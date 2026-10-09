# 单运行 root 资源范围 producer

## 开工与边界

起点 95276dfbbce7fd25dd32e10999a6e6a4a21303af，承接单运行资源关闭设计报告的第三方案。实施裁定来自 root：固定受管 worker 槽、每代一个 run、原 OS 的 RAM key 登记，不同对话可并行。实验两个槽不构成生产默认槽数。

本包只实现 Agent 用途的 scope schema、root 生命周期发布器、可信文件只读 reader、专属纯测试及供 root 运行的 Linux 实验。不会改 run provider、instance authority、doc assembly、Sol 执行器或 finalizer。Asset v2 含义、记录与原有测试保留；不以整代 Asset 关闭代替单 run 关闭。

三级修改前：显式资源计数为零仍可能有未登记真实 workspace 子进程，缺独立 OS witness 时 FIFO 保持 pending。修改后：独占单代单 grant 的完整 service/slice 双身份，由 root 固定旧对象 FD 观察空并耐久发布；reader 只输出完整校验后的投影，不能由网络自由写 closed 行。

## 依赖与验证计划

当前叶未含 main 已有 Asset root publisher/schema 与专属测试。先读固定 main Git 对象，向 root 提交六条依赖原 blob 引入方案；不合整 main，不自行改其它产品。

安全链必须含显式 root 配置的 anchor、完整连续历史、单代单 grant、完整目标绑定、持久锁与 publication marker、固定旧 slice FD、真实 process birth 与 service/scope 身份。ENOENT/ENODEV 不算空；缺 marker、有锁、混配、回退、新空实例替旧实例均拒。

只运行授权 npm 专属与 Asset 回归、类型及语法检查；Windows 上不宣称 Linux root/cgroup 通过。实际双槽 Linux 实验由 root 审核源码后单次运行。本机不启动业务 listener、full、模型或节点操作。纯测试 wrapper 自身既有端口 guard 不作绕过。

## 开工检查

已读 AGENTS、developer_guide、suggested_agent_behavior、constraints、verification、multi_agent、solution_table 与 Agent 产品/机制。原规范中旧机制细节与最新账号契约不一致处沿用 root 已定账号语义，不调整用户行为。

首条 rg 在本叶查 Asset 文件无匹配退出 1，属依赖未在该基底，不是测试失败。随后 git ls-tree main 确认六条固定依赖存在。
