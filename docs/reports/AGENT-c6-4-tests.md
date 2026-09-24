# C6.4 测试方报告（c6-4-tests）

- 分支：`claude/c6-4-tests`（从 `claude/c6-4` 起）
- 依据：`docs/plan/manifest-contract.md` 第 6 节；前提 `artifact-transfer-contract.md`（C6.2）、`docservice-contract.md`（C6.3）
- 对抗式分工：只照契约写，不看 `claude/c6-4-node`、`claude/c6-4-pipeline`

## 进度

- [ ] `server/test/content-client.test.mjs`（Q1～Q3）
- [ ] `server/test/artifact-dedup.test.mjs`（U1～U5）
- [ ] `server/test/artifact-push.test.mjs`（W1～W6）
- [ ] `server/test/artifact-adopt.test.mjs`（A1～A2）
