# T2 报告：R8 轨道流

分支 `claude/r8-streams`（从 main `fc62e16` 建），worktree `.claude/worktrees/r8-streams`，端口 5230～5239。
任务书：`docs/plan/r8-streams-task.md`（G1～G7）；参数按 `docs/plan/g0-b-stream-prototype.md` 的结论。

## 先看这三条

1. **轨道流整条链在本分支里做完了、验过了，但要在编辑台里真的用上，还要 6 个清单外文件的小改动**（父页合成流平面、分段字节的 HTTP 读口）。改动写成了补丁 `out/r8-evidence/r8-glue.patch`（本报告末尾也贴了全文），我没有动这 6 个文件。补丁在一份拷贝上验过：`tsc` 0 错误、`src` 下 919 个单测全过、真编辑台端到端探针全过（见「验证」第 6 条）。
2. **没打补丁时，本分支的行为和 R7 结束时一样**：生产者等「分段读口接上」才开工（`StreamProducer.routeAttached`，由补丁在 `vite-plugin-frames.ts` 里调 `attachRoute()`）。这道闸是必须的——实测现在的父页会把 `kind: 'stream'` 的层当快照去取，`/api/frames/snapshot/stream/…` 在预渲染进程上落到 SPA 兜底、回一整页 `index.html`（200），重卡暂停 / 拖动时会贴上一整张应用页面。`streams` 开关本身按任务要求默认开（`PROMPTCUT_STREAMS=0` 关）。
3. **dual 模式的编辑台今天没有人调 `/api/frames/preload`**（只有 legacy 的 `UnifiedPreview` 调）。这是 R6 / R7 留下的空缺：预渲染进程的后台预渲染（C2 锚帧、快照）和轨道流的生产入口都挂在 `preload` 上，所以就算打了补丁，编辑台里也要有人触发一次 `preload` 才会产流。端到端探针是自己调的。怎么补要用户定（见「待用户定」第 4 条）。

## 做了什么（按 G 项）

### G1 流的划分与层抑制（`server/frame-stream.mjs`）

- **哪些卡进流**：预渲染集合（`prerenderPicked`）里、审阅表 `compositing: 'independent'`、在可见序列上、框没有用三维的卡片段（`streamEligible`）。毛玻璃（`belowDependent`）和 `unknown` 不进流；`sourceDependent` 这一版保守地也不进（隔离工程要带齐源链，见「待用户定」第 5 条）。
- **单卡流画在包裹层自己的坐标系里**（`plane: 'local'`）：和快照平面一样，x / y / 缩放 / 旋转 / 不透明度 / 淡入淡出 / motion / 强调都不在流里，舞台上由包裹层照常加（E7 第 5 条「层序、overflow、zIndex 自动跟着包裹层走」「包裹层轨迹仍随 t 变」）。隔离工程里把这张卡的框摆到画面中间（`offset`），截图矩形 = 平面矩形 + `offset`。任务书 G1 写的「舞台像素」只对组流成立，见「更正建议」第 1 条。
- **裁剪矩形**：上界 = 框 ∩ 可截范围、四周留 32 px 溢出；稀疏那一趟把每张截图里 alpha > 0 的包围盒并起来（`pngAlphaBox`，Node 端直接读截下来的 PNG），外扩 8 px、夹回上界、外扩到偶数宽高（`evenRect`），**整条流的稀疏分段都量完之后**补密那一趟改用它（省不到 15% 面积就不收紧）。没用页面里 `__pcSolid` 的实体框：它按元素外框算，金句药丸的外发光实测被裁掉一圈。
- **组流**：同时活跃的流超过解码器预算（6）时，按画家顺序把**紧挨着的**两条合并（两者之间、在合并后的时间段里没有别的画面层插着），反复直到不超预算或合不动（`groupStreams`）。组流是舞台坐标、外观全部画进流里；层挂在组里最上面那张卡上、带 `groupClipIds`。
- **抑制与开关是两件事**：抑制照旧由父页按 `H(t)` 发，`streams` 只决定有没有流平面（本分支没改抑制逻辑）。
- **舞台侧**（`src/render/Stage.tsx`、`src/render/solid.ts`、`src/StageView.tsx`）：单卡流的 `<canvas data-pc-stream-plane>` 是包裹层的兄弟平面（清单到之前先铺满包裹层、背板 0×0 透明，被抑制的卡照样点得中）；组流的 `<canvas data-pc-group-plane>` 挂在组里**此刻活跃的最上面那张卡**所在的单片段 `Stage` 根下（live 路每个片段一个单片段 `Stage`，挂在固定的最上面那张上的话它不在场时组流就没了——实测踩到过，已修），`pointer-events: none`；组内成员的包裹层带 `data-pc-stream-member`，`hitTest` 点到被抑制的成员包裹层就命中它（不穿透），`bounds` 不把组流平面算进去。

### G2 分段（`server/frame-stream.mjs`）

- 每条流按**全局帧号**切 15 帧一段；每个分段一次 ffmpeg 调用，Node 端按 box 切：`ftyp + moov` → `init-<id>.mp4`、`moof + mdat` → `<n>-<hash>.m4s`、`mfra` 丢掉（`splitFmp4`）。每段校验：恰好一个 moof、样本数恰好 15（末段按项目剩余帧数）、首帧同步样本，不对就记失败、重试（同一段最多 3 次）。
- **变体**：一个变体（矩形 + 编码器）的 init 只写一次；后续分段编出来的 `ftyp + moov` 和已存的不逐字节相同就是新变体（按内容哈希命名）。清单 `stream.json` 里每个分段记着自己用哪个 init，页面按分段各自配置解码器。
- **稀疏分段**：`stride = 3`，每张 PNG 连续喂 3 次（末段按剩余帧数截），样本数不变。
- **分段签名** = 流键 + 分段号 + stride + 编码器名 + 编码参数哈希 + 矩形（`segmentSignature`）。
- **流键**（`server/card-identity.mjs` 的 `cardStreamIdentity`）：单卡流 = 共享快照键 `snapshotKey`（内容，不含摆放）+ 时间上的摆放（第一帧、相位、fps）+ 画幅 + 代码版本；组流 = 各成员带外观的 `control.key` + 画家顺序。矩形和编码器不进流键（进变体）。命名按任务书暂叫 `streamKey`（见「待用户定」第 1 条）。

### G3 编码（`server/bakery/ffmpeg.mjs`）

- 滤镜链照 G3：`format=gbrap,premultiply=inplace=1,format=rgba` 开头（色半区存预乘色）、`out_range=tv`、`-color_range tv`、`-reinit_filter 0`、`-video_track_timescale <fps>`、`frag_keyframe+empty_moov+default_base_moof`，fMP4 从 stdout 收。
- 每个编码器一行参数（`STREAM_ENCODERS`）；`h264_mf` 单列 `nv12`。nvenc / qsv / amf 三行照任务书原样，没实测。
- `probeEncoders()` **真编一小段**（两张 320×240 半透明 PNG、同一条滤镜链、同样输出 fMP4、要看到 `moof` + `avcC` 才算过）。本机结果：`libx264` 过、`h264_mf` 过、nvenc / qsv / amf 不过（和 G0-b 一致）。
- 缺省只试 `libx264` → `h264_mf`；`PROMPTCUT_STREAM_ENCODER=auto` 才按 `nvenc → qsv → amf → libx264 → h264_mf` 探测（硬件那几行没实测过，不默认启用，见「待用户定」第 6 条）。

### G4 调度与连续出帧（`server/bakery/bake.mjs`、`server/bakery/capture-frame.mjs`、`server/frame-playback.mjs`、`server/frame-pipeline.mjs`、`server/frame-stream.mjs`）

- **`createStepper`**：`bakeFrames` 的 `step` 闭包**逐字搬出来**，`bakeFrames` 改为调它；`warmUp` 同样搬成 `warmUpAt`，`frameWindow` 由 `bakeFrames` 传进去。`bakeFrames` 行为不变（导出逐像素对照见「验证」）。
- **`bakeStream`**：bakery 上挂流租约 `{ streamSignature, lastFrame, lastShot, stepper, dirty, page }`；接得上（同一条流、`fromFrame === lastFrame + 1`、没被弄脏、页面没换）就跳过 `__pcSetFrameWindow` 和预热接着推；否则 `__pcSetFrameWindow(null, …)`（`clipIds` 恒为 null）+ 预热 + 从挂载帧回放。`dirtyStreamLease()` 给「别的调用用过这个会话」置 `dirty`。
- **`captureFrame` 的 `clip`**：beginFrame 的截图参数没有 clip，改用 `Emulation.setDeviceMetricsOverride` 的 `viewport`（布局不受影响；本机 1920×1080 → 400×240 每张截图 29 ms → 3 ms）。只在矩形变了时发一次；换尺寸后先推一拍（实测新页面第一次换尺寸后会连着 4 次空截图）。
- **会话**：`FramePipeline.leaseStreamBakery()` / `returnStreamBakery()`，裸 bakery、不经 `acquireUser`、不进 `laneChains`、和 legacy 热池不共用；空闲 60 秒关掉。`streamPool` 缺省 1、最多 2，按实测自适应（带编码器时每帧出图耗时不超过空闲时的 2 倍、而且不止一条流有活才加到 2；`PROMPTCUT_STREAM_POOL=1|2` 钉死）。
- **只在空闲时生产**（`FramePipeline.streamBusy()`：legacy 播放热池在用 / 后台让路租约在期 / 镜像插件报「在播」且 5 秒内有音讯 / 800 ms 内刚动过播放头）。
- **先稀疏后补密**：所有流先 `stride 3` 铺满，再满密度替换；worker 优先延续自己的租约，否则挑离播放头最近的那条流（`planStreamSegments`）。同时存活的分段编码器 ≤ 2 × `streamPool`（双缓冲，背压靠 `onFrame` 的 `await`）。
- 纯函数：`streamFirstMs`（含 G0-b 的 80 ms 固定开销）、`streamFeasibility`（不满足先加 stride，只取 15 的因数）、`planStreamSegments`（`leadSegments`、租约优先、回头补洞）。
- **入口**：`preload` 在锚帧就绪之后调 `streamProducer().update(entry)`（不等它）；`adoptCardPlan` 认领时把流层一并认领并补发（认领是「清表后全量重发」，组流的 `groupClipIds` 不在认领表里）；`rescanSnapshots` 顺带扫流库（F5）；`diagnostics()` 带 `streams`（每条流的分段表，G4 的 `status()`）；`close()` 收尾。

### G5 浏览器端解码与合成（`src/render/streamPlayer.ts`）

- 每条流一个 `VideoDecoder`（`prefer-hardware`，配不上退 `no-preference`），`codec` 从 `avcC` 拼、`description` = `avcC`；自写 fMP4 解封装；`timestamp = 全局帧号 × 1e6 / fps`；随机访问从目标所在分段的 IDR 解，目标之前的帧一出来就关；连续播放往后多解两个分段的视野。
- 着色器按 `alphaTop = (H + 8) / (2H + 16)`、`half = H / (2H + 16)` 拆两半，`rgb = min(rgb, vec3(a))`，`premultipliedAlpha: true` 输出。画布位置 / 尺寸按清单的矩形上界设；每一帧按它所在变体的矩形设 viewport。
- 预算：单个解码器「手里没关的 + 喂进去还没出来的」≤ 8（硬约束；`decodeQueueSize` 不算正在解的，实测只数它会攒到 12 帧，已修）；解码帧字节按流均分 80 MB、每流夹在 [3, 8] 帧；同时 ≤ 6 条解码器；每流最多 2 个在途请求。
- 这一拍的帧没解出来时，最近 3 帧内画过的那张留着，再远就清成透明；段不在就绪区间里就透明——播放头从不为它停。有流画面时把同一包裹层里的快照平面藏起来（父页那一侧还没接上时两层会叠出重影）。
- 暂停 / 拖动时清单、init、分段是异步到的，到了就按这一拍要的帧再走一遍（`wake`，实测不这样随机访问会停在半路）；父页发空表时不再要的流当场关掉。
- `StageView` 接入：`setStreamPlanes` 只在 `front` 收（`back` 收到只清空）；K4 每拍、`setTime` 之后画；`setRole('back')` 停下并关掉全部 `VideoFrame`；实体模式停解码；`__pcStageDiag()` 带 `streams`。探针用的 `window.__pcStreamBase` 可以把字节源指到别处。
- RPC（`src/render/stageRpc.ts`）：`setStreamPlanes` 的元素仍是 `{ clipIds }`，加了可选的 `key`（流键）和 `ranges`（就绪分段号）。父页那一侧的合成是纯函数 `streamPlanesFor`（在 `streamPlayer.ts` 里，补丁里的 `snapshotFeed.streamPlanesAt` 调它）。

### G6 校验与替换

- 期望签名按当前编码器、参数、矩形算；签名不对的分段在补密那一趟重新生产，新分段落盘后换用（清单改指向），旧文件 5 秒后删（页面上可能还有一个在途请求）。`localRev` 变了（新 entry）→ `update()` 重算这一版的全部流：流键没变的沿用盘上分段，变了的是新流。

### G7

- 没有 MSE / `<video>` 回退。`streams` 关着（或读口没接上）时就是 R7 的样子：重卡播放中照旧贴 C4 选出的最近快照或透明。

### `particles.tsx`

没改。顺带发现一个既有问题（和轨道流无关，见「没做成的」第 6 条）。

## 验证

所有命令都在 worktree 根目录跑；dev server `npx vite --port 5230 --strictPort --host 127.0.0.1`（我起的，PID 44452；它自己拉起的预渲染子进程端口是系统随机分配的，这是产品行为）。

1. **类型检查**：`npx tsc -b --force` → 退出码 0。
2. **全量测试**：`npm test` → tests 1752 / pass 1751 / fail 0 / skipped 1（main 基线 1718 / 1717 / 0 / 1；新增 34 条：`server/test/frame-stream.test.mjs` 21、`server/test/bake-stream.test.mjs` 6、`src/render/streamPlayer.test.mjs` 7）。
3. **导出确定性**：`node scripts/verify-determinism.mjs --url "http://127.0.0.1:5230/?export=1"` → 退出码 0，1800 帧 1800 帧逐像素相同（在 `705af8b` 上跑过一遍；在代码的最后一个提交 `8f4d926` 上又跑了一遍：导出 144.7 秒，Total Frames 1800 / Identical 1800 / Different 0，退出码 0）。
4. **导出像素基线不变**：同一台 dev server、同一个导出路径（`exportFrames`，演示时间轴 1800 帧），main（`fc62e16`）的 10 个产品文件临时检出来导一遍、本分支 HEAD 导一遍，**解码后逐像素比 1800 / 1800 相同**（做完立即检出回 HEAD，`git status` 干净）。本任务没有有损编码进入导出路径，所以没有「有损 H.264 造成的像素差」要说明。
5. **导出与快照重放一致**：`PC_FRAME_TEST_URL=http://127.0.0.1:5230 node scripts/verify-unified-frames.mjs` → 退出码 0，`PASS: no video during B; all HTML frames; exact video seek; random replay; cache hits; cumulative C equals A; streamed video contains all 10 frames.`
   （第一次跑挂在 `Video decode failed`：那时我的 dev server 带了 `PROMPTCUT_EXPORT_DIR` 指到临时目录，脚本写进 `out/media` 的测试视频 `/@media` 取不到——环境问题，去掉这个变量重起 dev server 之后通过。）
6. **轨道流探针**（新增，`scripts/probes/stream-*.mjs`；数据留在 `out/r8-evidence/`，`out/` 不入库）：
   - `node scripts/probes/stream-produce-probe.mjs --origin http://127.0.0.1:5230`（三张重卡：全屏粒子 5 秒 10 段、金句药丸框 640×360、Lottie 框 800×450）→ 退出码 0，全部条目过：
     - 每段样本数恰好 15、首帧 IDR、只有 moof + mdat、`mfra` 不落盘；变体数：粒子 1、药丸 2（上界 704×424 → 收紧 560×374，含外发光）、Lottie 2；
     - **连续生产**：3 条流、34 个分段一共重挂载 6 次（`__pcSetFrameWindow` 6 次、`clipIds` 恒为 null）：药丸、Lottie 稀疏 / 补密各 1 次，10 段的粒子流稀疏 1 次、补密 2 次（补密中途 worker 换去做了别的流、回来再接，是「离播放头最近」的排法造成的，不是租约断了）；同时存活的编码器最多 2 = 2 × `streamPool`；
     - **编码耗时**（15 张 PNG 一次喂、没有别的编码器争 CPU，3 次）：1080p 全幅 252 / 258 / 260 ms（p50 258 ≤ 300）；药丸 560×374 64 ms。分段体积：全幅粒子 414～442 KB（≤ 512 KB，这张卡带连线、比 G0-b 的雪花大）、药丸 9～55 KB、Lottie 8～22 KB；
     - **稀疏 / 满密度**（同一矩形）：254～271 KB / 414～442 KB = 0.61～0.62 倍（≤ 1.0）；
     - **alpha 平均误差**：粒子 0.096 / 255、药丸 0.069 / 255（≤ 0.5；最大 50 / 54，在边缘，和 G0-b 一致）；
     - **隔离**：绿色粒子流里药丸的蓝色像素 0 个，药丸流里 29519 个；
     - **G6**：把第 5 段签名弄旧，只重新生产了这一段、索引区间仍是 `[[0, 9]]`、签名对上；稀疏 → 满密度替换掉的 17 个旧文件 5 秒后都删了；
     - **F5**：关掉 `FramePipeline`、同一库根上新起一个：扫盘把 3 条流挂在键上、项目到位之前 0 条 `layer`、到位后 3 条流的层原样发出、一个分段都没重新生产。
   - 同上加 `--group`（解码器预算压到 1）→ 退出码 0：合成 1 条组流（10 段，稀疏 / 补密各重挂载 1 次）（粒子、Lottie、药丸），层挂在药丸上、带 `groupClipIds`；组流分段里药丸的蓝 29507 像素、右边只有粒子的那一条里 1992 个不透明像素；F5 同样过。
   - `node scripts/probes/stream-play-probe.mjs --origin http://127.0.0.1:5230`（测试页扮演父页、只经 RPC 驱动舞台；字节由探针自己的 http 服务用同一个 `handleStreamRequest` 发）→ 退出码 0（最后一次在 HEAD 前一个提交之后又跑了两次，结果相同）：
     - 3 条流都画出了帧（到暂停时 54 / 54 / 40 帧，Lottie 从 0.5 秒才开始）、解码器 0 报错、单解码器最多持有 6 / 8 / 8 帧、解码帧总字节 32 MB（≤ 80 MB）；`back` 舞台 0 条流；
     - 节拍：`frame` 的 `sec` 差恒为 1/30、不跳帧；间隔中位数贴流 34.7 ms、不挂流平面对照 35.2 ms（不拖慢）；
     - 暂停帧（1.733 s）**舞台贴流 vs 导出页从第 0 帧顺推到这一帧**：平均误差 0.248 / 255（最大 81）；**贴流 vs 同一舞台活渲**：0.196 / 255；
     - **毛玻璃叠在流画布上**（里程表 HUD 活渲、压在粒子流上）：那一块贴流 vs 活渲 0.115 / 255、vs 导出 0.533 / 255；
     - 被抑制的粒子卡自己那块画布像素哈希抑制期间不变、`data-pc-local-frame` 40 → 52；点药丸命中药丸、点空处命中粒子背景；
     - 冷 seek 到第 117 帧（第 7 段第 12 个样本）解出并画上：15.2 ms（≤ 60；前几次跑 15～25 ms）；
     - 缺分段（只给前两段）：播放头照走、不跳帧，那一层透明；
     - `setRole('back')` 之后流全部关掉、持有字节 0。
   - 同上加 `--group` → 退出码 0：组流平面 `pointer-events: none`、点它命中背后组内被抑制的卡、`rects` 不含组流平面；平均误差 0.25 / 255；冷 seek 21 ms。
   - `node scripts/probes/stream-editor-e2e.mjs --origin http://127.0.0.1:5236`：**只在打了补丁的 server 上有意义**。我把 HEAD 用 `git archive` 导到 `out/glue-e2e`、打上补丁、在 5236 起 dev server 跑它（跑完关掉）→ 退出码 0：真编辑台 dual 模式里加一张 30 秒粒子卡 → 60 段满密度 → 父页就绪索引里有 `stream` 层 → 播放：父页抑制了它、发了带流键的 `setStreamPlanes`、**没给它投快照**（A3c），舞台画了 60 帧、0 报错、最多持有 8 帧 → 暂停：流平面清空、解码器关掉、改投快照。
7. **R7 回归探针**（`streams` 在本分支里等读口，所以是 R7 的样子）：`stage-content-probe`、`stage-rpc-probe`、`playback-probe`、`reveal-probe`（都 `--origin http://127.0.0.1:5230`）→ 全过；`ready-index-probe --port 5233` 第一次在 ⑨「按新 costs 重算出的预渲染集合」超时（那时机器上别的 Agent 也在跑导出校验），第二次全过。
8. **看过的图**（都在 `out/r8-evidence/`）：
   - `stage-streams-1.733.png`（舞台贴流的整帧）、`stage-live-1.733.png`（同一帧活渲）、`export-1.733.png`（导出同一帧）——三张肉眼一致；
   - `pill-lottie-stage-vs-export.png`（药丸 + Lottie 局部：左舞台贴流、右导出）——一致；
   - `glass-stage-vs-export.png`（毛玻璃 HUD 局部：左舞台、右导出）——HUD 本体一致；玻璃里透出来的粒子，导出页（headless-shell、软件光栅）比舞台（带 GPU 的 Chrome）更清楚一点，这是两种 Chrome 配置下 `backdrop-filter` 本身的差别，和流无关（贴流 vs 活渲那一块只差 0.115 / 255）；
   - `stage-groupstream-1.767.png`（组流）；`editor-e2e-playing.png`（真编辑台播放中，粒子卡贴流）；
   - 分段本身解出来的上下拼合画面（药丸：上半预乘色、下半 alpha 灰度）在生产探针的临时目录里看过，布局正确。

## 没做成的，以及原因

1. **6 个清单外文件没动**（见文末补丁）：`server/vite-plugin-frames.ts`（分段字节的读口 + `attachRoute()`）、`src/editor/snapshotFeed.ts`（`stream` 不当快照选、播放中有流分段的卡不投快照、`streamPlanesAt`）、`src/editor/Preview.tsx`（和 `setSuppressed` 同一处发 `setStreamPlanes`）、`src/editor/stageSwap.ts`（播放态互换时也发）、`src/editor/stageSwap.test.mjs`（它 mock 了 `snapshotFeed` 的导出表，要加一项）、`src/render/snapshotSource.ts`（`applyReadyMessage` 丢掉了 `groupClipIds`）。找不到不碰它们的办法：字节只能经预渲染进程的 HTTP 路由给舞台，路由表在 `vite-plugin-frames.ts`；父页按就绪索引合成流平面是 C3 写定的，只有父页知道 `H(t)` 和就绪索引。
2. **dual 模式没有 `preload` 触发点**（R6 / R7 的空缺，见「先看这三条」第 3 条）。没有自作主张补：`preload` 那条链会连 legacy 的整场景 MOV / `preview.mp4` 一起做，挂到 dual 模式上等于改了编辑时的后台 CPU 占用。
3. **重启那一条只验了进程内重启**（F5 的扫盘 / 认领 / 补发 / 不重产）；「杀掉预渲染进程、播放中贴流的重卡最多空白一个分段」要真进程 + 补丁后的父页，没跑。
4. **没在桌面壳 WebView2 上跑**（都是 puppeteer 自带的 Chrome）。
5. **硬件编码器没实测**（本机 nvenc 驱动版本不够、没有 Intel / AMD 显卡），`streamPool` 自适应加到 2 的那一支在探针里没触发到（流数和比值都没到）。
6. **既有问题（没修，记在这里）**：同一时刻挂两张粒子卡时，后挂的那张 `tsParticles.load` 会把先挂那张的容器当成同一个 id 销毁掉（容器 id 取自引擎的共享随机数，实测后挂那张一挂上，前一张的 `<canvas>` 就被 `CanvasManager.destroy` 摘掉）。舞台和导出都一样。修它会改变含两张重叠粒子卡的项目的导出像素，要用户点头，所以没动；探针里第二张卡换成了 Lottie。
7. **既有现象（记在这里）**：导出页的随机访问（`bakeFrames` 带 `targetFrames`）回放的那些帧不截图，Motion 的 JS 帧循环推不动，金句药丸在暂停那一帧上画成了入场刚开始的样子，和从第 0 帧顺推（整片导出）不一样。轨道流是顺推截的，和整片导出对得上；`see_frames` 走的是随机访问。
8. **改了 `server/bakery/` 下的文件**（`bake.mjs` / `ffmpeg.mjs` / `capture-frame.mjs`），`snapshotCode` / `captureCode` 会变：合并之后全部共享快照键和卡片缓存作废一次、重新生成（像素不变，只是缓存冷了）。

## 对任务书 / 语义的更正建议

1. **G1 的坐标系**：单卡流应当写成「包裹层自己的坐标系（框坐标）」，不是「舞台像素」——E7 第 5 条要求流画布是包裹层里的兄弟平面、随包裹层轨迹走，流里若是舞台像素，包裹层的框 / motion / 不透明度会作用两遍。「舞台像素」只对组流成立。
2. **G1 的裁剪矩形**：「实测实体框」建议写明按**截图的 alpha 包围盒**量（G0-b (10) 也是这么量的），不用页面的实体框（`box-shadow` / 外发光不在元素外框里）；「第二段起收紧」建议写成「稀疏那一趟整条流量完之后，补密分段用收紧后的矩形；矩形不同的分段各带自己的 init」。
3. **G4 的 `captureFrame` 加 `clip`**：写明实现是设备度量的 `viewport` 覆盖（beginFrame 截图没有 clip 参数）。
4. **G4 的调度**：G0-b 结论 1（只在空闲时生产、播放和拖动时让路）和 G4「给播放头前方铺路」那段是两种口径，建议 G4 改成「空闲时按离播放头的远近排；`leadSegments` 只在将来允许边播边产时用」。
5. **G5 的预算**：6 条 1080p 全幅流时「每流保底 3 帧」（6 × 3 × 6.27 = 113 MB）和「总量 ≤ 80 MB」冲突，实现取了保底优先。另外「单个解码器 ≤ 8 帧」要数上「喂进去还没出来的」，只数 `decodeQueueSize` 不够。
6. **C3 / J3**：父页的 `snapshotFeed` 现在把 `stream` 排在快照选择的第一位（`KIND_ORDER`）、`applyReadyMessage` 丢 `groupClipIds`——R8 要一起改（补丁里有）。
7. `r2-r7-task.md` 里列的新文件 `server/stream-store.mjs` 这次并进了 `server/frame-stream.mjs`（本任务的可改清单里没有它）。
8. **R8 任务书收尾那条写的 5197 端口**已过时（`verification.md` 现在是 `dev-test` 5203）。
9. 语义文件（`docs/semantics/`）没发现要改的地方；dual 模式缺 `preload` 触发点是实现空缺，不是语义冲突。

## 待用户定

1. **`streamKey` 的命名**（任务书：本任务定、A3b 回头对齐）：这次叫 `streamKey`，是 `cardStreamIdentity` 的摘要；流库目录 `<库根>/streams/<streamKey>/`。
2. **`streams` 开关放哪儿**：现在是环境变量 `PROMPTCUT_STREAMS`（缺省开），外加「读口接上才开工」的闸。要不要做成项目选项 / 设置项。
3. **是否合入补丁 `r8-glue.patch`**（6 个清单外文件）。
4. **dual 模式怎么触发后台预渲染**：给 `Preview` 在 dual 模式下也按 2 秒一次调 `preload`（最省事，但会把 legacy 的 MOV / `preview.mp4` 一起跑起来），还是加一个只做锚帧 + 快照 + 轨道流的轻量入口。
5. **`sourceDependent` 的卡（转场、接素材的图卡）要不要进流**；**框用了三维的卡要不要进流**（这一版都不进，照 K5 贴快照）。
6. **硬件编码器**：现在缺省只用 `libx264`（兜底 `h264_mf`），`PROMPTCUT_STREAM_ENCODER=auto` 才按任务书的顺序探测硬件编码器——nvenc 那一行的参数没实测过。要不要默认 `auto`。
7. **「预渲染中」的界面样式**：状态可读（父页就绪索引里这张卡的 `stream` 表没覆盖当前分段；舞台 `__pcStageDiag().streams`），样式没做。
8. **流库的回收**：流键换了之后旧流目录不删（内容寻址的缓存），盘会一直长；回收策略和 A3b 的推送一起定。
9. **两张粒子卡同时挂载的既有问题**要不要修（会改导出像素）。
10. **6 条全幅流的保底帧数 vs 80 MB**（见更正建议第 5 条）。

## 提交

`8bca549` 报告骨架 → `76ae81e` 服务端骨架 → `2cd6bf7` 生产修正与生产探针 → `970f7c3` 舞台侧 → `a23bdf6` 组流平面挂载修正 → `705af8b` 单测 → `4738dd6` 探针扩充、租约换页 → `04c7e6a` 读口闸 → `584798f` 截图稳定 → `dbb3c3a` 空表关流 + 编辑台端到端探针 → `8f4d926` 异步到料重画、流画布默认铺满包裹层（之后只有本报告的提交）。

## 补丁 `r8-glue.patch`（6 个清单外文件，`git apply` 在仓库根目录用）

见 `out/r8-evidence/r8-glue.patch`（同内容），全文：

```diff
diff -ru a/server/vite-plugin-frames.ts b/server/vite-plugin-frames.ts
--- a/server/vite-plugin-frames.ts
+++ b/server/vite-plugin-frames.ts
@@ -46,6 +46,11 @@
     });
     services.set(root, service);
     /*
+     * R8:轨道流分段的读口挂在下面的 `/api/frames/*` 上 —— 生产者要读口接上了才开工、才发 `stream` 层
+     * (`StreamProducer.routeAttached`)。编辑器进程(`interactive: false`)没有生产者,这里是空操作。
+     */
+    service.streamProducer()?.attachRoute();
+    /*
      * F5:预渲染进程起来先扫盘重建「键 → 区间」。只挂在键上,不发 `layer` ——
      * `clipId` 要等项目到位、重算 card plan 之后才反查得出来(`adoptCardPlan`)。
      */
@@ -185,6 +190,12 @@
       }
       if (req.method === "GET") {
         /*
+         * R8 轨道流的字节(清单 / init / 分段),和快照字节同源、同走 `PROMPTCUT_CORS_ORIGINS`。
+         * 只有预渲染进程(`interactive: true`)有生产者;编辑器进程这里是 null,不答。
+         */
+        const producer = service.streamProducer();
+        if (producer && producer.handle(req, res, url.pathname)) return;
+        /*
          * J3 / C3 的快照字节:`GET /api/frames/snapshot/<kind>/<key>/<localFrame>`。
          * `kind` 为 `local` 时 `key` = `<entry.key>/<共享键>`,所以有两个键段。
          * 键是内容寻址的,所以可以 immutable 缓存一年。
diff -ru a/src/editor/Preview.tsx b/src/editor/Preview.tsx
--- a/src/editor/Preview.tsx
+++ b/src/editor/Preview.tsx
@@ -20,7 +20,7 @@
 import "./preview/preview.css";
 import { atFrameGrid } from "../render/frameGrid";
 import { contentStartOf } from "./timeline/utils";
-import { deliverSnapshots, markBaselineReset, noteSettled, pendingDemotes, pickForSetTime, stopSnapshotFeed, suppressedAt, syncSnapshotSubscription } from "./snapshotFeed";
+import { deliverSnapshots, markBaselineReset, noteSettled, pendingDemotes, pickForSetTime, stopSnapshotFeed, streamPlanesAt, suppressedAt, syncSnapshotSubscription } from "./snapshotFeed";
 import { playingCatchUpTargets, runPlayingSwap, runSettleSwap, setSwapHost, swapInFlight } from "./stageSwap";
 import { demotedClips, onStageDemote } from "./demote";
 import { flushSync } from "react-dom";
@@ -383,6 +383,8 @@
   dualRef.current = dual;
   /** 上一次发出去的抑制集合(拼成一条字符串比,省掉没变也发) */
   const suppressedRef = useRef("");
+  /** 上一次发出去的流平面(R8;同样拼成字符串比) */
+  const streamPlanesRef = useRef("[]");
   const pumpFeed = useCallback(async () => {
     if (!dualRef.current) return;
     const s = frontStage();
@@ -394,6 +396,13 @@
       suppressedRef.current = want;
       void s.setSuppressed(want ? want.split("|") : []).catch(() => {});
     }
+    // R8:和抑制集合同一处发流平面(播放中贴流;暂停 / 拖动时清空,改贴快照)
+    const planes = streamPlanesAt(head);
+    const planesKey = JSON.stringify(planes);
+    if (planesKey !== streamPlanesRef.current) {
+      streamPlanesRef.current = planesKey;
+      void s.setStreamPlanes(planes).catch(() => {});
+    }
     await deliverSnapshots(s, "front", head);
   }, []);
   const pumpRef = useRef(pumpFeed);
diff -ru a/src/editor/snapshotFeed.ts b/src/editor/snapshotFeed.ts
--- a/src/editor/snapshotFeed.ts
+++ b/src/editor/snapshotFeed.ts
@@ -33,6 +33,7 @@
 import type { Project, TrackClip } from "../kernel/project";
 import type { StageRole, StageRpcClient } from "../render/stageRpc";
 import { currentPlan } from "./planDispatch";
+import { rangesHave, SEGMENT_FRAMES, streamPlanesFor, type StreamPlaneRequest } from "../render/streamPlayer";
 
 /** C4：换 DOM 每 rAF 至多一次、间隔 ≥ 33 ms */
 export const SNAPSHOT_THROTTLE_MS = 33;
@@ -40,8 +41,23 @@
 export const SNAPSHOT_DELIVERY_MAX_BYTES = 2 * 1024 * 1024;
 /** C4：一次最多报 8 条缺口给预渲染进程 */
 export const MAX_WANTED = 8;
-/** 没有 `stream` 表时优先 `html`、再 `local`（A3a 的档位由预渲染进程按审阅表定，这里只看有没有） */
-const KIND_ORDER: ReadyKind[] = ["stream", "html", "local"];
+/**
+ * 快照按 `html`、再 `local` 的顺序选（A3a 的档位由预渲染进程按审阅表定，这里只看有没有）。
+ * **`stream` 不是快照**：它的区间单位是分段号、字节是 fMP4，由舞台里的 `streamPlayer` 解（R8）。
+ */
+const KIND_ORDER: ReadyKind[] = ["html", "local"];
+
+/** 这张卡此刻所在的分段有没有流（单卡流挂在它自己身上；组流挂在组里最上面那张上、带 `groupClipIds`） */
+function streamCovers(clipId: string, globalFrame: number): boolean {
+  const seg = Math.floor(Math.max(0, globalFrame) / SEGMENT_FRAMES);
+  for (const [owner, byKind] of readyIndex) {
+    const layer = byKind.get("stream");
+    if (!layer) continue;
+    const members = layer.groupClipIds?.length ? layer.groupClipIds : [owner];
+    if (members.includes(clipId) && rangesHave(layer.ranges, seg)) return true;
+  }
+  return false;
+}
 
 /** 这一刻某张卡选中的那一帧 */
 export interface Pick {
@@ -224,7 +240,7 @@
 /**
  * 这一刻的投递计划。**纯算，不 fetch、不发 RPC**，所以验收探针可以单独看它。
  */
-export function planFeed({ project, t }: Playhead): FeedPlan {
+export function planFeed({ project, t, playing }: Playhead): FeedPlan {
   const plan = currentPlan();
   const fps = Math.max(1, project.fps || 30);
   const globalFrame = Math.max(0, Math.floor(t * fps + 1e-6));
@@ -241,6 +257,8 @@
       pendingDemote.delete(clip.id);
     }
     heavy.push(clip.id);
+    // A3c：播放中**有流分段**的抑制卡不投快照（贴流）；缺分段 / 暂停 / 拖动时照投
+    if (playing && streamCovers(clip.id, globalFrame)) continue;
     let picked: Pick | null = null;
     for (const kind of KIND_ORDER) {
       const layer = layerOf(readyIndex, clip.id, kind);
@@ -401,6 +419,22 @@
   extraSuppressed = [...clipIds];
 }
 
+/**
+ * R8：这一刻的流平面（C3 末段：由就绪索引里 `kind: 'stream'` 的层合成）。只在播放中、只给被抑制的卡。
+ * 父页在发 `setSuppressed(H(t))` 的同一处发 `setStreamPlanes(...)`。
+ */
+export function streamPlanesAt(head: Playhead): StreamPlaneRequest[] {
+  if (!head.playing) return [];
+  const layers: { clipId: string; key: string; ranges: Array<[number, number]>; groupClipIds?: string[] }[] = [];
+  for (const [clipId, byKind] of readyIndex) {
+    const layer = byKind.get("stream");
+    if (layer) layers.push({ clipId, key: layer.key, ranges: layer.ranges as Array<[number, number]>, groupClipIds: layer.groupClipIds });
+  }
+  if (!layers.length) return [];
+  const fps = Math.max(1, head.project.fps || 30);
+  return streamPlanesFor(layers, new Set(suppressedAt(head)), Math.floor(head.t * fps + 1e-6));
+}
+
 /** 这一刻该抑制哪几张（播放中才有，C5 / K5） */
 export function suppressedAt(head: Playhead): string[] {
   if (!head.playing) return [];
diff -ru a/src/editor/stageSwap.test.mjs b/src/editor/stageSwap.test.mjs
--- a/src/editor/stageSwap.test.mjs
+++ b/src/editor/stageSwap.test.mjs
@@ -60,6 +60,8 @@
     markBaselineReset: (role) => log.push(["markBaselineReset", role]),
     setExtraSuppressed: (ids) => log.push(["setExtraSuppressed", [...ids]]),
     suppressedAt: () => ["h"],
+    // R8:播放态互换时也发流平面(和抑制集合同一组)
+    streamPlanesAt: () => [],
   },
 });
 mock.module(srcUrl("editor/demote.ts"), { exports: { onStageDemote: async (id) => { log.push(["demote", id]); return { ok: true, clipId: id }; } } });
diff -ru a/src/editor/stageSwap.ts b/src/editor/stageSwap.ts
--- a/src/editor/stageSwap.ts
+++ b/src/editor/stageSwap.ts
@@ -39,7 +39,7 @@
 import { runBackJob } from "./stageJobs";
 import { currentCosts, currentPlan, currentTuning, sendPlanTo } from "./planDispatch";
 import { clipIdentityOf } from "./costIdentity";
-import { deliverSnapshots, markBaselineReset, setExtraSuppressed, suppressedAt } from "./snapshotFeed";
+import { deliverSnapshots, markBaselineReset, setExtraSuppressed, streamPlanesAt, suppressedAt } from "./snapshotFeed";
 import { onStageDemote } from "./demote";
 
 /** K5 (3)：等后台舞台的素材层画出一帧，最多等这么久（真墙钟），超时照样换 */
@@ -269,7 +269,7 @@
     if (playing) {
       // 播放态互换：先把三个集合摆好，再 play(T)
       await next.setSuppressed(suppressedAt({ project, t: sec, playing: true }));
-      await next.setStreamPlanes([]);
+      await next.setStreamPlanes(streamPlanesAt({ project, t: sec, playing: true }));
       markBaselineReset("front");
       await deliverSnapshots(next, "front", { project, t: sec, playing: true });
       await next.setScrubbing(false);
diff -ru a/src/render/snapshotSource.ts b/src/render/snapshotSource.ts
--- a/src/render/snapshotSource.ts
+++ b/src/render/snapshotSource.ts
@@ -49,7 +49,7 @@
 }
 
 /** 就绪索引的页面侧形状(C3):同一张重卡的 `stream` 表和 `html` 表并存、互不覆盖 */
-export type ReadyIndex = Map<string, Map<ReadyKind, { key: string; ranges: ReadyRange[] }>>;
+export type ReadyIndex = Map<string, Map<ReadyKind, { key: string; ranges: ReadyRange[]; groupClipIds?: string[] }>>;
 
 /**
  * 把一条消息应用到页面的 `readyIndex`。`reset` 清表,`layer` 整层替换
@@ -60,7 +60,8 @@
   if (message.type !== "layer") return index;
   let byKind = index.get(message.clipId);
   if (!byKind) { byKind = new Map(); index.set(message.clipId, byKind); }
-  byKind.set(message.kind, { key: message.key, ranges: message.ranges });
+  // 组流(R8 / G1)的层带 `groupClipIds`:父页按它合成一条 `{ clipIds: groupClipIds }` 的流平面
+  byKind.set(message.kind, { key: message.key, ranges: message.ranges, ...(message.groupClipIds?.length ? { groupClipIds: [...message.groupClipIds] } : {}) });
   return index;
 }
 
```
