# C6.2 素材服务侧（c6-2-asset）报告

- 角色：c6-2-asset；分支 `claude/c6-2-asset`（自 `claude/c6-2` 的 71236d0 起）；worktree `.worktrees/c6-2-asset`
- 依据：`docs/plan/artifact-transfer-contract.md` 第 1、2、8 节；`docs/plan/asset-store-contract.md`
- 文件：`server/asset-service.ts`、`server/http-guard.mjs`（只改 `isAssetServicePath` 那一处：正则与它上面的注释）、`server/asset-store/client.mjs`（新）、`server/asset-store/index.mjs`（加出 `createAssetClient`）

## 做了什么

### 命名空间（契约第 1 节）

- 路由 `/api/asset/<ns>/<hash>[/chunks|/complete|/<n>]`，`<ns>` ∈ `media` | `snap` | `px`。`http-guard.mjs` 的 `ASSET_ROUTE` 从 `media` 扩成 `(?:media|snap|px)`，中间件和同源守卫仍用同一个判据。
- `assetServiceMiddleware(root, opts)`：
  - `opts.stores?: { media?, snap?, px? }`；旧的 `opts.store` 仍认，当作 `stores.media`（两个都给时 `stores.media` 优先）；
  - `media` 缺省仍是 `defaultAssetStore(root)`，代码路径不变；
  - `snap` / `px` 缺省是 `defaultArtifactStore(root, ns)`：fs 实现，目录 `path.resolve(root, "out", "asset-store", ns)`（`artifactStoreDir`）；钩子只给 `onStored: () => {}` 和 Content-Type 表，`resolveFile` 用 fs 实现自带的「`<hash>` 或 `<hash>.<ext>`」。用到时才建。
  - 子路由、状态码、分片规则、跨源头、写入鉴权三个命名空间走同一段代码。
- 新增导出：`ASSET_NAMESPACES`、`AssetNamespace`、`artifactStoreDir`、`defaultArtifactStore`。
- 产物命名空间的 Content-Type：`html` → `text/html; charset=utf-8`，`m4s` → `video/iso.segment`，其余照 `vite-plugin-media` 的表。
- C5 守门照旧：`asset-service.ts` 只新引了 `path`，没有 fs，也没有字符串里的暂存目录名（H2 用例过）。

### 客户端 `server/asset-store/client.mjs`（契约第 2 节）

`createAssetClient({ base, token, fetch, chunkSize, retries })` → `{ base, put, get, has }`，只用全局 `fetch` 和 `node:crypto`。
- `put`：算 sha256 → `GET chunks`，`complete` 就回 `uploaded: false` → 只 PUT `received` 里缺的片，每片带 `X-Media-Size`，给了 `ext` 就带 `X-Media-Ext` → `POST complete` → `uploaded: true`。
- `get`：404 回 `null`；其余非 2xx 抛；校验 sha256，不符抛 `code: 'hash-mismatch'`。
- `has`：`chunks` 的 `complete`。
- 重试：每个请求各自计数（所以分片就是按片重试），网络错误（含读回包途中断开）和 5xx 重试最多 `retries` 次，间隔 200、400、800 ms，再往后翻倍；次数用尽抛最后一次的错误（网络错误 `code: 'network'`，5xx 带 `status`、`body`）。4xx 不重试，错误带 `status` 和回包 `body`。
- 令牌：给了就在每个请求上加 `Authorization: Bearer …`。异常信息里出现令牌原文的地方换成 `***`，不挂原始错误对象（`cause` 只留 `name`、`code`）。
- 参数检查：命名空间不认识、哈希不是 64 位 hex、`ext` 不合 `[a-z0-9]{1,8}`、上传空内容，都同步抛 TypeError / RangeError，不发请求。

## 验证

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误 |
| 全量测试 | `npm test` | 退出码 0；tests 2294，pass 2293，fail 0，skipped 1（`集成:/api/cards/layout 对真实项目返回整数框`，需要 5190） |
| 素材服务相关既有测试 | `node --test server/test/asset-service.test.mjs server/test/asset-store-http.test.mjs server/test/blob-store-conformance.test.mjs server/test/api-guard.test.mjs server/test/http-guard.test.mjs server/test/asset-announce.test.mjs` | 77/77 过，测试文件未改 |
| G0-R | 不跑 | 本分支只改素材服务，没动渲染、预渲染、导出；G0-R 由 pipeline 方跑 |

### 自测（scratch 脚本，不提交，端口 0）

`node <scratchpad>/c62-asset-selftest.mjs <worktree>`：用 typescript 把 `asset-service.ts` 转译后 import，`http.createServer` 挂 `assetServiceMiddleware`，末尾 `next` 回 404 `next`。退出码 0，输出：

```
PASS 三个命名空间 put/get/has，再 put uploaded:false 且无 PUT
PASS 命名空间互不可见（snap 里有、media/px 404）
  complete(media) → {"ok":true,"hash":"c14a…4d9d","size":100,"complete":true,"url":"/@media/c14a…4d9d"}
  complete(snap) → {"ok":true,"hash":"c14a…4d9d","size":100,"complete":true,"url":"/api/asset/snap/c14a…4d9d"}
PASS 不认识的命名空间：中间件 next（这里 404），isAssetServicePath 只认三个
  snap Content-Type text/html; charset=utf-8
  px Range 206 bytes 0-9/9000 video/iso.segment
  目录内容 asset-store | asset-store\px | asset-store\snap | asset-store\px\<暂存目录> | asset-store\px\6772…2b2e.m4s | asset-store\snap\<暂存目录> | asset-store\snap\40c8…9efc.html
PASS 缺省 fs：snap/px 落在 out/asset-store/<ns>，不写媒体索引
PASS 续传：预置第 1 片，只 PUT 0,2,3
PASS 重试：第 1 片 500 两次后成功，耗时 655 ms
PASS 网络错误：retries=2 共发 3 次后抛 code=network
PASS 4xx：只发 1 次，抛出带 status 与 body
  令牌错的异常信息： 素材服务 PUT snap/47d8…bbda/0 回 401：unauthorized
PASS 401：无令牌、令牌错都 401 且异常无令牌原文；令牌对时每个写请求带 Bearer
PASS get：篡改抛 hash-mismatch，404 回 null

10 项全过
```

- 前三项用 memory 实现注入三个命名空间；「缺省 fs」一项只给 `media` 注入 memory，`snap` / `px` 走缺省 fs，检查 `<root>/out/` 下只有 `asset-store/`，没有 `media/`（没写媒体索引）。
- 续传一项 `chunkSize` 1024，先手工 PUT 第 1 片，再 `client.put`，数到的 PUT 只有 0、2、3。
- 重试一项用包一层的假 fetch 让第 1 片前两次回 500，PUT 序列是 0、1、1、1、2，耗时 ≥ 600 ms（200 + 400）。
- 401 一项：服务端配随机令牌、`isTrusted: () => false`；不带令牌、令牌错都 401；异常的 message、body、stack 里都找不到令牌原文；令牌对时每个非 GET 请求都带 `Bearer <令牌>`；假 fetch 抛出含令牌的网络错误，异常与 `cause` 里也没有令牌。

附加 `node <scratchpad>/c62-mime.mjs <worktree>`（三个命名空间全用缺省 fs，只带 `X-Media-Type`），退出码 0：

```
media text/html → application/octet-stream true
snap text/html → text/html; charset=utf-8 true
px video/iso.segment → video/iso.segment true
media index.json: true   （只有 media 那一件进了媒体索引；snap/px 文件是 <hash>.html、<hash>.m4s）
```

## 契约疑点（都按最保守的读法做了，请主 Agent 定）

1. **`MIME_TO_EXT` 加两项 vs「`media` 一个字节都不变」**：第 1 节说 `MIME_TO_EXT` 加 `text/html → html`、`video/iso.segment → m4s`。如果加进共用的表，`media` 收到 `X-Media-Type: text/html` 的上传，落盘文件名会从 `<hash>` 变成 `<hash>.html`，这是 `media` 的外部行为变化。实现里新表只给 `snap` / `px` 用，`media` 的反查表不动。
2. **收尾回包的 `url`**：第 1 节说三个命名空间回包完全相同，但 `media` 的 `url` 是 `/@media/<hash>`，而老路由只对应 `media`，给 `snap` 回这个地址会指错东西。实现里字段集合相同，`snap` / `px` 的 `url` 是 `/api/asset/<ns>/<hash>`。S2 如果逐字段比较 `complete` 回包，`url` 这一项需要按命名空间比。
3. **目录与 `PROMPTCUT_EXPORT_DIR`**：`media` 的目录经 `outRoot` 认 `PROMPTCUT_EXPORT_DIR`；契约写的是 `<root>/out/asset-store/<ns>`。实现照字面，固定用 `<root>/out`，不认这个环境变量。要跟 `media` 一致的话，改 `artifactStoreDir` 一行即可。
4. **不认识的命名空间（S4）**：`isAssetServicePath` 不认，中间件直接 `next()`，本身不回 400 / 404、不落状态。在 vite 里它会落到后面的处理器上：同源请求多半是 vite 的 404，跨源的 `/api/**` 被同源守卫回 403。S4 若要求素材服务自己回 400 / 404，需要另定。
5. **分片大小以服务端为准**：客户端的 `chunkSize` 选项只在 `chunks` 回包没给 `chunkSize` 时用。`received` 是按服务端的片号编的，两边不一致时照选项切片必然 409 / 400。L2 如果把客户端 `chunkSize` 调小却不调服务端，行为会是按服务端的 8 MiB 切。
6. **重试范围**：契约写「按片重试」。实现对 `chunks`、`complete`、`get` 也同样重试（都是幂等请求）。
7. **没有超时**：契约没提，客户端不设请求超时；对端挂住不回时 `put` / `get` 会一直等。建议 M5b 接入时由调用方传带超时的 `fetch`，或者在契约里加一个 `timeoutMs`。
8. **`snap` 目录的查找开销**：fs 实现缺省的 `resolveFile` 每次 `stat` / `chunks` 都 `readdir` 整个目录。快照块多了以后（几万个文件）每个请求都是 O(n)。本阶段按契约用缺省；`asset-service.ts` 不许碰 fs，要优化得在 `fs-store.mjs` 里加「先按 `<hash>.<ext>` 直接 stat」之类的快路径，不在本分支的文件清单里。

## 没做的

- 没改 `frame-pipeline.mjs`、`frame-stream.mjs`、`server/test/` 下任何文件。
- 没跑 G0-R（理由见上）。没推送、没合并。
