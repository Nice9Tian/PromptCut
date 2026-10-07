# 0.7.18 迁移设计与跨仓库接口

2026-10-08，实施起点 PromptCut `7b4b7106`，包含 main `6f85cd78`；VisuHive 只读核对点 `a2ebd001`。本文是可派发的实施协议，新增接口、模块与结构均标为**拟实现**，不把设计当上线事实。主会话已经获得三版本连续实施授权，按包推进，不再次等待计划审批；一级语义改变或后续完全无法选型才停。已有用户决定不标待决。本文不修改任务书或一级语义。

## 范围、来源与当前缺口

0.7.18 做账号、在线创建、云端 Agent 余项、共有/私有及可信已读、退出记录、素材隔离和旧文件恢复；0.7.19 做三道闸门、确定快照和离线合入；0.7.20 做逐项补偿与申请加入。0.7.18/.19 的退出区间修改保留，仍从 0.7.18 开始完整记录供 0.7.20 使用。生产 Agent 从未部署、没有历史对话，不需要主人键历史迁移；旧测试项目及实际旧文件需要真实备份恢复和转换验收。

必须以 `docs/plan/account-binding-task.md`、`account-binding-contract.md`、`online-browser-task.md` 和 `docs/semantics/product/{agent,document-service,asset-service,platforms}.md` 的 2026-10-08 决定为准。`docs/plan/three-versions-brief.md` 第 5、8、9、11 节是现场、分工、执行裁定和交付指路，不是另一个权限来源。资料旧句子“只授权文档、未实施”描述历史，不能覆盖本轮授权。

| 旧资料段落 | 现状或已失效部分 | 迁移与实际模块 |
|---|---|---|
| `cloud-agent-contract.md` §1、§3、§7.2；`auth-contract.md` §1、§6、§17.1 | 主人用 `creator` / `user:<username>` / `device:<userId>`；实例按项目×主人；自由成员换设备失去历史 | 云端一律 `accountId`，对话按项目×conversationId，所属账号只用于归属和管理；改 `server/auth/delegation.mjs`、`server/agent/service/{create-agent-service,conversations,instance,workspace,usage}.mjs`、`src/ai/cloud/identity.ts` |
| `cloud-agent-contract.md` §2.3–2.5、§7.1、§7.4、§10 | 列表、历史、事件、附件按主人隔离；发消息遇正在运行回 `busy-conversation` | 所有读取/发言/附件/可视化/诊断与订阅按项目和对话 ACL；一对话一个当前轮，其余服务端 FIFO；改 `server/agent-service/http.mjs`、上述 service、`src/ai/cloud/{cloudApi,session,events,types,useCloud}.ts`（useCloud 实际为 `.ts`）及聊天 UI |
| `cloud-agent-contract.md` §4.3；`hosted-wiring.mjs` 的 `verifyCacheMs:15000` | 凭票据摘要缓存身份 15 秒；SSE 只按项目/userId关闭 | 去掉授权放行缓存，逐请求问文档权威；持续订阅用 ACL revision 屏障与逐事件核对；切私有先关闭失权流和排队/写入，再提交可见状态，不能等缓存或 ping |
| `cloud-agent-contract.md` §4.4–4.6、§5；`auth-contract.md` §17.2–17.4；`hosted-render-contract.md` §1.4、§8 | 代成员票据继承 creator、只读可发起、撤销一律停整对话 | 发消息就拒只读，每轮以实际发起账号核验有效成员，Agent永远无管理员能力；可信已读共有当前轮可继续，单独持久 run grant；私有停；actor新增 sender/run/msg/session归属 |
| `cloud-agent-contract.md` §7.3、§7.5、§16、§28 | 对话最多一轮但无 FIFO，进程恢复标 interrupted，委托原文只存内存；反向通道看主人/userId/pageId | 持久 messages、queue、runGrant与read ack；正常进程中断仍可按原中断语义记录，跨重启保留已读事实和豁免授权，不强制自动重放外部副作用；队列恢复后重新核成员；反向通道绑定本轮真实发起账号/登录/pageId |
| `auth-contract.md` §3–5、§7–8、§11–12 | 云端还接受自报用户名+设备、项目派生密码、按设备踢人 | **仅 hosted 云端**改 account认证、account bans/generation；LAN路径保持 `server/auth/{client,pure,handshake,invite}.mjs` 旧规则；cloud分支通过 `server/docservice/shared-service.mjs` 单处接线 |
| `auth-contract.md` §8；`hosted-render-contract.md` §1.6、§7.5 残余；`cloud-agent-contract.md` §4.4、§9 | 任意项目票据凭已知hash可读任何素材 | `server/asset-service.ts` 的真实 storage selector按project隔离，media/snap/px、索引、staging、tier、thumb、stream、worker、转码及队列产物全覆盖；见素材协议 |
| `cloud-agent-contract.md` §9、§23–28；`cloud-agent-task.md` J | 本机与云端工具一致；pending工具和登录通路未完成 | 按下文真实23个pending及额外欠项补齐；§9.4d/§27/§28的登录上传方向失效；spawn_agent固定关闭，不算待实现 |
| `online-card-exec-contract.md` 隔离/执行/素材授权；`hosted-render-contract.md` §1、§5a、§7、§8a | 执行隔离和服务身份已实现，不能绕过项目读 | 保留Ed25519服务身份、角色白名单、隔离进程，追加project ACL/产物归属；舞台不接账号cookie，不向卡代码交凭证 |
| `four-stage-deploy-checklist.md` A3/A4/B1/B4；`HANDOFF-four-stage.md` §4、§5甲乙、旧周额度与笔记本 | 三版本合一、只补丁、不备份整数据、等5分钟/3小时、模型密文待用户提供等历史句子 | 三版各完整包+patch；一致备份和实际恢复；旧测试项目临时例外三版适用；cipher已经待导入；网站后端先、site最后；新主分工Sol/Luna/Astra |

模块路径以检索结果为准：中央文件是 `server/docservice/shared-service.mjs` 和 `server/docservice/service.mjs`，不存在 `server/docservice/server.mjs`。工具声明是 `server/tools/*.mjs`，不是 `.ts`。旧分支 `8fb6df79` 仅有未完成选型提交，无产品代码；只参考其动图/visual思路，不合并它。`product/agent.md` 运行位置仍有“同用户名”“主人独享”“一律停”等旧段落，与其接入段和本次决定冲突；实施契约同步包修正，不能拿旧段给权限放行。

## 身份、恢复与唯一权威

以下结构和API全部拟实现。`accountId`沿用VisuHive现存不可变 `acc_<24 hex>`。账号服务唯一管理密码和登录；文档服务唯一管理项目存在、创建者、成员、禁入、版本和操作。托管目录只牵线与中继，网站不能另建一张授权项目表。LAN自报ID、白名单、邀请、回环本机信任和主机角色**完整保留**；本地搬到云端是创建新的账号项目/迁入事务，原本地账号名不能升级成云端身份。

`server/docservice/service.mjs` 的 `normalizePrincipal` 目前只透传有限 `PRINCIPAL_EXTRA`；必须增加字段，否则后端验过身份但模块收到的身份丢失。

```js
// 拟实现 CloudPrincipal v2；不接受消息body自报下列授权字段
{
  identityVersion: 2, realm: 'account', accountId, accountName,
  userId: `account:${accountId}@${deviceId}`, tenantId: projectId,
  scope: 'member', role: 'page'|'agent'|'render', deviceId, deviceName,
  loginId, loginKind: 'website'|'editor', loginGeneration, credentialId,
  accountEventSeq, projectAccessRevision, creator, access: 'rw'|'r',
  conversationId, messageId, runId, runGrantId, service, serviceKid,
  purpose: 'user'|'run'|'publish', connectionId
}
```

`creator`只对真人page管理入口生效；service/agent永远由白名单拒 `shared.admin`、kick、名单、delete、开关、账号接口，不能通过创建者发起轮绕过。`accountName/deviceName`只是显示，设备ID不授予身份。`loginId`是服务端随机登录记录ID，与客户端自报的文档会话标识 `session` 区分。actor从连接principal生成；`server/docservice/modules/actor.mjs`拟追加 `{accountId,loginId,loginGeneration,credentialId,conversationId,messageId,runId,runGrantId}`；服务端生成/验证操作时间、序号，忽略客户端同名字段。

〔裁，卡点1第1行〕云端项目记录拟 `v:2, identityRealm:'account', projectId, authorityId, name, status:'active'|'deleted'|'relocating', creatorAccountId, allowLinkJoin:true, members:{[accountId]:{access,joinedAt}}, bans:{[accountId]:{reason,eventId}}, accessRevision, accountGenerations, hosted:{render,agent}, ticketKey,kid,creationRequestId`。旧LAN `v:1`分支照旧。云端旧测试项目由根会话清理，不把旧username自动猜成账号；删除保留无秘密的权威tombstone，才能对真实旧文件答准确gone。邀请码只定位项目。创建事务先写含creator的pending记录，初始project/content落地后一次转active；pending不能签票据/列表展示。重复requestId回同一项目/原结果；失败保留可续办事务或清理其不可访问半成品，不能生成第二个项目。

### 公开接口（拟实现）

账号公共前缀 `/api/account`，项目公共前缀 `/hosted/shared/account`，公网反代映射到模块相对路径。JSON统一 `{ok:true,...}` / `{ok:false,code,message,requestId?}`，`Cache-Control:no-store`。旧LAN `shared/create/challenge/verify`路径保留；hosted的旧密码创建/握手拒绝，不能混用旧格式。

| Method/path | 请求/可信来源 | 成功响应 | 关键失败 |
|---|---|---|---|
| `GET /api/account/me`（现有扩展） | host-only cookie | `{account:{id,name,email,createdAt}|null,session:{loginId,remember,expiresAt}?,csrfToken?}` | 503 account-unavailable |
| `POST /api/account/login`、`/register`（现有扩展） | `{name,password,remember:boolean}`、合法Origin/CSRF | account+website session cookie；login不回密码 | 401 bad-login、429 too-many |
| `POST /api/account/editor/login` | 桌面服务经TLS `{name,password,deviceId,deviceName,requestId}`；nginx可信实际IP | `{account,loginId,recoveryToken,accessToken,accessExpiresAt,recoveryExpiresAt}`；仅此次传递密码 | 401 bad-login、429 too-many，复用同一name/IP试密码限速 |
| `POST /api/account/editor/recover` | `{recoveryToken,requestId,deviceId}`；rotating token | 新recovery/access+相同loginId；旧token只对同requestId重放同结果 | 401 credential-revoked、409 token-reused |
| `POST /api/account/editor/logout` | Bearer editor access | 本登录撤销事件+结果 | 401 unauthorized |
| `POST /api/account/editor/session` | 官网cookie+CSRF `{deviceId,deviceName,requestId}` | 单独editor login/access；寿命不得越过website登录；不发长期browser恢复token | 401 not-logged-in |
| `POST /api/account/password`、`/reset/confirm`（现有改行为） | 当前密码或有效一次reset code，原body保留，requestId | `{account?,passwordEventId,changedAt,choice:'pending'}`；密码确已成功；reset建立本次website会话 | bad-password/bad-code/too-many；失败不能弹退出选择 |
| `POST /api/account/password-events/<id>/choice` | 发起网站会话+CSRF `{exitOthers:boolean,requestId}` | 202 `{eventId,state:'retained'|'revoking',logout:{state},modifications:{state:'retained'}}` | 403 not-initiator、409 choice-fixed |
| `GET /api/account/password-events/<id>` | 发起网站会话 | `{changedAt,choice,logout:{state,pendingServices},modifications:{state,version}}` | 404 not-found；未确认仍revoking |
| `GET /api/account/projects`（现有改实现） | cookie -> 内部doc权威查询 | `{owned:[ProjectListItem],joined:[ProjectListItem],authorityId,revision}`；item含projectId/name/status/creatorAccountId/url | 503 projects-unavailable，页面显示“暂时无法获取项目”；不能empty代错 |
| `POST /hosted/shared/account/create` | Bearer editor access（浏览器先session交换） `{name,requestId,initialProject?,allowLinkJoin?}` | 201 `{projectId,authorityId,contentId,accessRevision}`；创建能力口 `canCreate(principal)`目前登录即允许、数量不限 | 401 login-required、403 forbidden、503 account-unavailable、409 name-taken |
| `POST .../join` | `{projectId,invite?,requestId}` + editor access | `{membership,connectionTicket,assetTicket,expiresAt}` | 403 banned/not-listed、404 no-project、503 unavailable |
| `POST .../session` | `{projectId,deviceId,role,requestId}` + editor access | 连接/素材短票据及principal显示字段；WS只带票据子协议 | 401 credential-revoked、403 banned、409 relocating |
| `GET .../status?authorityId=&projectId=` | 验准确authority；现有认证状态按权限独立返回 | `{authorityId,projectId,state:'exists'|'gone',tombstoneRevision?,proof}`；proof由doc签名用于恢复验证，不是登录凭证 | wrong-authority/unauthorized/banned/timeout/unavailable都不能gone |
| `POST .../admin` | 真人creator access `{projectId,op,requestId,expectedAccessRevision,...}` | `{eventId,accessRevision,completed}`；op含set-entry/set-list/kick/unban/delete/set-hosted-service | 403 forbidden；Agent一律拒；409 stale-revision |

0.7.20的 `/join-requests` 提交/列表/approve另外实现，0.7.18不假装已具备；名单拒绝可显示明确原因，不能临时自由进入。列表url仅定位，点击仍重新查身份/权限。

### 内部接口、隔离与同域防护（拟实现）

〔裁，卡点2第1行〕选择**每个服务独立OS用户 + mTLS独立内部监听 + 每个调用者单独证书**。account/doc/asset/Agent/render不共享可读取的私钥目录；私钥0600，父目录0700，服务sandbox与用户卡worker无读取能力。内部HTTPS只loopback是额外约束，不能作为身份核验。TLS证书subject/SAN映射配置serviceId和允许方法，客户端不能body自报serviceId；mTLS根仅本节点root签发，不信公共CA作内部服务身份。nginx不给internal路由；public监听与internal监听分开。可以复用既有Ed25519注册表验证signed envelope，但不能替代OS钥匙隔离；所有测试包含同机其它用户无证书/错误证书/反代转发均拒。部署必须建立独立服务用户；既有服务全以root跑的组合不满足此验收。

| 内部API | 授权调用者 | 请求/响应 |
|---|---|---|
| `POST /internal/v2/credentials/verify`（account提供） | doc；不开放Agent直接试密码 | `{accessToken,audience:'doc',requestId}` -> `{principal:{accountId,accountName,loginId,loginGeneration,credentialId,kind,expiresAt},accountEventSeq}`；只核凭证，不收密码 |
| `GET /internal/v2/events?after=<seq>`（account提供） | doc | `{events:[PasswordEvent/RevocationEvent],headSeq}`；按全局持久seq拉取，推送只是唤醒 |
| `POST /internal/v2/events/<id>/ack`（account提供） | doc | `{receiptId,appliedSeq,logoutComplete,connections:[结束记录],endCursor,clockEvidence,modifications}` -> 持久ack；eventId/service重复幂等 |
| `GET /internal/v2/projects?accountId=`（doc提供） | account | 直接从doc记录构造owned/joined，带authorityId/revision；失败503不可空 |
| `POST /internal/v2/access/check`（doc提供） | asset；必要时Agent/render | `{projectId,loginId,credentialId,accountId,purpose,runGrantId?,action,resource?}` -> `{allowed,accessRevision,revocationSeq}`；不接受未经account核验的身份直接授权 |
| `GET /internal/v2/access/events?after=`（doc提供） | asset/Agent/render | 持久项目/登录/对话撤销流；必须先同步head再开放请求，ACK或重新拉取恢复缺口 |
| `POST /internal/v2/access/events/<id>/ack`（doc提供） | 对应服务 | `{stoppedRuns,closedStreams,rejectedCredentials,cursor}`；doc据相关服务收口完成点 |

既有Agent控制连接 `hosted.delegate.verify`、`hosted.ticket`扩展v2身份，增 `hosted.run.admit`、`hosted.run.read`、`hosted.run.finish`、`hosted.conversation.access`（下节），保留服务Ed25519握手和白名单。消息支持requestId/receiptId，后端先提供再消费。

同域官网/editor使用 `vh_session`（可后续兼容改为__Host前缀），`Path=/; HttpOnly; Secure; SameSite=Lax`，**不设Domain**。不记住：session cookie不带Max-Age，服务端设24小时绝对上限；记住：保持现有30天滚动寿命，续期同时刷新cookie与数据库，不能无限仅服务端续期；两种均有可撤销loginId。browser编辑器恢复依官网cookie，不能在localStorage另存永不失效登录；desktop vault只保存可撤销随机恢复token，不保存password/key派生物，access短期内存。〔裁，卡点3第1行〕短access 2分钟、desktop恢复30天滚动、未记住24小时属于机制，实施时同步参数文档。

Cookie接口所有写方法（含登录、注册、reset、防登录CSRF）要求 `Origin === https://visuhive.com`，精确scheme/host/port，拒null与无Origin；JSON内容类型精确解析并要求CSRF头，与服务端session/匿名nonce绑定，不在URL；Fetch Metadata拒cross-site。GET只读且no-store。bearer desktop接口单独路由，不收cookie、不返回Allow-Credentials；公网上真实来源由可信nginx覆盖 `X-Real-IP`，忽略直接来访伪造头，试密码共享同一limit库。旧 `sslip.io/editor`不能收到visuhive cookie：提示去正式同域入口或明确登录，不能复制cookie到别的域。

编辑器主文档CSP仅允许self脚本及明确舞台 `frame-src`，禁止unsafe-eval、object、任意外部connect；必要外部连接由后端代理/明确配置源，不把用户卡脚本放同域主文档。官网内联代码改外部模块或固定hash/nonce。stage域无account cookie，CSP保持现有执行隔离：禁止访问账号/内部/Agent端点，素材只经project-scoped `media-s`委托，绝不传website cookie。新增策略先在两仓库模板及真nginx测试，不损坏既有动态用户卡隔离。

### 持久记录与版本

VisuHive `account/store.mjs`当前SQLite只有accounts/sessions/codes，密码事务和会话删除非原子；拟 `PRAGMA user_version=2`，原表增兼容nullable/default字段，迁移在事务内。新增 `login_credentials`（id/loginId/tokenHash/kind/generation/remember/createdAt/expiresAt/revokedEventId/rotatedFrom）、`password_events`（eventId/requestId/accountId/changeSeq/changedAt/clock/initiatorWebsiteLoginId/oldLoginIds/choice/choiceSeq/logoutState/modificationState）、`outbox`（eventId/seq/payload/status）、`consumer_acks`（eventId/service/cursor/result）、`rotation_results`（旧tokenHash/requestId/result密封短期存储）。hash不是可用凭证；实际token结果不能写日志。password change不自动增全账号授权代数；只有选是产生对应受影响登录的持久撤销。重设成功建立发起website会话并保留，其余旧会话在选择前完整保留。

doc拟新增 `server/account/{authority,client,ledger,clock}.mjs` 与 `server/docservice/modules/account-projects.mjs`，分别管验证客户、幂等撤销账本、可信时钟证据、云端项目权威接口。account事件 `(issuer,eventId,seq)` 去重，收到seq跳跃拉缺口，旧seq ACK不倒退水位；收到撤销但密码事件尚未到则暂存不猜时间。doc的project/access/run/operation日志在一条可恢复提交序列里写先后关系，fsync成功才确认。不能沿用conversation当前“写盘失败仍广播成功”的行为保存授权/已读；授权日志持久失败应503并禁止启动下一轮。

## 改密、退出完成点与0.7.20的操作历史

### 密码成功和退出分开

密码事务用服务器requestId幂等：核当前密码/reset验证码、计算新密码hash，进入事务写password与事件/outbox，成功提交后回“密码已修改”（或重设成功），**之后**显示是否退出选择。密码核对失败无事件、不显示成功。事件初始choice=pending；用户取消/关页面仍pending，下次同发起网站会话读状态可继续选择，不能默认退出。选否原子写retained，保留所有登录、恢复凭证、项目访问和写入，之后新密码用于新登录。选是原子固定受影响集合并写revocation/outbox。选择是/否仅首次有效，同requestId重试回原结果。

受影响集合是密码成功时存在的旧登录ID，减去发起的website登录ID；包含所有旧editor登录（包括发起电脑editor），其余website登录。密码成功之后用新密码产生的新loginId不属于集合，不能只按 `accountId`一刀全部撤销。连续两次改密各自用独立事件/集合/顺序；重叠登录只撤一次，但每个事件均有完成结果。邮箱reset保持/建立的当前website登录是本次发起会话，旧其它website照集合处理。

账号先持久撤销旧refresh/access记录，doc迟到时已有连接可以继续编辑，但新登录/创建失败明确报不可用。doc收到事件后立刻建立旧loginId拒绝屏障：所有新握手、resume、逐消息gate、素材票据签发、Agent消息和订阅拒旧登录；将旧连接标revoking并终止page/本机Agent/私有云Agent/不满足例外轮。asset/Agent/render收到project/login撤销后停止旧流和入口；共有已读当前run换专用授权继续，不算仍登录。不能用ticket TTL、15秒缓存或“通知稍后到”报告已退出。

退出完成不等浏览器真正显示已退出或等待共有run结束，而是：account旧凭证持久不可用；doc旧连接全部关闭或进入永久拒绝状态且不能resume；asset旧票据/Range/stream授权不可继续；Agent失权read/SSE/page-request/queue已关闭且私有任务的提交权限已撤；各相关服务持久ACK确认屏障。doc收集多连接 `{connectionId,loginId,lastAcceptedOpSeq,closedAt,closeClock,reason}`；先登记撤销时全量连接，再到所有入口屏障提交点查新增连接（应为零），记录 `endCursor`、最大closeClock和服务ACK。`logoutState='complete'`需无pending服务；网络断开后不能凭连接消失跳过授权撤销。界面一直“正在退出已登录设备”，失败显示具体仍待服务与可重试；重新打开查持久结果，不能将timeout算完成。

### 可信区间，而非比客户端时间戳

〔裁，卡点4第1行〕当前节点账号/doc同机部署，选择**同一Linux内核单调时钟坐标 + bootId + 权威UTC锚点 + 文档顺序**。拟`server/account/clock.mjs`和VisuHive`account/clock.mjs`在Linux以经过探针核对同源的 `process.hrtime.bigint()`取纳秒（持久为十进制字符串，JSON不直接写BigInt），读取同一内核bootId；账号密码事件记录 `{clockVersion:1,hostClockId,bootId,tickNs,utcMs,changeSeq}`，`utcMs`由账号服务在密码事务成功线性化位置确认，不接受body。文档每条接受操作在提交顺序锁内记录 `{bootId,tickNs,docUtcMs,authoritySeq,projectRev}`。密码的“绝对时刻”以此可信事件命名，同时用同boot tick比较，不直接把两服务Date.now比较；NTP调时不会改区间选择。

密码事务定义写入密码event的commit为改密生效点：在同一事务锁内为event采tick/UTC并立即COMMIT；事务提交失败不发布事件。密码验证、会话签发同一账号串行锁，doc操作独立。为了避免COMMIT调用期间的纳秒边界猜测，passwordEvent记录 `commitStartTickNs/commitEndTickNs`；0.7.20分类时若候选操作tick落入这段边界，doc向account持久commit witness查询并按两服务共同的时序屏障重建，**不能直接任选纳秒**。实施包需将最终线性化定义写成可测试协议：最低可行方式在改密commit窗口让doc记录操作接受意图并暂存，account成功后释放这些意图按commit之后接受（失败则按原顺序接受），仅短commit屏障；不影响选否保留登录。屏障通过持久 `password-commit.prepare/commit/abort`与doc `barrierId/authoritySeq`确认，account故障时屏障恢复按事务结果释放，不靠超时猜commit。既有连接在其它账号服务故障期间不进入这个短屏障，照既有可编辑意向继续。**最终以共同屏障顺序为区间边界，时钟证据用于可信绝对时间和审计**。

执行步骤：account先向doc准备本账号commit barrier，doc把当前操作接受意图序列边界fsync并ACK；account成功密码事务写UTC/tick和barrierId，再发commit；doc把barrier里尚未接受的旧操作排在commitMarker之后，释放编辑，密码接口此后回成功。仅本账号旧登录的project.op/content.put等项目修改等到commit结果，其它账号无等待；选否不撤任何改动。若doc在改密期间不可达，密码成功仍可发生（找回账号不能被doc故障卡住），标 `barrier:'clock-fallback'`：同boot精确tick选范围，commit不确定窗口保留pending候选，恢复后必须用操作意图/持久见证消歧；不能到0.7.20发布时仍剩该边界不可判定。卡点4第2行的中央账本备选用于这种边界：将account密码事件与doc接受操作共同交给本机独立持久顺序器，旧连接断account仍可写doc/顺序器；若第1行探针证实无法重建，就落第2行，不改变用户区间。实现前Astra专包应证明这一点，主会话不凭设计文字宣布已证实。

跨服务分机不在当前部署组合；禁止不核时钟偏差直接比较。若将来分机须换中央顺序器或有明确误差处理，属于另一个机制包。本机进程重启同boot保持tick坐标；机器重启boot变化时**旧连接已物理结束**，doc启动必须先恢复撤销ledger和对账account head，然后允许credential恢复。保存最后一条已接受操作的旧boot tick和连接断开水位；区间取旧boot从commitMarker/tick起到旧boot最后接受操作，再结合启动屏障，不能用新boot tick与旧boot比较。遇同账号旧登录在新boot复活说明启动屏障失败，验收直接失败。bootId/hostClockId不相符、缺见证或账本不完整标 `modifications='needs-reconciliation'`，保存原历史、保持已撤销授权、不进行猜测补偿；续办恢复，仍挡0.7.20撤回发布。

区间上界为该事件受影响旧登录全部访问屏障和连接关闭确认完成，`endCursor`是doc最后接受这些登录修改的权威序号；各服务结束时间分别记，最大可信closeClock展示区间结束。候选选择同时满足：账号相同、loginId在oldLoginIds、credential/generation属旧授权、接受顺序在可信下界之后且不超过endCursor、projectId匹配；新登录、别人和无关项目不入选。明确共有已读runGrant例外按message/run精确排除，不能因同账号保留一切修改。

### 从0.7.18保留到0.7.20的撤回信息

拟操作日志v2字段：`opId/requestId,projectId,authoritySeq,projectRev,actor,acceptedClock,passwordBarrierId?,ops,changes[],dependencies,runGrantId?,compensatesOpId?,result`。`changes[]`每项 `{itemKey,before:{present,value},after:{present,value},beforeVersion,afterVersion}`；itemKey用对象稳定ID+JSON子路径，数组增删/移动同时记录父容器结构版本，不用易漂移的数组index充当永久身份。整root replace在服务端拆成实际叶项/结构变化，不能只存摘要；无法安全拆的结构项整体作为一项，对后来结构修改保守判冲突。内容库card-source、素材引用变更也记录before/after，不仅project.op。

〔裁，卡点5第1行〕未完成password事件及其候选操作、已读message/run链、before/after和基准snapshot不可淘汰；完成后按项目生命周期保留审计与选择性撤销所需历史，容量达限拒相应新写或明确告知维护需求，不能静默删除未处理区间。conversations的8/12MB降级只能压缩thinking/diagnostic，不能去掉sender/read/run/queue/ACL审计。每次snapshot压缩保存引用中的操作历史；账号备份含outbox/acks、doc备份含历史及clock witness。

0.7.20补偿在项目写锁下逐item比较：该项以后被**别人账号**写过/基于该项做派生结构变化即冲突，即便值后来巧合相等也不撤；本账号新登录的合法后续写也保护，不能被旧凭证补偿覆盖。逆序撤同事件旧操作，给其自身补偿建立版本链；若无法证明未被后续合法修改依赖，保留该项并记冲突原因。对可撤项发普通审计操作 `{opId: eventId/projectId/originalOpId/itemKey,compensatesOpId,expectedItemVersion}`，版本在检查与提交之间变化则重新判，不根替换。重复补偿回原结果，不重复version+1；私有任务已落地修改在区间内仍按逐项规则撤，共有已读当前轮改动排除。

0.7.18/.19只记录 `modifications={state:'retained',candidateRange}`，绝不执行上述补偿；0.7.20显示处理进度独立于logout，失败保持 `pending/retrying/needs-reconciliation`，按持久任务续办，旧授权保持撤销。完成可报告changed/reverted/conflicted/exempt项数和证据，不弹改密冲突窗口。用户普通撤销（含AI“撤销这一步”）独立实现窗口：〔裁，卡点6第1行〕列出逐项当前值/原改值/还原值，给“只撤无冲突项”“选择冲突项覆盖”“取消”；没有冲突直接撤。窗口期间版本变化再核对、不能用同一窗口覆盖新冲突；该机制不修改已定的改密冲突不撤规则。

## Agent共有/私有、FIFO、已读与任务授权

拟对话结构v2存 `tenants/<projectId>/conversations/<conversationId>/`（不再owner目录决定访问），`meta={v:2,id,projectId,ownerAccountId,visibility:'shared'|'private',aclRevision,title,state,currentRunId,queueRevision}`；`messages`每条 `{messageId,requestId,arrivalSeq,senderAccountId,senderNameAtSend,loginId,credentialId,createdAt,content,queueState,runId,readReceiptId?}`。所属账号永远是创建对话者；sender永远实际凭证账号。model history保留逐条sender，不能把对话历史全部冒名owner。

服务端同conversation持久接受锁分配arrivalSeq；202回 `{messageId,runId?,seq,queuePosition,queueRevision}`，重复requestId同sender回原结果，不能排两次。一个共有conversation最多一个currentRun，其余 `queued`严格按server到达序FIFO；不同conversation可并行。页面显示“排在第N”，位置由服务端计算并推 `queue.changed`，切换客户端/重连按持久队列恢复。入队时验成员、登录、visibility、rw；出队再验当前权限/credential，失权取消该条而非借owner启动；拒绝后原文保留历史并有明确状态，无新的run授权。切私有作废所有其它账号queued消息，不迁移到别的对话；owner queued仍按FIFO。

| 能力 | shared | private | 其它限制 |
|---|---|---|---|
| list/get/history/events/visuals/diagnostic/attachments读取 | 同项目当前有效成员 | owner；creator只读例外 | 被踢/旧登录失效均拒；项目scope不能绕过；鉴权逐接口 |
| send/reply/upload attachment | 当前有效rw成员 | 当前有效rw owner | creator在别人的private也不能发送；只读发消息即拒 |
| change visibility | owner | owner | creator没有替别人切换特权 |
| abort run | 该轮initiator，或项目creator | 同左，creator仍能停止 | 通过runId，不是笼统对话主人停全部 |
| rename/remove | owner（沿用既有owner管理边界） | owner | 本期删除UI仍按既有延期；API不可成为其它成员删除入口 |
| run工具管理员操作 | 永远拒 | 永远拒 | initiator为creator也拒；服务白名单独立 |

读取/订阅都问doc的拟 `hosted.conversation.access {projectId,conversationId,action,principalRef,expectedAclRevision?}`，返回 `{allowed,aclRevision,ownerAccountId,visibility,creatorReadOnly}`。无对话权可404（不泄露）；private creator只读列表明确标识。HTTP先鉴权再flush SSE headers；补历史前、每次事件写前校验revision，document失联则暂停/关闭用户读取和新请求并503，不能把缓存当授权。事件广播只到仍有权限的listener；visibility提交同时发失权撤销控制事件，关闭他们全部history/visual/media发流、清浏览器对话内容与列表。已下载字节不能追回，但切换线性化点以后无新字节/历史/事件；测试含在同一个event loop里切换与event.emit竞态。

**切私有即时行为已定**：doc先提交ACL/任务写入fence（同步禁止其他initiator run后续op），再通知Agent终止当前其它成员轮、取消其page requests和排队；已落地修改保留。creator只读例外仍能查看，但若creator不是owner，其在shared发起的当前轮同样中止，不能因能看private继续任务。接口成功必须Agent已停工具提交、撤销流完成ACK；过程status可pending，但权限fence从doc提交即生效。

〔裁，卡点7第1行〕可信已读确认点：Agent从持久messages读出**该轮完整prompt**并装入runner输入，计算contentDigest，先fsync本机 `read-intents`；在首次模型调用/工具执行前，服务身份发 `hosted.run.read {requestId,projectId,conversationId,messageId,runId,promptDigest,readIntentId}`。doc验证当前被选中的currentRun、实际sender/登录、完整消息hash和服务登记，在同一事务追加 `readReceipt={receiptId,messageId,runId,promptDigest,authoritySeq,readAt}` 和 `runGrant`，ACK后才向模型交输入。客户端上报“已读”或model普通流量不算确认；仅HTTP202入队不算。ACK丢失用requestId查询结果，Agent禁止再发模型请求直到结果确定。

拟 `hosted.run.admit`先为出队消息创建preparing/currentRun、锁定initiator；`hosted.run.read`完成上述可信确认；`hosted.run.finish`幂等持久end。doc是currentRun/receipt的最终仲裁，Agent WAL是读事实证据；“已读完成”以可信读记录被doc持久确认点为准。与退出同时发生用doc提交序排序：read先成功的shared当前run获得例外；撤销先则read被拒，Agent不能运行。保留已读消息内容、sender和历史，不允许conversations压缩/删除去掉该关联。

`runGrant={v:2,grantId,projectId,conversationId,runId,messageIds:[...],initiatorAccountId,loginId,credentialId,admittedAt,readReceiptIds:[...],state:'active'|'retained'|'revoked'|'finished',visibilityAtRead,aclRevision,projectAccessRevision,serviceKid,reason,opIds,artifactRefs}` 由doc持久保存。Agent拿的是服务可恢复引用，不把旧用户access/recovery token保存为执行授权。拟 `hosted.ticket {projectId,runGrantId,purpose:'run'}`重新查run记录签短票据，principal包含runId/messageId/实际initiator但creator=false；每次操作gate重新查project、开关、service登记、run状态；即使豁免run也不能跨project。素材票据/渲染产物继承精确runGrantId。

踢人或改密选退出：doc关闭旧真人登录访问；private当前run立即revoked，中止且保留已读历史；shared且已经read-confirmed的**当前run**置retained，当前轮继续并保留修改；未读/preparing/queued取消，其他成员的有效队列在当前轮完后可继续，旧登录不能新发/下一轮。项目删除/关Agent终止全项目run；切private取消其它initiator run，优先于retained例外。重新开服务不能自动复活revoked run或credential；保留服务重启前read与retained记录，重启后换执行票据仍查它。模型进程崩溃仍可按现有interrupted留痕，不声称重启会自动重做已发送外部请求；保留已读豁免和已落地操作，恢复待完任务必须有幂等工具/清楚续点，不能无证据从prompt重跑。

| 同时发生 | 线性化优先级/结果 |
|---|---|
| project delete / hosted.agent=false / service key revoke 与任意操作 | project存在/开关/服务白名单是最外层，关闭后所有run拒；删除最高，不被retained豁免 |
| shared->private 与 kick/password exit | 无论先后，非owner当前轮被private fence终止，已落地保留；旧用户仍撤；owner private轮遇退出仍停 |
| read ACK 与 kick/exit | doc事务顺序：先read且shared current ->retained；先exit ->拒read，不启动 |
| owner切回shared与旧queue/run | 旧取消消息/撤销grant不复活，新有效成员重新发送产生新requestId |
| run末次op与stop | 同一project gate/提交顺序：fence前成功的保留，后到达的拒；工具返回迟到不绕过fence |

跨重启对账必须持久且完整：doc恢复project和revocation ledger，Agent恢复read-intents/runGrant引用/queue，先拉head再接受请求；重复、乱序、断网、服务在ACK前后崩溃分别测。立刻失权以doc提交gate为界，不能使用现有15秒身份缓存宽限。
