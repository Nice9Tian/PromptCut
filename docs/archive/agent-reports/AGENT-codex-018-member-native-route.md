# AGENT 报告：018-member-native-route

## 任务范围

- 工作区：`.worktrees/018-member-native-route`；分支 `codex/018-member-native-route`；起点 `53b7246c`。
- 允许改动仅为 `desktop/src-tauri/src/account_vault.rs`、新测试 `server/test/account-member-native-route.test.mjs`、本报告。
- 将精确路径 `/hosted/shared/account/members` 加入现有 projectRoute allowlist；首次测试发现 PowerShell `-in` 默认大小写不敏感，故将名单比较改为 `-cin`，避免路径大小写变体通过。原有 create/join/session/admin 路径文字不变；main window/origin、DPAPI、账号 token、大小、方法和请求体守门逻辑不变。
- 实际后台 members 由 Sol 实现。本任务只验证 native bridge 的路由放行边界，不改业务权限，也不把受控 HTTP shim 测试描述为 IPC、TLS 或真实服务验证。

## 当前进度

- 已阅读 `AGENTS.md`、developer guide、建议行为、constraints、git/release 与 multi-agent 协议；已读 account/document-service、asset-service 和 platforms 语义。
- 已检查 `account_vault.rs` 的内嵌 PowerShell `SCRIPT` 与 `cloud-queue-native-admin.test.mjs`。新测试从真实 Rust 源提取脚本，仅替换 `Http` 为受控 shim；测试代码不创建业务 listener，也不访问账号服务。现有 npm wrapper/global 的临时坏端口保护按原样保留。

## 验收与限制

- 首轮目标测试曾失败并保留原始日志：`%TEMP%\pc-account-member-native-target-1791499781241.log`，1 项/0 通过/1 失败，原因是大小写变体 `/HOSTED/shared/account/members` 被 PowerShell `-in` 当作匹配。将名单比较改为 `-cin` 后，同一目标复验 1/1 通过，日志 `%TEMP%\pc-account-member-native-target-after-fix-1791499808417.log`。原首失败未覆盖。
- 验证包括 `node --check server/test/account-member-native-route.test.mjs`、`git diff --check`，以及经现有 `npm.cmd test -- server/test/account-member-native-route.test.mjs` wrapper 运行目标测试。测试覆盖精确 POST 路径、缺 token/body（GET）、大小写/前后缀/查询/未知路径拒绝、旧 create/join/session/admin 路由和 consent GET/POST，并静态核对 HTTP 仍用 JSON、Bearer token 和 1 MiB 输入上限。
- 目标 npm 命令经现有 wrapper/global，进程环境使用绝对 file URL 静默 preload、cuda_Vit Python、主目录模型路径和 canonical `PSModulePath`（删除大小写别名后只留该键）；这些只设置在测试进程及其子进程。不安装依赖，不创建 junction，不启动产品服务、浏览器或节点连接。
- 未运行 full、cargo/Rust 真壳构建或原生 IPC/TLS；根负责用最终 Rust exe 验实际成员路由。本叶的 HTTP shim 只证明内嵌脚本路由守门，不证明后台业务权限或账号服务可用。
- 最终报告记录原始/复验结果、失败证据、提交 SHA 和工作区状态；任何未跑项说明原因。
