# 交接：文档服务的 HTTP 长轮询传输（云端节点接入）

2026-09-26。本机会话「文档服务 HTTP 长轮询传输」交接用。停在用户指定的检查点：基线全绿、阿里云第二实例上经临时路由从本机自测成员接入通过；**没有部署正式实例、没有合 main、没有给云端发第 3 版指令**。语义由用户另开会话敲定，定下来后可能要返工本分支。

## 1. 分支

| 分支 | 最后提交 | 内容 | 状态 |
|---|---|---|---|
| `claude/coord-mailbox` | `bf50e7f` | 协调口加两个 Agent 之间的 HTTP 信箱（`to-cloud` / `to-local`，长轮询、`X-Mail-Token`、可持久化）与命令行 `serve` / `send` / `wait`；开了信箱时 KV 也要令牌；命令行用 `exitCode` 自然退出 | 已推送，未合；基线 2960 条 0 失败（`782d18a` 时） |
| `claude/http-transport` | 本文件所在提交 | 契约 `docs/plan/http-transport-contract.md`、服务端 `server/docservice/http-transport.mjs`、节点端 `server/render-node/http-transport.mjs`、选用、测试 | 已推送，未合；**以 `782d18a` 为底，还没并入信箱分支后来的 `bf50e7f`**，返工时一起并；合并顺序：信箱先合 |

worktree 保留：`.worktrees/coord-mailbox`、`.worktrees/http-transport`，等合并后再清。

## 2. 检查点证据

- 基线（`b9e0b5e`，主会话复核）：`npx tsc -b --force` 退出码 0；`npm test` 2990 条，2989 通过，0 失败，1 跳过。
- HT1、HT2：`server/test/docservice-http-transport.test.mjs` 17 条全过（open 的鉴权与 WebSocket 同一套、send 顺序 / 重发幂等 / 跳号 409 / 超限 413、recv 挂起 / ack 丢帧与重发 / 单 GET 替换 / `closed` 下发、过期、healthz、CORS、关停；背压 1013、合并键）。
- HT3：`server/test/docservice-transport-equivalence.test.mjs` 3 条全过（render-queue、project、content 在两种传输上逐条回包相同）。
- HT4：`server/test/render-node-http-transport.test.mjs` 10 条全过（退避、`protocols()` 每次现取、断线丢弃计数、临时错误重试不报断线、404 / 410 报 `onClose` 并重连、`HttpWebSocket` 注入 `doc-link` 能读写项目）。
- HT5 本机版（Opus）：本机托管组合，`--transport http` 与 `--transport ws` 的成员接入各跑一遍，都 `ok: true`；`render-queue-e2e --role both --tasks 20` 两种传输都 20 个完成、没有重复。
- HT5 阿里云第二实例（主会话）：`https://8-219-80-16.sslip.io/hosted-next`，creator 与 member 都 `--transport http`：
  - member：`"ok":true,"transport":"http","enter":{"ok":true,"ms":386},"assetUrl":"https://8-219-80-16.sslip.io/media-next/api/asset","snapshot":{"ok":true},"content":{"ok":true},"media":{"bearer":true,"query":true,"noTicket":401,"loopbackTrusted":false},"ticket":{"rw":true,"r":true},"claims":6,"taskDone":6,"artifactsWritten":6,"fails":[]`；
  - creator：`"ok":true,"transport":"http","tasks":{"published":6,"completed":6,"duplicateDone":0,"byCreatorNode":0},"memberOk":true,"fails":[]`；
  - 第二实例 `/healthz` 的 `transports`：`{"ws":1,"http":0,"httpOpened":2,"httpExpired":0,"httpSuperseded":0}`。
- HT6（部署后云端节点接入并认领任务）没做：按用户要求停在检查点。

## 3. 契约里的八条裁定

契约里只有第 1 条标了〔裁〕，其余七条是写契约时直接定的，性质相同：

1. **由配置显式选传输，不做自动降级**〔裁〕：不做「先试 WebSocket、不行再退回 HTTP」，由配置项 `transport: 'ws' | 'http'` 决定，行为可预期；以后要自动降级只改客户端，协议不动。
2. **只做长轮询，不做 SSE**：代理可能缓冲 SSE，事件会成批到或拖到最后才到（codex 查资料）。
3. **参数**：服务端最长挂 25 s（上限 30 s）、会话空闲 60 s 过期、客户端单次请求超时 40 s。
4. **会话过期等同于断线**：不做跨会话的消息接续，重连后照旧靠 `hello.resume` 与队列快照恢复。
5. **同一会话只允许一个挂起的 GET**：新的到了，旧的立刻空回（`superseded: true`），不拒绝新的。
6. **会话号只放 `Authorization` 头**：256 位随机数，不用 Cookie，所以没有 CSRF 面。
7. **浏览器跨源默认关**：`httpCorsOrigins` 名单为空时不回任何 CORS 头；浏览器真正接入留给 C10 / M7。
8. **挂载模式（挂进 vite 的本机文档服务）只交出处理函数** `service.handleLongPoll(req, res)`，vite 不接线。

## 4. 实现与契约不一致的地方（契约第 13 节有全文）

- 契约没写、实现补上的回包：缺 `Authorization` 或格式不对回 404；`recv` 的 `ack` 超过已发出的最大序号回 400 `bad-ack`；`send` 请求体不是约定形状回 400 `bad-request`；整个请求体超限回 413 并以 1009 关闭（契约只写了单帧超限）。
- 会话注销推迟一轮事件循环（`setImmediate`），模块在处理消息时踢人（4003）或删项目（4004）不会重入 `disconnect`。
- 节点端计时器分两组：`setTimeout` / `clearTimeout` 只管重连退避；请求超时、临时错误重试另由 `httpTimers` 注入；另有 `now`、`requestTimeoutMs`（缺省 40 s）。
- 节点端日志沿用 `ws.*` 事件名（HTTP 端点就是 `createWsEndpoint` 套上 `HttpWebSocket`），`HttpWebSocket` 另打 `http.retry`、`http.error`。
- 契约范围外多改了一行：`vite-plugin-frames.ts` 的 `hostAssetClient` 原来把 `https:` 文档服务地址推成 `http:` 素材地址，现在推成 `https:`。
- 挂起的 GET 被新帧叫醒时推迟到 `setImmediate` 再回，同一轮连写的几条合成一次回包。

## 5. 还没接 HTTP 的两处

`server/vite-plugin-frames.ts` 里经 `resolveDocLink` 取 `PROMPTCUT_SHARED_CONFIG` 第一项的两处仍只走 WebSocket：

- **预渲染推送**（`startArtifactPush`，约第 151～160 行）；
- **本机队列节点**（`startQueueNode`，约第 283～300 行）。

第一项写 `transport: 'http'` 加 `https://` 地址时，这两处会因地址不是 ws(s) 而报错。**独立渲染主机不经过这两处**（`hostProfile()` 时推送直接跳过、队列节点改走 `startHostNode` 按配置项逐个建连接，那一处已按 `entry.transport` 选端点），所以不挡云端当渲染节点；桌面版编辑器以后要走 HTTP 时要补。

## 6. 语义文档的修改建议（原文）

1. **`document-service.md`「职责」第 3 条**（必改）：
   - 修改前：它和各方之间是一条长连接，传小消息、要求快速响应。素材字节和预渲染结果不走这条连接，走素材服务。
   - 修改后：它和各方之间是一条长连接，传小消息、要求快速响应。素材字节和预渲染结果不走这条连接，走素材服务。这条连接有两种传输，业务上完全等价：通常用 WebSocket；所在网络只放行普通 HTTPS 请求的一方（例如出网代理只允许 443、不支持 WebSocket）改用 HTTP 长轮询。用哪种由连接的一方自己选，文档服务两种都接。
2. **`glossary.md`**：加一条「HTTP 长轮询」，指向 `document-service.md`。
3. **`platforms.md`「渲染节点」表**：「独立渲染主机」一行补一句「也可以是只能经 HTTPS 出网的云端容器」。
4. **`platforms.md`「在线浏览器模式」**：要不要写「页面到文档服务也可以用 HTTP 长轮询」，看 C10 怎么定；建议这次先不写。

## 7. 阿里云 `8.219.80.16` 现状

- **nginx 1.24 + Let's Encrypt**（证书 `8-219-80-16.sslip.io`，certbot 自动续期；80 跳转 443）。站点配置 `/etc/nginx/sites-available/promptcut`，备份 `/root/nginx-promptcut.bak*`。保留的路由：
  - `/coord` → `127.0.0.1:8799`（协调口与信箱）；
  - `/hosted` → `172.19.0.47:8787`（WebSocket 升级头、`proxy_read_timeout 3600s`）；
  - `/media` → `172.19.0.47:8788`（`client_max_body_size 2g`）。
  - `/hosted`、`/media` 用 `proxy_bind 172.19.0.47` 从内网地址连后端：托管端把回环来的请求当本机自己人，经 nginx 进来的若走 127.0.0.1 会被当成本机（2026-09-26 09:22～09:26Z 出现过约 4 分钟，已堵上并验证：匿名 WebSocket 升级被拒、匿名读素材 401）。代价：限速按来源地址算，经 nginx 的请求都算 172.19.0.47 一个来源。
  - 部署 HTTP 传输时 `/hosted` 还要补 `client_max_body_size 2m; proxy_buffering off;`（契约第 11 节）。
  - 临时路由 `/hosted-next`、`/media-next` 已在收尾时删除（见第 10 节）。
- **pm2**：`promptcut-hosted`（正式实例，C6.5 代码，8787 / 8788）、`probe-coord`（协调口与信箱）、`pm2-logrotate`；第二实例 `promptcut-drill` 还在跑，见第 10 节。
- **UFW**：22、8787、8788、80、443；8799 已撤（协调口只听 127.0.0.1，只经 443 进来）。
- **正式实例的 pm2 配置改过两个 PUBLIC_URL**（`/opt/promptcut-hosted/pm2.config.cjs`，备份 `pm2.config.cjs.bak-20260926`）：
  - `PROMPTCUT_DOCSERVICE_PUBLIC_URL`：`ws://8.219.80.16:8787` → `wss://8-219-80-16.sslip.io/hosted/`；
  - `PROMPTCUT_ASSET_PUBLIC_URL`：`http://8.219.80.16:8788/api/asset` → `https://8-219-80-16.sslip.io/media/api/asset`（`service.endpoints` 下发给成员的就是它）。
  - **隐患**：`scripts/remote/docservice.mjs deploy-hosted` 会按 `server/hosted/deploy.mjs` 的 `hostedPm2Config` 重新生成这个文件，把两个地址改回 `ws://…:8787` / `http://…:8788`，云端节点就又连不上素材服务了。部署后要手工改回，或者给 `deploy-hosted` 加覆盖公网地址的选项。
- **协调口 `probe-coord`**：`/opt/probe-coord/probe-coord.mjs`（信箱分支的版本），pm2 配置 `/opt/probe-coord/ecosystem.config.cjs`（0600，里面有信箱令牌），消息落盘 `/opt/probe-coord/mail.jsonl`；只听 `127.0.0.1:8799`。信箱令牌本机在 `docs/local.md`「云端信箱」一节。

## 8. 云端节点

- 会话「云端工作」（Anthropic 云端容器）。与本机的往来一律走信箱：`https://8-219-80-16.sslip.io/coord/mail/to-cloud`（本机→云端）与 `/to-local`（云端→本机），请求头 `X-Mail-Token`，令牌用户另外交给了云端。不再用跨会话消息与 git 分支 `claude/cloud-node-status`。
- 环境（信箱 `to-local` seq 4，协调口 KV `cloud-env` 有同样的 JSON）：
  - Node v22.22.2、npm 10.9.7；`NODE_USE_ENV_PROXY=1` 下全局 `fetch` 经代理连阿里云成功（v22.22 有 experimental 警告）；
  - 出网代理只放行 443 HTTPS（CONNECT），不支持 WebSocket 升级；变量 `HTTPS_PROXY` / `NO_PROXY` 等，`NODE_EXTRA_CA_CERTS` 已预设；对本站不做 TLS 中间人（证书颁发者是 Let's Encrypt）；出口 IP 在 160.79.106.x 之间轮换；
  - Chrome：puppeteer 的 Chrome 152 与 chrome-headless-shell、playwright 的 chromium；以 root 运行，**要 `--no-sandbox`**（仓库的 `server/bakery/chrome.mjs` 读 `PC_CHROME_ARGS` 追加启动参数，设 `PC_CHROME_ARGS=--no-sandbox` 即可，不用改代码）；
  - ffmpeg 没有（apt 源可达，没装）：独立渲染主机不开流任务就用不到，已告诉它先别装；
  - 4 核、16 GB 内存、29 GB 可用磁盘、无 GPU；仓库能 `git fetch origin`，`npm ci` 能装上。
- 定下的角色：以**独立渲染主机**（`scripts/render-host.mjs`，共享配置项 `transport: 'http'`、`url: https://8-219-80-16.sslip.io/hosted`）接入，先成员探针、再认领真实任务。
- 当前状态：**挂在信箱上长轮询 `to-cloud`，等第 3 版指令**。已收到的本机消息到 `to-cloud` seq 5（交接说明：下一条指令会来自笔记本会话）。`to-local` 最后一条是 seq 4。
- 第 3 版指令要点（留给接手的会话）：用 `NODE_USE_ENV_PROXY=1`；先 `shared-project-probe --mode internet --role member --transport http --hosted https://8-219-80-16.sslip.io/hosted`（协调口 `https://8-219-80-16.sslip.io/coord`，带 `PROBE_MAIL_TOKEN`）；再以 `scripts/render-host.mjs` 加 `PC_CHROME_ARGS=--no-sandbox` 认领任务；回执照信箱约定写回 `to-local`。

## 9. 顾问调用记录

| 用途 | 问题 | 结论 | 采纳 |
|---|---|---|---|
| 查资料（codex，`gpt-6-sol` / `high`） | 长轮询与 SSE 过企业 CONNECT 代理、nginx 长连接超时、Node 代理、浏览器可用性、协议先例、会话号安全 | 只做长轮询，挂 20～25 s；Node 24.5+ `NODE_USE_ENV_PROXY`；nginx 1.24 要显式 HTTP/1.1；凭证放 `Authorization`；Engine.IO 式单 GET、CometD 式按批确认 | 采纳，写进契约第 11 节 |
| 攻坚（codex worktree 模式） | 没有走到 | — | 没有调用 |
| 发散（Gemini） | 没有走到 | — | 没有调用 |

## 10. 收尾记录（2026-09-26 10:33Z）

- 本机挂着的 `to-local` 长轮询已停；`to-local` 最后一条是 seq 4，没有漏读。
- nginx：删掉临时路由 `/hosted-next`、`/media-next` 并 reload（备份 `/root/nginx-promptcut.bak4`）；`/coord`、`/hosted`、`/media` 仍是 200。注意 `/hosted-next/…` 现在会被 `/hosted` 的前缀匹配吃进去、回 404，无害。
- 探针项目：本会话建的 5 个都删了。删除要创建者证明，探针当时生成的口令没有留下，所以做法是停进程、删 `docservice/auth/projects/<id>.json` 与 `docservice/tenants/<id>/`、再起（与在线删除的 `st.remove` 加 `dropSpace` 等价；素材三个命名空间按哈希共用，没动）：
  - 正式实例：`cloud-node-handshake`（`sp_mqwci777…`）、`https-selftest`（`sp_fooqntei…`）、`https-selftest2`（`sp_svy4jcvu…`）、`cloud-node-handshake-2`（`sp_6ajk3mji…`）；
  - 第二实例：`ht5-next`（`sp_qst5zy42…`）。
  - 正式实例上剩下的 `sp-probe-muhgn208-fc53f5`、`rhp-muhg3z5h` 是主线会话 SP / M6 阶段留下的，不是本会话建的，没动。
- 正式实例因此重启一次；重启后对外宣告的仍是 `wss://8-219-80-16.sslip.io/hosted/` 与 `https://8-219-80-16.sslip.io/media/api/asset`。
- 保留：`/coord`、`/hosted`、`/media` 三条路由，`probe-coord`，`promptcut-hosted`。
- **第二实例 `promptcut-drill` 进程还在跑**（8777 / 8778，`/opt/promptcut-drill`、`/var/lib/promptcut/drill`，没有项目、没有路由、UFW 不放行，外面连不到）；pm2 没有 save，服务器重启后不会自己起来。这两个端口是 M8 迁移演练要用的，演练时 `deploy-hosted --instance drill` 会覆盖它；要提前清掉就 `pm2 delete promptcut-drill` 并删那两个目录。
- 云端：`to-cloud` seq 5 告诉它本机会话交接中、继续长轮询、下一条指令来自笔记本会话。
