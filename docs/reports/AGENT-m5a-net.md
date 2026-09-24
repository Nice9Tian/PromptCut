# M5a 节点侧（net）实现报告

- 角色：net（`claude/rq-m5a-net`，基于 `claude/rq-m5a` 的 `b17c50a`）
- 依据：`docs/plan/render-queue-contract.md` G 节（重点 G.7）、D.1、D.2；背景 `docs/plan/Master-Execution-Plan.md` 第 7 节 M5a
- 可改文件：`server/render-node/ws-transport.mjs`（新）、`server/render-node/endpoint.mjs`（新）、`server/render-node/index.mjs`
- 端口段：5260～5269（实际全部用端口 0，没占这一段）

## 进度

- [x] `ws-transport.mjs`
- [x] `endpoint.mjs`
- [x] `index.mjs` 出口
- [x] 自测
- [x] 基线（`npx tsc -b --force`、`npm test`）

## 做了什么

### `server/render-node/ws-transport.mjs`

- 导出 `BACKOFF_DEFAULTS = { baseMs: 500, factor: 2, maxMs: 15_000, jitter: 0.2 }`（冻结）和 `createWsEndpoint`。另导出 `PROTOCOL`（`'promptcut.v1'`，给 `endpoint.mjs` 用）和 `backoffDelay(n, backoff, random)`（公式本身），这两个没进 `index.mjs`。
- 不引任何模块，只用全局 `WebSocket`；`WebSocket`、`setTimeout`、`clearTimeout`、`random`、`backoff`、`log` 都可注入。假 `WebSocket` 有 `addEventListener` 就用它，没有就挂 `onopen` 这类属性。
- 子协议：有令牌时 `['promptcut.v1', 'promptcut.token.' + token]`，否则 `['promptcut.v1']`。令牌不进 URL，也不进日志。
- 重连：断开或连不上之后，第 n 次（从 0 起）等 `min(maxMs, baseMs × factor^n) × (1 + jitter × (2·random() − 1))`，连上后 n 清零；`close()` 会清掉待跑的重连计时器，之后不再重连。
- `send`：没连上（包括 `close()` 之后）就丢弃，回 `false`，`dropped` 加一；连上时序列化成 JSON 发出，`sent` 加一。断线期间的消息不缓存，也不重放。
- `onMessage`：处理器按注册顺序逐个调用。某个处理器抛错会被接住并记 `ws.handler-error` 日志，不影响后面的处理器。不是 JSON、JSON 不是对象、二进制帧，都丢弃并记入 `badFrames`。
- `onOpen` / `onClose`：每次连上、每次断开都调用，`onClose` 带 `{ code, reason }`。
- 日志事件：`ws.open { url, protocol }`、`ws.close { url, code, reason }`、`ws.connect-failed { url, code }`、`ws.retry { url, attempt, delayMs }`、`ws.error`、`ws.closed`、`ws.handler-error`。`url` 只保留协议、主机和路径。

### `server/render-node/endpoint.mjs`

- `resolveDocservice({ env, fetch, timeoutMs = 3000 })`：
  - 按顺序试两个候选：先 `PROMPTCUT_DOCSERVICE_URL`（设了才试），再 `ws://127.0.0.1:${PROMPTCUT_DOCSERVICE_PORT ?? 8787}`；
  - 第 1 个可用回 `remote`，第 2 个可用回 `local`，都不可用回 `offline`；
  - 探活：把 `ws:` / `wss:` 换成 `http:` / `https:`，`GET <origin>/healthz`，用 `AbortController` 做超时；
  - 判为可用的条件：`ok === true` 且 `protocol === 'promptcut.v1'`；
  - `tried` 里的 `reason` 取值：`protocol-mismatch`、`not-ok`、`unreachable`、`timeout`、`http-<status>`、`bad-json`、`bad-url`、`no-fetch`；
  - 缺省参数取 `globalThis.process?.env` 和全局 `fetch`，不读文件系统。
- `watchServiceEndpoints(ep, kinds, onChange)`：
  - 每次 `onOpen` 发一次 `service.watch { kinds }`，收到 `service.endpoints` 就调 `onChange(endpoints)`；
  - 调用时端点已经连上，就立刻补发一次（见「契约疑点」5）；
  - 返回的 `stop()` 靠标志位停用：端点没有撤销处理器的接口；
  - `kinds` 只接受字符串数组或 `'all'`，不合法时抛 `TypeError`。

### `server/render-node/index.mjs`

加出 `BACKOFF_DEFAULTS`、`createWsEndpoint`、`resolveDocservice`、`watchServiceEndpoints`。文件头注释补上三个新模块的说明，并写明两个网络模块是「不开计时器、不读环境变量」的例外。

## 验证

### 自测（脚本在 scratchpad，不提交）

**1. 单元级**：`node --test net-unit.test.mjs`，退出码 0，9/9 通过。用可注入的假 `WebSocket` 和记录型 `setTimeout`，外加真 HTTP 服务（端口 0）。

| 编号 | 内容 |
|---|---|
| U1 | 子协议：带令牌时两项，不带时一项；URL 不含令牌 |
| U2 | `random` 固定为 0、0.5、0.999999 三种，n = 0～7 每次等待都等于公式值（含封顶）；连上后清零（断开后第一次等 `baseMs`，再失败等第 1 项）；一直连不上时 `opens === 0`、`closes === 0` |
| U3 | 断线期间 `send` 回 `false`；重连后不重放；`stats` 恰为 `{ opens: 2, closes: 1, sent: 2, received: 0, dropped: 3, badFrames: 0 }` |
| U4 | 多个处理器按顺序调用，前一个抛错后一个照样调；非 JSON、`42`、`ArrayBuffer` 记 3 个 `badFrames` |
| U5 | `onOpen` / `onClose` 每次都调，`onClose` 带 `{ code: 4000, reason: 'kick' }`；连不上的那次不调 `onClose` |
| U6 | 已连上时 `close()`：不再新建 socket，没有待跑的计时器，`onClose` 收到 `{ code: 1000, reason: 'closed' }`；退避等待中 `close()`：计时器被清掉；连接中 `close()`：不重连 |
| U7 | 连接、失败、重连、断开、关闭走一遍，全部日志里找不到令牌原文 |
| U8 | `watchServiceEndpoints`：每次 `onOpen` 各发一次 `service.watch`；只把 `service.endpoints` 交给 `onChange`；`stop()` 后不再调用；已连上时调用会立刻补发 |
| U9 | `resolveDocservice`：环境变量地址可用 → `remote`（`tried` 只有一项）；它连不上、回环可用 → `local`（`unreachable`）；旧版 `/healthz` 没有 `protocol` → `protocol-mismatch`；不响应的服务 300 ms 后记 `timeout`；`ok: false` 记 `not-ok`；`http:` 地址记 `bad-url`；`wss://cloud.example:9443/ws` 探的是 `https://cloud.example:9443/healthz`；没设端口时探 `http://127.0.0.1:8787/healthz` |

**2. 对真文档服务**：`node net-real.mjs`，退出码 0，最后一行 `ALL PASS`。文档服务用本分支（与 main 相同）的 `server/docservice/`，匿名模式，端口 0；队列用 `createRenderQueue`。

- **A 段：直连现有文档服务。** 现有服务不回显子协议，Node v24.19.0 内置的 `WebSocket` 请求了 `promptcut.v1` 而服务端不回，握手失败：`opens: 0`，日志是 `ws.error` → `ws.connect-failed { code: 1006 }` → `ws.retry`。
  - 实测退避序列（`baseMs` 100、`maxMs` 400）：`80, 215, 411, 393, 461` ms，封顶加抖动，符合公式；
  - `close()` 之后 800 ms 内没有再重试；
  - 对照组：不带子协议的原生 `WebSocket` 能连上同一个服务。
  - **结论**：`createWsEndpoint` 对现有 main 的文档服务连不上，要等 svc 分支让 `acceptUpgrade` 回显 `promptcut.v1`（G.5）之后才能直连。这与 G.5「Chrome 会让握手失败」的说法一致，Node 内置 `WebSocket`（undici）也一样。
- **B 段：经回显代理的端到端。** 在 scratch 里写了一个 TCP 代理，只在服务端的 101 响应头里补一行 `Sec-WebSocket-Protocol: promptcut.v1`，其余字节原样转发。节点用 `createLocalNode` + `createWsEndpoint`，按 G.7 的约定写法在 `onOpen` 里调 `node.start(held)`，每 250 ms `tick` 一次；执行器睡一段时间，产物库放内存。发布方用另一个 `createWsEndpoint`，发布 20 个细任务。
  - 握手后 `ws.protocol === 'promptcut.v1'`；
  - 节点认领后，代理掐断节点连接：断线期间 `send` 回 `false`；约 200 ms 后自动重连；
  - `resume` 接续：掐断前持有 `snapshot:rk-B-10:0-9#2`，重连后仍持有同一令牌；
  - 20 个任务全部收到 `task.done`，没有重复，`render` 共调用 20 次（没有重做），队列 `describe()` 里这 20 个都是 `done`；
  - 节点端点 `stats`：`{"opens":2,"closes":1,"sent":166,"received":206,"dropped":2,"badFrames":0}`。
- **C 段：换新 epoch。** 节点持有一个任务时，关掉服务 A、起服务 B（`epoch-B`），代理改指向 B。
  - 节点重连后，线上收到 `task.lease-lost { reason: 'epoch', epoch: 'epoch-B' }`；
  - `onLost` 被调用，local-node 事件是 `{ type: 'lost', reason: 'lost' }`，不是 `'epoch'`，原因见「契约疑点」4；
  - 被丢的任务不再在跑。

**没做的联调**：令牌模式和真实服务端的联调（T1 令牌那一遍、T8 对真服务），要等 svc 分支合进集成分支才能做，这里没做。令牌模式在节点侧只影响子协议列表，已由 U1 覆盖。

### 基线（在 worktree 里跑）

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误 |
| 全量测试 | `npm test` | 退出码 0；tests 2197，pass 2196，fail 0，skipped 1。跳过的是需要 5190 的「集成:/api/cards/layout 对真实项目返回整数框」 |
| 导出确定性、快照重放、画面 | —— | 没跑：本任务不动渲染、导出、卡片和页面（G.7 只加节点侧网络模块） |

## 契约疑点（都按最保守的读法实现了）

1. **连不上算不算「断开」**：G.7 说 `onClose`「每次断开都调」，`stats` 里有 `closes`。我的读法是只有连上过的连接断开才算：调 `onClose`，`closes` 加一。握手失败（包括 401）只记 `ws.connect-failed` 日志并按退避重连，不调 `onClose`，不计 `closes`，这样 `opens` 和 `closes` 成对。T8 只断言 `opens === 0`，不受影响；如果测试方按「失败也计 closes」写，会与此冲突。
2. **`received` 与 `badFrames` 的口径**：G.7 只说「非 JSON 文本丢弃并计数」。我的实现：能解析但不是对象的 JSON（如 `42`、`null`、数组）和二进制帧，也记入 `badFrames`，不交给处理器；`received` 只计交给了处理器的消息。协议里所有消息都是对象，交出非对象反而可能让 `session.receive` 出错。
3. **抖动乘在封顶之后**：按公式逐字实现，实际等待最多是 `maxMs × (1 + jitter)` = 18 s。T8 所说的「封顶」应理解为 `min(...)` 那一项封顶；测试若断言「等待 ≤ maxMs」，要么固定 `random = 0.5`，要么放宽到 `× 1.2`。
4. **T5 里 `onLost` 的 reason**：队列（`queue.mjs` 335～336 行）对新 epoch 下的 resume，先回 `node.welcome { lost: [...] }`，再补 `task.lease-lost { reason: 'epoch' }`。会话（`session.mjs` 126 行）看到 `welcome.lost` 就以 `'lost'` 丢掉持有，随后那条 `lease-lost` 因为持有已不在而被忽略（`session.mjs` 文件头 26 行写明是有意的）。所以 `onLost` 被调时 reason 是 `'lost'`，不是 `'epoch'`，但线上确实收到了 `lease-lost { reason: 'epoch' }`。G.9 T5 如果断言 `onLost` 的 reason 为 `'epoch'`，会失败。这是 M2 会话的既有行为，本分支不能改 `session.mjs`。建议 T5 的断言写成「线上收到 `lease-lost { reason: 'epoch' }` 且 `onLost` 被调」，或者另开任务让会话在 `welcome.lost` 时用 `'epoch'`（需要改 `session.mjs`）。
5. **`watchServiceEndpoints` 调用时已经连上**：G.7 只说「每次 `onOpen` 发一次」。如果调用时端点已经连上，照字面要等到下一次重连才会订阅，所以我立刻补发一次。这是一处扩展：调用时没连上的，行为与字面完全一致。
6. **`resolveDocservice` 的边界**：
   - `PROMPTCUT_DOCSERVICE_URL` 为空串，当作没设（`tried` 里没有它）；
   - 不是 `ws:` / `wss:` 时记 `bad-url`，继续试回环；
   - `/healthz` 取在源站根上，URL 里的路径不保留：如果将来文档服务挂在反向代理的路径前缀下，要改这里；
   - `PROMPTCUT_DOCSERVICE_PORT` 为空串时按 `??` 的字面保留空串，拼出来的 `ws://127.0.0.1:` 会落到默认端口；
   - 除 `protocol-mismatch` 外，其余 `reason` 的取值契约没有规定，是我定的。
7. **建连时机**：接口里没有 `connect()`，所以 `createWsEndpoint` 创建时就发起连接。第一次 `open` 一定是异步到达的，创建后同步注册的 `onOpen` 不会漏。`url` 不合法、协议不是 `ws:` / `wss:`、没有可用的 `WebSocket`、`token` 是空串，都在创建时同步抛 `TypeError`。
8. **`close()` 与 `onClose`**：`close()` 立即把 `connected` 置为 `false`，此后 `send` 一律丢弃。`onClose` 等 socket 真正关上时才调（`{ code: 1000, reason: 'closed' }`），这一次也计入 `closes`。
9. **计划和契约不一致**：主执行计划第 7 节 M5a 的 net 行写着「`local-node.mjs` 里只加『传输可换』的注入点」和「`epoch` 变了就清本地认领、让发布方重发」，契约 G.7 与任务书则明确不改 `local-node.mjs`。我按契约办：注入点 D.2 的 `endpoint` 已经有了；换 epoch 后清本地认领由会话按 `welcome.lost` 完成（C 段已验证）；让发布方重发是发布方（探针、页面）自己的事。

## 提交

| 提交 | 内容 |
|---|---|
| `2182836` | 文档：建报告 |
| `ae7736f` | 节点：`ws-transport.mjs`、`endpoint.mjs`、`index.mjs` |
| （本次） | 文档：报告写入自测与基线结果 |
