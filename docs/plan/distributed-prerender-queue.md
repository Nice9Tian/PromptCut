# 分布式预渲染：文档服务托管的拉取式任务队列（设计方案）

状态：**设计稿，待审核**。审核通过前不写实现代码。

语义依据：`docs/semantics/architecture/document-service.md`「渲染任务队列」、`platforms.md`「渲染节点」、`rendering.md`「重管线：预渲染」、`asset-storage.md`「预渲染的产物」。本文与语义冲突时以语义为准。

前置条件：文档服务本身还没实现（`docs/plan/cloud-task.md` 第 6 步 `vite-plugin-docservice.ts`，WebSocket、`projectRev`）。预渲染产物入素材服务（A3b）也还没做。本方案建在这两者之上，不单独落地。

## 1. 目标与边界

- 拓扑：本机 PC、独立渲染主机、纯浏览器三类渲染节点，共同为一个或多个项目做预渲染。
- 调度：拉取式。文档服务只在内存里记账（任务、状态、认领者），不测算算力、不主动分配。
- 不在本方案内：
  - 查询渲染（Agent 看画面、用户交互需要的查询）仍在各自所在的位置直接做，不进队列；
  - 成片导出；
  - 素材上传；
  - 多租户鉴权的具体实现（第 7 节只列要求）。

## 2. 任务的粒度与身份

一个任务 = **一个预渲染结果键的一段帧范围**。

| 种类 `kind` | 结果键 `resultKey` | 范围单位 | 缺省段长 |
|---|---|---|---|
| `snapshot`，`tier: "shared"` | 共享键（`card-cache.mjs` 的 `snapshotKey`，与项目无关） | 卡片本地帧 | 60 帧 |
| `snapshot`，`tier: "local"` | `<entry.key>/<共享键>`（毛玻璃、`unknown` 卡要整场景渲） | 卡片本地帧 | 60 帧 |
| `stream` | 流键 `streamKey` | 分段号（每段 15 帧，现有 G2 规则） | 8 段 |
| `plan` | `<projectId>@<projectRev>` | 无 | — |

- **任务 id 由内容决定**：`<kind>:<resultKey>:<from>-<to>`（`plan` 任务是 `plan:<projectId>@<projectRev>`）。同一个结果只会有一个任务。重复发布即幂等合并：只把发布方加进订阅者，不新建任务。
- **为什么要有 `plan` 任务**：结果键（共享键、流键）要在 Chrome 里算出 card plan（`__pcCardPlan`），再由服务端的 `card-cache.mjs` 算出来。页面算不了，而文档服务不做计算。所以发布方只发一个粗任务「给这一版项目做计划」，第一个认领它的节点算出 card plan 和预渲染集合，再把细任务发布回队列（`derivedFrom` 指向这个 `plan` 任务）。**这一点需要审核确认**，备选见第 8 节 Q1。
- 段长让长卡可以被多台节点并行做，又不至于把任务切得太碎。段长是节点发布细任务时的参数，文档服务不关心。

## 3. 任务的 JSON 结构

文档服务内存里的整张表：

```json
{
  "epoch": "b2f1c7",
  "tasks": {
    "snapshot:9f3a…e1:0-59": { "...": "见下" }
  },
  "byProject": { "proj-42": ["snapshot:9f3a…e1:0-59", "plan:proj-42@118"] }
}
```

单个任务：

```json
{
  "id": "snapshot:9f3a…e1:0-59",
  "kind": "snapshot",
  "tier": "shared",
  "resultKey": "9f3a…e1",
  "range": { "unit": "localFrame", "from": 0, "to": 59 },

  "source": {
    "projectId": "proj-42",
    "projectRev": 118,
    "publisher": { "kind": "editor", "id": "user:u1/page:tab-3" },
    "derivedFrom": "plan:proj-42@118",
    "publishedAt": 1790231200000
  },
  "input": {
    "clipId": "clip-7",
    "cardId": "particles",
    "entryKey": null
  },

  "weight": {
    "class": "heavy",
    "estMs": 42000,
    "frames": 60
  },
  "requires": {
    "codeVersion": "c0de5a…",
    "cardSources": { "particles": "builtin:12" },
    "transcode": false,
    "userCards": false,
    "graphCards": false,
    "belowDependent": false,
    "memoryMB": 900
  },
  "priority": 10,

  "state": "claimed",
  "version": 7,
  "claim": {
    "nodeId": "node:render-host-01",
    "token": 7,
    "claimedAt": 1790231260000,
    "leaseUntil": 1790231290000,
    "progress": { "done": 24, "at": 1790231275000 }
  },
  "attempts": 1,
  "lastError": null,
  "subscribers": ["user:u1/page:tab-3", "user:u2/page:tab-1"]
}
```

字段说明：

| 字段 | 谁写 | 含义 |
|---|---|---|
| `id` | 发布方 | 由内容决定，见第 2 节 |
| `source.*` | 发布方 | 任务来源：项目、项目版本、发布方身份、从哪个 `plan` 任务派生 |
| `input.*` | 发布方 | 节点做这件事需要的最小定位信息；项目本体按 `projectId@projectRev` 从文档服务取，素材从素材服务取，**任务不带字节** |
| `weight.class` | 发布方 | 计算重度：`light` / `medium` / `heavy`。由发布方按已有的成本记录（K1 的 `costs`）估；文档服务不算 |
| `weight.estMs` | 发布方 | 估计耗时，没有成本记录时为 `null` |
| `requires.*` | 发布方 | 能力要求，节点据此自己过滤（第 4.3 节） |
| `priority` | 发布方 | 整数，越大越先。例：AI 栏预览插队 100，锚帧 50，普通 10 |
| `state` | 文档服务 | `open` / `claimed` / `done` / `failed` |
| `version` | 文档服务 | 每次状态变化加一，乐观锁用 |
| `claim.token` | 文档服务 | 认领令牌，**单调递增**（取当时的 `version`），完成和续约都要带它；旧认领者拿着旧令牌的报告一律不作数 |
| `claim.leaseUntil` | 文档服务 | 租约到期时刻，只用文档服务自己的时钟 |
| `attempts` / `lastError` | 文档服务 | 失败计数；到上限（缺省 3）进 `failed` |
| `subscribers` | 文档服务 | 关心这个任务的发布方；完成通知只发给它们 |

内存上界：每项目最多 `MAX_TASKS_PER_PROJECT`（缺省 5000）个未完成任务；`done` 的任务通知发出后保留 `DONE_TTL`（缺省 10 分钟），供晚到的重复发布直接回「已完成」，然后删除。

## 4. 认领协议（走文档服务现有的 WebSocket 长连接）

### 4.1 消息

节点 → 文档服务：

| 消息 | 字段 | 说明 |
|---|---|---|
| `node.hello` | `nodeId`、`profile`、`capabilities`、`codeVersions`、`maxConcurrent`、`resume: [{id, token}]` | 连上（或重连）时报到；`resume` 用于重连后接续手里的认领 |
| `queue.watch` | `projects: [...]` 或 `"all"` | 订阅哪些项目的任务变化 |
| `task.claim` | `id`、`expectVersion`、`reqId` | 认领 |
| `task.progress` | `id`、`token`、`done` | 报进度，同时续约 |
| `task.complete` | `id`、`token`、`result: { ranges }` | 报完成（产物已在素材服务里收全之后） |
| `task.release` | `id`、`token`、`reason` | 主动放回（比如用户开始播放、节点要让路） |
| `task.fail` | `id`、`token`、`error`、`retryable` | 报失败 |

发布方 → 文档服务：

| 消息 | 字段 | 说明 |
|---|---|---|
| `task.publish` | `tasks: [...]` | 幂等发布；已存在就加订阅者；已是 `done` 就立即回 `task.done` |
| `task.unsubscribe` | `ids` 或 `projectRev` | 不再需要（比如项目换了版本）。没有订阅者且还是 `open` 的任务删除；`claimed` 的让它做完（结果按内容键寻址，别的版本可能还用得上），做完后不通知 |

文档服务 → 各方：

| 消息 | 发给谁 | 说明 |
|---|---|---|
| `queue.snapshot` | 刚 `watch` 的节点 | 当前所有 `open` 任务的摘要，带 `epoch` |
| `task.opened` / `task.taken` / `task.closed` | 所有 watch 了该项目的节点 | 增量：可认领了 / 被人认领了 / 完成或删除了 |
| `task.claimed` / `task.claim-rejected` | 认领者 | 认领结果（见 4.2） |
| `task.done` | 订阅者 | 完成通知，带 `resultKey` 和 `ranges`；页面据此更新本机的就绪索引，字节从素材服务取 |
| `task.lease-lost` | 原认领者 | 租约已被收回，停止并丢弃这个任务 |

### 4.2 乐观锁：比对再加锁

文档服务处理 `task.claim` 是单线程、不可打断的一步（Node 的事件循环里就是一次同步函数）：

```
t = tasks[id]
若 t 不存在            → claim-rejected { reason: "gone" }
若 t.state ≠ "open"    → claim-rejected { reason: "taken", state: t.state, version: t.version }
若 expectVersion ≠ t.version → claim-rejected { reason: "stale", version: t.version }
否则：
  t.version += 1
  t.state = "claimed"
  t.claim = { nodeId, token: t.version, claimedAt: now, leaseUntil: now + LEASE_MS, progress: null }
  回 claimed { id, token, leaseUntil, input, requires, source }
  向其它 watch 者广播 task.taken { id, version }
```

- 两个节点同时认领同一个任务：只有第一个到达的成功，第二个拿到 `taken`，换下一个。
- `expectVersion` 防的是「节点看到的是旧状态」：任务被收回又重新 `open` 之后，版本已经变了。节点拿旧快照去认领会被拒，要先按回包里的新版本刷新再决定。
- **令牌即栅栏**：`token` 单调递增。`progress`、`complete`、`release`、`fail` 都必须带当前令牌，令牌不等于 `t.claim.token` 的一律回 `lease-lost` 并忽略。租约被收回后原节点即使做完，也改不了任务状态。

### 4.3 节点按能力过滤（节点端逻辑，文档服务不参与）

节点在 `hello` 里报自己的能力，但**过滤在节点本地做**，文档服务照样把所有 `open` 任务的摘要推给它：

```json
{
  "profile": "browser",
  "capabilities": {
    "transcode": false,
    "userCards": false,
    "graphCards": false,
    "belowDependent": true,
    "streams": false,
    "memoryMB": 1500
  },
  "codeVersions": ["c0de5a…"],
  "maxConcurrent": 1
}
```

过滤规则（节点本地）：

1. `requires.codeVersion` 必须在 `codeVersions` 里，`requires.cardSources` 里每张卡的版本本机都有，否则不认领（语义：版本对不上的任务不认领）。
2. `kind: "stream"` 或 `requires.transcode` 需要本机转码能力：纯浏览器跳过。
3. `requires.userCards` / `graphCards`：纯浏览器跳过（一期只支持内置卡片）。
4. `weight.class`：纯浏览器只认 `light`、`medium`；本机 PC 在用户正在编辑时只认自己项目的任务和 `light`，闲时全认；独立渲染主机全认。这是各节点自己的策略表，可配置。
5. `requires.memoryMB` 超过本机可用内存的跳过。
6. `kind: "plan"` 需要 Chrome 和服务端的 `card-cache`：只有本机 PC 和独立渲染主机认。

挑选顺序：按 `priority` 降序，再按 `publishedAt` 升序，在排名前 K 个（缺省 K = 4）里随机取一个去认领。随机是为了避免所有节点同时抢同一个任务、互相撞出一串 `taken`。

### 4.4 节点侧的闲时门槛

- 本机 PC、纯浏览器：只在闲时认领（不在播放、不在拖动；复用现有的 `streamBusy` 判据）。开始播放时，手里的任务做完当前这一批（4 帧或 1 段）就 `task.release`，不强行做完整个任务。
- 同时在做的任务数不超过 `maxConcurrent`。
- 开工前先问素材服务这个结果键的这一段是不是已经有了（比如别的节点做过、或上一个认领者做完了却没来得及报），有了就直接 `complete`，不重做。

## 5. 容错

| 情形 | 处理 |
|---|---|
| **认领者 WebSocket 断开** | 文档服务给这个节点 `RECONNECT_GRACE_MS`（缺省 10 s）。宽限期内同一个 `nodeId` 重连、`hello.resume` 里带着 `{id, token}` 且令牌仍有效，就接续认领。宽限期过了，它名下所有 `claimed` 任务回 `open`：`version += 1`、`claim = null`、`attempts += 1`，广播 `task.opened` |
| **处理超时** | `LEASE_MS` 缺省 30 s。节点至少每 10 s 发一次 `task.progress` 续约（`leaseUntil = now + LEASE_MS`）。文档服务每 5 s 扫一遍，`claimed` 且 `now > leaseUntil` 的回 `open`，处理同上，并给原认领者发 `task.lease-lost` |
| **进度停滞** | 连续续约但 `progress.done` 在 `STALL_MS`（缺省 120 s）内不变，按超时处理。防的是「心跳还活着、渲染已经卡死」的节点 |
| **反复失败的任务** | `attempts` 到 `MAX_ATTEMPTS`（缺省 3）进 `failed`，通知订阅者；页面按兜底顺序处理这一层（最终占位符）。代码或卡片源码换了版本，发布方会发布新 id 的任务，不受旧 `failed` 影响 |
| **晚到的完成报告** | 令牌不对，回 `lease-lost`、不改状态。产物已经推到素材服务的话并不浪费：下一个认领者开工前查素材服务，会发现已经有了，直接 `complete` |
| **节点推产物推到一半就崩了** | 语义规定先推素材服务、收全之后才报完成；素材服务按内容哈希校验，半截的产物不算有。任务按超时回 `open` |
| **发布方断开** | 宽限期后移除它在所有任务上的订阅；没有订阅者的 `open` 任务删除，`claimed` 的让它做完（不通知） |
| **文档服务重启** | 队列在内存里，重启即清空，`epoch` 换新。各方重连时从 `hello` 回包里看到 `epoch` 变了：发布方把仍需要的任务重新 `publish`；节点手里的认领作废（`resume` 会被拒），但可以把当前这一批做完并推给素材服务，结果不会白做 |
| **两个节点在宽限期里都以为自己持有同一个任务** | 不会发生：宽限期内任务仍是 `claimed`，别人认领不到；宽限期过后原令牌失效 |

所有时刻只看文档服务自己的时钟，节点之间不需要对时。

## 6. 和现有代码怎么接

| 现在 | 接队列之后 |
|---|---|
| 页面防抖发 `POST /api/frames/preload` 给本机预渲染进程 | 页面向文档服务 `task.publish` 一个 `plan` 任务（本机预渲染进程作为节点，大多数时候会自己认领到它） |
| `preload()` 的后台那一趟按顺序做锚帧、控件快照、本地档、整场景、轨道流 | 认领 `plan` 任务的节点算出 card plan 和预渲染集合，按第 2 节切成细任务发布；锚帧所在的段 `priority` 调高 |
| 预渲染进程按会话分片的就绪索引（`ready-index.mjs`）+ `/ready` SSE | 本机预渲染进程保留它，服务本机页面；另外订阅本机项目任务的 `task.done`，把别的节点做的结果也并进就绪索引（产物字节从素材服务取） |
| 编辑器进程的会话登记表（方案 A）重放 preload | 离线或连不上文档服务时照旧走本机这一路（语义：离线时本机照常做） |
| 页面直连预渲染进程取快照和流的字节 | 产物入素材服务（A3b）之后改从素材服务取；这是本方案的前置条件 |

## 7. 风险与要求

- **像素一致性**：不同 GPU、驱动、Chrome 版本对 canvas 的栅格化结果可能有细微差别，同一个共享键在两台节点上产出的快照未必逐像素相同。语义已经把「代码和卡片源码一致」列为互相替用的前提。还要不要把 Chrome 版本、GPU 厂商也并进结果键，需要实测后定（第 8 节 Q3）。
- **代码版本固定**：`frameCode` 对整个 `src/` 取哈希并计入帧身份。独立渲染主机要同时持有多个代码版本（每个版本一个 worker 池），否则只能做与自己版本相同的项目。这是落地成本最大的一项。
- **节点信任**：结果键不是产物字节的哈希，恶意或出错的节点可以往某个结果键下推错画面。至少要做到：节点须经鉴权才能认领；产物带上认领令牌和节点 id 记账，发现问题时能按节点整批作废。
- **公平性**：多项目、多用户共用独立渲染主机时，靠发布方的 `priority` 不够。节点侧按项目轮转挑任务（同优先级里轮转）。
- **文档服务负载**：广播量约为「任务状态变化次数 × watch 节点数」。任务按段切，60 帧的段一般要几秒到几十秒，状态变化频率低。节点多了以后，改成按项目分组、只推摘要。

## 8. 待定问题（需要审核时拍板）

- **Q1 细任务由谁切**：推荐 A。
  - A（本方案）：`plan` 任务由节点认领、节点切分后回发布；
  - B：把 card plan 和结果键的计算搬到页面，由页面直接发布细任务。B 少一跳，但要把 `card-cache.mjs` 的键计算（依赖 Chrome 里的 `__pcCardPlan` 和卡片源码版本）移植到页面，改动面大。
- **Q2 纯浏览器节点要不要做别人项目的任务**：语义没有限制。但浏览器节点在用户自己的标签页里跑，为别的用户干活可能不合用户预期。建议缺省只认同一个用户的项目，可设置放开。
- **Q3 结果键要不要纳入渲染环境**：见第 7 节「像素一致性」。建议先实测两台不同 GPU 的机器对同一批卡的快照差异，再定。
- **Q4 租约与宽限期的缺省值**：`LEASE_MS = 30 s`、续约间隔 10 s、`RECONNECT_GRACE_MS = 10 s`、`STALL_MS = 120 s`、`MAX_ATTEMPTS = 3`。取值依据是：一段 60 帧的快照在本机 PC 上是几秒到几十秒，一段轨道流（15 帧）是秒级。需要以实测的分段耗时校准。

## 9. 落地顺序（审核通过后）

1. 文档服务骨架（`cloud-task.md` 第 6 步）与产物入素材服务（A3b）。这是前置条件，不在本方案内。
2. 队列本体：内存表、`publish` / `claim` / `progress` / `complete` / `release` / `fail`、租约扫描、断开宽限、`epoch`。纯逻辑，单测覆盖第 5 节每一行。
3. 本机预渲染进程作为节点：`plan` 任务的认领与切分；细任务的认领、续约、查素材服务去重、推产物、报完成；闲时门槛。
4. 页面：`preload` 改为发布 `plan` 任务；订阅 `task.done`，并入就绪索引。离线时回落到现在的本机路径。
5. 独立渲染主机形态：无编辑界面的预渲染进程、按代码版本的 worker 池、鉴权。
6. 纯浏览器节点：后台舞台认领快照任务。

端到端验证沿用 `docs/reports/REPORT-architecture-agent-prerender.md` 目标一第 3 节的测法，另加：多个节点同时抢同一批任务（断言每个任务恰好完成一次）、认领中途断网（断言宽限期后被别的节点接手）、文档服务重启（断言发布方重新发布后全部完成）。
