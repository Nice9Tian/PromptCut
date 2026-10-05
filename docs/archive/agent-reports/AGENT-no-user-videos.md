# AGENT-no-user-videos：测试与探针不写用户的 Videos\PromptCut

分支 `claude/no-user-videos`（从 main `e27fa520` 拉出）。子智能体报告，主会话「PromptCut M5～M8 开发交接」派出。

## 任务

桌面版的帧库 `%USERPROFILE%\Videos\PromptCut\frame-library` 已长到 273 GB。核对自动化测试和探针有没有任何一处会写到 `%USERPROFILE%\Videos\PromptCut`，有就改到仓库 `out/` 或临时目录，并加守门。不改产品行为（桌面版、编辑器自身的缺省目录不动）。

## 结论先说

- 仓库里**没有**一处测试或探针把 Videos 写死成输出目录。写到 Videos 的途径只有两条：
  1. **继承环境变量**：编辑器、预渲染进程、`FramePipeline` 的输出目录都是「`PROMPTCUT_EXPORT_DIR` / `PROMPTCUT_DATA_DIR` 优先，缺省 `<root>/out`」。桌面壳（`desktop/src-tauri/src/lib.rs:466`、`:470`）把前者设成 `~/Videos/PromptCut`、后者设成应用数据目录，交给编辑器进程；桌面版里的 Agent、从桌面版环境开的终端、或某台机器全局设了这两个变量时，跑的探针与测试会原样继承。12 个探针与脚本（清单见下）起编辑器时不设 `PROMPTCUT_EXPORT_DIR`，在这个条件下帧库就写进 Videos。
  2. **经 junction 写**：`scripts/export-e2e.mjs --media-lib`（缺省目标 `~/Videos/PromptCut/media`）在导出目录里建 `media` junction；而导出目录的 `media/` 正是编辑器的本地内容库，按需拉取、导入、Agent 预渲染的 bake 图、`index.json` 都往里写，于是经 junction 写进用户素材目录。
- 本机（笔记本）检查过：用户级、系统级、当前进程都**没有**设 `PROMPTCUT_*` 环境变量，所以这台机器上直接开终端跑不会触发第 1 条。273 GB 更可能来自桌面版本身的正常使用（用户和桌面版里的 Agent 预渲染），这一项清理属于下一项「存储占用」功能，不在本任务里。

## 核对清单

判定：**写 V** = 在所述条件下会写到 `~/Videos/PromptCut`；**写数据** = 只会写到用户的应用数据目录（不是 Videos，但同样不该写）；**安全** = 输出目录显式、不受外部变量影响；**只读** = 只读 Videos。「继承」都指继承外部的 `PROMPTCUT_EXPORT_DIR` / `PROMPTCUT_DATA_DIR`。

### 产品代码里涉及 Videos 的地方（不改，只核对）

| 位置 | 判定 | 理由 |
|---|---|---|
| `server/vite-plugin-frames.ts:963` | 条件写 V | 帧库根 `PROMPTCUT_EXPORT_DIR \|\| <root>/out` + `frame-library`，继承时写 V |
| `server/vite-plugin-media.ts:17`、`vite-plugin-export.ts:42`、`vite-plugin-audio.ts:25`、`server/vision/http.ts:30` | 条件写 V | `outRoot()` 同上；内容库 `media/`、导出 `export-<id>/`、`ai-visual/` |
| `server/vite-plugin-media.ts:35`、`vite-plugin-export.ts:54` | 只读 | 旧素材目录 `~/Videos/PromptCut/media` 只放进 `/api/media/file` 的读白名单 |
| `server/frame-pipeline.mjs:249` | 只读 | `mediaStamper` 的 `exportRoot` 只用来找 `/@export/` 素材文件打戳 |
| `server/costs-store.mjs:39`、`card-overrides.mjs:37`、`vite-plugin-stt.ts:88`、`vite-plugin-frames.ts:791` | 条件写数据 | `PROMPTCUT_DATA_DIR` 优先；成本记录、卡片改动层、同步卡片、cookies |
| `server/render-node/host.mjs:386` | 安全 | 渲染主机给子进程显式设两个变量（`--data` 下） |
| `desktop/src-tauri/src/lib.rs:80`、`:359`、`:466` | 产品 | 桌面壳定导出目录，不动 |

### 测试（`npm test`：`server/test/*.test.mjs`、`src/**/*.test.mjs`、`tools/report-worker/*.test.mjs`）

| 位置 | 判定（修前） | 理由 |
|---|---|---|
| 所有测试 | 修后安全 | `server/test/global-setup.mjs` 在测试运行器主进程里摘掉两个变量，所有测试文件子进程继承摘过的环境（实测 Node 24 的 `--test-global-setup` 改的环境会传给测试文件子进程） |
| `server/test/collect-plugin.test.mjs:55`、`:152` | 条件写 V + 写数据 | 项目根是临时目录，但 `mediaDir(root)` 先看 `PROMPTCUT_EXPORT_DIR`：继承时下载的 `--out-dir` 指到 `~/Videos/PromptCut/media`（假解释器本身不写文件，:156 的断言会挂），cookies 读写走 `PROMPTCUT_DATA_DIR` |
| 在进程里建 `FramePipeline` 的测试（`agent-lane`、`cards-layout`、`legacy-preview-target:76`、`host-card-code:334`、`frame-*`、`artifact-png:86`、`card-lock-pipeline:162`、`env-fingerprint-keys`、`m6c-*`、`prerender-executor`、`small-tier`、`stream-queue`、`xnode-dedup`） | 帧库安全；条件写数据 | 帧库根都显式给（临时目录或 `out/…`）；成本记录 `costsDir` 在 `PROMPTCUT_DATA_DIR` 设了时写那里 |
| 起托管组合的测试（`ht-kit.mjs:466`、`sp-kit.mjs:179`、`sp-hosting.test.mjs:127/544`、`auth-main`、`docservice-auth`、`ht5/ht6/ht7`） | 安全 | 显式设 `PROMPTCUT_DATA_DIR`；托管组合不读 `PROMPTCUT_EXPORT_DIR` |
| 用 `vite-plugin-media` 等的测试（`media-hash`、`media-pcm`、`media-pull`、`media-tiers`、`asset-service`、`asset-store-http`、`c66-integ`、`asset-namespaces`） | 安全 | 文件头已 `delete process.env.PROMPTCUT_EXPORT_DIR` 或显式设临时目录 |
| `agent-c65*.test.mjs`、`session-link-page.test.mjs` | 安全 | 进程内 `createVite({ configFile: false })`，不装插件，不碰帧库 |
| `ai-visual-shared.test.mjs`、`prune-prerender-cache.test.mjs`、`costs.test.mjs`、`prerender-costs-root.test.mjs`、`card-*.test.mjs` | 安全 | 显式临时目录，或测试内先摘再还原 |
| `server/test/skill-gate-e2e.mjs:39` | 修后安全（不在 `npm test` 里） | 起 `scripts/headless.mjs`，继承外面环境；手动跑时仍会继承（见「没做的」） |

测试侧没有一处起完整的编辑器 vite（带 `vite.config.ts` 插件），所以修前「写 V」只有 `collect-plugin.test.mjs` 一处，而且那时断言会挂、容易发现。

### 探针与脚本（`scripts/`，不含 `scripts/archive/`）

修前会继承、起编辑器（完整 vite，会拉起预渲染进程写帧库）且**没设 `PROMPTCUT_EXPORT_DIR`** 的，继承时**写 V**：

| 位置 | 修前设了什么 |
|---|---|
| `scripts/card-shots.mjs:69` | 都没设 |
| `scripts/preview-boxes.mjs:53` | 都没设 |
| `scripts/probes/c65-editor-probe.mjs:726` | 都没设 |
| `scripts/probes/placeholder-probe.mjs:50` | 都没设 |
| `scripts/probes/card-overlay-probe.mjs:131` | 只设 DATA |
| `scripts/probes/card-sync-probe.mjs:109/138`、`:248` | 只设 DATA |
| `scripts/probes/chat-window-probe.mjs:129` | 只设 DATA |
| `scripts/probes/playback-probe.mjs:77` | 只设 DATA |
| `scripts/probes/probe-gate-probe.mjs:92` | 只设 DATA |
| `scripts/probes/reveal-probe.mjs:75` | 只设 DATA |
| `scripts/verify-preview-window.mjs:19` | 只设 DATA（进程内改 `process.env`） |
| `scripts/probes/export-baseline-compare.mjs:105` | 都没设（在另一棵检出里跑导出） |
| `scripts/export-e2e.mjs:166` | 设了 EXPORT；`--media-lib` 时**经 junction 写 V**（无需任何环境变量） |

修前只会**写数据**（设了 EXPORT、没设 DATA，或进程内 `FramePipeline` 的成本记录）：`scripts/export-e2e.mjs:170`（经 `scripts/lib/dev-server.mjs:123` 起的 dev server）、`scripts/verify-playback.mjs:18`、`scripts/verify-unified-frames.mjs`、`scripts/probes/gl-unified-probe.mjs:58`、`snapshot-diff-compare.mjs:157`、`stream-probe-project.mjs:54`、`stream-produce-probe.mjs:83`、`scripts/replay-frames.mjs`。

修前已**安全**（两个变量都显式设成临时目录或 `out/`）：`c10-browser-probe:349`、`c10-catalog-probe:210`、`c10-cost-probe:187`、`c10a-demo-probe:217`、`c66-t9-probe:213`、`ht-w-probe:233`、`m8/procs.mjs:122`（`childEnv`；`SCRUB_ENV` 里**没有**这两个，但 `childEnv` 之后显式覆盖）、`m8-migrate-probe:518`、`online-join-probe:173`、`png-adopt-probe:109`、`queue-mode-probe:174`、`ready-index-probe:152`、`render-host-probe:270`、`shared-project-lan:242`、`snapshot-hash-probe:107`、`tiers-probe:98`、`review-loop-run:105`、`verify-playback-project:24`、`m7-bake(-node)-probe`、`small-tier-probe`（`FramePipeline` 的 `dataRoot` 也显式）、`m7-browser/m7-node/m8-e/m8-scale/m8-outbound`（经 `m8/procs.mjs` 或托管组合，显式）。`c10-stage-probe:702` 只设 DATA，但起的是托管组合，不读 EXPORT。

只起托管组合或不起子进程、不涉及导出目录的（`bakery` 直连的 `verify-card-*`、`verify-export-frame-content`、`verify-frame-scene-order`、`verify-stale-capture`、`verify-determinism`，输出目录都相对 cwd 显式给）：安全。

`scripts/probes/stage-content-probe.mjs:220` 里的「Videos」是 `pixelTrackVideos` 变量名，和目录无关。

产品入口，**不改**：`scripts/headless.mjs`（编辑器 Skill 拉起的无头实例，要跟随宿主目录）、`scripts/render-host.mjs`（按 `--data` 显式设两个变量）、`scripts/prune-prerender-cache.mjs:49`（清用户帧库的维护工具，缺省就该看 `PROMPTCUT_EXPORT_DIR`）。

## 改了什么

提交：`b434864b`（报告骨架）、`02c03958`（公共件与测试全局准备）、`bc2d0d2c`（探针、export-e2e、守门）、本报告提交。

1. **公共件** `scripts/lib/user-dirs.mjs`（新）：`USER_DIR_ENV_KEYS`、`userExportDir()`、`isUnderUserExportDir()`、`scrubUserDirEnv(env)`、`assertNoUserExportDir(env)`。
   `scripts/lib/no-user-dirs.mjs`（新）：副作用模块，被引入时摘掉本进程的两个变量，摘了什么打一行到 stderr。
   - 为什么是**摘掉**而不是改设成 `<root>/out`：两个变量没设时的缺省就是开发期布局；尤其 `PROMPTCUT_DATA_DIR` 没设时卡片改动直接改检出目录、同步卡片落 `.pc-work/`，设成 `<root>/out` 会改变探针的行为。需要临时目录的探针照旧自己显式设（显式值写在引入之后，照常生效）。
2. **测试**：`server/test/global-setup.mjs` 的 `globalSetup()` 先 `scrubUserDirEnv(process.env)`，整个 `npm test` 的测试文件子进程都不再继承。
3. **探针与脚本**：49 个会起编辑器 / 托管组合 / 渲染进程 / 导出、或在进程里建 `FramePipeline` 的脚本，第一个 import 改成 `import '<相对路径>/lib/no-user-dirs.mjs'`（清单同守门测试的识别规则；包括 `scripts/lib/dev-server.mjs`、`scripts/probes/m8/procs.mjs`、`m8/lib.mjs`，所以经它们起进程的探针也被覆盖）。`scripts/lib/dev-server.mjs` 的 `startOnce` 另外 `assertNoUserExportDir`：调用方显式给的目录指向 Videos 就抛。
4. **export-e2e 的素材**：`--media-lib` 不再建 junction，改为 `mirrorMediaLibrary()`（新，放在 `scripts/lib/dev-server.mjs`）：在 `<work>/media` 建真目录，素材文件逐个硬链接（不占空间、同一份字节），`index.json` 和点开头的元数据复制；编辑器新写的文件只落在镜像里，删镜像不动素材。要求 `--work` 与素材在同一个盘，不在就报错让用户换 `--work`（不退回 junction）。旧版留下的 junction 仍由 `sweepStaleJunctions` 清理；`createJunction` 等函数保留（`dev-server-junction.test.mjs` 仍在测）。`--work` 指到 Videos 下直接报错。
5. `server/test/bakery-deps.test.mjs`：「`server/**` 不 import `scripts/**`」的例外名单加上 `no-user-dirs.test.mjs`（测 `scripts/lib` 本身）与 `global-setup.mjs`（测试准备，不是生产代码），各写一句原因。

没动 `src/`、`server/frame-pipeline.mjs`、`server/frame-identity.mjs`、`server/bakery/`，也没动任何产品缺省值。

## 守门

`server/test/no-user-dirs.test.mjs`（新，5 条，全部不依赖本机环境）：

1. `isUnderUserExportDir` 用假 home 判定（本目录、子目录、前缀相同的兄弟目录、Windows 大小写）；
2. `scrubUserDirEnv` 只摘两个变量；`assertNoUserExportDir` 指到 Videos 时抛；
3. 静态核对 `global-setup.mjs` 在 `globalSetup()` 里调 `scrubUserDirEnv(process.env)`、`package.json` 的 `npm test` 走这份全局准备；在全局准备之下运行时再核对本进程的两个变量不指向 Videos；
4. 扫描 `scripts/`（跳过 `archive/`）：凡源码匹配「起编辑器 / 托管组合 / 渲染主机或进程 / 导出 / `FramePipeline`」规则的，**第一个 import** 必须是 `no-user-dirs.mjs`；产品入口在白名单里写明原因；扫描数少于 20 个时判规则失效；
5. `mirrorMediaLibrary`：真目录、硬链接（`nlink` 为 2）、镜像里新写的文件与改写的 `index.json` 不进素材目录、删镜像后素材完好。

## 验证

只跑了与改动直接相关的单个测试文件（笔记本是性能基准机，全量 `npm test` 与 G0 由主会话在另一台机器跑）：

- `node --test server/test/no-user-dirs.test.mjs` → 5/5 通过。
- 守门会拦：临时删掉 `scripts/probes/tiers-probe.mjs` 的那行 import 再跑，第 4 条失败并指出「tiers-probe.mjs:第一个 import 是 import { spawn, spawnSync } from 'node:child_process';,要 import '../lib/no-user-dirs.mjs'」；恢复后通过。
- 全局准备生效：`PROMPTCUT_EXPORT_DIR=%USERPROFILE%\Videos\PromptCut PROMPTCUT_DATA_DIR=C:\x node --experimental-test-module-mocks --test-global-setup=server/test/global-setup.mjs --test server/test/no-user-dirs.test.mjs` → 打出两行「[global-setup] 不继承外部的 …」，5/5 通过。
- 副作用模块生效：带着指向 Videos 的 `PROMPTCUT_EXPORT_DIR` 引入 `scripts/lib/no-user-dirs.mjs`，之后 `process.env.PROMPTCUT_EXPORT_DIR` 为 `undefined`。
- `node --test server/test/bakery-deps.test.mjs server/test/m8-kit.test.mjs` → 23/23 通过（`m8-kit` 引入了改过的 `m8/lib.mjs`、`m8/procs.mjs`）。
- `node --test server/test/syntax.test.mjs server/test/dev-server-junction.test.mjs server/test/no-user-dirs.test.mjs` → 12/12 通过。
- 改过的 51 个脚本逐个 `node --check` 全过；`node scripts/export-e2e.mjs`（不给参数）照常报用法。
- `npx tsc -b --force` → 退出码 0。

没跑：全量 `npm test`、G0（按任务书交主会话在另一台机器跑）；没有真跑一趟 `export-e2e --media-lib`、也没真跑任何探针（重负载，且本机是基准机）。

## 没做的、留给主会话判断的

- **单独跑某个测试文件**（`node --test <文件>`，不经全局准备）仍会继承外部变量。测试侧没有一处起完整编辑器，最坏是 `collect-plugin.test.mjs` 的下载目录与 cookies、进程内 `FramePipeline` 的成本记录；要彻底堵可以在这几个测试文件头加摘除，本次没扩大范围。
- `scripts/probes/shared-project-probe.mjs:653` 故意读 `process.env.PROMPTCUT_DATA_DIR` 找集群令牌（只读），不起编辑器，没加引入，守门规则也不匹配它。
- `server/test/skill-gate-e2e.mjs`（手动跑、不在 `npm test` 里）起 `scripts/headless.mjs` 时继承外部环境；`headless.mjs` 是产品入口，没改。
- `PROMPTCUT_PYLIBS`、`PROMPTCUT_MODELS`（桌面壳也设，指向应用数据目录）没摘：它们不写 Videos；若也要隔离，加进 `USER_DIR_ENV_KEYS` 即可，但会让探针重新下载 Python 库和模型。
- 守门第 4 条靠源码正则识别「会起进程的脚本」：新探针若用别的写法起编辑器（例如另写一个启动函数、又不经 `dev-server.mjs` / `m8/procs.mjs`），可能漏识别。
- 对任务书的更正：任务书说「`m8/procs.mjs` 起编辑器时会删掉一批 `PROMPTCUT_*`」，核实是删 `SCRUB_ENV`（15 个，**不含** `PROMPTCUT_EXPORT_DIR` / `PROMPTCUT_DATA_DIR`），但 `childEnv()` 随后显式设了这两个，所以原本就安全。`vite-plugin-media.ts` / `vite-plugin-export.ts` 的旧素材目录只进读白名单，不写。
