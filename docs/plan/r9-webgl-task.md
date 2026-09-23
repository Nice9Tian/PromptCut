# R9 任务书：canvas 卡的共享 WebGL 渲染器

这份文件是 `docs/archive/restructure_planning/render_pipeline_restructure.md` 第 5 节 R9 一步的**协议全文**，自成一体：动工的人读 `docs/archive/user_pinned_goal.md`（渲染 10 是这一步的出处）、`docs/archive/restructure_planning/render_pipeline_restructure.md`（总览、3.6 的更正、步骤依赖）、`docs/archive/restructure_planning/r2-r7-task.md`（R9 依赖的 E、K 各节）和这一份就够，不需要再翻 `AGY-TASK-cloud-doc-and-write-race.md`。

**怎么来的**（2026-09-22）：正文取自任务书第 111 版的目标 M，逐条折进了三样东西——第 75 轮第 6 份分步审查里已采纳的处理意见（8 条阻塞 + 1 条非阻塞 + manager 补的 3 条前置接口不符，原文在 `docs/archive/restructure_planning/r75/agy-r75-06.md`，逐条结论在 `docs/archive/restructure_planning/r75/fold-notes.md`）、`docs/archive/restructure_planning/render_pipeline_restructure.md` 第 3.6 / 3.8 / 3.9 节的更正、以及 2026-09-22 和用户定下的几条（判重只看活渲耗时 `stepMs`、生成快照改名拆文件、画布位图换 webp 搁置、粒子卡不迁进 Worker）。

**还没做的事**：这份文件**没有经过独立审查**。第 75 轮审的是折叠之前的第 111 版；折叠本身只有我自己核过锚点和措辞。另外 `scripts/probes/gl-atlas-probe.mjs` 还没写，**它是本步的第一件事**（M3 末尾），探针不过就要换退路。

## 读法

- **步骤名的对应**：「第 1 / 2 / 2b / 3 步」都已落地（提交 `b5c65dc`）；「3b 步」= R1（差异样式内联，已完成，`e67390e`）；R1b（像素映射分流与 WebGL2 后端）已完成（`dd58cb5`）；「第 4 步」= R2～R7（见 `docs/archive/restructure_planning/r2-r7-task.md`）加上 R8（轨道流，`docs/plan/r8-streams-task.md`）和本文的 R9（第 111 版里叫「第 4b 步」）；「第 5～10 步」是云端 / 文档服务那一半，不在本文范围。**R9 依赖 R3（舞台内容、E7 的兄弟平面）和 R5（K3～K5 的跳转、节拍、追帧）**。
- **R9 之前是什么样**：canvas 卡在舞台主线程各自拿上下文自己画。`[data-pc-gl-plane]`、GL Worker 的 `beat` / `done` / `measure` 这些都是本步才有；R2～R8 的正文里遇到它们就跳过。
- **行号**：正文里的 `文件:行号` 分两类。**未标注的是 2026-09-22 当前 main（`048074c`）上逐条打开核对过的**；标了「`b5c65dc` 的行号，仅作提示」的没有核对，以符号名和引用的代码原句为准。引用的符号在当前代码里都 grep 得到，标「新」的是本任务要创建的文件。
- **用词**：一律说「预渲染」「生成快照」。`createSnapshot`（`src/render/createSnapshot.ts:137`）按顺序调五步：`cloneScene → inlineDOMStyles → rasterizeCanvas → stripMedia → serializeScene`；页面协议是 `window.__pcCreateSnapshot`（`StageView.tsx:585`）。「冻住」只用来说被抑制的卡的 `t` 停在某一刻。代码标识符里残留的 `bake*` 不受这条约束。
- **时间单位**：`beat` 里每张卡的 `t` 一律是**本地秒**（`cardT − clip.start`，`Stage.tsx:175` / `:177` 的口径）。`data-pc-gl-frame` 和包裹层的 `data-pc-local-frame` 一律是**本地帧号**（整数）。

**路径缩写表**（正文里的裸文件名都指下面这些；2026-09-22 按解耦后的位置核过，标「新」的文件还不存在、由本任务创建）：`Stage.tsx` = `src/render/Stage.tsx`；`StageView.tsx` = `src/StageView.tsx`；`ExportView.tsx` = `src/ExportView.tsx`；`FrameScene.tsx` = `src/render/FrameScene.tsx`；`Preview.tsx` = `src/editor/Preview.tsx`；`solid.ts` = `src/render/solid.ts`；`solidMode.ts` = `src/render/solidMode.ts`；`stageRpc.ts` = `src/render/stageRpc.ts`；`stageClock.ts` = `src/render/stageClock.ts`；`frameReady.ts` = `src/kernel/frameReady.ts`；`createSnapshot.ts` = `src/render/createSnapshot.ts`（R1 之前叫 `snapshotFreeze.ts`）；`rasterizeCanvas.ts` = `src/render/snapshot/rasterizeCanvas.ts`（新拆出来的，R1）；`inlineStyles.ts` = `src/render/snapshot/inlineStyles.ts`；`pixelMapGl.ts` = `src/render/pixelMapGl.ts`（R1b 落地）；`project.ts` = `src/kernel/project.ts`（`Project` 接口在 `:260`；`src/store/project.ts` 是 store，别写错）；`frameMode.mjs` = `src/kernel/frameMode.mjs`；`bake.mjs` = `server/bakery/bake.mjs`；`frame-pipeline.mjs` = `server/frame-pipeline.mjs`；`probe-card-costs.mjs` = `scripts/probe-card-costs.mjs`；`CanvasCardProgram.ts` / `glWorker.ts` / `glHost.ts` / `programs.ts` = `src/render/gl/` 下同名文件（全新）；`gl-atlas-probe.mjs` = `scripts/probes/gl-atlas-probe.mjs`（新）；卡片文件（`particles.tsx` / `scene-3d.tsx`）在 `src/cards/native/`。

## 这一步做什么、依赖什么、怎么验收

| | |
|---|---|
| **做什么** | **舞台只开一个 WebGL 上下文，放在 Worker 的 OffscreenCanvas 里**，canvas 卡不再自己拿上下文。每张卡自带 GLSL、各编各的 program、纹理只上传一次；每拍收 `t` 画进一张图集，按卡裁成位图交回各自的 `<canvas>`，回 `done` 主线程才推进一拍。本地模式和在线浏览器模式一样，不依赖预渲染进程；预渲染进程产死素材时加载的也是导出页，走同一套。 |
| **为什么要做** | 今天 5 张 canvas 卡各自拿上下文：`particles`（2D canvas，`particles.tsx:235` 把 `transferControlToOffscreen` 短路成真画布）、`scene-3d`（`scene-3d.tsx:152` 自建 `THREE.WebGLRenderer`、开了 `preserveDrawingBuffer`）和三张 runtime 用户卡 `logo-3d-9tian` / `route-globe-wa-3d` / `rpk-3d-showcase`（都是 three.js）。每张一个 WebGL 上下文，发指令的 JS 全在舞台主线程；Chrome 一页最多约 16 个活的上下文，多了丢最早的（`webglcontextlost`）。 |
| **先做什么** | `gl-atlas-probe.mjs`。第一件事先验「MSAA FBO → `blitFramebuffer` → `createImageBitmap`」两条路线都成立，再量 20 张卡每拍 `createImageBitmap` + transfer 的主线程耗时。不达标就走 M3 末尾的退路。 |
| **依赖哪几步** | R3（E7 的兄弟平面与四条类选择器）、R5（K3 的跳转、K4 的节拍、K5 的追帧与角色互换）。 |
| **读哪几节** | 本文 M1～M7；`docs/archive/restructure_planning/r2-r7-task.md` 的 E7 第 5 条（兄弟平面）、K1（探针）、K2（贪心分派）、K3(a)（同步 `advanceTo`）、K4（一拍的顺序）、K5（两路追帧与互换）、K6（降级）、约束第 1 条（fps 与 `glRoute` 下拉）、J4（宿主能力表）。 |
| **单步验收** | 见本文「验收」一节。 |

---

## 目标 M：canvas 卡的共享 WebGL 渲染器

### M1 契约：主线程一半、Worker 一半

**为什么要拆两半。** Worker 是独立的 JS 运行环境，`postMessage` 传不了函数对象。所以契约拆开：

- **可序列化的那一半收进 `CardDef` 的一个独立字段** `canvas?: { kind: 'gl' | 'three' | '2d' | 'dom2d'; programId?: string; textures?: Array<{ name: string; mediaId?: string; url?: string }> }`。**不用顶层 `kind`**——H1 已给 `CardDef` 加了 `kind?: 'animation' | … | 'audio'`，同名不同值在 `strict` 下编不过。有 `canvas` 字段的卡就是 canvas 卡（`canvasHeavy` 只在探针到达前当兜底）。
- **函数那一半放独立模块** `<卡文件同目录>/<id>.gl.ts`，**不 import React、不碰 DOM**，导出 `program`。类型定义在 `CanvasCardProgram.ts`。
- **注册表** `programs.ts`：`import.meta.glob('../../cards/**/*.gl.ts', { eager: true })`，按 `programId` 取。Worker 是**模块 Worker**（`new Worker(new URL('./glWorker.ts', import.meta.url), { type: 'module' })`），import 这张表；M2 的主线程退路 import 同一张表。用户卡的 `.gl.ts` 在本地模式由 vite 照常服务；在线浏览器模式只有内置卡（那个模式根本加载不了用户卡）。

**三种进 Worker 的契约**：

| kind | `program` 的形状 | 画在哪 |
|---|---|---|
| `gl` | `{ vertex: string, fragment: string, uniforms(t, params): Record<string, number \| number[]>, geometry?: 'quad' \| { vertices, indices }, extensions?: string[] }` | 共享上下文，图集里自己那块区域 |
| `three` | `{ build(THREE, params, { textures }): { scene, camera, update(t, { reset }) } }` | 渲染器由 M2 用共享上下文建一次（`new THREE.WebGLRenderer({ canvas: offscreen, context: gl })`），各卡的 scene 各画各的、用 `setViewport` / `setScissor` 画进图集自己的区域 |
| `2d` | `{ draw(ctx, t, params, { images, reset }) }` | 同一个 Worker 里各自的 `OffscreenCanvas` 2D 上下文（不占 WebGL 上下文） |

**`textures` 三种 kind 共用。** Worker 按 `mediaId + tier` 缓存**解码后的 `ImageBitmap`**；在这之上 `gl` 支再缓存 `WebGLTexture`，`three` 支缓存一份 `THREE.Texture`（同一个 renderer 下多张卡传同一个实例，所以只上传一次），`2d` 支直接拿 `ImageBitmap`。取法就是 `build(THREE, params, { textures })` / `draw(ctx, t, params, { images, reset })` 的第三个参数。

**三种契约的共同点**：**只收 `t`（本地秒）、params 和 `reset` 位，不读 rAF / `performance.now` / `Date.now`**（Worker 里没有舞台的虚拟时钟，时间只能由主线程给）。`reset` 到时把内部状态（粒子池、随机种子、three 的 mixer 时间）清零再推到 `t`——`update(t, { reset })` / `draw(ctx, t, params, { images, reset })` / `uniforms(t, params)`（纯函数的卡忽略它）。

**第四种 `dom2d` 不带函数。** 卡的 `Component` 自己渲 `<canvas>` 并在 effect 里按 `t` 同步画（今天粒子卡的做法）；没有 gl 平面、不进 Worker；在 `beat.cards` 里登记它只为**和别的卡同拍落定**（对它 `done` = 主线程画完）；生成快照时直接读它自己的 canvas。

**canvas 卡仍必须有 `Component`**（可以只渲 DOM 部分或直接返回 `null`）——`canvas` 契约只决定 `Stage` 额外渲一个兄弟平面，`Stage.tsx:177` 的 `<C>` 分支和 `isCardDef`（`src/cards/user/index.ts:14-25`）都不用为它加新支，H1 的「不要改成 `if (!C) return null`」照旧成立。

**`Stage` 不需要新 prop**：片段的 `CardDef` 带 `canvas` 契约，就在包裹层里渲 `<canvas data-pc-gl-plane={clip.id}>`（尺寸 = 片段实体框，`bitmaprenderer` 上下文），卡片组件本身不再渲 `<canvas>`。**这个平面不加 `data-pc-clip`**——`solid.ts:102` 的 `isSolid` 把带 `data-pc-clip` 的元素当包裹层跳过，加了整类 canvas 卡点不中。`StageView` 收到 `done` 后按 `data-pc-gl-plane` 的值找平面（`querySelector('[data-pc-gl-plane="…"]')`，或挂载时用 ref 收进 `Map<clipId, HTMLCanvasElement>`）。E7 的六个可选 prop 不变。

### M2 Worker 与两条路线（`glWorker.ts` / `glHost.ts`）

**Worker 的创建放在两个宿主共用的模块** `glHost.ts`：`createGlHost(sceneRoot)`，**`StageView` 和 `ExportView` 挂载时都调它**——预渲染进程加载的是导出页（`frame-pipeline.mjs:160` / `:229` 的 `?export=1`），不建就没有 Worker、gl 平面永远是空的。

**两条路线同时实现**（pinned 渲染 10 末句）。项目选项 `glRoute: 'perDocument' | 'shared'`（字段加在 `project.ts:260` 的 `Project` 接口上；默认值、切换后重建 `glHost` 并重走 K1 的 `ProbeGate` 遮罩，见「约束」第 1 条）。桌面默认 `perDocument`、低内存档默认 `shared`。**两条只在 `glHost` 的建法上不同，M1 契约、M3 协议、M4 探针一字不改。**

- **路线 1 `perDocument`**：`front` / `back` / 导出页各持一个 Worker、一个上下文；`back` 的探针和补跑用它自己的。
- **路线 2 `shared`**：父页（编辑器文档）`new Worker` 一次、持唯一的上下文和图集，`new MessageChannel()` 两次，把 `port1` 分别 `postMessage(port, [port])` 转进 `front` 和 `back`（`MessagePort` 可跨源转移，E1 的两个 iframe 是跨源的），两个舞台的 `glHost` 用拿到的端口而不是自己的 Worker 收发同一套 `beat` / `done` / `measure` / `release` 消息。GL 线程落在编辑器进程里（独立线程，不碰主线程），舞台的进程隔离对它不成立，这是路线 2 的代价；**导出页在预渲染进程里没有父页，永远走路线 1**。

**端口转交协议。** 父页在收到该舞台 `pc-stage-ready` 之后、发任何 RPC 之前，先 `postMessage({ type: 'gl-port', stageId, port }, [port])`；舞台的 `glHost` 收到之前把 `beat` 排队、不呈现 canvas 卡。路线 1 下这条消息不发、`glHost` 在握手后自己 `new Worker`。共享 Worker 里**每个 `stageId` 一个 framebuffer 图集**，`release({ stageId })` 只清那一份，另一舞台在飞的区域坐标不动。

**`stageId` 必须与角色脱钩。** Worker 按 `stageId` 各维护一份「活跃卡集合 + 图集区域」、共用 program 缓存和纹理缓存（所以纹理只有一份），**互换角色时 `stageId` 不变**：新 `front`（原 `back`）继续用自己的 `stageId` 发 `beat`，Worker 里它那份区域就是互换前补跑到目标帧的那份；旧 `front` 收到 `setRole('back')` 时它的 `glHost` 发一条 `release({ stageId })`，Worker 释放那份区域（路线 1 里这一步就是 `back` 闲时释放）。**今天的落地口径不满足这一条**：`stageId` 取自 iframe URL 的 `id` 参数（`stageRpc.ts:330` 的 `q.get("id") || "front"`），而 `Preview.tsx:607` 写死 `?stage=1&id=front`、探针 `scripts/probes/stage-rpc-probe.mjs:76` 断言 `out.caps.stageId === 'back'`——都是**角色名**，角色一换区域就跟着换。**E1 落地时两个 iframe 的 URL 改成 `?stage=1&id=A` / `id=B`，角色只经 `setRole` 走，探针的断言同步改。**

**统一的画法（两条路线一样）。** 上下文属性 `{ alpha: true, antialias: false, premultipliedAlpha: true }`；每个图集画在**多重采样 FBO** 上（`renderbufferStorageMultisample`，`samples = min(4, MAX_SAMPLES)`），`blitFramebuffer` 解析到不带抗锯齿的默认帧缓冲（那张 `OffscreenCanvas`）再按区域裁位图。**为什么不能直接开 `antialias: true`**：WebGL2 不允许往多重采样的绘制缓冲 blit，开了 `antialias` 的默认帧缓冲就是多重采样的。`three` 支用 `WebGLRenderTarget({ samples })`。

**图集画布由 `glHost` 建。** `glHost` 建 Worker（路线 1）或父页建 Worker（路线 2）时，把一张 `OffscreenCanvas` `transferControlToOffscreen` 过去；Worker 在它上面持一个 WebGL2 上下文。图集尺寸 = 各活跃 canvas 卡实体框的打包结果，上限 4096²、低内存档 2048²，超了分多张。**显存不重复三份**：GL 对象不能跨上下文、上下文不能跨文档，所以靠按需持有——图集按当前活跃集合打包、不固定 4096（一张 4096² RGBA 是 64 MB），活跃集合变了就重打包；`back` 只在探针 / 补跑 / 预渲染任务进行时上传纹理和开图集，队列空就 `deleteTexture` / 把图集缩到 1×1、只留上下文（下次任务重新上传，纹理来自本地内容库、代价是一次解码）；program 的机器码由 Chrome 的着色器缓存按源码去重、三个上下文不存三份。稳态显存 = `front` 一份全量 + `back` 近零，导出页在预渲染进程的 Chrome 里、不在用户机的这份预算内。

**图集打包**：`Stage` 每次活跃 canvas 卡集合变化时发一次 `layout`（各卡的像素尺寸），Worker 用 shelf 打包算区域并回 `regions`。

**program 各编各的**：`compileShader` / `linkProgram` 用 `KHR_parallel_shader_compile`，`COMPLETION_STATUS_KHR` 轮询，按 GLSL 哈希缓存（同一张卡的多个片段共用）；编译期间该卡在图集里留空、舞台那一层透明。

**素材纹理只上传一次**：按 `mediaId + tier`（A1 的两档）缓存；视频素材每拍由主线程 `createImageBitmap(video)` 传过去（transferable，零拷贝）。

**能力检测与退路。** `glHost` 先测 Worker 里能不能拿到 `OffscreenCanvas` 的 `webgl2` 上下文（判据已落地：`stageRpc.ts:322` 的 `offscreenGl`，Safari 17 以前不行、部分 WebView 不行），不能就退回今天的路——canvas 卡在舞台主线程自己画（M1 契约照用，`glHost` 在主线程建一个上下文顶替 Worker，import 同一张 `programs.ts`），探针照量、按实测分派，只是这类卡更容易判重；`beat` / `done` 协议不变（主线程同步画完就算 `done`）。

**低内存档**（平板：Apple 芯片是统一内存、Safari 每标签页只给 1～2 GB）。判据也已落地（`stageRpc.ts:329`：`navigator.deviceMemory ≤ 4` 或 Safari）。此时纹理一律取素材的小分辨率档（A1 的 `tiers.small`，没有才取原片）、图集上限 2048²；路线 1 下 `back` 舞台不开 Worker（探针和补跑对 canvas 卡走主线程退路，`stepMs` 按退路量、和 `front` 的 Worker 口径不同，**所以低内存档默认走路线 2**）；路线 2 下 `back` 本来只收端口、不多开任何东西，探针和 `front` 同一个 Worker、同一口径。

**写进 `costs` 的 `device`。** `offscreenGl` / `lowMemory` / 当前 `glRoute` 由 J4 的宿主能力表报给父页，并进 `device` 字段一起去重（`stepMs` 含 `beat → done` 往返，两条路线量级不同，切路线等于换机器、重探针）。**`glRoute` 要取生效路线**：`project.glRoute ?? (lowMemory ? 'shared' : 'perDocument')`。今天 `probe-card-costs.mjs:191` 只按 `caps.lowMemory` 算（`glRoute: caps.lowMemory ? 'shared' : 'perDocument'`），用户在项目选项里把桌面手切成 `shared` 时 `device` 不变、旧记录不会作废，和「切 `glRoute` 后重走 `ProbeGate`」的前提对不上。改法：离线探针用已有的 `--gl-route` 开关（`probe-card-costs.mjs:94` / `:433`）覆盖，页面侧的 `ProbeGate` 传生效路线。

### M3 节拍协议（K4 的一部分）

**凡是舞台向用户或截图呈现一帧，就对自己的 Worker 发一次 `beat` 并等 `done`。** 具体是这些时机：

- K4 的每一拍；
- `setTime` 落定那一帧；`advanceToAsync` 每次让出前的那一帧；
- **导出页 / 预渲染页每一帧**；
- K5 第一路和 K3(b) 追帧**追上那一帧**（追帧中间步不呈现——被 `.pc-settling` 藏着——所以不发，和同步 `advanceTo` 的豁免同一道理；canvas 卡按契约只收 `t`，追上那一拍给它一个带 `reset`（向后时）的 `beat` 就到位，**追帧的 GPU 成本因此不进 K2 / K6 的预算**）；
- K5 第二路补跑到目标的那一帧；K1 探针生成快照的每一帧；预渲染进程截流的每一帧；预渲染页生成 HTML 快照的每一帧（不发就会被 M4 的 `lossy++` 和 `bake.mjs:269` 的 throw 判成硬失败）。

**同步的 `advanceTo`（K3(a)，≤ 30 步、同步块里等不到 Worker）不逐步发**：只在它结束后发一次带终点 `t` 的 `beat`（canvas 卡按契约「只收 `t`」自己从当前状态推到目标，粒子卡内部本来就是整格推进到目标，`particles.tsx:209`），落定前等这一次 `done`。

**一拍的顺序写死**（K4 和 M3 共用这一条）：

1. `clock` 推到下一拍、`flushSync(setT)`、`pinner.sync`（DOM 提交完）；
2. `glHost.beat(t, cards)`；
3. `await done`（**慢帧就等在这里**）；
4. 位图 `transferFromImageBitmap` 到各平面、写 `data-pc-gl-frame`；
5. `await realRaf()`（`StageView.tsx:73`）；
6. post `frame`。

`settle` 的 `queueMicrotask`（`StageView.tsx:180`）在第 1 步之后、第 3 步的 await 恢复之前跑，互不依赖。**领帧票**：`glHost` 每发一次 `beat` 就用 `beginFrameWork('gl')`（`frameReady.ts:6`，H3 的 `GraphCard` 已是这个用法）领一张票、收到 `done` 再 `ready()`，于是 `bake.mjs:175` 的 `waitFrameReady` 天然把 `done` 等进来，`__pcCreateSnapshot` 保持同步、J2 的协议清单不用加条目。

**导出页的 `beat` 发在哪。** 导出页的帧推进由 `window.__pcSetT`（`ExportView.tsx:156`）驱动：它写 `__pcExportMs` 并触发 React 重渲染。`beat` 发在**那次重渲染的 `useLayoutEffect`**（依赖导出时间）里，同一处 `beginFrameWork('gl')` 领票。`ExportView.tsx:168` 已经把 `waitForFrameWork` 挂成 `window.__pcFrameReady`，Node 端照旧等它。

**`beat` 消息**：`postMessage({ type: 'beat', t, cards: [{ clipId, t, params, reset? }] })`。

- 每卡的 `t` **一律是本地秒**（`Stage.tsx:175` / `:177` 的 `cardT − clip.start` 口径；追帧中的卡是它的追帧本地秒，其它卡是 `全局 t − clip.start`）。
- 只传变了的 params。
- `reset: true` 在该片段重挂载（`remountGen` 变）或 `t` 比上一次发给它的小（向后拖、K3(a′) 向后跳、K1 布尔探针复位、K5 第一路从挂载帧起步）时带上；Worker 侧把这张卡的内部状态清零后再推到 `t`（对照 `particles.tsx:169` 今天的倒退重播种）。
- **`cards` 只剔「在 `suppressed` 里」和「在 `snapshots` 里且不在 `settling` 里」的 canvas 卡**——前者在贴流，后者在贴快照且没在追。正在追的卡虽然快照平面还挂着（K5 第一路：追完才从 `snapshots` 移出）也要画，它的 gl 平面被 `.pc-settling` 藏着、用户看不见；**追到 `t` 那一步要等这一拍的 `done` 回来、位图贴上后再摘 `.pc-settling` 和快照**，否则曝光的是上一拍的旧位图。

**Worker 一拍做什么**：对每张卡 `useProgram` → 设 uniform（含 `t`）→ `setViewport` / `setScissor` 到区域 → draw；全部画完 `gl.flush()`；**两条路线都是** `bindFramebuffer(READ_FRAMEBUFFER, 多重采样 fbo)` + `blitFramebuffer` 解析到默认帧缓冲（那张 `OffscreenCanvas`），再对每张卡 `createImageBitmap(atlas, x, y, w, h)`（GPU 内部引用，不走 CPU）；路线 2 下两个 `stageId` 的 blit 串行——`beat` 本来就是一拍一条。然后 `postMessage({ type: 'done', t, bitmaps: Map<clipId, ImageBitmap> }, [transfer])`。

**主线程收到 `done` 之后**：把每张位图 `transferFromImageBitmap` 到该卡包裹层里 `Stage` 渲的 `<canvas>`（`bitmaprenderer` 上下文，是 E7 的第五种兄弟平面 `[data-pc-gl-plane]`）。**它是活渲的一部分，不进 `.pc-snapshot` / `.pc-suppressed` / `.pc-settling` / `.pc-awaiting` 四条选择器的放过名单**——藏子树时它和子树一起被藏，四条选择器一字不改（`.pc-settling` 的整条规则在 K5 里，E7 第 5 条回指它；今天 `solidMode.ts:138` 只有 `.pc-proxy` 一条）。然后才走 K4 的第 5、6 步。图层关系不变：每卡一张 `<canvas>`，z 序仍由 `Stage` 的包裹层管。

canvas 卡都按 `t` 求值、都是 `vtOk: true`；K5 第一路对它就是追上那一帧发一个带本地 `t`（必要时带 `reset`）的 `beat`、等 `done` 再摘 `.pc-settling`。

**探针 `gl-atlas-probe.mjs`（本步的第一件事）。** 照 `scripts/probes/backdrop-probe.mjs` 的做法写。**第一件事先验「MSAA FBO → blit → `createImageBitmap`」两条路线都成立**；然后量 20 张卡每拍 `createImageBitmap` + transfer 的主线程耗时。不达标的**退路**：Worker `transferToImageBitmap()` 整张图集一次传回、主线程按区域 `drawImage` 到各卡的 2D `<canvas>`，多一次拷贝但只有一条消息。

### M4 探针与分派

**量什么。** K1 对 canvas 卡量的是主线程成本 + `beat → done` 的往返（用 `__pcRealNow`），Worker 侧另报每卡 GPU 时间（`EXT_disjoint_timer_query_webgl2`，没有就用 `gl.finish()` 前后的墙钟）。**`stepMs` = 两者之和的最差值**，进 K2 的贪心。（判重只看 `stepMs`；`inlineMs` / `rasterMs` / `serializeMs` 是生成快照的三段耗时，只排产能、不进判重。旧的单个 `frameMs` 字段在 R1 已删，不留兼容。）Worker 一拍画不完（`done` 晚于一拍）按 K4「慢帧就等」，K6 的一秒窗口照常降最贵的。

**生成快照怎么读 gl 平面。** `rasterizeCanvas`（`rasterizeCanvas.ts:33-66`）对 `[data-pc-gl-plane]` 的 `<canvas>` 走现有的 canvas → `<img>` 路，位图来自 `bitmaprenderer`、`toDataURL` 总能读出，WebGL 的 `preserveDrawingBuffer` 问题消失。**但空的 `bitmaprenderer` 画布 `toDataURL` 照样成功**（`rasterizeCanvas.ts:45` 不会抛，`:49` 的 `src.length > 22` 也拦不住），所以：

- `glHost` 在每次贴上位图后给平面写 `data-pc-gl-frame={该卡本拍收到的本地帧号}`（M3 里 `beat` 给这张卡的 `t` × fps 取整，和包裹层的 `data-pc-local-frame` 同单位）；
- `rasterizeCanvas` 直接按字符串比这两个属性、不需要 fps 入参，对**没有 `data-pc-gl-frame`、或它与包裹层 `data-pc-local-frame` 不符**的 gl 平面 `lossy++`；
- 配套：K1 的两趟布尔探针期间和 K5 第一路追帧期间，`Stage` 对 `settling` 里的片段把 `Stage.tsx:135` 的 `data-pc-local-frame` 也按 `settling.get(clip.id)` 算（否则子树虚拟时间下包裹层的帧号不跟着走，每张 canvas 卡都被误判 `lossy`、`vtOk` / `seekOk` 一律 `false`）；
- `bake.mjs:269` 的 `if (lossy) throw` 才拦得住空图。

**位图格式不变。** `rasterizeCanvas` 继续用 PNG `toDataURL()`；换 webp、改成异步 `convertToBlob` 都**已搁置（用户 2026-09-22），没有新的指示不要做**。本步唯一要动的快照文件就是 `rasterizeCanvas.ts`（`createSnapshot.ts` 的五步顺序、`inlineStyles.ts` 都不动）。

### M5 迁移 5 张卡

- **`scene-3d` 和三张 three.js 用户卡**改成 `canvas.kind: 'three'` 契约（删自建 `WebGLRenderer`，`scene-3d.tsx:152`）。**三张用户卡不在仓库里**，在用户机的运行时副本 `C:\Users\admin\AppData\Local\PromptCut\runtime\app\src\cards\user\`（`logo-3d-9tian` / `route-globe-wa-3d` / `rpk-3d-showcase`）。执行者把它们拷进仓库 `src/cards/user/` 做迁移和验收；迁移后的源码放进交付说明，**是否入库、是否放回 runtime 由用户定**。
- **没迁移的旧 canvas 卡（自己建上下文的）照旧能跑**：当 `canvasHeavy` 兜底、不进共享渲染器，不因 M 而坏。
- **`particles` 不迁进 Worker**：`particles.tsx:128` 的 `tsParticles.load({ element: box.current })` 要 DOM 元素、配置是异步 `fetch`，53 张粒子卡共用这份；它走 M1 的第四种契约 `kind: 'dom2d'`——仍在主线程用真画布画（`:232-236` 的 `transferControlToOffscreen` 短路保留），只登记进 `beat` 的 `cards` 以便和别的卡同拍落定。M 验收的「主线程 0 个 WebGL 上下文」仍成立（它是 2D 上下文）。长的粒子片段判重时走轨道流，见 `docs/plan/r8-streams-task.md` 的 G1。
- **导出页（`ExportView`）同样经 M2 的 Worker 画。** 像素口径用 `scripts/verify-unified-frames.mjs` 核：迁移前后同一帧**允许抗锯齿边缘差异，非边缘像素差 ≤ 1/255**（three.js 同一版本；上下文属性从 `{ alpha: true, antialias: true }` 换成 `{ alpha: true, antialias: false, premultipliedAlpha: true }` + MSAA FBO，边缘必然有差）。

### M6 uber-shader 是可选优化，不做

pinned 渲染 10 说的不是这个基础方案。留一个 `fragmentOnly: true` 的声明位给将来合并纯片元卡，本任务不实现。

### M7 把像素映射的上下文并进来

R1b 已经给像素映射做了自己的 WebGL2 后端 `pixelMapGl.ts`：**每个文档一个离屏上下文**（`:90` 的 `getContext("webgl2", …)`），按定义哈希缓存编译好的 program，画完用 `transferToImageBitmap` + `bitmaprenderer` 交给素材层自己的 `<canvas>`（`:195-199` 的 `drawPixelMap`）。它今天是舞台文档里**除 canvas 卡之外的另一个 WebGL 上下文**。

R9 落地时把这个上下文并进共享渲染器：`pixelMapGl` 不再自己 `getContext`，改用 `glHost` 那一个（路线 2 下就是父页 Worker 里那一个）。**对外契约不变**——`drawPixelMap(out, opts)` / `readPixelMap(opts)` / `compilePixelMapGlsl(def)` 的签名和像素结果都不动，`PixelMappedMedia` 不用改；`pixelMapGlContext()`（`pixelMapGl.ts:224`，只给探针用）返回共享上下文。验收：并进来前后，`scripts/probes/pixelmap-gl-probe.mjs` 的八个用例结果不变。

---

## 约束

- **帧率制与 `glRoute` 下拉。** 项目 `fps` 提供 24 / 25 / 30 / 60 四档，在项目选项面板 `src/editor/ProjectSettingsDialog.tsx` 里切换；**同一面板再加 `glRoute` 下拉**——`project.ts:260` 的 `Project` 接口加字段 `glRoute?: 'perDocument' | 'shared'`，缺省按宿主能力（`lowMemory` 时 `shared`、否则 `perDocument`）；**切换后两个舞台重建 `glHost`，并和切 fps 一样重走 K1 的 `ProbeGate` 遮罩**（`device` 变了，新 `device` 下已有记录的跳过）。整条约束的全文见 `docs/archive/restructure_planning/r2-r7-task.md` 的「约束」第 1 条。
- **不改导出像素基线的其余部分**：`FrameScene` 的 `placeholder` 分支不动、不加包裹层；`Stage` 的六个新 prop 在导出页不传。M5 明写的抗锯齿边缘差异是这一条的**唯一例外**，验收按 M5 的口径。
- **页面代码只按宿主能力表分支，不按平台名分支**（J4）。`offscreenGl` / `lowMemory` 的判据已经落地在 `stageRpc.ts:322` / `:329`。
- **在线浏览器模式下同样成立**：canvas 卡走同一套 Worker，不请求任何本机进程；那个模式加载不了用户卡 / 图卡，所以只有内置 canvas 卡参与。

## 验收

- **上下文数量，分路线写**：
  - 路线 1：每个舞台文档**恰好一个** WebGL 上下文，在它的 Worker 里；**主线程 0 个**。
  - 路线 2：舞台文档 **0 个**；父页的 Worker 里 1 个。
- **20 张 three.js 卡同时活跃不触发 `webglcontextlost`**（「20 张」= 探针脚本生成 20 个不同参数的 `scene-3d` 片段，不是仓库里有 20 张卡）。
- 同一素材被 3 张 canvas 卡引用时 Worker 只上传一次纹理（`ImageBitmap` 一份；`three` 支共用同一个 `THREE.Texture` 实例）。
- **节拍**：播放中 `beat → done` 往返 ≤ 一拍时，`frame` 序列的 `sec` 差恒为 1/fps；Worker 故意睡 100 ms 时可见舞台等它、不跳帧、40 ms 后主文档音频暂停；点时间轴一次只发一拍 `beat`；K3(a) 的同步 `advanceTo` 只在结束后发一次 `beat`。
- **快照**：生成快照对 three.js 卡得到非空 `<img>`、`lossy = 0`；把某张卡的 `data-pc-gl-frame` 人为改成不符的值时 `lossy` 计到它、`bake.mjs:269` 抛错。
- **追帧**：K5 第一路追一张 canvas 卡，追上那一拍等到 `done`、贴上位图之后才摘 `.pc-settling` 和快照（不出现旧位图闪一下）；追帧中间步不发 `beat`。
- **互换角色**：路线 2 下互换不换端口、不交接区域，`stageId` 不变；旧 `front` 发出 `release({ stageId })` 后 Worker 里那份图集区域被释放。
- **能力退路**：把 `offscreenGl` 探测强制为 `false` 时，canvas 卡在主线程画、`beat` / `done` 协议不变、画面正确。
- **探针**：`gl-atlas-probe.mjs` 两条路线的「MSAA FBO → blit → `createImageBitmap`」都成立；20 张卡每拍的主线程耗时在预算内（不在就走整图回传的退路）。
- **迁移**：5 张卡迁移后 `scripts/verify-unified-frames.mjs` 按 M5 的口径通过（非边缘像素差 ≤ 1/255）；没迁移的旧 canvas 卡照旧能跑。
- **像素映射**：`pixelMapGl` 并进共享上下文之后，`scripts/probes/pixelmap-gl-probe.mjs` 的八个用例结果与 `dd58cb5` 上一致。
- **在线浏览器模式（L）下同样成立、不请求任何本机进程。**
- 收尾照 `docs/archive/restructure_planning/r2-r7-task.md` 的「每一步通用的收尾」：`npx tsc -b --force` 零错误；`npm test` 全过；不改导出像素基线（M5 的例外除外）。验证改动用 5197 端口（`.claude/launch.json` 的 `dev-test`），不要碰用户常驻的 5190，不要动 `%LOCALAPPDATA%\PromptCut\runtime\app`。

## 不做

- uber-shader（合并纯片元卡）；只留 `fragmentOnly: true` 的声明位。
- 把粒子卡迁进 Worker（它是 `dom2d`，主线程画）。
- 给 canvas 卡加顶层 `kind` 字段（用独立的 `canvas` 字段，顶层 `kind` 已被 H1 占用）。
- 给 `[data-pc-gl-plane]` 加 `data-pc-clip`（会让整类 canvas 卡点不中）。
- 把 gl 平面加进 `.pc-snapshot` / `.pc-suppressed` / `.pc-settling` / `.pc-awaiting` 四条选择器的放过名单（它是活渲的一部分，跟子树一起藏）。
- 给 `Stage` 为 canvas 卡加新 prop、或把 `Stage.tsx:177` 的 `<C>` 分支改成 `if (!C) return null`。
- 在 Worker 里读 rAF / `performance.now` / `Date.now`（时间只由主线程在 `beat` 里给）。
- 开 `antialias: true` 的默认帧缓冲（WebGL2 不允许往多重采样的绘制缓冲 blit；抗锯齿靠 MSAA FBO + blit）。
- 固定 4096² 的图集（按活跃集合打包）。
- 追帧的中间步发 `beat`，或把追帧的 GPU 成本算进 K2 / K6 的预算。
- 把 `画布位图换 webp` / `rasterizeCanvas` 改异步一起做（已搁置）。
- 改 `createSnapshot` 的五步顺序或 `inlineStyles.ts`（本步只动 `rasterizeCanvas.ts`）。
- 改 `drawPixelMap` / `readPixelMap` / `compilePixelMapGlsl` 的对外契约（M7 只换上下文来源）。

---

## 本文没带走的内容

源文本目标 M 里下面这些句子判断为已过时或被取代，逐条说明：

1. **M1 原来的「canvas 卡不再渲 `<canvas>` 自己画，改成导出一个 `program` 描述：`{ vertex, fragment, textures, uniforms, geometry, extensions }`」写成一个整体**——函数和可序列化字段混在一个对象里，Worker 里拿不到函数。拆成 `CardDef.canvas`（主线程、可序列化）+ `<id>.gl.ts`（函数）两半，加注册表 `programs.ts`。
2. **M1 原来只给 `gl` 契约写了 `textures`**——`three` / `2d` 享受不到「纹理只上传一次」。改成三种 kind 共用，并写明三层缓存和取法。
3. **M1 原来对 `dom2d` 只说「仍在主线程用真画布画」、没有签名**——补成「不带函数、卡的 `Component` 自己在 effect 里按 `t` 画」。
4. **M2 原来的上下文属性 `{ alpha: true, antialias: true }`**（写在 M5 的括注里）——换成 `{ alpha: true, antialias: false, premultipliedAlpha: true }` + 多重采样 FBO，两条路线统一。原句在路线 2 下会丢掉抗锯齿、过不了 M5 的像素验收。
5. **M2 结尾那句「…写进 `costs` 的 `device` 字段一起去重，把一张 `OffscreenCanvas`（图集，…）`transferControlToOffscreen` 过去；Worker 持一个 WebGL2 上下文。」**——一句话拼了两件不相干的事、主语缺失，读不出图集画布由谁建。拆成两段：`device` 去重归 `costs` 那一段，图集画布归「图集画布由 `glHost` 建」那一段。语义没改。
6. **M2 原来说 `stageId` 是「每个舞台 iframe 挂载时由父页分配的固定 id，比如 `'A'` / `'B'`，互换角色不变」，当成既成事实**——落地口径其实是角色名（`stageRpc.ts:330` 缺省 `"front"`，`Preview.tsx:607` 写死 `id=front`，`stage-rpc-probe.mjs:76` 断言 `'back'`）。改成明写「今天不满足，E1 落地时改 URL 与探针断言」。
7. **M3 原来只说「画完回 `done` 主线程才推进一拍」，没说 `await done` 卡在一拍的哪两步之间、`settle` 的微任务和它谁先**——补成写死的六步顺序。
8. **M3 原来说导出页「在 `__pcSetT` 触发的那次重渲染里」发 `beat`，没说哪个生命周期**——补成「依赖导出时间的 `useLayoutEffect`」。
9. **M3 / M4 里的 `snapshotFreeze.ts:71-94`、`:198`、`freezeScene`、`__bfFreeze`**——R1 已改名拆文件：`createSnapshot.ts` + `snapshot/inlineStyles.ts` + `snapshot/rasterizeCanvas.ts`，页面协议是 `window.__pcCreateSnapshot`，`freezeCode` → `snapshotCode`，`FrozenScene` / `FrozenControl` → `SceneSnapshot` / `ControlSnapshot`。gl 平面那一段的落点全部改成 `rasterizeCanvas.ts`。
10. **M4 里的「`frameMs` = 两者之和的最差值，进 K2 的贪心」和 M2 低内存档里的「`frameMs` 按退路量」**——`frameMs` 字段在 R1 删了，判重只看 `stepMs`，两处都换名；句意（两者之和的最差值进贪心、退路另算一份口径）不变。
11. **`export-frames.mjs:610` / `:704` 两处行号**——那个文件在解耦重构里拆掉了，`waitFrameReady` 和 `if (lossy) throw` 现在在 `bake.mjs:175` / `:269`。同理源文本里「旧 `:198`（b5c65dc 后已搬到 …）」这种行内版本考古注一律删掉，只留现在的位置。
12. **M5 原来的像素口径「迁移前后同一帧逐像素相同（允许抗锯齿末位差异 ≤ 1/255）」**——MSAA FBO + blit 之后边缘必然有差，「逐像素相同」不成立。改成「允许抗锯齿边缘差异，非边缘像素 ≤ 1/255」。
13. **M5 原来只说三张 three.js 用户卡是「runtime 用户卡」**——没说在哪、谁迁、没迁的怎么办。补成 runtime 副本的绝对路径 + 拷进仓库迁移 + 是否入库由用户定 + 没迁移的旧 canvas 卡照旧能跑。
14. **M 验收原来的「舞台文档里 WebGL 上下文实例只有 Worker 里那一个」**——和路线 2（上下文在父页、舞台文档里 0 个）直接冲突。改成分路线写。「20 张 three.js 卡」原来没说卡从哪来（仓库内置只有一张），补成探针脚本生成 20 个不同参数的 `scene-3d` 片段。
15. **M2 原来对 `glRoute` 只说「项目选项 `glRoute: perDocument | shared`」、没回指字段落点**——补了回指「约束」第 1 条，并把 `project.ts` 指向 `src/kernel/project.ts:260`（`src/store/project.ts` 是 store，不是 `Project` 接口所在）。
16. **M2 的低内存档原来写「路线 1 下 `back` 舞台不开 Worker」时把判据当待办**——`offscreenGl` / `lowMemory` 的探测已经落地（`stageRpc.ts:322` / `:329`），改写成现状 + 还差什么。
