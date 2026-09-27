# AGENT 报告：perf-t4

分支 `claude/perf-t4`（从 main 2c7cee2），worktree `.worktrees/perf-t4`。端口段 5600～5609。

## 任务

修 tiers-probe 的 T4（后台上传期间页面主线程没有 > 50 ms 的长任务）在笔记本上 3 轮挂 2 的性能缺陷：
长任务 69 ms / 56 ms，都在一次 move 编辑之后 dtMs 0 开始，只在上传窗口出现，不上传的基线窗口没有。

## 进度

- [ ] 复现与剖析
- [ ] 修
- [ ] 单测
- [ ] 验证
