# 单任务worker的Doc分配与真实关闭接线

开工基线：cc7303611f5de9b79f5680b89c733fc42aad44b0，分支codex/018-agent-worker-doc。旧c705/2d分支只读，不整包合入。根已实测scope首包Linux10/10；本包仍需真实Doc签发、实际worker消费者和root关闭链配对，不能套用该结果为业务完成。

范围按根精确租约：Doc run/instance authority及internal、必要doc-agent assembly、新agent-run-scope-doc；scope schema/reader/publisher的typed forced/unassigned增量及专属测试/既有scope增量。Sol独占session/run-client/runner/executor/events/main；不改UI/Asset publisher。若runtime原语确需扩展先列精确缺口交根。

首阶段：显式证明Doc规范PEM与scope规范DER来自同一Ed25519公钥，保留两种原摘要域；root ready记录与实际worker注册绑定，assigned-unbound只能取得Doc assignment，不得read/execute，真实root bound之后才放行。controller身份RPC的TLS证书与worker→Doc出站证书是两个角色，不能混用。

第二阶段：normal before-death prepare签名→Doc实际read/data关闭→Doc terminal→原RAM intent→root原FD实空→Doc可信reader导入与FIFO finalizer。forced和unassigned独立类型，不补死worker签名、不把未知资源算空。保留retained政策、并行conversation和完整原grant/currentRun绑定。

所有首次失败保存TMP。仅授权专属目标/类型及6712–6721自有mTLS窗口；不开full/浏览器/模型/节点。生产尚未挂载，报告逐项区分纯schema/SQLite/受控TLS/实际root Linux证据。

## 第一块：公钥映射与assignment执行门

服务端`agentScopeKeyMapping`从实际Ed25519公钥规范导出PEM/DER，Doc原publicKeyDigest仍digestOf(PEM)，另scopePublicKeyDigest=digestOf(DER base64)，仅同公钥字节相等才关联。challenge可选rootScopeRef exact4；启用scope模式时缺ref拒绝。root控制面identity RPC的clientFingerprint256不充worker Doc客户端pin，slot另配workerServiceKid/workerFingerprint256且逐次核trusted transport。

注册从完整root链ready取instanceId，同request同key可幂等；admit在同SQLite事务生成assignment并占原currentRun，root真正bound以前confirmRead拒绝且无receipt，query/check同闸。独立`scopeAssignment`operation及`/internal/v2/runs/assignment`只返回原tuple签名记录/执行门状态。持久required重启后缺模块拒绝；root锁/失败refresh清旧缓存。第一块normalfinish暂明确503，不能沿旧main finish直接done释放FIFO；后续同本包接三段终态，不以此pending当整体完成。

验证首轮原始日志：TMP `pc-worker-doc-assignment-target-1.log`，3/3、0fail/skip、153.5352ms；为真实SQLite/签名/完整root链校验器，rootOS与transport是明确受控模型，非TLS/OS证明。首回归TMP `pc-worker-doc-assignment-regression-1.log`，78项/77pass/0fail/1skip、627.0225ms；唯一skip未配置actual VH provider，保留该首次结果，后续显式配置再验。未业务监听/full/模型/节点。

## 第二块接口与首个有因失败

根窄扩已交接：master采用独立实际mTLS pin/kid，登记purpose=control-only，只允许conversationControlSubscribe/conversationReadOpen/conversationReadClose/conversationControlAck及pendingRuns；worker mandatory rootScopeRef且purpose=run-worker。不能用缺ref推master，scope配置同pin或同kid拒绝。pending在新模式需原RAM签名；未启scope旧模式保持。

typed forced-terminal需Doc签名完整assignment+持久fence引用，intent必须null；unassigned-retirement只可ready且无assignment，root可信文件记录不表示任务完成。两类closed有独立protocol，完整历史允许无bound阶段的retirement；normal原结构/签名不变。共享Asset原语仅固定Agent endpoint允许显式allowDeadMain，Asset默认及Asset用途传true均拒；死主分支核boot/scope/原service inode/Invocation/MainPID0/旧birth消失及loaded drop-in前后相同，随后复用原固定eventsFD空证据。实际Linux尚未跑，纯模型不能替代该证据。

首typed/兼容回归TMP `pc-worker-doc-lifecycle-target-1.log`：163项/162pass/1fail/0skip、651.2879ms。唯一失败为actual account fixture要求两条显式路径，我仅配置provider未配PROMPTCUT_PASSWORD_ORDER_MODULE，尚未进入该项业务；原失败保留，补真实order绝对路径后有因复验。eca3类型首轮exit0（8.10秒，TMP pc-worker-doc-assignment-type-1.log）；本增量需固定后重验类型。没有full/真实TLS/节点。
