# AGENT 报告：M6c 契约测试（X1～X5）

分支 `claude/m6c-tests`（基于 `claude/m6`），worktree `.worktrees/m6c-tests`。只照 `docs/plan/m6c-contract.md` 写，没读 `claude/m6c-stream`、`claude/m6c-queue` 的实现。X6、X7 已合入，不在本分支范围。

## 做了什么

| 文件 | 内容 |
|---|---|
| `server/test/m6c-kit.mjs` | 任务夹具（流、带 `localMedia` 的快照、带 `preferNode` 的 plan）、文档服务 + 队列模块 + 队列的进程内组合（X3）、X5 的播放头与 preload 模拟；**契约没写死的接口名全在这里**，每条标〔假设 A-…〕，`ASSUMPTIONS` 导出同一份清单 |
| `server/test/m6c-contract.test.mjs` | X1（除执行器）、X2、X3、X4，19 条 |
| `server/test/m6c-executor.test.mjs` | X1 执行器烟测、X5，6 条；`mock.module` 换掉 `server/bakery/index.mjs`，Date 用 `mock.timers` |

驱动方式：队列只经 A.3 公开接口；节点经 `createNodeSession` / `createLocalNode`；会话与队列之间用 D.3 的环回传输；X3 经真的 `createRouter` + `renderQueueModule` + `createRenderQueue`（送信照 `service.mjs` 的 `sendFromOutside` 接 `outbound`）。不起网络，不开 Chrome，不找 ffmpeg。

## 编号对应

| 用例 | 契约 | 验的是 | 在本分支（无实现）上 |
|---|---|---|---|
| MC-X1-filter | X1 能力 | `checkClaimable`：流任务 `requires.capabilities.streams`；`streams:false`（即使 `transcode:true`）与未报的节点拒，`streams:true` 放行 | 失败（预期） |
| MC-X1-filter-snapshot | X1 能力 | 快照任务不受 `streams` 影响 | 通过 |
| MC-X1-split | X1 能力 | `splitPlan` 出的流任务 `requires.capabilities.streams === true`，快照不要求 | 失败（预期） |
| MC-X1-queue-claims | X1 验收 | 真队列 + 会话：`streams:false` 节点对流任务 0 次认领；`streams:true` 节点认领到全部 | 失败（预期） |
| MC-X1-hello | X1 能力 | 会话把 `capabilities.streams` 原样报进 `node.hello` | 通过（回归护栏） |
| MC-X1-done | X1 验收 | 流任务经队列完成，页面每个任务恰好一次 `task.done`，`result` 是 `StreamResult`（`v:1`、`kind:'stream'`、范围为分段号、分段落在范围内） | 通过（走既有 sink 路径，回归护栏） |
| MC-X1-exec | X1 执行器 | `createPrerenderExecutor().render(流任务)` 不再以 `stream-not-supported` 拒绝（烟测） | 失败（预期） |
| MC-X2-queue | X2 验收 | 别的节点：`task.opened` 0 条、晚来的 `queue.snapshot` 不含、认领被拒且任务仍 open；发布方节点能认领 | 失败（预期） |
| MC-X2-node | X2 | 节点侧过滤：会话层（直接喂 `queue.snapshot`）别的节点不认领、发布方节点认领；纯函数层 `checkClaimable` | 失败（预期） |
| MC-X2-e2e | X2 验收 | 两个本机节点跑 20 秒：B 认领 0、收到 0；5 段全部完成、全部由 A 认领 | 失败（预期） |
| MC-X3-browser | X3 验收 | browser `watch all` → `error { reason: 'forbidden' }`；指定项目的 watch 照常 | 失败（预期） |
| MC-X3-host | X3 验收 | host `watch all`：6 个周期、3 个项目持续发布认领完成，单任务增量 0 条；每周期摘要 ≤ 1 条；每条摘要每项目 ≤ 1 项；至少一条摘要；pc 同时照收全量 | 失败（预期） |
| MC-X3-pc | X3 | pc `watch all` 照常回 `queue.snapshot` | 通过（回归护栏） |
| MC-X4-const | X4 | `QUEUE_DEFAULTS.PLAN_PREFER_MS === 5000` | 失败（预期） |
| MC-X4-planTaskOf | X4 发布方 | `planTaskOf({ …, preferNode })` 写进 `requires.preferNode`，id 不变 | 失败（预期） |
| MC-X4-window | X4 验收 | t+1 s 别的 pc 认领被拒，任务仍 open | 失败（预期） |
| MC-X4-prefer | X4 | 窗口内 preferNode 能认领 | 通过 |
| MC-X4-after | X4 验收 | t+5001 ms 别的 pc 能认领 | 通过 |
| MC-X4-host-browser | X4 验收 | host、browser 在 t+1 s / 6 s / 60 s 直接认领 plan 都被拒 | 失败（预期） |
| MC-X4-sessions | X4 验收 | 会话跑 20 秒：窗口内 B 认领不到，窗口后 B 认领到；host、browser 0 次 | 失败（预期） |
| MC-X5-idle | X5 | preload 代际没到 ready、没有交互：`executor.isIdle()` 为真 | 失败（预期） |
| MC-X5-drag | X5 | 100 ms 前拖过不闲；最后一次拖动在 600 ms 前算闲 | 失败（预期；现行判据是 800 ms，见歧义 5） |
| MC-X5-play | X5 | 播放中不闲 | 通过 |
| MC-X5-claim-before-ready | X5 验收 | 真队列 + 本机节点（`isIdle` 接真执行器）：preload 在跑时已开始认领 | 失败（预期） |
| MC-X5-drag-no-claim | X5 验收 | 拖动 2 秒：新认领 0 次；手里那段在拖动中途做完并收到 `task.done`；停下后恢复认领 | 失败（预期） |

## 验证

```
node --check server/test/m6c-kit.mjs                 → 退出码 0
node --check server/test/m6c-contract.test.mjs       → 退出码 0
node --check server/test/m6c-executor.test.mjs       → 退出码 0
node --experimental-test-module-mocks --test server/test/m6c-contract.test.mjs   → tests 19, pass 6, fail 13（退出码 1）
node --experimental-test-module-mocks --test server/test/m6c-executor.test.mjs   → tests 6,  pass 1, fail 5（退出码 1）
```

失败全部逐条看过，原因都是「新行为还没有」，不是用例写错：例如 X2 是 node-B 收到了 `snapshot:rk-local:0-59` 的 `task.opened`；X3 是 browser 拿到 `queue.snapshot`、host 收到 `task.opened/taken/closed`；X4 是 node-B 在窗口内拿到 `task.claimed`；X5 是 `isIdle()` 在 preload 没 ready 时回 false。

**夹具自检**：把 X5 用例里的 preload 模拟去掉、600 ms 换成 800 ms（现行判据）另跑一份临时副本，X5 五条全过（副本已删，没提交）。说明 X5 的拓扑、播放头、手动放行的执行都能跑通，失败只来自门槛本身。X4-prefer / X4-after、X1-done 在现状下通过，也说明各自的拓扑是通的。

没跑全量测试与 tsc：本分支只新增三份测试文件，不改被测代码；新文件在无实现时按预期失败，全量测试因此会红，集成时由主会话对账后再跑。

## 接口假设（主会话对账用；全在 `m6c-kit.mjs`）

- **A-X1-1**：执行器的流路径仍是 `createPrerenderExecutor({ pipeline, projects, prepareProject, log }).render(task, { signal, progress })`。烟测用假管线（`streams()` / `streamProducer()` 回一个任何方法都是异步空操作的对象），只断言不以 `code: 'stream-not-supported'` 拒绝；300 ms 内不落定也算通过。真产流归 `queue-mode-probe` / `stream-produce-probe`。
- **A-X1-2**：`StreamResult` 经 `sink.put` 回的 `{ complete: true, result }` 进 `task.complete`（C6.2 / J.3 的既有路径），`local-node` 签名不变。
- **A-X2-1**：`checkClaimable(task, node)` 从 `node.nodeId` 取本节点 id 比 `requires.localMedia`。会话层用例另走 `createNodeSession({ nodeId })`，不依赖这一条。
- **A-X3-1**：X3 可以落在队列（`onWatch`）或文档服务的队列模块任一层；用例经两层的组合驱动。
- **A-X3-2**：host 发不带 `mode`（或 `mode: 'full'`）的 `queue.watch { projects: 'all' }` 也按摘要处理，至少收到一条 `queue.summary`。
- **A-X3-3**：browser 的 watch all 回 `{ type: 'error', reason: 'forbidden' }`，与 H.3 摘要订阅的拒绝同形。
- **A-X4-1**：`QUEUE_DEFAULTS.PLAN_PREFER_MS`，可经 `createRenderQueue({ constants })` 覆盖；窗口从发布时刻起算。
- **A-X4-2**：`planTaskOf({ projectId, projectRev, preferNode })` 写 `requires.preferNode`。
- **A-X4-3**：被拒一律是 `task.claim-rejected`（原因名不限），任务保持 open。
- **A-X5-1**：「preload 没 ready」用 `FramePipeline` 内部的 `generations` / `entries` 模拟：一个未中止的代际指向 `status: 'html'` 的 entry。
- **A-X5-2**：「交互帧请求」用构造时注入的 `playhead()` 模拟（拖动 `{ at, playing: false }`，播放 `{ at, playing: true }`）。实现若改用别的信号（例如 `user` / `playback` lane 的帧请求时间戳），只改 kit 的 `createPlayhead`。
- **A-X5-3**：本机队列节点的闲时门槛仍是 `executor.isIdle(now)`。

## 契约歧义与更正建议

1. **X3 会饿死 M6b 的独立渲染主机**（最要紧）。`host.mjs` 给每个项目起的 `createLocalNode` 没传 `projects`，会话缺省发 `queue.watch { projects: 'all' }`，靠单任务增量挑活。X3 让 host 的 watch all 只收摘要后，主机再也看不到任务。建议契约写明：host 按摘要挑项目后改为 watch 具体项目（或 `host.mjs` 传 `projects: [projectId]`），并把这条放进 `claude/m6c-queue` 的范围；否则 RHC / H1 会回归。
2. **X3 判定落在哪一层没写**：队列 `onWatch` 还是文档服务的队列模块。两处都能做，用例已按两层组合驱动，但建议契约定一处。另：host 的全量 watch 是「转成摘要订阅」还是「回 forbidden 要求改发 `mode: 'summary'`」没写，用例按前者（A-X3-2）。
3. **X4 的拒绝原因名没定**，也没说窗口内别的节点看不看得见这个 plan（`task.opened` 发不发、窗口过后要不要补发）。若窗口内不发、窗口过后不补，别的 pc 永远不知道能认领了；建议写明窗口到期由 `tick` 补发 `task.opened`，或窗口内照发、认领时拒。用例只断言认领结果。preferNode 断开时窗口是否提前结束也没写。
4. **X2 切分侧的输入没定**：`splitPlan` 从哪里知道「素材没有内容哈希」、发布方 nodeId 从哪个参数来，都没写，所以本分支没写切分层的 X2 用例，只测了 `requires.localMedia` 的队列与节点两侧。建议契约补上 PlanContext 里标记的字段名。X2 的拒绝原因名同样没定。
5. **X5 的 500 ms 与现行 800 ms**：`FramePipeline.streamBusy` 把 800 ms 内动过算忙，执行器现在用它。契约说 500 ms，用例 MC-X5-drag 按 600 ms 算闲来测；若主会话认为流生产仍按 800 ms 让路、只是队列门槛改 500 ms，这条就是在验证两者分开。另外「执行器有空位」没定义（执行器并发数？流生产者在忙算不算没空位？），用例没测这一项。
6. **X1 `PROMPTCUT_STREAMS=0` 时不发布流任务**、**纯浏览器一律报 `streams: false`**、**清单键 `<resultKey>:<from>-<to>`**：单进程里没有干净的入口（开关在预渲染进程接线、浏览器节点在 `src/` 侧、清单写在真 sink 里），本分支没写，归探针或 `claude/m6c-stream` 自测。
7. **流任务的 `requires` 形状**：契约只说 `requires.capabilities.streams = true`，没说旧的 `requires.transcode: true` 与过滤规则 2（流要 `capabilities.transcode`）去留。用例的「能认领」一侧同时给了 `transcode` 与 `streams`，两种取舍都不影响结果。
