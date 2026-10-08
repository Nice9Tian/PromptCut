# LP close body validation

## 开工记录

- 固定基底：`2485c6cc6153b9eb008a831948e665413f0de5f4`，分支 `codex/018-instance-lp-close-body`。
- 独占文件：`server/docservice/http-transport.mjs` 中 `onClose` 请求体结果守门、新增 `server/test/account-instance-lp-close-body.test.mjs`、本报告。
- 已核实任务反例：Agent LP `POST /lp/close` 的请求体读取被中止时，`readBody` 返回 `{ aborted: true }`，当前 `onClose` 没有检查该结果；`body.text` 因而为缺失值，并继续进入 invocation。受控授权调用会把它按空字符串处理并结束会话。此反例不是无签名越权；问题是中止的签名正文进入了 dispatch，并在 dispatch 前产生传输跟踪。
- 计划的最小改动：在 `onClose` 读取请求体后、签名 dispatch、transport tracking 和会话修改之前，`aborted` 时无响应返回，`tooLarge` 时按既有请求体上限回 413；不改上限、签名规则、普通 LAN 的合法 close、resume 或实际 fence 路径。
- 新测试使用原 `http-transport.mjs` 与真实 session/transport fixture，按受控 instance principal 观察 aborted、too-large、合法 close/resume 的 dispatch 调用及会话状态。测试不将受控签名校验称为生产 mTLS 验收。
- 本包仅跑专用 npm 目标、绝对路径 TypeScript 检查与 diff 校验；不运行服务探针、全量测试或生产环境验证。
