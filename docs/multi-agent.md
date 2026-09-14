# 多 Agent 并行(AI 面板分页)

AI 助手面板右边有一条竖向 rail(`src/editor/right/chat/RightRail.tsx`):最上面是「剧本」页,下面每一项是一个 Agent 分页,
最后一个「+」开新页。一页一个 Agent,可以同时跑;点当前已选中的项收起 / 展开面板。
传统式和对话式布局都经 `RightPanel` 渲染,所以两种布局都有。

## 页和身份

| 概念 | 在哪 | 说明 |
|---|---|---|
| tabId | `src/ai/agentTabs.ts` | 页面内部的键。主页固定 `main`,它的对话随 `.proc` 存取;别的页是临时并行的 Agent |
| conversationId | `useChatHistory`(每页一个 localStorage 键 `pcChatId:<tabId>`) | **给模型看的「Agent 对话 ID」**。`send_message` 的收件人、改动记录里的「谁改的」都写它 |
| 对话 store | `src/ai/liveChat.ts` `getChatStore(tabId)` | 每页一份;`messagesForSave` / `replaceMessages` 只碰主页那份 |
| CLI 会话 | `useAiChat` 的 `aiSession:<provider>:<tabId>` | 每页各自续自己的 CLI 会话,不会两页接着同一段话说 |

不在前台的页只是 `display:none`,对话照跑;页签上的点在跑的时候呼吸;关页会掐掉那一页还在跑的请求。

## 谁改了哪儿:工具调用的归属

每次 `/api/ai/chat` 都带 `conversationId`。服务端(`server/vite-plugin-ai.ts`):

- 起 CLI 时把它塞进 MCP 进程的环境变量 `PROMPTCUT_AGENT`,`server/mcp-server.mjs` 调桥时放进 body 的 `agent` 字段;
- API 直连那条路由 `callTool` 闭包直接带;
- 推给编辑台的 `call` 事件多一个 `agent`。

编辑台的执行器(`src/ai/mcpExecutor.ts`)对时间轴类工具在执行前后各看一眼项目,
`agentBus.diffScopes` 算出改了哪几条「剪辑->序列」(序列的 `clips` 数组换了引用就算),记到公告板。
`agy` 那条路的 MCP 是全局注册的,带不上环境变量,它的调用归属为空。

## 公告板(`src/ai/agentBus.ts`)

- `declare_scope`:Agent 开工先声明范围「剪辑X->序列X」,页签改成这个名字;和别人重叠会返回 `warning`。
- 改动记录:别的 Agent 的声明和改动,在这个 Agent **下一次发消息时**拼在提示词前面
  (`[其他 Agent 的动态 —— 系统自动附上,不是用户说的话] … [/其他 Agent 的动态]`),只进模型,不进屏幕上那条用户消息。
  取走即已读(`consumeNotes`)。
- `send_message` / 信箱:投给某个对话 ID(或 `all`)。收件页空闲时立刻作为一条用户消息
  `【来自 Agent <id> 的消息】…` 发出去;正忙就等它这一轮跑完。自动连锁有层数上限 `MAX_AUTO_HOPS`(3):
  到顶的消息留在信箱里(页签上有未读角标),等用户下次和那一页说话时一并带上,防止两个 Agent 互相唤醒到天亮。
- `list_agents` / `check_messages`:看有谁在跑、信箱和最近的改动(不取走)。

工具定义在 `server/mcp-tools.mjs`(四个都是 `side: "browser"`),提示词说明在 `server/ai-system-prompt.md` 的「多 Agent 并行」一节。

## 手工验证

```bash
# 以某一页的对话 ID 的身份调工具(用户那份编辑台在 5197 上)
curl -s -X POST http://127.0.0.1:5197/api/mcp/call -H "Content-Type: application/json" -H "Origin: http://127.0.0.1:5197" \
  -d '{"tool":"declare_scope","args":{"scope":"剪辑1->序列2"},"agent":"<对话 ID>"}'
```

单测:`node --test src/ai/agentBus.test.mjs`。
