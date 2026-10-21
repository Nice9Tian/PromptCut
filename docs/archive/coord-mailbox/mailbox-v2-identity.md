# 会话信箱身份认证与寻址扩展（v2）设计

状态：设计与实现（`scripts/probes/probe-coord-v2.mjs`、测试 `server/test/probe-coord-v2.test.mjs`）在分支 `claude/peaceful-meitner-ef78de`，未部署。生产部署、nginx 入口、真实凭据、OAuth 授权、改安全配置都等用户批准（第 9 节）。

## 1. 现状（据代码与部署记录，不假定服务器副本与仓库一致）

- 代码：`scripts/probes/probe-coord.mjs`（协调口 KV + 信箱 `/mail/<队列>`），测试 `server/test/probe-coord-mail.test.mjs`。
- 部署（`docs/reports/HANDOFF-http-transport.md` 第 7 节、主计划 6.2 节）：pm2 应用 `probe-coord`，程序是**复制到** `/opt/probe-coord/probe-coord.mjs` 的一份，只听 `127.0.0.1:8799`，nginx `/coord` 走 443，消息落盘 `/opt/probe-coord/mail.jsonl`，令牌在 0600 的 pm2 配置里。服务器副本对应哪个提交没有记录；2026-10-04 只读核对：`/healthz` 的形状与仓库 main 一致，`kind: status` 被接受。
- 问题：一个全权限共享令牌（读写两个队列、读写 KV）；`from` 由客户端自填、不验证；只有两个固定队列，没有会话寻址；没有消息 ID、有效期、幂等、处理状态；`/healthz` 不要令牌就回 KV 键名。

## 2. 目标与非目标

- 目标：每个客户端（doger、指定的本地 Codex 会话、Claude 会话……）有服务端验证的独立身份；只能读自己的收件箱、只能发给被允许的接收方；可单独撤销、会过期；消息有服务端确认的发送方、明确接收方、消息 ID、回复关联、有效期；幂等发送；区分「收到 / 已处理 / 失败」。
- 非目标：MCP、WebSocket、任意命令执行接口。信箱只传消息；**收到 `instruction` 不等于用户批准**，接收会话照它自己的授权规则（goal、主计划 6.4b）决定做不做。

## 3. 兼容方式（总判断：旧客户端零改动）

- v2 是**独立进程**（新文件 `scripts/probes/probe-coord-v2.mjs`，pm2 新应用 `probe-coord-v2`，只听 `127.0.0.1:8800`），nginx 新加 `location /coord/v2/`。旧进程 `probe-coord`、旧路径 `/coord/mail/*`、`/coord/kv/*`、旧共享令牌、`mail.jsonl` 全都不动，**部署 v2 不需要重启旧进程**。
- 旧令牌在 v2 上无效（v2 只认自己签发的令牌），新客户端拿不到旧令牌。
- v2 与旧队列不互通：旧云端客户端照旧用 `to-cloud` / `to-local`；迁到 v2 的会话改用 v2 收件箱。过渡期两套并存。
- 健康接口：v2 的 `GET /v2/health` 只回 `{ ok: true }`。旧 `/coord/healthz` 公开 KV 键名的问题，用两种办法之一收口（都要用户批准）：(a) nginx 加 `location = /coord/healthz` 直接回 `{"ok":true}`，只 reload nginx，不重启旧进程；(b) 下次旧进程本来就要重启时，带上新增的 `--health minimal`（`startCoordServer({ healthMode: 'minimal' })`，缺省不变）。仓库里没有客户端读旧 `/healthz` 的 `keys`（已 grep 核对）。

## 4. 身份、令牌、权限

- **主体（principal）**：`{ id, kind: doger|codex|claude|other, label, maxScopes, sendTo: [主体 id], disabledAt }`。收件箱地址就是主体 id（如 `doger`、`codex-laptop`、`claude-cloud`）。主体由管理员在服务器上建，HTTP 上不能建。
- **令牌**：`pcm2_<令牌 id>_<秘密>`，秘密 32 字节随机（`crypto.randomBytes`，base64url）。服务端只存 `SHA-256(秘密)`（高熵随机令牌用一次哈希即可，不需要慢哈希），用令牌 id 查、`timingSafeEqual` 比。每个令牌：`{ id, principal, scopes, sendTo, createdAt, expiresAt, revokedAt, via: admin|device, label }`；有效 = 未撤销 ∧ 未过期 ∧ 主体未停用。令牌的权限 ≤ 主体的 `maxScopes` / `sendTo`。
- **权限（scope）**：
  | scope | 能做 |
  |---|---|
  | `status` | `GET /v2/whoami` |
  | `inbox:read` | 读**自己的**收件箱、看自己收到的消息、对自己收到的消息报「收到 / 已处理 / 失败」 |
  | `send` | 发消息给令牌 `sendTo` 里的主体；看自己发出的消息及其状态 |
  缺省签发 `status` + `inbox:read`；`send` 要单独授予。没有别的 scope，没有执行接口。
- **撤销与过期**：令牌单独撤销、主体整体停用；令牌必须有过期时间（管理员签发上限 90 天，设备授权上限 30 天）。
- **管理口**：只在服务器本机的 Unix 套接字上（文件 0600，网络不可达，nginx 也转发不到），命令行 `node scripts/probes/probe-coord-v2.mjs admin <子命令>`：`principal-add / principal-list / principal-disable / token-issue / token-list / token-revoke / passphrase-set`。`token-issue` 只把令牌写进 `--token-out` 指定的 0600 文件，不打印、不进日志。

## 5. 消息、寻址、幂等、状态

- **发**：`POST /v2/messages`，请求头 `Authorization: Bearer <令牌>`、`Idempotency-Key: <8～128 位 [A-Za-z0-9._:-]>`（必填），体 `{ to, kind, body, replyTo?, ttlSeconds? }`。
  - 服务端决定：`id`（UUID）、`seq`（接收方收件箱内单调递增）、`from`（= 令牌的主体，客户端带 `from` 一律忽略）、`createdAt`、`expiresAt`（缺省 3 天，上限 30 天）。
  - `to` 必须在令牌 `sendTo` 里；`replyTo` 必须是**发送方收到过**的一条消息的 id。
  - 幂等：同一发送方 + 同一 `Idempotency-Key` 再发，回同一条消息（200，`replayed: true`），不新增；内容不同回 409 `idempotency-conflict`。客户端超时重发带同一个键，所以不会重复执行。
- **收**：`GET /v2/inbox?after=<seq>&wait=<秒>`，只回发给自己的、未过期的消息，长轮询上限 25 s，一次最多 100 条。
- **状态**：`POST /v2/messages/<id>/state`，体 `{ state: received|processed|failed, detail? }`，只有接收方能报。`received` 可重复报；`processed` / `failed` 是终态，同一终态重复报幂等，换成另一个终态回 409。过期后再报回 410。`GET /v2/messages/<id>` 发送方或接收方可看信封与状态，别人一律 404（不暴露消息是否存在）。
- **信封**：`{ id, seq, from, to, kind, replyTo, body, createdAt, expiresAt, state: { received, processed, failed } }`；`kind` 沿用 `instruction / receipt / question / status`。
- **游标**：客户端按 `after` 读；服务端持久化每个收件箱的 seq，重启后接着编，游标不失效。
- **保留**：过期或进入终态的消息，再过 `retentionDays`（缺省 14 天）从存储里删；幂等记录随消息一起删。

## 6. doger 的浏览器授权（OAuth 2.0 设备授权，RFC 8628）

1. doger 运行 `login`：`POST /v2/device/code`，体 `{ principal: "doger", scopes: [...], sendTo: [...], label }` → `{ device_code, user_code, verification_uri, expires_in: 600, interval: 5 }`。终端只显示 `user_code`（8 位、10 分钟有效、只能用一次）和 `verification_uri`；不给带码的 `verification_uri_complete`。
2. 用户在**自己的浏览器**打开 `https://<服务器>/coord/v2/device`，用管理口令登录（口令只存 scrypt 哈希；会话 Cookie `HttpOnly; Secure; SameSite=Strict`、15 分钟；表单带 CSRF 令牌；连续失败 10 次锁 15 分钟），输入 `user_code`，看清申请的主体、权限、接收方，可以收窄，再批准或拒绝。批准的权限 ≤ 主体上限。
3. doger 按 `interval` 轮询 `POST /v2/device/token`（`grant_type=urn:ietf:params:oauth:grant-type:device_code`），依次得到 `authorization_pending` / `slow_down` / `access_denied` / `expired_token`，批准后一次性拿到 `{ access_token, token_type: "Bearer", expires_in, scope }`，客户端直接写进 0600 的令牌文件，不打印。`device_code` 只能兑换一次。
- 加密只用现成的：TLS 由 nginx 终止；随机数 `crypto.randomBytes`；口令 `crypto.scrypt`；比较 `timingSafeEqual`。不自创协议。长期凭据不进 URL、聊天、日志或报告。

## 7. 健康、日志、保留

- `GET /v2/health` → `{ ok: true }`，不要令牌，不含键名、正文、计数、凭据。
- 审计日志（JSONL，0600）：`auth.fail`（只记原因与令牌 id，不记秘密）、`token.issue / token.revoke`、`device.code / device.approve / device.deny / device.token`（`user_code` 只记前 2 位）、`login.ok / login.fail`、`message.post`（id、from、to、kind、字节数，不记正文）、`message.state`。stdout（pm2 日志）只打同样脱敏的事件。审计保留 `auditRetentionDays`（缺省 30 天），启动时与每小时裁剪一次。
- 存储文件（JSON，0600，先写临时文件再换名）：主体、令牌哈希、口令哈希、消息、seq、幂等记录。

## 8. 迁移与回滚

- 迁移（每步可单独回退）：① 部署 v2 进程（不碰旧进程）；② 加 nginx `location /coord/v2/`；③ 设管理口令；④ 建主体（doger、codex-laptop、claude-cloud……）；⑤ 签发令牌或走设备授权；⑥ 会话逐个改用 v2；⑦ 全部迁完、用户同意后，再决定旧信箱是否下线、旧令牌是否轮换（本设计不要求、不做）。
- 回滚：删 nginx `location /coord/v2/` 并 reload → `pm2 stop probe-coord-v2`。旧信箱一直在跑，旧客户端不受影响。v2 存储文件保留，可再启用。

## 9. 需要用户批准才做的事

生产部署（复制文件到服务器、建 pm2 应用）；nginx 加 `/coord/v2/` 或改 `/coord/healthz`；设管理口令；建主体、签发真实令牌、批准设备授权；任何安全配置改动；旧信箱下线或旧令牌轮换。

## 10. 部署步骤（草案，每一步都等用户批准；以下都不含任何秘密值）

1. 只读核对服务器副本：`sha256sum /opt/probe-coord/probe-coord.mjs`，与仓库各提交比对，记下实际部署的是哪版（现在没有记录）。v2 不改这个文件。
2. 建目录 `/opt/probe-coord-v2/`（0700），放 `probe-coord-v2.mjs`；pm2 新应用 `probe-coord-v2`：
   `node probe-coord-v2.mjs serve --port 8800 --host 127.0.0.1 --store /opt/probe-coord-v2/store.json --audit /opt/probe-coord-v2/audit.jsonl --admin-socket /opt/probe-coord-v2/admin.sock --public-base https://8-219-80-16.sslip.io/coord/v2`。不需要任何环境变量里的秘密。
3. nginx 加（`proxy_read_timeout` 保持在 60 s 以上，长轮询挂 25 s）：
   ```nginx
   location /coord/v2/ {
     proxy_pass http://127.0.0.1:8800/v2/;
     proxy_set_header Host $host;
     proxy_read_timeout 60s;
     client_max_body_size 1m;
   }
   ```
   `nginx -t && systemctl reload nginx`（reload 不断旧连接）。
4. 设管理口令（在服务器上，口令只走标准输入，不进命令行历史）：`node probe-coord-v2.mjs admin --socket /opt/probe-coord-v2/admin.sock passphrase-set`，然后输入一行口令。
5. 建主体，例如：
   `admin … principal-add --id doger --kind doger --max-scopes status,inbox:read,send --send-to codex-laptop`
   `admin … principal-add --id codex-laptop --kind codex --max-scopes status,inbox:read,send --send-to doger,claude-cloud`
   `admin … principal-add --id claude-cloud --kind claude --max-scopes status,inbox:read,send --send-to codex-laptop`
6. 给不能走浏览器的会话（云端 Claude、本地 Codex）签发令牌：`admin … token-issue --principal claude-cloud --scopes status,inbox:read,send --send-to codex-laptop --ttl-days 14 --token-out /root/claude-cloud.token`，再由用户本人把文件内容填进该会话的环境变量 `PROBE_MAIL_V2_TOKEN`，之后删掉服务器上的这个文件。
7. （可选）收口旧 `/coord/healthz`：见第 3 节 (a) 或 (b)。
- 回滚：第 8 节。

## 11. doger 的最小接入步骤（部署与建主体之后）

1. 拉仓库，Node 22 以上。
2. `node scripts/probes/probe-coord-v2.mjs login --base https://8-219-80-16.sslip.io/coord/v2 --principal doger --scopes status,inbox:read --token-file ~/.config/promptcut/doger.token`（要发消息再加 `send` 与 `--send-to codex-laptop`）。
3. 终端显示地址和 8 位代码；用户在自己的浏览器打开地址、登录、输入代码、核对权限后批准。
4. 客户端自己把令牌写进 0600 的令牌文件，不打印。之后：
   - 看身份：`… whoami --base … --token-file …`
   - 等消息：`… wait --base … --token-file … --state ~/.config/promptcut/doger.cursor --timeout-min 9`
   - 报状态：`… state --base … --token-file … --id <消息 id> --state received|processed|failed`
   - 发消息（有 send 时）：`… send --base … --token-file … --to codex-laptop --kind receipt --reply-to <id> --body-file <文件>`
5. 不用了就请用户在服务器上 `admin … token-revoke --token-id <id>`（`whoami` 的 `tokenId` 就是它）。

## 12. 已知限制

- 设备码申请不要令牌（RFC 8628 本来如此）：同时待批的码上限 20 个，超出回 429；恶意大量申请只会让 doger 稍后重试，拿不到任何权限。
- 登录失败全局计数：连续 10 次失败锁 15 分钟，也会把真管理员一起锁住（不信任代理转来的客户端地址，换来不被伪造地址绕过）。
- 没有按令牌的发送速率限制；消息大小 256 KiB、请求体 512 KiB 有上限。
- 存储是单个 JSON 文件整份重写，适合几个主体、几百条消息的量。
- 设备授权中的待批码只在内存，v2 进程重启就作废，客户端重新 `login` 即可。
