# 云端真实发送与持久队列用户路径

## 开工与范围

本任务接通账号项目里用户可见的“真实发送、持久排队、共有对话双方看到发送者与第几”。排队成功不代表 Agent 已读、运行或模型已经调用；未接通生产 runner 时必须明确显示等待执行服务。本任务不处理历史浏览器普通档探针，不选择删除、提前让位、补渲故障等未决产品方案。

工作分支为 `codex/018-cloud-queue-user-path`，起点 `5fe070d62605dc3e5b360d1c4a9c43a948045c61`。开工时工作区干净；实际检查 6520–6539 没有监听。以下接口草案保留开工时的原状态；当前实现和验证见文末“实施与固定证据”。用户常驻端口和其它 Agent 服务不在本任务操作范围。

已读 AGENTS 入口、开发者指南、建议行为、约束、多 Agent、提交规则及 Agent 产品语义；产品源码等待主会话收回首次告知阶段并通知同步后再编辑。本报告先独立提交。

## 真实接口与接线草案

| 接缝 | 当前真实实现 | 本任务所需最小接线 |
|---|---|---|
| 账号项目会话 | `server/docservice/account-hosted.mjs` 的 `issueSession` 已签发 kind-bound 的 `connectionTicket`、`assetTicket`、`agentDelegationTicket` 和 `expiresAt`；解析委托每次重新问账号及项目权威 | `src/account/client.ts` 当前仅保留前两张票据，须严格验证并保留委托票据；使用现有会话续签，不能开放 `auth.ticket` |
| 前端云端身份 | `src/editor/sync/syncManager.ts` 在账号模式注入 null；`src/ai/cloud/identity.ts` 已有可注入的 `getTicket/getGrant` | 仅账号项目绑定当前项目的委托 provider，失联、换项目、退出立即撤绑定；`getGrant` 不走旧 LAN 票据 |
| 创建者与项目开关 | `server/account/authority.mjs` 的 `authorizePrincipal` 返回真实 `creator`；`/hosted/shared/account/admin` 已核真实创建者，支持 `set-hosted-service`；新项目 Agent 默认关闭 | 页面必须依据服务端身份显示开启入口。会话目前未回传 creator/开关，需先确定最窄权威响应补充，不能页面自报 |
| 真实选区 | `src/editor/sync/selectionPresence.ts` 发布认证 pageId；`server/hosted/doc-assembly.mjs` 的 `captureSnapshot` 只接受 `{pageId}`，从真实连接取选区 | 发送 `selectionSnapshot:{pageId}` 引用；不传客户端选区内容，不用云端面板另造的 pageId 冒充 presence |
| 真实发送 | `server/account/conversation-authority.mjs` 持久保存 senderAccountId、senderNameAtSend、arrivalSeq、queueState；send 返回 messageId、runId:null、queuePosition、queueRevision | `cloudApi/session/events` 保留消息身份和队列确认；不造 runId，不因尚无 runId 丢弃 user 消息或生成假的 assistant |
| FIFO 与重载 | 同权威按 arrivalSeq 排队；`publicConversation` 已返回 queueRevision/currentRunId；`get` 返回获权消息，但 publicMessage 没有逐项 position | 位置必须从权威认可的消息快照及 revision 得到，刷新与续接恢复同一消息，不能使用本机任务队列替代 |
| 共有 SSE | `server/agent-service/http.mjs` 的 `accountEvents` 逐次真查询、逐消息核 read；当前只按 arrivalSeq 发新增 user，没有独立队列快照，旧消息状态变更无法到达页面 | 需向主会话申请仅 accountEvents 及对应真实 HTTP target 的窄后端扩租；完整草案见下节，未获租前不编辑 |

〔裁〕接线机制选择：在现有账号会话续签闭包内提供短期委托，沿用已有对话权威与 HTTP/SSE，不再增加身份权威或长期 localStorage 凭据。替代为复制旧 auth.ticket 链会违反账号 v2 的禁用规则；独立永久缓存 principal 会绕过撤销。尺子是旧票据撤销后新请求拒绝、会话续签后仅新委托可用、换项目后旧 provider 不再发请求。

## 需要主会话确认文件租约的队列接口

当前 `publicConversation` 包含 `queueRevision/currentRunId`，`get` 的消息含持久 `queueState/arrivalSeq/messageId`，但 SSE 只查询 after=cursor，因此同一已发消息从 queued 变为 preparing/running/cancelled 时没有更新。需要独立队列事件，不能把 queueRevision 冒充消息 seq。

〔裁〕最小候选为 accountEvents 用真实 conversation get 的完整获权视图追踪队列 revision，在首次订阅和 revision 变化时发独立 `queue.state`，内容为 conversationId、queueRevision、currentRunId 和精确 messageId/queueState/position 行；普通 user 仍按 arrivalSeq 去重，包含真实发送者。位置按该同一权威快照的 queued 行 arrivalSeq 顺序编号。每次事件仍经真实 read 验权；没有 runner 不发 read/run/model 事件。是否将 position 放入 doc public projection，待主会话核最小租约后固定；两种方式均不改变权威 FIFO。

主会话已批准 `server/agent-service/http.mjs` 仅 accountEvents/queue.state 和专属 HTTP/SSE target；`server/agent/service/conversation-policy.mjs` 仅 info 诚实暴露账号模式与执行器未挂载状态。对话权威不修改，位置从 get 的完整获权持久消息视图派生。`server/docservice/shared-service.mjs` 仅 bindService 一处传既有可信 registry/urls，`server/docservice/account-hosted.mjs` 仅 session projection。产品源码仍等首次告知阶段收回后通知同步，目前均未修改。

### 拟固定的命名与响应校验

〔裁〕账号会话响应在 `server/docservice/account-hosted.mjs` 的 `createAccountHostedRuntime().issueSession` 扩充如下，其它三种票据的 kind、到期和解析规则保持原实现：

```ts
interface AccountProjectSession {
  connectionTicket: string; assetTicket: string; agentDelegationTicket: string;
  expiresAt: number;
  projectId: string; creator: boolean; access: 'r' | 'rw'; accessRevision: number;
  hosted: { agent: { available: boolean; enabled: boolean; url: string | null } };
}
```

三张票据均严格为 43 字符 base64url，expiresAt 必须是未来的安全整数；projectId 必须等于请求的项目，creator/access/revision 的形状逐项校验。creator 来自 authority 重新核过的 principal，开关来自同一项目持久记录，available 来自既有服务登记表当前 Agent 条目，url 只来自 constructor 的既有 `hostedServiceUrls.agent` 可信配置。无登记则 available=false，未配地址则 url=null；页面不能据在线默认地址自报服务存在。available 仅说明登记了服务，不代表 runner 已运行。共享服务构造器现有 `accountRuntime.bindService(service)` 传入 registry 与 urls，让 runtime 使用可信 provider，每次会话重新核；不用请求正文设这些字段。该接口只投影账号 Agent 信息，不提前接渲染服务。

〔裁〕客户端新增 `setAgentEnabled(projectId, enabled, expectedAccessRevision, requestId)`，内部真实 POST `/hosted/shared/account/admin`，正文精确为 `{projectId,requestId,expectedAccessRevision,op:'set-hosted-service',service:'agent',enabled}`。凭据由现有 ensureLogin 获取、credentials omit；不得接收 creator/role/principal。真实返回当前是 `{eventId,accessRevision,completed:false,state:'pending-services'}`，不能将开关写入成功说成资源关闭完成。收到后重新取得 session，以服务端投影更新 UI；409 revision 变化时重新读取并显示重试，禁止无条件覆盖新开关。其它 LAN 创建者操作保留旧路径。

〔裁〕排队成功单独类型 `CloudSendAccepted`，账号分支验证 `{messageId,runId:null,seq,queuePosition,queueRevision,conversation}`，seq/revision/position 均安全整数，conversation.id 必须等于请求对话且 projectId 等于当前项目。服务首次 send 自动创建共有对话，前端不增加假的创建 API。重试沿用 requestId，失 ACK 后通过消息去重和真 get 重载确认；不使用 assistant/runId 占位代替消息。

〔裁〕SSE 独立事件命名 `queue.state`，无 seq，响应如下：

```ts
type CloudQueueSnapshot = {
  type: 'queue.state'; conversationId: string;
  queueRevision: number; aclRevision: number; currentRunId: string | null;
  items: Array<{messageId: string; arrivalSeq: number;
    state: 'queued' | 'preparing' | 'running' | 'cancelled' | 'done';
    position: number | null; runId: string | null}>;
};
```

状态已按实际 `claimNextInState/markReadInState/finishInState/privateFenceInState` 核过，终态是 done/cancelled，不能用未知值默认运行或完成。queued 行按同一获权 get 快照 arrivalSeq 排序，position 从 1 开始；其它状态 position=null。user 事件独立保留 `{type:'user',seq,messageId,prompt,senderAccountId,senderNameAtSend,queueState}`，runId 仅权威确实有值时使用。客户端拒错误 conversationId、重复 messageId、非安全 revision/seq 和非法 position；旧 queueRevision 不回退，独立 seq 不覆盖队列 revision。初次订阅及变化均发送完整队列快照，普通消息按 arrivalSeq/messageId 去重，续接不丢已发送者或旧消息的队列变化。

〔裁〕`/v1/info` 在 account-policy 模式返回现有 enabled/running，追加 `accountMode:true,executorMounted:false`，从现有未挂载执行器事实派生。页面文案为“已排队，等待执行服务”，不显示正在模型执行。将来 runner 接通后须由该实现自身报告 mounted，当前不新增自由 ready 参数。

### 实际撤销边界与尚未接通处

每次事件写出前 fresh access 并核获权快照 aclRevision；不能用 250ms 轮询缓存延迟拒绝。精确检索发现 `server/agent/service/conversation-policy.mjs` 的 `onRevoke` 当前是 no-op，HTTP 的 openStreams 订阅虽已有回调，却没有账号的真实控制来源。fresh mTLS RPC 不能单独证明“doc 提交切私有/踢人后 Agent HTTP 零新正文”，因为 RPC 成功与实际 write 跨服务仍有窗口。

这项不得以本任务队列绿色冒称完成。已向主会话报告，需要现有 doc→Agent control owner 提供真实同步 subscription fence，关闭实际 HTTP/源 socket，组合真实 receipt 后才确认完成；不能用轮询、自由回调或 HTTP finish 当 actual close。当前 lease 只含 info 与 accountEvents，不含 main/runner/control 接线，故先保留明确缺口并等精确接口，既定撤销语义没有降级。

### 真实本机夹具组合

新增专属夹具可复用 `server/test/fixtures/account-dual-user-path.mjs` 已验证的临时真实 VH provider、doc combo、独立 asset 子进程、HTTPS edge 和真实站点账号会话机制，但该现有夹具没有 Agent 登记/私有客户端，不能直接宣称发送已接通。新夹具须在临时服务登记表登记 Agent，从 `server/agent-service/conversation-client.mjs` 建真实 pin+mTLS client，经 `server/agent-service/hosted-wiring.mjs` 的账号 authenticate 和 `createAccountConversationService` 接 HTTP；edge 转实际 `/agent/v1`。真实 doc assembly 使用同 ledger、真实 accepted-message provider、同意与 selection capture，不伪造权限或 ready。

端口计划全部在 6520–6539：账号网站/内部、doc 公共/内部、asset 公共/内部、Agent HTTP、HTTPS edge、两舞台源；页面构建复用真实 compiled online artifact。夹具秘密、TLS key 与账号凭据仅 TMP/RAM，日志只固定状态、公开 ID 和端口。尚未编写或运行；实际监听和浏览器目标待主会话窗口。现有夹具 account mode 的 `assetPort:6389` 仅参数占位，实际明确 `combo.assetPort===null`，不新增监听，不借此占用其它段。

## 文件独占边界

已确认任务提出的 `src/account/client.ts`、`src/editor/sync/syncManager.ts`、`src/ai/cloud/{identity,cloudApi,types,events,session,useCloud}.ts`、`src/editor/right/{CloudAiPanel,ChatHistoryDrawer}.tsx/.css`、`chat/MessageList.tsx`、`chat/QueueList.tsx` 和 `server/docservice/account-hosted.mjs` 均存在。账号客户端现有测试为 `src/account/client.test.mjs`；云端现有测试实际为 `src/ai/cloud/cloud-chat.test.mjs`、`page-requests.test.mjs`、`cloud-report.test.mjs`，未找到按 identity/cloudApi/events/session 分名的测试文件，需要新增专属测试或取得这些现存 target 的精确租约。

`hostedServices.ts`、`selectionPresence.ts` 当前只读；优先复用已有导出，必要改动先报告。`src/ai/types.ts` 等未租文件不得顺手修改；发送者与队列 metadata 可先使用 Cloud 层独立类型及渲染参数，不污染本地 Agent 消息契约。

## 验证与证据状态

当前仅只读路径/接口检索、起点与干净状态核对及监听预检。没有把模块已有测试、历史 58 项公网路径或主会话基线算成本任务通过。后续验证必须覆盖真实本机账号、文档与 Agent account-policy HTTP、两个隔离浏览器的真实发送及持久共有消息，不用 ready、ACL、SSE、队列 mock。临时服务与浏览器只用本任务端口、TMP 和自有进程，结束等待实际 close。类型与全量按主会话后续窗口执行，首次失败日志保留。

待续：首次告知依赖收回后的源码同步；委托/创建者/选区接线；队列 SSE 窄扩租；真实双账号用户路径及持久恢复验收。当前为已提交开工与接口草案，尚未实施或交付用户路径。

## 实施与固定证据

主会话在工作区干净时同步首次告知 main，组合点为 `053e9f63d8464b088a7ba657f11f23a139704bc8`。开工草案以上的“尚未实施”均是历史记录，不代表当前状态。当前已实现产品接线，真实浏览器夹具尚未获启动窗口，不能称用户路径通过。

源码块 `88a4f43e` 接通现有会话的 opaque agentDelegationTicket，续签前后核当前项目和账号绑定；退出或换项目撤掉 provider，账号模式不走旧 auth.ticket/getGrant。session 增 creator/accessRevision/hosted Agent 投影，creator 每次来自重新核过的 authority，开关来自项目记录，地址与登记来自可信 constructor 配置。syncManager 的开启操作使用 fresh creator、expectedAccessRevision 和真实 admin POST，返回 pending-services 不冒称多服务停止完成。桌面 SCRIPT 只增加精确 admin 路径，原主窗口/origin/token/POST body/上限守门不变。

真实选区只发送已认证 presence 的 pageId。202 保留 messageId/arrivalSeq/queueRevision/position/runId:null；账号消息渲染不生成 assistant 或本机排队记录。SSE 独立 queue.state 从同一次获权完整持久 get 视图派生 FIFO，并在每项正文及队列写出前 fresh access/aclRevision 核验；请求 aborted 或响应 close 收口，不误把 GET 请求正常结束当 SSE 结束。发送者来自持久 senderAccountId/senderNameAtSend。页面展示“等待执行服务”，info 明确 accountMode=true/executorMounted=false；本块没有接 read/run/model。G 首次同意门保持原实现。

`adfc9589` 对齐原账号客户端测试夹具的完整 session projection，新增 actual SCRIPT 路径守门及专属真实服务夹具。`ea63df0b` 新增浏览器探针和无业务监听的 HTTP/SSE 协议目标。后续窄补：202 响应精确 projectId 必须等于当前 CloudApi 项目绑定，拒错项目或已丢绑定；浏览器静态 catalog 使用真实 online 构建产物。

| 固定源码 | 命令范围 | 实际结果与原始日志 |
|---|---|---|
| 88a4f43e | 绝对 TypeScript tsc -b --force | exit0、零错误，wall 6856.7ms；TMP `pc-queue-type-1.log` 为空输出 |
| 88a4f43e | npm test：client、account-queue、cloud-chat 三文件 | 首次 32 项/31 通过/1 失败/0 取消/0 跳过，1575.8926ms，wrapper wall 1810ms，exit1；TMP `pc-queue-pure-1.log` 原文保留。旧客户端夹具缺委托和权威投影字段触发严格 503，未降低产品校验 |
| ea63df0b | npm test：以上三文件＋cloud-queue-native-admin＋cloud-queue-http | 36 项/36 通过/0 失败/0 取消/0 跳过，1740.9864ms，wrapper wall 1965.3078ms，exit0；TMP `pc-queue-pure-2.log`，nativeRetries=0 |

所有 npm 均使用已装 Node 的 npm-cli.js，经仓库 npm wrapper/global setup；唯一原坏端口 guard 仍按原规则运行并 teardown。本任务目标未建立 HTTP/TLS/WS 业务 listener，未启动 Chrome、实际壳或全量。子 PowerShell 执行的是实际 Rust SCRIPT，只有 Http 函数由受控无监听适配器替换，证明路径/body/token 分支，不能证明 native IPC/系统 TLS。HTTP/SSE 目标使用实际 handler/account-policy 与受控 doc RPC，证明消息/独立队列 revision/晚验权拒分支，不能证明真实对话权威持久化或即时跨服务 fence。

### 已编写的真实服务与页面目标，尚未启动

`server/test/fixtures/cloud-queue-user-path.mjs` 的 `startCloudQueueUserFixture(options)` 复用真实 VH store/app/internal/order、doc assembly 同 SQLite、临时服务登记、独立 asset Node 子进程及其真实持久 consumer/head/status，再增加真实 Agent HTTP account-policy 和 pinned mTLS conversation-client；不用 ready、ACL、队列或 SSE mock。options 为 `{providerRoot,passwordOrderModule,publicHandler,ports?}`，默认端口是 site6520/account-internal6521/doc6522/doc-internal6523/asset6524/asset-internal6525/Agent6526/edge6528；6539 仅 combo 旧 LAN 参数，账号组合明确 assetPort=null，未监听。返回 origin/公开 projectId/ports/assetPid/close 与仅 RAM accounts；禁止 stringify 整个返回对象。close 等 asset 子进程 close、升级双 socket、各服务器实际 close。

`scripts/probes/cloud-queue-user-pages-probe.mjs` 使用真实 compiled dist-online、VH site 静态内容及两个隔离 Chrome context。舞台6530/6531，共十个业务监听，均在租约6520–6539。真实表单 A/B 登录，A 新建并确认首次同意、创建者开启 Agent，B 以真实链接加入和同意；A 发送→B 从真实历史选择同一共有对话→B 发送→两端核同 messageId/FIFO/发送者→B reload 核持久恢复。两个实际 messages202 必须出现，不用事件注入，不改 DOM disabled，不读剪贴板或打印账号秘密。所有阶段 timeout30s，夹具已有等待20s/HTTP5s；第一失败立即进入 owned teardown，不同源码盲重跑。截图遇密码字段跳过；网络只记录 pathname/status/method，查询串/headers/票据/正文不输出。浏览器临时证书容错只作用此隔离 browser 进程，不改系统 CA、原生 HTTP 或生产。

本夹具是在同一 Windows OS 上用临时角色证书和真实 mTLS；registry/sender/head 等走真实 provider，但独立 OS 用户隔离与生产 root 实例注册不在此目标证明范围。Agent 只有 conversation-policy，没有 runner；队列通过也不表示 Agent 执行、模型、素材或关闭 receipt 链完成。

待主会话批准的执行入口：先固定源码及真实 online 构建，再运行 `scripts/probes/cloud-queue-user-pages-probe.mjs --dist <本叶dist-online> --site-root <真实VH site> --out <TMP本任务独占目录>`，设置真实 provider/order 路径、fileURL silent preload 和仅进程 cuda/models 环境。asset 为唯一常驻业务 Node 子进程，Chrome 使用 pipe；临时 PKI openssl 子进程隐藏并等待 close。固定端口、业务子进程/浏览器与构建尚未实际启动。真实 Rust admin IPC 由主会话后续独立编译/窗口验证；本任务不占旧6388、不扩 lib.rs、不以受控注入替代。

明确未做：整套 npm/真实双浏览器/真实 native IPC/节点与公网/模型执行/跨服务立即 fence。fresh RPC 与250ms轮询不替代已有即刻撤销承诺，account-policy onRevoke 的真实 control 来源仍须专属 owner 接线。

### 主会话首次真实浏览器与探针操作修正

主会话在固定 `e9abf5945750907fbe75af9c05a6b61096a9f108` 编译 online 并单次运行；本叶没有启动该服务/浏览器。原始 TMP `pc-cloud-queue-e9abf594-once/result.json`、两张队列图和 failure-0/failure-1 图均保留。sourceBefore/sourceAfter 完全相同；9/9 前置检查通过但 completed=false，总35002ms，phase=reload 等待 queue 超时。实际 create201、admin200、join200、两次消息202，双方同一 messageId/FIFO 和真实用户名已通过；这些局部结果不冒称刷新恢复或完整链通过。cleanup.closed/childClosed=true、assetPid35024；主会话实际复核6520–6539零监听。

已只读查看 failure-1：刷新后 cookie 已恢复，页面为已登录账号开始页，joined 有 baseline 项目和本次 Queue shared browser project。`workflow/project.md` 第13/26条规定在线开始页与共用账号登录；`product/agent.md` 承诺重新打开项目后能找回有权对话，没有要求普通 F5 自动回到编辑器。真实 `AccountProjects.restore` 仅恢复账号/列表，`enter` 从可见按钮触发。本次是探针误假设直接 reload 后应立刻出现队列，没有改产品刷新行为。

仅 probe 修正为：F5→等待真实账号与目标 joined 行 enabled→实际点“显示项目链接”并核同源链接中的 projectId 等于本次 ID→实际点击该行打开项目→从真实历史选择原 conversationId→核原 messageIds/FIFO 并截图。新增 reload-cookie-restored、reopen-list-link-exact-project、reopen-same-conversation 检查，重用原 queue 恢复检查。禁止新建、重送、注入页面状态/URL或替代后端；只读取 DOM 及现有只读对话标识，链接全文不写结果。

本次改动只有 probe 和报告，nodecheck exit0、diff --check0，未重新执行 pure/type/full/浏览器。产品与测试源码相对 e9 原样保持，主会话可复用已编译同一产品的 dist 单次有因运行。另补 e9 提交后完成而此前尚未记入的固定证据：项目归属专属目标6/6、209.2007ms、wrapper397.3602ms，TMP `pc-queue-project-confirm-1.log`；force type0、wall7392.2995ms，TMP `pc-queue-type-2.log`；原 probe/fixture nodecheck 均0。原首 pure1 失败和首次真实 reload 超时未删除或覆盖。实际 Rust admin IPC/全量仍由主会话独立验证，当前不称执行器可运行。
