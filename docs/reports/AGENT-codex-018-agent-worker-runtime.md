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

## RAM session 首块

root已将run-client租约更正为真实 `server/agent-service/run-client.mjs`。Astra确认challenge附精确rootScopeRef及双摘要，原publicKeyDigest仍PEM；result附原ref且instanceId来自可信rootrecord。prepare签 `Buffer.from(digestOf(payload))`，terminalReceiptDigest为完整signedprepare摘要；原Doc注册PoP签canonicalJson不变。

角色进一步澄清：scope `record.instance.clientFingerprint256` 是root-controller→worker identity RPC的客户端证书，不是worker→Doc客户端证书。Doc另配workerServiceKid/workerFingerprint256核真实transport；DER/PEM同key关联两通路，两个pin不得强行相等。worker entry/gateway后包必须独立配置这两个证书身份。

新增纯专属session目标首红4tests/0pass/4fail/82.244ms，exit1，均为尚无scopeIdentity；TMP `pc-worker-session-first.log`保留。没有业务listener，npm原globalguard照旧。本轮修session实现公开两种编码/key摘要、可信rootrecord注册绑定、assignment精确绑定、prepare私有source+完整域/tuple、原Docterminal与intent核验；source失败/变内容/多调用竞争不得签冲突prepare，无closed/counts/rootwitness伪声明。Doc/root真正注册reader装配仍等待Astra模块，此纯目标registration/OS/localdrain是受控adapter，Ed25519签名是真实，不称production链。

固定首块源码 `c2b820ca5d43777716e48cbf392edc74a88ecffa`：5个新session目标与既有scopecore合计50/50，0fail/cancel/skip，304.6914ms（外层约569ms），npm exit0，TMP `pc-worker-session-c2b820ca-target.log`。目标覆盖同RAMkey的两种编码、rootref/摘要/instance混配拒绝、prepare前置/source失败和冲突、Doc签名终态/原intent验证。无业务listener；scope原CLI负向owned子进程等待close，没有运行root或worker服务。

类型第一次命令误用本worktree不存在的 `node_modules/typescript/bin/tsc`，exit1/ERR_MODULE_NOT_FOUND，日志 `pc-worker-session-c2b820ca-type.log`保留；属于启动路径错误，未进入TS检查。改用已有父仓库绝对TypeScript路径 `tsc -b --force` 后exit0/零错误，工具wall7333ms，日志 `pc-worker-session-c2b820ca-type-2.log`。未装依赖/建junction/更改全局环境。session nodecheck/diffcheck0，验证期间源码固定，无重跑target。

当前真实exports为 `scopeIdentity/configureRegistrationScope/bindScope/scopePrepareFor/scopeIntentFor`。configureRegistrationScope必须在PoP注册开始前以可信expected/record调用；bindScope核signedassignment完整target与已注册身份。prepare签名域与intent签名域都用scope digest算法，Doc PoP原canonicalJson算法保持。生产source仍未挂，缺scopePrepareSource拒503，缺Doc新register/bound gate也不执行；这个提交仅可独立审RAM身份与签名块，不是完整worker/gateway/FIFO交付。

## run-client 窄消费接口

Astra约定 `POST /internal/v2/runs/assignment` exact六refs `{projectId,conversationId,messageId,runId,runGrantId,requestId}`，独立signed operation `scopeAssignment`；Doc每次rootreader核bound才回executionAllowed。session仅对这条exactpath/exactbody签新op，resolve/read/write proof不能替代；原其它op不改。run-client沿原真实secureConnect/exporter路径发送，透传上述五个RAM接口，不另生key/实例；不允许body自报instanceId/身份。

本块仅消费者接口，Doc新路由/source尚待Astra固定；尚无正常成功闭合或单任务worker服务监听。

固定 `cd90cc13676824de8989aa91367e744b3cd63700` 的专属7/7、0fail/cancel/skip，106.5577ms/exit0（外层344ms），TMP `pc-worker-session-cd90cc13-target.log`。新增op fullbody签名反向使用受控exporter、真实Ed25519，不计实际TLS。未重复已过scopecore/type，也未启动业务服务。

## 指定单任务 manager 接缝

task只接受projectId/conversationId/requestId，不能携grant或instance身份。必须有私有assignmentReady、durableevent sink与onTaskDrained；领到原workergrant后先等bound完整tuple，才准备readIntent和调用factory。仅一次指定admit；没有跨对话pending扫描、第二次领队列、legacyfinish或后台自动重试定时器。此时终态仍pending，第二条消息必须留DocFIFO，不在本包改finish协议。

单任务drain hook等待实际runner drain/close和event flush，分别给local-drained/unknown与durable/failed分类；不产生root witness/complete。close异常保留并监督所有本task清理，hook失败不能遗留active逻辑状态。默认旧多任务fixture路径不变。assembly在注册前配置可信rootrecord，task模式用remote sink、无周期resume，仅一次工作Promise且保持completionReady:false；实际Doc/worker入口将在固定依赖收回后验证。

固定94cf首目标出现两项accepted-message-record：新test复用旧runFixture.enqueue，其Docseed缺createdAt与selectionSnapshot.messageId，真实FULL事件镜像在runner前拒绝。首log `pc-worker-task-94cf0321-target.log`保留。仅补新test中这两个真实conversation.send本会持久的字段；不改oldfixture/生产校验/既有测试。该窄修有因复验，不能把旧通过项套给修后源。

修fixture固定9752f5c5后8/8、0fail/cancel/skip、257.2992ms/exit0（外层517ms），TMP `pc-worker-task-9752f5c5-target.log`。包括旧read/ACK丢失回归5项与新task3项；真实SQLite/FULL/eventcrypto，assignment/model为受控，不计真实OSworker。

只读发现Hosted factory显式参数列表会丢task四接口；root已窄扩 `create-agent-service.mjs` 仅四参数解构/传原accountRunner，不改LAN/default。新实际factory调用回归同时核singleTask参数真正到manager、durableevent/drain hook被调用及旧default仍非task，而不是只看manager纯目标推断assembly挂通。

新增factory目标1e4首4/3/1、252.6671ms，因test传空conversationClient被原构造守门503正确拒；TMP `pc-worker-task-1e4c46a0-target.log`保留。测试改为具备原必需方法且调用一律throw的human-client adapter；本测试不做human读，不能用freeACL代替真实服务，也不改生产constructor。

固定5324874d目标4/3/1、271.7113ms，实际factory/单任务断言都已到达，但fixture清理顺序失败：早登记setup after hook先rm父目录，较晚登记Hosted service close尚未关闭自己的SQLite handle，Windows实际EPERM。TMP `pc-worker-task-5324874d-target.log`保留，不拿断言成功算通过。改新测试为本体try/finally先await实际service.close，再运行setup后置清理；不吞EPERM/改重试次数/改产品关闭行为。
