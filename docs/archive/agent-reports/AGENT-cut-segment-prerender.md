# AGENT 报告：剪辑段参与测量与预渲染

分支 `claude/cut-segment-prerender`，工作区 `.worktrees/cut-segment-prerender`，基于 main `80bf8246`。
背景：`docs/archive/agent-reports/AGENT-cut-segment-followups.md`「没做成的」第 1 条（剪辑段即「剪辑套剪辑」：一条剪辑放进另一条剪辑序列里的那种片段；原来它和里面的卡一律在舞台里活渲，内容重时预览按「慢帧就等」变慢）。按那张解法表的第 2 行（把整个剪辑段当一张重卡：测量剪辑段的成本，按它产一条剪辑段级的轨道流）做，没有走到要改语义层级的地步，没建新的解法表。

## 状态

做完，等主会话审查。剪辑段作为一个整体参与测量、分派、产流、贴流；基线全绿（全量测试的两条失败与本改动无关，见下）。没有推送、没有合并。

## 做法（一句话版）

剪辑段在「卡片计划的图」里多一个节点，于是测量、分派、预渲染进程、托管渲染服务都把它当一张卡认：测得重就产一条剪辑段级的单卡流；页面在流把整段铺满以后贴流，没铺满照旧活渲；被引用剪辑（任意深度）一改，成本键、流键、输入签名都变，旧流不贴、重测重产。

## 做了什么

### 1. 身份：剪辑段进卡片计划的图（`src/kernel/cutSegments.ts`、`src/kernel/cutIdentity.mjs`）

- `withCutSegmentOutputs(project, graph, versionOf)`：在 `projectCardGraph` 的结果末尾，给激活剪辑序列上每个（不在隐藏序列、不悬空不成环的）剪辑段补一个节点 `@clip/<片段 id>/cut` 和它的输出。节点 `adapter: 'chrome'`、`cardId: '@cut'`、`clipId`，`cut` 字段是内容身份，能力表 `{ frameMode: 被引用剪辑的推帧口径, compositing: 'independent', need_prerendering: false, cutSegment: true, cutPreroll: 预卷秒数 }`。没有剪辑段时原样返回同一个图对象。
- **不改 `src/kernel/cardGraph.mjs`**：它在三张有声卡的源码闭包里（`src/render/audioCardSourceVersion.test.mjs` 钉着），改一个字就让用户已生成的卡片声音全部判过期。所以是在图算出来之后、在三处要卡片计划的地方补：导出页的 `__pcCardPlan`（`src/ExportView.tsx`，预渲染进程、托管渲染服务、渲染主机都从这里拿计划）、页面的成本身份（`src/editor/costIdentity.ts`）、页面产流用的卡片计划原料（`src/editor/browserNodeHost.ts` 的 `pageCardPlanValue`，保持和导出页同一份键）。渲染用的图（`Timeline.graph`）不经这里。
- `cutSegmentContent(project, clip)`（`cutIdentity.mjs`，纯 JS，服务端也能用）：引用哪条、偏移；从这一段出发经剪辑段任意深度能走到的剪辑的内容（`reachableCutContents`）；用到的素材（只取 id、种类、哈希，没有哈希的取地址——页面和预渲染进程手里素材条目别的字段可能不一样）；片段挂着的素材效果卡节点连同上游；效果库条目；里面用到的卡片 id。节点里另带每张卡的源码版本（`versionOf`）。
- 结果：成本键（`cardCostKey`）、共享内容键、流的成员键都随被引用剪辑（含两层以上嵌套）和里面卡的源码变；激活剪辑里别的改动不动它。实测页面与预渲染进程算出同一个成本键（`1c7e552f070c88`，两边对得上，分派表两端一致）。

### 2. 测量（`src/editor/probeRunner.ts`）

- 剪辑段进测量清单；缩水项目保留素材、效果库、素材效果卡节点（嵌套场景要用），段挪到 0 起。
- 记录口径：`kind: 'random'`（`clipWeight` 走 `direct` 档，权重 = 活渲单帧耗时）、`vtOk: false`、`seekOk: false`、`cutSegment: true`，不跑两趟布尔探针。理由：剪辑段的跳转、从段中间开始播放一律整场景在后台补跑后互换，可见舞台从不追它，追帧总耗时不该把它判重（照记，只作诊断）；`vtOk`/`seekOk` 写 false 保证舞台不在子树虚拟时间里追它、不直接定位它（`StageView` 的 `routeJump`/`routeSettle` 对它什么都不做，和原来一样）。

### 3. 产流（`server/frame-stream.mjs`、`src/render/streamPlanRules.mjs`、`server/card-cache.mjs`、`server/render-node/split.mjs`）

- `soloStreamKind` 对剪辑段回 `'cut'`：一条单卡流（`kind: 'card'`、`plane: 'local'`，包裹层坐标；框的位置缩放旋转、不透明度、淡入淡出、强调不在流里），不并进组流，浏览器节点不产（和另两类单独成流的卡同一条规则，切分不出浏览器那一份）。
- 挂载帧含预卷（`capabilities.cutPreroll`）：有按历史推进的卡时从预卷之前回放。隔离工程本来就不平移时间，预卷照常成立。
- 里面有视频、图片时 `hasMedia`，截图前等素材就位。
- 发层时带 `streamKind: 'cut'` 和这一版的输入签名（`belowLayerMark`；`server/ready-index.mjs`、`src/render/snapshotSource.ts` 认这个值）。
- `card-cache.mjs`：剪辑段的控件 `cacheable` 为假，不走整帧 PNG 那一支（那一支用的隔离单卡工程把片段平移到 0，会截掉预卷）。
- `paintLayers`、`belowLayersOf`、`streamInputs` 把剪辑段算作一个画面层：组流的相邻判断、依赖下层的流的下层都算上它（依赖下层的流盖在剪辑段上面时，剪辑段的内容变了，那条流也作废；挂载帧同样含预卷）。原来剪辑段不在这几处，是个遗漏。
- `split.mjs` 的 `innerCardIds`：剪辑段节点按「拿不准」算（要这一版全部定制卡的代码、不给浏览器节点）。

### 4. 贴流（`src/editor/snapshotFeed.ts`、`src/editor/stageSwap.ts`、`src/render/CutSegmentScene.tsx`、`src/render/Stage.tsx`）

- `cutStreamHeavy(project, clip, t)`：分派表判它重，**而且**它的剪辑段级流已把整段铺满（每个分段至少有稀疏版），而且层带的输入签名和当前项目算的对得上，才按重卡办（抑制、发流平面、暂停时兜底）。否则照旧活渲，不显示占位符，播放中途也不会从流换回活渲。`planFeed` 的活跃片段清单收进剪辑段，判重走这一条。
- 停下：贴着流的剪辑段并进 `needsBackCatchUp`（整场景在后台补跑后互换），补跑好之前照旧贴流，互换后回到精确活渲。要按历史推进的剪辑段原来就由 `statefulSegmentsAt` 收，不变。
- 贴流时嵌套场景整棵跳过重渲（`CutSegmentScene` 的 `frozen`：抑制着时原样交回上一拍的元素）。不这样做，藏起来的嵌套场景每拍照样重渲一遍，贴流省不下钱。导出页、预渲染页从不抑制，不受影响。

### 5. 语义

`docs/semantics/mechanism/rendering.md`「剪辑段」：「停下就精确」一条补上贴流的剪辑段；原「没做的」一条换成「测量与预渲染：整段当一张卡」（身份、测量、产流、贴流四小条）。标〔裁：剪辑段预渲染 2026-10-20（三级）〕。`product/` 没改。

## 文件清单（相对 `80bf8246`）

新增：`scripts/probes/cut-segment-prerender-probe.mjs`（管线级）、`scripts/probes/cut-segment-prerender-editor-probe.mjs`（编辑台级）、`server/test/cut-segment-prerender.test.mjs`、截图与结果 `docs/reports/assets/cut-segment-prerender/**`、本报告。

修改：`src/kernel/{cutSegments.ts,cutIdentity.mjs,cutIdentity.d.mts}`、`src/ExportView.tsx`、`src/editor/{costIdentity.ts,browserNodeHost.ts,probeRunner.ts,snapshotFeed.ts,stageSwap.ts,Preview.tsx}`、`src/render/{CutSegmentScene.tsx,Stage.tsx,layerInputSig.mjs,streamInputSig.mjs,streamPlanRules.mjs,streamPlanRules.d.mts,cardCostKey.d.mts,snapshotSource.ts}`、`server/{card-cache.mjs,frame-stream.mjs,ready-index.mjs}`、`server/render-node/split.mjs`；测试替身 `src/editor/{stageSwap.test.mjs,stageSwapBaseline.test.mjs,c10a-swap-gate.test.mjs}`（`snapshotFeed` 的替身补一个 `cutStreamHeavy`）；语义 `docs/semantics/mechanism/rendering.md`。

没动 `server/hosted-render/**`：托管渲染服务的工作进程跑的是同一份预渲染管线和导出页，按同一份 `planStreams` 认剪辑段。

## 验证

全量测试从 `409dc0ec` 起跑；跑的过程中又提交了两处小改动（`6ae320d5`：在线页面清单收进剪辑段，`src/editor/Preview.tsx` 一行；`7b348520`：只挪注释），类型检查在这之后另跑了一次（零错误），之后的探针与比对都在 `7b348520` 上。端口：dev server 5400、5403、5406（各另占 +1、+2 当舞台端口）；预渲染进程自己挑空闲端口（如 2558、10878、10268，探针结束后连同 dev server 一起收掉）。

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，输出 0 行（两次） |
| 全量测试 | `npm test`（命令里设 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT`、`PROMPTCUT_PASSWORD_ORDER_MODULE`） | 7212 条：7195 过、3 败、0 取消、14 跳过。失败两项都与本改动无关：① `server/test/account-v2-deploy-config.test.mjs`「registers an optional service…」——断言整份结果的字符串里不含 `render`，结果里带着工作区路径 `.worktrees/cut-segment-prerender`（含 `render`），这个工作区里必红（第一轮全量也红，单独跑同样红）；② `server/test/multi-agent-presence.test.mjs` MA-X2（等在场消息 15 秒超时，负载下的偶发；第一轮全量里是过的，单独重跑 6/6 过） |
| 新增单测 | `server/test/cut-segment-prerender.test.mjs` | 8 条全过（也在 npm test 里） |
| 导出确定性 | `node scripts/verify-determinism.mjs --url "http://127.0.0.1:5406/?export=1"` | 退出码 0；1800/1800 帧相同 |
| 快照重放一致 | `PC_FRAME_TEST_URL=http://127.0.0.1:5406 node scripts/verify-unified-frames.mjs` | 退出码 0；PASS |
| 与 main 的导出像素比对 | `bash .worktrees/_export-baseline/check.sh <本树> cut-segment-prerender 5406` | 240 帧；对 89c15177 第二种结果（A）240/240 逐字节相同，PASS（不含剪辑段的项目像素不变） |
| 剪辑段预渲染（管线级，新） | `node scripts/probes/cut-segment-prerender-probe.mjs --port 5400 --out docs/reports/assets/cut-segment-prerender/pipeline` | 退出码 0，零失败，见下 |
| 剪辑段预渲染（编辑台，新） | `node scripts/probes/cut-segment-prerender-editor-probe.mjs --port 5403 --out docs/reports/assets/cut-segment-prerender/editor` | 退出码 0，零失败，见下 |
| 测量判重（编辑台，新） | 同上加 `--burn 60` | 退出码 0：S 的记录 `stepMs` 63、`capped: true`、`kind: random`、`vtOk`/`seekOk` false、`cutSegment: true`，父页分派表在 S 的位置判重（`editor-measure-burn60.json`） |
| 上一轮剪辑段界面探针 | `node scripts/probes/cut-nesting-ui-probe.mjs --origin http://127.0.0.1:5406` | 退出码 0；A1～A9 全过，页面零报错 |
| 上一轮剪辑段面板探针 | `node scripts/probes/cut-segment-panel-probe.mjs --origin http://127.0.0.1:5406` | 退出码 0；P1～P9、L1、E0 全过 |
| 上一轮剪辑段声音探针 | `node scripts/probes/cut-segment-audio-probe.mjs --port 5400` | 退出码 0；chrome、ffmpeg 两遍 PASS（段前 −200 dB、淡入头 −34.89 dB、主体 −24.09 dB，原素材 −24.08 dB） |
| 上一轮剪辑段有声卡导出探针 | `node scripts/probes/cut-segment-card-sound-probe.mjs --port 5400` | 退出码 0；全过（段间五个窗口 −200 dB，页面零报错） |
| 上一轮兼容旁路探针 | `node scripts/probes/cut-segment-ffmpeg-media-probe.mjs --port 5400` | 退出码 0；F1、F2、F3 两遍全过（2 秒处左上 RGB (252,0,0)） |

**管线级探针**（`FramePipeline` 同预渲染进程的代码、真 Chrome、真编码器；项目：激活剪辑上一个剪辑段 S，第 1～5 秒、框 960×540 居中、偏移 1 秒，引用「重」——一张推帧卡 `r6-stateful` 加一个剪辑段引用「里」——两层嵌套）：

1. 卡片计划里有 S 的控件：`cutSegment`、预卷 1 秒、`frameMode: stateful`、成本键 `1c7e552f070c88`、`cacheable: false`。
2. 流的计划：一条 `solo: 'cut'`、`plane: 'local'` 的单卡流，第 30～149 帧，`replay: true`、挂载帧 0（含预卷），隔离工程把框摆在原处。
3. 流用的隔离工程导出 120 帧，与整个项目导出的同一帧**逐像素相同**（120/120，含段起点那一帧——预卷对了）。
4. 稀疏版 8 个分段，每段一张、最像分段第一帧（平均误差 0.20～0.21/255）；满密度 120 帧逐帧最像自己那一帧，最差平均误差 0.71/255。
5. 真舞台（跨源两台）上抑制 S、发它的流平面，停在第 31、47、75、100、133、149 帧截图，与整个项目的活渲导出比：每一帧最像的都是它自己那一帧，框内平均差 0.22～0.26/255；剪辑段的活子树藏着、流平面露着。
6. 改「里」（两层深）那张卡的文字：成本键 `1c7e552f070c88`→`f9f1523b1faaa`，流键也变；激活剪辑里加一条隐藏序列：键都不变。

**编辑台探针**（真编辑台、真预渲染进程）：测量记录按剪辑段口径；页面与预渲染进程算出同一个成本键；钉死为重卡、项目换一版后，预渲染进程产出 `solo: 'cut'` 的流（8 段满密度），父页就绪索引收到流层、`cutStreamHeavy` 为真；从头播放 3 秒，S 被抑制、流平面露着、父页发了带这条流键的流平面、流画出 64 帧零解码错误；暂停后整场景补跑互换，S 不再抑制（回到精确活渲）；改两层深的被引用剪辑：成本身份换了，**当场**父页不再判流铺满（旧流签名对不上、不贴），新身份测量、钉死后重产了一条新流（流键不同），父页换上新流的层；页面零报错。没流时（钉死之前）从头播放，S 照旧活渲、不抑制。

看过的图（`docs/reports/assets/cut-segment-prerender/`）：
- `pipeline/export-30.png`、`export-75.png`、`export-149.png`：整个项目活渲导出（段起点 r6 推帧卡在中间——预卷正确；第 75 帧往左走了）；
- `pipeline/stage-stream-75.png`：舞台贴流的第 75 帧，与 `export-75.png` 肉眼无差；
- `editor/editor-playing-stream.png`：编辑台播放中（4.03 秒）预览贴着剪辑段的流；`editor/editor-paused-live.png`：暂停后回到活渲（4.07 秒），画面一致。

## 用户看得出的区别（请审）

- **重的剪辑段播放时贴流**：测得重、流铺满以后，播放中剪辑段的画面来自它的轨道流。只有稀疏版时（打开项目后最先产出的那一版，每 15 帧一张）播放中剪辑段的画面一卡一卡地跳，满密度补上以后就是逐帧的；原来是在舞台里活渲、整个预览按「慢帧就等」变慢。这和 `product/rendering.md` 对一切重卡的承诺一致（「重管线：预渲染」「兜底顺序」），所以没有改 `product/`，按三级办、标〔裁〕；但它确实是看得见的变化，请用户审。
- **没流时照旧活渲，不显示占位符**：`product/rendering.md`「兜底顺序」对重卡说的是「该层还没有任何预渲染结果时显示占位符」。剪辑段这里按任务书「没流照旧活渲」办（就是原来的样子）；流铺满的那一刻起改贴流（播放中途也换，画面是同一帧）。反过来从流退回活渲只在旧流失效时发生（播放中改了被引用剪辑）：那一下要按历史推进的内容停在开始贴流时的状态，直到下一次跳转、暂停或起播补跑——这和改了参数的普通重卡在流重产好之前的情形同类。这是对二级兜底规则的一个例外，写在三级里、标〔裁〕，请用户定要不要把它写进 `product/`，或改成和别的重卡一样显示占位符。

## 〔裁〕清单

〔裁〕= 执行中自己定、用户合入前要审的决定。

| # | 级 | 内容 | 写在 |
|---|---|---|---|
| 1 | 三 | 剪辑段整段当一张卡：身份（内容身份 + 里面各卡源码版本）、测量口径（`kind: random`、`vtOk`/`seekOk` false）、产剪辑段级单卡流（`solo: 'cut'`，浏览器不产）、不走整帧 PNG | `mechanism/rendering.md`「剪辑段」第「测量与预渲染」条 |
| 2 | 三（看得见，请审） | 判重且流铺满（至少稀疏版）、签名对得上才贴流；否则照旧活渲、不显示占位符 | 同上「贴流」小条 |
| 3 | 三 | 贴着流的剪辑段停下时整场景补跑互换，补跑好之前照旧贴流 | 同上「停下就精确」条 |

## 没做成的与原因

1. **在线浏览器页面不产剪辑段的流**：剪辑段的流要整套嵌套场景（含素材、素材效果卡），和另两类单独成流的卡一样只由桌面应用、托管方的渲染服务（「生成轨道流」打开时）和渲染主机产。在线页面只有桌面成员或托管渲染服务能产时才贴得上流；都没有时照旧活渲（不比现在差）。
2. **在线页面不比剪辑段流的输入签名**：在线页面从层表（`server/artifact-transfer.mjs` 的 `layerMapOf`，`src/render/snapshotSource.ts` 的在线来源）拿流，层表那一行没有带 `streamKind: 'cut'` 和签名，被引用剪辑改过、渲染节点还没换键之前的那一小段，在线页面可能贴旧流（和在线页面上别的单卡流同一个口径：靠渲染节点换键重写层表）。桌面版预渲染进程发的层带签名，页面对不上就不贴（编辑台探针第 5 条）。要补的话改 `layerMapOf` 与在线来源，属另一位子 Agent 正在动的托管与在线那一片，没碰。
3. **成本记录事后变了不重排这一版的流**：预渲染进程只在一版项目的后台那一趟里按成本记录定产哪些流；同一版里记录后来才判重（降级、人工钉死）不会马上产流，要等项目下一次变动。这是原有的行为，所有卡都一样，不是剪辑段特有的；编辑台探针钉死以后用「加一条空的隐藏序列」换一版来绕。
4. **`probe-slow` 烧时间的剪辑段产不了流**：探针卡 `probe-slow` 靠舞台的真时钟 `__pcRealNow` 忙等，导出页把时间钉死、没有真时钟，它在导出页会一直烧下去（页面主线程卡死）。所以「测出来判重」用它在编辑台里测（`--burn 60`：单帧 63 ms，判重），产流与贴流用人工钉死为重卡（`pinnedHeavy`）的同一个剪辑段。这是探针卡的限制；真实的重内容（多张卡、粒子、视频）能在导出页渲，不受影响。
5. **播放头走多快没有当闸门**：编辑台探针记录了贴流与活渲时墙上 3 秒内播放头前进多少，但钉死为重卡的那一段内容本身不重，两者都约 4 秒，看不出差别；烧时间的那一段又产不了流（上一条）。贴流时嵌套场景不重渲由 `CutSegmentScene` 的 `frozen` 保证（代码层面），没有用耗时数字证明。

## 对任务书或语义的更正建议

- 任务书写「本机预渲染进程与托管渲染服务按同一份分派认它」：托管渲染服务的工作进程跑的就是同一份预渲染管线与导出页（`__pcCardPlan`），不用动 `server/hosted-render/**`；但托管渲染服务「不测卡片轻重」，按在线页面发来的清单计划和已有成本记录产流。在线页面的清单原来只收有 `cardId` 的片段（`src/editor/Preview.tsx` 的 `heavyCardClips`），剪辑段进不去；本轮把剪辑段加进去了（判重的剪辑段进清单，切分只出切分方自己的那一份）。托管那一侧按清单为剪辑段产流、在线页面贴上，没有端到端实测（不碰生产节点），部署后由主会话验。
- `server/test/account-v2-deploy-config.test.mjs` 的「registers an optional service only when its distinct identity is enabled」用 `JSON.stringify(result).includes('render') === false` 判断，结果里带着工作区路径，本工作区名字 `cut-segment-prerender` 里有 `render`，于是在这个工作区里必红（与改动无关，在别的路径下是绿的）。建议把判断改成只看服务列表，不看整份结果的字符串。
- `product/rendering.md`「兜底顺序」可以考虑补一句剪辑段的例外（见上「用户看得出的区别」第 2 条），由用户定。

## 部署要换什么

改了 `src/`：**整份 `src/` 同步进渲染树**（预渲染进程、托管渲染服务、托管 Agent 服务都按 `src/` 加载；导出页 `ExportView.tsx` 是产流用的那一页）。

- **在线前端重建并换静态页**：编辑台（测量、贴流、`snapshotFeed`、`stageSwap`）、舞台（`Stage`、`CutSegmentScene`）、导出页都在前端构建里。
- **渲染服务 / 预渲染进程**（桌面版的预渲染进程、托管方的渲染服务及其工作进程、渲染主机）：换 `server/card-cache.mjs`、`server/frame-stream.mjs`、`server/ready-index.mjs`、`server/render-node/split.mjs`，以及它们 import 的 `src/kernel/cutIdentity.mjs`、`src/render/{streamPlanRules.mjs,streamInputSig.mjs,layerInputSig.mjs}`；重启这些服务。没有剪辑段的项目，卡片计划、键、层表一个字节不变，旧缓存照用。
- 文档服务、素材服务、Agent 服务不用换（没有新数据字段落盘：剪辑段的节点只在卡片计划里，成本记录多一个 `cutSegment` 标记）。
- 桌面版：随下一个补丁一起出。
