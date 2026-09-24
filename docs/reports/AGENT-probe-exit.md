# 子 Agent 报告：探针退出时的 libuv 断言

分支 `claude/probe-exit`，worktree `.worktrees/probe-exit`。

## 任务

`scripts/probes/ws-client-test.mjs` 对远端跑完后 `ws.close()` 紧接 `process.exit()`，关闭握手没完成就退出，Windows 上 Node 报 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`，退出码 -1073740791。改成先等 `close` 事件（最多 3 秒）再退出；检查 `render-queue-e2e.mjs`、`asset-lan-probe.mjs` 有没有同样的写法。

## 进度

- [ ] ws-client-test.mjs
- [ ] render-queue-e2e.mjs / asset-lan-probe.mjs
- [ ] 验证
