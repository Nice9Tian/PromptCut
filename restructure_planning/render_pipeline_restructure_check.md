# 渲染管线重整计划——执行核对（render_pipeline_restructure_check）

这份文件**只记做了什么、没做什么、验到了什么**，章节编号和 `render_pipeline_restructure.md` 一一对应；计划本身（范围、依赖、更正、决策）只在那边，这边不重复。每次合并一步就更新这里。最后更新：2026-09-22，main `e7eeb3a` 之后。

**总状态**：R0～R7 完成（R0 剩两条），**舞台已露出、缺省已翻成跨源双舞台**；R8、R9 未开始；云端那一半未开始。main 上 `tsc -b --force` 零错误，`npm test` 1633 / 1632 通过 / 0 失败 / 1 跳过。

**做法**：我在 main 上统筹，可解耦的子任务派 Opus 在子 worktree 里做，每个回来由我审查、重跑类型检查和全量测试后 `--no-ff` 合并。**分册的独立审查没有另派**（用户「一口气做完」之后，我改成让实现者逐句对照代码读任务书，报上来的更正折回分册；这是我替用户做的决定，记在这里）。下文凡是标「Agent 自报」的数字是实现者的报告，我没有重跑；标「我验」的是我在 main 上自己跑的。

---

## 1. `result_decouple.md` 逐项查收

全部核过（2026-09-22，未用子 Agent），细节在计划正文第 1 节。没核的：报告第 5 节的四次真实渲染冒烟和 STT 端到端；对外接口的对账脚本没重跑。

## 2. 现在手上有什么 / 2.1 压力实测

计划正文第 2 节的数据都是实测。其中「2 核 60 fps 下 3 张粒子卡判重」在 R4a 改成百分位之后**已不成立**：两种配置各连跑两趟，因单帧太慢判重的都是 0 张、名单一致（见 R4）。计划正文 2.1(a) 已加注。

## 3. 对底稿的更正

3.1～3.9 全部已折进各分册（`r2-r7-task.md`、`r8-streams-task.md`、`r9-webgl-task.md`），实现时又产生的更正记在各分册文首「实现后的更正」一节（R2、R4a、R7 三批）。3.8（生成快照命名与指标拆开）由 R1 实现；3.9（像素映射分流）由 R1b 实现，实现时改掉 3.9 的七条见下文 R1b。

## 4. 路径对照

解耦之后的路径表；分册里 R2～R7 期间又新建的文件（`previewMode.ts`、`stageJobs.ts`、`planDispatch.ts`、`probeRunner.ts`、`snapshotFeed.ts`、`stageSwap.ts`、`demote.ts`、`VideoTrack.tsx`、`mediaDrive.ts`、`virtualTimers.ts`、`pipelinePlan.mjs`、`pipelineTuning.mjs`、`wirePlan.ts`、`snapshotSource.ts`、`snapshotPick.mjs`、`costDevice.mjs`、`snapshotCompare.mjs`、`server/ready-index.mjs`、`server/prerender-set.mjs`、`server/stage-ports.mjs`、`server/vite-plugin-stage-ports.ts`）没有回填进第 4 节的表。**待补。**

## 5. 步骤

### R0 清账

| 条 | 状态 |
|---|---|
| 1 探针改动与 `g0-a-webview2-probe.md` 提交 | 已做（`5157f91`） |
| 2 `scripts/verify-unified-frames.mjs` | **做了一半**。脚本两处过期已改（`eec7a08`：缓存命中的来源叫 `mov`；导出页要经 `?timeline=` 带项目）。剩下的真问题两个根因：**根因一已修**——begin-frame 控制下 Motion 的 JS 帧循环（spring、MotionValue）只在真截图时才推进，HTML 快照在截图前生成，纯采样那一趟一张图都不截，快照里这类动画整段冻在第 1 帧（30 fps 下 `punch-pill` 整段小 33%）；修法是生成快照前先画一拍把图丢掉（`server/bakery/bake.mjs` +22 行），导出 60 / 60 帧逐字节不变（Agent 自报），代价快照趟每帧多约 20～30 ms，旧共享快照全部失效（本来就是错的）；差异从 65607 个通道缩到 27080 个、超过 2 级的只剩 15 个。**根因二未修**——快照重放时重新排版丢 1/64 px（`getComputedStyle().width` 只给三位小数），`blur(32px)` 对此极敏感、能差出 255 级，无滤镜的卡最大差 3；修它要改 `inlineStyles.ts` 的几何内联口径、作废全部共享快照，三个修法和代价在排查报告里（本会话 scratchpad `replay-mismatch-report.md`，没进仓库）。**这条脚本的最后一条断言仍以红为已知状态。** |
| 3 仓库根 dev server 冷启动量测 | **没做**（一直有 Agent 在跑，没有安静的机器可量） |
| 4 旧任务书文首说明 | 已做，随后旧任务书整体删除（见第 7 节） |

### R1 差异样式内联收尾——已完成，合并 `e67390e`

- **我验**：`tsc` 零错误；`npm test` 1472 / 1471 / 0 失败 / 1 跳过。
- **Agent 自报**：新旧快照重放逐像素比对 8 / 8 相同（四张卡各两帧，探针 `scripts/probes/snapshot-diff-compare.mjs`）；导出 240 / 240 帧逐字节相同；单帧快照 max 23107 → 915 KB，超 300 KB 的 DOM 卡只剩 `lottie-bodymovin`（915 KB）和 `lottie-navidad`（855 KB），DOM 卡 p90 185.8 KB（不算 lottie 47.8 KB），canvas 位图 p90 / max 466 / 628 KB；成本探针 62 张全部测通并落盘（dev 模式）：30 fps 下 `stepMs` p50 / p90 / max = 1.3 / 2.7 / 6.6 ms、0 张判重；2 核 60 fps 下 2.4 / 4.9 / 21.2 ms、3 张越线（旧口径，取单次最大）；`inlineMs` p50 / p90 / max = 6.1 / 23 / 367 ms，`rasterMs` 0.1 / 36 / 94 ms，`serializeMs` 0.8 / 1.9 / 149 ms。
- **实现时补定的三条**：`direct` 卡也有 `stepMs`（在等 rAF 之前取），类型收紧成 `number`；`cloneScene` 的时间并进 `inlineMs`、`stripMedia` 并进 `serializeMs`；`SNAPSHOT_FILES` 随拆出来的三个模块一起加（`solid.ts` 照旧不进）。
- **没做**：`configurePreviewServer` 和 build 模式那一趟（光补四个插件跑不起来，`dist/` 里没有 `/src/**`，还要一套探针 kit；留给在线浏览器模式）。
- **两张超 300 KB 的 lottie**：不处理（用户定，见第 7 节）。

### R1b 像素映射分流与 GPU 后端——已完成，合并 `dd58cb5`

- **我验**：`tsc` 零错误；`npm test` 1481 / 1480 / 0 失败 / 1 跳过；`node scripts/probes/pixelmap-gl-probe.mjs`（真 GPU：RTX 3080 / D3D11）八个用例里七个 GPU 对 CPU 最大差 ≤ 1 级（1080p，829 万个通道值），1080p 视频单帧主线程提交 p50 0.2 ms、GPU 计时查询 0.016 ms（CPU 旧实现 416～483 ms）。
- **Agent 自报**：图片素材挂抠色映射的真实导出对 `mapRgba` 最大差 0 级。
- **一条已知超标**：continuous 颜色序列 13 / 207 万像素差 255 级——这些像素到两个 `from` 色精确等距，旧实现让浮点末位舍入决定，着色器稳定取靠前那个；不改。
- **实现时对 3.9 的更正**：① `colorSequence` 一律判 B；② A 类除看表达式形状还要把等价 `ops` 在 0～255 全值域逐值核对，差 > 1 级退回 B；③ `curves` / `matrix` 改不了 alpha，A 类等价只在不透明素材上成立，回包带 `alphaNote`；④ C 类不是「GLSL 没有对应函数」，是负底数配非整数常量指数的乘方；⑤ 画完用 `transferToImageBitmap` + `bitmaprenderer` 而非 `drawImage`（预乘来回会吃掉低 alpha），素材层画布因此不能再有 2D 上下文；⑥ x / y 从 `gl_FragCoord` 算；⑦ 验收「1080p 播放 0 长任务」量不了，改成「单帧主线程 < 1 ms」。
- **遗留**：`normalizePixelMapDef` 忽略 `colorSequence.mode`（只认顶层 `mode`），要不要改行为另开一条。

### R2 双舞台与协议补齐——已完成，合并见 git log「合并 R2」

- **我验**：`tsc` 零错误；`npm test` 1505 / 1504 / 0 失败 / 1 跳过（新增 24 条）。
- **Agent 自报**：`stage-rpc-probe` 跨源与 `--legacy` 各 3 次全过；进程隔离 3 轮全过（CDP 里 2 个 `type: 'iframe'` target；A 死循环 2.5 s 时父页最坏 rAF 间隔中位数 6.1～6.6 ms）；`editor-preview-smoke` 两种模式全过，`get_layout` 的 `contentBox` 和拖动写入的 `frame` 逐位相同。
- **做成什么样**（与计划不同处）：非 legacy 开关是 `?preview=stage`（R7 之前 legacy 缺省）；`job` 枚举 RPC 上是 `'probe' | 'catchup' | 'bake'`，父页队列分三档、测量映射成 `catchup`；`desktop/` 下没有写 port.json 的代码，`stagePorts` 写在 `server/vite-plugin-ai.ts` 那处；「父页最坏帧间隔 < 20 ms」在这台机器的无头 Chrome 上要带 `--disable-gpu-vsync --disable-frame-rate-limit` 才量得到主线程停顿。
- **舞台端口 = 编辑器端口 +1 / +2**，会吃掉相邻端口：`npm run preview` 从 5191 挪到 5195；`.claude/launch.json` 的 `dev-test` 从 5197 挪到 5203（否则撞 `dev-2d` 的 5198）。用户常驻的 5190 的舞台端口是 5191 / 5192，**没确认是否空闲**。
- **留给后面的**：`play` / `pause` 回 `unsupported`（R5 做）；七种事件 R2 里一条不会来。

### R3 舞台内容——已完成，合并见 git log「合并 R3」

- **我验**：`tsc` 零错误；`npm test` 1589 / 1588 / 0 失败 / 1 跳过。合并时一处冲突（探针卡注册表），已合。
- **Agent 自报**：导出逐字节 90 / 90 相同（每棵树第一趟冷起会因字体预热差 35 帧，去掉冷起后四趟两两一致——**比对陷阱，记住**）；`verify-bake-protocol` PASS；新探针 `stage-content-probe.mjs` 21 条断言 3 次全过；E4b 两条判例：打字机卡补跑到第 3 秒恰好 30 格、倒计时卡推 10 秒恰好少 10000 ms；`editor-preview-smoke` legacy / `--stage` 均 PASS。
- **与任务书不同**：`Date.now` 沿用已有的固定纪元，没换成「舞台打开那一刻的真实时间」（否则预览和导出的日期卡不一致）；假定时器只装在舞台、没装导出页（导出页三处墙钟定时器会死锁，与「导出逐字节不变」冲突）。
- **只验了一半**：图卡接管素材段只验了「`VideoTrack` 不画它」（仓库里还没有 `def.card` 的图卡）。

### R4 探针与分派——已完成（分两半：R4a 合并见「合并 R4a」，R4b 见「合并 R4b」）

**R4a（分派纯函数、可调系数、离线探针两趟）**
- **我验**：`tsc` 零错误；`npm test` 1547 / 1546 / 0 失败 / 1 跳过（新增 42 条，K 节验收算例逐条覆盖）。
- **Agent 自报**：62 张高频卡，28 核 30 fps 下 `stepMs` p50 / p90 / max = 1.00 / 1.70 / 3.00 ms，限 2 核 60 fps 下 1.30 / 2.20 / 3.70 ms；**新口径（百分位）两种配置各连跑两趟因单帧太慢判重都是 0 张、名单一致**；旧口径（单次最大）限 2 核下两趟 11 张和 9 张、交集 6 张。判重现在全部来自追帧上界：换算成片段长度 p50 约 12 秒、最短 8 秒（`scene-3d`）；20 秒片段 8 张样本 6 张判重。
- **做成什么样**：`GET /api/data/costs` 回 `{ ok, device, mode, costs, tuning }`（加字段没改名）；`STEP_PERCENTILE` / `STEP_MIN_SAMPLES` 拼进 `device` 串，`COST_SCALE` 不拼；`COST_SCALE` 乘在 `stepMs` / `catchUpMs` / `seekMs` 全部实测成本上；`planPipelines` 的 `opts` 多 `identityKeys` / `frameModes`，「片段 → 节点 → `cardCostKey`」拆成 `clipCostIndex`；`catchUpMs` 外推 = 已推帧之和 + 中位数（除首帧）× 未推帧数；`robustStep` 样本不足取最大值。
- **没做**：`out/pipeline-tuning.json` 的写入口（R4b 补了）；`--mode build`（宿主页只有 dev server 供得起）。

**R4b（`ProbeGate`、常驻探针、布尔探针、`setPlan` 下发）**
- **我验**：`tsc` 零错误；`npm test` 1625 / 1624 / 0 失败 / 1 跳过。合并时三处冲突（探针卡注册表、`pinAnimations.ts` 两边各加了同名函数——取 R3 的超集、`StageView.tsx` 状态区），已合。顺手把 `server/costs-store.mjs` 里键分隔符的字面 NUL 换成 ` ` 转义（git 原把它当二进制）。
- **Agent 自报**：`probe-gate-probe` 三趟 pass——20 张没测过的卡遮罩停到测完（8.5 秒）、`out/card-costs.json` 20 条齐全、第二次打开遮罩一帧不出现、后台舞台任何时刻只有 1 个卡片段、换项目后队列重排；布尔判例全中（`probe-css` `vtOk+seekOk`、`particles-snow` `vtOk`、`probe-motion-js` `vtOk:false`）；`device` 串与离线探针逐字节相同，`stepMs` 对照 20 / 20 同量级。
- **一条实话**：帧间隔 p50 17.1 ms ≤ 20 ms，但 headless 下 rAF 仍贴着 16.7 ms，那两个参数没解开 vsync，量到的是上界。
- **做成什么样**：舞台不 post `probe` 事件，父页按三次 `render` 回包自己合成记录；布尔趟自带基线；`render` 快照趟加 `snapshotSteps` 逐帧样本；布尔探针不需要 `Stage` 的 `settling` prop；`seekMs` 超上限记 `null`。
- **留给后面的**：`probe-frame` → `PUT /api/frames/snapshot` 的转发写好但未验收；K3 / K5 的消费、K6 的 `demote` 接收、切 fps 后重走遮罩（R5 做）。

### R5 播放与追帧——已完成，合并见 git log「合并 R5」

- **我验**：`tsc` 零错误；`npm test` 1632 / 1631 / 0 失败 / 1 跳过；合并无冲突。
- **Agent 自报**：节拍 24 / 25 / 30 / 60 fps 各播 10 秒，`frame` 间隔均值 41.704 / 40.054 / 33.356 / 16.691 ms（全部 ±0.04 ms 内），`sec` 差恒为 1 / fps，30 fps 无短拍，主文档长任务 0；到头 `ended.sec = 2`、`store.t = duration`、循环自停、`suppressed = []`；追帧第一路 `settled` 带 clipId、追完摘类摘快照，第二路 front A→B、新 front post `settled(clipIds=[])`、三个集合全空，连点 10 次恰好互换 1 次；K3(a′) 不进 `prerenderSet`、跳到 50 s 不重挂载一步到位、55 s→20 s 重挂载恰好 1 次；K6 `demote` 命中最贵那张、拍长 62 ms 而 `sec` 差 0 条错、`costs` 与落盘各恰好 1 条 `capped+demoted`、就绪前留在 `pendingDemote` 照常活渲；既有探针全绿。
- **实跑才暴露、已修的 5 个问题**：`Preview` 的 effect 依赖成环（Maximum update depth）；`settled` 按工作项判会被队列交还抢先；带 `reset` 的投递基线没清零；**React `<Profiler>` 在舞台里恒报 0**（它读被虚拟化的 `performance.now`，舞台里量耗时一律用 `__pcRealNow`）；**K6 会连着降**（`pendingDemote` 的耗时没从窗口扣掉）。另修：被节流的跨源 iframe 会把节拍循环永久挂死。
- **做成什么样**：「慢帧后移」按这一拍的活超时判；`setPlan` 带 `identityKeys` / `tuning`；没有成本记录的卡不触发 K5 两路（否则刚打开项目就互换、挤掉探针）；`prerenderSetOf` 已接上真的 `planPipelines`（两端同表有单测）。
- **没验到**：要预渲染进程才验得了的三条 K6 闭环（33 ms 换快照、就绪后切换、重测写回 `demoted: false`）；「零卡顿」只量到播放中、未同时跑预渲染；逐帧录屏那两条改用等价判据；`stageJobs.lastSentJob` 在互换后可能漏发一次 `setRole`（R7 修了）。

### R6 数据面——已完成，合并见 git log「合并 R6」

- **我验**：`tsc` 零错误；`npm test` 1572 / 1571 / 0 失败 / 1 跳过。
- **Agent 自报**：`ready-index-probe.mjs`（冷缓存）8 条全过——锚帧先就绪；SSE 首条 `reset`；取回的 HTML 与磁盘逐字节相同；C4 第 45 帧选中段起点 29；超限帧（1 438 949 字节）盘上有、层不存在；`unknown` 卡在 `'local'` 表里；杀进程后重连首条 `reset`、项目到位后三层重建；`wanted` 促成批次提前。`editor-preview-smoke` 过。
- **做成什么样**：`vite.config.ts` 一行没改；预渲染进程端口落不到 5231～5239（`listen(0)` 是 OS 临时端口，探针从 `/api/prerender/info` 读地址）；新增 `GET /api/frames/diagnostics`（预渲染进程 stdout 进程外看不见，批次插队和超限帧诊断从这里读）；A3c 的「canvas 位图 1 MB」在服务端没有可单独量的对象，对 `canvasHeavy` 的卡取整帧上限 1 MB；C2 的 HTML 完整性判据和 PNG 的 `hasComplete` 取并。
- **留下的接线**：`server/prerender-set.mjs` 的 `prerenderSetOf` 当时按声明兜底，R5 接上了真的。

### R7 露出舞台（原子切换）——已完成，合并见 git log「合并 R7」，**开关已翻**（单独提交 `9b88e9b`，摘掉它就回 legacy 缺省）

- **我验**：`tsc` 零错误；`npm test` 1633 / 1632 / 0 失败 / 1 跳过；在 5203 上开编辑器看过——主文档挂两个跨源舞台 iframe（5204 前台 `opacity: 1`、5205 后台 `opacity: 0; pointer-events: none`），主文档里没有整帧图、没有素材元素，点播放 3 秒内 `store.t` 推进 3.000 秒、主文档长任务 0，截图里舞台在画当前片段的卡。
- **Agent 自报**：12 趟无头探针全绿（每趟一台新 dev server）；导出逐字节 60 / 60 相同；**有头**（不关 vsync）24 / 30 / 60 fps `frame` 间隔均值 41.755 / 33.339 / 16.674 ms，`sec` 差恒为 1 / fps，主文档长任务 0，拖动 30 次往返均值 7.9 ms、最大 11 ms；`verify-bake-protocol`、`verify-export-frame-content` 过；桌面壳 `cargo check` 通过（为此补了两样 gitignore 的本地资源）。
- **做成什么样**：`probe_port` → `probe_port_at(port, timeout)`，新增 `occupied_stage_ports` 查 5211 / 5212 并在弹窗里点名，**被占只警告不拦启动**；`smoke-boot.mjs` 新增 Step 2b 等两个舞台端口各回 200 + OAC 头；`remote.json` / `on_navigation` 没改；`editor-preview-smoke` 原来是 order-dependent 的（只 `addCardClip` 从不 `newProject`），总验收改成一探针一台新 server，并给它加 `--legacy`。
- **没验到 / 没做**：拖动 `frame` / `contentBox` 与 legacy 的跨模式逐位比对；K6 那三条；回滚路的截图逐字节比对（只验了结构等价）；「零卡顿」只到「预渲染在跑 + 后台舞台空闲」（探针几百毫秒就收工，压不住「同时」）；桌面壳没真构建、没真跑；`verify-unified-frames.mjs` 挂在「导出页 60 秒没就绪」——退回 main 复跑挂在同一行，可能是环境问题，没查根因。
- **已知代价**：legacy 模式下点素材段会选不中（主文档的 `mediaRects` 删了，任务书明写的）。

### R8 轨道流——未开始

编码原型（G0-b）已做完，探针 `scripts/probes/stream-*.mjs` 已合并、报告 `g0-b-stream-prototype.md`、结论已回填 `r8-streams-task.md`。没做成的：nvenc 的 `-tune ll` vs `-rc vbr -cq`（驱动版本不够，ffmpeg 9.0.1 要 nvenc API 13.1）；桌面壳 WebView2 上的复测；带 `motion` 的卡上两种裁剪矩形的对比；组流。

### R9 共享 WebGL 渲染器——未开始

分册 `r9-webgl-task.md` 已就绪（含 M7：像素映射的上下文并进来）。`gl-atlas-probe.mjs` 未写。

### 依赖

按计划顺序执行：前置（R1、R1b）→ 第一波 R2 / R4a / R6 并行 → 第二波 R3 / R4b → R5 → R7。R4 拆成两半是为了和 R2 并行，计划里没写。

## 6. 云端那一半

未开始。分册 `cloud-task.md` 已就绪，文末 6 个问题动工前定。

## 7. 决策

「已定的」全部已落地或已写进分册。「还没定的」现状：
1. 四份分册的独立审查——**没派**（见文首「做法」）。
2. `cloud-task.md` 文末 6 个问题——未定，云端动工前定。
3. R8 / R9 分册的三个细节——未定，各自动工时定。

## 附：这次没照计划做的地方（汇总）

- 独立审查没派（用户「一口气做完」后我定的）。
- R4 拆成两半。
- 第 4 节路径表没回填新文件。
- R0 的冷启动量测没做。
- 各步验收里打折扣的项都在上面各节的「没验到」里。
