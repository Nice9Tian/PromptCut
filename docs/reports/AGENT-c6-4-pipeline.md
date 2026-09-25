# C6.4 预渲染管线侧实现报告（c6-4-pipeline）

- 分支：`claude/c6-4-pipeline`（从 `claude/c6-4` 的 dc1addc 起）
- 依据：`docs/plan/manifest-contract.md` 第 3、4、5 节；`artifact-transfer-contract.md`（含第 10、11 节）；`docservice-contract.md`；`cloud-task.md` A3b、A5
- 文件：`server/artifact-transfer.mjs`、`server/artifact-push.mjs`（新）、`server/frame-pipeline.mjs`、`server/frame-stream.mjs`、`server/vite-plugin-frames.ts`。没有碰 `server/render-node/`、`server/test/`、`server/docservice/`。
- 端口段：5500～5509（本分支 dev server 5500，基线对照 5503，`ready-index-probe` 自带的 dev server 5506）

## 进度

- [x] 第 3 节：`createAssetSink` 接 `content`、`resultFor`、`put` 之后写清单
- [x] 第 4 节：`artifact-push.mjs` 推送队列
- [x] 第 4 节：`frame-pipeline.mjs` / `frame-stream.mjs` 钩子
- [x] 第 5 节：`adoptFromManifests` 与调用点
- [x] 第 4 节末段：`vite-plugin-frames.ts` 接线（方案见下）
- [x] 验证：tsc、npm test、G0-R、自测

## 做了什么

### 第 3 节：`server/artifact-transfer.mjs`

- `createAssetSink({ pipeline, client, content?, log? })`：
  - `has(ref)`：先看本机帧库（同 C6.2）；不覆盖且给了 `content` 时，按 `<resultKey>:<from>-<to>` 取清单。清单的 `v` / `kind` / `resultKey` / `range` 对得上、覆盖整段（`frames` 覆盖每一帧，或 `segments` 覆盖每个分段号且 init 在）、每个块 `client.has` 都在，三条都满足才回 `true`，并把清单记在 sink 里。
  - `resultFor(ref)`（异步）：本机覆盖的由 `collect*` 现算；查内容库得到的回记下的那份；都不是回 `null`。
  - `put`：`pushResult` 成功后 `content.put(kind, key, result)`；写失败或超限只记日志（`log('manifest.put-failed' | 'manifest.too-large', …)`），不影响 `{ complete: true, result }`。
- 新增导出：`manifestKindOf`、`manifestKeyOf`、`manifestMatches`、`spansOf`（与 `split.mjs` 的 `spans` 同一个式子）、`blocksPresent`、`writeManifest`。
- `collectSnapshotResult` 的 `opts` 新增 `location: { tier, entryKey, dirKey }`：推送队列的段自带落盘位置，直接给进来，不再按 E.9 反算。不给时行为与 C6.2 相同。
- `applyResult` 拉快照时给 `commitSnapshots` 多带一个 `adopted: true`（快照库不看它），推送钩子据此不把拉来的帧再进推送队列。

### 第 4 节：`server/artifact-push.mjs`（新）

`createPushQueue({ pipeline, client, content, dir, log, concurrency = 2 })` → `{ enqueue(unit, priority), start(), stop(), stats() }`，另有 `drain()`、`poke()` 和只读的 `client` / `content` / `file`。

- **进队**：同一段（`<kind>:<resultKey>:<from>-<to>`）已在队里就只合并优先级；正在推的那一段又进队，推完再推一遍（推的时候读的是旧帧库）。`enqueue` 回 `true` 表示新进了一段。
- **优先级**（数字越小越先推）：`max(调用方给的卡级, 这一段自己看得出的下限, 块级)`。
  - 下限：流、本地档、`canvasHeavy` 至少 1。
  - 块级在这一段轮到之前读帧库算：`index.json` 的 `oversize` 与本段相交就是 2；否则按帧文件算 `data:image` 占比，`dataImageBytes` 照抄 `snapshot-size-probe.mjs` 的正则，超过一半就是 1。
  - 同级按进队先后。
- **执行**：并发 `concurrency` 段，每段依次 `collect*`、`pushResult`、`content.put`。
  - 失败按 5 s、30 s、120 s、之后每 10 min 退避，不放弃。
  - 例外有两种。清单超过 256 KiB 的段永远写不进内容库，记日志后丢掉。帧库里这一段一帧都没有的，不写空清单，直接出队。
- **落盘**：`<dir>/push-queue.json`（缺省 `pipeline.root`）经 `atomic` 写回，进队、完成、失败时都写，多次写合并成一次。
  - 创建时同步读回，所以重建后 `stats().restored` 立刻可见。
  - 已完成的段不留。`stop()` 停派新活、等在推的段收尾、等文件写完。
- **挂接**：建好后自动挂到 `pipeline.pushQueue`；传 `attach: false` 可以不挂。
- 本实现另加的可选项：
  - `settleMs`（缺省 0）：同一段最后一次进队后静置多久再推；
  - `backoff`：退避表；
  - 注入时钟：`clock: { now, setTimeout, clearTimeout }`，或者分开传 `now` / `setTimeout` / `clearTimeout`。

### 第 4、5 节：`server/frame-pipeline.mjs`、`server/frame-stream.mjs`

- 构造参数新增 `pushQueue = null`，字段 `this.pushQueue`。
- **快照钩子**：`snapshots()` 建出 `SnapshotStore` 时把实例上的 `commitSnapshots` 包一层（`batch` 也经它），快照库文件本身没改。
  - **没配推送队列时原样返回原来那个 promise**：不多一个 tick，不写任何文件。
  - 配了时，这一批帧落在哪几段，每段 `enqueue` 一次（`enqueueSnapshotPush`）：
    - 共享档：`resultKey` 就是共享键；
    - 本地档：`resultKey = resultKeyOf("<entryKey>/<contentKey>", 指纹)`，`dirKey` 是目录键。要在 card plan 里找到这张卡才算得出来，找不到就不进队；
    - 段长 `QUEUE_DEFAULTS.SNAPSHOT_SPAN`（60），从 0 起切。card plan 里查得到这张卡时最后一段到 `count - 1`，查不到就按整段长算。
- **流钩子**：`storeSegment` 存完清单、发完层之后，只在 `pipeline.pushQueue` 存在时调 `pipeline.enqueueStreamPush(spec, segment)`。
  - 段从 `spec.firstSegment` 起每 `STREAM_SEGMENTS`（8）个一段，最后一段到 `lastSegment`，与 `split.mjs` 一致；
  - 优先级 1。
  - `adoptSegments` 拉来的分段不经 `storeSegment`，所以不会再推回去。
- **卡级优先级** `cardPushPriority`：以下几种回 1，其余共享档回 0：
  - 本地档；
  - `canvasHeavy`；
  - 明写的 `unknown` / `belowDependent` / `context`；
  - 图卡（`isGraphCardControl`，见疑点 3）。
- **`adoptFromManifests(entry, content, client, { signal }?)`**：
  - 按 card plan 的共享档、本地档 control，以及 `planStreams` 算出的每条流，按同一种切法算出各段的键；
  - 本机已有整段的跳过；然后并发 4 路 `content.get`，查不到的跳过；
  - 清单与这一段对得上（快照另核 `tier` / `dirKey` / `entryKey`）就交给 `applyResult`；
  - 回 `{ manifests, fetched, written }`，只有这三个字段。跳过、缺失、失败的计数放在 `this.lastAdoption`，供诊断看；
  - 内容库断线（`code: 'disconnected'`）就停止，剩下的段不再查。
- **调用点**：在 `preload` 的后台那一趟里，`adoptCardPlan` 之后、`fillAnchorSnapshots` 之前。只在 `browserPlan && this.pushQueue` 时调，出错吞掉。
- `diagnostics()` 只在配了推送队列时多出 `push`（队列的 `stats()`）和 `adoption`；没配时形状不变。
- `closeNow()` 在配了推送队列时调 `pushQueue.stop()`。

### 第 4 节末段：`server/vite-plugin-frames.ts`

按下面写定的方案实现：`startArtifactPush(root, service)`，在 `frameService()` 首次建管线后异步调用；`httpServer` 关闭时先收尾推送（停队列、关 WebSocket），再关管线。日志前缀 `[artifact-push]`；每段推完、空段这两种不打日志，免得刷屏。

## 接线方案（动手前写定，`vite-plugin-frames.ts`）

只在**预渲染进程**（`isPrerender`）里、`frameService()` 第一次建出 `FramePipeline` 之后异步做一次。它不挡 `frameService()` 返回；任何一步出错只打日志，不建队列。

1. **无头实例不建**：`PROMPTCUT_HEADLESS === "1"` 时直接跳过。口径与 C6.3 第 10 节第 6、14 条相同：无头实例是临时副本，不该往共享服务写东西。
2. **素材服务的基址**：
   - 用 `asset-client.ts` 的 `assetServiceOrigin()`。在预渲染进程里它就是 `PROMPTCUT_EDITOR_URL`，也就是编辑器进程里挂的本地素材服务；
   - 基址 = `<origin>/api/asset`，取不到（null）就不建；
   - 客户端：`createAssetClient({ base, token: PROMPTCUT_CLUSTER_TOKEN || null })`。
3. **文档服务**：照契约用 `render-node` 的 `resolveDocservice()`（缺省 env、全局 fetch、每个候选探活 3 s）。
   - 回 `offline` 就不建；回 `remote` / `local` 才用它的 `url` 建 `createWsEndpoint({ url, token })`，再 `createContentClient(endpoint)`。
   - `createContentClient` 在 `claude/c6-4-node` 上，合并前 `render-node/index.mjs` 里还没有它。这里用动态 `import("./render-node/index.mjs")` 去取，取不到就打一行日志、不建队列。合并后自然生效，类型检查也不受影响。
4. 两样都有了才 `createPushQueue({ pipeline: service, client, content, dir: service.root, log, settleMs: 1500 })`，挂到 `service.pushQueue`，再 `start()`。
   - `settleMs` 是本实现加的可选项，缺省 0：同一段最后一次进队后静置这么久再推，免得边渲边推时一段 60 帧被推十几遍。
   - 测试不传就是 0，不受影响。
5. **关闭**：`httpServer` 关闭时先 `queue.stop()`，再关 WebSocket 端点。
6. **离线就是不建**：上面任何一个条件不满足，`service.pushQueue` 就保持 `null`。所有钩子都成了空操作，行为与现在逐路径相同。

默认开发环境下没设 `PROMPTCUT_DOCSERVICE_URL`，本机 8787 上也没有独立文档服务，`resolveDocservice` 会回 `offline`，所以 G0-R 自然跑在不推送状态。开工时查过：本机 8787 没有监听，`PROMPTCUT_DOCSERVICE_URL` 未设。G0-R 期间又从预渲染进程的 `/api/frames/diagnostics` 核对了一次，回包的键是 `ok,oversize,promotions,plans,streams,ready,environment,cardLocks`，没有 `push`，确认没建队列；帧库根下也没有 `push-queue.json`。

## 验证

最终代码是 127751c。全量测试跑完之后才起 dev server，两者没有同时跑。

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误 |
| 全量测试 | `npm test` | 退出码 0：tests 2352，pass 2351，fail 0，skipped 1。跳过的是需要 5190 的「集成:/api/cards/layout 对真实项目返回整数框」 |

### G0-R（默认不推送状态）

本分支 dev server：`node C:\Users\admin\Documents\PromptCut\node_modules\vite\bin\vite.js --port 5500 --strictPort --host 127.0.0.1`，工作目录是本 worktree，舞台端口 5501、5502。

| 项 | 命令 | 结果 |
|---|---|---|
| 导出确定性 | `node scripts/verify-determinism.mjs --url "http://127.0.0.1:5500/?export=1"` | 退出码 0，1800/1800 相同 |
| 导出与快照重放一致 | `PC_FRAME_TEST_URL=http://127.0.0.1:5500 node scripts/verify-unified-frames.mjs` | 退出码 0，`PASS: no video during B; all HTML frames; exact video seek; random replay; cache hits; cumulative C equals A; streamed video contains all 10 frames.` |
| 就绪索引 | `node scripts/probes/ready-index-probe.mjs --port 5506` | 退出码 0，`"fails": []` |
| 轨道流生产 | `node scripts/probes/stream-produce-probe.mjs --origin http://127.0.0.1:5500` | 退出码 0，`"fails": []`，PASS |
| 同上，组流 | 同上加 `--group` | 退出码 0，`"fails": []`，PASS |
| 预览兜底 | `node scripts/probes/preview-fallback-probe.mjs --origin http://127.0.0.1:5500` | 退出码 0，`"fails": []`，PASS |
| 同上，页面自触发 | 同上加 `--page-preload` | 退出码 0，`"fails": []`，PASS |
| 与 main 逐像素对比 | 见下 | 1800 帧，不同帧 0，不同像素 0 |

逐像素对比的做法：

1. `git worktree add --detach .worktrees/c6-4-baseline main`，当时 main 在 4665995；
2. 在 5503 起 dev server，跑同样的 `verify-determinism`，结果 1800/1800 相同；
3. 用 pngjs 逐帧、逐像素比较两边的 `out/verify-a/frames`：帧数 1800，不同帧 0，不同像素 0，退出码 0。

收尾：

- 两个 dev server 都用 `taskkill /T /F` 按我启动的 PID 连同子进程关掉，5500～5509 已经没有监听；
- 删 baseline worktree 之前，用 `Get-ChildItem -Attributes ReparsePoint -Recurse -Force` 查过，junction 为 0 个，然后 `git worktree remove --force` 删除。

### 自测（不提交）

文件在 scratchpad：`c64-selftest.mjs`。

- 跑法：`node --experimental-test-module-mocks --test c64-selftest.mjs`，退出码 0，9/9 通过，耗时约 10 s。
- 环境：
  - 两个临时帧库，各一个真的 `FramePipeline`（`mock.module` 换掉 bakery，不开 Chrome）；
  - 一台真 HTTP 的 memory 素材服务：`server/test/fake-asset-service.mjs`，配真客户端 `createAssetClient`；
  - 一个内存假内容库，接口照第 2 节。

| 用例 | 断言与关键输出 |
|---|---|
| 推送（W1 式） | card plan 里 `count = 130`，一次 `commitSnapshots` 写 130 帧，`stats().enqueued = 3`。推完后清单键是 `…:0-59`、`…:60-119`、`…:120-129`，每个块 `client.has` 为真，实际上传 130 块，`push-queue.json` 的 `items` 为 `[]` |
| 推送，查不到卡 | card plan 里没有这张卡时，最后一段按整段长算，是 `…:120-179`（见疑点 2） |
| 优先级（W2 / W3 式） | 进队顺序故意反着排：超体积、`data:image`、本地档、共享档。`concurrency: 1` 下实际推送顺序是 `shared-normal, dataimage-low, local-low, oversize-lowest`，两个 low 之间按进队先后。本地档清单键用 E.9 的结果键，正文的 `dirKey` / `entryKey` 正确 |
| 去重（U1～U4 式） | A 的 sink `put` 之后，内容库正文等于 `result`。B 本机没有也 `has = true`，`resultFor` 回同一份。假装缺一块时 `has = false`；清单只剩前 30 帧时 `has = false`。不给 `content` 时只看本机 |
| 换机取用（A1 式） | A 推完 3 段（共享档 100 帧、本地档 30 帧）。B 用同一份 card plan 调 `adoptFromManifests`，回 `{"manifests":3,"fetched":130,"written":130}`。B 的两个目录与 A 逐字节相同，会话收到 `k1` 的 `html` 层和 `k2` 的 `local` 层，渲染计数 0。B 也配了推送队列，但拉来的帧没有进队（`enqueued = 0`）。再调一次回全 0 |
| 换机取用（A2 式） | 共 150 帧，删掉 `60-119` 的清单，回 `{"manifests":2,"fetched":90,"written":90}`，`lastAdoption.missing = 1` |
| 落盘（W4 式） | 180 帧、3 段、`concurrency: 1`。推完第一段后停掉，队列文件里留下未完成的段，另一段在停的时候正好推完。同一 dir 重建后 `restored` 与文件一致，推完后上传总数 180（每块一次），清单 `put` 总共 3 次（已完成的不重推） |
| 退避（W5 式） | 注入时钟。坏段在时钟过 35 s 之前一律 500：好段先推完，坏段第一次失败后定时器是 5000 ms，第二次是 30000 ms，第三次成功。`failures = 2` |
| W6 式 | 没配推送队列时：`pushQueue === null`，`commitSnapshots` 照常回 index，不生成 `push-queue.json`，`diagnostics()` 里没有 `push`，`enqueueStreamPush` 回 false |
| 流 | `firstSegment 3`、`lastSegment 20`，对 3、10、11、19、20、20 号分段调 `enqueueStreamPush`，进队三段 `3-10`、`11-18`、`19-20`，都是 low。手工造的 `3-10` 推到 `px`，`render-manifest` 键是 `…:3-10`。B `applyResult` 回 `{"written":8,"skipped":0,"fetched":9}`。另外两段帧库里没有分段，按空段出队，没有写清单 |

**没测到的**：

- `adoptFromManifests` 里流的那一支：要真的 card plan 和项目才能让 `planStreams` 出规格，自测里没造；
- `storeSegment` 里真的钩子触发：要真 fMP4。

这两处留给 `claude/c6-4-tests` 的 A1 与 W3 真机验证。

## 契约疑点（都按最保守读法做了）

1. **本地文档服务找不到**：`resolveDocservice` 的本机候选是独立文档服务 `ws://127.0.0.1:8787`（探 `/healthz`），找不到 C6.3 挂在编辑器进程里的那一份（`ws://<编辑器>/docservice`，健康检查在 `/api/docservice/healthz`）。
   - 契约第 4 节只认 `resolveDocservice` 回 `remote` / `local`，所以这里**不另探**；
   - 后果是只开编辑器、不设 `PROMPTCUT_DOCSERVICE_URL` 时不推送；
   - 要不要把挂载的那一份也算作「能连上」，请主会话裁定。若要算，得改 `endpoint.mjs`，或者在接线里多探一个候选，而且默认开发环境也会开始推送，G0-R 的「不推送状态」就要另设开关。
2. **查不到卡时最后一段的 `to`**：钩子只从 `commitSnapshots` 的参数拿不到 `count`，要靠 card plan。
   - card plan 里查得到这张卡时，最后一段到 `count - 1`，与 `split.mjs` 一致；
   - 查不到时（例如测试直接对裸管线 `commitSnapshots`）按整段长算，130 帧的第三段键就是 `…:120-179`；
   - 测试方若按 `120-129` 断言，需要先给管线登记 card plan。
3. **图卡判不了**：A5 要求图卡按 low 推，但服务端的 card plan 没有能判图卡的字段；`split.mjs` 的 `isGraphCard` 也是调用方注入、缺省 false。
   - 本实现只认 control 上明写的 `graphCard: true`，或者 `capabilities.graphCard: true`，缺省按非图卡；
   - 需要卡片计划补这个字段，或者给管线一个判据。
4. **「一半以上」的边界**：按 `cloud-task.md` A3b「超过一半」取严格大于，正好一半算 normal。
5. **怎么「配推送队列」**：契约只说「管线配了推送队列」，没定形状。本实现三种都认：
   - 构造参数 `pushQueue`；
   - `createPushQueue` 建好后自动挂到 `pipeline.pushQueue`（可以 `attach: false`）；
   - 直接赋值 `pipeline.pushQueue = queue`。
6. **注入时钟的选项名**：契约没写。本实现认 `clock: { now, setTimeout, clearTimeout }`，也认分开传的 `now` / `setTimeout` / `clearTimeout`。
7. **两种不重试的情况**：「不放弃」之外只有两种。
   - 清单超过 256 KiB（`result-too-large` / `too-large`）：永远写不进内容库，记日志后丢掉；
   - 帧库里这一段一帧都没有：不写空清单，直接出队。
8. **内容库清单写失败的处理不同**：
   - 在 sink 里只记日志，照契约第 3 节，任务清单已经随 `task.done` 走了；
   - 在推送队列里算这一段失败、要重试，因为不经队列的产物没有清单就没人找得到（C6.2 第 0 节）。
9. **在推的段又进队**：「同一段已经在队里就不重复」只管排队中的段。正在推的段又来新帧时，推完会再推一遍：`put` 会跳过已有的块，清单整体覆盖成更全的一份。W1 那种一次写完的情形仍然恰好进队一次。

## 需要主会话决定

- 疑点 1（挂载的本地文档服务算不算「能连上」）、疑点 3（图卡的判据）。
- 合并：本分支依赖 `claude/c6-4-node` 的 `createContentClient` 才能真的建队列。合并前接线会打一行 `push.skip no-content-client`，行为与现在相同。
