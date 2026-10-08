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
