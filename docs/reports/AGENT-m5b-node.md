# M5b 节点侧（m5b-node）报告

分支 `claude/rq-m5b-node`（基于 `claude/rq-m5b`），worktree `.worktrees/rq-m5b-node`。

依据：`docs/plan/render-queue-contract.md` J.3 的 `local-node.mjs` 与 `split.mjs` 两条（文件照 J.8 的 node 行），以及 D.1、D.2、B.4、E.5；`docs/plan/artifact-transfer-contract.md` 第 11 节第 2、3 条；`docs/plan/manifest-contract.md` 第 3 节。

## 进度

- [ ] `local-node.mjs`：sink `ref` 带 `input`、`requires`；`put` 完成展开 `r.result`；去重完成带 `resultFor`
- [ ] `split.mjs`：快照任务 `input.canvasHeavy`；`planTaskOf` 写 `requires.codeVersion` / `requires.envFingerprint`
- [ ] 验证：`npx tsc -b --force`、`npm test`、scratch 自测
