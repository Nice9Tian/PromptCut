# AGENT 报告：M5b 预渲染管线侧（m5b-pipeline）

- 分支：`claude/rq-m5b-pipeline`（基于 `claude/rq-m5b` 的 `5c4635f`）
- worktree：`.worktrees/rq-m5b-pipeline`
- 依据：`docs/plan/render-queue-contract.md` J.4、J.5、J.6、J.7 末段（`queue-mode-probe`），文件照 J.8 pipeline 行；设计附件 `docs/plan/queue-executor-design.md`
- 端口段：5510～5519
- 改动文件（都在 J.8 pipeline 行里）：`server/prerender-executor.mjs`（新）、`server/render-project.mjs`（新）、`server/frame-pipeline.mjs`、`server/vite-plugin-frames.ts`、`server/asset-client.ts`、`scripts/probes/queue-mode-probe.mjs`（新）
- 没碰：`server/render-node/`、`server/docservice/`、`server/test/`、`src/`

## 做了什么

### J.4 真实执行器（`server/prerender-executor.mjs`）

`createPrerenderExecutor({ pipeline, projects, prepareProject, log }) → { plan, render, isIdle, forget }`。

| 方法 | 实现 |
|---|---|
| `plan(planTask)` | 按 `source.projectId@projectRev` 取上下文：`projects.get` 取不到抛 `{ code: 'no-snapshot', retryable: true }`；取到的 JSON 过 `prepareProject`（预渲染进程传 `renderProject`），交给 `pipeline.planForQueue`，回它的 PlanContext。上下文按版本缓存，LRU 4 条；失败的不留。 |
| `render(task)` | 流任务抛 `stream-not-supported`（不可重试）；快照任务按附件第 3 节对回 control：`clipId` 找得到、`tier` 一致、这张卡由队列产（见下）、`range` 在 `0..count-1`、本机有指纹；共享档 `input.contentKey === control.contentKey` 且 `resultKey === resultKeyOf(contentKey, 本机指纹)`；本地档 `input.entryKey === entry.key`、`input.contentKey === entry.key + "/" + control.contentKey`，另外也核 `resultKey === resultKeyOf(input.contentKey, 本机指纹)`（附件没写这一条，本地档没有锁，指纹只能是本机的，多核一条更保守）。任何一项对不上抛 `plan-mismatch`（不可重试）。共享档调 `renderCardSnapshotRange`，本地档调 `renderSceneSnapshotRange`，回 `null`。 |
| `isIdle()` | 管线已关、流生产者有 worker 或在编的分段、后台让路中（`backgroundYielding`、让路租约在期、`playback.playing`、`streamBusy()`：页面报的播放头在播或 800 ms 内拖过）、有没中止的 preload 代际不在 `ready` / `error` / `cancelled`，任一成立就不闲。 |

### `FramePipeline` 新增（`server/frame-pipeline.mjs`）

- **`'queue'` lane 与 `runQueueTask(work, signal)`**：照 `runAgentTask` 写，链进 `laneChains`（第一次用才加进去，构造时不动），`closeNow` 照旧等全部 lane。`acquire` 的播放让路判断和 `scaleForLane` 的后台缩放都覆盖 `'queue'`。
- **`planForQueue(project, { signal })`**：附件第 2 节的 1～7 步。取卡片计划在 `'queue'` lane 上开预渲染间；`entry.cardPlan` 不是数组才 `recordCardPlan`（不调 `adoptCardPlan`）；按本机锁库给共享档卡定 `cardLocks` / `takeover`（见下）；只留 `queueHandles` 的卡、补 `cardId`（从 `browserPlan.graph.nodes[].cardId` 按 `nodeId` 补）；`isUserCard` 看 `sourceVersions[cardId]` 的 `user:` 前缀；`isGraphCard` 用已有的 `isGraphCardControl`；`weightOf` 按附件（`canvasHeavy`、`belowDependent`、`unknown`、本地档 `heavy`，其余 `medium`）；`cardSourceVersions: {}`；`streams: []`；锚帧取 `anchorFrames` 在 `0..count-1` 的。回 `{ entry, context }`。
- **`queueHandles(control)`**：由队列产的卡 = 本地档，或共享档且 `cacheable`。共享档里不可缓存的（`sourceDependent`）不进队列，照旧由整场景路 / B 趟产（附件第 2 节「去掉不可缓存的共享档卡」）。
- **`renderCardSnapshotRange(entry, control, range, { signal, progress })`**：开工前这张卡被别的环境锁住就抛 `card-locked-local`（不可重试）；在 `'queue'` lane 上调 `fillCardControls(entry, bakery, signal, [control], { range, onBatch })`，每批交完按这一段里的帧数报进度；渲完再判一次锁（渲的途中被页面抢了锁，`fillCardControls` 会把这张卡换成锁定方的键、不写 HTML），又被锁了照样抛。
- **`fillCardControls` 的第 5 个参数 `{ range, onBatch }`**：只改两处——批的起点（覆盖 `[from, to]` 的那几批，起点按 4 帧对齐）和生成快照的帧（只取区间内缺的）；批内的 PNG 帧、锁判断、发层、`finish` 都不变。每批交完调 `onBatch`。不传时逐字节是原来的行为（`inRange` 恒真、`onBatch` 为空）。
- **`renderSceneSnapshotRange(entry, control, range, …)`**：本地帧换成全局帧，照 `missingSnapshotFrames` 的条件（不在 `frames` / `oversize`、`global / fps < end`）挑出缺的，在 `'queue'` lane 上交给 `renderLocalSnapshots`。
- **`preload` 的 `queue` 选项**与 **`leaveQueueMode()`**：见 J.5。

### J.5 队列模式（`server/vite-plugin-frames.ts`、`server/render-project.mjs`）

- `renderProject` 原样搬到 `server/render-project.mjs`，`.ts` 里 `export { renderProject }` 转出，`vision/render.ts` 与脚本不用改。
- 开关 `PROMPTCUT_QUEUE_NODE=1`，缺省关。关着时：不建节点、`queueNodes` 为空，`/preload` 调 `service.preload` 的参数与原来一字不差，`/diagnostics` 不多键。
- `startQueueNode`（`frameService` 建管线时，和 `startArtifactPush` 并排起）：`render-node/index.mjs` 缺 `createProjectClient` 等出口时打 `queue.skip { reason: 'render-node-exports-missing' }` 就不起（本分支单独跑就是这样，svc 合进来之后才有这个出口）；`resolveDocservice` 不是 `remote` / `local` / `editor` 也不起。起的话：借一次流预渲染间探指纹；一条 WebSocket 端点上挂 `createProjectClient`、`createContentClient`、`createLocalNode`（`profile: 'pc'`、`maxConcurrent: 1`、`capabilities: { userCards: true, graphCards: false }`、`codeVersions: [frameCode(root)]`、`isIdle` 用执行器的），sink 是 `createAssetSink({ pipeline, client, content })`。节点身份 `prerender:<主机名>:<编辑器端口>`。节拍 500 ms：`frameCode` 变了就重建节点重新报到；`streamBusy()` 时在跑的任务 `yieldAll('busy')`；然后 `tick()`。
- `/preload`：节点在线时先 `publish`：取 `project.id`（合 `PROJECT_ID_RE`），不合就取镜像的会话键，都不合就不走队列；`digest = sha256(JSON.stringify(prepareProject 之后的项目))`；`announce` → `putSnapshot` → 以节点的发布方身份发布 `planTaskOf(...)`，`requires` 里补 `codeVersion`、`envFingerprint`（node 分支的 `planTaskOf` 会自己写，合并之前的版本不认这两个参数，这里再补一遍，两种都对）；等同一 reqId 的 `task.published`。成了 `preload(..., { queue: true })`，不成 `queue: false`。同一 `(projectId, digest)` 只发一次（页面每 2 秒一次的保活 preload 不再往返）。
- **「不再跑原来后台那一趟的快照部分」的做法**（设计取舍，见下文疑点 1）：`entry.queueSnapshots === true` 时，后台那一趟跳过两次 `fillCardControls` 和 `renderLocalSnapshots`；另外 `recordSnapshots` 对 `queueHandles` 的卡不写快照（B 趟、MOV 那一趟、Agent 查询顺带记的帧都经它），**锚帧那一趟例外**（`record(..., { anchors: true })`）。每一步开始前现读这个标志。
- `task.done`：`plan` 的记下 `derived`；细任务的 `result` 是 C6.2 清单（`v: 1`）就串行 `applyResult(service, client, result)`，本机产的按「已有跳过」处理、再 `adoptResult` 认领。
- 断线：`leaveQueueMode()` 把队列模式的 entry 标回 `false`、掐掉它们的后台代次、对还有会话停着的 entry 以 `adopt: false` 重排一趟（跑完的也重排：它跳过了快照那几步）；节点 `yieldAll('offline')`；已发布记录清空。重连（`onOpen`）按 G.7 的写法重新报到，之后新的 preload 再走队列。
- 诊断：`/api/frames/diagnostics` 在队列模式下多一个 `queue` 键（连接、节点、计数、已发布的 plan、`plans`（plan → 派生任务 id）、`tasks`（id → done / failed）、最近事件），`queue-mode-probe` 读它。
- `startArtifactPush` 也认 `editor`（主会话 2026-09-25 要求，见疑点 4）。

### J.6 远端节点的素材回退（`server/asset-client.ts`）

`setMediaFallbackBases(list)` / `mediaFallbackBases()` 存在 `globalThis` 上。`assetProxyPlugin` 只在「有回退基址、GET / HEAD、路径是 `/@media/<64 位十六进制>`（可带扩展名）」时走新路：主源 404（或连不上）就依次试 `<base>/media/<hash>`，Range 等几个头透传，第一个不是 404 的答复原样转；都不行回主源的答复（去掉长度、分块头）。其余请求走原来的代码，逐字节不变。节点在 J.5 里订阅 `service.endpoints` 的 `asset`，排除 `announcerId === asset:<本机主机名>` 和与本机素材服务同 host 的地址，填进来。

### 探针 `scripts/probes/queue-mode-probe.mjs`

见文件头。前后各起一套编辑器（普通模式 5513、队列模式 5516），各配一个空帧库和一个**独立的**文档服务（`server/docservice/main.mjs`，5519，数据目录是临时目录），逐帧比较 `controls-html/**`、`controls-local/**` 的 `.html` 与 `index.json`。输出 `{ ok, tasks, done, identical, differentFrames, fails }`。另外每帧标 `styleOrderOnly`（只差 `style` 属性里声明的先后），汇总 `identicalIgnoringStyleOrder`。

## 提交

- `e54beac` 报告骨架；`0061fd6` 执行器与 queue lane、renderProject 搬家、素材回退；`eb3f49a` 队列模式接线；`b97dc35` 探针
- `1eb78d5` 修正 asset-client.ts 回退正则的反斜杠（改写时丢了，全量测试的语法守门抓到）
- `9f4f13a` 修正 vite-plugin-frames.ts 漏了 renderProject 的 import（dev server 起不来）
- `92f161a` 合并 `claude/rq-m5b`（`52229b6`：svc、node、tests 都在上面）；`bf9ce69` 探针标出只差 style 声明顺序的帧；本报告的提交见分支最新

## 验证

都在合并 `claude/rq-m5b` 之后的本分支上跑；全量测试与导出类验证没有同时跑。

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0 |
| 全量测试 | `npm test` | 退出码 0：tests 2429，pass 2428，fail 0，skipped 1（需要 5190 的那一条） |
| 测试方的执行器用例 | `node --experimental-test-module-mocks --test server/test/prerender-executor.test.mjs` | J8～J11 共 9 条全过 |

合并前的一次 `npm test` 出过一条 `docservice-content.test.mjs` N4 失败（端口 4190 连不上，close 1006）；单独连跑 3 次都过，合并后的全量也过，判为负载下偶发，与本分支无关。

### G0-R 开关关（5510，基线 5513）

dev server：`node C:\Users\admin\Documents\PromptCut\node_modules\vite\bin\vite.js --port 5510 --strictPort --host 127.0.0.1`，工作目录本 worktree。

| 项 | 结果 |
|---|---|
| `verify-determinism --url "http://127.0.0.1:5510/?export=1"` | 退出码 0，1800/1800 相同 |
| `verify-unified-frames`（`PC_FRAME_TEST_URL=http://127.0.0.1:5510`） | 退出码 0，`PASS: no video during B; all HTML frames; exact video seek; random replay; cache hits; cumulative C equals A; streamed video contains all 10 frames.` |
| `stream-produce-probe --origin …5510`，以及加 `--group` | 两次退出码 0，`"fails": []` |
| `preview-fallback-probe --origin …5510`，以及加 `--page-preload` | 两次退出码 0，`"fails": []` |
| `ready-index-probe --port 5513`（基线停掉之后） | 退出码 0，`"fails": []`（第二次跑会失败，原因不在本分支，见疑点 4） |
| 与 main 逐像素 | 基线 `git worktree add --detach .worktrees/rq-m5b-baseline main`（`c7bfe5b`），5513 跑同样的 `verify-determinism`（1800/1800），pngjs 逐帧逐像素比两边 `out/verify-a/frames`：1800 帧，不同帧 0，不同像素 0 |

### G0-R 开关开（5516）

同上命令换 `--port 5516`，前面加 `PROMPTCUT_QUEUE_NODE=1`，没设 `PROMPTCUT_DOCSERVICE_URL`（合并之后 `resolveDocservice` 自己发现编辑器里挂的文档服务）。诊断 `queue`：`mode: "editor"`、`url: "ws://127.0.0.1:5516/docservice"`、`active: true`、`nodeId: "prerender:DESKTOP-GS40TCK:5516"`、指纹 `258acaaa7c5fe509`。

| 项 | 结果 |
|---|---|
| `verify-determinism --url "http://127.0.0.1:5516/?export=1"` | 退出码 0，1800/1800；与 main 基线逐像素：不同帧 0、不同像素 0 |
| `verify-unified-frames`（5516） | 退出码 0，PASS |
| `queue-mode-probe`（自己起 5513 普通、5516 队列、5519 独立文档服务） | 退出码 0，见下节 |
| （额外）`PROMPTCUT_QUEUE_NODE=1 … ready-index-probe --port 5516` | 清空内容库后跑：退出码 0，`"fails": []` |

### `queue-mode-probe` 与「preload 三写」（附件第 0 节第 1 条）

最后一次的最后一行：

```
{"ok":true,"tasks":5,"done":5,"identical":false,"differentFrames":168,"identicalIgnoringStyleOrder":true,
 "differenceSummary":{"clip-stateful/shared/bytes(style-order)/anchor":2,"clip-stateful/shared/bytes(style-order)/non-anchor":38,
 "clip-canvas/shared/bytes(style-order)/anchor":2,"clip-canvas/shared/bytes(style-order)/non-anchor":66,
 "clip-unknown/local/bytes(style-order)/non-anchor":60},"fails":[]}
```

- 1 个 `plan` 切出 5 个细任务（两张共享档卡各两段 0～59、60～89，本地档卡一段），全部 `task.done`，都由本机节点 `completed`（`dedup` 0、`failed` 0、`lost` 0）；5 份清单都经 `applyResult` 落定（本机已有，跳过 240 帧）。两边帧库都是 243 个文件，3 个 `index.json` 逐字节相同。
- 差异：第一次跑 240 帧全不同，第二次 168 帧不同；**全部只差 `style` 属性里声明的先后**，排序之后逐字节相同，字节数也相同。
- **对照**：`--only normal` 另跑一趟普通模式，两趟普通模式之间同样 240 帧全不同、排序后全同。所以差异是**进程之间**的（快照内联样式的声明顺序随预渲染间进程变），与队列无关，也不是三写造成的。
- 结论：在这个探针项目上没有看到三写带来的差异。附带发现见疑点 3。

### 自测（不提交）

- scratch 里照附件第 7 节写了 J8～J10 式的对照（假 bakery、`mock.module`），4 条全过；之后测试方的正式用例合进来也全过。
- `assetProxyPlugin` 回退用假服务器对拍：无回退基址原样 404；主源 404 → 第一台 404 → 第二台 206 带 Range；不转发 Cookie；HEAD；主源有就不走回退；不按哈希寻址的不走回退；回退全 404 回主源的 404；主源连不上走回退、没有回退回 502。全过。

### 收尾

- 我起的 dev server（5510、5513、5516）与探针起的进程都按 PID 连子进程关掉，5510～5521 没有监听，也没有留下工作目录在本 worktree 或基线 worktree 的 node 进程。
- 基线 worktree 与合并前自测用的 `.worktrees/rq-m5b-pipeline-int`（detached）删之前都查过 junction 为 0，再 `git worktree remove --force`。
- 为验证疑点 4 清过两次本 worktree 的 `out/docservice`、`out/asset-store`（git 忽略的运行产物）。

## 与任务书、契约不一致的地方，以及疑点

1. **「不再跑原来后台那一趟的快照部分」的读法**（J.5）：只跳过 `fillCardControls` 与 `renderLocalSnapshots` 不够。B 趟和 MOV 那一趟也经 `recordSnapshots` 写快照，而且在队列模式下先于本机节点（要等 preload 落定才闲）把所有帧写完，细任务全成去重，执行器不干活，探针的比较也没有意义。所以队列模式下 `recordSnapshots` 对 `queueHandles` 的卡不写，锚帧那一趟例外；`sourceDependent` 共享档卡不进队列，照旧由整场景路 / B 趟写。请确认。
2. **本机节点起得晚**：`isIdle` 要求没有活的 preload 代际，而后台那一趟要跑完 MOV 与预览视频才 `ready`。探针里普通模式 113 s 产完；队列模式 preload 69 s，全部细任务 115 s 落定。远端节点不受限制。要不要放宽「闲」（例如 `stage === 'direct'` 之后），请主会话定。
3. **快照 HTML 跨进程不逐字节确定**（附带发现）：只差 `style` 里声明的先后。按内容哈希推块时，同一段在两个进程算出的块哈希不同，块会重复上传（清单按段键，不受影响）。建议另立一项让样式内联按固定顺序输出（`src/render/snapshot/` 一带，不在本任务文件清单里，没动）。
4. **`startArtifactPush` 认 `editor` 之后，开关关着的行为也变了**（主会话要求，已照做）：合并 svc 后，推送队列和 preload 前的换机取用在开关关着时也常开；内容库在工作副本的 `out/docservice`，跨重启保留，`ready-index-probe` 在同一工作副本里跑第二次就失败（开关关、开都一样）：② done 时每层已是 0～59 全段、④ 冷缓存选帧不回到区间起点、⑤ 超限帧诊断 `clipId` 为 null——上一趟推上去的段被整段拉了回来。清掉 `out/docservice`、`out/asset-store` 后重跑，开关关、开都 `"fails": []`。不是队列模式的问题，但会让 G0-R 依赖内容库为空。请主会话决定：探针配独立文档服务（`queue-mode-probe` 已这么做），还是 `startArtifactPush` 缺省不认 `editor`。
5. **`queue-mode-probe` 没用编辑器里挂的文档服务**：理由同第 4 条；每一趟起一个独立文档服务（5519，临时数据目录），`--docservice-url` 可改用现成的。探针缺省 `PROMPTCUT_STREAMS=0`（流不走队列、不影响快照；开着时本机节点要等流全产完才闲），`--streams` 保留。
6. **`planForQueue` 在本机锁库上先接手**：决策为 `takeover` 的卡，在 `plan` 时就 `store.takeover` 并整层换键发层（同 `fillCardControls`），切分时带 `takeover: true`、按本机指纹出键；否则执行器会被自己的 `card-locked-local` 挡住。`reuse` / `defer` 照锁定方指纹出键，等锁定方的节点。
7. **远端做的共享档卡在本机没有 PNG 缓存**：`?preview=legacy` 旧整帧通道对这些卡会走占位（Agent、导出缺料时退回 Chrome 活渲，不受影响）。登记为遗留。
8. **projectId**：取项目 JSON 的 `id`（合 `PROJECT_ID_RE`），不合才退到镜像的会话键。页面目前不 `announce`；以后页面也按自己的摘要 `announce` 同一 projectId 时，摘要算法要统一，否则版本号来回跳。
9. **代码版本随改动变**：`frameCode(root)` 变了就重建本机节点、重新报到（在跑的任务随之放弃）。
10. 主会话的裁定（`plan` 不按指纹过滤认领，推迟到 M6）已知悉，没做处理；`plan` 的 `requires` 照 J.5 带 `envFingerprint`，只作记录。
11. `createProjectClient` 合并后已在 `render-node/index.mjs`；`startQueueNode` 仍用动态 import 加出口检查（同 `startArtifactPush` 的写法），缺出口只打日志、不起节点，留作兜底。

## 需要主会话决定的

- 疑点 1 的读法、疑点 2 的「闲」的判据；
- 疑点 4：G0-R 探针与编辑器文档服务的内容库怎么隔离；
- 疑点 3 是否另立一项；
- 合并本分支。

