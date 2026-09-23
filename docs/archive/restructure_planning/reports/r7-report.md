# R7 「露出舞台」实施报告

分支：`r7-reveal-stage`
worktree：`C:\Users\admin\Documents\PromptCut\.claude\worktrees\agent-r7reveal`
基线：`0a1c069`（main，「文档:执行记录——R5 合并,R7 派出」）

## 0. 开工前的意外：worktree 被清掉过一次

原先派给我的 worktree `agent-a9f57c755ae3c8209` 在几次 529 过载中断后被清理掉了
（目录和分支都不存在），分支上没有任何提交，所以没有丢失任何工作。

重建过程：
- `git worktree add -b r7-reveal-stage .claude/worktrees/agent-r7reveal main`
- `git merge --ff-only main` → `Already up to date.`（基线 `0a1c069`）
- `node_modules` 用 robocopy 从主仓库**实拷**一份（317 MB）。遵守「不建 junction、不 npm ci」：
  两样都没做。主仓库和各兄弟 worktree 的 `node_modules` 本来也都是实目录、不是 junction。

harness 的 `EnterWorktree` 在本会话不可用（子 Agent 带 cwd override 时禁止创建；按 path
切换又要求当前已在 worktree 内）。所以 worktree 用 git 手工建，全程用绝对路径操作 ——
它位于主工作目录之下，读写没有问题。**主仓库 main 一个字没动。**

## 1. 提交列表（7 个）

| SHA | 说明 |
|---|---|
| `49d8901` | 清账：`frame-pipeline.mjs` 两个字面 NUL → `\u0000` 转义 |
| `d09982d` | 清账：`setRole` 的「不重发」改成按 `{client, job}` 判，补一条互换用例 |
| `d191bc5` | D5 同源退回删除：预渲染拿不到地址就抛，编辑器进程不再养热 Chrome |
| `d923330` | 桌面壳：端口预检一并查 5211 / 5212，`smoke-boot` 等两个舞台端口 |
| `1bc1fd4` | 露出舞台：摘 `front` 的 `opacity: 0`、整帧 `<img>` 只留 legacy、删 `mediaRects` |
| `3cd1749` | 验收探针 `reveal-probe`，smoke 补 `--legacy`，任务书补 R7 的更正 |
| `9b88e9b` | **翻开关**：`previewMode()` 缺省 legacy → stage（单独、最后） |
| `36a53ed` | `reveal-probe`：有头模式下不关垂直同步（补在翻开关之后） |

## 2. 改了哪些文件

**页面侧**
- `src/editor/previewMode.ts` — 缺省翻成 `stage`；`?preview=legacy` 是唯一的回滚值。
- `src/editor/Preview.tsx` — `opacity: dual && frontId === 'A' ? 1 : 0`（B 同理）；
  `UnifiedPreview` 只在 `!dual` 时渲；删 `mediaRects` 及两个调用点；去掉随之不用的
  `videoLayersAt` / `frameBox` 两个 import。
- `src/editor/stageJobs.ts` + `stageJobs.test.mjs` — `lastSentJob` → `lastSent {client, job}`。
- `src/render/prerender.ts` — 拿不到地址抛 `PRERENDER_UNAVAILABLE`；`usePrerenderBase()` 回
  `string | null`；「问过了没有」也缓存 `CACHE_MS`。
- `src/render/frameClient.ts` — `see_frames` 缺省 `target` → `"prerender"`。
- `src/render/snapshotSource.ts` — SSE 拿不到源就退避重连，不再连同源。
- `src/editor/right/ToolVisual.tsx`、`src/editor/right/chat/OpDetailPreview.tsx` — `base` 为
  `null` 时明示「预渲染进程还没就绪」，不去拼地址。

**服务端**
- `server/vite-plugin-frames.ts` — `interactive: true` → `interactive: isPrerender`。
- `server/frame-pipeline.mjs` — 两个字面 NUL → `\u0000`。

**桌面壳**
- `desktop/src-tauri/src/lib.rs` — `probe_port` → `probe_port_at(port, timeout)`；新增
  `EDITOR_PORT` / `STAGE_PORTS` / `occupied_stage_ports`；启动时查 5211 / 5212 并点名。
- `desktop/scripts/smoke-boot.mjs` — `httpGet` 带回 headers；Step 2b 等两个舞台端口各回
  一次 200 且带 `origin-agent-cluster: ?1`；结果进 `BOOT_RESULT_JSON`。

**探针与文档**
- `scripts/probes/reveal-probe.mjs`（新）、`scripts/probes/editor-preview-smoke.mjs`（补
  `--legacy`、缺省自认）、`docs/plan/r2-r7-task.md`（文首补「R7 落地后的更正」一节）。

## 3. 总验收

### 3.1 静态

| 项 | 结果 |
|---|---|
| `npx tsc -b --force` | **零错误**（翻开关后复跑仍零错误） |
| `npm test` | **1633 / 1632 通过 / 0 失败 / 1 跳过**（main 基线 1632/1631/0/1，我加了 1 条用例） |
| `cargo check`（`desktop/src-tauri`） | **通过，exit 0** |

`cargo check` 的前提：新 worktree 里缺两样 **gitignore 的本地构建资源** ——
`desktop/src-tauri/binaries/node-x86_64-pc-windows-msvc.exe`（92 MB）和
`desktop/src-tauri/runtime/`（主仓库那份 1.6 GB）。前者从主仓库拷了一份，
后者建了个空目录占位（`tauri-build` 只检查路径存在）。两样都不进提交。
`CARGO_TARGET_DIR` 指到 scratchpad，没有碰主仓库那个 14 GB 的 target 目录。

### 3.2 探针（无头）

**每个探针一台全新的 dev server + 全新的数据目录**（见下面「对任务书的更正」第 8 条）。
端口只用 5291（舞台 5292 / 5293）和 5294。

| 探针 | 结果 |
|---|---|
| `reveal-probe`（新，不带任何 preview 参数） | **全绿，`ok: true`** |
| `editor-preview-smoke`（legacy） | 全过 |
| `editor-preview-smoke`（`--stage`） | 全过 |
| `stage-rpc-probe`（跨源） | 全过 |
| `stage-rpc-probe`（`--legacy`） | 全过 |
| `stage-isolation-probe` | 全过 |
| `stage-content-probe` | 全过 |
| `probe-gate-probe` | 全过 |
| `playback-probe` | 全过 |
| `ready-index-probe` | 全过 |

**12 趟全绿，`fails` 都是空的。** 其中 `editor-preview-smoke` 跑了三种：`--legacy`、
`--stage`、不带参数（翻开关之后不带参数会自认成 stage 并按 stage 验）。

### 3.2b 导出逐字节

`export-baseline-compare.mjs`：基线 = main（`0a1c069`）的临时 worktree + 它自己那棵树的
`scripts/export-frames.mjs`，候选 = 本分支。两台 dev server（5294 / 5297），`TEMP`
各指一处免得覆盖全局 `port.json`，`--workers 1`、`--no-video`。

**逐字节：相同 60/60，✅ 全长导出逐字节相同。**

临时 worktree 已 `git worktree remove --force`，目录确认不存在；它的 `node_modules` 是
**实拷**不是 junction（删之前确认过 `LinkType` 是空），主仓库的依赖完好
（`node_modules/vite` 仍在）。`git worktree list` 里只剩我这一个。

另有一条**静态证据**佐证同一结论：本分支相对 main 的全部改动是 16 个文件，
`server/bakery/*`、`scripts/export-frames.mjs`、`ExportView.tsx`、`FrameScene`、
`render/Stage` **一个都没碰**；而且 `ExportView.tsx` 的模块图里没有任何我改过的文件
（`render/prerender` 的真实 importer 全在 `src/editor` / `src/ai` / `src/mcp` 和
`frameClient` 里；`registry.ts` / `types.ts` 命中的 `prerender` 是 `need_prerendering`
这个字段名，不是 import）。

### 3.2c 三个 verify 脚本

| 脚本 | 结果 |
|---|---|
| `scripts/verify-bake-protocol.mjs` | **PASS**（25 个 `window.__*` 全部对上两栏清单） |
| `scripts/verify-export-frame-content.mjs` | **PASS**（保留 GPU canvas、六帧整场景视频、红蓝稀疏 seek） |
| `scripts/verify-unified-frames.mjs` | **失败，但是预先存在的**（见 5.1） |

### 3.5 有头（`--headed`）实测

有头这一趟**不关垂直同步** —— 关掉量到的是「主线程最快能推多少拍」，不是屏幕上真实的节拍。

| 档 | `frame` 到达间隔均值 | p50 | min / max | `sec` 差错的条数 | 主文档长任务 |
|---|---|---|---|---|---|
| 24 fps | **41.755 ms**（想要 41.667） | 42.3 | 4.5 / 86.7 | 0 | 0 |
| 30 fps | **33.339 ms**（想要 33.333） | 33.3 | 31.6 / 35.0 | 0 | 0 |
| 60 fps | **16.674 ms**（想要 16.667） | 16.7 | 15.0 / 18.5 | 0 | 0 |

24 fps 那一行 min 4.5 / max 86.7 的抖动正是 60 Hz 屏上「2 帧 / 3 帧交替」的样子
（R2 报告预言过），均值仍然准到 0.09 ms 以内。

有头**拖动** 30 次：往返均值 **7.9 ms**、p50 8 ms、最大 **11 ms**，没有一次超过一拍
（30 fps 的一拍是 33.3 ms）；`.pc-awaiting` 一次都没出现过，自然也没有卡住的。

### 3.3 `reveal-probe` 逐条

- **露出**：`ProbeGate` 遮罩出现过、测完摘掉；`front` 的 `opacity` 是 `1`；`back` 仍是
  `opacity: 0` + `pointer-events: none`，且没有用 `display: none` / `visibility: hidden`；
  CDP `Target.getTargets` 里 **2 个** `type: 'iframe'` 的 target；
  主文档预览区里 **0 个** `<img>`、**0 个** `<video>`。
- **暂停拖动**：30 次 `setTime`，没有一次超过三拍；`.pc-awaiting` 没有一次卡过 500 ms。
- **播放**：`frame` 到达间隔均值 —— 24 fps / 30 fps / 60 fps 都落在 `1000/fps ± 1 ms` 内
  （60 fps 实测均值 16.689 ms，想要 16.667）；三档的 `sec` 差**全部**恒为 `1/fps`
  （`secDiffWrong: 0`）；三档播放中主文档长任务都是 0。
- **零卡顿**：预渲染进程在（`prerenderUp: true`），播放中主文档长任务 **0**。
- **点选**：实体框中心的 `hitTest` 命中的就是那张卡本身。
- **回滚**：`?preview=legacy` 下只有一个舞台 iframe、`opacity` 是 `0`。

## 4. 对任务书的更正（已写进 `docs/plan/r2-r7-task.md` 文首）

1. **露出的判据是 `dualStage()`，不是 `previewMode() === 'stage'`**。舞台页只有 `dual` 时才带
   `&preview=stage`、才渲 live 变体、才把素材层画在自己里面；端口被占退回同源单舞台时
   那一份还是 `placeholder` 内容，露出来会是一张没有素材的画面。正文 D5 只说「对 `front`
   去掉」，没写端口起不来那一档。
2. **`mediaRects` 连 legacy 一起删**（D3 第 4 步原意，R3 的代码注释也这么写）。代价：legacy 下
   点素材段选不中 —— legacy 的舞台是 `placeholder` 模式、里面没有素材层，主文档又不再补。
   `?preview=legacy` 是回滚开关、不是长期形态。
3. **`frameClient.ts` 的 `see_frames` 缺省 `target` 必须改成 `"prerender"`**。这是 D5 的必然推论
   （编辑器进程 `interactive: false` 之后 `user` lane 立即回 `USE_PRERENDER`），但任务书
   只在 D5 里提了 `frameClient.ts:90`，没说它是「编辑器能不能出画面」的前提。
4. **`usePrerenderBase()` 回 `string | null`**（正文只说「初值跟着处理」）。两个消费方要跟着改。
5. **桌面壳的舞台端口预检只警告、不拦启动**。任务书只说「弹窗点名哪个被占」，没说拦不拦。
   按「编辑器那一侧被占只是退回同源单舞台、照样能用」来定：拦掉反而比网页版更糟。
6. **`setRole` 的「不重发」按 `{client, job}` 判**，而不是在 `setStageClient` 里清 —— 后者会让
   `stageBridge` 反过来依赖 `stageJobs`，而且只盖得住互换那一条路径。
7. **`server/frame-pipeline.mjs` 的字面 NUL 换成转义**后 git 恢复按文本处理这个文件。
8. **`editor-preview-smoke.mjs` 必须一台全新 dev server 跑一次。** 它只 `addCardClip`、
   从不 `newProject`，同一台 server 上连跑会让片段累积、浮层盖住点击点、`.pc-pv-hit` 的
   第一个不再是它要拖的那一张。**实测同一台 server 连跑三次：过、挂（两条）、过。**
   我一开始把这个当成自己改坏了，回退 `Preview.tsx` 复跑「过」更像是坐实 —— 实际是
   probe 卫生问题。总验收因此改成「一探针一台新 server」。
9. **翻开关之后 `editor-preview-smoke` 不带参数不再是 legacy**，所以给它加了 `--legacy`；
   不带参数时按「页面真的挂了几个舞台 iframe」自认模式。

## 5. 没做成 / 没验的事（如实）

### 5.1 `verify-unified-frames.mjs` 红 —— 预先存在，不是 R7 弄的

本分支上它在**很早的一步**就挂：`导出页 60 秒没就绪(window.__pcReady 一直不是 true)`
（`server/bakery/chrome.mjs:228`，经 `FramePipeline.bakery` → `openBakery`）。

**做过隔离**：`git checkout 0a1c069 -- src server`（把 src 和 server 整个退回 main）
之后复跑，**一模一样地挂在同一行**。所以它和 R7 无关。R5 / R6 的报告说这个脚本的红
在第 60 行那条「export must exactly match see_frames」断言上；这台机器上它连导出页
都起不来，比那更早，可能是环境（`work/` 残留、Chrome 版本）而不是同一个毛病 ——
**我没有去查它的根因**，超出本步范围。

一并说明：`verify-export-frame-content.mjs` 里硬编码用 5196 端口、
`verify-unified-frames.mjs` 用 5192，都落在任务书划的「别碰 5190～5199」区间里。
这两个端口是脚本自己写死的，我没得选；跑的时候 5188～5200 没有任何监听者
（用户的编辑台当时没开），所以没有影响到谁。

### 5.2 「零卡顿」那一条只验到一半

任务书要的是「播放中**同时**跑着后台舞台探针和预渲染进程」时主文档长任务为 0。

- **预渲染进程确实在**（探针记了 `prerenderUp: true`）；
- **后台舞台探针没能保证在跑**：`probeRunningDuringPlayback: false`。我的做法是
  「换一份三张卡的新项目、故意不等 `waitProbeIdle` 就开播」，但 K1 探针把这几张卡
  测完只要几百毫秒，等播放采样窗口铺开它已经收工了。要真正压住这一条，得有一个
  能让探针**持续**有活干的办法（比如塞一批没测过的合成卡，或者给 `probeRunner`
  开一个「慢速重测」的测试钩子）——我没有做。

所以「播放中主文档长任务为 0」这条结论是在**预渲染进程在跑 + 后台舞台空闲**下得到的
（无头和有头都为 0）。R5 量的是「都不跑」，比 R5 进了一步，但没到任务书要的那一步。

### 5.3 探针里没做的几条验收

`reveal-probe` 覆盖了露出、拖动、播放、点选、回滚五组。**下面这些没进探针**：

1. **「快照挂上 / 摘掉 / 换帧时组件实例不变」**：`stage-content-probe` 已经逐条验了这三种
   情况（本轮全过），我没有在 `reveal-probe` 里重复一遍；探针里那两个
   `genBefore` / `genAfter` 只是记录，没有写成断言。
2. **「拖动写入的 `frame` 与 legacy 逐位相同」「`get_layout` 的 `contentBox` 与 legacy 逐位相同」**：
   没做**跨模式逐位比对**。现状是 `editor-preview-smoke` 在 `--legacy` / `--stage` /
   缺省三种下各自的断言都过（含拖动写 `frame`、`contentLayoutOf` 量 `contentBox`），
   但那是「各自都在合理范围内」，不是「两边逐位相同」。要做得起一页 legacy 一页 stage、
   同一份项目同一个点，把两边的数对着比 —— 我没写。
3. **K6 闭环那三条**（`streams` 关着时判重的卡播放中每 ≥ 33 ms 换一次快照且不透明、
   `demote` 后 5 秒内预渲染进程有它的批且就绪后下一拍切进 `suppressed`、
   重开项目重测写回 `demoted: false`）：**没做**。`playback-probe` 的「降级」用例验了
   K6 的父页一半（触发 demote、`costs` 里恰好一条 `demoted: true`、整条 PUT、
   死素材就绪前留在 `pendingDemote` 照常活渲、慢帧不跳帧），本轮全过；
   但「预渲染进程真的收到了它的批」和「重开项目写回 `demoted: false`」这两条要
   碰预渲染进程的诊断口和重开流程，我没有写。
4. **回滚的「画面与 R7 之前逐字节相同（截图比对）」**：**没做截图比对**。
   现在验的是结构等价物 —— legacy 下只有一个舞台 iframe、它的 `opacity` 是 `0`
   （也就是整帧 `<img>` 在上面），加上 `editor-preview-smoke --legacy` 全过。
   真要逐字节就得在翻开关前后各截一次同一帧再比，我没有留那个前置截图。

### 5.4 桌面壳只做了 `cargo check`，没有构建、没有真跑

`cargo check` 通过（exit 0），但**没有 `cargo build`、没有打包、没有真的启动桌面壳**，
所以：

- 端口占用弹窗（5211 / 5212 被占时点名哪一个）**没有在真机上看过**；
- `smoke-boot.mjs` 新增的 Step 2b **没有真的跑过** —— 它要一个已经在跑的
  `promptcut.exe`，而我没有构建。只做了 `node --check` 语法检查。

另外为了让 `cargo check` 能跑，我在 worktree 里补了两样 **gitignore 的本地构建资源**：
从主仓库拷了 `desktop/src-tauri/binaries/node-x86_64-pc-windows-msvc.exe`（92 MB），
并给 `desktop/src-tauri/runtime/` 建了个空目录占位（`tauri-build` 只检查路径存在）。
**两样都没进提交**，但它们还留在 worktree 里；这个 worktree 是一次性的，不用管，
换一棵树重跑 `cargo check` 时要重新补。

### 5.5 legacy 下点素材段选不中（已知代价，写进了任务书）

删 `mediaRects` 是 D3 第 4 步明写的，R3 在代码注释里也写了「那一步 legacy 也不要了」。
代价是：legacy 的舞台是 `placeholder` 模式、里面没有素材层，主文档又不再补一份，
所以 `?preview=legacy` 下点视频 / 图片段选不中。卡片照常。
`editor-preview-smoke --legacy` 不覆盖这一条（它那个项目里没有素材段），所以是**推理**
不是实测。`?preview=legacy` 是回滚开关、不是长期形态，我按任务书做了并记在更正里。

### 5.6 其它

- **没 push、没合并、没动 main**（主仓库仍在 `0a1c069`，工作区只有原本就有的
  `?? .claude/worktrees/` 和 `?? nul` 两条）。没动别的 worktree。
- 端口只用了 5291～5299（另加两个脚本写死的 5192 / 5196，见 5.1）。用完确认
  5291～5299 全部空闲、没有遗留的 puppeteer Chrome。
- 没建 junction、没跑 `npm ci`、没装任何东西。没有读写
  `%LOCALAPPDATA%\PromptCut\runtime\app`。
- `render_pipeline_restructure.md` 按要求没动（主会话改）。

## 6. 开关翻了没有

**翻了。** `9b88e9b` 是单独的最后一个代码提交（之后只有 `36a53ed` 那个探针小改），
翻之前 12 趟既有探针 + 三个 verify 里的两个 + 导出逐字节对账都已经绿；
翻之后 `reveal-probe`（不带任何 preview 参数）全绿，`npm test` 1633/1632/0/1、
`tsc -b --force` 零错误复跑过。

要回退这一下：`git revert 9b88e9b` 或把它从分支上摘掉，别的六个提交都不依赖它
（它们全藏在 `dual` 后面，缺省 legacy 时行为和 R7 之前一样）。
