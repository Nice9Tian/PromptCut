# AGENT-queue-maint

分支 `claude/queue-maint`（起点 main `98e042d0`），worktree `.worktrees/queue-maint`。端口段 5710～5719。

任务（主会话派，M7 遗留三条，出处 `docs/reports/REPORT-M7.md` 第 11 节、`docs/archive/agent-reports/AGENT-rq-m7-node.md`「没做成的」）：

- D：页面只是忙，不被 D2（队列锁闲置接手）接手；
- E：执行器按本机快照库的超限记录标 `snapshotOversize`；
- F：舞台互换时生成快照跟着后台位置走的专门剧本。

（进行中，逐块补写。）
