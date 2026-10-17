# AGENT-docservice-run-cpu 报告

## 任务目标

消除文档服务 `promptcut-doc-v2` 在运行素材轮询与权限检查热路径上的 94% CPU 瓶颈：
1. `server/account/run-authority.mjs`：为 `sync()` 与 `checkWithScope()` 增加 `needsReconcile` 只读快速路径，避免无新访问事件时每次调用都执行全量 `ledger.transaction`（`JSON.parse` / `JSON.stringify`）；收紧 `reconcileScopeClosures()` 的待结清任务过滤条件，避免活跃且未结束的任务反复触发 `503 run-forced-closure-pending` 事务回滚。
2. `server/hosted/run-assets-checkpoint.mjs`：在 `acceptCurrent()` 中当 `same(previous, first.checkpoint)` 成立时直接返回基于 `first` 的冻结快照，省去重复的 `current()` -> `read()` 磁盘读取。
3. 新建 `server/test/run-authority-readonly-fastpath.test.mjs` 验证只读快速路径与围栏同步语义。

## 进展

- [ ] 创建报告并完成初始提交
- [ ] 修改 `server/account/run-authority.mjs` 与 `server/hosted/run-assets-checkpoint.mjs`
- [ ] 新建并通过 `server/test/run-authority-readonly-fastpath.test.mjs` 及相关回归测试
