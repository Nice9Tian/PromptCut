# 预渲染产物推拉契约（C6.2）

主 Agent 定稿，2026-09-25（用户授权自动推进）。实现方与测试方**只照本文写**，互不看对方的代码。本文要改只能由主 Agent 改，并同时通知各方。

- 计划：`docs/plan/Master-Execution-Plan.md` C6 一节的 C6.2 行
- 设计：`docs/plan/cloud-task.md` A3b（本文把其中与任务结果有关的 `[DRAFT]` 定下来）；`docs/plan/distributed-prerender-queue.md` 第 6 节
- 语义：`docs/semantics/architecture/asset-storage.md`「预渲染的产物」；`document-service.md`「渲染任务队列」的「完成」一条：节点先把产物推送到素材服务，再报完成；各方从素材服务取字节
- 现有接口：`docs/plan/asset-store-contract.md`（C5 的 `BlobStore`）；`render-queue-contract.md` D.1（`sink`）、E.9（本地档键的换算）

## 0. 范围

**做**：队列任务的两类产物（HTML 快照，含共享档与本地档；轨道流的 init 与分段）。
1. 按内容哈希推到素材服务；
2. 把「这一段由哪些块组成」的**任务清单**放进 `task.complete` 的 `result`，随 `task.done` 送到订阅方；
3. 订阅方按清单拉块，经现有的写入函数落盘，再发布进就绪索引。

**不做，挪到 C6.4，与内容库的清单一起**：
- 跨节点的「开工前查素材服务去重」：没有按结果键查清单的地方。本阶段的 `has` 只看本机磁盘；
- A3b「所有产物无条件推送」里任务之外的那部分，以及 A5 的推送优先级。本机预渲染进程自己产的、不经队列的产物，没有清单就没人找得到，推上去也没用；
- PNG 缓存与 MOV：队列里没有这类任务。

**依据**：`task.done` 本来就带 `result`（契约 A.7.4）。清单很小：一段 60 帧快照大约 5 KB，一段轨道流不到 2 KB。放进队列消息没有问题，单条上限 1 MB。

## 1. 素材服务的命名空间（`server/asset-service.ts`）

- 基址 `/api/asset` 下的路由扩成 `/api/asset/<ns>/<hash>…`，`<ns>` ∈ `media` | `snap` | `px`。
  - `media`：现有素材，行为一个字节都不变；
  - `snap`：HTML 快照块；
  - `px`：像素产物，本阶段只用于轨道流的 init（`.mp4`）和分段（`.m4s`）。
  - 这就是 `cloud-task.md` A3b 的 `snap/<hash>`、`px/<hash>`，`[DRAFT]` 就此定下。
- **三个命名空间各一个 `BlobStore`**：
  - `media` 照旧（C5）；
  - `snap`、`px` 用 fs 实现，目录分别是 `<root>/out/asset-store/snap`、`<root>/out/asset-store/px`；
  - 这两个的钩子不写媒体索引：`resolveFile` 只按 `<hash>[.<ext>]` 找，`onStored` 什么都不做。
- **子路由、状态码、回包、分片规则、跨源头、写入鉴权**：三个命名空间完全相同（C5 契约第 3、4 节）。老路由 `/@media/*` 只对应 `media`。
- `MIME_TO_EXT` 加 `text/html → html`、`video/iso.segment → m4s`。扩展名仍然以 `X-Media-Ext` 优先。
- `http-guard.mjs` 的素材服务路径判据 `isAssetServicePath` 扩到三个命名空间。同源守卫的豁免范围就跟着扩了，只扩这三个。
- `assetServiceMiddleware(root, opts)` 的 `opts.store` 改名为 `opts.stores?: { media?, snap?, px? }`。旧的 `opts.store` 仍然认，当作 `stores.media`。

## 2. 客户端（`server/asset-store/client.mjs`，新建）

只用 Node 内置模块（全局 `fetch`、`node:crypto`）。

```js
export function createAssetClient({ base, token = null, fetch = globalThis.fetch, chunkSize = 8 * 1024 * 1024, retries = 3 }) → AssetClient
// base：素材服务的 API 基址，形如 http://192.168.50.96:5460/api/asset

AssetClient = {
  put(ns, bytes: Buffer, { ext } = {}) → Promise<{ hash, size, uploaded: boolean }>,
  get(ns, hash) → Promise<Buffer | null>,       // 404 → null；下载后校验 sha256，不符就抛
  has(ns, hash) → Promise<boolean>,             // GET <ns>/<hash>/chunks 的 complete
}
```

**`put` 的流程**：
1. 算 sha256；
2. 先问 `chunks`：已经 `complete` 就不传，`uploaded: false`；
3. 否则只传 `received` 里缺的片，每片都带 `X-Media-Size`、`X-Media-Ext`；
4. 再 `complete`；
5. 带了令牌就加 `Authorization: Bearer <令牌>`。

**重试**：网络错误和 5xx 按片重试，最多 `retries` 次，间隔 200 ms、400 ms、800 ms。4xx 不重试，直接抛，错误对象带 `status` 和回包。

令牌原文不进异常信息。

## 3. 任务清单（放在 `task.complete` 的 `result` 里）

**快照**（`kind: 'snapshot'`）：

```js
SnapshotResult = {
  v: 1, kind: 'snapshot', tier: 'shared' | 'local',
  resultKey,                 // 任务的结果键
  dirKey,                    // 落盘目录键：共享档 = resultKey；本地档 = resultKeyOf(去掉 "<entryKey>/" 前缀的内容键, 任务的锁指纹)（E.9）
  entryKey,                  // 本地档必填；共享档为 null
  range: { from, to },       // 本地帧，闭区间，与任务一致
  canvasHeavy: boolean,      // 决定体积上限（snapshot-store 的 snapshotLimit）
  frames: [[localFrame, hash, bytes], …],   // 这一段里已产出的每一帧，按帧升序；超体积的帧也在内
}
```

**轨道流**（`kind: 'stream'`）：

```js
StreamResult = {
  v: 1, kind: 'stream',
  resultKey,                 // = streamKey
  range: { from, to },       // 分段号，闭区间
  header: { kind, plane, clipIds, fps, bound, offset, tight },     // 取自 stream.json 顶层
  inits: { [initId]: { hash, bytes, codec, width, height, timescale, rect, encoder } },   // 只列本段分段用到的 init
  segments: { [n]: { hash, bytes, init, stride, samples, sig, encoder } },               // 本段里已产出的分段
}
```

**约束**：
- `result` 的 JSON ≤ 256 KiB。超了，实现要报错，不许截断。
- `v` 以外出现不认识的字段时，拉取方忽略它们。

## 4. 推送端（`server/artifact-transfer.mjs`，新建）

这个模块可以引 `snapshot-store.mjs`、`frame-stream.mjs`（它们带依赖），所以放在 `server/` 下，**不放** `server/render-node/`（D1 守门）。

```js
export async function collectSnapshotResult(pipeline, task) → SnapshotResult
export async function collectStreamResult(pipeline, task) → StreamResult
export async function pushResult(client, result, readBlob) → { result, uploaded: number, skipped: number }
export function createAssetSink({ pipeline, client }) → Sink     // 实现 D.1 的 sink，另见下
```

**`collect*`**：从本机帧库读这一任务范围里已经落盘的产物。
- 快照读 `index.json` 的 `frames` 与 `oversize`，再读对应帧文件算哈希；
- 流读 `stream.json`；
- 同时返回一个 `readBlob(hash) → Buffer`（闭包里记着哈希到文件的对应），给 `pushResult` 用。

**`pushResult`**：清单里的每个块都 `client.put` 一次，快照进 `snap`、流进 `px`，`put` 本身会跳过已有的块；全部成功才返回。

**`createAssetSink`**：
- `has(ref)`：本机帧库覆盖了整个 `range` 就回 `true`。只看本机，不查素材服务。
- `put({ ...ref, artifacts, meta })`：`artifacts` 本阶段约定为 `null` 或被忽略，字节以本机帧库为准。流程是 `collect*`，再 `pushResult`，全部推完回 `{ complete: true, result }`；清单有缺帧、有块推失败，回 `{ complete: false }`。
- 返回值多了 `result` 字段，这是对 D.1 的**扩展**。`local-node.mjs` 什么时候把它放进 `session.complete(id, { ranges, …result })`，由 M5b 改，本阶段不改 `local-node.mjs`。

## 5. 拉取端

```js
// server/artifact-transfer.mjs
export async function applyResult(pipeline, client, result) → { written: number, skipped: number, fetched: number }
```

**快照**：
1. 本机 `index.json` 里已经有的帧跳过，不下载；
2. 其余帧按 `hash` 从 `snap` 拉，`client.get` 已经校验了 sha256；
3. 经 `pipeline.snapshots().commitSnapshots({ tier, entryKey, key: dirKey, clipId: null, capabilities: { canvasHeavy }, items })` 落盘。超体积由 `commitSnapshots` 自己判；
4. 再调 `pipeline.adoptResult(result)` 发布（见第 6 节）。

**流**：
1. 按清单从 `px` 拉 init 和分段；
2. 交给 `pipeline.streams().adoptSegments(result, blobs)`（第 6 节）。

**不许绕过写入函数**：只有 `commitSnapshots` 和 `adoptSegments` 可以写文件，否则 `index.json` / `stream.json` 会和磁盘不一致（A3b 原文要求）。

## 6. 预渲染管线的接入（`server/frame-pipeline.mjs`、`server/frame-stream.mjs`）

**`FramePipeline.adoptResult(result)`**：
- 快照：
  - 用 `ready-index.mjs` 的 `wireSnapshotKey(tier, entryKey, dirKey)` 算出线上的键；
  - 按落盘后的 `index.json`，`this.ready.stageByKey({ kind, key, ranges: frames })`；
  - 再对每个活着的 entry 调 `claimSessions(entry)`：凡是用到这个键的会话，都能收到 `layer`。
- 流：由 `adoptSegments` 负责发布。
- 不需要知道 `clipId`：键就是内容寻址的，`claimSessions` 会按卡片计划把键对回片段。

**`StreamProducer.adoptSegments(result, blobs)`**（`blobs`：哈希到 Buffer 的映射）：
- **写文件**：init 和分段照现有命名写：`init-<sha16>.mp4`、`<n>-<sha16>.m4s`，经 `atomic` 写入。
- **合并清单**：合进这条流**在内存里**的 `state.manifest`；这条流当前没有 `state` 时新建一个。合并后经 `StreamStore.save` 落盘，不许从外面直接改 `stream.json`，否则会被 producer 覆盖（勘察结论第 3 条）。
- **分段标记**：拉来的分段在清单里记 `adopted: true`，带上对方的 `encoder` 与 `sig`。
  - `segmentState` 对 `adopted` 的分段不按本机的 `encoderName` 重算 `sig`，只要这条流的内容键没变就算新鲜；
  - 否则指纹相同、编码器名不同的机器会把它判成 `stale` 重渲（勘察结论第 2 条）。
- **发布**：照现有的 `publish(state)`。
- 本机已经有、而且不是 `stale` 的分段跳过，不覆盖。

## 7. 测试（Verification）

**`server/test/asset-namespaces.test.mjs`**（`asset-service.ts` 照 C5 的转译办法 import，三个命名空间都注入 memory 实现）：

| 编号 | 内容 |
|---|---|
| S1 | 同一份字节分别传进 `media`、`snap`、`px`：三个命名空间互不可见，一个里有、另一个里 404 |
| S2 | `snap`、`px` 的分片、对账、收尾、Range、HEAD、CORS、401 规则与 `media` 相同，字段逐个比较 |
| S3 | `media` 的全部行为不变：`asset-service.test.mjs`、`asset-store-http.test.mjs` 不改、全过，由 `npm test` 覆盖 |
| S4 | 不认识的命名空间回 400 或 404，不落任何状态；`isAssetServicePath` 只认三个命名空间 |

**`server/test/asset-client.test.mjs`**（真 HTTP，端口 0，素材服务注入 memory 实现）：

| 编号 | 内容 |
|---|---|
| L1 | `put` 后 `has` 为真，`get` 取回的字节一致；再 `put` 同一份，`uploaded: false`，而且没有发任何 PUT（数请求） |
| L2 | 大于一片（`chunkSize` 调小）的对象：只补传缺的片，先预置 `received` 模拟断点 |
| L3 | 服务端对某片回 500 两次再成功：重试后成功；4xx 立即抛出，错误带 `status` |
| L4 | `get` 到的字节被篡改（假 fetch）：抛错；404 回 `null` |
| L5 | 带令牌时每个写请求都有 `Authorization: Bearer …`；异常信息里没有令牌原文 |

**`server/test/artifact-transfer.test.mjs`**（两个临时帧库 A、B，各一个 `FramePipeline`，用现有测试构造它的办法。一个共享的素材服务，端口 0，memory 实现）：

| 编号 | 内容 |
|---|---|
| T1 | A 的共享档写 60 帧快照（`commitSnapshots`，含 1 帧超 300 KB）：`collectSnapshotResult` 的清单帧数、哈希与文件一致；`pushResult` 之后每个块在 `snap` 里都有 |
| T2 | B `applyResult`：B 的 `controls-html/<dirKey>/` 与 A 逐字节相同，`index.json` 一致（包括 `oversize`）；B 的就绪索引 `stageByKey` 了这个键，范围与 `frames` 一致 |
| T3 | 本地档：`dirKey` 与 `entryKey` 的换算符合 E.9；B 落在 `controls-local/<entryKey>/<dirKey>/` |
| T4 | B 已经有一部分帧：只下载缺的（数 `get` 次数），已有的不覆盖 |
| T5 | 流：A 用一份固定的 `stream.json` 加分段文件（可以用 `server/test/` 里现成的夹具，或者按 `frame-stream.mjs` 的格式手工造）；`collectStreamResult`、`pushResult`，B `adoptSegments`：B 的分段文件相同，清单合进 producer 的状态，这些分段在 B 不被判 `stale`，`ready` 发布了 `kind: 'stream'` 的范围 |
| T6 | `createAssetSink`：本机帧库覆盖完整时 `has` 为真；`put` 回 `{ complete: true, result }`，`result` 符合第 3 节；缺一帧时回 `{ complete: false }` |
| T7 | `result` 超过 256 KiB（人为造大）：报错，不截断 |
| T8 | `applyResult` 遇到块在素材服务上不存在（404）：整体失败、抛错，已经写下的帧照样经 `commitSnapshots` 进了索引，不留半截文件 |

## 8. 文件归属

| 子分支 | 文件 |
|---|---|
| `claude/c6-2-asset` | `server/asset-service.ts`、`server/http-guard.mjs`（只改 `isAssetServicePath` 那一处）、`server/asset-store/client.mjs`（新）、`server/asset-store/index.mjs`（如需加出） |
| `claude/c6-2-pipeline` | `server/artifact-transfer.mjs`（新）、`server/frame-pipeline.mjs`（只加 `adoptResult` 与相关小改）、`server/frame-stream.mjs`（只加 `adoptSegments` 与 `adopted` 判定） |
| `claude/c6-2-tests` | 第 7 节的三个测试文件（新），需要的 `server/test/fake-*.mjs` |
| 主 Agent | 本文；C6.2 报告 |

`claude/c6-2-pipeline` 用到的 `createAssetClient` 在 `claude/c6-2-asset` 上，两边并行开发：
- pipeline 方先照第 2 节的接口写一个仅供自测的假客户端，不提交；
- 集成时由主 Agent 合两边。

## 9. 验收

- G0 通用门槛。
- **G0-R 必跑**：改了 `frame-pipeline.mjs`、`frame-stream.mjs`。
  - `verify-determinism` 1800/1800；
  - `verify-unified-frames` PASS；
  - 与 main 的导出逐像素 0 差异；
  - `ready-index-probe`、`stream-produce-probe`（含 `--group`）、`preview-fallback-probe`（含 `--page-preload`）全部退出码 0。
- 第 7 节全过。
- 跨机不单独做：C6.2 的跨机验证并进 M5b 的 W4（笔记本真实渲染、主 PC 拉取）。

## 10. 定稿后的补充细则（2026-09-25，主 Agent 按素材服务侧实现方疑点裁定）

1. **MIME 表分开**：`text/html → html`、`video/iso.segment → m4s` 放进 `snap` / `px` 专用的 MIME 表，不改共享的 `MIME_TO_EXT`，`media` 落盘的文件名因此不变。
2. **收尾回包的 `url`**：`snap` / `px` 收尾成功时，`url` 是 `/api/asset/<ns>/<hash>`；`media` 照旧是 `/@media/<hash>`。
3. **不认识的命名空间**：中间件不处理，交给 `next()`。
4. **分片大小**：以服务端 `chunks` 回包里的 `chunkSize` 为准，客户端的 `chunkSize` 选项只作兜底。
5. **超时**：客户端新增 `timeoutMs`，缺省 30000，按单个请求计时，到点中止。超时算网络错误，照常重试，重试用完就抛，错误带 `code: 'timeout'`。重试不只用于分片上传，也用于 `chunks`、`complete`、`get`。
6. **查找不扫目录**：`snap` / `px` 的 fs 钩子 `resolveFile` 按候选文件名直接查，依次是 `<hash>.html`、`.mp4`、`.m4s`，最后是没有扩展名的 `<hash>`。
7. **目录位置**：`snap` / `px` 的 fs 目录固定在 `<root>/out/asset-store/…`，不看 `PROMPTCUT_EXPORT_DIR`。
8. **`snap` / `px` 只存候选扩展名**：扩展名不在第 6 条候选表里的对象（例如 `X-Media-Ext: bin`），一律存成不带扩展名的 `<hash>`。否则按候选名查找就再也找不到它。这些对象的 HTTP `Content-Type` 本来就是 `application/octet-stream`，对外没有变化。`media` 不受影响。
9. **查候选文件的函数放在 `server/asset-store/index.mjs`**：`asset-service.ts` 不许碰文件系统（C5 守门），所以这个函数不能放在那里。

## 11. 定稿后的补充细则（2026-09-25，主 Agent 按测试方疑点裁定）

1. **`collect*` 的返回值**：`collectSnapshotResult` / `collectStreamResult` 统一返回 `{ result, readBlob }`，签名是 `(pipeline, task, opts?)`。
2. **`canvasHeavy` 的来源**：依次取 `opts.canvasHeavy`、`task.input.canvasHeavy`（是布尔值时），都没有就是 `false`。M5b 由切分节点把它写进 `input`。
3. **sink 的 `ref` 扩展**：`has` / `put` 收到的 `ref` 带上任务的 `input` 与 `requires`。本地档按 E.9，用 `input.entryKey`、`input.contentKey`、`requires.envFingerprint` 算落盘键；缺了这几项时，`has` 回 `false`，`put` 回 `{ complete: false }`。
4. **流的访问器**：沿用 `pipeline.streamProducer()`，它只在 `interactive: true` 的管线上存在。没有 producer 却收到流清单时，`applyResult` 抛错，错误带 `code: 'no-stream-producer'`。
5. **拉取方还没有这条流时**：`adoptSegments` 按 `header` 建出最小的 state，保证之后能发布成功，不许静默失败。
6. **分段的 `encoder`**：取这个分段所用 init 的 `encoder`。
7. **`result` 超限**：超过 256 KiB 时 `collect*` 抛错（`code: 'result-too-large'`），`sink.put` 捕获后回 `{ complete: false }`。
8. **`applyResult` 的计数**：`written` 是实际落盘的帧数 / 分段数，`skipped` 是本机已有而跳过的，`fetched` 是下载的块数，init 也算。
10. **候选扩展名的完整口径**（更正第 10 节第 6 条）：`snap` / `px` 的候选扩展名依次是 `html`、`mp4`、`m4s`、`snap` / `px` 专用 MIME 表（`ARTIFACT_MIME_TO_EXT`）里的全部扩展名（含 `png` 等），最后是 `htm`、`m4v`、`jpeg`。不在这张表里的才按第 8 条存成不带扩展名的 `<hash>`。以实现里的 `ARTIFACT_EXTS` 为准。
