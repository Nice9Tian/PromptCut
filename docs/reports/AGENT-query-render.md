# AGENT-query-render 报告

分支 `claude/query-render`，worktree `.worktrees/query-render`，起点 main `d23d97cf`。

任务：查询渲染（按 Agent 要求渲染画面、供 Agent 观察）的两处差距——G1 用户在 AI 栏点开的操作预览不占 Agent 专用实例、插到普通预渲染待办之前；G2 Agent 专用实例空闲时接普通预渲染；搭车 G3 Tailwind 扫描源。

提交（从早到晚）：

| 提交 | 内容 |
|---|---|
| `54ff5a56` | 报告开工 |
| `ba2bc8fb` | 差距清单 |
| `8a5c74f8` | G1 + G2 主体、3D 视图贴图移出 Agent lane、调度诊断、单测 QR-G1-1～6、QR-G2-1～9 |
| `e088b515` | G3 Tailwind 扫描源 |
| `ea7a61dc` | Agent 任务之后的 1 秒空档（`AGENT_GRACE_MS`）、诊断记等待时长、探针 `query-render-probe.mjs`、单测 QR-G2-10 |
| （本报告的提交） | 报告定稿 |

## 1. 差距清单

对照的语义：`product/rendering.md` 第 64、65 行（「Agent 优先只是插队」「AI 栏的操作预览可以插队」），`mechanism/rendering.md`「查询渲染与预渲染进程」（三种模式；「Agent 优先只是插队」一条），`architecture.md` 第 13、43 行，`workflow/editing.md` 第 15 行，`product/agent.md` 第 14 行。行号是起点 `d23d97cf` 上的。

| # | 语义 | 起点上的现状 | 证据 | 本分支之后 |
|---|---|---|---|---|
| D1 | Agent 的请求只在一个专用渲染实例里走 | **做到**。`see_frames` 的 agent 批、`layout`、`entityRects`、`/api/cards/dom` 都经 `runAgentTask` 排同一条链、借同一个 `'agent'` 预渲染间 | `server/frame-pipeline.mjs:495-511`、`:843-846`、`:2814`、`:2866` | 不变 |
| D2 | 不提高进程优先级 | **做到**。Agent 请求没有单独的优先级；整个预渲染进程被编辑器进程调成 `BELOW_NORMAL`（对 Agent 和预渲染一视同仁） | `server/vite-plugin-prerender.ts:222` | 不变 |
| D3 | 专用实例不打断正在跑的任务 | **做到**（链式串行） | `server/frame-pipeline.mjs:498` | 不变（专用实例借去做的预渲染也挂在同一条链上，同样不被打断） |
| D4 | 专用实例每做完一个任务先从 Agent 队列按先后取下一个；Agent 任务永远不排在排队中的预渲染任务后面 | **只做到一半**：链里混着不是 Agent 的活——3D 视图的空闲贴图预取（`/api/vision/bake-batch`，优先级 0）、用户在 AI 栏点开的动图（D7）都进同一条链、按先后排，Agent 请求会排在已在链里的它们后面 | `server/vision/render.ts:135` 写死 `lane: "agent"`；`server/vision/bake.ts:310`、`:377`；`server/vision/routes.ts:546`；`src/editor/preview/useBakePrefetch.ts:414` | **修好**：这两类活不再进 Agent 链（G1、第 3.3 节）；专用实例接的预渲染一次一项、只在 Agent 队列空时接（G2） |
| D5 | Agent 队列空时专用实例接普通预渲染任务 | **没做**。空闲只起 10 分钟关闭计时器 | `server/frame-pipeline.mjs:783-795` | **做了**（G2） |
| D6 | 专用实例永远不占用别的实例 | **做到** | `server/frame-pipeline.mjs:500-505` | 不变 |
| D7 | AI 栏的操作预览由用户触发，不占用 Agent 的专用实例 | **相反**。`GET /api/ai/visual/gif/<key>.gif` → `ensureGif(key, 0)` → `renderFrames` → `see_frames(…, { lane: "agent" })` → `runAgentTask`，就在 Agent 专用实例上渲 | `server/vision/routes.ts:279`、`:244`；`server/vision/render.ts:135` | **修好**（G1） |
| D8 | 操作预览排到普通预渲染队列所有待办之前、不打断正在跑的那一批 | **没做**。它走 vision 的优先级队列（`render-queue.ts`，优先级 0 = 与空闲预渲染同级，导出期间整个停住），再落到 Agent 链尾；和 `FramePipeline` 的预渲染队列不是同一个队列 | `server/vision/routes.ts:244`；`server/vision/render-queue.ts:92-97`、`:130-133` | **修好**（G1） |
| D9 | 模型自己要的动图（`get_gif` 的 `/render`）、`see_frames`、`bake_card` 走 Agent 专用实例 | **做到** | `server/vision/routes.ts:306`、`:420`、`:453`、`:663` | 不变（显式写 `lane: "agent"`） |
| D10 | 预渲染进程三种模式（Agent / User / Full） | **没做**（不在本任务范围，只记录）。代码里没有 `PROMPTCUT_PRERENDER_MODE`，预渲染进程总是三条 lane 都建，相当于一直是 Full 模式 | 全仓 grep 无 `PRERENDER_MODE`；计划见 `docs/plan/cloud-task.md` I1、I4 | 不变 |
| D11 | 编辑器进程没有 Agent lane；用户交互的查询在用户自己的后台舞台上算 | **做到** | `server/frame-pipeline.mjs:476-481`；`server/test/agent-lane.test.mjs` 第 2 个用例 | 不变（新单测 QR-G2-3 再核一次：编辑器进程的 `kickAgentIdle` 也不借） |
| D12 | 查询渲染的结果从渲染所在的位置直接回传，不经素材服务 | **做到** | `server/vision/routes.ts:355-460` | 不变 |
| D13 | AI 栏显示操作详细预览：看过的图、改动前后的动图、参数差异 | **做到**（界面层） | `src/editor/right/chat/OpDetailPreview.tsx`；`src/editor/right/ToolVisual.tsx:96-132`；`server/vision/routes.ts:318-350` | 不变（界面没改） |

## 2. G1：用户触发的操作预览不占 Agent 实例、插在普通预渲染待办之前

### 做法

- **区分谁要的**（`server/vision/routes.ts`）：`ensureGif(key, who)`。
  - 用户点开的 `GET /api/ai/visual/gif/<key>.gif` → `who = "user"` → `renderFrames(…, { lane: "preview" })`，**不经** vision 的优先级队列（`enqueue`）。原因：那是另一个队列，排在它前面插不到 `FramePipeline` 的预渲染待办之前，而且导出期间会把优先级 0 整个停住。
  - 模型的 `POST /api/ai/visual/render`（`get_gif`）→ `who = "model"` → 照旧 `enqueue(…, 1, 25000)` + `lane: "agent"`。
  - 同一个 key 两边同时在渲时仍共用那一趟（`gifInflight`，原有行为）：后到的一方等先开工的那一趟，不另渲。
- **`renderFrames` 加 `lane` 选项**（`server/vision/render.ts` 的 `RenderOpts.lane`，缺省 `"agent"`），传给 `service.see_frames`。
- **`FramePipeline` 的普通预渲染队列改成显式待办**（`server/frame-pipeline.mjs`）：原来 `'queue'` lane 是一条 promise 链、只能排队尾；现在 `runQueueTask(work, signal, { front, agentOk, tag, scaleLane, kind })` 把项放进 `queueTasks`，`pumpQueue` 在 `'queue'` 预渲染间空着时取队头。
  - `front: true` 插在所有待办之前（已排着的插队项之后，插队项之间仍按先后）；
  - `see_frames` 认两个新 lane：`'preview'`（插队、`agentOk: false`、1 倍缩放）和 `'prerender'`（排队尾、`agentOk: true`、1 倍缩放），都经 `runQueueTask` 调 `flush`，不经 `runAgentTask`。`readFramesCore` 对它们和对 Agent 批一样（不走占位、写 MOV），只是借的是 `'queue'` 预渲染间。
- 缩放：操作预览原来在 Agent lane 上按 1 倍渲，现在借 `'queue'` 预渲染间时 `acquire('queue', project, { scaleLane: 'preview' })` 仍按 1 倍，不跟 `PROMPTCUT_PRERENDER_SCALE`。

### 为什么这样不违背「不打断正在跑的那一批」

- 插队只改**待办**的顺序：`pumpQueue` 只在 `queueRunning` 为空时取下一项，正在跑的那一项从不被中止或让出预渲染间；它做完，下一个就是插队项（单测 QR-G1-2 核：A 在跑、B、C 排着，预览进来排到 B、C 前面，A 做完才开工，顺序 A → 预览 → B → C）。
- 它不碰后台那一趟（`'background'` 预渲染间）：本机模式（没接文档服务）下 `'queue'` lane 平时空着，预览直接开工，不等后台那一趟，也不打断它（探针 ⑤：后台那一趟状态还是 `html` 时预览就回来了，`waitMs` 为 0）。
- 我没有照 `docs/plan/cloud-task.md` I4(b2) 的写法（在后台那一趟的批边界把 `'background'` 预渲染间交出去）：那要在 `fillCardControls` / `fillRequiredScene` / `fillMov` / `prerender` 各处找可交接点、交出去之后再恢复页面状态，改动面大、风险高；而 `'queue'` lane 本来就是「一项一项的普通预渲染任务」，插队点天然清楚。代价见第 6 节「Chrome 数」。

### 证据

- 单测（`server/test/query-render.test.mjs`）：QR-G1-1（不进 Agent lane、在 `'queue'` 预渲染间上、1 倍缩放、Agent 专用实例一次没借）、QR-G1-2（插在待办之前、不打断正在跑的）、QR-G1-3（几个预览之间按先后）、QR-G1-4（模型的 `see_frames` 照旧 Agent lane）、QR-G1-5（Agent 专用实例空着也不接预览）、QR-G1-6（路由源码核对：GET → `"user"` → `lane: "preview"` 不经 `enqueue`；`/render` → `"model"` → Agent；`bake_card` 不带 lane = Agent；bake-batch 的 lane 映射）。
- 探针 `scripts/probes/query-render-probe.mjs`（真 Chrome）①②③⑤，见第 5 节。
- 看过的图：dev server 5750 上用 `r6-stateful` 卡写一份规格、按用户那条路 GET 动图（诊断计数 `preview@queue: 1`），拼成 4×2 的 PNG 看过，8 帧都是那张卡、位置逐帧变化；再把同一张卡换一份项目时长（3 → 3.1 秒，帧库多出一个新条目，确认是重新渲的）走模型那条路（`/render`，计数 `agent@agent` +1），两张 GIF **逐字节相同**（30 531 字节）。

## 3. G2：Agent 专用实例空闲时接普通预渲染

### 做法

`FramePipeline.kickAgentIdle()`：下列条件全部成立时，专用实例接**一项**普通预渲染，挂在 `laneChains.get('agent')` 链尾：

1. 这个实例有 Agent lane（`interactive`；编辑器进程没有）；
2. Agent 队列空（`agentPending === 0`，`runAgentTask` 入队加一、做完减一），手里也没有别的预渲染项；
3. 专用实例的预渲染间**已经开着、还没到空闲关闭**（`lanes.get('agent')` 在、没标 `expired`）：不为接预渲染去开 Chrome，Agent 最近 10 分钟用过它才接；
4. 不在播放让路期间（同后台那一趟）；
5. 离最近一个 Agent 任务做完已过 `AGENT_GRACE_MS`（1 秒）：没到就定个计时器到点再判。

接哪一项（`takeAgentUnit`）：

- 先是普通预渲染队列里第一个 `agentOk`、且和 `'queue'` 预渲染间手里那一项不同 `tag` 的（队列细任务：共享档 `card:<control.key>`、本地档 `scene:<entry.key>`；3D 视图空闲贴图预取没有 tag）；
- 没有就从**后台那一趟正在做的那张卡**里借一批（`fillCardControls` 的新选项 `share`，只有 `preload` 那两处调用传 `true`）：借最靠后的那一批（4 帧），后台自己从前往后做，两边不抢同一批。

为什么满足语义里的三条：

- **做完一个任务先看 Agent 队列**：每项做完回到 `kickAgentIdle` 重新判，Agent 队列不空就不接。
- **不打断正在跑的任务**：接的那一项挂在 Agent 链上，之后到的 Agent 任务排在它后面、等它做完；Agent 任务也不打断预渲染（语义没要求打断）。一个 Agent 请求最多等专用实例手里那一项：卡批是 4 帧一批（探针实测一批约 2.4～2.8 秒，大头是换页），队列细任务是一段。
- **Agent 任务永远不排在排队中的预渲染任务后面**：专用实例只在 Agent 队列空时接，而且一次一项；接的那一项开工时没有 Agent 任务在排，之后到的 Agent 任务只等它这一项，排着的其它预渲染（队列里剩下的、那张卡剩下的批）都在 Agent 任务之后。单测 QR-G2-2、QR-G2-8 核这条。
- 1 秒空档是后加的（`ea7a61dc`）：探针第一轮发现 `see_frames`（渲完一批才排「量实体框」）两个 Agent 任务之间的空档里专用实例接了一批卡批，第二个任务白等 3861 ms；加空档后同一处等 1 ms。它只推迟「接预渲染」，不影响 Agent 任务。

### 防护（同一张卡两个实例同时渲、卡片锁、帧库写入）

- **队列细任务**：`tag` 相同的两项不同时在两个实例上跑（`pumpQueue` 跳过和专用实例手里同 tag 的，`takeAgentUnit` 跳过和 `'queue'` 预渲染间手里同 tag 的）。单测 QR-G2-5。
- **后台卡批**：同一张卡的不同批可以在两个实例上同时跑，写入本来就容得下：快照入库 `SnapshotStore.commitSnapshots` → `updateIndex` 按键目录串行读改写（`server/snapshot-store.mjs:229-239`）；PNG 缓存 `MovFrameStore.put` 按 store 的 `writeChain` 串行（`server/frame-mov.mjs:251-256`），同一 entry 共用同一个 `CardFrameCache`；帧文件一律原子改名。卡片锁的判定（`cardLockDecision`、`acquireCardLock`）在每张卡开工前由后台做一次，借走的批只执行、不判锁。**这张卡的收尾**（`cardCache.finish`，起 ffmpeg 编 MOV）只由后台做，而且等借走的批都落定之后——不会两处同时收尾（单测 QR-G2-7：32 帧每帧恰好一次、`finish` 一次且在 32 帧之后）。借走的批出错（不是被掐）就交还后台补做，并关掉专用实例那个预渲染间（下一个 Agent 任务重开），免得空闲时一再借它、一再失败。
- **空闲关闭**：专用实例的 10 分钟计时器只按 Agent 自己的任务算；它在专用实例做预渲染时到点，只标 `expired`，做完那一项再关，之后不再接（单测 QR-G2-6）。
- **编辑器进程**：`interactive: false` 时 `kickAgentIdle` 直接返回，`runAgentTask` 照旧回 `503 NO_AGENT_LANE`（单测 QR-G2-3）。
- **没开着的专用实例时 `share` 与不传逐项相同**（单测 QR-G2-9：同一张卡两种调用的批序列一样、全部在后台预渲染间上）。

### 3.3 顺带：3D 视图的贴图不再进 Agent lane

`/api/vision/bake-batch`（3D 视图 `useBakePrefetch` 的空闲贴图预取）原来经 `bakeClip` → `renderFrames` 进 Agent 链，是 D4 的一半原因。现在 `bakeOne` / `bakeClip` 多一个 `o.lane`：优先级 0（空闲预取）→ `'prerender'`，排普通预渲染队尾、专用实例空闲时可接；优先级 1（用户等着看）→ `'preview'`，插队。`bake_card`（模型，`/api/vision/bake`）不带 lane，照旧 Agent。vision 优先级队列对它们照旧（导出期间停空闲预取）。

### 证据

- 单测 QR-G2-1～10（见第 5 节清单）。
- 探针 ④⑥⑦：后台预渲染进行中、Agent 专用实例刚用过且空着时，诊断计数 `card-batch@agent` 从 0 涨到 39（这一趟两张 6 秒卡），`@agent` 下只有 `agent`（Agent 任务）和 `card-batch`（卡批）两类，没有 `preview`；进行中模型再看一帧照常返回，两个 Agent 任务各等 2842 ms（专用实例手里那一批）和 1 ms；那一趟最后 `status: 'ready'`、没有 error。

## 4. G3：Tailwind 扫描源

`src/index.css` 第一行换成 `@import "tailwindcss" source(none);` 加 `@source "../src";`、`@source "../server";`、`@source "../index.html";`，其余 `@source not` 行不动，单独一个提交 `e088b515`。

核对（改前 = 本分支 G1/G2 提交之后、G3 之前；改后 = G3）：

| 构建 | 改前 | 改后 | 结果 |
|---|---|---|---|
| `npx vite build`（`dist/assets/index-CtU7rlnp.css`） | 303 983 字节，sha256 `143cf760…811548` | 同名、同大小、同 sha256 | `cmp` 相同 |
| `npx vite build --mode online`（`dist-online/assets/index-D5vohaf8.css`） | 441 530 字节 | 同名、同大小 | `cmp` 相同 |

构建产物（`dist/`、`dist-online/`，都在 `.gitignore` 里）核完已删。目录遍历耗时没有另测，依据的是 `AGENT-watch-ignore.md` 里的 10 s → 0.12 s。

## 5. 验证

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0（它只查 `src/`）。另对改过的三个 `server/vision/*.ts` 单独跑了 `npx tsc --noEmit --skipLibCheck --module esnext --moduleResolution bundler --target es2022 --types node server/vision/render.ts server/vision/bake.ts server/vision/routes.ts`：这三个文件 0 个错误（报出来的错都在别的文件里，改前改后一样） |
| 全量测试 | `npm test`（PATH 里加了 ffmpeg） | 最后一次：`tests 4051 / pass 4049 / fail 0 / skipped 2`（main 上 4035 条，新增 16 条）；中途一次（加空档之前）4050 / 4048 / 0 / 2 |
| 新单测 | `node --experimental-test-module-mocks --test server/test/query-render.test.mjs` | 16 / 16 通过：QR-G1-1～6、QR-G2-1～10 |
| 相关旧单测 | `agent-lane`、`m6c-integ`、`stall-phases`、`prerender-executor`、`m6c-executor` | 29 / 29 通过（全量里也都过） |
| 代码指纹 | `node -e "import('./server/frame-code.mjs').then(m=>console.log(m.snapshotCode(process.cwd()), m.captureCode(process.cwd())))"` | `00a5264bf8a062ff6e0b5ed0516cccd1 86e443cb6fa838aef64788af6822fd68`，与 main 相同；`frameCode` 由 `bab4aba8…` 变为 `e1bb40f9…`（预期：`frame-pipeline.mjs` 与 `src/index.css` 都进它） |
| 探针 ready-index | `node scripts/probes/ready-index-probe.mjs --port 5753` | 退出码 0，`fails: []`（95 秒） |
| 探针 preview-fallback | dev server `PROMPTCUT_NO_PORT_FILE=1 npx vite --port 5750 --strictPort --host 127.0.0.1`（产物指到临时目录），`node scripts/probes/preview-fallback-probe.mjs --origin http://127.0.0.1:5750` | `PASS`，`transparentBeats: 0`，`fails: []`，`pageErrors: []`，`taskP90` 34.1 ms（没给 `--baseline`，不比涨幅） |
| 探针 query-render（新） | `node scripts/probes/query-render-probe.mjs --port 5756` | 跑了三轮都退出码 0、`fails: []`；最后一轮数字见下 |

`query-render-probe` 最后一轮（`ea7a61dc`）：

- ① 用户点开的动图：200、`image/gif`、`GIF89a`、42 444 字节、10.5 s（冷启动 Chrome）；计数 `preview@queue: 1`，`agent@agent` 仍为 0。
- ② 模型 `see_frames`：200、4.3 s；`agent@agent` 0 → 2（渲帧一批 + 量实体框），`preview@queue` 不变。
- ③ 模型 `get_gif`：回拼图；`agent@agent` 2 → 3，`preview@queue` 不变；之后 `agentOpen: true`。
- ④ 后台预渲染开跑后 `card-batch@agent` ≥ 1（这一趟最后共 39 批）。
- ⑤ 后台进行中用户点开另一张动图：8.3 s 回 GIF，`waitMs: [0]`，回来时后台那一趟状态 `html`（没做完）。
- ⑥ 后台进行中模型再看一帧：9.5 s 返回，两个 Agent 任务等待 `[2842, 1]` ms。
- ⑦ 那一趟 `status: 'ready'`、`error: null`；总计数 `preview@queue 2、agent@agent 5、card-batch@agent 39`。

没跑的：导出确定性（`verify-determinism.mjs`）和导出与快照重放一致（`verify-unified-frames.mjs`）——任务书说 G0-R 其余项由主会话合流时跑；本分支没改导出路径，快照与截图两个指纹不变。带耗时门槛的项本分支没有；上面的耗时只是记录，不是判据（也没在笔记本上复核）。

## 6. 对外接口与兼容

- HTTP 路由的地址、请求体、回包形状都没改。`GET /api/ai/visual/gif/<key>.gif` 与 `POST /api/ai/visual/render` 行为上只改了在哪个实例上渲。
- `GET /api/frames/diagnostics` 多一个键 `scheduler`（`counts`、`recent[{kind, worker, at, waitMs}]`、`agentPending`、`queueWaiting`、`queueRunning`、`agentUnit`、`agentOpen`），只加不改。
- `FramePipeline.runQueueTask(work, signal)` 多一个可选第三参数；`acquire(lane, project)` 多一个可选第三参数；`fillCardControls` 多一个选项 `share`；`see_frames` 多认两个 lane 名 `'preview'` / `'prerender'`。缺省时行为与原来相同。原来 `'queue'` lane 的链不再进 `laneChains`，`closeNow` 改为等 `queueSettled()`。
- `renderFrames` / `bakeOne` / `bakeClip` 的选项多一个 `lane`，缺省 `"agent"`。
- **Chrome 数**：本机模式下 `'queue'` lane 平时不开；现在用户第一次点开操作预览（或 3D 视图预取贴图）会开它（空闲 30 秒关），不再借 Agent 的那一个。所以 Agent 专用实例开着时点开预览，会多一个 Chrome 同时在（以前两者共用一个）。
- `server/frame-code.mjs` 的 `SNAPSHOT_FILES` / `CAPTURE_FILES` 里的文件一个没动。

## 7. 没做成的、限制

1. **D10 三种模式没做**（不在范围）。
2. **G2 的「队列细任务」这一路在现有部署下几乎碰不上**：PC 本机节点 `maxConcurrent: 1`（`server/vite-plugin-frames.ts` 的 `startQueueNode` 注释）、独立渲染主机只在 `'queue'` lane 空着时认领（`server/render-node/host.mjs:182-189` 看 `laneBusy()`），所以 `'queue'` lane 上同时排着两项的情况很少，专用实例没得接。实际起作用的是「后台那一趟的卡批」这一路（探针 39 批）和 3D 视图的贴图预取。要让队列模式也吃到，需要节点在专用实例空着时多认领一项——改的是认领闸，不在本任务的文件范围，建议另开任务。
3. **后台那一趟里只有 `fillCardControls` 的卡批可借**；锚帧（`fillAnchorSnapshots`，一次 `bakeFrames` 推整段）、本地档整场景、整场景 HTML / MOV / 预览视频都绑死在后台预渲染间上，没拆。
4. 预渲染进程的端口由编辑器进程自己挑空闲端口（`vite-plugin-prerender.ts` 的 `freePort`），不在分配的 5750～5759 里；这是现有机制，探针没法指定。
5. Agent 请求在专用实例做卡批时要等一批（本机实测约 2.4～2.8 秒，大头是 `bakery.reset` 换页）。语义允许（不打断正在跑的任务），但比以前（专用实例空着、立即开工）慢。要缩短可以让专用实例连续借同一张卡时不换页，本任务没做。

## 8. 语义与任务书的更正建议（dry run，没改 `docs/semantics/`）

### 8.1 `docs/semantics/mechanism/rendering.md`「查询渲染与预渲染进程」（三级，写数字）

修改前（第 112 行）：

> - **Agent 优先只是插队**：Agent 的请求只在一个专用渲染实例里走，不提高进程优先级。专用实例每做完一个任务，先从 Agent 队列里按先后取下一个；Agent 队列空时接普通预渲染任务。它不打断正在跑的任务，Agent 任务永远不排在排队中的预渲染任务后面，也永远不占用别的实例，所以用户总能等到预渲染。

修改后（原句不动，后面加两条）：

> - **Agent 优先只是插队**：Agent 的请求只在一个专用渲染实例里走，不提高进程优先级。专用实例每做完一个任务，先从 Agent 队列里按先后取下一个；Agent 队列空时接普通预渲染任务。它不打断正在跑的任务，Agent 任务永远不排在排队中的预渲染任务后面，也永远不占用别的实例，所以用户总能等到预渲染。
> - 专用实例只在开着的时候接普通预渲染（Agent 在它 10 分钟的空闲关闭之前用过它），不为接预渲染开新实例；空闲关闭只按 Agent 自己的任务计时。每次接一项：普通预渲染队列里的一项，或后台预渲染正在做的那张卡的一批（4 帧）；和另一个实例手里同一张卡的队列任务不同时接。做完一个 Agent 任务后先空 1 秒再接，免得一次工具调用里前后脚的几个查询之间插进一批。
> - AI 栏的操作预览在预渲染进程专做队列任务的那个实例上渲，排在它所有待办之前，正在做的那一项做完就轮到它；它不进 Agent 队列。3D 视图的贴图预取是普通预渲染，排队尾；用户等着看的那张同操作预览一样插队。

### 8.2 `docs/plan/cloud-task.md` I4(b)、(b2)（计划文件，不是语义）

- I4(b) 写的是专用实例空闲时接「C2 的锚帧队列和 C4 的 `wanted` 单帧」；实际做的是接后台那一趟 `fillCardControls` 的 4 帧批和普通预渲染队列的项（锚帧是一次推整段，拆成单帧改动大）。等待上界因此是「一批」而不是「一帧」。
- I4(b2) 写的是在后台那一趟的批边界把 `'background'` 预渲染间交给插队项；实际做的是插在 `'queue'` lane 的待办之前、在 `'queue'` 预渲染间上渲（理由见第 2 节）。验收里「等待 ≤ 一批的时长」在本机模式下变成「不等」（`'queue'` lane 平时空着）。
- 建议主会话合流时按实际做法改这两段，或标注「以 `AGENT-query-render.md` 为准」。

### 8.3 TODO

`docs/plan/TODO.md`「语义与代码的差距」里「查询渲染：Agent 专用渲染实例的优先通道、AI 栏操作预览的插队只有雏形」一条，合入后可以改成只剩第 7 节的第 2、3 条（队列模式的认领闸、锚帧等不可借）和 D10（三种模式）。
