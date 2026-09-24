# 分布式预渲染：文档服务托管的拉取式任务队列（设计方案）

状态：**设计已审核通过**（2026-09-24），Q1～Q4 已定，见第 8 节。实现排在前置条件之后，另行下发指令再动工。

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

表里「结果键」一列写的是内容键；细任务实际用的结果键还要乘上环境指纹，见第 2.1 节。

- **任务 id 由内容决定**：`<kind>:<resultKey>:<from>-<to>`（`plan` 任务是 `plan:<projectId>@<projectRev>`）。同一个结果只会有一个任务。重复发布即幂等合并：只把发布方加进订阅者，不新建任务。
- **页面只发粗任务（已定，Q1）**：页面是轻量客户端，只发布一个 `plan` 任务「给这一版项目做计划」。第一个认领它的渲染节点在 Chrome 里算出 card plan（`__pcCardPlan`）、用服务端的 `card-cache.mjs` 算出结果键和预渲染集合，再把细任务切分、发布回队列（`derivedFrom` 指向这个 `plan` 任务）。页面不移植键的计算，文档服务也不做计算。
- **环境指纹进结果键（已定，Q3）**：细任务的结果键 = 内容键与环境指纹一起取哈希，见第 2.1 节。
- 段长让长卡可以被多台节点并行做，又不至于把任务切得太碎。段长是节点发布细任务时的参数，文档服务不关心。

### 2.1 环境指纹（已定，Q3）

不同硬件上，Canvas / WebGL 的字体微调（hinting）和抗锯齿有确定的像素级差异。不同环境渲出的连续帧拼在一起，画面会闪。所以设计上**不假设跨环境可以互相替用**，环境指纹直接进结果键。

- **环境指纹**：`envFingerprint = hash(os, gpuClass, chromeMajor)`。
  - `os`：`windows` / `macos` / `linux`；
  - `gpuClass`：GPU 基础类别，按厂商分 `nvidia` / `amd` / `intel` / `apple` / `software`（无硬件加速），不细到型号和驱动；
  - `chromeMajor`：渲染用的 Chrome 主版本。它不在用户列出的两项里，但栅格化同样取决于它，一并纳入。
  - 节点启动时算一次，在 `node.hello` 里上报。
- **结果键**：`resultKey = hash(contentKey, envFingerprint)`。
  - `contentKey`：今天的共享键、本地档键或流键；
  - 同一张卡在两种环境下是两个结果键、两个任务、两份产物，互不覆盖。
- **谁定指纹**：认领 `plan` 任务的节点把**自己的**指纹定为这一版项目的指纹。它切出的所有细任务的 `resultKey` 都按这个指纹算，并在 `requires.envFingerprint` 里写明，只有指纹相同的节点能认领（第 4.3 节规则 1）。
- **效果**：
  - 同一版项目里每一层的所有帧都出自同一种环境，页面贴的连续帧不会混环境；
  - 项目换版本时，页面按就绪索引的 `reset` 整层换，不会在一段里拼接。
- **代价**：并行度只在同指纹的节点之间展开；不同环境做过的结果不能复用。这是为画面稳定有意付出的代价。
- **对现有代码的影响**（M4 已落地，见 `render-queue-contract.md` E 节）：本机预渲染进程的结果键（共享键、本地档键、独立卡 PNG 缓存键、流键）都乘上了指纹，现有缓存整体换了一次键。本机预渲染进程的指纹在第一个预渲染间开起来时探测一次，整个进程不变。

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
    "userId": "user:u1",
    "tenantId": "tenant-team-a",
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
    "envFingerprint": "e7a0…",
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
| `source.userId` | 文档服务 | 产生这个任务的登录用户，由文档服务按发布方连接的凭证填写，发布方自报的不作数。由 `plan` 任务切出的细任务继承 `plan` 任务的 `userId`，不取切分节点的身份。纯浏览器节点的边界靠它（第 4.3 节规则 0） |
| `source.tenantId` | 文档服务 | 发布方凭证所属的团队 / 租户，同样按凭证填写；只用于本机 PC、独立渲染主机的授权范围，**不放宽**纯浏览器节点的边界 |
| `source.*`（其余） | 发布方 | 任务来源：项目、项目版本、发布方身份、从哪个 `plan` 任务派生 |
| `input.*` | 发布方 | 节点做这件事需要的最小定位信息；项目本体按 `projectId@projectRev` 从文档服务取，素材从素材服务取，**任务不带字节** |
| `weight.class` | 发布方 | 计算重度：`light` / `medium` / `heavy`。由发布方按已有的成本记录（K1 的 `costs`）估；文档服务不算 |
| `weight.estMs` | 发布方 | 估计耗时，没有成本记录时为 `null` |
| `requires.envFingerprint` | 切分细任务的节点 | 环境指纹，见第 2.1 节；`plan` 任务没有这一项 |
| `requires.*`（其余） | 发布方 / 切分细任务的节点 | 能力要求，节点据此自己过滤（第 4.3 节） |
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
| `node.hello` | `nodeId`、`profile`、`envFingerprint`、`capabilities`、`codeVersions`、`maxConcurrent`、`resume: [{id, token}]` | 连上（或重连）时报到；`resume` 用于重连后接续手里的认领。节点的租户由连接的凭证决定，不在消息里自报 |
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
若节点 profile 是 "browser" 且 t.source.userId ≠ 节点凭证的用户
                       → claim-rejected { reason: "forbidden" }
若 t.state ≠ "open"    → claim-rejected { reason: "taken", state: t.state, version: t.version }
若 expectVersion ≠ t.version → claim-rejected { reason: "stale", version: t.version }
否则：
  t.version += 1
  t.state = "claimed"
  t.claim = { nodeId, token: t.version, claimedAt: now, leaseUntil: now + LEASE_MS, progress: { done: null, changedAt: now } }
  回 claimed { id, token, leaseUntil, input, requires, source }
  向其它 watch 者广播 task.taken { id, version }
```

- 两个节点同时认领同一个任务：只有第一个到达的成功，第二个拿到 `taken`，换下一个。
- `expectVersion` 防的是「节点看到的是旧状态」：任务被收回又重新 `open` 之后，版本已经变了。节点拿旧快照去认领会被拒，要先按回包里的新版本刷新再决定。
- **令牌即栅栏**：`token` 单调递增。`progress`、`complete`、`release`、`fail` 都必须带当前令牌，令牌不等于 `t.claim.token` 的一律回 `lease-lost` 并忽略。租约被收回后原节点即使做完，也改不了任务状态。

### 4.3 节点按能力过滤

**纯浏览器节点的用户边界由文档服务把关（已定，Q2）**。这是权限检查，不是资源测算或分配：

- 纯浏览器节点只能看到、只能认领**当前登录用户自己产生的**任务（`source.userId` 等于节点凭证的用户）。同一团队、同一租户里其他用户的任务也不行。
- 文档服务推给它的 `queue.snapshot` 和增量消息只含这个用户的任务；别人的任务回 `forbidden`（见 4.2）。
- 不允许靠节点自己过滤来守这条边界：节点端代码跑在用户的标签页里，不可信。
- 理由有两条：
  - 杜绝隐私越权：别人的项目内容不会进你的浏览器；
  - 杜绝端侧算力被不可控地占用：你的浏览器不会替别人干活。
- 本机 PC 和独立渲染主机不受这一条限制；它们为谁干活按部署时的授权定（按 `tenantId`，见第 7 节「节点信任」）。

**其余能力过滤在节点本地做**。节点在 `hello` 里报自己的能力，文档服务把该用户（纯浏览器）或授权范围内（其它节点）所有 `open` 任务的摘要推给它：

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

过滤规则：

0. （文档服务把关，见上）纯浏览器节点只见当前登录用户自己的任务。
1. `requires.envFingerprint` 必须等于本机的环境指纹；`requires.codeVersion` 必须在 `codeVersions` 里；`requires.cardSources` 里每张卡的版本本机都有。任一不符都不认领（语义：环境或版本对不上的任务不认领）。`plan` 任务没有指纹要求，谁认领谁的指纹就是这一版的指纹（第 2.1 节）。
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
| **进度停滞** | 连续续约但 `progress.done` 在 `STALL_MS`（缺省 120 s）内不变，按超时处理。防的是「心跳还活着、渲染已经卡死」的节点。节点认领到任务、开工时先报一次 `progress(0)`，所以「一次进度都没报就卡死」的执行器同样落在这条规则里（节点照常续约时租约不会到期） |
| **反复失败的任务** | `attempts` 到 `MAX_ATTEMPTS`（缺省 3）进 `failed`，通知订阅者；页面按兜底顺序处理这一层（最终占位符）。代码或卡片源码换了版本，发布方会发布新 id 的任务，不受旧 `failed` 影响 |
| **晚到的完成报告** | 令牌不对，回 `lease-lost`、不改状态。产物已经推到素材服务的话并不浪费：下一个认领者开工前查素材服务，会发现已经有了，直接 `complete` |
| **节点推产物推到一半就崩了** | 语义规定先推素材服务、收全之后才报完成；素材服务按内容哈希校验，半截的产物不算有。任务按超时回 `open` |
| **发布方断开** | 宽限期后移除它在所有任务上的订阅；没有订阅者的 `open` 任务删除，`claimed` 的让它做完（不通知） |
| **文档服务重启** | 队列在内存里，重启即清空，`epoch` 换新。各方重连时从 `hello` 回包里看到 `epoch` 变了：发布方把仍需要的任务重新 `publish`；节点手里的认领作废（`resume` 会被拒），但可以把当前这一批做完并推给素材服务，结果不会白做 |
| **两个节点在宽限期里都以为自己持有同一个任务** | 不会发生：宽限期内任务仍是 `claimed`，别人认领不到；宽限期过后原令牌失效 |

所有时刻只看文档服务自己的时钟，节点之间不需要对时。

### 5.1 补充规则（2026-09-24 用户确认，原任务书第 7 节 C1～C6）

| 编号 | 规则 |
|---|---|
| C1 | `failed` 的任务和 `done` 一样保留 `DONE_TTL`：TTL 内重复发布回「已失败」，不重新打开；TTL 后删除，再发布就是新任务 |
| C2 | 主动放回（`task.release`）不算失败，`attempts` 不加 |
| C3 | 超时回收、断开回收、停滞回收和 `task.fail` 共用一个 `attempts`，到 `MAX_ATTEMPTS` 一律进 `failed` |
| C4 | 重连接续认领（`hello.resume`）只认认领它的那个 `nodeId`；别的节点拿着令牌也接续不了 |
| C5 | 发布方断开的宽限期与节点相同，用 `RECONNECT_GRACE_MS`（基线 10 s） |
| C6 | 入站消息格式不对回 `error`（`bad-message`），每项目未完成任务超上限回 `limit`，都不改状态；所有出站消息都带 `epoch` |

## 6. 和现有代码怎么接

| 现在 | 接队列之后 |
|---|---|
| 页面防抖发 `POST /api/frames/preload` 给本机预渲染进程 | 页面向文档服务 `task.publish` 一个 `plan` 任务（本机预渲染进程作为节点，大多数时候会自己认领到它） |
| `preload()` 的后台那一趟按顺序做锚帧、控件快照、本地档、整场景、轨道流 | 认领 `plan` 任务的节点算出 card plan 和预渲染集合，按第 2 节切成细任务发布；锚帧所在的段 `priority` 调高 |
| 预渲染进程按会话分片的就绪索引（`ready-index.mjs`）+ `/ready` SSE | 本机预渲染进程保留它，服务本机页面；另外订阅本机项目任务的 `task.done`，把别的节点做的结果也并进就绪索引（产物字节从素材服务取） |
| 编辑器进程的会话登记表（方案 A）重放 preload | 离线或连不上文档服务时照旧走本机这一路（语义：离线时本机照常做） |
| 页面直连预渲染进程取快照和流的字节 | 产物入素材服务（A3b）之后改从素材服务取；这是本方案的前置条件 |

## 7. 风险与要求

- **像素一致性**：已按 Q3 的决议处理，环境指纹进结果键（第 2.1 节），不同环境的结果不互相替用。剩下的风险在指纹粒度：同一 `gpuClass` 里不同型号、不同驱动之间仍可能有差异。落地后如果实测看到同指纹之间闪烁，再把指纹细化（例如加驱动大版本）。
- **代码版本固定**：`frameCode` 对整个 `src/` 取哈希并计入帧身份。独立渲染主机要同时持有多个代码版本（每个版本一个 worker 池），否则只能做与自己版本相同的项目。这是落地成本最大的一项。
- **节点信任**：结果键不是产物字节的哈希，恶意或出错的节点可以往某个结果键下推错画面。至少要做到：节点须经鉴权才能认领；产物带上认领令牌和节点 id 记账，发现问题时能按节点整批作废。
- **公平性**：多项目、多用户共用独立渲染主机时，靠发布方的 `priority` 不够。节点侧按项目轮转挑任务（同优先级里轮转）。
- **文档服务负载**：广播量约为「任务状态变化次数 × watch 节点数」。任务按段切，60 帧的段一般要几秒到几十秒，状态变化频率低。节点多了以后，改成按项目分组、只推摘要。

## 8. 已定的决议（2026-09-24 用户审核）

- **Q1 细任务由谁切**：页面是轻量客户端，只发布粗粒度的 `plan` 任务。第一个认领它的渲染节点算 card plan、算结果键，把细任务切分后发布回队列（第 2 节）。不把键的计算移植到页面。
- **Q2 纯浏览器节点的边界**：只处理**当前登录用户自己产生的**任务，禁止任何跨用户调度，同一团队、同一租户的其他用户也不行。由文档服务按凭证把关，不靠节点自己过滤（第 4.3 节规则 0、第 4.2 节 `forbidden`）。理由：杜绝端侧算力被不可控地占用，杜绝隐私越权。
- **Q3 环境指纹**：不等实测，设计上直接把环境指纹（OS、GPU 基础类别，另加 Chrome 主版本）纳入结果键的哈希因子，同时写进 `requires.envFingerprint` 强制约束（第 2.1 节）。理由：Canvas / WebGL 的字体微调和抗锯齿在不同硬件上有确定的像素差，不同硬件渲的连续帧拼接会闪。
- **Q4 超时与续租参数**：接受下表的缺省值作为工程基线。实现第一版可以写成常量，**之后要抽成可由环境变量配置的调优参数**（变量名先定在下表，实现时照用）。

| 常量 | 基线值 | 以后的环境变量 | 含义 |
|---|---|---|---|
| `LEASE_MS` | 30 000 | `PROMPTCUT_QUEUE_LEASE_MS` | 认领租约时长 |
| `RENEW_INTERVAL_MS` | 10 000 | `PROMPTCUT_QUEUE_RENEW_MS` | 节点续约（`task.progress`）间隔上限 |
| `SWEEP_INTERVAL_MS` | 5 000 | `PROMPTCUT_QUEUE_SWEEP_MS` | 文档服务扫过期租约的间隔 |
| `RECONNECT_GRACE_MS` | 10 000 | `PROMPTCUT_QUEUE_GRACE_MS` | 断开后接续认领的宽限期 |
| `STALL_MS` | 120 000 | `PROMPTCUT_QUEUE_STALL_MS` | 进度不动多久按超时处理 |
| `MAX_ATTEMPTS` | 3 | `PROMPTCUT_QUEUE_MAX_ATTEMPTS` | 失败几次进 `failed` |
| `DONE_TTL` | 600 000 | `PROMPTCUT_QUEUE_DONE_TTL_MS` | 完成的任务留多久（供晚到的重复发布直接回「已完成」） |
| `MAX_TASKS_PER_PROJECT` | 5000 | `PROMPTCUT_QUEUE_MAX_TASKS` | 每项目未完成任务上限 |
| 快照段长 | 60 帧 | `PROMPTCUT_QUEUE_SNAPSHOT_SPAN` | 切分快照细任务的段长 |
| 流段数 | 8 段 | `PROMPTCUT_QUEUE_STREAM_SEGMENTS` | 切分轨道流细任务的段数（每段 15 帧） |
| 候选数 K | 4 | `PROMPTCUT_QUEUE_PICK_K` | 节点在前 K 个候选里随机挑 |

取值依据：一段 60 帧的快照在本机 PC 上是几秒到几十秒，一段轨道流（15 帧）是秒级。抽成环境变量之后，按实测的分段耗时校准。

## 9. 落地顺序（另行下发指令后）

1. 文档服务骨架（`cloud-task.md` 第 6 步）与产物入素材服务（A3b）。这是前置条件，不在本方案内。
2. 队列本体：内存表、`publish` / `claim` / `progress` / `complete` / `release` / `fail`、租约扫描、断开宽限、`epoch`。纯逻辑，单测覆盖第 5 节每一行。
3. 本机预渲染进程作为节点：`plan` 任务的认领与切分；细任务的认领、续约、查素材服务去重、推产物、报完成；闲时门槛。
4. 页面：`preload` 改为发布 `plan` 任务；订阅 `task.done`，并入就绪索引。离线时回落到现在的本机路径。
5. 独立渲染主机形态：无编辑界面的预渲染进程、按代码版本的 worker 池、鉴权。
6. 纯浏览器节点：后台舞台认领快照任务。

端到端验证沿用 `docs/reports/REPORT-architecture-agent-prerender.md` 目标一第 3 节的测法，另加：多个节点同时抢同一批任务（断言每个任务恰好完成一次）、认领中途断网（断言宽限期后被别的节点接手）、文档服务重启（断言发布方重新发布后全部完成）。
