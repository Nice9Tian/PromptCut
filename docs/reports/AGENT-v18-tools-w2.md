# AGENT 报告:v18-tools-w2(0.7.18 块七·工具包 W2「本人页面反向通道」)

分支 `claude/v18-tools-w2`,基底 main `41aaa2ce`,工作区 `.worktrees/v18-tools-w2`。2026-10-13。

名词:「W2」是 `docs/plan/cloud-agent-tools-implementation.md` 拆包表里的一个工具包,管云端 Agent 要操作「发消息的那个人自己的页面」时用的反向通道(`seek`、`play`、`pause`、`web_handoff`)。「G 包」是同一张表最后的中央接线包,工具表、路由、页面接线都归它;「W1」是云端的网页操作本体;「F0」是已在 main 的公共地基(可信的运行上下文、运行资源登记器、作业表)。「发起人」是文档服务确认的这条消息的发送者,「发起页」是他发这条消息时用的那张页面。

## 1. 做了什么

| 文件 | 内容 |
|---|---|
| `server/agent/service/page-bridge.mjs`(新) | 反向通道本体 `createPageBridge`:共用入口 `requestPage({ run, initiatorAccountId, pageId, tool, args, requestId, deadline })`;事件流挂上与摘下 `attach`;页面交回 `acceptResult`;这一轮结束时收掉 `cancelRun`;查状态 `status`;`close`。请求记录落 SQLite。另有 `seek`/`play`/`pause` 的工具提供方 `createPageControlTools`(形状同别的工具包:`handles` / `call(name, args, context)` / `close(reason)`),以及可替换的「这一轮的权威信息」口子 `createRunPageAuthority` |
| `server/agent/service/hosted-handoff.mjs`(新) | `web_handoff` 的工具提供方 `createHandoffTools`。依赖 W1 的那一半只定了接口(`browser.handoffTarget(context)`),测试里是假实现 |
| `src/ai/cloud/pageRequests.ts`(改,只追加) | 账号模式的页面执行器 `createAccountPageRequests` 与白名单 `ACCOUNT_PAGE_REQUEST_TOOLS`。旧通道的 `runPageRequest`、`CLOUD_PAGE_REQUEST_TOOLS` 一个字没动(本地与局域网照旧) |
| `src/ai/cloud/page-requests.test.mjs`(改,只追加) | 新增 CAU-ACC-01～07 七条 |
| `server/test/cloud-tools-w2-fixture.mjs`、`cloud-tools-w2-bridge.test.mjs`(新) | 夹具与 20 条单测 |
| `scripts/probes/cloud-tools-w2-probe.mjs`(新) | 真浏览器探针(无头),7 条 |
| `docs/reports/assets/v18-tools-w2/`(新) | 探针截图 8 张 |

中央文件一个都没碰(`cloud-tools.mjs`、`hosted-tools.mjs`、`instance.mjs`、`create-agent-service.mjs`、`server/agent-service/*`、`account-runner.mjs`、`account-executor-assembly.mjs`、`src/ai/cloud/{useCloud,session,cloudApi}.ts`)。所以**产品里现在还用不上**:账号模式下这四个工具仍然回「发起方不在线」,要等 G 包接线。

## 2. 怎么绑的

**发起人、发起页从哪来。** 文档服务收消息时,页面只报一个「在场页面号」(页面连文档服务时自己起的随机号,`src/editor/sync/selectionPresence.ts`),文档服务核过「这张页面此刻连着、属于这次登录」才把它记进消息(`server/docservice/modules/selection.mjs` 的 `captureSnapshot`);这一轮的运行授权里带着它(`runGrant.selectionSnapshot.pageId`)和发送者账号(`runGrant.accountId`)。反向通道只认这两样。`requestPage` 的 `initiatorAccountId`、`pageId` 两个参数是调用方的断言,与授权对不上回 `page-binding-mismatch`,不能用来挑页面;模型的工具参数里多带任何字段都被拒;页面交回的请求体指定不了页面。

**「现在确实在线」要两样同时成立。** 文档服务的在场表里这张页面此刻连着(用全员选区那条查询);并且这张页面有一条到 Agent 服务的事件流挂在这个对话上(账号是 HTTP 层核过委托票据的)。请求只写给那一条流,带一个只出现在那条流上的一次性随机数,不带 `seq`、不进事件记录。同账号的别的页面(页面号不同)、别的成员的页面(账号不同)都收不到;别的成员向 Agent 服务谎报发起人的页面号也收不到。

**不在线怎么回。** 发起页离开了文档服务:立刻回,不等。文档服务说在、事件流还没挂上:最多等 3 秒。发出后 15 秒没交回、等的中途那条流断了、这一轮结束:都回 `initiatorOffline`(`cloud-tools.mjs` 里现成的那句话),Agent 据此继续。两个时限的数字沿用旧通道。

**交回时重核。** 交的人是发起人且此刻仍读得到这个对话;对话的权限版本和发请求时一样;页面号与一次性随机数对得上;这一轮的授权仍是当前的、仍是「发起人本人有效」(不是被踢或退出登录后按例外保留的)、栅栏版本没换过;没过时限;请求还在等。任何一样不对都拒收,等待的工具按不在线收掉,页面交来的内容不当结果用(`seek` 做成后通知宿主改播放头的回调不会被调)。同一份结果重复交回回 `{ ok: true, duplicate: true }`,内容不同回 409。

**状态落盘。** 每次请求在 `page_requests` 表里有一行:`pending`、`answered`、`offline`、`expired`、`cancelled`、`interrupted`、`rejected`。重启时还在等的标成 `interrupted`(原因 `agent-restart`);之后 `status` 查得到,发起页这时才交回会得到 410 `page-request-interrupted`,同一个请求号再调回中断、不重新发给页面。库里只存随机数的哈希,日志里没有随机数和页面号。

**`web_handoff`。** 语义(`docs/semantics/product/agent.md`「工具范围」)写的是它只作用于发起人自己的页面与本机界面。本包做的是:向 W1 的云端浏览器要「这个对话此刻开着的网页地址」,经反向通道让发起页用它本机同一份 `web_handoff` 把本机的浏览器交给本人,并把地址带过去;云端只拿回「交没交出去」。模型不能指定地址;不是公开网页地址(`file:`、带口令的)不往用户电脑上带;发起人用的是网页版(没有本机浏览器)时页面回 `unsupported`,工具如实说做不了。

## 3. 验证结果

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0,零错误 |
| 全量测试 | `npm test`(设了那两个环境变量) | 见文末「最终基线」 |
| W2 单测 | `npm test -- server/test/cloud-tools-w2-bridge.test.mjs src/ai/cloud/page-requests.test.mjs` | 33 项全过(服务端 20,页面 13 其中新增 7) |
| 无窗口守门 | `npm test -- server/test/windows-hide-silent-spawn.test.mjs` | 4 项全过 |
| 真浏览器探针 | `node scripts/probes/cloud-tools-w2-probe.mjs` | 退出码 0,7 条全过;连跑三次都过(第一次的截图被开机遮罩挡住,改成等遮罩收掉后重跑) |

**单测逐条对应验收。**

| 验收点 | 测试 |
|---|---|
| 绑定:请求只到发起页;同账号另一页、别的成员、谎报页面号的都收不到 | W2-BIND 第一条 |
| 调用方、模型都指定不了页面;伪造的运行上下文被拒;什么都没发、没留记录 | W2-BIND 第二条 |
| 发起页离开文档服务:立刻不在线,同账号另一页不顶替;在场表取不到同样按不在线 | W2-OFF 第一条 |
| 事件流没挂上:等一小会儿再回不在线;及时挂上就照常 | W2-OFF 第二条 |
| 等的中途断了:立刻不在线,之后交回被拒;重连后照常 | W2-OFF 第三条 |
| 晚到被拒:超时 | W2-LATE timeout |
| 晚到被拒:这一轮结束或被宿主取消 | W2-LATE run ended |
| 晚到被拒:用户点了停止(文档服务的停止栅栏) | W2-LATE stopped |
| 晚到被拒:对话转私有(别的成员发起的那一轮被撤销) | W2-LATE private(member) |
| 晚到被拒:主人把自己在跑的对话转私有(这一轮保留,正在途中的那一次拒收,之后恢复) | W2-LATE private(owner) |
| 晚到被拒:发起人被踢出;保留着跑的那一轮之后一律回不在线 | W2-LATE kicked |
| 晚到被拒:发起人退出登录;核对身份的上游不可达 | W2-LATE logged out |
| 重复交回幂等;同号不同内容冲突;同一请求号不让页面执行两次 | W2-DUP |
| 伪造的页面号、请求号、随机数、别的成员、别的对话、别的项目:同一个 410,且不影响在等的那一次;超大结果 413 | W2-FORGE |
| 重启后的状态 | W2-RESTART |
| 关闭时全部收掉 | W2 close() |
| 权威信息的口子可替换,答得不对一律拒 | W2 run authority seam |
| `web_handoff` | W2-HANDOFF |
| `get_selection` 不走这条通道 | W2-SEL、CAU-ACC-01、CAU-ACC-05 |

夹具里真的:SQLite 账本上的运行授权(`run-authority.mjs`)、对话权限的判定(`conversation-authority.mjs` 的同一个函数)、文档服务的在场模块、运行资源登记器、请求记录的 SQLite 文件。不是真的:页面到文档服务的连接(直接调在场模块的接入函数,没有 WebSocket)、页面到 Agent 服务的 HTTP(直接调 `attach` / `acceptResult`);这两样在探针里是真的。

**探针的关键行**(第三次运行):

```
P1 三张真的编辑器页面各自连上文档服务的在场表、挂上到 Agent 服务的事件流  ok  streams 3
P2 发消息时的页面号由文档服务核过才记进消息;别的成员报发起人的页面号发不出消息  ok  otherMemberClaimingTabA: selection-page-unavailable
P3 Agent 调 seek:只有发起页的播放头真的变了  ok  target 10, seekResult {ok:true}, seekMs 32,
   before A/B/C = 0/0/0;after A = {t:10, received 1, posted [200]},B = {t:0, received 0, posted []},C = {t:0, received 0, posted []}
P4 别的成员拿着发起页的请求号与页面号交结果:410 page-request-gone;发起页那一次照常做成  ok
P5 play / pause:发起页开始播、停下;另两张页面没在播、播放头不动  ok
P6 发起页关掉后再请求:{ok:false, initiatorOffline:true, error:"发起方不在线,seek 要用到他的播放头。请按项目内容继续,不要等待。"},17～19 毫秒;B、C 不动  ok
P7 收尾:探针起的浏览器、编辑器都按进程号结束,端口放回  ok
{"summary":true,"total":7,"passed":7,"failed":[]}
```

**看过的图**(`docs/reports/assets/v18-tools-w2/`):`w2-02-A-after-seek.png` 发起页的时间码是「10.00 / 20.00 s」,预览下方的进度点在正中,时间轴上的播放头标签移走了;`w2-02-B-after-seek.png`(发起人的另一张页面)和 `w2-02-C-after-seek.png`(另一个成员)仍是「0.00 / 20.00 s」,播放头标签「0:00.0」在最左。跑探针前后各查了一次可见窗口,都是空的;28420～28459 没有留下监听。

**探针里哪些不是产品接线**(中央文件不许改,所以探针自己搭,不冒充):页面里「连文档服务报在场、开事件流、把请求交给执行器、交回结果」这一段是探针注入的一小段脚本,替的是 `useCloud.ts` / `session.ts`;Agent 服务一侧的两条路由是探针自己的测试服务器挂的,替的是 `server/agent-service/http.mjs`;页面的身份是探针专用的请求头(测试服务器只认探针给的三个账号),没有走账号登录与委托票据。真的部分:页面是本工作区 dev server 的真编辑器,播放头读的是编辑器自己的 store,执行请求的是 `pageRequests.ts` 的 `createAccountPageRequests` 加 `src/mcp/handlers/playback.ts` 那份本机实现,在场页面号是 `selectionPresence.ts` 自己起、经真的 WebSocket 报给真的在场模块,服务一侧是 `page-bridge.mjs` 加真的运行授权。P4 那一次冒充发生在发起页已经交回之后(发起页答得太快);「还在等的时候被人乱交不受影响」由单测 W2-FORGE 逐条验。

## 4. `get_selection` 核对(任务第 6 条)

现状没有问题,本包又加了一道。

- 服务端:`instance.mjs` 第 564 行,账号模式的 `get_selection` 直接走 `hostedAccountSelection`(向文档服务发 `selection.query`,回全员选区),不进 `hostedPageTool`,也就到不了旧的单人快照退路 `hostedPageRead`(该函数的注释也写了账号模式不会来)。发起人不在线时回的是文档服务自己保存的、发消息时核过的那一份,并标「发消息时的选区,非实时」——这是用户定的行为,不是页面的旧快照。
- `account-runner.mjs` 起一轮时仍把 `pageState: { selection: 发消息时的 clipIds }` 传给实例。账号模式下读它的只有 `hostedPageRead`(走不到)和切剪辑三个工具要的播放头;所以它现在不会被当成选区答出去。建议 G 包接线时顺手确认这一点仍然成立。
- 本包加的一道:反向通道的工具表(`PAGE_BRIDGE_TOOLS`)和页面的账号模式白名单(`ACCOUNT_PAGE_REQUEST_TOOLS`)里都没有 `get_selection`,服务端发不出、页面收到也拒绝(CAU-ACC-01 里特意给执行器装了一个 `getSelection`,断言它没被调)。旧通道的白名单仍有它(本地与局域网不变)。

## 5. G 包接线时要填什么

### 5.0 先定一件事:反向通道放在哪个进程

账号模式的生产形态是「一条任务一个工作进程」(`account-task-worker.mjs`):跑这一轮、持有这一轮授权登记的是工作进程;接着页面事件流和交回请求的是主服务。`requestPage` 的调用方在工作进程,`attach` / `acceptResult` 的调用方在主服务,两边不在一个进程里,**现有代码里没有主服务到工作进程的通道**(工作进程到主服务有一条带签名的 `POST /internal/v2/worker/events/append`,单向)。本包的单测与探针都是一个进程里跑的,没有覆盖这一段。两种接法:

- **甲(建议):反向通道放在主服务。** 仿照 `worker-event-internal.mjs` 加一条工作进程到主服务的内部请求(同一套签名与文档服务核对),请求体是 `{ context, initiatorAccountId, pageId, tool, args, requestId, deadline }`,主服务调 `bridge.requestPage` 后把结果作为响应回给工作进程(最长 60 秒,`maxPageMs`)。主服务没有这一轮的授权登记,所以建桥时不给 `resources` / `runClient`,改给 `runAuthority`:它的 `current(context)` 要回 `{ accountId, pageId, fenceRevision, grantState }`,来源必须是文档服务对这个工作进程、这一轮的当前核对(`workerEventSource` 那一类核对里已有 `senderAccountId` 等绑定;页面号取文档服务里这条消息的 `selectionSnapshot.pageId`),不能取请求体里自报的。工作进程收到 `delivered: true` 后,自己再用 `createRunPageAuthority({ resources, runClient }).current(context)` 核一遍栅栏版本、`grantState === 'active'`、页面号没变,不一致按不在线处理。
- **乙:反向通道放在工作进程。** 那就要新做主服务到工作进程的通道,转发「流挂上/摘下」「页面交回」,并把 `page.request` 从工作进程送到主服务的那一条流而不进事件记录。改动更大。

非单任务的老路径(`createAccountRunManager` 不带 `task`)是同一个进程,直接用缺省的 `resources` + `runClient` 即可。

### 5.1 服务一侧

1. **建桥**(主服务装配处,`hosted-wiring.mjs` / `main.mjs`):`createPageBridge({ databasePath: <数据目录>/page-requests.sqlite, runAuthority 或 resources+runClient, presence, checkSubmitter, log })`。
   - `presence(context)`:回文档服务 `selection.query` 的答案(`{ members: [{ accountId, isInitiator, pages: [{ pageId, live }] }] }`)。现成的发法在 `instance.mjs` 的 `hostedAccountSelection`(经这一轮的数据连接);取不到就抛错,桥按不在线办。
   - `checkSubmitter(identity, conversationId)`:就是 `service.access(identity, conversationId, 'read')`,要回 `{ allowed: true, aclRevision }`。
2. **事件流**(`server/agent-service/http.mjs` 的 `accountEvents`):查询串加 `page=<在场页面号>`;写完响应头后 `const attachment = bridge.attach({ identity: { accountId, projectId }, conversationId, pageId, aclRevision: view.aclRevision, send: ev => res.write('data: ' + JSON.stringify(ev) + '\n\n') })`(页面号不合格回 `null`,那条流只是看);`release` 里 `attachment?.detach()`;轮询里发现 `view.aclRevision` 变了且 `access.allowed` 仍为真时 `attachment.update({ aclRevision })`。`send` 写的事件不带 `seq`,不要经 `runEvents`。
3. **交回**(同文件 `accountRoute` 的 `page-results` 分支,现在是直接抛 503):读请求体(上限 256 KiB 即可,桥自己再卡 64 KiB),`sendJson(res, 200, await bridge.acceptResult({ identity: { accountId, projectId }, conversationId, body }))`;`PageBridgeError` 的 `status` / `code` 原样回(400、409、410、413、503)。请求体形状 `{ v: 2, id, nonce, pageId, runId?, ok, result?, error?, code? }`,多带字段回 400。`conversation-policy.mjs` 的 `pageResult` 相应改掉。
4. **工具路由**(`instance.mjs` 第 564～565 行附近):账号模式下 `seek`/`play`/`pause` 交给 `createPageControlTools({ bridge, onPlayhead })`,`web_handoff` 交给 `createHandoffTools({ bridge, browser })`,调用形如 `provider.call(tool, args, context, { requestId, signal })`。`context` 是这一轮的 ToolRunContext(`account-runner.mjs` 里 `resources.contextFor(...)` 得到的 `entry.context`,现在没有传给 `runnerFactory`,要加)。`requestId` 建议用这次工具调用的 `callId` 派生(形状 `^[A-Za-z0-9_-]{8,64}$`),宿主重试同一次调用时页面不会执行两次。`onPlayhead(context, t)` 里把 `hostedPageStates` 记着的播放头改成 `t`(旧通道 `hostedPageTool` 里的那两行)。`account-runner.mjs` 里写死的 `initiatorOnline: () => false`、`pageCall: async () => ({ offline: true })` 相应换掉。
5. **收尾**:一轮结束(`drain`)和控制通道叫停(`drainControl`)时调 `bridge.cancelRun({ projectId, conversationId, runId }, 原因)`;Agent 服务关闭时 `bridge.close(原因)`。
6. **工具表**(`cloud-tools.mjs`):`web_handoff` 那一行的 `online` 说明是旧话(「云端的网页操作还没接上」),W1 与本包都接上后改成经反向通道;`seek`/`play`/`pause` 的 `page: true` 不变。系统提示词里「网页接管……在云端做不了」那半句同步改。

### 5.2 页面一侧

1. **`session.ts`**:账号模式下,事件流里 `type === 'page.request' && v === 2` 的事件交给新的执行器;交回时请求体就是执行器的答案**原样**(现在第 104 行是 `{ ...answer, pageId }`,会把页面号换成旧通道的 `pg-…`,账号模式不能换);开事件流时报的 `page` 改成在场页面号(`selectionPresenceStatus().pageId`),它是连上文档服务之后才有的,所以要每次现取,不能在建会话时定死;页面号变了(重连文档服务)要重开事件流。
2. **`useCloud.ts`**:`cloud.accountMode` 时用 `createAccountPageRequests({ pageId: () => selectionPresenceStatus().pageId, exec })`,`exec` 是 `{ seek, play, pause, begin: beginAgentTool, end: endAgentTool }`,桌面版另给 `webHandoff`(见下);不给 `getSelection`。接上后把 `page-requests.test.mjs` 的 CAU-ACC-07 放行名单加上 `ai/cloud/useCloud.ts`。
3. **`cloudApi.ts`**:`pageResult` 的请求体类型放宽到新形状;`events` 的页面号参数不用改。
4. **`webHandoff` 钩子**(桌面版):参数 `{ reason?, hide?, url? }`。本机现成的做法是 `mcpExecutor.ts` 的 `web_handoff` 分支(`webHandoff(args)`,壳模式下点亮「浏览器」页签);带了 `url` 时要先让本机的 Agent 浏览器打开它(`webOpen({ url })`)再交出。这一步改不改界面、怎么显示,见第 9 节。

### 5.3 W1 那一半

`hosted-handoff.mjs` 只用 W1 一个口子:`browser.handoffTarget(context) -> Promise<{ url } | null>`,回这个对话(项目 × 对话)的云端浏览器当前页的地址,没有开着的页回 `null`。W1 的 `hosted-browser.mjs` 提供这个函数后,G 包把它传给 `createHandoffTools({ bridge, browser })`。没传时 `web_handoff` 回 `cloudUnavailable`(「云端的网页操作还没接上」),不会假装交出去了。

## 6. 没做成的与原因

- **产品里的端到端没有**:中央接线归 G 包。真模型、账号登录、委托票据、mTLS 下的文档服务与素材服务,都没有在这一包里走。计划第 84 行要求的「真实 doc/asset mTLS」本包没有:运行授权是真的账本和真的判定,但传输是进程内调用。
- **工作进程与主服务跨进程的那一段没有做也没有测**(第 5.0 节)。
- **`web_handoff` 到本机浏览器的那一步没有真跑**:页面一侧只做到调用宿主给的 `webHandoff` 钩子(单测用假钩子);桌面版的真钩子、云端浏览器的真地址都要等接线与 W1。
- **Linux 没验**。本包没有子进程,只用 `node:sqlite`,风险小,但确实没跑。
- **没有用作业表(`tool-jobs.mjs`)**,见第 7 节〔裁 1〕。

## 7. 我做的裁定(〔裁〕,都是三级,用户看不出区别;第 3 条有一点二级的味道,已单列到第 9 节)

1. 〔裁 1〕请求记录用反向通道自己的一张表,不用 F0 的作业表。原因:作业表存不了页面号与随机数的哈希;更要紧的是它每次读写都要一个运行上下文,而重启之后页面交回时这一轮已经没有上下文了(「执行已开始」的任务重启后不重放),查不了。
2. 〔裁 2〕「在线」要文档服务在场表与事件流两样都成立;在场表取不到按不在线办(不猜)。
3. 〔裁 3〕对话的主人把自己正在跑的对话转成私有时,正在途中的那一次页面请求拒收(工具得到「发起方不在线」),之后的请求恢复正常。任务书写的是「对话转私有之后才到的结果一律拒收」,我照字面做了;这一轮本身按既有规则是保留的。
4. 〔裁 4〕发起人被踢出或退出登录后,按「已读共有任务」例外保留着跑的那一轮,页面工具一律回不在线(授权状态是 `retained` 就不再找他的页面)。
5. 〔裁 5〕不是发起页的人来交(账号、页面号、随机数任何一样不对)一律同一个 410 `page-request-gone`,不说是哪样;确是发起页但收不下的,回带状态的 410(`page-request-expired` 等),方便排障。
6. 〔裁 6〕同一张页面重连(账号与页面号相同的新流)顶掉旧流,发在旧流上还没交回的按断开收掉。
7. 〔裁 7〕`web_handoff` 把云端浏览器当前页的地址带给发起页,模型不能指定地址;页面本机实现回的窗口细节不带回云端。这是沿着 `three-versions-018-design.md` 第 258 行那条〔裁〕(ChatGPT 做的,用户还没审)往下做的最小接法。
8. 〔裁 8〕两个时限(15 秒、3 秒)、结果上限 64 KiB、记录保留 7 天:前三个沿用旧通道,保留期是我定的。

## 8. 要主会话决定或注意的事

1. **第 5.0 节的进程问题**要在派 G 包之前定,它决定 G 包要不要新做一条内部请求。C1(采集代下)同样受它影响。
2. **页面号对同账号的别的页签不是秘密**:`get_selection` 的答案里有每张页面的页面号,共有对话里人人看得到。别的成员冒用被账号挡住(测过);但发起人自己的另一个页签如果故意向 Agent 服务谎报发起页的页面号,会把请求抢到自己这里(它本来就是同一个人、同一次登录能做的事,文档服务的在场模块也挡不住它另起一条连接报同一个号)。正常页面不会这样做。要彻底堵住得让文档服务在发消息时多记一样只有那张页面知道的东西,那要改文档服务,不在本包范围。
3. **C1 要用的可信返回协议就是这一份**:请求 `page.request { v: 2, id, nonce, runId, pageId, tool, args, timeoutMs }`,交回 `{ v: 2, id, nonce, pageId, runId?, ok, result?, error?, code? }`。C1 加工具只需要在 `PAGE_BRIDGE_TOOLS`、`checkedPageArgs` 和页面白名单各加一项;结果上限 64 KiB 对「只回一个素材引用」够用。
4. `page-requests.test.mjs` 的 CAU-ACC-07 现在断言 `src/` 里没有别处引用新执行器,G 包接线时要把放行名单加上接线的那个文件。
5. 全量测试里被跳过的 8 项不是本包的(本包没有带跳过条件的测试)。

## 9. 要用户定的事

1. **`web_handoff` 在云端到底做成什么样。** 背景:本机的 `web_handoff` 是把 Agent 用的浏览器窗口交给用户去登录、过验证码。云端的浏览器在节点上,没有窗口可交,登录信息也不许上节点。现在照 ChatGPT 留下的那条裁定做成:让发起人**自己电脑上**的 Agent 浏览器打开同一个网址,由他在本机处理。后果:他在本机登录了,云端那个浏览器**并没有登录**,云端 Agent 接下来看到的还是没登录的页面;这个工具在云端的实际用处因此很有限(主要是配合「由发起人电脑代下」的素材采集)。选项:(甲)照现在这样,并在给模型的话里说明「登录只留在他的电脑上」;(乙)云端先不开放 `web_handoff`,遇到登录墙直接告诉用户到电脑上做;(丙)做远程画面把云端浏览器给用户操作(登录信息会上节点,与既定原则冲突,不建议)。我的建议是甲与 C1 一起上,在那之前按乙。
2. **`web_handoff` 给模型看的几句话**(不是界面文字,但模型会照着转述给用户)。草稿在 `hosted-handoff.mjs` 的 `HANDOFF_TEXT`,可整体替换:
   - 交出去了:「已经请发起人在他自己的电脑上处理(原因)。登录信息只留在他的电脑上,云端拿不到。现在停下来,用中文告诉用户要做什么、做完了怎么说。**不要继续调工具**,等用户回话之后再 web_view 看当前状态。」
   - 收回了:「发起人电脑上的浏览器已经收回。」
   - 云端浏览器没开网页:「云端的浏览器还没有打开网页,没有可以交给用户的页面。先用 web_open 打开要处理的网页。」
   - 发起人用的是网页版:「发起人现在用的是网页版,没有可以交给他的本机浏览器。请告诉用户到电脑上的 PromptCut 里处理这一步,或者换一个不需要登录的做法。」
   - 云端网页操作没接上:「云端的网页操作还没接上,web_handoff 现在用不了。请按项目内容继续,需要的话告诉用户自己在电脑上的 PromptCut 里做这一步。」
3. **界面上要不要新增文字。** 本包没有新增任何界面文字:桌面版收到交接后沿用本机现成的「浏览器」页签闪烁与气泡。如果希望用户看得出「这是云端 Agent 请你处理的」,那是新的界面文字,要用户给原文。
4. **〔裁 3〕要不要放宽。** 背景:对话的主人在自己的任务跑到一半时把对话转成私有,任务按规则继续;此刻正好在途的一次播放头操作会被拒(Agent 得到一次「发起方不在线」),之后恢复。选项:保持(照任务书字面,最稳),或放宽成「主人自己转私有不影响他自己的页面请求」。影响很小,我的建议是保持。

## 10. 对任务书或语义的更正建议

- `docs/plan/cloud-agent-contract.md` 第 28 节写的是旧通道(页面号 `pg-…` 由请求体自报、判定按 `userId`)。账号模式的新形状(第 2 节与第 8 节第 3 条)建议在 G 包接线时追加一小节,并写明旧通道只用于本地与局域网。
- `docs/semantics/mechanism/agent.md` 里反向通道那一条同样只写了旧形状,接线后补「账号模式下发起页取自文档服务记在消息上的在场页面号、交回时重核授权、请求状态落盘」。
- `docs/plan/cloud-agent-tools-implementation.md` W2 行写「页面 POST 结果重核……revision/nonce」,本包两样都用了(栅栏版本与对话权限版本,加一次性随机数),可以把「/」改成「与」。该行没有提工作进程与主服务不在同一进程这件事,建议补一句(第 5.0 节)。
- `cloud-tools.mjs` 里 `web_handoff` 的 `online` 说明与系统提示词里「网页接管……在云端做不了」是旧话,接线时改(第 5.1 节第 6 条)。

## 最终基线

(交活前在最终提交上跑一遍后填写。)
