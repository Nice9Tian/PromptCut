# 报告：卡片级指纹锁的测试（Verification/Test）

分支 `claude/rq-card-lock-tests`，基于契约提交 `bc3004a`，中途两次 `git merge claude/rq-card-lock` 合进契约 F.7、F.8（只改文档）。2026-09-24。

- 规格：`docs/plan/render-queue-contract.md` F 节（F.5 的 Q1～Q9、N1～N5、L1～L8、W1～W2；F.7 第 6 条的 Q10、Q11、N6；F.8 第 5 条的 L9、L10），以及它引用的 A、B、D、E 节
- 只照契约写测试，没有看三个实现方的代码；读过的生产代码只有本分支里旧版本的公开接口形状（构造参数、方法名、`describe()` 形状），断言一律按契约
- 没有改生产代码

## 1. 文件

| 文件 | 内容 | 条数 |
|---|---|---|
| `server/test/card-lock-queue.test.mjs`（新） | Q0（`lockKeyOf`）、Q1～Q11 | 27 |
| `server/test/card-lock-node.test.mjs`（新） | N1～N6 | 19 |
| `server/test/card-lock-pipeline.test.mjs`（新） | L1～L10 | 21 |
| `src/editor/pageEnvironment.test.mjs`（新） | W1～W2 | 6 |
| `server/test/render-queue-inproc.test.mjs`（改） | I6 第二轮的期望，见第 3 节 | — |

新模块（`server/card-lock.mjs`、`src/editor/pageEnvironment.mjs`）和新出口（`lockKeyOf`）一律按需动态引入或用命名空间引入：它们不存在时只有用到它们的用例失败，不连累整个文件。

## 2. 各编号测了什么

### 队列（`card-lock-queue.test.mjs`）

只经 A.3 的公开接口（`connect` / `handle` / `tick` / `describe`）驱动，复用 `fake-render-queue-env.mjs` 的假时钟和消息收集器。结果键按 B.1 的公式自己算。

| 编号 | 断言要点 |
|---|---|
| Q0 | `lockKeyOf` 从 `index.mjs` 转出；snapshot / stream 且 `input.contentKey` 是非空字符串才有锁键，本地档带 `entryKey/`；plan、没有 input、空串、数字、未知 kind 都是 `null` |
| Q1 | 发布不建锁；首次认领建锁 `{ source: 'claim', since, touchedAt }`；同指纹的其余段照常认领、只刷新 `touchedAt`；流是 `stream:` 锁、与同名快照锁互不相干；完成刷新 `touchedAt` |
| Q2 | 异指纹认领回 `card-locked`（`state: 'open'`、`version`、`lockedBy`），只回给认领者、版本和锁都不变；顺序：`gone` 最先，`card-locked` 在 `stale` 之前（`expectVersion` 错了照样回 `card-locked`），同指纹时 `stale` 照旧；别的卡、别的 kind 不受影响 |
| Q3 | `card.lock`：没锁得锁（`source: 'lock'`）；同指纹 `granted` 并刷新；异指纹不带 / `takeover: false` 回 `granted: false`、锁上的指纹，状态完全不变；回包带 `reqId` 与 `epoch`；12 种格式错误整条 `bad-message`、状态不变；`card.lock` 在 `PUBLISHER_TYPES` 里、不在 `NODE_TYPES` 里；只发过 `node.hello` 或什么都没发的连接回 `not-registered`；先格式后角色 |
| Q4 | 带 `takeover` 发布或 `card.lock` 接手：锁改为 `{ F, 'takeover', now, now }`；旧指纹 `claimed` 的 `version+1`、`failed`、`attempts` 不变、`lastError: 'superseded'`、`claim` 清空，原认领者收 `lease-lost { reason: 'superseded' }`，之后拿旧令牌完成回 `token`；`open` 的同样作废；订阅者（含第二个发布方）收 `task.failed { error: 'superseded' }`；watch 者收 `task.closed { state: 'failed' }`；`done` 的不动；别的锁键不动；与新锁同指纹的任务不作废；第三种指纹再接手作废的是上一任的；锁已经是自己的时带 `takeover` 只刷新 `touchedAt` |
| Q5 | 锁在别的指纹上、任务已存在（锁建起来之前就发布过）：照 A.7.1 合并，`results[i]` 带 `lockedBy`；同指纹、没锁的不带；`takeover: false` 同不带；合并进来的异指纹任务仍认领不了 |
| Q6 | 任务的 `takeover` 不是布尔（`'yes'`、`1`、`0`、`{}`、`[]`、`'false'`）整条 `bad-message`，同条里带合法 `takeover` 的任务也不生效；布尔时不存进任务，`task.opened` / `task.claimed` 的 TaskView 不含它，字段与 A.4 一致 |
| Q7 | 锁回收（F.7 第 3 条严格大于）：done 任务在 TTL 边界还在、锁也在，`+1` 时同一次 tick 里任务删掉、锁随之删掉（第 5 项在第 4 项之后）；没有任务引用的锁恰好 `DONE_TTL` 还在、`+1` 才删；open 任务引用时过多久都不删；刷新推迟回收；被 failed（未过 TTL）任务引用时也不删 |
| Q8 | `describe().locks` 恰好五个字段、按 `lockKey` 排序、深拷贝；一开始是 `[]`；新 epoch 的队列没有锁，谁先认领谁锁 |
| Q9 | 没有锁键（没有 / 空的 `contentKey`）或没有锁指纹（没有 / 空的 `requires.envFingerprint`）的任务、plan 任务：不带 `lockedBy`，带 `takeover` 也不接手、不建锁；认领不建锁、不刷新锁 |
| Q10 | 拒建：锁在别的指纹上、不带 `takeover`、表里没有同 id 任务 → `{ id, error: 'card-locked', lockedBy }`，不建、不广播 `task.opened`；同条消息里别的卡、同指纹、另一种 kind 的照常建；锁被接手后 `lockedBy` 跟着换；因 `limit` 没建成的项不建锁、不接手 |
| Q11 | 没锁时带 `takeover` 发布：建锁（`source: 'takeover'`），同一锁键上异指纹的 open 任务作废（`failed` / `superseded`，订阅者 `task.failed`，watch 者 `task.closed`）；同指纹、别的卡不动；此后异指纹新任务被拒建 |

### 节点（`card-lock-node.test.mjs`）

| 编号 | 断言要点 |
|---|---|
| N1 | `Win32`、`Win64`、`MacIntel`、`Linux x86_64`、`Linux aarch64`、`Windows`、`macOS`、`Linux` 及大写形式按前缀归类；旧映射不变，`freebsd`、`Android`、`iPhone`、`CrOS`、`OpenBSD`、`x11`、`ewin`、`amac`、`unix`、空串等仍是 `other`；用真实页面串（Win / Mac / Linux 的 `navigator.platform`、ANGLE 串、完整 Chrome UA，含 Mac UA 里的 `10_15_7` 和 Edge UA）算出的 `{ os, gpuClass, chromeMajor, fingerprint }` 与 B.1 公式一致；`userAgentData.platform` 与 `navigator.platform` 同指纹；页面 GPU 与预渲染 SwiftShader 指纹不同，页面也是 SwiftShader 时两边相同 |
| N2 | 不给 / 空表 / 空 Map 与 E.5 完全相同；普通对象与 Map 两种形式：被别的指纹锁定的卡（共享档、本地档带 `entryKey/`、流、没有 `contentKey` 字段的旧形状）按锁指纹出键，任务只有 `resultKey`、`id`、`requires.envFingerprint` 变、其余字段不变；锁在自己指纹上的照旧；诱饵键（本地档不带 `entryKey/`、kind 不对、按结果键写的）用另一个指纹，写错锁键就会出别的键；照锁指纹切出的 id 与锁定方自己切出的相同 |
| N3 | `takeover` 为 `true` / `Set` / 函数：命中的被锁卡按本节点指纹出键、每个任务带 `takeover: true`；被锁但没命中的照 N2；没锁或锁在自己指纹上的不带字段；函数收到锁键；缺省 `false`、空 Set、恒假函数都等于不接手；没有锁时 `takeover: true` 不给任何任务加字段 |
| N4 | 会话收到 `claim-rejected { reason: 'card-locked' }`：候选从 `known()` 去掉、在飞的认领清掉，下一拍认领别的，之后五拍都不再认领被锁的；它后来又被 `task.opened` 推来时照常能认领 |
| N5 | 真队列 + M3 的环回和假件：`PlanContext.cardLocks`（Map）锁住标题卡给 FP_B，切分节点 FP_A：标题卡的三段按 FP_B 出键、只被 FP_B 节点认领（指纹不同的节点连试都没试）、做完进产物库，其余照 FP_A；页面收到全部 `task.done`；`PlanContext.takeover`（Set）：标题卡按本节点指纹出键、每个发布的任务带 `takeover: true`，全部由 FP_A 节点做完 |
| N6 | 页面先用 `card.lock` 把标题卡锁给 FP_B：切分节点第一次发布整批，标题卡回 `card-locked`（带 `lockedBy`）；第二次只重发标题卡、按 FP_B、不带 `takeover`；两次 `task.publish` 都带 `reqId`；plan 的 `task.complete` 在第二次回包之后；`derived` 是最终发布成功的全部 id；重发的细任务订阅者里有页面、`source.userId` 是页面的、由 FP_B 节点做完；队列里没有 FP_A 的标题卡死任务。`takeoverLocked` 为 `true` 或函数（收到 `(lockKey, lockedBy)`）：带 `takeover` 按本节点指纹重发，锁转为 FP_A / `takeover`。每次发布前页面都把锁接手到一个新指纹：共发布 3 次（首发 + 重来 2 轮）后放弃，发 `plan-relocked { id, lockKeys, gaveUp }`，plan 照样完成、`derived` 只含成功的，其余细任务照常做完 |

### 本机预渲染进程（`card-lock-pipeline.test.mjs`）

`server/bakery/index.mjs` 用 `mock.module` 整个换成假的（和 `agent-lane.test.mjs` 一样），不起 Chrome：假的 `bakeFrames` 记下每次的 `out` / `targetFrames` / `snapshotFrames`，按契约回调 `onFrame` / `onSnapshot`。`FramePipeline` 注入 `environment`（E.2）、`dataRoot` 指向临时目录、`interactive: false`。card plan 用 entry 自带的真 `CardFrameCache.plan()` 算；`publishLayer` 在实例上包一层记录。每条用例一个 `fs.mkdtemp` 目录，结束删掉（锁库写盘是异步的，删目录带重试）。

| 编号 | 断言要点 |
|---|---|
| L1 | `CARD_LOCK_IDLE_MS === 30000`；`acquire` / `takeover` 同步；得锁、同指纹只刷新 `touchedAt`（`since`、`source` 不变）、异指纹 `granted: false` 并回现有的锁；`takeover` 覆盖且 `since = touchedAt = now`；`list()` 按 `contentKey` 排序；`flush` 后一把锁一个 `<contentKey>.json`、内容是最后一次的状态、没有残留临时文件；新建的库 `load` 读得回；坏文件（坏 JSON、空文件、非 `.json`）跳过、目录不存在不算错；10 种非法 `contentKey` 与空的环境指纹（F.8 第 4 条）抛出，抛出的调用不改内存、不写文件 |
| L2 | `cardLockDecision` 四个分支按顺序：没锁 / 自己的锁 → `own`（不论齐不齐、新不新鲜）；别人的锁已齐 → `reuse`（新鲜、闲置都一样）；不齐且 `now - touchedAt < idleMs` → `defer`；恰好 `idleMs` → `takeover`；`idleMs` 可覆盖 |
| L3 | `recordCardPlan` 里调 `applyCardLocks`：页面锁定的卡 `snapshotKey = resultKeyOf(contentKey, 锁指纹)`、`envFingerprint` 是锁指纹、`cardLock = { envFingerprint, source, foreign: true }`，`key` / `contentKey` 不变；没锁的共享档卡自己的键、`cardLock: null`；本地档不参与；重复调结果相同；锁换回本机 → 自己的键、`foreign: false`；再被别的页面接手又换过去；锁没了 → 自己的键、`cardLock: null`；同一内容键摆在两个片段上时一起换；`diagnostics().cardLocks === store.list()`，`planDiagnostics()` 的 control 带 `cardLock` |
| L4 | `acceptMeasuredSnapshot`：8 种非法指纹 → `ENV_MISSING` 且不建锁；第一帧 `{ stored: true, indexed: true, count: 1, envFingerprint, key: 页面键 }`、写在页面键下、页面得锁（`source: 'page'`）、恰好一条页面键的 `layer`、plan 换成页面键；后续帧 `count: 2`、`layer` 区间变长；别的页面指纹 → `CARD_LOCKED`（`lockedBy`）且一帧不写；锁 `flush` 后新库读得回；同一内容键的两个片段各发一条页面键的 `layer`（F.8 第 3 条）；预渲染进程先得锁时页面被拒；页面指纹与本机相同时写在本机键下、键不变；超限 → `OVER_LIMIT`；没有 `contentKey` → `NO_CONTENT_KEY`、不写、不建锁 |
| L5 | 页面锁定的卡：`snapshotTargets` 不含它；`missingSnapshotFrames` 只回别的卡缺的全局帧、但把它现有的区间以页面键发成 `layer`；限定锚帧时同样不为它要帧；锁在中途（测量帧入库）发生时 `snapshotTargets` 跟着变；`recordSnapshots` + `flushSnapshots` 不写被锁的卡（本机键、页面键都不写），给自己的卡写帧前得锁 |
| L6 | 页面结果已齐：这张卡一帧 HTML 快照都不渲，PNG 那一支照旧（全部帧进 `bakeFrames` 的 `targetFrames` 与 `put`），本机键下不写，`layer` 全是页面键、最后一条是全量；锁不变；自己的卡照常渲、渲之前得锁、发自己的键；PNG 也齐时这张卡一次都不进 `bakeFrames`、照样投递 |
| L7 | 页面锁闲置且不齐：锁转为本机（`source: 'prerender'`，`since` / `touchedAt` 是此刻，落盘）；control 换回自己的键、`foreign: false`；自己键的第一条 `layer` 区间为空、在产出之前，之后不再发页面键，最后一条是全量；整张卡从头渲；页面的旧帧不动；同一内容键的两个片段在渲 HTML 之前都发了自己键的换键 `layer`、最后都到全量；两个片段共用一份快照，HTML 只产一遍 |
| L8 | 页面锁新鲜且不齐：这张卡本趟不进 `bakeFrames`、PNG 也不写、本机键和页面键都不写，锁与键不变，别的卡照做；末尾再判：在别的卡渲染期间页面把帧补齐 → 这张卡判成 `reuse`，在那张卡开始渲之后发页面键的全量 `layer`，不渲 HTML |
| L9 | 走真的 `preload`（会话 `s`），只把 `acquire`、`fillMov`、`prerender`、`save` 换成桩：`cardLockIdleMs: 300`、锁的 `touchedAt` 放在 1.2 秒后，第一趟判 `defer`（锁不变、不渲、别的卡产齐）；之后计时器重判（中间几次仍新鲜再延后），闲置后接手，锁归本机、换回自己的键、产齐、发全量自己键的 `layer`，重判那一小趟借了 background 的预渲染间；另一条：锁一直新鲜，第一趟之后页面把帧补齐，计时器重判改为投递页面键的全量 `layer`，不接手、不渲 HTML。两条都在结束时 `close()` |
| L10 | 本机已产齐、没有锁文件的卡：`fillCardControls` 走到它时不渲、但锁归本机（`prerender`，落盘），此后页面测量帧回 `CARD_LOCKED`（`lockedBy` 本机）；反过来页面在这一趟之前推来测量帧的，仍是页面先得锁，这一趟之后键是页面键、不渲 HTML |

### 页面（`pageEnvironment.test.mjs`）

假 `navigator` / `document` / WebGL 只实现契约写明的调用。

| 编号 | 断言要点 |
|---|---|
| W1 | 读出 `{ platform, userAgent, renderer, vendor }`；`userAgentData.platform` 优先，为空时退到 `navigator.platform`，都没有是空串；只建一个 canvas、不挂进文档；`webgl2` 拿到就不试 `webgl`，拿不到再试 `webgl`；有 debug 扩展读 `UNMASKED_*`，没有读 `RENDERER` / `VENDOR`；读完 `loseContext` 一次；`pageEnvironment()` 读 `globalThis`、只读一次 |
| W2 | 两种上下文都拿不到、`getContext` 抛出、`createElement` 抛出、`getParameter` 抛出、`document` 为 `undefined` / `null` / 空对象、`navigator` 缺失：都不抛，缺的项是空串，其余照读 |

## 3. 改了哪些既有测试

逐处 grep 了 `normalizeOs`、`'other'`、`describe()` 的整体比较、`PUBLISHER_TYPES`、`ENV_MISMATCH`、`frames/snapshot`、`contentKey`、`envFingerprint`：

- `render-node-logic.test.mjs` 的 `normalizeOs` 「其它 → other」列表是 `freebsd`、`aix`、`sunos`、`android`、空串，都不落在新前缀上，不用改；
- `describe()` 的 `deepEqual` 都是「前后两次 describe 相比」，多一个 `locks` 字段不影响；
- 没有既有单测覆盖 E.6 的 `ENV_MISMATCH`（M4 时是主 Agent 现场脚本核对的），无可改；
- `render-node-session.test.mjs` 的联调任务没有 `input.contentKey`，不参与锁；
- **唯一改动：`render-queue-inproc.test.mjs` 的 I6**（F.7 第 6 条）。第一轮已把每张卡、每条流锁给 FP_B，第二轮切分节点是 FP_A：
  - 第二轮的期望细任务由 `expectedDerived(ctx, FP_A)` 改为 `expectedDerived(ctx, FP_B)`；逐轮核对表里第二轮的指纹由 FP_A 改为 FP_B（「每个细任务恰好认领一次」「只被这个指纹的节点认领、指纹不同的节点连试都没试」「requires 是这个指纹与 CV」照旧逐条核）；
  - 原来的「两轮结果键互不相同、第二轮全是真渲染」这一条与 F.7 相反，改为：第二轮的 id 集合等于第一轮的；第二轮 plan 的 `derived` 是照锁指纹出键的那批；每段仍只渲过一次、没有 `dedup`；
  - 另加：按 FP_A 出键的标题卡任务不在表里、也没被认领过（拒建，不留死任务）；
  - 原测试名里「细任务只被与 plan 认领者同指纹的节点认领」对被锁的卡不再成立，测试名改成分两轮说明；
  - 其余断言（`assertCompletedOnce`、plan 的认领者、`hygiene`）没有放宽。

## 4. 运行结果

### 本分支（生产代码仍是旧的）

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误 |
| 队列 | `node --experimental-test-module-mocks --test server/test/card-lock-queue.test.mjs` | 退出码 1；27 条，过 2、挂 25 |
| 节点 | 同上跑 `card-lock-node.test.mjs` | 退出码 1；19 条，过 5、挂 14 |
| 预渲染进程 | 同上跑 `card-lock-pipeline.test.mjs` | 退出码 1；21 条，过 0、挂 21 |
| 页面 | 同上跑 `src/editor/pageEnvironment.test.mjs` | 退出码 1；6 条，过 0、挂 6 |
| 全量 | `npm test` | 退出码 1；tests 2194，pass 2126，fail 67，skipped 1（照旧需要 5190 的 dev server）。67 条全在上面四个新文件（25 + 14 + 21 + 6）加 I6 |

旧实现下的失败原因逐条看过，都是「实现尚未到位」：

- 队列：`lockKeyOf` 没有出口；`describe().locks` 是 `undefined`（`reading 'find'` / `'map'`）；`card.lock` 回 `bad-message`（未知 type）；认领不回 `card-locked`；发布不拒建、不带 `lockedBy`；`takeover` 不校验、不接手。过的 2 条是「锁只按锁键拦」（旧实现不拦，结论相同）与「`card.lock` 格式错误回 `bad-message`」（旧实现把整个类型当未知，结论相同）。
- 节点：`normalizeOs('MacIntel')` 等回 `other`（N1 两条；真实 Mac UA 的主版本旧代码已能取出 139，只差 os）；`splitPlan` 不认 `cardLocks` / `takeover`；N5 第一条因标题卡按 FP_A 出键、期望的 FP_B 任务永远等不到而超步；N6 四条在第一步 `card.lock` 就没得到 `card.locked`。过的 5 条：旧映射不变、不带锁时等于 E.5、`takeover` 不命中时等于不接手、N4 两条（旧会话对非 `stale` 的拒绝一律丢候选，已经覆盖 `card-locked`，与契约 F.2「现有的『非 stale 一律丢』若已覆盖就不用改」一致）。
- 预渲染进程：`server/card-lock.mjs` 不存在（`ERR_MODULE_NOT_FOUND`），或 `pipeline.ensureCardLocks is not a function`。
- 页面：`src/editor/pageEnvironment.mjs` 不存在。
- I6：第二轮 plan 的 `derived` 是 FP_A 键，不是锁定方的 FP_B 键。

### 自检（scratchpad 里的未跟踪副本，跑完已删）

在 scratchpad 写了一份最小实现：`server/render-queue/` 三个文件、`server/render-node/` 的 `fingerprint` / `split` / `local-node`、新建的 `server/card-lock.mjs` 与 `src/editor/pageEnvironment.mjs`、`frame-pipeline.mjs` 的补丁。用一个 `--import` 的解析钩子把 worktree 里对应的模块换成 scratch 里的，其余模块和依赖照旧从 worktree 解析。仓库里没有留下任何文件。

| 项 | 结果 |
|---|---|
| 四个新文件 | 27 / 27、19 / 19、21 / 21、6 / 6 全过；`card-lock-pipeline` 连跑 3 遍都全过 |
| 既有的队列 / 节点 / 指纹 / 文档服务测试（含改过的 I6） | 209 / 209 |
| 全量（`server/test/*.test.mjs`、`src/**/*.test.mjs`、`tools/report-worker/*.test.mjs`） | tests 2194，pass 2193，fail 0，skipped 1 |

种故意的错（每次改最小实现的一处，跑对应的测试文件，看有没有用例失败）：

| 范围 | 抓到 | 没抓到 |
|---|---|---|
| 队列 14 处：`stale` 先于 `card-locked`；锁回收用 `>=`；接手不发 `lease-lost`；不拒建；`card.lock` 异指纹不带 `takeover` 也覆盖；没锁 + `takeover` 不作废；`locks` 不排序；完成不刷新；`takeover` 不校验；作废时 `attempts` 加一；作废把 `done` 也改掉；没有锁指纹也建锁；不带 `lockedBy`；`card.lock` 不在 `PUBLISHER_TYPES` | 14 | 0 |
| 节点 11 处：`mac` 前缀漏了；`cardLocks` 只认普通对象；没锁也加 `takeover`；`requires` 不跟锁指纹；本地档锁键不带 `entryKey/`；拒建后不重发；`takeoverLocked` 被忽略；重来不设上限；不等回包就完成 plan；重发全部任务；`derived` 用第一次切出的 | 11（「本地档锁键不带 entryKey/」起初只有 N3 抓到，把 N2 的诱饵锁改成另一个指纹后 N2 也抓到） | 0 |
| 预渲染进程 23 处：`applyCardLocks` 不认异指纹；`snapshotTargets` 不排除 / 缓存不随锁变；`missingSnapshotFrames` 算缺；延后不再判；接手不发换键层；接手只给当前片段发层；测量帧入库只给当前片段发层；本机已齐不得锁；整场景路写帧前不得锁；没有重判计时器；决策先看闲置再看齐；闲置边界 `<=`；同指纹得锁改 `source`；坏文件让 `load` 失败；指纹接受大写；不报 `OVER_LIMIT`；`flush` 不等写盘；测量帧写在本机键下；非法键不抛；接手不转锁；缺 `NO_CONTENT_KEY`；`reuse` 仍按锁定方键走 HTML 分支 | 22（「接手只给当前片段发层」起初没抓到，给 L7 多片段补了「渲 HTML 之前两个片段都已发换键层」后抓到） | 1：「`reuse` 时不把 target 置空」。锁定方的结果已齐，按它的键算缺帧为空，行为与置空等价，不算漏 |
| 页面 6 处：不看 `userAgentData`；不释放上下文；只试 `webgl`；不读 debug 扩展；不缓存；`getContext` 抛出不就地接住 | 5 | 1：最后一处由外层的 `try` 兜住，行为等价 |

## 5. 契约疑点与建议

1. **`takeover: null`**：F.1 写「不是布尔就整条 `bad-message`」，而 A.10a 与现有校验把可选字段的 `null` 当「没给」。Q6 没有测 `null`（只测了 `'yes'`、`1`、`0`、`{}`、`[]`、`'false'`），建议在契约里定一句。
2. **`card.lock` 在没锁时带 `takeover`**：F.1 的 `card.lock` 写「没锁：建锁（`source: 'lock'`）」，F.7 第 2 条「没锁时带 `takeover`：建锁（`source: 'takeover'`）并作废」是在发布的语境里写的。两处对 `card.lock` 不一致，测试没有覆盖这种组合，建议明确 `source` 取哪个、要不要作废异指纹任务。
3. **F.7 第 2 条作废 `claimed`**：认领一定建锁，锁又只在没有任务引用时才回收，所以「没锁、却有 claimed 的异指纹任务」在正常流程里到不了。Q11 只测了 open 的，这一条写着无妨，但可以注明。
4. **`applyCardLocks(plan)` 要就地改 control**：F.3 接手那一步写「对 `entry.cardPlan` 重跑 `applyCardLocks`」，没有把返回值赋回去，所以测试按「就地改 `entry.cardPlan` 里的 control 对象」写（L3 直接读 `entry.cardPlan`）。建议契约写明是就地修改。
5. **`acceptMeasuredSnapshot` 回包里的 `count`**：契约没说是什么，测试按「这把键 `index.json` 的 `count`（已有帧数）」断言（第一帧 1、第二帧 2）。
6. **`defer` 跳过时 PNG 那一支**：F.3 说 `reuse` 时「PNG 那一支照旧」，`defer` 只说「这一趟跳过」。L8 按字面把「跳过」理解为整张卡都不做，并断言 PNG 也不写（F.5 L8 的「不写任何帧」）。若本意是只跳过 HTML，需要改这一条断言。
7. **换键那一条空区间的 `layer`**：L7 断言接手后先发一条自己键、`ranges: []` 的 `layer`。这条消息经 `publishLayer` 到就绪索引后，页面会不会把它当成「整层换键、丢掉旧环境的帧」，取决于 `ready-index.mjs` 对空区间的处理，本测试只看 `publishLayer` 被调用，没有覆盖线上效果。建议主 Agent 现场核对，或在契约里写明空区间 `layer` 的线上语义。
8. **`plan-relocked` 事件**：只在放弃时发，还是每次照锁重发都发？`gaveUp` 里是任务 id 还是锁键？N6 只在放弃那条里断言：事件存在、`id` 是 plan、`lockKeys` 含标题卡的锁键、`gaveUp` 是非空数组。
9. **L9 依赖的调用点**：延后重判的计时器、那一小趟用 `this.acquire('background', …)` 借预渲染间（断言借用次数变多），以及 `preload` 里只替换 `acquire` / `fillMov` / `prerender` / `save` 就能跑通一趟。若实现把计时器挂在别处（例如 `preload` 的收尾而不是 `fillCardControls` 里），测试仍然成立；若那一小趟不经 `acquire` 借预渲染间，这条断言会失败，需要对照 F.8 第 2 条确认。
10. **没覆盖的**：`rescanSnapshots` / `preload` / `cardRender` 之前 `await ensureCardLocks()`；`PUT /api/frames/snapshot` 的路由（F.5 写明探针不改、主 Agent 现场核对）；`probeRunner.ts` 的请求体（由类型检查兜底）。
11. **F.3 路由把 `environment.userAgent` 当 `chromeVersion`**：这要求 `chromeMajorOf` 能从真实浏览器 UA 里取出主版本。B.1 只列了 `HeadlessChrome/…` 的形式，现有实现对 Mac UA（含 `10_15_7`）和 Edge UA 已经能取对，N1 把这一点钉住了。建议 B.1 补一句「完整 UA 取 `Chrome/` 后的主版本」。

## 6. 提交

见 `git log claude/rq-card-lock-tests`。没有推送、没有合并。
