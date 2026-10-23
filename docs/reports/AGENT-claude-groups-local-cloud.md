# AGENT 报告：本地分组与云端分组（claude/groups-local-cloud）

基准 main `84702232`。任务：氛围式侧栏的分组拆成两套，本地分组装本机草稿项目、存本地；云端分组装云端项目、存云端；互相放不进。

状态：**本地那一半与界面已做完并验证；云端那一半（存云端）只做了设计，没动服务端，等用户确认接口方案**（按「改对外接口先 dry run」）。

用户 2026-10-23 的原话（任务来源）：「分本地分组（桌面版的本地 Agent）和云端分组。云端分组存云端，本地分组存本地。本地项目放不进云端的分组（反之云端也放不进本地）。」

## 现状（动手前）

### 分组状态长什么样、存在哪、谁读谁写

- **形状**：`src/start/vibeOrg.ts` 的 `OrgState = { v:1, groups, projects, chats }`。`groups` 是 `{id,name,pinned?,archived?}`；`projects` 是 `{id,groupId,pinned?,archived?}`，数组顺序就是手排的顺序；`chats` 是项目下对话的置顶、归档标记。**一份里装着分组、置顶、归档、顺序四样**，不只是分组。
- **存哪**：浏览器 `localStorage`，键 `pc.start.org.<范围>`（`orgKey(scope)`）。读写是 `loadOrg` / `saveOrg`，包了 try/catch。
- **范围**：在线屏 `OnlineStart.tsx` 用 `viewer`，账号是 `acc:<账号编号>`、游客是 `guest:<游客编号>`；桌面屏 `DesktopStart.tsx` 固定 `desktop`（常量 `ORG_SCOPE`）。所以现状是「两屏的键本来就不同」，但**没有任何东西声明这是两套**：整理信息不标记自己属于哪一套，`moveProject` 不核对项目与分组是不是同一套，别的屏的键拷过来也会被照单全收。
- **谁读谁写**：只有两个屏幕组件（`OnlineStart.tsx`、`DesktopStart.tsx`）持有 `OrgState` 的 React state 并写盘；`ProjectSidebar.tsx` 不碰存储，只收 `groups/projects/chats` 和一组 `TreeOps` 回调；`treeState.ts` 是纯函数（置顶、排序、归档，只在同级生效）；`RowMenu.tsx` 出右键菜单。
- **项目从哪来**：在线屏是云端项目列表（`useAccountProjects` 的 `lists`，游客是本机记着的那一个）；桌面屏是本机草稿（`editor/io/drafts.ts` 的 `listDrafts`）。两边都经 `mergeProjects(org, entries, meta)` 拼出侧栏清单。
- **「放进分组」有几个入口**：**只有一个，右键菜单的「移到分组」**（`ProjectSidebar.tsx` → `ops.move` → `moveProject`）。拖拽现在**只能在同级里排序**（`onDragOver` 里 `d.kind !== spec.kind || d.sib !== spec.sib` 就不接），项目拖到分组行上本来就放不进去。任务书里说的「拖拽放进分组」目前不存在；我没有新增这个功能（那是新功能，不是这件事必需的），但把「拦住」做在唯一的底层函数里，将来加拖拽也绕不过去（见下「方案：本地那一半」）。
- **游客**：现状游客也能在这台浏览器里建分组、置顶、归档，存在 `pc.start.org.guest:<编号>`。

### 云端那一份能不能搭现成的车（调查结论：没有现成的可搭，要新开一条）

我查了账号服务（VisuHive 仓库，只读）和文档服务（`server/docservice/`、`server/account/`）里所有「跟着账号走的小块数据」：

| 候选 | 是什么 | 为什么不能直接用 |
|---|---|---|
| 账号服务的 `account_consents` 表（VisuHive `account/consents.mjs`，接口 `/api/account/cloud-agent-consent`） | 每个账号一行：云端 Agent 告知有没有点同意、告知版本号 | 单用途、定长字段，不是通用设置存储；游客没有（账号服务不认识游客，`guest-agent-unavailable`）；在另一个仓库、另一套部署；账号服务的职责是账号、密码、会话，`docs/accounts.md` 还写着「本站不另建可独立修改的项目关系账本」 |
| 文档服务的待合并表（`server/docservice/modules/pending-merge.mjs`） | 按「项目 × 用户」存，同一用户换设备看到同一份，限大小，整条替换 | 它在**项目空间**里、走 WebSocket、要先连进某个项目；分组是跨项目的账号级信息，开始页没有连任何项目。它的模型（按身份存、限大小、整条替换）值得照搬，但不能直接放进去 |
| 文档服务的账本（`server/account/ledger.mjs`，整本账是一段 JSON） | 项目存在、成员、禁入、游客撤销表 | 注释里写明热路径每秒读几十上百次、整段解析（2026-10-17 曾把节点主线程占满）；往里加每个账号一份整理信息会让它越来越大。不能往里放 |
| 通用的「账号偏好 / 用户设置」 | — | `grep preference/userSetting/accountSetting` 全仓没有相关实现，没有这种东西 |

**结论：选「文档服务新增一条账号级的小记录」**（下面「方案：云端那一半」）。理由：①云端项目列表本来就以文档服务为权威，分组是对这张列表的整理，同一个服务出；②文档服务已有一整排「带账号或游客令牌、不需要项目」的公开路由（`/hosted/shared/account/*`：create、join、session、admin、members、guest），页面已经有现成的 `request(path, body, accessToken)`，一条新路由顺着长就是；③数据放文档服务数据目录的独立文件里，不进账本；④不动账号服务、不跨仓库。

## 方案

### 本地那一半（已实现，在本分支）

核心思想：**一份整理信息属于哪一套（`realm: "local" | "cloud"`），键、内容、拼清单、放进分组四处都按它认，任何一处对不上就拒绝。**

| 规矩 | 怎么保证 | 在哪 |
|---|---|---|
| 存储键按套分开 | 键是 `pc.start.org.local.<范围>` / `pc.start.org.cloud.<范围>`，前缀不同，任何范围名撞不到对面；`saveOrg` 用整份自己的 `realm` 定键，调用方没有机会写错 | `vibeOrg.ts` `orgKey`、`saveOrg` |
| 内容带标记，读到对不上的当没记过 | 存下去的 JSON 带 `realm`；`parseOrg(raw, realm)` 读到标着另一套的整份不认；没有标记的是分套之前的老格式，按调用方要的这一套认 | `parseOrg` |
| 老数据不丢 | 新键读不到时认一次老键 `pc.start.org.<范围>`（桌面版的 `desktop`、云端的 `acc:…`），之后只写新键，老键不动 | `loadOrg` |
| 拼清单只收同一套 | `mergeProjects` 忽略 `realm` 不同的项目；`withProjects` / `withGroups` 也丢掉另一套的 | `vibeOrg.ts` |
| 放进分组只能同一套 | `moveProject(org, project, groupId)` 返回 `{ org, refused }`：跨套时整理信息**原样不动**（返回同一个对象），`refused` 是说给用户的一句（本地项目不能放进云端分组……/云端项目不能放进本地分组……）；屏幕把它放进提示栏 | `moveProject`、`moveRefusal` |
| 右键菜单里另一套的分组 | `moveTargetsFor` 把另一套的分组也列出来、置灰、悬停说明（现在每屏只有一套，用不上；侧栏将来同时有两套时，用户会想往那边放，得告诉他为什么不行，不能悄悄不列） | `moveTargetsFor` → `RowMenu.tsx` |
| 同级判断带上套 | 侧栏排序的同级键加上 `realm`，两套里的「没放进分组」不会算成同级 | `ProjectSidebar.tsx` |

类型上 `VibeGroup`、`VibeProject` 多了必填的 `realm`，`CloudEntry` 改名 `OrgEntry` 并带 `realm`（桌面屏拿它装本机草稿，叫 Cloud 是错的），所以哪里漏标会在 `tsc` 报错，不会悄悄放过。

两屏各自：

- **桌面屏**（`DesktopStart.tsx`）：本地分组，键 `pc.start.org.local.desktop`；新建分组的提示写「本地分组：只记在这台机器上，只能放本机的项目。」。
- **在线屏**（`OnlineStart.tsx`）：云端分组，范围是登录账号编号（`cloudOrgScope`）；**游客没有分组**。

### 游客怎么办（最省事又说得通的做法）

**游客没有分组，也不能置顶、归档**：新建分组置灰，悬停说「游客只有一个项目，没有分组、置顶和归档。注册一个账号后，可以用云端分组整理项目。」；置顶、归档、排序、移到分组都拦下并说同一句；整理信息一律空，不读不写任何键。

理由：①游客最多一个项目（`product/document-service.md`「游客」），分组、置顶、排序对他没有意义；②游客身份只记在这台浏览器里、不跨设备，没有地方存「云端那一份」；③游客的项目是云端项目，按用户定的规矩它不能进本地分组，那游客就没有任何合法的分组可放，所以干脆不给；④比「给游客一份只存浏览器的分组」少一整条代码路径和一个要解释的例外；⑤归档唯一的那个项目会把它藏进最下面的「已归档」，对游客是陷阱，一起拦。这是比现状（游客能在浏览器里建分组）收窄的一处，标〔裁〕，待用户审；要放宽很容易（把 `guestBlocked` 去掉并给游客一个本机范围即可，但那就违反「云端项目放不进本地分组」，所以我没这么做）。

### 云端那一半（只有设计，等用户确认）

**存哪、存什么**：存在云端文档服务，按账号一份，内容是整份 `OrgState`（带 `realm: "cloud"`）——分组、云端项目放在哪个分组、置顶、归档、手排顺序、云端对话的置顶归档，都跟着账号走（「云端分组存云端」在用户眼里是整套整理，不止分组名）。服务端把它当不透明的 JSON，只做形状与大小检查，**不认识项目**（陈旧的项目号无害；不核对成员关系）。别的账号、别的成员看不到。

**接口**（接在已有的 `/hosted/shared/account/*` 这一排，同样的 Bearer 编辑器令牌、同样的错误形状 `{ok:false, code, message}`）：

```
POST /hosted/shared/account/start-org
  请求  { op: "get" }
        { op: "put", baseVersion: <整数>, org: { v:1, realm:"cloud", groups:[…], projects:[…], chats:[…] } }
  成功  { ok:true, version:<整数>, org:<对象|null>, updatedAt:<毫秒> }
         get：没存过时 version 0、org null；put：version 是写入后的新版本
  冲突  409 { ok:false, code:"org-version-mismatch", version, org }   —— 带回云端当前那一份，页面不用再 get 一次
  拒绝  403 guest-org-unavailable（游客令牌）、400 bad-org（形状不对）、413 org-too-large、401/503 照现有
```

- 用 POST + `op` 是照现有这排路由的习惯（`create/join/admin` 都是 POST 带 `op`），也避开 GET 缓存问题。
- 身份只取令牌解出来的账号编号，**请求体里写什么身份都不收**（和现有路由一样，带 `accountId` 等字段直接 400 `invalid-authority-claim`）。
- 桌面外壳的账号桥只放行五条路由（`desktop/src-tauri/src/account_vault.rs`），这条不在其中：桌面版氛围式用本地分组，不需要它，所以**不用换外壳**。

**服务端怎么存**（三级，数字待用户定）：文档服务数据目录下独立文件 `accounts/<fileNameOf(账号编号)>.json`，用现成的 `store.writeBlob`（先写临时文件、刷盘、改名，读的一方看不到写一半的）；内存里按账号缓存一份，写时先比 `baseVersion`（比较并替换，一个账号一把串行锁），相等才写、版本加一。**不进授权账本**（理由见上面调查表）。限制建议值：整份 ≤ 256 KB、分组 ≤ 200、项目条目 ≤ 5000、对话条目 ≤ 20000、名字 ≤ 200 字符（客户端现在已经截到 200）。需要的服务端改动：
1. `server/account/authority.mjs` 把已有的内部 `verify(input)`（账号或游客令牌 → 主体，不要求项目）以一个很薄的 `identify` 暴露出来（现在只暴露了要项目号的 `authorizePrincipal`）；
2. `server/docservice/modules/account-projects.mjs` 的公开路由里加 `start-org` 一支；
3. 新文件 `server/docservice/modules/account-org.mjs`（读写、校验、比较并替换，纯函数加存储，好单测）；
4. `server/docservice/shared-service.mjs` 把存储传进去。

**怎么同步、冲突怎么办**（页面一侧，新文件 `src/start/orgSync.ts`，纯逻辑加一个很薄的 hook）：
- 打开页面、登录、页面重新可见（`visibilitychange`）时 `get`；本机缓存先顶上（`pc.start.org.cloud.<账号>` 里存 `{ org, base: {version, org}, dirty }`），打开不等网络。
- 改动先写缓存、立刻显示；防抖约 1 秒后 `put`（`baseVersion` 用缓存里的 `base.version`）。
- 遇到 409：对 **base（上次从云端拿到的）、mine（我这边现在的）、theirs（409 带回的）做三方合并**再重试：分组、项目、对话条目按 `id` 对齐；字段（名字、`groupId`、`pinned`、`archived`）谁改过听谁的，两边都改同一字段时我这边的赢；增是并集；删是「对方没改过才算删」；顺序——我这边动过顺序就用我的（对方新增的排最前、对方删掉的去掉），没动过就用对方的。同一个人在两台设备上同时改，才会走到这里，不求花哨，求不丢东西。
- 同一次写的回包丢了、重发：重发时 `baseVersion` 已经落后，409 带回的就是我刚写的那份，三方合并结果和云端一样，等于什么都没发生，不需要请求号。
- 离线、服务报错、旧文档服务还没这条路由（404）：缓存里标 `dirty`，界面说「云端分组没同步上，改动先记在这台浏览器里，联网后自动补」；之后每次改动、页面可见、`online` 事件都重试，退避；不丢、不弹窗打断。
- 清理：写出去之前，把「这次成功拿到的项目列表里已经没有、又没任何整理信息（没分组、没置顶、没归档）」的条目去掉，免得云端那份只增不减；列表取不到的那一次不清理。
- 不做推送：另一台设备的改动在这台下次打开或重新可见时看到。分组不是实时协作的东西，这是有意的。

**界面上云端那一套怎么说话**：`CLOUD_ORG_IN_CLOUD`（`vibeOrg.ts`）现在是 `false`：云端分组此刻仍只是这台浏览器里的缓存，界面如实写「暂时只记在这台浏览器里」，不假装已经跨设备。接上服务端时改成 `true`，文案自动变成「存在云端，换设备也能看到」，再加一行同步状态。

**确认之后的活（我估计的清单，约一个小阶段）**：服务端四处改动 + 服务端单测（存取、比较并替换、409、大小限制、游客 403、不能读别人的、重启后还在）；`src/account/client.ts` 加 `startOrg()` 两个方法（含 `AccountFailure` 的中文提示）；`orgSync.ts` 与三方合并单测；`OnlineStart.tsx` 接上同步状态；一条真浏览器探针（两个页面上下文、同一账号，改名后另一边刷新能看到）；服务端要部署到托管节点，按 `verification.md` 的「真实网络验证」只在部署时跑一次。

**需要用户定的几点**：①整份整理信息（含置顶、归档、顺序、对话标记）都上云，还是只上分组与项目归属——我的建议是都上，否则「换设备看到的置顶和归档不一样」更别扭；②游客没有分组这一条（见上）；③限制数字；④冲突用三方合并，还是更省事的「后写的赢」——我的建议是三方合并，代价是多一个约 120 行的纯函数加测试。

## 改了哪些文件（本分支，均在 worktree 内）

- `src/start/types.ts`：加 `OrgRealm`；`VibeGroup`、`VibeProject` 加必填 `realm`；文件头说明改成两套。
- `src/start/vibeOrg.ts`：`OrgState` 带 `realm`；`emptyOrg`、`orgKey(realm, scope)`、`LOCAL_ORG_SCOPE`、`cloudOrgScope`；`parseOrg/loadOrg/saveOrg` 按套读写并认老键；`mergeProjects/withProjects/withGroups` 只收同一套；`moveProject` 返回 `{org, refused}`；`moveRefusal`、`moveTargetsFor`、`groupsOf`、`orgWhereText`、`groupNoteText`、`CLOUD_ORG_IN_CLOUD`；`CloudEntry` 改名 `OrgEntry`。
- `src/start/ProjectSidebar.tsx`：「移到分组」用 `moveTargetsFor`；同级键带 `realm`；新增 `groupNote`、`newGroupBlocked` 两个属性（「新建分组」的悬停说明与置灰）。
- `src/start/RowMenu.tsx`：`moveTargets` 项可带 `blocked`，置灰并悬停说明。
- `src/start/DesktopStart.tsx`：本地分组（`loadOrg("local", LOCAL_ORG_SCOPE)`）、项目标 `local`、`ops.move` 走 `moveProject` 并把拒绝说明放进提示栏、文案。
- `src/start/OnlineStart.tsx`：云端分组（范围是账号编号）、项目标 `cloud`、游客没有分组（`guestBlocked`）、`ops.move` 同上、文案走 `orgWhereText`。**没有碰 `openProject(id, intoClassic)` 那条路**（本分支基准里它还是 `openProject(id)`，我一个字没动）。
- `src/start/start.css`：加一行 `.ps-row:disabled`（新建分组置灰的样子）。
- `src/start/vibeOrg.test.mjs`：原有 7 条用例照旧，只把构造数据补上 `realm: 'cloud'`、`emptyOrg('cloud')`、`moveProject` 新签名，**断言一条没改**。
- `src/start/orgRealm.test.mjs`（新）。
- `docs/reports/AGENT-claude-groups-local-cloud.md`（本文件）。

没碰：`server/bakery/` 七个文件、`src/render/createSnapshot.ts`、`src/render/snapshot/*`、`src/render/snapshotRename.ts`、`src/render/gl/canvasGrab.ts`（`git diff --stat` 里没有它们）。`treeState.ts` 与 `treeState.test.mjs` 没改。

## 验证

均在 worktree `C:\Users\admin\Documents\PromptCut\.worktrees\groups-local-cloud` 跑，端口只用 5960、5964（带 `PROMPTCUT_NO_PORT_FILE=1`），用完已停。

- `npx tsc -b --force`：退出码 0，零错误。
- `npm test -- src/start/format.test.mjs src/start/vibeOrg.test.mjs src/start/treeState.test.mjs src/start/orgRealm.test.mjs`：29 条通过、0 失败（`✓ npm test 最终结果：零失败`）。其中 `treeState.test.mjs` 8 条、`vibeOrg.test.mjs` 7 条（VORG-01～07，照过）、`format.test.mjs` 6 条、新增 `orgRealm.test.mjs` 8 条。
- 影响范围说明：`src/start/` 下的全部测试文件都跑了；仓库里只有 `src/start/*.test.mjs` 引用这些文件（grep 过）；没有改渲染，不跑导出确定性与快照重放。

**新增测试**（`src/start/orgRealm.test.mjs`，跑法 `npm test -- src/start/orgRealm.test.mjs`）：

| 名字 | 盯什么 |
|---|---|
| ORGR-01 | 本地分组只收本机项目：混进云端项目不出现；硬塞进写回清单也进不了本地那一份 |
| ORGR-02 | 云端分组只收云端项目：混进本机草稿不出现；本地的分组也进不了云端那一份 |
| ORGR-03 | 跨着放被拦住并给出说明（两个方向各一句不同的话），整理信息原样不动（同一个对象）；「移出分组」对跨套也不碰 |
| ORGR-04 | 右键「移到分组」：另一套的分组置灰并带说明，归档的、已在的不列，已在分组里多一项移出 |
| ORGR-05 | 两套的存储键互不覆盖：前缀不同、范围名取成对面的样子也不撞；同一范围名各存一份互不盖掉；桌面一份、账号各一份读回来各是各的；存下去的内容带 `realm` |
| ORGR-06 | 云端的内容躺进本地的键、或反过来，读出来是空的 |
| ORGR-07 | 分套之前的老键认一次、之后只写新键、老键不动 |
| ORGR-08 | 游客没有范围：读不到、也存不了，不写任何键 |

**真浏览器走查**（无头 Chrome，看了截图，没有控制台错误）：

- 桌面屏（`?ui=vibe`，本 worktree 的 vite 5960）：新建分组弹窗里是「本地分组：只记在这台机器上，只能放本机的项目」；新建一个本机项目后右键出现「移到「素材组」」，点了之后 `localStorage` 里只有 `pc.start.org.local.desktop`，内容 `{"v":1,"realm":"local",…,"projects":[{"id":"20261023-weuzoa","groupId":"g-…"}]}`；刷新后分组「素材组，1 个项目」还在。截图 `…\scratchpad\shot4-menu.png`、`shot4-after.png`。
- 在线屏（`VITE_PC_ONLINE=1` 的 vite 5964，**账号与项目列表接口用 puppeteer 拦截请求造的假数据**，没有连真账号服务）：登录后侧栏列出两个云端项目；新建分组提示是「云端分组：暂时只记在这台浏览器里，只能放云端的项目」；移进分组后只有 `pc.start.org.cloud.acc:acc_…`，`realm:"cloud"`；置顶后提示「置顶只在自己同级里生效，暂时只记在这台浏览器里。」；刷新后还在。游客（假的游客令牌接口）：新建分组置灰、悬停是游客那句，没有写任何 `pc.start.*` 键。截图 `shot5-account.png`、`shot6-guest.png`。
- 没跑：`scripts/probes/vibe-start-probe.mjs`（真账号服务那一整套）：它写死了端口 6500～6509，要十个端口；我这一段 5960～5969 里 5961～5963、5966～5968 被**不是我启动的**进程占着（pid 23916 的 `vite --port 5961`、pid 2268），我没动它们。所以用上面「拦请求造假数据」的办法验了在线屏的列表、分组、游客三条路。`scripts/probes/vibe-desktop-probe.mjs` 要真的 Tauri 桌面壳，没跑；桌面屏用浏览器里的同一份页面代码验了。云端存储没做，所以也没有「换设备看到」的验证。

## 没做成的与原因

1. **云端分组真的存云端**：按任务书的停点，需要新开接口，先 dry run 等确认；设计见上。
2. **拖拽放进分组的入口**：现状没有这个入口（只能同级排序），没有新增；底层函数已经拦住，将来加拖拽也绕不过。
3. **侧栏同时出现两套分组**的界面（比如桌面版既有本地项目又有云端项目）：这一版每屏只有一套；`moveTargetsFor`、`realm` 标记、同级键都已经按「将来会同时有」留好，但没有这样的界面，所以「另一套的分组置灰」这条在界面上看不到，只有单测覆盖（ORGR-04）。
4. 真账号服务的在线探针没跑（见上）。

## 对任务书与语义的更正建议

- 任务书写的「拖拽、右键『放进分组』这些入口都要拦住」：现状只有右键一个入口，已拦；见上。
- 端口段 5960～5969 里有他人的进程（5961～5963、5966～5968），建议主会话核对是不是别的分支也分到了这一段。
- 语义里至今没有「分组」「置顶」「归档」的任何一句（`grep 分组 docs/semantics` 只有 `mechanism/agent.md` 讲 AI 栏会话的无关用法）；这次把两套分组的规矩写进语义是一级加二级的新增，下面拟稿。

## 语义修改前 / 修改后（拟稿，未落笔，等用户过目）

**一、一级（用户怎么操作）**

1. `user-workflow.md`「工作方式」表里氛围式那一行：
   - 修改前：（没有提整理项目）
   - 修改后（在氛围式那一行末尾加一句）：「侧栏里可以把项目整理进分组、置顶、归档、手排顺序。分组分两套：**本地分组**（桌面版的氛围式，装本机的项目）和**云端分组**（在线浏览器的氛围式，装云端项目）；两套互相放不进，本地项目不能放进云端分组，云端项目不能放进本地分组（2026-10-23 用户定）。游客只有一个项目，没有分组。」
2. `glossary.md` 新增两条（一级）：
   - **本地分组**：桌面版氛围式侧栏里的分组，只装本机草稿项目，存在本机。
   - **云端分组**：在线浏览器氛围式侧栏里的分组，只装云端项目，存在云端，跟着账号走，换设备也能看到；游客没有。

**二级（系统承诺什么）**

3. `product/document-service.md`「职责」里加一条：
   - 修改前：（没有）
   - 修改后：「**账号级整理信息**：云端文档服务替每个网站账号保存一份整理信息——云端分组、云端项目放在哪个分组、置顶、归档、手排顺序，只有这个账号自己读写，别的成员看不到；游客没有。它只是对项目列表的整理，不改变项目存在状态、创建者、成员（这些仍以文档服务的项目记录为准）。两台设备同时改时按改动项合并，不整份覆盖。（2026-10-23 用户定「云端分组存云端」）」
4. `product/platforms.md` 在线浏览器、桌面版两节各加一句：在线浏览器的氛围式用云端分组、桌面版的氛围式用本地分组，桌面版不提供云端分组（桌面版氛围式只管本机项目）。

**三级（具体机制）**

5. `mechanism/document-service.md` 新增「账号级整理信息」一节：接口 `POST /hosted/shared/account/start-org`（`get` / `put`）、版本号比较并替换、409 带回云端当前份、文档服务数据目录下 `accounts/<编号>.json`、不进授权账本、各项大小限制（建议值：整份 256 KB、分组 200、项目条目 5000、对话条目 20000）、游客令牌回 `guest-org-unavailable`；页面一侧的三方合并规则、缓存与重试。
6. `mechanism/platforms.md`：本机存储键 `pc.start.org.local.desktop` 与 `pc.start.org.cloud.<账号>`（缓存）的约定、分套之前老键认一次。
