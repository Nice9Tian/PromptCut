# AGENT 报告：claude/conflict-merge（0.7.19 冲突合并窗口）

分支 `claude/conflict-merge`，从 main `ca4fc432` 切出；worktree `.worktrees/conflict-merge`；端口段 5890～5899。

任务：固定非本机快照、断网保留（在线浏览器落盘至浏览器本地缓存）、重连后逐项合入面板——做出共用的「冲突合并」窗口。
语义出处：`workflow/editing.md`「撤销、重做」、`workflow/project.md`「暂时离线项目与保存」、`product/document-service.md`「冲突」「离线」、`mechanism/document-service.md`「保存基准与修改状态检查」。

## 进度

- [ ] 读规则、语义与现状
