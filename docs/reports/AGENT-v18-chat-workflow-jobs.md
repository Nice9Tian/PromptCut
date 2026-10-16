# AGENT-v18-chat-workflow-jobs 报告

分支 `gemini/v18-chat-workflow-jobs`，工作区 `.worktrees/v18-chat-workflow-jobs`（基于 `main` `0ba84411`）。本分支按 `user-decisions-2026-10-14.md` 第 3.1 节（第 111–116 行）、第 5 节（第 172 行、第 178 行）完成两项核心功能：
1. **共有对话设为私有时成员页面**：刷新后记住已被撤销并停止无限重连、禁用输入框与发送按钮、改顶栏「共有对话」字样为「已无读取权限」；
2. **后台作业等待与超时**：模型说话结束后等待后台作业（转写、镜头识别等）时在条带与队列提示「上一条消息发起的后台作业（转写、镜头识别等）还在做，做完就处理你这条消息。」，等满 1 小时超时中断时在流中给出「后台作业等了一小时还没做完，已经中断；需要的话请重新发起。」；
3. **一键流程（`auto_workflow`）优化**：主体识别改为缺省可选（没就绪就自动跳过并说明原因，继续后续配卡与预渲染），且基于 `commitKey`（`workflowCommitKey`）查重，重复跑直接复用已生成的字幕与卡片，不重复叠出第二份。

---

## 1. 做了什么

| 文件 | 变更内容 |
|---|---|
| `src/ai/cloud/session.ts` | 增加 `revokedStorageKey`、`readRevokedSet`、`writeRevokedSet`、`markConversationRevoked` 等撤销集合管理；在 `access.revoked`、403 `not-listed`/`banned`、404 `no-conversation`/`no-project`（`seenLive` 后）时记入撤销集合；刷新/重开已撤销对话遇到 404 `no-conversation` 时直接给出 `REVOKED_TEXT`、置为 `idle` 并停止重连；会话状态暴露 `revoked: boolean`；收到正常事件流时自动移出撤销集合 |
| `src/ai/cloud/useCloud.ts` | `useCloudChat` 向 `createCloudSession` 注入 `projectId` 与 `accountId` 提取函数；在会话返回值中透传 `revoked` 字段；`send` 在 `view.revoked` 为真时直接拦截 |
| `src/ai/types.ts` | 在 `RunProgress` 接口中补充 `waitingJobs?: boolean` 与 `waitingTimeout?: boolean` 类型支持 |
| `src/editor/right/chat/Composer.tsx` | 增加 `disabled?: boolean` 与 `disabledReason?: string` 属性；支持在当前对话已被撤销时禁用 textarea、曲别针附件按钮和发送按钮，展示不可用占位提示并阻止 Enter 发送 |
| `src/editor/right/CloudAiPanel.tsx` | 顶部控制条在 `view.revoked` 时隐藏「共有对话」徽章和切换按钮，显示「已无读取权限」；在 `view.revoked` 时向 `Composer` 传递 `disabled` 与原因；当上一轮发起的后台作业在做时显示横幅提示 |
| `src/editor/right/chat/ThinkingStrip.tsx` | `stripText` 在检测到 `m.progress.waitingJobs` 时显示「上一条消息发起的后台作业（转写、镜头识别等）还在做，做完就处理你这条消息。」 |
| `src/editor/right/chat/QueueList.tsx` | `CloudQueueList` 在正在等待后台作业时将头部换为「上一条消息发起的后台作业（转写、镜头识别等）还在做，做完就处理你这条消息。」 |
| `server/agent/service/account-tools.mjs` | `settle` 增加 `onWaiting` 与 `onTimeout` 回调与标准文案；`applyEdits` 检查项目轨道中是否已存在带有同一 `commitKey`（`params.workflowCommitKey`）的片段，存在则返回 `alreadyApplied: true` 及已有片段信息，写入时物化 `workflowCommitKey` |
| `server/agent/service/account-runner.mjs` | 运行器暴露 `settle` 接口供执行器等待后台作业；`createAccountRunManager` 在模型说话完成（`entry.done`）后、签发 `runner_done` 前调用 `runner.settle`；等待时向流发送 `waiting_jobs` 进度事件，超时时向流发送明确中断状态事件并将终态置为 `interrupted` |
| `server/agent/service/hosted-workflow.mjs` | `WORKFLOW_DEFAULTS.optionalStages` 缺省值从 `['prerender']` 改为 `Object.freeze(['subjects', 'prerender'])` |
| `src/ai/cloud/private-revoked.test.mjs` | 增加 `PRIV-10` 测试用例，覆盖「被撤销后刷新重开直接显示已无法读取且停止重试」以及「改回共有后重开自动移出撤销集合」 |
| `server/test/cloud-tools-wire.test.mjs` | 增加 `WIRE-SET` 测试用例，验证 `settle` 等待时向回调报标准提示、超时一小时向回调报中断提示 |
| `server/test/cloud-tools-p5-workflow.test.mjs` | 更新非可选测试显式指定 `optionalStages: ['prerender']`，新增验证缺省 `optionalStages` 包含 `subjects` 时主体识别未就绪自动跳过并完成后续配卡与预渲染 |
| `server/test/cloud-tools-p5-real.test.mjs` | 更新依赖未就绪测试显式指定 `workflowLimits: { optionalStages: ['prerender'] }` |

---

## 2. 怎么做的

### 2.1 共有对话设为私有后的成员端体验（刷新记住、禁用输入、改顶栏字样）
- **持久记录与快速拒绝**：在 `session.ts` 中维护按 `projectId` + `accountId` 隔离的撤销对话集合。当对话收到 `access.revoked`、403 `not-listed`/`banned` 或已读到过（`seenLive`）后重连收到 404 `no-conversation`/`no-project` 时，将该对话 ID 记入 `localStorage`（键为 `pc.cloudRevoked:${accountId}:${projectId}`）。
- **刷新/重开拦截**：页面刷新后重新打开在撤销集合里的对话时，服务端照常回 404 `no-conversation`。此时 `session.ts` 识别出该对话在撤销集合中，不再当作网络抖动无限退避重试，而是直接设置 `problem = REVOKED_TEXT`、连接置为 `idle`、`revoked = true` 并终止重连循环。
- **改回共有后恢复**：若对话被创建者重新设为共有，用户再次点开收到正常事件流后，`session.ts` 会自动从 `localStorage` 中将该对话 ID 移除，并将 `revoked` 置回 `false`。
- **界面联动**：
  - `CloudAiPanel.tsx` 顶栏原本显示「共有对话」的徽章在 `view.revoked` 为真时变为「已无读取权限」，且不展示权限切换按钮；
  - 聊天输入框 `Composer.tsx` 接收 `disabled={view.revoked}`，禁用 `textarea`、附件按钮和发送按钮，占位文字显示「当前账号已无法读取这个对话，请重新选择有权限的对话。」，同时在 `handleSend` 与 `sendNow` 进行双重防护。

### 2.2 后台作业排队等待提示与 1 小时超时中断说明
- **后台作业等待通知**：
  - 在 `account-tools.mjs` 的 `settle` 轮询循环中，当检测到有未完成作业（`pending > 0`）且尚未通知时，触发 `onWaiting` 回调，文本为：`「上一条消息发起的后台作业（转写、镜头识别等）还在做，做完就处理你这条消息。」`；
  - 在 `account-runner.mjs` 中，当模型生成完毕（`entry.done` 解析）、终态事件发出前调用 `runner.settle`。`onWaiting` 会向事件流派发 `{ type: 'progress', phase: 'waiting_jobs', waitingJobs: true, text: ... }`；
  - 前端 `ThinkingStrip` 的 `stripText` 与 `QueueList` 的 `CloudQueueList` 监听到 `waitingJobs` 时，将条带与队列头部文案统一展示为该提示。
- **1 小时超时中断提示**：
  - 当 `settle` 等待超过 `limits.settleMs`（缺省 60 分钟）时，触发 `onTimeout` 回调，向对话事件流派发 `{ type: 'status', text: '后台作业等了一小时还没做完，已经中断；需要的话请重新发起。' }`；
  - `settle` 返回 `{ waited: false, reason: 'timeout' }`，`account-runner.mjs` 据此将该任务的终态判定为 `'interrupted'`，随后的关闭流程将未结清作业安全收拢。

### 2.3 一键流程主体识别缺省可选与防重复叠放
- **主体识别缺省可选**：
  - 在 `hosted-workflow.mjs` 中，将 `WORKFLOW_DEFAULTS.optionalStages` 缺省值设为 `['subjects', 'prerender']`；
  - 当主体识别提供方未配置或返回 `cloudUnavailable` 时，该阶段被标记为 `unavailable` 并附带说明，一键流程不会中断，而是继续进入第 4 阶段「生成字幕与卡片」和第 5 阶段「发布预渲染任务」；最终输出带有 `notDone: ['主体识别']` 说明。
- **重复执行防叠放**：
  - 一键流程在 `compose` 阶段按 `mediaId`、`maxCards` 与文字稿生成 `commitKey`；
  - `account-tools.mjs` 的 `applyEdits` 在提交前检查项目所有轨道中已有片段的 `params.workflowCommitKey`；若存在匹配片段，直接返回 `{ alreadyApplied: true, projectRev: snap.rev, clips: ..., captionClipId: ... }`，不生成重复片段；
  - `hosted-workflow.mjs` 收到 `alreadyApplied: true` 后将 `compose` 阶段标记为 `reused`（理由：「这份文字稿的字幕和卡片已经在项目里了,没有重复放。」），实现了重复调用不叠出第二份。

---

## 3. 验证

### 3.1 针对性测试验证
1. `npx tsc -b --force`：
   - 结果：退出码 0，零错误。
2. 核心回归测试套件：
   ```powershell
   $env:PROMPTCUT_ACCOUNT_PROVIDER_ROOT="C:\Users\admin\Documents\VisuHive"
   $env:PROMPTCUT_PASSWORD_ORDER_MODULE="C:\Users\admin\Documents\VisuHive\account\password-order.mjs"
   $env:PROMPTCUT_NO_PORT_FILE="1"
   npm test -- src/ai/cloud/private-revoked.test.mjs src/ai/cloud/newchat-absent.test.mjs server/test/cloud-tools-p5-workflow.test.mjs server/test/cloud-tools-wire.test.mjs
   ```
   - 结果：**90 项用例全部通过，0 项失败，2 项跳过（Windows 上演不出 Linux 目录权限），耗时约 20 秒**。
3. 关键子进程生命周期单测：
   `npm test -- server/test/account-worker-lifecycle.test.mjs`
   - 结果：**9 项用例全部通过，0 项失败**。
4. 真实装配单测：
   `npm test -- server/test/account-master-production.test.mjs`
   - 结果：**1 项用例全部通过，0 项失败**。
5. 行尾符审计：
   `node C:/Users/admin/Documents/PromptCut/out/main-session-tools/eol-audit.mjs . 0ba84411 HEAD`
   - 结果：行尾翻转数为 0。

---

## 4. 没做成的 / 要用户定的事 / 注意事项

1. **真实 Python 权重环境**：`server/test/cloud-tools-p5-real.test.mjs` 中的真短片测试由于当前工作区未部署 `out/p2-stt` 目录下的 faster-whisper 权重环境而自动跳过（与基线一致）；在 mock 环境及 wire 工具链路中均已 100% 验证。
2. **多页签同步**：`localStorage` 中的撤销集合是按浏览器实例本地存储的。若用户在一个页签中该对话被改回共有且成功重连，集合已清除；其他已打开该页面的页签在重新聚焦或重新点开时亦能恢复。
3. **未越界声明**：未改动 `server/account/**`、`server/docservice/**`、`src/editor/sync/**` 以及任何计划进度文件。

---

## 5. 全量测试结果

- `tsc -b --force`：0 错误。
- 4 个专属单测套件：`private-revoked.test.mjs`（11 通过）、`newchat-absent.test.mjs`（15 通过）、`cloud-tools-p5-workflow.test.mjs`（37 通过）、`cloud-tools-wire.test.mjs`（27 通过，2 跳过），总计 90/90 通过。
- 进程生命周期与主服务单测：`account-worker-lifecycle.test.mjs`（9 通过）、`account-master-production.test.mjs`（1 通过）。
- 全量运行中仅既有的未完成渲染测试（`pageStreams`、`c10-l3-source` 等）保持既有状态，本分支修改范围全部绿灯。
