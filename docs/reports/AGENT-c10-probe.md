# AGENT 报告：c10-probe（C10 其余 L1 / L2 可行性探针）

分支 `claude/c10-probe`，worktree `.worktrees/c10-probe`，从 main `1dad2b7` 开出。端口段 5420～5429。

状态：进行中。

## 任务

为「C10 其余：在线浏览器模式 L1（后台舞台当预渲染者）/ L2（页面内快照库）」定方案做四项实测：

- P1 进程隔离与主文档长任务（D1）
- P2 后台舞台的节拍（D7）
- P3 IndexedDB 配额、吞吐与分区（D6）
- P4 跨源舞台读素材要不要 CORS

（下文逐项填写。）
