# 归档：已退役的探针

这里的探针**不在验收清单里、不被任何代码引用**，留着只作对账和考古。两种情形都在这里，查之前先分清：

- **验的行为产品已经改了**——照旧跑必然不过（`lowmem-online-probe`、`snapshot-size-probe` 的判据、
  `m7-bake-node-probe` 的 `desktop` 那条腿）。要验现在的行为，看下面每条写的「接替它的是谁」。
- **一次性的可行性或选型实测**——今天还跑得动（它们问的是浏览器或系统怎么表现，不调产品的断言），
  但**不是通过与不通过的凭据**：结论已经落进实现、契约或任务书。浏览器换了版本想重验某条结论，
  直接跑归档里的那一支即可（`backdrop-probe`、`videodecoder-probe`、`c10-stage-probe`、
  `audio-determine-probe`、轨道流那 17 支、`gl-atlas-probe`、`svg-url-serialize-probe`、
  `hosted-render-node-side-check`）。

验收台账（`scripts/acceptance/four-stage-manifest.mjs` 的 `EXCLUDED_PROBE_FILES`）不收这里的文件：
守门 `--check-coverage` 只看 `scripts/probes/` 下的，挪进来就不用再写排除原因。

归档由 2026-10-23 的探针总审开始（报告 `docs/reports/AGENT-claude-probe-audit.md`）。

## lowmem-online-probe.mjs

整支按「低内存档」写：手机仿真自动判成低内存档、设备设置「显示档」、进入提示、只贴预渲染小尺寸、
停下追一帧限时 5 秒。那一档 2026-10-07 撤销、0.7.19 从代码里去掉（语义 `docs/semantics/product/platforms.md`「在线浏览器」），
所以它的断言照旧跑必然不过。文件头自己从 2026-10-22 起就标着〔已退役〕。

接替它的：

| 原来验什么 | 现在谁验 |
|---|---|
| 最低一档（播放时不即时渲染、停下逐层追一帧不设时限） | `scripts/probes/stage-gate-probe.mjs` 的 S15、`page-stream-probe.mjs --only lowest` |
| 模拟手机（精简模式） | `page-stream-probe.mjs --only mobile` |
| 浏览器逐帧导出 | `online-export-modes-probe.mjs`、`lowmem-export-compare.mjs` |

挪进来时只改了三行 import 的相对路径（`probe-chrome.mjs`、`probe-connect.mjs`、`server/bakery/ffmpeg.mjs`），
断言一字未动。`docs/plan/c10-contract.md`「C10-A9 低内存档回归」和 `docs/plan/m8-plan.md` 第 255 行把它列作回归探针，
那是当时的记录，不再适用。

## 轨道流的单项实测（2026-09 那一批，17 支）

`merged-stream-bitstream`、`merged-stream-capacity`、`merged-stream-decode-limits`、`merged-stream-h264`、
`merged-stream-play`、`merged-stream-play-page.js`、`merged-stream-reencode`、`stream-alpha-quality`、
`stream-cadence`、`stream-crop-rect`、`stream-decode-throughput`、`stream-demux-browser.js`、`stream-fmp4-split`、
`stream-material`、`stream-roundtrip`、`stream-sparse`、`stream-encoder-params`。

都是 2026-09 选型期的一次性实测：量编码参数、比特流、解码吞吐、容量上限、alpha 质量、裁剪、分段、重编码。
结论已经落进 `docs/plan/g0-b-stream-prototype.md` 与 `docs/plan/prerender-products-contract.md`，产品里的轨道流
（R8）与共享渲染器（R9）已按那些结论做成并合入 main。它们验的不是产品承诺，是当时的选型依据，所以归档。

**没有一起挪的两支公共件**（还在 `scripts/probes/`，因为在用的探针还 import 它们）：

- `stream-common.mjs` —— 14 支在用探针 import（`sparse-stream-probe`、`cut-flatten-probe`、`scrub-stream-probe`、`stream-below-probe` 等）；
- `merged-stream-common.mjs` —— `stream-budget-probe.mjs` import 它。

所以挪进来的这些文件里，对这两支的 import 改成了 `../../probes/…`，对 `server/` 的相对路径多加了一层；断言一字未动。

## audio-determine-probe.mjs

音频素材效果卡判重方案的前提实测（2026-09，排除表早就标着「历史」）：量「一次渲完 vs 分段 + 预滚」的接缝误差，
为的是定分块参数。它不调用产品的判重逻辑、没有产品断言，实验里用的 24000 帧一块、随机抽样也已被正式语义里的
4096 帧一块、顺序抽样取代。挪进来时改了一处仓库根的相对路径（多一层）。

## 原型与迁移对账（6 支，2026-09～10）

| 文件 | 它是什么 | 为什么归档 |
|---|---|---|
| `backdrop-probe.mjs` | 浏览器 `backdrop-filter` 能不能采样兄弟画布的可行性原型 | 不调产品代码、没有退出码断言；结论已落进毛玻璃的实现与 `docs/plan/r8-streams-task.md`、`r9-webgl-task.md` |
| `gl-atlas-probe.mjs`、`gl-atlas-harness.html` | R9 共享渲染器的独立 Blob Worker 图集原型与它的夹具页 | 不调产品代码；真实产品那一侧由 `scripts/probes/gl-stage-probe.mjs` 验 |
| `gl-migrate-compare.mjs` | R9 迁移期「迁移前 vs 迁移后」的对账件 | R9 已合入 main（`eff2011`），迁移对账做完即无用 |
| `svg-url-serialize-probe.mjs` | SVG 里 `url(...)` 怎么序列化的一次性观测（2026-09-17，Chrome 152） | 全文 0 条断言、恒以 0 退出；结论已固化进 `src/render/snapshotRename.ts` 的文件头与 `snapshotRename.test.mjs` |
| `stream-editor-e2e.mjs` | R8 轨道流在真编辑台里的端到端探针 | 文件头自己写明「只对打过 `r8-glue.patch` 的 dev server 有意义」，那个补丁在仓库和任何分支上都不存在，没打补丁时它会卡在「等流生产完」超时；R8 已合入 main，现在这条链由 `scrub-stream-probe.mjs` 等守门 |

指向它们的散文指针已改到归档路径：`src/render/snapshotRename.ts`、`scripts/probes/preview-fallback-probe.mjs`、`scripts/probes/probe-connect.mjs`。

## snapshot-size-probe.mjs

量「单卡 HTML 快照」的体积分布，判据是当年快照投递的体积上限。每张卡的快照 2026-10-16（己二）撤掉后，
它量的入口（整场景 HTML 采样）还在，所以跑得完、退出码 0，但**判据已经没有对应的产品行为**，不再是通过与不通过的凭据。
同批被删掉的是另外 5 支（`scrub-hold-snapshot-probe`、`snapshot-hash-probe`、`snapshot-diff-apply-probe`、`swap-cost-probe`、`png-adopt-probe`）：
它们跑起来必然失败或在测空桩，见 `docs/reports/AGENT-claude-probe-audit.md`。

## fixtures/asset-root-publisher-v2-worker.mjs

Linux root 下那套「素材根发布者 v2」隔离实验的被测 worker（2026-10 codex 那一轮写的，当时由 root 写进
`/run/systemd/system/pc-asset-cgroup-proof-<id>.service` 的 `ExecStart` 启动，见归档报告
`docs/archive/agent-reports/AGENT-codex-018-asset-root-publisher.md`）。

**今天在仓库里一处引用都没有**：`scripts/probes/asset-root-cgroup-os-probe.mjs` 的 `--publisher-v2` 模式还在，
但它整个文件没有出现过这支 worker 的名字，连 `fixtures/` 都没引过（`systemd-run` 起的是探针自己内联的东西）；
命令行也没有传 worker 路径的参数。子 Agent（B13 块）判它「由 systemd ExecStart 启动、属于静态引用查不到的活件」，
主 Agent 查过原文后推翻了这条理由 —— 它是真孤儿，所以归档而不是留在 `scripts/probes/` 里。

要恢复它的用法，连带看那份归档报告第 352、360 行，以及 `server/hosted/run-assets-current-registry-v2.mjs` 的
`readRootAssetReservationV2`（这个函数现在还在）。

## M7 的零断言实测件与一个演示（4 支，2026-09～10）

`m7-bake-node-probe.mjs`、`m7-upload-probe.mjs`、`m7-visibility-probe.mjs`、`hosted-render-wipe-demo.mjs`。

四支都**没有一条断言**（`check` / `fails.push` / `assert` / 退出码判定全为 0 处），跑出来只打印数字或现象，也没有任何单测引用、
不在任何验收项里。各自的产品实现都已正式落地：上传测速那条路在 `src/online/snapUploader.ts`，后台节流那条在
`src/editor/browserNodeHost.ts` 与 `src/online/browserNode.ts`（并由 `m7-browser-probe.mjs` 的 A6 覆盖），文件锁演示的那件事由
`server/test/hosted-render-isolation.test.mjs` 与清单项 `S3-render-iso` 覆盖。

`m7-bake-node-probe.mjs` 多说一句：主 Agent 先前判它「留」，当作被删掉的 `m7-bake-probe.mjs` 的后继；
**后来自己核查推翻了这个判断** —— 它的 `desktop` 子命令要从桌面预渲染拷「每张卡的 `<帧>.html` 与 `<帧>.small.webp`」当参照，
而每卡快照 2026-10-16 已撤（`snapshotTier()` 恒回 `'none'`），这条参照腿产不出来，`compare` 也就无从比起。
它的 `browser` 子命令驱动产品真实的 `bakeFrame`，那一半仍有效，所以归档留着，等渲染重构真回到 M7 P1～P3 时再用。

同批**删掉**（不是归档）的是 `m7-build-probe.mjs`：它要 `src/online/m7NodeProbe.ts` 与 `window.__m7CreateNodeSession`，
两样都已不存在（产品侧改成 `src/online/browserNode.ts` 引 `server/render-node/session.mjs`），整支跑不起来。

## hosted-render-node-side-check.mjs

一次性**对照实验**：同步来的样式与脚本不过预检时，工作进程里的 Vite 与 Tailwind 在 Node 一侧会不会读到工作目录以外的文件、
会不会把同步来的脚本当构建插件执行（契约 `hosted-render-contract.md` 第 7.5 节要堵的缺口）。它**故意不走预检**，
所以回答的是「这个缺口在不在」，不能当回归用。0 条断言（只打印发现），不在任何验收项里，`server/test`／`src`／`tools` 下没人引用它。

缺口已经堵上、而且有了正式的回归：预检本身由 `scripts/probes/hosted-render-isolation-probe.mjs` 的 G2 与单测 HR32 验。
所以这支归档。要重跑它看「缺口今天还在不在」，直接 `node scripts/archive/probes/hosted-render-node-side-check.mjs`（它不依赖仓库里别的探针）。

## c10-stage-probe.mjs

C10 契约的可行性探针（2026-09-27 `opus-dev` 跑，子命令 `p1`～`p4`、`p3q`、`calibrate`），
排除表原本就标着「历史，结论已落进契约」。归档的三条理由：

1. 结论已经固化成 `docs/plan/c10-contract.md` 第 15 节的结果表，那一节现在指向本归档路径；
2. 它把 `src/render/createSnapshot.ts` 打成 IIFE 后读 `s.controls[0].html`，也就是**每张卡的 HTML 快照**那个平面。
   那一层 2026-10-16（己二）撤掉后（`snapshotTier()` 恒回 `'none'`），`snap` / `bakeT` / `bakeRT` / `bake`
   这几个用例量到的已经不是当年量的东西，重跑也对不上契约里的数；
3. 没有任何代码、单测或验收项引用它。

挪进来时改了四处路径（`../lib/no-user-dirs.mjs`、两支公共件 `probe-chrome.mjs` / `probe-connect.mjs`、
`ROOT` 多上一层）和文件头的用法行，断言与量法一字未动。`docs/reports/HANDOFF-2026-09-27-pc.md`、
`docs/reports/REPORT-C10.md` 里的旧路径是当时的记录，不改。

## videodecoder-probe.mjs

G0-a 准入的三支可行性探针之一（WebCodecs 能不能硬解 `avc1.640028`、上下拼合那个 1920×2176 的几何放不放得下、
`mediaCapabilities.decodingInfo` 的 `powerEfficient` 怎么说）。同批的 `backdrop-probe.mjs` 已经在这里，
口径一致：0 条断言、不调产品代码、结论已落进 `docs/plan/r8-streams-task.md`（G0-a 2026-09-19 全过），
`server/test` / `src` / `tools` 下没人引用。任务书第 224 行的指针已改到本归档路径。

**同批没有一起挪的** `oac-probe.mjs`（还在 `scripts/probes/`）：产品代码
`server/vite-plugin-stage-ports.ts` 第 39 行引它作 `Origin-Agent-Cluster: ?1` 这个头的实测出处，
`stage-isolation-probe.mjs`、`playback-probe.mjs` 两支在用的探针照它的做法做。它量的是浏览器的进程隔离，
换一个 Chrome 版本就可能变，留在原处方便重验。

挪进来时只改了一行 import（`probe-connect.mjs` → `../../probes/`）和文件头的用法行。
