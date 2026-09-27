# AGENT 报告：HT-a 测试方（`claude/ht-tests`）

HT-a 是「文档服务的会话模型 + 序号确认 + WebSocket 传输接会话层 + 本机信任开关」这一阶段（`docs/plan/Master-Execution-Plan.md` 第 7 节）。本分支只照契约 `docs/plan/http-transport-contract.md` 第 2 版（含文件头「2026-09-27 拆分」）独立写测试，没看实现分支（`claude/http-transport`、`claude/ht-client`）。HTTP 长轮询（HT-b）一条都不测。

编号说明：HT1～HT7 是契约第 11 节的验收编号；H1～H14 是本分支对实现的假设编号（集中在 `server/test/ht-kit.mjs` 文件头）。

## 1. 交付

| 文件 | 内容 |
|---|---|
| `server/test/ht-kit.mjs` | 公共件：假设 H1～H14、到位探测（跳过原因）、测试鉴权与测试模块、讲会话的测试客户端、假 WebSocket、`makeEndpoint`、托管组合子进程 |
| `server/test/ht-legacy.test.mjs` | 通用验收：旧客户端（不带会话项）行为不变，**现在就真跑** |
| `server/test/ht1-session.test.mjs` | HT1 服务端会话层（WebSocket 部分） |
| `server/test/ht2-backpressure.test.mjs` | HT2 背压接会话层（含一条现在就真跑的旧客户端对照） |
| `server/test/ht3-equivalence.test.mjs` | HT3「只走 WebSocket」与「中途断开再接续」等价 |
| `server/test/ht4-client.test.mjs` | HT4 客户端 `createDocEndpoint`（假 WebSocket 逐步驱动，加对着真服务的三条） |
| `server/test/ht5-probe.test.mjs` | HT5 本机托管组合 + 同形 nginx 路由，探针 member 自动 / 强制 ws |
| `server/test/ht6-trust.test.mjs` | HT6 本机信任开关 |
| `scripts/probes/ht7-probe.mjs` | HT7 探针：外网三项匿名拒绝，必须显式给 `--base` |
| `server/test/ht7-probe.test.mjs` | HT7 探针自身的用例（不连外网） |

## 2. 逐条用例与依赖的接口

「门」：`S` = 服务端会话层到位（`server/docservice/session.mjs` 存在，H1）；`C` = 客户端会话层到位（`server/render-node/session-link.mjs` 存在，H10）；`T` = 信任开关到位（`server/hosted/*.mjs` 里出现 `PROMPTCUT_TRUST_LOOPBACK`，H13）；`—` = 不设门，现在就跑。门没过时用 `node:test` 的 `skip` 并写明原因；门过了而接口名字或形状不对，用例报错，不跳过。

### 通用：旧客户端（第 3.6 节）

| 用例 | 门 | 核对 |
|---|---|---|
| HT-legacy-1 | — | 不带会话项握手 101、只回显 `promptcut.v1`、没有 `session.*`（等过 1.3 s）、两个方向不带 `seq/ack`，模块原样收到 |
| HT-legacy-2 | — | 旧客户端断开立即断线（保留时限相当于 0） |
| HT-legacy-3 | — | 现有 `createWsEndpoint` 照常连、收发、被关后重连 |
| HT2-legacy-compare | — | 旧客户端同样的量不被背压关（积压只算套接字） |

### HT1（门 S）

| 用例 | 核对 | 假设 |
|---|---|---|
| HT1-open | 第一条出站是 `session.welcome`，sid 43 字符 base64url，`resumed:false, ack:0, retainMs, transport:'ws'`，回显只有 `promptcut.v1`，鉴权一次，两次建会话 sid 不同 | H2～H4 |
| HT1-default-retain | 缺省 `retainMs` 60 000 | H2 |
| HT1-seq | 服务端业务消息 seq 从 1 起；回包顺带 ack；模块看不到 seq/ack；`service.send` 同样补 seq | 第 3.2、3.3 节 |
| HT1-control | `session.*` 不进核心、不回 unsupported；挂认领 `session.` / `session.ack` 的模块抛错 | 第 3.2 节 |
| HT1-ack-batch | 没顺带机会时约 1 s 单发 `session.ack`；满 32 条 700 ms 内单发 | 第 3.3 节 |
| HT1-resume | 断后经 WebSocket 接续：不再鉴权、connId 与身份不变、模块不见断开；welcome 的 ack；先 welcome 后补发、原 seq、按序；`describe().conns[i]` 的 `resumes/transport/detached`；日志 `session.detach`、`session.resume { connId, transport, gapMs }`；`sessions.resumed` | H3、H4、H8、H9 |
| HT1-dedup | 同一传输与跨传输的重发都丢弃，新的照常进 | 第 3.3 节 |
| HT1-superseded | 半开旧连接以 4009 `superseded` 关，新的照常用，仍是一个会话 | H6 |
| HT1-resume-exclusive | 接续项加鉴权项、新会话项加接续项：握手不成功 | 第 4.1 节 |
| HT1-resume-fail | 不存在 404；主动结束后 410 | H5 |
| HT1-bad-seq、HT1-bad-ack | 跳号、越界 ack（单发或顺带）：1002 `bad-seq`，不保留，之后 410 | H6 |
| HT1-bad-resume-ack | 接续项的 ack 越界：不接续，会话结束 | 第 3.5 节的推论（第 7 节第 4 条） |
| HT1-retain | 保留期内不断线、`/healthz` 显示脱开；期满断线、`conn.timeout`、`expired`、之后 410 | H2、H7、H9 |
| HT1-close | `session.close` 立即断线、之后 410 | 第 4.2 节 |
| HT1-server-close-4003 / 4004 / closeConn / 1001 | 服务端主动关立即结束、不保留；关停时脱开的会话同样结束 | 第 4.2 节 |
| HT1-heartbeat | 一轮 ping 没等到 pong：只脱开、之后能接续 | 第 5 节 |
| HT1-healthz | `sessions` 形状与计数、list 五个键、`describe()` 四个新字段；sid 不进 `/healthz`、`describe()`、日志 | H7、H8 |
| HT1-no-sid-in-logs | 接续、过期全程 sid 不进日志；`conn.open`、`conn.timeout` 带 `transport` | H9 |

### HT2（门 S）

| 用例 | 核对 |
|---|---|
| HT2-no-ack | 客户端读而不确认，未确认字节超上限 → 1013 `backpressure`、不保留、`backpressureCloses` 1 |
| HT2-ack-releases | 按时确认：同量不触发背压 |
| HT2-detached | 脱开期间服务端继续写，超上限 → 1013，不等保留期满，之后 410 |
| HT2-coalesce | 未确认字节过高水位后同键消息只留最后一条；确认推进后写出，seq 在写出时编 |

### HT3（门 S 与 C）

HT3-ws-vs-resume：同一段业务脚本跑两遍（传输不断 / 每步前后 `cutAll()` 让会话接续），客户端是 `createDocEndpoint`，服务端挂真的 project、content 模块与 render-queue（节点用 `pc` 档）。覆盖队列的认领、完成（`task.done` 到发布方，`task.taken`、`task.closed` 到旁观节点）、断线放回（传输断不放回，会话结束才放回）；项目提交与 stale；内容库 put 与 watch。两遍记录逐项 `deepEqual`，并核对第二遍确实接续过（端点 `resumes`、`sessions.resumed`），上层看不到 `seq/ack`、没有 error。

### HT4（门 C；`HT4-real-*` 门 S 与 C）

| 用例 | 核对 |
|---|---|
| HT4-first | 先试 WebSocket；`http(s)` 换 `ws(s)`；列表 = `protocols()` 现取 + `promptcut.session.new`；收到 welcome 才 `onOpen` |
| HT4-seq | 出站 seq 从 1、顺带 ack；入站摘掉 seq/ack、重发丢弃、`session.*` 不交上层 |
| HT4-ack-timer | 1 s 内单发 `session.ack` |
| HT4-resume | 接续项带已收全的 ack、不带鉴权项、不调 `protocols()`；调 `onResume` 不调 `onOpen`；脱开期间的 send 按序补发（只补 welcome.ack 之后的）；ack 释放 `pendingBytes` |
| HT4-error-only | 握手只有 error 没有 close（2026-09-27 云端实测）：照样重试；接续握手同样 |
| HT4-ws-first-every-time | 每次重连都从 WebSocket 开始（`fetch` 一律失败） |
| HT4-forced-ws | `PROMPTCUT_TRANSPORT=ws` 或选项 `transport:'ws'`：`fetch` 一次都不调 |
| HT4-server-end-4003 / 4004 / 1013 / 1001 / 1002 | `onClose {code}`、不接续、建新会话；结束后 send 丢弃计数；旧会话的未确认不进新会话；新会话 seq 从 1 |
| HT4-bad-seq、HT4-bad-ack | 客户端结束会话（1002）并重建 |
| HT4-pending-cap | 未确认出站超 1 MiB → `onClose {code:1013}` |
| HT4-retain-expiry | 接续握不上超过 `welcome.retainMs` → `onClose`、重新取凭证建新会话（H11） |
| HT4-close | `close()` 先发 `session.close`；不再重连；之后 send 丢弃 |
| HT4-stats | `stats()` 的 `transport/fallbacks/resumes/pendingBytes/dropped` |
| HT4-index | `render-node/index.mjs` 同名再导出 |
| HT4-real-resume | 真服务、TCP 代理掐断：自动接续，两边断开期间发的都按序到、各一次 |
| HT4-real-410 | 服务端保留期满（410）后客户端重建会话 |
| HT4-real-404 | 换了一个服务端（404）后客户端重建会话 |

### HT5（门 S、C、T）

HT5-auto、HT5-ws：`main.mjs` 子进程（只绑 127.0.0.1、端口 0、`PROMPTCUT_TRUST_LOOPBACK=0` 加令牌），测试里起一个前缀反向代理当同形 nginx（`/hosted/*` → 文档服务，`/media/*` → 素材服务，HTTP 与升级都转），素材公网地址登记成 `<代理>/media/api/asset`；协调口在进程内起（端口 0）；creator、member 各一个探针子进程。核对 member 退出码 0、`ok:true`、完成至少 1 个任务、`loopbackTrusted:false`，creator 同样通过；强制 ws 那条输出里没有 `session.fallback`（H14）。

### HT6（门 T）

| 用例 | 核对 |
|---|---|
| HT6-off | `=0`：回环不带凭证握手 401、本机声明 401、不带票据读素材 401、不带 / 带错令牌调管理接口 401、带对令牌 200 |
| HT6-on `=1`、缺省 | 回环握手 101、读素材不要票据（404）、管理接口 200 |
| HT6-old-name | 旧名 `PROMPTCUT_TEST_NO_LOOPBACK_TRUST=1` 不再生效 |
| HT6-no-token | `=0` 无令牌拒绝启动，`config.error cluster-token-required`、退出码 1 |

### HT7

- `node scripts/probes/ht7-probe.mjs --base <文档服务基址> [--asset <url>] [--admin <url>] [--timeout-ms 15000]`：五项（匿名升级 401、随机令牌升级 401、匿名读素材 401、管理接口无令牌 / 随机令牌被拒 401 或 403）。缺省不连任何地址，不给 `--base` 退出码 2；`--asset` 缺省按阿里云同形 `<origin>/media/api/asset`，`--admin` 缺省是它去掉 `/api/asset`。最后一行一行 JSON；全过 0、有不过 1、全连不上 2。退出不用 `process.exit`（Windows 上套接字未关完时强退会以 0xC0000409 崩掉，自检时遇到过）。
- 用例：HT7-probe-no-base（—）、HT7-probe-local（T，`=0` 全过、退出码 0）、HT7-probe-discriminates（T，`=1` 时退出码 1）。
- 阿里云上由主会话在部署后跑：`node scripts/probes/ht7-probe.mjs --base https://8-219-80-16.sslip.io/hosted`。

## 3. 用例条数与跳过数

新增用例 **63** 条：

| 文件 | 条数 | 本分支（实现未到位）真跑 / 跳过 |
|---|---|---|
| ht-legacy | 3 | 3 / 0 |
| ht1-session | 22 | 0 / 22 |
| ht2-backpressure | 5 | 1 / 4 |
| ht3-equivalence | 1 | 0 / 1 |
| ht4-client | 22 | 0 / 22 |
| ht5-probe | 2 | 0 / 2 |
| ht6-trust | 5 | 0 / 5 |
| ht7-probe | 3 | 1 / 2 |
| 合计 | 63 | 5 / 58 |

- 集成前 `npm test` 比 main 多跳过 **58** 条，每条写明原因（哪个文件不存在，或哪个名字没出现）。
- 集成后三道门都打开，这 58 条自动转为真跑；`npm test` 应回到只跳过需要 5190 的那 1 条（`集成:/api/cards/layout 对真实项目返回整数框`）。

## 4. 假设表

详见 `server/test/ht-kit.mjs` 文件头，集成对账只改那里。

| 编号 | 假设 | 依据 |
|---|---|---|
| H1 | 服务端会话层文件 `server/docservice/session.mjs`；测试只经 `createDocService` 测，不调它的导出 | 第 2、15 节 |
| H2 | `createDocService` 新选项 `retainMs`，缺省 60 000，等于 welcome 的 `retainMs` | 第 4.2 节 |
| H3 | 会话项写法；新会话照常调 `authenticate`，接续不调 | 第 4.1 节 |
| H4 | welcome 形状，sid 43 字符 | 第 3.1、4.1 节 |
| H5 | 接续失败在握手里回 404 / 410 | 第 4.1 节 |
| H6 | 1002 `bad-seq`、4009 `superseded`、1013 `backpressure` | 第 3.1、3.5 节，H.2 |
| H7 | `/healthz.sessions` 的键与计数口径（`total` 等于 list 条数，旧客户端也计入 `ws`） | 第 8 节 |
| H8 | `describe().conns[i]` 四个新字段 | 第 8 节 |
| H9 | 日志事件名与字段，sid 不进日志 | 第 8 节 |
| H10 | `session-link.mjs` 导出 `createDocEndpoint` 的选项与返回值；`protocols()` 只回鉴权项，会话项端点自己加；另认 `transport` | 第 9 节 |
| H11 | HT-a 客户端读不到 404 / 410：脱开超过 `welcome.retainMs` 就当会话结束并重建 | 第 4.3 节注的推论（第 7 节第 1 条） |
| H12 | `close()` 先发 `session.close` | 第 4.2 节 |
| H13 | `main.mjs` 读 `PROMPTCUT_TRUST_LOOPBACK`；`=0` 无令牌打 `cluster-token-required` | 第 10 节 |
| H14 | 探针 member 认 `PROMPTCUT_TRANSPORT=ws` 与 `--transport ws` | 第 4.3 节第 6 条、第 14 节 |

## 5. 验证与参考实现自检

### 本分支的基线（参考实现已删掉之后）

- `npx tsc -b --force`：退出码 0，零错误。
- `npm test`：退出码 0；tests 3057、pass 2998、fail 0、cancelled 0、skipped 59。main `dc28209` 上是 tests 2994、pass 2993、skipped 1；多出的 63 条就是本分支的用例，多跳过的 58 条见第 3 节。

### 参考实现自检（在 worktree 里临时写，跑完用 `git checkout` 还原、删掉新文件，没有提交）

照契约写的最小参考实现：`server/docservice/session.mjs`（会话项解析、sid）；`service.mjs` 接会话层（序号与确认、1 s / 32 条确认、脱开与保留、接续与 4009 替换、墓碑 404 / 410、未确认字节当 `buffered`、`/healthz.sessions`、`describe()` 字段）；`server/render-node/session-link.mjs` 的 `createDocEndpoint`（只走 WebSocket、保留期满重建）与 `index.mjs` 再导出；`main.mjs`、`combo.mjs` 接 `PROMPTCUT_TRUST_LOOPBACK`。

- 本分支 63 条对着参考实现：**63 过、0 失败、0 跳过**（`node --test server/test/ht*.test.mjs` 共 74 条，含前缀相同的 `http-guard.test.mjs` 11 条，74 过）。HT1、HT2、HT3、HT4、legacy 连跑 3 遍，每遍 53 过、0 失败。
- 自检发现并改掉的用例本身的错（已提交）：HT2-coalesce 的前置条数没按高水位的写出规则算（`dc50cdd`）；HT3 的节点原用 `host` 档，`queue.watch all` 对 host 只回项目摘要（M6c X3），改成 `pc`（`abd7bf5`）。
- 变异检查（证明用例抓得住错）：客户端接续后不补发 → HT3、HT4-resume、HT4-real-resume 失败；服务端把重发当跳号 → HT1-dedup 失败。
- 实现未到位时的反向检查：把 HT6、HT7 的门临时打开对着 main 跑，HT6-off、old-name、no-token 与 HT7-probe-local 按预期失败（main 上回环握手仍 101、旧名仍生效、无令牌照常启动），`=1` 与缺省两条通过，说明路径与判据对得上。HT5 的同形路由与探针编排也在 main 上临时打开门跑过，自动、强制 ws 两条都过（约 16 s 一条）。
- 顺带发现（给实现方）：参考实现把信任开关接进 `createSharedDocService` 之后，现有 `sp-hosting.test.mjs` 的 SPH-SP3（`trustLoopback: false` 且不给集群令牌）失败，且该文件随后挂住：素材服务经回环向文档服务登记地址不再被当本机。契约第 10 节已规定 `0` 而没有令牌拒绝启动、登记一律带令牌，实现方要按第 15 节一并改 `sp-hosting.test.mjs`。

## 6. 未覆盖项

- HT-b 的全部：HT1 里「WebSocket 断后经 HTTP 接续」「HTTP 断后经 WebSocket 接续」、open 的鉴权（有效证明、错证明 401、随机数重用 401 且不计数、限速）、send 按帧去重与单 POST 在途、recv 的挂起 / 单 GET 替换 / `closed`；HT4 里「失败转 HTTP、沿用同一份列表」「HTTP 临时错误重试不报断开」「HTTP 回 404 / 410 重建」；HT5 强制 http；HT8。没写成跳过的占位用例，免得集成后多出永远跳过的条目。
- HT7 在阿里云上的真核对：由主会话在部署后用 `ht7-probe.mjs` 跑。
- HT9、跨机 W-HT-a：不在本分支。
- 第 10 节第 2 条「共享 HTTP 端点按非回环处理、挑战与建项目受限速」没有单独用例（HT6 验收表没列）；HT6-off 只覆盖了握手里的本机声明。
- 墓碑保留 2 分钟的上限没测（要等 2 分钟或注入选项，契约没给选项名）。
- 页面 `SyncLink` 讲会话（`src/editor/sync/`）不在本分支范围。

## 7. 对契约与主计划的更正建议

1. **HT-a 的客户端读不到 404 / 410**（第 4.1、4.3 节）：契约靠「转 HTTP、沿用同一份列表」让 HTTP 回包分辨接续失败；HT-a 不接 HTTP，浏览器与 Node 的 `WebSocket` 又读不到握手状态码。本分支按 H11 写（脱开超过 `welcome.retainMs` 就当会话结束、重建），代价是服务端重启后客户端要空等最多 60 s。建议在第 4.1 节补一条 HT-a 的做法，二选一：(a) 接续失败时服务端先接受升级，再以 4404 / 4410 关闭（关闭码浏览器读得到）；(b) 明写 H11。用例对两种都通过。
2. **主计划第 7 节 HT-a 的验收写「HT1、HT2、HT4 全过」**，但 HT1、HT4 里有 HTTP 的条目。建议像 HT3、HT5 一样写明 HT-a 只跑 WebSocket 部分，其余归 HT-b。
3. **`/healthz.sessions` 的计数口径**（第 8 节）：例子里 `total 3 = ws 1 + http 1 + detached 1`，没说旧客户端算不算进 `ws`、`opened` 算不算旧客户端。本分支按 H7。建议契约写明。
4. **接续项里的 ack 越界**（大于服务端发出过的最大 seq）没写怎么办。本分支按第 3.5 节推论：会话已坏、结束（只要求「不接续、会话结束」）。建议写明回 410 还是接受后以 1002 关。
5. **选项名**：`createDocService` 的保留时限（本分支假设 `retainMs`）与墓碑时长没有选项名；墓碑 2 分钟因此没法不等 2 分钟就测。建议定名（例如 `retainMs`、`tombstoneMs`）。
6. **WebSocket 握手里的 410「带 code、reason」**：放在回包哪里没写，客户端也读不到。建议 HT-a 删掉这半句或并入第 1 条。
7. **`onOpen` 的时机**：建议写明「收到 `session.welcome` 之后」而不是 WebSocket 的 `open`；本分支按前者测（HT4-first）。
8. **`conn.timeout` 一名两用**：现在心跳没等到 pong 打 `conn.timeout`，第 4.2 节又用它表示保留期满。建议心跳超时只打 `session.detach`（带原因），`conn.timeout` 只留给会话结束。
9. **第一次建会话之前的 `send`** 丢弃还是排队没写；本分支不测这一段。

## 8. 需要主会话决定的事

- 第 7 节第 1、2 条（HT-a 里接续失败怎么让客户端知道；主计划 HT-a 验收的措辞）。
- 集成方对账：假设 H1～H14 若与实现不一致，改 `ht-kit.mjs` 对应的那一处，不改用例的判据。
- 计时类用例（HT1-ack-batch 的「700 ms 内」「1.8 s 内」、HT4-retain-expiry 的「3.3 s 内」）给全量并行留了余量；集成后若在慢机器上偶发超时，放宽数字即可，不是行为问题。
