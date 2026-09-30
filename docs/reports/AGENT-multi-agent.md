# AGENT-multi-agent 报告（A3「多 Agent」）

分支 `claude/multi-agent`，起点 `claude/r4-merge` 的 `628b7d42`（main 之上已合 A1 创造力等级、A2「用户正在编辑」、查询渲染调度）。

A3 = 计划 `docs/plan/agent-workflow-plan.md` 第 2 节表里的第三段「多 Agent」：主 Agent 拉起子 Agent（`spawn_agent`）、协调公告板从页面内存搬到服务端、Agent 之间的覆盖双方都知道、归档旧的「分工模式」，第二阶段把「正在编辑」、范围声明和 Agent 间的消息经文档服务转给共享项目的其它成员。

## 状态

**完成，基线全绿、探针两个阶段都过**（见「验证」）。主会话已审过 18 条〔裁〕并认可；计划 A3 验收措辞由主会话改；`product/document-service.md` 补「在场状态」先不写、列给用户定。没有二级语义改动；三级〔裁〕18 条（见「〔裁〕清单」）。托管端（文档服务）**需要重新部署**才有跨设备提示（新增在场状态模块）；不部署也不坏：客户端对旧版文档服务平稳退回（单测 MA-X5）。

## 提交

| 提交 | 内容 |
|---|---|
| `038d18ba` | 建本报告 |
| `d864374a` | 第一阶段：`spawn_agent`、公告板搬到编辑器进程、被覆盖方得知、写进别人范围双方提示、归档分工模式 |
| `2a90648c` | 第二阶段：文档服务的在场状态模块、编辑器进程的桥、页面发布编辑状态与显示别的成员的 Agent |
| `5e8cb041` | 探针 `scripts/probes/multi-agent-probe.mjs` |
| `a19f1f69` | 报告草稿；公告板 `touch` 不记空对话 ID |
| `e48f6be8` | 修：交给在场状态的 `userId` 可能是 null（tsc 拦下） |
| `9ae3eac2` | 修：`spawn_agent` 的角色常量挪进不引 Node 内置模块的 `server/agent/spawn-roles.mjs`（工具表被页面静态引入，之前经 `agent-roles.mjs` 把 `node:fs` 带进页面依赖链，开发服务器会整页白屏；`src/pageNodeImports.test.mjs` 拦下） |
| `9f3757c1` | 修：不认识的驱动名不再让 AI 栏整页报错（`src/ai/modelOptions.ts` 加 `capabilityOf`，查不到给一张「什么都不支持」的能力表；探针里子 Agent 页签沿用 `probe-none` 时暴露） |
| （本提交） | 探针第二阶段等编辑台挂好再拖；`/api/agent/status` 带在场状态与编辑看板的诊断；报告补验证 |

## 做了什么

### 1. `spawn_agent`（`server/agent/multi-agent.mjs`、`server/agent/agent-roles.mjs`、`server/tools/agent.mjs`）

- 主 Agent 调 `spawn_agent(role, task)`：服务端给子 Agent 一个新对话 ID（`sub-` + 12 位随机，= 新身份），在 A1 的登记表 `server/agent/agent-sessions.mjs` 里登记（`type` / `vendor` 沿用父对话，`role` = 预设角色，新增 `parent` 字段记父对话），经编辑器页面的 SSE（`agent.spawn`）开一个新页签，页面 `POST /api/agent/spawned` 回话（8 秒没回算失败，撤掉登记）；任务作为第一条消息投进子 Agent 的信箱，页签一开、空闲就由页面发出（与 `send_message` 同一条投递路）。返回子 Agent 的对话 ID、角色名、驱动、等级。
- 预设角色从 `src/ai/roles/*.md` 里取（「一键配特效」也读它们），工具参数里列成 `enum`：`director`（剪辑导演）、`fx-assistant`（特效助理）、`collector`（素材收集员）。只做拆解调度的 `manager.md`（制片主管）随分工模式删掉。子 Agent 每一轮的系统提示词里都拼上它的角色提示词（`/api/ai/chat`）。
- 上限（计划第 4 节第 2 条〔裁〕）：子 Agent 再拉起回 `code: 'depth'`；同一个主 Agent 开着的子 Agent 满 4 个时第 5 个回 `code: 'too-many'`（带现有子 Agent 列表）；桌面 APP 会话 / 没登记的对话回 `code: 'no-tab'`（「没有页签可开」）；编辑台没打开同样 `no-tab`。
- 子 Agent 的创造力等级：拉起时取父对话此刻生效的等级作覆盖值；之后每次判都再和父对话此刻生效的等级取低的（`agent-sessions.mjs` 的 `creativityOf`）。AI 栏每条消息的登记（`role` 固定 `main`）不改掉子 Agent 的角色与父对话。
- 页面：`src/ai/agentTabs.ts` 的页签加 `role`、`roleName`、`parent`、`provider`；`addSpawnedTab` 先把对话 ID 写进这一页记会话 id 的键（`pcChatId:<tabId>`），页面挂上时 `useChatHistory` 就用它；不抢当前页焦点；页签名 = 角色名（同角色第二个起编号），声明范围后「角色 · 范围」。`useAiChat` 对拉起的页签按 `provider` 预选驱动（沿用父对话）。

### 2. 公告板搬到服务端（`server/agent/agent-board.mjs`、`src/kernel/agentScopes.mjs`、`src/ai/agentBus.ts`）

- 公告板在编辑器进程里、按项目一份（`createAgentBoards`；绑了副本用副本的项目 id，没绑用镜像里的项目 id）。`declare_scope` / `list_agents` / `send_message` / `check_messages` 改成 `side: "server"`，在 `callToolInternal` → `runServerTool`（绑了副本时经 `agent-side` 的 `callServer`，现在带 `{ agent }`）里答，所有 Agent 看到同一份。
- 名单：页面报的页签（`POST /api/agent/tabs`：对话 ID、页签名、忙不忙）、调过工具的会话、第二阶段别的成员那边的 Agent。
- 改动记录**由文档服务的提交流喂**：`doc-link.mjs` 的副本每应用一版回调 `onCommit({ rev, opId, actor, ops, before, after })`，`attachLink` 接到公告板，按前后两份项目算碰了哪几条「剪辑->序列」（页面与服务端共用 `src/kernel/agentScopes.mjs`），写入身份照文档服务的 actor：页面 = 用户、各 Agent（session `agent:<对话>`）、共享项目别的成员（`用户 <userId>`）。页面替某个 Agent 执行的写入（以页面身份提交）靠页面回包的 `opIds` 归到那个 Agent 名下（`agent-side` 的 `onPageWrites`）。**没接文档服务时**退回在 `callToolInternal` 记：页面执行器算好这次的范围随 `/api/mcp/result` 回包带回（`scopes`），`dispatchTool` 里记。
- 页签上的范围名、未读标记经现有 SSE 推给页面（`agent.board`，50 ms 合并）；页面 `agentBus.ts` 改成客户端：收 `agent.board`、报页签、空闲时 `POST /api/agent/inbox` 取走可自动投递的消息发出、收 `agent.spawn` 开页签。
- 投递规则沿用：收件页签空闲就作为一条用户消息发出、忙就攒着跑完再送，`MAX_AUTO_HOPS = 3` 保留（层数随 `/api/ai/chat` 的 `hops` 带给服务端，服务端 `beginRun` / `endRun` 记）。「其他 Agent 的动态」改由服务端在 `/api/ai/chat` 拼在这一轮提示词前面。
- **下一次工具结果里带上**（`multiAgent.wrap`，放法与 A2 的 `annotateResult` 一致，`notice` 在最前）：信箱里的消息（`messages`，带出即送达）、别人动了你声明的范围（`scopeChanges`，每条只提示一次）、你写的被覆盖了（`overwrittenBy`）、你这次写进了别的在跑 Agent 声明的范围（`scopeClash`）。多 Agent 工具本身不带。
- `server/ai-system-prompt.md` 的「多 Agent 并行」一节补 `spawn_agent` 与结果里的这几种提示。

### 3. 双方都知道覆盖（`attachLink`、`annotateBoard`）

- 被覆盖方：文档服务发给它那条连接的 `project.overwritten`（`writer` 是被覆盖那次写入的身份）按对话记下，下一次工具结果带「你写的 片段 c2（被 Agent conv-a（codex）覆盖，rev N）。先重读……」。覆盖方仍是 A2 的 `overwrote`。
- 「正在改」：写入方这次结果里 `scopeClash`（「这次写入落在别的 Agent 正在改的范围里：Agent X 声明在改的「…」……」），声明方下一次结果里 `scopeChanges`（「别人正在改你声明的范围：Agent Y 用 update_clip 改了 …」）。用户在页面上改进来也算。

### 4. 归档分工模式

删掉的文件（最后一个含它们的提交是 `038d18ba`，即本分支删之前的那一个；它们最后一次被修改是 `87ed412b` 等）：

- `src/ai/teamMode.ts`、`src/ai/orchestrate.ts`、`src/ai/orchestrateGraph.ts`（+ `orchestrateGraph.test.mjs`、`orchestrateReal.test.mjs`）、`src/ai/triage.ts`（+ `triage.test.mjs`）、`src/ai/runRoleTask.ts`、`src/editor/right/OrchestrationBlock.tsx`、`src/editor/right/OrchestrationBlock.css`、`src/ai/roles/manager.md`。
- 路由 `/api/ai/plan`、`/api/ai/triage` 与只给它们用的 `oneShotCompletion`、`oneShotViaCli`（`server/vite-plugin-ai.ts`）。
- Composer ✦ 菜单里的「分工模式」开关（`data-pc="ai-team-mode"`）与按钮上的小圆点；`useAiChat` 的 `runTeamMode`、编排状态；`MessageList` 的编排块。
- 「一键配特效」（`runWorkflow`、`WORKFLOW_ROLES`）与「诊断报告」照常；诊断报告的 `mode.teamMode` 换成 `mode.agentTabs`（页签数，`describeMode` 多于 1 页时写「多 Agent（N 个页签）」），`localStorage` 白名单去掉 `aiTeamMode`。
- 在线构建的 `/api` 棘轮基线 `server/test/c10-api-ratchet-baseline.json` 去掉 `/api/ai/plan`、`/api/ai/triage`（只减不增，说明里记了一笔）。
- 棘轮式检查：`server/test/multi-agent.test.mjs` 的 MA-S14 扫 `src/`、`server/`、`scripts/`，`teamMode` / `orchestrat` / `triage` / `runRoleTask` / `OrchestrationBlock` / 两条路由 / 菜单项都不许再出现，文件都不许存在。

### 5. 第二阶段：跨设备（`server/docservice/modules/presence.mjs`、`server/agent/presence-bridge.mjs`、`src/editor/sync/presence.ts`）

- 文档服务新模块「在场状态」（`presence.set / clear / list / send`，回 `presence.ok / presence.state`，广播 `presence.update / presence.message`）：只在内存里转发、不落盘、不进项目历史、带过期时间，借项目模块的频道广播（订阅就是 `project.open`，与事件模块同一做法），不回发给自己，断线撤掉该连接记的各项；渲染节点的连接不能发。挂进 `shared-service.mjs` 的每个空间（本地文档服务、局域网主机、托管端同一份）。
- 页面：A2 的编辑状态汇总每次推给编辑器进程时，另经**这个页面自己的文档服务连接**发布一份（`presence.set key=editing`，15 秒过期，非空时每 5 秒随心跳续期；空了 `presence.clear`）。在线页面（没有编辑器进程）也走这条。
- 编辑器进程的桥：订阅连接上收到的 `kind: 'editing'` → A2 看板 `createUserEditingBoard` 的新来源 `reportRemote`（带成员名、过期时刻；本机页面自己发布的那份按会话号跳过），Agent 读写到时提示「用户 bob 正在编辑片段 c2（拖动中）」（本机用户与各成员分句）；`kind: 'agent'` → 公告板名单里的远端 Agent（`list_agents` 带 `member`、`remote: true`）；`kind: 'agent-message'` → 进本机收件 Agent 的信箱（标「Agent X（codex，成员 bob 那边）」）。本机 Agent 声明范围时经它自己的连接发布（30 分钟过期），发给远端 Agent 的消息经发件方自己的连接 `presence.send`。绑上项目时就打开订阅、取一次现有状态（`presence.list`），不等 Agent 第一次调工具。
- 页面收别的成员那边 Agent 的范围，AI 栏顶上列一行「成员 alice 的 Agent（claude）正在改：剪辑1->序列1」（`src/editor/right/RemoteAgentsStrip.tsx`；在线页面放在「AI 助手」占位里）。
- **兼容**：旧版文档服务（线上 0.7.4）没有这个模块，核心对 `presence.*` 回 `error { reason: 'unsupported' }`：编辑器进程的桥第一次看到就记「不支持」、之后不发；页面按连接记、之后不发；都不抛错、不断线，只是没有跨设备提示（MA-X5、MA-P7）。旧客户端不发这些消息，连新文档服务不受影响。

## 〔裁〕清单（三级，语义没写到的细节；用户合入前可推翻）

1. **子 Agent 的创造力等级**：拉起时取父对话此刻生效的等级；之后每次判都与父对话此刻生效的等级取低的（父降级子跟着降；用户在子页签里调高也只到父那一档；往低调可以）。
2. **「同时在跑的子 Agent」= 页签还开着**：子 Agent 跑完一轮仍可能被消息唤起继续跑，用户关掉它的页签才腾出名额。按「正在跑一轮」算的话，拉起后立即结束一轮（比如驱动报错）就永远不会满 4 个，上限形同虚设。
3. 深度 1、并发 4（计划第 4 节第 2 条已定，只落实）；错误码 `depth` / `too-many` / `no-tab` / `no-parent` / `bad-role` / `bad-task`。
4. **预设角色**：`director`、`fx-assistant`、`collector`；`manager.md`（只做拆解）随分工模式删。角色提示词每一轮拼进子 Agent 的系统提示词。
5. **任务的投递**：作为第一条消息进子 Agent 信箱（层数 1），页签空闲就由页面发出；页签没开出来（8 秒）就撤掉登记、回错误。
6. **子 Agent 页签**：不抢焦点；页签名 = 角色名（同角色第二个起编号），声明范围后「角色 · 范围」；驱动沿用父对话（`type` 为 `api` 时是 `api`，否则是父对话的厂商）。
7. **公告板按项目一份**：绑了副本用副本的项目 id，没绑用镜像里的项目 id，都没有是 `''`；页面最近报的页签在切到新项目的公告板时补上。
8. **范围声明的有效期**：一个 Agent 30 分钟没动静（页签没开、不在跑、没调工具）就不算「在跑」，它的范围不再拿来比、不再列；别的成员那边 Agent 的范围在场状态 30 分钟过期。
9. **工具结果里带出的消息算送达**（从信箱取走，这一轮结束不再自动投递）；每条范围改动只提示一次；已在结果里提示过的改动不再进下一轮的「其他 Agent 的动态」。多 Agent 工具本身的结果不带这些提示。工具抛错时不取走，留给下一次。
10. **写入方提示的判据**：这次调用期间提交流里记到它名下的范围，与别的在跑 Agent 声明的范围重叠（同名或一方是另一方的上级）。
11. **改动记录的粒度**：只记「剪辑->序列」级的范围（与旧页面版相同）、切剪辑记整条剪辑、只调顺序记「序列顺序」、主题变了记「全局主题」；项目名、效果库、卡片源码不算范围。
12. **页面替 Agent 执行的写入**（以页面身份提交）靠页面回包的 `opIds` 归到那个 Agent 名下。
13. **在场状态模块的口径**：`data` 8 KiB、过期 1 秒～30 分钟（缺省 30 秒）、每个项目 256 项；连接断了撤掉它记的；页面编辑状态 15 秒过期（与 A2 看板续期一致）。
14. **旧版文档服务的退回**：第一次收到 `unsupported` 即停发（编辑器进程按整条 link，页面按那条连接）；请求超时只算这一次没发出去。
15. **本机页面自己的编辑状态**经文档服务回来时按页面会话号跳过（先到的远端那份在本机那份到达时清掉）；本机空间（userId `local`）的不带成员名。
16. **跨设备消息**：经发件 Agent 自己的连接广播，收件方所在的编辑器进程按 `to` 认；投进信箱时标「Agent <对话>（<厂商>，成员 <名> 那边）」；远端 Agent 在名单里忙不忙取它发布时的状态。
17. **诊断报告**：`mode.teamMode` 换成 `mode.agentTabs`（页签数）。
18. **成员名**：共享项目 userId 是「用户名@设备」，提示与名单里只取用户名。

## 验证

收到「可以跑重活」之后（机器上同时有 A6 的子 Agent 在跑重活）：

| 项 | 跑了几遍 | 结果 |
|---|---|---|
| `npx tsc -b --force` | 3 | 第 1 遍 1 个错（`syncManager.ts` 把可能为 null 的 `userId` 交给 `setPresenceLink`），修后第 2、3 遍（最后一遍在全部修完之后）退出码 0、0 错误 |
| `npm test` | 3 | 第 1 遍 4074 项 4071 过、1 败、跳过 2：`src/pageNodeImports.test.mjs`「页面的静态依赖链里没有 Node 内置模块」—— 真问题，见提交 `9ae3eac2`；修后第 2 遍、第 3 遍（全部修完之后）都是 4074 项 **4072 过、0 败、跳过 2**，退出码 0 |
| 代码指纹 `snapshotCode` / `captureCode` | 2 | `00a5264bf8a062ff6e0b5ed0516cccd1` / `86e443cb6fa838aef64788af6822fd68`，与任务书给的一致，没碰渲染 |
| 探针第一阶段 `node scripts/probes/multi-agent-probe.mjs --phase 1`（自起编辑器 5840，舞台 5841/5842） | 2 | 第 1 遍 17 过 7 败：子 Agent 页签沿用 `probe-none` 驱动，`ModelBar` 查能力表 `CAPABILITIES['probe-none']` 得 undefined，页面抛错（「Cannot read properties of undefined (reading 'efforts')」）、编辑台断开，之后的投递、页签名、再拉起都失败 —— 真问题，见提交 `9f3757c1`；修后第 2 遍 **24 过 0 败**，退出码 0 |
| 探针第二阶段 `--phase 2`（托管组合 5850/5851，成员甲编辑器 5843、成员乙编辑器 5846） | 3 | 前 2 遍各 3 败：负载下乙的页面过了 2 分钟还在开场的「正在测量卡片」遮罩里（截图为证），编辑台没挂上，拖不到卡、也没画 AI 栏 —— 探针等待太短（原来 120 秒、超时不报）；改成等遮罩撤掉、卡出现在时间轴上（最多 10 分钟，并作为一项检查）后第 3 遍 **11 过 0 败**，退出码 0 |

探针要点（第一阶段 M1～M6、第二阶段 X0～X3 的实测值）：
- 主对话调 `spawn_agent` 回 `sub-PdYr-QziiOhv`，角色「剪辑导演」、等级「中」（父对话此刻的等级）、驱动沿用 `probe-none`；页面出现页签「剪辑导演」，登记表 `role: director`、`parent: <主对话>`；任务作为来自主对话的消息由子页签发出。
- 父子各写一处：公告板改动记录里两条，写入身份分别是主对话与子 Agent。
- `send_message` 给空闲的子 Agent 由它的页签自动发出；给没有页签的会话，下一次 `get_clip` 结果里带 `messages` 与「别的 Agent 给你的消息」。
- 子 Agent 覆盖父写的片段：子这次结果带 `overwrote`（「Agent <主对话>(probe-none)刚改过」），父下一次结果带 `overwrittenBy`（「被 Agent sub-…(probe-none) 覆盖」）；父写进子声明的范围：父这次 `scopeClash`，子下一次 `scopeChanges`；页签名跟着范围变成「剪辑导演 · 剪辑1->序列 1」。
- 子 Agent 再拉起回「不能再拉起（深度上限 1）」；再拉 3 个共 4 个成功，第 5 个回「上限 4」，页面上正好 4 个子 Agent 页签。
- 第二阶段：乙（bob）的页面按住拖动一张卡，甲编辑器进程里的 Agent 读它：`userEditing: [{ kind: 'drag', who: 'bob' }]`，提示「用户 bob 正在编辑片段 c-…(拖动中)。这是提示不是禁止……」；读别的卡不带；甲的 Agent 声明「剪辑1->序列1」后，乙的页面 AI 栏顶上出现「成员 alice 的 Agent(probe-none)正在改:剪辑1->序列1」。两个页面都没有未捕获的异常。

看过的截图（都在 scratchpad 的 `ma/shots1`、`ma/shots2`）：
- `tabs.png`：右侧栏在「Agent 1」下面多了「剪辑导演」页签。
- `child-tab.png`：右侧栏有「剪辑导演」和三个「特效助理」页签（带角标），Agent 操作记录里是 5 条 `spawn_agent` 和几次读写。探针用 `activateTab` 切页签没有改变右侧栏显示的那一页（显示哪一页由侧栏布局管），所以这张图显示的仍是 Agent 1 的对话，不是子页签的对话；子页签收到任务消息是按 chat store 断言的（M2、M4）。
- `b-dragging.png`（第 2 遍）：乙的页面还在「正在测量卡片 7 / 11」遮罩里 —— 前两遍失败的原因。
- `b-remote-agents.png`（第 3 遍）：乙的页面顶栏「成员：2 人」，AI 栏顶上一行「成员 alice 的 Agent(probe-none)正在改:剪辑1->序列1」，时间轴上被拖动的那张卡带选中框。

重活禁令期间已跑的单测（一次一个测试文件，都在 worktree 里，ffmpeg 在 PATH）：

| 命令 | 结果 |
|---|---|
| `node --test server/test/multi-agent.test.mjs` | 15 过 0 败（MA-S1～S14，含真文档服务端到端 S11～S13） |
| `node --test server/test/multi-agent-presence.test.mjs` | 6 过 0 败（MA-X1～X5，两个成员共用真文档服务、旧版文档服务退回） |
| `node --test src/ai/agentBus.test.mjs` | 5 过 0 败（MA-P1～P5） |
| `node --test src/editor/sync/presence.test.mjs` | 3 过 0 败（MA-P6～P8） |
| `node --test server/test/user-editing.test.mjs` | 11 过 0 败（A2 原有用例不变） |
| `node --test server/test/agent-c65.test.mjs` | 11 过 0 败 |
| `node --test server/test/creativity-gate.test.mjs` | 11 过 0 败 |
| `node --test server/test/mcp-routes.test.mjs` / `tool-schema.test.mjs` | 8 / 21 过 0 败 |
| `node --test src/ai/envReport.test.mjs` / `src/ai/rewind.test.mjs` | 15 / 7 过 0 败 |
| `node --test server/test/report-progress.test.mjs` / `wait-tool.test.mjs` | 8 / 5 过 0 败 |

## 没做成的 / 不在本段

- 「父子并行写入不互相被判过时」的字面要求与二级语义冲突，没有照做：`product/document-service.md`「Agent 的写操作带期望版本，和当前版本不符就拒绝……由它重读后再改」。身份隔离做到了（各自的连接、写入身份、读到的版本、改动记录；MA-S11），但一方没重读就写仍按期望版本被拒（MA-S11 末尾断言）。见「更正建议」1。
- 在线页面没有自己的 Agent，所以在线页面上看不到「写进别人范围」之类的 Agent 提示；它能发布编辑状态、能看到别的成员那边 Agent 的范围。
- 桌面 APP 会话（A4）的公告板接入只铺了路：服务端答工具、消息能带在它的工具结果里；它没有页签，拉不起子 Agent（按任务书回 `no-tab`）。

## 对计划 / 语义的更正建议

1. 计划第 3 节 A3 验收「`spawn_agent` 的身份隔离（并行写入不再互相被拒）」改为「各记各的身份：写入身份、读到的版本、改动记录分开；读后写不被对方的写入误伤；没重读就写照 `product/document-service.md` 被拒」。
2. `product/document-service.md`（二级）「职责」里「它管理：……」可补「在场状态（成员正在编辑的内容、Agent 的范围与消息：不进项目历史、带过期）」。本段按同一节「通用的轻量文本 / JSON 调度分发中心……模块也可以挂上来」做，没有改语义；是否写进清单由用户定。dry run：
   - 修改前：`- 它管理：项目信息、每一次操作的接收与分发、锁、覆盖通知、卡片源码、渲染任务队列。`
   - 修改后：`- 它管理：项目信息、每一次操作的接收与分发、锁、覆盖通知、在场状态（成员正在编辑的内容、Agent 的范围与消息，不进项目历史、带过期）、卡片源码、渲染任务队列。`
3. `mechanism/agent.md`（三级）dry run（没有改文件）：
   - 修改前（「用户正在编辑与覆盖提示」一节最后一条）：`- 共享项目里别的成员正在编辑（跨设备），以及被覆盖的一方在下一次工具结果里得知，还没做（计划 A3）。〔裁：2026-09-30 claude/user-editing，出处 docs/plan/agent-workflow-plan.md A2〕`
   - 修改后（那一条换成下面两条，文末加一节）：
     > - 共享项目里别的成员的页面经文档服务的在场状态发布正在编辑的片段（15 秒过期，随心跳续期），编辑器进程记成另一个来源，Agent 读写到时提示「用户 <成员>正在编辑」；本机页面自己发布的那份按页面会话号认出、不重复算。
     > - 被覆盖的一方：文档服务发给它那条连接的覆盖通知按对话记下，在它下一次工具结果里带「你写的 … 被 用户 / Agent <对话>（<厂商>）覆盖了」。〔裁：2026-09-30 `claude/multi-agent`，出处 `docs/plan/agent-workflow-plan.md` A3〕
     >
     > ## 多 Agent
     >
     > - 主 Agent 用 `spawn_agent` 拉起子 Agent：新对话 ID 即新身份，登记厂商、驱动（沿用父对话）、预设角色、父对话；开一个带角色名的新页签，不抢焦点；任务作为第一条消息进它的信箱，页签空闲就发出；角色提示词每一轮拼进它的系统提示词。子 Agent 不能再拉起；同一个主 Agent 开着页签的子 Agent 至多 4 个，关掉页签才腾出名额；没有页签可开（桌面 APP 会话、编辑台没打开）时回错误。子 Agent 的创造力等级取父对话此刻生效的等级，之后也不高于父对话。
     > - 协调公告板在本机服务里、按项目一份：范围声明、改动记录、信箱。改动记录由文档服务的提交流喂，带写入身份（用户、各 Agent、共享项目里别的成员）；没接文档服务时由工具入口记。范围按「剪辑->序列」算。一个 Agent 30 分钟没动静就不算在跑，它的范围不再拿来比。
     > - 消息：收件页签空闲就作为一条用户消息发出，忙就带在它下一次工具结果里、跑完还没看到的再送；自动连锁至多 3 层，到顶的留到用户下次开口。
     > - 工具结果里带（提示在最前）：给它的消息、别人动了它声明的范围（每条一次）、它写的被覆盖了、它这次写进了别的在跑 Agent 声明的范围。
     > - 共享项目里，Agent 的范围与互发的消息经文档服务的在场状态转给其它成员（不进项目历史，范围 30 分钟过期）；文档服务不认识在场状态时停发，不报错。〔裁：2026-09-30 `claude/multi-agent`，出处 `docs/plan/agent-workflow-plan.md` A3〕

## 需要主会话决定的事

- 18 条〔裁〕主会话已认可；计划验收措辞由主会话改；`product/document-service.md` 是否补「在场状态」列给用户定；`mechanism/agent.md` 的 dry run 待定。
- 合并 `claude/multi-agent`（`--no-ff`），或返工。
- **托管端重新部署**（文档服务多了在场状态模块）由主会话做；本分支没有部署任何东西。不部署时线上只是没有跨设备提示。
- 顺带说明：我起初把几个临时脚本（`uac.py`、`comp.py`、`ml.py`、`env.py`、`roles.py`、`sp.py`、`ss.py`、`ai3.py`）直接写在会话共用的 scratchpad 根目录，后来都挪进了 `scratchpad/ma/`；若主会话在根目录原本也有同名文件，可能被我覆盖过（我没有看到先前的内容）。
