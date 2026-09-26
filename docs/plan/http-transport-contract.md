# 文档服务的会话与两种传输（契约）

状态：契约第 2 版，2026-09-26 按用户裁定重写（分支 `claude/ht-plan`），取代 `claude/http-transport` 上 `7477acd` 的第 1 版。第 1 版的实现按第 15 节返工。〔裁〕是写本版时定的细节，写明了理由；用户合入前审。

依据：
- 语义：`docs/semantics/product/document-service.md` 与 `docs/semantics/mechanism/document-service.md` 的「会话与传输」；`docs/semantics/product/platforms.md`「只能出网的节点」；`docs/semantics/product/asset-service.md`、`docs/semantics/mechanism/asset-service.md` 里「本机」按真正的发起方判断。
- 核心与信封：`docs/plan/render-queue-contract.md` G.2（本版同时修订，加 `seq`、`ack`）、G.3、G.7、H.2。
- 鉴权：`docs/plan/auth-contract.md` 第 5、9、10、14 节；本机信任开关见本文第 10 节与 `docs/plan/shared-project-contract.md` 第 10 节第 8 条。
- 计划：`docs/plan/Master-Execution-Plan.md` 第 7 节「HT」。
- 第 1 版的实现与交接：`claude/http-transport`（`7477acd`），`docs/reports/HANDOFF-http-transport.md`（在该分支上）。

## 1. 为什么要有

- **只能出网的节点**（例如云端容器）出网只能经代理走 443 端口的 HTTPS。有的代理不放行 WebSocket 升级，文档服务要有一种只靠普通 HTTP 请求的传输，这就是 HTTP 长轮询。
- **单次传输中断不该丢东西**：换网、代理掐断空闲连接、笔记本休眠，都会让传输断一下。以前一断就是断线：节点的租约要回收、页面没确认的提交要重放。本版把「会话」从传输里提出来，会话内的消息带序号、接收方确认，传输断了在保留时限内接着传。
- **2026-09-26 的实测**（写本版时，在一个 Anthropic 云端容器里做的，出网同样只经代理走 443）：
  - Node v22.22.2 的内置 `WebSocket` 连 `wss://echo.websocket.org` 收发成功，设不设 `NODE_USE_ENV_PROXY=1` 都一样；
  - 经代理的 CONNECT 隧道向阿里云 `/hosted/` 发不带凭证的升级请求，回 `401 Unauthorized`：升级请求穿过代理到了文档服务，匿名被拒；
  - 隧道空闲 35.7 s 后照常收发。
  - 所以第 1 版「云端 `wss://` 不通」的结论，很可能是不带凭证的握手被回了 401。本版不假定代理一定挡 WebSocket：先试 WebSocket，失败再转 HTTP（第 4.3 节），两种代理都接得上。云端节点所在容器仍要在 HT 开工时复测一次（第 11 节 HT8）。

## 2. 范围

| 在范围内 | 不在范围内 |
|---|---|
| 组装层的会话层，新文件 `server/docservice/session.mjs`：会话表、序号与确认、保留与补发，两种传输都接在它下面 | `router.mjs` 与所有业务模块：一行不改 |
| WebSocket 传输：`service.mjs` 的升级处理接会话项（第 4.1 节），接续时替换旧连接 | SSE、二进制帧：不做，两种传输只收发文本 JSON |
| HTTP 长轮询传输：`server/docservice/http-transport.mjs`（第 1 版保留，按第 6 节改） | 挂载模式（挂进 vite 的本地文档服务）接 HTTP 长轮询：不接，**直连计划启动时重新评估** |
| 客户端会话层一份，Node 与浏览器通用，只用 `fetch`、`WebSocket`、计时器：新文件 `server/render-node/session-link.mjs`，导出 `createDocEndpoint`（名字〔裁〕：放在节点端目录下，页面照 `src/editor/sync/sharedApi.ts` 引 `server/auth/*.mjs` 的先例引它） | 素材字节的中继：是云端托管服务的职责，属于 `docs/plan/direct-connect-plan.md` |
| 接入：本机队列节点、预渲染推送、独立渲染主机（`vite-plugin-frames.ts` 三处），`server/agent/doc-link.mjs`，页面 `src/editor/sync/`，探针 | 页面经 HTTP 长轮询回落：随 C10a 接上（`/editor` 与 `/hosted` 同源，不用开跨源）。本阶段页面讲会话、只走 WebSocket〔裁：页面经 HTTP 要么同源、要么开跨源名单，前者 C10a 才有，后者 U9 已定缺省关〕 |
| 本机信任开关 `PROMPTCUT_TRUST_LOOPBACK`（第 10 节） | 共享项目配置里的 `transport` 字段：不设（第 1 版加的删掉） |
| 部署：`deploy-hosted` 写开关与公网地址（第 12 节） | 限速在反向代理之后按真实来源计数（取 `X-Forwarded-For`）：以后再做 |

## 3. 会话：序号与确认

### 3.1 会话是什么

- 会话在组装层。核心只看见一条连接（`connId`）：会话建立时 `router.connect`，会话结束时 `router.disconnect`。传输断开与接续都不经过核心，模块感觉不到。
- **会话号 `sid`**：32 字节 CSPRNG，base64url，是这个会话的 bearer 凭证。只放请求头（WebSocket 的 `Sec-WebSocket-Protocol`，HTTP 的 `Authorization` 与 `X-Promptcut-Protocols`），不进地址、日志、`describe()`、`/healthz`。
- 同一会话同一时刻只挂一条传输。新的传输接上时，旧的立刻关掉：WebSocket 以 4009 `superseded` 关；HTTP 挂着的 GET 回 `superseded: true`。

### 3.2 信封字段

- 两个方向的每条业务消息都带 **`seq`**：发送方在这个会话里的序号，从 1 起，每条加一，与传输无关，换了传输接着编号。
- 可以带 **`ack`**：发送方已经按序收全的对方的最大 `seq`。
- 会话层在把消息交给核心之前摘掉 `seq`、`ack`，核心写出的消息由会话层补上。模块看不到这两个字段，也不许用这两个名字：它们加进核心的保留字段名（`render-queue-contract.md` G.2）。
- **会话控制消息**的 `type` 以 `session.` 开头，由会话层处理，不进核心：`session.welcome`、`session.ack`、`session.close`。控制消息不带 `seq`、不被确认。`session.` 前缀加进核心保留前缀，模块不得认领〔裁：控制消息与业务消息分开，免得确认本身又要确认〕。

### 3.3 收与确认

- 接收方按 `seq` 收：
  - 等于「已收 + 1」：交给上层（服务端交 `router.dispatch`，客户端交 `onMessage`），已收加一；
  - 小于等于已收：是重发，丢弃；
  - 大于「已收 + 1」（跳号）：会话已坏，见第 3.5 节。
- 确认随出站消息顺带（`ack` 字段）。收到的消息里还没确认的满 32 条，或 1 s 内没有顺带的机会，就单发一条 `{ type: 'session.ack', ack }`〔裁：取 Engine.IO、CometD 按批确认的做法，数字按消息小、频率不高定〕。
- 发送方留着已发出、未确认的消息，按对方的 `ack` 释放。

### 3.4 背压

- `buffered(connId)` = 这个会话里已写出、未确认的消息的字节数（已交给套接字的也算）。`drained(connId)`：`ack` 推进让它下降后调一次。
- 高水位、`maxPendingBytes`、1013 `backpressure` 照 H.2 不变。传输断着的保留期里，未确认的字节一直涨，涨过 `maxPendingBytes` 同样以 1013 结束会话。合并键（H.3）照常，只对还没写出的消息生效。
- 客户端方向：客户端留着未确认的出站消息，上限 1 MiB，超了就结束会话，报 `onClose { code: 1013 }`〔裁：与服务端的上限对称〕。

### 3.5 出错

- 跳号，或 `ack` 大于自己发出过的最大 `seq`：会话已坏。服务端以 1002 `bad-seq` 结束会话；客户端同样结束，重新建会话。

### 3.6 旧客户端

- 握手里不带会话项（第 4.1 节）的是旧客户端。服务端照第 1 版之前的行为对待它：消息不带 `seq`、`ack`，传输一断会话就结束，相当于保留时限为 0。现有桌面版与探针在升级前照常能连（语义「会话」对它们退化为「一条传输就是一个会话」）。

## 4. 建立、接续与选传输

### 4.1 会话项

- 在鉴权项之外加一项会话项，放在同一个列表里（WebSocket 的 `Sec-WebSocket-Protocol`，HTTP 的 `X-Promptcut-Protocols`）：
  - `promptcut.session.new`：建新会话，与一项鉴权项一起给（`auth-contract.md` 第 5 节「至多一项鉴权」不变）；
  - `promptcut.session.<sid>.<ack>`：接续。`ack` 是客户端已收全的服务端最大 `seq`（十进制）。接续项与鉴权项互斥，给了接续项就不能再给鉴权项；会话的身份就是建会话时的身份〔裁：会话号本身就是 bearer 凭证，再交一次证明要多耗一个一次性随机数，也多一次限速计数〕。
- 回显照旧只回 `promptcut.v1`。
- 建会话或接续成功后，服务端的第一条出站消息是 `{ type: 'session.welcome', sid, resumed, ack, retainMs, transport }`。其中 `ack` 是服务端已收全的客户端最大 `seq`，客户端据此补发。HTTP 的 `POST /lp/open` 回包带同样的字段（第 6.1 节）。
- 接续失败：会话不存在回 404；已结束回 410，带 `code`、`reason`。WebSocket 在握手里回这两个状态码，HTTP 回 `404 { error: 'no-session' }`、`410 { error: 'session-closed', code, reason }`。客户端收到就丢掉旧会话，报 `onClose`，重新建会话（重新取一次性随机数）。

### 4.2 保留与结束

- **脱开**：传输断开后会话进入脱开状态，保留 `retainMs`（缺省 **60 000 ms**〔裁〕）。传输断开指：WebSocket 关闭，或一轮 ping 没等到 pong；HTTP 在 `waitMs + 15 s` 内既没有挂着的 GET、也没来过请求。
- 保留期内接续就接着用；过了保留期会话结束：`router.disconnect`，日志 `conn.timeout`，立墓碑 `1006 timeout`，墓碑保留 2 分钟。
- 死连接从出事到判为断线，最多是 30～90 s（心跳或 HTTP 空闲）加 60 s 保留，与 WebSocket 单靠心跳在同一量级（语义「会话与传输」）。
- **主动结束**：客户端发 `{ type: 'session.close', code, reason }`（HTTP 是 `POST /lp/close`），服务端立刻 `router.disconnect`。主计划 X5「干净断开后接手 ≤ 17 s」按这一条算。
- **服务端主动关**（踢人 4003、删项目 4004、背压 1013、关停 1001、跳号 1002）：会话立刻结束，不保留；客户端收到这些关闭码不接续。
- **断线之后照旧**：订阅清空（核心在 `disconnect` 时做），队列按 G 节的规则回收租约，客户端重新交凭证建新会话，节点在新会话的 `onOpen` 里发 `hello.resume`。`hello.resume` 管租约，序号管消息，两者并存。

### 4.3 选传输（客户端）

1. 每次建会话或接续，都先试 WebSocket。
2. 握手成功（101）就用它。
3. 握手失败就转 HTTP 长轮询，**沿用这一次 WebSocket 握手用的同一份列表**（同一项鉴权、同一个一次性随机数）：
   - 升级请求没到服务端（代理挡了、连不上）：随机数没用过，HTTP 建连照常成功；
   - 到了服务端、鉴权没过：随机数已作废、失败已计一次，HTTP 再交同一个随机数回 401，且按 `auth-contract.md` 第 14 节「已用过的 nonce 重放不计入限速」不再计数。客户端由此知道是鉴权失败，不是传输的问题；
   - 接续失败：HTTP 回 404 或 410，客户端重建会话。
   - 〔裁：浏览器与 Node 内置的 `WebSocket` 都读不到握手的状态码，分不清 401 与代理拒绝；沿用同一个随机数，就能让 HTTP 的回包来分辨，口令输错也不会被算成两次失败〕
4. 两种都失败：按 G.7 的退避重来，下一次仍从 WebSocket 开始。
5. **降级原因**：客户端在 HTTP 建连的请求头里带 `X-Promptcut-Fallback: <原因>`，原因取 `ws-error`（握手失败，客户端分不出细节时）、`ws-timeout`（10 s 没握上）、`ws-closed`（刚握上就被关）。原因里不含地址与凭证。服务端把它记进会话（第 8 节）；客户端打日志 `session.fallback { from: 'ws', to: 'http', reason }`。
6. **开发者强制**：Node 进程读环境变量 `PROMPTCUT_TRANSPORT=ws|http`，探针用 `--transport ws|http`。设了就只用那一种，不降级。共享项目配置里没有 `transport` 字段（第 1 版加的删掉，见第 15 节）。

### 4.4 端点的事件与断线期间的发送

- `onOpen`：只在**建新会话**成功时调。节点在这里发 `hello.resume`，页面在这里重新订阅。
- `onResume`：接续成功时调，不调 `onOpen`，所以接续后不重发 `hello.resume`。
- `onClose { code, reason }`：会话结束时调。传输的断开与切换只进日志与 `stats()`。
- 保留期内的 `send` 不丢：进客户端的未确认缓冲，接续后按序补发。会话结束后 `send` 才丢弃，计入 `stats().dropped`。这修订了 G.7「断线期间的消息一律丢弃」。

## 5. WebSocket 传输

- 升级：鉴权与现在相同（`auth-contract.md` 第 5 节），另认会话项（第 4.1 节）。回显只回 `promptcut.v1`。
- 接续时，若这个会话还挂着旧的 WebSocket（半开），服务端以 4009 `superseded` 关掉旧的。
- 心跳不变：30 s 一轮 ping，上一轮没等到 pong 就关掉这条传输。关传输只让会话脱开，不结束会话（第 4.2 节）。
- 对讲会话的连接，服务端发出的每条业务消息都带 `seq`，控制消息除外。

## 6. HTTP 长轮询传输

基址、回包的 `Content-Type` 与 `Cache-Control`、跨源规则与第 1 版相同：基址是 `httpBaseOf(文档服务地址)`，托管端经 nginx 时是 `https://8-219-80-16.sslip.io/hosted`，端点在 `<基址>/lp/…`。凭证、会话号只放请求头。

### 6.1 建会话或接续 `POST /lp/open`

- 请求头 `X-Promptcut-Protocols`：与 WebSocket 同一个列表，含会话项；可选 `X-Promptcut-Fallback`（第 4.3 节第 5 条）。
- 服务端把这个请求头当作 `sec-websocket-protocol` 交给同一个 `authenticate(req)`；接续项由会话层按 `sid` 核对。
- 成功 `200 { ok: true, sid, resumed, ack, retainMs, waitMs, maxFrameBytes, protocol: 'promptcut.v1', transport: 'http' }`。
- 失败：鉴权不过 401；请求头缺失或第一项不是 `promptcut.v1` 回 400 `bad-protocols`；关停中或会话数满 503；接续失败 404 / 410（第 4.1 节）。
- 会话数上限 `maxConnections` 按会话计，两种传输共用。

### 6.2 发送 `POST /lp/send`

- 请求头 `Authorization: Bearer <sid>`。请求体 `{ "frames": ["<文本帧>", …] }`，每帧就是带 `seq`（和可选 `ack`）的那条消息文本。第 1 版的批次号去掉，重发靠每帧的 `seq` 去重（第 3.3 节）。
- 回 `200 { ok: true, ack }`。
- 同一时刻只有一个 POST 在途；单帧超限，或整个请求体超过「单帧上限 + 64 KiB」，回 413 并以 1009 结束会话。

### 6.3 接收 `GET /lp/recv?ack=<n>&wait=<毫秒>`

- 请求头 `Authorization: Bearer <sid>`。`ack` 是客户端已收全的服务端最大 `seq`，与第 3.3 节是同一个数，服务端据此释放。
- 回 `200 { ok: true, frames: ["<文本帧>", …], closed }`。帧就是带 `seq` 的消息文本，第 1 版的 `{ seq, data }` 外包去掉。
- 不变的部分：挂起；有新帧立即回，一次最多 1 MiB；同一会话只挂一个 GET，新的来了旧的回 `superseded: true`；会话结束时先回完剩下的帧、再带 `closed`。`wait` 缺省 25 000 ms、上限 30 000 ms；客户端单次 GET 超时 40 s。

### 6.4 结束 `POST /lp/close`

- 立刻结束会话（第 4.2 节「主动结束」）。挂着的 GET 回 `closed`。

### 6.5 脱开与临时错误

- 在 `waitMs + 15 s` 内既没有挂着的 GET、也没来过请求，算传输断开，会话进入保留期（第 4.2 节）。第 1 版「`idleMs` 到了就断线」废除。
- 客户端的单次 GET 或 POST 失败，不立刻算传输断开：在 `retainMs / 2` 内按短退避（250 ms 起，翻倍，封顶 5 s）重试同一请求；超过就按传输断开处理，照第 4.3 节从 WebSocket 重来接续。

### 6.6 跨源

- 同第 1 版：`createDocService` 的 `httpCorsOrigins` 名单缺省为空，为空时不回任何 CORS 头；预检 `OPTIONS /lp/*` 回 204。C10a 的页面与 `/hosted` 同源，用不到它。

## 7. 与核心的接法（组装层）

核心只认 `write`、`buffered`、`close` 与 `drained`（`router.mjs` 文件头）。本版这四个钩子都接到会话层，两种传输在会话层下面：

| 核心钩子 | 会话层做什么 |
|---|---|
| `write(connId, text)` | 补上 `seq`、`ack`，放进未确认缓冲；当前挂着传输就写出去，脱开时只留着 |
| `buffered(connId)` | 未确认的字节数 |
| `close(connId, code, reason)` | 结束会话（不保留），关掉当前传输，挂着的 GET 回 `closed`；之后 `router.disconnect` 与 `conn.close` 日志，照第 1 版推迟到下一轮事件循环 |
| `drained(connId)` | `ack` 推进后调一次 |

组装层用一张 `connId → 会话` 表分派，会话里记当前的传输 `'ws' | 'http' | null`。`router.mjs` 不知道有会话，也不知道有两种传输。

## 8. `/healthz`、诊断与日志

- `/healthz` 加一个组装层字段 `sessions`，取代第 1 版的 `transports`：

  ```json
  "sessions": { "total": 3, "ws": 1, "http": 1, "detached": 1, "legacy": 0,
                "opened": 12, "resumed": 4, "expired": 2, "fallbacks": 1,
                "list": [ { "connId": "conn-7", "transport": "http", "fallback": "ws-error", "detached": false } ] }
  ```

  `list` 每条会话一项，只有 `connId`、`transport`（脱开时为 `null`）、`fallback`、`detached`、`legacy`，不含身份、地址与会话号〔裁：语义要求 `/healthz` 能看出每条会话走的哪种传输；`/healthz` 不鉴权，所以只给这几项〕。
- `describe().conns[i]` 加 `transport`、`fallback`、`detached`、`resumes`。
- 日志：`conn.open`、`conn.close`、`conn.timeout` 带 `transport`；新增 `session.detach`、`session.resume { connId, transport, gapMs }`、`session.fallback { connId, reason }`。会话号与凭证一律不进日志。

## 9. 客户端：`server/render-node/session-link.mjs`

- `createDocEndpoint({ url, protocols, fetch?, WebSocket?, setTimeout?, clearTimeout?, random?, backoff?, log?, now?, waitMs? })`：
  - 返回值与 `createWsEndpoint` 同形状（`send`、`onMessage`、`onOpen`、`onClose`、`close`、`connected`、`closed`、`stats()`），加 `onResume(handler)`；
  - `stats()` 另加 `transport`、`fallbacks`、`resumes`、`pendingBytes`；
  - `url` 收 `ws(s)://` 或 `http(s)://`，内部各换出另一种写法；
  - `protocols()` 每次建会话前现取（一次性随机数只能用一次），转 HTTP 时沿用同一份（第 4.3 节）；
  - 读 `PROMPTCUT_TRANSPORT`（只在 Node 里读；浏览器由调用方传 `transport`）。
- 第 1 版的 `HttpWebSocket`、`createHttpEndpoint` 与现有的 `createWsEndpoint` 留作只走一种传输的底座，给开发者强制和测试用；业务调用方一律改用 `createDocEndpoint`。
- 页面：`src/editor/sync/` 的 `SyncLink` 接同一份会话层，本阶段只走 WebSocket（第 2 节）。
- **代理**：本模块不自己处理代理。Node 22.22 起，出网要经 `HTTPS_PROXY` 时加 `NODE_USE_ENV_PROXY=1` 即可（U11 改写）；TLS 中间人代理的 CA 用 `NODE_EXTRA_CA_CERTS` 信任，不关证书校验。
- `render-node/index.mjs` 导出 `createDocEndpoint`。

## 10. 本机信任：`PROMPTCUT_TRUST_LOOPBACK`

- **取代** `PROMPTCUT_TEST_NO_LOOPBACK_TRUST`。旧名直接删，不留兼容。
- 取值 `1`（回环来源算本机）或 `0`（不算）。缺省 `1`，本机开发、编辑器、本机起的托管组合都照旧。`deploy-hosted` 给阿里云生成的 pm2 配置写 `0`，正式实例与演练实例都写。
- `0` 时，下面四处一律不认回环为本机：
  1. **文档服务握手**：回环不带凭证不再得到本机身份，回 401；本机声明 `promptcut.tenant.*`、`promptcut.role.*` 不认；
  2. **共享 HTTP 端点**（`server/auth/http.mjs`）：按非回环来源处理，挑战与建项目照样受限速；
  3. **素材服务**：回环来的读写同样要票据；
  4. **管理接口**（`/admin/*`、服务地址登记 `service.announce`）：只认集群令牌。
  回环也不再豁免限速。
- **第 1 版之前的缺口**：旧开关只接到了素材服务与管理接口（`server/hosted/combo.mjs` 的 `isLoopbackReq`），没有传给 `createSharedDocService`，文档服务的握手与共享端点仍按套接字对端地址信任回环。阿里云上靠 nginx 的 `proxy_bind` 从内网地址连后端堵住了这个缺口（交接文档第 7 节）。本版要求开关接到上面四处。
- 托管端自己的地址登记（素材服务向同机文档服务登记公网地址）一律带集群令牌。`0` 而没有集群令牌时拒绝启动，打 `config.error { reason: 'cluster-token-required' }`〔裁：`shared-project-contract.md` 第 10 节第 5 条原允许没令牌时以回环本机身份登记，`0` 下这条路不存在了〕。
- 已知代价（不在本版解决）：反向代理之后，限速按来源地址算，经代理进来的请求都算成代理一个来源。

## 11. 验收

| 编号 | 标准 |
|---|---|
| HT1 | 服务端单测：建会话；接续（WebSocket 断后经 HTTP 接续、HTTP 断后经 WebSocket 接续）；补发与去重；跳号 1002；保留期满结束；主动结束立即断线；4003、4004、1013、1001 不保留。open 的鉴权与 WebSocket 同一套（有效证明进、错证明 401、随机数重用 401 且不计数、限速生效）。send 按帧去重、单 POST 在途；recv 的挂起、单 GET 替换、`closed` 下发。`/healthz` 的 `sessions`，含每条会话的传输 |
| HT2 | 背压：客户端不确认时核心以 1013 结束会话；保留期内未确认的字节涨过上限，同样 1013；合并键照常生效 |
| HT3 | 等价性：同一组模块测试在「只走 WebSocket」「只走 HTTP」「中途断开再接续」三种情况下结果相同。至少覆盖 render-queue 的认领、完成、断线放回，project 的提交与 stale，content 的 put 与 watch |
| HT4 | 客户端单测：先 WebSocket、失败转 HTTP、沿用同一份列表；每次重连从 WebSocket 重试；`PROMPTCUT_TRANSPORT` 强制；接续调 `onResume` 不调 `onOpen`；保留期内 `send` 不丢、接续后按序补发；会话结束后丢弃并计数；临时错误重试不报断开；404、410 重建会话 |
| HT5 | 本机托管组合加同形 nginx 路由（或阿里云第二实例），`shared-project-probe` 的 member 在强制 ws、强制 http、自动三种设置下全部通过 |
| HT6 | 本机信任：`PROMPTCUT_TRUST_LOOPBACK=0` 时，回环不带凭证握手 401，回环不带票据读素材 401，回环不带令牌调管理接口 401；`=1` 时行为不变；旧名 `PROMPTCUT_TEST_NO_LOOPBACK_TRUST` 不再生效 |
| HT7 | 阿里云部署后，从外网经 443：匿名 WebSocket 升级被拒（401）；匿名读素材 401；不带令牌调管理接口被拒 |
| HT8 | 云端代理下的长轮询：从云端容器经代理挂满 25 s 的 GET 不被掐断，连续 10 次都如此（U3 的实测） |
| HT9 | **硬验收**：云端容器作为独立渲染主机，经信箱收指令，认领并完成真实预渲染任务。记录它实际用的传输（自动选择的结果）与降级原因（U13） |
| 通用 | G0；旧客户端（不带会话项）行为不变，现有测试不改期望 |

## 12. 部署与云端

- **阿里云**：
  - `deploy-hosted` 生成 pm2 配置时写 `PROMPTCUT_TRUST_LOOPBACK=0`。
  - 两个公网地址要能从参数给（`--doc-public-url`、`--asset-public-url`），重新部署时不再被改回 `ws://…:8787`、`http://…:8788`〔裁：交接文档第 7 节记的隐患，不修就无法正常部署 HT〕。
  - nginx `/hosted` 补 `client_max_body_size 2m; proxy_buffering off;`，WebSocket 的升级头与 `proxy_read_timeout 3600s` 照旧。`proxy_bind` 在开关生效后可以保留，作为多一层防护。
- **云端节点**：经信箱收指令。Node 进程加 `NODE_USE_ENV_PROXY=1`；Chrome 以 root 运行要 `PC_CHROME_ARGS=--no-sandbox`；无头 Chrome 的 TLS 被代理重新签发，要信任代理的 CA，做法见主计划 T9 的注，不关证书校验。

## 13. 查资料的结论（codex，`gpt-6-sol` / `high`，第 1 版）

| 题 | 结论 | 怎么用 |
|---|---|---|
| 长轮询 vs SSE 过代理 | 代理与网关可能缓冲响应体，SSE 被缓冲时事件成批或到结束才到；长轮询每次是完整 JSON，不依赖中途刷新 | 采纳：只做长轮询，不做 SSE |
| 挂起时长 | GCP LB 默认 30 s、AWS ALB 空闲 60 s、nginx `proxy_read_timeout` 60 s；建议 20～25 s、上限 30 s，客户端超时 35～40 s | 采纳：`waitMs` 25 s，上限 30 s，客户端单次 GET 超时 40 s |
| Node 走代理 | `NODE_USE_ENV_PROXY=1` / `--use-env-proxy` 让 `fetch` 经 CONNECT；全局 `WebSocket` 读不读代理没有出处保证 | 采纳，版本改为 Node 22.22 起（第 9 节）；WebSocket 经代理在云端容器实测可用（第 1 节） |
| nginx | 1.24 连上游默认 HTTP/1.0，要显式 `proxy_http_version 1.1`、清 `Connection`；`client_max_body_size` 与 POST 上限一致 | 采纳（第 12 节） |
| 浏览器 | HTTP/1.1 每源约 6 条连接，挂起的 GET 占一条；自定义头触发预检；后台页定时器节流 | 采纳：凭证放 `Authorization`；页面的 HTTP 回落随 C10a 同源接上 |
| 协议先例 | Engine.IO：握手取 sid、同一会话只一个 GET 与一个 POST；CometD：按批确认、队列上限 | 采纳，扩展为双向序号与确认（第 3 节） |
| 会话号安全 | sid 即 bearer 凭证：CSPRNG ≥ 128 位、只放请求头、空闲过期；CORS 不防 CSRF | 采纳：256 位、只放请求头、保留期满作废；不用 Cookie，没有 CSRF 面 |

## 14. 第 1 版的裁定与实现记录：新模型下保留还是废弃

第 1 版契约第 13 节「实现记录」、交接文档第 3 节「八条裁定」与第 4 节「实现与契约不一致的地方」，逐条对照如下。交接文档第 4 节的六条都在本表里（标「交 4」）。

| 第 1 版的条目 | 新模型下 | 说明 |
|---|---|---|
| 八条裁定 1：由配置显式选传输，不自动降级〔裁〕 | **废弃** | 改为自动选择（第 4.3 节）；K1 不认 |
| 八条裁定 2：只做长轮询，不做 SSE | 保留 | |
| 八条裁定 3：挂 25 s、上限 30 s、客户端超时 40 s、空闲 60 s 过期 | 前三个保留；「空闲 60 s 过期即断线」**改** | 改为「脱开 + 保留 60 s」（第 4.2、6.5 节） |
| 八条裁定 4：会话过期等同断线，不做跨会话接续 | **废弃** | U6 不认；改为会话内接续（第 4 节），过了保留期才等同断线 |
| 八条裁定 5：同一会话只挂一个 GET，新的替换旧的 | 保留 | 推广到两种传输：一个会话同一时刻只挂一条传输（第 3.1 节） |
| 八条裁定 6：会话号只放 `Authorization` 头，256 位 | 保留 | WebSocket 接续时会话号放在 `Sec-WebSocket-Protocol`（第 4.1 节） |
| 八条裁定 7：跨源名单缺省为空 | 保留 | U9 认 |
| 八条裁定 8：挂载模式只交出处理函数，vite 不接线 | 保留 | 直连计划启动时重新评估 |
| 服务端：端点前缀 `<path>/lp/…` | 保留 | |
| 服务端：open 的判定顺序（503 → 400 → 读体 → 503 → 鉴权） | 保留 | 另加：接续项在鉴权之前按 `sid` 查，查不到 404 / 410 |
| 服务端：交给 `authenticate` 的是 `Object.create(req)`，只换请求头 | 保留 | |
| 服务端：缺 `Authorization` 回 404、`bad-ack` 回 400、`bad-request` 回 400、整个请求体超限 413 并以 1009 关闭（交 4） | 保留 | `bad-ack` 改按会话里服务端发出过的最大 `seq` 判 |
| 服务端：注销推迟到下一轮事件循环（交 4） | 保留 | 会话结束时同样推迟 |
| 服务端：墓碑的时机（服务端关、客户端不取、客户端 close、过期） | **改** | 墓碑只在会话结束时立；传输断开只脱开，不立墓碑 |
| 服务端：挂着的 GET 被新帧叫醒后推迟一轮再回，攒批（交 4） | 保留 | |
| 服务端：关停回 `closed: { 1001 }` 并带 `Connection: close` | 保留 | |
| 服务端：`/healthz` 的 `transports` 字段 | **废弃** | 换成 `sessions`（第 8 节） |
| 服务端：部署清单不用改 | 保留 | 新文件 `session.mjs` 在同一目录，自动带上 |
| 节点端：计时器分两组，另有 `now`、`requestTimeoutMs`（交 4） | 保留 | |
| 节点端：日志沿用 `ws.*` 事件名（交 4） | **改** | 会话层另打 `session.*`（建立、接续、降级、结束）；传输层的事件名原样 |
| 节点端：错误归类（临时错误重试；404 → 1006；410 → 墓碑码；413 → 1009；409、400、401 → 1006） | **改** | 404、410 走「重建会话」；401 是鉴权失败，不转传输；409 跳号不再有（按帧去重）；其余保留 |
| 节点端：挂起时长取两边较小的 | 保留 | |
| 节点端：WebSocket 形状的细节（CONNECTING 时 `send` 抛错等） | 保留 | 这些是 `HttpWebSocket` 底座的行为；会话层在上面另排队 |
| 节点端：分批按转义后的 JSON 长度计 | 保留 | 批次号去掉 |
| 选用：共享项目配置项的 `transport` 字段 | **废弃** | 删掉字段、规整逻辑与它的测试（第 15 节） |
| 选用：`vite-plugin-frames.ts` 按 `entry.transport` 选端点 | **废弃** | 三处都改用 `createDocEndpoint` |
| 选用：`hostAssetClient` 把 `https:` 文档服务地址推成 `https:` 素材地址（交 4） | 保留 | |
| 选用：没接 HTTP 的两处（预渲染推送、本机队列节点） | **改** | 本阶段一并接上 `createDocEndpoint` |
| 选用：探针的 `--transport` | 保留 | 作为开发者强制参数，缺省改为自动；成员配置里不再写 `transport` |
| 验证记录（HT1～HT5 本机版、阿里云第二实例） | **作废** | 按第 11 节重跑 |

## 15. 返工清单（`claude/http-transport`，相对 `7477acd`）

合并与顺序：
- 先等 `claude/coord-mailbox` 与 `claude/ht-plan` 合入 main，再把 main 合进 `claude/http-transport`（用合并，不改写历史）。
- `docs/plan/http-transport-contract.md` 冲突时取 main 的版本（本版）；实现记录改在本版之后另起一节。

要改的文件：

| 文件 | 返工 |
|---|---|
| `server/docservice/session.mjs`（新） | 会话层：会话表、序号与确认、保留与补发、脱开与结束、`sessions` 统计（第 3、4、7、8 节） |
| `server/docservice/service.mjs` | WebSocket 升级认会话项、替换半开的旧连接；两种传输接到会话层；`/healthz` 换成 `sessions` |
| `server/docservice/http-transport.mjs` | 去掉批次号；帧带 `seq`；`recv` 的帧改为纯文本；`open` 认会话项与 `X-Promptcut-Fallback`；脱开代替过期；墓碑只在会话结束时立 |
| `server/render-node/session-link.mjs`（新） | `createDocEndpoint`：自动选传输、沿用同一份列表转 HTTP、序号与确认、接续、补发、`onResume`、`PROMPTCUT_TRANSPORT`（第 4.3、4.4、9 节） |
| `server/render-node/http-transport.mjs`、`ws-transport.mjs` | 留作底座；错误归类按第 14 节改 |
| `server/render-node/index.mjs` | 导出 `createDocEndpoint` |
| `server/auth/shared-config.mjs` | 删 `transport` 字段与相关规整；删 `5cdf8f7` 的测试 |
| `server/vite-plugin-frames.ts` | 本机队列节点、预渲染推送、独立渲染主机三处改用 `createDocEndpoint` |
| `server/agent/doc-link.mjs` | 改用 `createDocEndpoint`（或由它生成的会话化 WebSocket 工厂） |
| `src/editor/sync/` | `SyncLink` 讲会话：序号与确认、接续；本阶段只走 WebSocket |
| `scripts/probes/shared-project-probe.mjs`、`render-queue-e2e.mjs` | `--transport` 缺省为自动；成员配置不再写 `transport` |
| `server/hosted/main.mjs`、`server/hosted/combo.mjs`、`server/docservice/shared-service.mjs`、`server/auth/http.mjs`、`server/docservice/main.mjs` | `PROMPTCUT_TRUST_LOOPBACK` 接到四处（第 10 节）；删旧名；`sp-hosting.test.mjs` 相应改名 |
| `server/hosted/deploy.mjs`、`scripts/remote/docservice.mjs` | pm2 配置写开关；公网地址参数（第 12 节） |
| 测试 | `1892c1f`、`da0ea0a`、`234e33e` 的三个测试文件按第 11 节改写；`fake-transport-kit.mjs` 保留并扩展 |

`claude/coord-mailbox` 要跟着改（在它合入 main 之前，或合入后另起一个小提交）：
- `MAIL_DEFAULTS.QUEUES` 加 `to-pc`、`from-pc`（主计划第 6 节）；
- `MAIL_DEFAULTS.KINDS` 加 `status`，给上线、下线报到用〔裁：报到不是某条指令的回执，单列一种更好过滤〕；
- 文件头注明：在 Claude Code 里等消息，用一条后台运行的 `wait` 命令，由它内部循环长轮询，不要让模型逐次轮询；
- 阿里云上的 `probe-coord` 用新版本重启，`mail.jsonl` 原样保留，信箱令牌不变。
