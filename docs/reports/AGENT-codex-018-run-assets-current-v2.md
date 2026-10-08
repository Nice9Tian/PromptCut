# 018 Run Assets 当前登记 v2：实施记录

- 工作区：`018-cloud-assets-central-glue`，分支 `codex/018-run-assets-current-v2`，起点 `8c1078f6b8df2087c2852e924826450ed6161167`。
- 本包仅接 doc 侧 root-owned asset 登记读/接受；Astra 冻结的纯 schema 源 `4b7b09dceaad5409fb697163f15500854b5879ed` 只按两份固定文件复制，不合其分支。
- v1 `run-assets-current-registry.mjs` 的现有导出语义保留；v2 明确分派，不把 v1 root 文件或 checkpoint 降级复用。
- root 已在 Linux systemd 249 独占 slice 实际验证父进程退出但子进程持 FD/TCP 时 populated=1 的拒绝、同固定 scope populated=0 与双 birth 消失/双 EOF，以及文件和目录持久化后释放。旧 ENODEV 失败是历史证据，不能记作 v1 通过；本叶不会自己制造 OS 见证。
- 尚未生产启用。缺完整 root-owned history、出版锁前后核验、root 初始 anchor、独立 SQLite v2 checkpoint 或耐久提交，持续返回 503；纯模块测试不代表生产资产已挂载。

## 接口与验证

待固定 schema、生产读路径、测试原始日志和剩余部署边界补入。不得修改账号权威、asset control、main 或节点，也不运行 full。
