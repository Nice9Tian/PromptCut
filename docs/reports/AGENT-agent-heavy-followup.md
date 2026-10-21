# AGENT-agent-heavy-followup

分支 `claude/agent-heavy-followup`（自 main `b88dbdec`），worktree `.worktrees/agent-heavy-followup`。未推送、未合并、未部署。

## 任务

线上（2026-10-21，部署 b88dbdec）发现「云端 Agent 只发布重卡」的两个问题：

1. 判定结果在线上看不到：任务进程的 `log` 没接到任何输出，主服务日志只有 `agent.publish.plan` / `agent.render.published`。
2. 刚改过参数的卡一律判重：新成本身份没有记录，按兜底（非 direct 判重）照发。

（进行中，终稿另行提交。）
