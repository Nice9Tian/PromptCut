# AGENT 报告：storage-merge

分支 `claude/storage-merge`，worktree `.worktrees/storage-merge`，起点 `abd6ee56`（主会话已依次合入 storage-leaks、storage-cap、storage-ui、storage-semantics）。端口段 5700～5709（dev server 5700，舞台 5701/5702；`ready-index-probe` 与界面探针用 5703～5705）。没有改 `docs/semantics/`。

任务：把存储占用三支接成一体。三支指计划 `docs/plan/storage-plan.md` 拆出的三个分支：storage-leaks（A 部分，泄漏修复）、storage-cap（B 部分，帧库上限与淘汰、`/api/storage*`）、storage-ui（B 部分的界面与 `/api/exports*`）。

## 提交

| 提交 | 内容 |
|---|---|
| `03aaaa6b` | 报告：开工 |
| `45644824` | 第 1～3 条：导出目录规则只留一份；`/api/storage` 导出一栏用 `summarizeExports`；每次检查与清理缓存前清遗留；遗留认法两边同一套 |
| `9e7eabbd` | 第 4 条：推送队列遇到被淘汰的键丢段、记 `push.evicted`；单测 |
| `8181bebc` | 导出汇总按顶层目录签名失效；界面探针加 U7（不拦截） |
| `6f8b32b1` | 帧库探针 ③a（跑着时放遗留，核下一次检查清掉）；`?detail=1` 带 `lastLeftoverSweep` |
| `0cacc4a2` | 「存储」一块按十进制 GB 显示与提交；用户点的清理缓存标「上次清理缓存」 |
| `e32a43f0` | 没有中间文件时的文案 |
| `7c22addb` | 报告（第一轮） |
| `61dea3a6` | 第二轮：GB 按 1024³；`GET /api/storage` 过时后台量、开始页自动重取；单测与探针 U8 |
| 本提交 | 报告 |

## 做了什么

### 1. 导出目录的规则只留一份

- 定义全放在 `server/storage-leftovers.mjs`：`EXPORT_ID_RE`（`export-YYYYMMDD-HHMMSS`，同秒后缀 `-<1～4 位>`）、`isExportDirName`、`EXPORT_DELIVERABLES`（`preview.mp4`、`overlay.mov`）、`EXPORT_KEEP`（交付物加 `project.json`）、`isExportKeepName`。
- `server/exports-list.mjs` 不再自己定义，改成引这几个（`EXPORT_ID_RE` 原样转出，`KEEP_NAMES`、`DELIVERABLE_NAMES` 就是同一个数组对象）；判断「留不留」都走 `isExportKeepName`。storage-ui 的路径校验、链接跳过、占用回 409、`running` 保护都没动。
- `frame-library-storage.mjs` 里 storage-cap 自带的 `EXPORT_DELIVERABLES`、`EXPORT_KEEP`（它那份只有 `['project.json']`，与 storage-leaks 的同名常量意思不同）、`EXPORT_DIR_NAME`、`isExportDirName`、`summarizeExports` 全删。
- 同秒后缀核对：`claimExportDir` 起的名字是 `-2`、`-3`……最多 `-999`；正则认 1～4 位，是它的超集。单测连起 12 次同一秒的目录，逐个过 `parseExportId`，时刻相同、序号 `0, 2, 3 … 12`。

### 2. `/api/storage` 的导出一栏

- `createExportSummary` 直接调 `exports-list.mjs` 的 `summarizeExports`，与 `GET /api/exports` 同一套认目录的规则。
- 另加：缓存按「导出目录下各份导出的名字 + 修改时刻」签名失效。原来 60 秒缓存在预渲染进程里，而删除、只删中间文件发生在编辑器进程（`/api/exports*`），界面删完后 `/api/storage` 最多 60 秒还报旧数；现在每次 GET 先比签名（只 lstat 顶层，很便宜），变了就重算。签名看不到导出目录深处的变化（导出进行中往 `frames/` 里写），那一种仍由 60 秒兜底。

### 3. 每次淘汰检查时清遗留

- 帧库管理器（`createFrameLibraryStorage`）的 `checkNow()` 与 `clearCache()` 在淘汰之前调 `sweepFrameLibrary(root)`；删过东西的键目录记为要重量，紧接着的 `refresh()` 量完，`leftovers.bytes` 是清完之后的数。
- 保护照留：只有根名为 `frame-library` 时才清（新选项 `sweepLeftovers` 缺省就是这个判断，与 `FramePipeline` 的启动清理同一道）。
- 遗留的认法两边统一：`storage-leftovers.mjs` 新导出 `leftoverFileKind(name, { dead, ageMs })` 与 `isDeadSpillDir`，启动清理删的与 `measureDir` 计进 `leftovers.bytes` 的是同一套名字规则。由此改了 storage-cap 原来的两处出入：
  - 新式的 `playback-<pid>-<uuid>.mov`（storage-leaks 改的名）原来不计为遗留，现在属主进程不在就计；
  - 旧式不带 pid 的 `playback-<uuid>.mov` 原来 10 分钟没动就计，现在按 storage-leaks 的 1 小时（`LEGACY_PLAYBACK_AGE_MS`）。
- 进程死活：遗留用 storage-leaks 的 `pidAlive`（拿不准按活，不删）；主进程锁仍用 storage-cap 自己的（拿不准按死，可接管）。测试注入的 `alive` 两处都管。
- 日志：清掉东西时记一行 `storage.leftovers { removed, bytes, skipped }`（走 storage-cap 的 `[storage]` 日志）；`GET /api/storage?detail=1` 多一个 `frameLibrary.lastLeftoverSweep { at, removed, bytes, skipped }`（诊断与探针用）。

### 4. 推送队列遇到被淘汰的键

- `server/artifact-push.mjs` 新导出 `unitDirOf(pipeline, unit)`（共享档 `controls-html/<dirKey>`、本地档 `controls-local/<entryKey>/<dirKey>`、流 `streams/<resultKey>`）与 `unitEvicted`（目录确实 ENOENT 才算，别的错不算）。
- 在三处判：推之前、清单为空时、推失败时。键目录不在就丢掉这一段（`finish(item, { dropped: true })`），计 `stats().evicted`，记 `push.evicted { id, count }`；日志只记前 3 条和之后每 100 条一条（一次淘汰可能带走很多段）。不算 `failures`、不退避、不挡别的段。
- 原来的行为：快照段目录没了会走 `push.empty` 丢掉（不报淘汰）；流段目录没了抛 `no-stream-manifest`，**按失败无限重试**；推到一半文件读不到也无限重试。

### 5. 三支之间互相打架的地方（核过的与改过的）

| 项 | 结论 |
|---|---|
| `.storage/`、`usage.json`、`push-queue.json`、`controls-lock` | storage-leaks 的清理只进 64 位十六进制键目录、`controls/`、`tracks/`，不碰这些；storage-cap 的淘汰只认六种键形状，也不碰。单测核 `.storage` 在清理缓存后还在 |
| `PROMPTCUT_STORAGE_EVICT=0` | 按任务书「只停淘汰、遗留照清」：`evict: false` 只影响 `evictTo`，`sweepLeftoverFiles` 照做。单测 evict=true/false 两遍都清 |
| 同名常量 `EXPORT_KEEP` 意思不同 | storage-leaks 的是三样全留，storage-cap 的只有 `project.json`；已删 storage-cap 那份 |
| 遗留认法 | 见第 3 条，两处出入已改成 storage-leaks 的口径 |
| pid 死活判法 | 两份 `pidAlive` 故意不同：遗留「拿不准按活」、锁「拿不准按死」。已分开用，写进代码注释 |
| **GB 口径（改了）** | 服务端（storage-cap）按十进制 1e9：缺省 50 GB = 5e10、下限 5e9。界面（storage-ui）按 1024 换算：缺省上限显示成「46.6G」，填 20 发出去 21474836480。探针第一次跑出这个（`cacheText: "0 B / 上限 46.6G（缺省）"`）。改成「存储」一块统一按十进制（新函数 `storageSize`，`GB = 1e9`）；草稿列表的大小仍用原来的 `humanSize`（1024） |
| **「上次自动清理」（改了）** | 用户点「清理缓存」后 `lastEvict.reason` 是 `clear`，界面却写「上次自动清理」。改成按 `reason` 写「上次清理缓存」或「上次自动清理」 |
| 中间文件 0 时的文案（改了） | 「其中中间文件 0 B，可以只删它们」改成「没有中间文件。」 |
| 日志名 | storage-leaks 的启动清理用 `console.log('[storage] 帧库遗留：…')` 字符串，storage-cap 用 `[storage] <event> <json>`；前缀一致。管理器调清理时不传字符串 log，只记结构化的 `storage.leftovers` |
| 预渲染进程的日志 | 预渲染进程的 stdout 只把会话行转给编辑器进程（`vite-plugin-prerender.ts`），`[storage]` 行在编辑器日志里看不到；所以加了 `?detail=1` 的 `lastLeftoverSweep` |
| 错误回包 | `/api/storage*` 错误带 `code`（`CAP_OUT_OF_RANGE`、`STORAGE_NOT_OWNER`），`/api/exports*` 的 409 只有 `error`、`busy`、`skipped`、`freedBytes`，没有 `code`。没改，建议接口约定补一句 |
| 编辑器进程也做启动清理 | 编辑器进程与预渲染进程各在第一次建帧服务时清一次，只删死 pid 的，不冲突 |

## 验证

所有 dev server 都带 `PROMPTCUT_NO_PORT_FILE=1`，都是我起的，跑完都 `taskkill /T` 停掉；收尾时 5700～5709 无监听、没有命令行含 `storage-merge` 的 node 进程。实导与探针的导出目录、数据目录都在临时目录；G0-R 那台不设 `PROMPTCUT_EXPORT_DIR`（帧库在 worktree 的 `out/frame-library`）。用户的 `Videos\PromptCut` 没读没写。

| 项 | 命令 | 结果 |
|---|---|---|
| 相关单测 | `node --experimental-test-module-mocks --test server/test/storage-leftovers.test.mjs server/test/frame-library-storage.test.mjs server/test/exports-list.test.mjs` | 48/48 过（之后又加一条缓存失效，`frame-library-storage.test.mjs` 单独 27/27 过） |
| 推送单测 | `node --test server/test/push-evicted.test.mjs`（新） | 6/6 过 |
| 原有推送单测 | `node --experimental-test-module-mocks --test server/test/artifact-push.test.mjs server/test/push-scope.test.mjs` | 15/15 过 |
| 类型检查 | `npx tsc -b --force` | 退出 0（改完代码后两次，最后一次在全部改动之后） |
| 全量测试 | `npm test` | 第一次（第 1～4 条之后）：tests 3949、pass 3947、fail 0、skipped 2，退出 0；最终：tests 3950、pass 3948、fail 0、skipped 2，退出 0。两次都没有挂的文件，没有需要单独重跑的 |
| 构建 | `npm run build` | 两次都退出 0 |
| 在线构建 | `npx vite build --mode online --outDir <scratch>/online-dist` | 退出 0；产物里 `/api/storage`、`/api/exports`、`start-storage`、`storageSize`、「没有中间文件」都是 0 个文件 |
| 帧库探针 | `node scripts/probes/storage-cap-probe.mjs --port 5700` | 跑了三次都 `ok: true`、`fails: []`。第三次（最终代码）带新加的 ③a：`"leftoverSweep":{"deadPid":55636,"swept":true,"leftovers":{"bytes":0},"last":{"removed":2,"bytes":500000,"skipped":0}}` —— 跑着时放进去的死进程 `full-<pid>.tmp.mov` 与 `html-cache/live-<pid>-*` 由帧库管理器的检查删掉（`lastLeftoverSweep.removed = 2`，不是启动清理删的），`leftovers.bytes` 归零；原有的淘汰顺序 `p1,p1,p2,p2,p3,p3`、`busy:busy` 跳过、清理缓存 `freedBytes 100000000` 都照旧 |
| 界面探针 | `node scripts/probes/storage-ui-probe.mjs --port 5703 --out <scratch>\ui-shots` | 最终一次 `ok: true`、`fails: []`、`pageErrors: []`。新加的 U7（不拦截）：真的 `GET /api/storage` 与 `GET /api/exports` 都 `ok: true`；导出一栏 `{bytes 66060374, count 3, intermediateBytes 34603008}` = 列表合计（vision 不算）；删一份、只删中间文件之后两边都是 `{34603051, 2, 3145728}`；缺省上限显示「0 B / 上限 50.0G（缺省）」；真的「清理缓存」后「上次清理缓存 20:22」；填 20 发 `20000000000`，服务端 `capBytes 20000000000`、`capSource user`，回显「上限 20.0G」。U1～U6 照旧过（U5 仍是拦截那一版，GB 改成 1e9） |
| 实导 | 起 5700（`PROMPTCUT_EXPORT_DIR`、`PROMPTCUT_DATA_DIR` 指 scratch），`node <scratch>\storage-merge\run-export.mjs http://127.0.0.1:5700 6` | `status: done`，180/180；目录 `export-20260929-202254` 里只有 `overlay.mov`（42009105）、`preview.mp4`（167625）、`project.json`（872）。`GET /api/exports` 列出这一份（`finished: true`、`intermediateBytes: 0`、项目名 `storage-merge-probe`）；`GET /api/storage` 的 `exports` 为 `{42177602, 1, 0}`。开始页上点「删除」，确认框「删除导出「storage-merge-probe（20:22）」？这会删掉磁盘上的文件（42.2M）…」，提示「已删除，腾出 42.2M。」，列表空、目录没了，`/api/storage` 的 `exports` 立刻变 `{0, 0, 0}` |
| G0-R 导出确定性 | `node scripts/verify-determinism.mjs --url "http://127.0.0.1:5700/?export=1"` | 1800/1800 相同，退出 0 |
| G0-R 像素基线 | `node <scratchpad>\compare-frames.mjs …\pc-g0r-base\out\verify-a\frames …\storage-merge\out\verify-a\frames` | total 1800、identical 1800、different 0、missing 0、extra 0（`pc-g0r-base` 只读） |
| G0-R 快照重放 | `node scripts/verify-unified-frames.mjs --origin http://127.0.0.1:5700` | PASS（这台不设 `PROMPTCUT_EXPORT_DIR`） |
| 就绪索引探针 | `node scripts/probes/ready-index-probe.mjs --port 5703` | 退出 0，`ok: true`、`fails: []` |
| 轨道流探针 | `stream-produce-probe --origin http://127.0.0.1:5700`、`--group` | 两次都退出 0、PASS、`fails: []` |
| 预览兜底探针 | `preview-fallback-probe --origin http://127.0.0.1:5700`、`--page-preload` | 两次都退出 0、PASS；各段 `transparentBeats` 全 0 |

截图（看过的打了 ✓），目录 `C:\Users\admin\AppData\Local\Temp\claude\C--Users-admin-Documents-PromptCut\33960a81-c3e7-4589-8c3f-514fe979f675\scratchpad\storage-merge\`：

- ✓ `real-library-before.png`：G0-R 那台跑完探针后，开始页「存储」显示真实帧库「86.3M / 上限 50.0G（缺省）」、导出 0 份。
- ✓ `real-export-before.png`：实导之后，列表里有「storage-merge-probe · 20:22 · 42.2M · 成片 167.6K · 透明层 42.0M」，导出产物 42.2M · 1 份。
- `real-export-after-delete.png`：删之后。
- `ui-shots\` 下：✓ `u1-storage.png`（真 `/api/storage`，50.0G 缺省）、✓ `u7-real-cap.png`（改上限后「上限 20.0G」；这张是改文案之前的一次，上面的「上次自动清理」就是那时发现的问题）、`u7-real-cleared.png`、`u2-pruned.png`、`u3-deleted.png`、`u4-menu-from-start.png`、`u4-menu-from-editor.png`、`u5-*.png`。

## 没做成的、没做的

- ~~帧库的字节数滞后~~：第二轮已处理，见下「第二轮」。
- `/api/exports*` 的错误回包没加 `code`（见上表），没改。
- 独立渲染主机 / 用户 PC 第一次运行的淘汰问题（storage-cap 报告「需要主会话定的事」1、2）没动。

## 给语义的更正清单（`mechanism/platforms.md`「帧库」，主会话来写）

1. **遗留文件在「启动时与每次检查时」清**：检查 = 启动宽限后的第一次、每 5 分钟节拍、预加载后台一趟做完（最多每 5 分钟）、改上限时；「清理缓存」前也清一次。`PROMPTCUT_STORAGE_EVICT=0` 只停淘汰，遗留照清。只对名为 `frame-library` 的帧库根动手。
2. **遗留形态**补全（storage-leaks 报告第 1 条）：`<键>/mov/full-<pid>.tmp.mov`、`controls/<键>/mov/full-<pid>.tmp.mov`、`<键>/mov/playback-<pid>-<uuid>.mov`、`<键>/html-cache/live-<pid>-*`、`<键>/preview-<pid>.tmp.mp4`、`tracks/<键>/preview-<pid>.tmp.mp4`；pid 所指进程已不在才算。旧版不带 pid 的 `playback-<uuid>.mov` **1 小时**没动算遗留（不是 storage-cap 原来的 10 分钟）。
3. **`leftovers.bytes`** 是按上面同一套规则计的、清完之后还剩的（删不掉的、属主还活着的不算）。
4. **导出产物的目录名**：`export-YYYYMMDD-HHMMSS`，同一秒重名依次加 `-2`、`-3`……；列表、`/api/storage` 的导出一栏、导出完成后的收拾是同一套规则，只认导出目录直接下面的真目录，不跟链接。
5. **单位**（第二轮按主会话定改）：**GB 按 1024³ 字节**。缺省上限 50 × 1024³（53687091200）、下限 5 × 1024³、「磁盘总容量小于 500 GB 取 10%」的 500 GB 也是 500 × 1024³（所以标称 500 GB、512 GB 的盘都算小盘）；「存储」一块的显示与输入都按 1024（填 20 发 20 × 1024³）。
9. **占用数字的新鲜度**（第二轮）：`GET /api/storage` 时若上一次检查或量早于 **60 秒**，后台量一次（并进别的进程的使用、清遗留、增量量，**不淘汰**、不动淘汰的节拍），这次回包立刻回、`frameLibrary.scanning: true`；开始页见到 `scanning` 隔 **3 秒**再取，直到为 false，最多再取 **10 次**。
6. **推送队列**：段的键目录被淘汰（或清理缓存删掉）后，这一段丢掉、不重试（日志 `push.evicted`），换机取用时那一段就没有了，需要时由持有它的机器重新预渲染。
7. **盘上布局**（storage-cap 报告第 7 条照旧）：帧库根下 `usage.json`、`.storage/`（`owner.json`、`touch/<pid>.json`、`trash/`）；遗留清理与淘汰都不碰 `.storage/`。
8. 接口约定（`docs/plan/storage-plan.md` 第 4 节）可补：`GET /api/storage?detail=1` 另带 `units`、`lastEvictDetail`、`lastLeftoverSweep`；`lastEvict.reason` 为 `cap` 或 `clear`；`/api/exports` 的 `running` 与 409 回包（storage-ui 报告已提）。

## 第二轮（主会话审过后定的两处，提交 `61dea3a6`）

### 1. 单位统一按 1024

- 服务端 `frame-library-storage.mjs`：`GB = 1024 ** 3`，于是 `DEFAULT_CAP_BYTES = 50 × 1024³ = 53687091200`、`MIN_CAP_BYTES = 5 × 1024³`、`SMALL_DISK_BYTES = 500 × 1024³`。接口回包里的 `capBytes`、`minCapBytes` 随之变（例：`"capBytes":53687091200`）。
- 界面 `StartPage.tsx`：「存储」一块改回用 `humanSize`（1024），`GB = 1024 ** 3`；第一轮加的十进制 `storageSize` 去掉（留作 `humanSize` 的别名）。缺省上限显示「50.0G」，填 20 发 `21474836480`。
- 单测：`GB === 1024 ** 3`、`DEFAULT_CAP_BYTES === 53687091200`、256 GB 盘取 `floor(256 × 1024³ × 0.1)`、标称 500e9 的盘算小盘。探针：`storage-cap-probe` 的缺省上限期望按 1024³；`storage-ui-probe` 的 U5、U7 按 1024³。
- 第一轮上表「GB 口径（改了）」那一行作废：现在两端都是 1024³。

### 2. 占用数字过期

- 管理器新方法 `refreshIfStale({ maxAgeMs = SUMMARY_STALE_MS = 60 s })`：距上一次检查或量超过 60 秒就在串行链上发起一次 `measureNow()`（成为主进程、索引缺失时重扫、清遗留、并进别的进程的使用、增量量、落盘），**不淘汰**，也不改 `lastCheckAt`（启动 2 分钟宽限与每 5 分钟最多一次的淘汰检查照旧，不会因为有人看开始页就提前淘汰）；在量时再调不重复发起。`summary().scanning` = 重扫中或这一趟在量。
- `GET /api/storage`（`storage-routes.mjs`）先调 `refreshIfStale()` 再取 `summary()`，不等量完。
- 开始页：回包 `scanning: true` 时隔 3 秒再取，直到 false，最多 10 次（`STORAGE_RESCAN_MS`、`STORAGE_RESCAN_TRIES`）；自动重取时上限输入框只在上限变了才更新，不冲掉用户正在填的数。
- 单测（`frame-library-storage.test.mjs` 新两条）：新写的键在检查前数字是旧的；`refreshIfStale()` 回 true、`summary().scanning` 为 true、在量时再调不重复；量完 `bytes` 是真实值、`scanning` false；上限远低于总量也不删、`lastEvict` 仍为 null；60 秒内不再发起、过了再发起。路由：GET 调一次、回包 `scanning` 照实，POST 不调。
- 探针 `storage-ui-probe` 新 U8（最先跑）：就绪后往帧库写一批 5 帧共 5 MiB，等满 60 秒不发请求，再打开开始页。结果 `{"first":"0 B / 上限 50.0G（缺省）","settled":"5.0M / 上限 50.0G（缺省）","elapsedMs":4272,"serverBytes":5242880,"scanning":false}`——打开时是旧数，4.3 秒后自动变成真实值。截图 `scratchpad\storage-merge\ui-shots2\u8-fresh-bytes.png`（看过：「5.0M / 上限 50.0G（缺省）」）。

### 第二轮验证

| 项 | 结果 |
|---|---|
| `node --test server/test/frame-library-storage.test.mjs` | 29/29 过 |
| `npx tsc -b --force` | 退出 0 |
| `npm test` | tests 3952、pass 3950、fail 0、skipped 2，退出 0；没有挂的文件 |
| `npm run build` | 退出 0 |
| `node scripts/probes/storage-cap-probe.mjs --port 5700`（真接口） | `ok: true`、`fails: []`；`start.capBytes 53687091200`（50 × 1024³，缺省）；③a `leftoverSweep.last.removed 2`、`leftovers.bytes 0`；淘汰 `p1,p1,p2,p2,p3,p3`、`busy:busy`；清理缓存 `freedBytes 100000000` |
| `node scripts/probes/storage-ui-probe.mjs --port 5703 --out <scratch>\ui-shots2`（真接口，U5 另有一段拦截） | `ok: true`、`fails: []`；U8 见上；U7 改上限 `sentBytes 21474836480`、服务端 `capBytes 21474836480`、回显「上限 20.0G」，缺省「上限 50.0G（缺省）」 |

G0-R 没重跑：第二轮只改了存储管理器的量与单位、`/api/storage` 路由和开始页，不碰预渲染、导出与渲染路径。跑完 5700～5709 无监听，没有命令行含 `storage-merge` 的 node 进程。

## 需要主会话定的事

1. ~~GB 口径~~、~~字节数滞后~~：第二轮已按主会话定的做完。
2. 合并：本分支在 `abd6ee56`（四支合入之后）之上，只动了 `server/storage-leftovers.mjs`、`server/exports-list.mjs`、`server/frame-library-storage.mjs`、`server/artifact-push.mjs`、`src/StartPage.tsx`、两个探针、三个测试文件与一个新测试文件。
