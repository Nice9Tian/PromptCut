# Cloud tool context and authorization adapter

## 开工记录

- 固定基底：`277136ea00fe2005d0c98c7720012e9c22682c5b`，分支 `codex/018-cloud-tool-context`。
- 独占范围：新增 `server/agent/service/tool-context.mjs`、新增 `server/test/cloud-tools-context.test.mjs`、本报告。
- 依据：`docs/plan/cloud-agent-tools-implementation.md` 全文要求 `ToolRunContext` 只能由 doc 已确认读的当前 run grant 与已注册 Agent 实例身份构造；每次受权 read/write 都重新访问 doc 当前 authority。现有 `run-client.mjs` 以 mTLS + 当前实例 proof 调用 `/internal/v2/runs/check`；`runAuthority.checkAccess` 返回 `runGrant` 与已读确认标记；`instanceIdentity()` 读取当前进程注册身份。
- 拟议窄 API：`createToolRunContextAccess({runClient})` 返回 `fromGrant({projectId,runGrantId})` 与 `authorize(context, action)`。构造和每次授权都从 doc 返回的完整 grant 校验八字段及当前实例注册；context 必须与本 factory 已登记的精确值相同。拒绝或上游故障一律不授权。
- 约束：不改 run authority、instance 注册、ToolJobs、工具 runner/provider 或服务接线；不声明实例 signal、worker 关闭、子进程取消能力已经接通。
- 待本报告完成的验证范围：本包专用 npm 定向测试与 TypeScript 检查；不运行完整测试、固定端口或宽探针。

## 实现与边界

- `createToolRunContextAccess({ runClient })` 暴露 `fromGrant({ projectId, runGrantId })` 和 `authorize(context, action)`。配置缺少 `checkAccess` 或 `instanceIdentity` 时即拒绝。
- `fromGrant` 从当前 run authority 的 `read` 响应构造 context，只接收精确八字段：`projectId`、`conversationId`、`runId`、`runGrantId`、`instanceId`、`instanceGeneration`、`senderAccountId`、`messageId`。项目、对话、运行、消息、发起账号、grant 与已注册实例必须逐项匹配；grant 必须由当前 authority 标记为 active 或 retained 且 read-confirmed，并带 read receipt 与 fence。context 冻结并登记在创建它的 adapter 私有表中。
- 每次 `authorize` 只接受 `read`/`write`，要求 context 与本 adapter 登记的完整值相同，然后把同一 action 交给当前 `runClient.checkAccess`。返回的 fence 与 active/retained 状态取自该次 authority 响应。远端拒绝、transport 故障、实例更换或异步 authority 检查期间实例身份变化均 fail closed；不以缓存 grant 放行。
- 没有新增 `allowWrite`/`writeEnabled` 本地策略，保留 Doc 当前 checkAccess 的 action 语义。Doc 当前只为 rw/creator 发起者签发 run grant，因此本包没有真实只读 Agent 发起 grant 的正向案例。定向测试中的只读情形是显式受控 RunClient adapter 返回 read allowed/write 403，用来验证本 adapter 原样委托且不升级权限；它不证明 Doc 已支持只读发起者。
- 测试使用真实 SQLite `runAuthority` 数据及其 grant、read confirmation、fence 和 active→retained 状态；实例调用是测试内受控 adapter，不是真实 mTLS/TLS 端到端连接。未提供或声称接通 `signalFor`；实例信号、子进程终止与取消仍需后续宿主接线及独立证据。此包没有 production runner 接线，也不是生产 mTLS 验收。

## 验证记录

- 首次定向运行保留：`%TEMP%\pc-cloud-tools-context-target-1.out.log`（stderr：`%TEMP%\pc-cloud-tools-context-target-1.err.log`），5 项中 4 通过、1 失败。唯一失败把 admit 时的 fence 与 read-confirm 后当前 fence 比较；实际 authority 在 read confirmation 时递增 fence。修正为检查每次授权返回当前安全整数 fence、read/write 使用同一当前 fence，并确认它晚于 admit fence。没有放宽产品断言。
- 中间修订定向运行：`%TEMP%\pc-cloud-tools-context-target-2.out.log`，5/5 通过、0 失败、0 跳过，测试耗时 188.3047 ms（外层 478.56 ms）。
- 最终定向运行：`npm test -- server/test/cloud-tools-context.test.mjs`，5/5 通过、0 失败、0 跳过，测试耗时 198.0403 ms（外层 0.7 s）。日志：`%TEMP%\pc-cloud-tools-context-target-3.out.log`，stderr：`%TEMP%\pc-cloud-tools-context-target-3.err.log`。覆盖真实 SQLite grant/read confirmation/current instance 映射、逐调用 read/write 与 active/retained/fence、受控 read-only adapter 拒写、跨 grant/伪造 context/实例变化与授权调用期间实例变化、authority transport 失败。
- TypeScript：使用主工作区 `node_modules/.bin/tsc.cmd -b --force`，exit 0；日志 `%TEMP%\pc-cloud-tools-context-type-1.out.log` 与 `%TEMP%\pc-cloud-tools-context-type-1.err.log`。
- `node --check` 对两个新增 JavaScript 文件均通过；`git diff --check` 通过。未运行全量测试、服务、固定端口或宽探针；未做生产 mTLS、signal/子进程取消、部署或 Linux 核验。
