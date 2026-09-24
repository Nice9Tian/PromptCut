# M5a 测试方报告（tests）

分支 `claude/rq-m5a-tests`（基于 `claude/rq-m5a`），worktree `.worktrees/rq-m5a-tests`。
依据：`docs/plan/render-queue-contract.md` G 节（G.8 探针、G.9 用例表）。只照契约写，不看实现分支。

## 进度

- [ ] docservice-router.test.mjs（R1、R2、R3、R5、R6、R7）
- [ ] docservice-auth.test.mjs（A1～A6）
- [ ] docservice-endpoints.test.mjs（E1～E8）
- [ ] render-node-ws.test.mjs（T1～T9）
- [ ] 探针 render-queue-e2e.mjs、render-queue-proxy.mjs
- [ ] ws-client-test.mjs 加令牌与新字段断言
- [ ] 收尾：tsc、npm test
