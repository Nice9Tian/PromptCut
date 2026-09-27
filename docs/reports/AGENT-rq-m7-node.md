# AGENT 报告：claude/rq-m7-node

M7（纯浏览器当渲染节点）的页面与舞台一侧，契约 `docs/plan/m7-contract.md` 第 1 版第 9 节 `claude/rq-m7-node` 行，按第 13 节主会话裁定（D1～D18，下称「裁定」）。起点 `claude/c10-integ`（24c2c57），合入 `claude/rq-m7-tests`（8f18461）与 `claude/rq-m7-queue`（fdbeb60，主会话通知后合入）。端口 5440～5449。

状态：实现与本机验证做完，待主会话审。

代号说明：D1～D18 是契约第 11 节的待定点（裁定见第 13 节）；K10、K11 是契约测试 `server/test/m7-kit.mjs` 文件头对实现形状的第 10、11 条假设；M7-A1～A12 是契约第 10 节的验收项；P1～P6 是第 8 节的可行性探针。

## 做了什么

| 块 | 文件 | 内容 |
|---|---|---|
| 当节点的条件与编排（K10、K11） | `src/online/browserNode.ts` | `browserNodeEligibility`（在线构建、嵌了代码版本 D16、普通档、双舞台握上手、Chromium D14、成员、测量落定，回 `{ ok, reason }`）；`createBrowserNode(deps)`：会话用 `server/render-node/session.mjs`，细任务的执行规矩（先报 0、去重、推完才完成、丢认领丢结果）用队列分支抽出的同构 `server/render-node/task-runner.mjs`（D11 a），本页只在它的 `render` 里管逐帧与让路。`node.hello` 只报原始 `environment`、`profile: 'browser'`、`maxConcurrent: 1`，不报指纹；`node.welcome` 回的指纹记下（节点侧过滤用）并交宿主；watch 只列本项目。D6：先用发布时留存的那一版，没有再取快照，都没有放回 `no-snapshot`。D8：`play` / `drag` / `urgent` 当前帧做完放回（还在取项目时立即放回；全段已齐只剩收尾时照常完成），`hidden` 立即放回并中止当前帧。已做的帧按任务 id 留着，重新认领同一段只补缺的帧。诊断 `debug()`：状态与原因、计数（认领、完成、去重、放回按原因、失败、丢认领、帧数与每帧 p50 / p95、被节点侧过滤挡掉的任务按「规则号:原因」）、最近一次错误 |
| 宿主（第 2、4、5、7 节） | `src/editor/browserNodeHost.ts` | 每 250 ms 判资格：成立就开 render 连接（页面连接上现签 `auth.ticket { kind:'conn', role:'render', owner:{ kind:'browser' } }`，子协议 `promptcut.ticket.<票据>`，会话层 `createDocEndpoint`，`onOpen` 里报到）；不成立、4003 / 4004、报到被拒就放回全部、结束会话、不重连。`isIdle()`：后台活的门开着、不在播放 / 拖动、离上一次交互过了 500 ms、单飞队列里没有更急的活、有后台舞台。让路来源：store 的 `playing`、`subscribeScrub`、`visibilitychange` 与 `backWorkGate` 的 `hidden` / `raf-gap`、单飞 `bake` 活的 abort。一帧：单飞队列里开最不急的 `bake` 活，`pushProject('back', 隔离单卡工程, { reset })`（走 stageBridge 的基线），`bakeFrame` RPC，收 `bake-frame` 事件 → 解压 → 推 `snap` 与 `px`（D7 父页推，rw 票据缓存、到 2/3 寿命换）→ 块进页面内快照库、这一层 `ranges` 写这一帧。全段齐后组清单、`content.put`（失败只记诊断）。去重：内容库清单在、覆盖整段、两档齐、每块在素材服务上 complete。取项目快照经 render 连接收分片、WebCrypto 核摘要。D6 留存最多 4 版。`window.__pcBrowserNode()`。票据不进诊断 |
| 生成快照 RPC（D3，第 4.3 节） | `src/render/stageRpc.ts`、`src/StageView.tsx` | 新 RPC `bakeFrame({ session, clipId, localFrame, mode, small })` 与 `bakeCancel()`；新事件 `bake-frame { session, clipId, localFrame, hash, bytes, htmlGz \| htmlRaw, small }`（字节随消息转移，只认后台舞台）。舞台里：`batch4`（缺省，批起点按 4 帧对齐、每批从头推，同桌面）或 `seq`（接着上一帧顺推）；帧间让一个宏任务、查后台活的门（挡住的时长记 `pausedMs`，不算耗时）；不受一拍预算截断；就绪闸（控件异步活、字体、图片，照预渲染 `waitFrameReady`）；生成快照取本控件 HTML，`lossy` → 回 `lossy`（父页按不可重试失败交回），本地帧号对不上 → `frame-mismatch`；sha256 用 WebCrypto 在舞台里算。`setRole('back', { job: 'bake' })` 在线构建里接受（桌面照旧 `unsupported`）。回包超时 120 s（原地重载丢回包时父页能放手） |
| 小尺寸（D5 a，第 4.4 节） | `src/render/bakeSmall.ts` | 快照 HTML 按桌面同一道清洗、放进框大小整体 `scale(s)` 的盒子，连同舞台页的样式表包进 SVG `foreignObject`，`data:` 地址画上透明画布，`toBlob('image/webp', 0.8)`；尺寸换算与 `server/bakery/small-bitmap.mjs` 对拍 |
| 单飞队列 | `src/editor/stageJobs.ts` | 第四种活 `bake`，最不急（补跑 > 测量 > 探针 > 生成快照）；`urgentBackJobs()` 给闲的判据用 |
| 隔离单卡工程共用（第 4.3 节，主会话指派） | `src/kernel/isolatedCard.mjs`（+ `.d.mts`）、`server/frame-pipeline.mjs` | 函数原样挪进 kernel 的纯 .mjs（不引任何模块），桌面 `FramePipeline#isolatedCardProject` 改成调它，行为不变（`frame-playback.test.mjs` 与新的对拍单测都过） |
| 清单与 bake 参数 | `src/online/bakeTask.ts` | `bakeInputOf`（从 `input.bake` + `input.clipId` 取，缺东西回 null）、`snapshotManifest`（形状同 `collectSnapshotResult`，≤ 256 KiB，超限抛不可重试）、`manifestKey`、`manifestCovers`（去重判据：两档都齐）、`manifestBlocks` |
| 上传器（D7） | `src/online/snapUploader.ts` | `chunks` 对账 → 缺的片 `PUT`（`X-Media-Size`、`X-Media-Ext`）→ `complete`；已 complete 的跳过；401 强制换票据重试一次；统计推 / 跳过 / 字节 / 失败 |
| 清单计划等节点报到（主会话第 3 条） | `src/online/planPublisher.ts`、`src/editor/Preview.tsx` | `nodeReady()` 为 `pending` 时这一版等，最多 3 s（`BROWSER_NODE_WAIT_MS`），节点报到完（`nodeChanged()`）马上发；`onPublish` 发之前把这一版的已确认项目交宿主留存（D6）。计划不写浏览器意向（见「与契约不一致」第 1 条） |
| 层表 v3 的候选认定（D12 页面侧，主会话第 1 条） | `src/render/snapshotSource.ts` | `OnlineSnapshotSource` 记认定活着 / 作废的结果键：`task.done` 活，`task.failed { error: 'superseded' }` 是另一份活着（不是失败、不重试、不报错）；层选候选时认定活着的优先、否则第一个没作废的，整层换成它（用队列分支的 `layerRefOf(..., { alive })`，不重写读法）；本页完成一段时 `markAlive`。`Preview` 把队列事件喂给它 |
| 访问器 | `src/store/docsync.ts`、`src/editor/sync/syncManager.ts` | `DocSync#confirmedProject`（只读）；`currentSharedUrl()` |
| 与队列分支同一行 | `server/render-node/session.mjs`、`filter.mjs` | 改从 `constants.mjs` / `messages.mjs` 取（与 `claude/rq-m7-queue` 同一行，合并无冲突） |
| 端到端探针 | `scripts/probes/m7-node-probe.mjs` | 见「验证」第 5 项 |

## 验证

1. **类型检查**：`npx tsc -b --force`，退出码 0，零错误（最后一次在 cf26eb1 之后跑）。
2. **全量测试**：`npm test`，退出码 0：`tests 3657, pass 3655, fail 0, skipped 2, todo 0`。跳过的 2 条是原有的（`集成:/api/cards/layout …`、`SKILL 闸门 …`，都要真 dev server），M7 的门全部打开，没有新增跳过。
3. **页面节点那 10 条门打开后**：`node --experimental-test-module-mocks --test server/test/m7-page-node.test.mjs` → `tests 10, pass 10, fail 0, skipped 0`（当节点的条件；hello 只报原始值；先 progress(0)、逐帧、complete 一次；让路 drag / play / urgent；隐藏立即放回；D6 三条）。本分支新增单测：`src/online/bakeTask.test.mjs` 3 条、`src/online/planPublisher.test.mjs` 新增 M7-PP-05 / 06 两条（等报到、最多 3 s、超时照发、不当节点不等）、`server/test/m7-uploader.test.mjs` 2 条（对着真素材服务 HTTP 层）、`src/render/bakeSmall.test.mjs` 1 条、`src/render/m7-alive-source.test.mjs` 1 条，`src/render/stageRpc.test.mjs` 白名单改为八种。
4. **在线构建**：`npx vite build --mode online`，退出码 0（`✓ built`）；产物里没有 `__vite-browser-external`，`node:crypto` 只出现在嵌进去的源码文本里（代码版本算法的源码字符串），页面引 `session.mjs`、`filter.mjs`、`task-runner.mjs` 能构建（P6 的问题在本分支上成立）。
5. **端到端**（本机，端口 5440～5444）：`node scripts/probes/m7-node-probe.mjs --dist dist-online --out <scratchpad>/m7out2`，退出码 0，`"ok":true,"fails":[]`。场景：托管组合（真文档服务、真队列、真素材服务）+ 三个源的仿 nginx 代理（OAC、runtime-config 给两个舞台源）；探针经 `shared/create` 建自由进入的项目；切分方是本进程里的 pc 档节点（真会话、真 `splitPlan`，执行器只算计划，重度策略只收 medium、细任务一律标 light —— 只切分不认领，D15 的测试替身做法）；成员用无头 Chrome 打开在线构建凭项目名 + 口令进入，加一张 `probe-slow-stepped`（每帧烧 40 ms，1 秒 30 帧）。原样摘录：
   - 页面节点：`"envFingerprint":"258acaaa7c5fe509"`，`"eligibility":{"ok":true,"reason":null}`，`"counters":{"claims":1,"completed":1,"dedup":0,"failed":0,"lost":0,"bakedFrames":30,"released":{},"blocked":{"6:plan-on-browser":1},"frameMs":{"n":30,"p50":167,"p95":1431}}`
   - 舞台：`"stage":{"frames":30,"remounts":8,"pausedMs":0,"errors":{},"frameMs":{"p50":103.8,"p95":1163},"smallFrames":30,"smallMs":{"p50":50.3,"p95":86.2}}`（batch4 每 4 帧从头推一次，所以 p95 高）
   - 推送：`"upload":{"pushed":60,"skipped":0,"bytes":425699,"failed":0,"reauth":0}`；清单 `"manifests":{"written":1,"failed":0}`；从认领到完成约 15 s（`completeMs: 15142`，CPU 很忙时，只作参考）
   - 清单计划：`{"id":"plan:…@1#clips:…","ok":true,"node":"none"}`（页面还在测量、没当节点时照发），`{"id":"plan:…@4#clips:…","ok":true,"node":"ready"}`（报到完才发）；切分方认领第 4 版、`"derived"` 两条（浏览器指纹一份、切分方指纹一份）；第 1 版没有项目快照，切分方不可重试地失败（探针的替身行为）
   - 核对：内容库清单过 `manifestMatches`、结果键 = 内容键 × 浏览器指纹、30 帧原尺寸 + 30 帧小尺寸；素材服务上 30 块 `snap` 与 30 块 `px` 都 complete，取回的 HTML sha256 与清单一致；页面内快照库有 `snap/` 与 `px/` 块；切分方没做任何细任务；在线来源 `"aliveKeys":2,"deadKeys":1`（本页那份活着，切分方那份收到 `superseded`）；小尺寸第一帧 `{"bytes":2018,"riff":"RIFF","webp":"WEBP"}`；节点报到之后主文档长任务 0（只记不判，见下）
   - 第一次跑（run1）只挂在探针自己的一条判据上（把切分方对第 1 版 plan 的失败也算进「做了细任务」），改判据后第二次全过
6. **导出确定性与像素基线**：见文末「verify-determinism」一节。

没跑的：M7-A4～A12 的验收剧本（A4 的 30 s、A12 的长任务是带耗时门槛的项，按 `verification.md`「性能基准机」在笔记本判）；W7 跨机；G0-R 由主会话在集成时做；探针 P1～P6 是 `claude/m7-probe` 的活。

## K10、K11 对账

实现照契约写，形状与 `m7-kit.mjs` 的假设一致，`m7-kit.mjs` 一行没改：

- **K10**：`src/online/browserNode.ts` 导出 `browserNodeEligibility`（候选名表里有），入参正是 `{ online, codeVersion, lowMemory, stageLayout, userAgent, member, measured }`，回 `{ ok, reason }`（`normalizeEligible` 认 `ok`）。纯函数，不引 `mode.ts`（守门测试 `modeImportGuard` 不受影响）。
- **K11**：同一文件导出 `createBrowserNode(deps)`；`deps` 用到的正是假设里那一组（`nodeId, projectId, userId, codeVersion, environment, now, isIdle, send, keptProject, fetchSnapshot, bakeFrame, finishTask`），另有可选的 `lookupResult`（去重）、`onTaskEnd`、`onFingerprint`、`onRefused`、`random`、`constants`；方法 `start / receive / tick / yieldFor / stop`，另有 `debug()` 与 `envFingerprint`。消息形状照 `render-queue-contract.md` A 节；`task.release` 的 `reason` 取 `yield-play`、`yield-drag`、`yield-urgent`、`yield-hidden`、`no-snapshot`、`offline`、`unsupported`。

## 没做成的与原因

- **D15 的「只切分」开关**（`PROMPTCUT_TEST_PLAN_ONLY=1`）在服务端没有实现（队列分支没做，属 `local-node.mjs` / `host.mjs`，不在本分支文件清单里）。端到端改用探针里的替身切分方（重度策略只收 medium、细任务标 light）。真 pc / host 在线时，宿主多半抢先（契约 D15 所说），要验 M7-A4 需要这个开关。
- **推帧口径**：缺省 `batch4`（与桌面一致），等探针 P2 证明顺推相同后可把 `BAKE_MODE` 改 `seq`（舞台两种都支持）；batch4 下每 4 帧从头推，重的推帧卡越到段尾越慢（端到端里 p95 ≈ 1.2 s / 帧）。
- **小尺寸的外部字体**：`foreignObject` 里取不到外部字体，卡片自带的字体（如 KaTeX）会退回系统字体；差多少由 P3 量。
- **「用上前端的算力」的可选优化**（第 3.3 节末：测量推过的独立卡帧直接当浏览器那一份）没做，要 P2 先证明两路帧相同。
- 契约第 4.3 节「舞台互换时生成快照跟着后台位置走」：互换前补跑是更急的活，单飞队列 abort 通知到、当前帧做完放回（D8），重新认领时在新的后台舞台上从留着的帧之后接着做；宿主另在每帧前核后台位置换没换人、换了就重灌隔离工程。没有专门的互换剧本验它。

## 与契约不一致之处、更正建议

1. **清单计划不写 `input.browser`**（契约第 3.3 节原文要页面写 `{ nodeId, envFingerprint }`）：队列分支改为「队列在 plan 的认领回包里给同用户在线浏览器节点的指纹」，页面自报的不作数（`AGENT-rq-m7-queue.md` 出入第 1 条）；主会话的接口说明也照此。页面这一侧保留「等报到完、最多 3 s 再发」，这是这条路成立的前提。建议契约第 3.3 节按队列分支的做法改。三级 / 计划级，未改语义。
2. **让路的细则补了一条**（D8，三级）：全段帧已齐、只剩组清单与报完成时来了 `play` / `drag` / `urgent`，照常完成不放回（放回只会让下一个认领者从头重做）；隐藏仍立即放回。契约 D8 可加这一句。
3. **nodeId 按页面会话取**（`browser-<pageSession>`）：每次载入是新节点，旧节点手里的认领由队列按宽限回收；D9 的「nodeId 绑 userId」照样成立。
4. **`isolatedCardProject` 的去处**：契约写「页面与服务端共用的纯模块」，本分支放在 `src/kernel/isolatedCard.mjs`（Node 能直接 import 的 .mjs、kernel 最底层、不引任何模块）。
5. **改了队列分支的 `src/render/snapshotSource.ts`**：只加了候选认定（`noteQueueEvent`、`markAlive`、`layers()` 按认定选候选），v3 的解析与 `layerRefOf` 没动。
6. **每帧回包超时 120 s**（`BAKE_FRAME_TIMEOUT_MS`，三级数字）、就绪闸上限 20 s（照预渲染）、闲的安静期 500 ms（契约建议值）、留存 4 版（契约建议值）、宿主节拍 250 ms：都是三级数字，写在代码常量里。
7. D18 的三级语义措辞本分支没写进 `docs/semantics/`（裁定是 M7 合入 main 时写）。实现与那两句一致：后台舞台在闲时为认领到的快照任务逐帧生成快照；指纹由文档服务按页面报的原始值算，一期只在 Chromium 内核上当节点。

## 提交列表

`git log --oneline --first-parent 24c2c57..HEAD`（新到旧，截至报告提交前）：

```
（报告提交）
<探针判据提交>
1baeb9c 探针:m7-node-probe
cf26eb1 功能:纯浏览器节点的页面宿主;Preview 接上宿主、清单计划等节点报到、task.done/superseded 喂给在线来源
838a0d2 测试:舞台事件白名单加 bake-frame
23a5b74 功能:在线来源按 task.done 与 superseded 认定层表 v3 的候选(D12 页面侧)
239289a 功能:后台舞台的生成快照 RPC、foreignObject 小尺寸;单飞队列加 bake 活
349a3cd 测试:m7-uploader 文件头排版
91af6b4 功能:页面上传器
7ee8f45 功能:清单计划等本页纯浏览器节点报到完再发(最多 3 s)、发之前交出这一版
fda8036 重构:isolatedCardProject 挪进 src/kernel/isolatedCard.mjs;页面节点改用 task-runner(D11 a);清单与 bake 参数
f8c2879 合并 claude/rq-m7-queue
b8ab7a8 WIP:生成快照的纯函数
1c9708c 功能:页面纯浏览器节点的判据与编排(K10/K11);session/filter 的 import
23efdf3 报告:开工占位
（以下是合入的 claude/rq-m7-tests）
```

## verify-determinism

（跑完补）
