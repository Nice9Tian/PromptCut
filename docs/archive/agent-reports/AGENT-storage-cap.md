# AGENT 报告：storage-cap

分支 `claude/storage-cap`，worktree `.worktrees/storage-cap`，起点 main `35f1fddd`，端口段 5710～5719。

任务：存储占用计划（`docs/plan/storage-plan.md`）的 B 部分——帧库的使用索引、容量上限、按最近使用淘汰、「清理缓存」、`/api/storage*`。
「B 部分」指计划第 2 节分出的第二块（上限、淘汰与入口）；A 部分（泄漏修复）归 `claude/storage-leaks`，界面与 `/api/exports*` 归 `claude/storage-ui`。

## 做了什么

| 文件 | 改动 |
|---|---|
| `server/frame-library-storage.mjs`（新） | 使用索引、上限、淘汰、清理缓存、主进程锁、导出汇总 |
| `server/storage-routes.mjs`（新） | `GET /api/storage`、`POST /api/storage/cap`、`POST /api/storage/clear-cache` 的处理 |
| `server/vite-plugin-frames.ts` | 预渲染进程建管理器并接上管线；挂 `/api/storage` 路由（编辑器进程转发）；dev server 关闭时关管理器 |
| `server/frame-pipeline.mjs` | **只加 4 处、共 12 行**（见下「与并行分支的交集」） |
| `server/ready-index.mjs` | 就绪索引加 `unstage`（淘汰删掉目录后摘掉挂着的键） |
| `server/test/frame-library-storage.test.mjs`（新） | 单测 20 条 |
| `scripts/probes/storage-cap-probe.mjs`（新） | 端到端探针 |

### 使用索引

- 位置：帧库根下 `usage.json`（原子写：临时文件再改名，目标被占时退避重试）。按键目录记 `[最近使用时刻, 字节数, 其中遗留文件字节, 量的时刻]`，键是相对帧库根的路径：`<entryKey>`、`controls-local/<entryKey>`、`controls-html/<键>`、`controls/<键>`、`streams/<键>`、`tracks/<键>`（键一律 64 位十六进制，别的名字不认）。
- 记使用（`touchEntry`）：
  - `preload()` 一拿到 entry 就记（此时只知道整场景与本地档）；
  - `recordCardPlan()` 记（任何 lane 用到这一版计划时，键集合按 card plan 取：`control.key` → `controls/`，共享档的 `snapshotKey` → `controls-html/`；轨道前缀按 `prefixes(entry)`；轨道流按生产者里 `entryKey` 等于这一版的流）；
  - `preload()` 后台那一趟结束时再记一次（此时轨道流才有），并按节拍判一次要不要淘汰（`afterBatch`）；
  - 项目开着时每 5 分钟再记一次（管理器自己的节拍）。「开着」= 就绪索引里有订阅者、或 10 分钟内发过 preload 的会话的当前版本，加上 10 分钟内活动过的后台代次。
- 字节数增量维护：记过使用的键在下一次检查时重量（它们正在被写）；每次检查列一遍各族目录的**名字**（不进去），新出现的键量一次、消失的从索引删掉。全量重扫只在索引缺失、读不懂、或距上次全量超过 24 小时时做，都在管理器的串行链上异步跑，不挡预加载。
- 索引缺失（含第一次运行）按目录重扫，最近使用时刻取目录里最新文件（含子目录）的修改时刻。
- 量目录时顺便把计划第 3.3 节「遗留文件」那几种（死进程的 `html-cache/live-<pid>-*`、`full-<pid>.tmp.mov`、`preview-<pid>.tmp.mp4`，以及 10 分钟没动过的 `playback-*.mov`）的字节单独记，`GET /api/storage` 的 `leftovers.bytes` 就是它们的和。**不删它们**（启动清理归 storage-leaks）。

### 上限

- 缺省 50 GB；所在磁盘总容量（`fs.statfs` 的 `blocks × bsize`）小于 500 GB 时取总容量的 10%。GB 按十进制（1e9），和磁盘厂商标的口径一致：512 GB 的盘不算小盘。
- 用户值存数据目录（`PROMPTCUT_DATA_DIR`，缺省 `<viteRoot>/out`，和 `costs-store.mjs` 同一口径）的 `storage.json`，字段 `frameLibraryCapBytes`；允许 5 GB 到磁盘总容量，越界的请求 400 `CAP_OUT_OF_RANGE`（带 `min`、`max`）；文件里已有的越界值读时收进范围。
- 测试钩子：`PROMPTCUT_TEST_STORAGE_MIN_CAP`（字节）把下限调小，只给探针；`PROMPTCUT_STORAGE_EVICT=0` 只记只量不删（给独立渲染主机等不想淘汰的场合留的开关，缺省开）。

### 淘汰与清理缓存

- 淘汰单元：整场景目录和它的 `controls-local/<entryKey>` 是一个单元（一起判、一起删），其余每个键目录一个单元。单元的最近使用时刻取其中各键的最大值。
- 时机：管理器启动时（索引读完或重扫完）检查一次；每次预加载后台那一趟做完、以及每 5 分钟节拍，最多每 5 分钟检查一次；改上限立即检查一次。
- 超上限时按最近使用从旧到新删，删到上限的 90% 就停；30 分钟内用过的、正在打开的项目的键不删。
- 删法：先 `rename` 进 `<帧库>/.storage/trash/`，再递归删垃圾目录。实测 Windows 上目录里任何文件被打开（含 Node 以 FILE_SHARE_DELETE 打开的）时目录改名失败（EPERM），所以「被别的进程打开」的单元整个跳过、一个文件都不删，下一轮再试；垃圾目录删不完的下一轮接着删。
- 安全：只认帧库根下六种形状；键目录本身、所在的族目录、目录里任何一处是符号链接或 junction 的整单元跳过（沿用 `prerender-cache-prune.mjs` 的做法）；认不出的目录和文件（`controls-lock`、`push-queue.json`、别的名字）不计、不删。
- 删完在本进程里把指着被删目录的内存状态清掉：整场景 entry 从 `pipeline.entries` 删、同键的后台代次作废（否则回到那一版时 `preload` 走「同一个 entry 直接返回」不重渲）；就绪索引挂着的键摘掉（新加的 `unstage`）；流清单缓存删掉。
- 清理缓存：删 10 分钟内没用过的全部单元（正在打开的项目不删），删完才回 `{ freedBytes, removed, skipped }`。

### 接口（计划第 4 节）

- `GET /api/storage` → `{ ok, frameLibrary: { bytes, capBytes, capSource, diskBytes, pinnedBytes, scannedAt, lastEvict, scanning, owner, minCapBytes }, exports: { bytes, count, intermediateBytes }, leftovers: { bytes } }`。`pinnedBytes` = 受保护（30 分钟内用过或正在打开）的单元的字节。多出的 `scanning`、`owner`、`minCapBytes` 给界面判状态。`?detail=1` 另带每个单元的明细和上一轮淘汰删了哪些、跳过哪些（探针与诊断用）。
- `exports`：导出目录下 `export-*`（不含 `export-vision-*`）的总字节与份数；`intermediateBytes` = 每份里 `preview.mp4`、`overlay.mov`、`project.json` 以外的字节（计划第 3.3 节的中间文件名单）。60 秒缓存，过期先回旧值、后台刷新。
- `POST /api/storage/cap { bytes }` → `{ ok, capBytes }`，立即判一次（不等删完）。
- `POST /api/storage/clear-cache` → `{ ok, freedBytes, removed, skipped }`。
- 扫描与淘汰在预渲染进程里做；编辑器进程只认这三条路径，原样 `proxyToPrerender`。都挂在 `/api/storage` 下，`vite-plugin-api-guard.ts` 排在全部插件之前，所以在同源守卫之后。在线构建没有 dev server、这块也没有客户端代码，不产生 `/api` 调用；客户端的剪枝写法（`src/online/pageFlag.ts`）由界面那一支在调用处照写。

### 多进程

- **谁写索引**：同一帧库同一时刻只有一个「主进程」写 `usage.json`、做淘汰。主进程持有 `<帧库>/.storage/owner.json`（`{ pid, at }`，每分钟心跳）；3 分钟没心跳、或 pid 不在了，别的进程可以接管（两个同时接管时各写各的、稍等再读，留下的那个赢）。关闭时放锁。
- **别的进程的使用**：不是主进程的（例如无头实例 Skill 起的另一个预渲染进程共用同一帧库）把自己记的使用写进 `<帧库>/.storage/touch/<pid>.json`（只有它自己写，防抖 60 秒），主进程每次检查时并进索引（取较大的时刻），pid 不在了的文件并完即删。它们对 `clear-cache`、`cap` 回 409 `STORAGE_NOT_OWNER`，`GET` 照答（读的是自己手里那份）。
- **编辑器进程**不建管理器：它的管线是 `interactive: false`，几乎不写帧库；`/api/storage*` 它转给预渲染进程。
- 没人记过使用的目录（编辑器进程或别的工具写的）按目录里最新文件的修改时刻兜底：新写的目录天然落在 30 分钟保护窗里。

## 与并行分支的交集（合并时注意）

`server/frame-pipeline.mjs` 只加了 4 处：

1. 构造函数里 `this.usage = null;`（带注释，在 `this.pushQueue = pushQueue;` 之后）；
2. `preload()` 里 `const entry = await this.entry(project);` 之后一行 `this.usage?.touchEntry(entry);`；
3. `preload()` 后台那一趟 `finally` 末尾两行 `this.usage?.touchEntry(entry); this.usage?.afterBatch();`；
4. `recordCardPlan()` 末尾 `return plan;` 之前一行 `this.usage?.touchEntry(entry);`。

没有碰 `publishLayerMap`、`playback-*.mov`、tmp 文件与启动清理，也没有碰 `vite-plugin-export.ts`。

与 storage-leaks 的衔接建议：计划第 3.3 节说遗留文件「启动时与每次淘汰时一并清掉」。本分支只把遗留文件的字节算进 `leftovers.bytes`，没有删；若 storage-leaks 导出一个清理函数，合并时可以在 `checkNow()` 里淘汰之前调一次。

## 验证

PC 上跑，机器有负载。dev server 都是本分支自己起的（5710，舞台 5711、5712；`ready-index-probe` 自己起 5713～5715），跑完已停；预渲染子进程的端口由 `freePort()` 随机取，不在 5710～5719 段内（现有机制，没改）。

| 项 | 命令 | 结果 |
|---|---|---|
| 单测（本分支） | `node --test server/test/frame-library-storage.test.mjs` | 21 条全过 |
| 类型检查 | `npx tsc -b --force` | 退出 0，零错误 |
| 全量测试 | `npm test` | 第一次（加启动宽限之前）：tests 3896、pass 3894、fail 0、skipped 2，退出 0；最终代码（`84d9b24c`）：tests 3897、pass 3895、fail 0、skipped 2，退出 0。两次都没有挂的文件，不需要单独重跑 |
| 本任务探针 | `node scripts/probes/storage-cap-probe.mjs --port 5710` | 跑了两次（`16587346` 与最终代码），都退出 0，`ok: true`、`fails: []`（最后一行 JSON 见下） |
| G0-R 导出确定性 | `node scripts/verify-determinism.mjs --url "http://127.0.0.1:5710/?export=1"` | 1800/1800 相同，退出 0 |
| G0-R 像素基线 | `node <scratchpad>\compare-frames.mjs …\pc-g0r-base\out\verify-a\frames …\storage-cap\out\verify-a\frames` | total 1800、identical 1800、different 0、missing 0、extra 0 |
| G0-R 快照重放 | `node scripts/verify-unified-frames.mjs --origin http://127.0.0.1:5710` | PASS |
| 预渲染探针 | `node scripts/probes/ready-index-probe.mjs --port 5713` | 退出 0，`fails: []` |
| 预渲染探针 | `stream-produce-probe --origin http://127.0.0.1:5710`、`--group` | 两次都 PASS，`fails: []` |
| 预渲染探针 | `preview-fallback-probe --origin http://127.0.0.1:5710`、`--page-preload` | 两次都退出 0、PASS；各段与合计 `transparentBeats` 全是 0 |

说明：

- 第一次跑 `verify-unified-frames` 时 dev server 带着 `PROMPTCUT_EXPORT_DIR=<scratchpad>`，脚本把测试视频写在 `<worktree>/out/media`、页面却从导出目录的 `media` 取，回 404（`Video decode failed`）——是环境不匹配，不是本分支的改动。去掉 `PROMPTCUT_EXPORT_DIR` 重起 5710（帧库落在 `<worktree>/out/frame-library`）后 PASS；之后的预渲染探针都在这台上跑。导出确定性与像素基线是在带 `PROMPTCUT_EXPORT_DIR` 的那台上跑的（与导出目录无关）。建议 `compare-pitfalls.md` 记一句：`verify-unified-frames` 要求 dev server 用缺省导出目录。
- 跑完之后在那台 dev server 上 `GET /api/storage`：`bytes 80339049、capBytes 50000000000、capSource default、diskBytes 1999249600512、pinnedBytes 80339049、owner true、scanning false`——预渲染探针开的项目都记为使用、在保护窗里。

探针最后一行（第一次跑）：

```json
{"ok":true,"fails":[],"port":5710,"createdBytes":163000000,"start":{"bytes":163000000,"capBytes":50000000000,"capSource":"default","diskBytes":1999249600512,"owner":true,"exports":{"bytes":6002,"count":1,"intermediateBytes":5000},"leftovers":{"bytes":0}},"projectEntry":"105b291e23f6","projectUnits":[{"unit":"entry:105b291e23f660ffd0d7","bytes":0,"pinned":true},{"unit":"tracks/105b291e23f660ffd0d","bytes":0,"pinned":true},{"unit":"controls/2be282b083fd93919","bytes":0,"pinned":true},{"unit":"controls-html/8dd41890d083","bytes":0,"pinned":true},{"unit":"streams/435a8675e9f61d7c57","bytes":0,"pinned":true}],"projectBytes":7483765,"evict":{"total":170483765,"cap":122204183,"target":109983764,"measured":true,"removed":["p1","p1","p2","p2","p3","p3"],"skipped":["busy:busy"],"after":107483765,"capSource":"user","detail":{"before":170483765,"after":107483765,"targetBytes":109983764,"lastRemoved":5000000}},"clear":{"before":107483765,"after":7483765,"ok":true,"freedBytes":100000000,"removed":9,"skipped":0}}
```

（`projectUnits` 的 `bytes: 0` 是打开之后、下一次检查之前的样子：刚记使用的键在检查时才量，探针随后先设一次大上限触发检查，量完才算目标。）

探针最后一行（最终代码）：

```json
{"ok":true,"fails":[],"port":5710,"createdBytes":163000000,"start":{"bytes":163000000,"capBytes":50000000000,"capSource":"default","diskBytes":1999249600512,"owner":true,"exports":{"bytes":6002,"count":1,"intermediateBytes":5000},"leftovers":{"bytes":0}},"projectEntry":"105b291e23f6","projectUnits":[{"unit":"entry:105b291e23f660ffd0d7","bytes":3567043,"pinned":true},{"unit":"tracks/105b291e23f660ffd0d","bytes":1023811,"pinned":true},{"unit":"controls/2be282b083fd93919","bytes":2446768,"pinned":true},{"unit":"controls-html/8dd41890d083","bytes":431091,"pinned":true},{"unit":"streams/435a8675e9f61d7c57","bytes":15050,"pinned":true}],"projectBytes":7483763,"evict":{"total":170483763,"cap":122204181,"target":109983762,"measured":true,"removed":["p1","p1","p2","p2","p3","p3"],"skipped":["busy:busy"],"after":107483763,"capSource":"user","detail":{"before":170483763,"after":107483763,"targetBytes":109983762,"lastRemoved":5000000}},"clear":{"before":107483763,"after":7483763,"ok":true,"freedBytes":100000000,"removed":9,"skipped":0}}
```

（这一次打开项目后 `bytes` 已经有数：启动检查推迟到宽限期之后，preload 后台那一趟做完的 `afterBatch` 成了第一次检查，顺带量了。）

G0-R 各项跑在 `6bec8c85`（含启动宽限）上；之后的 `84d9b24c` 只改了导出汇总认目录的正则，不涉及渲染。`preview-fallback-probe` 两次跑时 dev server 已按 `84d9b24c` 重载。

## 没做成的及原因

- 遗留文件只计不删：计划第 3.3 节写「启动时与每次淘汰时一并清掉」，任务书把启动清理划给 storage-leaks，本分支没有删它们的代码，只把字节算进 `leftovers.bytes`。合并后若要「每次淘汰时一并清掉」，在 `checkNow()` 里调 storage-leaks 的清理函数即可。
- 别的进程内存里的状态：淘汰只清主进程自己管线里指着被删目录的 entry、就绪索引挂着的键、流清单缓存。非主进程（例如无头实例的预渲染进程）若内存里还留着 30 分钟以上没用过的 entry，回到那一版时会按缺帧重渲（快照读不到按 404 处理），没有做跨进程通知。
- 推送队列（C6.4，连得上素材服务时）里还没推完的段如果属于被淘汰的键，推送会读不到文件；没有专门处理，也没测（这台桌面没有 `push-queue.json`）。

## 与计划第 3.3 节不一致之处、需要主会话定的事

与第 3.3 节的出入（数字、时机、盘上布局），合并写语义时请据此改：

1. **启动宽限 2 分钟**：第 3.3 节写「启动扫完后」检查。实现是索引缺失时马上重扫（只量不删），第一次判淘汰等 2 分钟——不然用户昨天开着的项目可能在页面重发 preload 之前就被判成最久没用的删掉。
2. **检查时机**：「每次预加载或预渲染一批做完后」落实为「preload 后台那一趟做完」加每 5 分钟的节拍，最多每 5 分钟一次；队列细任务每一批之后没有单独挂钩（节拍兜底）。
3. **正在打开的项目显式保护**：除 30 分钟窗口外，淘汰与清理缓存都跳过「开着」的项目的键（就绪索引里有订阅者或 10 分钟内发过 preload 的会话）。
4. **淘汰单元**：整场景目录与它的 `controls-local/<entryKey>` 是一个单元；最近使用取两者较大的。
5. **全量重扫**：除索引缺失外，每 24 小时全量重扫一次校正字节数（新数字）。
6. **GB 按十进制**（1e9）：「50 GB」「500 GB」「5 GB」都是十进制，与磁盘标称一致。
7. **盘上布局**：帧库根下除 `usage.json` 外还有 `.storage/`（`owner.json` 主进程锁、`touch/<pid>.json` 别的进程的使用、`trash/` 删到一半的垃圾目录）；`storage.json` 的字段名 `frameLibraryCapBytes`。
8. **开关**：`PROMPTCUT_STORAGE_EVICT=0` 只记只量不删；`PROMPTCUT_TEST_STORAGE_MIN_CAP` 仅测试。
9. **接口**：`GET /api/storage` 多了 `scanning`、`owner`、`minCapBytes` 与 `?detail=1`；`exports` 的目录规则已按主会话转来的界面那一支口径改（只认 `export-YYYYMMDD-HHMMSS` 与同秒后缀 `-n` 的真目录、排除 `export-vision-*`、中间文件 = 总量减 `preview.mp4` / `overlay.mov` / `project.json`、不跟链接），合并时主会话改成直接引 `server/exports-list.mjs` 的 `summarizeExports`。

需要主会话（和用户）定的事：

1. **用户那台 PC 上的第一次运行**：合并、装上之后，桌面版预渲染进程第一次起来会全量重扫约 282 GB（几分钟的磁盘读），2 分钟宽限后按缺省 50 GB 上限（2 TB 盘不算小盘）删到 45 GB，也就是一次删掉约 230 GB 的预渲染结果（删之前先改名进垃圾目录，删的过程在后台）。这是语义要的行为，但不可逆；要不要先让用户在开始页设好上限、或先带 `PROMPTCUT_STORAGE_EVICT=0` 跑一版，请定。主工作区 `npm run dev`（5190）的 `out/frame-library` 同理。
2. **独立渲染主机 / 云端渲染节点**：它们也跑同一个预渲染进程，也会按 50 GB 淘汰。要不要在那里缺省关掉（`PROMPTCUT_STORAGE_EVICT=0`）。
3. **与 storage-leaks、storage-ui 的衔接**：见上「没做成的」第一条与「接口」第 9 条。

## 事故：碰了主工作区（已查明）

主会话报告主工作区出现一个 0 字节的 `server/test/frame-library-storage.test.mjs`（主会话已删）。原因：本分支早先有两条 PowerShell 命令用 `[IO.File]::ReadAllText('server\…')` 这种**相对路径**，.NET 按进程的当前目录（主工作区）解析，而不是 PowerShell 的 `cd`：

- 改测试文件那一条：读主工作区里不存在的同名文件失败，随后的 `WriteAllText` 把空内容写成了主工作区里的 0 字节文件；
- 更早改 `vite-plugin-frames.ts` 的那一条：读到了主工作区的 `server/vite-plugin-frames.ts`，替换没匹配上（换行是 CRLF），原样写了回去——内容逐字节不变（主工作区 `git status` 干净），但修改时刻变成 19:25:06。用户常驻的 5190 dev server 可能因此重载过一次这个插件。

之后所有读写与命令都只用 worktree 下的绝对路径，没有再用 .NET 的相对路径 API。

## 主会话审查（2026-09-30，笔记本主会话）

- 审过淘汰与清理缓存的删除路径：30 分钟内用过的与正在打开的项目不删；先改名进 `.storage/trash/`，改名失败跳过；链接跳过；多进程只持锁的那个淘汰。
- 最终合流上 `storage-cap-probe` 过（缺省上限 53687091200 字节）。「需要主会话定的事」里第一次运行的淘汰，按已定的 50 GB 上限办，发版通知里告诉用户。
- 合入 main `fe62c17f`。
