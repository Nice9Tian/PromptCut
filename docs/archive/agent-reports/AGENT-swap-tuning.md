# AGENT 报告：claude/swap-tuning

分支 `claude/swap-tuning`，工作区 `.worktrees/swap-tuning`，起点 main `98e042d0`。端口段 5700～5709。机器：笔记本（AMD Ryzen 7 6800H，16 逻辑核），同机另有两个子 Agent 在跑测试与探针。

任务：
- **任务 A**：`SWAP_MS`（在线普通档播放时换一层快照的每拍成本，`src/render/beatSwap.mjs`）按卡种实测，改成按层取值，`fitBeatSwaps` 按各层自己的代价累加装箱；给 `mechanism/rendering.md`「兜底顺序」的修改前 / 修改后建议。
- **任务 C**：区分「连续播放中自然进场」与「从卡中间开始播放」：前者不发起播放态互换，后者照旧按估时决定（`AGENT-pause-precise.md`「没做的与观察」第 1 条；`REPORT-C10.md` 第 6 节第 29 行记的维护项）。

代号：播放态互换（K3(b)）= 播放中一张判轻、(b) 档、`vtOk = false` 的卡由后台舞台整场景补跑到「播放头 + 估时」的目标拍后与可见舞台互换（`stageSwap.ts` 的 `runPlayingSwap`）；暂停态第二路（K5 第二路）= 停下时整场景补跑到当前时刻再互换（`runSettleSwap`）。(b) 档 = 整段补跑超过一拍预算、推帧数在上界内的轻卡（`pipelinePlan.mjs` 的 `catchup-b`）。`vtOk` = 这张卡能不能用自己子树的虚拟时间推进（不能的只认全局时钟）。C10-A4 = C10 契约第 20 节验收第 4 条（装不下的层显示占位、暂停后追到精确活渲）。G0-R = 改了预览与导出路径时加跑的回归（导出确定性、像素基线、快照重放），本任务由主会话在合流时跑。

状态：**两条都做完**，单测、类型检查、全量测试（3988 / 3986 过 / 2 跳过）、两个代码指纹不变、兜底顺序探针两次过、`c10-browser-probe --only-a4` 过（第 3 轮）。带耗时的数都在忙的笔记本上量，最终判定由主会话在空闲机器上做。

需要主会话定的事：
1. 合不合并本分支；
2. 语义 `mechanism/rendering.md` 的两处修改（见「语义与契约的更正建议」第 1、2 条，都是三级）写不写；
3. 契约里新加的两条〔裁〕（第 6 节末句、第 18 节末条）认不认；
4. 探针卡加 `padNodes`、`c10-browser-probe` 的附加重层改用它（A4 的场景随换帧成本变了，见「验证」）认不认。

## 提交

| 提交 | 内容 |
|---|---|
| `6e05bf3a` | 建报告 |
| `9ce1a170` | 任务 C：`src/render/playEntry.mjs`（起点与连续性的纯状态机）、`stageSwap.ts` 的 `notePlayRunStart` / `notePlayFrame` / `playingSwapTargets`、`Preview.tsx` 接线；单测 ST-C-01～16 |
| `38a3e43a`、`b32ea63d` | 任务 C 的探针检查（`c10-browser-probe.mjs`）；诊断留完整 clipId 与最近 20 次发起判断 |
| `df49051a`、`d0fc1ae2` | 任务 A 的测量脚本 `scripts/probes/swap-cost-probe.mjs` |
| `8e1597cf` | 任务 A：`SWAP_MS_BY_KIND`、`swapKindOf`、`swapCostOf`、`fitBeatSwaps` 的 `costOf`；`planPipelines` 的 `deadMs` 可按片段取；`src/editor/swapCost.ts`；单测 ST-A-01～07 |
| `fc76b668` | 任务 A：已知快照大小时按大小估（`SWAP_COST_MODEL`、`swapCostOfSize`，`snapshotFeed.ts` 记每层最近一次投递的大小）；单测 ST-A-08、09 |
| `dcc4c1c0` | 按实测定表里的数 |
| `808ff137` | C10 契约第 6 节、第 18 节记两条〔裁〕 |
| `33bdd500` | 探针卡 `probe-slow` / `probe-slow-stepped` 加可选参数 `padNodes`（缺省 0，画面与快照不变）；`c10-browser-probe` 的 8 张附加重层用 `padNodes: 60` 把快照做到约 70 KB；`swap-cost-probe` 加 `--params` |
| （本次） | 报告 |

## 任务 A：换一层快照的代价

### 测法（`scripts/probes/swap-cost-probe.mjs`，文件头有完整说明）

- 宿主页里两个同源舞台：B（后台，`setRole('back', { job: 'probe' })`）按卡生成 24 个时刻的快照（`__pcCreateSnapshot().controls[0].html`，与投递的同形：差异样式已内联、画布已栅格成内联位图）；A（`?stage=1&id=A&preview=stage&dual=1`，舞台的 live 变体，1920×1080 可见，`setRole('front')`）挂同一张卡、`setSuppressed` 当重层，逐帧 `window.__pcStage.setSnapshots({ 片段: 第 i 帧 })`——与播放时父页每拍投递同一个 RPC、同一条 `Stage` 提交路径（快照平面 `dangerouslySetInnerHTML`、`renameSnapshotIds`）。
- 只轮换互不相同的帧（相邻两帧一样时 `Stage` 不动 DOM，等于空换）；只有一种画面的卡（`caption-track`）不量。
- 每换一次：同步提交 → 强制样式与布局 → 等两次真 rAF（让绘制记录也落在这一段）。「换帧」与「空换」（把当前帧原样再投一次：React 提交与占位刷新照走、DOM 不动）各 5 批**交替**跑，每批前后读 CDP `Performance.getMetrics` 的 `TaskDuration`（渲染进程主线程任务总时长，宿主与两个舞台同一个进程）：**`swapMs` =（换帧批 − 空换批）/ 每批帧数，取 5 批的中位数**。它就是「每多换一层，这一拍主线程多干多少」，含解析、改名、样式、布局、绘制记录，不含光栅化与图片解码（不在主线程）。
- dev 模式 dev server（`npx vite --port 5700`）。React 开发版的提交开销空换也付，相减抵掉；解析、样式、布局、绘制是浏览器原生代码。
- 另跑了 `--via rpc`（经 postMessage，含结构化克隆）对照 4 张卡：`chapter-bar` 1.59、`odometer` 4.66、`lottie-adrock` 5.07、`particles-basic` 5.59 ms（整机忙 19～21%），与直调同量级，克隆不是大头。

### 结果（两轮 `--all`：38 张卡，37 张量到）

跑法：`node scripts/probes/swap-cost-probe.mjs --origin http://127.0.0.1:5700 --all --particles 6 --json <文件>`，退出码第 1 轮 1（`pin-board` 生成快照超时，之后加了 `protocolTimeout`）、第 2 轮 0。第 1 轮整机更忙（量时抽样 33～100%），第 2 轮每张卡旁记了整机忙碌比例（17～77%，多数 20～35%）。**估值取两轮里小的那个**（竞争只会把数拉大）。

| 卡 | 卡种 | 快照 KB（中位） | 其中位图 KB | 第 1 轮 ms | 第 2 轮 ms | 第 2 轮整机忙 | 估值 ms | 按大小估 ms | 同步提交 + 布局 中位 / p90 ms |
|---|---|---|---|---|---|---|---|---|---|
| mu-number-ticker | dom | 15.3 |  | 0.86 | 0.72 | 27% | 0.72 | 1.4 | 1.8 / 2.4 |
| mu-blur-fade | dom | 12 |  | 1.26 | 1.68 | 27% | 1.26 | 1.3 | 2.5 / 3.6 |
| mu-circular-progress | dom | 17.3 |  | 1.57 | 1.63 | 23% | 1.57 | 1.5 | 2.2 / 2.6 |
| mu-typing | dom | 11.7 |  | 1.35 | 1.24 | 29% | 1.24 | 1.3 | 1.8 / 2.3 |
| mu-word-rotate | dom | 14.7 |  | 1.81 | 1.64 | 21% | 1.64 | 1.4 | 2.5 / 3 |
| odometer | dom | 143.7 |  | 8.24 | 6.37 | 66% | 6.37 | 6.5 | 7.3 / 8.9 |
| blur-text（`filter: blur`） | dom | 21 |  | 2.93 | 1.96 | 33% | 1.96 | 1.6 | 2.6 / 3.1 |
| ring-metric | dom | 21.6 |  | 3.2 | 1.81 | 22% | 1.81 | 1.7 | 2.6 / 3 |
| checklist | dom | 46.7 |  | 4.62 | 3.08 | 29% | 3.08 | 2.7 | 3.9 / 5.2 |
| step-timeline | dom | 48.9 |  | 3.45 | 2.47 | 26% | 2.47 | 2.8 | 3.35 / 4.2 |
| quote-lockup | dom | 17.8 |  | 1.96 | 1.51 | 16% | 1.51 | 1.5 | 2.4 / 2.9 |
| punch-pill（`filter: blur(32px)`） | dom | 13.7 |  | 2.11 | 1.24 | 23% | 1.24 | 1.3 | 2 / 2.6 |
| term-card | dom | 28 |  | 3.28 | 1.44 | 31% | 1.44 | 1.9 | 3.2 / 4 |
| type-shift | dom | 16.3 |  | 1.64 | 1.32 | 26% | 1.32 | 1.5 | 2.4 / 2.8 |
| entity-chips | dom | 25.2 |  | 2.95 | 1.83 | 37% | 1.83 | 1.8 | 2.8 / 3.5 |
| pin-board | dom | 21.2 |  | — | 1.73 | 65% | 1.73 | 1.6 | 3 / 4.1 |
| rank-bars | dom | 47.9 |  | 3.89 | 2.96 | 45% | 2.96 | 2.7 | 3.9 / 4.7 |
| stat-proof（毛玻璃 `backdrop-filter`） | dom | 24.6 |  | 1.9 | 1.84 | 28% | 1.84 | 1.8 | 2.5 / 3.1 |
| growth-curve | dom | 40.8 |  | 3.16 | 3.42 | 30% | 3.16 | 2.4 | 4 / 6.2 |
| versus-card | dom | 23.9 |  | 1.77 | 1.77 | 33% | 1.77 | 1.8 | 2.65 / 3.7 |
| ui-callout | dom | 16.1 |  | 1.91 | 1.54 | 22% | 1.54 | 1.4 | 2.6 / 3.1 |
| chapter-bar（毛玻璃） | dom | 24.6 |  | 1.42 | 1.89 | 28% | 1.42 | 1.8 | 2.8 / 3.7 |
| terminal-3d | dom | 25.2 |  | 3.08 | 2.4 | 26% | 2.4 | 1.8 | 2.8 / 3.2 |
| focus-card | dom | 25.4 |  | 1.98 | 1.94 | 25% | 1.94 | 1.8 | 2.75 / 3.5 |
| mu-animated-shiny-text（**用户卡**） | dom | 12.8 |  | 1.58 | 1.16 | 25% | 1.16 | 1.3 | 1.7 / 2.4 |
| lottie-adrock | lottie | 137.7 |  | 5.24 | 5.54 | 35% | 5.24 | 6.3 | 6.3 / 9.5 |
| lottie-bodymovin | lottie | 733.1 |  | 28.91 | 27.14 | 36% | 27.14 | 30.1 | 27.7 / 35.5 |
| lottie-gatin | lottie | 65.2 |  | 3.2 | 3.06 | 26% | 3.06 | 3.4 | 3.65 / 4.5 |
| lottie-happy2016 | lottie | 237.1 |  | 7.03 | 6.25 | 28% | 6.25 | 10.3 | 6.7 / 8.8 |
| lottie-navidad | lottie | 629.5 |  | 31.61 | 30.65 | 31% | 30.65 | 26.0 | 26 / 32.2 |
| scene-3d（共享 WebGL） | canvas | 489.8 | 479.5 | 6.92 | 6.7 | 77% | 6.7 | 5.2 | 6.3 / 8.7 |
| particles-basic | canvas | 638.9 | 628.1 | 6.36 | 5.5 | 19% | 5.5 | 6.6 | 5.4 / 6.6 |
| particles-big | canvas | 425.3 | 414.5 | 4.3 | 4.27 | 21% | 4.27 | 4.6 | 4.3 / 5.4 |
| particles-bigBlend | canvas | 333.9 | 323.1 | 3.68 | 3.91 | 18% | 3.68 | 3.8 | 3.9 / 5 |
| particles-bubble | canvas | 87.6 | 76.8 | 1.78 | 1.9 | 17% | 1.78 | 1.6 | 2.3 / 2.9 |
| particles-colorAnimation | canvas | 212.8 | 202.1 | 2.5 | 2.35 | 17% | 2.35 | 2.7 | 2.85 / 3.5 |
| particles-fallingConfetti | canvas | 202.5 | 191.7 | 2.69 | 2.36 | 17% | 2.36 | 2.6 | 2.9 / 3.4 |

按卡种（估值）：DOM 25 张中位 1.73、p75 1.96、最大 6.37 ms；Lottie 5 张中位 6.25、最大 30.65 ms；画布 7 张中位 3.68、最大 6.7 ms。毛玻璃、`filter: blur` 的卡与普通 DOM 卡在同一区间（主线程上滤镜只多一点绘制记录，模糊本身在合成器 / GPU），不单列一档；仓库用户卡（DOM）与内置 DOM 卡同一区间。

**结论**：代价主要由快照大小决定，卡种只是它的粗代理。最小二乘拟合：文本（DOM 与 Lottie 的 SVG）约 0.04 ms/KB、截距约 0.7～0.8；内联位图（画布卡）约 0.0086 ms/KB、截距约 0.87。取 `0.8 + 0.04 × KB`（文本）/ `0.8 + 0.009 × KB`（含位图）：37 张卡相对估值的中位误差 11%（最大 96%，`mu-number-ticker` 估大了）；按卡种表中位误差 32%（最大 178%）；一律 3 ms 中位误差 64%（最大 317%）。低估超过两成的卡：按大小 3 张、按卡种 8 张、一律 3 ms 8 张。

### 改法

- `src/render/beatSwap.mjs`：
  - `SWAP_MS = 3` 不变，留作兜底（卡种认不出来、调用方不给每层成本）；
  - `SWAP_MS_BY_KIND = { dom: 2, lottie: 6.5, canvas: 4 }`（各卡种中位数向上取到 0.5），`swapKindOf`（Lottie：`lottie` / `lottie-*`；画布：`particles` / `particles-*`、定义声明画布契约（`dom2d` 除外）或审阅表 / 定义标 `canvasHeavy`；页面上有定义的其余卡，含按声明是 DOM 的用户卡：DOM；页面上没有定义的用户卡、图卡：认不出来）、`swapCostOf`；
  - `SWAP_COST_MODEL = { baseMs: 0.8, textMsPerKB: 0.04, bitmapMsPerKB: 0.009 }`、`swapCostOfSize({ bytes, bitmap })`；
  - `fitBeatSwaps({ fps, occupiedMs, layers, swapMs, costOf })`：从上到下逐层累加 `costOf(id)`（给不出正数按 `swapMs`，`swapMs` 没给按 `SWAP_MS`），累加超过 `deadMs` 的那一层起（含）全部占位，**不越过它去换下面更便宜的层**（占位符只出现在下层，与原来「按从上到下的层序取」一致）；多回 `usedMs`。只给 `swapMs` 的旧调用每层同一个成本，与 `floor(deadMs / swapMs)` 逐一相同（ST-A-03 扫了 5 种帧率 × 8 种成本 × 9 种已占用）。
- `src/editor/snapshotFeed.ts`：`setBeatSwap(on, { swapMs, occupied, costOf })`；开了每层成本时记每层最近一次投出去的快照大小（字符数、有没有 `data:image/`），已知大小的层按大小估，没投过的按宿主给的卡种成本。不开每层成本（旧调用、测试）时行为不变。
- `src/render/pipelinePlan.mjs`：`opts.deadMs` 可以是函数（按片段取），停止条件从「Σw + 重卡数 × deadMs > B」变成「Σw + Σ各重卡的固定成本 > B」；数字时逐字不变（桌面 `DEAD_MS` 0.3 不受影响）。
- `src/editor/planDispatch.ts`：`setPlanDeadMs(ms, of?)`，`of` 给了按片段取（卡种成本），`ms` 作兜底。
- `src/editor/swapCost.ts`（新）：片段 → 卡种 → 成本，按项目与卡片注册表的代数记忆。
- `src/editor/Preview.tsx`：在线普通档打开时两边都接 `layerSwapMs`；桌面（关着）不变。

分派用卡种成本、按拍装箱在已知大小后用大小估，两者可以不同（分派是整段的静态判定，播放中才知道每层快照多大）；都在同一个预算 B 里。

### 单测（任务 A）

- `src/render/beatSwap.test.mjs`：ST-A-01 按层代价累加装箱（含贵的层在上时挡住下面、层去重、结果稳定）；ST-A-02 缺省兜底（`costOf` 回 undefined / 0 / 负数 / NaN / 非数字 / 抛错都按 `swapMs`，`swapMs` 没给按 `SWAP_MS`；卡种认不出、表里是 0 都兜底）；ST-A-03 旧调用兼容（扫 360 组与 `floor` 公式逐一相同）；ST-A-04 边界：预算 0 时再便宜也全占位、`deadMs` 恰好等于一层成本时装得下、空层表；ST-A-05 只装得下一层、最上层自己装不下时一层都不换；ST-A-06 卡种判定与表的形状（`SWAP_MS` 仍是 3）；ST-A-07 `planPipelines` 的 `deadMs` 函数与数字等价、贵的重层挤掉轻卡、候选各计自己的成本、坏值按 `DEAD_MS`。原有 C10-BS-01～04 不改照过。
- `src/editor/c10-beat-feed.test.mjs`：ST-A-08 宿主给了每层成本时按各层装箱；ST-A-09 已知大小后按大小估（文本比位图贵）、不开每层成本时大小不起作用。原有 C10-BF-01、02 不改照过。
- `server/test/c10-beat-swap.test.mjs`（C10-T 写的独立测试，`SWAP_MS_DEFAULT = 3`）不改照过。

## 任务 C：自然进场不发起播放态互换

### 规则（`src/render/playEntry.mjs`，纯状态机）

- **起播**（`notePlayStart`）：这一轮播放从 `fromSec` 那一帧起；起播那一帧的画面来自暂停态定位（`setTime`，或暂停态第二路互换），那一刻已经挂着的卡算「从中间开始」。宿主在发 `play(from)` 之前调（`Preview.tsx` 的播放 effect）。
- **一拍**（`notePlayBeat`）：可见舞台每报一拍（`frame` 事件），拍序号 `round(sec × fps)`：比上一拍多 1 算连续；与上一拍相同（武装停那一拍重复报）不算断；**跳了（差 > 1）或回退算断开**，从落点重新起算。
- **掉帧不算断**：可见舞台是「慢帧就等」（`product/rendering.md`「按帧走，慢帧就等」：慢了整体后移、不追、不跳帧；`StageView.tsx` 的 `runBeatLoop`），主线程卡一下时父页收到的拍序号仍逐一递增、只是到得晚，卡片的时钟也仍是一拍一拍推过去的。所以连续与否只看拍序号，不看墙钟间隔。拍序号真跳了（播放中跳转、换了舞台没接上）才算断，按从中间开始处理（与原来一样走估时，是保守的一边）。
- **接缝**（`notePlaySeam`）：播放态互换换上来的新可见舞台在目标拍 T 是整场景补跑出来的精确状态，从 T 接着报拍算连续、起点不变（`runPlayingSwap` 换成功后调）。
- **自然进场**（`enteredNaturally`）：挂载帧 > 起点、且已经走到。**挂载帧 = 起点的不算**：起播那一刻它已经挂着，状态来自暂停态定位——例如往回跳到它的挂载帧时，(b) 档 `vtOk = false` 的卡组件实例不换（`StageView.tsx` 的 `routeJump` 把它留给父页的第二路），保留着跳之前的状态；暂停态第二路没做完就按播放时它就是错的。停在挂载帧前一帧起播的算自然进场。没起播过（不知道起点）一律不算。
- `stageSwap.ts` 的 `playingSwapTargets(project, t)` = `playingCatchUpTargets` 去掉自然进场的；`Preview.tsx` 每拍先 `notePlayFrame(e.sec)` 再用它算目标。**暂停态第二路（`staleOnBackCatchUp`）不经这里**，照旧收全部 (b) 档 `vtOk = false` 的轻卡（停下时照旧整场景补跑到精确）。
- 诊断：`__pcPreviewDiag().swapPlaying` 加 `playRun`（起点、最后一拍、断开次数）、`naturalSkips`、`naturalSkipped`（这一轮播放里因自然进场没发起的卡，完整 clipId）、`plans`（最近 20 次发起判断，含完整 clipId）。

### 与语义不冲突的理由

- **「轻卡永远活渲」**（`mechanism/rendering.md`「轻管线：活渲」）：不发起播放态互换时，这张卡就在可见舞台里照常活渲，不进额外抑制、不显示占位——比以前（发起了就先抑制、显示占位，等补跑完再换）更贴近这一条。
- **「同一时刻同一帧」**（`product/rendering.md`「总规则」）：自然进场的卡在可见舞台里于自己的挂载帧挂上（与导出同一个 `mountFrameOf`），此后每拍按全局时钟推 1/fps（`clock.advanceTo` 按帧格分步，慢帧就等不跳帧），与导出逐帧推过去是同一个过程，所以每一拍的状态与导出同一时刻的那一帧相同，不需要后台补跑去「追」。会不同的只有两种：起播那一刻它已经挂着（状态来自暂停态定位）、拍序号断过（中间没逐拍推）——这两种照旧交给估时，能追上就互换。
- 互换本身在语义里写在「跳转时」之下（「只认全局时钟的卡由后台舞台整场景补跑后与可见舞台互换」），连续播放中自然进场不是跳转，所以这是按现有语义收窄发起条件，不改语义。

### 单测（任务 C）

- `src/render/playEntry.test.mjs`：ST-C-01 起播在卡之前、逐拍走过挂载帧 → 自然进场；ST-C-02 从卡中间起播 → 不是；ST-C-03 恰好停在挂载帧起播 → 不是，停在前一帧起播 → 是；ST-C-04 暂停后在卡中间继续播 → 不是（之后才挂载的卡仍是）；ST-C-05 掉帧（事件一口气到、拍序号不缺）→ 连续；ST-C-06 拍序号跳过挂载帧 → 断开、落点及之前的不算、之后的算；ST-C-07 回退算断开、重复报不算；ST-C-08 没起播过不算；ST-C-09 接缝后起点不变；ST-C-10 还没走到的挂载帧不算。
- `src/editor/stageSwap.test.mjs`（真的判据 + 假舞台）：ST-C-11 自然进场不发起、判据本身与暂停态第二路照旧收它；ST-C-12 跳到卡中间再播 / 暂停后在卡中间继续播，第一拍就交给估时；ST-C-13 恰好停在挂载帧与前一帧；ST-C-14 同一拍两张，只交从中间开始的那张；ST-C-15 拍序号跳过挂载帧交给估时；ST-C-16 播放态互换换上来之后从 T 接着报拍、之后挂载的卡仍是自然进场。原有 25 条不改照过。

## 验证（笔记本，同机另有两个子 Agent 在跑）

| 项 | 命令 | 结果 |
|---|---|---|
| 新单测 | `node --experimental-test-module-mocks --test src/render/beatSwap.test.mjs src/render/playEntry.test.mjs src/editor/stageSwap.test.mjs src/editor/c10-beat-feed.test.mjs` 等 | ST-A-01～09、ST-C-01～16 全过；所在文件原有用例不改照过 |
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误（最后一次在 `33bdd500` 之后） |
| 全量测试 | `npm test`（PATH 带 ffmpeg） | 退出码 0；tests 3988、pass 3986、fail 0、cancelled 0、skipped 2（main 3963 条，新增 25 条） |
| 代码指纹 | `node -e "import('./server/frame-code.mjs').then(m=>console.log(m.snapshotCode(process.cwd()), m.captureCode(process.cwd())))"` | `00a5264bf8a062ff6e0b5ed0516cccd1 86e443cb6fa838aef64788af6822fd68`，两个都不变；`SNAPSHOT_FILES` / `CAPTURE_FILES` 里的文件一个没动 |
| 兜底顺序探针 | `npx vite --port 5700 --strictPort --host 127.0.0.1`（`PROMPTCUT_NO_PORT_FILE=1`）后 `node scripts/probes/preview-fallback-probe.mjs --origin http://127.0.0.1:5700` | **第 1 次 FAIL 2**（「超时:粒子卡的轨道流满密度、快照铺上一截」「给 6 张新粒子卡复制了流层和快照层 :: 0」，`readyLayers: null`，K1 记录也超时）：那台 dev server 已经跑了一个半小时、中途因改 `pipelinePlan.mjs` 自己重启过一次、又被 swap-cost-probe 用了很久，预渲染进程没出任何产物。重起 dev server 后**第 2 次 PASS**：beats 298、transparentBeats 0、fails []、readyLayers 2（dense 162 拍、snapshot 418 拍） |
| 同上加 `--page-preload` | `… --page-preload` | **PASS**：beats 309、transparentBeats 0、fails []（dense 219、snapshot 432） |
| 看图 | `pfp-2/after-跳转.png` | 粒子卡的流铺满、两张药丸（旋转 25°、缩放 0.6）是占位符加沙漏，没有透明层 |
| 任务 C 与 A4 | `node scripts/probes/c10-browser-probe.mjs --base-port 5700 --only-a4 --out <目录>`（占 5700～5707，先停了自己的 dev server） | 见下 |
| 任务 A 的测量 | `node scripts/probes/swap-cost-probe.mjs --origin http://127.0.0.1:5700 --all --particles 6 --json <文件>` | 两轮，见上文表；另 `--via rpc` 4 张、`--cards probe-slow-stepped --params …` 2 次 |

### c10-browser-probe（`--only-a4`）三轮

1. **第 1 轮**（`b32ea63d` 之前的探针判据）：A1～A4 全过；我新加的任务 C 检查自己判错了（把「起播时已经挂着、入点为 0 的卡在 t = 1 走了一次估时」当成失败）。改了判据（按 typewriter 的片段核）与诊断（完整 clipId）。
2. **第 2 轮**（`dcc4c1c0`）：任务 C 两条过；**A4「换帧预算装不下的层显示占位（0～1 秒 9 张重卡）」挂了**：9 层探针重卡的快照各约 12 KB，按大小估每层约 1.3 ms，9 层 11.5 ms 装得下一拍（`fit 9、usedMs 11.48、deadMs 23.33`），没有层需要占位。原来的场景是按一律 3 ms 设计的（9 × 3 > 23.3）。这是任务 A 改了换帧成本的直接结果，不是回归：于是给探针卡加了可选的 `padNodes`，附加重层用 60 个小点把快照做到约 70 KB（按大小估约 3.6 ms；实测换帧 1.43 ms），装箱又回到「装得下 6～7 层、其余占位」。
3. **第 3 轮**（`33bdd500`）：**`ok: true`、`fails: []`**。
   - 任务 C：从 0 秒连续播放 10 秒，`playRun { startFrame 0, lastFrame 299, breaks 0 }`（300 拍拍序号一个不缺）；`probe-typewriter`（入点 2 秒）在 `naturalSkipped` 里、这一轮播放的发起判断里没有它（`naturalSkips 121`，即它在场的每一拍都判自然进场）；这一轮唯一一次发起判断是 t = 1 的入点 0 的轻卡（起播时已挂着，照旧估时，`rate` 不发起）。跳到 3 秒（typewriter 中间）等暂停态第二路做完再播：第一拍（t = 3.033）就对 typewriter 走了估时（`ids` 含它，`rate` 不发起），`playRun { startFrame 90 }`。以前的代码在连续播放中也会在 typewriter 入点那一拍估一次（`AGENT-pause-precise.md` 的 final3 / final4：`skip-rate`）。
   - A1：主文档长任务 0、播放中主重卡的快照平面 53 帧不同、按拍投递 258 次。
   - A4：t = 0.1 时 `fit 6、deadMs 23.33`，3 层占位、都显示为占位（`shown` 3 张）；暂停后追到精确活渲（`settled`、3 秒后仍是活渲）；「点停到精确活渲」7022 ms（与 `pause-precise` 的 6.9 秒同量级，没变）。
   - 看图：`a4-settled-live.png` 播放头 0.50、暂停，重层是活渲卡面（橙块加 `padNodes` 的小点），没有占位、没有沙漏。
- 自己起的进程都已结束：两次 dev server（5700）按 PID 连子进程一起结束，只结束了命令行是本工作区 `vite --port 5700` 的那棵进程树；探针自己起的服务与浏览器由探针收掉。收尾时 5700～5709 无监听（`netstat` 核过）。

### 机器状态与耗时数字

- 这台是笔记本（`verification.md` 说的性能基准机），但同机另有两个子 Agent 在跑全量测试与探针。swap-cost-probe 第 1 轮时抽样 33～100%，第 2 轮每张卡记的整机忙碌比例 17～77%（多数 20～35%）。表里的估值取两轮里小的，仍可能偏大；最终判定请主会话在空闲机器上重跑 `swap-cost-probe --all` 两轮再看表里的数要不要调。
- `preview-fallback-probe` 的 `taskMs` p90 32～45 ms、`c10-browser-probe` 的「点停到精确活渲」7.0 秒，都是在忙的机器上量的，只作对照。

## 语义与契约的更正建议（dry run，交主会话定）

### 1. `docs/semantics/mechanism/rendering.md`「兜底顺序」末条（三级）

修改前：

> - **在线浏览器模式（普通档）没有轨道流**：重层每拍换一次 HTML 快照，播放中的投递不受换帧节流。换一次快照的成本 `swapMs` 计入每拍预算：`deadMs = max(0, B − 这一拍轻管线已占用)`，这一拍装得下 `floor(deadMs / swapMs)` 个重层，按从上到下的层序取，装不下的显示占位符；分派时每张重卡每拍的固定成本也取 `swapMs`。`swapMs` 缺省 3 毫秒，按卡种实测后改这里（出处：`docs/plan/c10-contract.md` 第 6 节、第 18 节第 1 条）。

修改后：

> - **在线浏览器模式（普通档）没有轨道流**：重层每拍换一次 HTML 快照，播放中的投递不受换帧节流。换一次快照的成本按层计入每拍预算：`deadMs = max(0, B − 这一拍轻管线已占用)`，从上到下逐层累加各层的换帧成本，累加超过 `deadMs` 的那一层起（含）这一拍显示占位符，不越过它去换下面的层。一层的换帧成本：这一层已投递过快照时按快照大小估，`0.8 + 0.04 × KB` 毫秒，快照含内联位图（画布卡）时 `0.8 + 0.009 × KB`；还没投递过时按卡种，DOM 卡 2、Lottie 6.5、画布卡 4 毫秒；认不出卡种的（页面上没有定义的用户卡、图卡）取缺省 3 毫秒。分派时每张重卡每拍的固定成本取它的卡种成本。数字是笔记本实测（`scripts/probes/swap-cost-probe.mjs`，37 张卡；出处：`docs/plan/c10-contract.md` 第 6 节、第 18 节第 1 条与末条）。

### 2. `docs/semantics/mechanism/rendering.md`「轻管线：活渲」第二条（三级，可选，只是写明）

修改前：

> - 跳转时：可定位的卡直接钉到目标帧；……能用自己子树的虚拟时间推进的卡在可见舞台里追；只认全局时钟的卡由后台舞台整场景补跑后与可见舞台互换。

修改后（在这一条末尾加一句）：

> ……只认全局时钟的卡由后台舞台整场景补跑后与可见舞台互换。播放中逐帧走过挂载帧、自然进场的卡不是跳转，不互换；从卡中间开始播放（起播时已经挂着，或播放中帧序号断过）的照跳转办。

### 3. 契约 `docs/plan/c10-contract.md`（已改，标〔裁〕）

- 第 6 节「播放」末尾加一句：换帧成本按层取（按大小 / 按卡种 / 兜底 3 ms）、逐层累加装箱。
- 第 18 节末加 2026-09-30 一条，两款：换帧成本按层取（测法、数字、试过的另一条路）；播放态互换只给从卡中间开始播放的卡（规则与语义依据）。

### 4. 观察（没改，供主会话定）

- 「挂载帧 = 起点」的卡照旧走估时：从 0 秒起播时入点为 0 的 (b) 档 `vtOk = false` 卡都算「从中间开始」。若暂停态第二路已经在起播那一帧做完（整场景精确），其实也不必互换；要进一步省，可在 `stageSwap.ts` 记「最近一次暂停态互换在哪一帧做完、之后项目与播放头没动过」，起播帧与它相同时把起点当精确。没做：失效条件（编辑、换项目、舞台重载）多，出错的代价是状态错而不是多一次补跑。
- 按大小估目前用字符数近似字节数，DOM 与 SVG 同一个斜率；超大 SVG（Lottie 600 KB 以上）一层就 26～31 ms，超过 30 fps 的整拍预算（23.3 ms），这类层在在线普通档播放中永远装不下、一直占位，这是现有兜底顺序的结果，不是本任务引入的。

## 没做成的与限制

- **按大小估对「样式多、结构简单」的快照偏大**：`probe-slow` 加 60 个小点的快照 70.5 KB，按大小估 3.6 ms，实测 1.43 ms（400 个点 402 KB：估 16.9、实测 7.1）。系数是按 37 张真卡拟合的（中位误差 11%），合成的重复节点每 KB 便宜一半以上。要更准得按节点数与文本量分开估，需要在投递时多扫一遍 HTML，没做。
- **分派用卡种、装箱用大小**：分派（`planPipelines` 的 `deadMs`）在播放前定整段的轻重，拿不到每层快照多大，只按卡种；播放中已知大小后按拍装箱按大小。两者同在预算 B 里，但一张重层在分派里记 2 ms、播放中可能记 6 ms，这一拍可能比分派时算的多出占位。没有让分派回头按大小重算（大小会随播放变，分派表一变就要重发给舞台）。
- **第 1 次 `preview-fallback-probe` 挂了**，原因判为 dev server 状态（见验证表），重起后两次都过；没有在 main 上对照跑（主工作区不动）。
- 表里的数是在忙的笔记本上、dev 模式下量的（React 开发版的开销被空换抵掉，浏览器原生的部分与产物包一样）。
- 任务 C 只收窄了**播放态互换**的发起条件；「挂载帧 = 起点」的卡照旧走估时（见「观察」），没做「暂停态第二路已精确就把起点当精确」的进一步优化。
- G0-R（导出确定性、像素基线、快照重放）按任务书由主会话合流时跑，我没跑。

## 主会话审查（2026-09-30，笔记本主会话）

- 审过 `playEntry.mjs`（按拍序号判连续，掉帧不算断）与按层装箱；认可给探针卡 `probe-slow` 加 `padNodes`（缺省 0）让 A4 的「装不下显示占位」仍验得到（验收标准不变，只是场景的层做重）〔裁〕。
- 空闲笔记本上重测两轮 `swap-cost-probe --all`（整机忙碌中位 13%）：DOM 1.41、画布 3.25、Lottie 5.02 ms（中位数），比本报告负载下的数低约 20%。空闲数据最小二乘拟合 `0.59 + 0.031 × 文本 KB + 0.0062 × 位图 KB` 中位误差 9% 但低估 22 / 37 张；本报告的常数中位误差 28%、只低估 2 张，作保守上沿照留〔裁〕（低估会让一拍超预算掉帧），写进 `mechanism/rendering.md`「兜底顺序」。
- 合流 `claude/r3-merge` 上 `c10-browser-probe --only-a4 --no-video` 过：自然进场跳过 121 次、300 拍连续，跳到 3.03 s 再播照旧走估时；A4 `fit` 6、占位显示、暂停后精确活渲保持。合入 main `0efcd41d`。
