# M8 之后的推进报告（2026-09-29 起；第 1 轮 PC 主会话，第 2 轮起笔记本主会话）

主计划 M8 完成之后、团队测试之前的工作，按用户 2026-09-29 的 goal 推进：先把在线用户卡第二轮收尾出 0.7.2，再处理真机复测报回来的缺陷与 `HANDOFF-2026-09-29.md` 第 4、6 节的遗留和性能缺陷，然后做主计划「M8 之后、团队测试之前：存储占用」。每一轮在这里续一节。

用到的代号：G0 / G0-R = 通用基线与渲染基线（`guide_files/verification.md`、主计划第 8 节）；UC2-1 = 本轮发给笔记本辅助节点的指令编号；六项 = `HANDOFF-2026-09-29.md` 第 2 节表里在线用户卡第二轮的六项修复；frameCode = 渲染代码版本（`server/frame-code.mjs`，桌面节点只认领代码版本相同的在线计划）。

## 第 1 轮：在线用户卡第二轮收尾，出 0.7.2（2026-09-29）

### 1.1 做了什么

1. **审 diff**。`claude/online-user-cards-2`（`c00bcd8a`，相对 `2e1518a3` 44 个文件 +2779 / −195）与 `claude/desktop-auto-node`（`2c9ba278`，16 个文件 +2104 / −39）逐文件看过代码部分：
   - 桌面自动成为渲染节点：编辑器进程新开的 `/api/render-node/*` 与预渲染进程的 `/api/frames/render-node` 都在 `/api` 同源守卫之后（`vite-plugin-api-guard.ts`，预渲染进程的 `vite.prerender.config.ts` 另只放行编辑器的源），跨站页面改不了节点绑定；`ticket-request` 只认不带 Origin 的本机请求；页面只交文档服务地址、项目 id、素材基址和 render 连接票据，不交口令与 `K`；票据只在内存、不进日志与诊断；在线构建整段剪掉。
   - 第 1～5 项：参数面板的只读视图不进主注册表；测量门按连接关、最多等 10 秒；未知卡片不测、不判重、不进计划，导出与预渲染的卡片计划只跳过未知卡那几个输出、别的卡的键不变；占位符缩放对坏值有兜底（倒数夹在 1/8～16）。
   - 结论：两支没发现新引入的问题。发现一处 **0.7.1 就有的缺陷**（见下一条）。
2. **修卡片源码解析的死循环**（0.7.1 遗留）。`src/kernel/cardSourceParse.mjs` 的转义解码遇到没闭合的 `\u{`（例如 `"\u{41"`）时把下标拨回 −1、从头重扫，无限循环直到内存耗尽；在线页面同步到这样的卡片源码（写卡时手误、Agent 写坏）会卡死。实测：修复前该用例以 134 退出（堆耗尽），修复后 1 ms 返回。分支 `claude/card-parse-escape`（`c0401057`，改 2 行、加 1 条单测）。这段代码在 `src/` 下，会改 frameCode，只能随桌面补丁同版出，所以放进 0.7.2。
3. **合入 main**：`db7aa05e`（`--no-ff` 合 `claude/uc2-candidate`，无冲突）→ `2fbe038d`（`--no-ff` 合 `claude/card-parse-escape`）→ `3aa859e3`（版本号 0.7.1 → 0.7.2，外壳仍 0.2.6）。每次合入后 release 都判过并前进，现 main = release = `3aa859e3`。
4. **部署 `/editor`**（只换编辑器页，托管服务没动）：从 `3aa859e3` 的干净检出出在线构建 `index-lRHxl2a9.js`（`index.html` sha256 `43d471a0530f…`，82 个 assets），先在服务器备份到 `/root/editor-backup-20260929-072.tgz`、`/root/editor-runtime-config-20260929-072.json`，再上传换代（`editorSwapLines()`，保留上一代 assets 7 个与运行配置）。
5. **阿里云真机路径**：`desktop-auto-node-probe --remote` 过（1.2 节）。
6. **出补丁**：PC 主工作区 `desktop\release\PromptCut-patch-0.7.2.exe`，12,413,364 字节，SHA-256 `22da3bf659f3ad344ec9196970b8fe38e9bb37668b2c33fe5531ad3613cecbe1`；`manifest-0.7.2.json` 基准 0.7.1、外壳代次 0.2、不含依赖（0.7.0、0.7.1、0.7.2 三份清单的依赖哈希都是 `0c3aa690a005…`，从 0.7.0 直接装即可）。
7. **通知用户**装 0.7.2 复测（播报已发）。

### 1.2 验证

| 项 | 提交 | 命令 | 结果 |
|---|---|---|---|
| G0 类型检查 | `db7aa05e`、`2fbe038d` | `npx tsc -b --force` | 0 错误 |
| G0 全量测试 | `db7aa05e` | `npm test` | 3855 / 3853 通过 / 0 失败 / 2 跳过 |
| G0 全量测试 | `2fbe038d` | `npm test` | 3856 / 3854 / 0 / 2（新单测「没闭合的 \u{ 转义」通过） |
| G0 构建 | `db7aa05e`、`2fbe038d`、`3aa859e3` | `npm run build` | 成功 |
| 在线构建与代码版本 | `db7aa05e` | `npx vite build --mode online` | `index-C0tZfBDH.js`，嵌 `066c10a4383a…`，与桌面算出的相同（与交接文件记的一致） |
| 在线构建与代码版本 | `2fbe038d`、`3aa859e3` | 同上 | `index-lRHxl2a9.js`，嵌 `57568600294c…`，与桌面 `frameCode()` 相同；改版本号不改代码版本 |
| G0-R 导出确定性 | `db7aa05e` | `verify-determinism.mjs --url http://127.0.0.1:5690/?export=1` | 1800 / 1800 帧相同 |
| G0-R 导出像素基线 | `db7aa05e` | 与 `pc-g0r-base`（`d70fce77`）逐帧比 | 1800 帧相同，不同 0、缺 0、多 0 |
| G0-R 快照重放 | `db7aa05e` | `verify-unified-frames.mjs --origin …5690` | PASS |
| G0-R 预渲染探针 | `db7aa05e` | `ready-index-probe --port 5693`；`stream-produce-probe` 与 `--group`；`preview-fallback-probe` 与 `--page-preload` | 全部退出 0；ready-index `fails: []`；stream 两种 PASS；fallback 两种透明拍 0、沙漏屏幕 28 像素 |
| 交接第 3 节第 1 步 | `2fbe038d` | `c10-browser-probe --user-card --only-a4 --no-video --base-port 5690` | 退出 0，`ok: true`，`fails: []`，用时 1201 s；用户卡那一步 686.7 s 拿到层（ready 91 帧）；成员页页面错误、控制台错误都为 0；探针建的项目已删。上次的退出码 4 没复现 |
| 在线用户卡探针 | `2fbe038d` | `online-user-cards-probe --dist <在线构建> --base-port 5690` | 退出 0，`ok: true`，`fails: []` |
| C10 界面探针 | `2fbe038d` | `c10-ui-probe --dist <在线构建>` | 第一次（代理开在 5690 / 5693）挂 A7：代理收到 2 条 `/api/mcp/call`。查明是本机的 MCP 客户端按 `%TEMP%\promptcut\port.json` 找编辑器，而该文件被 G0-R 里 `ready-index-probe` 起的编辑器写成了 5693；页面自己的 `/api` 拦截记录为空，`src/` 里也没有调用这个接口的代码。换到 5680～5683 重跑：退出 0，`ok: true`，`fails: []`，A7 两项记录都为空，A8 回 501 |
| `/editor` 部署 | `3aa859e3` | 三个地址取 index 与 JS；无头打开 `/editor/` | 主站与 `s1.` / `s2.` 都发 `index-lRHxl2a9.js`、内含 `57568600…`，运行配置保留 `{ v: 1, stageOrigins: [s1, s2] }`；无头打开 200、标题 PromptCut、页面错误 0、控制台错误 0；`promptcut-hosted` 重启次数仍是 16（没重启） |
| 阿里云真机路径 | `3aa859e3` | `desktop-auto-node-probe --remote https://8-219-80-16.sslip.io --base-port 5690 --skip-off` | 退出 0，`ok: true`，`fails: []`，458 s。A1 节点连上、推送目标一开始就是云端素材服务（`source: page`）；A2 层表与块齐 24.8 s；A3 另一设备贴上用户卡 291 s；A4 桌面页关着时在线页改用户卡、这台桌面节点渲完换上 86 s；A5 离开后节点撤掉 3.5 s；桌面页与成员页页面错误都为 0；项目已用创建者凭证删（`shared.admin.ok`） |
| 补丁 | `3aa859e3` | `cd desktop && npm run release -- --from-head --patch-only` | 退出 0；见 1.1 节第 6 条 |

以上探针都在 PC 上跑（本机替身，见 1.3 节），带耗时门槛的项与在线探针的耗时待笔记本复核。

### 1.3 与交接文件、对齐时不一致的地方

- **笔记本辅助节点没接 UC2-1**：它回复仍在用户 2026-09-28 给它的「下线后待命」目标下，要用户在它的会话里说恢复才动。按 goal（对端不在线用本机替身、不等），UC2-1 的各项在 PC 上跑了，带时限的项标「待笔记本复核」；已告诉它恢复后先向主会话报到、按届时的新指令做。
- **多合了一处修复**：0.7.2 比交接文件写的多了解析器修复，frameCode 因此从 `066c10a4…` 变成 `57568600…`，在线构建是 `index-lRHxl2a9.js`（不是 `index-C0tZfBDH.js`）。0.7.1 及更早的桌面节点不会认领 0.7.2 在线页面发的计划（代码版本不同），装了 0.7.2 补丁的才会。
- **`c10-ui-probe` 第一次挂 A7**：本机环境串扰，不是代码问题（1.2 节表中那一行）。

### 1.4 新发现、记入遗留

- **探针起的编辑器会覆盖公共的 `%TEMP%\promptcut\port.json`**（`vite-plugin-ai.ts` 写，`mcp-server.mjs` 读）。用户的编辑器开着时，这会把用户那边 MCP 工具调用引到探针的编辑器上；本轮 `c10-ui-probe` 的 A7 误挂就是它反过来的样子。独立渲染主机已把 `TEMP` 指到自己的目录（`render-host.test.mjs` 有断言），探针起的编辑器还没有。放进第 2 轮。
- 本轮没有改 `port.json` 的现值（指向已退出的 5693）：用户的编辑器下次启动会重写它。

### 1.5 待跨机复核

- 笔记本复核带耗时门槛的项：`ready-index-probe`、`stream-produce-probe`（含 `--group`）、`preview-fallback-probe`（含 `--page-preload`）；以及在线探针的耗时（用户卡那一步 686.7 s、真机路径 A3 291 s、A4 86 s）。
- 用户装 0.7.2 后的真机复测（1.6 节第 1 条）。
- 第 6 项「本机当主机的项目」端到端（要 `PROMPTCUT_LAN_HOST=1`，会弹防火墙；沿用交接文件的记法）。

### 1.6 待用户项

1. **装 0.7.2 补丁并复测**：`desktop\release\PromptCut-patch-0.7.2.exe`，从现在的 0.7.0 直接装，不用先装 0.7.1；装之前先关掉那台机器上在跑的 PromptCut Agent 会话。复测第 2 节六项与真机路径：安装版不设任何环境变量打开放云端、含用户卡的项目；另一台设备的浏览器进同一项目，用户卡的层能贴上；浏览器发的补渲由这台桌面版认领完成。
2. **在笔记本辅助会话「PromptCut 笔记本辅助测试节点」里说恢复**，它才接主会话的指令（1.5 节的复核）。
3. 其余沿用 `HANDOFF-2026-09-29.md` 第 8 节。

### 1.7 顾问调用记录

本轮没有调 codex 或 Gemini：没有卡住的问题，审查发现的缺陷根因清楚、修复只有一处判断。

## 第 2 轮：交接收尾——c10 用户卡回归、uc-latency、存储占用合流，合入 main（2026-09-30，笔记本主会话）

按用户 2026-09-30 的 goal 从 `HANDOFF-2026-09-29-pc.md` 第 3 节接着做。本轮多用到的代号：A3 / A4 = `desktop-auto-node-probe` 的两步（A3：另一台设备的在线页面进项目、贴出用户卡；A4：桌面页面关掉后在线页面改用户卡、桌面节点认领渲完、在线页面换上）；snapshotCode / captureCode = 共享快照键与卡片 PNG 缓存里的「渲染器版本」（`server/frame-code.mjs`，它们的文件表里任何一个文件改一个字，所有机器已有的共享快照或 PNG 缓存就作废）；J9 / J10 = `server/test/prerender-executor.test.mjs` 里队列执行器的两组用例；〔裁〕= 会话定的、待用户审的决定。

### 2.1 做了什么

1. **接手**（第六次交接）。主计划 0.4 节自检全过：codex（`gpt-6-sol` / high）与 agy（`gemini-3.1-pro-high`）各答一句；`opus-dev`、`opus-dev-high`、`gpt-manager`、`agy-manager` 各派一个空任务都回「ok」；main `b7e68eee` 上 tsc 0、`npm test` 3876 / 3874 / 0 / 2；SSH 免交互、`.env.cluster` 在、信箱能读（`to-local` 最新 34，是云端对交接通知的回执；`to-cloud` 最新 30）；阿里云 pm2 的 `promptcut-hosted` 与 `probe-coord` 在线、nginx 有 `/coord` `/hosted` `/media`、UFW 放行 22 / 8787 / 8788 / 80 / 443、两个 healthz 回 200、外网匿名 WebSocket 升级回 401；8777 / 8778 第二实例不在（只记录）。接手动作：主计划第七次修订 `45296836`，归档 `AGENT-probe-hygiene.md`（`701a27c0`），release 前进到 `701a27c0`；`to-cloud` 31 通知云端本会话接手（status，不用回执）。PC 辅助节点整轮 offline，笔记本辅助节点按用户安排待命，算力活都在笔记本上跑；笔记本是性能基准机，本轮带耗时门槛的数就是最终数。
2. **① `c10-browser-probe` 用户卡回归**。在笔记本上建 `claude/r2-merge` 的 worktree，先合进 stale-layer 最后一版（`05212eed`：单测 SIG-7 与排查记录），在机器空闲时连跑三遍 `c10-browser-probe --user-card --only-a4 --no-video`，三遍都过，用户卡那一步 712.0 / 606.7 / 551.5 s；`online-stale-layer-probe --dist` 过。拆第一遍的时间线：创建者自己的计划 6 段在进成员那一步之前渲完；成员页的计划要创建者节点渲 10 段（用户卡 5 段、另一张重卡 5 段），节点并发 1，每段 44～121 s（平均约 71 s），用户卡最后一段排在最后，所以整段贴上要 712 s；推送队列没有扣段（`outOfScope` 0、扣着 0，老路径不限范围），两边签名都是 `i1-7d741a8c3803f58e`。结论：r2-merge 没有功能回归，交接文件怀疑的「签名对不上」「push-scope 扣段」都排除；PC 那次是机器同时跑着几支探针、逐段渲染超过 1200 s 时限。慢的本身由 uc-latency 修（下面第 4 条）。r2-merge 推送后合进 storage-merge（`14bd8dca`）。
3. **审 diff**（stale-layer、push-scope、存储占用五支与合流、uc-latency）：
   - 会删用户盘上东西的代码逐段看过：启动清遗留只认几种固定的文件名形态、属主进程拿不准按「还在」、跳过链接；帧库淘汰 30 分钟内用过的与正在打开的项目不删，先改名进 `.storage/trash/`、改名失败就跳过（不会删一半），多进程只持锁的那个淘汰；导出删除接口按导出目录名的规则与真实路径核对，不跟链接，正在导出的不让删。我起的 dev server 缺省把帧库放在 worktree 的 `out/` 下，碰不到用户的 `Videos\PromptCut`。
   - **发现 storage-leaks 改了 `server/bakery/ffmpeg.mjs`**（`streamPngVideo().abort()` 里等 ffmpeg 退出后删半截输出）。这个文件在 snapshotCode 与 captureCode 的文件表里，合流后 snapshotCode 从 `00a5264bf8a0…` 变成 `f3adde92c4ce…`、captureCode 从 `86e443cb6fa8…` 变成 `168d07283322…`：用户和各节点已有的共享快照与卡片 PNG 缓存会全部作废，装上新版都要重新预渲染。临时 MOV 中止时 `MovFrameStore` 本来就自己删，这处删除是多余的，所以还原到 main（`e24eafb8`〔裁〕），测它的单测由子 Agent 删掉（`401bab11`）。还原后两个指纹与 main 相同。代价：单进程流式导出（`export.mjs` 的透明层流）中途失败时，半截 `overlay.mov` 留在导出目录，与 main 现在的行为相同；存储占用的语义写的是「取消或失败的导出留下的文件同样列出」，用户能在「存储」里看到并删掉。
4. **② uc-latency 收尾**。候选分支 `claude/post-m8-r2` = storage-merge + `claude/uc-latency`（`7c18653c`，自动合并无冲突）+ 上面的还原：
   - **复查 A4 卡 30 分钟**：用每处等待都记日志的探针连跑三遍 `desktop-auto-node-probe --skip-off --prerender-log`，都没卡（2.2 节）。卡住那次的记录是节点空闲、队列里只有第一版计划，卡在认领之前；顺推只改认领之后这一段怎么渲。
   - **根因二（一段一趟顺推）留下**〔裁〕，写进 `docs/plan/queue-executor-design.md` 第 3 节（`4a41dad2`），理由见 2.3 节第 2 条。
   - **J9、J10 挂了**：候选上 `npm test` 3961 条挂 2 条，断言的是逐批的 `bakeFrames` 调用记录（uc-latency 当时没跑全量）。按回退梯次第 1 级交给 Opus（`opus-dev-high`）：逐批断言在关掉顺推时照跑，另加顺推的 J9b / J10b；顺推下的中止语义核过没有问题（中止后不写后面的帧、快照只入库到 4 帧的边界、换新信号重渲能补齐），`frame-pipeline.mjs` 没动（`78f9ab41`）。
   - 改前改后各三遍、G0-R、全量测试都过（2.2 节），storage-merge 快进到 `e0b7d769`。
5. **③ 最终合流验证**（storage-merge `e0b7d769`）：G0、G0-R、九个探针全过，看过开始页「存储」截图（2.2 节）。`--no-ff` 合入 main `fe62c17f`（合并结果与验证过的提交相比只多了 main 上的文档），`npm run build` 成功、没动桌面壳，release 前进到 `fe62c17f`；本轮 8 份 AGENT 报告附上主会话审查后归档（`c9a4810c`）。
6. **代码注释里的旧报告路径**（第 ⑤ 项第一条，提前到 0.7.3 之前做〔裁〕：改 `src/` 与 `frame-pipeline.mjs` 会换代码版本，0.7.3 本来就要换一次，放在一起只换一次）：子 Agent 在 `claude/comment-paths` 把 49 个文件里 60 处 `docs/reports/AGENT-…` 改成 `docs/archive/agent-reports/AGENT-…`；进快照键与捕获代码文件表的 5 处（`server/bakery/ffmpeg.mjs` 4 处、`src/render/snapshot/renameSceneIds.ts` 1 处）不改。我另核过：除它的报告外，改动的行把路径换回去后逐字相同，那两张文件表里的文件一个没碰；两个指纹改前改后相同，tsc 0，`npm test` 3963 / 3961 / 0 / 2。合入 main（见 2.2 节最后一行）。

### 2.2 验证

全部在笔记本上跑（性能基准机；PC 辅助节点整轮 offline）。

| 项 | 提交 | 命令 | 结果 |
|---|---|---|---|
| 接手基线 | main `b7e68eee` | `npx tsc -b --force`；`npm test` | 0 错误；3876 / 3874 / 0 / 2 |
| ① 用户卡回归（改前 1） | r2-merge `05212eed` | `c10-browser-probe --user-card --only-a4 --no-video --base-port 5600 --dist <在线构建>` | 退出 0，`ok: true`，`fails: []`，整遍 1246 s；用户卡那一步 712.0 s，层出自创建者节点（指纹 `258acaaa7c5fe509`），ready 91 帧，签名 `i1-7d741a8c3803f58e` |
| ① 用户卡回归（改前 2、3） | 同上 | 同上 | 都退出 0、`ok: true`；606.7 s（整遍 1119 s）、551.5 s（整遍 1057 s） |
| ① 旧层探针 | 同上 | `online-stale-layer-probe --dist <在线构建> --base-port 5610` | 退出 0，`ok: true`，`fails: []`，44 s；改参数后 8～10 ms 撤旧层，改回照贴，新层照常换上 |
| 快照键 | 候选（还原前 / 后） | `snapshotCode()`、`captureCode()` | 还原前 `f3adde92c4ce…` / `168d07283322…`；还原后 `00a5264bf8a062ff6e0b5ed0516cccd1` / `86e443cb6fa8…`，与 main 相同 |
| ② A4 复查 ×3 | 候选 `401bab11` | `desktop-auto-node-probe --skip-off --prerender-log --dist <在线构建> --base-port 5620` | 三遍都退出 0、`ok: true`、没有 `wait.timeout`；A3 46.8 / 47.2 / 59.3 s；A4（改动 → 贴上）26.3 / 26.2 / 26.3 s（改后约 0.8 s 发计划、约 3.7 s 认领、约 26.3 s 云端层表换新即贴上）；整遍 490 / 487 / 491 s |
| ② 一段 60 帧（诊断行 `executor.render-timing`） | 同上 | 三遍的预渲染日志 | 顺推段 10.4～12.9 s（换页约 1 s、推帧 4.2～5.6 s）；每个预渲染进程记 `converter.worker`（预览视频的像素活走 worker 线程）。改前（第 ① 项的时间线）每段 44～121 s |
| ② 用户卡改后 ×3 | 候选 `4a41dad2` | `c10-browser-probe --user-card --only-a4 --no-video --base-port 5600 --dist <在线构建>` | 三遍都退出 0、`ok: true`；用户卡那一步 110.4 / 110.4 / 110.5 s（整遍 259 / 257 / 257 s），对改前中位数 606.7 s 约 5.5 倍；层都出自创建者节点、签名相同 |
| ② 全量测试（改测试前） | 候选 `4a41dad2` | `npx tsc -b --force`；`npm test` | 0 错误；3961 / 3957 / **2 失败** / 2（J9、J10） |
| ② J9 / J10 修正后 | 候选 `e0b7d769` | `node --experimental-test-module-mocks --test` 四个相关测试文件；`npm test` | 19 / 19 过；全量 3963 / 3961 / 0 / 2 |
| G0-R 导出确定性 | 候选（代码同 `e0b7d769`） | `verify-determinism.mjs --url http://127.0.0.1:5640/?export=1` | 1800 / 1800 相同（520 s） |
| G0-R 导出像素基线 | 同上 | 与 main `701a27c0` 现导的 1800 帧逐像素比（基准导出 183 s） | 1800 帧相同，不同 0、缺 0、多 0 |
| G0-R 快照重放 | 同上 | `verify-unified-frames.mjs --origin http://127.0.0.1:5640`（不设 `PROMPTCUT_EXPORT_DIR`） | PASS |
| G0-R 预渲染探针 | 同上 | `stream-produce-probe` 与 `--group`；`preview-fallback-probe` 与 `--page-preload`；`ready-index-probe --port 5643` | 全部退出 0、`fails: []`；1080p 全幅流 15 帧分段编码 p50 261 ms（238 / 261 / 268，门槛 300 ms）；预览兜底两种透明拍 0 |
| ③ 类型检查 | storage-merge `e0b7d769` | `npx tsc -b --force` | 0 错误 |
| ③ 桌面自动成为渲染节点（两遍） | 同上 | `desktop-auto-node-probe --dist <在线构建> --base-port 5620` | 退出 0，`ok: true`，`fails: []`，588 s；A3 46.8 s、A4 26.4 s；A7：另一个本机项目 120 帧、漏进共享项目 0 块、范围外 108 段、层表没写进共享项目、计划只为绑定项目发布；第二遍关掉开关后不起节点；两边页面错误 0 |
| ③ 在线用户卡 | 同上 | `online-user-cards-probe --dist <在线构建> --base-port 5650` | 退出 0，`ok: true`，`fails: []` |
| ③ C10 界面 | 同上 | `c10-ui-probe --dist <在线构建> --proxy-port 5660 --doc-port 5661 --asset-port 5662 --proxy2-port 5663` | 退出 0，`ok: true` |
| ③ 旧层 | 同上 | `online-stale-layer-probe --dist <在线构建> --base-port 5610` | 退出 0，`ok: true`，`fails: []`；改后 8～11 ms 撤旧层 |
| ③ 帧库上限与淘汰 | 同上 | `storage-cap-probe --port 5670` | 退出 0，`ok: true`，`fails: []`；缺省上限 53687091200 字节（50 × 1024³） |
| ③ 开始页「存储」 | 同上 | `storage-ui-probe --port 5680`；看截图 `u1-storage.png`、`u8-fresh-bytes.png` | 退出 0，`ok: true`；真接口下「5.0M / 上限 50.0G（缺省）」、导出 3 份（其中中间文件 33.0M）、每份可打开目录 / 只删中间文件 / 删除，未完成的有标记 |
| 合入与 release | main `fe62c17f` | `npm run build` | 成功；snapshotCode 仍是 `00a5264bf8a0…`，代码版本（frameCode）`1a68bdb5797e…`；release 前进到 `fe62c17f` |
| 注释旧路径 | `claude/comment-paths` → main `e3a09498` | `npx tsc -b --force`；`npm test`；两个指纹；我另核 diff | 0 错误；3963 / 3961 / 0 / 2（子 Agent 在分支上跑）；snapshotCode `00a5264bf8a0…`、captureCode `86e443cb6fa8…` 不变，代码版本变成 `63945f91ae27…`（0.7.3 带的就是它）；除报告外改动的行把路径换回去后逐字相同 |

### 2.3 〔裁〕（本轮主会话定，待用户审）

1. **还原 `server/bakery/ffmpeg.mjs`**（2.1 节第 3 条）：保住共享快照键与捕获代码，用户装 0.7.3 后已有的预渲染缓存照常可用（第一次运行按上限清掉的部分除外）。
2. **一段一趟顺推留下**（uc-latency 根因二；交接文件 2.3 节要接手方定）。依据：
   - 语义 `product/rendering.md`「同一时刻同一帧」：逐批每批从挂载帧回放时不截图，依赖 JS 帧循环的卡（实测 `mu-word-rotate`）的快照从第 32 帧起与导出（顺序活渲）对不上，84 帧里 0 帧一致；顺推 79 帧一致，更贴近这条承诺；
   - 等价性：19 张共享档卡里 14 张两种做法逐字节相同（含用户卡 `mu-animated-shiny-text`），`lottie` 像素相同，canvas 重卡与页面播放头正要的那一段仍逐批；两张按计时器走的测试卡两种做法都不确定；
   - A4 卡住那次卡在认领之前，顺推只管认领之后怎么渲；笔记本三遍复查、最终合流一遍都没卡；
   - 速度：一段 60 帧笔记本上从 44～121 s 到 10.4～12.9 s。
   - 代价与后续：桌面自己那一趟后台预渲染（整张卡、不给 `range`）仍逐批，这类卡同一个共享键两条路产出的字节不同，另立任务把后台那一趟也改成顺推，或修掉回放不截图的相位落后。开关 `PROMPTCUT_QUEUE_SINGLE_PASS=0` 可退回逐批。
3. **第 ⑤ 项第一条（代码注释旧路径）提前到 0.7.3 之前**（排期，2.1 节第 6 条）：goal 的顺序是 ①～⑤，这一条挪前是为了少换一次代码版本，范围不变。
4. **沿用 PC 主会话的〔裁〕**（播报过，本轮随合并进 main，仍待用户审）：stale-layer（层表输入签名 `inputSig`、过期后 15 秒内当结果在路上）；push-scope（`render-queue-contract.md` J.13 补充与 J.14、`contentId` 缺省不限范围）；存储占用（入口放开始页第五块与标题栏「存储…」、导出完成后删中间文件、缺省上限 50 GB 与小盘取 10%、30 分钟 / 10 分钟 / 2 分钟 / 5 分钟 / 24 小时 / 60 秒这些时间数；语义改在 `workflow/project.md`、`product/platforms.md`、`mechanism/platforms.md`「帧库」、`glossary.md`「帧库」）。其中二级的两条在这里再说明一次：`product/platforms.md` 写了桌面应用的预渲染缓存有上限、按最近使用淘汰、有「清理缓存」，导出产物只留成片与透明层、可列出与删除。

### 2.4 与交接文件、对齐时不一致的地方

- **第 ① 项没有改代码**：复测三遍都过，回归的两种怀疑都排除，只合了 stale-layer 最后一版的单测与记录。
- **第 ③ 项多了两处集成修正**：还原 `ffmpeg.mjs`，以及按顺推改 J9、J10 两条单测。
- **c10 的改前、改后取的分支不同**：改前取 r2-merge（不含存储占用），改后取最终合流（含存储占用）。存储占用对队列渲染那条路只加了「记使用」，不影响耗时，对比照样成立。
- **交接文件第 4 节「待跨机复核」里的耗时项**：0.7.2 那一组数（用户卡 686.7 s、真机路径 A3 291 s、A4 86 s）已被本轮代码取代，本轮在笔记本上补跑的是新代码的数（2.2 节），以它为准；真机路径随 0.7.3 再跑（第 3 轮）。

### 2.5 新发现、记入遗留

- **桌面后台那一趟仍逐批**：依赖 JS 帧循环的卡同一个共享键两条路产出的字节不同，与导出也不一致（2.3 节第 2 条），另立任务。
- **队列节点并发 1、成员计划里几张卡的段交错排队**：用户卡最后一段可能排在最后（第 ① 项的时间线）。uc-latency 已记，另立任务（按「页面正在看的卡先渲」排序，或节点多开一条 lane）。
- **`/api/exports*` 的 409 回包没有 `code`**（`/api/storage*` 有），接口约定补一句即可。
- **代码注释里有两处旧报告路径不能改**：`src/render/snapshot/renameSceneIds.ts`、`server/bakery/ffmpeg.mjs` 在快照键文件表里，改注释也会作废共享快照，等这两个文件因别的原因要改时顺带。
- **单进程流式导出失败留半截透明层**（与 main 相同，按语义列出可删；2.1 节第 3 条）。
- stale-layer 报的两处原有闪烁（暂停时用户卡偶尔在旧层与沙漏之间闪一下；播放中重卡每拍在快照与占位之间交替），以及改卡片**源码**不在输入签名的判据里：沿用交接文件的记法，另立任务。

### 2.6 待跨机复核

- 本轮的耗时项都在笔记本上跑了（性能基准机），不再待复核。
- PC 辅助节点整轮 offline：`asset-lan-probe` 跨机实跑、第 6 项「本机当主机的项目」端到端、M8 留下的真热点 / 真手机扫码 / iOS 导出，沿用交接文件第 4 节。
- 真机路径 `desktop-auto-node-probe --remote`：随 0.7.3 跑（第 3 轮）。

### 2.7 待用户项

1. 审 2.3 节的〔裁〕。
2. 装 0.7.3（第 3 轮出）。**装上后的第一次运行会清缓存**：用户 PC 的帧库约 282 GB，启动约 2 分钟后按 50 GB 上限一次清掉约 230 GB 最久没用的预渲染缓存（需要时重新预渲染，不可撤销）；想留更多，装完先在开始页「存储」把上限调大。
3. 沿用交接文件第 4 节其余各项（笔记本辅助会话要用户说恢复才接活；`cloud-untouched` 按用户查要不要给托管端加只读接口；`claude/join-error`、演练数据目录等）。

### 2.8 顾问调用记录

本轮没有调 codex 或 Gemini：第 ① 项复测三遍都过，拆时间线就定位清楚，不是做不出来；`ffmpeg.mjs` 的问题是审 diff 时对照 `server/frame-code.mjs` 的文件表核出来的；J9、J10 是测试断言了旧行为，回退梯次第 1 级 Opus 一次就改过了。子 Agent：`opus-dev` 两次（删测被还原行为的单测；代码注释旧路径），`opus-dev-high` 一次（J9 / J10）。

## 第 3 轮：出 0.7.3，部署 `/editor`（2026-09-30，笔记本主会话）

### 3.1 做了什么

1. **版本号**：根目录 `package.json` 与 `package-lock.json` 两处 0.7.2 → 0.7.3，外壳仍 0.2.6（本版没动 `desktop/` 与 Rust，只动 Node 那一半，按 `git_and_release.md` 应用版本末位 +1、走更新补丁）。提交 `648eec9a`，`npm run build` 成功，release 前进到 `648eec9a`。
2. **在线构建**：从 `648eec9a` 的干净检出（分离头 worktree）出 `index-BHNnlkq0.js`（`index.html` sha256 `2e54bc7d3263…`，82 个 assets），嵌代码版本 `63945f91ae27…`；共享快照键仍是 `00a5264bf8a0…`（与 0.7.x 相同，用户已有的共享快照照常可用）；在线构建里没有 `/api/storage`、`/api/exports` 调用。
3. **部署 `/editor`**（只换编辑器页，托管服务没动）：先在服务器备份 `/root/editor-backup-20260930-073.tgz`（4.5 MB，换 0.7.3 之前的 `index-lRHxl2a9.js` 那一代）与 `/root/editor-runtime-config-20260930-073.json`；新构建经 tar 传到 `/opt/promptcut-hosted/.incoming-editor`，执行 `server/hosted/deploy.mjs` 的 `editorSwapLines()`：保留上一代 assets 8 个与运行配置，本代 82 个、在位 90 个。`promptcut-hosted` 仍 online、重启次数仍 16。
4. **阿里云真机路径**：`desktop-auto-node-probe --remote` 过（3.2 节），探针建的项目已用创建者凭证删掉。
5. **补丁：待办**。PC 辅助节点「PromptCut M5～M8 PC 辅助测试节点」整轮 offline，补丁只能在 PC 主工作区打（基准清单 `desktop\release\manifest-0.7.2.json` 在那里）。指令 PC-073-1 已写好（`git pull` 到 `648eec9a` 后 `cd desktop && npm run release -- --from-head --patch-only`，回传补丁字节数、SHA-256 与清单要点），PC 报到后发。**在装上 0.7.3 补丁之前，用户的桌面版不会认领 0.7.3 在线页面发的计划**（代码版本不同）；用户还没装 0.7.2，这个情况 0.7.2 部署后就已存在，本次没有变坏。

### 3.2 验证

| 项 | 命令 | 结果 |
|---|---|---|
| 构建 | `npm run build`（`648eec9a`） | 成功 |
| `/editor` 三个地址 | 取主站与 `s1.` / `s2.` 的 `/editor/`、对应 JS，核嵌的代码版本 | 三处都 200、都发 `index-BHNnlkq0.js`（3,809,539 字节）、都含 `63945f91ae27`；运行配置 `{ v: 1, stageOrigins: [s1, s2] }` 保留 |
| 无头打开 | 无头 Chrome 打开 `https://8-219-80-16.sslip.io/editor/`，静置 8 s | 200，标题 PromptCut，页面错误 0，控制台错误 0 |
| 阿里云真机路径 | `desktop-auto-node-probe --remote https://8-219-80-16.sslip.io --base-port 5620 --skip-off`（从 `648eec9a` 的干净检出起桌面端，笔记本） | 退出 0，`ok: true`，`fails: []`，582 s；A1 节点连上；A2 云端层表与块齐 21.3 s；A3 另一设备贴出用户卡 101.1 s；A4 改动 → 贴上 47.3 s；A5 离开后节点撤掉 4.1 s；两边页面错误 0；项目已删（`shared.admin.ok`）。对照 0.7.2 在 PC 上的真机路径 A3 291 s、A4 86 s |

### 3.3 待用户项

1. **装 0.7.3 补丁**（PC 上线打出来之后；打出来会再通知，附路径与 SHA-256）。从现在的 0.7.0 直接装即可，不用先装 0.7.1、0.7.2；装之前先关掉那台机器上在跑的 PromptCut Agent 会话。
2. **装上后的第一次运行会清缓存**：用户 PC 的帧库约 282 GB，启动约 2 分钟后按 50 GB 上限一次清掉约 230 GB 最久没用的预渲染缓存（需要时重新预渲染，不可撤销）；想留更多，装完先在开始页「存储」把上限调大。
3. 审第 2 轮 2.3 节的〔裁〕。

### 3.4 待跨机复核

- PC-073-1（出补丁）与用户装 0.7.3 后的真机复测。

## 第 4 轮：第二批遗留，出 0.7.4（2026-09-30，笔记本主会话）

交接文件 2.1 节末的第二批遗留（出处 `REPORT-render-queue-m8.md` 第 13.5 节、`REPORT-M5-M8.md` 第 7.4 节）。代码注释旧路径那一条已在第 2 轮提前做完；其余 9 条分三个子 Agent 并行（笔记本上，各自 worktree 与端口段），合流后主会话在空闲机器上验证。本轮用到的代号：D2 = M7 契约的卡片级锁闲置接手规则；K3(b) / 播放态互换 = 只认全局时钟的轻卡由后台舞台补跑后与可见舞台互换（C10 契约）；W7 = M7 的真跨机验收。

### 4.1 做了什么

| 遗留 | 分支（子 Agent） | 做法 |
|---|---|---|
| `SWAP_MS` 按卡种实测 | `claude/swap-tuning`（`opus-dev-high`） | 新探针 `swap-cost-probe` 实测 37 张卡换一层快照的主线程代价；换帧成本从一律 3 ms 改成按层取：投递过的按快照大小估（`0.8 + 0.04 × 文本 KB + 0.009 × 位图 KB` ms），没投递过的按卡种（DOM 2、Lottie 6.5、画布 4 ms），认不出的 3 ms；`fitBeatSwaps` 从上到下逐层累加装箱 |
| 区分自然进场与从卡中间开始播放 | 同上 | 新纯模块 `src/render/playEntry.mjs` 按拍序号判连续（掉帧不跳拍号，不算断）；连续播放中自然进场的轻卡不发起播放态互换，从卡中间开始播放的照旧按估时 |
| 页面只是忙也会被 D2 接手 | `claude/queue-maint`（`opus-dev-high`） | 新节点消息 `node.active`（页面在认领或后台舞台有更急的活时每 10 s 报一次）；队列的锁闲置按「最后一次产出或报忙」算，报忙的节点须此刻连着、指纹是锁上的那一个；旧页面、旧队列行为不变（契约 F.9〔裁〕） |
| 执行器不标 `snapshotOversize` | 同上 | 执行器切分前按本机快照库的超限记录标整张卡，切分不再把它给纯浏览器 |
| 舞台互换缺专门剧本 | 同上 | 把宿主每帧前半段抽成 `src/editor/stageBake.ts`（行为不变），写互换剧本单测 QM-F-01～05；**剧本抓到一个缺陷并修掉**：一帧中途后台舞台换人时原来算一次可重试失败，现在在新后台重做这一帧（每帧至多 2 次）、不计失败 |
| 在线舞台握手成功后又断 | `claude/misc-maint`（`opus-dev`） | 新 `src/online/stageWatch.ts`：每 5 s 问一次、15 s 没回包算断开（页面隐藏不判），先重载那一台，20 s 握不回来或 10 分钟里断到第 4 次就退回同源单舞台、不再重载 |
| 静态解析跨文件引进来的控件 | 同上 | 在线页面沿相对 import 取内容库里同目录的卡片源码，解析器跟着 import 求值（导出、转出、别名、默认导入、有环检测），内置模块用页面登记的现成值；`select` / `asset` 缺字段能推断的补上，认不出的在面板逐条说明；仍不执行源码 |
| 探针 `PC_CHROME_ARGS` 用法说明 | 同上 | 6 个探针文件头与 `scripts/README.md`：只透传、典型用途 `--no-sandbox`、不要用来关 TLS 校验 |
| 纯浏览器节点经公网锚点段 33～37 s（观察项） | 主会话 | 本机（门槛以笔记本本机为准）重测：合流上 `m7-browser-probe --role all --timing-authoritative` 最慢锚点段 22.2 s（门槛 30 s；M7 合入时 27.6 s）；经公网的观察随 0.7.4 部署后用站点模式补测（4.2 节） |

合流：`claude/r3-merge` 依次合 misc-maint、queue-maint、swap-tuning（无冲突），主会话写 `mechanism/rendering.md` 四处三级语义〔裁〕（`982ee1c5`，4.3 节），验证全过后 `--no-ff` 合入 main `0efcd41d`。合入时 origin/main 上多了另一个会话按用户 2026-09-30 的决定推的规则提交 `d0ceaf9e`（`verification.md`「性能基准机」补一条：笔记本当主会话期间，不计时的活 PC 辅助在线就派给它、不在线本机自己做，不等不登记），因 release 已推到 `0efcd41d`，没有改写历史，而是把 origin/main 合进来（`d1f14798`）。三份 AGENT 报告附审查后归档（`1721baae`）。

**0.7.4**：版本号 0.7.3 → 0.7.4（外壳仍 0.2.6，`3fcb52cf`）；从干净检出出在线构建 `index-CkR3pv-2.js`（`index.html` sha256 `42b35c84d46d…`，82 个 assets），嵌代码版本 `bab4aba83c78…`，共享快照键与捕获代码不变。阿里云上先备份（`/root/hosted-app-backup-20260930-074.tgz`、`/root/editor-backup-20260930-074.tgz`、`/root/editor-runtime-config-20260930-074.json`），再**重部署托管服务**（`deploy-hosted`，两个公网地址照原样，`--save`；22:09:24Z 重载，`promptcut-hosted` 重启次数 16 → 17，已连着的客户端断开一次后接续）——自上次部署（M8 的 `0cabcfb0`）以来托管端清单里真正改的只有队列服务的 `node.active`（另有两处注释路径与桌面端读配置用的可选 `contentId`）；然后换 `/editor`（保留上一代 assets 7 个与运行配置，本代 82 个、在位 89 个）。桌面补丁：PC 辅助整轮 offline，指令改为 PC-074-1（取代没发出的 PC-073-1，用户直接装 0.7.4）。

### 4.2 验证

全部在笔记本上跑。三个子 Agent 各自在分支上跑了 tsc、全量测试与相关探针（机器有负载）；下表是合流后主会话在**空闲机器**上跑的（性能基准机，计时作数）。

| 项 | 提交 | 命令 | 结果 |
|---|---|---|---|
| 类型检查、全量测试 | `claude/r3-merge` | `npx tsc -b --force`；`npm test` | 0 错误；4035 / 4033 / 0 / 2（main 上 3963 条，新增 72 条） |
| 代码指纹 | 同上 | `snapshotCode()`、`captureCode()`、`frameCode()` | `00a5264bf8a0…`、`86e443cb6fa8…` 不变；代码版本 `bab4aba83c78…` |
| 换帧成本重测 ×2 | 同上 | `swap-cost-probe --origin http://127.0.0.1:5700 --all`（两轮，整机忙碌中位 13%） | 37 张卡；中位数 DOM 1.41、画布 3.25、Lottie 5.02 ms；按大小估的常数中位误差 28%、低估 2 / 37，空闲拟合 `0.59 + 0.031 × 文本 KB + 0.0062 × 位图 KB` 中位误差 9%、低估 22 / 37（取舍见 4.3 节） |
| G0-R | 同上 | `g0r.sh`：`verify-determinism` / 与 main `701a27c0` 逐像素 / `verify-unified-frames` / `stream-produce` 两种 / `preview-fallback` 两种 / `ready-index` | 全过：1800 / 1800 相同；像素 1800 相同（探针卡 `padNodes` 缺省 0 不改导出）；快照重放 PASS；其余 `fails: []` |
| C10 A4 场景 | 同上 | `c10-browser-probe --only-a4 --no-video --base-port 5600 --dist <在线构建>` | 退出 0、`fails: []`；自然进场的 `probe-typewriter` 跳过 121 次、300 拍连续没断；跳到 3.03 s 再播照旧走估时；一拍装得下 6 层（`deadMs` 23.33）、其余显示占位，暂停后精确活渲保持；点停到精确 7.0 s（与之前同量级） |
| 用户卡那一步 | 同上 | `c10-browser-probe --user-card --only-a4 --no-video` | 退出 0；105.5 s（第 2 轮改后 110 s 左右），层出自创建者节点、签名相同 |
| 在线用户卡 | 同上 | `online-user-cards-probe` | 退出 0、`fails: []` |
| 舞台看守 | 同上 | `online-stage-watch-probe --base-port 5720`（整机负载 0） | 退出 0；弄崩 B 19.2 s 重载、19.7 s 握回来仍双舞台；A 的源回 503 再弄崩 A，34.8 s 退回同源单舞台并画出画面，之后不再请求舞台源；页面错误 0 |
| M7 本机（计时作数） | 同上 | `m7-browser-probe --role all --timing-authoritative --base-port 5710` | M7-A1～A12、D9、D10、D14、D1-D2-D12 全过；**A4 最慢锚点段 22.2 s**（门槛 30 s，M7 合入时 27.6 s）；A5 拖动让路后 619 ms 恢复；A12 长任务 0；只有 W7 真跨机待复核（退出码 3 = 只有待复核项） |
| 桌面自动成为渲染节点（两遍） | 同上 | `desktop-auto-node-probe --base-port 5620` | 退出 0、`fails: []`；A3 46.8 s、A4 26.3 s；A7 漏进 0 块、范围外 108 段；关掉开关不起节点；页面错误 0 |
| C10 界面、旧层 | 同上 | `c10-ui-probe`；`online-stale-layer-probe` | 都退出 0、`fails: []` |
| 合入与 release | main `0efcd41d` → `d1f14798` | `npm run build` | 成功（合并结果与验证过的集成分支内容相同）；release 前进 |
| 0.7.4 构建 | `3fcb52cf` | `npm run build`；干净检出 `npx vite build --mode online` | 成功；`index-CkR3pv-2.js`，嵌 `bab4aba83c78` |
| 托管服务重部署 | `3fcb52cf` | `deploy-hosted --doc-public-url … --asset-public-url … --save` | 22:09:24Z 重载完成，重启次数 17；外网两个 healthz 200、匿名 WebSocket 升级 401；文档服务新 epoch、素材服务地址经集群令牌登记 |
| `/editor` 三个地址与无头打开 | 同上 | 核主站与 `s1.` / `s2.` 的 index 与 JS；无头 Chrome 打开 | 三处都 200、都发 `index-CkR3pv-2.js`、都含 `bab4aba83c78`；运行配置保留；无头 200、页面错误 0、控制台错误 0 |
| 阿里云真机路径 | 同上 | `desktop-auto-node-probe --remote https://8-219-80-16.sslip.io --base-port 5620 --skip-off` | 退出 0、`ok: true`、`fails: []`，595 s；A2 21.6 s、A3 114.7 s、A4 48.5 s、A5 4.0 s；页面错误 0；项目已删（`shared.admin.ok`） |
| 经公网观察（两个角色都在笔记本上的站点模式） | 同上 | `m7-browser-probe --site https://8-219-80-16.sslip.io`：creator 与 node（带 `--timing-authoritative`）两个进程 | 1363 s。**最慢锚点段经公网 32.6 s**（以前观察 33～37 s；按 M7 验收口径站点模式只作观察，门槛以本机 22.2 s 为准）。另有两项功能判定没过：A4 `page-layer-env-browser`（h1 / h2 / light 三层在检查那一刻仍是浏览器的指纹、就绪 0）、A10 `server-race-one-env-per-card`（`w1` 300 s 里一段也没做完）。分析见 4.5 节：与以前没有 D 时同一模式的现象一致（m7wlocal1 同样挂 `page-layer-env-browser`，M8 两个角色都在笔记本上的一轮 A10 记过超时），是站点模式经公网的时序现象，不是第 ⑤ 项带进来的回归；真跨机 W7 待 PC 上线复核 |

### 4.3 〔裁〕（本轮主会话定，待用户审）

1. **换帧成本的数照子 Agent 定的留作保守上沿**：空闲基准机上它们比实测中位数高约 28%，但 37 张卡只低估 2 张；空闲数据的无偏拟合误差更小（9%），却会低估 22 张——低估会让一拍超预算掉帧，高估只多显示占位。
2. **认可给探针卡 `probe-slow` 加 `padNodes`（缺省 0）**：按实测成本原 A4 场景 9 层都装得下一拍，验不到「装不下显示占位」；验收标准不变，只把附加重层做大。
3. **`mechanism/rendering.md` 四处三级语义**（`982ee1c5`）：换帧成本按层取；自然进场不互换；在线双舞台握手后又断的退回（5 / 15 / 20 秒与 10 分钟 4 次）；D2 闲置按「既没有再产出、也没有报告自己还在忙」算。
4. **马上出 0.7.4 并重部署托管服务**：第 ⑤ 项的队列改动要在托管端生效；托管端自上次部署以来只多了这一处实改，风险小；PC 上的补丁改为 0.7.4（0.7.3 的补丁本来就没打，用户直接装 0.7.4）。
5. **页面只是在播放或拖动、后台舞台没活时不算忙**（子 Agent 提请）：页面这时确实没在做那张卡，照留。

### 4.4 与计划、对齐时不一致的地方

- 第 ⑤ 项第一条（注释旧路径）已在第 2 轮提前做完。
- 二级语义建议（`product/platforms.md` 写「同步来的用户卡照常能改参数，读不出的逐条说明」）没写：不是改变承诺，只是把已实现的行为写成二级承诺，按最小修改先不动，列进待用户项。
- 合入时 origin/main 多了另一个会话按用户决定推的规则提交 `d0ceaf9e`（4.1 节），用合并而不是改写历史处理。

### 4.5 新发现、记入遗留

- **站点模式（两个角色在同一台机器上经公网）的两项功能判定没过**（4.2 节最后一行）。依据：M7 契约第 3.4 节「接手只在有人重新切分时发生」——A10 的 race 阶段加完 `w1`、`w2` 后没有再发布计划，即使没有 D，桌面节点也接不走 `w1`，`w1` 只能等经公网变慢的浏览器；A4 那一项在没有 D 时挂的样子是层被 pc 接走换了环境，这次层留在浏览器的环境里（D 生效），只是经公网上传慢、检查那一刻就绪 0。两项都是站点模式的时序现象；本机计时版（验收口径）同一份代码全过。要彻底分清，等 PC 上线跑真跨机 W7（PC 当创建者、笔记本当节点）。
- D 的取舍要记住：页面报忙时它锁着、还没去做的卡不会被快的节点接走；页面慢（经公网）而桌面快时，这类卡出结果可能比以前晚（以前 30 秒没产出、且有人重新切分就被接走）。如果以后真机上看到这个代价，可以把「报忙保护」收窄到页面已经为这张卡产出过帧的锁。
- `stageJobs.ts` 里补跑刚结束到互换之间有一小段空当，排着的 `bake` 可能在旧后台上开工（每帧前的核对保证帧是对的，子 Agent 没改，报告里给了改法）。
- 按大小估的换帧成本对样式多、结构简单的快照偏大；分派只按卡种、播放中按大小装箱，一拍里可能比分派时多出占位。
- 卡片对象本身写在别的文件里时（入口只 `export { card } from "./impl"`），在线页面仍认不出参数；`online-user-cards-probe` 还没有跨文件那张卡的端到端断言。

### 4.6 待跨机复核

- W7 真跨机（PC 当创建者、笔记本当纯浏览器节点，经阿里云）：要 PC 上线；顺带分清 4.5 节站点模式的两项。
- PC-074-1 出 0.7.4 补丁；用户装上后的真机复测。

### 4.7 待用户项

1. **装 0.7.4 补丁**（PC 上线打出来后再通知，附路径与 SHA-256）；0.7.3 的补丁不用装。
2. **装上后的第一次运行会清缓存**：帧库约 282 GB，启动约 2 分钟后按 50 GB 上限清掉约 230 GB 最久没用的预渲染缓存（需要时重新预渲染，不可撤销）；想留更多，装完先在开始页「存储」把上限调大。
3. 审 4.3 节与第 2 轮 2.3 节的〔裁〕；定要不要把「同步来的用户卡照常能改参数」写进 `product/platforms.md`（二级）。
4. 播放停顿期间要不要加音频看门狗（`TODO.md`，沿用）。

### 4.8 顾问调用记录

本轮没有调 codex 或 Gemini：三条子任务都是实现与测量，第一轮就做成；站点模式的两项判定查到根因在已知的模式局限（接手只在重新切分时发生、经公网慢），没有卡住。子 Agent：`opus-dev-high` 两个（swap-tuning、queue-maint），`opus-dev` 一个（misc-maint）。

## 第 5 轮：回到 TODO——R0 冷启动、Agent 工作方式 A1 与 A2、查询渲染，出 0.7.5（2026-09-30，笔记本主会话）

按 goal「之后回到 `docs/plan/TODO.md` 与主计划继续」。先把 TODO「语义与代码的差距」按 M5～M8 之后的合入更新（`6ac9018d`），核出两条早已做完的（手动截短总时长的入口、`see_frames` 回包附实体矩形，`27c01466`、`a6663d56`）；剩下的「工作方式」「Agent」两大块排成计划 `docs/plan/agent-workflow-plan.md`（`1ef55bb2`，A1～A6 六段，按主计划第 10 节发给用户、不等）。本轮用到的代号：R0 = TODO 里「dev server 冷启动慢」那一条；A1～A6 = 该计划第 2 节的六段；G1～G3 = 查询渲染任务的三处差距（AI 栏操作预览插队、Agent 专用实例空闲时接预渲染、Tailwind 扫描源）；D10 = 预渲染进程的三种模式（Agent / User / Full）。

### 5.1 做了什么

| 项 | 分支（子 Agent） | 做法 |
|---|---|---|
| R0 冷启动 | `claude/watch-ignore`（`opus-dev`），Tailwind 那处随 `claude/query-render` | 查出三处原因：依赖扫描把帧库里的快照 `.html` 当入口（大头，约 170 s）；worktree 路径里的 `.worktrees` 点段让监听忽略的 glob 整张失效；Tailwind 遍历整棵树（约 10 s）。前两处改成 `server/vite-scan-ignore.mjs`（依赖扫描入口只认页面，监听忽略按仓库根算），两份 Vite 配置共用（合入 `adb856b0`，报告归档 `d23d97cf`）；Tailwind 那处要改 `src/index.css`（进代码版本），搭查询渲染一起做（`source(none)` 加三行 `@source`） |
| A1 创造力等级 | `claude/creativity`（`opus-dev`） | 项目设置里选等级（出厂「高」），AI 栏按对话覆盖，桌面 APP 会话跟项目；所有工具调用的总入口按对照表拒绝越级；`set_project_meta` 只收 schema 声明的字段（`name`、`width`、`height`、`fps`、`duration`、`themeId`），Agent 写不进等级、也不能借它改项目别的内容；Agent 会话登记表（合入 `74f3b3ae`，报告归档 `7e3c27e3`） |
| 查询渲染 | `claude/query-render`（`opus-dev-high`） | 差距清单 D1～D13。G1：用户点开的操作预览走 `'preview'` lane，插到普通预渲染待办之前，不占 Agent 专用实例（以前正相反）；G2：专用实例开着且空闲时接一项普通预渲染（队列里的一项，或后台那一趟的一批卡），Agent 任务之后先空 1 秒；3D 视图的贴图预取移出 Agent 队列；G3 见 R0 |
| A2 用户正在编辑（本机） | `claude/user-editing`（`opus-dev`） | 页面把拖动中、文字编辑中、选中后 30 秒内动过的片段节流推给本机服务；Agent 读写到这些片段时结果带 `userEditing` 与一句提示（只提示不拦）；文档服务回的 `overwrote` 进结果（「用户刚改过」/「Agent <对话>（<厂商>）刚改过」）；在线构建剪掉推送 |
| 语义与计划 | 主会话 | `mechanism/agent.md` 两节（「创造力等级的判定」`53629a63`、「用户正在编辑与覆盖提示」`628b7d42`）；`mechanism/rendering.md` 查询渲染两条（`afabcab7`）；TODO 两条与 `cloud-task.md` I4 实现注（`36405da5`） |

合流：A1 先单独合入 main（`74f3b3ae`）。查询渲染与 A2 在集成分支 `claude/r4-merge` 上合（无冲突），主会话写两处三级语义，在空闲的笔记本上验证（5.2 节），全过后 `--no-ff` 合入 main `41713bf9`；两份报告附审查后归档（`a668d358`）。

**0.7.5**：版本号 0.7.4 → 0.7.5（外壳仍 0.2.6，`ed8484d1`），main = release = origin。从 `ed8484d1` 的干净检出出在线构建 `index-Bg2luIDZ.js`（`index.html` sha256 `b7d3a4d05383…`，82 个 assets），嵌代码版本 `dc21934c0c52…`；共享快照键 `00a5264bf8a0…` 与捕获代码不变，用户已有的共享快照照常可用；在线构建里的 `/api` 只剩登记过的 4 个（没有 A2 的推送路径）。**托管服务没动**：自 0.7.4 部署以来托管端清单（`server/hosted/files.mjs`）里的文件一个没改。换 `/editor` 前在服务器备份 `/root/editor-backup-20260930-075.tgz`（换下的 `index-CkR3pv-2.js` 那一代）与 `/root/editor-runtime-config-20260930-075.json`；新构建经 tar 传到 `.incoming-editor`，执行 `editorSwapLines()`：保留上一代 assets 7 个与运行配置，本代 82 个、在位 89 个。桌面补丁指令改为 PC-075-1（取代没发出的 PC-074-1；PC 辅助整轮不在线，记为待办）。

同时派出 A3、A6 两个子 Agent（5.6 节）。

### 5.2 验证

全部在笔记本上跑（PC 辅助整轮不在线）。集成分支上的一整套是主会话串行跑的；跑的时候 A3、A6 两个子 Agent 只读代码、写代码、一次跑一个测试文件（重活禁令，等主会话放行）。

| 项 | 提交 | 命令 | 结果 |
|---|---|---|---|
| 类型检查、全量测试 | `claude/r4-merge` `628b7d42` | `npx tsc -b --force`；`npm test` | 0 错误；4083 / 4081 / 0 / 2（main 上 4046 条，新增 37 条） |
| 代码指纹 | 同上 | `snapshotCode()`、`captureCode()`、`frameCode()` | `00a5264bf8a0…`、`86e443cb6fa8…` 不变；代码版本 `dc21934c0c52…` |
| G0-R | 同上 | `g0r.sh`（5800）：`verify-determinism` / 与 main `701a27c0` 逐像素 / `verify-unified-frames` / `stream-produce` 两种 / `preview-fallback` 两种 / `ready-index` | 全过：1800 / 1800 相同；像素 1800 相同；快照重放 PASS；其余 `fails: []` |
| C10 A4 场景 | 同上 | `c10-browser-probe --only-a4 --no-video --base-port 5600 --dist <在线构建>` | 退出 0、`ok: true`；自然进场的卡跳过 121 次，300 拍连续没断 |
| 用户卡那一步 | 同上 | `c10-browser-probe --user-card --only-a4 --no-video` | 退出 0、`ok: true` |
| 在线用户卡 | 同上 | `online-user-cards-probe` | 退出 0、`fails: []` |
| 舞台看守 | 同上 | `online-stage-watch-probe --base-port 5720` | 退出 0；弄崩 B 19.2 s 重载、19.7 s 握回来仍双舞台；弄崩 A 34.8 s 退回同源单舞台并画出画面 |
| M7 本机（计时作数） | 同上 | `m7-browser-probe --role all --timing-authoritative --base-port 5710` | 第一跑退出 1：node 角色打开 `<站点>/editor` 180 s 没等到 DOMContentLoaded，后面各项都没走到（见 5.5 节）；机器空下来单独重跑：M7-A1～A12、D9、D10、D14、D1-D2-D12 全过，**A4 最慢锚点段 22.3 s**（门槛 30 s，第 4 轮 22.2 s），A5 拖动让路后 682 ms 恢复，A12 长任务 0；只剩 W7 真跨机待复核（退出码 3） |
| 桌面自动成为渲染节点 | 同上 | `desktop-auto-node-probe --base-port 5620` | 退出 0、`ok: true`（616 s） |
| C10 界面、旧层 | 同上 | `c10-ui-probe`；`online-stale-layer-probe` | 都退出 0、`fails: []` |
| 查询渲染 | 同上 | `query-render-probe --port 5756` | 退出 0、`fails: []` |
| 创造力等级 | 同上 | `creativity-probe --shots` | 15 项全过 |
| 用户正在编辑 | 同上 | `user-editing-probe --shots` | 18 项全过；看过 `dragging.png`（被拖的卡选中、从 1 秒拖到约 1.6 秒，AI 栏操作记录里有 Agent 的那次 `get_clip`） |
| R0 冷启动 | 同上 | `r0-coldstart`（删 Vite 依赖缓存后起 dev server，量到 `/` 回 200 与编辑器可用）：空帧库两遍、树内 15 万个文件两遍 | 空帧库 3.0 s / 9.8 s；15 万个文件 3.0 s / 10.0 s，两者相同（0.7.4：17 s / 180 s；只修前两处时 20.6 s） |
| 合入与 release | main `41713bf9`、`a668d358`、`ed8484d1` | `npm run build`（合入后、改版本号后各一次） | 都成功；合并结果与验证过的集成分支内容相同；release 两次快进，已推送 |
| 0.7.5 在线构建 | `ed8484d1` 干净检出 | `npx vite build --mode online` | 成功；`index-Bg2luIDZ.js`，嵌 `dc21934c0c52` |
| `/editor` 三个地址与无头打开 | 同上 | `verify-editor.mjs dc21934c0c52` | 主站与 `s1.` / `s2.` 都 200、都发 `index-Bg2luIDZ.js`、都含代码版本；运行配置保留；无头 200、页面错误 0、控制台错误 0 |
| 阿里云真机路径 | 同上 | `desktop-auto-node-probe --remote https://8-219-80-16.sslip.io --base-port 5620 --skip-off` | 退出 0、`ok: true`、`fails: []`，972 s（那段时间 A3、A6 两个子 Agent 在跑重活，A7 用了 604 s）；A2 22.5 s、A3 97.7 s、A4 70.5 s、A5 4.5 s；页面错误 0；项目已删（`shared.admin.ok`） |

### 5.3 〔裁〕（本轮主会话定，待用户审）

1. A1 的九条〔裁〕、A2 的八条〔裁〕照子 Agent 定的留（全文在两份归档报告里）；计划 A1 行的白名单措辞按 schema 更正（`53629a63`）。
2. `mechanism/agent.md` 两节与 `mechanism/rendering.md` 查询渲染两条（三级），措辞在子 Agent 的 dry run 上略缩。
3. 查询渲染的实际做法与 `cloud-task.md` I4(b)、(b2) 不同：操作预览插在 `'queue'` lane 的待办之前，而不是在后台那一趟的批边界抢后台预渲染间；专用实例空闲时接一批（4 帧）而不是一帧。照子 Agent 的做法，计划加实现注。代价：专用实例开着时用户点开预览会多开一个 Chrome（以前两者共用一个），空闲 30 秒关。
4. 0.7.5 只换 `/editor`、不重部署托管服务（托管端文件没变）。
5. 计划第 4 节的三条〔裁〕（「正在编辑」的口径、子 Agent 深度 1 且至多 4 个、创造力等级存在项目里）已按原样落实。

### 5.4 与计划、对齐时不一致的地方

- 计划 A1 行把 `set_project_meta` 的白名单写成含三维透视与渲染路线，实际 schema 只有六个字段，已按实现更正（`53629a63`）。
- 计划第 3 节 A3 的验收「并行写入不再互相被拒」字面上与二级语义冲突（`product/document-service.md`：Agent 的写操作带期望版本，不符就拒、由它重读再改）。A3 子 Agent 按语义做（各记各的身份，读后再写不被对方误伤，没重读就写照样被拒），计划措辞随 A3 合入改。
- R0 原本打算分两次出，Tailwind 那一处搭查询渲染一起进了 0.7.5。

### 5.5 新发现、记入遗留

- `measure_audio` 在编辑器进程里按素材目录直接找文件交给 ffmpeg，没经素材服务的接口，与 `product/agent.md`「素材与产物」不符（A6 子 Agent 发现）。要和 A6 的 `measure_audio_js` 一起改，记进 TODO。
- M7 本机第一跑 node 角色的页面 180 s 没等到 DOMContentLoaded。同一份在线构建在其它 10 个探针里都正常加载，机器空下来重跑全过；当时两个子 Agent 只在轻量阶段。没能复现，先记为偶发；再出现就查探针站点服务与页面的请求拦截。
- 查询渲染报告第 7 节：队列模式的认领闸（节点在专用实例空着时多认领一项）、后台那一趟的锚帧 / 整场景 / MOV 专用实例借不到、Agent 请求碰上专用实例在做卡批时要等一批（本机 2.4～2.8 s）；D10 三种模式没做。都已写进 TODO「查询渲染」一条。
- 编辑界面顶上仍有「传统式 / 对话式 / SKILL」三档；TODO「工作方式」里「去掉对话式布局」一条还没做，排在 A4 前后。

### 5.6 在做

- **A3 多 Agent**（`claude/multi-agent`，`opus-dev`，端口 5840～5859）：`spawn_agent`（新页签、新身份、预设角色；深度 1、每个主 Agent 至多 4 个开着的子 Agent）；公告板搬到本机服务、改动记录由文档服务的提交流喂；被覆盖的一方和「正在改」的双方都在下一次工具结果里得知；分工模式归档；跨设备（文档服务新模块「在场状态」`presence.*`，合入后要重部署托管端；旧文档服务回 `unsupported` 时平稳退回）。代码与单测已写完，主会话放行后正在跑基线与探针。
- **A6 JS 自定义测量**（`claude/custom-measure`，`opus-dev`，端口 5860～5869）：`measure_audio_js`，专用无头 Chrome 沙箱（限时、限内存、断网四道），只在「高」档开放。代码与单测已写完，正在跑基线与探针。

### 5.7 待跨机复核

- W7 真跨机（PC 当创建者、笔记本当纯浏览器节点，经阿里云），沿用第 4 轮。
- PC-075-1 出 0.7.5 补丁；用户装上后的真机复测。

### 5.8 待用户项

1. **装 0.7.5 补丁**（PC 上线打出来后再通知，附路径与 SHA-256）；0.7.3、0.7.4 的补丁都不用装。
2. **装上后的第一次运行会清缓存**：帧库约 282 GB，启动约 2 分钟后按 50 GB 上限清掉约 230 GB 最久没用的预渲染缓存（需要时重新预渲染，不可撤销）；想留更多，装完先在开始页「存储」把上限调大。
3. 审 5.3 节，以及 A1、A2 两份归档报告里的〔裁〕。
4. 沿用第 4 轮：`product/platforms.md` 要不要写「同步来的用户卡照常能改参数」（二级）；播放停顿期间要不要加音频看门狗。

### 5.9 顾问调用记录

本轮没有调 codex 或 Gemini：各段第一轮就做成，没有卡住的语义问题。子 Agent：`opus-dev` 五个（watch-ignore、creativity、user-editing，以及在跑的 A3、A6），`opus-dev-high` 一个（query-render），`Explore` 一个（为写计划摸清现有 Agent 架构）。
