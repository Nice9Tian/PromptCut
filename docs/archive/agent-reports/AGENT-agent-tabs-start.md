# AGENT-agent-tabs-start

分支 `claude/agent-tabs-start`(从 main `cc716da3` 切出)。任务:A10 分页清单按项目分开;A09 会话都能关、没有会话时显示开始页(用户 2026-10-22 定;A09、A10 是 `docs/plan/user-decisions-2026-10-21.md` 第 7 节表格里的两条回复编号)。

## 做了什么

### A10 分页清单按项目分开

- `src/ai/agentTabs.ts` 重写为「每个项目一份清单」:存 `localStorage` 键 `pc.agentTabs:<项目ID>`(里面是该项目的页列表、当前页、「手动关光过」标记);分页的内部 id 是「项目ID_AgentID」(`tabIdOf`),`AgentID` 是随机短串,**不复用**(关掉再建不会碰到旧会话留下的 `pcChatId:`、云端指针等键)。界面上仍叫 Agent 1、Agent 2……,编号在本项目内取最小空号。
- 新文件 `src/ai/agentTabsProject.ts`:盯着编辑器 store 的项目 id 与 `projectLoadToken`,换项目就调 `setAgentProject`。`agentTabs.ts` 自己不依赖 store,Node 单测能直接载入。`railStore.ts` 导入它(先于第一次读清单)。
- 竖栏同步(`railStore.ts`):换项目或关光回到开始页时,新补进来的当前页顺手选中(不展开),不会退回「剧本」。
- 子 Agent 页(`spawn_agent`)、`findTabByConversation`、范围改名等照旧,只是都在当前项目的清单里。

### A09 会话都能关;没有会话时显示开始页

- 去掉「至少保留一个」:最后一个分页的「×」可点,提示语删掉(`RailBar.tsx`)。
- 没有会话时,清单对外给一个 `draft: true` 的占位页(开始页):它的 id 就是点发送后建出来的第一个会话的 id,所以变真页时竖栏的项、页面节点都不换。占位页不进存储、不发请求。竖栏上画成一项「开始」(图标 ✦,没有「×」);没有会话时「+」回到它。
- 新组件 `src/editor/right/chat/StartHero.tsx` + `startHero.css`:消息区换成开始页(说明 + 预设按钮「做一个动画告诉我使用软件可以干什么」),下面仍是平常的输入框。`Composer` 加 `guide` 属性(`"input"` 输入框描边脉动;`"send"` 发送按钮闪)。
  - 刚进项目、从没手动关光过:开始页带引导动画(呼吸的光点、指向输入框的箭头、输入框描边脉动)。`prefers-reduced-motion` 下全部关掉。
  - 手动关光过(按项目记在清单里,`cleared`):不放动画,只有预设和输入框。
  - 点预设:句子放进输入框(已有同一句不重复加),发送按钮闪,两种开始页都这样。
  - 点发送(`AiPanel.handleSend`、`CloudAiPanel.handleSend`):先 `commitDraft` 建出 Agent 1,再发这条消息。本机和云端两条路都是。没点发送之前不建会话、不发聊天请求。
  - 在开始页里从历史列表点开旧对话、点「接上看看」之类(消息先出现了):占位页自动变真页,免得对话被开始页盖住。
- 手机版(`src/mobile/`)没改:它用固定的一页 `main`(`OnlineCloudPanel tabId=main`),不看分页清单,所以没有开始页;本项目有没有会话都照常显示云端对话面板。在线构建里实测(见验证)不出错、不白屏:Agent 分页占满 375×703,是平常的空对话(示例句「为我快速创建一个视频告诉我软件都可以做什么。」,输入框要等对话权限读回来才出现,与改前一致),截图 `out/agent-tabs-start-mobile-probe/mobile-agent.png`。

### 为让分页 id 改成「项目ID_AgentID」而必须动的邻近文件(超出任务书清单,最小改动)

- `src/ai/liveChat.ts`:`isMainTab(id)`(「main」或以「_main」结尾);`getChatStore` 把两种叫法归到同一份主对话 store;`messagesForSave` 多一个可选的 store 参数。
- `src/ai/useAiChat.ts`:`tabId === MAIN_TAB` 三处换成 `isMainTab` / 首启设置对话框「谁先走到谁弹」(以前认「main」那一页;第一个会话不再是固定的 main)。
- `src/ai/projectAi.ts`:见〔裁〕3、4。
- `src/ai/envCollect.ts`:报告里的页签数取真页数。
- `src/ai/cloud/useCloud.ts`:探针只读口子 `window.__pcCloud` 里,清单排第一的页同时挂在 `main` 名下(老探针 28 处读 `__pcCloud.main`)。
- 老探针开场一两行跟着改:`creativity-probe`、`multi-agent-probe`、`codex-auth-state-probe`、`chat-window-probe`、`cloud-agent-ui-probe`(O8)。`src/ai/agentBus.test.mjs` MA-P2 先点发送建出第一个会话再开第二页。

## 〔裁〕清单(我定的实现细节,都已写进 `docs/semantics/workflow/editing.md` 标〔裁〕)

1. **旧的全局清单(`pc.agentTabs`、`pc.agentTabs.active`)不迁移、不读取、也不删**(原样留在本机,回滚版本还能用)。理由:迁到「第一个打开的项目」会把别的项目里干活的会话挂到错的项目上,和「按项目分开」相违。对话本身没丢,在历史对话里找得到。
2. 开始页在竖栏上是一项「开始」(没有「×」),没有会话时「+」回到它;引导动画的样子(光点、箭头、描边脉动)和「减少动态效果」时关掉;点预设后发送按钮闪在两种开始页里都有。
3. 项目文件(`.proc`)自带老对话而本机没有这个项目的清单时,补一个页「项目ID_main」(显示为 Agent 1)接住,并把老的全局 `pcChatId` 接过来,归档里那段接得上。靠 `applyProjectAi` 记一笔、紧接着的换项目消费(只管一次)。
4. 随项目文件存的对话改取「本项目清单里排第一的真页」的对话(以前只存主页那一份)。新建的会话各有自己的 store,不这样改的话新项目的对话不会跟项目文件走。**仍然的差别**:同一台机器上重开项目时,各页的对话从会话归档按对话 id 找回(和以前的非主页一样),项目文件里那一份只在本机没有分页清单时才会被补成 Agent 1。
5. 分页 id 里 AgentID 随机且不复用;项目里还没有过真页时开始页的 AgentID 固定叫 `start`(不写存储,刷新后仍是同一个,不会每次刷新留一串键);关光后换成随机的。没关光过也没有会话的项目不往存储里写键(编辑器启动时那个临时空项目也不留键)。
6. 云端开始页:不发聊天请求,但云端面板挂上时和任何新开的空标签一样会做只读的事件读取与对话权限读取(对页面刚建的新对话,服务端回「还没有」当空对话,不报错)。点发送时若云端因告知未确认等原因没有真发出去,第一个会话已经建出来了(用户已点发送)。
7. 切项目时,旧项目的 AI 面板卸载,还在跑的那一轮随之断开(以前切项目时那些页留着,工具会落到新项目上)。

## 验证

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0,零错误 |
| 全量测试 | `npm test`(设了两个 VisuHive 环境变量),在最后一次代码改动之后跑 | 退出码 0;7379 个用例,通过 7364,失败 0,取消 0,跳过 15 |
| 单测 | `node --test src/ai/agentTabsClose.test.mjs`(AT-C1～C6) | 通过 6 |
| | `node --test src/ai/agentTabsProjects.test.mjs`(AT-P1～P6、P5b) | 通过 7 |
| | `node --test src/ai/projectAiSave.test.mjs`(PA-1) | 通过 1 |
| | `src/ai/agentBus.test.mjs`、`envReport.test.mjs`、`CloudModelBar.test.mjs` | 通过 6、15、3 |
| 界面探针(新) | `node scripts/probes/agent-tabs-start-probe.mjs`(真 Chrome,`?editor&aimock=1`,不调真模型) | 26 项全过,无页面错误 |
| 在线构建探针(新) | `node scripts/probes/agent-tabs-start-mobile-probe.mjs`(`vite build --mode online` 后) | 4 项全过:在线桌面界面的云端开始页、手机版 Agent 分页不出错 |
| 老探针 | `creativity-probe.mjs --origin …` | 16 项全过 |
| | `multi-agent-probe.mjs --phase 1 --origin …` | 24 项全过 |
| | `codex-auth-state-probe.mjs --port 5987` | 15 项全过 |
| | `chat-window-probe.mjs --port 5987` | 19 项全过(含「在开始页点开历史会话」) |

界面探针 S1～S7:S1 新项目进来只有竖栏一项「开始」、开始页带动画、存储里没有清单、零聊天请求;S2 点预设后输入框里是那句话、发送按钮在引导、仍没建会话;S3 点发送后才出现 Agent 1(id 以项目 id 打头)、消息在里面、清单按项目存;S4 项目 A 开两个分页、切到新项目 B 只看到 B 自己的(开始页,带动画)、B 发送得 B 的 Agent 1、切回 A 还是 Agent 1+2;S5 把 A 关光(最后一个「×」可点、标题不再是「至少保留」)回到不带动画的开始页,清单里记 `cleared:true`,B 记 `cleared:false`,点预设仍可用;S6 刷新页面再载回 A 仍是不带动画的开始页、载回 B 仍有 Agent 1;S7 正常时光点/涟漪/箭头/输入框描边四处都有 animation,开「减少动态效果」后全为 none。

截图(主会话请亲自看,路径在 worktree 下,探针每次运行会覆盖):
- `out/agent-tabs-start-probe/s1-start-animated.png` 开始页带引导动画
- `…/s2-after-preset.png` 点预设后(输入框有那句话、发送按钮闪)
- `…/s3-after-send.png` 点发送后(Agent 1 出现,对话在里面)
- `…/s4-rail-a.png`、`s4-page-a.png` 项目 A 开了两个分页;`…/s4-rail-b.png`、`s4-page-b.png` 项目 B 只有自己的(开始页);`…/s4-rail-a-again.png` 切回 A
- `…/s5-cleared.png` 关光后的开始页(无动画);`…/s5-cleared-after-preset.png` 关光后点预设;`…/s6-reload-cleared.png` 刷新后仍无动画
- `out/agent-tabs-start-mobile-probe/online-desktop-start.png` 在线桌面界面的云端开始页;`…/mobile-agent.png` 手机版 Agent 分页

## 没做到的与原因

- **云端开始页「点预设、点发送」的端到端没在浏览器里走**:本机托管组合没有云端 Agent 服务,云端面板的输入框要等对话权限读回来才出现。云端面板的开始页本身(竖栏「开始」、光点、预设)已在在线构建里看过;点发送那一段与本机面板用同一个 `useStartPage`,代码对称,但没有真云端对话验证。要验就得跑账号组合的云端探针。
- **这批云端 / 账号探针没跑**(端口要 45 个连号或多个端口段,超出分给我的 5980～5989):`cloud-agent-ui-probe`、`cloud-agent-ux-ui-probe`、`cloud-queue-user-pages-probe`、`agent-panel-smooth-probe`、`conversation-delete-probe`、`newchat-events-probe`、`account-*` 一族、`accept-018-conv-password-probe`。它们读 `window.__pcCloud.main`(已加兼容口子)、开场看空对话示例句(`cloud-agent-ui-probe` O8 已改成看开始页预设)。**这些探针改动后没有验证**,合入前请在有云端夹具的机器上跑一遍,可能还会碰到别的小处(如开场就期待消息区是空对话)。
- 手机版 Agent 分页的重画(开始页等)按任务书没做。
- 引导动画我只验了「有 animation / 关掉后没有」和截图,没录视频看动感。

## 给 `product/agent.md`、`mechanism/agent.md` 的修改建议(这两份我没改)

`product/agent.md` 里没找到与新做法冲突的句子(没有「主分页不能关」之类)。`mechanism/agent.md` 同样没有冲突,但有两处可补:

1. `mechanism/agent.md` 第 59 行(`spawn_agent` 那条):
   - 修改前:「……开一个带角色名的新页签,不抢焦点……」
   - 修改后:「……在当前项目的 AI 栏分页清单里开一个带角色名的新页签(页签 id 是「项目ID_AgentID」,清单按项目分开,见 `../workflow/editing.md`「AI 栏的 Agent 标签」),不抢焦点……」
2. `mechanism/agent.md` 第 159 行(`pc.cloudFresh` 那条):
   - 修改前:「键 `pc.cloudFresh:<账号范围>:<项目>:<页签>`」
   - 修改后:「键 `pc.cloudFresh:<账号范围>:<项目>:<页签>`(页签 id 是「项目ID_AgentID」;开始页占位页在点发送之前就用它将来的 id,新对话编号只记当前那一个)」
3. 可选:`product/agent.md` 在「云端 Agent」或 AI 栏相关处加一句「AI 栏的 Agent 标签按项目分开,没有会话时显示开始页,点发送才建第一个会话(用户 2026-10-22 定,见 `../workflow/editing.md`)」,免得产品层读者以为 Agent 标签是全局的。

## 部署清单

- 只有 `src/`(加 `docs/`、`scripts/probes/`)变了:要**重建在线前端**,并把**整份 `src/` 同步进渲染树**。
- 没有服务端文件变化(`server/**` 一个字没动)。无新依赖、无数据格式迁移(旧的 `pc.agentTabs` 键不动)。

## 分支提交

见 `git log claude/agent-tabs-start`。不推送、不合并。
