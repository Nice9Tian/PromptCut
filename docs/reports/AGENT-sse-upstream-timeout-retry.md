# AGENT 报告：流式请求首块前上游超时/临时错误自动重试（`gemini/sse-upstream-timeout-retry`）

## 1. 任务目标与背景

在生产节点对话 `cc-mvcmrim9-7fu6` 中，模型流式请求在产出任何内容块之前因上游网关返回 HTTP 200 SSE `data: {"error":{"message":"The upstream service timed out. Please try again later. (request id: 202610180052009722857049rKYajio)"}}` 直接失败退出（0 次重试）。

根因：
1. `createRetryingFetch` 只检查 HTTP 响应头状态码，看到 `200 OK` 即返回，未对 SSE 流在产出首个有效内容块前的临时错误/超时/断流做预检与退避重试；
2. `retry-fetch.mjs` 的 `isAbort(e)` 将 `withIdleTimeout` 抛出的单次尝试 `TimeoutError`（外部 `signal.aborted === false`）误判为用户主动停止，导致闲置超时从不重试。

## 2. 改动计划与进展

- [ ] 区分用户主动停止（外部 `signal.aborted === true`）与单次尝试闲置超时（`TimeoutError`）
- [ ] 对 SSE 响应在产出首个有效内容块（`text_delta` / `thinking_delta` / `tool_use`）之前的上游超时与临时错误自动退避重试，已产出内容块后绝不重发
- [ ] 补齐 `server/test/retry-fetch.test.mjs`、`server/test/api-retry-wiring.test.mjs`、`server/test/idle-timeout.test.mjs` 单测
- [ ] 本地全量基线验证（`npx tsc -b --force`、`npm test`）
- [ ] 合入 `main` 并推送，同步更新生产节点 Agent 发布目录并验证 `/healthz`
