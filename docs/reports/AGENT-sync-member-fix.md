# AGENT-sync-member-fix

分支 `claude/sync-member-fix`（从 `claude/accept-final3` @6028555c 建出）。worktree 实际路径是 `.worktrees/.worktrees/sync-member-fix`（嵌套了一层，非本 Agent 所建）。

任务：修两处缺陷。
- 缺陷 1（探针检查 A7）：账号路径上 syncManager 发 `events.list` 不带 projectId，文档服务回「projectId 不合法」，重开页面看不到工具调用记录和「撤销这步」。
- 缺陷 2（探针检查 B1）：建项目的成员离线、他的云端 Agent 在跑时，别的成员看到「成员：1 人 · Agent：0 个」，没有「离线，Agent 在跑」那一行。

## 进度

（开工中）
