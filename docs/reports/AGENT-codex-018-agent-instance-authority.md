# Agent 实例权威：开工记录

- 工作区：`018-agent-instance-authority`；分支：`codex/018-agent-instance-authority`；基底：`6c4cd8d8bb74e9cfb817ea83657436fa9d26ec9d`。
- 独占范围：`server/account/run-authority.mjs`、新增 `server/account/agent-instance-authority.mjs`、实例专属测试/子进程夹具及本报告。中央接线、Agent runner、部署与旧工作区不改。
- 已读 AGENTS 入口、开发索引、行为/约束、验证/多 Agent 协议、任务 brief 5/8/9/11 及可信 read/run 语义。

## 已知问题与证据边界

现有 runGrant 只绑定 serviceId/serviceKid。同一证书只能证明服务身份，不能区分旧进程和新进程；旧模块测试通过不证明旧 OS 实例及其资源已经关闭。中央当前以 `run-instance-unavailable` 关闭生产授权，不能在本包证据未接入时解除。

## 三级机制拟修改

保持用户队列、已读、退出、切私有和禁止自动重放外部副作用的语义。拟增加每次进程启动的内存 Ed25519 持有证明、doc 持久注册及单调代际；握手挑战绑定 doc authority、当前服务证书、具体传输认证会话及实例。仅 doc 验证成功后生成服务器内部实例会话，客户端提交的 instanceId/generation 只是查找引用。每个 grant 固定绑定实例，逐调用查持久状态与当前证书；同进程重连重新证明持有，同证书新启动不得继承旧 grant。doc 重启保留注册但清空会话，必须重新挑战。

进程私钥不能落盘、加入 readIntent 或日志。该持有证明不声称能阻止受信服务主动泄露私钥，也不代替 root 部署侧 OS/cgroup 资源关闭见证；没有完整关闭证据仍 pending。恢复只查同实例及其本机 readIntent，execution-started 不自动重做。

## 预定故障矩阵与状态

注册前后真实 SQLite crash/ACK 丢失、重复请求与改变公钥冲突、同证书新实例、伪造/旧代际/撤销、同实例重连、doc 重启、证书撤销夹缝、各 run API 精确绑定、旧实例资源仍存活与真实关闭、缺部署 witness、已启动执行不重放。首失败及原始日志保留。

当前仅完成只读审阅；实现、定向、类型、full 均未跑。没有服务/固定端口/probe 租约；full 待 root 单独授权。不会把拟机制或受控 OS 夹具称为已完成生产实例关闭证明。

## 已实施接口（2026-10-08）

三级修改前：同服务证书的新进程能重用旧 runGrant，幂等表仅以 serviceKid/requestId 为键。修改后：每次进程启动只在 RAM 生成 Ed25519 私钥，注册结果含 `instanceId` 与正安全整数 `instanceGeneration`；代际由同一 doc SQLite 事务单调分配。新实例不继承旧实例，不自动宣称旧实例关闭；普通用户账号、退出及共享已读例外语义不变。

采用 TLS exporter 逐请求证明，替代最初拟定的两次同连接挑战。实际 Agent client 当前每 POST 新建 TLS 连接，逐请求 exporter 无需修改为强制 keepAlive；这仅是三级传输机制收敛。新 `createAgentInstanceAuthority({ledger,verifyTransportInState,verifyClosureWitnessInState?,failpoint?})` 提供：

- `beginRegistration({servicePrincipal,requestId,publicKey})`：当前可信 Agent 服务才能生成持久挑战。公钥必须 Ed25519。同服务/kid/requestId 重试返回原挑战，更换公钥 409。
- `register({servicePrincipal,challenge,signature})`：签名覆盖固定 `promptcut.agent-instance.register.v1` domain、doc authorityId、服务/kid/requestId、challengeId、nonce、公钥摘要。原请求/原公钥的 ACK 丢失可重试；新实例代际在 SQLite FULL 同事务提交，不保存私钥。
- `authenticate({servicePrincipal,method,path,operation,request,proof})`：method/path/operation 由实际受信路由决定；request 是解析后的完整正文，proof 单独放头/传输元数据、不在正文里。proof 为 `{instanceId,instanceGeneration,signature}`。签名使用导出的 `instanceProofPayload` 和 `canonicalJson`，覆盖 `promptcut.agent-instance.request.v1`、doc authorityId、实例/代际、当前 serviceId/kid、channelBinding、method/path/operation、完整 `digestOf(request)`。签名输出 base64url。
- `instanceTlsBinding(socket)`：必须传真实已验证且仍活的 TLSSocket；双方使用 `exportKeyingMaterial(32,'EXPORTER-PromptCut-Agent-Instance-v1')` 后 SHA-256。缺 exporter、TLS 在不受信代理终结、未认证或 closed 一律失败；不接受转发头或 body 给 binding。
- `verifyTransportInState(state,principal)`：中央同步 callback，逐次 force 核当前证书登记，返回 `{serviceId:'agent',serviceKid,authenticationId,channelBinding}`。authenticationId 必须是实际 socket 的 RAM 唯一标识；不能使用旧 cert 级标识。中央 RAM 表由标识找 socket；不要把 socket 本体放进需 structuredClone 的 principal。
- `authenticate` 返回 `{instanceSession,instanceId,instanceGeneration}` **仅供服务器内部**，不得网络回包/日志/磁盘。`verifyInState(state,principal,{operation,input})` 同时检查当前 socket、证书、持久实例状态，以及 `instanceRunScope(operation,input)` 精确授权输入。完整正文摘要在请求验签阶段绑定；服务端派生 actor 不从客户端 body 建立。`release(instanceSession)` 应在该次完整调用及内部 gate 结束后 finally 执行。
- run 工厂新增必需 `instanceAuthority`，无依赖即 fail closed；admit/read/query/check/resolve/finish 全走上述检查。`authorizeQuery` 与 `resolveRunPrincipal` 只在本函数内部派生同范围 read gate，不能把该 cap 拿去外部 `checkAccess(write)`。ticket 消费者应签对应 resolve 请求，不能将 ticket/metadata cap 升级成写权限；长期 WS 逐消息授权需要另接精确调用证明，本包没有偷偷放通。
- `fenceInstance({instanceId,instanceGeneration,requestId,reason})` 在同一 ledger 事务先实例 fenced，再撤该实例原 grant 并产生 operationFences。控制记录保留精确 `instances[]`；旧队列未分配给实例时不被误撤。`confirmClosed` 只收精确实例/代际的 complete witness 并要求 root 部署侧 `verifyClosureWitnessInState` 明确 true；没有 verifier 或证据不完整均拒。run control 的现有 receipt verifier 仍须核 controlId/fenceRevision、每个 `instances[]` 的实际关闭资源与 retained 例外；此包不把证书签名或新注册代际当关闭证明。

中央/runner 后续最小接线：真实 mTLS socket → 当前 service registry → 实例注册/逐请求 proof；runner 在 secureConnect 后、请求正文发送前签名；中央将内部 cap 传 provider 并 finally release；WS/ticket 严格消费对应范围；root 另接历史 OS/cgroup inventory 和 close witness。上述生产中央/runner 文件不在本包实现范围，现有 503 防线应保留到消费者实际挂好。

## 状态与恢复矩阵

| 状态 | 同一个仍活 Agent 进程、doc 重启 | 新 Agent OS 进程、新 RAM key | fence/关闭证据 |
|---|---|---|---|
| queued（尚无实例） | 正常重新核 sender 后 admit | 可注册新实例并按 FIFO admit | 仅项目/登录/对话失权取消，不因旧实例离开误取消 |
| preparing（已绑定实例） | 新 TLS 重签；用同 request/grant 和本机完整 readIntent 确认 | 拒绝旧 grant/旧 ACK；不改实例绑定 | 实例 fence 撤 grant，操作 fence pending 到真实收口 |
| active/retained 已读当前轮 | 精确原实例重签后查同 receipt；每次仍核 private/stop/currentRun | 拒绝接管；旧实例 unknown 不归零 | private/stop/delete 仍优先；已落地和 read 历史保留 |
| execution-started | 已发模型/外部副作用不自动重放；只保留明确续点证据 | 不接管、不从 prompt 重做 | 保留不确定外部效果事实，不冒称 complete |
| fenced / closed | 原 key 也不能恢复授权 | 新 key 不能冒用旧身份 | fenced 立刻拒权限；closed 另需精确可信 root witness |

本机制证明当前 TLS 通道持有特定 RAM 私钥；它不声称抵抗受信 Agent 主动复制私钥给其它 OS，也不代替 OS/cgroup 隔离与部署验证。密钥不落盘是实际 Agent 消费者必须落实的契约。

## 真实证据及首次失败

- `9aa15681` 首目标：5/5、0 fail/skip/cancel，1369.6696 ms，exit 0；`%TEMP%/pc-agent-instance-target-1.log`。真实两个独立 Agent 子进程、真实 mTLS listen(0)：同连接 exporter 一致；旧签名换连接拒绝；原进程重连重新签成功；doc SQLite close/reopen 后原 key 成功；同证书新 OS key 冒旧实例拒绝。子进程实际 close exit 0 后才放行受控 owned-child-close witness，之前拒绝。
- `9811de71` 首接线目标：50 tests / 42 pass / 8 fail / 0 skip，1923.3917 ms，exit 1；`%TEMP%/pc-agent-instance-target-2.log`。7 个旧 crash 断言与新语义冲突，另 1 个父 suite 计失败。没有 native retry。不是生产 grant 问题被 sleep 修复。
- root 精确批准修改旧 `run-authority-crash.test.mjs`：两项 credential crash 原“新进程恢复 retained 成功”改为精确 403 `run-instance-mismatch` 且 read 历史仍在；两项 read ACK crash 原“新进程 confirm 成功”改为 unknown + query 精确 403 且 receipt 数量不变；三项 private/off crash 仍要求持久 revoked，错误从旧 run gate 改为更早的实例 mismatch。原 19 个 SQLite/receipt/execution-started/无重复外部效果断言全部保留，没有修改旧 child。
- `1514b6c1` 有因复验：56/56、0 fail/skip/cancel，7114.6887 ms，exit 0；`%TEMP%/pc-agent-instance-target-3.log`。新增 6 个 doc-only **真实 exit 73 + close** 切点覆盖 register/admit/read 的 before/after commit；Agent 是另一个持续活着的 OS 进程，私钥只 RAM，本机 readIntent 为 SQLite FULL；重启 doc 后同 key/同 request 恢复同 grant/receipt，不发任何模型/工具请求。此补偿验证区分合法 doc 恢复与非法新 Agent 接管。
- `1514b6c1` types --force：exit 0、零错误，wall 10151.3159 ms；`%TEMP%/pc-agent-instance-types-1.log` 及 `-exit.json`。
- full 前只读自审发现 `normalizePrincipal` 缺 instanceId/instanceGeneration 会丢 trusted 身份，未赌全量绿；root 追加最窄租约仅在 `service.mjs` PRINCIPAL_EXTRA 增加这两字段，新增实际 WS/listen(0) 测试核 body 伪身份不能替换、其它未知字段仍丢、内部 cap 不外发。该接线待随后固定源码定向/type/full。

实际账号 provider 固定为 VH `327ff674f16d9ddf83d5697f4c78f63847a82768`（018-active-run-order），order 同叶固定文件；没有用脏 provider。所有证书、SQLite、测试日志在系统 TMP，child windowsHide，未打印私钥/proof/exporter/token 值。共享 full 已获 root 租约，尚待最后窄接线固定验证；未运行宽渲染/节点/生产实例验收。
