# 018-cloud-doc-assembly

开工：分支codex/018-cloud-doc-assembly，工作区018-cloud-doc-assembly，固定base80b5e658。旧asset叶保持冻结；本叶独占中央装配，先约接口，不复制账号/项目/run权威。

目标：真实v2 doc中央挂已验operationCoordinator、持久operation history与account order transport、全员selection authority。selection.set/clear逐消息read；project.op继续write。retained/read/run callback消费Astra新可信接口，缺接口生产failclosed，不用局部fixture声明生产完成。与对话ACL/FIFO owner约跨模块schema，互不改provider模块。

租约：server/hosted/combo.mjs、main.mjs、files.mjs；新account-assembly tests/probe与本报告。根清单提到的server/account/hosted-runtime.mjs和account/http.mjs实际不存在，已按rg报告真实路径docservice/account-hosted.mjs、http-transport.mjs、service-gate.mjs及shared-service.mjs装配位置，必要路径扩租待根确认后才改。operation-wiring、project/history/password-order/asset底层、Agent UI、主文档与部署参数不改。

验证：仅5770–5779自有服务，根正占5823–5829/5860–5869全量段，本叶不占；full先申请租约。临时真实provider→中央→独立asset→两页面WS验证create/join/read/op身份、projection/restart、readonly选区/伪名拒、旧凭证resume拒、逐次grant/fence核验和required缺配置拒。固定完整块后type --force/必要target/full；首次失败原样保留。所有子孙windowsHide、Node绝对父仓库test-silent-processes预载、只TMP产物/进程实际close；Python按cuda_Vit/PYTHONDONTWRITEBYTECODE，仅必要时进程models主out/models。不npmci/junction/依赖升级，不push/merge/节点/用户数据。

语义边界：按brief5/8/9/11与三版本设计、render补充执行。删除细节/提前让位/补渲故障A/B仍未批准，本包不裁。应用仍.17，.18 required和后续节点部署由根负责；本叶不宣称独立provider已验证等于中央生产接通。

初始实际API：createOperationWiring({history,account,verifyWitness,authority,projection,docAuthorityId,runProvider,docAttestationPrivateKey,...})；coordinator绑定project adapter，read/execute内部反复核authority，runProvider缺失/精确字段缺失拒。createAccountHostedRuntime实际位于server/docservice/account-hosted.mjs；全员选区module独立，中央未挂。run-authority owner已确认新模块尚未实现，会先交checkAccess/selection authorizeQuery schema，不能把proposal当已存在。

## 中央 API 图与租约修正

根已确认实际租约为`server/docservice/account-hosted.mjs`、`shared-service.mjs`（constructor/可信callback/逐消息read-write直接接线）和`service-gate.mjs`；http-transport不改。额外已批准新`server/hosted/doc-assembly.mjs`、main窄order配置和旧asset-wiring/account-hosted测试必要真实order setup。

路径：public `/hosted/shared/account/create|join|session` → runtime authority → 每次真实asset mTLS status双head核齐 → opaque connection/asset/agent delegation票据。页面WS → account RAM引用每条凭证/项目重核 → shared tenant bundle → projectModule绑定该tenant唯一operationCoordinator → 单个持久`docservice/operation-history-v2.sqlite` → doc自有证书mTLS `/internal/v2/order/reserve|<id>|<id>/seal|cancel` → account签名sealed →同一prepared历史和真实tenant项目projection。跨项目共用历史库和order连接，不共用project module/coordinator绑定。

`createDocAssembly({dataDir,authority,account,runProvider,now})`返回`coordinatorForSpace({space,store,directory})`、`selectionForSpace({space,project})`、`fence(value)`、`history`、`runProvider`和异步`close`。close在doc实际关闭后等所有coordinator.idle再关SQLite/transport。投影路径必须等于可信dataDir/tenants/space；local不创建coordinator。运行授权与selection query只转可信provider，缺出口503。

main只加载doc自己的account client/private attestation key与account公开witness keys：`PROMPTCUT_ACCOUNT_ORDER_WITNESS_KEYS_FILE`为`{keyId:PEM公钥}`JSON，`PROMPTCUT_ACCOUNT_ORDER_ISSUER`默认visuhive-account，`PROMPTCUT_DOC_ORDER_ATTESTATION_KEY_FILE`为doc自有Ed25519私钥。真实运行不读其它角色私钥；测试仅TMP临时CA与角色证书。REQUIRED缺order配置启动拒；非法/空公钥和不完整attestation也拒。

全员selection已挂每tenant实例：set/clear显式read，客户端伪名/account/actor声明拒；project.op保持write，actor从真实principal取。Agent delegation独立kind随机票据，session返回`agentDelegationTicket`，resolver重新核live credential/head/project；asset票据不能代它。对话owner新mTLS路由消费resolver，UI尚未送此票据，不能声称生产Agent接通。

Astra已定`createRunAuthority`出口checkAccess/authorizeQuery/resolveRunPrincipal；运行principal必须带从真实签名或mTLS核验所得servicePrincipal，公开runRefs不构成凭证。run尚未提供固定源码，当前生产run/query仍拒。root已扩租authority窄同步runHooks事务接线，待owner完整签名，禁止后置自由授予。对话owner正在写独立conversation internal handler/client，未在本块假接通。

当前状态：页面/history/selection完整块待固定源码定向验证；所有首次失败、重启/权限边界和准确计数将在后文追加。尚未跑全量；full须先租约。

## 首轮固定源码证据及依赖暂停点

页面源码bc6e5a42，fixture修正324ca429。target-1 `npm test -- server/test/account-assembly-central.test.mjs`：2项/1通过/1失败/0取消/0跳过，3700.3072ms；首次真实admin返回409 access-revision-mismatch，因为本新fixture漏expectedAccessRevision，保留TMP/pc-doc-assembly-target-1.log与child-1791422201304.log。补真实当前accessRevision，并按真实只读权限码not-listed核断言，未弱化版本/权限。

target-2固定324ca429，同一测试：2/2/0/0/0，4086.7212ms，TMP/pc-doc-assembly-target-2.log及child-1791422248533.log。真实临时account+order mTLS→中央→隔离部署树独立asset child→两页面WS，验证一条操作orderSeq=1、完整before/after/change项、真实actor、readonly选区/伪名拒/写拒、重启projection/history恢复、delegation种类/restart作废、退出后旧凭证session/resume拒和required缺order配置拒。缺runProvider的拒绝已测；不将此冒称实际run或生产Agent通过。

authority同步钩子源码03ee7fd1。定向`account-assembly-fence-transaction.test.mjs`：1/1/0/0/0，118.5064ms，TMP/pc-doc-assembly-fence-1.log。实际provider与SQLite验证admin/revocation transaction内同步hook，throw/thenable整事务回滚，agent-off空affected仍通知，off→on→重启保留immutable service/enabled。该测试hook仅在真实事务中写受控证据，不是实际runGrant provider；receipt仍pending/null。原account事件seq/权限策略保留，缺hook且已有durable grants拒，page-only无grant不会自由授予run。

后续runtime增量新增trusted getRunProvider/onRunControl、每消息/resume run核验，先关受影响page再处理run持久control，保留run要求provider返回精确retainedGrant。Agent-off不会误撤普通page。缺provider或失败关闭run，不自由ACK。本增量尚待真实run模块组合验证。按根指示固定此暂停点并停止编辑，由root组合conversation来源b25e5de8；不自行cherry-pick/merge。types/full尚未运行，待完整依赖固定后必要验证。

## 可信选区与专用真实连接关闭

选区源码e662aaf7：`captureSnapshot`只接受服务端principal/projectId/pageId，从现存未blocked、非synthetic的live entry取选区；账号/login/credential/generation四字段和page精确匹配，检查前后重新核live authority与entry对象身份。空选区真实输出空clipIds，不采客户端selection/name，不给离线发送兜底。独立target `account-assembly-selection-capture.test.mjs` 5/5/0失败/0取消/0跳过，78.1451ms，TMP/pc-doc-assembly-capture-1.log；尚非Agent UI送票据闭环。

根窄扩租`server/docservice/service.mjs`、`http-transport.mjs`、`session.mjs`供dedicated fenceConn；常规close/tail-replay契约保持。源码8ba09633新增：同步会话fence丢未确认帧、SID立墓碑，真实WS TCP close Promise；HTTP请求/响应actual close及其已关联keep-alive socket保留到真实socket close（HTTP finish/res close不能代socket close）；精确fencePrincipals覆盖已在异步authenticate期间的admission registry并阻止旧身份晚入场。清逻辑连接不是ACK，返回receipt仅代表这些已关联doc transport实际关闭，未代表Agent工具/进程或跨重启OS已闭口。

首轮新受控target固定8ba09633：4/4/0失败/0取消/0跳过，2151.9183ms，TMP/pc-doc-assembly-transport-fence-1.log。实际HTTP已end而keepalive TCP仍open时，覆盖server owned socket `_destroy` callback gate：describe=0、old SID recv/resume=410时receipt仍未完成，释放callback且实际closed才完成。其它测试覆盖held LP GET和未完整读取POST的两个socket分别释放、WS actualclose、异步authenticate前后窗口；所有gate仅替换该测试创建的socket实例，不碰其他进程/socket/global prototype。

原三份transport/session回归固定8ba09633：33/33/0失败/0取消/0跳过，5535.9877ms，TMP/pc-doc-assembly-transport-regression-1.log。原`listen(0)`由OS原子分配临时端口，按root确认保留原形态，未加映射preload；准确临时端口未在原fixture输出中留存。正常LP关闭仍先交尾帧再closed，WS正常接续/确认/保留期/普通close等原断言保留且通过。

审查追加窗口：WS已accept/LP已处理resume，但异步resumeGate未回时，尚未成为current transport的socket也须立即绑定可信旧SID对应conn。ac3bd9a2只增加该等待窗口的owned资源登记与真实close追踪，不放宽resume权限；new unknown SID没有任何actor绑定，仍按原拒绝流程处理。固定ac3bd9a2复验新6项（含WS/LP pending resume）和原33项：39/39/0失败/0取消/0跳过，5574.3443ms，TMP/pc-doc-assembly-transport-fence-2.log。pending resume actualclose前receipt保持未完成；释放后即便异步gate后来返回，旧session仍不能恢复且无welcome。定向固定端口5775–5779；结束5770–5779零监听。

当前关闭证据边界：这些受控测试证明当前实例的doc owned TCP/HTTP/WS句柄，而非重启旧instance/cgroup、Agent实际资源停止或完整跨服务receipt。那些缺可信证据继续pending，不能用describe或fixture free ACK补齐。Astra scoped control+accepted-message专用核验接口仍待root组合；普通verify-actor存在access TTL反例，不能用于已经accepted的持久queued message资格。此次未跑types/full，full须租约；前面的源码证据不能冒用为后续全量结果。
## 身份字段独立修复与入场 cohort

根/Astra真实WS发现normalize字段缺口，未用fixture重造身份绕过。独立提交36584287只在`PRINCIPAL_EXTRA`补`servicePrincipal`、`serviceId`（`serviceKid`原已存在）；只复制authenticate已认证对象，消息body的同名字段不进入actor。新增`account-assembly-principal.test.mjs`含旧userId/tenantId精确兼容、未知字段drop、nested独立clone和真实WS模块收到完整可信身份、消息伪身份不替换。固定365产品源执行target：1/1/0失败/0取消/0跳过，2117.9833ms，TMP/pc-doc-assembly-principal-1.log。测试前把尚未提交cohort服务源保存TMP，再写入固定365 Git对象；跑程不改源，结束后恢复cohort编辑。该独立Git对象已交Astra/root，不借脏工作树作为依赖。

cohort源码a43b1430。`fencePrincipals`每个scope独立持有条件与入场rows：fence开始时已有admissions，以及条件有效期间新admissions，都记各自cohort；authenticate返回后核其历史cohort和当前条件，即使瞬时全局条件后来移除，也不能让该旧entry拿过时核验结果入场。receipt先等现存连接真实close，再动态追齐cohort直到所有未知鉴权结算、所有受影响socket实际close；未归鉴权仍pending。scope无关的已确定身份不被destroy，不宣称它已关闭。最后检查与删除本scope瞬时条件不跨await，并发scope不会互相移除。

条件精确字段为accountIds/loginIds/runGrantIds/serviceKids/roles及projectId。永久仅保留不可复活旧loginIds/runGrantIds/被撤serviceKids，accountIds-only、project/Agent开关范围只覆盖本次屏障；失败未结算时条件继续failclosed。屏障后新的合法join/login/run仍须上层live authority/head核验，底层不永久禁账号/项目。新增core fixture证明条件生命周期和身份区分，不冒称已完成真实run provider的off/on、服务key登记或Agent停止闭环。

固定a43 target `account-assembly-fence-transport.test.mjs`+principal：10/10/0失败/0取消/0跳过，2151.1783ms，TMP/pc-doc-assembly-cohort-1.log。覆盖开始前/开始后未知auth晚归、受影响_destroy未释放保持pending、无关同账号其它项目live连接保留、同账号旧有效login屏障后合法重入/新login、并发两fence A结束不能撤B条件、project-only Agent条件退休、旧runGrant/login/serviceKid拒而新引用允许。所有新固定端口5770、5775–5779均本叶拥有；不改原普通close/resume断言。

同固定a43原transport/session回归33/33/0失败/0取消/0跳过，5555.5235ms，TMP/pc-doc-assembly-cohort-regression-1.log。`node <父仓库node_modules>/typescript/bin/tsc -b --force` exit0、零类型错误，6999.9083ms，TMP/pc-doc-assembly-types-1.log；源码在两项并行独立检查期间固定。未跑full，仍待根租约与Astra最终依赖组合；现有type/target不能当整个中央生产接通。report提交后工作树clean，继续按root停点等待固定依赖，不自行合并。