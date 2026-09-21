# R8 任务书：轨道流（H.264 上下拼合 alpha，挂 `streams` 开关）

这份文件是 `render_pipeline_restructure.md` 第 5 节 R8 一步的**协议全文**，自成一体：动工的人读 `user_pinned_goal.md`、`render_pipeline_restructure.md`（总览、实测数据、步骤依赖）、`docs/plan/r2-r7-task.md`（R8 依赖的 E、K、C、D 各节）和这一份就够，不需要再翻 `AGY-TASK-cloud-doc-and-write-race.md`。

**怎么来的**（2026-09-22）：正文取自任务书第 111 版的目标 G，逐条折进了四样东西——第 75 轮第 5 份分步审查里已采纳的处理意见（4 条阻塞 + 7 条非阻塞，原文在 `docs/plan/r75/agy-r75-05.md`，逐条结论在 `docs/plan/r75/fold-notes.md`）、Opus-A 的 G0-a 桌面壳探针结论（`docs/g0-a-webview2-probe.md`）、`render_pipeline_restructure.md` 第 3.5 / 3.8 节的更正、以及 2026-09-22 和用户定下的几条（判重只看活渲耗时 `stepMs`、生成快照改名、粒子卡不迁 Worker、长粒子片段交给轨道流）。

**还没做的事**：这份文件**没有经过独立审查**。第 75 轮审的是折叠之前的第 111 版；折叠本身只有我自己核过锚点和措辞。另外 **G0-b 编码原型还在另一个 worktree 里跑，结论没回来**——正文里凡是标了「待 G0-b 原型定稿」的数都是第 111 版的初值，不是结论，原型报告回来之后要逐处回填再动工。

## 读法

- **步骤名的对应**：「第 1 / 2 / 2b / 3 步」都已落地（提交 `b5c65dc`）；「3b 步」= R1（差异样式内联，已完成，`e67390e`）；R1b（像素映射分流与 WebGL2 后端）已完成（`dd58cb5`）；「第 4 步」= R2～R7（见 `docs/plan/r2-r7-task.md`）加上本文的 R8 和 R9（`docs/plan/r9-webgl-task.md`）；「第 5～10 步」是云端 / 文档服务那一半，不在本文范围。**R8 依赖 R5（K3～K6 的播放与追帧）和 R6（C2～C5 的数据面、`streamPool`）**，排在 R7 之后。
- **`streams` 开关**：R8 之前它恒为关——判重的卡在播放中贴 C4 的最近快照或透明（`docs/plan/r2-r7-task.md` 的 K5）。本文做的就是把它打开之后的那一路。
- **行号**：正文里的 `文件:行号` 分两类。**未标注的是 2026-09-22 当前 main（`048074c`）上逐条打开核对过的**；标了「`b5c65dc` 的行号，仅作提示」的没有核对，以符号名和引用的代码原句为准。引用的符号在当前代码里都 grep 得到，标「新」的是本任务要创建的文件。
- **用词**：一律说「预渲染」「生成快照」（`createSnapshot`：`cloneScene → inlineDOMStyles → rasterizeCanvas → stripMedia → serializeScene`）。「冻住」只用来说被抑制的卡的 `t` 停在某一刻，和生成快照无关。代码标识符里残留的 `bake*` 不受这条约束。
- **时间单位**：舞台 RPC 接口、`frame` 消息、`t` 一律用**秒**；分段号、本地帧号一律是整数帧。编码器和调度器里的 `*Ms` 是毫秒。

**路径缩写表**（正文里的裸文件名都指下面这些；2026-09-22 按解耦后的位置核过，标「新」的文件还不存在、由本任务创建）：`bake.mjs` = `server/bakery/bake.mjs`；`chrome.mjs` = `server/bakery/chrome.mjs`；`capture-frame.mjs` = `server/bakery/capture-frame.mjs`；`ffmpeg.mjs` = `server/bakery/ffmpeg.mjs`；`frame-pipeline.mjs` = `server/frame-pipeline.mjs`；`frame-playback.mjs` = `server/frame-playback.mjs`；`card-identity.mjs` = `server/card-identity.mjs`；`snapshot-store.mjs` = `server/snapshot-store.mjs`；`frame-stream.mjs` = `server/frame-stream.mjs`（新）；`Stage.tsx` = `src/render/Stage.tsx`；`StageView.tsx` = `src/StageView.tsx`；`ExportView.tsx` = `src/ExportView.tsx`；`solid.ts` = `src/render/solid.ts`；`stageRpc.ts` = `src/render/stageRpc.ts`；`frameMedia.ts` = `src/render/frameMedia.ts`；`frameWindow.mjs` = `src/render/frameWindow.mjs`；`streamPlayer.ts` = `src/render/streamPlayer.ts`（新）；`particles.tsx` = `src/cards/native/particles.tsx`。底稿里写 `scripts/export-frames.mjs` 的地方，内容已经拆进 `bake.mjs`（帧循环）和 `chrome.mjs`（会话与页面），按 `render_pipeline_restructure.md` 第 4 节的对照表换。

## 这一步做什么、依赖什么、怎么验收

| | |
|---|---|
| **做什么** | 给预渲染集合里的卡产「轨道流」：每张（或每组）重卡一条 H.264 流，上半 RGB、下半 alpha 灰度，裁到实体框，按 15 帧切成 fMP4 分段；页面侧自写解封装、`VideoDecoder` 硬解、WebGL 拆两半合成，贴在 `Stage` 渲的兄弟平面上。这是 pinned 渲染 10 的**播放态形态**（暂停和拖动态是 HTML 快照，见 `docs/plan/r2-r7-task.md` 的 A3a / C4）。 |
| **先做什么** | G0-b 编码原型（另一个 worktree 在跑）。**原型没定稿不动工**：解码器预算、`streamPool`、各编码器参数、裁剪矩形取法、`streams` 默认值都等它。 |
| **依赖哪几步** | R5（K3～K6：抑制、追帧、角色互换、降级）；R6（C2～C5：就绪索引与 SSE、`wanted` 优先级、`FramePipeline` 的 `streamPool`）。R2～R4 是它们的前置。 |
| **读哪几节** | 本文 G0～G7；`docs/plan/r2-r7-task.md` 的 E7 第 5 条（`suppressed` / `streamPlanes` 与兄弟平面）、K5（播放中贴流、暂停后追到活渲）、C3（就绪索引与 SSE）、C4（缺分段时贴最近快照）、D5（预渲染进程自建池、编辑器进程不留热池）、F5（重启后重建索引、租约作废）。 |
| **单步验收** | 见本文「验收」一节；`streams` 关着时全部功能与 R7 结束时逐项相同。 |

---

## 目标 G：轨道流

### G0 准入实测

分两段，都在桌面版 WebView2 窗口里跑。

**G0-a 纯探针——已过（2026-09-19，报告 `docs/g0-a-webview2-probe.md`，真壳 WebView2 153.0.4234.32 + RTX 3080）。** 三项结论：

1. `VideoDecoder.isConfigSupported({ codec: 'avc1.640028', hardwareAcceleration: 'prefer-hardware' })` = true，且**真的走了硬解**（硬解与软解的 `codedSize` 不同：1920×1088 vs 1920×1090）。实测解码耗时：1080p 稳态 1.5 ms / 帧（p50）、首帧 1.9～9.6 ms；**1920×2176（1080p 上下拼合，本任务的真实画面尺寸）2.4～2.7 ms / 帧、首帧 5.9～7.3 ms**。附带两条要写进 G5 的事实：`isConfigSupported` **不校验 level 与分辨率**（L4.0 配 1920×2176 也回 true，不能拿它当能力判据）；实际 SPS 会写成 `avc1.640033`，所以 G5 的「`codec` 从 `avcC` 拼」不是可选项。
2. 毛玻璃 9 个用例全过，数字与 Chrome 152 逐位相同；**跨源 OOPIF 里 `<video>` 下的毛玻璃模糊正确**，1280×720 复跑仍正确。跨源 OOPIF 里的玻璃能模糊父文档的 canvas 和 video。
3. OAC 双端口隔离成立：带 `Origin-Agent-Cluster: ?1` 时 iframe 是独立进程，A 舞台死循环 2.5 秒下父页最坏 rAF 间隔 7 ms、B 6 ms。**使用前提**（这条归 E1，本文只是引用）：舞台 origin 在同一个 browsing context group 里的**第一次加载**就必须带这个头，之后补加无效（Chromium 按 BrowsingInstance 缓存 origin-keyed 决定）；`window.originAgentCluster` 恒回 true、不能当判据，验收要看 CDP `Target.getTargets` 里有没有 `type: 'iframe'` 的 target。

**G0-b 编码原型（一周，与 R2～R7 并行；正在另一个 worktree 里做，结论未回）。** 它定下面这些数，本文正文里凡是标「待 G0-b 原型定稿」的都等它：

| 项 | 内容 | 定死什么 |
|---|---|---|
| (4) | 吞吐探测 N = 1、2、4、6 个解码器 | 同时活跃的解码器预算（初值 6）、`streams` 默认值 |
| (5) | 一段真 1080p 15 帧分段的编码耗时、文件大小、alpha 误差**与色差** | G3 的色彩标注（`out_color_matrix=bt709` 那一套是理论推导，没有原型背书）、验收里的编码耗时与 alpha 误差上限 |
| (6) | `frameMs`（稳态每帧）、`resetMs`（换页）、**回放到第 N 帧的耗时曲线**、两个编码器并存时的出帧节奏 | G4 的可行性条件、`streamPool` |
| (7) | `h264_nvenc` 的 `-tune ll` 与 `-rc vbr -cq` 二选一 | G3 的 NVENC 参数 |
| (8) | 重复帧稀疏分段的实际码率 | `stride` 的可取值 |
| (10) | 裁剪矩形取法：第一版的「包裹层框在整段 motion 下的包围盒」够不够，要不要改成实测实体框并集 | G1 的裁剪矩形 |

### G1 流的划分与层抑制

**一条流 = 一张预渲染集合（`plan.prerenderSet`）里的卡**，裁到该片段实体框的并集、每张卡单独一条（`canvasHeavy` 只在探针到达前按声明兜底进集合；图卡按 K 进了集合也做流）。

**裁剪矩形怎么取。** 第一版用**包裹层框在整段 motion 下的包围盒 ∩ 画布**，从项目数据算、不实测。**流的画面尺寸 = 这个矩形外扩到偶数宽、偶数高**——`format=yuv420p` 严格要求宽高都是偶数，G3 的 `pad=iw:ih+8` 只保证了高，实体框宽为奇数时 ffmpeg 直接崩；取整做在截图的 `clip` 矩形上，**滤镜链不动**。索引里每条流记 `rect: { x, y, w, h }`（舞台像素，已外扩）。是否改成实测实体框的并集，**待 G0-b 原型定稿（(10) 的交付项）**。

**合并成组流。** 同时活跃的流超过解码器预算（**初值 6，待 G0-b 原型定稿**）时，预渲染把超出的相邻重卡（都在预渲染集合里、在该段位置都判重的卡）合并成一条组流。「相邻卡一组」只在这时用，**这是唯一的合并规则**。

**组流的几何与宿主。** 组流裁到组内各卡实体框的并集、坐标是舞台像素；它的 `<canvas>` 不挂在任何一张卡的包裹层里，而是 `Stage` 渲在**与卡包裹层同一层级**（`AnimClock` 的透视父层里、和各卡包裹层是兄弟——项目设了 `camera3dFov` 时那一层有 `perspective`、是独立层叠上下文，挂在 `.pc-stage` 根下会整体压在所有卡之上或之下）的独立平面 `[data-pc-group-plane]`，`zIndex` = 组内最上面那张卡的 `zIndex`（组只由 z 序相邻的卡组成，所以组内没有别的卡插在中间），不受任何包裹层的 `frameCss` / `opacity` / `filter` / `motion` / `isolation` 影响——这些在预渲染截流时已经画进流里。组内各卡照常 `.pc-suppressed` 藏子树、各自不挂单卡流平面。`setStreamPlanes` 的元素是 `{ clipIds: string[] }`（单卡流就是长度 1；这个形状已经落地，`stageRpc.ts:145`）。

**组流平面的命中与实体框。** `[data-pc-group-plane]` 不在任何 `[data-pc-clip]` 里，`solid.ts:165` 的 `el.closest("[data-pc-clip]")` 取不到 `clipId`、`:167` 就 `continue` 略过它，点击会穿透到背后图层。所以：组流平面加 `pointer-events: none`；`solid.ts:197` 的平面排除名单（今天是 `data-pc-proxy-plane` / `data-pc-snapshot-plane` / `data-pc-stream-plane` 三条）加上 `data-pc-group-plane`，不参与 `bounds` / `rects`；组内被抑制的卡没有自己的流平面，`hitTest` / `bounds` 对它们退回包裹层框（`frameCss` 框）。

**抑制与开关是两件事。** 抑制由该位置的实时判定决定（`H(位置)`，不是预渲染集合——集合里的卡在判轻的位置活渲、不抑制），**与 `streams` 开关无关**：照 `docs/plan/r2-r7-task.md` 的 E7 第 5 条，挂着不卸载，包裹层加 `.pc-suppressed` 藏子树、`t` 冻住；流的 `<canvas>` 是该卡包裹层里的兄弟平面；`suppressed` / `streamPlanes` / `snapshots` 只发给 `front`，`back` 永远全活渲（K5）。`streams` 开关只决定有没有流平面，关着时重卡贴 C4 的最近快照或透明。

**哪些卡不进流。** 毛玻璃卡（`belowDependent`）不进流——它要采样下层，截出来的流和下层对不上；抑制照 K5 走：判重时照常 `.pc-suppressed`，贴 C4 从 `controls-local` 选出的最近快照，没有就透明。`unknown` 卡（审阅表没覆盖到的卡——用户定制卡、带部件的组合卡片段在真实项目里都是它）**一律按 `belowDependent` 处理**（`docs/plan/r2-r7-task.md` 的「组件与术语」一节），同样不上云、不进流。

**粒子卡。** 粒子卡（tsParticles，2D canvas + 主线程库；R9 里是 `dom2d` 契约，不迁进 Worker）的稳定活渲成本只有 1.4～3.8 ms，多数位置判轻、活渲；**长的粒子片段（超过约 8 秒，按 K2 的追帧上界判重）交给轨道流**，和别的重卡同一条路。被抑制的粒子卡照 E7 第 5 条藏子树、`t` 冻住，`<canvas>` 的像素在抑制期间不变。

**三个数的关系**：`流数 ≤ N`（解码器预算，**初值 6，待 G0-b 原型定稿**）、`并发 run = streamPool`（**待 G0-b 原型定稿**）、`同时存活的分段编码器 ≤ 2 × streamPool`。

### G2 分段是生产和随机访问的单位

每条流按 15 帧切分段；每个分段一个独立 fMP4 片段文件（`moof + mdat`，首帧 IDR，`mfra` 剥掉）；流目录一个 `init.mp4`。解封装器的帧号只由「分段号 × 15 + 样本序号」得出。**一个分段的样本数必须恰好 15**（末段除外），少一帧就重拍。

**谁来剥 `init.mp4` 和 `mfra`。** ffmpeg 的 `-movflags frag_keyframe+empty_moov+default_base_moof` 输出的是一条连贯的 MP4 字节流，切分在 **Node 端**做：读 ffmpeg 的管道输出、按 MP4 box 结构切——`ftyp + moov` 写成 `init.mp4`（每条流只写一次，**后续分段算出来的必须与它逐字节相同，不同就换流签名**），`moof + mdat` 写成分段文件，`mfra` 丢弃。

**稀疏分段**用重复帧（每张 PNG 连续喂 `stride` 次，timescale 和 `avcC` 不变；画面最多滞后 `stride − 1` 帧），之后满密度替换。**注意**：要凑满「恰好 15 个样本」，`stride` 只能取 15 的因数（1 / 3 / 5 / 15）；`stride` 的可取值集合**待 G0-b 原型定稿（(8) 的交付项）**，如果原型要用别的值，就要同时决定末段之外的样本数怎么算。

**分段签名** = 流签名 + 分段号 + `stride` + 编码器名 + 编码参数哈希。同一条流的分段按分段号递增生产；单个分段的重新生产是它自己的一个 run。

### G3 编码

每个分段一次 ffmpeg 调用（编码器由 `ffmpeg.mjs` 找到的可执行文件加新增的 `probeEncoders()` 决定）；输入是经 `captureFrame`（`capture-frame.mjs:18`）取得的 PNG 字节经 `image2pipe` 喂 ffmpeg。

**公共命令**：

```
-reinit_filter 0 -f image2pipe -c:v png -framerate <fps> -i pipe:0 -filter_complex
  "[0:v]format=gbrap,premultiply=inplace=1,format=rgba,split=2[c][a];
   [c]format=rgb24,pad=iw:ih+8:0:0:black[rgb];
   [a]alphaextract,format=gray,format=rgb24,pad=iw:ih+8:0:0:black[mask];
   [rgb][mask]vstack=inputs=2,scale=out_range=pc:out_color_matrix=bt709,format=yuv420p"
-c:v <编码器> <编码器参数与严格 GOP 参数，见下表>
-color_range pc -colorspace bt709 -color_primaries bt709 -color_trc bt709
-video_track_timescale <fps>
-movflags frag_keyframe+empty_moov+default_base_moof -an
```

- **`-reinit_filter 0` 必须有。**
- **色半区存预乘色。** 首句是 `format=gbrap,premultiply=inplace=1,format=rgba`（不是直接 `format=rgba`）：PNG 的透明像素可能带 RGB 垃圾值，`format=rgb24` 只丢 alpha、不清理透明区的 RGB，H.264 的 4:2:0 色度下采样会把它渗到不透明边缘造成杂色。预乘之后 alpha 为 0 处的 RGB 恒为纯黑。**G5 的着色器因此按预乘输出**（`premultipliedAlpha: true`），不再做 `rgb × a`。alpha 误差在 G0-b (5) 里量。
- **布局**：上半 RGB `H` 行 + 8 行填充 + 下半 alpha 灰度 `H` 行 + 8 行填充，编码高度 = `2 × (H + 8)`（`docs/async-track-playback.md:52`）。
- **宽高**：`iw` / `ih` 已经是 G1 外扩过的偶数，滤镜链不再取整。
- **色彩标注**：`out_color_matrix=bt709` 和 `-colorspace` / `-color_primaries` / `-color_trc` 这一套是理论推导，原型实测命令（`docs/async-track-playback.md:55-71`）里没有。**待 G0-b (5) 验色差**，不过就退回原型那一套。

**编码器参数与严格 GOP 参数**（每个编码器一行，不要拿公共块去拼——`-sc_threshold` 等不是所有编码器都认）：

| 编码器 | 参数 |
|---|---|
| `libx264` | `-c:v libx264 -preset veryfast -crf 16 -g 15 -keyint_min 15 -sc_threshold 0 -bf 0` |
| `h264_nvenc` | `-c:v h264_nvenc -preset p4 -rc vbr -cq 16 -b:v 0 -g 15 -bf 0 -no-scenecut 1 -forced-idr 1 -strict_gop 1`（`-tune ll` 与 `-rc vbr -cq` 二选一，**待 G0-b (7) 定稿**） |
| `h264_qsv` | `-c:v h264_qsv -preset veryfast -global_quality 16 -g 15 -bf 0`（其余以 G0-b (7) 实测为准） |
| `h264_amf` | `-c:v h264_amf -quality speed -rc cqp -qp_i 16 -qp_p 16`（严格 GOP 参数以 G0-b (7) 实测为准） |

`init.mp4` 从该流第一次编码的输出里截取（G2）。

### G4 调度（新文件 `frame-stream.mjs`）与连续出帧模式

**为什么要新写一套。** 现有 `bakeFrames`（`bake.mjs:28`）每次调用都 `__pcSetFrameWindow` 重挂场景、拨回挂载帧（`:81-83`）并在 `warmUp` 里 `__pcRestartCards` / `__pcResetAnims`（`:200`），所以「紧接上一个 run」在它上面做不到；`step`（`:125`）和 `warmUp`（`:189`）又是 `bakeFrames` 的内部闭包。

**第一步，把 `step` 抽成 `createStepper(bakery, { fps, directFrameAt, signal, trace })` 供两处复用**。`step` 闭包实际用到的外层量是 `bakery` 解构出的 `page` / `beginFrame` / `waitNet`、`waitFrameReady(bakery, signal)`（`bake.mjs:175`）、`fps`、`directFrameAt`（`:77`）和 `trace`，正好被这个签名覆盖。`staticSkip`（`:68`）留在调用方；**`frameWindow` 也留在调用方的闭包里**——它不只在外层循环用，`warmUp` 里也要（`bake.mjs:189-192` 的 `frameWindow.replayClipIds`），由调用方传给 `warmUp`。

**第二步，新增 `bakeStream(bakery, { streamSignature, fromFrame, toFrame, stride, onFrame, signal })`**（与 `bakeFrames` 并列）：worker 持有一份「流租约」`{ streamSignature, lastFrame, stepper }`；租约匹配且 `fromFrame === lastFrame + 1` 时**跳过** `__pcSetFrameWindow` 和 `warmUp`，用租约里的 `stepper` 从页面当前状态逐帧 `step()` + `beginFrame()`（`window.__pcExportMs` 就是上一帧的值，`__pcSetT` 照常推）；否则（首次、换流、跳段、签名变）走 `bakeFrames` 那套重挂载并付完整回放。

**`bakeStream` 一律 `frameWindow = null`（`__pcSetFrameWindow(null, …)`）**：`ExportView.tsx:55-57` 的 `renderProject` 按 `frameClipIds` 过滤卡片段，连续模式若首个 run 带了非空 `clipIds`，后续 run 里新进入的卡会被滤掉、永远不挂；挂载交给 `FrameScene` 的活跃判据。

**单卡像素怎么隔离。** `frameWindow = null` 是全员挂载，`captureFrame` 又是整页截图，同一画面里和该卡实体框重叠的别的卡会被一起截进这条单卡流里。**做法是隔离工程，不是 `clipIds`**：每条流的会话加载**该流的隔离工程**（`frame-pipeline.mjs:855` 的 `isolatedCardProject` 的流版本：只留这条流的卡——单卡流一张、组流一组——和 `sourceDependent` 链上的源片段；素材轨和其它卡全部剔掉；**时间不平移**，流按全局帧号分段；背景透明），所以 `frameWindow = null` 全员挂载时页面里也只有这条流的像素。配套：`captureFrame` 加可选 `clip` 矩形（G1 的外扩矩形），只截裁剪矩形——今天 `bake.mjs:90-92` 的 `shotParams` 只有 `{ format: 'png', optimizeForSpeed: true }`，没有 clip。这和「不做」清单里的「`bakeStream` 带非空 `clipIds`」不冲突：隔离靠工程，不靠 `clipIds`。

**会话从哪来。** `streamPool` 的会话**不经 `acquireUser`**（`frame-pipeline.mjs:256`，它每次都 `bakery.reset` 重载页面，租约活不过一次），也不走 `acquire(lane, project)`（`:195`，那是按 lane 的链式队列）。`FramePipeline` 加一对 `leaseStreamBakery()` / `returnStreamBakery()`：裸 bakery，不进 `laneChains`，数量 = `streamPool`；`frame-stream.mjs` 只经这两个函数拿会话，只在租约断掉时 `reset`。`installFrameMedia` 不用管——它是导出页自己在加载时装的（`frameMedia.ts:11`，由 `ExportView.tsx:27` 调用），不是 Node 端在 `openBakery` 里装的。

**`firstMs` 不是常数**：`firstMs = resetMs + (runStartFrame − 该流各卡的最早挂载帧) × frameMs`，只在租约断掉时付；同一条流按递增顺序生产、每个 run 紧接上一个末尾时只付换页。（这里的 `frameMs` / `resetMs` / `jitterMs` 是**生产侧的每帧耗时**，和 `planPlaybackBatch` 的同名参数一个口径（`frame-playback.mjs:3`）；它和 R1 里删掉的成本记录字段 `frameMs` 不是一回事——成本记录现在只有 `stepMs` / `inlineMs` / `rasterMs` / `serializeMs` / `catchUpMs`，判重只看 `stepMs`。）

`onFrame` 逐帧到达时按 15 帧一组各开一个 ffmpeg，同时存活 ≤ 2（双缓冲，靠 `bake.mjs:309` 的 `await opts.onFrame(i, buf)` 背压）。

**可行性条件**：`firstMs + n × 15 × frameMs / stride ≤ n × (15000 / fps) × (该流分到的 worker 数)`；不满足时先加 `stride`，再合并流。

**排程**。`planStreamSegments` 按流各一份：`leadSegments = ceil((firstMs + segMs + jitterMs + deliveryMs) × rate × fps / (15 × 1000))`；`reserved`、`epoch`、`incomplete`、`resetMs / frameMs / jitterMs` 按流各一份；worker 在流之间按「离播放头最近的未就绪分段」轮转，**但同一 worker 优先延续自己的租约**（`frame-playback.mjs:23` 的「不为每个新露出的远端帧付换页」在这里对应「不轻易断租约」）；播放头跳到远处时该流从跳到的分段开新 run（付一次回放）。`status()` 按流返回分段表。

### G5 浏览器端解码与合成（新文件 `streamPlayer.ts`）

每条流一个 `VideoDecoder`（`hardwareAcceleration: 'prefer-hardware'`，**`codec` 从 `avcC` 拼**、不要写死 `avc1.640028`——真实 SPS 会是 `avc1.640033`；`description` = `avcC`）。`isConfigSupported` 不校验 level 与分辨率（G0-a），不能拿它当能力判据。

自写 fMP4 解封装；`EncodedVideoChunk.timestamp = (分段号 × 15 + 样本序号) × 1e6 / fps`。随机访问从 IDR 解到目标；连续播放预解下一分段。

`VideoFrame` 直接 `texImage2D`，片元着色器按 `docs/async-track-playback.md:73-78` 的公式（`alphaTop = (H + 8) / (2H + 16)`、`half_ = H / (2H + 16)`）拆两半；**色半区是预乘色**（G3），所以上下文按 `premultipliedAlpha: true` 输出，不再做 `rgb × a`。

**解码帧预算按字节算，不按帧数。** 解码出来的 `VideoFrame` 是**上下拼合后的编码画面**：1080p 流的编码画面是 1920 × 2176，NV12 按 1.5 字节 / 像素 ≈ **6.27 MB 一帧**。总预算 **≤ 80 MB**（1080p 全幅流约 12 帧），按流优先级分配、**每流保底 3 帧**。每个 `VideoFrame` 用完立刻 `close()`。分段文件 `fetch` 整段拉，每流最多 2 个在途请求。具体数字**待 G0-b (4)(6) 原型定稿**。

### G6 校验与替换

索引里每个分段带签名；`localRev` 变了预渲染进程重算受影响流的期望签名，不等的分段重新生产；新分段到达后换用，旧文件延迟 5 秒删除。

### G7 不做 MSE / `<video>` 回退

`streams` 开关关着时 G 的层走 `?preview=legacy` 的整帧通道。

---

## 约束

- **帧率制：上限 60 fps。** 项目 `fps` 提供 24 / 25 / 30 / 60 四档，在项目选项面板里切换；`identityKey` 含 fps，所以全部 `costs` 和全部死素材（含轨道流）同时作废，流按新 fps 重新预渲染。分段的 `-video_track_timescale` 和 `-framerate` 都跟项目 fps。整条约束的全文见 `docs/plan/r2-r7-task.md` 的「约束」第 1 条。
- **编辑器进程（Node 侧）不再有无头 Chrome 热池；轨道流的池由预渲染进程自建**（`streamPool`，D5）。页面侧的热渲染是可见舞台 iframe，两者不是一回事。
- **渲染永远在「看图的那一方」旁边。** 轨道流只在有本机进程的宿主上产（`user` / `full` 模式的预渲染进程）；在线浏览器模式没有 ffmpeg、没有流，按拍换快照（L4）。`agent` 模式的进程不产流。
- **像素缓存不上云**：PNG / MOV / 轨道流都只在本机，云端只有 HTML 快照块（A3b）。
- 不改导出像素基线：`bakeStream` 是 `bakeFrames` 之外的新入口，`bakeFrames` 的行为一字不改；`FrameScene` 的 `placeholder` 分支不动。

## 验收

数字以 G0-b 实测为准（下面是第 111 版的初值）。

- **编码**：一条 1080p 流 15 帧分段编码 ≤ 300 ms；分段文件 ≤ 1 MB；每分段样本数恰为 15；`stride = 3` 的稀疏分段文件 ≤ 满密度的 1.3 倍、画面滞后 ≤ 2 帧；alpha 平均误差 ≤ 0.5 / 255；预乘之后透明区边缘无杂色；色差在 G0-b (5) 的判据内。
- **切分与索引**：`init.mp4` 每条流只写一次，后续分段算出来的 `ftyp + moov` 与它逐字节相同；`mfra` 不落盘；单独重新生产第 5 段后索引正确；替换后 5 秒内旧文件删除。
- **解码与播放**：冷 seek 到解出目标帧 ≤ 60 ms；N 条流同时播 30 fps 不掉帧；**解码帧总内存 ≤ 80 MB**（前提：1080p 流的编码画面是 1920 × 2176、NV12 6.27 MB / 帧，所以是约 12 帧而不是 24 帧）、每流保底 3 帧；毛玻璃卡叠在流 `<canvas>` 和 `<video>` 上时模糊正确。
- **连续生产**：`bakeStream` 连续生产 10 个分段只付一次换页、**不调 `__pcSetFrameWindow`**；`bakeStream` 的 `__pcSetFrameWindow` 调用 `clipIds` 恒为 `null`，连续模式里新进入的卡正常挂载；同时存活的分段编码器 ≤ 2 × `streamPool`。
- **隔离**：单卡流的分段里只有这一张卡的像素（隔离工程 + `clip` 矩形），和它重叠的别的卡不出现；组流的分段里恰好是组内那几张卡。
- **舞台侧**：被抑制的卡藏子树、不卸载、解除抑制后不重播；被抑制的粒子卡在 `streams` 开着时 `<canvas>` 的像素哈希在抑制期间不变，但包裹层轨迹和 `data-pc-local-frame` 仍随 `t` 变、点画布能点中它；流 `<canvas>` 是 `Stage` 渲的兄弟平面、只在 `front` 舞台里有 decoder；缺分段时该层贴最近快照或透明、**播放头不停**；暂停后按 K5 追到活渲。
- **组流平面**：`[data-pc-group-plane]` 带 `pointer-events: none`，`hitTest` 点它时命中的是背后组内被抑制的卡的包裹层框（不是穿透到别的图层）；`bounds` / `rects` 不把它算进去。
- **开关**：`streams` 关着时 G 的层走 legacy 通道，其余功能与 R7 结束时逐项相同；关着时被判重的粒子卡仍被抑制、贴 C4 快照或透明。
- **重启**：杀掉预渲染进程，`streamPool` 的租约全部作废、索引按键重建（F5），播放中贴流的重卡最多空白一个分段。
- 收尾照 `docs/plan/r2-r7-task.md` 的「每一步通用的收尾」：`npx tsc -b --force` 零错误；`npm test` 全过；`scripts/verify-unified-frames.mjs` 通过；不改导出像素基线。验证改动用 5197 端口（`.claude/launch.json` 的 `dev-test`），不要碰用户常驻的 5190，不要动 `%LOCALAPPDATA%\PromptCut\runtime\app`。

## 不做

- 轨道流的 MSE / `<video>` 回退。
- PNG MOV 多流。
- 改 timescale 的稀疏分段（稀疏用重复帧）。
- 毛玻璃卡进流；场景流（整场景一条流）。
- 跨流的乱序生产（只允许单分段重生产）。
- `streamPool` 的会话走 `acquireUser`。
- `bakeStream` 带非空 `clipIds`（单卡像素靠隔离工程）。
- `back` 舞台解码轨道流。
- `streamPlayer` 用 `insertBefore` 往包裹层塞 canvas（由 `Stage` 按 `streamPlanes` 渲）。
- 给**有流分段的**被抑制的卡投快照（`streams` 关着、这一拍缺分段、在线浏览器模式时照投）。
- 不在预渲染集合里的卡产流；播放中为等分段停住播放头（缺就透明）。
- 像素缓存（PNG / MOV / 轨道流）上云。
- 在线浏览器模式做流（L4 的按拍换快照是那个模式的唯一例外）。
- 把粒子卡迁进 Worker（它是 `dom2d`，长片段交给轨道流；见 R9 的 M5）。
- 卸载被抑制的卡，或在包裹层上 `display:none`（照实体模式：藏子树、留兄弟平面）。
- 给卡片加 `suspended` 之类的对外挂起 prop 协议（冻 `t` 即可）。
- rawvideo 取帧。
- 单流时间分层做素材的渐进补全（同一份 H.264 按「参考帧先、可丢弃 B 帧后」的顺序传、用 MSE 重叠替换；或 VP9 / AV1 temporal layers 走 WebCodecs）——技术上可行、不多编一份，但参考帧占一份编码一半到七成的字节，首播要等的量只比整片少一点，收益远小于换档；留到将来给原片档做补全。本任务的渐进是素材两档换档（A1）。

---

## 本文没带走的内容

源文本目标 G 里下面这些句子判断为已过时或被取代，逐条说明：

1. **「G0-a 纯探针（一天，第 4 步准入）」的待办口径**——G0-a 已于 2026-09-19 跑完并全过，正文改写成结论 + 报告路径，不再写成待办。三项探针的脚本已在仓库里（`scripts/probes/videodecoder-probe.mjs` / `backdrop-probe.mjs` / `oac-probe.mjs` / `probe-connect.mjs`）。
2. **「任一不过，第 4 步不开工」**——已经全过，这句没有再成立的对象；准入条件现在只剩 G0-b。
3. **G0-b 里「量 `frameMs`（稳态每帧）」的字面歧义**——`frameMs` 作为成本记录字段在 R1 已删，判重只看 `stepMs`。G0-b 量的是**生产侧每帧耗时**，和成本记录无关，正文里保留这个名字但加了口径注（同 `planPlaybackBatch` 的参数）。
4. **G3 公共命令块里的 `-g 15 -keyint_min 15 -sc_threshold 0 -bf 0`**——从公共块挪进了每个编码器各自一行的参数表（`-sc_threshold` 等不是所有编码器都认，直接拼会失败）。
5. **G3 的「编码器参数：`libx264 -preset veryfast -crf 16`」等四条简写**——都补上了 `-c:v`，否则直接拼是语法错误。
6. **G3 首句 `format=rgba`**——换成 `format=gbrap,premultiply=inplace=1,format=rgba`（预乘），配套 G5 的着色器不再做 `rgb × a`。
7. **G3「`-reinit_filter 0` 必须有；首句 `format=rgba`」里「首句 `format=rgba`」那半句**——被第 6 条取代。
8. **G4 里「`staticSkip` 和 `frameWindow` 只在外层循环用，留在调用方」**——`frameWindow` 在 `warmUp` 里也用（`bake.mjs:189-192`），改成「留在调用方闭包里，由调用方传给 `warmUp`」。
9. **G4 里「`installFrameMedia` 在 `openBakery` 里一个页面装一次（旧 `:370`）」**——不成立：`installFrameMedia` 是导出页自己在加载时装的（`frameMedia.ts:11` + `ExportView.tsx:27`），Node 端从来没调过。整句改写。
10. **G4 里「`streamPool` 的会话不经 `acquireUser`，`frame-stream.mjs` 自己持有会话」**——只说了不走哪条路、没说走哪条，补成 `leaseStreamBakery()` / `returnStreamBakery()` 这对新接口。
11. **G5 里「解码后保留的帧总数全局预算 24 帧」**——按帧数算漏了上下拼合（编码画面高是 `2 × (H + 8)`），24 帧 ≈ 150 MB，和验收的 80 MB 差近一倍。改成按字节算（≤ 80 MB，1080p 约 12 帧）。
12. **G5 里「`codec` 从 `avcC` 拼」原本只是一句实现细节**——G0-a 证明了它是必须的（`isConfigSupported` 不校验 level 与分辨率，真实 SPS 是 `avc1.640033`），升成带理由的硬规定。
13. **全部 `scripts/export-frames.mjs:NNN` 的行号引用**——那个文件在解耦重构里已经拆掉，内容进了 `bake.mjs` 和 `chrome.mjs`，行号一律按当前 main 重新核过。同理，源文本里「旧 `:370`（b5c65dc 后已搬到 src/render/frameMedia.ts:11）」这种行内版本考古注一律删掉，只留现在的位置。
14. **源文本 G 节里没有、但审查里的一条「走查合格记录」（`agy-r75-05` 的 3.7）**——那是五条「核过、没问题」的记录，不是修改意见，没有可折的内容。
