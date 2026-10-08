# 云端项目素材数据链与 ProjectAssets 实施报告

2026-10-08；分支 `codex/018-cloud-project-assets`；固定基底 `7dab214f8dc521ef908141a06b14b7996520f1dd`。这是 B 功能叶；A 最终报告已在独立叶提交 `4766384b17c81e6dcb68562ccd76764f2cd9435f` 并冻结。

## 目标与边界

按 `docs/plan/cloud-agent-project-assets-implementation.md` 实施独立 asset 数据链与 Agent ProjectAssets。只新增 `server/hosted/asset-run-access.mjs`、`asset-run-client.mjs`，必要的 `server/agent/service/project-assets.mjs`、`run-asset-client.mjs`、`tool-assets-resources.mjs`，专用 `server/test/project-assets-*.test.mjs`、`asset-run-*.test.mjs`、fixtures 与本报告；仅窄改 `server/asset-store/project-access.mjs` 的通用资源 lease／run 暂停接缝、`project-revocations.mjs` 的唯一人类 consumer 参与者 hook。原人类撤销、actual close、持久 receipt 与 ACK 继续保留。

A 协议复用冻结 `909a6b96`，文件 SHA256 `d44879481a93af8c86aa258b5349084e25753c8f93ba814ec28ebe5c2e85d777`。不复制身份或 run 权威、不签通用 proof、不修改 A、instance/run/operation/Jobs/run-resources/store/publication/中央/worker。worker 窄 facade 与实际 run-resources 以其冻结 API 适配；未挂生产 adapter 保持 503。

## 验证约束与当前状态

现已实现独立模块、物理导入与实际资源关闭目标；纯目标24/24、产品强制类型零错、获根单次窄窗口的真实mTLS目标1/1，精确源码/范围见下节。保留仓库 wrapper 的38个坏端口guard候选例外，不bypass。6480～6489从未启动。full／宽probe／部署／节点均未做，生产G接线不在本叶。

所有自有数据、日志、spool、测试密钥在 TMP；子进程 windowsHide、隐藏绝对 preload；Python/cuda/models/provider/order 仅进程环境；不安装依赖、不 junction、不改变系统环境、用户端口或数据、不推送/合并。首红与每次有因修正将逐次补记。

## 阶段源码与首次目标

2026-10-09继续原叶；未重建、回滚或盲合根。0923f62b是开工报告；e36f3854完成新client/access/consumer、ProjectAssets及实际run-resources适配和通用lease两窄处。A复核曾临时回其独立叶，最终56dbee2c交root，本B只读原基底A，协议909/worker/中央不改。

e36目标 `npm.cmd test -- server/test/asset-run-lease.test.mjs server/test/asset-project-stores.test.mjs server/test/asset-project-revocations.test.mjs` 首红13项12pass/1fail、0cancel/skip，129.4722ms，墙422.5495ms，TMP `pc-project-assets-pure-1.log`：暂停决策已拒后assert仍再调check，实际run-revoked，断言要求access-revoked。4a9e650a最小修为await暂停决策后先重新核aborted/released，再决定调用权威，没有降低断言；同三目标13/13/0fail/cancel/skip，131.4356ms，墙418.1566ms，`pc-project-assets-pure-2.log`。

790da014目标 `npm.cmd test -- server/test/project-assets-client.test.mjs server/test/asset-run-lease.test.mjs` 6/6、0fail/cancel/skip，121.4459ms，墙492.6387ms，`pc-project-assets-client-1.log`。真实physical projectStores/完整hash/实际Readable与FileHandle，工具import只返stored、无mediaId/registeredMedia；context/Job/abort反向和handle跨run拒。wire、account、lifecycle与sender adapter受控，不是production crypto或三方mTLS。

7bc952b6新增handler的实际FileHandle复制、marker/rename撤销切点测试。首次实际 `npm.cmd test -- server/test/asset-run-handler.test.mjs` 5/5、0fail/cancel/skip，358.3829ms、墙727.1355ms，TMP `pc-project-assets-handler-1.log`。前一次编排命令因内存环境前缀变量缺失生成 `undefined$taskTimer`，PowerShell解析失败，npm没有启动；补回完整环境后才进行上述首次实际目标，不算一次测试重跑。ControlledSocket/exporter/account adapter受控；真实的是物理projectStores、完整hash、源流/文件句柄和publication，不能据此宣称真实TLS或生产接通。

3d00696ed1571032db0cb0bab661bd0d3608f534补actual-close后的私有持久witness、丢ACK新实例拒、异步资源背压监听清理、Uint8Array完整输入。五文件精确目标 `npm.cmd test -- server/test/asset-run-handler.test.mjs server/test/asset-run-lease.test.mjs server/test/project-assets-client.test.mjs server/test/asset-project-stores.test.mjs server/test/asset-project-revocations.test.mjs` 24/24、0fail/cancel/skip，402.4595ms、墙745.951ms，TMP `pc-project-assets-pure-3.log`，测前/后源码相同。保留9项旧humanstore/撤销回归；新增真实Readable `_destroy` callback gate：HTTP/源逻辑结束与资源actualclose分开，prepareClosure阻塞至真实close，落盘前没有closureWitness，没有run ACK。

同固定3d源码绝对TypeScript `tsc -b --force` exit0/零错、墙5873.532ms，TMP `pc-project-assets-type-1.log`。npm/type使用绝对silent preload、唯一canonical PSModulePath与仅进程cuda_Vit/models/显式VH provider/order/conversation。没有裸node --test、业务listener、full/C10或节点。后续新TLS测试源码不冒用这次类型/24项为已运行TLS证据。

新 `server/test/asset-run-mtls.test.mjs` 写入后首次 `node --check` 失败：同测试词法作用域 `verified` 重复声明；工具原输出保留，未启动测试或监听。仅将verifyRef句柄局部名改为verifyHandle；第二次静态检查exit0、TMP `pc-project-assets-mtls-syntax-2.log`。第一次静态命令没有显式preload前缀；仅解析、无子进程或监听，后续检查已带完整前缀。不得把静态检查写成TLS通过。

## 当前接口与可信缺缝

`createAssetRunClient({origin,tls,serverFingerprint256,timeoutMs,maxResponseBytes})` 只持asset自己私钥；openLease独占observer keepalive socket，换socket永久拒continuation，返回check/closeLease/close；eventsSince/acknowledgeEvent独立连续日志通道。`createAssetRunConsumer({client,file,assetInstanceId,serviceIdentity,verifyLifecycle})` 持久cursor/pending receipt/非秘密lease归属，未知重启lease failclosed。人类consumer新增participants，仅原单consumer写access ACK；run participant先同步pause后独立doc核验，合法retained恢复，revoked等owned资源实际close与持久lease receipt后才run ACK，不在recheck里递归锁。

`createAssetRunAccess`只走独立Agent mTLS handler；实际wire重建909 tuple，标准body长度/摘要与peer exporter，不收public tuple/actor或loopback免票据。project目录只来自`projectStores.project(doc已核projectId).root/dirs.media`。root已授权本项目+runGrant+已验proof实例代际+importId摘要的暂存BlobStore，复用hash完整核验；temp文件每read/write fresh assert，实际FileHandle close，最终通过既有publishProjectFile marker/dirsync/回退。GET/HEAD只看projectStores已接受目标，不直接读暂存。cancel不删除其它合法同hash。

Agent `createRunAssetClient`消费worker的隐藏raw票据facade；`createProjectAssets`只收可信8字段context/媒体引用/内容。resources用冻结register(context,{kind,resource})/signalFor等真实接口；spool quota的reserveImport与workspace(context)须真实宿主提供，sourceJob提供时另核同context，不设默认数字。存入字节与doc addMedia仍分开。

G仍须接force current服务registry、真实A observed私有subject与actual closure verifier、asset lifecycle/root旧cgroup witness、双head required状态、真实worker transport/额度与workspace adapter。缺这些生产保持503，HTTP/UID/OS重启未知不借empty Map或计数0完成。真实TLS只有下述本叶单目标，全量未跑；root共同基线不是本B新源的证据。

## 给中央接线的实际模块接口

- `createAssetRunAccess({client,consumer,projectStores,humanConsumer,assetInstanceId,serviceIdentity,agentFingerprint256,resolveAgentTransport,maxBodyBytes,publicationIO?})` → `handler/idle/close/status`。`resolveAgentTransport({req,socket,fingerprint256})`必须force current并仅回`{serviceKid}`；`projectStores.project(已核projectId)`提供`root/dirs.media/stores.media`，不收callerpath。`status()`回`runAssetsConfigured/runAssetCursor/runAssetHead/runAssetsReady`，本方法不自动同步；G真实status入口必须先同步两个consumer，再组合原human的head/cursor/instance状态。
- `createAssetRunConsumer({client,file,assetInstanceId,serviceIdentity,verifyLifecycle})` → `start/sync/beginAdmission/finishAdmission/admit/prepareClosure/closed/unknownAdmission/handleAccessEvent/unavailable/close`及ready/cursor/head。私有`closureWitness(leaseId)`回`{assetInstanceId,serviceIdentity,receipt,binding:{projectId,runGrantId,instanceId,instanceGeneration}}`；私有`controlWitness(eventId)`回`{assetInstanceId,serviceIdentity,receipt}`。只能由G暴露于pinned doc mTLS，实际lease release及成功落盘前503，不能从public body生成。人类access消费等待participant，run连续outbox仍单独ACK；continuation仅独立问doc，不递归await任何consumer队列。
- 生产新assetInstance遇持久旧实例pending ACK或lease记录一律503，不改写旧receipt归属。相同instance的受控lost-ACK重发已验；新OS/旧doc epoch/旧实例observer的恢复仍需G与A的可信精确恢复接缝。本模块不宣称已解决该跨进程恢复。
- `createRunAssetClient({transport,maxResponseBytes})` → `issue(context,purpose,selector,requestId)/request(context,handle,options)/json(context,handle,options,track)`；只消费worker隐藏票据facade，handle绑定完整可信context，工具不能取raw ticket/私钥。`createProjectAssets({contextAccess,runAssetClient,workspace,resources,reserveImport,maxImportBytes,verifySourceJob?})` → `openRead/import/verifyRef/close`；import只回stored，不代替doc addMedia注册。`createToolAssetResources(resources)` → `track/handle/close`，适配冻结register/context signal/authorize/verifyFence，仅自身scope资源证明。

## TLS窗口申请的固定测试边界

`asset-run-mtls.test.mjs`沿用现有TMP PKI和runFixture：真正SQLite、RAM Ed25519注册、instance/run权威、三个不同角色cert、两个HTTPS服务器（doc/asset），真实assetRunClient observer RPC和assetRunAccess physical stores。sender/currentregistry/media/lifecycle及doc回查B witness由受控可信adapter注入；humanConsumer为受控head0，未挂生产唯一human access consumer。两个server同测试OS/UID，不是生产三进程或OS隔离完成。

拟命令仅 `npm.cmd test -- server/test/asset-run-mtls.test.mjs`；业务监听恰doc/asset两个listen(0)，原wrapper guards例外另计；没有Agent服务、浏览器、Python或ffmpeg。TMP PKI通过现有helper运行windowsHide openssl短子进程，单命令30秒超时；用例60秒、每HTTP请求10秒。teardown先关闭 owned data sockets并等receipt RPC，再关闭client/consumer/server/all TLS sockets并删除准确TMP目录；source冻结后才申请窗口。覆盖GET/HEAD/Range/PUT/complete/verifyRef、完整wire tamper、真实nonce/TLS重放拒、错project、已读共有retained再读及stop拒。actual-close的长源gate已有纯目标，不将这里5字节素材当长流关闭或真实worker执行验收。

### 单次真实TLS结果与窗口释放

root全文核e361夹具后，先等G及共同基线结束，再明确授本叶单次窄窗口。固定 `e36150ee1ab1bc9d78c3c3debd5621eebacc5a40` 实际运行上述唯一npm命令：exit0，1项/1pass/0fail/cancel/skip，用例1493.9725ms，suite1581.2813ms，墙1884.2219ms；native retry0；sourceBefore/After均e361、全程无编辑。TMP原始stdout `pc-project-assets-mtls-1.log`、stderr `pc-project-assets-mtls-1.stderr.log`（空）、进程与监听观察 `pc-project-assets-mtls-1.meta.log` 原文保留。

实际doc/asset业务端口1475/1477、Node测试PID28448；wrapper guards PID11896观察到38监听。隐藏启动树观察到PID11896/12608/19944/24372/28448/30612/33704/34288/38416（包含隐藏npm/cmd/Node及临时PKI命令中被观察到的进程，不把观察清单说成捕捉了每个极短子进程）。teardown诊断真正TLS socket Set空、两HTTPS server listening=false、准确TMP目录已删除；外部Get-CimInstance/Get-NetTCPConnection在结束后确认观察到的owned PIDs/listeners均无残留。自然结束后立即向root释放窗口，未加跑其它目标/full。该wrapper按约定保留原global setup/guard；凭据/proof/exporter没有输出。

实际链：Agent真实实例注册/已读→doc A issue完整body→B原wire重建/独立asset cert问A→exact scope+TLS proof→physical chunks/hash/publish/read→owned HTTP/TCP/source fd实际收口→本地receipt持久→同observer doc关闭RPC；retained共有任务可再读、stop后拒。错project、raw body空白篡改、新TLS旧proof与已用nonce均拒。sender/registry/media/lifecycle/humanhead/closure回查仍为报告中明确的受控可信adapter；不冒称生产G、真实provider会话、三UID隔离、真实Worker facade或OS历史恢复。

未做：最终full、Linux全链/dirsync平台新包验证、生产G接线/required传播、真实worker+工具链、真实human+run双head并发、跨OS历史receipt恢复、全部晚结果/发布切点、用户UI及节点。latest render supplement仅作边界核对：不选择未批准earlyyield/补渲failure A/B/删除细节，不引入内存默认数字。产品最后源码3d00696e，后续e361仅测试/报告；24pure/type3d和TLS e361各自范围分开。最终只报告提交不改变产品与已运行TLSfixture。

### root复审中的待查异步窗口

root独立读原始日志及7个产品diff后提出两处静态窗口：ProjectAssets.import第二次read fs.open后的track在try/finally之外，register/取消当场拒时read fd是否遗漏；assetRunAccess先构造closedTask，再await consumer.admit，active/catch在其后，持久admit拒时是否仍完整收口channel/live/task。Astra随后取到下述真实反例/负向实证，原e361首次TLS并未覆盖它们。原首次源码与日志始终保留。

## 异常生命周期受控修复

root精确扩大租约后，仍在原B叶实现；不修改A、protocol909、中央、worker、run-resources或publication/store。Astra固定e361反例索引均在TMP：

- `pc-assets-e361-admit-persist-counter.mjs/.log`：真实consumer/lease/文件持久I/O，受控doc/TLS且无监听。state.json置目录后实际rename EPERM；handler503、closedTask prepareClosure再EPERM，产生unhandled，idle成功、channel.close=0、closureACK=0。此为已证窗口。
- `pc-assets-e361-fd-register-counter.log`：真实FileHandles与run-resources.register，拒绝前dispose并await实际close，read fd=-1、未复现泄漏。本次未为fake register改read fd路径。
- `pc-assets-e361-pause-admission-counter.mjs/.log`：真实consumer/lease，另admission未结期间受控实际close回调拒绝；pause延迟监督派生结果，产生unhandled close-failure，外层已有catch也太晚。
- `pc-assets-e361-openread-close-counter.mjs/.log`：真实RunResources/Readable，受控issue挂起；close先回streamsClosed:true，issue放行后又request创建源流。原e361的成功链不覆盖这条初始化竞态。

5943449f新增正式admit回归，唯一handler目标首红6项5pass/1fail、0cancel/skip，342.4872ms、墙627.5502ms，TMP `pc-project-assets-admit-red-1.log`：idle未拒真实I/O失败。随后f8d3737c立即把closedTask纳入active并附非抛错监督，在admit失败后等待完整闭口；无论prepare持久化/closeLease RPC/closed持久化成败，都最终await observer.close。原持久错误保留，关闭也失败时保留AggregateError两因，idle/close等全体owned结束后再传播，不虚构ACK或witness。

6f9a7bf1增加pause/openRead/verifyRef回归，两个pure文件首红13项10pass/3fail、0cancel/skip，126.5505ms、墙405.1434ms，TMP `pc-project-assets-lifecycle-red-1.log`：原close-failure unhandled以及两公开方法setup早返close均被正式测试捕获。d187683f把pause每个派生结果在生成时转为已监督settled结果，仍向调用方传播原错；ProjectAssets所有公开async方法在入口注册inflight，close先停止、关闭已拥有资源，再等待setup/泵送/实际closed，最后再次收口晚到资源。所有新I/O前重新核stopped/当前权限；不以逻辑pending=0替代真实resource close。既有真实register的fd dispose保持。

最后b2064d68/a7d19fde增closeLease RPC拒绝反向：所有controlled observer资源必须close，持久record仍closing、不是已ACK；双持久错误聚合必须每一项都为真实I/O失败，断言不接受泛化错误。固定 `a7d19fdea1672193add55aa9f4228080d2960445` 五pure文件一次29/29/0fail/cancel/skip，393.3215ms、墙669.4695ms，TMP `pc-project-assets-lifecycle-fixed-1.log`；测前/后同源码。绝对tsc -b --force一次exit0/零错，墙5453.1374ms，TMP `pc-project-assets-lifecycle-type-1.log`，测前/后同a7。native retry0；wrapper原guards不bypass，除此没有业务listener/TLS/full/宽probe。父仓库silent preload、canonical PSModulePath、cuda/provider/order/conversation均仅进程配置。

产品最新源码d187683f（handler首修f8包含在祖先），最终测试源码a7；原3d类型/24pure与e361TLS首过仅作对应旧源证据，不冒用为新生命周期块的TLS/full通过。新块只改2个产品文件、3个专属测试与本报告，不删素材或更改账号/共有retained语义。

## 下一恢复续包提案（仅方案，尚未实现）

root要求先交字段与风险，待逐读后另授窄实现；下面不改变当前503、A909格式或G生产ready。

1. 已durable closed的旧asset实例可精确归档，不能把任何旧receipt.assetInstanceId改成新实例。建议持久state版本2新增`archivedInstances[assetInstanceId]`，包含原serviceIdentity、原lease binding、receipt和receiptDigest；当前`leases/pending`仍仅属于当前实例。归档准入需逐lease真实closed、完整原receipt与doc持久closed/ACK记录精确相等，且没有旧unknown/open/closing/pending。旧OS资源或observer无法证明则503，仍需root外部cgroup witness；有旧pending但doc已ACK时，必须由pinned doc只读查询确认原eventId/cursor/instance/serviceIdentity/receiptDigest后再归档。doc未ACK、旧epoch或证据不可用时不得猜游标或自行制造新ACK。
2. 控制witness应精确eventId持久只读，不能只保存RAM最近一条。建议`controlReceipts[eventId]={assetInstanceId,serviceIdentity,cursor,controlId,fenceRevision,receiptDigest,receipt}`，与原pending receipt同一次原子落盘，ACK后继续保留；witness只返回该原记录，拒不存在/篡改/身份冲突。重启加载需逐digest/seq/event/receipt绑定核验，旧实例返回旧身份的历史记录，不能为当前observer重新签complete。当前A已ACK/lostACK历史核验通过G pinned doc→asset callback消费；如A现接口不能核历史observer，保持pending并交最窄接口缺口，不改protocol字段来绕过。

需正式反例覆盖：全closed旧实例仅历史可审不改名；旧pending/open/unknown拒；doc已ACK精确原receipt归档与doc未ACK分开；连续多event和ACK后重启任意旧eventId精确回查；event/body/digest/服务身份篡改；持久文件sync/rename失败不得提前有witness。上述均未在本块跑/实现。

G另交真实接缝风险：若A.check已持久lease、B resource lease未创建，G双head wrapper发现游标差1就拒，会让双方留下unknown。admission token未结内不能再await两consumer.sync，否则participant.pause等待token形成锁环。G暂未挂该wrapper，本块只记后续需精确pre-resource lease关闭或同步顺序设计；不在EPERM修复中扩大修改或降低双head要求。
