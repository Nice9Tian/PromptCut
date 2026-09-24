# 报告：渲染任务队列 M3（进程内集成）

集成分支 `claude/rq-m3`，基于 main 的 `3f1f733`（M1、M2 已合入）。2026-09-24。未合并 main，等用户审核。

- 依据：`docs/plan/distributed-prerender-queue.md`（设计）
- 任务书：`docs/plan/TASK-distributed-prerender-queue.md`（M3 行）
- 契约：`docs/plan/render-queue-contract.md`（D 节是本阶段的；A.4 末段、A.10a 有本阶段的补充）

子 Agent 不能写报告文件，本文由主 Agent 并写。

## 1. 结果

| 项 | 命令 / 位置 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误 |
| 全量测试 | `npm test` | **tests 2086，pass 2085，fail 0，skipped 1**。M2 之后的 2072 条加新增 14 条；跳过的 1 条照旧，需要 5190 的 dev server |
| 进程内集成 | `server/test/render-queue-inproc.test.mjs` | 13 条全过：I1～I11，其中 I8 两条、I11 两条 |
| 队列协议 | `server/test/render-queue-protocol.test.mjs` | 16 条全过（新增 P16） |
| 队列、节点、集成合计 | `node --test server/test/render-queue-*.test.mjs server/test/render-node-*.test.mjs` | 174/174 |

**全链路**（I1）：

1. 页面发布 `plan`；
2. 两个本机节点中恰有一个认领它，调执行器算出 card plan，切出 5 个快照任务（共享档加本地档）和 2 个流任务，并在仍持有 `plan` 时发布它们；
3. 两个节点认领细任务、执行（假执行器）、把产物推到产物库（假 sink，推送后确认收全）、报完成；
4. 页面收到 `plan` 与全部细任务的 `task.done`，细任务的 `userId` 是页面的用户（继承）；
5. 每个任务恰好完成一次，产物库里每段都在，`describe()` 全部 `done`。

**首次对账**：测试方照契约写测试，没有看实现。合进集成分支后，对真实的 local-node 11/11 首跑全过。

## 2. 交付物与隔离

| 文件 | 性质 | 说明 |
|---|---|---|
| `server/render-node/local-node.mjs` | 生产编排模块 | 只认注入的 `endpoint`、`executor`、`sink`（接口在 JSDoc 里）；只引 `./session.mjs`、`./split.mjs`；不碰网络、文件系统、环境变量、计时器 |
| `server/render-node/index.mjs` | 生产 | 加一行，转出 `createLocalNode` |
| `server/render-queue/queue.mjs` | 生产 | +21 行：继承条件满足时，已存在的细任务也并入 plan 的订阅者，并补发 done / failed（见第 3 节） |
| `server/test/fake-loopback-transport.mjs` | **仅测试** | 环回传输：单一先进先出、经 `flush` 投递、JSON 往返、分区与关闭 |
| `server/test/fake-artifact-sink.mjs` | **仅测试** | 内存产物库：预置、推送失败注入、调用记录、接口误用检查 |
| `server/test/fake-render-executor.mjs` | **仅测试** | 可编排执行器：耗时、进度、可重试 / 不可重试失败、卡死；带假时钟 |
| `server/test/render-queue-inproc.test.mjs` | 测试 | I1～I11 |
| `server/test/render-queue-protocol.test.mjs` | 测试 | 加 P16 |
| `docs/plan/render-queue-contract.md` | 契约 | D 节；A.4 末段、A.10a 的补充 |
| `docs/plan/distributed-prerender-queue.md` | 设计 | 第 5 节「进度停滞」补 `progress(0)` |

**隔离核查**（在集成分支上执行）：

- 三个假件只被 `server/test/` 引用，文件头第一段都写明「仅供测试与进程内集成，生产代码不得引用」；
- `server/render-queue/`、`server/render-node/` 不被任何生产模块引用；
- `local-node.mjs` 只 import 同目录的两个模块，没有 `process.env`、计时器、`node:fs`、`node:net`、`node:http`、`WebSocket`。唯一一处「WebSocket」字样在注释里。

**与任务书 M3 行的差异**：任务书原写「`frame-pipeline.mjs` 里节点接入的那一段（新方法，开关后面）」。本阶段不改 `frame-pipeline.mjs`，也没有改任何既有业务代码。

- 理由：接真管线要么在单测里起 Chrome，要么让假件留在生产路径的开关后面，两者都违反用户的隔离要求。
- 接真实预渲染执行器（`executor` 用 `FramePipeline` 实现、`sink` 用素材服务实现）移到 M5。
- 已写进契约 D 节开头，TODO 同步。
- 因为没动业务代码，任务书 M3 行要求的「现有探针照旧通过」自然成立，本阶段没有另跑探针。

## 3. 本阶段发现并修掉的问题

| 来源 | 问题 | 处理 |
|---|---|---|
| 实现方（local-node） | 会话每次 tick 都用 `done: null` 续约，而停滞规则只在 `done !== null` 时生效。所以从不报进度的卡死执行器只要节点还在 tick，就永远不会被回收，设计第 5 节「进度停滞」一行形同虚设 | 契约 D.2：节点开工时先同步报一次 `progress(0)`。I8 改为按停滞回收（`lastError: 'stalled'`），另加一条「节点连心跳也停了」按租约回收。设计第 5 节补了这一句 |
| 实现方 | `start(resume)` 把不在跑的项也交给会话，会一直续约、占住并发名额，却永远完不成 | 契约 D.2：只保留本实例在跑表里、令牌相同的项；新进程等于不接续 |
| 实现方 | `splitPlan({ ..., ...ctx })` 里执行器返回的字段能盖掉切分节点自己的指纹 | 改为 `{ ...ctx, planTask, envFingerprint, codeVersion, constants }`，I6 专门验证 |
| 测试方 | 共享档的结果键与项目无关，同一张卡在新一版项目里切出的细任务常常已经存在；原先继承只在新建时发生，页面收不到这些细任务的 `task.done`。编辑后不变的卡都会中招 | 契约 A.4 末段：继承条件满足时，已存在的任务也并入 plan 的订阅者，已完成 / 已失败的给新并入的订阅者补发一条通知。队列改了 21 行，P16 与 I11 验证。I11 覆盖了「v1 全部完成后再发 v2」和「v1 还在跑时 v2 就被切分」两种情形；不变的卡不重渲，改了的照常渲染 |

## 4. 各子 Agent 的工作

| 角色 | 分支 | 提交 | 自测 |
|---|---|---|---|
| Pipeline/Node | `claude/rq-m3-node` | `44f6b02`、`8544479`、`12264dc` | 真队列加极简环回的一次性脚本 10/10。覆盖：全链路、去重、卡死后按停滞回收、同 id 换新令牌时旧执行不会误完成、让路、失败与重试、stop、开工先报 0、resume 过滤 |
| Verification/Test | `claude/rq-m3-tests` | `0f93a86` 等 5 次，另加 `b1be3fe`、`1427b38` | 照契约写了一个假 local-node，13/13 过；注入 17 个变异，全部被抓到；对真实实现首跑 11/11 |
| Protocol/State | `claude/rq-m3-state` | `b76c0ac` | 一次性脚本 20/20；既有 171 条不退化 |

主 Agent 的集成提交：`c6be5b2`、`6157314`、`571236e`、`63af5b0`；契约提交：`48854c9`、`744c8d7`、`8b4398c` 及其后一次。

## 5. 遗留（进 M5 及以后）

- **撤销后的迟到推送**：I3 里断开的节点不知道自己的认领已经没了，仍会把产物推到产物库，只是完成消息被丢弃。按内容寻址这没有害处，但设计第 7 节「节点信任」要求能记账。M5 的素材服务要不要按令牌核对推送，届时定。
- **浏览器节点可能很少分到活**：Q3 把 Chrome 主版本放进了环境指纹，而本机 PC 渲染用的 Chrome 与用户浏览器的主版本常常不同，那样浏览器节点永远认领不到 PC 切出的细任务。I5 让两者用同一个指纹，才有活可干。M7 之前应当实测，或者对浏览器节点放宽版本这一维。
- **令牌重号**：同一 local-node 实例里已经由「中止 + 执行身份 + 令牌」三道核对挡住；跨进程重启的残留 worker 仍只能靠内容寻址兜底（A.10a 已列）。
- **契约没写死、实现自定、测试不依赖的细节**：`running()` 在中止瞬间就不再列出、`discarded` 事件的触发时机、流任务交给 sink 的 `tier` 为 `null`、环回 `close()` 同时丢弃自己没发出去的消息。

## 6. 需要用户决定

- 是否把 `claude/rq-m3` 合并进 main（`--no-ff`）。
- 合并后是否清理 `.worktrees/` 下的 4 个工作区（`rq-m3`、`rq-m3-node`、`rq-m3-tests`、`rq-m3-state`，都没有 junction）及其分支。
