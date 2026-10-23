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

### 第二阶段（编辑器页路径号按账号加项目固定与单文档单路径号隔离）

1. **`src/online/stageIsolation.ts`**：
   - 新增 `STAGE_SID_STORAGE_PREFIX = "pc.stageSid.v1:"`、`StageSidScope`、`StageSidStorage`、`StageSidStore` 与 `createStageSidStore({ storage, random })`：
     - 当 `accountId` 与 `projectId` 均为非空字符串时，在编辑页面自己的 `localStorage` 中按 `'pc.stageSid.v1:' + encodeURIComponent(accountId) + ':' + encodeURIComponent(projectId)` 读写；仅当已存值匹配 `/^[0-9a-f]{32}$/`（且未被本 store 其它作用域占用）时复用，否则调用 `newSid(random)` 生成并写回；访问 `localStorage`、`getItem` 或 `setItem` 抛错（或无 `storage`）时，退回本页面会话内存里为该键保存的随机 32 位十六进制路径号。
     - 当任一标识缺失（`null`、`undefined` 或 `""`）时，绝不触碰 `storage`，按作用域键在本页面会话内存里分配随机 32 位十六进制路径号。
     - 不同作用域在任何模式下绝不共用路径号，同一作用域在整个页面会话内始终返回同一路径号；模块顶层导入时不访问任何存储。
   - 在 `StageIsolationSession` 上新增 `setScope(scope: StageSidScope): void`，并将 `readonly sid: string` 改为返回当前作用域路径号的 getter：
     - 调用 `setScope` 之前行为与原先完全一致（`deps.sid ?? newSid()`）；
     - 作用域键未变化时 `setScope` 为空操作（防止 `pushMediaPolicy` 与订阅回调循环触发）；路径号变化时调用 `update()` 重算状态并通知订阅方。
   - 单舞台文档单路径号隔离（`Slot.docSid`）：
     - 每个舞台槽位记录当前文档已拿过的路径号 `docSid`（任何返回非空 `base` 的 `plan()` 分支都会记录 `slot.docSid = currentSid`，`handshake(id)` 时重置为 `null`）；
     - 若 `slot.docSid !== null && slot.docSid !== currentSid`，`plan()` 在所有可能返回 `base` 的路径（含 `safeFallback`、`!ctx.ticket` 及异步等待唤醒后）之前均拦截并返回 `{ mode: "cookie", base: null, ticket: null, cardExec: false, reload: true }`，不发出 `grant` 请求、不给新 `sid`、不开启 `cardExec`；`judge()` 同时将该槽位判为未就绪（`pending`）。
   - 票据交接按 `(stageOrigin, sid, ticket)` 判重（`slot.granted` 与 `slot.granting.key` 均包含 `sid`），路径号变化后即使票据与舞台源相同也会为新路径号重新交接。
   - 更新 `newSid` 注释（去掉「不是秘密」表述，说明按账号加项目隔离、对其它项目的舞台保密）。

2. **`src/online/stagePolicy.mjs`**：
   - 更新 `SID_PATTERN` 注释（去掉「不是秘密」表述，说明按账号加项目固定、对其它项目的舞台保密）。

3. **`src/editor/Preview.tsx`**：
   - 从 `./media/assetTiers` 引入 `remoteAccountProjectId`；
   - 在 `pushMediaPolicy` 中规划前调用 `iso.setScope({ accountId: getSyncView().shared?.accountId || null, projectId: remoteAccountProjectId() || currentDocProjectId() || null })`；
   - 当 `plan.reload` 为真时，按既有舞台重载流程释放并销毁该舞台 RPC 客户端、清空 `rpcRef.current[id]` 与 `hostCapsRef.current[id]`、执行 `frame.src = frame.src` 整页重载该舞台 iframe 并直接返回（不向旧文档下发策略；新文档握手后由 L920 既有重推逻辑拿到新 `sid`）；
   - 更新 L1996 诊断注释（去掉「不是秘密」表述）。

4. **`src/online/stageIsolation.test.mjs`**：
   - 新增用例 `(f) 路径号按账号加项目固定(createStageSidStore 与会话 setScope / reload):同账号同项目稳定复用、跨项目跨账号隔离、存储异常与脏值兜底、缺标识不碰存储、换项目强制重载舞台且守单向规矩`。

### 第三阶段（无头 Chrome 浏览器缓存与跨项目路径号隔离探针）

1. **`scripts/probes/media-cache-probe.mjs`（新建）**：
   - 端口 `6420`（项目授权模式素材服务）、`6421`（编辑器页源 `http://pc.localhost:6421`）、`6422`（舞台源 `http://s1.pc.localhost:6422`），启动前检查端口空闲，仅绑定 `127.0.0.1`；
   - 用 `rolldown` 将真实的 `src/online/stageIsolation.ts` 打包为浏览器 IIFE（全局 `PCStageIso`），在真实无头 Chrome 中跨两次同 `userDataDir` 会话验证：会话 1 舞台经 `/media-s/<sid>/media/<hash>` 拉取获得 `Cache-Control: private, max-age=31536000, immutable` 与 `Vary: Authorization`；会话 2 复用 `localStorage` 中的 `sid` 直接命中浏览器缓存（素材服务收到 0 次无 `t` 的 `GET` 请求，并报告 ResourceTiming `transferSize`）；`?t=` 路由两轮会话共 4 次请求每次均回源且带 `Cache-Control: no-store`；同账号下项目 B 获得不同 `sid`，经项目 B 的 `sid` 拉取项目 A 的素材哈希回源返回 404（跨项目不命中缓存）。

## 原地换项目与舞台重载

编辑器页可以在不重新挂载 `Preview` 组件的情况下原地切换项目（例如 `src/editor/sync/syncManager.ts` 的 `onLoad` 在检测到云项目关联时调用 `enterAccountProject`）。若不重载舞台 iframe，原先拿过项目 A 路径号 `sid` 的同一个舞台文档稍后会接着运行项目 B 的卡片代码，从而让项目 B 的代码有机会从该文档（ResourceTiming、DOM 或内存）拿到项目 A 的 `sid` 并读取项目 A 已缓存的素材。因此在 `pushMediaPolicy` 与 `stageIsolation.plan` 中强制实施「单舞台文档单路径号」并在路径号变化时整页重载舞台 iframe。

## 验证结果

### 第一阶段（提交 `c273466c`）

- 沙箱内 HTTP 用例因回环 `connect EACCES` 与 `openssl` 受限无法在沙箱内直跑；以下为 manager 在沙箱外对提交 `c273466c` 实跑的结果：
  - `npm test -- server/test/asset-media-cache-headers.test.mjs` -> `ℹ tests 6` / `ℹ pass 6` / `ℹ fail 0`（零失败）
  - `npm test -- server/test/asset-project-http.test.mjs server/test/asset-service.test.mjs server/test/auth-tickets.test.mjs server/test/asset-namespaces.test.mjs server/test/asset-store-http.test.mjs` -> `ℹ tests 41` / `ℹ pass 41` / `ℹ fail 0`
  - 变异核对（mutation check）：去掉「不含 `t` 查询参数」条件会使测试 `(c)` 失败；去掉「仅限 `media` 命名空间」条件会使测试 `(e)` 失败；原代码 6 条全过。
  - `npx tsc -b --force` -> 退出码 0，无输出。注：`tsconfig.json` 的 `include` 仅含 `src/`，因此基线类型检查不覆盖 `server/asset-service.ts`；对该文件单独跑 `tsc` 在修改前后均仅报相同的 6 条既有 `TS7016`（未声明类型的 `.mjs` 导入），无新增错误。

### 第二阶段（提交 `707c745b`）

- 沙箱内单测与类型检查：
  - `npm test -- src/online/stageIsolation.test.mjs src/online/stagePolicy.test.mjs` -> `ℹ tests 25` / `ℹ pass 25` / `ℹ fail 0`（`✓ npm test 最终结果：零失败`）
  - 读取 `Preview.tsx` 或 `stageIsolation.ts` 源码的相关单测：`npm test -- src/editor/measureGate.test.mjs src/editor/onlineCardsL.test.mjs src/online/cardRuntime/onlineCardsG.test.mjs src/online/modeImportGuard.test.mjs server/test/c10-ui-gates.test.mjs` -> `ℹ tests 33` / `ℹ pass 33` / `ℹ fail 0`（`✓ npm test 最终结果：零失败`）
  - `npx tsc --noEmit` -> 退出码 0，无输出（零错误；沙箱内 `npx tsc -b --force` 无代码类型错误，仅因沙箱禁止写根下 `tsconfig.tsbuildinfo` 报 `TS5033: EPERM`）。
- manager 在沙箱外对提交 `707c745b` 实跑的结果：
  - 引用 `stageIsolation` / `stagePolicy` / `Preview.tsx` 的 12 个测试文件（`server/test/c10-ui-gates.test.mjs`、`server/test/legacy-preview-target.test.mjs`、`server/test/stage-policy-nginx.test.mjs`、`src/editor/measureGate.test.mjs`、`src/editor/onlineCardsL.test.mjs`、`src/editor/stageSwapBaseline.test.mjs`、`src/online/cardRuntime/cardRuntime.test.mjs`、`src/online/cardRuntime/onlineCardsG.test.mjs`、`src/online/modeImportGuard.test.mjs`、`src/online/stageIsolation.test.mjs`、`src/online/stagePolicy.test.mjs`、`src/render/c10-cost-plan.test.mjs`）执行 `npm test` -> `ℹ tests 93` / `ℹ pass 93` / `ℹ fail 0`；
  - `npx tsc -b --force` -> 退出码 0，无输出；
  - 变异核对（mutation check）：将 `needReload` 改为恒 `false` 会使测试 `(f)` 失败。

### 第三阶段（浏览器探针 `scripts/probes/media-cache-probe.mjs`）

- 沙箱内语法检查：`node --check scripts/probes/media-cache-probe.mjs` -> 退出码 0，无输出。
- 沙箱外实跑结果（待填入）：
  - manager 在沙箱外实跑 `node scripts/probes/media-cache-probe.mjs`（端口 6420～6422，探针自建临时配置目录，跑完删除），退出码 0，输出：
    ```
    PASS session1: grantMediaCookie succeeded (sid=8a30870bcdbccbb94e4a8eb6305e414a)
    PASS session1: stage fetch status 200 and SHA-256 matches (status=200, bytes=262144)
    PASS session1: stage response Cache-Control is long-cache immutable (cache-control="private, max-age=31536000, immutable")
    PASS session1: stage response Vary is Authorization (vary="Authorization")
    PASS session1: asset service saw >= 1 GET without t (delta=1)
    PASS session2: sid equals session 1 sid (persisted in editor localStorage) (s1=8a30870bcdbccbb94e4a8eb6305e414a, s2=8a30870bcdbccbb94e4a8eb6305e414a)
    PASS session2: stage fetch status 200 and SHA-256 matches (status=200, bytes=262144)
    PASS session2: asset service saw 0 GET requests without t (served from browser cache) (before=1, after=1, delta=0)
    INFO session2 stage transferSize=0 (hasPerfEntry=true)
    PASS session2: ResourceTiming transferSize is 0 (transferSize=0)
    PASS query-ticket route: GET with t count increased by exactly 2 in session 1 and 2 in session 2 (s1Delta=2, s2Delta=2)
    PASS query-ticket route: all 4 fetches returned status 200 and Cache-Control: no-store (fetches=[{"status":200,"cc":"no-store"},{"status":200,"cc":"no-store"},{"status":200,"cc":"no-store"},{"status":200,"cc":"no-store"}])
    PASS project B: sid differs from project A sid (sidA=8a30870bcdbccbb94e4a8eb6305e414a, sidB=71920173b76bd17fada1180970851923)
    PASS project B: stage fetch of project A hash through B sid returns 404 and reached asset service (grantOk=true, status=404, assetDelta=1)
    media-cache-probe: PASS
    ```
  - 反向对照（确认探针不是空过）：临时把 `server/asset-service.ts` 的长期缓存条件改成恒假后再跑，探针按预期失败 4 项（会话 1 的 `Cache-Control` 为 `no-store`、`Vary` 为空；会话 2 回源 1 次，`transferSize=262444`），`media-cache-probe: FAIL (4 failed)`；随即还原，文件与提交内容逐字节一致。

### 最终验收（提交 `c0343c19`，manager 在沙箱外实跑）

- `npx tsc -b --force` -> 退出码 0，无输出（零错误）。
- `npm test`（单独一条命令，设 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT=C:\Users\admin\Documents\VisuHive` 与 `PROMPTCUT_PASSWORD_ORDER_MODULE=C:\Users\admin\Documents\VisuHive\account\password-order.mjs`）-> `ℹ tests 7684` / `ℹ pass 7669` / `ℹ fail 0` / `ℹ cancelled 0` / `ℹ skipped 15`，`✓ npm test 最终结果：零失败`；用时约 204 秒，没有文件级崩溃重跑。跳过的 15 条都是既有的环境条件项（Windows 权限位、本机没有 faster_whisper、要联网的 pip 等），不含本分支的测试；本分支的 7 条（`asset-media-cache-headers.test.mjs` 6 条、`stageIsolation.test.mjs` 的 (f)）在全量里都通过。
- `node scripts/probes/media-cache-probe.mjs` -> 14 项 PASS，末行 `media-cache-probe: PASS`，退出码 0（路径号与上面那次不同，因为每次探针都新建临时配置目录）。跑完没有残留的临时目录、Chrome 进程或 6420～6429 上的监听。
## 编辑器页仍用 `?t=` 读素材字节的地方（任务第 5 步）

在线**编辑器页**（非舞台文档）在 `src/editor/Preview.tsx:466-467` 将主文档的 `mediaTierPolicy` 设为 `remote: { base, ticket }`（带只读票据原文），经 `src/render/mediaTier.ts` 的 `remoteMediaUrl`（`L141-151`）把 `/@media/<hash>` 转成 `<base>/media/<hash>?t=<ticket>`。编辑器页仍用 `?t=` URL 读取素材字节的位置如下：

1. **`src/editor/preview/MediaLayers.tsx:81`（挂到 `L136` `<audio src={...} preload="auto">`）**：
   - 调用 `playbackUrl(result.media, localHashes)` 读取已生成的持久化卡片声音 WAV 产物（`media/<hash>?t=...`），整份 WAV 音频（通常数百 KB 至数 MB）。
2. **`src/editor/preview/MediaLayers.tsx:126`（挂到 `L136` `<audio src={...} preload="auto">`）**：
   - 调用 `playbackUrl(media, localHashes)` 供编辑器主文档声音层播放音频片段与视频片段的音轨（视频有小尺寸时优先走小尺寸哈希，否则走原尺寸音频/视频 `media/<hash>?t=...`；由浏览器 `<audio>` 流式缓冲，通常数 MB 至数十 MB）。
   - （注：`MediaLayers.tsx:192` 的 `<VideoTrack>` 内部在 `src/render/VideoTrack.tsx:67, 386` 同样调 `playbackUrl`，但在线模式主文档在 `Preview.tsx:2182` 传 `audioOnly`，画面层在跨源舞台里渲染。）
3. **`src/render/mediaTier.ts:223` → `src/render/playability.ts:171`（`probePlayable`）**：
   - 当主文档声音层调用 `chooseTier` / `playbackUrl`（未传 `probe: false`）且素材同时存在原尺寸与小尺寸两档时，创建离屏 `<video muted>` 试放原尺寸地址 `remoteMediaUrl(original, remote)`（`media/<originalHash>?t=...`）的首帧（浏览器按 Range 拉取容器头部与首帧采样，约数百 KB 至数 MB）。
4. **`src/editor/left/library/mediaGroups.tsx:125`（`MediaTile`，挂到 `L145` `<img>` 与 `L149` `<video preload="metadata">`）**：
   - 调 `usePreviewMediaUrl(m)`（`src/editor/media/previewUrl.ts:18` → `previewMediaUrl`）：图片读原尺寸整图（数百 KB 至数 MB）；视频优先读小尺寸档（无小尺寸且非最低档时读原尺寸），平时 `preload="metadata"` 读容器元数据与首帧（数百 KB），悬停时静音循环播放整段小尺寸视频（数 MB）。
5. **`src/editor/left/library/mediaGroups.tsx:193`（`MediaThumb`，挂到 `L218` `<img>` 与 `L227` `<video preload="metadata">`）**：
   - 素材分组总览缩略格，调 `usePreviewMediaUrl(m)`，加载内容与体量同上（图片整图；视频平时读元数据与首帧、悬停播小尺寸视频）。
6. **`src/editor/left/library/mediaGroups.tsx:247`（`AudioRow`）与 `src/editor/left/library/mediaGroups.tsx:413`（分组总览 `AudioStrip`）→ `src/editor/left/library/AudioStrip.tsx:35` → `src/editor/timeline/AudioWaveform.tsx:16`（`loadWave`）**：
   - 对 `usePreviewMediaUrl` / `previewMediaUrl` 返回的音频地址（`media/<hash>?t=...`）执行 `fetch(url)` + `res.arrayBuffer()`，下载整份音频文件并解码算波形峰值（整份原尺寸音频，通常数 MB 至数十 MB；内存按去掉查询串的键缓存）。
7. **`src/editor/left/library/mediaGroups.tsx:307`（右键菜单「以图片/视频比例作为项目比例」`handleApplyAspectRatio`）**：
   - 当素材元数据缺失宽高且非 `smallOnly` 档时，调 `originalMediaUrl(m, policy)`（`media/<originalHash>?t=...`），用 `<img>` 或 `<video>` 读取原尺寸图片（整图）或原尺寸视频元数据（容器头，数百 KB）以测量宽高。
8. **`src/editor/left/library/transitionsGroup.tsx:64`（`Still`，挂到 `L73` `<img>` 与 `L74` `<video preload="metadata">`）**：
   - 转场分区的静态预览图，调 `usePreviewMediaUrl(media)`，图片读原尺寸整图，视频读小尺寸档（或原尺寸）的元数据与首帧。
9. **`src/editor/timeline/AudioWaveform.tsx:47` → `src/editor/timeline/AudioWaveform.tsx:16`（时间轴片段波形 `loadWave`）**：
   - 调 `usePreviewMediaUrl(media)` 并 `fetch(url)` + `res.arrayBuffer()` 下载整份音频或小尺寸视频文件解码算波形峰值（整份文件，数 MB 至数十 MB）。
10. **`src/mobile/Thumb.tsx:27` → `src/mobile/thumbs.ts:174-200`（手机版缩略图 `grabFrame`）**：
    - 调 `usePreviewMediaUrl`（`media/<hash>?t=...`），用离屏 `<img crossOrigin="anonymous">`（原尺寸整图）或 `<video crossOrigin="anonymous" preload="auto">`（优先小尺寸档，seek 到目标时刻解码单帧，约数百 KB 至数 MB）抽帧压成 224px 宽的 JPEG data URL。
11. **`src/export/onlineExport.ts:120, 186`（`exportVideoOnline` 与 `exportVideoBrowserProbe`）**：
    - 构造 `mediaUrl: (url) => remoteMediaUrl(url, { base: remote.base, ticket: renewer?.ticket() ?? remote.ticket })`（`media/<originalHash>?t=...`），在浏览器逐帧导出中用于两处：
      - `src/export/browserExport.ts:171`（`encodeAudio`）：`fetch(deps.mediaUrl(m.url))` + `res.arrayBuffer()` 下载时间轴用到的每份有声素材的**原尺寸完整字节**（数十 MB 至数百 MB）以混音编码；
      - `src/export/browserExport.ts:263` → `src/export/frameCompositor.ts:267, 475`（`ExportCompositor`，每帧通过 `withTicket` 续换 `?t=`）：导出页加载**原尺寸**图片与视频（`<video>` Range 分段拉取或整图）逐帧合成。
12. **`src/editor/io/procp.ts:259` → `src/editor/io/procp.ts:277`（导出项目包 `packProcp` / `packProcpFrom`）**：
    - 调 `originalMediaUrl({ url: '/@media/' + hash, hash })`（`media/<originalHash>?t=...`）并 `fetch(url)` + `res.blob()` 下载项目中所有素材的**原尺寸完整字节**打包进 `.procp`。

- **编辑器页携带 `Authorization` 头读取素材字节（无尾巴路由 `media/<hash>`）的地方**：
  - **无（0 处）。** 编辑器页带 `Authorization: Bearer <ticket>` 的请求只访问 `media/<hash>/chunks`（`src/editor/media/assetTiers.ts:206`、`src/online/mediaUploadQueue.ts:182`）、分片上传 `PUT media/<hash>/<index>` 与 `POST media/<hash>/complete`（`src/online/mediaUploadQueue.ts:199, 212`）、`px/<hash>` 与 `snap/<hash>`（`src/render/snapshotSource.ts:1759`、`src/export/exportFrames.ts:408`、`src/export/originals.ts:104`、`src/export/streamFrames.ts:191`）、轨道流 `/streams/...` 以及舞台票据交接 `POST <stageOrigin>/media-s/<sid>/_grant`（`src/online/stageIsolation.ts:264`），没有任何地方用 `Authorization` 头直接 `GET`/`HEAD` `media/<hash>`。

## 舞台侧存储核查（I8）

舞台入口 `stage.html` 与 `index.html` 共用同一个打包入口 `src/main.tsx`（由 `?stage=1` 分支挂载 `src/StageView.tsx`）。对 `src/main.tsx` 顶层导入链及 `src/StageView.tsx` 可达模块中所有 `localStorage`、`sessionStorage`、`IndexedDB`、`Cache` API、`document.cookie` 写入的核查结果如下：

1. **`src/render/playability.ts:112`**（`StageView.tsx` → `FrameScene.tsx` / `VideoTrack.tsx` → `mediaTier.ts:223` `probePlayable` → `rememberPlayable`）：
   - 写入：`localStorage.setItem("pc.playable." + browserMajor() + ":" + hash.toLowerCase(), playable ? "1" : "0")`。
   - 能否含素材 URL、素材基址或 `sid`：**不能**。键仅含固定前缀、浏览器主版本号与 64 位小写内容哈希，值恒为 `"1"` 或 `"0"`。
2. **`src/skins/useSkin.ts:18, 20`**（因 `src/main.tsx:9` 静态导入 `Shell.tsx` → `Editor.tsx` → `useSkin.ts`，在模块求值阶段执行一次旧默认皮肤迁移）：
   - 写入：`localStorage.setItem("pc.skin", "studio-dark")`（仅当原值为 `"indigo-dark"` 时）与 `localStorage.setItem("pc.skin.studioMigrated", "1")`。
   - 能否含素材 URL、素材基址或 `sid`：**不能**。键与值均为写死的皮肤常量字符串。
3. **`src/store/actions/playback.ts:48`**（`setVolume`，经 `src/store/index.ts` 导入链可达）：
   - 写入：`localStorage.setItem(VOLUME_KEY, String(volume))`（`VOLUME_KEY = "promptcut:volume"`，值为 `0`～`1` 的音量数值字符串）。
   - 能否含素材 URL、素材基址或 `sid`：**不能**。键为固定常量，值仅为音量数字。
4. **其余存储 API（`sessionStorage`、`IndexedDB`、`Cache` API、`document.cookie`）**：
   - `src/online/boot.ts:25-29` 在 `?stage` 存在时 `editorPage` 为 `false`，不调用 `bootStageGate`（因此 `src/online/stageGate.ts:267` 的 `sessionStorage` 与 `src/online/crashLog.ts:151` 的 `localStorage` 在舞台文档里不执行）；
   - `src/online/stageIsolation.ts:192` 的 `localStorage.setItem("pc.stageSid.v1:...", sid)` 仅在编辑器页调用 `iso.setScope(...)` → `sidStore.sidFor(...)` 时执行，模块导入时不触碰存储，舞台文档从不调用；
   - `src/online/l2.ts`、`src/online/cardRuntime/transpileCache.ts`、`src/editor/sync/offlineCache.ts` 均不在舞台中调用，模块顶层也不打开 `IndexedDB`；
   - 舞台侧没有任何 `Cache` API（`caches`）或 `document.cookie` 写入（舞台源上的 `pc_rt` cookie 由服务端在 `/media-s/<sid>/_grant` 响应里以 `HttpOnly` 下发，脚本不可读写）。

## 没做成的及原因

- 第一、二、三阶段代码、单测、探针与报告要求均已完成。沙箱内无法启动回环监听，探针 `scripts/probes/media-cache-probe.mjs` 已在沙箱内通过 `node --check` 语法校验，由 manager 在沙箱外实跑并填入结果。

## 对任务书或语义的更正建议

- `docs/semantics/mechanism/asset-service.md` 的「缓存头」条没有限定账号模式；本分支按任务书要求只在账号云模式（`projectAccess`）下实现，因此旧局域网 / 本机 Bearer 读仍不发 `Cache-Control`（浏览器可能按 `Last-Modified` 做启发式缓存）。建议该条语义注明仅限账号云模式，或由后续任务覆盖旧模式。
- 本分支在长期缓存响应上同时返回了 `Vary: Authorization`（manager 要求的纵深防御；语义未写）。建议将其补入「缓存头」条。
- **残余风险（供主会话与用户决策，本分支不作修改）**：
  - **(a) 原地切换项目时的过渡期定时器**：`syncManager` 原地切换项目时会先断开旧项目的素材连接，促使 `pushMediaPolicy` 先下发一份不带 `cardExec` 的策略，使舞台执行闸门关闭（`src/online/isolation/execGate.ts` 的 `noteMediaPolicy`：`parentAllows = policy?.cardExec === true && !hasTicket`）；随后在新项目路径号生效前，旧舞台文档即被整页重载而不会拿到新项目的 `sid`。但旧项目卡片此前已在该舞台文档里启动的代码（如定时器）在文档重载完成前仍会短暂继续运行；该现象早于本分支存在，且与素材缓存无关。
  - **(b) 舞台卡片参数携带 `/media-s/<sid>/media/<hash>` 地址**：`src/render/mediaTier.ts` 的 `resolveCardParams` 会将 `/media-s/<sid>/media/<hash>` 地址传入舞台卡片的 `params`。若项目 A 的某张卡片把自己的 `params` 写进舞台源的持久化存储（如 `localStorage` / `IndexedDB`），就会把项目 A 的 `sid` 暴露给同舞台源上其它项目的卡片；在本分支之前，该暴露受限于 15 分钟 cookie 寿命与 `no-store`，而在开启长期缓存后，已缓存的素材字节在浏览器保留缓存期间可持续被读取。建议在卡片编写指南中明确禁止将素材 URL 持久化到存储，或在后续改动中不再向卡片代码直接提供含 `sid` 的地址。

## 审查（Opus 高思考档，2026-10-23）

审查范围：`git diff 5e8363ba..HEAD` 的全部代码改动（`server/asset-service.ts`、`server/test/asset-media-cache-headers.test.mjs`、`src/online/stageIsolation.ts` 及其测试、`src/online/stagePolicy.mjs`、`src/editor/Preview.tsx`、`scripts/probes/media-cache-probe.mjs`），对照 `product/asset-service.md` 的「不能跨项目读」「凭票据读写」「浏览器可以长期缓存素材」、`mechanism/asset-service.md` 的「缓存头」、`mechanism/platforms.md` 的「素材票据」与「路径号按账号加项目固定」、`product/platforms.md` 里「用户卡只在隔离环境里执行，拿不到项目凭证与票据」。下文的「路径号」就是舞台读素材的地址 `/media-s/<路径号>/media/<哈希>` 里那一段（代码里叫 sid）。

### 发现

| # | 严重度 | 位置 | 发现 | 处理 |
|---|---|---|---|---|
| 1 | 高 | `src/online/isolation/harden.ts`（原先没有这一节）、`server/hosted/deploy/nginx-snippet-promptcut-stage-headers.conf` | 舞台源上的卡片代码可以随便读写 `localStorage`、`sessionStorage`、IndexedDB、Cache Storage、源私有文件系统（OPFS）、存储桶和旧的 `webkitRequestFileSystem`：加固只把 cookie 改成只读，内容安全策略不管存储。卡片参数里带着 `/media-s/<路径号>/media/<哈希>`（`resolveCardParams`），项目 A 的卡片只要把参数存下来，以后在同一舞台源上运行的项目 B 的卡片就能读到 A 的路径号和哈希。本分支之前路径号每个页面会话一换、cookie 15 分钟、响应 `no-store`，拿到也很快没用；现在路径号跨会话不变、素材字节在浏览器缓存里留一年，B 的卡片可以不经任何服务端核对、一直读到 A 已缓存的素材，A 打开后 15 分钟内还能凭 cookie 读 A 的任何已知哈希。实测见下「验证」：修之前「卡片」写的带路径号地址重启浏览器后还在真实 `localStorage`、`sessionStorage`、IndexedDB、Cache Storage、OPFS、存储桶里。 | 已修，`4ce9b225`、`6e9d7afb` |
| 2 | 中 | `src/editor/Preview.tsx` 原 478 行附近（`pushMediaPolicy` 里的 `setScope`）；`src/editor/sync/syncManager.ts` 1531、1624 行（只读） | 页面原地换项目时，`enterAccountProject` 先 `bind`（编辑器里的项目已经是 B），过一会儿才 `connectSharedAssets`（素材连接换成 B）。原实现只在 `pushMediaPolicy` 里、`await remoteAssetTicket()` 之后才 `setScope`，作用域又优先取素材连接的项目号（这一段里还是 A），所以这段时间里本页仍判「可执行」，B 的卡片包（`onBundles` → `pushCardBundles`）会发进拿着 A 路径号的旧舞台文档并执行；B 的代码能从 ResourceTiming、DOM、卡片参数里看到 A 的路径号与哈希，正是语义「一个舞台文档只用一个路径号……免得新项目的卡片在旧文档里看到上一个项目的路径号」要防的事。本分支之前同样存在（那时两个项目共用一个路径号，更糟），但本分支的整页重载只在素材连接换过来之后才触发，没有真正兑现这条语义。 | 已修，`843d05a3` |
| 3 | 低 | `server/test/asset-media-cache-headers.test.mjs` | 没有用例核「局域网、本机项目的旧模式（没有 `projectAccess`）读 media 不回长期缓存头」：把 `opts.projectAccess &&` 去掉测试照样全绿，而 `764e0105` 的语义写了「旧模式不变」。 | 已补用例 (f)，`55cfe67c` |
| 4 | 提示 | `src/online/stageIsolation.ts:289`、`309` | `everAllowed` 只写不读（基线 `5e8363ba` 里就这样）。「点过头之后任何舞台都不再收到票据」仍然成立：`plan()` 的每个分支都回 `ticket: null`；`Preview.tsx` 里走旧办法 `?t=` 的那一支本来就不点头执行；舞台侧 `execGate.noteMediaPolicy` 在闸门开过之后一律不收票据。没改，建议以后删掉这个死变量或真正用上。 | 未改 |
| 5 | 提示 | `server/asset-service.ts:759` | `bearerOf(req) !== null` 在账号模式下是冗余条件（账号模式下没有 `Authorization` 头时只能凭 `?t=` 进来，而带 `t` 的已被 `hasQueryTicketParam` 排除），留着当纵深防御，无害。 | 未改 |

其余逐项核对、没有问题的：

- **长期缓存头的条件**（`server/asset-service.ts:759`、`377-415`）：只在 `projectAccess`（账号模式）、`ns === "media"`、请求头带 Bearer、地址里没有 `t` 参数（含空 `?t=`）时设；只在 `serveBlob` 真要写 200/206 时、`store.stat` 非空（项目库只对收齐的内容给 stat，用例 (e) 覆盖未收尾单片与只传末片）、读流已打开、`lease.assert()` 通过之后才加；404、416、401、403、400 都走 `sendJson` 或在加头之前返回，保持 `no-store`。`admit()` 先 `setHeader("Cache-Control","no-store")`，`writeHead` 传的同名头优先，所以成功时被长期缓存头覆盖、其它情况保留 `no-store`（用例 (a)(b)(c)(e) 实测）。托管运行时 `resolvePrincipal`（`server/hosted/asset-runtime.mjs:70-78`，只读）在有 `Authorization` 头时只认头里的票据、同时带不一致的 `t` 直接 401、带 Cookie 一律 400，与本分支的条件一致。
- **Range/206**：206 同样带长期缓存头（语义已写「含分段读的 206」），浏览器按分段缓存；416 不带。传输中途读流出错时连接被断，浏览器不会把不完整的回应当完整的缓存。
- **路径号存储**（`stageIsolation.ts:98-201`）：键 `pc.stageSid.v1:<encodeURIComponent(账号)>:<encodeURIComponent(项目)>`，`encodeURIComponent` 会转义冒号，键不会歧义；读回的值必须匹配 `^[0-9a-f]{32}$` 且不与本页其它作用域重复，否则换新并写回；`localStorage` 取不到、`getItem`/`setItem` 抛错都退回本页内存；缺账号或项目号时不碰存储；模块导入时不碰存储（`pageStageIsolation` 懒建）。存储在编辑器页的源上，舞台读不到。
- **原地换项目的整页重载**（`Preview.tsx:497-505`）：与已有的三处整页重载（看守重载、卡片代码过期重载、卸载）同一写法：摘下并 dispose RPC 客户端、清 `rpcRef`/`hostCapsRef`、`frame.src = frame.src`，新文档握手时 `handshake(id)` 清掉 `docSid` 后重推策略。路径号只在素材作用域变化时变，不会来回振荡导致反复重载。
- **单向规矩**：`breach` 之后永不点头、点过头之后不给票据，用例 (f) 与 OCS-S-09、OCS-S-10 覆盖，`843d05a3` 没有动这两处判断。
- **票据与路径号不进地址、日志、Referer**：票据只在 `_grant` 的 `Authorization` 头里，舞台源 `Referrer-Policy: no-referrer`；路径号会出现在 nginx 访问日志的路径里（服务端运维才看得到，单凭路径号在服务端读不到东西，要 cookie）；编辑器页诊断口 `cardExec.sid` 在编辑器源上，卡片代码够不着。

### 三个安全问题的回答

**问题 1：通过浏览器缓存跨项目读（实现报告的残余风险 b）。**

- 卡片代码能不能读写舞台源上的持久存储：**修之前能，全都能**。`harden.ts` 只把 `document.cookie` 改成只读、锁了 `CookieStore.set/delete`；`stageGuard.ts` 只装加固和自检；舞台的内容安全策略（`nginx-snippet-promptcut-stage-headers.conf`）不管存储；卡片在 `loader.ts` 里用 `new Function` 和运行时同一个全局对象执行。无头 Chrome 152 实测：装上原来的加固之后，「卡片」照样把带路径号的地址写进 `localStorage`、`sessionStorage`、IndexedDB、Cache Storage、OPFS、存储桶，同一标签页舞台重载后、重启浏览器后都还在（见「验证」里的反向对照）。
- 能不能看到别的文档的地址：不同文档的 ResourceTiming、DOM 互相看不到；同一个舞台文档里能看到（这就是发现 2）。舞台 iframe 的 `sandbox` 没开 `allow-popups`，开不出同源窗口；加固拦了子框架。
- 舞台运行时自己存不存地址或路径号：不存。舞台文档里写持久存储的只有 `render/playability.ts`（键是 `pc.playable.<浏览器主版本>:<哈希>`，值 `"0"`/`"1"`）、`skins/useSkin.ts`（皮肤常量）、`store/actions/playback.ts`（音量数字），与实现报告「舞台侧存储核查」一致。转译缓存（IndexedDB）只在编辑器页用。
- **修法（`4ce9b225`）**：`harden.ts` 新增 `denyPersistentStorage(scope)`，舞台加固第 6b 步调用；声音线程入口 `soundWorker.ts` 在载入任何卡片代码之前也调用。
  - `localStorage`、`sessionStorage` 换成只在本文档内存里的一份（卡片和运行时照常能用、不报错，文档一换就没了）；方法和 `length` 锁死，列不出、读不到、删不掉真实存储里原有的键。唯一写进真实 `localStorage` 的是取档结论：键必须是 `pc.playable.<数字>:<64 位小写十六进制>`，值必须是 `"0"` 或 `"1"`，所以取档的跨会话缓存不受影响。
  - `indexedDB`、`caches`、`webkitRequestFileSystem*`、`webkitResolveLocalFileSystem*URL`、`openDatabase*` 沿原型链整条改成 `undefined`，不可配置、改不回来（Worker 里这些入口在原型上，同样处理）。
  - `StorageManager.prototype.getDirectory`（OPFS）、`StorageBucketManager.prototype.open`（存储桶）一律拒绝。
  - 缓存收益不受影响：浏览器的 HTTP 缓存不是脚本能列举的存储，探针会话 2 照样 0 次回源、`transferSize=0`。
- **余留风险（如实写明，本分支不再处理）**：
  1. 卡片代码自己 `new Worker(blob:)` 起的线程里仍有 IndexedDB、Cache Storage、OPFS。要靠它存东西得是刻意的代码；而刻意作恶的卡片在项目 A 里运行时本来就能直接把 A 的素材发到外网（出口不限，2026-10-08 用户定），用不着缓存；正常卡片不会为了存参数专门起 Worker。要堵有两条路：包一层 `Worker` 构造函数只放行运行时自己建的地址（会挡掉用 Worker 的卡片）；或把声音线程改成托管的脚本文件、把舞台策略的 `worker-src` 收紧到 `'self'`（要改 `stagePolicy.mjs` 与 nginx 片段，超出本次可改范围）。
  2. 同源的实时通道（`BroadcastChannel`、`SharedWorker`）只在两个文档同时开着、而且两边都配合时才通；`storage` 事件现在只会因取档结论触发，内容只有哈希、没有路径号。
  3. 舞台 iframe 的 `window.name` 在同一个 iframe 整页重载后保留，同样只有刻意写进去才有内容。
  4. 卡片编写指南第 2.4 节已经禁止 remotion 式的卡用 `localStorage` 与全局对象，本次没有改指南（没有新的作者规则；在线舞台上存储只活在本文档，是平台行为，建议写进机制语义，见下）。

**问题 2：`Vary: Authorization`（实现方在语义之外加的，语义已在 `764e0105` 补上）。**

保留。走 cookie 的舞台请求从浏览器出去时不带 `Authorization`（nginx 在上游才加），浏览器存下的条目记的是「请求里没有 `Authorization`」，下次同样没有，照样命中：探针会话 2 素材服务收到 0 次请求、`transferSize=0`，有实测。坏处没有找到：只会让「带不同 `Authorization` 的请求」各存一份；`private` 已经挡住共享缓存，`Vary` 是第二道（万一哪层代理不守 `private`，也不会把凭甲票据拿到的回应给凭乙票据或不带票据的请求）。

**问题 3：其它会削弱「不能跨项目读」「凭票据读写」的地方。**

- 到达服务端的请求：没有发现。跨项目凭哈希读回 404 + `no-store`（用例 (a)、探针「project B」）；撤销、过期、未知票据回 401/403 + `no-store`（用例 (b)）；托管运行时拒绝带 Cookie 的请求（用例 (d)）。长期缓存只影响浏览器本地，服务端每次回源照旧核票据与项目归属。
- 票据或路径号泄进地址、日志、Referer、舞台源存储：票据只在请求头里；路径号不进舞台源存储（问题 1 的修法把卡片这一侧也堵上了）；编辑器页仍有 12 处用 `?t=` 读素材（实现报告第 5 步列的），是本分支之前就有的做法，回 `no-store` + `no-referrer`，本分支没改。
- 发现 2（原地换项目）是本问题下找到并修掉的一处。**修法（`843d05a3`）**：`StageSidScope` 加 `codeProjectId`（此刻打开的项目）；它和素材作用域的项目号都给了又不同时，会话判 `pending`、本页不点头，并通知订阅方（`Preview` 据此重发策略，舞台闸门关上）。`Preview.tsx` 新增 `stageSidScope()`，`pushMediaPolicy` 和 `pushCardBundles` 都用它，`pushCardBundles` 先 `setScope` 再看 `cardExecAvailable()`，于是素材连接没换过来的这一段发出去的是空表，B 的代码进不了旧文档；素材连接换成 B 后路径号变、旧文档整页重载，新文档里才执行 B 的卡。路径号仍只跟素材连接的项目走（cookie 里是那个项目的票据），不会出现「B 的路径号底下存着 A 的素材」。

### 修了什么（提交）

- `4ce9b225`：`src/online/isolation/harden.ts`（`denyPersistentStorage`、`STAGE_STORAGE_PASSTHROUGH_KEY`，加固第 6b 步，`HardenReport.storageDenied`）、`src/online/cardRuntime/soundWorker.ts`、`src/online/isolation/isolation.test.mjs`（OCS-H-09、OCS-H-10）。
- `843d05a3`：`src/online/stageIsolation.ts`（`codeProjectId`、`scopeMismatch`）、`src/editor/Preview.tsx`（`stageSidScope()`、`pushCardBundles` 先重算作用域）、`src/online/stageIsolation.test.mjs`（用例 (g)）。
- `55cfe67c`：`server/test/asset-media-cache-headers.test.mjs` 用例 (f)（旧模式不回长期缓存头）。
- `6e9d7afb`：`scripts/probes/media-cache-probe.mjs` 第 5 项（舞台源持久存储：真实加固、真实 Chrome，同标签页重载与重启浏览器各核一遍）。

### 验证

- `npx tsc -b --force`：退出码 0，无输出（改完后、全量测试之后各跑一次）。
- `server/asset-service.ts` 单独类型检查（`npx tsc --noEmit --strict --skipLibCheck --target es2022 --module esnext --moduleResolution bundler --allowImportingTsExtensions --types node server/asset-service.ts`）：HEAD 与基线 `5e8363ba` 都是 18 条 `TS7016`（未声明类型的 `.mjs` 导入），去掉行列号后逐行相同，没有新增。本次审查没有改这个文件。
- 定向测试（`node scripts/test-suite.mjs`）：引用到改动文件的 14 个测试文件（`c10-ui-gates`、`legacy-preview-target`、`stage-policy-nginx`、`measureGate`、`onlineCardsL`、`stageSwapBaseline`、`cardRuntime`、`onlineCardsG`、`soundThread`、`modeImportGuard`、`stageIsolation`、`stagePolicy`、`isolation`、`c10-cost-plan`）→ `ℹ tests 111` / `ℹ pass 111` / `ℹ fail 0`；`asset-media-cache-headers.test.mjs` → `ℹ tests 7` / `ℹ pass 7` / `ℹ fail 0`。
- 变异核对（改坏、跑、`git checkout` 还原）：`lockAlongChain` 不沿原型链 → OCS-H-10 红；取档键放行不验值 → OCS-H-09 红；判定里去掉 `scopeMismatch` → (g) 红；长期缓存条件去掉 `opts.projectAccess` → 头测试 (f) 红；加固里不调 `denyPersistentStorage` → 探针 8 项 FAIL（见下）。
- 探针 `node scripts/probes/media-cache-probe.mjs`：退出码 0，28 项 PASS，末行 `media-cache-probe: PASS`。原有 14 项照旧通过（会话 2 路径号相同、素材服务 0 次回源、`transferSize=0`；`?t=` 4 次都回源且 `no-store`；项目 B 路径号不同、经 B 的路径号读 A 的哈希回源 404）。新增 14 项：加固收走了 `localStorage`、`sessionStorage`、`indexedDB`、`caches`、`webkitRequestFileSystem`、`webkitResolveLocalFileSystemURL`、`StorageManager.getDirectory`、`StorageBucketManager.open`，存储相关错误 0；卡片在本文档内照常读写 `localStorage`/`sessionStorage`；`indexedDB`、`caches` 为 `undefined`，OPFS 与存储桶拒绝；`window.localStorage` 不可配置、没有访问器；同标签页重载后与重启浏览器后，真实 `localStorage`、`sessionStorage`、IndexedDB、Cache Storage、OPFS、存储桶里都没有卡片写的东西，对照键都在，取档结论 `pc.playable.999:<哈希>="1"` 留存。
  - 反向对照：临时让加固不调 `denyPersistentStorage` 再跑，`media-cache-probe: FAIL (8 failed)`，真实存储里出现 `pc-probe-leak`（`localStorage`、`sessionStorage`、IndexedDB、Cache Storage、OPFS、存储桶各一份）；随即还原，工作区干净。
  - 跑完 6420～6429 上没有监听。
- 全量 `npm test`（单独一条命令，设 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT=C:\Users\admin\Documents\VisuHive`、`PROMPTCUT_PASSWORD_ORDER_MODULE=C:\Users\admin\Documents\VisuHive\account\password-order.mjs`）：退出码 0，`ℹ tests 7688` / `ℹ pass 7673` / `ℹ fail 0` / `ℹ cancelled 0` / `ℹ skipped 15`，`✓ npm test 最终结果：零失败`，用时约 195 秒，没有文件级崩溃重跑。比实现方那次多 4 条，正好是本次新增的 OCS-H-09、OCS-H-10、(g) 和头测试 (f)。
- 测试在 worktree 里留下的 `node_modules/`（只有 `.vite`、`.vite-temp`）和 `data/`：确认没有 junction 或其它重解析点后删掉；主仓库的 `node_modules` 完好。

### 没做的及原因

- 卡片自建 Worker 里的持久存储、`window.name`、同源实时通道：见问题 1 的余留风险，都要刻意的代码才会用到；堵起来要么挡掉正常卡片，要么要改 `stagePolicy.mjs` 与 nginx（不在本次可改清单里）。
- 原地换项目的修法只有单元测试和源码接线核对，没有端到端探针：要真实的托管组合（文档服务、账号、两个项目）在同一页面里换项目，超出本次范围。建议后续在在线浏览器的验收探针里补一条「项目 A 换到项目 B 期间，舞台没收到过 B 的卡片包，直到旧舞台文档重载」。
- 没有改 `server/card-authoring-guide.md`：没有新的作者规则。

### 对语义的更正建议（本次没有改 `docs/semantics/`，交主会话定）

- `mechanism/platforms.md`「路径号按账号加项目固定」里的「舞台一侧不得把路径号存进舞台源的任何存储」只约束了运行时，建议补一句机制（三级，按本次实现）：「卡片代码在跨源舞台上用的 `localStorage`、`sessionStorage` 只活在本文档内存里，IndexedDB、Cache Storage、源私有文件系统、存储桶不给用；舞台源上写进真实存储的只有取档的『能不能放』结论（键只有浏览器主版本与内容哈希）。」若主会话认为这会让卡片作者看到不同（在线卡片的本地存储不再跨会话保留），按二级办；卡片编写指南第 2.4 节本来就不许用 `localStorage`。
- 同一条「一个舞台文档只用一个路径号」后面建议补半句：「页面原地换项目、素材连接还没换过来的那一段，本页不执行用户卡」。
