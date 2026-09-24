# 卡片级指纹锁：Node Agent 报告

分支 `claude/rq-card-lock-node`（基于 bc3004a），规格为 `docs/plan/render-queue-contract.md` F.2。

状态：进行中。

## 范围

只改 `server/render-node/` 的 `fingerprint.mjs`、`split.mjs`、`session.mjs`、`local-node.mjs`、`index.mjs`。不写 `server/test/`，不碰 `server/render-queue/`。
