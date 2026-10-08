# Cloud Agent tool coverage inventory

- Worktree: `PromptCut/.worktrees/018-cloud-tool-coverage`
- Branch: `codex/018-cloud-tool-coverage`
- Fixed starting revision: `8b255ab4d0f261415664c3822aff25ad24ac1e79`
- Scope: only `docs/plan/cloud-agent-tool-coverage.md` and this report. This is a static source and contract inventory for the remaining Cloud Agent tools; no implementation, production route/store, service, probe, test, install, node, main, or push changes are authorized.
- Read the repository entry rules and shared developer guidance before starting. The source of product decisions is the current cloud-agent task and contract plus the account-binding decisions, with the latest user decisions taking precedence over historical handoff notes and old fixtures.
- Planned inventory: for each remaining tool, record its exact name, hosted route/entry and line, reusable implementation, directly relevant test/probe, what that evidence actually covers, production-unverified boundary, and required dependency (instance grant, materials, initiator selection, local download, rendering, or separate tool service). Mark user-decided exclusions/replacements separately from implementation gaps; do not treat old fixtures or prior full-suite results as proof of current production coverage.
- Initial repository state was clean at the fixed revision. No service, probe, test, or install has been run for this task.

## 静态清单完成

- 已核对来源：`AGENTS.md`、`docs/semantics/developer_guide.md`、`suggested_agent_behavior.md`、`constraints.md`；`docs/plan/three-versions-brief.md` 第 5、8、9、11 节；`cloud-agent-task.md`、`account-binding-task.md` 与 `account-binding-contract.md`；`docs/semantics/product/agent.md`、`workflow/production.md`；`docs/reports/HANDOFF-four-stage.md` 第 3 节和收工现场；当前 `cloud-agent-contract.md` 的 9.1/9.2、25–28 节与账号版补记。
- 新计划：`docs/plan/cloud-agent-tool-coverage.md`，提交 `7cd55ffe7f20e32511885486d2f870ede29535b9`。报告开工记录提交 `21bb7c1d89bd66125d978ce5eacd93505472bdbf`。本报告将另行提交。
- 计划区分了 20 个已存在 hosted 实现与账号版的代码接线路径、23 个旧 planner pending 工具，以及账号版 page bridge、全员选区、PC 本机素材代下、get_gif 可视结果等新目标缺口。细分后是 30 个不同工具名/用户可见行为、32 行（两个能力行是现有工具的子模式/结果缺口）；`spawn_agent` 不计入本期，另列为已定延期。
- 对账号版的关键静态结论：`account-runner.mjs` 确实通过 run ticket 构造现有 Hosted Agent instance，并复用 `createHostedTools`，所以现有 20 个 hosted 工具在代码里有复用路径；但账号版 runner 的 page channel 明确设为 offline，旧 page 通道测试不能证明新账号流程。`agent-runner-read.test.mjs` 使用 mock runner factory，没有逐工具账号版闭环证据。此处没有把代码可达说成生产通过。
- 用户决定已写入清单：素材采集缺省匿名，登录态由发起 PC 代下且不上传 cookie；卡片与图卡外链在所有浏览器正常加载，旧卡片出口护栏不列本期要求；`spawn_agent` 三版本关闭，触发时给「云端暂不支持开子 Agent」；`get_selection` 使用同项目所有在线成员选区，发起人离线回消息快照并标非实时。
- 本次仅静态读源与文档、写两份文档并运行 `git diff --check`（通过）；未运行服务、probe、测试、安装依赖或访问节点/生产凭证。文档差异没有新增或重新批准产品语义；实现选项仅作为分包依赖提示。
