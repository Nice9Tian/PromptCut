# AGENT 报告：claude/vibe-wire（Vibe 模式开始页接业务层并成为在线缺省）

分支 `claude/vibe-wire`，从 main `99c574d7` 切出；worktree `.worktrees/vibe-wire`。端口段 6500～6519。不推送、不合并。

## 状态

账号这一路全部接通、真跑全绿；游客这一路**进项目**这一步不通，卡在 `src/editor/sync/syncManager.ts`（另一个 Agent 在修的那一处，本分支不碰），详见「没做成的」第 1 条。

## 做了什么

用户验收指出：在线编辑器开始页还是老的「云端项目 / 我创建的」表单，新界面（左侧列表栏、中间输入框、右侧拓展栏）没接业务层。本分支把 `src/start/` 这套接到真业务层，并让它成为在线构建 `/editor/` 的缺省页。

### 逐块接到哪

| 界面 | 接到的现有模块 | 文件 |
|---|---|---|
| 登录页（账号密码、游客） | `src/account/useAccountProjects.ts` 的 `login`、`enterAsGuest`、`restore`（打开页面先看官网是否已登录，问完之前显示「正在连接账号服务…」，不闪登录页）。`OnlineLogin.tsx` **一行没改**（主会话划的边界），外面套一层 `VibeLogin.tsx`，在捕获阶段认出是「提交表单」还是「游客键」、读出表单里的账号名、密码、「记住登录状态」，再在 `onDone()` 里真去做；失败时在页面右上角出错误条 | `src/start/VibeLogin.tsx` |
| 左侧项目列表 | `useAccountProjects` 的 `lists`（我创建的 / 我加入的），游客用 `guestProject`（本机记着的那一个）。进项目走它的 `open`（列表）、`openGuestProject`（游客）、`join`（链接）、直达地址自动进（`enterDirect`）；二级密码、不在名单、申请加入照它现有的处理 | `OnlineStart.tsx`、`JoinPanel.tsx`、`ProjectSidebar.tsx`、`vibeOrg.ts` |
| 「用链接加入项目」 | 原来开始页那一栏「凭链接加入」搬到顶栏右边一颗键点出的小块，业务照搬 `AccountProjects.tsx`（二级密码、链接失效、不在名单→发送申请→每 10 秒问一次→通过后自动再加入）。页面从分享链接打开时登录后自动打开、链接已填好 | `JoinPanel.tsx` |
| 中间输入框（说一句话） | 新建云端项目（`useAccountProjects.create`，名字取这句话的头 24 个字）→ 按选的画幅 `actions.setProjectMeta` 定尺寸 → 「＋ 素材」挑的文件经 `importMediaFiles`（编辑界面同一套导入）放进项目 → 进聊天页 → 这句话作为第一条消息发给云端 Agent。没登录、游客已建过项目时置灰并写原因 | `OnlineStart.tsx`、`PromptBox.tsx` |
| 聊天页 | `src/ai/cloud/useCloud.ts` 的 `useCloudChat`，做法照手机版 `src/mobile/AgentChat.tsx`：告知框（`CloudAgentConsentDialog`，第一次用时弹，「我知道了」才发）、乐观发送、断网待发、停止、共有 / 私有切换、权限（`cloudConversationControlPolicy`，只读成员、创建者看别人私有对话时不能发）。一轮回复按 `product/agent.md`「汇报」拆成「在做什么」的话 + 「Agent 操作」那一块（拆法共用 `src/mobile/agentView.ts` 的 `roundView`） | `useVibeCloud.ts`、`ChatView.tsx` |
| 侧栏「项目 Agent」 | 同一份云端对话历史列表，页面再按共有 / 私有规则复核一遍（`vibeOrg.ts` 的 `viewableChats`）：别人的私有对话不列，创建者能只读地看 | `useVibeCloud.ts`、`vibeOrg.ts` |
| 右侧拓展栏「画面」 | 编辑界面的预览 `src/editor/Preview.tsx`（`variant="mobile"`，只出画面）+ `ProbeGate`，和手机版编辑界面挂的同一套；播放、拖动走 store 的同一套动作 | `VibeStage.tsx`、`ChatSidePanel.tsx` |
| 右侧拓展栏「修改前 / 修改后」 | 这条对话里 Agent 每次新增 / 删除 / 修改留下的画面记录（`src/editor/right/ToolVisual.tsx` 的 `useVisualRecord`），读取范围按当前对话设（`setCloudVisualScope`）。取不到时写原因 | `ChatSidePanel.tsx`、`useVibeCloud.ts` |
| 「这次改动」 | 用户要求归档（`SHOW_CHANGES = false`），没接，原样关着 | — |
| 详细编辑 | 真舞台（同上）+ store 里当前项目当前剪辑的序列与片段，**只看不改**；点片段跳到它的起点，右键「引用到输入框」写成 `@卡片 名字(片段 id)`（编辑器「引用到 AI」同一写法，Agent 认得）、「在传统式里打开」；「进入传统式」调上层真正的 `onEnterEditor` | `DetailEdit.tsx` |
| 缩略图 | 这台浏览器打开过的项目记下画幅、时长和首帧（首帧取法同手机版素材格子 `useThumb`），没打开过 / 只有卡片 / 取不到就是原来的色块 | `thumbCache.ts`、`useSeenProject.ts`、`ProjectThumb.tsx` |
| 同步浮层 | 连着项目时挂 `SyncOverlays`（进项目气泡、被移出等阻断弹窗、断网未发出提示），和编辑界面同一套 | `OnlineStart.tsx` |

### 缺省与假数据

- `src/StartPage.tsx` 的 `OnlineStartPage`：去掉 `?ui=vibe` 那道门，缺省就是 `OnlineStart`。`?ui=vibe/home/login` 不再有特殊意思（`?ui=home` 不再跳过登录）。老的账号表单（`AccountProjects`）只在 `?ui=classic` 下还能打开，界面上没有入口——留着是给还认老页面的探针和排障用（见「待主会话」第 3 条）。
- `mockProjects.ts`、`mockChat.ts`、`mockTimeline.ts` **整个删掉**；原来放在里面的 `humanDuration` / `humanWhen` 挪到 `format.ts`。在线构建的产物里搜不到任何假数据字符串（「夏季上新」等）。
- 取不到数据时的空态（都不显示假数据、不白屏）：没登录 → 侧栏与那一排写「登录后列出你的云端项目」并有「去登录」；列表取不到 → 写服务端的原因 + 「重试」；列表在取 → 「正在取项目列表…」；没有项目 → 「你还没有云端项目」；托管端没有云端 Agent / 开关关着 / 只读 → 输入框置灰、下面写原因；云端执行服务没在接活 → 照编辑器右栏写「消息会持久排队，等待执行服务；重新打开可接着看。」；连接断了 → 顶上那条重连提示。

### 分组那条

「用户怎么组织项目」属一级，语义里没有分组，会话不自定。这一版做成**只记在这台浏览器里**的本地整理（`src/start/vibeOrg.ts`，localStorage 键 `pc.start.org.<acc:账号编号 | guest:游客编号>`）：新建分组、分组改名 / 删除（删分组只把项目放回「项目」，项目本身不动）、项目右键「移到「某分组」/ 移出分组」、置顶、归档（收进侧栏最下面「已归档」，那里右键取消归档）、拖着排序。项目有哪些、叫什么一律以云端列表为准，本机整理不凭空造项目，列表暂时取不到时也不丢整理信息（单测 VORG-01～07）。**没有发明任何服务端分组模型。**「分组 Agent」语义里没有，这一版去掉了（侧栏只有项目 Agent）。

### 改了哪些文件

`src/StartPage.tsx`；`src/start/` 下：改 `OnlineStart.tsx`、`ChatView.tsx`、`ChatSidePanel.tsx`、`DetailEdit.tsx`、`ProjectSidebar.tsx`、`ProjectRail.tsx`、`ProjectThumb.tsx`、`PromptBox.tsx`、`RowMenu.tsx`、`start.css`（文件末尾追加一节，已有样式一条没改）；新增 `types.ts`、`format.ts`、`vibeOrg.ts`、`vibeOrg.test.mjs`、`thumbCache.ts`、`useSeenProject.ts`、`useVibeCloud.ts`、`VibeLogin.tsx`、`VibeStage.tsx`、`JoinPanel.tsx`；删除 `mockProjects.ts`、`mockChat.ts`、`mockTimeline.ts`。另外：新增探针 `scripts/probes/vibe-start-probe.mjs`；`server/test/fixtures/account-conversation-controls-user-path.mjs` 放开 Agent 端口的白名单加一段 6500～6519（一行，只为探针能用分给本分支的端口）。

**没碰**：`src/mobile/`、`src/start/OnlineLogin.tsx`、`src/editor/sync/syncManager.ts`、`src/account/client.ts`、`src/render/cards/audioSources.ts`、`server/bakery/`（`git diff --stat 99c574d7 -- <这些>` 为空）。只读地 import 了 `syncManager` 的 `currentDocProjectId`、`forgetSharedResume`、`useSync`，和手机版 `agentView.ts` / `mainContent.ts` / `Thumb.tsx` 的纯函数与钩子。

## 验证

### 类型检查与受影响的测试

- `npx tsc -b --force` → 退出码 0，零错误。
- `node scripts/test-suite.mjs src/start/*.test.mjs src/account/*.test.mjs src/online/*.test.mjs src/layering.test.mjs`（`PROMPTCUT_NO_PORT_FILE=1`，两个 VisuHive 变量用反斜杠路径）→ 退出码 0，**288 项、288 过、0 失败、0 跳过**（含新增的 `vibeOrg.test.mjs` 7 项）。
- `npx vite build --mode online --outDir dist-online` → 退出码 0。

### 真跑一遍（`scripts/probes/vibe-start-probe.mjs`）

全在本机、全是真进程：真 VisuHive 账号服务与官网接口、账号版文档服务、独立素材服务进程、真云端 Agent HTTP 服务（夹具 `account-conversation-controls-user-path.mjs`，三个真账号 dualUser0/1/2、一个共享项目，dualUser0 是创建者），在线构建当 `/editor/`，两个舞台源；端口 6500～6509；无头 Chrome（没用桌面应用的内置浏览器窗格）。命令：

```
PROMPTCUT_NO_PORT_FILE=1 PROMPTCUT_ACCOUNT_PROVIDER_ROOT=C:\Users\admin\Documents\VisuHive PROMPTCUT_PASSWORD_ORDER_MODULE=C:\Users\admin\Documents\VisuHive\account\password-order.mjs \
  node scripts/probes/vibe-start-probe.mjs --dist dist-online --site-root C:\Users\admin\Documents\VisuHive\site
```

最后一次：退出码 1，**账号这一路（第 1～9 步）的检查全过**，不过的 4 项全在游客进项目那一步。三个页面都没有未捕获的错误，没有 5xx。逐步结果（原始记录 `AGENT-claude-vibe-wire-shots/probe-steps.log`、`probe-result.json`）：

| 步 | 结果 | 截图（`docs/reports/AGENT-claude-vibe-wire-shots/`）证明了什么 |
|---|---|---|
| 1 打开 `/editor/` | 缺省进 Vibe 登录页，没有老账号表单；「界面预览阶段」那行已藏 | `01-login.png`：缺省是新登录页 |
| 2 账号登录 | dualUser0 登录成功；侧栏与那一排是真云端项目「Shared dual account project」；页面上没有任何假数据 | `02-home-account.png`：真项目列表，顶栏是真账号名 |
| 3 点进项目 | 留在 Vibe 聊天页（没挂编辑界面），地址换成直达地址 `/editor/p/sp_…`；告知框弹出，点「我知道了」后关上 | `creator-consent.png`：告知框；空对话只有一条示例句 |
| 4 发一句话 | 自己那条气泡出现；`POST /agent/v1/conversations/:id/messages` 回 **202**；气泡写「已发出，等待云端开始处理…」，下面一行「消息会持久排队，等待执行服务；重新打开可接着看。」——这是夹具里云端 Agent 服务的**真实状态**（它收下消息、持久排队，但没挂执行器 `executorMounted` 为假），文案和编辑器右栏一字不差 | `03-chat-sent.png`：真发出、真排队提示 |
| 5 拓展栏、详细编辑 | 拓展栏挂上真预览（空项目所以是透明棋盘格，时长 00:30 是项目真时长）；详细编辑挂真预览、真时间轴（2 条序列「序列 1 / 序列 2」，项目里 0 个片段），同一时刻只挂一份舞台 | `04-chat-ext.png`、`05-detail-edit.png` |
| 5b 另一位成员 | dualUser1 登录、进同一个项目：侧栏里**看得到** dualUser0 的共有对话 | `05b-member-sees-shared.png` |
| 6 切私有 | dualUser0 点「共有」切成「私有」成功 | — |
| 9 私有之后 | dualUser1 的侧栏里那条对话**消失**（下一轮列表读取后），只剩他自己的新对话 | `09-member-no-private.png`：别人的私有对话不列 |
| 7 说一句话建项目 | 回首页地址换回 `/editor/`；挑一张图（「＋素材 · 1」）、选 9:16、说一句话 → 新项目建好、进聊天页、这句话自动发出（202 + 同上的排队提示）；新项目画面比例 `1080 / 1920`；新项目出现在侧栏 | `06-home-back.png`、`07-prompt-project-chat.png`：竖屏的真画面框 |
| 8 缩略图 | 新项目那一格是**真画面**（导入的那张蓝图，按 9:16 套在框里，时长 00:30）；没有素材的共享项目是色块 | `08-home-thumbs.png` |
| 10 游客进来 | 登录页「以游客身份进入」真进来了：顶栏「游客-1F63」，没有项目时写「游客自己能建 1 个项目」 | `10-guest-home.png` |
| 11 游客说一句话 | 项目**真建出来了**（服务端记下、本机记下），但进项目被拒：「请先登录账号。」 | `11-guest-chat.png` |
| 12 游客回首页 | 侧栏、那一排列着游客自己的项目；「新建项目」置灰（游客只能建 1 个） | `12-guest-home-project.png` |
| 13 刷新再以游客进 | 还是同一个游客「游客-1F63」，项目还列着；点进去同样「请先登录账号。」 | `13-guest-reopen.png` |

## 没做成的与原因

1. **游客进不了自己的项目**（硬要求里「游客能打开自己那一个项目」）。原因在 `src/editor/sync/syncManager.ts` 第 1525～1526 行 `enterAccountProject`：`const account = options.client.account; if (!account) throw new AccountFailure(401, 'login-required');`，而 `client.account` 对游客是 null（`src/account/client.ts` 第 228 行只回账号登录或官网账号）。这正是任务书说另一个 Agent 在修的「游客进不了项目」，两份文件都在禁改清单里，本分支没碰。界面这边已把游客身份正确传下去：游客经 `useAccountProjects.enterAsGuest` 进来、`create` 用游客身份**真建出了项目**、`openGuestProject` 走的就是同一个 `enter`；老开始页走的也是同一行，所以这不是本分支引入的。那边修好后重跑本探针，第 11、13 步应当转绿。
2. **没拿到云端 Agent 的真回复**：本机能用浏览器真登录的夹具里，云端 Agent 服务收消息、持久排队，但没挂执行器（没有模型），所以真跑看到的是「真实的排队提示」而不是回复。有执行器加模拟模型的夹具（`account-executor-visible.mjs` 等）用的是受控身份，不能从浏览器真登录。要看真回复得在托管节点上（真模型）或给账号版夹具挂一个模拟执行器，这超出本分支范围。
3. **缩略图不是「预渲染给的合成首帧」**（〔裁 vibe-wire-1〕，见下）：云端项目列表只给项目号和名字；不进项目就拿不到内容，也没有按项目取首帧快照的接口；合成画面在跨源舞台 iframe 里，父页读不到像素。现在是「这台浏览器打开过时，取最先出现的视频 / 图片素材那一帧」。要真的合成首帧，需要服务端加一个按项目取首帧快照的接口（三级以上的接口改动），列为待办。
4. **项目改名、删除云端项目**：右键菜单里置灰并悬停说明——文档服务没有改名接口；删除云端项目这一版不在开始页做。云端对话按语义没有改名入口（`workflow/production.md`「云端对话」）。
5. **侧栏只列得出此刻连着的那个项目的对话**：对话要凭这个项目的身份向云端 Agent 服务要，别的项目点进去才列。
6. 「删除对话」用的是浏览器自带的 `confirm` 框，没有做成软件内的确认框；「新建分组」用的是 `prompt`。功能对（删前确认、不能撤销），长相待定。
7. 删对话之后的气泡通知（`useCloudNotices`）这一页没挂，进传统式或手机版时照常补弹。

## 〔裁〕（本分支自己定的，用户合入前可推翻）

- **〔裁 vibe-wire-1〕（三级）缩略图来源**：见上「没做成的」第 3 条；记在 localStorage `pc.start.seen`，最多 40 个项目。
- **〔裁 vibe-wire-2〕（二级，单列）进项目留在 Vibe 聊天页**：在线浏览器里从列表点项目、凭链接加入、新建、直达地址打开，原来都直接进编辑界面（传统式）；现在进的是这个项目的 Vibe 聊天页，要自己动手点「进入传统式」。依据 `user-workflow.md`「Vibe 模式……在线浏览器登录后的默认界面」。刷新直达地址同样回到聊天页。
- **〔裁 vibe-wire-3〕（二级，单列）分组等整理信息只在本机**：见「分组那条」。
- **〔裁 vibe-wire-4〕（二级，单列）「用链接加入项目」挪到顶栏右边一颗键**：原来开始页上那一栏的位置在新界面里没有，功能照搬、位置换了。登录页上那一栏「项目链接」没有提交键（`OnlineLogin.tsx` 不能改），填了的链接登录后带进这一处。
- **〔裁 vibe-wire-5〕（三级）开始页那句话的项目名**：取这句话的头 24 个字。
- **〔裁 vibe-wire-6〕（三级）开始页那句话自动发出前等选区登记**：账号模式发消息要带这张页面的选区快照，刚进项目那一下文档服务还没登记这张页面，立刻发会被拒（`selection-page-unavailable`，真跑撞到过）；现在等选区连上后再等 2 秒才发。
- 原〔裁 V21-12〕（新界面不作缺省）按用户 2026-10-23 的推翻撤掉，`StartPage.tsx` 注释里写了。

## 要主会话合并时处理的

1. **`src/start/OnlineLogin.tsx` 该删掉的一行**：表单底下「界面预览阶段：登录不会真的发请求……」那一段（含「或者直接跳过」键）已经不是真的。本分支没改那个文件，只在 `start.css` 里用 `.ps-vibe-login .ps-login-note { display: none; }` 把它藏了；合并 Google 登录那一支时请在文件里直接删掉这一段，再去掉这条样式。顺带：那个文件头的「这一版只跑界面」「待办（业务层）」几条也该改掉。
2. **游客进项目**（「没做成的」第 1 条）：等 syncManager 那一支合进来后重跑 `scripts/probes/vibe-start-probe.mjs`。
3. **认老开始页的探针要改**：`scripts/probes/` 下有一批探针按老开始页的钩子（`[data-pc="account-projects"]`、`cloud-project-open`、`guest-enter`、`cloud-create`）点，缺省换成新界面后它们的桌面那一步会找不到元素，例如 `account-conversation-controls-probe.mjs`、`account-user-pages-probe.mjs`、`account-direct-address-probe.mjs`、`mobile-account-probe.mjs` 的第 9 步、`cloud-agent-ui-lib.mjs` 等（`grep -rln 'account-projects\|cloud-project-open\|guest-enter\|cloud-create' scripts/probes`）。最省事的改法是它们打开 `/editor/?ui=classic`；也可以改成点新界面的钩子。没有任何 `npm test` 里的测试依赖老开始页（查过 `server/test`、`src` 下的 `*.test.mjs`）。
4. 报告目录 `docs/reports/AGENT-claude-vibe-wire-shots/` 约 1.6 MB（16 张图 + 两份记录），归档时一起挪。

## 待用户项

1. **分组要不要放到服务端、跨设备同步**：现在分组、置顶、归档、顺序只记在这台浏览器里，换浏览器 / 换设备就没了，别的成员也看不到。要跨设备，得先定「用户怎么组织项目」这一条一级语义（分组属于账号还是属于项目、成员之间是否共享），再定记在文档服务还是账号服务。
2. **「分组 Agent」**（跨一个分组里几个项目的对话）语义里没有，这一版去掉了，要不要做、怎么做请定。
3. 〔裁 vibe-wire-2〕进项目留在 Vibe 聊天页、〔裁 vibe-wire-4〕「用链接加入」挪到顶栏——请确认。
4. 缩略图要不要真的做成「预渲染给的合成首帧」（需要服务端加接口）。

## 对任务书或语义的更正建议

- `docs/plan/user-decisions-2026-10-23.md` 第 5 节（〔裁 V21-12〕）应标为已被用户推翻、门已去掉，指向本报告。
- 那份决定第 4 节说「还欠一处：`workflow/production.md` 该补一节写 Vibe 模式这套界面的流程」——现在界面接上了，可以按本报告「逐块接到哪」那张表起草（一级，需用户确认后写）。
- `product/agent.md`「对话记录」与 `workflow/production.md`「云端对话」写的是 AI 栏里的历史列表；Vibe 模式里同一份列表出现在侧栏的项目底下，建议语义里补一句「Vibe 模式的侧栏列的是同一份」。
