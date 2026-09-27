# AGENT-eol-eperm 报告

分支 `claude/eol-eperm`，worktree `.worktrees/eol-eperm`，基于 main a038948。端口段 5630～5639。

## 任务

1. 页面侧卡片源码版本（`src/render/cardSourceVersion.mjs`）统一换行（CRLF→LF），与服务端 `server/frame-code.mjs` 一致。
2. 成本记录写盘（`server/costs-store.mjs`）改名遇 EPERM / EBUSY / EACCES 时有限次退避重试。

## 进度

- [ ] 1 换行统一 + 单测
- [ ] 2 改名重试 + 单测
- [ ] 验证
