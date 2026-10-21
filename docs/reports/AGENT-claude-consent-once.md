# AGENT 报告：claude/consent-once

任务：云端 Agent 发一条消息只核一次「首次使用告知」，省掉重复的那一次对账号服务的往返，不放松告知这道关。
出处：`docs/archive/agent-reports/AGENT-agent-panel-smooth.md`「没改、交回主会话的」第 2 条。
分支 `claude/consent-once`，从 main `141e0be8` 切。

## 语义核对

- `product/agent.md` 第 21、65 行与 `workflow/production.md` 第 11 行只规定：第一次使用时弹告知、「我知道了」才能用、按账号记住、「拒绝」就不发这条消息且下次再弹。语义里没有「每次发送核两次」，也没写核几次；「每次数据操作都向服务端新读一次」是 `consent.ts` 里的代码注释，不是语义。
- `mechanism/agent.md` 没有告知相关条目。
- 结论：本改动不改语义，也不需要停下来等答复。用户看不出区别（三级）。

## 做了什么（逐文件）

- `src/ai/cloud/consent.ts`
  - 新增 `grantCloudConsent(expected)`：向账号服务新读一次告知（内部仍走原来的 `refreshCloudConsent`，原有的防旧结果、防换绑逻辑都在）；读到「已同意」时回一张**一次性许可**，未同意回 `null`，出错照旧抛出。
  - 许可是一个冻结的对象，真正的内容记在模块私有的 `WeakMap` 里：发它时的账号来源对象、绑定代（`generation`）、告知请求序号（`requestSeq`）、发出时间、是否用过。外面伪造的对象在表里查不到，一律当没有。
  - `requireCloudConsent(expected, permit?)` 多了可选的第二个参数。带了许可时先照原规则同步核绑定（`assertBinding`）和登录（`boundSource`），对不上照旧抛 `credential-revoked` / `login-required`；再同步核许可（`spendPermit`），全部满足才不再读：
    1. 许可是 `grantCloudConsent` 发的、没用过（核一次就作废，不论成败）；
    2. 许可的绑定、调用方的绑定、当前状态的绑定三者一致（账号号 + 绑定版本）；
    3. 账号来源对象没换、绑定代没变（换号、换项目、退出、凭证被换都会让它变）、客户端当前账号仍是这个账号；
    4. 发许可以后没有任何别的告知读取或确认插进来（`requestSeq` 没动），当前状态是「已同意」且没有读取在路上；
    5. 发出不超过 `CLOUD_CONSENT_PERMIT_TTL_MS`（5 秒）。
    任何一条不满足，退回原来的做法：向服务端新读一次。所以最坏情况和改前一样，不会更松。
  - `CLOUD_CONSENT_PERMIT_TTL_MS = 5_000` 与只给单测用的 `setCloudConsentClockForTest`。
- `src/ai/cloud/useCloud.ts`：`CloudChat.send` 多一个可选参数 `consentPermit`，原样交给 `requireCloudConsent`。不带许可的调用（附件 `attach`、切权限、删除对话）不变，照旧每次新读。
- `src/editor/right/CloudAiPanel.tsx`：`consentForUse` 改用 `grantCloudConsent`，放行时回 `{ permit }`（本地档回 `{ permit: null }`），不放行回 `null`；四条发送路径（账号模式的乐观发送、普通发送、本地排队的队首、插队发送）把许可经 `sendNow` 交给 `chat.send`。附件上传与重试只用它的真假，行为不变。
- `src/ai/cloud/consent-once.test.mjs`（新）：17 个用例，见下。

## 安全论证

### 核查次数

| 路径 | 改前 | 改后 |
|---|---|---|
| 账号模式点发送（无附件或附件放素材库在 5 秒内） | 2 次 GET（`consentForUse`→`refreshCloudConsent`；`chat.send`→`requireCloudConsent`） | 1 次 GET（`consentForUse`→`grantCloudConsent`）+ 发出前 1 次同步核许可 |
| 账号模式点发送，放素材库超过 5 秒 | 2 次 | 2 次（许可过期，`chat.send` 照旧新读） |
| 发许可后有任何告知读取/确认插进来、换号、换项目、退出、凭证被换 | 2 次 | 第 2 步同步拒绝或退回新读，见下 |
| 服务端收消息（文档服务 `conversation-authority.mjs` 的 `send`） | 每条都核登录主体和告知（`checkConsent`，未同意回 403 `consent-required`） | 不变 |
| 附件上传、切权限、删除对话 | 各自每次新读 | 不变 |

### 被省掉的那一次为什么安全

- 谁在它之前已经核过：同一次发送开头的 `grantCloudConsent` 刚向账号服务新读过，并且是带同一个绑定（账号号 + 绑定版本）读的；读回来时原来那套检查（来源没换、代没变、不是被后来的读取取代的旧结果）都已经过了。
- 中间的窗口：从开头那次读取返回到 POST 之间，页面里能让告知结论失效的事件只有四类，每一类都会让许可当场作废：
  - 账号状态变化（退出、凭证被换、换号）：账号客户端 `authChanged` → `consent.ts` 的订阅把绑定代加一、清空「已同意」→ 第 3 条和第 4 条都不满足；`assertBinding` 先抛 `credential-revoked`。
  - 换项目或重新绑定：`setCloudConsentSource` 换来源、绑定代加一 → 同上。
  - 别处又读了一次告知（读到「不同意」或还在路上）、或刚确认过：`requestSeq` 变了 → 许可作废，退回新读，按新读的结果办。
  - 时间：超过 5 秒（例如放素材库很久）→ 退回新读。
- 改前同样有窗口：第二次 GET 返回到 POST 之间。改后的窗口多了「开头读取 → 第二次核对」那一段，这一段被上面四条盖住，又被 5 秒封顶；页面本身没有「撤回同意」的入口（语义里同意按账号记住），能在这段时间里从别处把同意撤掉的，只有服务端改告知版本这类运维动作。
- 最后的关在服务端：文档服务收每条消息时都核登录主体（凭证号、登录代）和告知（`noticeVersion === 1` 且 `accepted`），不靠页面的结论。页面这两次核查本来就只是让用户早点看到告知框、不白等，删掉其中重复的一次不影响服务端那道关。
- 许可不能重放、不能伪造：一次性（核一次就作废）；只认模块私有 `WeakMap` 里的记录，外面造一个同形对象不算；许可绑死发它时的绑定，拿去配别的绑定时作废并退回新读（读的是新绑定自己的告知）。

### 三种情况下的行为

- **撤权**（凭证被换掉 / 吊销）：页面能察觉的（账号客户端身份变了）→ 许可作废，`requireCloudConsent` 抛 `credential-revoked`，不发，也不再读服务端（单测「撤权：许可发出后凭证被换掉」，读取计数停在 1）。页面没察觉、只在服务端失效的 → 许可有效时由服务端收消息时的主体核验拒绝（401）；许可已作废时页面新读拿到 401 被拒（单测「撤权：凭证在服务端失效」）。
- **换绑**（换账号 / 同一账号换项目或重新绑定）：抛 `credential-revoked`；旧许可配新绑定也只会退回新读，读的是新账号自己的告知（单测两条「换绑」，旧账号读取计数停在 1）。
- **退出登录**：抛 `credential-revoked`（页面状态里已没有账号，任何绑定都对不上）；不带绑定直接问是 `login-required`；从未登录发不出许可，读取次数为 0（单测「未登录」）。

原有 `consent.test.mjs` 的 6 个用例（含 `credential-revoked`、`login-required`、被取代的旧读取不能借用 `accepted=true`）一条未改，全部通过。

## 验证

（见下一节，跑完后填）

## 没做成的及原因

- 没在真实页面里跑探针（`scripts/probes/cloud-agent-consent-user-path-probe.mjs` 要真账号服务和网站登录）。请求计数用单测在账号客户端的 `native` 桥上数（每次 `request` 到 `/api/account/cloud-agent-consent` 记一次），接线由单测读源码核对四条发送路径都把许可交下去了。
- 附件上传（`handleFileChange` → `chat.attach`）同样是「面板核一次、`attach` 再核一次」，本次没动：一次选多个文件共用一次面板核查，一次性许可只能给第一个文件省，收益小、写法别扭，留给主会话决定要不要做。

## 对任务书或语义的更正建议

- 任务书说「`useCloud.ts` 第 455、501、536、608 行调 `requireCloudConsent`」，核对无误；其中只有 455（发送）属于「一次发送」，501 是附件、536 切权限、608 删除对话，都是各自独立的一次操作，每次一读，不算重复。
- `consent.ts` 原注释「A fresh server read is required at every data operation」是代码里的约定，不在语义里；本次在它下面写明了唯一的例外。若主会话希望把「一次发送只核一次告知、许可 5 秒」写进 `mechanism/agent.md`，建议加一条（修改前：无；修改后：「页面发一条消息只向账号服务读一次告知：开头读到已同意时发一次性许可，发出前同步核对，账号、绑定、登录、告知状态有变或过了 5 秒就重读；服务端收消息时照旧核告知」），按规则需用户确认，我没写。
