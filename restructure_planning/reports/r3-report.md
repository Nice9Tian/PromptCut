# R3「舞台内容」实施报告

分支：`worktree-agent-ae27590eacc29aed3`（worktree `.claude/worktrees/agent-ae27590eacc29aed3`）
基线：`git merge --ff-only main` → `62810bb`（R1 / R1b / R2 / R4a 都在里面）
报告时间：2026-09-22

## 提交列表（`62810bb..HEAD`）

| sha | 说明 |
|---|---|
| `586fd02` | R3：素材层搬家（E7 第 1 条）——VideoTrack / mediaDrive / mediaSync 进 `src/render` |
| `7194834` | R3：pinAnimations 的 `resetIn` / `syncIn` / `sync(skip)` 与 E4b 的定时器虚拟化 |
| `7bda056` | R3：Stage 的六个可选 prop 与四种平面、FrameScene 的 live 变体、StageView 的真实 setter |
| `52952da` | R3：E4b 的两张探针卡与新探针 `scripts/probes/stage-content-probe.mjs` |

## 改了哪些文件

**新增**

- `src/render/VideoTrack.tsx`（从 `MediaLayers.tsx:151-312` + `:128` 的 `interface Slot` + `:138-150` 三个辅助函数抽出）
- `src/render/mediaDrive.ts`（`driveMedia` / `releaseMedia` / `syncMediaEl` / 三个 WeakMap / `targetTimeOf` / `filterOf`）
- `src/render/mediaSync.ts` + `src/render/mediaSync.test.mjs`（`git mv` 自 `src/editor/preview/`）
- `src/render/virtualTimers.ts` + `src/render/virtualTimers.test.mjs`（E4b 的 fake timers，10 条单测）
- `src/render/pinAnimations.test.mjs`（7 条单测）
- `src/render/planeStyle.ts`（E7 的四条样式规则）
- `src/cards/_probe/timers.tsx`（打字机卡 / 倒计时卡）
- `scripts/probes/stage-content-probe.mjs`

**改动**

- `src/render/Stage.tsx`：六个可选 prop、四种类与平面、`remountGen` 的 key 与 `playToken`、四支 `t` 的冻结
- `src/render/FrameScene.tsx`：`mediaMode` 与全部新 props、live 素材层、`PixelMappedMedia` 的 live 分支、`legacyTimeline` memo
- `src/render/pinAnimations.ts`：`resetIn` / `syncIn` / `sync(nowMs, skip)`
- `src/render/stageClock.ts`：接管 `setTimeout` / `setInterval` / `clearTimeout` / `clearInterval`，补 `__pcRealSetInterval` / `__pcRealDateNow`，`set` / `maxCatchUp` 削起点改走 `jumpTo`（不结算），`tick` 先结算定时器再跑 rAF，新增 `pendingTimers()`
- `src/kernel/pinEntropy.ts`：接管前存一份 `__pcRealDateNow`
- `src/kernel/clock.ts`：两个新 `window.__pcReal*` 的类型
- `src/kernel/project.ts`：`nextVideoLayerAfter` 加可选谓词 `skip`
- `src/editor/preview/MediaLayers.tsx`：改从新位置 import，只剩摆位和声音层
- `src/cards/_probe/index.ts`、`src/cards/capabilities.json`：注册两张探针卡
- **`src/StageView.tsx`**（动了哪几块，见下）
- **`src/editor/Preview.tsx`** / `src/editor/previewMode.ts`（最小接线，见下）

### `StageView.tsx` 动了哪几块（避开了 R4b 的地盘）

1. 文件头常量区：新增 `LIVE`（`?preview=stage`）、`AWAIT_FALLBACK_MS`、`realSetTimeout`。
2. `ref.current` 的初值：`snapshots` / `suppressed` / `streamPlanes` / `awaiting` / `settling` 改成**整份替换**的只读集合，新增 `awaitTimer` / `remountGen`；加 `bumpPlanes` reducer。
3. 组件级新增 `skipWrappers()`（`useCallback`）和 `onMediaFrame()`（`useCallback`）。
4. 大 effect 里新增三个局部函数 `commitPlanes` / `applySnapshots` / `setAwaiting`（紧挨着原来的 `abortPending`）。
5. 八处 `pinner.sync(ms)` → `pinner.sync(ms, skipWrappers())`。
6. `setTime` 里那三行 snapshots / awaiting 的处理（**在 `flushSync(setT)` 之前**，同一次提交生效）；`setTime` 的文档注释。
7. `setRole` 的清理体；`setSuppressed` / `setStreamPlanes` / `setScrubbing` / `setPlaying` / `setMediaT` / `setSnapshots` 六个方法体。
8. 两处 `window.setTimeout` → `realSetTimeout`（legacy 的 `SETTLE_MS` 防抖、采样防抖），卸载时多清一个 `awaitTimer`。
9. 返回的 JSX：`LIVE ? <FrameScene … mediaMode="live" …/> : <Stage …/>`。

**没碰**：`render` 的探针分支（`opts.probe` 的两趟、`steps` / `snapshot` 计时、`abort` 里的封顶）一个字都没动；`setTime` 里 `if (opts.probe)` 那一块也没动——R4b 要往这两处加 `vtOk` / `seekOk`。

### `Preview.tsx` 动了哪几块

1. import 多一行 `useSyncExternalStore` + `isScrubbing / subscribeScrub`。
2. `mediaRects` 里加一句 `if (dual) return []`（素材段已经在舞台的 `rects()` 里，再补一份会同一个 clipId 出现两次）；依赖数组加 `dual`。整个 `useCallback` 删掉是 R7（D5 的「删主文档的 `mediaRects`」）。
3. 新增两个 effect：向**两个**舞台下发 `setScrubbing` / `setPlaying` 和 `setMediaT`（E3：素材层 `mediaT = t`，两种角色一样）。父页什么时候发 `setSnapshots` / `setSuppressed` 是 R5 的事，没做。
4. `previewMode.ts` 的 `stageSrc`：开了双舞台才在 iframe src 上带 `&preview=stage`。

`Preview.tsx` 的 rAF 播放循环（`:125-167`）一个字没动（E6 的拆分属于 R5）。

## 验收

| 项 | 结果 |
|---|---|
| `npx tsc -b --force` | 零错误 |
| `npm test` | **1564 / 1563 通过 / 0 失败 / 1 跳过**（main 基线 1547 / 1546 / 0 / 1，新增 17 条：pinAnimations 7 + virtualTimers 10） |
| `placeholder` 模式全长导出逐字节不变 | **90/90 逐字节相同**，见下 |
| `scripts/verify-bake-protocol.mjs` | PASS（25 个 `window.__*` 全部对上） |
| 新探针 `stage-content-probe.mjs` | 3 次全过，`fails: []`；21 条断言 |
| E4b 打字机卡 | 补跑到第 3 秒**恰好 30 格**（3 次一致），`text.length` 也是 30 |
| E4b 倒计时卡 | 续推 10 秒后**恰好少 10000 ms**（3 次一致） |
| `editor-preview-smoke.mjs`（legacy） | PASS，`fails: []` |
| `editor-preview-smoke.mjs --stage` | PASS，`fails: []` |
| `stage-rpc-probe.mjs --legacy` | PASS，`fails: []` |
| `stage-rpc-probe.mjs`（跨源，即 `--stage` 口径） | PASS，`fails: []` |
| `scripts/verify-unified-frames.mjs` | **不过，且和本步无关**，见下 |

端口：dev server **5241**（舞台端口 5242 / 5243），导出基线树另起 **5244**（它的舞台端口 5245 / 5246）。跑完全部关掉，已确认 5241～5246 无监听。没碰 5190～5199 / 5201 / 5211～5239 / 5251～5259。

### 导出逐字节对账（`placeholder` 模式）

做法照 R1 报告：`git worktree add --detach .claude/worktrees/r3-export-baseline 62810bb`（**基线取的是我的 merge base，不是当前 main**——main 在我动工后已经前进到 `1e71401`，拿它当基线会把别人的改动混进来）。**没建 junction、没 `npm ci`**：新 worktree 放在主仓库树里，Node 往上找就命中 `C:\Users\admin\Documents\PromptCut\node_modules`。跑完 `git worktree remove --force`，主仓库 `node_modules` 182 项完好，之后又跑了一遍 `tsc` + `npm test` 确认。

算例：`scratchpad/r3-export-fixture.json`，1920×1080 / 30 fps / 3 秒 / **90 帧**，含普通视频段、带像素映射的视频段（`1 - r` 反色、`mediaOffset: 1`）、粒子卡（canvas）、odometer（stateful）、chapter-bar（Motion + layoutId）、punch-pill（带 `emphasis`）。`--workers 1 --no-video`。

| 对账 | 结果 |
|---|---|
| baseline#1（冷起）vs candidate#1 | 55/90 相同、35 帧不同 |
| baseline#1（冷起）vs baseline#2 | **同样 55/90、同样 35 帧、逐帧 sha 一模一样** |
| baseline#2 vs candidate#1 | **90/90 逐字节相同** |
| baseline#2 vs baseline#3 | 90/90 |
| baseline#3 vs candidate#2 | 90/90 |
| candidate#1 vs candidate#2 | 90/90 |

即：**每棵树的第一趟（dev server 冷起）和之后的趟不一样，而这件事和代码无关**——baseline#2 的每一帧 sha 和 candidate 完全相同，说明第一趟是 dev server 的冷启动产物（首处差异 (1349,739) 落在 punch-pill 的文字框里，是字体没就绪那一帧）。**去掉冷启动那一趟之后，两棵树四趟两两 90/90 逐字节相同。**

### `verify-unified-frames.mjs`：先前就红，不是本步造成的

- 直接跑会打 `127.0.0.1:5192`（在禁用端口段里，而且它**不自己起 dev server**，只读 `PC_FRAME_TEST_URL`）。用 `PC_FRAME_TEST_URL=http://127.0.0.1:5241` 跑，失败在 `scripts/verify-unified-frames.mjs:46` 的 `'mov' !== 'rendered'`。
- 在**基线树 62810bb** 上用同样的办法跑（打 5244），**同一行、同一条断言、同一个值**失败。
- main 上 `eec7a08`（在我的 merge base 之后）正是修这两处过期写法的提交，其提交说明还写明最后一条断言在 `7f10ebe`（R1 之前）上同样不过。

结论：这条是既有红，和 R3 无关；R3 没让它变坏。**建议**：R5 之前把 `eec7a08` 带进来再把这条纳入每步收尾。

### 新探针覆盖到的 21 条

1. `?preview=stage` 真的进了 iframe 地址（live 路生效的判据）；
2. E7 四条样式规则已注入（`style[data-pc-planes]`，4 行）；
3～6. 快照**挂上 / 换另一帧 / 摘掉**：组件 DOM 根是同一个元素对象（挂了 `__pcProbeMark`）、内部状态（打字机格数）一格不丢、`.pc-snapshot` 跟着快照来去、换帧是同一个平面 `innerHTML` 的原子替换（平面数恒为 1、前后两张不共存）；
7～8. `.pc-snapshot` 子树 `display:none`、快照平面放过；摘掉后平面没了、组件露出来；
9～13. 抑制：`.pc-suppressed` 挂上、子树 `display:none` 而平面放过；粒子卡 `<canvas>` 的 `toDataURL` 在 t=2.0→3.0 之间**一字不变**（传给组件的 `t` 冻住了）；包裹层 `data-pc-local-frame` 从 `60` 变到 `90`（`cardT` 的其余用途照常用实时值）；`hitTest` 仍命中 `c-par`；
14～17. `.pc-awaiting`：由 `setTime({ awaiting })` 挂上、是 `visibility:hidden`（`display` 仍是 `grid`）、**500 ms 后自动摘掉**且露出的是同一个活组件、快照到达时立刻换成 `.pc-snapshot`；
18. `.pc-settling` 的可见性契约（`visibility:hidden`、`display` 不变）；
19～21. 素材层：视频 `readyState=4`/`320×240`/取样 456 色、图片 `128×128`/230 色、像素映射 canvas 472 色且无 `data-pc-pixel-error`；`rects()` = `["c-pixel","c-image","c-video"]`（含素材段、无重复）；带像素映射的段和图卡节点接管的段都不被 `VideoTrack` 再画一遍。

耗时类数字（3 次中位数）：后台舞台把打字机卡从挂载帧补跑到第 3 秒（90 帧）**81.5 ms**（77.2 / 81.5 / 94.9）。

## 对任务书的更正建议（原句 → 怎么做的 → 为什么）

1. **E4b 的 `Date.now`**
   原句：「`Date.now = () => epochAtStart + now`（`epochAtStart` 取舞台打开那一刻的真实时间，显示日期的卡仍是正常日期）」。
   怎么做的：**没有另写一份**，沿用已经落地的 `src/kernel/pinEntropy.ts`——它把 `Date.now()` / 无参 `new Date()` / `Date()` 钉成 `PINNED_EPOCH_MS`（2026-01-01）+ 当前帧毫秒，而「当前帧毫秒」读的正是 `__pcStageClock.now()`，舞台和导出页同一份。`stageClock` 只在接管前把真的那份存进 `__pcRealDateNow`。
   为什么：`epochAtStart` 用真实纪元会让**预览和导出的日期卡显示不同的日期**（导出页只有 `__pcExportMs`，没有「打开那一刻」），直接破「预览所见 = 导出所得」；而 E4b 自己就要求导出页同享这套、导出基线不许变。建议任务书把这条改成「沿用 `pinEntropy` 的固定纪元」，并把「显示日期的卡仍是正常日期」记成已知取舍。

2. **E4b 的「导出页同一份 `stageClock`」**
   原句：「导出页同一份 `stageClock`，导出的确定性同样受益……导出像素基线不许变，要验。」
   怎么做的：**定时器那一半只装在舞台**（`?stage=1`），导出页仍是真 `setTimeout` / `setInterval`；Date 那一半两边已经共用（见上）。导出逐字节对账已验，90/90。
   为什么：导出页**自己的**墙钟定时器就有三处会死锁——`render/snapshotSettle.ts:14` 的 `await new Promise(r => setTimeout(r, 0))` 排空循环（虚拟时钟不推进就永远不响，`settleDom` 直接挂死）、`render/frameMedia.ts` 的 20 秒图片超时、`render/prerender.ts:44` 的重试退避。要让导出页共用必须先把这三处改成真定时器，那是一次独立的、有像素风险的改动，和 R3「导出逐字节不变」的硬验收直接冲突。**好消息**：仓库里三张用过定时器的卡（`number-ticker` / `typing-animation` / `word-rotate`）早就改成了 rAF + `performance.now`，所以今天导出页和舞台在这一点上没有分叉。建议把「导出页共用 fake timers」单列成一条，放在 R5 或 R7，并把上面三处一起改。

3. **E7 第 1 条的过滤清单**
   原句只点名「用 `!graphVisualNode(graph, clip.nodeId)` 滤掉被图卡接管的素材段」。
   怎么做的：`takenByOther(clip)` 同时滤掉 **带 `clip.pixelMap` 的素材段**，并把它下推给 `nextVideoLayerAfter` 的 `skip`。
   为什么：E7 同一条又要求「带像素映射的素材段在 live 路照 `placeholder` 路的 `PixelMappedMedia` 画」。两条并存的话同一段素材会被 `VideoTrack` 和 `PixelMappedMedia` 各画一遍（上下叠两层、还多一路解码）。建议把这句补进任务书。

4. **`PixelMappedMedia` 在 live 路不能原样照搬**
   原句：「带像素映射的素材段在 live 路照 `placeholder` 路的 `PixelMappedMedia` 画」。
   怎么做的：给它加了 `live` / `playing` / `scrubbing` 三个 prop——live 下源素材才挂 `src`、`preload="auto"`，自己经 `driveMedia` 跟播放头对齐，每次渲染重画一次并补注册 rVFC / `onLoad`。
   为什么：`placeholder` 路的源素材**刻意没有 `src`**（推进 React 时绝不能 seek/解码），截图那一步才由 `__pcPrepareFrameMedia` 装回来。原样照搬到舞台上就是一块永远空白的 canvas。`placeholder` 分支的 DOM 一个字没改（导出 90/90 证明）。

5. **`.pc-suppressed` 下的 `hitTest`**
   原句（E7 第 5 条）：「包裹层留在布局树里，几何不变，`rects()` / `hitTest` 照常能点中被抑制的卡。」
   怎么做的：探针里按「抑制 + 有快照平面」验的，这时 `hitTest` 命中。
   为什么：`.pc-suppressed` 是 `display:none`，子树不参与绘制，`elementsFromPoint` 也就取不到它；**能点中靠的是流平面或快照平面**（两者都被那条规则放过）。`rects()` 只要包裹层，任何时候都成立。「有流分段时父页不投快照」那一档靠流平面，R8 之前恒空——**所以在 R8 之前，「抑制 + 既没流也没快照」的卡是点不中的**。建议任务书把这条写成「贴着平面时点得中」，并说明 R8 之前的空档。

6. **探针卡的位置**
   原句：「测试卡放 `src/cards/_probe/` 下，别进正式注册表的高频清单」。
   怎么做的：放在 `src/cards/_probe/`，和已有的 `probe` 卡一样经 `probeCards` 注册。
   为什么：**「高频清单」今天就是 `allCards()` 过滤掉非 featured 粒子卡**（`snapshot-size-probe.mjs:137`、`probe-card-costs.mjs:235`），而 `_probe/` 下的卡本来就在 `allCards()` 里（`probe` 卡已有先例，`capabilities.json` 里也有它的条目）。要真的把它们挡在清单外，得在那两个脚本里按 id 前缀或 `source` 过滤——那是 R4 的地盘，我没动。建议任务书把这条改成「`_probe/` 下的卡由探针脚本按前缀排除」，或者由 R4 在两个清单函数里加一句 `!id.startsWith('probe')`。

7. **`?preview=stage` 要进 iframe 的 src**
   任务书里没写这一条（`previewMode.ts` 的注释还特意说「`Preview` 从来不把 `preview` 参数传进 iframe」），但 R3 的验收又写着新探针打 `?preview=stage`。
   怎么做的：`stageSrc` 在 `dualStage()` 为真时才加 `&preview=stage`，`StageView` 读它决定 live / 照旧。
   为什么：舞台页自己看不到父页的 `?preview=stage`；不传的话「新行为只在非 legacy 下生效」没有落点——要么全体切 live（改了缺省行为），要么永远切不过去。建议把这一句补进 E7 / D5 的回滚开关那段。

8. **`mediaReady` 只由 `back` 报**
   原句（E0）：「`{ type: 'mediaReady', sec }`（K5 第 (4) 步，`back` 素材层画出一帧后）」。
   怎么做的：`StageView` 里显式 `if (ref.current.role !== 'back') return`。
   为什么：`front` 播放时每解出一帧都会回调 rVFC，不闸门就是每秒几十条 postMessage。父页的 `event.source` 过滤只解决「认谁的」，不解决「发多少」。

## 没做成 / 留给 R5 的事

- **`settling` 没有驱动**：`Stage` / `StageView` 的 `settling` 表、`.pc-settling` 类、`pinner.syncIn` / `sync(skip)` 都就位了，但「谁把片段放进 `settling`、每步推多少」是 K5 第一路（R5）。探针里 `.pc-settling` 只验了样式契约（手动加类看计算样式）。
- **`remountGen` 没有驱动**：`Stage` 的 key 和 `playToken` 已经读它，`StageView` 里恒是空表（退回整舞台 `playToken`）。填它是 K3 的重挂载定位配方（R5）。
- **`streamPlanes` 恒空**：单卡流平面（包裹层里的 `[data-pc-stream-plane]`）和组流平面（舞台根下的 `[data-pc-group-plane]`）的渲染位置、尺寸、z 序都就位，`streamPlayer` 是 R8。
- **`localHashes` 只存不用**：E7 把它列进 `FrameScene` 的 props，但换档那条路在 A1 / L，R3 没有消费方。
- **`play` / `pause` 仍回 `unsupported`**：K4 的节拍循环是 R5。
- **父页不发 `setSnapshots` / `setSuppressed`**：C4 的选帧和投递节流是 R5 / R6，R3 只把舞台侧的收端做完（探针直接调 RPC 验的）。
- **图卡接管素材段只验了一半**：仓库里现在**一张 `def.card` 的图卡都没有**（H 还没落地），所以探针只能验「`VideoTrack` 不画它」，验不了「图卡把它画一遍」。等 H 之后补。
- **`Preview.tsx` 的 rAF 播放循环、E6 的 effect 拆分**：按任务书归 R5，没动。E6 里「舞台没有墙钟模式」这一条在舞台侧已经成立（`StageClock` 只有 `driven`，没有 `setMode` / `patchAnimate` 的 live 分支 / `AnimationPinner.release` / `clockSec` 心跳）——已确认，无改动。
- **`verify-unified-frames.mjs`**：先前就红（见上），建议先把 main 的 `eec7a08` 带进来。
