# AGENT-agent-panel-smooth

分支 `claude/agent-panel-smooth`（从 main `669ba647` 切出），工作区 `.worktrees/agent-panel-smooth`。

任务：修在线编辑器云端 Agent 面板的交互流畅度。六条现象来自 0.7.18 发版验收（2026-10-19，visuhive.com/editor，账号 9tian，新建云端项目「验收018-Claude」）。

## 一句话结论

| # | 现象 | 根因（一句话） | 改了没有 |
|---|---|---|---|
| 1 | 打开面板「正在确认对话权限」约 10 秒 | 面板要等自己的一次「列对话」读回来才放开输入框；列对话一次 2～7 秒（根因见第 3 条），换对话、切分页还要再等一次 | 改了：列表整页一份、进项目就读，读到过就放开；服务端变快 |
| 2 | 点发送后 2 秒以上没反应、5～7 秒才出气泡、先进「排队」 | 气泡要等服务端的记录从事件流回来才画；发送前还要过两次告知确认的往返；`POST messages` 本身慢（第 3 条）；空闲时消息在文档服务里先记成 `queued`，界面照搬成「已排队 第 1 条」 | 改了：点发送当场出气泡（发送中 / 已发出 / 没发出去），空闲时排第一的不进排队 |
| 3 | 接口又多又慢 | 主因：Agent 主服务本地的「已关读取」回执账本只增不删，节点上已有 10.6 MB，每次 HTTP 读取（列对话、发消息、取 info…）都要整段解析、整段写回并落盘，把主服务事件循环占住；次因：每个分页各自 3 秒拉一次列表、每 3 秒无条件续会话、成员名单每 3 秒取一次、事件流每 250 毫秒向文档服务新开一条双向证书连接读一次 | 改了 |
| 4 | 重开项目后面板是空的新对话；从历史点开要 13 秒 | 记「上次看的对话」的本地存储键里拼了页面内存里的绑定版本计数，刷新后计数从头数，键对不上；13 秒同第 3 条 | 改了（旧键自动找回一次） |
| 5 | 「Agent 1」删不掉；新项目里是 Agent 1、Agent 3 | 「Agent 1」是右侧竖栏的主分页，代码规定主分页不能关（`agentTabs.ts` 的 `closeTab`，不是语义规定）；分页清单存在浏览器本地、不分项目，名字按建的时候的分页数编号，中间关过一页就跳号 | 没改代码，待用户定（见末节） |
| 6 | 「第 1/24 轮：正在等待模型响应…」后的「0 秒」不走 | 轮次小字照抄服务端最近一条进度里的已用时间，等模型回话那一段几十秒没有新进度 | 改了：界面每秒往前走 |


## 逐条根因与改法

### 3. 接口又多又慢（先写这条，1、2、4 的「慢」都源于它）

证据（2026-10-19 节点 149.88.94.84 只读诊断，未改节点任何文件）：

- 进程 CPU（`ps`，进程活了约 31 小时）：文档服务 `promptcut-doc-v2` 累计 8 小时 6 分（26%）；两个 `render-worker.mjs` 各 26～27%，诊断当时各挂着刚起 16～32 秒的 Chrome（在渲染）；Agent 主服务 4.4%，但常驻内存 966 MB。
- Agent 主服务本地账本 `/var/lib/promptcut/agent/conversation-read-closures.sqlite`：一行 JSON，**10,634,044 字节**，几乎全是 `agentReadClosedV1`（每次 HTTP 读取关掉时记一行，原来一行都不删）。只读打开量得：解析 100 ms、序列化 148 ms。`server/account/ledger.mjs` 每次事务都整段解析、整段序列化、整段写回并 `synchronous=FULL` 落盘；`conversation-control-client.mjs` 每关一次读取就做一次这样的事务。列对话、取单个对话、开事件流、发消息后的读回、交附件，每一次都是一次读取。本机复现：1760 万字节的同形账本，一次事务 150～184 ms（PC，比节点快）。这段时间主服务事件循环被占住，所有 `/agent/v1/*` 排队，于是列对话平均 2.3 秒、info 6.6 秒、notices 2.9 秒、`POST messages` 5.2 秒。
- 文档服务账本 `/var/lib/promptcut-v2/doc/docservice/account-v2.sqlite`：1,772,174 字节（解析 26 ms、序列化 22 ms），其中 `agentReadsV1` 占 587 KB：8 个已退出、已收口的旧主服务实例各留 64 条已关读取（`pruneClosedReads` 不分实例活没活都留 64 条）。每次读取在文档服务一侧开、关各一次事务。
- 请求频率（nginx access.log 当天 + 代码）：
  - `GET /agent/v1/conversations` 每个 Agent 分页各一个 3 秒轮询（`useCloud.ts` 旧代码每个 `useCloudChat` 起一个），另外换对话、出第一条、切权限时各自再读；两个分页 2 分钟 39 次。
  - `POST /hosted/shared/account/session` 每 3 秒无条件一次（`syncManager.ts` 的 `metadataTimer` 每次都 `renew()`），文档服务每次签三张票据。
  - `POST /hosted/shared/account/members` 每 3 秒一次（`AccountMembersPanel.tsx`，不论成员列表展开与否）。
  - 事件流（`http.mjs` 的 `accountEvents`）每 250 ms 向文档服务读一次对话，每次是一条新的双向证书 TLS 连接（读取控制的设计：一条连接只发一个请求），不论对话忙闲；每开着一个对话页面，文档服务每秒 4 次握手加读取核对。
  - `/agent/v1/notices` 每个分页各一个 15 秒轮询。
- 节点日志：Agent 主服务 24 小时内一条 `read-control-timeout`；文档服务没有错误。nginx 日志格式不含请求耗时（`combined`），服务端单次耗时无法从日志直接取，上面的耗时是任务书给的浏览器实测与本机复现。

判断：主延迟源是 Agent 主服务那本 10.6 MB 的回执账本；文档服务空闲 25% CPU 主要来自上面几种高频请求（每 3 秒续会话签票、每 3 秒取成员、每个开着的对话每秒 4 次新 TLS 连接读取、列对话的开关两次整本账本事务）。渲染服务两个工作进程的 CPU 属于渲染服务，诊断当时它们在跑 Chrome，不是这几个接口慢的原因，只记录不改。

改法：

- `server/agent-service/conversation-control-client.mjs`：记新行时同一事务里删掉别的实例（重启前的进程、旧一代）的行，和文档服务已确认关掉且过了 10 分钟留存期（`CONFIRMED_CLOSE_KEEP_MS`）的行。确认以后还留一阵，是因为文档服务的读取控制流点名与关闭确认在两条连接上、先后不定（点名的那一刻本地要查得到这一行）。部署后第一次读取就把 10.6 MB 删到只剩几行。
- `server/account/agent-read-control.mjs`：`pruneClosedReads` 对已收口（`closed` 且有收口记录、代相符）的实例，名下已关的读取一条不留。
- `server/agent-service/http.mjs`：账号事件流空闲时（没有在跑的一轮、没有排队 / 准备中 / 在跑的消息、本机运行事件库没有新事件、没被叫醒）每 1 秒（`ACCOUNT_STREAM_IDLE_DOC_MS`）向文档服务读一次，忙时照旧每 250 ms；收下消息、切权限、停止后当场叫醒这个对话的事件流读一次。撤权仍由文档服务读取控制流当场掐断，不靠这个轮询。〔裁：三级，`mechanism/agent.md`「新对话的空对话」第三条「每一轮轮询都向文档服务核读权限」仍成立，只是空闲时轮询变稀〕
- `src/ai/cloud/historyStore.ts`（新）+ `useCloud.ts`：一个项目（同账号范围）整张页面只有一份对话列表、一个 3 秒轮询，分页都走了就停；同时只有一次在途；`refresh(maxAgeMs)` 两秒内读过就直接用。删除通知的轮询同样按键共用、引用计数。
- `src/editor/sync/syncManager.ts`：续会话改成每 15 秒（`ACCOUNT_METADATA_RENEW_MS`）或会话剩不到 60 秒时；连接到期检查仍 3 秒一次（本机算）。〔裁：三级；成员看到「创建者关闭了云端 Agent」的气泡、自己的权限变化最多晚 15 秒，Agent 服务那边关开关是当场拒绝的〕
- `src/account/AccountMembersPanel.tsx`：成员名单展开时 3 秒、收着时 15 秒取一次。〔裁：三级；工具栏上「成员：N 人 · Agent：M 个」最多晚 15 秒〕

没改、交回主会话的：

- `server/agent/service/conversation-transports.mjs`（另一位子 Agent 的范围）里 `closed` 这张 Map 把每次读取的 `req`、`res`、`socket` 永远留在内存里（`closed.set(readHandleId, entry)` 从不删），Agent 主服务 966 MB 常驻内存多半来自它；它也是 `consume` 里 `hasClosed` 的依据。建议：只留最近若干条或只留号不留对象。
- 发消息前页面过两次告知确认的往返（`CloudAiPanel.consentForUse` 一次、`useCloudChat.send` 的 `requireCloudConsent` 一次），都是对账号服务的网络请求。乐观气泡已经把这段等待藏起来了，没动；要省一次往返需要定「一次发送只核一次告知」，属于告知流程，留给主会话。

### 1. 进项目后对话权限确认慢

- 根因：`CloudAiPanel.tsx` 的 `metadataReady` 要等本分页自己的一次 `chat.history.refresh()`（列对话）读回来，而且以「项目 + 账号 + 对话号 + 开关」为键，换对话、自动接上、出第一条后都重新等一次；列对话本身 2～7 秒（第 3 条）。
- 改法：对话列表整页一份（`historyStore.ts`），各分页挂上就开始读；面板在这份列表读到过以后就放开输入框（`chat.history.loaded`），换对话时两秒内读过的直接用。列表只决定界面开关，发消息、切权限、停止仍在服务端逐次核对（`product/agent.md` 的权限与隔离不受影响）；创建者只读私有对话照旧按列表里的 `creatorReadOnly` 挡住输入框。
- 本机探针 R1：点项目到能输入 295～561 ms（改前同机 383～645 ms；本机服务端本来就快，差别主要在生产上那 2～7 秒的列对话）。

### 2. 发送卡顿、先进「排队」

- 根因：① 气泡要等服务端的 `user` 事件经事件流回来才画（事件流还要等文档服务读一次），输入框也要等发送成功才清；② 发送前过两次告知确认的往返（见第 3 条「没改」）；③ `POST messages` 5.2 秒（第 3 条）；④ 文档服务把刚收下的消息记成 `queued`，执行服务领走之前页面照搬成「已排队 1 条 · 第 1 条」。
- 改法：
  - `session.ts` 新增 `stage / failStaged / dropStaged`，`send(…, { staged })`：一点发送就在对话里放一条本地气泡，写「发送中…」；云端回 202 后写「已发出，等待云端开始处理…」；服务端那条记录（`cq-<消息号>`）一到就换掉，不叠两条；没发出去（告知没确认、没权限、网络断、页面选区没连上）标「没有发出去：原因」并描红边，原文放回输入框。断流重放时本地气泡补回，换对话清掉。云端收下前只写「发送中…」，没权限的人看不到「已发送」。
  - `CloudAiPanel.handleSend`（账号模式）：先 `stage`、清空输入框，再做告知确认、放素材库、发送。
  - `events.ts` 的 `isIdleHead / markWaitingFromQueue`：对话空闲（没有在跑的一轮）时排第一的消息，在执行服务在问（`info.executorMounted`）时不列进排队列表，只在它的气泡下写「已发出，等待云端开始处理…」；前面有一轮在跑时照旧显示排在第几；执行服务不在问时照旧列出（那时消息真在排着等，原有的探针也按这个断言）。〔裁：二级边上的三级，界面上少了「第 1 条」这一行；`workflow/production.md`「多人同时发言时排队……界面显示排在第几」指的是前面有人在跑，本改动不碰〕
- 本机探针 S1：按回车到气泡出现 8～9 ms，输入框当场清空，气泡写「发送中…」（改前同机 138～168 ms，气泡要等服务端记录）；S2：202 后 142～183 ms 换成服务端那条，只有一条。

### 4. 重开项目不回到上次的对话、从历史点开慢

- 语义：`user-workflow.md`「重新打开项目能接着看、停掉或接着说」，`workflow/production.md` 小字「在云端运行，关闭后继续；重新打开可接着看」。没写「重开时显示哪一个对话」，代码的本意（`useCloud.ts` 记「这一页上次用的对话」）就是回到上次那个，用户预期一致。
- 根因：`useCloud.ts` 记上次对话的本地存储键是 `pc.cloudChat:<账号>:<绑定版本>:<项目>:<页签>`。绑定版本是 `consent.ts` 在页面内存里的计数（进出项目、登录变化各加一），刷新后从头数；建完项目直接进去、或在页面里进出过项目，数到的就和刷新后不一样，键对不上，面板退成新对话。`pc.cloudFresh`、`pc.cloudTitles` 同样。
- 改法：新文件 `src/ai/cloud/persistKeys.ts`，这三个键在账号模式下只按账号编号分；新键没有时找一次旧格式的键（同账号、同项目、同页签，取版本号最大的）。会话、轮询这些内存里的东西仍按绑定版本隔离。从历史点开慢是第 3 条的服务端问题。
- 本机探针 O1（同一页里回项目首页再进一次、发消息、刷新再进）：改前同机复现失败——刷新后对话号从 `cc-mvfjc8v8-838d` 变成 `cc-mvfjc7ya-h88w`，面板只剩示例句（截图 `pc-panel-smooth-base/shots/04-after-reopen.png`）；改后对话号相同、刚发的那条在（`pc-panel-smooth-new/shots/04-after-reopen.png`），刷新后 421 ms 显示出来。
- 对机制文档的更正建议：`mechanism/agent.md`「新对话的空对话」最后一条写的键 `pc.cloudFresh:<账号范围>:<项目>:<页签>`，「账号范围」改成「账号编号」，并补一句「不含页面里的绑定版本，刷新后仍找得到」。文档不在我的文件范围，没改。

### 5. 「Agent 1」删不掉；Agent 1、Agent 3

- 「Agent 1」「Agent 3」是右侧竖栏的 **Agent 分页**（`src/ai/agentTabs.ts`），不是云端对话。「新云端对话 · 默认共有」是 Agent 1 这一页此刻显示的、还没发过消息的云端对话的状态行。
- 删不掉：分页上的 × 由 `RailBar.tsx` 只给非主分页（`closable`），`closeTab` 第一行 `if (id === MAIN_TAB) return;`，注释「主页不能关」。语义里没有这条（查了 `user-workflow.md`「多 Agent」、`workflow/`、`product/agent.md`），是代码的设计。分页里的那个**云端对话**能不能删按 `product/agent.md`「对话的上限与删除」：开对话的人能删，入口在历史列表；但还没发过消息的新对话在服务端不存在，历史列表里没有它，所以无从删起。
- 为什么新项目就是 Agent 1、Agent 3：分页清单存在浏览器本地（`localStorage` 的 `pc.agentTabs`），不分项目，换项目、新建项目都沿用；新分页的名字是「Agent <建的时候的分页数+1>」，以前开过 Agent 2、Agent 3 又关了 Agent 2，就剩 Agent 1、Agent 3。
- 没改代码，待用户定（见末节）。

### 6. 计时停在 0 秒

- 根因：气泡里「第 1/24 轮 · N 秒」照抄服务端最近一条进度的 `elapsedMs`。第一条进度在开始请求模型时就发了（`elapsedMs` 约 1 ms，显示「0 秒」），下一条要等模型回话或 10 秒一次的心跳；云端这一段看到的就是一直「0 秒」。
- 改法：`AgentBubble.tsx` 新增 `LiveProgressMeta`，在跑时每秒刷新：以收到这条进度的时刻为起点在它报的已用时间上往前加，同时按这一轮的开始时间（云端 `run` 事件带的时刻）算一份，取大的（开始时间比现在还晚或超过一天就不用，防两边时钟不准）。本机 Agent 的气泡同样受益。
- 没在浏览器里看到走表：本机隔离夹具没有执行器，消息不会开始跑。只有类型检查与代码审读。

### 主会话补充 1：一轮在第一个事件之前就失败，页面什么都不显示

- `events.ts` 的 `settleFromQueue`：队列项终态是 `failed` / `interrupted`、却找不到 `ca-<runId>` 助手消息时，在那条用户消息后补一条失败的助手消息（号 `ca-<runId>`；没有运行号时 `ca-q-<消息号>`），原因沿用原有 `settledPatch` 的文字（`worker-failed` →「云端执行这一轮的进程出了故障……」，其余「中断」那句）。停止、完成、没有终态、用户消息还没到的不补；用户消息后到时下一次折叠补上；同一份快照折两次不叠第二条。回归测试在 `events.test.mjs`。

### 主会话补充参考（主服务每收一个事件都同步问文档服务、文档服务空闲 30～60%）

- 在我的范围里能确认、能安全改的已改：Agent 主服务本地 10.6 MB 回执账本（每次读取一次整本事务，见第 3 条）；文档服务账本里已收口旧实例的 477 条已关读取（约占 1.78 MB 账本的四分之一）；事件流空闲轮询、续会话、成员名单、列对话的频率。
- 文档服务账本里另外几大块（`runScopeClosuresV1` 157 KB、`runReadRequestsV2` 98 KB、`runRequestsV2` 85 KB、`runControlsV2` 81 KB、`docRunClosuresV2` 77 KB、`runGrantsV2` 75 KB、`agentRegistrationsV2` 66 KB……）和 40 个一直是 `active` 的 `run-worker` 实例行，属于运行授权与 root 登记，文件不在我的范围，没动；它们和「每次重读 root 登记历史（33 代）」「每次核发送者登录」一样没量过。根本办法是账本不再「一行整段 JSON、每次事务整段解析写回」，属于 `server/account/ledger.mjs` 的结构改动，影响所有账本，交主会话定。

## 改动的文件

服务端：`server/agent-service/conversation-control-client.mjs`、`server/agent-service/http.mjs`、`server/account/agent-read-control.mjs`。
页面：`src/ai/cloud/historyStore.ts`（新）、`src/ai/cloud/persistKeys.ts`（新）、`src/ai/cloud/useCloud.ts`、`src/ai/cloud/session.ts`、`src/ai/cloud/events.ts`、`src/ai/types.ts`、`src/editor/right/CloudAiPanel.tsx`、`src/editor/right/chat/AgentBubble.tsx`、`src/editor/right/chat/UserBubble.tsx`、`src/editor/right/chat/QueueList.tsx`、`src/editor/right/chat/chat.css`、`src/editor/sync/syncManager.ts`、`src/account/AccountMembersPanel.tsx`。
测试与探针：`server/test/agent-read-closed-prune.test.mjs`（新）、`server/test/agent-events-idle-poll.test.mjs`（新）、`server/test/agent-read-control.test.mjs`（加一条）、`src/ai/cloud/history-store.test.mjs`（新）、`src/ai/cloud/persist-keys.test.mjs`（新）、`src/ai/cloud/optimistic-send.test.mjs`（新）、`src/ai/cloud/events.test.mjs`（加一条）、`scripts/probes/agent-panel-smooth-probe.mjs`（新）、`server/test/fixtures/account-conversation-controls-user-path.mjs`（端口白名单加 5320～5329 一段，供新探针用）。

### 审查中自己发现并修掉的两处

- 事件流被别人的请求叫醒（`http.mjs` 的 `kickStreams`）时，原先的写法让这次读取记在叫醒它的那个「发消息」请求名下（读取通道按异步上下文认请求），发消息请求一结束就把别人的事件流掐断、对方转「重连中」并清屏。`conversation-delete-probe.mjs` 两次复现（owner 的流在成员发消息后变 `reconnecting`）。改成 `AsyncResource.bind` 绑在流自己的上下文里；回归测试「叫醒的读取记在这条事件流自己的读取通道上」，去掉绑定时这条测试失败（实测读取记到了 `/v1/conversations/c1/messages` 名下）。
- 共用列表的去重：在途那一次可能早于刚才的新建 / 删除，要「新的」时等它回来再读一次（几处共用这一次）；只要「够新」（`maxAgeMs`）时才直接用在途那一次。历史列表里「刚发出第一条、列表还没刷新」先列进去的那条，只认云端已有的消息，本地没发出去的气泡不算（否则满 50 个时被拒的新对话会先出现在历史里，`conversation-delete-probe` 的 `limit-no-history-auto-deleted` 抓到过）。

## 验证

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误（最后一次在提交 `45b0788b` 上跑） |
| 全量测试 | `npm test`（带 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT`、`PROMPTCUT_PASSWORD_ORDER_MODULE`） | 最后一次：7122 项，通过 7107，失败 1，跳过 14。失败的是 `server/test/asset-store-http.test.mjs` 的 H1（`connect ETIMEDOUT 127.0.0.1:1414`，满负载下连本机端口超时，与本分支无关），单独重跑 3 次各 6/6 通过。前两次全量各有 3 项满负载失败（`move-guard`、`user-editing` UE-S7、`prerender-executor` J10b、`cloud-chat` CAU-SES-04 的 3 秒等待），这四个文件合起来单独重跑 3 次，47/47 全过。 |
| 新增与改动处的单测 | `node --test` 下列文件 | `agent-read-closed-prune` 1/1、`agent-events-idle-poll` 4/4、`agent-read-control` 15/15、`history-store` 6/6、`persist-keys` 2/2、`optimistic-send` 4/4、`events` 加的一条在内全过；`cloud-chat`、`account-queue`、`account-page-wire`、`account-read-revocation`、`newchat-absent`、`private-revoked`、`chat-delete`、`account-conversation-controls`、`agent-events-denial`、`cloud-queue-http`、`agent-access-http`、`account-real-runner-sse`、`agent-read-control-transport` 全过 |
| 新探针 | `node scripts/probes/agent-panel-smooth-probe.mjs --dist out/dist-online-new --site-root <VisuHive/site> --out <temp> --base-port 5320` | 17 项全过（`completed:true`）。改前（main `669ba647` 的在线构建与服务端，同一探针）O1 失败：刷新后对话号变了、面板只剩示例句 |
| 原有探针 | `node scripts/probes/conversation-delete-probe.mjs … --base-port 5320` | 改后连跑两次 55/55 全过；main 同机 55/55 |
| 看过的图 | 探针截图 | `%TEMP%/pc-panel-smooth-new/shots/02-right-after-enter.png`（按回车当场出「发送中…」气泡、输入框已空）、`04-after-reopen.png`（刷新后回到刚才的对话，气泡下「已发出，等待云端开始处理…」）；`%TEMP%/pc-panel-smooth-base/shots/04-after-reopen.png`（改前：刷新后是空的新对话） |

探针记录的数字（本机，耗时只记录不作闸门）：

| 项 | main `669ba647` | 本分支 |
|---|---|---|
| 点项目到能输入 | 383～645 ms | 281～561 ms |
| 按回车到气泡出现（页面内） | 138～168 ms（等服务端记录） | 7～10 ms（本地气泡） |
| 空闲 30 秒：列对话 / 续会话 / 成员名单 / 通知 | 10 / 10 / 10 / 2（夹具只有一个分页） | 10 / 1～2 / 2 / 2 |
| 刷新再进项目，回到上次对话 | 失败（同一页里进出过项目之后） | 成功，312～421 ms 显示出来 |

没做的验证：

- 生产节点上的真实耗时没有量（只读诊断，不部署）。主延迟源在节点上那本 10.6 MB 账本，本机夹具里没有这个量，本机数字体现不出生产上 2～7 秒到多少；部署后要在节点上复测列对话、info、发消息的耗时。
- 第 6 条走表、主会话补充 1（一轮在第一个事件前失败）没在浏览器里看：本机夹具没有执行器，消息不会开始跑。只有单测与类型检查。
- `newchat-events-probe.mjs`（固定端口 28850～28861）、`account-conversation-controls-probe.mjs`、`cloud-queue-user-pages-probe.mjs`（固定 6528）端口不在分给我的 5320～5329，没跑。
- 不涉及画面，渲染附加项不适用。

## 部署

需要换的文件（都在节点的 PromptCut 代码目录里，按服务分）：

| 服务 | 文件 | 要不要重启 |
|---|---|---|
| Agent 主服务 `promptcut-agent` | `server/agent-service/conversation-control-client.mjs`、`server/agent-service/http.mjs` | 重启。第一次读取时把 10.6 MB 的 `conversation-read-closures.sqlite` 里旧实例的行一次删掉（一次几百毫秒的事务），之后每次读取的事务只剩几行 |
| 文档服务 `promptcut-doc-v2` | `server/account/agent-read-control.mjs` | 重启。下一个新主服务实例订阅读取控制流时，把已收口旧实例名下的已关读取删掉 |
| 在线前端（`/editor`） | `src/**` 改动：要用 `vite build --mode online` 重建在线构建再换上 | 不涉及服务进程 |

主服务和文档服务改的都是本地账本的修剪与轮询节拍，数据格式没变，旧前端连新服务端、新前端连旧服务端都能用（新前端的乐观气泡、共用列表不依赖服务端改动）。另一位子 Agent 也在改 `server/agent-service/` 里别的文件，部署时按合并后的同一个提交整体换。

回滚：

- 前端：换回上一版在线构建。用户浏览器里新写的本地存储键 `pc.cloudChat:<账号>:<项目>:<页签>` 旧前端不认，回滚后又是「刷新后找不到上次对话」的老样子，不会出错。
- Agent 主服务、文档服务：换回原文件、重启。被删掉的只是「已关、已确认」的读取回执和旧实例的行，旧代码不需要它们（旧代码只在关闭重试、点名时查当前实例的行），回滚后从头再攒。部署前按惯例备份两个账本文件（`/var/lib/promptcut/agent/conversation-read-closures.sqlite`、`/var/lib/promptcut-v2/doc/docservice/account-v2.sqlite`），出问题可整本换回。

## 待用户定

1. **「Agent 1」能不能关。** 现状：右侧竖栏的主分页（Agent 1）代码规定不能关，语义没写。选项：甲、维持不能关（主分页始终在，关了别的总还剩一页）；乙、主分页也能关，关到只剩最后一页时那一页不能关。建议甲，再在主分页的悬停说明里写一句「主分页不能关，可以在历史里删对话」。
2. **分页清单要不要按项目分。** 现状：竖栏的 Agent 分页存在浏览器本地、不分项目，新项目里会带着别的项目里开过的分页，名字按建的时候的分页数编号，会出现「Agent 1、Agent 3」。选项：甲、按项目分（新项目只有 Agent 1）；乙、维持全局，只把新分页的编号改成「现有最大号 + 1」；丙、不动。建议甲，改动在 `src/ai/agentTabs.ts`，影响本机 AI 栏，要先定。
3. **一次发送只核一次告知**（第 3 条「没改」第二项）：省一次到账号服务的往返。需要定的是「点发送时面板核过一次，发送接口里不再重核」是否可以接受。
4. **〔裁〕待审**：第 2 条「执行服务在问时，空闲对话排第一的消息不列进排队列表，只在气泡下写『已发出，等待云端开始处理…』」；第 3 条续会话 15 秒、成员名单收着时 15 秒、事件流空闲时 1 秒读一次文档服务。都按三级办，用户看得到的变化是：发出后不再闪「已排队 第 1 条」，成员人数、创建者关开关的气泡最多晚 15 秒。

## 交回主会话的（不在我的文件范围）

- `server/agent/service/conversation-transports.mjs` 的 `closed` Map 永不清，留着每次读取的请求、响应与套接字（主服务 966 MB 常驻）。
- 文档服务账本整段 JSON 的结构（`server/account/ledger.mjs`）与运行授权各表、40 个一直 `active` 的 `run-worker` 实例行。
- `docs/semantics/mechanism/agent.md` 的 `pc.cloudFresh` 键说明更正（见第 4 条）。
