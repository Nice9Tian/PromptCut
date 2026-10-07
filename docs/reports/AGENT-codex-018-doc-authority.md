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
