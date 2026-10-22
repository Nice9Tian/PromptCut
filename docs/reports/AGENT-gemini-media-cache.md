# AGENT 报告：gemini/media-cache

分支 `gemini/media-cache`，worktree `.worktrees/media-cache`，从本地 main `0e16b291` 拉出；本任务实现的语义已在 `5e8363ba` 提交：

- `docs/semantics/product/asset-service.md`：「不能跨项目读」「凭票据读写」「浏览器可以长期缓存素材」；
- `docs/semantics/mechanism/asset-service.md`：「缓存头」；
- `docs/semantics/mechanism/platforms.md`：「素材票据」及其下「路径号按账号加项目固定」。

执行：agy（Gemini 4 Argon），由 agy manager 督导、审 diff、提交。端口段 6420～6429。

## 做了什么

### 第一阶段（服务端缓存头与单测）

1. **`server/asset-service.ts`**：
   - 导出常量 `ASSET_MEDIA_CACHE_CONTROL = "private, max-age=31536000, immutable"`。
   - 新增 `hasQueryTicketParam(req)`（使用 `new URLSearchParams(...).has("t")`，空参数 `?t=` 同样算带了 `t`）。
   - 在项目授权模式（`opts.projectAccess` 已设置）下，当无尾巴路由 `/api/asset/media/<hash>` 的 `GET` 或 `HEAD` 请求同时满足：携带 `Authorization: Bearer ...` 请求头（`bearerOf(req) !== null`）、URL 查询串不含 `t` 参数（`!hasQueryTicketParam(req)`）、`admit()` 放行、数据层 `store.stat(hash)` 非空（内容已完整入库，且 `GET` 的读取流打开成功）、`lease.assert()` 通过、最终实际写出的状态码为 `200` 或 `206` 时，在 `serveBlob()` 的 `res.writeHead(range ? 206 : 200, headers)` 前设置：
     - `Cache-Control: private, max-age=31536000, immutable`
     - `Vary: Authorization`
   - 其余所有情况保持原有响应头不变：带 `?t=` 查询串票据的请求保持 `Cache-Control: no-store` 与 `Referrer-Policy: no-referrer`；所有 4xx/5xx 错误（含 404 未找到或未收尾、416 Range 越界、401、403、400）保持 `Cache-Control: no-store`；`snap`、`px`、`chunks`、`complete`、`PUT`、`/@media/*` 等路由不变。
   - 在 `server/asset-service.ts` 文件头注释「凭票据读写」一节补充了账号云模式下的长期缓存头规则说明。
   - **非 `projectAccess` 模式（旧局域网票据与本机回环信任）行为保持未改**，现状如下：
     - **本机回环信任（`isTrusted(req)` 为真且不带 `?t=`）**：`admit()` 不设 `Cache-Control`。`GET` / `HEAD` `/api/asset/<ns>/<hash>`（200 或 206）以及 `/@media/<hash>` 均不发 `Cache-Control` 响应头（值为 `null`）；JSON 路由（`chunks`、`complete`、`PUT`）经 `sendJson()` 发 `Cache-Control: no-store`。
     - **Bearer 票据（`Authorization: Bearer <票据>`，`isTrusted` 为假且不带 `?t=`）**：`admit()` 不设 `Cache-Control`。`GET` / `HEAD` `/api/asset/<ns>/<hash>`（200 或 206）以及 `/@media/<hash>` 均不发 `Cache-Control` 响应头（值为 `null`）；JSON 路由经 `sendJson()` 发 `Cache-Control: no-store`。
     - **查询串票据（`?t=<非空票据>`）**：`queryTicketOf(req) !== null` 为真，`admit()` 设 `Cache-Control: no-store` 与 `Referrer-Policy: no-referrer`，因此 200 / 206 响应带这两个头。（若 `?t=` 为空串，`queryTicketOf(req)` 返回 `null`，不触发该分支。）
     - **错误响应（4xx / 5xx）**：所有经 `sendJson()`（含 `reject()`）返回的 400 / 401 / 403 / 404 / 405 / 409 / 413 / 500 / 501 / 507 均带 `Cache-Control: no-store`；`serveBlob()` 的 416 分支直接调 `res.writeHead(416, ...)`，在请求带非空 `?t=` 时继承 `admit()` 设的 `Cache-Control: no-store`，不带非空 `?t=` 时无 `Cache-Control` 头。

2. **`server/test/asset-media-cache-headers.test.mjs`（新建）**：
   - 覆盖 `(a)` 跨项目凭哈希读被拒（404 + `no-store`，无长期缓存头）及所属项目 Bearer `GET`（200）、`Range`（206）、`HEAD`（200）返回 `Cache-Control: private, max-age=31536000, immutable` 与 `Vary: Authorization`（另核 416 与 `/@media/<hash>` 保持 `no-store`）；
   - 覆盖 `(b)` 无票据、未知票据、过期票据（401）以及 `fixture.revoke` 撤销项目后（403）均返回 `Cache-Control: no-store`，绝不带长期缓存头；
   - 覆盖 `(c)` 查询串票据 `?t=A-r` 返回 200/206 + `Cache-Control: no-store` + `Referrer-Policy: no-referrer`，以及 Bearer 同时携带 `?t=A-r`、`?t=B-r` 或空 `?t=` 时绝不返回长期缓存头；
   - 覆盖 `(d)` 真实 `startHostedAssetService`（`server/hosted/asset-runtime.mjs` 未修改，配 `server/test/fixtures/asset-wiring-pki.mjs` 临时证书与 `createAccountProjectsInternalServer` 桩文档服务）在请求携带 `Cookie` 头（含同时携带有效 Bearer）时一律拒绝（400 + `Cache-Control: no-store`），不带 `Cookie` 的有效 Bearer 正常返回 200 与长期缓存头；
   - 覆盖 `(e)` 未收尾的单分片 `PUT`、以及两分片对象（`size = chunkSize + 1`）仅上传末片（chunk 1）时，`GET` 与 `HEAD` 均返回 404 + `Cache-Control: no-store`；`snap` 与 `px` 的 `GET` / `HEAD` / `Range` 以及 `GET /api/asset/media/<hash>/chunks` 保持 `Cache-Control: no-store`；
   - 覆盖静态回归守卫：读取 `server/hosted/deploy/nginx-site-promptcut-stages.conf` 与 `server/hosted/deploy/nginx-snippet-promptcut-stage-headers.conf`，断言 `/media-s/<sid>/media/<hash>` 的 `location` 块不含 `add_header Cache-Control`、`add_header Vary`、`proxy_hide_header`、`proxy_ignore_headers`，且片段文件不设置 `Cache-Control` 或 `Vary`。

3. **nginx 配置核查结论（只读）**：
   - `server/hosted/deploy/nginx-site-promptcut-stages.conf` 中 `location ~ "^/media-s/(?<pc_sid>[A-Za-z0-9]{16,64})/(?<pc_mpath>media/[0-9a-f]{64}(?:\.[A-Za-z0-9]{1,8})?)$"` 块仅包含 `include snippets/promptcut-stage-headers.conf;`、方法限制、cookie 判空与 `proxy_pass`，没有任何 `add_header Cache-Control`、`add_header Vary`、`proxy_hide_header`、`proxy_ignore_headers` 或 `expires` 指令；
   - `server/hosted/deploy/nginx-snippet-promptcut-stage-headers.conf` 仅设置 `Content-Security-Policy`、`X-DNS-Prefetch-Control`、`Origin-Agent-Cluster`、`Referrer-Policy`、`X-Content-Type-Options`，不设置 `Cache-Control` 或 `Vary`；
   - 因此上游素材服务返回的 `Cache-Control: private, max-age=31536000, immutable` 与 `Vary: Authorization` 会由 nginx 原样透传给浏览器，不会阻断浏览器缓存。

## 验证结果

1. **`npm test -- server/test/asset-media-cache-headers.test.mjs`**（沙箱内执行）：
   - 汇总行：`ℹ tests 6` / `ℹ pass 1` / `ℹ fail 5`
   - 说明：静态回归守卫用例在沙箱内通过（`✔ 静态回归守卫：nginx 舞台站点 /media-s/<sid>/media/<hash> 与 stage-headers 片段不覆盖或剥离上游 Cache-Control 与 Vary`）；其余 5 条 HTTP 用例因沙箱禁止回环 TCP 连接（`fetch` 报 `connect EACCES 127.0.0.1:<port>`）以及沙箱拦截 `C:/Program Files/Git/usr/bin/openssl.exe`（`temporary-pki-generation-failed`）而在沙箱内受阻，需在沙箱外运行。
2. **`npm test -- server/test/asset-project-http.test.mjs server/test/asset-service.test.mjs server/test/auth-tickets.test.mjs server/test/asset-namespaces.test.mjs server/test/asset-store-http.test.mjs`**（沙箱内执行）：
   - 纯内存与源码守门用例（含 `H2 守门：asset-service.ts 源码里没有文件系统引用、没有 .chunks 目录名`、`契约常数`、`客户端`、`预检中间件`）全部通过；回环 HTTP 用例同样因沙箱禁止 `connect 127.0.0.1`（`EACCES`）受阻，需在沙箱外运行。
3. **内存直接调用 `assetServiceMiddleware` 冒烟验证**（沙箱内绕过 TCP socket 直接构造 `IncomingMessage` / `ServerResponse` 验证跨项目 404 `no-store`、本项目 Bearer `GET`/`Range`/`HEAD` 长期缓存头与 `Vary: Authorization`、`?t=B-r` 与空 `?t=` 的 `no-store`）：
   - 输出：`IN_MEMORY_VERIFICATION_ALL_PASSED`（退出码 0）。
4. **`npx tsc -b --force` 与 `npx tsc --noEmit`**（沙箱内执行）：
   - `npx tsc -b --force`：无任何代码类型错误，仅在最后写 `tsconfig.tsbuildinfo` 时因沙箱文件权限报 `error TS5033: Could not write file '.../tsconfig.tsbuildinfo': EPERM: operation not permitted`。
   - `npx tsc --noEmit`：退出码 0，零错误。

## 编辑器页仍用 `?t=` 读素材字节的地方（任务第 5 步）

（待后续阶段填写）

## 没做成的及原因

- 第一阶段代码与测试已全部完成；沙箱内回环 TCP `connect 127.0.0.1` 被拒（`EACCES`）及 `openssl.exe` 派生受限（`temporary-pki-generation-failed`）及 `tsconfig.tsbuildinfo` 写入 `EPERM` 属于沙箱隔离限制，需由宿主机在沙箱外执行上述命令复核。

## 对任务书或语义的更正建议

- 无。
