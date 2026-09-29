# M8 之后的推进报告（PC 主会话，2026-09-29 起）

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
