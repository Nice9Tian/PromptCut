# AGENT 报告：剪辑段参与测量与预渲染

分支 `claude/cut-segment-prerender`，工作区 `.worktrees/cut-segment-prerender`，基于 main `80bf8246`。
背景：`docs/archive/agent-reports/AGENT-cut-segment-followups.md`「没做成的」第 1 条（剪辑段即「剪辑套剪辑」：一条剪辑放进另一条剪辑序列里的那种片段；原来它和里面的卡一律在舞台里活渲，内容重时预览按「慢帧就等」变慢）。按那张解法表的第 2 行（把整个剪辑段当一张重卡：测量剪辑段的成本，按它产一条剪辑段级的轨道流）做，没有走到要改语义层级的地步，没建新的解法表。

## 状态

见文末「结论」。没有推送、没有合并。

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

修改：`src/kernel/{cutSegments.ts,cutIdentity.mjs,cutIdentity.d.mts}`、`src/ExportView.tsx`、`src/editor/{costIdentity.ts,browserNodeHost.ts,probeRunner.ts,snapshotFeed.ts,stageSwap.ts}`、`src/render/{CutSegmentScene.tsx,Stage.tsx,layerInputSig.mjs,streamInputSig.mjs,streamPlanRules.mjs,streamPlanRules.d.mts,cardCostKey.d.mts,snapshotSource.ts}`、`server/{card-cache.mjs,frame-stream.mjs,ready-index.mjs}`、`server/render-node/split.mjs`；测试替身 `src/editor/{stageSwap.test.mjs,stageSwapBaseline.test.mjs,c10a-swap-gate.test.mjs}`（`snapshotFeed` 的替身补一个 `cutStreamHeavy`）；语义 `docs/semantics/mechanism/rendering.md`。

没动 `server/hosted-render/**`：托管渲染服务的工作进程跑的是同一份预渲染管线和导出页，按同一份 `planStreams` 认剪辑段。

## 验证

（收尾时填）
