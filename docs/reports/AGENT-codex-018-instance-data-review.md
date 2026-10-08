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

## 固定数据通道增量复审（cc5465a8 / cc1bac0f）

根再次授权在同叶只读审查。本轮只读中央 Git 对象 `cc5465a8eeb5edffca14ddabf23e8a0c40616e59` 和 worker Git 对象 `cc1bac0fcde54b90b74e5c8a99d04451118aadab`（实际 ACK 源码为其祖先 `d5d7de676fc6d91be98ee302f5ea4192c8f1bfde`）。没有借 owner 后续工作区修改验证，也没有写任何产品源码。

### 原 M1–M6 的判定

| 原项 | 固定源码复审结果 | 边界 |
|---|---|---|
| M1，完整异步 dispatch 能力生命周期 | 已解决该源码缺口。session 的三条业务分支返回 router Promise；factory 在 ALS.run 的完整返回 Promise 结束后 finally release。纯控制组验证普通业务 receive 返回 Promise，模块恢复时 cap 仍 live。 | 不是最终真实 mTLS/project.op 成功证明；真实各分支与 production gate 仍由 owner 的集成目标验证。 |
| M2，外围 FIFO 与旧传输 | WS 已落 invocationTail，鉴权前及 receive 前各核 isCurrent；LP send 在 t.sending 内逐 frame await，且在 await 后 receive 前核当前 t。 | LP recv/close 仍缺授权 await 后、修改会话前的当前 t 检查，反例见 R2。不能把 M2 整项记全过。 |
| M3，LP 延迟 read 与缓存 | recv 的 returned Promise 现在等 res.finish/close；timer/wake 的 respondRecv 在真正 pull 前再次 lease.check，随后核 fenced/current。代码消除了原提前释放 cap 的缺口。 | fresh pull 检查发生在 receiveAllowed 的 ACK/替换 waiter 之后，不能挽回旧请求已造成的副作用；send 还有 R1 未认证分支。 |
| M4，同步关闭先于收口等待 | 已落。deliver 在第一次 await doc.fence 前调用 service.fencePrincipals，该调用同步建立入场/session/cache 屏障并启动实际 socket 关闭；onFence 先从持久 control 发起 deliver，再 synchronize。 | 完整 Agent/历史 OS 资源关闭仍 pending；record.complete 明确 false，没有冒充全部退出完成。实际 transport 关闭与长 seal 并发仍需最终集成实证。 |
| M5，同 OS admit ACK 不确定 | 已落原 requestId 与 grant 的 RAM slot；失败不丢 tuple，后续 wake/resumeQueued 使用原 slot；新 OS 没有继承旧 RAM key/tuple 的机制。 | 已读 owner 两项真实 SQLite + 签名适配 fixture；本轮没有重跑，也不将其称真实 mTLS 数据通道。 |
| M6，finish ACK 不确定不重执行 | 已落 finished → 原 finish:<grantId> 续办；execution-started 明确 run-execution-uncertain，不自动重做模型/工具。 | 还需 R3：finish 续办前的模型 preflight 会在模型配置消失时阻断不需模型的完成重试。 |

### 必须修复的剩余项

**R1 — LP 未认证 send 仍能操作 Agent 会话（中央 owner）。** `http-transport.mjs` 固定对象的 458–477 行在 invoke 之前处理 body.tooLarge / 超大单帧，两处都调用 sessions.close。持有 SID 的请求尚未证明实例私钥、当前 socket 或 read/write 权限，就可结束合法会话。空 `frames:[]` 也完全跳过 invoke，直接 takeAck 并返回 200。应对未认证超限仅拒绝本次请求，不据此关闭会话；空 batch 要明确拒绝或有独立已验证 read 操作，不能以循环零次自然绕过认证。保留原普通页面/LAN 协议规则由 owner 精确区分，不削弱其它超限标准。

**R2 — LP 旧 recv/close 在 resume 后仍修改新会话（中央 owner）。** `receiveAllowed`（504 行起）在清旧 waiter 与 sessions.ack 前没有检查当前 transport；onClose 的 next（560 行起）也没有。请求可先取得旧 t、停在异步授权，另一次合法 resume 替换 t，然后旧请求继续执行。真正的 sessions 反例证明：旧 close 把新传输关闭；旧 recv 先释放未确认缓存，最终 respondRecv 才以 409 拒绝。应在这些副作用之前重新核当前 t/fenced/dead；拒绝旧请求不能删除新会话缓存、关闭新连接或替换其 waiter。send 已有的检查应保留。

**R3 — 无模型配置阻断 finish 续办（worker owner）。** `account-runner.mjs` 的 182 行 preflight 在 183 行 slot.finish 之前。模型/工具已完成、doc finish 已提交但 ACK 丢失后，如模型配置撤去，下一 wake 以 no-model-key 退出而不再发送原 finish。此阶段无需新模型，应该先续已确定的 finish，再在新 admit/执行前做模型 preflight；仍由原 finish API 核实例与 grant，不能绕过失权检查。此结论是固定源码控制流审查，未执行真实模型；已发 worker 请求窄修及相应回归。

**R4 — Agent 尝试不能经非 Agent cached principal 降级（中央需确认并补负向）。** service 的 dispatchInvocation 与 LP invoke 只依据 cached principal 的 realm/role 决定是否调用 factory。resume 本身不经过 transportAuthenticate。于是 internal Agent mTLS 或带 instance proof 的请求若定位普通 page/LAN SID，当前分支会直接用旧 SID resume，跳过 factory 的 internal/proof 检查。按根明确的“Agent cert/proof 无效不可 fallback 到 legacy”，应在实际内部/实例尝试入口识别并拒绝主体不匹配；保留普通公共 page resume。这里是静态分支证据，尚无真实 mTLS 攻击复现，不把它写成已部署泄露。

上述项已即时发 owners 并抄 root。owners 的后续修正不包含在本报告固定对象的通过结论中。

### 本轮无端口反例及原始结果

只从中央固定 Git 对象导出 `session.mjs`、`router.mjs`、`http-transport.mjs`。脚本使用真实三个模块；req/res 和授权等待为受控 EventEmitter/Promise，不启动网络或冒造真实 mTLS。

- TMP 目录：`%TEMP%/pc-instance-data-review-cc5465-013c5e31640a4187b58731c991591dd8/`。
- 脚本 `counter.mjs`，最终原始结果 `counter.log`，第一次原始结果 `counter-first.log` 均保留。
- 两次命令均 `node <TMP>/counter.mjs`，均 exit **0**；这是纯脚本而非裸 node --test。显式 cuda_Vit Python 环境、PYTHONDONTWRITEBYTECODE 与静默 preload。没有 listener、child、模型、工具、服务或固定端口。
- 第二次有因修正反例脚本的观测：第一次把 fresh.closed 数组引用留到最终打印，cleanup 又追加自身关闭记录。改为 structuredClone 当场快照，保留原始首日志；产品模块及所有判定断言不变，不是产品失败后赌绿。

| 反例/控制组 | 最终实际输出 |
|---|---|
| 超大 body | status 413；proofInvocations 0；sessionAlive false |
| 超大单帧 | status 413；proofInvocations 0；sessionAlive false |
| 空 frames | status 200；proofInvocations 0；returnedAck 0 |
| 旧 close 授权等待期间 resume | status 200；sessionAlive false；新 transport 收到 close 1000 |
| 旧 recv 授权等待期间 resume | status 409；sessionAlive true；缓存从 1 条变 0 条；新 transport 当时未被关闭 |
| 修后 session Promise 控制组 | returnsPromise true；capLiveAtModuleCompletion true |

`exit 0` 表示反例及控制组与断言一致，不能写作 R1/R2 已修复。日志明示 productionMounted:false、realMtls:false、networkListeners:0，不含 SID/key/proof/exporter/账号凭证值。

只读检索期间两次猜测 account runtime 文件名、一次猜测 ACK test 文件名不存在；随后用 Git 路径清单与 git grep 找到真实 `docservice/account-hosted.mjs`、`agent-runner-ack-recovery.test.mjs`。这些是只读命令路径错误，没有执行不存在测试或修改源码。

### 签名、nonce、恢复与尚待实证

固定 factory 静态已绑定真实 req.socket exporter、当前 cert/kid、authorityId/instanceId/generation、method/path/operation；connection request 包含实际完整 URL、原始 websocket/http/fallback 协议头和 LP 原 bodyText，LP 合成 sec-websocket 头前另存原头。frame request 包含可信 project/grant/connId、nonce、kind、完整 text（含 seq/ack）、LP 原 bodyText/frameIndex，action 由实际 type 分类，与 account-hosted 当前分类一致。selection.query 要两份各自精确 checkAccess(read)/authorizeQuery proof。握手 cap 在 finally 释放，只缓存基础 socket subject 与可信 grant/actor；cap 不在 principal/network 中作为长期授权。

初握手 nonce 在验签后按真实 socket 消费；连接建立后将初值记入该 connId 集合。逐帧与 resume nonce 在各 proof 验签/实例匹配后、首次 await check 前同步 claim，后续权限失败不回收已 claim 值。resume 证明覆盖真实 sid/ack 与相同实例/grant，新 TLS socket 必须重新签名。并发 nonce 同值一次性、请求重排、初握手到 connId 关联、双 resume、错误实例、错误 exporter、伪 headers/protocol/url/body、无效 proof 不得 fallback、签名失败不影响旧合法会话，仍需最终固定生产 factory + 真实 mTLS WS/LP 目标；本轮不以源码推理替代实证。长生命周期 usedNonces 的容量/会话结束清理属于后续资源压力检查，不能用提前清表放开重放。

transport ACK 仍不代表 project.op 持久 OK；发送方须保留原业务 opId/requestId，并以业务响应/历史解析不确定性。worker 的原 tuple 修复只解决 admit/read/finish 阶段，不能据此宣称 WS 业务 ACK 全部收口。私有/stop/fence 的真实退出、缓存零新字节、所有历史 Agent 子树/socket 关闭证据仍待最终集成与 root 部署侧提供。

本轮是只读源码审查与纯反例，依根租约没有运行 types/full/固定服务/宽探针，没有新增生产代码。原三个已确认缺口得到部分修复，R1/R2 仍被真实模块反例证实；因此不授予此固定数据通道整体通过结论。
