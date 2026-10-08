# 0.7.18 云端 Agent 持久轮次消费与真实资源收口

工作树 `codex/018-agent-runner`，起点 `39e740008895b336b901f348d4e0c3c4b78d05a7`。本叶只负责消费 doc 持久队列与 run/read 权威，以及 Agent 本实例的停止资源回执。中央 doc 路由、账号 provider、界面、node 与真实模型配置由各自 owner 负责；未接证据保持 pending。

## 固定源码与接口

- `11b1b8df39784f246c741286b62a8bcff8b54bec` 单独修正 conversation send/switch/stop 的幂等范围，key 含 action/project/conversation/account/request 的规范摘要。同 owner 在不同 conversation 复用 requestId 不再互相冲突；未改旧历史迁移。
- `e54651d12fc3a9235d208553f5bbc96b1ab0383f` 增加 Agent 侧 `createRunClient({ origin,tls,serverFingerprint256 })`。它经 Agent 自身 mTLS 证书和 doc server pin 调用 `/internal/v2/runs/{admit,read,read/query,check,finish,ticket,pending}`；body 不接收 servicePrincipal 或用户身份声明，doc 必须从 TLS 注入真实登记身份。`pending` 只列 conversation metadata，不返回消息正文。
- `createHostedAgentService({ accountMode:true, requireAccountRunner:true, conversationClient,runClient,readIntentsFile,serviceKid,instanceId,... })` 返回 `runManager`。send 持久排队后唤醒；admit 取 doc 持久完整 message；Agent SQLite FULL 的 read-intent 先 fsync，再由 doc 以持久消息原文/身份/选区/附件独立确认 read receipt；丢失 ACK 时按同一 readIntentId/queryRead 取已落地回执；只有回执和新鲜 grant/fence 通过后，才交既有 `startHostedRun`。模型请求前和每个工具前都重新向 doc 查当前 grant。Agent 完成/异常不自动重放 execution-started。最终模型输入含 Agent 自有 system/history，可另记摘要审计，不作为 doc 确认用户消息已读的前置条件。
- `createRunControlServer({ tls,docFingerprint256,serviceKid,instanceId,manager })` 是独立 Agent 内部 HTTPS/mTLS 接口 `POST /internal/v2/agent/control`。只接 pinned doc 证书，body 必须绑定目标实例和 serviceKid；manager 等真实 runner/底层延时工具完成及自有 socket/child witness，任一未知旧实例或 witness 缺失返回 503 pending。它的 receipt 仅是 Agent 本实例声明，doc 仍须独立验证自己的 data socket、持久 operation fence 和目标实例世代，才能提交三方 ACK。生产 wiring 必须传可信的实际资源 witness，不能传测试里的 `() => true`。
- `createAgentInstance` 新的可选 `beforeToolCall` 和 `drain` 只为 account runner 传入；原 LAN/local 未传时维持旧路径。runner 对 doc 已验证的发送时选区使用 `clipIds` 数组，在发起人离线时将其明确作为非实时快照。全员在线选区的实时 query provider 尚未在这个 Agent runner 上挂载。

## 首次失败和验证

- `npm test -- server/test/agent-runner-read.test.mjs` 首次 2/2，exit 0，151.4469 ms：真实 SQLite doc ledger + conversation/run authority 同事务、真实 Agent read-intents SQLite，覆盖完整持久 record 与丢 ACK query 后才执行，以及凭证在 admit 前撤销后零执行。runnerFactory 是明确测试 runner，故这不是生产模型调用证明。
- `npm test -- server/test/agent-runner-control.test.mjs` 首轮挂起大于 40 秒，手动 Ctrl+C，exit 1；第二次加诊断输出已到 receipt/finally 再挂起，手动 Ctrl+C，exit 1。原因是 fixture 子进程收到终止信号后 `exitCode` 仍是 null，但 `signalCode` 已非 null；原 witness 因此给出 pending，finally 又等待同一子进程第二次 `exit`。两次失败临时目录 `C:\Users\admin\AppData\Local\Temp\pc-agent-control-VGwbQq`、`C:\Users\admin\AppData\Local\Temp\pc-agent-control-wQVi2T` 保留，不重解释为通过。
- 修正 fixture 后固定 e546 target 同命令 1/1，exit 0，1075.6404 ms（wall 1.384 s）。临时 CA 的独立 doc/Agent/wrong 叶证书走真实 TLS；wrong cert 403、伪造 target 403，收到真实 socket/server 关闭及 child `exit` 事件后才回 complete receipt；缺一份连接 witness 时 503。子进程为本测试 `process.execPath -e setInterval(...)`、`windowsHide:true`，没有碰用户进程。测试没有打印 ephemeral child PID，证明范围是该 owned child 的 spawn/exit 事件、socket.destroyed 与 listener close；它不证明历史旧实例的 OS/cgroup 收口。
- e546 固定源码执行 `node ..\..\node_modules\typescript\bin\tsc -b --force`，exit 0，7.6959 s。target 后 5790–5799 无 LISTEN，CIM 查询无匹配 fixture child，worktree 干净。新主体全量 npm test 尚待独占共享端口租约，不能引用根其他固定源码的全量结果。

## 尚未完成的生产条件

中央 doc mTLS run routes、可信 service registry/真实 provider 逐消息同步与 run-ticket、Agent 生产 control listener/资源 witness、真实模型 API 配置和运行实例世代尚由各 owner 装配；`requireAccountRunner` 在正式 accountMode 必须强制启用，不能以旧 queued-only fixture 分支充数。当前 `pending` 只枚举 queued，preparing/active crash 的同实例恢复与旧实例隔离尚未具备 doc 持久 instance binding/recover 协议；这部分明确 pending，不能自动重放执行中的工作或给退出 ACK。全员选区实时工具、实际模型/工具/HTTP/SSE 与 doc 端到端目标以及旧实例 OS 级关闭证据亦待中央组合复验。0.7.18 未在节点部署，本叶不能视为产品版本完成。
