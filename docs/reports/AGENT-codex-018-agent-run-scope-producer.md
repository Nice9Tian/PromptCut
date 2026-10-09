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

## 第一块接口（三级实施草案）

root 将六条 main 原 blob 独立引入 c8a938c5；本包未合整 main。`createRootScopeRuntimeV2` 从原 Asset v2 runtime 提取原有 OS 操作对象，Asset wrapper 继续原入口、validator 与固定 identity 路径。Agent 只传已编写的独立 reservation grammar 和固定 `/internal/v2/agent/run-scope/identity`，网络及 CLI 不接任意函数、unit 或 URL。

Agent schema 使用独立 `promptcut.agent-run-scope.*.v1` 域。每个 root 配置绑定 slotId、独占 service/slice 配置、Doc authority 与 Ed25519 公钥。scope/instance 的严格结构检查复用 Asset 的纯双 tuple 校验；不使用 Asset 的 record/anchor/witness/publication 域。

CLI 模式为 initialize / start / bind / close。initialize 必须 root 显式 fresh 初始化；start 要求上一代 closed。ready→bound→closed 单调，bind 接 Doc 签名的完整唯一 assignment；close 先验 Doc terminal（包含 read/finish/outcome/terminal receipt 摘要）及该代实际 RAM 公钥的 intent 签名，再 pin 旧 scope、实际 stop/空观察、fsync closure、释放 scope、写 closed marker、最后释放锁。错误保锁，文件可见不代表耐久成功。

文件为 current.json、anchor.json、reservation.json、reservation-N.json、epoch-N.json、assignment-N.json、terminal-N.json、intent-N.json、closure-N.json、publication-N-{ready,bound,closed}.json。anchor 摘要需 root 外部配置，不由 reader 自信任。reader 验全历史和 checkpoint，锁及 head 前后双读，只返回 record/assignment/terminal/closure 与新 checkpoint，不写任何 doc 账本。签名生产者及 finalizer 后包接；本包 Linux 实验仅受控 Doc 签发。

首块 node --check（schema、两 publisher、新 test）及 diff-check 通过；尚未运行 npm、类型或 Linux。所有纯模型的 OS 回调明确不构成真实 kernel witness。
