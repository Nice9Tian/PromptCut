# AGENT 报告：多项目渲染节点（claude/multi-project-render）

0.7.19 的一项：渲染服务的多项目模式。每个请求只加载它那几帧用到的卡和素材，不让哪个项目占着；取代 0.7.18 的暂行办法「云端 Agent 按轮占用」。

- worktree：`.worktrees/multi-project-render`，分支 `claude/multi-project-render`，从 main `6c571a27` 切。
- 端口段：5880～5889（开发服务器 5880～5882；端到端探针 5880～5889）。
- 语义出处：`docs/semantics/product/rendering.md`「渲染服务的两种模式」（下称「产品那一条」）；`docs/semantics/mechanism/rendering.md`「多项目模式的做法」（下称「机制那一条」）。语义文档一个字没改。

## 状态

做完，等主会话审。门槛逐条：

| 门槛 | 结果 |
|---|---|
| 1 类型检查 | `npx tsc -b --force` 零错误 |
| 2 全量测试 | 最后一次 `npm test`：7453 条，7437 过，**1 失败**，15 跳过；那 1 条是本 worktree 目录名带 `render` 造成的（main 的代码放在同一处也失败），不是本分支引入。详见「验证」 |
| 3 画面相同 | 24/24 帧逐像素相同，不同的像素 0（导出取帧与看画面两条路各 12 帧） |
| 4 队列顺序 | 单测打出实际出队次序；云端排队探针端到端 13/13 过 |
| 5 隔离 | 单测 MPI1～MPI4；隔离探针端到端 49/49 过（最终代码上） |
| 6 导出像素基线 | 不变（没改出图代码；另跑了导出确定性 300 帧全同、快照重放一致 PASS） |

没做成的一项：产流任务的「只加载用到的」（卡点 1，解法表在文末），交主会话定。

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

所有命令都在本 worktree 里跑；跑 `npm test` 之前设了任务书给的两个环境变量（值不写进这里）。机器上同时有别的任务在跑，内存一直吃紧（隔离探针的日志里背压原因是「内存」，可用内存 40～110 MB）。

### 门槛 1：类型检查

`npx tsc -b --force`：退出码 0，没有输出（零错误）。

### 门槛 2：全量测试

第一次 `npm test`（满载）：tests 7452，pass 7432，**fail 5**，skipped 15。最终代码上再跑一次（机器负载降下来之后）：tests 7453，pass 7437，**fail 1**（下表第三行那一条），skipped 15，todo 0。逐个单跑复核：

| 失败的用例 | 满载 | 单跑第 1 次 | 单跑第 2 次 | 结论 |
|---|---|---|---|---|
| `server/test/user-editing.test.mjs` UE-S7、UE-S7～S10（两条） | 失败 | 11/11 过 | —— | 时序假失败 |
| `server/test/collect-plugin.test.mjs`「download:done 事件之后……」 | 失败 | 17/17 过 | —— | 时序假失败 |
| `server/test/account-v2-deploy-config.test.mjs`「v2 deploy config registers an optional service……」 | 失败 | 8/9 | 8/9 | **环境造成，不是本分支引入**：用例断言整份结果里不出现字符串 `render`，结果里有 `accountOrderModuleFile` 的绝对路径，本 worktree 的目录名 `multi-project-render` 里就有 `render`。把 main `6c571a27` 的代码导出到本 worktree 下 `out/main-copy` 原样跑，同样 8/9 |
| `server/test/media-tiers.test.mjs` T3-8「应用重启后队列恢复……」 | 失败 | 18/19 | 18/19 | **不是本分支引入**：main `6c571a27` 的代码在同一处原样跑同样 18/19（读队列文件 ENOENT，日志里素材服务 PUT ECONNRESET）。本分支没碰 `server/upload-queue.mjs`、`server/media-tiers.mjs`。最终那次全量里它又过了（时好时坏） |

开发中途另有一次几个文件并行跑时 `cloud-agent-look/page/runs/scope` 四个文件失败 4 条，单跑 47/47 过（时序假失败）。

本分支直接相关的测试单跑：`hosted-render-*.test.mjs` 全部、`multi-project-*.test.mjs`、`cloud-see-frames-dispatch.test.mjs`、`accept-018-rest-queue-account-look.test.mjs`、`cloud-agent-look.test.mjs` 合跑 140/140；`render-host*.test.mjs`、`render-node-*.test.mjs`、`hosted-render-streams.test.mjs`、`c10-host-claim.test.mjs`、`auto-render-node.test.mjs` 合跑 182/182；`accept-018-rest-ssr-seam.test.mjs`（独立入口不许引 `src/`）过。

### 门槛 3：两种模式出的画面相同（逐帧）

探针 `scripts/probes/multi-project-expand-probe.mjs`，开发服务器开在 5880：

```
node scripts/probes/multi-project-expand-probe.mjs --url http://127.0.0.1:5880 --out out/mpe-run3
→ 退出码 0；{"ok":true,"requests":7,"frames":24,"identical":24,"diffPixels":0}
```

测试项目 640×360、30 fps、12 秒，13 个片段：推帧卡（odometer、mu-number-ticker）、毛玻璃这类依赖下层的卡（blur-text，下层是视频）、画布卡（particles）、remotion 式卡（lottie）、两段视频交叉溶解、图片素材、一个剪辑段（引用停放的剪辑，从它的第 1 秒起，里面两张卡 ring-metric、checklist）、一条隐藏序列。7 个请求共 12 帧，挑在挂载边界（1.0 s 前一帧与当帧、8.2 s 推帧卡刚挂上）、交叉溶解重叠段、剪辑段里两张卡重叠处、最后一帧。

每个请求渲两遍：整份项目一遍（单项目模式），按这个请求要的帧展开后一遍（多项目模式）；两条出图路各比一次：

- 导出取帧（`exportUnified`）：12 帧，不同的像素 0；
- 看画面那一路（工作进程的 `renderFrames` 用的 `FramePipeline#see_frames`）：12 帧，不同的像素 0；
- 合计 **24/24 帧逐像素相同（RGBA 逐字节），不同的像素数 0**。

展开后片段从 13 个降到 2～7 个，例如「交叉溶解重叠段」只剩 4 个（blur-text、两段视频、隐藏序列上横跨全片的那张），「末尾」只剩 2 个、素材 0 个。看过的图（拷到了 `docs/archive/agent-reports/assets/multi-project-render/`）：`expand-r4-multi-000138.png`（毛玻璃卡 + 画布卡叠在视频上）、`expand-r6-multi-000255.png`（剪辑段里的 ring-metric 盖在图片上）、`expand-r2-single-000045.png`（毛玻璃卡 + odometer），画面内容正常，不是两遍都空白。第一次跑时序列次序放反了（视频盖住了卡），也是 0 差异，但证据弱，所以调了次序重跑。

另按 `verification.md` 跑了渲染附加项（本分支没有改出图管线，只改了交给它的项目内容；跑一遍为稳）：

- `scripts/verify-unified-frames.mjs`（PC_FRAME_TEST_URL 指 5880）：PASS，退出码 0；
- `scripts/verify-determinism.mjs --url "http://127.0.0.1:5880/?export=1" --frames 0-299`：300 帧全部相同，退出码 0。

导出像素基线：本分支没有改导出、舞台、卡片的画面代码，像素基线不变，不涉及重定基线。

### 门槛 4：队列顺序

单测把实际出队次序打出来：

| 用例 | 场景 | 实际出队次序 |
|---|---|---|
| MPQ1（`multi-project-queue.test.mjs`） | 先来的产流请求、后来的看画面请求 | `look:C → look:A → stream:A → stream:B → stream:A` |
| MPQ2 | A 一口气来 4 个、B 2 个、C 1 个 | `A1 → B1 → C1 → A2 → B2 → A3 → A4` |
| MPQ2b | A 正在一个个出，B 中途来了 | `A1 → B1 → A2 → A3` |
| MPQ4 | 排在前面的 B 此刻做不了 | 先出 `A1 → C1`，B 能做了以后它最久没轮到、排第一 |
| RQ3（`hosted-render-queue.test.mjs`，真的看画面队列） | 甲 3 个、乙 2 个、丙 1 个依次登记 | 转给工作进程的次序 `a1 → b1 → c1 → a2 → b2 → a3`；排队位次 `[0,3,5,1,4,2]` |
| HR23（`hosted-render-isolation.test.mjs`，隔离工作进程） | 三个项目都有很多产流任务 | 依次装 `pA → pB → pC → pA → pB → pC`（每个做了一个任务就换） |
| HR16（`hosted-render-service.test.mjs`，独立渲染主机，真队列） | 按 a1、b1、a2、c1、b2、a3 的先后发布，并发 1 | 认领、做完的次序 `a1 → b1 → c1 → a2 → b2 → a3` |
| MPI1（`multi-project-isolation.test.mjs`，看画面队列 + 隔离编排接在一起） | 甲 3 个、乙 2 个带用户卡 | 出图 `a1 → b1 → a2 → b2 → a3`，隔离工作进程依次装 甲、乙、甲、乙、甲 |

端到端（真进程）：云端排队探针 `scripts/probes/hosted-render-queue-probe.mjs`（本分支改成按多项目模式验）在本机隔离的托管组合 + 真的渲染服务上跑（`--base-port 5880 --doc-port 5888 --asset-port 5889 --time-scale 3`，缓存时长用生产的 5 分钟）：**13/13 过，退出码 0**。三个都带用户卡的项目甲、乙、丙，卡把舞台涂成各自的颜色：
  - Q3a：甲出完图空着，丙发了产流计划，15.8～30.1 秒内换装丙（不等五分钟），甲那一轮结束原因 `rotated`；
  - 丙在产流时甲、乙依次登记 甲-2、甲-3、乙-1、乙-2（另一条乙登记后撤回）：实际出图次序 **乙-1 → 甲-2 → 乙-2 → 甲-3**（Q1），这一段里隔离工作进程依次装 乙、甲、乙、甲，结束原因全是 `rotated`、没有一次是空闲满时长（Q3），丙做完手里那一个就让、四帧出完之前没再装丙（Q2），每一帧的颜色都是自己项目的、都由隔离工作进程出（Q4），任何一拍都没有同时装两个项目、撤回的不留（Q1b）；
  - Q5a～Q5c：请求排着时强杀管理进程整棵树 → 盘上留着；再起时内存吃紧 → 因背压排着、不新起；正常再起 → 先为它（看画面）起来、出图、颜色对；
  - Q6：丙的计划让过了四帧和两次重启，看画面的都出完后 16.8 秒为丙起来把它做完；Q7：一次不重试、到时限回「渲染超时」；Q8：进程与端口都收干净。
  - 这支探针跑了三次：第一次 Q1 不过——探针并发发出四个请求，渲染服务收到的先后与发出的先后不同（服务端照收到的先后做是对的），改成一个一个登记；第二次暴露了两个真问题并修掉（见下「跑探针时修掉的两个问题」）；第三次全过。


### 门槛 5：隔离

单测 `server/test/multi-project-isolation.test.mjs`（连跑 6 次都过）：

- MPI1：两个带用户卡的项目交错要画面，每个请求转出去的那一刻，隔离工作进程装着的就是它自己的项目、带的是那一轮的口令；每次装下一个项目之前，上一轮已经 stop → cleanup（清空）；五个请求用了五个不同的口令。起停记录：`prepare:a start:a stop:rotated cleanup:a prepare:b start:b stop:rotated cleanup:b prepare:a …`；
- MPI2：隔离工作进程这一轮的口令只要得到它那个项目的票据，要别的项目的 403；换了一轮，旧口令 401；
- MPI3：展开后的项目只带本项目素材表里、被用到的素材条目；
- MPI4：排空中工作进程自己退出算换装；同一项目出过图的一轮没了，不算后面排着的请求「起不来」（见下「跑探针时修掉的两个问题」）。

端到端探针 `scripts/probes/hosted-render-isolation-probe.mjs --base-port 5880 --doc-port 5888 --asset-port 5889 --time-scale 3`（本机隔离的托管组合 + 真的渲染服务、真 Chrome、「越权探测卡」夹具）：**49/49 过，退出码 0**。与本项直接相关的几条：

- H：甲的结果里没有乙的内容、乙的卡片源码；乙的结果里没有甲的记号卡；乙那一轮开始之前的全部输出里没有乙的内容与卡片源码；
- I：换项目之前甲那一轮结束并清空（`reason: rotated, cleaned: true`），两轮之间数据目录是空的；每一轮各是一个新进程、结束后进程树不剩；乙那一轮的改动层里只有乙的卡；乙的页面里没有甲的卡片代码；
- L2：看画面这一路的渲染页取不到别的项目（乙）的卡片文件；
- A3：对照——探测卡读自己项目的素材是通的（不是探针瞎了）。

素材：探针的「残余面」第 1 条照旧如实记录——同一台素材服务上，成员凭自己项目的票据按哈希读得到别的项目的块（`memberCanReadOtherProjectBlobByHash: true`），这是 `auth-contract.md` 第 8 节的既有裁定，探针本来就把它记成残余面、不算隔离失败；不是本分支引入的。素材服务按项目分库、拿 A 的票据读不到 B 的流与块的单测在 `server/test/asset-project-workers.test.mjs`（本分支没动，满载与单跑都过）。见下「语义」第 5 条。

这支探针一共跑了五次（端口 5880～5889）：第 1 次没起来（常驻工作进程 180 秒没交诊断被看护重起，探针等就绪 300 秒超时，退出码 2，当时机器可用内存只有几十 MB）；第 2 次加 `--time-scale 3`，49/49 过（那时还没修下面两个问题）；修完后第 3 次 48/49，不过的是 L3「绕过管理进程直接请求工作进程」——常驻与隔离工作进程恰好同时在重起、连不上（ECONNREFUSED），原因见下「Windows 上的事件循环」一段；第 4 次探针自己读状态口 5 秒超时中途退出（退出码 2）；第 5 次（最终代码、机器负载降下来之后）**49/49 过，退出码 0**，上面列的就是这一次。逐条结果与汇总 JSON 存在 `docs/archive/agent-reports/assets/multi-project-render/isolation-probe-checks.txt`、`isolation-probe-result.json`；云端排队探针的同样存在 `queue-probe-checks.txt`、`queue-probe-result.json`。

### 跑探针时修掉的两个问题

1. 排空中的隔离工作进程自己收尾退出（清单标了排空、手里的做完，工作进程退出）时，管理进程有时先看到「进程没了」，把这一轮记成意外退出（`exit`）而不是换装（`rotated`）。改成排空中退出算换装（`isolation.mjs`）。
2. 多项目模式下一个项目的一轮可能先为它前面的请求出过图、之后才没了；原来的规矩把它当成「为后面排着的这个请求起的一轮没起成」，重试次数为 0 时直接回「这次没看成」。改成只有没出过图就没了（`worked` 为假）才算（`look.mjs`）。两条都补了单测 MPI4。

**Windows 上的事件循环**（本分支没改）：管理进程量内存（`limits.mjs` 的 `measureWindows`）与结束进程树（`worker.mjs` 的 `listProcesses`）都用 `spawnSync('powershell.exe', …)`，机器满载时一次能卡住事件循环好几秒；工作进程每 5 秒问一次代理口、连续 3 次问不通就自己退出，于是满载时偶尔看到常驻与隔离工作进程同时以退出码 0 退掉（隔离探针第 3 次跑的 L3 就是撞上这个）。多项目模式换装更频繁，碰上的机会更多。节点是 Linux（走 `/proc`），不受影响；本机跑探针时会受影响。建议另开一项把这两处改成异步。


## 语义里说不通或缺的地方（交给主会话）

1. **「同一类里各项目轮流」与「有成员在线的项目优先」冲突**（代码按语义改了）。`hosted-render-contract.md` 第 4 节与 0.7.18 暂行办法里都有「有真人成员在线的项目先」：独立渲染主机每一拍先推进有成员在线的项目（`host.mjs`），隔离工作进程的候选按成员在线排（`isolation.mjs`）。产品那一条只说各项目轮流，没有成员在线优先，用户 2026-10-16 第 4 节第 4 条也说这是临时的。按原则 2 以语义为准，两处都改成纯轮流，`members` 只留在诊断里。如果要留「有人在看的项目先」，需要在产品那一条里写明（二级）。

2. **「同一项目内先来先做」与「稀疏版排在满密度版前面」、发布方的优先级怎么合**。产品那一条说同一项目内先来先做；同一册「重管线」又说稀疏版排在满密度版前面，发布方还给任务排名次（锚帧段 50、普通段 10，`pick.mjs`）。实现时同一项目内沿用原来的挑法（先按档与名次，同名次再按发布先后），即把「先来先做」读成「同一优先级内先来先做」。请在语义里写明这个读法，或者改。

3. **轮流按「一个请求」算，和「隔离环境」的换装成本**。机制那一条第四条要求每个请求在只属于它那个项目的隔离环境里执行，现有做法是按项目起一棵隔离工作进程（自己的数据目录、端口、Chrome，换项目前清空）。轮流按一个请求算时，两个带用户卡的项目交替要画面，每个请求都要换装一次（本机冷启动一轮几十秒，满载时更久）。语义允许（缓存「别的项目要用时随时清掉」），但吞吐会掉得很厉害。两条路，需要主会话定：
   - 三级：一轮在同一项目上最多连做 K 个请求再换（K 是三级数字）；或者开 N 个隔离槽同时装 N 个项目（受内存上限约束）；
   - 三级（大改）：隔离不按进程、按页面——同一棵工作进程里每个请求开一个只属于这个项目的浏览器上下文、卡片代码按项目分目录加载、页面请求闸按项目放行。这样换项目不用重起进程，但要动卡片同步、Vite 的模块图、页面闸，影响面大，本分支没做。
   - 「各项目轮流」的粒度（按请求还是按一小批）如果用户在意，是二级。

4. **产流任务的「展开」**（见「没做成的」卡点 1）。产品 `document-service.md`「渲染任务队列」写「多项目模式的节点取来的项目只用来展开，只加载这个任务用到的卡和素材」，机制那一条写「产流时用发布方给的片段清单和已有的成本记录」。现有代码里节点认领一个产流任务时，先按「项目@版本」把整份项目交给渲染页做一遍全项目计划（`prerender-executor.mjs` → `frame-pipeline.mjs` 的 `planForQueue`），任务能不能认、键对不对都靠这份全项目计划（`local` 档的任务要对 `entry.key`，它是整份项目的键）。语义没说多项目模式下键怎么算：只用展开后的项目算，键会和发布方算的不一样。需要先定这一条（可能牵涉任务的键与契约，属二级或接口改动）。

5. **素材「不能跨项目读」在非账号模式下没有做到**。产品 `asset-service.md` 第 19 行：持有别的项目的票据、知道哈希也读不到。机制同册第 10 行：账号模式下每个项目一个物理库，「局域网和本机项目仍用全局库」。隔离探针用的是本机托管组合里的自由模式共享项目（不是账号项目），残余面第 1 条实测：甲的成员凭甲的票据按哈希读得到乙的块，隔离工作进程里甲的页面经 `/@media/<哈希>` 也读到了。账号模式下按项目分库、读不到的单测在 `server/test/asset-project-workers.test.mjs`。产品那一条没写例外，机制那一条留了全局库：两边说不通，请定（这不在本分支范围，渲染服务这一侧拿到的票据只给本项目，已经做到）。

6. **0.7.18 的验收清单还引着旧说法**。`scripts/acceptance/v18-manifest.mjs`（`V18-queue-probe`、`V18-queue-probe-prod` 要求 `"realIdle": true`、说明里写「按轮占用」）与 `four-stage-manifest.mjs` 第 165、756 行描述的是 0.7.18 的行为；云端排队探针本分支已改成按多项目模式验。0.7.19 的验收清单请改引新的探针说明（`docs/plan` 下的清单与任务书本分支不动）。


## 要定的三级数字（交给主会话）

| 数字 | 现在用的 | 在哪 | 说明 |
|---|---|---|---|
| 没人排队时隔离工作进程装着的项目留作缓存多久 | 5 分钟 | `isolation.mjs` 的 `ISOLATION_DEFAULTS.CACHE_MS`；环境变量 `PROMPTCUT_RENDER_ISO_IDLE_MS` | 沿用原来「空闲满五分钟」的数，意思变了：只在没人排队时起作用，别的项目一排上就不等 |
| 内存吃紧时清掉空着的缓存 | 背压原因里有「内存」就清 | `main.mjs` 的 `memoryLow` | 负载高、文档服务慢不算 |
| 换项目时等手里那一个做完的上限 | 120 秒 | `ISOLATION_DEFAULTS.DRAIN_MS`（原有） | 到点让掉认领结束 |
| 展开时判「挂没挂」前后多放的余量 | 一帧（1/fps） | `expand.mjs` | 取超集，多留不改画面 |
| 隔离槽数 | 1 | 隐含在 `isolation.mjs` | 见「语义」第 3 条 |
| 一轮在同一项目上连做几个请求再换 | 1 | `isolation.mjs`（产流按认领数）、`look.mjs`（看画面按请求） | 见「语义」第 3 条 |


## 没做成的及原因

### 卡点 1：产流任务只加载这个任务用到的卡和素材

尺子：多项目模式的节点认领一个产流任务时，交给渲染页的项目里还有多少与这个任务无关的片段；以及隔离工作进程装进来的用户卡是不是只有这个任务用到的。现状：看画面那一路已经展开（只交用到的片段与素材）；产流那一路仍是整份项目（计划阶段整份装进渲染页；产流阶段别的片段作为隐藏的源序列留着），隔离工作进程照旧同步这个项目的全部用户卡。

| # | 轮 | 层 | 父 | 候选 | 改善机制 | g | h | f | 验证 | 状态 | 结果 / 学到 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 三级 | — | 产流那一趟（`frame-stream.mjs` 的 `isolatedStreamProject` 之后）再按这一段的时间展开，去掉无关的隐藏源序列 | 渲染页少挂无关的片段与素材 | 2 | 4 | 6 | 要另做产流像素的逐帧比对 | 开放 | 只省素材与挂载，卡片代码照旧全装；计划阶段仍是整份项目，缺口大部分还在 |
| 2 | 1 | 三级 | — | 计划阶段（`planForQueue`）只用展开后的项目算清单里那几张卡的键 | 计划不再装整份项目 | 4 | 2 | 6 | 发布方与节点的键一致性测试 | 开放（要先定语义第 4 条） | `local` 档任务对的是整份项目的 `entry.key`，展开后的项目算出来对不上；`shared` 档按卡的内容键，理论上可行 |
| 3 | 1 | 三级 | 2 | 隔离工作进程的卡片同步只装请求要的卡（按源码静态解析出卡片 id 与导入闭包，`kernel/cardSourceParse.mjs` 有现成的 `parseCardSource`、`cardSourceImports`） | 页面只加载用到的用户卡 | 3 | 2 | 5 | 隔离探针 I 一类的断言 | 锁在 2 后面 | 计划阶段要全项目的卡才算得出键；2 不成立之前只装一部分卡会让计划失败 |
| 4 | 1 | 二级 | — | 按语义第 4 条改任务的键或契约（多项目模式按展开后的项目算键） | 让 2、3 成立 | — | — | — | — | 锁住 | 二级，三级没扫空之前不动 |

这一条没做完不挡后面：看画面那一路、队列次序、隔离都不依赖它。交给主会话（可以让 Gemini 出新假设，或定语义第 4 条之后再派）。

### 其它

- 节点（149.88.94.84）上的真实网络验证没跑：任务书不许碰节点。
- 开发服务器的预渲染子进程用的是系统随机分的空闲端口（`vite-plugin-prerender.ts` 的 `freePort`，所有开发服务器都这样），不在 5880～5889 段内；没有占用任何固定端口。

