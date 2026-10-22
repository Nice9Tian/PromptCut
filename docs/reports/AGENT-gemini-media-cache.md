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
