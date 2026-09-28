# AGENT-m7-accept-probe 报告

分支 `claude/m7-accept-probe`，起点 `claude/rq-m7-queue` `fdbeb60`（C10 集成 + M7 服务端一侧 + 契约单测），合进了 `claude/m8-kit`（`4b18d64`，m8 探针公共件）。端口段 5450～5459。

代号：M7 是「纯浏览器节点」阶段；M7-A1～A12、W7 是契约 `docs/plan/m7-contract.md` 第 10 节的验收编号（W7 = 跨机那一条）；D1～D18 是契约第 11 节的待定点、第 13 节主会话的裁定；E5 是「纯浏览器只见本人任务」，B2 是「纯浏览器只认领 light / medium 共享档快照」；L1 是云端任务书里「后台 iframe 当预渲染者」那一条（已并入 M7）。

## 做了什么

| 文件 | 内容 |
|---|---|
| `scripts/probes/m7-browser-probe.mjs` | 验收探针。角色 `creator`（用户 A：托管组合 + 三源代理 + 在线构建 + A 的桌面编辑器当 pc 节点 + 上帝视角）、`node`（成员 B：无头 Chromium 的普通档 b1、低内存档 low、退回单舞台 single，A10 另开 b2）、`all`（本机替身：协调口 + 两个角色各一个子进程）。协调口 KV 前缀 `m7ap`，键名照 `m8/kv.mjs` |
| `scripts/probes/m7-node-adapter.mjs` | 页面节点诊断的唯一适配处（契约第 7 节没定形状的读法），假设清单 `ASSUMPTIONS` |

判据的取证尽量不靠页面诊断：

- **线上消息**：node 角色用 CDP 抓每页全部 WebSocket（握手子协议、回显、收发的业务消息）。连接的角色按握手里票据负载的 `r` / `o.kind` 认，接续的连接按会话号认回；票据与会话号只留内存，不输出。
- **上帝视角**：creator 进程内起托管组合，轮询 `service.describe()`（任务状态史、认领过它的节点、锁、节点表），另有一个 pc 档旁观节点（A 的 render 连接，不带指纹、watch `'all'`）拿任务正文（`requires`、`input`、`priority`、`source.userId`）；清单、层表用 `content.get`，`snap/` `px/` 块用托管组合的 `inventory()`。
- **替身节点**（服务端一侧现在就真判）：`server/render-node/session.mjs` + `filter.mjs`（页面按 D11 要用的同一份节点代码），经 `auth.ticket { kind: 'conn', role: 'render', owner: { kind: 'browser' } }` 签的票据连文档服务，`node.hello` 带 `environment` 原始值；Chrome 主版本取 901～907，指纹与真页面、pc 都不撞。
- 页面诊断（`__pcBrowserNode()` 等）只作对照与补充。

### 每条验收的判据写法

| 编号 | 部分（`parts` 里的名字） | 判据 |
|---|---|---|
| M7-A1 | `server-B-other-user`、`server-same-name-other-device` | A（发布方 + 每种指纹一个 host 假节点）发布 10 个细任务（不带指纹的、带替身 sB / sS / 页面指纹的）并全部做完；B 的替身 sB、与 A 同名不同设备的替身 sS 在这期间收到 A 任务的 `queue.snapshot` / `task.opened` / `task.taken` / `task.closed` 0 条；旁观节点看得见这些任务（证明任务确实发出、只是被「只见本人」挡住） |
| | `page` | 页面当了节点后：b1、low、single 三页任何连接上收到 A 任务 id 的消息 0 条（CDP） |
| M7-A2 | `server-claim-other-user-forbidden` | sB 拿 A 的 open 细任务与 A 的计划任务 id 认领：一律 `task.claim-rejected { reason: 'forbidden' }`，不带 `state`、`version` |
| | `server-own-plan-plan-profile` | sB 认领 B 自己发布的清单计划：`plan-profile` |
| | `server-d9-browser-as-pc-forbidden` | 浏览器归属的 render 连接以 `pc` 报到：`error forbidden`，之后 `queue.watch` 回 `not-registered` |
| | `page-hello-profile-browser` | 页面当节点时：它的 `node.hello` 是 `profile: 'browser'`、`maxConcurrent: 1`、带 `environment` |
| M7-A3 | `server-standin-*` | 替身 sQ（work 模式）+ B 发布的本人任务：light 2、medium 2（应认领）；heavy、本地档、用户卡、图卡、改过源码的卡、非独立卡（D4）、流、plan（不应认领）；跑满 `--a3-seconds`（缺省 60 s）：禁收的认领 0 次（替身发出的 `task.claim` 与上帝视角的认领记录都数），light / medium 全部认领并完成 |
| | `server-page-*` | 页面当节点时：以页面的身份（同用户名、同设备 id → 同一 userId）发布同样几类禁收任务（页面的指纹、页面的代码版本），60 s 内页面节点认领 0 次 |
| M7-A4 | `page-anchors-done`、`page-within-30s`、`page-layer-env-browser` | 从 b1 的加载遮罩撤下起：三张重卡（`h1～h3`）的锚帧段（认领回包里 `priority: 50`）都由本页 `task.complete`，最慢一段距遮罩撤下 ≤ 30 s（计时：笔记本判）；页面内快照库 `snapshots` 表有条目；`__pcOnlineSnapshots().layers` 这三层的指纹 = 页面指纹 |
| | `server-anchors-by-browser`、`server-layer-map-points-to-browser` | 这些锚帧段任务状态 done、认领者是页面节点、内容库有清单、清单里每帧的 `snap/` 块都在素材服务；层表 `layers:<项目>` 这三层的候选里有页面指纹 |
| M7-A5 | `page-yield-on-drag`、`page-attempts-unchanged`、`page-resume-after-500ms` | 本页持有一段且在报进度时，在 `[data-pc="ruler"]` 上真鼠标连续拖 3 s：拖动期间 `task.claim` 0 条；这一段新的 `task.progress` ≤ 1；`task.release` 恰 1 次；快照库条数增加 ≤ 1；松手后 500 ms 内认领 0 条、之后恢复认领；再认领到同一段时回包的 `attempts` 为 0 |
| M7-A6 | `play-yield` | 同 A5，换成播放 3 s |
| | `hidden-release-now`、`hidden-no-claims-then-resume` | 同一窗口另开标签切过去（页面 `visibilityState` 变 hidden）：立即 `task.release`，放回之前不再报这一段的进度；隐藏期间认领 0；切回后恢复认领 |
| | `urgent-stops-at-frame-boundary` | 生成快照中加一张新卡（后台舞台要测量它，比生成快照急）：30 s 内放回，放回前至多再报 1 帧 |
| M7-A7 | `setup-single-stage` | single 页（拦掉 `runtime-config.json`）确实退回单舞台（`__pcPreviewDiag().dual === false`） |
| | `no-render-connection` | 整场 low、single 两页：render 连接 0 条、`node.hello` 0 条；对照 = b1 当了节点。对照没当节点时记 pending（判据成立但没有对照） |
| M7-A8 | `server-manifest-matches` | 页面产的每份清单过 `manifestMatches` |
| | `server-one-env-per-layer` | 每张卡已完成的细任务只有一种指纹 |
| | `server-exactly-once-done` | 旁观节点看到的每个任务的 `task.closed { state: 'done' }` 至多一次（作废的不算） |
| | `server-desktop-applied` | A 的 pc 节点诊断 `queue.stats.applied > 0`、`applyErrors === 0`（桌面经 `applyResult` 取回） |
| M7-A9 | `server-every-frame-has-px` | 页面产的清单 `small` 帧数 = `frames` 帧数，每个 `px/` 块都在素材服务 |
| | `page-low-memory-shows-small` | low 页播放中：`__pcOnlineSnapshots().tier === 'small'`，三层的指纹 = 页面指纹、`ready > 0`，舞台里这三层不显示占位 |
| M7-A10 | `page` / `server-idle-takeover` / `server-race-one-env-per-card` / `page-layer-switched` | b1 加一张新卡、认领到它的一段且报过进度后关掉 b1；creator 等锁闲置 > 33 s，重启 A 的编辑器（不设只切分开关，宿主全开），加两张新卡 w1、w2 并改一处让页面重发计划：z 卡的锁转到 pc 指纹；w1、w2 各自已完成的任务只有一种指纹；新开的 b2 上 z 层的指纹换成 pc 的 |
| M7-A11 | `echo-only-promptcut.v1`、`render-echo-only-promptcut.v1` | 三页所有 101 握手的回显都是 `promptcut.v1`；render 连接单列 |
| | `ticket-not-in-url-or-page-diag` | 页面发出的 WebSocket 地址、HTTP 地址里没有票据（按收到的票据原文与票据的样子 `v1.<负载>.<签名>` 两种比）；页面诊断（节点、预览、在线来源）里也没有 |
| | `server-logs-describe` | 托管组合的全部日志行、`describe()`、代理收到的全部地址里没有票据 |
| | `page-render-ticket-expiry` | render 连接建起 130 s 后（票据 2 分钟已过期）让页面断网 70 s（超过会话保留期 60 s，会话结束），恢复后页面重签 render 票据并收到新的 `node.welcome` |
| M7-A12 | `play-10s-longtasks-0` | b1 播放 10 s：主文档长任务 0（C10-A1 回归；现在就真判） |
| | `play-10s-claims-0` | 同一段时间 `task.claim` 0 条 |
| | `bake-longtasks-0` | 从遮罩撤下到三张卡锚帧段做完：主文档长任务 0 |
| W7 | `cross-machine`、`M7-A1`～`M7-A3`、`A4-timing-on-laptop` | 两个角色不在同一台机器上；A1～A3 的状态照抄；A4 的计时在带 `--timing-authoritative` 的 node 角色上判出 |
| D9 / D10 / D14 | 见结果 | D9：浏览器凭证以 pc / host 报到 forbidden 且不登记；别的用户（浏览器凭证、A 的桌面凭证）拿 sB 的 nodeId 报到 forbidden，sB 照常可用。D10：welcome 回的指纹 = `describeEnvironment(原始值)`；自报的指纹不作数；浏览器凭证不报原始值回 `bad-message`。D14：Firefox、Safari、iOS Chrome（CriOS）回 `not-chromium`，之后 watch 回 `not-registered` |
| D1-D2-D12 | `dual-split-*`、`supersede-*`、`layer-map-v3-*`、`idle-takeover-*` | 页面没当节点时，以页面（b1）的身份起替身 twin（它在线、watch 本项目），A 加一张新重卡 h4 → 页面测完重发清单计划 → 真的 pc 切分：h4 每段两份（pc 指纹、twin 指纹），都 `input.dual`，twin 那份带 `compositing: 'independent'` 与 `bake { start, end, count, sampling }`，两份的段与优先级一致，twin 那份的 `source.userId` 是页面的；先认领者得卡、另一份全部 `failed / superseded`、`attempts` 0；层表 v3 这一层两个候选（切分方自己的在前），层上字段 = 第一个候选，`layerRefOf(…, { alive })` 按活着的整份换；twin 认领一段后放回、闲置 > 33 s，改轻卡参数让页面重发计划 → 锁转到 pc 指纹、twin 那份全部作废 |

### 适配函数的假设清单（`scripts/probes/m7-node-adapter.mjs` 的 `ASSUMPTIONS`，集成时只改那一处）

- A-1 诊断钩子是编辑器页上的 `window.__pcBrowserNode()`，同步回可结构化克隆的对象；没有它 = 页面节点代码不在（`readNodeDiag`）。
- A-2 `state` 取 `off` / `idle` / `busy` / `baking`，另有 `reason`；`nodeId`、`envFingerprint`、`codeVersion` 平铺在顶层（`normalizeNodeDiag`）。
- A-3 持有的任务在 `held`（也认 `tasks`、`holding`），元素是 id 或带 `id` 的对象。
- A-4 计数在 `counts`（也认 `stats` 或平铺）：`claimed` `completed` `dedup` `failed` `lost` `bakeFrames` `chunksPushed` `chunksSkipped` `bytesPushed` `smallFrames`；放回按原因 `released: { yield, hidden, urgent, noSnapshot }`。
- A-5 每帧耗时分位数 `bakeMs: { p50, p95 }`；舞台被门挡住的时长单记 `pausedMs`。
- A-6 最近一次错误 `lastError`（字符串或 `{ message }`）。
- A-7 舞台侧 `window.__pcStageDiag().bake = { frames, frameMs: { p50, p95 }, pausedMs }`（`readStageBakeDiag`）。
- A-8 `task.release` 的原因字符串（契约只写明 `no-snapshot`）：让路认 `yield` `busy` `interaction` `drag` `play`，隐藏认 `hidden` `visibility`，更急的活认 `urgent` `preempt` `measure` `catch-up`（`releaseCauseOf`）；判据里「放回 1 次」不看原因。
- A-9 C10 已有的 `__pcPreviewDiag()`、`__pcOnlineSnapshots()`、`__pcPlanPublisher()` 形状不变。

探针主体里另有三处依赖页面的行为（不是诊断形状，写在这里供集成时核对）：页面拿本机 `localStorage` 的 `pc.online.device` 当设备身份（C10a，已有）；时间轴标尺是 `[data-pc="ruler"]`；A6 的「更急的活」用 `window.__pcStore.actions.addClipOnNewTrack` 加一张卡触发后台测量。

## 验证

- `npx tsc -b --force`：退出码 0，零错误。
- `npm test`：退出码 0；tests 3668、pass 3656、fail 0、cancelled 0、skipped 12、todo 0。跳过 12 = 原有 2 条 + 页面节点单测的门 10 条（与 rq-m7-queue 相同）；比 rq-m7-queue 多出的 20 条是合进来的 `m8-kit` 单测。
- 探针本机替身：见下「本机结果」（机器上十来个子智能体并行，计时项只作参考）。

## 本机结果

命令：`node scripts/probes/m7-browser-probe.mjs --role all --out <scratchpad>/m7ap/run4`（缺省参数：A3 跑满 60 s、等页面当节点 60 s；自己做在线构建）。退出码 3（没有 fail、只有 pending），用时 237 s；跑完 5450～5459 上没有监听。

结果行摘要（原样）：

```
{"ok":false,"fails":[],"exit":{"creator":3,"node":3},"ms":236969,
 "planOnly":{"pcNodeId":"prerender:DESKTOP-GS40TCK:5453","fineClaimedByPc":3,"plansClaimedByPc":3,"applied":false},
 "pageNode":{"isNode":false,"diag":{"available":false,"reason":"no-hook"}}}
M7-A1      pending  server-B-other-user=pass, server-same-name-other-device=pass, page=pending
M7-A2      pass     server-claim-other-user-forbidden=pass, server-own-plan-plan-profile=pass, server-d9-browser-as-pc-forbidden=pass
M7-A3      pending  server-standin-forbidden-claimed-0=pass, server-standin-light-medium-done=pass, server=pending, page=pending
M7-A4      pending  server=pending, page=pending
M7-A5      pending  page=pending
M7-A6      pending  page=pending
M7-A7      pending  setup-single-stage=pass, no-render-connection=pending
M7-A8      pending  server=pending, page=pending
M7-A9      pending  server=pending, page=pending
M7-A10     pending  server=pending, page=pending
M7-A11     pending  server-logs-describe=pass, page-render-ticket-expiry=pending, echo-only-promptcut.v1=pass, render-echo-only-promptcut.v1=pending, ticket-not-in-url-or-page-diag=pass
M7-A12     pending  play-10s-longtasks-0=pass, play-10s-claims-0=pending, bake-longtasks-0=pending
W7         pending  cross-machine=pending, M7-A1=pending, M7-A2=pass, M7-A3=pending, A4-timing-on-laptop=pending
D9         pass     browser-credential-as-pc-host=pass, nodeId-bound-to-userId=pass
D10        pass     welcome-fingerprint=pass, self-reported-ignored=pass, browser-without-environment=pass
D14        pass     non-chromium-refused=pass
D1-D2-D12  pass     dual-split-h4=pass, supersede-h4=pass, layer-map-v3-h4=pass, idle-takeover-h4=pass
```

pending 的原因一律是「节点未就绪（等 rq-m7-node）」（页面没有 `__pcBrowserNode`、没发过 `node.hello`），另有 W7 的「本机替身，真跨机待复核」与「计时在笔记本判」。低内存档与单舞台页 render 连接 0、`node.hello` 0，但对照（普通档）也没当节点，所以 A7 记 pending。

同一版代码的上一轮（run3）有一条 fail：`layer-map-v3-h4` 读到的层表候选是 twin 在前、pc 在后。查下来是这一轮页面发过两次清单计划，第二次切分时 h4 的锁已在 twin 上、只出了 twin 那份，切分方自己的指纹按 rq-m7-queue 的规则补在末尾——实现是对的，是探针判得太严，已改成先后只记不判（`52695e2`）。更早两轮暴露的探针自身问题（替身不带 userId、A 的假节点不分指纹、pc 忙着做细任务没空切分）都已修，见提交列表。

## 发现的缺口与对契约的更正建议

1. **D15 的「只切分、不认领细任务」开关服务端没有**：`PROMPTCUT_TEST_PLAN_ONLY` 在 `server/`、`src/`、`scripts/` 里都 grep 不到。探针照设，并在结果的 `planOnly` 里报它有没有生效（`applied: false` 即 pc 认领过细任务）。没有它，M7-A4 里 pc 会与页面抢同一张卡，页面多半一张也拿不到。页面没当节点时的 D1 检查用一个「吸收者」假节点（pc 指纹、host 档）替 pc 以空清单吃掉非双份细任务，代这个开关（只在探针里，不是生产行为）。建议：由 `claude/rq-m7-queue` 或集成时在 pc 节点（`vite-plugin-frames.ts` 的节点 `isIdle` / 过滤）上补这个测试开关。
2. **页面节点的 `node.hello` 要带 `environment`，`createNodeSession` 的 `start()` 不带**：会话发的 `node.hello` 没有 `environment` 字段；浏览器归属的连接不报原始值回 `bad-message`。替身在 `send` 里补；页面节点分支要么同样包一层，要么给 `session.mjs` 加一项。
3. **节点侧过滤规则 0 要 `node.userId`**：纯浏览器节点描述不带 `userId` 时，本人的任务也一律判 `other-user`、一个都不认领（本探针第一轮就这样：替身 0 认领）。页面节点分支组 `node` 描述时要带页面的 userId（`用户名@设备 id`）。
4. 契约第 3.3 节「页面在 `input.browser` 写意向」已被 rq-m7-queue 改成「队列按在线浏览器节点给指纹」（它的报告「出入」第 1 条）；实测证实：同一用户的在线浏览器节点在 pc 认领计划时就在，切分方就出双份（本机结果 `dual-split-h4`）。探针照实现写。
5. M7-A4 的夹具缺省用 `probe-slow-stepped`（内置、独立、每个新时刻烧 40 ms，任何机器上都判重），不是契约写的「Motion 卡」；Motion 卡（`punch-pill` 等）在快机器上会判轻、不产任务。`--a4-motion` 可换回 Motion 卡。建议契约 D15 的夹具改写成「3 张判重的独立内置卡」。
6. 低内存档页面在 A 改项目后发布了一份只含新卡 `h4` 的清单计划（`B-low`，rev 2），一直 open 没人认领（本机结果 `dual-split-h4` 的 `plans`）。它是补渲计划还是普通清单计划没细查，记在这里给页面节点 / C10a 看。

## 没做成的及原因

- M7-A3～A12 的页面部分、M7-A1 的页面部分：页面节点（`claude/rq-m7-node`）没合入，页面不当节点，探针走到「页面没当节点」那一步报 `节点未就绪（等 rq-m7-node）`（pending，不算崩）。页面当节点那条路径的代码（`pageFlows`、`pageServerSide`）写了但没跑过，集成时第一轮大概率要调。
- W7 真跨机：没连笔记本（主会话任务书限定本机替身）；`cross-machine` 记 pending。
- A11 的「票据过期后重建」用 CDP 断网 70 s 让会话结束；CDP 的离线模拟会不会断开已有的 WebSocket 没实测（页面节点不在），集成时核对，不行就改成让托管组合结束那条会话。

## 给笔记本跑计时项的命令

PC（用户 A，creator；把 `<PC-IP>` 换成 PC 的局域网地址，笔记本要能访问 5450～5452、5456）：

```
node scripts/probes/m7-browser-probe.mjs --role creator --bind 0.0.0.0 --public-host <PC-IP>
```

笔记本（成员 B，node；计时以这里为准）：

```
node scripts/probes/m7-browser-probe.mjs --role node --coord http://<PC-IP>:5456 --timing-authoritative
```

creator 的 stdout 最后一行是汇总（含 node 角色交回的各项）。站点是局域网 http 时，node 角色自动给 Chrome 加 `--unsafely-treat-insecure-origin-as-secure`（只放行这三个源），WebCrypto 等要安全上下文的接口才可用。

## 提交列表

`git log --oneline --first-parent fdbeb60..HEAD`（新到旧）：

```
52695e2 探针:层表 v3 候选的先后不判(只记 firstIsSplitter),照 rq-m7-queue 的写入规则
c4d0520 文档:AGENT-m7-accept-probe 报告正文(判据写法、适配假设、缺口、笔记本命令)
cc613b5 探针:A 的假节点按指纹分组、替身节点带 userId(节点侧规则 0)、页面没当节点时替 pc 吃掉非双份细任务(代 D15 开关)、切分诊断带计划清单
8a8b5ec 探针:m7-browser-probe 初版与页面诊断适配处 m7-node-adapter
f918648 Merge branch 'claude/m8-kit' into claude/m7-accept-probe
2b51508 文档:AGENT-m7-accept-probe 报告(开工)
(本提交) 文档:报告补本机结果与提交列表
```

## 第二段（主会话 2026-09-28 追加：诊断补渲计划、合入页面节点、外网模式、合 main）

### 诊断：低内存页的补渲计划为什么一直 open

- 那份计划是 `plan:<项目>@2#backfill:<签名>`（用户 B-low、`priority: 'backfill'`、`requires: {}`、清单 `["h4"]`）：低内存页发现 h4 判重、层表里没有它，按 c10a 第 17 节发补渲。发布本身是对的。
- 谁该认领：本项目的桌面节点（pc；语义「加入共享项目的桌面应用……可以认领本项目任何成员发布的任务」）与独立渲染主机（host；带清单的计划 host 也收，filter 规则 6）。纯浏览器不收计划（规则 6、队列 `plan-profile`）。
- 节点侧过滤：探针的 `dumpPlans` 按 pc 的节点描述对它跑 `checkClaimable`，结果 `{ ok: true }`，没有一条规则挡它。队列侧也没有拒绝记录。
- 实际没人认领的原因：pc 是 `maxConcurrent: 1`，`pick.mjs` 在还有 normal 档可认领的任务时一张 backfill 都不碰（语义「补渲排在后面」）。第一轮里 D15 的只切分开关还不存在，pc 在一件一件地做 h1～h3 的 normal 细任务，所以补渲计划一直排在后面，在探针那几分钟里始终 open。
- 复现（run6，加了替 pc 吃掉 normal 细任务的吸收者）：pc 空下来 1 秒内就认领了这份补渲计划、切出 5 个 backfill 档细任务，计划 `done`（`executor.backfill` → `node.plan-relocked` → `node.plan-split derived 5`）。合入页面节点、开关生效之后的 run10 里两份 B-low 的补渲计划也都 `done`。
- 结论：**不是产品缺陷**，是探针环境（当时没有 D15 开关、pc 单并发忙着做 normal 活）让它排在后面，行为符合「补渲排在后面」。不需要改代码。

### 合入页面节点（`claude/rq-m7-node` 9774eda）后

- 适配处 `m7-node-adapter.mjs` 的 A-4、A-5 按它报告的「诊断形状」一节改了：计数取 `counters`（`claims`、`bakedFrames`；放回的键是线上原因原文，按 `releaseCauseOf` 归类），推送取 `upload`，小尺寸取 `stage.smallFrames`，每帧耗时取 `counters.frameMs`、`stage.frameMs`、`stage.pausedMs`。
- 探针随之改的：持有中按时间判（放回后重新认领很常见）；A5 一帧按两块（原尺寸 + 小尺寸）算；A9 等三层产物到齐再从头播放取样；A11 的「票据过期后重建」改由 creator 在服务端 `closeConn(…, 1001)` 结束那条 render 会话（应用层，不动网络；原来用 CDP 断网，不可靠且不合新约束）；A10 由 creator 加 z1；计时项（A4 的 30 s、A5 的 500 ms、A12 的长任务）只在带 `--timing-authoritative` 的 node 角色上判，其余机器只记录、标「待笔记本复核」。

### 外网模式（W7：云端 Linux 节点当成员 B）

- `--site https://8-219-80-16.sslip.io`：creator 不起本机托管组合与代理，连阿里云托管组合（文档服务 `<站点>/hosted/`，素材服务 `<站点>/media/api/asset`，在线编辑器 `<站点>/editor/`，两个舞台源读 `<站点>/editor/runtime-config.json`）；协调口缺省 `<站点>/coord`（`PROBE_MAIL_TOKEN` 从环境变量取）；给了 `--site` 时 `--role` 缺省 creator。
- 外网模式没有进程内的 `describe()`：上帝视角改由 pc 档旁观节点收到的消息拼（任务状态、按被认领那份的指纹推断的锁；认领者、`attempts`、`lastError` 拿不到）；素材块用读票据 `GET <ns>/<hash>/chunks` 核 `complete`；A3 页面部分由 node 角色按线上 `task.claim` 判；托管端日志与 `describe()` 的票据泄漏、A11 的服务端结束会话记 pending（阿里云上另验）。
- node 角色：`--site` 同上；`--chrome <路径>`（或 `PUPPETEER_EXECUTABLE_PATH`）用系统的 Chromium；Linux 上自动加 `--no-sandbox --disable-dev-shm-usage`；站点是 https 不需要放行不安全源。

### 合入页面节点与 main 之后的本机结果（run12）

分支上合了 `claude/rq-m7-node`（9774eda）与 main（8f92683，含 C10 51f01c4；`vite.config.ts` 一处冲突按两边意图合：main 的 `rawEolPlugin`、`onlineCatalogPlugin` 加页面节点分支的 `tailwindcss({ optimize: false })`）。`npx tsc -b --force` 退出码 0；`npm test` 退出码 0，tests 3741、pass 3739、fail 0、skipped 2（原有两条）。

`node scripts/probes/m7-browser-probe.mjs --role all`：退出码 1，1425 s，跑完 5450～5459 上没有监听。

```
M7-A1      pass     server-B-other-user, server-same-name-other-device, page
M7-A2      pass     server-claim-other-user-forbidden, server-own-plan-plan-profile, server-d9-browser-as-pc-forbidden, page-hello-profile-browser
M7-A3      pass     server-standin-*（2）, server-page-node-registered, server-page-forbidden-claimed-0, page-forbidden-claimed-0, page-light-medium-done
M7-A4      pending  server-anchors-by-browser=pass, server-layer-map-points-to-browser=pass, page-anchors-done=pass, page-layer-env-browser=pass, page-within-30s=pending（参考值 42.8 s，PC 忙，待笔记本）
M7-A5      pending  page-yield-on-drag=pass, page-attempts-unchanged=pass, page-resume-after-500ms=pending（计时）
M7-A6      fail     play-yield=fail, hidden-release-now=pass, hidden-no-claims-then-resume=pass, urgent-stops-at-frame-boundary=pass
M7-A7      pass     setup-single-stage, no-render-connection
M7-A8      pass     server-manifest-matches, server-one-env-per-layer, server-exactly-once-done, server-desktop-applied
M7-A9      pass     server-every-frame-has-px, page-low-memory-shows-small
M7-A10     fail     server-idle-takeover=fail, server-race-one-env-per-card=pass, page-layer-switched=pass（这条判得太宽，已改）
M7-A11     pass     server-logs-describe, page-render-ticket-expiry, echo-only-promptcut.v1, render-echo-only-promptcut.v1, ticket-not-in-url-or-page-diag
M7-A12     pending  play-10s-claims-0=pass, play-10s-longtasks-0 / bake-longtasks-0=pending（计时，参考值都是 0 条）
W7         pending  cross-machine=pending（本机替身）, A1～A3=pass, A4-timing-on-laptop=pending
D9 / D10 / D14  pass
D1-D2-D12  fail     page-dual-split-supersede-layermap（判据对「页面报到前那一版只出 pc 一份」判得太严，已改）
planOnly: {"fineClaimedByPc":5,"plansClaimedByPc":4,"applied":false}
```

三条 fail 的原因：

1. **M7-A6 play-yield（页面节点的行为，两轮都复现）**：生成快照中开始播放 3 s，这 3 s 里这一段 0 帧、0 次放回；放回（`yield-play`）在暂停之后约 5.2 s 才发出（run11 同样 `releaseAfterPauseMs: 5212`）。拖动那条（A5）run12 过了、run11 同样 0 帧 0 放回，是时有时无。推测：播放、拖动时后台活的门关了，舞台把正在做的那一帧挡在门外（记进 `pausedMs`），那一帧既做不完也不放回，要等交互结束门重新打开。契约 D8 是「当前这一帧做完，随后放回」。建议页面节点分支：让路时当前帧如果被门挡住，就照隐藏那样立即放回（不等这一帧），或者门对正在做的那一帧放行到帧末。
2. **M7-A10 server-idle-takeover**：b1 拿着 z1 的一段后关掉，锁闲置超过 30 s，重启 pc（宿主全开）、再开 b2（下一个发布计划的人），等了 600 s 锁一直在页面指纹上，pc 那份没做。run11 里接手发生过（锁在 b2 打开后转到 pc），run12 没有。本机替身里 b2 与 b1 是同一台机器，指纹相同但用户不同（设备不同）：b1 留下的那几份任务按 D13 属于 b1，b2 认领不了，切分方又按「锁在浏览器指纹上、这一版的浏览器也是这个指纹」照锁出键。这是不是接手判定漏了「锁定方已离线、同指纹的是别的用户」这种情形，要队列分支看一下（`split.mjs` 的 `keyingOf` 与 `idleLockTakeover` 的调用处）。
3. **D1 判据**：h2、h3 的 pc 那份里有不带 `dual` 的，是页面报到之前（最多等 3 s）发的那一版切出来的，照契约只出 pc 一份、不参与作废；h1 的 5 份双份、全部作废、层表 v3 两个候选都对。判据已改成只对带 `dual` 的要求作废（`探针:真页面上的 D1 判据…` 那次提交）。

## 第三段：合入 M7 集成分支 claude/rq-m7 之后（2026-09-28）

- `git merge claude/rq-m7`（无冲突）；D1-D2-D12 挪到 M7-A4 之后、A10 之前判，判据改为「每张卡恰好一份被作废（先认领者是谁都行）、页面那份带 bake 与 independent、层表 v3 两个候选都在」。
- `npx tsc -b --force` 退出码 0；`npm test` 退出码 0，tests 3754、pass 3752、fail 0、skipped 2（原有两条）。
- 本机验收 run13（跑前、跑后 5450～5459 空着，跑的期间没动工作区）：退出码 creator 1 / node 3，1228 s。M7-A1、A2、A3、A6、A7、A8、A9、A10、A11 与 D9、D10、D14 全过；M7-A4、A5、A12 只剩计时部分 pending（待笔记本复核；A4 参考值 124.8 s，PC 很忙）；W7 pending（本机替身）；D1-D2-D12 一条 fail：h1 的 `allDual` 为假。原因是探针的旁观节点手里是那几份任务最早的 `task.opened` 正文，队列合并补 `dual` 后只对还 open 的重发，已作废的那几份留着旧正文；按主会话给的判据（每张卡恰好一份被作废、两个候选都在），这一轮三张卡都是 pc 那份整份作废、候选 `page`、`pc` 都在。已把 `allDual` 改成只记不判（ecd71d2），没有再跑一轮。
- `planOnly.applied: false`（pc 认领过 17 个细任务）是因为统计把 A10 那段也算了进去：A10 为了测「宿主全开」重启了不带只切分开关的 pc。
