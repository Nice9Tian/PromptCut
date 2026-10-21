# AGENT-mobile-agent-page：手机版 Agent 分页照演示稿重画

分支 `claude/mobile-agent-page`（从 main `13c89af6` 切出），worktree `.worktrees/mobile-agent-page`，端口段 5980～5989。

## 任务

照 `prototypes/mobile-ui-demo/` 重画手机版（`src/mobile/`）的 Agent 分页：对话标签、消息气泡、操作卡片、输入框、输入框上方的引用标记条；没有会话时显示开始页（和桌面共用 `src/ai/agentTabs.ts` 的逻辑）。桌面界面不受影响。出处：`docs/plan/mobile-online-task.md` 文末「待用户项」第 3 条（用户 2026-10-21 定另开一项先做，2026-10-22 定派子 Agent 做）。

## 做了什么

代码都在 `src/mobile/`，桌面文件一行没动（`git diff main...HEAD --stat` 里 `src/` 下只有 `src/mobile/`）。

- `agentView.ts`（纯函数，node 可测）：引用的写法与识别（`withQuotes` / `splitQuotes` / `addQuote`）、一轮回复拆成「动手前的话 → 操作卡片 → 动手后的话」（`roundView`）。单测 `agentView.test.mjs` AV1～AV6。
- `agentParts.tsx`：气泡、操作卡片、引用标记条、开始页、对话标签行（`AgentTabsBar`）。
- `AgentChatView.tsx`：一个会话的对话页的画法（创造力一行、消息区贴底跟随、输入区），不接云端，只吃 props。
- `AgentChat.tsx`：一个会话的云端接线，沿用桌面 `CloudAiPanel` 的做法：`useCloudChat`、告知确认、对话权限、发送（账号模式乐观显示、没发出去放回）、停止、共有 / 私有、开始页（`useStartPage`，和桌面同一个钩子）。
- `AgentPage.tsx`：标签行 + 每个会话各挂一份 `AgentChat`（切标签不卸载，后台对话照跑）。标签清单用 `agentTabs.ts`（按项目分开、标记「项目ID_AgentID」），并引入 `agentTabsProject.ts` 让清单跟着项目走（手机版原来没引入，只因桌面的 `railStore` 引入了它才没出问题）。
- `MobileEditor.tsx`：Agent 分页换成 `<AgentPage>`，`pc-quote-clip` 事件（选中项点「引用」、预览右键「引用到 AI」同一个事件）照旧发，只是接收方由往输入框插字改成往标记条放。
- `mobile.css`：演示稿 Agent 页的样式（类名同演示稿，全挂在 `.pcm` 下，颜色走变量）、开始页的引导动画（`prefers-reduced-motion` 下全关）。
- `icons.tsx`：加 `send`、`stop`。
- `agent-harness.tsx`：只给探针用的页面（不接云端，用假消息画一页），不进任何构建。
- 语义：`docs/semantics/workflow/editing.md`「手机版界面」加一组 Agent 分页的写法（含用户 2026-10-21、2026-10-22 的决定与〔裁〕），并把上面「AI 栏的 Agent 标签」里「手机版的 Agent 分页另有一项要照演示稿重画（这次没改）」那条改成指向新写法；`glossary.md` 改「引用（手机版界面）」一条、加「引用标记条」。
- 探针：新增 `mobile-agent-probe.mjs`（真页面：开始页、清空、引用、发送、标签、和演示稿尺寸对照）、`mobile-agent-view-probe.mjs`（对话页的画法，假消息）；改 `mobile-business-probe.mjs`（引用一段）、`agent-tabs-start-mobile-probe.mjs`（M1 一段）；`mobile-account-probe.mjs` 加可选 `--base-port`（缺省端口不变，给了就改用连着的 9 个，好在分给自己的端口段里跑）。

## 〔裁〕清单

全部写进了 `workflow/editing.md`，每条标「〔裁：2026-10-22 mobile-agent-page〕」。语义里没有的细节，我按「业务层怎么做、演示稿怎么画」定了下面几条，用户合入前审，可推翻：

1. **引用的发送写法不变**：标记条里是引用项，发送时正文仍是「@卡片 名字(片段 id) 」放在话前面（Agent 认的就是桌面「引用到 AI」那个写法）；气泡上把开头的引用串认出来画成标记。修改前：往输入框里插这串字。修改后：放进输入框上方的标记条。
2. **关会话先问**：手机版没有历史对话列表，关掉的会话在手机上找不回，所以有对话的会话关之前问一声；空会话直接关。（桌面悬停「×」直接关。）
3. **快捷提问四句保留，但点了只放进输入框、不直接发送**（演示稿是点了就发；免得点错用掉额度）。开始页上不放。
4. **发送钮在「在跑且输入框空」时换成停止钮**（演示稿没有停止，业务层必须有）；输入框里有字时仍是发送。
5. **已有对话、权限还没读回来时先不让发**；新对话不等（桌面是整个输入区都等权限，手机版开始页要能直接输入）。
6. **创造力一行**：低 / 中 / 高，只管这个对话（`agentTabs` 里每个会话的覆盖值），在跑时置灰（同桌面下拉框）；缺省跟项目。
7. **「共有对话 / 私有对话」小标签**：演示稿里是个标签；开这个对话的人可以点一下切换共有 / 私有（业务层有这个能力，同桌面的「设为私有」按钮）。
8. **操作卡片的条目写「类别 + 工具名」**（新增 add_clip、修改 set_clip_param……，类别沿用桌面操作图标的分类），业务层没有人话的一句描述。
9. **演示稿有、业务层没有，不显示**：Agent 需要你确认的破坏性操作确认卡；操作卡片里「改动前后」对比图和参数差异。**业务层有、演示稿没有，暂不放**：附件、模型与思考强度、历史对话列表、删除对话、诊断报告、操作卡片里的「撤销这步」、Agent 未读角标。这些都要用户定要不要补、补到哪里。
10. **Enter 发送、Shift+Enter 换行**（同演示稿的 Enter 发送）；输入框随内容长高，最多约五行。

## 验证结果

最终提交上跑的（命令都在 worktree 根目录）。端口都在 5980～5989 里，旧探针用 `--base-port` 一类参数挪进来；起的进程跑完都结束了（`netstat` 看 598x 没有监听）。

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误 |
| 全量测试 | `$env:PROMPTCUT_ACCOUNT_PROVIDER_ROOT=…; $env:PROMPTCUT_PASSWORD_ORDER_MODULE=…; npm test` | 7403 项，通过 7388，失败 0，跳过 15（跳过的是原有的），退出码 0；其中新增 `src/mobile/agentView.test.mjs` AV1～AV6 全过 |
| 新：真页面 | `node scripts/probes/mobile-agent-probe.mjs` | ok、0 项失败（见下面各组） |
| 新：对话页画法 | `node scripts/probes/mobile-agent-view-probe.mjs` | ok、0 项失败 |
| 旧：界面 M2 | `node scripts/probes/mobile-ui-probe.mjs --base-port 5980 --base2-port 5983 --doc-port 5987 --asset-port 5988` | ok、0 项失败（没改断言） |
| 旧：业务层 M3 | `node scripts/probes/mobile-business-probe.mjs`（同上端口） | ok、0 项失败（改了「引用」那一段的断言，见下） |
| 旧：账号版全路径 | `node scripts/probes/mobile-account-probe.mjs --dist dist-online --site-root <VisuHive>/site --base-port 5980`（设了两个环境变量） | ok、0 项失败（加了 `--base-port`，缺省端口不变） |
| 旧：开始页（手机） | `node scripts/probes/agent-tabs-start-mobile-probe.mjs` | 4 项全过（改了 M1 一项，见下） |
| 旧：开始页（桌面，证明桌面没受影响） | `node scripts/probes/agent-tabs-start-probe.mjs --port 5980` | 26 项全过 |

`mobile-agent-probe.mjs` 验的（安卓仿真 375×812、触屏）：
- S：没有会话时只有「开始」一项标签（没有 ✕）、预设按钮、输入框，刚进项目带光点和箭头、输入框带引导；点预设后句子进输入框、发送钮催发送、清单里仍没有真页；点发送才建 Agent 1（分页标记是「项目ID_AgentID」，存在 `pc.agentTabs:<项目ID>`），这条消息是在新建出来的 Agent 1 里发的。
- Q：选中缩略卡点「引用」→ 切到 Agent 分页，标记条出现，底边 ≤ 输入框顶边；开始页上点「引用」不往输入框里插字；重复点同一项只有一个标记；点 ✕ 去掉；发送时正文是「@卡片 名字(片段 id) 话」（读只读口子 `window.__pcMobileAgent[会话].lastSend()`），没发出去时引用放回标记条。
- C：关掉最后一个会话回到只有「开始」的开始页，没有光点和箭头、输入框不带引导、记下「手动清空过」；清空后点预设仍催发送。
- T：「+」新开 Agent 2 并切过去，每个标签都带 ✕；切标签换会话、没显示的会话仍挂着；空会话直接关，有对话的先问一声（取消不关）；新建取最小空号；清单按项目存。
- D：和演示稿同尺寸对照：对话标签高 30、「+」34×34、创造力一行高与间距、分段控件 100×28、输入区整块位置与高度（97）、输入框 307×40、发送钮 40×40、快捷提问 28 高、底部导航栏同位；带引用时标记条 24+4 高、标记与 ✕（18×18）位置尺寸、输入区高 133，和演示稿逐像素一致。
- W：375 宽无横向溢出，页面无未捕获错误。
- 本机组合没有云端 Agent 服务，探针在页面收到成员列表时把 `hosted.agent` 改成「可用、开着」（`addInitScript` 式的垫片），好让发送走到页面自己的那一段；这个垫片同时会让同步层弹一条桌面样式的气泡，探针把它藏了。

`mobile-agent-view-probe.mjs` 验的（用 `agent-harness.tsx` 画假消息，vite 中间件模式服务，端口 5985）：V1 气泡左右与最宽 88%、引用画成只读标记；V2 操作卡片（标签、轮次与项数、折叠 / 展开、状态色同演示稿变量、小结行）；V3 在跑的一轮三点和「正在做什么」、发送中 / 已发出 / 没发出去的原因、出错原因；V4 引用标记条尺寸与位置同演示稿；V5 开始页（引导动画、预设后催发送、清空后无动画、`prefers-reduced-motion` 下动画全关只留静态描边）；V6 标签行（每个都有 ✕、忙着的小点、长标题截断、只有「开始」时没有 ✕）；V7 在跑且输入框空时换成停止钮；V8 无横向溢出、无页面报错。

旧探针断言的改动：
- `mobile-business-probe.mjs`「引用进 Agent」：原来看输入框里被插了字；现在看输入框是空的、输入框上方出现标记「@ 名字」。
- `agent-tabs-start-mobile-probe.mjs` M1：原来要求 Agent 分页里是桌面那套云端对话面板、没有开始页；现在要求是新的 Agent 分页的开始页（一项「开始」标签、预设、输入框、没有 `.ai-panel`）。
- `mobile-ui-probe.mjs`、`mobile-account-probe.mjs`：断言没改。

看过的图（和演示稿同尺寸 375×812、2 倍像素；`out/` 在 worktree 里，不入库）：
- 开始页带引导动画：`.worktrees/mobile-agent-page/out/mobile-agent-shots/agent-start.png`（真页面）、`out/mobile-agent-view-shots/view-start.png`；点预设后：`agent-start-preset.png`。演示稿里没有开始页，所以这一张没有并排。
- 有会话的对话页（气泡、操作卡片、小结行、在跑一轮）并排：`out/mobile-agent-view-shots/side-view-chat.png`（左实现、右演示稿）；展开旧一轮与各种状态：`view-chat-open.png`、`view-chat-states.png`；标签行：`view-tabs.png`；停止钮：`view-stop.png`。
- 引用标记条并排：`out/mobile-agent-view-shots/side-view-quote.png`、真页面上的 `out/mobile-agent-shots/side-agent-quote.png`；发送带引用之后：`agent-sent.png`。
- 清空后的开始页（没有光点和箭头）：`out/mobile-agent-shots/agent-cleared.png`、`out/mobile-agent-view-shots/view-start-cleared.png`。
- 真页面与演示稿的整屏并排：`out/mobile-agent-shots/side-agent.png`（真页面在本机没有云端 Agent，会话是空的，所以只对布局，不对内容）。

## 没做到的与原因

- 上面〔裁〕第 9 条那几项（手机版暂不放的业务层入口）——演示稿里没有，按任务书「设计决定 3」不显示，待用户定。
- **发出的消息真正到云端、Agent 回复真正流回来**，在本机环境里没法端到端验：本机托管组合没有云端 Agent 服务，也没有网站账号，页面的云端会话（`useCloudChat`）因此不起（账号模式要有账号和告知确认才起）；`cloud-agent-ui-probe.mjs` 那套真账号 + 真 Agent 服务的夹具要连着占 45 个端口，超出分给我的 10 个。所以：点发送到「建会话、拼出带引用的正文」这一步用探针验了（读只读口子 `window.__pcMobileAgent[会话].lastSend()`）；对话页怎么画用假消息验了（`agent-harness.tsx`）；发到云端之后的那一段沿用桌面 `useCloudChat`、没改，桌面那边有它自己的探针（`cloud-agent-ui-probe.mjs` 等）。建议用户或后续会话在带账号和 Agent 的环境（本机账号版组合，或部署后的 visuhive.com）里用手机仿真发一条带引用的消息，看一眼。

## 对任务书或语义的更正建议

- `docs/plan/mobile-online-task.md` 文末「待用户项」第 3 条（Agent 分页用的是桌面那套对话页）可以标为已完成，指向本报告与 `workflow/editing.md`「手机版界面」。（任务书在 `docs/plan/**`，按要求没碰。）
- 同一份任务书「没做到的与原因」里和「待用户项 4」并列的那几个入口，本任务又新增了一批手机版暂不放的入口（见〔裁〕第 9 条），建议并进同一张待用户表。
- 手机版里同步层的气泡（`pc-toasts`，桌面样式，固定在右上角 `top: 58px`）会盖在 Agent 分页的标签行上、拦触摸（探针里造「创建者开了云端 Agent」时撞上）。这是原有行为、不在本任务范围，没改，建议另列一项。

## 部署清单

只有 `src/`（`src/mobile/`）：重建在线前端（`npx vite build --mode online`），整份 `src/` 同步进渲染树（渲染节点里的 `src/` 副本跟 main 对齐）。没有 `server/` 改动、没有语义以外的 `docs/` 改动要上线，没有新依赖。
