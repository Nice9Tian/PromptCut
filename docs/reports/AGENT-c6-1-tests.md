# C6.1 测试方报告（c6-1-tests）

分支 `claude/c6-1-tests`，从 `claude/c6-1`（契约 H 节定稿）拉出。只照契约 H 节（含主会话后补的 H.7）写测试，没看实现方分支 `claude/c6-1-impl` 和它的 worktree。

## 做了什么

| 文件 | 内容 |
|---|---|
| `server/test/docservice-channels.test.mjs`（新） | C1～C7，9 条。核心单元测试：直接 `createRouter`，注入假的 `write` / `buffered` / `close`，不起网络 |
| `server/test/docservice-backpressure.test.mjs`（新） | I1～I5，外加「C7 组装层」，共 6 条。真 WebSocket，端口 0，`autoTick: false` |
| `server/test/fake-raw-ws.mjs`（新假件） | 原始 TCP 上的最小 WebSocket 客户端：自己握手，能 `pause()` 停止读取 socket、`resume()` 恢复，读关闭帧 |

既有假件一个没改，生产代码一个没改。

### 用例与契约的对应

- **C1**：`subscribe` / `unsubscribe` / `publish` 的返回值；只有订阅者收到；重复订阅、未知连接回 `false`。
- **C2**：越界发布、越界订阅都抛错，包括 `roomy:` 对 `room`，以及没声明 `channels` 的模块；同前缀挂载抛错，已挂模块不受影响；卸载后前缀放出来。
- **C3**：断开清空订阅；同 id 重连不继承旧订阅。
- **C4**：同键只留最新一条、排到队尾；无键不合并；已写出的不参与合并；不跨连接合并；`publish` 带键也合并；`coalesced` 计数。
- **C5**：排到 `buffered >= highWater` 为止；队列非空时新消息不插队；按 H.7 第 4 条，重复 `drained` 不多写、不乱序。
- **C6**：
  - 1013 与 `backpressure`、`conn.backpressure { connId, pendingBytes }`、队列清空、之后的发送（`ctx.send`、`publish`、`router.send`）一律丢弃、不重复关闭、别的连接不受影响；
  - 另一条用例查 `CORE_DEFAULTS` 为 64 KiB / 1 MiB，不传选项时按它关闭。
- **C7**：
  - 核心层：`router.health()` 的 5 个字段、`describeConn` 的 `pendingBytes` / `subscriptions`；7 个保留字段名分别被模块占用时都抛错。
  - 组装层：`/healthz` 与 `describe()`，放在 backpressure 文件里，因为要起真服务。
- **I1 / I2**：共用一个场景（20 个项目 × 10 个节点；对 p00 做 500 轮「发布、认领、完成」）。
  - I1：190 个非 A 节点在 snapshot 之后收到 0 条消息。
  - I2：逐个任务核对投递次数：`task.opened` 10 次、`task.taken` 9 次（认领者自己不收）、`task.closed` 10 次。
- **I3**：8 KiB / 64 KiB。慢连接用原始 TCP 客户端，握手后 `pause()`。其余 199 个节点用内置 `WebSocket`，只计数、不留消息。
  - 断言 p95 < 50 ms、恢复读取后读到 1013 或连接已断、`backpressureCloses === 1`、`heapUsed` 增长 < 50 MB。
  - `heapUsed` 在 `gc()` 之后取，`gc` 用 `v8.setFlagsFromString('--expose-gc')` 拿到，不需要命令行参数。
- **I4**：
  - 独立主机先全量 `watch`，再切到摘要，订阅后立即回一条摘要。
  - 做 6 轮变化（新发布、认领、完成），每轮 `tick` 恰好 1 条摘要，内容与 `describe()` 一致（按 H.7 第 1、2 条的口径）；紧跟一次无变化的 `tick`，收到 0 条。
  - 全程不收单任务增量；`browser` 回 `forbidden`；没 hello 的回 `not-registered`；摘要切回 `mode: 'full'` 后重新收增量、不再收摘要。
- **I5**：
  - 慢节点先认领 `keep[0]`，再停止读取；往 `flood` 灌任务，直到它被 1013 关闭；
  - 撤掉 `flood`，在宽限期内重连并 `resume`：`resumed` 含 `keep[0]`；`queue.snapshot` 与 `describe()` 的 open 任务一致；令牌不变；别人的认领不受影响；接续后完成，发布方收到 `task.done`。

## 验证

### 语法检查

`node --check` 三个新文件，都通过。

### 在本分支上逐个跑新文件（实现还没合进来）

`node --test server/test/docservice-channels.test.mjs`：0 过、9 败。都是缺功能：`ctx.subscribe` 不存在、没有 `CORE_DEFAULTS`、没有 `drained` 等。

| 用例 | 结果 |
|---|---|
| C1 | 失败 |
| C2 | 失败 |
| C3 | 失败 |
| C4 | 失败 |
| C5 | 失败 |
| C6（1013 关闭） | 失败 |
| C6（缺省上限） | 失败 |
| C7（核心字段） | 失败 |
| C7（保留字段名） | 失败 |

`node --test server/test/docservice-backpressure.test.mjs`：2 过、4 败，约 7 s。

| 用例 | 结果 |
|---|---|
| C7 组装层 | 失败：`/healthz` 没有新字段 |
| I1 | **通过**：现有队列本来就按连接逐个发，隔离已成立 |
| I2 | **通过** |
| I3 | 失败：发了 4000 个任务，慢连接仍没被关 |
| I4 | 失败：没有摘要订阅 |
| I5 | 失败：灌了 3000 个任务，慢节点仍没被关 |

### 全量测试

`npm test`（在本 worktree）：退出码 1。

- 2309 条：2295 过、13 败、1 跳过。
- 13 条失败全部是上面这两个新文件（9 + 4）。
- 既有测试全过。

### 类型检查

`npx tsc -b --force`：退出码 0。

### 参考实现自检

在 scratchpad 里复制了 `server/docservice`、`server/render-queue`、测试与假件，按契约写了一份最小参考实现（router、service、ws、队列模块），没提交，用完已删。

- 两个新文件 15/15 过，连跑 3 次都稳定，backpressure 文件约 4 s。
- 既有的 5 个 `docservice*.test.mjs` 共 61 条照旧全过，包括 R2 守门。
- I3 实测：发到第 105 个任务时慢连接被关；正常节点 5970 次投递，p95 约 2.2 ms；`heapUsed` 增长 1.7 MB；慢连接恢复读取后读到关闭帧 `{ code: 1013, reason: 'backpressure' }`。
- 变异检查：往参考实现里逐个注入错误，每处都有测试抓到。

  | 注入的错误 | 抓到它的用例 |
  |---|---|
  | `drained` 不看 highWater | C5 |
  | 不做背压关闭 | C6、I3、I5 |
  | 不做合并 | C4、C7 |
  | 摘要每次 `tick` 都推 | I4 |
  | 指纹键写错 | I4 |
  | 不拦 `browser` | I4 |
  | 切到摘要后不停发单任务增量 | I4 |

## 没做成的

无。

## 对契约的疑点与更正建议

1. **摘要的数据来源**：H.3 写「来源是 `q.describe()`」，但 `queue.mjs` 的 `describe().tasks` 里没有 `priority`，也没有 `requires`，H.6 又不让改 `server/render-queue/`。
   - H.7 第 2 条说这两项「来自任务发布时」，那么模块只能自己在 `handle` 里截留 `task.publish` 记下来。
   - 建议契约写明这一点。另外，同 id 的重复发布不改变这两项。
2. **合并键怎么加到队列的出站消息上**：队列是用 `createRenderQueue({ send: service.send })` 在外面构造的，`send` 只有两个参数；H.7 第 5 条说合并键是模块内部的事。
   - 实现方只能在组装层的 `service.send` 里按消息类型补键，或者改变队列的接线方式。
   - 测试沿用既有接法。接法要是变了，既有测试里的 `send: service.send` 也要跟着变，建议契约明确。
3. **`publish` 的返回值**：进了出站队列、被合并的消息，是否算「实际投递」？测试按「算」写的（C4 断言合并时也回 1）。背压关闭之后的 `publish` 返回值没有断言。
4. **核心层的 H.4 字段从哪里取**：测试假定 `router.health()` 带 5 个新字段，`router.describeConn()` 带 `pendingBytes` / `subscriptions`。`describe().channels` 需要核心再给一个接口，契约没有命名，所以只在组装层断言。
5. **摘要的「内容相同」**：测试按「不含 `at`」理解，即无变化的 `tick` 推 0 条；有变化时断言恰好 1 条，契约原文是「至多 1 条」。
6. **切到摘要时的附带回包**：按 H.3 的做法，模块替客户端向队列发 `queue.watch { projects: [] }`，队列会给客户端回一条 `queue.snapshot { tasks: [] }`。测试容忍这条，只禁止 `task.opened` / `task.taken` / `task.closed`。建议契约说明这条回包是否应当吞掉。
7. **I3 的 `heapUsed` 门槛偏弱**：底层积压的字节在 socket 的 Buffer 里，算在 `arrayBuffers` / `external`，基本不进 `heapUsed`。
   - 真正拦住无界积压的是「1013 关闭」这条断言。
   - 测试在失败信息里顺带打印 `arrayBuffers` 的增长。建议以后把门槛改成 `heapUsed + arrayBuffers`。
8. **I3 的慢连接 watch 全部项目**：慢连接占 p00 的第 0 个节点位置，但 watch `'all'`，好尽快积压；其余 199 个节点只 watch 本项目。与 H.5 的字面「其余 199 个正常」一致。
9. **越界的 `unsubscribe`**：H.1 只说订阅、发布越界抛错，没说 `unsubscribe`，测试没有断言。
10. **背压关闭后、断开之前**：这条连接的 `pendingBytes` 该报多少，契约没说，测试也没断言。
