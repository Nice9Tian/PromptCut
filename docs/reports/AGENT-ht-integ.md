# AGENT 报告：HT-a 集成（`claude/ht-integ`）

状态：完成，等主会话审查。合并、对账、主会话四条裁定已落实；第 3 节八项验证全部通过。

HT-a 是 `docs/plan/http-transport-contract.md` 第 2 版文件头「2026-09-27 拆分」的前一段：文档服务的会话模型、序号确认、WebSocket 传输接会话层、本机信任开关。本分支把服务端（`claude/http-transport`）、客户端（`claude/ht-client`）、测试方（`claude/ht-tests`）三条分支与 main 合到一起，按主会话的裁定对账，并做集成验证。

底：`aa9a85b`（三条 HT 分支与 C10a 集成分支的公共底）。端口段 5620～5629。下文「第 N 节」不加说明时指契约 `docs/plan/http-transport-contract.md`；H1～H14 是测试方在 `server/test/ht-kit.mjs` 顶部列的、契约没写死的假设编号；HT1～HT9 是契约第 11 节的验收编号；〔裁〕是会话里定的细节，用户合入前审。

## 1. 合并

顺序：`claude/http-transport` → `claude/ht-client` → `claude/ht-tests` → main（`19f1dec`）。

| 合并 | 冲突与处理 |
|---|---|
| `claude/http-transport` | 无冲突 |
| `claude/ht-client` | 4 处冲突：`server/vite-plugin-frames.ts` 取 ht-client（第 1 版按 `entry.transport` 选端点那一支去掉），http-transport 那边 `hostAssetClient` 把 `https:` 文档服务地址推成 `https:` 素材地址的一行是自动合并进来的，已核对仍在；`server/render-node/index.mjs` 两边导出都留，`http-transport.mjs` 的文件头注明是 HT-b 底座、HT-a 无调用方；两个探针（`shared-project-probe.mjs`、`render-queue-e2e.mjs`）取 ht-client 整份——http-transport 对这两个文件只有第 1 版的 `--transport ws|http` 改动，里面没有 `PROMPTCUT_TRUST_LOOPBACK` 的说明可保留（这条说明在 `c66-t9-probe.mjs` 文件头，自动合并保留）。`server/auth/shared-config.mjs` 自动合并后仍带第 1 版的 `transport` 字段与规整，改取 ht-client 的版本（字段与规整删掉；它的测试 `render-node-http-transport.test.mjs` 已随 http-transport 删掉） |
| `claude/ht-tests` | 无冲突 |
| main | 无冲突 |

注意：`claude/c10a-integ` 在 http-transport 合它之后又有 3 个提交（`171180d`、`5bc3eed`、`0dd86e9`：演示探针与在线页面快照重投），不在本分支。按任务书的合并顺序没有合它们。

`server/render-node/http-transport.mjs` 第 14 节的错误归类没改（留给 HT-b）。

## 2. 对账与主会话裁定

### 2.1 `ht-kit.mjs` 的假设（第 16 节第 3 条）

只改 kit 里的假设与折算，用例判据一条没动：

- **H5**：原写「接续失败在握手里回 404 / 410」。按第 16 节，`resumeStatus` 改成握手成功后读关闭帧，4404 折算 404、4410 折算 410，握手就被拒的照回状态码。
- **H7**：与实现一致；补注实现的 `opened` 连旧客户端累计。
- **H11**：补注实现两条都做（收到 4404 / 4410 立刻重建；握不上时脱开超过 `welcome.retainMs` 也重建）。
- 其余与实现一致（http-transport 报告第 3 节、ht-client 报告第 2 节逐条核过）。

对账后 63 条 HT 用例全部真跑、0 跳过（第 3 节）。

### 2.2 客户端偏离的接受（〔裁〕主会话）

写进契约第 17.1、17.2 节：旧服务端退化（250 ms 探测）、页面未确认上限 32 MiB / 节点 1 MiB、只有 1005/1006/1011/1012/1014/1015 算传输故障（4009 当会话结束）、契约外的 `onConnectFail`、`renew: false`、`dropTransport()`、`welcomeTimeoutMs`。http-transport 报告里记的偏离与更正建议收进第 17.3 节。

### 2.3 4410 的上报（〔裁〕主会话）

- `server/render-node/session-link.mjs`：新增 `FINAL_CLOSE = {4003, 4004}`（「连着时收到也不会重连」，与页面 `link.ts` 的 `FATAL_CLOSE` 一致）与 `closedCodeOf(reason)`（从 `session-closed <码>[ <原因>]` 取原码）。接续得 4410 且原码在 `FINAL_CLOSE` 里：按原关闭码与原因 `onClose`，不走 4410 的重建；否则照旧报 4410 并重建。日志 `session.lost { code: 4410, closedCode }`。节点侧与页面 `SyncLink` 共用这一份。
- 对 `renew` 缺省为真的节点端点，报出原码后照连着时一样按退避建新会话（连着时收到 4004 本来也是这样）；页面与 doc-link 是 `renew: false`，由上层决定，页面对 4003 / 4004 不再重连、弹阻断弹窗。
- 单测：节点侧 `session-link.test.mjs` 加 SL-closed-code、SL-4410-final（4004 deleted、4003 kicked、4003 removed，各自与「连着时收到同一个码」的 onClose 逐项相同）、SL-4410-final-renew、SL-4410-renew（1013、1001、1000 照报 4410 并重建）、SL-4410-expired；页面 `session-link-page.test.mjs` 加 SL-page-final（4004 deleted、4003 removed：脱开期间结束 → 页面 `onClosed` 收到 `{ code, reason, fatal: true, neverOpened: false }`，不重连，与连着时收到的逐项相同）、SL-page-4410-renew。页面测试的 `startEnv` 加 `direct` 选项：服务端会话层已合入，经代理直连真服务、不挡网关。
- 变异检查：把判断改成 `if (false)`，这 6 条（节点 4、页面 2）全部失败，恢复后全过。

### 2.4 按字节确认（〔裁〕主会话）

服务端 `session.mjs` 已照做（`SESSION_DEFAULTS.ACK_BYTES = 64 KiB`，`noteReceived` 里「满 32 条或满 64 KiB 立刻单发」），但没有单测；补了 `server/test/docservice-session-ack.test.mjs`（DS-ack-bytes：40 KiB 不立刻确认；累计过 64 KiB 500 ms 内确认到 2；之后一条小消息按 1 s 计时）。客户端 `c724836` 已有 SL-ack-bytes。契约第 3.3 节写入。

### 2.5 没接会话层的调用方（〔裁〕主会话）

`server/card-sync.mjs`、`scripts/probes/shared-project-lan.mjs`、`render-host-probe.mjs`、`c66-t9-probe.mjs` 的页面连接、管理接口的令牌连接仍用 `createWsEndpoint`，这次不接。列进契约第 17.1 节第 3 条与 `docs/plan/TODO.md` 的 HT-b 条目下（连同第 1 版节点端 HTTP 客户端的改写、第 6 节的 409 与 `bad-ack`）。

### 2.6 契约的改动

第 3.3 节（按字节确认）、第 3.4 节（客户端上限可调，页面 32 MiB）、第 4.1 节（WebSocket 接续失败 4404 / 4410 / 1002 与 4410 的 `reason` 格式、4003 / 4004 的上报例外）、第 4.2 节（客户端怎么分传输故障、4009）、第 4.3 节第 6 条（HT-a 里 `http` 未启用）与新增第 7 条（旧服务端退化）、第 4.4 节（`onOpen` 时机、`connected`、第一次建会话前的 `send`），新增第 17 节「实现记录」。

## 3. 验证

### 3.1 类型检查

`npx tsc -b --force`：退出码 0，零错误（`b03823b` 上跑一次；最后一个代码提交 `de3dbed` 上再跑一次，同样零错误）。

### 3.2 HT 用例（63 条）与 `ht*.test.mjs` 连跑

各文件单跑（对账后）：

| 文件 | 条数 | 过 | 跳过 |
|---|---|---|---|
| ht-legacy | 3 | 3 | 0 |
| ht1-session | 22 | 22 | 0 |
| ht2-backpressure | 5 | 5 | 0 |
| ht3-equivalence | 1 | 1 | 0 |
| ht4-client | 22 | 22 | 0 |
| ht5-probe | 2 | 2 | 0 |
| ht6-trust | 5 | 5 | 0 |
| ht7-probe | 3 | 3 | 0 |
| 合计 | 63 | 63 | 0 |

HT7 的三条是探针自身的本机用例（不给 `--base` 退出码 2、本机托管组合信任关闭全过、信任回环时探针报失败）；阿里云上的 HT7 由主会话在部署后跑。

`node --test server/test/ht*.test.mjs`（含前缀相同的 `http-guard.test.mjs` 11 条）连跑 3 遍：三遍都是 `tests 74 / pass 74 / fail 0 / cancelled 0 / skipped 0`，退出码 0。

另：`session-link.test.mjs` 20 条连跑 3 遍全过；`session-link-page.test.mjs` 7 条全过；`docservice-session-ack.test.mjs` 1 条过。

### 3.3 页面验证（真服务端会话层，不用网关桩）

脚本在 scratchpad（`ht-integ/page-verify.mjs`，不入库），全部由它起、跑完关掉：

- 托管组合 `server/hosted/main.mjs` 子进程：`PROMPTCUT_TRUST_LOOPBACK=0`、现场生成的集群令牌（不打印），文档服务 5623、素材服务 5624，只绑回环；启动行 `loopbackTrust: false`，素材服务地址登记 `via: cluster-token`；
- 同形 nginx 的前缀代理 5625：`/hosted/*` → 文档服务、`/media/*` → 素材服务，HTTP 与升级都转；能只掐断页面的连接、能拒绝页面的新连接；解析页面→文档服务方向的 WebSocket 帧，数 `project.op` 与 opId；
- 桌面编辑器：本 worktree 的 vite dev server 5620（舞台 5621、5622），数据目录临时、`PROMPTCUT_PUSH=0`；无头 Chrome（puppeteer）。

步骤：开始页「加入别人的项目」填服务器地址 `http://127.0.0.1:5625/hosted`、项目名、用户名、项目密码 → 进入共享项目；以 `store.setProject`（界面同一条路）改 1 次、等确认；代理从服务端一侧掐断页面的传输，紧接着改 3 次；等接续；页面 `__pcSyncTest.cut()` 关掉 WebSocket，再改 2 次；等接续、全部确认。

结果（第二遍，第一遍数字相同）：

| 核对 | 结果 |
|---|---|
| 版本号 | `pageRev 7 = serverRev 7 = rev0 1 + 6 次` |
| 转给文档服务的 `project.op` | 6 条、6 个不同 opId（没有重放） |
| 页面项目与服务端项目 | 整份逐项相同（键排序后 JSON 相等）；轨道：序列 1、序列 2、序列 1、服务端断开期间 1～3、页面断开期间 1～2 |
| 同步状态 | 全程只有 `online`（每 100 ms 采样） |
| 页面端点 | `opens 1, resumes 2, detaches 2, closes 0, dropped 0, pendingBytes 0, transport 'ws', legacy false` |
| 服务端 `/healthz.sessions` | `resumed` 0 → 2；`opened` 4 → 5（多的 1 是核对时创建者的旧式连接）；页面会话 `conn-2` 一直是同一个 |
| 日志 | 托管端 `session.detach conn-2 1006` → `session.resume gapMs 521` → `session.detach 1000` → `session.resume gapMs 416` |

截图：`1-after-edits.png`（编辑器右上「成员 1 人」，时间轴依次是序列 1、序列 2、序列 1、服务端断开…）。

「脱开期间删项目」（第 2.3 节的裁定）：代理拒绝页面的新连接并掐断它的传输，等服务端 `/healthz` 显示页面会话脱开（`conn-2 detached: true, transport: null`）；创建者经代理做 `shared.admin delete`（回 `shared.admin.ok`）；托管端日志 `shared.delete` 后 `conn.close conn-2 4004 deleted`（会话在脱开中结束，立墓碑）；放行后页面接续得 4410，弹出与连着时相同的阻断弹窗「项目已被创建者删除。回开始页新建或打开别的项目。」（截图 `2-deleted-while-detached.png`）。
对照：临时把 `session-link.mjs` 的这条判断改成 `if (false)`（不提交，跑完还原，`git status` 干净）再跑，同一步 30 s 内等不到这个提示，脚本以 error 结束。

两遍跑下来 `summary: { total: 10, failed: [] }`。

### 3.4 全量测试

`npm test`（`de3dbed` 上，当时没有别的会话在跑全量测试）：退出码 0；**tests 3347、pass 3345、fail 0、cancelled 0、skipped 2**。跳过的两条正是显式开启的集成用例：`集成:/api/cards/layout 对真实项目返回整数框`、`SKILL 闸门:闸关之后无头实例的工具调用不落地`。

第一次跑（`b03823b` 上）是 tests 3347、fail 4：`sp-hosted.test.mjs` 的 SPC1-2、SPC1-3、SPC2-1、SPC2-2 起托管组合时 `EADDRINUSE 5490`。当时另有两份别的会话的 `npm test` 在跑（`node --test-global-setup=… --test …`，不是本会话起的，没动）；`sp-kit.mjs` 用固定端口 5490～5499，两份全量测试重叠时互踩，是 `AGENT-bad-ports-concurrency.md` 里记过的已知问题，与 HT 无关。单跑 `sp-hosted.test.mjs` 12/12 过，别的会话跑完后全量重跑即上面的全过。

### 3.5 C6.6 T9 本机替身（信任关闭）

脚本拷自主会话的 `run-t9-local.sh`，放在 scratchpad 的 `ht-integ/run-t9-local.sh`：旧变量名改成 `PROMPTCUT_TRUST_LOOPBACK=0` 加现场生成的集群令牌（不打印）；托管组合与协调口的端口由系统分配（端口 0；--role all 的三个编辑器要 9 个端口 5620～5628，段里放不下另外三个）；`c66-t9-probe --role all --port-base 5620`。托管端启动行 `loopbackTrust: false`。

结果（第二遍）：`probe exit 0`，顶层 `ok: true, fails: [], ms: 178427`。

- creator：`ok true`；`plan { plans 1, tasks 8, done 8, failed 0, pcCompleted 3, publishToSettledMs 150079 }`；`edit { ok true }`、`cardRevAfterEdit 2`；上传 `firstCompleteMs { small 2959, original 47762 }`；
- observer：`ok true`；`joinMs 437`；`firstShown { tier small, w 800 }`；换档 `swapMode covered`、`swapSamples { n 369, black 0 }`；`tierSequence` none → small（2456 ms）→ original（39258 ms）；
- host：`ok true`；`claimed 5, completed 5, failed 0, lost 0`；`doneCounts { tasks 8, exactlyOnce 8, missing 0, duplicate 0 }`；`artifacts { manifests 8, missingManifests 0, blocks 35, missingBlocks [] }`；`cardV2 { rev 2, inOverlay true, baseUntouched true }`。
- creator 的 `uploadQueue` 记了 1 次 401（原尺寸第 1 片，重试后传完）。主会话 scratchpad 里 `c66fix/` 下之前的 11 次 T9 结果都有同样一条，不是 HT 带来的。

第一遍没过（`plan 没落定`、observer 截图超时），原因是我：跑到 06:36:15 时我在 worktree 里写报告并提交（`git add -A` 还把探针临时生成的 `src/cards/user/c66t9-*.tsx` 带进了提交，已 amend 去掉），同一秒两个编辑器页面都以 1001 离开（托管端 `session.detach … code 1001`）、重新载入后回了本机空间，计划因此落不定。第二遍全程不碰 worktree 即全过。教训：dev server 在跑时不往它的 worktree 里写文件、不提交。

### 3.6 C10a 在线加入（信任关闭）

`scripts/probes/online-join-probe.mjs` 原来起托管组合时不传本机信任，加了一处：环境变量 `PROMPTCUT_TRUST_LOOPBACK=0` 时给 `startHostedCombo` 传 `trustLoopback: false` 与集群令牌（取 `PROMPTCUT_CLUSTER_TOKEN`，没给就现场生成）（`de3dbed`）。在线构建 `npx vite build --mode online` 出到 scratchpad；端口 5620（编辑器，舞台 5621、5622）、代理 5623、文档服务 5624、素材服务 5625。

`PROMPTCUT_TRUST_LOOPBACK=0 node scripts/probes/online-join-probe.mjs …`：`hosted.up … trustLoopback: false`；`summary { checks 44, ok 44, fail 0 }`，退出码 0。本底含 `3214f4c`。

### 3.7 渲染队列冒烟

本 worktree 的 vite dev server 5620（数据目录临时、`PROMPTCUT_PUSH=0`）：

- `node scripts/probes/stream-produce-probe.mjs --origin http://127.0.0.1:5620`：**PASS**，`fails: []`，退出码 0；
- 同上加 `--group`：**PASS**，`fails: []`，退出码 0。

主计划说 HT 不跑 G0-R（导出确定性、快照重放一致），本次也没跑；`vite-plugin-frames.ts` 的三处改动只换了到文档服务的端点，冒烟覆盖到了预渲染管线本身。

### 3.8 旧客户端行为不变

`ht-legacy` 3/3 过；`HT2-legacy-compare` 过；现有测试一条期望没改，全量 0 失败。页面验证里托管端同时挂着 2 条旧客户端会话（素材服务的地址登记、编辑器进程的卡片同步），全程照常。`session-link-page.test.mjs` 的 SL-page-legacy（新页面对没有会话层的旧服务端）过。

### 3.9 没跑的

导出确定性、快照重放一致（G0-R）：按主计划 HT 不跑。HT7 阿里云外网三项、跨机 W-HT-a、部署：主会话做。

## 4. 与语义不一致之处（只列出，没改语义，由主会话定）

对照 `docs/semantics/product/document-service.md`、`docs/semantics/mechanism/document-service.md` 的「会话与传输」与「本机按真正的发起方判断」：

1. **传输只有 WebSocket**：语义写「WebSocket 与 HTTP 长轮询并存」「由系统自动选择」，机制写「握手失败就转 HTTP 长轮询」。HT-a 按拆分只接 WebSocket，HTTP 是 HT-b。阶段性缺口，不是实现偏离；HT-b 做完前被代理挡住 WebSocket 的成员连不上。
2. **不是每一方都讲会话**：语义说文档服务与「每一方」之间是一个会话、单次传输中断不结束会话。`server/card-sync.mjs`、管理接口的令牌连接（`asset-announce`）与几个探针仍是旧客户端，断一次就断线（主会话已裁定这次不接）。
3. **本机信任靠开关**：语义说经同机反向代理转进来的请求按远端对待。实现是开关 `PROMPTCUT_TRUST_LOOPBACK`，缺省 `1`，只有部署脚本给阿里云写 `0`；用户自己在本机托管组合前挡反向代理时，缺省下仍把代理转进来的请求当本机。契约第 10 节就是这么定的，与语义字面有出入，要不要在语义里写明「由部署方关掉本机信任」请主会话定。
4. 新客户端对旧服务端的退化（契约第 4.3 节第 7 条）语义里没有；只在服务端没升级时生效，不改变承诺，列出备查。

## 5. 需要主会话决定的事

1. 本分支是否合入 main（用户授权）。合入前请审第 17 节与本报告里的〔裁〕。
2. `claude/c10a-integ` 在 `claude/http-transport` 合它之后又有 3 个提交（`171180d`、`5bc3eed`、`0dd86e9`）不在本分支；要不要在合入前补合。
3. 第 4 节第 3 条（本机信任开关与语义字面）。
4. `sp-kit.mjs` 的固定端口 5490～5499 在并行全量测试下互踩（第 3.4 节），要不要另立一项改成端口 0。
