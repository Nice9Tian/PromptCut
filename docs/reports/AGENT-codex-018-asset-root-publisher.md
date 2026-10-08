# Asset root registry publisher

本包在 codex/018-asset-root-publisher、main 86c810a1 起点实施，仅拥有 publisher、新专用测试及本报告。旧 C10 dcc51 已推分支保持隔离，不修改产品 run-assets 权限接口。

目标：Linux root 外部监督者串行验证精确配置 asset unit 的旧 cgroup/PID 实际关闭，耐久 witness 后保留新 epoch，再以 systemd/kernel 与纯私有 TLS identity 双读发布 active registry。Windows 只做受控模块/CLI 拒绝验证，不伪称 Linux OS 证据。

固定协议参考：G 0cd94730 的 run-assets-current-registry.mjs；canonical hash 使用实际 account/ledger.mjs digestOf。producer 不写 doc checkpoint；root anchor 建立 epoch 1 信任起点，doc owner 必须验完整证据并先持久 checkpoint 后授权。

三级修改前：无 root producer，current 身份与历史关闭不能由同证书推断，生产 run-assets 保持 503。修改后：独立 root 配置精确 scope 的工具，非 active / witness / reserved / active 原子耐久阶段；任一歧义停止且留非 active，不以超时或 ENOENT 推断关闭。

尚未运行：Linux root/systemd/TLS、任何业务服务/监听器、全量；节点执行由 root 另租。
