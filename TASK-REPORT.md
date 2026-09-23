# T1b 任务报告：云端计划第 5 步——素材服务空壳与底层 API 契约

分支 `claude/asset-service-step5`（自 main `88ed1fe`），worktree `.claude/worktrees/asset-service-step5`。未推送、未合并。

## 做了什么

| 文件 | 改动 |
|---|---|
| `server/asset-service.ts`（新） | 素材服务本体：分片上传、对账、收尾校验、按哈希取回、跨源、预检。**契约写在文件头**。 |
| `server/asset-client.ts`（新） | 客户端一侧：素材服务基址解析、素材记录 → HTTP 地址（`mediaHttpUrl`）、预渲染进程的素材路由转发插件（`assetProxyPlugin`）。不 import 媒体插件，只认地址。 |
| `server/vite-plugin-media.ts` | `mediaPlugin` 改成 async `configureServer`：惰性 import 素材服务（好几个单测把本文件单独转译到临时目录，静态 import 兄弟模块会解析失败），挂在老路由前面；预检中间件插到 connect 栈最前面（原因见下文）；记下本进程的监听地址。`serveFile` 补上后缀 Range（`bytes=-n`）、越界回 416、`HEAD`；合法的 `bytes=a-b` 行为和原来一样。`writeMediaIndex` 改成导出。`/@media/*` 也接受 `HEAD`。 |
| `server/http-guard.mjs` | 新增 `isAssetServicePath(url)`：严格匹配 `/api/asset/media/<64 位 hex>[/chunks|/complete|/<n>]`，判的是 `apiPath` 归一化之后的形式。 |
| `server/vite-plugin-api-guard.ts` | 同源守卫只对 `isAssetServicePath` 放行，其余 `/api/**` 不变。 |
| `server/vision/ffmpeg-frames.ts` | 新增 `mediaSourceOf(m)`：返回素材服务上的 HTTP 地址，给 ffmpeg 当 `-i`。`renderMediaLayers` 改用它。`mediaFileOf` 保留，标成「老路，待迁」（原因见「遗留」）。 |
| `vite.prerender.config.ts` | 由编辑器拉起（带 `PROMPTCUT_EDITOR_URL`）时，素材路由（`/@media/*`、`/api/asset/*`、`/api/media/*`）整条转发给编辑器进程里的素材服务，本进程不再挂 `mediaPlugin`、不再读本地内容库；没有这个变量时（脚本直接用这份配置起服务）仍挂本地 `mediaPlugin`。 |
| `server/test/asset-service.test.mjs`（新） | 11 条，见下文。 |
| `server/test/api-guard.test.mjs`、`server/test/http-guard.test.mjs` | 补守卫豁免的正反用例。 |

编辑器的导入流程（`/api/media/upload/`、`handleMediaUpload`、`storeMediaStream`、`adopt`、`local`、`file`）一行没改，仍然只接受同源请求。整件导入进来的素材，在对账接口里直接报 `complete: true`。

## API 契约（第 5 步）

基址是 `<origin>/api/asset`，下面的路径都相对这个基址。本地素材服务原有的读路由 `/@media/<hash>` 等价于 `GET media/<hash>`。远程素材服务必须实现同一份契约，客户端只换基址。

- **按哈希寻址**：`<hash>` 是全件内容的 sha256（64 位 hex），**由上传方自己算**。大小写不敏感，服务端一律按小写存。写入后不可变，同一哈希只存一份。
- **`PUT media/<hash>/<n>`**：分片固定 8 MiB（8388608 字节），`count = max(1, ceil(size / 8 MiB))`，小于 8 MiB 就是 1 片。没有整件 `PUT`。
  - `n` 是十进制、不带前导零。格式不对回 400，`n ≥ count` 回 416。
  - **每一片都要带** `X-Media-Size: <全件字节数>`。缺了或不是正整数回 400，超过 64 GiB 回 413，和已登记的 size 不一致回 409（`size-mismatch`）。
  - 可选 `X-Media-Ext` 或 `X-Media-Type`，决定取回时的 Content-Type。两个都给时扩展名优先；只给 MIME 时反查扩展名。以最先带上的那一片为准。请求体本身的 Content-Type 不看。
  - 长度：除最后一片外都必须正好 8 MiB，最后一片是 `size − 8 MiB × (count − 1)`。`Content-Length` 或实际收到的字节数对不上都回 400，这一片不算收到。
  - 幂等：同一片重传就原位重写；哈希已入库后，任何分片都回 200 且不写盘。成功回 `{ ok, hash, n, bytes }`。
- **`GET media/<hash>/chunks`** → `{ size, chunkSize, received: number[], complete }`，`received` 升序。
  - 没见过的哈希回 `{ size: null, chunkSize, received: [], complete: false }`。
  - 已入库的哈希回全部分片号，`complete: true`。
- **`POST media/<hash>/complete`**：
  - 分片没到齐回 400 `{ error: "incomplete", missing }`，已收的分片不动。
  - 到齐后按全件算 sha256，不符回 **409** `{ error: "hash-mismatch", actual }`，并丢弃这个哈希已收的全部分片（分不清是哪片坏了，上传方从头传）。
  - 通过才入库为 `<hash>.<ext>` 并写索引，回 200 `{ ok, hash, size, complete: true, url: "/@media/<hash>" }`。
  - 没见过的哈希回 404；已入库的再调一次回 200。
- **`GET`/`HEAD media/<hash>`**：只取已入库的全件，Content-Type 按扩展名。支持单段 Range（`a-b`、`a-`、`-n`），回 206 和 `Content-Range`，越界回 416。还没 complete 的哈希回 404。
- **跨源**：`/api/asset/media/...` 和 `/@media/*` 回 `Access-Control-Allow-Origin: *`，以及 `Access-Control-Expose-Headers: Content-Range, Accept-Ranges, Content-Length, Content-Type`。
  - 预检回 204：方法 `GET, HEAD, PUT, POST, OPTIONS`，头 `Content-Type, Range, X-Media-Size, X-Media-Ext, X-Media-Type`，`Max-Age 600`。
  - 请求里带 `Access-Control-Request-Private-Network` 时，回 `Access-Control-Allow-Private-Network: true`。
  - 不带凭据。其余 `/api/**` 的同源守卫不变。
- **存储**：没收齐的分片放在 `out/media/.chunks/<hash>/`，里面有 `meta.json`、`data`（按偏移原位写的全件，收尾时只读一遍算哈希再改名，不多拷一遍）和 `<n>.ok` 标记。写一片之前先删它的标记、写完才补上，所以断线或写失败的那一片只会被报成「没收到」。同一哈希的登记和收尾是串行的。

### 基址怎么定（`asset-client.ts` 的 `assetServiceOrigin`）

1. 有 `PROMPTCUT_EDITOR_URL` 就用它。预渲染进程由 `vite-plugin-prerender.ts` 拉起时带着这个变量，本地素材服务第一版就在编辑器进程里。**现有这个变量够用，没有加新的环境变量。**
2. 否则用本进程的监听地址（媒体插件起来时记在 `globalThis`）。这是**单进程形态**：Agent 就在编辑器进程里，照样走回环地址的 HTTP，不直接读目录。
3. 都没有就返回 null，调用方如实写「素材服务不可达」。

## 验证结果

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0（注意：tsconfig 只含 `src`，不看 `server/`。我另外对新文件跑了 `tsc --noEmit --strict … server/asset-service.ts server/asset-client.ts server/vite-plugin-api-guard.ts vite.prerender.config.ts`，本次改动涉及的文件零错误；报出来的都是 `vision/render.ts`、`worker-pool.ts`、`vite-plugin-frames.ts` 等原有的问题） |
| 全量测试 | `npm test` | 退出码 0：tests 1735、pass 1734、fail 0、skipped 1（原有的 `/api/cards/layout` 集成用例） |
| 素材服务单测 | `node --test server/test/asset-service.test.mjs` | 11/11 通过 |
| 守卫单测 | `node --test server/test/api-guard.test.mjs server/test/http-guard.test.mjs` | 16/16 通过 |
| 导出确定性 | `node scripts/verify-determinism.mjs --url "http://127.0.0.1:5220/?export=1"`（worktree 里起的 dev server，5220–5222） | 退出码 0：1800 帧里 1800 帧相同、0 帧不同，输出 “Determinism verified!” |

`asset-service.test.mjs` 覆盖的验收点：

- **断线续传**：3 片的素材（8 MiB + 8 MiB + 4321 B）。先传完第 0、2 片，第 1 片只发 1 MiB 就掐断连接。之后 `chunks` 报 `received: [0, 2]`；提前 `complete` 回 400 `missing: [1]`，`complete` 仍是 false。续传函数先对账，**实际只发出第 1 片**（断言 `sent` 等于 `[1]`），然后 `complete` 回 200，`chunks` 报 `complete: true`。库里出现 `<hash>.mp4`，内容的 sha256 对得上，暂存区已清掉。
- **校验不符**：`complete` 回 409 `hash-mismatch`，之后 `chunks` 报 `received: []`，取回 404。
- **分片校验**：越界 416；非末片长度不对 400；末片超长 400；缺 `X-Media-Size` 400；分片号 `01` 回 400；size 前后不一 409；同一片重传两次都是 200。
- **取回**：Content-Type 按 `X-Media-Type: video/webm` 反查。`bytes=100-199`、`bytes=-10`、`bytes=4990-` 都回 206，`bytes=9000-9001` 回 416，`HEAD` 正常。`/api/asset/media/<hash>` 和 `/@media/<hash>` 结果一致。
- **老路**：整件导入 `/api/media/upload` 照常可用，进来的素材在 `chunks` 里是 `complete: true`。
- **跨源**：用源 `http://192.168.1.50:8080` 模拟局域网设备，三类路由的预检和实际请求都拿到上面列的 CORS 头，Private Network 头也有。非素材路由不带 CORS 头。
- **转发**：经 `assetProxyPlugin` 上传、收尾、Range 取回，字节和 Content-Range 原样透传。
- **ffmpeg**：用 `extractArgs` 分别拿素材服务的 HTTP 地址和本地文件抽同一帧，两个 PNG 逐字节相同。

**真 dev server 上的端到端检查**（worktree 里 `npx vite --port 5220 --strictPort --host 127.0.0.1`，这个进程和它拉起的预渲染子进程都是我起的，最后按 PID 关掉）：

- 9000000 字节、2 片，用 curl 带 `Origin: http://192.168.1.50:8080`：
  - 传第 0 片后 `chunks` 报 `received: [0]`；`complete` 回 400 `missing: [1]`。
  - 补传第 1 片后 `complete` 回 200，`chunks` 报 `complete: true`。
  - `/@media/<hash>` 带 Range 回 206，`Content-Type: video/mp4`，带 `Access-Control-Allow-Origin: *`。
  - 跨源 `POST /api/ai/config` 回 **403**，跨源 `GET /api/media/local` 回 **403**，同源回 200。
- **发现并修了一个问题**：第一轮实测时，局域网源的预检被 vite 自带的 cors 中间件答成了 204，但**不带** `Access-Control-Allow-Origin`，浏览器会判预检失败。原因是 vite 的 `server.cors` 默认只放行 localhost 系的源，而且它排在所有插件中间件前面。修法：媒体插件把素材路由的预检中间件 `unshift` 到 connect 栈最前面。修完重测，局域网源对 `/api/asset/...` 和 `/@media/...` 的预检都返回完整 CORS 头；`/api/ai/config` 的预检和原来一样（vite 答 204，不带 Allow-Origin）。
- 经预渲染进程转发：`http://127.0.0.1:<预渲染端口>/@media/<hash>` 带 `Range: bytes=100-199` 回 206，`content-range: bytes 100-199/9000000`，取回的字节和源文件对应区段逐字节相同（`cmp` 通过）。经转发查 `chunks` 也报 `complete: true`。
- **真浏览器跨源**：Browser 面板里打开 `http://127.0.0.1:5223` 的测试页（和 5220 不同源），页面结果：`PUT 200 | chunks {"size":3000,…,"received":[0],"complete":false} | complete 200 true | GET 206 bytes 10-19/3000 image/png len=10 | non-media status 403`。
  - PUT 带了自定义头，所以真的走了预检。
  - 本想用 `127.0.0.2` 模拟一台别的主机，但 Browser 面板自己拦了请求（`ERR_BLOCKED_BY_CLIENT`，是客户端策略，不是 CORS 失败）。「另一台主机」这一层靠 curl 和单测里的局域网源覆盖。

## 读素材是否只经 HTTP：grep 结果与例外

检查命令是 `grep -rn "mediaDir|mediaRootDir|out/media|mediaFileOf|resolveHashFile" server scripts vite*.ts`（排除测试和素材服务自身）。剩下的逐条如下：

| 位置 | 进程 | 性质 | 处理 |
|---|---|---|---|
| `server/vision/ffmpeg-frames.ts` `mediaFileOf` ← `server/vision/routes.ts:124`（`POST /api/vision/sheet`，see_frames 素材模式的镜头拼图） | 预渲染 | **读素材，没迁** | `routes.ts` 不在可写清单里。它拿返回值做 `fs.statSync(file).mtimeMs` 当缓存键，只改 `mediaFileOf` 让它返回 URL 会直接抛错。**迁法**：`routes.ts:124` 改用 `mediaSourceOf(media)`；缓存键把 `${file}|${stamp}` 换成 `${media.hash || url}`（内容寻址、不可变，不需要 mtime）；然后删掉 `mediaFileOf` 和 `ffmpeg-frames.ts` 对 `mediaDir` 的 import。约 5 行，需要主 Agent 授权再改。 |
| `server/vision/ffmpeg-frames.ts` `renderMediaLayers` | — | 已改走 HTTP | 顺带发现：这个函数没有被任何地方调用（不导出，全仓无引用），是死代码。 |
| `server/bakery/media.mjs:24-50` `mediaSourceOf`、`:79` `mediaRootDir`、`server/bakery/export.mjs:115` | 预渲染（导出） | **读素材，归 R8** | 见下节。 |
| `server/vision/bake.ts:246,356`、`server/vision/bake-cache.ts:19,50` | 预渲染 | 预渲染产物（PNG）的读写 | 属第 6 步 A3b，按要求没动。 |
| `server/vite-plugin-export.ts:53,95,131-139` | 编辑器 / 预渲染 | 导出暂存和产物目录 | 产物路径，属第 6 步。 |
| `server/vite-plugin-audio.ts:29-50`（`mediaFileOf` 的一份拷贝） | 编辑器进程 | 读素材（音频混音、波形） | 只挂在编辑器进程里（`vite.prerender.config.ts` 没挂它），不属于 Agent 进程或预渲染进程；也不在可写清单里。建议第 6 步一并改成经 `mediaHttpUrl`。 |
| `server/vite-plugin-collect.ts:184,504`、`server/vite-plugin-voice.ts:113-162` | 编辑器进程 | **写**素材（下载、配音直接落到素材目录） | 属第 6 步「入库」（应经素材服务 API 入库）。 |
| `scripts/verify-unified-frames.mjs`、`scripts/probes/*` | 测试脚本 | 往本地内容库放测试素材 | 不是运行时路径。 |

## R8 合并后要改的（R8 占着的文件）

- `server/bakery/media.mjs` 的 `mediaSourceOf`（第 24～50 行）：删掉 `m.path` 和 `url.startsWith('/@media/')` 这两个读磁盘的分支，只保留 `/@export/<id>/media/` 分支（那是导出产物，第 6 步再说）和最后的「按 `pageUrl` 的源走 HTTP」分支。在预渲染进程里 `pageUrl` 的源就是预渲染进程自己，它的 `/@media/*` 已经转发给素材服务，所以 ffmpeg 和 ffprobe 自然都经 HTTP。更直接的写法是 `import { mediaHttpUrl } from '../asset-client'`，基址用 `assetServiceOrigin()`。`legacyMediaRoots()` 和 `mediaRootDir()` 随之删掉，`export.mjs:115` 不再传 `mediaRoot`。
- 这个改动要重跑导出确定性和 `verify-unified-frames.mjs`：经 HTTP 读的字节相同，理论上像素不变；本次 ffmpeg 单测已证明抽帧结果逐字节相同。
- `src/render/**`、`src/StageView.tsx`、`src/ExportView.tsx`：这一步没有需要改的地方。页面仍然按 `/@media/<hash>` 取素材，这条路由已经带 CORS。

## 没做的及原因

- `routes.ts` 的镜头拼图还在直接读目录：文件不在清单里，迁法见上表。
- `server/bakery/media.mjs`：R8 占着，改法见上节。
- 两档、上传队列、换档、`playable`、产物推送、A5、A6、A3b：都属第 6 步，不在本次范围。

## 对任务书或语义的更正建议

- `docs/plan/cloud-task.md` 的 A1「上传一律走分片」没写分片元数据的契约。建议把本报告「API 契约」一节（`X-Media-Size` 每片必带、扩展名 / MIME 头、分片号范围、长度规则、幂等、未到齐回 400、sha256 不符回 409 并丢弃分片）补进去，并写明基址是 `<origin>/api/asset`。
- 任务书组件表「本地内容库」那一行引用的行号（`vite-plugin-media.ts:17/67/171/235`）已经不准，`:486`、`:508` 这类行号也一样。建议改成按符号名引用（`outRoot`、`mediaDir`、`resolveHashFile`、`storeMediaStream`）。
- 验收里的「局域网里另一台设备跨源访问本机素材服务成功」：dev server 只监听 127.0.0.1，真实的另一台设备根本连不上，本次只能用不同 Origin 模拟（见「待用户定」第 1 条）。
- `verification.md` 的「类型检查」一项：`tsc -b` 不看 `server/`（`syntax.test.mjs` 只查语法，不查类型）。建议在基线说明里点明，或者给 `server/` 加一份 tsconfig。
- `vite-plugin-prerender.ts` 用 `freePort()` 随机分配预渲染进程的端口（本次是 8774 和 6062），落在分配的端口段之外。子 Agent 协议里的「端口段」管不住它，建议在 `multi_agent.md` 或 `verification.md` 里说明。

## 待用户定

1. **dev server 的监听地址**：现在仍是 127.0.0.1，没改。要让局域网设备真的连得上，得监听 0.0.0.0 或局域网网卡地址，并决定其余 `/api/**` 在那种情况下怎么防护（同源守卫挡不了「不带 Origin 的局域网请求」）。
2. **跨源的放行范围**：现在对任意源回 `*`，这是语义「允许跨源访问」的最宽解读。代价是：用户浏览器里任何网页都能读到已知哈希的素材，也能往本地内容库写（写入的内容受 sha256 校验、单件 64 GiB 上限，只可能占用磁盘）。要不要改成白名单（局域网段，或经连接发现登记过的设备）？
3. **单件上限 64 GiB**：是我定的保守值，要不要可配？
4. **Private Network Access**：现在只要请求带了那个头，就回 `Access-Control-Allow-Private-Network: true`。公网页面访问本机素材服务时，Chrome 也就放行了。要不要只对局域网源放行？
5. **分片没到齐时 `complete` 回 400**（契约只规定了校验不符回 409）。这是我的选择，好让「409」只表示「内容不符、要从头传」。
6. **远程素材服务的基址**：第 5 步沿用 `PROMPTCUT_EDITOR_URL` 和本进程地址，没有新增环境变量。F4「切换所连接的服务」时要不要加一个专门的配置（比如 `PROMPTCUT_ASSET_URL`），这次没定。
7. `/api/media/*`（整件上传、adopt、local、file）还是编辑器内部接口，只认同源，**不属于素材服务契约**。其中 `local` 在任务书 A1 里已经注明「不是判据」。第 6 步是否把它们并进素材服务，或者删掉，待定。

## 其它

- worktree 的 `out/` 里留着这次端到端检查和确定性验证的临时文件（`out/media` 下的测试素材、`out/verify-a`、`out/verify-b`），都被 gitignore，不影响分支。
- 我起的进程（5220 的 dev server 及其预渲染子进程、5223 的测试页服务）都已按 PID 或任务 ID 关掉。
