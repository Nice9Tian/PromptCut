# 后端渲染引擎解耦（Vite Plugin Vision）——**已完成**

`server/vite-plugin-vision.ts` 原来是 2011 行的单文件，仓库里唯一真正的巨石：ffmpeg 抽帧、
渲染并发队列、Chrome worker 池、单卡预渲染、HTTP 路由全挤在一起。现在已拆成 `server/vision/`
下的八个模块，插件外壳只剩 56 行。

这一次是**纯重构**：函数体与注释逐字搬运，没有改变任何运行时行为。非逐字的改动只有四处，
逐条列在最后一节。

> 本文档里一律用「预渲染」，不用「烘焙」；代码标识符（`bakeOne`、`bakeClip`、`bakeTarget`、
> 路由 `/api/vision/bake` 等）保持原样不动。

---

## 一、实际的模块划分

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `server/vite-plugin-vision.ts` | 56 | **插件外壳**。只做三件事：卡片源码变了通知 worker 扔备用页、服务关掉时收 worker、按 `isPrerender` 把路由注册分流到两侧。对外的 export（`visionPlugin`、`bakeTarget`、default）都还在这里。 |
| `server/vision/ffmpeg-frames.ts` | 118 | ffmpeg 在哪（`ffmpegCommand`）、素材文件解析的白名单边界（`mediaFileOf`）、抽一帧（`extractFrame`）、素材层（`renderMediaLayers`）。只认磁盘，不碰浏览器、不碰队列。 |
| `server/vision/render-queue.ts` | 142 | **渲染并发队列**。并发上限（`maxConcurrentRenders`）、派发（`pumpRenderQueue`）、入队与插队（`enqueue`）、取消错误（`cancelError`）。它不认识 Chrome，只知道「一个活是一个返回 promise 的函数」。 |
| `server/vision/http.ts` | 82 | HTTP 小工具：`sendJson`、`abortOnClose`、`outRoot`、`resolveMediaUrls`、`originOf`。无状态。 |
| `server/vision/bake-cache.ts` | 56 | 预渲染产物在磁盘上的盘点与清理：`listBakes`、`evictBakes`。只认键、不认路径。 |
| `server/vision/bake.ts` | 387 | **单卡预渲染**。缓存键的唯一算法 `bakeTarget`（预渲染、盘点、清理三方共用）、单张 `bakeOne`、同一张卡一批时刻 `bakeClip`、图卡源码指纹 `graphCardCode`。 |
| `server/vision/worker-pool.ts` | 369 | **常驻渲染 worker 池**，每个 worker 背后守着一个 Chrome。开 / 杀 / 挑 / 备（`spawnWorker`、`killWorker`、`pickWorker`、`ensureSpareWorker`）、协议收发（`callWorker`、`runOnWorker`）、池内跑一趟（`runExport`）、源码变了让全部 worker 扔备用页（`invalidateWorkers`）。 |
| `server/vision/ui-renderer.ts` | 163 | 编辑器这一端常驻的那对热备渲染器 A / B（`createUiRenderer`）。用户前台的预渲染请求不进渲染池，走这里。 |
| `server/vision/render.ts` | 153 | **渲染入口**：`renderOneFrame` / `renderFrames`，把「这份项目的这几个时刻」变成 PNG。 |
| `server/vision/routes.ts` | 618 | 两侧的 HTTP 路由注册：`registerEditorSide`（编辑器进程）和 `registerPrerenderSide`（预渲染进程）。路由处理体保留搬运前的 6 空格缩进，为的是让「只是搬家」能被逐字比对证明。 |

### 依赖方向（运行时 import 图，单向无环）

```
vite-plugin-vision.ts ──► vision/routes.ts ──┬─► vision/bake.ts ──► vision/render.ts ─┐
          │                                  ├─► vision/bake-cache.ts                 │
          │                                  ├─► vision/ffmpeg-frames.ts              │
          │                                  ├─► vision/http.ts ◄─────────────────────┤
          │                                  ├─► vision/ui-renderer.ts ──┐            │
          └──────────────────────────────────┴─► vision/worker-pool.ts ◄─┴────────────┘
                                                        │
                                                        ▼
                                                vision/render-queue.ts
```

队列和 worker 池互相要用对方的东西，方向定成 **worker-pool → render-queue 单向**：
worker 池只取队列的 `cancelError`，队列完全不认识 worker。`ui-renderer` 要写 worker 池的
`lastRenderOrigin`，走一个单向的 `setLastRenderOrigin`，不反手 import。

这条无环约束由 `server/test/vision-modules.test.mjs` 钉住（同时钉住外壳行数 < 400）。

---

## 二、模块级可变状态归属表

**每份状态只有一个归属模块**，别处只能通过该模块导出的函数读写，拆完没有任何一份被复制成两份。

| 状态 | 归属模块 | 谁写 | 谁读 | 跨模块怎么读写 |
| --- | --- | --- | --- | --- |
| `ffmpegResolved` | `ffmpeg-frames.ts` | 只有 `ffmpegCommand` | 只有 `ffmpegCommand` | 不出模块 |
| `renderWaiting`（队列数组） | `render-queue.ts` | `enqueue` / `pumpRenderQueue` | 同左 | 不出模块，外面只能 `enqueue` |
| `renderRunning` | `render-queue.ts` | 只有 `pumpRenderQueue` | `enqueue`、`routes.ts`（health / bake-status 的观测口） | `export let`，外面只读这个活绑定，**不许在别处赋值** |
| `bakeInFlight` | `bake.ts` | 只有 `bakeOne` | 只有 `bakeOne` | 不出模块 |
| `counter`（临时文件名取号器） | `render.ts` | `renderFrames`、`nextCounter()` | 同左 | `bake.ts` 通过 `nextCounter()` 取号，全进程只有这一个计数器 |
| `renderWorkers`（worker 列表） | `worker-pool.ts` | 只有 `spawnWorker` / `killWorker` | `pickWorker`、`ensureSpareWorker`、`invalidateWorkers`、`routes.ts`（bake-status 的明细）、外壳（关服务时全杀） | 导出的是 `const` 数组引用，只有本模块改它的内容 |
| `renderJobSeq` | `worker-pool.ts` | 只有 `runOnWorker` | 同左 | 不出模块 |
| `lastRenderOrigin` | `worker-pool.ts` | `runExport`、`setLastRenderOrigin` | `spawnWorker`（预热） | `ui-renderer.ts` 通过 `setLastRenderOrigin` 写 |
| 热备渲染器的 `slots` / `running` / `pending` | `ui-renderer.ts` | `createUiRenderer` 的闭包 | 同左 | 闭包，不是模块级状态 |
| `gifInflight`、`visualDir`、`visualLib` | `routes.ts` | `registerPrerenderSide` 的闭包 | 同左 | 闭包，**刻意没有提到模块级**，行为和拆分前一致 |

---

## 三、将来要改什么，改哪个模块

这三件事都写在 `user_pinned_goal.md` 的「架构设计」第 4、5 条里，本次**只搬代码、没有实现任何新调度行为**。
下面只是路标。

### 1. 预渲染进程的 Agent / User / Full 三种模式（目标第 4 条）

- **判断当前是哪种模式**：新加一个模块（建议 `server/vision/render-mode.ts`），别塞进队列里 ——
  模式是进程级配置，队列只该认「优先级」这一个数。
- **Agent 模式不预渲染、只查询精确某帧**：落点在 `render-queue.ts` 的 `pumpRenderQueue`
  （现在它已经有一条「导出期间空闲预渲染整个暂停」的先例，就在同一处判断）和
  `routes.ts` 里发起空闲预渲染的那几条路由。
- **User 模式只预渲染重卡片**：不在服务端，落点在前端的预渲染调度（`src/editor/preview/useBakePrefetch.ts`），
  服务端这边不用改。
- **Full 模式优先 Agent 查询、其次预渲染**：见下一条。

### 2. Agent 专用 Chrome 优先通道（目标第 4 条）

**改 `worker-pool.ts`，不要改 `render-queue.ts`。**

现在 `pickWorker(root, priority)` 已经是两条路：`priority > 0` 只用 `reserved` 那台（热的、专属的、
永不闲置退出），`priority === 0` 只用非 reserved 的。这正是「专用 Chrome」的骨架，
要做的是把「前台 / 后台」这一档扩成「Agent 专用 / 普通」：

- `RenderWorker` 上的 `reserved` 字段换成一个角色（`"agent" | "ui" | "pool"`），`pickWorker` 按角色挑；
- 「Agent 请求优先」的语义是**插队、不打断**：专用 Chrome 每做完一个任务，先从 Agent 队列里按先后取下一个，
  Agent 队列空了才接普通预渲染任务。这条是 `render-queue.ts` 里「按优先级插在所有不低于它的之后」
  那一段的自然延伸 —— 需要的是**两条队列**，不是抢占；正在跑的那一趟绝不打断（`pumpRenderQueue` 现在
  也只调度「还没开始」的，语义一致）。
- 「不独占预渲染资源」这条由 `pumpRenderQueue` 的槽位账保证：它现在已经给前台永远留一个槽位
  （后台只能用到 `max - 1`），Agent 通道复用同一套账即可。

### 3. AI 菜单的操作预览插队（目标第 5 条）

**改 `render-queue.ts`，不要改 `worker-pool.ts`。**

目标的原话是「在普通 Chrome 的队列里排到所有待预渲染任务之前，不打断正在跑的那一批，
也不占用 Agent 的专用 Chrome」—— 这三件事分别对应：

- 「排到所有待预渲染任务之前」= `enqueue` 里新增一档介于 0 和 1 之间的优先级（现在是 0 / 1 两档），
  `renderWaiting.findIndex((w) => w.priority < priority)` 这一句不用改；
- 「不打断正在跑的那一批」= `pumpRenderQueue` 本来就只调度还没开始的，不用改；
- 「不占用 Agent 的专用 Chrome」= `pickWorker` 按角色挑时，这一档走普通池。

发起方是 `routes.ts` 里 AI 菜单那几条路由（`/api/ai/visual`），只要传新的优先级即可。

---

## 四、这次拆分的完整改动清单

### 非逐字搬运的四处（其余全部逐字，含注释）

1. **各模块的 import / export 语句**是新写的（原文件只有一份 import 头）。顺带删掉了一个
   从来没被用过的 import：`cardsOnly`（`server/vision-compose.mjs`）。
2. `bake.ts` 的 `bakeOne`：`${counter++}` → `${nextCounter()}`。`counter` 归 `render.ts`，
   ESM 的导入绑定是只读的，跨模块取号只能走函数。
3. `ui-renderer.ts` 的 `createUiRenderer`：`lastRenderOrigin = originFn()` →
   `setLastRenderOrigin(originFn())`。同上，状态仍然只有 `worker-pool.ts` 那一份。
4. `server/vite-plugin-vision.ts` 的 `configureServer`：原来内联的 514 行预渲染侧路由，
   换成一句 `registerPrerenderSide(server, root)`。

另有一处**必须**跟着搬家改的相对路径（不是可选的接线，是搬家的一部分）：
`routes.ts` 里 `/api/ai/visual` 用 `new URL("./ai-visual.mjs", import.meta.url)` 动态加载
`server/ai-visual.mjs`，文件搬进 `server/vision/` 之后改成 `"../ai-visual.mjs"`。
这一处起服务不报错，要到真有人请求 `/api/ai/visual/*` 才 500 —— 是运行时冒烟抓到的。

还有一处**位置**变了但文字没变的注释：原文件里讲 `renderOneFrame` 的那段 doc 注释
孤零零地夹在 `listBakes` 上面（历史遗留的错位），现在放回它真正描述的 `renderOneFrame` 头上。

### 代码指纹（`server/frame-code.mjs`）

`vite-plugin-vision.ts` **不在**任何一张指纹清单里（`BAKERY_FILES` / `CAPTURE_FILES` /
`SNAPSHOT_FILES` 里只有 `server/bakery/*.mjs` 和 `server/frame-*.mjs`），所以拆出去的模块
也不需要补进清单，**指纹不会变**。

### 测试清单同步

`server/test/syntax.test.mjs` 的目录清单不递归，补上了 `server/vision`，
让「哈希 / 解析覆盖的内容集合」与拆分前一致。
新增 `server/test/vision-modules.test.mjs`（import 无环 + 外壳行数红线 + 对外 export 还在）。
