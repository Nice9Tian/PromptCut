# AGENT-query-render-2 报告

分支 `claude/query-render-2`，worktree `.worktrees/query-render-2`，起点 main `82294fea`。

状态：进行中。

任务：查询渲染（按 Agent 要求渲染画面、供 Agent 观察）剩下的差距与遗留——
1. 预渲染进程三种模式（D10：`PROMPTCUT_PRERENDER_MODE` = `user` / `agent` / `full`）；
2. 队列模式的认领闸（Agent 专用实例开着且空闲时本机节点多认领一项）；
3. 探针加 `PC_CHROME_ARGS` 透传以便取证；
4. R7b 遗留：更正折回 `r2-r7-task.md`；legacy 整帧通道调查与 dry run。
