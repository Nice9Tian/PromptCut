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

## 首轮本机验证

固定 4c5401cb 首次 npm 专属（agent-run-scope-core + 原 Asset publisher/schema 两整文件）99/99，0 failed/cancelled/skipped，353.2699 ms，外层 789 ms；原日志系统 TMP `pc-agent-run-scope-4c5401cb-target-1.log`。没有 native retry，没有业务 listener。4c 产品加尚未提交的实验源码时类型首次 0 错，9010 ms，日志 `pc-agent-run-scope-type-1.log`；该结果不代替最终固定源类型。

追加代码自审将 phase 显式枚举，防 JavaScript prototype 属性名被当阶段序号；补对应纯反例。固定 FD close 失败也保锁，不能在 finally 中因先前 durable=true 解锁。追加同 terminal 幂等/异 terminal、旧 grant、旧 RAM key 重用拒绝测试。

## root 单次 Linux 实验入口（尚未执行）

源码 `scripts/probes/agent-run-scope-proof.mjs`、`scripts/probes/fixtures/agent-run-scope-worker.mjs`。两个槽只是实验数量，不是生产并发默认。worker 是隔离受控驱动，不是生产 Agent：真实 RAM Ed25519、真实 pinned mTLS、父/子文件 FD 和 TCP，无模型、工具业务或 Doc admission。Doc assignment/terminal 由 root 独立新实验 issuer 签发。全程不把测试自己写的 closed row 当根证据。

root 预建两个名称严格为 `pcagentrunproof<同一16位随机hex>a.service` / `...b.service` 的固定 unit，各自新 root 目录、公开 reservation 目录、由目标非 root UID 拥有的 holdFile 父目录；每槽独立 registryDir/authorityId/slotId/端口。所有可信配置放全祖先 root-owned、无组/他人写权限的 `/run/<唯一实验目录>`；输出用新 `/var/tmp/<唯一实验目录>/out`，脚本只 exclusive mkdir 这一个新 out，不 chmod 既有路径。

service 必须 `Type=simple; User=<实验UID>; Restart=no; KillMode=control-group; Delegate=no; TimeoutStopSec=5`，`ExecStart=/usr/bin/node <可遍历的固定源码>/scripts/probes/fixtures/agent-run-scope-worker.mjs --config <worker配置>`。基础 unit **不能写 Slice=system.slice**：之前真实 systemd249 已证明其与 runtime drop-in 赋值不符合本 adapter 前提。runtimeAdapter 精确 root-owned fragment 路径及 SHA256、baseDropIns 白名单、`/run/systemd/system/<unit>.d/90-promptcut-root-slice.conf`；原文件存在须有该 publisher 自有 receipt，未知配置一律拒绝。root 所有操作使用同一外部互斥约定，不允许其它 controller 同时启停这两个 unit。

端口选 6540/6541（A HTTPS/observer）、6542/6543（B），脚本预查完整 6540–6549 无监听。root 另给实际节点窗口，本 Agent 未用这些端口。新 CA/root client/worker server 证书与私钥只在本实验目录，root 配置带精确 pin；worker 的 clientCertFile 真证书计算值也必须匹配配置。私钥、signature、exporter 不打印。

probe 配置精确：`{v:1,issuerPrivateKeyFile,protectedUnits:[账号unit,docunit,assetunit,nginxunit],slots:[{publisherConfigFile,workerConfigFile},{publisherConfigFile,workerConfigFile}]}`。四个生产 unit 只读 MainPID/NRestarts/ActiveState 前后必须相同；探针不控制这些 unit。

publisher 配置精确：`{v:1,expected,registryDir,identity:{origin,keyFile,certFile,caFile},runtimeAdapter,configuredAnchorDigest:null}`。expected 为 `{authorityId,slotId,docAuthorityId,docPublicKey,serviceIdentity:'agent',uid,unit,clientFingerprint256,serverFingerprint256,closurePolicy:{kind:'systemd-slice',unitNamespace,cgroupRoot:'/sys/fs/cgroup',placement:'direct-child',singleEpoch:true}}`。docPublicKey 是新实验 Ed25519 SPKI DER 的 base64；不是生产密钥。首次初始化返回 anchorDigest，probe 将精确该摘要传给后续 bind/close/reader，不重写配置或自信任旧文件。

worker 配置精确：`{v:1,expected,registryDir,port,observerPort,holdFile,tls:{keyFile,certFile,caFile,clientCertFile,rootClientFingerprint256}}`。registry/config 公共元数据可读，私钥文件仅正确 UID/root 可读；启动后 reservation 身份只读一次，RAM 私钥不落盘。对子进程 SIGTERM 用持续注册 handler 加 stopping 幂等，避免 systemd 二次 SIGTERM 抢掉两秒负例。

运行命令：`node scripts/probes/agent-run-scope-proof.mjs --config /run/<唯一目录>/probe.json --out /var/tmp/<唯一目录>/out`。不自动重跑。采样/peer 等待使用30秒阶段期限，底层已审 root systemctl 原语保留120秒硬超时（不为探针改 Asset 安全原语）；因此不能宣称总进程保证30秒。root 外层 bounded runner 需保留原始结果并按精确 tuple 收尾，不杀未知 PID。

A/B 实际先初始化、bind、两角色 TCP/文件持有确认。先经真实 mTLS 请求原 RAM key 签 intent；publisher 锁内将完整 Doc terminal 与 intent fsync，再 stop。A MainPID birth 消失、子 birth 存在且文件/TCP仍持有、原 scope 仍 active/populated1 时，真实 root reader 必须因锁拒绝；原固定 eventsFD 最终 populated0、父子 birth gone、双 EOF+close，B 原 tuple/文件/连接仍活才继续。closure fsync 后才释放 scope，最终 marker+无锁才供 reader 导入。B 随后独立关闭。

缺 marker/有锁/混配 B closure/替代空实例的反例在独立 root-owned **复制目录**上执行真实 reader，绝不改成功原链。正常路径只由 publisher stop 精确自有 service/slice，不删除 unit、drop-in、数据或锁。失败保留未关闭 unit 元数据交 root 按 receipt/tuple 处理，不自动第二次 stop/retry。结果输出 checks/samples/实际 retainedUnits/listeners/四生产 unit 前后元数据与耗时，不输出签名或密钥。

### 源闭包

新增 schema、reader、publisher、probe、worker；既有 Asset publisher/schema；既有 `server/account/ledger.mjs` 及其静态依赖。root 可按固定提交的 Git 文件闭包导出，不能拿 G WIP 或本机绝对路径作运行依赖。Doc 签名业务 producer、真实执行器/远端任务资源引用、doc finalizer/SQLite 闭合投影均未接；该实验通过也只证明单 run root 生命周期和可信源，不能声称整个 Agent FIFO/生产 ready。
