# T3b 报告：R9 canvas 卡的共享 WebGL 渲染器

分支 `claude/r9-webgl`（从 main `787f7d9` 建），worktree `.claude/worktrees/r9-webgl`，端口 5240～5249。
没有推送、没有合并。清单外的改动一律没有提交，做成补丁放在 `out/r9-glue.patch`，全文在文末。

## 结论

- **做完了**：M1、M2（两条路线、端口转交、能力退路、低内存档）、M3、M4、M5 里的 `scene-3d` 和 `particles`。
- **没做**：M7（像素映射并进共享上下文）。原因见「没做成的」第 1 条。
- **没迁**：三张 runtime 用户卡。它们不在仓库里，按主 Agent 的指示没有迁。
- **导出页暂时在主线程画**：用的是同一份渲染器代码、同样的 MSAA 画法。原因是 `server/bakery/chrome.mjs` 的 `waitNet` 会卡在 Worker 的脚本请求上，这个文件不在清单里。补丁打上之后加 `?glWorker=1` 就走 Worker，实测两种画出来的像素逐字节相同。
- **基线全绿**：`tsc` 零错误，`npm test` 1772 过、0 失败、1 跳过。确定性 1800/1800 帧相同。导出像素基线与 main 相比 1800/1800 帧逐像素相同。`verify-unified-frames` 通过。R7/R8 的 6 个回归探针全过。新写的 4 个 R9 探针全过。

## 做了什么（按 M 项）

### M1 契约

- **`src/render/gl/CanvasCardProgram.ts`**：
  - `CanvasContract`，即 `CardDef.canvas`，有四种 `kind`：`gl` / `three` / `2d` / `dom2d`，另有 `programId`、`textures` 和 M6 的 `fragmentOnly` 声明位。
  - 三种 program 的类型，以及 `layout` / `beat` / `done` / `release` / `diag` 消息的类型。
  - `CardDef.canvas` 是用 `declare module "../../kernel/types"` 做接口合并挂上去的。这样没有改 `kernel/types.ts`（它不在清单里）。
- **`textures`** 除了 `mediaId` / `url` 之外，多了一个 `param`，意思是「地址在这个参数里」。原因是 `scene-3d` 的贴图地址本来就是 `texture` 参数。
- **`src/render/gl/programs.ts`**：注册表 `import.meta.glob('../../cards/**/*.gl.ts', { eager: true })`，按文件名或导出的 `programId` 取。
- **`src/render/gl/GlPlane.tsx`** 和 **`planes.ts`**：
  - `Stage` 给带 `canvas` 契约的片段（`dom2d` 除外）在包裹层里渲 `<canvas data-pc-gl-plane={clipId}>`。尺寸等于 `frameBox`，上下文是 `bitmaprenderer`，不加 `data-pc-clip`。
  - 每次提交在 layout effect 里把这一拍要画什么登记进 `glPlanes`：本地秒、本地帧号、参数、`gen`、skip 位、纹理地址。宿主只需先 `flushSync`，再 `glHost.beat()`。
- **`Stage` 没加新 prop**，`<C>` 分支也没动。
- **`Stage.tsx`**：包裹层的 `data-pc-local-frame` 对 `settling` 里的片段改按它自己的虚拟时间算（M4 的配套）。不传 `settling` 时，表达式和原来逐字相同。

### M2 Worker 与两条路线

- **`src/render/gl/renderer.ts`**：画的那一半。Worker 和主线程退路用的是同一份代码。
  - 上下文属性 `{ alpha: true, antialias: false, premultipliedAlpha: true }`。
  - 每个 `stageId` 一份图集，画法是：多重采样 FBO（`samples = min(4, MAX_SAMPLES)`，带 DEPTH24_STENCIL8）→ 清 → 画 → `blitFramebuffer` 解析到默认帧缓冲 → 每卡 `createImageBitmap(canvas, x, y, w, h)`。
  - `three` 支只建一个 `WebGLRenderer({ canvas, context: gl })`。图集 FBO 经 `setRenderTargetFramebuffer` 交给 three，渲染目标标成 `isXRRenderTarget`、纹理标 sRGB，所以输出色彩空间和色调映射与「画到屏幕」一致；不这样做，画面会停在线性空间、偏暗。
  - `gl` 支用 `KHR_parallel_shader_compile` 轮询，program 按 GLSL 哈希缓存。
  - `2d` 支各自一张 `OffscreenCanvas` 2D。
  - 纹理分三层缓存：地址+朝向 → `ImageBitmap`，再往上是 `WebGLTexture` / 同一个 `THREE.Texture`。按引用计数回收，`release` 之后没人用的纹理就删掉。
  - 图集按活跃集合打包，上限 4096²，低内存档 2048²，放不下分页。打包在 `atlasPack.mjs`（纯函数，有单测）。默认帧缓冲取各舞台最大那一页的尺寸。
- **`src/render/gl/glWorker.ts`**：模块 Worker。两种来路收同一套消息：直接 `onmessage`（路线 1），或者父页交进来的 `MessagePort`（路线 2）。一个端口绑死一个 `stageId`。`renderer.beat` 内部串行，所以路线 2 下两个 `stageId` 的 blit 也是串行的。
- **`src/render/gl/glHost.ts`**：`StageView` 和 `ExportView` 挂载时各建一个。
  - Worker 懒建：真有 canvas 卡要画才建，纯 DOM 项目一个 Worker 都不开。
  - 路线 2 等父页的 `gl-port`。收到之前，活渲的拍不呈现 canvas 卡；严格的拍等端口，2 秒等不到就自己开 Worker。
  - 能力退路有两种触发：Worker 的 `init` 回 `ok: false`，或 `?glOffscreen=0` 强制。这时在主线程用同一个渲染器。
  - 低内存档 + 路线 1 + `back`：走主线程退路。
  - `release()`：`setRole('back')` 时调用。
- **`src/render/gl/spawnWorker.ts`**：Worker 用一个 `blob:` 引导脚本起（开发态 `import`，构建产物 `importScripts`）。原因见「更正建议」第 1 条。
- **`src/render/gl/glParent.ts`** 和 **`Preview.tsx`**：路线 2 的父页一侧。
  - 生效路线是 `shared` 时，父页建一个 Worker。每个舞台一条 `MessageChannel`。
  - 收到 `pc-stage-ready` 之后、发 `setRole` 之前，先 `postMessage({ type: 'gl-port', stageId, port }, [port])`。
  - 项目切到 `shared` 时，给已经握手的舞台补交端口。
- **`stageId` 与角色脱钩**：当前 main 已经是 `id=A` / `id=B`，探针断言也已经是 `'A'` / `'B'`（E1 落地时改的）。这一步不用再改，任务书那一段已经过时。
- **`Project.glRoute?: 'perDocument' | 'shared'`**：加在 `src/kernel/project.ts`。舞台在 `setProject` 时按 `resolveGlRoute(project.glRoute, caps.lowMemory)` 切路线。
- **`stageRpc.ts` 的 `detectHostCapabilities`**：
  - 探完 `offscreenGl` 立刻 `WEBGL_lose_context`，否则舞台主线程会一直留着一个活的上下文。
  - 支持 `?glOffscreen=0` 强制为 `false`。

### M3 节拍协议

**发拍时机（`StageView`）**：

- **K4 每一拍**：顺序是「DOM 提交 → `beat` → `await done` → 贴位图 → 等真帧 → post `frame`」。
- **`setTime` 落定那一帧**，包括连续路：同步 `advanceTo` 结束后只发一拍。
- **K1 探针**：
  - `setTime({ probe })`：`stepMs` 含 `beat → done` 往返。
  - `render` 的计时趟和快照趟：每帧都等 `done`。为此 `stageClock.advanceToAsync` 的 `afterFrame` 可以回 Promise，回 `void` 时一次微任务都不多让。
  - 两趟布尔探针：每次比对之前都等 `done`。
- **K5 第二路**：补跑到目标那一帧。
- **K5 第一路 / K3(b)**：追上那一拍先发 `beat` 并等 `done`，再摘 `.pc-settling` 和快照。任务上加了 `finishing` 位。追帧中间步不发。
- **`beat.cards` 的剔除**：只剔「在 `suppressed` 里」和「在 `snapshots` 里且不在 `settling` 里」的卡。被剔的卡留在 `layout` 里（场景不拆），只是这一拍不画。

**`reset` 与 `params`**：

- `reset` 在 `gen`（`remountGen ?? playToken`）变了，或 `t` 比上次发的小时带上。
- `params` 只在变了时带。

**`data-pc-gl-frame`**：

- 写的是登记时算的本地帧号，和包裹层的 `data-pc-local-frame` 是同一个算式（见「更正建议」第 3 条）。
- 每拍领一张 `beginFrameWork('gl')` 的票。

**导出页**：`ExportView` 在不带依赖的 `useLayoutEffect` 里发严格的拍（任何一次提交都可能换帧）。严格的拍会等编译和纹理就绪，不留空帧；纹理 404 这种硬错误会让票失败、导出报错，和原来 `scene-3d texture` 那张票的行为一致。

**`done` 晚到**：

- 活渲的拍 1 秒没回就放行：平面留上一张，循环不挂住。
- 严格的拍 15 秒没回就判票失败。
- 超时之后才到的 `done` 丢掉，位图 `close()`。
- 活渲的拍里有卡还在编译、这一拍留空时，暂停着的舞台不会自己再来下一拍，所以 40 ms 后自己补一拍，`release` 之后不补。

实测往返（编辑台，路线 1，3 张 `scene-3d`，播放 2 秒）：p50 0.7 ms / p90 2.3 ms / max 35.7 ms，0 次超时。T3a 提到的 30～84 ms 尖峰这次最大只见到 35.7 ms，按「慢帧就等」处理，`frame` 的 `sec` 差全程恒为 1/30。

### M4 探针与分派、生成快照

- **`rasterizeCanvas.ts`**：对 `[data-pc-gl-plane]`，直接按字符串比 `data-pc-gl-frame` 和最近的包裹层 `data-pc-local-frame`。没有、或对不上就 `lossy++`。这是本步唯一改动的快照文件；五步顺序和 `inlineStyles.ts` 都没动。
- **每卡 GPU 时间**：`beat({ measure })` 让 Worker 回报每卡 GPU 时间，用的是 `gl.finish()` 前后的墙钟，没接 timer query（见「没做成的」）。`setTime({ probe })` 的回包多一个诊断字段 `glGpuMs`，不进判重。
- **`device` 串里的 `glRoute`**：离线的 `probe-card-costs.mjs` 已经有 `--gl-route`。页面侧 `probeRunner.ts` 改成生效路线，这个文件不在清单里，改动在补丁里。

### M5 迁移

- **`scene-3d`**：
  - 新增 `src/cards/native/scene-3d.gl.ts`，是 `three` 契约，几何、材质、灯光、姿势仍只从 `scene3dObject.ts` 取。
  - `scene-3d.tsx` 删掉了自建的 `WebGLRenderer`、`preserveDrawingBuffer`、`ResizeObserver` 和 `import('three')`，`Component` 回 `null`。
  - 契约是 `canvas: { kind: 'three', programId: 'scene-3d', textures: [{ name: 'map', param: 'texture' }] }`。
- **`particles`**：只加了 `canvas: { kind: 'dom2d' }`，仍在主线程用真画布画，`transferControlToOffscreen` 的短路保留，没有 gl 平面。53 张素材封装粒子卡（`src/cards/assets/`，不在清单里）没加这个字段。`dom2d` 目前只是声明，不影响行为。
- **三张用户卡**：不在仓库里，在 `%LOCALAPPDATA%\PromptCut\runtime\app\src\cards\user\`，没有迁。没迁的旧 canvas 卡仍然自己建上下文，照旧能跑：没有 `canvas` 字段就不渲 gl 平面，走原来的路。

### M6

只留了 `fragmentOnly` 声明位，没有实现。

### M7

没做，见下文。

## 验证结果

以下全部在本 worktree 的 dev server 上跑：`npx vite --port 5240 --strictPort --host 127.0.0.1`，最后一轮用的是重启后的 PID 44004。对照用的 main 树是 `.claude/worktrees/r9-base`（`787f7d9`，detached），server 在 5243，PID 42808。

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0 |
| 全量测试 | `npm test` | 退出码 0；tests 1773，pass 1772，fail 0，skipped 1。含新增的 `src/render/gl/atlasPack.test.mjs`（4 条） |
| 导出确定性 | `node scripts/verify-determinism.mjs --url "http://127.0.0.1:5240/?export=1"` | 退出码 0；1800 帧 Identical 1800 / Different 0 |
| 导出像素基线（对 main） | `node out/r9exp/baseline.mjs http://127.0.0.1:5243 http://127.0.0.1:5240 out/r9baseline`（两边各导一遍默认 demo，`noVideo`，`workers: 1`，逐帧 sha256 或逐字节比） | `PASS 1800 frames pixel-identical` |
| 导出与快照重放一致 | `PC_FRAME_TEST_URL=http://127.0.0.1:5240 node scripts/verify-unified-frames.mjs` | 退出码 0，`PASS: no video during B; all HTML frames; exact video seek; random replay; cache hits; cumulative C equals A; streamed video contains all 10 frames.` |
| M5 迁移像素 | `node scripts/probes/gl-migrate-compare.mjs --base http://127.0.0.1:5243 --origin http://127.0.0.1:5240 --base-tree ../r9-base` | 退出码 0；4 张 `scene-3d`（纽结、线框方块、贴图球、逆光晶体），10 帧全过。每帧 230400 像素里与 main 相同的有 230367～230400 个；非边缘差都 ≤ 1 级（最多 7 个像素差 1 级）；边缘差最多 33 个像素 |
| M4 / M5 快照 → 重放 | `PC_FRAME_TEST_URL=http://127.0.0.1:5240 node scripts/probes/gl-unified-probe.mjs` | 退出码 0；10 帧快照都等到了 `done`，没有 lossy；第 8 帧快照里 2 张 three 卡都是非空 `<img>`；重放两次逐字节相同；导出与快照重放 129600/129600 逐像素相同 |
| R9 舞台验收 | `node scripts/probes/gl-stage-probe.mjs --origin http://127.0.0.1:5240` | 退出码 0，30 条全 PASS（逐条见下） |
| T3a 图集探针复跑 | `node scripts/probes/gl-atlas-probe.mjs --parent-port 5248 --child-port 5249` | 退出码 0；两条路线的裁位图和整图退路都 PASS；每拍主线程 p50/p90/max 为 0/0.1/0.1 ms；beat→present：perDocument 1.4/1.8/6.8 ms，shared 3/3.3/4.8 ms |
| 回归 stage-content | `node scripts/probes/stage-content-probe.mjs --origin http://127.0.0.1:5240` | 退出码 0，`fails: []` |
| 回归 stage-rpc | `node scripts/probes/stage-rpc-probe.mjs --origin http://127.0.0.1:5240` | 退出码 0，`fails: []` |
| 回归 playback | `node scripts/probes/playback-probe.mjs --origin http://127.0.0.1:5240` | 退出码 0，`fails: []`（见注） |
| 回归 reveal | `node scripts/probes/reveal-probe.mjs --origin http://127.0.0.1:5240` | 退出码 0，`fails: []`（见注） |
| 回归 stream-play | `node scripts/probes/stream-play-probe.mjs --origin http://127.0.0.1:5240` | 退出码 0，`PASS` |
| 回归 ready-index | `node scripts/probes/ready-index-probe.mjs --port 5246` | 退出码 0，`fails: []` |
| 构建（顺手） | `npx vite build --outDir out/r9build` | 退出码 0；`glWorker-*.js` 740 KB，是 IIFE、没有 import，所以 `importScripts` 引导成立。构建产物没有实跑 |

注：playback 和 reveal 第一次在 5240 上跑时，都在「two stages registered」那一步超时 180 秒。原因是那台 dev server 被我中途热改过好几次，页面里的模块带着 `?t=` 时间戳加载，探针用裸路径 `import('/src/editor/stageBridge.ts')` 拿到的是另一份模块实例，所以 `backRole()` 永远是 `'front'`。main 那台（5243）上同一步 1 秒就过。我重启了自己那台 server 再跑，两个探针都过了。这是探针的一个坑，不是代码问题，建议记进 `docs/guides/troubleshooting.md`（见「更正建议」第 5 条）。

**`gl-stage-probe` 的 30 条**（结果文件 `out/gl-stage/report.json`）：

- **路线 1**（4 张卡、3 张共用一张贴图）：
  - 4 个平面都贴上了当前帧。
  - glHost 走自己的 Worker。
  - **舞台主线程 0 个活的 WebGL 上下文**。
  - **Worker 里恰好 1 个**。
  - `THREE.Texture` 1 个、上传 1 次。
- **节拍**：点一次时间轴只发 1 拍；往前 0.3 秒（同步 `advanceTo` 推 9 帧）也只发 1 拍。
- **快照**：`back` 下生成快照，three 卡是非空 `<img>`、`lossy = 0`；把 `data-pc-gl-frame` 改成 99999，`lossy = 1`。`bake.mjs:269` 的 `if (lossy) throw` 没动，`gl-unified-probe` 覆盖了预渲染那条路。
- **setTime 探针**：回包带 `stepMs`。
- **20 张 `scene-3d` 同时活跃**：20 个平面都贴上了；`contextLost = 0`；Worker 1 个上下文；主线程 0 个。
- **能力退路**（`?glOffscreen=0`）：
  - `offscreenGl = false`，glHost 走主线程。
  - 协议不变，平面照样贴上。
  - 主线程恰好 1 个上下文。
  - 画面与 Worker 那条路逐像素相同，差异字节 0。
- **路线 2**（编辑台，`glRoute: 'shared'`）：
  - 可见舞台 3 个平面贴上了，走父页交来的端口。
  - 两个舞台文档主线程都是 0 个上下文，父页的共享 Worker 里 1 个。
  - 释放前共享 Worker 里 A、B 各一份图集；对 B 发 `setRole('back')` 后 B 那份没了、A 的不动。
  - `stageId` 仍是 `B`，端口不换。
- **播放**（路线 1，30 fps）：
  - 正常 2 秒：61 条 `frame`，`sec` 差全为 1/30。
  - Worker 故意睡 100 ms：20 条 `frame`，`sec` 差仍全为 1/30、不跳帧，到达间隔 100.8～112.5 ms；主文档判卡顿 2 次（`mediaStallCount`）。这一段 K6 还把这张卡降了级（`demoted: true`），它仍在 `pendingDemote` 里照常活渲，符合 K6。
- **追帧**（K5 第一路，判重、`vtOk` 的 `scene-3d`，`setTime(3.0, { settle: true })`）：
  - 进了 `.pc-settling`。
  - 摘掉的那一刻平面上已是目标帧：`data-pc-gl-frame = 90` 等于本地帧号 90。
  - 进 `.pc-settling` 到摘掉之间只发了 2 拍（`setTime` 自己那一拍 + 追上那一拍），90 个中间步一拍都没发。

**看过的图**：

- `out/gl-migrate/base/frames/000002.png` 和 `out/gl-migrate/candidate/frames/000002.png`：4 张 `scene-3d`，两张肉眼无差别，包括贴图球和线框方块。
- `out/r9exp/exp2/frames/000003.png`：导出页单张纽结。
- `out/gl-stage/worker.png`：路线 1，3 张贴图卡 + 纽结。
- `out/gl-stage/twenty.png`：20 张不同形状、不同颜色的 `scene-3d` 同时在屏，全部正确。第一轮全是灰色，是探针给的颜色写成了 `hsl(h s% l%)` 空格语法，`THREE.Color` 不认；改成十六进制之后，最终这一轮是彩色。
- `out/gl-unified-*/replay-8.png`：快照重放出来的纽结和贴图球。
- `out/gl-stage/editor-front.png`：编辑台截图，画面中央被「选择 AI 助手」对话框挡住了，只能看出时间轴上的两段三维物件。编辑台这一段的画面正确性靠 gl-frame 核对和 `route2` 的数据，不靠这张图。

**没跑的**：

- `scripts/probes/pixelmap-gl-probe.mjs`：它写死自己起 vite 5199（不在我的端口段），而且要求真 GPU。M7 没做，`pixelMapGl.ts` 一个字没动，结果按构造不变。
- 在线浏览器模式（L）没有实跑。

## 没做成的，以及原因

1. **M7（像素映射并进共享上下文）没做。** 按任务书的字面做法，会和它自己的「对外契约不变」冲突：
   - `readPixelMap(opts)` 是同步返回像素的，`drawPixelMap` 同步画完；并进 Worker 就只能改成异步。
   - 像素映射的上下文是 `premultipliedAlpha: false`（直通 alpha，抠色到透明时 rgb 大于 alpha），canvas 卡的是 `premultipliedAlpha: true`。共用一个默认帧缓冲，半透明像素的结果会变。
   - 源是 `<video>` / `<img>` 元素，进 Worker 要先 `createImageBitmap`，每帧多一次异步。
   - `pixelMapGlContext()` 要把「共享上下文」交给主线程上的探针，而 Worker 里的上下文交不出来。

   按「语义未定的地方取最保守」的原则，保持 `pixelMapGl.ts` 不动，列入待用户定。
2. **导出页没走 Worker**：见上文和补丁里 `chrome.mjs` 那一处。打上补丁、带 `?glWorker=1` 实测可以走 Worker，6 帧与主线程那条逐字节相同。要默认走 Worker，需要补丁合入后把 `ExportView` 里 `mainThread: !worker` 的缺省翻过来。
3. **切 `glRoute` 后重走 `ProbeGate` 遮罩**：
   - `device` 串用生效路线，这一处在补丁里（`probeRunner.ts`）。打上后旧记录不命中、会重测，但 `firstPassDone` 只在切 fps 时复位，所以不一定挡遮罩。
   - 项目选项面板的下拉也在补丁里（`ProjectSettingsDialog.tsx` + `projectMeta.ts` 的类型）。
   - 这几个文件都不在清单里，所以都没提交。
4. **每卡 GPU 时间**只用了 `gl.finish()` 前后墙钟这条退路，没接 `EXT_disjoint_timer_query_webgl2`。它只作诊断，不进判重。
5. **`gl` / `2d` 两种契约**写了，但仓库里没有卡用它们，没有实跑验证。三张 three.js 用户卡、以及以后的 `gl` 卡，第一次用的时候要看一眼。
6. **`mediaId` 纹理**（低内存档取 `tiers.small`）：契约里有这个字段，但 `GlPlane` 目前只解析 `url` / `param`，`mediaId` 会被忽略。原因是 `Stage` 手里的 `Timeline` 没有素材表。目前没有卡用它。
7. **比上限还大的卡**（单卡超过 4096 或 2048）夹到上限、CSS 拉伸，没有做分块。

## 对任务书 / 语义的更正建议

1. **Worker 的起法。** M2 写的是 `new Worker(new URL('./glWorker.ts', import.meta.url), { type: 'module' })`。在受帧控制的导出页里，Worker 主脚本请求的收尾事件报在 Worker 自己的 target 上，`chrome.mjs` 的 `waitNet` 在页面的 Network 域里看它一直「在路上」，每帧白等 30 秒后报错（实测）。改成 blob 引导也一样被记账（`Script blob:...`）。所以要么 `chrome.mjs` 放过 `blob:`（补丁），要么导出页不开 Worker（现状）。建议在任务书 M2 里加一句。
2. **「图集画布由 `glHost` `transferControlToOffscreen` 过去」行不通。** 粒子卡在全局把 `HTMLCanvasElement.prototype.transferControlToOffscreen` 短路成了「返回画布自己」（`particles.tsx` 的 `withRealCanvas`），一旦有粒子卡挂载，这个方法就坏了。现在的做法是 Worker（或主线程退路）自己 `new OffscreenCanvas`。建议任务书改成「由 Worker 自己建 `OffscreenCanvas`」。
3. **`data-pc-gl-frame` 的口径。** 任务书写的是「`beat` 给这张卡的 `t` × fps 取整」。但包裹层在 LEAD 窗口里的本地帧号可以是负数，而传给卡的 `t` 被夹到 0，按任务书的写法两者对不上，会误判 `lossy`。现在写的是登记时和 `data-pc-local-frame` 同一个算式算出来的帧号。建议任务书改成这个口径。
4. **`build(THREE, params, { textures })` 的第三个参数不够用**：`scene-3d` 的相机要画布宽高和项目的 `camera3dFov`。现在第三个参数是 `{ textures, width, height, stage }`，`2d` 的 `draw` 同理。纹理也需要「地址在某个参数里」这种来源（`param`）。
5. **`stageId` 与角色脱钩在 E1 已经落地**（`id=A` / `id=B`、`stage-rpc-probe` 已断言 `'A'` / `'B'`），任务书 M2 那一段「今天不满足」已经过时。
6. **舞台页的 `setTimeout` 是虚拟时钟。** 主线程退路里 three 的 `compileAsync` 靠全局 `setTimeout` 轮询，暂停时永远等不到。现在主线程上改用同步 `compile`。建议写进 `card-authoring-guide.md`：canvas 卡的 `.gl.ts` 不要依赖 `setTimeout`。
7. **探针和热改。** 同一台 dev server 被热改过之后，探针用裸路径 `import('/src/...')` 会拿到另一份模块实例，`playback` / `reveal` 因此假失败。建议写进 `docs/guides/troubleshooting.md`：「验证前重启 dev server」。
8. **`CardDef.canvas` 放在哪。** 现在是在 `render/gl/CanvasCardProgram.ts` 里用接口合并挂到 `CardDef` 上。建议合入时直接写进 `src/kernel/types.ts`（一行字段加一个 import type），更直白。

## 待用户定

1. **M7 怎么做。** 三个选项：
   - (a) 保持现状，像素映射仍自带一个主线程上下文；
   - (b) 改成异步：Worker 里画，`readPixels` 读回直通 alpha，再 `createImageBitmap` 回传，`readPixelMap` 保留一份主线程实现只给探针用；
   - (c) 改 M7 的验收口径。

   现在按 (a)。
2. **导出页走不走 Worker。** 需要先合入补丁里 `chrome.mjs` 那一处。现在按保守做法走主线程，代码和像素都相同。
3. **补丁合不合**：`out/r9-glue.patch`，涉及 `chrome.mjs`、`ProjectSettingsDialog.tsx`、`projectMeta.ts`、`probeRunner.ts`。
4. **三张用户卡要不要拷进仓库迁移，还是等用户自己迁。** 契约现在已经可以直接用：写一个 `<id>.gl.ts`，导出 `program: ThreeProgram`，卡上加 `canvas: { kind: 'three' }`，`Component` 回 `null`。
5. **53 张素材粒子卡要不要也标 `canvas: { kind: 'dom2d' }`。** 目前这个标记只是声明，不改行为。
6. **活渲的拍的超时。** 1 秒放行、平面留上一张，这个值是我定的，任务书没写。严格的拍 15 秒判失败，对应导出每帧 20 秒的就绪上限。
7. **临时 worktree。** 对照用的 main 树 `.claude/worktrees/r9-base`（detached `787f7d9`）还在，没删，由主 Agent 决定。它的 vite（5243）已停。

## 清单外补丁（`out/r9-glue.patch`，没有提交）

```diff
diff --git a/server/bakery/chrome.mjs b/server/bakery/chrome.mjs
--- a/server/bakery/chrome.mjs
+++ b/server/bakery/chrome.mjs
@@ -195,6 +195,11 @@ async function newSession(browser, url) {
      * __pcFrameReady 逐层等 seek 到位,这里再等一遍既不需要也等不到。
      */
     if (e.type === 'Media') return;
+    /*
+     * `blob:` 脚本也不算(R9):GL Worker 由一个 blob 引导脚本起,Worker 主脚本请求的收尾事件报在 Worker 自己的
+     * target 上,页面的 Network 域里永远等不到 loadingFinished。blob 是本地内存,本来就没有「在路上」这回事。
+     */
+    if (String(e.request?.url || '').startsWith('blob:')) return;
     inflight.set(e.requestId, `${e.type || '?'} ${String(e.request?.url || '').slice(0, 120)}`);
   });
diff --git a/src/editor/ProjectSettingsDialog.tsx b/src/editor/ProjectSettingsDialog.tsx
--- a/src/editor/ProjectSettingsDialog.tsx
+++ b/src/editor/ProjectSettingsDialog.tsx
@@ -57,12 +57,15 @@
   const curDuration = useStore((s) => s.project.duration);
+  const curGlRoute = useStore((s) => s.project.glRoute);
 ...
   const [duration, setDuration] = useState("");
+  /** R9:canvas 卡的共享 WebGL 渲染器走哪条路线;空串 = 按宿主能力(低内存档 shared,否则 perDocument) */
+  const [glRoute, setGlRoute] = useState<"" | "perDocument" | "shared">("");
@@ -79,6 +82,8 @@
       fps,
+      // 切了路线:两个舞台按新的生效路线重建连接;`device` 串跟着变,probeRunner 重挡遮罩、重测(同切 fps)
+      glRoute: glRoute || undefined,
     });
@@ -105,8 +110,9 @@
       setDuration(String(curDuration));
+      setGlRoute(curGlRoute ?? "");
     }
-  }, [open, curW, curH, curName, curFps, curDuration]);
+  }, [open, curW, curH, curName, curFps, curDuration, curGlRoute]);
@@ -204,6 +210,20 @@
             </select>
           </div>
+          <div className="pc-dialog-row">
+            <label className="pc-dialog-label" htmlFor="pc-proj-gl-route">三维渲染</label>
+            <select
+              id="pc-proj-gl-route"
+              data-pc="gl-route-select"
+              className="pc-dialog-select"
+              value={glRoute}
+              onChange={(e) => setGlRoute(e.target.value as "" | "perDocument" | "shared")}
+            >
+              <option value="">自动(按本机内存)</option>
+              <option value="perDocument">每个舞台各一个</option>
+              <option value="shared">两个舞台共用一个(省内存)</option>
+            </select>
+          </div>
           <div className="pc-dialog-row">
diff --git a/src/editor/probeRunner.ts b/src/editor/probeRunner.ts
--- a/src/editor/probeRunner.ts
+++ b/src/editor/probeRunner.ts
@@ -130,7 +130,8 @@ function deviceStringOf(tuning: PipelineTuning): string {
     offscreenGl: !!caps?.offscreenGl,
-    glRoute: resolveGlRoute(null, lowMemory),
+    // 生效路线(M2):项目选项优先,否则按低内存档。切了路线等于换机器,旧记录不命中、重探针
+    glRoute: resolveGlRoute(currentProject?.glRoute ?? null, lowMemory),
diff --git a/src/store/actions/projectMeta.ts b/src/store/actions/projectMeta.ts
--- a/src/store/actions/projectMeta.ts
+++ b/src/store/actions/projectMeta.ts
@@ -4,7 +4,7 @@
-  setProjectMeta(patch: Partial<Pick<Project, "name" | "width" | "height" | "fps" | "duration" | "themeId" | "camera3dFov">>) {
+  setProjectMeta(patch: Partial<Pick<Project, "name" | "width" | "height" | "fps" | "duration" | "themeId" | "camera3dFov" | "glRoute">>) {
```

这里的 diff 为了篇幅省略了上下文行，可直接 `git apply` 的完整版本是 `out/r9-glue.patch`。打上后 `tsc` 零错误（实测过）。

## 文件清单

- **新增**：
  - `src/render/gl/` 下：`CanvasCardProgram.ts`、`atlasPack.mjs`、`atlasPack.d.mts`、`atlasPack.test.mjs`、`renderer.ts`、`glWorker.ts`、`glHost.ts`、`glParent.ts`、`spawnWorker.ts`、`planes.ts`、`GlPlane.tsx`、`programs.ts`
  - `src/cards/native/scene-3d.gl.ts`
  - 探针：`scripts/probes/gl-stage-probe.mjs`、`gl-migrate-compare.mjs`、`gl-unified-probe.mjs`
- **修改**：`src/render/Stage.tsx`、`src/StageView.tsx`、`src/ExportView.tsx`、`src/editor/Preview.tsx`、`src/render/stageRpc.ts`、`src/render/stageClock.ts`、`src/render/snapshot/rasterizeCanvas.ts`、`src/kernel/project.ts`、`src/cards/native/scene-3d.tsx`、`src/cards/native/particles.tsx`
- **没动**：`server/frame-pipeline.mjs`、`server/bakery/**`、`server/vision/**`、`server/asset-*`、`server/vite-plugin-media.ts`、`src/render/pixelMapGl.ts`、`src/render/createSnapshot.ts`、`inlineStyles.ts`
