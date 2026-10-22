# AGENT 报告：云端 Agent 消息断网排队（claude/offline-agent-queue）

- 分支：`claude/offline-agent-queue`（从 main `f00424ef` 切）；worktree：`.worktrees/offline-agent-queue`；端口段 5900～5909（只用了 5900）。
- 任务：`docs/semantics/workflow/production.md`「云端对话」里断网时发消息那一条（2026-10-22 用户定）。只管云端对话（账号模式）；桌面版本机 Agent 不变。
- 名词：「待发清单」= 断网时发的、排着等网络恢复的消息；「核对」= 发出之前向服务端现问这个对话里最近一条用户消息，和排队时页面看到的那条比；〔裁〕= 会话按解法表自行定的三级（用户看不出区别）做法，合入前由用户审，可推翻。

## 做了什么（逐文件）

| 文件 | 改动 |
|---|---|
| `src/ai/cloud/outbox.ts`（新） | 待发清单 `createOutbox`（按账号、项目、页签存浏览器本地存储；同一对话按排队先后）、核对判定 `outboxVerdict`（send / delivered / conflict）、排一条时「看到的最近一条」`baselineFor`、试发调度 `createOutboxRunner`（一次只跑一遍、同一对话里前一条没发出去后面的不越过、没发出去按退避再试）、断网一类错误的判定 `isOfflineError` / `isTransientError`、用户看得到的几句话 `OUTBOX_TEXT`。没有 React，Node 单测直接测。 |
| `src/ai/cloud/session.ts` | ① 记住页面最近看到的那条用户消息（账号模式断流时正文会清空、重放，清空前记下，重放没放到它之前仍以它为准）→ `seenBaseline()`；② `showOutbox(items)` 把待发清单画成本地气泡（排着 / 正在发 / 发送失败带 `resendable`），已被云端收下的不动；③ 发送失败的待发气泡不会被下一次点发送撤掉；④ `send(..., { quiet })`：待发那条发不出去时不在这里标失败；⑤ 本地气泡始终排在重放回来的记录后面（`stagedLast`，否则断流重放后排着的气泡跑到对话最上面，探针第一轮截图里看到过）。 |
| `src/ai/cloud/cloudApi.ts` | 新增 `conversationMessages(id)`：`GET /agent/v1/conversations/<id>` 取 `meta.messages` 的消息号、请求号、到达序号（服务端已有的接口，`server/agent-service/http.mjs:320`，账号模式回文档服务的记录）；服务端还没有这个对话（404 `no-conversation`）回空清单。把「和文档服务的连接断着」那句提成常量 `DOC_LINK_DOWN_TEXT`（话不变），供认出「断网」。 |
| `src/ai/cloud/useCloud.ts` | `useCloudChat({ outbox: true, prepareFiles })` 开断网待发：点发送时就定请求号、记下「看到的最近一条」和运行选项；`send(..., { queueOnNetwork })`：浏览器断网、读告知断网、选区没连上且事件流也断着、发送时断网（`network` / 文档服务连接断着）→ 转成排着，不报错；试发 `attempt`：告知 → 选区 → **现问服务端** → 核对 → 发送（同一个请求号）；`online` 事件、页面回到前台、事件流重新连上、刚排了一条时马上试；其余按退避。对外多了 `chat.outbox`（`offline` / `mustQueue` / `enqueue` / `resend` / `transient` / `items`）。不开 `outbox` 时（手机页）行为不变。 |
| `src/editor/right/CloudAiPanel.tsx` | 开 `outbox`；点发送时浏览器断网、或这个对话里已有排着的（新发的排在后面，顺序不乱）→ 直接排；读告知断网 → 排（不弹告知框）；发送时 `queueOnNetwork`；接「重新发送」事件；有消息后读对话列表那一次在断网时静默（不弹「连不上云端 Agent 服务」）。 |
| `src/ai/cloud/consent-once.test.mjs` | 守门测试里两条源码正则随 `chat.send` / `sendNow` 多一个选项参数更新，意图不变（许可照旧原样交过去）。 |
| `src/ai/cloud/outbox.test.mjs`（新） | 18 个用例，见下。 |
| `src/ai/cloud/offline-queue-probe-harness.tsx`（新）、`scripts/probes/cloud-offline-queue-probe.mjs`（新） | 浏览器探针：挂真的 `CloudAiPanel`，告知、身份、选区换成本页假来源，Agent 服务由探针模拟，断网用浏览器离线模式（应用层，不碰宿主机网络）。 |

清单外改动的文件（任务书说可改、要说明）：

- `src/ai/types.ts`：`ChatMessage.sendState` 加 `"queued"`，加 `resendable`。气泡状态的类型就定义在这里。
- `src/editor/right/chat/UserBubble.tsx`：排着的气泡下面写「等网络恢复后发出」（`data-pc="cloud-send-state" data-state="queued"`）；发送失败且 `resendable` 的带「重新发送」按钮（`data-pc="cloud-resend"`），点了发窗口事件 `pc-cloud-resend`（MessageRow 是 memo 的，不多传会变的函数）。气泡就画在这里，没有别的地方能加。
- `src/editor/right/chat/chat.css`：「重新发送」按钮的样式（`.ai-message-resend`）。

第二轮（主会话 2026-10-22 授权改 `src/mobile/AgentChat.tsx`，先合了 main `44d1a234`，无冲突，没碰 `src/mobile/sheets.tsx`）——手机版接上：

- `src/mobile/AgentChat.tsx`：开 `outbox`；点发送时断网或对话里已有排着的 → 直接排；读告知断网 → 排（不弹告知框）；发送时 `queueOnNetwork`；接「重新发送」事件；有消息后读对话列表那次在断网时静默。
- `src/mobile/agentParts.tsx`（同目录，手机气泡画在这里）：排着的气泡写「等网络恢复后发出」（`data-pcm="send-queued"`），发送失败且可重发的带「重新发送」（`data-pcm="resend"`）。
- `src/mobile/mobile.css`：「重新发送」按钮样式。
- 「重新发送」的窗口事件名挪到 `outbox.ts` 的 `OUTBOX_RESEND_EVENT`，桌面 `UserBubble.tsx` 的 `CLOUD_RESEND_EVENT` 改成引用它（值不变）。

没动：`src/editor/sync/**`、任何 `docs/semantics/**`、`docs/plan/**`。

## 四条各自的证据

单测：`node --test src/ai/cloud/outbox.test.mjs` → 18 过 0 失败；`node --test src/ai/cloud/*.test.mjs` → 182 过 0 失败。
探针：`node scripts/probes/cloud-offline-queue-probe.mjs --port 5900` → `ok: true`，19 项全过（含手机版 5 项），页面报错 0（结果 `out/offline-queue/result.json`）。

| 条 | 单测（`outbox.test.mjs`） | 探针（真面板） |
|---|---|---|
| 1 断网发消息不报错，气泡照常显示、下面写「等网络恢复后发出」 | 「断网发消息:不报错,气泡照常显示…」（气泡 `sendState: "queued"`、无 `error`；发送失败的待发气泡不被下一次发送撤掉） | `1-queued-bubble-text`（两条气泡都写「等网络恢复后发出」）、`1-no-error-shown`、`1-server-received-nothing`、`1-stored-in-order-with-baseline`；截图 `out/offline-queue/01-queued.png` |
| 2 网络恢复后自动发出 | 「恢复后自动发出:断网时试不出去、按退避等着;网络回来(kick)不用再点就发出」 | `2-auto-sent-in-order`、`2-outbox-empty`；截图 `02-sent.png` |
| 3 最近一条用户消息变了就不发（正反） | 正：「最近一条没变 → 恢复后发出」；反：「离线期间别人发过 → 不发,标「发送失败」」（同用例两段）；另有核对的边界：按到达序号认最近一条、新对话、这一页更早排的那条已发 / 没发、丢了回包其实已到（`delivered`，不当成别人发过）、断流清空后仍记得看到的最近一条 | 正：第 2 条；反：`3-failed-with-resend`、`3-not-sent`（服务端一条没收到）；截图 `03-failed.png` |
| 4 「发送失败」带「重新发送」，点了按当前状态重走 | 「重新发送:核对以点的这一刻看到的为准(这时最近一条已是别人那条)→ 发出;挪到清单末尾」（之后又有人发 → 照样不发） | `4-resent-after-other`（第三条排在「另一台设备发的」之后到达服务端）；截图 `04-resent.png` |
| 多条排队的顺序 | 「同一个对话里排了多条:按排队顺序发出」「前一条还连不上,后面的不越过它;别的对话不受影响」 | `2-auto-sent-in-order`（第一条、第二条按序到达） |
| 跨刷新 | 「排着的消息跨页面刷新还在…」 | `5-held-while-service-unavailable`、`5-restored-after-reload`、`5-sent-once`；截图 `05-after-reload.png` |
| 手机版（真的 `AgentChat`，375×812 触屏） | 同一套逻辑（`useCloudChat`） | `6-mobile-queued`、`6-mobile-server-received-nothing`、`6-mobile-failed-with-resend`（期间「电脑上发的」，两条都标发送失败带重新发送）、`6-mobile-not-sent`、`6-mobile-resend-only-that-one`（点第一条的重新发送只发出第一条）；截图 `mobile-01-queued.png`、`mobile-02-failed.png`、`mobile-03-resent.png` |

看过的图（都看过）：

- `out/offline-queue/01-queued.png`：断网时发的两条，气泡略淡，下面一行「等网络恢复后发出」；顶上是已有的断线提示。
- `out/offline-queue/03-failed.png`：第三条排在「另一台设备发的」之后，红边，写「发送失败：断网期间这个对话里有了新消息，这条没有发出。」，下面「重新发送」按钮。
- `out/offline-queue/04-resent.png`：点了重新发送，第三条变成正常的已发消息。
- `out/offline-queue/05-after-reload.png`：刷新后排着的那条还在，仍写「等网络恢复后发出」。
- `out/offline-queue/mobile-01-queued.png`：手机版，断网时发的两条，气泡下写「等网络恢复后发出」。
- `out/offline-queue/mobile-02-failed.png`：手机版，两条都标红字「发送失败：断网期间这个对话里有了新消息，这条没有发出。」，各带「重新发送」小按钮，排在「电脑上发的」之后。

## 三级的数字与〔裁〕

| # | 项 | 定的 | 理由 |
|---|---|---|---|
| 裁1 | 排着的消息要不要跨页面刷新存活 | **要**：存浏览器本地存储，键 `pc.cloudOutbox:<账号>:<项目>:<页签>`；刷新前「正在发」的那条按「排着」恢复（发之前现问服务端，已经到了就不会多一条）。和冲突合并那套项目改动的离线存储各存各的，不共用键（那边是 `pc.shared` 等）。 | 语义承诺「网络恢复后自动发出」；断网时用户常会刷新页面，刷新就悄悄丢掉排着的消息，比假装还在更糟（用户以为发了）。重复发送的风险由请求号去重和「发之前现问服务端」兜住。 |
| 裁2 | 网络恢复的判据 | 不单独判「恢复了没有」，而是在这几个时机直接试一次：浏览器 `online` 事件、页面回到前台、云端事件流重新连上（`connection` 变成 `live`）、刚排了一条；浏览器说断网（`navigator.onLine === false`）时不试。试的结果说了算：告知、核对、发送任一步遇到断网一类错误（`network`、文档服务连接断着、5xx、429/`busy`）就算还没恢复。 | `navigator.onLine` 只在「确定断了」时可靠；路由器后面断了它仍是 true，所以以真试为准。 |
| 裁3 | 重试间隔 | 第 n 次没发出去后等 `min(30 秒, 2 秒 × 2^(n-1))`：2、4、8、16、30、30…秒；上面几个时机来了就提前试并把退避清零。 | 断网通常几秒到几分钟；30 秒封顶，恢复后最多晚 30 秒（有 online / 重连事件时是立刻）。 |
| 裁4 | 清单上限 | 每个账号、项目、页签最多 100 条，多了丢最早的。 | 防本地存储被意外写爆；正常用不到。 |
| 裁5 | 点发送时什么算「断网」 | 浏览器断网；读告知时断网；选区没连上且（浏览器断网或事件流也断着）；发送时 `network` 或「和文档服务的连接断着」。服务端 5xx 这类在点发送时**不**转排着，照旧当场标「没有发出去」（只在已经排着的那条重试时当成暂时故障）。 | 语义说的是断网；5xx 不是断网，改成排着属于另一种用户看得到的变化，不在这次范围。 |
| 裁6 | 「看到的最近一条」怎么定 | 同一个对话里，这一页更早排着（没失败）的那条优先（记它的请求号；它发出后服务端记录上是同一个请求号），否则页面上最近一条已发出的用户消息（记文档服务的消息号）。正在发、还没结果的本地气泡也算（记请求号）。 | 用户发第二条时看着的是第一条的气泡；第一条没发出去（不发了），第二条看到的东西就不对了，也不该发。 |
| 裁7 | 核对时「已经到了」 | 服务端清单里已有这条的请求号 → 当成已经到了，用同一个请求号再发一次拿回原结果（文档服务按请求号去重，不会多一条），不当成「别人发过」。 | 丢了回包的那次其实到了，不该标发送失败。 |
| 裁8 | 已经排着的对话里新发的 | 只要这个对话里还有排着的（没失败的），新点发送的也排进去，跟在后面发。 | 语义要求顺序保住；在线时直接发会越过前面排着的。 |
| 裁9 | 正在试发时气泡写什么 | 头一次试写「发送中…」；试过一次没成以后一直写「等网络恢复后发出」。 | 断网时每次重试都在两句之间闪不好看，也不对。 |

## 要补进语义的内容（交给主会话写）

1. `docs/semantics/mechanism/agent.md`（或 `mechanism/` 里管云端对话的那一本）补一段「断网待发」的机制，内容取上表裁1～裁9（数字：退避 2 秒起翻倍封顶 30 秒、清单上限 100、键名 `pc.cloudOutbox:<账号>:<项目>:<页签>`、核对接口 `GET /agent/v1/conversations/<id>` 的 `meta.messages`）。
2. `mechanism/agent.md`「出错时的话对照表」：
   - 「云端：发消息被拒」一节的「网络」那一行（`连不上云端 Agent 服务,请检查网络。`）：桌面、在线页面和手机版的云端对话里，点发送时断网都**不再**出这句，改为排着。
   - 新增一小节（形状照「发消息被拒」那张表）：

     | 出错种类 | 怎么认出来 | 气泡里的话（原文） | 产生的代码位置 | 排查从哪看 |
     |---|---|---|---|---|
     | 断网时发的（排着） | 浏览器断网，或发送时 `network` / 和文档服务的连接断着 | 气泡下一行：等网络恢复后发出（不是出错，灰字） | `src/ai/cloud/outbox.ts:61`；画在 `src/editor/right/chat/UserBubble.tsx:99`、手机 `src/mobile/agentParts.tsx:46` | 浏览器本地存储 `pc.cloudOutbox:<账号>:<项目>:<页签>` |
     | 断网期间对话里有了新消息，不发 | 发出前现问服务端，最近一条用户消息和排队时看到的不一样 | 发送失败：断网期间这个对话里有了新消息，这条没有发出。（带「重新发送」） | `outbox.ts:63`（判定 `outboxVerdict`，:225）；试发 `src/ai/cloud/useCloud.ts:600` | 服务端对话记录的消息清单（`GET /agent/v1/conversations/<id>`） |
     | 排着的那条后来因别的原因没发出去 | 试发时回非断网一类的错（没权限、对话被删、满额、告知没确认等） | 发送失败：<cloudErrorText 的话>（带「重新发送」） | `outbox.ts:65`；`useCloud.ts:600` | 同「发消息被拒」那张表按 `code` 查 |

   - 行号（按本分支最终提交核过）：通则里「发消息被拒的话挂在用户自己那条气泡下面（`UserBubble.tsx:95`）」现在是 `src/editor/right/chat/UserBubble.tsx:100`（`data-pc="cloud-send-failed"`），「重新发送」按钮 `:102`（`data-pc="cloud-resend"`），「等网络恢复后发出」`:99`；手机版对应 `src/mobile/agentParts.tsx:47`（`data-pcm="send-failed"`）、`:49`（`data-pcm="resend"`）、`:46`（`data-pcm="send-queued"`）。「发消息被拒」一节说的「由 `session.ts:573` 拼成『没有发出去：<话>』」现在是 `src/ai/cloud/session.ts:642`；「网络」那一行的 `session.ts:572` 现在是 `:640`。
3. 一级文字（会话拟的；主会话 2026-10-22 定：在用户已定的框架内先用，记为「文案待用户过目」）：
   - 「发送失败：断网期间这个对话里有了新消息，这条没有发出。」
   - 「发送失败：<原因>」（排着的那条因别的原因没发出去）
   - 「等网络恢复后发出」「重新发送」是语义原文。

## 没做成的及原因

- 手机页：第一轮因文件边界没接，第二轮已接上（见上）。
- 以下两条主会话已同意按原有行为记待办、这一版不动：
- **断网时刷新、页面在断网状态下重新打开**：页面本身打不开（这不是本任务能管的）；刷新后联网但对话列表还没读回来之前，输入框照旧是「正在确认对话权限，确认前暂不能发送。」，排着的消息照样显示、照样会在恢复后发出。
- **断网时已有正文会被清空**：账号模式断流时会清掉对话正文、连上后重放（原有行为，`session.ts` 的 `clearAccountReadState`），所以断网期间对话区只剩本地气泡（截图 01 可见）。不在本任务范围，未改。
- 真实网络环境验收没跑：只改了页面这一侧，服务端接口没改，按 `verification.md` 本地验证即可。

## 门槛结果（在本分支最后一个代码提交 `2f49948a` 上跑）

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误 |
| 全量测试 | `npm test`（设好两个账号服务的环境变量） | 退出码 0；tests 7523、pass 7508、fail 0、skipped 15、cancelled 0；「npm test 最终结果：零失败」；没有文件级失败、没有触发重跑，所以没有需要单跑复核的失败（`T3-8` 这次也没失败） |
| 构建 | `npm run build` | 退出码 0 |
| 本任务探针 | `node scripts/probes/cloud-offline-queue-probe.mjs --port 5900` | `ok: true`，14 项全过，页面报错 0 |
| 渲染附加项 | — | 不适用：没改画面（渲染、舞台、卡片），只改云端对话的发送与气泡文字 |
| 真实网络环境验收 | — | 未跑：服务端接口与部署都没改，按 `verification.md` 本地验证即可 |
