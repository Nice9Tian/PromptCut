# AGENT 报告：M6c 集成对账（`claude/m6c-integ`）

- worktree：`.worktrees/m6c-integ`，分支 `claude/m6c-integ`（起点 `claude/m6` @ `932c72e`：M6a、M6b、M6c-X6X7、W5 探针）
- 依次 `--no-ff` 合并 `claude/m6c-stream`、`claude/m6c-queue`、`claude/m6c-tests`；按主会话裁定核对并改实现；测试对账；基线与 G0-R。
- 没推送、没合并到别处、没装依赖、没建 junction、没跑 `npm ci`。
- 状态：见第 6 节「结论」。

## 1. 合并与冲突

| 合并 | 提交 | 冲突 |
|---|---|---|
| `claude/m6c-stream`（X1） | 合并提交（无冲突） | 无 |
| `claude/m6c-queue`（X2～X5） | `e1777bf` | 4 个文件，见下 |
| `claude/m6c-tests`（契约测试） | 合并提交（无冲突） | 无 |

`claude/m6c-queue` 的四处冲突（两边新行为都保留，合并提交说明里同样写了）：

- `server/render-node/filter.mjs`：只冲突在文件头的规则说明。规则 1 取 queue 的（带 `preferNode` 的 plan 查指纹、`localMedia` 闸），规则 2 取 stream 的（`capabilities.streams`，没报的按 `transcode`）并保留原「轨道流要转码能力」。函数体自动合并，两条新判断都在。
- `server/render-node/split.mjs`：流任务的 `requires` 同时要 X1 的 `capabilities: { streams: true }` 与 X2 的 `gateLocalMedia(…, { clipId, kind: 'stream' })` 包装：先写全 `requires`，再交给 `gateLocalMedia`。
- `server/vite-plugin-frames.ts`：本机 PC 节点的 `createLocalNode` 用 stream 的 `capabilities`（`nodeCapabilities` 实报 `streams` / `transcode`），`isIdle` 用 queue 的 `idleGate.idle()`（X5 门槛，取代 `executor.isIdle()`）。
- `scripts/probes/queue-mode-probe.mjs`：stream 把 preload 挪进了 `preloadOn`（为了 `--peer` 两台同时 preload）；queue 的 X5 证据（preload 没到 ready 期间的认领数）随之移进 `preloadOn`、按实例统计，`runOnce` 取主实例那份；收尾同时删 peer 的目录并记 `out.x5`；末行同时打 `streamTasks` / `streamDone` / `streamCompare` 与 `x5`。

## 2. 裁定核对与改动

逐条已写进 `docs/plan/m6c-contract.md` 末尾「## 集成时的裁定（2026-09-26）」。

| 裁定 | 核对结果 | 改动 |
|---|---|---|
| X1 两个能力字段：同报 `streams` 与 `transcode`（同一次编码器探测），规则 2 两条同时生效，没有 `streams` 的回落 `transcode` | 实现一致（`nodeCapabilities`、`filter.mjs` 规则 2） | 无；契约测试 MC-X1-filter 一条断言按裁定改（B 类，第 3 节） |
| X1 空档：切 plan 的节点关着流、本机开着流时本机的流不能丢 | 原来会丢（stream 报告第 4 节第 4 条） | **本机自己产**：`FramePipeline.releaseQueueStreams(entryKey)`（标 `entry.queueStreamsLocal`）；`StreamProducer.queueOwned` 见标记不再归队列；`vite-plugin-frames.ts` 发布时记下 entry，收到自己那个 plan 的 `task.done`、`derived` 里没有 `stream:` 任务且本机 `capabilities.streams` 为真时调它（发布回包前 plan 已完成的也补判一次）。单测 X1-local-fallback。理由见契约裁定 |
| X2 `localMedia` 由切分判断、filter 读 `node.nodeId` | 一致 | 无 |
| X2 已知限制（图节点间接引用判不出） | — | 写进契约为已知限制 |
| X3 host 按摘要再单独订阅项目 | 一致（`session.mjs` `followSummary`；队列非空列表不停摘要） | 无；`render-queue-contract.md` H.3 补一条 |
| X4 窗口内回 `preferred`、不丢候选 | 一致（`queue.mjs`、`session.mjs` 的 `deferred`） | 无 |
| X4 preferNode 断开窗口立即结束 | **原来没有**（只按时间） | `queue.mjs` 的 `detachNode` 给该节点做 preferNode 的 open plan 标 `preferEnded`，窗口判定跳过；重连不恢复。单测 X4-6 |
| X4 `PLAN_PREFER_MS` 在 `QUEUE_DEFAULTS`、`planTaskOf` 接受 `preferNode`、host/browser 认领 plan 回 `plan-profile` | 一致 | 无；`render-host-contract.md` 第 6 节补注 |
| X5 阈值 500 ms、空位 = 执行中 < `maxConcurrent` | 一致（`queue-idle.mjs` `INTERACTION_QUIET_MS = 500`；会话 `holds.size >= maxConcurrent` 与在飞认领不认领） | 无 |
| 语义冲突：queue lane 让路期间取消在跑任务 | 冲突属实：`acquire('queue')` 在让路租约在期 / 正在让路时抛 `Background yielded to playback` | `frame-pipeline.mjs` `acquire` 只对 `'background'` 让路；`'queue'` 认领在手的做完为止，不认领新的由闲时门槛管。单测 MI-yield-queue（改前失败、改后通过，第 4 节）。`queue-executor-design.md` 第 3 步补注 |
| 删执行器 `isIdle()` | 生产代码无引用（`git grep isIdle` 只剩 session / local-node / host 自己的 `isIdle` 参数） | `prerender-executor.mjs` 删 `isIdle` 与 `SETTLED`，只剩 `{ plan, render, forget }`；J8 用例作废（注释说明）、J 公共夹具里「执行器有 isIdle」改为「没有」、X5-2 删掉对 M5b `isIdle` 的对照两行；`render-queue-contract.md` J.4 补注。单测 MI-no-isIdle |

## 3. 测试对账（MC-X1～MC-X5）

合并后第一次跑 `m6c-contract` + `m6c-executor`（25 条）：20 过、5 败。归类：

| 用例 | 类 | 处理 |
|---|---|---|
| MC-X5-idle、MC-X5-drag、MC-X5-claim-before-ready、MC-X5-drag-no-claim | A 胶水 | 〔假设 A-X5-3〕原是 `executor.isIdle(now)`；实现是 `queue-idle.mjs` 的 `createQueueIdleGate({ pipeline }).idle(now)`。只改 `m6c-kit.mjs` 的 `queueIdle`（参数由执行器改为管线）和用例里 `queueIdle(…)` 的实参（`executor` / `real` → `pipeline`），断言一条没动 |
| MC-X1-filter | B 测试写错（按裁定） | 断言「没报 `streams` 的节点不该能认领流任务」与裁定「没有 `streams` 字段的节点回落 `transcode`」不符。契约 X1 原文：「流任务的 `requires.capabilities.streams = true`，节点侧过滤照此执行」，没说没报的旧节点怎么算。改为：没报 `streams`、有 `transcode` → 能认领；两者都没有 → 不能 |
| C 类 | — | 无（实现改动都来自主会话裁定，第 2 节） |
| D 类 | — | 无新增。测试方报告的歧义 1～7 已由主会话裁定覆盖（X3 host 订阅、X3 落在队列本体、X4 `preferred` 与候选、X2 切分输入、X5 500 ms 与空位、X1 `transcode` 去留） |

其余 20 条第一次就过（MC-X1-split、MC-X1-queue-claims、MC-X1-exec、MC-X2-*、MC-X3-*、MC-X4-*、MC-X5-play 等）。

## 4. 基线与单测（原始关键行）

（待补）

## 5. G0-R 与探针（原始关键行）

（待补）

## 6. 结论与遗留

（待补）
