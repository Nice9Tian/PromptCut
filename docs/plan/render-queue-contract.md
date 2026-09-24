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

条件不满足（P 不存在、不是 `plan`、不在 `claimed`、认领者不是本节点）时不继承，按上一段取 `principal`，不报错。之后 P 的订阅者变化不再传给已建的细任务。

**已存在的同 `id` 任务**（2026-09-24 M3 裁定）：共享档的结果键与项目无关，一版项目切出的细任务常常已经存在（上一版、别的项目建的）。满足上面的继承条件时，对已存在的任务同样把 P 此刻的订阅者并进它的订阅者（`userId` / `tenantId` 不改），并且：已是 `done`（未过 TTL）的，给**新并入的**每个订阅者各发一条 `task.done`；已是 `failed`（未过 TTL）的，给新并入的每个订阅者各发一条 `task.failed`。已经是订阅者的不重复发。不满足继承条件时照 A.7.1 只加本发布方。

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
| 没接续的认领 | 按 A.9 放弃，不给这个节点再发 `lease-lost`（节点自己已经不认它们）。`resume` 里列了自己名下的任务、但令牌不对的，同样算没接续：记进 `lost`（reason `token`）并放弃 |
| resume 回绝对纯浏览器的信息量 | 纯浏览器节点拿别人的任务 id resume 或做令牌操作，回 `lease-lost`（`not-owner` / `token` / `epoch`）。只回显它自己给的 id，不带任务内容或归属，接受 |
| 令牌重号（已知限制） | 令牌取认领时的 `version`（设计 4.2）。任务过 TTL 被删、同 `id` 重建后 `version` 从 1 重来，令牌可能与旧的重号。别的节点靠 `nodeId` 核对挡住；同一节点的残留旧 worker 可能拿旧令牌完成新一轮认领，但结果按内容寻址，同 `id` 的产物一样。M1 不改，列入遗留 |
| 继承并入已存在的 `done` / `failed` 任务（A.4 末段） | 只并入 plan 的订阅者，切分节点这个发布方不加入（A.7.1：已完成的任务重复发布不改变它）；切分节点照 A.7.1 在自己连接上收到每个已完成任务的一条 `task.done` |
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
- **补充细则**（2026-09-24 主 Agent 按双方疑点裁定）：
  - `node.welcome` 里 `resumed` 的任务：把它的 `lastSentAt` 置为 `now - RENEW_INTERVAL_MS`，下一次 `tick` 立即续约（断线宽限加续约间隔，最坏会顶到租约边界）。其它回包（`task.renewed`、`task.completed`、`task.released`、`task.fail-ack`）不改持有。
  - `welcome.lost` 与随后同 id 的 `task.lease-lost` 是同一件事，`onLost` 只调一次；`welcome.lost` 传的 reason 是 `'lost'`。
  - `task.lease-lost` 的 `token` 与本地持有的不符（旧认领的迟到消息）时忽略。
  - `start(resume)`：清掉在飞的认领和本地视图；`resume` 里的项放进持有；本地持有但不在 `resume` 里的，调 `onLost(id, 'not-resumed')`。
  - `yieldAll` 时有认领在飞：回包若是 `task.claimed`，立即 `task.release`，不调 `onTask`。
  - 收到 `error` 时清掉在飞的认领（`task.claim` 不带 `reqId`，对不上是哪一条，按兜底处理）。
  - `task.claimed` 后，这个任务从本地视图（`known()`）移除。
  - 流任务的分段从 `firstSegment` 起切，不对齐到 `STREAM_SEGMENTS` 的倍数。
  - `gpuClassOf` 用一个空格把 `renderer`、`vendor` 拼起来匹配；规则 1 的「存在」指值不为 `null` / `undefined`。

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

---

## D. M3：进程内集成（本机节点编排 × 队列，环回传输与假产物库）

主 Agent 定稿，2026-09-24。

**范围**：在单个 Node 进程里，把 M1 的队列和 M2 的节点逻辑串成端到端链路：

- 页面发布 `plan` 任务；
- 节点认领、算计划、切分并发布细任务；
- 各节点认领细任务、执行、把产物推到产物库、报完成；
- 页面收到全部 `task.done`。

**隔离**：

- 环回传输和假产物库、假执行器**只放在 `server/test/`**，文件头写明「仅供测试与进程内集成，生产代码不得引用」；
- 生产目录里只新增一个编排模块 `server/render-node/local-node.mjs`：它只认注入进来的接口，不引 WebSocket、不碰文件系统、不认识任何真实存储。

**与任务书 M3 行的差异**：任务书原写「`frame-pipeline.mjs` 里节点接入的那一段（新方法，开关后面）」。本阶段不改 `frame-pipeline.mjs`，接真的预渲染执行器移到 M5（与素材服务一起）。理由：接真管线要么在单测里起 Chrome，要么让假件留在生产路径的开关后面，两者都违反隔离要求。所以本阶段不动任何既有业务代码，现有探针的行为不变。

### D.1 注入接口（在 `local-node.mjs` 里用 JSDoc 写明，不提供实现）

**执行器 `executor`**：

```js
executor.plan(planTask, { signal }) → Promise<PlanContext>
// PlanContext = { entryKey, cardPlan, prerenderSet?, streams?, anchorFrames?, cardSourceVersions?,
//                 weightOf?, isUserCard?, isGraphCard? }   —— 原样喂给 splitPlan（B.4）
executor.render(task, { signal, progress }) → Promise<artifacts>
// task 是 TaskView；progress(done: number) 报进度；artifacts 不透明，原样交给 sink.put
// 抛出的错误若带 retryable === false，按不可重试处理；否则可重试
```

**产物库 `sink`**（M5 起由素材服务实现，设计 4.4、语义 `asset-storage.md`「先推送、确认收全，再报完成」）：

```js
// 一「段」的身份是 (resultKey, range.from, range.to)；kind、tier 只作记账，不参与身份
sink.has({ resultKey, kind, tier, range }) → Promise<boolean>          // 这一段是否已经收全
sink.put({ resultKey, kind, tier, range, artifacts, meta }) → Promise<{ complete: boolean }>
// meta = { taskId, nodeId, token }，供记账（设计第 7 节「节点信任」）
```

### D.2 `server/render-node/local-node.mjs`

```js
export function createLocalNode(options) → LocalNode
```

| 参数 | 说明 |
|---|---|
| `nodeId` | 节点身份 |
| `publisherId` | 缺省等于 `nodeId`。切分出的细任务以它发布（契约 A.5：同一连接先 `publisher.hello`） |
| `node` | B.2 的节点描述（`profile`、`envFingerprint`、`codeVersions`、`capabilities`…） |
| `endpoint` | `{ send(message), onMessage(handler) }`：到队列的一条连接（进程内是环回端点，M5 起是 WebSocket 适配层） |
| `now`、`random`、`isIdle`、`maxConcurrent`、`constants`、`projects` | 原样传给 `createNodeSession`（B.5） |
| `codeVersion` | 切分细任务时写进 `requires.codeVersion` |
| `executor`、`sink` | D.1 |
| `onEvent` | `(event) => void`，诊断用，缺省空函数 |

| 方法 | 说明 |
|---|---|
| `start(resume = [])` | 先挂 `endpoint.onMessage`，再发 `publisher.hello { publisherId }`，再调 `session.start(resume')`。`resume'` 只保留本实例在跑表里、且令牌相同的项（新进程的实例在跑表是空的，等于不接续；接续只用于同一实例的重连）〔裁〕 |
| `tick()` | 调 `session.tick()` |
| `yieldAll(reason = 'busy')` | 中止所有在跑的任务（`AbortController`），调 `session.yieldAll(reason)` |
| `stop()` | 中止所有在跑的任务；不再处理收到的消息 |
| `running()` | 在跑的任务 id 数组（升序） |
| `settled()` | `Promise<void>`：等到此刻所有在跑的任务都落定 |
| `session` | 底层 `createNodeSession` 的实例（只读，测试可以看 `held()` / `known()`） |

**收到的消息**：全部交给 `session.receive`。`publisher.welcome`、`task.published`、`task.done`、`task.failed` 等会话不认的类型，会话本就忽略。另外按 `onEvent({ type: 'publish-result', results })` 报出 `task.published` 的结果。

**认领到任务**（会话的 `onTask(task, { token })`）：新建 `AbortController`，异步执行下面的流程，记进在跑表。**开工时先同步调一次 `session.progress(id, 0)`**〔裁〕：让队列的停滞规则（A.8 第 2 项，`done !== null` 才生效）覆盖到「执行器卡死、从不报进度、但节点还在 tick 续约」的情形——否则会话每拍用 `done: null` 续约，卡死的任务永远不会被回收。「仍持有」的判定是 `session.held()` 里有 `{ id, token }` 且 token 相同，每一步落定后都要重新判一次。不再持有或已中止时，丢弃结果，`onEvent({ type: 'discarded', id })`，不发任何消息。

- **`plan` 任务**：
  1. `ctx = await executor.plan(task, { signal })`；
  2. `tasks = splitPlan({ ...ctx, planTask: task, envFingerprint: node.envFingerprint, codeVersion, constants })`（`ctx` 放在前面：切分节点自己的指纹、plan 与代码版本一定生效，设计 2.1）；
  3. 仍持有时，若 `tasks.length > 0`，先 `endpoint.send({ type: 'task.publish', tasks })`；
  4. 再 `session.complete(task.id, { ranges: null, derived: tasks.map(t => t.id) })`；
  5. `onEvent({ type: 'plan-split', id, derived: [...] })`。

  **发布必须在完成之前发出**：派生任务的继承（A.4 末段）要求发布时 `plan` 仍由本节点认领。同一连接上的消息按序处理，所以先发的 `publish` 一定先于 `complete` 生效。
- **细任务**（`snapshot` / `stream`）：
  1. `await sink.has(...)` 为真：仍持有时直接 `session.complete(id, { ranges: [[from, to]], dedup: true })`，`onEvent({ type: 'dedup', id })`；
  2. 否则 `artifacts = await executor.render(task, { signal, progress })`。`progress(done)` 仅在仍持有时调 `session.progress(id, done)`；
  3. `r = await sink.put({ ..., artifacts, meta: { taskId: id, nodeId, token } })`；
  4. `r.complete !== true`：仍持有时 `session.fail(id, 'sink-incomplete', true)`；
  5. 否则仍持有时 `session.complete(id, { ranges: [[from, to]] })`，`onEvent({ type: 'completed', id })`。
- **执行或推送出错**：仍持有时 `session.fail(id, String(error?.message ?? error), error?.retryable !== false)`，`onEvent({ type: 'failed', id })`。
- **丢认领**（会话的 `onLost(id, reason)`）：中止对应任务，`onEvent({ type: 'lost', id, reason })`。已经推到产物库的产物不回收（按内容寻址，下一个认领者查 `has` 会直接完成）。

模块只引 `./session.mjs`、`./split.mjs`（或 `./index.mjs`），不引网络、文件系统和环境变量。

### D.3 测试用的假件（Verification 独占，都在 `server/test/`）

每个文件头第一段写明：**仅供测试与进程内集成，生产代码不得引用**。

**`fake-loopback-transport.mjs`**：

```js
export function createLoopback({ serialize = true } = {}) → {
  queueSend(connId, message),          // 作为 createRenderQueue 的 send 传入
  attach(queue),
  connect(connId, principal) → Endpoint,   // 调 queue.connect，返回端点
  flush(max = 100000) → number,        // 按入队顺序投递所有待投消息（含投递中新产生的），超过 max 条抛错（防活锁）
  pending() → number,
  partition(connId), heal(connId),     // 分区期间这条连接双向的消息都丢弃
  log() → [{ dir: 'in' | 'out', connId, message }],   // 已投递的记录
  errors() → Error[],                  // 端点处理器抛出的异常（测试断言为空）
}
Endpoint = { connId, send(message), onMessage(handler), close(), closed }
// close()：调 queue.disconnect(connId)，并丢弃还没投给它的消息
```

- 两个方向的消息进同一个先进先出队列：`in` 投给 `queue.handle`，`out` 投给端点的处理器；
- `serialize` 时入队前做一次 JSON 往返；
- 从不直接同步回调，全部经 `flush` 投递，保证顺序确定、不重入。

**`fake-artifact-sink.mjs`**：内存产物库，实现 D.1 的 `sink`。另提供：

- `entries()`；
- `seed({ resultKey, range })`（预置已收全）；
- `failNextPut(n)`（接下来 n 次 `put` 回 `{ complete: false }`）；
- `putCount(resultKey)`。

**`fake-render-executor.mjs`**：可编排的执行器。按任务 id 或规则设定：

- 耗时（按注入时钟推进）；
- 进度步长；
- 失败（可重试 / 不可重试）；
- 卡死（永不返回也不报进度）。

`plan()` 返回测试给定的 `PlanContext`。所有等待都按注入时钟推进，不用真实计时器。

### D.4 集成测试 `server/test/render-queue-inproc.test.mjs`

一个队列、一条环回、若干 `createLocalNode`、一个页面发布方（直接用环回端点发 `publisher.hello` 和 `task.publish`），假时钟驱动。驱动循环：

1. `flush`；
2. 让出微任务，让假执行器和假产物库的 Promise 落定；
3. 各节点 `tick`；
4. `queue.tick`；
5. 没有待投消息、条件还不满足时，推进时钟。

| 编号 | 场景 | 断言要点 |
|---|---|---|
| I1 | 全链路：页面发布 `plan`，两个 `pc` 节点；plan 切出若干快照与流任务 | 恰有一个节点认领并切分 `plan`；每个细任务恰好完成一次；产物库里每个结果键的每一段都在；页面收到 `plan` 与全部细任务的 `task.done`（继承订阅）；细任务的 `source.userId` 是页面的用户；`describe()` 全部 `done` |
| I2 | 产物库已有部分结果 | 这些任务不调 `executor.render`，直接完成（`dedup`）；其余照常 |
| I3 | 执行中节点断开（`partition` 后 `close`） | 宽限期后另一节点接手并完成；每个任务恰好完成一次；断开节点的迟到结果被丢弃（不会让任务完成第二次） |
| I4 | 执行失败：可重试一次后成功；不可重试 | 前者最终 `done`、`attempts` 1；后者 `failed`，页面收到 `task.failed` |
| I5 | 纯浏览器节点 + `pc` 节点，另有别的用户的项目 | 浏览器节点不认领 `plan`、不认领流任务、不认领别的用户的任务；它完成的都是本人的 `light` / `medium` 快照任务 |
| I6 | 两种环境指纹的 `pc` 节点 | 细任务只被与 `plan` 认领者同指纹的节点认领 |
| I7 | 执行中节点转为不空闲并 `yieldAll` | 任务放回（`attempts` 不加）、被另一节点完成；让路节点的执行被中止、结果丢弃 |
| I8 | 执行器卡死（不报进度），卡死节点照常 tick | 开工时的 `progress(0)` 之后进度不再变化，`STALL_MS` 后被停滞规则回收（`lastError` 为 `stalled`），另一节点完成；卡死节点收到 `lease-lost`，之后即使返回也被丢弃 |
| I9 | 产物库推送没收全（`failNextPut`） | 任务报失败后被重试完成；最终每段恰好完成一次 |
| I10 | 队列重启（新实例、新 epoch） | 页面重新发布后全部完成；已在产物库里的段走 `dedup`，不重复渲染 |

所有用例：

- 端点处理器没有抛出异常（`errors()` 为空）；
- 环回里投递过的每条消息都能 JSON 往返；
- 测试名以编号开头。

## E. M4：环境指纹进结果键（本机预渲染进程）

主 Agent 定稿，2026-09-24。依据：设计 `distributed-prerender-queue.md` 2.1、`rendering.md`「不同环境的结果不混用」、`TODO.md`「语义与代码的差距」的「渲染任务队列与渲染节点」一条。

**范围**：本机预渲染进程写盘、投递的全部预渲染键都乘上环境指纹，现有缓存整体换键一次。

- 快照共享键 `snapshotKey`（共享档目录名；本地档目录的第二层也是它）；
- 本地档键 `<entry.key>/<snapshotKey>`（随 `snapshotKey` 一起换，`entry.key` 本身不变）；
- 独立卡 PNG 缓存键 `control.key`（`controls/<key>/`，产自同一个 Chrome，同样按环境隔离）；
- 轨道流键 `streamKey`（`streams/<streamKey>/`）。

**不变**：

- `card-identity.mjs` 的四个函数（内容身份仍然只认内容）；
- `entry.key`（`frameIdentity`，就绪索引的会话版本）；
- `costKey`（K1 成本键，设备口径另有 `device` 字段）；
- 就绪索引的线格式（`wireSnapshotKey`）、快照与流的路由正则（结果键仍是 64 位十六进制）；
- 导出路径与导出像素（指纹只改键，不改画面）。

旧键目录不删除（用户数据只读不写），换键后成为不再被引用的孤儿目录。

### E.1 指纹从哪里来：`server/bakery/environment.mjs`（新建）

```js
export async function probeBrowserEnvironment({ browser, page }, { platform = process.platform, timeoutMs = 5000 } = {})
// → { os, gpuClass, chromeMajor, fingerprint, renderer, vendor, chromeVersion, detected }
```

- `chromeVersion = await browser.version()`（例如 `HeadlessChrome/138.0.7204.49`）；
- `renderer` / `vendor`：在 `page` 里 `evaluate` 一段自包含的函数：新建一个不挂进文档的 `<canvas>`，依次试 `webgl2`、`webgl`；有 `WEBGL_debug_renderer_info` 就读 `UNMASKED_RENDERER_WEBGL` / `UNMASKED_VENDOR_WEBGL`，否则读 `gl.RENDERER` / `gl.VENDOR`；读完用 `WEBGL_lose_context` 释放上下文；拿不到上下文返回两个空串；
- 结果交给 `render-node/fingerprint.mjs` 的 `describeEnvironment({ platform, renderer, vendor, chromeVersion })`；
- **从不抛出**：任何一步失败或超过 `timeoutMs`，缺的那项按空值计，`detected: false`；两步都成功才是 `detected: true`（拿不到 WebGL 上下文、返回两个空串，也算成功）；
- 预渲染用的 Chrome 带 `--disable-gpu` 加 `--enable-unsafe-swiftshader`，WebGL 走 SwiftShader，所以本机预渲染进程的 `gpuClass` 预期是 `software`。这就是它真实的栅格化环境，不做特判。

### E.2 `FramePipeline`（`server/frame-pipeline.mjs`）

- 构造参数新增 `environment`（`describeEnvironment` 的形状，至少有 `fingerprint`）。给了就不探测，直接用（测试和以后的独立渲染主机用）。
- `this.environment`：没定下来之前是 `null`。getter `envFingerprint` 返回 `this.environment?.fingerprint ?? null`。
- `async ensureEnvironment(bakery)`：
  - 已有 `this.environment` 就直接返回；
  - 并发调用只探测一次（single-flight）；
  - 结果**整个进程只定一次**，`detected: false` 的结果也照样定下来，免得同一进程中途换键；
  - 探测只在真的 bakery 上做：`bakery?.browser` 和 `bakery?.page` 缺一个就不探测，返回 `this.environment`。
- 调用点：`bakery()` 里 `openBakery` 之后、`loadProject` 之前；`leaseStreamBakery()` 里 `openBakery` 之后。都用 `await`。这两处是本进程仅有的两个 `openBakery` 调用点。
- `entry.cardCache = new CardFrameCache({ ..., envFingerprint: () => this.envFingerprint })`。
- `diagnostics()` 新增 `environment: this.environment`。
- `planDiagnostics()` 的每个 control 新增 `contentKey`、`envFingerprint`。

### E.3 `CardFrameCache.plan()`（`server/card-cache.mjs`）

- 构造参数新增 `envFingerprint`：字符串，或返回字符串的函数。`plan()` 开头解析一次；解析结果不是非空字符串就抛 `Error`（消息里带「环境指纹」四个字），不产任何键。现有调用点都已包在 `try` 里。
- 每个 control：
  - `cacheContentKey = cardCacheIdentity(...)`（与今天的 `key` 相同的算法和输入）；
  - `key = resultKeyOf(cacheContentKey, fp)`；
  - `contentKey = cardSnapshotIdentity(...)`（与今天的 `snapshotKey` 相同的算法和输入）；
  - `snapshotKey = resultKeyOf(contentKey, fp)`；
  - 输出新增字段 `contentKey`、`cacheContentKey`、`envFingerprint: fp`，其余字段不变（`costKey` 不乘指纹）。
- `resultKeyOf` 从 `server/render-node/fingerprint.mjs` 引入，不另写一份。
- `renderState` / `put` / `hasComplete` / `finish` 照旧只认 `control.key`。

### E.4 轨道流（`server/frame-stream.mjs`）

- `planStreams(entry, { ..., envFingerprint })`：`envFingerprint` 不是非空字符串就返回 `[]`，不产流。
- 每个 spec：
  - 单卡流：`contentKey = cardStreamIdentity({ kind: 'card', ..., members: [{ key: control.contentKey ?? control.snapshotKey ?? control.key, ... }] })`；
  - 组流：`contentKey = cardStreamIdentity({ kind: 'group', ..., members: [{ key: control.cacheContentKey ?? control.key, ... }] })`；
  - `streamKey = resultKeyOf(contentKey, envFingerprint)`；spec 新增 `contentKey`、`envFingerprint`。
  - 成员键优先取内容键，因此同一个项目在两种环境下的 `contentKey` 相同，`streamKey` 不同。`??` 后面的回退只为没有内容键字段的旧形状输入。
- `StreamProducer.update` 传 `envFingerprint: this.pipeline.envFingerprint`。
- `status().streams[]` 每项新增 `contentKey`。
- `STREAM_CODE_VERSION` 不变。

### E.5 细任务切分（`server/render-node/split.mjs`，改 B.4）

- 快照内容键改为：
  - `shared` → `control.contentKey ?? control.snapshotKey`；
  - `local` → `${entryKey}/${control.contentKey ?? control.snapshotKey}`；
- 流内容键改为 `stream.contentKey ?? stream.streamKey`；
- 其余照 B.4。
- 由此成立的不变式（`splitPlan` 的 `envFingerprint` 与 plan 的指纹相同时）：
  - 共享档快照任务的 `resultKey === control.snapshotKey`；
  - 流任务的 `resultKey === spec.streamKey`；
  - 本地档任务的 `resultKey = resultKeyOf(<entryKey>/<contentKey>, fp)`，`input.contentKey` 就是这个拼接串，和 B.4 一样。
- 没有 `contentKey` 字段的输入（M2 夹具的形状）照旧把 `snapshotKey` / `streamKey` 当内容键。

### E.6 页面测量帧入库（`server/vite-plugin-frames.ts` 的 `PUT /api/frames/snapshot`）

页面把测量时推过的帧交给预渲染进程存成共享快照（K1 末句）。这些帧产自用户的浏览器，和预渲染进程不是同一种环境。按「不同环境的结果不混用」：

- 在 `NOT_INDEPENDENT` 判断之后、写盘之前加一道闸：请求体的 `envFingerprint` 必须是字符串，且等于 `control.envFingerprint`；
- 不等（含没带）就回 `200 { ok: true, stored: false, reason: 'ENV_MISMATCH' }`，不写盘、不发层。
- 页面（`src/editor/probeRunner.ts`）本阶段不改，它现在不带这个字段，所以测量帧不再入库，这些帧由预渲染进程自己补渲。页面只在意 404，回 200 不影响它。

### E.7 测试（Verification，`server/test/`）

新建 `server/test/env-fingerprint-keys.test.mjs`，测试名以编号开头：

| 编号 | 内容 |
|---|---|
| F1 | 真实串的指纹提取：SwiftShader 的 ANGLE 串 → `software`；NVIDIA、AMD、Intel 的 ANGLE / D3D11 串 → 对应类别；`Apple M2` → `apple`；`HeadlessChrome/138.0.7204.49` 与完整 UA → 138；三项任一不同，指纹不同；同输入指纹稳定、16 位十六进制 |
| F2 | **同一张卡、两种环境**：同一份 browserPlan 喂给两个只差 `envFingerprint` 的 `CardFrameCache`：`contentKey` / `cacheContentKey` 相同；`snapshotKey`、`key` 必然不同；且 `snapshotKey === resultKeyOf(contentKey, fp)`、`key === resultKeyOf(cacheContentKey, fp)`；同一指纹算两次完全相同；64 位十六进制（路由正则仍匹配） |
| F3 | 没有指纹（`undefined`、`''`、函数返回 `null`）时 `plan()` 抛出，错误消息含「环境指纹」 |
| F4 | 流：同一个 entry 在两种指纹下，`planStreams` 的 `contentKey` 相同、`streamKey` 不同且等于 `resultKeyOf(contentKey, fp)`；单卡流和组流都覆盖；没有指纹返回 `[]` |
| F5 | 落盘隔离：两种环境的共享档、本地档、PNG 缓存、流目录路径两两不同（`snapshotDir` 与 `path.join(root, 'controls', key)`、`streams/<streamKey>`），一种环境写入的快照另一种环境读不到 |
| F6 | `splitPlan` 喂真实 `plan()` 输出：共享档任务 `resultKey === control.snapshotKey`，流任务 `resultKey === spec.streamKey`，本地档按 E.5；两种指纹切出的任务 id 集合不相交 |
| F7 | `probeBrowserEnvironment` 用假 browser / page：正常路径；没有 WebGL（空串 → `software`，`detected` 仍为 true）；`version()` 抛出或 `evaluate` 抛出或超时 → 不抛、`detected: false`；`evaluate` 收到的是一个函数 |
| F8 | `FramePipeline`：构造时注入 `environment` 就不探测、`cardCache.plan` 用它；`ensureEnvironment` 并发调用只探测一次、结果终身不变（包括 `detected: false`）；bakery 缺 `browser` 或 `page` 时不探测；`diagnostics().environment` 可见 |

另外：

- 因本契约失效的既有测试（不带指纹构造 `CardFrameCache` 后调 `plan()`、不带指纹调 `planStreams` 的），按本契约补上指纹。只补输入，不放宽断言。
- 探针：`scripts/probes/ready-index-probe.mjs` 与 `scripts/probes/stream-produce-probe.mjs` 各加一项检查：
  - `diagnostics.environment.fingerprint` 是 16 位十六进制；
  - `plans[].controls[]` 有 `snapshotKey` 的，`snapshotKey === resultKeyOf(contentKey, envFingerprint)`；
  - 流探针另查 `streams.streams[]` 的 `streamKey === resultKeyOf(contentKey, environment.fingerprint)`。
  - 探针本身照旧从空库起跑，所以「旧缓存失效后重新生成新键产物」由探针原有的「产出、就绪、取得到」断言覆盖。

### E.8 文件归属

| 角色 | 文件 |
|---|---|
| Pipeline/Node | 新建 `server/bakery/environment.mjs`；改 `server/card-cache.mjs`、`server/frame-stream.mjs`、`server/frame-pipeline.mjs`、`server/render-node/split.mjs`、`server/vite-plugin-frames.ts`。不改 `server/card-identity.mjs` |
| Verification/Test | 新建 `server/test/env-fingerprint-keys.test.mjs`；改受影响的既有 `server/test/*.test.mjs`、`scripts/probes/ready-index-probe.mjs`、`scripts/probes/stream-produce-probe.mjs` |
| 主 Agent | 本节；设计 2.1「对现有代码的影响」、`TODO.md`、任务书、报告 `docs/reports/REPORT-render-queue-m4.md` |

### E.9 定稿后的补充细则（2026-09-24，主 Agent 按实现方与测试方的疑点裁定）

- **E.1 超时**：`timeoutMs` 按步算。两步（`browser.version()` 与页面探测）并行，各自限时，所以整次探测最多约 `timeoutMs`。
- **E.1 空值**：缺项一律按空串计。`version()` 返回空串算这一步失败（`detected: false`）。
- **E.3 解析顺序**：指纹在 `plan()` 开头、读 browserPlan 之前解析。没有指纹时，空的或非法的 browserPlan 也抛出，不先回 `[]`。
- **E.4 回退**：单卡流成员键的回退写成 `contentKey ?? (snapshotKey || key)`，与旧代码的 `snapshotKey || key` 一致。
- **E.5 流任务**：流任务的 `input.contentKey` 是流的内容键（`spec.contentKey`），不是结果键 `streamKey`。
- **E.5 本地档**：本地档任务的 `resultKey` 是队列里的任务身份，不等于落盘目录键 `<entryKey>/<snapshotKey>`，这是有意的。
  - 共享档和流的任务身份与落盘键重合，因为它们没有 `entryKey` 这一层。
  - M5 的产物库接口按 `input.entryKey` 与去掉 `<entryKey>/` 前缀的内容键，用同一个指纹重算落盘键。
- **E.6 实际效果**：页面用 GPU 栅格化，本机预渲染用 SwiftShader，两边指纹几乎不可能相同，所以这道闸实际上停掉了测量帧入库。（已被 F 节取代：页面上报自己的环境，测量帧按卡片级指纹锁入库。）

## F. 卡片级指纹锁（M4 补充：前端测量帧入库与队列认领）

主 Agent 定稿，2026-09-24，按用户的「卡片级一致性锁定」决策。依据：`rendering.md`「不同环境的结果不混用」与「预渲染结果的复用」、设计 2.1「谁定指纹」。本节取代 E.6 的测量帧闸，其余 E 节不变。

**概念**：

- **锁键** `lockKey = <kind>:<contentKey>`。`kind` 是 `snapshot` 或 `stream`。`contentKey` 就是细任务的 `input.contentKey`：
  - 共享档快照是卡的内容键；
  - 本地档是 `<entryKey>/<内容键>`；
  - 流是流的内容键。
- **锁** `{ envFingerprint, source, since, touchedAt }`。同一把锁下只有一个环境的结果被产出、投递。
- **得锁**：没锁时，第一个产出者得锁；同指纹再来只刷新 `touchedAt`；不同指纹被拒，除非**接手**（takeover）。
- **接手**：用自己的指纹另起一套键、锁转给自己，原指纹的未完成工作作废。

### F.1 队列（`server/render-queue/`，Protocol/State）

**入站任务**：`TaskInput` 新增可选字段 `takeover?: boolean`。

- 不是布尔就整条 `bad-message`；
- 不存进任务，`TaskView` 不变。

**锁键**：`lockKeyOf(task)`，从 `index.mjs` 转出。

- `kind` 是 `snapshot` / `stream`，且 `input.contentKey` 是非空字符串时，返回 `` `${kind}:${input.contentKey}` ``；
- 其余返回 `null`。
- 任务的**锁指纹**是 `requires.envFingerprint`（非空字符串）。没有锁键或锁指纹的任务不参与锁。

**状态**：新增 `locks: Map<lockKey, { envFingerprint, source: 'claim' | 'lock' | 'takeover', since, touchedAt }>`。只在内存里，队列重启（新 `epoch`）后清空，和任务表一样。

**新入站消息 `card.lock`**：只有发布连接能发，加进 `PUBLISHER_TYPES`。文档服务按这个集合路由，不用改文档服务。

- 字段：`kind: 'snapshot' | 'stream'`、`contentKey: 非空字符串`、`envFingerprint: 非空字符串`、`takeover?: boolean`；格式错误整条 `bad-message`。
- 处理：
  - 没锁：建锁（`source: 'lock'`）；
  - 同指纹：刷新 `touchedAt`；
  - 不同指纹且 `takeover === true`：按下面的「接手」处理；
  - 不同指纹且没带 `takeover`：不变。
- 回包 `card.locked { lockKey, envFingerprint: <处理后锁上的指纹>, granted: boolean }`。

**认领（改 A.7.2）**：在第 3 步（`taken`）与第 4 步（`stale`）之间插入：

- 3a. 任务有锁键 L 和锁指纹 F，且 `locks` 里 L 的指纹 X 存在、`X !== F` → `claim-rejected { reason: 'card-locked', state: 'open', version, lockedBy: X }`。
- 认领成功时：L 没锁就建锁（`{ envFingerprint: F, source: 'claim' }`）；同指纹就刷新 `touchedAt`。

**发布（改 A.7.1）**：逐个任务在原有处理之后看锁。任务有锁键 L 和锁指纹 F 时：

| 锁的状态 | `takeover` | 处理 | `results[i]` 另加 |
|---|---|---|---|
| 没锁 | `true` | 建锁（`source: 'takeover'`） | — |
| 没锁 | 其余 | 不建锁（等第一次认领） | — |
| 同指纹 | 任意 | 刷新 `touchedAt` | — |
| 不同指纹 X | `true` | 接手（见下） | — |
| 不同指纹 X | 其余 | 任务照常建或合并，但在锁变之前认领会被拒 | `lockedBy: X` |

**接手**（`card.lock` 与发布共用）：锁改为 `{ envFingerprint: F, source: 'takeover', since: now, touchedAt: now }`。然后对表里**每个**锁键为 L、锁指纹不是 F、状态是 `open` 或 `claimed` 的任务 T，都走「放弃」的收尾，只是直接进 `failed`：

1. `version += 1`；`state = 'failed'`；`finishedAt = now`；`lastError = 'superseded'`；`attempts` 不变；
2. T 若是 `claimed`：原认领者的连接还在，就先给它发 `task.lease-lost { id, token, reason: 'superseded' }`，再 `claim = null`；
3. 给 T 的每个当前订阅者发 `task.failed { id, error: 'superseded' }`；给可见的 watch 者发 `task.closed { id, state: 'failed' }`。

`done` 的任务不动。

**完成**：锁键为 L 的任务完成时，刷新 L 的 `touchedAt`（锁存在时）。

**`tick()` 第 5 项扫描**（在原有四项之后）：锁 L 满足以下两条就删掉：

- 表里已没有任何任务的锁键是 L；
- `now - touchedAt >= DONE_TTL_MS`。

**`describe()`**：新增 `locks: [{ lockKey, envFingerprint, source, since, touchedAt }]`，按 `lockKey` 排序。

### F.2 节点（`server/render-node/`，Pipeline/Node 的 Node 部分）

**`fingerprint.mjs` 的 `normalizeOs`**：在现有精确匹配之后，按前缀补三条（小写后比）：

- `win` 开头 → `windows`；
- `mac` 开头 → `macos`；
- `linux` 开头 → `linux`。

这是为了认得页面上报的 `navigator.platform`（`Win32`、`MacIntel`、`Linux x86_64`）和 `userAgentData.platform`（`Windows`、`macOS`、`Linux`）。其余输入照旧返回 `other`。

**`split.mjs` 的 `splitPlan`**：新增两个可选参数。

- `cardLocks`：`Map` 或普通对象，`lockKey → envFingerprint`，缺省 `{}`；
- `takeover`：布尔（全部接手），或 `Set<lockKey>`，或 `(lockKey) => boolean`，缺省 `false`。

对每个快照 control、每条流：

- 按 E.5 算出内容键 `contentKey`，也就是任务的 `input.contentKey`，锁键 `L = <kind>:<contentKey>`；
- 取 `X = cardLocks[L]`：
  - 没有 X，或 `X === envFingerprint`：照 E.5，不加 `takeover` 字段；
  - 有 X、`X !== envFingerprint`，且 `takeover` 命中 L：用本节点的 `envFingerprint` 出键，每个任务加 `takeover: true`；
  - 有 X、`X !== envFingerprint`，且不接手：`resultKey = resultKeyOf(contentKey, X)`，`requires.envFingerprint = X`，其余字段不变。剩余帧只给同指纹的节点。

**`session.mjs`**：`claim-rejected` 的 `reason: 'card-locked'` 按 `taken` 处理，丢掉这个候选。现有的「非 `stale` 一律丢」若已覆盖就不用改，报告里写明。

**`local-node.mjs`**：`executor.plan()` 返回的 `PlanContext` 可以带 `cardLocks`、`takeover`，原样传给 `splitPlan`。JSDoc 的 typedef 补这两项。

### F.3 本机预渲染进程（Pipeline/Node 的 Pipeline 部分）

本机只锁**共享档快照**这一种结果，锁键就用卡的内容键 `control.contentKey`：

- 本地档、轨道流、独立卡 PNG 缓存本机只有预渲染进程一个产出者，不加锁；
- PNG 缓存是旧整帧通道和导出用的料，不是页面按层贴的结果。

**新建 `server/card-lock.mjs`**：

```js
export const CARD_LOCK_IDLE_MS = 30_000;
export function createCardLockStore({ dir, now = Date.now })
// → { load(): Promise<void>, get(contentKey), acquire(contentKey, envFingerprint, source), takeover(contentKey, envFingerprint, source), list(), flush(): Promise<void> }
export function cardLockDecision({ lock, ownFingerprint, complete, now, idleMs = CARD_LOCK_IDLE_MS })
// → 'own' | 'reuse' | 'defer' | 'takeover'
```

**锁库**：

- 目录 `<root>/controls-lock/`，一把锁一个文件 `<contentKey>.json`，内容 `{ envFingerprint, source: 'page' | 'prerender', since, touchedAt }`；
- `contentKey` 必须是 64 位小写十六进制，否则 `acquire` / `takeover` 抛出；
- `load()`：读目录里全部 `*.json`，坏文件跳过，目录不存在不算错；
- 各方法语义：
  - `get()`：同步，没有返回 `null`；
  - `acquire()`：同步改内存，回 `{ granted, lock }`；没锁建锁、同指纹刷新 `touchedAt`、不同指纹 `granted: false`；
  - `takeover()`：同步覆盖，`since = touchedAt = now()`；
- 持久化：写盘排在后面异步做（原子写，照 `frame-mov.mjs` 的 `atomic`），`flush()` 等排队的写盘全部落定；
- `list()` 回 `[{ contentKey, ...lock }]`，按 `contentKey` 排序。

**`cardLockDecision`** 是纯函数，按顺序判：

1. 没锁，或 `lock.envFingerprint === ownFingerprint` → `'own'`：照常渲，渲之前得锁；
2. `complete` → `'reuse'`：锁定方的结果已齐，直接投递，不渲；
3. `now - lock.touchedAt < idleMs` → `'defer'`：锁定方可能还在产，先做别的卡；
4. 其余 → `'takeover'`。

**`FramePipeline`**：

- 构造时 `this.cardLockStore = createCardLockStore({ dir: path.join(root, 'controls-lock') })`，并立刻开始 `load()`，记下这个 Promise；
- `async ensureCardLocks()` 等那次 `load()` 落定；
- `rescanSnapshots()` 开头、`preload` 后台那一趟算 card plan 之前、`cardRender` 算 card plan 之前，都 `await this.ensureCardLocks()`。

**`applyCardLocks(plan)`**：在 `recordCardPlan` 里调，对同一份 plan 重复调结果相同。对每个 `tier === 'shared'` 且有 `contentKey` 的 control：

- 第一次见到这个 control 时，记下 `ownSnapshotKey = snapshotKey`、`ownEnvFingerprint = envFingerprint`；
- 锁 `lock = store.get(contentKey)`：
  - 有锁且 `lock.envFingerprint !== ownEnvFingerprint`：`snapshotKey = resultKeyOf(contentKey, lock.envFingerprint)`，`envFingerprint = lock.envFingerprint`，`cardLock = { envFingerprint, source, foreign: true }`；
  - 否则：`snapshotKey = ownSnapshotKey`，`envFingerprint = ownEnvFingerprint`，`cardLock = lock ? { envFingerprint, source, foreign: false } : null`。

这样投递、认领、就绪索引、扫盘重建都自动用锁定方的键，不用各处改。`key`（PNG）和 `contentKey` 不动。

**不替锁定方产帧**：凡是 `cardLock.foreign === true` 的 control：

- `snapshotTargets` 不给它 target，整场景路（含锚帧那一趟）不写它；
- `missingSnapshotFrames` 照常把它现有的区间发成 `layer`，但不把它的帧算进「缺」；
- `fillCardControls` 按 `cardLockDecision` 分支：
  - `complete` = `index.count + rangeCount(index.oversize) >= control.count`，看的是锁定方的键；
  - `'reuse'`：发 `layer`，HTML 这一支不产（`target` 当 `null`），PNG 那一支照旧；
  - `'defer'`：放进本趟的延后列表，其余卡做完后再判一次；仍是 `'defer'` 就这一趟跳过，下一次 `preload` 再判；
  - `'takeover'`：`store.takeover(contentKey, ownEnvFingerprint, 'prerender')`，然后对 `entry.cardPlan` 重跑 `applyCardLocks`，同一内容键的所有 control 都换回自己的键；再用自己键现有的区间（可能为空）发一条 `layer`，线上是整层换键，页面丢掉旧环境的帧；最后照常渲。

**渲之前得锁**：本机为一个共享档 control 写帧前，`store.acquire(contentKey, ownEnvFingerprint, 'prerender')`：

- 位置：`fillCardControls` 开始渲这张卡之前；`recordSnapshots` 每帧入批之前；
- 得不到（页面刚抢先锁了）：这张卡本趟不再写 HTML 快照，对 `entry.cardPlan` 重跑 `applyCardLocks`。

**新方法 `acceptMeasuredSnapshot(entry, control, { envFingerprint, localFrame, html })`**：路由的全部判断放在这里，便于单测。按顺序：

1. `await this.ensureCardLocks()`；
2. `envFingerprint` 不是 16 位小写十六进制 → `{ ok: true, stored: false, reason: 'ENV_MISSING' }`；
3. `store.acquire(control.contentKey, envFingerprint, 'page')` 没得到 → `{ ok: true, stored: false, reason: 'CARD_LOCKED', lockedBy }`；
4. `key = resultKeyOf(control.contentKey, envFingerprint)`；`commitSnapshots({ tier: 'shared', key, clipId, capabilities, items: [{ localFrame, html }] })`；什么都没写进去 → `{ ok: true, stored: true, indexed: false, reason: 'OVER_LIMIT', envFingerprint, key }`；
5. 对 `entry.cardPlan` 重跑 `applyCardLocks`，再 `publishLayer(entry, { clipId, snapshotKey: key }, 'shared', index.frames)`；
6. 回 `{ ok: true, stored: true, indexed: true, count, envFingerprint, key }`。

注意：页面指纹与预渲染进程相同时，第 3 步同指纹得锁，第 4 步的键就是本机自己的键，和预渲染的结果合在一起，这是对的。

**诊断**：`diagnostics()` 新增 `cardLocks: store.list()`；`planDiagnostics()` 的 control 新增 `cardLock`。

**路由 `PUT /api/frames/snapshot`**（`vite-plugin-frames.ts`，替换 E.6 的闸）：

- 在 `NOT_INDEPENDENT` 之后算页面指纹：
  - 请求体有对象 `environment` 时，取 `describeEnvironment({ platform: environment.platform, renderer: environment.renderer, vendor: environment.vendor, chromeVersion: environment.userAgent ?? environment.chromeVersion }).fingerprint`；
  - 否则用字符串 `envFingerprint`；
  - 都没有就传 `null`。
- 其余交给 `service.acceptMeasuredSnapshot(entry, control, …)`，回它的结果（HTTP 200）。

### F.4 页面（`src/editor/`，Pipeline/Node 的页面部分）

- **新建 `src/editor/pageEnvironment.mjs`**，类型声明照仓库里 `.mjs` 被 TS 引用的既有做法补：

  ```js
  export function readPageEnvironment({ navigator, document } = globalThis)
  // → { platform, userAgent, renderer, vendor }
  export function pageEnvironment()   // 缓存一次的 readPageEnvironment()
  ```

  - `platform = navigator.userAgentData?.platform || navigator.platform || ''`；
  - `userAgent = navigator.userAgent || ''`；
  - `renderer` / `vendor`：不挂进文档的 canvas，依次试 `webgl2`、`webgl`，有 `WEBGL_debug_renderer_info` 读 `UNMASKED_*`，否则读 `RENDERER` / `VENDOR`，读完 `WEBGL_lose_context`；
  - 任何一步失败按空串计，不抛。
- **`probeRunner.ts` 的 `forwardProbeFrame`**：请求体加 `environment: pageEnvironment()`，其余不变。

### F.5 测试（Verification）

测试名以编号开头。

**`server/test/card-lock-queue.test.mjs`**（Q1～Q9）：

| 编号 | 内容 |
|---|---|
| Q1 | 首次认领建锁（`source: 'claim'`），同指纹的其余段照常认领 |
| Q2 | 锁上指纹 X 后，同一 `contentKey` 的 Y 指纹任务认领被拒 `card-locked`，带 `lockedBy: X`；版本不变 |
| Q3 | `card.lock`：没锁得锁；同指纹 `granted: true`；不同指纹不带 `takeover` → `granted: false`、锁不变；格式错误 `bad-message`；`card.lock` 在 `PUBLISHER_TYPES` 里，没发过 `publisher.hello` 的连接发它回 `not-registered`（A.5） |
| Q4 | 带 `takeover` 发布：锁转给新指纹；旧指纹 `open` 的任务进 `failed`（`superseded`），`claimed` 的认领者收到 `lease-lost { reason: 'superseded' }`，订阅者收到 `task.failed`；`done` 的不动 |
| Q5 | 不带 `takeover`、锁在别的指纹上时发布：任务照建，`results[i].lockedBy` 是锁指纹 |
| Q6 | `takeover` 不是布尔 → 整条 `bad-message`，状态不变 |
| Q7 | 锁回收：没有任务再引用、且过了 `DONE_TTL_MS` 才删；还有任务引用时不删 |
| Q8 | `describe().locks` 的形状与排序；新 epoch 的队列没有锁 |
| Q9 | 没有 `input.contentKey` 或没有 `requires.envFingerprint` 的任务不建锁、不受锁影响 |

**`server/test/card-lock-node.test.mjs`**（N1～N5）：

| 编号 | 内容 |
|---|---|
| N1 | `normalizeOs` 的新映射（`Win32`、`MacIntel`、`Linux x86_64`、`Windows`、`macOS`、`Linux`），旧映射不变；用真实页面 UA 算指纹 |
| N2 | `splitPlan` 带 `cardLocks`：被别的指纹锁定的卡按锁指纹出键与 `requires`；同指纹、没锁的照旧；本地档的锁键带 `entryKey/` |
| N3 | `splitPlan` 带 `takeover`（布尔、Set、函数三种）：按本节点指纹出键，任务带 `takeover: true`；没命中的照 N2 |
| N4 | 节点会话收到 `card-locked` 丢掉候选，不重试 |
| N5 | `createLocalNode` 把 `PlanContext.cardLocks` / `takeover` 传给切分：用 M3 的环回和假件跑一条链路，被锁的卡只被同指纹节点做完 |

**`server/test/card-lock-pipeline.test.mjs`**（L1～L8）：

| 编号 | 内容 |
|---|---|
| L1 | 锁库：`acquire` 得锁、同指纹刷新、异指纹拒绝；`takeover` 覆盖；`flush` 后新建的库 `load` 读得回；坏文件跳过；非法 `contentKey` 抛 |
| L2 | `cardLockDecision` 四个分支和边界（`touchedAt` 恰好 `idleMs` 前） |
| L3 | `applyCardLocks`：异指纹锁 → control 的 `snapshotKey === resultKeyOf(contentKey, 锁指纹)`、`envFingerprint` 是锁指纹、`cardLock.foreign`；解锁或换回后恢复自己的键；重复调结果相同；`key` / `contentKey` 不变 |
| L4 | `acceptMeasuredSnapshot`：没指纹 `ENV_MISSING`；第一帧得锁、写在页面键下、发 `layer`（键为页面键）；同页面指纹后续帧照写；别的页面指纹 `CARD_LOCKED`；预渲染进程先得锁时页面被拒 |
| L5 | 页面锁定后：`snapshotTargets` 不含这张卡；`missingSnapshotFrames` 不把它的帧算缺，但发出它现有的区间 |
| L6 | 页面结果已齐时 `fillCardControls` 不渲 HTML（假 bakery 计数），发的 `layer` 是页面键 |
| L7 | 页面锁闲置且不齐时接手：锁转为本机指纹，control 换回自己的键，先发一条自己键的 `layer`（换键），之后照常产 |
| L8 | 页面锁还新鲜且不齐：本趟延后，末尾再判；仍新鲜就跳过，不写任何帧 |

**`src/editor/pageEnvironment.test.mjs`**（W1～W2）：

- W1：假 `navigator` / `document` 读出四项；`userAgentData` 优先；
- W2：没有 WebGL、`getContext` 抛出时回空串、不抛。

另外：

- 既有测试因本节失效的（E.6 相关、`normalizeOs` 的 `other` 断言恰好落在新前缀上的），只按本节改输入或期望，不放宽别的断言，逐条写进报告；
- 探针不改。主 Agent 另用现场脚本核对路由。

### F.6 文件归属

| 角色 | 文件 |
|---|---|
| Protocol/State | `server/render-queue/queue.mjs`、`messages.mjs`、`index.mjs`（`constants.mjs` 按需） |
| Node | `server/render-node/fingerprint.mjs`、`split.mjs`、`session.mjs`、`local-node.mjs`、`index.mjs` |
| Pipeline | 新建 `server/card-lock.mjs`、`src/editor/pageEnvironment.mjs`（及类型声明）；改 `server/frame-pipeline.mjs`、`server/vite-plugin-frames.ts`、`src/editor/probeRunner.ts` |
| Verification/Test | 新建上面四个测试文件；改受影响的既有测试 |
| 主 Agent | 本节；`rendering.md`、`glossary.md`、设计 2.1、`TODO.md`、报告 |

### F.7 定稿后的补充细则（2026-09-24，主 Agent 按实现方疑点裁定）

**问题**：不知道锁的切分节点按自己的指纹发布了被别的环境锁定的卡，这些任务谁也认领不了，一直 `open`，页面永远等不到 `task.done`。M3 的 I6 第二轮就是这种情形。按「不得抢单」，这类任务不该建出来；切分方要照锁定方的指纹重发，或者明确接手。

1. **发布时拒建**（改 F.1「发布」表的最后一行）：
   - 条件：任务有锁键 L 和锁指纹 F，锁在别的指纹 X 上，没带 `takeover`，且表里**没有**同 `id` 的任务；
   - 处理：**不建**，`results[i] = { id, error: 'card-locked', lockedBy: X }`，和 `limit` 一样不影响同一条消息里的其它任务；
   - 已有同 `id` 任务的，照 A.7.1 合并，另加 `lockedBy: X`。
2. **没锁时带 `takeover`**：建锁（`source: 'takeover'`），同时照「接手」作废锁键为 L、指纹不是 F 的 `open` / `claimed` 任务。两个节点几乎同时切分时，不留异指纹的死任务。
3. **锁回收**的比较与 A.8 一致，用严格大于：`now - touchedAt > DONE_TTL`。常量名以 `constants.mjs` 为准（`DONE_TTL`），F.1 里写的 `DONE_TTL_MS` 指的就是它。
4. 因 `limit` 没建成的那一项不做任何锁处理。
5. **`local-node.mjs` 切分后等发布回包**：
   - 派生任务的 `task.publish` 带 `reqId`；等到同一 `reqId` 的 `task.published` 回来，才 `complete` 这个 `plan`（用注入的等待方式，跟随 `signal` 中止）。理由：细任务要在 `plan` 仍被本节点认领时发布，才能继承页面的订阅（A.4 继承条件）。
   - 回包里有 `error: 'card-locked'` 的：
     - 把这些结果的锁键和 `lockedBy` 并进 `cardLocks`；
     - 按 `createLocalNode` 的新选项 `takeoverLocked`（布尔或 `(lockKey, lockedBy) => boolean`，缺省 `false`，即照锁定方的指纹重发）重跑 `splitPlan`；
     - 只发布锁键在这些结果里的任务，再等一次回包；
     - 最多重来 2 轮，还被拒的放弃，发事件 `{ type: 'plan-relocked', id, lockKeys, gaveUp: [...] }`。
   - `complete` 的 `derived` 是最终发布成功的全部 id。
6. **测试**：
   - I6 的第二轮按本节改期望：被第一轮锁住的卡，第二轮的细任务照锁定方的指纹出键，由锁定方指纹的节点做完。只改这一处期望，其余断言不放宽；
   - 新增：
     - Q10：拒建，任务不存在，`results` 带 `error` 与 `lockedBy`；
     - Q11：没锁时带 `takeover` 也作废异指纹任务；
     - N6：`local-node` 在拒建后照锁指纹重发、`plan` 等回包后才完成、细任务继承页面订阅；`takeoverLocked` 为真时带 `takeover` 重发。

### F.8 本机侧的补充细则（2026-09-24，主 Agent 按 Pipeline 实现方疑点裁定）

1. **本机已有结果也得锁**：`fillCardControls` 走到一个共享档 control 时，锁库里没有它的锁，就用本机指纹得锁（`source: 'prerender'`），不管这张卡本机是不是已经齐了。否则换键前就已产齐、但没有锁文件的卡，会被页面的第一帧测量帧锁走，反而少了覆盖。页面在后台那一趟走到这张卡之前推来测量帧的，仍是页面先得锁。
2. **延后的卡要再判**：`rendering.md` 说锁定方停下一段时间后要接手，所以延后不能停在「等下一次 preload」。
   - 一趟后台结束时仍有 `'defer'` 的卡，就定一个一次性计时器（`unref`），在 `cardLockIdleMs` 之后重判这些卡；
   - 计时器触发时，满足以下三条才把一小趟排进后台串行链：这一版的后台那一趟没被取消（它的 `signal` 没 abort）；还有会话的当前版本是这个 entry；这些卡仍在预渲染集合里。
   - 那一小趟只对这些卡跑 `fillCardControls`，同一个 `signal`、`'background'` lane 的预渲染间；
   - 重判结果：已齐 → 投递；已闲置 → 接手；仍新鲜 → 再延后。同一版最多重排 20 次，之后等下一版。
   - `FramePipeline` 构造参数新增 `cardLockIdleMs`（缺省 `CARD_LOCK_IDLE_MS`），决策和计时器都用它，测试可以给小值。
3. **同一内容键的所有片段一起发层**：接手，或测量帧入库时，`entry.cardPlan` 里内容键相同的每个 control 都发一条 `layer`，同一张卡摆了几次时各片段一起换键。
4. control 没有 `contentKey` 时，`acceptMeasuredSnapshot` 回 `{ ok: true, stored: false, reason: 'NO_CONTENT_KEY' }`、不写；锁库对空的环境指纹同样抛出。
5. **测试**：L4、L7 按第 3 条补「多个片段一起换键」的断言；新增：
   - L9：`cardLockIdleMs` 给小值，延后的卡在锁闲置后被重判并接手；在重判前页面结果已齐的，改为投递；
   - L10：本机已齐、没有锁文件的卡，后台那一趟之后锁归本机，此后页面测量帧回 `CARD_LOCKED`。

---

## G. M5a：网络层、集群令牌与服务地址登记（文档服务通用化）

主 Agent 定稿，2026-09-25（用户授权自动推进，未逐节审阅；有疑点按回退梯次处理）。依据：`docs/plan/Master-Execution-Plan.md` 第 5.4 节（文档服务通用化）、第 7 节 M5a、第 3 节 S1 / S3 / S4；语义 `document-service.md`「职责」「连接发现」（M5a 开工前按 S1 与定位改写）。

**范围**：
- 文档服务拆成「通用核心 + 模块」，渲染任务队列与服务地址登记各是一个模块；
- 建连用集群令牌鉴权；
- 节点经真 WebSocket 接队列，断线自动重连；
- 端点解析与离线回落。

**不在范围**：
- 不接真实预渲染执行器，产物库仍用 D.3 的假件；
- 不改 `frame-pipeline.mjs`、页面、导出路径；
- 频道与背压在 C6（本节只要求核心留出位置）；
- 指纹前置过滤在 M5b。

### G.1 分层与文件

| 层 | 文件 | 可以引用 | 不可以 |
|---|---|---|---|
| 传输 | `server/docservice/ws.mjs` | Node 内置 | 任何业务词 |
| 核心 | `server/docservice/router.mjs`（新） | Node 内置 | 引用 `server/render-queue/`、`./modules/`；出现 `task.`、`node.hello`、`publisher`、`queue` 这类业务词（守门测试 R2 按源码文本检查） |
| 组装 | `server/docservice/service.mjs` | 传输、核心、`./auth.mjs`、`./modules/*` | —— |
| 鉴权 | `server/docservice/auth.mjs`（新） | Node 内置 | 业务词 |
| 模块 | `server/docservice/modules/render-queue.mjs`（新）、`server/docservice/modules/endpoints.mjs`（新） | 各自需要的东西（队列模块引 `server/render-queue/`） | 引用别的模块 |
| 入口 | `server/docservice/main.mjs` | 组装层、队列、两个模块 | —— |

〔裁〕计划第 5.4 节把 `service.mjs` 与 `router.mjs` 一起叫「核心」。定稿细化为：`router.mjs` 是纯核心，`service.mjs` 是组装层（HTTP、升级、鉴权、心跳、旧接口的外观）。守门只针对 `router.mjs` 与 `ws.mjs`。

### G.2 核心：`createRouter`

```js
export function createRouter({ now, log, write }) → Router
// write(connId, text): 把一条已序列化的消息写到连接上（组装层接到 WsConnection.send）

Router = {
  connect(connId, principal, info),      // info = { remote, connectedAt }；对已挂的模块逐个调 connect
  disconnect(connId),                    // 对已挂的模块逐个调 disconnect，然后删连接记录
  dispatch(connId, text),                // 解析信封、路由到模块
  mount(module) → unmount,               // 见 G.3
  tick(name?),                           // 同步调一个或全部模块的 tick
  send(connId, message),                 // 模块之外的发送入口（旧接口 service.send 用它）
  describeConn(connId) → object,         // 合并各模块 describeConn 的字段
  health() → object,                     // 合并各模块 health 的字段
  modules() → string[],                  // 已挂模块名，按挂载顺序
}
```

**信封**：
- 入站必须是 JSON 对象、带字符串 `type`；
- `reqId`（字符串，或有限的数字）可选，核心不解释它，只在核心自己回错误时带上；
- 其余字段属于模块。

**核心的错误回包**（`{ type: 'error', reason, detail, reqId? }`）：

| `reason` | 何时 |
|---|---|
| `bad-message` | 不是合法 JSON、不是对象、没有字符串 `type` |
| `unsupported` | 没有模块认领这个 `type` |
| `internal` | 模块的 `handle` 同步抛出，或它返回的 Promise 被拒绝。记日志 `module.error { module, type, message }`，连接和别的模块照常工作 |

`detail` 是给人看的中文短句，不含消息原文。

### G.3 模块接口

```js
module = {
  name: string,                          // 唯一；重复挂载抛错
  types: string[],                       // 精确名（'node.hello'）或以 '.' 结尾的前缀（'service.'）
  connect?(ctx, connId, principal),
  disconnect?(ctx, connId),
  handle(ctx, connId, message),          // 同步；需要异步的模块自己排队，返回值被忽略（Promise 只挂错误处理）
  tick?(ctx),
  tickMs?: number,                       // 组装层按它起计时器；没有 tick 就不起
  describeConn?(connId) → object,        // 合进 describe().conns[i]
  health?() → object,                    // 合进 /healthz
  describe?() → any,                     // 进 describe().modules[name]
}

ctx = { send(connId, message), now(), log(event, fields) }
```

- **类型冲突**：挂载时，新模块与已挂模块之间出现下面任一情况就抛错、不挂：
  - 精确名相同；
  - 一方的精确名以另一方的前缀开头；
  - 两个前缀里有一个以另一个开头。

  所以任何一条消息至多属于一个模块，匹配顺序无关紧要。
- **字段冲突**：`describeConn`、`health` 返回的字段名与核心字段或已挂模块的字段重名时，挂载抛错。实现方在挂载时各调一次这两个函数，拿到字段名来检查。
- **挂载时机**：挂载时对已有连接逐个调 `connect`，卸载时逐个调 `disconnect`；卸载后这些类型回 `unsupported`。
- `ctx.send` 发给已断开的连接时静默丢弃。
- 核心不给出站消息补任何字段（队列自己补 `epoch`）。
- C6 会在 `ctx` 上加 `publish(channel, message)` 和订阅钩子，本节不实现，也不预先占用这两个名字以外的 `ctx` 字段。

### G.4 组装层：`createDocService`（旧接口不变）

- 签名、返回值、现有行为不变。`server/test/docservice.test.mjs` 一个字不改，要全过。
- 新增选项：
  - `modules?: module[]`：创建时挂上；
  - `autoTick = true`：为 `false` 时不起模块计时器，测试手动调 `service.tick()`；
  - `protocol = 'promptcut.v1'`。
- 新增方法：`mount(module) → unmount`、`tick(name?)`。
- **旧接口的外观**：
  - `mountRenderQueue(q)` 等于 `mount(renderQueueModule(q, { sweepMs }))`；
  - 创建时挂一个占位模块 `renderQueuePlaceholder()`，它认领队列的全部类型，一律回 `queue-unavailable`，`describeConn` 回 `{ roles: [], publisherId: null, node: null }`，`health` 回 `{ queue: false, publishers: 0, nodes: 0 }`；
  - `mountRenderQueue` 先卸占位模块再挂真的；它返回的卸载函数卸真的、重新挂占位模块。
- 两个工厂都放在 `modules/render-queue.mjs`，组装层只从那里拿。
- **队列模块**：
  - `types` 是 `node.hello`、`publisher.hello`、`NODE_TYPES`、`PUBLISHER_TYPES` 的精确名，照 `messages.mjs` 出口取，不写死；
  - `publisherId`、`node` 这两种角色记在模块自己的连接表里；
  - 现有 `service.mjs` 里 `recordRole`、`rolesOf` 的行为原样搬过去；
  - `health()` 回 `{ queue: true, publishers, nodes, epoch }`。
- **`/healthz`**：
  - 核心字段：`ok`、`service`、`uptimeMs`、`connections`、`protocol`、`modules`；
  - 各模块的 `health()` 字段平铺合入；
  - 旧字段（`queue`、`publishers`、`nodes`）因此不变，另多出 `epoch`。
- **`describe()`**：
  - `conns[i]` = 核心字段（`connId`、`remote`、`principal`、`connectedAt`）加上各模块 `describeConn` 的字段；
  - 另加 `modules: { [name]: module.describe?.() ?? null }`。

### G.5 集群令牌鉴权（`auth.mjs`）

```js
export const PROTOCOL = 'promptcut.v1';
export function createClusterAuth({ token, allowAnonymous }) → {
  authenticate(req) → principal | null,     // null = 401
  protocolFor(req) → 'promptcut.v1' | null,  // 握手要回显的子协议；null = 不回 Sec-WebSocket-Protocol
}
export function isLoopbackHost(host) → boolean   // '127.0.0.1'、'::1'、'localhost'
export function checkTokenFormat(token) → boolean // /^[A-Za-z0-9_-]{32,256}$/
```

- **携带方式**：客户端在 `Sec-WebSocket-Protocol` 里给两项：
  - `promptcut.v1`
  - `promptcut.token.<令牌>`

  浏览器和 Node 内置的 `WebSocket` 都用 `new WebSocket(url, [两项])`。不放 URL 查询串。
- **回显**：只要客户端给了 `promptcut.v1`，握手成功时服务端就回 `Sec-WebSocket-Protocol: promptcut.v1`，**从不回显令牌那一项**。`ws.mjs` 的 `acceptUpgrade` 为此新增可选参数 `protocol`。Chrome 在请求了子协议、服务端却没回的时候会让握手失败，所以必须回。
- **令牌模式**（`token` 已设）：
  - 缺 `promptcut.v1`、缺令牌项、令牌不符 → 401；
  - 令牌比对：两边各取 sha256，再用 `crypto.timingSafeEqual` 比较；
  - 通过 → `principal = { userId: 'cluster', tenantId: 'cluster' }`（计划第 3 节 S3）。
- **匿名模式**（`token` 未设且 `allowAnonymous`）：
  - 不看令牌项，`principal = { userId: 'anonymous', tenantId: null }`（与现在相同）；
  - 带了 `promptcut.v1` 的照样回显；
  - 旧客户端（包括 `scripts/probes/ws-client-test.mjs` 不带参数时）不带子协议，也能连上。
- **日志**：握手被拒记 `auth.reject { remote, reason }`，`reason` ∈ `no-protocol` / `no-token` / `bad-token`。任何日志、错误信息、`describe()` 里都不出现令牌原文。
- **失败即关**（`main.mjs`）：
  - 读 `PROMPTCUT_CLUSTER_TOKEN`；
  - 已设但 `checkTokenFormat` 不过 → 打一行 `config.error { reason: 'bad-token-format' }`，退出码 1；
  - 未设且 `PROMPTCUT_DOCSERVICE_HOST` 不是回环地址 → 打 `config.error { reason: 'token-required' }`，退出码 1；
  - 未设且绑回环 → 匿名模式；
  - 已设 → 令牌模式（绑哪里都一样）。
- **生成令牌**（写进 `main.mjs` 文件头，给人看）：
  ```
  node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
  ```
- **部署**：
  - `scripts/remote/docservice.mjs deploy` 从本机环境变量读 `PROMPTCUT_CLUSTER_TOKEN`，没设就拒绝部署（远端绑 `0.0.0.0`）；
  - 令牌只经 ssh 的标准输入进远端脚本，由它 `export` 后 `pm2 startOrReload --update-env`；
  - 不上命令行，不回显，不写进仓库；
  - `ecosystem.config.cjs` 透传这个变量。

### G.6 服务地址登记模块（`modules/endpoints.mjs`，D7 与 S1）

`types: ['service.']`。常量从本模块导出：

```js
ENDPOINT_DEFAULTS = { GRACE_MS: 10_000, MAX_ANNOUNCERS: 64, MAX_URLS: 8, MAX_META_BYTES: 4096, TICK_MS: 1000 }
```

| 入站 `type` | 字段 | 回包 | 其它效果 |
|---|---|---|---|
| `service.announce` | `announcerId`、`kind`、`urls: string[]`、`meta?: object` | `service.announced { announcerId, kind, urls }` | 以 `(announcerId, kind)` 为键新建或替换；登记绑定到这条连接；向订阅了该 `kind` 的连接推送 |
| `service.withdraw` | `announcerId`、`kind` | `service.withdrawn { announcerId, kind, removed: boolean }` | 只有登记所在的连接能撤回；删掉后推送 |
| `service.watch` | `kinds: string[] \| 'all'` | `service.endpoints { endpoints }`（该连接可见的全量） | 此后每次变化都给它推一条全量 |

- `endpoints` 的每项：`{ announcerId, kind, urls, meta, since }`，`since` 是 `ctx.now()`。
- **推送一律是全量**：按订阅者的 `kinds` 过滤后的完整列表。列表很小，不做增量。
- **校验**（不过 → `error { reason: 'bad-message' }`，状态不变）：
  - `announcerId` 匹配 `/^[A-Za-z0-9._:-]{1,128}$/`；
  - `kind` 匹配 `/^[a-z][a-z0-9-]{0,31}$/`；
  - `urls` 1～`MAX_URLS` 个，每个能被 `new URL` 解析，协议是 `http:` 或 `https:`，不带用户名密码，长度 ≤ 2048；
  - `meta` 序列化后 ≤ `MAX_META_BYTES`。
- **上限**：登记总数超过 `MAX_ANNOUNCERS` → `error { reason: 'limit' }`。
- **断开与宽限**：
  - 登记所在的连接断开时，登记标为离线、记下时刻，但**仍然可见**；
  - `tick` 发现离线超过 `GRACE_MS`（严格大于）就删掉并推送；
  - 宽限期内同一 `(announcerId, kind)` 从新连接再登记：只改绑连接，不推送撤回；`urls` 变了才推送。
- **只交换地址**：模块不访问登记的 URL，不转发任何字节（语义 `document-service.md`「连接发现」）。
- **权限**：M5a 里任何通过鉴权的连接都能登记和订阅（S3：细粒度权限在 M6）。
- `health()` 回 `{ endpoints: <登记数> }`；`describeConn` 不加字段。

### G.7 节点侧：WebSocket 端点与端点解析（`server/render-node/`）

**`ws-transport.mjs`**：

```js
export const BACKOFF_DEFAULTS = { baseMs: 500, factor: 2, maxMs: 15_000, jitter: 0.2 };
export function createWsEndpoint({
  url, token?, WebSocket = globalThis.WebSocket,
  setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout,
  random = Math.random, backoff?, log?,
}) → WsEndpoint

WsEndpoint = {
  send(message) → boolean,        // 未连上时丢弃、回 false、计入 stats.dropped
  onMessage(handler),             // 多个处理器按注册顺序都调；收到的非 JSON 文本丢弃并计数
  onOpen(handler), onClose(handler),   // 每次（重）连上、每次断开都调；onClose 带 { code, reason }
  close(),                        // 关连接、停止重连，closed 变 true
  readonly connected: boolean,
  readonly closed: boolean,
  stats() → { opens, closes, sent, received, dropped, badFrames },
}
```

- 满足 D.2 的 `endpoint` 形状（`send`、`onMessage`）。
- **子协议**：有 `token` 时是 `['promptcut.v1', 'promptcut.token.' + token]`，否则是 `['promptcut.v1']`。
- **重连**：
  - 断开或连不上之后，第 n 次（从 0 起）等 `min(maxMs, baseMs × factor^n)`，再乘 `1 + jitter × (2·random() − 1)`；
  - 连上后 n 清零；
  - `close()` 之后不再重连。
  - 401 在浏览器 API 里表现为连不上，同样按退避重连，退避封顶，不会高频打服务端。
- **断线期间的消息一律丢弃**，不缓存重放。正确性靠两条保证：重连后的 `hello.resume` 与 `queue.snapshot`；以及 D.2 细任务开工前先查 `sink.has`。完成报告丢了，最坏是租约到期后被重做一次，走去重直接完成。
- **接 `local-node`**：由调用方负责，本模块不认识它。约定写法（e2e 探针就这么用）：
  ```js
  ep.onOpen(() => node.start(node.session.held().map(({ id, token }) => ({ id, token }))));
  ```
  `local-node.start()` 已经做到重复调用时只挂一次处理器、按原 `reqId` 重发还在等回包的发布（D.2），本阶段**不改 `local-node.mjs`**。

**`endpoint.mjs`**：

```js
export async function resolveDocservice({ env = process.env, fetch = globalThis.fetch, timeoutMs = 3000 })
  → { mode: 'remote' | 'local' | 'offline', url?: string, health?: object, tried: [{ url, ok, reason? }] }
export function watchServiceEndpoints(wsEndpoint, kinds, onChange) → stop()
```

- **`resolveDocservice` 的顺序**：
  1. `PROMPTCUT_DOCSERVICE_URL`（`ws://` 或 `wss://`）；
  2. `ws://127.0.0.1:${PROMPTCUT_DOCSERVICE_PORT ?? 8787}`；
  3. 都不行 → `offline`，调用方回落本机 preload 路径。
- 每个候选的探活方法：把协议换成 `http:` / `https:`，`GET /healthz`，超时 `timeoutMs`；`ok === true` 且 `protocol === 'promptcut.v1'` 才算可用。协议不符的 `reason` 是 `protocol-mismatch`。
- 第 1 项可用 → `remote`；第 2 项可用 → `local`。
- `watchServiceEndpoints`：每次 `onOpen` 发一次 `service.watch { kinds }`；收到 `service.endpoints` 就调 `onChange(endpoints)`。

**出口**：`server/render-node/index.mjs` 加出这些名字。`ws-transport.mjs` 只引 Node 内置；`endpoint.mjs` 不读文件系统。

### G.8 探针

**`scripts/probes/render-queue-e2e.mjs`**：

```
node scripts/probes/render-queue-e2e.mjs --url <ws://…> --role publisher|node|both
  [--tasks 50] [--project <id>] [--node-id <id>] [--task-ms 200] [--max-concurrent 2]
  [--exit-after-claim] [--announce <http-url>] [--watch-endpoints] [--timeout-ms 120000]
```

- 令牌从 `PROMPTCUT_CLUSTER_TOKEN` 读，不接受命令行参数。
- **`node` 角色**：
  - 用 `createLocalNode` + `createWsEndpoint`；执行器按 `--task-ms` 睡眠，产物库用内存版；
  - 可以复用 `server/test/fake-*.mjs`：探针不是生产代码，D.3 的禁令不适用；
  - `--exit-after-claim`：第一次认领成功后立刻 `process.exit(3)`，用来测「干净断开」（X5）。
- **`publisher` 角色**：
  - 发 `publisher.hello`，发布 `--tasks` 个假细任务（`kind: 'snapshot'`、`tier: 'shared'`，结果键随机、带运行 id，免得撞上旧任务）；
  - 数 `task.done`：每个 id 第一次记完成，再来的记重复；
  - 看到 `epoch` 变了，就把没完成的重新发布。
- **`both`**：同一进程两者都跑。
- **测接手**：`node` 角色同时 `queue.watch`。记下别人认领某任务时看到 `task.taken` 的时刻 t1，和自己认领到同一任务的时刻 t2，`takeovers[]` 记 `t2 − t1`。两个时刻都用本机时钟，不受两台机器时钟偏差影响。
- **输出**：最后一行 JSON：
  ```
  { ok, role, url, epochs: [], published, completed, duplicateDone, claims, claimsById,
    doneLatencyMs: { p50, p95 }, takeovers: [{ id, ms }], endpoints?: [], fails: [] }
  ```
- **退出码**：0 全过；1 有断言失败；2 连不上；3 `--exit-after-claim` 的预期退出。

**`scripts/probes/render-queue-proxy.mjs`**（TCP 层代理，不解析 WebSocket）：

```
node scripts/probes/render-queue-proxy.mjs --listen 127.0.0.1:8795 --target <host:port>
  [--delay-ms 200] [--loss 0.05] [--loss-hold-ms 200..1000] [--stall-after-ms N] [--cut-after-ms N]
```

- `--loss p`：每个数据块以概率 p 被「扣住」一段随机时长再发，其后的块也排在它后面，模拟 TCP 重传带来的队头阻塞。不能真丢字节：丢了会破坏 WebSocket 帧。
- `--stall-after-ms`：到点后两个方向都停止转发、但不关连接，模拟半开。
- `--cut-after-ms`：到点后直接断开。
- 每条连接的统计打到标准输出。

`scripts/probes/ws-client-test.mjs` 加上：从 `PROMPTCUT_CLUSTER_TOKEN` 读令牌，按 G.5 携带；断言 `/healthz` 有 `protocol`、`modules`。

### G.9 测试（Verification，`server/test/`）

测试名以编号开头。一律用端口 0；需要时钟的用 `now` 注入加 `autoTick: false` 手动 `tick`。

**`docservice-router.test.mjs`**：

| 编号 | 内容 |
|---|---|
| R1 | 挂一个与渲染无关的示例模块 `text.`（`text.count { text }` → `text.counted { lines, chars }`），与队列同时在线；两边的消息互不串门；同一条连接交替发两种消息，各自正确 |
| R2 | 守门：`router.mjs`、`ws.mjs` 的源码文本里没有 `render-queue`、`modules/`、`task.`、`node.hello`、`publisher`、`queue` |
| R3 | 类型冲突的三种情形都在挂载时抛错；字段冲突同样抛错；抛错后已挂的模块不受影响 |
| R4 | `docservice.test.mjs` 不改一个字全过（由 `npm test` 覆盖，这里不重复写） |
| R5 | 模块 `handle` 同步抛出、返回被拒绝的 Promise：回 `internal`（带原 `reqId`），连接不断，别的模块照常 |
| R6 | 卸载后这些类型回 `unsupported`；`mountRenderQueue` 的卸载函数卸下之后回 `queue-unavailable` |
| R7 | `/healthz` 有 `protocol`、`modules`，旧字段不变，挂上队列后有 `epoch`；`describe()` 的 `conns[i]` 含队列模块的 `roles` / `publisherId` / `node`，`modules` 含各模块 `describe` |

**`docservice-auth.test.mjs`**：

| 编号 | 内容 |
|---|---|
| A1 | 令牌模式：不带子协议 → 401；只带 `promptcut.v1` → 401；令牌错 → 401 |
| A2 | 令牌对 → 101，响应头 `Sec-WebSocket-Protocol` **恰好**是 `promptcut.v1`；Node 内置 `WebSocket` 能连上，`ws.protocol === 'promptcut.v1'` |
| A3 | 通过后 `principal` 为 `{ userId: 'cluster', tenantId: 'cluster' }`；消息里自报的 `userId` 不改变它 |
| A4 | 匿名模式：不带子协议的旧客户端能连上；带 `promptcut.v1` 的得到回显 |
| A5 | 被拒、通过各试几次，收集到的全部日志里都找不到令牌原文 |
| A6 | 起 `main.mjs` 子进程：非回环地址且未设令牌 → 退出码 1、输出含 `token-required`；令牌格式不对 → 退出码 1、`bad-token-format`；回环且未设 → 起得来、`/healthz` 正常 |

**`docservice-endpoints.test.mjs`**：

| 编号 | 内容 |
|---|---|
| E1 | 登记后，订阅了该 `kind` 的连接收到一条全量 `service.endpoints`，没订阅的收不到 |
| E2 | `service.watch` 的回包是当前可见的全量；`kinds` 过滤正确，`'all'` 看到全部 |
| E3 | 同一 `(announcerId, kind)` 再登记：替换，不新增 |
| E4 | `service.withdraw`：登记所在的连接能撤回，别的连接撤回回 `removed: false` |
| E5 | 登记所在的连接断开：宽限期内仍可见；`GRACE_MS` 之后的 `tick` 删除并推送；正好等于 `GRACE_MS` 时不删 |
| E6 | 宽限期内从新连接以相同 `urls` 再登记：不推送撤回；`urls` 变了推送一次 |
| E7 | 校验：`ftp:` 地址、带用户名密码的地址、超过 8 个地址、`kind` 不合法、`meta` 过大 → `bad-message`，状态不变 |
| E8 | 第 65 个登记回 `limit` |

**`render-node-ws.test.mjs`**：

| 编号 | 内容 |
|---|---|
| T1 | 对真文档服务（端口 0，匿名模式与令牌模式各一遍）建 `createWsEndpoint`：`onOpen` 触发；`local-node` 收到 `node.welcome` |
| T2 | 服务端主动断开：重连等待按 G.7 公式（注入 `setTimeout` 记录与固定 `random`），连上后清零 |
| T3 | 断线期间 `send` 回 `false`，`stats().dropped` 计数正确 |
| T4 | 节点认领一个任务后，服务端强行断开这条连接（宽限期内）：重连后节点以 `resume` 接续，令牌不变，任务照常完成 |
| T5 | 换一个新的文档服务实例（新 epoch）：原持有的任务收到 `lease-lost { reason: 'epoch' }`，`onLost` 被调 |
| T6 | `resolveDocservice`：环境变量地址可用 → `remote`；它不可用、回环可用 → `local`；都不可用 → `offline`；`protocol` 不符 → 跳过并记 `protocol-mismatch` |
| T7 | `close()` 之后不再重连 |
| T8 | 令牌错误：连续连不上时退避增长到 `maxMs` 封顶，`opens === 0` |
| T9 | 两个节点经真 WebSocket（回环）抢 50 个假任务：每个任务恰好完成一次，两个节点各至少一个 |

### G.10 文件归属

| 子分支 | 文件 |
|---|---|
| `claude/rq-m5a-svc` | `server/docservice/router.mjs`、`auth.mjs`、`modules/render-queue.mjs`、`modules/endpoints.mjs`（新）；`server/docservice/service.mjs`、`ws.mjs`、`main.mjs`、`ecosystem.config.cjs`；`scripts/remote/docservice.mjs` |
| `claude/rq-m5a-net` | `server/render-node/ws-transport.mjs`、`endpoint.mjs`（新）；`server/render-node/index.mjs` |
| `claude/rq-m5a-tests` | `server/test/docservice-router.test.mjs`、`docservice-auth.test.mjs`、`docservice-endpoints.test.mjs`、`render-node-ws.test.mjs`（新）；`scripts/probes/render-queue-e2e.mjs`、`render-queue-proxy.mjs`（新）；`scripts/probes/ws-client-test.mjs` |
| 主 Agent | 本节；`docs/reports/REPORT-render-queue-m5a.md` |

不改：
- `server/render-queue/`；
- `server/render-node/local-node.mjs`、`session.mjs`；
- `server/test/docservice.test.mjs`；
- 任何渲染与页面代码。

### G.11 定稿后的补充细则（2026-09-25，主 Agent 按实现方疑点裁定）

- **握手失败不算断开**：包括 401 在内的握手失败，不调 `onClose`、不计 `closes`；只有连上过的连接断开才算。
- **计数口径**：`badFrames` 包括能解析、但不是对象的 JSON 和二进制帧；`received` 只数交给处理器的消息。
- **抖动乘在封顶之后**：单次等待的上限是 `maxMs × (1 + jitter)`。
- **T5 只断言两件事**：线上收到 `task.lease-lost { reason: 'epoch' }`；`onLost` 被调过。不断言 `onLost` 的 reason：会话先按 `node.welcome.lost` 报 `'lost'`，是 B.5 补充细则的既有行为。
- **`watchServiceEndpoints` 立即补发订阅**：调用时端点已经连上的，立刻补发一次 `service.watch`。
- **`resolveDocservice` 的边界**：
  - URL 为空串视为没设；
  - 不是 `ws:` / `wss:` 的记 `bad-url`，继续试下一项；
  - `/healthz` 取在源站根上。
- **端点的创建与关闭**：`createWsEndpoint` 创建时立即连接，参数不合法时同步抛 `TypeError`。`close()` 之后 `connected` 立即变为 `false`；`onClose` 在底层真正关上时才调，带 `{ code: 1000, reason: 'closed' }`。

### G.12 接线方式与命名（2026-09-25，主 Agent 按 svc 实现方疑点补定）

1. **令牌模式的接法**：
   - `createDocService({ authenticate: auth.authenticate, log })`；
   - 其中 `auth = createClusterAuth({ token, allowAnonymous, log? })`；
   - `createClusterAuth` 的可选参数 `log` 用来记握手被拒的 `auth.reject`。
2. **子协议回显由组装层做**：客户端给了 `promptcut.v1` 就回显，`protocol` 选项缺省是 `promptcut.v1`。
3. **服务地址登记模块**：`modules/endpoints.mjs` 导出 `endpointsModule(options?)`，另有别名 `createEndpointsModule` 和默认导出。
   - 选项平铺：`graceMs`、`maxAnnouncers`、`maxUrls`、`maxMetaBytes`、`tickMs`，缺省取 `ENDPOINT_DEFAULTS`；
   - 没带 `meta` 的登记存为 `meta: null`；
   - 宽限期内从新连接再登记：`urls` 和 `meta` 都没变才不推送。
4. **队列模块**：`modules/render-queue.mjs` 导出 `renderQueueModule(q, { sweepMs })`、`renderQueuePlaceholder()`。
5. **两处 `modules` 形状不同**：`/healthz` 里是模块名数组，`describe().modules` 是对象。
6. **保留字段名**：`conns` 是核心保留的 `health` 字段名，模块不能用。
7. **字段冲突检查的调用方式**：挂载时用一个不存在的连接 id 调一次 `describeConn`，模块对未知连接也要返回完整的字段集。
8. **`ws.mjs` 的半开修正**：对端结束 TCP 却没发关闭帧时，服务端立即结束本端并触发 `disconnect`，不再等心跳。
9. **`main.mjs` 的输出与判定**：
   - `config.error` 同时写 stdout 和 stderr；
   - 令牌为空串算「已设」，按格式错误关闭。
