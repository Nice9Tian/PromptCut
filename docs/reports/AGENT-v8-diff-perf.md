# AGENT-v8-diff-perf 报告

分支 `claude/v8-diff-perf`（从 main `8a5d6ff` 建），worktree `.worktrees/v8-diff-perf`。
任务：把 `src/kernel/diffProject.ts` 对「整份深拷贝」输入的差异计算做快，让 V8（`docs/plan/c65-design.md` 验收表里的性能项：1000 个片段的项目，单次差异计算 ≤ 5 ms）有足够余量。输出必须与现在逐字节等价，不改门槛与量法。

（进行中）
