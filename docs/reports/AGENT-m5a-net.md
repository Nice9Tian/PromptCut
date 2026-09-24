# M5a 节点侧（net）实现报告

- 角色：net（`claude/rq-m5a-net`，基于 `claude/rq-m5a`）
- 依据：`docs/plan/render-queue-contract.md` G 节（重点 G.7）、D.1、D.2
- 可改文件：`server/render-node/ws-transport.mjs`（新）、`server/render-node/endpoint.mjs`（新）、`server/render-node/index.mjs`
- 端口段：5260～5269

## 进度

- [ ] `ws-transport.mjs`
- [ ] `endpoint.mjs`
- [ ] `index.mjs` 出口
- [ ] 自测
- [ ] 基线（`npx tsc -b --force`、`npm test`）
