# 单任务worker的Doc分配与真实关闭接线

开工基线：cc7303611f5de9b79f5680b89c733fc42aad44b0，分支codex/018-agent-worker-doc。旧c705/2d分支只读，不整包合入。根已实测scope首包Linux10/10；本包仍需真实Doc签发、实际worker消费者和root关闭链配对，不能套用该结果为业务完成。

范围按根精确租约：Doc run/instance authority及internal、必要doc-agent assembly、新agent-run-scope-doc；scope schema/reader/publisher的typed forced/unassigned增量及专属测试/既有scope增量。Sol独占session/run-client/runner/executor/events/main；不改UI/Asset publisher。若runtime原语确需扩展先列精确缺口交根。

首阶段：显式证明Doc规范PEM与scope规范DER来自同一Ed25519公钥，保留两种原摘要域；root ready记录与实际worker注册绑定，assigned-unbound只能取得Doc assignment，不得read/execute，真实root bound之后才放行。controller身份RPC的TLS证书与worker→Doc出站证书是两个角色，不能混用。

第二阶段：normal before-death prepare签名→Doc实际read/data关闭→Doc terminal→原RAM intent→root原FD实空→Doc可信reader导入与FIFO finalizer。forced和unassigned独立类型，不补死worker签名、不把未知资源算空。保留retained政策、并行conversation和完整原grant/currentRun绑定。

所有首次失败保存TMP。仅授权专属目标/类型及6712–6721自有mTLS窗口；不开full/浏览器/模型/节点。生产尚未挂载，报告逐项区分纯schema/SQLite/受控TLS/实际root Linux证据。
