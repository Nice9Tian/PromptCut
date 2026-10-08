# Cloud tool context and authorization adapter

## 开工记录

- 固定基底：`277136ea00fe2005d0c98c7720012e9c22682c5b`，分支 `codex/018-cloud-tool-context`。
- 独占范围：新增 `server/agent/service/tool-context.mjs`、新增 `server/test/cloud-tools-context.test.mjs`、本报告。
- 依据：`docs/plan/cloud-agent-tools-implementation.md` 全文要求 `ToolRunContext` 只能由 doc 已确认读的当前 run grant 与已注册 Agent 实例身份构造；每次受权 read/write 都重新访问 doc 当前 authority。现有 `run-client.mjs` 以 mTLS + 当前实例 proof 调用 `/internal/v2/runs/check`；`runAuthority.checkAccess` 返回 `runGrant` 与已读确认标记；`instanceIdentity()` 读取当前进程注册身份。
- 拟议窄 API：`createToolRunContextAccess({runClient})` 返回 `fromGrant({projectId,runGrantId})` 与 `authorize(context, action)`。构造和每次授权都从 doc 返回的完整 grant 校验八字段及当前实例注册；context 必须与本 factory 已登记的精确值相同。拒绝或上游故障一律不授权。
- 约束：不改 run authority、instance 注册、ToolJobs、工具 runner/provider 或服务接线；不声明实例 signal、worker 关闭、子进程取消能力已经接通。
- 待本报告完成的验证范围：本包专用 npm 定向测试与 TypeScript 检查；不运行完整测试、固定端口或宽探针。
