# 云端真实发送与持久队列用户路径

## 开工与范围

本任务接通账号项目里用户可见的“真实发送、持久排队、共有对话双方看到发送者与第几”。排队成功不代表 Agent 已读、运行或模型已经调用；未接通生产 runner 时必须明确显示等待执行服务。本任务不处理历史浏览器普通档探针，不选择删除、提前让位、补渲故障等未决产品方案。

工作分支为 `codex/018-cloud-queue-user-path`，起点 `5fe070d62605dc3e5b360d1c4a9c43a948045c61`。开工时工作区干净；实际检查 6520–6539 没有监听。本任务没有启动监听、浏览器、服务、子进程测试或全量测试，也没有修改产品源码。用户常驻端口和其它 Agent 服务不在本任务操作范围。

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
