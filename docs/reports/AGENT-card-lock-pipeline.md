# 卡片级指纹锁：Pipeline Agent 报告

分支 `claude/rq-card-lock-pipeline`（基于契约提交 bc3004a）。规格：`docs/plan/render-queue-contract.md` F.3、F.4（及 E 节）；语义 `rendering.md`「不同环境的结果不混用」「预渲染结果的复用」。

没有改 `server/test/`、`src/**/*.test.mjs`、`server/render-queue/`、`server/render-node/`。

## 逐文件做了什么

### 新建 `server/card-lock.mjs`

- `CARD_LOCK_IDLE_MS = 30_000`。
- `createCardLockStore({ dir, now })`：
  - `get` / `acquire` / `takeover` 同步改内存，回副本；
  - `acquire`：没锁建锁，同指纹只刷新 `touchedAt`（`source` 不变），不同指纹回 `granted: false`、锁不变；
  - `takeover`：整把覆盖，`since = touchedAt = now()`；
  - 写盘：`dirty` 集合加单趟排空，同一把锁连改多次只写最后的样子（整场景路每帧都 `acquire`，不能每帧落一次盘）。每个文件用 `frame-mov.mjs` 的 `atomic` 写，文件是 `<dir>/<contentKey>.json`；
  - `flush()`：等排空；
  - `load()`：目录不存在不算错，坏文件、文件名不是 64 位十六进制的跳过。load 之前内存里已有的锁以内存为准；
  - `list()`：按 `contentKey` 排序；
  - `contentKey` 不是 64 位小写十六进制时 `acquire` / `takeover` 抛 `TypeError`；环境指纹不是非空字符串也抛（契约没写，见疑点 6）。
- `cardLockDecision`：纯函数，按 own → reuse → defer → takeover 的顺序判。`now` 缺省 `Date.now()`，边界是 `now - touchedAt < idleMs` 时 defer，正好等于 `idleMs` 时 takeover。

### 改 `server/frame-pipeline.mjs`

- **构造**：`this.cardLockStore = createCardLockStore({ dir: <root>/controls-lock })`，立刻开始 `load()`，Promise 记在 `cardLocksLoading`；`root` 不是字符串时不建。另有 `cardLockEpoch`：锁让某张卡换了键或换了 `foreign`，它就加一，`snapshotTargets` 的缓存据此失效。
- `ensureCardLocks()`：等那次 `load()` 落定。调用点：
  - `rescanSnapshots()` 开头；
  - `preload` 后台那一趟算 card plan 之前；
  - `cardRender` 算 card plan 之前。
- `applyCardLocks(plan)`：按 F.3 原地改。
  - 条件：`tier`（缺省按 `snapshotTier(capabilities)` 推）是 `shared`，且有 `contentKey`；
  - 第一次见到时记 `ownSnapshotKey` / `ownEnvFingerprint`；
  - 设置 `snapshotKey`、`envFingerprint`、`cardLock`；
  - 幂等，回有没有变。
- `reapplyCardLocks(entry, controls)`：同时重排 `entry.cardPlan` 和调用方手里另一份 control 列表。
- `recordCardPlan` 先调 `applyCardLocks`。
- **不替锁定方产帧**：
  - `snapshotTargets`：过滤掉 `cardLock.foreign === true` 的卡；target 里多带 `contentKey`、本机指纹，供得锁用；
  - `missingSnapshotFrames`：foreign 的卡照常发现有区间（键是锁定方的），不计入「缺」；
  - `fillCardControls`：开工前按锁库重排一遍。foreign 的共享档卡按 `cardLockDecision` 分支：
    - `reuse`：发锁定方的层，`target = null`，PNG 那一支照旧；
    - `defer`：放到工作列表末尾，`lastChance` 再判一次；仍是 `defer` 就整张跳过；
    - `takeover`：`store.takeover(contentKey, 本机指纹, 'prerender')`，重排，用自己键现有的区间（可能为空）发层（`publishRelocked`），再照常产；
    - `own`：锁已回到自己手上，重排后照常。
- **渲之前得锁**：
  - `acquireCardLock(entry, target, controls)`：没有锁库、不是共享档、缺内容键或指纹的，一律当得到；得不到就重排、回 false；刚建了锁时把 `cardLock` 记到 control 上，让诊断看得见；
  - `fillCardControls`：在开渲这张卡之前得锁。本机已有这张卡的结果（`index.count > 0`）时也得锁（见疑点 1）。得不到时 `target = null`，本趟不写 HTML；
  - `recordSnapshots`：每帧入批之前得锁；得不到就不写这一帧，并重取 targets。
- `flushSnapshots`：批交完时，若这张卡此刻锁在别的环境上（`foreign` 且键不同），就不发这一批的层，免得把层换回本机的键。这条是防御性的，正常时序下到不了这里。
- `publishRelocked(entry, controls, control, ranges)`：给同一内容键的每个共享档片段各发一条 `layer`。
- `acceptMeasuredSnapshot(entry, control, { envFingerprint, localFrame, html })`：按 F.3 的 1～6 步做。另加两处：
  - 缺合法 `contentKey` 时回 `NO_CONTENT_KEY`；
  - 第 5 步除 `clipId` 本身外，同一内容键、已换成页面键的其它片段也一起发层（见疑点 3）。
- 诊断：
  - `diagnostics().cardLocks = store.list()`；
  - `planDiagnostics()` 的 control 增加 `cardLock`（没有锁时为 `null`）。

### 改 `server/vite-plugin-frames.ts`（`PUT /api/frames/snapshot`）

- 删掉 E.6 的 `ENV_MISMATCH` 闸。
- 在 `NOT_INDEPENDENT` 之后算页面指纹：
  - 请求体有对象 `environment` 时，用 `describeEnvironment({ platform, renderer, vendor, chromeVersion: userAgent ?? chromeVersion }).fingerprint`；
  - 否则取字符串 `envFingerprint`；
  - 都没有就是 `null`。
- 之后交给 `service.acceptMeasuredSnapshot`，回它的结果（HTTP 200）。
- 编辑器进程一侧的转发不变：请求体原样转发，`environment` 也随之带过去。

### 新建 `src/editor/pageEnvironment.mjs` 与 `pageEnvironment.d.mts`

- 类型声明照 `src/render/*.d.mts` 的做法写。
- `readPageEnvironment({ navigator, document } = globalThis)` 回 `{ platform, userAgent, renderer, vendor }`：
  - `userAgentData.platform` 优先，其次 `navigator.platform`；
  - 用不挂进文档的画布，依次试 `webgl2`、`webgl`，每次 `getContext` 各自 try；
  - 有 `WEBGL_debug_renderer_info` 就读 `UNMASKED_*`，否则读 `RENDERER` / `VENDOR`；读完 `WEBGL_lose_context`；
  - 任何一步失败按空串计，不抛。
- `pageEnvironment()`：缓存一次的结果。
- 页面只报原始值，不自己算指纹。归一规则只在 `fingerprint.mjs` 一处。

### 改 `src/editor/probeRunner.ts`

- `forwardProbeFrame` 的请求体加 `environment: pageEnvironment()`，其余不变。

## 验证

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误（最后一次在提交 8473f19 上跑） |
| 全量测试 | `npm test` | 退出码 0：tests 2121，pass 2120，fail 0，skipped 1（仓库原有的 skip） |
| 自查（不入库） | scratchpad `selfcheck.test.mjs`，`node --experimental-test-module-mocks --test` | 5/5 通过，见下 |
| 轨道流生产探针 | `node scripts/probes/stream-produce-probe.mjs --origin http://127.0.0.1:5240` | 退出码 0，`PASS`，`fails: []` |
| 兜底顺序探针 | `node scripts/probes/preview-fallback-probe.mjs --origin http://127.0.0.1:5240` | 退出码 0，`PASS`，`fails: []` |
| 现场路由核对 | scratchpad `live-route.mjs` 对 5240 | 全部符合契约，原样输出见下 |

**自查**用假 bakery 核对以下情形：

- 无锁时照常渲 8 帧，写在自己的键下，得锁 `source: 'prerender'`，锁文件落盘；之后页面来被拒 `CARD_LOCKED`；
- L3、L4、L5；
- L6：页面已齐时 `bakeFrames` 调用 0 次；PNG 不齐时只渲 PNG，HTML 帧 0；
- L7：先发一条 `ranges: []` 的自己键的层，锁转为 `OWN/prerender`，再产 8 帧；
- L8：`bakeFrames` 调用 0 次，锁仍在页面上。

这不是正式测试，正式的 L1～L8、W1～W2 由测试 Agent 写。

**探针说明**：

- 流探针报的环境：`{"os":"windows","gpuClass":"software","chromeMajor":152,"fingerprint":"258acaaa7c5fe509",...,"detected":true}`，另有 `restart.producedAfterRestart: 0`、`resegment.sigOk: true`。
- 兜底探针：`total.beats 292`，`transparentBeats 0`，`pageErrors []`。
- 跑完兜底探针后，预渲染进程的诊断里有锁 `[{"contentKey":"93772def…","envFingerprint":"258acaaa7c5fe509","source":"prerender",…}]`，每个共享档 control 的 `cardLock` 都是 `foreign: false`。无锁起跑时锁由预渲染进程自己拿下，行为不变。
- dev server 的启动命令是 `npx vite <worktree> --port 5240 --strictPort --host 127.0.0.1`，另设了 `PROMPTCUT_EXPORT_DIR` 指向 scratchpad，帧库从空库起跑，不碰 worktree 的 `out/`。

**现场脚本输出**（原样）：

```
prerender: "http://127.0.0.1:12287"
push project: 200
preload: {"key":"bf7efbf6137c66b1315abf081a574a49e05da573af00b5b8f467b4696fbea8ee","status":"queued","sampled":0,"movSampled":0,"total":60,"error":null,"video":null,"mov":null}
card plan clip-a: {"tier":"shared","contentKey":"b5769ac58ab230f0c46383aa34162e6ed8a554cf1c2fdad1c812dcd511a0c5df","snapshotKey":"dd4c62f7a9badda97b3a2106ff1675b311778fdfbc4f7651b79a0780b20e679c","envFingerprint":"258acaaa7c5fe509","cardLock":null}
prerender fingerprint: "258acaaa7c5fe509"
PUT 不带 environment: {"status":200,"body":{"ok":true,"stored":false,"reason":"ENV_MISSING"}}
fpA / fpB: {"fpA":"ec313bc687208b5c","fpB":"1c195b2d864a0bc2"}
PUT 环境 A: {"status":200,"body":{"ok":true,"stored":true,"indexed":true,"count":1,"envFingerprint":"ec313bc687208b5c","key":"70b34fe947088f9dffc2007e713c27def3430ae492871097b7c6677ac4ebcd1c"}}
A 的 key === resultKeyOf(contentKey, fpA): true
PUT 环境 A 第二帧: {"status":200,"body":{"ok":true,"stored":true,"indexed":true,"count":2,"envFingerprint":"ec313bc687208b5c","key":"70b34fe947088f9dffc2007e713c27def3430ae492871097b7c6677ac4ebcd1c"}}
PUT 环境 B: {"status":200,"body":{"ok":true,"stored":false,"reason":"CARD_LOCKED","lockedBy":"ec313bc687208b5c"}}
diagnostics.cardLocks: [{"contentKey":"b5769ac58ab230f0c46383aa34162e6ed8a554cf1c2fdad1c812dcd511a0c5df","envFingerprint":"ec313bc687208b5c","source":"page","since":1790253353102,"touchedAt":1790253353133}]
plan clip-a 之后: {"snapshotKey":"70b34fe947088f9dffc2007e713c27def3430ae492871097b7c6677ac4ebcd1c","envFingerprint":"ec313bc687208b5c","cardLock":{"envFingerprint":"ec313bc687208b5c","source":"page","foreign":true}}
15 秒后 GET 本机键第 0 帧(应 404): 404
15 秒后 GET 页面键第 0 帧(应 200): 200
15 秒后 cardLocks: [{"contentKey":"b5769ac58ab230f0c46383aa34162e6ed8a554cf1c2fdad1c812dcd511a0c5df","envFingerprint":"ec313bc687208b5c","source":"page","since":1790253353102,"touchedAt":1790253353133}]
```

脚本的做法：

- 项目含一张 `r6-stateful`；
- `preload` 之后每 20 ms 轮询诊断，card plan 一出现就立刻 PUT，抢在锚帧那一趟之前让页面环境 A 先得锁；
- PUT 打的是编辑器进程 5240，顺带验证了转发会把 `environment` 带过去。

从输出能读出三件事：

- 最后两行 `GET` 说明锚帧那一趟和 `fillCardControls` 都没有在本机键下写这张卡（锁定方新鲜、不齐，所以 defer）；
- 锁文件确实落在 `<库根>/controls-lock/<contentKey>.json`，内容与诊断一致；
- fpA、fpB 按本分支的 `normalizeOs` 算（`Win32` / `MacIntel` 此时还是 `other`）。Node Agent 加上前缀映射后，具体数值会变。但路由和节点共用同一份 `describeEnvironment`，所以不影响正确性。

**收尾**：dev server 进程树（cmd 53840 → vite 55196 → 预渲染 43372 → 各 Chrome）已用 `taskkill /T /F` 结束，5240、5241、5242、12287 都不再有 LISTENING。

**没跑的项**：

- `ready-index-probe.mjs`：按任务书不跑，它自带端口 5231；
- `verify-determinism` 与 `verify-unified-frames`：没跑。本次改动只动键的选择和写与不写，不改画面产出路径；无锁时的逐路径行为由全量测试和两条探针覆盖。主 Agent 若要按 `verification.md`「改到快照、预渲染」补跑，需要 5203。

## 没做成的

无。

## 契约疑点与我的选择

1. **本机已有结果、却没有锁文件的卡。** 我在 `fillCardControls` 里也让本机得锁。
   - 情形：锁库之前的 M4 缓存，本机早已产齐，但没有锁文件。
   - 契约的写法：只在「渲之前」得锁。照这个写法，这类卡会被页面的第一帧测量帧锁走，层随之换成页面的键。页面键下只有零星几帧，页面看到的覆盖反而变少，要等页面闲置 30 秒、下一次 preload 才会接手回来。
   - 语义：「最先为这张卡产出这种结果的环境锁定它」，本机是先产出的一方。
   - 所以条件放宽为 `index.count > 0 || 不齐` 时得锁。
   - 仍有的窗口：页面在 preload 走到这张卡之前就推来测量帧，还是会先锁。扫盘阶段只知道结果键、不知道内容键，没法提前得锁。
2. **`defer` 的最后一次判定仍是 `defer`，整张卡跳过，PNG 那一支也不做。**
   - 依据：契约写的是「这一趟跳过」，L8 写的是「不写任何帧」。
   - 另一个问题：「下一次 preload 再判」实际上可能很久不来。同一个 entry、同一代次、状态不是 `error`、`cancelled`、`partial` 时，`preload` 直接早退，不重排后台那一趟。于是页面锁闲置、结果又不齐的卡，要等项目改动或会话换代才会被接手。
   - 需要主 Agent 决定：要不要给 `defer` 加一次延时重排，比如 `CARD_LOCK_IDLE_MS` 之后补一趟 `fillCardControls`。
3. **换键时同一内容键的其它片段一起发层。** 接手（`publishRelocked`）和 `acceptMeasuredSnapshot` 第 5 步都这样做。
   - 契约的写法是只发一条。
   - 但 `applyCardLocks` 会把同一内容键的所有 control 一起换键。只发一条的话，同一张卡摆了几次时，其余片段的层会停在旧环境的键上，要等下一次 `missingSnapshotFrames` 才换过来。
   - 只有一个片段时，行为与契约一致。
4. **`acceptMeasuredSnapshot` 在 control 没有合法 `contentKey` 时回 `NO_CONTENT_KEY`（不写）。** 契约没有这一支。按现在的 `card-cache.mjs`，共享档 control 总有 `contentKey`，这一支只为旧形状兜底。
5. **`flushSnapshots` 对已被锁走的卡不发层。** 这是防御性的：本机一旦得锁，页面就再也拿不到这把锁，所以正常时序下到不了。
6. **锁库对空的环境指纹也抛。** 契约只写了非法 `contentKey` 抛。空指纹得锁会产生一把谁都匹配不上的锁，所以一并拒绝。
7. **整场景路每帧 `acquire` 都会刷新 `touchedAt`。** 写盘已合并，不会每帧落一次盘。本机自己的锁的 `touchedAt` 本机不据此做判断，只在诊断里看得到。
8. **`cardRender`（Agent 查询、导出、交互帧）也按锁换键。** 这些路径的整场景快照因此同样不写被别的环境锁定的卡。导出和 `renderState` 只认 `control.key`（PNG），`key` 不随锁变，所以导出像素不受影响。
