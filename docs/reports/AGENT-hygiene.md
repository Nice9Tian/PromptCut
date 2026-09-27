# AGENT-hygiene 报告

分支 `claude/hygiene`，worktree `.worktrees/hygiene`，基于 main a038948。任务：M8 之前的一批卫生类遗留，共六项，每项一个提交。端口只用了 5620～5625（tiers-probe 实跑）和端口 0。

## 提交

| 项 | 提交 | 内容 |
|---|---|---|
| 1 | d1352ff | 测试起 Vite 中间件时加 `server.ws: false` |
| 2 | 319c768 | 四个手动脚本必须显式给地址 |
| 3 | a1da2bc | 旧词统一 |
| 4 | 99cdc77 | 修掉断开的 `AGENT-c6-4-pipeline.md` 引用 |
| 5 | 1f2df29 | tiers-probe 先等遮罩出现、再等它退下 |
| 6 | f433030 | c10a-demo-probe：导航计数只算整页导航；第 3 步逐帧核两档 |

## 1. HMR 端口告警

- 原因：这些测试其实都已经写了 `hmr: false`。但在 Vite 8.2.2 里，`hmr: false` 只关 HMR，WebSocket 服务照样起、缺省占 24678；要写 `server.ws: false` 才不起（`node_modules/vite/dist/node/chunks/node.js` 的 `config.server.ws === false` 分支）。
- 改法：12 处 `hmr: false, watch: null` 都改成 `hmr: false, ws: false, watch: null`。改到的文件：`src/` 下 7 个 `.test.mjs`，`server/test/` 下的 `agent-c65*`（3 个）、`session-link-page`、`c65b-kit.mjs`。
- 告警行数（`grep -c 24678`）：改前 **8 行**，改后 **0 行**。任务书写的是约 17 行，这次基线实测是 8 行，可能随并行调度变化。

## 2. 缺省连 5190～5192 的手动脚本

- `scripts/io-check.mjs`、`scripts/timeline-verify.mjs`：地址从 `--url <地址>` 或 `PROMPTCUT_BASE` 取，两样都没有就打用法、`exit 2`。
- `scripts/catalog-notes.mjs sheets`：地址从 `--url` 或 `PROMPTCUT_BASE` 取（后者会自动补上 `/?export=1`），都没有就打用法、`exit 2`。文件头示例也改掉了。
- `server/test/cli-setup-ui.mjs`：要 `BASE` 环境变量，没有就打用法、`exit 2`。
- 实测：四个脚本不给地址都打出用法、退出码 2；`io-check --url` 后面不跟值也是退出码 2。
- **过失**：第一次批量改时，替换脚本（python）在本机不存在，改动根本没落地。我没先检查退出码，就接着跑了「不给地址」的检查，结果 `io-check`、`timeline-verify`、`cli-setup-ui`、`catalog-notes` 各对 5190 或 5192 发了一次 GET，全部 `ERR_CONNECTION_REFUSED`（端口上没有服务），没有写请求。挂住的进程我结束了，只是我自己起的那几个；也查过，没有留下孤立的 puppeteer Chrome。之后改用 Edit 重做，并用 `&&` 串起检查。
- 没改的：`scripts/archive/export-frames-virtual-time.mjs` 是归档的库代码，不会被运行；`server/bakery/chrome.mjs` 的 `DEFAULT_URL`（5190）是产品代码，不是手动脚本，所有正式调用方都显式传了 `url`。它要不要去掉，由主会话定。

## 3. 用词

- 范围：注释与文档，以及测试名、断言说明、探针检查项、日志与报错里的字。代码标识符不改。`src/editor` 里没有界面文案含旧词（TopBar 那处是注释）。
- 规则：`素材(的)?原片 → 素材$1原尺寸`，其余 `原片 → 素材原尺寸`；`小版 → 素材小尺寸`，排除「最小版」和「小版本」。「冻结」「烘焙」按上下文逐条换成「生成快照」「生成的快照」「预渲染」；`c10a-research.md` 里 Page Lifecycle 的「可冻结任务」写成「可挂起的任务」。
- 意思不是档位的「原片」按意思换：`ytdl.py` 里的「原文件」，GraphCard 里的「原素材 + 滤镜」，`project.ts`、`mediaSync.ts`、`mediaSync.test.mjs` 里的「源文件里不连续」。
- 保留原样的：`glossary.md` 和主执行计划里定义旧词的那两行，`glossary.md`、`constraints.md` 的用词规则，测试夹具的文件名「访谈原片.mp4」。`mediaTier.ts` 里那句「代码注释暂未统一」改成了「都用新词」。
- 没动 `docs/reports/`、`docs/archive/`（历史记录）。`docs/reports/` 里还剩旧词的报告，要改的话等它们归档前由主会话定。
- 规模：59 个文件，330 行增、330 行删，没有整文件换行符变动。

## 4. 断开的引用

`server/vite-plugin-frames.ts` 第 52 行原来指向 `docs/reports/AGENT-c6-4-pipeline.md`，现在改指现存的 `docs/reports/REPORT-c6-4.md`。这份报告以后如果归档，路径要跟着改。

## 5. tiers-probe 的测量时机

- 原来等「iframe ≥ 2 且没有测量遮罩」。改成：先等 iframe ≥ 2；再等测量开始，即遮罩 `[data-pc="probe-gate"]` 出现，或者在页面里 `import('/src/editor/probeRunner.ts')` 读到的 `probeProgress().running` 为真；最后等遮罩退下且不再 running。
- 30 s 内测量都没开始（项目里没有要测的卡），就照常往下走，不算失败。结果里记 `out.probeGate`：`shown-then-gone` 或 `never-shown`。
- 判据没动。
- 实跑一轮：`node scripts/probes/tiers-probe.mjs --port-a 5620 --port-r 5623`，退出码 0，`ok: true`，`probeGate: "shown-then-gone"`，`fails: []`。T4 上传窗口 2497 ms、21 次编辑，长任务 0；对照窗口长任务 0。这是在 PC 上跑的，而且机器正忙，耗时数字不作数，只证明新的等待逻辑能走通。跑完 5620～5625 都空了。

## 6. c10a-demo-probe

- **第 3 步「整段重渲完成」**：要求帧齐的判据，main 上 ad77330 已经加了（`frames === count && smallCount === frames`），比 `AGENT-c10a-r2.md` 写的时候新。这次又补了 `missingSmall.length === 0`，逐帧核新键下每一帧都有小尺寸。
- **导航计数**：puppeteer 的 `framenavigated` 遇到同页跳转也会触发。改成另开一个 CDP 会话，听 `Page.frameNavigated`（只在换文档时发，只算顶层框架）；同页跳转听 `Page.navigatedWithinDocument`，另记 `sameDocNavs`，并放进 `out.creatorPage`。
- 用一个临时小脚本验证过这个口径：本地起一个 HTTP 服务（端口 0），依次做 `goto #invite=…`、`replaceState` 清 hash、改 hash、`reload`。puppeteer 计 4 次，新口径计整页 2 次、同页 2 次。临时脚本已删。
- 没实跑整份 c10a-demo-probe：它要起四个服务、整段重渲最长等 15 分钟，而且 PC 正被十来个子智能体占着。改动只涉及计数方式和一个更严的等待条件，建议下次演示复核时顺带跑。

## 验证

- `npx tsc -b --force`：退出码 0，零错误。
- `npm test`：退出码 0；tests 3410、pass 3408、fail 0、skipped 2。改前基线也是这组数字。
- 24678 告警：改前 8 行，改后 0 行。
- `node --check`：本分支改过的 12 个 `.mjs` 脚本和探针都通过。
- 没跑导出确定性、导出与快照重放一致两项：没有改渲染、导出、快照代码，只改了注释、字符串和探针。

## 给主会话的建议

1. `server/bakery/chrome.mjs` 的 `DEFAULT_URL = 5190`：可以考虑也改成缺省报错。它是产品代码，不在这次的范围里。
2. `docs/reports/` 下的报告里还有旧词和「冻结」，归档时要不要统一，由主会话定。
