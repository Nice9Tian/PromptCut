# AGENT 报告：在线浏览器模式里用户卡出结果太慢（claude/uc-latency）

- 分支 `claude/uc-latency`，起点 main `76eee894`（v0.7.2）；端口段 5740～5749。
- 任务：交接文件 `HANDOFF-2026-09-29.md` 第 4 节第一条、第 6 节第 1 条（浏览器里的用户卡要等桌面渲染节点渲完页面发布的清单计划才有结果，笔记本 A4 196 s）。
- 代号：A3 / A4 = `desktop-auto-node-probe` 的两步（A3：另一台设备的在线页面进项目、贴出用户卡 U1；A4：桌面页面关掉后在线页面改用户卡 U2、由桌面节点认领渲完、在线页面换上）。一段 = 队列的一个快照细任务，60 帧。

## 进度

进行中（本文随做随改）。

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
   - 等价性（`scripts/probes/queue-single-pass-probe.mjs`，两套帧库各走一遍比）：见第五节。

## 四、改后的分段耗时

（待补）

## 五、验证

（待补）

## 六、诊断（只记日志，不改行为，留在代码里）

- `executor.render-timing`（`prerender-executor.mjs`）：队列细任务一段的排队、借预渲染间、换页（含画小尺寸）、推帧、回放帧数、入库、收尾各花多久；编辑器进程的转发器放行（`session-diag.mjs` 的 `TASK_LINE_RE`）。
- `[bakery] ready.slow`（`chrome.mjs`）：等导出页就绪超过 5 秒时每 5 秒记一次在途请求；60 秒超时的报错带在途请求。
- `PROMPTCUT_PRERENDER_LOG=<文件>`（`vite-plugin-prerender.ts`）：编辑器把预渲染进程的全部输出另存一份，缺省不开。
- `desktop-auto-node-probe`：日志行带时刻、A3 / A4 分段计时（`marks`）、`--prerender-log`、收尾不再挂住（原来代理上升级过的连接不关，`server.close` 一直等，不出结果行）。

## 七、事故记录

- 开工时用 PowerShell 的 `[IO.File]::ReadAllText/WriteAllText` 给探针加计时，传的是相对路径：.NET 按进程的工作目录（主工作区）解析，不跟 PowerShell 的 `cd`，于是改到了**主工作区**的 `scripts/probes/desktop-auto-node-probe.mjs`（两次替换，第二次重复了 `const marks`）。主会话发现后说由它还原，我没有再碰主工作区。worktree 里的同名文件是之后用绝对路径改的，只声明了一次 `const marks`、`node --check` 通过；所有探针都是在 worktree 目录里跑 worktree 这份（命令都是 `cd <worktree> && node scripts/probes/…`），结果有效。之后一律用绝对路径。
