# M6a 实现报告（claude/m6-auth）

契约：`docs/plan/auth-contract.md`。计划：`docs/plan/Master-Execution-Plan.md` 第 7 节 M6、第 12 节 D9。
worktree：`.worktrees/m6-auth`，分支 `claude/m6-auth`。没看测试方分支 `claude/m6-auth-tests`。

## 1. 做了什么（按契约节号）

| 节 | 内容 | 落在哪 |
|---|---|---|
| 2 口令派生 | PBKDF2-HMAC-SHA256；客户端优先 WebCrypto，没有 `crypto.subtle` 时走仓库内纯 JS 实现（SHA-256 / HMAC / PBKDF2，60 万次约 0.3 s），以 `node:crypto` 对拍。服务端从不派生 | `server/auth/pure.mjs`、`client.mjs` |
| 3 存储 | `auth/server.json`（服务端密钥，首次生成）、`auth/projects/<projectId>.json`（临时文件加改名）；打开时全量读进内存，读不了就抛错；按目录取进程内单例（文档服务与素材服务共用） | `server/auth/store.mjs` |
| 4 HTTP 端点 | `shared/create`、`shared/lookup`、`shared/challenge`；JSON、`no-store`、`ACAO *`、`OPTIONS`、64 KiB 上限（413）；托管端同一来源每小时 10 个、全服务 1000 个；局域网主机只许回环建；名单外 / 非创建者回伪盐 | `server/auth/http.mjs` |
| 4 挑战 | nonce 32 字节、一次、60 s、绑定四元组；用过的记得住（见第 3 节第 5 条） | `server/auth/challenges.mjs` |
| 5 握手 | 证明、连接票据、本机声明、集群令牌至多一项；回环什么都不带 = 本机身份；只回显 `promptcut.v1`；失败一律 401，日志 `auth.reject { remote, reason }` 用契约的原因词表 | `server/auth/handshake.mjs` |
| 6 principal 与空间 | principal 字段按契约；数据面模块（队列、项目、内容库）按 `tenantId` 各起一份实例，频道名加空间前缀（`<前缀>:@<空间>/<其余>`，`local` 不变），共享空间存储在 `tenants/<projectId>/`，`local` 沿用原目录；管理身份不进空间；`node.hello` 只许 `render` 与 `local`；写入 `actor` 带设备、角色、对话号 | `server/docservice/spaces.mjs`、`service.mjs`、`modules/render-queue.mjs`、`modules/actor.mjs` |
| 7 成员与创建者操作 | 新模块 `shared`：`shared.members` / `shared.watch` / `shared.challenge` / `shared.admin`（五种 op）/ `auth.ticket`；关闭码 4003 `removed` / `kicked`、4004 `deleted`；删项目清记录、空间实例与数据目录 | `server/docservice/modules/shared.mjs` |
| 8 票据 | 形状 `v1.<负载>.<签名>`；素材 15 min、连接 2 min；30 s 偏差；代数（项目、用户）作废；`kid` 与 `oldTicketKeys` 轮换 | `server/auth/tickets.mjs` |
| 8 素材服务 | 回环不要票据；其它来源写要 Bearer `rw`、读要 Bearer 或查询串 `r`；401 / 403；查询串票据的响应 `no-store` + `no-referrer`；`/@media/*` 同样把关；集群令牌退役 | `server/asset-service.ts`、`server/auth/asset-tickets.mjs` |
| 9 限速 | 按来源：1 分钟 5 次失败 → 60 s 冷却；挑战 429、握手 401、创建者操作 `rate-limited`；回环不计 | `server/auth/rate-limit.mjs` |
| 10 失败即关 | `main.mjs`：非回环而凭证存储加载不了 → `config.error { reason: 'auth-store' }` 退出码 1；令牌格式不对仍 `bad-token-format`；没设令牌照常启动。挂载模式不认令牌；`endpoints` 的登记与撤回只给管理与 `local` 身份 | `server/docservice/main.mjs`、`vite-plugin-docservice.ts`、`modules/endpoints.mjs` |
| 10 组装 | 两种挂法共用一个组装入口 `createSharedDocService({ mode: 'hosted' \| 'lan', … })`；旧入口 `mountRenderQueue(q)`、`createDocService({ modules })` 不变（`mountRenderQueue` 另接受「空间 → 队列」的工厂函数） | `server/docservice/shared-service.mjs` |
| 11 客户端 | `client.mjs`（`deriveKey`、`buildAuthProtocols`、`ticketExpiry` 等）；`createWsEndpoint({ protocols })` 每次连前现取；素材客户端 `ticket()`（401 换票重试一次）；Node 进程读 `PROMPTCUT_SHARED_CONFIG`；经连接取素材票据 | `server/auth/client.mjs`、`shared-config.mjs`、`ticket-source.mjs`、`render-node/ws-transport.mjs`、`asset-store/client.mjs`、`vite-plugin-frames.ts`、`asset-client.ts` |

集群令牌现在只在管理用途上读：`asset-announce`（沿用，`createWsEndpoint({ token })`）与 `scripts/remote/docservice.mjs`（部署时另拷 `server/auth/`）。

## 2. 新增与改动的文件

新增：
- `server/auth/`：`protocol.mjs`、`pure.mjs`、`client.mjs`、`store.mjs`、`challenges.mjs`、`rate-limit.mjs`、`tickets.mjs`、`handshake.mjs`、`http.mjs`、`asset-tickets.mjs`、`ticket-source.mjs`、`shared-config.mjs`、`device.mjs`
- `server/docservice/`：`spaces.mjs`、`shared-service.mjs`、`modules/shared.mjs`、`modules/actor.mjs`
- 测试：`server/test/auth-impl-crypto.test.mjs`、`auth-impl-units.test.mjs`、`auth-impl-service.test.mjs`、`auth-impl-client.test.mjs`、测试件 `fake-shared-env.mjs`

改动：
- `server/docservice/`：`router.mjs`（放行判断 `gate`、`ctx.close`、`ctx.remote`）、`service.mjs`（principal 规整、管理身份放行判断、`http` 钩子、`remoteOf`、`closeConn`、`dropSpace`、`claimsOf`、按空间挂队列）、`auth.mjs`（改成旧入口外观，令牌 → 管理身份）、`main.mjs`、`modules/render-queue.mjs`、`modules/endpoints.mjs`、`modules/project.mjs`、`modules/content.mjs`
- `server/vite-plugin-docservice.ts`、`server/asset-service.ts`、`server/asset-client.ts`、`server/asset-store/client.mjs`、`server/render-node/ws-transport.mjs`、`server/vite-plugin-frames.ts`
- `scripts/remote/docservice.mjs`、`scripts/probes/ws-client-test.mjs`、`render-queue-e2e.mjs`、`asset-lan-probe.mjs`、`queue-mode-probe.mjs`（只改注释）
- 旧测试：见第 4 节

没动渲染与导出路径（`frame-pipeline`、导出、卡片、快照都没改）；`vite-plugin-frames.ts` 只改了预渲染进程连文档服务与素材服务的凭证接线，所以没跑 G0-R。

## 3. 基线与验证

命令都在 worktree 根目录跑。

```
npx tsc -b --force        → tsc EXIT 0
npm test                  → npm test EXIT 0
ℹ tests 2488
ℹ pass 2487
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1               （集成:/api/cards/layout 对真实项目返回整数框，原来就跳过）
```

实现方自测（新增 41 条，全过）：`auth-impl-crypto` 10、`auth-impl-units` 15、`auth-impl-service` 9、`auth-impl-client` 7。

真起服务的检查（端口 5460 / 5463，用完已停，只结束了自己起的进程树）：
- worktree 的编辑器（`npx vite --port 5460 --host 127.0.0.1`，挂载模式）：scratchpad 的 `vite-check.mjs` 20/20 过。「局域网来源」用舞台端口代理的真实对端头 `x-pc-stage-client` 模拟：局域网建项目 403、本机 201；局域网不带凭证 / 带令牌 401、凭证明 101、口令错 401；本机声明 101；两个插件共用一份凭证存储——同一进程里文档服务签的素材票据，素材服务认：局域网 PUT 不带票据 401、只读票据 403、rw 票据 200；GET 不带票据 401、查询串只读票据 206 且 `no-store` / `no-referrer`；`/@media/*` 不带票据 401；本机不要票据 200。
- 独立模式 `main.mjs`（127.0.0.1:5463）：`ws-client-test` 本机身份 12/12、共享项目配置 14/14；`render-queue-e2e --role both --tasks 10` 本机身份与共享项目配置两种都 `ok: true`（10 发布 10 完成、0 重复）。
- `asset-lan-probe` 以共享项目配置对 5460 跑：取票据、带票据分片上传、收尾、Range、查询串票据、全件 sha256 都过；三条反面步骤（不带票据 401、读不带票据 401、只读票据写 403）在本机跑必然不过，因为回环来源不要票据，要在别的机器上跑（W5）。输出里没有票据原文。

## 4. 改过的旧测试（原来测什么 → 现在怎么测）

断言只换了凭证的来源（令牌 → 共享项目凭证 / 素材票据 / 回环本机身份），没为了过而删断言；契约改了行为的地方按新契约改断言，逐条写在下面。

`server/test/docservice-auth.test.mjs`：
- **A1 auth 模块本身**：原来令牌对 → `{ userId: 'cluster', tenantId: 'cluster' }` → 现在令牌对 → 管理身份 `{ userId: 'admin', tenantId: null, scope: 'admin' }`（契约第 5 节）。其余断言不变。
- **A2**：原来令牌连上后 `publisher.hello` 得 `publisher.welcome` → 现在同一条连接发 `publisher.hello` 回 `forbidden`，发 `service.watch` 得 `service.endpoints`（为此测试服务多挂了 `endpointsModule`）。握手、只回显 `promptcut.v1`、响应头不含令牌的断言不变。
- **A3**：原来「令牌连接的 principal 是 cluster，自报的 userId 不改变它，任务 source 取 principal」→ 拆成两条：(a) 令牌连接的 principal 是管理身份，`node.hello` / `publisher.hello` / `queue.watch` / `task.publish` 全回 `forbidden`；(b) 共享项目成员身份（`page` 发布、`render` 认领）发布时自报 `userId: 'mallory'`、`tenantId: 'evil'`，`task.opened` 里的 `source` 仍是连接的 `userId` 与项目 id，`describe().conns` 的 principal 对得上。
- **A5**：原来被拒原因集合 `['bad-token', 'no-protocol', 'no-token']` → 现在用契约的词表 `['bad-format', 'bad-proof', 'no-credential']`；「日志 / 标准输出 / describe / healthz 里没有令牌原文」「每次被拒记一条、共 9 条」不变。
- **A6 非回环没设令牌 → token-required 退出**：→ 改为「非回环而凭证存储不可用（数据目录是个文件）→ 退出码 1、`auth-store`」，另加「非回环、没设令牌、存储可用 → 照常启动，带令牌握手 401」。「非回环」用 `127.0.0.2`：`main.mjs` 按字面只把 127.0.0.1 / ::1 / localhost 当回环，而 127.0.0.2 仍在回环网卡上，测试不用真绑 0.0.0.0（Windows 会弹防火墙）。
- **A6 设了合法令牌**：原来「只带 `promptcut.v1` → 401」→ 现在回环不带令牌是本机身份（101），改测「令牌错 → 401」；令牌对 101、只回显 `promptcut.v1`、输出里没有令牌不变；另加令牌连接发数据面消息 `forbidden`、`service.announce` 成功。
- A1（第一条）、A4、A6（回环未设令牌、令牌格式不对）没改。

`server/test/render-node-ws.test.mjs`：
- **T1 令牌模式**：原来 `createWsEndpoint({ token })` 连令牌模式的服务、principal 是 cluster → 现在「共享项目凭证」模式：`createWsEndpoint({ protocols })` 每次连前现取挑战、以 `render` 角色进入托管端，`node.welcome` 的 epoch 与项目空间的队列一致，principal 是完整的成员身份。onOpen、stats、角色登记的断言不变。T8（令牌错时的退避）没改：它测的是握手失败时的传输行为，用管理令牌鉴权照样成立。

`server/test/asset-store-http.test.mjs`：
- **H3**：原来「写要令牌、读（GET/HEAD/chunks）不要」→ 现在「写要 rw 票据、读也要票据」：不带票据 / 各种坏票据（乱写、多一字符、少一字符、不带 Bearer、Basic、空 Bearer、放在别的头里、签名大小写不同）写入 401；scheme 大小写不敏感；rw 票据写入、收尾照常；读不带票据 401（GET、HEAD、chunks、`/@media`），Bearer 票据与查询串只读票据照常，查询串只认只读票据、响应带 `no-store` / `no-referrer`；只读票据写 403、查询串写 401；OPTIONS 不要票据；「先鉴权后校验」「被拒不落盘」的断言全部保留（对账改为带票据读）。
- **H4**：原来「token 为 null 非本机写 401、读照常；缺省 token 取环境变量」→ 现在「tickets 为 null 非本机读写都 401；本机照常；缺省 isTrusted 按回环判（9 个地址的表不变）；设了 `PROMPTCUT_CLUSTER_TOKEN`、Bearer 带集群令牌读写都 401（退役）；缺省核对器按 `<root>/out/docservice/auth` 取进程内凭证存储，认同目录存储签的票据、不认别的存储签的」。
- **H5**：`serve` 的选项 `token` 换成 `tickets: null`，断言不变。
- **H6**：令牌换成票据（另加两次查询串请求），「回包和日志里没有票据原文」不变。

`server/test/asset-namespaces.test.mjs`（共用剧本 `script`）：
- **S2 / S3**：原来服务配集群令牌、剧本里只有写带令牌 → 现在服务配票据核对器、`TOKEN` 是一张 rw 素材票据，剧本里的读也带它；新增三步「对账不带票据 401」「GET 不带票据 401」「查询串只读票据 200（no-store）」「只读票据 PUT 403」，并在 media 的核对里断言它们。三个命名空间逐字段比较、S3 新旧写法逐字段相同的断言不变。

`server/test/asset-client.test.mjs`：
- **L3 4xx 不重试**：原来令牌服务、客户端不带令牌，第一片 PUT 回 401、只发 1 次 PUT → 现在票据服务，读也要票据，401 出在第一个请求（对账 GET chunks）上，断言改为「总共只发 1 个请求」；另加「只读票据写入 403、只发 1 次 PUT」。
- **L5**：原来「带令牌时每个写请求有 Bearer，异常里没有令牌原文」→ 现在「带 `ticket()` 时每个请求（读写都算）有 Bearer <票据>、每个请求取一次；没给 / 回 null 不带；401 换一张（`refresh: true`）重试一次、换来的新票据能用（项目代数变了之后）；换了还 401 只重试一次；异常里（401、5xx、网络错）没有票据原文；给 `token` 选项抛 TypeError」。

`server/test/fake-asset-service.mjs`：`serve` 多透传 `tickets`（`token` 仍透传，中间件不认）。

探针：`ws-client-test`、`render-queue-e2e`、`asset-lan-probe` 不再读集群令牌：设 `PROMPTCUT_SHARED_CONFIG` 就凭项目证明进入（节点连接 `render`、发布方 `page`），没设就是本机身份。`asset-lan-probe` 另加读不带票据 401、只读票据写 403、查询串票据 Range 三步。`queue-mode-probe` 只改注释（自起的文档服务仍删掉令牌，现在是本机身份；连远端时要设 `PROMPTCUT_SHARED_CONFIG`）。`ws-client-test` 凭共享项目进入时，healthz 的 epoch 是 `local` 空间那一份队列的，只查它是字符串。

## 5. 与契约不一致之处

1. **票据核对的顺序**（第 8 节「先对原始负载段验签名，验过再解析 JSON」）：签名密钥按项目分，不看负载就不知道用哪把钥匙。我先把负载段解出 `p` 与 `kid`**只用来找密钥**，再对收到的原始负载段验签名，验过才采信任何字段（类别、角色、有效期、代数）。总长先限 2048。
2. **连接票据多两个字段**：`dn`（设备名）、`cr: true`（签发者是创建者，只作界面标记）。契约的票据字段里没有设备名，而凭票据进入的连接要有完整的 principal（成员列表显示设备名）。
3. **本机声明的角色项**：契约写 `promptcut.role.<page|agent|render>`；`agent` 连接必须有对话号，所以另认 `promptcut.role.agent.<对话号>`。本机声明的 principal 除了契约给的 `{ userId: 'local@<deviceId>', tenantId, creator: true, role }`，还带 `scope: 'member'`、`username: 'local'`、`deviceId`、`deviceName`、`conversation`、`owner`，与成员身份形状一致。
4. **回环来源连 `promptcut.v1` 都不带**：按本机身份放行（M5 的旧客户端）。带了鉴权项却没带 `promptcut.v1` 回 401 `bad-format`。
5. **重放用过的 nonce 不计入限速**（第 9 节失败的定义含「nonce 不对」）：Node 内置的 WebSocket（undici）在握手回 401 时会用同一组子协议原样再请求一次（本机实测：只有 401 会重试，403 / 400 / 503 不会），一次输错口令会被数成两次。重放用过的 nonce 永远进不来，不计数不帮猜口令的人任何忙；没见过的、过期的、绑定不符的 nonce 照常计数。
6. **票据握手失败不计入限速**：契约的失败定义只有证明与 nonce。冷却期内票据握手照样 401。日志原因记 `bad-proof`（词表里没有票据专用的词）。集群令牌错也记 `bad-proof`，令牌不被接受（挂载模式、没配令牌）记 `no-credential`。
7. **用户名规则**：契约只给了项目名的规则。用户名要拼进以换行分隔的用途串，我定为 1～64 个字符、不含控制字符、首尾不是空白。
8. **限定进入下创建者以 `as: 'member'` 进入**：挑战给创建者的盐，证明对就进，principal 的 `creator: true`（「创建者自动算名单的一员」）。
9. **创建者操作不绑连接身份**：本空间任何成员连接都能取 `shared.challenge`（回创建者的盐），证明对就成功——特权绑「创建者用户名 + 创建者口令」，知道创建者口令的普通成员连接也能操作。`local` 身份（没有项目）与管理身份一律 `forbidden`。操作的证明不覆盖 `kick` 的目标等字段（契约的用途串就是这样定的）。
10. **`set-list` 移出的人立即以 4003 关闭**（契约是 5 s 内）。「被移出」按新名单判：不在新名单里、又不是创建者（也不是本机声明的创建者）的连接都关。
11. **写入身份 `actor`**：新身份记 `{ userId, deviceId, role, conversation, session }`；不带 `role` 的旧式身份（测试注入的 `authenticate`、M5 匿名）仍记 `{ userId, session }`，现有测试（P5、内容库 C 系列）照过。同理 `node.hello` 的角色限制与 `endpoints` 的登记限制只管带 `scope` 的新身份，旧式身份不受限。
12. **`local` 空间的成员列表**：`shared.members` / `shared.watch` 对本机身份也回（按连接聚合，`username` 取 `userId`），没回 `forbidden`；`shared.watch` 立即回一条当前列表作回包。
13. **独立模式只绑回环而凭证存储加载不了**：照常启动，只有本机身份可用，共享端点回 503 `auth-store`（契约只规定了非回环的情形）。凭证存储里有一个项目文件坏了就整份打不开（失败即关）。
14. **素材服务的「读」**：`GET chunks` 也算读，要票据；老路由 `/@media/*` 同样把关。
15. **素材客户端给 `token` 选项直接抛 TypeError**，免得旧调用方以为令牌还有用。`createWsEndpoint` 仍接受 `token`，只给管理用途（`asset-announce`），不能和 `protocols` 同给。
16. **预渲染进程读 `PROMPTCUT_SHARED_CONFIG`**：是数组时只取第一项（多项目留给 M6b 的独立主机）；角色固定用 `render`（它就是渲染连接，`node.hello` 只许 `render`）。另给素材回退（J.6，读别的机器的素材服务）接了票据：`setMediaFallbackTicket`。
17. **本机设备信息**：计划 12.2 说设备名「写入用户数据目录后不再变」。本阶段不写任何文件，按主机名、平台、架构、第一块网卡 MAC 现算（同一台机器每次一样），`PROMPTCUT_DEVICE_ID` / `PROMPTCUT_DEVICE_NAME` 可覆盖；落盘留给桌面壳（C6.5）。
18. **`/healthz` 与 `describe()`**：队列按空间各一份后，healthz 的 `epoch` 是 `local` 空间那份，`publishers` / `nodes` 是各空间之和；`describe().modules[...]` 在有别的空间时多一个 `spaces` 键。
19. **JSON 超 1024 字节**按 base64url 解码后的字节数算。

## 6. 遗留问题

- **跨机未验**：非回环来源的票据把关在本机只能靠单测（`isTrusted: () => false`）和舞台端口代理头模拟；`asset-lan-probe` 的三条反面步骤要在另一台机器上跑（W5）。
- **素材回退遇 401 不换下一个地址**：J.6 的回退只在 404 时改试下一个基址，别的机器回 401（例如没配共享项目）会原样交给页面。
- **`queue-mode-probe --docservice-url`** 与 **`scripts/remote/docservice.mjs deploy`** 没跑：前者要远端控制面加共享项目配置，后者要远端（主会话做）。部署脚本仍要求设集群令牌（给阿里云管理接口）。
- **页面一侧**还没接共享项目（界面、`buildAuthProtocols` 的浏览器调用、成员列表显示）：属 C6.5。
- **文档服务与素材服务不同进程时**票据核对不了（契约明确不支持）。托管端的「组合入口」（阿里云上文档服务加素材服务同进程）不在本阶段：`main.mjs` 只起文档服务。
- `ws-client-test` 对挂载模式跑时 healthz 那一步会失败（它查独立模式的 `/healthz`，挂载模式在 `/api/docservice/healthz`）；本阶段之前就这样，没改。
- 旧测试里 `harness.serve({ token: null })` 这类选项还留着（中间件不认，无害）。

## 7. 顾问调用记录

没有调用。本阶段没遇到反复失败的用例（回退梯次没触发）；查资料的结论已在契约第 13 节，实现照它做。唯一的意外（Node WebSocket 在 401 后重试一次）是本机实测定位的，处理见第 5 节第 5 条。
