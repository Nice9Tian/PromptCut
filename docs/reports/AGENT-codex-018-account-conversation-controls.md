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


## Puppeteer 用户路径 CLI 补充（2026-10-09）

- 把先前只暴露页面操作函数的探针扩展为 Puppeteer CLI：`node scripts/probes/account-conversation-controls-probe.mjs --dist <online-dist> --site-root <site-root> --out <os-temp-child>`。脚本启动自有 Puppeteer 浏览器、静态页面和新 fixture，按真实 UI 流程创建两账号会话、由项目成员发送共享对话、项目创建者核对无切换按钮、成员切私有遇 HTTP 503 fence pending 后重试并核同一 request ID；创建者打开私有对话核对可读只读状态。页面只通过 DOM 检查和点击操作，不注入状态或伪造接口响应。
- 原 cloud queue fixture 的 Agent HTTP 端口固定在 6526，超出本阶段 6620–6639 租用段，所以新增独立 fixture 文件副本 `server/test/fixtures/account-conversation-controls-user-path.mjs`，只将其 Agent 端口配置为调用者传入的 6627，close 后保留失败现场目录供核查；没有修改既有 queue fixture。探针使用 6620–6629，并在 finally 后验证这些端口全部可重新绑定。输出只留安全路径/status/method、重试 request ID 相同的布尔值、截图与检查结果；不写凭证、请求 body 或原始 request ID，并保留已关闭的 Chrome profile 与 fixture 临时目录，供 root 检查真实失败现场；临时数据位于当前用户 temp 下，fixture 在非 Windows 系统使用 0700 权限。
- 可见性检查现在核对目标元素实际矩形和从元素到根节点的所有祖先样式、`hidden` 与 `aria-hidden`，避免隐藏 panel 内的按钮被误报可见。CLI 的结果分类纯测试覆盖 confirmed/pending/error 三种状态。
- 代码检查只做 `node --check` 和 `git diff --check`；纯分类测试三种情况通过。本轮没有运行真实 CLI、浏览器或 fixture，也没有运行完整服务；因此尚无页面截图、真实 HTTP 503 或端口关闭实测结果。已有服务代码路径显示私有切换执行 `onFence` 并在 ACK 未完成时返回 `agent-fence-pending`，conversation authority 的 `get` 为创建者私有只读返回标志；这只是源码证据，不替代真实页面验收。
- root 另审到 `Composer` 的 running 分支始终显示停止按钮，账号成员无权停止别人运行时 `handleStop` 只会静默返回。此为可见权限缺口，和对话 `streaming` 状态无关；本次在 CLI 中没有伪造 running 状态。root 已单独授权窄修 `src/editor/right/chat/Composer.tsx`，后续以独立提交修正并验证按钮的权限说明，同时保留真实运行态待 executor 验收。
