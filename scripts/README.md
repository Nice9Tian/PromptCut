# 导出引擎预热机制与设计说明

本文档介绍了 PromptCut 逐帧导出机制的设计理念，特别是为了解决非确定性渲染（如 CSS 动画、JS requestAnimationFrame）而引入的**稳态预热**流程。

## 导出命令与验证脚本用法

### export-frames.mjs

导出动画为逐帧图片序列和视频文件。

**用法**:
```bash
node scripts/export-frames.mjs [选项]
```

**命令行参数**:
- `--url <url>`: 指定要导出的页面 URL。默认: `http://127.0.0.1:5190/?export=1`
- `--out <dir>`: 输出目录。默认: `out`
- `--frames <start-end>`: 指定要导出的帧范围（例如 `0-59`）。默认导出所有帧。注意，不管指定的截取起点是多少，引擎**始终**会从第 0 帧开始步进并模拟整个时间流逝，只有当帧号大于或等于截取起点时，才会将图片落盘。这保证了即使只截取中间某一段，其内部状态也与整段导出完全一致。
- `--fps <number>`: 导出帧率。默认使用页面的时间轴帧率，通常为 `30`。
- `--no-video`: 仅导出图片序列，不调用 ffmpeg 合成视频。

### verify-determinism.mjs

导出两遍完全相同的范围并对比像素，验证导出结果是否具有确定性。

**用法**:
```bash
node scripts/verify-determinism.mjs [选项]
```

**命令行参数**:
- `--url <url>`: 同上。
- `--frames <start-end>`: 同上。
- `--fps <number>`: 同上。

---

## 7步确定性预热流程

我们在导出流程中设计了以下 7 步确保画面、动画和内部时钟在第 0 帧前达到确定且稳定的状态：

1. **就绪等待**: `setViewport` 和 `goto` 页面后，由 Node 侧最多轮询等待页面内 `window.__pcReady` 置位。
2. **WARM_A (8 轮稳态预热)**: 执行 8 次固定的“发放一帧预算 -> 等待到期 -> rAF -> 丢弃截图”。强制页面时钟和渲染管线运转起来，此时帧时钟达到稳态。
3. **时钟校准**: 触发 `window.__pcResetCalibration()`，将 `__pcClockRate` 的测量基准点移至此刻的稳态基点上。为了消除子帧相位差，此操作必须包裹在 `requestAnimationFrame` 里。
4. **WARM_B (12 轮稳态预热)**: 继续执行 12 轮固定的帧步进，让 `__pcClockRate` 的数值累加并收敛到一个固定的确切值。
5. **收敛检查与时钟冻结**: 读取 `__pcClockRate` 两次，进行收敛检查。若 `|r2-r1|/r1 > 0.01` 则抛错退出。检查通过后，调用 `window.__pcFreezeCalibration()`，将 `__pcClockRate` 锁存，确保其在正式计帧期间不再有微小漂移。此举避免了 AnimClock 中针对 CSS 动画的 `playbackRate` 因漂移而频繁重置（频繁重置会导致动画失去起始时间而停滞）。
6. **重启卡片与锚定动画**: 
   - 调用 `window.__pcRestartCards()` 让所有卡片重新挂载。
   - 推进一次帧预算，让 React 将新卡片挂载，且 JS 驱动动画完成构建。
   - 调用 `window.__pcAnchorAnimations()`，将所有 `getAnimations()` 获取到的动画对象的 `startTime` 重锚至 `document.timeline.currentTime`，消除因性能接口基准差（`performance.now()` vs `document.timeline.currentTime`）导致的 WAAPI 初始时间偏移问题。
   - 再次调用 `rAF` 等待动画就绪。
7. **正式导出主循环**: 从第 0 帧（内部始终从 0 帧步进）开始正式导出。

---

## 性能接口与时钟非确定性

**虚拟时间下的时钟差异**:
在 Chrome 的虚拟时间策略下，`document.timeline.currentTime` 每个虚拟帧前进的量是不稳定的（实测 33.33ms 的虚拟帧，它可能推进 66.6 到 78.0ms 不等）。
这就意味着单一的 `playbackRate` 标量无法将 WAAPI/CSS 动画校正到逐帧精确。由于标定值仅能无限接近真实比率，我们选择在稳态后冻结 `__pcClockRate` 以换取动画时间的平滑性，而非追求绝对精确（反而是读取 `performance.now()` 的 JS 驱动动画（如 Motion 的 RAF 钩子）是严格跟从我们释放的 `budget` 精确递增的）。

### 实测验证数据 (Frames 0-59)

* **确定性**: 0-59 帧与 60-119 帧的的两段校验 `verify-determinism.mjs` 中，结果均为 `60/60 Identical`，不同帧数 0，完全达成确定性。
* **背景透明度**: 每帧非零 alpha 像素数稳定在降低后的安全范围，验证了 `background: transparent` 生效。
* **Motion JS 动画（蓝框）**: x 轴平移与 alpha 淡入完美从第 0 帧开始生效，并按预期 1.5s 后停止。
* **CSS 旋转动画（红方块）**: 红方块宽度呈现预期的正弦型波动极小值（间隔 15 帧），表明 `pcSpin` 旋转正常进行。
* **步长计数器**: `__pcProbeMs` 步长严格稳定在 `33.33` ms，且由于重置成功，从 `0` 开始递增。

---

# 导入 / 导出（src/editor/io/ + server/vite-plugin-export.ts）

本节由「导入导出」任务补充，与上面的渲染内核小节相互独立。

## 四个入口

`src/editor/io/index.ts` 对外只暴露四个函数（签名冻结，TopBar 直接调用）：

- `importVideoFiles(files)` — 每个文件 `URL.createObjectURL` + 隐藏 `<video preload=metadata>` 探测时长/宽高，
  `actions.addMedia` 登记后 `actions.addMediaClip(id, 播放头)`；多文件顺序排，游标推到上一段实际 `end`。
  `File` 对象按 mediaId 存进模块级 Map，供 `exportVideo` 上传给渲染脚本。
- `exportProjectJson()` — Project 的 JSON（2 空格缩进）。`blob:` 素材的 url 换成文件名，顶层加 `_note` 说明
  重新打开后需要重新导入素材。
- `importProjectFile(file)` — 吃两种形状：标准 Project（`version:1` + `tracks`）；以及 `{cards:[...]}` 旧编排
  （转成一条动效轨，未知 cardId 跳过并 `console.warn`）。标准 Project 里 url 不是 `blob:/http/https/data:/` 开头的
  素材标记为缺失（`url=""`、`name` 加「(缺失) 」前缀），**clip 保留**，Preview 不渲染 video 元素也不报错。
- `exportVideo(opts)` — 先把 `blob:` 素材 POST 上传，再 POST 整个 Project 给 `/api/export`，用 SSE 订阅进度，
  返回 `{ outDir }`。

## /api/export 接口（server/vite-plugin-export.ts）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/export/media/<文件名>` | 请求体为文件原始字节，落到 `out/.export-staging/media/`，返回 `{"url":"/@export/media/<文件名>"}` |
| POST | `/api/export` | 请求体是 Project JSON 或 `{project,frames?,fps?,noVideo?}`。建 `out/export-<id>/`，把 staging 素材移进去，写 `project.json`，spawn `node scripts/export-frames.mjs --url http://127.0.0.1:<当前端口>/?export=1&timeline=/@export/<id>/project.json --out out/export-<id>`，立刻返回 `{"id","outDir"}` |
| GET | `/api/export/<id>` | 进度。`Accept: text/event-stream` 或 `?sse=1` 走 SSE，推 `{done,total,status,message}`；否则返回一次性 JSON 快照 |
| GET | `/@export/<id>/project.json`、`/@export/project.json` | 该 job / 最近 job 的 project.json |
| GET | `/@export/<id>/media/<文件名>`、`/@export/media/<文件名>` | 素材，支持 Range 请求 |

## ExportView 的视频层

`?timeline=<url>` 现在同时吃 `Project`（有 `tracks`，用 `flattenOverlay` 压平）和 `Timeline` 两种形状。
是 Project 时按 `videoClipAt` 在 Stage 下面放一个 `<video>`（永远 pause，靠 seek 取帧），
每帧 `__pcSetT` 把 `currentTime` 设到 `mediaOffset + (sec - clip.start)`，并把这次 seek 登记成
`window.__pcFrameReady()` 返回的 Promise；导出脚本在截图前 `Promise.race([__pcFrameReady(), node 侧 3s 超时])`。

**两处虚拟时间的坑（都必须在 `__pcReady` 之前处理完）**：

1. 素材 URL 先 `fetch` 成 `blob:`。`<video>` 直接指向 http 素材时它的媒体流一直挂着网络请求，
   `pauseIfNetworkFetchesPending` 会认为有 fetch 未完成，`virtualTimeBudgetExpired` 永不触发。
2. `<video>` 元素常驻挂载并等到 `readyState >= 4`（整段解码进内存）才放行 `__pcReady`；
   不命中当前 clip 时用 `visibility:hidden` 藏起来而不是卸载。
   页面里**不能**用 `setTimeout` 做逐帧超时兜底（虚拟时间下不触发），兜底一律放 node 侧。

## scripts/io-check.mjs（临时验证脚本）

puppeteer 端到端跑一遍导入导出：铺演示卡 → 导入 `out/test.mp4` → 校验 `exportProjectJson` →
重新导入验缺失素材 → 导入旧编排验未知卡跳过 → `exportVideo` 导 0-89 帧 →
用 pngjs 统计第 0/45/89 帧的非零 alpha 像素数、平均 RGB、颜色数，并复制成 `out/check-frame-0XX.png`。
用法：`node scripts/io-check.mjs`（需要 dev server 在跑）。**这是临时验证脚本，正式版可删。**

## 实测结果（2026-09-06，dev server 跑在 5196）

- `npx tsc -p tsconfig.json`：**0 错误**。
- 端到端链路已验证打通：编辑器导入视频 → 上传 → `/api/export` → `export-frames.mjs` → 带视频画面的透明 PNG。
  `out/check-frame-000.png` / `out/check-frame-001.png` 是实拍帧：ffmpeg testsrc 彩条铺满画面，
  `mu-number-ticker` 卡（「100%／已完成目标」）叠在上面。
- **未能导满 90 帧**：`export-frames.mjs` 的预热循环在真实卡片集下会死锁——虚拟时间预算耗尽后
  `page.evaluate(() => new Promise(r => requestAnimationFrame(...)))` 的 rAF 回调不再触发，
  puppeteer 报 `Runtime.callFunctionOn timed out`。已隔离验证：
  只有 `probe` 卡的 demo 时间轴正常跑完；换成 10 张真实演示卡后必挂，
  **且 `Timeline` 形状和 `Project` 形状一样挂**（说明与视频层、与 Project 解析都无关）。
- `node scripts/verify-determinism.mjs --frames 0-59`（demo 时间轴，不含视频）连跑两次：
  - 第一次：总帧数 60 / 相同 1 / 不同 59 / 最差帧 `000028.png` 差异 **1.5933%**
  - 第二次：总帧数 60 / 相同 0 / 不同 60 / 最差帧 `000028.png` 差异 **1.6998%**
  - 两遍预热测出的 `__pcClockRate` 本身就不一样（0.5143 / 0.5070），这是差异的来源。
  与上面渲染内核小节自述的「60/60 Identical」不符，需要渲染内核任务复核。
