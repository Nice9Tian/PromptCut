# M4 测试方报告（Verification/Test）

分支 `claude/rq-m4-tests`，worktree `.worktrees/rq-m4-tests`，基于 `d5082a8`（契约 E 节）。

规格只认 `docs/plan/render-queue-contract.md` E 节（以及它引用的 B.1、B.4）、设计 `distributed-prerender-queue.md` 2.1、语义 `rendering.md`「不同环境的结果不混用」。没看 M4 的实现。

## 做了什么

### 新建 `server/test/env-fingerprint-keys.test.mjs`（18 条，编号 F1～F8）

公共夹具：一份 browserPlan（`card-cache.mjs` 的 `plan()` 收的 graph 形状，照 `card-cache.test.mjs`），里面有两张共享档卡（`clip-a` 90 帧、`clip-c` 45 帧）和一张本地档卡（`clip-b`，belowDependent）。两种环境：`ENV_A` = Windows + SwiftShader + Chrome 138，`ENV_B` = macOS + Apple M2 + Chrome 139，都由 `describeEnvironment` 算出。

| 编号 | 用例 | 测了什么 |
|---|---|---|
| F1 | 1 条 | SwiftShader / NVIDIA / AMD / Intel 的 ANGLE（D3D11）串，`Apple M2`、Metal 串、llvmpipe、Microsoft Basic Render、空串的归类；`HeadlessChrome/138.0.7204.49`、完整 UA、纯版本号、数字 → 138；指纹 16 位十六进制、同输入稳定、三项任一不同就不同；与 B.1 公式（独立用 `node:crypto` 算）一致；`resultKeyOf` 与公式一致 |
| F2 | 2 条 | **第一条是任务书要的明确对比**：同一份 browserPlan、`FP_A` / `FP_B` 两个 `CardFrameCache`，`clip-a` 的 `contentKey` 相同、`cacheContentKey` 相同，`snapshotKey` 不同、`key` 不同，并验证 `snapshotKey === resultKeyOf(contentKey, fp)`、`key === resultKeyOf(cacheContentKey, fp)`、`envFingerprint === fp`。第二条：三个 control 逐个成立、四个键都是 64 位十六进制；`costKey` 相同；去掉 `key` / `snapshotKey` / `envFingerprint` 后其余字段逐字段相同（E.3「其余字段不变」）；同一指纹算两次、函数形式与字符串形式结果完全相同；共享档、本地档、PNG 路由正则仍匹配 |
| F3 | 2 条 | 不传、`undefined`、`''`、`() => null`、`() => undefined`、`() => ''`、数字、函数返回数字 → `plan()` 抛 `Error`，消息含「环境指纹」。第二条：空 graph、`plan(null)` 也抛（E.3「plan() 开头解析」）；函数形式在 `plan()` 时才解析（指纹后定下来的情形，即 `FramePipeline` 的 `() => this.envFingerprint`） |
| F4 | 2 条 | 同一个 entry 在两种指纹下，单卡流（预算 6，两条）和组流（预算 1，一条）的 `contentKey` 相同、`streamKey` 不同且等于 `resultKeyOf(contentKey, fp)`，spec 带 `envFingerprint`，流路由正则仍匹配；指纹为 `undefined` / `''` / `null` / 不传时返回 `[]`。第二条：两种环境各自的 `plan()` 输出（成员的 `snapshotKey` / `key` 已经不同）算出的 `contentKey` 仍相同，即成员键取内容键 |
| F5 | 2 条 | 临时目录（`fs.mkdtemp`，`finally` 里删）。共享档、本地档（`snapshotDir`）、PNG 缓存（`controls/<key>`）、流（`streams/<streamKey>`，并核对 `StreamStore.dir`）两种环境共 8 个目录两两不同；A 写的共享档、本地档快照，B 的键读不到、索引为空；A 存的流清单 B 读不到，扫盘只挂 A 的键。第二条：独立卡 PNG 缓存，A 的 `CardFrameCache` 写一帧，A 读得到，同一个库根上 B 的 `CardFrameCache` 读不到 |
| F6 | 1 条 | `splitPlan` 喂真实 `plan()` 与 `planStreams` 的输出：共享档 `resultKey === control.snapshotKey`、`input.contentKey === control.contentKey`；本地档 `input.contentKey === <entryKey>/<contentKey>`、`resultKey === resultKeyOf(那个串, fp)`；流 `resultKey === spec.streamKey`、`input.contentKey === spec.contentKey`；`requires.envFingerprint`、id 公式；两种指纹的任务 id 集合不相交，按内容键一一对应 |
| F7 | 4 条 | 动态引入 `server/bakery/environment.mjs`。假 page 把传进来的函数按 Puppeteer 的做法用源码重建（所以函数必须自包含），在假 `document` + 假 WebGL 里真的执行，不依赖 evaluate 回值的形状（契约没规定）。正常路径（读 UNMASKED_*，不读打码的 `gl.RENDERER`；先试 `webgl2`；canvas 不挂进文档；调了 `WEBGL_lose_context`；evaluate 收到函数；`detected: true`）；只有 `webgl`、没有 debug 扩展时读 `gl.RENDERER` / `VENDOR`；SwiftShader 照实归 `software`；没有 WebGL → 两个空串、`software`、`detected` 仍为 true；`version()` 抛出、`evaluate` 抛出、`evaluate` 永不返回（`timeoutMs: 50`）、`version()` 永不返回、两步都失败 → 不抛、`detected: false`、缺项按空值、指纹按空值算 |
| F8 | 4 条 | `new FramePipeline({ root, origin: () => '', environment })`，root 用临时目录。注入 `environment` 时 `ensureEnvironment` 不探测，`entry.cardCache.plan` 用注入的指纹，`diagnostics().environment` 可见。不注入时 `environment` / `envFingerprint` / `diagnostics().environment` 都是 `null`，此时 `entry.cardCache.plan` 抛「环境指纹」；三个并发 `ensureEnvironment` 只调一次 `version()`、一次 `evaluate`；定下来之后同一个 entry 的 `cardCache` 按这个指纹出键；换一个 GPU 的 bakery 再调不探测、结果不变。`detected: false` 的结果也终身不变。bakery 缺 `browser`、缺 `page`、`null`、`undefined`、`{}` 时都不探测、不定指纹，真 bakery 来了才探测 |

### 改了的既有测试（只补输入，断言一处没动）

用 grep 查了 `new CardFrameCache`、`planStreams(`、`.plan(`、`snapshotKey`、`streamKey`。

| 文件 | 改动 | 为什么 |
|---|---|---|
| `server/test/card-cache.test.mjs` | 加常量 `ENV_FP = '0123456789abcdef'`；两处 `new CardFrameCache({ ... })` 加 `envFingerprint: ENV_FP` | 两条用例都调 `plan()`，E.3 起没有指纹就抛 |
| `server/test/frame-stream.test.mjs` | 加常量 `ENV_FP`；六处 `planStreams(...)`（原第 175、186、188、199、217、230 行）的选项加 `envFingerprint: ENV_FP` | E.4 起没有指纹返回 `[]` |

没有既有断言把 plan 的 `snapshotKey` 直接和 `cardSnapshotIdentity(...)` 比，所以不需要改成和 `resultKeyOf(...)` 比。

查过、不用改的：

- `frame-cache-validation.test.mjs`：不带指纹构造了 `CardFrameCache`，但只调 `put` / `renderState` / `hasComplete`，不调 `plan()`。E.3 说这些方法照旧只认 `control.key`，所以不补。
- `render-node-logic.test.mjs`：B.4 夹具没有 `contentKey` 字段，按 E.5 回退到 `snapshotKey` / `streamKey`，原断言照样成立。
- `render-queue-inproc.test.mjs`、`prerender-schedule.test.mjs`、`snapshot-store.test.mjs`、`ready-*.test.mjs`、`frame-preload.test.mjs`：control 都是手写的，不经 `plan()` / `planStreams`。`planDiagnostics` 那条测试只取 `clipId` / `costKey` / `picked`，新增字段不影响。
- 构造 `FramePipeline` 的其它测试（`agent-lane`、`cards-layout`、`frame-memory`、`frame-playback` 等）不走 `cardCache.plan`。

### 探针（只 `node --check`，没跑）

- `scripts/probes/ready-index-probe.mjs`：新增 ⑩，读已有的 `/api/frames/diagnostics` 回包，检查 `environment.fingerprint` 是 16 位十六进制；诊断里有带 `snapshotKey` 的 control；每个带 `snapshotKey` 的 control 满足 `snapshotKey === resultKeyOf(contentKey, envFingerprint)`，而且它的 `envFingerprint` 就是本进程的指纹。文件头的验收清单补了第 10 条。
- `scripts/probes/stream-produce-probe.mjs`：生产完成后取 `pipeline.diagnostics()`（这支探针在本进程里起 `FramePipeline`，不走 HTTP），检查上面三条，另查 `diagnostics.streams.streams[]` 的 `streamKey === resultKeyOf(contentKey, environment.fingerprint)`，并要求流列表非空。文件头补了第 13 条。
- 两支都从 `server/render-node/fingerprint.mjs` 引 `resultKeyOf`，检查写法照原有的 `check(...)`。

## 验证结果

| 命令 | 结果 |
|---|---|
| `npx tsc -b --force` | 退出码 0，零错误 |
| `node --check` 两支探针和新测试文件 | 都是 0 |
| `node --experimental-test-module-mocks --test server/test/env-fingerprint-keys.test.mjs`（旧实现） | 18 条：1 过（F1），17 挂（F2～F8） |
| `node --test server/test/card-cache.test.mjs server/test/frame-stream.test.mjs`（旧实现） | 23 条全过：旧实现忽略多传的参数 |
| `npm test`（旧实现） | 2104 条：2086 过，17 挂，1 跳过。挂的 17 条正好是 F2～F8，其余全绿 |

旧实现下 17 条失败，原因都是实现还没到位，不是测试写错：

- F2、F3、F5、F6：`plan()` 输出里没有 `contentKey` / `cacheContentKey`，没有指纹也不抛（例如「expected 'string', actual 'undefined'」「Missing expected exception」）。F5 算出的 8 个目录只有 4 个不同；F6 的 `resultKey` 不等于 `snapshotKey`。
- F4：`planStreams` 不认 `envFingerprint`，spec 没有 `contentKey`，两种指纹的 `streamKey` 相同。
- F7：`server/bakery/environment.mjs` 不存在（ERR_MODULE_NOT_FOUND）。
- F8：`FramePipeline` 没有 `environment`（是 `undefined` 不是 `null`），也没有 `ensureEnvironment`（TypeError）。

**测试自检**：为了确认失败是因为实现没到位、而不是测试写错，我在 worktree 里建了一个不入库的临时副本 `.shadow-m4/`，复制 `server/`、`src/`，在副本里按契约 E.1～E.5 写了一份最小参考实现，然后把新测试跑在它上面：

- 18/18 全过。
- 变异测试，9 个变异都被抓到：
  - 流成员键用 `snapshotKey`：F4、F6 挂；
  - 组流成员键用 `key`：F4 挂；
  - 切分的快照内容键用 `snapshotKey`：F6 挂；
  - 切分的流内容键用 `streamKey`：F6 挂；
  - 去掉 single-flight：F8 挂；
  - `detected: false` 不定下来：F8 挂；
  - 读打码的 `gl.RENDERER`：F7 挂；
  - 去掉超时：F7 挂；
  - 不释放上下文：F7 挂。
- 在副本上跑全量测试，只有 2 条挂：`bake-protocol`、`dev-server-junction`，都是因为副本里没复制 `scripts/`（ERR_MODULE_NOT_FOUND），在真 worktree 里这两条是过的。

跑完后副本已删除（删之前查过，没有 junction），不影响分支内容。

## 意外：误写了主工作区一个文件，已还原

改 `card-cache.test.mjs` 时，第一次用 PowerShell 的 `[IO.File]::ReadAllText/WriteAllText` 配相对路径，这个 API 按进程的当前目录解析，也就是主仓库根，不是 worktree。结果主工作区的 `server/test/card-cache.test.mjs` 被写入了我的改动。

发现后我先用 `git diff` 确认改动只有我那几行，再在主工作区 `git checkout -- server/test/card-cache.test.mjs` 还原；之后主工作区 `git status` 是干净的。从那以后改文件一律用 Edit 工具或绝对路径。

## 对契约的疑点和建议

1. **E.1 没有规定 `evaluate` 回值的形状**（对象、数组都有可能）。测试绕开了这一点：在假 DOM 里真的执行那个函数。建议主 Agent 不必补，但如果以后有别的调用方要复用这段函数，最好写明形状。
2. **E.1「缺的那项按空值计」没说空值是 `''` 还是 `null`**。测试在失败路径只要求假值；「没有 WebGL」那条照「返回两个空串」严格要求 `''`。
3. **E.1 的 `timeoutMs` 没说是每一步还是整体**。测试两种理解都能过：只要求在约 3 秒内放弃。
4. **E.3「plan() 开头解析」**：F3 第二条按字面要求空 graph、`plan(null)` 也抛。如果实现方把检查放在「没有 nodes/outputs 就返回 `[]`」之后，这条会挂，需要主 Agent 裁定。我认为按字面：没有指纹时一律报错更安全。
5. **E.5 本地档的结果键与盘上目录键不对应**：
   - 本地档任务 `resultKey = resultKeyOf(<entryKey>/<contentKey>, fp)`，而盘上目录是 `controls-local/<entryKey>/<snapshotKey>`，其中 `snapshotKey = resultKeyOf(contentKey, fp)`。两者不是同一个键。
   - 共享档没有这个问题：共享档有 `resultKey === snapshotKey`。
   - 这是 B.4 留下来的写法，E.5 明文保留了，测试照写。
   - 建议主 Agent 确认这是有意的：执行本地档任务的节点要从 `input.entryKey` 和 `input.contentKey` 自己算目录。
6. **E.6（`PUT /api/frames/snapshot` 的 `ENV_MISMATCH` 闸）在 F1～F8 和两支探针里都没有覆盖**。建议后续给 `vite-plugin-frames.ts` 的这个处理器补一条单测，或者在探针里 PUT 一帧、断言回 `stored: false, reason: 'ENV_MISMATCH'`。本任务没做，因为它不在 E.7 的清单里，也不在我的文件范围里。
7. **E.2 的两个调用点没有单测**：`bakery()` 里 `openBakery` 之后、`loadProject` 之前，`leaseStreamBakery()` 里 `openBakery` 之后。它们只由两支探针的「`diagnostics.environment.fingerprint` 是 16 位十六进制」间接覆盖。要单测，可以照 `agent-lane.test.mjs` 用 `--experimental-test-module-mocks` 模拟 `./bakery/index.mjs` 的 `openBakery`。E.7 没要求，没做。
8. **`frame-cache-validation.test.mjs` 不带指纹构造 `CardFrameCache`、但不调 `plan()`**，按 E.3 我没改它。如果实现方在构造函数里就校验指纹，这条会挂，那就是实现偏离了契约。

## 需要主 Agent 决定

- 合并本分支，还是等实现分支合进来、在同一处重跑 F1～F8 和 `npm test` 之后再合。
- 疑点 4（空 graph 也抛）和疑点 5（本地档结果键）的裁定。
- 疑点 6、7 要不要另立测试任务。
