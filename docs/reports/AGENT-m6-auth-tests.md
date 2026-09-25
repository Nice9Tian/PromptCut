# AGENT 报告：M6a 鉴权契约测试（测试方）

分支 `claude/m6-auth-tests`，worktree `.worktrees/m6-auth-tests`。依据只有 `docs/plan/auth-contract.md`（以及主执行计划第 12 节），没有看实现分支 `claude/m6-auth`。
可读的现有公共接口只用来知道怎么起服务、怎么连：`server/docservice/service.mjs`（`createDocService`、`describe()`）、`router.mjs`、`main.mjs`（环境变量与 `listen` / `config.error` 日志行）、`modules/*.mjs` 的消息类型、`server/render-queue/messages.mjs` 的类型表、`server/asset-service.ts` 的 `assetServiceMiddleware`、`server/test/fake-ws-kit.mjs` 与 `asset-store-http.test.mjs` 的写法。

## 做了什么

新增 7 个文件，都在 `server/test/`：

| 文件 | 内容 | 用例数 |
|---|---|---|
| `auth-kit.mjs` | 共用工具（不是测试文件）。**假设的服务端接口全部集中在这里**（见下文「假设的接口」），集成对账只需改这一个文件的 `assemble` 与 `assetMiddleware` | — |
| `auth-create.test.mjs` | AU1 | 7 |
| `auth-handshake.test.mjs` | AU2、AU3、AU8、AU14，`client.mjs` 对拍 | 20 |
| `auth-members.test.mjs` | AU4、AU5、AU6、AU10 | 13 |
| `auth-tickets.test.mjs` | AU7 | 12 |
| `auth-spaces.test.mjs` | AU9、AU11 | 7 |
| `auth-main.test.mjs` | AU12、AU13 | 5 |

合计 **64 条用例**。AU15 按分工归实现方，没写。

### 测试怎么做到只依赖契约

- **协议在测试里自己实现**：派生（PBKDF2-HMAC-SHA256）、挑战、握手证明 `m`、创建者操作证明、票据的解析与篡改都用 `node:crypto` 照契约第 2、4、5、7、8 节现算，不经 `client.mjs`。这样核对的是线上格式本身；`client.mjs` 另有一条用例对拍（见 AU2 最后一条）。测试用 `iter: 100000`（契约允许的下限）省时间。
- **模拟非回环来源**：服务一律绑 `127.0.0.1`、端口 0。URL 查询串带 `__remote=<地址>` 时，测试在服务器的 `request` / `upgrade` 事件上抢先挂的监听把 `req.socket.remoteAddress` 改成该地址、并从 `req.url` 删掉这一项，实现看不到它；没带的请求恢复成原来的回环地址（keep-alive 复用的 socket 不串）。已用现有 `createDocService` 自检过：`authenticate` 看到的对端地址分别是 `10.0.0.5`、`127.0.0.1`、`203.0.113.1`，`req.url` 已还原为 `/`。
- **观察 principal**：用现有的 `service.describe().conns[].principal`。
- **观察写入身份**：用 `content.watch` 收到的 `content.changed.actor`、`project.open` 后收到的 `project.rev.actor`。
- **关闭码**：Node 内置 `WebSocket` 的 `close` 事件的 `code` / `reason`。
- **握手状态码**：`fake-ws-kit.mjs` 的 `rawHandshake`（原始 TCP 握手，读得到 401 与回显的子协议）。
- **注入时钟**：`testClock()` 跟着真实时间走，`advance(ms)` 往前拨；作为 `now` 传给组装入口，nonce 过期、票据过期、限速冷却、每小时建项目上限都靠它。
- **回包匹配**：按 `reqId` 等回包。契约没写 `shared.*`、`auth.ticket` 的回包带不带 `reqId`，所以 `ask(c, msg, types)` 在给了 `types` 时，也接受不带 `reqId`、类型在 `types` 里或是 `error` 的消息。

## AU 编号与用例对应

| 编号 | 用例（文件：用例名摘要） |
|---|---|
| AU1 | create：两种模式建成（`sp_<26 位 base32>`、lookup、凭证文件落在 `auth/projects/`、`auth/server.json` 生成）；同名 409（大小写、NFC/NFD）；字段缺失或不合法 400（17 种）；超 64 KiB 回 413、OPTIONS 预检；挂载模式非回环 403；托管端同一来源第 11 个 429、别的来源不受影响、一小时后恢复；`shared/challenge` 形状、404、400 |
| AU2 | handshake：证明对 101、只回显 `promptcut.v1`、principal 字段齐全；创建者进入 `creator: true`；证明错 401（口令错、m 随机、m 不是 32 字节、m 33 字节）；nonce 复用 401；nonce 失败一次也作废；nonce 过期（59 s 有效、61 s 401）；四元组不符（username、deviceId、projectId、as）401；证明格式（r、c、o、JSON 超 1024 字节、v）401，合法组合 101；至多一项鉴权；回环什么都不带是本机身份（两种模式）；`client.mjs` 对拍 |
| AU3 | handshake：名单内成功、创建者自动在名单里；名单外挑战形状相同、同名同盐、不同名不同盐、`as: creator` 非创建者也回稳定伪盐、随后 401；伪盐随时间不变 |
| AU4 | members：两台同名设备 userId 不同、都显示 `用户名 (设备名)`；`shared.watch` 收到离开后的推送；剩一台只显示用户名 |
| AU5 | members：`set-password`、`set-list`、`kick` + `unban`、`delete`（4004、记录与 `tenants/<id>/` 删除、名字释放）各一条；不带证明、证明错、用项目口令算的证明、非创建者、别的连接取的 nonce 一律 `forbidden` 且不生效；逐条列出 29 种数据面消息，创建者与成员的结果（`type` 与 `reason`）一致 |
| AU6 | members：`set-list` 移出后该用户名的全部连接（含另一台设备）5 s 内 4003 `removed`、再握手 401、其余人不受影响；`kick` 后 4003 `kicked`、素材票据与连接票据立即 401、同名同设备再进入 401、同名换设备与同设备换名不受影响、`unban` 后能进、新票据可用 |
| AU7 | tickets：票据形状与负载字段；Bearer 与查询串读、HEAD、Range、`no-store` 与 `no-referrer`；读的 401 各情形（无票据、签名错、负载被改、查询串用读写票据、超长）；过期（偏差内有效、超出后下一个 Range 401）；写的 401/403 各情形（含 `complete`）；`set-password`、`set-list` 后旧票据 401；`kick` 后被踢者 401、别人不受影响；回环不带票据照常、集群令牌不再用于素材服务；票据不限定哈希；CORS 允许 `Authorization`；日志不含票据 |
| AU8 | handshake：错 5 次后挑战 429、口令对也 401、别的来源照常、58 s 仍冷却、61 s 恢复；错 4 次还能进、一分钟外的失败不累计；nonce 不对也算、回环不计数；创建者操作证明错计入、冷却中回 `rate-limited`、61 s 后恢复 |
| AU9 | spaces：两个共享项目与 `local` 空间互相收到 0 条、同名键与同名项目各自独立；`tenants/<projectId>/` 落盘、`local` 不在 `tenants/` 下；队列按空间隔离（快照里没有、认领回 `gone`）；局域网主机的本机声明与成员同一空间、principal 字段、非回环 401、项目不存在 401 |
| AU10 | members：page、agent 发 `node.hello` 回 `forbidden`，render 与 `local` 可以；agent 写入的 actor 带对话号与 session、page 写入的 actor 角色为 page、`project.rev.actor` 同样；page + render + agent + agent 的 render 聚成一行、标签与 conns 正确、认领后 `rendering` 为真；纯浏览器节点同名不同设备 `forbidden`、独立主机与本机 PC 能认领别人的任务 |
| AU11 | spaces：令牌连接是 `{ userId: admin, tenantId: null, scope: admin }`、18 种数据面消息都 `forbidden`、`service.announce` / `watch` / `withdraw` 成功；成员 announce、withdraw 回 `forbidden`，watch 看得到；`local` 能登记；令牌错、令牌 + 证明、两个令牌项 401；没设令牌时带令牌握手 401；挂载模式非回环带令牌 401 |
| AU12 | main：数据目录是文件 + 绑 `0.0.0.0` → 退出码 1、`config.error { reason: auth-store }`；绑 `0.0.0.0` 不设令牌照常启动、带令牌握手 401、`shared/lookup` 可用；令牌格式错仍 `bad-token-format`；子进程里建项目、握手、`auth/projects/` 落盘、输出不含口令与 K |
| AU13 | main：进程内一整套流程（成功与失败的握手、票据、素材读写、创建者操作、踢人再进入、HTTP 错误），收集的秘密（口令、K、m、证明子协议、票据全文与负载段与签名段）不出现在任何日志行与错误回包里；每条 `auth.reject` 带 `remote`、`reason` 在约定集合里，且应出现 `bad-proof`、`nonce`、`multiple`、`no-credential`、`bad-format`、`no-project`、`banned` |
| AU14 | handshake：页面要 `render` 连接票据，另一条连接凭它进入，身份字段与页面相同、角色 render、owner 带上、有效期 ≤ 2 分钟、过期后 401；agent 票据带对话号；签名错 401；素材票据不能当连接票据；`local` 要不到票据 |

## 假设的接口（主会话集成时对账）

契约第 11 节只写了客户端；服务端组装入口没写死。下面是我的假设，**全部集中在 `server/test/auth-kit.mjs`**，实现方的名字对不上时只改那里的 `assemble()` 与 `assetMiddleware()`。

1. `server/auth/index.mjs` 导出 `createSharedHost(options) → host`：
   - `options.dataDir`：数据目录；凭证存储在 `<dataDir>/auth/`，共享项目空间在 `<dataDir>/tenants/<projectId>/`（独立模式；挂载模式由插件把 `<root>/out/docservice` 传进来）。
   - `options.server` + `options.path`：给了就是挂载模式，WS 路径 `/docservice`，HTTP 端点 `/docservice/shared/…`。
   - `options.now`：注入时钟（nonce、票据、限速、每小时建项目上限）。
   - `options.log(event, fields)`：文档服务与鉴权的日志都走它。
   - `options.device`：`{ deviceId, deviceName }`，本机声明用。
   - `options.clusterToken`：独立模式的集群令牌。
   - 返回 `host.service`（`createDocService` 的返回值，用 `describe()` 与 `server`）、`host.auth`（凭证存储，交给素材服务）、`host.handleHttp(req, res) → boolean`（挂载模式由宿主调；独立模式 host 已自己接好）、`host.listen(port, hostname)`、`host.close()`。
2. `server/asset-service.ts` 的 `assetServiceMiddleware(root, { stores: { media }, auth: host.auth })`：凭 `host.auth` 核对票据，时钟随 `host.auth`。
3. `server/auth/client.mjs`：
   - `deriveKey(password, salt, kdf) → Promise<string | Uint8Array>`（base64url 字符串或字节都接受）；
   - `buildAuthProtocols({ base, projectId, username, deviceId, deviceName, as, password | key, role, conversation, owner }) → Promise<string[]>`，`base` 是文档服务的 HTTP 基址、以 `/` 结尾（独立模式 `http://host:port/`，挂载模式 `http://host:port/docservice/`），客户端在其后拼 `shared/challenge`；
   - `ticketExpiry(ticket) → number`，等于 `auth.ticket.ok.exp`。
4. 消息与回包：`shared.members → shared.members.list`、`shared.challenge → shared.challenge.ok`、`shared.admin → shared.admin.ok | error`、`auth.ticket → auth.ticket.ok`；创建者操作的字段与 `op` 平级（`{ type: 'shared.admin', op, proof, username, deviceId }`、`{ …, project }`、`{ …, list }`）。
5. principal 通过现有的 `describe().conns[].principal` 暴露，含契约第 6 节的全部字段。
6. `main.mjs` 沿用现有环境变量：`PROMPTCUT_DOCSERVICE_DATA` 就是契约说的「数据目录」。

## 契约里有歧义的地方（建议主会话裁定后补进契约）

1. **派生的盐怎么喂给 PBKDF2**：契约说盐是「16 字节随机数，base64url」，`K = KDF(口令, 盐)`。我按「base64url 解码后的 16 字节」喂，口令按 UTF-8、不做 NFC 规范化。服务端从不派生，不影响服务端用例；但 `client.mjs` 的对拍用例按这个理解断言。
2. **HMAC 的密钥**：`HMAC-SHA256(K, …)` 我按「K 的 32 字节原始值」作密钥，不是 base64url 字符串。
3. **`shared.*` 与 `auth.ticket` 的回包带不带 `reqId`**：没写。测试两种都接受。
4. **`shared.watch` 有没有立即回包**：只写了「之后每次变化都收到 `shared.members.list`」。测试不依赖立即回包。
5. **非创建者能不能取 `shared.challenge`、拿到的是什么盐**：第 7 节说「除上表之外创建者和普通成员的一切行为完全相同」，我据此在 AU5 的逐条对比里把 `shared.challenge` 算进「结果一致」。如果实现让非创建者取挑战回 `forbidden`，这一条会失败，需要裁定。
6. **「不是创建者」指什么**：是「这条连接不是以 creator 进来的」，还是「证明不对」？特权绑每次的证明、不靠会话角色（主执行计划 12.2），那么一个以 member 进来的连接如果拿得出创建者证明算不算？测试只断言「成员按自己的口令算证明 → forbidden」，没测这一种。
7. **本机声明在独立模式下认不认**：第 5 节写「只在回环来源上认」，没限定模式。AU13 在独立模式下用本机声明触发 `no-project`，假设独立模式也认。
8. **限速冷却中握手被拒算不算新的失败**：契约说失败是「证明不对、nonce 不对」；测试假设因冷却被拒不再累计（否则冷却会被持续延长，「61 s 后恢复」无从谈起）。
9. **`set-list` 移出的「其全部连接」**：我理解为这个用户名在所有设备上的连接（AU6 断言另一台设备上的 agent 连接也以 4003 关闭）。
10. **`delete` 的回包**：连接可能在 `shared.admin.ok` 之前就被关。测试两种都接受，只要求 4004。
11. **创建者操作的字段形状**：`kick`、`unban` 的 `username, deviceId` 与 `op` 平级（和 `proof` 同一层），没有嵌套。
12. **挂载模式下回环来源带集群令牌**：第 10 节说「集群令牌在挂载模式下一律不认」，没说回环带令牌时是 401 还是退回本机身份。测试只断言非回环 401。
13. **`name` 的「控制字符」**：按 C0（含 `\u0001`）测，没测 C1 与 `\u007f`。
14. **AU7「签名错」对应的 `kid` 轮换**（`oldTicketKeys`）没有公开的触发方式，没测。
15. **素材服务的访问日志**：素材服务在 TS 里、日志不走 `options.log`，AU7 最后一条只检查了文档服务那一侧的日志；「访问日志只记路径不记查询串」严格说没覆盖到，需要实现方给素材服务一个可注入的 `log` 才能测。

## 验证结果

- `node --check` 7 个文件：全部通过（退出码 0）。
- 自检：
  - `installRemoteOverride` 与 `wsClient` / `rawHandshake` 配合现有 `createDocService` 跑通：两次握手都 101，对端地址改写正确；
  - `credential` / `derive` / `tamperTicket` / `flipSignature` 输出形状正确（盐 22 字符、K 43 字符）；
  - `loadAsset()` 能把现有 `asset-service.ts` 转译载入（三个导出都是函数）。
- `node --test server/test/auth-create.test.mjs`：7 条全部失败，原因都是 `ERR_MODULE_NOT_FOUND: server/auth/index.mjs`。这是预期的：本分支没有实现，每条用例各自失败、原因写清楚，不会崩掉整个文件。
- 没跑 `npm test` 全量与 `tsc`：本分支只加测试文件，实现不在本分支，新测试必然红；合并时应与实现分支一起跑。

## 没做的与原因

- AU15（旧行为保持）按分工归实现方。
- 契约第 11 节的 `createWsEndpoint({ protocols })`、`asset-store/client.mjs` 的 `ticket()` 与 401 重试、`PROMPTCUT_SHARED_CONFIG`：不在 AU1～AU14 里，没写单测。建议实现方在 AU15 或另立编号补上。
- 整台服务 1000 个共享项目的上限：AU1 没列，没测（要建 1000 个，耗时）。
- 伪盐跨重启稳定（`auth/server.json` 持久）：需要组装入口支持指定已有数据目录重启；按现在的假设接口可以做，但 AU3 没要求，没写。
