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

修后固定 `c215bfccfbcba20a69d82924f0f891cc8f17c84c`：新task4与旧read/ACK5合9/9，0fail/cancel/skip，305.0308ms/exit0（外层527ms），`pc-worker-task-c215bfcc-target.log`；强制类型exit0/零错误、7271ms，`pc-worker-task-c215bfcc-type.log`。均无业务listener，使用真实SQLite/原factory调用接线/受控assignment与模型，原旧default断言保持。source固定期间无编辑，无target重试/native retry；失败TEMP日志/目录保留，没有全量、根服务、模型或OSworker实验。

## master/worker 注册角色消费

Astra新scope模式从真实mTLS kid+pin与可信配置判断purpose，challenge/result不可变 `control-only` 或 `run-worker`。master只可签conversationControlSubscribe/conversationReadOpen/conversationReadClose/conversationControlAck与pendingRuns；后者exactPOST `/internal/v2/runs/pending`/body{}。不由缺ref推master，不允许两个kid/pin相同配置。worker强制rootScopeRef并核双摘要；其他DocrunAPI强拒master。

session可配置required registrationPurpose并核服务器回显；rootScope配置自动要求run-worker。master签data/run/assets/assignment与bindScope全拒；metadata签精确pendingRuns，旧未启scope模式pending仍沿原路径。生产master/controller/worker证书由root另配，本叶不读取真实key、不自行改main开启。新消费者源码尚待配Astra最终固定provider真实目标。

固定aafd69ec专属9/9、0fail/cancel/skip、110.6967ms/exit0（外层347ms），TMP `pc-worker-session-aafd69ec-target.log`。均纯受控注册/真实RAM签名，没有业务TLS监听。尚未把Astraeca3/purpose新增provider合进本叶，等待root冻结组合；未冒用其目标结果。

root准最窄workerEventProofFor固定POST独立域，但实际signed remote sink的fresh Doc验权仍需observer getter：control-only master不能拿当前五个op作scopeAssignment/checkAccess(write)，历史rootassignment不是currentgrant/fence权限。已与Astra约exactworker/root/actor绑定的只读private getter；缺callback仍503，不自由allow、不放宽masterrun能力。当前gateway/worker入口/remote sink没有实现或运行，不能称此阶段完整OSworker/Editor已过。

## 独立事件签名协议及真实注册目标预备

事件签名首红12tests/9pass/3fail/119.0206ms，三个新目标均为workerEventProofFor缺失，TMP `pc-worker-event-signer-first.log`；原9项未退化。固定源码1284c59f后12/12、0fail/cancel/skip、125.6583ms，`pc-worker-event-signer-fixed.log`。纯exporter adapter、真实同RAM Ed25519；不是实际TLS/远端sink/OSworker验证。新域只签固定POST `/internal/v2/worker/events/append`，完整原body SHA256、packet/rootref/assignmentDigest/fullbinding/sourceSeq/eventId、nonce、独立TLS exporter。私有durable source缺失或变packet拒，sourceawait后真实socket已关闭拒。签名不能替fresh Doc授权。

root已将clean叶快进56a10f07，纳Astra5beb的真实scope provider/角色注册/assignment gate；未自行合依赖。Astra新getter约exactPOST `/internal/v2/runs/worker-event-source`、独立workerEventSource operation、body只projectId/runGrantId/assignmentDigest；control-only master真实PoP，每次真实rootbound/currentgrant/readreceipt/active或精确retained/fence核验。只返业务message和公开绑定/DERkey/Docworkerpin/版本，不返人类login/credential/delegation或cap；master不能藉此拿run/check/write授权。此getter尚WIP，remote sink接收端未配置仍503。

新增account-task-worker为真实oneRAM/client/identity入口：root reservation来自可信启动参数；identity只接受另配root-controller leaf，原root schema exact response、真实process.pid及DER公钥。worker→Doc outbound TLS另配证书，不能把root-controller pin当Doc worker pin。仅一project/conversation/requestId领grant并取得Doc签assignment；assignmentReady再次真实问Doc且同原tuple/原assignment，未bound拒startTask；startTask仍调用现有account-executor-assembly/Hosted factory，不复制执行器。局部close等待实际identity sockets、client请求/TLSsocket与正在startup的assembly收口，不产root闭合证据。

本次预备Windows真实TLS目标使用6700 Doc/6701 workeridentity；完整6700–6711预检无监听。TMP临时PKI/SQLite/rootchain，真实原instance/run internalhandlers、PoP/exporter、同RAM注册/admit，原inspectAgentScopeSource完整检查实际JSON链。publisher的cgroup/birth/uid为受控OS模型，account sender核验为受控adapter；不降低production createAgentScopeReader的linux-required，也不声称系统root权限/OSclosed。节点根后续应以相同冻结入口配真实Linux reader/publisher、独立controller证书与worker出站证书执行。旧128M控制实验上限不用于SSR worker；root须实测RSS后选本次实验限制，此处没有默认生产预算或吞吐结论。

当前尚未执行这个新的TLS目标、未跑全量/模型/完整Editor；gateway/remoteeventmaster/finalizer/forced退役配对未完成，completionReady仍false。已通过的旧Editor/main基线不得套给这些新代码。

## 固定1ab766d9真实TLS首轮结果

源码1ab766d9930a1615d5756d3bd81fe558f4a60fbd固定期间未编辑。root准Windows独立真实TLS/原Dochandlers/磁盘链窗口后，仅运行 `npm test -- server/test/agent-worker-registration-mtls.test.mjs`。首轮1/1、0fail/cancel/skip，case883.6528ms、suite998.2461ms、工具wall1828ms、exit0；无retry。TMP `pc-worker-registration-1ab766d9-first.log`。初次6700–6711全段空，实际Doc6700、workeridentity6701；teardown实际servers/sockets/SQLiteclose断言通过，结束全段无监听。PKI子进程都是已安装OpenSSL、windowsHide、自建TMP，不读取生产证书。没有模型/浏览器/业务full。

本次真实链：新worker同一个RAM key公开DER → root publisher exactidentity通过真实独立TLS读取 → TMP磁盘ready chain → Doc原instance internalhandler/authority真实PoP → worker自身admit/单grant → Doc签assignment。root-controller证书与worker→Doc证书不同，错误controller身份真实403。Doc登记仍PEM摘要，root target仍DER摘要，原mapping完整核同key。bound前assignmentReady/startTask拒、modelconfig调用0、实际Docreadreceipt0；原publisher bind/原chain验证后assignmentReady真返回bound。第二调度请求不同requestId拒、grant总1、completionReady:false。

准确边界：这是同OSworker模块实际PID/TLS/SQLite/磁盘链，不是child进程、Linuxroot UID/cgroup/birth、真实模型/完整Editor/终态完成。publisher OS与账号sender验证是受控adapter，生产reader没有任何宽免。源码中runClient.close新增等待owned请求及TLSsocket的实际close；assembly已有同worker预登记时核purpose/rootinstance/Docauthority/同DERkey再继续，不能重复configureRegistrationScope导致真实worker注册后assembly启动拒绝。task组装仍复用Hosted factory。

同固定源affected纯目标 session12+task4合16/16、0fail/cancel/skip、274.8935ms/exit0，TMP `pc-worker-registration-1ab766d9-pure.log`；强制绝对父仓库tsc -b --force，exit0/零错误、工具wall7205ms，TMP `pc-worker-registration-1ab766d9-type.log`。没有重跑既有full/Editor，三份目标/类型日志原样保留。report后提交不改变本次product source。

### 根Linux预备配置与接口

入口为 `createAccountTaskWorker({doc,expected,reservation,identityTls,readRootRecord,scopePrepareSource?,workerEventSource?})`。doc是worker自己读的outboundclient `{origin,tls:{key,cert,ca},serverFingerprint256}`；identityTls是workeridentity server自己的key/cert/CA；expected中的clientFingerprint256仅root-controller入站pin，serverFingerprint256必须与identityTls实际leaf一致。root privatekey不交worker/master。expected/reservation必须来自root已耐久的固定slot启动配置；readRootRecord是可信entry配置读同registryDir的epoch文件，Doc仍用原createAgentScopeReader完整rootownership/连续链/currenthead再验，worker读单record绝不代替它。

先 `worker.listen({host:'127.0.0.1',port:根独占端口})`，root才能按原 `/internal/v2/agent/run-scope/identity` RPC取得原schema exact公开DER与真实PID。root发布ready后，gateway只指定 `{projectId,conversationId,requestId}` 调 `prepareTask`，不传旧grant/instance/privatekey；返回Doc签assignment和当前phase。root耐久bind后才 `assignmentReady(实际grant)`/`startTask(可信assembly参数)`。startTask只调用原assembly/Hostedfactory，仍需要真实sameRAM readControl、DocdataClient、remote runEventsSink、onTaskDrained；这些生产参数未配置时拒，不补()=>true。正常prepareSource与workerEventSource必须读durable本机事实，缺失503。本包尚未实现root调度gateway/独立worker CLI或远端eventmaster，因此Linux根可先用固定module构造配置验证身份/准入；不能声称它已自动上线生产worker。

normal闭合还需Astra冻结scopePrepare/scopeTerminal/queryFinish及root真实forced/unassigned/finalizer配对。活跃任务强制中止保原pending/原slot，不把失败启动或新OS自动作closed。root最新内存/CPU/磁盘仅现场快照，SSR必须测实际RSS再取实验限制，不从旧128M控制实验/两槽示例推默认生产值。
