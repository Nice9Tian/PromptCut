# AGENT-ps1-bom：给含中文的 .ps1 加 UTF-8 BOM

分支 `claude/ps1-bom`（基于 main f119a66d），worktree `.worktrees/ps1-bom`。选型 sonnet-dev-high（维护项）。

## 任务

笔记本（系统 ANSI 代码页 GBK）上，Windows PowerShell 5.1 读不带 BOM 的 .ps1 按 ANSI 解码，不看 chcp。
三份随安装包 / 补丁 / 扩展包发给用户、含中文的脚本因此在中文系统上解析失败。给它们开头加 EF BB BF，并加守门测试。

## 进度

（开工提交；下面随各块提交补全）
