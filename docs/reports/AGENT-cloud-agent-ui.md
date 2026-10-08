# 子 Agent 报告：云端 Agent 界面（丁块，分支 `claude/cloud-agent-ui`）

任务书：`docs/plan/cloud-agent-task.md`（四段连做的第四段）；契约：`docs/plan/cloud-agent-contract.md` 第 9.5、10 节。起点 `3935042a`（甲块完成），本轮提交 `11b12601`～`d201271d`（见文末）。不合入 main、不推送、不连任何远端、不动新节点。

## 做了什么

**在线浏览器宽屏**：右侧占位换成「云端」接入方式的 AI 栏（`src/editor/right/CloudAiPanel.tsx`）。发消息、流式回复、停止、工具调用过程、进度、「撤销这一步」（文档服务推来的 Agent 操作记录，原样复用）、对话重开、历史列表、创造力等级、模型选择（托管方配了多个模型才出现）、「引用到 AI」都可用。事件流断了自动重连并按 `seq` 补齐；重新打开页面自动接上还在跑的对话（`info.running`）；出错的原因写进对话。手机仿真（低内存档，现成的 `lowMemoryMode` 判定）仍是原来的占位，不请求 `/agent/`。

**桌面版**：只在项目放云端（连着托管端的共享项目）且托管端有云端 Agent（`hosted.agent.available`）时，接入方式里多一项「云端」；本机驱动仍是缺省、从不自动切，选择只记在这个页签、只放内存。选「云端」的页签由 `CloudAiPanel` 接管，页面**直连**云节点 Agent 服务（跨源），不经本机 Agent 进程。不选「云端」时，打开项目只多一次 `info` 加一次对话列表，之后不轮询。历史列表多一组「云端」；云端有这位成员在跑的对话时，AI 栏顶上出提示，点「接上看看」接上。开关被创建者关着（`hosted.agent.enabled` 为假）时「云端」一项在、置灰、写原因。选「云端」时：附件按钮、「深度自主」置灰并写原因；一键配特效、诊断报告、AI 设置不出现或置灰。

**页面一侧的结构**（`src/ai/cloud/`，纯逻辑部分 Node 里有单测，不引 React、不引 `mode.ts`）：

| 文件 | 管什么 |
|---|---|
| `cloudApi.ts` | 接口层：每个请求现取委托票据、不带 Cookie；发消息回 202；事件流用 `fetch` 读；错误码换成给用户看的话 |
| `events.ts` | 事件折成消息（纯函数，对重放幂等：每条助手消息记折到过的最大 `seq`，`ChatMessage.cloudSeq`） |
| `session.ts` | 一个云端对话的控制器：从 seq 0 读流、断了退避重连并带上已看到的 seq、停止、关闭只掐流不停服务端那一轮、服务端对话从头开始时掐旧流重读 |
| `endpoint.ts` | 云端在哪、能不能用：在线页面固定同源 `/agent/v1`；桌面版地址与开关来自成员列表回包的 `hosted.agent`；可注入来源 |
| `identity.ts` | 身份接口位：委托票据与对话委托（见下「接口位」） |
| `useCloud.ts`、`tabMode.ts` | React 接线：`useCloudAgent`、`useCloudChat`、`useCloudDigest`（桌面版一次 info + 列表）；桌面版页签选云端的内存状态 |

改到的既有文件都尽量小：`DockPages.tsx` +10 行（`OnlineAgentSwitch`，其余不动）、`AiPanel.tsx` +53 行（云端分支，全部在 `cloud.available` 时才生效）、`Composer.tsx`（可选的 `cloud` 属性，不给就与原来逐条相同）、`ChatHeader.tsx`、`ChatHistoryDrawer.tsx`（可选的 `cloud` 组）、`ToolVisual.tsx`（在线构建剪掉 `/api/ai/visual`）、`syncManager.ts` +5 行（收 `hosted.agent` 与 `hosted-service-changed`）、`ai/types.ts`（`cloudSeq` 字段）。`vite.config.ts` 没动。

## 验证结果

| 项 | 结果 |
|---|---|
| `npx tsc -b --force` | 退出码 0 |
| `npm test` | 4465 项、4464 通过、0 失败、0 取消、1 跳过（起点 4449 / 4448 / 1，新增 16 项） |
| `npm run build` | 成功 |
| `npx vite build --mode online` | 成功；产物里 `/api/` 路径与棘轮清单逐条一致（没新增、没少，清单文件一字没改） |
| 新增单测 `src/ai/cloud/cloud-chat.test.mjs` | 12 项全过：CAU-EV-01、EV-01b、EV-02、SES-01、SES-01b、SES-02、SES-03、SES-04、SES-05、EP-01、API-01、ID-01（编号含义见文件头） |
| 新增守门 `server/test/c10a-online-build.test.mjs` | C10A-API-05、07、08 三项全过（同文件原有 8 项照旧过） |
| 界面探针 `scripts/probes/cloud-agent-ui-probe.mjs`（一次跑完，在线 + 桌面） | `{"summary":{"total":52,"failed":0}}` |
| `chat-window-probe`（`--port 5796`） | 退出码 0，19 项、0 失败 |
| `creativity-probe`（自起的 dev server，5796） | 退出码 0，通过 15 项 |
| `user-editing-probe`（同上） | 退出码 0，通过 18 项 |

探针逐条（全部通过，原文在探针输出里；验收标准写在探针文件头）：

- 在线宽屏 O0～O6：右侧是云端 AI 栏不是占位、下拉里只有「云端」且选中、进入项目时问了同源 `/agent/v1/info`；发消息后收尾之前就有「停止」按钮与工具调用（流式），四次工具调用（读项目 + 改文案、挪片段、调卡片参数各一次）都成功，文档服务里项目真被改了三处、页面编辑区也看到；停止 78 ms 内停下、`outcome=aborted`、服务端 `running` 为空；代理掐断事件流后自动重连，重连请求 `after>0`，连接状态经过 `reconnecting` 回到 `live`，最终工具调用数与脚本一致（不重不漏）；关掉页面、另开浏览器上下文（无本地存储）进同一项目自动接上还在跑的对话、补齐关页面之前的过程、等它结束后每轮一条用户消息无重复；历史列表「云端」一组里有对话；模型失败时对话里有原因；服务端撤销时对话里写「已失效」、之后还能再发；整个在线过程没有同源 `/api/*` 请求发出（守卫拦下的只有棘轮清单里原有的几条，没有 `/api/ai`、`/api/chats`、`/api/mcp`）；手机仿真仍是占位、没有发往 `/agent/` 的请求。
- 桌面 D1～D6：放本机的项目没有「云端」、没有任何发往 Agent 服务的请求；放云端后多了「云端」、本机驱动仍是缺省；身份没就绪时一个请求不发，就绪后恰好一次 info 加一次列表；开关被关时置灰并写「项目创建者已关闭云端 Agent。」；选「云端」后附件、深度自主置灰并写原因；发长任务确认被接下后，桌面标签页离开编辑器，对话在云端照跑完（服务端状态 idle），三处改动落地；同一标签页重新打开回到同一项目，AI 栏仍是本机驱动，只多一次 info 加一次列表；历史列表「云端」一组里找得到那个对话，点开找回完整过程（用户消息、四个工具调用、最后回复）；云端对话还在跑时重开，出现「云端有一个对话正在进行」提示，点「接上看看」接上，跑完过程完整、改动落地。

截图（`C:\Users\admin\Documents\PromptCut\work\four-stage\cloud-agent\ui\`，我都看过）：`O0-online-ai-panel.png`、`O1-online-streaming.png`、`O1-online-done.png`、`O2-online-stopped.png`、`O4-online-reopened-running.png`、`O4-online-history.png`、`O5-online-model-error.png`、`O5-online-revoked.png`、`O6-mobile-placeholder.png`、`D3-desktop-cloud-selected.png`、`D4-desktop-streaming.png`、`D5-desktop-history-cloud-group.png`、`D5-desktop-cloud-recovered.png`、`D6-desktop-running-banner.png`、`D6-desktop-attached.png`。

跑法与环境：探针起本机隔离的托管组合（8776、8777）、Agent 服务托管档（8778，模拟模型提供方的脚本模式，**鉴权与凭证是测试替身**）、在线构建加仿 nginx 代理（5790～5792，含 `/agent/` 转发与可掐断的事件流）、桌面 dev server（5793～5795，照壳的环境起，数据在临时目录）。跑完所有端口已释放、临时目录已删。没碰 5190～5192、5210～5212、用户的安装版与数据目录。

## 守卫与棘轮清单改了什么

- `src/online/apiGuard.ts`、棘轮清单 `c10a-online-api-paths.json`、基线 `c10-api-ratchet-baseline.json`：**一字没改**。AiPanel 的桌面调用靠就地常量整体摇掉；唯一冒出来的新路径是 `ToolVisual.tsx` 里的 `/api/ai/visual/`（云端 AI 栏经 MessageList 把它带进了在线产物），在 `loadVisualRecord` 开头加就地的 `ONLINE_BUILD` 剪掉（云端第一版不开放看画面的工具，在线页面不会有 visualId）。
- 新增守门（`c10a-online-build.test.mjs`）：C10A-API-05 在线产物里 `/agent/` 开头的地址字面量只有 `/agent/v1` 一种；C10A-API-07 在线产物里没有 `/api/mcp/events`、`/api/ai/setup`、`/api/chats/`、`PROMPTCUT_AGENT`；C10A-API-08 桌面产物里带云端 AI 栏、且没有写死的云节点 `/agent/v1` 地址（地址由文档服务下发）。契约 10.3 写的 C10A-API-06 已作废，所以我用 08。
- 契约同步：`c10a-contract.md` 第 2 节「在线模式的替代」加了 Agent 服务一行；`c10-contract.md` 第 10 节置灰清单里「AI 栏」改成「普通档云端可用、低内存档仍置灰、云端下仍置灰的子入口」。
- 运行期：在线探针 O0 断言整个过程中守卫拦下的路径 ⊆ 棘轮清单、没有 `/api/ai|chats|mcp|agent`。

## 任务书没列的用户可见行为（逐条）

1. 云端 AI 栏顶栏：连接状态点的悬停说明是「已连接云端 / 正在连接云端… / 连接中断，重新连接中… / 未连接云端」；「AI 设置」齿轮置灰，悬停「云端 Agent 的模型由托管方配置，这里没有 AI 设置可改」。
2. 事件流断了时 AI 栏顶上出一条提示：「和云端 Agent 的连接断了，正在重新连接。云端的这一轮仍在继续，连上后会把错过的过程补齐。」
3. 输入区上方常驻一行小字「在云端运行，关闭后继续；重新打开可接着看」（契约 9.5 已定）。
4. 创建者关了开关时（成员列表回包或 `info` 报）：AI 栏顶上「项目创建者已关闭云端 Agent。」，并且不能发消息。
5. 云端下 Agent 正在跑时继续输入，Enter 是「加入队列」，这一轮结束后自动发下一条（沿用本机 AI 栏的输入队列与「插入」「编辑」「继续」）。
6. 云端下「✦」菜单只剩「新对话」（一键配特效、诊断报告不出现）。
7. 云端下运行选项里：创造力可选，「深度自主」置灰，悬停「云端 Agent 暂不支持深度自主与审查环路：云端用的是托管方的模型额度，目前没有上限」。（桌面界面上本来没有「审查环路」的控件，只有深度自主，所以只置灰这一项。）
8. 云端下附件按钮置灰，悬停「云端 Agent 暂不支持附文件：请先把素材导入项目的素材库，再让它按素材库里的素材来做」。
9. 历史列表：多一组「云端」；每项标题是服务端给的标题或页面本地记的第一句话（取前 40 字），状态文字「进行中 / 已中断 / 出错 / 已失效」；空时写「这个项目里还没有云端对话」；在线页面只有这一组。云端对话没有「删除」按钮（服务端还没有删除接口）。
10. 桌面版本机模式下，云端有在跑的对话时 AI 栏顶上提示「云端有一个对话正在进行」加按钮「接上看看」（契约写的是页签上的标记，我放成了面板顶上的提示条）。
11. 桌面版没有任何本机驱动可用的空状态里，项目放云端时多一个按钮「改用云端 Agent」。
12. 驱动下拉里「云端」一项的悬停说明：「消息发到云端，在云节点上执行；关掉软件也会继续」。
13. 补渲进展（契约 16 节的 `render` 事件）显示为一行状态：已把 N 个片段交给云端渲染 / 云端渲染中：x/y / 云端渲染完成 / 云端渲染失败：原因 / 云端渲染暂不可用，画面会在渲染节点恢复后补上。（契约没给原文，这是我写的。）
14. 各类出错的对话内文案（服务端 `error.message` 优先，没给才用页面的）：被撤销「云端 Agent 的这段对话已失效（开关被关、你被移出项目或项目已删除）。已经落地的改动保留在项目里。」、中断「云端 Agent 服务中断，这一轮没有做完。……」、到上限、模型失败、额度用尽；发送失败的提示（身份验证没过、忙、额度、没配模型、消息太长等）见 `cloudApi.ts` 的 `cloudErrorText`。
15. 服务端把对话丢了（实例被回收、服务重启又没落盘）、又读到「没有这个对话」时，没收尾的那一轮标成「服务中断」，不让界面一直转圈。
16. 云端空对话里仍显示本机 AI 栏那三条示例句（其中「根据我刚导入的视频做字幕」在云端做不了），没有为云端另写。

## 接口位与需要其它块配合（合流时怎么接）

**身份（`claude/cloud-agent-auth`）**：`src/ai/cloud/identity.ts` 的 `setCloudIdentity({ getTicket(), getGrant?(conversationId) })`。`getTicket` 每个请求现取一张委托票据（放 `Authorization: Bearer`），`getGrant` 在发消息时取这个对话的对话委托（放请求体 `grant`）。身份晚于「云端可用」就绪时调用它，界面自动重取一次 info 与列表（`subscribeCloudIdentity`）。没注入时读 `globalThis.__pcCloudIdentity`（探针的替身口子，同形状）；两处都没有就不发任何请求并显示「云端 Agent 暂时用不了：还没有取得身份证明。」。**合流时要决定是否保留这个全局口子**：它只在页面自己的脚本里可设，不给别人多任何权限，但生产构建里多一个后门口子，建议接真身份后删掉 `identity.ts` 里 `current()` 的全局回退。
**托管端下发（乙块与第三段）**：成员列表回包顶层 `hosted.agent: { available, enabled, url }`（`syncManager.ts` 的 `shared.members.list` 分支已接，回包没有 `hosted` 就清掉）；开关变化通知 `shared.notice { event: 'hosted-service-changed', service: 'agent', enabled }`（已接）。桌面版地址就取 `url`，在线页面固定 `${origin}/agent/v1`。合流前的可注入来源：`setCloudAgentSource(fn)` 或 `globalThis.__pcCloudAgent = { available, enabled, url }`，只在文档服务没报、且连着托管端的共享项目时才算数；合流后可删。
**项目设置里的「云端 Agent」开关（第三段 `claude/render-service-ops` 合流后加）**：按任务书先不做界面。合流后在「按服务名渲染一行」的组件里多一行，服务名 `agent`：标题「云端 Agent」；只有创建者能改；开关状态读 `hosted.agent.enabled`；点击发 `shared.admin { op: 'set-hosted-service', service: 'agent', enabled, proof }`（proof 同其它创建者操作）；通知 `shared.notice { event: 'hosted-service-changed', service: 'agent', enabled }` 到了就刷新这一行（页面一侧 `endpoint.ts` 的 `setHostedAgentEnabled` 已经在收，AI 栏「云端」一项的置灰也随它变）。「开关被关时 AI 栏里云端不可选并说明原因」这一条已做（读 `hosted.agent.enabled`）。
**需要丙块配合（HTTP 接口只追加字段，页面一侧已做适配）**：
1. `GET /v1/conversations` 的 items 现在只有 `{ id, state, reason, lastSeq }`，契约 2.3 要的 `title`、`updatedAt`、`startedOn` 还没有：页面用本地记的第一句话当标题、`updatedAt` 缺省 0（不显示时间）。服务端补上后页面自动用。
2. 事件与对话状态落盘、seq 跨轮连续、进程重启后补 `interrupted`：页面按「同一个对话 seq 单调不减」写；服务端对话从头开始（现在的内存版撤销或重启后会这样）时页面靠「发送回的 seq 小于发送之前看到的」判出来、掐旧流重读，否则旧流挂在已不存在的对话上永远收不到。落盘后不会走到这条。
3. `end` 事件建议带 `reason`（`stopped` 等）：页面现在靠先前一条 `status: '已停止'` 判「主人停掉」，已兼容 `end.reason === 'stopped'`。
4. `render` 事件字段按契约 2.4：`{ state, clips, done?, total?, reason? }`，`clips` 数组或数字都认。
5. `GET /v1/info` 的 `models` 认字符串或 `{ id, label }`；`enabled:false` 时页面显示关了开关；`running` 用于自动接上。
6. `PATCH`、`DELETE /v1/conversations/<id>`、`GET /v1/usage` 还没有，页面没做对应入口。
7. `tool_result` 的 `callId` 要与 `tool_call` 对得上（页面按 callId 配对，没有 callId 才按工具名配）。

## 没做成的及原因

- 项目设置里的「云端 Agent」开关界面：按指示留到第三段的组件合流后，接法见上。
- 真实的委托票据与对话委托：接口位已留，本机验证用测试替身（探针里 `Bearer test:<项目>:<成员>`），真身份由 `claude/cloud-agent-auth` 合流后接。
- 桌面版「页签上」的「云端对话进行中」小标记：做成了面板顶上的提示条（见上第 10 条），没有往 rail 页签图标上加标记。
- 用户体验验收里的「撤销能撤掉 Agent 的改动」：界面一侧（AI 栏里的 Agent 操作记录加「撤销这步」按钮）就是本机 Agent 同一套，截图 `O1-online-done.png` 能看到；对着云端 Agent 写入的逆操作取回（契约 7.4 要探针验的那一条）这一轮没单独验，属于乙块与文档服务事件模块，建议集成阶段补。
- 在线探针只用了一个成员；「另一位成员从在线浏览器进项目、看署名」属于署名与身份（乙块），这一块没做。

## 对任务书或契约的更正建议

1. 契约 10.3：C10A-API-06 作废，实际守门是 05、07、08；CA-DESK-02（不选「云端」时只多一次 info 加一次列表）我放在浏览器探针 D2、D5 里验，没写成单测。
2. 契约 9.5 第一条：低内存档判定用 `lowMemoryMode(true)`（运行中被改判也会换回占位），已按此实现。
3. 契约 9.3：桌面界面上并没有「审查环路」控件，只有「深度自主」；说明文案里两项一起提。
4. 契约 7.4 对桌面版写的是「页签上出标记」，实际做成面板内提示条；若要页签标记另提。
5. 契约 4.3 提到的 `bad-grant` 页面一侧只显示「这次对话的授权已失效，请重新发送」，重取对话委托靠重新发送一次（`getGrant` 每次发消息都现取）。
6. 对话 `seq` 需要「同一对话跨轮连续、重启后不回到 1」（契约 2.4 已写，这里再强调页面依赖它）。

## 过程中的两处注意

- Bash 工具里写含反斜杠的正则（`\/`、`\s`）会被吞掉一层，导致生成的探针与测试语法错误；之后含反斜杠的编辑一律用 Edit 工具。无副作用，已修。
- 探针桌面段两次碰到偶发：重新打开的桌面页面会先显示「正在测量卡片」的门，门没放开就去点历史列表会点空（探针问题，已改成等门放开再动手、历史按钮点不开就重点）；开关关掉的模拟原先用 `setHostedAgent`，会被成员列表一条不带 `hosted` 的回包（本机文档服务不报这个字段）抹掉，改用可注入来源模拟。修完之后桌面段单跑一次 24/24 全过、在线加桌面合跑一次 52/52 全过；中间那次桌面段「点了历史里的云端对话但云端 AI 栏没出现」只出现过一次、没再复现，原因没有查清（门放开之后的点击时机的可能性最大），所以探针里留了诊断截图 `D5-click-failed.png` 的出口，再出现时有现场可看。

## 提交

`11b12601` 页面一侧接口层与单测 · `59fcd5a8` AI 栏组件与接入 · `36c91b54` 守卫与棘轮 · `0b40331a` 探针骨架 · `8a9e2e59` 折函数幂等与重置判定 · `9250278e` 身份订阅与探针 D6 · `b27395e7` 探针稳定性与契约补行 · `d201271d` `end.reason` 兼容；加本报告的提交。
