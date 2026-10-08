# Agent 实例 worker 接线记录

工作树 `codex/018-agent-instance-worker`，起点 `6c3ca23a306eca526c5888d096c0f2645cd00830`。本叶只实现 Agent 侧 RAM Ed25519 实例注册与真实 TLS exporter 绑定的 HTTP 请求证明，并在获准的实例消费入口接线。WS/LP 的逐帧证明要等 doc 核心窄协议和租约；未完成时仍拒绝，不把旧 read capability 当写权限。

已读 `AGENTS.md`、`developer_guide.md`、`suggested_agent_behavior.md`、`constraints.md`、`verification.md`、Agent/hosting 产品机制、三版本设计、实例权威 `agent-instance-authority.mjs`、实例/运行内部 HTTP handler 及生产 Agent 入口。中央 owner 给出的协议为注册 `challenge/register`、`X-PromptCut-Instance-Proof`、完整方法/路径/操作/正文 digest 及真实 TLS exporter；不存在的原租约路径已向根纠正为 `server/agent-service/run-client.mjs`，获准后才修改。

源码提交 `a5f02082136c8f7f12e6697e59426ad8a77c0d15`：每次 Agent OS 进程构造仅 RAM Ed25519 key/稳定注册 requestId，丢 register ACK 后仍以相同 key/challenge 幂等查询；每个 run HTTP 请求用独立 mTLS socket，握手完成后取实际 exporter 签 exact `{authorityId,instanceId,generation,serviceId,kid,channelBinding,method,path,operation,requestDigest}`，在发送正文前设置证明头，并等实际 socket close 才返回。`checkAccess` 必传 read/write，body 不接自报身份。`pending {}` 仅 mTLS 元数据，无实例能力。测试 fork 两个独立 Agent OS，临时自签 CA/独立叶证书，doc SQLite 与真实 HTTP handler；旧进程可继续、新进程不能继承旧绑定，注册 ACK 丢失后持久实例未重复，所有 owned TLS 连接归零，两个 child 都收到 close。

源码提交 `623d09411c706a2c17811b607bc8c197f15ca53b`：`server/agent-service/main.mjs` 按现有 `PROMPTCUT_ACCOUNT_V2_REQUIRED` / `PROMPTCUT_ACCOUNT_V2` 标志区分；账号版另需 `PROMPTCUT_AGENT_DOC_INTERNAL_ORIGIN`、`PROMPTCUT_AGENT_DOC_FINGERPRINT256`、`PROMPTCUT_AGENT_CLIENT_KEY_FILE/CERT_FILE/CA_FILE`，证书文件只读，缺配置启动 `config.error account-v2`，不自动进入旧控制连接。账号服务只挂 doc mTLS 对话 HTTP，run client 在后台以同一 RAM 实例重试注册并随进程退出关闭；**生产 run 消费者仍未挂载**，明确 `runAuthorityMounted:false`、`runDataProofReady:false`，没有 WS/LP 逐消息证明前不 admit、不确认已读、不调用模型/工具。`create-agent-service.mjs` 已有参数接缝，故未修改。

首次目标测试 `npm test -- server/test/agent-instance-worker.test.mjs`：1/1 通过、0 失败/取消/跳过，1167.3705 ms，exit 0。有因加入“注册已提交但 ACK 丢失”场景后二次：1/1，1212.9613 ms，exit 0。账号入口接线后当前固定源码目标：2/2，0 失败/取消/跳过，1167.9246 ms，exit 0；记录的临时监听端口 9542、关闭后 active TLS sockets 0、两个 Agent child 均收到 close。独立类型 `C:\Users\admin\Documents\PromptCut\node_modules\.bin\tsc.cmd -b --force` exit 0。`git diff --cached --check` exit 0。以上均是本机临时证书/fixture，未运行真实模型或生产节点；没有独立全量 `npm test`，共享租约仍由根持有。

提交报告后又针对 CLI required 配置补了有因负例：`PROMPTCUT_ACCOUNT_V2_REQUIRED=1` 而 V2 关，及 V2 开但证书文件缺失，两个独立子进程都 exit 1、只写 `config.error`、没有监听或 `agent.ready`。随后的目标测试 3/3 通过、0 失败/取消/跳过，1397.6113 ms，exit 0；临时端口 2527，实际 TLS socket 0，两个 Agent child close。新增仅测试断言，生产源码仍为 `623d0941`；待提交此测试增量并纳入最终固定源码复核。

后续边界：中央 WS/LP 逐帧完整请求、连接 nonce/公开 connId、原 seq/ack 重试与实际 TLS capability 仍在中央窄核心设计/实现中；本叶未改 doc 核心、未复用已关闭 HTTP capability 充当数据写权限。跨重启对未确认 external side effect 不重放，旧实例资源缺实际 OS/cgroup witness 时 ACK 继续 pending。生产部署、证书文件路径、节点私钥隔离、真实模型输入及全量回归仍待根集成验证。
