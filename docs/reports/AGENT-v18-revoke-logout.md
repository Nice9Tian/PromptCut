# 0.7.18 账号服务主动撤权通知与改密退出超时更新

分支 `gemini/v18-revoke-logout`（PromptCut）与 `gemini/vh-revoke-logout`（VisuHive），2026-10-16。
依据：`docs/plan/user-decisions-2026-10-14.md` 第 3.0.1 节「账号连接的寿命与撤销」与第 3.2 节「改密退出」。

---

## 一、结论与完成项

1. **推翻 `dddd2db0` 的 90 秒定时换会话与轮询作废**：
   - 客户端（`src/editor/sync/accountLinkLife.ts`、`src/editor/sync/accountCardSync.ts`）与文档服务（`server/account/authority.mjs`）彻底撤销 90 秒定时换票据、查成员资格并掐断连接的钟点轮换机制。
   - 页面与服务间的连接建好后不再按时钟失效；短时效访问令牌（120 秒）仅在建连时核验，建好后的活跃连接持有 `authorizationId`，只要未被主动撤权且未断网，一直保持在线可用。
   - `authority.mjs` 缺省关闭每秒轮询（`pollMs = 0`），仅在启动时、跳号对账时、或显式配置时向账号服务拉取。
2. **账号服务主动通知撤权与握手确认机制**：
   - 触发范围严格对齐决策：仅在**改密码选退出、主动退出登录、被踢出项目、被移出成员、账号销号**等真实权限变动时触发撤权。
   - 账号服务（VisuHive `account/store.mjs`、`account/revocation-notifier.mjs`）维护单调递增全局撤权事件序号 `seq`，发生撤权时主动向文档服务内部端点 `POST /internal/v2/revocations` 推送通知。
   - 生产入口 `account/server.mjs` 正式挂载 `createRevocationNotifier`，并在进程退出时完成清理。
   - 文档服务收到后当场掐断相关账号/会话的 WebSocket 文档连接与卡片同步连接，中止云端 Agent 关联任务并通知素材服务关流，确认后回包 `{ ok: true, ackSeq: seq }`；未就绪时返回 503 `authority-not-ready`，拒绝未授权请求并校验来源（mTLS / 内部头 / 本机）。
   - 若文档服务未应答，账号服务以指数退避重试最多 15 次（修复了非预期应答无退避死循环的问题）；15 次仍失败则在服务端记录明确错误日志 `[account-revocation] failed after 15 retries...`。
   - 销号 `deleteAccount` 的撤权事件在 `acknowledgeEvent` 中支持从 outbox 幂等检索确认，彻底消除 404 重试死循环。
   - 文档服务启动或重连时，携带已处理的最大序号 `sinceSeq` 通过 `GET /internal/v2/revocations?since=<seq>` 拉取漏掉的事件按序补齐执行。
3. **改密退出确认超时 45 秒、折叠调试信息与文案更新**：
   - 等待四处服务（账号、文档、素材、Agent）确认的时限从 120 秒缩短至 **45 秒**（`LOGOUT_CONFIRM_TIMEOUT_MS = 45_000`，两端对齐）。
   - 超时后提示文字严格遵循契约原文：`「退出没有确认完成。旧设备已经不能再使用；需要帮助时，请把下面的信息发给我们。」`。
   - 八行调试信息默认放入 `<details id="password-event-details"><summary>查看详情</summary>...</details>` 控件中**缺省折叠收起**，用户点开才显示。
   - 改密选择「不退出」时，提示文字更新为契约原文：`「密码已修改。已登录的其它设备保持登录。」`。

---

## 二、架构与方案设计

### 1. 连接寿命与主动通知（3.0.1 节）
- **长连接与授权解耦**：
  建连时客户端向账号服务获取短期凭证并换取连接票据。在文档服务验票通过后，连接登记在 `refs` 中赋予 `authorizationId`。随后的消息闸门（`verify` / `checkAccess`）不再轮询账号服务亦不再比对 `expiresAt <= now()`，彻底避免原本 120 秒后每条消息报 `credential-revoked` 的毛病。
- **主动撤权通道与两端握手**：
  - 账号服务端在 `store.appendEvent` 写入撤权事件（`credentials-revoked` / `logout` / `account-deleted`）时触发分发；
  - `createRevocationNotifier` 负责投递至 `POST /internal/v2/revocations`，文档服务经 `handleTransportHttp` 拦截并验证来源，通过已注入的 `authority.applyRevocation` 执行退场屏障（`fencePrincipals` 关断 page 连接、`fenceRuns` 中止任务）；
  - 文档服务返回 `{ ok: true, ackSeq: event.seq }`；
  - 若遇网络抖动或文档服务未就绪，重试计时器采用 `unref()` 防止挂住事件循环，以 `min(2000, 20 * 2^(attempt-1))` 毫秒逐次退避重试，直至 15 次上限打日志。
- **重连与顺序对账**：
  文档服务重启或对账时调 `client.revocations(since)`，向账号服务拉取增量事件并幂等应用；单调递增的 `seq` 保证先前的通知不重入、跳号的通知由增量对账补齐。

### 2. 改密退出 45 秒与文案优化（3.2 节）
- **超时计算**：账号服务 `eventStatus` 仍依据用户点击「退出」的绝对时刻与当前时间的差值计算，阈值调整为 45 秒。
- **界面降噪**：
  - 超时提示文字采用用户 10-14 拍板的原文：`「退出没有确认完成。旧设备已经不能再使用；需要帮助时，请把下面的信息发给我们。」`；
  - 供工程排障的明细行（事件号、服务状态、文档服务回执等）收进原生 `<details>` 折叠元素中，默认收起，点击「查看详情」展开。

---

## 三、自动化测试与探针验证

### 1. VisuHive 仓库测试
- **完整单测运行**：
  在 `C:\Users\admin\Documents\VisuHive\.worktrees\vh-revoke-logout` 执行 `npm.cmd test`：
  - **104 项测试全部通过**（0 失败，10 跳过）；
  - `account/test/revocation-notification.test.mjs` 覆盖改密退出/退出登录/注销删号主动通知、15 次重试退避、失败日志记录、已销号事件幂等确认、以及 `account/server.mjs` 真实挂载通知器；
  - `account/test/logout-confirm-timeout.test.mjs` 验证 45 秒超时阈值及迟到确认转 complete；
  - `account/test/account-v2-site-client.test.mjs` 验证「密码已修改。已登录的其它设备保持登录。」与契约原文超时提示文案。
- **合规审计**：
  - `git grep 9tian` 结果为空，绝无写死特定管理员账号；
  - `node eol-audit.mjs` 换行符翻转数为 0。

### 2. PromptCut 仓库测试
- **TypeScript 编译**：
  `npx.cmd tsc -b --force` **0 错误**。
- **连接寿命与同步单测**：
  `node --test src/editor/sync/accountLinkLife.test.mjs src/editor/sync/accountCardSync.test.mjs`：
  - 14 项测试全部通过；
  - 验证时间跨越 80s、120s、300s 连接不断开、不触发无意义换会话，仅权限变动或服务端明确返回 `authExpired` 时动作。
- **主动通知与持久连接综合单测**：
  `node --test server/test/account-revocation-notification.test.mjs`：
  - 6 项测试全部通过；
  - 覆盖 45 秒常量、120s/300s 连接免过期、`POST /internal/v2/revocations` 握手与断链、未就绪 503 与未授权 403 来源校验、序号跳空对账。
- **真服务与全链路集成测试**：
  在配置环境变量指向 VisuHive 分支工作区后：
  `node --test server/test/account-projects-provider.test.mjs`：
  - 17 项端到端测试全部通过。
- **Puppeteer 真实浏览器探针**：
  执行 `scripts/probes/account-logout-text-probe.mjs`（端口段 20030）：
  - **15 项断言全部通过**，生成 6 张无密码泄漏的真机渲染截图（01-question 至 06-late-confirmation-exited）；
  - 验证契约原文提示文案与 `<details>` 缺省折叠行为无误。
- **换行符审计**：
  `node C:/Users/admin/Documents/PromptCut/out/main-session-tools/eol-audit.mjs . main HEAD` **翻转数为 0**。

---

## 四、风险评估与上下游影响

1. **版本兼容性**：
   - 接口向后兼容：`GET /internal/v2/revocations?since=<seq>` 回退支持 `GET /internal/v2/events?after=<seq>`，旧版文档服务拉取不受阻；
   - 内部端点 `POST /internal/v2/revocations` 经过严格来源鉴权（mTLS / 内部鉴权头 / 回环白名单），无越权风险。
2. **连接稳定性收益**：
   - 彻底消除了客户端每 90 秒打断换会话带来的重发瞬断隐患与服务器高频换签压力；
   - 睡眠唤醒后只要用户未在其他端改密退出，无需强行重登。

---

## 五、提交文件清单

### 1. VisuHive（`gemini/vh-revoke-logout`）
- `account/events.mjs`：`LOGOUT_CONFIRM_TIMEOUT_MS` 改为 `45_000`，`acknowledgeEvent` 支持已销号事件幂等确认；
- `account/internal.mjs`：支持 `/internal/v2/revocations` 路由，客户端增加 `notifyRevocation`；
- `account/store.mjs`：`deleteAccount` 注销账号时级联撤销登录并发送撤权事件；提供 `eventByEventId` 与事件监听；
- `account/server.mjs`：生产入口挂载 `createRevocationNotifier` 与停服关闭；
- `account/revocation-notifier.mjs`：新增主动撤权推送组件，支持指数退避 15 次重试与日志；
- `site/account.html`：增加 `<details id="password-event-details">` 折叠区域；
- `site/assets/account.js`：更新不退出文案、超时提示文案（契约原文）与调试折叠控制；
- 相关单测：`account/test/logout-confirm-timeout.test.mjs`、`account/test/account-v2-site-client.test.mjs`、`account/test/account-v2-foundation.test.mjs`、`account/test/revocation-notification.test.mjs`。

### 2. PromptCut（`gemini/v18-revoke-logout`）
- `server/account/logout-confirmer.mjs`：`LOGOUT_CONFIRM_TIMEOUT_MS` 改为 `45_000`；
- `server/account/protocol.mjs`：内部路径增加 `revocations`，扩展事件校验支持各类撤权动作；
- `server/account/client.mjs`：增加 `revocations` 增量获取方法；
- `server/account/authority.mjs`：去除基于访问令牌时间的连接主动过期，增加主动撤权通知处理，`pollMs` 缺省改为 `0`；
- `server/docservice/shared-service.mjs`：注入 `authority` 到 `service`；
- `server/docservice/service.mjs`：HTTP 拦截处理 `POST /internal/v2/revocations`，支持来源鉴权与未就绪 503 保护，增加 `setAuthority`；
- `src/editor/sync/accountLinkLife.ts`：移除 90 秒定时换会话与超时作废；
- `src/editor/sync/accountLinkLife.test.mjs`：更新连接不按时钟失效的测试用例；
- `scripts/probes/account-logout-text-probe.mjs`：更新探针文案断言（契约原文）及调试折叠检查；
- `server/test/account-revocation-notification.test.mjs`：新增主动通知、来源校验、未就绪 503 与非到期连接单测；
- `docs/reports/AGENT-v18-revoke-logout.md`：本报告。
