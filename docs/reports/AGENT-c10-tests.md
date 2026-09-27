# AGENT-c10-tests：C10 其余的契约测试（C10-T）

分支 `claude/c10-tests`，从 main `bcb67a0` 拉出；端口段 5430～5439（本分支的测试全用 `listen(0)`，没占这一段的固定端口，也没起 dev server）。依据 `docs/plan/c10-contract.md` 第 1 版（下称「契约」）第 2～12 节与它引的语义；没看 C10、C10a、HT-a 的实现代码。

用到的代号：C10 = 在线浏览器模式普通档（契约）；C10a = 在线浏览器模式 demo（`docs/plan/c10a-contract.md`）；L2 = 页面内快照库（IndexedDB）；L5 = 预留接口；K1…K12 = 本报告的测试假设（与 C10a 契约里的 K 系列无关）；C10-A1…A10 = 契约第 20 节的验收条目。

## 做了什么

只新增测试文件与测试夹具，没改产品代码。

| 文件 | 内容 |
|---|---|
| `server/test/c10-kit.mjs` | 公共件：假设 K1～K12（文件头）、静态查导出的门、按候选名接方法的适配、观测工具 |
| `server/test/c10-fake-idb.mjs` | 自写的最小内存 IndexedDB（仓库没有 `fake-indexeddb`，按任务书不引新依赖） |
| `server/test/c10-fake-idb.test.mjs` | 桩本身的单测 FIDB-01～07（不设门，一直跑） |
| `server/test/c10-l2.test.mjs` | L2 配额与淘汰（第 4 节，第 3 节的成本记录） |
| `server/test/c10-beat-swap.test.mjs` | 按拍换帧、swapMs、deadMs、33 ms 节流（第 6 节） |
| `server/test/c10-layer-table.test.mjs` | 层表与环境（第 5 节） |
| `server/test/c10-stages.test.mjs` | 两个舞台的运行配置与退回（第 2 节） |
| `server/test/c10-plan-publish.test.mjs` | 页面发布 `plan`（第 7 节） |
| `server/test/c10-ui-gates.test.mjs` | 用户卡与图卡（第 9 节）、表 A 文案（第 10、17 节）、`/api` 棘轮（第 10 节） |
| `server/test/c10-backup.test.mjs` | 离线备份（第 10 节） |
| `server/test/c10-merge-501.test.mjs` | L5 合并分发回 501（第 11 节） |
| `server/test/c10-ticket-renew.test.mjs` | 逐帧导出续签票据（第 12 节） |
| `server/test/c10-api-ratchet-baseline.json` | 棘轮基线：`claude/c10a-integ@5b2fccc` 上 `c10a-online-api-paths.json` 的 120 条路径原样拷来 |

### 门怎么开

每组开头静态查接口在不在（读源文件找 `export` 的名字，不 import）。不在就 `node:test` skip，原因写明哪个文件不存在、哪个名字没出现；名字一出现就真跑，形状对不上直接失败，不静默跳过。C10 集成后这些门必须全部打开：集成后 `npm test` 的跳过数应回到 2（集成前 main 本来就有的两条，见下）。

计时：本分支没有墙钟断言。防抖与续签全用 `mock.timers`（`setTimeout` 与 `Date` 一起推），L2 的吞吐不测，所以不需要照 `diffProject.test.mjs` 分批重试，忙机上不会误报。

## 用例清单

| 编号 | 契约 | 断言 |
|---|---|---|
| FIDB-01～07 | —— | 桩：升级建表、读写、游标与索引、微任务里事务仍活跃、提交后发请求抛 `TransactionInactiveError`、配额错误两种事件顺序（请求 error → 事务 error → abort；只有 abort）、中止回滚、`forceQuota` |
| C10-L2-01 | 4 | 一个库、三张表 costs / snapshots / ranges，没有 backups |
| C10-L2-02 | 4 | 256 MiB、64 MiB 两个数由 L2 模块导出 |
| C10-L2-03 | 4 | 普通档、剩余额度 200 MiB → 软上限 20 MiB（取较小者）；每写一块库里都不超；不过度淘汰；留下的是最近写的一段 |
| C10-L2-04 | 4 | 低内存档、剩余额度很大 → 64 MiB |
| C10-L2-05 | 4 | LRU：读过的块晚于没读过的被淘汰 |
| C10-L2-06 | 4 | costs 不参与淘汰（40 条一条不少） |
| C10-L2-07/08 | 4 | 配额错误（请求报错 / 只有 abort）：失败的那块写两次；中间只有一个删除事务，删掉 16～64 MiB；重试成功 |
| C10-L2-09/10 | 4 | 回收后仍失败（两种）：这块只放内存、读得回来；写库恰好两次；之后不再为它写库 |
| C10-L2-11 | 4 | ranges 写入即通知订阅方，且落进 ranges 表 |
| C10-L2-12 | 3 | 成本记录关掉再开还在 |
| C10-BS-01 | 6 | `SWAP_MS` = 3 |
| C10-BS-02 | 6 | 装得下的换快照、装不下的占位，两组不重不漏；层数在「预算口径」与「拍长口径」之间（见「需要主会话定的事」1） |
| C10-BS-03 | 6 | 已占用、swapMs 单调；占满一拍全占位；缺省按 SWAP_MS |
| C10-BS-04 | 6 | 带 deadMs 时等于拍长或预算减已占用 |
| C10-BS-05 | 6 | 开着按拍换帧、播放中：60 fps 相邻两拍（16.7 ms）都投，不受 33 ms 节流 |
| C10-BS-06 | 6 | 开着按拍换帧、暂停：33 ms 内不重投 |
| C10-BS-07 | 6 | 桌面（开关关）播放中照旧受节流 |
| C10-LT-01～05 | 5 | 对得上的层回内容键与环境指纹；缺键、缺指纹、层表坏、没这层都回空不抛；同一层两种指纹只回一种且稳定 |
| C10-LT-06 | 5 | 层表所在模块不引 `resultKeyOf`、`snapshotCode`、`cardCostKey`（页面不算键） |
| C10-ST-01～02 | 2 | 舞台源配置解析：两个源（子域，或本机同主机不同端口）→ A、B；缺、空、一个、相同、非地址、非 http(s)、JSON 坏 → 回空不抛 |
| C10-ST-03～05 | 2 | 普通档 + 配置 + 握手成功 → 双舞台；读不到或握手失败 → 单舞台；低内存档恒单舞台 |
| C10-PP-01～06 | 7 | 测量落定前不发；落定后防抖发一个，`parseInbound` 认得、`plan`、`resultKey = <id>@<rev>`；连续改动只发最后一版；改动后重发；回包 published 不 done、error、不回、断线都不抛、无未处理拒绝、之后照常重发；dispose 后不发 |
| C10-UI-01 | 10、17 | 表 A 九段原文在 `src/` 非测试源文件里 |
| C10-UI-02 | 9 | 「该模式暂不支持素材输入的音频图卡」不再单独出现 |
| C10-UI-03 | 9 | 在线时用户卡、图卡那一层不选帧、不报缺口、不取字节；内置重卡照常 |
| C10-UI-04 | 9 | 桌面（开关关）用户卡、图卡照常选帧 |
| C10-RA-01 | 10 | 棘轮清单 ⊆ 基线、不重复 |
| C10-BK-01～04 | 10 | 收到备份不写 localStorage / sessionStorage / IndexedDB、不请求 `/api`、不自动下载；按序留在内存；下载是 `.json`、内容是那份备份；模块源码不出现这三个存储名 |
| C10-MG-01～03 | 11 | `POST /api/asset/merge/<projectId>/<key>` 回 501；任何 projectId 都 501；原有 `GET media/<hash>` 照旧 404 |
| C10-TR-01～05 | 12 | 45 分钟导出、15 分钟票据，每 200 ms 用一次，用到的票据都没过期；取票不超过 11 次；2 分钟票据同样成立；某次续签失败会在过期前再试；stop 后不再取票 |

合计 60 条：FIDB 7 条一直跑，C10 的 53 条在实现不在时 skip。

## 假设 K1…K12

原文在 `server/test/c10-kit.mjs` 文件头，集成方按实现对账只改那里，不改判据。摘要：

- **K1 通用**：被测 `.ts` 经 `src/testing/registerTs.mjs` 在 Node 里 import，import 时不碰 `window`、`document`；门靠静态找 `export` 的名字，名字在候选表里任取其一。
- **K2 L2**：文件取 `L2_FILES` 之一；打开函数 `openL2` 等（候选表），`await open({ indexedDB, lowMemory, estimate, now })`；对象上 `putBlock(key, bytes, type)`、`getBlock(key)`、`putCost(key, rec)`、`getCost(key)`、`putRange(layer, from, to)`、`subscribe(cb)`、`close()`；库里的块以键或值里的字符串认出（`snap/<hash>` 或 `<hash>`）；256 / 64 MiB 以数值常量导出。
- **K3 按拍换帧**：`SWAP_MS` 与一个纯函数 `fn({ fps, occupiedMs, layers, swapMs })` → `{ swap, placeholder, deadMs? }`；`snapshotFeed.ts` 导出开关 `setBeatSwap(on)` 等（候选表）。门：`SWAP_MS` 出现。
- **K4 层表**：纯函数 `fn(table, clipId)`；层表形如 `{ layers: [{ clipId, resultKey, contentKey, envFingerprint, … }] }`（`layerEntry()` 一处定形）；对得上回带 `contentKey`、`envFingerprint` 的对象，否则回空。
- **K5 舞台**：`parseStageOrigins(config)` → `{ A, B }` 或空；`stageLayout({ lowMemory, origins, handshake: 'ok' | 'failed' })` → `'dual' | 'single'`（也认布尔）。
- **K6 发布 plan**：`createPlanPublisher({ endpoint })`，`endpoint` 为 `createWsEndpoint` 形状；方法 `measured(v)`、`changed(v)`、`dispose()`；防抖用全局 `setTimeout`；发的是 `task.publish`。
- **K7 用户卡、图卡**：在线开关沿用 `placeholderHost.setOnlineBrowserMode(true)`；判法与 `unsupportedHere` 相同；豁免做在 `snapshotFeed.ts` 的 `planFeed` / `deliverSnapshots`。门：K8。
- **K8 文案**：以字面量写在 `src/` 非测试源文件里；置灰模板拆两段找。门：表 A 的置灰后半句或离线常驻提示任一出现。
- **K9 棘轮**：清单 `server/test/c10a-online-api-paths.json`（`{ paths }`）；基线从 `claude/c10a-integ@5b2fccc` 拷来。C10a 合入前清单若又改过，集成方按合入时的内容更新基线。门：清单文件存在。
- **K10 备份**：`createOnlineBackups({ download })` 等（候选表）；`save(b)`、`list()`、`download(i)`；下载走回调或 `<a download>` + `createObjectURL`，两种都认。
- **K11 合并分发**：由 `assetServiceMiddleware` 处理，路径 `/api/asset/merge/<projectId>/<key>`。门：`server/asset-service.ts` 里出现 `merge`。
- **K12 续签**：`createTicketRenewer({ fetchTicket, now })` 等（候选表），`start()`、`ticket()`（同步）、`stop()`，按时限提前续签用全局 `setTimeout`。

## 验证结果

- `npx tsc -b --force`：退出码 0，零错误。
- `npm test`（worktree，clean 状态）：退出码 0；`tests 3181, pass 3126, fail 0, cancelled 0, skipped 55`，用时约 30 s。
- 跳过 55 条，逐条原因：
  - 集成前 main 本来就有的 2 条：`集成:/api/cards/layout 对真实项目返回整数框`（`# SKIP`）；`SKILL 闸门:闸关之后无头实例的工具调用不落地`（要 `PROMPTCUT_BASE` 指向自己起的 dev server）。
  - 本分支的门 53 条：

    | 组 | 条数 | 原因 |
    |---|---|---|
    | C10-L2 | 12 | `L2_FILES` 8 个候选文件都不存在，没有 `openL2` 等打开函数 |
    | C10-BS | 7 | `pipelinePlan.mjs`、`snapshotFeed.ts` 在，但没有导出 `SWAP_MS` |
    | C10-LT | 6 | `snapshotSource.ts` 在，但没有导出 `layerRefOf` 等 |
    | C10-ST | 5 | `previewMode.ts` 在，但没有导出 `parseStageOrigins` 等 |
    | C10-PP | 6 | `PLAN_FILES` 都不存在，没有 `createPlanPublisher` 等 |
    | C10-UI | 4 | `src/` 里没有表 A 的置灰后半句或离线常驻提示 |
    | C10-RA | 1 | `server/test/c10a-online-api-paths.json` 不存在（棘轮清单还在 C10a 集成分支） |
    | C10-BK | 4 | `BACKUP_FILES` 都不存在，没有 `createOnlineBackups` 等 |
    | C10-MG | 3 | `server/asset-service.ts` 里没有 merge 路由 |
    | C10-TR | 5 | `RENEW_FILES` 都不存在，没有 `createTicketRenewer` 等 |

## 自检（照契约写的最小参考实现，不提交）

参考实现放在 scratchpad，临时拷进 worktree 跑完即删（`git status` 已干净）：`src/online/l2.ts`、`layerTable.ts`、`stageOrigins.ts`、`planPublisher.ts`、`texts.ts`、`backups.ts`、`ticketRenewal.ts`，`src/render/beatSwap.mjs`；临时改了 `snapshotFeed.ts`（开关、在线时跳过用户卡和图卡）与 `server/asset-service.ts`（merge 回 501）；临时放了 C10a 的棘轮清单。

- 参考实现下：`node --experimental-test-module-mocks --test server/test/c10-*.test.mjs` → `tests 60, pass 60, fail 0, skipped 0`。
- 自检顺带查出两处问题，都改了：
  - 参考 L2 的事务 `onerror` 里调了 `preventDefault()`：请求出错时事务不中止，而是把没写成的那块当成功提交了。C10-L2-07 当场判红，说明测试能拦住这种真实会犯的错；参考实现改掉后通过。
  - C10-MG 的临时素材服务挂在第一条用例的 `after` 上，后两条连不上。已改成整个文件跑完才关（提交 `3b772e7`）。
- 变异检查：每次只改参考实现的一处，看测试能不能判红。下表 27 个变异都判红：

  | 变异 | 判红的用例 |
  |---|---|
  | 多建一张 backups 表 | L2-01 |
  | 不按软上限淘汰 | L2-03、04、05 |
  | 回收拆成每块一个事务 | L2-07、08 |
  | 只接 error、不接 abort | L2-07～10（abort 模式挂住 5 s 后判红） |
  | 回收后仍失败时丢掉那一块 | L2-09、10 |
  | 读不更新 LRU | L2-05 |
  | 回收后重试两次 | L2-09、10 |
  | 播放中不绕节流 | BS-05 |
  | 暂停也绕节流 | BS-06 |
  | 不计已占用 | BS-02、03、04 |
  | swapMs 缺省不是 SWAP_MS | BS-03 |
  | 不查环境指纹 | LT-02 |
  | 坏项让函数抛错 | LT-01～05 |
  | 低内存档也开双舞台 | ST-05 |
  | 握手失败也开双舞台 | ST-04 |
  | A、B 同源不拒 | ST-02 |
  | 测量落定前就发 | PP-01 |
  | 不防抖 | PP-02、03、06 |
  | 断线时留下未处理的拒绝 | PP-05 |
  | 任务 id 形状不对（队列不认） | PP-02、03 |
  | 用户卡、图卡照样取快照 | UI-03 |
  | 文案改错并留着旧的音频图卡文案 | UI-01、02 |
  | 棘轮清单加一条 | RA-01 |
  | 收到备份时写 localStorage | BK-01、03、04 |
  | merge 回 404 | MG-01、02 |
  | 过期后才续签 | TR-01、03、04 |
  | 续签失败不重试 | TR-04 |

## 没覆盖的（及原因）

模块级测不了，或不在任务书列的范围内，归探针与验收（主会话）：

- 第 2 节：OAC 头、同站跨源进独立进程；后台舞台留在视口里 `opacity: 0`；舞台里用 `setTimeout(0)` 定节拍；编辑器页 rAF 间隔超过约 500 ms 时暂停后台活；大块产出用可转移 `ArrayBuffer`；舞台读自己源上的 `/media`；`hostCapabilities` 照实报（契约没给字段名）。对应 C10-A1。
- 第 3 节：成本记录按「卡片身份 + 本机环境指纹」为键。本分支只把键当不透明字符串，键怎么拼契约没写。加载遮罩下测完：C10-A2。
- 第 5 节：普通档取原尺寸、不请求小尺寸；预取播放头前后 2 秒；`task.done` 并入层表。对应 C10-A3、A5。
- 第 10 节：置灰入口点了不发请求、不露报错（要真页面点，C10-A7）；离线常驻提示的显隐与关页面时的离开确认；HT-a 会话接续期间顶栏不闪状态；DocSync 丢弃时把备份交给在线备份模块的接线（`syncManager` 的在线分支）。
- 第 4 节「L2 只存小尺寸」（低内存档）：C10-A9 探针。

## 偏离契约之处与理由

- 测试全放在 `server/test/c10-*`，没放 `src/**`：统一用 `registerTs` 加载 `.ts`，也免得和 C10a 在 `src/online/` 下新建的测试撞名。
- 棘轮基线是从 C10a 集成分支拷来的数据快照（任务书许可「沿用那份做法」），不依赖那个分支的代码。
- 第 6 节「deadMs 由拍长减去已占用」口径不明，BS-02 两种口径都认（见下）。

## 需要主会话定的事

1. **deadMs 的「拍长」**（第 6 节）：是 `1000 / fps`，还是 K2 的每拍预算 `1000 / fps × 0.7`？测试暂时两种都认：装得下的层数 k 须满足 `floor((预算 − 已占用) / swapMs) ≤ k ≤ floor((拍长 − 已占用) / swapMs)`。定了之后收紧 BS-02、BS-04。
2. **「回收 16～64 MiB」的读法**（第 4 节）：测试按「一次回收至少 16 MiB、至多 64 MiB，全在一个删除事务里；重试可以另开事务，也可以和删除同一个事务」判。如果本意是「回收量在 16～64 MiB 之间按某规则取」，请写明规则。
3. **层表形状与「对不上」的判据**（第 5 节）：契约只说层表补上内容键与环境指纹、对不上的层当没有。测试按「缺内容键或缺指纹、层表坏、没这一层」判。建议层表带版本号 `v`，版本不认得的整张当没有，并写进契约。
4. **「丢弃」后给下载**（第 10 节）：测试按「给下载入口、由用户点，不自动下载、不写存储」判（BK-01 断言收到备份时不自动下载）。另外契约写「丢弃或被覆盖时当场给下载备份」：被覆盖是别人提交落地时发生的，不是用户操作，每次都弹下载入口可能太吵。建议被覆盖的只进内存列表、在同步面板里统一给下载。
5. **续签的形状**（第 12 节）：契约只说「按时限提前续签」。K12 假设导出里有一个续签器（`start / ticket / stop`）。现有的 `server/auth/ticket-source.mjs` 已在剩 1/3 时惰性换新；如果 C10 直接每段调它、再重拼素材地址，K12 要改成测「导出每段取一次票据」，由集成方在 kit 里改。
6. **用户卡、图卡的豁免放在哪**（第 9 节）：K7 假设在 `snapshotFeed.ts`。如果 C10 做在在线快照来源里（从来源那一侧不报这些层），UI-03 要改成测来源，由集成方在 kit 里改。

## 对任务书或语义的更正建议

- 语义与契约没有发现冲突。
- C10a 契约表 C 还列着「该模式暂不支持素材输入的音频图卡」；C10 契约第 9 节把它并入图标。C10 合入时 C10a 契约表 C 那一行建议注明「已由 C10 第 9 节取消」（UI-02 会拦实现里残留的这句文案）。
- 契约第 20 节验收 C10-A10 说「测试里缩短时限」：TR-03 用 2 分钟票据加假时钟就做到了，不用改 `TICKET_TTL`。

## 收口与交接（2026-09-27，应主会话交接到笔记本的要求）

- 收尾各跑一次（worktree，clean 状态，报告提交之前）：`npx tsc -b --force` 退出码 0；`npm test` 退出码 0，`tests 3181, pass 3126, fail 0, cancelled 0, skipped 55`（2 条是 main 原有的，53 条是本分支的门）。
- 进程与端口：本分支没起 dev server，也没起常驻进程；测试里的临时服务都用 `listen(0)`，跑完就关。`netstat -ano` 查 5430～5439 无占用。
- 任务书列的契约第 2～12 节里，能在 Node 单测或模块级验证的约定都写了。没覆盖的见上文「没覆盖的」，归探针与验收，不是没写完。
- 接手的下一步（C10 实现合入之后，集成方做）：
  1. 在 C10 集成分支上跑 `npm test`，看 C10 这 53 条门是否全部打开：跳过数应回到 2；
  2. 仍被跳过的，按报告里的 skip 原因把真名字补进 `server/test/c10-kit.mjs` 的候选表或适配函数，只改 kit，不改判据；
  3. 门开了但判红的，先分清是假设 K 不对（改 kit）还是实现不合契约（退回实现分支）；
  4. C10a 合入 main 时，核对 `server/test/c10a-online-api-paths.json` 与 `c10-api-ratchet-baseline.json` 是否一致，不一致就按合入时的清单更新基线（K9）；
  5. 「需要主会话定的事」1～6 定了之后，按结论收紧对应用例（BS-02、BS-04、L2-07/08、LT、BK-01、TR、UI-03）。
