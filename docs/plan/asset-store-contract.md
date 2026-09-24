# 素材服务数据层与集群接入契约（C5）

主 Agent 定稿，2026-09-25（用户授权自动推进）。实现方与测试方**只照本文写**，互不看对方的代码。本文要改只能由主 Agent 改，并同时通知各方。

- 计划：`docs/plan/Master-Execution-Plan.md` 第 5.2 节、第 7 节 C5
- 语义：`docs/semantics/architecture/asset-storage.md`；`document-service.md`「连接发现」（素材服务地址下发已引入）
- 现有契约：`server/asset-service.ts` 文件头（第 5 步的 HTTP API）。**本文不改那份 HTTP 契约的任何外部行为**，只在它下面加一层数据层，另加写入鉴权与地址登记。

## 0. 现状更正

计划写 C5 时以为 `cloud-task.md` 第 5 步没做，实际已经在 main 上了：
- `8b8ad2c`：空壳、分片上传、对账、收尾校验、按哈希取回、跨源；
- `2944743`：导出与镜头拼图读素材只经素材服务。

所以 C5 的实际范围收窄为三件事，外加 W2：
1. 把现有 `server/asset-service.ts` 改成只经数据层接口 `BlobStore` 读写（计划第 5.2 节）；
2. 非回环来源的写请求要带集群令牌；
3. 编辑器进程把本机素材服务的局域网地址登记到控制面（D7，用 M5a 的服务地址登记模块）。

`docs/plan/TODO.md`「语义与代码的差距」里「素材服务：还不存在」那一条已经过时，本阶段顺带更正。

**不在本阶段**：
- `/@media/<hash>` 老读路由仍由 `vite-plugin-media.ts` 的 `mediaMiddleware` 按文件答。它就是 fs 实现自己的本地读路径，C6 做两档时再挪到数据层后面；
- 两档、上传队列、换档、按需拉取（第 6 步）。

## 1. 文件与归属

| 子分支 | 文件 |
|---|---|
| `claude/c5-impl` | 新建 `server/asset-store/index.mjs`、`blob-store.mjs`、`fs-store.mjs`、`memory-store.mjs`、`server/asset-announce.mjs`；修改 `server/asset-service.ts`、`server/vite-plugin-media.ts`（只改 `mediaPlugin()` 的接线）；`server/test/asset-service.test.mjs` **只许在 `compile(...)` 的替换表里加行**，断言一个字不改 |
| `claude/c5-tests` | 新建 `server/test/blob-store-conformance.test.mjs`、`server/test/asset-store-http.test.mjs`、`server/test/asset-announce.test.mjs`、`scripts/probes/asset-lan-probe.mjs` |
| 主 Agent | 本文；`docs/plan/TODO.md` 的更正；`docs/reports/REPORT-c5.md` |

`server/asset-store/` 下全是 `.mjs`，只引 Node 内置模块，不引 `.ts`（单测直接 import，不用转译）。

## 2. `BlobStore` 接口（`server/asset-store/blob-store.mjs` 用 JSDoc 写明）

```js
// server/asset-store/index.mjs
export { createBlobStore, BLOB_CHUNK_SIZE } …
export function createBlobStore(options) → BlobStore
// options.kind === 'fs'     → createFsStore(options)
// options.kind === 'memory' → createMemoryStore(options)
// options.kind === 'oss'    → 抛 Error，err.code === 'not-implemented'（插槽，不装任何 SDK）
// 其它                       → 抛 TypeError

BLOB_CHUNK_SIZE = 8 * 1024 * 1024

BlobStore = {
  kind: 'fs' | 'memory',
  chunkSize: number,
  stat(hash) → Promise<{ size, ext, contentType, mtimeMs } | null>,
  read(hash, { start, end } = {}) → Promise<Readable | null>,
  chunks(hash) → Promise<{ size: number | null, chunkSize, received: number[], complete: boolean }>,
  putChunk(hash, n, { size, ext }, source) → Promise<PutResult>,
  complete(hash) → Promise<CompleteResult>,
  remove(hash) → Promise<boolean>,
  usage() → Promise<{ blobs: number, bytes: number, staging: number }>,
}

PutResult =
  | { status: 'ok', bytes }
  | { status: 'complete' }                    // 已入库：请求体读完丢掉，不落盘
  | { status: 'size-mismatch', size }         // 与已登记的 size 不同
  | { status: 'out-of-range', count }         // n >= count
  | { status: 'length', expected, got }       // 实收字节与这一片应有长度不符；这一片不算收到
  | { status: 'discarded' }                   // 写的过程中暂存被收尾丢弃了

CompleteResult =
  | { status: 'ok', size, ext }               // 入库成功，或早已入库
  | { status: 'unknown' }                     // 从没见过
  | { status: 'incomplete', missing: number[] }
  | { status: 'hash-mismatch', actual }       // 已收分片全部丢弃
```

各方法的约定：
- **`stat`**：只认已入库的全件；`mtimeMs` 在拿不到修改时间的实现里可以是 `null`。
- **`read`**：闭区间，`end` 缺省到末尾；没入库返回 `null`。
- **`chunks`**：从没见过的哈希返回 `size: null`、`received: []`；已入库返回全部片号、`complete: true`。
- **`putChunk`**：`source` 是可读流或异步可迭代的 Buffer。

**共同规则**（照现在 `asset-service.ts` 的行为，两种实现一样）：
- **哈希**：64 位十六进制，大小写不敏感，一律按小写存取。格式不对抛 `TypeError`（HTTP 层在调用前已经挡掉）。
- **分片**：分片数 `max(1, ceil(size / chunkSize))`；除最后一片外每片恰好 `chunkSize` 字节。
- **扩展名**：`ext` 以最先登记的非空值为准，之后不改。
- **串行**：同一哈希的登记与收尾串行执行，分片字节的写入不排队。并发写同一哈希的不同分片，结果与顺序写相同。
- **一片算不算收到**：先撤掉这一片的「收到」标记，写完、长度核对无误再补上标记。中途失败、断流、长度不符，都只会让这一片算「没收到」。
- **收尾**：按片号顺序对全件算 sha256。
  - 不符：丢弃这个哈希的全部暂存，之后 `chunks` 报 `received: []`；
  - 相符：入库。入库后再 `putChunk` 回 `complete`、不落盘，再 `complete` 回 `ok`。
- **`remove`**：删掉已入库的全件和暂存；删到了返回 `true`。
- **`usage`**：`staging` 是有暂存的哈希个数。

**fs 实现**（`createFsStore({ dir, hooks })`）：
- 目录布局与今天**逐字节一致**：
  - 全件：`<dir>/<hash>.<ext>`（没有扩展名就是 `<dir>/<hash>`）；
  - 暂存：`<dir>/.chunks/<hash>/`，里面是 `meta.json`、`data`（按偏移原位写）、`<n>.ok`。
- `hooks` 由调用方注入，fs 实现不自己引 `vite-plugin-media.ts`：
  - `resolveFile(hash) → Promise<string|null>`：找已入库的文件，要兼容老的整件导入；
  - `onStored({ hash, file, ext, size, contentType })`：入库后写媒体索引；
  - `contentTypeForExt(ext)`。
- 收尾时直接把 `data` 改名成全件，不再拷一遍。Windows 上改名前要先关掉句柄。

**memory 实现**（`createMemoryStore({ chunkSize? })`）：
- 全部放在内存里，`chunkSize` 可以调小，方便测试；
- `mtimeMs` 取入库时刻，`contentType` 按一张最小的扩展名表给（mp4、webm、mov、png、jpg、wav、mp3，其余 `application/octet-stream`）。

## 3. HTTP 层（`server/asset-service.ts`）

```ts
assetServiceMiddleware(root: string, opts?: { store?: BlobStore, token?: string | null, isTrusted?: (req) => boolean })
```

**默认值**：
- `store`：`createBlobStore({ kind: 'fs', dir: mediaDir(root), hooks })`，`hooks` 用 `vite-plugin-media.ts` 已有的 `resolveHashFile`、`writeMediaIndex`、`contentTypeForExt` 组装；
- `token`：`process.env.PROMPTCUT_CLUSTER_TOKEN ?? null`，在创建中间件时读一次；
- `isTrusted`：请求的 `socket.remoteAddress` 是回环地址（`127.0.0.0/8`、`::1`、`::ffff:127.*`）。

**外部行为一个字节都不变**：路由、状态码、回包 JSON、CORS 头都照文件头的第 5 步契约。唯一的例外是下文的写入鉴权。

结果到 HTTP 回包的映射：

| 结果 | 回包 |
|---|---|
| `putChunk` → `ok` | 200 `{ ok: true, hash, n, bytes }` |
| `putChunk` → `complete` | 200 `{ ok: true, hash, n, bytes: <这一片应有长度>, complete: true }` |
| `putChunk` → `size-mismatch` | 409 `{ ok: false, error: 'size-mismatch', size }` |
| `putChunk` → `out-of-range` | 416 `{ ok: false, error: 'chunk-out-of-range', count }`（HTTP 层先按 size 算过，一般到不了这里） |
| `putChunk` → `length` | 400 `{ ok: false, error: 'chunk-length', expected, got }` |
| `putChunk` → `discarded` | 409 `{ ok: false, error: 'staging-discarded' }` |
| `complete` → `ok` | 200 `{ ok: true, hash, size, complete: true, url: '/@media/<hash>' }` |
| `complete` → `unknown` | 404 `{ ok: false, error: 'unknown-hash' }` |
| `complete` → `incomplete` | 400 `{ ok: false, error: 'incomplete', missing }` |
| `complete` → `hash-mismatch` | 409 `{ ok: false, error: 'hash-mismatch', actual }` |

`GET` / `HEAD media/<hash>`：
- 用 `store.stat` 加 `store.read` 答；Range 用 `vite-plugin-media.ts` 已导出的 `parseRange`；
- 响应头与今天的 `serveFile` 完全一样：200 / 206 / 416，`Content-Type`、`Content-Length`、`Accept-Ranges: bytes`、`Last-Modified`（取 `mtimeMs`，是 `null` 就不发）、`Content-Range`；
- 没入库回 404 `{ ok: false, error: 'not-found' }`。

**守门**：`asset-service.ts` 的源码里不许出现 `from "fs"`、`from "fs/promises"`、`from "node:fs"`、`createReadStream`、`createWriteStream`，也不许出现 `.chunks` 目录名。

## 4. 写入鉴权

- **管哪些请求**：`PUT media/<hash>/<n>`、`POST media/<hash>/complete`。**读**（`GET` / `HEAD`、`chunks`、`OPTIONS`）不管，照语义允许局域网跨源访问。
- **放行条件**：`isTrusted(req)` 为真（本机）；或者请求头 `Authorization: Bearer <令牌>` 与 `token` 相符（两边各取 sha256，再用 `timingSafeEqual` 比较）。
- **不放行**：回 401 `{ ok: false, error: 'unauthorized' }`，并按现有的 `reject` 规则处理请求体（读完扔掉或掐断）。
- **没配令牌**（`token` 为 `null`）：非本机的写一律 401，失败即关。本机的写照常。
- 预检的 `Access-Control-Allow-Headers` 加上 `Authorization`（`ASSET_ALLOW_HEADERS` 常量同步改）。
- 令牌原文不进日志、不进回包。

## 5. 地址登记（`server/asset-announce.mjs`，D7）

```js
export function lanAssetUrls({ interfaces = os.networkInterfaces(), port, basePath = '/api/asset' }) → string[]
export function startAssetAnnounce({
  url,                       // 控制面地址（ws:// 或 wss://）；为空就什么都不做，返回 { stop() {} }
  token,                     // 集群令牌
  announcerId,               // 缺省 `asset@${os.hostname()}`
  urls,                      // lanAssetUrls 的结果；为空数组就不登记，打一行 log 说明
  createEndpoint,            // 缺省 createWsEndpoint（server/render-node/ws-transport.mjs）
  log,
}) → { stop() }
```

- **`lanAssetUrls`**：
  - 取所有非 internal 的 IPv4 地址里属于私有网段（`10/8`、`172.16/12`、`192.168/16`）的；
  - 每个拼成 `http://<ip>:<port><basePath>`，按地址字典序去重排序；
  - `port` 缺省时返回 `[]`。
- **`startAssetAnnounce`**：
  - 每次 `onOpen` 发一次 `service.announce { announcerId, kind: 'asset', urls }`；
  - 收到 `error` 就打日志，不重试（重连时自然会再登记）；
  - `stop()` 先发 `service.withdraw`（连着的话），再 `close()`。
- **接线**（`vite-plugin-media.ts` 的 `mediaPlugin()`）：
  - 条件：`httpServer` 开始监听、实际绑定的地址不是回环、`PROMPTCUT_DOCSERVICE_URL` 已设；
  - 满足时按实际端口算 `lanAssetUrls`，惰性 import `asset-announce.mjs` 调 `startAssetAnnounce`；
  - `httpServer` 关闭时 `stop()`；
  - 任何一步出错只打日志，不影响编辑器启动。
- 这里的 `/api/asset` 就是现有 HTTP API 的基址（`asset-service.ts` 文件头），取字节是 `GET <url>/media/<hash>`。

## 6. 测试（测试方）

测试名以编号开头。

**`blob-store-conformance.test.mjs`**：同一套用例对 `fs`（临时目录，`hooks` 用一份最小的测试实现）和 `memory`（`chunkSize` 调小）各跑一遍。

| 编号 | 内容 |
|---|---|
| K1 | 没见过的哈希：`chunks` 为 `size: null`、`received: []`；`stat`、`read` 为 `null`；`complete` 为 `unknown` |
| K2 | `putChunk` 成功；同一片重传结果相同（幂等） |
| K3 | 同一哈希报不同 size → `size-mismatch`，已收的不动 |
| K4 | 实收字节多了或少了 → `length`，这一片不算收到 |
| K5 | `n` 越界 → `out-of-range` |
| K6 | 缺片时 `complete` → `incomplete`，`missing` 正确 |
| K7 | 字节被篡改 → `hash-mismatch`，之后 `received: []`，`stat` 为 `null` |
| K8 | 全部到齐 → `ok`；`stat` 正确；`read` 全件与区间的字节都对 |
| K9 | 入库后再 `putChunk` → `complete`；再 `complete` → `ok` |
| K10 | 所有分片并发 `putChunk`，再 `complete`：结果与顺序写相同 |
| K11 | `remove` 后 `stat` 为 `null`，`chunks` 为未知；第二次 `remove` 返回 `false` |
| K12 | `usage` 的计数正确 |
| K13 | `ext` 以最先登记的非空值为准 |
| K14 | 大写哈希与小写哈希是同一个 |
| K15 | `createBlobStore({ kind: 'oss' })` 抛出，`code === 'not-implemented'`；未知 `kind` 抛 `TypeError` |
| K16 | fs 实现的目录布局：入库后 `<dir>/<hash>.<ext>` 存在、`.chunks/<hash>` 不存在；入库前暂存目录里有 `meta.json`、`data`、`<n>.ok` |

**`asset-store-http.test.mjs`**：`asset-service.ts` 照现有 `asset-service.test.mjs` 的办法转译后 import，注入 `memory` 实现（`chunkSize` 必须是 8 MiB，HTTP 契约写死了）。

| 编号 | 内容 |
|---|---|
| H1 | 注入 memory 实现后：断点续传、409 校验、Range 206 / 416、`HEAD`、跨源头，都与 fs 实现的回包相同（逐个字段比较） |
| H2 | 守门：`asset-service.ts` 源码里没有第 3 节列的文件系统引用 |
| H3 | `isTrusted` 注入为 `false`：不带令牌 `PUT` / `POST complete` → 401；令牌错 → 401；令牌对 → 照常；`GET`、`chunks` 不要令牌 |
| H4 | `token: null` 且非本机：写入一律 401；本机（`isTrusted` 为真）照常 |
| H5 | 预检回的 `Access-Control-Allow-Headers` 含 `Authorization` |
| H6 | 被拒、通过各试几次，日志和回包里都没有令牌原文 |

**`asset-announce.test.mjs`**：

| 编号 | 内容 |
|---|---|
| N1 | `lanAssetUrls` 在注入的网卡表上只取私有网段 IPv4，排除 internal、IPv6、公网地址，结果排序去重；没有 `port` 返回 `[]` |
| N2 | `startAssetAnnounce` 用假端点：每次 `onOpen` 发一次 `service.announce`，字段正确；`url` 为空时什么都不做 |
| N3 | `urls` 为空不登记；`stop()` 先发 `service.withdraw` 再关 |
| N4 | 对真文档服务（端口 0，挂服务地址登记模块）：登记后，另一条连接 `service.watch { kinds: ['asset'] }` 收到这份地址 |

**`scripts/probes/asset-lan-probe.mjs`**（W2 在笔记本上跑；只用 Node 内置，不需要 `node_modules`）：

```
node scripts/probes/asset-lan-probe.mjs --docservice <ws://…> [--asset <http://…/api/asset>] [--mb 20] [--timeout-ms 60000]
```

- 令牌从 `PROMPTCUT_CLUSTER_TOKEN` 读。
- 没给 `--asset` 时：连控制面，`service.watch { kinds: ['asset'] }`，取第一个登记里第一个能 `GET …/media/<一个不存在的哈希>/chunks` 通的地址。**地址来自控制面下发，不手填**，这正是 W2 要证明的。
- 断言：
  1. 随机生成 `--mb` MB 数据，算出哈希；
  2. 不带令牌 `PUT` 第 0 片 → 401；
  3. 带令牌只传第 0、1 片，`chunks` 报 `received: [0, 1]`；
  4. 补传其余分片，`complete` → 200；
  5. 带 `Origin: http://192.168.50.247:9999` 的 `GET` 有 `Access-Control-Allow-Origin: *`；
  6. `Range: bytes=100-199` → 206，字节正确；
  7. 全件下载后 sha256 相符。
- 输出一行 JSON：`{ ok, assetUrl, source: 'docservice' | 'arg', bytes, steps: [{ name, ok, ms }], fails: [] }`。
- 退出码：0 全过，1 有断言失败，2 连不上。

## 7. 验收（合并前）

- G0 通用门槛：`npx tsc -b --force` 零错误；`npm test` 失败 0、跳过 ≤ 1；第 6 节全部用例通过；`asset-service.test.mjs` 的断言没改、全过。
- **G0-R 必跑**：导出和预渲染经 HTTP 读素材。
  - `verify-determinism` 1800/1800；
  - `verify-unified-frames` PASS；
  - 与 main 的导出逐像素 0 差异；
  - `ready-index-probe`、`preview-fallback-probe` 退出码 0。
- **W2**：笔记本跑 `asset-lan-probe.mjs`，地址由控制面下发，全部断言通过。
