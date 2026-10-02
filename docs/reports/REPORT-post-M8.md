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

## 第 6 轮：A3 多 Agent 与 A6 自定义测量合入，出 0.7.6（托管端重部署）；A4 做完留在分支，A5 在做（2026-09-30，笔记本主会话）

接第 5 轮。本轮代号：A3、A4、A5、A6 = 计划 `docs/plan/agent-workflow-plan.md` 第 2 节的四段（多 Agent；SKILL 改为桌面 APP 经 MCP 直连；后台运行；Agent 用 JS 自定义测量）；「在场状态」= A3 在文档服务里加的模块，转发共享项目里成员正在编辑的内容、Agent 的范围与消息。

### 6.1 做了什么

| 段 | 分支（子 Agent） | 做法 |
|---|---|---|
| A6 自定义测量 | `claude/custom-measure`（`opus-dev`） | 新工具 `measure_audio_js`：与 `measure_audio` 同样取声音（片段原声、整个素材、时间轴混音），解码成 PCM 后在**专用**无头 Chrome 的 Worker 里跑 Agent 写的 JS（每次新的无痕上下文，限时、限内存、四道断网，心跳判卡死），只回 JSON；只在「高」档开放。验证中修了两处真问题：内存炸弹要 36 s 才回来且报错含糊（加心跳后约 6 s、报「内存超限」）；`mono` 比原声响 3 dB（改为各声道取平均） |
| A3 多 Agent | `claude/multi-agent`（`opus-dev`） | `spawn_agent`（新页签、新身份、预设角色；深度 1、每个主 Agent 至多 4 个开着的子 Agent，等级不高于父对话）；公告板从页面内存搬到本机服务，改动记录由文档服务的提交流喂；被覆盖方与「正在改」的双方在下一次工具结果里得知；分工模式归档（`teamMode`、`orchestrate*`、`triage`、`runRoleTask`、两条路由与菜单项）；文档服务加在场状态模块（`presence.*`，只在内存里转发、带过期、按空间隔离），跨设备的「正在编辑」、Agent 的范围与消息经它转发，旧文档服务回 `unsupported` 时停发。验证中修了三处真问题：在场状态的 `userId` 可能为空（tsc）；角色常量经 `agent-roles.mjs` 把 `node:fs` 带进页面（开发服务器会整页白屏，守门测试抓到）；拉起的页签沿用页面不认识的驱动名时 `ModelBar` 整页报错 |
| A4 SKILL 经 MCP 直连 | `claude/skill-mcp`（`opus-dev`） | 做完、验证全绿，**按计划留在分支、不合入**（6.6 节） |
| A5 后台运行 | `claude/tray`（`opus-dev`，在 A4 之上） | 在做 |
| 语义与计划 | 主会话 | `mechanism/agent.md`：「创造力等级的判定」末句、新增「自定义测量」「多 Agent」两节、「用户正在编辑与覆盖提示」的跨设备与被覆盖方两条（`a77855df`，三级〔裁〕）；计划 A3 验收按二级语义更正、A6 沙箱位置按实现更正；TODO 刷新（`4152cd4a`：分布式预渲染 M0～M8 已合入、云端计划只剩 I 节、R0 修完、Agent 与工作方式进度、记偶发的探针页面打不开） |

合流：`claude/r5-merge`（main `ed8484d1` 起）依次合 A6、A3（三处两边都改过的文件自动合并，核对过合并结果），主会话写语义后在笔记本上验证（6.2 节），合入 main `dc51de8c`；两份报告附审查后归档（`4152cd4a`）。

**0.7.6**：版本号 0.7.5 → 0.7.6（外壳仍 0.2.6，`2ef4f083`），main = release = origin。从干净检出出在线构建 `index-DKNBZ4FD.js`（`index.html` sha256 `179b9cb24a64…`，82 个 assets），嵌代码版本 `fc7191841c6e…`；共享快照键 `00a5264bf8a0…` 与捕获代码不变；`/api` 仍只有登记过的 4 个。先在服务器备份 `/root/hosted-app-backup-20260930-076.tgz`、`/root/editor-backup-20260930-076.tgz`（换下的 `index-Bg2luIDZ.js` 那一代）、`/root/editor-runtime-config-20260930-076.json`，再 `deploy-hosted --editor <在线构建> --doc-public-url … --asset-public-url … --save`：托管服务重载（`promptcut-hosted` 重启次数 17 → 18），`/editor` 换代保留运行配置。桌面补丁指令改为 PC-076-1（PC 辅助整轮不在线，记为待办）。

### 6.2 验证

全部在笔记本上跑。集成分支一整套由主会话串行跑；跑的时候 A4 子 Agent 在轻量阶段（只读、写代码、一次跑一个测试文件）。

| 项 | 提交 | 命令 | 结果 |
|---|---|---|---|
| 类型检查、全量测试 | `claude/r5-merge` `a77855df` | `npx tsc -b --force`；`npm test` | 0 错误；4089 / 4087 / 0 / 2（第 5 轮 4083 条，A6 加 15 条，A3 删减后净少 9 条） |
| 代码指纹 | 同上 | `snapshotCode()`、`captureCode()`、`frameCode()` | `00a5264bf8a0…`、`86e443cb6fa8…` 不变；代码版本 `fc7191841c6e…` |
| G0-R | 同上 | `g0r.sh`（5800） | 全过：确定性 1800 / 1800 相同；与 main `701a27c0` 逐像素 1800 相同；快照重放 PASS；流式生产两种、预览退回两种、就绪索引 `fails: []` |
| C10 A4 场景 | 同上 | `c10-browser-probe --only-a4 --no-video --base-port 5600 --dist <在线构建>` | 退出 0、`ok: true` |
| 用户卡那一步 | 同上 | `c10-browser-probe --user-card --only-a4 --no-video` | 第一跑退出 1（舞台 A 的能力表为空、播放没起来，那段时间一个遗留的 `grep` 进程占着一个核和 7 GB 内存，见 6.5 节）；机器安静后重跑退出 0、`ok: true`（274 s） |
| 在线用户卡 | 同上 | `online-user-cards-probe --base-port 5650` | 前三次退出 1：给第 5 个成员新开的页面打开 `<站点>/editor` 120 s 等不到 DOMContentLoaded；之后同一份构建连过 6 次（都是 34～35 s，其中 4 次带 Chrome 网络日志）。二分见 6.5 节 |
| 舞台看守 | 同上 | `online-stage-watch-probe --base-port 5720` | 退出 0、`ok: true` |
| M7 本机（计时作数） | 同上 | `m7-browser-probe --role all --timing-authoritative --base-port 5710` | M7-A1～A12、D9、D10、D14、D1-D2-D12 全过，**A4 最慢锚点段 25.1 s**（门槛 30 s；第 5 轮 22.3 s，这一跑时用户的屏保程序在占 CPU）；A5 让路后 700 ms 恢复；A12 长任务 0；只剩 W7 真跨机待复核（退出码 3） |
| 桌面自动成为渲染节点 | 同上 | `desktop-auto-node-probe --base-port 5620` | 退出 0、`ok: true`（604 s） |
| C10 界面、旧层 | 同上 | `c10-ui-probe`；`online-stale-layer-probe` | 都退出 0、`fails: []` |
| 查询渲染、创造力、用户正在编辑 | 同上 | `query-render-probe`；`creativity-probe --shots`；`user-editing-probe --shots` | `fails: []`；15 项全过；18 项全过 |
| 多 Agent | 同上 | `multi-agent-probe --phase all --shots`（第二阶段两个成员共用本地托管组合） | 35 项全过；看过 `tabs.png` 与 `b-remote-agents.png`（审查记在归档报告里） |
| 自定义测量 | 同上 | `custom-measure-probe --port 5860` | 21 项全过（1 kHz、振幅 0.5 的正弦波 RMS −9.0309 dBFS，与理论值相同） |
| 合入与 release | main `dc51de8c`、`4152cd4a`、`2ef4f083` | `npm run build`（合入后、改版本号后各一次） | 都成功；合并结果的代码与验证过的集成分支相同；release 两次快进，已推送 |
| 0.7.6 在线构建 | `2ef4f083` 干净检出 | `npx vite build --mode online` | 成功；`index-DKNBZ4FD.js`，嵌 `fc7191841c6e` |
| 托管服务重部署 | 同上 | `deploy-hosted --editor … --save` | 重载完成，重启次数 18；服务器本机文档服务 healthz 的模块列表含 `presence`、新 epoch；外网 `/hosted/healthz` 与 `/media/healthz` 200、匿名 WebSocket 升级 401 |
| `/editor` 三个地址与无头打开 | 同上 | `verify-editor.mjs fc7191841c6e` | 三处都 200、都发 `index-DKNBZ4FD.js`、都含代码版本；运行配置保留；无头 200、页面错误 0、控制台错误 0 |
| 阿里云真机路径 | 同上 | `desktop-auto-node-probe --remote https://8-219-80-16.sslip.io --base-port 5620 --skip-off` | 退出 0、`ok: true`、`fails: []`，592 s（那段时间 A5 子 Agent 在编 Rust，A7 用了 333 s）；A2 22.5 s、A3 96.4 s、A4 63.4 s、A5 4.4 s；页面错误 0；项目已删（`shared.admin.ok`） |

### 6.3 〔裁〕（本轮主会话定，待用户审）

1. A6 的 8 条、A3 的 18 条〔裁〕照子 Agent 定的留（全文在两份归档报告里）。
2. `mechanism/agent.md` 的「自定义测量」「多 Agent」两节与相关两条（三级）。
3. **A4 与 A5 一起合入**：A4 进 SKILL 后外壳仍会隐藏主窗，WebView2 隐藏后页面侧工具可能停摆，要 A5 的后台运行一起解决；A5 改 Rust 外壳，完整安装包只能在 PC 上打。所以 A4、A5 做完先留在分支上，等 PC 上线出包实测后一起合入，不让 release 带着半截的 SKILL。
4. A4 删掉「合并 Skill 结果…」菜单项与 `scripts/pc-tool.mjs`：它们只为三方合并与任务目录存在，语义里的 SKILL 是桌面 APP 经 MCP 直接改同一个项目，没有「合并」这一步。
5. 0.7.6 同时重部署托管服务（在场状态模块）与换 `/editor`；自 0.7.4 起托管端只多了这一个模块。

### 6.4 与计划、对齐时不一致的地方

- 计划第 3 节 A3 验收「并行写入不再互相被拒」按二级语义更正（第 5 轮 5.4 节已预告）。
- 计划 A6 行与第 5 节风险写的是「在预渲染 Chrome 里跑」，实现改为专用无头 Chrome（内存上限是整个浏览器的启动参数，混用会伤渲染或限不住内存炸弹），按实现更正。
- A4 原计划随本轮合入，改为与 A5 同发（6.3 节第 3 条）。

### 6.5 新发现、记入遗留

- **一个遗留的 `grep` 进程占了一个核和 7 GB 内存约一小时**：主会话为查子 Agent 类型对整份会话记录跑的 `grep`（正则里 `{0,20000}` 回溯过重），外层命令被停掉后它没跟着退出，从 11:45 一直跑到 12:46（本地时间），与 r5 合流的 G0-R 前半、C10 用户卡第一跑重叠。已结束。另有三个更早的 `--line-buffered` grep（父进程已不在、各几 MB、不耗 CPU），不能确定是本会话起的，按规矩没动。
- **在线用户卡探针的页面打不开**（6.2 节）：二分过——A6、A3 各自的分支单独跑、两者合在一起（0.7.4 与只改版本号的 0.7.5）都过；与失败时逐字节相同的 r5 构建之后连过 6 次；r4 合流时 M7 本机第一跑也出过一次同类（180 s），那时还没有 A3、A6。结论：与本轮代码无关的偶发。通过的几次 Chrome 网络日志里，同一主机的 6 个连接会用满、请求排队（`SOCKET_POOL_STALLED_MAX_SOCKETS_PER_GROUP` 约 30 次），疑为运气不好时 6 个连接都被长连接占住；失败那次没抓到日志。已记进 `docs/plan/TODO.md`，再出现时带网络日志复现。
- 用户的屏保程序（OLED Care Screensaver）运行时占约 57% CPU；带耗时门槛的项在用户离开时跑，会受它影响（本轮 M7 A4 锚点段 25.1 s，仍在门槛内）。不是本会话的进程，不动它。
- A4 顺带发现：AI 栏下方的「Agent 操作记录」把桌面会话只记成「Agent『第 N 个对话』」，不带厂商（文档服务事件里的对话序号），留给 A5 之后顺手补。

### 6.6 在做与留在分支上的

- **A4**（`claude/skill-mcp` `19dee607`）：MCP 直连（每个桌面会话一个身份：Claude Code 按一个 MCP 进程一个会话、Codex 按每次调用带的线程号；厂商按 `clientInfo`）；SKILL 提示词放在 MCP 的 `instructions` 并加本地工具 `get_skill_guide`，不写用户级 skill 文件；「登记到 Claude Code / Codex」（写用户级 MCP 配置，条目名固定 `promptcut`，写前整份备份，能撤销，测试只写临时目录——主会话只读核过用户真实的 `~/.claude.json` 与 `~/.codex/config.toml` 没被写过）；AI 栏按桌面会话分组显示厂商与当前操作；SKILL 闸按调用方类型；归档无头实例、任务目录、`submit_merge`、三方合并；去掉对话式布局。验证：tsc 0；`npm test` 4064 / 0 失败 / 1 跳过；指纹不变；`skill-mcp-probe` 两遍都 35 项全过。
- **A5**（`claude/tray`）：托盘、关窗不退出、悬浮窗与 SKILL 解耦、收起时页面照常干活；笔记本上能做 `cargo check` 与纯逻辑的 `cargo test`，完整安装包与实机验收要 PC。

### 6.7 待跨机复核

- W7 真跨机（沿用）。
- PC-076-1 出 0.7.6 补丁；用户装上后的真机复测。
- A4 + A5：PC 上出完整安装包（改了外壳，不是 `--patch-only`）与实机验收。

### 6.8 待用户项

1. **装 0.7.6 补丁**（PC 上线打出来后再通知，附路径与 SHA-256）；0.7.3～0.7.5 的补丁都不用装。
2. **装上后的第一次运行会清缓存**：帧库约 282 GB，启动约 2 分钟后按 50 GB 上限清掉约 230 GB 最久没用的预渲染缓存（需要时重新预渲染，不可撤销）；想留更多，装完先在开始页「存储」把上限调大。
3. A4、A5 合入后：在 PromptCut 里点「登记到 Claude Code / Codex」，各开一个新会话连过来，看 AI 栏有没有对应分组；试完可在同一处撤销登记（写的是用户级配置，本会话不替你写）。Codex 会不会把 `instructions` 交给模型、调工具是否每次要批准，也要真机上看。
4. 审 6.3 节与 A3、A6 两份归档报告里的〔裁〕；A4 报告第 8 节的两条语义 dry run 要你定：二级「传统式下桌面 APP 的调用被拒」、一级「在软件里一键登记到桌面 APP」；A3 报告建议的 `product/document-service.md` 补「在场状态」（二级）。
5. 沿用：`product/platforms.md` 要不要写「同步来的用户卡照常能改参数」（二级）；播放停顿期间要不要加音频看门狗。

### 6.9 顾问调用记录

本轮没有调 codex 或 Gemini：各段第一轮就做成；在线用户卡的偶发失败靠二分与网络日志排除了代码原因，没有卡在语义上。子 Agent：`opus-dev` 四个（custom-measure、multi-agent、skill-mcp、在跑的 tray）。

## 第 7 轮：加入失败的误报、测量走素材服务、预渲染进程三种模式，出 0.7.7（托管端重部署）；A5 做完留在分支（2026-09-30，笔记本主会话）

接第 6 轮。本轮代号：D10 = 预渲染进程的三种模式（Agent / User / Full）；认领闸 = 本机渲染节点认领队列任务的上限规则；legacy 整帧通道 = 查询渲染与分层预览之前那条整帧 PNG / MOV 的老路（`entry.cardCache`、`?preview=legacy` 等）。

### 7.1 做了什么

| 项 | 分支（子 Agent） | 做法 |
|---|---|---|
| 加入共享项目的误报 | `claude/join-error`（M8 时期的 `opus-dev`，一直「修复待审」） | 浏览器看不到 WebSocket 握手被 401 拒的状态码，连接没建成也被报成「用户名或密码不对」。新增 `POST shared/verify`〔裁〕（与握手同一个鉴权，nonce 照样用掉、失败计入限速），页面在打开前就断时拿新证明问一次：服务端认 → 报「连不上服务器」，不认 → 报「用户名或密码不对」，旧服务端回 404 → 照旧 |
| 测量走素材服务 | `claude/asset-path`（`opus-dev`） | `measure_audio`、`measure_audio_js` 把素材服务的 HTTP 地址交给 ffmpeg（按 Range 分段取），不再按素材目录找文件；先发 1 字节试探分清「没有这份素材」与「素材服务不可达」；结果与改前逐字相同。排查出别的几条直接读写素材目录的 Agent 路径（7.5 节） |
| 预渲染三种模式与认领闸 | `claude/query-render-2`（`opus-dev`） | `PROMPTCUT_PRERENDER_MODE`：User 模式不建 Agent lane、Agent 模式只接 Agent 查询，模式不接的请求当场回错；编辑器进程缺省拉起 Full（现有用户看不出区别）。认领闸：Agent 专用实例开着且空闲时，本机节点多认领一项快照任务给它。另给三个探针加 Chrome 参数透传（下次页面打不开时能带网络日志）、把 R7b 报告的 8 条更正折回归档文档、查清 legacy 整帧通道还有哪些活路径在用 |
| A5 后台运行 | `claude/tray`（`opus-dev`，在 A4 之上） | 托盘常在（左键唤回、右键「打开编辑界面 / 关闭」）；关窗与进 SKILL 都收起不退出（窗口挪到所有显示器之外、不进任务栏、不抢焦点，页面照常干活）；悬浮窗与 SKILL 解耦（编辑界面收起就出现，单击唤回、右键关闭）；第二次启动带 `--quit` 走同一条干净退出路径，补丁脚本先发 `--quit`。顺带修了两个老问题：SKILL 收起自从加了 Agent 子 webview 就一直没生效；悬浮窗缺 WebView2 启动参数。**做完、留在分支**（7.6 节） |
| 语义与计划 | 主会话 | `mechanism/rendering.md` 补两条（缺省模式与拒绝、认领闸，三级〔裁〕）；`cloud-task.md` I4 实现注与 I1 前提；`auth-contract.md` 端点表补 `shared/verify`；TODO 按合流更新（`cd37c8ed`、`7425ba0c`） |

合流：`claude/join-merge`（main 之上合 `origin/claude/join-error`，自动合并，核对过两处与 A3 共改的文件）→ `claude/r6-merge` 再合 asset-path、query-render-2（无冲突），主会话写语义后在笔记本上验证（7.2 节），合入 main `8237849f`；三份报告附审查后归档（`7425ba0c`）。

**0.7.7**：版本号 0.7.6 → 0.7.7（外壳仍 0.2.6，`faaf7ac4`），main = release = origin。从干净检出出在线构建 `index-i379dq6n.js`（`index.html` sha256 `b2fae8a71216…`，82 个 assets），嵌代码版本 `46c60466ba5d…`；共享快照键 `00a5264bf8a0…` 与捕获代码不变；`/api` 仍只有登记过的 4 个。自 0.7.6 起托管端改了三个文件（`shared/verify`），先备份 `/root/hosted-app-backup-20260930-077.tgz`、`/root/editor-backup-20260930-077.tgz`（换下的 `index-DKNBZ4FD.js` 那一代）、`/root/editor-runtime-config-20260930-077.json`，再 `deploy-hosted --editor … --save`：托管服务重载（重启次数 18 → 19），`/editor` 换代保留运行配置。桌面补丁指令改为 PC-077-1（PC 辅助整轮不在线，记为待办）。

### 7.2 验证

全部在笔记本上跑，集成分支一整套由主会话串行跑、跑的时候没有子 Agent 在做重活。用户的屏保程序整段都在，占约 80% CPU。

| 项 | 提交 | 命令 | 结果 |
|---|---|---|---|
| 类型检查、全量测试 | `claude/r6-merge` `cd37c8ed` | `npx tsc -b --force`；`npm test` | 0 错误；4120 / 4118 / 0 / 2 |
| 代码指纹 | 同上 | `snapshotCode()`、`captureCode()`、`frameCode()` | `00a5264bf8a0…`、`86e443cb6fa8…` 不变；代码版本 `46c60466ba5d…` |
| G0-R | 同上 | `g0r.sh`（5800） | 全过：确定性 1800 / 1800；与 main `701a27c0` 逐像素 1800 相同；快照重放 PASS；流式生产两种（**编码 p50 287 ms**，门槛 300 ms，见 7.5 节）、预览退回两种、就绪索引 `fails: []` |
| 探针八项 | 同上 | C10 A4、C10 用户卡、在线用户卡、舞台看守、M7 本机、桌面自动节点、C10 界面、在线旧层 | 全部第一跑就过（在线用户卡 35 s；C10 用户卡 259 s）。**M7 A4 最慢锚点段 22.4 s**（门槛 30 s），A5 让路后 703 ms 恢复，A12 长任务 0，只剩 W7 待跨机 |
| 新功能探针 | 同上 | `query-render-probe`；`creativity-probe`；`user-editing-probe`；`multi-agent-probe --phase all`；`custom-measure-probe`；`asset-path-probe --port 5920` | `fails: []`；15；18；35；21；17 项全过 |
| 合入与 release | main `8237849f`、`7425ba0c`、`faaf7ac4` | `npm run build`（合入后、改版本号后各一次） | 都成功；合并结果的代码与验证过的集成分支相同；release 两次快进，已推送 |
| 托管服务重部署 | `faaf7ac4` | `deploy-hosted --editor … --save` | 重载完成，重启次数 19；文档服务 healthz 的模块含 `presence`、`shared`；新端点在线（不带证明回 400 `bad-request`）；外网 `/hosted/healthz`、`/media/healthz` 200，匿名 WebSocket 升级 401 |
| `/editor` | 同上 | `verify-editor.mjs 46c60466ba5d` | 三处都 200、都发 `index-i379dq6n.js`、都含代码版本；运行配置保留；无头打开页面错误 0、控制台错误 0 |
| 阿里云真机路径 | 同上 | `desktop-auto-node-probe --remote https://8-219-80-16.sslip.io --base-port 5620 --skip-off` | 退出 0、`ok: true`、`fails: []`，588 s；A2 21.6 s、A3 96.7 s、A4 62.5 s、A5 4.5 s；项目已删 |
| A5（分支上） | `claude/tray` `a8e206cd` | `cargo check`；`cargo test --lib`；`node --test desktop/test/*.test.mjs`；根目录 tsc 与 `npm test`；临时目录里真跑开发构建 | 无警告；24 过；23 过；0 错误、4064 过 0 失败；关窗后窗口在屏幕外、页面 `visible`、动画帧与计时器速率不变，唤回正常，隐藏状态下退出与 `--quit` 退出码都是 0、窗口位置保存正常。托盘图标与菜单没能目测（这台机器截不了屏） |

### 7.3 〔裁〕（本轮主会话定，待用户审）

1. join-error 的一条（新增 `shared/verify`）、asset-path 的 4 条、query-render-2 的 6 条、A5 的各条照子 Agent 定的留（全文在归档报告与 `claude/tray` 的报告里）。
2. `mechanism/rendering.md` 两条（三级）。
3. 0.7.7 同时重部署托管服务（`shared/verify`）与换 `/editor`。
4. A5 的「文件 → 退出」菜单项保留、防节流参数保留；补丁脚本加 `--quit`（主会话要求补）。

### 7.4 与计划、对齐时不一致的地方

- 认领闸只有单测证据，队列模式的端到端探针没有（现成探针里没有这个组合），记进 TODO。
- `agent` 模式仍传 `PROMPTCUT_EDITOR_URL`（计划要求不传，但它依赖的 I2 推送、I3 素材服务地址还没做，不传就一张图都查不出来），计划 I1 已注明前提。

### 7.5 新发现、记入遗留

- **流式编码 p50 287 ms，离 300 ms 门槛只差 13 ms**（上一轮合流 261 ms，2026-09-28 修完时 207～224 ms）。这一跑时屏保占着约 80% CPU，代码没动编码这一段。先记下，下一轮在屏保不跑时再量；若屏保不在时也逼近门槛，按回退梯次查。
- `claude/asset-path` 排查出的直接读写素材目录的 Agent 路径：三个感知工具（共享项目里没有本机路径的素材用不了）、`voice_generate` 与 `collect_download`（写入绕过入库）、`bake_card`（卡片快照直接写、列、删素材目录）、提示词里的「磁盘路径」。前两类与提示词交 `claude/asset-path-2`（下一轮合），`bake_card` 另开任务。
- 托管部署下（编辑器进程请求自己的素材服务也要票据）上面这些读写都会回写明原因的 401 / 502；`voice_generate` 失败时服务商那边已经合成计费。已记进 TODO。
- legacy 整帧通道不是死代码：Agent 看帧、`get_layout`、草稿与 .proc 的快照、转场卡的快照都还依赖它，舞台端口被占时页面也会退回它。五个方案（A 不动；B 只删没人用的 `preview.mp4`、`full.mov`；C 停判轻卡的 PNG；D 删整帧预览老路；E 整条删）列给用户。
- 时间轴档测响度的逐秒曲线偶发缺点（改前就有，汇总值不受影响）。

### 7.6 在做与留在分支上的

- **A4 + A5**（`claude/skill-mcp` `19dee607`、`claude/tray` `a8e206cd`）：两段都做完、笔记本上能验的都过了。要 PC 上出完整安装包（改了外壳，外壳版本建议 0.2.6 → 0.2.7），用户装上按 `claude/tray` 报告第 7 节的 8 步清单实测（关窗不退出、收起时页面侧工具照常、托盘与悬浮窗唤回、右键关闭才退出、SKILL、多显示器、补丁经 `--quit` 干净退出），过了再一起合入。会话不替用户装安装包。
- **`claude/asset-path-2`**（三个感知工具与两个写入工具走素材服务、试听落缓存、提示词）：子 Agent 的验证全过（`npm test` 4131 / 4129 / 0 / 2，探针 29 项），主会话的集成验证 `claude/r7-merge` 正在跑，下一轮合。

### 7.7 待跨机复核

- W7 真跨机（沿用）。
- PC-077-1 出 0.7.7 补丁；A4 + A5 的完整安装包。

### 7.8 待用户项

1. **装 0.7.7 补丁**（PC 上线打出来后再通知，附路径与 SHA-256）；0.7.3～0.7.6 的补丁都不用装。
2. **装上后的第一次运行会清缓存**：帧库约 282 GB，启动约 2 分钟后按 50 GB 上限清掉约 230 GB 最久没用的预渲染缓存（需要时重新预渲染，不可撤销）；想留更多，装完先在开始页「存储」把上限调大。
3. A4 + A5 的完整安装包出来后按清单实测；A4 的「登记到 Claude Code / Codex」要你自己点（写的是用户级配置）。
4. 要你定的：
   - legacy 整帧通道选哪个方案（建议 B 另开小任务；C、D 牵涉你看得见的行为）；
   - 「文件 → 退出」菜单项留不留（语义说只有托盘或悬浮窗右键关闭才退出）；
   - A4 报告第 8 节的两条语义（二级「传统式下桌面 APP 的调用被拒」、一级「在软件里一键登记到桌面 APP」）；A3 建议的 `product/document-service.md` 补「在场状态」（二级）；
   - 音频整体改成浏览器端 JS 的计划（`docs/plan/audio_structure_plan.md`）第 6 节六条：解封装自己写还是引库、导出装 mp4 用不用 ffmpeg `-c copy`、浏览器解不了的格式（WMA、AC-3、DTS）怎么办、要不要看门狗、要不要写进语义、和 R8 的先后。这几条不定，这份计划不动工；
   - 审 7.3 节与各份归档报告里的〔裁〕。
5. 沿用：`product/platforms.md` 要不要写「同步来的用户卡照常能改参数」（二级）。

### 7.9 顾问调用记录

本轮没有调 codex 或 Gemini：各段第一轮就做成，没有卡住的语义问题。子 Agent：`opus-dev` 四个（asset-path、query-render-2、tray 的续做、asset-path-2）；join-error 是 M8 时期的分支，本轮只审与合。

## 第 8 轮：Agent 读写素材全部走素材服务、认领闸按批让路，出 0.7.8（托管端重部署）；线上 nginx 开压缩（2026-09-30，笔记本主会话）

接第 7 轮。本轮代号：`px` = 素材服务里存像素产物（卡片快照等）的命名空间；按批让路 = Agent 专用实例做队列任务时每 4 帧检查一次、有 Agent 任务就先做它。

### 8.1 做了什么

| 项 | 分支（子 Agent） | 做法 |
|---|---|---|
| 感知工具与写入工具走素材服务 | `claude/asset-path-2`（`opus-dev`） | `detect_shots`、`track_points`、`detect_subjects` 只发素材标识、服务端经素材服务取字节（Python 老包认不了地址时流到临时文件），请求体里的 `path` 不再读盘（堵掉一个任意读文件的口子）；`voice_generate`、`collect_download` 先落临时目录再经用户导入同一条入库路；三种试听落缓存；提示词不再说「磁盘路径」。合流 `claude/r7-merge` → main `fb144d56` |
| `bake_card` 走素材服务 | `claude/bake-asset`（`opus-dev`） | 卡片快照写进 `px`（地址 `/api/asset/px/<内容哈希>`），输入哈希到内容哈希的索引由产出方本机记着、命中以素材服务的对账为准；老项目里的 `/@media/bake-….png` 照常能取、首次命中时迁移；共享项目写入后推一份到远程，别的成员的本机素材服务按需拉取（核 sha256、防成环）。主会话要求补本机 `px` 的容量淘汰（10 GiB、小盘 2%、按最近使用删到 90%、30 分钟保护）：以前这些快照在素材目录里有页面预算管着，改走素材服务后不能没人管上限 |
| 维护四项与按批让路 | `claude/maint-3`（`opus-dev`） | legacy 方案 B（不再编没人用的 `preview.mp4`、整场景 `full.mov`）；响度逐秒曲线加 `asetpts`（复现 100 次缺 13 次 → 三种配置各 100 次 0 次）；配音复刻源文件走素材服务；认领闸的端到端探针。探针暴露认领闸让 Agent 查询等了 38 s（专用实例接了一整项 60 帧的任务），主会话要求在同一分支修掉：按批让路后等待 1.2 s、整次请求 40.6 s → 6.1 s |
| 语义与计划 | 主会话 | `mechanism/asset-service.md` 补单张快照的缓存、按需拉取、「预渲染产物的容量」一节；`mechanism/rendering.md` 补按批让路一条（三级〔裁〕，`4d2de8f8`）；TODO 按合流更新，另记托管端与远程素材服务的产物容量、偶发的探针页面打不开（第四次）；`docs/plan/hosting-migration.md` 补 nginx 一步（`7f83bc37`） |

合流：`claude/r8-merge`（main 起）合 bake-asset、maint-3（`vite-plugin-frames.ts` 自动合并，核对过），合入 main `ec983fc0`，报告附审查归档（`56169372`；`AGENT-query-render-2.md` 注〔裁 6〕已被按批让路取代）。

**0.7.8**：版本号 0.7.7 → 0.7.8（外壳仍 0.2.6，`f683de74`），main = release = origin。从干净检出出在线构建 `index-BrSSa29i.js`（`index.html` sha256 `ad6093797761…`，82 个 assets），嵌代码版本 `8de56638db7d…`；共享快照键与捕获代码不变；`/api` 仍只有登记过的 4 个。自 0.7.7 起托管端改了三个文件（`asset-service.ts`、`vite-plugin-media.ts`、新的 `asset-store/px-evict.mjs`；托管组合注入自己的数据层，所以托管端既不按需拉取、也不开淘汰），先备份 `/root/*-20260930-078*` 三份，再 `deploy-hosted --editor … --save`（重启次数 19 → 20）。桌面补丁指令改为 PC-078-1（PC 辅助整轮不在线）。

**线上 nginx 开压缩**（8.5 节第一条）：备份 `/root/nginx.conf.bak-20260930-gzip` 后打开 `gzip_vary`、`gzip_proxied any`、`gzip_comp_level 6` 与 `gzip_types`（JS、CSS、JSON、XML、SVG、wasm），`nginx -t` 通过后重载。在线页面主脚本线上传输 4.26 MB → 1.33 MB，三个源的加载 26 / 46 / 15 s → 4.7 / 2.9 / 1.6 s。

### 8.2 验证

| 项 | 提交 | 命令 | 结果 |
|---|---|---|---|
| r7 整套 | `claude/r7-merge` `e4f6e8df` | tsc；`npm test`；在线构建；G0-R；探针八项；新功能探针六项（`asset-path-probe --port 5950`） | 0 错误；4131 / 4129 / 0 / 2；G0-R 全过（流式编码 p50 279 ms，屏保在跑）；`c10-ui-probe` 第一跑遇到偶发的页面打不开（120 s），带网络日志重跑 3 遍都过；M7 本机 A4 22.8 s、A5 662 ms、A12 长任务 0；其余全过，`asset-path-probe` 29 项 |
| r8 整套 | `claude/r8-merge` `4d2de8f8` | 同上，加 `bake-asset-probe --port 5970`、`claim-gate-probe --port 5990` | 0 错误；4167 / 4165 / 0 / 2；G0-R 全过（确定性 1800 / 1800、与基准逐像素 1800 相同、快照重放的新断言也过、流式编码 p50 270 ms）；`bake-asset-probe` 33 项、`claim-gate-probe` 退出 0；M7 本机第一跑页面落在单舞台（`reason: single-stage`、`nodeHello: 0`，A12 记到 3 个约 123 ms 的长任务），空闲重跑 16 项 pass、只剩 W7，A4 22.5 s、A5 667 ms、A12 0；其余全过 |
| 合入与 release | main `fb144d56`、`e1949a31`、`ec983fc0`、`56169372`、`f683de74` | `npm run build` | 都成功；合并结果的代码与验证过的集成分支相同；release 快进，已推送 |
| 托管服务重部署 | `f683de74` | `deploy-hosted --editor … --save` | 重启次数 20；文档服务与素材服务健康；外网两个 healthz 200、匿名 WebSocket 升级 401 |
| `/editor` | 同上 | `verify-editor.mjs 8de56638db7d` | 三处都 200、都发 `index-BrSSa29i.js`、都含代码版本；无头打开页面错误 0、控制台错误 0 |
| 阿里云真机路径（开压缩前） | 同上 | `desktop-auto-node-probe --remote … --base-port 5620 --skip-off` | **没过**：A3「在线页面贴出 U1 的层」等满 902 s、A4 多步超时；服务端日志里成员页面连上后再没登记成渲染节点与计划发布者（0.7.7 那次 8 s 内就登记了）；截图里 H 卡挂着「需要本地 PC 渲染辅助」、两张用户卡没画出来；项目已删 |
| 阿里云真机路径（开压缩后） | 同上 | `… --base-port 5640 …` | 退出 0、`ok: true`、`fails: []`，526 s；A2 24.9 s、A3 124.3 s、A4 71.5 s、A5 4.2 s；项目已删 |

### 8.3 〔裁〕（本轮主会话定，待用户审）

1. asset-path-2、bake-asset（1～7）、maint-3（1～6）的〔裁〕照子 Agent 定的留（全文在归档报告里）。
2. 三级语义四条（素材服务三条、渲染一条）。
3. **给线上 nginx 开压缩**：托管服务器的配置由主会话维护，这是性能配置、可随时还原（备份在服务器上），不涉及你本机网络，也不花钱。
4. r7 合入后不单独出版本，与 r8 一起出 0.7.8，少一轮线上部署。

### 8.4 与计划、对齐时不一致的地方

- bake-asset 原任务书没要求容量淘汰，主会话审查时加上（理由见 8.1）。
- maint-3 原任务书没有按批让路，认领闸探针暴露 38 s 的等待后加上。

### 8.5 新发现、记入遗留

- **慢网络下在线页面永久退回单舞台、当不了纯浏览器节点**：两个舞台在独立的源上，各要下载一遍主脚本；首次握手的计时从编辑台挂上起算、固定 20 s，到点没握上就永久单舞台（`src/editor/Preview.tsx`、`src/online/stageOrigins.ts`）。开压缩治标；治本交 `claude/stage-handshake` 在做：每一台的 20 s 从那一台 iframe 的 `load` 起算，另设自打开起的总上限。这也可能解释本机验证链里几次「页面打不开 / 单舞台」的偶发（本机探针的舞台也是独立的源）。
- 偶发的探针页面打不开又出了两次（r7 的 C10 界面、r8 的 M7 单舞台），重跑都过。验证链期间起了 TIME_WAIT 采样（每 5 s 一次），这段里最高 1197（动态端口 16384 个），端口耗尽的猜测没得到支持。
- **用户真机缺陷：图卡视频源 0.5 倍慢放导出节奏不均**（另一个会话按你的决定写进 TODO：根因是 seek 目标落在帧边界时被截断到微秒、取到前一帧；修法、节奏探针、像素基线的硬规则、真机验收都已写定）。已派 `claude/video-cadence`（`opus-dev-high`）在做；真机验收要你把项目打成 `.procp` 发给本会话。
- 用户的屏保程序运行时占约 80% CPU，本轮带耗时门槛的项大多在它运行时跑的，都在门槛内。

### 8.6 在做与留在分支上的

- `claude/stage-handshake`（首次握手按舞台自己的加载进度计时）、`claude/video-cadence`（慢放节奏）在做。
- A4 + A5（`claude/skill-mcp`、`claude/tray`）照旧留在分支，等 PC 出完整安装包、你实测。

### 8.7 待跨机复核

- W7 真跨机（沿用）；PC-078-1 出 0.7.8 补丁；A4 + A5 的完整安装包。

### 8.8 待用户项

1. **装 0.7.8 补丁**（PC 上线打出来后再通知，附路径与 SHA-256）；0.7.3～0.7.7 的补丁都不用装。**装上后的第一次运行会清缓存**：帧库约 282 GB，启动约 2 分钟后按 50 GB 上限清掉约 230 GB 最久没用的预渲染缓存（需要时重新预渲染，不可撤销）；想留更多，装完先在开始页「存储」把上限调大。
2. **慢放缺陷的真机验收**：把 `9tian666.proc` 那个项目在顶栏「打包保存…」打成 `.procp`（编排 + 素材），直接发给本会话；本会话导入到自己的测试数据目录验，不碰你的 `Videos\PromptCut`。
3. A4 + A5 的完整安装包出来后按清单实测；「登记到 Claude Code / Codex」要你自己点。
4. 第 7 轮 7.8 节列的几项决定（legacy 整帧通道 C / D / E、「文件 → 退出」、A4 的两条语义、`product/document-service.md` 补「在场状态」、音频计划第 6 节六条），以及本轮 8.3 节与各归档报告里的〔裁〕。
5. 托管端与远程素材服务的产物（`px`、`snap`）没有容量管理，要按托管端的成本另定（TODO）。

### 8.9 顾问调用记录

本轮没有调 codex 或 Gemini：各段第一轮就做成；线上真机路径的失败靠服务端日志、截图与下载测速查到根因，没有卡在语义上。子 Agent：`opus-dev` 四个（asset-path-2、bake-asset、maint-3、stage-handshake），`opus-dev-high` 一个（video-cadence）。

## 第 9 轮：两条用户真机缺陷与慢网络下的舞台握手，出 0.7.9（2026-10-01，笔记本主会话）

用户 2026-09-30 晚把项目打成 `9tian666_pack.procp` 发到本会话，并确认两条真机缺陷同批修、随 0.7.9 发（做法写在 `docs/plan/TODO.md`，由另一个会话按用户的决定记下）。本轮代号：节奏探针 = 验证「取帧是否取对源帧」的回归探针 `video-source-cadence-probe`；过渡期 = 在线页面首次握手没握上时先用同源单舞台出画面、握上后换回双舞台的那一段。

### 9.1 做了什么

| 项 | 分支（子 Agent） | 做法 |
|---|---|---|
| 图卡视频源慢放节奏不均 | `claude/video-cadence`（`opus-dev-high`） | 图卡视频源（`mediaSource.ts`）与时间轴视频片段的导出取帧（`frameMedia.ts`）seek 目标统一加 2 ms：目标正好落在素材帧边界时，浏览器截断到微秒会取到前一帧。节奏探针改前 7 个用例 6 个失败（0.5 倍慢放取到 0,0,1,1,**1**,2,3,3,4,4,**4**,5…，就是用户的六帧一循环；起点不在 0 的 1 倍速片段 60 帧错 27 帧；25 fps 素材错 4 帧），改后全过；单测 VC-01～05 改前 4 条失败。节奏探针纳入 G0-R「预渲染探针」一行 |
| 打包保存跳过没哈希的素材 | `claude/pack-hash`（`opus-dev`） | 统一的「补入库」步骤（先走 adopt，服务端不收再取字节入库，换新对象写回），在打包前、放云端交上传队列前、桌面版打开项目后三处调用；补不上的（文件真的不在了）打包结束时列出名字，放云端传不上的同样列出。另发现包里的 `project.proc` 带着打包那台机器的素材路径、导出按路径读，于是打开包时去掉包内有字节的素材的路径、只按哈希找〔裁〕 |
| 慢网络下的舞台首次握手 | `claude/stage-handshake`（`opus-dev`） | 每一台的 20 秒从自己的 iframe `load` 起算，自挂上起总上限 2 分钟；可见舞台 20 秒没握上先用同源单舞台出画面，两个跨源舞台隐藏预热、都握上后换回双舞台（只换一次，盖板衔接）；后台舞台等可见舞台加载完再挂。第一版等待期间预览空白，主会话按「不许开不出画面」要求改成过渡期 |
| 语义与计划 | 主会话 | `mechanism/cards.md` 新增「图卡的视频输入源取帧」、`mechanism/rendering.md` 原第 14 行拆成「首次握手」「握上之后又断」两条（三级〔裁〕，`80b966ad`）；TODO 标两条缺陷已修，另记「跨机器打开项目时的素材路径」等跟进项 |

合流：`claude/r9-merge`（main 起）依次合 pack-hash、stage-handshake、video-cadence（无冲突），主会话写语义后在笔记本上验证，合入 main `b543b88e`，三份报告附审查归档（`9a4122d1`）。

**0.7.9**：版本号 0.7.8 → 0.7.9（外壳仍 0.2.6，`3a99bcea`），main = release = origin。从干净检出出在线构建 `index-I84a29ts.js`（`index.html` sha256 `c5518830c994…`，82 个 assets），嵌代码版本 `351ab621c2fa…`；共享快照键与捕获代码不变；`/api` 仍只有登记过的 4 个。托管端文件自 0.7.8 起没变，只换 `/editor`（备份 `/root/editor-backup-20261001-079.tgz` 与运行配置；保留上一代 assets 7 个，本代 82 个、在位 89 个）。桌面补丁指令改为 PC-079-1（PC 辅助仍不在线）。

### 9.2 验证

| 项 | 提交 | 命令 | 结果 |
|---|---|---|---|
| 类型检查、全量测试 | `claude/r9-merge` `80b966ad` | `npx tsc -b --force`；`npm test` | 0 错误；4199 / 4197 / 0 / 2 |
| 代码指纹 | 同上 | `snapshotCode()`、`captureCode()`、`frameCode()` | `00a5264bf8a0…`、`86e443cb6fa8…` 不变；代码版本 `351ab621c2fa…` |
| G0-R | 同上 | `g0r.sh`（5800） | 全过：确定性 1800 / 1800；与 main `701a27c0` 逐像素 1800 相同（像素基线不用重定：演示项目里没有视频源）；快照重放 PASS；流式编码 p50 239 ms；预览退回两种、就绪索引 `fails: []` |
| 探针八项 | 同上 | C10 A4、C10 用户卡、在线用户卡、舞台看守、M7 本机、桌面自动节点、C10 界面、在线旧层 | 全部第一跑就过；**M7 本机 A4 24.3 s**（门槛 30 s）、A5 628 ms、A12 两项长任务 0，只剩 W7 待跨机 |
| 新功能探针 | 同上 | 查询渲染、创造力、用户正在编辑、多 Agent、自定义测量、素材路径、bake-asset、认领闸 | 都退出 0 |
| 本轮新探针 | 同上 | `video-source-cadence-probe --port 6030`；`procp-roundtrip-probe --port-a 6050 --port-b 6060`；`online-stage-handshake-probe --base-port 6010` | 都退出 0、`ok: true` |
| **慢放真机验收** | `claude/video-cadence` | 用户的 `9tian666_pack.procp`，笔记本、会话自己的临时数据目录，改前 / 改后各导出 2913 帧，按素材内容逐帧判 | 改前六个 0.5 倍段每段 40～61 处「该重复却变了」和同样多的「该变却重复了」，1 倍速第 1、10 段各 62、52 处「该变却重复了」；**改后 12 段两项全是 0**（素材静止分不出新旧的帧另计：10、3、1、125）；原本正确的 1 倍速段改前改后逐像素相同 |
| 打包保存（用户老包） | `claude/pack-hash` | 新代码打开老包、再打包 | 打开照常；再打包时列出 8 条配音的名字（字节本来就不在老包里，要用户在自己机器上用新版本重新打包才会带上） |
| 合入与 release | main `b543b88e`、`9a4122d1`、`3a99bcea` | `npm run build` | 都成功；合并结果的代码与验证过的集成分支相同；release 快进，已推送 |
| `/editor` | `3a99bcea` | `verify-editor.mjs 351ab621c2fa` | 三处都 200、都发 `index-I84a29ts.js`、都含代码版本；无头打开页面错误 0、控制台错误 0 |
| 阿里云真机路径 | `3a99bcea` | `desktop-auto-node-probe --remote https://8-219-80-16.sslip.io --base-port 5620 --skip-off` | 退出 0、`ok: true`、`fails: []`，521 s；A2 23.7 s、A3 130.3 s、A4 71.2 s、A5 3.8 s；项目已删 |

### 9.3 〔裁〕（本轮主会话定，待用户审）

1. 三个分支的〔裁〕照子 Agent 定的留（全文在归档报告里），其中 pack-hash 的〔裁 1〕（打开包时去掉包内有字节的素材的路径）是为了让换机器导出能过的绕法，根治在导出那一侧（TODO）。
2. 两条三级语义（取帧规则、首次握手）。
3. 首次握手的第一版（等待期间空白）不接受，改为过渡期出单舞台画面。
4. 0.7.9 只换 `/editor`（托管端文件没变）。

### 9.4 与计划、对齐时不一致的地方

- TODO 的节奏探针规格写的是 2 s 素材，实现用 3 s（偏移 0.35 的时间轴用例要用到源第 69 帧）；「帧率已知时对齐帧中心」没采用（导出页拿不到可靠的素材帧率，与语义那句也不一致）。
- TODO 说「1 倍速段仍与原素材逐帧对得上」，实测改前并不全对：起点正好落在帧边界的两个 1 倍速段每三帧重复一帧，这次一并修好。

### 9.5 新发现、记入遗留

- 跨机器打开项目时的素材路径：导出只要素材带 `path` 就按路径读（`vite-plugin-export.ts` 约 177 行），在另一台机器上直接打开带对方路径的 `.proc` 再导出会失败；只有路径、本机又取不到文件的素材打开时不标「(缺失)」；放云端后才补上哈希的素材会不会进上传队列没核实。已记 TODO。
- r9 整套验证全部第一跑就过，这一轮没出现偶发的探针页面打不开（TIME_WAIT 采样照开）。

### 9.6 待跨机复核

- W7 真跨机（沿用）；PC-079-1 出 0.7.9 补丁；A4 + A5 的完整安装包。

### 9.7 待用户项

1. **装 0.7.9 补丁**（PC 上线打出来后再通知，附路径与 SHA-256）；0.7.3～0.7.8 的补丁都不用装。**装上后的第一次运行会清缓存**：帧库约 282 GB，启动约 2 分钟后按 50 GB 上限清掉约 230 GB 最久没用的预渲染缓存（需要时重新预渲染，不可撤销）；想留更多，装完先在开始页「存储」把上限调大。
2. 这一版的变化：图卡视频源的慢放段（以及起点正好落在帧边界的 1 倍速段）画面会变，这是修正；老项目里以前生成的配音，从这一版起打包和放云端时会一并带上，本机已经找不到文件的素材会列出名字提醒。
3. 打包保存的真机验收：装上 0.7.9 后，在你的机器上打开 `9tian666` 再「打包保存…」，包里应有 9 份素材（1 条视频 + 8 条配音）；拿到另一台机器打开，配音能播、导出有声。
4. 前几轮列的待定事项照旧（legacy 整帧通道 C / D / E、「文件 → 退出」、A4 的两条语义、`product/document-service.md` 补「在场状态」、音频计划第 6 节六条、托管端产物容量），以及各归档报告里的〔裁〕。

### 9.8 顾问调用记录

本轮没有调 codex 或 Gemini：三条都是第一轮就做成，语义与验收规则事先已由用户定。子 Agent：`opus-dev-high` 一个（video-cadence），`opus-dev` 两个（pack-hash、stage-handshake）。

## 第 10 轮：跨机器打开项目的素材路径、探针偶发导航超时查明，出 0.7.10；线上改为预压缩发静态资源（2026-10-01，笔记本主会话）

接第 9 轮。本轮代号：实验配置 = puppeteer 下载的测试版 Chrome（Chrome for Testing）缺省打开的一批 Chromium 在试功能；`gzip_static` = nginx 直接发预先压缩好的 `.gz` 文件（带 `Content-Length`），区别于边发边压的动态压缩（分块传输）。

### 10.1 做了什么

| 项 | 分支（子 Agent） | 做法 |
|---|---|---|
| 跨机器打开项目的素材路径 | `claude/media-path`（`opus-dev`） | 导出有合法哈希就按哈希取素材（`normalizeExportMedia`），没有才按路径读；只有路径又取不到、或带哈希但本机内容库没有字节的素材打开后标「(缺失)」（只认明确的否定回答，文件回来自动去掉标记；共享项目、在线构建、只读页面不标）；放云端后后台补上哈希的素材按哈希交给上传队列。新探针在另一台实例上直接打开带对方路径的 `.proc`，导出画面与音轨正常；换回旧导出插件就 `Video decode failed` |
| 三项维护 | `claude/maint-4`（`opus-dev`，在 media-path 之上） | 部署时在本机暂存目录里给在线构建的 `assets/` 生成 `.gz`，换代补回上一代原文件时同名 `.gz` 一起补；放云端之后新导入的图片、音频也交给上传队列（改前只有视频）；标了缺失、没有哈希的老素材导出时去掉引用它的片段、其余照常，完成对话框列出被跳过的素材 |
| 探针偶发导航超时 | `claude/nav-hang`（`opus-dev-high`） | 复现并查明：测试版 Chrome 的实验配置下（这次网络日志列出 91 个在试功能组），入口脚本（4.26 MB）用分块传输发时约 1～3% 的页面卡死——网络层 55 ms 收完全部字节，渲染进程却不收下，页面停在 `interactive`。对照：关掉实验配置 1250 次 0、headless-shell 200 次 0、正式版 Chrome 300 次 0、站点服务带 `Content-Length` 500 次 0、gzip + 分块 300 次 0。历史 7 次现场都对得上。修法：17 个打开在线页的探针的 Chrome 统一加 `--disable-field-trial-config`（不是重试）；另加压测与网络日志取证工具 |
| A4 + A5 对齐 main | 主会话 | `claude/tray`（含 A4）与 main（到 0.7.9）合成 `claude/a45-merge`，无冲突；验证见 10.2 |
| 线上加固 | 主会话 | 备份两份 nginx 站点配置（`/root/nginx-site-promptcut*.bak-20261001-gzstatic`）后，在 `location ^~ /editor/assets/` 里加 `gzip_static on;`，给当时的资源手工生成 `.gz`；从 0.7.10 起部署自动生成 |
| 语义、规则、计划 | 主会话 / 用户 | `mechanism/asset-service.md` 补「判缺失只认明确的否定回答」「放云端后入队」（三级〔裁〕，`f1050002`）；TODO 标跨机器素材路径、探针偶发导航超时已做。用户定的新规则 `f921b8ad`（`verification.md`「子分支与集成分支各跑什么」）从下一轮派活起执行。另一个会话在 TODO 加了「性能方向」一条（canvas 卡预渲染产物经 WebCodecs 直出，未排期） |

合流：`claude/r10-merge`（main 起）合 maint-4（含 media-path）、nav-hang（无冲突），写语义后整套验证，合入 main `f454490d`，三份报告附审查归档（`06f7b034`），并入 origin 上另一个会话的 TODO 提交（`8daf19a7`）。

**0.7.10**：版本号 0.7.9 → 0.7.10（外壳仍 0.2.6，`3784b6ca`），main = release = origin。从干净检出出在线构建 `index-CQbzCEbG.js`（`index.html` sha256 `e14dc46d6da9…`，82 个 assets），嵌代码版本 `191f21594347…`；共享快照键与捕获代码不变；`/api` 仍只有登记过的 4 个。托管端自 0.7.8 起只改了部署用的 `server/hosted/deploy.mjs`（服务运行时不用），不重启托管服务、只换 `/editor`：暂存目录里用仓库的 `precompressAssets()` 生成 `.gz`，本代 96 个（含 `.gz`），保留上一代 13 个，备份 `/root/editor-backup-20261001-0710.tgz`。桌面补丁指令改为 PC-0710-1（PC 辅助仍不在线）。

### 10.2 验证

| 项 | 提交 | 命令 | 结果 |
|---|---|---|---|
| r10 整套（按新规则，集成分支这一遍是硬要求） | `claude/r10-merge` `f1050002` | tsc；`npm test`；在线构建；G0-R；探针八项；新功能探针十一项；本轮新探针三项 | **全部第一跑就过**：0 错误；4218 / 4216 / 0 / 2；G0-R（确定性 1800 / 1800、逐像素 1800 相同、快照重放 PASS、**流式编码 p50 253 ms**——media-path 分支上三遍超时是负载所致，空闲机器上复核过）；M7 本机 A4 22.3 s、A5 576 ms、A12 0；`cross-machine-proc-probe`、`shared-import-upload-probe` 退出 0；**导航压测 200 次 0 卡死**（新开页面导航 p50 281 ms） |
| A4 + A5 集成分支 | `claude/a45-merge` `e53a0e94` | tsc；`npm test`；`node --test desktop/test/*.test.mjs`；在线构建；`skill-mcp-probe`；`multi-agent-probe`；首次握手；舞台看守；C10 界面 | 0 错误；4175 / 4174 / 0 / 1；外壳测试 23 过；其余都退出 0（舞台看守第一跑是那种导航超时，重跑过——当时这条分支还没有 nav-hang 的修复） |
| 合入与 release | main `f454490d`、`06f7b034`、`8daf19a7`、`3784b6ca` | `npm run build` | 都成功；合并结果的代码与验证过的集成分支相同；release 快进，已推送 |
| `/editor` | `3784b6ca` | `verify-editor.mjs 191f21594347`；curl | 三处都 200、都发 `index-CQbzCEbG.js`、都含代码版本，无头打开无错误；主站与舞台源的主脚本都是 `Content-Encoding: gzip` + `Content-Length: 1340983`，不再分块 |
| 阿里云真机路径 | `3784b6ca` | `desktop-auto-node-probe --remote https://8-219-80-16.sslip.io --base-port 5620 --skip-off` | 退出 0、`ok: true`、`fails: []`，466 s；A2 21.8 s、A3 84.8 s（前几版 96～130 s，页面脚本预压缩后加载更快）、A4 63.3 s、A5 4.6 s；项目已删 |

### 10.3 〔裁〕（本轮主会话定，待用户审）

1. media-path、maint-4 各 5 条、nav-hang 的〔裁〕照子 Agent 定的留（全文在归档报告里）。
2. 三级语义两句（判缺失、放云端后入队）。「打开项目时素材找不到标『(缺失)』、导出跳过并列出」是用户看得见的行为，按二级办，没写，列给用户。
3. **页面里「入口脚本卡住就自动刷新一次」的看门狗不做**：正式版 Chrome 与 gzip + 分块各 300 次 0 卡死，线上又已改为带 `Content-Length` 的预压缩；这是用户看得见的行为，用户可推翻。
4. 给线上 nginx 加 `gzip_static`：托管服务器配置由主会话维护，可随时还原（备份在服务器上），不涉及用户本机网络，不花钱。
5. 其余约 40 个开发服务器页面的探针（没有单个大脚本）暂不加 `--disable-field-trial-config`。

### 10.4 与计划、对齐时不一致的地方

- maint-4 发现 media-path 报告里「地址清空、导出跳过」对导出不成立，导出跳过改由 maint-4 负责（归档报告已注明）。
- 按用户新规则，本轮子分支（media-path、maint-4、nav-hang）有的跑了整套 G0-R，从下一轮派活起按「子分支只跑相关项、集成分支跑整套」写任务书。

### 10.5 新发现、记入遗留

- 打开云端项目后、上传目标设好之前导入的素材仍不会入队（时序缺口，TODO）。
- 性能方向：canvas 卡的预渲染产物经 WebCodecs 直出（另一个会话按用户意见记进 TODO，未排期、档位未定）。

### 10.6 在做与留在分支上的

- A4 + A5：`claude/a45-merge` 已对齐 main 到 0.7.9、验证健康；PC 上线后按 `scratchpad` 里的 PC-A45-1 模板在分支上改版本号（应用末位 +1、外壳 0.2.7）出完整安装包，用户装上实测后合入。

### 10.7 待跨机复核

- W7 真跨机（沿用）；PC-0710-1 出 0.7.10 补丁；A4 + A5 的完整安装包。

### 10.8 待用户项

1. **装 0.7.10 补丁**（PC 上线打出来后再通知，附路径与 SHA-256）；0.7.3～0.7.9 的补丁都不用装。**装上后的第一次运行会清缓存**：帧库约 282 GB，启动约 2 分钟后按 50 GB 上限清掉约 230 GB 最久没用的预渲染缓存（需要时重新预渲染，不可撤销）；想留更多，装完先在开始页「存储」把上限调大。
2. 这一版的变化：在另一台机器上打开 `.proc`，有哈希的素材照常导出；本机找不到的素材会标「(缺失)」，导出时跳过它们并列出名字；共享项目里新导入的图片、音频，别的成员也能拿到了。
3. 第 9 轮的打包保存真机验收（装上后重新「打包保存…」，包里应有 9 份素材）。
4. 要你定的：「打开项目时素材找不到标『(缺失)』、导出跳过并列出」要不要写进二级语义；页面「入口卡住自动刷新」的看门狗要不要做；以及前几轮列的待定事项。

### 10.9 顾问调用记录

本轮没有调 codex 或 Gemini：导航超时靠压测与网络日志查到根因，其余各段第一轮就做成。子 Agent：`opus-dev` 两个（media-path、maint-4），`opus-dev-high` 一个（nav-hang）。

## 第 11 轮：放云端的时序缺口补上、探针统一关掉实验配置，出 0.7.11；子 Agent 换 Sonnet 按难度选档，codex 换 gpt-6.1-sol（2026-10-01，笔记本主会话）

接第 10 轮。本轮代号：上传目标 = 共享项目里编辑器进程往远程素材服务上传时用的地址与票据；解法表 = 用户 2026-10-01 新定的 `guide_files/solution_table.md`（按现有语义做不下去时逐层穷尽解法的做法）；rollout 日志 = codex 每次运行写在 `~/.codex/sessions/<日期>/` 下的会话记录，记着实际用的模型。

### 11.1 做了什么

| 项 | 分支（子 Agent） | 做法 |
|---|---|---|
| 放云端的时序缺口 | `claude/upload-timing`（`opus-dev`，06:22 派出，早于换 Sonnet） | 打开共享项目后、上传目标交到编辑器进程之前导入的素材，由页面按素材原尺寸哈希记下，上传目标就绪后经开启放云端时同一个入队口子补交；已就绪时当场交一次（队列按素材去重合并）；补交没成留到下次续签；离开项目丢弃；本机就是主机时不记。改前 UT 单测 5 个全挂、`shared-import-upload-probe` 新步骤 4 项挂，改后全过。服务端没动 |
| 探针统一关掉实验配置 | 同上 | `scripts/probes/` 下其余 44 个起 Chrome 的探针，启动参数都以 `PROBE_CHROME_ARGS` 打头；只动启动参数，不动判定 |
| 子 Agent 与顾问配置（用户交办） | 主会话 | 用户同日三改（`2bf76f54` → `a0911c81` → `f5742154`，以最后一次为准）：Claude 子 Agent 只留两个——照 `opus-dev.md` 另存 `sonnet-dev-high`（`claude-sonnet-5-5`、effort high，description 的用途照主计划 0.2 节「Claude 子 Agent 怎么选」表的日常一行，正文与 `opus-dev.md` 逐字相同），`opus-dev`（Opus 5.5、medium）不动；按中间那次建过的 `sonnet-dev`、`sonnet-dev-xhigh`、`sonnet-dev-max` 已移到回收站；`opus-dev-high` 留着。用户 `16b14c34`：npm 全局装 codex 0.159.2，`subagent-gpt` 技能（`codex-run.ps1`、`agents/manager.md`、`SKILL.md`）与 `gpt-manager.md` 里的 `gpt-6-sol` 全部换成 `gpt-6.1-sol`（小写 10 处，另有 SKILL.md 描述里大写的 2 处），改前各文件备份在会话 scratchpad |
| 规则 | 用户 | `577c58fd` 解法表（一级卡死改为记未达成、做下一项）；`f921b8ad`「子分支与集成分支各跑什么」本轮起照办：upload-timing 子分支只跑了类型检查、全量测试与点名的探针，整套在集成分支跑一次；`ba6f57df`、`8dad2250` codex 攻坚的推理档按难度一次选定 high / xhigh / max（不低于 high，难的直接 max，不逐档重交，报「思路穷尽」就算穷尽；查资料仍 high），从下一轮派活起照办 |

合流：`claude/r11-merge`（main `df81ae5d` 起，`bfb34123`）合 upload-timing（无冲突），整套验证后合入 main `a76640d0`（合并结果的代码与验证过的集成分支逐字相同，只多了用户当天改的规则文档），报告附审查归档、TODO 更新（`52f0b252`）。

**0.7.11**：版本号 0.7.10 → 0.7.11（外壳仍 0.2.6，`d20b6aad`），main = release = origin。从干净检出出在线构建 `index-DdRMKpuF.js`（`index.html` sha256 `1f1c106d862c…`，82 个 assets），嵌代码版本 `aaea7dfb7416…`；共享快照键与捕获代码不变；`/api` 仍只有登记过的 4 个。托管端自 0.7.8 起只改了部署用的 `server/hosted/deploy.mjs`（服务运行时不用），不重启托管服务、只换 `/editor`：暂存目录里生成 `.gz` 14 个，本代 96 个（含 `.gz`），保留上一代 13 个，备份 `/root/editor-backup-20261001-0711.tgz`。桌面补丁指令改为 PC-0711-1（PC 辅助仍不在线）。

### 11.2 验证

| 项 | 提交 | 命令 | 结果 |
|---|---|---|---|
| r11 整套（集成分支，按新规则只跑这一遍） | `claude/r11-merge` `bfb34123` | tsc；`npm test`；在线构建；G0-R；探针八项；新功能探针十三项；导航压测 200 次 | 0 错误；4223 / 4221 / 0 / 2；G0-R 全过（确定性 1800 / 1800、逐像素 1800 相同、**流式编码 p50 239 ms**）；M7 本机 `fails: []`、A4 22.2 s；导航压测 200 次 0 失败（p50 253 ms）；`shared-import-upload-probe`（含本轮新步骤）、`cross-machine-proc-probe` 退出 0。**唯一没过的是 `video-source-cadence-probe`**：用例①rate 0.5 offset 0.35 第 51 帧取到源帧 35、应为 36（目标 1.2 s 正落在帧边界），其余约 420 帧全对 |
| 定位（按新规则单跑挂的那一项） | 改前 `3784b6ca`（0.7.10）/ 改后 `bfb34123`（代码与 `claude/upload-timing` 相同） | `video-source-cadence-probe --port 6030`，两边交替各 5 遍 | 10 遍全过、`fails: []`。本轮没动渲染代码，改前改后同样全过 → 判为原有的偶发（那次紧接在最忙的认领闸探针之后），不挡本轮合入；记进 TODO，派 `claude/cadence-race`（`opus-dev`）修 |
| 合入与 release | main `a76640d0`、`52f0b252`、`d20b6aad` | `npm run build` | 两次都成功；合并结果的代码与验证过的集成分支逐字相同；release 快进，已推送 |
| `/editor` | `d20b6aad` | `verify-editor.mjs aaea7dfb7416`；curl | 三处都 200、都发 `index-DdRMKpuF.js`、都含代码版本，无头打开无错误；主站与舞台源的主脚本都是 `Content-Encoding: gzip` + `Content-Length: 1341425` |
| 阿里云真机路径 | `d20b6aad` | `desktop-auto-node-probe --remote https://8-219-80-16.sslip.io --base-port 5620 --skip-off` | 前两次都撞上 `claude/cadence-race` 的压测（16 个 node 满载进程，CPU 100%），没判成：第一次本机预渲染进程 240 s 没起来；第二次 1350 s 超时，慢在字节上云（创建 161 s、A4 等 U2 字节上云 395 s，上一轮 A4 全程 63 s）。托管端与上一版相同、`/editor` 核验已过；第四次在机器空下来后跑（10:26～10:35）：**退出 0、`ok: true`、`fails: []`，529 s**；A2 21.9 s、A3 108.3 s、A4 64.8 s、A5 4.0 s、A7 251 s；测试项目已删、端口全放（前三次的测试项目也都由探针自己删了，第一次没走到建项目） |
| codex 配置 | — | `codex --version`；`codex-run.ps1 -Prompt "1+1 等于几？只回数字"`（不带 `-Model` / `-Effort`，即缺省参数） | PATH 上的 codex 是 `codex-cli 0.159.2`；运行 COMPLETED、回答「2」；rollout 日志 `rollout-2026-10-01T07-00-27-01a0f455-….jsonl` 里 `turn_context.model = gpt-6.1-sol`、`effort = high`、`cli_version = 0.159.2` |

### 11.3 〔裁〕（本轮主会话定，待用户审）

1. upload-timing 的三级语义一句（`mechanism/asset-service.md`「本地内容库」：上传目标就绪之前导入的素材由页面记下、就绪后按哈希补交）。
2. 上传目标已就绪时导入也当场交一次，与服务端入队重复、由队列合并——维持，不为省一个小请求扩大改动面。
3. 第 10 轮〔裁〕第 5 条（其余探针暂不加 `--disable-field-trial-config`）改为全加。

### 11.4 与计划、对齐时不一致的地方

- 本会话认不得新建的 `sonnet-dev-high`（要新开会话）。本会话里派日常活用 `opus-dev-high` 加 `model: sonnet`（它的 effort 是 high、正文与 `opus-dev` 逐字相同，等同 `sonnet-dev-high`），核心难点用 `opus-dev`；新开会话后直接用 `sonnet-dev-high`。
- 0.4 节写的另存法只改 `name`、`model`、`effort` 三项，照做的话 description 会仍写「Opus 5.5、effort medium、用于核心架构重构……」，与新选法矛盾；这次 description 也跟着改成 Sonnet 5.5、high、日常用途，用户可改回。
- `subagent-gpt` 的 `SKILL.md`「已验证的机制备忘」仍写「PromptCut 自带（PATH 第一）和 npm 全局（2026-09-24 都升到 0.156.1）」，与现状不符：npm 全局前缀已是 `%LOCALAPPDATA%\npm-global`（PATH 第一，0.159.2），`%APPDATA%\npm` 与 `%LOCALAPPDATA%\promptcut\cli\codex` 下都已没有 codex，Codex 桌面版是 0.157.1。`codex-run.ps1` 按版本挑中 npm 那份，经 `codex.cmd` 起（原生 `codex.exe` 的候选路径还指着 `%APPDATA%\npm`，现在不存在）。实跑正常；只按交代换了模型名，这两处没改，列给用户。

### 11.5 新发现、记入遗留

- **装了 npm 全局 codex 之后，main 的 `npm test` 在本机有 4 个失败**：`server/test/codex-desktop.test.mjs` 只 mock 了 `spawn`，codex 从哪儿解析取决于本机——装的是原生 `codex.exe` 时过，npm 版（`codex.cmd`，`cliCommand` 改写成 `node codex.js`）时参数前多一个脚本路径就挂。产品行为是对的，是测试不封闭。r11 的 `npm test`（06:45）在装 codex（06:58）之前，所以 0.7.11 的判定不受影响。修在 `claude/codex-test-env`（Sonnet，按选法表「日常」）：用假可执行文件让结果与本机无关，另把 `agy-stdin`、`claude-prompt-file` 两个同类测试一并改了；`npm test` 4226 / 4224 / 0 / 2，PATH 去掉 npm-global 也全过。随第 12 轮合入。
- 导出时图卡的视频源偶发取到上一帧（见 11.2 的定位一行）：疑为 `seeked` 发出时视频元素的当前帧还没换成新帧就取图的时序竞争，时间轴视频片段的 `frameMedia.ts` 同类写法；记进 TODO，修在 `claude/cadence-race`。

### 11.6 在做与留在分支上的

- 图卡视频源偶发取到上一帧：`claude/cadence-race`（`opus-dev`）修好了——根因是 Chrome 里 `seeked` 先于帧槽换帧（两条线程），改为 `seeked` 后用 `VideoFrame` 核对帧时间戳再取图；最小复现探针改前 312 000 次 seek 错 22 次、改后 396 000 次 0 错，G0-R 全过、像素基线不变。审查时发现它的报告提交 `9da8e62a` 把两个源文件误还原成改前版本（做耗时对照时检出的旧文件被一并提交），已让它恢复、在分支末端重跑验证并更正报告；完成后与 `claude/codex-test-env` 一起进第 12 轮集成分支跑整套。
- A4 + A5：`claude/a45-merge`（对齐到 0.7.9，健康）；PC 上线后按 PC-A45-1 模板刷新到最新 main、改版本号出完整安装包，用户装上实测后合入。

### 11.7 待跨机复核

- W7 真跨机（沿用）；PC-0711-1 出 0.7.11 补丁（取代没发出的 PC-0710-1）；A4 + A5 的完整安装包。

### 11.8 待用户项

1. **装 0.7.11 补丁**（PC 上线打出来后再通知，附路径与 SHA-256）；0.7.3～0.7.10 的补丁都不用装。**装上后的第一次运行会清缓存**：帧库约 282 GB，启动约 2 分钟后按 50 GB 上限清掉约 230 GB 最久没用的预渲染缓存（需要时重新预渲染，不可撤销）；想留更多，装完先在开始页「存储」把上限调大。
2. 这一版的变化：共享项目里刚打开就导入的素材（上传目标还没就绪那几秒里导入的），别的成员也拿得到了。
3. 第 9 轮的打包保存真机验收（装上后重新「打包保存…」，包里应有 9 份素材）。
4. 要你定的：`subagent-gpt` 机制备忘里过时的两处要不要我改（11.4）；以及前几轮列的待定事项（legacy 整帧通道 C / D、「文件→退出」、A4 的两条语义、在场状态、用户卡、音频计划第 6 节、「素材找不到标缺失」写不写进二级、入口卡住看门狗、托管端产物容量）。

### 11.9 顾问调用记录

本轮没有调 codex 或 Gemini 做工程顾问：upload-timing 第一轮就做成。codex 只按用户交代做了一次配置自检（「1+1 等于几」，缺省参数）。子 Agent：`opus-dev` 两个（upload-timing；cadence-race，按选法表「核心难点」一行选的）；Sonnet 一个（codex-test-env，按选法表「日常」，本会话里用 `opus-dev-high` 加 `model: sonnet`）。选哪个、为什么都写在派活指令里。

## 第 12 轮：图卡视频源导出偶发取到上一帧修好、测试不再依赖本机装的 CLI，出 0.7.12（2026-10-01，笔记本主会话）

接第 11 轮。本轮代号：帧槽 = 视频元素「当前帧」所在的那一格，`createImageBitmap(video)` 取的就是它；最小复现探针 = `scripts/probes/video-seek-race-probe.mjs`（不走导出管线，在受帧控制的 chrome-headless-shell 里反复 seek、取帧，读 `VideoFrame` 时间戳与像素两边互证）；A10 = M7 浏览器节点探针的第 10 组断言（宿主全开时谁先谁得卡、锁闲置后接手）。

### 12.1 做了什么

| 项 | 分支（子 Agent） | 做法 |
|---|---|---|
| 图卡视频源导出偶发取到上一帧 | `claude/cadence-race`（`opus-dev`：渲染管线里的并发与时序、根因不明，选法表「核心难点」） | 根因：Chrome 里 seek 完成后，新帧送进帧槽与通知主线程发 `seeked` 走两条线程，机器忙时 `seeked` 先到，当场取帧拿到 seek 之前那一帧。修法：`seeked` 之后用 `new VideoFrame(video)` 核对帧槽里那一帧的时间戳与时长覆盖 `currentTime` 才取图，没覆盖隔 1 ms 再看、单帧最多 500 ms，连续两帧对不上就暂停核对、对上即恢复；同一素材的取帧排队；取消后 seek 未完也等。时间轴视频片段（`frameMedia.ts`）的呈现窗口按帧时长收窄。核对只读时间戳、不等合成器回调，不会和 beginFrame 控制的导出器互相等住。最小复现探针改前 312 000 次 seek 错 22 次，改后（分支上与集成分支上合计）504 000 次 0 错 |
| 测试不再依赖本机装的 CLI | `claude/codex-test-env`（Sonnet：改测试的维护项，选法表「日常」；本会话用 `opus-dev-high` 加 `model: sonnet`） | `codex-desktop.test.mjs` 每个用例显式设 `PROMPTCUT_CODEX_EXE` 指向临时目录的假 exe；新 `fake-cli-home.mjs` 把 `PROMPTCUT_CLI_HOME` 指到临时目录，`agy-stdin`、`claude-prompt-file` 两个同类测试一并改；只改测试 |
| G0-R 加取帧竞态的回归基线 | 主会话 | 主计划第 8 节 G0-R「预渲染探针」一行加 `video-seek-race-probe --mode fixed --busy --settle 0 --loops 300` 三实例并行（据 cadence-race 的建议：节奏探针抓这类竞态太钝，改前每轮都能复现） |

审查中发现并纠正：cadence-race 的报告提交 `9da8e62a` 把两个源文件误还原成改前版本（做耗时对照时 `git checkout <提交> -- <文件>` 顺带暂存了旧文件，「只提交报告」时被一并带进去），分支末端一度没有修复、之后那组耗时对照两遍都是旧代码。主会话按 `git diff` 与关键函数出现次数查出，让子 Agent 恢复（`6d0e6aaf`）、在末端重跑全部验证并如实更正报告（`b9dab6ad`）。

合流：`claude/r12-merge`（main `3b0ad253` 起，`f707c276`）合 cadence-race、codex-test-env（无冲突），整套验证后合入 main `1e17d9fa`（合并结果与验证过的集成分支逐字相同），两份报告附审查归档、TODO 与主计划 G0-R 行更新（`c8b533eb`）。

**0.7.12**：版本号 0.7.11 → 0.7.12（外壳仍 0.2.6，`131c016e`），main = release = origin。从干净检出出在线构建 `index-CaqnVPgD.js`（`index.html` sha256 `c6bc9e59fbe3…`，82 个 assets），嵌代码版本 `0331c3277625…`；共享快照键与捕获代码不变；`/api` 仍只有登记过的 4 个。托管端自 0.7.8 起仍只改了部署用的 `server/hosted/deploy.mjs`，不重启托管服务、只换 `/editor`：暂存目录里生成 `.gz` 14 个，本代 96 个（含 `.gz`），保留上一代 13 个，备份 `/root/editor-backup-20261001-0712.tgz`。桌面补丁指令改为 PC-0712-1（PC 辅助仍不在线）。

### 12.2 验证

| 项 | 提交 | 命令 | 结果 |
|---|---|---|---|
| cadence-race 子分支（恢复后的末端） | `b9dab6ad` | tsc；模块单测；空闲节奏探针 5 遍；最小复现三实例并行；G0-R；确定性耗时改前改后 | 0 错误；9/9；5/5；108 000 次 seek 0 错；G0-R 全过（确定性 1800 / 1800、像素基线 1800 相同）；改前 547 s / 改后 550 s |
| codex-test-env 子分支 | `b245a4c3` | `codex-desktop` 单测（PATH 有无 npm-global 各一次）；tsc；`npm test` | 7/7、7/7；0 错误；4226 / 4224 / 0 / 2 |
| r12 整套（集成分支，按规则只跑这一遍） | `claude/r12-merge` `f707c276` | tsc；`npm test`；在线构建；G0-R；探针八项；新功能探针十三项；导航压测 200 次；最小复现三实例并行 | 0 错误；4230 / 4228 / 0 / 2；G0-R 全过（确定性 1800 / 1800、逐像素 1800 相同、**流式编码 p50 229 ms**）；节奏探针、导航压测（200 次 0 失败）与其余探针退出 0；最小复现 108 000 次 seek 0 错；**M7 本机 A10 抢卡一步没过**：w1 这张新卡 300 s 内没做完（`{"w1":[],"w2":[…]}`） |
| 定位 M7 那一项（按规则单跑） | `claude/cadence-race`、`claude/codex-test-env`、`claude/r12-merge` | `m7-browser-probe --role all --timing-authoritative --base-port 5710`，三个检出串行各一次 | cadence-race `fails: []`（抢卡这一步 306 s）；**codex-test-env（运行时代码同 main）同样挂**（301 s，w1 超时）；r12 重跑 `fails: []`（256 s）。连同 r10 214 s、r11 270 s、r12 整套 311 s，这一步一直贴着 300 s 的等待上限——是原有的偶发，与本轮改动无关，不挡合入；记进 TODO，派 `claude/m7-race`（`opus-dev`）查 |
| 合入与 release | main `1e17d9fa`、`c8b533eb`、`131c016e` | `npm run build` | 两次都成功；合并结果与验证过的集成分支逐字相同；release 快进，已推送 |
| `/editor` | `131c016e` | `verify-editor.mjs 0331c3277625`；curl | 三处都 200、都发 `index-CaqnVPgD.js`、都含代码版本，无头打开无错误；主站与舞台源的主脚本都是 `Content-Encoding: gzip` + `Content-Length: 1344790` |
| 阿里云真机路径 | `131c016e` | `desktop-auto-node-probe --remote https://8-219-80-16.sslip.io --base-port 5620 --skip-off`（先确认机器空闲） | 第一跑就过：退出 0、`ok: true`、`fails: []`，481 s；A2 21.8 s、A3 88.0 s、A4 64.7 s、A5 4.5 s、A7 224 s；测试项目已删、端口全放 |

### 12.3 〔裁〕（本轮主会话定，待用户审）

1. cadence-race 的三级语义一句（`mechanism/cards.md`「图卡的视频输入源取帧」：seek 完成后核对帧时间戳再取、排队、收窄呈现窗口，写明试过而没采用的「等合成器回调」「固定多等」两条路）。
2. G0-R「预渲染探针」一行加最小复现探针（计划层面，主计划第 8 节）。
3. M7 A10 抢卡一项在集成分支挂、定位为原有偶发（运行时代码同 main 的检出上也挂），照常合入 r12；问题另派 `claude/m7-race` 处理。

### 12.4 与计划、对齐时不一致的地方

- cadence-race 第一次交回时分支末端没有修复（见 12.1 末段），返工一次。
- 第 11 轮里真机路径探针两次撞上 cadence-race 的压测（16 个满载进程）没判成；之后主会话跑线上验证前先看压测进程、必要时请子 Agent 让出几分钟。

### 12.5 新发现、记入遗留

- **M7 本机探针 A10「抢卡」一步卡在等待上限上**（见 12.2 定位一行）：加两张新卡后，本机节点要先渲完约 20 段重卡、w1 排在后面，这一步 214～311 s，而每张卡的等待上限是 300 s；探针还把「等超时」与「一张卡出自两种环境」判成同一种失败。要查纯浏览器节点在线时为什么不先认领 w1（设计如此还是认领有缺口），探针区分超时与违反、等待上限留足余量。记进 TODO，修在 `claude/m7-race`（`opus-dev`）。

### 12.6 在做与留在分支上的

- M7 A10 抢卡一步的等待余量：`claude/m7-race`（`opus-dev`，起点 main `131c016e`），在做。
- A4 + A5：`claude/a45-merge`（对齐到 0.7.9，健康）；PC 上线后按 PC-A45-1 模板刷新到最新 main、改版本号出完整安装包，用户装上实测后合入。

### 12.7 待跨机复核

- W7 真跨机（沿用）；PC-0712-1 出 0.7.12 补丁（取代没发出的 PC-0711-1）；A4 + A5 的完整安装包。

### 12.8 待用户项

1. **装 0.7.12 补丁**（PC 上线打出来后再通知，附路径与 SHA-256）；0.7.3～0.7.11 的补丁都不用装。**装上后的第一次运行会清缓存**：帧库约 282 GB，启动约 2 分钟后按 50 GB 上限清掉约 230 GB 最久没用的预渲染缓存（需要时重新预渲染，不可撤销）；想留更多，装完先在开始页「存储」把上限调大。
2. 这一版的变化：导出含视频图卡的项目时，机器忙的情况下偶尔有一帧取成上一帧（慢放、变速段偶尔一顿），修好了；共享项目里刚打开就导入的素材别的成员也拿得到（0.7.11 起）。
3. 第 9 轮的打包保存真机验收（装上后重新「打包保存…」，包里应有 9 份素材）。
4. 要你定的：前几轮列的待定事项（legacy 整帧通道 C / D、「文件→退出」、A4 的两条语义、在场状态、用户卡、音频计划第 6 节、「素材找不到标缺失」写不写进二级、入口卡住看门狗、托管端产物容量），以及第 11 轮的 `subagent-gpt` 机制备忘过时两处要不要改。

### 12.9 顾问调用记录

本轮没有调 codex 或 Gemini：cadence-race 靠最小复现探针与日志直接坐实根因，codex-test-env 第一轮就做成。子 Agent：`opus-dev` 两个（cadence-race，返工一次；m7-race 在做），Sonnet 一个（codex-test-env）。选哪个、为什么都写在派活指令里。

## 第 13 轮：新卡不再等积压做完才切分、推产物不再偶发 400 incomplete，出 0.7.13（托管端重部署）（2026-10-01，笔记本主会话）

接第 12 轮。本轮代号：计划任务 = 渲染任务队列里待切分的「清单计划」，切分后才有逐段的细任务；切分只由桌面节点（pc）或独立渲染主机做，纯浏览器节点不切分；两路推送 = 节点渲完一段后自己推产物，同时本机后台推送队列也推同一段。

### 13.1 做了什么

| 项 | 分支（子 Agent） | 做法 |
|---|---|---|
| M7 A10 抢卡一步卡在等待上限上 | `claude/m7-race`（`opus-dev`：队列认领与时序、根因不明，选法表「核心难点」） | 查明是调度缺口：pc 挑活把计划（`priority: 'normal'`，记名次 0）排在所有整数名次的细任务（锚帧段 50、普通段 10）后面，新卡的计划要在约 20 段积压后面躺 224～295 s 才切分，纯浏览器节点这段时间没活可接——与 `m7-contract.md` 第 3.3 节「浏览器闲着也能抢」相反。`server/render-node/pick.mjs` 改为同一档里计划先于细任务（档仍排第一，补渲计划仍在全部 normal 之后）。探针把抢卡一步拆成「切分及时」「做完及时（超时带现场）」「一卡一环境」三条，判法没放宽 |
| 推产物偶发 400 incomplete | `claude/push-incomplete`（`opus-dev`：并发与时序、根因不明） | m7-race 查日志时发现，每遍 M7 有 1～4 段。根因在素材服务存储层：两路推送同推一段时，再传已收到的片会先撤「收到」标记再重写，另一路已答过 200、正要收尾就撞上 `incomplete`；另一路先收尾入库时这边白收 409。存储层（`fs-store`、`memory-store`、`blob-store`）改为已收到的片不重写、不撤标记、只核对长度，另一路先收尾时回 `complete`；客户端 complete 回 incomplete 时重问 `chunks`、补传再收尾（至多 2 轮），兜住还没升级的服务端 |

审查中主会话核过的一点：把计划排第一，一直切分失败的计划会不会被反复先挑、饿住细任务——队列有 `MAX_ATTEMPTS: 3`，失败 3 次即转 failed，不会。

合流：`claude/r13-merge`（main `6f0ad9e9` 起，`82eba457`）合 m7-race、push-incomplete（无冲突），整套验证后合入 main `83c6d74f`（合并结果与验证过的集成分支逐字相同），两份报告附审查归档、TODO 两条、两处契约（`render-queue-contract.md` B.3 加「计划先于细任务」；`asset-store-contract.md`「一片算不算收到」原文正是病根，改为已收到的片不重写不撤标记）一并提交（`e498bb07`）。

**0.7.13**：版本号 0.7.12 → 0.7.13（外壳仍 0.2.6，`fec9130b`），main = release = origin。从干净检出出在线构建 `index-xTcaMXT2.js`（`index.html` sha256 `a894bb5a4c92…`，82 个 assets），嵌代码版本 `0331c3277625…`（本轮没动页面代码，与 0.7.12 相同）；共享快照键与捕获代码不变；`/api` 仍只有登记过的 4 个。**托管端重部署**：自 0.7.8 起托管服务要用的文件改了 `server/asset-store/` 下 4 个（本轮的存储层修复）和部署脚本，先备份 `/root/hosted-app-backup-20261001-0713.tgz`（app 与 pm2 配置）、`/root/editor-backup-20261001-0713.tgz`，再 `scripts/remote/docservice.mjs deploy-hosted`（暂存目录里预压缩 `.gz` 14 个，`/editor` 本代 96 个、保留上一代 13 个），pm2 重启计数 20 → 21、无异常重启。桌面补丁指令改为 PC-0713-1（PC 辅助仍不在线）。

### 13.2 验证

| 项 | 提交 | 命令 | 结果 |
|---|---|---|---|
| m7-race 子分支 | `b30d0774` | tsc；`npm test`；M7 改前对照 1 遍、改后 6 遍；`claim-gate-probe`；`desktop-auto-node-probe`（本机） | 0 错误；4231 / 4229 / 0 / 2；改前必挂（加卡 88 s 后计划仍 open、排 pc 可认领任务第 14 名），改后最终版连跑 3 遍 `fails: []`，切分约 15 s、抢卡一步 33～40 s（改前 214～311 s）；认领闸、本机节点都退出 0 |
| push-incomplete 子分支 | `b168123c` | tsc；`npm test`；复现探针 `push-race-probe`；强制交错单测；M7 一遍；导入上传、本机节点 | 0 错误；4243 / 4241 / 0 / 2；分片布局改前 60 次推送挂 38 次（incomplete 109 次）、改后 0，平铺 5 → 0；单测改前 9/9 挂、改后 9/9 过；老服务端代码下老客户端 60 次挂 37 次、新客户端 0 次；M7 `fails: []`、编辑器日志 incomplete 0 次（旧日志每遍 1～4 次）；两个探针退出 0 |
| r13 整套（集成分支，按规则只跑这一遍） | `claude/r13-merge` `82eba457` | tsc；`npm test`；在线构建；G0-R；探针八项；新功能探针十三项；导航压测 200 次；取帧竞态最小复现三实例并行；推送复现分片、平铺各一遍 | **全部第一跑就过**：0 错误；4244 / 4242 / 0 / 2；G0-R 全过（确定性 1800 / 1800、逐像素 1800 相同、**流式编码 p50 255 ms**）；M7 本机 `fails: []`（切分 14.3 s、两张卡做完 29.4 s，整个探针 839 s，此前约 1100 s）；导航压测 200 次 0 失败；取帧竞态 108 000 次 seek 0 错；推送复现两种布局各 60 次 0 失败 |
| 合入与 release | main `83c6d74f`、`e498bb07`、`fec9130b` | `npm run build` | 两次都成功；合并结果与验证过的集成分支逐字相同；release 快进，已推送 |
| 托管端 | `fec9130b` | 两个 `healthz`；`pm2 jlist`；查服务器上存储层新代码 | 文档服务、素材服务（分片布局）都 `ok`；`promptcut-hosted` online、重启计数 21；`countSource` 在 `app/server/asset-store/blob-store.mjs`、`fs-store.mjs` 里都在 |
| `/editor` | `fec9130b` | `verify-editor.mjs 0331c3277625`；curl | 三处都 200、都发 `index-xTcaMXT2.js`、都含代码版本，无头打开无错误；主站与舞台源的主脚本都是 `Content-Encoding: gzip` + `Content-Length: 1344843` |
| 阿里云真机路径 | `fec9130b` | `desktop-auto-node-probe --remote https://8-219-80-16.sslip.io --base-port 5620 --skip-off`（先确认机器空闲） | 第一跑就过：退出 0、`ok: true`、`fails: []`，477 s；A2 21.5 s、A3 84.4 s、A4 66.8 s、A5 4.6 s、A7 221 s；测试项目已删、端口全放。**本机节点推产物到托管端的 incomplete / staging-discarded：0.7.12 那次 11 行，这次 0 行**（托管端新存储层 + 新客户端） |

### 13.3 〔裁〕（本轮主会话定，待用户审）

1. m7-race 的三级语义一句（`mechanism/document-service.md`「优先级」末句：同一档里计划任务排在细任务前面）。定为三级：只改已有优先级规则里计划与细任务的先后，用户感到的只是新改的卡更快开始预渲染。
2. push-incomplete 的三级语义一句（`mechanism/asset-service.md`「上传」：几路同时推同一内容时已收到的片不重写、不撤标记）。
3. 两处契约跟着改（计划层面）：`render-queue-contract.md` B.3、`asset-store-contract.md`「一片算不算收到」。
4. 托管端重部署（服务器配置与服务由主会话维护，先备份、可还原）。

### 13.4 与计划、对齐时不一致的地方

- push-incomplete 不在原计划里，是 m7-race 查日志时顺带发现的；为了只跑一次整套，等它修完与 m7-race 一起进 r13。

### 13.5 新发现、记入遗留

- 两路推送仍各推一遍每一段，是重复劳动（不再出错）；要省得让推送队列跳过节点正在推的段。记 TODO，未排期。
- 改后抢卡的两张卡都由浏览器拿到，「pc 抢到一张」的分布 M7 探针看不到——符合「谁先谁得卡」，不另加场景。

### 13.6 在做与留在分支上的

- A4 + A5：`claude/a45-merge`（对齐到 0.7.9，健康）；PC 上线后按 PC-A45-1 模板刷新到最新 main、改版本号出完整安装包，用户装上实测后合入。

### 13.7 待跨机复核

- W7 真跨机（沿用）；PC-0713-1 出 0.7.13 补丁（取代没发出的 PC-0712-1）；A4 + A5 的完整安装包。

### 13.8 待用户项

1. **装 0.7.13 补丁**（PC 上线打出来后再通知，附路径与 SHA-256）；0.7.3～0.7.12 的补丁都不用装。**装上后的第一次运行会清缓存**：帧库约 282 GB，启动约 2 分钟后按 50 GB 上限清掉约 230 GB 最久没用的预渲染缓存（需要时重新预渲染，不可撤销）；想留更多，装完先在开始页「存储」把上限调大。
2. 这一版的变化：共享项目里新加、新改的卡更快开始预渲染（不再排在别的卡的积压后面），在线页面这类纯浏览器节点也更早有活接；推产物不再偶发白费一次（托管端已更新）。前两版的变化：导出含视频图卡时偶尔取成上一帧（0.7.12 修好），共享项目里刚打开就导入的素材别的成员也拿得到（0.7.11）。
3. 第 9 轮的打包保存真机验收（装上后重新「打包保存…」，包里应有 9 份素材）。
4. 要你定的：前几轮列的待定事项（legacy 整帧通道 C / D、「文件→退出」、A4 的两条语义、在场状态、用户卡、音频计划第 6 节、「素材找不到标缺失」写不写进二级、入口卡住看门狗、托管端产物容量、`subagent-gpt` 机制备忘过时两处）。

### 13.9 顾问调用记录

本轮没有调 codex 或 Gemini：两个卡点都由子 Agent 用日志与复现探针直接坐实根因、三级层第一条就过。子 Agent：`opus-dev` 两个（m7-race、push-incomplete）。选哪个、为什么都写在派活指令里。

## 第 14 轮：PC 上线——出 0.7.13 补丁、W7 真跨机复核、A4 + A5 完整安装包（2026-10-02，笔记本主会话）

接第 13 轮。本轮代号：PC 窗口项 = 要 PC 辅助节点才能做的验收与出包（主计划 6.4 节）；站点模式 = M7 探针的 `--site` 跑法，两端都经阿里云的托管服务与协调口；A4 + A5 = SKILL 经 MCP 直连（A4）与托盘后台运行（A5），改了 Rust 外壳，只能出完整安装包。

### 14.1 做了什么

| 项 | 谁做 | 做法与结果 |
|---|---|---|
| PC 握手 | PC 辅助节点 / 主会话 | PC 报到（HEAD `729ce7f6`、bypassPermissions、Node v24.19.0、Chrome 154、ffmpeg 9.0.1、RTX 3080、局域网 192.168.50.96，像素基准 `pc-g0r-base@d70fce77`），主会话回执，积压的三项 PC 窗口项按序发出 |
| PC-0713-1 出 0.7.13 补丁 | PC | 从 release 提交 `fec9130b` 打（PC 报到时 main 多一个纯文档提交）：`PromptCut-patch-0.7.13.exe`，13 455 096 字节，SHA-256 `F1E4C3C967F60A371FEB7F67826A7F1DC0B594BD9168E575A32A7DE026E1D5AD`；基准 0.7.2、外壳代次 0.2、依赖不发（`0c3aa690…`）、37 个点名文件都在、已删的 4 个标为删除。PC 报的疑点：`files` 里有 `.git`——查明是 `--from-head` 的临时 worktree 里 `.git` 是指针文件，`prepare-runtime.mjs` 的排除名单只对目录生效；运行时代码不调 git，不影响功能，补丁照装，打包排除另修（`claude/release-no-git`） |
| PC-W7-1 W7 真跨机 | PC（创建者）+ 笔记本（纯浏览器节点） | M7 探针站点模式，run `m7w1002a`，经 `https://8-219-80-16.sslip.io`（托管端与 `/editor` 都是 0.7.13）：W7 跨机通过（DESKTOP-GS40TCK 当创建者、LAPTOP-A56T03FK 当节点、计时以笔记本为准）；M7-A1、A2、A5～A10（接手 6.0 s）、A12，D1-D2-D12、D9、D10、D14 全过；A3 服务端那半外网看不到认领者、由节点侧判（8 个禁止任务 60 s 0 认领）过；A11 票据过期一项外网判不了（照旧另验）；**A4 经公网 54.3 s**，按 M8 定的判法只作观察（30 s 门槛以笔记本本机替身为准，本机 22～24 s 过），比 9-28 的观察值 37.4 s 慢，记观察项 |
| A4 + A5 对齐 main 与测试版本号 | 主会话 | `claude/a45-merge` 合 main 到 0.7.13（`b60f4b0e`）：一处冲突——`server/test/codex-desktop.test.mjs` 在 A4 里随被测模块 `server/codex-desktop.ts` 一起删了、main 上上一轮改过，保持删除；改测试版本号应用 0.7.14、外壳 0.2.7（`71f7a9ed`，6 个文件，与上次外壳升版同形）；推到 origin |
| PC-A45-1 A4 + A5 完整安装包 | PC | 从 `71f7a9ed` 出（445 s，PC 数）：`PromptCut-0.7.14-setup.exe` 433 679 525 字节，SHA-256 `26397283BBBAC5D9A28681B992A4E32A865FEB05CAADA9CD7E0FC3A6C59AC32C`；补丁 `PromptCut-patch-0.7.14.exe` 13 423 544 字节，SHA-256 `BEC610B4246448647C12630253DB6379C1E19D4EB3DBEB47C362718D89D82349`（测试构建，补丁不发给用户）；外壳 0.2.7 用 MSVC 工具链编过，只有 1 条 `linker_messages`、没有代码警告。PC 提的两点：① `minShellVersion` 0.2.0——按 tray 报告第 8 节「老外壳上能降级运行」（没有托盘、关窗照旧退出，`apply-patch.ps1` 对不认 `--quit` 的老外壳退回原关窗方式）不抬，测试只给完整安装包；② 打包后 `desktop/src-tauri/Cargo.toml` 被 tauri CLI 同步依赖特性时写回成 LF、显示被改（内容不变），用 `.gitattributes` 定 `eol=lf` 修 |
| 打包卫生 | `claude/release-no-git`（`sonnet-dev-high`：维护项，选法表「日常」） | `prepare-runtime.mjs` 的排除名单只对目录生效，`--from-head` 临时 worktree 里 `.git` 是指针文件、被拷进运行时目录与补丁清单（0.7.13、0.7.14 的 manifest 都有）：改为 `.git` 文件与目录都跳过，`make-patch.mjs` 收集清单时每层也排除（PC 上旧运行时目录里已有的也挡住）；脚本「是否直接执行」改为真实路径、win32 不分大小写比较（主会话审查时要求的加固：逐字比较在目录联接或盘符大小写不同时会让 prepare-runtime 悄悄不干活）；`.gitattributes` 给 `desktop/src-tauri` 的 `Cargo.toml`、`Cargo.lock` 定 `text eol=lf`。验证：tsc 0 错误、`npm test` 4244 / 4242 / 0 / 2、外壳单测 21 / 21、模拟工具按 LF 写回后工作区干净。只动打包工具，留在分支上，下次集成一起合入 |

### 14.2 验证

| 项 | 提交 | 命令 | 结果 |
|---|---|---|---|
| A4 + A5 集成分支 | `claude/a45-merge` `71f7a9ed` | tsc；`npm test`；`node --test desktop/test/*.test.mjs`；在线构建；`skill-mcp-probe`；`multi-agent-probe`；首次握手；舞台看守；C10 界面 | 0 错误；4217 / 4216 / 0 / 1（比 main 少的是 A4 删旧 SKILL 路径时一起删的测试）；外壳测试 23 / 23；其余都退出 0（MCP 35 项、多 Agent 35 项）。Rust 侧自上次 `cargo test` 24 条全过后只改了版本号；笔记本 GNU 工具链缺 `dlltool` / `as`，这次没重跑，外壳能否编过以 PC 完整构建为准 |
| W7 | run `m7w1002a` | 见 14.1 | 见 14.1 |
| PC 完整构建 | `71f7a9ed` | `cd desktop && npm ci && npm run release -- --from-head` | 退出 0（445 s，PC 数）；外壳 0.2.7 编过；安装包、补丁、清单见 14.1 |

### 14.3 〔裁〕（本轮主会话定，待用户审）

1. W7 的 A4 经公网 54.3 s 照 M8 定的判法记观察项，不算 W7 失败。
2. 0.7.13 补丁里的 `.git` 指针文件判为无害、补丁照装，打包排除另修。
3. a45-merge 合并冲突：`codex-desktop.test.mjs` 保持删除（被测模块已随 A4 删掉）。

### 14.4 与计划、对齐时不一致的地方

- 0.7.14 是 A4 + A5 的测试构建，不进 release；正式版等用户实测通过、在集成分支跑过整套合入 main 后，从 main 重新出（那时连同打包卫生的修复，manifest 里不再有 `.git`）。
- 笔记本这次没重跑 cargo（GNU 工具链缺 `dlltool` / `as`），外壳能否编过以 PC 完整构建为准——编过。

### 14.5 新发现、记入遗留

- 站点模式 A4 观察值变慢：9-28 37.4 s → 本次 54.3 s（经公网，非门槛）。下次站点复测再看是网络时段还是代码；本机替身照过。
- 打包把 `--from-head` 临时 worktree 的 `.git` 指针文件带进运行时目录（`claude/release-no-git` 修）。

### 14.6 在做与留在分支上的

- A4 + A5：完整安装包已出（0.7.14 / 外壳 0.2.7），等用户装上按 tray 报告第 7 节的 8 步清单实测；通过后在集成分支跑整套，连同 `claude/release-no-git` 合入 main，合入时按 `git_and_release.md` 定正式版本号（按第 8 节建议：应用末位 +1、外壳 0.2.7，补丁与完整安装包都出）。合入后 PC 主工作区要重新检出一次 `desktop/src-tauri/Cargo.toml`、`Cargo.lock`，`eol=lf` 才生效。
- 打包卫生：`claude/release-no-git`（已验证，待集成）。

### 14.7 待跨机复核

- A11 票据过期在托管端用测试钩子另验（沿用）。

### 14.8 待用户项

1. **装 0.7.13 补丁**：PC 上 `C:\Users\admin\Documents\PromptCut\desktop\release\PromptCut-patch-0.7.13.exe`（13 455 096 字节，SHA-256 `F1E4C3C9…E1D5AD`）；0.7.3～0.7.12 的补丁都不用装。**装上后的第一次运行会清缓存**：帧库约 282 GB，启动约 2 分钟后按 50 GB 上限清掉约 230 GB 最久没用的预渲染缓存（需要时重新预渲染，不可撤销）；想留更多，装完先在开始页「存储」把上限调大。
2. **实测 A4 + A5（测试构建，装不装由你）**：PC 上 `C:\Users\admin\Documents\PromptCut\desktop\release\PromptCut-0.7.14-setup.exe`（433 679 525 字节，SHA-256 `26397283…59AC32C`）。它已含 0.7.13 的全部修复，装它就不用另装 0.7.13 补丁；装上后的第一次运行同样会清缓存（同上）。装上后按 tray 报告第 7 节的 8 步清单实测：关窗不退出、收起时页面侧工具照常（含 5 分钟后再调一次）、托盘与悬浮窗唤回、悬浮窗拖动、右键关闭才退出（promptcut.exe、node.exe、ffmpeg.exe 都不在）、SKILL、多显示器、补丁经 `--quit` 干净退出；另在 PromptCut 里点「登记到 Claude Code / Codex」各开一个会话连过来，看 AI 栏有没有对应分组。另外「文件 → 退出」菜单项留不留由你定。
3. 第 9 轮的打包保存真机验收（装上后重新「打包保存…」，包里应有 9 份素材）。
4. 要你定的：前几轮列的待定事项（同第 13 轮）。

### 14.9 顾问调用记录

本轮没有调 codex 或 Gemini。子 Agent：Sonnet 一个（release-no-git，选法表「日常」，返工两次：加固「是否直接执行」、加 Cargo 行尾规则）。PC 辅助节点三项窗口项（PC-0713-1、PC-W7-1、PC-A45-1）。

## 第 15 轮：Codex 接手 A4 + A5 真机验收与正式发布（2026-10-02，笔记本主会话；main 与网页完成，正式桌面包待发布配置）

任务书是 `docs/plan/a45-acceptance-test-plan.md`（d391883f）；用户本轮补充指示取代其中「只测、不改代码、不合入、不出包」的旧范围。本轮授权包括写 main、出完整安装包、部署 /editor；PC 的用户安装不动，真补丁和多屏仍待用户。所有带耗时门槛的项在笔记本串行跑，取帧竞态按规定三实例并行。

### 15.1 已执行与用户决定

- main 起点 f119a66d；release 起点 fec9130b（应用 0.7.13 / 外壳 0.2.6）。集成分支同步 main 后依次 `--no-ff` 合入 ps1-bom、draft-lock、release-no-git。ps1-bom 的两处修改/删除冲突保持 A4 已删除的旧 Claude 桌面驱动及其测试，编码修复保留在现存脚本上。
- R4 镜像退出脚本实际测到草稿锁残留，修复在独立 worktree/分支 `claude/r4-lock-cleanup`：Windows 持锁句柄关闭时由内核删除旁路文件，正常退出和强杀都不用等 Node 清理回调。见 `AGENT-r4-lock-cleanup.md` 卡点 1 第 1 行；只修实现，没有语义变更。已合流。Cargo 下子测试全名不同造成的夹具失败也已修复。
- 用户已定：「文件 → 退出」保留，已同步 `docs/semantics/user-workflow.md`；回首页维持持锁。维持持锁会让其它实例在这个窗口回到首页后仍不能打开 A，直到切换草稿/新建/退出；若改成回首页放锁，其它实例能立刻接手 A，但返回 A 时要重新抢锁，也可能因为别人已经打开而被拒。本轮不改，政策复核列入待用户项。
- R6 的 x=-2678 是单屏现场坐标。实际代码按 `available_monitors` 中最左屏位置减去窗口宽度和 256 像素计算，没有写死该值；Rust「副屏在主屏左边」测试通过。仍不能替代 PC 双屏实测，不宣称 R6 已过。
- 正式命令因缺 VITE_DIAG_* 本地发布配置退出 1。解法表见 `AGENT-a45-build-config.md`；继续独立项，不把缺配置的测试构建当正式包。版本号沿用本轮已提交的应用 0.7.14 / 外壳 0.2.7，正式产物必须重新从正式 HEAD 出。

### 15.2 子分支验证

均由本主会话执行，依赖向上解析，没有创建 node_modules junction。ffmpeg 路径按本机 docs/local.md 就位；日志在对应 worktree 的 out/a45-validation/。令牌与密钥值未输出。

| 分支 | 命令 | 结果 |
|---|---|---|
| ps1-bom 1398e237 | `npx tsc -b --force`；`npm test`；`node --test desktop/test/*.test.mjs`；`node --test server/test/claude-desktop.test.mjs`；Windows PowerShell 5.1 ParseFile 三份随包 .ps1；`node --check scripts/probes/m8-outbound-probe.mjs` | 0；4245 / 4243 / 0 / 2；19/19；16/16；三份各 0 解析错误；0 |
| draft-lock c47f2abf | tsc 同上；`npm test`；`node --experimental-test-module-mocks --test src/editor/io/draftLock.test.mjs` | 0；4251 / 4249 / 0 / 2；7/7 |
| release-no-git 913f223e | 审查实际 diff；`node --test desktop/test/prepare-runtime-filter.test.mjs`；集成分支全量 | 5/5；完整基线结果见下一节 |
| r4-lock-cleanup 2e8c68c3 / d87821a9 | tsc 同上；`npm test`；直接编译 proc_lock.rs 和带 mod proc_lock 的 Rust 测试 harness | 0；4217 / 4216 / 0 / 1；修复前 3 项失败、修复后 3 项过，另 1 个忽略子入口；夹具修正后再次全量同样全过 |

### 15.3 R1～R8 现场验收

本轮截图与脚本在集成 worktree 的 `desktop/.cache/a45-install/`；截图、MCP 输出、进程表和命令结果已直接贴进对话。

| 项 | 结论（当前） | 实测与证据文件 |
|---|---|---|
| R1 | 过 | Codex 原生登记 MCP 读项目并 split_clip，rev 7→8；AI 栏出现 Codex 分组，悬浮窗有「上一步：切开卡片」与画面；抓到「Codex 正在 see_frames」；展开超过 60 s 仍保持 SKILL；传统式收起显示后台运行，桌面 Claude get_project 回 skillClosed、无项目改动。r1-ai-top.png、r1-collapsed.png、r1-working-c-60.png、r1-open-60-start.png / end.png、r1-traditional-collapsed.png、r1-failed-group.png |
| R2 | 过 | 实际 Windows 右键托盘菜单成功，打开后回原位置、前台，输入框接受打字；r2-tray-menu.png、r2-open-result.png、r2-type.png |
| R3 | 过 | 托盘和悬浮窗两种右键关闭均使应用及 sidecar 进程为 0；本会话的 stdio MCP 客户端单列、结束后重测，不当成 sidecar。再开主窗仍为 (240,54)、2422×1453，状态文件记的是屏上坐标；r3-tray-clean-menu.png / quit.png、r3-overlay-menu.png / quit.png、r3-reopen-position.png |
| R4 | 过（保留初测失败） | 初测进程归零但 64 字节锁残留。修复后的实际安装版打开 A，A 锁 64 字节；展开 Rect=240,54 2422x1453；收起后镜像 0.39 s 发 --quit、1.35 s wait=0、3.48 s final=0、fallback=False，完整进程表安装目录名下为 0，A/B 正文保留、锁消失，重开 Rect 相同。r4-final-open-a.png、r4-final-overlay.png、r4-final-quit-test.log、r4-final-reopen.png。最后一轮输入桌面在 Screen-saver，使用真实 WebView 截图与原生 PrintWindow，未伪造桌面图 |
| R5 | 待用户 | 真补丁的 PC 基准清单不可达。PC 上从本轮最终 main 出 `cd desktop && npm run release -- --from-head --patch-only`，将真实补丁拷到笔记本后补测 0.2.7 的退出/装补丁/重开，以及允许的先降装 0.7.13（外壳 0.2.6）同补丁强杀兜底，再装回本轮版本。没有动 PC 的用户安装，也没用镜像冒充真补丁 |
| R6 | 待用户在 PC 验 | 副屏放在主屏左边，收起后两屏上都不应出现主窗任何一部分；重点核对主窗虽仍 visible，计算出的屏外坐标是否确在所有屏幕之外。单屏不等于通过 |
| R7 | 待用户（草稿锁与实际拓展包编码已过） | 新安装包现场「开始创作→首页→开 A」后 A.proc.lock 为 64 字节；「A→首页」保持 A 锁；打开 B 后 B 锁 64 字节、A 锁消失。r7-new.png、r7-new-home-dialog.png、r7-confirm-home.png、r7-home-open-a.png、r7-a-home.png、r7-home-open-b.png。更正早先的包位置判断：apply-extension.ps1 是独立拓展包的临时执行脚本。实际 `node desktop/scripts/make-extension.mjs stt --keep-stage` 退出 0（19.5 s），NSIS 收集 payload 中脚本 BOM=True、PowerShell 5.1.26100.9444 ParseFile=0；script SHA-256 A644898DAEF50829B9ED4664C86D827D1104DFAC16F09E113D51F854A1EADCAD。未安装可选能力，不把源解析冒充随包结果；补丁中的 apply-patch.ps1 与真安装仍待 R5 |
| R8 | 过 | SKILL 对话框实际撤销两张卡登记；Claude Code 当前与备份均没有 mcpServers.promptcut。Codex 撤销后还含登记以后增加的桌面工具与插件配置，首次整文件比较不一致；按本轮明确恢复授权，先将当前完整配置留本机忽略备份，再复制原登记备份，逐字节比较为 true。传统式「文件→退出」后安装目录名下进程 0，A/B 草稿 4554/4555 字节保留、锁均消失。r8-skill-dialog.png、r8-claude-confirm.png、r8-codex-confirm-desktop.png、r8-file-menu-desktop.png、r8-after-exit.png；check-registration.mjs 输出四个对应布尔值 false / false / true / true |

### 15.4 集成整套验证（本机项完成；W7 为 PC 窗口项）

`claude/a45-merge` 代码验证起点 47bb49fb 合流后的内容；其后变更只有用户决定的纯文档和 Rust 子测试夹具。G0：`npx tsc -b --force` 0；`npm test` 4224 / 4223 / 0 / 1（80.13 s）；桌面脚本 31/31。较 main 少的测试随 A4 删除旧被测路径，沿用第 14 轮已说明的原因，没有删现行路径测试。Rust MSVC `cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml` 27 过、0 失败、1 子入口忽略；外壳 release 编译通过。

G0-R 与全部探针逐项命令、结果由 `out/a45-validation/suite-results.json` 保留。已过：main 全长 1800 帧、候选两遍 1800/1800 相同、快照重放、就绪索引、流式生产及 group（全幅编码 p50 242 ms，门槛 300 ms）、预览 page-preload、视频节奏、取帧竞态三实例合计 108000 次且 stale/wrongPixel 都为 0。普通预览兜底仅「跳转:舞台记下了逐拍分级」失败，按规则在各子分支独立目录与实例上逐个定位。像素比较启动器误写脚本文件名，现已补齐，结果见下文。

首套 45 个命令已执行完：40 个退出 0，M7 退出 3 仅 W7 真跨机待复核；另有上述像素比较命令错误、普通预览回退、C10 界面、换档三项失败。M7 最慢锚点段 24028 ms，低于本机 30000 ms 门槛。真实跨机沿用第 14 轮已有证据，本轮没有重跑，按主计划 6.4 节列为 PC 窗口项，不混称退出 0。导航 200 次通过；两种存储布局各 30 轮、60 次推送，均零失败。C10 点击前下载数为 2：默认下载目录存在 9 月 28 日的两份测试 JSON，保留原文件，改用各次独立目录复跑原断言。换档失败包括采样空档与素材原尺寸到齐后的切换超时，待逐分支定位。

像素对比已补齐。先发现命令行 main 导出默认 4 个进程、`verify-determinism` 用单进程，保留旧产物后从同一份 main `f119a66d` 重新以 `--workers 1 --fps 30 --no-video` 导出全长到 `a45-baseline-single-30`（189.0 s、1800 帧）。`node scripts/probes/export-baseline-compare.mjs compare --baseline <main worktree>/out/a45-baseline-single-30/frames --candidate out/verify-a/frames` 退出 0，1800/1800 逐字节相同、零不同、零缺失，没有改像素基线。两边 `snapshotCode` 均为 `00a5264bf8a062ff6e0b5ed0516cccd1`，`captureCode` 均为 `86e443cb6fa838aef64788af6822fd68`。

验证启动器第一次把 Windows Path 属性大小写写错，导致测试子进程找不到 PowerShell/taskkill。结束本启动器进程树、修正环境传递后全量通过；失败日志保留为 g0-test-harness-path-failure.log，未当代码缺陷处理。导出日志的 1440 是第一个分片，汇总为 1800；重新读取汇总已纠正口径。

### 15.4.1 首套命令逐项记录

下表保留首跑原始退出码；后面的定位、补测结果另记，不覆盖失败证据。路径占位符指对应 worktree，命令中的端口为实际使用值。G0 全量命令是 npm test 的展开；在线构建是 npm run build 中的 Vite 阶段。

| 项 | 实际命令 | 退出码 | 秒 |
|---|---|---:|---:|
| g0-tsc | `node <repo>/node_modules\typescript\bin\tsc -b --force` | 0 | 7.6 |
| g0-test | `node --experimental-test-module-mocks --test-global-setup=server/test/global-setup.mjs --test server/test/*.test.mjs src/**/*.test.mjs tools/report-worker/*.test.mjs` | 0 | 80.2 |
| desktop-test | `node --test desktop/test/*.test.mjs` | 0 | 2.4 |
| online-build | `node <repo>/node_modules\vite\bin\vite.js build --mode online --outDir <integration worktree>\out\a45-validation\dist-online` | 0 | 3.2 |
| main-pixels | `node scripts/export-frames.mjs --url http://127.0.0.1:5206/?export=1 --out <main worktree>\out\a45-baseline --no-video` | 0 | 153.4 |
| main-pixels | `node scripts/export-frames.mjs --url http://127.0.0.1:5206/?export=1 --fps 30 --out <main worktree>\out\a45-baseline-30 --no-video` | 0 | 192 |
| determinism | `node scripts/verify-determinism.mjs --url http://127.0.0.1:5203/?export=1 --fps 30` | 0 | 502.2 |
| pixel-compare | `node scripts\probes\export-baseline-compare-probe.mjs compare --baseline <main worktree>\out\a45-baseline-30\frames --candidate <integration worktree>\out\verify-a\frames` | 1 | 0.1 |
| unified-frames | `node scripts/verify-unified-frames.mjs --origin http://127.0.0.1:5203` | 0 | 15.1 |
| ready-index | `node scripts\probes\ready-index-probe.mjs --port 5260` | 0 | 98.3 |
| stream-produce | `node scripts\probes\stream-produce-probe.mjs --origin http://127.0.0.1:5203` | 0 | 57.6 |
| stream-group | `node scripts\probes\stream-produce-probe.mjs --origin http://127.0.0.1:5203 --group` | 0 | 33.9 |
| preview-fallback | `node scripts\probes\preview-fallback-probe.mjs --origin http://127.0.0.1:5203` | 1 | 82.2 |
| preview-preload | `node scripts\probes\preview-fallback-probe.mjs --origin http://127.0.0.1:5203 --page-preload` | 0 | 38.9 |
| video-cadence | `node scripts\probes\video-source-cadence-probe.mjs --port 6030` | 0 | 19.1 |
| seek-race-1 | `node scripts\probes\video-seek-race-probe.mjs --port 6211 --mode fixed --busy --settle 0 --loops 300` | 0 | 92.9 |
| seek-race-3 | `node scripts\probes\video-seek-race-probe.mjs --port 6231 --mode fixed --busy --settle 0 --loops 300` | 0 | 93.3 |
| seek-race-2 | `node scripts\probes\video-seek-race-probe.mjs --port 6221 --mode fixed --busy --settle 0 --loops 300` | 0 | 93.4 |
| c10-browser | `node scripts\probes\c10-browser-probe.mjs --only-a4 --no-video --base-port 5600 --dist <integration worktree>\out\a45-validation\dist-online` | 0 | 181.9 |
| c10-user-card | `node scripts\probes\c10-browser-probe.mjs --user-card --only-a4 --no-video --base-port 5600 --dist <integration worktree>\out\a45-validation\dist-online` | 0 | 343.4 |
| online-user-cards | `node scripts\probes\online-user-cards-probe.mjs --dist <integration worktree>\out\a45-validation\dist-online --base-port 5650` | 0 | 33.9 |
| online-stage-watch | `node scripts\probes\online-stage-watch-probe.mjs --dist <integration worktree>\out\a45-validation\dist-online --base-port 5720` | 0 | 143 |
| m7-browser | `node scripts\probes\m7-browser-probe.mjs --role all --timing-authoritative --base-port 5710` | 3 | 831.1 |
| desktop-auto-node | `node scripts\probes\desktop-auto-node-probe.mjs --dist <integration worktree>\out\a45-validation\dist-online --base-port 5620` | 0 | 464.8 |
| c10-ui | `node scripts\probes\c10-ui-probe.mjs --dist <integration worktree>\out\a45-validation\dist-online --proxy-port 5660 --doc-port 5661 --asset-port 5662 --proxy2-port 5663` | 1 | 167.1 |
| online-stale-layer | `node scripts\probes\online-stale-layer-probe.mjs --dist <integration worktree>\out\a45-validation\dist-online --base-port 5610` | 0 | 41.8 |
| query-render | `node scripts\probes\query-render-probe.mjs --port 5756` | 0 | 167.9 |
| creativity | `node scripts\probes\creativity-probe.mjs --origin http://127.0.0.1:5203` | 0 | 8.7 |
| user-editing | `node scripts\probes\user-editing-probe.mjs --origin http://127.0.0.1:5203` | 0 | 4.7 |
| multi-agent | `node scripts\probes\multi-agent-probe.mjs --phase all` | 0 | 57.6 |
| custom-measure | `node scripts\probes\custom-measure-probe.mjs --port 5860` | 0 | 23.4 |
| asset-path | `node scripts\probes\asset-path-probe.mjs --port 5920` | 0 | 28.4 |
| bake-asset | `node scripts\probes\bake-asset-probe.mjs --port 5970` | 0 | 155.7 |
| claim-gate | `node scripts\probes\claim-gate-probe.mjs --port 5990 --doc-port 5993` | 0 | 339.3 |
| tiers | `node scripts\probes\tiers-probe.mjs --port-a 6020 --port-r 6023` | 0 | 34.1 |
| tier-switch | `node scripts\probes\tier-switch-probe.mjs --origin http://127.0.0.1:5203 --remote-port 6025` | 1 | 93.8 |
| storage-cap | `node scripts\probes\storage-cap-probe.mjs --port 5670` | 0 | 31.2 |
| storage-ui | `node scripts\probes\storage-ui-probe.mjs --port 5680` | 0 | 84.8 |
| cross-machine-proc | `node scripts\probes\cross-machine-proc-probe.mjs --port-a 6070 --port-b 6075 --port-c 6080` | 0 | 124.8 |
| shared-import-upload | `node scripts\probes\shared-import-upload-probe.mjs --doc-port 6120 --asset-port 6121 --port-a 6110 --port-b 6115` | 0 | 31.7 |
| skill-mcp | `node scripts\probes\skill-mcp-probe.mjs --port 5880` | 0 | 23.7 |
| online-stage-handshake | `node scripts\probes\online-stage-handshake-probe.mjs --dist <integration worktree>\out\a45-validation\dist-online --base-port 6010` | 0 | 174 |
| online-nav-stress | `node scripts\probes\online-nav-stress-probe.mjs --dist <integration worktree>\out\a45-validation\dist-online --base-port 6090 --iters 200 --out <integration worktree>\out\a45-validation\nav-stress` | 0 | 268.2 |
| push-race-shard | `node scripts\probes\push-race-probe.mjs --port 6440 --rounds 30 --store shard` | 0 | 25.5 |
| push-race-flat | `node scripts\probes\push-race-probe.mjs --port 6440 --rounds 30 --store flat` | 0 | 66.9 |

### 15.4.2 首跑失败项定位与补测

按 verification.md 在七个子分支/集成分支逐个单跑，dev 端口依次 6240、6250、6260、6270、6280、6290、6300；换档远端 6345；C10 每次独立在线构建，proxy/doc/asset/proxy2 端口 6340/6341/6342/6343。每次给唯一的 `--out` 与数据目录，原断言保留；命令全文和耗时在 `out/a45-validation/locate/results.json`。

| 分支 | preview-fallback（码 / 秒） | tier-switch（码 / 秒） | online build（码 / 秒） | c10-ui（码 / 秒） |
|---|---|---|---|---|
| skill-mcp | 0 / 96.2 | 0 / 64.6 | 0 / 3.0 | 0 / 163.6 |
| tray | 0 / 97.5 | 0 / 62.0 | 0 / 3.0 | 0 / 175.3 |
| release-no-git | 0 / 95.0 | 1 / 93.2 | 0 / 3.0 | 0 / 172.2 |
| ps1-bom | 0 / 96.7 | 1 / 93.4 | 0 / 3.0 | 0 / 172.0 |
| draft-lock | 0 / 96.7 | 1 / 94.0 | 0 / 2.9 | 0 / 168.5 |
| r4-lock-cleanup | 0 / 97.2 | 1 / 95.6 | 0 / 3.0 | 0 / 174.3 |
| a45-merge | 0 / 47.5 | 1 / 100.3 | 0 / 3.3 | 0 / 167.0 |

换档回到 release-no-git 所含的新基线独立定位，专用分支 `claude/tier-switch-baseline`。只读 RPC/DOM 诊断保留原断言，两轮重现失败：同一项目素材 url 被本机缺失检查清空，两个槽位真实一起隐藏，前台角色与媒体时刻未改变。原探针只调用 setRemoteAssets 却未进入共享空间；main bb21d84b 新增的本机缺失检查是在错误夹具中正常执行。按真实 enableCollab 入口建立隔离共享项目后添加测试素材，再由原场景控制远程服务；产品代码和黑帧、帧误差、超时断言不动。解法表 `AGENT-tier-switch-baseline.md` 卡点 1 第 6 行（三级，无〔裁〕）。

子分支 `node scripts/probes/tier-switch-probe.mjs --origin http://127.0.0.1:6350 --remote-port 6355 --out out/a45-validation/tier-fix-first` 0、71.0 s、fails=[]；T5a/T5c/T5e 黑帧全为 0、播放换档误差为 0 帧。类型检查 0、全量 4244 / 4242 / 0 / 2（82.5 s）、桌面脚本 21/21。按规则先合回 release-no-git（6295c387），再合入 a45-merge（17f515c2）。

另发现 Windows PowerShell 5.1 函数只输出一个 PSCustomObject 时为标量，Count=null。专用 `claude/ps1-process-count` 修正真实补丁关闭段四处计数，避免仅剩一个时跳过退出或误报干净；真实关闭代码段在隔离假进程/时钟中执行四种情形全过。类型检查 0、全量 4224 / 4223 / 0 / 1（81.9 s）、桌面脚本 35/35、源三份随包 PowerShell ParseFile 各 0 错且 BOM 均有；c4d4ed8d 合流。两项都不改渲染，子分支不重复 G0-R，集成合流后补跑 G0、桌面脚本及换档。

合流后集成 G0 复验：代码 17f515c2，之后仅报告、计划更正、R4 证据。类型检查 0、10.3 s；全量测试 4224 / 4223 / 0 / 1、82.2 s；桌面脚本 35/35、1.3 s。日志 `out/a45-validation/branch-results.json`。集成换档复验同一命令退出 0、70.7 s、fails=[]；T5a 黑帧 0、1940 ms；T5b 换槽后黑帧 0、4099 ms、帧误差 -0.39；T5c 慢原尺寸源黑帧 0、16359 ms；T5e 重载后黑帧 0、2120 ms。门槛与产品代码均未改，结果在 `out/a45-validation/tier-fix-first/`。

### 15.5 发版、部署、未跑与〔裁〕

正式构建首试：`cd desktop && npm run release -- --from-head` 组装 runtime 因缺发布配置退出 1。测试用 `npx tauri build` 已编过 Rust；NSIS 工具解压后的 rename 报 os error 17，把它复制到 Tauri 预期缓存位置、下载附加插件并核对官方 SHA-1 后，重试通过，详见下一段。该测试构建不构成正式发布通过。

NSIS 工具缓存已核对能报告 v3.11。`cd desktop && npx tauri build` 测试构建重试退出 0，Rust release 编译 2.96 s，其后完成安装包压缩。测试包 PromptCut-0.7.14-a45-retest-setup.exe 为 432441826 字节，SHA-256 `3E68F7EEA5EBEF4DD51FA3751D00F156F8B6CA23B45FDCF224DAF09775E6C177`；已用真实安装向导完成本机重装，安装的 promptcut.exe 与目标 Rust 产物 SHA-256 相同（`902AF6463A1DE85F864248B1D8DF7664C1EC22DE6D7AC8ED2286424E25315358`）。有一条 `__TAURI_BUNDLE_TYPE` 标记缺失警告，保留日志；源码没有 updater 插件，本轮仍用已有的自有补丁安装器。这个测试包不构成正式 release 命令通过。部署前只读检查：主站与两个舞台源 `/editor/` 均 200，主站 `/hosted/healthz` 200，托管服务 online、重启计数 21。托管清单只变 `vite-plugin-media.ts` 的旧无头实例队列判断；托管组合实际调用的素材函数未变，只需换静态编辑器页。

合入前 `npm run build`（先 tsc，再 Vite 普通网页构建）退出 0，Vite 1.79 s；提交 d3bbb625，工作区干净。`git fetch origin` 后 main 仍为 f119a66d，按本轮明确授权 `git merge --no-ff claude/a45-merge` 得到 `c4d9f0fe0bb50dce64398306d4512edce2eda670`；与验证过的集成末端 db565958 整棵树相同，已 `git push origin main`。集成快进到该合并提交，连同 release-no-git、r4-lock-cleanup、ps1-process-count、tier-switch-baseline 推送。立即判定 release：桌面壳与运行时布局涉及本轮改动，正式发版构建未成功，三项合入条件未同时满足，因此保留 `fec9130b2373deb1c13d201212e92519423a1a87`，不能用测试 NSIS 包代替正式构建。R5 真补丁与老外壳降装因 PC 真实补丁未到而未跑；R6 无第二屏；正式出包因本地构建配置缺失。

`/editor` 从已提交的 main c4d9f0fe 构建：`npm run build -- --mode online --outDir out/a45-validation/dist-online-final` 退出 0，Vite 1.67 s。`node out/a45-validation/deploy-editor.mjs` 退出 0；它直接复用仓库 `server/hosted/deploy.mjs` 的 stageEditorBuild / editorSwapLines，先备份 `/opt/promptcut-hosted/.a45-backups/editor-before-c4d9f0fe0bb5.tar.gz`，上传预压缩后的暂存目录，再换代；14 个 gzip、本代 96 个 assets、保留上一代 15 个，111 个在位，runtime-config.json 原样保留。托管后端使用的模块相对 0.7.13 未变，不重启 PM2。

`node out/a45-validation/verify-editor.mjs` 退出 0：主站 `https://8-219-80-16.sslip.io/editor/` 与 s1 / s2 两个舞台源均 200，均发 `/editor/assets/index-RvNdCRPh.js`，含本轮 frameCode `f2b39909cf8cf38a4844436777faf817187e5385e50ea8b33dd61f6af0ba96bb`；index SHA-256 均为 `8651922ea1b83bc8df3a4472515d8ae2eecf6edddaa30f5b544a10fdf699f4dd`，入口 JS SHA-256 均为 `fc527e7bb616decd85cae7d1ea2c0167e1404c05ec0ccce33172989a119dbb98`。三处浏览器页面/控制台错误数组均空，主脚本 Content-Encoding=gzip、Content-Length=1338211；运行配置 v=1、两个舞台源正确。主站 hosted / media 两个 healthz 均 200；promptcut-hosted 仍 online、PID 110031、重启计数 21。截图 `out/a45-validation/editor-<域名>.png`，部署/核验元数据为 editor-deployment.json / editor-after.json；真实公网渲染路径复验结果另补。

R7 实际独立拓展测试包：`desktop/release/extensions/PromptCut-ext-stt-1.0.0.exe`，83991737 字节，SHA-256 `4A8099784FC60FADB95C9B124D914B002293359FF4E8C96A1EF22EAB3ABAB582`。保留的 `.cache/ext-stage/PromptCut-ext-stt-1.0.0/` 为成功 NSIS `File /r` 收入的真实 payload；本轮只做随包编码核验，没有安装或发布该可选能力。

真实公网路径：`node scripts/probes/desktop-auto-node-probe.mjs --remote https://8-219-80-16.sslip.io --base-port 5620 --skip-off --out out/a45-validation/editor-remote-final` 退出 0、490.1 s、ok=true、fails=[]。A2 补推原有重卡层 22.5 s、120 帧/120 块齐；A7 219.4 s、另一项目 120 块泄漏 0、云端无其层表、绑定未打断；A3 100.7 s，在线成员显示 U1、桌面与线上项目文档 id 相同、代码版本相同；A4 66.5 s，关闭桌面页面后节点切分并完成在线新改内容的 6 个段，编辑到显示 52.0 s；A5 4.7 s，重开交接后离开共享项目，nodes=[]、推送停止。桌面与成员页错误数组均空；本轮测试项目已 shared.admin.ok 删除，cleanup.listening=[]。截图 a3-online-u1.png、a4-online-u2-before.png / after.png 已直接贴进对话；日志与产物目录在 out/a45-validation/。整个探针使用隔离的数据、项目、工作与 TEMP 目录，启动器设置 PROMPTCUT_NO_PORT_FILE=1；未写用户数据。

本轮〔裁〕两条：补齐上一任交接时留下的三级「桌面 APP 接入」和「桌面应用后台运行」机制说明，均指向 15.8 节卡点 1 第 1 行；内容依据已经通过的实现及 A4/A5 归档报告，不改一二级行为。原 A4 的九条实现选择、A5 的十条实现选择仍完整保留在对应归档报告第 5 节，没有伪造它们的历史解法表。退出清锁（归档 AGENT-r4-lock-cleanup 卡点 1 第 1 行）、PowerShell 单进程计数（归档 AGENT-ps1-process-count 卡点 1 第 1 行）、共享项目换档夹具（归档 AGENT-tier-switch-baseline 卡点 1 第 6 行）只修实现，没有新增语义裁决。菜单保留来自用户明确决定；草稿锁政策依用户决定维持。未把出包守门删掉或把真补丁要求降成镜像。

### 15.6 顾问调用记录

没有调用工程顾问或本机子 Agent，用户把顾问流程改为主会话每层扫空后换角度重列候选；代码修改和笔记本验证由 Codex 主会话完成，任务未派给 PC。用户随后明确授权云端工作节点，主会话仅经 HTTP 信箱派出只读配置审计，详见 15.10；没有把笔记本性能门槛移到云端。

### 15.7 待用户项与未跑项

1. **正式出包的阻塞项**：笔记本没有 PC 的原有发布配置（VITE_DIAG_SUBMIT_URL / VITE_DIAG_SUBMIT_TOKEN）。解法表 `docs/reports/AGENT-a45-build-config.md` 卡点 1 第 1～7 行：本地配置、编译产物、交接记录与管理凭证来源均扫空，换角度重新列候选也没有新路；第 5 行需要用户把 PC 的原 `.env.local` 安全复制到笔记本 `D:\VectorMPEG7\PromptCut\.env.local`，不把值发进对话。随后主会话只把所需 VITE_ 键复制进忽略的构建 worktree，再从已提交 main 执行正式 release 命令，核对产物和安装，按规则重判并快进 release。正式包的路径与 SHA-256 当前尚不存在；上面的测试包只用来完成独立验收。
2. **R5 真补丁 / R7 真补丁内脚本**：PC 构建检出同步到本轮 main 后，在仓库根执行原命令 `cd desktop && npm run release -- --from-head --patch-only`，将补丁和 SHA-256 带到笔记本。基准清单只在 PC 的 desktop/release，笔记本不伪造它。用户已授权笔记本降装 0.7.13 / 外壳 0.2.6 测同一补丁，再装回本轮版本；现无真补丁，尚未降装。待测：0.2.7 几秒内干净退出、进程与锁清零、窗口位置恢复；0.2.6 约 10 秒后兜底强杀、补丁仍成功安装，最后恢复本轮版本。
3. **R6 多屏**：笔记本只有一块屏。PC 上把副屏排在主屏左边，再收起主窗口，检查两屏任何位置都没有主窗露出。现场主窗 x=-2678；实现按所有屏幕的最左边计算外侧位置，源码与 Rust 左副屏用例通过，物理双屏仍待用户。
4. **M7 W7 真跨机本轮复核**：PC 不可达，本轮本机替身的所有断言通过、fails=[]，退出 3 仅标 W7 pending。第 14 轮 m7w1002a 的 PC/笔记本证据仍在 14.1，本轮没有重新运行；按主计划 6.4 / 6.8 节列为待跨机复核，不记成退出 0，不用 PC 数字取代笔记本性能判据。历史 M8 物理断网、迁移和多端验收没有重跑：本轮任务是 A4+A5，且用户明确禁止改网络；现行本机整套命令详列 15.4.1，未把整个 probes 目录中的历史实验和辅助模块混称全跑。
5. **草稿锁政策复核**：本轮按用户决定维持回首页持锁。保留会阻止另一个实例接手 A，直到切草稿/新建/退出；改成回首页释放会允许立即接手，但返回 A 需要重新抢锁并可能被拒。此政策仍列待用户项，当前行为不改。「文件→退出」用户已明确决定保留，已落实，无需再拍板。
6. **配置恢复**：Claude Code 与 Codex 均已撤销 PromptCut 登记；最新 `node desktop/.cache/a45-install/check-registration.mjs` 为 false / false / true / true。Codex 登记后新增桌面配置另存于忽略文件 `desktop/.cache/a45-install/codex-after-unregister-before-restore.toml`，原登记前备份已逐字节恢复；备份内容从未输出或入库。

R2 / R3.1 托盘右键由本会话实际做完，没有留人手操作项。所有 R 项的图和命令输出已直接贴进对话；完整证据目录保留在集成 worktree，不因报告归档而删掉。

归档时承接的旧待定：AGENT-skill-mcp 第 8 / 10 节的二级「传统式下桌面 APP 调用被拒」及一级「软件里一键登记」表述建议仍为 dry run，未写入对应产品/用户工作流程章节；既有接入模式表已经把桌面 APP 对应到 SKILL，本轮只补实现机制。AGENT-tray 第 9 节的菜单项已由用户决定保留，防节流参数依上一主会话决定保留；标题栏 × 的无障碍名仍为「关闭」，是否改成「收到后台」未改，列为后续文案复核。本轮不展开无关 TODO。

### 15.8 三级机制说明收口解法表

卡点 1：上一任归档报告明确留下「主会话合入时写」，但机制册仍没有 A4 桌面接入和 A5 后台运行说明。尺子：`rg -n '^## 桌面 APP 接入|后台运行由外壳状态机' docs/semantics/mechanism/agent.md docs/semantics/mechanism/platforms.md` 两处均存在；逐条对照 stdio 身份、端口优先级、登记与撤销、分组限额、窗口状态机和退出代码；`node --experimental-test-module-mocks --test server/test/skill-mcp.test.mjs desktop/test/overlay-summary.test.mjs` 零失败；MSVC `cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml --lib` 零失败，现场 R1 / R3 / R4 证据不变。这是本轮真实补写与复核过程，不追写上一任未提供的搜索历史。

| # | 轮 | 层 | 父 | 候选 | 改善机制 | g | h | f | 验证 | 状态 | 结果 / 学到 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 三级 | — | 把已验证的接入与后台实现补进机制册 | 填上语义索引下的实现说明，不改变产品承诺、入口或默认行为 | 1 | 1 | 2 | 上述命令、源逐条核对、R1/R3/R4 | 已试·过 | 两处文字齐；Node 21/21、零跳过，1.72 s；Rust 27 过、0 失败、1 子入口忽略，0.02 s。Codex 多线程共享 MCP 的机制按实际代码写，未照抄「每会话起一份进程」的不准确描述 |
| 2 | 1 | 三级 | — | 只保留归档报告当机制说明 | 报告记录存在，但主机制册仍空缺 | 1 | 3 | 4 | 原机制册读取 | 关闭·剪（无机制） | 无法填补交接明确要求补写的正文位置 |
| 3 | 1 | 二级 | — | 同时写入桌面 APP 调用闸的产品表述 | 增加产品册里的可见限制表述 | 1 | 2 | 3 | 原 dry run | 待用户 | 三级第 1 行已经达成；没有升层，此处承接原报告的待定建议 |
| 4 | 1 | 一级 | — | 顺带写一键登记的用户工作流程 | 更改一级入口流程正文 | 1 | 2 | 3 | 本轮一级禁令 | 关闭·剪（禁止） | 原建议仍保留在 dry run，不在本轮自行改 |

第 1 行即达成，没有层扫空，不需要额外顾问；按用户本轮改写的流程由主会话自己核对。两处机制条目标〔裁〕并指回这一行。纯文档改动不重复整套性能验证，21 项 Node 与 27 项 Rust 是这两段说明的对应尺子，未重写测试或放宽门槛。

### 15.9 用户提供凭证包后复核 worktree 与分支

用户提示「独有改动可能在 worktree 或 branch」，并指定本机凭证 ZIP。`node out/a45-validation/audit-handoff-inputs.mjs` 退出 0：注册的 99 个 worktree 均无未提交/未跟踪改动；230 个本地与远端分支引用中，有独有提交的只剩下表 3 个远端引用。本轮已合入的 ps1-bom、draft-lock、release-no-git 及后续修复均被 main 包含。全仓连同忽略目录扫描只发现 .env.cluster，无诊断发布配置；Git 全引用历史中没有 .env* / .dev.vars* / *.env 文件 blob。审计 JSON 只含路径、提交号与键存在布尔值，不含值。

| 分支 | 独有提交 | 内容与处理 |
|---|---|---|
| origin/claude/c10-accept | 38c33fd1、9614df01 | 2026-09-28 的 C10 验收报告，保留在原支，不属于本轮发布配置 |
| origin/claude/c10-integ | 7c8ad867 | C10 探针修正的合并提交；多个 merge base 下三点 diff 的初次路径统计不作为最终独有改动清单，改用 `git diff-tree --no-commit-id --name-status -r 7c8ad867^1 7c8ad867` 核对，实际只有 AGENT-c10-site 报告和 c10-browser-probe；无发布配置或打包工具修复，保留原支 |
| origin/claude/m7-probe-exp | 8b15dfed、66fa49c2、1d2abc7c、ef4b45b7、87d3461d、1058b4ca | 2026-09-28 的就绪闸与逐拍渲染实验，涉及 StageView、stageRpc、m7NodeProbe、渲染节点引入；未顺带合入，符合本轮不展开其它 TODO 的范围 |

凭证包内存检查退出 0：4 个文件为集群环境、SSH 私钥、local.md 摘要、README。SSH 和集群凭证与本机已有副本逐字节一致；各文件均无 VITE_DIAG_SUBMIT_URL / VITE_DIAG_SUBMIT_TOKEN，附带说明也没有诊断服务内容。包内文本与凭证值未输出，未展开、未提交；附带文件只作凭证来源参考，没有当作新的工作指令。已有凭证已用于本轮 SSH 部署，它们不能替代诊断 Worker 的提交配置。正式出包仍停在 15.7 第 1 项，补充解法表为 AGENT-a45-build-config 卡点 1 第 8 行。

### 15.10 用户授权的云端配置审计

云端会话「PromptCut M5～M8 云端工作节点」只能经阿里云 HTTP 信箱通信。2026-10-02 08:55:15 UTC 的报到为 to-local #36，seenToCloudSeq=31；主会话回 to-cloud #32 receipt（ref=36），再发 #33 instruction，编号 A45-CLOUD-CONFIG-01。指令指定 origin/main 052d54784f27626289bc1d3b95d63969755c92c5、独立 worktree/分支 a45-cloud-config-audit，要求 HEAD 精确一致，仅查云端环境、忽略配置文件和独有分支提交，不改已有工作树，不提交、不推送、不写 main。报告由信箱回执替代仓库提交，遵从用户对云端的明确限制。

命令使用 main 的 `scripts/probes/probe-coord.mjs send` / `wait`，X-Mail-Token 只经 PROBE_MAIL_TOKEN 子进程环境传入；没有把令牌写进命令行、新文件、信箱正文或日志。等待状态位于仓库外 `%TEMP%/promptcut-a45-cloud-mail-state.json`，9 分钟后台长轮询；暂时错误由脚本退避重试，超时退出 3 后重挂。指令正文只含变量名和元数据输出要求；找到配置也只报告存在和路径，不通过信箱传值。

云端没有 ffmpeg，Chromium 的 WSS 升级受代理限制，因此未派纯浏览器 W7，也未关闭 TLS 校验。当前等待审计回执，结果与「收工」确认随后补记；正式出包不能将等待当作配置已经存在。
