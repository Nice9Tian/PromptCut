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


## 异步身份隔离补丁（2026-10-09）

- root 审查指出，原 `applyCloudControl` 在 `await` 后只比较 render 闭包中的 conversation ID；账号或项目切换后若 conversation ID 相同，迟到结果可能清理新 scope 的 pending、显示旧操作成功，或在旧停止请求重试时误用新身份。
- `CloudAiPanel.tsx` 现在把账号、项目、云端地址与身份版本、consent account/binding/accepted 状态及 conversation ID 绑定到单调 epoch。作用域变化时即时隐藏/清空旧 pending 与 in-flight；每次控制请求开始、接口 await 后、历史刷新 await 后、catch/finally 都校验原 epoch。旧请求不刷新、不写状态、不清新请求的 in-flight，也不能带旧 request ID 重试。
- `useCloud.ts` 的权限切换在 consent promise 返回后重新核验同一 epoch、key、session 和 conversation，再提交 API；历史读取和错误提示也只允许原 scope 更新状态。账号模式 abort 必须有当前 run ID 与 request ID，否则拒绝，绝不回落到 session 的 legacy 空请求。
- 回归测试不是源码字符串断言：以真实 deferred promise 模拟同一 conversation 的 A→B→A。保留首红输出：首次 4 项中 3 项通过、1 项失败，ABA 旧 token 被误判 current（`true !== false`）；单调 epoch 修复及 consent-迟到提交用例后，控制测试 6 项通过。测试还检查旧操作不能清除新 request pending，迟到 consent 后 API 提交次数为 0，账号 abort 缺任一编号会拒绝。
- 浏览器探针补了实际签入页面的可调用操作 `requestAccountVisibility` / `retryAccountStop`，读取真实控件、点击真实按钮并区分 `confirmed`、`pending`、`error`。它不模拟服务端成功；仍需 root 提供的真实签入窗口做角色、private/fence-pending 页面验收和截图。
- 本补丁验证：`node scripts/test-suite.mjs src/ai/cloud/account-conversation-controls.test.mjs src/ai/cloud/cloud-chat.test.mjs src/ai/cloud/account-queue.test.mjs`（31 项通过，0 失败）、`npx tsc -p tsconfig.json --pretty false`、`node --check scripts/probes/account-conversation-controls-probe.mjs`、`git diff --check`。未启动浏览器、服务或节点；实际账号 fence ACK 仍由独立服务块验收。
