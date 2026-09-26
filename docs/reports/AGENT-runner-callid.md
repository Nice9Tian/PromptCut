# AGENT-runner-callid 报告

任务：让 codex、agy 两路 Agent 的工具调用也带上 `callId`（修 C6.5 遗留：`docs/reports/REPORT-C6.5.md` 第 6、8 节「codex、agy 两路拿不到 callId，它们的调用只能在 Agent 操作记录里撤」）。C6.5 指「Agent 服务端项目副本与工具调用事件」那一阶段；`callId` 是模型那一侧这次工具调用的 id，页面 AI 栏按它把文档服务的工具调用事件对上聊天记录。

分支 `claude/runner-callid`，worktree `.worktrees/runner-callid`，起点 main `8a5d6ff`。

## 状态

进行中。
