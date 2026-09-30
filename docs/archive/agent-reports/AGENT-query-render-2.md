# AGENT-query-render-2 报告

分支 `claude/query-render-2`，worktree `.worktrees/query-render-2`，起点 main `82294fea`。

**没有改二级语义，也没有改任何语义文件。** 三级的细节按「对齐」办，标〔裁〕，列在第 6 节；对语义与计划的更正建议是 dry run，在第 9 节。

## 1. 状态

四块都做完了，已提交在本分支，等主会话审查。

- 基线：`tsc` 0 错误；`npm test` 4100 条，4098 过、0 失败、2 跳过；两个代码指纹没变。
- G0-R 全部通过：导出确定性、与 main 基准逐像素比对、快照重放、流式生产两种、预览退回两种、就绪索引、查询渲染。
- 没跑的只有一项：队列模式下认领闸的端到端探针。原因见第 7 节，认领闸只有单测覆盖。

G0-R 指改到渲染、预渲染、导出、卡片时必跑的那组附加验收，定义在 `docs/plan/Master-Execution-Plan.md` 的「G0-R 渲染附加项」。

## 2. 提交

| 提交 | 内容 |
|---|---|
| `0b3dc675` | 报告开工 |
| `9e61067b` | 功能：预渲染进程三种模式；队列模式的认领闸；单测 QR2-M-1～6、QR2-C-1～5 |
| `4c2f1e6f` | 探针：三个探针加 `PC_CHROME_ARGS` 透传 |
| `4502e304` | 文档：`r2-r7-task.md` 文末补 R7b 的 8 条更正 |
| （本报告的提交） | 报告定稿 |

## 3. 预渲染进程的三种模式（D10）

D10 是上一轮报告 `docs/archive/agent-reports/AGENT-query-render.md` 差距清单的第 10 条：同一份预渲染代码要能按 `user` / `agent` / `full` 三种模式起。

### 新模块 `server/prerender-mode.mjs`

- 提供 `PRERENDER_MODE` 常量，以及解析函数 `parsePrerenderMode`、`prerenderModeOf(env)`、`localPrerenderMode(env)`。
- `lanesOfMode` 给出每种模式建哪些 lane；`modeRefusal(mode, lane)` 给出模式不接某条 lane 时回什么错：

| 模式 | 建哪些 lane | 被拒的请求 | 回什么 |
|---|---|---|---|
| `user` | user / background / queue / stream | Agent 的查询 | `503 NO_AGENT_LANE`，`retryable: false` |
| `agent` | 只有 agent | 预渲染的各条 lane | `503 NO_PRERENDER`，`retryable: false` |
| `full` | 全部 | 无 | 和改之前完全一样 |

- 模式名和 lane 名同字不同物：代码里模式一律用 `PRERENDER_MODE` 常量，按 `cloud-task.md` I1 的要求不和 lane 混。

### `FramePipeline` 的构造参数 `mode`

缺省是 `full`；认不得的值也按 `full`。

- `laneChains` 按模式建：`user` 模式没有 `'agent'` 这条链，`agent` 模式只有 `'agent'`。
- 模式不接的请求一律当场拒，不进批处理，也不会挂住。拒绝点包括：
  - `laneRefused`，以及 `runAgentTask`、`layout`、`entityRects` 这些经它的入口；
  - `see_frames` 在规整完 lane 名之后；
  - `runQueueTask`、`acquire`、`updatePlayback`。
- `acquire('background')` 在 `agent` 模式下被拒时同时标 `cancelled`，后台那一趟照「让路」收手（I1）。
- `agent` 模式下：
  - `preload` 回 `{ skipped: 'agent' }`；
  - `streamProducer()` 回 null，不产流；
  - `prewarmUser` 不养热池；
  - `kickAgentIdle` 与 `agentSpareSlot` 只在 `full` 模式下工作。
- 只对预渲染进程生效（`interactive: true`）。编辑器进程的行为一字不变：仍回 `NO_AGENT_LANE`（`retryable: true`）或 `USE_PRERENDER`（单测 QR2-M-5）。
- 诊断回包多两项：`mode: { mode, lanes }`，以及 `scheduler.agentSpare`。

### 编辑器进程怎么拉起（`server/vite-plugin-prerender.ts`）

- 拉起时的环境变量多一项 `PROMPTCUT_PRERENDER_MODE`，取值来自 `localPrerenderMode(process.env)`：缺省 `full`〔裁 1〕，编辑器的环境里显式给了合法值就照它。
- `/api/prerender/info` 的回包多一个键 `mode`。
- `PROMPTCUT_EDITOR_URL` 三种模式都照传〔裁 2〕。

### 帧插件（`server/vite-plugin-frames.ts`）

- 按 `prerenderModeOf(process.env)` 建管线。
- `agent` 模式下：
  - 不建推送队列（`startArtifactPush`），不起本机渲染节点（`startQueueNode`）；
  - 自动渲染节点的 bind 回 `enabled: false, reason: 'prerender-mode-agent'`；
  - `/preload` 回 `200 { ok: true, skipped: 'agent', key }`，照 I1 的写法。

### `server/vision/routes.ts`

`/api/ai/visual` 失败时的回包把错误的 `code` 原样带出。这样 `agent` 模式下用户点开动图，回的是带 `NO_PRERENDER` 的 503，调用方分得清。

## 4. 队列模式的认领闸

起因是上一轮报告第 7 节第 2 条：本机节点 `maxConcurrent: 1`，`'queue'` lane 上很少同时排着两项，所以 Agent 专用实例空闲时从普通预渲染队列里接不到活。

### 节点会话（`server/render-node/session.mjs`）

- 新增选项 `claimLimit()`：此刻最多持有几项。缺省恒为 `maxConcurrent`，所以现有的调用方行为不变。
- `canClaim(task, { held })` 多一个参数，告诉它此刻的持有数，用来区分这一格是平时那一格还是多出的那一格。
- `node.hello` 报给队列的仍是 `maxConcurrent`。
- `local-node.mjs` 只是把 `claimLimit` 透传下去。

### `FramePipeline.agentSpareSlot()`

判断此刻 Agent 专用实例能不能再接一项。条件与 `kickAgentIdle` 接活的条件相同：

- `full` 模式；
- 专用实例开着，且没到空闲关闭；
- Agent 队列空，专用实例手里没有预渲染项；
- 不在播放让路期间；
- 普通预渲染队列里没有它自己能接的待办。

不看「Agent 任务之后空 1 秒」那个空档〔裁 5〕。专用实例没开时回 false，也就不为接预渲染开新实例。

### 新模块 `server/queue-agent-spare.mjs`

- `claimLimit = 1 + (专用实例能接 && 'queue' 预渲染间正在做一项 ? 1 : 0)`。
- 多出的那一格只认领这样的任务：
  - 快照细任务。plan 不接；轨道流也不接，因为流用流预渲染间池，多认领一项流任务等于多开一个流 Chrome。
  - 和执行器手里在做的快照不是同一张卡。互斥口径与管线的 `tag` 相同：共享档按 `contentKey`，本地档按 `entryKey`。
- `wrap(executor)` 记下执行器手里在做哪些快照，做完摘掉。

`startQueueNode` 接上了这三样；队列节点的诊断回包多一项 `spare`。

### 为什么不会认领到做不完的活

- **租约与上报**：多认领的那一项和普通认领一样由会话续约、由执行编排上报进度。
- **排在哪、等多久**：它在管线里照旧经 `runQueueTask` 排进普通预渲染队列，由 `kickAgentIdle` 交给专用实例。如果专用实例在它到手前被 Agent 任务占了，它就等 `'queue'` 预渲染间手里那一项做完，至多等一项〔裁 6〕。
- **不开新 Chrome**：认领时 `'queue'` 预渲染间正在做事，这一项不会让管线新开 Chrome。
- **卡片锁与结果上报**：走原来的执行路径，没改。

### 顺序保证

「Agent 任务永远不排在排队中的预渲染任务后面」由现有的 `kickAgentIdle` 保证：一次只接一项，并且只在 Agent 队列空时接。认领闸只改节点能持有几项，不改这条规则。单测 QR2-C-4 核对了顺序：专用实例上多认领的 B 做完，接着就是 Agent 任务 X，排在队列里等着的 C 在 X 之后。

## 5. 探针取证与 R7b 遗留

### `PC_CHROME_ARGS` 透传

`scripts/probes/online-user-cards-probe.mjs`、`desktop-auto-node-probe.mjs`、`c10-ui-probe.mjs` 三个探针原来都没有，现在都有了。

- 写法照 `online-stage-watch-probe.mjs`：只把参数原样拼进 Chrome 的启动参数。
- 文件头写了用途：例如用 `--log-net-log=<文件>` 抓网络日志，给「探针新开的页面偶发 120～180 s 打不开在线页」取证。也写明不要用它关 TLS 校验。
- 三个文件 `node --check` 通过。这三个探针没有实际跑。

### R7b 的 8 条更正

R7b 是 R7 之后修「六条必修」的那一轮分支，报告在 `docs/archive/restructure_planning/reports/r7b-report.md`。

- 第 4 节的 8 条已折回 `docs/archive/restructure_planning/r2-r7-task.md`，放在文末新加的一节「2026-09-30 按 R7b 报告补的更正」，正文一字未删。
- 逐条对过代码，和报告不一致的以代码为准。
  - 第 1 条：`prerenderPicked` 现在不止四个消费点，有十来个。
  - 第 7 条：R7b 说的文档已搬到 `docs/archive/topics/`，`make-fixture.mjs` 仍不在仓库里。
- 这个文件含一个字面的 NUL 字节，而且是 CRLF 换行。追加时按字节处理，没动原有内容。

## 6. 〔裁〕

1. **「本机有 Agent」按代码现状判，缺省 `full`。**
   - 依据：编辑器进程的插件表（`vite.config.ts`）总是挂着 `vite-plugin-ai`，本机 Agent 的服务端工具就在编辑器进程里，桌面版和 dev server 都一样。
   - 显式的 `PROMPTCUT_PRERENDER_MODE` 可以覆盖，用于排障和验收。
   - 所以现有用户看不出任何区别；实测 5930 这台上 `/api/prerender/info` 回 `mode: "full"`。
   - 没有新增「关掉本机 Agent」的开关。
2. **本机拉起的 `agent` 模式仍传 `PROMPTCUT_EDITOR_URL`。**
   - 计划 I1、I4(a) 写的是 `agent` 模式不传，因为项目应由 Agent 服务端推（I2）。
   - 但 I2 的推送还没有做：今天本机 Agent 的查询只带 `{session, localRev}`，靠这个地址回拉项目。素材服务的基址（`asset-client.ts` 的 `assetServiceOrigin`）也还是这个地址。
   - 不传的话，本机的 `agent` 模式一张图都查不出来。等 I2 与 I3 落地再按计划去掉，代码注释里写了。
3. **模式不接时回什么。**
   - `user` 模式收到 Agent 的查询：回 `503 NO_AGENT_LANE`。沿用编辑器进程的码，调用方已经认它；但标 `retryable: false`，因为模式在进程启动时定下，重试也还是这个进程。
   - `agent` 模式收到预渲染请求：新增码 `503 NO_PRERENDER`，`retryable: false`。
   - `/preload` 不报错，回 `200 skipped`，照 I1 的写法。
4. **`agent` 模式不当渲染节点。** 不建推送队列，自动渲染节点的 bind 回 `enabled: false`。依据是语义「预渲染进程做 User 或 Full 模式时同时是一个渲染节点」，`agent` 模式不在其列。
5. **认领闸多出的那一格：**
   - 只在两个条件同时成立时开：`'queue'` 预渲染间在忙，专用实例能接。`'queue'` 空着时多认领的一项会落在它上面，等于多开一个实例。
   - 只接快照，不接同一张卡的。
   - 不看 1 秒空档：认领要一个来回，到手时空档多半已过；没过的话 `kickAgentIdle` 自己等到点再接。
   - 独立渲染主机（`host.mjs`）不加：现有部署下 Agent 的查询打的是用户本机的预渲染进程，不打独立渲染主机，主机上的专用实例基本不会开着。
6. **等待上界。** 多认领的那一项到手时，专用实例如果已被 Agent 任务占了，它就在普通预渲染队列里等 `'queue'` 预渲染间手里那一项做完。
   - 队列的停滞收回是开工报过进度之后 120 s 没有进展，而快照细任务一段是 60 帧。按上一轮实测一批 4 帧约 2.4～2.8 s 推算，一段约 40 s，一般到不了 120 s。
   - 碰上极慢的卡会被当停滞收回、交给别人重做。结果不会错，只是白认领一次。
   - 没有为此加「逐项让回」的机制。要加，得给会话和执行编排加按 id 放回的接口，改动面大。

## 7. 验证

每条命令都在本 worktree 里跑，PATH 里加了 ffmpeg。dev server 都带 `PROMPTCUT_NO_PORT_FILE=1`，端口只用了 5930～5944；跑完我自己按进程树结束了它们。

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0 |
| 全量测试 | `npm test` | tests 4100 / pass 4098 / fail 0 / skipped 2，退出码 0 |
| 新单测 | `node --experimental-test-module-mocks --test server/test/query-render-2.test.mjs` | 11 / 11 通过 |
| 相关旧单测 | `query-render`、`agent-lane`、`render-node-session` | 60 / 60 通过 |
| 代码指纹 | `node -e 'import("./server/frame-code.mjs")…'` | `00a5264bf8a062ff6e0b5ed0516cccd1 86e443cb6fa838aef64788af6822fd68`，不变 |
| 导出确定性 | 5930 这台，`node scripts/verify-determinism.mjs --url "http://127.0.0.1:5930/?export=1"` | Identical 1800 / Different 0，退出码 0 |
| 与 main 基准逐像素 | 自写比较脚本（放在 `out/`，被 gitignore），对 `.worktrees/main-g0r/out/verify-a/frames` 与本分支的 `out/verify-a/frames` 逐帧解码比 RGBA | baseline 1800、candidate 1800、same 1800、diff 0、missing 0 |
| 快照重放一致 | `PC_FRAME_TEST_URL=http://127.0.0.1:5930 node scripts/verify-unified-frames.mjs` | PASS，退出码 0 |
| 流式生产 | `stream-produce-probe.mjs --origin …5930`，另跑一遍加 `--group` | 两种都 PASS，`fails: []`，退出码 0 |
| 预览退回 | `preview-fallback-probe.mjs --origin …5930`，另跑一遍加 `--page-preload` | 两种都 PASS，`transparentBeats: 0`，`pageErrors: []`，`fails: []`；taskP90 为 33.1 / 31.3 ms |
| 就绪索引 | `ready-index-probe.mjs --port 5933` | `fails: []`，退出码 0 |
| 查询渲染 | `query-render-probe.mjs --port 5936` | `fails: []`，退出码 0 |

查询渲染探针的明细：

- 用户点开的动图走 `preview@queue`。
- 模型的查询走 `agent@agent`，Agent 任务的等待为 `[3358, 0]` ms。
- 专用实例空闲时接了后台那一趟的卡批，`card-batch@agent` 共 39 批。
- 那一趟结束时 `status: ready`。

G0-R 中带耗时门槛的只有流式生产的编码耗时，这次的 `encodeMs` p50 为 41 ms。当时机器上还有别的子 Agent 在跑，这个数只作参考，需在笔记本上复核。

### 模式的真进程冒烟

另起了两台 dev server，用 `PROMPTCUT_PRERENDER_MODE` 分别指定 `user` 和 `agent`，脚本放在临时目录。每台对同一个空项目打四个请求：

| 请求 | `user` 模式（5939） | `agent` 模式（5942） |
|---|---|---|
| `/api/prerender/info` | `mode: "user"` | `mode: "agent"` |
| `/api/cards/layout`（经编辑器进程转发） | 503 `NO_AGENT_LANE`，579 ms | 200 |
| `/api/frames/preload` | 200 | 200 `skipped: "agent"`，19 ms |
| `/api/frames/see`，user lane | 被接受（见下） | 503 `NO_PRERENDER`，18 ms |
| `/api/frames/see`，agent lane | 503 `NO_AGENT_LANE`，4 ms | 200，1 帧 |
| 诊断里的 lane | `["user","background","queue","stream"]` | `["agent"]` |

`user` 模式下 user lane 的那次请求回了 504 `FRAME_TIMEOUT`：它被接受了，但老路的热池 Chrome 冷启动加上机器负载超过了 10 s。这是整帧老路本身的超时，和模式无关。

### 没跑的

- **认领闸的端到端探针（队列模式）。**
  - 要跑，得起本机文档服务，开 `PROMPTCUT_QUEUE_NODE=1`，发布 plan，还要让专用实例先开着，现成探针里没有这个组合。
  - 现在的证据只有单测 QR2-C-1～5，以及单测里的管线整合用例 QR2-C-4。
  - 建议主会话合流时在 `queue-mode-probe` 或 `query-render-probe` 里加一步：先让 Agent 用一下专用实例，再看诊断里 `queue.spare` 与 `scheduler.counts["queue@agent"]`。
- 三个加了 `PC_CHROME_ARGS` 的探针没有实际跑，只做了语法检查。
- 云端 `agent` 模式、拆分模式（I4(d)）、按角色路由（I4(c)）都不在本任务范围。

## 8. legacy 整帧通道的调查与 dry run（R7b 第 5 节第 2 条）

R7b 留下的问题是「渲染 9 只停了快照、没停 PNG」。渲染 9 指：不在预渲染集合里的卡不产快照、不产流。

调查用了一个只读的检索子 Agent；关键几处我自己抽查过（`fillCardControls` 定档那一段，`Preview.tsx` 与 `previewMode.ts` 的挂载条件）。行号相对本分支。**我没有删任何东西。**

### 8.1 结论

「legacy 整帧通道」不是只服务 `?preview=legacy` 的死代码。它的四块存储也是 Agent 查询渲染的料和缓存：

- 逐卡的 PNG 与 MOV：`entry.cardCache`，落在 `controls/<key>/mov/`；
- 整场景的逐帧 PNG：`entry.mov`；
- 整场景的 HTML 帧：`entry.html`，落盘为 `html-manifest.json`；
- `frames/`、`tracks/` 下的 PNG。

真正只服务旧页面的，是整帧预览的前后两端：页面侧的 `UnifiedPreview` 与 `MovPlayer`，服务端的 `userPool`、`acquireUser`、`FramePlayback`、`PlaybackMovStore`。

### 8.2 逐块

| 块 | 谁产 | 在用的消费方（非 legacy） | 只给 legacy 或没人用的部分 |
|---|---|---|---|
| `entry.cardCache` | `fillCardControls` 逐帧写（`frame-pipeline.mjs:2688`），收尾编 `full.mov`（`:2730`）。判轻的卡照样渲全部 PNG：`:2567` 只把快照档记成 `'none'`，注释写明是为了 legacy 不缺料。队列细任务同样写；远端拉取 `applyPngFrames`（`artifact-transfer.mjs:955`）也写 | `readFramesCore` 经 `cardRender`、`renderState`，把 `/api/frames/control/<key>/<n>` 的缓存图装进渲染页。所有 lane 都用：Agent 的 `see_frames`、`get_gif`、`bake_card`、3D 视图贴图、AI 栏操作预览。另外它的 `hasComplete` 是「这张卡还要不要渲」的判据 | user / playback lane 的占位判断（`:1194`）；快照清单里附带的 `pngs` |
| `entry.html`（`html-manifest.json`） | 后台那一趟的 B 趟；`renderMovFrames`、`layoutNow`、`entityRectsNow`、`/import` | Agent 用 HTML 重放帧（`:1227-1246`）；`get_layout`（`layoutNow`）；`see_frames` 附带的实体框；**保存草稿与打开 .proc**（`drafts.ts:47`、`proc.ts:106/163`，经 `/archive`、`/import`）；**`record()` 顺手写的新快照库**：转场卡（`sourceDependent`）不走队列，它们的快照只由整场景路产 | `UnifiedPreview` 的 `collectSnapshots` |
| `entry.mov`，以及 `frames/`、`tracks/` 下的 PNG | `readFramesCore`（所有 lane）、`fillRequiredScene`、`fillMov` | `readFramesCore` 第一步查它（Agent 因此拿到 `source: 'mov'`），渲完的结果也从它取，是结构性依赖；`verify-unified-frames.mjs` 断言 `source === 'mov'` | `full.mov` 只被用来判断文件在不在，没有人读内容；`FramePlayback` 的 `cached` |
| `preview.mp4`（`prerender()` 里 `frameVideo` 产） | 后台那一趟的最后一步 | **没有消费方**。`src/` 里出现的 `preview.mp4` 都是导出产物的同名文件 | 整块 |
| `userPool`、`acquireUser`、`updatePlayback`、`FramePlayback`、`PlaybackMovStore` | `/see` 的 user lane、`/playback` | 无 | 整块。另有一个副作用：`/playback` 会 `yieldBackground`，掐掉新通道的后台代次 |
| `?preview=legacy` 页面（`UnifiedPreview` 加 `MovPlayer`） | — | — | 除了显式 `?preview=legacy`，**舞台端口起不来时自动退回这里**（`Preview.tsx:2037` 的 `!live`，`previewMode.ts:65-67`、`:91`）。现实中有两种情况：桌面版的舞台端口被占（`desktop/src-tauri/src/lib.rs:318-343` 只弹提示「退回同源单舞台」），以及 `vite preview` 的产物（舞台端口插件 `apply: "serve"`）。在线页面不会进 |

导出（成片）不是这些块的消费者：导出是另起的子进程，自己开浏览器渲。`frame-pipeline.mjs:1503`、`:1756` 注释里写的「导出用」已经过时。

新通道和它之间还有一处时间上的耦合：双舞台页每 2 秒问一次 `/status`，直到 `ready`；而 `ready` 要等 `fillMov` 和 `prerender`（产 `preview.mp4`）都做完。这两步出错会让整趟下一次重跑。

### 8.3 dry run：删不删、删了影响谁（由主会话与用户定）

| 方案 | 删什么 | 影响谁 | 风险与代价 |
|---|---|---|---|
| A. 什么都不删（现状） | — | — | 判轻的卡照样整卡渲 PNG；后台那一趟多跑 `fillMov` 与 `preview.mp4` |
| B. 只删没人用的产物 | `prerender()` 产 `preview.mp4`；`fillMov` 编的 `full.mov`（只判存在，没人读内容） | 没有用户可见的影响；`ready` 更早到 | 要改 `ready` 的判据，以及 `/status` 回包里的 `video`、`mov` 两个字段；`verify-unified-frames` 要核一遍。改动小 |
| C. 停判轻卡的 PNG（R7b 想要的「省 CPU」） | `fillCardControls` 对 `prerenderPicked` 为假的卡整卡跳过 | Agent 看判轻卡时没有缓存图，每次当场渲（慢一些，结果不变）；legacy 页面与端口回退时判轻卡缺料 | 要先定端口回退时 legacy 页面缺料怎么办（改成透明或占位，属于一级、二级的用户可见行为，得用户定）；还要改 `hasComplete` 判据与清单的 `pngs` |
| D. 删整帧预览这条老路 | `UnifiedPreview`、`MovPlayer`、`userPool`、`acquireUser`、`FramePlayback`、`PlaybackMovStore`、`/playback`、`/see` 的 user lane、`?preview=legacy` | **舞台端口被占的桌面用户与 `vite preview` 的产物**会失去预览，得先给端口回退一个新去处（例如单舞台的 live 变体，在线页面已有 `singleLiveStage`）；R7 回滚开关随之消失 | 删用户看得见的功能，按一级办：主会话、用户定。受影响的测试有 `frame-playback`、`frame-user-watchdog`、`legacy-preview-target` 等，脚本有 `verify-playback*`、`verify-preview-window`，探针有 `editor-preview-smoke --legacy` |
| E. 连 `entry.html`、`entry.mov`、B 趟一起删 | 整条整帧通道 | Agent 的 `see_frames`、`get_layout`、实体框要换一套料；草稿与 .proc 里的快照变空；**转场卡除锚帧外不再有快照，新通道也受影响** | 不建议，除非先把这些消费方迁走 |

我的建议：B 可以另开一个小任务直接做；C、D 要先由用户定端口回退时的行为；E 不做。

## 9. 更正建议（dry run，没改任何文件）

### 9.1 `docs/semantics/mechanism/rendering.md`「查询渲染与预渲染进程」（三级）

修改前（第 106～109 行，三种模式）：

> - 预渲染进程有三种模式：
>   - **Agent 模式**（本机只有 Agent）：不预渲染，只按 Agent 的要求渲染精确的某一帧。
>   - **User 模式**（本机只有用户在编辑）：只预渲染重卡。
>   - **Full 模式**（两者都在本机）：优先 Agent 的查询，其次预渲染。

修改后（原文不动，在三种模式之后加一条）：

> - 用户机上缺省一个预渲染进程，以 Full 模式起（编辑器进程里总有本机 Agent）；模式在进程启动时定下。模式不接的请求当场回错、不排队：User 模式收到 Agent 的查询回「没有 Agent lane」，Agent 模式收到预渲染请求回「不做预渲染」，预加载请求回「跳过」。Agent 模式不当渲染节点。

「Agent 优先只是插队」那几条之后，再加一条：

> - 本机渲染节点在 Agent 专用实例开着且空闲、专做队列任务的那个实例正做着一项时，多认领一项快照任务交给专用实例；不是同一张卡、不认领轨道流。专用实例没开时不多认领。

### 9.2 `docs/plan/cloud-task.md`

- I4 前的实现注，把「(a) 的三种模式还没做」改成：「(a) 已做（`claude/query-render-2`），缺省 `full`，`agent` 模式暂仍传 `PROMPTCUT_EDITOR_URL`，等 I2 与 I3；(c)、(d) 没做」。
- I1 的「`agent` 模式不传 `PROMPTCUT_EDITOR_URL`」后面加一句：「以 I2 的推送与 I3 的素材服务地址落地为前提」。

### 9.3 `docs/plan/TODO.md`

- 「查询渲染」一条：D10 与队列模式的认领闸合入后划掉。剩下的是：锚帧等整段任务不可拆借；认领闸的端到端探针；独立渲染主机的多认领（现有部署下用不上）。
- 「偶发：探针里新开的页面打不开在线页」一条：补一句「三个探针已可用 `PC_CHROME_ARGS=--log-net-log=<文件>` 取证」。
- 新增一条「legacy 整帧通道：见 AGENT-query-render-2 第 8 节 dry run，待定」。

## 10. 需要主会话决定的事

1. 审本分支的 diff，决定合并、返工还是放弃。合 main 须按原则 4 先得到用户授权。
2. 〔裁 1〕～〔裁 6〕是否认可。尤其是〔裁 2〕：`agent` 模式暂仍传 `PROMPTCUT_EDITOR_URL`，和计划写的不一样。
3. 认领闸的端到端探针：是在合流时补，还是另开任务。
4. 第 8.3 节 legacy 整帧通道的方案：B 是否另开小任务；C、D 要不要拿给用户定。
5. 第 9 节的语义与计划更正是否采纳。
6. 流式生产的编码耗时需在笔记本上复核。

## 主会话审查（2026-09-30，笔记本主会话）

- 审过 `server/prerender-mode.mjs` 与 `FramePipeline` 按模式建 lane、各入口当场拒绝不排队；编辑器进程缺省拉起 `full`（现有用户看不出区别）；认领闸只在专用实例开着且空闲时多认领一项快照任务，不接 plan、轨道流与同一张卡。6 条〔裁〕照留（含 `agent` 模式暂仍传 `PROMPTCUT_EDITOR_URL`，等 `cloud-task.md` I2、I3），待用户审。
- 采纳第 9 节：`mechanism/rendering.md` 补两条（三级〔裁〕）、`cloud-task.md` I4 实现注与 I1 前提、TODO 的「查询渲染」「偶发的探针页面」「legacy 整帧通道」「R7b」几条（`cd37c8ed`）。
- 主会话在 `claude/r6-merge` 上、笔记本上重跑 G0-R：确定性 1800 / 1800、与 main `701a27c0` 逐像素 1800 相同、快照重放 PASS、流式生产两种（编码 p50 287 ms，门槛 300 ms，这一跑时用户的屏保占着约 80% CPU）、预览退回两种、就绪索引、`query-render-probe` 全过；三个加了 Chrome 参数透传的探针（在线用户卡、桌面自动节点、C10 界面）都照常过。认领闸的队列模式端到端探针没有，记进 TODO。
- legacy 整帧通道的五个方案列给用户：B 可另开小任务；C、D 要用户定；E 不做。合入 main `8237849f`。

- 〔2026-09-30 补注〕〔裁 6〕（Agent 任务不打断专用实例手里那一项、至多等一项）已被 `claude/maint-3` 第 5 项取代：专用实例上的队列任务按批（4 帧）给 Agent 让路，见 `AGENT-maint-3.md`。
