# 文档服务的第二种传输：HTTP 长轮询（契约）

状态：契约，2026-09-26 写。分支 `claude/http-transport`。查资料的结论见第 11 节（codex，原文在 scratchpad 的 `research-http-transport.md`）。

## 1. 为什么要有

- 有一类节点（Anthropic 的云端开发容器）出网只能经一个出站代理，代理只放行 443 端口的 HTTPS，不支持 WebSocket 升级、非 443 端口、原始 TCP。
- 阿里云托管端已经在 443 上有 nginx 反代：`https://8-219-80-16.sslip.io/hosted` 对应文档服务，`/media` 对应素材服务。HTTP 健康检查从云端能通，但 `wss://` 不通。
- 路线由用户定：给文档服务加第二种传输「HTTP 长轮询」，与 WebSocket 并存。**业务模块一行不改**，核心 `router.mjs` 不改。

## 2. 范围

| 在范围内 | 不在范围内 |
|---|---|
| 服务端：组装层 `server/docservice/service.mjs` 加一种传输；新文件 `server/docservice/http-transport.mjs` 放会话表与端点 | `router.mjs`、所有模块、鉴权规则本身 |
| 节点端：新文件 `server/render-node/http-transport.mjs`，端点形状与 `ws-transport.mjs` 相同 | SSE（第 11 节第 1 条） |
| 注入：`render-node`（经 `createLocalNode` 的 `endpoint`）、`server/agent/doc-link.mjs`（经 `WebSocketImpl`）、探针（`--transport http`）、共享项目配置项的 `transport` 字段（独立渲染主机经它选择） | 编辑器页面、在线浏览器模式改用 HTTP 传输（C10 / M7 再定；本契约只保证协议对浏览器可用） |
| 独立模式（自建 http 服务器：托管组合、`docservice/main.mjs`） | 挂载模式（挂进 vite）只把处理函数交出来，vite 不接线 |

## 3. 端点

基址与共享端点相同：`httpBaseOf(文档服务地址)`（`ws:` → `http:`、`wss:` → `https:`，路径保留）。托管端经 nginx 时是 `https://8-219-80-16.sslip.io/hosted`。下面的路径都相对这个基址。

所有回包都是 `application/json; charset=utf-8`，带 `Cache-Control: no-store`。凭证、会话号一律只放请求头，不放 URL、不进日志。

### 3.1 建连 `POST /lp/open`

- 请求头 `X-Promptcut-Protocols`：**与 WebSocket 的 `Sec-WebSocket-Protocol` 同一个列表**，逗号分隔，第一项是 `promptcut.v1`，其余是 `promptcut.auth.<…>`、`promptcut.ticket.<…>`、`promptcut.tenant.<…>`、`promptcut.role.<…>`、`promptcut.token.<…>`（管理身份）。
- 请求体：空或 `{}`。
- 服务端把这个请求头当作 `sec-websocket-protocol` 交给**同一个** `authenticate(req)`：鉴权、限速、回环信任、共享项目的挑战证明（nonce 只能用一次）全部原样生效，本传输不另写鉴权。
- 成功 `200`：
  ```json
  { "ok": true, "sid": "<会话号>", "protocol": "promptcut.v1", "transport": "http",
    "waitMs": 25000, "idleMs": 60000, "maxFrameBytes": 1048576 }
  ```
  - `sid`：32 字节 CSPRNG，base64url；它就是这条连接的 bearer 凭证。
  - 服务端同时在核心里登记一条连接（`router.connect(connId, principal, …)`），`connId` 与 WebSocket 连接同一个编号序列。
- 失败：鉴权不过 `401 { ok:false, error:'unauthorized' }`（不细分原因，和 WebSocket 升级回 401 一样）；关停中或连接数满 `503`；请求头缺失或不是 `promptcut.v1` 开头 `400 { error:'bad-protocols' }`。
- 连接数上限 `maxConnections` 由 WebSocket 连接与 HTTP 会话共用。

### 3.2 发送 `POST /lp/send`

- 请求头 `Authorization: Bearer <sid>`。
- 请求体：`{ "seq": <n>, "frames": ["<文本帧>", …] }`。
  - 每个文本帧就是 WebSocket 上会发的那条 JSON 文本，单帧不超过 `maxFrameBytes`（= `maxPayload`，缺省 1 MiB）；
  - 一次 POST 的请求体不超过 `maxFrameBytes + 64 KiB`，客户端把小帧攒成一批，超了就分几次发；
  - `seq` 是这个会话的发送批次号，从 1 起，每批 +1。
- 服务端：
  - `seq` = 已收批次号 + 1：按顺序逐帧 `router.dispatch(connId, text)`，已收批次号 = `seq`；
  - `seq` ≤ 已收批次号：**重发**，不再分发，照样回成功（幂等，客户端没收到回包时重发同一批）；
  - 其余（跳号）：`409 { error:'out-of-order', expect: <已收+1> }`，客户端按会话已坏处理（第 5 节）。
- 回包 `200 { ok:true, ack: <已收批次号> }`。
- 客户端**同一时刻只有一个 POST 在途**，下一批等上一批回包再发。
- 单帧超限 `413 { error:'too-large' }`，会话以 1009 关闭（与 WebSocket 超 `maxPayload` 相同）。

### 3.3 接收 `GET /lp/recv?ack=<n>&wait=<毫秒>`

- 请求头 `Authorization: Bearer <sid>`。
- `ack`：客户端已完整收到的最大出站序号（从 0 起）；`wait`：最多挂多久，服务端取 `min(wait, waitMs)`，`waitMs` 缺省 **25 000 ms**，上限 30 000 ms。
- 服务端的出站帧各有一个递增序号（每会话从 1 起）。收到请求时先丢掉序号 ≤ `ack` 的帧，然后：
  - 有序号 > `ack` 的帧：立即回，一次最多 1 MiB（至少一帧）；
  - 没有：挂着，来了新帧或会话被关就立即回；到 `wait` 回空列表。
- 回包 `200`：
  ```json
  { "ok": true, "frames": [ { "seq": 7, "data": "<文本帧>" } ], "closed": null }
  ```
  会话已被服务端关闭时，先回完剩下的帧，`closed` 为 `{ "code": 1013, "reason": "backpressure" }` 这类对象，之后会话作废。
- **一个会话同时只有一个挂起的 GET**。新的 GET 到了，旧的立刻回 `200 { ok:true, frames:[], closed:null, superseded:true }`（客户端超时重连后旧请求可能还挂在服务端，替换比拒绝更顺）。
- 丢掉的帧不重放：客户端只在确实收到回包后才推进 `ack`，所以响应在路上丢了，下一次 GET 仍然带旧的 `ack`，服务端重发；客户端按 `seq` 去重。

### 3.4 关闭 `POST /lp/close`

- 请求头 `Authorization: Bearer <sid>`，请求体可带 `{ "code": 1000, "reason": "closed" }`。
- 服务端 `router.disconnect(connId)`，挂着的 GET 回 `closed: { code, reason }`，会话作废。

### 3.5 会话不存在或已结束

- 未知 `sid`：`404 { error:'no-session' }`；
- 刚结束的会话（墓碑保留 2 分钟）：`410 { error:'session-closed', code, reason }`；
- 客户端收到这两种都按「连接断开」处理：报 `onClose`，按退避重新 `open`。

### 3.6 跨源（给浏览器留的）

- `createDocService` 新选项 `httpCorsOrigins`（字符串数组，缺省空）。请求的 `Origin` 在名单里才回 `Access-Control-Allow-Origin: <该 Origin>`、`Vary: Origin`；
- `OPTIONS /lp/*` 预检回 `204`，`Access-Control-Allow-Methods: GET, POST, OPTIONS`，`Access-Control-Allow-Headers: Authorization, Content-Type, X-Promptcut-Protocols`，`Access-Control-Max-Age: 600`；预检不做任何会话操作；
- 名单为空时不回任何 CORS 头（浏览器跨源用不了，Node 客户端不受影响）。

## 4. 与核心的接法（组装层）

核心只认 `write` / `buffered` / `close` 与 `drained`（`router.mjs` 文件头），两种传输各给一份：

| 核心钩子 | WebSocket | HTTP 会话 |
|---|---|---|
| `write(connId, text)` | `ws.send(text)` | 追加到会话出站缓冲，序号 +1，叫醒挂着的 GET |
| `buffered(connId)` | `ws.bufferedAmount` | 出站缓冲里**尚未被 ack 的帧**的字节数（含已发出、未确认的） |
| `close(connId, code, reason)` | `ws.close(code, reason)` | 会话标记关闭、记下 `code` / `reason`，叫醒挂着的 GET 回 `closed`；之后 `router.disconnect(connId)`、`conn.close` 日志 |
| `drained(connId)` | `ws` 的 `drain` 事件 | 每次 GET 的 `ack` 让 `buffered` 下降后调一次 |

组装层用一张 `connId → { kind: 'ws' | 'http', … }` 表分派。`router.mjs` 不知道有两种传输。

## 5. 背压

- 映射见第 4 节：客户端不来取（或取得慢），出站缓冲的未确认字节就涨；到高水位（缺省 64 KiB）核心改进自己的出站队列；队列加缓冲超过 `maxPendingBytes`（缺省 1 MiB）核心以 **1013 `backpressure`** 关闭，客户端在下一次 GET 里拿到 `closed: {1013}`。行为与 WebSocket 慢读者完全相同，合并键（H.3）照常生效。
- 入站方向：单帧上限 + 单个 POST 在途，天然节流。

## 6. 会话过期与 `hello.resume`

- **活跃**的定义：会话有一个挂着的 GET，或者最近 `idleMs`（缺省 **60 000 ms**）内来过任何请求。
- 组装层的心跳计时器（`heartbeatMs`，缺省 30 s）每轮扫一遍 HTTP 会话：不活跃的按超时关闭（`conn.timeout` 日志，`router.disconnect`），墓碑 `code: 1006, reason: 'timeout'`。和 WebSocket「一轮 ping 没等到 pong 就断」对齐：两种传输都在 30～90 s 内发现死连接。
- **会话过期 = 连接断开**，没有别的语义。客户端之后照 WebSocket 断线的做法走：退避重连，新 `open` 拿新 `sid`（新 `connId`），节点在 `onOpen` 里照旧发 `hello.resume`、队列按 G.7 / D.2 的规则接续或放弃。本传输**不做跨会话的消息接续**，正确性照旧靠 `hello.resume` / `queue.snapshot` 和开工前的 `sink.has`。
- 客户端的临时网络错误（一次 GET 或 POST 失败）不立刻算断线：在 `idleMs / 2` 之内按短退避（250 ms 起，翻倍，封顶 5 s）重试同一请求；超过才报 `onClose { code: 1006 }` 并重新 `open`。

## 7. `/healthz` 与日志

- `/healthz` 加一个组装层字段（不是核心字段，模块不得重名）：
  ```json
  "transports": { "ws": 3, "http": 1, "httpOpened": 12, "httpExpired": 2, "httpSuperseded": 5 }
  ```
  `ws + http = connections`；后三个是累计数。`protocol` 字段不变。
- `conn.open` 日志多一个 `transport: 'ws' | 'http'`；`conn.close`、`conn.timeout` 同样带上。`sid`、请求头里的凭证一律不进日志。

## 8. 节点端 `server/render-node/http-transport.mjs`

- `createHttpEndpoint(options)`：返回值与 `createWsEndpoint` **同一个形状**（`send`、`onMessage`、`onOpen`、`onClose`、`close`、`connected`、`closed`、`stats()`），选项同名同义：`url`、`protocols`（每次重连前现取）、`token`、`setTimeout`、`clearTimeout`、`random`、`backoff`、`log`；另有 `fetch`（缺省全局 `fetch`）、`waitMs`（缺省 25 000）。
  - `url` 收 `http(s)://` 或 `ws(s)://`（后者换成前者），指文档服务基址。
  - 断线期间 `send` 丢弃并计入 `stats().dropped`，和 WebSocket 端点相同。
- `HttpWebSocket`：仿 WebSocket 的类（`new HttpWebSocket(url, protocols)`，`readyState`、`protocol`、`bufferedAmount`、`send`、`close`、`addEventListener` 与 `on*`），给 `doc-link` 这类直接 `new WebSocket` 的调用方注入。`createHttpEndpoint` 可以就是 `createWsEndpoint` 套上它。工厂 `httpWebSocketClass({ fetch, waitMs, … })` 返回绑好依赖的类。
- 只用全局 `fetch`、计时器，不引任何包；浏览器可以原样用。
- **代理**：本模块不自己处理代理。Node 24.5 起，以 `NODE_USE_ENV_PROXY=1`（或 `--use-env-proxy`）加 `HTTPS_PROXY` 运行，全局 `fetch` 就经 CONNECT 隧道走代理；TLS 中间人代理的 CA 用 `NODE_EXTRA_CA_CERTS` 或 `NODE_USE_SYSTEM_CA=1` 信任，不关证书校验。要显式控制时注入带 `dispatcher` 的 `fetch`。
- `render-node/index.mjs` 导出 `createHttpEndpoint`。

## 9. 选用传输

- 共享项目配置项（`server/auth/shared-config.mjs` 的 `normalizeEntry`）加可选字段 `transport: 'ws' | 'http'`，缺省 `'ws'`；`url` 在 `transport: 'http'` 时也可以写 `https://…`。
- `vite-plugin-frames.ts` 给共享项目建 render 连接时按 `entry.transport` 选 `createHttpEndpoint` 或 `createWsEndpoint`（一处）。独立渲染主机 `scripts/render-host.mjs` 经配置文件自然带过去。
- 探针：`shared-project-probe.mjs` 的 creator / member 加 `--transport ws|http`（缺省 ws），member 写进成员配置的 `transport` 优先于成员配置里的；`render-queue-e2e.mjs` 同样加。
- 不做自动探测降级（先 WebSocket、不行再 HTTP）：由配置显式选，行为可预期〔裁〕。以后需要时在客户端加，不影响协议。

## 10. 验收

| 编号 | 标准 |
|---|---|
| HT1 | 服务端单测：open 的鉴权与 WebSocket 同一套（有效证明进、错证明 401、nonce 重用 401、限速生效、回环信任只按 socket 对端算）；send 的顺序、重发幂等、跳号 409；recv 的挂起、立即回、ack 丢帧与重发、单 GET 替换、`closed` 下发；过期；`/healthz` 字段 |
| HT2 | 背压：客户端不取时核心以 1013 关闭，下一次 GET 拿到 `closed: {1013}`；合并键照常生效 |
| HT3 | 等价性：同一组模块测试分别跑在 WebSocket 与 HTTP 两种传输上结果相同（至少：render-queue 的认领 / 完成 / 断线放回，project 的提交 / stale，content 的 put / watch） |
| HT4 | 节点端单测：`createHttpEndpoint` 的退避、`protocols()` 每次现取、断线丢弃计数、临时错误重试不报断线、404 / 410 报 `onClose` 并重连、`HttpWebSocket` 注入 `doc-link` 能读写项目 |
| HT5 | 本机经 `https://8-219-80-16.sslip.io/hosted`（部署前可先起本机托管组合 + 同形 nginx 路由，或直接对阿里云跑） `shared-project-probe --transport http` 的 member 全部通过：进入、快照、内容库、凭票据读写素材、认领并完成任务 |
| HT6 | 部署后：云端节点以 `--transport http` 作为成员接入并认领任务；能渲染的话以独立渲染主机身份认领真实任务（第 12 节） |
| 通用 | 类型检查 0 错误；全量测试 0 失败；WebSocket 路径行为不变（现有测试不改期望） |

## 11. 查资料的结论（codex，`gpt-6-sol` / `high`）

| 题 | 结论 | 怎么用 |
|---|---|---|
| 长轮询 vs SSE 过代理 | 代理与网关可能缓冲响应体，SSE 被缓冲时事件成批或到结束才到；长轮询每次是完整 JSON，不依赖中途刷新 | **采纳**：只做长轮询；SSE 以后有必要再加，并按事件到达时间探测 |
| 挂起时长 | GCP LB 默认 30 s、AWS ALB 空闲 60 s、nginx `proxy_read_timeout` 60 s；建议 20～25 s、上限 30 s，客户端超时 35～40 s | **采纳**：`waitMs` 25 s，上限 30 s；客户端单次 GET 超时 40 s |
| Node 24 走代理 | 24.5 起 `NODE_USE_ENV_PROXY=1` / `--use-env-proxy`，`fetch` 经 CONNECT；全局 `WebSocket` 读不读代理没有出处保证 | **采纳**：第 8 节「代理」；云端指令里写明 |
| nginx | 1.24 连上游默认 HTTP/1.0，要显式 `proxy_http_version 1.1`、清 `Connection`；`client_max_body_size` 与 POST 上限一致 | **采纳**：`/hosted` 路由补 `client_max_body_size 2m`、`proxy_buffering off`；WebSocket 的 `Upgrade` 头照旧 |
| 浏览器 | HTTP/1.1 每源约 6 条连接，挂起的 GET 占一条；自定义头触发预检；后台页定时器节流 | **采纳**：凭证放 `Authorization`，CORS 名单见 3.6；浏览器接入留给 C10 / M7 |
| 协议先例 | Engine.IO：握手取 sid、同一会话只一个 GET 与一个 POST；CometD：按批确认、队列上限 | **采纳**：3.2、3.3 的批次号与 ack；超限走核心的 1013 |
| 会话号安全 | sid 即 bearer 凭证：CSPRNG ≥ 128 位、只放请求头、空闲过期；CORS 不防 CSRF | **采纳**：256 位、只放 `Authorization`、`idleMs` 过期；不用 Cookie，所以没有 CSRF 面 |

## 12. 部署与云端

- 阿里云：从本分支 `deploy-hosted`（注意 pm2 配置会重新生成：两个 `PUBLIC_URL` 要保持 `wss://8-219-80-16.sslip.io/hosted/` 与 `https://8-219-80-16.sslip.io/media/api/asset`），nginx `/hosted` 补 `client_max_body_size 2m; proxy_buffering off;`。
- 云端节点经信箱（`to-cloud`）收第 3 版指令：`NODE_USE_ENV_PROXY=1` 下以 `--transport http` 作为成员接入；是否有 Chrome 由它自己探、写回 `cloud-env`，本机据此决定它当成员节点还是渲染节点。

## 13. 实现记录

2026-09-26 实现（分支 `claude/http-transport`）。下面是契约没说清、由实现裁定的地方，以及与契约的出入。

### 服务端（`server/docservice/http-transport.mjs`，`service.mjs` 只接线）

- **端点前缀**：独立模式 `path` 不是 `/` 时端点在 `<path>/lp/…`，与 `httpBaseOf` 保留路径一致。挂载模式经 `service.handleLongPoll(req, res)` 交出处理函数（回 true 表示接手），vite 不接线。
- **open 的判定顺序**：关停中或连接数满 503 → `X-Promptcut-Protocols` 缺失或第一项不是 `promptcut.v1` 400 → 读请求体（上限 4 KiB，超了 413）→ 再判一次 503 → `authenticate` → 401。先判连接数再鉴权，与 WebSocket 升级的顺序一致。
- **交给 `authenticate` 的请求**：`Object.create(req)`，只换 `headers`（`sec-websocket-protocol` 换成 `X-Promptcut-Protocols` 的列表，客户端自带的 `Sec-WebSocket-Protocol` 被覆盖）；`socket`、`url`、`method` 都是原请求的。
- **契约没写的回包**：`Authorization` 缺失或格式不对按未知 sid 回 404；`recv` 的 `ack` 超过已发出的最大序号回 400 `bad-ack`；`send` 的请求体不是 `{ seq, frames: string[] }` 回 400 `bad-request`；请求体整体超过「单帧上限 + 64 KiB」也回 413 并以 1009 关闭（契约只写了单帧超限）。
- **注销延到下一轮事件循环**：会话关闭后，`router.disconnect` 与 `conn.close` 日志在 `setImmediate` 里做，和 WebSocket 的 `close` 事件一样是异步的——模块在 `handle` 里调 `ctx.close`（踢人 4003、删项目 4004）时不会重入 `disconnect`。这之间的 `write` 丢弃，与 WebSocket 发出关闭帧之后的 `send` 相同。
- **墓碑的时机**：服务端关闭的会话，剩下的帧连同 `closed` 回完后转墓碑；客户端一直不来取的，关闭 `idleMs` 之后转墓碑。客户端自己 `POST /lp/close` 的立刻转墓碑（剩下的帧它不要了）。过期的会话直接转墓碑（`1006 timeout`），日志先 `conn.timeout` 后 `conn.close`，与 WebSocket 超时的两条一致。
- **攒批**：挂着的 GET 被新帧叫醒时推迟到 `setImmediate` 再回，同一轮里核心连写的几条合成一次回包。
- **关停**：`close()` 让挂着的 GET 立刻回 `closed: { 1001 }`，关停期间的回包带 `Connection: close`，免得 keep-alive 连接拖住 `server.close()`。
- **`/healthz`**：`transports` 在合并模块字段之前放进去，模块同名字段不会覆盖它。`conn.open` / `conn.close` / `conn.timeout` 两种传输都带 `transport`（WebSocket 那边新加了这一个字段，现有测试不受影响）。
- **部署清单**：`server/hosted/files.mjs` 整个目录拷 `server/docservice`，新文件自动带上，清单不用改；节点端的 `render-node/http-transport.mjs` 托管端用不到，不进清单。

### 节点端（`server/render-node/http-transport.mjs`）

- **计时器分两组**：`createHttpEndpoint` 的 `setTimeout` / `clearTimeout` 与 WebSocket 端点同义，只管重连退避；单次请求的超时、临时错误的重试间隔、`close()` 的期限另由 `httpTimers: { setTimeout, clearTimeout }` 注入（缺省全局计时器）。混成一组的话，测试手动触发退避时会误触发请求超时。另加了 `now`（重试期限按它算）与 `requestTimeoutMs`（缺省 `waitMs + 15 s` = 40 s）。
- **日志事件名**：`createHttpEndpoint` 就是 `createWsEndpoint` 套上 `HttpWebSocket`，所以端点层的日志仍是 `ws.open`、`ws.close`、`ws.connect-failed`……，其中的 `url` 是换成 ws(s) 的写法；`HttpWebSocket` 自己另打 `http.retry`、`http.error`。`vite-plugin-frames.ts` 按事件名计数的逻辑因此不用改。
- **错误的归类**：临时错误是网络错误或超时（状态 0）、408、429、5xx，在 `idleMs / 2` 内重试同一请求（`idleMs` 取 open 回包里服务端给的）。404 → `onClose { 1006 }`；410 → `onClose` 带墓碑里的 `code` / `reason`；413 → 1009；409、400、401 等按会话已坏 → 1006。
- **`waitMs`**：客户端请求的挂起时长取自己的 `waitMs` 与服务端 open 回包里的 `waitMs` 中较小的。
- **WebSocket 形状的细节**：CONNECTING 时 `send` 抛错；OPEN 以外的 `send` 丢弃；`close()` 先把已进队的帧发完再 `POST /lp/close`，最多等 5 s；CONNECTING 时 `close()` 报 1006（同浏览器），建连回来后顺手关掉服务端的会话；建连失败先 `error` 再 `close { 1006 }`，不带原因。
- **分批**：一批的请求体按转义后的 JSON 长度计，不超过「单帧上限 + 64 KiB」；单帧本身超限时照发一帧，由服务端回 413。

### 选用

- `normalizeEntry` 的 `transport` 缺省 `'ws'`；`'ws'` 时 `url` 仍只收 ws(s)，`'http'` 时 ws(s)、http(s) 都收；别的值报 `bad-shared-config`。
- `vite-plugin-frames.ts`：独立渲染主机的那一处按 `entry.transport` 选端点。另改了同文件 `hostAssetClient` 从文档服务地址推素材地址的一行：原来只把 `wss:` 推成 `https:`，`https:` 地址会被推成 `http:`，现在两者都推成 `https:`。
- **没接的地方**：同文件里预渲染推送与本机队列节点（`resolveDocLink` 取 `PROMPTCUT_SHARED_CONFIG` 第一项的两处 `createWsEndpoint`）仍只走 WebSocket；第一项若写 `transport: 'http'` 加 `https://` 地址，那两处会因地址不是 ws(s) 而抛错。第 9 节只要求独立渲染主机一处，留给需要时再接。
- 探针：`shared-project-probe.mjs` 的 creator 把自己的 `--transport` 写进成员配置；member 的 `--transport` 优先，其次成员配置里的，都没有是 ws。`render-queue-e2e.mjs` 的 `--transport http` 时 `--url` 也收 http(s)。

### 验证记录

- HT1、HT2：`server/test/docservice-http-transport.test.mjs` 17 条；HT3：`server/test/docservice-transport-equivalence.test.mjs` 3 条（两种传输逐条回包相同，只把认领令牌换成类型再比）；HT4：`server/test/render-node-http-transport.test.mjs` 10 条。共用件在 `server/test/fake-transport-kit.mjs`。
- HT5（本机版）：本机起托管组合（`server/hosted/main.mjs`，绑 127.0.0.1、临时数据目录、随机高端口），`shared-project-probe --mode internet --role creator/member --transport http` 两边 `ok: true`：成员进入、快照、内容库、Bearer 与查询串两种票据读素材、认领并完成任务（6 个任务全部完成，成员做了 2 个）；`--transport ws` 再跑一遍也 `ok: true`。`render-queue-e2e --role both --transport http` 20 个任务全部完成、没有重复。经 nginx 与阿里云的 HT5、HT6 没做。

