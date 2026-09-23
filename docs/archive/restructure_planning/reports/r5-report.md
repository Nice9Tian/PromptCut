# R5「播放与追帧」实施报告

分支：`worktree-agent-a52a03fda5bdd932f`
worktree：`C:\Users\admin\Documents\PromptCut\.claude\worktrees\agent-a52a03fda5bdd932f`
起点：`e8c2333`（`git merge --ff-only main` 之后）；没 push、没合并、没动 main、没动别的 worktree。

## 提交（按块，`main..HEAD`）

| 提交 | 块 |
|---|---|
| `d42746f` | **K4 节拍器**（舞台侧 `play` / `pause` 真实现 + 父页 `frame` / `ended` / `mediaStalled` / E6 拆 effect） |
| `215b771` | **父页的快照 / 抑制投递**（C4 选帧、A3c 基线与节流、C5 播放态抑制） |
| `7f48d23` | **K3 三条跳转路**（(a′) 直接定位、(a) 一拍内重推、(b) 子树虚拟时间追） |
| `f3e2c7b` | **K5 两路追帧与角色互换**（第二路整场景补跑 + 两个 iframe 换身份） |
| `73ea969` | **K6 降级闭环**的父页一半（整条 PUT、`pendingDemote`、就绪后才切进 `suppressed`） |
| `bfbf59d` | **`prerenderSetOf` 接上真的 `planPipelines`** + 两端同表单测 |
| `7f7b75d` | 验收探针 `playback-probe`，并修四处实跑才暴露出来的问题 |
| `9d1490d` | 节拍循环不许被节流的 iframe 挂死；互换后不再白灌一次整份项目 |

K6 的**舞台侧记账 + `checkDemote`** 落在 `d42746f`（K4）里，不在 `73ea969`：一秒窗口是按拍记的，
和节拍循环写在一起才读得懂，拆开会让两边都只剩半句话。

## 改了哪些文件（`main..HEAD`，2801 + / 98 −）

**新增**
- `src/editor/snapshotFeed.ts`（417）— C4 / C5 / A3c 的排程：选帧、`wanted`、投递基线、33 ms 节流、2 MB 拆分、`pendingDemote`
- `src/editor/stageSwap.ts`（323）— K5 第二路 + K3(b) 的播放态互换
- `src/editor/demote.ts`（69）— K6 的父页一半
- `src/cards/_probe/slow.tsx`（57）— K6 的判例卡（每次渲染烧 `burnMs` 毫秒）
- `scripts/probes/playback-probe.mjs`（545）、`server/test/prerender-set.test.mjs`（108）

**改动**
- `src/StageView.tsx`（+711）— K4 的节拍循环、K6 的窗口与 `checkDemote`、K3 的三条跳转路、
  按片段的追帧驱动（K3(a) / K3(b) / K5 第一路共用）、`setRole('front')` 报 `settled`、`__pcStageDiag`
- `src/editor/Preview.tsx`（+346）— 起 / 停节拍、七种事件的消费方、E6 拆 effect、角色互换的宿主、`__pcPreviewDiag`
- `src/render/wirePlan.ts` / `src/editor/planDispatch.ts` — `WirePlan` 加 `identityKeys` / `frameModes` / `tuning`，新增 `reviveStagePlan`
- `src/render/FrameScene.tsx` — live 路的每卡耗时（`CostMark`）
- `src/editor/stageBridge.ts` — 新增 `markPushed`
- `src/kernel/clock.ts` — `__pcStageDiag` 的类型声明
- `server/card-cache.mjs` — control 上加 `costKey` / `frameMode`
- `server/prerender-set.mjs` — 换成真的 `planPipelines(...).prerenderSet`
- `server/frame-pipeline.mjs` — `adoptCardPlan` 把 `fps` / `root` 传下去
- `scripts/probes/stage-rpc-probe.mjs` / `editor-preview-smoke.mjs` — 按 R5 的新行为更新断言 / 不再写死 `id=A`

## 六块各做到哪一步

| 块 | 状态 |
|---|---|
| 1 K4 节拍器 | **做完**。舞台侧绝对时刻排程、慢帧后移、封顶 fps、`ended` 自停、武装停、`setRole('back')` 停循环；父页 `play` / `pause`、`frame → actions.tick`、`ended` 收尾、`mediaStalled`、E6 拆 effect、非 legacy 不启动 rAF 循环、发 `pause()` 处清 `lastRenderKey` |
| 2 父页投递 | **做完**（`streams` 恒关那条路）。选帧 / `wanted` / 基线 / `reset` / 33 ms 节流 / `settled` 删基线 / ≤ 2 MB 拆分都在。**没有端到端验过真的快照字节** —— 要预渲染进程，见「没做成」 |
| 3 K3 三条跳转路 | **做完**。(a′) / (a) / (b)、重挂载定位配方（片段粒度）、`remountGen`、拖动 100 ms 节流、播放中 (b) 档卡进入即追 |
| 4 K5 两路追帧与角色互换 | **做完**。第一路（`settling` + `catchUpGen` + `settled` 带 clipId）、第二路（六步全在）、播放态互换（目标拍 `T`、武装停、`passed` 重取 `T'`）、五个 RPC 中止追帧、补跑经 `stageJobs` 的 `catchup` 档优先于探针 |
| 5 K6 降级闭环 | **做完到「写 `demoted`」为止**。窗口统计 / `demote` / 整条 PUT / `pendingDemote` / 就绪判据 / 会话内生效 / 两端重算都在。**「5 秒内预渲染进程有它的批 → 就绪 → 下一拍切进 `suppressed`」没有端到端验过**，见「没做成」 |
| 6 `prerenderSetOf` | **做完**。换成 `planPipelines(...).prerenderSet`，`costs` / `tuning` 读本机那一份（编辑器进程转发过来），`costKey` 在 `card-cache.mjs` 的 `plan()` 里算；两端同表有单测 |

## 验收数字

环境：这台机器，dev server **5281**（舞台 5282 / 5283），`PROMPTCUT_DATA_DIR` 指到临时目录（仓库 `out/` 没被碰）。
无头 Chrome 带 `--disable-gpu-vsync --disable-frame-rate-limit`（**照 R2 报告**：不带这两个，这台机器上
无头 rAF 退到 10 Hz，节拍循环的 `await __pcRealRaf()` 等不到、拍长全错）。

### 例行

- `npx tsc -b --force`：**0 错误**。
- `npm test`：**1632 / 1631 通过 / 0 失败 / 1 跳过**（main 基线 1625 / 1624 / 0 / 1；新增 7 条：
  `wirePlan.test.mjs` 2 条 + `server/test/prerender-set.test.mjs` 5 条）。
- `scripts/verify-unified-frames.mjs`：**红**，但**不是 R5 引入的** —— 把 `server` / `src` / `scripts`
  整体 `git checkout e8c2333 --` 之后重跑，**同样在第 60 行 `export must exactly match see_frames` 失败**
  （R6 报告记的是第 46 行 `'mov' !== 'rendered'`，那一条现在过了，说明 main 后来修过一次，
  剩下这条是另一处旧账）。

### `scripts/probes/playback-probe.mjs`（新，自己起 dev server，`--seconds 10`，全绿 `ok: true` / `fails: []`）

**K4 节拍**（每档播 10 秒；`want = 1000/fps`）：

| fps | 拍数 | 到达间隔均值 | want | p50 | min / max | `sec` 差不等于 1/fps 的条数 | 短拍 | 主文档长任务 |
|---|---|---|---|---|---|---|---|---|
| 24 | 241 | **41.704** | 41.667 | 35.6 | 30.8 / 55.2 | **0** | 0 | **0** |
| 25 | 251 | **40.054** | 40.000 | 35.2 | 33.6 / 53.8 | **0** | 0 | **0** |
| 30 | 301 | **33.356** | 33.333 | 34.7 | 17.4 / 39.0 | **0** | **0** | **0** |
| 60 | 601 | **16.691** | 16.667 | 17.6 | 2.3 / 21.1 | **0** | 35 | **0** |

四档均值全部落在 **±0.04 ms** 内（判据是 ±1 ms）。`sec` 差恒为 1/fps。
30 fps 下**没有**短于半拍的间隔（任务书点名的那一条）。60 fps 的 35 条「短拍」是**父页收
postMessage 的抖动**（两条 `frame` 挨着到达），不是跳拍 —— 10 秒恰好 601 拍、`sec` 差全对；
所以探针只对 30 fps 判这一条，别的帧率只记数（见下面的更正建议）。

**播放到头**：`ended.sec = 2`、`store.t = 2 = duration`、`store.playing = false`、
舞台 `beatRunning = false`、`suppressed = []`（最后一帧**不**停在抑制态）。

**暂停后重卡追到活渲**
- 第一路（`vtOk` 重卡）：`settled { sec: 8, clipIds: ["c-…-16"] }` **带 clipId**；追完 `settling = []`、
  该片段不在 `snapshots` 里。
- 第二路（`vtOk = false` 重卡）：`front` 由 **A → B**（两个 iframe 换了身份）、新 `front` post
  `settled` 且 `clipIds` 为空、互换后 `snapshots = []`、`suppressed = []`、`settling = []`
  （**组件不在任何集合里**）。
- **连点时间轴 10 次**：`settled(clipIds=[])` 恰好 **1 条**（前九次都被 `catchUpGen` / `renderGen`
  中止且没有重发），最后一次正常互换（`front` 再翻一次）。

**K3(a′)**（60 秒纯 CSS 平移卡，`seekOk: true` / `seekMs: 3 ms ≤ B`）：
`prerenderSet = []`（不进预渲染集合）；**点到第 50 秒**：`remountGen` 不变（0 → 0）、舞台 `t = 50`；
**从第 55 秒拖回第 20 秒**：`remountGen` **恰好 +1**（0 → 1）、舞台 `t = 20`、`settling = []`。

**K6 降级**（`probe-slow` 每帧烧 60 ms，探针成绩写成 `stepMs: 1` 判轻）：
- `demote` 事件 1 条，clipId 正是 `probe-slow` 那一段；
- 这一段的 `frame` 间隔 **mean 62.058 ms / p50 62 / min 58.3 / max 66.8**（人为拉到 60 ms 之后拍长
  就是 60 ms 量级），**`sec` 差不等于 1/fps 的条数 = 0**（慢帧就等、不跳帧）；
- 每拍都超过 40 ms，父页 `mediaStalled = true`（素材与音频被掐住）；
- `costs` 里**恰好一条** `demoted: true`，且 `capped: true`、各测量值还在（整条 PUT）；
- 落盘的 `card-costs.json` 里同样 1 条；
- 死素材没就绪之前它留在 `pendingDemote`（父页和舞台两边都是），**照常活渲**。

### 既有探针（全部在 5281 上复跑，全绿）

| 探针 | 结果 |
|---|---|
| `stage-rpc-probe.mjs`（跨源 / `--legacy`） | `fails: []`（两种模式）。**改了两条断言**：`play` / `pause` 不再是 `unsupported` |
| `editor-preview-smoke.mjs`（legacy / `--stage`） | `fails: []`（两种模式）。**改了一处**：`stageFrame()` 不再写死 `id=A` |
| `stage-content-probe.mjs` | `fails: []` |
| `probe-gate-probe.mjs --cards 20` | `pass: true` / `fails: []` |
| `ready-index-probe.mjs` | `fails: []`（重启后按键重建 3 层） |

### 主文档零卡顿

四档节拍各 10 秒，主文档 `PerformanceObserver({ entryTypes: ['longtask'] })` 计到的长任务
**全部为 0**（见上表最后一列）。**量到的范围**：播放期间后台舞台是空闲的（探针在 `waitProbeIdle`
里已经跑完），**没有**同时跑预渲染进程 —— 那一条见「没做成」。

### 端口

`5281` / `5282` / `5283` 用完已全部关掉（`Get-NetTCPConnection` 查 0 个监听），带探针开关的
Chrome 0 个，我起的 node 0 个。没碰 5190～5199 / 5201 / 5211～5279。

## 对任务书的更正建议（原句 → 怎么做的 → 为什么）

1. **K4「慢帧就等：一拍超时就把时间轴整体后移（`playStart += 超出量`）」**
   **怎么做的**：只在**这一拍的活本身**超过 `nextDue` 时后移；等 rAF 那一下的粒度溢出**不**后移。
   **为什么**：照字面每拍都按「等到的那一刻 − nextDue」后移的话，绝对时刻就被一路推成
   「每拍整数个垂直同步」—— 24 fps（41.67 ms）在 60 Hz 上会被推成恒定 49.8 ms，均值不再是 1000/fps，
   正好破掉同一节的验收。建议把这句写成「**一拍的活**超时才后移」。

2. **K4 / K 节验收「30 fps 下没有 16.6 ms 的短拍」「24 / 25 fps 自然是 2 / 3 帧交替」**
   **怎么做的**：探针只对 30 fps 判「没有短拍」，别的帧率只记数；2/3 交替**没有验**。
   **为什么**：要量准拍长就必须带 `--disable-gpu-vsync --disable-frame-rate-limit`（R2 报告：
   不带的话这台机器无头 rAF 退到 10 Hz），而带了之后 rAF 不再被垂直同步量化成 16.6 ms 的格子，
   「2/3 帧交替」这个现象**按定义就不会出现**。能量准、也是这条真正要保的，是均值 = 1000/fps 和
   `sec` 差恒为 1/fps。建议把 2/3 交替那句改成「有垂直同步的真机上」，并注明无头下的量法限制。

3. **K6「本窗口实测累计耗时最大的那张轻卡」怎么量**
   **怎么做的**：`FrameScene` 的 live 路给每个片段的 `Stage` **前后各放一个只跑回调、不产生 DOM 的
   兄弟组件**，用 `__pcRealNow` 掐表（React 的兄弟渲染顺序是确定的）。
   **为什么**：先试的是 React 的 `<Profiler>`，**实测每张卡都报 0** —— 它的 `actualDuration` 读
   `performance.now()`，而舞台把 `performance.now` 换成了虚拟时钟（`stageClock.ts:123`），
   一拍之内是个常数。建议在 K6 / E4b 里写明「舞台里量耗时一律用 `__pcRealNow`，`Profiler` 不可用」。
   **已知限制**：这么量到的是**渲染阶段**，不含卡片自己 rAF 回调里的时间（那些跑在 `clock.tick`
   里，回调和片段之间没有可靠的归属关系）。对「贵在 render」的卡（组合卡、大量 DOM）准；
   对「贵在 rAF 回调」的卡（粒子、三维）偏小。任务书没给这一段的量法，建议补一句取舍。

4. **K6「`pendingDemote` 的卡……不计入 K6 的一秒窗口、K6 也不再把它当候选」**
   **怎么做的**：不只把它从候选里摘掉，**连它那一份耗时一起从这一拍的超时里扣掉**。
   **为什么**：只摘候选不够 —— 它照常活渲、照常把这一拍拖到 60 ms，窗口还是每秒都爆，
   于是每秒再降一张。**实测**：两张卡的项目里第二张（无辜的那张）也被降了。
   这正是同一句话紧接着担心的那个失败模式，建议把「不计入窗口」写明是「连耗时一起扣」。

5. **K5 (6)「新 `front` post `{ type: 'settled', sec, clipIds: [] }`」的触发判据**
   **怎么做的**：按「上一刻**是不是 `back`**」判，不看工作项。
   **为什么**：按「上一刻工作项是不是 `catchup`」判会漏 —— 单飞队列（`stageJobs.pump`）在补跑那个活
   做完之后会把工作项交还成 `'probe'`，那条 `setRole('back', { job: 'probe' })` 和互换的
   `setRole('front')` 是两条并行的 RPC，谁先到没有保证。**实测**交还先到，`settled` 一条都发不出来。

6. **K5 / K3(b)「`front` 按每张判重卡的 `vtOk` 分两路」—— 没有成本记录时怎么办没写**
   **怎么做的**：**没有记录的卡两条路都不走**（`needsBackCatchUp` / `playingCatchUpTargets` 都要求
   记录存在），等 `setPlan` 带着记录下来再说。
   **为什么**：没记录时 `clipWeight` 按声明把 stateful 卡一律判重，而 `vtOk` 是 `undefined`；
   照「不是 `true` 就走第二路」读的话，**刚打开一个项目、K1 探针还没测完就会整场景补跑 + 互换**，
   而那时后台舞台正在跑探针（补跑排在 `catchup` 档，会把探针整体挤掉）。**实测**
   `editor-preview-smoke --stage` 里加两张卡再 `seek` 一下就换了一次身份。建议在 K1 末段
   「兜底分派只用于『新卡还没测完』那几秒」后面补一句：**兜底只用于分派，不触发 K5 的两路**。

7. **K4「用 `window.__pcRealRaf` 等真实一帧提交」—— 等不到怎么办没写**
   **怎么做的**：`realRafOrAfter(ms)`，超时就当这一帧已经画过；**连着 3 拍等不到就认定这个 iframe
   被节流了**，此后每拍只让一个宏任务（4 ms）。
   **为什么**：跨源 iframe 被浏览器判成「不可见」时 rAF 被节流到零。**实测**
   `editor-preview-smoke --stage` 里可见舞台走完第一拍就再也没有下一帧，整个节拍循环永远挂在那里：
   `pause()` 回不了包、`play()` 等不到上一轮收摊、K5 的武装停等不到 `frame(T)`，整条链一起僵住。
   总规则是「永远不等」，所以宁可少渲一帧也不能让循环僵死。Motion 要的是**任务边界**、不是真帧，
   所以退化成宏任务是安全的。建议在 K4 里补这条兜底。

8. **E0 的 `setPlan({ plan, costs })` 不够舞台用**
   **怎么做的**：`WirePlan` 加三个字段 `identityKeys`（clipId → `cardCostKey`）、`frameModes`、`tuning`。
   **为什么**：K3 的 (a′)/(a)/(b) 和 K5 的两路都要按**片段**查 `vtOk` / `seekOk` / `seekMs` / `catchUpMs`，
   而 `costs` 是按 `identityKey` 索引的、`CardCostRecord` 里**没有 `clipId`**（它是内容寻址的，
   同一张卡的两个片段共用一条）。父页在 `clipIdentityOf(project)` 里本来就算好了这一份。
   `tuning` 一起过去是因为舞台要用同一份 `clipWeight` 分档，系数不一致两端会分出不同的档。

9. **`prerenderSetOf` 在预渲染进程那一端怎么挑 `device`——任务书没写**
   **怎么做的**：按 `identityKey` 取 `measuredAt` **最新**的那一条。
   **为什么**：`costs` 按 `(identityKey, device)` 去重，而预渲染进程**不知道编辑器那台机器的
   `device` 串**（它是页面侧探测出来的：GPU、核数、低内存、`offscreenGl`、`tuning` 两项……）。
   同一台机器上通常只有一条；真有两条（离线探针和常驻探针各写了一份）时最近一次实测更可信。
   要更准的话得让页面把 `device` 随 `__pcCardPlan` 捎过去，建议记一笔。

10. **A3c「投递基线按 iframe 各一份」**
    **怎么做的**：按**角色**各一份（`front` / `back`），角色互换时给 `front` 那一份打 `reset`。
    **为什么**：`back` 永远不收快照（E0），所以按角色记和按 iframe 记等价，而按角色记能直接
    和 `stageBridge` 的两个槽位对上。互换时打 `reset` 那一下就是把「换了一个 iframe」补回来。
    带 `reset` 的那次投递**基线也从零算起**（否则该重挂的那几张不会被重新投）——
    这一点任务书没写，建议补。

11. **E3「拖动结束：先发最后一次 `setTime(t_end, { settle: true })`，再 `setScrubbing(false)`」**
    **怎么做的**：`sendSetTime` 在「非播放且非拖动中」时带 `settle: true`，拖动中不带；
    `setScrubbing` 由 `useScrub` 的订阅单独驱动，顺序由 React 的提交顺序定，**没有显式串起来**。
    **为什么**：两者在 `Preview` 里是两个独立的 effect（`scrubbing` 来自
    `useSyncExternalStore`）。实测行为对得上（松手那一次 `scrubbing` 已经是 false，
    `setTime` 带 settle），但严格的先后顺序没有强制。建议要么写明「不要求顺序」，要么在 R7 串起来。

## 没做成 / 留给 R7 的事

1. **要预渲染进程才验得了的三条，没有端到端验**：
   - 「`streams` 关着时播放判重的卡每 ≥ 33 ms 换一次快照、不透明」；
   - K6 的「5 秒内预渲染进程有它的批 → 就绪 → 下一拍切进 `suppressed`」；
   - 「重开项目重测写回 `demoted: false`」。
   代码路径都在（`snapshotFeed` 的选帧 / 投递 / `demoteReady`、`probeRunner` 显式写
   `demoted: false`、`costs-store` 的 `STICKY_FLAGS`），单测和 `ready-index-probe` 覆盖了
   服务端那一半，但把预渲染进程一起拉起来跑一遍的端到端没做。`playback-probe` 留了
   `--only` 开关，加一组用例即可。
2. **「主文档零卡顿」只量到了「播放中」这一半**：播放期间后台舞台是空闲的，没有同时跑
   预渲染进程。要补的话得起 `full` 模式的预渲染进程再跑一次 `--only 节拍`。
3. **`vtOk` 的重卡「期间全局 `pinner.sync` 没碰它子树、别的卡一帧没动」没有单独验**：
   机制在（`skipWrappers` → `sync(nowMs, skip)`，R3 已落地并有样式契约的探针），
   但「别的卡一帧没动」要逐帧录屏比对，没做。
4. **逐帧录屏那两条**（「播放中互换时画面不回退一帧」「可见舞台里看不到推帧过程」）没做：
   判据改成了可观测的等价物（`sec` 差恒为 1/fps + 旧 `front` 恰好停在 `T`；
   帧间只让微任务、`.pc-settling` 是 `visibility:hidden`）。
5. **`scripts/verify-unified-frames.mjs` 仍然红**（第 60 行 `export must exactly match see_frames`），
   已确认在 `e8c2333` 上同样红，不是 R5 引入的；没有去修（超出本步范围）。
   **导出逐字节对账本身没有重跑** —— 理由：`FrameScene` 的改动全部挂在 `live` 分支上
   （`CostMark` 只在 `live` 时出现，而且它自己 `return null`、不产生任何 DOM），
   `Stage` 一个字没改，导出页不传那六个 prop。
6. **`playing` 状态下的 `settle` 竞态**：`runSettleSwap` 在补跑完之后会检查
   「`store.t` 变了没有 / 是不是又在播了」，变了就作废。**没有为这条写专门的用例**。
7. **`stageJobs` 的 `lastSentJob` 是模块级的**：K5 互换之后 `back` 换了一个客户端，
   而 `lastSentJob` 还记着上一个客户端的工作项，于是「同一个工作项不重发」可能漏发一次
   `setRole('back', { job })`。互换路径里 `swapAndDress` 自己发了 `setRole('back')`，
   所以现在不出问题；但这是个**隐患**，建议 R7 在 `setStageClient('back', …)` 时把它清掉。
8. **不在范围、确实没碰**：摘 `front` 的 `opacity: 0`、删主文档的 `mediaRects`、翻默认开关（R7）；
   轨道流平面的内容（R8）；共享 WebGL 渲染器（R9）。`server/bakery/*` 和导出路径一个字没动。
9. **`server/frame-pipeline.mjs` 里有 2 个字面 NUL 字符**（第 712 行的 `${target.tier}\0…`），
   git 因此把这个文件当二进制存，逐行 diff 和换行规范化都没了 —— 和 R4b 报告里说的
   `costs-store.mjs` 是同一个毛病（那个已经在 `919c9e2` 修了）。我没动它（不在范围），
   但它会让这个文件的合并很难受，建议照 `919c9e2` 的办法换成转义写法。

## 给合并的人：几处口径

- **`__pcStageDiag` / `__pcPreviewDiag` 是只读的观察口**，给验收探针用（跨源摸不到 iframe 的
  document）。没有副作用，也没有别的消费方。
- **`src/cards/_probe/slow.tsx` 是判例卡**，`frameMode: 'direct'`、缺省 `burnMs: 0`
  （不给参数时和一张普通静态卡一样便宜）。它会进 `allCards()`，和 `probe-css` /
  `probe-motion-js` 一个待遇。
- **`dev server 跑久了会踩 HMR 的坑**：一台连续 HMR 了几十次的 dev server 上，舞台 iframe 会停在
  一份旧模块上、`pc-stage-ready` 再也不来（实测：`front: false` / 两个 iframe 都在、
  `__pcStage` 也在）。跑探针前重起一次 dev server 就好。这不是代码问题，但会白白浪费半小时，
  记在这里。

## 原始数据

`C:\Users\admin\AppData\Local\Temp\claude\C--Users-admin-Documents-PromptCut\165173c5-efca-49ed-bcce-9f4d3c1c1774\scratchpad\r5-data\`
- `playback-final.json` — 最后一次全绿的完整跑（自己起 dev server、干净数据目录）
- `cadence.json` / `settle.json` / `demote.json` — 中途分组跑的几次
