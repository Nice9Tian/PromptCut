# AGENT 报告：多项目渲染节点（claude/multi-project-render）

0.7.19 的一项：渲染服务的多项目模式。每个请求只加载它那几帧用到的卡和素材，不让哪个项目占着；取代 0.7.18 的暂行办法「云端 Agent 按轮占用」。

- worktree：`.worktrees/multi-project-render`，分支 `claude/multi-project-render`，从 main `6c571a27` 切。
- 端口段：5880～5889（开发服务器 5880～5882；端到端探针 5880～5889）。
- 语义出处：`docs/semantics/product/rendering.md`「渲染服务的两种模式」（下称「产品那一条」）；`docs/semantics/mechanism/rendering.md`「多项目模式的做法」（下称「机制那一条」）。语义文档一个字没改。

## 状态

__STATUS__

## 先说一个更正：0.7.18 暂行办法在哪

任务书说暂行办法的实现在 `server/render-node/local-node.mjs`、`session.mjs`、`task-runner.mjs`。核过：这三个文件里没有按轮占用的东西（搜「还在」「占住」「roundId」命中的是别的意思）。暂行办法实际在：

| 位置 | 内容 |
|---|---|
| `server/hosted-render/isolation.mjs` | `acquireTurn` / `releaseTurn` / `cancelTurn` / `unlockProject` / `heartbeat` / `checkHeartbeats` / `markModified`，`lockedProject`、`activeTurns`、`queuedTurns`；`HEARTBEAT_TIMEOUT_MS`（2 分钟）、`STREAM_SLICE_MS`、`IDLE_NO_MODIFY_MS`；`tick` 里的「这一轮放开才让位」「产流让位」「真人在线项目五分钟轮换」「流产满且五分钟没修改才关」，以及更早的「空闲满五分钟才让位」`IDLE_MS`、「连续做满五分钟让一轮」`SLICE_MS` |
| `server/hosted-render/look.mjs` | `routeOnce` 里调 `acquireTurn`；`/look/release`、`/look/heartbeat` 两条；排队异常时 `unlockProject`；撤回时 `cancelTurn` |
| `server/hosted-render/main.mjs` | `isoIdleMs` / `isoSliceMs` 配置，把 `isolation` 交给 `createLook` |
| `server/hosted-render/broker.mjs` | 路由表里的 `/look/release`、`/look/heartbeat` |
| `server/agent/service/account-runner.mjs` | 每 30 秒发心跳、收尾 / 被叫停 / 出错时发「结束了」 |
| `server/agent-service/account-task-worker-config.mjs`、`account-master-assembly.mjs`、`look-client.mjs` | 任务进程 → 主服务 → 渲染服务转这两条 |

## 做了什么

### 找出来的渲染服务相关文件（全清单）

托管方的渲染服务（管理进程与工作进程）：`server/hosted-render/` 下 `main.mjs`（管理进程）、`broker.mjs`（代理口与诊断口）、`isolation.mjs`（隔离工作进程编排）、`look.mjs`（看画面的口子与调度）、`render-requests.mjs`（看画面的持久队列）、`worker.mjs`（工作进程看护、按项目的素材作用域）、`limits.mjs`（背压、内存看护）、`directory.mjs`（目录连接）、`page-gate.mjs` / `vite-gate.mjs` / `source-gate.mjs`（页面请求闸、同步文件预检）、`card-presence.mjs`、`audio-js.mjs`、`selfcheck.mjs`、`deploy.mjs`、`keygen.mjs`；工作进程入口 `scripts/render-host.mjs`。
独立渲染主机与渲染节点：`server/render-node/` 下 `host.mjs`（多项目连接与挑活先后）、`local-node.mjs`、`session.mjs`、`task-runner.mjs`、`pick.mjs`、`filter.mjs`、`split.mjs`、`export-plan.mjs`、`content-client.mjs`、`project-client.mjs`、`session-link.mjs` 等。
出图：`server/prerender-executor.mjs`（队列任务 → 计划与产流）、`server/frame-pipeline.mjs`、`server/frame-stream.mjs`、`server/vision/`（看画面的那几条接口）、`server/bakery/`（导出取帧）。
调用方：`server/agent-service/look-client.mjs`、`server/agent/service/frame-dispatcher.mjs`、`account-runner.mjs`。

### 逐文件

新加：

| 文件 | 内容 |
|---|---|
| `server/render-node/multi-queue.mjs` | 多项目模式的出队次序（纯逻辑）：看画面先于产流；同一类里最久没轮到的项目先、出一个就排到最后；同一项目内按来的先后。`orderByPolicy`、`createRotation`、`createMultiQueue`。三处共用：看画面队列、隔离工作进程装哪个项目、独立渲染主机各项目认领的先后 |
| `server/render-node/expand.mjs` | 机制那一条的「展开」：`expandProject(project, { times/frames/spans, clipIds })` 拼一份只含用到的片段的项目——这些帧上挂着的片段（含挂载提前量，前后各多放一帧，取超集）、素材效果卡的节点与输入片段、转场的两段、剪辑段引用的剪辑里按段换算后同一时刻的片段（任意深度、有环就停）、用到的素材与效果库条目；项目级设置原样、序列一条不删、留下的片段原样（同一个对象）、时间位置不变。`lookNeed` / `expandLookBody`：看画面的各条接口（`see_frames`、`bake_card`、`inspect_card_dom`、`get_layout`、`get_gif`、卡片声音）要的是哪几帧、哪张卡；认不出的原样转发。不引 `src/`（独立入口的接缝规矩），挂载提前量抄一份，测试核对与舞台的相等 |
| `scripts/probes/multi-project-expand-probe.mjs` | 「两种模式出的画面相同」的逐帧证据（见下「验证」） |
| `server/test/multi-project-queue.test.mjs` | 出队次序 MPQ1～MPQ5 |
| `server/test/multi-project-expand.test.mjs` | 展开 MPE1～MPE5 |
| `server/test/multi-project-isolation.test.mjs` | 多项目模式下的隔离 MPI1～MPI3 |

改动：

| 文件 | 改了什么、为什么 |
|---|---|
| `server/hosted-render/isolation.mjs` | 状态机换成多项目模式：装哪个项目只看排队的请求谁排第一（有要隔离的看画面请求就是看画面队列里排第一的那个项目；否则是要产流的项目按「各项目轮流」，一个项目做了一个任务——认领数涨了——就轮到下一个，刚装上的先做完它这一个）；排第一的换成别的项目时**不等它空闲**：清单上标排空，手里那一个做完就结束、清空，下一拍装排第一的；没人排队时装着的留作缓存 `cacheMs`，内存吃紧（背压）时空着就结束。删掉按轮占用的全部状态与方法、心跳、五分钟让位、连续做满五分钟、真人在线优先、流产满且五分钟没修改才关。`isolationCandidates` 的 `looks` 收「按看画面队列出队次序排好的项目」，产流候选不再按成员在线排。检出副本与清目录的函数一字未动 |
| `server/hosted-render/look.mjs` | 排着的请求按多项目模式的次序做（各项目轮流、项目内先来先做），排队位次也按这个次序报；要隔离工作进程出的请求严格按这个次序——排在最前的项目没轮上之前，装着的项目的下一个请求不越过它（不然装着的项目一直有活、一直不空，排在前面的永远装不上）；轮到时按要的帧展开项目再转给工作进程（日志 `look.expanded`）；新加 `isoOrder()` 给管理进程定下一个装谁；删掉对隔离编排的按轮调用；`/look/release`、`/look/heartbeat` 只认身份后回 200 `{ ok: true, ignored: true }`（理由见下节） |
| `server/hosted-render/main.mjs` | 隔离编排用 `cacheMs`（沿用环境变量 `PROMPTCUT_RENDER_ISO_IDLE_MS`，探针与验收清单里的写法照旧能用）；删 `isoSliceMs` 与 `PROMPTCUT_RENDER_ISO_SLICE_MS`；把看画面的出队次序与背压交给隔离编排 |
| `server/render-node/host.mjs` | 独立渲染主机（以及托管方的常驻工作进程，它就是一台独立渲染主机）每一拍按「最久没轮到的项目先」推进，发出认领的项目排到最后；取消「有成员在线的项目优先」（与产品那一条「同一类里各项目轮流」冲突，见「语义」一节）。`members` 照旧记着、诊断里看得到 |
| `server/agent/service/account-runner.mjs`、`server/agent-service/account-task-worker-config.mjs`、`server/agent-service/look-client.mjs` | 去掉心跳与收尾通知的发送与转发 |
| `server/agent-service/account-master-assembly.mjs` | 任务进程发来的 `release` / `heartbeat` 照样过授权核对，回 200 什么都不做（滚动重启时旧任务进程还会发） |
| `server/agent/service/frame-dispatcher.mjs`、`server/agent/service/instance.mjs` | 两处注释里「按轮占用」「空闲满五分钟才让位」的说法改掉 |
| 测试：`server/test/hosted-render-isolation.test.mjs`（HR23 四条重写）、`hosted-render-look.test.mjs`（HR41 重写）、`hosted-render-queue.test.mjs`（RQ3 重写，RQ1、RQ4 按新次序改）、`hosted-render-service.test.mjs`（HR16「成员在线优先」改成「各项目轮流」）、`hosted-render-usercards.test.mjs`（配置项）、`cloud-see-frames-dispatch.test.mjs`（不再有心跳与收尾通知） | 原来断言的是被取代的规则 |

任务书清单之外改到的文件：`server/agent/**`、`server/agent-service/**` 那几处（为了不把心跳与收尾通知留成死代码），以及上面那几份测试。没有动 `src/online/**`、`src/editor/**`、`src/mobile/**`、`src/ai/cloud/**`、`scripts/probes/playback-probe.mjs`、任何语义文档、任何 `docs/plan/**`。

## 0.7.18 暂行办法：留什么、删什么

| 东西 | 处理 | 理由 |
|---|---|---|
| 按轮占用的状态机（占住、排队的轮、共用、FIFO 防插队、强制解锁） | 删 | 产品那一条：多项目模式「不让哪个项目占着」，0.7.19 起取代暂行办法。留着就是死代码 |
| 「空闲满五分钟才让位」「连续做满五分钟让一轮」 | 删 | 同上；别的项目一排上就不等（机制那一条：「别的项目要用时随时清掉、不等它空闲」） |
| 产流的「真人在线项目先产、两个以上五分钟轮换」「流产满且五分钟没修改才关」 | 删 | 用户 2026-10-16 第 4 节第 4 条原话：多项目模式以后不再被项目独占；改成按任务轮流 |
| 2 分钟没心跳当结束 | 删 | 没有「一轮」了，不用判它结束没有 |
| 任务进程每 30 秒发心跳、收尾 / 被叫停时发「结束了」 | 删（发送方与转发链） | 收的一方什么都不做了，再发就是死代码。被叫停时排着的看画面请求本来就由 `look-client` 按 `signal` 撤回（`/look/cancel`），不靠「结束了」 |
| 渲染服务的 `/look/release`、`/look/heartbeat` 两条路由 | 留，改成认身份后回 200、什么都不做 | 节点上滚动部署时，Agent 服务与渲染服务分开重启，可能有一段时间是 0.7.18 的 Agent 服务对着 0.7.19 的渲染服务；删了它会收到 404（虽然它吞掉错误，但日志里会记失败）。节点上不再有 0.7.18 的 Agent 服务之后可以删，代码注释里写了 |
| 主服务收任务进程的 `release` / `heartbeat` | 留，改成过授权核对后回 200、不转发 | 同一个理由：主服务与任务进程换代不同时 |
| 反过来：0.7.19 的 Agent 服务对着 0.7.18 的渲染服务 | 不发心跳了，旧渲染服务会在 2 分钟后按超时放开这一轮 | 降级而不坏：最多多占 2 分钟。部署顺序先渲染服务后 Agent 服务就没有这一段 |
| 看画面的「排队不计时、渲染一次最多三分钟、超时回调试信息、一次不重试、队列 10 分钟不动回排队异常」 | 留 | 用户 2026-10-16 第 3.4 节定的，不属于「按轮占用」，多项目模式下照样成立 |
| 隔离工作进程本身（只装一个项目、自己的数据目录与端口、口令每轮现生成、换项目前清空） | 留 | 这就是机制那一条第四条「每个请求在只属于它那个项目的隔离环境里执行」的做法；换了的是「什么时候换」 |

## 验证

__VERIFY__

## 语义里说不通或缺的地方（交给主会话）

__SEMANTICS__

## 要定的三级数字（交给主会话）

__NUMBERS__

## 没做成的及原因

__NOTDONE__
