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

（本节在全量门槛跑完后补全）

## 六、语义里说不通或缺的地方（交主会话定）

1. **「无冲突时也可使用该窗口」的触发条件**。我的做法：断网期间云端**完全没人改过**（历史序号没动）时，离线修改照旧直接提交，不进窗口（OM-06）；只要云端有人改过（哪怕改的是别处），这一批离线修改全部转进待合并表、窗口打开，其中不冲突的可以「选中无冲突项」一键并。理由：断一秒网、只自己在改也弹窗太打扰。若要「每次重连都进窗口」，改 `refreshStatus` 一处即可。
2. **「每张卡片的源码」这一类没进这张表**。卡片源码不在项目 JSON 里，由编辑器进程的卡片源码同步（`server/card-sync.mjs`，经内容库）另走一条路，离线时的改动不在 DocSync 的离线批次里。要列进窗口，需要卡片源码同步把「离线改过、云端也改过」的卡交出来（形状照第二节，`ref.kind` 加 `card`）。这不在我的文件范围里，记待办。
3. **冲突横条的「N 处 / M 处」按一级数**（一样东西算一处），与手机演示稿 `cfBar` 的数法一致；「已选 N 项」按二级数。语义没写明，请确认。
4. **不冲突的二级项也写「（云端现在是 X）」**（此时 X 就是基准值）。语义的例子只给了冲突的情形；我按「写明改成什么、云端现在是什么」一律写。
5. **片段的开始与结束合成一条「时间」**：移动片段与改长度是同一个属性。满足「先改长度、又改透明度仍是两条」，但「先移动、又改长度」只出一条。要拆成「开始」「结束」或「位置」「长度」两条，改 `mergeItems.ts` 的 `clipProps` 一处。
6. **一级除了语义列的四类，还列了序列、剪辑、转场、素材与各效果库条目**：不列的话离线时对它们的改动就无处可合（会丢）。
7. **在线页面离线常驻提示改了字**：原文（C10 契约表 A）「当前离线，有未提交的修改。关闭页面将丢失这些操作。」在 2026-10-22「落盘到浏览器本地缓存」之后不成立，改成「当前离线，有未提交的修改，已暂存在这台设备的浏览器里，连上后再提交。」请定稿。
8. **「合并」要连着文档服务**，断网时只能「删除选中」（语义说每次合并要重新核对云端历史序号，断网核对不了）。
9. **从云端项目另存的 .proc 在本地改过、重开连回云端**（`handleCloudAssociationReopen` → `mergeOffline`）：文件里只有改过的内容、没有另存时的基准，所以基准只能取「连回时的云端」，另存之后别人在云端的改动会被当成「我这边改回去了」列进窗口。要做对，需要另存时把非本机内容的确定快照（基准内容，不只是哈希）随文件保存——这正是「固定非本机快照」那一条，见第八节。

## 七、要定的三级数字

| 数字 | 现值 | 在哪 |
|---|---|---|
| 一个用户在一个项目里待合并表最多几样东西 | 2000 | `pending-merge.mjs` `MERGE_LIMITS.THINGS_PER_USER` |
| 一样东西序列化后上限 | 512 KiB | `MERGE_LIMITS.THING_BYTES` |
| 一个用户一个项目整张表上限 | 4 MiB | `MERGE_LIMITS.USER_BYTES` |
| 离线批次写浏览器本地缓存的合并间隔 | 300 ms | `syncManager.ts` `BROWSER_JOURNAL_MS` |
| 浏览器本地缓存的库名 / 表名 | `pc-offline` / `kv` | `offlineCache.ts` `OFFLINE_DB` |

超限时文档服务拒收，页面把表留在本机、窗口里说明「暂时只存在这台设备上」，不丢。

## 八、没做成的及原因

1. **固定非本机快照（保存时记哈希、时间、历史序号并能当基准用）**：没做。现有的云端关联记号只有 `savedRev`、`savedAt`；要加的是另存时把基准内容随文件保存，写在 `src/editor/io/proc.ts`（不在我的文件范围），而且光有哈希不能当基准（`mechanism/document-service.md`：哈希和时间不替代可比较的基准内容）。建议：`serializeProc` 里 `cloudAssociation` 加 `base`（DocSync 的已确认副本）与 `baseSha256`，重开时 `offlineThings({ project: 文件内容, pending: [] })` 换成「`diffThings(base, 文件内容)`」直接进待合并表。
2. **卡片源码**：见第六节第 2 条。
3. **在线浏览器里旧办法的口令房间（非账号项目）**的离线批次没落盘到浏览器本地缓存：进入流程在同步回调里建连接，没处插异步读缓存；在线浏览器的云端项目都已是账号项目（2026-10-07 用户定），只对账号项目做。
4. **旧探针要跟着改**（不在我的文件范围）：`scripts/probes/c65-editor-probe.mjs`、`c10-ui-probe.mjs`、`reopen-matrix.mjs` 等着旧的离线对话框（`[data-pc=offline-dialog]`，「加进去 / 不要了」）；`mobile-ui-probe.mjs` 的 C 段直接点「删除选中」（现在要先勾选）。平时走新窗口，这几处会等不到。改法：等 `[data-pc=conflict-merge]`，点「选中无冲突项」或勾一级勾选框，再点「合并」/「删除选中」。
5. **转表时的安全网备份**：整批回退前照旧存一份整批备份（桌面写本地备份目录，在线页面存本页内存，顶栏「备份 1」），不弹「已丢弃」气泡。若觉得多余可去掉（`saveBackup` 的 `quiet` 分支）。

## 九、截图

都在 `out/conflict-merge/`（worktree 下，不入库）：

- 桌面：`desktop-0-offline.png`（断网，常驻提示新字）、`desktop-6-import-offline.png`（导入媒体置灰）、`desktop-1-window.png`（重连后窗口自动打开，两级展开）、`desktop-2-select-clean.png`、`desktop-3-merged.png`、`desktop-4-nav-button.png`（顶栏「冲突合并 3」）、`desktop-5-cleared.png`（处理完按钮消失）
- 手机：`mobile-1-bar.png`（冲突横条）、`mobile-2-sheet.png`（面板）、`mobile-3-picked.png`、`mobile-4-done.png`（「完成」）、`mobile-5-cleared.png`、`mobile-6-import-offline.png`
