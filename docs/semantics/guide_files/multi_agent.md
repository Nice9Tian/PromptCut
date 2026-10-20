# 子 Agent 协议

索引见 `../developer_guide.md`。

用不用子 Agent、用哪种，由用户按任务指定，本文不规定。本文只规定用了之后怎么做。

## 派出之前（主 Agent）

- 每个子 Agent 一个 worktree、一个分支。
- 给每个子 Agent 分配互不重叠的文件清单和端口段。端口按 10 个一段分，并避开用户常驻的 dev server 及其舞台端口。
- 写清验收标准和报告要写什么。
- 约定报告文件的路径：`docs/reports/AGENT-<分支名>.md`。阶段报告写完后，主 Agent 把这些 AGENT 报告归档到 `docs/archive/agent-reports/`，不留在 `docs/reports/`。

## 子 Agent 干活时

- 开工先建报告文件，并提交一次。
- 每完成一块提交一次。
- 不推送，不合并。
- 不建 `node_modules` 的 junction，不跑 `npm ci`。worktree 建在仓库目录下，依赖向上解析。
- 报告写清：做了什么、验证结果、没做成的及原因、对任务书或语义的更正建议。

## 等待与收回（主 Agent）

- **零轮询等待**：派完子 Agent（`invoke_subagent` / `send_message`）或启动后台任务（异步 `run_command`）后，若主 Agent 手头没有其它独立工作可推进，直接输出一句简短状态说明并立即结束当前回合（不调用任何工具，句末严禁输出重复符号、多余标点或空行），完全依靠系统的事件通知（`SYSTEM_MESSAGE` / Reactive Wakeup）自动唤醒。
- **禁设轮询闹钟，允许绑定任务 ID 的单次死锁看门狗**：严禁对子 Agent 或后台任务设置周期性 `CronExpression` 或 `TimerCondition="never"` 的无条件巡检闹钟，更不得调用 `manage_subagents(Action="list")` 或 `manage_task(Action="status")` 手工轮询。但当 `run_command` 转入后台（返回 `task-xxx`）且存在远端 SSH、WebSocket、无头浏览器等潜在挂死风险时，允许设置一个**单次、绑定该任务 ID 的超长兜底看门狗** `schedule(DurationSeconds=300, TimerCondition="task-xxx")`——任务正常结束时系统会自动静默取消该定时器（零额外唤醒开销），仅在命令真正死锁超时后唤醒会话查日志并 `manage_task(Action="kill")`。
- 逐个读 diff，自己重跑基线，涉及渲染的改动自己看图。
- 审查通过后用 `--no-ff` 合并。合并进 main 须按 `suggested_agent_behavior.md` 原则 4 先得到用户授权。
- 审查不通过或验证没过，分支保留，按 `suggested_agent_behavior.md`「验证」一节告诉用户。

## 清理 worktree 与子 Agent

- 删之前确认改动已合并或已提交在分支上。
- 删之前确认 worktree 里没有 junction，有就按 `verification.md`「会造成真实损失的操作」一节先拆掉。直接删会顺着 junction 把主仓库的 `node_modules` 清空。
- 分支合入 `main`、AGENT 报告归档并拆掉 worktree 后，调用 `manage_subagents(Action="kill")` 清理已结束（`idle`）的子 Agent，避免活动列表无限膨胀污染后续上下文。
