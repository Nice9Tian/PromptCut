# 后端渲染引擎解耦计划 (Vite Plugin Vision)

由于 `server/vite-plugin-vision.ts` 目前正在开发中（处于锁定动工状态），我仅出具重构方案，**不进行任何实际代码修改**。
一旦该文件解除锁定，您可以直接按照此蓝图对其进行解耦。

## 现状与问题分析
该文件目前长达 110KB，承载了整个 PromptCut 的核心视觉渲染逻辑。它过度杂糅了以下完全不同的业务：
- Vite 插件钩子与 HTTP 路由 (Express 中间件)
- Puppeteer 无头浏览器生命周期与并发调度池 (Priority Queue)
- FFmpeg 进程调度与路径安全防护 (Path Traversal 防护)
- 卡片预渲染逻辑与缓存驱逐 (LRU/Orphan Eviction)

这导致了难以排查的竞态问题，也使得新增渲染功能时 Token 成本极高。

---

## 解耦蓝图 (Proposed Architecture)

建议在 `server/` 目录下新建 `vision/` 文件夹，将 `vite-plugin-vision.ts` 打散为以下 **6 个职责单一的核心模块**：

### 1. `server/vision/index.ts` (插件骨架与路由层)
**职责**：仅负责向外暴露 `visionPlugin()`，并挂载 HTTP 中间件。
- 提取所有的 `server.middlewares.use("/api/vision/*", ...)` 逻辑。
- 处理请求/响应体的解析和通用 HTTP 状态码回传，具体的业务逻辑委托给下面的核心模块。

### 2. `server/vision/ffmpeg.ts` (媒体剥离与抽帧层)
**职责**：纯粹的 FFmpeg 进程调度，不关心前端 DOM。
- **转移内容**：`ffmpegCommand`, `extractFrame`, `renderMediaLayers`, `mediaLayersAt`。
- **边界**：传入项目状态和时间点，输出抽出来的 PNG 素材层文件路径。

### 3. `server/vision/browser-pool.ts` (无头浏览器调度池)
**职责**：负责管理沉重的 Chrome 进程，控制并发数与优先级，保障内存安全。
- **转移内容**：`renderWaiting`, `bakeInFlight`, `renderRunning`, `maxConcurrentRenders()`。
- **逻辑剥离**：彻底将“排队系统”和“渲染具体什么东西”解耦。提供 `enqueueRender(job, priority)` 这样的纯粹调度 API，处理诸如 `CANCEL_GRACE_MS` 和死锁检测的机制。

### 4. `server/vision/baker.ts` (图卡合成与预渲染引擎)
**职责**：承上启下，拿到 FFmpeg 的素材层后，指挥 Browser Pool 去拍 DOM 快照，最后合成最终图像。
- **转移内容**：`bakeTarget`, `bakeOne`, `bakeClip`, `resolveMediaUrls`。
- **剥离收益**：这是最容易因需求变更而修改的地方（例如新增一种裁切模式），单独成文件后，修改时不用再面对网络层和 FFmpeg 的干扰。

### 5. `server/vision/cache.ts` (磁盘缓存与生命周期)
**职责**：记录预渲染文件的哈希键值，清理孤儿文件，防止磁盘溢出。
- **转移内容**：`listBakes`, `evictBakes`, 及 `/api/vision/bake-status` 中有关 orphan 计算和 `totalBytes` 的统筹逻辑。

### 6. `server/vision/security.ts` (路径安全与防护层)
**职责**：负责所有的防御性编程，挡住恶意请求。
- **转移内容**：`mediaFileOf`（防止跨目录的 Path Traversal漏洞），`overLimit`（防 OOM 的请求体大小熔断机制），`isInside` 等。

---

## 落地建议 (Execution Note)
由于模块内部使用了较多闭包状态（例如正在跑的 `bakeInFlight` Map 和 Worker 数组），在后续正式动工时，需要特别注意：
1. **不要打破单例状态**：`browser-pool.ts` 必须以单例模式导出队列状态。
2. **保持同步**：前端发出的 `AbortSignal` (如拖拽进度条引起的抛弃) 需要贯穿传入 `baker.ts` 并传递给 `browser-pool.ts` 以正确杀掉 Chrome 进程。

**此计划目前处于挂起状态。当该模块允许被修改时，您可以直接通知我：“执行 Vision 插件的解耦计划”。**
