# C5 素材服务数据层实现报告

- 角色：c5-impl（`claude/c5-impl`，基于 `claude/c5` 的 `fdf8963`；中途按主会话要求合入 `claude/c5` 的 `bb39dbe`，拿到契约第 8 节）
- 依据：`docs/plan/asset-store-contract.md` 第 2～5 节与第 8 节；语义 `docs/semantics/architecture/asset-storage.md`、`document-service.md`「连接发现」
- 可改文件：新建 `server/asset-store/{index,blob-store,fs-store,memory-store}.mjs`、`server/asset-announce.mjs`；修改 `server/asset-service.ts`、`server/vite-plugin-media.ts`（只改 `mediaPlugin()` 接线）；`server/test/asset-service.test.mjs` 只在 `compile(...)` 替换表里加行
- 端口段：5460～5469（实现 5460，舞台 5461/5462；main 基线 5463，舞台 5464/5465）

## 进度

- [x] `server/asset-store/`（接口、fs、memory、oss 插槽）
- [x] HTTP 层改走 `BlobStore`
- [x] 写入鉴权
- [x] 地址登记 `asset-announce.mjs`
- [x] `mediaPlugin()` 接线
- [x] 契约第 8 节补改
- [x] 基线：tsc、npm test
- [ ] G0-R（见下文「验证」，跑完补）

## 做了什么

### `server/asset-store/`

- `blob-store.mjs`：用 JSDoc 写明 `BlobStore`、`PutResult`、`CompleteResult` 和共同规则；放两种实现共用的小工具：`BLOB_CHUNK_SIZE`、哈希归一（小写，格式不对抛 `TypeError`）、`ext` 归一（去点、小写，非空但不是 1～8 位字母数字抛 `TypeError`，因为它会拼进文件名）、分片数与片长、`extOfName`（与 `vite-plugin-media.ts` 同一写法）、按键串行锁、`drainSource`、最小扩展名表。
- `fs-store.mjs`（`createFsStore({ dir, hooks, chunkSize? })`）：逐行照搬原 `asset-service.ts` 的暂存与入库逻辑。
  - 布局不变：`<dir>/<hash>[.<ext>]`；`<dir>/.chunks/<hash>/{meta.json,data,<n>.ok}`；`meta.json` 仍经 `meta.<8hex>.tmp` 改名写入；
  - 收尾时关掉读句柄再把 `data` 改名成全件；入库后调 `hooks.onStored({ hash, file, ext, size, contentType })`，`file` 是文件名；
  - 锁放在模块级、按「目录 + 哈希」取键，同一目录建了几个实例也串行；
  - 没注入的钩子有缺省：`resolveFile` 在目录里按 `<hash>` / `<hash>.*` 找，`onStored` 空操作，`contentTypeForExt` 用最小表；
  - `usage` 只数 `<hash>` 与 `<hash>.<ext>` 形状的文件（同一哈希只算一次），`staging` 数 `.chunks` 下以哈希命名的目录。
- `memory-store.mjs`（`createMemoryStore({ chunkSize?, now? })`）：分片放在 Map 里，收尾按片号拼接算哈希；`mtimeMs` 取入库时刻；`size` 超过 256 MiB 回 `size-mismatch`（第 8 节第 7 条）。
- `index.mjs`：`createBlobStore`、`BLOB_CHUNK_SIZE`，另转出两个工厂；`oss` 抛 `code: 'not-implemented'`，未知 `kind` 抛 `TypeError`。

### `server/asset-service.ts`

- 不再 import `fs` / `path` / `stream`；字节一律经 `store`。缺省 `store` 是 `defaultAssetStore(root)`：fs 实现，钩子用 `resolveHashFile`、`writeMediaIndex`、`contentTypeForExt` 组装。
- `assetServiceMiddleware(root, { store?, token?, isTrusted? })`：
  - `token` 在创建时读一次 `PROMPTCUT_CLUSTER_TOKEN`；传了 `token`（含 `null`）就以传入为准；空串当没设；
  - 路由、校验顺序、状态码、回包 JSON、CORS 头照旧；结果到回包按契约第 3 节的表映射；`size-mismatch` / `out-of-range` 仍走 `reject`（按声明长度读完或掐断），`length` / `discarded` 直接回；
  - `GET` / `HEAD media/<hash>` 改为 `serveBlob`：`store.stat` + `parseRange` + `store.read`，响应头的名字、顺序与原 `serveFile` 相同；`mtimeMs` 为 `null` 时不发 `Last-Modified`；读流先打开再发头，读流出错时掐断响应。
- 保留原有导出（`chunkStatus` 多了可选的第三个参数 `store`），新增导出 `AssetBlobStore`、`AssetServiceOptions`、`defaultAssetStore`、`isLoopbackRequest`。
- 文件头的契约补上「写入鉴权」一节，预检头加 `Authorization`，「存储」一节改指 `fs-store.mjs`。

### 写入鉴权

- 管 `PUT media/<hash>/<n>` 与 `POST media/<hash>/complete`：方法对了就先判鉴权，不通过直接 `reject(401, { ok: false, error: 'unauthorized' })`，不看长度等其它校验；入库后的重传与收尾同样要令牌。
- 放行：`isTrusted(req)`（抛错当不信任），或 `Authorization` 匹配 `/^Bearer[ \t]+(\S+)$/i`，令牌两边各取 sha256 后 `timingSafeEqual`。没配令牌时非本机一律 401。
- 缺省 `isTrusted` = `isLoopbackRequest`：用 `http-guard.mjs` 的 `clientAddressOf` 取对端，再判回环（见「契约疑点」2）。
- `ASSET_ALLOW_HEADERS` 加 `Authorization`。本模块不打任何日志；回包里没有令牌。

### `server/asset-announce.mjs`

- `lanAssetUrls`：非 internal、`family` 为 `'IPv4'`（或老 Node 的数字 4）且在 10/8、172.16/12、192.168/16 里的地址，拼成 URL 后去重、按 URL 字符串字典序排序；`port` 缺省或不合法返回 `[]`。
- `startAssetAnnounce`：`url` 为空返回空操作；`urls` 为空打一行 `asset-announce.skip` 并返回空操作（不建连接）；否则建端点（令牌空串当没设），每次 `onOpen` 发一次 `service.announce`，收到 `error` 只打 `asset-announce.error`；`stop()` 幂等，端点 `connected !== false` 时先发 `service.withdraw`，再 `close()`。建端点抛错只打日志、返回空操作。
- 缺省 `announcerId` 是 `asset:<主机名>`（第 8 节第 1 条），主机名里 `[A-Za-z0-9._:-]` 以外的字符换成 `-`，截到 128 字符（G.6 的规则）。

### `mediaPlugin()` 接线

- `PROMPTCUT_DOCSERVICE_URL` 已设且有 `httpServer` 时：等 `listening`（已在听就立即），取实际绑定地址；回环就不登记；否则惰性 import `asset-announce.mjs`，按实际端口算 `lanAssetUrls`，绑在某个具体地址（不是 `0.0.0.0` / `::`）时只留这个地址；`httpServer` 的 `close` 事件里 `stop()`。
- 日志只打 `asset-announce.*`、`ws.open`、`ws.close`（端点的重连日志太密）。整段包在 try/catch 里，出错只 `console.warn`。

### 测试文件

`server/test/asset-service.test.mjs` 只在替换表里加了一行，把 `from "./asset-store/index.mjs"` 改写成绝对 file URL；断言一个字没动。

## 验证

（G0-R 跑完后补全本节。）

## 契约疑点

1. **缺省 `announcerId` 的 `@`**：第 5 节原文 `asset@${hostname}` 会被 G.6 的 `announcerId` 规则拒收（自测里实际发给真文档服务，回 `error { reason: 'bad-message', detail: 'announcerId 不合法' }`）。已由第 8 节第 1 条改为 `asset:${hostname}`，照改。另外我对主机名做了字符清洗和截断，正常主机名下与 `asset:${os.hostname()}` 完全相同。
2. **缺省 `isTrusted`**：第 3 节写「`socket.remoteAddress` 是回环」。舞台端口的反向代理从 127.0.0.1 转回 vite，照字面判，经舞台端口进来的局域网请求也会算本机、不要令牌就能写。所以缺省实现用 `http-guard.mjs` 的 `clientAddressOf`：对端是回环时改看代理写进的真实对端（`x-pc-stage-client`，只在对端是回环时才信）。直连请求的判定与字面一致；只会更严，不会放宽。没有 socket 的请求不算本机（与 `fromLocalClient` 不同，取保守的一边）。
3. **`startAssetAnnounce` 在 `urls` 为空时不建连接**：契约说「不登记，打一行 log」，没说连不连。不连最省事，也不会占控制面的连接。
4. **`stop()` 的「连着的话」**：注入的假端点可能没有 `connected` 字段，按 `connected !== false` 判，真端点没连上时 `send` 本来就会丢弃。
5. **接线里绑定具体地址时只报这一个**：契约只说「按实际端口算 `lanAssetUrls`」。绑在某个网卡地址上时，别的网卡连不进来，报了也没用，所以只保留与绑定地址相同的那条。绑 `0.0.0.0` / `::`（`npm run dev` 的情形）不受影响。
6. **memory 实现超上限时 `size-mismatch` 带的 `size`**：第 8 节没说。已有登记时给登记的 size，没有时给上限 256 MiB。
7. **`ext` 不合法时抛 `TypeError`**：契约只说哈希格式不对抛。`ext` 会拼进 fs 的文件名，HTTP 层递进来的一定合法，直接调用数据层时不合法就抛，不静默丢掉。
8. **G0-R 的基线 worktree**：`git worktree add .worktrees/c5-baseline main` 报 `main` 已在主工作区检出，改用 `--detach` 建在同一提交 `95f9aa7` 上。
