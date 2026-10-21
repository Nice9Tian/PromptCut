# AGENT 报告：剪辑段拆开逐卡预渲染

分支 `claude/cut-flatten`，工作区 `.worktrees/cut-flatten`，基于 main `16005ae4`。

## 用户原话（2026-10-21）

> 剪辑卡其实里面也是卡片，只是用看到的是"剪辑卡"，实际轨道流里面还是拆分成多个卡片。也就是说剪辑卡的轻卡还是照常能出。重卡走轨道流，和没有剪辑段的情况下，是一回事。

## 状态

做完，等主会话审查。剪辑段里的卡逐张参与测量、分派、产流、贴流与占位；上一轮的剪辑段级流整套拆掉。基线：见「验证」。没有推送、没有合并。

## 设计（开工时定，实现按此推进）

**核心：两份视图。** 画面照旧走嵌套场景（`CutSegmentScene` → 嵌套 `FrameScene`/`Stage`，像素口径不变）；只有「计划」这一侧（成本身份、测量、分派、流计划、层表、输入签名、就绪索引）换成**摊平视图**。

1. **摊平视图** `src/kernel/cutFlatten.mjs`（纯 JS，页面与服务端共用，不碰注册表）：`flatPlanProject(project)`，没有剪辑段时原样回同一个对象（键、表、像素一字不变）。激活剪辑里每个（不在隐藏序列、不悬空不成环的）剪辑段换成它里面的片段（任意深度递归）：
   - 虚拟片段 id = `<段 id>~<里面片段 id>`（多层就一路接下去），虚拟序列 id 同理，插在段所在序列的位置（画家顺序不变）；
   - 时间：父时间 = 剪辑时间 + `段.start − 段.cutOffset`；只留露出来的窗口（`[段.start, 段.end)` 与 `被引用剪辑总长` 的交集，再与片段自己的区间相交），`start/end` = 露出窗口；
   - 框、参数、部件照里面片段原样（被引用剪辑和项目同画幅，流在包裹层自己的坐标系里，段的框不进流像素，和顶层卡的缩放旋转不进流同一个道理）；
   - 另带 `flat: { lead, chain }`：`lead` = 露出起点时卡的本地时间（片段被段截头时 > 0），`chain` = 一路剪辑段的 `{ id, cutId, start, end, cutOffset }`，`mount` = 产流回放的安全起点 `max(0, 顶层段.start − 顶层段.cutOffset)`；
   - v1 只摊卡片段（`cardId`，无 `nodeId`）和素材段；素材效果卡片段（`nodeId`）、转场不摊（照旧活渲，节点输入按原片段 id 引用，换 id 会悬空）。
2. **身份**：卡片计划的图 = `projectCardGraph(摊平视图)`，再给虚拟片段的基节点补 `flat` 字段（`withFlatNodes`）。流成员键、内容键随它变；成本键 `cardCostKey` 剥掉 `flat`（同一张卡在各实例只测一次，和顶层同口径）。改被引用剪辑里某张卡只改那张卡的节点；改别的卡不动它。同一被引用剪辑引用两次：各实例 id 不同，在分派表、层表、就绪索引里各一行；露出窗口不同则流键不同。
3. **哪些虚拟卡有流**：只有独立卡（平面与三维外框），单独成流 `solo: 'flat'`（不并组流、浏览器不产，由桌面、托管渲染服务、渲染主机产）；依赖下层、源依赖、未审阅的虚拟卡不产流、不抑制，照旧活渲（v1 限制）。
4. **产流的隔离工程**：从真实项目出发，顶层只留这条链上的段、去掉段的框与外观（嵌套场景 1:1），被引用剪辑里只留链上下一个段或目标卡，目标卡照 `localClip` 摆到 `offset`。这样嵌套场景的预卷、截头近似与活渲完全相同；回放从 `flat.mount` 起。
5. **贴流与占位**：`snapshotFeed` 在摊平视图上算重卡；`Stage` 把平面 prop 原样递给 `CutSegmentScene` → 嵌套 `FrameScene`/`Stage`，嵌套舞台按 `前缀 + 片段 id` 查抑制、流平面、占位；嵌套包裹层另挂 `data-pc-flat-clip`，`streamPlayer` 与 `StageView` 的占位槽位按它找。停下时贴着流的虚拟卡走整场景后台补跑互换（`needsBackCatchUp`），不走子树虚拟时间。
6. **拆掉**：`withCutSegmentOutputs`、`cutStreamHeavy`、`streamKind: 'cut'`（就绪索引、层表、在线来源）、`CutSegmentScene` 的 `frozen`、`probeRunner` 的剪辑段口径、`card-cache` 的 `cutSegment`、`split.mjs` 的剪辑段节点、`solo: 'cut'`、相关测试与探针。

## 做了什么

1. **摊平视图** `src/kernel/cutFlatten.mjs`（新，纯 JS，页面与服务端共用）：`flatPlanProject`、`withFlatNodes`、`isolatedFlatProject`、`isFlatClipId`。没有剪辑段时原样回同一个对象。
2. **身份**：导出页 `__pcCardPlan`、页面成本身份 `costIdentity.ts`、页面产流的卡片计划原料 `browserNodeHost.ts` 一律用 `projectCardGraph(摊平视图)` + `withFlatNodes`；`cardCostKey` 剥掉 `flat`（同一张卡各实例只测一次）。
3. **测量、分派**：`probeRunner.ts` 在摊平视图上挑卡（缩水项目里虚拟片段就是一张顶层卡）；`planDispatch.ts` 的 `planPipelines` 吃摊平视图；`Preview.tsx` 的清单计划在摊平视图里认卡。
4. **流的计划与产流**（`server/frame-stream.mjs`、`src/render/streamPlanRules.mjs`、`server/card-cache.mjs`）：`planStreams`、`belowStreamSpecs` 在摊平视图上算；`soloStreamKind` 对虚拟片段的独立卡回 `'flat'`（`streamEligible`、`belowStreamEligible` 对虚拟片段回假：不并组流、不出依赖下层的流）；回放从 `flat.mount` 起（`mountClipOf`）；`isolatedStreamProject` 遇 `solo: 'flat'` 走 `isolatedFlatProject`；虚拟片段的控件 `cacheable` 为假。
5. **输入签名**：`streamInputSig.mjs` 的 `belowLayersOf` / `streamInputs` 内部先摊平（页面、服务端同一份认定）；`layerInputSig.mjs` 对虚拟片段多带 `flat`。顶层片段签名不变。
6. **贴流与占位**：`snapshotFeed.ts` 在摊平视图上算活跃卡，剪辑段里非独立卡不抑制（`flatStreamable`）；`stageSwap.ts` 的 `needsBackCatchUp` 收判重、按历史推进的虚拟卡（停下时整场景补跑互换）；`Stage.tsx` 加 `flatPrefix`，平面 prop 按「前缀 + 片段 id」查，嵌套包裹层挂 `data-pc-flat-clip`，把平面 prop 递进 `CutSegmentScene` → 嵌套 `FrameScene`；`streamPlayer.ts`、`StageView.tsx` 的流平面与占位槽位也认 `data-pc-flat-clip`。导出页、预渲染页不传平面，DOM 只多一个 `data-pc-flat-clip`（只在有剪辑段的项目里）。
7. **在线**：`pageStreamPlan.ts` 在摊平视图上算（页面不产 `'flat'` 流，只算进预算）；快速导出不从流里取虚拟片段（`streamFrames.ts`）。
8. **拆掉上一轮**（恢复到剪辑段级流之前的样子，再加本轮改动）：`withCutSegmentOutputs`、`isCutSegmentNode`、`cutSegmentContent`、`cutSegmentHasVisualMedia`、`cutStreamHeavy`、`staleCut`、`CutSegmentScene` 的 `frozen`、`probeRunner` 的剪辑段口径、`streamKind: 'cut'`（`ready-index.mjs`、`artifact-transfer.mjs`、`snapshotSource.ts` 的整段清单与就绪口径）、`split.mjs` 的剪辑段节点、`solo: 'cut'`、`layerInputSig` 的 `cut` 项；删测试 `server/test/cut-segment-prerender.test.mjs`、`server/test/cutseg-layer-sig*.mjs`、`src/editor/snapshotFeedCutOnline.test.mjs`，删探针 `cut-segment-prerender-probe.mjs`、`cut-segment-prerender-editor-probe.mjs`。
9. **语义**：`product/rendering.md`「用到的词」加一条（引用户原话）；`mechanism/rendering.md`「剪辑段」的「停下就精确」改写、「测量与预渲染」整条换成逐卡机制（摊平视图、身份、哪些卡有流、产流、贴流与占位、导出），标〔裁〕。

## 文件清单（相对 main `16005ae4`）

新增：`src/kernel/cutFlatten.mjs`、`src/kernel/cutFlatten.d.mts`、`src/kernel/cutFlatten.test.mjs`、`server/test/cut-flatten-streams.test.mjs`、`scripts/probes/cut-flatten-probe.mjs`、本报告、`docs/archive/agent-reports/assets/cut-flatten/**`。

修改：`server/{artifact-transfer.mjs,card-cache.mjs,frame-stream.mjs,ready-index.mjs,render-node/split.mjs}`、`src/{ExportView.tsx,StageView.tsx}`、`src/editor/{Preview.tsx,browserNodeHost.ts,costIdentity.ts,planDispatch.ts,probeRunner.ts,snapshotFeed.ts,stageSwap.ts}`、`src/export/streamFrames.ts`、`src/kernel/{cutIdentity.mjs,cutIdentity.d.mts,cutSegments.ts}`、`src/online/pageStreamPlan.ts`、`src/render/{CutSegmentScene.tsx,FrameScene.tsx,Stage.tsx,cardCostKey.mjs,cardCostKey.d.mts,layerInputSig.mjs,snapshotSource.ts,streamInputSig.mjs,streamPlanRules.mjs,streamPlanRules.d.mts,streamPlayer.ts}`、测试替身 `src/editor/{c10a-swap-gate,stageSwap,stageSwapBaseline}.test.mjs`（去掉 `cutStreamHeavy`）、探针 `scripts/probes/cut-online-e2e-probe.mjs`（改逐卡口径）、语义两本。

删除：见第 8 条。

## 验证

端口：dev server 5440（+5441、5442 舞台）、5444、5447；在线端到端 5443～5450。没碰 5190～5192。代码定稿在 `4ec2f08b`（最后一处改动是父页判「能不能产流」改用 `cardCapabilities`、流平面与占位槽位分两次查，行为不变）；类型检查与全量测试在它上面跑，探针与像素比对在它之前的 `4b84bfa4`／`f7f4a025` 上跑（之后只改了上面两处与一条源码正则测试）。

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，输出 0 行 |
| 全量测试 | `node scripts/test-suite.mjs`（即 `npm test`，命令里设 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT`、`PROMPTCUT_PASSWORD_ORDER_MODULE`） | 7232 条：7215 过、1 败、1 取消、15 跳过。两项都是满负载偶发、与本改动无关，单独重跑都过：`server/test/asset-project-workers.test.mjs`（真 ffmpeg 转码 20 秒超时；单跑 11/11 过）、`server/test/cloud-see-frames-dispatch.test.mjs`（`account-master-listen` 监听失败；单跑 1/1 过）。上一轮全量里暴露的父页测试整文件载不起来（`snapshotFeed` 引了 `costIdentity`，测试环境没有 vite 的 `import.meta.glob`）、流平面测试的假 DOM 不认逗号选择器、CU-04 源码正则，已在 `4ec2f08b` 修掉，相关 17 个文件单跑全过 |
| 新增单测 | `src/kernel/cutFlatten.test.mjs`（7 条）、`server/test/cut-flatten-streams.test.mjs`（4 条） | 全过（也在全量里） |
| 导出确定性 | `node .worktrees/_export-baseline/baseline-driver.mjs --tree <本树> --port 5444 --mode determinism-default`（即 `verify-determinism.mjs --url <它起的 dev server>/?export=1`） | 退出码 0；Identical 1800、Different 0 |
| 快照重放一致 | 同上 `--mode unified`（即 `verify-unified-frames.mjs`） | 退出码 0；PASS |
| 与 main 的导出像素比对 | `bash .worktrees/_export-baseline/check.sh <本树> cut-flatten 5447` | 退出码 0；240 帧，对 89c15177 第二种结果（A）240/240 逐字节相同，PASS（不含剪辑段的项目像素不变） |
| 逐卡探针（新） | `node scripts/probes/cut-flatten-probe.mjs --port 5440 --out docs/archive/agent-reports/assets/cut-flatten/pipeline` | 退出码 0，`fails: []`，见下 |
| 在线端到端（改逐卡口径） | `node scripts/probes/cut-online-e2e-probe.mjs --dist <会话临时目录>/dist-online --base-port 5443 --out docs/archive/agent-reports/assets/cut-flatten/online`（在线构建取自 `f7f4a025`） | 退出码 0，`fails: []`，见下 |
| 上一轮剪辑段界面、面板探针 | `cut-nesting-ui-probe.mjs`、`cut-segment-panel-probe.mjs --origin http://127.0.0.1:5440` | 退出码 0、0；面板 P1～P9、L1、E0 全过 |

没跑：剪辑段声音、有声卡导出、兼容旁路三个探针——本次没碰声音与导出取帧，导出确定性与像素比对已覆盖画面；在线 visuhive.com 实测（不碰生产节点）。

**逐卡探针**（真 Chrome、真编码器、真跨源舞台；激活剪辑一个剪辑段 S 第 1～5 秒、框 960×540 居中、偏移 1 秒，引用「重」：推帧卡 `r6-stateful`、轻卡 `punch-pill`、剪辑段引用「里」里的 `punch-pill`）：
1. 卡片计划里 `seg-s~h-r6`、`seg-s~h-seg~i-pill`（两层嵌套）、`seg-s~h-light` 各有控件，`seg-s` 本身没有；都不走整帧 PNG。
2. 各一条 `solo: 'flat'`、`kind: card`、`plane: local` 的单卡流，从第 30 帧起到露出窗口末帧（重卡 149、轻卡 89）；`r6` 回放、挂载帧 0（嵌套场景挂上那一帧）。
3. 隔离工程：顶层只剩 `seg-s`、剪辑「重」里只剩 `h-r6`。
4. 稀疏版每段一张；满密度 300 帧齐。
5. 舞台贴流（抑制两张重卡、发它们的流平面，轻卡不抑制）停在 31、47、75、100、133、149 帧，与整个项目的活渲导出比：每一帧最像的都是它自己那一帧，框内平均差 0.51、0.37、0.31、0.30、0.30、0.30（/255）；嵌套包裹层上两张重卡 `pc-suppressed`、流平面露着，轻卡挂着、不抑制，剪辑段本身不抑制。
6. 只抑制「里」那张卡、不给流平面：它的嵌套包裹层里占位槽位露出（沙漏 + 噪点，位置随段的框缩放）。
7. 改「里」那张卡的文字：只有它的流键变（`039f75e5…`→`dd9fa5cd…`），`r6` 的不变；激活剪辑加一条隐藏序列：键都不变。

**在线端到端**（本机隔离托管组合 + 在线构建 + 桌面预渲染进程当切分方；两层嵌套里那张 `punch-pill`，虚拟 id V）：加 S 只多出一条成本记录（就是 V 自己的，钉重）；层表里 V 一行 `kind: card`、`plane: local`、带 `inputSig`、没有 `streamKind`，第一帧 6、分段 0～3 满密度；父页判 V 重、流平面挂在包裹层里，S 本身不判重；播放 26/28 个样本画的是这条流、嵌套包裹层一直抑制、零错误；改「里」那张卡的文字：12 ms 内不再发旧流平面，在线来源把它列进 `staleStreams`，没有占位、活渲，旧流没再贴上；新流重产（新内容键、新签名）后贴上 26/27；另一个 8 秒剪辑段 L 里同一张卡各自一行（16 段）、开播 1.1 秒起贴流；页面零报错。

看过的图（`docs/archive/agent-reports/assets/cut-flatten/`）：`pipeline/stage-stream-47.png`（两张重卡贴流、轻卡活渲，与 `pipeline/export-*.png` 的活渲导出一致）、`pipeline/stage-stream-75.png`、`pipeline/stage-placeholder-75.png`（没流时那张卡显示占位）、`online/play-v1.png`、`online/after-edit-live.png`、`online/play-v2.png`、`online/play-long.png`。

## 用户看得出的区别（请审）

- 剪辑段里的重卡播放时贴自己的流，轻卡照常活渲；没流时那张卡显示占位符（和顶层重卡一样，`product/rendering.md`「兜底顺序」）。上一轮是「整段流没铺满就整段活渲、不显示占位」，这次按用户原话改掉了。
- 在线浏览器里，剪辑段里的重卡只能由桌面成员或托管方的渲染服务（「生成轨道流」开着）产流；都没有时播放中那张卡显示占位（和顶层的源依赖卡、三维外框卡同一处境），暂停后追到精确活渲。

## 〔裁〕清单

| # | 级 | 内容 | 写在 |
|---|---|---|---|
| 1 | 三 | 逐卡机制：摊平视图、身份（`flat` 进流键不进成本键）、`solo: 'flat'`（不并组流、浏览器不产）、隔离工程带剪辑段链、贴流与占位按虚拟片段 id、停下整场景补跑 | `mechanism/rendering.md`「剪辑段」 |
| 2 | 三（看得见，请审） | v1 只给剪辑段里的独立卡产流；依赖下层、源依赖、没审阅过的卡与挂素材效果卡节点的片段照旧活渲、不抑制 | 同上「哪些卡有流」 |

product 那一句是用户原话，没有〔裁〕。

## 没做成的与原因

1. **剪辑段里依赖下层的卡（毛玻璃、没审阅过的用户卡）不产流**：它的流要按舞台坐标画、要把「段外面的下层 + 段里面的下层」一起算进去，而嵌套场景整块缩放、可能旋转，按舞台坐标贴回去时盖不住段里比它高的层。现在这种卡照旧在嵌套场景里活渲、不抑制。解法表：

   | 行 | 级 | 思路 | 卡在哪 |
   |---|---|---|---|
   | 1 | 三 | 在嵌套场景自己的坐标系里产依赖下层的流（只算段里的下层），贴在嵌套舞台根下 | `backdrop-filter` 会透过嵌套场景采样到段外面的层（`isolation` 挡不住），只算段里的下层画面不对 |
   | 2 | 三 | 按顶层舞台坐标产（整场景差分取层），贴在顶层、层序取段那一层 | 段里比它高的层会被这张平面盖住 |
   | 3 | 二 | 判重时显示占位（和顶层「依赖下层且外框三维」同口径） | 用户看得出：播放中这张卡一直是占位；这次没选，留给用户定 |

2. **剪辑段里挂素材效果卡节点的片段、转场不摊**：节点的输入按原片段 id 引用，摊平改了 id 会悬空；要摊得给每个实例复制一份节点并改写输入。照旧活渲、不进分派表（它们的成本不计入预算）。
3. **浏览器节点、在线页面本页不产剪辑段里的卡的流**：浏览器取像素那条路按顶层包裹层找卡，嵌套场景里的卡要带着剪辑段链渲，没接。
4. **在线父页「改了被引用剪辑那张卡」后撤判重要等分派表重算**（端到端探针 D 里约 1.7 秒）：旧流平面 12 ms 内就不发了（在线来源按签名撤层），只是「判重」这一标记要等新身份的成本记录到了才变，和顶层卡改参数后同一条路，不影响画面。
5. **测量时虚拟片段挪到 0 起**：被截头的卡（`lead > 0`）测的是它自己从 0 起的那一段，不是露出窗口那一段；成本是估计值，影响小。

## 对任务书或语义的更正建议

- 任务书写「流键要把剪辑段的平移与框复合算进去」「框不同则像素不同」：流在卡自己的包裹层坐标系里出（和顶层单卡流一样），段的框（位置、缩放、旋转、不透明度、淡入淡出）不在流的像素里，贴的时候由外面的包裹层加，所以没把段的框放进键；时间平移（露出窗口、截头 `lead`、剪辑段链）在键里。同一剪辑被引用两次：各实例 id 不同、各自一行；露出窗口相同时流键相同、共用一条流（像素本来就相同）。要强制各实例各产一条，只要把实例路径加进 `flat`，一行改动。
- `verification.md` 写的 `npm test` 输出：本机后台重定向时 `npm test` 的输出曾截断、没打出「最终结果」那一行（第一次全量只拿到退出码 0，实际有文件载不起来）；直接跑 `node scripts/test-suite.mjs` 才拿到完整汇总。建议文档里写明用后者。

## 部署要换什么

改了 `src/`：**整份 `src/` 同步进渲染树**（预渲染进程、托管方的渲染服务及工作进程、渲染主机、托管 Agent 服务都按 `src/` 加载；导出页 `ExportView.tsx` 是产流用的那一页）。**先换在线前端，再重启渲染服务。**

- **在线前端重建并换静态页**：父页（`snapshotFeed`、`stageSwap`、`planDispatch`、`costIdentity`、`probeRunner`、`Preview`、`browserNodeHost`）、舞台（`Stage`、`FrameScene`、`CutSegmentScene`、`streamPlayer`、`StageView`）、导出页、在线来源（`snapshotSource.ts`）都在前端构建里。
- **服务端文件**：`server/frame-stream.mjs`、`server/card-cache.mjs`、`server/ready-index.mjs`、`server/artifact-transfer.mjs`、`server/render-node/split.mjs`，以及它们 import 的 `src/kernel/cutFlatten.mjs`（新）、`src/kernel/cutIdentity.mjs`、`src/render/{streamPlanRules.mjs,streamInputSig.mjs,layerInputSig.mjs,cardCostKey.mjs}`。重启托管方的**渲染服务**（连同工作进程）与渲染主机；桌面版随下一个补丁。
- 文档服务、素材服务、Agent 服务不用换（没有新的落盘字段；层表里不再写 `streamKind: 'cut'`）。
- 没有剪辑段的项目：卡片计划、键、层表、像素一个字节不变，旧缓存照用。有剪辑段的项目：上一轮的剪辑段级流不再被引用（成本记录里旧的 `cutSegment` 记录变成用不上的孤儿，无害），剪辑段里的卡按新键测量、产流。
