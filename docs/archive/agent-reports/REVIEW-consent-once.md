# 安全审查：claude/consent-once

审查对象：分支 `claude/consent-once`，`f203e318`..`efdd19cb`（5 个提交，从 main `141e0be8` 切）。
审查人：Opus 子 Agent，对抗性审查，不改功能代码。
改动目的：云端 Agent 发一条消息时，页面向账号服务读「首次使用告知」的次数从 2 次降到 1 次（开头读一次、发「一次性许可」，发出前同步核许可）。

## 结论

**可以合入。** 没有发现能绕过告知或身份核验把消息发给云端 Agent 的路径。下面有两处界面上不够好的地方（都不是安全问题），建议合入前顺手改，或者主会话决定记成后续项。

对主会话要交给用户的那句话：

> **这个改动没有任何一条路径，能让一个没有接受过告知、或者已经被撤权／被踢出项目／已退出登录的身份，成功把消息发给云端 Agent。** 消息要进 Agent 的队列，必须经过文档服务 `conversation-authority.mjs` 的 `send`，它每一条都现场向账号服务核身份、核项目成员资格、核告知，不采信页面的任何结论；这一关本次没有改动。页面那一侧少读的这一次只影响「在极少数情况下，用户看到的拒绝提示换了一种说法」，不影响能不能发出去。

## 支点：服务端这一关是真的在，而且是现场核

自己读代码核实，不采信实施者报告的转述：

| 关口 | 位置 | 核什么 | 不通过回什么 |
|---|---|---|---|
| 身份 | `server/account/conversation-authority.mjs:247` → `server/account/authority.mjs:196-215` `verify` | 每次都现场调 `accountClient.verify(token)`（`authority.mjs:211`，`server/account/client.mjs:45-52` 每次发 POST，无缓存），再同步吊销事件，查 `revokedLogins`（`:209`、`:215`） | 401 `credential-revoked` / `authorization-expired` / `principal-mismatch` |
| 项目成员 | `conversation-authority.mjs:33-43` `projectAccessInState`（`send` 里在 `:258`、`:271`、`:287` 等处各核一次） | 被踢（不在名单）、被封、只读、云端 Agent 被关 | 403 `not-listed` / `banned` / `agent-disabled`；只读 403 |
| 告知 | `conversation-authority.mjs:248-250` | `checkConsent` 必须存在，且返回 `accepted === true`、`noticeVersion === 1`、账号对得上；在「同一请求号重放」分支（`:254`）之前就核，所以重放旧请求也绕不过 | 403 `consent-required`（缺 `checkConsent` 时 503 `consent-unavailable`，失败即拒） |
| 告知的来源 | `server/hosted/doc-agent-assembly.mjs:194-199` | 每次现场 `GET /internal/v2/consents?accountId=…` 问账号服务；形状不对 503 | — |
| 唯一入口 | `server/account/conversation-internal.mjs:58` 是 `conversationAuthority.send` 唯一的调用方；它只认 Agent 服务的钉死证书（`:34`），请求体里自报的身份字段一律 400（`:41-43`）。Agent 服务的账号模式 `send`（`server/agent/service/conversation-policy.mjs:79-90`）只是转发到这里 | — | — |

服务端测试我自己跑过（命令见「验证」）：`agent-access-conversation.test.mjs` 的「read-only, revoked and consent-absent send fail before queue」直接断言了撤权 401、只读 403、未同意 `consent-required` 且账本里没有新对话；`agent-access-http.test.mjs` 走真实 mTLS 文档服务 + HTTP Agent 服务，`POST /v1/conversations/c2/messages` 在未同意时回 403 `consent-required`。

所以页面上的两次读取本来就只是「早点让用户看到告知框、少白等一趟」，不是安全边界：恶意页面可以直接调 Agent 服务的 HTTP 接口，根本不走 `requireCloudConsent`。

## 逐项核对任务书的 6 个问题

### 1. 5 秒窗口

`spendPermit`（`src/ai/cloud/consent.ts:114-125`）的作废条件能覆盖的，是**页面自己能看到的**事件：

- 退出登录、本页换号、凭证在本页被换：账号客户端发 `authChanged` → `consent.ts:25-31` 把 `generation`、`requestSeq` 都加一、清空已同意 → 先被 `assertBinding` 抛 `credential-revoked`。探针与新单测都核过。
- 换项目、重新绑定、解绑：`setCloudConsentSource`（`:17-22`）同上。
- 别处又读了一次或刚确认过：`requestSeq` 变 → 退回真读。

**页面看不到、作废条件触发不了的事件**（这一条实施者的报告也承认了「服务端改告知版本」这一类，但没列全）：

- 账号服务那边告知被重置或版本升级；
- 凭证在服务端被吊销（别的设备「全部退出」、改密撤回），而本页账号客户端还没收到通知；
- 被创建者踢出项目或封禁（这一条**改前的第二次读取本来也查不到**：账号服务的告知接口不看项目成员资格）。

在这三种情况下，5 秒内页面这一关会放行（探针 P2、P3 实测确认），消息照样 POST 出去，然后被服务端拒：告知 403 `consent-required`，吊销 401，被踢 403。**不能真的发出去。** 改前同样存在「第二次读取 → POST」这段窗口，只是更短（毫秒级，加上组装 `pageState` 的时间）；改后窗口最长约 5 秒加上开头读取的回程。

### 2. 一次性是不是真的一次性

是。`spendPermit` 是同步函数，第一行查 `used`，第二行就置 `used = true`（`consent.ts:116-117`），中间没有 `await`；JS 单线程下不存在两条路径同时拿到「未用」的可能。许可只认模块私有 `WeakMap` 里的记录，外面伪造同形对象不算。探针 P1：同一张许可同时交给两次 `requireCloudConsent`，第一条免读放行，第二条退回真读（服务端此时已不同意，被拒），读取计数 2。

小出入：实施者说「第一次校验就作废，不论通过与否」，不完全准确——`requireCloudConsent` 在调 `spendPermit` 之前先跑 `assertBinding` 和 `boundSource`（`:134-135`），这两个抛错时许可**没有**被标为用过。但这只在绑定已经变了的时候发生，许可里记的 `generation` 已经对不上，之后永远核不过（探针 P6），不构成重放。

### 3. 服务端那道关

见上面「支点」一节。严，且每次现场核。

### 4. 退化路径

逐条核过 `requireCloudConsent`（`consent.ts:132-141`）：

- 带许可时：`assertBinding` 抛 `credential-revoked`、`boundSource` 抛 `login-required`——这两个错误码和不带许可时 `refreshCloudConsent` 开头（`:50-51`）抛的**完全相同、顺序相同**，界面不会把撤权说成别的意思。
- `spendPermit` 返回 `false` 的所有分支都落到下面的 `refreshCloudConsent` 真读，没有直接放行，也没有新的直接拒绝。
- `spendPermit` 返回 `true` 的唯一一条路要求 14 个条件全部成立。
- 不带许可（`permit` 为 `null`/`undefined`）或不带 `expected` 时，代码和改前逐字一样。

`grantCloudConsent`（`:102-111`）只在 `refreshCloudConsent` 返回 `true` 之后才可能发许可，而 `refreshCloudConsent` 只有在本次读取没被后来的读取取代、且服务端说已同意时才返回 `true`（`:59-61`）。

### 5. 新测试是不是真能证明

- 16 条新用例用的是**真的** `consent.ts` 和真的 `createAccountClient`，只把最底层的 `native` 桥换成假账号服务；作废路径（换凭证、退出、换绑、解绑、插进来的读取、在途读取、过期、伪造）都是走真代码触发的，不是测桩。这一点成立。
- 「请求计数 2→1」：在 `native` 桥上数 `/api/account/cloud-agent-consent` 的 GET，量法可信。但「改前 2 次」那条用例（`consent-once.test.mjs:35-42`）是**手工按旧路径调用** `refreshCloudConsent` + `requireCloudConsent` 模拟出来的，没有跑旧的面板代码；不过无许可路径的代码确实没变，这个模拟是对的。
- 「4 条消息 8→4」：只有「改后 4」是测出来的（`:51-52`，1 + 3）；「改前 8」是按 2×4 推出来的，没有用例量。不影响结论，报告措辞应改成「推算」。
- 「接线」那条（`:201-210`）是对源码做正则匹配，只能证明四处调用写了 `admission.permit`，不能证明 React 面板运行时只读一次。没有面板级的集成测试或真实页面探针（实施者报告「没做成的」里已如实说明）。
- 新用例**没覆盖**：同一许可并发使用（我的 P1 补了）、页面看不到的服务端变化（P2、P3 补了，说明这时完全靠服务端）、`grant` 读到已同意却回 `null`（P4，见下面问题 A）。

### 6. 原有安全用例有没有改松

没有。`git diff 141e0be8..efdd19cb --stat` 里没有 `src/ai/cloud/consent.test.mjs`，原 6 条一字未动，且全部通过。

## 确实是问题（都不是安全问题）

### A. 已同意的用户可能被误弹告知框（低）

- **在哪**：`src/ai/cloud/consent.ts:104-107`；`src/editor/right/CloudAiPanel.tsx:101-103`。
- **是什么**：`grantCloudConsent` 在 `refreshCloudConsent` 已经返回 `true`（服务端说已同意）之后，还会因为「续跑前别处又起了一次读取（`state.pending`）」或「绑定在这一瞬间变了」而回 `null`。面板把 `null` 一律当成「没同意」，`setConsentOpen(true)` 弹告知框、把乐观气泡标成「请先阅读并确认告知」。改前同样情形下 `refreshCloudConsent` 返回 `true`，面板直接放行。
- **怎么触发**：`await refreshCloudConsent` 返回到 `grant` 续跑之间有一个微任务的空隙，这时另一条发送、附件选择或重试恰好开始读取。探针 P4 用订阅回调构造出来了。实际页面里很难碰上（React 的订阅者不会同步起读取）。
- **后果**：不能绕过任何东西，只是白弹一次框；用户点「我知道了」会再提交一次确认（幂等）。
- **建议**：让 `grantCloudConsent` 区分「服务端说没同意」和「同意了但这次发不出许可」，例如返回 `{ accepted: boolean; permit: CloudConsentPermit | null }`；面板只在 `accepted === false` 时弹框，`accepted === true && permit === null` 时照常发送、`permit` 传 `null`（发送接口会自己再读一次，等于改前行为）。

### B. 页面看不到的服务端变化，在窗口内变成一条生硬的报错（低）

- **在哪**：`src/ai/cloud/cloudApi.ts:83`（`cloudErrorText` 的 `default` 分支）；`src/ai/cloud/useCloud.ts:492-494`。
- **是什么**：问题 1 里那三类页面看不到的事件，改前大多数会被第二次读取接住，显示「使用云端 Agent 前，请先阅读并确认告知。」或「登录已失效，请重新登录。」；改后在 5 秒窗口里会一路走到服务端被拒，`consent-required` 没有对应文案，界面显示「云端 Agent 出错了(consent-required)。」，也不会弹告知框。
- **怎么触发**：开头读取之后、POST 之前的约 5 秒内，账号服务一侧重置了告知或吊销了凭证。
- **后果**：消息发不出去（服务端拒了），只是提示不友好；概率很低。
- **建议**：在 `cloudErrorText` 加 `consent-required` 一条，用和 `CloudConsentRequiredError` 一样的文案；更好的是 `useCloud.ts` 的 `send` 收到这个码时也让面板弹告知框。`cloudApi.ts` 不在本分支的文件清单里，要不要扩范围由主会话定。另外也可以把 `CLOUD_CONSENT_PERMIT_TTL_MS` 从 5 秒降到 1～2 秒：开头读取到 POST 之间只有放素材库可能慢，而那种情况本来就会过期重读，降低几乎不损失收益。

## 我不确定、要主会话定的

- **用墙钟算有效期**（`consent.ts:97`，`Date.now()`）：系统时间往回拨 N 秒，许可的有效期会被拉长 N 秒；往前拨只会让它提前过期（安全方向）。因为服务端那一关在，这不构成绕过。建议改用 `performance.now()`（单调时钟），测试钩子不变。
- **测试钩子 `setCloudConsentClockForTest` 进了生产包**（`consent.ts:99`）：页面里的任何代码都能把时钟钉死、让许可永不过期。但能在页面里跑代码的人本来就能直接调 Agent 服务的接口，所以不增加实际风险。要不要换成只在测试构建里可见的写法，主会话定。
- **附件上传路径**白发一张不会被用的许可（`CloudAiPanel.tsx:469`、`:483` 只用真假）：无害，许可不被使用且下一次读取就让它作废；只是语义上多余。
- **实施者报告建议把「一次发送只核一次告知、许可 5 秒」写进 `mechanism/agent.md`**：我同意这是三级机制，可以写；如果采纳上面「降到 1～2 秒」，写进去的数字跟着改。按规则需要用户确认。

## 验证

所有命令在 worktree `C:\Users\admin\Documents\PromptCut\.worktrees\consent-once` 里跑，跑前按任务书设了两个本机环境变量（值不写进报告）。

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm test -- src/ai/cloud/consent.test.mjs src/ai/cloud/consent-once.test.mjs` | 0 | 22 / 22 通过（新 16 + 原 6） |
| `npm test -- docs/reports/REVIEW-consent-once.probe.mjs`（本次审查写的探针，见下） | 0 | 6 / 6 通过 |
| `npm test -- server/test/agent-access-conversation.test.mjs server/test/agent-access-http.test.mjs server/test/account-assembly-central.test.mjs` | 0 | 9 / 9 通过（服务端告知、撤权、只读拒绝） |
| `git diff 141e0be8..efdd19cb --stat` | 0 | 原 `consent.test.mjs` 不在改动列表里 |

没有重跑全量测试和类型检查：本次是安全审查、没改功能代码；实施者报告里记了 `tsc` 零错误、全量 7427 通过 0 失败，合入前主会话按 `multi_agent.md` 自己重跑基线。

### 探针 `docs/reports/REVIEW-consent-once.probe.mjs`

一次性的审查探针，文件名故意不带 `.test`，`npm test` 缺省的 glob 和 `node --test` 的缺省发现规则都收不到它，不进基线。每条断言的是**审查时观察到的现状**：

| 编号 | 说明了什么 |
|---|---|
| P1 | 同一张许可同时用两次，只有一次免读，另一次退回真读 |
| P2 | 许可发出后服务端撤掉告知、页面不知道：5 秒内页面放行，只能靠服务端拦 |
| P3 | 许可发出后凭证在服务端被吊销、页面不知道：同上；不带许可时真读拿到 `credential-revoked` |
| P4 | 问题 A：服务端说已同意，`grant` 仍回 `null` |
| P5 | 两条发送同时开头读取，先发的被取代回 `null`——**改前已有**，不是本次引入 |
| P6 | 绑定先抛错时许可没被标为用过，但之后永远核不过 |

合入时这个探针文件可以删掉，也可以随报告一起归档。
