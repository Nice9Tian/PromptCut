# AGENT-sse-retry-budget 报告

- **分支**：`gemini/sse-retry-budget`
- **工作区**：`.worktrees/sse-retry-budget`
- **分配端口段**：`5830..5839`
- **状态**：进行中

## 1. 任务目标
- 修复 `server/harness/retry-fetch.mjs` 中 `DEFAULT_RETRY.maxTotalMs`（原为 5 分钟 = 300,000 ms）在 OpenLux 网关单次上游超时约 93～95 秒时，连续 4 次尝试（首次 + 3 次重试，累计约 377 秒 > 300 秒）即因总时间预算耗尽而提前放弃后续重试的问题，将其调整为 `20 * 60 * 1000`（20 分钟 = 1,200,000 ms）并同步更新注释说明。
- 在 `server/test/retry-fetch.test.mjs` 中更新/补充对 `DEFAULT_RETRY.maxTotalMs` 的断言，并新增模拟每次耗时 95 秒返回 SSE `The upstream service timed out. Please try again later.`、连续失败 4 次（累计 380 秒 > 旧 5 分钟）后继续第 4 次重试并在第 5 次尝试成功返回正文的单元测试。
