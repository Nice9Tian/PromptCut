# AGENT 报告：claude/guest-asset-quota

任务：把 `server/account/guest.mjs` 的 `checkGuestAsset` 接到素材服务上传路径，游客往 `media` 传素材最多 3 条、每条不超过 100 MB；账号不受影响；`snap` / `px` 不受限。

分支 `claude/guest-asset-quota`（从 `claude/guest-identity` 切出），未推送、未合并。

## 做了什么

| 文件 | 改动 |
|---|---|
| `server/asset-store/guest-quota.mjs`（新） | 游客限额的接线：`createGuestAssetQuota()` 给出分片、收尾、整件上传三处的判断，和同一数据层内的排队锁 |
| `server/asset-store/index.mjs` | 转出 `createGuestAssetQuota`、`guestQuotaApplies`；文件头补一句「本目录只引 Node 内置模块」的例外 |
| `server/asset-service.ts` | `admit` 透出 `accountId`；`handlePutChunk` / `handleComplete` 前过游客限额；托管下给 `POST /api/media/upload/*`、`POST /api/media/adopt` 加一道游客闸 |
| `server/test/guest-asset-quota.test.mjs`（新） | 9 项测试 |

没有改 `server/account/guest.mjs`（不需要加东西），没有改 `server/hosted/asset-*.mjs`。

### 拦路点 1：上传者是谁

- 托管那条路：`admit` 回包加 `accountId: lease.principal.accountId`。这个主体是文档服务 `/internal/v2/access/check` 核过回来的（`asset-doc-client.mjs` 的字段白名单里有 `accountId`），游客的就是 `gst_…`（`guestPrincipal` 把游客编号放在 `accountId`）。代成员写的云端 Agent，`accountId` 是成员本人，所以 Agent 替游客传也按游客限额算；渲染服务是 `service:render`，只写 `snap` / `px`，不经这里。
- 票据那条路：`accessOf` 三处放行都带上 `accountId: v.userId`。
- 本机回环来源不看票据，不带 `accountId`，不受限。
- `Access` 类型和 `WriteTrace` 各加了字段，`handlePutChunk` / `handleComplete` 从 `WriteTrace` 拿 `accountId` 和限额对象。

### 拦路点 2：已经存了几条

**用数据层的 `usage()` 当场数，没有给 memory-store 补 `list()`，也没有用 `service-usage.mjs`。** 理由：

- `usage()` 本来就在 `BlobStore` 接口里（`blob-store.mjs` 第 46 行），fs、memory 两种实现都有，回 `{ blobs, bytes, staging }`，`blobs` 就是去重后已入库的条数。`authorizedAssetStore` 的代理也已经放行 `usage`。不用改接口。
- `list()` 是 fs 独有的盘点用接口，为了数个数去补 memory 的 `list()`，等于在接口外再长一条；`usage().blobs` 已经够了。
- `service-usage.mjs` 是另一本持久账，只记托管方渲染服务的产物，要和数据层对齐（删素材、删项目都得另外通知它）。当场数就没有对不上的问题：删掉一条、三天清理删掉整个项目，下一次数就跟着变。
- 花销：只有游客的写入才数；fs 实现要扫一遍目录，游客的项目最多 3 条，扫起来很便宜。账号的写入一次都不数。

托管下每个项目一个独立数据层（`project-stores.mjs`），游客只能建 1 个项目、进别人的项目只读写不进去，所以「这个项目的 `media` 有几条」就是「这个游客传了几条」。

### 拦的时机

| 时机 | 查什么 |
|---|---|
| `PUT media/<hash>/<n>`（每一片） | 尺寸：`X-Media-Size` 超过 100 MB 回 403 `guest-asset-too-large`，第一片就拦，不收字节。条数：只在**开新暂存**时数（这个哈希既没入库、也没在收），数 `blobs + staging`，到 3 回 403 `guest-asset-limit`。已入库的同一条（去重）、正在收的续传 / 乱序后几片不算新的一条 |
| `POST media/<hash>/complete` | 再数一次已入库的 `blobs`（这一条自己还在暂存里，不算），到 3 回 403 `guest-asset-limit`，**暂存留着**，删掉一条之后同一条能收尾 |
| `POST /api/media/upload/<名>`（托管下也挂着） | 内容哈希读完才知道，只能按「再多一条」算：`blobs + staging` 到 3 就拒（哪怕传的是已有的一份）；尺寸看 `Content-Length`，超了回 403，游客没带 `Content-Length`（分块编码）回 411 `length-required` |
| `POST /api/media/adopt`（托管下也挂着） | 同上数条数，不看尺寸（文件已经在项目素材目录里） |

开新暂存时数上 `staging`，是为了不让游客同时开任意多个 100 MB 的暂存、一个都不收尾把盘占满。

**并发**：数和写之间有空档。游客的「数 + 开新暂存那一片」「数 + 收尾」「数 + 整件上传（占到回完包）」在同一个项目里排队做（托管下用项目编号当键，本机用那个数据层对象）。账号的写入不排队。测试里两路同时开新暂存，只放进一路。

**整件上传那两条**：任务书没提，但它们在托管组合里确实挂着（`hosted/asset-runtime.mjs` 把 `mediaMiddleware` 接在素材服务后面，`asset-project-http.test.mjs` 也在托管下用 `/api/media/upload`），不拦的话游客绕过分片路由就能随便传。这道闸放在 `assetServiceMiddleware` 里，只在给了 `projectAccess`（托管）时生效：先问一遍 `projectAccess.resolve` 看是不是游客，是就按限额拦，不是游客、或者核权没过，原样交给媒体中间件，行为和以前一样。代价：托管下账号每次整件上传多一次核权往返。

**为什么不在 `asset-service.ts` 里直接 `import "./account/guest.mjs"`**：好几个单测（`asset-service.test.mjs`、`c66-integ.test.mjs`、`media-tiers.test.mjs` 等）把 `asset-service.ts` 单独转译到临时目录，只替换已有的那几条静态 import，再加一条就会解析失败。所以经已经被替换的 `./asset-store/index.mjs` 转出来。

## 验证

### 新测试 `server/test/guest-asset-quota.test.mjs`

托管那条路用真的项目数据层（fs，临时目录）和合成的文档服务权威；票据那条路用 memory 数据层和合成的票据核对。端口一律 0。

| 任务书要求 | 测试 |
|---|---|
| 游客第 4 条被拒 | 第 1 项（分片时 403 `guest-asset-limit`，对账显示连暂存都没开）；第 3 项（收尾时 403） |
| 101 MB 被拒 | 第 2 项：报 101 MB 和 100 MB + 1 字节，第一片都回 403 `guest-asset-too-large` |
| 正好 3 条 / 正好 100 MB 收下 | 第 1 项（3 条）；第 2 项（真传满 104857600 字节，收尾回 `size: 104857600`） |
| 账号 10 条 200 MB 照常 | 第 6 项：真的数据层传 10 条；10 条 200 MB 用「只记一笔不落盘」的数据层（只验限额这一层放不放行，不往临时盘写 2 GB），分片和收尾都回 200 |
| `snap` / `px` 不受限 | 第 5 项：游客各传 5 条，200 MB 的第一片也收 |
| 删掉一条之后又能传 | 第 3 项：收尾被拒后暂存还在；删一条后同一条能收尾；再删一条后能传新的 |
| （另加）已有的同一条再传 | 第 1 项：满 3 条后重传第 1 条照收 |
| （另加）并发 | 第 4 项：两路同时开新暂存，结果是 [200, 403] |
| （另加）两个游客互不影响 | 第 7 项 |
| （另加）整件上传 | 第 8 项：游客满 3 条后 403；报 101 MB 长度当场 403；分块编码 411；账号传 5 条照收 |
| （另加）票据路径与本机回环 | 第 9 项 |

单独跑：

```
$ node --test --test-timeout=40000 server/test/guest-asset-quota.test.mjs
ℹ tests 9
ℹ pass 9
ℹ fail 0
ℹ duration_ms 4264.3091
```

反证（把 `guestTrace` 和整件上传闸临时关掉再跑，跑完 `git checkout` 还原）：涉及游客被拒的 6 项全红，`snap/px`、账号、两个游客那 3 项照旧绿。说明测试确实在验接线，不是空过。

```
✖ 游客：正好 3 条收下，第 4 条在分片时就回 403 …
✖ 游客：101 MB 在第一片就回 403 …
✖ 游客：收尾时再数一次 …
✖ 游客：并发开两个新暂存，只放进一个
✔ 游客：snap / px 不受限
✔ 账号：10 条照收 …
✔ 游客的限额按各自项目数 …
✖ 整件上传 /api/media/upload …
✖ 票据路径 …
ℹ pass 3
ℹ fail 6
```

### 基线

类型检查：

```
$ npx tsc -b --force
TSC_EXIT=0
```

全量测试：**在本分支上不全绿**，原因是越界的一处文件清单，见下节「全量测试结果」。

渲染附加项（导出确定性、快照重放、看图）：不适用。这次只改素材服务的写入放行，不出画面。

## 发现的问题与对任务书 / 语义的更正建议

1. **「3 条素材」和「3 个块」对不上（要用户定）。** 在线浏览器传一段视频是**两个**块：先传浏览器里转出来的素材小尺寸，再传原尺寸（`src/editor/io/mediaUpload.ts` 的 `uploadOnlineMediaFile`、`src/online/mediaUploadQueue.ts`，两档都进 `media` 命名空间、各有各的哈希）。素材服务没有项目语义，分不出哪个块是哪一条素材的小尺寸，所以现在按块数：游客传一段视频就占 2 个名额，第二段视频的小尺寸进去了、原尺寸会被拒，页面上看是「第 2 条就满了」。图片、音频一条一个块，不受影响。
   可选的改法：
   - (a) 页面传小尺寸时带一个头（例如 `X-Media-Tier: small`，要加进跨源允许的头），素材服务把小尺寸和原尺寸分开数，各 3 个。最坏情况游客把原尺寸也标成小尺寸，多占一倍（6 × 100 MB），有上限。要改 `src/online/`，不在我的清单里；对外接口多一个头，按二级办。
   - (b) 按块数但把上限放宽到 6：图片就能传 6 张，和文案「3 条」不符。
   - (c) 维持现状，把页面文案改成按块算的说法。
   建议 (a)。
2. **托管下 `?tiers=1` 的整件上传会在服务端多转出一个素材小尺寸**（`media-tiers.mjs` 的 `prepareImport`，转出的文件落在同一个 `media` 目录），放行时按 1 条算、事后变 2 条。在线浏览器不走这条路（它自己转、自己分片传），只有直接调接口才会碰到。没有拦，记在这里。
3. **游客扔下的暂存会一直占名额**：开新暂存时数了 `staging`，游客传到一半关了页面，那个暂存要等同一条续传收尾、或者三天后整个项目被清掉才腾出来；中间想换一个文件传会被拒。素材服务现在没有清暂存的接口，也没有暂存过期。不数 `staging` 又会让游客能开任意多个 100 MB 的暂存占盘。我选了数；要更好，得加暂存过期（三级机制，`fs-store.mjs` / `memory-store.mjs` 里加），或给页面一个撤销暂存的接口。
4. **素材服务没有删素材的 HTTP 接口**，所以「删掉一条之后又能传」测试里是直接调数据层的 `remove()` 模拟的。实现是当场数，数据层少了一条就能再传；现实里会让游客腾出名额的是三天清理（删整个项目）。游客想删一条换一条，现在做不到，这是产品上的空缺，不是这个分支的事。
5. **托管下同一个项目里别人写的也占名额。** 按项目数，所以游客自己的项目里如果有别的成员（账号）传了素材，也算在这 3 条里。游客的项目一般只有他自己；真有别人加入并上传，算法上就是「这个游客项目一共 3 条」。语义写的是「游客能传 3 条」，严格说是按人。要按人数得在数据层记每个块是谁传的，没有这个信息。建议语义里明确成「游客的项目最多 3 条素材」，或者接受现状。
6. **票据那条路（本机 / 局域网素材服务）只有一个全局 `media` 数据层**，游客票据在这里按整个库的条数数，偏严。游客只在云端有，本机文档服务不发游客令牌，现实里碰不到；只是 `userId` 透出来之后照同一套规则走。
7. 任务书说「`list()` 回 `{hash,size}[]`，memory-store 没有」，这一条属实，但数个数不需要它，`usage()` 两边都有（见上）。

## 全量测试结果

两个环境变量按任务书设（Windows 路径形式），用 `npm test`。

### 第 1 次（本分支原样）：23 项失败，全是同一个原因

```
ℹ tests 7695
ℹ pass 7656
ℹ fail 23
✖ npm test 最终结果：仍有失败
```

失败里出现 25 次 `{"event":"asset.config-error","code":"ERR_MODULE_NOT_FOUND"}`（`asset-wiring-integration`、`move-guard`、`account-*`、`accept-018-*` 等起独立素材进程的测试）。
原因：独立素材进程是按 `server/hosted/files.mjs` 的 `HOSTED_ASSET_DEPLOY_FILES` **逐个文件**拷进暂存目录再起的（`asset-entry-stage.test.mjs` 守着这个闭包），
我新加的 `server/asset-store/guest-quota.mjs` 和它引的 `server/account/guest.mjs` 不在清单里。

**`server/hosted/files.mjs` 不在我能改的清单里**（只允许 `server/hosted/asset-*.mjs`），按规矩停在这里，没有提交这处改动。要补的是两行：

```diff
   'server/account/client.mjs',
+  'server/account/guest.mjs',
   'server/account/ledger.mjs',
 ...
   'server/asset-store/fs-store.mjs',
+  'server/asset-store/guest-quota.mjs',
   'server/asset-store/index.mjs',
```

（补丁另存在会话草稿目录 `files-mjs.patch`，内容就是上面这两行。）

### 第 2 次（临时打上这两行再跑，跑完已 `git checkout` 还原，没提交）

```
ℹ tests 7736
ℹ pass 7718
ℹ fail 1        （另 2 项 cancelled，同属下面的超时）
✖ npm test 最终结果：仍有失败
```

`ERR_MODULE_NOT_FOUND` 出现 0 次。剩下 3 处：

- `agent-live-selection.test.mjs`：`test timed out after 30000ms`
- `asset-project-workers.test.mjs`：真 ffmpeg 转码，`test timed out after 20000ms`
- `cloud-tools-p3-track.test.mjs`：`TRACK_FAILED`「读不出视频分辨率」

都是全量并发下的超时 / ffmpeg 探测，和素材上传放行无关。单独重跑（仍打着那两行，用 `npm test -- <文件>`，带上起独立素材进程的两项和新测试）：

```
$ npm test -- server/test/agent-live-selection.test.mjs server/test/asset-project-workers.test.mjs server/test/cloud-tools-p3-track.test.mjs server/test/asset-entry-stage.test.mjs server/test/asset-wiring-integration.test.mjs server/test/guest-asset-quota.test.mjs
ℹ tests 40
ℹ pass 40
ℹ fail 0
✓ npm test 最终结果：零失败
```

结论：打上 `files.mjs` 那两行后基线可以全绿（3 处是偶发，单独重跑全过）；不打，本分支的全量测试是红的。
任务书点名的偶发文件 `multi-agent-presence.test.mjs`、`user-editing.test.mjs` 两次都没红。

## 待主 Agent 决定

1. 在 `server/hosted/files.mjs` 补上面两行（或授权我补）。不补不能合。
2. 「3 条素材」按块数还是按素材数（上节第 1 条），建议 (a)。
3. 游客扔下的暂存占名额（上节第 3 条）要不要加暂存过期。
