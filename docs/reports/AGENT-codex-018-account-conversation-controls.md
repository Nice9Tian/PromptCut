# 账号云端对话控制界面

## 开工记录

- 分支：`codex/018-account-conversation-controls`，基线 `037587670cb6c0cd28379d4ee72d6007821a3b02`。
- 工作边界：只改 `src/ai/CloudAiPanel.tsx`、`src/ai/CloudAiPanel.css`、`src/ai/cloud/cloudApi.ts`、`src/ai/cloud/useCloud.ts`，以及本任务的 API 测试、UI 探针和本报告。不改成员面板、同步管理器、服务端、产品语义或进度文件。
- 目标：用真实的账号云端对话接口呈现共有/私有状态；只有对话所有者能切换；创建者查看他人私有对话时只读；仅当前轮发起者和项目创建者可以停止，并且停止请求必须携带服务端报告的 `currentRunId`。
- 可靠性约束：等待执行服务的消息不显示成运行中的任务。权限切换或停止遇到 503、fence pending 时不报成功；保留同一个 `requestId` 供重试并在成功或冲突后重读元数据。若切私有已先行禁止新访问但相关服务 fencing 尚未确认，界面说明“已禁止新访问，相关服务关闭待确认”，不以新请求号重复提交。
- 服务端执行确认由独立服务块负责；本任务不伪造确认，也不把前端状态当作实际任务停止。

## 验收与证据

### 实现

- `CloudAiPanel.tsx` 与样式新增当前云端对话的共有/私有状态、所有者切换按钮、创建者只读提示，以及基于队列当前 `runId` 和发送者账号显示停止操作。等待执行服务的队列行不会当成运行中的一轮；创建者只读私有对话不渲染输入区和附件入口。
- `cloudApi.ts` 新增账号模式 visibility POST 与带 `runId`、稳定 `requestId` 的停止 POST。两个接口都省略 Cookie；成功回包严格核对。旧 LAN/hosted abort 仍发原来的空 JSON body。
- `useCloud.ts` 暴露上述对话控制，并让历史刷新返回是否成功，以便页面在权限元数据读取成功前隐藏发送区。
- 503/fence pending 后刷新历史元数据并保留原 `requestId` 供重试；`agent-fence-pending` 明示“已禁止新访问，相关服务关闭待确认”。不会把 pending 当作已切换或已停止。
- 新增 `src/ai/cloud/account-conversation-controls.test.mjs` 与 `scripts/probes/account-conversation-controls-probe.mjs`。探针读取真实页面上的 `data-pc` 控件；需 root 提供已登录窗口后才可做实际 UI 验收。

### 验证

- `node scripts/test-suite.mjs src/ai/cloud/account-conversation-controls.test.mjs src/ai/cloud/cloud-chat.test.mjs src/ai/cloud/account-queue.test.mjs`：28 项通过，0 失败。新增控制测试覆盖角色门控、排队不作运行、无 Cookie 的请求形状、严格确认和同 request ID 重试；回归覆盖云端会话与旧 abort 行为。
- `npx tsc -p tsconfig.json --pretty false`：通过。
- `node --check scripts/probes/account-conversation-controls-probe.mjs` 与 `git diff --check`：通过。
- 未启动 listener、浏览器、服务或节点；因此真实页面截图及后端 fencing ACK 不在本阶段验收范围。当前账号服务若返回 503，UI 会显示待确认状态，不声称任务已关闭。

### 工作区误写记录

实施中我有两次 `apply_patch` 路径漏掉 `.worktrees/018-member-native-route` 前缀，短暂把 `CloudAiPanel.tsx` handler 写入主工作区。核实时主工作区只有该文件被我改动；我仅撤销了这个由我造成的单文件差异，并确认主工作区 `git status --short` 为空，随后已向 root 报告该经过。root 表示会另行核对 main 文件与 HEAD 字节一致。本报告不把该事件记作“未发生”。

本分支开工报告已先独立提交；实现与本报告的最终 SHA、干净状态由交接消息报告。未完成项：待 root 提供真实窗口后运行页面控件探针；账号 fencing 的实际执行确认由独立服务块验收。
