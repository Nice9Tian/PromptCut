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
