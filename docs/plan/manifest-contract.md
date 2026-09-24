# 产物清单、跨节点去重与无条件推送契约（C6.4）

主 Agent 定稿，2026-09-25（用户授权自动推进）。实现方与测试方**只照本文写**，互不看对方的代码。

- 计划：`docs/plan/Master-Execution-Plan.md` C6 一节 C6.4 行
- 设计：`docs/plan/cloud-task.md` A3b、A5，文末决议 11
- 独立审查：`docs/reports/REVIEW-c6-agy.md` 第 6 节第 1 条（清单「后写的赢」与分段并发）
- 已落地的前提：
  - C6.2 `docs/plan/artifact-transfer-contract.md`：任务清单的形状、推拉函数、`snap` / `px` 命名空间；
  - C6.3 `docs/plan/docservice-contract.md`：内容库 `content.put` / `get` / `list` / `watch`。

## 0. 范围，以及决议 11 怎么处理

**做**：
1. **清单进内容库**：每一段产物（与队列细任务的一段一一对应）的清单写进内容库，别的机器按键查得到。
2. **跨节点去重**：节点开工前先查内容库里的清单，清单的块都在素材服务上，就直接完成，不渲。
3. **无条件推送**：本机预渲染进程自己产的产物，不经队列的那些也算，按 A5 的优先级排队推到素材服务，并写清单。队列落盘，重启后接着推。
4. **换机取用**：另一台机器打开同一项目，按本机算出的键查清单、拉块、就绪，不渲。

**决议 11 不用改**：
- 清单按**段**拆键：键是 `<resultKey>:<from>-<to>`，也就是任务 id 去掉 `kind:` 前缀，每一段一个键。同一张卡的不同段由不同节点并发产出，写的是不同的键，互不覆盖。
- 同一段被两个节点重复产出，在指纹相同、代码相同的前提下内容相同，后写的赢也无害。
- 独立审查担心的「同指纹多节点分段产同一张卡时丢帧」因此不会发生，决议 11 的「后写的赢、被覆盖方收通知」照常适用。

**不做**：PNG 缓存与 MOV 的入库，队列没有这类任务，第 6 步也没要求它们跨机复用。

## 1. 清单的键与正文

| `kind` | 键 | 正文 |
|---|---|---|
| `snapshot-manifest` | `<resultKey>:<from>-<to>`，`from`、`to` 是本地帧 | C6.2 的 `SnapshotResult` |
| `render-manifest` | `<resultKey>:<from>-<to>`，`from`、`to` 是分段号 | C6.2 的 `StreamResult` |

- `resultKey` 与 `range` 必须与队列细任务的切分完全一致（`split.mjs`：快照每 60 帧一段，流每 8 个分段一段），所以任务清单和内容库清单是同一份东西。
- 不经队列、本机自己产的产物，按同样的段长切出同样的键，见第 4 节。
- 正文超过内容库的 `maxBodyBytes`（256 KiB）就报错，不写。C6.2 已经保证一段不超过 256 KiB。

## 2. 内容库客户端（`server/render-node/content-client.mjs`，新建）

只依赖 Node 内置模块（D1 守门）。

```js
export function createContentClient(endpoint, { timeoutMs = 10_000 } = {}) → ContentClient
// endpoint：M5a 的 WsEndpoint（createWsEndpoint 的返回值），和节点共用同一条连接
ContentClient = {
  put(kind, key, body) → Promise<{ hash, rev? }>,
  get(kind, key) → Promise<{ body, hash, rev? } | null>,     // missing → null
  list(kind, prefix?) → Promise<{ items, truncated }>,
}
```

- **请求与回包的配对**：每个请求带唯一的 `reqId`，按 `reqId` 配回包；收到 `error` 时按 `reqId` 抛出，错误带 `reason`。
- **超时**：超时抛 `code: 'timeout'`。
- **断线**：断线时所有在途请求立即以 `code: 'disconnected'` 失败，不重放。

## 3. 去重（改 C6.2 的 `createAssetSink`）

`createAssetSink({ pipeline, client, content? })` 新增可选的 `content`（`ContentClient`）。

`has(ref)` 的判断顺序：
1. 本机帧库覆盖整段 → `true`，与 C6.2 相同；
2. 否则，给了 `content`：
   - 查 `content.get(kind, key)`；
   - 清单存在、清单里每个块在素材服务上都有（逐个 `client.has`；已有的数量达到清单的全部）、而且清单覆盖整段（快照：`frames` 覆盖 `range` 的每一帧；流：`segments` 覆盖每个分段号）；
   - 三条都满足就回 `true`，并且把清单记在 sink 里；
3. 其它情况 → `false`。

**去重完成时带上清单**：`has` 回 `true` 之后，local-node 会以去重的方式完成任务（D.2 细任务第 1 步）。为了让订阅方拿到清单，sink 提供 `resultFor(ref) → result | null`：本机覆盖的，由 `collect*` 现算；查内容库得到的，直接回记下的清单。M5b 的 local-node 改完成逻辑时，用它把清单放进 `result`。

**`put` 推完之后写清单**：
- `put` 推送成功后，给了 `content` 就再 `content.put(kind, key, result)`；
- 写清单失败只记日志，不影响 `{ complete: true, result }`：任务清单已经在 `task.done` 里了，内容库清单只是给以后复用的；
- 清单超限就不写，记日志。

## 4. 无条件推送（`server/artifact-push.mjs`，新建；`frame-pipeline.mjs`、`frame-stream.mjs` 加钩子）

```js
export function createPushQueue({ pipeline, client, content, dir, log, concurrency = 2 }) → PushQueue
PushQueue = { enqueue(unit, priority), start(), stop(), stats() }
// unit = { kind: 'snapshot' | 'stream', tier?, resultKey, dirKey?, entryKey?, range, canvasHeavy? }
```

**什么时候进队**：
- 快照：`commitSnapshots` 每写完一批，照 C6.2 的段长（`SNAPSHOT_SPAN`），把这一批覆盖到的每一段进队。同一段已经在队里就不重复。
- 流：`storeSegment` 每写完一个分段，把它所在的段（`STREAM_SEGMENTS` 个分段一段）进队。
- 钩子只在 `pipeline` 配了推送队列时生效。没配时（包括所有现有测试和探针），逐路径行为不变。

**这一段的 `resultKey`**：由预渲染进程按与 `split.mjs` 相同的规则算：
- 共享档：`resultKey = snapshotKey`；
- 本地档：`resultKey = resultKeyOf("<entryKey>/<contentKey>", fp)`，`dirKey` 是落盘目录键（E.9）；
- 流：`resultKey = streamKey`。

**优先级（A5 加 A3b 块级），数字越小越先推**：

| 级 | 条件 |
|---|---|
| 0 `normal` | 共享档，而且下面几条都不命中 |
| 1 `low` | 卡是 `canvasHeavy`、图卡、`unknown`、`belowDependent`，或本地档（A5）；或者这一段里 `data:image` 字节占全部 HTML 字节一半以上（A3b 块级；按帧文件计，用与 `scripts/probes/snapshot-size-probe.mjs` 的 `dataImageBytes` 相同的算法，复制过来，不引用探针） |
| 2 `lowest` | 这一段里有超体积（`oversize`）的帧 |

卡级、块级取低的那个（数字大的）。流一律按 1。

**执行**：
- 并发 `concurrency` 段；
- 每段先 `collect*`，再 `pushResult`，再 `content.put` 清单；
- 失败的段按指数退避重试（5 s、30 s、120 s、之后每 10 min），不放弃。

**落盘**：
- 队列存在 `<dir>/push-queue.json`（`dir` 是帧库根），每次进队、完成时写回，写法经 `atomic`；
- 重启时读回，接着推；
- 已完成的段不留在文件里。

**不挡预渲染、不挡编辑**：推送在后台跑，预渲染的每一帧不等它。

**接线**：
- `vite-plugin-frames.ts` 里，预渲染进程只在同时满足下面两条时才建推送队列：
  - 能解析到素材服务的基址（C5 的 `asset-client.ts` / `assetServiceOrigin`）；
  - 能连上文档服务，`resolveDocservice` 回 `remote` 或 `local`。
- 连不上时不建，行为与现在相同。这就是离线。
- 这一处由实现方与主会话确认后再改，改法写进报告。

## 5. 换机取用（`FramePipeline.adoptFromManifests(entry, content, client)`）

给一个活的 entry（某个会话当前版本的 card plan）：
- **逐个查清单**：按 card plan 里每个共享档与本地档的 control，以及每条流，算出它们各段的键，逐段 `content.get`；
- **拉取**：查到的清单交给 C6.2 的 `applyResult` 拉取、落盘、发布；
- **跳过**：本机已经有的段跳过，查不到的段也跳过，由本机照常预渲染；
- 返回 `{ manifests, fetched, written }`。

**调用时机**：预渲染进程收到一个新版本的 `preload`、算出 card plan 之后，**先**调它，再开始后台那一趟。这一处在 `frame-pipeline.mjs` 里，只在配了推送队列（也就是连得上两个服务）时调。

## 6. 测试（Verification）

**`server/test/content-client.test.mjs`**（真文档服务，端口 0，挂 C6.3 的内容库模块，memory 存储）：

| 编号 | 内容 |
|---|---|
| Q1 | `put` 后 `get` 取回相同的正文；`missing` 回 `null`；`list` 按前缀 |
| Q2 | 并发 20 个请求，按 `reqId` 配对，结果不串 |
| Q3 | 服务端不回：超时抛 `timeout`；断线时在途请求抛 `disconnected` |

**`server/test/artifact-dedup.test.mjs`**（两个临时帧库 A、B，一个素材服务、一个文档服务，都是 memory 实现、端口 0）：

| 编号 | 内容 |
|---|---|
| U1 | A 的 sink `put` 一段之后，内容库里有键 `<resultKey>:<from>-<to>` 的清单，正文等于 `result` |
| U2 | B 本机没有，内容库有清单且块都在：`has` 为 `true`，`resultFor` 回的就是这份清单；B 没有调执行器 |
| U3 | 清单在，但缺一个块（从素材服务删掉）：`has` 为 `false` |
| U4 | 清单只覆盖部分帧：`has` 为 `false` |
| U5 | 同一张卡的两段由 A、B 各产一段：内容库里两个键都在，互不覆盖；第三台 C 拉这两段，都能拉全 |

**`server/test/artifact-push.test.mjs`**（一个临时帧库，素材服务与文档服务都是 memory 实现）：

| 编号 | 内容 |
|---|---|
| W1 | 配了推送队列的管线 `commitSnapshots` 写 130 帧（跨 3 段），每段进队恰好一次；推完之后素材服务有全部块，内容库有 3 份清单 |
| W2 | 优先级：同时进队一段共享档、一段本地档、一段含超体积帧的，推送顺序是 normal → low → lowest |
| W3 | `data:image` 占比过半的段按 low 推 |
| W4 | 推到一半停掉（`stop()`），从同一个 `dir` 重建队列：未完成的段接着推，已完成的不重推（数 `put` 的上传次数） |
| W5 | 素材服务对某段返回 500：这一段按退避重试（注入时钟），最后成功；别的段不受影响 |
| W6 | 没配推送队列的管线：`commitSnapshots` 与 `storeSegment` 的行为和写盘内容，与 C6.2 之后的 main 完全一样 |

**`server/test/artifact-adopt.test.mjs`**：

| 编号 | 内容 |
|---|---|
| A1 | A 预渲染（直接写帧库）并推送完；B 用同一份 card plan 调 `adoptFromManifests`：B 的帧库与 A 逐字节相同，就绪索引发布了对应的层，B 没有调任何渲染 |
| A2 | 部分段在内容库里没有：只拉有的，返回的计数正确 |

## 7. 文件归属

| 子分支 | 文件 |
|---|---|
| `claude/c6-4-node` | `server/render-node/content-client.mjs`（新）、`server/render-node/index.mjs`（加出） |
| `claude/c6-4-pipeline` | `server/artifact-transfer.mjs`（第 3 节）、`server/artifact-push.mjs`（新）、`server/frame-pipeline.mjs`（钩子与 `adoptFromManifests`）、`server/frame-stream.mjs`（钩子）、`server/vite-plugin-frames.ts`（第 4 节末段的接线） |
| `claude/c6-4-tests` | 第 6 节的四个测试文件（新），需要的 `server/test/fake-*.mjs` |
| 主 Agent | 本文；C6.4 报告；W3 |

## 8. 验收

- **G0 通用门槛**。
- **G0-R 必跑**：改了 `frame-pipeline.mjs` 和 `frame-stream.mjs`。
  - `verify-determinism` 1800/1800；
  - `verify-unified-frames` PASS；
  - 与 main 的导出逐像素 0 差异；
  - `ready-index-probe`、`stream-produce-probe`（含 `--group`）、`preview-fallback-probe`（含 `--page-preload`）全部退出码 0。
  - 这几项都在**没配推送队列**的默认状态下跑。
- **第 6 节全过**。
- **W3（换机不重渲）**：主 PC 起一个配了推送队列的预渲染；打开示例项目，预渲染完、推送完。笔记本拉同一分支、打开同一份项目文件，也配推送队列，连同一对服务。断言：
  - 笔记本的 `adoptFromManifests` 拉全了主 PC 已产的段；
  - 这些段在笔记本上不触发渲染（看预渲染诊断里的渲染计数）；
  - 就绪层来自同一组键。
  - 两台机器指纹相同，所以键完全一致（W0 实测）。
