# AGENT 报告：HT-a 集成（`claude/ht-integ`）

状态：进行中（合并、对账、裁定已落实；验证进行中）。

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
