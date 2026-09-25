# AGENT 报告：M6c 集成对账（`claude/m6c-integ`）

- worktree：`.worktrees/m6c-integ`，分支 `claude/m6c-integ`（起点 `claude/m6` @ `932c72e`：M6a、M6b、M6c-X6X7、W5 探针）
- 依次 `--no-ff` 合并 `claude/m6c-stream`、`claude/m6c-queue`、`claude/m6c-tests`；按主会话裁定核对并改实现；测试对账；基线与 G0-R。
- 没推送、没合并到别处、没装依赖、没建 junction、没跑 `npm ci`。
- 状态：除 stream-produce-probe（不带 `--group`）的 1080p 编码计时门槛外全过，见第 5、6 节。

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

```
npx tsc -b --force                                   → tsc exit 0（没有输出）
npm test（TEMP/TMP 指到 scratchpad）                  → exit 0
  ℹ tests 2653  ℹ pass 2652  ℹ fail 0  ℹ cancelled 0  ℹ skipped 1  ℹ duration_ms 19931.7347
node --experimental-test-module-mocks --test \
  server/test/m6c-contract.test.mjs server/test/m6c-executor.test.mjs server/test/m6c-integ.test.mjs \
  server/test/m6c-queue-impl.test.mjs server/test/stream-queue.test.mjs \
  server/test/render-host-contract.test.mjs server/test/render-host.test.mjs server/test/auth-*.test.mjs（10 个）
  ℹ tests 193  ℹ pass 193  ℹ fail 0  ℹ cancelled 0  ℹ skipped 0
```

本次新增的单测（都在上面的全绿里）：

```
✔ X1-local-fallback 切分方没切出流任务:releaseQueueStreams 把这一版的流交还本机自动生产,快照仍归队列;不是队列模式 / 重复调用回 0
✔ X4-6（集成裁定）preferNode 断开：独占窗口立即结束，别的 pc 马上能认领；重连也不恢复窗口
✔ MI-yield-queue:让路租约在期 / 正在让路时,queue lane 照常借到预渲染间、在跑的队列任务做完;background lane 照旧让路
✔ MI-no-isIdle:执行器只有 plan / render / forget,不再有 isIdle
```

MI-yield-queue 在改 `acquire` 之前跑是失败的：`git stash` 掉 `frame-pipeline.mjs` 的改动后，结果为 `✖ MI-yield-queue … ℹ pass 1 ℹ fail 1`；恢复改动后通过。

改过的旧测试，全部因为裁定：

| 文件 | 用例 | 改了什么 |
|---|---|---|
| `server/test/prerender-executor.test.mjs` | J 公共夹具 `executorFor` | 「执行器有 isIdle」改为「执行器不再有 isIdle」 |
| 同上 | J8 | 删去（执行器的 isIdle 作废），原处留注释指向 X5-1～X5-3 |
| `server/test/m6c-queue-impl.test.mjs` | X5-2 | 删掉与 M5b `isIdle` 对照的两行，以及不再用到的 import；门槛断言不变 |
| `server/test/m6c-contract.test.mjs` | MC-X1-filter | B 类，见第 3 节 |
| `server/test/m6c-kit.mjs`、`server/test/m6c-executor.test.mjs` | MC-X5-* | A 类胶水，见第 3 节 |

契约 F 节的 Q、N、L、W 系列没改，全过。

## 5. G0-R 与探针（原始关键行）

端口：主会话的 render-host-probe creator 正占着 5400～5402 和 5409，那不是我起的，我没碰。所以我全部用 5410～5439。dev server 与探针都把 `TEMP` / `TMP` 指到 scratchpad。

| 项 | 命令 | 结果 |
|---|---|---|
| 导出确定性 | 本 worktree 起 `vite --port 5410 --strictPort --host 127.0.0.1`；`node scripts/verify-determinism.mjs --url "http://127.0.0.1:5410/?export=1"` | exit 0；`Total Frames: 1800` `Identical: 1800` `Different: 0` `All frames are identical. Determinism verified!` |
| 快照重放一致 | `node scripts/verify-unified-frames.mjs --origin http://127.0.0.1:5410` | exit 0；`PASS: no video during B; all HTML frames; exact video seek; random replay; cache hits; cumulative C equals A; streamed video contains all 10 frames.` |
| 导出像素与 main | 临时 `git worktree add --detach .worktrees/m6c-integ-main-baseline main`（`b84fee5`），在 5416 起它的 dev server，跑同一条 verify-determinism（main 也是 `Identical: 1800` `Different: 0`）。再用 scratchpad 里的 pngjs 脚本逐帧逐像素比两边的 `out/verify-a/frames` | `{"frames":1800,"sameBytes":1800,"diffFrames":0,"diffPixels":0,"missing":0,"extra":0}`。删临时 worktree 前查过 reparse point，数量为 0；`git worktree remove --force` 退出码 0；主仓库的 `node_modules/vite/package.json` 仍在 |
| ready-index-probe | `node scripts/probes/ready-index-probe.mjs --port 5420` | exit 0；`"sameBytes": true` `"ok": true` `"fails": []` |
| stream-produce-probe `--group` | `--origin http://127.0.0.1:5410 --group` | exit 0；`"fails": []` `PASS` |
| stream-produce-probe（不带 `--group`） | `--origin http://127.0.0.1:5410` | **exit 1**，唯一一条是计时门槛，见下 |
| preview-fallback-probe | `--origin http://127.0.0.1:5410` | exit 0，`PASS`；`total: {"beats":286,"transparentBeats":0,"placeholderDelay":29,"counts":{"snapshot":181,"placeholder-delay":29,"placeholder":493,"dense":473},"taskP90":15.855}`，`pageErrors []`，`fails []` |
| preview-fallback-probe `--page-preload` | 同一台 | exit 0，`PASS`；`total: {"beats":286,"transparentBeats":0,"placeholderDelay":26,"counts":{"snapshot":170,"placeholder-delay":26,"dense":465,"placeholder":496},"taskP90":14.84}`，`pageErrors []`，`fails []` |

### stream-produce-probe 的 1080p 编码门槛：本分支与 main 同一时段对照

按指示没改门槛。同一时段对 main 跑同一条探针（5416，`b84fee5`），两边交替各跑两次：

| 顺序 | 分支 | 退出码 | 1080p 全幅 `encodeMs` | p50 | 药丸 p50 |
|---|---|---|---|---|---|
| 1 | m6c-integ（5410） | 1 | `[305,325,336]` | **325** | 99 |
| 2 | main（5416） | 0 | `[292,294,344]` | 294 | 70 |
| 3 | m6c-integ（5410） | 1 | `[300,337,341]` | **337** | 83 |
| 4 | main（5416） | 0 | `[287,294,306]` | 294 | 77 |

第 1 次的原始失败行：

```
"1080p 全幅流 15 帧分段编码 ≤ 300 ms(无别的编码器争 CPU) :: {\"clipId\":\"clip-bg\",\"rect\":{\"x\":0,\"y\":0,\"w\":1920,\"h\":1080},\"captureMsFor15\":767,\"encodeMs\":[305,325,336],\"p50\":325,\"bytes\":426118,\"alpha\":{\"mean\":0.0956,\"max\":50}}"
```

读法与判断（按回退规则，时序类问题只报告、不排查）：

- 基准在探针进程里直接调 `openStreamSegmentEncoder`（`server/bakery/ffmpeg.mjs`）。`git diff main HEAD -- server/bakery/ scripts/probes/stream-produce-probe.mjs` 为空，这段代码与 main 相同。两边编码器都是 `libx264`。
- 本分支两次都比 main 慢 30～40 ms。门槛本来就贴边，main 也只剩 6 ms 余量。
- 差别只能来自同机负载：探针跑编码基准时，被测 dev server 的预渲染进程如果在干活，会争 CPU。本分支的 5410 在这之前跑过 verify-determinism 与 verify-unified-frames，main 的 5416 是新起的。
- 不过两边进程树的累计 CPU 时间相近（5410 那棵 60.5 s，5416 那棵 51.3 s），没看出明显的后台活。
- 同一时段本机还有主会话的 render-host-probe creator（5400）在跑，两边同样受它影响。
- 建议主会话在机器空闲时，对两边新起的 dev server 各跑一次对照。若本分支仍稳定慢于 main，再查 X1 改过的 `StreamProducer`：非队列模式下它的行为应与 main 相同。

### queue-mode-probe

开流、两个队列节点：`node scripts/probes/queue-mode-probe.mjs --streams --peer --normal-port 5410 --queue-port 5413 --peer-port 5416 --docservice-port 5419 --timeout-min 15`，exit 0。末行原始 JSON：

```json
{"ok":true,"tasks":7,"done":7,"identical":true,"differentFrames":0,"identicalIgnoringStyleOrder":true,"differenceSummary":{},"streamTasks":2,"streamDone":2,"streamCompare":{"streams":2,"segments":12,"missing":0,"mismatched":0,"perStream":{"50d75787b9f3":{"segments":6,"adoptedByMain":6,"adoptedByPeer":0},"5cb9ae65ee2f":{"segments":6,"adoptedByMain":0,"adoptedByPeer":6}}},"x5":{"readyAfterMs":69683,"firstPlanClaim":null,"firstFineClaim":{"id":"snapshot:67d1fa79085b69908576aa4ca598dd44c8d8bd9d8c98447db951f114f9a55140:0-59","afterPreloadMs":1708,"preload":["html"]},"claimedWhileNotReady":4,"fineClaimedBeforeReady":true},"fails":[]}
```

同一次运行里的流任务明细（`runs.queue`）：

```json
{"streamTasks":2,"streamDone":2,"streamDoneCounts":{"main":{"stream:5cb9ae65ee2f0c64f04a638fa00ff530a5fbcdbfc282cfe725fdec86bc0e68fd:0-5":1,"stream:50d75787b9f3ae23e0c3ab3e981fafc564a4e6e69682ff4223df4858a3e9c5a1:0-5":1},"peer":{"stream:5cb9ae65ee2f0c64f04a638fa00ff530a5fbcdbfc282cfe725fdec86bc0e68fd:0-5":1,"stream:50d75787b9f3ae23e0c3ab3e981fafc564a4e6e69682ff4223df4858a3e9c5a1:0-5":1}},"streamBy":{"stream:5cb9ae65ee2f0c64f04a638fa00ff530a5fbcdbfc282cfe725fdec86bc0e68fd:0-5":"main","stream:50d75787b9f3ae23e0c3ab3e981fafc564a4e6e69682ff4223df4858a3e9c5a1:0-5":"peer"},"queueEvents":[]}
```

- 7 个细任务（5 个快照、2 个流）全部 done。
- 两个流任务一个由主节点产，一个由 peer 产；两个节点对每个流任务各收到恰好一次 `task.done`。
- 另一方经 `adoptSegments` 取用的 12 个分段逐段 sha256 一致（`missing 0`、`mismatched 0`）。
- 快照与普通模式逐字节相同。
- `firstPlanClaim: null`：这一次 plan 由 peer 认领。两台发布的是同一个 plan id，先发布那台的 `preferNode` 生效，窗口内由它认领；主节点没认领 plan，所以只记到细任务的首次认领时刻。
- X5：主节点在 preload 还在 `html` 时（开跑后 1708 ms）就认领了细任务；等 ready 期间读到的认领数是 4。

关流：`node scripts/probes/queue-mode-probe.mjs --normal-port 5410 --queue-port 5413 --docservice-port 5419 --timeout-min 15`，exit 0：

```json
{"ok":true,"tasks":5,"done":5,"identical":true,"differentFrames":0,"identicalIgnoringStyleOrder":true,"differenceSummary":{},"streamTasks":0,"streamDone":0,"streamCompare":null,"x5":{"readyAfterMs":61112,"firstPlanClaim":{"id":"plan:queue-mode-probe@1","afterPreloadMs":884,"preload":["html"]},"firstFineClaim":{"id":"snapshot:5cfc864ede7c3a160687bdde5fd1218d522523904c822f418c7ca0e149bd7ad0:60-89","afterPreloadMs":2404,"preload":["html"]},"claimedWhileNotReady":4,"fineClaimedBeforeReady":true},"fails":[]}
```

### render-host-probe 本机完整序列（X3 改了 host 订阅方式之后的回归）

编排同 `AGENT-m6-integ2.md`，端口平移到 5430 段：

- creator 5430，`--rounds "r1:host-a,host-b;r2:host-c,host-bad"`；
- r1：host-a 5433、host-b 5436；
- r2：host-c 5433（`--code-version test-code-version-mismatch --expect-claims none`）、host-bad 5436（口令错，`--expect-handshake 401 --expect-claims none`）；
- 主机退出后，check r1 与 check r2 都用 5433；
- auth-check `--config host-a.json --rate-limit`；
- 最后 `--role stop`。

state 目录是 scratchpad 的 `rhp-integ`，编排脚本是 scratchpad 的 `run-rhp.ps1`。全部角色退出码 0：`exit codes: creator 0 a 0 b 0 c 0 bad 0 chk1 0 chk2 0 auth 0`。

第一次编排漏了 `--rounds`：本机模式缺省只有 r1，host-c 和 host-bad 一直在等 `round-r2.json`。这是我编排写错了（A 类）。我用 `taskkill /T` 结束了自己起的那棵进程树（根是我的编排 powershell），补上 `--rounds` 重跑。下面是重跑的原始行：

```
== creator
{"role":"creator","port":5430,"state":"…\\scratchpad\\rhp-integ","rounds":[{"round":"r1","hosts":["host-a","host-b"],"planId":"plan:render-host-probe@1","tasks":5,"done":5,"failed":0,"doneCounts":[1,1,1,1,1],"reused":0,"pcCompleted":1,"pcDedup":0,"pcPlanClaimed":true,"preloadMs":111278},{"round":"r2","hosts":["host-c","host-bad"],"planId":"plan:render-host-probe@2","tasks":5,"done":5,"failed":0,"doneCounts":[1,1,1,1,1],"reused":2,"pcCompleted":3,"pcDedup":0,"pcPlanClaimed":true,"preloadMs":105436}],"projectId":"sp_qkehwz43bipe7onl3ho3um7ybs","pc":{"mode":"shared","nodeId":"prerender:DESKTOP-GS40TCK:5430","envFingerprint":"258acaaa7c5fe509","codeVersion":"0474af158815df96221126a494940b171b214a3f1134bc73b7b8c1760f6ae9bc"},"auth":["auth.reject {\"remote\":\"127.0.0.1\",\"reason\":\"bad-proof\"}","auth.reject {\"remote\":\"127.0.0.1\",\"reason\":\"nonce\"}","auth.reject {\"remote\":\"127.0.0.1\",\"reason\":\"bad-proof\"}","auth.reject {\"remote\":\"127.0.0.1\",\"reason\":\"nonce\"}","auth.reject {\"remote\":\"127.0.0.1\",\"reason\":\"bad-proof\"}","auth.reject {\"remote\":\"127.0.0.1\",\"reason\":\"bad-proof\"}","auth.reject {\"remote\":\"127.0.0.1\",\"reason\":\"bad-proof\"}","auth.reject {\"remote\":\"127.0.0.1\",\"reason\":\"bad-proof\"}","auth.reject {\"remote\":\"127.0.0.1\",\"reason\":\"bad-proof\"}","auth.reject {\"remote\":\"127.0.0.1\",\"reason\":\"bad-proof\"}"],"ok":true,"fails":[]}
== host-a
{"ok":true,"name":"host-a","round":"r1","port":5433,"projectId":"sp_qkehwz43bipe7onl3ho3um7ybs","claimed":2,"completed":2,"dedup":0,"seen":4,"connected":true,"opens":1,"handshake":101,"codeVersion":"0474af158815df96221126a494940b171b214a3f1134bc73b7b8c1760f6ae9bc","envFingerprint":"258acaaa7c5fe509","codeVersionOverride":false,"exitCode":0,"released":0,"failed":0,"lost":0,"connectFailed":0,"assetBase":"http://127.0.0.1:5430/api/asset","maxConcurrent":1,"profile":"host","fails":[]}
== host-b
{"ok":true,"name":"host-b","round":"r1","port":5436,"projectId":"sp_qkehwz43bipe7onl3ho3um7ybs","claimed":2,"completed":2,"dedup":0,"seen":4,"connected":true,"opens":1,"handshake":101,"codeVersion":"0474af158815df96221126a494940b171b214a3f1134bc73b7b8c1760f6ae9bc","envFingerprint":"258acaaa7c5fe509","codeVersionOverride":false,"exitCode":0,"released":0,"failed":0,"lost":0,"connectFailed":0,"assetBase":"http://127.0.0.1:5430/api/asset","maxConcurrent":1,"profile":"host","fails":[]}
== host-c
{"ok":true,"name":"host-c","round":"r2","port":5433,"projectId":"sp_qkehwz43bipe7onl3ho3um7ybs","claimed":0,"completed":0,"dedup":0,"seen":2,"connected":true,"opens":1,"handshake":101,"codeVersion":"test-code-version-mismatch","envFingerprint":"258acaaa7c5fe509","codeVersionOverride":true,"exitCode":0,"released":0,"failed":0,"lost":0,"connectFailed":0,"assetBase":"http://127.0.0.1:5430/api/asset","maxConcurrent":1,"profile":"host","fails":[]}
== host-bad
{"ok":true,"name":"host-bad","round":"r2","port":5436,"projectId":"sp_qkehwz43bipe7onl3ho3um7ybs","claimed":0,"completed":0,"dedup":0,"seen":0,"connected":false,"opens":0,"handshake":401,"codeVersion":"0474af158815df96221126a494940b171b214a3f1134bc73b7b8c1760f6ae9bc","envFingerprint":"258acaaa7c5fe509","codeVersionOverride":false,"exitCode":0,"released":0,"failed":0,"lost":0,"connectFailed":12,"assetBase":"http://127.0.0.1:5430/api/asset","maxConcurrent":1,"profile":"host","fails":[]}
== check-r1
{"role":"check","round":"r1","ok":true,"tasks":5,"done":5,"duplicateDone":0,"missingDone":0,"planDoneCount":1,"hostOk:host-a":true,"claimed:host-a":2,"hostOk:host-b":true,"claimed:host-b":2,"completedByNode":{"pc":1,"host-a":2,"host-b":2},"sumCompleted":5,"pcPlanClaimed":true,"reused":0,"compared":{"dirs":3,"singleFiles":243,"creatorFiles":243,"htmlFiles":240},"styleOrderOnly":0,"styleOrderWithDuplicateProps":0,"differentFrames":0,"differences":[],"identicalBytes":true,"identical":true,"fails":[]}
== check-r2
{"role":"check","round":"r2","ok":true,"tasks":5,"done":5,"duplicateDone":0,"missingDone":0,"planDoneCount":1,"hostOk:host-c":true,"claimed:host-c":0,"hostOk:host-bad":true,"claimed:host-bad":0,"completedByNode":{"pc":3,"host-c":0,"host-bad":0},"sumCompleted":3,"pcPlanClaimed":true,"reused":2,"compared":{"dirs":3,"singleFiles":243,"creatorFiles":243,"htmlFiles":240},"styleOrderOnly":0,"styleOrderWithDuplicateProps":0,"differentFrames":0,"differences":[],"identicalBytes":true,"identical":true,"fails":[]}
== auth-check
{"role":"auth-check","ok":true,"loopback":true,"docHost":"127.0.0.1","projectId":"sp_qkehwz43bipe7onl3ho3um7ybs","wrongPassword":401,"rightPassword":101,"ticket":true,"assetPutNoTicket":200,"assetPutWithTicket":200,"assetComplete":200,"assetNoTicket":200,"assetWithTicket":200,"assetRangeWithTicket":206,"assetRangeNoTicket":206,"assetBadTicket":200,"wrongStatuses":[401,401,401,401,401],"afterFiveWrong":101,"challengeInCooldown":"ok","fails":[]}
```

- **H1**：check r1 `duplicateDone 0`、`missingDone 0`、`identicalBytes true`；host-a `claimed 2`、host-b `claimed 2`，都大于 0；完成数 PC 1 + host-a 2 + host-b 2 = 5。X3 之后主机按摘要找到项目、照常认领，没有回归。
- **H2**：host-c（代码版本不同）`seen 2`、`claimed 0`；check r2 `identicalBytes true`。
- **H3**：host-bad `handshake 401`、`opens 0`、`connectFailed 12`、`claimed 0`。
- auth-check：来源是回环，`assetNoTicket` 等几项按设计不判（`loopback: true`）。
- 两轮的 `preloadMs` 约 105～111 s，比 integ2 的 58 s 长。同一时段主会话的 creator 也在跑，机器负载高，不影响判定。

进程：

- dev server 5410、5416 是我用 `Start-Process` 起的，用完用 `taskkill /PID <根> /T /F` 只结束了它们自己的进程树；
- 各探针自己起、自己关；
- render-host-probe 两次编排，结束的也只是我自己起的那棵进程树；
- 跑完后 5410～5439 没有监听；
- 没碰 5190～5192，也没碰 5400～5409 上主会话的进程。

## 6. 结论与遗留

**结论**：三个分支已合入。主会话的裁定逐条核对过，其中三处原来和裁定不一致，已按裁定改：X1 空档、X4 断开时结束窗口、queue lane 让路。另外删了执行器的 `isIdle`。契约与相关文档都已补注。

验证结果：

- tsc 0；全量测试 fail 0、skipped 1；相关单测 193/193；
- verify-determinism 1800/1800；verify-unified-frames PASS；导出像素与 main 0 差异；
- ready-index-probe、stream-produce-probe `--group`、preview-fallback-probe 两种模式都过；
- queue-mode-probe 开流双节点与关流两次都 exit 0；
- render-host-probe H1、H2、H3 全过。

**唯一没过的一项**：stream-produce-probe（不带 `--group`）的 1080p 编码计时门槛（300 ms）。本分支两次 p50 为 325、337 ms，同一时段 main 两次都是 294 ms。基准代码与 main 相同。按回退规则只报告、不排查，数字见第 5 节。需要主会话定：空闲时复测，还是另开排查。

**遗留**：

- **X1 空档兜底的判定时机**：只在发布方收到自己那个 plan 的 `task.done` 时判。如果这个 plan 在本进程发布之前就由别人发布并完成了（同一 `projectRev`），有两种情况：
  - 发布回包后本机已经有 `derived` 记录，会补判一次；
  - 本机从没收到过那条 `task.done`，就判不到。

  当前发布方按内容摘要递增 `projectRev`，同一版被别人先发布，只会出现在多台编辑器编辑同一项目时。
- **X1 空档兜底的粒度**：按「整个 plan 一个流任务都没有」判，没有逐条流比对。切分方也开着流、只是算出的流集合与本机不同时（比如预算不同），差出来的流不会补。两边用同一个 `planStreams`、同一组参数，正常不会不同。
- **X4 断开后的延迟**：已经收到 `preferred` 的别的会话，仍按原来的 `retryInMs` 再试，最多晚 `PLAN_PREFER_MS`（5 s）。要真正立即，需要队列在 preferNode 断开时重发 `task.opened`，会话收到后清掉搁置。这超出本次改动范围，没做。
- **X2 已知限制**：图节点间接引用的本地素材判不出，已写进契约，等图卡能力开放时补。
- **stream 报告第 5 节的其余遗留照旧**：`queueOnly` 的流 state 在独立渲染主机上不回收；独立渲染主机的流任务只有单测覆盖。
- **queue 报告第 6 节的遗留照旧**：文档服务模块转发 `queue.summary` 时不带合并键；host 发现新项目最迟要等一个扫描周期（5 s）。
- **两份子分支报告**：`AGENT-m6c-stream.md`、`AGENT-m6c-queue.md` 里留给「集成时处理」的几条（`isIdle` 清理、queue lane 让路、`transcode` 与 `streams` 的关系），已在本报告第 2 节处理。那两份报告本身没改。

**需要主会话决定**：是否合并 `claude/m6c-integ`。建议先定 stream-produce-probe 计时项怎么处理。
