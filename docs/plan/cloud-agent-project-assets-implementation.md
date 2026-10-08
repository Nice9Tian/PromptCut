# 云端 Agent project-assets：F0 剩余基础接口实施设计

2026-10-08。固定源码起点2485c6cc；本文件是可派工的内部机制设计，不是新增用户批准、已实现声明或测试报告。F0指[剩余工具实施计划](cloud-agent-tools-implementation.md)中的 grant／asset／job 基础包；本文件只补尚未实施的 project-assets。ToolContext和ToolJobs已有源码，不能继续按三个空模块派工。

## 1. 产品决定与当前事实

已定承诺来源：[账号契约](account-binding-contract.md)、[素材服务产品语义](../semantics/product/asset-service.md)、[云端Agent契约](cloud-agent-contract.md)2026-10-08补记及[剩余工具计划](cloud-agent-tools-implementation.md)。项目素材隔离；服务同样不得凭全局hash读另一项目；素材字节不经doc；素材服务只存分发字节；Agent不借creator特权。已确认读的共有当前轮，被踢或改密退出后可按run authority保留执行及修改；旧人类登录、读取、订阅、新消息与下一轮仍撤销。private、stop、Agent off、项目删除、服务/实例撤销优先，不因retained穿透。只读写拒的实际判据由现权威保持，不另创造只读发送身份或产品例外。

本设计不选择未定的补渲故障A/B、提前让位、删除权限/计数/释放时机，不设新内存数字，不改匿名采集/电脑登录代下决定。卡片外链正常与Agent采集SSRF保护仍分别执行。下列〔裁-F0〕是三级实施选型，供root审代码与接口；没有把技术选型说成用户逐项批准。

### 真实源码接缝

| 真实路径与函数 | 2485已有行为 | 本包不能假定的能力／拟接缝 |
|---|---|---|
| `server/agent/service/tool-context.mjs:createToolRunContextAccess`（98行）、`fromGrant`、`authorize` | 由当前注册身份及doc read-confirmed grant构造可信8字段，每次调用真实checkAccess；拒changed instance、未发行context | 没有`signalFor`、没有资源注册/actualclose；8字段不含token、servicePrincipal、RAM cap |
| `server/agent/service/tool-jobs.mjs:createToolJobs`（154行） | SQLite WAL/FULL，精确8字段幂等；运行中重启转interrupted；before/after authorize及verifyFence；outputRefs只收`{kind,id}` | 不执行/停止worker；close只关DB；取消记录不等于资源关闭。现job update的row.fenceRevision须等新授权revision，active→retained合法变化需Jobs owner另补可信checkpoint迁移，不能F0资产层偷改 |
| `server/docservice/account-hosted.mjs:issue`（90行）、`resolve`（96行）、`issueSession`（199行）、`resolveAssetTicket`（228行） | 人类assetTicket是RAM opaque引用，绑定authorizationId，resolve逐次account token/current project核验 | retained旧login不能借此续票据；runTicket不能替代asset授权；本设计不放宽该resolver |
| `server/account/authority.mjs:checkAccess`（149行） | 必须真实authorizationId，resource.ns仅media/snap/px；runGrant body不能豁免旧登录 | 不改为自由accountId或runId授权；Agent asset路径另走真实run provider |
| `server/docservice/modules/account-projects.mjs:mountAccountProjects` | `/internal/v2/access/check`只在已登记mTLS服务下处理；明确拒body.runGrantId/serviceId | 不把新run分支混进这一人类principal入口 |
| `server/hosted/doc-agent-assembly.mjs`（62/137/167/297行） | 同SQLite instance/run工厂、真实socket+current registry、scopedInput、grantPrincipal、handleInternal；逐调用finally release | 注入新asset专用handler；只在私有transport adapter接可信asset观察，不直接把asset证书当Agent证书；原WS/LP与run gate不改 |
| `server/account/agent-instance-authority.mjs:instanceTlsBinding`（19行）、`authenticate`（134行）、`verifyInState`（150行） | exporter真实socket；Ed25519签完整请求；内部RAM capability核精确operation/scope/current实例，release；普通body实例号不授权 | 复用`checkAccess` operation，resource/full HTTP tuple由新handler精确核验；不能序列化instanceSession、复用已关doc HTTP cap |
| `server/account/run-authority.mjs:checkAccess`、`resolveRunPrincipal` | 当前项目/开关、read receipt、当前run/actor、instance、active专用accepted-message或retained规则 | 是唯一任务权威。新asset模块只调用它；不拷贝member/private/retained状态机。controls.retained/revoked/instances是持久控制事实 |
| `server/hosted/doc-assembly.mjs:coordinatorForSpace`、`history`；`server/docservice/operation-wiring.mjs:read`（96行）；`server/docservice/modules/operation-history.mjs:snapshot`（70行） | 同tenant coordinator恢复历史/投影并在同锁读；history.snapshot返回`{projectRev,value,versions}` | 新`resolveMediaForRun`在已有coordinator.read回调内读history.snapshot，不改operation底层或绕恢复读全局文件 |
| `src/kernel/project.ts:MediaAsset`（135行） | media.id/kind/name/url、可选hash/size/ext/tiers；tiers.original、小尺寸hash；可能有旧path | 无原生mediaRev。派生mediaRev必须注明算法；云端不把旧绝对path当可读资产 |
| `server/hosted/asset-runtime.mjs:startHostedAssetService`（22行） | 独立进程、自有asset key；public HTTP只人类opaque票据→doc；internal HTTPS目前只doc pin/status | 新Agent mTLS路由严格分支；status仍仅doc；public/human无run fallback |
| `server/hosted/asset-doc-client.mjs:createAssetDocClient` | principal白名单强制authorizationId；逐check、连续access events和ACK；不会接受run principal | 新独立run client不伪造authorizationId；普通client不改变 |
| `server/asset-store/project-stores.mjs:createProjectAssetStores`（25行） | 项目物理目录由sha256(projectId)选，media/snap/px分别存；同hash跨项目独立；retire防迟到复用 | 新工具只经HTTP；asset角色复用此factory，不直接跨root读取 |
| `server/asset-store/project-access.mjs:openProjectStream`（28行） | 先订阅后check；hold/trackHandle/trackProcess、release等实际close；authorizedAssetStore每发布前重核 | 现login/account事件直接abort，会错误撤掉合法retained run；新run policy必须分流且暂停读写后再问唯一run权威 |
| `server/asset-store/project-revocations.mjs:createAssetRevocationConsumer`（7行） | 连续access head，actualclose→持久receipt→ACK；gap/失联ready=false | private/stop runControls不在access日志；需run-control outbox与受控ACK参与者，不能15秒缓存或只poll当前开关 |
| `server/asset-store/project-io.mjs:publishProjectFile` | marker隐藏未接受target；file+Linux directory sync、回退及actual handle close；恢复symlink/缺backup failclosed | 沿用已验发布边界；新增登记/索引也纳入intent，不用assert前后就宣称跨await原子 |
| `server/agent/service/hosted-tools.mjs:assetClient/ingest/registerMedia`（277/308/355行） | 旧auth.ticket、缓存20秒、先上传后exec.mutate addMedia | 账号版禁止auth.ticket，不能继续走旧cache；G只改accountMode依赖注入，本地/LAN保留 |
| `server/agent-service/run-client.mjs`、`server/agent/service/agent-instance-session.mjs:proofFor` | 每真实TLS请求签名；私钥只RAM；现proofFor只准POST `/internal/v2/runs/`，run-client不导出signer | F0不能假称已能签asset请求；由worker owner固定后提供窄`runAssetTransport`签名能力，同一实例key，不另注册一个“工具实例” |

历史`asset-store-contract.md`第3/4节的免票据读、loopback写信任、cluster token只是LAN/C5历史；当前云端v2由projectAccess替代。云端Agent旧契约638行的“成员此刻权限”不能覆盖已读共有任务retained规则；也不能凭该旧句子放宽所有token。剩余工具计划的ProjectAssets类型为草案，下面按实际“先字节入库，再doc addMedia”拆清成功点。

## 2. 选型与真实三方信任边界

卡点1：人类票据逐token核验不能满足retained，单个runGrantId又不是凭证。尺子是后述真实mTLS目标：原login撤销后，旧用户401/403，精确retained已读run仍可读/导入；新OS同证书/别项目/stop/private均拒，真实源流close后才receipt。

| 行／层 | 候选与因果 | g/h/f | 状态 |
|---|---|---|---|
| 1／三级 | 复用人类assetTicket、改runGrant body豁免：旧token失效矛盾，且授权引用可伪报 | — | 剪：不满足已定身份 |
| 2／三级 | doc一次mint可长期用的bearer run票据：无法证明持票进程是原实例，失联/撤销后缓存越权 | — | 剪：无实时机制 |
| 3／三级 | 每asset HTTP独立实例签名＋asset可信TLS观察＋asset→doc专用再验＋项目lease | 3/1/4 | 开放·本设计选用〔裁-F0-1〕；尚未试，非已试·过 |
| 4／三级 | 全字节经doc转发以保留doc socket cap | — | 剪：违反字节不经doc职责 |

〔裁-F0-1〕asset在新专用mTLS入口是Agent TLS的可信观察方，doc仍是权限权威。每个进程只读自身private key；公开peer cert/CA/pin可共享。Node真实asset TLSSocket上的authorized、leaf fingerprint、exportKeyingMaterial不能由public header或body指定。asset以**自己的**固定doc client cert转发观察；doc当前registry核asset观察者和Agent key，不能将asset mTLS身份直接升为Agent。doc核原Agent RAM实例key签名及持久请求/票据绑定后，在**私有闭包**建立remote subject，仅本次asset handler可使用。

g=3：需要新两角色协议、observer连接与持久lease，但复用现权威/store；h=1：还缺实际mTLS和关闭证明，明确可由目标检验。可运行尺子是实施A后的`npm.cmd test -- server/test/run-assets-authority.test.mjs server/test/run-assets-observer.test.mjs`与实施B后的`npm.cmd test -- server/test/project-assets-mtls.test.mjs`；新增文件由各包独占，要求上述身份/retained/close负向全部0失败。本设计没有执行不存在的目标，也不把估分当实验。

这比已有“只认doc本地Agent socket”的adapter多一个可信观察接缝，必须在真实三进程fixture和root Linux核验，不能把传来一个exporter字符串就当真实socket。doc的新remote subject只从已认证asset observer RPC构造，任何普通run/conversation/WS路由、代理header、自报principal、任意serviceId不得创建它。现instanceAuthority无需复制签名规则：verifyTransportInState的可信callback核该RAM subject、当前observer RPC socket、当前asset/Agent registry及该live request；authenticate仍用原instanceProofPayload。operation固定checkAccess，run-authority仍唯一判断active/retained/project/fence。

G必须给现doc-agent-assembly的**两个**同步callback接同一私有subject registry：`verifyServiceInState`和`instanceAuthority.verifyTransportInState`；前者当前只查本地Agent socket，后者依赖前者。仅修改后者会仍然拒或诱使实现绕service核验。observed subject必须携带不可由body创建的RAM object/token，查回真正observer RPC socket+原asset TLS观察；currentService(force registry)依旧验证Agent当前serviceKid/pin，另核asset observer当前登记，之后返Agent serviceId/kid及本次authenticationId/channelBinding。原direct subject路径与普通provider规则不变，adapter没有注册/改成员/授grant权限。

每次check的RAM cap在完整await检查、selector和结果核验之后finally release；资产字节不跟着cap穿过doc。asset本地lease持续持有原请求socket/fd，但不能将一个cap保存成后续HTTP授权。后续同lease assert使用专用continuation RPC，重新authenticate原签名意图并核**同一live资产请求**，不能作为第二次admission或移到别socket。closed socket、旧asset进程实例、旧doc启动代际均失效。

观察方也有真实连接边界：首次check将lease绑定到doc自己观察到的asset→doc TLSSocket RAM authenticationId及exporter摘要；asset为该lease持有专用keep-alive observer连接，不能由共享连接池自动换socket。body里的assetInstanceId/serviceIdentity只是与可信启动登记比对的引用，不是身份来源。continuation只接受这个仍存活、仍是current asset key的observer socket；同证书新进程、新连接、自报旧assetInstanceId都不能接续或确认旧lease关闭。TLS连接断开即暂停/拒新动作；asset销毁自己仍拥有的资源，doc保留旧lease pending，不能将观察通道断开等同远端所有fd/worker已关闭。重建需新Agent请求、新nonce、新票据/Range，旧请求的关闭由实际收据或可信root OS证明处理。这是连接生命周期机制，不延长任何已释放RAM cap。

## 3. ProjectAssets交付类型与成功点

新`server/agent/service/project-assets.mjs`导出：

```ts
createProjectAssets({contextAccess, runAssetClient, workspace, resources, registerMedia?}) -> {
  openRead(context, mediaId, {tier?:'original'|'small', range?}?)
    -> {stream: NodeReadable, assetRef, mediaRev, projectRev, kind, closed: Promise<void>};
  import(context, NodeReadable|AsyncIterable<Uint8Array>, {name,kind,sourceJobId?,requestId})
    -> {importId, assetRef, state:'stored', resourceRev};
  verifyRef(context, {projectId,hash,size})
    -> {assetRefId, assetRef, resourceRev, registeredMedia?:{mediaId,mediaRev}};
  close(reason) -> {streamsClosed:boolean, dispatchesOpen:number, pending:boolean};
}
```

context仍精确现有8字段。工具参数只收mediaId/name/kind、经过工具schema的内容与业务requestId；不收project/run/instance/票据/本地绝对路径。每个操作先`contextAccess.authorize(read|write)`，对返回产物再次authorize；它不能替代服务端再验。`resources`必须由真实run宿主提供注册/abort/awaitActualClose能力，缺则503。没有现成signalFor；不把自建永远不abort signal当接通。此包新资源登记器只拥有自己的流、spool和HTTP dispatch，不声明关闭Agent全部worker。

宿主窄接口为`resources.register({context,resourceId,abort,closed:Promise<void>}) -> unregisterAfterClose`、`resources.drain(context,reason) -> {actualClosed,resourceIds}`。register先验真实context；closed只能由实际owned源流/fd/HTTP/socket close组成，unregister须等closed，不由finish触发；drain同步调用abort后等所有close。ProjectAssets每请求用独占Agent→asset连接并在结束时关闭，避免撤销一个请求时误认为共享keepalive socket已经归它收口，或关闭其它scope请求。所有权跨HTTP、源流和workspace spool明确登记；宿主未提供真实关闭callback不启用生产工具。

AssetRef为`{projectId,ns:'media',hash:64hex,size:safeInteger,ext?,contentType}`，没有磁盘路径、URL凭据或永久read能力。resourceRev=`sha256(canonicalJson({v:1,...AssetRef}))`；mediaRev=`sha256(canonicalJson({v:1,mediaId,kind,hash,ext,size,tiers}))`，是新派生标识，不冒称现MediaAsset已存rev。doc在已有coordinator.read锁内恢复后读history.snapshot.value.media，按mediaId唯一选取，original只取tiers.original或hash，small只取已登记tiers.small，不猜全球索引、不用path。如果记录无hash、没有已完成字节或非准确project，明确缺失/未完成；故障不是缺素材。

〔裁-F0-2〕import只确认字节入库，不伪造mediaId；项目媒体记录仍由当前run数据连接的existing exec.mutate/host.addMedia落地。修改前草案`import/verifyRef`总回mediaId，实际入库尚无doc媒体记录；修改后先回importId/assetRef，确实登记后才回mediaId。纯内部接口细化，无用户操作改变；替代“资产服务直接addMedia”违反角色职责，替代“预分配mediaId当已登记”产生假成功。G的registerMedia adapter复用hosted-tools的原name/kind/hash/size/tiers及probe信息，不能在F0直接写project文件。ToolJobs.outputRefs只存`{kind:'asset',id:assetRefId}`，ref内容另在真实asset记录中，不改Jobs schema为随意对象。

import先在本对话受控workspace spool/算sha256与size（有现配置上限；没有配置拒启动，不设新内存预算），然后分片直传asset，whole hash校验后complete；spool是Agent持有的输入/缓存，不是直接读asset存储。sourceJobId必须同context从真实Jobs读取验证；不能因一个字符串让迟到job跨run登记。verifyRef是同项目stat/chunks.complete/size/resourceRev核验，没有content hash跨项目搜索；尚未addMedia时registeredMedia省略。

字节stored后、doc登记前失权：拒后续登记与结果发布，不能把stored误报“已放时间轴”；已接受项目字节保留，不删除另一合法import相同hash或已落地修改。上传未接受的target继续由publication marker隐藏和回退。项目登记已有opId重试走原operationCoordinator，不重复addMedia；同importId/body摘要不一致409。

## 4. 拟实施API与签名字段（均尚未存在）

### 4.1 Agent→doc签名发行

`POST /internal/v2/run-assets/issue`，只固定Agent cert＋current registry＋真实TLS exporter。

```json
{"projectId":"...","runGrantId":"...","action":"read","requestId":"...",
 "purpose":"openRead","selector":{"mediaId":"...","tier":"original"}}
```

purpose为openRead/import/verifyRef；action由purpose固定read/write/read，不听调用者扩权。import selector精确`{hash,size,ext,name,kind,importId}`；verifyRef精确`{hash,size}`。头沿用INSTANCE_PROOF_HEADER，instanceProofPayload.operation=`checkAccess`，method/path及**完整原body**签名。不能调用旧runTicket503或auth.ticket。

handler从真实grant重建principal（grantPrincipal的同类trusted facade），当前runAuthority.checkAccess；openRead额外在coordinator.read中解析真实media。返回`{ok:true,result:{ticket,expiresAt,ticketId,resource,resourceRev,mediaRev?,projectRev?,fenceRevision,grantState,docEpoch}}`。ticket是随机32字节opaque，只有RAM保存raw；持久只留ticketDigest。期限由必须提供的`runAssetTicketTtlMs`机制配置与doc可信now生成，不继承旧人类token expiry，不能写成永远有效；同时受grant/instance/project/fence限制。结果不含authorizationId/token/instanceSession/servicePrincipal。

票据绑定完整grant identity、serviceId/kid、instanceId/generation、readReceiptId、project/resource/action/purpose、docEpoch、发行fenceRevision；不会仅绑定账号/project或给hash wildcard。发行fenceRevision只是审计，不自定“变化全取消”：能否在retained继续只问runAuthority。read票据不能PUT/complete，write票据也不自动变read票据；对账必须另发read scope。

### 4.2 Agent→asset逐真实HTTP

专用HTTPS入口`/internal/v2/asset/run/media/<hash>` GET/HEAD/Range；`.../<hash>/chunks` GET；`.../<hash>/<n>` PUT；`.../<hash>/complete` POST；`/internal/v2/asset/run/refs/verify` POST。这里只ns=media，snap/px及任意非列路由403；扩展其它产物由对应render/visual owner另约，不发全namespace通票。复用BlobStore协议状态码与分片大小，字节只Agent↔asset。

固定Agent cert/current registry，独立实例证明头`x-promptcut-run-asset-proof`、Authorization Bearer opaque票据；不允许URL`t`、Cookie、proxy身份header。签名request规范对象：

```ts
{v:1, purpose:'run-asset-http', projectId, runGrantId, action,
 ticketDigest, resourceRev, nonce, requestId,
 method:actualMethod, url:actualUrl, range:actualRangeOrNull,
 contentLength:actualLength, contentDigest:sha256ExactBody,
 contentType:actualContentTypeOrNull, importId?:string, chunkIndex?:number}
```

仍用instanceProofPayload的domain/authorityId/instance/service/kid，operation checkAccess；method、path与requestDigest对应上述完整tuple，channelBinding来自此**asset TLS socket**。GET/HEAD空body用sha256(empty)，不接受声明大body却按空串核签；PUT先已知chunk hash/length，实际流同步计算并核对，长度不足/过长/abort都拒并actualclose。签名覆盖Range、query、chunk号和完整body摘要；asset重新从actual request组装，不把Agent提交的tuple当事实。nonce每ticket/request唯一，持久claim在合法签名/current检查之后、任何入库/headers副作用之前；并发相同nonce一方接受，另一403；相同import的重试使用新nonce但同import/chunk逻辑键。

### 4.3 独立asset→doc再验与continuation

`POST /internal/v2/run-assets/check`只asset专用doc cert/current registry。body为`{ticket,request:actualTuple,proof,observation}`；observation由asset自身从已认证live请求生成：`{assetInstanceId,assetServiceIdentity,assetLeaseId,agentFingerprint256,agentServiceKid,authenticationId,channelBinding,open:true}`。这些不是public API可填的身份；doc严核observer是登记asset、observer当前RPC socket真实alive、票据原绑定的Agent key/instance、原签名。公开asset请求传这些字段直接400。

doc私有remote subject登记本次observation和原proof，注入instanceAuthority.verifyTransportInState callback，再authenticate生成内部cap；从grant重建actor→runAuthority.checkAccess→精确resource/ticket/期限/physical project选择检查。返回`{ok:true,allowed:true,leaseId,projectId,action,resource,resourceRev,grantState,fenceRevision,accessHead,runAssetHead,docEpoch}`；没有账户authorizationId，没有cap。asset将此scope放内部req context，projectId只能来自此结果选projectStores，body project显式值必须等于它。

`POST /internal/v2/run-assets/leases/<leaseId>/check`用于同一个live请求继续assert；asset发送原tuple/proof及可信同socket观察，doc要求持久lease和nonce已由首次check接受、leaseId与asset instance/transport匹配，不能作新admission；每次重核签名、当前instance/run、资源、heads并finally release。observer RPC实际socket必须与首次check相同，RPC HTTP request可结束但socket不能已closed后换连复用。keep-alive超时/最大连接时长采用既有运行配置显式注入并测试；不能默认为无期限，也不能自动迁移权限。正常`.../closed`在同observer连接上提交持久收据，仅记录已结束请求；对历史channel已丢失的lease，独立恢复入口只消费绑定精确旧instance/service identity的可信OS证明，不能凭当前asset证书自报结束。完整control ACK另走actual资源屏障；不能POST一个complete令ready=true。

remote观察只被这个handler使用，不能用于doc project.op/read/metadata scope；read ticket/proof不能转write，resolve/authorizeQuery cap也不能代替checkAccess。Agent实际asset socket关闭后，旧observe/lease不能继续。doc重启docEpoch变化令全部旧RAM票据/leases失效；活Agent用原RAM实例key重新签发行，新OS另注册不能接旧grant。

### 4.4 错误码

| 状态 | 拟码／处理 |
|---|---|
| 400 | run-asset-body-invalid / resource-invalid / invalid-authority-claim；额外身份字段、任意URL/path、无完整body |
| 401 | run-asset-ticket-required / ticket-expired；raw opaque只RAM，重启后须重签issue |
| 403 | service-forbidden / instance-proof-invalid / nonce-replayed / project-mismatch / resource-scope-mismatch / run-revoked；保留provider原实际code，不泛化为素材缺失 |
| 404 | media-not-found（doc无准确mediaId）或asset-not-found（授权成立且本项目store无已接受hash）；不搜索别项目 |
| 409 | request-mismatch / stale-media-ref / import-conflict / publication-pending |
| 413/416 | 本请求字节界限／Range非法；不能未验proof结束别人的会话 |
| 503 | run-assets-unconfigured / authority-unavailable / asset-not-ready / run-control-gap / instance-resource-unknown；不可退人类票据、LAN/globalhash或本机读取 |
| 507 | 沿用内部存储压力信号；工具job保留实际错误/等待，由已定容量owner处理，不擅选新故障A/B策略 |

## 5. 持久状态、撤销与发布切点

doc同account ledger增加独立命名空间`runAssetIntentsV1`、`runAssetLeasesV1`、`runAssetControlOutboxV1`；不改原runGrants/controls含义。intent至少含`{v:1,ticketId,ticketDigest,docEpoch,requestId,inputDigest,grantBinding,resource,action,purpose,issuedAt,expiresAt,fenceRevisionAtIssue,state}`；没有raw票据、密码、token、instanceSession。mint同完整scope requestId/digest重复在原进程返同RAM票据；doc重启raw丢失则原intent不可复活，明确ticket-epoch-lost，客户端新requestId重签；同importId仍由asset幂等，不重复副作用。

首次资产admission事务将`{ticketId,nonce,requestDigest,assetInstanceId,assetLeaseId,state:'admitted'}`及完整grant binding登记；同nonce异摘要409、同nonce已接受403，不能依赖RAM Map重启清空。lease审计存头、resource和closed receipt；不存进程cap。observer socket引用/authenticationId只RAM存，不从磁盘恢复为活连接；doc重启仍保留admitted审计并将其关闭状态标unknown，旧epoch不能继续。asset侧独立`run-assets-v1.sqlite`存import/ref、request nonce结果与待重放receipt（WAL/FULL、0700目录/0600文件、Linux目录耐久），只本服务拥有，不让Agent工具直读DB。

import逻辑键为全部8context＋importId；记录`{inputDigest,hash,size,ext,state:'staging'|'stored'|'registered'|'cancelled'|'interrupted',assetRefId,resourceRev,docOpId?,revision}`。同hash另合法import不会被旧取消删除；`stored`确认真实BlobStore.complete与已接受文件，`registered`仅doc op接受后更新。refs查出也要fresh authorize，不以持久记录本身授读。

〔裁-F0-3〕run leases不直接订阅现openProjectStream的“login事件即abort”策略。同access事件先**同步暂停**匹配run资源的出字节/headers/commit闸，阻止新动作，再让doc runAuthority同步事件重验：仍返回精确retained/current/same-instance则恢复该任务lease，记最新fenceRevision/head；被revoked则abort/destroy并等actualclose。人类lease仍按原策略立即关闭，没有旧登录复活。替代“所有login事件忽略”会泄漏private/stop，替代“所有run随旧login终止”违反retained承诺。有限失联/无法消歧保持paused并failclosed，不通过15秒principal缓存恢复。

需要窄提取project-access的generic资源生命周期或增加trusted内部revocation strategy，保持人类默认策略不变；不复制第二套fd/async open/release。generic lease必须支持pause/assert/track/hold与actualclose，异步open在hold内，所有源流、file handle、请求、响应、TCP socket都持有至真实close。发布用authorizedAssetStore及publishProjectFile；publication marker、目录sync和回退完成之前既不能readable也不能complete ACK。late worker产物每阶段assert，错项目/旧实例/result revision不能写。

private/stop/Agent off/项目删除/服务或instance fence还要从持久runControls派生连续asset outbox。outbox独立seq、controlId/payloadDigest幂等，内容只引用原control.retained/revoked/instances/fenceRevision，不推导第二套权限。doc启动及每次check先同步runAuthority并将所有未镜像control补入outbox；off→on期间的历史revoked grant不因当前true消失。deliver开始时发起asset pause/fence，不能等待operation fence收口后才建立读屏障。

asset以自身doc cert`GET /internal/v2/run-assets/events?after=N`连续追齐`{events,headSeq}`，通知仅唤醒；`POST .../events/<eventId>/ack`仅真实完成持久receipt。登录access日志与run outbox都要追齐，Agent入口状态为`accessCursor===accessHead && runAssetCursor===runAssetHead`。不是将runClockV2所有空洞当作连续control流，也不是只看当前projectAgent=true。现human consumer继续唯一access ACK，增加run-resource参与者完成hook：它等待同access事件的retained重验或实际关闭后再持久原ACK；不能另发同cursor不同receipt。run outbox ACK单独持久，以controlId精确归属。

outbox event精确`{v:1,eventId,seq,controlId,payloadDigest,control:{kind,projectId,conversationId?,runId?,fenceRevision,retained,revoked,instances,operationFences},committedAt}`，control逐字段来自持久原runControls；`eventId='run-asset:'+controlId`，seq只在本outbox第一次镜像时分配。ACK body为`{receiptId,eventId,cursor,controlId,fenceRevision,complete:true,assetInstanceId,closedLeaseIds,retainedLeaseIds,evidenceDigest}`，可信service identity由TLS提供；同cursor同摘要幂等，同cursor异摘要409，低cursor不回退。events接口不返回prompt、human credential或raw ticket。ready/status增加`runAssetsConfigured,runAssetCursor,runAssetHead,runAssetsReady`；只有配置required且两日志齐头、旧实例unknown已消歧才能true，由trusted status构造，不收public setReady。

连续consumer锁只保护cursor/receipt提交，不能持该锁await一个又调用同consumer.sync的run recheck。run资源事件处理先同步pause，随后调用独立doc run provider核已持久事件；doc可返回当前权威结果，但不能等正在生成的asset ACK。同样不持project/coordinator写锁等待asset receipt；operation与asset实际关闭并行起屏障，最后在锁外组合证据。A/B必须用真实撤销事件+retained recheck+丢ACK证明无环等待，而非手动推进cursor。

control receipt含`{controlId,fenceRevision,receiptId,assetInstanceId,serviceIdentity,closedLeaseIds,retainedLeaseIds,actualClosed,complete}`，retained项必须doc结果仍允许且不在control.revoked；unknown旧instance/cgroup/worker不complete。本实例trueReadable `_destroy` gate、FileHandle close、req/res及TCP close都完成后才写receipt；HTTP finish和计数0不算。重启先旧asset生命周期claim/marker与可信root OS/cgroup空证据，复用既有asset-lifecycle机制；没有证据就ready=false/ACK pending，不借新进程空Map。

doc完整run control ACK仍组合operation fence、doc transport、asset资源、Agent工具/子进程及历史OS证据。F0最多证明自身asset闭口；ToolJobs.cancelForFence只状态更新，不能取代runner drain；ToolContext没有signal这项依赖必须由实际宿主接。active→retained的新fenceRevision若导致已有Jobs不能update，由Jobs owner按真实provider结果补受控checkpoint迁移，不把合法任务取消或在资产层伪报旧revision。

## 6. 两个功能小包与唯一glue

以下为**建议租约**，root建新叶后核空并分配；本设计叶不创建它们。端口建议A6470～6479/B6480～6489/G6490～6499，不是已获租/已核空；优先真listen(0)独占fixtures，full由root串行租。所有server tests不import scripts，child windowsHide并等close，只TMP、cuda_Vit/process-only models/preload；不install/junction/global环境。

| 包／模型／依赖 | 独占文件建议 | 独立完成点与闸门 |
|---|---|---|
| A：doc资源票据与三方证明／Sol；先行 | 新`server/account/run-assets.mjs`、`run-assets-internal.mjs`、`run-asset-protocol.mjs`；专用`server/test/run-assets-*.test.mjs`及报告。只交换callbacks，不编辑doc-agent-assembly、authority、instanceAuthority、run-authority、operation底层 | 交`createRunAssets({ledger,runProvider,authenticateDirect,authenticateObserved,resolveMedia,now,ticketTtlMs})`、handler、protocol tuple、outbox/receipt接口。真实doc SQLite/instanceAuthority＋独立asset observer mTLS＋Agent RAM key：retained/current/instance/proof/resource边界、mint丢ACK/restart/nonce并发、heads失联、scope不能改write。缺任何可信callback503；fixture不能free allow |
| B：独立asset数据链与ProjectAssets／Sol；A协议固定后 | 新`server/hosted/asset-run-access.mjs`、`asset-run-client.mjs`；新`server/agent/service/project-assets.mjs`、`run-asset-client.mjs`、`tool-assets-resources.mjs`；专用tests/probe/fixtures。窄独占`server/asset-store/project-access.mjs`generic生命周期与`project-revocations.mjs`单consumer参与者hook（须root单独授租，不改已验publication/store语义） | 注入真实A handler，真独立asset进程与physical projectStores；GET/HEAD/Range/chunks/PUT/complete/verifyRef，真实import哈希与重试；close/retainedpause、actualfd与publication gates、重启receipt。projectAssets.signer来自可信宿主，测试用真实注册key，生产缺signer/resource宿主503。不碰worker instance/main/runner或旧humanclient |
| G：唯一中央glue／一个Sol；A/B和worker固定后串行 | 窄`server/hosted/{doc-agent-assembly,doc-assembly,asset-runtime,combo,main,files}.mjs`；`hosted-tools.mjs`仅accountMode ProjectAssets注入。Agent worker仍由其owner修改`agent-instance-session/run-client/account-runner/instance/main`，G只消费其冻结exports；若root移交才租，禁止并行改 | 接真实current registry与remote observerRAM adapter、coordinator.read历史selector、asset HTTPS固定入口/双head、run controls真实resource参与者，精确部署闭包。ordinary auth.ticket仍禁、runTicket503不为素材开通而放宽。真实VH327/provider/order→combo→独立asset→Agent消费者→doc op登记；最终type/target/一次有因full、原asset/central回归。真实模型调用在工具总Glue验证，不用模拟模型冒称 |

worker需交接口`createRunAssetTransport({docOrigin,assetOrigin,peerPins,...})`或等价窄受信facade：同一现instanceSession注册/RAM key，对允许的issue及asset资源tuple签名，不能给工具原始key或通用任意operation signer；不得复用runData HTTP cap。当前proofFor路径硬闸是明确依赖，A/B可用真实独立fixtures先实施，生产G缺此export保持503。旧宿主`hosted-tools.assetClient`20秒cache不用于accountMode；LAN/local保持旧路径。

facade建议导出`issue(body)`及`request({method,url,ticket,resourceRev,projectId,runGrantId,action,requestId,importId?,chunkIndex?,range?,bodyFile?}) -> {status,headers,stream,closed}`。url只接受配置assetOrigin和上列固定路由；method/path/purpose/action由固定表匹配，bodyFile只接受workspace内部已登记spool引用，不让工具传任意本机路径。facade自己建立pinned mTLS socket、核server cert、取exporter、构造完整tuple/nonce并签名，再发送原字节；工具拿不到签名函数、key/exporter。worker owner实际固定接口可以等价调整参数名，但必须先交协议目标给A/B，不能只给一个可签任意request的hook。

A只提供接口，B只拥有通用lease窄处，G唯一改中央；root不承担大多数实现。包A与B分branch/worktree，A协议冻结后B可先用真实A fixture；worker在自己租约开发signer时两包不写其文件。A/B报告列源码固定SHA、所有首红、provider和closure真实程度，纯adapter完成与中央挂载分别标。

## 7. 可执行验收矩阵与Linux证据

| 场景 | 必须实际观察的结果 |
|---|---|
| A/B项目同hash | A入库B未入库→B404；B独立入库后两边均可读；错project票据/explicit query403；删除A机制fixture不影响B，不代表批准生产删除 |
| 真实身份 | 无cert、错Agent/asset cert、同cert新OS、伪instance/bodyactor/creator、proxy header、exporter缺失/另socket replay拒；cap字段不回HTTP、不落DB |
| scope与字节 | project.open/resource读不误分类write；read proof不能PUT/complete；Range/chunk/size/ext/body/protocol改变拒；partial/超限/abort不能按空正文签名通过；hash mismatch未发布 |
| retained | 真发送→admit→read-confirm；撤发起login或kick后旧页面/旧assetTicket拒；原registered已读共有run openRead/import成功；不得新admit/新message，private/stop/off/delete/revoke实例随后拒 |
| 在途撤销 | 真慢Readable `_destroy` callback gate、异步open+FileHandle gate、HTTP finish先于source.close；此时ACK仍pending；放close gate后receipt持久并可重放。paused retained重验成功后继续，不错误终止合法当前轮 |
| 入库竞态 | assert后/rename前、marker后、rename后/marker移除前、登记doc op前分别撤销；未接受target不读，不新增media记录，不删除别合法同hash；已接受字节不假报已登记 |
| 幂等与重启 | 同request同digest副作用一次、改digest409；并发nonce只一方admit；doc epoch重启旧ticket拒/新proof恢复；asset cursor gap/乱序/重复/丢ACK重放原receipt；observer换socket/同cert新asset进程不能接旧lease，断通道不当全资源已关；crash历史OS未知不complete |
| Jobs/context | forged8字段context拒；authorize逐调用，无signal/resource注册宿主503；Jobs cancelled≠子进程关闭；active→retained revision迁移未接明确失败而非绕过 |
| 中央真实链 | 真实账号provider、当前服务registry、三个独立TLS/进程、ProjectAssets消费者实际字节SHA、exec.mutate接受署精确run actor；无手动ready/free verifier/人类token续借 |

包A/B每固定完整块：`npm.cmd test -- server/test/run-assets-*.test.mjs`／各包精确目标（PowerShell先展开实际文件列表），`tsc -b --force`；full只root分配唯一租约后一次，失败分类、有源码变化才有因复验。产品probe拟`node scripts/probes/cloud-project-assets-probe.mjs --doc ... --asset ...`，凭证只环境/私有TMP，安全输出步名/count/耗时/关闭证据，不打印cookie/token/ticket/key/proof/exporter。本纯设计不运行这些命令或宣称通过。

root Linux阶段从固定Git精确部署闭包TMP树真实import/start：Node TLS exporter双端签名、专用doc/asset/agent UID及privatekey不可互读、WAL/FULL与file+目录fsync、source/fd/TCP actualclose、两项目物理store、receipt丢失/正常进程crash恢复。保留异常symlink/backupmissing failclosed；Linux正常重启和syscall成功不等物理掉电验收。生产备份/自动备份/恢复、服务元组、旧cgroup空证明与部署由root/ops负责，不让功能叶操作节点。只有真实Linux入口与最终公网TLS部署验后才记相应状态；本机mTLS fixture不是不同OS UID或真实网络证据。

## 8. 本设计交付的未完成项

本文件使A/B可立即派工，不声称project-assets源码、API或授权已经存在。跨角色可信TLS观察adapter、worker signer、generic run pause策略、双head/outbox与完整control参与者是必须实施的接缝；任一缺失生产保持503。ToolContext取消signal、Jobs合法retained checkpoint与实际worker停止由各owner另接，不纳入“已有功能”。private visual bytes/渲染snap/px的对话ACL资源票据不借F0 media票据旁路，另由V1/render包实施。未决定的产品语义与资源数字都没有被本方案选择。
