# AGENT 报告：v18-tools-c1（0.7.18 块七·工具包 C1「本机采集代下」）

分支 `claude/v18-tools-c1`，基底 main `d284f9fc`，工作区 `.worktrees/v18-tools-c1`。2026-10-13。

名词：「C1」是 `docs/plan/cloud-agent-tools-implementation.md` 拆包表里的一个工具包，管云端 Agent 的 `collect_download` 在要登录的站点上委托发起人自己的电脑代为下载。「W2」是同一张表里的「本人页面反向通道」包（已在 main），C1 用它的可信返回协议。「F0」是已在 main 的公共地基（可信的运行上下文、运行资源登记器、「项目素材」）。「G 包」是最后的中央接线包，工具表、路由、页面接线都归它。「发起人」是文档服务确认的这条消息的发送者，「发起页」是他发这条消息时用的那张页面。「回执」是发起人的电脑传完文件后交给云端的那一小份说明。

## 1. 做了什么

| 文件 | 内容 |
|---|---|
| `server/agent/service/collect-bridge.mjs`（新） | 云端一侧：`createCollectBridge`（发起委托、隔一会儿问进度、收回执、向素材服务核实、登记、退回匿名的原因、取消、重启后的状态）；`collectPageTools()`（加在反向通道上的五种请求各自的参数检查与答案白名单）；给模型看的话 `COLLECT_BRIDGE_TEXT`；委托记录落 SQLite |
| `src/ai/cloud/collectBridge.ts`（新） | 页面一侧：`createCollectBridgePage`，收到请求后调本机采集、交给本机上传队列、等素材服务里齐了再交回执；网页版（没有本机采集）如实回 `unsupported` |
| `server/agent/service/hosted-collect.mjs`（改） | `collect_download` 分流：宿主给了委托口子就先问它，委托成了作业做完（`route: 'delegated'`），没成接着云端匿名（`route: 'anonymous'`，原因写进 `notes`）；新增 `collect_login`、`collect_login_check` 两个工具的实现。不给委托口子时行为与原来一样（原有的 `cloud-agent-collect.test.mjs` 7 条全过） |
| `server/agent/service/page-bridge.mjs`（改，只加） | `createPageBridge` 多一个可选参数 `extraTools`；返回值多一个 `extraTools`（名字列表）。见第 2.5 节 |
| `server/test/cloud-tools-c1-fixture.mjs`、`cloud-tools-c1-bridge.test.mjs`、`cloud-tools-c1-page.test.mjs`（新） | 夹具与 22 条单测 |
| `scripts/probes/cloud-tools-c1-probe.mjs`、`cloud-tools-c1-site.mjs`（新） | 真东西探针与「要登录才给高画质」的假站 |
| `docs/reports/assets/v18-tools-c1/probe-output.jsonl` | 探针最后一次运行的原始输出 |

中央文件一个都没碰（`cloud-tools.mjs`、`hosted-tools.mjs`、`instance.mjs`、`server/agent-service/` 下的、`account-runner.mjs`、`src/ai/cloud/{useCloud,session,cloudApi}.ts`）；桌面一侧的 `server/vite-plugin-collect.ts`、`src/ai/collectLoginStore.ts` 也没改（现成的接口够用）。所以**产品里现在还用不上**，要等 G 包接线（第 5 节）。没有新增依赖，没有新增界面文字。

## 2. 怎么做的

### 2.1 一次委托的全过程

1. 模型调 `collect_download`。云端先看这条链接属不属于「有登录支持的站点」（`server/collect-cookies.mjs` 的站点表，现在只有哔哩哔哩）。不属于：照旧云端匿名下载，不打扰任何人。
2. 属于：经反向通道向发起页发 `collect_delegate_start`。发起人与发起页只从文档服务确认过的运行授权里取（W2 原来的规矩），模型、工具参数都指定不了页面。
3. 发起页（桌面版）查本机：采集就绪吗、这个站点有没有没过期的登录态、项目对不对、是不是正忙。都行就调本机现成的 `/api/collect/download`（带本机的登录态）并回「接了」；不行回原因的代号。网页版没有本机采集，回 `unsupported`。
4. 云端每 2 秒发一次 `collect_delegate_poll`。本机下载完，页面把文件按哈希交给本机的上传队列，由编辑器进程用账号会话签发的素材票据**直接**传进这个项目的素材服务；页面等素材服务里这份字节齐了，在下一次 poll 的答案里交回执 `{ requestId, jobId, assetRef: { projectId, hash, size }, result: { items, cookiesUsed } }`。
5. 回执是一次页面请求的答案，交回时反向通道照原样重核：交的人是发起人且此刻读得到这个对话、对话权限版本没变、这一轮授权仍是当前的且「发起人本人有效」、栅栏版本没换、页面号与一次性随机数对得上、没过时限。
6. 云端拿到回执后：核回执里的请求号、作业号、项目就是这一次委托的 → 向文档服务核这一轮此刻能写 → 向素材服务核「这份字节在这个项目的素材库里，哈希与大小对得上」（F0 的 `verifyRef`）→ 再核一次能写 → 交给宿主登记进项目（宿主带期望版本提交；同一个登记请求号不登记两次）。
7. 任何一步不成，回「没委托成」加原因，`hosted-collect.mjs` 接着在云端匿名下载，作业的 `notes` 里写一句原因加「画质可能低于登录后的」。这一轮自己已经不能写了（被停止、被撤销）就不再匿名下载，作业直接记失败。

### 2.2 为什么是「开始、轮询、取消」三种短请求

一次下载可能几分钟，而反向通道一次请求最多等 60 秒（`maxPageMs`），等的中途页面的事件流断了就按不在线收掉。所以拆成短请求，每一次都是独立的、完整重核过的。页面中途断线重连（页面号不变）不影响，20 秒宽限内接着问；超过就退回匿名。整次委托最多 15 分钟（与云端匿名下载的墙钟上限同一个数）。

### 2.3 云端拿不到什么

- 页面交回的答案由 `collectBridge.ts` 逐字段拼出来：本机接口回的 `path`、`userId`、`message`、`stderrTail` 等一概不带；没做成只回代号；文件名只取最后一段。登录态文件的路径只从本机一个接口（查登录态）交到本机另一个接口（下载），不出这台电脑。
- 云端再收一遍：`collectPageTools()` 给每种请求一份答案白名单，多带任何字段**整份拒收**（反向通道回 422，页面交来的那一份不落盘），页面写的出错原因那句话也不留（里面可能有路径）。
- 委托记录里只有：委托号、作业号、项目、对话、这一轮、发起人账号、站点代号、链接的摘要、状态、原因代号、回执摘要、哈希与大小、登记出来的素材号。日志只有事件名、项目、这一轮、状态、原因代号。
- `collect_login`、`collect_login_check` 云端只拿回「开没开」「是不是已经登录」「登没登」「是不是过期了」四个真假值。

### 2.4 对话转私有、被停止、被踢出之后才到的回执

都不登记。两道闸：反向通道交回时就拒收（W2 的重核）；万一过了这一道，云端登记前还要向文档服务核这一轮能不能写。

**已经传上去的字节**：留在这个项目的素材库里，没有任何登记引用它。成员在项目里看不到它；云端任务按「项目里登记的素材」读，也读不到它；别的项目的票据在素材服务上取不到（探针 R3b 验了）。云端没有删素材的权限（任务书把删除权限列为待确认），所以不删。委托记录里留着这份字节的哈希与大小（`state: rejected`，`refs`），以后做清理时找得到。同样的字节以后再被正常登记时可以直接复用（内容寻址）。

### 2.5 对 `page-bridge.mjs` 的扩展（只加不改）

`createPageBridge({ …, extraTools })`：`{ 工具名: { args(宿主给的参数) => 发给页面的参数, answer?(页面交回的答案) => 留下的答案 } }`。名字不能与 `PAGE_BRIDGE_TOOLS` 重（重了建桥时就报配置错）；`answer` 抛错时这一次按拒收办。发起人与发起页的绑定、交回时的重核、落盘、幂等全是原来那一套，一行没改。`PAGE_BRIDGE_TOOLS` 没动，所以 W2 的对账测试（CAU-ACC-05）不受影响。W2 的 20 条单测与页面 13 条全过。

## 3. 验证结果

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误 |
| C1 单测 | `npm test -- server/test/cloud-tools-c1-bridge.test.mjs server/test/cloud-tools-c1-page.test.mjs` | 22 项全过（云端 16、页面 6）；改完时限后连跑三次都过 |
| 相关的旧测试 | 同一条命令加 `cloud-tools-w2-bridge`、`src/ai/cloud/page-requests`、`cloud-agent-collect`、`windows-hide-silent-spawn`、`accept-018-rest-ssr-seam` | 69 项、通过 67、失败 0、todo 2（SEAM-1、SEAM-2 本来就是 todo）；SEAM-3 过，无窗口守门过 |
| 真东西探针 | `node scripts/probes/cloud-tools-c1-probe.mjs` | 退出码 0，9 条全过（跑了三次：第一次 R3 不过，原因见下；之后两次都过） |
| 全量测试 | `npm test`（设了那两个环境变量） | 见文末「最终基线」 |

### 3.1 单测逐条对应验收

| 验收点 | 测试 |
|---|---|
| 委托成了：只有发起页收到请求；字节在本项目的物理库里、别的项目的库里没有；云端向素材服务核过；登记带期望版本；云端一个子进程都没起（这条里云端节点连采集工具都没装） | C1-OK |
| 不属于登录站点：不打扰发起页，云端匿名，请求不带 cookie | C1-ANON |
| 浏览器页面作发起页：只问了一次，如实匿名，说明里写原因 | C1-WEB |
| 委托不成退回匿名并注明原因：本人不在线、本机没登录、本机采集没就绪、本机下载失败、上传失败、超时 | C1-FALL（六种情形逐一） |
| 节点没装采集工具、委托又没成：作业明确记失败 | C1-FALL 第二条 |
| 取消：对话结束（`stopAll`）与这一轮结束（`cancelRun`）；本机下载被叫停；既不登记也不退回匿名 | C1-CANCEL |
| 被停止之后才到的回执不登记；字节还在库里没人引用；不再匿名下载 | C1-LATE stopped |
| 对话转私有（成员发起的那一轮被撤销）不登记 | C1-LATE private(member) |
| 主人把自己在跑的对话转私有：在途的回执被拒、这次委托到此为止；这一轮仍有效所以接着匿名 | C1-LATE private(owner) |
| 发起人被踢出：不登记；之后再委托直接是不在线 | C1-LATE kicked |
| 重启：委托记录是 `interrupted`、作业表说「重启过」；重启后才到的回执不登记；别的项目查不到这条记录 | C1-RESTART |
| 伪造回执：多带字段（本机路径、cookie）、别的项目的哈希、回执写别的项目、改过的大小、别的对话的请求号、别的成员来交 | C1-FORGE（四组） |
| 回执重复交：页面重交幂等；核实登记的口子并发两次只登记一次；内容不同的第二份不采用 | C1-DUP |
| 登录两件：不在线回现成的「发起方不在线」；在线打开本机登录窗口、只回真假值；页面硬塞用户标识与路径被拒；网页版如实说；没接线时如实说 | C1-LOGIN |
| 云端的日志、两个 SQLite 库的每一行、作业表文件、页面交回的每份答案里查不到本机的 cookie、请求头、cookies 文件路径、用户数据目录、文件路径、站点用户标识 | C1-SECRET，另 C1-OK、C1-FALL、C1-FORGE、C1-LOGIN 各扫一遍 |
| 页面与服务端工具表对账；不与 W2 的工具重名；没带扩展的反向通道不认这些请求 | C1-TABLE、C1-PAGE-06 |
| 页面一侧：只认发给这张页面的请求；重复请求只执行一次；开始前的几道闸；回执逐字段拼；项目中途换了不往别的项目传 | C1-PAGE-01～05 |

夹具里真的：SQLite 账本上的运行授权与对话权限判定、文档服务的在场模块、运行资源登记器、反向通道与它的请求记录、委托记录、F0 的「项目素材」（`createProjectAssets` 加 `createRunAssetClient`）、素材服务的项目分库（磁盘上的物理库）、云端采集连同工作区、受限子进程、出网闸、页面一侧的执行器（`collectBridge.ts` 原样载入）。不是真的：页面到 Agent 服务没有 HTTP（直接调 `attach` / `acceptResult`）；「项目素材」到素材服务之间是一段受控的转接（判断照 `server/hosted/asset-run-access.mjs` 的 verifyRef 分支抄，没有 mTLS）；本机采集是内存里的替身；登记进项目是夹具里一个带版本号的小账本；云端匿名用下载器替身。

### 3.2 探针的关键行（最后一次运行，原文在 `docs/reports/assets/v18-tools-c1/probe-output.jsonl`）

```
R1 桌面一侧的真编辑器进程:采集就绪  ok  ytdlp {installed:true, version:"2026.08.19"}, ffmpeg true, bilibili {loggedIn:true, expired:false}
R2 对照:云端匿名(真 Python、真 yt-dlp,经出网闸的代理)  ok  got 低画质(320x180) 36916 字节;假站看到 ["GET cookie:false → sd" ×2]
R3a 委托:桌面一侧真的本机采集带着假登录态下载  ok  route delegated;假站看到 ["GET 登录:true → hd" ×2];本机调用 download{quality:1080, cookies:(本机路径)}、enqueue{queued:1}
R3b 上传队列直接传进素材服务里本项目的分库  ok  取回 370663 字节 = 高画质(1280x720);别的项目的票据 404;上传请求 PUT …/<hash>/0、POST …/complete 各两次(小尺寸、原尺寸)
R3c 回执与核实登记  ok  receipt {requestId:"cd-…", jobId:"collect-…", assetRef:{projectId:"sp_fixture", hash:"29e9…d1b3", size:370663}, result:{items:[{…, name:"clip [clip].mp4", kind:"video", width:1280, height:720, vcodec:"h264"}], cookiesUsed:true}}
     verify [{projectId:"sp_fixture", hash:"29e9…", size:370663, found:true}];登记 {mediaId:"m-2", hash:"29e9…", width:1280, height:720};commit {expectedRev:2, rev:3}
R4 发起页是浏览器页面  ok  route anonymous,got 低画质(320x180),notes ["这个站点登录后才有更高的画质,但发起人现在用的是网页版…;已改为云端按未登录的画质下载,画质可能低于登录后的。"]
R5 collect_login / collect_login_check  ok  {ok:true, alreadyLoggedIn:true, …} / {ok:true, loggedIn:true, …}(各只有 ok、site、真假值、onInitiatorComputer、hint)
R6 云端查不到本机的东西  ok  found [];扫了 11792 字节;委托记录 ["done refs=[{hash,size}]", "fallback(page-without-local-collect)"]
R7 收尾  ok  8 个进程全部结束,五个端口放回
{"summary":true,"total":9,"passed":9,"failed":[]}
```

对照就是 R2 与 R3：同一条链接，云端匿名拿到的是 36916 字节的 320×180 那一份，委托拿到的是 370663 字节的 1280×720 那一份，两份都与假站上的文件逐字节相同（比的是 SHA-256）。

**第一次运行 R3 不过的原因**（如实记）：桌面版的编辑器进程在视频入库时自己已经把它排进上传队列，探针再交一次时队列回的是「已经在了」，我当时把这当成没交出去。文件其实已经传上去了。改成「本机内容库里有、上传目标不是本机就算交了，传没传完看素材服务」之后通过。产品接线时 `push` 也要这样判（第 5.2 节第 3 条）。

**探针里哪些不是产品接线**：页面一侧的执行器跑在探针进程里，不是浏览器里的编辑器页面，它的「本机采集」「上传」两组接口是对那台真编辑器进程发真的 HTTP 请求（`src/ai/collect.ts` 用的同一组接口）；页面到 Agent 服务是进程内直接调（真 HTTP 与真浏览器页面在 W2 的探针里验过）；「项目素材」到素材服务之间是受控的转接，读的是素材服务的同一个物理库；登记是探针里的小账本；假站不在站点表里，探针用 `collect-bridge.mjs` 留的口子把它算成 bilibili 那一格（桌面一侧因此用 bilibili 那一格的登录态文件，里面另有一行假站认的 cookie）。账号登录、委托票据、真模型不在探针范围里。

真 Python 用的是主工作区 `desktop/src-tauri/runtime/python/python.exe`（只执行，不写）；yt-dlp 是从主工作区 `out/pylibs` 复制进本工作区 `out/c1-collect/pylibs` 的（`--setup`，照 P2 探针的先例，不联网、不 pip）。

**窗口与进程**：每次跑探针前后各查一次可见窗口，都是空的；28810～28849 没有留下监听；探针起的编辑器进程树（8 个进程）按进程号结束。本包自己不起子进程（云端的子进程仍经公共实现 `perception/runner.mjs`；页面一侧不起进程）。

## 4. 对上摸底报告

`AGENT-018-prep.md` 第 1 节「第 2 项」里的「素材采集」那一行（需要登录态时让发起人的电脑代下、直接传进本项目素材库；做不成或他不在线退回不带登录态）：实现与包内验证做了，产品接线没做。第 2.3 节第 4 条（隔离验收：跨项目拿不到素材、伪造的身份证明被拒）：本包范围内的由 C1-FORGE、C1-LATE、探针 R3b 覆盖，账号模式整体的要 G 包之后重跑。第 11 条（tsc、npm test）见最终基线。

## 5. G 包接线时要填什么

### 5.0 先定：委托逻辑放在哪个进程

与 W2 报告第 5.0 节是同一件事。账号模式的生产形态是一条任务一个工作进程，反向通道（接着页面事件流）在主服务。`createCollectBridge` 既要调反向通道（`requestPage`、`initiator`），又要用这一轮的「项目素材」、写权限核对、登记（都在工作进程）。建议：**委托逻辑放在工作进程**，`bridge` 传一个转发对象 `{ requestPage, initiator, extraTools, limits }`，经 W2 5.0 甲那条「工作进程到主服务」的内部请求转给主服务的真反向通道；主服务建桥时带上 `extraTools: collectPageTools()`。本包的单测与探针都在一个进程里，这一段没有覆盖。

### 5.1 服务一侧

1. 建桥：`createPageBridge({ …, extraTools: collectPageTools() })`（W2 的那一个桥，多给一个参数）。
2. 建委托：`createCollectBridge({ bridge, databasePath: <数据目录>/collect-delegations.sqlite, assets: { verifyRef: (ctx, ref) => projectAssets.verifyRef(ctx, ref) }, authorize: (ctx, action) => resources.authorize(ctx, action), register, log })`。`loginSiteOf` 不给（缺省用站点表）。
3. `register(context, entry)`：`entry` 是 `{ requestId, sourceJobId, assetRef: { projectId, hash, size }, kind, ext, name, title?, duration?, width?, height? }`。在 `hosted-tools.mjs` 里挨着 `registerMedia` 写一个不经 `ingest` 的版本（字节已经在库里）：`exec().mutate('import_media', …, host => host.addMedia({ kind, name, url: '/@media/<hash>', hash, ext, size, tiers: { original: hash }, … }))`，视频照 `importFile` 的规矩放上时间轴；同一个 `requestId` 重复调用回第一次的结果；回 `{ mediaId, kind, clipId? }`。**时长、宽高是发起人电脑报的，没有核过**：登记后最好经「项目素材」读一次、用 ffprobe 重量再改（本包没做）。
4. 委托口子：`collector.forConversation({ …, delegate: () => <这一轮的 collectBridge.forRun(context) 或 null> })`；`context` 是这一轮的可信运行上下文（`account-runner.mjs` 里 `entry.context`）。`hosted-tools.mjs` 的工具映射加 `collect_login`、`collect_login_check` 两行。
5. 收尾：一轮结束与控制通道叫停时 `collectBridge.cancelRun({ projectId, conversationId, runId })`（与 `bridge.cancelRun` 一起）；服务关闭时 `collectBridge.close()`。
6. 工具表（`cloud-tools.mjs`）：`collect_login`、`collect_login_check` 两行从「要操作发起人界面、还没桥接」改成已接；`NEED_LOGIN` 那句与系统提示词里「`collect_*` … 不带任何站点的登录态（按未登录的画质）」是旧话，改成「登录站点的链接在发起人在线且他的电脑上已登录时由他的电脑代下，否则按未登录的画质」。
7. 路由不用加：事件流与交回用的就是 W2 那两条。

### 5.2 页面一侧

1. 事件分流（`session.ts` / `useCloud.ts`）：账号模式下 `collect.handles(ev)` 为真的交给 `createCollectBridgePage(...)`，其余交 W2 的执行器；答案**原样**交回。
2. `local`（只在有本机编辑器进程的桌面版给，在线构建不给）：`status` ← `/api/collect/status`；`cookies` ← `cookieStatus()`；`download` ← `/api/collect/download`；`job` ← `/api/collect/job/<id>`（404 回 null）；`cancel` ← `DELETE`；`login` ← 本机 `collect_login` 现成的那一支（`mcpExecutor.ts` 里：`method: 'qr'` 调 `openCollectLogin` 弹现成的「站点登录」弹窗，`'browser'` 调 `collectLogin`）；`loginCheck` ← `collectLoginCheck`。
3. `upload`：`projectId()` ← 当前账号项目号；`push(items)` ← `enqueueExistingMedia` 那个入队口子，**判定用「本机内容库里有（不在 `missing` 里）且上传目标不是本机（不是 `local`）」**，不要用「`queued` 里有」（视频入库时已经自动排过队）；`stored(hash)` ← `askComplete([hash])`。
4. 接上后把 `cloud-tools-c1-page.test.mjs` 的 C1-PAGE-06 放行名单加上接线的那个文件。

## 6. 没做成的与原因

- **产品里的端到端没有**：中央接线归 G 包。真模型、账号登录、委托票据、mTLS 下的文档服务与素材服务、文档服务里真的登记（带期望版本的 `import_media`）都没有在这一包里走。计划第 84 行要求的「真实 doc/asset mTLS」本包没有。
- **工作进程与主服务跨进程的那一段没有做也没有测**（第 5.0 节）。
- **探针里页面一侧不是真浏览器页面**（见第 3.2 节）。浏览器页面作发起页的「如实匿名」验的是「页面执行器没有本机采集」这一形态，不是在真的在线构建里点出来的。
- **真的哔哩哔哩没有验**：没有也不该用真账号。真 yt-dlp 走的是通用提取器对假站。
- **Linux 没验**。本包没有新的子进程，只用 `node:sqlite`。
- **没有用 F0 的作业表**（〔裁 3〕）。
- **素材小尺寸没有登记**：桌面版入库视频会生成并上传小尺寸，回执里只带原尺寸，云端登记时 `tiers` 只有原尺寸。别的成员预览时取的是原尺寸。要补得在回执里加小尺寸的哈希并同样核实。
- **发起人电脑报的时长、宽高没有核**（第 5.1 节第 3 条）。
- **`collect_probe`、`collect_search` 仍然只在云端匿名做**：模型先探测时看到的是未登录的清晰度，可能据此以为拿不到高画质。没有做「探测也委托」。
- **`collect_logout` 没有接到本人电脑**：云端仍回「没有可退出的」。
- **委托时桌面版界面上没有任何提示**（第 9 节第 2 条，要用户定）。
- **反向通道的请求记录会多**：每问一次进度是一行，一次 15 分钟的下载最多约 450 行，留 7 天。没有做合并或提前清。

## 7. 我做的裁定〔裁〕

1. 〔裁 1〕一次委托拆成「开始、轮询、取消」三种短请求，不做一条长请求（三级）。原因见第 2.2 节。
2. 〔裁 2〕**「站点需要登录」的判定**：链接属于站点表里有登录支持的站点（现在只有哔哩哔哩），并且发起人的电脑上有这个站点没过期的登录态，就委托；不看模型要的清晰度。**这条用户看得到区别（二级）**，单列在第 9 节第 1 条。
3. 〔裁 3〕委托记录用自己的一张表，作业状态仍在 `hosted-collect.mjs` 原有的随对话落盘的作业表里（加了 `route`），不用 F0 的作业表（三级）。原因与 W2〔裁 1〕相同：重启之后回执到达时这一轮已经没有上下文，F0 的作业表每次读写都要上下文。
4. 〔裁 4〕在途的回执被拒收后这一次委托就此结束，不再接受同一次委托的后续回执；这一轮此刻还能写就接着匿名下载，不能写就不下（三级，沿着 W2〔裁 3〕）。
5. 〔裁 5〕核实通过但登记没成时不退回匿名（重下一遍也登记不了），作业记失败并说明（三级）。
6. 〔裁 6〕页面交回的答案按白名单收，多带字段整份拒收；页面没做成只留代号（三级）。
7. 〔裁 7〕`collect_login`、`collect_login_check` 在云端只回真假值，不回本机版会回的 `userId`、`expiresAt`、`path`（**二级**：云端 Agent 因此说不出「你登录的是哪个账号、什么时候过期」）。
8. 〔裁 8〕素材的种类与扩展名以素材服务核回来的为准，页面说的只在它没给时用（三级）。
9. 〔裁 9〕一张页面同时只替一个委托下载，第二个回「正忙」并退回匿名（三级）。
10. 〔裁 10〕时限：轮询间隔 2 秒、整次委托 15 分钟、掉线宽限 20 秒、记录保留 7 天（三级）。
11. 〔裁 11〕`page-bridge.mjs` 加 `extraTools` 口子而不是把五个名字加进 `PAGE_BRIDGE_TOOLS`（三级）。原因：W2 的对账测试要求那张表与页面的 W2 白名单一致，加进去就得改 W2 的页面文件与测试。
12. 〔裁 12〕页面把本机查到的登录态文件路径显式交给本机的下载（三级）。产品里不交也会自动带上；显式交是为了「页面核过的那一份就是下载用的那一份」，也使探针的假站能用上假登录态。路径不出本机。
13. 〔裁 13〕节点没装采集工具但有委托口子时 `collect_download` 不再立刻回「没装」，而是先试委托，没成再把「没装」记进作业（二级的边角：模型从立刻得到答案变成查作业才得到）。
14. 〔裁 14〕新增一批给模型看的话（`COLLECT_BRIDGE_TEXT` 与 `hosted-collect.mjs` 里两句），都是草稿，见第 9 节第 3 条。

ChatGPT 留下的裁定我没有推翻任何一条。

## 8. 要主会话决定或注意的事

1. **第 5.0 节的进程问题**在派 G 包之前要定。
2. **页面相信云端说的「站点」**：页面按云端给的站点代号去查本机登录态，自己不核「这条链接是不是这个站点的」（`src/` 不能引用 `server/collect-cookies.mjs`）。后果有限：下载器只把 cookie 发给它所属的域，别的站点的链接拿不到这份 cookie；但发起人的电脑会被用来下载云端指定的任意 http(s) 链接。要收紧可以让本机的编辑器进程加一个「这条链接归哪个站点、有没有登录态」的接口，页面改问它（要动 `server/vite-plugin-collect.ts`，本包没动）。
3. **委托会用发起人的带宽和磁盘**（文件先进他本机的内容库再上传），而且现在没有任何界面提示（第 9 节第 2 条）。
4. 全量测试里别的包写死端口的测试在几个工作区同时跑时会撞（见最终基线），不是本包的。本包单测用的固定端口是 28830，探针用 28812、28813、28820～28822。
5. `out/c1-collect/` 是本包的依赖副本与日志（不入库）。

## 9. 要用户定的事

1. **什么时候算「需要登录」而去用发起人的电脑。** 背景：云端匿名下载画质低，登录后才高，但登录信息只能留在用户自己的电脑上。现在的做法：只要链接是哔哩哔哩的（目前唯一有登录支持的站点）、发消息的人正在线用桌面版、他电脑上有没过期的登录，就由他的电脑下载；否则云端匿名。选项：（甲）照现在这样，凡是登录站点的链接、能委托就委托；（乙）只在模型要的清晰度超过未登录上限时才委托，其余匿名（少占用户带宽，但未登录的上限各站不同、常变，容易判错）；（丙）先云端匿名试，失败或画质不够再委托（多花一遍时间）。后果：甲最简单、画质最好，但用户的电脑会经常被用来下载；乙、丙少打扰用户。我的建议是甲，配合下一条的提示。
2. **委托时桌面版要不要提示用户。** 背景：现在云端 Agent 请发起人的电脑代下时，他的界面上没有任何提示（本包不许自己定界面文字，桌面版也没有现成的这句话）；下载用的是他的登录身份、他的带宽和磁盘。选项：（甲）不提示（现状）；（乙）在采集面板或聊天栏里显示一条「云端 Agent 正在用这台电脑的登录下载 XXX」（要用户给原文）；（丙）每次弹确认框，点了才下（最稳，但发了任务后人不在电脑前就会卡到超时再退回匿名）。我的建议是乙。
3. **给模型看的几句话**（不是界面文字，但模型会照着转述给用户）。草稿在 `collect-bridge.mjs` 的 `COLLECT_BRIDGE_TEXT`，可整体替换。主要几句：
   - 委托成了：「这条链接由发起人自己的电脑用他本机的登录态下载,文件由他的电脑直接传进这个项目的素材库;登录信息没有离开他的电脑。」
   - 退回匿名（十一种原因各一句，结尾都是）：「…;已改为云端按未登录的画质下载,画质可能低于登录后的。」例如「这个站点登录后才有更高的画质,但发起人现在不在线,用不了他电脑上的登录态」「发起人的电脑上还没有这个站点的登录态(需要的话先 collect_login,让他在自己的电脑上登录)」。
   - 登录框弹出：「登录框已经在发起人自己的电脑上弹出来了。登录只能由他本人在自己的电脑上完成,登录态只留在他的电脑上,云端拿不到。**现在停下来**,…用户回话之后再调 collect_login_check。」
   - 网页版：「collect_login 只能在发起人自己的电脑上操作,而他现在用的是网页版(没有本机的登录窗口)。请告诉用户到电脑上的 PromptCut 里登录;云端照常按未登录的画质采集。」
   - 回执晚到：「这条任务已经被停止,或者不再有往这个项目里写素材的权限;发起人电脑交回的文件没有登记进项目。」
4. **没登记的字节留不留。** 背景：任务被停止或对话转私有之后才传完的文件，留在项目素材库里但没有登记，谁也看不到（第 2.4 节）。选项：留着（现状，占一点空间，记录里查得到）；以后做一个定期清理没人引用的素材的功能。影响小，我的建议是先留着。
5. **云端的 `collect_login_check` 要不要告诉模型登录的是哪个账号**（〔裁 7〕）。背景：本机版会回站点的用户标识和过期时间，云端版我只让它回「登没登」。选项：保持；或者允许回用户标识（它会进云端的对话记录）。我的建议是保持。

## 10. 对任务书或语义的更正建议

- `docs/plan/cloud-agent-tools-implementation.md` C1 行写云端只接 `{requestId,jobId,assetRef:{projectId,hash,size},result}`：实现照此；补一句「回执是反向通道一次请求的答案，下载过程用开始、轮询、取消三种短请求」，并注明 `result` 里是 `{ items: [{ assetRef, name, kind, title?, duration?, width?, height?, vcodec? }], cookiesUsed? }`。该行「本机 `server/vite-plugin-collect.ts`／`src/ai/collectLoginStore.ts` 如需扩展」：这次没有扩展。
- `docs/plan/cloud-agent-contract.md` 第 9.4d 节「登录态」那一条与第 28.3 节 `collect_login` 两行写的是「云端的采集用不到它」「尚未桥接」，接线后改成本报告第 2.1 节的做法；第 9.4d 节作业表那一条补 `route` 字段。
- `docs/semantics/product/agent.md`「工具范围」：接线后补一句「素材采集遇到要登录的站点，发起人在线且用桌面版时由他的电脑代下并直接传进项目素材库，登录信息不离开他的电脑；否则按未登录的画质」。这是二级，由主会话合入时改。
- `docs/semantics/mechanism/agent.md` 反向通道那一条：补「别的工具包可以经 `extraTools` 在这条通道上加请求，绑定与重核不变」。
- W2 的 `page-requests.test.mjs` CAU-ACC-07 是按名字在 `src/` 里搜引用的，注释里提到那个名字也会红（我撞了一次，改了注释）。建议 G 包接线时顺手改成只认 import。

## 最终基线

（见下节，交活前最后一遍的结果）

## 提交列表

（见下节）
