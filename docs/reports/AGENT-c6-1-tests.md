# C6.1 测试方报告（c6-1-tests）

分支 `claude/c6-1-tests`，从 `claude/c6-1`（契约 H 节定稿）拉出。只照契约 H 节写测试，不看实现方分支。

## 范围

- `server/test/docservice-channels.test.mjs`：C1～C7，核心单元，直接 `createRouter`，假 `write` / `buffered` / `close`。
- `server/test/docservice-backpressure.test.mjs`：I1～I5，真 WebSocket，端口 0，`autoTick: false`。
- 需要的新假件：`server/test/fake-*.mjs`。

## 进度

- [ ] 报告骨架
- [ ] channels 测试
- [ ] backpressure 测试与假件
- [ ] 参考实现自检
- [ ] 收尾验证
