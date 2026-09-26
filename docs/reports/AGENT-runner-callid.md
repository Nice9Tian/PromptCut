# AGENT-runner-callid 报告

任务：让 codex、agy 两路 Agent 的工具调用也带上 `callId`，修 C6.5 的遗留（`docs/reports/REPORT-C6.5.md` 第 6、8 节：「codex、agy 两路拿不到 callId，它们的调用只能在 Agent 操作记录里撤」）。C6.5 是「Agent 服务端项目副本与工具调用事件」那一阶段。`callId` 是模型那一侧这次工具调用的 id，页面 AI 栏按它把文档服务的工具调用事件对上聊天记录里的那一条，对上了，聊天记录里的操作卡才出现「撤销这步」。

分支 `claude/runner-callid`，worktree `.worktrees/runner-callid`，起点 main `8a5d6ff`。

## 1. 查到的原文

2026-09-27 在本机实录，版本为 codex-cli 0.156.1、agy 1.2.11。探针是 scratchpad 里一个最小的 stdio MCP 服务，它把收到的每一行原样记下来，不进仓库。每家只问了一个最简单的读工具，再加 agy 续跑一轮，用来确认步号是否会重号。原文里没有凭证，用户目录已换成 `<user>`。

### codex

codex 发给 MCP 的 `tools/call`（`-c mcp_servers.probe.*` 临时注册，不改任何配置文件）：

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"_meta":{"callId":"exec-ba81ac03-fea9-48f1-85a9-4ec13937f9f9","x-codex-turn-metadata":{"session_id":"01a0e00b-4a61-7e70-af46-a8cf5a166523","thread_id":"01a0e00b-4a61-7e70-af46-a8cf5a166523","reasoning_effort":"low","turn_id":"01a0e00b-4a9a-7c10-8644-674679b27b6e","model":"gpt-6-astra","thread_source":"user","turn_trigger":"exec","sandbox":"none","sandbox_mode":"read-only","auto_review_enabled":false,"node_repl_auto_review_required":true,"node_repl_disabled":false,"turn_started_at_unix_ms":1790465231519,"codex_version":"0.156.1"},"threadId":"01a0e00b-4a61-7e70-af46-a8cf5a166523","sessionId":"01a0e00b-4a61-7e70-af46-a8cf5a166523","windowId":"01a0e00b-4a61-7e70-af46-a8cf5a166523:0","itemId":"ctc_0caa429e5666034f016ab854d340e887d08ba42bd7148af1b0","progressToken":1},"name":"get_answer","arguments":{"key":"alpha"}}}
```

第二次调用的 `_meta.callId` 是 `exec-59b61a7d-…`，但 `itemId` 与第一次**相同**，所以不能用它区分调用。

`codex exec --json` 输出流里对应的条目：

```json
{"type":"thread.started","thread_id":"01a0e00b-4a61-7e70-af46-a8cf5a166523"}
{"type":"item.started","item":{"id":"item_0","type":"mcp_tool_call","server":"probe","tool":"get_answer","arguments":{"key":"alpha"},"result":null,"error":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_0","type":"mcp_tool_call","server":"probe","tool":"get_answer","arguments":{"key":"alpha"},"result":{"content":[{"type":"text","text":"answer for alpha is 42"}],"structured_content":null},"error":null,"status":"completed"}}
{"type":"item.started","item":{"id":"item_1", ... "arguments":{"key":"beta"} ...}}
```

结论：输出流里只有 `item_N`（每次起 codex 都从 0 数），`_meta` 里的 `exec-…` 在输出流里找不到。两边共有的只有 thread id、工具名和参数。这次让它「并行」调两次，它仍是串行执行的，`item_0` 结束后 `item_1` 才开始。

### agy

agy 发给 MCP 的 `tools/call`：

```json
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"_meta":{"antigravity.google/artifacts_dir":"C:\\Users\\<user>\\.gemini\\antigravity-cli\\brain\\5b290f32-0511-401d-8e85-30ceb9cbd662","antigravity.google/conversation_id":"5b290f32-0511-401d-8e85-30ceb9cbd662","progressToken":"29d2aeee-8ff2-4280-9aec-237872d543e5:2"},"name":"get_clip","arguments":{"clip_id":"c1","id":"c1"}}}
```

`--output-format stream-json` 输出流里对应的条目：

```json
{"event":"step_update","step_update":{"conversation_id":"5b290f32-0511-401d-8e85-30ceb9cbd662","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"call_mcp_tool","tool_info":{"name":"call_mcp_tool","parameters":{"Arguments":{"clip_id":"c1","id":"c1"},"ServerName":"promptcut","ToolName":"get_clip"}}}}
```

第二次调用的 `progressToken` 是 `…:3`，对应 `step_index` 3。用 `--conversation` 续跑同一对话后，下一次调用的 `progressToken` 是 `29d2aeee-…:8`（uuid 前缀没变），对应 `step_index` 8：续跑时步号接着涨，不会重号。

结论：`progressToken` 冒号后面的数就是输出流的 `step_index`，`conversation_id` 两边一致。据此可以精确配对。

探针过程中临时改过 agy 的全局 MCP 登记。登记内容先备份，两次探针用完都立刻 `agy mcp add` 改回原值，再逐字节比对 `~/.gemini/config/mcp_config.json`，结果一致。

## 2. 做法

两家都不带可以直接用的 id，所以走「runner 报到、MCP 调用认领」的配对路线。

- `server/agent/call-pairing.mjs`（新）：配对表。runner 在输出流里看到一次 PromptCut 工具调用开始时调 `announce`，登记范围、工具名、参数和它发给页面的 callId；`/api/mcp/call` 进来的调用用 `claim` 认领。范围是 codex 的 thread 或 agy 的对话，比 Agent 页更窄。规则是**宁可不配，不许配错**，配不上就退回原来的行为（事件不带 callId，只能在操作记录里撤）：
  - agy 带提示（按步号拼出的 callId）时只认那一条，而且工具名和参数也要一致；提示格式哪天变了，结果是配不上，不会退回按参数去猜。
  - codex 按工具名加参数配对（参数先按键排序再比）。同一范围里只有一条未认领的报到时才配；有两条以上，即同名同参并行，就不配。
  - MCP 那边先到时等报到：范围已知最多等 2 s，未知的只等 0.3 s。等待期间同一把钥匙又来了第二个认领者，也算分不清，两个都不配。
  - runner 看到调用结束就调 `settle` 删掉这条报到（没被认领的也删），运行结束把报过的全删。这样挂着的报到只有正在进行的调用，不会挡住后面同名同参的调用。
- `server/runners/codex.mjs`：`tool_call`、`tool_result` 带 `callId = cx-<这次运行的随机段>-<item.id>`，并报到到范围 `codex:<thread_id>`（只报 `server` 为 promptcut 的条目）。
- `server/runners/agy.mjs`：`tool_call`、`tool_result` 带 `callId = agy:<对话>:<step_index>`，PromptCut 的 MCP 调用报到到范围 `agy:<对话>`。
- `server/mcp-server.mjs`：`pairingOf(_meta)` 把 codex 的 `threadId` 转成 `pair.scope`，把 agy 的 `conversation_id` 和 `progressToken` 步号转成 `pair.scope` 与 `pair.hint`，交给 `/api/mcp/call`。Claude 的 `claudecode/toolUseId` 照旧处理，这时不带 `pair`。函数写在文件内、没有抽成模块，因为这份脚本会被复制进 Skill 任务目录单独运行（`server/vite-plugin-skill.ts`），多一个相对 import 就会断。
- `server/vite-plugin-ai.ts`：建一个配对表，经 `opts.callPairing` 交给 runner；审查环路走 `cli-loop` 时 baseOpts 会原样传下去，所以那条路也有。`/api/mcp/call` 在没有 callId、带 `pair`、**且绑了项目副本**时认领；没绑时事件不发，也就不等。
- 页面不用改：`useAiChat` 和 `runRoleTask` 已经按 `callId` 盖章，`OpDetailPreview` 已经按 `t.callId` 找撤销记录。附带的好处是：codex、agy 并行调同名工具时，结果不会再只按名字盖错行。

为什么不直接用 CLI 的 id：codex 的 `_meta.callId` 输出流里没有；agy 那边虽然能拼出确定的 id，也仍然经配对表核对一遍工具名和参数，防止 `progressToken` 的含义以后变了而配错。

剩余风险（只在 codex 上）：两个同名同参的调用真正并行，而且一个调用的 MCP 请求比另一个在输出流里的开始行先到，这时两者可能互换。互换的两条工具名、参数完全相同。这次实测 codex 的 MCP 调用是串行的。agy 走提示配对，不受影响。

## 3. 验证

- 新单测 `server/test/runner-callid.test.mjs`，夹具是第 1 节录下的两家输出流和 `_meta`，已去掉凭证。共 11 条：两种先后顺序、同名同参并行不配（报到在前、认领在前两种）、同名同参先后各配各的、配对失败的退化（参数、工具名、范围不一致，报到已结清，范围未知只短等）、agy 提示只认那一条、codex 与 agy runner 按实录流跑通、不接编辑器时照常运行、mcp-server 转发 `pair`。
  `node --experimental-test-module-mocks --test server/test/runner-callid.test.mjs server/test/mcp-callid.test.mjs server/test/agy-denied.test.mjs server/test/agy-stdin.test.mjs server/test/codex-tool-errors.test.mjs server/test/codex-mcp-permissions.test.mjs server/test/mcp-bridge-timeout.test.mjs` → tests 41、pass 41、fail 0。
- `npx tsc -b --force` → 退出码 0，零错误。
- `npm test` → 退出码 0：tests 2973、pass 2972、fail 0、skipped 1。跳过的是 `集成:/api/cards/layout 对真实项目返回整数框`，它需要 5190，按约定跳过。
- 真实端到端：在本 worktree 起 dev server，端口 5680（舞台端口 5681、5682），`PROMPTCUT_DATA_DIR` 和 `TEMP` 都指向 scratchpad，没有改写全局 `port.json`。在浏览器面板打开 `?editor`，页面绑上项目副本（`/api/agent/status` 显示 `bound: true`）。然后在 AI 栏里分别用 Codex、Antigravity 各发一条「只调一次 add_track」。这里用的是写工具，因为只有写操作才有「撤销这步」，能从页面上直接看出配没配上；读工具只能从事件里看。
  - Codex：输出流里是 `item_1` 的 `add_track`。聊天记录里 add_track 的操作卡（`[data-pc="op-card"]`）里出现了 `[data-pc="agent-undo"]` 按钮「撤销这步」，截图已看过。只有 `agentOpFor(t.callId)` 按 SSE 带来的 callId 找到了文档服务事件的撤销记录，这个按钮才会出现。点下去变成「已撤销」；之后用 `/api/mcp/call get_project` 查副本，rev 3，轨道只剩「序列 1」「序列 2」，撤销已落到文档服务。
  - agy：输出流里 `step_index` 2 是 `add_track`。聊天记录里对应的操作卡同样出现了「撤销这步」，截图已看过。
  - 跑 agy 时，runner 按现有逻辑把 agy 的全局 MCP 登记改成了本 worktree 的脚本。跑完立刻改回原值，逐字节比对一致。
  - 收尾：已关掉浏览器页，结束自己起的 dev server 进程树（pid 27188 及其子进程），删掉临时目录。dev server 和测试在 worktree 里生成的忽略目录（`node_modules/.vite*`、`out/`、`.pc-chats/`、`data/`）确认不是 junction 后也删了；主仓库的 `node_modules` 完好。

## 4. 没做成的，以及顺带看到的

- 读工具的端到端只在探针和单测里验证了，页面上验证用的是写工具，原因见上。
- **观察到一处不属于本任务的现象，没有查，也不在我能改的范围内**：在 codex 那条 add_track 的操作卡上点「撤销这步」后，文档服务的副本已经没有「测试轨道」（rev 3），但页面时间轴仍显示这条轨道，状态栏也还是「序列 3」，直到下一次改动（agy 新建轨道）到达才刷新掉。这可能是撤销后页面没有重新渲染，涉及 `src/editor/sync/`，那块归另一个任务。建议主会话转给相关任务确认。
- 截图里 agy 那张操作卡显示在触发它的那条用户消息上方（在 assistant 消息的操作轮播里）。这是布局问题，不影响配对，没有深究。

## 5. 对语义或设计的更正建议

- `docs/plan/c65-design.md` 第 7 节 D2 那句「codex、agy 那两路拿不到，只能在操作记录里撤」应当更新为：codex、agy 由 runner 在输出流里报到、MCP 调用按线索认领（`server/agent/call-pairing.mjs`）；配不上时退回只能在操作记录里撤。按任务书，这份计划文档不在我能改的清单里，所以没动。
- 第 2 节配对的阈值（等待 2 s 和 0.3 s）是三级机制，如需要写入语义，应放进 `docs/semantics/mechanism/agent.md`。本次没有改语义文档。

## 状态

完成，等主会话审查。
