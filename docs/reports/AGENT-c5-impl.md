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
- [x] G0-R

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

以下都在 `.worktrees/c5-impl` 里、以最终代码（含契约第 8 节补改）跑。

### 基线

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误 |
| 全量测试 | `npm test` | 退出码 0；tests 2247，pass 2246，fail 0，skipped 1（`集成:/api/cards/layout 对真实项目返回整数框`，要 5190 的那一条） |
| 原有素材服务测试 | `node --test server/test/asset-service.test.mjs` | 11/11 通过（断言未改，只加了替换表一行） |

### G0-R

dev server：`npx vite --port 5460 --strictPort --host 127.0.0.1`（舞台 5461/5462）；main 基线 worktree 用 5463（舞台 5464/5465）。改完契约第 8 节后重启过 5460 再跑下面各项。

| 项 | 命令 | 结果 |
|---|---|---|
| 导出确定性（实现） | `node scripts/verify-determinism.mjs --url "http://127.0.0.1:5460/?export=1"` | 退出码 0，Total 1800，Identical 1800，Different 0 |
| 导出确定性（main 基线） | 同上，打 5463，在 `c5-baseline` 里跑 | 退出码 0，1800/1800 相同 |
| 与 main 逐像素对比 | 自测脚本 `pixel-compare.mjs` 比两边 `out/verify-a/frames/*.png`（解码后比 RGBA） | `{"frames":1800,"pixelIdentical":1800,"different":0,"fileBytesIdentical":1800}`，PNG 文件逐字节也相同 |
| 导出与快照重放一致 | `PC_FRAME_TEST_URL=http://127.0.0.1:5460 node scripts/verify-unified-frames.mjs` | 退出码 0，`PASS: no video during B; all HTML frames; exact video seek; random replay; cache hits; cumulative C equals A; streamed video contains all 10 frames.`（这一项的视频素材走 `/@media/<name>`） |
| 兜底顺序探针 | `node scripts/probes/preview-fallback-probe.mjs --origin http://127.0.0.1:5460` | 退出码 0，`PASS`；276 拍，transparentBeats 0，fails []，pageErrors [] |
| 就绪索引探针（契约第 7 节列了） | `node scripts/probes/ready-index-probe.mjs --port 5466` | 退出码 0，fails []（它自己起 5466 与临时端口的预渲染进程，跑完自己关） |

跑完关掉了自己起的 5460、5463 两台 dev server（先核对了进程命令行是自己起的那两条），5460～5469 全部空出。`c5-baseline` 删之前查过没有 junction（`Get-ChildItem -Attributes ReparsePoint` 为空；里面的 `node_modules` 是 vite 自己建的依赖缓存目录，不是链接），用 `git worktree remove --force` 删掉；删后主仓库 `node_modules` 仍在（182 项，`vite`、`typescript` 都在）。

### 自测（scratch，不提交）

脚本都在 scratchpad 的 `c5-impl/` 下，参数是 worktree 的绝对路径。

1. `store-selftest.mjs`：fs（临时目录，`chunkSize` 1024）与 memory 各跑一遍 K1～K16 的要点（未知哈希、幂等、size 冲突、长度不符、越界、缺片、篡改、入库、入库后重传、并发、remove、usage、ext 先到为准、大小写、oss / 未知 kind、fs 布局），另测 memory 超 256 MiB 回 `size-mismatch`、fs 的 `usage` 不数 `index.json` 与普通文件。输出 `PASS fs`、`PASS memory`、`memory >256MiB: {"status":"size-mismatch","size":268435456}`、`fs usage: {"blobs":1,"bytes":3,"staging":0}`，退出码 0。
2. `http-selftest.mjs`：把 **main 上的** `asset-service.ts` / `vite-plugin-media.ts` 和本分支的各转译一份，各起一个服务，打同一串 46 个请求（断点续传、各种 4xx、405、Range 各形态、HEAD、`/@media`、X-Media-Type 反查、无扩展名、哈希不符、预检含 / 不含私有网络等），逐个比较状态码、响应头（按顺序，只把 Date / Last-Modified 的值换掉）和回包字节：`compared 46, same 46, diffs []`（唯一允许的差别是预检头多了 `, Authorization`）。两边 `out/media` 的目录树与每个文件的 sha256 相同（含 `index.json`、收了一半的 `.chunks/<hash>/{meta.json,data,1.ok}`，`meta.json` 逐字节相同）。
   鉴权：`isTrusted` 注入为假时，不带令牌 / 令牌错 / `Basic` 方案 / 收尾不带令牌 / 分块传输不带令牌都是 401，`GET`、`chunks` 不要令牌，令牌对（`bearer` 小写也行）照常；`token: null` 非本机一律 401，本机照常；缺省读 `PROMPTCUT_CLUSTER_TOKEN`；缺省 `isTrusted` 下带 `x-pc-stage-client: 192.168.1.9` 的请求 401、普通回环请求 200；回包、日志里都找不到令牌原文（日志 0 行）。
   memory 注入（8 MiB）与 fs 打同一串 13 个请求，回包逐字节相同（含 Last-Modified 以外的头）。输出 `ALL PASS`，退出码 0。
3. `announce-selftest.mjs`：N1（注入网卡表，排除 internal、IPv6、公网、172.32；结果 `["http://10.0.0.20:5190/api/asset","http://10.0.0.2:5190/api/asset","http://172.16.5.4:5190/api/asset","http://192.168.50.20:5190/api/asset"]`；没 port 回 `[]`）；N2/N3（假端点：两次 onOpen 发两次 announce、stop 先 withdraw 再 close、url 为空或 urls 为空都不建端点、日志没有令牌）；N4（带令牌的真文档服务：缺省登记者 `asset:DESKTOP-GS40TCK` 登记成功，另一条连接 `service.watch` 收到这份地址，stop 后收到空列表）。另外把字面的 `asset@<主机名>` 发给真文档服务，回 `{"type":"error","reason":"bad-message","detail":"announcerId 不合法"}`，证实第 8 节第 1 条。退出码 0。
4. 接线端到端（`docservice-watch.mjs` 起一台带令牌的文档服务在 127.0.0.1:5469 并订阅 `asset`；另起 `PROMPTCUT_DOCSERVICE_URL=ws://127.0.0.1:5469 npx vite --port 5466 --strictPort --host 0.0.0.0`，测完即关）：
   - vite 日志 `asset-announce.announce {"announcerId":"asset:DESKTOP-GS40TCK","urls":["http://192.168.50.96:5466/api/asset"],"sent":true}`，订阅方收到同一条登记；
   - 从本机经局域网地址 `http://192.168.50.96:5466/api/asset/...` 打（对端不是回环）：不带令牌、令牌错都回 `{"ok":false,"error":"unauthorized"}`；带令牌 PUT 200、`BEARER` 大写收尾 200；不带令牌读 Range、`chunks` 正常；
   - 强杀 vite 后约 1 秒宽限到期，订阅方收到空列表；用 vite 的 `createServer` 起同样配置再 `server.close()`，`asset-announce.stopped` 之后 26 ms 订阅方就收到空列表（走的是 `stop()` 的撤回，不是宽限）；
   - `PROMPTCUT_DOCSERVICE_URL=http://not-ws`：只打一行 `asset-announce.error {"stage":"connect",...}`，vite 照常起、照常关；指向没人听的端口：照常起，关时 `stopped`。

### 没做的

- W2（笔记本上跑 `asset-lan-probe.mjs`）是测试方与主会话的事，不在本任务。
- 用 vite 的 `createServer` 起服、并设了 `PROMPTCUT_DOCSERVICE_URL` 时，Node 报一条 `MaxListenersExceededWarning: 11 listening listeners added to [Server]`：别的插件已经挂了 10 个 `listening` 监听，接线又挂了 1 个。只在设了这个环境变量时出现，不影响功能；没去改全局上限。

## 契约疑点

1. **缺省 `announcerId` 的 `@`**：第 5 节原文 `asset@${hostname}` 会被 G.6 的 `announcerId` 规则拒收（自测里实际发给真文档服务，回 `error { reason: 'bad-message', detail: 'announcerId 不合法' }`）。已由第 8 节第 1 条改为 `asset:${hostname}`，照改。另外我对主机名做了字符清洗和截断，正常主机名下与 `asset:${os.hostname()}` 完全相同。
2. **缺省 `isTrusted`**：第 3 节写「`socket.remoteAddress` 是回环」。舞台端口的反向代理从 127.0.0.1 转回 vite，照字面判，经舞台端口进来的局域网请求也会算本机、不要令牌就能写。所以缺省实现用 `http-guard.mjs` 的 `clientAddressOf`：对端是回环时改看代理写进的真实对端（`x-pc-stage-client`，只在对端是回环时才信）。直连请求的判定与字面一致；只会更严，不会放宽。没有 socket 的请求不算本机（与 `fromLocalClient` 不同，取保守的一边）。
3. **`startAssetAnnounce` 在 `urls` 为空时不建连接**：契约说「不登记，打一行 log」，没说连不连。不连最省事，也不会占控制面的连接。
4. **`stop()` 的「连着的话」**：注入的假端点可能没有 `connected` 字段，按 `connected !== false` 判，真端点没连上时 `send` 本来就会丢弃。
5. **接线里绑定具体地址时只报这一个**：契约只说「按实际端口算 `lanAssetUrls`」。绑在某个网卡地址上时，别的网卡连不进来，报了也没用，所以只保留与绑定地址相同的那条。绑 `0.0.0.0` / `::`（`npm run dev` 的情形）不受影响。
6. **memory 实现超上限时 `size-mismatch` 带的 `size`**：第 8 节没说。已有登记时给登记的 size，没有时给上限 256 MiB。
7. **`ext` 不合法时抛 `TypeError`**：契约只说哈希格式不对抛。`ext` 会拼进 fs 的文件名，HTTP 层递进来的一定合法，直接调用数据层时不合法就抛，不静默丢掉。
8. **G0-R 的基线 worktree**：`git worktree add .worktrees/c5-baseline main` 报 `main` 已在主工作区检出，改用 `--detach` 建在同一提交 `95f9aa7` 上。
