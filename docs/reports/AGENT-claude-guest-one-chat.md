# AGENT 报告：claude/guest-one-chat

任务：游客每个项目只能开一个 Agent 对话（2026-10-23 用户原话「游客每个项目只能开一个会话。帮我定死。」），回答安全审查 S8（游客自己的项目默认开着云端 Agent，匿名用户能触发模型费用，语义没写）。
分支 `claude/guest-one-chat`，基准 main `84702232`。状态：做完，等主 Agent 审。不推送、不合并。

## 现状（改之前摸到的）

### 对话是怎么建的

- 云端对话没有单独的「新建」接口。页面点「新对话」只是在本地生成一个新的对话号（`src/ai/cloud/useCloud.ts` 的 `newChat` → `switchTo(newCloudChatId(), true)`），**第一条消息发出去时服务端才建这条对话**。
- 账号模式（游客也在这一条路上）的链：页面 → Agent 主服务（`server/agent-service/account-master-assembly.mjs` 的 `send`，先查项目额度、核附件）→ `server/agent/service/conversation-policy.mjs` 的 `send`（只转发）→ 文档服务的 `server/account/conversation-authority.mjs` 的 `send`。**只有 `conversation-authority.mjs` 的 `send` 在事务里往账本（`conversationsV2`）插新对话行**（全仓库只有这一处写入 `rows(state)[projectId][conversationId]`），模型调用由账本里的消息驱动，所以账本这一处就是「建对话」的唯一关口。
- 现有的数量上限：同一项目同一个人最多 50 条（`MAX_CONVERSATIONS_PER_OWNER`，`conversation-authority.mjs`），满了拒 `409 conversation-limit`，不删历史。这一条在事务里按「这个项目里 owner 是我的行数」数。
- 错误码一路透传：权威抛 `accountError(status, code)` → 文档服务内部路由 → `server/agent-service/conversation-client.mjs`（取 `value.code`）→ `conversation-policy.mjs` 的 `translated`（保留 code 与 status）→ Agent 服务 HTTP → 页面 `src/ai/cloud/cloudApi.ts` 的 `CloudError.code` → `cloudErrorText` 译成人话。
- 老的本机/非账号模式另有一份 `server/agent/service/conversations.mjs` 的 `assertRoomForNew`（同样 50，码 `conversation-limit`）；游客只在账号模式的在线浏览器里有，这一份不涉及。

### 游客身份与现有限额

- 游客的 principal：`accountId` 就是 `gst_` + 24 位十六进制（`server/account/guest.mjs`、`authority.mjs` 的 `guestPrincipal`），带 `guest: true`；服务端用 `isGuestId(accountId)` 认。游客进别人的项目是只读（`guest-read-only`），不能发消息；所以游客只可能在**自己建的那一个项目**里发消息、建对话。
- `GUEST_LIMITS` 服务端在 `server/account/guest.mjs`：`projects 1`、`videos 3`、`assetBytes 100 MB`、`ttlMs 3 天`、`tokenTtlMs 24 小时`、`renewGraceMs 3 天`。界面一份镜像在 `src/account/guest.ts`（`projects, videos, assetMB, ttlDays` + `GUEST_LIMITS_TEXT` 那句话），`src/account/guest.test.mjs` 守两边的数一致。
- 服务端游客错误码与文案：`GUEST_ERROR_TEXT`（`guest.mjs`）；页面译码表 `accountErrorText`（`src/account/client.ts`，游客那段注释「数都从 GUEST_LIMITS 拼」）。游客项目数上限是 `authority.mjs` 的 `checkCreateProject` 直接问 `guestProjectLimitReached`（不走可配的 `createPolicy`），拒 `403 guest-project-limit`；开始页 `src/start/OnlineStart.tsx` 的 `createBlocked` 在界面上先拦并给「游客只能建 1 个项目。要建更多，请注册一个账号。」
- 云端 Agent 告知（consent）：页面这一侧游客直接抛 `guest-agent-unavailable`（`client.ts`），标着「待用户定」；服务端 `doc-agent-assembly.mjs` 的 `checkConsent` 向账号服务按 accountId 问，账号服务不认游客编号。也就是说，现状下游客能否真的走到「发消息」要看这一关；这不在本任务范围内，但**本任务的服务端限额不依赖它**——限额在建对话的事务里，不论 consent 怎么定，游客只要走到建对话就只能建一条。

### 界面上「新建对话」的入口

1. 开始页侧栏项目下的「新对话」行（`src/start/ProjectSidebar.tsx` 的 `newChatRow` → `OnlineStart.tsx` 的 `onNewChat`，已有 `history.atLimit` 的 50 条检查）。
2. 项目里右侧云端 Agent 面板（`src/editor/right/CloudAiPanel.tsx`）：输入框菜单里的「新对话」（`Composer.tsx` `ai-new-chat`）、对话历史抽屉里的「新建」按钮（`ChatHistoryDrawer.tsx` `chat-new`）、满额时输入框上方的提示条（CloudAiPanel 762 行附近）。
3. 删除当前对话或当前对话被删之后页面自动退到一条新对话号（`useCloud.ts` 的 `removeChat`、`onDeletedRef`）。
4. 开始页中间输入框「说一句话」：新建项目再发第一条消息；游客已有项目时被 `createBlocked` 拦在建项目这一步，不会走到第二条对话。

### 一个要先说的发现（影响怎么理解 S8 现在的暴露面）

按代码读，游客**今天在页面上就发不了 Agent 消息**：页面这一侧 `src/account/client.ts` 的 `cloudAgentConsent / acceptCloudAgentConsent` 对游客直接抛 `guest-agent-unavailable`（标着「待用户定」，`claude/guest-enter` 留的），云端 Agent 面板要先过告知才连得上，所以游客连对话列表都读不到；绕过页面直接打接口，文档服务的 `checkConsent` 向账号服务按 accountId 问，账号服务只认 `acc_` 形状的编号（VisuHive `account/test/account-v2-internal.test.mjs` 对非法编号回 400），`gst_` 编号拿不到「已确认」。这是我读代码得出的，**没有在线上或真账号服务上验过**。所以 S8 的费用暴露现在是被「游客没法过告知」这个缺口挡着的；本任务把「就算以后放开了，每个项目也只有一条」先在服务端定死，界面入口的处理在放开之后才会被游客看到。放不放开游客用 Agent，仍是待用户定的事。

## 做了什么

| 块 | 文件 | 为什么 |
|---|---|---|
| 服务端：建对话处拦 | `server/account/conversation-authority.mjs` | `send` 事务里、新对话要插账本之前，调 `guestChatLimitReached`，游客在这个项目里已有 1 条（owner 是他的行数）就 `403 guest-chat-limit`。在事务里数，所以两个并发的新对话号只有先到的成；只拦「新建」，往已有对话里发（走 `else`）不受影响。放在 50 条检查之前 |
| 限额的数与判断 | `server/account/guest.mjs` | `GUEST_LIMITS.conversations = 1`（注释写明来历和 S8）；`guestChatLimitReached({accountId, ownedCount})`（只认 `gst_` 编号，账号恒 false，和 `guestProjectLimitReached` 同款）；`GUEST_ERROR_TEXT['guest-chat-limit']` |
| 页面：说明与上限 | `src/account/guest.ts` | 镜像 `GUEST_LIMITS.conversations`；`GUEST_LIMITS_TEXT`（开始页与项目列表上那句总说明）加上「每个项目里开 1 个 Agent 对话」；新增 `GUEST_CHAT_LIMIT_TEXT`：「游客在每个项目里只能开 1 个 Agent 对话，你已经开过了：在「对话历史」里点它就能接着聊。要多开，请注册一个账号。」，数从上限拼 |
| 页面：错误码译话 | `src/ai/cloud/cloudApi.ts`、`src/ai/cloud/chatTexts.ts` | `cloudErrorText('guest-chat-limit')` 译成上面那句，不落到「云端 Agent 出错了(代号)」；`chatLimitOf(accountId)`（游客 1、账号 50）；`countLabel` 能带上限（游客显示「我的 1/1」） |
| 页面：hook | `src/ai/cloud/useCloud.ts` | 上限按身份算（原先写死 50）；`history` 多出 `limit`、`guest`；游客已满时 `newChat()` 自己不开新对话、给说明（兜底，不依赖各入口都记得判）；被服务端拒（含 `guest-chat-limit`）之后重读列表 |
| 入口置灰 | `src/editor/right/CloudAiPanel.tsx`、`chat/Composer.tsx`、`ChatHistoryDrawer.tsx`(+`.css`)、`src/start/OnlineStart.tsx`、`ProjectSidebar.tsx`(+`start.css`) | 游客已有一条时：输入框「✦」菜单里的「新对话」、对话历史抽屉头部的「新对话」置灰且悬停写那句；抽屉顶上的提示和计数换成游客的口径；开始页侧栏项目下的「新对话」行置灰（点一下仍把那句话摆在提示上）；停在一段没发过的新对话上（回来时列表里没有当前这个）输入区置灰并指到「对话历史」。账号的行为一律不变（包括满 50 条时「新对话」照常可点） |
| 测试 | 见下 | |

没改的：`server/bakery/`、`src/render/` 一律没碰；`server/agent/service/conversations.mjs` 的老本机存储路径没动（游客只在账号模式）；`server/hosted/files.mjs` 的部署清单没改（`guest.mjs` 本来就在清单里，`conversation-authority.mjs` 只是新增 import 它）。

## 验证

环境：`PROMPTCUT_NO_PORT_FILE=1`，VisuHive 两个环境变量按 `verification.md` 设；没起任何 dev server，没占 5950～5959 以外的端口（mTLS 测试用 `freePorts`）。

- `npx tsc -b --force`：退出码 0，零错误（页面改完后与最终提交各跑过）。
- **新增测试**
  - `server/test/guest-one-chat.test.mjs`（8 条，真账号权威认游客令牌 + 真对话权威，绕过界面直接发）：`GOC-1` 游客建第一条成功且往里接着发成功；`GOC-2` 第二条被拒 `403 guest-chat-limit`、换对话号也拦、账本里只有一条、老对话照发；`GOC-3` 三个新对话号并发只成一个；`GOC-4` **登录账号不受影响**：同项目建 3 条、建到 50 条，第 51 条仍是 `409 conversation-limit`；`GOC-5` 游客甲建满不影响游客乙、进别人的项目先死在 `guest-read-only`；`GOC-6` 历史上留下 3 条游客对话：不删不动、老的照发、新的不让建；`GOC-7` 删掉那条之后名额让出（只数「现有几条」）；`GOC-8` 判断函数。
  - `server/test/guest-one-chat-http.test.mjs`（1 条，真 mTLS 的文档服务 + 真 HTTP 的 Agent 服务，用游客与账号两张委托票据）：游客第一条 202；第二条 **403、`body.code === 'guest-chat-limit'`**，GET 那个对话号是 404（没留半条）；老对话照发；账号在同一个项目里建 3 条都 202。证明从页面能打到的口子一路到账本都拦得住，错误码原样到页面。
  - `src/ai/cloud/guest-chat-limit.test.mjs`（3 条）：`chatLimitOf` 游客 1 / 账号 50 且与服务端同数；403 `guest-chat-limit` 经 `createCloudApi` 变成 `CloudError{code,status:403,message=那句人话}`，账号满额那句没动；源码守门：每个新建入口都接了游客限制。
  - 改了 `src/account/guest.test.mjs`：界面与服务端 `conversations` 同数、总说明里有「1 个 Agent 对话」、两句提示里的数与关键词（对话历史、注册一个账号）。
- **影响范围内的测试**：`npm test -- <服务端游客/账号/对话/Agent HTTP/删除/队列/用量等 25 个文件 + src/account、src/ai/cloud、src/start 下全部 *.test.*>`：435 条，pass 435，fail 0，退出码 0。另跑守门与部署类 `src/layering`、`pageNodeImports`、`online/modeImportGuard`、`c10a-api-guard*`、`sp-boundary`、`c10-layer-table`、`m7-layer`、`api-guard`、`hosted-render-deploy`、`account-executor-assembly-mtls`：53 条全过。没跑全量（按 2026-10-23 的规矩）。
- **看过的界面**：用 vite 的 SSR 构建把 `ChatHistoryDrawer` 渲染成 HTML（脚本在 scratchpad，没入库），游客参数得到 `<button … data-pc="chat-new" disabled title="游客在每个项目里只能开 1 个 Agent 对话，你已经开过了：在「对话历史」里点它就能接着聊。要多开，请注册一个账号。">`、计数「我的 1/1」、顶上提示同一句；账号参数得到不带 disabled 的按钮、「我的 3/50」、没有限额提示。**没有真浏览器看过整页**：因为游客现在过不了云端 Agent 告知（见上），真页面里游客走不到这些入口；`ProjectSidebar` 的置灰行、`Composer` 菜单项、输入区置灰只有 tsc 与源码守门，没有渲染过。

## 没做成的与原因

1. **真浏览器看游客的整条路径**：被「游客过不了告知」挡住（见现状里的发现），不是本任务能绕的。放开之后建议补一次真页面验收（游客建项目、发第一条、点「新对话」应置灰、后端拒码）。
2. **对话附件的预上传不受这条限制**：`account-master-assembly.mjs` 的 `attach` 在对话还没建时凭项目身份收文件，落进「对话号」对应的工作目录，有单个工作区的体积上限，但不数游客用了几个对话号。游客可以换很多对话号各传一份，占磁盘，不花模型费用。账号同样没有这层限制，不是游客独有，没扩大范围去改。要堵的话该在 `attach` 里按「游客已有对话数」拒，待用户定。
3. **游客删了那条再建一条**：规矩只数「现有几条」，没数「建过几条」（和账号的 50 条上限同一口径，删完名额立刻让出）。游客可以靠「删、建、删、建」重复，每条对话本身不花钱，花钱的是每一轮模型调用，仍受项目额度与并发闸管；真要「一生一条」得另记账，没做，也没人要过。
4. **回来时记不得上次对话**（本机清了存储）：此刻会停在一段新对话上、输入区置灰、指到「对话历史」。没做自动切到那一条。游客的身份也存在本机，清了存储连项目都找不回，所以这条路本来就极少走到。

## 对语义的更正建议（拟稿，没落笔；一级、二级要用户过目）

**1. `product/agent.md`「游客进别人的项目就是只读成员……」那一条（二级）后面加一条**

- 修改前：（没有游客对话数的说法；只有「游客进别人的项目就是只读成员，所以不能给云端 Agent 发消息」）
- 修改后（在同一条末尾或下面新起一条）：「**游客每个项目只能开一个对话**（2026-10-23 用户定，原话：『游客每个项目只能开一个会话。帮我定死。』，回应安全审查 S8）：游客在自己的项目里只能有一条云端 Agent 对话，要多开请注册账号。云端文档服务在新建对话时就拒绝，不只是界面上不给入口；界面上『新对话』置灰并说明原因。已经有的对话照常能发、不删；登录账号不受这条影响，仍是 50 个。」

**2. `product/document-service.md` 第 61 条「游客」（二级）**

- 修改前：「……自己能建 1 个项目、能传 3 条视频……；进别人的项目一律只读，改不了内容，也不能给云端 Agent 发消息（见 `agent.md`“只读成员”）。」
- 修改后：「……自己能建 1 个项目、项目里能开 1 个云端 Agent 对话（见 `agent.md`）、能传 3 条视频……（其余不变）」

**3. `mechanism/document-service.md` 第 97 条「限额」（三级）**

- 修改前：「……`GUEST_LIMITS`：项目 1 个、视频 3 条、每条源文件 100 MB、3 天清理、令牌 24 小时、过期 3 天内可续；……」
- 修改后：「……项目 1 个、**每个项目的对话 1 个**、视频 3 条……」，并在下面加一条机制：「**游客的对话数**在文档服务的对话权威（`server/account/conversation-authority.mjs` 的 `send`）建新对话的事务里数：这个项目里 owner 是该游客的对话行数已达 `GUEST_LIMITS.conversations` 就回 `403 guest-chat-limit`，先于账号的 50 条检查；并发的新对话号以事务为界只成先到的；只拦新建，往已有对话里发不拦；上限定下来之前留下的多条历史对话不删不动。页面把这个码译成 `GUEST_CHAT_LIMIT_TEXT`。」

**4. `workflow/production.md` 第 39 行（一级：用户看到的文字与可点性，**会话不能改，要用户定**）**

- 修改前：「对话满 50 个时「新对话」照常可点，页面上显示自己已有几个，随新建和删除实时更新（2026-10-12、2026-10-13 用户定）。」
- 修改后（拟）：在后面加：「游客例外：游客在一个项目里已经有一个对话时，「新对话」置灰，悬停和提示条里写『游客在每个项目里只能开 1 个 Agent 对话，你已经开过了：在「对话历史」里点它就能接着聊。要多开，请注册一个账号。』，显示『我的 1/1』（2026-10-23 用户定）。」——**注意**：账号「满 50 个时新对话照常可点」和游客「已满就置灰」口径不同，是我按任务书「游客看不到/点不动」做的；如果你想让游客也「可点、发出去才拒」，把置灰那几处去掉即可，服务端不用动。

**5. `glossary.md`「游客」条（二级）**：「自己能建 1 个项目、传 3 条视频……」→「自己能建 1 个项目、每个项目里开 1 个 Agent 对话、传 3 条视频……」。

**6. 待用户项（新）**：游客现在过不了云端 Agent 告知（页面抛 `guest-agent-unavailable`、服务端告知查询只认账号编号），语义（`document-service.md` 与 `agent.md`）只写了「进别人的项目的游客不能给 Agent 发消息」，**没写游客在自己项目里能不能用 Agent**；S8 说「默认开着」，而实际是被挡着。要不要放开、放开时告知怎么记（游客没有账号可记），需要用户定；本分支不依赖这个决定。

## 提交

分支 `claude/guest-one-chat`，基于 main `84702232`：报告、服务端、服务端 HTTP 测试、界面各一次提交。没推送、没合并。
