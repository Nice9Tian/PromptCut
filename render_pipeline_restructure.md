# 渲染管线重整计划（render_pipeline_restructure）

基线：第 1、2 节的核对做在本地 main `30917d2`（2026-09-22）；之后 main 上又落了探针（`5157f91`）、滤镜两种新 op（`7f10ebe`）、第 75 轮审查材料（`dfef7e8`）。必读：`user_pinned_goal.md`（2026-09-22 经弹窗确认改过三处：渲染 5、渲染 10、架构 1，本文逐条遵循；引用写「pinned 架构 N / 渲染 N / 划分 轴N / 平台」）。
**本文是整个计划的总入口。** 旧任务书 `AGY-TASK-cloud-doc-and-write-race.md`（第 111 版）已按用户 2026-09-22 的决定**整体舍弃**，还有价值的内容都搬进了仓库里受版本控制的分册，动工读分册：

| 分册 | 管什么 |
|---|---|
| `docs/plan/r2-r7-task.md` | R2～R7：双舞台、舞台内容、探针与分派、播放与追帧、数据面、露出舞台 |
| `docs/plan/r8-streams-task.md` | R8 轨道流（依赖编码原型的数标了「待 G0-b 原型定稿」） |
| `docs/plan/r9-webgl-task.md` | R9 共享 WebGL 渲染器 |
| `docs/plan/cloud-task.md` | 云端 / 文档服务那一半（旧第 5～10 步），排在 R7 之后 |
| `docs/plan/landed-notes.md` | 已落地那几步留下的验收口径和「不做」条目 |
| `docs/plan/r75/` | 第 75 轮十份分步审查和逐条处理意见（过程材料） |

分册都已折进本文第 3 节的更正和第 75 轮的处理意见，但**都还没经过独立审查**。本文下面提到「底稿」的地方，指的就是已舍弃的旧任务书，留作来历说明；内容以分册为准。

---

## 1. `result_decouple.md` 逐项查收（2026-09-22，我独立核对，未用子 Agent）

| 项 | 报告的说法 | 我核对的方法 | 结果 |
|---|---|---|---|
| 2.1 store 解环 | `actions/*` 不再 import `../project`；`project.ts` 只转出门面 | `grep` `src/store/actions`；读 `src/store/project.ts` 的 export | 属实：零命中；export 只有 `EditorState` / `getState` / `subscribe` / `useStore` / `planPlacement` / `actions` |
| 2.2 MCP 路由表 | 103 条 `else if` → `src/mcp/routes.mjs`；4 个工具模块下沉到 `src/mcp/tools/` | 数 `routes.mjs` 的 `method:`；数 `mcpExecutor.ts` 剩余的 `else if (tool ===` | 属实：路由 103 条；`mcpExecutor.ts` 只剩 5 条，都是报告列的特殊分支；`src/mcp/tools/` 四个模块与单测在位 |
| 2.3 渲染引擎搬家 | `scripts/export-frames.mjs` 1406 → 42 行；`server/bakery/` 七个模块 + 11 个传递依赖；`server → scripts` 断开 | `wc -l`；`grep` `server/**` 对 `scripts/` 的 import | 属实：42 行；`server/bakery/` 19 个文件、行数与报告一致；`server/**`（测试除外）零处 import `scripts/` |
| 2.4 分层 | 9 个文件 `git mv`（`Stage` / `PartTree` 上移到 `render`，`frameMode` 下沉到 `kernel`，`prerender` / `dataMirror` / `contentBox` 从 `editor` 移到 `render`，部件契约下沉，新建 `kernel/cardGpu.ts`） | 逐个看新旧路径 | 属实：9 个新路径都在，6 个旧路径都不在 |
| 2.5 vision 拆分 | 外壳 56 行 + `server/vision/` 九个模块 | `wc -l` | 属实：行数逐个对上（56 / 387 / 118 / 82 / 142 / 153 / 618 / 163 / 369） |
| 3 #10 指纹清单 | `frame-code.mjs` 的 `CAPTURE_FILES` / `FREEZE_FILES` 改指 `server/bakery/*` | 读 `server/frame-code.mjs:19` / `:70` | 属实。后果见下「要记住的两件事」 |
| 4 守门测试 | 5 个新测试文件 | 看文件在不在，并跑全量 | 5 个都在 |
| 5 验证数字 | `tsc -b --force` 零错误；`npm test` 1462 / 1461 pass / 0 fail / 1 skipped | 我在 main 上重跑了一遍 | **完全一致**：`tsc` 退出码 0；1462 / 1461 / 0 / 1 |
| 6.5 别的会话的 worktree | `.claude/worktrees/agent-af0dae85c12674862` 有 18 个未提交改动，未动 | `git status` | 属实。它是我上一轮派出去做「差异样式内联」的那个，见第 2 节 |

没有查出与报告不符的地方。没核的部分：报告第 5 节的四次真实渲染冒烟和 STT 端到端（需要起服务看图，我这次没重做）；对外接口「逐项序列化比较」那几行我只核了结果面（测试全过、路由条数），没有重跑它的对账脚本。

**要记住的两件事**（对渲染计划有直接影响）：

1. **全部帧缓存和共享快照已经失效过一次**（路径进了 `frameCode` / `captureCode` / `freezeCode` 的哈希）。差异样式内联落地时会再失效一次，两次合成一次处理即可，不需要兼容旧快照。
2. **报告 6.2 说 `out/frame-library/` 的文件量会拖垮 vite 的文件监听**。我看了 `vite.config.ts:76-80`，`**/out/**` 已在忽略名单里，所以真正的原因还没钉死；桌面版跑的就是 vite dev server（见 3.1），用户冷启动同样受影响，列进 R0 先量再改。

---

## 2. 现在手上有什么（截至 `30917d2`）

**已落地、已提交**：原任务书第 1、2、2b、3 步（`b5c65dc`）——能力审计与审阅表、镜像插件与两层 diff、素材按哈希寻址、快照格式（`freezeScene`）、共享键与快照库、挂载算式统一、JS 图卡、舞台 postMessage RPC（`stageRpc.ts` / `stageBridge.ts`）、`solid.ts`、成本记录的键与端点、离线成本探针。之后是 PR #1 和这次的五项解耦。

**已提交（`5157f91`）**：桌面壳探针——`scripts/probes/probe-connect.mjs`、`videodecoder-probe.mjs`（新），`backdrop-probe.mjs` / `oac-probe.mjs`（改），报告 `docs/g0-a-webview2-probe.md`。三项全过：WebView2 153 硬解 H.264（1080p 稳态 1.5 ms / 帧，上下拼合的 1920×2176 约 2.5 ms / 帧）；跨源 iframe 里视频下的毛玻璃正确；带 `Origin-Agent-Cluster: ?1` 时舞台 iframe 独立进程（父页最坏帧间隔 7 ms）。

**已核、无代码改动**：能力审计的两条验收都过——仓库注册表 89 张卡里 `unknown` 为 0、54 张粒子卡全部 `canvasHeavy`；5 份旧 `.proc`（含没写 `frameMode` 的定制卡、裸 Project、Python 卡样本、全部素材无哈希）都能打开。

**做了一大半、被额度打断**（worktree `.claude/worktrees/agent-af0dae85c12674862`，基于 `b5c65dc`，18 个未提交改动，**没有交付报告**）：差异样式内联（`src/render/snapshotFreeze.ts` +225 行，新模块 `src/render/freezeStyleProps.mjs`）、四个插件补 `configurePreviewServer`、成本记录加 `mode`、三个新探针、两份探针重跑的数据（存在旧 scratchpad 的 `opus-3b/`）。它的验收跑到哪一步不知道，**一律按未验收处理**。数据本身可用：

| 量 | 差异内联之前 | 之后 |
|---|---|---|
| 单帧快照 max | 23107 KB | 956 KB |
| 超 300 KB 的 DOM 卡 | 12 张 | 2 张（都是 `lottie-*`） |
| DOM 卡 p90（排除 `lottie-*`） | — | 47.8 KB |
| canvas 卡位图 p90 / max | — | 466 KB / 628 KB（上限 1 MB） |

| 成本探针（62 张高频卡，fps 30，预算 B = 23.3 ms） | dev 模式 | 构建产物 |
|---|---|---|
| 含冻结的单帧最差 `frameMs`：p50 / p90 | 34.6 / 46.8 ms | 23.7 / 44.4 ms |
| 按 `frameMs > B` 判重的张数 | 37 | 32 |
| **不含冻结的单帧最差 `stepMs`：p50 / p90 / max** | **1.3 / 2.5 / 6.9 ms** | 0.4 / 1.6 / 6.9 ms |
| **按 `stepMs > B` 判重的张数** | **0** | 0 |

### 2.1 压力实测（2026-09-22，用户要求；我自己跑的）

**(a) 限 2 个核心、按 60 fps 重跑成本探针。** dev server 和探针的 Chrome 都用 `start /affinity 3` 钉在 2 个逻辑核上（本机 28 核、RTX 3080；已确认 Chrome 进程的亲和掩码是 3），`node scripts/probe-card-costs.mjs --fps 60 --dry-run --force`，61 / 62 张测完（`lottie-navidad` 生成快照超时）。门槛 B = 1000/60 × 70% = 11.67 ms。

| 活渲单帧最差（不含生成快照） | 28 核、30 fps（上表） | 2 核、60 fps |
|---|---|---|
| p50 / p90 / max | 1.3 / 2.5 / 6.9 ms | 2.7 / 8.2 / 33 ms |
| 超过各自门槛的卡 | 0 张 | **3 张**（R1 之后重测仍是 3 张，但换成了 `particles-lch` / `lottie-happy2016` / `scene-3d`——2 核下单帧最差的噪声很大，**张数可信、卡名不可复现**；R4 要拿它当依据得多跑几趟取中位）：`particles-orbit` 33 ms、`particles-snow` 31.8 ms、`particles-slow` 19.9 ms |
| 其中连 30 fps 的 23.3 ms 也超的 | 0 | 2 张（orbit、snow） |
| 次一档（接近门槛） | — | `mu-blur-fade` 10.5、`particles-star` 9.4、`particles-random` 8.6、`checklist` 8.2、`particles-spin` 8.1 |

结论（2026-09-22 按 R1 的重测和追帧上界修订）：**谁会用到重管线，要分两条判据看。** (1) **单帧太慢**（`stepMs > B`）：按现在的卡库没有——R4a 改成百分位之后 62 张卡在两种配置下各连跑两趟都是 0 张、名单一致；下面是改之前的数：本机 30 fps 下 0 张；限 2 核 60 fps 下两次实测各有 3 张越线，但两次的三张完全不重合、同一张卡能差十几倍，是偶发的慢帧而不是卡的稳定成本（所以判重改取百分位、不取单次最大，见 3.3）。(2) **整段追不上**（K2 的追帧上界：要逐帧推、不能直接定位的卡，从第 0 帧追到最后一帧 2 秒内追不完就每个位置判重、整段进预渲染）：每拍最多多推 4 步，换算下来**片段超过约 8 秒就触发，和每帧多便宜无关**。粒子卡正是这一类（靠时间逐格推进，`particles.tsx` 的 `MAX_STEPS = 1200` 之外画面还会错），一张铺满 20 秒的粒子背景按规则就是重卡，播放中要靠轨道流才会动。**重管线的主要用户是「长的、有状态的卡」，不是「慢的卡」**——所以轨道流原型现在就做（第 7 节）。

**(b) 给素材做颜色映射会不会成为重活。** 同一段 1080p H.264 视频，三条路各量单帧的主线程耗时（无限核，脚本和原始数据在 scratchpad `colormap-bench.mjs` / `.json`）：

| 做法 | 项目里对应什么 | 1080p 单帧主线程耗时 | 结论 |
|---|---|---|---|
| CSS `filter`（函数式，或 SVG 查表 `feComponentTransfer` + `feColorMatrix`） | `project.filters`，挂在 `<video>` 上 | 量不出来：播放 3 秒，帧间隔中位数不变，0 个长任务；函数式那组掉了 3 / 92 帧，SVG 查表 0 帧 | 合成器线程在 GPU 上做，不占每拍预算 |
| **像素映射 `pixelMap`**（`FrameScene.tsx` 的 `PixelMappedMedia`：`getImageData` → 逐像素调 `mapRgba` 解释表达式 → `putImageData`） | `create_pixel_map` / `apply_pixel_map` | **416～483 ms**（其中逐像素循环 337～402 ms、读回像素 35～84 ms）；720p 也要 203～232 ms | 超 30 fps 门槛约 20 倍，任何机器都重 |
| WebGL 片元着色器 + 33³ 三维查找表 | 还没有；GPU 图卡 / 共享 WebGL 渲染器可以这样做 | 0.1 ms（提交 + `gl.finish`；这个数小得可疑，只能说明主线程提交很便宜，GPU 真实耗时要用计时查询再量） | 是达芬奇那种调色该走的路 |

**由此暴露的计划缺口**：像素映射挂在**素材层**上，素材层不是卡片——不被探针测、不进轻重分派、没有死素材。今天的编辑器预览（`MediaLayers`）根本不画像素映射，只有导出页和 `see_frames` 画；R3 把素材层搬进舞台、R7 露出舞台之后，带像素映射的素材段会在每一拍里同步跑 400 多毫秒，整个舞台的节拍被它拖成 2 fps。处理办法已定：工具主动分流 + WebGL 后端，见 3.9 和 R1b。

---

## 3. 对底稿的更正（第 75 轮十份分步审查 + 三项实测的结论；优先于底稿）

### 3.1 改变前提的三条

1. **桌面版跑的是 vite dev server，不读 `dist/`**（`desktop/src-tauri/src/lib.rs:434` 用 sidecar 的 node 起 `vite --port 5210`；`desktop/scripts/prepare-runtime.mjs:257` 注释写明）。所以底稿第 110 版「成本探针以构建产物为准、分派只认 build 记录」作废：**分派用当前运行模式的记录**——`mode=dev|build` 拼进 `device` 串，dev 的应用只看 dev 记录，将来的在线浏览器模式（构建产物）只看 build 记录。
2. **`unknown` 卡不能一律判重**。真实项目的 10 张定制卡和所有带部件的组合卡片段都是 `unknown`；底稿规定它们「每个位置都判重、没有死素材、只能透明」，照做会让它们在播放和拖动时全部消失。改成：**`unknown` 一律按下层依赖卡（`belowDependent`）处理**——照测、照实测分派，判轻就活渲；判重用本地档快照，不上云、不进流。代码跟一处：`server/snapshot-store.mjs` 的 `snapshotTier` 对 `unknown` 的 stateful 卡回 `'local'`。
3. **判重门槛只看活渲耗时（用户 2026-09-22 同意）**。含生成快照的时间时 62 张里 37 张判重；只看活渲耗时，本机（28 核、30 fps）0 张判重、最贵的一张 6.9 ms，限 2 核、60 fps 时 3 张粒子卡判重（2.1(a)）——判重的是真正重的卡，而不是「生成快照慢」的卡。生成快照只在探针和预渲染时发生，活渲每拍并不做。`capped = stepMs > B`；生成快照的耗时拆开单独记（见 3.8），只用来排探针和预渲染的产能。

### 3.2 舞台与协议

- `render` 和 `setTime({ probe: true })` 在舞台侧都加角色闸门：不是 `back` 就回 `{ aborted: true, reason: 'role' }`。`render` 回包的 `reason` 全集是 `superseded | project | timeout | role | detached`；`detached`（iframe 换掉时客户端自己造的）= 丢弃回包、按新客户端重发。
- `stageId` 与角色无关：两个 iframe 的地址用 `?stage=1&id=A` / `id=B`，角色只经 `setRole`（今天传的是 `id=front`）。
- 舞台地址**第一次加载**就必须带 `Origin-Agent-Cluster: ?1`，补加无效；`window.originAgentCluster` 恒回 true，验收看 CDP 里有没有 `type: 'iframe'` 的 target。
- `stageBridge.ts` 加两个口子：`whenStageReady(role)`（加载遮罩靠它知道后台舞台就绪）、`pushProject(role, project, { reset })`（探针、整场景补跑、页面侧测量对后台舞台换项目一律走它，否则 `syncProject` 的基线会让下一次同步静默不发）。
- 对后台舞台的「掐断后不重发」例外按工作项判（`job: 'catchup'` 期间收到的 `'project'` 一律丢弃），不按 `settling` 标志判。
- `play` / `pause` 回包统一成 `{ ok: true, stoppedAt }` / `{ ok: true, passed: true }` / `{ ok: false, reason }`；循环已停时 `pause()` 立即回最后一拍。`setPlaying(on)` 只管素材层，不碰节拍循环。
- 节拍按绝对时刻排：`nextDue = playStart + n × 1000/fps`，干完活循环等真实帧直到 `nextDue − 1 ms`；慢帧把时间轴整体后移，不追。（一次 rAF 在 60 Hz 屏上只有 16.6 ms，30 fps 等不满一拍。）
- 播放到头的收尾：写 store + `setPlaying(false)` + `pause()` 拿 `stoppedAt` + `setTime(stoppedAt, { settle: true })`，否则最后一帧的重卡永远停在抑制态。
- 非 legacy 下 `Preview.tsx` 的 rAF 播放循环不启动，播放头由舞台的 `frame` 事件推进。
- 快照是**兄弟平面**，卡片组件照常挂着（底稿 A4 那句「替换组件」作废）。
- 素材层搬家清单补全：`VideoTrack` + `interface Slot` + 三个辅助函数进 `src/render/VideoTrack.tsx`；`targetTimeOf` / `filterOf` / `driveMedia` 一族和三个 `WeakMap` 进 `src/render/mediaDrive.ts`；`mediaSync.ts`（纯函数）搬到 `src/render/mediaSync.ts`。`FrameScene` 新 props 补上 `remountGen` / `settling` / `awaiting`。
- 子树虚拟时间追帧要改 `Stage` 里**四支**传 `t` 的地方（组合卡、图卡、`DirectCard`、普通卡），底稿漏了图卡。
- 已经落地、底稿还写成待办的：`advanceToAsync` 的 `yieldEvery`；`__pcRealNow` / `__pcRealSetTimeout` / `__pcRealRaf`（只差 `__pcRealDateNow` / `__pcRealSetInterval`）；一次 `rectsWithBounds` 取框；`rects()` 遍历全部包裹层；`getLayout` 含素材段。

### 3.3 探针、分派、降级

- 成本记录：舞台的 `probe` 事件只报测量值；`device`、`measuredAt`、`mode`、`demoted: false` 由父页补齐后整条 PUT（`costs-store` 是整条替换）。
- **只用 `demoted` 一面旗**：K6 降级 = 父页查出旧记录，整条 PUT `{ ...旧记录, capped: true, demoted: true }`（不写 `null`）；探针写回显式带 `demoted: false`；`pinnedHeavy` 留给将来的人工钉死，本任务不写它。分派时 `demoted` 和 `pinnedHeavy` 都当 `capped`。
- **`stepMs` 取稳健统计值、不取单次最大，并保留可调系数（用户 2026-09-22 定）**：2 核下同一张卡两次实测的单帧最差能差十几倍，越线的是偶发卡顿。`stepMs` = 每帧活渲耗时的第 `STEP_PERCENTILE`（缺省 0.9）百分位、至少 `STEP_MIN_SAMPLES`（缺省 16）帧，单次最大另记 `stepMaxMs` 只作诊断；判重比较式 `stepMs × COST_SCALE > B`（缺省 1），贪心权重同样乘。三个系数放 `src/render/pipelineTuning.mjs`，覆盖值在本机 `out/pipeline-tuning.json`、随成本记录一起发给两端，不改代码就能调；不动 pinned 的 70% 预算公式。细则见 `docs/plan/r2-r7-task.md` 的 K1 / K2。
- `catchUpMs` 只有一个定义：逐帧推进耗时之和、不含生成快照；探针每帧分「推进」「生成快照」两段计时；被预算截断时按已推帧的平均外推。**R1 的实测里 61 张推帧卡全部被截断**（旧截断判据是「这一次 `render` 累计墙钟超过 B」，预算里还含生成快照，只推得了 1～10 帧），`catchUpMs` 靠含挂载成本的前几帧外推、偏大 1.7～3.6 倍，5 张便宜卡因此被追帧上界错判成重。**已定（2026-09-22，pinned 渲染 5 已按弹窗确认的原文补写）**：探针分两趟——计时趟只推进不生成快照，按单帧（稳健值）判「太慢」，不按累计时间截断，只为长片段留 300 帧 / 500 ms 的封顶并用中位数外推；快照趟才生成快照，仍受一拍预算约束。细则见 `docs/plan/r2-r7-task.md` 的 K1。

### 3.4 数据面

- 就绪事件流（SSE）由页面**直连预渲染进程**，编辑器进程不代理。
- `wanted` 要改四处：服务端三处白名单（`mirror-store.mjs` 的 `setPlayhead`、`vite-plugin-mirror.ts` 的调用与转发体）+ 页面侧 `src/render/dataMirror.ts` 的播放头路径（播放中不推的闸门、`t` 不变就早退、400 ms 可重入防抖、`await` + 读 body 的 `post`）——`wanted` 单开一个 100 ms 固定节流、`keepalive`、不读响应的发送函数。
- 预渲染进程重启后重建就绪索引：扫盘只得到「键 → 区间」，`clipId` 要等项目到位后重算 card plan 反查（`control.clipId` ↔ `control.snapshotKey`）。
- 本地档快照那一趟保持 `snapshotOnly: false` + `fullFrame: true`（每帧多截一张丢弃的 PNG 是已知代价）；完整性判据 = `index.count === control.count`；`onSnapshot` / `snapshotFrames` 已落地，只差把帧集合收窄成缺的那些。
- 回滚开关 `?preview=legacy` **合并**舞台里已有的同名开关；「服务端旧调度器」= 预渲染进程保留的 `user` / `playback` lane 旧路径，legacy 页面照今天的方式发请求，服务端不另读开关。
- 播放热池的借还和 `stopPlayback()` **还在**（`server/frame-pipeline.mjs:1084-1107`），底稿说「已删除」是错的。

### 3.5 轨道流

- 每条流的会话加载**该流的隔离工程**（只留这条流的卡和它的源依赖链，素材轨和其它卡剔掉，时间不平移，背景透明），截图加 `clip` 矩形；否则整页截图会把重叠的别的卡截进来。
- 画面尺寸外扩到偶数宽高（`yuv420p` 要求）；色半区存预乘色（滤镜链开头加 `format=gbrap,premultiply=inplace=1`），着色器按预乘输出。
- 组流平面加 `pointer-events: none`、不参与实体框；组内被抑制的卡命中退回包裹层框。
- 解码帧预算按字节算（≤ 80 MB；上下拼合的 1080p 一帧约 6.3 MB，约 12 帧），不是按 24 帧。
- Node 端按 MP4 box 切 `init.mp4` / 分段、丢 `mfra`；`-c:v` 要写；各编码器的严格 GOP 参数分列；`FramePipeline` 给流会话单开 `leaseStreamBakery()` / `returnStreamBakery()`。
- 裁剪矩形第一版用包裹层框在整段 motion 下的包围盒（从项目数据算）；要不要改成实测实体框并集，由编码原型定。

### 3.6 共享 WebGL 渲染器

- **函数进不了 Worker**：契约拆两半——`CardDef.canvas = { kind, programId }`（可序列化）+ 同目录的独立模块 `<id>.gl.ts`（不 import React / DOM，导出 `uniforms` / `build` / `draw`）；Worker 是模块 Worker，经注册表 `src/render/gl/programs.ts`（`import.meta.glob`）按 `programId` 取；主线程退路用同一张表。
- 两条路线统一画法：上下文 `antialias: false`，每个图集画在多重采样 FBO 上，`blitFramebuffer` 解析到默认帧缓冲再裁位图（WebGL2 不允许往多重采样的绘制缓冲 blit）。探针 `gl-atlas-probe.mjs` 第一件事先验这条。
- 一拍的顺序写死：推时钟并提交 DOM → `beat` → 等 `done`（慢帧等在这里）→ 贴位图 → 等真实一帧 → 发 `frame`。导出页在 `__pcSetT` 触发的那次 `useLayoutEffect` 里发 `beat` 并领帧票。
- 三种契约共用 `textures?` 声明；`dom2d` 不带函数（卡自己在主线程画，只登记同拍落定）。
- **粒子卡不迁**（用户 2026-09-22 定，理由见第 7 节「已定的」）：它留在 `dom2d` 契约下自己在主线程画，只登记同拍落定；长粒子片段靠轨道流。
- 三张 three.js 用户卡不在仓库，在 `%LOCALAPPDATA%\PromptCut\runtime\app\src\cards\user\`；没迁移的旧 canvas 卡照旧能跑。
- `costs.device` 里的路线取**生效值**（项目选项优先，否则按低内存档）。
- 验收分路线写：路线 1 每个舞台文档恰好 1 个上下文、在 Worker 里；路线 2 舞台文档 0 个、父页 Worker 里 1 个。

### 3.7 在线浏览器模式里与渲染有关的一条

canvas 重卡**不活渲**（与 pinned 渲染 7、平台一节、不做清单冲突）：和 DOM 重卡同一规则，按拍换快照，装不下就透明，暂停追到活渲。

### 3.8 生成快照：命名与指标拆开（用户 2026-09-22 提出）

「冻结」这个词以后不用了：它把两条原理、瓶颈、产物大小都不同的技术路线说成了一件事，而且和「被抑制的卡 `t` 冻住」撞词。文档里改叫**生成快照**，其中两步分别叫**样式内联**和**画布栅格化**。

- **代码结构**（R1 一起做，反正 R1 本来就要换 `freezeCode` 的哈希、作废全部旧快照）：`src/render/snapshotFreeze.ts` 改名 `src/render/createSnapshot.ts`，导出 `createSnapshot(root)`；里面按顺序调五个独立函数——`cloneScene`（复制 DOM）→ `inlineDOMStyles`（读计算样式、按差异口径写进 `style`；瓶颈是元素数 × 属性数）→ `rasterizeCanvas`（读像素、压成图片、写实体框；瓶颈是画布面积和编码器）→ `stripMedia`（素材层只留占位属性）→ `serializeScene`（`outerHTML`、整场景的 id 改名、逐控件取包裹层 `innerHTML`）。`inlineDOMStyles` 和 `rasterizeCanvas` 各自一个文件（`src/render/snapshot/inlineStyles.ts`、`src/render/snapshot/rasterizeCanvas.ts`），互不 import；worktree 里那份差异内联的逻辑（`ensureBaselines` / `animatedProps` / `forcedProps` / `buildStyle`）整体归 `inlineStyles.ts`。
- **跟着改名的地方**（b5c65dc 以来约 20 个文件引用旧名）：页面协议 `window.__bfFreeze` → `window.__pcCreateSnapshot`（`src/StageView.tsx`、`src/ExportView.tsx`、`src/kernel/clock.ts` 的类型、`server/bakery/bake.mjs` 的两处 `page.evaluate`、`docs/bake-page-protocol.md` 的清单、`scripts/verify-bake-protocol.mjs` 和它的测试）；`freezeCode` → `snapshotCode`（`server/frame-code.mjs`、`server/card-identity.mjs`、`server/card-cache.mjs`、`card-snapshot-identity.test.mjs`；`FREEZE_FILES` 清单同步新文件）；类型 `FrozenScene` / `FrozenControl` → `SceneSnapshot` / `ControlSnapshot`；四个探针脚本。**共享键里那个字段的名字也跟着换**，键值本来就要变，不多付一次失效。
- **探针分开上报**：成本记录从一个 `frameMs` 拆成四个数——`stepMs`（活渲单帧最差，**唯一进判重的数**）、`inlineMs`（样式内联单帧最差）、`rasterMs`（画布栅格化单帧最差，没有画布的卡为 0）、`serializeMs`（序列化单帧最差）；`catchUpMs` 照 3.3 只算活渲。`frameMs` 字段删掉，不留兼容（`out/card-costs.json` 重测一遍就有）。舞台的 `probe` 事件、`CardCostRecord` 类型、`docs/snapshot-size-audit.md` 的「冻结 ms」一列同步拆。哪类卡超标一眼可见：`inlineMs` 高 = DOM 太复杂（lottie 的两千多个节点），`rasterMs` 高 = 画布太大。
- **顺带修一个量法问题**（`reply_to_users_goal.md` 第 9 条）：带 `probe: true` 的 `setTime` 会先等一次真实 rAF 再生成快照，随机访问卡量出来的数因此至少含一个垂直同步（约 17 ms）。四个数都只量各自那一段，rAF 等待不计入任何一个。
- **给以后留的口子（用户 2026-09-22：画布位图换 webp 先搁置，继续用 PNG；没有新的指示不要做）**：两步拆开之后，`rasterizeCanvas` 可以单独换成 webp、单独改成异步（`convertToBlob`），不牵动样式内联；到那一步 `createSnapshot` 会变成 async，页面协议的调用方（`bake.mjs` 的 `page.evaluate` 本来就 await）不用改，舞台里同步调用它的两处（`StageView.tsx` 的探针分支）到时改 await。共享 WebGL 渲染器（R9）落地后，画布卡的像素来自 Worker 交回的位图，`rasterizeCanvas` 是唯一要改的文件。
- **产能预算怎么用这三个数**：预渲染一帧的成本 ≈ `stepMs + inlineMs + rasterMs + serializeMs`；探针阶段「整段推完要多久」按它估，超过遮罩可接受的时长就只测不存（探针推过的帧不当预渲染存），把生成快照留给后台预渲染。

### 3.9 像素映射：工具主动分流（用户 2026-09-22 定）

`create_pixel_map` / `update_pixel_map` 不再无条件接单。落库之前先给定义分类（新纯函数 `classifyPixelMap(def)`，放 `src/kernel/pixelMap.mjs`，浏览器和 Node 共用、可单测），按类别走三条路：

| 类别 | 判据（都能从已编译的表达式里静态看出来） | 走哪条路 | 工具怎么回 |
|---|---|---|---|
| A 通道曲线 / 线性混色 / 按亮度的渐变映射 | `where` 恒为 1（不引用 `r g b a luma x y t`）；`to` 是 `expr` 且每个通道只依赖自己（`r→f(r)`）或是 `r g b` 的线性组合；或 `colorSequence` 只按 `luma` 取色 | **CSS / SVG 滤镜**：`feComponentTransfer type="table"`（把 f 在 33 个点上取样）、`feColorMatrix` | **拒绝并给出等价物**：抛错，错误体里带一份可以直接传给 `create_filter` 的 `ops`（见下），Agent 照着重发即可 |
| B 要逐像素判断的 | `where` 引用颜色做选区（抠色）、引用 `x / y / t`；`to` 是 `transparent`、另一段素材、或通道互相依赖的非线性表达式 | **WebGL**：表达式翻译成 GLSL 片元着色器（解析器的函数集 `sin cos abs min max pow clamp lerp step smoothstep` 与 GLSL 一一对应，`lerp → mix`），视频帧当纹理 | 接单，回包带 `backend: 'webgl'` |
| C 翻译不了的 | 出现 GLSL 没有对应物的写法 | 无 | 拒绝，说明哪一处翻译不了 |

- **滤镜的两种新 op 已落地（`7f10ebe`）**：`src/kernel/filters.mjs` 加了 `curves`（每通道 2～33 点的取样表、线性插值，`rgb` 是三通道简写）和 `matrix`（行优先 3×3，外加混色截断之后再加的 `offset`）；预览走 SVG 滤镜（`svgFilterMarkup` / `ensureSvgFilter`，定义按内容哈希去重、收在 `body` 末尾一个 0×0 的 `<svg>` 里，不进 HTML 快照），导出走 `lutrgb`（`tableLutExpr`：不含逗号的分段线性表达式）和 `colorchannelmixer`，标了 `fixed` 的步骤 `sendcmd` 不逐帧重发；一个滤镜最多 4 步 `curves`；`create_filter` 的描述和 schema、`list_filters` 的回包、类型声明同步；`server/export-compose.mjs` 在滤镜图超过 12000 字符时改用 `-/filter_complex <文件>`（本机和随包的 ffmpeg 都是 9.0.1，`-filter_complex_script` 在 9 里已经没了，实测过）。**实测预览与导出的像素差**（同一张图，Chrome 截图对 ffmpeg 输出）：单步 `curves` / `matrix` 最大差 1 级、带 `offset` 的 2 级；三步叠加（含原有的 `contrast`）最大 5 级、0.3% 的通道差超过 2 级。`tsc` 零错误，`npm test` 1466 / 1465 通过 / 0 失败 / 1 跳过（新增 4 条单测；`filterTools.test.mjs` 里钉死「8 种 kind」的那条按新口径改成 10 种）。
- **B 类的 WebGL 后端就在本计划里做完（用户 2026-09-22 定：不走「先拒绝」的过渡）**：新模块 `src/render/pixelMapGl.ts`——每个文档一个 WebGL2 上下文（离屏 canvas），按定义哈希缓存编译好的 program；`compilePixelMapGlsl(def)`（放 `src/kernel/pixelMap.mjs`，纯函数可单测）把 `where` / `to.expr` / 颜色序列翻译成片元着色器，变量 `r g b a luma x y t` 对应 uniform / 纹理取样；视频帧 `texImage2D` 进纹理，目标素材是第二张纹理；画完 `drawImage` 到素材层自己的 `<canvas>`。`PixelMappedMedia` 改调它，**逐像素的 CPU 循环整体删除、不留退路**（实测 1080p 每帧 416～483 ms）。预览、导出页、`see_frames` 三处共用这一份，所以导出的像素基线会变一次：验收用旧 CPU 实现在同一帧上出对照图，逐像素差 ≤ 2 级（`mapRgba` 保留为单测和对照用的参考实现，不再进任何渲染路径）。以后共享 WebGL 渲染器（R9）落地时，把这个上下文并进去即可，契约不变。
- 先后：两种新 op 已做；`classifyPixelMap` + A 类拒绝并回等价 `ops`、B 类的 WebGL 后端、C 类拒绝，都在 R1b 里做完，**不等 R9**；R3 把素材层搬进舞台之前 R1b 必须完成。
- 工具描述（`server/tools/effects.mjs` 的 `create_pixel_map`）同步改：开头写明「整帧调色请用 create_filter 的 curves / matrix；这个工具只给要逐像素选区的活」，让 Agent 多数时候一开始就选对，少走一次被拒。

---

## 4. 路径对照（解耦之后；底稿里的旧路径一律按这张表换）

| 底稿里的写法 | 现在 |
|---|---|
| `src/kernel/Stage.tsx`、`src/kernel/PartTree.tsx` | `src/render/Stage.tsx`、`src/render/PartTree.tsx` |
| `src/render/frameMode.mjs` | `src/kernel/frameMode.mjs` |
| `src/editor/dataMirror.ts`、`src/editor/prerender.ts`、`src/editor/left/contentBox.ts` | `src/render/` 下同名文件 |
| `src/parts/types.ts`、`src/parts/registry.ts` | `src/kernel/partTypes.ts`、`src/kernel/partRegistry.ts` |
| `right/index.tsx` 的 `frameLayoutOf` / `contentLayoutOf` / `measureContentBoxes` | `src/mcp/common.ts:90` / `:97` / `:42` |
| `mcpExecutor.ts` 里按工具名的 `else if` 分支 | `src/mcp/routes.mjs` 的路由表（`get_layout` 的 `awaited` 在表里） |
| `scripts/export-frames.mjs` 的 `bakeFrames` / `step` / `warmUp` / `__pcSetFrameWindow` 调用 / `onSnapshot` / `snapshotOnly` 守卫 / `onFrame` | `server/bakery/bake.mjs:28` / `:125` / `:189` / `:81-82` / `:266-270` / `:281` / `:309` |
| `export-frames.mjs` 的 `newSession` / `openBakery` | `server/bakery/chrome.mjs:162` / `:298` |
| `scripts/capture-snapshot.mjs`、`capture-frame.mjs`、`frame-media.mjs`、`frame-ready.mjs` | `server/bakery/` 下同名文件 |
| `findFfmpeg` | `server/bakery/ffmpeg.mjs` |
| `vite-plugin-vision.ts` 的 `ensureGif` | `server/vision/routes.ts:198` |
| `vite-plugin-vision.ts` 的 `enqueue`（优先级队列） | `server/vision/render-queue.ts:115` |
| `vite-plugin-vision.ts` 里写死 `lane: 'agent'` 的那一支 | `server/vision/render.ts:73` |
| 常驻 Chrome worker 池 | `server/vision/worker-pool.ts` |
| `frameCode` 的 `CAPTURE_FILES` / `FREEZE_FILES` | `server/frame-code.mjs:19` / `:70`（内容已指向 `server/bakery/*`） |

没动的：`src/StageView.tsx`、`src/ExportView.tsx`、`src/editor/Preview.tsx`、`src/render/{stageRpc,snapshotFreeze,snapshotRename,solid,FrameScene,stageClock,pinAnimations,frameWindow,changedClips,cardCostKey}`、`src/editor/stageBridge.ts`、`server/{frame-pipeline,card-identity,card-cache,snapshot-store,mirror-store,costs-store}.mjs`、`server/vite-plugin-{mirror,costs,frames,media,cards,prerender,ai}.ts`。其中 `server/frame-pipeline.mjs`（1155 行）是后面改动最集中的文件，行号以当前文件为准：`acquireUser:256`、`fillCardControls:799`、`isolatedCardProject:855`、`rasterPrefix:893`、`layout:931`、`updatePlayback:1049`、`stopPlayback:1107`。

pinned 架构 4 / 5 的落点因为 vision 拆分而变清楚了：**Agent 专用 Chrome 的优先通道改 `worker-pool.ts` 的取任务逻辑；AI 菜单操作预览的插队改 `render-queue.ts` 的入队位置**，两处互不牵连。

---

## 5. 重整后的步骤（只含渲染管线；每步单独可验收、可回滚）

### R0 清账（半天）
1. （已做，`5157f91`）主工作区的探针改动和 `docs/g0-a-webview2-probe.md` 提交。
2. `scripts/verify-unified-frames.mjs`：脚本本身两处过期已改（`eec7a08`）。改完剩下的真问题查清并修了一半——**根因一（已修，合并提交见 git log「生成快照前先让 Motion 的 JS 帧循环跑一拍」）**：在 begin-frame 控制下，Motion 自己的 JS 帧循环（spring、MotionValue）只在真截图时才推进；整帧导出每帧截图所以对，HTML 快照在截图之前生成、纯采样那一趟一张图都不截，于是**快照里所有 JS 帧循环驱动的动画整段冻在第 1 帧**（30 fps 下 `punch-pill` 的药丸整段小 33%）。修法是生成快照前先画一拍把图丢掉；导出 60 / 60 帧逐字节不变；代价是快照趟每帧多约 20～30 ms（1080p）；`bake.mjs` 在指纹清单里，旧共享快照全部失效（本来就是错的）。差异从 65607 个通道缩到 27080 个、超过 2 级的只剩 15 个。**根因二（未修）**：快照重放时重新排版丢了 1/64 px（`getComputedStyle().width` 只给三位小数，316.15625 → 316.140625），`blur(32px)` 对此极敏感、能差出 255 级；无滤镜的卡最大差 3。修它要改 `inlineStyles.ts` 的几何内联口径、作废全部共享快照，三个修法和代价在 `docs/plan/` 之外的排查报告里（scratchpad `replay-mismatch-report.md`），R7 露出舞台前定。在此之前这条脚本仍以最后一条断言不过为已知状态。
3. `result_decouple.md` 6.2 的遗留：`vite.config.ts:76-80` 的 `server.watch.ignored` **已经有** `**/out/**`，报告说冷启动仍被 `out/frame-library/` 拖慢——先量一次仓库根 dev server 的冷启动，确认慢在哪（监听器初扫还是别处）再动；最省事的兜底是给 `frame-library` 加 GC（原 F1）。
4. （已做）给 `AGY-TASK-cloud-doc-and-write-race.md` 文首加一句「渲染管线部分以 `render_pipeline_restructure.md` 为准」。

### R1 差异样式内联收尾（原 3b 步）——已完成，合并提交 `e67390e`（2026-09-22）
**结果**：`tsc` 零错误，`npm test` 1472 / 1471 通过 / 0 失败 / 1 跳过；新旧快照重放逐像素比对 8 / 8 相同（`lottie-bodymovin` / `growth-curve` / `odometer` / `scene-3d` 各两帧，探针 `scripts/probes/snapshot-diff-compare.mjs`）；导出 240 / 240 帧逐字节相同。单帧快照 max 23107 → 915 KB，超 300 KB 的 DOM 卡只剩 `lottie-bodymovin`（915 KB）和 `lottie-navidad`（855 KB），DOM 卡 p90 185.8 KB（不算 lottie 47.8 KB），canvas 位图 p90 / max 466 / 628 KB。成本探针 62 张全部测通并落盘（dev 模式，`demoted: false`）：30 fps 下 `stepMs` p50 / p90 / max = 1.3 / 2.7 / 6.6 ms、0 张判重；2 核 60 fps 下 2.4 / 4.9 / 21.2 ms、3 张越线。`inlineMs` p50 / p90 / max = 6.1 / 23 / 367 ms，`rasterMs` 0.1 / 36 / 94 ms，`serializeMs` 0.8 / 1.9 / 149 ms。**实现时补定的三条**：`direct` 卡也有 `stepMs`（在等 rAF 之前取），类型收紧成 `number`；`cloneScene` 的时间并进 `inlineMs`、`stripMedia` 并进 `serializeMs`；`SNAPSHOT_FILES` 随拆出来的三个模块一起加（`solid.ts` 照旧不进）。**没做**：`configurePreviewServer` 和 build 模式那一趟（光补四个插件跑不起来，`dist/` 里没有 `/src/**`，还要一套探针 kit；留给在线浏览器模式）。**遗留给 R0**：`scripts/verify-unified-frames.mjs` 在 R1 之前的 `7f10ebe` 上就不过（`:46` 的 `'mov' !== 'rendered'`，放宽后 `:55` 导出与 `see_frames` 不等），不是 R1 弄坏的。以下是动工前写的范围，留作记录。
- 把 worktree 里的改动挪到当前 main 上重做一遍（它基于 `b5c65dc`，`frame-code.mjs` 和探针脚本引用的路径都已搬家，直接合并会冲突；`src/render/snapshotFreeze.ts` 和新模块 `freezeStyleProps.mjs` 可以原样取）。
- **先按 3.8 改名拆文件**（`createSnapshot` / `inlineDOMStyles` / `rasterizeCanvas`，页面协议和 `snapshotCode` 一起改），再把差异内联的逻辑放进 `inlineStyles.ts`。
- 探针和成本记录按 3.8 拆成 `stepMs` / `inlineMs` / `rasterMs` / `serializeMs`，判重只看 `stepMs`。
- 比对口径照底稿第 111 版 A2(8)：继承属性和父元素的计算值比、布局解析值属性一律内联、其余和同标签基线比；基线按 `namespaceURI + tagName + themeId` 缓存，SVG 用 `createElementNS`；canvas 换 `<img>` 按 IMG 的基线另算。
- 成本记录：`mode` 拼进 `device`；探针写回显式 `demoted: false`；类型声明补 `mode`。
- **验收（那个 worktree 没交报告，全部重跑）**：`scripts/verify-unified-frames.mjs` 通过；`lottie-bodymovin` / `growth-curve` / `odometer` / `scene-3d` 内联前后位图逐像素比对；导出逐字节基线不变；DOM 卡 p90 ≤ 300 KB、canvas 卡位图 ≤ 1 MB；`npm test`、`tsc`。
- 两张仍超 300 KB 的 `lottie-*`：不处理（见第 7 节「已定的」）。
- `configurePreviewServer` 那部分降级：不再是后续步骤的准入，做完了就留着给在线浏览器模式用。

### R1b 像素映射分流与 GPU 后端——已完成，合并提交 `dd58cb5`（2026-09-22）
**结果**（合并后我在 main 上重跑过）：`tsc` 零错误，`npm test` 1481 / 1480 通过 / 0 失败 / 1 跳过；`node scripts/probes/pixelmap-gl-probe.mjs`（真 GPU：RTX 3080 / D3D11）八个用例里七个 GPU 对 CPU 最大差 ≤ 1 级（1080p，829 万个通道值），1080p 视频单帧主线程提交 p50 0.2 ms、GPU 计时查询 0.016 ms（CPU 旧实现 416～483 ms）；报告另称图片素材挂抠色映射的真实导出对 `mapRgba` 最大差 0 级（这一项我没重跑）。**一条已知的超标**：continuous 颜色序列有 13 / 207 万像素差 255 级——这些像素到两个 `from` 色精确等距，`mapRgba` 让 `Math.hypot` 的末位舍入决定取哪个，着色器稳定取靠前那个；不改。**实现时对 3.9 的更正**：① `colorSequence` 一律判 B（它按最近邻取色，取样成表差两百多级，A 类那条「只按 luma 取色」的判据永远不成立）；② A 类除了看表达式形状，还要把等价 `ops` 在 0～255 全值域上逐值核对，差 > 1 级就退回 B（`step()` 和矩阵的截断顺序会漏过形状判据）；③ `curves` / `matrix` 改不了 alpha，A 类的等价只在不透明素材上成立，回包带 `alphaNote`；④ C 类不是「GLSL 没有对应函数」（白名单函数一个不缺），真正翻译不了的是负底数配非整数常量指数的乘方；⑤ 画完不用 `drawImage`，用 `transferToImageBitmap` + `bitmaprenderer`（`drawImage` 的预乘来回会吃掉低 alpha，抠色正是产生低 alpha 的活），素材层那张画布因此不能再有 2D 上下文；⑥ 着色器里的 x / y 从 `gl_FragCoord` 算、行从上往下；⑦ 验收里「1080p 播放 0 长任务」量不了（编辑器预览今天不画像素映射），改成「单帧主线程 < 1 ms」。**遗留**：`normalizePixelMapDef` 忽略 `colorSequence.mode`（只认顶层 `mode`，工具描述已写明），要不要改行为另开一条。以下是动工前写的范围，留作记录。
已做：滤镜新增 `curves` / `matrix` 两种 op 与 SVG 注入（见 3.9）。待做：`classifyPixelMap`、`create_pixel_map` / `update_pixel_map` 对 A 类的拒绝与等价 `ops` 回包、`compilePixelMapGlsl` + `src/render/pixelMapGl.ts`、删掉 CPU 逐像素循环、工具描述。验收：调色类定义被拒且回包里的 `ops` 直接可用，两者画面逐像素对比差 ≤ 2 / 255；1080p 播放 0 长任务；抠色类定义按 3.9 处理。

### R2 双舞台与协议补齐（不改用户可见行为；legacy 默认开）
第二个舞台 iframe、两个舞台端口、跨源 + OAC 头、`stageId` A / B、角色闸门、`whenStageReady` / `pushProject`、`play` / `pause` / 六种事件的真实实现、`RenderAborted` 补全、单飞队列（补跑 > 页面侧测量 > 探针）。验收：`stage-rpc-probe.mjs` 在跨源下复跑；A 舞台死循环 2.5 秒时父页最坏帧间隔 < 20 ms。

### R3 舞台内容（E7 + E4b）
素材层搬进舞台（3.2 的搬家清单）、`FrameScene` 的 live 变体与全部新 props、快照 / 抑制 / 等待三种类与样式表、四种计时方式虚拟化。验收：`placeholder` 模式全长导出逐字节不变；快照挂上、摘掉、换帧时卡片组件实例不变。

### R4 探针与分派（K1 常驻半、K2）
加载遮罩下逐张测（靠 `whenStageReady('back')`）、两趟布尔探针（`vtOk` / `seekOk`）、`planPipelines`（两端同一份纯函数）、成本记录链（3.3、3.8）。门槛 = `stepMs > B`。 验收：底稿 K 节的四个算例；`unknown` 卡照常参加贪心。

### R5 播放与追帧（K3、K4、K5、K6）
轻卡三条跳转路、节拍器（3.2 的绝对时刻排程）、两路追帧与角色互换、降级闭环。验收：60 Hz 屏上 24 / 25 / 30 / 60 fps 的 `frame` 间隔；暂停后重卡追到活渲；播放到头后最后一帧是活渲。

### R6 数据面（C2～C5、J3、F5、D5 的服务端部分）
锚帧优先、就绪索引与 SSE 直连、`wanted` 四处、快照来源接口、重启恢复、`interactive` 参数与 `streamPool`。验收：冷缓存拖动贴区间起点快照；杀掉预渲染进程再拖，索引按键重建。

### R7 露出舞台（原子切换）
摘掉舞台 iframe 的 `opacity: 0`、删主文档的 `mediaRects`、非 legacy 下停掉 `Preview` 的 rAF 循环、`?preview=legacy` 回滚。R2～R6 都在同一分支上、都在 legacy 后面，这一步才翻开关。验收：底稿「D5 + E + K」那一条总验收 + 零卡顿（主文档长任务为 0）。

### R8 轨道流（G）
先做编码原型（吞吐、编码耗时、alpha 误差、严格 GOP 参数、裁剪矩形取法），再按 3.5 实现，挂 `streams` 开关。**是否现在做，见第 7 节第 1 条。**

### R9 共享 WebGL 渲染器（M）
先 `gl-atlas-probe.mjs`，再按 3.6 做两条路线，迁移 `scene-3d` 和三张用户卡。

依赖：R1 → R4（探针数据）；R2 → R3 → R5；R4 → R5；R6 可与 R3～R5 并行；R7 在 R2～R6 之后；R8 依赖 R5、R6；R9 依赖 R3、R5。

---

### 执行记录（用户 2026-09-22：「直接按照 plan 一口气做完」）

做法：我在 main 上统筹，可解耦的子任务派 Opus 在子 worktree 里做，每个回来都由我审查、重跑类型检查和全量测试后 `--no-ff` 合并。分册的独立审查不另派——实现的人就是第一批逐句对照代码读任务书的人，他们报上来的「任务书要改的句子」由我折回分册。R2～R6 全部藏在回滚开关后面（R2 起非 legacy 要显式打开），R7 才翻默认值。

| 波次 | 任务 | 状态 |
|---|---|---|
| 前置 | R1、R1b、用词清理、分册抽取、轨道流编码原型 | 已合并 |
| 第一波（互不碰文件） | R2 双舞台与协议；R4a 分派纯函数 + 可调系数 + 离线探针两趟；R6 服务端数据面 | 三项都已合并（main 上 `tsc` 零错误、`npm test` 1572 / 1571 / 0 失败）。R6 留了一个接线：`server/prerender-set.mjs` 的 `prerenderSetOf` 还是按声明兜底，换成 `planPipelines(...).prerenderSet` 要先让预渲染进程拿到成本记录和系数，放在 R5 一起做 |
| 第二波 | R3 舞台内容；R4b `ProbeGate` 与常驻探针；另加一项排查（快照重放里 Motion 的 JS 帧循环动画整段冻住，已修） | 三项都已合并（`npm test` 1625 / 1624 / 0 失败） |
| 第三波 | R5 播放与追帧（K3～K6、C4 消费方、预渲染进程接上 `planPipelines`） | 已合并（六块全做完；`npm test` 1632 / 1631 / 0 失败）。留给 R7：要预渲染进程才验得了的三条 K6 闭环、有头浏览器下的帧间隔 |
| 第四波 | R7 露出舞台（原子切换）+ 总验收 + 桌面壳两处配合 | 2026-09-22 派出。要求：总验收有一条过不了就不翻开关 |
| 之后 | R8 轨道流；R9 共享 WebGL 渲染器；云端那一半 | |

## 6. 不在本文范围、但已经有审查结论的部分

第 75 轮对云端 / 文档服务那一半（原第 5～10 步）查出的问题和我的处理意见，逐条记在 `docs/plan/r75/fold-notes.md`（十份报告原文在同一目录），要点：第 5、6 步顺序倒置（卡片源码同步和快照清单要用本机文档服务，应挪到第 6 步）；内容库要补一套 WebSocket 消息；素材上传统一走分片并补「已收分片」查询；`uploaded` 要按两档分开记；B4 的期望版本只约束 Agent 写工具；模式切换时 `projectRev` 不能归零；拆分模式下 AI 菜单的动图预览不能被路由进 Agent 专用 Chrome。**素材两档（pinned 架构 1，2026-09-22 定稿）**：和底稿第 5 步一致——小版由导入方本机用 ffmpeg 转出（云端小规模运行，没有转码能力），小版和原片都分片上传；要补的只有上传队列的顺序：**逐个素材，同一个素材先小版后原片，两份都 `uploaded` 才轮到下一个素材**（底稿是「所有素材的小版先传、原片后传」，要改）；`uploaded` 仍按两档分开记（第 75 轮的结论不变）；拉取方有小版先拉小版、原片落盘后换档，没有小版直接拉原片；换档前仍要过「原片能不能在浏览器里播放」那一关，放不了的预览一直停在小版，导出才用原片；在线浏览器模式**能拉小版、但产不出小版**：拉取侧和桌面版完全一样（云端有小版就先拉小版）；只有在浏览器里导入的素材，因为没有本机 ffmpeg，上传时只有原片一档，别人拉它时按 pinned「还没有小版就直接拉原片」走。用户 2026-09-22 定：现在就这样，不补；「桌面版发现云端缺小版就补转一份传上去」记在 `future_planning.md` 第 1 条，以后再做；不在页面里用 WebCodecs 转。**这一节的内容已全部折进 `docs/plan/cloud-task.md`**（2026-09-22），以它为准；它文末列了 6 个动工前要定的问题。

---

## 7. 需要你拍板的

**还没定的**

1. R2～R7、R8、R9、云端四份分册都还没经过独立审查：R2 动工前要不要派、派谁。
2. `docs/plan/cloud-task.md` 文末的 6 个问题（A3b 要不要整体挪到第 6 步、原片可播放性怎么探、`uploaded` 在本地模式的取值、流的键名对齐、在线重型控件渲染服务的鉴权与上限、第 8 步归哪一半）——云端那一半动工前定。
3. R8 / R9 分册留的三个细节（稀疏分段的步长是否只能取 15 的因数、G4 里生产侧 `frameMs` 要不要换名、M2 一处长句的读法）——各自动工时定。

**已定的（2026-09-22，pinned 的对应条目都已按弹窗确认的原文改写）**

- 判重门槛只看活渲耗时；生成快照的耗时拆成样式内联 / 画布栅格化 / 序列化三个数单独上报（pinned 渲染 5；本文 3.1 第 3 条、3.8）。
- 素材两档：小版由上传方本机转码、云端不转码；逐个素材先小版后原片，两份都传完才下一个；拉取时有小版先拉小版再换原片（pinned 架构 1；本文第 6 节）。「单词操作块」改成了「单次操作块」。
- 同一个舞台的所有 canvas 卡共用一个 WebGL 上下文和一个 Worker，放在哪见两条路线，导出页自己开一个（pinned 渲染 10；本文 3.6）。
- 两张仍超 300 KB 的 lottie 卡不做专门处理：它们不判重、不进预渲染集合、根本不生成快照；原来的二选一作废，换成一条通用兜底——任何超限的快照帧不进就绪索引、不投递，那一层按缺料处理并记诊断（`docs/plan/r2-r7-task.md` 的 A3c）。
- **粒子卡不迁进共享 WebGL 渲染器的 Worker**（R9 的迁移名单里没有它）：54 张粒子卡共用一份 tsParticles（2D 画布 + 主线程库，`dom2d` 契约），迁 = 用 WebGL 重写粒子引擎、54 份配置逐张对画面、导出基线重立；整库搬进 Worker 也不行（它依赖 DOM，项目还把它的离屏画布机制短路掉了，`particles.tsx` 的 `withRealCanvas`）；而且迁了也解决不了真正的问题——Worker 里的粒子一样要从头逐步推。它的稳定活渲成本只有 1.4～3.8 ms，短片段本来就判轻；**长粒子片段（超过约 8 秒）按追帧上界判重，交给轨道流**。「模拟状态检查点」仍在不做清单里。
- 轨道流的编码原型现在就做、不等 R7：用户明确要面向低配机、60 fps 下保证流畅。原型（原 G0-b：解码吞吐、编码耗时与 alpha 误差、严格 GOP 参数、fMP4 切分、裁剪矩形取法）已派 Opus 在子 worktree 里做，只产出探针、数据和报告，不碰主线；R8 的实现仍排在 R7 之后。
- 代码注释和文档里的禁用旧词做一次全仓清理（只动注释和文档，字符串字面量只列不改），已派出去，单独合并、不混进 R2～R7。
- 轨道流的 `streams` 开关**默认开、生产限速**：只在空闲时生产、同时一条、用户操作时让路；裁剪矩形用实测实体框；先稀疏（`stride = 3`）后补密；流没录好时界面要有「预渲染中」的提示（样式 R8 动工时定）。原型的三条硬结论已写进 R8 分册：`out_range` 必须是 `tv`、预乘色配着色器钳位、单个解码器同时持有 ≤ 8 帧。
- 旧任务书整体舍弃，有价值的内容搬进 `docs/plan/` 下的分册（见文首的表）。
- 像素映射由工具主动分流：整帧调色走 `create_filter` 的 `curves` / `matrix`，要逐像素的走 WebGL 后端，R1b 里做完，不设「先拒绝」的过渡期（本文 3.9）。
