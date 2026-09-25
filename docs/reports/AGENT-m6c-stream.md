# AGENT 报告：M6c X1 轨道流走队列（`claude/m6c-stream`）

- 契约：`docs/plan/m6c-contract.md` X1
- worktree：`.worktrees/m6c-stream`，分支 `claude/m6c-stream`（基于 `claude/m6` `2398902`）
- 端口：只用 5410～5419；单测端口 0。没推送、没合并、没装依赖、没建 junction、没跑 `npm ci`。
- 结论：X1 的功能与验收全部做完；G0 全过；G0-R 里 `stream-produce-probe`（不带 `--group`）有一条**计时门槛**没过（1080p 全幅分段编码 p50 310 ms，门槛 300 ms），按回退规则（时序类问题）没有重跑、没有排查，交回主会话判断。其余 G0-R 全过。

## 1. 做了什么

| 文件 | 改动 |
|---|---|
| `server/frame-stream.mjs` | `StreamProducer` 新增 `capable()`（开关开着且探到编码器才 true，探不到关掉生产者，同 `runWorker`）、`queueOwned(state)`、`queueState(entry, spec)`、`produceRange(entry, spec, range, { signal, progress })`；常量 `QUEUE_SEGMENT_ATTEMPTS = 3`。`runSegment` 接受 `task.queue`：队列产的分段不按版本（`generation`）作废，只在任务中止 / 生产者关闭 / 流被换掉时作废，`storeSegment` 收 `generation: null` 时不判版本；`task.job` 交出编码收尾的 promise。`nextTask` / `needsSparseAnywhere` 跳过归队列的流。`update()` 保留队列正在产（`queueHolds > 0`）的流，接手 `queueOnly` 的流时去掉这个标记 |
| `server/frame-pipeline.mjs` | `planForQueue` 回 `{ entry, context, streamSpecs }`，`context.streams` 由 `queueStreamSpecs(entry)` 给（与 `StreamProducer.update` 同一个 `planStreams` 调用、同一组参数）；新增 `queueStreamSpecs`、`streamCapable`、`renderStreamRange` |
| `server/prerender-executor.mjs` | `render` 接 `kind: 'stream'`：本机不能产流抛 `no-streams`（不可重试）；按 `input.contentKey` 对回这一版的流，核对结果键是本机指纹的、分段范围在流内，对不上抛 `plan-mismatch`；交给 `renderStreamRange`。不再抛 `stream-not-supported` |
| `server/render-node/split.mjs` | 流任务 `requires.capabilities = { streams: true }` |
| `server/render-node/filter.mjs` | 规则 2 加一条（只加这一条）：`requires.capabilities.streams === true` 而节点 `(capabilities.streams ?? capabilities.transcode) !== true` → `{ rule: 2, reason: 'streams' }` |
| `server/vite-plugin-frames.ts` | `nodeCapabilities(service)`：`{ userCards: true, graphCards: false, transcode: s, streams: s }`，`s = FramePipeline.streamCapable()`。PC 节点与独立渲染主机（`createRenderHost({ capabilities })`）都用它；`queue.started` 日志带上能力 |
| `server/test/stream-queue.test.mjs`（新） | X1-* 共 11 条，见第 3 节 |
| `server/test/render-node-logic.test.mjs` | B.4 流任务的 `requires` 全形状期望加 `capabilities: { streams: true }`（契约要求的形状变化） |
| `server/test/prerender-executor.test.mjs` | J10 里流任务的期望从 `stream-not-supported` 改为 `no-streams`（契约：不再抛 `stream-not-supported`；该用例的管线 `interactive: false`，没有生产者） |
| `scripts/probes/queue-mode-probe.mjs` | `--streams` 显式 `PROMPTCUT_STREAMS=1`，不给时 `=0`；断言流任务全部 `done`、每节点每个流任务恰好一次 `task.done`、由执行器产出（不是去重）；关着时断言流任务 0 条。新增 `--peer [--peer-port]`：第二台队列模式编辑器（自己的空帧库、同一文档服务），两台同时 preload；开流时两边流库逐段比 sha256（`compareStreams`，分段与 init） |

**编码器不进结果键、不进卡片锁、只进清单**：流键 = `resultKeyOf(contentKey, 指纹)`，`contentKey` 由 `cardStreamIdentity` 算，不含编码器（原本如此，X1-render 断言两台编码器不同的管线算出的流键相同）；编码器只在 `segmentSignature` 和清单的 `inits[].encoder` / `segments[].encoder` 里。取用方 `adoptSegments` 把分段记 `adopted: true`，`segmentState` 不按本机编码器重算签名（C6.2 已有）。卡片锁：队列的锁键 `stream:<contentKey>`（F.1 已有），本次没改。

**队列模式下谁产流**：比照 J.12 第 1 条，队列模式的 entry（`entry.queueSnapshots === true`）的流归队列产，本机自动生产（`runWorker`）跳过它们；`queueOwned` 现读 entry 的标记，`leaveQueueMode` 清掉标记后自动生产立即接手。不这样做的话，本机 preload 会先把流产完，队列的流任务全部走去重。执行器只产满密度分段（stride 1），队列模式下没有「先稀疏」那一趟。

**每段清单与推送**：沿用 C6.2 / C6.4 的 `createAssetSink`：`put` 经 `collectStreamResult` → `pushResult`（`px`）→ `writeManifest`（`render-manifest`，键 `<resultKey>:<from>-<to>`），回 `{ complete: true, result: StreamResult }`；local-node 展开进 `task.done`；订阅方 `applyResult` → `adoptSegments` 落地（`vite-plugin-frames.ts` 原本就接了 `kind: 'stream'`）。这几处代码本次没改，X1-render 与探针验证了它们。

## 2. 基线与 G0-R（原始关键行）

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0 |
| 全量测试 | `npm test` | `ℹ tests 2608` `ℹ pass 2607` `ℹ fail 0` `ℹ cancelled 0` `ℹ skipped 1`，退出码 0 |
| 导出确定性 | 本 worktree 起 dev server 5410；`node scripts/verify-determinism.mjs --url "http://127.0.0.1:5410/?export=1"` | `Total Frames: 1800` `Identical: 1800` `Different: 0`，退出码 0 |
| 快照重放一致 | `node scripts/verify-unified-frames.mjs --origin http://127.0.0.1:5410` | `PASS: no video during B; all HTML frames; exact video seek; random replay; cache hits; cumulative C equals A; streamed video contains all 10 frames.`，退出码 0 |
| 导出像素与 main | 临时 `git worktree add --detach .worktrees/m6c-stream-main-baseline main`（`4130a5f`），5416 起它的 dev server 跑同一条 `verify-determinism`（main 也是 1800/1800），scratchpad 里的 pngjs 脚本逐帧逐像素比两边 `out/verify-a/frames` | `{"frames":1800,"sameBytes":1800,"diffFrames":0,"diffPixels":0,"missing":0,"extra":0}`。临时 worktree 删前查过没有 reparse point，已 `git worktree remove --force` |
| ready-index-probe | `node scripts/probes/ready-index-probe.mjs --port 5413` | 退出码 0，`"fails": []` |
| stream-produce-probe `--group` | `node scripts/probes/stream-produce-probe.mjs --origin http://127.0.0.1:5410 --group` | 退出码 0，`"fails": []`，`PASS` |
| stream-produce-probe（不带 `--group`） | `node scripts/probes/stream-produce-probe.mjs --origin http://127.0.0.1:5410` | **退出码 1**，唯一一条：`1080p 全幅流 15 帧分段编码 ≤ 300 ms(无别的编码器争 CPU) :: {"clipId":"clip-bg","rect":{"x":0,"y":0,"w":1920,"h":1080},"captureMsFor15":695,"encodeMs":[293,310,311],"p50":310,"bytes":426118,...}`；编码器 `libx264`。其余断言（分段、签名、替换、重启重发）都过 |
| preview-fallback-probe | `--origin http://127.0.0.1:5410`；同上加 `--page-preload` | 两条都退出码 0、`PASS`，`transparentBeats: 0` |

**stream-produce-probe 那一条的判断（未排查，按回退规则交回）**：这是计时门槛，p50 310 ms 对 300 ms。基准直接调 `openStreamSegmentEncoder`（`server/bakery/ffmpeg.mjs`，本分支没改）编 3 次，与本分支改的自动生产 / 队列路径无关；本机选到的编码器是 `libx264`（没有硬件编码器可用），1080p 全幅编码本来就贴着门槛。按「偶发 / 时序才复现的问题立刻停手」，没有重跑、没有在 main 上对照。建议主会话在空闲时重跑一次，或在 main 上跑同一条对照。

## 3. X1 验收

### 单测（`server/test/stream-queue.test.mjs`，11/11 过）

```
✔ X1-filter 流任务要求 capabilities.streams:报 true 的节点收,报 false 的不收(规则 2 streams);没报这一项的旧节点按 transcode;纯浏览器不收
✔ X1-split 流任务带 requires.capabilities.streams = true;快照任务不带;结果键 = 内容键 × 指纹
✔ X1-plan 开关开着、探到编码器:plan 的 streams 是这一版的全部流(流键 = 内容键 × 本机指纹,与生产者算的相同);PROMPTCUT_STREAMS=0 时为空、不能产流
✔ X1-encoder-probe 探不到编码器:streamCapable 为 false,plan 不出流,生产者关掉
✔ X1-render 执行器按段产出流任务的分段(满密度)、报进度;sink 推 px、写每段清单(<resultKey>:<from>-<to>)、回 StreamResult;另一节点 applyResult 经 adoptSegments 落地,逐段 sha256 一致、不判旧
✔ X1-render-skip 已经是满密度、不旧的分段不重产;本机只有稀疏分段时补成满密度
✔ X1-mismatch 流任务对不上这一版的流:内容键、结果键(别的指纹)、分段范围越界 → plan-mismatch(不可重试),不截图
✔ X1-abort 中途中止:拒绝(cancelled),不再产后面的分段;之后用新信号重做能补齐
✔ X1-owned 队列模式的 entry(queueSnapshots)的流不自动产;退回本机(queueSnapshots=false)后自动生产接手
✔ X1-hold 队列正在产的流:换一版(新计划里没有它)时 state 不丢,在产的分段照常落盘
✔ X1-attempts 一个分段连续失败 QUEUE_SEGMENT_ATTEMPTS 次:任务以可重试的错误失败
ℹ pass 11  ℹ fail 0
```

不用 Chrome、不用 ffmpeg：`bakery/index.mjs`、`bakery/bake.mjs` 换成假的；`bakery/ffmpeg.mjs` 用真导出，只换掉找 ffmpeg、选编码器、分段编码器，假编码器产结构合法的 fMP4（字节随输入与编码器名变）。X1-render 里两条管线的编码器不同（`h264_nvenc` / `libx264`）。

### queue-mode-probe（开流、两个队列节点）

命令：`node scripts/probes/queue-mode-probe.mjs --streams --peer --normal-port 5410 --queue-port 5413 --peer-port 5416 --docservice-port 5419 --timeout-min 15`，退出码 0。末行原始 JSON：

```json
{"ok":true,"tasks":7,"done":7,"identical":true,"differentFrames":0,"identicalIgnoringStyleOrder":true,"differenceSummary":{},"streamTasks":2,"streamDone":2,"streamCompare":{"streams":2,"segments":12,"missing":0,"mismatched":0,"perStream":{"50d75787b9f3":{"segments":6,"adoptedByMain":6,"adoptedByPeer":0},"5cb9ae65ee2f":{"segments":6,"adoptedByMain":6,"adoptedByPeer":0}}},"fails":[]}
```

同一次运行里取出的流任务明细（`runs.queue`）：

```json
{
 "streamTasks": 2, "streamDone": 2,
 "streamDoneCounts": {
  "main": { "stream:5cb9ae65…68fd:0-5": 1, "stream:50d75787…c5a1:0-5": 1 },
  "peer": { "stream:5cb9ae65…68fd:0-5": 1, "stream:50d75787…c5a1:0-5": 1 }
 },
 "streamBy": { "stream:5cb9ae65…68fd:0-5": "peer", "stream:50d75787…c5a1:0-5": "peer" },
 "mainStats": { "claimed": 2, "completed": 2, "dedup": 0, "failed": 0, "done": 8, "applied": 7, "applyErrors": 0 },
 "peerStats": { "claimed": 6, "completed": 5, "dedup": 0, "failed": 0, "planSplit": 1, "done": 8, "applied": 7, "applyErrors": 0 },
 "queueEvents": [], "peerEvents": []
}
```

（流键在这里截短了；报告外的完整输出在 scratchpad。）读法：

- 7 个细任务（5 个快照、2 个流）全部 `done`，没有失败；两个流任务都由 peer 节点的执行器产出（`completed`，不是去重）；
- 两个节点对每个流任务各恰好收到一次 `task.done`；
- 主节点经 `task.done` 的 `applyResult` → `adoptSegments` 取用了 peer 产的 12 个分段（`adoptedByMain` 6 + 6），与 peer 的文件逐段 sha256 相同（分段与 init 都比），`missing: 0`、`mismatched: 0`；
- 快照部分与普通模式逐字节相同（`identical: true`）。

### 关流对照（`PROMPTCUT_STREAMS=0`，行为同 M5b）

`node scripts/probes/queue-mode-probe.mjs --normal-port 5410 --queue-port 5413 --docservice-port 5419 --timeout-min 15`，退出码 0：

```json
{"ok":true,"tasks":5,"done":5,"identical":true,"differentFrames":0,"identicalIgnoringStyleOrder":true,"differenceSummary":{},"streamTasks":0,"streamDone":0,"streamCompare":null,"fails":[]}
```

### stream-produce-probe（含 `--group`）

见第 2 节：`--group` 退出码 0；不带 `--group` 退出码 1（计时门槛），未排查。

## 4. 与契约不一致之处、需要主会话定的事

1. **转码能力**：节点侧过滤规则 2 原有的「`kind: 'stream'` 要 `capabilities.transcode`」没动（只许加 streams 一条）。所以节点除了报 `streams` 还得报 `transcode`，否则认领不了流任务。本分支让两者用同一个判据（探到能用的 H.264 编码器）。若测试方按契约只报 `streams: true` 不报 `transcode`，这样的节点会被原规则 2 拦下，集成对账时请留意；要改就得改原规则（例如流任务只看 `streams`），需主会话定。
2. **没报 `streams` 的节点**：新规则对没有 `streams` 这一项的节点按 `transcode` 算（兼容 M6c 之前的节点形状与既有测试夹具，N 系列等不改就能过）；报了 `false` 的一律不收。
3. **队列模式下本机不自动产流**：契约没写，比照 J.12 第 1 条定的，理由见第 1 节。后果：队列模式下没有「先稀疏后补密」，流只按任务产满密度分段；PC 连不上文档服务时 `leaveQueueMode` 之后自动生产接手。
4. **谁发布流任务**：认领 `plan` 的节点在本机能产流（开关开着、探到编码器）时才切出流任务。若认领 `plan` 的节点关着流、而本机开着，本机的流在队列模式下既不自动产、也没有任务（遗留，第 5 节）。
5. **既有测试的改动**：B.4 一条（流任务 `requires` 形状）、J10 一条（`stream-not-supported` → `no-streams`），都是契约要求的形状 / 行为变化。F 节 Q、N、L、W 系列没改，全过。
6. **任务进行中收到的主会话补充裁定**（X3 主机订阅、X4 `preferred`、X5 门槛、X2 `localMedia`）都属于 `claude/m6c-queue` 的 X2～X5；按派工「不要改 queue.mjs 的认领与可见性逻辑、local-node 的闲时门槛」，本分支没有实现，也没跑 render-host-probe。若其中要本分支做的部分（例如 `planTaskOf` 的 `preferNode`），请主会话另行指派。

## 5. 遗留

- `stream-produce-probe`（不带 `--group`）的 1080p 编码计时门槛，见第 2 节。
- 第 4 节第 4 条：`plan` 由关着流的节点切分时，发布方本机的流在队列模式下没人产。
- 纯浏览器节点：仓库里还没有浏览器节点的实现，`streams: false` 由过滤规则保证（X1-filter 覆盖），接线等浏览器节点落地时做。
- 队列产的流只在 `update()` 换版时才会从生产者的内存里清掉；独立渲染主机不调 `update()`，`queueOnly` 的 state 会一直留着（只有清单，体积小；与附件第 6 节「entries 从不回收」同一类，M6 之后一起处理）。
- 独立渲染主机的流任务只有单测覆盖（执行器与生产者同一套代码），没有跑主机探针。
