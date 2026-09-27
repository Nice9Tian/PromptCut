# AGENT 报告：c10a-integ

分支 `claude/c10a-integ`，worktree `.worktrees/c10a-integ`，起点 C6.6 集成分支 `claude/c66-integ` 的 `3519ca1`（C6.6 还没合入 main；这一版含 C6.6 的素材同步与渲染主机用户卡两处修复）。端口段 5660～5669。

任务：把 C10a 的三个子分支（`claude/c10a-web`、`claude/c10a-lowmem`、`claude/c10a-tests`）合到一起，落实主会话的裁定，跑通本机验收。依据 `docs/plan/c10a-contract.md`（C10a 契约，下称「契约」；第 16 节是开工后的裁定，在 main 的 `dc28209` 上）与三份子报告。

## 进度

- [ ] 依次合并三个子分支
- [ ] `server/test/c10a-kit.mjs` 对账，C10A 53 条真跑全过
- [ ] 主会话裁定逐条落实
- [ ] 验证
- [ ] 报告写完
