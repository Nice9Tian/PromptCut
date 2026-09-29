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

（验证结果见下，逐项补。）

## 没做成的及原因

（见下。）

## 与计划第 3.3 节不一致之处、需要主会话定的事

（见下。）
