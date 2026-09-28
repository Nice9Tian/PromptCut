# AGENT 报告：claude/rq-m7-node

M7（纯浏览器当渲染节点）的页面与舞台一侧，契约 `docs/plan/m7-contract.md` 第 1 版第 9 节 `claude/rq-m7-node` 行，按第 13 节主会话裁定（下称「裁定」）与其后「探针之后的更正」十条。起点 `claude/c10-integ`（24c2c57），合入 `claude/rq-m7-tests`（8f18461）与 `claude/rq-m7-queue`（fdbeb60，主会话通知后合入）。端口 5440～5449。

状态：实现与本机验证做完，待主会话审。

代号说明：D1～D18 是契约第 11 节的待定点（裁定见第 13 节）；K10、K11 是契约测试 `server/test/m7-kit.mjs` 文件头对实现形状的第 10、11 条假设；M7-A1～A12 是契约第 10 节的验收项；P1～P6 是第 8 节的可行性探针（结果见 `claude/m7-probe` 的 `AGENT-m7-probe.md`，已归档 `docs/archive/agent-reports/AGENT-m7-probe.md`）；A-1～A-9 是验收探针 `claude/m7-accept-probe` 的适配处 `scripts/probes/m7-node-adapter.mjs` 对页面诊断形状的假设。

## 做了什么

| 块 | 文件 | 内容 |
|---|---|---|
| 当节点的条件与编排（K10、K11） | `src/online/browserNode.ts` | `browserNodeEligibility`（在线构建、嵌了代码版本 D16、普通档、双舞台握上手、Chromium D14、成员、测量落定，回 `{ ok, reason }`）；`createBrowserNode(deps)`：会话用 `server/render-node/session.mjs`，细任务的执行规矩（先报 0、去重、推完才完成、丢认领丢结果）用队列分支抽出的同构 `server/render-node/task-runner.mjs`（D11 a），本页只在它的 `render` 里管逐帧与让路。节点描述带 `userId`（规则 0）；`node.hello` 自己带原始 `environment`、`profile: 'browser'`、`maxConcurrent: 1`，去掉自报的指纹；`node.welcome` 回的指纹记下并交宿主；watch 只列本项目；报到被拒（`forbidden` / `not-chromium` / `bad-message`）就不再当节点。D6：先用发布时留存的那一版，没有再取快照，都没有放回 `no-snapshot`。D8：`play` / `drag` / `urgent` 当前帧做完放回（还在取项目时立即放回；全段已齐只剩收尾时照常完成），`hidden` 立即放回并中止当前帧。已做的帧按任务 id 留着，重新认领同一段只补缺的帧。`debug()` 见「诊断形状」 |
| 宿主（第 2、4、5、7 节） | `src/editor/browserNodeHost.ts` | 每 250 ms 判资格（「打开项目的测量已落定」按项目记住，之后补测新卡不下线）；成立就开 render 连接（页面连接上现签 `auth.ticket { kind:'conn', role:'render', owner:{ kind:'browser' } }`，子协议 `promptcut.ticket.<票据>`，会话层 `createDocEndpoint`，`onOpen` 里报到）；不成立、4003 / 4004、报到被拒就放回全部、结束会话、不重连。`isIdle()`：后台活的门开着、不在播放 / 拖动、离上一次交互过了 500 ms、单飞队列里没有更急的活、有后台舞台。让路来源：store 的 `playing`、`subscribeScrub`、`visibilitychange` 与 `backWorkGate` 的 `hidden` / `raf-gap`、单飞 `bake` 活的 abort、`freeze`（再尽力放回一次）；`resume` 一律当重连（结束会话、马上重建、重新报到）。一帧：单飞队列里开最不急的 `bake` 活，`pushProject('back', 隔离单卡工程, { reset })`（走 stageBridge 的基线），`bakeFrame` RPC，收 `bake-frame` 事件 → 解压 → 推 `snap` 与 `px`（D7 父页推，rw 票据缓存、到 2/3 寿命换）→ 块进页面内快照库、这一层 `ranges` 写这一帧。全段齐后组清单、`content.put`（失败只记诊断）。去重：内容库清单在、覆盖整段、两档齐、每块在素材服务上 complete。取项目快照经 render 连接收分片、WebCrypto 核摘要。D6 留存最多 4 版 |
| 生成快照 RPC（D3，第 4.3 节） | `src/render/stageRpc.ts`、`src/StageView.tsx` | 新 RPC `bakeFrame({ session, clipId, localFrame, mode, small })` 与 `bakeCancel()`；新事件 `bake-frame`（字节随消息转移，只认后台舞台）。舞台里：缺省逐帧顺推（`seq`，接不上才从头推），也支持 `batch4`；帧间让一个宏任务、查后台活的门（挡住的时长记 `pausedMs`，不算耗时）；不受一拍预算截断；每帧先过就绪闸（照 `waitFrameReady`：控件异步活、字体、图片，等待中照常 tick；控件报错或 20 s 不就绪回 `not-ready`，这一段失败、不出空白帧）；取本控件 HTML，`lossy` → `lossy`（不可重试），本地帧号对不上 → `frame-mismatch`；sha256 用 WebCrypto 在舞台里算。`setRole('back', { job: 'bake' })` 只在在线构建里接受。回包超时 120 s。`__pcStageDiag().bake`：帧数、逐帧耗时 p50 / p95、`pausedMs`、从头推次数、小尺寸耗时、没成的原因计数 |
| 小尺寸（D5 a，第 4.4 节） | `src/render/bakeSmall.ts` | 快照 HTML 按桌面同一道清洗、放进框大小整体 `scale(s)` 的盒子，**连同舞台页的全局样式表**包进 SVG `foreignObject`，`data:` 地址画上透明画布，`toBlob('image/webp', 0.8)`；尺寸换算与 `server/bakery/small-bitmap.mjs` 对拍 |
| 单飞队列 | `src/editor/stageJobs.ts` | 第四种活 `bake`，最不急（补跑 > 测量 > 探针 > 生成快照）；`urgentBackJobs()` 给闲的判据用 |
| 隔离单卡工程共用（主会话指派） | `src/kernel/isolatedCard.mjs`（+ `.d.mts`）、`server/frame-pipeline.mjs` | 函数原样挪进 kernel 的纯 .mjs（不引任何模块），桌面 `FramePipeline#isolatedCardProject` 改成调它，行为不变 |
| 清单与 bake 参数 | `src/online/bakeTask.ts` | `bakeInputOf`、`snapshotManifest`（形状同 `collectSnapshotResult`，≤ 256 KiB）、`manifestKey`、`manifestCovers`（去重判据：两档都齐）、`manifestBlocks` |
| 上传器（D7，更正第 8 条） | `src/online/snapUploader.ts` | `chunks` 对账 → 缺的片 `PUT` → `complete`；已 complete 的跳过；同一哈希单飞；收尾回 `400 incomplete` 先重查 chunks、补传一次；401 强制换票据重试一次 |
| 清单计划等节点报到（主会话第 3 条） | `src/online/planPublisher.ts`、`src/editor/Preview.tsx` | 本页当节点时这一版等报到完再发，最多 3 s；`onPublish` 发之前交出这一版供 D6 留存。计划不写浏览器意向（见「与契约不一致」第 1 条） |
| 层表 v3 的候选认定（D12 页面侧） | `src/render/snapshotSource.ts` | 在线来源按 `task.done`（活）与 `task.failed { error: 'superseded' }`（另一份活着，不是失败）认定候选，整层换成活着的那一个（用队列分支的 `layerRefOf(..., { alive })`）；本页完成一段时 `markAlive` |
| 节点规则（更正第 3、6 条） | `server/render-node/filter.mjs`、`server/render-node/split.mjs` | 规则 7 加 `canvas-heavy`（纯浏览器不收画布卡）；切分的浏览器可做判定挡掉 `lottie` / `lottie-*`、画布卡、执行器标了 `snapshotOversize` 的卡 |
| 仅供测试的「只切分」（D15，验收探针查出） | `server/render-node/filter.mjs`、`server/render-node/index.mjs`、`server/vite-plugin-frames.ts` | `testPlanOnly(env)`：`PROMPTCUT_TEST_PLAN_ONLY=1` 时 pc 节点的节点描述带 `planOnly: true`，节点侧过滤规则 8 只认领 plan、不认领细任务；生产不设 |
| 在线构建不改写 CSS（更正第 4 条） | `vite.config.ts` | 在线构建 `build.cssMinify: false`，另关 Tailwind 插件的构建期优化（`optimize: false`：Lightning CSS 不压缩也把 `0.4` 改写成 `.4`，只关压缩不够） |
| 守门（更正第 1 条） | `src/pageNodeImports.test.mjs` | 从 `src/main.tsx` 起顺着静态 import 走遍页面会载入的模块（含 `server/`），出现 Node 内置模块就判红并给出引用链 |
| 访问器 | `src/store/docsync.ts`、`src/editor/sync/syncManager.ts` | `DocSync#confirmedProject`（只读）；`currentSharedUrl()` |
| 契约 | `docs/plan/m7-contract.md` | 第 13 节补「探针之后的更正」十条与落实；第 0、3.3、3.4、4.3、4.4 节随之改述；M7-A4 夹具改述为「3 张实测为重的独立内置卡」〔裁〕；D15 注明开关已实现 |
| 探针 | `scripts/probes/m7-node-probe.mjs`、`scripts/probes/m7-bake-node-probe.mjs` | 前者是本分支的端到端；后者是 `m7-bake-probe.mjs` 的页面节点版（`browser` 子命令改驱动产品的 `bakeFrame`，`compare` 顺带比小尺寸） |

## 验证

1. **类型检查**：`npx tsc -b --force`，退出码 0，零错误。
2. **全量测试**：`npm test`，退出码 0：`tests 3663, pass 3661, fail 0, skipped 2, todo 0`（终验，bb18234）。跳过的 2 条是原有的（`集成:/api/cards/layout …`、`SKILL 闸门 …`，都要真 dev server），M7 的门全部打开，没有新增跳过。
3. **页面节点那 10 条门打开后**：`node --experimental-test-module-mocks --test server/test/m7-page-node.test.mjs` → `tests 10, pass 10, fail 0, skipped 0`（`m7-kit.mjs` 一行没改）。本分支新增单测：`src/online/bakeTask.test.mjs` 3 条、`src/online/planPublisher.test.mjs` 新增 2 条（等报到、最多 3 s、超时照发、不当节点不等）、`server/test/m7-uploader.test.mjs` 4 条（对着真素材服务 HTTP 层；单飞、incomplete 重查）、`server/test/m7-node-rules.test.mjs` 3 条（画布卡、Lottie 等不给浏览器、只切分开关）、`src/render/bakeSmall.test.mjs` 1 条、`src/render/m7-alive-source.test.mjs` 1 条、`src/pageNodeImports.test.mjs` 1 条（变异验证：`session.mjs` 改回引 `index.mjs` 即判红，引用链 `src/main.tsx → … → src/online/browserNode.ts → server/render-node/session.mjs → server/render-queue/index.mjs → server/render-queue/queue.mjs`）；`src/render/stageRpc.test.mjs` 白名单改为八种。
4. **在线构建**：`npx vite build --mode online`，退出码 0；产物里没有 `__vite-browser-external`；CSS 保留原文（`oklch(96.2% 0.059 …`，关优化前是 `.059`）。
5. **端到端**（本机，端口 5440～5444）：`node scripts/probes/m7-node-probe.mjs --dist dist-online --out <scratchpad>/m7outN`。场景：托管组合（真文档服务、真队列、真素材服务）+ 三个源的仿 nginx 代理（OAC、runtime-config 给两个舞台源）；探针经 `shared/create` 建自由进入的项目；切分方是本进程里的 pc 档节点（真会话、真 `splitPlan`，执行器只算计划，重度策略只收 medium、细任务一律标 light —— 只切分不认领）；成员用无头 Chrome 打开在线构建凭项目名 + 口令进入，加一张 `probe-slow-stepped`（每帧烧 40 ms，1 秒 30 帧），再加第二张（2 秒 60 帧）验让路。run4（顺推、就绪闸、CSS 不改写之后）原样摘录，退出码 0，`"ok":true,"fails":[]`：
   - 页面节点：`"counters":{"claims":1,"completed":1,"dedup":0,"failed":0,"lost":0,"bakedFrames":30,"released":{},"blocked":{"6:plan-on-browser":2},"frameMs":{"n":30,"p50":155,"p95":213}}`
   - 舞台：`"stage":{"frames":30,"remounts":1,"pausedMs":0,"errors":{},"frameMs":{"p50":100.7,"p95":152.1},"smallFrames":30,"smallMs":{"p50":49.4,"p95":100}}`（顺推只从头推一次）
   - 推送：`"upload":{"pushed":60,"skipped":0,"bytes":427439,"failed":0,"reauth":0}`，`"manifests":{"written":1,"failed":0}`；认领到完成约 8 s（`completeMs: 8084`，CPU 很忙时，只作参考）
   - 清单计划：两版都 `"ok":true,"node":"ready"`（等节点报到完才发）；切分方认领、双份出键
   - 核对（探针判据全过）：内容库清单过 `manifestMatches`、结果键 = 内容键 × 浏览器指纹、30 帧原尺寸 + 30 帧小尺寸；素材服务上 30 块 `snap` 与 30 块 `px` 都 complete，取回的 HTML sha256 与清单一致；页面内快照库有 `snap/` 与 `px/` 块；切分方没做任何细任务；在线来源 `"aliveKeys":2,"deadKeys":1`（本页那份活着，切分方那份收到 `superseded`）；小尺寸是 WebP；节点报到后主文档长任务 0（只记不判）
   - 让路（D8）：第二张卡做到第 2 帧后开始播放 → `"before":{"claims":2,"bakedFrames":32}`、`"released":{"released":{"yield-play":1},"claims":2,"bakedFrames":33}`（当前帧做完放回恰好一次）、2.5 s 后 `"during":{"claims":2,"bakedFrames":33,"idle":false}`（播放中不认领、不生成）、停下后 `"after":{"claims":3,"completed":2,"bakedFrames":90,"failed":0}`（重新认领同一段只补缺的帧，30 + 60 = 90；不计失败）
   - 早先几轮：run1 只挂在探针自己的判据上（把切分方对第 1 版 plan 的失败算成「做了细任务」）；run2、run3（batch4 时）全过，stage p95 约 1.2 s / 帧（每 4 帧从头推）
6. **在线构建 vs 桌面（更正第 4 条）**：`scripts/probes/m7-bake-node-probe.mjs` 的 `desktop`（本进程 `FramePipeline`，导出页用本 worktree 起在 5445 的开发服务器，跑完已停）→ `browser --layouts cross-oac --modes seq,batch4`（在线构建、跨源 + OAC、产品的 `bakeFrame`）→ `compare --small`。逐字节相同的帧数 / 去掉 CSS 自定义属性后 / 再去掉 `will-change` 后（每卡 60 帧）：

   | 对比 | pill | ticker | slow | particles | lottie |
   |---|---|---|---|---|---|
   | 桌面 vs 在线顺推（关 CSS 优化后） | 46 / 46 / **60** | **60** | **60** | 13 / 13 / 13 | 在线 0 帧（`not-ready: 控件尚未就绪 (lottie): HTTP 404`） |
   | 桌面 vs 在线 batch4（关 CSS 优化后） | 31 / 31 / **60** | **60** | **60** | 56 | 同上 |
   | 桌面 vs 在线顺推（只关 `cssMinify` 时） | 0 / 36 / 60 | 0 / 60 / 60 | 0 / 60 / 60 | 0 | 同上 |

   - ticker、slow 逐字节相同；pill 剩 14 帧（顺推）只差 `will-change`，**照实报、未动**（是否在快照序列化里去掉由主会话定）；particles 顺推不等价（画布卡，已由规则 7 与切分挡在浏览器之外）；lottie 在线没有 `/catalog/`，就绪闸把整段判失败、不出空白帧（更正第 7 条另修）。
   - 像素：pill、ticker、slow 桌面 HTML 与在线 HTML 截图逐像素相同（平均绝对差 0）；小尺寸（`foreignObject`，带全局样式表）与桌面 CDP 小位图：ticker 0、slow 预乘差 > 16 的像素 ≈ 0.05%、pill ≤ 0.88%（第 30 帧 `pmOver16Pct 0.877`）。
   - 舞台逐帧耗时（无头、忙机）：顺推 pill p50 47 ms、ticker 87 ms、slow 105 ms；batch4 slow p95 2.3 s。父页长任务全部 0。待笔记本复核。
7. **导出确定性与像素基线**：`node scripts/verify-determinism.mjs --url "http://127.0.0.1:5445/?export=1"`（本 worktree 的开发服务器，数据目录指向 scratchpad），退出码 0：`Total Frames: 1800 / Identical: 1800 / Different: 0 / All frames are identical. Determinism verified!`；两遍都与基线逐像素比：`compare-frames.mjs pc-g0r-base/out/verify-a/frames out/verify-a/frames` → `{"total":1800,"identical":1800,"different":0,"missing":0,"extra":0}`，`… out/verify-b/frames` → 同样 1800 / 1800 / 0。（这一次在 isolatedCardProject 挪动之后、在线构建配置改动之前跑；后者只影响在线构建，导出走开发服务器，不受影响。）

没跑的：M7-A4～A12 的验收剧本（验收探针 `claude/m7-accept-probe` 的活，带耗时门槛的项在笔记本判）；W7 跨机；G0-R 由主会话在集成时做。

## K10、K11 对账

实现照契约写，形状与 `m7-kit.mjs` 的假设一致，`m7-kit.mjs` 一行没改：

- **K10**：`src/online/browserNode.ts` 导出 `browserNodeEligibility`（候选名表里有），入参正是 `{ online, codeVersion, lowMemory, stageLayout, userAgent, member, measured }`，回 `{ ok, reason }`。纯函数，不引 `mode.ts`。
- **K11**：同一文件导出 `createBrowserNode(deps)`；`deps` 用到的正是假设里那一组，另有可选的 `lookupResult`（去重）、`onTaskEnd`、`onFingerprint`、`onRefused`、`random`、`constants`；方法 `start / receive / tick / yieldFor / stop`，另有 `debug()` 与 `envFingerprint`。`task.release` 的 `reason`：`yield-play`、`yield-drag`、`yield-urgent`、`yield-hidden`、`no-snapshot`、`offline`、`unsupported`。

## 诊断形状与验收探针适配处（A-1～A-9）的对账

诊断照契约第 7 节定，不为适配处改形状；对不上的列在这里，集成时改 `scripts/probes/m7-node-adapter.mjs`：

| 假设 | 本分支实际 | 对得上吗 |
|---|---|---|
| A-1 `window.__pcBrowserNode()` 在编辑器页 | 同 | 是 |
| A-2 `state`（off / idle / busy / baking）、`reason`、`nodeId`、`envFingerprint`、`codeVersion` 平铺 | 同；不当节点时 `state: 'off'`，`reason` 是资格不成立的原因（`measuring`、`single-stage` …）或 `refused-<原因>` / `closed-4003` | 是 |
| A-3 持有的任务在 `held` / `tasks` / `holding` | `holding: [{ id, token, done, of, projectRev }]` | 是（适配处认 `holding`） |
| A-4 计数在 `counts` / `stats` / 顶层，名字 `claimed completed dedup failed lost bakeFrames chunksPushed chunksSkipped bytesPushed smallFrames`，放回在 `released: { yield, hidden, urgent, noSnapshot }` | 计数在 **`counters`**：`claims completed dedup failed lost bakedFrames`、`released`（键是线上原因原文：`yield-play`、`yield-drag`、`yield-urgent`、`yield-hidden`、`no-snapshot`、`offline`、`unsupported`）、`blocked`（节点侧过滤挡掉的任务按「规则号:原因」）；推送在 **`upload`**：`pushed skipped bytes failed reauth recheck lastError`；小尺寸帧数在 **`stage.smallFrames`** | 否：`countsOf` 要从 `counters` / `upload` / `stage` 取，`bakeFrames` ← `counters.bakedFrames`，放回按原因要按键名套 `releaseCauseOf` |
| A-5 每帧耗时在 `bakeMs` / `frameMs`，`pausedMs` 单记 | 页面侧一帧（含推送）在 **`counters.frameMs { n, p50, p95 }`**；舞台侧在 **`stage.frameMs`**、**`stage.pausedMs`** | 否：路径不同 |
| A-6 `lastError` | 字符串 | 是 |
| A-7 舞台 `__pcStageDiag().bake`：`{ frames, frameMs: { p50, p95 }, pausedMs }` | 同（另有 `remounts`、`smallMs`、`errors`、`cursor`） | 是 |
| A-8 `task.release` 的原因 | `yield-play` / `yield-drag` → `releaseCauseOf` 判 `yield`；`yield-hidden` → `hidden`；`yield-urgent` → `urgent`；`no-snapshot`；`offline` → `stop` | 是（正则都命中） |
| A-9 C10 已有诊断 | 形状没改；`__pcOnlineSnapshots()` 另加 `aliveKeys`、`deadKeys`、`layers[].candidates`；`__pcPlanPublisher().log[]` 另加 `node`、`waitedMs`，另有 `nodeWaitMs` | 是 |

## 没做成的与原因

- **`will-change` 的字节差**（更正第 4 条）：pill 顺推 14 / 60 帧只差它，像素相同；按主会话要求照实报、未动快照序列化（去掉它会让现有快照键一次性失效）。
- **Lottie**：在线构建与托管端没有 `/catalog/`（更正第 7 条，主会话另派人修），现在整段 `not-ready` 失败；另按更正第 6 条切分已不给浏览器出 Lottie 卡。
- **`snapshotOversize`**：切分认这个标，但桌面执行器还没按本机快照库里已记为超限的内容键去标（`server/prerender-executor.mjs` 不在本分支清单里的改动范围，没动）；眼下能挡的只有按卡种（Lottie）与画布卡。
- 契约第 4.3 节「舞台互换时生成快照跟着后台位置走」：互换前补跑是更急的活，当前帧做完放回（D8），重新认领时从留着的帧之后接着做；宿主另在每帧前核后台位置换没换人、换了就重灌隔离工程。没有专门的互换剧本验它。

## 与契约不一致之处、更正建议

1. **清单计划不写 `input.browser`**（契约第 3.3 节原文要页面写）：队列分支改为「队列在 plan 的认领回包里给同用户在线浏览器节点的指纹」，页面自报的不作数（`AGENT-rq-m7-queue.md` 出入第 1 条）。页面保留「等报到完、最多 3 s 再发」，这是这条路成立的前提。建议契约第 3.3 节按队列分支的做法改（计划级）。
2. **让路细则补一条**（D8，三级）：全段帧已齐、只剩组清单与报完成时来了 `play` / `drag` / `urgent`，照常完成不放回；隐藏仍立即放回。
3. **nodeId 按页面会话取**（`browser-<pageSession>`）：每次载入是新节点，旧节点手里的认领由队列按宽限回收；D9 的「nodeId 绑 userId」照样成立。
4. **`isolatedCardProject` 的去处**：`src/kernel/isolatedCard.mjs`（Node 能直接 import 的 .mjs、kernel 最底层、不引任何模块）。
5. **改了队列分支的文件**：`src/render/snapshotSource.ts`（只加候选认定）、`server/render-node/filter.mjs`（规则 7 的 `canvas-heavy`、规则 8）、`server/render-node/split.mjs`（浏览器可做判定）、`server/render-node/index.mjs`（转出 `testPlanOnly`）、`server/vite-plugin-frames.ts`（pc 节点描述的 `planOnly`）—— 都是主会话指派的更正。
6. **更正第 4 条的实现比裁定多一步**：只关 `cssMinify` 不够（Tailwind 插件在构建期仍用 Lightning CSS 改写数值），另关了插件的 `optimize`；在线构建的 CSS 由此与开发服务器（桌面导出页）同形，体积 439 KB（未压缩）。
7. **三级数字**写在代码常量里：每帧回包超时 120 s（`BAKE_FRAME_TIMEOUT_MS`）、就绪闸上限 20 s（同预渲染）、闲的安静期 500 ms、留存 4 版、宿主节拍 250 ms、清单计划等报到 3 s。
8. D18 的三级语义措辞本分支没写进 `docs/semantics/`（裁定是 M7 合入 main 时写）。实现与那两句一致。

## 提交列表

`git log --oneline --first-parent 24c2c57..HEAD`（新到旧）见文末「终验」一节贴的原样输出。

## 终验（bb18234 之上）

- `npx tsc -b --force`：退出码 0，零错误。
- `npm test`：退出码 0，`tests 3663, pass 3661, fail 0, cancelled 0, skipped 2, todo 0`（跳过的 2 条是原有的）。
- 页面节点那 10 条门：`tests 10, pass 10, fail 0, skipped 0`。
- `npx vite build --mode online`：退出码 0。
- 端到端 run5（最终代码、重出的在线构建）：退出码 0，`"ok":true,"fails":[]`；`"counters":{"claims":1,"completed":1,"bakedFrames":30,"frameMs":{"p50":156,"p95":204}}`、`"stage":{"frames":30,"remounts":1,"pausedMs":0,"frameMs":{"p50":103.1,"p95":145.9},"smallFrames":30}`、`"upload":{"pushed":60,"skipped":0,"bytes":427439,"failed":0,"reauth":0,"recheck":0}`、`"online":{"aliveKeys":2,"deadKeys":1}`、`"completeMs":7061`；让路一段 `"released":{"yield-play":1}`、`"before":{"bakedFrames":32}` → `"released":{"bakedFrames":33}` → `"after":{"claims":3,"completed":2,"bakedFrames":90,"failed":0}`；主文档长任务 0。
- 本会话起的进程（5445 的开发服务器两次、端到端探针的托管组合与代理）都已结束；5440～5449 空着。

提交（`git log --oneline --first-parent 24c2c57..HEAD`，新到旧；最末几条是合入的 `claude/rq-m7-tests`）：

```
（本报告的提交）
bb18234 诊断:__pcBrowserNode 的 upload 带 recheck
19fbaa3 功能:仅供测试的「只切分」开关 PROMPTCUT_TEST_PLAN_ONLY;舞台 __pcStageDiag().bake;契约 M7-A4 夹具改述〔裁〕
6334683 文档:m7-contract 第 13 节补「探针之后的更正」十条与落实
62f7eb5 构建:在线构建另关 Tailwind 插件的构建期优化;探针:m7-bake-node-probe
8f8a1a0 测试:守门——页面的静态依赖链里不许有 Node 内置模块
9ebad30 功能:宿主听 freeze 再尽力放回一次、resume 一律当重连;小尺寸文件头照探针 P3 改述
8b3febf 功能:就绪闸、逐帧顺推、在线构建不压缩 CSS、上传器单飞与 incomplete 重查
59835cc 功能:纯浏览器不收画布卡;切分不给浏览器另出 Lottie、画布卡、超体积的卡
73d49eb 探针:m7-node-probe 加让路一段
420e154 功能:宿主把「测量已落定」按项目记住
7fe7325 报告:正文
b5b8951 探针:m7-node-probe 判据修正
1baeb9c 探针:m7-node-probe
cf26eb1 功能:页面宿主;Preview 接线
838a0d2 测试:舞台事件白名单加 bake-frame
23a5b74 功能:在线来源认定层表 v3 的候选(D12 页面侧)
239289a 功能:后台舞台的生成快照 RPC、foreignObject 小尺寸;单飞队列加 bake 活
349a3cd 测试:m7-uploader 文件头排版
91af6b4 功能:页面上传器
7ee8f45 功能:清单计划等节点报到完再发(最多 3 s)
fda8036 重构:isolatedCardProject 挪进 src/kernel/isolatedCard.mjs;页面节点改用 task-runner
f8c2879 合并 claude/rq-m7-queue
b8ab7a8 WIP:生成快照的纯函数
1c9708c 功能:页面纯浏览器节点的判据与编排(K10/K11)
23efdf3 报告:开工占位
8f18461 … 7685c5e(合入的 claude/rq-m7-tests)
```

## 补：A5 / A6 让路修复（主会话 2026-09-28 转验收探针结论）

- 缺陷：播放、拖动时后台活的门关了，正在做的那一帧在舞台里被挡住；节点按 D8 等「当前帧做完」再放回，于是既不出帧也不放回，停下后约 5.2 s 才放回。
- 修：`src/online/browserNode.ts` 让路（play / drag / urgent）之后，当前帧 `YIELD_FRAME_MAX_MS`（1 s，三级数字）内做不完就像页面隐藏那样中止它、立即放回（宿主每 250 ms 的节拍里判）。单测 `src/online/browserNode.test.mjs` 4 条，修前 3 条失败。
- 验收探针（合入 `claude/m7-accept-probe`，`--role all`）：M7-A5 `page-yield-on-drag` pass（`claimsDuring 0`、`framesDuringDrag 0`、`yield-drag` 在拖动后 1162 ms 放回）、`page-attempts-unchanged` pass；M7-A6 `play-yield` pass（`claims 0`、`frames 0`、`releases ["yield-play"]`）、`hidden-release-now` pass、`urgent-stops-at-frame-boundary` pass（1153 ms）。同一轮其余 fail：M7-A10 两条、D1-D2-D12 一条，都在切分 / 锁接手一侧（队列分支在复现 A10），不是本修复的范围。
