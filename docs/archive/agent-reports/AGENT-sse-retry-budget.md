# AGENT-sse-retry-budget 报告

- **分支**：`gemini/sse-retry-budget`
- **工作区**：`.worktrees/sse-retry-budget`
- **分配端口段**：`5830..5839`
- **状态**：已完成

## 1. 做了什么
1. **`server/harness/retry-fetch.mjs`**：
   - 将 `DEFAULT_RETRY.maxTotalMs` 从 `5 * 60 * 1000`（5 分钟 = 300,000 ms）调整为 `20 * 60 * 1000`（20 分钟 = 1,200,000 ms）。
   - 同步更新 `maxTotalMs` 上方注释：说明单次上游超时（如 OpenLux 网关 90～95 秒返回 SSE `The upstream service timed out...` 或本地 120 秒闲置超时）约需 90～120 秒；若总预算只有 5 分钟，连续 4 次尝试（首次 + 3 次重试，累计约 380 秒 > 300 秒）就会在第 `3/10` 次重试后因 `overBudget` 被提前截断；调至 20 分钟足以覆盖 `maxRetries: 10` 的完整退避重试。
2. **`server/test/retry-fetch.test.mjs`**：
   - 新增单测 `DEFAULT_RETRY.maxTotalMs 为 20 分钟:每次耗时 95 秒返回 SSE upstream timed out、连续失败 4 次(累计 380 秒 > 旧 5 分钟)后不提前中止,继续第 4 次重试并在第 5 次尝试成功返回正文`：
     - 断言 `DEFAULT_RETRY.maxTotalMs === 20 * 60 * 1000` 且 `DEFAULT_RETRY.maxRetries === 10`。
     - 模拟单次上游挂起 95 秒（`clock += 95_000`）才返回 SSE `The upstream service timed out. Please try again later.`，连续失败 4 次（累计耗时 380 秒，超过旧的 5 分钟预算）后不提前中止，继续第 4 次重试（`4/10`）并在第 5 次尝试正常流式返回正文。

## 2. 验证结果
- `node --test server/test/retry-fetch.test.mjs`：**15 / 15 通过**（含新增的连续 4 次 95 秒超时后第 5 次成功用例）。
- `node --test server/test/api-retry-wiring.test.mjs`：**7 / 7 通过**。
- `npx.cmd tsc -b --force`：**0 错误通过**。

## 3. 未完成项与原因
- 无。

## 4. 对任务书或语义的更正建议
- 无。`DEFAULT_RETRY.maxTotalMs` 属于三级机制内部阈值，`docs/semantics/mechanism/agent.md` 未硬编码该旧值（5 分钟），无需改动语义文档。
