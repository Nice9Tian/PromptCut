# 018 run authority — 开工报告

基底：80b5e658e0c56a756003a94cab4c5e4992e76fc3。独占工作区 `018-run-authority`；旧 operation 工作区冻结。

范围：新增 `server/account/run-authority.mjs`、`server/agent/service/read-intents.mjs`、本包专用测试/子进程夹具与本报告。端口 5730–5739；不改中央挂载、既有 authority/ledger/history/password-order/project、VH 或其它 owner 文件。首次端口核查无监听。

已读 AGENTS、developer_guide、suggested_agent_behavior、constraints、multi_agent、verification、solution_table、任务 brief 5/8/9/11 与设计的可信已读/退出/切私有/FIFO/选区约定。

目标：完整 prompt 的本机持久 read intent → doc 同账本 currentRun/readReceipt/runGrant 原子确认 → 明确 ACK 才首次执行。ACK 不确定只查同 request，不再次调用模型。退出先则未读取消；read 先且 shared current 才 retained；private/stop/delete/Agent off/service revoke 优先阻断，重新开放不复活。账号旧登录始终撤销，不保存可用用户令牌。

三级机制：复用现有 SQLite WAL/FULL ledger，以同步事务组合 conversation owner 的 claim/read/finish helpers 与本包 grant 状态。完整 prompt 哈希须由 doc 持久内容独立重建，不能把 Agent 声称 hash 当证明。控制事件、grant 状态、消息取消与 revision 在同事务提交；外部停止/撤流 ACK 独立记录，未齐不报告完成。所有运行 gate 每次核当前账本与可信 service 身份，缺生产 provider 失败关闭。

接口协调：conversation owner 持 conversationsV2/FIFO；本包持 runGrantsV2/read requests/receipts/单调 runClockV2。对外统一 runGrantId 与非负 safeInteger fenceRevision。普通页面仍由真实 account authority 当前凭据校验。中央负责认证服务主体与注入实际 sender 凭据核验；body service 字段不授予权限。

待证明：真实 SQLite 子进程 crash、read/exit/private 顺序、ACK 丢失与重启幂等、身份/项目混用拒绝、retained 精确当前轮、完整 prompt 绑定。当前仅开工与接口设计，没有宣称运行语义已经通过。首次失败/原始日志与全部验证结果将逐项补入。

未决产品项：删除权限/确认/数量释放及调度的上位待确认项不由本包裁定；只实现已授权停止/撤销机制。

## 三级机制收敛及实际接口

开工时曾考虑让 doc 独立重建全部 system/history/tool 模型输入。root 审查指出可信已读对象是持久的完整已发消息，该额外前提不属于用户要求。最终 `canonicalReadRecord` 从 doc 当前 message 重建 `projectId/conversationId/messageId/runId/requestId/senderAccountId/senderNameAtSend/loginId/credentialId/loginGeneration/content/contentDigest/selectionSnapshot/attachments`，与 Agent 从完整持久记录读出的对象作规范化精确比较。输入内可选 `inputDigest` 仅作 Agent 审计，不用于凭空授权。这是三级机制收敛，不是新批准的产品语义。

`createRunAuthority({ledger,conversationHooks,verifySender,verifyServiceInState,synchronize,...})` 要求真实依赖；没有默认允许身份或账户检查。conversation 的 claim/markRead/finish 与 grant/read receipt 共用实际 `openAccountLedger.transaction`，WAL/FULL 单事务。对外返回字段统一 `runGrantId`，`fenceRevision` 为非负安全整数。当前服务只接受经 owner 验证的 Agent 服务主体；公开 grant 引用本身不是凭据。不得把 HTTP body 的 service、actor、已读字段提升为认证身份。

- `admit({servicePrincipal,projectId,conversationId,requestId})`：按 arrivalSeq 核当前队首完整真实 sender；本地失权或账户明确 401/403 可持久取消，未知错误/503 保留队列并拒本次。下一条另查凭据，`expectedMessageId` 阻止借上一条核验结果启动新条目。无可派消息返回 empty；FIFO 变动可返回 retry，均不启动模型。
- `confirmRead({servicePrincipal,projectId,conversationId,messageId,runId,runGrantId,requestId,readIntentId,prompt,promptDigest})`：prompt 是上面的规范持久消息对象；核完整对象、服务登记、当前 run、发送者精确四字段、account head 与权限，然后原子提交 receipt/grant/message running。`queryRead` 用完全相同请求与绑定查历史结果；历史已读回执不替代当前授权。
- `resolveRunPrincipal({servicePrincipal,projectId,runGrantId})`：从真实 grant 构建 actor/run 四重关联并调用当前 gate，返回 account v2/role agent/creator false/principal.servicePrincipal。`checkAccess({principal,projectId,action})` 每次查当前服务/项目/开关/currentRun/receipt/grant；active 仍查真实 sender，retained 不续旧用户凭据。`authorizeQuery` 只从 grant 返回可信 initiator/name/snapshot 与 fenceRevision。
- `hooks.fenceInState(state,fence)`：给 authority/conversation owner 同事务组合；输入 kind、requestId 以及 project/conversation/run/service/login/account 精确范围。shared 且 doc 已确认的 current run 在 credential/member fence 下 retained；private/stop/delete/off/service revoke 优先撤销。取消的消息仍在日志，重新开放不复活。
- `applyAccessEvent(event)`：仅接受与账本已持久 event 完全相同的事件，返回其 controls。`synchronize()` 返回所有持久 pending controls；中央启动时须实际落各 operation fence，并等待实际停止/撤流证据，不能把通知当 ACK。旧 set-hosted-service 缺不可变 service/enabled 信息会 503，不能用最新 true 推断中间未关闭。
- `acknowledgeControl({controlId,receipt},validateReceiptInState)`：必须精确 controlId/fenceRevision/receiptId/complete，再调用真实关闭证据验证器；未齐保持 pending，没有 timeout 成功路径。`onControl` 是提交后的通知，调用方必须独立等待实际 delivery，不是已完成证明。

`openReadIntents` 为 Agent 独立 SQLite WAL/FULL 日志。持久顺序是 prepared → confirmed → execution-started → finished。ACK 不明只能查询同 request；没有 confirmed 不允许执行。执行前还须实际当前 gate，private 后重放旧 read ACK 不能启动。执行开始记录先提交，崩溃留下 execution-started 不自动再次运行模型/工具；重启自动重做外部副作用不是本包功能。

## root 审查反例及修正

固定 `ce44405294f8dfe6789f563c75e172781812e9e8` 首次 full 全绿之后，root 独立真实 SQLite 反例发现：同 owner 的两个不同 conversation 使用相同 requestId 切 private，第一成功，第二 `409 run-request-mismatch` 并仍 shared。原始 `TMP/pc-root-run-scope-ce444052.mjs/.log` 保留，脚本 exit 1；`productionMounted:false`。这说明当时测试缺少请求作用域案例，不是生产接线已通过。

根因：原 `runControlsV2` 以 requestId 全局索引。修正 `08335387`：稳定 scope 为 `{kind,projectId|null,conversationId|null,runId|null,serviceKid|null,requestId}`，`controlId = 'run-control:' + SHA256(canonical(scope))`。loginIds/accountIds/accessSeq 等其余参数属于完整 fence 的 `payloadDigest`；同 scope 改 payload 仍 409，不加随机串绕幂等。authority 原全局 access event requestId 不变。私有操作者由上层 owner 权限确定，同 conversation 的 owner 不变；authority 管理动作来自唯一已持久 eventId。

ACK 只以 controlId 查找，receipt 必须绑定相同 controlId/fenceRevision，旧 requestId-only 调用拒绝。`operationFence.id` 同步改为 controlId + projectId，避免不同 conversation 在操作历史层再次撞 ID。没有真实生产旧记录需要迁移，本包不猜测迁移未 scoped 数据。新增用实际 conversation helpers 的同项目两条 active run/两 conversation、另项目、同 requestId、同 scope 变参与跨 scope ACK 用例；三次私有变更独立成功，错误域 ACK 拒绝，另一 control 仍 pending。

## 验证依赖与证据边界

本包实际 doc SQLite 与真实子进程测试使用 conversation owner 冻结文件 `018-agent-access-v2/server/account/conversation-authority.mjs`，SHA `b25e5de86df474e2d5949acc950169628f30519e`，通过 `PROMPTCUT_CONVERSATION_AUTHORITY_MODULE` 显式只读导入。合流后默认本仓库同路径。没有复制一套假 hooks；本分支单独执行须配置该依赖。

真实账户用 `018-account-foundation` SHA `580bec81325e09a92a805f8d33bb7353a45503d8` 和 `018-password-order` SHA `7eab5535462ebb1980d37be7579f419d382e3efa`，分别由 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT`、`PROMPTCUT_PASSWORD_ORDER_MODULE` 指定。验证了真实 password choice/no-exit/exit、旧 credential 拒绝、新登录独立与 shared retained。测试只用新建 TMP fixture 账户，不输出真实令牌。

其余单元场景的账户与 servicePrincipal verifier 是明确的可控接口夹具；它们证明模块拒绝伪 service、精确身份/project 错绑与控制顺序，不证明生产 challenge/mTLS 已挂。生产 service 认证、actorRef 的真实 internal endpoint、WS gate、撤流/stop receipts 由中央与其它 owner 接线验证。**本包没有改 instance/runner，不能宣称真实首次模型调用已受 read-intent 保护；此生产挂载仍由 owner 完成。** 同样没有把 raw fixture effect 叫模型调用或生产 UI 验收。

19 个子进程 crash cuts 使用 `process.exit(73)`，父进程逐个确认 exit=73 和实际 close 后再打开数据库；不是只抛 JS 异常。包括 admit、Agent intent、doc read、Agent confirmation、execution-started、外部 fixture effect 文件 fsync、finished 的提交前后，以及 private/exit/retained/off→on 提交后。崩溃后两个 SQLite integrity 均 ok；doc read 已提交而 ACK 丢失只返回原 receipt；execution-started 的不确定效果不重做；retained 重启保持，private/off 撤销不复活。Windows 上这证明 SQLite FULL 配置与真实进程崩溃恢复，不冒称硬件断电或 Linux syscall 跟踪。

## 验证流水

所有命令显式设置 cuda_Vit Python、PYTHONDONTWRITEBYTECODE=1、主仓库静默 Node preload；npm full 另设置主仓库模型目录。每项 raw log 与 exit/wall JSON 均在系统 TMP 的 `promptcut-run-authority-` 前缀下。未安装依赖、没有 junction、未改用户端口/进程。纯权限/持久性逻辑不改变画面，不跑 G0-R；最终产品装配探针由 root 执行。

| 验证 | 源码 | 结果 | 原始证据 |
|---|---|---|---|
| target-1 | d0339270 后本包在制修改 | 31/31，0 fail/skip，1204.635 ms；wall 1504.1815 ms；exit 0 | target-1.log / target-1-exit.json |
| types-1 `npx --no-install tsc -b --force` | 同上 | 0 error，wall 7456.5658 ms；exit 0 | types-1.log / types-1-exit.json |
| target-2 | ce444052 | 39/39，0 fail/skip，2012.7307 ms；wall 2488.8049 ms；exit 0 | target-2.log / target-2-exit.json |
| types-2 --force | ce444052 | 0 error，wall 10023.3198 ms；exit 0 | types-2.log / types-2-exit.json |
| full-1 | ce444052 | 5128 tests / 5126 pass / 0 fail / 0 cancelled / 2 skip，71245.2516 ms；wall 71615.8039 ms；exit 0，无 native retry | full-1.log / full-1-exit.json |
| root 独立反例 | ce444052 | 同 requestId 不同 conversation 第二次错误 409，exit 1；保留原失败 | pc-root-run-scope-ce444052.mjs/.log |
| target-3 | 08335387 | 40/40，0 fail/skip，1655.2276 ms；exit 0，无 retry | target-3.log / target-3-exit.json |
| types-3 --force | 08335387 | 0 error，wall 8043.508 ms；exit 0 | types-3.log / types-3-exit.json |
| full-2（scope 修正后必要复验） | 08335387 | 5129 tests / 5127 pass / 0 fail / 0 cancelled / 2 skip，75318.1559 ms；wall 75772.0452 ms；exit 0，无 native retry | full-2.log / full-2-exit.json |
| 真实账户 TTL 反例 | 08335387 + foundation 580bec8 | 已接受消息等 120001 ms：普通 token 正确拒绝、login 仍有效，接错 verifyActorRef 的 admit 却 empty 并取消；exit 1 | ttl-counterexample.mjs/.log |

full-1 前后 5730–5739、5823–5829 均无监听，证据 `ports-before-full.json`、`ports-after-full.json`。本包 target 均不用网络固定端口。早期只读定位出现过错误文件名 `scripts/types.mjs` ENOENT（随后 rg 定位并按 verification 的 tsc 命令执行），无安装或替换路径动作；不是隐藏的测试失败。根反例是本包实际发现的逻辑失败，修正后需新的固定源码验证，不能用旧 full 绿替代。

full-2 前后相同端口仍为空，`ports-before-full2.json`、`ports-after-full2.json`，已向 root 释放租约。两次全量的 2 个 skip 均为既有跳过，不是本包新增跳过。后续不为赌绿重复全量。

## 新发现的账号引用 TTL 接口问题（尚待 owner 实现）

root 审查指出真实 `verifyActorRef` 会按 access row 的 120 秒有效期拒绝，但已接受的 FIFO 消息可以合法等待更久。真实反例使用 foundation SQLite `createEditor` 后从真实 principal 写入 doc 持久消息，受控时钟推进 120001 ms（不 sleep、不改主机时钟），普通 `verify(token)` 拒绝，`validLogin(loginId)` 仍成功；把现有 `verifyActorRef` 直接注入本包 `verifySender` 时，admit 错把该消息取消。日志只输出布尔值/队列状态，无 token，`productionMounted:false`，exit 1。full-2 未包含此接口修复，其全绿不能当反例已关闭。

提给 root 的三级方案是**仅供 doc 处理已持久接受消息的用途专属 actor reference 校验**：真实 credential 存在且 kind access，account/login/generation 严格匹配，显式 credential 撤销/consumed、login 过期/撤销及 browser parent 失效仍拒；短 access token 到期不取消已接受消息。普通页面与新 send 的 token TTL 原样严格生效；该内部接口不签发 token，不授权项目，也不让 body 自称 accepted 获权。doc 调用必须从自身持久 message/grant 重建精确 actorRef 和消息绑定，provider 返回明确用途与账户事件 head。active run gate 也使用此专属资格；retained 仍只受精确已读当前轮例外，不用旧用户 token。

本包未获 VH 文件改动范围，已把证据与接口需求交 root/中央 owner，等待真实 provider 后再定向验证。不能通过放宽普通 `verifyActorRef`、增加 token TTL、静默吞 401 或任意重签旧登录来掩盖。
