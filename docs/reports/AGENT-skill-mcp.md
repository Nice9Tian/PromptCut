# AGENT-skill-mcp：A4 SKILL 改为桌面 APP 经 MCP 直连同一个项目

分支 `claude/skill-mcp`（起点 `claude/r5-merge` 的 `a77855df`），worktree `.worktrees/skill-mcp`。计划 `docs/plan/agent-workflow-plan.md` 的 A4（「Agent 与工作方式」计划的第 4 段：桌面 APP 里的 Agent 经 MCP 直接改用户正在用的那个项目），顺带 TODO「工作方式」的「去掉对话式布局」。

## 状态

进行中：开工。

## 未知数的结论（开工时查，只读用户的程序文件，没写任何用户配置）

1. **Claude Code 每个会话一个 stdio MCP 进程。** 本机 Claude 桌面版的「Code」每个会话是一个独立的 `claude.exe`（进程树里 `Claude.exe` 下挂着两个会话各一个 `claude.exe`），stdio MCP 服务由每个 `claude.exe` 自己起。`initialize` 的 `clientInfo` 是 `{ name: "claude-code", title: "Claude Code", version }`（在 `claude-code\2.1.284\claude.exe` 里查到 MCP 客户端就是这样构造的）。它支持 MCP 的 `instructions`（同一个二进制里有「MCP 工具说明与服务端 instructions 各 2048 字符上限」的说明）。`tools/call` 的 `_meta` 只有 `claudecode/toolUseId`（子 Agent 另有 `claudecode/agentId`），没有会话号——所以 Claude Code 按「一个 MCP 进程 = 一个会话」认。
2. **Codex 的 `clientInfo` 是 `codex-mcp-client`。** `codex.exe`（0.157.1）里 MCP 客户端名就是这个；它读 `~/.codex/config.toml` 的 `[mcp_servers.*]`（桌面版与命令行共用这份配置，桌面版内嵌的就是这个 `codex.exe`），所以 **Codex 桌面版能挂 MCP**，不用退回命令行那条路。每次 `tools/call` 的 `_meta` 都带 `threadId`（`docs/archive/agent-reports/AGENT-runner-callid.md` 有实录），所以 Codex 不管是不是多个线程共用一个 MCP 进程，都按线程认身份。`instructions` 在它的初始化结构里有字段，但查不到会不会交给模型，所以 SKILL 提示词不能只靠它（见下条）。
3. **SKILL 提示词放哪〔裁〕**：放 MCP 自己身上，不写用户级 skill 文件——`initialize` 回一段不超过 2000 字的 `instructions`（Claude Code 会拼进系统提示词），另外只在桌面会话的工具列表里多一个本地工具 `get_skill_guide`（「开工先调一次」，回完整的做法与汇报约定），这样 Codex 就算不读 `instructions` 也能从工具说明里知道。不写用户级文件就少一处要备份、要撤销的用户配置。
4. **没法区分会话的客户端〔裁〕**：Claude 桌面版的「聊天」（不是 Code）一个应用进程只起一份 MCP，所有聊天共用、`_meta` 里也没有会话号。本段不登记它；若以后要接，退路是「一个 MCP 进程算一个会话」（多个聊天会显示成同一组）。计划说的「会话开头领一个会话号、之后每次调用带上」要给所有工具加一个参数、并依赖模型每次都记得带，Claude Code 与 Codex 都用不上，不做。
