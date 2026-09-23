# 子 Agent 协议

索引见 `../developer_guide.md`。

用不用子 Agent、用哪种，由用户按任务指定，本文不规定。本文只规定用了之后怎么做。

## 派出之前（主 Agent）

- 每个子 Agent 一个 worktree、一个分支。
- 给每个子 Agent 分配互不重叠的文件清单和端口段。端口按 10 个一段分，并避开用户常驻的 dev server 及其舞台端口。
- 写清验收标准和报告要写什么。

## 子 Agent 干活时

- 开工先建报告文件，并提交一次。
- 每完成一块提交一次。
- 不推送，不合并。
- 不建 `node_modules` 的 junction，不跑 `npm ci`。worktree 建在仓库目录下，依赖向上解析。
- 报告写清：做了什么、验证结果、没做成的及原因、对任务书或语义的更正建议。

## 收回之后（主 Agent）

- 逐个读 diff，自己重跑基线，涉及渲染的改动自己看图。
- 审查通过后用 `--no-ff` 合并。合并进 main 须按 `suggested_agent_behavior.md` 原则 4 先得到用户授权。
- 审查不通过或验证没过，分支保留，按 `suggested_agent_behavior.md`「验证」一节告诉用户。

## 清理 worktree

- 删之前确认改动已合并或已提交在分支上。
- 删之前确认 worktree 里没有 junction，有就按 `verification.md`「会造成真实损失的操作」一节先拆掉。直接删会顺着 junction 把主仓库的 `node_modules` 清空。
