# AGENT-c10-integ：C10 其余集成

分支 `claude/c10-integ`（worktree `.worktrees/c10-integ`），起点 `fcbff6c`。端口段 5420～5429。

派活方：「PromptCut 主会话（PC）」。任务：合 `claude/c10-browser`（`9ad7429`）与 main（`cdeaff9`），做交接文件 `HANDOFF-2026-09-28.md` 第 2.2 节第 2～6 条接线，跑 G0、G0-R 不带耗时门槛的各项与 C10-A 本机验收（A4 除外，由 `claude/c10-a4` 处理）。

## 主会话的裁定（〔裁〕）

- 清单计划用独立的 `#clips:` 键，不与补渲共用 `#backfill:` 键：接受。
- 独立渲染主机写层表（`publishLayerMap` 钩子）：接受；两个只给测试用的环境变量 `PROMPTCUT_TEST_ASSET_TICKET_TTL_MS`、`PROMPTCUT_TEST_ENV_FINGERPRINT`：接受，生产不设。
- A9、A10 由本分支在集成后的代码上跑。
- 云端工作节点已归档，C10 的外网复验与跨机项不经云端。

## 进度

（随工作续写）
