# 实例数据通道最终冻结复核

工作分支 `codex/018-instance-data-final-review`，起点 `2485c6cc6153b9eb008a831948e665413f0de5f4`。本叶仅拥有本报告，源码只读；必要纯反例仅写系统 TMP，不启动服务、固定端口、全量或宽探针，不改 owners 的在途源码。

按根会话任务复核中央 d48（产品146d、074边界修复）及 worker Git对象 d8007be1/c695；沿旧 bf104 的 FIFO/current/ALS、LP授权先于缓存/ACK/lastSeen/关闭、resume、nonce和完整输入绑定反例追踪。中央首次7506与78c8真实目标失败原始证据保留；146d修正后的真实3/3与组件目标区分，不以旧fixture替代实际provider。

已遵循 AGENTS 入口、developer_guide、行为/约束与 verification/multi_agent 规则。此轮只读审查不授权实现、部署或主分支操作；实际OS关闭证明缺失仍保持pending。

当前尚无本轮结论或测试结果。

## 固定对象与结论

中央读取本叶固定 `2485c6cc6153b9eb008a831948e665413f0de5f4`，含 d48/产品146d/074。worker 只读 Git 对象 `d8007be1`（祖先 c695）和根追加的 `8ab9f11155ec6eb6dbd356505a4353d7257fd3d1`，没有导入 owner 的 WIP 工作树或改动源码。

本轮发现 **三个应先修的具体边界**：中央 LP close 不完整正文仍进入签名路径；worker 分片累计/控制帧/UTF-8 检查不完整；worker 8ab 建厂取消未覆盖 modelConfig/bind 的等待且存在未处理 Promise 拒绝。均已即时发 root 与对应 owner。当前不授予最终数据通道整体通过；这不否定中央146d已完成的真实3/3范围。

### 原审查项的收口情况

| 项目 | 本轮判断 | 证据边界 |
| --- | --- | --- |
| M1：完整 dispatch Promise 与能力生命周期 | 代码已收口。session 业务分支返回 router Promise；factory await 整个 ALS.run/next，finally 才 release；LP recv 返回 Promise 持续到 response finish/close。 | 真实中央146d目标覆盖正常provider通道；所有故障组合不由这条静态推理替代。 |
| M2：外围 FIFO/current | WS invocationTail 在鉴权前与 receive 前核当前transport；LP首proof之后才占sending，批内逐帧await并各核current。旧recv/close在异步鉴权后先核current，再ACK/换waiter/关闭。 | 同本轮冻结原模块纯控制证明旧recv/close均409、缓存仍1、新连接不关闭。 |
| M3：LP缓存与最后读权限 | recv的实际pull前再次lease.check，继而核fenced/dead/superseded/current，再同步pull/send。实际响应finish/close前cap未释放。 | 先读取body的未认证send不再更新lastSeen、占sending或登记会话资源。LP close还有下述F1。 |
| 原R1：send超限/空帧未认证副作用 | 已修复。声明超限/单帧超限413，空frames400，均不invoke、不ACK、不关闭session。 | 本轮纯原模块控制成立，不冒充mTLS验签。 |
| 原R2：旧recv/close在resume后操作新session | 已修复。current检查位于ACK/close之前。 | 本轮真实session/router/http模块，授权等待适配受控。 |
| 原R4：internal/proof尝试降级普通SID | 静态已修复。needsInvocation识别真实internal socket或proof/runGrant尝试，factory对非Agent principal拒run-principal-invalid。 | 公共无实例普通页面/LAN旧路径保留；未在本轮重跑真实mTLS负向。 |
| M4：fence先关闭读入口后await操作收口 | 已修复调用顺序。deliver在第一次await doc.fence之前同步调用service.fencePrincipals；onFence先消费已持久control。 | docRunClosures.complete仍false、agentState resource-closure-required；历史OS/cgroup资源不能据此ACK完成。 |
| M5/M6：同OS不确定ACK与不重复执行 | worker固定源码保存admit tuple；execution-started拒自动重放；finished只续原finish。原R3已改为先slot.finish再模型preflight。 | 新OS无旧RAM key/grant恢复授权；metadata pending不能替代readIntent恢复。未调用模型/工具。 |

146d将中央与worker动作分类收敛到完整消息名：project.open为read、project.op为write，selection.query独立authorizeQuery+read，scopedInput绑定完整actor/run/instance字段。没有为了让project.open通过而加write能读或放宽cap。中央原7506首轮3/2/1、4893.7788ms和78c8诊断3/2/1、5422.4829ms保留；原因instance-operation-forbidden。root已审146d真实3/3、7183.0952ms，日志 `%TEMP%/pc-instance-doc-data-central-{1,2-diagnostic,3}.log` 及对应exit.json。本轮没有重跑或用worker受控adapter替代该实际中央provider证据。

## 必须修复项

### F1：LP close未完整读取的正文降为签名空正文（中央）

`server/docservice/http-transport.mjs` 的 onClose await readBody 后，缺少 onOpen/onSend已有的 aborted/tooLarge检查。声明content-length4097、实际chunk4097及aborted均返回无text对象；仍调用dispatchInvocation，而factory以 `input.bodyText ?? ''` 构造签名tuple。受控授权next之后，三个实际原模块分支均回200并结束session。

这是完整实际正文绑定缺口，**不是无签名者可关闭Agent的证明**：真实factory仍要求该实例/该socket/nonce的合法空正文proof。最小修正应在invoke之前拒超限或终止aborted，不得拿空串代替未读完的正文；新负向应核不调用签名分派、不改变session/cache/lastSeen。root已明确安排窄修，本叶不改源码。

### F2：worker手写WebSocket解析边界（worker）

`server/agent-service/run-data-client.mjs` 固定d800以及8ab（后者仅改共享action helper，解析器未改）只对单帧检查8MiB。两个合法大小的5MiB非终结fragment累积10MiB仍全部保留，无总message上限；持续fragment可继续累加。fragmented pong、126字节pong、一字节close未报错；非法UTF-8字节0xff经Buffer.toString替换为U+FFFD后成为合法JSON交业务。

本轮直接执行导出的真实parser，只对网络socket/注册等待使用受控对象，无伪造真实服务身份。建议最小修正总分片字节上限、完整控制帧合法性、严格UTF-8，并保留合法ping穿插分片/正常文本和真实实际close回归。该项不是跨实例权限突破结论，但应在挂载自定义协议实现前收口。不要只靠单帧上限宣称消息内存有界。

### F3：8ab建厂取消覆盖不完整且产生未处理拒绝（worker）

`createExistingHostedRunnerFactory` 先await modelConfig；其后创建一个独立aborted拒绝Promise，又先await inst.bindAgent，直到下一阶段才把aborted接到link.ready的Promise.race。真实bindAgent含三个动态import，可异步让出。

执行Git对象的**完整原factory函数体**、注入受控modelConfig/inst依赖：

- modelConfig挂起时abort，factory仍pending，直到原依赖resolve才返回run-fenced。
- bindAgent挂起时abort，立即观察到真正`unhandledRejection('run-fenced')`；factory仍pending，直到原bind resolve才进入catch和closeOwned。

脚本专门监听unhandledRejection使反例能够记录，生产代码不因此被认为已有处理。该实验只证明Promise排序，不把受控close/drain次数当真实socket/OS关闭。修正应及时处理拒绝并覆盖建厂各等待；同时保留late-bind资源归属/关闭，不能简单race后遗弃稍后建立的连接。

8ab已正确增加manager的AbortController、取消后不执行检查、runner.drain优先与DataWebSocket.closeOwned等待；真实project.state已到达前的ready阶段取消目标证明了那一段。它没有覆盖上述更早modelConfig/bind等待。缺connectionsClosed/childrenClosed witness时仍报1，旧实例未知仍true，不能改成空活动表即完成。

## 无端口反例与原始结果

目录 `%TEMP%/pc-instance-final-review-2485-d800/`。中央三个模块从2485 Git对象导出；worker parser及闭包从d800 Git对象导出；8ab原account-runner另存用于提取完整factory函数体。不读绝对WIP模块、不修改导出模块。两条命令都显式设置cuda_Vit Python、PROMPTCUT_TEST_PYTHON、PYTHONDONTWRITEBYTECODE和静默preload。

| 命令/原始日志 | 首次结果 |
| --- | --- |
| `node <TMP>/counter.mjs` → `counter.log` | exit0，全部反例/修复控制断言成立；productionMounted:false、realMtls:false、networkListeners:0 |
| `node <TMP>/abort-counter.mjs` → `abort-counter.log` | exit0；exactFactoryBody:true、dependencies:controlled、realMtls:false、networkListeners:0 |

`counter.log` 精确输出：三个send控制分别413/413/400且proofInvocations0/sessionAlive true；旧close/recv均409/cache1/newTransportClosed false；三个不完整close均200/invocations1/bodyMissing true/canonicalBodyBytes0/sessionAlive false；fragment累计10485760>单帧8388608而errors0；三个非法控制帧errors0；非法UTF-8 messagesDelivered1/replacementCharacter true。

两次均为首次有因运行，未盲重跑；exit0表示发现问题的断言成立，不是产品通过。没有网络listener、模型、工具、固定服务或npm/full/probe。只读检索曾猜错run-data-client路径（实际在server/agent-service），随后用git ls-tree定位，没有执行不存在测试。新增TMP目录/文件仅本任务所有，未清其它任务数据。

## 签名、恢复和剩余实证边界

静态确认签名输入包含实际TLS exporter、当前cert/kid、authorityId/instance、method/path/operation、完整URL/protocols/body以及逐frame text（含seq/ack）/connId/nonce/frameIndex。握手cap不进入缓存principal；逐动作cap只在完整dispatch ALS内生效。初握手nonce按真实socket消费后转入connId集合，逐连接nonce在验签后首次await前claim；权限失败不回收nonce。resume另签当前socket、精确旧sid/ack和同grant/instance，再read核，之后才进入session.resume释放缓存/回放。

不是所有序列均已真实集成验证：两个resume并发、失败/并发nonce一次性、最后fresh-read与fence/private同时发生、异常socket关闭和Agent历史OS/cgroup实际inventory仍需最终目标。当前关闭证明的partial/pending边界正确，应保持。usedNonces长期容量/会话清理是后续压力观察项，不能为了省内存提前清表开放重放。

worker升级成功后以实际socket.close发关闭事件；LP等待socket close（没有socket时等request close），closeOwned会等待其关闭事件。升级前只依据ClientRequest close、没有独立登记TLS socket close这一点，本轮仅列证据边界，未凭静态猜测宣称发生残留；若要给全资源关闭receipt，应以真实pre-upgrade失败/取消目标核对两者，不能用openCount0代替外部witness。

报告提交后本叶保持clean、停止审查并释放slot。未修改owner源码，未执行types/full/服务/节点/部署。本轮建议先按F1–F3窄修，再由root给新固定hash复核；C10 particles实际判重另等其独立窗口，与本审查不混算。
