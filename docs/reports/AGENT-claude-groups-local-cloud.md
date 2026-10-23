# AGENT 报告：本地分组与云端分组（claude/groups-local-cloud）

基准 main `84702232`。任务：氛围式侧栏的分组拆成两套，本地分组装本机草稿项目、存本地；云端分组装云端项目、存云端；互相放不进。

状态：**本地那一半与云端那一半都已做完并验证**（云端那一半是协调者按我的方案裁定后接着做的，裁定 V22-05～09 记在 `docs/plan/release-021-rulings.md`：整份上云、游客没有分组、上限按我提的数、三方合并、接口照我的方案开）。服务端**尚未部署**（见「没做成的」）。

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

### 云端那一半（已实现，在本分支）

**存哪、存什么**：存在云端文档服务，按账号一份，内容是整份 `OrgState`（带 `realm: "cloud"`）——分组、云端项目放在哪个分组、置顶、归档、手排顺序、云端对话的置顶归档，全部跟着账号走（V22-05）。服务端把它当不透明的 JSON，只做形状与大小检查，**不认识项目**；别的账号看不到；游客令牌一律拒。

**接口**（接在已有的 `/hosted/shared/account/*` 这一排，同样的 Bearer 编辑器令牌、同样的 `{ok:false, code, message}` 错误形状）：

```
POST /hosted/shared/account/start-org
  请求  { op: "get" }
        { op: "put", baseVersion: <整数>, org: { v:1, realm:"cloud", groups, projects, chats } }
  成功  { ok:true, version, org, updatedAt }       get 没存过：version 0、org null
  冲突  409 { ok:false, code:"org-version-mismatch", version, org, updatedAt }   带回云端当前那一份
  拒绝  403 guest-org-unavailable（游客）、400 bad-org（形状不对 / baseVersion 不是整数 / 不认识的 op）、
        413 org-too-large（超限）、503 org-unavailable（这台部署没配存储）、401 照现有；
        请求体里带 accountId 等身份字段一律 400 invalid-authority-claim（沿用这一排路由已有的检查）
```

**服务端**（三级机制，上限按 V22-07）：

- `server/docservice/modules/account-org.mjs`（新）：`checkOrg`（形状与大小检查，**只保留已知字段**，多余的丢掉）、`createAccountOrgStore`（`get` / `put`，版本号比较并替换）。上限：整份 ≤ 256 KB、分组 ≤ 200、项目条目 ≤ 5000、对话条目 ≤ 20000、名字与编号 ≤ 200 字符。存储接口是同步的、Node 单线程，读-比-写之间不会插进别的请求，所以不需要另加锁。
- 文件是文档服务数据目录下的 `accounts/<账号编号>.json`（`store.writeBlob`：先写临时文件、刷盘、改名），**不进授权账本**。内容里带账号编号，文件被换成别人的读出来当没有，不把别人的整理信息给出去。
- `server/account/authority.mjs`：暴露一个很薄的 `identify(input)`，回 `{ accountId, guest }`（内部用已有的 `verify`；验完把验证时临时记的授权引用丢掉，不给高频调用留垃圾）。
- `server/docservice/modules/account-projects.mjs`：公开路由加 `start-org` 一支；`mountAccountProjects` 多收一个可选的 `orgStore`，没传就 503 `org-unavailable`（所以别的部署、旧测试不受影响）。409 单独回，带 `version`、`org`。
- `server/hosted/combo.mjs`：把 `createAccountOrgStore({ store: createFileStore({ dir: paths.docservice }) })` 传给公开那份 `mountAccountProjects`（内部 mTLS 那份不挂，账号服务不碰它）。

**客户端**：

- `src/account/client.ts`：`getStartOrg()`、`putStartOrg(baseVersion, org)`（只在线、只账号；游客在客户端就抛 `guest-org-unavailable`；409 当结果返回而不是抛；`AccountFailure` 多带服务端整个回包 `body`）；错误提示补了五条中文。
- `src/start/orgMerge.ts`（新，纯函数）：**三方合并** `mergeOrg(base, mine, theirs)`。规则：字段只我改听我的、只对方改听对方的、两边改同一字段我的赢；增取并集（同编号两边都加，整条听我的）；删——一边删、另一边没改过才算删，改过的留下；顺序——我动过用我的，没动过用对方的，另一边新增的条目插在它在那一边的前一个邻居后面（所以「新建分组」仍在最后、「新出现的项目」仍在最前，这比方案里写的「对方新增的排最前」更准，已按它实现）；连带——对方删了某个分组而我把项目放进了它，项目回到「没放进分组」。
- `src/start/orgSync.ts`（新）：同步引擎，网络、存储、计时器都注入，不碰 React，所以可以单测。本机缓存优先；拉（打开、登录、重新可见、网络恢复）；改动防抖 1 秒后传；传的过程中又有新改动则传完再排一次；409 用带回的那份三方合并后重传（最多 5 次）；离线、5xx → `pending`，间隔 2 秒起逐次加倍到 60 秒封顶；**老服务端（404 / 405 / 501 / no-route / org-unavailable）→ `unsupported`：不报错、不重试，改动留本机，下次打开页面再探一次**；云端比本机记的版本还旧（云端被重置）→ 以云端为出发点把本机整份再传；**一台设备第一次连云端、本机已有云端存储接上之前做的分组时，当作「有没传的改动」和云端那份取并集**，不会被另一台设备传上去的那份顶掉。同步记录（`{version, base, dirty}`）和整理信息分两个键存本机（`pc.start.orgsync.cloud.<账号>`）。
- `src/start/orgTransport.ts`（新）：把客户端接成引擎要的传输，只负责把「没有这条路由」翻成 `OrgUnsupportedError`。
- `src/start/useCloudOrg.ts`（新）：React 一层，持有整理信息 state、写本机缓存、驱动引擎、监听页面重新可见与 `online` 事件。
- `src/account/useAccountProjects.ts`：多给一个稳定的 `orgApi`。
- `src/start/OnlineStart.tsx`：用 `useCloudOrg`；项目列表取到后清理（`pruneOrg`：列表里已经没有的项目、没有任何整理信息的条目去掉，对话跟着去掉，云端那份不会只增不减；列表没取到不清）；`orgStatus === "pending"` 时侧栏分组卡里多一行「云端分组没同步上：改动先记在这台浏览器里，联网后自动补上。」；探到老服务端时「存在云端」改口成「暂时只记在这台浏览器里」。
- `src/start/vibeOrg.ts`：`CLOUD_ORG_IN_CLOUD` 翻成 `true`；`orgWhereText(realm, inCloud)`、`groupNoteText(realm, inCloud)` 多一个参数；界面那句现在是「存在云端，换设备也能看到」。
- `src/account/joinRequest.test.mjs`（原有守门测试 JRC-7）：把 `start-org` 登记进「只在线路由」清单（和 `guest` 同一条先例：外壳账号桥只放行五条路由，这条只给在线浏览器、桌面版氛围式用本地分组，所以**不用换外壳**）；那条测试同时核对发这条请求前有 `options.online` 的挡板，客户端里有。

## 改了哪些文件（本分支，均在 worktree 内）

本地那一半与界面（第一批提交）：`src/start/types.ts`、`vibeOrg.ts`、`ProjectSidebar.tsx`、`RowMenu.tsx`、`DesktopStart.tsx`、`OnlineStart.tsx`、`start.css`（一行）、`vibeOrg.test.mjs`（断言没改，只补 `realm` 字段与新签名）、`orgRealm.test.mjs`（新）。

云端那一半（第二批提交）：

- 服务端：`server/docservice/modules/account-org.mjs`（新）、`account-projects.mjs`、`server/account/authority.mjs`（加 `identify`）、`server/hosted/combo.mjs`（传 `orgStore`）。
- 客户端：`src/account/client.ts`、`useAccountProjects.ts`、`src/start/orgMerge.ts`、`orgSync.ts`、`orgTransport.ts`、`useCloudOrg.ts`（均新）；`vibeOrg.ts`、`OnlineStart.tsx`、`ProjectSidebar.tsx`（加 `groupStatus` 一行）。
- 测试与探针：`server/test/account-org-route.test.mjs`、`src/start/orgMerge.test.mjs`、`orgSync.test.mjs`、`orgTransport.test.mjs`（均新）；`orgRealm.test.mjs`（加 ORGR-09、10）；`src/account/joinRequest.test.mjs`（JRC-7 清单加一条）；`scripts/probes/vibe-groups-cloud-probe.mjs`（新，真服务端双设备探针）。

没碰：`server/bakery/` 七个文件、`src/render/createSnapshot.ts`、`src/render/snapshot/*`、`src/render/snapshotRename.ts`、`src/render/gl/canvasGrab.ts`；`treeState.ts`；`OnlineStart.tsx` 里 `openProject` 那条路一个字没动。

## 验证

均在本 worktree 跑；端口只用 5960、5964（vite）、5969（探针里的服务端），用完已停；带 `PROMPTCUT_NO_PORT_FILE=1`；账号服务测试设了 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT`、`PROMPTCUT_PASSWORD_ORDER_MODULE` 指到本机 VisuHive 仓库。

- `npx tsc -b --force`：退出码 0，零错误。
- 与改动直接相关的测试：
  - `npm test -- server/test/account-org-route.test.mjs`：8 条全过。
  - `npm test -- src/start/orgMerge.test.mjs src/start/orgSync.test.mjs src/start/orgTransport.test.mjs src/start/orgRealm.test.mjs src/start/vibeOrg.test.mjs src/start/treeState.test.mjs src/start/format.test.mjs`：全过（orgMerge 7、orgSync 12、orgTransport 3、orgRealm 10、vibeOrg 7、treeState 8、format 6）。
- 影响范围里更大的一批：`server/test/account-*.test.mjs` + `src/account/*.test.mjs` + `src/start/*.test.mjs` + `src/layering.test.mjs`，一次跑 447 条，438 过、1 跳过、**8 败**。
  - **7 条是环境问题、基线上就败**：`server/test/account-v2-install-plan.test.mjs` 的 7 条（报 `Error: vh-source`，找不到 VisuHive 源码布局）。我在基线 `84702232` 上单独建了一个临时 worktree 跑同一个文件，同样 7 条败、1 条过，跑完已删。
  - **另 1 条是 JRC-7**（外壳放行清单的守门测试）：它扫到页面代码里多了 `start-org` 这条外壳不放行的路由，红得对。我把它登记进「只在线路由」清单（理由见上，和 `guest` 同一条先例），并把客户端里一条注释里写到的全路径改掉，让它的「发请求前必须有 `options.online` 挡板」那一检也过；重跑 `src/account/joinRequest.test.mjs`：7 条全过。
- 改到 `server/hosted/combo.mjs`（挂载）与 `authority.mjs`（加 `identify`），所以另跑了引用它们的测试：`asset-wiring-integration`、`hosted-render-capacity`、`hosted-render-identity`、`invite-impl`、`local-origin`、`move-guard`、`reopen-hosting`、`reopen-relocation-files`，连同 `joinRequest`：71 条全过、0 败（`✓ npm test 最终结果：零失败`）。
- 新增测试名与盯的东西：
  - `account-org-route.test.mjs`：ORG-1 get/put 往返与版本递增；ORG-2 版本冲突回 409 且带回云端那份、不写、用带回的版本重传就成；ORG-3 超大小与超条数（分组、项目、对话各一）413、形状不对 400、被拒的不改云端；**ORG-4 游客令牌被拒 403 且不落文件**（存储层自己也拒）；**ORG-5 别的账号读不到你的那份**、请求体里写别人的账号编号 400；ORG-6 落在数据目录下独立文件、重开存储还在、文件被换成别人的内容当没有；ORG-7 没配存储 503、没 Bearer 401、不认识的 op 400；ORG-8 只存已知字段。
  - `orgMerge.test.mjs`：ORGM-01 两边各加一个分组；ORGM-02 两边改同一个项目的归属（我的赢）、改不同字段（两边都留）；ORGM-03 一边删一边改（改过的留下、没改过才删、删分组连带项目回到没放进分组）；ORGM-04 顺序；ORGM-05 没有 base；ORGM-06 对话按项目+对话对齐；ORGM-07 回包丢了原样重传幂等、输入不被原地改。
  - `orgSync.test.mjs`：SYNC-01～11（第一次连上整份上传、采用云端、防抖、先拉后合并、拉传之间 409、离线退避与补传、**老服务端安静退回**、传的过程中又改、云端被重置、stop、两台设备首次连云端取并集、同步记录读写）。
  - `orgTransport.test.mjs`：TRN-01～03（老服务端 404 → `unsupported` 不抛；网络错 → `pending`）。
- **真服务端双设备探针**（`scripts/probes/vibe-groups-cloud-probe.mjs`，在我这一段端口里跑通，退出码 0，最后一行 `{"ok":true,"steps":11,"fails":[]}`）：服务端是真的 `mountAccountProjects` + 真权威 + 真整理信息存储（临时目录），只有账号服务那三个接口是页面请求拦截造的假数据。结果：
  - 设备甲建分组「客户组」并把项目放进去，服务端真存下了（`version 1`）；
  - **设备乙（全新浏览器上下文）登录后侧栏直接是「客户组，1 个项目」**（换设备能看到）；
  - 两台设备各改一处不刷新（甲新建「第二组」、乙给另一个项目置顶），服务端 `version 3`，两处改动都在，两边刷新后看到同一份；
  - 老服务端（路由 404）下页面没有提示条、没有脚本错误、分组照常能建、提示改口成「暂时只记在这台浏览器里」；
  - 云端 503 时侧栏出现「云端分组没同步上：…」，断线期间服务端没有这条、界面上还在；恢复后自动补上、提示消失。
  - 看了截图（`…\scratchpad\shots\2-B-sees-group.png`、`5-C-pending.png` 等六张），没有页面脚本错误。
- 没跑：`vibe-start-probe.mjs`（真账号那一整套，6500～6509 十个端口，不在我这一段；协调者说整套验收会跑它）、`vibe-desktop-probe.mjs`（要真 Tauri 桌面壳）。没有改渲染，不跑导出确定性与快照重放。真实网络验证（节点上）没做：服务端没部署。

## 没做成的与原因

1. **服务端没有部署到托管节点**：`start-org` 只在本分支的代码里，线上的文档服务还是老的。**部署前**线上页面碰到它回 404，已验证安静退回「只记在这台浏览器里」，不会报错；部署后才真正跨设备。部署要重启文档服务，按 `verification.md` 的「真实网络验证」在节点上跑一遍（测试账号：A 设备建分组、B 设备看到），这一步需要用户同意部署，我没做。
2. **拖拽放进分组的入口**：现状没有，没有新增；底层函数已经拦住。
3. **侧栏同时出现两套分组的界面**：这一版每屏只有一套；`realm` 标记、置灰的「另一套的分组」、同级键都已留好，只有单测覆盖（ORGR-04）。
4. **服务端限流**：`start-org` 没有单独限流（和 `create/join/admin` 一样靠令牌核对、请求体 1 MB 上限）；每次保存是一次文件写。防抖 1 秒、页面可见时才拉，正常用量很小；要防恶意账号狂写可以另加一道，这是新增的三级机制，我没擅自加。
5. 真账号服务的在线探针没跑（见上）。

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
