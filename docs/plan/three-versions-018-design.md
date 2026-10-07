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
