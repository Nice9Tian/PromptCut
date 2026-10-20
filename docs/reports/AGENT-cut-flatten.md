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

新增：`src/kernel/cutFlatten.mjs`、`src/kernel/cutFlatten.d.mts`、`src/kernel/cutFlatten.test.mjs`、`server/test/cut-flatten-streams.test.mjs`、`scripts/probes/cut-flatten-probe.mjs`、本报告、`docs/reports/assets/cut-flatten/**`。

修改：`server/{artifact-transfer.mjs,card-cache.mjs,frame-stream.mjs,ready-index.mjs,render-node/split.mjs}`、`src/{ExportView.tsx,StageView.tsx}`、`src/editor/{Preview.tsx,browserNodeHost.ts,costIdentity.ts,planDispatch.ts,probeRunner.ts,snapshotFeed.ts,stageSwap.ts}`、`src/export/streamFrames.ts`、`src/kernel/{cutIdentity.mjs,cutIdentity.d.mts,cutSegments.ts}`、`src/online/pageStreamPlan.ts`、`src/render/{CutSegmentScene.tsx,FrameScene.tsx,Stage.tsx,cardCostKey.mjs,cardCostKey.d.mts,layerInputSig.mjs,snapshotSource.ts,streamInputSig.mjs,streamPlanRules.mjs,streamPlanRules.d.mts,streamPlayer.ts}`、测试替身 `src/editor/{c10a-swap-gate,stageSwap,stageSwapBaseline}.test.mjs`（去掉 `cutStreamHeavy`）、探针 `scripts/probes/cut-online-e2e-probe.mjs`（改逐卡口径）、语义两本。

删除：见第 8 条。
