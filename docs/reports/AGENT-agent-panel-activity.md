# AGENT-agent-panel-activity

分支 `claude/agent-panel-activity`（从 `claude/accept-018-fixes` 的 `c5285cfc` 切出），工作区 `.worktrees/agent-panel-activity`。

任务：在线编辑器云端 Agent 面板的展示方式（用户 0.7.18 验收中提出），并修一个回归（新一轮内容被画进旧的失败补位回复里）。主会话中途补了一条：工具出错时把 `err.debug` 交给模型。

用户原话：「派一个子Agent，把Agent操作记录哪里换成气泡里面那个可视化组件。气泡里面只展示在做什么（harness可能要改，比如加入send_message(user,xxx)的用法。）。」

## 一句话结论

| # | 要做的 | 结论 |
|---|---|---|
| 1 | 底部「Agent 操作记录」换成气泡里的可视化组件 | 做了。新组件「Agent 操作」（`src/editor/right/chat/ActivityPanel.tsx`）放在原位置，内容就是原气泡里的操作图标组、操作详细预览、阶段 / 本轮小结。只取这个对话的消息，一次显示一轮：缺省跟最新一轮，点气泡切到那一轮，也能用 ‹ › 翻。本机 AI 栏和云端 AI 栏都换了 |
| 2 | 气泡只展示在做什么；harness 加 send_message(user, …) | 做了。沿用已有的 `send_message` 工具，`to` 填 `"user"` 就是对用户说话；harness 就地答。气泡按顺序列出这些话；一轮里没调它、只回了文字的，那段文字当一句话显示。撤掉了上一轮加的「按文字回复代交收尾汇报」，留一种做法 |
| 3 | 语义 | 改了 `product/agent.md`「汇报」第一条，`mechanism/agent.md` 新增「汇报与对用户说话」一节；改前改后见下 |
| 4 | 回归：新一轮画进旧的失败回复 | 查清并修好。根因不在折叠函数，在 `MessageList.tsx` 的「合并气泡」；去掉合并，补回归测试 |
| 补 | 工具出错时 `err.debug` 交给模型 | 做了。`toolErrorResult` 把 `code` 和 `debug`（去掉凭证、截到 2000 字）放进 tool_result，补测试 |

## 4. 回归的根因（先写这条）

生产上只读取了这个对话的数据（节点 149.88.94.84，只读打开两个库，没改任何东西）：

- 主服务事件库 `master-run-events.sqlite`：对话 `cc-mvfhwi2p-xi4o` 有 84 行事件。第一条消息（`35b79e88…`）只有 `user` 事件，没有任何运行事件；第二条（`00294dc0…`，run `run_6ddafe98…`）9 行；第三条（`0fe80b48…`，run `run_84bd45d3…`）72 行。
- 文档服务账本 `account-v2.sqlite`：三条消息的 `runId` 各不相同（`run_3134f5ad…` / `run_6ddafe98…` / `run_84bd45d3…`），第一条 `cancelled` + `failed / worker-failed`，后两条 `done`。

所以失败补位的 id（`ca-run_3134f5ad…`）是唯一的，runId 也没有复用。把这 84 行真实事件和账本队列喂给页面的 `applyCloudEvent` + `settleFromQueue`，折出来的消息顺序是对的：`cq-35b7 / ca-run_3134(失败) / cq-0029 / ca-run_6dda / cq-0fe8 / ca-run_84bd`，第三轮的工具全在 `ca-run_84bd` 里。**折叠函数没有问题。**

真正的原因在画的时候：`src/editor/right/chat/MessageList.tsx` 在简洁模式下有「合并气泡」——没交本轮小结（`final: true` 的 report_progress）的回复，后面几轮的回复都并进它的气泡里画，直到某一轮交了本轮小结。失败补位那条回复当然没有小结，第二轮只回了「好」也没有小结，于是第二、三轮都成了第一条失败回复的「跟随者」：它们自己不画，内容全画进第一条的气泡，位置就在第二、三条用户消息之上，新消息下面空着。失败补位只是让这个老问题更显眼（以前第一轮在第一个事件前失败时页面根本没有回复，合并从第二轮开始）。

修法：气泡里现在只放 Agent 说的话，操作挪到了底部按轮显示，合并已经没用，整段去掉。哪条消息画成哪一行抽成纯函数 `src/editor/right/chat/rowPlan.ts`（`inboundPlan`、`rowPlan`、`promptOf`），`MessageList` 用它；每一轮的回复各画各的气泡，紧跟在发起它的用户消息后面。

回归测试 `src/editor/right/chat/row-plan.test.mjs`（3 项）：用生产同形的事件（第一条第一个事件前失败、第二条只回文字、第三条有思考 / send_message / 工具 / 本轮小结）折出消息，断言行序是 `cq-m1, ca-run_1, cq-m2, ca-run_2, cq-m3, ca-run_3`、失败回复里没有别的轮次的内容、第三轮的工具都在它自己那条里；第三轮还在跑时同样如此。

## 1. 「Agent 操作」取代「Agent 操作记录」

- 原来的「Agent 操作记录」（`src/editor/sync/AgentEventLog.tsx`）列的是文档服务项目频道上的工具事件，来源包括这个对话、别的对话、别的成员的 Agent、命令行 `/api/mcp/call`。语义里查过（`product/agent.md`、`user-workflow.md`、`workflow/editing.md`、`workflow/production.md`），没有哪条要求在 AI 栏里列别的对话或别的成员的操作，所以新组件只看这个对话自己的消息。
- 新组件 `AgentActivityPanel`：标题行「▾ Agent 操作　第 i/N 轮 · k 次操作 · 进行中」加 ‹ › 两个按钮；正文第一行「回应：<那一轮的用户消息>」，下面是那一轮的图标组和操作详细预览（简洁模式），或按发生顺序的工具行和汇报卡（详细模式）。没有操作的一轮写「这一轮没有操作」。折叠状态记在本地（`pc.ai.activity.open`）。
- 选哪一轮：`useRoundSelection`——用户点过哪个气泡就显示哪一轮；有新的一轮开始时回到跟着最新。被选中的气泡描一圈淡强调色。
- 「撤销这步」：原记录里每行都有。新组件里写了项目的那一步在操作详细预览的操作卡上照旧有（`AgentUndoButton`，按 `callId` 对上文档服务的事件，原气泡里就是这样），所以这个功能没丢；但**只对这个对话的操作**。别的对话、别的成员、命令行的调用在 AI 栏里不再列出、也不能从这里撤。
- `AgentEventLog.tsx` 文件不在我的范围，没删，只是两个面板不再挂它（现在没有别处引用）。

## 2. 气泡只展示在做什么、send_message(user, …)

做法：

- **工具**：沿用多 Agent 协调已有的 `send_message`（`server/tools/agent.mjs`），`to` 填 `"user"` 就是对用户说话；说明文字补上这一用法。没有另起新名字：用户举例就是 `send_message(user, xxx)`，同名同参数正好对上。
- **执行**（三条路都通）：
  - API 直连（本机桌面 API 驱动、云端账号模式与托管档都走 `server/runners/api.mjs` → `buildTools`）：`server/harness/tools/index.mjs` 包住 `send_message`，发给 user 就地答 `{ ok: true, shown: true }`，不经公告板；开放清单里没有 `send_message` 时补一个只能发给 user 的（`server/harness/tools/userMessage.mjs`）。云端开放清单（`cloud-tools.mjs`）本来就有 `send_message`，**没改 `cloud-tools.mjs`，也没改 `mcp-tools.mjs`**。
  - 经 MCP 的 CLI 驱动（Claude Code、agy、codex）：调用落到公告板 `server/agent/agent-board.mjs` 的 `sendMessage`，加了 `to === 'user'` 直接答「已显示」两行。**这个文件不在任务书的清单里**，也不在另两位子 Agent 的清单里；它是 `send_message` 的执行处，改动只有这两行，单独列出供主会话取舍。
- **执行规则与提示词**：`server/harness/agent.mjs` 拼给模型的执行规则在有 `send_message` 时改成「每组操作前调用 send_message（to 填 "user"）用一两句话告诉用户接下来要做什么，做完一组再用它说一句做好了什么；和这一组的工具调用放在同一次回复里；收尾仍调 final 为 true 的 report_progress」。`server/ai-system-prompt.md` 的「向用户汇报」开头一段和第 38 条 `send_message` 改写（见下）；`server/runners/claude.mjs`、`agy.mjs` 的工具对照表各加一行。说过话（send_message 发给 user 成功）的一轮，最后一次空回复不算「API 没有返回文字」。
- **气泡里显示什么**（`src/ai/userMessages.ts` 的 `sayingsOf`）：这一轮调过 `send_message`（发给 user、没失败）的，按先后列出它们的 `text`；一次都没调的，用文字回复（相邻文字并成一句，被工具隔开的分成几句）。两种不混：调过的那一轮，文字回复只在「显示思考」里看得到，免得同一句话出现两遍。气泡里另有：在跑时的转圈与「正在做什么」、出错、停下、云端渲染进展；一轮没说话但做了操作时写「做了 N 次操作，详见下方「Agent 操作」」。
- **和 autoReport 对一下，留一种**：上一轮（`AGENT-agent-run-reliability.md`）加的「没交收尾汇报就按文字回复代交一份」会让同一段文字在气泡（文字当一句话）和汇报（代交的 done 条目）里各出现一次。留的是界面这一种：撤掉 harness 里的代交（`requireFinalReport` 选项与 `reportItemsFromText` 一并去掉，`api.mjs` 不再传）。理由：界面这一种对所有驱动都成立（CLI 驱动从来没有代交）；轮数到顶的收尾摘要原来代交的「问题」那条，和气泡里的结局行「已达到本次模型往返轮数上限……」重复，也一并不再代交。原先「交过收尾汇报后最后一次空回复不误报」保留。
- 端到端测试里为代交多出来的那条 `report_progress` 期望去掉（`account-master-production`、`account-real-runner`、`account-runner-process`、`cloud-agent-look`、`cloud-agent-page`、`cloud-agent-tools`），按 `synthetic` 或名字排除的那几处过滤保留不动（无害）。`cloud-agent-look.test.mjs` 可能也在查 see_frames 那位子 Agent 的范围里，我只改了两行期望，合并时留意。

## 补：工具出错时调试信息交给模型

- `server/harness/agent.mjs` 新增 `toolErrorResult(err)`：给模型的 tool_result 是 `{ error, code?, debug? }`。`debug` 是对象时转 JSON，字符串照原样；键名像密钥（token、secret、password、authorization、cookie、ticket、credential、signature、api_key、private_key、key、bearer）的值换成「[已隐去]」，值里像凭证的（Bearer 头、`sk-` 形状的 Key、`v1.` 票据、JWT）也换掉；整份截到 2000 字（`TOOL_DEBUG_CHARS`），超出注明「已截断」。界面的 tool_result 事件同样带着它。
- 测试在 `server/test/agent-user-message.test.mjs` 最后一项：直接测函数（带 code、debug 里的卡片与行号保留、四种凭证都被隐去、超长截断、没有 debug 时只有 error），再走一遍 `Agent.run`，断言下一次请求里模型看到的 tool_result 带着 debug。

## 3. 语义改动（改前 / 改后）

`docs/semantics/product/agent.md`「汇报」第一条：

- 改前：「Agent 的文字回复不直接展示给用户。它通过结构化的进度汇报交代做了什么、还有什么没做、遇到了什么问题。」
- 改后：「对话气泡里只展示 Agent 在做什么：Agent 每组操作前后用一两句话告诉用户接下来要做什么、做好了什么，气泡里按顺序显示这些话；它没有专门对用户说话、只回了文字时，那段文字当作一句「在做什么」显示。做过的操作和结构化的进度汇报（做了什么、还有什么没做、遇到了什么问题）不放在气泡里，放在气泡下方按轮显示的操作区，只显示这个对话自己的操作（2026-10-20 用户定，原话「……」；取代原来的「……」）。」

`docs/semantics/mechanism/agent.md`：在「桌面 APP 接入」前新增「## 汇报与对用户说话（2026-10-20 用户定）」四条：工具与三条执行路径、执行规则、气泡取话的规则与撤掉代交、操作区按轮显示只取本对话、不再合并气泡。

**和一级语义的冲突，交回主会话**（一级不在我的文件范围，没改）：

- `user-workflow.md` 第 74 行：「Agent 的文字回复不显示给用户。用户看到的是 Agent 交上来的进度条目（做了、待办、问题）和操作详细预览。」——现在气泡里显示 Agent 用 send_message 说的话，没调时显示文字回复。建议改成：「对话气泡里显示 Agent 说的在做什么（它用 send_message 对用户说的话；没说时是它的文字回复）。进度条目（做了、待办、问题）和操作详细预览在气泡下方的「Agent 操作」里按轮显示。」
- `workflow/editing.md` 第 15 行「AI 栏显示 Agent 的进度条目和操作详细预览：看过的图、改动前后的动图、参数差异。」仍成立（位置从气泡挪到下方），可补半句「在气泡下方的「Agent 操作」里，按轮显示」。

`server/ai-system-prompt.md`「向用户汇报」开头：

- 改前：「你的文字回复**用户默认看不到**。用户在聊天栏里只看得到你通过 `report_progress` 交上来的条目:做了什么、还有什么没做、遇到了什么问题。」
- 改后：用户看到两样——气泡里是你用 `send_message`（`to: "user"`）说的「在做什么」（每组操作前后一两句，和工具调用同一次回复，不报工具名参数）；下方「Agent 操作」里是操作和 `report_progress` 的条目。只回文字时文字原样当一句显示，要说的话用 send_message 说、文字留空，不要两边各说一遍。后面「什么时候调 report_progress」等条目不变。

## 文件清单

| 范围 | 文件 |
|---|---|
| harness | `server/harness/agent.mjs`、`server/harness/tools/index.mjs`、`server/harness/tools/userMessage.mjs`（新） |
| 运行器 | `server/runners/api.mjs`、`server/runners/claude.mjs`、`server/runners/agy.mjs` |
| 工具定义 / 执行 | `server/tools/agent.mjs`、`server/agent/agent-board.mjs`（清单外，两行） |
| 提示词 | `server/ai-system-prompt.md`（「向用户汇报」开头、第 38 条） |
| 页面 | `src/ai/userMessages.ts`（新）、`src/editor/right/chat/ActivityPanel.tsx`（新）、`src/editor/right/chat/rowPlan.ts`（新）、`src/editor/right/chat/AgentBubble.tsx`、`src/editor/right/chat/MessageList.tsx`、`src/editor/right/chat/agent.css`、`src/editor/right/AiPanel.tsx`、`src/editor/right/CloudAiPanel.tsx` |
| 语义 | `docs/semantics/product/agent.md`、`docs/semantics/mechanism/agent.md` |
| 测试 | `server/test/agent-user-message.test.mjs`（由 `agent-final-report.test.mjs` 改名重写，11 项）、`src/ai/user-messages.test.mjs`（新，3 项）、`src/editor/right/chat/row-plan.test.mjs`（新，3 项）；改期望：`account-master-production`、`account-real-runner`、`account-runner-process`、`cloud-agent-look`、`cloud-agent-page`、`cloud-agent-tools` |

## 验证

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误（最后一次在 `8de62190` 之后跑） |
| 全量测试 | `npm test`（命令里设 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT`、`PROMPTCUT_PASSWORD_ORDER_MODULE`） | 7142 项，通过 7127，跳过 14，失败 1：`server/test/asset-project-workers.test.mjs` 的「真实ffmpeg项目worker独立转码/登记……」`test timed out after 20000ms`（满负载下真 ffmpeg 转码超时，和本分支无关）。这个文件单独重跑 3 次，每次 11/11 通过 |
| 新增单测 | `node --test server/test/agent-user-message.test.mjs`、`src/ai/user-messages.test.mjs`、`src/editor/right/chat/row-plan.test.mjs` | 11/11、3/3、3/3 |
| 生产真实事件喂折叠 | 只读取节点上这个对话的 84 行事件与账本队列，在本机喂 `applyCloudEvent` + `settleFromQueue` | 消息顺序正确（见第 4 条），证明折叠没错、问题在画 |
| 看图 | 本机临时页面（`out/visual-activity/`，不入库；vite 5330，用完已停）用这 84 行真实事件 + 账本队列渲染 `MessageList` 与「Agent 操作」 | 见下 |

看过的图（Browser pane 截图）：

1. 真实事件：失败回复里只有「云端执行这一轮的进程出了故障……」；「好」单独一个气泡在第二条用户消息后；第三轮的文字在第三条用户消息后、自己的气泡里；底部「Agent 操作　第 3/3 轮 · 7 次操作」显示读取 ×4、添加、出错、修改图标和本轮小结卡（已完成三条、问题一条）。
2. 点第一条失败回复：气泡描边，底部切到「第 1/3 轮 · 0 次操作」，「回应：请在时间轴上加一张标题文字卡……」「这一轮没有操作」。
3. 加一轮在跑的演示（两次 `send_message(to user)` + see_frames、update_clip、list_cards、add_clip）：底部自动跟到「第 4/4 轮 · 4 次操作 · 进行中」，图标只有那 4 次（send_message 不算操作）；气泡里按顺序两句「先看一下开头几秒的画面，找个不挡人的位置。」「标题卡挪到左上角了。接着加结尾卡。」，下面转圈「正在执行 add_clip…」「第 3/24 轮 · 34 秒」。
4. 看图时发现「回应：……」那行被压成 0 高（正文超出最大高度时 flex 子块被压扁），已修（`8de62190`），修后在第 2 张图里可见。

没跑的：渲染附加项不适用（没改画面）；托管环境的整套浏览器探针（`cloud-agent-ui-probe` 等）没跑，原因见「部署」末条。

## 部署（主会话做）

- **服务端要换的文件**（Agent 代码树，节点上用 `systemctl show promptcut-agent promptcut-agent-root -p ExecStart` 确认目录）：`server/harness/agent.mjs`、`server/harness/tools/index.mjs`、`server/harness/tools/userMessage.mjs`（新）、`server/runners/api.mjs`、`server/tools/agent.mjs`、`server/agent/agent-board.mjs`、`server/ai-system-prompt.md`。`server/runners/claude.mjs`、`agy.mjs` 只影响本机 CLI 驱动，节点上换不换都行（一起换保持同一提交）。
- **重启**：任务进程每代新开，换完文件后下一条任务就用新的 harness、工具与提示词。`promptcut-agent`（主服务）载入了 `mcp-tools.mjs` → `tools/agent.mjs`、以及托管档的 `instance.mjs` → `agent-board.mjs`，建议在没有任务在跑时重启一次，让工具清单与公告板一致。`promptcut-agent-root` 不载这些文件，不用重启。文档服务、渲染服务不涉及。
- **在线前端要重建**：`src/**` 改了，`vite build --mode online` 重建在线构建（`/opt/promptcut-hosted/editor`）再换上。
- **新旧组合**：新服务端 + 旧前端：模型会调 `send_message(to user)`，旧前端把它当一次「Agent」类操作画成图标，汇报照旧；不出错。旧服务端 + 新前端：模型不调 send_message，气泡显示文字回复，操作在底部；也不出错。没有数据格式变化。
- **部署后验证**：在测试项目里发「在时间轴开头加一张标题文字卡」，气泡里应出现一两句「先……」「……好了」，底部「Agent 操作」显示这一轮的图标与本轮小结；发「请只回复一个字：好」，气泡里是「好」，底部「这一轮没有操作」。
- **回滚**：服务端把备份的文件拷回、重启 `promptcut-agent`；前端换回上一版在线构建。两边可以分别回滚。
- 探针已跟着改（见文末「第二轮」）。

## 没做成的与原因

- 没有用真实模型跑新提示词（看模型会不会按规则调 send_message）：本机网关只有 Gemini，这轮没跑；部署后按上面的验证步骤在节点上看。

## 对任务书的更正

- 「失败补位的 id？runId 复用？折叠时按什么找助手消息？」三处都查过，都不是原因；原因是画的时候的「合并气泡」，见第 4 条。

## 第二轮（主会话审后追加：探针与 user-workflow.md）

### 探针与库（`scripts/probes/`；`scripts/acceptance/` 里 grep 不到 `agent-event-log` / `agent-event`，没有要改的）

| 文件 | 改了什么 |
|---|---|
| `cloud-agent-ui-lib.mjs` | `eventLog()` 换成 `activity(page)`（读 `[data-pc="agent-activity"]`：第几轮 / 共几轮、这一轮几次操作、是否进行中、图标、此刻画出来的撤销按钮）和 `undoLatestStep(page)`（从最后一个写入类图标往前点，在那一页上点最后一个可用的「撤销这步」，等它变「已撤销」） |
| `cloud-agent-ui-probe.mjs` | O1：「Agent 操作」显示的是这个对话最新一轮、4 次操作；在面板里撤销最后一步，项目内容变回去。O4：从历史点开后，操作次数改读面板（面板按轮显示，图标同类会合并，不能再数图标个数） |
| `cloud-agent-ux-ui-probe.mjs` | A4 / RA4：bob 的「Agent 操作」里不混进创建者那个对话的操作（原先断言 bob 在「Agent 操作记录」里看到创建者的每一步、署名对）；A7 / RA7：创建者在面板里撤销最后一步；B1：「改动一条条出现」改为数 bob 页面里项目变了几次，署名由原有的成员列表那一项核对（「〈创建者〉的云端 Agent」） |
| `account-real-runner-probe.mjs` | 汇报文字改在「Agent 操作」里找（先点小结图标翻到那一页） |
| `account-executor-visible-probe.mjs` + `fixtures/account-executor-visible/page.tsx` | 页面加上 `AgentActivityPanel`；「工具可见」改在面板里找 |
| `chat-window-probe.mjs` | 三轮假流回复各占一个气泡（3 + 3 = 6 行，原先合并成 4 行） |

另外补了一处界面：操作详细预览的画面页（修改、参数差异）原来没有「撤销这步」，只有无画面的操作卡页有；原先靠底部「Agent 操作记录」每行都能撤，换掉之后有画面的那几步就撤不了。现在画面页右上角也挂上 `AgentUndoButton`（`OpDetailPreview.tsx`、`agent.css`）。

跑过的：

- `node scripts/probes/chat-window-probe.mjs --port 5330`（占 5330～5332）：19 项全过（`failed: 0`）。看了截图 `6-small-chat.png`：右侧 AI 栏底部是「Agent 操作　第 3/3 轮 · 1 次操作」，回应那一行、读取图标、操作卡都在。截图里也看到窗口矮（AI 栏约 480 像素高、上面还有一条「Claude Code 还没登录」横幅）时，「Agent 操作」把对话列表挤得只剩一小截；把正文最大高度从 45vh 改成 30vh。是否还要再收（比如缺省折起、或预览更小）留给用户看实际效果定。

没跑的与原因：

- `cloud-agent-ui-probe.mjs`：要从 `--base-port` 起连着 45 个端口，分给我的只有 5330～5339。
- `cloud-agent-ux-ui-probe.mjs`：同样要一大段端口（编辑器、两个舞台、桌面版、渲染服务三个工作端口与诊断口、文档 / 素材 / Agent 服务），超出分配。
- `account-real-runner-probe.mjs`（固定 6708 等）、`account-executor-visible-probe.mjs`（固定 6640～6643）：端口写死，不在分配段里。
- 这几支都只做了 `node --check` 语法检查。主会话集成时跑。

**交回主会话一件事（功能面）**：原「Agent 操作记录」是 AI 栏里唯一一处能看到别的成员的云端 Agent 每一步操作和署名的地方。现在 AI 栏只显示自己正在看的对话；共享项目里别人的 Agent 改了什么，在 AI 栏里看不到逐步记录了（署名仍体现在成员列表「〈用户名〉的云端 Agent」、`RemoteAgentsStrip` 的「谁在改哪儿」、覆盖提示「由 X 修改」）。用户原话是把那块换掉，我照做了；如果用户还想在某处看别人的 Agent 逐步记录，要另定位置。

### `docs/semantics/user-workflow.md` 第 74 行（「进度可见」第一条）

- 改前：「Agent 的文字回复不显示给用户。用户看到的是 Agent 交上来的进度条目（做了、待办、问题）和操作详细预览。」
- 改后：「对话气泡里显示 Agent 说的在做什么（它用 send_message 对用户说的话；没说时是它的文字回复）。进度条目（做了、待办、问题）和操作详细预览在气泡下方的「Agent 操作」里按轮显示（2026-10-20 用户定，原话「把Agent操作记录哪里换成气泡里面那个可视化组件。气泡里面只展示在做什么（harness可能要改，比如加入send_message(user,xxx)的用法。）。」；取代原来的「Agent 的文字回复不显示给用户。用户看到的是 Agent 交上来的进度条目（做了、待办、问题）和操作详细预览。」）。」
- 第 75 行（桌面 APP 的 Agent 文字输出拿不到、按 SKILL 汇报）没动：桌面 APP 会话的分组显示不在这次改动里。

验证：`npx tsc -b --force` 退出码 0。按主会话说的没再跑全量。

## 第三轮（主会话在集成分支上跑探针后：对照与修复）

先把 `claude/accept-018-fixes`（`3f8375e4`，含 see_frames 分支与「账号项目两个托管开关缺省开」）用 `--no-ff` 合进本分支（`d8a041c3`）。对照基线是改动前的 `c5285cfc`：另建临时 worktree `.worktrees/pa-base`（detached，没建 junction；里面的 `node_modules` 只有 Vite 缓存，是普通目录），两边都 `vite build --mode online` 现打在线构建，同一命令、同一端口各跑一遍。用完已 `git worktree remove`。

| 探针 | 改动前 `c5285cfc` | 本分支（修后） | 结论 |
|---|---|---|---|
| `account-executor-visible-probe` | —（主会话在集成分支上已 7/7） | 7/7，`completed: true` | 通过 |
| `cloud-agent-ui-probe --base-port 29003` | 29 项失败 3：O1（多出代交的 `report_progress`）、O4 两项 | 28 项全过（`failed: 0`） | 集成分支上卡在 `enabled('[data-pc="cloud-agent-enable"]')` 是**这次合进来的「开关缺省开」引入的**：新建的账号项目直接开着，页面上没有「开启云端 Agent」按钮了。探针改成先看开关状态，关着才点。O4 改成先点回 O1 那一轮的气泡（「Agent 操作」缺省显示最新一轮，O1 后面还有别的轮次）。O1 在基线不过是旧的代交汇报，本分支已撤掉 |
| `cloud-agent-ux-ui-probe`（缺省端口） | 15 项失败 7：D A2、D A3、D A5、D:点开后完整过程都在、D A6、接入方式里有可选的「云端」、探针自己没出错 | 14 项失败 5：D A3、D A5、D A6、接入方式里有可选的「云端」、探针自己没出错 | 剩下 5 项**原来就不过**（基线同样失败），本分支没有引入新失败，还修好两项（A2 多出代交汇报、A6 的「完整过程」）。原因见下 |
| `account-real-runner-probe` | `completed: false`，停在 `expand-actual-output-b` | `completed: true`，17 项，退出码 0 | 集成分支上第 19 行抛 `private-output-and-site-required` 是调用方式：这支要带 `--site-root <VisuHive/site>`，`--out` 要在系统临时目录下。带上以后停在 `enable`，同样是「开关缺省开」引入的，探针已同样改法修好 |

`cloud-agent-ux-ui-probe` 原来就不过的 5 项：

- **D A3 / D A5 / D A6**：同一个原因。三项断言都靠「本机这套托管组合里的渲染服务把被改的重卡渲出来、入库」：A3 读渲染服务诊断口的完成数，两边都是 `completed: [0, 0]`、素材文件数 `1 → 1`；A5 播放时没有贴快照（`stage: null`、层表空）；A6 其余全过（同一项目、历史里找得到、20 次工具调用全成功、回复与「云端渲染完成」都在、项目是最新版本），只有 `prerender.ok: false`（`layers:<项目>` 的层表存在但是空的）。对话里的 `render` 事件照常是 `published → done`，也就是说 Agent 一侧认为交了，但渲染服务这边没干活。基线上一模一样，和本任务无关（预渲染与渲染服务不在我的范围），没往下查。
- **接入方式里有可选的「云端」 / 探针自己没出错**：在线浏览器那一遍（步骤 online）里，页面上没有 `[data-pc="ai-provider"]` 这个下拉，`selectCloud` 第 240 行 `page.select` 找不到元素就抛错，后面的步骤都没跑。基线同样如此。推测是这套局域网托管档的在线页面后来不再出接入方式下拉（账号模式的探针里是「只有云端一项的下拉」），探针还按旧界面写；没在范围内改。

截图：本分支 `%TEMP%/pa-ux-new/`、基线 `%TEMP%/pa-ux-base/`；ui 探针 `%TEMP%/pa-ui-new2/`。

本轮提交：`a24a53bc`（ui 探针：开关缺省开）、O4 点回那一轮、`account-real-runner` 探针：开关缺省开。之后 `npx tsc -b --force` 退出码 0；三份新增单测 17/17。按主会话说的没再跑全量。
