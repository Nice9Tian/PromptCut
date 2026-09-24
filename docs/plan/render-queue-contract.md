# 渲染任务队列 M1 / M2 接口契约（定稿）

主 Agent 定稿，2026-09-24。实现方（Protocol/State、Pipeline/Node）和测试方（Verification/Test）**只照本文和设计写**，互不看对方的代码。本文要改只能由主 Agent 改，并同时通知各方。

- 上位文档：`docs/plan/distributed-prerender-queue.md`（下称「设计」，含第 5.1 节 C1～C6）
- 任务书：`docs/plan/TASK-distributed-prerender-queue.md`（下称「任务书」，第 4、5 节）
- 优先级：设计 > 本文 > 任务书。本文是设计的逐字段展开；三者有冲突时由主 Agent 裁决，一律以设计为准。

标 **〔裁〕** 的条目是设计没写死、由主 Agent 在定稿时裁定的细则。

---

## A. M1：`server/render-queue/`

### A.1 模块与出口

- `server/render-queue/index.mjs`：导出 `createRenderQueue`、`QUEUE_DEFAULTS`、`QUEUE_ENV`、`taskIdOf`
- `server/render-queue/constants.mjs`：`QUEUE_DEFAULTS`、`QUEUE_ENV`
- `server/render-queue/messages.mjs`：入站校验、出站构造、`taskIdOf`
- `server/render-queue/queue.mjs`：状态机

纯 ESM，只可以引 Node 内置模块（`node:crypto`），不引仓库里别的模块，不读环境变量，不开计时器，不做 I/O。

### A.2 常量

```js
export const QUEUE_DEFAULTS = Object.freeze({
  LEASE_MS: 30_000, RENEW_INTERVAL_MS: 10_000, SWEEP_INTERVAL_MS: 5_000,
  RECONNECT_GRACE_MS: 10_000, STALL_MS: 120_000, MAX_ATTEMPTS: 3,
  DONE_TTL: 600_000, MAX_TASKS_PER_PROJECT: 5000,
  SNAPSHOT_SPAN: 60, STREAM_SEGMENTS: 8, PICK_K: 4,
});
export const QUEUE_ENV = Object.freeze({
  LEASE_MS: 'PROMPTCUT_QUEUE_LEASE_MS', RENEW_INTERVAL_MS: 'PROMPTCUT_QUEUE_RENEW_MS',
  SWEEP_INTERVAL_MS: 'PROMPTCUT_QUEUE_SWEEP_MS', RECONNECT_GRACE_MS: 'PROMPTCUT_QUEUE_GRACE_MS',
  STALL_MS: 'PROMPTCUT_QUEUE_STALL_MS', MAX_ATTEMPTS: 'PROMPTCUT_QUEUE_MAX_ATTEMPTS',
  DONE_TTL: 'PROMPTCUT_QUEUE_DONE_TTL_MS', MAX_TASKS_PER_PROJECT: 'PROMPTCUT_QUEUE_MAX_TASKS',
  SNAPSHOT_SPAN: 'PROMPTCUT_QUEUE_SNAPSHOT_SPAN', STREAM_SEGMENTS: 'PROMPTCUT_QUEUE_STREAM_SEGMENTS',
  PICK_K: 'PROMPTCUT_QUEUE_PICK_K',
});
```

M1 / M2 都不读 `QUEUE_ENV`，只导出名字（设计第 8 节 Q4）。

### A.3 构造与方法

```js
const q = createRenderQueue({ now, send, constants, epoch });
```

| 参数 | 必填 | 说明 |
|---|---|---|
| `now` | 是 | `() => number`，毫秒 |
| `send` | 是 | `(connId, message) => void`，队列只经它往外发；每条出站消息由队列补上 `epoch` 字段 |
| `constants` | 否 | 覆盖 `QUEUE_DEFAULTS` 的部分键 |
| `epoch` | 否 | 字符串；缺省 `crypto.randomUUID()` |

| 方法 | 说明 |
|---|---|
| `connect(connId, principal)` | 新连接。`principal = { userId: string, tenantId: string }`。同一 `connId` 重复 `connect` 视为新连接（先按断开处理旧的） |
| `disconnect(connId)` | 连接断开。未知 `connId` 忽略 |
| `handle(connId, message)` | 处理一条入站消息。同步 |
| `tick()` | 时钟推进后调用，做 A.8 的四项扫描。同步 |
| `describe()` | 诊断，见 A.10 |
| `epoch` | 只读属性 |

`handle` 和 `tick` 执行中不让出事件循环，也不回调调用方（`send` 除外）。**比对再加锁**靠这一点成立。

未 `connect` 过的 `connId` 调 `handle`：忽略，不发任何消息。

### A.4 任务 id 与入站任务

```js
taskIdOf({ kind, resultKey, range })
// kind === 'plan'      → `plan:${resultKey}`
// 其余                  → `${kind}:${resultKey}:${range.from}-${range.to}`
```

`task.publish` 里每个任务（`TaskInput`）：

```js
{
  id: string,                    // 必须等于 taskIdOf(...)，否则整条消息 bad-message
  kind: 'plan' | 'snapshot' | 'stream',
  tier?: 'shared' | 'local',     // snapshot 必填；其余忽略
  resultKey: string,             // 非空。plan 任务是 `${projectId}@${projectRev}`，且必须与 source 一致
  range: { unit: 'localFrame' | 'segment', from: int, to: int } | null,   // plan 为 null；其余必填，0 <= from <= to
  source: { projectId: string, projectRev: int, derivedFrom?: string | null },
  input?: object,                // 原样保存
  weight?: { class: 'light' | 'medium' | 'heavy', estMs?: number | null, frames?: number | null },
  requires?: object,             // 原样保存（envFingerprint、codeVersion、cardSources 等）
  priority?: int,                // 缺省 0
}
```

队列补的字段：`source.userId`、`source.tenantId`（来自发布连接的 `principal`，入站自报的丢弃）、`source.publisher = { id: publisherId }`、`source.publishedAt = now()`、`source.derivedFrom`（缺省 `null`）。

**派生任务的继承**（设计第 3 节「细任务继承 `plan` 任务的 `userId`，不取切分节点的身份」）〔裁〕：新建任务时，若 `source.derivedFrom` 指向一个**现存的 `plan` 任务 P**，且 P 此刻是 `claimed`、认领者就是发布连接对应的节点（`P.claim.nodeId` 等于这条连接 `node.hello` 的 `nodeId`），则：

- `source.userId`、`source.tenantId` 取 P 的，不取发布连接的 `principal`；
- 订阅者 = {本发布方} ∪ P 此刻的订阅者（页面订阅了 `plan`，就能收到细任务的 `task.done`；切分节点断开也不会让细任务因为没人订阅而被删）。

条件不满足（P 不存在、不是 `plan`、不在 `claimed`、认领者不是本节点）时不继承，按上一段取 `principal`，不报错。之后 P 的订阅者变化不再传给已建的细任务。已存在的同 `id` 任务按 A.7.1 处理，不重新继承。

**任务视图 `TaskView`**（出站消息里的任务）：

```js
{ id, kind, tier?, resultKey, range, source, input, weight, requires, priority, state, version, attempts }
```

不含 `claim`、`subscribers`。

### A.5 连接角色

- 连接发 `node.hello` 后是**节点连接**，发 `publisher.hello` 后是**发布连接**。一条连接可以两者都是。
- 节点身份是 `nodeId`，发布方身份是 `publisherId`。身份跨连接：同一身份的新连接取代旧连接。
- 没发过 `node.hello` 的连接发 `queue.watch` / `task.claim` / `task.progress` / `task.complete` / `task.release` / `task.fail`，回 `error { reason: 'not-registered' }`。没发过 `publisher.hello` 的连接发 `task.publish` / `task.unsubscribe`，同样回 `not-registered`。〔裁〕

### A.6 入站消息

所有入站消息可带 `reqId`（任意字符串或数字），回包原样带回。

| `type` | 字段 | 成功回包（发给本连接） |
|---|---|---|
| `node.hello` | `nodeId: string`、`profile: 'pc' \| 'host' \| 'browser'`、`envFingerprint?: string`、`capabilities?: object`、`codeVersions?: string[]`、`maxConcurrent?: int`、`resume?: [{ id, token }]` | `node.welcome { nodeId, resumed: [id], lost: [id] }`；每个 `lost` 另发一条 `task.lease-lost` |
| `publisher.hello` | `publisherId: string` | `publisher.welcome { publisherId }` |
| `queue.watch` | `projects: string[] \| 'all'` | `queue.snapshot { tasks: TaskView[] }`（只含可见的 `open` 任务，见 A.9） |
| `task.publish` | `tasks: TaskInput[]`（至少 1 个） | `task.published { results: [...] }`，见 A.7.1 |
| `task.unsubscribe` | `ids?: string[]` 或 `projectId: string, projectRev?: int`（二选一） | `task.unsubscribed { ids: [实际移除了订阅的 id] }` |
| `task.claim` | `id: string`、`expectVersion: int` | `task.claimed { id, token, version, leaseUntil, task: TaskView }` 或 `task.claim-rejected { id, reason, state?, version? }` |
| `task.progress` | `id`、`token: int`、`done: number` | `task.renewed { id, token, leaseUntil }` |
| `task.complete` | `id`、`token`、`result?: { ranges?: any }` | `task.completed { id }` |
| `task.release` | `id`、`token`、`reason?: string` | `task.released { id }` |
| `task.fail` | `id`、`token`、`error?: string`、`retryable?: boolean`（缺省 `true`） | `task.fail-ack { id, state }`（`state` 是处理后的状态：`open`、`failed`，或没有订阅者被删时的 `removed`） |

- **格式错误**（缺必填字段、类型不对、`id` 与 `taskIdOf` 不符、`plan` 的 `resultKey` 与 `source` 不符、未知 `type`、消息不是对象）：回 `error { reqId, reason: 'bad-message', detail: string }`，**整条消息不生效**，状态不变（C6）。
- **令牌不符**：`progress` / `complete` / `release` / `fail` 的 `id` 不存在，或任务不是 `claimed`，或 `token !== claim.token`，或发消息的节点不是当前认领者：回 `task.lease-lost { id, token, reason: 'token' }`，状态不变。

### A.7 状态转移

任务状态：`open` | `claimed` | `done` | `failed`。**每次状态转移 `version += 1`**；`task.progress` 不是状态转移，不改 `version`。新建任务 `version = 1`、`attempts = 0`。

#### A.7.1 发布（`task.publish`）

逐个处理 `tasks`（整条先整体校验，任一格式错误整条 `bad-message`）：

| 已有同 `id` 的任务 | 处理 | `results[i]` |
|---|---|---|
| 没有 | 若该项目 `open + claimed` 数已达 `MAX_TASKS_PER_PROJECT`：不建 | `{ id, error: 'limit' }` |
| 没有 | 新建：`state = 'open'`，订阅者 = {本发布方}；给可见的 watch 者发 `task.opened { task }` | `{ id, state: 'open', version: 1, created: true }` |
| `open` / `claimed` | 订阅者加入本发布方 | `{ id, state, version, created: false }` |
| `done`（未过 TTL） | 不变；另给本连接发 `task.done`（形状见 A.7.4） | `{ id, state: 'done', version, created: false }` |
| `failed`（未过 TTL） | 不变（C1） | `{ id, state: 'failed', version, created: false }` |

`limit` 只计 `open` 与 `claimed`；`done`、`failed` 不计（P10）。

#### A.7.2 认领（`task.claim`）

严格按设计 4.2 的顺序，同步一步完成：

1. 任务不存在 → `claim-rejected { reason: 'gone' }`
2. 本节点 `profile === 'browser'` 且 `task.source.userId !== principal.userId` → `claim-rejected { reason: 'forbidden' }`（不带 `state` / `version`）
3. `state !== 'open'` → `claim-rejected { reason: 'taken', state, version }`
4. `expectVersion !== version` → `claim-rejected { reason: 'stale', state: 'open', version }`
5. 成功：`version += 1`；`state = 'claimed'`；`claim = { nodeId, connId, token: version, claimedAt: now, leaseUntil: now + LEASE_MS, progress: { done: null, changedAt: now } }`；回 `task.claimed`；给**其它**可见的 watch 者发 `task.taken { id, version }`

同一节点同时持有的任务数**不设上限**：`maxConcurrent` 只由节点自己守。〔裁〕

#### A.7.3 续约（`task.progress`）

令牌有效时：`leaseUntil = now + LEASE_MS`；若 `done !== claim.progress.done`，则 `claim.progress = { done, changedAt: now }`，否则只保留原来的 `changedAt`；回 `task.renewed`。

#### A.7.4 完成（`task.complete`）

令牌有效时：`version += 1`；`state = 'done'`；`claim = null`；`finishedAt = now`；`result` 原样保存；回 `task.completed`；

- 给**当前每个订阅者**（按 `publisherId` 找它的当前连接，已断开的跳过）发 `task.done { id, resultKey, projectId, projectRev, result }`；
- 给可见的 watch 者发 `task.closed { id, state: 'done' }`。

没有订阅者时不发 `task.done`（F7.2）。

#### A.7.5 放回（`task.release`）

令牌有效时：`version += 1`；`state = 'open'`；`claim = null`；**`attempts` 不变**（C2）；回 `task.released`；给可见的 watch 者发 `task.opened { task }`。

#### A.7.6 失败（`task.fail`）与回收

`task.fail` 令牌有效时，以及 A.8 的每一种回收，都走同一个「放弃」过程：

```
version += 1
attempts += 1
claim = null
若 fail 且 retryable === false，或 attempts >= MAX_ATTEMPTS：    〔裁：retryable:false 直接进 failed〕
    state = 'failed'; finishedAt = now; lastError = error ?? reason
    给每个当前订阅者发 task.failed { id, error: lastError }
    给可见的 watch 者发 task.closed { id, state: 'failed' }
否则：
    state = 'open'
    给可见的 watch 者发 task.opened { task }
```

- `task.fail` 自己回 `task.fail-ack { id, state }`。
- 回收时（A.8），若原认领者的连接还在，给它发 `task.lease-lost { id, token, reason: 'expired' }`；连接已断开就不发。
- **没有订阅者**的任务经「放弃」或「放回」（A.7.5）回到 `open` 时，直接删除（发 `task.closed { id, state: 'removed' }` 代替 `task.opened`）〔裁〕：它不会再有人要，理由同 A.8 第 3 项。这时 `task.fail-ack` 的 `state` 是 `'removed'`。

### A.8 `tick()` 的四项扫描（按此顺序）

所有比较都是**严格大于**：

1. **租约**：`claimed` 且 `now > claim.leaseUntil` → 放弃（`lastError = 'lease-expired'`）
2. **停滞**：`claimed` 且 `now - claim.progress.changedAt > STALL_MS` 且 `claim.progress.done !== null` → 放弃（`lastError = 'stalled'`）。从未报过进度的任务只受租约管（F3.3）
3. **宽限**：
   - 节点断开且 `now - disconnectedAt > RECONNECT_GRACE_MS`：它名下每个 `claimed` 任务放弃（`lastError = 'disconnected'`），然后删掉这个节点记录；
   - 发布方断开且超过宽限：从所有任务的订阅者里移除它；变得没有订阅者的 `open` 任务删除（给可见的 watch 者发 `task.closed { id, state: 'removed' }`），`claimed` 的保留；然后删掉这个发布方记录（C5）
4. **TTL**：`done` / `failed` 且 `now - finishedAt > DONE_TTL` → 删除，不发消息（C1）

### A.9 断开、重连与可见性

- **断开**：`disconnect(connId)` 时，若它是某节点身份的当前连接，记 `node.disconnectedAt = now`；若它是某发布方身份的当前连接，记 `publisher.disconnectedAt = now`。认领和订阅都不动，等 A.8 第 3 项。
- **节点报到 / 重连**：`node.hello` 时：
  - `nodeId` 有记录：清掉 `disconnectedAt`，把这个身份的当前连接换成新连接（旧连接若还连着，此后不再代表这个节点）；没有记录：新建节点记录。
  - `resume` 的处理**不论 `nodeId` 有没有记录都一样**，逐项：任务存在、`state === 'claimed'`、`claim.nodeId === nodeId`、`claim.token === token` → 接续（`claim.connId` 换成新连接；`leaseUntil`、`token` 不变），记进 `resumed`；
  - 否则记进 `lost`，并发 `task.lease-lost { id, token, reason }`：
    - 任务不存在：`reason = 'epoch'`；
    - 任务存在但 `claim.nodeId !== nodeId`：`reason = 'not-owner'`（C4）；
    - 其余（不是 `claimed`、令牌不符）：`reason = 'token'`；
  - 这个节点名下**没出现在 `resume` 里**的 `claimed` 任务：立即放弃（`lastError = 'not-resumed'`）〔裁〕。
- **发布方重连**：`publisher.hello` 的 `publisherId` 有记录：清掉 `disconnectedAt`，换成新连接，订阅全部保留（F7.4）。
- **新 `nodeId` 拿着别人的令牌 `resume`**：该任务 `claim.nodeId` 不是它 → `lost`、`reason = 'not-owner'`（F1.6）。
- **可见性**（A.6 的 `queue.snapshot` 和所有 `task.opened` / `task.taken` / `task.closed`）：
  - 只发给 `queue.watch` 过、且 `projects === 'all'` 或包含 `task.source.projectId` 的节点连接；
  - `profile === 'browser'` 的连接，只收 `task.source.userId === principal.userId` 的任务（Q2）；
  - `pc` / `host` 不按用户过滤（P6）。

### A.10 `describe()`

```js
{
  epoch,
  tasks: [{ id, projectId, state, version, attempts, lastError,
            claim: { nodeId, token, leaseUntil, progress: { done, changedAt } } | null,
            subscribers: [publisherId], finishedAt: number | null }],
  nodes: [{ nodeId, profile, connected: boolean, disconnectedAt: number | null }],
  publishers: [{ publisherId, connected: boolean, disconnectedAt: number | null }],
}
```

`tasks` 按 `id` 升序；`subscribers` 升序。返回深拷贝，调用方改它不影响队列。

### A.10a 定稿后的补充细则（2026-09-24，主 Agent 按实现方与测试方的疑点裁定）

| 事项 | 定为 |
|---|---|
| `lastError` | 每次「放弃」（fail 与 A.8 各种回收）都写；`task.release` 不写。`task.fail` 没带 `error` 时记 `'failed'` |
| `task.progress.done` | 接受数字或 `null`（缺省按 `null`） |
| 被新连接取代的旧连接 | 此后再发节点 / 发布方消息，回 `error { reason: 'not-registered' }`；它的 watch 一并取消 |
| 校验顺序 | 先格式（`bad-message`），后角色（`not-registered`） |
| `reqId` 回显 | 只在主回包里带。附发的 `task.lease-lost`（hello 的 lost）、`task.done`（重复发布已完成的任务）不带。`reqId` 不是字符串也不是有限数时按 `bad-message` |
| 缺省字段 | `input` → `{}`，`requires` → `{}`，`weight` → `null`，`priority` → `0`，`derivedFrom` → `null`。节点侧把 `weight === null` 当 `medium` |
| `plan` 的 `range` | 必须为 `null` 或不给；给了非 null 算 `bad-message`。`nodeId`、`publisherId`、`resultKey`、`projectId` 必须是非空字符串 |
| 发布时的 TTL | 已过 `DONE_TTL` 的 `done` / `failed` 任务，即使还没被 `tick` 删掉，发布时也当作不存在 |
| `connect` 的 `principal` | `userId` 不是字符串就抛 `TypeError`；`tenantId` 不是字符串记 `null` |
| `send` 抛异常 | 吞掉（状态已经改完） |
| 没接续的认领 | 按 A.9 放弃，不给这个节点再发 `lease-lost`（节点自己已经不认它们） |
| 令牌重号（已知限制） | 令牌取认领时的 `version`（设计 4.2）。任务过 TTL 被删、同 `id` 重建后 `version` 从 1 重来，令牌可能与旧的重号。别的节点靠 `nodeId` 核对挡住；同一节点的残留旧 worker 可能拿旧令牌完成新一轮认领，但结果按内容寻址，同 `id` 的产物一样。M1 不改，列入遗留 |
| 本地档缺 `entryKey`（B.4） | 跳过这个 control，不生成任务 |
| 没有 `streamKey` 的流（B.4） | 跳过 |

### A.11 出站消息汇总

所有出站消息都带 `epoch`（C6）。回包带入站的 `reqId`（有的话）。

`node.welcome`、`publisher.welcome`、`queue.snapshot`、`task.published`、`task.unsubscribed`、`task.claimed`、`task.claim-rejected`、`task.renewed`、`task.completed`、`task.released`、`task.fail-ack`、`task.lease-lost`、`task.opened`、`task.taken`、`task.closed`、`task.done`、`task.failed`、`error`。

---

## B. M2：`server/render-node/`

纯函数和一个会话状态机。只可以引 Node 内置模块、`server/render-queue/index.mjs`（常量与 `taskIdOf`）和 `server/snapshot-store.mjs` 的 `snapshotTier`；不读环境变量，不开计时器，不做 I/O，不连网络。

### B.1 `fingerprint.mjs`（设计 2.1）

```js
export function normalizeOs(platform)            // 'win32'|'windows' → 'windows'；'darwin'|'macos' → 'macos'；'linux' → 'linux'；其它 → 'other'
export function gpuClassOf(renderer, vendor)     // WebGL UNMASKED_RENDERER / VENDOR 字符串 → 'nvidia'|'amd'|'intel'|'apple'|'software'
export function chromeMajorOf(version)           // '138.0.7204.49' / 'HeadlessChrome/138.0...' / 138 → 138；解析不出 → 0
export function envFingerprintOf({ os, gpuClass, chromeMajor })   // → 16 位小写十六进制
export function describeEnvironment({ platform, renderer, vendor, chromeVersion })
                                                 // → { os, gpuClass, chromeMajor, fingerprint }
export function resultKeyOf(contentKey, envFingerprint)           // → 64 位小写十六进制
```

- `gpuClassOf` 大小写不敏感，按顺序匹配：
  1. 含 `swiftshader` / `llvmpipe` / `software` / `microsoft basic render` → `software`；
  2. `nvidia` / `geforce` / `quadro` / `rtx` → `nvidia`；
  3. `amd` / `radeon` / `ati ` → `amd`；
  4. `intel` → `intel`；
  5. `apple` → `apple`；
  6. 都不含 → `software`（保守：认不出就当没有硬件加速）。

  `renderer`、`vendor` 两个字符串拼起来一起匹配。
- `envFingerprintOf` = `sha256(\`${os}\n${gpuClass}\n${chromeMajor}\`)` 的前 16 位十六进制。三项任一缺失按 `''` / `0` 计，不抛。
- `resultKeyOf` = `sha256(\`${contentKey}\n${envFingerprint}\`)` 的 64 位十六进制。与现有键同形（64 位十六进制），以后的路由正则不用改。

### B.2 `filter.mjs`（设计 4.3）

```js
export const DEFAULT_WEIGHT_POLICY   // { browser: ['light','medium'], pc: { editing: 'own-or-light', idle: 'all' }, host: 'all' }
export function checkClaimable(task, node)   // → { ok: true } | { ok: false, rule: 0..6, reason: string }
export function filterClaimable(tasks, node) // → task[]（保持原顺序）
```

`task` 是 `TaskView`（A.4）。`node`：

```js
{
  profile: 'pc' | 'host' | 'browser',
  userId?: string,
  envFingerprint: string,
  codeVersions: string[],
  cardSourceVersions?: Record<cardId, string[]>,
  capabilities: { transcode: boolean, userCards: boolean, graphCards: boolean, memoryMB?: number },
  editing?: boolean,              // 只对 pc 有意义
  ownProjectIds?: string[],       // 只对 pc 有意义
  weightPolicy?: object,          // 缺省 DEFAULT_WEIGHT_POLICY
}
```

按规则号顺序检查，第一条不过就返回：

| 规则 | 不过的条件 |
|---|---|
| 0 | `profile === 'browser'` 且 `task.source.userId !== node.userId`（服务端已把关，这里再挡一次） |
| 1 | `task.kind !== 'plan'` 时：`requires.envFingerprint` 存在且 `!== node.envFingerprint`；或 `requires.codeVersion` 存在且不在 `codeVersions` 里；或 `requires.cardSources` 里任一 `[cardId, version]` 不在 `cardSourceVersions[cardId]` 里。`plan` 任务只查 `codeVersion` |
| 2 | `task.kind === 'stream'` 或 `requires.transcode === true`，且 `!capabilities.transcode` |
| 3 | `requires.userCards === true` 且 `!capabilities.userCards`；或 `requires.graphCards === true` 且 `!capabilities.graphCards` |
| 4 | 重度策略（见下）不允许 `weight.class`。缺 `weight` 按 `medium` |
| 5 | `requires.memoryMB` 是数且 `capabilities.memoryMB` 是数，且前者大于后者 |
| 6 | `task.kind === 'plan'` 且 `profile === 'browser'` |

规则 4 的重度策略：

- `browser`：只收 `light`、`medium`；
- `host`：全收；
- `pc`：`editing === true` 时，只收 `task.source.projectId` 在 `ownProjectIds` 里的任务，或 `light` 任务；否则全收。

### B.3 `pick.mjs`（设计 4.3 末段、第 7 节「公平性」）

```js
export function rankCandidates(tasks)                              // 新数组：priority 降序 → source.publishedAt 升序 → id 升序
export function pickCandidate(tasks, { k = 4, random = Math.random, lastProjectId = null } = {})   // → task | null
```

`pickCandidate`：

1. 空数组回 `null`；
2. 取 `rankCandidates` 的前 `k` 个；
3. 若给了 `lastProjectId`，且前 `k` 个里有和第一名**同优先级**、但 `source.projectId !== lastProjectId` 的，候选只留这些（同优先级里按项目轮转）；
4. 在候选里取 `candidates[Math.floor(random() * candidates.length)]`（`random()` 返回 `[0, 1)`）。

### B.4 `split.mjs`（设计第 2 节，Q1）

```js
export function planTaskOf({ projectId, projectRev, priority = 0 })   // → TaskInput（kind 'plan'）
export function splitPlan(args)                                        // → TaskInput[]
```

`planTaskOf` 返回：

```js
{ id: `plan:${projectId}@${projectRev}`, kind: 'plan', resultKey: `${projectId}@${projectRev}`, range: null,
  source: { projectId, projectRev }, input: {}, weight: { class: 'medium', estMs: null, frames: null },
  requires: {}, priority }
```

`splitPlan` 的参数：

```js
{
  planTask,                 // TaskView 或 TaskInput（kind 'plan'）
  entryKey,                 // 这一版项目的 entry.key（本地档内容键要用）
  cardPlan,                 // card-cache.mjs 的 plan() 输出；每个 control 可以额外带 cardId
  prerenderSet,             // Set<clipId> | undefined（undefined = 不过滤）
  streams = [],             // [{ streamKey, topClipId, firstSegment, lastSegment }]，由调用方从 planStreams 取
  envFingerprint,
  codeVersion,
  cardSourceVersions = {},  // Record<cardId, string>：这一版用的卡片源码版本
  anchorFrames = [],        // 全局帧号（src/render/snapshotPick.mjs 的 anchorFrames 输出）
  weightOf = () => ({ class: 'heavy', estMs: null }),   // (control) => weight，调用方按 K1 成本算
  isUserCard = () => false, // (control) => boolean
  isGraphCard = () => false,
  constants = {},           // 覆盖 SNAPSHOT_SPAN / STREAM_SEGMENTS
}
```

**快照任务**，对 `cardPlan` 里每个 control：

- 跳过：没有 `snapshotKey`、没有 `clipId`、`prerenderSet` 给了但不含 `clipId`，或档位 `control.tier ?? snapshotTier(control.capabilities)` 不是 `shared` / `local`；
- 内容键：
  - `shared` → `snapshotKey`；
  - `local` → `${entryKey}/${snapshotKey}`；
- `resultKey = resultKeyOf(内容键, envFingerprint)`；
- 把本地帧 `0 .. control.count-1` 按 `SNAPSHOT_SPAN` 切段，`[from, to]`（最后一段到 `count-1`）；
- 每段一个任务：

```js
{
  id: taskIdOf(...), kind: 'snapshot', tier, resultKey,
  range: { unit: 'localFrame', from, to },
  source: { projectId, projectRev, derivedFrom: planTask.id },   // projectId / projectRev 取自 planTask.source
  input: { clipId, cardId: control.cardId ?? null, entryKey: tier === 'local' ? entryKey : null, contentKey },
  weight: { ...weightOf(control), frames: to - from + 1 },
  requires: {
    envFingerprint, codeVersion,
    cardSources: control.cardId && cardSourceVersions[control.cardId] ? { [control.cardId]: cardSourceVersions[control.cardId] } : {},
    transcode: false,
    userCards: !!isUserCard(control),
    graphCards: !!isGraphCard(control),
    belowDependent: (control.compositing ?? control.capabilities?.compositing) === 'belowDependent',
  },
  priority: 这一段含锚帧 ? 50 : 10,
}
```

  段含锚帧的判法：有 `a ∈ anchorFrames` 满足 `from <= a - control.sampling.firstFrame <= to`。

**轨道流任务**，对 `streams` 里每一项：

- 分段 `firstSegment .. lastSegment` 按 `STREAM_SEGMENTS` 切，`range: { unit: 'segment', from, to }`；
- `resultKey = resultKeyOf(streamKey, envFingerprint)`；
- 任务字段：
  - `input: { clipId: topClipId, cardId: null, entryKey: null, contentKey: streamKey }`；
  - `weight: { ...weightOf({ clipId: topClipId }), frames: (to - from + 1) * 15 }`；
  - `requires: { envFingerprint, codeVersion, cardSources: {}, transcode: true, userCards: false, graphCards: false, belowDependent: false }`；
  - `priority: 10`。

输出顺序：先快照（按 `cardPlan` 顺序、段升序），后轨道流（按 `streams` 顺序、段升序）。同一个 `id` 只出现一次（先出现的留下）。

### B.5 `session.mjs`（任务书 M2「节点会话状态机」）

```js
export function createNodeSession(options)   // → NodeSession
```

| 参数 | 说明 |
|---|---|
| `nodeId` | 节点身份 |
| `node` | 同 B.2 的 `node` 描述（含 `profile`、`envFingerprint` 等） |
| `send` | `(message) => void`，发给队列 |
| `now` | `() => number` |
| `random` | 缺省 `Math.random` |
| `isIdle` | `() => boolean`，缺省 `() => true` |
| `maxConcurrent` | 缺省 1 |
| `constants` | 覆盖 `QUEUE_DEFAULTS` 的部分键（用 `RENEW_INTERVAL_MS`、`PICK_K`） |
| `projects` | `queue.watch` 的范围，缺省 `'all'` |
| `onTask` | `(task, { token }) => void`：认领成功时调用，调用方开始干活 |
| `onLost` | `(id, reason) => void`：认领丢了（`lease-lost`），调用方停手丢弃 |

| 方法 | 说明 |
|---|---|
| `start(resume = [])` | 发 `node.hello`（带 `nodeId`、`profile`、`envFingerprint`、`capabilities`、`codeVersions`、`maxConcurrent`、`resume`），紧接着发 `queue.watch { projects }` |
| `receive(message)` | 处理队列发来的消息 |
| `tick()` | 按下文规则续约和认领 |
| `progress(id, done)` | 记下进度，立即发 `task.progress`（持有令牌时） |
| `complete(id, result)` | 发 `task.complete`，本地移除持有 |
| `fail(id, error, retryable = true)` | 发 `task.fail`，本地移除持有 |
| `yieldAll(reason = 'busy')` | 对每个持有的任务发 `task.release`，本地清空持有 |
| `held()` | `[{ id, token, lastSentAt }]` |
| `known()` | 本地看到的 `open` 任务（`TaskView[]`，按 id 升序） |

规则：

- **本地视图**：
  - `queue.snapshot` 整体替换；
  - `task.opened` 加入或更新；
  - `task.taken` / `task.closed` 移除；
  - `task.claim-rejected`：
    - `stale` 时把该任务的 `version` 改成回包的 `version`，下次 `tick` 可以再认领；
    - `taken` / `gone` / `forbidden` 时移除。
- **认领**（`tick` 里）：
  - 条件：`isIdle()`、持有数 + 在飞的认领数 `< maxConcurrent`、没有在飞的认领；
  - 做法：在 `filterClaimable(known(), node)` 上用 `pickCandidate`（`k = PICK_K`、`random`、`lastProjectId` = 上一次认领成功的项目）挑一个，发 `task.claim { id, expectVersion: task.version }`，记为在飞；
  - 一次 `tick` 至多发一条认领。
- **认领结果**：
  - `task.claimed`：加入持有（`lastSentAt = now`），清在飞，调 `onTask`；
  - `task.claim-rejected`：清在飞。
- **续约**（`tick` 里）：对每个持有的任务，若 `now - lastSentAt >= RENEW_INTERVAL_MS`，发 `task.progress { id, token, done: 最近一次 progress() 记下的值，没有就 null }`，并 `lastSentAt = now`。`progress()` 发出时同样刷新 `lastSentAt`。
- **丢认领**：`task.lease-lost` → 移除持有，调 `onLost(id, reason)`；
- **重连**：`node.welcome` 的 `lost` 里的 id → 同样移除持有、调 `onLost`。
- **不空闲时**：`tick` 不认领新任务，但照常续约。让路由调用方调 `yieldAll`。

---

## C. 测试文件（Verification/Test）

| 文件 | 内容 |
|---|---|
| `server/test/fake-render-queue-env.mjs` | 假时钟（`now()`、`advance(ms)`、`set(t)`）、消息收集器（按 `connId` 分桶、按 `type` 过滤、`clear()`）、造任务输入的助手（给 `projectId`、`projectRev`、`kind`、`range` 生成合法的 `TaskInput`） |
| `server/test/render-queue-fault.test.mjs` | 任务书 5.2 的 F1.1～F9.3，共 35 条 |
| `server/test/render-queue-protocol.test.mjs` | P1～P14 |
| `server/test/render-queue-state.test.mjs` | S-1～S-4（S-4 固定种子，至少 2000 步） |
| `server/test/render-node-logic.test.mjs` | B.1～B.4 |
| `server/test/render-node-session.test.mjs` | B.5，以及一条「会话 × 真队列」的联调：两个会话对同一个 `createRenderQueue` 抢 20 个任务，每个任务恰好完成一次 |

测试名以用例编号开头（如 `F2.2 处理超时：…`、`P4 …`），便于对账。测试只经 A.3 / B 节列出的接口调用，不碰内部字段（`describe()` 是公开接口，可以用）。
