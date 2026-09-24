# C6.1 实现方报告（c6-1-impl）

- 分支：`claude/c6-1-impl`（从 `claude/c6-1` 的 80fc64c 拉出）
- 依据：`docs/plan/render-queue-contract.md` H 节（H.1～H.4），G 节（G.2、G.3、G.11、G.12）
- 改动文件（只动 H.6 分给 impl 的四个）：`server/docservice/router.mjs`、`service.mjs`、`ws.mjs`、`modules/render-queue.mjs`
- 没改：`server/render-queue/`、`server/render-node/`、`server/test/` 下任何文件、`main.mjs`

## 进度

- [x] H.1 频道 API
- [x] H.2 出站队列与背压
- [x] H.3 队列模块：合并键、摘要订阅
- [x] H.4 可观测
- [x] 自测（scratch 脚本，不提交）
- [x] 基线：tsc、npm test

## 做了什么

### `router.mjs`（核心，通用）

- 导出 `CORE_DEFAULTS = { HIGH_WATER_BYTES: 64 KiB, MAX_PENDING_BYTES: 1 MiB }`。
- `createRouter` 新增 `buffered`、`close`、`highWaterBytes`、`maxPendingBytes`。`buffered` 缺省 `() => 0`，`close` 缺省空函数，所以只给 `write` 的旧用法（R1、R6 直接调 `createRouter`）行为不变。
- **出站队列**（H.2）：每条连接一个。
  - 队空且 `buffered < highWaterBytes` 就直接 `write`，否则进队。
  - 带 `coalesceKey` 的消息进队时，同键的旧项标作废，新项追加到队尾，`coalesced` 加一。
  - `router.drained(connId)` 按顺序写，写到队空，或者 `buffered` 又到高水位为止。
  - 进队后若「队里字节 + buffered」> `maxPendingBytes`：先清空，再记 `conn.backpressure { connId, pendingBytes }`，`backpressureCloses` 加一，最后 `close(connId, 1013, 'backpressure')`。之后发给这条连接的一律丢弃。
- **频道**（H.1）：
  - 模块可选字段 `channels: string[]` 声明前缀，挂载时校验格式；两个模块声明同一前缀就抛错。
  - `ctx.subscribe / unsubscribe / publish` 只认本模块前缀，频道名不合法或越界都抛 `Error`。
  - `publish` 只序列化一次，再逐个交给订阅者的出站队列，返回被接受（写出或进队）的连接数。
  - 连接断开时清掉它的全部订阅；卸载模块时清掉这个模块前缀下的全部订阅。
  - 模块卸载后，它的 `ctx.subscribe` 回 `false`，`ctx.publish` 回 0。
- **可观测**（H.4）：
  - `health()` 加 `channels`、`subscriptions`、`pendingBytesMax`、`coalesced`、`backpressureCloses`；
  - `describeConn` 加 `pendingBytes`、`subscriptions`（排好序）；
  - 新增 `router.channels()`，返回「频道 → 订阅数」；
  - 这些字段名都加进了保留名，模块占用时挂载抛错。
- R2 守门词一个没出现，注释里也没有（`grep -F` 逐词查过）。

### `ws.mjs`

- `WsConnection` 加 `get bufferedAmount()`（取 `socket.writableLength`），并新增 `'drain'` 事件。
- `'drain'` 有两个来源：
  - 转发 socket 自己的 `drain`；
  - 每帧的写回调里，如果 `writableLength === 0` 且 `!writableNeedDrain`，也补发一次。原因见「契约疑点」第 5 条。

### `service.mjs`（组装层）

- 新选项 `highWaterBytes`、`maxPendingBytes`，缺省取 `CORE_DEFAULTS`。
- 连接接上核心：`buffered` → `ws.bufferedAmount`，`close` → `ws.close(code, reason)`，`ws.on('drain')` → `router.drained`。
- **旧接口 `send`**（队列的 `send` 接在这里）：真队列挂着时，先调队列模块的 `outbound(connId, message)` 取发送选项，再交给 `router.send`；`outbound` 返回 `null` 的消息不发。占位模块没有 `outbound`，照常发。
- `describe()` 多出 `channels: { [channel]: 订阅数 }`，覆盖 `/healthz` 里同名的数字字段。这和 `modules` 一样，两处形状不同（G.12 第 5 条的先例）。

### `modules/render-queue.mjs`

- **合并键**：`outbound` 给 `task.opened` 的键取 `task.id`，给 `task.taken`、`task.closed` 的键取 `id`，都是 `'task:' + id`；其余消息不带键。
- **摘要订阅**：`queue.watch` 带 `mode: 'summary'` 时由模块自己处理。
  - 校验顺序：`projects` 不是 `'all'` → `bad-message`；这条连接没有合法的 `node.hello` 记录 → `not-registered`；`profile` 是 `browser` → `forbidden`。
  - 通过后：
    1. 替它向队列发 `queue.watch { projects: [] }`，reqId 取一个特殊值，队列回的 `queue.snapshot` 由 `outbound` 吞掉；
    2. 订阅 `queue-summary:all`；
    3. 立即回一条 `queue.summary`，带原 reqId。
  - `mode` 缺省或是 `'full'`：照旧交给队列。消息合法、而这条连接正在摘要订阅时，先退订摘要频道。
  - `mode` 是其它值 → `bad-message`。
  - 模块自己回的错误照队列的格式（`makeMessage`）带 `epoch`。
- **推送**：
  - 每次 `tick` 先 `q.tick()`，再算一遍摘要；
  - `projects` 的 JSON 与上次发布的不同才 `publish`，带 `coalesceKey: 'queue-summary'`；
  - 没有摘要订阅者时不算，并把「上次」清空。
- **摘要内容**：
  - 计数来自 `q.describe()`：只列有 open 或 claimed 任务的项目，按 `projectId` 升序；
  - `topPriority` 和 `openByFingerprint` 要的 `priority`、`requires.envFingerprint` 不在 `q.describe()` 里（见疑点 2）。模块在入站 `task.publish` 时记下这两项，以队列回包 `task.published` 里 `created: true` 的为准，所以过了 TTL 重建的任务会换成新值；
  - 每次算摘要时，删掉 `describe()` 里已经没有的任务；没人订阅时，记录多到一定程度也修剪一次。
- 模块声明 `channels: ['queue-summary']`。

## 验证

### 类型检查

```
npx tsc -b --force        → exit 0，零错误
```

### 全量测试

```
npm test                  → exit 0
ℹ tests 2294 / pass 2293 / fail 0 / skipped 1
```

唯一的跳过是「集成:/api/cards/layout 对真实项目返回整数框」，原因是 `SKIP: http://127.0.0.1:5190 上没有 dev server`，即允许的那一条。

指定的既有测试都一字未改、全过：`docservice.test.mjs`、`docservice-router`、`docservice-auth`、`docservice-endpoints`、`render-node-ws`、`render-node-deps`、`render-queue-*`（fault / inproc / protocol / state）、`card-lock-*`（node / pipeline / queue）。

单独跑这组文件时共 185 条，184 过。没过的 1 条是 `card-lock-pipeline`，原因是单跑时没加 `--experimental-test-module-mocks`。`npm test` 带这个参数，加上后这 21 条全过，与本改动无关。

### G0-R

没跑。本阶段不碰渲染、卡片、导出和预渲染路径，按 `verification.md` 不在必跑范围内。

### 自测（scratch，不提交）

- 脚本：`<scratchpad>/c61-selftest.mjs`、`<scratchpad>/c61-healthz.mjs`
- 端口一律为 0，不碰 5190～5192。
- 命令：`node --expose-gc c61-selftest.mjs`，exit 0，结果 **10/10 通过**。

输出：

```
     排空顺序 2,3,4,5,6
ok   U1 合并：积压时同键只留最新一条且排到队尾；无键不合并；coalesced 计数
     第一次排空写 3 条，其余在后续 drained 里按序写完
ok   U2 排空：按顺序写到 buffered 又到高水位为止，下一次 drained 接着写
ok   U3 背压：队列 + buffered 超过上限 → close(1013)、清空、之后丢弃、backpressureCloses+1、日志
ok   U4 频道：订阅、重复订阅、发布计数、前缀越界抛错、同前缀挂载抛错、断开清订阅、卸载清订阅
ok   U5 保留字段：模块的 health / describeConn 用了 H.4 字段名 → 挂载抛错
ok   U6 卸载模块：它前缀下的频道订阅清掉
ok   U7 队列模块 outbound：task.opened / taken / closed 带 task:<id> 键，其余不带
     发了 80 条（每条约 4 KB）后触发背压，用时 3 ms；日志 {"connId":"conn-2","pendingBytes":68624}
     heapUsed 增长 1.5 MB
     慢连接恢复读取后收到 66 帧，关闭帧 1013 backpressure；socket 已关 true
     正常连接按序收到全部 80 条
     healthz 字段：channels={"blast:all":1} pendingBytesMax=0 coalesced=0 backpressureCloses=1
ok   W1 慢连接（原始 TCP，握手后不读）被 1013 关闭；正常连接全收到；heap 增长小
     10 轮（每轮 20 个项目各发一个任务，tick 两次）每轮收到的摘要条数：1,1,1,1,1,1,1,1,1,1
     切回全量：snapshot 201 条，之后收到 task.opened，不再收摘要
ok   W2 摘要订阅：每个 tick 至多一条、内容与 describe() 一致、不收单任务增量、browser 回 forbidden、全量 / 摘要切换
     节点连接排空后收到：node.welcome: | queue.snapshot: | task.closed:snapshot:kk:0-29 | task.opened:snapshot:kk2:0-29
ok   W3 队列经 service.send 的增量在慢连接上合并（task:<id> 键），coalesced 计数增加

10/10 通过
```

要求的三项对应如下：

- **合并与排空的顺序**：U1、U2、W3。
  - U1：键 a 先进队、后被新值顶掉，新值排到队尾，排空顺序是 2、3、4、5、6；
  - W3：真队列经 `outbound` 发出，节点连接积压时 `task.opened` 被同 id 的 `task.closed` 顶掉。
- **慢连接被 1013 关闭**：W1。
  - 真 WebSocket，`highWaterBytes` 8 KiB、`maxPendingBytes` 64 KiB；
  - 原始 TCP 客户端握手、发一条订阅后 `pause()` 不读；
  - 结果：服务端记 `conn.backpressure`，恢复读取后读到关闭帧 1013 `backpressure`，socket 被关；正常连接按序收全；heap 增长 1.5 MB。
- **摘要每个 tick 至多一条**：W2。
  - 20 个项目持续变化，每轮连 tick 两次，每轮恰好 1 条；内容不变时 tick 0 条；
  - 计数与 `describe()` 逐项一致；摘要连接收不到任何单任务增量；
  - 静默 watch 的 `queue.snapshot` 没有漏给客户端；`browser` 回 `forbidden`，未注册回 `not-registered`；
  - 切回全量后收 snapshot 与增量，不再收摘要。

`c61-healthz.mjs` 的输出（`/healthz` 与 `describe()` 的 H.4 字段）：

```
healthz {"ok":true,"service":"promptcut-docservice","uptimeMs":130,"connections":1,"protocol":"promptcut.v1","modules":["render-queue"],"channels":1,"subscriptions":1,"pendingBytesMax":0,"coalesced":0,"backpressureCloses":0,"queue":true,"publishers":0,"nodes":1,"epoch":"e-h"}
describe.channels {"queue-summary:all":1}
describe.conns[0] {"connId":"conn-1",...,"pendingBytes":0,"subscriptions":["queue-summary:all"],"roles":["node"],...}
```

## 契约疑点与更正建议（均按最保守读法做了）

1. **队列的 `send` 不经过模块**。
   - 问题：H.3 说队列经 `send` 发出的三种消息带合并键，但队列的 `send` 由调用方接到 `service.send`（`main.mjs` 和各测试都这么写），模块拦不到。
   - 做法：旧接口 `service.send` 在真队列挂着时，先问队列模块的 `outbound(connId, message)` 要发送选项。`outbound` 不是 G.3 的模块接口，只给组装层的外观用。合并键的具体取值只写在队列模块里，核心不认识。
   - 影响：调用方如果把队列的 `send` 接到别处，就没有合并，但正确性不受影响。
   - 建议：H.3 补一句写明这种接法。
2. **`q.describe()` 没有 `priority` 和 `requires`**。
   - 问题：H.3 说摘要「来源是 `q.describe()`」，但 `topPriority`、`openByFingerprint` 要的这两项不在里面，而本阶段不许改 `server/render-queue/`。
   - 做法：计数取自 `describe()`；这两项由模块从入站 `task.publish` 记下，以 `task.published` 回包里 `created: true` 的为准。
   - 建议：以后让队列的 `describe().tasks[i]` 带上 `priority` 和 `envFingerprint`，模块就不必另记一份。
3. **切到摘要时用的是空数组**。队列的 `queue.watch` 校验收空数组（`messages.mjs` 的 `strArray` 不拒空），所以用的是 `projects: []`，**不是**「不存在的项目 id」。它的 `queue.snapshot` 回包靠特殊 reqId 由 `outbound` 吞掉。
4. **摘要只列有 open 或 claimed 任务的项目**。
   - 做法：只剩 done / failed 任务的项目不出现。
   - 问题：H.3 没说零计数的项目列不列。如果测试方从 `describe().tasks` 按项目全量分组，会多出 `open: 0, claimed: 0` 的行，两边对不上。
   - 建议：H.3 写明，或按测试方的读法再定。
5. **`drain` 的补发**。
   - 问题：socket 自己的高水位是 16 KiB，测试给的 `highWaterBytes` 是 8 KiB。积压在 8～16 KiB 之间时，`write` 一直返回 true，socket 永远不会发 `drain`，核心的出站队列就卡住。
   - 做法：`ws.mjs` 在写回调里看到缓冲归零、且 socket 不会自己发 `drain` 时，补发一次。可能重复，但重复无害。
   - 建议：H.2 补一句写明 `drain` 的这层含义。
6. **`channels` 两处形状不同**：`/healthz` 里是数字（频道数），`describe()` 里是对象，照 G.12 第 5 条 `modules` 的先例。
7. **H.3 没写的输入，都回 `bad-message`**：
   - 摘要订阅的 `projects` 不是 `'all'`；
   - `mode` 不是 `'full'` 或 `'summary'`。
8. **「发过 `node.hello`」怎么判断**：按模块自己的角色记录（有合法 hello 就算），不看队列里这个 nodeId 眼下是否被别的连接顶替。
9. **立即回的那条 `queue.summary`**：
   - 它是回包，带 reqId、不带合并键，也不更新「上次发布的内容」。所以新订阅者在下一个 tick 可能再收到一条内容相同的摘要。
   - 这样处理，是为了不让别的订阅者漏掉变化。每个 tick 至多一条仍然成立。
10. **`publish` 的返回值**：数的是被接受（直接写出或进队）的连接。如果这一次进队触发了背压关闭，这条连接不计入。

## 没做成的

无。
