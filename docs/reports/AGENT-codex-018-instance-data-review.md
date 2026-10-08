# 实例 WS/LP 数据通道独立审查

- 工作区/分支：`018-instance-data-review` / `codex/018-instance-data-review`。
- 起点：`2f6dfd1953a5d723a9483704de9fae24f3abc145`。
- 独占仅本报告；其它源码只读，特别是已验证实例权威及中央、worker 消费者均不改。
- 审查范围：真实 mTLS exporter、握手与逐帧能力范围、same-instance recovery、nonce/seq/ack、ALS 队列生命周期、缓存帧回放、失权屏障与真实关闭证据。
- 已读 AGENTS 入口及开发索引、约束、行为规则；适用已定可信 read/run、恢复与停止语义，不另造产品行为。

当前阶段只读审查，尚无新测试结论。共享 full/固定服务/宽探针无租约，不启动；必要纯反例仅写系统 TMP。报告将区分必须修复、待实证与可后验证，记录实际读取的源码点，未固定的在途代码不作冻结通过结论。

## 本次审查结论与固定对象

本报告是数据通道挂载前的机制审查，不是 WS/LP 成品通过验收。以下问题已直接交中央 Sol、worker Sol 并抄 root；两位 owner 保留源码独占，后续固定实现需另行复审。

- 中央只读固定对象：`018-agent-instance-doc@f45c912bfc80f6bbd2f9dbb8056916f974730ae7`。其 HTTP 注册/admit/read/query/check/finish 既有目标 3/3 为 owner 提供的结果，本审查没有冒充独立重跑。该固定点的数据通道仍 fail closed，不能把下面接线风险描述为已上线越权。
- worker 固定对象：`018-agent-instance-worker@a5f02082136c8f7f12e6697e59426ad8a77c0d15`。审查时仅 main 接线在途；`account-runner.mjs` 和 HTTP client 的上述固定版本只读。
- 中央开始编写的 service/session/http-transport 差异只作为提前指出接线位置的材料；本报告不把未固定差异列为已验证源码。
- 实例权威及其 a50/6e 最终验证保持冻结，未修改。

## 必须修复或落地的边界

| 编号 | 必须项、精确位置与原因 | Owner / 状态 |
|---|---|---|
| M1 | `session.receive` 的 legacy、坏 JSON/无 type、普通业务三条 `router.dispatch` 分支必须返回实际 Promise；最外层 dispatchInvocation/ALS 要 await 完整 session → router 排队 → gate → module → coordinator，再 finally release 全部 cap。真实 router 本身保留排队的 ALS 上下文，不需要为此改路由产品语义。 | 中央 Sol 已收到，正在其独占叶接线；尚未审最终 diff。 |
| M2 | 同一连接的外围异步签名/权限核验也要 FIFO；仅 router 内部排队不够，因为 session 在 router 前消费 seq/ack。seq2 核验先完成可将有效会话误关为 bad-seq。WS 和 LP 都要在进入 hook 前、await 后实际 `sessions.receive` 前核 `sessions.isCurrent(connId,transport)`；resume 后旧 socket 的缓冲事件/已排队工作不能继续操作新会话。 | 中央 Sol 已收到；实际受控反例已证明。 |
| M3 | LP `onRecv` 登记 waiter 后立即返回，后续 `wake`/timer 才 `respondRecv`。不可仅入口 read 核验后释放 cap，再晚些时候无当前权限吐缓存；read 授权生命周期必须覆盖实际回包，失权后不可再 pull/flush。先认证再修改 ack、替换旧 waiter、close；无效 resume 只能拒绝新传输，不能凭持有 SID 结束合法旧会话。 | 中央 Sol 已收到；需其实际 LP 延迟 recv、失权夹缝目标证明，不以本报告当通过。 |
| M4 | 固定 `doc-agent-assembly.deliver` 当前先 await `doc.fence`，后 `service.fencePrincipals`。pending seal 收口期间不能留旧 Agent 的缓存/等待流继续读。应先发起同步 transport admission/session/cache 屏障，再 await 操作收口与真实 close；该 service API 在首 await 前建立屏障，调用次序可窄改。`onFence` 的前置 synchronize await 亦不可留下读窗口，或必须另有实际出站前同步 ledger 判据。 | 中央 Sol 已收到；这是接通 WS/LP 前必须完成的顺序约束。 |
| M5 | worker `wake` 每次生成新 UUID admit；doc 已持久 preparing 而 ACK 丢失时，`waking.finally.delete` 遗忘原请求，下一 wake 只能新 requestId → run-not-ready。同 OS 必须保留未确定 admit 的原 requestId/实例并重试原幂等操作；新 OS 不可继承旧 grant，metadata pending 不可代替 recovery API。 | worker Sol 已确认缺口，将在其 account-runner 租约内修并补真实 SQLite/丢响应目标。 |
| M6 | 已完成本机 `executeOnce` 后，finish ACK 不确定时只续原 binding/派生 finish request，不能回到 `processGrant` 重跑模型或外部副作用。`execution-started` 仍保持原禁止自动重放规则。 | worker Sol 已确认补 finish-pending 续办；尚未审最终源码/原始结果。 |

以上不修改用户的共享已读例外、私有优先、FIFO、退出完成点或原始操作幂等语义。特别是 session ack 只表示按序收到，不是 project.op 已持久接受：worker 必须等业务 OK/错误或用原 opId/requestId 查历史/恢复，不能收到 transport ack 就宣告工具成功，也不能因为业务 ACK 丢失换新 opId 重做外部效果。

## 无端口原始反例

只从 **Git 对象 f45c912b** 导出 `server/docservice/session.mjs` 和 `router.mjs` 到系统 TMP，再用原模块执行，不读取 owner 正在修改的文件作为实验源码。

- 目录：`%TEMP%/pc-instance-data-review-40769ae2c09d487ab7c0d270fafa65f3/`
- 脚本：`counter.mjs`；冻结对象副本：`session.mjs`、`router.mjs`；原始结果：`counter.log`。
- 命令：`node <该目录>/counter.mjs`，exit **0**；不是 node --test。进程显式 cuda_Vit Python 路径、`PYTHONDONTWRITEBYTECODE=1`、静默 preload。无网络 listener、无服务、无模型/工具调用。
- 日志明示 `productionMounted:false`、`networkListeners:0`，仅输出布尔值/序号/关闭原因，不含 key/proof/exporter/token。

| 受控观察 | 实际输出 | 含义 |
|---|---|---|
| 原 session.receive 返回值 | `receiveReturnsPromise:false` | 外围 await 并未等待模块 Promise。 |
| 模块挂起时读取 transport ack | `ackBeforeModuleCompleted:1`，`moduleDoneAtAck:false` | transport ack 与业务持久完成不是同一事实。 |
| 外围 finally 释放后恢复原模块 | `capLiveWhenModuleResumed:false` | 仅外包 ALS、不返回 session 的完整 Promise 会提前释放。 |
| 第二帧异步授权先完成 | 实际 close `{code:1002,reason:'bad-seq'}` | FIFO 必须覆盖 session 之前的异步调用。 |
| resume 后旧 transport 回调仍直接 receive | `supersededCallbackReachedModule:1` | same-instance proof 不能替代当前 transport 判断。 |
| 控制组直接 await 原 router.dispatch | 两条记录分别 `context:first/second`，`live:true` 且顺序 1/2 | 原 router 队列可正确保留各自 ALS；缺口在外围 Promise/队列边界。 |

上述是成功复现不满足目标的反例，exit 0 表示反例断言成立，不表示数据通道已经修复。没有运行共享 full、固定端口目标或宽探针。

## 方案认可部分与后续实证清单

当前协议方向可保持：真实内网 Agent mTLS exporter；握手 GET 全 query/protocols、LP POST 全正文签名；主体由当前证书及持久实例/grant 构造；握手 cap 最终 release，不进 cached principal。SID/公开 connId 只是定位，resume 必须同实例/同 grant、新 socket 新 proof，并在缓存回放前重核 read。public nginx 没有可信 exporter、证书/proof 无效时 fail closed，不 fallback 到 legacy。

逐帧必须签完整 frame（含 seq/ack）、可信 project/grant、公开 connId、nonce、method/path/op/action。action 由实际帧语义派生，不能用 body 自报 read 使 project.op 得到读能力。selection.query 的 authorizeQuery 与 read 检查使用各自精确 proof；不得把 metadata/resolve 能力扩成 write。nonce 验签通过后在第一次异步让出之前原子 claim，授权失败后也不复用；并发同 nonce 只能有一个获准进入。重发使用原业务 frame/opId/seq 与新 nonce/当前 socket 新签名，不能重发旧 exporter proof。

后续成品必须以真实 mTLS WS/LP 验证：新/旧 socket、同实例重连与新 OS 拒绝、SID 泄漏不能 resume；seq/ack/control/recv/close 均完整认证；并发 frame/FIFO 与 ALS 跨等待；长轮询 waiter 被 revoke/private/stop 打断时零新字节；缓存重放前的有效读权限；双 resume 与旧 transport 迟到事件；nonce 同时使用和已失败 nonce；业务 ACK 丢失同 op 幂等。非安全门槛的吞吐/缓存容量压力可在功能与失权边界成立后验证，不通过增加 sleep/放宽完成标准代替上述证据。

实例 fence 的 `control.instances`（含零 grant 实例）与真实 OS/cgroup/children/socket inventory、完整 close receipts 仍须 root 部署侧证据。不得以新实例注册、空 active map、metadata pending、dispatcher 数量自报零或超时报告完成；保留 retained 当前共享轮也不能宽免其它旧授权。中央目前记录 partial closure/pending 的做法应保留到真实证据接齐。

## 交回状态

只提交本报告，无源码跨写、无依赖/系统/节点/部署变更；原实例权威和两个 owner 工作区均未写。必须项已即时发给 owners 与 root。root 要求此阶段收口释放 slot，待两位 Sol 固定数据通道源码后再派独立 diff/实证复审；本报告不授予最终数据通道通过结论。
