# 移交：预渲染进程的就绪索引缺少版本与会话隔离（Item 4）

来源：预览兜底任务（分支 `claude/fix-preview-degrade-sync`，报告 `REPORT-preview-degrade-sync.md`）里智能体 A 的跟进建议第 4 项。
用户决定把它剥离出来，作为独立的专项任务处理；本文件只记录现状、成因、影响和修复要点，**本分支没有改这部分代码**。
行号以本分支合并进 main 时的 `server/frame-pipeline.mjs` 为准。

## 一句话

预渲染进程里只有**一份**就绪索引（`FramePipeline.readyIndex`），页面经 SSE 订阅它；但往索引里发布、重置索引的代码路径
大多**不知道自己服务的是哪一版项目、哪一个页面会话**，于是旧版本的结果会被发给页面，别的会话（Agent 查询、导出）的渲染也会把页面的索引清空。

## 背景：索引与版本

- `FramePipeline` 按项目内容的键（`entry.key`，内容寻址，任何编排改动都会换键）维护多个 `entry`（`this.entries`，`:166`、`:370`～`:395`）。
- 就绪索引只有一份：`this.readyIndex = createReadyIndex()`（`:165`）。页面订阅的 SSE 端点 `GET /api/frames/ready`（`server/vite-plugin-frames.ts` 的 `/ready`）
  **不看**请求里的 `session` / `localRev`，所有页面共享同一条流。
- 「页面现在对的是哪一版」只靠 `adoptCardPlan(entry, plan)`（`:1158`）隐式表达：`entry.key` 与上次不同时 `readyIndex.reset()`，
  并记 `this.adoptedEntryKey = entry.key`。

## 成因（三类）

### 1. 发布不校验版本

往索引里发层的地方共有五处，只有一处（疑点 F 的修复）比对了 `adoptedEntryKey`：

| 位置 | 函数 | 是否校验 |
|---|---|---|
| `:971` 附近 | `flushSnapshots` | 已校验（F 的修复：`adoptedEntryKey !== entry.key` 时跳过） |
| `:1263` 附近 | `renderLocalSnapshots` | **未校验** |
| `:1286` 附近 | `missingSnapshotFrames`（顺带把已有区间发成层） | **未校验** |
| `:1346` 附近 | 锚帧 / 控件快照路径 | **未校验** |
| `:1393` 附近 | 控件快照批次 | **未校验** |

另外轨道流由 `StreamProducer`（`server/frame-stream.mjs`）经 `stageByKey` / `republish` 发层，同样没有版本概念。
后果：用户改了一版之后，旧 entry 还在跑的批次（后台 lane 不打断正在跑的那一批）完成时，把**旧键**的层发进刚为新版本重置过的索引，
页面据此贴旧快照；只要新键的同一层迟迟没有产出，旧层就一直留着。

### 2. 任何渲染都能「认领」索引

`cardRender(entry, bakery, frames, lane)`（`:800`）在每次渲染时调用 `adoptCardPlan(entry, plan)`（`:805`），**不分 lane**。
Agent 的查询渲染（`see_frames`，lane `agent`）、导出（final）、交互帧（`user` / `playback`）拿到的 `entry` 可能是另一个会话、另一版项目；
只要它的 `entry.key` 和页面当前那版不同，页面的整张索引就被 `reset` —— 页面上所有重卡同时丢料，按兜底顺序退到占位符，
直到页面那一版的层被重新发布。`preload`（`:1014`～`:1038`）里也调 `adoptCardPlan`，那一处是正当的「页面这一版」。

### 3. 索引和 SSE 不分会话

即使发布都带了版本，一份索引、一条不区分会话的 SSE 也无法同时服务两个页面（两个编辑器标签页、或编辑器与观看页）。
目前实际只有一个编辑页，所以问题主要表现为上面两类；但任何按版本修的方案都要先回答「当前版本」属于哪个会话。

## 影响范围

- **用户可见**：编辑后预览里的重卡可能贴改之前的快照（播放中属于「沿用旧的预渲染结果」，语义允许，但暂停态被 `snapshotFeed` 的 settled 集合挡住）；
  Agent 查询渲染或导出期间，预览里的重卡可能成片退到占位符。
- **不影响**：导出和 Agent 查询自身的画面（它们不读就绪索引）；导出像素基线。
- **与本分支的关系**：本分支新增的前端预渲染触发（Item 5，编辑推送成功后防抖 `preload`）会让「页面这一版」更及时地被 `adoptCardPlan`，
  能缩短第 1 类的窗口，但不能消除第 1、2 类。

## 涉及的文件

- `server/frame-pipeline.mjs`：`publishLayer`、`adoptCardPlan`、`cardRender`、`preload`、`flushSnapshots`、`renderLocalSnapshots`、`missingSnapshotFrames` 及锚帧 / 控件快照路径。
- `server/ready-index.mjs`：索引本身（`reset` / `setLayer` / `claim` / `backlog`）。
- `server/frame-stream.mjs`：轨道流的层发布（`stageByKey`、`republish`、`claimLayers`）。
- `server/vite-plugin-frames.ts`：`/ready` SSE 端点（不看 session / localRev）。
- `src/render/snapshotSource.ts`、`src/editor/snapshotFeed.ts`：页面侧订阅与应用（本分支已改为只按 session 做键、只听服务端 `reset` 清表）。
- 现有测试：`server/test/ready-stale-flush.test.mjs`（F 的回归），可作为新测试的样板。

## 修复要点（供专项任务参考，未定案）

1. **「当前版本」显式化**：服务端记录每个页面会话当前的 `entry.key`（在 `preload` 或镜像推送到达时更新），不再靠 `adoptCardPlan` 的副作用。
2. **发布统一收口**：`publishLayer(entry, …)` 带上它属于的 entry，不是该会话当前版本就丢弃；五处发布和轨道流的发层都走这一个口子。
3. **拆开 `adoptCardPlan`**：「把计划记在 entry 上」（`entry.cardPlan`、`prerenderSet`）永远做；「重置并认领页面索引」只对当前版本做。
   `cardRender` 只做前半。
4. **按会话分索引（可选，取决于是否要支持多页面）**：`readyIndex` 按会话分份，`/ready` 按 `session` 订阅。
5. **验收**：新增服务端测试覆盖「旧批次晚到」「Agent / 导出渲染另一版」「两个会话交替」；跑 `scripts/probes/ready-index-probe.mjs` 和 `preview-fallback-probe.mjs`。

## 需要专项任务先定的事

- 是否要支持同一预渲染进程同时服务多个编辑页（决定要不要做第 4 点）。
- 「当前版本」以 `preload` 为准还是以镜像推送为准（两者到达顺序不保证）。
