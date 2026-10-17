# 报告：流式请求首块前上游超时/临时错误自动重试修复（`gemini/sse-upstream-timeout-retry`）

- **日期**：2026-10-18
- **分支**：`gemini/sse-upstream-timeout-retry`（基于 `main` `6c235f1e`）
- **工作区**：`.worktrees/sse-upstream-timeout-retry`
- **状态**：已完成实现、本地全量基线验证与生产节点部署

---

## 1. 做了什么

### 1.1 背景与根因

在生产节点对话 `cc-mvcmrim9-7fu6` 中，模型调用第 7 轮（约 9 万输入 tokens + 128 个工具定义）及随后用户发「继续。」时，均在 92 秒后因 `The upstream service timed out. Please try again later. (request id: 202610180052009722857049rKYajio)` 直接中断，0 次重试。

根因有二：
1. **SSE 首包前错误绕过了 `createRetryingFetch`**：`stream: true` 下，中转网关（`api.openlux.ai`）先回了 HTTP `200 OK`（`text/event-stream`），等上游 90 秒超时后在 SSE 流里发回 `data: {"error":{"message":"The upstream service timed out. Please try again later. (request id: ...)"}}`（或流在产出首个有效块前断开/闲置超时）。`createRetryingFetch` 原先只检查 HTTP 响应头状态码，看到 200 就直接返回，随后 `openai.mjs` / `anthropic.mjs` / `gemini.mjs` 在 `readSse` 中读到 `parsed.error` 直接抛错，整轮任务失败退出——哪怕此时一个字的 `text_delta` / `thinking_delta` / `tool_use` 都还没有向界面或历史产出。
2. **`retry-fetch.mjs` 把 `withIdleTimeout` 的超时误判为用户停止**：`server/runners/api.mjs` 把 `withIdleTimeout` 包在 `createRetryingFetch` 里面，本意是单次尝试闲置超时后自动走下一次重试；但 `retry-fetch.mjs` 的 `isAbort(e)` 判断了 `e?.name === 'TimeoutError' || /aborted|abort/i.test(e?.message)`，把 `withIdleTimeout` 抛出的 `TimeoutError`（没有触发用户的 `signal.aborted`）当成了用户主动点停止，导致单次尝试闲置超时也从不重试。

### 1.2 具体改动

1. **区分「用户点停止」与「单次尝试闲置超时」**（[`server/harness/retry-fetch.mjs`](../../server/harness/retry-fetch.mjs)）
   - 将原有的 `isAbort(e)` 改为 `isUserAbort(e, externalSignal)`：
     - 只要传入了外部 `signal`（`opts.signal` 或 `init.signal`），仅当外部 `signal.aborted === true` 时才判定为用户主动停止（立即抛错不重试）；`fetchImpl` 内部单次尝试抛出的 `TimeoutError`（如 `withIdleTimeout` 到点，此时外部 `signal.aborted === false`）作为可重试故障按指数退避策略重试（受 `maxRetries` 与 `maxTotalMs` 总预算约束）。
     - 在未传外部 `signal` 的裸单测场景下，若 `e.name === 'TimeoutError'` 或消息匹配 `/timed?\s*out|timeout/i`，同样按超时故障重试，仅将非超时的 `AbortError` 视为停止。

2. **流式请求在产出首个有效内容块（`text_delta` / `thinking_delta` / `tool_use`）之前的临时性错误自动退避重试**（[`server/harness/retry-fetch.mjs`](../../server/harness/retry-fetch.mjs)、[`server/harness/idle-timeout.mjs`](../../server/harness/idle-timeout.mjs)、[`server/harness/providers/openai.mjs`](../../server/harness/providers/openai.mjs)、[`server/harness/providers/anthropic.mjs`](../../server/harness/providers/anthropic.mjs)、[`server/harness/providers/gemini.mjs`](../../server/harness/providers/gemini.mjs)、[`server/runners/api.mjs`](../../server/runners/api.mjs)）
   - 在 `createRetryingFetch` 中新增 `preflightSseResponse(response, userSignal)`、[`extractSseError`](../../server/harness/retry-fetch.mjs) 与 [`isRetryableSseError`](../../server/harness/retry-fetch.mjs)：
     - 对 HTTP 2xx 的 SSE 流响应，预读流事件直到确认产出首个可向下游交付的内容块（OpenAI 的非空 `delta.content` / `reasoning_content` / `finish_reason`、Anthropic 的非空 `content_block_delta` / 工具 `content_block_stop` / `message_stop`、Gemini 的非空 candidate `parts` / `finishReason`）。像 `message_start`、`ping`、仅含 `role: "assistant", content: ""` 的空帧、尚未闭合的 `<think>` 标签头或尚未 `finish_reason` 的半截工具参数均视为前导帧（`preamble`），继续预读。
     - 若在产出首个有效内容块前收到 SSE `error` 事件：
       - 属于上游超时（`timed out` / `timeout`）、过载（`overloaded` / `saturated`）、限流（`rate limit` / `429`）、网关/服务端临时错误（`500/502/503/504/529`、`bad gateway`、`service unavailable`、`try again later`、`upstream` 等）时，关闭当前流并按 `retry-fetch.mjs` 的指数退避与总预算（`maxRetries`、`maxTotalMs`）自动重发请求；
       - 属于明确的鉴权错（`invalid api key`、`unauthorized`、`401/403`）、参数错（`invalid argument`、`bad request`、`400`）、模型不存在或账户配额耗尽（`insufficient_quota`）时，绝不白白重试，将已读到的原始块原样回放给下游 Provider 立即抛错。
     - 若在产出首个有效内容块前发生网络异常、`TimeoutError`（`withIdleTimeout` 到点）、或空流意外结束（未产出任何内容也未收到正常收尾标记），同样按退避与总预算自动重发。
     - **安全红线**：一旦预读到首个有效内容块，`createRetryingFetch` 立即将已读原始块与后续流拼接返回给 Provider；一旦 Provider 已经向调用方 `yield` 过任何一个 `text_delta`、`thinking_delta` 或 `tool_use`，后续流中断或收到 `parsed.error` 绝不自动重发，直接按原样抛错。
   - 在 `anthropic.mjs` 与 `gemini.mjs` 中补齐流内 `parsed.error` 抛错与流意外提前结束（未收到 `message_stop` 或空流无 candidate）的抛错检查，与 `openai.mjs` 对齐。
   - 在 `idle-timeout.mjs` 的 `watched()` 中支持 `ReadableStream` 的 `getReader()` 迭代方式。
   - 在 `runners/api.mjs` 中支持可选的测试参数 `opts.retryForTest`，便于端到端接线测试快速驱动退避。

3. **测试覆盖**（[`server/test/retry-fetch.test.mjs`](../../server/test/retry-fetch.test.mjs)、[`server/test/api-retry-wiring.test.mjs`](../../server/test/api-retry-wiring.test.mjs)）
   - a. HTTP 200 SSE 流首包（及空 `role: "assistant"` 帧后）返回 `data: {"error":{"message":"The upstream service timed out. Please try again later. (request id: 202610180052009722857049rKYajio)"}}` 时自动重试，后续尝试正常流式返回时整轮成功、无 `error` 事件；
   - b. 单次尝试触发 `withIdleTimeout`（外部 `signal` 未 abort）时自动重试并成功；用户点击停止（外部 `signal.aborted === true`）时立即停止、绝不重试；
   - c. SSE 流已经吐出一半 `text_delta` 后再收到 `parsed.error` 或断流时，绝不重试，直接报错；
   - d. SSE 流首包返回不可重试错误（如 `Invalid API key provided` / `Invalid argument`）时不白白重试，一次即停；
   - e. `anthropic` 与 `gemini` 流在产出首个内容块前遇到 SSE 临时错误或空流断线同样自动重试。

---

## 2. 验证结果与证据

### 2.1 专项单测（`retry-fetch.test.mjs`、`api-retry-wiring.test.mjs`、`idle-timeout.test.mjs`）

- **命令**：
  ```powershell
  node --test server/test/retry-fetch.test.mjs server/test/api-retry-wiring.test.mjs server/test/idle-timeout.test.mjs
  ```
- **退出码**：`0`
- **结果**：`tests 27`、`pass 27`、`fail 0`（耗时 `5358.879 ms`）

### 2.2 类型检查（`npx tsc -b --force`）

- **命令**：
  ```powershell
  npx.cmd tsc -b --force
  ```
- **退出码**：`0`（零错误）

### 2.3 全量测试（`npm test`）

- **命令**：
  ```powershell
  $env:PROMPTCUT_ACCOUNT_PROVIDER_ROOT='C:\Users\admin\Documents\VisuHive'
  $env:PROMPTCUT_PASSWORD_ORDER_MODULE='C:\Users\admin\Documents\VisuHive\account\password-order.mjs'
  npm.cmd test
  ```
- **退出码**：`0`
- **结果**：`tests 7092`、`pass 7078`、`fail 0`、`cancelled 0`、`skipped 14`、`todo 0`（耗时 `197272.4763 ms`）

### 2.4 行尾检查（`eol-audit.mjs`）

- **命令**：
  ```powershell
  node ../../out/main-session-tools/eol-audit.mjs . main HEAD
  ```
- **结果**：全部修改文件均为 `LF → LF 孤立CR 0`，新建报告文件为 `LF 孤立CR 0`。

---

## 3. 没做成的与原因

无。

---

## 4. 对任务书或语义的更正建议

无。本次改动全部属于三级具体机制（`server/harness/` 与 `server/runners/api.mjs` 内部流式首块前重试与超时信号判别），不改变任何对外接口或一二级语义。

---

## 5. 合入 `main` 与生产节点部署记录（2026-10-18）

1. **合入 `main` 与清理工作区**：
   - 分支 `gemini/sse-upstream-timeout-retry`（`c8684fa3`）已通过 `--no-ff` 合入 `main`（合并提交 `cd275a14`），工作区 `.worktrees/sse-upstream-timeout-retry` 与本地临时分支已清理。
2. **生产节点互斥检查与备份更新（`root@149.88.94.84`）**：
   - 经 `systemctl show promptcut-agent -p ExecStart` 与 `/etc/promptcut/agent-root/agent-root.json` 核实，当前生产节点 `promptcut-agent.service`、`promptcut-agent-root.service` 及 6 个任务槽单元 `promptcut-agent-task-slot-a..f.service` 均运行在 `/opt/promptcut-render/releases/35f7b2abb9db`。
   - 经 `find /opt/promptcut-* /etc/promptcut* -newermt '-10 minutes'`、文档服务账本（`/var/lib/promptcut-v2/doc/docservice/account-v2.sqlite`：`activeCount: 0`）与 `account-root-main.mjs --status` 核实，无其它会话正在部署且 6 个槽全部处于 `closed / inactive / dead`。
   - 先将原文件备份至 `/root/sse-retry-backup-20261017T1851Z/`（`0700`），随后将本次改动的 6 个文件就地更新至 `/opt/promptcut-render/releases/35f7b2abb9db`（属主 `root:root`、权限 `0644`，LF 行尾，SHA-256 与本地 git blob 逐字节一致）：
     - `server/harness/retry-fetch.mjs`：`1635434f4777e857b029de0901c10fb8092378d68ad857159a32e37afd8811d3`
     - `server/harness/idle-timeout.mjs`：`ee32005cd0192be174538e1eafbf9121251f7e9af67af1d122e773bf913cb66f`
     - `server/harness/providers/openai.mjs`：`f75f4f32525ccf472767a794a140cefc1722d32251fb0205ad05260e377dcc46`
     - `server/harness/providers/anthropic.mjs`：`56927c62831358cf822697667a07ed42c540c1e10f89af32c160ffdccbadc7c8`
     - `server/harness/providers/gemini.mjs`：`cbd254a27b6cd1f2ab0d6c8fbbd7649bace5d9a4085d03542a4f479ef33d6e8e`
     - `server/runners/api.mjs`：`4c34269abc87ef96fd7951f4a25efef01849aeab5d6770ce8b0846f57850e53f`
   - 核验 `account-root-main.mjs --config /etc/promptcut/agent-root/agent-root.json --status`（包含 `assertRootOwnedCode`）6 个槽全部正常，且 `curl -sS http://127.0.0.1:8791/healthz` 返回 `{"ok":true,"version":"0.7.18","codeVersion":"0.7.18","egressTestAllow":false,"look":true,"collect":false,"collectTestRunner":false,"taskProcesses":true,"scheduler":true}`。
   - 部署与回滚说明已写入 `docs/local.md`。

