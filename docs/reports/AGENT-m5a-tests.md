# M5a 测试方报告（tests）

分支 `claude/rq-m5a-tests`（基于 `claude/rq-m5a` 的 b17c50a），worktree `.worktrees/rq-m5a-tests`。
依据：`docs/plan/render-queue-contract.md` G 节（G.8 探针、G.9 用例表），以及写测试期间主会话下发的 G.11、G.12 裁定。
只照契约写，没有看 `claude/rq-m5a-svc`、`claude/rq-m5a-net` 的代码和 worktree。

## 做了什么

| 文件 | 内容 |
|---|---|
| `server/test/docservice-router.test.mjs`（新） | R1、R2、R3、R5、R6、R7，共 12 条 |
| `server/test/docservice-auth.test.mjs`（新） | A1～A6，共 11 条 |
| `server/test/docservice-endpoints.test.mjs`（新） | E1～E8，共 12 条 |
| `server/test/render-node-ws.test.mjs`（新） | T1～T9，共 15 条 |
| `server/test/fake-ws-kit.mjs`（新假件） | 四个测试和探针共用：WebSocket 客户端、原始 TCP 握手、可控 TCP 代理（断开 / 拒连 / 换目标）、真实计时器的睡眠执行器、造 snapshot 任务、随机令牌 |
| `scripts/probes/render-queue-e2e.mjs`（新） | G.8 端到端探针 |
| `scripts/probes/render-queue-proxy.mjs`（新） | G.8 TCP 故障代理 |
| `scripts/probes/ws-client-test.mjs`（改） | 从 `PROMPTCUT_CLUSTER_TOKEN` 读令牌按 G.5 携带；断言子协议只回显 `promptcut.v1`、`/healthz` 有 `protocol` 与 `modules`、带 `epoch`、不含令牌 |

新增用例共 **50 条**，每张表的每一行至少一条；测试名都以编号开头。被测模块一律动态 `import`，模块缺失时各条用例分别失败、原因写明，不会整文件崩掉。既有假件一个没改。

## 每条测什么、当前分支上的结果

当前分支还没有实现，除 1 条外全部失败，失败原因都是「实现缺失」这一类，没有测试自身的错误（另见下文「用参考实现自检」）。

### docservice-router（12 条：1 过、11 败）

| 编号 | 测什么 | 当前结果 |
|---|---|---|
| R1（组装层） | 示例模块 `text.`（`text.count` → `text.counted { lines, chars }`）和真队列同时在线；同一连接交替发两种消息，各自回包正确；模块只见到 `text.*`；另一条连接收不到队列消息；核心不给模块消息补 `epoch`；`describe()` 合进两边的字段 | 失败：`createDocService` 还不认 `modules`，`text.count` 回 `error` |
| R1（路由核心） | `createRouter` 分派、`ctx.send` 经 `write` 发出、`describeConn` / `health` 合并、发给已断开连接静默丢弃 | 失败：`router.mjs` 不存在 |
| R2 | `router.mjs`、`ws.mjs` 源码里没有 `render-queue`、`modules/`、`task.`、`node.hello`、`publisher`、`queue` | 失败：`router.mjs` 不存在（现有 `ws.mjs` 本身是干净的） |
| R3（路由核心） | 类型冲突三种情形（精确名相同；精确名落在前缀里，两个方向；前缀互相包含，两个方向）、模块名重复、一个模块里只要有一个冲突就整个不挂，都在挂载时抛错；已挂模块照常，没挂上的类型回 `unsupported` | 失败：`router.mjs` 不存在 |
| R3（组装层） | 字段冲突：`describeConn` / `health` 与核心字段（`connId`、`principal`、`ok`、`modules`）重名、与已挂模块字段（`textSeen`、`textCounted`、队列的 `roles`、`epoch`）重名，以及与队列类型冲突（`task.`、`node.hello`），都抛错；之后已挂模块照常 | 失败：还没有 `service.mount` |
| R5 | `handle` 同步抛出、返回被拒绝的 Promise → `error { reason: 'internal', reqId }`，`detail` 不含消息原文；连接不断，同模块别的消息、别的模块、队列都照常；日志 `module.error { module, type, message }` | 失败：`boom.*` 回 `unsupported` |
| R6（组装层） | `mount` 返回卸载函数；挂载时对已有连接调 `connect`、卸载时调 `disconnect`；卸载后回 `unsupported`，`/healthz.modules` 里没有；可以再挂 | 失败：没有 `service.mount` |
| R6（队列） | `mountRenderQueue` 的卸载函数卸下后，`node.hello` / `queue.watch` / `task.publish` 回 `queue-unavailable`，角色清空，`/healthz` 旧字段回 `false/0/0`，可以再挂新队列 | **通过**（现有行为已满足） |
| R6（路由核心） | 不是 JSON、没有 `type`、不是对象 → `bad-message`；没人认领 → `unsupported`（带 `reqId`）；卸载后回 `unsupported` | 失败：`router.mjs` 不存在 |
| R7（/healthz） | 有 `ok`、`service`、`uptimeMs`、`connections`、`protocol === 'promptcut.v1'`、`modules` 数组；没挂队列时旧字段 `queue:false, publishers:0, nodes:0`；挂上后 `epoch === queue.epoch`、计数对；模块 `health` 字段平铺合入 | 失败：没有 `protocol` |
| R7（describe） | `conns[i]` 含核心四字段 + 队列模块的 `roles` / `publisherId` / `node` + 别的模块字段；`modules` 是 `{ 名字: describe() ?? null }`，键与 `/healthz.modules` 一致 | 失败：没有模块字段 |
| R7（节拍） | `autoTick: false` 不起计时器；`service.tick(name)` 只调一个模块、`tick()` 调全部；`autoTick` 缺省按 `tickMs` 起 | 失败：没有 `service.tick` |

### docservice-auth（11 条：全败）

| 编号 | 测什么 | 当前结果 |
|---|---|---|
| A1（握手） | 令牌模式下：不带子协议、只带 `promptcut.v1`、令牌错、只带令牌项、令牌被截短 → 都是 401，不建连接 | 失败：`auth.mjs` 不存在 |
| A1（模块） | `createClusterAuth` 各种情形回 `null` / principal；`protocolFor`；`PROTOCOL`；`isLoopbackHost`（`127.0.0.1`、`::1`、`localhost` 真，`0.0.0.0`、`::`、局域网地址、空串假）；`checkTokenFormat`（32 与 256 边界、`=`、空格、空串、`undefined`） | 失败：同上 |
| A2 | 令牌对 → 101，`Sec-WebSocket-Accept` 正确，`Sec-WebSocket-Protocol` 恰好是 `promptcut.v1`，响应头里没有令牌；两项顺序反过来也一样；Node 内置 `WebSocket` 连上后 `ws.protocol === 'promptcut.v1'` | 失败：同上 |
| A3 | principal 为 `{ cluster, cluster }`；`hello` 和 `task.publish` 里自报的 `userId` / `tenantId`（含 `source` 里的）不起作用，watch 者看到的任务 `source.userId === 'cluster'` | 失败：同上 |
| A4（握手） | 匿名模式：不带子协议 → 101 且不回 `Sec-WebSocket-Protocol`；带 `promptcut.v1` → 回显；带随便的令牌项也照样通过、只回显 `promptcut.v1`；旧客户端 `ws.protocol === ''`；principal 是匿名 | 失败：同上 |
| A4（模块） | 匿名模式 `authenticate` 回匿名，`protocolFor` 只在给了 `promptcut.v1` 时回它 | 失败：同上 |
| A5 | 拒、过各试三轮：注入日志、标准输出与标准错误（测试期间截获）、`describe()`、`/healthz` 里都没有令牌原文（对的和错的都查）；`auth.reject` 恰好 9 条，`reason` 覆盖 `no-protocol` / `no-token` / `bad-token`，都带 `remote` | 失败：同上 |
| A6（非回环无令牌） | 子进程 `main.mjs`，`HOST=0.0.0.0`、不设令牌 → 8 s 内退出码 1，输出含 `token-required` 和 `config.error` | 失败：现在的 `main.mjs` 照常起来（8 s 后被测试杀掉） |
| A6（令牌格式错） | 令牌 `short-token!` → 退出码 1、`bad-token-format`，输出里没有令牌原文 | 失败：同上 |
| A6（回环无令牌） | `HOST=127.0.0.1`、`PORT=0` → 打出 `listen` 行，`/healthz` 的 `ok`、`protocol`、`queue`、`modules` 正常，匿名握手 101 | 失败：`/healthz` 没有 `protocol` |
| A6（合法令牌） | 令牌模式：只带 `promptcut.v1` → 401，带令牌 → 101 且回显；输出里没有令牌 | 失败：现在不看令牌，回 101 |

子进程都用端口 0，环境变量里先删掉 `PROMPTCUT_CLUSTER_TOKEN` 等四个再按用例设；每条有 20 s 总超时，没退出就杀掉。

### docservice-endpoints（12 条：全败，原因都是 `modules/endpoints.mjs` 不存在）

| 编号 | 测什么 |
|---|---|
| E1 | 登记后，订阅了该 `kind` 的连接收到恰好一条全量 `service.endpoints`，项为 `{ announcerId, kind, urls, meta, since: 注入的 now }`；没订阅的、登记方自己都收不到；`/healthz.endpoints` 为 1。另查 `ENDPOINT_DEFAULTS` 的五个值、`types` 为 `['service.']`、`tickMs` |
| E2 | `service.watch` 回当前可见的全量；`kinds` 过滤、`'all'`、多个 kind、没有匹配的都对；没带 `meta` 的项 `meta === null`（G.12）；此后推送按各自的 `kinds` 过滤，不相关的变化不推 |
| E3 | 同 `(announcerId, kind)` 再登记是替换（`urls`、`meta` 都换，总数不变）；同 `announcerId` 不同 `kind` 是另一条 |
| E4 | 别的连接撤回 → `removed: false`、不推送、仍可见；登记所在连接撤回 → `removed: true`、推送空列表；再撤回 → `false` |
| E5（缺省） | 断开后宽限期内仍可见（新连接 `watch` 看得到）；正好等于 `GRACE_MS` 时 `tick` 不删；超过 1 ms 删除并推送 |
| E5（选项） | `endpointsModule({ graceMs: 100 })` 生效，边界同上 |
| E6（同 urls） | 宽限期内从新连接以相同 `urls` 再登记：不推送；过了原宽限也不删（已改绑）；改绑后新连接能撤回 |
| E6（不同 urls） | 不同 `urls` → 恰好推一次新地址，之后不按旧连接的宽限删除 |
| E6（不同 meta） | 相同 `urls`、不同 `meta` → 推一次（G.12 第 6 条） |
| E7 | `ftp:`、`ws:`、带用户名密码、只带用户名、9 个地址、0 个地址、`urls` 不是数组、解析不了、超过 2048 字符、`kind` 大写 / 数字开头 / 33 字符 / 空、`announcerId` 带空格 / 129 字符 / 缺、`meta` 超 4096 字节、同键替换成非法地址 → 都是 `bad-message`，不推送，状态不变；边界上的合法值（128 字符 id、32 字符 kind、8 个地址、3000 字节 meta）能登记 |
| E8（缺省） | 64 个都能登记，第 65 个回 `limit`，总数 64；到上限后替换已有的照常 |
| E8（选项） | `maxAnnouncers: 3`、`maxUrls: 2`、`maxMetaBytes: 64` 生效 |

### render-node-ws（15 条：全败，原因都是 `ws-transport.mjs` / `endpoint.mjs` / `auth.mjs` 不存在，或 `index.mjs` 还没加出这些名字）

| 编号 | 测什么 |
|---|---|
| T1 ×2 | 匿名、令牌模式各一遍：`onOpen` 触发、`connected`；按 G.7 约定写法接 `local-node`，收到 `node.welcome`，会话的 `epoch` 等于队列的；服务端记到这条连接两种角色（令牌模式 principal 为 cluster）；`stats()` 的 `opens`、`closes`、`sent`、`received`、`dropped`、`badFrames` |
| T1（出口） | `index.mjs` 加出四个名字；`BACKOFF_DEFAULTS` 的值；参数不合法同步抛 `TypeError`（G.11） |
| T2 | 经测试代理强行断开、再让新连接一接上就断：注入 `setTimeout` 攒着手动触发、`random` 固定 0.75，等待依次是 550、1100、2200（公式含抖动）；连上后清零回到 550；握手失败不调 `onClose`、不计 `closes`（G.11） |
| T3（丢弃） | 连上时 `send` 回 `true`、计入 `sent`；断线期间连发三次都回 `false`，`dropped` +3、`sent` 不变；重连后没有补发（新连接上没收到任何回包，`sent` 不变） |
| T3（坏帧） | 服务端经一个测试模块发 `42`、`[1,2]`、`"text"` 和一个对象：处理器只收到对象，`badFrames === 3`，`received` 只 +1（G.11） |
| T4 | 节点认领一个 1.5 s 的任务、开工后强行断开，自动重连（等待缩到 20 ms）：第二条 `node.welcome` 的 `resumed` 是这个任务、`lost` 为空；令牌不变；页面恰好收到一次 `task.done`；队列里 `attempts === 0`；执行器只跑了一次 |
| T5 | 代理换到另一个文档服务实例：线上收到 `task.lease-lost { reason: 'epoch' }`（`epoch` 是新实例的），`onEvent` 报了这个任务的 `lost`（不断言 reason，照 G.11），不再持有，会话 `epoch` 换成新的 |
| T6（真 HTTP） | 环境变量地址可用 → `remote`（只试一项）；不可用、回环可用 → `local`；都不可用 → `offline`（没有 `url`）；`protocol` 不符 → `protocol-mismatch`；`ok` 不是 `true` → 不可用；没设或空串 → 只试回环（G.11）；`http:` → `bad-url` 并继续（G.11）；探活挂住按 `timeoutMs` 放弃；URL 带路径时 `/healthz` 取在源站根上（G.11） |
| T6（注入 fetch） | `wss://…/ws` → `GET https://…/healthz`；回环 → `http://127.0.0.1:<port>/healthz`；返回的 `url` 原样 |
| T6（订阅） | `watchServiceEndpoints`：已连上时立即补发订阅（G.11），`onChange` 拿到全量；变化推送；断线重连后重新订阅；`stop()` 之后不再调 |
| T7 ×2 | `close()` 后 `closed` 真、`connected` 立即假，`onClose` 带 `{ code: 1000, reason: 'closed' }`，不排重连、代理上没有新连接、`send` 回 `false`、重复 `close()` 无害；退避等待中 `close()`，计时器到点也不再连 |
| T8 | 令牌错：`random` 0.5 时等待依次 500、1000、2000、4000、8000、15000、15000……；`opens`、`closes` 都是 0，不调 `onClose`；`random` 取 1 时封顶为 `maxMs × (1 + jitter)` = 18000，第 0 次 600（G.11） |
| T9 | 两个节点经真 WebSocket 抢 50 个假任务（每个 20 ms，`maxConcurrent` 2）：页面对每个 id 恰好收到一次 `task.done`，两节点完成数合计 50、无重复、各至少一个，队列里全部 `done`，`badFrames` 为 0 |

## 验证

- `node --check`：四个测试、`fake-ws-kit.mjs`、三个探针全部通过。
- 逐个跑新测试文件（`node --test --test-reporter=tap server/test/<文件>`）：router 12 条 1 过 11 败；auth 11 条全败；endpoints 12 条全败；render-node-ws 15 条全败。失败原因见上表，都是实现缺失。
- `npm test`：退出码 1；共 2247 条，通过 2197、失败 49、跳过 1。失败的 49 条全部在这四个新文件里（11 + 12 + 11 + 15）。跳过的 1 条是既有的「集成：/api/cards/layout 对真实项目返回整数框」。既有测试全过，`docservice.test.mjs` 没改、17 条全过。
- `npx tsc -b --force`：退出码 0，输出为空（零错误）。
- 探针不带参数：`render-queue-e2e.mjs` 打用法、退出码 2；`render-queue-proxy.mjs` 打用法、退出码 2。`--token x` 也被拒（令牌只从环境变量读）。

### 用参考实现自检（没有入库）

为了确认测试本身没写错，我在 scratchpad 里按契约写了一份最小的参考实现（router、auth、两个模块、改过的 service / ws / main、ws-transport、endpoint），在 worktree 下一个临时目录 `.verify-scratch/` 里和测试拼起来跑，跑完整个目录已删，**没有提交任何实现代码**。结果：

- 五个文件（含既有 `docservice.test.mjs`）一起跑，67 / 67 通过，连跑 3 遍都一样，每遍约 15.6 s。
- 自检中发现并改掉了测试里的三处问题：A4、A5、T3 原来假设服务端会马上察觉「只断 TCP、不发关闭帧」的连接（见下文风险 1），已改成不依赖这一点。
- 探针对参考实现跑过（端口 8790～8799，都是我起的进程，跑完已结束）：
  - `ws-client-test`：匿名 12 / 12，令牌模式 14 / 14，退出码 0；服务端日志里没有令牌。
  - `render-queue-e2e --role both --tasks 20 --watch-endpoints --announce …`：`ok: true`，完成 20、重复 0、认领 20，`endpoints` 里有自己的登记，退出码 0。
  - 连不上：退出码 2。
  - `--exit-after-claim`：退出码 3。另一节点事先在跑时，记到接手耗时 `takeovers: [{ ms: 12711 }]`（宽限 10 s 加扫描间隔）。
  - `render-queue-proxy`：`--delay-ms 50 --loss 0.05` 下发布方 30 / 30 完成；`--cut-after-ms 1000` 下节点每约 1 s 断开一次并自动重连（opens 1→2→3）；`--stall-after-ms 500` 打出 `conn.stall`，之后不转发、也不关连接。

## 契约疑点

1. **已由 G.12 解决**：组装层怎么拿到 `createClusterAuth`（`authenticate: auth.authenticate`，同一个 `log` 两边都传），以及登记模块工厂的名字和平铺选项。测试已照改。
2. **队列模块（和占位模块）叫什么名字**没写。测试不依赖它，只要求 `describe().modules` 的键和 `/healthz.modules` 一致。建议写明，并写明占位模块和真模块是否同名（同名的话，`/healthz.modules` 挂没挂队列都一样，靠 `queue` 字段区分）。
3. **登记模块的回包带不带 `reqId`** 没写（队列按 A.6 带，核心只在自己回错误时带）。测试按消息类型等，不依赖它。建议统一成「回包带原 `reqId`」，否则客户端没法把 `error` 对应到具体请求。
4. **`service.withdraw` / `service.watch` 的字段校验**：G.6 只写了 `announce` 的校验。E7 另外断言了 `withdraw` 的 `announcerId` 不合法、`watch` 的 `kinds` 是 `42` 时回 `bad-message`。这是按 A.6「格式错误回 `bad-message`」推的，请主会话确认；若不认可，删 E7 里这两行即可。
5. **E8 到上限后替换已有的登记**：测试断言可以替换（「登记总数超过」时才拒，替换不增加总数）。这是解读，请确认。
6. **字段冲突检查时 `describeConn` 拿什么 `connId`**：G.3 只说「挂载时各调一次」。测试里的模块不管 `connId` 是什么，都回同样的键。若实现传 `undefined` 或假 id，模块作者要注意不能因此抛错，建议写进 G.3。
7. **核心字段冲突在哪一层查**：`router.health()` 自己不产出核心字段（`ok`、`protocol` 等由组装层给）。测试只在组装层（`service.mount`）断言与核心字段冲突会抛错，路由核心只测模块之间的冲突。
8. **`meta` 必须是对象吗**（`null`、数组、字符串）没写，测试没测。
9. **重新登记时 `since` 变不变**没写，测试没断言。

## 契约没覆盖到的风险

1. **服务端察觉不到「只断 TCP、不发关闭帧」的连接（重要）**。`ws.mjs` 的 `WsConnection` 只听 socket 的 `close`，但 HTTP 服务端的 socket 是 `allowHalfOpen`：对端只发 FIN 时服务端收到 `end`，却不会自动关掉，连接记录一直留着，直到心跳（`HEARTBEAT_MS` 30 s，最长约 60 s）才清。现有 `main` 上的 `service.mjs` 同样如此：我用原始 socket 握手后 `destroy()` 或 `end()`，2 s 内 `describe().connections` 一直是 1。进程崩溃、代理断开、NAT 超时都会走到这条路径。后果有三：
   - 节点断开之后，要先等心跳发现、再过 `RECONNECT_GRACE_MS`，队列才开始接手，接手慢 30～60 s；
   - 地址登记的「断开后宽限」也要晚这么久才开始；
   - X5（干净断开）的测量会被心跳周期污染。
   建议 `ws.mjs` 在 socket `end` 时 `destroy()`（`ws.mjs` 在 svc 的文件清单里），并加一条回归测试：原始 socket `end()` 之后连接记录很快清掉。这次的测试里没加这条断言，因为契约没写。
2. **计时类用例的时序**：T4 依赖「1.5 s 的任务开工后断开，20 ms 内重连，宽限 10 s 之内接续」，T9 依赖真实计时器下 50 个 20 ms 的任务约 1～2 s 完成。自检三遍都稳，但慢机器上 T4 的余量主要看渲染时长，必要时可以把 `taskMs` 调大。
3. **注入的 `setTimeout` 只能用于重连**：T2 / T3 / T7 的手动计时器把所有毫秒数 > 0 的计时器都当作重连等待。实现若把注入的 `setTimeout` 另作他用（比如握手超时），这几条会误判。建议在 G.7 写明「注入的 `setTimeout` 只用于重连等待」，或者另给握手超时一个注入口。
4. **e2e 探针单跑 node 角色时的 `ok`**：节点侧看不出「半开」（proxy `--stall-after-ms`），到 `--timeout-ms` 时照样报 `ok: true`。判定要看发布方那一半的结果。
5. **测接手要先起观察节点**：`takeovers` 只在观察节点先看到了别人的 `task.taken` 时才有记录。探针的文件头已写明，跑 X5 时要先起观察节点、再起会退出的节点。
6. **A6 在实现缺失时**会让现有 `main.mjs` 在 `0.0.0.0` 的随机端口上起来最多 8 s，再被测试结束掉。实现合入后就不会再发生（失败即关）。

## 需要主会话决定

- 契约疑点 3～5 的取舍（`reqId` 回显、`withdraw` / `watch` 的校验、到上限后能不能替换）；
- 风险 1 要不要让 svc 在 `ws.mjs` 里补 `end` 处理，并补回归测试。
