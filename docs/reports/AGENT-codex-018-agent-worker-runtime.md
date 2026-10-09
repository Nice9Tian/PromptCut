# 独立任务 worker runtime

## 开工与独占边界

root 在已核干净的原物理工作区将分支切为 `codex/018-agent-worker-runtime`，固定基底 `cc7303611f5de9b79f5680b89c733fc42aad44b0`。不自行合 main、清工作区、部署或访问真实凭据。

本阶段按前包 `554f2d82` 与 Astra `2d063550` 三级交接机制，先实现可独立审的 RAM key公开身份/prepare/intent，再接单任务 worker、master事件writer和gateway。master不领grant再transfer；worker同一个不可导出RAM key贯穿rootidentity、Docregister、read/data/tool。缺assignment-bound/forced/unassigned/finalizer配对时生产入口保持关闭，donePromise/网络200/root计数都不充完成。

租约为 `server/agent/service/agent-instance-session.mjs`、`account-runner.mjs`、`account-run-events.mjs`，`server/agent-service/account-executor-assembly.mjs`，新增 `account-task-worker.mjs`、`account-worker-gateway.mjs`、`worker-event-internal.mjs` 与专属test/fixture/probe、本报告。实际 run-client 在 `server/agent-service/run-client.mjs`；已向root报告更正租约路径，确认前不改它。Doc/provider/schema/reader/publisher/UI/main/assets不在本叶改动范围。

## 首块接口与证据边界

〔裁〕保留Doc既有 `digestOf(PEM publicKey)`；公开rootscope key使用 `SPKI DER base64` 及其独立 `scopePublicKeyDigest`。两个编码摘要不能相等替代，必须解析并转换核同一个底层Ed25519公钥。私钥不export、不写文件、不经master签名。

拟session `scopeIdentity` 只公开公钥/两摘要/已注册identity；`scopePrepareFor` 与 `scopeIntentFor` 分域且内部核注册身份、完整target/原assignment/Docterminal签名。prepare只表示真实持久事件与本机drain准备，不表示OSclosed；normal intent仍按原scope schema签摘要。controller入站rootclient证书和worker出站Doc证书/pin独立配置，不复用实验rootclient作为Doc身份。

已向Astra约固定Doc注册rootScopeRef、assignment-bound和prepare schema；未获源码/接口前相关调用保持缺配置拒绝，不能造自由allow或body instance凭据。单任务仅指定project/conversation/一次admit，事件flush/drain失败监督，不继续下一model/tool/finish。

## 验证计划及当前状态

端口6700–6711由root租本叶，首次业务fixture前完整查空；占用只报告、不杀其它进程。专属纯目标走既有npm wrapper，隐身preload/process-only cuda/models/provider与唯一PSModulePath；不裸node--test、不装依赖、不全量、不生产模型/节点。实际TLS/worker/完整Editor仅固定源码后按窗口执行，首红及实际资源close全部保留。

本开工提交仅报告，尚未实现/验证新runtime；上包root type/full/Editor/Linux证据不套给本阶段。现有真正factory与持久events保持原样。
