# AGENT 报告：claude/cadence-race

任务：查明并修好「导出时图卡的视频输入源偶发取到上一帧」。现象是节奏探针 `scripts/probes/video-source-cadence-probe.mjs` 偶发挂在 `①图卡 rate 0.5 offset 0.35` 第 51 帧，取到 35、应为 36。

分支 `claude/cadence-race`，起点 main `a76640d0`。子 Agent 是 opus-dev。

## 结论

- 根因已查明，在 Chrome 里。seek 完成后，新解出的帧要送两个地方：一路进视频元素的帧槽（`createImageBitmap(video)` 读的就是它），另一路通知主线程发 `seeked`。两路走不同的线程。机器忙时主线程可能先收到 `seeked`，这时当场取帧，拿到的还是 seek 之前那一帧。
- 修法：图卡取帧在 `seeked` 之后，再用 `new VideoFrame(video)` 读帧槽里那一帧的 `timestamp` 和 `duration`，核对它覆盖了 `currentTime` 才取；没覆盖就隔 1 ms 再看。核对只读时间戳，不等合成器回调，所以不会和 beginFrame 控制的导出器互相等住。
- 时间轴视频片段那条路（`src/render/frameMedia.ts`）有同类的漏洞，一并收紧了。
- 量化结果：最小复现探针在改前每两万次 seek 左右错一帧（312 000 次错 22 次），改后 396 000 次 0 错；其间核对当场拦下帧槽未换好 21 次，都等到了新帧。整套导出探针在满载下改前 20 遍挂 1 遍，改后 20 遍 0 挂。G0-R 在恢复后的末端重跑全过，像素基线不变，导出不变慢。中途有一次报告提交误把两个源文件还原成旧版，已恢复，受影响的验证已重做，见「验证」。

## 尺子

准备了两把尺子。

### 尺子一：整套导出探针 + 满载

新建 `scripts/probes/video-source-cadence-stress.mjs`。它起 N 个占满一个核的 node 死循环进程，然后把节奏探针连跑 K 遍（可以并行），最后数挂了几遍。负载进程由它自己起、自己收。

- 改前：`--runs 20 --hogs 16`（16 核机器），挂 1 遍，是第 19 遍：`①图卡 rate 0.5 offset 0:1 帧源帧号不符 [{"n":34,"got":16,"want":17}]`，同样取到了上一帧。前 10 遍每遍 88～126 s（当时主会话另有探针在跑，机器更忙），后 10 遍每遍 30～45 s。
- 改前另跑了一轮：页面里临时加了取帧日志，`--runs 30 --hogs 8 --parallel 3`，0 挂。日志本身改变了时序，这一轮不算数，也没保留那段日志代码。
- 这把尺子太钝：失败率约 1/20 遍、一遍半分钟到两分钟，改后 0/20 在统计上说明不了多少。所以又做了尺子二。

### 尺子二：最小复现探针（主尺）

新建 `scripts/probes/video-seek-race-probe.mjs`。它不起 dev server，也不走导出管线：

- 在受帧控制的 chrome-headless-shell 里，放一个不挂进文档的 `<video>`。素材是 30 fps，第 n 帧整幅灰度为 16 × (n mod 16)。
- 按 `①图卡` 两组的取帧时刻（rate 0.5，offset 0.35 和 0）反复「设 currentTime → 等 seeked → 取帧」。
- 每次取帧后同时读 `VideoFrame.timestamp` 和位图像素，两边互证。
- Node 侧每 4 ms 发一拍 beginFrame，与 `server/bakery/frame-ready.mjs` 的节奏相同。
- `--busy` 在页面上放一块每拍重画的 1280×720 WebGL 画布，beginFrame 带截图，让合成与光栅线程忙起来。不加 `--busy` 时复现不出来：16 个负载进程下 2400 次 seek 0 错。
- `--mode seeked` 是改前的写法。`--mode fixed` 经 Vite 中间件直接加载 `src/render/cards/mediaSource.ts` 的 `CardMediaSource`，也就是修好后的源码本身，不是抄的副本。fixed 模式还会核对 `currentFrameCovers` 确实返回 true（不是读不出帧时的 null），并报出 `settleWaits`：核对当场发现帧槽没换好、多等了几次。

参数统一为 `--loops 200/300 --busy --settle 0`，一部分 `--hogs 16`，一部分三个实例并行。

| 模式 | 运行 | seek 次数 | 取到错帧（位图像素） | 其中 seeked 当场 VideoFrame 也是旧帧 |
|---|---|---|---|---|
| seeked（改前） | 单跑 200 loops × 4 | 96 000 | 4 | 2 |
| seeked（改前） | 3 并行 × 300 loops × 2 轮 | 216 000 | 18 | 9 |
| **seeked 合计** | | **312 000** | **22** | |
| fixed（改后，早期版本） | 单跑 200 × 3 + 3 并行 300 × 1 | 180 000 | 0（settleWaits 4） | |
| fixed（改后，最终版本） | 3 并行 300 × 2 轮 | 216 000 | 0（settleWaits 17） | |
| **fixed 合计** | | **396 000** | **0**（核对拦下 21 次） | |

seeked 和 fixed 是交替跑的，负载条件相同。按改前的错帧率，396 000 次 seek 预计错 28 次左右，实际 0 次。

## 根因与证据

- 最小复现里错帧的样本有两种（`samples` 字段）：
  - `time 0.7 want 21 gotByTs 20 pixel 4(=20)`：`seeked` 之后当场读 VideoFrame 和位图，都还是 seek 之前那一帧。
  - `time 0.9333 want 28 gotByTs 28 pixel 11(=27)`：位图是旧帧，紧接着读的 VideoFrame 已是新帧。也就是说，帧槽恰好在两次读之间才换好。
- 两种样本合起来，直接说明 `seeked` 先于帧槽换帧。和 Chrome 的实现对得上：媒体线程把首帧交给 VideoFrameCompositor 的 `PaintSingleFrame`（投到合成器那条线程），同时把「缓冲够了」投给主线程，`seeked` 由后者引出，两边谁先到没有保证。
- 错帧都落在帧边界（目标正好是新一帧的起点）。原因是 rate 0.5 那两组里，源帧号发生变化的帧全在边界上：源帧号不变时，就算取到 seek 前那一帧，也恰好是同一帧，看不出错。
- 主会话给的初步判断成立。另外查了两条 JS 层的竞态，在导出流程里都不常见，但属于同一类错误，一并堵上：
  - 同一个视频元素上两次取帧交错（图卡代码里用 `Promise.all` 并发调 `pixels()` 时会出现）。现在改为按元素排队。
  - 一次取帧被取消时 seek 还在路上，紧接着再取同一时刻：旧代码看 `currentTime` 已等于目标，就跳过等待、当场取帧，拿到旧帧。现在 `seeking` 为真时也等 `seeked`。

## 修法

### `src/render/cards/mediaSource.ts`

- 新增导出函数 `currentFrameCovers(video)`：读 `new VideoFrame(video)` 的 `timestamp` 和 `duration`，判断它是否覆盖 `trunc(currentTime × 1e6)`（两边各留 1 µs）。返回 true 或 false；没法判断时返回 null，按「对上了」处理，即退回只等 seeked 的老行为。没法判断的情况有：没有 WebCodecs、读不出帧（例如跨源素材）、帧没有时长而时间戳又不晚于目标。
- `frame()` 的视频分支拆成 `videoFrame()`，按素材 URL 排队。`seeked`（或 `seeking` 未完）之后，核对为 false 就每 1 ms 复查一次，单帧最多等 500 ms。
- 同一素材连续两帧等满仍对不上，就暂停等待；之后某一帧当场对上，再恢复。例如视频轨比素材时长短、目标落在最后一帧之后，帧槽一直是最后一帧，怎么等都对不上，不该每帧白等。
- 新增 `settleWaits` 计数，诊断用，由最小复现探针读取。
- 取位图仍用 `createImageBitmap(video)`，像素路径和改前完全相同。核对通过后帧槽不会再变（元素是暂停的，也不会再 seek），所以不存在先核对、后取帧之间被换掉的问题。

### `src/render/frameMedia.ts`（时间轴视频片段的导出取帧）

- 原来判「合成器呈现的是不是目标那一帧」用 0.25 s 宽窗。每帧都会重新装载元素，装载后先呈现第 0 帧，所以目标小于 0.25 s 时，第 0 帧也会被当成目标帧收下，也就是同类的取到旧帧。
- 现在窗口按当前帧时长（`VideoFrame.duration`）收窄；读不到时长才用 0.25 s。
- 只有宽窗认可、严窗不认可的呈现，等 1 s 仍没有严窗认可的呈现，就收下。这样素材时长异常时不会卡到 20 s 超时、导致导出失败。
- 这条路原来就靠 rVFC 呈现回调，导出器在等页面的同时一直在发 beginFrame（`server/bakery/frame-media.mjs`），不存在互相等住的问题，这次没动这一点。

### 没有动的

`server/bakery/` 一个文件都没改，也没有越出给定的文件清单。

## 改了哪些文件

- `src/render/cards/mediaSource.ts`：修法，见上。
- `src/render/cards/mediaSource.test.mjs`：新增 VC-06～VC-09。
  - VC-06：seeked 先于帧槽换帧时，等到对的帧再取。同一个用例先在没有 WebCodecs 的情况下确认假元素能复现缺陷。
  - VC-07：同一素材并发取帧，排队各取各的帧。
  - VC-08：取消时 seek 未完，再取同一时刻会等。
  - VC-09：时间戳始终对不上时，每帧最多等一会儿，连续两帧后暂停，对上即恢复。
- `src/render/frameMedia.ts`：收紧呈现判据，见上。
- `scripts/probes/video-seek-race-probe.mjs`（新）：最小复现，主尺。
- `scripts/probes/video-source-cadence-stress.mjs`（新）：整套探针的压力版。
- `scripts/probes/video-source-cadence-probe.mjs`：没改，判定没有放宽。
- `docs/semantics/mechanism/cards.md`：「图卡的视频输入源取帧」一节加一句，标〔裁〕，见下。
- `docs/reports/AGENT-cadence-race.md`：本报告。
- 提交 `6d0e6aaf`：恢复被 `9da8e62a` 误覆盖的两个源文件，见「验证」第一节。

## 验证

### 事故：报告提交误把两个源文件还原成旧版（已恢复）

- 提交 `9da8e62a`（10:08:33，报告提交）把 `src/render/cards/mediaSource.ts`、`src/render/frameMedia.ts` 一起还原成了 `a76640d0` 的版本（两文件 +16 −113）。
- 经过：那时我正在跑一个改前改后耗时对照的脚本，它用 `git checkout a76640d0 -- <两文件>` 换成旧代码。这个命令不只改工作区，也改暂存区。我提交报告时只 `git add` 了报告，但暂存区里已经留着那两个旧文件，于是一并进了提交。随后脚本的「恢复」一步 `git checkout HEAD -- <两文件>` 恢复到的是这个已被还原的 HEAD，worktree 从此也是旧代码。
- 处理：`6d0e6aaf` 把两文件恢复成 `c4f1a017` 的版本，`git diff c4f1a017 -- src/` 为空。
- 以后的做法：改前改后对照一律在另一个 worktree 里跑旧代码，不再检出到本 worktree。这次重做用的是 `.worktrees/rel-0711`，即 `d20b6aad`，两个源文件与 `a76640d0` 逐字相同。

### 各项验证跑的是哪份代码

修复代码在 `cee1968b`（09:14:31）进入分支，最终版在 `c4f1a017`（09:16:12）。代码在 09:16～10:08 之间是修复版；10:08:33～10:30 之间是旧版；`6d0e6aaf`（10:30）之后又是修复版，且与 `c4f1a017` 逐字相同。

判断依据：dev server 按工作区的源文件现场编译，所以每一项跑的是当时工作区里的代码。时间取自提交时间、日志文件的修改时间、命令前后打印的时刻。

| 项 | 时间 | 跑的代码 | 是否作数 |
|---|---|---|---|
| 尺子二 fixed，早期版本（180 000 次） | `cee1968b` 提交前后（约 09:00～09:14） | 修复版早期写法（工作区里的代码，即 `cee1968b` 那一版，还没有「暂停后恢复」那一改） | 作数，属早期版本 |
| 尺子一 改后，20 遍 16 负载 | 约 09:17～09:32:51 | 修复版 | 作数 |
| 尺子二 fixed / seeked 交替三轮（fixed 216 000 次） | 约 09:33～09:45 | 修复版 | 作数 |
| 节奏探针空闲 5 遍（第一次） | 约 09:45 | 修复版 | 作数 |
| exportMs 改前改后交替两轮 | 约 09:46～09:49 | 改前用 `git checkout a76640d0 -- 两文件`，改后用 `git checkout HEAD -- 两文件`，当时 HEAD 是 `e42bf329`，即修复版 | 作数。但正是这种做法后来闯了祸，已弃用 |
| `npm test` | 09:49～09:50:49 | 修复版 | 作数 |
| G0-R 第一次（端口 6200） | 09:51～10:06:44 | 按时间推断是修复版，但没有不依赖推断的证据 | 不再引用，已在末端重跑 |
| determinism 改前改后对照（552 s / 544 s） | 10:07～10:26 | **两遍都是旧代码** | **作废**，已重做 |

### 在恢复后的末端（`6d0e6aaf`）重跑

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出 0，0 错误 |
| 本模块单测 | `node --test src/render/cards/mediaSource.test.mjs` | 9/9 过 |
| 节奏探针空闲 5 遍 | `video-source-cadence-stress.mjs --port 6210 --runs 5 --hogs 0` | 5/5 过，exportMs 12856 / 12927 / 12709 / 13998 / 12832 |
| 尺子二 fixed，三实例并行一轮 | `video-seek-race-probe.mjs --mode fixed --busy --settle 0 --loops 300`，端口 6211（`--hogs 16`）、6212、6213 | 3 × 36 000 次 seek，stale 0、wrongPixel 0；`coversCheck` 都是 true；`settleWaits` 2 / 0 / 3，即核对拦下帧槽未换好 5 次 |
| G0-R 全套 | `g0r.sh …cadence-race 6200 <scratchpad>/g0r-cadence2 …main-g0r/out/verify-a/frames`，10:41:55～10:56:05；开跑前和跑完后都确认 `currentFrameCovers` 在源文件里出现 4 处 | 全部退出 0，明细见下 |
| determinism 改前改后对照 | 改前：`.worktrees/rel-0711`（`d20b6aad`，`currentFrameCovers` 0 处），端口 6210，10:56:26～11:05:37。改后：`cadence-race`（`6d0e6aaf`，4 处），端口 6213，11:05:40～11:14:54。两个 worktree 的源文件都没动，跑完 `git status` 都是干净的 | 改前 547 s，改后 550 s，两次都是 1800/1800 一致 |

G0-R（末端重跑）各项：

- determinism：Identical 1800 / Different 0，用时 549 s。
- pixels：与基准逐像素比，total 1800、identical 1800、different 0、missing 0、extra 0。像素基线不变。
- unified：PASS。
- stream：PASS。stream-group：PASS。
- fallback：PASS。fallback-preload：PASS。
- ready-index：fails []。

### 其它（修复版上跑过的，见上表时间）

- 尺子二改后合计 396 000 次 seek 0 错。末端重跑的 108 000 次另计，也是 0 错。
- 尺子一改后 20/20 过，改前 19/20。
- `npm test`（09:50，修复版）：退出 1，4227 个，过 4221，挂 4，跳过 2。挂的 4 个都在 `server/test/codex-desktop.test.mjs`：用例 mock 了 `spawn`，断言参数是 `['app-server','--stdio']`，而本机解析出的 codex 是 npm 全局目录里的 `codex.js`，参数前面多了一个脚本路径。本分支没有改 `server/`。主会话说明由另一个分支修，这里照实记下。

### 导出耗时

- 节奏探针 `exportMs`，空闲：
  - 改前改后交替两轮（09:46～09:49，见上表）：改前 13485、13755、12975、14147、13294、13402，均值约 13 510 ms；改后 13438、12667、12630、13496、13318、12751，均值约 13 050 ms。
  - 末端重跑 5 遍，均值约 13 060 ms。
- G0-R determinism 一步：末端重跑 549 s。改前改后对照（分 worktree 跑）：改前 547 s，改后 550 s。差 3 s，约 0.5%，在噪声以内，修法没有拖慢导出。

## 语义改动与〔裁〕

在 `docs/semantics/mechanism/cards.md`「图卡的视频输入源取帧」一节加了一句，属于三级，没有动一级或二级：

- seek 完成后核对帧时间戳再取帧，等待间隔 1 ms，单帧上限 500 ms。
- 连续两帧对不上就暂停核对，对上即恢复。
- 同一元素的取帧排队。
- 时间轴视频片段的呈现窗口按帧时长收窄，读不到时长才用 0.25 s，宽窗只认可的呈现等 1 s 后收下。

〔裁〕里写明了现象、根因、复现手段，以及试过而没有采用的两条路：

- 等合成器的呈现回调：图卡的视频元素不挂进文档，导出页由 beginFrame 控制出帧，可能和导出器互相等住。
- 只多等固定时长：负载下没有上限保证。

## 没做成的与原因

- 尺子一（整套探针）的改前失败率只有约 1/20 遍，改后 0/20 本身的统计力度弱，所以主证据放在尺子二（31 万对 40 万次 seek）。
- 时间轴片段那条路（frameMedia）没有专门复现出错帧。改动是按代码和 Chrome 行为推出来的收紧：严窗认不到时，1 s 后退回原来的宽窗，所以不会比改前更差。它的单测没加：这个模块挂在 `window` 上，依赖 rVFC 和 DOM，现有单测体系里没有它的测试桩。节奏探针 ③④ 两组时间轴片段（60 × 3 帧）在改后全部遍数里都过。

## 对任务书或语义的更正建议

- `npm test` 在本机现在有 4 个与本任务无关的失败（codex-desktop），建议主会话单独查。
- 节奏探针本身对这类竞态很钝。建议整套验证里把 `video-seek-race-probe.mjs --busy --settle 0 --mode fixed --loops 300` 作为它的补充：三个实例并行、各 300 loops，一轮约 3～5 分钟，改前每轮每个实例都复现（单实例 200 loops 只有一半的遍数能复现）。

## 主会话审查（2026-10-01，笔记本主会话）

- 审过 `currentFrameCovers`（`VideoFrame` 的起止覆盖截断到微秒的 `currentTime`，两边各留 1 µs；判断不了按对上处理、退回只等 seeked）、按素材排队、取消后 seek 未完也等 seeked、连续两帧对不上就暂停核对；`frameMedia.ts` 的呈现窗口按帧时长收窄、宽窗只认的呈现等 1 s 再收。往前、往后 seek 留下的旧帧都判不覆盖，目标落在帧边界加 2 ms 后判覆盖；核对只读时间戳，不等合成器回调，与 beginFrame 控制的导出器不会互相等住。采纳三级〔裁〕那一句（`mechanism/cards.md`「图卡的视频输入源取帧」）。
- **审查中发现的事故**：报告提交 `9da8e62a` 把两个源文件误还原成改前版本（做耗时对照时用 `git checkout <提交> -- <文件>` 换旧文件，它会顺带暂存，「只提交报告」时被一并带进去），分支末端一度没有修复。主会话按 `git diff` 与 `currentFrameCovers` 出现次数查出，让子 Agent 恢复（`6d0e6aaf`）、在末端重跑全部验证并如实更正报告（`b9dab6ad`）：类型检查、单测 9/9、空闲节奏探针 5/5、最小复现三实例并行 108 000 次 seek 0 错、G0-R 全套重跑全过（确定性 1800/1800、像素基线 1800 相同）、确定性耗时改前 547 s / 改后 550 s。教训：改前改后对照用另一个检出跑，不在工作分支里换文件。
- 采纳建议：`video-seek-race-probe --mode fixed --busy --settle 0 --loops 300` 三实例并行纳入 G0-R「预渲染探针」一行（主计划第 8 节），集成分支 `claude/r12-merge` 的整套里已跑。合入 main `1e17d9fa`。
