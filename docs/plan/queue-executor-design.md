# 队列执行器设计（M5b，契约 J 节的附件）

2026-09-25，由只读的架构子 Agent 对照代码写出，主 Agent 核过要点。行号以写作时的 main（`4665995`）为准，只作定位提示；实现时以符号名为准。契约 J 节与本文冲突时，以契约为准。

## 0. 先要知道的四件事

1. **「和 preload 逐字节相同」没有唯一的参照。**
   - 冷启动的 entry 上，preload 同一帧快照可能写三遍：
     - 锚帧那一趟（`fillAnchorSnapshots` → `record` → `recordSnapshots`）；
     - `fillCardControls` 或 `renderLocalSnapshots`；
     - B 趟（`snapshotOnly: true`，对所有目标的每一帧都 `record`）。
   - `commitSnapshots` 覆盖写，后写的赢。执行器复用各自指定的生产者：共享档可缓存的卡走隔离渲染，本地档走 `renderLocalSnapshots`。和 preload 最终落盘的结果是否一致，由 Chrome 探针实测。不一致说明 preload 本身就有这个问题，记为遗留。
2. **卡片计划离不开 Chrome**：`browserCardPlan` 在预渲染间里执行 `window.__pcCardPlan()`。所以 `plan()` 仍要开预渲染间，只是不需要页面会话。
3. **`project.snapshot.get` 在 J 节新建。**
4. **`local-node.mjs` 要补两处**：
   - sink 的 `ref` 要带上 `input` 与 `requires`；
   - `session.complete` 要放进 `put` 返回的 `result`；走去重的，放 `await sink.resultFor(ref)`。

## 1. 放在哪里

- **`server/prerender-executor.mjs`（新）**：`createPrerenderExecutor({ pipeline, projects, prepareProject, log }) → { plan, render, isIdle }`，是一层很薄的适配。它不能放进 `server/render-node/`，那个目录受 D1 守门（只许 Node 内置模块）。
- **真正的活放进 `FramePipeline` / `StreamProducer` 的新方法**，只在被调用时生效，preload 的路径不变。
- **`renderProject`** 从 `vite-plugin-frames.ts` 原样搬到 `server/render-project.mjs`，`.ts` 里转出。
- **`server/render-node/project-client.mjs`（新）**：按版本取项目快照。请求配对、超时、断线的语义与 `content-client.mjs` 相同。

## 2. `plan(planTask)`

新方法 `FramePipeline.planForQueue(project, { signal })`：
1. **取项目**：`project = prepareProject(await projects.get(projectId, projectRev))`，和 `/preload` 路由对镜像做的是同一个 `renderProject`。
2. **建 entry**：`entry = await this.entry(project)`。键是 `frameIdentity(项目 + 素材戳, frameCode(root))`，JSON 相同时与 preload 得到的键相同。
3. **在新的 `'queue'` lane 上算卡片计划**：
   - `runQueueTask(work, signal)`，照 `runAgentTask` 写，链进 `laneChains`，`closeNow` 会等它；
   - `acquire('queue', project)`；`scaleForLane` 让 `'queue'` 用后台的缩放；播放让路的判断也覆盖 `'queue'`；
   - 然后 `browserPlan = await this.browserCardPlan(bakery)`。
4. **记卡片计划**：`ensureCardLocks()`；`entry.cardPlan` 还不是数组时，调 `recordCardPlan(entry, entry.cardCache.plan(browserPlan))`。不调 `adoptCardPlan`，它会去认领会话。
5. **补 `cardId`**：`split.mjs` 要 `control.cardId`，卡片计划里的 control 只有 `nodeId`，所以从 `browserPlan.graph.nodes[].cardId` 补上。
6. **流**：M5b 不走队列，`streams: []`（契约 J.0）。
7. **锚帧**：`anchorFrames(clips, fps)`，只留在范围内的。

**返回的 PlanContext**：

| 字段 | 取值 |
|---|---|
| `entryKey` | `entry.key` |
| `prerenderSet` | `entry.prerenderSet` |
| `cardPlan` | 带上 `cardId`，**去掉不可缓存的共享档卡**（`sourceDependent`：preload 只经整场景或 B 趟产它们） |
| `isUserCard` | 看 `sourceVersions[cardId]` 是不是以 `user:` 开头 |
| `isGraphCard` | 条目带 `graphCard: true` |
| `weightOf` | `canvasHeavy`、`belowDependent`、`unknown`、本地档记 `heavy`，其余 `medium` |

**`cardLocks`、`takeover`**：由本机锁库和 `cardLockDecision` 映射；`reuse`、`defer` 照锁定方的指纹出键。

## 3. `render(task)`：快照

**按版本缓存上下文**：`projectId@projectRev` → `planForQueue` 的结果，LRU 约 4 条。

**把任务对回 control**：按 `clipId` 找到 control，再逐项核对：
- `tier` 与任务一致，`range` 在 `0..count-1` 之内；
- 共享档：`input.contentKey === control.contentKey`，而且 `resultKey === resultKeyOf(contentKey, 本机指纹)`；
- 本地档：`input.entryKey === entry.key`，`input.contentKey === entry.key + "/" + control.contentKey`。

任何一项对不上，就抛 `{ code: 'plan-mismatch', retryable: false }`。

**共享档，可缓存的卡**：`renderCardSnapshotRange(entry, control, { from, to }, { signal, progress })`：
- 在 queue lane 上调 `fillCardControls(entry, bakery, signal, [control], { range, onBatch })`，第 5 个参数是新加的可选参数，preload 从来不传；
- 只改批次的起点（按 4 帧对齐），以及 `snapshotFrames`（只取范围内缺的帧），其余逐字不变；
- 本机锁库里这张卡被别的环境锁住时，抛 `card-locked-local`（不可重试）。

**本地档**：`renderSceneSnapshotRange(entry, control, range, …)`：把本地帧换算成全局帧，照 `renderLocalSnapshots` 原有的过滤条件挑出缺的帧，再调用它。

**返回值**：`null`。sink 自己读磁盘。

## 4. 素材：远端节点

**现在**：Chrome 按预渲染源站取 `/@media/<hash>`，`assetProxyPlugin` 把它转给 `PROMPTCUT_EDITOR_URL`，这个地址是固定的。

**最小改动**：
- `asset-client.ts` 加 `setMediaFallbackBases(list)`，存在 `globalThis` 上；
- 节点经 `watchServiceEndpoints(endpoint, ['asset'], …)` 填这个列表，排除自己；
- `assetProxyPlugin` 对 `/@media/<64 位十六进制>` 的 GET / HEAD，主源回 404 时，依次改试 `<base>/media/<hash>`，Range 透传；
- 只有按哈希寻址的素材走回退。没有哈希的素材只在本机：它的素材戳在远端不同，`entry.key` 因此不同，会被 `plan-mismatch` 拦下。

## 5. 卡片源码

- `frameCode` 对整个 `src/` 取哈希，用户卡也在其中。所以节点的 `codeVersion` 等于 `frameCode` 时，源码一定相同。
- **M5b 的规则**：
  - `plan` 任务要带 `requires.codeVersion = frameCode(root)`；
  - `cardSourceVersions` 留空 `{}`；
  - 远端节点声明 `userCards: false`。
- **未知项**：检出时的 CRLF 差异会让 `frameCode` 不同，届时所有任务都认领不了，W4 会暴露。

## 6. 风险

- **本机 preload 与执行器同时在同一张卡上干活**：快照索引按键串行写，没问题；`MovFrameStore.put` 并发写没有核实过。闲时门槛能挡掉大部分。
- **重复推送**：两边都会把产物进推送队列。内容寻址，无害，但浪费。
- **由谁来做计划**：认领 `plan` 的节点决定所有细任务的指纹。M5b 让 `plan` 带 `requires.envFingerprint`，而且由发布方所在的进程自己优先认领。
- **`entries` 从不回收**：独立主机上会越积越多，M6 处理。
- **导出像素**：G0-R 在队列开、关两种状态下都要跑。

## 7. 测试

**不用 Chrome**：照 `card-lock-pipeline.test.mjs` 的办法，把 bakery 换成假件，注入 `environment`。
- `plan`：`entry.key` 与 `pipeline.entry()` 对同一份 JSON 算出的一致；E.5 的不变量；`cardId` 补上了；不可缓存的共享档卡被去掉。
- `render`：
  - 在帧库 A 上用 `fillCardControls` 渲整张卡，在帧库 B 上用执行器按 60 帧一段逐段渲；
  - 比较两边假 `bakeFrames` 的调用记录和落盘文件；
  - 另测 `plan-mismatch`、中途中止、进度回调；
  - 不传范围参数时，`fillCardControls` 的行为不变。

**要 Chrome**（探针）：
- 用执行器渲出的快照，与 preload 渲出的逐一比对；
- G0-R；
- W4。
