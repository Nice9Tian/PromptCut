# 共享项目的凭证、连接角色与票据：契约（M6a）

状态：**定稿**（2026-09-26，主会话）。依据：
- 主执行计划 `docs/plan/Master-Execution-Plan.md` 第 12 节（D9）、第 7 节 M6；
- 语义 `docs/semantics/architecture/document-service.md`「共享项目与权限」「渲染任务队列」、`asset-storage.md`「凭票据读写」、`workflow/project.md`「共享项目」；
- 查资料的结论见第 13 节（codex `gpt-6-sol`）。

实现方照本文写 `server/auth/`、改文档服务与素材服务；测试方只照本文写测试，不看实现。〔裁〕是主会话在 D9 授权范围内定的细节。

---

## 1. 名词

| 名词 | 含义 |
|---|---|
| 共享项目 | 权限的隔离单位。`projectId` 形如 `sp_<26 位小写 base32>`，服务端生成；`name` 由创建者给，同一台文档服务上不分大小写唯一 |
| 身份 | `用户名 + 设备`。`userId = <用户名>@<deviceId>`，两种进入方式、创建者都一样 |
| 设备 | `deviceId`：客户端给的稳定标识，16～64 个 `[A-Za-z0-9_-]`；`deviceName`：给人看的名字，1～64 个字符。服务端不核实设备，只记录 |
| 连接角色 | 每条连接各带一个：`page`（页面）、`agent`（Agent 的一个对话）、`render`（渲染）。`render` 可以标归属：归真人，或归某个 Agent 对话 |
| 数据面 | 项目、内容库、渲染任务队列、成员列表、素材读写 |
| 管理接口 | 服务地址登记（`service.announce` / `service.withdraw`）、管理用 HTTP、迁移导出 |

## 2. 口令派生

- 客户端从口令算出**派生密钥** `K = KDF(口令, 盐)`，服务端只存 `K`，口令本身从不离开客户端。
- KDF 定为 **PBKDF2-HMAC-SHA256，60 万次，输出 32 字节**，记作 `kdf: { alg: 'pbkdf2-sha256', iter: 600000 }`（第 13 节）。
  - Node 用 `crypto.pbkdf2`；浏览器在安全上下文里用 `crypto.subtle.deriveBits`。
  - 没有 `crypto.subtle` 的页面（明文 http 打开的远端页面，C10 才会遇到），用仓库内自带的纯 JS 实现兜底，并以 `node:crypto` 的结果对拍。
  - 服务端从不做派生：建项目、改口令时都由客户端算好 `K` 交上来。
  - 参数随记录保存（`kdf` 字段），以后换参数不影响老记录；服务端只接受 `iter` 在 10 万到 500 万之间的记录。
- 盐：16 字节随机数，base64url。每个口令一份：项目口令、名单每条、创建者各一份。
- `K`：32 字节，base64url。

## 3. 存储

- 目录：文档服务的数据目录下 `auth/`。每个共享项目一个文件 `auth/projects/<projectId>.json`，写入走临时文件加改名。另有 `auth/server.json`（服务端密钥，第 8 节），首次启动生成。
- 项目记录：

```json
{
  "v": 1,
  "projectId": "sp_…",
  "name": "demo",
  "mode": "free | restricted",
  "createdAt": 0,
  "kdf": { "alg": "…", "…": "…" },
  "creator": { "username": "alice", "salt": "…", "key": "…" },
  "project": { "salt": "…", "key": "…" },
  "list": [{ "username": "bob", "salt": "…", "key": "…" }],
  "generation": 1,
  "userGenerations": { "<userId>": 1 },
  "bans": [{ "username": "carol", "deviceId": "…" }],
  "ticketKey": "<32 字节 base64url>"
}
```

- `project` 只在自由进入时有；`list` 只在限定进入时有。限定进入不设项目口令〔用户已接受〕；创建者在限定进入下自动算名单的一员，不出现在 `list` 里，也不能被删。
- 项目名唯一性按 `name.normalize('NFC').toLowerCase()` 比较。名字 1～64 个字符，不含控制字符与 `/`。

## 4. HTTP 端点

独立模式挂在文档服务自己的 http 服务器上；挂载模式（vite）挂在 `<WS 路径>/shared/…`，即 `/docservice/shared/…`。下文写相对路径 `shared/…`。

- 全部返回 JSON，`Cache-Control: no-store`，`Access-Control-Allow-Origin: *`（不带凭证），答 `OPTIONS` 预检。
- 请求体上限 64 KiB，超出回 413。
- 错误统一为 `{ ok: false, error: '<原因>' }`。

| 端点 | 请求 | 成功 | 失败 |
|---|---|---|---|
| `POST shared/create` | `{ name, mode, kdf, creator: { username, salt, key }, project?: { salt, key }, list?: [{ username, salt, key }] }` | 201 `{ ok: true, projectId, name, mode }` | 400 `bad-request`；409 `name-taken`；429 `rate-limited`；403 `forbidden`（见下） |
| `GET shared/lookup?name=<名>` | — | 200 `{ ok: true, projectId, name, mode }` | 404 `no-project` |
| `POST shared/challenge` | `{ projectId, username, deviceId, as: 'member' \| 'creator' }` | 200 `{ ok: true, nonce, salt, kdf, mode }` | 404 `no-project`；400 `bad-request`；429 `rate-limited` |

- **谁能建**〔裁〕：
  - 独立模式（托管端）：任何来源都能建。同一来源地址每小时最多 10 个；整台服务最多 1000 个共享项目，超出回 429 `rate-limited`。
  - 挂载模式（局域网主机）：只有本机回环来源能建，别的回 403 `forbidden`。
- **挑战**：
  - `nonce` 是 32 字节随机数（base64url），只能用一次，60 s 过期，绑定 `(projectId, username, deviceId, as)`。
  - `salt` 按 `as` 与模式给：`creator` 给创建者的盐；自由进入的 `member` 给项目口令的盐；限定进入的 `member` 给名单里这个用户名的盐。
  - **用户名不在名单里时，不暴露**：回一个伪盐，值为 `HMAC-SHA256(serverSecret, projectId + '\n' + username)` 的前 16 字节，同一用户名每次都一样。之后的握手按「证明不对」失败，与口令错无法区分。
  - `as: 'creator'` 而用户名不是创建者时，同样回伪盐。
  - 同一来源在挑战上也受第 9 节限速。

## 5. WebSocket 握手

客户端在 `Sec-WebSocket-Protocol` 里给 `promptcut.v1`，再加下面**至多一项**鉴权（给了多项一律 401）：

| 项 | 形状 | 得到 |
|---|---|---|
| 证明 | `promptcut.auth.<base64url(JSON)>`，JSON 为 `{ v: 1, p: projectId, u: username, d: deviceId, dn: deviceName, as, nonce, m, r: role, c?: 对话号, o?: 归属 }`。<br>`m` = base64url(HMAC-SHA256(K, 用途串))，用途串为 UTF-8 的 `"promptcut.auth.v1\n" + projectId + "\n" + username + "\n" + deviceId + "\n" + as + "\n" + nonce`。`m` 解码后必须恰好 32 字节 | 该项目的成员身份 |
| 连接票据 | `promptcut.ticket.<票据>`（第 8 节，`k: 'conn'`） | 签发票据的那个身份，角色按票据 |
| 本机声明 | 只在回环来源上认：`promptcut.tenant.<projectId>`，可再加 `promptcut.role.<page\|agent\|render>` | 本机信任的该项目身份 |
| 集群令牌 | `promptcut.token.<令牌>`（M5 的格式） | 管理身份，只能用管理接口 |

- **回环来源什么都不带**：得到本机身份 `{ userId: 'local', tenantId: 'local', scope: 'local', role: 'page' }`。本机未共享的项目都在 `local` 空间里，和 M5 的行为一样。
- **本机声明**：用于局域网主机上创建者自己的页面和预渲染进程加入本机托管的共享项目。
  - 身份为 `{ userId: 'local@<本机 deviceId>', tenantId: projectId, creator: true, role }`；
  - `deviceId` 与 `deviceName` 取服务启动时给的本机设备信息；
  - 项目不存在回 401。
- **证明的核对**：
  - `nonce` 必须存在、未用过、未过期，且绑定的四元组与 JSON 里的一致；核对后 `nonce` 立即作废，不论成败；
  - `m` 按定长比较；
  - `r` 必须是三种角色之一；
  - `c` 在 `r: 'agent'` 时必填，是正整数；
  - `o` 只在 `r: 'render'` 时可给，取 `{ kind: 'user' }` 或 `{ kind: 'agent', c: <对话号> }`；
  - 名单或禁入表不允许时，一律 401。
- **集群令牌不给数据面任何权限**：带令牌项的连接得到管理身份 `{ userId: 'admin', tenantId: null, scope: 'admin' }`，只能收发管理接口的消息。同一连接不能再带别的鉴权项。
- **回显**：只回显 `promptcut.v1`。
- **子协议里的 JSON 超过 1024 字节回 401。**
- **失败**：握手一律回 401，响应体里不说原因。服务端日志记 `auth.reject { remote, reason }`，`reason` 取 `no-credential`、`bad-proof`、`nonce`、`banned`、`not-listed`、`no-project`、`rate-limited`、`bad-format`、`multiple`，不记任何口令、`K`、证明、票据的原文。

## 6. principal 与空间

- **principal**：

```js
{
  userId, tenantId, scope,                        // scope: 'member' | 'local' | 'admin'
  username, deviceId, deviceName, creator,        // 身份部分
  role, conversation, owner,                      // 连接部分：role 'page' | 'agent' | 'render'
}
```

  写入身份（项目版本日志、内容库的 `actor`）记 `{ userId, deviceId, role, conversation, session }`，满足语义「哪个用户的哪个页面，或哪个 Agent 的哪个对话」。

- **空间**：数据面模块（渲染任务队列、项目、内容库）**按 `tenantId` 各起一份实例**，互不相通：
  - 频道名在模块给的名字上再加空间前缀，同一个模块名、同一个频道名在两个空间里不串；
  - 存储：`local` 空间沿用原来的目录（本地文档服务 `<root>/out/docservice`，独立模式为数据目录本身），共享项目的空间在 `tenants/<projectId>/` 下；
  - 管理身份不进任何空间：发数据面消息回 `forbidden`。
  - 本机身份与成员身份按 `tenantId` 进对应空间。局域网主机上，创建者的页面（本机声明）与成员落在同一个空间里。
- **队列里的角色限制**：
  - `node.hello` 只允许 `role: 'render'` 的连接，以及 `local` 身份；别的回 `forbidden`。
  - 纯浏览器节点（`profile: 'browser'`）只见、只能认领 `source.userId` 等于自己 `userId` 的任务（与 M5 相同，只是 `userId` 现在带设备）。
  - 本机 PC 与独立主机能认领本空间里任何成员的任务。
- **旧入口不变**：`mountRenderQueue(q)` 与 `createDocService({ modules })` 仍能挂单实例模块，供现有测试与只有 `local` 空间的场合用；按空间起实例的新入口另加。

## 7. 成员与创建者操作（WebSocket，模块 `shared`，类型前缀 `shared.`）

| 消息 | 方向 | 内容 |
|---|---|---|
| `shared.members` | 请求 → 回包 `shared.members.list` | `devices: [{ deviceId, deviceName, username, displayName, creator, tags: { editing, rendering, agents }, conns: [{ role, conversation?, owner? }] }]` |
| `shared.watch` | 请求 | 订阅本空间的成员变化；之后每次有连接进出、创建者操作，都收到一条 `shared.members.list` |
| `shared.challenge` | 请求 → 回包 `shared.challenge.ok { nonce, salt, kdf }` | 为一次创建者操作取挑战，`nonce` 规则同第 4 节 |
| `shared.admin` | 请求 → 回包 `shared.admin.ok` 或 `error` | `{ op, proof: { nonce, m }, … }`，`op` 见下表 |
| `auth.ticket` | 请求 → 回包 `auth.ticket.ok { ticket, exp }` | 第 8 节 |

- **显示名**：`displayName` 是用户名。本空间当前在线的设备里，若有不同 `deviceId` 用着同一用户名，这几台都显示为 `用户名 (设备名)`。
- **标签**：
  - `editing`：这台设备有 `page` 连接；
  - `rendering`：这台设备有 `render` 连接，且至少一条正持有认领；
  - `agents`：`agent` 连接的条数。
- **创建者操作**（`shared.admin`）：`proof.m = base64url(HMAC-SHA256(K_创建者, "promptcut.admin.v1\n" + projectId + "\n" + 创建者用户名 + "\n" + op + "\n" + nonce))`，`nonce` 须由同一连接刚取的 `shared.challenge` 给出。证明不对回 `error { reason: 'forbidden' }`，并计入第 9 节的限速。

| `op` | 字段 | 效果 |
|---|---|---|
| `set-password` | `project: { salt, key }` | 只用于自由进入；项目的 `generation` 加一（已发的票据全部作废）；在线连接不断 |
| `set-list` | `list: [{ username, salt, key }]` | 只用于限定进入；整表替换；被移出的用户名，其全部连接 5 s 内以 4003 `removed` 关闭；项目 `generation` 加一 |
| `kick` | `username, deviceId` | 这台设备上这个用户名的全部连接以 4003 `kicked` 关闭；该 `userId` 的代数加一；记进禁入表，此后以这个用户名加 `deviceId` 进入一律 401 |
| `unban` | `username, deviceId` | 从禁入表删掉 |
| `delete` | — | 全空间连接以 4004 `deleted` 关闭；删掉项目记录与该空间的全部数据；名字释放 |

- 不是创建者、不带证明的，一律回 `forbidden`。
- 除上表之外，创建者和普通成员的一切行为完全相同（H5）。

## 8. 票据

- **形状**：`v1.<base64url(JSON)>.<base64url(HMAC-SHA256(签名密钥, "v1." + 负载段))>`，base64url 不带 `=`。JSON 为 `{ kid, k: 'asset' | 'conn', p: projectId, u: userId, r, g, ug, exp, iat }`。
  - 签名密钥就是项目记录里的 `ticketKey`，`kid` 是它的编号：记录可以另存 `oldTicketKeys: [{ kid, key, until }]`，供轮换期间核对旧票据。
  - 核对时，先对**收到的原始负载段**验签名，验过再解析 JSON；票据总长 ≤ 2048 字节；`exp - iat` 不得超过该类票据的有效期。
  - `k: 'asset'`：`r` 为 `'r'` 或 `'rw'`；
  - `k: 'conn'`：`r` 为连接角色，另可带 `c`、`o`；
  - `g` 是项目的代数，`ug` 是这个 `userId` 的代数；
  - `exp`、`iat` 是毫秒时间戳。
- **有效期**：素材票据 15 分钟，连接票据 2 分钟〔裁〕。
- **核对**：
  - 签名按定长比较；
  - 允许 30 s 时钟偏差；
  - 过期、代数与当前不符，一律无效。
- **签发**：`auth.ticket { kind, access?, role?, conversation?, owner? }`，只有成员身份与本机声明身份能要，票据的 `u` 就是本连接的 `userId`。
  - `kind: 'conn'` 用于同一设备再开别的角色的连接（例如页面替本机的预渲染进程要一张 `render` 票据）；
  - 本机 `local` 身份要不到票据（它不需要）。
- **素材服务的读写**：
  - **回环来源**：不需要票据，与现在相同。
  - **其它来源**：
    - 写（分片上传、`complete`、`remove`）要 `Authorization: Bearer <k: 'asset', r: 'rw' 的票据>`；
    - 读（`GET` / `HEAD`，含 Range）要 `Authorization: Bearer <素材票据>`，或者查询串 `?t=<票据>`。查询串只认 `r: 'r'` 的票据，写入一律不认查询串。
    - 没票据、签名不对、过期、代数不符：401 `unauthorized`；写入用了只读票据：403 `forbidden`。
  - 素材服务按哈希寻址，票据不限定哈希：持某个项目的有效票据，就能读这台服务上任何已知哈希的内容〔裁：内容按哈希寻址、写入不可变，不知道哈希就无从读起；按项目分库留到 OSS 之后〕。
  - **集群令牌不再用于素材服务**：C5 的「非本机写入凭集群令牌」退役。
  - 带票据的请求，访问日志只记路径，不记查询串。
  - 用查询串票据的响应加 `Cache-Control: no-store` 与 `Referrer-Policy: no-referrer`。
  - 每个请求都重新核对票据，包括同一段播放里的每个 Range 请求。
  - 票据的代数与签名密钥由文档服务的凭证存储持有。素材服务与文档服务跑在同一个进程里（挂载模式的 vite，托管端的组合入口），直接共用这份内存状态；不同进程之间不支持共用。
- **CORS**：素材服务允许 `Authorization` 请求头（`Access-Control-Allow-Headers` 含它）。

## 9. 口令错误限速

- 按来源地址计数：1 分钟内失败 5 次，这个来源进入 60 s 冷却。冷却期内：
  - 这个来源的挑战回 429；
  - 握手一律 401，口令对也拒；
  - 创建者操作回 `rate-limited`。
- 失败的定义：握手时证明不对、`nonce` 不对，以及创建者操作的证明不对。
- 别的来源不受影响；回环来源不计数。

## 10. 失败即关与管理接口

- **独立模式 `main.mjs`**：
  - 绑非回环地址而没加载凭证存储（数据目录不可写或 `auth/` 读失败）→ `config.error { reason: 'auth-store' }`，退出码 1。
  - 集群令牌不再是启动条件：
    - 设了而格式不对，仍是 `bad-token-format` 退出码 1；
    - 没设照常启动，管理接口（带令牌的握手）全部 401。
- **挂载模式（vite 插件）**：
  - 凭证存储放在 `<root>/out/docservice/auth/`；
  - 管理身份只认回环来源，集群令牌在挂载模式下一律不认〔用户定：局域网主机的管理接口只绑回环、不要令牌〕；
  - 局域网来的连接只能凭证明或连接票据进入。
- **服务地址登记**（`endpoints` 模块）：
  - `service.announce` / `service.withdraw` 只允许管理身份与 `local` 身份；成员回 `forbidden`；
  - `service.watch` 与下发的 `service.endpoints` 对所有身份开放（只读）。

## 11. 客户端

- **`server/auth/client.mjs`**：浏览器与 Node 通用，只用 WebCrypto 或 `node:crypto`。提供：
  - `deriveKey`；
  - 按第 4、5 节取挑战并拼好子协议的 `buildAuthProtocols({ base, projectId, username, deviceId, deviceName, as, password | key, role, conversation, owner })`；
  - 解析票据有效期的 `ticketExpiry`。
- **节点侧传输 `createWsEndpoint`**：接受一个 `protocols()` 函数（每次连前调用，因为 `nonce` 只能用一次），不再接受 `token` 用于数据面。
- **Node 进程怎么拿凭证**：预渲染进程、独立主机、探针读环境变量 `PROMPTCUT_SHARED_CONFIG`。
  - 它指向一个 JSON 文件：`{ url, projectId, username, deviceId, deviceName, as, password | key, role }`，也可以是这样的对象组成的数组（独立主机加入多个项目时）。
  - 设了这个变量，就用它拼证明、连文档服务，并经 `auth.ticket` 取素材票据；没设就维持原来的做法：连回环地址时是本机身份，连不上就回落本机。
  - 集群令牌 `PROMPTCUT_CLUSTER_TOKEN` 只在管理用途上读取：`asset-announce` 登记地址、`scripts/remote/docservice.mjs`。
- **素材客户端 `server/asset-store/client.mjs`**：接受 `ticket: () => string | Promise<string>` 取代 `token`，每个请求取一次；收到 401 时调一次 `ticket({ refresh: true })` 后重试一次。

## 12. 测试编号（测试方用）

用例名前缀 `AU`，每条都要单测覆盖；跨机的 H 系列由 M6 的探针与 W5 验。

| 编号 | 内容 |
|---|---|
| AU1 | `shared/create` 两种模式建成；同名（大小写、NFC 不同形）第二次回 409；字段缺失回 400；局域网主机上非回环来源建回 403；托管端同一来源第 11 次回 429 |
| AU2 | 自由进入：证明对 → 握手成功，`principal` 字段齐全；证明错 → 401；`nonce` 复用、过期（注入时钟）、四元组不符 → 401 |
| AU3 | 限定进入：名单内成功；名单外用户名得到的挑战与名单内形状相同，且同名两次得到同一个盐；随后握手 401 |
| AU4 | 两台设备自报同一用户名：两个 `userId` 不同；`shared.members` 里两台都显示 `用户名 (设备名)`；其中一台离开后，另一台恢复成只显示用户名 |
| AU5 | 创建者操作：五种 `op` 带证明都生效；不带证明、证明错、非创建者一律 `forbidden`；逐个列出其余全部数据面消息类型，创建者与成员结果一致 |
| AU6 | `set-list` 移出某人：他的连接 5 s 内以 4003 关闭，再握手 401；`kick`：连接关闭、票据立即 401、再进入 401，`unban` 后能进 |
| AU7 | 票据：素材读写的 401、403 各情形（无票据、签名错、过期、项目代数变了、用户代数变了、只读票据写入、查询串用于写入）；回环来源不带票据照常；`set-password` 后旧票据 401 |
| AU8 | 限速：同一来源 1 分钟内错 5 次后 60 s 内全部拒绝（口令对也拒），61 s 后恢复（注入时钟）；另一来源不受影响 |
| AU9 | 空间隔离：两个共享项目的成员各自发布、订阅、写内容库，对方收到 0 条；频道名相同也不串；`local` 空间与共享空间互不可见 |
| AU10 | 角色：`page` 连接发 `node.hello` 回 `forbidden`；`render` 可以；`agent` 连接写入的 `actor` 带对话号；一台设备 `page` 加 `render` 两条连接在成员列表里是一行，标签正确 |
| AU11 | 集群令牌：带令牌的连接发任何数据面消息回 `forbidden`；`service.announce` 成功；成员发 `service.announce` 回 `forbidden`；挂载模式下非回环来源带令牌握手 401 |
| AU12 | 失败即关：独立模式绑非回环而凭证存储不可用 → 退出码 1、`config.error { reason: 'auth-store' }`；没设集群令牌能启动 |
| AU13 | 握手日志与所有错误回包里，不出现口令、`K`、证明 `m`、票据原文（在一次完整流程的全部日志行上检查） |
| AU14 | 连接票据：页面要一张 `render` 连接票据，另一条连接凭它进入，身份与页面相同、角色为 `render`；过期后 401 |
| AU15 | 旧行为保持：只有 `local` 空间时，M5 的全部文档服务、队列、素材服务测试照过；原先靠集群令牌走数据面的测试改为走回环或凭证，改动逐条列在报告里 |

## 13. 查资料的结论（codex，`gpt-6-sol` / `high`）

原文存在 scratchpad 的 `research-m6.md`，要点和采纳情况如下。

| 题 | codex 的结论 | 本契约怎么用 |
|---|---|---|
| scrypt 参数 | `N=2^17, r=8, p=1`，单次约 128 MiB；`maxmem` 要调到 160 MiB；服务端并发派生限 2 | **没采用 scrypt**。浏览器没有原生 scrypt，要引依赖；而服务端按本协议从不派生，scrypt 的服务端代价本就不存在 |
| 浏览器派生函数 | 统一用 PBKDF2-HMAC-SHA256，60 万次，32 字节，16 字节盐；缺点是没有内存困难性 | **采纳**（第 2 节）。codex 另指出：明文 http 打开的远端页面不是安全上下文，没有 `crypto.subtle`。桌面编辑器跑在 localhost，是安全上下文，不受影响；C10 的在线浏览器页面才会遇到，用仓库内的纯 JS 实现兜底，以 `node:crypto` 对拍〔裁；用户已接受明文传输（S4），不为此上 HTTPS〕 |
| 挑战应答 | `nonce` 32 字节、只用一次；HMAC 的输入要有用途前缀和字段边界；证明解码后恰好 32 字节再做定长比较；名单外用户名给同形状的伪盐 | **全部采纳**（第 4、5、7 节） |
| 子协议 | 只能用 HTTP token 字符（base64url 在内）；没有单独的长度上限，受请求头总长（Node 缺省 16 KiB）限制；只回显客户端给过的那一项 | **采纳**：鉴权项的 JSON 限 1024 字节，只回显 `promptcut.v1`。`service.mjs` 本来就只回显客户端给过的项 |
| 媒体元素 | 元素用查询串只读票据，fetch 用 Bearer；每个 Range 请求都重新核对；带票据的响应 `no-store`、`no-referrer`，日志去掉查询串；Cookie、Service Worker 都要求安全上下文，不适用 | **采纳**（第 8 节）。没采纳「票据绑定到单个素材哈希」：一个页面要读成百上千个哈希，逐个签发不现实〔裁〕 |
| 票据格式 | 对收到的原始负载段验签名；带 `kid` 便于轮换；时钟偏差 30 s；靠代数作废需要素材服务能看到当前代数 | **采纳**（第 8 节）。素材服务与文档服务同进程，共用代数 |
