# AGENT 报告：v18-fix-account-tests 基线测试修复与安全核查

- **执行 Agent**：`v18-fix-account-tests`（Argon High / `pro`）
- **基线版本**：`e40065cc`
- **工作区分支**：`gemini/v18-fix-account-tests`（工作目录：`C:\Users\admin\Documents\PromptCut\.worktrees\v18-fix-account-tests`）
- **依据决策**：
  - `docs/reports/VERIFY-main-2026-10-17.md`（第 2 节第 28–31 行、第 4.3 节）
  - `docs/plan/user-decisions-2026-10-14.md`（第 3.0.1 节「账号连接寿命与撤销」、第 3.2 节「改密退出」、第 3.4 节）
  - 任务指引安全红线：测安全性质的测试绝不改松断言，彻底严查并修复代码缺陷。

---

## 一、修复清单与根因、安全性质核实总结

| 测试套件 | 失败现象 | 根因分类 | 修复方式与安全核实 |
|---|---|---|---|
| `server/test/operation-wiring-core.test.mjs` | ① `entry and both commit phases recheck real credential` 失败<br>② `credential revoked in reserve/seal gap is rejected despite cached creator principal` 失败 | **代码回退**（`611fb04c` 误伤） | 在 `server/account/authority.mjs` 的 `verify()` 中，`611fb04c` 为实现连接不按 120 秒到期，在传入 `authorizationId` 时直接早退并跳过了对账号服务实时的 `accountClient.verify(token)` 与 `synchronize()`。补回实时的 `accountClient.verify(token)` 与同步，**不修改测试断言**，两项安全测试原样全过。 |
| `server/test/account-assembly-central.test.mjs` | `Missing expected rejection`（`selection-page-unavailable`） | **代码回退**（`611fb04c` 误伤） | 因 `authority.mjs` 中 `verify()` 跳过了异步凭证核验与账号同步微任务，导致 `closePages()` 断开 WS 连接时服务器端的 disconnect 尚未在事件循环完成即返回了 selection 结果。补回凭证实时校验与同步后，所有断言**原样全过**。 |
| `server/test/account-logout-confirmation.test.mjs` | `三种故障都真的发生过: [0, 2, 1] !== [3, 2, 1]` | **测试匹配过时**（`611fb04c` 引入） | `611fb04c` 将文档服务拉取账号事件的端点升级为 `client.revocations()`（优先请求 `/internal/v2/revocations`），测试桩中的故障注入正则硬编码为 `/^GET \/internal\/v2\/events$/`，未能匹配到增量拉取。将路由匹配正则更新为 `/^GET \/internal\/v2\/(?:events\|revocations)$/` 后，3 次丢请求、2 次丢确认、1 次丢见证全部真实发生并验证办完。 |
| `server/test/account-page-link.test.mjs` | ① 「丙换了 0 次会话」<br>② 登录 130 秒后甲的提交未落地 | **测试断言过时**（10-14 3.0.1 推翻 `dddd2db0`）+ **客户端拒收事件冒泡缺陷** | ① 10-14 第 3.0.1 节明确推翻 `dddd2db0`「每 90 秒自动换会话」旧规：长连接时间流逝保持不断、不无故换会话。将断言更新为验证 `swaps === 0`、连接不断、40 次修改全部落地。<br>② 在 `authority.mjs` 中支持凭证在后台续期时同步更新已有 `ref` 的凭证信息，同时在 `src/editor/sync/link.ts` 中补充识别 `project.op.rejected` 附带的 `credential-revoked` / `authorization-expired` 触发 `onAuthExpired` 重新建连补发，全链路平滑接续。用例全部通过。 |
| `server/test/account-card-sync.test.mjs` | `timeout: 到期的连接被闸拒,端点换会话` | **测试断言过时**（10-14 3.0.1 推翻 `dddd2db0`） | 7c 原用例在断言「120 秒时钟到期必须被闸拒」。依据 10-14 3.0.1 节新规则，时间流逝长连接保持不断、不按时钟到期强行拒断换会话。更新断言验证时间到期后连接仍然保持、改动直接上传成功（`renews.length === 0`）。 |
| `server/test/gone-trust-source.test.mjs` | 守门失败：`actual: ['recoveryAssociation.ts', 'syncManager.ts']` | **守门白名单跟进**（`0ba84411` 引入） | `0ba84411` 在 `recoveryAssociation.ts` 中新增了打开 `.proc` 文件时核对云端项目是否已删的逻辑。严查其实现：严格调用无自备信任表的 `queryGone(d)`，且仅在验出有效签名证明时才转本地项目，未破坏安全边界。更新守门测试，将两个模块同时纳入「只引 queryGone、不传自备信任表、不碰信任表」的守卫审计中，测试全过。 |
| `src/ai/cloud/page-requests.test.mjs` | CAU-REV-06 守门正则匹配失败 | **守门正则跟进**（`301f8a39` 引入） | `301f8a39` 在 `useCloud.ts` 中向 `createCloudSession` 注入了私有对话作废持久化所需的 `projectId` 与 `accountId` 选项，导致 CAU-REV-06 的严格文本匹配未命中。核查代码未破坏安全执行边界后，调整正则兼容可选配置项，13 条测试全部通过。 |
| `server/test/account-logout-timeout.test.mjs` | 全量测试时偶发 `EADDRINUSE` 端口冲突 | **测试夹具端口硬编码** | 夹具原先硬编码了端口 `28150..28157`，改为使用动态分配的 `freePorts(8)`，消除端口冲突。 |
| `server/test/account-hosted-wiring.test.mjs` | `hosted account v2` | **验证通过** | `hosted account v2` 单测完全通过；套件中仅存的失败项为 `staged hosted account dependencies`（按要求留给队列组修复部署清单 `server/hosted/files.mjs`）。 |

---

## 二、关键安全性质与代码修复细节

### 1. `server/account/authority.mjs`：安全重核与免时钟失效解耦
- **安全红线恢复**：
  在 `verify()` 中恢复了调用账号客户端实时的 `accountClient.verify(token)` 与 `synchronize()`。每一次操作提交时，真实向账号权威重查凭证有效性与最新撤权事件，一旦改密、登出、销号或踢人事件入账，立即拒绝并撤权。
- **免时钟失效实现**：
  已建立长连接（持有 `authorizationId`）在初始验票通过后记录在 `refs` 中。若账号服务端凭证通过 recover 接口滚动刷新，新的凭证与到期时刻在 `authority` 层同步刷新绑定的 `ref`，使得长连接不因本地 120 秒时钟流逝而无故断开；但一旦账号服务发生实质撤权，拒绝机制原样生效。

### 2. `src/editor/sync/link.ts`：拒绝原因的完整鉴权感知
- `SyncLink` 内部原仅在收到 `{ type: 'error' }` 且为 `AUTH_EXPIRED_REASONS` 时触发 `onAuthExpired`；当服务端在操作层返回 `{ type: 'project.op.rejected', reason: 'credential-revoked' }` 时，未能及时通知寿命管理模块重连。
- 修复：识别包含 `credential-revoked` 与 `authorization-expired` 的 `project.op.rejected` 信号，不向 `DocSync` 派发永久丢弃指令，而是及时触发 `onAuthExpired` 启动端点重连与提交重试，保障离线与重入操作不丢失。

---

## 三、验证结果记录

1. **TypeScript 编译类型检查**：
   ```bash
   npx.cmd tsc -b --force
   # 输出：0 错误（Process exited with code 0）
   ```

2. **本组 12 个测试文件综合运行**：
   ```bash
   npm.cmd test -- \
     server/test/operation-wiring-core.test.mjs \
     server/test/account-assembly-central.test.mjs \
     server/test/account-logout-confirmation.test.mjs \
     server/test/account-hosted-wiring.test.mjs \
     server/test/account-page-link.test.mjs \
     server/test/account-card-sync.test.mjs \
     server/test/gone-trust-source.test.mjs \
     src/ai/cloud/page-requests.test.mjs \
     server/test/account-logout-timeout.test.mjs \
     server/test/account-revocation-notification.test.mjs \
     src/editor/sync/accountLinkLife.test.mjs \
     src/editor/sync/accountCardSync.test.mjs
   ```
   - **统计结果**：`tests 74, pass 73, fail 1`
   - **唯一失败**：`account-hosted-wiring.test.mjs` 中的 `staged hosted account dependencies are present and required mode fails closed without configuration`（缺失 `server/render-node/session.mjs`，按任务约定严禁越界修改 `server/hosted/files.mjs`，由队列组修复）。
   - **本组所有负责的测试全部 100% 通过**！

3. **行尾换行符审计**：
   ```bash
   node C:/Users/admin/Documents/PromptCut/out/main-session-tools/eol-audit.mjs . e40065cc HEAD
   # 输出：0 行尾翻转（Process exited with code 0）
   ```

---

## 四、修改文件清单

- `server/account/authority.mjs`
- `server/docservice/operation-wiring.mjs`
- `src/editor/sync/link.ts`
- `server/test/account-card-sync.test.mjs`
- `server/test/account-logout-confirmation.test.mjs`
- `server/test/account-logout-timeout.test.mjs`
- `server/test/account-page-link.test.mjs`
- `server/test/gone-trust-source.test.mjs`
- `src/ai/cloud/page-requests.test.mjs`
- `docs/reports/AGENT-v18-fix-account-tests.md`
