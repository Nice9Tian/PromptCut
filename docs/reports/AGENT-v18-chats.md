# 0.7.18 块五：50 个对话与删除

分支 `claude/v18-chats`，从 `main` `316f3f7c` 分出，2026-10-13。只在这个工作区里干活；没连节点、没读 `docs/local.md` 里两个环境变量以外的内容、没动 ChatGPT 的分支和工作区、没动 VisuHive、没动渲染那一带和那十个不许改的文件。语义文档没改（要改的地方写在「对任务书或语义的更正建议」）。

几个词：

- **开对话的人**：对话的所属账号（代码里 `ownerAccountId`）。共有对话里别人发消息不改变所属，几个成员在同一个对话里发言仍只算一个对话，名额算在开它的人名下。
- **创建者**：项目创建者。
- **名额**：同一个项目里同一个人最多 50 个云端 Agent 对话。
- **先停再删**：对话里有任务在跑时，先给这个对话下一条「停止」围栏，等 Agent 一侧确认任务真的停了、资源收干净，才删。用的是块一（接回独立任务进程）留的口子，和用户点「停止」是同一个办法。
- **围栏**：文档服务账本里的一条控制记录，从提交那一刻起这条任务再也过不了闸；它办完（任务进程真的被关掉、文档服务读到 root 的关闭记录）才算「停稳」。
- **探针端口段**：这一块分到 28180～28219。

## 第二轮：用户 2026-10-13 定的七条（原文在 `docs/plan/user-decisions-2026-10-13.md` 第 2 节「块五」）

下面这一节以后的内容是第一轮（用户定之前）的记录；凡和这一节冲突的，以这一节为准（第一轮「要用户定的事」那七条已全部定了，见本节末尾的对照）。

### 先并 main

`git merge main`（并入时 main 在 `ca8ded81` 之后一路到当前），两处冲突，都两边保留：

- `server/agent-service/http.mjs`：① `accountEvents` 轮询的 `catch`：main 改成「只有文档服务的 401/403/404 才发 `access.revoked`，503 一类只关流不说没权限」（`DENIAL_STATUS`）；我加的是「对话被删单独发 `conversation.deleted`」。合成：文档服务回 404 `conversation-deleted` 发 `conversation.deleted`，其余 401/403/404 照 main 发 `access.revoked`，别的只关流。② 路由段：main 的 `/v1/usage` 带 `since` 参数那一版 + 我的 `/v1/notices`、`/v1/notices/ack`、移出成员清私有对话的路由。
- `src/ai/cloud/useCloud.ts`：返回对象里 main 的 `openChat: (id) => switchTo(id)`（配合新对话的 `fresh` 标记）+ 我的 `removeChat`、`history.ownedCount/atLimit`。
- 核实 `869c5805`（读到过的对话重连得 404 显示「当前账号已无法读取这个对话…」）：被删的对话走哪条？文档服务对「删掉的号」改回 404 `conversation-deleted`（只对看得到过它的人：共有对话的成员、开对话的人、创建者；别人的私有对话仍回 `no-conversation`，不泄露存在过）。页面这一侧：流还开着时收到 `conversation.deleted` 事件；断线后重连收到 404 `conversation-deleted`（`session.ts` 里加了一支，排在 main 那支 `isAbsent` 之前）。两种都是：清掉正文、退到一个新对话、不重连、**不**显示「无法读取」那句；「你正在看的对话已被删除。」那句仍显示（自己删的不显示）。`access.revoked` 那句只给真的被撤权（私有、被踢、关 Agent）的情形。测试：`chat-delete.test.mjs` 末尾两条 + 探针 `member-viewing-deleted-conversation-moved-to-new-chat`。
- 并完的基线：`npx tsc -b --force` 退出码 0；这一块的测试全过。

### 七条逐条

| 条 | 做法 | 证据 |
|---|---|---|
| 1 界面文字照草稿 | 草稿算用户确认的原文，`chatTexts.ts` 头注释改掉「草稿」字样；只有第 5 条新增的那组仍标「〔草稿〕」 | 见下面第 5 条的句子 |
| 2 删干净 | 文档服务：对话行拿掉，墓碑只留不含文字的 8 个字段；新增 `server/account/conversation-scrub.mjs`，把账本各处带这个对话文字的记录清掉（只清文字，不删记录）。Agent 服务一侧：新增 `server/agent/service/conversation-purge.mjs` 清事件库（`account-run-events.mjs` 新增 `purgeConversation`）、已读意向（`read-intents.mjs` 新增 `purgeConversation`）、模型历史目录、工作目录与附件。删成功后才清；清失败回 503 `purge-failed`，页面用同一个请求号重试，会（含「已删」的重放）再清一遍。`purgeDeletedContent` 开关去掉（一律清） | 下一节的表；`conversation-delete.test.mjs` 的 3 条「块五第 2 条」（把整本账本序列化后查不到文字）、`conversation-delete-agent-side.test.mjs` 第 1 条（直接读事件库和已读意向的 SQLite 文件、查目录） |
| 3 切私有前发过言的成员不通知 | 本来就是这样（共有对话才通知发过言的成员，私有只通知开对话的人），测试在 | 第一轮「私有对话」那条测试 |
| 4 只读成员不能删自己开的对话 | 本来就是这样（只读成员 403），补一条明确的测试 | `conversation-delete.test.mjs`「块五第 4 条」 |
| 5 移出成员时选「是否同时清除他的私有对话」 | 成员面板里「踢出账号」的确认框多一个勾选框，缺省不勾（共有对话一律保留）。勾了：踢出成功后页面调 `POST /v1/members/clear-private`，文档服务对这个账号在本项目的每个私有对话做一次和单个删除完全一样的删除（先强制结束在跑的任务再清；顺带清 Agent 一侧）。他已进不了项目、收不到通知，所以这一批不留通知。没办完的（任务没停稳）列在 `pending`，面板里显示「重试清除」沿用同一个请求号。只有创建者能调 | `conversation-delete.test.mjs` 2 条「块五第 5 条」、`conversation-delete-http.test.mjs`（真 mTLS）、`conversation-delete-agent-side.test.mjs` 最后一条、探针「kick-with-clear-private」一段与截图 16、17 |
| 6 满额「新对话」不灰；对话数实时更新 | 「新对话」按钮没改（不灰），满额时第 51 个仍由服务端拒。实时更新：账号模式下页面每 3 秒（页面看得见时）后台读一次列表，回到前台和有人删了对话时立刻读一次；列表没变就不重绘。对话历史「云端」标题后面加显示「我的 N/50」。后台刷新失败不弹提示 | 探针：同一个账号在两个浏览器环境登录，一页删一个、另一页**不刷新**从 50 变 49 且那一行消失、满额提示消失；另一页新建、这一页变回 50；两页满额时「新对话」都没有 `disabled`；截图 13～15 |
| 7 不给取消；停不下来就强制结束再删 | 没有「取消删除」。停止围栏本来就是强制结束：文档服务出强制终态、root 关进程（`AGENT-v18-worker.md`）。删除这一步现在替页面等：Agent 服务收到 503 `agent-fence-pending` 后用同一个请求号隔 0.2 秒再问，最多等 15 秒（同「停止最多等 15 秒」，`deleteWaitMs`），办完才删、才清。到时没办完回 503，对话停在「正在删除」，页面显示「重试删除」；并且这位账号下次打开页面时自动接着办（`deletingBy`），不用他再点 | `conversation-delete-running.test.mjs` 3 条（真任务进程：一次调用就办完，任务进程被 root 关掉、结果「被中断」、对话读不到、清理和接缝在删成功之后；卡住时 8 次重试都不删） |

### 删干净那张表（删除一个云端对话以后各处还留着什么）

| 地方 | 删后 | 说明 |
|---|---|---|
| 文档服务账本：对话行（消息原文、标题、选区快照、排队状态） | **清掉** | 整行拿掉；名额同一个事务里让出 |
| 账本：每次发送、切换、改名的幂等结果里的标题与对话摘要（`conversationRequestsV2`） | **清掉** | `conversation-scrub.mjs` 按「项目号 + 对话号」找 |
| 账本：每一轮的运行授权、领取、已读、结束的结果里的整条消息、选区快照（`runGrantsV2`、`runRequestsV2`、`runReadRequestsV2`、`runFinishRequestsV2` 等） | **清掉文字，记录留** | 停止、结清、审计按号引用这些记录，整条删会让别处找不到；只剩号、状态、时间和 `contentDigest`（消息内容的 SHA-256 摘要，不是文字，不能还原） |
| 账本：墓碑 | **留，不含文字** | 只有对话号、项目号、开对话的人、可见性、谁删的、什么时候、请求号、通知了几个人；作用是让重复的删除得到「已删」、让旧对话号不复活、让看得到过它的人读到「已删」而不是「没有」 |
| 账本：还没弹出的通知 | **留到弹完** | 里面有对话名，气泡要靠它把话说清楚；弹完回执整条删，每人每项目最多留 50 条未弹的。移出成员时顺带清的那一批不生成通知 |
| Agent 服务事件库（`run_events`、`accepted_messages` 已接受消息原文、`conversation_heads`、`run_bindings`、任务进程交上来的来源包） | **清掉** | `purgeConversation` |
| Agent 服务已读意向（含提示词原文） | **清掉** | `purgeConversation` |
| 共用数据目录里的模型历史（`tenants/<项目>/conversations/<对话>`） | **清掉** | 目录整个删 |
| 共用数据目录里的工作目录与附件（`work/<项目>/<主人键>/<对话>`） | **清掉** | 目录整个删，包括用户上传的附件和工具下载的文件 |
| 云端浏览器、感知子进程等在 Agent 一侧还占着的东西 | **接缝，等 v18-wire** | 见下一节「留给工具表接线的接缝」 |
| 各代任务进程自己的本机状态（`stateDir`：已读意向副本、任务进程的事件日志 `worker_packets` 含事件包） | **清不了** | 在 root 管的各槽目录里，主服务够不到、也不该碰；一代任务进程结清后退休，目录不自动清（`mechanism/agent.md`「数据目录两份」）。建议：root 入口退休一代时一并清 `stateDir`（另一块要做的事，我没动 root 一侧） |
| 用量流水（`usage/`） | **留** | 只有项目、成员、对话号、模型、用量数，不含文字；额度和账单要用 |
| 项目里 Agent 改过的内容、操作历史 | **留** | 是项目内容和署名，不是对话文字；任务书说已落地的修改保留 |
| 账本、事件库的备份副本 | **清不了** | 备份删除不在授权内；随备份轮换自然没 |

### 留给工具表接线的接缝

在 **`server/agent/service/conversation-policy.mjs` 的 `createAccountConversationService({ …, onConversationDeleted })`**：`async ({ projectId, conversationId }) => void`，缺省空实现。文档服务确认删掉（含重复删除得到「已删」、含移出成员时清掉的每一个）之后，在 Agent 一侧各处清理完成之后调用；它抛错就回页面 503 `purge-failed`，页面用同一个请求号重试会再调一次，所以实现要幂等。两个装配入口都已透传这个参数，不用改我这边的代码：

- 生产（账号主服务）：`createAccountMasterAssembly({ …, onConversationDeleted })`（`server/agent-service/account-master-assembly.mjs`）；`main.mjs` 还没传，v18-wire 合入后由它在 `main.mjs` 装配那一处传进去。
- 进程内跑任务的老路：`createAccountRunnerService` 的 `runnerOptions.onConversationDeleted`。

谁后合谁接上：v18-wire 合入时把「收掉这个对话的云端浏览器、感知子进程」接到这个参数上即可；我这边合入时它是缺省空实现。注意任务进程里的东西（若子进程跑在任务进程里）主服务够不到——那种情形接线要走任务进程那一侧，不在这个接缝的能力范围内，v18-wire 要自己判。

### 第 5 条起草的界面文字（先用上，用户事后改；全在 `src/ai/cloud/chatTexts.ts`）

- 勾选框：「同时清除他的私有对话（他的共有对话会保留）」
- 清除中：「正在清除他的私有对话…」
- 完成：「已清除他的 N 个私有对话。」（没有私有对话时「他没有私有对话。」）
- 没办完：「还有 N 个对话里的任务没停稳，暂时没有清除。点「重试清除」会接着办。」；按钮「重试清除」

### 验收运行器登记的文件名

`scripts/acceptance/v18-manifest.mjs` 登记的四个文件名都对得上（`server/test/conversation-delete.test.mjs`、`conversation-delete-http.test.mjs`、`conversation-delete-running.test.mjs`、`src/ai/cloud/chat-delete.test.mjs`）；**多出一个**：`server/test/conversation-delete-agent-side.test.mjs`（Agent 服务一侧的清理、替页面等强制结束、接缝）；探针 `scripts/probes/conversation-delete-probe.mjs` 的检查项从 40 项变成 55 项（清单里写的「40 项检查」要改）。新测试不写死端口：`conversation-delete-http.test.mjs` 原来写死的 28180、28181 已改成向系统要；探针用的是分给我的 28180～28189 段（探针不是 `npm test` 里的测试）。

### 第一轮「要用户定的事」七条的结果

| 第一轮 | 用户的决定 | 代码 |
|---|---|---|
| 1 界面文字 | 照草稿 | 不再标草稿 |
| 2 删后文字要不要清 | **清干净（比我建议的 B 更彻底，连日志、请求记录里的标题都清）** | 见上表；`purgeDeletedContent` 去掉 |
| 3 切私有前发过言的要不要通知 | 不通知 | 没变 |
| 4 只读成员能不能删自己开的 | 不能（用户备注：将来只读成员开的可能是临时会话，退出后自动删，记待办） | 没变 |
| 5 被移出成员的对话 | **和我的建议不同**：移出时让操作的人选「是否同时清除他的私有对话」，共有对话缺省保留 | 见上 |
| 6 满额「新对话」要不要灰 | 不灰；另加：对话数要实时更新 | 见上 |
| 7 删到一半要不要取消 | 不给；停不下来就强制结束再删 | 见上 |


## 第一轮（用户定之前）：做了什么

### 1. 50 个上限：满额不让新建，不自动删历史

- 账号模式（文档服务的对话权威 `server/account/conversation-authority.mjs`）原本就在新建时拦第 51 个（409 `conversation-limit`）；这次把数字提成常量 `MAX_CONVERSATIONS_PER_OWNER`，加了注释和测试，计数按「项目 × 开对话的人」，别人在共有对话里发言不算。
- **`evictOld`（满额自动删最旧）去掉了**。摸底报告第 8 节第 5 条留的问题「它在哪些路径上还生效」答案是：只在旧的（非账号）托管路径上——`createHostedAgentService` 非账号分支用的 `server/agent/service/conversations.mjs`；账号模式在 `create-agent-service.mjs` 第 193～200 行就分出去了，从来不建这个文件存储，所以云端账号项目走不到。现在这条旧路径满额时 `store.get(…, { create: true })` 抛 `conversation-limit`，服务层译成 409，不删任何对话；旧测试 `CA-CHAT-03` 原先断言「第 4 个来了淘汰最旧的」，改成断言「被拒、原来的一个不少」，另加 `CA-CHAT-04`（服务层）钉住。

### 2. 删除入口（文档服务的对话权威 + Agent 服务 HTTP + 页面）

规则全部照 `account-binding-task.md`「已拍板」的「云端 Agent 对话的删除」（2026-10-12 用户定）：

| 规则 | 做法 |
|---|---|
| 开对话的人删自己的；创建者删任何成员的，含别人的私有 | `conversationAccessInState` 新增 `delete` 动作：私有对话对创建者只开放读和删，其它动作仍当没有这个对话；既不是开对话的人也不是创建者回 403 `delete-forbidden`；别人的私有对话回 404 |
| 删之前确认 | 页面弹确认框（见下）；服务端不另设确认接口 |
| 有任务在跑，先停再删，已落地的修改保留 | `remove()` 第一步事务里把对话标成「正在删除」、作废排队中的消息，并对正在跑的那一轮下 `kind: 'stop'` 围栏（请求号 `delete:<第一次删除的请求号>`，换请求号重试也落在同一条控制记录上）；然后等 `onFence`（和停止同一个口子）确认；确认后第二步事务再核一次「没有活着的运行授权、`currentRunId` 已清」才删。停不下来（围栏还在办、ack 没回、任务没真停）一律不删，对话留在「正在删除」，用同一个请求号重试 |
| 删完立刻让出名额 | 同一个事务里把对话行从账本拿走（计数、列表都看不到）、留一条存档、记录幂等结果 |
| 别人看到什么 | 见下一节「通知」 |
| 不自动删历史 | 同上 |
| 重命名入口不在范围 | 没做；服务端原有的 `rename` 接口没动，只是「正在删除」的对话不能再改名 |

新增接口：

- 文档服务内部（mTLS，Agent 服务调用）：`/internal/v2/conversations/remove`、`notices`、`ack-notices`；`conversation-internal.mjs`、`conversation-client.mjs` 对应。
- Agent 服务对页面：`DELETE /v1/conversations/<id>`（体 `{ requestId }`，原来固定回 503 `deletion-pending`）、`GET /v1/notices`、`POST /v1/notices/ack`（体 `{ noticeIds }`）。
- 对话流事件新增 `conversation.deleted`（对话被删时关流前发；和权限被收回的 `access.revoked` 分开说）。
- 「正在删除」期间：新消息 409 `conversation-deleting`、不再领新一轮（`claimNextInState` 拒）、不能切共有私有和改名；删一半时别的人想接手删也被拒（409），不和第一个人抢。
- 重复删：同一请求重放回原结果；换请求号再删，开对话的人和创建者得到 `already: true`，别人 404；并发删只删一次、只通知一次。删掉的对话号不复活（旧发送请求重放、拿旧号新发都回 404 `conversation-deleted`）。
- 满额提示的服务端那一句、删除错误码（`delete-forbidden`、`conversation-deleting`、`conversation-limit`、`agent-fence-pending`）进了 `cloudErrorText`。

### 3. 通知（气泡与补弹）

- 谁收：删的不是开对话的人时，开对话的人收一条；共有对话里发过消息的其他成员各收一条（同一个人发多条只收一条）；删的人自己不收；没发过消息的成员不收。开对话的人删自己的共有对话，在里面发过消息的其他成员照样收。私有对话：开对话的人自己删，不通知任何人；创建者删别人的私有，只通知开对话的人。
- 存哪：文档服务账本（`conversationNoticesV2`，每人每项目最多留 50 条未弹的，超了丢最旧的）。不在线的人下次打开项目取到、弹一次、弹完回执，回执之后不再给；别人的回执回不掉我的。
- 页面：`useCloudNotices`（`src/ai/cloud/useCloud.ts`）打开项目时取一次，之后每 15 秒和窗口回到前台时再取；自己删了对话、或正在看的那个对话被别人删时立刻再取一次；其余页面靠 15 秒一轮（所以别的成员的气泡最多晚 15 秒出现）。弹出用现成的右上角气泡（`pushToast`，点 × 才关）。正在看的对话被别人删了：流上来 `conversation.deleted`，页面自动退到一个新对话。

### 4. 界面

- 云端「对话历史」里每一条对话：开对话的人和创建者看得到 ✕ 删除按钮（其他成员没有）；点了弹确认框 `CloudDeleteChatDialog`（取消 / 删除；任务没停稳时变成「重试删除」并沿用原请求号）；删完弹「已删除，名额已经让出。」；删到一半的对话在列表里标「正在删除…」，按钮变成「继续删除」。
- 满额：历史列表顶上一行提示；当前是还没发过消息的新对话又已满额时输入框上方一行提示；发第一条消息被服务端拒（409）时弹出满额提示，输入框里的字保留。
- **界面文字全部是我起草的，集中在一个文件**：`src/ai/cloud/chatTexts.ts`（服务端那一句满额提示在 `create-agent-service.mjs` 的 `CONVERSATION_LIMIT_MESSAGE`，要同步）。任务书里只定了规则、没有原文，所以这些句子等用户定，见「要用户定的事」。

## 验证结果

### 基线

| 命令 | 结果 |
|---|---|
| `npx tsc -b --force` | 退出码 0，零错误（最后一次提交后重跑过） |
| `npm test`（第一次，在最后一处改动之前） | 6047 条，6045 通过，2 条失败：① `cloud-run-assets-current-vertical-tls.test.mjs` 的 `original asset TLS channel alone answers…`，`listen EADDRINUSE 6448`——机器忙时的端口撞车，单独重跑 2 条全过；② `CAU-REV-06`（`src/ai/cloud/page-requests.test.mjs`）：它用正则钉住 `useCloud.ts` 里 `createCloudSession({ api, store, accountMode, pageId, onPageRequest })` 那一处的写法，我往里加了一个字段就破了。没有改测试，改成「那一处不动，另用 `session.setOnConversationDeleted(...)` 登记」，重跑 11 条全过 |
| `npm test`（第二次，最终代码） | 6048 条，6047 通过，1 条失败：`cloud-run-assets-current-observer-tls.test.mjs` 的 `actual original pinned TLS channel…`，同样是 `listen EADDRINUSE 6448`。**原因：`cloud-run-assets-current-observer-tls.test.mjs` 和 `cloud-run-assets-current-vertical-tls.test.mjs` 两个文件都把端口写死在 6448，全量里恰好同时跑就撞**（第一次撞掉的是 vertical，第二次是 observer）。单独重跑 observer：通过；两个文件一起 `npm test -- a b`：3 条全过 |
| `npm test`（第三次，最终代码） | **6048 条全部通过，0 失败，退出码 0** |

### 这一块自己的测试

| 文件 | 条数 | 覆盖 |
|---|---|---|
| `server/test/conversation-delete.test.mjs` | 19 | 49→50→51 不自动删、项目×人各算各的（别人在满额的共有对话里发 60 条也不占名额）、并发创建不越过 50、删一个立刻让名额、删掉的号不复活；谁能删谁的（含创建者删私有、只读成员、被踢、登录被撤销）；先停再删、停不下来不删（围栏没确认 / ack 回 false / ack 了但任务没真停 / 运行授权还活着 / 没有停任务的口子）、「正在删除」期间拒新消息和抢删；重复删、并发删（同一人两次、开对话的人与创建者同时）；通知给谁（多种情形）、补弹（重开账本还在）、回执只能回自己的、封顶 50；存档缺省保留、`purgeDeletedContent` 打开才清 |
| `server/test/conversation-delete-running.test.mjs` | 2 | 用块一的整条真路径（文档服务账本、真的运行授权与围栏、真的任务子进程、槽调度、root 发布器事务）删一个正在跑的对话：第一次删回「还在办」→ 调度让 root 关进程、结清 → 同一请求号重试删成功；任务结果「被中断」、进程被 root 关掉（`killed`）、排队的别人的消息没被领去跑、其他成员各收到通知；另一条把 root 的强制关闭卡住，8 次重试都不删，放开后才删 |
| `server/test/conversation-delete-http.test.mjs` | 1 | 从页面的 HTTP 请求到文档服务（真 mTLS、真 SQLite、真 SSE）：删除 403/200、重复删、流上收到 `conversation.deleted`、通知取/回执/补弹、满额 409、删一个后再建 |
| `src/ai/cloud/chat-delete.test.mjs` | 5 | 页面一侧接口形状、错误码对应的话、列表项字段、通知、被删事件的处理 |
| `server/test/cloud-agent-runs.test.mjs` | `CA-CHAT-03` 改、`CA-CHAT-04` 新增 | 旧路径满额只拦新建、不淘汰 |

### 浏览器探针

`scripts/probes/conversation-delete-probe.mjs`：真账号后端（VisuHive 冻结的 provider）+ 本机隔离的托管组合（文档服务、素材服务子进程、Agent HTTP 服务），三个账号（创建者 creator、开对话的人 owner、普通成员 member）各开一个无头 Chrome 页面，页面只经 DOM 点击和输入操作，不注入页面状态、不伪造响应。唯一的「造数据」：往文档服务账本里直接放 49 个 owner 的空对话行（免得在界面点 49 次发送），第 50、第 51 个都由界面真发。端口 28180～28189，用完全部释放（结果里 `portsFree` 全真）。命令：

```
node scripts/probes/conversation-delete-probe.mjs --dist dist-online --site-root C:\Users\admin\Documents\VisuHive\site --out <os-temp 下的子目录>
```

（`dist-online` 是 `npx vite build --mode online` 的产物，在本工作区，已被 `.gitignore` 排除。）最终代码上的结果：`{"completed":true,"checks":40,"failed":0,"pageErrors":0,"closed":true}`。逐项（`docs/reports/assets/v18-chats/probe-result.json` 里有全部检查名）：

| 步骤 | 检查 | 截图（都看过） |
|---|---|---|
| owner 在界面发出第 50 个对话 | 创建成功、POST 202 | |
| 谁看得到删除按钮 | 普通成员在别人的共有对话和旧对话上没有删除按钮；创建者、owner 在每条上都有 | `01-member-history-no-delete-button`、`02-creator-history-delete-buttons` |
| 满额 | 历史顶上有满额提示；新对话输入框上方有提示；发第 51 个被拒（POST 409），提示原文一致；历史里仍是 50 个、原来的一个不少、没有自动删 | `03-owner-history-50-limit-hint`、`04-owner-51st-rejected-limit-text` |
| 确认弹窗 | 弹窗里写出对话名和「共有对话，发过消息的其他成员会收到通知」；取消后对话还在 | `05-owner-delete-confirm-dialog` |
| 删完让名额 | DELETE 200；该对话从列表消失；满额提示消失；「已删除，名额已经让出。」；之后能再新建（POST 202） | `06-owner-after-delete-slot-freed`、`07-owner-created-again-after-delete` |
| 创建者删 owner 的共有对话 | 弹窗多一句「其他成员开的对话，删除后他会收到通知」；DELETE 200 | `08-creator-delete-others-confirm-dialog` |
| 别的成员看到什么 | 在里面发过消息的成员：收到「项目创建者「…」删除了共有云端对话「…」，你在里面发过消息。」气泡，且正在看的对话自动退到新对话；owner：收到「项目创建者「…」删除了你的云端对话「…」。」；创建者自己：没有气泡 | `09-member-bubble-after-creator-delete`、`10-owner-bubble-after-creator-delete`、`11-creator-no-bubble` |
| 不在线补弹 | 成员关页面（about:blank）后 owner 删掉他发过言的共有对话；成员重新打开项目只弹一次；刷新再开不再弹 | `12-member-reopened-replayed-bubble` |

**没能在浏览器里验的**：删除一个**正在跑任务**的对话。这套隔离组合里 Agent 服务没挂执行器（页面上写「消息会持久排队，等待执行服务」），没有任务会真跑起来；这一项由 `conversation-delete-running.test.mjs` 用真进程路径验。生产入口里块一的槽调度仍缺省关（块一报告「生产入口」一节），所以生产上「先停再删」落在哪条路径上取决于那个开关：在进程内跑的老路径下，停止围栏要等 Agent 一侧回执才办完（和用户点「停止」完全同一个口子，停止能用删除就能用）。

## 对上摸底报告第 2 节 RS18-chat 的每一行

原行：「同项目同创建者 49→50→第51、共享消息多发送者、另一项目/创建者、并发创建、用户删除后重建/重开」。

| 输入 | 结论 | 证据 |
|---|---|---|
| 同项目同创建者 49→50→第 51 | 通过：第 50 个建得成，第 51 个 409，原来 50 个一个不少，不自动删 | `conversation-delete.test.mjs` 第 1 条；HTTP 全链路；浏览器 `04`/`limit-no-history-auto-deleted` |
| 共享消息多发送者 | 通过：别人在共有对话里发言不算他开了对话（成员在满额的共有对话里发 60 条仍只有自己开的 1 个）；浏览器里成员在 owner 的共有对话里发言，owner 的数不变 | 第 2 条；探针 |
| 另一项目 / 另一创建者 | 通过：另一个人、另一个项目各算各的 | 第 2 条 |
| 并发创建 | 通过：4 个并发抢最后 2 个名额，恰好 2 个成功，不越过 50（账本事务串行） | 第 3 条 |
| 用户删除后重建 | 通过：删一个立刻能建；浏览器里点删除→能再发 | 第 4 条；探针 `07` |
| 用户删除后重开 | 通过：删掉的对话号再发消息（新发、重放旧请求）回 404 `conversation-deleted`，不会把它救回来；正在看它的页面自动退到新对话；另一个成员关页面再开，补弹气泡 | 第 4 条；探针 `09`、`12` |
| 「依赖未决的删除成功/失败与释放切点另补」（任务书 RS18-chat 备注） | 通过：成功、权限失败、停不下来失败、释放切点（任务真停稳以后、同一个事务里）都有断言 | 上面 |

## 没做成的及原因

（第二轮更新：下面第 1 条「彻底清除」已做到除各代任务进程本机状态和备份外的所有地方，见「删干净那张表」；第 4 条的「新对话不灰」是用户定的。）

1. **「删除后文字在服务器上是否彻底清除」没有定，只做了最保守的一档**（见「要用户定的事」第 2 条）。除账本里的存档外，Agent 服务一侧的运行事件日志和账本里的请求记录（发送请求的幂等结果里带着标题）也含这条对话的文字；开关 `purgeDeletedContent` 现在只清存档，后两处没有清。对页面是不可见的（读接口都是 404）。
2. **旧的（非账号）托管路径没有删除的界面**：删除入口只给账号模式（`cloud.accountMode`）。旧路径服务端原本就有 `DELETE`（删自己的，不通知），页面没有接，因为任务书说云端项目一律走账号、旧云端项目清掉。
3. **删除一个正在跑任务的对话没有在浏览器里验**，原因同上。
4. **满额时「新对话」按钮没有置灰**：页面的列表可能是旧的，服务端才是准的，所以只给提示、让服务端拒绝；见「要用户定的事」第 6 条。
5. 没有改 `docs/semantics/`（规矩）。

## 我做的裁定〔裁〕

（第二轮更新：〔裁 1〕「没有取消删除」、〔裁 2〕「存档保留」、〔裁 3〕「只读不能删」、〔裁 4〕「私有只通知开对话的人」已被用户定了：1、3、4 照这样；2 改成清干净。〔裁 9〕改过的夹具断言仍在。）

- 〔裁 1〕**删到一半停不下来：对话留在「正在删除」状态，没有「取消删除」**，只有删它的人能继续；期间不收新消息。理由：任务书只说「先停再删」，没说停不下来怎么办；这是最保守的（宁可不删）。
- 〔裁 2〕**删完存档保留、只对所有人隐藏**（缺省 `purgeDeletedContent = false`）。理由：见「要用户定的事」第 2 条，宁可不清。
- 〔裁 3〕**只读成员不能删自己开的对话**（和其它 Agent 操作一致，`access: 'r'` 回 403）。
- 〔裁 4〕**私有对话的通知只发给开对话的人**：切私有之前在里面发过消息的成员不通知（他们已经看不到这个对话了）。
- 〔裁 5〕删除用文档服务账本里的对话行拿走加存档，不是改一个「已删」标记留在列表计数里：这样名额立刻让出、所有读取路径天然看不到。
- 〔裁 6〕删除接口的重放规则：请求号只在「一次删除、一个对话、一个账号」内有意义；删完后再来一次，开对话的人和创建者回「已删」，别人回 404。
- 〔裁 7〕未弹的通知每人每项目最多 50 条，超了丢最旧的；被移出项目的人取不到。
- 〔裁 8〕被删事件在页面里单独登记（`setOnConversationDeleted`），没有放进创建会话那一处的参数：因为 `CAU-REV-06` 守门测试用正则钉死了那一处的写法，不能改测试。
- 〔裁 9〕改了测试夹具 `server/test/fixtures/account-conversation-controls-user-path.mjs` 的一处断言：Agent 端口除了原来的 6620～6639 也允许 28180～28219（其它一字未动）。

## 对任务书或语义的更正建议

- `docs/semantics/workflow/production.md` 云端历史列表那一条（一级）：「云端对话这一版没有删除与重命名入口」要改成「开对话的人能删自己开的对话，项目创建者能删任何成员的对话（含私有）；删之前弹确认；对话里有任务在跑先停再删，已落地的修改保留；删完立刻让出名额；一个人在一个项目里最多 50 个，满了不让新建、不自动删历史；重命名这一版仍没有入口」。
- `docs/semantics/product/agent.md`「谁能管对话和任务」（二级）：补上删除的权限、通知（谁收谁不收）、补弹、先停再删、50 个上限计在开对话的人名下（原文都在 `account-binding-task.md`「已拍板」）。
- `docs/plan/account-binding-contract.md`「50 个不同对话与删除入口」整节、`cloud-agent-task.md` 第 17 行、`render-scheduling-supplement.md` 第 5.1 节末条、设计第 37 行、工具拆包第 11 行、部署清单第 31、38 行（摸底报告第 8 节第 11 条列的那几处）：仍写「待确认」，可以改成已定并指向实现；契约里要补上这次新增的三个内部接口和三个页面接口。
- 摸底报告第 8 节第 5 条的疑问可以关了：`evictOld` 只在旧的非账号托管路径生效，已去掉。
- 已记待办（不是块五范围）：新对话（服务端还没有这个对话）的事件流在真读取通道下回 502、页面一直显示「连接断了，正在重新连接」，见「要主会话注意的事」。

## 要主会话决定或注意的事

- **既有问题**（不是这一块引入的，截图里能看到）：打开一个还没发过消息的新云端对话时，`server/agent-service/http.mjs` 的 `accountEvents` 对「还没有这个对话」先写 200 再结束，被 `conversation-transports.mjs` 当成未授权的 200 拦下、连接被掐，探针夹具的边缘代理回 502，页面于是一直显示「和云端 Agent 的连接断了，正在重新连接」。我没有改（会动读取通道和页面的约定），已用一个任务芯片提给用户。
- 合并时注意：`server/test/fixtures/account-conversation-controls-user-path.mjs` 我动了一处断言（〔裁 9〕）；`docs/reports/assets/v18-chats/` 有 13 个文件（12 张截图加探针结果），约 1.4 MB。
- **全量测试里有一对必撞的测试**：`server/test/cloud-run-assets-current-observer-tls.test.mjs` 和 `…-vertical-tls.test.mjs` 都写死端口 6448（vertical 还用 6449），全量里两个文件恰好同时跑就 `EADDRINUSE`（我的三次全量里有两次撞，换着撞）。单独或一起指定文件跑都过。建议改成系统分配端口。
- 创建者把「云端 Agent」开关关掉以后，这个项目里所有对话（含删除）都回 403 `agent-disabled`，和现有的读、发消息一致；关着开关时没法删对话腾名额，要先打开。
- 删除接口需要文档服务装配里已有的 `onFence`；在没有 `onFence` 又有任务在跑时会 503 `agent-fence-unavailable` 且什么都不动。生产装配（`server/hosted/doc-agent-assembly.mjs`）里 `onFence` 是配了的，这块我没改它。

## 要用户定的事

第一轮的七条用户 2026-10-13 都定了（见「第二轮」末尾的对照表）。现在只剩一件：第 5 条我起草的那四句界面文字（「第 5 条起草的界面文字」），先用上，用户事后改。

## 提交列表

```
92b7c8c1 报告:0.7.18 块五(50 个对话与删除)立文件
a409675a 对话:50 个上限去掉自动删最旧、加删除(权限/先停再删/让名额/通知存档)与测试
9a49b809 界面:云端对话删除(确认弹窗、历史里的删除按钮、满额提示、别人删后的气泡与补弹)
64576d4d 测试:页面一侧的删除接口、通知、被删事件;HTTP 全链路(删除、满额、通知补弹、流上的被删事件)
1c30d52f 探针:云端对话删除与 50 个上限的浏览器探针(三个账号、40 项检查)与截图;夹具放宽探针端口段
（再往后的提交见 git log：被删事件的登记改法、旧路径服务层测试、探针重跑、本报告定稿）
```

## 最终全量

第二轮（并 main 之后、七条做完）最终提交：

- `npx tsc -b --force`：退出码 0。
- `npm test`（设了两个环境变量和 `PROMPTCUT_NO_PORT_FILE=1`）：**6621 条通过，0 失败，退出码 0**（12 条跳过、2 条待办是仓库原有的；输出里标 ⚠ 的 `accept-018-rest-ssr-seam` SEAM-2 是验收运行器登记的「现状不成立」项，不算失败）。
- 这一块的测试：`conversation-delete.test.mjs` 26 条、`conversation-delete-running.test.mjs` 3 条、`conversation-delete-http.test.mjs` 1 条、`conversation-delete-agent-side.test.mjs` 4 条、`chat-delete.test.mjs` 8 条、`cloud-agent-runs.test.mjs` 里 `CA-CHAT-03/04`。
- 浏览器探针：`{"completed":true,"checks":55,"failed":0,"pageErrors":0,"closed":true}`，截图 18 个文件（17 张图加结果）在 `docs/reports/assets/v18-chats/`，13～17 号是第二轮新增（两页实时对话数、移出成员时清私有对话的确认框与结果），我都看过。
- 探针这次起的进程全部收掉：无头 Chrome 随探针关闭，素材服务子进程随夹具关闭，28180～28219 无监听；机器上另有别的子 Agent 跑的 node 进程（别的测试），没有碰。

第一轮最后一次（并 main 之前）：`npm test` 6048/6048。
