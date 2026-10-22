# AGENT 报告：claude/conflict-merge（0.7.19 冲突合并窗口）

分支 `claude/conflict-merge`，从 main `ca4fc432` 切出；worktree `.worktrees/conflict-merge`；端口段 5890～5899（探针用了 5890～5897）。

任务：固定非本机快照、断网保留（在线浏览器落盘至浏览器本地缓存）、重连后逐项合入面板——做出共用的「冲突合并」窗口。
语义出处：`workflow/editing.md`「撤销、重做」、`workflow/project.md`「暂时离线项目与保存」、`product/document-service.md`「冲突」「离线」、`mechanism/document-service.md`「保存基准与修改状态检查」。语义文档一字未改。

## 一、做了什么（逐文件）

### 新文件

| 文件 | 内容 |
|---|---|
| `src/editor/sync/mergeItems.ts` | 逐项引擎（纯函数）。`diffThings(基准, 我这边)` 按「东西」分组、按属性去重，产出待合并的东西；`mergeRows(当前项目, 表)` 现算每个二级项冲突不冲突、云端现在是什么、给人看的那句话；`applyMerge` 把选中的二级项照我这边写进项目（增删两个方向、云端已删时恢复、新增连带序列 / 剪辑 / 素材、同一序列放不下不硬塞）；`staleSelections` 做「每次点合并重新核对」；勾选的几个纯函数（选中无冲突项、一级全勾 / 部分 / 没勾等）。 |
| `src/editor/sync/offlineTransfer.ts` | 离线批次 → 待合并的东西：本地副本按待确认队列的逆操作倒退得到基准，再和本地副本比。 |
| `src/editor/sync/mergeTable.ts` | 页面这一侧的待合并表：本机副本 + 待发队列，连上文档服务按顺序交、再以文档服务为准；同一用户别的设备改了表时收推送。 |
| `src/editor/sync/offlineCache.ts` | 浏览器本地缓存：IndexedDB（取不到退 localStorage、再退内存），键按「项目 × 用户」。 |
| `src/editor/sync/useConflictMerge.ts` | 桌面窗口与手机面板共用的界面状态（两级列表、勾选、合并、删除选中、「刚被别人改过」的取消勾选）。 |
| `src/editor/sync/ConflictMerge.tsx` | 桌面的「冲突合并」窗口，与导航栏顶端的「冲突合并」按钮。 |
| `src/editor/sync/useImportOffline.ts` | 在线浏览器断网时「导入媒体」置灰的 hook（判据是 `onlineStatus.ts` 的纯函数 `importOfflineOf`）。 |
| `src/mobile/conflictMerge.css` | 手机版面板里演示稿有、`mobile.css` 还没有的那几条样式（`.cf-top`、勾选框）。 |
| `server/docservice/modules/pending-merge.mjs` | 文档服务的待合并表模块：`merge.list` / `merge.put` / `merge.remove`，按「项目 × 用户」存，独立于项目 JSON，落盘，同用户多连接推送。 |
| 测试 | `src/editor/sync/mergeItems.test.mjs`（MI-01～12）、`src/editor/sync/offlineMerge.test.mjs`（OM-01～06）、`server/test/pending-merge.test.mjs`（PM-01～07） |
| 探针 | `scripts/probes/conflict-merge-probe.mjs`（桌面 + 手机两套界面走一遍、截图；见第五节） |

### 改的文件

| 文件 | 改了什么 |
|---|---|
| `src/editor/sync/syncManager.ts` | 界面状态加 `merge`（待合并表）、`mergeOpen`；`bind` 按「项目 × 用户」挂待合并表（本机空间 `local`、口令项目 `user:<名>`、账号项目 `account:<号>`），在线时接到连接上；DocSync 停下（离线批次被拒）时 `transferOffline`：逐项转进待合并表、当场整批回退到云端现状、打开窗口；`mergeSelected` / `deleteSelected`；账号云端项目的离线批次落盘到浏览器本地缓存（`watchBrowserJournal`），进项目前恢复（`restoreBrowserJournal`）；`merge.state` 推送接到表上；转表那一下的整批备份不弹「已丢弃」气泡。 |
| `src/editor/sync/SyncChips.tsx` | 导航栏顶端加「冲突合并」按钮（有待处理项就显示，断网、恢复中也显示）。 |
| `src/editor/sync/SyncOverlays.tsx` | 挂上冲突合并窗口；离线时的离开确认只在离线批次还没存进浏览器本地缓存时才拦。旧的整份「加进去 / 不要了」离线对话框留作退路（离线批次算不出基准时才会出现）。 |
| `src/editor/sync/onlineStatus.ts` + `onlineSync.test.mjs` | 离线常驻提示改字（原「关闭页面将丢失这些操作」不再成立，见第六节第 7 条）；加 `importOfflineOf`。 |
| `src/editor/sync/sync.css` | 窗口与按钮的样式（只用 `--ui-*` 变量）。 |
| `src/mobile/sheets.tsx` | `ConflictSheet` 换成逐项机制（同桌面一套）；`useConflicts` / `conflictBarText` 签名不变（`MobileEditor.tsx` 不用改）；素材库面板的两处导入断网置灰。 |
| `server/docservice/shared-service.mjs` | 每个空间挂上待合并表模块（4 行）。 |
| `src/editor/left/LibrarySection.tsx` | **越界（清单外）**：桌面素材库的「导入媒体」按钮断网置灰、提示「当前离线」。在线浏览器的桌面界面导入入口只在这个文件里，不改做不到第 6 条；改动 8 行，只接 `useImportOffline`。 |

没碰：`src/online/**`、`cardRunStates.ts`、`costs.mjs`、`render-node`、`bakery`、低内存档与三道闸门相关文件、`playback-probe.mjs`、`docs/plan/**`、`docs/semantics/**`、`src/mobile/MobileEditor.tsx`、`src/store/docsync.ts`（只用它的公开接口：`recoveryJournal`、`discardOffline`、`mergeOffline`、`restoreJournal`）。

## 二、待合并表的存储形状

- **一条记录 = 一样东西**（`MergeThing`）：`{ key, source, batch, baseRev, at, ref, change, label, base, mine, props: [{ prop, base, mine }] }`。
  - `key` = `<来源>:<东西的键>`，东西的键：片段 `clip:<id>`、字幕 `caption:<片段id>:<行的身份>`、项目设置 `settings`、序列 `track:<id>`、剪辑 `cut:<id>`、转场 `tr:<id>`、库条目 `lib:<集合>:<id>`。同一来源同一样东西只有一条；后来的离线批次并进去，同一属性以新的为准（「同一属性只列一条」跨批次也成立）。
  - `change`：`modify` / `add` / `delete`；增删的二级项是整件（属性记 `""`）。`base` / `mine` 是整件值（新增、删除、云端已删时恢复用），值用 `{ v }` 包一层，`null` 表示这一份里没有它。
  - **冲突与「云端现在是什么」不入表**：显示和点「合并」时拿当时的项目现算，所以每次合并天然是对着最新云端核对。
- **文档服务**：模块 `merge`，挂在每个空间的存储上，按项目落在 `merges/<项目号>`（账号 / 口令项目在 `<数据目录>/tenants/<项目号>/merges/`），一个用户一条记录 `{ projectId, user, version, things, at }`；项目删了随空间目录一起删。
  - **用户只取连接身份**：账号项目 `account:<账号号>`，口令项目 `user:<用户名>`（同一用户名换设备是同一张表），本机空间 `local`；消息里自报的一律不认；渲染节点、托管方服务、Agent 的连接不能用。共享项目的连接只能碰自己那个项目的表。
- **为什么独立于项目 JSON**：语义要求（`product/document-service.md`「冲突」：「不放进项目 JSON、不增加项目历史序号」），而且表是一个人的、别的成员不该看到也不该被同步；放进项目 JSON 会每改一次表就涨一次历史序号、广播给所有人、进别人的撤销冲突判断。PM-03 钉了：写表不涨序号、别人收不到任何消息。
- **页面这一侧**：浏览器本地缓存里 `merge|<项目号>|<用户>` 存表的副本与待发队列（断网时的「删除选中」、刚转进来还没交出去的批次），连上后按顺序发、再取一次表；`journal|<项目号>|<用户>` 存账号项目的离线批次（DocSync 的 `recoveryJournal`），都确认了就删。

## 三、给 0.7.20「撤销冲突」留的口子

- 每条记录带 `source`，现在只有 `offline`，0.7.20 加 `undo`；键里带来源，同一样东西离线和撤销各一条、互不覆盖（MI-12 钉了两条并存、同一套显示与合并）。
- 撤销冲突照同一个形状写，不用改窗口和服务：`base` 写那一步落地后的值（「期望云端仍是它」），`mine` 写撤回后要变成的值，用现成的 `diffThings(落地后, 撤回后, { source: 'undo', ... })` 就能生成；判冲突（云端 ≠ base）、显示（`base → mine（云端现在是 …）`）、合并（照 mine 写）、删除选中都不分来源。MI-12 就是这么造的撤销项。
- 页面上交表只有一个入口 `MergeTable.add(things)`；0.7.20 在 `revert` / `revertRemote` 遇到 `skipped` 时把被挡住的实体按上面的形状算出来交给它，窗口自动出现（顶栏按钮按表是否为空显示）。
- 改密码选了退出触发的撤回（没人在场、不弹窗）不经这张表，语义另有规定。

## 四、七个要点逐条的证据

（命令输出见第五节；MI = `mergeItems.test.mjs`，OM = `offlineMerge.test.mjs`，PM = `pending-merge.test.mjs`，D = 探针步骤）

1. **两级可勾选列表**：MI-01（一级按东西：每个片段、每条字幕、项目设置各一条，字幕卡改一行不另列整张卡）；MI-02（二级按属性：透明度改两次只一条、先改长度又改透明度是两条、跨批次并表不重复）；MI-03（「透明度 0.4 → 0.8（云端现在是 0.6）」原样，冲突按属性各判）；MI-07（展开后单独勾一项只并那一项）；MI-10（字幕逐条）。界面：D2 桌面窗口里 c1 一条、两个二级项「时间 0–2 秒 → 0–2.4 秒（云端现在是 0–2 秒）」「透明度 0.4 → 0.9（云端现在是 0.7）」（透明度离线时改了两次）。
2. **增删也算冲突**：MI-04（我删了、别人改了：冲突；合并 = 删掉；删除选中 = 云端保留别人改的）；MI-05（我改了、别人删了：冲突；合并 = 连同我的修改恢复，只勾一项时没勾的按基准；删除选中 = 保持删除）。界面：D2 的 c2「我这边删除了（云端现在已被别人改过）」、c4「名称 「清单」 → 「清单（甲改）」（云端已删除）」；D5 在手机上勾 c4 点合并，另一名成员那边 c4 恢复回来、名字是甲改的；删除选中 c2，另一名成员那边 c2 仍是乙改过的那版。
3. **按「项目 × 用户」存在文档服务、独立于项目 JSON、连上后按表恢复**：PM-01（同项目两用户互不可见、同用户两项目两张表、不能碰别的项目）、PM-02（同用户换设备同一张表、改了另一台马上收到）、PM-03（不涨历史序号、不广播）、PM-05（重启后按表恢复）、PM-06（自报用户不认）、PM-07（身份取法）；OM-04（断网时先进本机暂存、连上交给文档服务、同用户另一页面从文档服务恢复、别的用户看不见）。界面：D5 同一用户「甲」用手机进项目，冲突横条显示的是桌面那边转进来的同一张表；手机处理完，桌面的「冲突合并」按钮跟着消失。
4. **按钮**：MI-09（选中无冲突项、取消全部勾选、一级全勾 / 部分 / 没勾）。界面：D3 桌面「选中无冲突项」只勾上 c1 的长度（另三项都有冲突），点「合并」后另一名成员那边长度是甲的、透明度仍是乙的；D5 手机清空后关闭按钮变成「完成」；D4 关窗前是「下次再说」。
5. **导航栏顶端按钮**：D4 关窗后顶栏「冲突合并 3」按钮在；D5 处理完按钮消失；截图 `desktop-4-nav-button.png`、`desktop-5-cleared.png`。
6. **断网时**：改项目内容的操作都照常（DocSync 原本就允许，D1 甲断网时改了四处）；在线浏览器导入置灰并提示「当前离线」：D6 桌面「导入媒体（当前离线）」disabled、手机素材库两处导入 disabled；桌面版不置灰（`importOfflineOf` 的 `online: false` 恒为 false，`onlineStatus.ts`）。离线改动落盘到浏览器本地缓存：OM-05（IndexedDB 落盘，新开页面读回离线批次与表；恢复进新页面的 DocSync 照常走期望版本，云端变了再逐项转表）。重连后逐项恢复：OM-01、OM-02、D2。
7. **手机版同桌面**：`ConflictSheet` 用同一个 `useConflictMerge`；D5 截图 `mobile-2-sheet.png`（两级、勾选框、顶端两个按钮、底部三个按钮）、`mobile-3-picked.png`、`mobile-4-done.png`。

## 五、验证

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误（最后一次在提交 514ca0e4 之后） |
| 构建 | `npm run build` | 退出码 0（同上）；`npx vite build --mode online` 退出码 0（探针用） |
| 新增单测 | `node --test src/editor/sync/mergeItems.test.mjs` | 12/12 过 |
| | `node --test src/editor/sync/offlineMerge.test.mjs` | 6/6 过 |
| | `node --test server/test/pending-merge.test.mjs` | 8/8 过 |
| | `node --test src/editor/sync/onlineSync.test.mjs` | 7/7 过（含新加的断网导入判据） |
| 相关回归 | `node --test src/editor/sync/*.test.mjs src/mobile/*.test.mjs src/store/*.test.mjs` | 280/280 过 |
| | docservice / 共享项目相关（`auth-impl-service`、`docservice-auth`、`c65-shared-admin`、`multi-agent-presence`、`c65-docservice`、`docservice-project`、`docservice-router`、`docservice-channels`） | 35/35、43/43 过 |
| 全量（满载） | `npm test`（设好两个账号环境变量；机器上另有两个任务在跑，同时我的探针也在跑） | 7509 项：通过 7482、失败 11、取消 1、跳过 15 |
| 全量失败逐个单跑 | `node scripts/test-suite.mjs server/test/<文件>` | 见下 |
| 界面探针 | `node scripts/probes/conflict-merge-probe.mjs`（在线构建 + 本机托管组合 + 两套代理，端口 5890～5897） | 第三次跑 `ok: true`、`fails: []`、两页 `pageerror` 都是 0（第一次也全过；第二次手机「处理」按钮被进项目的气泡盖住没点着，探针加了直接点元素的退路后再跑全过） |

满载失败的 11 项与单跑结果：

| 文件 | 满载 | 单跑 | 判断 |
|---|---|---|---|
| `server/test/accept-018-auth-agent-path.test.mjs`（2.3-3 共有对话按到达顺序） | 失败（30 s 等待超时） | 9/9 过 | 时序敏感，机器忙时假失败 |
| `server/test/account-master-production.test.mjs` | 失败（169 s） | 1/1 过 | 同上 |
| `server/test/account-render-publish.test.mjs`（AR-09/11/12） | 失败（各 24～30 s 超时） | 12/12 过 | 同上 |
| `server/test/account-root-resident.test.mjs` | 失败（叫停后 15 s 内没退出） | 1/1 过 | 同上 |
| `server/test/account-runner-wiring.test.mjs`（RW10） | 失败（162 s） | 10/10 过 | 同上 |
| `server/test/account-task-worker-child.test.mjs` | 失败（164 s） | 1/1 过 | 同上 |
| `server/test/cli-setup.test.mjs`（真子进程 stdin + 收尾删临时目录 EPERM） | 失败 | 28/28 过 | 同上 |
| `server/test/c10-ui-gates.test.mjs`（C10-UI-01） | 失败 | 改回原文后 8/8 过 | **我引起的**：我改了离线常驻提示的字，这条门测试锁定 C10 表 A 原文。已回退原文（提交 514ca0e4），改字交主会话定，见第六节第 7 条 |

上面 7 个文件都在 Agent 任务进程、账号服务、命令行登录一带，本分支没碰；`media-tiers` 的 T3-8 这次全量里没有失败。

## 六、语义里说不通或缺的地方（交主会话定）

1. **「无冲突时也可使用该窗口」的触发条件**。我的做法：断网期间云端**完全没人改过**（历史序号没动）时，离线修改照旧直接提交，不进窗口（OM-06）；只要云端有人改过（哪怕改的是别处），这一批离线修改全部转进待合并表、窗口打开，其中不冲突的可以「选中无冲突项」一键并。理由：断一秒网、只自己在改也弹窗太打扰。若要「每次重连都进窗口」，改 `refreshStatus` 一处即可。
2. **〔已补，见第十节二〕「每张卡片的源码」这一类没进这张表**。卡片源码不在项目 JSON 里，由编辑器进程的卡片源码同步（`server/card-sync.mjs`，经内容库）另走一条路，离线时的改动不在 DocSync 的离线批次里。要列进窗口，需要卡片源码同步把「离线改过、云端也改过」的卡交出来（形状照第二节，`ref.kind` 加 `card`）。这不在我的文件范围里，记待办。
3. **冲突横条的「N 处 / M 处」按一级数**（一样东西算一处），与手机演示稿 `cfBar` 的数法一致；「已选 N 项」按二级数。语义没写明，请确认。
4. **不冲突的二级项也写「（云端现在是 X）」**（此时 X 就是基准值）。语义的例子只给了冲突的情形；我按「写明改成什么、云端现在是什么」一律写。
5. **片段的开始与结束合成一条「时间」**：移动片段与改长度是同一个属性。满足「先改长度、又改透明度仍是两条」，但「先移动、又改长度」只出一条。要拆成「开始」「结束」或「位置」「长度」两条，改 `mergeItems.ts` 的 `clipProps` 一处。
6. **一级除了语义列的四类，还列了序列、剪辑、转场、素材与各效果库条目**：不列的话离线时对它们的改动就无处可合（会丢）。
7. **〔已按主会话决定改，见第十节四〕在线页面离线常驻提示的字不准了，但没改**：原文（C10 契约表 A，`c10-ui-gates.test.mjs` 的 C10-UI-01 锁定）「当前离线，有未提交的修改。关闭页面将丢失这些操作。」在 2026-10-22「落盘到浏览器本地缓存」之后，对账号云端项目已不成立。我先改过一版（「当前离线，有未提交的修改，已暂存在这台设备的浏览器里，连上后再提交。」，截图 `desktop-0-offline.png` 里是这一版），撞了门测试，已回退原文。请主会话定新字，同时改 `server/test/c10-kit.mjs` 的 `TABLE_A`。离开页面的原生确认已改成「离线批次存进浏览器本地缓存了就不拦」（`SyncOverlays.tsx`）。
8. **「合并」要连着文档服务**，断网时只能「删除选中」（语义说每次合并要重新核对云端历史序号，断网核对不了）。
9. **〔已补，见第十节一〕从云端项目另存的 .proc 在本地改过、重开连回云端**（`handleCloudAssociationReopen` → `mergeOffline`）：文件里只有改过的内容、没有另存时的基准，所以基准只能取「连回时的云端」，另存之后别人在云端的改动会被当成「我这边改回去了」列进窗口。要做对，需要另存时把非本机内容的确定快照（基准内容，不只是哈希）随文件保存——这正是「固定非本机快照」那一条，见第八节。

## 七、要定的三级数字

| 数字 | 现值 | 在哪 |
|---|---|---|
| 一个用户在一个项目里待合并表最多几样东西 | 2000 | `pending-merge.mjs` `MERGE_LIMITS.THINGS_PER_USER` |
| 一样东西序列化后上限 | 512 KiB | `MERGE_LIMITS.THING_BYTES` |
| 一个用户一个项目整张表上限 | 4 MiB | `MERGE_LIMITS.USER_BYTES` |
| 离线批次写浏览器本地缓存的合并间隔 | 300 ms | `syncManager.ts` `BROWSER_JOURNAL_MS` |
| 浏览器本地缓存的库名 / 表名 | `pc-offline` / `kv` | `offlineCache.ts` `OFFLINE_DB` |

超限时的行为与测试见第十节五。

## 八、没做成的及原因

1. **〔已补，见第十节一〕固定非本机快照（保存时记哈希、时间、历史序号并能当基准用）**：原先没做。现有的云端关联记号只有 `savedRev`、`savedAt`；要加的是另存时把基准内容随文件保存，写在 `src/editor/io/proc.ts`（不在我的文件范围），而且光有哈希不能当基准（`mechanism/document-service.md`：哈希和时间不替代可比较的基准内容）。建议：`serializeProc` 里 `cloudAssociation` 加 `base`（DocSync 的已确认副本）与 `baseSha256`，重开时 `offlineThings({ project: 文件内容, pending: [] })` 换成「`diffThings(base, 文件内容)`」直接进待合并表。
2. **〔已补，见第十节二〕卡片源码**：见第六节第 2 条。
3. **在线浏览器里旧办法的口令房间（非账号项目）**的离线批次没落盘到浏览器本地缓存：进入流程在同步回调里建连接，没处插异步读缓存；在线浏览器的云端项目都已是账号项目（2026-10-07 用户定），只对账号项目做。
4. **〔已改，见第十节三〕旧探针要跟着改**（原先不在我的文件范围）：`scripts/probes/c65-editor-probe.mjs`、`c10-ui-probe.mjs`、`reopen-matrix.mjs` 等着旧的离线对话框（`[data-pc=offline-dialog]`，「加进去 / 不要了」）；`mobile-ui-probe.mjs` 的 C 段直接点「删除选中」（现在要先勾选）。平时走新窗口，这几处会等不到。改法：等 `[data-pc=conflict-merge]`，点「选中无冲突项」或勾一级勾选框，再点「合并」/「删除选中」。
5. **转表时的安全网备份**：整批回退前照旧存一份整批备份（桌面写本地备份目录，在线页面存本页内存，顶栏「备份 1」），不弹「已丢弃」气泡。若觉得多余可去掉（`saveBackup` 的 `quiet` 分支）。

## 九、截图

都在 `out/conflict-merge/`（worktree 下，不入库）：

- 桌面：`desktop-0-offline.png`（断网时的常驻提示；截的是改字那一版，现已回退原文）、`desktop-6-import-offline.png`（导入媒体置灰）、`desktop-1-window.png`（重连后窗口自动打开，两级展开）、`desktop-2-select-clean.png`、`desktop-3-merged.png`、`desktop-4-nav-button.png`（顶栏「冲突合并 3」）、`desktop-5-cleared.png`（处理完按钮消失）
- 手机：`mobile-1-bar.png`（冲突横条）、`mobile-2-sheet.png`（面板）、`mobile-3-picked.png`、`mobile-4-done.png`（「完成」）、`mobile-5-cleared.png`、`mobile-6-import-offline.png`

## 十、第二轮（主会话 2026-10-22 的四件）

### 一、固定非本机快照（授权改 `src/editor/io/proc.ts`）— 提交 aa67cb00

- **存什么**：账号云端项目另存 `.proc` / `.procp` 时，`cloudAssociation` 里除了 `savedRev`、`savedAt`，另带 `base`（另存那一刻文档服务确认过的那一版项目，即 DocSync 的已确认副本，是基准**内容**）和 `baseSha256`（`JSON.stringify(base)` 的 SHA-256，同步实现 `src/editor/sync/sha256.ts`，因为 `serializeProc` 是同步的）。逻辑在 `src/editor/sync/cloudSnapshot.ts`：
  - 连着这个云端项目时取当下的已确认副本与序号（`syncManager.ts` 装的 `setCloudSnapshotGetter`，只在 `cur` 是这个云端项目时给）；
  - 没连着（以本地副本打开、断网）再另存时**沿用文件里原来的基准与序号**——那一版仍是「本机改之前云端的样子」。顺带修了一个旧问题：原来以本地副本打开再另存，`savedRev` 取的是本机空间连接的序号。
- **怎么用**：重开连回时（`syncManager.ts` 的 `onLoad` → `reopenPlan`）拿基准和文件内容逐项比（同一个 `diffThings`）：云端在另存之后没人动过 → 当一次普通修改提交；被别人改过 → 我的修改进「冲突合并」（气泡「已连回云端项目。另存之后云端有别人的改动，你的修改已放进「冲突合并」，可以逐项合并。」）；本机没改过 → 什么都不做。
- **向后兼容**：老文件没有 `base` / `baseSha256` 照旧打开、关联照旧，连回时退回原来的做法；`base` 哈希对不上（文件被改坏）当没有基准，照旧打开。都有测试（CS-03、CS-06）。
- **文件变大多少**：多一份项目内容 JSON（同样两格缩进写出），不含素材字节、帧快照、缩略图、卡片源码。量级 ≈ 文件里 `project` 那一段再来一份；CS-06 的样例：文件 2016 字符，其中基准 1020 字符。帧快照与缩略图大的文件，相对增幅更小。另存时多算一次 SHA-256（纯 JS，项目 JSON 每 MB 约几十毫秒量级），草稿自动保存也会带上。
- **钉坏情形的测试**：`src/editor/sync/cloudSnapshot.test.mjs` CS-04——另存（rev 7）→ 本机在文件里改 c1 → 云端别人改 c2、加 c9（rev 8）→ 重开：只列 c1 一条；合并后 c2 仍是别人改的、c9 还在；同一测试里对照老办法（以连回时云端为基准）会多出「c2 改回去」「c9 删掉」两条，即被修掉的错。CS-01～06 全过；`accountMove.test.mjs`（含 AM-22 另存与重开四规则）同跑 79/79 过。

### 二、卡片源码进这张表（授权改 `server/card-sync.mjs`）— 提交 4de0b9c9

- **一级一张卡**（一个卡片源码文件，`卡片源码「cards/user/price-tag.tsx」`），**二级是「源码」**，文字「源码：我这边的版本比云端现在的多 a 行、少 b 行（云端现在是别人改过的版本）」（按行比，`lineDelta`）。总算冲突（只在云端也被别人改过时才进表）。
- **从哪来**：`server/card-sync.mjs` 在重连对账时（`fromList`），对**同步过的卡**（本机有记账）发现「本机在上次同步之后改过、服务上也更新了」，不再按「最后写的赢」悄悄换掉：先备份本机那份（同原来）、装上服务上的，发 `conflict` 事件（带我这边与云端两份源码）。在线时的同时改（T8-2）、第一次打开项目时本机碰巧有同名卡，仍照原来按覆盖办。页面 `cardSync.ts` 收到后交给 `syncManager.ts`，用 `cardConflictThing` 放进待合并表、打开窗口；没有待合并表时退回原来的覆盖提示。
- **合并 / 删除选中**：卡片不在项目 JSON 里，`applyMerge` 把它放进 `external`，`syncManager.mergeCards` 调 `POST /api/cards/sync/take-mine` → `card-sync.mjs` 新增的 `takeMine(rel, source)`：照我这边的源码走同一套审查、写文件、热更新，再当一次本机保存传上去；写成了才从表里拿掉，写不成（审查不过）给气泡、留在表里。「删除选中」= 从表里拿掉，本机已是云端版本。
- **越出清单的一处**：`server/vite-plugin-cards.ts` 加了 `/api/cards/sync/take-mine` 这一个端点（约 15 行，照同文件其它 `/api/cards/sync/*` 的写法：只收 POST、核 Origin、拒舞台来的请求）。它不在授权清单里、也不在禁区里；不加的话页面没有路子让编辑器进程照我这边写回一张卡（`/api/cards/edit` 要卡片 id 且只认整卡闭包，部件文件对不上）。页面这边在在线构建里剪掉（`ONLINE_BUILD`），在线页面不出现卡片冲突项（卡片源码同步只在桌面版跑）。
- **测试**：`server/test/card-sync.test.mjs` 新增 T8-8（A 断开时改卡、B 在线改同一张 → A 连回收到 `conflict`、本机换成云端、我的没被悄悄传上去、有备份、没有「被覆盖」提示；`takeMine` 之后服务上是我的、B 装上；审查不过的源码不写不传），T8-0～8 全过；`mergeItems.test.mjs` MI-13（卡片一条、文字、总算冲突、「选中无冲突项」不勾它、合并交给外部且同一次合并里项目项照常写）。
- **因此改的旧断言**：`server/test/c66-cards.test.mjs` 的 C66-T8-05 原断言「本机改过（没同步出去）、服务上也改过 → 后写的赢 + 覆盖提示」。2026-10-22 用户定这种情形进「冲突合并」，改成「先备份、再装服务上的、发 conflict（带两份源码）」；`c66-kit.mjs` 把 `conflict` 事件映射成 `card-conflict`。备份先于装、装的是服务上的版本这两条断言保留。
- **没做到的**：在线浏览器里卡片源码不走这条同步（在线页面没有编辑器进程），不涉及。真界面截图已补，见第十一节。

### 三、四支旧探针（授权改）— 提交 1d07f323

| 探针 | 改了哪处 | 为什么 | 跑了没有 |
|---|---|---|---|
| `scripts/probes/c65-editor-probe.mjs` 离线段 | 等 `[data-pc=offline-dialog]` → 等 `[data-pc=conflict-merge]`；断言「断网期间项目有新改动」「你有 3 步…」→ 断言窗口里有那一段、二级写着「「离线2」…云端现在是 「B5-离线」」；「关掉后顶栏『同步已暂停』、点它重开」→「关掉后顶栏『冲突合并』按钮、点它重开」；「不要了」→ 全勾 + 删除选中；「加进去」→ 全勾 + 合并。三份摘要一致、c5 / c7 结果的断言不变 | 旧对话框没了（整份处理换成逐项）；「同步已暂停」只在算不出基准的退路里出现 | 跑了 `--phases local`（本分支编辑器起在 5890，数据目录在临时目录）：**21/21 过**，截图 `out/probe-c65/conflict-merge-window.png`、`conflict-merge-button.png`。shared / lan 阶段要托管组合，没跑（不碰离线段） |
| `scripts/probes/c10-ui-probe.mjs` A7 第 1 轮 | 常驻提示断言改成新文案（口令房间 → 「只在这个页面里」那句）；等离线对话框 → 等冲突合并窗口，并断言列着离线改的那一段；「不要了」+「当场给下载备份的气泡」+「下载出 offline-discard JSON」→ 全勾 + 删除选中、断言回到云端现状、不自动下载、关闭按钮变「完成」；offline-discard 备份改在同步面板「备份 N」里核能下载 | 旧对话框没了；转表时那一下整批回退不再弹「已丢弃」气泡（内容在待合并表里，整批备份照旧静默留在本页内存） | 跑了（端口 5890～5897）：我改的检查全过；**唯一失败**是「A7 点置灰的入口不发请求」（舞台子域的 `/media-s/…` 请求）。我把 main `ca4fc432` 的源码用 `git archive` 拉到 `out/base-src` 另建在线构建、同一探针同一端口跑：**同一项同样失败**（还多两个 `stage.html` 请求）——是 main 原有的，与本分支无关 |
| `scripts/probes/mobile-ui-probe.mjs` C 段 | 点「处理」点不着时直接点元素（进项目的气泡盖住它）；「删除选中」前先断言它没勾时是灰的，再勾上一级、删；断言关闭按钮变「完成」后点掉，再核横条收起 | 面板从整份「删除全部」换成逐项勾选：没勾时「删除选中」是灰的 | 跑了（5890～5897）：**fails: []**；C 段 `bar`「1 处改动待合并，其中 1 处有冲突」、`dropBeforeSelect: true`、`closeText: 完成`、横条收起 |
| `scripts/probes/reopen-matrix.mjs` 两段（逐处见第十一节三） | 「等 paused + 等离线对话框 + 点加进去 / 不要了」→ 等冲突合并窗口、断言「项目设置」那一条同时写着我离线改的名字与主机改的名字、本机先回到云端现状、全勾 + 合并 / 删除选中；主机看到我的名字、本地备份目录里有 offline-discard 那两条断言不变 | 同上；离线批次转表后 DocSync 只停一下就回到云端，`status === 'paused'` 等不到 | **没跑、由主会话跑**：它由 `reopen-e2e.mjs --matrix` 起，编辑器端口写死 5203（主会话的 dev-test，禁止碰）、5206、5209、5215，每个再占 +1、+2，同时还要托管组合的端口，我的 5890～5899 装不下。要跑得给它一组端口，或由主会话跑 |

### 四、离线横幅文案〔裁：2026-10-22 主会话，二级〕— 提交 63e0e244

- **修改前**：一句——「当前离线，有未提交的修改。关闭页面将丢失这些操作。」，离线且有未提交就挂浏览器原生离开确认。
- **修改后**：按改动存没存下来分两句（`src/editor/sync/onlineStatus.ts` 的 `OFFLINE_UNSENT_TEXT.saved / .page`）——
  - 存下来了（账号云端项目：落盘到浏览器本地缓存；桌面版：本机恢复文件）：「当前离线。你的改动已存在本机，连上网络后会合并回项目。」
  - 没存下来（在线页面里旧办法的口令房间，不落盘；或这一次写浏览器本地缓存失败）：「当前离线。你的改动只在这个页面里，关掉页面就会丢失。」
  - 离开确认只在「只在这个页面里」时挂。判据是界面状态 `offlineStore`：进账号项目、桌面版是 `saved`，在线口令房间是 `page`；浏览器本地缓存写失败当场改成 `page`，写成了改回 `saved`。
  - 桌面版本来就不挂这条横幅（顶栏是「离线」小标），没新加。
- `server/test/c10-kit.mjs` 的 `TABLE_A` 换成这两句（`C10_UI_MARKERS` 跟着换），C10-UI-01 两句各断言一条：`c10-ui-gates.test.mjs` 8/8 过；`onlineSync.test.mjs` 断言两句原文与「saved 不拦离开」。
- 请主会话把这条写进语义时标〔裁〕。

### 五、三级数字的最终表与到上限时的行为

| 数字 | 值 | 在哪 | 依据 |
|---|---|---|---|
| 每用户每项目待合并表最多几样东西 | 2000 | `server/docservice/modules/pending-merge.mjs` `MERGE_LIMITS.THINGS_PER_USER` | 一次断网改到上千样东西已是极端情形；与文档服务提交摘要留 1000 条、撤销栈 100 步同一量级，取两倍余量 |
| 一样东西序列化后上限 | 512 KiB | `MERGE_LIMITS.THING_BYTES` | 一样东西带基准与我这边两份整件值；文档服务单条消息上限 1 MiB（`DOCSERVICE_DEFAULTS.MAX_PAYLOAD`），两份各一半以内才放得进一条 `merge.put` |
| 每用户每项目整张表上限 | 4 MiB | `MERGE_LIMITS.USER_BYTES` | 每次改动整表重写落盘（`store.rewrite`）；4 MiB 写一次在毫秒级，且约等于两份大项目的 JSON |
| 离线批次写浏览器本地缓存的合并间隔 | 300 ms | `src/editor/sync/syncManager.ts` `BROWSER_JOURNAL_MS` | 与撤销合并窗口 `MERGE_WINDOW_MS` 同值：拖滑块这类连续改动不至于每帧写一次 IndexedDB，关页面最多丢最后 0.3 秒 |
| 浏览器本地缓存的库名 / 表名 / 版本 | `pc-offline` / `kv` / 1 | `src/editor/sync/offlineCache.ts` `OFFLINE_DB` | 键按「类别 \| 项目号 \| 用户」，一张表放离线批次与待合并表副本两类 |

**到上限时**（2000 条或 4 MiB，单样东西 512 KiB 同此）：**拒绝再记，不丢最旧的，也不收一半，并提示用户**。
- 文档服务：那次 `merge.put` 整条不收（回 `too-many` / `too-large`），表原样。替换已有的一条不算新增。
- 页面：这几条留在本机（浏览器本地缓存），窗口里写「待合并项太多，文档服务存不下，暂时只存在这台设备上；合并或删除一些之后会自动再交。」（桌面 `data-pc="merge-blocked"`、手机 `data-pcm="cf-blocked"`）。用户合并或删掉一些后，先把「拿掉」发出去、再重交被拒的那批；已经删掉的不会被重交回去（待发队列里一起拿掉）。
- 测试：`server/test/pending-merge.test.mjs` PM-09（上限 2：第三条被拒、表原样、替换照收、拿掉一条后能记；整表超字节被拒）；`src/editor/sync/offlineMerge.test.mjs` OM-07（上限 1：两条被拒、本机两条都在、文档服务一条没记；删掉一条后自动重交、删掉的没被记回去）。全过。

### 六、这一轮的验证

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0 |
| 构建 | `npm run build`；`npx vite build --mode online` | 都是退出码 0 |
| 全量（满载，机器上另有两个任务） | `npm test`（设好两个账号环境变量） | 7519 项：通过 7502、失败 2、取消 0、跳过 15 |
| 满载失败单跑 | `node scripts/test-suite.mjs server/test/cli-setup.test.mjs` | 28/28 过（两项失败都在这一个文件：真子进程 stdin 等待超时 + 收尾删临时目录 EPERM，第一轮也出现过、单跑都过） |
| 新增 / 改动的测试 | `cloudSnapshot.test.mjs` CS-01～06、`mergeItems.test.mjs` MI-01～13、`offlineMerge.test.mjs` OM-01～07、`pending-merge.test.mjs` PM-01～09、`card-sync.test.mjs` T8-0～8、`c66-cards.test.mjs`、`c10-ui-gates.test.mjs`、`onlineSync.test.mjs` | 全过（全量里也都过） |
| 探针 | c65-editor（local）、c10-ui、mobile-ui、conflict-merge | 见本节三：c65 21/21；mobile-ui 与 conflict-merge 无失败；c10-ui 唯一失败项在 main 上同样失败。reopen-matrix 没跑（端口，见上） |

### 七、跑探针时看到的一处，交主会话定

- c10-ui 探针里断网时只挪了一个片段，窗口里却出现两条：那一段，和「项目设置」（二级「时长」）。原因是总时长跟着片段自动变（`duration` 是项目顶层字段，不进撤销栈但进项目 JSON）。它是真实的改动、合并它也无害，但用户会觉得「我没改设置」。可选：把跟着内容自动变的 `duration` 从「项目设置」里排除（合并片段后它会照常自动跟上）。我没改，等主会话定。

## 十一、第三轮（主会话 2026-10-22 的裁定与两件收尾）

### 一、「项目设置」里不列跟着算出来的值〔裁：2026-10-22 主会话，三级〕— 提交 8ad68cc7

原则：这张表只列用户直接改的东西，不列由别的东西算出来的值。去掉的（`src/editor/sync/mergeItems.ts` 的 `DERIVED_PROPS`）：

| 在哪 | 去掉的属性 | 为什么算「算出来的」 |
|---|---|---|
| 项目设置 | `duration`（时长） | 总时长缺省等于内容末尾、跟着片段走（`kernel/duration.ts`）；用户手动截断的值不落盘，只在编辑器状态 `durationManual` 里，项目 JSON 里的 `duration` 永远是按规则算出的结果。挪一个片段它就变 |
| 素材 | `pending` `tiers` `hash` `ext` `size` `duration` `width` `height` `url` `path` | 导入、入库、上传、补元数据时由系统写（「素材元数据回填」那类不进撤销栈的提交），用户没直接编辑过。素材的新增、删除照列，改名（`name`）照列 |
| 片段 | `cardAudio` `embeddedAudio` | 带声音的动效卡生成的声音产物与它的能力标记，由生成流程维护，用户不直接改 |

项目设置里剩下的（名称、宽高、帧率、主题、三维视角、渲染路线、创造力等级、风格）都是用户在项目设置里直接设的，照列。

合并之后总时长照规则跟着内容末尾重算（`applyMerge` 收 `manualDuration`，`syncManager` 从编辑器状态给，手动截断着的照截断），不会留下旧值。测试 MI-14：挪一个片段 + 系统回填素材元数据 + 生成卡片声音产物 → 表里只有那一段的「时间」；素材改名照列；合并后总时长 11、手动截断 10.5 时为 10.5。`mergeItems` 14/14、`src/editor/sync/*.test.mjs` 197/197 过。

请主会话写进语义时标〔裁〕。

### 二、卡片源码冲突的界面截图

- 探针 `scripts/probes/card-conflict-probe.mjs`（端口 5890～5892 起本分支的编辑器、5896 起进程内文档服务；数据目录都在临时目录）：
  1. 真的卡片源码同步：两份「编辑器进程」（临时项目根、真实装卡与备份）对着文档服务，甲断开期间改一张用户卡、乙在线改同一张 → 甲连回时同步发出 `conflict`（带两份源码，`mineHas` / `cloudHas` 都对）；
  2. 把这条提示交给页面——和编辑器进程经 HMR 送来的是同一个入口（`cardSync.ts` 新导出的 `receiveCardSyncNotice`，开发模式经 `__pcSyncTest.cardNotice`）；这一跳是探针替编辑器进程转交的，因为同一个仓库根起两台编辑器会共用 `src/cards/user/`，造不出两边不同的卡；
  3. 窗口里：一级「卡片源码「cards/user/price-tag.tsx」 修改 有冲突 1 项」，二级「源码：我这边的版本比云端现在的多 3 行、少 1 行（云端现在是别人改过的版本） 冲突」；顶栏「冲突合并 1」；「选中无冲突项」不勾它；勾上 →「删除选中」→「完成」。页面没有报错。结果 `ok: true`、`fails: []`。
  4. 不点「合并」：那会让这台编辑器把卡写进本仓库的 `src/cards/user/`。「合并」的规则由 `server/test/card-sync.test.mjs` T8-8 对着真文档服务覆盖。
- 截图：`out/conflict-merge/desktop-7-card-conflict.png`（窗口里那张卡的一行与「源码」二级，背后是编辑器、顶栏有「冲突合并 1」）、`out/conflict-merge/desktop-8-card-conflict-cleared.png`（删除选中后「全部处理完了」）。
- 顺手：窗口里一级名字过长会省略，加了悬停显示全名（`title`）。

### 三、`reopen-matrix` 的改动（已提交，提交 1d07f323；由主会话跑）

`scripts/probes/reopen-matrix.mjs` 里改了这几处，都在「离线修改」两段：

1. **删掉 `paused()`**（原来等 `getSyncView().status === 'paused'`），换成 `mergeWindow()`（等 `[data-pc="conflict-merge"]`）。原因：离线批次被拒后会当场逐项转进待合并表、DocSync 回到云端现状，`paused` 只停一瞬，等不到。
2. **新增 `mergeAll(button)`**：勾上全部一级勾选框（`[data-pc="merge-thing-check"]`），点 `merge-apply`（合并）或 `merge-delete`（删除选中），等关闭按钮变「完成」后点掉。原因：整份「加进去 / 不要了」换成逐项勾选。
3. **「offline edit survives real member process stop and conflict replay UI」段**：
   - `await paused(); await member.waitForSelector('[data-pc="offline-dialog"]')` → `await mergeWindow()`（原因同 1）；
   - 原断言「本机项目名仍是 `matrix-offline-replay`」改成：窗口里 `offline:settings` 这一条同时写着 `matrix-offline-replay`（我离线改的）与 `matrix-remote-replay`（主机改的），且**本机项目名是 `matrix-remote-replay`**。原因：转表后本机先回到云端现状，我的修改在窗口里；
   - 点「加进去（可能会盖掉他们刚改的地方）」→ `mergeAll('merge-apply')`。之后「主机看到 `matrix-offline-replay`」「已保存」的断言不变。
4. **「conflict discard UI retains a real local backup」段**：
   - `await paused(); await member.waitForSelector('[data-pc="offline-dialog"]')` → `await mergeWindow()`；
   - 点「不要了，用现在的最新版本」→ `mergeAll('merge-delete')`。之后「成员看到 `matrix-remote-discard`」「本地备份目录里有 `offline-discard`、项目名 `matrix-offline-discard`、批次非空」的断言不变——转表时那一下整批回退在桌面版照旧静默写本地备份。
5. 截图名 `matrix-conflict-replay`、`matrix-conflict-discard` 不变，内容换成冲突合并窗口。
