# AGENT 报告：bad-ports-concurrency

分支 `claude/bad-ports-concurrency`（从 main `7d90218` 起）。

## 任务

同一台机器上并行跑多份 `npm test` 时，后起的那份全局准备占不到坏端口（fetch 规范拒绝连接的端口），自检「自己占到的 ≥ 名单数 − 3」误报失败；先起的那份收尾放掉端口后，后起的那份也不会再去占。

改：`server/test/global-setup.mjs`、`server/test/bad-ports.test.mjs`。

## 进度

- 开工，建报告。
