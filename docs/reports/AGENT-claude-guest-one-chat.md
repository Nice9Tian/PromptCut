# AGENT 报告：claude/guest-one-chat

任务：游客每个项目只能开一个 Agent 对话（2026-10-23 用户原话「游客每个项目只能开一个会话。帮我定死。」），回答安全审查 S8（游客自己的项目默认开着云端 Agent，匿名用户能触发模型费用，语义没写）。
分支 `claude/guest-one-chat`，基准 main `84702232`。状态：进行中。不推送、不合并。

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

## 做了什么

（边做边补）
