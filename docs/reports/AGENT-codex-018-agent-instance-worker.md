# Agent 实例 worker 接线记录

工作树 `codex/018-agent-instance-worker`，起点 `6c3ca23a306eca526c5888d096c0f2645cd00830`。本叶只实现 Agent 侧 RAM Ed25519 实例注册与真实 TLS exporter 绑定的 HTTP 请求证明，并在获准的实例消费入口接线。WS/LP 的逐帧证明要等 doc 核心窄协议和租约；未完成时仍拒绝，不把旧 read capability 当写权限。

已读 `AGENTS.md`、`developer_guide.md`、`suggested_agent_behavior.md`、`constraints.md`、`verification.md`、Agent/hosting 产品机制、三版本设计、实例权威 `agent-instance-authority.mjs`、实例/运行内部 HTTP handler 及生产 Agent 入口。中央 owner 给出的协议为注册 `challenge/register`、`X-PromptCut-Instance-Proof`、完整方法/路径/操作/正文 digest 及真实 TLS exporter；不存在的原租约路径已向根纠正为 `server/agent-service/run-client.mjs`，获准后才修改。

源码提交 `a5f02082136c8f7f12e6697e59426ad8a77c0d15`：每次 Agent OS 进程构造仅 RAM Ed25519 key/稳定注册 requestId，丢 register ACK 后仍以相同 key/challenge 幂等查询；每个 run HTTP 请求用独立 mTLS socket，握手完成后取实际 exporter 签 exact `{authorityId,instanceId,generation,serviceId,kid,channelBinding,method,path,operation,requestDigest}`，在发送正文前设置证明头，并等实际 socket close 才返回。`checkAccess` 必传 read/write，body 不接自报身份。`pending {}` 仅 mTLS 元数据，无实例能力。测试 fork 两个独立 Agent OS，临时自签 CA/独立叶证书，doc SQLite 与真实 HTTP handler；旧进程可继续、新进程不能继承旧绑定，注册 ACK 丢失后持久实例未重复，所有 owned TLS 连接归零，两个 child 都收到 close。

源码提交 `623d09411c706a2c17811b607bc8c197f15ca53b`：`server/agent-service/main.mjs` 按现有 `PROMPTCUT_ACCOUNT_V2_REQUIRED` / `PROMPTCUT_ACCOUNT_V2` 标志区分；账号版另需 `PROMPTCUT_AGENT_DOC_INTERNAL_ORIGIN`、`PROMPTCUT_AGENT_DOC_FINGERPRINT256`、`PROMPTCUT_AGENT_CLIENT_KEY_FILE/CERT_FILE/CA_FILE`，证书文件只读，缺配置启动 `config.error account-v2`，不自动进入旧控制连接。账号服务只挂 doc mTLS 对话 HTTP，run client 在后台以同一 RAM 实例重试注册并随进程退出关闭；**生产 run 消费者仍未挂载**，明确 `runAuthorityMounted:false`、`runDataProofReady:false`，没有 WS/LP 逐消息证明前不 admit、不确认已读、不调用模型/工具。`create-agent-service.mjs` 已有参数接缝，故未修改。

首次目标测试 `npm test -- server/test/agent-instance-worker.test.mjs`：1/1 通过、0 失败/取消/跳过，1167.3705 ms，exit 0。有因加入“注册已提交但 ACK 丢失”场景后二次：1/1，1212.9613 ms，exit 0。账号入口接线后当前固定源码目标：2/2，0 失败/取消/跳过，1167.9246 ms，exit 0；记录的临时监听端口 9542、关闭后 active TLS sockets 0、两个 Agent child 均收到 close。独立类型 `C:\Users\admin\Documents\PromptCut\node_modules\.bin\tsc.cmd -b --force` exit 0。`git diff --cached --check` exit 0。以上均是本机临时证书/fixture，未运行真实模型或生产节点；没有独立全量 `npm test`，共享租约仍由根持有。

提交 `0f4c1973e0c45f8efaee4f4189945d1cfdcb88d5` 后针对 CLI required 配置补了有因负例：`PROMPTCUT_ACCOUNT_V2_REQUIRED=1` 而 V2 关，及 V2 开但证书文件缺失，两个独立子进程都 exit 1、只写 `config.error`、没有监听或 `agent.ready`。随后的目标测试 3/3 通过、0 失败/取消/跳过，1397.6113 ms，exit 0；临时端口 2527，实际 TLS socket 0，两个 Agent child close。此增量只加测试断言，生产入口仍为 `623d0941`。

根在独立组合固定源码 `506cd0e0` 的首次目标验证发现旧 runner 夹具缺现在强制的 `instanceAuthority`：类型 exit 0、6.594 秒；30 文件 177 项，173 pass、3 fail、1 Windows skip，15841.5134 ms，native 重跑 0。失败精确为 `agent-runner-control.test.mjs:37` 与 `agent-runner-read.test.mjs` 的“durable/lost read ACK”和“credential revoked before admit”，错误 `run-authority-configuration`，原始日志在 TMP `pc-root-instance-http-506cd0e0-target.log`；根因此没有启动该组合的全量测试。此失败不是允许无实例身份降级。

窄修复源码 `d5d7de676fc6d91be98ee302f5ea4192c8f1bfde`：两个旧夹具用真实 SQLite 实例权威登记仅 RAM 的 Agent key，每次调用按精确操作和输入签名、执行后释放授权会话；没有移除丢 read ACK 首次模型门、撤凭证禁启动、mTLS 错证书、真实 child `exit` 与 `close`、socket/server close 或缺 witness 拒绝断言。另修同 OS 未知 ACK：每个 conversation 保留同一个未确认 admit requestId；已拿 grant 后只重试该 grant；readIntent 已 `execution-started` 时拒绝自动再执行，已 `finished` 或当前刚结束时只用原 `finish:<runGrantId>` 完成 doc 状态，传输 503 在本进程以 250 ms 到 5 s 退避重试，close 清定时器。两项新增真实 SQLite、带签名实例 fixture 断言 admit 和 finish 在已提交后丢 ACK 时 requestId 不变、模型与工具各恰好一次。它们使用受控签名传输适配器，不能代替真实 mTLS 客户端/模型执行证据。

上述固定源码的定向 `npm test -- server/test/agent-runner-read.test.mjs server/test/agent-runner-control.test.mjs server/test/agent-runner-ack-recovery.test.mjs`：5/5 pass，0 fail/cancel/skip，1298.3014 ms、exit 0、native 重跑 0；显式环境指向真实 VH `018-account-foundation` provider 和 `018-active-run-order` 的 password-order 模块。启动前 5795–5797 无监听，结束后同段无监听。强制类型 `C:\Users\admin\Documents\PromptCut\node_modules\.bin\tsc.cmd -b --force` exit 0，8.402 s。开发时误用了一次裸 `node --test` 跑新增 ACK 两项，2/2 pass、188.8172 ms；正式定向结果以上述仓库 npm wrapper 为准。

部署源码只读核对：`deploy-agent` 使用 `deploy-render` 的同一份 `current` 检出，`scripts/remote/docservice.mjs` 的 `deploy-render` 将所选提交作完整 `git archive`，没有 Agent 专属源码排除清单。本机临时归档 `d5d7de67` 解包后，静态导入其 `server/agent-service/main.mjs` 最终 exit 0、导出 `startAgentService:function`，只证明归档依赖能解析，不运行 main、Vite、模型或节点。首次导入命令把 Windows `C:` 路径直接传给 ESM 导入而 exit 1；第二次转为 file URL 但把入口路径留在 `process.argv[1]`，误触 CLI 的 `doc-url` 配置检查，exit 1；第三次把该参数改成 `-` 后导入通过。所有操作仅在 TMP 归档目录，没有装包或改系统环境。

后续边界：中央 WS/LP 逐帧完整请求、连接 nonce/公开 connId、原 seq/ack 重试与实际 TLS capability 仍在中央窄核心设计/实现中；本叶未改 doc 核心、未复用已关闭 HTTP capability 充当数据写权限。跨重启对未确认 external side effect 不重放，旧实例资源缺实际 OS/cgroup witness 时 ACK 继续 pending。生产部署、证书文件路径、节点私钥隔离、真实模型输入及全量回归仍待根集成验证。

审读续办边界后又固定一项：模型已执行且 doc `finish` 已提交但 ACK 丢失时，模型配置可能随后失效。原循环先检查新模型资格，会挡住只需幂等提交的 finish。现先续办 `slot.finish`，再对任何新 grant/新队列运行模型 preflight。新增 SQLite 负例在第一个 run 的 finish ACK 丢失后撤模型配置并排第二条消息：旧 finish 原 ID 成功重试、模型与工具仍各一次，第二条维持 queued、没有新 grant。该单文件仓库 `npm test` 3/3 pass、0 fail/cancel/skip，196.495 ms、exit 0、native 重跑 0；显式 VH provider/order 环境。此窄改不声称生产模型配置生命周期已验。

清理自建临时 `TMP/pc-agent-worker-stage-d5d7` 归档时，命令先验证绝对路径落在 TEMP 下且名称精确匹配，再申请递归删除；自动审批直接拒绝整条命令，回报 `rejected: blocked by policy`，未给更具体理由。没有绕过或重试；临时归档目录仍保留，源码和工作树未变。
