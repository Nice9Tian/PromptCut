# 0.7.18 文档服务账号项目唯一权威实施报告

2026-10-08。独立包 `codex/018-doc-authority`，工作区 `.worktrees/018-doc-authority`；起点986ebec6，已审账号协议前置合入HEAD278e08df。先读入口规则、方案与产品语义，再按已授权19包设计实现，不另裁调度补充的待确认产品决定。

## 范围

唯一源码范围为 `server/account/{client,authority,ledger}.mjs`、`server/docservice/modules/account-projects.mjs`、专属 `server/test/account-projects-*.test.mjs`；按需要新增 `scripts/probes/account-projects-probe.mjs`与专用fixtures。先交稳定mount/authorize/applyRevocation/list接口与夹具，再真实account provider/mTLS、隔离A/B账号、幂等/禁入/踢全设备/重启事件缺口等验证。账号provider580bec8只读引用，旧foundation与C10工作区保留。

不改中央接线、order、素材、Agent/UI、LAN规则，不安装/junction、不merge/push/main/version/部署/真实数据/清理工作区。5750～5759独占；Node子进程windowsHide与file:///绝对静默preload，Python需要时显式cuda_Vit及禁止pycache。最终记录每次真实失败/修正、types/目标/完整npm结果和未挂载边界；模块通过不能冒称生产云项目已通。

## 首批稳定接口（模块夹具，尚未中央挂载）

`createAccountClient({origin,tls:{key,cert,ca},serverFingerprint256,timeoutMs})`：HTTPS私有CA+doc客户端证书+account叶证书SHA256钉选；`verify(accessToken)`返回协议白名单principal；`events(after)`验证单页严格连续，消费者必须拉全部页到全局head；`ack(eventId,receipt)`提供真实内部客户端入口，不自动假造完成ACK。

`openAccountLedger({file,authorityId,failpoint?})`：独立v2 SQLite事务账本，WAL/显式FULL；LAN存储不变。项目、幂等请求、account全局游标、精确旧login撤销、access持久事件与服务ACK同账本事务。`transaction(fn)`禁止异步事务，两个失败注入点为ledger-before-write/ledger-before-commit；`inspect()`只统计/版本/完整性。

`createAccountAuthority({ledger,accountClient,initializeProject,authorityUrl,signingKey,keyId,pollMs,...})`导出实例接口：`start/synchronize`、`applyRevocation(event)`、`createProject(input,body)`、`joinProject(input,body)`、`adminProject(input,body)`、`authorizePrincipal(input,{projectId,action, trustedRole?})`、`checkAccess({principal,projectId,action,resource?})`、`listProjects(accountId)`、`status/statusForPrincipal`、`eventsSince(after)`、`ackAccessEvent(eventId,trustedServiceId,receipt)`、`revocationStatus(eventId)`、`subscribeRevocations(context,callback)`、`close`。input仅初次accessToken或已建立authorizationId；权限永远来自真实account核验和当前doc记录。authorize结果包含真实accountId/loginId/credentialId/loginGeneration及projectId/authorityId/access/accessRevision/revocationSeq/role/creator/authorizationId。

authorizationId是易失RAM引用，绑定已核验短凭证，重启失效，不能落持久任务队列或当自报账号凭证；每次使用仍复核account和doc。checkAccess要求principal.projectId匹配projectId，action仅read/write，resource.ns仅media/snap/px。subscribe同步登记返回unsubscribe；回调只是唤醒，消费者须先拉齐eventsSince全局head再开放。access event为`{v:2,issuer:authorityId,eventId,seq,type,projectId?,accountIds?,loginIds?,accountEventId?,accountEventSeq?,accessRevision?,createdAt}`。事件一页最多100，head全局；ACK `{receiptId,cursor,complete,closedStreams,stoppedRuns,rejectedCredentials}`由可信证书映射serviceId，不能body冒认；同cursor异内容409，低cursor不退水位。

`mountAccountProjects({authority,services,issueSession?})`返回handlePublic/handleInternal；`createAccountProjectsInternalServer({tls,authority,services,...})`强制独立HTTPS/mTLS监听。public前缀/hosted/shared/account，仅Bearer、不接Cookie；create/join/admin/session为POST，status为GET。内部account证书仅GET /internal/v2/projects?accountId=；asset/agent/render仅POST /internal/v2/access/check、GET /internal/v2/access/events?after=、POST /internal/v2/access/events/:id/ack。初始真实doc/content持久器与会话票据签发器分别通过initializeProject/issueSession注入；未配置明确503，不能空壳成功。Agent身份绝不能admin；主体层旧normalizePrincipal和逐消息gate尚需中央owner接线。

退出、kick/delete状态不会仅凭通知或空连接列表完成。当前revocationStatus始终保留doc屏障待收口，实际连接/素材流关闭与Agent/render持久ACK、pending seal结清及logout-complete顺序见证由中央owner挂载；本模块不伪造它们。retained shared run例外由专门doc runGrant/顺序fence owner实现，本模块普通checkAccess不能用body runGrant绕旧登录撤销、页面/private读或新轮。gone仅本authority已删除记录+owner持久Ed25519签名；未知ID/错误authority/无权/无登录不当gone。

首个定向实证：只读VH580bec8的实际SQLite/credentials/internal HTTPS provider，临时CA/doc/account/asset证书（仅TMP），14 tests /14 pass /0 fail /0 cancelled /0 skipped，2432.2479ms，原始日志`%TEMP%/pc-account-projects-target-1.log`。覆盖A/B真实provider账号记录和短凭证、钉证书、无证书/错误服务/错误pin、创建pending恢复与幂等、权限隔离、踢两设备、restart、真实普通logout精确集合、新登录保留、服务ACK与gone签名。fixture账号通过provider store创建，不声称网站注册UI已集成。完整npm/types和更多切点尚未运行，当前不能标完整产品通过。

## 完整模块后续与接口补齐

首批接口提交ba10c8d2，主会话在干净暂停点独占合入已审auth fixture生命周期修复5bd65d27，合入提交839a4e99；没有自行merge/cherry-pick。随后完成本包负向/事务切点与最终验证。以下补记取代首批相应接口描述：

- `checkAccess`要求accountId/loginId/credentialId/loginGeneration完整，严格匹配authorizationId所绑定真实principal；外部字段不能改变角色。asset resource.ns与其owner对齐media/snap/px。
- `subscribeRevocations`只唤醒真实登录撤销或包含受影响账号的项目访问变化；创建/加入/解禁不撤流。`eventsSince`仍提供全部持久事件连续全局head，不能把通知过滤当缺口恢复。
- 服务ACK必须`complete:true`，在实际stream/子进程关闭和自身游标落盘后才发。pending进度不是ACK；immutable同cursor异内容409，不允许先false再同cursor改true造成完成困住。低cursor仍返回已持久高水位，不倒退。
- public join缺issueSession明确503；配置后返回`{membership,connectionTicket,assetTicket,expiresAt,...}`。session同样要求真实票据issuer，不能以空对象成功；direct joinProject仅提交会员记录，供中央签发组合使用。public只能真人page Bearer，不能body选Agent/service身份或creator。目标fixture没有伪造票据签发器，不声称连接票据已接线。
- `flushAccountAcknowledgements()`先持久exact receipt再发送账号服务ACK；响应丢失/重启重放同receipt。password-changed只发logoutComplete:false；credentials-revoked缺`getDocBarrier`、`verifyDocBarrier`真实注册表/顺序fence证明与asset/agent/render完整持久ACK就保留pending、不发送false同seq占位。真实proof需eventId/accountEventSeq准确、pendingSeals=0、connections、endCursor、clockEvidence、modifications，必须owner verifier确认；该注入不是默认“空连接证明”。账号最终logout-complete sealed witness仍由中央/order owner产生与核验，本模块不声明全局完成。中央消费器需在收口/重试时调用flush入口。
- 同eventId的password-changed/revocation需accountId/changeSeq/changedAt/initiatorWebsiteLoginId/oldLoginIds精确一致，不能第二stage扩大旧集合。正常独立logout不需要先造password事件。页级协议在client及authority双层核验；错误页、跳seq、倒head/缺页都在开放前fail closed。

项目账本已覆盖创建pending/active、名单/入口、access r/rw、ban/kick/unban/delete与托管开关事务；保留creator/member分离与幂等请求。管理结果的completed保守保持false/pending-services，持久权限屏障已生效，真实连接、run/stream fence完成点待中央控制面挂载；不能把该模块的管理提交视为所有服务已关闭。当前retained run例外完全不在ordinary checkAccess，root后续专门runGrant/fence消费；禁止旧用户据此继续页面/private读/新轮。

## 验证原始记录

全部命令显式继承`NODE_OPTIONS=--import=file:///C:/Users/admin/Documents/PromptCut/scripts/lib/test-silent-processes.mjs`、cuda_Vit `PROMPTCUT_TEST_PYTHON`、`PYTHONDONTWRITEBYTECODE=1`。OpenSSL临时夹具子进程windowsHide/stdio ignore；所有账号SQLite、证书、文档初始化fixture与日志在TMP。仅fixture生成钥匙，不生成生产私钥/配置。依赖从主仓库既有node_modules解析，未安装、复制或junction。模型/产品渲染不属此模块，无新增模型加载。

| 实际尝试 / 日志（均%TEMP%） | 结果 | 原始耗时 |
|---|---|---|
| `node --test server/test/account-projects-provider.test.mjs` / pc-account-projects-target-1.log | 14 tests，14 pass，0 fail/cancelled/skipped | 2432.2479ms |
| 追加事务失败/缺口/真实改密/两页恢复后 `node --test server/test/account-projects-*.test.mjs` / target-2.log | 21 tests，21 pass，0 fail/cancelled/skipped | 1421.2357ms |
| 追加当前名单/只读与ACK丢响应重启后，同命令 / target-3.log | 23 tests，23 pass，0 fail/cancelled/skipped | 1701.7972ms |
| 追加同event两个stage集合一致防线后，同命令 / target-4.log | 24 tests，24 pass，0 fail/cancelled/skipped | 1371.308ms |
| `node C:/Users/admin/Documents/PromptCut/node_modules/typescript/bin/tsc -b --force` / pc-account-projects-types-1.log | 首次exit0，0诊断错误 | 实测7450ms |
| `npm test` / pc-account-projects-full-1.log | 首次4960 tests，4959 pass，0 fail，0 cancelled，1 skipped，0 todo；无异常自动重跑 | runner64747.8253ms；外层65143ms |
| `git diff --check` | exit0，无差分错误；仅Windows LF→CRLF提示 | 静态核对 |

唯一skip是既有`集成：/api/cards/layout 对真实项目返回整数框`（未配置PC_STAGE_TEST_URL）；未跑不能算通过。所有新增account-projects测试实际执行，无provider不可用跳过。本包没有测试失败；保留所有四次随具体增加检查的真实结果，没有把旧报告或被主会话修复前的auth结果挪作本包结果。两次辅助rg对PowerShell通配路径报os error123（工具检索路径问题，无测试启动/结果失败），后续改为rg目录配合-g和读取明确文件；diff检查仍exit0。

目标24项含两处ledger-before-write/before-commit失败，证明event/head/精确撤销/outbox事务整体rollback并重开验证；失败恢复不能冒称真实process.exit/crash矩阵，后者是顺序owner独立证据。SQLite inspect实测schema2、journal_mode=wal、synchronous=2(FULL)、integrity_check=ok。真实account provider页>100（105个额外普通logout）重启拉齐全部全局head；password成功、选否保留、选是精确集合、新登录与发起website保留；同event两stage、不相关账号不跳seq；真实内部doc/asset/account证书方法白名单，无证书/错误角色/错误pin、公网/internal隔离；旧授权引用重启失效；所有可用短token不在doc数据库/WAL。gone签名实测owner Ed25519公钥验证正确，错误authority/未知项目/旧无效登录不能gone。

## 交回边界与中央owner待办

本包是独立可复验模块；没有中央WS握手/逐消息gate、normalizePrincipal新字段透传、既有project/content初始提交锁、短连接/素材票据签发器、实际连接注册表、Agent/render/runGrant/accepted-op顺序fence、生产内部监听与服务钥匙配置的接线。不能声称官网owned/joined或云项目编辑已在生产可用；internal测试用真正隔离mTLS listener、真实provider账号账本和controlled fsync doc初始化器，未把这些fixture当生产挂载。

中央每次写接受还必须用原共享order fence保护account verify→seal之间的竞争；本模块当前授权查询不构成接受见证或已读run证明。素材订阅须同步登记→追齐head→重新checkAccess→开放，实际close+自身durable cursor后发complete receipt；不能只收到通知就ACK。getDocBarrier/verifyDocBarrier的真实枚举与签名/pending seal核验由中央owner提供，不得返回默认空connections/pendingSeals。模块自身不会完成logout；account最终状态仍需sealed结束见证。

账本暂采用单SQLite事务JSON状态（全量private项目/事件/幂等/ACK），适合本轮独立准确性模块但不是容量实测/生产吞吐承诺；历史不自动淘汰。源云旧LAN项目不迁移、不猜账号，独立authorityId不符拒开；无production证书签名配置503。无产品画面改动，未扩大GR或C10/真实网络部署探针；旧Auth生命周期补丁由主会话归档，本包只验证合后完整基线。
