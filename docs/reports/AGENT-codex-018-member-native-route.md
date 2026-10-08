# AGENT 报告：018-member-native-route

## 任务范围

- 工作区：`.worktrees/018-member-native-route`；分支 `codex/018-member-native-route`；起点 `53b7246c`。
- 允许改动仅为 `desktop/src-tauri/src/account_vault.rs`、新测试 `server/test/account-member-native-route.test.mjs`、本报告。
- 只把精确路径 `/hosted/shared/account/members` 加入现有 projectRoute allowlist；保留当前 main window/origin、DPAPI、账号 token、大小、方法和请求体守门逻辑。
- 实际后台 members 由 Sol 实现。本任务只验证 native bridge 的路由放行边界，不改业务权限，也不把受控 HTTP shim 测试描述为 IPC、TLS 或真实服务验证。

## 当前进度

- 已阅读 `AGENTS.md`、developer guide、建议行为、constraints、git/release 与 multi-agent 协议；已读 account/document-service、asset-service 和 platforms 语义。
- 已检查 `account_vault.rs` 的内嵌 PowerShell `SCRIPT` 与 `cloud-queue-native-admin.test.mjs`，准备从真实 Rust 源提取脚本，仅替换 `Http` 为无监听的测试 shim。

## 验收与限制

- 测试应验证新增精确路径只在 body/token 齐全时通过；缺 token、缺 body、错误 method、路径前后缀/大小写变体及未知路径拒绝；旧 create/join/session/admin/consent 路由行为保持。
- 运行目标测试与适用类型检查前，按任务要求使用现有 npm wrapper/global 与静默 preload；不安装依赖，不创建 junction，不启动服务、浏览器或节点连接。
- 最终报告记录原始/复验结果、失败证据、提交 SHA 和工作区状态；任何未跑项说明原因。
