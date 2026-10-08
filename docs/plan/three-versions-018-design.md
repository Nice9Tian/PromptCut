# 0.7.18 迁移设计与跨仓库接口

2026-10-08，代码核对起点 PromptCut `7b4b7106`（含 `6f85cd78`），最终语义另只读核对 main `bf6e48e6`；VisuHive 核对点 `a2ebd001`。本文是可派发的实施协议，新增接口、模块与结构均标为**拟实现**，不把设计当上线事实。主会话已经获得三版本连续实施授权，按包推进，不再次等待计划审批；一级语义改变或后续完全无法选型才停。已有用户决定不标待决。本文不修改任务书或一级语义。

## 范围、来源与当前缺口

0.7.18 做账号、在线创建、云端 Agent 余项、共有/私有及可信已读、退出记录、素材隔离和旧文件恢复；0.7.19 做三道闸门、确定快照和离线合入；0.7.20 做逐项补偿与申请加入。0.7.18/.19 的退出区间修改保留，仍从 0.7.18 开始完整记录供 0.7.20 使用。生产 Agent 从未部署、没有历史对话，不需要主人键历史迁移；旧测试项目及实际旧文件需要真实备份恢复和转换验收。

必须以 `docs/plan/account-binding-task.md`、`account-binding-contract.md`、`online-browser-task.md` 和 `docs/semantics/product/{agent,document-service,asset-service,platforms}.md` 的 2026-10-08 决定为准。`docs/plan/three-versions-brief.md` 第 5、8、9、11 节是现场、分工、执行裁定和交付指路，不是另一个权限来源。资料旧句子“只授权文档、未实施”描述历史，不能覆盖本轮授权。

| 旧资料段落 | 现状或已失效部分 | 迁移与实际模块 |
|---|---|---|
| `cloud-agent-contract.md` §1、§3、§7.2；`auth-contract.md` §1、§6、§17.1 | 主人用 `creator` / `user:<username>` / `device:<userId>`；实例按项目×主人；自由成员换设备失去历史 | 云端一律 `accountId`，对话按项目×conversationId，所属账号只用于归属和管理；改 `server/auth/delegation.mjs`、`server/agent/service/{create-agent-service,conversations,instance,workspace,usage}.mjs`、`src/ai/cloud/identity.ts` |
| `cloud-agent-contract.md` §2.3–2.5、§7.1、§7.4、§10 | 列表、历史、事件、附件按主人隔离；发消息遇正在运行回 `busy-conversation` | 所有读取/发言/附件/可视化/诊断与订阅按项目和对话 ACL；一对话一个当前轮，其余服务端 FIFO；改 `server/agent-service/http.mjs`、上述 service、`src/ai/cloud/{cloudApi,session,events,types,useCloud}.ts`及聊天 UI |
| `cloud-agent-contract.md` §4.3；`hosted-wiring.mjs` 的 `verifyCacheMs:15000` | 凭票据摘要缓存身份 15 秒；SSE 只按项目/userId关闭 | 去掉授权放行缓存，逐请求问文档权威；持续订阅用 ACL revision 屏障与逐事件核对；切私有先关闭失权流和排队/写入，再提交可见状态，不能等缓存或 ping |
| `cloud-agent-contract.md` §4.4–4.6、§5；`auth-contract.md` §17.2–17.4；`hosted-render-contract.md` §1.4、§8 | 代成员票据继承 creator、只读可发起、撤销一律停整对话 | 发消息就拒只读，每轮以实际发起账号核验有效成员，Agent永远无管理员能力；可信已读共有当前轮可继续，单独持久 run grant；私有停；actor新增 sender/run/msg/session归属 |
| `cloud-agent-contract.md` §7.3、§7.5、§16、§28 | 对话最多一轮但无 FIFO，进程恢复标 interrupted，委托原文只存内存；反向通道看主人/userId/pageId | 持久 messages、queue、runGrant与read ack；正常进程中断仍可按原中断语义记录，跨重启保留已读事实和豁免授权，不强制自动重放外部副作用；队列恢复后重新核成员；反向通道绑定本轮真实发起账号/登录/pageId |
| `auth-contract.md` §3–5、§7–8、§11–12 | 云端还接受自报用户名+设备、项目派生密码、按设备踢人 | **仅 hosted 云端**改 account认证、account bans/generation；LAN路径保持 `server/auth/{client,pure,handshake,invite}.mjs` 旧规则；cloud分支通过 `server/docservice/shared-service.mjs` 单处接线 |
| `auth-contract.md` §8；`hosted-render-contract.md` §1.6、§7.5 残余；`cloud-agent-contract.md` §4.4、§9 | 任意项目票据凭已知hash可读任何素材 | `server/asset-service.ts` 的真实 storage selector按project隔离，media/snap/px、索引、staging、tier、thumb、stream、worker、转码及队列产物全覆盖；见素材协议 |
| `cloud-agent-contract.md` §9、§23–28；`cloud-agent-task.md` J | 本机与云端工具一致；pending工具和登录通路未完成 | 按下文真实23个pending及额外欠项补齐；§9.4d/§27/§28的登录上传方向失效；spawn_agent固定关闭，不算待实现 |
| `online-card-exec-contract.md` 隔离/执行/素材授权；`hosted-render-contract.md` §1、§5a、§7、§8a | 执行隔离和服务身份已实现，不能绕过项目读 | 保留Ed25519服务身份、角色白名单、隔离进程，追加project ACL/产物归属；舞台不接账号cookie，不向卡代码交凭证 |
| `online-card-exec-contract.md` 的出口限制/Connection-Allowlist fallback、`platforms.md` 2026-10-08补记；旧集成两条〔裁〕 | 不支持Connection-Allowlist就不执行、外链不能加载，均已作废 | 所有浏览器执行用户卡/图卡，图片/字体/样式/脚本外链照常；三版本不做卡片出口护栏。保留stage/editor分源、握手与project素材隔离；改 `src/online/{isolation,cardRuntime,stagePolicy.mjs}`及真实nginx模板 |
| `hosted-render-contract.md` 数字容量与“已满/本机降级”、`agent.md`旧发起页面专属选区 | 数字先沿用并由节点复核，超容量旧拒绝及原页专属选区失效 | `server/hosted-render/{limits,broker,main,isolation}.mjs`持久排队、Agent优先；`get_selection`改项目全员在线选区，标用户名和发起人，离线发起人用非实时快照；没有生产旧对话迁移 |
| `four-stage-deploy-checklist.md` A3/A4/B1/B4；`HANDOFF-four-stage.md` §4、§5甲乙、旧周额度与笔记本 | 三版本合一、只补丁、不备份整数据、等5分钟/3小时、模型密文待用户提供等历史句子 | 三版各完整包+patch；一致备份和实际恢复；旧测试项目临时例外三版适用；cipher已经待导入；网站后端先、site最后；新主分工Sol/Luna/Astra |

模块路径以检索结果为准：中央文件是 `server/docservice/shared-service.mjs` 和 `server/docservice/service.mjs`，不存在 `server/docservice/server.mjs`。工具声明是 `server/tools/*.mjs`，不是 `.ts`。旧分支 `8fb6df79` 仅有未完成选型提交，无产品代码；只参考其动图/visual思路，不合并它。`product/agent.md` 运行位置仍有“同用户名”“主人独享”“一律停”等旧段落，与其接入段和本次决定冲突；实施契约同步包修正，不能拿旧段给权限放行。

## 调度补充的设计边界（2026-10-08 文档增量）

来源：[渲染调度与项目计划补充](render-scheduling-supplement.md)，版本/验收唯一映射见 [任务书](account-binding-task.md)「渲染调度与对话上限补充」。0.7.18 新增合格本地即时查询帧优先、云端单活跃项目兜底；0.7.19 预算实测满足才双项目并行；0.7.20 磁盘缓存/交替加载目标至少三项目持续推进，不承诺三重型常驻。三版本全部生产容量输入含自定义卡片，see_frames 端到端 <5 分钟是目标。此设计增量仅已规划，不是代码接线或测试结论。

| 修改前 / 本文旧方案 | 修改后（已确认范围 / 技术草案） |
|---|---|
| 渲染容量章的 2 任务/16 项目数字和“不让 editor 改成本机” | 已确认 .18 云端单活跃项目；数字暂沿用并实测，连接/任务数不能突破活跃项目约束；只禁止云端满后的静默回本机，合格本地优先合法 |
| 202 render-requests、GET/取消/事件接口及 OOM 重排队 | 修改后（草案）：本地资格/一致性/取消/迟到隔离与云端队列组合设计；已有拟接口不是逐项批准或现有能力。故障/无进展的 A 失败手动或 B 有限重试暂停待确认，正常容量等待仍保留任务 |
| .19 原仅平台闸门/.20 原仅补偿与申请加入的派包计划 | 追加 .19 有条件双项目内存实验与 .20 磁盘轮换包；独占文件与具体接口由后续协调另租，不在本次文档中自定/开工 |
| Agent ACL 表 rename/remove 的 owner 边界和删除 UI 延期 | 已确认 .18 必要删除入口与 50 满额阻新建；删除权限/确认/共有计数/释放时机待确认，原 API owner 不能代替决定 |

未满 5 分钟提前回收与旧隔离工作进程 60 秒/45 秒规则有冲突，旧机制仅历史/待协调；本次不以最小裁定选择新策略。内存 7+7+2 / 5+5+6 GB 是示例，不能默认。具体计时起止、重试、超时和缓存机制均按任务书“修改前/修改后（草案）”落清；semantics 正文未改。

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
| `GET /api/account/cloud-agent-consent` | website cookie或editor bearer，分别入口按对应防护 | `{accountId,accepted:boolean,noticeVersion:1,acceptedAt?}` | 401 login-required、503 unavailable |
| `POST /api/account/cloud-agent-consent` | 同上，cookie要求CSRF；`{accept:true,noticeVersion:1,requestId}` | `{accepted:true,noticeVersion:1,acceptedAt}`，同账号跨设备幂等 | 不接受代别人accountId；旧version 409；拒绝不调用此接口 |
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
| `POST /internal/v2/order/reserve`、`/<id>/seal`、`/<id>/cancel`及`GET .../<id>`（account提供） | doc唯一调用者 | `{requestId,docAuthorityId,projectId,opId,actorRef,payloadDigest,preparedDigest}`；reserve/seal及接受定义见可信区间；409 digest-mismatch，401 credential-revoked，503 unavailable |
| `POST /internal/v2/order/logout-complete`（account提供） | doc | `{eventId,endCursors,serviceAckDigest,requestId}` -> `{endOrderSeq,utcMs,signature}`；重复回同一结束见证，不承载project写操作 |

既有Agent控制连接 `hosted.delegate.verify`、`hosted.ticket`扩展v2身份，增 `hosted.run.admit`、`hosted.run.read`、`hosted.run.finish`、`hosted.conversation.access`（下节），保留服务Ed25519握手和白名单。消息支持requestId/receiptId，后端先提供再消费。

同域官网/editor使用 `vh_session`（可后续兼容改为__Host前缀），`Path=/; HttpOnly; Secure; SameSite=Lax`，**不设Domain**。不记住：session cookie不带Max-Age，服务端设24小时绝对上限；记住：保持现有30天滚动寿命，续期同时刷新cookie与数据库，不能无限仅服务端续期；两种均有可撤销loginId。browser编辑器恢复依官网cookie，不能在localStorage另存永不失效登录；desktop vault只保存可撤销随机恢复token，不保存password/key派生物，access短期内存。〔裁，卡点3第1行〕短access 2分钟、desktop恢复30天滚动、未记住24小时属于机制，实施时同步参数文档。

Cookie接口所有写方法（含登录、注册、reset，防登录CSRF）要求 `Origin === https://visuhive.com`，精确scheme/host/port，拒null与无Origin；JSON内容类型精确解析并要求CSRF头，与服务端session/匿名nonce绑定，不在URL；Fetch Metadata拒cross-site。GET只读且no-store。bearer desktop接口单独路由，不收cookie、不返回Allow-Credentials；公网上真实来源由可信nginx覆盖 `X-Real-IP`，忽略直接来访伪造头，试密码共享同一limit库。旧 `sslip.io/editor`不能收到visuhive cookie：提示去正式同域入口或明确登录，不能复制cookie到别的域。

编辑器主文档CSP仅允许self脚本及明确舞台 `frame-src`，禁止unsafe-eval、object、任意外部connect；这是官网/editor自身防护。官网内联代码改外部模块或固定hash/nonce。**卡片stage的出口限制不做**，不能将主文档CSP或worker proxy规则复制到用户卡stage：外链图片/字体/样式/脚本照常加载，Connection-Allowlist缺失不触发fallback。stage分源且无account cookie；卡片不能取得editor DOM、会话凭证或内部服务证书，账号写接口仍有精确Origin/CSRF，doc/asset/Agent读取仍须受权，素材只经project-scoped `media-s`委托。跨源结构和接口授权保护账号/项目，不能借此恢复已取消的卡片外发拦截。新策略在实际Chrome/Edge/Firefox/Safari（无Connection-Allowlist也执行）和真nginx验外链fixture、stage脚本摸editor拒、跨项目同hash拒；0.7.19闸门仍负责设备实际能力。

### 持久记录与版本

VisuHive `account/store.mjs`当前SQLite只有accounts/sessions/codes，密码事务和会话删除非原子；拟 `PRAGMA user_version=2`，原表增兼容nullable/default字段，迁移在事务内。新增 `login_credentials`（id/loginId/tokenHash/kind/generation/remember/createdAt/expiresAt/revokedEventId/rotatedFrom）、`password_events`（eventId/requestId/accountId/changeSeq/changedAt/clock/initiatorWebsiteLoginId/oldLoginIds/choice/choiceSeq/logoutState/modificationState）、`outbox`（eventId/seq/payload/status）、`consumer_acks`（eventId/service/cursor/result）、`rotation_results`（旧tokenHash/requestId/result密封短期存储）。hash不是可用凭证；实际token结果不能写日志。password change不自动增全账号授权代数；只有选是产生对应受影响登录的持久撤销。重设成功建立发起website会话并保留，其余旧会话在选择前完整保留。

拟新增 `account_consents(accountId,noticeVersion,acceptedAt,requestId)`和上述`order_witnesses`及唯一seq计数；同SQLite事务/备份，登出或改密不删除账号同意。告知文案和两按钮是用户已定，noticeVersion固定1，此版本不新增反复同意规则。拒绝不持久为“已同意”，下次云端使用继续弹。

doc拟新增 `server/account/{authority,client,ledger,clock}.mjs` 与 `server/docservice/modules/account-projects.mjs`，分别管验证客户、幂等撤销账本、可信时钟证据、云端项目权威接口。account事件 `(issuer,eventId,seq)` 去重，收到seq跳跃拉缺口，旧seq ACK不倒退水位；收到撤销但密码事件尚未到则暂存不猜时间。doc的project/access/run/operation日志在一条可恢复提交序列里写先后关系，fsync成功才确认。不能沿用conversation当前“写盘失败仍广播成功”的行为保存授权/已读；授权日志持久失败应503并禁止启动下一轮。

## 改密、退出完成点与0.7.20的操作历史

### 密码成功和退出分开

密码事务用服务器requestId幂等：核当前密码/reset验证码、计算新密码hash，进入事务写password与事件/outbox，成功提交后回“密码已修改”（或重设成功），**之后**显示是否退出选择。密码核对失败无事件、不显示成功。事件初始choice=pending；用户取消/关页面仍pending，下次同发起网站会话读状态可继续选择，不能默认退出。选否原子写retained，保留所有登录、恢复凭证、项目访问和写入，之后新密码用于新登录。选是原子固定受影响集合并写revocation/outbox。选择是/否仅首次有效，同requestId重试回原结果。

受影响集合是密码成功时存在的旧登录ID，减去发起的website登录ID；包含所有旧editor登录（包括发起电脑editor），其余website登录。密码成功之后用新密码产生的新loginId不属于集合，不能只按 `accountId`一刀全部撤销。连续两次改密各自用独立事件/集合/顺序；重叠登录只撤一次，但每个事件均有完成结果。邮箱reset保持/建立的当前website登录是本次发起会话，旧其它website照集合处理。

账号先持久撤销旧refresh/access记录，doc迟到时已有连接可以继续编辑，但新登录/创建失败明确报不可用。doc收到事件后立刻建立旧loginId拒绝屏障：所有新握手、resume、逐消息gate、素材票据签发、Agent消息和订阅拒旧登录；将旧连接标revoking并终止page/本机Agent/私有云Agent/不满足例外轮。asset/Agent/render收到project/login撤销后停止旧流和入口；共有已读当前run换专用授权继续，不算仍登录。不能用ticket TTL、15秒缓存或“通知稍后到”报告已退出。

退出完成不等浏览器真正显示已退出或等待共有run结束，而是：account旧凭证持久不可用；doc旧连接全部关闭或进入永久拒绝状态且不能resume；asset旧票据/Range/stream授权不可继续；Agent失权read/SSE/page-request/queue已关闭且私有任务的提交权限已撤；各相关服务持久ACK确认屏障。doc收集多连接 `{connectionId,loginId,lastAcceptedOpSeq,closedAt,closeClock,reason}`；先登记撤销时全量连接，再到所有入口屏障提交点查新增连接（应为零），记录 `endCursor`、最大closeClock和服务ACK。`logoutState='complete'`需无pending服务；网络断开后不能凭连接消失跳过授权撤销。界面一直“正在退出已登录设备”，失败显示具体仍待服务与可重试；重新打开查持久结果，不能将timeout算完成。

### 可信区间，而非比客户端时间戳

〔裁，卡点4第1行，三级〕选择**账号SQLite持久统一顺序见证 + doc独占项目接受事务**。account只回答时间/顺序，不核项目成员、不接project写指令。新增 `order_witnesses={issuer,orderSeq,witnessId,kind,requestId,docAuthorityId,projectId,opId,actorRef,payloadDigest,preparedDigest,state,utcMs,signature}`；其中actorRef仅accountId/loginId/credentialId/runGrantId，不含项目内容。密码事件与见证seal都在同一SQLite写序列分配orderSeq；密码hash、eventId、changedAt、oldLoginIds与outbox在一个事务成功后立即回成功，再问退出，无doc往返依赖。可信绝对时刻由account在该成功事务内记录UTC，附clock quality/进程启动信息用于诊断；区间精确排序用orderSeq，不把客户端时间、两个Date.now或两个hrtime比较。`bootId/process.hrtime.bigint()`即使在同Linux也**不作为正确性依据**，不同进程、Node升级、重启或分机都按签名见证处理。

拟内部两步 `POST /internal/v2/order/reserve` -> `{witnessId,state:'reserved',digest}`，`POST .../<id>/seal` -> `{state:'sealed',orderSeq,acceptedAtUtc,signature}`，另有`GET .../<id>`与`POST .../<id>/cancel`。只doc服务证书可调用，requestId+opId+preparedDigest幂等，digest变更409；reserve没有修改接受含义、没有区间归属，不能用reserve早于改密判断操作早于改密。seal要验editor credential此刻有效，或者由doc签署已读retained run的精确项目例外；account只核账号撤销和服务身份，最终项目/run合法性仍由doc决定。密码夹在reserve/seal之间，则sealed orderSeq必在密码changeSeq之后，归旧凭证候选；新的合法登录不入选。

**精确接受点与提交约束（Astra必须实证）**：doc在该项目提交锁内核project/member/credential/run/private/stop fence，生成不可变before/after、下一个projectRev和完整恢复记录并fsync `prepared-op`；该记录尚未接受、不回成功、不广播、不改可见snapshot。随后取得reserve，并在同一提交锁内复核fence，发seal。account持久seal是该doc授权事务的逻辑接受点；doc只在验证sealed签名后补写 `accepted-op {orderSeq,witnessId}`、fsync并materialize同一恢复记录，才回成功和广播。doc仍是产生/提交这条修改的唯一服务，account不能凭自己的见证构造任何修改。取得reserve后尚未seal的操作遇stop/private一律cancel，绝不能replay；sealed操作已经是不可变、可恢复接受记录，崩溃后只落同一份prepared内容、不重新执行工具或模型。prepared必须包含足以完全重建实际修改的内容，account只存digest；签名seal丢失从account查询，查明前不重试另一个op、不放出此项目的后续提交。

同一个项目的stop/private/delete fence与seal/materialize用**同一提交锁和持久序列**排顺序；fence先则不得seal，seal先且该恢复修改已接受则先完成该份落地再提交fence，fence以后的请求全部拒绝。期间用户撤销读取的控制面可先关闭流，新写立即进入暂停/拒绝态，但不能提前回“切换已完成”；成功点必须任务fence、既有接受记录收口及撤销ACK全部完成。进程崩溃或seal响应不确定时对该pending事务先查account结果：reserved/cancelled不接受，sealed仅恢复已接受内容；完成收口后才落后续fence/重新开放。不得因收到旧credential撤销通知把此前sealed记录改名成新登录，也不得把未sealed intent当已落地例外。账号撤销的序列若先于seal，account拒seal；此时即使doc还有旧内存身份也落不进修改。该提交锁范围、请求超时和取消结果必须有产品探针，不能以长时间锁定或缓存宽限冒充立即权限生效。

account不可达时，云端新修改不能取得可信接受见证，保持未接受/可重试且不广播；这是云账号逐请求核验既有fail-closed要求，不新增doc离线导致改密失败的体验。已读共有当前run授权仍持久保留，相关写阶段暂停重试、不假装成功或撤销run。account自己SQLite失败则密码事务本来就失败，不弹成功选择；doc离线时密码照常成功，outbox在doc重启恢复后按changeSeq消费，所有旧登录在开放连接前拉齐head。机器/进程重启不重置orderSeq；重复seal回原结果，cancel不得覆盖sealed，旧ACK不降水位。完整prepared/accepted与account witnesses必须一起备份；缺任一证据标 `modifications='needs-reconciliation'`，保留历史和撤销状态，不猜补偿，阻挡0.7.20补偿发布但不阻挡独立卡片/素材/工具包。

区间上界为受影响旧登录全部访问屏障和连接收口后，doc向account追加幂等 `kind:'logout-complete'`见证，记录`endOrderSeq`；同时保留各project `endCursor`、各连接`lastAcceptedOrderSeq`及各服务ACK。doc须先结清所有pending seal，不得先报退出完成、后悄悄落旧操作。候选同时满足accountId相同、loginId在oldLoginIds、credential/generation旧授权、`changeSeq < op.orderSeq <= endOrderSeq`、doc已接受且project匹配；实际修改只从doc accepted日志取，纯reserved/cancelled不是修改。新登录、其他账号、无关项目与精确共有已读当前runGrant均排除；不能用保留一个run豁免整账号。

替代卡点4第2行是独立顺序服务（同机制但新增部署对象，4+1=5），第3行是跨服务时钟误差区间（无法证明边界操作，2+5=7，关闭·剪），第4行原“doc准备屏障失败就改密前503”是二级锁住且本稿不选。第1行3+1=4，先由Astra独立故障包核reserve/seal/accepted每个持久点、私有/stop race、改密夹缝、UTC跳变和重启。**这是可派发方案而非已证通过**；若seal逻辑接受与doc落地不能在真实代码中满足上述尺子，必须继续三级候选/故障实证后由root裁定，不能强制偷改已定改密流程、错撤或让未提交操作穿fence。
### 从0.7.18保留到0.7.20的撤回信息

拟操作日志v2字段：`opId/requestId,projectId,authoritySeq,projectRev,actor,acceptedClock,orderSeq,witnessId,ops,changes[],dependencies,runGrantId?,compensatesOpId?,result`。`changes[]`每项 `{itemKey,before:{present,value},after:{present,value},beforeVersion,afterVersion}`；itemKey用对象稳定ID+JSON子路径，数组增删/移动同时记录父容器结构版本，不用易漂移的数组index充当永久身份。整root replace在服务端拆成实际叶项/结构变化，不能只存摘要；无法安全拆的结构项整体作为一项，对后来结构修改保守判冲突。内容库card-source、素材引用变更也记录before/after，不仅project.op。

〔裁，卡点5第1行〕未完成password事件及其候选操作、已读message/run链、before/after和基准snapshot不可淘汰；完成后按项目生命周期保留审计与选择性撤销所需历史，容量达限拒相应新写或明确告知维护需求，不能静默删除未处理区间。conversations的8/12MB降级只能压缩thinking/diagnostic，不能去掉sender/read/run/queue/ACL审计。每次snapshot压缩保存引用中的操作历史；账号备份含outbox/acks、doc备份含历史及clock witness。

0.7.20补偿在项目写锁下逐item比较：该项以后被**别人账号**写过/基于该项做派生结构变化即冲突，即便值后来巧合相等也不撤；本账号新登录的合法后续写也保护，不能被旧凭证补偿覆盖。逆序撤同事件旧操作，给其自身补偿建立版本链；若无法证明未被后续合法修改依赖，保留该项并记冲突原因。对可撤项发普通审计操作 `{opId: eventId/projectId/originalOpId/itemKey,compensatesOpId,expectedItemVersion}`，版本在检查与提交之间变化则重新判，不根替换。重复补偿回原结果，不重复version+1；私有任务已落地修改在区间内仍按逐项规则撤，共有已读当前轮改动排除。

0.7.18/.19只记录 `modifications={state:'retained',candidateRange}`，绝不执行上述补偿；0.7.20显示处理进度独立于logout，失败保持 `pending/retrying/needs-reconciliation`，按持久任务续办，旧授权保持撤销。完成可报告changed/reverted/conflicted/exempt项数和证据，不弹改密冲突窗口。用户普通撤销（含AI“撤销这一步”）独立实现窗口：〔裁，卡点6第1行〕列出逐项当前值/原改值/还原值，给“只撤无冲突项”“选择冲突项覆盖”“取消”；没有冲突直接撤。窗口期间版本变化再核对、不能用同一窗口覆盖新冲突；该机制不修改已定的改密冲突不撤规则。

## Agent共有/私有、FIFO、已读与任务授权

**首次告知（0.7.18已定）**：首次云端Agent使用弹框，逐字显示“托管方能读到你和云端 Agent 的对话记录，包括私有对话”，按钮逐字“我知道了”“拒绝”。云端托管方读取节点记录的事实与成员ACL分开说明；不能在UI承诺托管方也看不到private。按账号服务持久同意跨设备保留；“拒绝”保留用户未发草稿但不发送消息、不入队、不生成read/runGrant、不调用模型或工具，下次用再弹。UI在send前查consent，Agent服务接收入口经doc/account核同意，绕UI直调返回403 `consent-required`；同意记录服务不可用不能先发再补。同意后私有/共有完整授权仍照下文，告知不授予其他成员读取能力。

拟对话结构v2存 `tenants/<projectId>/conversations/<conversationId>/`（不再owner目录决定访问），`meta={v:2,id,projectId,ownerAccountId,visibility:'shared'|'private',aclRevision,title,state,currentRunId,queueRevision}`；`messages`每条 `{messageId,requestId,arrivalSeq,senderAccountId,senderNameAtSend,loginId,credentialId,createdAt,content,queueState,runId,readReceiptId?}`。所属账号永远是创建对话者；sender永远实际凭证账号。model history保留逐条sender，不能把对话历史全部冒名owner。

服务端同conversation持久接受锁分配arrivalSeq；202回 `{messageId,runId?,seq,queuePosition,queueRevision}`，重复requestId同sender回原结果，不能排两次。一个共有conversation最多一个currentRun，其余 `queued`严格按server到达序FIFO；不同conversation可并行。页面显示“排在第N”，位置由服务端计算并推 `queue.changed`，切换客户端/重连按持久队列恢复。入队时验成员、登录、visibility、rw；出队再验当前权限/credential，失权取消该条而非借owner启动；拒绝后原文保留历史并有明确状态，无新的run授权。切私有作废所有其它账号queued消息，不迁移到别的对话；owner queued仍按FIFO。

| 能力 | shared | private | 其它限制 |
|---|---|---|---|
| list/get/history/events/visuals/diagnostic/attachments读取 | 同项目当前有效成员 | owner；creator只读例外 | 被踢/旧登录失效均拒；项目scope不能绕过；鉴权逐接口 |
| send/reply/upload attachment | 当前有效rw成员 | 当前有效rw owner | creator在别人的private也不能发送；只读发消息即拒 |
| change visibility | owner | owner | creator没有替别人切换特权 |
| abort run | 该轮initiator，或项目creator | 同左，creator仍能停止 | 通过runId，不是笼统对话主人停全部 |
| rename/remove | rename 保留旧方案；remove 权限待确认 | 同左 | 删除 UI 延期被补充第 5.1 节取代，0.7.18 必要入口；50 满额阻新建、不自动删，删除权限/确认/共有计数/释放时机待确认。原 owner remove 是修改前方案，非新批准 |
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

### 项目全员选区（0.7.18已定，拟接口）

真实在场模块是 `server/docservice/modules/presence.mjs`，当前 `presence.set/list/update`由服务端`actorOf`写身份、断连接撤项；当前 `src/editor/sync/presence.ts`只有editing/cloud-run等，不是全员selection。拟独立 `server/docservice/modules/selection.mjs`和`src/editor/sync/selectionPresence.ts`，不把用户自报username当身份。页面以已认证项目连接发 `selection.set {projectId,pageId,revision,selection:{clipIds,range?},requestId}`，服务端覆盖accountId/accountName/loginId/connectionId/serverReceivedAt；clear及disconnect/revoke清对应项，空选区保留在线成员 `{selection:empty}`。doc为 `selection.query {projectId,runGrantId,initiatorAccountId}` 返回 `{projectId,presenceRevision,members:[{accountId,username,isInitiator,pages:[{pageId,selection,selectionRevision,live:true}],displayName}],queriedAt}`，多个页面不静默丢弃，按账号归组页内分别列出，发起账号displayName为 `username + '（当前用户）'`。username是账号当前可信名称，消息显示仍保留senderNameAtSend。clipIds按doc当前project版本解析返回每项`{id,trackId,clip}`详情（现有本机`src/mcp/handlers/project.ts getSelection`仅返回第一个，需补齐多选，selectionRevision与projectRev区分；无效已删ID回missing条目不误指其它片段）。返回覆盖该项目**全部当前在线有效成员**，同账号多设备、空选区、项目正在关闭均有测试；private对话不限制成员自己的项目选区读取范围，也不暴露他们私有聊天。

`get_selection {}`云端改走doc query，而非在对话SSE上只找initiator page；`seek/play/pause`仍走实际发起页面反向通道。send时把发起页面当前selection写入消息持久 `selectionSnapshot={projectId,pageId,selection,sentAt,source:'sent-snapshot'}`，服务器加实际发送账号关联；发起账号全部页面离线时，聚合结果额外带该账号这一份 `{live:false,source:'sent-snapshot',displayName:'用户名（当前用户）',note:'发消息时的选区，非实时'}`。若当时没选内容存空快照，不能凭空找其它成员冒名；若发起账号被踢/旧login退出但shared已读run继续，其他有效在线成员仍实时，发起人只用原消息快照且明确非实时。其他离线成员不加入旧快照；撤销立即剔除live数据，不用15秒在场TTL推迟权限。该接口经runGrant/project scope核验，跨project查询拒；上线状态以有效连接为准，网络半开时heartbeat只判连接存活，不能延长已撤销权限。

## 素材全链路隔离与工具欠账

### 素材协议（拟实现）

〔裁，卡点8第1行〕选择**托管端按项目物理store**，不在原全球hash库只补一层工具检查。接口外观保留 `/api/asset/<media|snap|px>/<hash>`、`/<hash>/chunks`、`PUT /<hash>/<n>`、`POST /<hash>/complete`；hash仍内容hash，project从已验票据取。`server/asset-service.ts`目前`storeOf(ns)`在admit之前选全局store，必须改为admit返回可信 `{projectId,accountId,loginId,runGrantId?,service,accessRevision}`后 `storeOf(ns,projectId)`；任何请求必须在stat/chunks/read/write/pull之前判project。托管目录拟 `tenants/<projectId>/assets/{media,snap,px}/`及独立 `staging`、index、tiers、jobs。LAN与未共享本地继续旧本机store，不能把整个本地素材库误隔离成账号库。

| 路径/模块实际入口 | 必须绑定的范围与拒绝条件 |
|---|---|
| `server/asset-service.ts` GET/HEAD/Range/chunks/PUT/complete | 每个请求验当前project/login/run权限；hash在另一project存在也回本项目404，错误不给全局存在性；uploadId/chunk staging按project+ns+hash，不能A分片B收尾 |
| `server/vite-plugin-media.ts` `/@media/<hash>`、PCM、`/api/media/upload/<name>`、adopt、素材引用绑定、originals、upload-queue | 托管组合不得把未鉴权请求next到global mediaMiddleware；本地absolute path/file入口不暴露给托管用户；绑定hash须实际本项目入库或已授权复制，不因全局hash存在加入归属 |
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

2026-10-08在起点用只读模块导入核对：`CLOUD_TOOL_PLAN`的pending恰为**23个**。其中感知/工作流15个、browser七个、measure_audio_js一个；额外web_handoff、collect_login/collect_login_check及可视化收尾也必须接。下表输入名来自 `server/tools/{ai,browser,audio,core,project}.mjs`；输出以本机同工具真实契约为准，不能只回“ok”。所有job返回project/run-bound jobId；查job也验tenant，取消、退出和项目关闭传播到子进程，不能靠模型继续写已有全局jobs Map。

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

### 渲染容量排队与Agent优先（已定，拟接线）

真实 `server/hosted-render/limits.mjs LIMIT_DEFAULTS`暂沿用maxConcurrent2/maxProjects16/memoryMax6G/memoryHigh5G、低内存2GiB和30秒恢复；节点部署由root复核实际资源，不自动升级。`broker.mjs pickProjects`已有waiting项目，`look.mjs`目前背压或maxWaiting满回503 busy、等待不足回busy，必须改。超容量不拒项目/请求“已满”，不让editor因云端满而静默改成本机渲染（已确认的合格本地即时查询帧优先另见首部调度补充）：预渲染任务继续留doc持久任务队列；等待接入项目依权威directory恢复；即时look/audio-js等Agent请求进入拟 `render-requests.mjs`持久队列（requestId/runGrant/project/priority/createdSeq/status），回202 `{requestId,state:'queued',queuePosition}`并可受权`GET /requests/<id>`/取消/事件取得结果。look-client支持此202握手和等待，不能把它作失败触发本机降级。正常容量压力是queued/waiting，真正项目删/关/失权是cancelled/forbidden，坏输入仍400；原“临时资源故障是queued/retrying”仅修改前方案，节点故障/持续无进展应选A失败手动还是B有限重试暂停仍待确认，不能由旧拟接口默选；不以无限长HTTP连接充当持久队列。Agent等待本轮请求时不能先报告“已看完”。

在现有单节点资源看护内优先保证Agent：Agent进程独立slice/OS用户；render工作进程已有低cpuWeight/ioWeight/nice/OOM先终止渲染设置保留，资源压力时暂停新增预渲染认领，把可用渲染名额先交Agent look/audio请求，再做普通发布任务；已执行原子任务可到安全点，〔修改前机制建议，节点故障A/B待确认〕OOM重启未完成任务恢复排队，不丢失队列产物归属。不是本期新增跨服务器调度：项目分配多个服务器只留 `docs/plan/TODO.md`待办；web工具proxy和断网audio worker是节点工具隔离，不是已取消的**浏览器用户卡出口护栏**。正向验2任务+第3排队、16项目+第17等待、重启恢复、内存压力解除继续；反向验无“已满”提示/无云端满后的静默客户端本机降级、不能借队列跨project或失权继续出图。

存储压力同样排队：asset硬上限和507作为**内部数据保护信号**保留，worker停止认领、未完成render任务继续在doc持久等待队列，已有claim经retryable-storage回交为waiting（幂等、不删除任务或误记completed）；upload/转码/px入库部分产物记录同project job归属和可续阶段，释放压力后重试。render-requests保留`blockedReason:'storage-pressure'`和重试次数，用户显示等待渲染/排队，不把内部507翻译成“已满”、不丢任务、不因云端满隐式本机降级。Agent优先仍适用；不能为腾空间删除pinned密码/操作历史或其它项目素材。容量probe新增磁盘/配额507注入→保留队列→恢复入库→一次完成、重启与部分upload恢复，verify任务数与可用产物相等。

## 真实旧文件、本地转换与缺失素材

当前 `src/editor/io/proc.ts` 的 `PROC_VERSION=1`保存project/cards/ai/snapshots/collaboration；`server/recovery/descriptor.mjs` v1关联含roomId/service/where，不是授权。`src/editor/io/procp.ts`实际先unpack、按hash上传本地，`landed`再 `dropPackedPaths`；必须保留这个顺序和成功落地hash信息。`server/recovery/coordinator.mjs`目前 `saved.revoked -> deleted`、`no-project -> deleted`会把本地状态/泛错误当删除，此两支对**hosted**不能直接触发转换。

〔裁，卡点11第1行〕拟新增恢复证明结构 `goneProof={v:1,authorityId,projectId,state:'gone',tombstoneRevision,issuedAt,kid,signature}`，doc权威签发，服务身份与项目号必须精确匹配文件关联；已部署旧节点authority通过已确认托管地址身份映射与新authority核验，不能任意错误节点404。公网status可给准确gone状态但不披露项目内容/成员；一个泛HTTP404、账号网站empty、超时、bad password、credential revoked、banned、local.deleted、连错节点均不可转换。无可确认proof保持原关联和内容，提示认证/权限/暂不可用；不补造云端最后一次保存之后的修改。

转换输入先完整解析和校验可读project，保留原 `.proc/.procp`，产生**新本地project id**，保存来源roomId/authority供提示/追溯，不保存云账号凭据；`setAssociation(null)`且关闭协作，提示一次。保留tracks/clips/params/theme/media hash/path/卡源码/ai和可用snapshots；云端message历史不能用本地file旧快照冒名在线新对话。保存成功的新文件不含活跃hosted collaboration；重开不再试旧项目。失败保留原文件和内存内容，不用空project落盘，另存成功后才更新save target。损坏矩阵覆盖JSON截断、zip截断/CRC、空包、无project、旧裸Project、未知proc/association版本、坏roomId、部分缺卡/素材、落盘中断；未知可读版本不能静默升级丢字段，保留可读原文并显示unsupported。

素材恢复优先级：`.procp`实际成功landed的hash -> 本机已有合法hash -> 原guarded本地path -> 明确旧云端素材缺失。包内有素材不因云端项目gone或旧path坏误占位；hash不符/ZIP损坏单独报错，不伪称可恢复。临时下载失败、无权限、不可解码与真正not-found分列状态；只确认missing才替代显示/声音。原media对象和引用留存，不将临时文字卡替换后删除source信息。

〔裁，卡点12第1行〕占位用独立可序列化 `missingMaterial={v:1,mediaId,original:{hash,name,url,path?,kind},reason:'confirmed-missing',visual:true/false,audio:true/false}`状态（放项目恢复元数据或稳定media字段），渲染层建立等时长缺素材代理；不改原clip start/end/offset/速度/轨道/volume/mute/fades。视觉在原片段矩形显示默认文字卡“找不到素材xxx”，不让相邻片段挪位。音频用软件内 `src/audio/assets/missing-material.wav`（1.37秒，48kHz mono，SHA256见account-binding-contract）从**片段开始**播放一次，短片段裁切，长片段余下静音，不循环不断喊；保留原mute/音量/淡入淡出和时间轴duration。原视频画面与音轨均缺失，则同一片段同时文字代理+这段人声，不额外创建重叠声音剪辑。音轨已分离或源视频静音只在实际缺且可听的那条音轨响；图像无音轨不强加人声。原素材重新找到、验证hash后清missing状态恢复原引用/params。

代理人声不是项目素材、不上传asset、不打入procp；desktop/online/render节点构建各带同一文件，在软件相应public/静态资源受控路径使用，不能使用本机绝对文件路径。previewAudio、renderMix、导出、发布后的另一设备均能播放，尽可能共用missing代理source adapter（拟`src/editor/io/missingMaterials.ts`、`src/audio/missingMaterial.ts`），renderer worker可获取软件builtin资源而不能将builtin读口变成任意节点读盘。确认missing弹窗列逐项恢复状态；保存重开保持代理且原引用可找回。

旧数据实际验收由根执行：先一致备份doc/auth/hosting/tombstone历史、assets/jobs、账号SQLite及配置版本；隔离恢复副本实际启动读取恢复项目和素材，对实际旧 `.proc/.procp`保存文件hash和恢复内容摘要、真实媒体完整/部分/全缺矩阵；随后列精确projectId/目录/refs/保留对象删除清单，完成删除后由doc读准确goneProof。再从真实旧文件双击/菜单打开，验证内容、默认协作关、占位文字、人声试听和有声导出、保存重开仍本地、procp本地素材不占位。保留备份；转换/恢复失败停后续清理，不能用合成fixture替代真实旧文件这关。

## 可独立派发的实施包与文件所有权

包号表示独立可验收的小阶段，不是新增文档编号简称。所有新增路径均拟新增；实施前由根从最新绿色集成头建 `.worktrees/<包名>` 和 `codex/<包名>`，相同后缀用于两个仓库，各仓库各自worktree/branch。根只协调、维护进度、审查main/release、推送、构建部署；Sol承担常规实现和接线，Luna做明确单模块/测试/资料整理，Astra只攻时序难题。子任务先报告独立提交，不合并推送，不装依赖/junction；依赖在仓库上层解析。下表端口是**预留**，根派出前检查占用；每个十个一段，dev server本段首端口及+1/+2一起保留，不挪用户端口。5690～5699仅根验收、5720～5729既有Agent、5730～5739设计任务（本任务未启动服务）。

| 包/分支与worktree后缀 | 模型/依赖/端口段 | 独占文件（PC=PromptCut，VH=VisuHive） | API先行交付与独立验收 |
|---|---|---|---|
| `018-account-foundation` | Sol；方案后；5740～5749 | VH `account/{app,store,server,passwords}.mjs`；拟`account/{credentials,events,internal,clock,backup,consents}.mjs`；`account/test/account-v2-*.test.mjs`；PC拟`server/account/protocol.mjs`（仅跨仓库JSON定义） | 先schema v2/public/internal API fixture，后网站/desktop登录、recover、consent和事件事务；现有VH tests+新增原子失败/重复/选否/旧refresh撤销；witness存储提供单事务append接口给Astra模块，网站暂不合site |
| `018-doc-authority` | Sol；account API稳定；5750～5759 | PC拟`server/account/{client,authority,ledger}.mjs`、`server/docservice/modules/account-projects.mjs`、`server/test/account-projects-*.test.mjs`；不写中央接线 | account verify/events消费者、project v2 CRUD/tombstone/list幂等；A/B账号创建/名单/bans/authority不符/gone正反，restart消费乱序/缺口；提供`mountAccountProjects/authorizePrincipal/applyRevocation/listProjects` |
| `018-password-order` | Astra；account witness存储接口+doc提交接口；5760～5769 | PC拟`server/account/clock.mjs`（仅诊断）、`server/account/password-order.mjs`、`server/docservice/modules/operation-history.mjs`、`server/test/password-order-*.test.mjs`；VH拟`account/{password-order,order-witnesses}.mjs`和专用test，不改app/store（回接口交foundation接线） | reserve/seal/accepted/fence故障证明、UTC可信时间、完整before/after历史；每个fsync/ACK crash、密码夹在reserve/seal、旧登录撤销后replay、多连接/新登录/选否、顺序缺口；接口`prepareOperation/resolveWitness/recordAcceptedOperation/recordChanges`，0.7.18只记录。独立难题不阻塞guard/asset/tools先做 |
| `018-cloud-glue` | **一个Sol独占**；上述接口先；5770～5779 | PC `server/docservice/{shared-service,service,service-gate}.mjs`、`server/docservice/modules/{shared,hosted,actor,project,content}.mjs`、`server/auth/{store,handshake,tickets,delegation,asset-tickets,protocol,http,route}.mjs`、`server/hosted/{combo,main,files}.mjs`；专用`server/test/account-glue-*.test.mjs` | 中央连接/normalizePrincipal/gate/资产工厂/operation ledger挂载；只此包改中央文件，其它包提交模块接口；LAN v1全回归，cloud旧证明拒绝，creator Agent admin拒，credential resume拒、每次op署名、搬入/迁出原子失败/幂等。每次接完整一接口阶段绿色后可main，不能带半接权限 |
| `018-asset-isolation` | Sol；doc授权接口，可与Agent并行；5780～5789 | PC `server/asset-service.ts`、`server/asset-store/{index,fs-store,service-usage,px-evict}.mjs`、`server/media-{tiers,pull,stamp,ingest}.mjs`、`server/{upload-queue,frame-stream,queue-local-media}.mjs`、`server/vite-plugin-media.ts`；拟asset ownership模块/tests/probe | `createProjectAssetStores/authorizeAsset/openProjectStream`先交；同hash A/B全GET/HEAD/Range/chunks/complete/upload/bind/PCM/tier/thumb/stream都互拒，worker和queue产物错project拒；撤销持续stream关闭；暴露本地store兼容，不改combo接线 |
| `018-agent-access` | Sol；doc接口+password-order，asset可同时做；5790～5799 | PC `server/agent/service/{create-agent-service,conversations,workspace,usage}.mjs`、`server/agent-service/{http,hosted-wiring}.mjs`；拟`server/agent/service/{conversation-policy,run-ledger,fifo}.mjs`及`server/test/agent-access-*.test.mjs` | ACL/FIFO/read/runGrant接口先；失权SSE/history/visual/diagnostic/附件；owner/creator只读/其他成员全组合；共转私即时fence与队列作废；read/exit/kick/delete/off/on竞态重启；不改工具核心instance/hosted-tools，接口给工具接线包 |
| `018-account-client` | Sol；cloud glue；5800～5809 | PC拟`src/account/`与专用tests；`src/StartPage.tsx`、`src/editor/sync/{sharedApi,collab,collabSecrets,link}.ts`、`src/editor/sync/{SharedDialogs,JoinForm,MembersPanel,CollabSection}.tsx`；`src/editor/ProjectSettingsDialog.tsx`、`src/online/boot.ts`、`server/recovery/{vault,http}.mjs` | `getAccountAccess` adapter先；desktop一次密码+恢复、online共用session、未登录创建拒、云端新建加入迁入与账号踢全设备；LAN界面不账号化；入云quota口数量不限。只此包挂src/account；不提前改0.7.19闸门 |
| `018-agent-ui` | Sol；agent access API；5810～5819 | PC `src/ai/cloud/{cloudApi,session,events,types,useCloud,identity,pageRequests}.ts`、`src/editor/right/ToolVisual.tsx`、`src/editor/right/{CloudAiPanel,AiPanel,OnlineAgentPage}.tsx`；专用UI/probe | sender/owner区分、首次托管告知/同意与拒绝不发、selectionSnapshot、共有/私有开关、只读creator、run stop/FIFO位置、即时隐藏、页面安全恢复；配合visual服务provider，按ACL下载blob；截图+多人浏览器SSE反向probe，private不得遗留在DOM |
| `018-perception-tools` | Sol；asset+run context接口；5820～5829 | PC拟`server/agent/service/{hosted-perception,job-store,hosted-workflow}.mjs`、`server/agent/service/perception/`，`server/perception-source.mjs`、`server/vite-plugin-{stt,shots,track,subject}.ts`、`python/promptcut_{stt,shots,track,subject}/`按必要改动；专用tests/probe | 15工具真实schema与输出，persist jobs；desk插件抽薄壳后本地不退步；CPU短素材实际结果、缺依赖明确失败、crossproject/path/任意安装拒、退出取消、workflow确实做片；部署依赖清单交ops，设计Agent不装 |
| `018-web-tools` | Sol；egress/asset/run接口；5830～5839 | PC拟`server/agent/service/{hosted-browser,hosted-handoff}.mjs`、拟`server/web/hosted/`；`server/agent/service/egress.mjs`必要扩展；独占web tests/probe | 7 browser+handoff实现，不改本机global `server/web/browser.mjs`；服务browser隔离context/OS进程与proxy；DNS/redirect/file/WebRTC/内网/系统路径/错profile拒；在线本人handoff、不在线offline；独立受控fixture站 |
| `018-tool-render-visual` | Sol；asset+Agent ACL接口；5840～5849 | PC `server/agent-service/look-client.mjs`；拟`server/hosted-render/audio-js.mjs`、`server/agent/service/{hosted-audio-js,hosted-visuals}.mjs`；`server/vision/routes.ts`、`server/ai-visual.mjs`、`server/audio-measure-js.mjs`、`server/audio-sandbox.mjs`、`server/vite-plugin-audio.ts`；专用audio-js/visual tests/probe | measure-js签名handler先交render-capacity挂载（不改look）；客户端支持queued202；PCM断网worker数值/超时/泄露拒；get_gif/see_frames/前后视觉/镜头拼图；private bytes不可asset hash绕过；UI交agent-ui |
| `018-collect-bridge` | Sol；asset、Agent page binding；5850～5859 | PC `server/agent/service/hosted-collect.mjs`；拟`server/agent/service/collect-bridge.mjs`、`src/ai/cloud/collectBridge.ts`；`server/vite-plugin-collect.ts`、`src/ai/{collectLoginStore,mcpExecutor}.ts`；专用tests/probe | 匿名默认、本机登录代下、直接project asset入库、签入库ref；cookie/password绝不上报；不在线/失败匿名回退；换private/撤销/重复迟到page result拒；Linux真实yt-dlp及小尺寸欠项 |
| `018-tools-glue` | **一个Sol独占**；perception/web/render/collect provider完成；5860～5869 | PC `server/agent/service/{instance,hosted-tools,cloud-tools}.mjs`、`server/agent-service/main.mjs`、`src/ai/cloud/pageRequests.ts`（agent-ui移交后串行）、`server/agent/ssr-host.mjs`如需；专用tool-plan tests | provider以`createXTools({context,assets,workspace,jobs,runAccess}) -> {handles,call,close}`交付；只此包挂所有工具、更新23项mode与提示词，spawn固定关闭；完整工具表不能有未归类，新工具schema对账；示例句真实短片/离线Agent+补渲验 |
| `018-file-recovery` | Sol；doc status+asset接口；5870～5879 | PC `server/recovery/{coordinator,descriptor}.mjs`、`src/editor/sync/recoveryAssociation.ts`、`src/editor/sync/RecoveryActions.tsx`、`src/editor/io/{proc,procp,mediaUrls}.ts`；拟`src/editor/io/{missingMaterials,cloudGone}.ts`、`src/audio/missingMaterial.ts`；`src/audio/{previewAudio,renderMix}.ts`、`src/export/onlineExport.ts`；专用file/missing probes | proof gate/新local id/保存重开/原输入保留；真实包landed优先；人声clip裁切静音、不挪时序；desktop/online/导出证据；保留builtin WAV哈希。渲染missing接线独占 `src/render/FrameScene.tsx`、`src/render/cards/mediaSource.ts`、`server/bakery/frame-media.mjs`，不与ops/visual重叠 |
| `018-site-last` | Sol；后端已装且cloud/client验过才合VH main；5880～5889 | VH `site/{account,login,register,reset}.html`、`site/assets/{account.js,site.css}`、`site/index.html`；专用site probe；不改account后端 | remember状态、两列表、改密成功后选择/退出中/完成/失败恢复；后端503不可空列表；sameorigin/CSRF/CSP/不同cookie profile实探。**LAST**：先branch验，不提前push main自动上线 |
| `018-ops-contract-tests` | Luna做确定的清单/测试骨架与参数，Sol审运行机制；可早并行；5890～5899 | PC `scripts/remote/docservice.mjs`、`server/{hosted-render,agent-service}/deploy.mjs`、`server/hosted/deploy/`、`scripts/acceptance/`新增覆盖项、`scripts/probes/account-*`；VH拟`account/test/backup-restore.test.mjs`（本包独占，foundation不写此测试）、`deploy/`、`docs/accounts.md`、`user_readme.md`、`README.md`；PC语义契约由root现行Luna独占同步、Sol审后串行接入 | backup/restore scripts和版本元组，internal身份/端口/健康检查/自动backup；测试骨架不等于业务完成；first部署dry-run实际缺文件检查、network条目必须真执行。删除旧数据和cipher操作只根 |
| `018-card-guard-reversal` | **独立Sol小包**；无需账号难题前置，可立即；5900～5909 | PC `src/online/isolation/{execGate,harden,isolationCheck,stageGuard}.ts`、`src/online/isolation/isolation.test.mjs`、`src/online/cardRuntime/{gate,stageRuntime}.ts`、`src/online/{stagePolicy.mjs,stagePolicy.test.mjs}`；`server/hosted/stage-policy-nginx.mjs`、`scripts/gen-stage-policy-nginx.mjs`、nginx editor-policy/stage-headers两snippet与stages site模板（ops排除上述两snippet与stages模板）；`server/hosted-render/vite-gate.mjs`、`server/test/{hosted-render-usercards,hosted-render-isolation}.test.mjs`、`scripts/probes/hosted-render-isolation-probe.mjs`、`src/cards/native/particles.tsx`、`src/cards/externalResources.test.mjs` | 删除浏览器与云render worker Connection-Allowlist/fallback、脚本出口拦截/仅本机出口proxy强制args和外链限制；保留分源/握手/editor防护/project asset、页面API闸/管理口认证/OS worker；fixture外链image/font/style/script正常，四浏览器及Linux云worker均执行，NASA背景同桌面；精准particles参数分支逐帧和相关fixture由本包独占。root事后审UI截图，不新打徽标 |
| `018-render-capacity` | Sol；可与账号/asset并行，最终接doc run接口；5910～5919 | PC `server/hosted-render/{main,broker,limits,isolation,look}.mjs`；拟`server/hosted-render/{render-requests,agent-priority}.mjs`及专用tests/probe；不改visual provider/look-client | `enqueueRenderRequest/getRequest/cancelRequestsForGrant`及202接口先交；2+1并发/16+1项目/内存背压及storage507排队、恢复重试无满或本机降级，Agent优先，重启/ACK丢失/去重/失权取消；此包独占look接audio provider路由，ops部署参数只由其审接口 |
| `018-project-selections` | Sol；doc principal接口，可先fixture并行；5920～5929 | PC拟`server/docservice/modules/selection.mjs`、`src/editor/sync/selectionPresence.ts`；`server/tools/project.mjs`（只get_selection描述/schema兼容）、`src/mcp/handlers/project.ts`（只getSelection多选详情），`src/editor/sync/presence.ts`与专用tests/probe | `mountSelection/querySelections`交cloud-glue挂载，tools-glue接get_selection；AgentUI send写selectionSnapshot由UI owner接。不改中央或pageRequests；全员/多设备/空选区/用户名/当前用户/离线非实时/跨project/失权立即清正反验 |

所有现存路径扩展名已按rg核定，拟新增路径按表派出；根不需要再补模糊的TS/TSX清单。目前已定位聊天视觉入口 `src/editor/right/ToolVisual.tsx`，不得写不存在的 `src/ai/ToolVisual.tsx`。visual后端实际入口已核到 `server/vision/routes.ts`、`server/ai-visual.mjs`；measure-js复用 `server/audio-measure-js.mjs`、`server/audio-sandbox.mjs` 与 `server/vite-plugin-audio.ts`，不能虚构不存在的visual插件。单测文件前缀各包独占，旧公共test如需调整交中央或当前owner，不能两包同时改。接口提供者不改消费者核心，消费者拒绝先写临时自由放行。现行三契约/部署清单、product/agent、mechanism/platforms与rulings由root已派Luna独占精准同步，实施包只提供接口差异回交，不同时改这些文档。guard-reversal实际工作区已由root从461206a3建立，表的统一“根建立”不意味着重复建立它。

guard包不能只删在线execGate：真实Linux云worker `vite-gate.mjs`有出口proxy仅转本机、Connection-Allowlist响应头与强制proxy/UDP args，必须沿 `installPageGate/egressChromeArgs`调用链删卡片出口限制，保留page-gate/vite-gate管理/API白名单和worker身份隔离；fixture从“外部请求全拒”改为“外链照常、管理/账号/project资源越权仍拒”。在线原生particles的 `onlineSafeBackground`与externalResources测试有禁NASA外链分支，按P3撤销并验真实背景。纯卡片参数分支逐帧对比按verification做，不把不含particles的演示帧当充分验证。Agent web/collect下载自身SSRF保护属于另外工具，guard不能改其egress.mjs或凭据桥；audio-js断网sandbox同样保留。

依赖图：account基础 → doc权威与password-order → cloud glue → account client/asset/Agent access；asset+run context → 感知/web/visual/collect（互不依赖者并行）→ tools glue；Agent access → Agent UI；doc status+asset →旧文件；全部本地功能通过 → site branch完整验证 → 根部署后端与PC组合 → site LAST。ops骨架/契约映射可早并行，但部署参数要收所有provider交付。前三槽可同期开三个无文件交叠包，根不承担多数实现。

可立即开工的顺序不是等待Astra解完全部：第一个并行窗口 `card-guard-reversal + account-foundation + ops骨架`；其后空槽做`render-capacity`、doc-authority和project-selections。asset/perception/web/visual/collect可先按确定的account principal/run context fixture实现独立模块，服务挂载/完整main闸门仍等doc接受与授权接口；未完成认证接线前不能对外放行。这19个包分别有工作区和独占文件，root按上表租段派出，不再把常规实现留给root。`selection.mjs`由cloud-glue唯一挂载，get_selection tool由tools-glue唯一挂载，UI snapshot由agent-ui接；三方接口先行而不共同改核心文件。

每个包把功能拆成可讲清的一两点提交/小阶段：接口+fail-closed skeleton先验、正向实现再验、故障/权限收口再验；完整块绿色才由根 `--no-ff`合集成，根复验适用基线后小阶段main并push、进度随合并更新。不是先合空架子宣称功能完成，也不等整个0.7.18全部结束才main。`018-cloud-glue`和`018-tools-glue`中央文件期间不借给其它包，review修补仍回该owner。

0.7.19依赖但不提前扩0.7.18：另派Sol `019-platform-gates`锁 `src/online/{lowMemory,stageWatch,device,l2,l2Costs,browserNode}.ts`和`src/online/stagePolicy.mjs`（guard-reversal移交后）及相应render闸门；依既定顶配/标准/精简/低配的名字、文案、位置，不再标待决；另派Sol `019-save-offline`锁proc/sync/project history快照与离线三方逐项窗口（018-file-recovery移交后）；Luna做覆盖清单/真机核对表；Astra只在崩溃与重连竞态确有难题时派。0.7.20另派Sol `020-selective-compensation`消费018 history/password ledger，Sol `020-join-requests`消费account project v2，Luna写冲突矩阵；history中央修改回cloud-glue owner审后串行接入。新版本端口重新租段，每段十个，不复用正在跑的上版服务。三版本所有终点均保留。

四档气泡逐字为“这台设备运行在顶配模式”“这台设备运行在标准模式”“这台设备运行在精简模式：复杂的效果交给云端渲染”“这台设备运行在低配模式：播放时只显示已渲染好的画面”；所有档都在预览窗口上方提示，几秒后自动消失，不能另起更名文案。P2纯浏览器超过图卡体积上限不认领仍保留，和P1所有浏览器画面执行是两件不同能力。取消出口限制和以后跨服务器调度只同步最新TODO，不塞回三版本。

### 后续调度实施包与验收增量

本次不改现有 owner/文件租约或代码。后续由协调者补 0.7.18 本地即时查询帧资格/云端单活跃调度、Agent 50 对话限制与删除入口；0.7.19 项目及总体内存实验；0.7.20 磁盘缓存与轮换实验。与当前容量包/Agent UI/存储包存在接口依赖，需先约接口，不能各写一套调度或对话计数。

新增验收用 [任务书](account-binding-task.md) RS18-local、RS18-queue、RS18-chat、RS19-memory、RS20-rotation、RS-common 的输入/断言；旧 render capacity 和单一路 look 测试不足新目标。目标/规划/实现/测试/通过分开，留最终 SHA、配置和原始失败；本次状态明确为目标已确认、已规划、未由本次实现、未测试、未通过。

## 验收输入、正反探针与集成闸门

| 场景组/所属包 | 可重复输入 | 必须断言与反向输入 |
|---|---|---|
| 身份与限速/account-foundation+cloud-glue | 三账号A creator/B member/C outsider；各2editor+2website登录 | desktop一次输密跨重启、cookie remember/不remember、同账号新设备creator恢复；同机无证书internal拒/伪造IP不能逃name/IP limits；LAN无账号仍可创建/加入 |
| 权威/create/join/list | 相同requestId重复create/join、join失败中断、restricted/banned | 只有一个active项目/creator、owned/joined权威一致；doc停 ->503明确不可用；非creator/Agent管理员拒；C知道invite仍不越名单 |
| 改密/reset/choice | 密码先成功，再是/否；reset同逻辑；退出事件push丢失/重复/乱序 | 否所有旧登录继续写、新密码可登录；是保留发起website，撤其它website+全部旧editor，new login不撤；在每个事务/ACK切点重启，退出中直到全部入口ACK；0.7.18修改保留 |
| password-order/历史 | 旧登录在reserve前/reserve与seal间/密码后/撤销前写；其它账号/new login交织；多连接不同断点 | 精确changeSeq/endOrderSeq与各project endCursor，before/after可重建；UTC前后跳不误选；doc离线密码照常成功，reserved不冒充accepted，未seal操作不穿private/stop fence；0.7.20逆序逐item补偿、不碰后来合法项 |
| Agent ACL/FIFO/read | A建shared，B/C同时发，A/B各多页面；read前/后kick/exit | 一currentRun、FIFO arrivalSeq和队列位置；private creator只读、只有owner可切；切私有立刻other initiator停+queued作废+SSE不再有字节；共享已读run继续但旧账号各读/发/next全部拒；项目关/删压过例外 |
| consent/Agent UI | 同账号两个设备首次使用；拒绝再用；接受后改密/退出重登；直调send | 精确文案/两按钮，拒绝消息数/队列数/model调用数均0，下一次重弹，接受跨设备与重启保持；伪造客户端accepted/别账号consent拒，private仍显示托管方可读事实 |
| all-member selection | A/B各两页面、C空选区；发起B离线/踢出，read-confirmed shared run保留 | 全部有效在线成员用户名和各页选区；B名字带“（当前用户）”，离线B仅发送快照且非实时；C空仍有条目，删clip明确missing，撤销立即移除live，另一project无数据 |
| card外链/分源 | 同一用户卡/图卡加载受控图片、字体、CSS、JS，四浏览器含不支持allowlist | 全部画面执行/资源正常；不得恢复外发拦截，不以无allowlist降档；分源editor DOM/cookie摸取失败，账号CSRF拒、跨项目素材拒；截图交root事后审 |
| render capacity | 保留旧2+1任务/16+1连接压力输入，追加均含自定义卡的多项目、合格本地/失格/离线/迟到、Agent look争用、manager重启 | 0.7.18 云端单活跃项目，超额queued并恢复，无已满提示或云端满后的静默本机回退；本地优先必须完整授权/能力/可用性核验；对应任务书 RS18-local/queue，新增未跑。原初值不能代替新约束；保留原requestId幂等、普通任务之后继续及改private/off/delete取消失权产物、不借队列继续写断言 |
| 同hash素材/worker | A上传hash H，B知道H；另测B合法独立上传H | 各接口A权限读成功/B未入库读404；chunks/complete/thumbnail/PCM/stream/tier/key/worker/manifest都不漏；B自己上传正常；delete A不影响B；撤旧流、Private visual不能靠asset hash读 |
| 工具与隔离 | 短speech/两镜头/移动点/人物fixture，受控网站，PCM正弦；真实模型示例句 | 不只status，实际result写doc且run/op相连；同project不同conversation browser隔离，系统/其它project/path/内网/redirect拒，安装参数白名单；spawn精确中文固定回复，代下载不上凭据 |
| gone/missing/真实旧文件 | 真实旧proc/procp（包内全部/部分/无素材）、可信准确gone、错误authority/404/401/503 | 只有gone转换；内容/原引用/clip时序保留，local协作关，procp已landed不占位；截图文字、人声试听/导出、重开持久；截断/未知版本保留输入，不空覆盖 |

子分支每个实现完整块执行 `npx tsc -b --force`、`npm test`（VH自己的npm test），新增probe只跑该包场景；渲染/画面变动按verification加适用渲染附加项，声音-only做覆盖范围probe及desktop/online有声导出。所有Windows子进程 `windowsHide:true`，PowerShell后台 `-WindowStyle Hidden`；静默预载绝对URL，独立artifact目录；Python设 `PYTHONDONTWRITEBYTECODE=1`，若用本机现有Python路径由根已确认环境提供，不打印秘密/不改全局环境。

根集成每次main小阶段基线零错误/零失败，按改动范围验画面；每版最终集成完整四阶段运行器与新账号/素材/Agent/恢复覆盖清单，`--check-coverage`确认所有约束有行；**默认集合通过不等于可选/网络120项都执行**。有声/隔离/首视频/关软件继续/actual tools这些点名项单列真实结果。渲染已有主会话17项基线1800/1800 main与候选逐字节相同只是起点证据，不能替代新渲染改动最终验。每项记录命令、最终SHA、通过/失败/未跑/不适用（依据）、输出目录、截图、机器配置与耗时；耗时只记录，功能/隔离/像素断言继续为闸门。

## 两仓库部署、备份、恢复与可撤销回退

以下为根后续操作步骤，本设计任务没有操作节点。根2026-10-08只读核对：doc组合代码 `/opt/promptcut-hosted/app`，数据 `/var/lib/promptcut/hosted`（0700），doc8787/asset8788 healthz HTTP200；account `/opt/visuhive-account`，SQLite `/var/lib/visuhive-account/accounts.db`（父目录0700），account8790 `/api/account/me` HTTP200、专用用户service active；`/opt/promptcut-render`、`/opt/promptcut-agent`未建立。使用现有真实路径，新增render/Agent路径由deploy dry-run审查后建立，不凭旧计划假设已经存在。

〔裁，卡点13第1行〕Agent部署明确 `PROMPTCUT_AGENT_PORT=8791`，nginx `AGENT_PORT`一致；不能照 `main.mjs/deploy.mjs`缺省8790撞account。doc/asset保持8787/8788，render status/look/broker用 `server/hosted-render/main.mjs`的`renderServiceConfig`：缺省5399；普通worker5400～5402，隔离worker5410～5412，仍须节点监听盘点填写清单，任何重复配置预检即拒。内部mTLS listener另留节点局部端口表，仅loopback但有证书与OS隔离；不能借改宿主防火墙/DNS/代理模拟故障。

版本元组（拟持久部署manifest）`{releaseId,appVersion,pcSha,vhBackendSha,vhSiteSha,docSchema:2,accountSchema:2,assetLayout:2,agentStore:2,clockProtocol:1,docCode,assetCode,renderCode,agentCode,onlineCode,nginxPolicyHash,serviceRegistryRevision,revocationHighWater,createdAt}`。PC doc/asset/render/Agent/online同一pcSha，账号/site明确同一接口兼容范围； `/healthz`/status与构建buildInfo可查无秘密版本。服务拒不支持schema/协议，不把“不一致警告但照常放行”当完整验收；site在后端能力未到时显示不可用，不暴露新入口半成功。

1. **预部署准备与一致备份。** 根记录相关client/Agent/upload/render/jobs状态，三版可打断当时旧测试项目，仍准确限定无外部用户前提；对新现场真实用户冲突报告并不套例外。account用Node SQLite在线backup API或SQLite backup机制生成一致accounts.db副本，不能cp正在写的db/WAL假装一致；记录backup开始/完成、`PRAGMA integrity_check`、schema、accounts数量和撤销head。PC停止/暂停本次范围写入后做doc/auth/project/history/hosting/tombstone/asset/staging/jobs/服务注册表一致checkpoint备份；配置/代码/nginx/online/PM2单独清单/权限/校验。秘密仅记录范围与校验结论，不打印内容。
2. **真正恢复测试。** 备份恢复到隔离目录/独立端口，account能读取测试账号、登录与撤销记录，doc可打开准确projectRev、读取素材bytes、历史run/read/ops；完整数据库恢复不只integrity_check。验证已撤token仍拒、账号新写/撤销不能在恢复时丢；恢复副本不联系生产外部系统。未证明恢复不得清理或切不可逆数据库结构。
3. **自动账号备份。** 拟VH `account/backup.mjs` + `deploy/visuhive-account-backup.{service,timer}`，至少每日一致backup，变更/发版前额外一份；0700归备份账号/root管理、0600产物、先新备份成功再按可配置保留策略淘汰普通自动历史，**此次已验证迁移备份不在自动删除范围**。每月隔离恢复检查（本次先实跑一次），失败日志含代码/范围不含账号密码/token。新增费用不需要。备份schema/head和服务元组一并记录。
4. **账号后端先。** VH基础/内部/事件/backup接口分支测试绿色合main（不带新site），手装 `/opt/visuhive-account`、数据库迁移事务与恢复guard；保留旧程序并验证兼容schema；核special用户、mTLS路由、真实IP/CSRF、自动backup timer。本阶段公网新site还没发布。
5. **PC组合、nginx、在线、render/Agent。** 先审两仓库所有配置差异和 `scripts/remote/docservice.mjs`现有命令dry-run，确保stage-hosted携带拟新增account/ledger/policy模块。部署依赖与项目scope素材目录，render/Agent服务密钥只节点生成，PM2自启/独立OS用户/隔离worker限制核实；`nginx -t`再reload，stage策略与 `visuhive.com/editor`及旧sslip.io入口同时验证；新online只在兼容doc/asset可用后放出。停单服务失败路径或退在线上一兼容版，其它通过的保留，记录元组不能误宣全组合通过。
6. **模型cipher导入。** 指定 `/root/promptcut-pending/agent-model-key.blob` 已由根只读确认存在、0600、289bytes；设计子任务未读取值。根部署Agent后照 `server/agent-service/import-key.mjs`实际CLI，用 `--file`指向它导入；在节点核末四位与两模型真实调用，通过后删除这个cipher。记录仅结果与文件是否清除，末四位/模型不敏感现场信息按既定local边界存 `docs/local.md`，不打印值到方案/报告/消息；无需再向用户索取Key。失败留cipher并停对应调用路径，不盲删。
7. **site LAST与公网验证。** 后端/PC组合真实新接口验证后才合推 `018-site-last` 到VH main（五分钟自动更新含删除），确认实际site SHA与backend manifest；真网络执行原16项+账号点名：HTTPS/证书/同域host-only cookie、双stage握手、account/列表/新建/加入/跨设备creator、account bans、旧票据与内部接口拒、私有即撤、退出和重连、实际工具、结束发起方软件后继续+补渲。只用测试账号/项目，验完按精确范围清理。
8. **旧测试项目清理与真实旧文件。** 0.7.18根准确盘点当前项目ID/source/目录/资产归属/持久任务/明确保留对象；不用历史“4个”当清单。备份与恢复证明先成立，再删除授权清单，权威tombstone保留；按上节真实旧文件验收内容/素材/local保存重开。三版临时可打断规则在0.7.20节点切换办结删除，不继承未来版本。

回退必须以**兼容元组**操作，不能单退旧backend配新schema。〔裁，卡点14第1行〕revocation ledger、password events/acks和账号新写数据独立保留为单调高水位；回退程序必须能加载schema2并应用撤销head，不能用发布前db覆盖当前db使旧token复活。若只有不懂v2的0.7.17旧后端可退，安全回退是关闭云账号/Agent相关入口并保留数据、使用可读v2的兼容修复版；不能回到旧云端自报身份放行。恢复备份后先重放备份之后持久account outbox/doc revocation与新账号写入journal，对账head，所有旧refresh/access/票据仍拒，才开放业务。丢失journal则不开放，保留当前数据待修复，不能默许恢复旧权限。

网站回退要合推兼容旧site的修复提交或根在授权范围控制timer+固定SHA，同步记录恢复点，防五分钟后又自动覆盖；不能只手工改 `/var/www/landing`而仓库仍推新网页。nginx恢复只经 `nginx -t`/reload，保留host-only cookie与隔离策略；render/Agent current回退一起核pcSha，credentials revocation ledger不回滚，项目已删不因换代码复活。每版对测试数据实际回退一次，证据不是dry-run替代。

0.7.18、.19、.20每版各走：最终产品交互验收 → 根main版本提交（package与lock一致）→ `npm run build`/在线build → `desktop/`的 `npm run release -- --from-head`完整包和兼容patch（不能只patch-only）→ 独立安装副本验启动/账号/真实文件关联与旧文件转换 → patch在当前声明最低壳0.2.0与现用0.2.7隔离副本验升级/回退；根据证据决定壳/最小壳字段，不盲抬 → release三条件判断并ff-only推进/推送（不能快进按`docs/plan/release-fallback.md`）→ 节点部署与真实网络验收 → 进度/报告及产物路径、大小、SHA256、两仓库版本元组。安装验证不覆盖用户运行副本，patch不在Agent会话使用的真实安装目录执行。源码先提交再构建，旧报告不替最终SHA。

## 最小裁定解法表、未达成与验证状态

表中的“选用”是设计决定，**不是已跑探针通过**；实施包跑右列尺子后填真实结果。本稿三级选择不改变已定交互；原卡点4的doc故障改密前503取舍已撤回，卡点9只落实已定本机交接。所有新增界面先合理实现并交截图事后审。下列测试/探针均拟由对应包新增到指定目录，用 `npm test`执行，product probes通过根验收runner调用，不裸跑node --test。表中g/h为solution_table要求1～5档，f=g+h，选最小可行路线；无一级改动/新增费用/下游完全选不了型项。

| 卡点/行/层 | 选用机制与原因，g+h=f | 替代/未选原因 | 可验证尺子（实施时新增） |
|---|---|---|---|
| 1/1三级 | account project v2与LAN v1分支；避免改本地身份，2+1=3 | 全球改username为account破坏LAN，禁止；云端猜旧映射不可信 | `npm test`的account-projects-v2及auth LAN回归零失败 |
| 2/1三级 | OS用户+mTLS逐服务身份；防同机用户内部核验，3+1=4 | 仅loopback/共享secret无进程钥匙隔离，无法满足尺子；UDS peercred需额外跨平台native模块 | account-internal probe无证书/错误身份/公网/其它UID拒绝计数全部通过 |
| 3/1三级 | remember30日/不remember24小时+cookie寿命同步，1+1=2 | 默认一律永久不符remember；仅session cookie无server上界难恢复 | account-session probe浏览器重开、服务时间前移、token rotation与revoked全部断言通过 |
| 4/1三级 | account统一顺序见证+doc接受事务，doc离线仍改密成功，3+1=4 | 独立顺序服务4+1=5；UTC误差无法消歧关闭；原doc前置503为二级锁住不选 | password-order探针reserved/sealed/accepted/fence所有切点、UTC跳变、夹缝改密、重启后错误区间与穿fence数0 |
| 5/1三级 | pinned完整item历史到事件完成，2+1=3 | 只存hash/摘要1+5=6不能重建；按天淘汰会丢待撤信息 | operation-history probe压缩/重启后before/after/actor完全可重建，0缺项 |
| 6/1三级 | 普通撤销逐项选择覆盖/只撤无冲突/取消，2+1=3 | 一键根回退禁止；改密弹窗违反已定不弹 | undo-items UI probe窗口三动作、窗口期间新修改不误覆盖 |
| 7/1三级 | Agent可信read WAL + doc receipt/runGrant，3+1=4 | client读回执1+5=6可伪造；模型流量无法精确op关联 | agent-read-races probe退出前后/ACK丢失/重启/不可伪造，错误例外0 |
| 8/1三级 | project物理store，2+1=3 | 全球blob+ownership ledger3+2=5本期多改；仅工具检查无机制 | asset-project-isolation probe同hash完整链路、产物/缓存拒绝泄漏0 |
| 9/1三级 | 既定本机代下经run/page-bound桥，不上传登录信息，3+1=4 | 上传cookie禁止；节点有头远程窗仍凭据离机 | collect-bridge/web-handoff probe在线正确本机/离线fallback、上行payload秘密字段0 |
| 10/1三级 | visual读取经conversation ACL，不凭成员asset可读，2+1=3 | private字节公开px URL1+5=6泄露；独立visual服务4+1=5 | private-visual probe已知hash、旧URL/ACL revision、creator readOnly全部正反通过 |
| 11/1三级 | doc签名准确goneProof+tombstone，2+1=3 | local.deleted/HTTP404无权威；网站列表缓存不是证据 | cloud-gone-file probe错误服务/凭证/网络0次转换，正确gone转换一次 |
| 12/1三级 | 占位保持clip时序、人声一次裁切+余静音，2+1=3 | 循环/伸缩人声会不自然，另加音轨易重复；重排片段禁止 | missing-material probe时间轴frame/time完全相等、preview/导出可听、procp landed误占位0 |
| 13/1三级 | Agent8791明确配置并node端口唯一预检，1+1=2 | default8790已被account占，无法启动 | deployment-preflight probe账号/Agent监听不同、nginx正确目标 |
| 14/1三级 | 高水位撤销ledger不回滚，兼容修复/关闭入口，3+1=4 | 旧db直接覆盖1+5=6复活token；禁入口保留数据优于丢新账号 | rollback-revocation probe发布前后撤销、新账号/操作均保留，旧token拒绝100% |

卡点9只裁本机反向通道实现，匿名默认/本机代下已是用户决定，属于三级接法而非新增二级取舍；已定云端匿名默认/电脑代下不上凭据不变，实施时完整web工具与登录回退必须验。最终选择没有新增二级可用性取舍；未选的改密前doc依赖503保留为锁住替代，UI按已定合理截图事后审。所有机制裁定交根进度事后记录，不在本任务修改进度或一级语义。若Astra证明某方案做不下去，照solution_table补候选与实验，再按规则升级；不能把“耗时多”“通知延迟”当放弃机制。

本方案纯文档验证：`git diff --check`；实际模块/工具schema/路由/数据字段检索；23个pending只读导入对账；contract用户决定逐项覆盖与互相矛盾段落矩阵。没有启动服务、没有重复17项基线/全量render、没有读取local秘密/actual cipher/key、没有操作节点/用户数据。产品行为、单测、产品交互验收、实际备份恢复与真实网络验收均是后续包的工作，当前状态**未跑，不能报通过**。

实施包新增可执行产品尺子统一用 `node scripts/probes/<包后缀>-probe.mjs --url <本包绝对URL> --out <独立产物目录>`；文件头必须写输入/断言/失败退出码。具体脚本名为 `account-session-probe.mjs`、`account-internal-probe.mjs`、`password-order-probe.mjs`、`operation-history-probe.mjs`、`undo-items-probe.mjs`、`agent-read-races-probe.mjs`、`asset-project-isolation-probe.mjs`、`cloud-agent-consent-probe.mjs`、`all-member-selection-probe.mjs`、`card-external-resources-probe.mjs`、`render-capacity-probe.mjs`、`collect-bridge-probe.mjs`、`web-handoff-probe.mjs`、`private-visual-probe.mjs`、`cloud-gone-file-probe.mjs`、`missing-material-probe.mjs`、`deployment-preflight-probe.mjs`、`rollback-revocation-probe.mjs`，对应上表尺子；源码provider测试用 `npm test`零失败及对应断言计数，产品probe零失败才算该卡点实现通过。
