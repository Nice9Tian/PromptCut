# 独立任务 OS worker 交接接口

## 开工边界

工作区沿用 `018-cloud-queue-user-path` / `codex/018-agent-real-runner`，当前固定 `8be334966e721d3ea5d019f1a3307df55d0e1d3c` 干净。根已收回上包到 `a4d22ce3` 并占用 6700–6711 验证，本包不合 main、不改产品、不启动服务或模型，只新增本报告。

目标是把真实 HostedRunnerFactory 放进独立每任务 OS worker，以 Doc 签名 assignment、worker 自有 RAM dataKey 和 root 固定槽生命周期衔接 master 准入、执行、强制中止、关闭证明与 Doc 结算。现有 grant 不 transfer，master key 不发给 worker，supervisor 不代签 worker。

已向 Astra 约 Doc finalizer/provider 边界，后续设计列精确文件租约与未实现接口。所有技术选择标〔裁〕，不冒称用户逐字段批准；端口和两槽只用于实验，不成为生产默认容量。
