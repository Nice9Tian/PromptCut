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
- **E.6 实际效果**：页面用 GPU 栅格化，本机预渲染用 SwiftShader，两边指纹几乎不可能相同，所以这道闸实际上停掉了测量帧入库。这条路径以后怎么处理记在 `TODO.md`，本阶段不改页面。
