# 0.7.18 云端 Agent 对话权限与持久队列接线

工作区 `codex/018-agent-access-v2`，起点 `80b5e658e0c56a756003a94cab4c5e4992e76fc3`。本报告记录本叶的接口、执行和验证；中央装配与真实模型部署未完成前不宣称生产端到端可用。

## 租约与边界

已读 `AGENTS.md`、开发者指南索引、建议行为和硬约束。此叶仅改指定 Agent 服务、对话权限与 doc 权威侧新增模块、专属测试探针及本报告。删除权限、确认、计数和名额释放未拍板，不实施自动删除真实数据；main、node、其它 owner 文件保持不变。

## 固定源码与接口

源码提交 `b25e5de86df474e2d5949acc950169628f30519e`。`createConversationAuthority({ledger,accountAuthority,checkConsent,verifySelectionSnapshot,runHooks,onFence})` 是 doc 侧唯一对话权限入口；每次人类入口经 `accountAuthority.authorizePrincipal` 真核 opaque authorization、account head 和项目权限，随后在同一 SQLite transaction 内再查本地 project/ban/revoked/Agent 开关。sender 只取该可信 principal，`accountName` 保存为 `senderNameAtSend`；对话 owner 固定为首次创建账号，和逐条 sender 分离。

同一 `openAccountLedger.transaction` 懒建 `conversationsV2[projectId][conversationId]`、`conversationRequestsV2` 和单调 `conversationClockV2`。对话保留 `ownerAccountId/visibility/aclRevision/currentRunId/queueRevision`；消息保留 `messageId/requestId/arrivalSeq/senderAccountId/senderNameAtSend/loginId/credentialId/loginGeneration/content/contentDigest/selectionSnapshot/attachments/queueState/runId/readReceiptId`。请求 ID 同账号同项目幂等，丢失 202 后重发取第一次持久快照；同 ID 不同正文 409。一个项目同 owner 已保留 50 个对话时阻新建，不逐出、不删记录；删除入口账号模式 503 `deletion-pending`，未决定删除权限/确认/名额释放。

同步 hooks 为 `claimNextInState(state,{projectId,conversationId,runId,expectedMessageId})`、`markReadInState(state,{projectId,conversationId,messageId,runId,readReceiptId})`、`finishInState(state,{projectId,conversationId,messageId,runId,state,reason})`、`privateFenceInState(state,{projectId,conversationId,ownerAccountId,runHooks,requestId})`。`expectedMessageId` 必填，必须是 run-authority 已真实重验的队首；本地已失权 queued 项同事务取消，若后继不是该 ID，返回 `message:null,retry:true`，先提交取消，再重验下一位，防止借上一位验证结果启动后继。Astra `createRunAuthority` 的同事务 `fenceInState` 注入此处；未注入时私有切换/stop 503。切私有提交 ACL 和取消其它账号 queued 后，`onFence` 必须回 `{ack:true,aclRevision}`；stop 必须回 `{ack:true,runId}`，否则返回 503 pending，不把空回调当生产 ACK。

新增独立 `createConversationInternalHandler/Server({tls,conversationAuthority,resolveDelegation,agentFingerprint256})` 与 `createConversationClient({origin,tls,serverFingerprint256})`。内部 POST `/internal/v2/conversations/{identity,access,list,get,send,switch,stop,rename}` 要求真实 Agent client 证书 pin；doc 自己的 `resolveDelegation(ticket,{serviceId:'agent',action})` 解析 doc 发行的 RAM 票据并真核 authorization，body 不能自报 principal/account/login/service/readReceipt。中央已约 `issueSession.agentDelegationTicket`/`resolveAgentDelegation`，本包不修改既有 `service-client` 的 LAN RPC。

Agent `accountMode:true` 明确走新 doc client；缺 client 启动 503。HTTP 两账号 shared 可列、读、发；private owner 独占发与切换，project creator 可读别人 private 但不能发/切；同意未接受 403 `consent-required` 且不入队；HTTP DELETE/attachment/usage/page-result 在账号模式仍 503。SSE 在 headers 前及每次队列事件写前重新问 doc，失权/上游不可达关闭；当前实现用 250ms 轮询收口，**不是**跨进程 fence 后零延迟撤流证明。LAN 缺省 `accountMode:false` 保持旧路径。

## 首次证据与限制

- 首次开发期 `node --test server/test/agent-access-conversation.test.mjs` 3/3 失败：测试夹具把 `principals` 以 accountId 存、以 `auth:<id>` 取，修测试键；随后 1/3 通过、2/3 失败：重开 ledger 清理时重复 close 与 fixture 索引引用旧键，修清理/索引。保留首次失败原貌，没有降低产品断言。
- HTTP 测试首次失败：错误 client 证书实际收到服务身份 403，测试误期望 503；改为精确 403。再一次失败：`handle` 对 async `accountRoute` 未 `await` 导致错误逸出，修为 awaited 使 400 凭证伪造按协议返回。
- 冻结前类型检查 `C:\Users\admin\Documents\PromptCut\node_modules\.bin\tsc.cmd -b --force --pretty false` exit 0；其后只改一处 JS 账号模式 disabled 错误映射，最终固定源码由下面全量测试覆盖。`npm test -- server/test/agent-access-conversation.test.mjs server/test/agent-access-http.test.mjs` 6/6、0 fail、0 skipped，约 1.20s。测试独立生成临时 CA/doc/Agent/错误 client 证书，真实 TLS1.3 双向连接和服务指纹 pin；经真实 Agent HTTP、SSE 与 SQLite 覆盖两账号、伪造账号拒绝、同意拒绝、private/creator只读、重复消息、重启、失权队首、revoked 请求。证书和 SQLite 都是本测试临时 fixture，运行结束关闭服务器并清理。
- 根独占全量租约上的首次且唯一 `npm test`，显式设置 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT=C:\Users\admin\Documents\VisuHive\.worktrees\018-account-foundation` 与 `PROMPTCUT_PASSWORD_ORDER_MODULE=C:\Users\admin\Documents\VisuHive\.worktrees\018-password-order\account\password-order.mjs`，exit 0：5095 tests / 5093 pass / 0 fail / 0 cancelled / 2 skip，`duration_ms 66071.662`，无 native 自动重跑。原始输出 `C:\Users\admin\AppData\Local\Temp\pc-agent-access-v2-full-b25e5de8.log`。前后源码 SHA 同 `b25e5de8`、工作树干净；5790–5799 启动前/结束后零监听。

这些证据证明本模块的真实 mTLS/HTTP/SSE/SQLite 路径，但 fixture 的 account authority/consent/selection capture 和 `onFence` ACK 均是明确测试替身，**不证明**真实 provider、实际 Agent 停工具 ACK、doc 选区在线快照、read-intent fsync/read receipt、模型/tool gate 或中央生产装配。账号模式现在只会把消息持久置 `queued`，不会制造 read receipt/runGrant，也不会调用模型。Astra 的 run-authority、真实模型 runner 读取持久完整 message record、中央 combo 的 grant/control/selection/fence 回执、服务文件 staging、UI 首次告知与 private 即时 DOM 清理均为后续 owner 接线；缺 callback 必须 503。未交独立 URL/`--out` 产品 probe、浏览器截图和真实两进程 service fence ACK；不能以本包 full 绿宣称 0.7.18 Agent 产品端到端完成。
