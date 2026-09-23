# R7b 实现报告

分支：`worktree-agent-a103fc9e09e475a07`
起点：main `af69c3a`（开工时）。**干活期间 main 走到了 `e4ab1b1`**（只改文档：
pinned 渲染 2 / 4 按弹窗确认的原文对齐、路径表回填、四条决定记入交接）——
本分支**没有**把它合进来（硬性规则「不合并」），合并由主会话做，没有代码冲突。

范围：把独立复核（`hunman_read.md` / `task_recheck.md`）查出的「不符合 pinned 目标的
5 处」和 1 条回归修掉，并顺手清 R5～R7 的零碎。都在已完成的 R5～R7 范围内，不是新功能。

---

## 0. 提交

| 提交 | 内容 |
|---|---|
| `09d6653` | 开工：建立实现报告骨架 |
| `96fd93d` | **必修 1（渲染 9）** 预渲染进程真的按 `prerenderSet` 挑卡 |
| `6273325` | **必修 2（架构 7）** 项目选项加 fps 下拉，切 fps 重走遮罩 |
| `a4ddbd9` | **必修 3 + 4 + 6** settle 补发、`mediaStalled` 按拍长判、播到头能重播 |
| `4401404` | **必修 5（渲染 4）** K3(b) 的追帧代价按播放位置估 |
| `575408d` | 顺手清：S39-8 过期文案、S38-6 探针引用的文件不存在 |
| `edde840` | 顺手清：R6-7 换项目时清就绪索引、R6-14 超限帧下一趟跳过 |
| `88b89de` | 顺手清：R7-6 `?preview=legacy` 也传进舞台 iframe |
| `25a6477` | 顺手清：R5-15 连点不丢最后一次、R5-11 两次失败要降级、R5-12 判轻的卡也补跑 |
| `47b9466` | 探针：playback 的时间轴一节先关掉自动弹出的 AI 设置对话框、鼠标坐标裁进视口 |
| `5728c5d` | 探针：probe-gate 的 fps 一节同样先关对话框 |
| `3e2c6c5` | 探针：ready-index 第 ⑨ 条按「这张卡没被挑中」找、删目录挪到重算之后 |
| `5a86c02` | 本报告 |

**必修 3、4、6 本该分三个提交，失手一起 `git add -A` 了**，合在 `a4ddbd9` 里；
三件事互不依赖，提交说明里逐条写清了。

---

## 1. 六条必修各修成什么样

### 必修 1 —— 渲染 9 / R6-2：预渲染进程按 `prerenderSet` 挑卡

**病**：`entry.prerenderSet` 在 `frame-pipeline.mjs` 里**只写不读**，判轻的 stateful
卡照样逐帧产快照、进就绪索引；用户定过的「两张超 300 KB 的 lottie 卡根本不生成快照」
实际不成立。

**改法**：新 `prerenderPicked(entry, clipId)`，把集合接进**四个**消费点：

| 消费点 | 以前 | 现在 |
|---|---|---|
| `snapshotTargets` | 全部有共享键的 stateful 卡 | 不在集合里的拿不到 target，整场景路（`recordSnapshots` / `renderLocalSnapshots`）对它什么都不产 |
| `missingSnapshotFrames` | 遍历全部卡算缺帧 | 判轻的卡不算「缺帧」，整场景那一趟不为它多渲 |
| `fillCardControls` | `snapshotTier(caps)` 按 `frameMode === 'stateful'` 挑 | 不在集合里就 `target = null`：不写快照、不更新 `index.json`、不发 `layer` |
| `adoptCardPlan` 的 `readyIndex.claim` | 全部卡认领层 | 判轻的卡不进就绪索引 |

- 集合**压根没算过**（没走过 `adoptCardPlan`，比如手工构造 entry 的调用方）时不过滤，
  行为和接上之前一致；**一条成本记录都没有**时 `prerenderSetOfPlan` 自己按声明兜底
  （`declaredHeavy`），口径一个字没改。
- **PNG 那一支照旧**（`entry.cardCache` / `html-manifest.json`）：它是 legacy 整帧通道
  和 `renderState` 的料，断了 `?preview=legacy` 就缺画面。所以「判轻的卡不再产**快照**」
  是完整做到的，「判轻的卡不再被渲」只做到快照这一半 —— 见第 5 节「没做成的」。
- `diagnostics()` 加 `plans`：每个 entry 的集合 + 每张卡的 `costKey` / `tier` / `picked`。
  探针靠 `costKey` 才能为某张卡写成本记录（那个键只有 `card-cache.mjs` 的 `plan()` 算得出来）。

**证明它的断言**（`ready-index-probe` 第 ⑨ 条，实跑退出码 0）：

```
planBefore  prerenderSet = [clip-canvas, clip-huge, clip-stateful, clip-unknown]   ← 没有成本记录，按声明兜底
（给 clip-stateful 写一条便宜的随机访问记录，其余三张钉死为重）
planAfter   prerenderSet = [clip-canvas, clip-huge, clip-unknown]
            picked       = [[clip-huge,true],[clip-unknown,true],[clip-canvas,true],[clip-stateful,false]]
layersB     = ["clip-canvas/html", "clip-unknown/local"]      ← clip-stateful 不在就绪索引里
statefulDirBack = false   canvasDir = true                     ← 判轻的那张快照目录删掉之后没长回来
```

单测 +6（`server/test/prerender-schedule.test.mjs`）：拿不到 target、集合是 `undefined`
时不过滤、空集合一张都不产、集合换了缓存跟着换、不算缺帧、诊断露出 costKey。

### 必修 2 —— 架构 7 / P-2：项目选项的 fps 下拉

- `src/editor/ProjectSettingsDialog.tsx` 加「帧率」一行：原生 `<select data-pc="fps-select">`，
  四档 **24 / 25 / 30 / 60**，新项目默认 30，确定时随画幅一起走 `setProjectMeta({ fps })`。
  样式新增 `.pc-dialog-select`，规格照 `.pc-dialog-input` 抄同一套主题变量
  （`--ui-border-strong` / `--ui-panel-2` / `--ui-fg` / `--ui-accent`），**没有新的固定配色**。
  工程文件里存着别的帧率（手改过）时下拉退回 30，别的字段不动。
- **切 fps 重走 `ProbeGate`**（R4b 报告记的「切 fps 后重走遮罩」，一直没做）：
  `probeRunner.syncProbeRun` 发现新旧项目 fps 不同就把 `firstPassDone` 拨回 false。
  理由写在代码里：`cardCostKey` 把 fps 吃进了身份键，换帧率之后全部卡的记录都失配、
  要重测一整轮，预算 `B = 1000/fps × 70%` 也跟着变。

**证明它的断言**（`probe-gate-probe` 第 7 条，实跑退出码 0）：

```
fpsSelect        {"value":"30","options":[24,25,30,60]}
fpsAfterConfirm  60
gateAfterFpsChange  true            ← 确定之后遮罩重新出现（MutationObserver，一帧都溜不过去）
costs60          {"count":2,"sample":[{"fps":60,"stepMs":0.3,…},{"fps":60,"stepMs":0.3,…}]}
```

### 必修 3 —— 架构 9 / R5-16（顺带 R5-4、R5-3）：点时间轴、拖动松开后真的发 settle

**病**：`Preview.tsx` 唯一发 settle 的那个 effect 依赖里没有 `scrubbing`，去重键也不带它。
拖动松开时松手坐标通常等于最后一次 flush 的位置（`t` 没变、effect 不重跑）；在标尺上点
一下时 `seek` 和 `beginScrub` 批成一次渲染，那一刻 `scrubbing` 已经是 true、发出去的是
不带 settle 的 `setTime`，松手又因为位置没变不再补发。两种情况下 K5 两路都不启动。

**改法**：
1. 去重键加一位 `dual && scrubbing`，依赖补 `scrubbing` —— 拖动 / 点击结束那一刻键必变，
   补上一条 `setTime(t, { settle: true })`。legacy 下 `dual` 为 false，后缀恒定、不会多发。
2. 顺带修 **R5-4**：`playing` 翻 false 的那一次这个 effect 不再抢着按 `store.t` 发 settle
   （新 `wasPlayingRef`）。收尾仍由下面那个 effect 按 `pause()` 回包的 `stoppedAt` 发。
   播放到头（`ended`）走的是同一段，**R5-3 记的「重复启动 K5」一并没了**。

**证明它的断言**（`playback-probe` 新 `--only 时间轴`，用**真的鼠标**）：

| | 实跑 |
|---|---|
| 点标尺 | `t` 1 → 3.23，`settled` 到达（`clickSettled: true`） |
| 按住拖一段松手 | `t` → 11，`settled` 到达（`dragSettled: true`） |
| 松手之后 | `.pc-settling` / `snapshots` 都摘干净 |

**反向对照**（把去重键那一位临时去掉再跑同一条）：

```
fails: ["点时间轴之后 settled 到达(判重卡追成精确活渲) :: …clickSettled:false…",
        "拖动松开之后 settled 到达 :: …dragSettled:false…"]
```

—— 两条都红，证明断言真的在测这一位，不是碰巧过。

### 必修 4 —— 架构 10 / R5-6：`mediaStalled` 在 24 / 25 fps 下误触发

**选哪个判据、为什么**：任务给了两条路（`max(40, 1000/fps) + 容差`，或「连续两拍超时」），
**我两条都没直接取，取的是第一条的干净形式**：

> 阈值仍是 pinned 钉死的 **40 毫秒**、不按帧算；改的是**被判的那个量** ——
> 从「相邻两条 `frame` 的到达间隔」改成「到达间隔**超出一拍名义时长**的部分」：
> `now - prev - 1000/fps > 40`。

理由：
- 一拍本来就要 `1000/fps` 毫秒，把它算进「卡顿」是**把正常节拍当成了停顿**。60 Hz 屏上
  24 / 25 fps 的拍排不进 16.7 ms 的格子，实际到达是 33 / 50 交替（`StageView` 的节拍
  循环注释自己也这么说），按总间隔判每隔一拍就误判一次、音频每 ~80 ms 暂停恢复一次。
- 这个式子等价于「阈值 = `1000/fps + 40`」，也就是任务第一条里 `容差 = 40`、
  基准取 `1000/fps` 的版本。**pinned 原文一个字没动**：「停顿超过约 40 毫秒就暂停音频」
  —— 一次 40 ms 的停顿加在正常一拍上就是这个式子，语义和 pinned 更贴。
- **没选「连续两拍超时」**：真正的一次卡顿（比如 300 ms）只产生**一条**迟到的 `frame`，
  下一拍就准时了，要求连续两拍会让它永远判不出来 —— 那是把漏报换掉了误报。
  现在这条对 24/25 fps 的正常节拍（超出 8.3 / 10 ms）不触发，对 300 ms 的真卡顿
  （超出 266 ms）照样当场触发，判出的时机和以前一样。
- `mediaSync.ts` 的 `IN_SYNC_SEC = 0.04` 是另一件事（素材元素的漂移容差），没动。

**量出来的数**（`playback-probe --seconds 10`，一档播 10 秒，最后一趟全绿）：

| fps | 拍数 | `mediaStalled` 触发次数 | 最大「超出名义拍长」 |
|---|---|---|---|
| 24 | 241 | **0** | 11.6 ms |
| 25 | 251 | **0** | 13.4 ms |
| 30 | 301 | **0** | 3.1 ms |
| 60 | 601 | **0** | 5.1 ms |

（四档 `secDiffWrong` 全 0、主文档长任务全 0。另外两趟的最大超出量分别到 21.3 / 23.3 /
32.6 / 17.5 ms 和 12.6 / 12.9 / 4.4 / 3.8 ms，都没越 40。）

`__pcPreviewDiag` 新增 `mediaStallCount` / `mediaGapMaxMs` 两个读口。

### 必修 5 —— 渲染 4：K3(b) 按播放位置估实际要追的帧数

**病**：`stageSwap.guessCatchUpMs` 取的是成本记录里的**整段** `catchUpMs`（从第 0 帧冲到
最后一帧的总代价）。播放头刚进入一个 60 秒的长 motion 时按它估，K5 第二路的目标拍 `T`
会被推出去好几秒：可见舞台白等，那张卡在 `suppressed` 里多透明一大截。

**改法**：新纯函数 `src/render/catchUpEstimate.mjs` 的 `catchUpEstimateMs(record, frames)`：

```
t_c = frames × t_oc        frames = (t − clip.start) × fps
t_oc = record.stepMaxMs（K1 量的「推帧过程中最慢一帧」），没有就退回 p90 的 stepMs
封顶在整段 catchUpMs 上（单帧最差乘满整段比实测还悲观）；算不出位置就退回整段代价
```

**只改「追多少」这个实际取值**：K2 的轻重分派仍按整段最差判（pinned 渲染 3、`clipWeight`
一个字没动）。单独抽一个 `.mjs` 是为了能 `node --test`（`stageSwap.ts` 那一侧要卡片注册表
和 store，进不了 node，见第 5 节）。单测 +6。

> **和 main `e4ab1b1` 的 pinned 更新一致**：那一版把渲染 4 补成了
> 「这个按位置的 t_c 只用于算播放头落在 t 时实际要追多少帧；轻重分派仍按渲染 3 的整段最差
> 代价判」—— 和本条的实现逐字对上，「渲染 4 被渲染 3 取代」那条待拍板的已经不冲突。

### 必修 6 —— R7-11 回归：播放头在末尾按播放要从头重播

**病**：非 legacy 下直接 `s.play(tRef.current)`，舞台第一拍就 `rawSec >= duration`、
立刻 post `ended`，按下去什么都不发生。legacy 的墙钟循环一直会从最早那张卡重播。

**改法**：新 `playStartOf()`——播放头在第一张卡之前、或已经播到头，就回到 `contentStart`
（和 legacy 循环 `Preview.tsx:155-158` 逐字同一条规矩），并同步写 store，时间轴跟着回起点。

**证明它的断言**（`playback-probe` 的「到头」一节末尾新增「到头重播」）：

```
{"frames":25,"firstSec":0.0333,"lastSec":0.8333,"endedAgain":0,"state":{"t":0.8333,"playing":true}}
```

—— 播到头再按播放：收到 25 条 `frame`、第一条 `sec` = 0.033（< 0.5，从 0 起）、**不再立刻 ended**。

---

## 2. 顺手清了哪几条

| 条目 | 做了什么 |
|---|---|
| **R5-12** | 新 `staleOnBackCatchUp()` = `needsBackCatchUp` ∪ `playingCatchUpTargets`，`runSettleSwap` 按它判。判轻的 (b) 档 `vtOk=false` 卡在暂停 / 跳转 / 拖动松开下也会被后台补跑。第二路本来就是整场景补跑再互换，多收这一类不多花一分钱。 |
| **R5-11** | 两次都追不上走 `giveUp()`：对每张卡 `onStageDemote`（K6 整条 PUT `capped` + `demoted`、就地并进 plan），并且**不清** `extraSuppressed` —— 它活渲出来的状态本来就是错的，死素材就绪前留在 `suppressed`（透明），这是计划明写的例外。 |
| **R5-15** | `runSettleSwap` 运行中来的新请求不再丢：记下**最后**那一次（`pendingSettleT`），当前这次完成或中止之后按它再做一遍；中间被盖掉的本来就不用做。 |
| **R6-7** | `ready-index.mjs` 的 `reset()` 以前没有调用方。`adoptCardPlan` 按 `entry.key` 变没变补一次 `readyIndex.reset(localRev)`，换项目 / 改编排时页面清表，已删片段的旧层不残留。单测 +1。 |
| **R6-14** | `index.json` 加一份 `oversize` 区间名单（为空时**不写**这个字段，老文件原样读得回来）：`snapshotIndex` 回 `{count, frames, oversize}`，`updateIndex` 收 `oversize`；`rebuildIndex` 留着旧名单（盘上有帧文件不代表它合格）；`missingSnapshotFrames` / `fillCardControls` 的缺帧和 `htmlComplete` 都把 `oversize` 算成「已经处理过」；三条产快照的路都记帧号。跨进程留得住。单测 +2。 |
| **R7-6** | `stageSrc` 在 legacy 下带 `&preview=legacy`，`StageView` 里那个同名的 `LEGACY`（`setProject` 立刻按跳转重算这一帧）终于生效。端口没起来的退回**不传**（那不是回滚、是双舞台开不出来）。`reveal-probe` 的「回滚」一节加两条断言：iframe 的 `src` 带 `preview=legacy`、舞台页自己的 URL 也是 legacy。实跑：`"src":"/?stage=1&id=A&preview=legacy"`、`stageUrl: "http://127.0.0.1:5301/?stage=1&id=A&preview=legacy"`。 |
| **S39-8** | `server/tools/effects.mjs:107`、`src/mcp/tools/pixelMapTools.ts:73` 的「1080p 每帧 400 毫秒以上」是 CPU 逐像素循环时代的数，R1b 改走 WebGL 之后会误导 Agent 不敢用像素映射。改成描述现在的实现；「整帧调色请用 create_filter」的分流结论不变。全仓库 `grep "400 毫秒"` 零命中。 |
| **S38-6** | `scripts/probes/inherited-props-probe.mjs` 还 import `src/render/freezeStyleProps.mjs`（3.8 改名拆文件之后在 `src/render/snapshot/snapshotStyleProps.mjs`），一跑就崩。路径和两处文案一起改，**实跑通过（退出码 0）**：表里 124 个、Chrome 证实继承 101 个、没定论 23 个。 |

---

## 3. 验收数字

### 3.1 静态

| 项 | 结果 |
|---|---|
| `npx tsc -b --force` | **零错误**（退出码 0） |
| `npm test` | **1648 / 1647 通过 / 0 失败 / 1 跳过**（main 基线 1633 / 1632 / 0 / 1，**新增 15 条**） |

新增单测：`server/test/prerender-schedule.test.mjs` +8（渲染 9 六条、R6-7 一条、R6-14 一条）、
`server/test/snapshot-store.test.mjs` +1（R6-14 跨进程 + rebuildIndex 保名单）、
`src/render/catchUpEstimate.test.mjs` +6（新文件）。

### 3.2 探针（dev server 一律 5301，舞台 5302 / 5303；基线树 5304，候选 5307）

| 探针 | 结果 |
|---|---|
| `reveal-probe` | **全绿**（退出码 0）。24/30/60 fps 到达间隔均值 41.69 / 33.36 / 16.71 ms（想要 41.67 / 33.33 / 16.67），`secDiffWrong` 全 0、长任务 0；回滚两条新断言过 |
| `playback-probe`（全套） | **全绿**（退出码 0），10 个 case |
| `stage-content-probe` | **全绿** |
| `probe-gate-probe`（20 张卡） | **全绿**（退出码 0）。探针期间可见舞台 rAF p50 17.1 ms / p90 17.6 ms |
| `ready-index-probe` | **全绿**（退出码 0），九条 |
| `stage-rpc-probe` | **全绿**（缺省跨源） |
| `stage-rpc-probe --legacy` | **全绿**（同源） |
| `editor-preview-smoke`（缺省） | **全绿**（一探针一台新 server） |
| `editor-preview-smoke --legacy` | **全绿** |
| `editor-preview-smoke --stage` | **全绿** |
| `inherited-props-probe` | **全绿**（S38-6 修完实跑） |

**首轮有两条红、都是机器负载 / 探针自己的毛病，复跑全绿**：
- `reveal-probe` 首轮「60 fps 均值 20.4 ms」、`probe-gate-probe` 首轮「rAF 中位数 31 ms」：
  当时机器上还有别的活；安静下来复跑分别是 16.71 ms 和 17.1 ms。
- `playback-probe` 某一趟「30 fps 有 1 个短拍」（300 拍里 1 个 13.6 ms，`secDiffWrong` 仍是 0
  —— 父页收 postMessage 的抖动，舞台那边的拍是准的），同一条复跑两趟都是 0。

### 3.3 导出逐字节

`export-baseline-compare.mjs`：基线 = main `e4ab1b1` 的临时 worktree（`--detach`）+ **它自己那棵树的**
`scripts/export-frames.mjs`，候选 = 本分支。两台 dev server（5304 / 5307），`TEMP` / `TMP` /
`PROMPTCUT_DATA_DIR` 各指一处，`--workers 1`、`--no-video`。
Fixture：1280×720 / 30 fps / 4 秒 = **120 帧**，`blur-text` 0–2、`mu-word-rotate` 2–4、
`chapter-bar` 0–4、`growth-curve` 1–3.5（不含素材，本轮改动一个字都没碰素材那一侧）。

```
逐字节：相同 120/120
✅ 全长导出逐字节相同
```

**不建 junction、不 `npm ci`**：临时 worktree 在仓库目录下（`.claude/worktrees/`），
`node_modules` 由 Node 向上解析到主仓库那一份。跑完 `git worktree remove --force`，
目录确认不存在（`ls .claude/worktrees/` 只剩两个 agent 树），`git worktree list` 里没有它；
删之前确认过它那个 `node_modules` 是**空的普通目录**（`LinkType` 为空、0 个条目），
主仓库依赖完好（182 个包、`node_modules/vite` 仍在）。

**静态佐证**：本分支相对 main 的代码改动是 `server/frame-pipeline.mjs`、
`server/snapshot-store.mjs`、`server/tools/effects.mjs`、`src/editor/{Preview,ProjectSettingsDialog,
previewMode,probeRunner,stageSwap}`、`src/mcp/tools/pixelMapTools.ts`、
`src/render/catchUpEstimate.*` —— `server/bakery/*`、`scripts/export-frames.mjs`、
`ExportView.tsx`、`FrameScene`、`render/Stage` **一个都没碰**。

### 3.4 端口

全程只用 5301（舞台 5302 / 5303）和基线树的 5304 / 5307（舞台 5305/5306、5308/5309）；
5190～5299 一次都没碰。收工时 5230～5320 没有任何监听（`Get-NetTCPConnection` 空）。

---

## 4. 对分册 / 文档的更正建议（我没改，留给你折）

1. **`r2-r7-task.md` A3a**（:88）写「`frame-pipeline.mjs:799` 进入循环前把不在并集里的
   control 从列表剔掉」。实现上**剔在四个点**而不是一个：`snapshotTargets`、
   `missingSnapshotFrames`、`fillCardControls`、`adoptCardPlan` 的索引认领 —— 整场景路和
   本地档路都不走 `fillCardControls`，只剔那一处等于只剔了三分之一。建议把那一句改成
   「四个消费点统一过 `prerenderPicked`」。
2. **同上**：任务书没说 PNG 那一支（`entry.cardCache`）要不要一起停。我**没停**（legacy 整帧
   通道和 `renderState` 还从它取料）。建议在分册里写明「渲染 9 只管快照 / 流 / 就绪索引，
   PNG 随 legacy 通道一起删」，否则下一个人会以为 CPU 也一起省下来了。
3. **`r2-r7-task.md` K4 的 `mediaStalled`**（:157）：「相邻两条 `frame` 到达间隔 > 40 ms」
   这句本身就是 24 / 25 fps 误判的来源。建议改成「到达间隔**超出一拍名义时长** 40 ms」
   并注明这和 pinned 架构 10「停顿超过约 40 毫秒」是同一件事。
4. **`r2-r7-task.md` K3(b)**（:156）：「实际要追的帧数按 pinned 渲染 4 的公式取」这句现在
   实现了，但分册没说 `t_oc` 取哪个字段。建议补「`t_oc` = `stepMaxMs`（单帧最差），
   没有就退回 `stepMs`；位置估算封顶在整段 `catchUpMs` 上」。
5. **`r2-r7-task.md` D5 / F2 的 `?preview=legacy`**：分册说「合并已有的同名开关」，但
   `previewMode.ts` 的文件头注释写的是「`Preview` 从来不把 `preview` 参数传进 iframe，
   所以这里加的值一个字都不影响它」——**注释和分册是冲突的**，我按分册改了代码、
   同时改了注释。建议把「有意不传」那句从历史里划掉。
6. **`snapshot-store.mjs` 的 index.json 契约**：加了 `oversize` 字段。分册 A3c 只写了
   「超限帧照常落盘、不进索引」，没写「怎么让下一趟别再重渲」。建议把这个字段写进契约。
7. **`docs/export-baseline-compare.md`**：第 1 节点名的 `make-fixture.mjs` 和那份
   `pc-baseline-fixture.mp4` 都只在当时的 scratch 里，仓库里没有，下一个人复现不了。
   建议把 fixture 生成脚本收进 `scripts/probes/`（本轮我另造了一份不含素材的 4 秒 fixture，
   放在 scratchpad，没进仓库）。
8. **`hunman_read.md` 的两处和代码对不上**（以代码为准，已在上面各条里写明）：
   - R5-6 说「判据是事后的……停顿进行中音频照播」—— 属实，而且**本轮没改这一点**：
     还是「迟到的那条 `frame` 到了才置 stalled」。要改成看门狗定时器得你拍板（复核也是这么建议的）。
   - R6-14 说「超限帧照常落盘（下一次不用重渲）不成立」—— 属实；本轮修的是「不用重渲」
     那一半（记名单），落盘那一半本来就是成立的。

---

## 5. 没做成的 / 明确留下的

1. **`stageSwap.ts` / `snapshotFeed.ts` / `demote.ts` / 节拍循环的最小单测：没做。**
   技术原因（不是没时间）：这三个 `.ts` 里 import 的是**无扩展名**的路径
   （`"../store/project"`、`"./planDispatch"`…），`node --test` 的 ESM 解析器不认，
   一 import 就 `ERR_MODULE_NOT_FOUND`。能被测到的 `stageJobs.ts` 之所以能测，是因为它
   自己的 import **全都写了 `.ts` 后缀**。节拍循环在 `StageView.tsx` 里，更进不去。
   **可行的路**：给这三个模块（和它们的传递依赖）的 import 补上 `.ts` / `.tsx` 后缀
   （`allowImportingTsExtensions` 已经开着，Vite 也认），是一次纯机械改动，但牵连面不小，
   不该和这一轮的行为修复混在一个分支里。本轮我把**能抽成纯函数的那一块**抽出来测了
   （`catchUpEstimate.mjs`，6 条），其余的靠探针断言覆盖。
2. **渲染 9 只停了快照，没停 PNG**（见 1.必修1 和 4.2）：判轻的卡仍会被 `fillCardControls`
   逐帧渲 PNG 进 `entry.cardCache`。要真的省下这份 CPU，得等 legacy 整帧通道删掉。
3. **R5-6 的「事后判据」没改**：还是「迟到的那条 `frame` 到了才置 stalled」，停顿**进行中**
   音频照播。要不要加播放中的 40 ms 看门狗定时器属于改 pinned 意图的范围，等你拍板。
4. **R5-11 的 `extraSuppressed` 跨播放不会自己清**：放弃那一次之后它留在集合里，直到下一次
   互换重新 `setExtraSuppressed`。正常路径上无害（降级生效后那张卡本来就该被抑制 + 贴快照），
   但如果 `onStageDemote` 的 PUT 失败、死素材永远不就绪，它会一直透明。没加兜底。
5. **四条等你拍板的一个字都没动**：`Date.now` 固定纪元、导出页不装虚拟定时器、抽 16 帧取 p90、
   渲染 4 是否被渲染 3 取代。（第四条 main `e4ab1b1` 已经按「两者并存、各管一段」定了，
   和必修 5 的实现一致。）
6. **`user_pinned_goal.md` 一个字没改**；`server/bakery/*`、导出路径、`restructure_planning/`
   下除本报告外的文档都没碰（更正建议全在第 4 节）。
7. **main 走到 `e4ab1b1` 之后没合进本分支**（硬性规则「不合并」）。`git diff main` 会显示
   `user_pinned_goal.md` / `future_planning.md` / `render_pipeline_restructure.md` 三个文件
   「被改」，那是主分支新加的文档，不是我动的。
