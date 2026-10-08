# 云端 run assets 权威 A 包报告

固定基底712dda863a48460002f343c99c3feb4907f7e968；工作叶018-cloud-run-assets-authority。目标是实施已审F0设计的doc资源发行、实例/资源精确再验、连续控制outbox与持久lease/nonce/receipt模块，保持现run authority唯一判权，不复制ACL或retained规则。

独占仅新增server/account/run-assets.mjs、run-assets-internal.mjs、run-asset-protocol.mjs、server/test/run-assets-*.test.mjs及本报告。原authority/instance/run provider、operation、中央/worker/asset/Jobs全部只读。当前状态：A模块已实施并定向验证；最终产品/fixture固定91d4e28478f98d9eab75c22152be63eb7ee4628a，协议固定909a6b964a2bd741c4f58ef594305cb6b77a66ee；本次最后只提交报告，不代表中央或生产接通。

根C10占用宽探针/full，当前禁止所有listener（含listen0）及full/服务/节点；仅无监听pure精确npm目标、绝对tsc。真实mTLS目标可编写但等待根窗口后执行，不将受控adapter当真实TLS证据。每次首红保留，源码固定后才运行，不改全局环境/安装依赖/用户数据/密钥。

上述为开工限制；root随后明确准原npm global-setup坏端口guard唯一例外（19端口×IPv4/IPv6共38候选，已占跳过，正常teardown关闭），不准mock/bypass setup。最后root仅授固定91d4一次doc/asset两个listen(0)真实mTLS目标，已执行并释放窗口；全量始终未授。本报告不事后改写首次限制。

## 实际模块与消费接口

协议：`server/account/run-asset-protocol.mjs`，SHA256 `d44879481a93af8c86aa258b5349084e25753c8f93ba814ec28ebe5c2e85d777`，Git/工作文件均LF。root负责只复制这个冻结文件到worker，后续格式变更协调唯一来源。

公开exports：RUN_ASSET_ROOT、RUN_ASSET_DATA_ROOT、RUN_ASSET_PROOF_HEADER、RUN_ASSET_OPERATION；validateIssue、runAssetIssueRequest、decodeRunAssetBody；assetHttpTuple、validateAssetHttpTuple；validateAssetRef、resourceRevision、assetRefId、ticketDigest、bytesDigest；requestProof、exactShape、reference、hashOf、failRunAsset。没有私钥/通用自由签名export。

`runAssetIssueRequest({body,bodyText})`返回精确`{v:1,purpose:'run-asset-issue',projectId,runGrantId,action,body,bodyText,bodyDigest}`。body是六字段projectId/runGrantId/action/requestId/purpose/selector；action由purpose固定，selector不含身份/path。bodyText来自实际完整UTF8 wire，fatal decode，不剥BOM、不替换非法字节；parsed body必须匹配。缺bodyText拒400，不能猜JSON.stringify或默认空串。worker签这个descriptor，但HTTP发送原bodyText对应body，不把descriptor作为wire body。普通/runs原签名格式未改。

assetHttpTuple精确含v/purpose/projectId/runGrantId/action/ticketDigest/resourceRev/nonce/requestId/method/url/range/contentLength/contentDigest/contentType及可选importId/chunkIndex，实际字节/Range/完整路径由asset观察方独立取；固定media路由、方法与action匹配，不授snap/px或全局hash。GET/HEAD必须真空body摘要。Agent proof独立header，operation为checkAccess。

`createRunAssets({ledger,runProvider,authenticateDirect,authenticateObserved,verifyObserver,resolveMedia,verifyLeaseClosure,verifyControlReceipt,verifyRecoveryClosure?,now,ticketTtlMs})`。所有非可选callback与真实ledger/provider方法、时钟、TTL缺失503；没有自由allow默认。exports返回：

| 方法 | 精确输入／结果与所有权 |
|---|---|
| issue | `{body,bodyText,transport,proof}` → `{ticket,expiresAt,ticketId,resource,resourceRev,mediaRev?,projectRev?,kind?,fenceRevision,grantState,docEpoch}`；角色transport来自真实req |
| check | `{ticket,request,proof,observation,observer,leaseId?}` → `{allowed:true,leaseId,projectId,action,resource,resourceRev,grantState,fenceRevision,accessHead,runAssetHead,docEpoch}`；无principal/cap；leaseId仅同原observer continuation |
| closeLease | `{leaseId,observer,receipt:{leaseId,receiptId,complete:true,evidenceDigest}}`；真实callback已关才事务closed，重复同receipt幂等，改变409 |
| recoverLeaseClosure | `{leaseId,witness}`；只有unknown且配置可信恢复验证器true才closed，普通RPC不暴露此方法，不凭新进程空Map |
| synchronize / eventsSince | 实际provider同步，镜像ledger原controls；eventsSince(after)返回连续最多100个events＋全局headSeq，gap/corruption拒503 |
| acknowledgeEvent | `{eventId,observer,receipt}`，receipt完整绑定event/cursor/control/fence/assetInstance与closed/retained lease清单及evidenceDigest；actual callback和持久lease均核后才ACK，重复精确、低cursor不回退、异内容409 |
| close | 禁新admission、清RAM引用、移除owned observer close listeners；它不是远端资源关闭receipt。G必须先收实际HTTP dispatch/handler再关闭ledger，不以这个方法当Agent/asset drain |

authenticate callback实际入参为`{transport?,observer?,observation?,proof,method,path,operation:'checkAccess',request}`；返`{servicePrincipal,release}`，必须和同一个instanceAuthority互操作。issue的request是上列原文descriptor，observed request是assetHttpTuple。servicePrincipal仅内部RAM，module从同ledger真实grant重建actor，调用runProvider.checkAccess，完整await selector和第二次gate后finally release；不能body填actor/authorizationId。atCommit校验不可变grant绑定/current状态/fence/readReceipt，runtime epoch改变拒晚发布。

verifyObserver同步返**精确三字段**`{socket,assetInstanceId,serviceIdentity}`；trusted callback实际拥有current pinned mTLS socket/登记，不能由observation自报。每lease绑定doc见到的同一observer socket RAM标识，换连接或旧epoch拒。socket close先撤RAM admission并持久unknown，失败全模块failclosed。authenticateObserved的私有subject要由G接现service/instance两个callback，A不改它们也不绕现核验。

resolveMedia返精确`{resource,mediaRev?,projectRev?,kind?}`；resource为`{projectId,ns:'media',hash,size,contentType,ext?}`。必须在当前coordinator.read恢复投影下按mediaId/tier解析，或import/verifyRef的准确本项目metadata；A不直接读store/字节。原MediaTiers.small只有hash，缺实际size则503。G/B需可信stat callback提供small实际size，不能借original.size。callback不配置或返回虚假跨project被拒。

`createRunAssetsInternalHandler/Server({runAssets,agentFingerprint256,assetFingerprint256,resolveObserver,maxBodyBytes,tls?})`，两角色pin必须不同，实际authorized/nonclosed TLS exporter存在；拒proxy headers、非固定method/path/query、超大/截断/aborted/非法UTF8原body。maxBodyBytes必配，不引入新内存默认数字。issue只Agent cert，其它只asset cert；resolveObserver每次force当前登记，只从actual socket取可信启动identity。

路由：POST /internal/v2/run-assets/issue、check、leases/:id/check、leases/:id/closed；GET events?after=N；POST events/:eventId/ack。issue沿INSTANCE_PROOF_HEADER；asset RPC只含ticket/request/originalproof/observation，不收public complete/actor。HTTP结果统一`{ok:true,result}`或`{ok:false,code}`；无cap/token/authorizationId序列化。

## 持久状态与失败边界

同现SQLite ledger使用runAssetsEpochV1、runAssetIntentsV1、runAssetLeasesV1、runAssetNoncesV1、runAssetControlOutboxV1、runAssetControlMirrorsV1、runAssetAcksV1。没有另建权限库，未改原schema/state含义。raw票据、instanceSession、servicePrincipal只RAM，不入intent；随机启动epoch同时持久为当前代际，旧runtime不能继续新admission。admitted在新runtime/observer断连变unknown，缺可信恢复证据保持pending。

nonce在验原签名、两次当前权威与准确resource之后，同SQLite事务claim；并发只接受一次，失败proof不占nonce。same request/digest原进程返同RAM票据，重启原requestId报ticket-epoch-lost，新requestId重新证明；同importId后续实际入库幂等归B。票据有期限，read/write/purpose/hash/project/instance/readReceipt绑定都实时再验。

连续outbox从现runControlsV2复制不可变字段，独立seq，无正文/凭证。保留原retained/revoked/instances/operationFences，不另推导ACL或当前开关覆盖历史。只有instance-revoked按全实例资源清单；普通stop/credential不能误关闭同一Agent实例的其它current run。asset receipt仅本角色证据，**不会**调用runAuthority.acknowledgeControl完成整轮；operation/doc/worker/历史OS完整组合仍归G。zero-grant inventory也交可信callback核，不因清单空就默认true。

verifyLeaseClosure/verifyControlReceipt/verifyRecoveryClosure必须由真实资源/OS witness宿主实现，body的complete/count本身无证明力。当前没有中央/B实现这些callback；生产缺则503/pending。A模块不执行资源关闭，也不声明ToolJobs有执行停止；真实Readable gate只证明受控单资源收据切点。

## 首红与逐固定源验证记录

所有命令经npm原wrapper，Node绝对父仓库silent-processes预载；PSModulePath移除大小写别名后只保留canonical一键。cuda_Vit/PYTHONDONTWRITEBYTECODE/主out/models仅过程env；真实VH018-active-run-order provider/password-order与本叶conversation模块显式设置。pure fixture的sender是受控adapter，不因为env配置就冒称已调用真实VH。

| 固定source／步骤 | 命令与raw日志（TMP） | 原始结果 |
|---|---|---|
| 837c00cd 首纯目标 | npm.cmd test -- server/test/run-assets-authority.test.mjs；pc-run-assets-pure-1.log | 7/7，0fail/cancel/skip；292.0061ms，墙578.56ms |
| 6d457d15 受控反例 | 同目标；pc-run-assets-pure-2.log | 9项7pass/2fail；348.179ms，墙626.71ms。控制inventory误纳同实例另一run，ACK报closure-pending；outbox seq损坏未拒。首次失败保留 |
| cb05fe30 因果修正 | 同目标；pc-run-assets-pure-3.log | 9/9，0fail/cancel/skip；359.6403ms，墙639.44ms。只限定实例fence范围＋连续日志校验，没有改权限/降低断言 |
| b0a3c0e3 原文反例 | npm.cmd test -- server/test/run-assets-authority.test.mjs server/test/run-assets-protocol.test.mjs；pc-run-assets-raw-red-1.log | 14项13pass/1fail；377.9547ms，墙654.84ms。非法UTF8实际200而应400；parsed-only签名缺口按root审查补，不伪称原文已验 |
| 909a6b96 修原文并复验 | 上述两目标；pc-run-assets-pure-4.log | 14/14，0fail/cancel/skip；401.4412ms，墙679.83ms。descriptor实际签bodyText/shaExactBody；缺原文/改空白/改selector/方法/路径、非法UTF8均拒 |
| 909a6b96 类型 | node C:/Users/admin/Documents/PromptCut/node_modules/typescript/bin/tsc -b --force；pc-run-assets-type-1.log | exit0/零错误，墙6773.77ms。之后6938新增MJS epoch保护及新pure用例，**未冒称这是最终91d4的类型复验**；根共同候选再验 |
| 91d4e284 唯一三方TLS窗口 | npm.cmd test -- server/test/run-assets-observer.test.mjs；pc-run-assets-mtls-1.log | 1/1，0fail/cancel/skip；suite896.9789ms，用例817.4903ms，墙1189.37ms，nativeRetries0。工具流测前/后SHA同91d4；没有事后造测前截图 |

6938的当前epoch保护、trusted stat缺失503已由最终真实TLS目标实际进口/发行/admission覆盖，但新增“两个factory代际并行”pure用例尚未单独运行；不将先前14项当该新断言通过。7ef新增真实TLS fixture，91d4只补整例60s/单请求10s期限；protocol字节从909未变。全部产品运行尝试均列以上，未为赌绿同源重复。

首语法检查三新MJS exit0；首次是exec管道直接node --check（无child/窗口），随后fixture check与实际npm均带绝对silent预载。只读找错run-authority.test.mjs/agent-instance-mtls.test.mjs/account-pki-fixture.mjs，rg定位实际core/fixture/tls/asset-wiring-pki；PowerShell rg glob password-order*.mjs一次无效。均未读真实秘密、启动未知进程或改测试断言。

## 真实TLS证据与精确限制

实际doc/asset两个HTTPS OS临时端口4274/4275，Agent是HTTPS客户端。角色各用TMP独立CA叶证书：fixture account cert扮Agent、doc cert扮doc、asset cert扮asset；不读生产key。真实instanceAuthority登记RAM Ed25519 key，run admit/read/check用既有provider；完整实际TLS exporter proof。目标实证：same observer continuation200/new observer403；原文空白篡改403；错角色cert403；新TLS旧proof403；fresh签名重复nonce403；原已读共有run撤登录后读取200；stop后403。

teardown真实等owned TLS socket close、两个server.close、pending closingRequests及SQLite/instance authority关闭，所有data/key只有本例TMP pc-run-authority-*。Node正常自然exit0；工具流结束Get-NetTCPConnection核4274/4275 listeningAfter=[]，源码status为空。npm坏端口guard是此前准许的临时例外，suite自然teardown。没有打印cookie/token/ticket/key/proof/exporter；未终止其它进程。

此fixture两个server同一个OS进程，sender/currentregistry/media projection与closure verifier是受控adapter。没有证明生产三进程/专用UID、真实account provider、新B projectStores、asset publication/fd/worker全链、外网/节点或全量。纯目标Readable真实_destroy gate→close前无receipt/ACK，只是单资源边界，不能替代历史cgroup或全部Agent停止证据。窗口一次通过后已向root释放并冻结，不追加服务/full。

## 交回与后续

只新增三模块/三目标/报告，无原lease之外编辑，无main/merge/push/节点/版本/进度或依赖安装。G需接两个私有subject/current registry callback、恢复后coordinator read/stat、实际asset关闭与control参与者，B实现项目物理store和upload/import/read字节；worker只消费root复制的冻结protocol，同RAMkey窄签名，不给模型key或任意signer。ToolJobs retained checkpoint/actualresources仍各owner接，不由A偷改。

未做全量与最终强制类型是根共享窗口明确限制；root已决定no-ff到统一configured候选再验。本叶本次最后只提交报告，产品和protocol保持91d4冻结。除独立模块协议与上述目标，不声明生产入口ready或账号模式已完整接通。
