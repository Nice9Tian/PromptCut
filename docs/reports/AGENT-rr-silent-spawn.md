# AGENT-rr-silent-spawn

任务：Windows 上起子进程不弹命令行窗口——给 child_process 调用补 windowsHide: true，加守门测试。分支 claude/rr-silent-spawn，基于 main 5d960cb4。

## 做了什么
- 补 windowsHide: true 共 18 处：
  - server/（10 处）：vision/worker-pool.ts 的 fork（弹窗的直接原因）和 taskkill、vite-plugin-collect/export/stt/subject.ts 的 taskkill、vite-plugin-export.ts 起 node、bakery/export.mjs、bakery/ffmpeg.mjs（2 处）、runners/agy.mjs（选项放在展开之前，调用方仍可覆盖）。
  - scripts/（8 处）：card-shots.mjs、verify-preview-window.mjs、verify-unified-frames.mjs、acceptance/four-stage-manifest.mjs（命令串里 `node -e` 的 execSync）、probes/stream-common.mjs（4 处，被多支探针共用）。
  - 其余 server/、scripts/lib/、scripts/*.mjs 里起进程的调用原本就带了。
- 只加选项，没改行为，没重构。
- 守门测试：server/test/windows-hide-silent-spawn.test.mjs，扫描器在 server/test/silent-spawn-scan.mjs（TypeScript 语法树）。扫 server/（不含 test）、scripts/lib/、scripts/*.mjs、scripts/acceptance/、scripts/probes/lib/ 与 stream-common.mjs。认命名/命名空间/默认导入、require、动态 import、promisify 别名、选项写在后几行、选项经变量或展开传入；认不出（选项来自参数、拼进字符串里的 require）一律报出。

## 例外名单（在测试里，每条有理由；名单过期也会红）
1. server/vite-plugin-ai.ts、vite-plugin-export.ts、vite-plugin-exports-list.ts 各一处 opener：「打开所在文件夹」起 explorer.exe，要让用户看到窗口，windowsHide 会把它藏起来。
2. server/hosted-render/deploy.mjs：拼进 deploy 脚本文本、在远端 Linux 上执行的 `node -e`。
3. node-pty（server/runners/agy-login.mjs）不是 node:child_process，扫描不认，不需条目。

## 验证
- 守门测试 4 条通过；临时撤掉 worker-pool.ts 的修改后测试变红并报出 `worker-pool.ts:118`、`:123`，已还原。夹具测试覆盖 11 种没带的写法（全报）和 11 种带了/无关的写法（全不报）。
- 第 4 步实测见下。
- 基线：见文末。

### 第 4 步：弹窗链实测
链：Start-Process（隐藏）→ node scripts/render-host.mjs（端口 7400，数据目录在临时区）→ vite（render-host 以 detached + windowsHide 起，脱离控制台）→ 编辑器侧一秒后自动起两台热备 render-worker.mjs（worker-pool.spawnWorker，即原来弹窗的那一环）；另有预渲染 vite 子进程。配置文件故意不可读（预渲染日志 `bad-shared-config`），不影响这条进程链。
- 改前（命令要求的窗口查询）：可见窗口 0；OpenConsole 0；conhost 72；WindowsTerminal 0。
- 运行中每 3 秒采样共 30 秒：可见窗口始终 0；OpenConsole 始终 0（conhost 73→64，是别的进程退出）；同时确认两台 render-worker.mjs 进程在跑（父进程是脱离控制台的 vite）。
- 改后停掉我起的进程树（taskkill /T，PID 10544）：我工作区相关进程残留 0；7400～7409 无监听；可见窗口 0；OpenConsole 0。
- 没有做「改之前的代码」对照（会再弹窗，按任务要求不做）。

## 没覆盖的（清单，不逐个改）
范围外、未改，扫描器能认出的遗漏：
- scripts/probes/ 单支探针（约 25 个文件、40 余处），文件：backdrop-probe、c10-stage-probe、c10a-demo-probe、cold-start-probe、gl-atlas-probe、gl-migrate-compare、m7-bake-node-probe、m7-bake-probe、m7-build-probe、m7-upload-probe、m8-outbound-probe、pixelmap-gl-probe、playback-probe、probe-gate-probe、ready-index-probe、reopen-public-tunnel、reveal-probe、sound-effects-probe、stage-content-probe、storage-cap-probe、storage-ui-probe、stream-encoder-params、stream-produce-probe、svg-url-serialize-probe、tier-switch-probe、videodecoder-probe。多数是 ffmpeg、taskkill、vite 的起停，另有 `powershell -Command` 取 CPU 负载的几处。
- scripts/remote/docservice.mjs：ssh/scp 共 5 处（部署工具，手动在控制台跑）。
- desktop/scripts/*（build-release、make-extension、make-patch、prepare-python、prepare-runtime、smoke-*）约 30 处：构建与冒烟脚本。
- 测试文件里自己起进程的（src/*.test.mjs、desktop/test/*）：`npm test` 经 scripts/lib/test-silent-processes.mjs 预加载统一补，本次未动。
- 扫描器只看直接调用；经 `spawnImpl = spawn` 这类默认参数传入的，只在调用点检查选项（现有几处调用点都带了）。
