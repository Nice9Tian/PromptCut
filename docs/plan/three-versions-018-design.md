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

## 素材全链路隔离与工具欠账

### 素材协议（拟实现）

〔裁，卡点8第1行〕选择**托管端按项目物理store**，不在原全球hash库只补一层工具检查。接口外观保留 `/api/asset/<media|snap|px>/<hash>`、`/<hash>/chunks`、`PUT /<hash>/<n>`、`POST /<hash>/complete`；hash仍内容hash，project从已验票据取。`server/asset-service.ts`目前`storeOf(ns)`在admit之前选全局store，必须改为admit返回可信 `{projectId,accountId,loginId,runGrantId?,service,accessRevision}`后 `storeOf(ns,projectId)`；任何请求必须在stat/chunks/read/write/pull之前判project。托管目录拟 `tenants/<projectId>/assets/{media,snap,px}/`及独立 `staging`、index、tiers、jobs。LAN与未共享本地继续旧本机store，不能把整个本地素材库误隔离成账号库。

| 路径/模块实际入口 | 必须绑定的范围与拒绝条件 |
|---|---|
| `server/asset-service.ts` GET/HEAD/Range/chunks/PUT/complete | 每个请求验当前project/login/run权限；hash在另一project存在也回本项目404，错误不给全局存在性；uploadId/chunk staging按project+ns+hash，不能A分片B收尾 |
| `server/vite-plugin-media.ts` `/@media/<hash>`、PCM、`/api/media/upload/<name>`、adopt、bind、originals、upload-queue | 托管组合不得把未鉴权请求next到global mediaMiddleware；本地absolute path/file入口不暴露给托管用户；绑定hash须实际本项目入库或已授权复制，不因全局hash存在加入归属 |
| `server/media-{tiers,pull,stamp,ingest}.mjs`、`server/upload-queue.mjs` | manager/队列/临时文件缓存键加projectId；跨项目同hash不共享读授权；pull source身份不得沿用上个项目当前远程base/ticket；complete后再标可用 |
| 低尺寸/thumbnail/PCM/`server/frame-stream.mjs`、`server/queue-local-media.mjs` | 衍生key包含projectId+源hash+规格版本；所有URL与下载、流、thumbnail在服务层同样核project；不要因px/hash已命中跳过授权；转码worker传可信project上下文，不信body.path |
| `server/hosted/combo.mjs`、`server/asset-client.ts`、`server/asset-store/{index,fs-store,client}.mjs` | 组合注入project store工厂；client每次以该project取票据，禁止任意project header当授权；进程内读写API同样必须明确tenant |
| `server/hosted-render/{worker,look}.mjs`、`server/agent-service/{look-client,render-publisher}.mjs` | worker的asset key/缓存/代理绑定project；不可读别的store或credentials；看画面请求的project由已验证服务+run权限取，body不可换；产物记录creator run/task/project |
| `server/docservice/modules/{render-queue,content}.mjs` 与产物manifest | task.source、taskId、content scope、产物hash/manifest均带project；A task不能交B产物或引用B asset；过时计划按现有撤回版本规则拒；写px权限不能变成写media |
| `server/asset-store/{service-usage,px-evict}.mjs` | 容量账本及淘汰以project+ns+hash记录，多project同hash删除一份不能删除另一份；删除project只删此project字节/队列/cache，不扫全局hash |
| `media-s` 舞台委托/nginx | grant绑定project、session、允许资源；不可重用A grant拿B hash；cookie仅stage scoped，account cookie无Domain不下发stage |

跨项目同hash：本期允许独立存两份（少改授权机制）；A有效票据只能A库读；B若用户从合法输入独立上传相同字节，则B自己的完整入库正常。不能建立“凭hash复用全球字节”的隐式bind；未来安全去重只能由服务内部共享物理blob+独立不可绕过ownership ledger，当前不做。hash/URL/tool结果/logs不替代归属。

旧asset ticket格式v1兼容LAN；云端v2载 `p/accountId/loginId/credentialId/accessRevision/runGrantId?`。票据由doc签发并权威核对，素材同组合可直接查询doc ledger；分进程内部check渠道按上节mTLS。持续read stream在撤销event处destroy，不只每个Range重新验；新的完整stream不能在退出期间留旧权限。缓存鉴权失联应暂停新云端访问，已联网编辑意向在doc现有连接上保留，并由撤销区间追踪承接；不允许旧asset直接绕过未确认撤销。服务票据与user票据分别处理，retained run只用精确project/run授权，project delete/开关终止优先。

### 真实工具清单与节点验证

2026-10-08在起点用只读模块导入核对：`CLOUD_TOOL_PLAN`的pending恰为**23个**。其中感知/工作流15个、browser七个、measure_audio_js一个；额外web_handoff、collect_login/collect_login_check及可视化收尾也必须接。下表输入名来自 `server/tools/{ai,browser,audio,core}.mjs`；输出以本机同工具真实契约为准，不能只回“ok”。所有job返回project/run-bound jobId；查job也验tenant，取消、退出和项目关闭传播到子进程，不能靠模型继续写已有全局jobs Map。

| 工具（逐名） | 当前实际输入 / 拟同形返回 | 实现位置、节点可行性与验收 |
|---|---|---|
| `stt_status` | `{}` -> engines各installed/ready/model信息 | 拟`hosted-perception.mjs`复用 `python/promptcut_stt` status；节点CPU可行，真实调用核依赖，不伪称装好 |
| `stt_install` | `{engine:'faster-whisper'|'whisper'}` -> jobId | 本机接口声明安装到用户目录；云端拟受限安装job用预批准锁定包/权重与受控venv，禁止任意pip/shell、OS全局安装；准备阶段根部署依赖，重复安装幂等；缺包真实清单上报但不能先排除 |
| `transcribe_media` | `{mediaId,engine?,model?,language?}` -> jobId；get_transcript得segments | 经asset票据取本项目素材，CPU small可先测；fixture真实语音验文本/时间区间并写doc（不是page本地store），截断/无音频返回明确错 |
| `detect_shots` | `{mediaId,force?}` -> jobId；list_shots得shots/transitions/engine | 复用 `python/promptcut_shots`，ffmpeg scdet兜底真实hard-cut；TransNetV2条件准备后测dissolve；source media拼图同步接see_frames |
| `track_points` | `{mediaId,points:[[frame,x,y],...]}` -> jobId | 复用 `python/promptcut_track` CPU模板匹配可行；BootsTAPIR权重条件真实测；移动fixture验轨迹，跨项目mediaId拒绝 |
| `get_track` | `{mediaId,full?}` -> running/engine/tracks/summary | 结果存doc项目副本，不存全球mediaId map；完整轨迹只按已授权项目取 |
| `track_status` | `{}` -> ready/engine/detail | 同服务受控Python status，不能report根主机路径/密钥 |
| `track_install` | `{}` -> jobId或明确已就绪 | 锁定track依赖、重量权重部署准备；CPU fallback仍能完成真实追踪；禁止模型任意指定安装包 |
| `detect_subjects` | `{mediaId,times?,prompt?,force?}` -> jobId | 复用 `python/promptcut_subject`，light YuNet/RT-DETR CPU优先，full DINO需要权重；英文prompt规则保留，light不假装prompt生效 |
| `subject_status` | `{}` -> ready/engine:'light'|'full'|null/detail | status真实检查依赖与权重；无环境明确error而非空boxes |
| `subject_install` | `{}` -> jobId | 锁定light依赖；节点权重部署测试；full按本机已有契约不通过在线装，不能改成本期排除full能力 |
| `attach_clip_motion` | `{clipId,mediaId,pointIndex?,whenHidden?}` -> movedX/movedY/visibleFrames/warning | 有track后在Agent项目副本route执行，clip类型/时间重叠校验；doc提交记录run/op关联；画面随轨迹需对应渲染探针 |
| `background_job_status` | `{jobId}` -> job/status/progress/result/error | 拟持久job store，跨run/project jobId无法读；服务重启running标interrupted或续可幂等阶段，保留真实状态 |
| `auto_workflow` | `{mediaId,style?,maxCards?}` -> jobId | 分阶段stt/shots/subject/卡片/字幕/补渲，均由doc同一run归属；不跳过已失败感知装成功；不调用关闭的spawn_agent |
| `auto_workflow_status` | `{jobId}` -> stages/progress/result/error | 同job store、取消/项目关停/重启；真实短片验不是仅安装状态 |
| `web_open` | `{url}` -> screenshot/image/clickable/page | 拟`hosted-browser.mjs`，Chrome按project×conversation独立browser/profile，正常headless网页浏览（不能复用渲染确定性进程）；受控出网代理拦回环/内网/DNS重绑定/redirect/IPv6/file/下载/WebRTC |
| `web_view` | `{}` -> 新截图和clickable | 只本对话browser；相同project其它conversation也不可取其profile；截屏字节经受权visual路径交UI/model |
| `web_click` | `{u? ,x?,y?,expect?}` -> 新截图/clickable或candidates | 最近一图element revision绑定，旧u失效；无法命中不能静默点别处 |
| `web_type` | `{u,text,append?,submit?}` -> 新截图/clickable | 保留本机禁止代理填写密码/验证码/凭据；登录需handoff到本人电脑，凭据不上节点 |
| `web_scroll` | `{dy?,to?}` -> 新截图/clickable | 真实滚动fixture验位置与编号重置 |
| `web_read` | `{limit?}` -> text/truncated | 页面数据不当指令；禁止内网/本机页面、另一project网页/profile读取 |
| `web_close` | `{}` -> closed | 只关闭本Agent自起实例，释放数据目录；不结束别的会话/用户浏览器 |
| `measure_audio_js` | `{code,clipId?,mediaId?,scope?,start?,duration?,sampleRate?,mono?,timeoutMs?}` -> JSON摘要或带位置error | 拟`hosted-audio-js.mjs`；`server/hosted-render/look.mjs`新增签名`/api/audio/measure-js`，受限worker只收已授权PCM，断网、无Node、时间/内存/256KiB输出上限按本机；已存在measure_audio走ffmpeg不被替代；验纯正弦数值/超时/越权脚本 |

感知实现来源是 `server/vite-plugin-{stt,shots,track,subject}.ts` 和 `server/perception-source.mjs`；它们当前jobs在进程内且页面负责写结果，需要抽取adapter/job逻辑到拟 `server/agent/service/perception/`，desktop插件改薄壳的接线交专人串行，不能云端直接调用Vite `/api/*`。部署依赖/权重由根负责，不由设计子任务安装；先CPU能跑的路线，不因没有GPU提前排除。重型权重若确受节点条件阻挡，按solution_table逐层处理并记真实未达成，不允许视作工具完成或把三个版本终点缩小。

`web_handoff {reason?,hide?}`：**操作本人电脑界面的工具**，在线时经安全反向通道显示本人本机浏览器登录/验证窗口，云节点只返回handoff需求与状态；本人不在线回initiatorOffline。云端匿名浏览器遇站点登录不上传cookies，不把本机登录同步给云端profile；交接针对本机采集通路，返回可由匿名继续访问的公开URL/已下载素材，不宣称云端获得该站身份。〔裁，卡点9第1行〕这条是满足“登录信息不离开电脑”的最小产品接法，界面说明交接只作用在发起电脑，不能做假的远程有头窗口。若web通用登录页面必须同浏览状态才可继续，则转本人电脑执行该段web动作，经同样反向通道返回经审核的公开结果；没有本人在线明确offline，不偷偷走凭据上传。

`collect_login`、`collect_login_check`经发起本轮电脑现有本机采集登录窗/状态，返回就绪布尔/站点名，无cookie/header/profile内容；`collect_download`缺省匿名云端下载，明确需要登录且本人在线才发project/run/page-bound代下载请求，本机工具用自己登录信息下载并直接上传到**该项目**asset。服务只接 `{requestId,jobId,assetRef:{projectId,hash,size},result}`，doc/asset核真实入库与run授权，禁止把本地path/凭据发云端；网页/浏览器发起者不是电脑且不能代下时匿名回退。离线、超时、失败也匿名回退并注明画质/原因；取消或者切private/踢人后page-results不能再交旧job产物。云端collect_install保持受控部署状态能力，不因工具名称允许任意装系统依赖。

`spawn_agent`在0.7.18～.20每种登录/在线状态都固定 `{ok:false,error:'云端暂不支持开子 Agent'}`，无需发起方在线判断；本机spawn保持原行为。保留其它公告板工具但project/conversation scope检查，不能读另一个project。

可视化收尾：`get_gif`返回用户可读受权动图；see_frames、前后对比和source:media镜头拼图可在聊天栏打开。拟Agent conversation内 `visuals/<visualId>.json`存规格/记录，受权 `GET /agent/v1/conversations/<id>/visuals/<vid>` /files读取；gif/截图bytes可用asset px，但必须project+conversation ACL核对，不能直接用成员asset票据读private视觉记录。〔裁，卡点10第1行〕private visual字节优先经Agent受权文件端点（即使底层px保留），shared visual按同一conversation检查；缓存key含aclRevision，visibility改变即废。复用 `src/editor/right/ToolVisual.tsx`，不是新建另一个聊天UI；前后对比惰性渲染但保存完整spec/sourceRev，版本变化不伪称同一画面。`8fb6df79`的“已知hash跨项目可读”只是一条已失效风险记载。

节点收尾还有：import_media小尺寸档、Linux ffmpeg响度/真实yt-dlp、render开关气泡、发起页面刷新后安全恢复page绑定、示例句真做短片、退出软件后云Agent继续及托管渲染入库。都单列探针，不用23项表代替这些产品结果。pageId仍只绑定真实login/run，刷新只本人新page经一次恢复握手取得旧run page-binding，不让别成员看同对话就成为initiator。

## 真实旧文件、本地转换与缺失素材

当前 `src/editor/io/proc.ts` 的 `PROC_VERSION=1`保存project/cards/ai/snapshots/collaboration；`server/recovery/descriptor.mjs` v1关联含roomId/service/where，不是授权。`src/editor/io/procp.ts`实际先unpack、按hash上传本地，`landed`再 `dropPackedPaths`；必须保留这个顺序和成功落地hash信息。`server/recovery/coordinator.mjs`目前 `saved.revoked -> deleted`、`no-project -> deleted`会把本地状态/泛错误当删除，此两支对**hosted**不能直接触发转换。

〔裁，卡点11第1行〕拟新增恢复证明结构 `goneProof={v:1,authorityId,projectId,state:'gone',tombstoneRevision,issuedAt,kid,signature}`，doc权威签发，服务身份与项目号必须精确匹配文件关联；已部署旧节点authority通过已确认托管地址身份映射与新authority核验，不能任意错误节点404。公网status可给准确gone状态但不披露项目内容/成员；一个泛HTTP404、账号网站empty、超时、bad password、credential revoked、banned、local.deleted、连错节点均不可转换。无可确认proof保持原关联和内容，提示认证/权限/暂不可用；不补造云端最后一次保存之后的修改。

转换输入先完整解析和校验可读project，保留原 `.proc/.procp`，产生**新本地project id**，保存来源roomId/authority供提示/追溯，不保存云账号凭据；`setAssociation(null)`且关闭协作，提示一次。保留tracks/clips/params/theme/media hash/path/卡源码/ai和可用snapshots；云端message历史不能用本地file旧快照冒名在线新对话。保存成功的新文件不含活跃hosted collaboration；重开不再试旧项目。失败保留原文件和内存内容，不用空project落盘，另存成功后才更新save target。损坏矩阵覆盖JSON截断、zip截断/CRC、空包、无project、旧裸Project、未知proc/association版本、坏roomId、部分缺卡/素材、落盘中断；未知可读版本不能静默升级丢字段，保留可读原文并显示unsupported。

素材恢复优先级：`.procp`实际成功landed的hash -> 本机已有合法hash -> 原guarded本地path -> 明确旧云端素材缺失。包内有素材不因云端项目gone或旧path坏误占位；hash不符/ZIP损坏单独报错，不伪称可恢复。临时下载失败、无权限、不可解码与真正not-found分列状态；只确认missing才替代显示/声音。原media对象和引用留存，不将临时文字卡替换后删除source信息。

〔裁，卡点12第1行〕占位用独立可序列化 `missingMaterial={v:1,mediaId,original:{hash,name,url,path?,kind},reason:'confirmed-missing',visual:true/false,audio:true/false}`状态（放项目恢复元数据或稳定media字段），渲染层建立等时长缺素材代理；不改原clip start/end/offset/速度/轨道/volume/mute/fades。视觉在原片段矩形显示默认文字卡“找不到素材xxx”，不让相邻片段挪位。音频用软件内 `src/audio/assets/missing-material.wav`（1.37秒，48kHz mono，SHA256见account-binding-contract）从**片段开始**播放一次，短片段裁切，长片段余下静音，不循环不断喊；保留原mute/音量/淡入淡出和时间轴duration。原视频画面与音轨均缺失，则同一片段同时文字代理+这段人声，不额外创建重叠声音剪辑。音轨已分离或源视频静音只在实际缺且可听的那条音轨响；图像无音轨不强加人声。原素材重新找到、验证hash后清missing状态恢复原引用/params。

代理人声不是项目素材、不上传asset、不打入procp；desktop/online/render节点构建各带同一文件，在软件相应public/静态资源受控路径使用，不能使用本机绝对文件路径。previewAudio、renderMix、导出、发布后的另一设备均能播放，尽可能共用missing代理source adapter（拟`src/editor/io/missingMaterials.ts`、`src/audio/missingMaterial.ts`），renderer worker可获取软件builtin资源而不能将builtin读口变成任意节点读盘。确认missing弹窗列逐项恢复状态；保存重开保持代理且原引用可找回。

旧数据实际验收由根执行：先一致备份doc/auth/hosting/tombstone历史、assets/jobs、账号SQLite及配置版本；隔离恢复副本实际启动读取恢复项目和素材，对实际旧 `.proc/.procp`保存文件hash和恢复内容摘要、真实媒体完整/部分/全缺矩阵；随后列精确projectId/目录/refs/保留对象删除清单，完成删除后由doc读准确goneProof。再从真实旧文件双击/菜单打开，验证内容、默认协作关、占位文字、人声试听和有声导出、保存重开仍本地、procp本地素材不占位。保留备份；转换/恢复失败停后续清理，不能用合成fixture替代真实旧文件这关。
