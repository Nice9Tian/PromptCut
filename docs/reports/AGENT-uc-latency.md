# AGENT 报告：在线浏览器模式里用户卡出结果太慢（claude/uc-latency）

- 分支 `claude/uc-latency`，起点 main `76eee894`（v0.7.2）；端口段 5740～5749。
- 任务：交接文件 `HANDOFF-2026-09-29.md` 第 4 节第一条、第 6 节第 1 条（浏览器里的用户卡要等桌面渲染节点渲完页面发布的清单计划才有结果，笔记本 A4 196 s）。
- 代号：A3 / A4 = `desktop-auto-node-probe` 的两步（A3：另一台设备的在线页面进项目、贴出用户卡 U1；A4：桌面页面关掉后在线页面改用户卡 U2、由桌面节点认领渲完、在线页面换上）。一段 = 队列的一个快照细任务，60 帧。

## 进度

主会话 2026-09-29 要求交接笔记本、本轮停在这里：两处改动都已提交，改后的探针跑过一部分（见第四节），**基线（`npm test`、G0-R）没跑**，见第五节。

提交（worktree 分支上，没推）：

| 提交 | 内容 |
|---|---|
| `130838ee` | 开工建报告 |
| `0aa7483a` | 诊断:`executor.render-timing` 分段耗时(不改行为);探针计时、收尾不挂 |
| `ba74f3a7` | **改法 1**:预览视频的 PNG 活挪到 worker 线程;另加排障日志 |
| `78d36cdf` | **改法 2**:队列的一段一趟顺推 + 对照探针 + 单测 QSP1～3 |
| `aba6a01e`、`1ed86bd9` | 报告;对照探针判据;c10-browser-probe 收尾不挂 |
| `19ceae14` | 单测 QSP4～6 |
| `a5301a54` | 撤掉 `chrome.mjs` 的排障日志(它在 snapshotCode 里);探针记每处等待 |
| 本次 | 报告收尾 |

## 一、时间线分解（改前，PC）

`desktop-auto-node-probe --base-port 5740 --skip-off`，代码：base1 = main + 探针计时；base2～6 另加只记日志的诊断（不改行为）。

| 遍 | A3 进项目→贴出 U1 | A4 改动→贴上 | A4 其中：页面发布 / 节点认领 / 云端层表齐 |
|---|---|---|---|
| base1 | 100.8 s | 197.7 s | +0.8 / +3.6 / +197.7 s |
| base2 | 88.8 s | 224.9 s | +0.8 / +3.6 / +224.9 s |
| base3 | 117.0 s | 200.4 s | +0.8 / +3.6 / +200.4 s |
| base4 | 129.2 s | 254.8 s | +0.8 / +3.6 / +254.8 s |
| base5 | 88.9 s | 236.7 s | +0.8 / +3.6 / +236.7 s |
| base6（期间对预渲染进程抓 CPU 剖析） | 109.3 s | 248.9 s | +0.8 / +3.6 / +248.9 s |
| **中位** | **105 s** | **230 s** | |

页面发布、队列认领都在 4 秒以内；云端层表齐与页面贴上之间不到 0.1 s（页面收到 `task.done` 就重取层表）。**时间全在桌面节点渲那两段上。**

逐段（诊断行 `executor.render-timing`，毫秒，用户卡 `mu-animated-shiny-text`，stateful）：

| 段 | 总 | 换页（15 批） | 其中画小尺寸 | 推帧 | 回放帧数 | 入库 |
|---|---|---|---|---|---|---|
| 正常的 0-59 | 21 500～23 900 | 13 600～15 300 | 3 500～4 100 | 6 200～6 800 | 480 | 110～180 |
| 正常的 60-119 | 22 400～26 900 | 12 500～15 900 | 2 000～4 700 | 8 200～9 900 | 1 380 | 150～180 |
| A4 里慢的那一段（base3） | 171 238 | 135 179（单次最多 47 523） | 20 790 | 26 794 | 480 | 7 496 |

## 二、占大头的原因

### 1. A4 每遍都有一段慢 5～8 倍：预渲染进程的主线程被整段预览视频的 PNG 编解码占满（根因，已修）

- 现象：A4 里总有一段 60 帧要 170～210 s（base2 那一段还因「导出页 60 秒没就绪」失败重做），各项一起变慢，连写小文件（入库）都从 0.17 s 变 7.5 s。
- 排查：诊断日志显示换页时新页面要从预渲染进程的 Vite 取 300～450 个模块，慢的时候几十秒取不完（`ready.slow`，在途 300+ 个）；那段时间整机负载只有 0～30%，但预渲染进程的 node 一直占满一个核。
  对预渲染进程抓 CPU 剖析（`process._debugProcess` + CDP `Profiler`，60 s 两段）：`filter-pack.js`（pngjs 编码）40%、`shrink`（`png-post.mjs`，棋盘格合成）17.5%、`bitmapper.js` / `filter-parse.js`（pngjs 解码）11%，都在主线程上。
- 根因：桌面自己那一版的后台预渲染一趟收尾时跑 `FramePipeline#prerender()`，为每条轨道前缀编一段 `preview.mp4`（旧预览通道用），`server/bakery/frame-video.mjs` 逐帧在主线程上 `PNG.sync.read` → `shrink` → `PNG.sync.write`，1080p 一帧上百毫秒，300+ 帧就是几分钟。主线程同时是给预渲染 Chrome 供模块的 Vite 服务和驱动 Chrome 的 CDP 连接，队列节点每换一页都要等它。探针的时序让这几分钟正好落在 A4（A3 期间桌面页面开着、它的那一趟还在前面几步）。真机上只要桌面版开着共享项目、这一版刚改过，就会撞上。
- 仓库里对同一类问题早有定论（`server/png-post.mjs` 文件头：pngjs 同步活不许跑在供模块的 Vite 进程事件循环上），这一处是漏网的。

### 2. 正常时一段 60 帧 22～27 s，其中每 4 帧换一张新页占 55～65%（已改）

- `fillCardControls` 对队列的一段也按「4 帧一批、每批换一张新页、从挂载帧回放到批首」跑：一段 15 次换页（每次约 0.75 s + 在旧页上画上一批的小尺寸）、stateful 卡第二段要回放 1 380 帧。

### 3. 其它（没改，记录）

- A3 里有一段推送回 `400 incomplete`（`素材服务 POST px/<hash>/complete 回 400`）：队列 sink 与推送队列同时推同一块，那一段按可重试失败交回、之后去重完成，多花约 5 s。推送那几段归 push-scope 子 Agent。
- 节点并发是 1（`maxConcurrent: 1`、一条 `'queue'` lane）：A3 的计划里 U1、U2 各两段，只能一段一段来；页面判「贴上」要整张卡覆盖（徽标撤掉），U1 两段可能排在 U2 之后。
- 页面侧：发布计划在测量落定后约 2.5 s（A3）/ 改动后 0.8 s（A4，防抖 800 ms）；层表、清单轮询 3 s / 2 s，但收到 `task.done` 就立刻重取，实测不是瓶颈。这些都没改。

## 三、改法

1. **预览视频的像素活挪到 worker 线程**（`server/bakery/frame-video.mjs`、新文件 `server/bakery/frame-video-worker.mjs`）：同一个函数（解码、`shrink`、编码，算法逐字不变）在 `node:worker_threads` 里做，主线程只转交字节；起不了 worker 或中途出错退回主线程（结果相同）。预渲染进程里实测起来了（日志 `[frame-video] converter.worker`）。单测 FV1～FV3：worker 结果与主线程逐字节相同。
2. **队列的一段一趟顺推**（`server/frame-pipeline.mjs` 的 `fillCardControls` 新选项 `singlePass`、判定 `queueSinglePass`）：给了 `range` 时把这一段的几批并成一批，只换一次页、只回放一次；帧集合与原来逐批的并集相同，入库与进度照旧每 4 帧一次。不走的：canvas 重卡（`canvasHeavy`，M7 探针 P2 记过异步装载的画布卡顺推与逐批不等价）、页面播放头正要这一段的帧（C4 `wanted`，照逐批让含播放头的那批先出）、`PROMPTCUT_QUEUE_SINGLE_PASS=0`。后台那一趟（整张卡，不给 `range`）一行不改。
   - 等价性（`scripts/probes/queue-single-pass-probe.mjs`：本进程起两个 `FramePipeline`，同一项目、每张共享档卡按 60 帧一段走 `renderCardSnapshotRange`，一边关掉顺推一边照新行为，逐帧比 HTML 字节，不同的再比重放像素，像素也不同的再以这张卡的顺序活渲为准）：
     - 19 张共享档卡（其余在这个项目里是本地档，不走这条路）：**14 张 120/120 帧 HTML 逐字节相同**（含用户卡 `mu-animated-shiny-text`、`punch-pill`、`mu-number-ticker`、`probe-slow-stepped` 等）；`lottie` 64 帧字节同、56 帧像素同；`particles`（canvas 重卡，两边都逐批）相同。
     - `mu-word-rotate`（AnimatePresence 换词）84 帧不同：**逐批与顺序活渲一致 0 帧、顺推一致 79 帧**。单独核对（`export-vs-snap`，12 帧抽样）：逐批从第 32 帧起就与活渲不一致，顺推第一段与活渲逐像素相同、第二段开头几帧（60、64）同样落后、之后对上。原因：逐批每批从挂载帧回放时不截图，Motion 的 JS 帧循环推不动（`bake.mjs` 注释里写过这件事），换词的相位落后。即**现行逐批对这类卡本来就与导出不一致**，顺推少了这种回放、更接近导出，不是新引入的差别。
     - `probe`、`probe-typewriter`（按 setInterval / 计时器走的 E4b 探针卡）两种都大半与活渲对不上、两次跑结果也不一样（预渲染间里本来不确定），探针只记不判。
     - 用时：同一台机器同一时刻，逐批一段 13～23 s，顺推 4.4～8.5 s（这里没挂推送队列、不画小尺寸）。
     - 最后一次跑（`--cards mu-word-rotate,probe-typewriter,probe,lottie,mu-animated-shiny-text`）`ok: true`。

## 四、改后的分段耗时（PC）

代码 `1ed86bd9`（两处改法都在；另有已撤的 `chrome.mjs` 排障日志，只记日志）。同一台 PC，同时有别的子 Agent 在跑。

`desktop-auto-node-probe --base-port 5740 --skip-off`：

| 遍 | A3 进项目→贴出 U1 | A4 改动→贴上 | A4 其中：发布 / 认领 / 云端层表齐 |
|---|---|---|---|
| fix1a（只有改法 1） | 109.0 s | 59.5 s | +0.8 / +3.6 / +59.5 s |
| after-dan2 | 40.8 s | **26.2 s** | +0.8 / +3.6 / +26.2 s |
| after-dan3 | 36.9 s | **21.2 s** | +0.8 / +1.6 / +21.2 s |
| after-dan1 | 60.8 s | **卡住没出结果**（见下） | — |

- 对比改前中位（A3 105 s、A4 230 s）：只有改法 1 时 A4 约 **3.9 倍**；两处都在时 A4 约 **9～11 倍**、A3 约 **2.6～2.8 倍**。
- 一段 60 帧（`executor.render-timing`）：改前正常 22～27 s、撞上时 170～210 s；改后 **7.1～11.1 s**（换页 1 次 0.6～0.8 s、推帧 3.6～5.4 s、第二段末尾写整卡 PNG 缓存 1.1～1.5 s）。
- **after-dan1 在 A4 卡住 30 分钟**：A3 正常（四段各 8.7～10.1 s），A4 里桌面节点再没认领到新计划（节点连着、空闲、队列诊断里只有第一版的计划，代码版本没变）；那时探针的等待不记日志，看不出卡在「等 U2 旧层」「等页面发新计划」还是「等认领」。我杀掉重跑时端口还没放，没跑成（after-dbg1）。之后 `a5301a54` 给探针每处等待加了 `wait.ok / wait.timeout` 日志。**原因没查清，待复核**（见第七节）。

`c10-browser-probe --user-card --only-a4 --no-video --base-port 5740`（用户卡那一步：成员页进项目后到用户卡整段贴上、徽标撤掉）：

| 遍 | 用户卡那一步 | 结果 |
|---|---|---|
| after-c10-1 | **75.3 s** | `ok: true` |
| after-c10-2 | **75.3 s** | `ok: true` |
| after-c10-3 | — | 主会话叫停时刚开始，已停 |

改前没在这台跑（交接文件记的 PC 数字 686.7 s，笔记本 656 s），按那个数约 **9 倍**。改前三遍没跑成：计划是临时把 `server/`、`src/` 检出成 `76eee894` 跑三遍再还原，排在改后之后，被叫停。

## 五、验证

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 0 错误（在 `1ed86bd9` 之后跑；之后只改了 `.mjs` 与测试） |
| 新单测 | `node --experimental-test-module-mocks --test server/test/frame-video.test.mjs server/test/queue-single-pass.test.mjs server/test/queue-single-pass-fill.test.mjs` | 9 / 9 过（`a5301a54`） |
| 全量测试 | `npm test` | **没跑**（叫停） |
| G0-R（导出确定性、像素基线、快照重放、ready-index、stream-produce、preview-fallback） | 见任务书 | **没跑**（叫停）。改法 1 不改像素；改法 2 只动队列的一段（后台那一趟、导出不走它），G0-R 的几项都不经这条路，但照规矩要跑 |
| 快照键 | `snapshotCode()` | `00a5264bf8a0…`，与 0.7.x 相同（`chrome.mjs` 已撤回原样） |
| 顺推等价 | `queue-single-pass-probe` | 见第三节 |
| 笔记本复核 | — | 没做（带耗时门槛的以笔记本为准） |

## 六、诊断（只记日志，不改行为，留在代码里）

- `executor.render-timing`（`prerender-executor.mjs`）：队列细任务一段的排队、借预渲染间、换页（含画小尺寸）、推帧、回放帧数、入库、收尾各花多久、是否顺推；编辑器进程的转发器放行（`session-diag.mjs` 的 `TASK_LINE_RE`）。
- `fillCardControls` / `renderCardSnapshotRange` 的可选 `timing` 参数（只累计毫秒数）。
- `PROMPTCUT_PRERENDER_LOG=<文件>`（`vite-plugin-prerender.ts`）：编辑器把预渲染进程的全部输出另存一份，缺省不开。
- `[frame-video] converter.worker|inline`：每个进程记一次预览视频的像素活走的哪条路。
- 查问题时还在 `chrome.mjs` 加过 `ready.slow`（等导出页就绪超 5 s 记在途请求），已撤：`chrome.mjs` 在 `snapshotCode` / `captureCode` 的文件表里，改它会换共享快照键。
- `desktop-auto-node-probe`：日志行带时刻、A3 / A4 分段计时（`marks`）、每处等待落定记 `wait.ok / wait.timeout`、`--prerender-log`、A4 之后存一份预渲染进程诊断、收尾不再挂住（原来代理上升级过的连接不关，`server.close` 一直等，不出结果行）；`c10-browser-probe` 收尾同样修了。

## 七、下一步建议（给主会话 / 笔记本）

1. 跑基线：`npx tsc -b --force`、`npm test`、G0-R 全套（任务书列的命令，dev server 5740）。
2. 查 after-dan1 的 A4 卡住：在笔记本上用 `a5301a54` 之后的探针多跑几遍 `desktop-auto-node-probe --skip-off --prerender-log`，看 `wait.timeout` 落在哪一步；改前 6 遍都没出现过，要确认是不是顺推引起的（可用 `PROMPTCUT_QUEUE_SINGLE_PASS=0`——注意这个探针会去掉 `PROMPTCUT_*`，要在 `shellEnv` 里放行它才能对照）。
3. 笔记本上复核耗时：`desktop-auto-node-probe` A4、`c10-browser-probe --user-card` 用户卡那一步，改前 / 改后各 3 遍。
4. 要不要保留顺推，由主会话定：它把 `mu-word-rotate` 这类卡的快照改得更接近导出（现行逐批本来不一致），但属于「队列产出的快照内容变了」；`docs/plan/queue-executor-design.md` 第 3 节写过「只改批次的起点,其余逐字不变」，保留的话那一句要改（计划文档，不是语义）。不保留就设 `PROMPTCUT_QUEUE_SINGLE_PASS=0` 或撤 `78d36cdf`，只留改法 1（A4 约 3.9 倍）。
5. 另开任务（没改）：逐批回放不截图让 Motion 类卡的快照与导出不一致（`mu-word-rotate` 实测），影响预渲染的所有路径；推送队列与 sink 同推一块回 400（push-scope）；节点并发 1、用户卡几段排队。

## 八、对任务书或语义的更正建议

- 任务书列的方向里「页面轮询间隔、节拍、优先级」实测都不是瓶颈（发布 0.8 s、认领 1.6～3.6 s、层表齐到贴上 <0.1 s）；大头是桌面预渲染进程主线程被旧预览视频编码占住，以及每 4 帧换一页。语义不用改。
- `server/png-post.mjs` 文件头的规矩（pngjs 同步活不许上供模块的 Vite 进程主线程）建议写进 `mechanism/rendering.md`，免得再漏。

## 九、事故记录

- 开工时用 PowerShell 的 `[IO.File]::ReadAllText/WriteAllText` 给探针加计时，传的是相对路径：.NET 按进程的工作目录（主工作区）解析，不跟 PowerShell 的 `cd`，于是改到了**主工作区**的 `scripts/probes/desktop-auto-node-probe.mjs`（两次替换，第二次重复了 `const marks`）。主会话发现后说由它还原，我没有再碰主工作区。worktree 里的同名文件是之后用绝对路径改的，只声明了一次 `const marks`、`node --check` 通过；所有探针都是在 worktree 目录里跑 worktree 这份（命令都是 `cd <worktree> && node scripts/probes/…`），结果有效。之后一律用绝对路径。
