# AGENT 报告：snapshot-ids（生成快照的 id 改名改成线性）

分支 `claude/snapshot-ids`，worktree `.worktrees/snapshot-ids`，从 main `b7635ad` 开出。端口段 5670～5679。

状态：进行中。

## 任务

`src/render/createSnapshot.ts` 的 `serializeScene` 对每个 id 在整段 HTML 上跑三遍正则改名，带 id 的元素多时是平方级（C10 探针 `docs/reports/AGENT-c10-probe.md`「旁证」：1400 个带 id 的元素约 6.5 s）。改成线性，生成快照的输出逐字节不变。
