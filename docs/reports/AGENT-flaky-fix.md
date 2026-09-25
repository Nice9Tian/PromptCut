# AGENT-flaky-fix：全量测试偶发失败排障

- 角色：flaky-fix
- 分支：`claude/flaky-fix`（从 `claude/rq-m5b` 的 415284a 分出）
- worktree：`.worktrees/flaky-fix`

## 状态

主因（坏端口）和 artifact-push 的竞态已修；验收 `npm test` 连跑 20 次 0 失败。另有两类各只出现过 1 次的残留，原因没有定论，见文末。

## 结论（先看这里）

偶发失败有两类根因，主会话怀疑的 4 条里只有第 3 条（紧的墙钟阈值）沾边，而且只占一处：

1. **fetch 的「坏端口」（主因，占了绝大多数偶发失败）。** Node 的 `fetch` 和内置 `WebSocket`（都是 undici）按 WHATWG fetch 规范拒绝连
   1719、1720、1723、2049、3659、4045、4190、5060、5061、6000、6566、6665～6669、6679、6697、10080 这些端口，
   报 `TypeError: fetch failed`（cause `bad port`），WebSocket 直接 error / 1006，连都不连。
   测试里的服务几乎都 `listen(0)`。缺省的临时端口段（49152～65535）碰不到这份名单，但**本机的临时端口段被改到了低段，覆盖了整份名单**
   （具体数值是本机信息，不写进仓库，见给主会话的回复）；而且 Windows 是**全机一个计数器顺序发号**，
   并行的几十个测试进程一起往前走，一次全量大约走过三千多个号。走到坏端口时恰好拿到它的那个服务就谁也连不上。
   - 这解释了「单独跑必过」「几个文件同时挂在 30 ms 左右」（6665～6669 连着 5 个号，一次挂好几个）、
     「挂的全是起真实服务器、开真实连接的测试」、以及 W1 的 3015 ms（`端点 3000 ms 内没连上：ws://127.0.0.1:1719`）。
   - 主会话提到的「写死的 4190」：仓库里没有写死 4190 的测试；4190 本身就是坏端口之一。
2. **artifact-push 测试自己的竞态（W5 为主，W4、W1 各一处）。** 见下文「根因二」。

主会话的另外几条怀疑，取证后的判断：

- **「关掉的端口被别的进程拿去」**：在本机基本不会发生 —— 顺序发号要绕一整圈（一万多个号，约一分钟）才会回到刚关掉的号。
  但这种写法在别的系统（随机发号）上确实不可靠，所以仍按任务书改成了测试自己占着、连上就 RST 的端口（`refusingPort()`）。
- **临时端口耗尽 / TIME_WAIT**：25 次全量里没有出现 `EADDRINUSE`、`ENOBUFS`、`ECONNRESET` 之类的错误，未见证据。
- **共享固定端口或临时目录**：测试里没有写死的监听端口（`8790` 只出现在登记用的字符串里，不监听）；临时目录都是 `mkdtemp`。未见证据。

## 取证数据

### 本机环境

- 逻辑核 28；Node v24.19.0。
- `netsh int ipv4 show dynamicport tcp`：临时端口段在低段（数值见回复）。
- 探针（scratch，不入库）连续 `listen(0)` 12 次：`5601 5602 … 5612`，再跑一次 `5613 … 5624` —— 全机顺序发号。
- 探针：在另一个进程里把某个号占在 127.0.0.1 和 ::1 上，本进程 `listen(0)` 到那一段时会跳过它；
  绑 `127.0.0.1`、`::1`、`0.0.0.0`、`::`、缺省、`localhost` 六种写法都跳过。
- 探针：`fetch('http://127.0.0.1:<p>/')` 对名单里 19 个 ≥ 1024 的端口全部报 `bad port`，对邻号（1718、1721、5999、6001、6664、6670、10079、10081 等）报 `ECONNREFUSED`。

### 全量连跑（修改前，`claude/rq-m5b` 原样）

命令同 `npm test`（`node --experimental-test-module-mocks --test …`），逐次串行，不叠别的负载。

| 批次 | 次数 | 失败的次数 | 失败内容 |
|---|---|---|---|
| base0 | 1 | 0 | — |
| base | 25 | 2 | 第 3 次：`docservice.test.mjs`「GET /healthz 报告服务状态」，`TypeError: fetch failed`，cause `Error: bad port`（25 ms）；第 7 次：`artifact-push` W5，等 15 s 内容库只有 2 份清单 |
| repro（先把全机端口计数器拨到 6599 再跑，使这一趟走过 6665～6697） | 1 | 1 | `artifact-push` W4，「第二段没开始推：first=0」（第一段推块时撞坏端口失败，进了假时钟上的退避） |

每次全量每条 `✔` 共 2428 条通过、1 条跳过；失败的那次是 2427 通过、1 失败。

### 单文件压力（`artifact-push.test.mjs`，24 个进程并行一轮）

| 批次 | 次数 | 失败的次数 | 失败内容 |
|---|---|---|---|
| stress（修改前） | 72 | 9 | W5 × 7（第三轮仍 `HTTP 500`）、W4 × 1（「队列文件还在」读到 null）、W3 × 1（15 s 内 0 份清单、队列无报错） |
| stress2（修改前，加了诊断） | 96 | 14 | W5 × 12（第三轮仍 `HTTP 500`，`attempts=3`，下一次退避 120 s）；W5 × 1、W1 × 1、W4 × 1 都是 `端点 3000 ms 内没连上：ws://127.0.0.1:{10080,1719,6566}` —— 三个都是坏端口 |
| stress3（修改后） | 120 | 0 | — |

## 根因一：坏端口

见「结论」第 1 条。修法：**测试期间把坏端口占住，让系统根本不发它们**，而不是在每个 `listen(0)` 的地方各自重试
（测试里有二十多处 `listen(0)`，还有被测的生产代码自己 `listen(0)`，如 `createDocService().listen(0)`，逐处改既多又漏）。

- 新增 `server/test/global-setup.mjs`：`npm test` 经 `--test-global-setup` 在测试运行器的主进程里跑它一次（早于所有测试子进程），
  把名单里 ≥ 1024 的 19 个端口在 127.0.0.1 和 ::1 上各绑一个不接连接的监听（只绑回环，不开防火墙口子），测试结束时关掉。
  绑不上的跳过（别的程序占着，系统同样不会发给测试）。占住了哪些经环境变量 `PROMPTCUT_TEST_BAD_PORTS_HELD` 传给子进程。
- `package.json` 的 `test` 脚本加 `--test-global-setup=server/test/global-setup.mjs`。**并发不变。**
- 新增 `server/test/bad-ports.test.mjs` 自检：名单与本机 fetch 的行为一致（名单内报 `bad port`、邻号不报）；
  `npm test` 下这些端口在 127.0.0.1 上 `listen` 得到 `EADDRINUSE`（单独跑本文件时这条跳过）。
- 探针：把计数器拨到 5990 附近后连续 `listen(0)` 60 次，**带**全局准备时拿到 `5991 … 5999 6001 …`（跳过 6000），
  绑 `127.0.0.1`、`0.0.0.0`、缺省三种写法都一样；**不带**时拿到了 6665～6669 等坏端口，断言失败。

注意：直接跑 `node --test …` 而不经 `npm test`（不带 `--test-global-setup`）时没有这层保护，在本机仍会偶发。
主会话的任务书里写的是裸命令，之后请用 `npm test`，或者裸命令里补上这个参数。

## 根因二：artifact-push 测试的竞态

- **W5**（最常见）：测试按「哨兵块（这一段第一帧）被 put 的次数」决定整段成败 —— 哨兵前两次 500、第三次放行。
  但 `pushResult` 一段里的块是 4 路并发 put 的，谁先到 `beforePut` 由读盘快慢决定；第三轮里别的块可能抢在哨兵前面，
  那时计数还是 2，仍判 500，这一段第三次也失败、进 120 s 退避。假时钟不再往前拨，测试等满 15 s 超时。
  诊断输出证实：`attempts: 3, delayMs: 120000, message: "HTTP 500"`。
  修法：每个块按它自己被 put 的次数判（前两次 500、第三次成功）。
- **W4**：第二段放行后测试固定睡 100 ms 就读 `push-queue.json`。契约里 `stop()` 不等在推的段，那一段放行后失败、会再写一次队列文件；
  满载时这次写正好和测试的读撞上（Windows 上改名替换的瞬间读会失败），`readQueueFile` 把任何错误都当成「没有文件」，回 null。
  修法：等队列 `inflight` 归零、再 `stop()` 一次（等排着的写回全部完成）再读；`readQueueFile` 遇到 EPERM / EBUSY / EACCES 稍等重读，只有 ENOENT 才回 null。
  这也避免了随后建 q2 时 `restore` 和 q1 的写回撞上。
- **W1**（「素材服务卡住时 commitSnapshots 照常很快返回」）：断言 `commitSnapshots < 2000 ms` 是墙钟阈值，满载时写 60 帧本身偶尔就要两三秒。
  推送卡在 gate 上、测试放行之前永远不会完成，所以只要 commitSnapshots 在放行前返回就证明它不等推送。
  修法：改为与 20 s 的兜底计时赛跑，并断言返回时一个块都还没推成。
- 另外：等待超时的报错里带上各队列的 `stats`、`lastError` 和最近 3 条重试日志 —— 之前 W4/W5 超时只看得到「清单只有 2 份」，看不出原因。
- **W3** 在 stress 里出现过 1 次（15 s 内 0 份清单、队列无报错），加了诊断之后的 216 次单文件压力、以及之后的全量连跑里都没再出现，原因没有定论。
  它和 W4 那次「first=0」一样都发生在修坏端口之前，可能也是撞了坏端口（素材服务的 fetch 连不上时，客户端重试完才会记 `push.retry`），但没有证据，只记在这里。

## 修改清单

| 提交 | 文件 | 内容 |
|---|---|---|
| d4294b8 | `package.json`、`server/test/global-setup.mjs`（新）、`server/test/bad-ports.test.mjs`（新） | 全量测试期间占住坏端口；自检 |
| fea313a | `server/test/artifact-push.test.mjs` | W5 按块计次；W4 等收尾和写回、读文件遇锁重读；W1 去掉 2000 ms 阈值；等待超时带队列诊断 |
| 5e6881f | `server/test/fake-ws-kit.mjs`、`server/test/render-node-ws.test.mjs`、`server/test/prerender-proxy.test.mjs` | `closedPort()` 换成 `refusingPort()`（测试自己占着、连上就 RST），T6 与 prerender-proxy 的「连不上」地址改用它 |

**生产代码没有改。**

## 生产代码里发现的同类问题（没改，请主会话决定）

- `server/vite-plugin-prerender.ts` 的 `freePort()` 用 `listen(0)` 挑预渲染进程的端口。在临时端口段落在低段的机器上（本机就是），
  它可能拿到坏端口：编辑器进程里的 fetch 连不上它，浏览器（舞台 iframe、页面）也会报 `ERR_UNSAFE_PORT`。
  `scripts/headless.mjs` 的 `freePort` 和 `scripts/lib/dev-server.mjs` 的 `pickPort` 已经知道这件事（从 20000 以上挑）；
  建议 `vite-plugin-prerender.ts` 照做，或者拿到坏端口就重挑。这是产品 bug，不影响测试，不在本任务范围内。

## 其它风险（没出现，没改）

- `media-hash.test.mjs`「导入期间别的请求最慢 < 100 ms」、`docservice-backpressure.test.mjs` I3「p95 < 50 ms」是满载下的墙钟延迟断言，
  本次所有连跑里都没失败过。主会话列的 I3 零星失败，更可能也是坏端口（它开 200 条真 WebSocket 连同一个 `listen(0)` 的服务）。

## 修改后的全量连跑

命令：`npm test`（已含 `--test-global-setup`），逐次串行，两次之间不跑别的负载。每次 2431 条：2430 通过、1 跳过（多出的 2 条是 `bad-ports.test.mjs`）。

| 批次 | 次数 | 失败的次数 | 说明 |
|---|---|---|---|
| fix1 | 20 | 1 | 每次开跑前先把全机端口计数器拨到某个坏端口簇下方（1700、4150、5990、6550、10050、3640、4020、5040、6640、2030 轮换），专门让每一趟都走过坏端口。坏端口类 0 次。唯一一次失败是新的一类：第 11 次 `frame-memory.test.mjs`「cold stage … under a 192 MiB heap」，子进程里 `HTML frame cache 5 is missing or unreadable` |
| dbg1 | 25 | 0 | `frame-archive.mjs` 里临时加了日志（只记录，不改行为；已还原，未提交） |
| dbg2 | 20 | 1 | 同上的临时日志。唯一一次失败又是新的一类：第 17 次 `asset-store-http.test.mjs` H1，`fetch failed`，cause `connect ETIMEDOUT 127.0.0.1:2901`（服务一直在监听，之前几步都连得上） |
| **acc1（验收）** | **20** | **0** | 纯 `npm test`，不拨计数器、不加日志，**20 次全绿** |

- 类型检查：`npx tsc -b --force` 退出码 0，输出 0 行。
- 修改后合计 85 次全量：坏端口类、artifact-push 竞态类都是 0 次；另有 2 次是下面两类残留，各 1 次。

## 残留（各只出现 1 次，没修，请主会话决定）

1. **`frame-memory.test.mjs`「cold stage and newly discovered controls …」，约 1/85。**
   子进程（`--max-old-space-size=192`）第一次 `save` 时，已经溢写到磁盘的第 5 帧读不回来。
   `server/frame-archive.mjs` 的 `LazyFrameStore.readSpill` 遇到**任何**读错误（含 EBUSY / EPERM 这种暂时性的、以及内存不够时解压抛的错）
   都当成「文件坏了」、把文件删掉、回 undefined，于是 `pendingValue` 抛 `missing or unreadable`。
   单文件 60 次并行压力复现不出来；全量 45 次加了日志（把非 ENOENT 的读错误和写失败记到文件）也没再出现，所以**没拿到错误码，原因没有定论**。
   代码上的风险是确定的：一次暂时性读错误会变成永久丢帧（要重新预渲染）。建议（产品代码，未改）：`readSpill` 对 EBUSY / EPERM / EACCES 稍等重试、
   只在 ENOENT 或解压校验失败时才判坏，且不要在暂时性错误时删文件。
2. **`asset-store-http.test.mjs` H1，`connect ETIMEDOUT 127.0.0.1:<port>`，约 1/85。**
   目标服务在监听，H1 整条只用了 1.76 s（平时 1.3～1.8 s），说明这次连接是**立刻**报 ETIMEDOUT，不是等超时。
   查过的方向：服务端 TIME_WAIT 与新连接同一四元组（探针：服务端先关、同端口重开、用同一源端口连 20 次，全部成功，排除）；
   客户端 TIME_WAIT（探针：显式绑同一源端口得 EADDRINUSE，系统不会发）；backlog 满（Windows 回 RST，应是 ECONNREFUSED）。
   都对不上，只记录现象：一次全量结束时本机回环上有约 6000 个 TIME_WAIT（`netstat`），临时端口段小，一分钟左右就绕一圈。
   没有找到测试侧不掩盖问题的修法（给全局 fetch 加连接重试会把真正的网络 bug 一起盖掉），所以没改。

## 对任务书的更正

- 任务书里的全量命令是裸的 `node --experimental-test-module-mocks --test …`。改完之后请用 `npm test`，或在裸命令里加 `--test-global-setup=server/test/global-setup.mjs`，否则坏端口保护不生效。
- 主会话怀疑的 1、2、4 条（关掉的端口被抢、TIME_WAIT / 临时端口耗尽、共享固定端口或临时目录）都不是这批失败的主因；第 3 条（紧的墙钟阈值）只坐实了 W1 一处。
- 主会话列的零星失败（render-node-ws T6/T9、docservice-backpressure I3、docservice-content N4/N6/N7、docservice-endpoints E8、asset-client L3、asset-namespaces S2c/S3/S4、project-snapshot J1/J2、docservice-project P1、prerender-proxy 那条）
  都是起真实服务、用 fetch / WebSocket 连的用例，特征（单独跑必过、30 ms 左右失败、几条同时挂）与坏端口一致。本次取证里直接看到的坏端口证据是：
  `bad port`（docservice.test.mjs）、`ws://127.0.0.1:1719`（W1）、`:6566`（W4）、`:10080`（W5）。
