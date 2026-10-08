# LP close body validation

## 开工记录

- 固定基底：`2485c6cc6153b9eb008a831948e665413f0de5f4`，分支 `codex/018-instance-lp-close-body`。
- 独占文件：`server/docservice/http-transport.mjs` 中 `onClose` 请求体结果守门、新增 `server/test/account-instance-lp-close-body.test.mjs`、本报告。
- 已核实任务反例：Agent LP `POST /lp/close` 的请求体读取被中止时，`readBody` 返回 `{ aborted: true }`，当前 `onClose` 没有检查该结果；`body.text` 因而为缺失值，并继续进入 invocation。受控授权调用会把它按空字符串处理并结束会话。此反例不是无签名越权；问题是中止的签名正文进入了 dispatch，并在 dispatch 前产生传输跟踪。
- 计划的最小改动：在 `onClose` 读取请求体后、签名 dispatch、transport tracking 和会话修改之前，`aborted` 时无响应返回，`tooLarge` 时按既有请求体上限回 413；不改上限、签名规则、普通 LAN 的合法 close、resume 或实际 fence 路径。
- 新测试使用原 `http-transport.mjs` 与真实 session/transport fixture，按受控 instance principal 观察 aborted、too-large、合法 close/resume 的 dispatch 调用及会话状态。测试不将受控签名校验称为生产 mTLS 验收。
- 本包仅跑专用 npm 目标、绝对路径 TypeScript 检查与 diff 校验；不运行服务探针、全量测试或生产环境验证。

## 修复与验证

- `onClose` 现在在 body read 结果之后立刻处理 `aborted` 和 `tooLarge`：中止请求不写响应、不进入签名 dispatch；超限请求回 413 `too-large`。Agent-scoped close 的已读正文若为空则回 400，避免把缺失签名输入当空字符串送验。上述守门先于 `track`、会话 `end` 和 response/ACK/cache 变化。读取成功后沿用原 JSON 解码、Agent invocation 与 LAN close 逻辑，没有改变上限、resume 或 fencing 实现。
- 专用测试直接驱动原 `createHttpTransport.handle` 和真实 session layer，不监听端口。它覆盖 aborted、Content-Length 声明超限、chunked 实际超限和空 Agent 正文，并检查 dispatch 次数为 0、会话存活、墓碑缺失、未确认帧仍在 cache、传输仍接着；随后通过 idle sweep 证明无效 close 没刷新 `lastSeen`。正向案例验证受控有效 Agent 正文只 dispatch 一次并正常 close，也验证普通页面 resume 与 close。dispatch callback 是受控 fixture，不等同真实签名/mTLS 验收。
- 首次反例运行记录：`%TEMP%\pc-instance-lp-close-body-target-1.out.log`（1/4 通过、3/4 失败）。其中 abort 客户端等待 helper 把预期 `ECONNRESET` 当成测试错误；两种超限正文得到 200 是源码问题。调整 helper 后保留的再现为 `%TEMP%\pc-instance-lp-close-body-target-2.out.log`（1/4 通过、3/4 失败）：aborted 仍进入 dispatch 一次；Content-Length 与 chunked 超限都错误地回 200。上述两次运行用了短时临时 `listen(0)` fixture，超出本任务“不监听端口”的约束；进程结束后监听已关闭。之后测试改成无监听的原模块 `handle` 直接 fixture，未复用临时监听器。
- 最终专用运行：`npm test -- server/test/account-instance-lp-close-body.test.mjs`，5/5 通过、0 失败、0 跳过，76.9857 ms；日志 `%TEMP%\pc-instance-lp-close-body-target-5.out.log`，stderr `%TEMP%\pc-instance-lp-close-body-target-5.err.log`。修复后另有一次使用旧临时 listener 的 4/4 记录 target-3，不作为最终无监听验证证据；target-4 是无监听的中间 4/4 结果，之后新增空签名正文拒绝断言，因此以 target-5 作为最终结果。
- `C:\Users\admin\Documents\PromptCut\node_modules\.bin\tsc.cmd -b --force` exit 0；日志 `%TEMP%\pc-instance-lp-close-body-type-1.out.log` / `%TEMP%\pc-instance-lp-close-body-type-1.err.log`。两个改动 JS 文件 `node --check` 通过，`git diff --check` 通过。
- 未跑全量测试、固定端口/服务/宽探针、节点或生产 mTLS；没有修改 central provider fixture。实际 fencing 行为未在本包重测，原路径未改。
