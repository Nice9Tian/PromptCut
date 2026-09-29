# AGENT 报告：storage-cap

分支 `claude/storage-cap`，worktree `.worktrees/storage-cap`，起点 main `35f1fddd`，端口段 5710～5719。

任务：存储占用计划（`docs/plan/storage-plan.md`）的 B 部分——帧库使用索引、上限、按最近使用淘汰、清理缓存、`/api/storage*`。

## 进度

- [ ] 读代码，定设计
- [ ] 使用索引与记使用
- [ ] 上限与 `storage.json`
- [ ] 淘汰与清理缓存
- [ ] `/api/storage*`（预渲染进程实现、编辑器进程转发）
- [ ] 单测
- [ ] 探针
- [ ] 基线
