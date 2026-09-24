# M5a 文档服务侧实现报告（svc）

分支 `claude/rq-m5a-svc`，基于 `claude/rq-m5a`（b17c50a）。依据：`docs/plan/render-queue-contract.md` G 节（G.1～G.6）。

## 进度

- [x] 核心 `router.mjs`（G.2、G.3）
- [x] 鉴权 `auth.mjs`（G.5）
- [x] 队列模块 `modules/render-queue.mjs`（G.4）
- [x] 登记模块 `modules/endpoints.mjs`（G.6）
- [x] 组装层 `service.mjs`、`ws.mjs`（G.4、G.5）
- [x] `main.mjs`、`ecosystem.config.cjs`、`scripts/remote/docservice.mjs`（G.5）
- [x] 收尾基线

## 做了什么

只改了 G.10 分给 svc 的文件；`server/render-queue/`、`server/render-node/`、`server/test/` 一个字没动。

| 文件 | 内容 |
|---|---|
| `server/docservice/router.mjs`（新） | `createRouter({ now, log, write })`，接口照 G.2：`connect / disconnect / dispatch / mount / tick / send / describeConn / health / modules`。信封校验、`bad-message` / `unsupported` / `internal` 三种核心错误（`internal` 带原 `reqId`，同步抛出与 Promise 被拒都接住，记 `module.error { module, type, message }`）。挂载时查三种类型冲突、查 `describeConn` / `health` 字段与核心字段及已挂模块重名；挂载时对已有连接调 `connect`，卸载时调 `disconnect`；`ctx` 只有 `send / now / log`。源码文本（含注释）不含守门词 |
| `server/docservice/auth.mjs`（新） | `PROTOCOL`、`createClusterAuth`、`isLoopbackHost`、`checkTokenFormat`，另导出 `offeredProtocols(req)` 给组装层用。令牌模式下缺 `promptcut.v1` → `no-protocol`，缺令牌项 → `no-token`，不符 → `bad-token`；比对是两边 sha256 后 `timingSafeEqual`。通过 → `{ userId: 'cluster', tenantId: 'cluster' }` |
| `server/docservice/modules/render-queue.mjs`（新） | `renderQueueModule(q, { sweepMs })` 与 `renderQueuePlaceholder()`。类型取自 `messages.mjs` 的 `NODE_TYPES`、`PUBLISHER_TYPES` 加两个 hello；`recordRole` / `rolesOf` 原样搬来，角色记在模块自己的连接表；`health()` = `{ queue: true, publishers, nodes, epoch }`；占位模块回 `queue-unavailable` |
| `server/docservice/modules/endpoints.mjs`（新） | `ENDPOINT_DEFAULTS` 与 `endpointsModule(options?)`（见「契约疑点」第 1 条）。`service.announce / withdraw / watch`，推送一律是按订阅者 `kinds` 过滤的全量；校验、上限 64、断开后宽限 10 s（严格大于才删）、宽限期内同内容改绑不推送 |
| `server/docservice/service.mjs` | 组装层改为「传输 + router + 模块」。新选项 `modules`、`autoTick`、`protocol`；新方法 `mount`、`tick`。创建时挂占位模块，`mountRenderQueue` 先校验、再把占位换成真队列，卸载函数换回占位。`/healthz` 核心字段 `ok / service / uptimeMs / connections / protocol / modules` 加各模块字段平铺；`describe()` 的 `conns[i]` 是核心字段加模块字段，另有 `modules: { [name]: describe() ?? null }`。握手时客户端给了 `protocol` 才回显它，其它子协议项（含令牌项）一律不回 |
| `server/docservice/ws.mjs` | `acceptUpgrade` 新增可选参数 `protocol`（只接受合法 HTTP token 字符，防止拼出多余响应头）。另修了一个旧问题，见下 |
| `server/docservice/main.mjs` | 读 `PROMPTCUT_CLUSTER_TOKEN`，失败即关（`bad-token-format` / `token-required`，退出码 1）；回环且未设 → 匿名；已设 → 令牌模式。挂队列（`mountRenderQueue`）与服务地址登记（`mount(endpointsModule())`）。文件头写了生成令牌的命令。`listen` 日志多一个 `auth: 'anonymous' | 'token'` |
| `server/docservice/ecosystem.config.cjs` | 本机环境里有 `PROMPTCUT_CLUSTER_TOKEN` 才透传，不写值 |
| `scripts/remote/docservice.mjs` | `deploy` 先查本机 `PROMPTCUT_CLUSTER_TOKEN`：没设或格式不对就拒绝部署（在 ssh 之前）。令牌只拼进经 ssh 标准输入交给远端 `bash -s` 的脚本（`export` 后 `pm2 startOrReload --update-env`），脚本里显式 `set +x`；不上命令行、不打印。`scp -r server/docservice` 已经包含 `modules/`，文件头写明 |

**`ws.mjs` 的额外修复（契约之外，但在分给我的文件里）**：http 服务的 socket 是 `allowHalfOpen`，升级之后 http 解析器不再替我们收尾。对端不发关闭帧、只结束 TCP（进程退出、`--exit-after-claim` 这类「干净断开」）时，服务端一直半开，要等心跳 30～60 s 才发现，队列的 `disconnect` 也跟着晚。加了 `socket.on('end')` 时这边也 `end()`，`close` 立刻发生。自测里发现的：原始 TCP 客户端 101 后 `destroy()`，`service.close()` 要等 2 s 的关闭超时才结束。旧测试 17 条照过。

## 验证

### 基线（在 worktree 里跑）

```
npx tsc -b --force        → 退出码 0，零错误
npm test                  → 退出码 0
  ℹ tests 2197  ℹ pass 2196  ℹ fail 0  ℹ skipped 1
  唯一的跳过：server/test/cards-layout.test.mjs「集成:/api/cards/layout 对真实项目返回整数框」（要 PC_STAGE_TEST_URL，即 5190 的 dev server）
node --test server/test/docservice.test.mjs → pass 17 / fail 0（文件未改）
```

### 守门词（R2）

```
grep -nE "render-queue|modules/|task\.|node\.hello|publisher|queue" server/docservice/ws.mjs server/docservice/router.mjs
→ 无输出，退出码 1
```

（`router.mjs` 文件头原本引用了契约文件名 `render-queue-contract.md`，也会命中，已改成不写全名。）

### scratch 自测（脚本在会话 scratchpad，未提交）

`node svc-selftest.mjs`，全部服务端口 0，令牌用 `randomBytes(32).toString('base64url')` 本地生成：

```
PASS R1/R5/R7 路由、示例模块与队列同时在线、internal 错误、healthz 与 describe
PASS R3 类型与字段冲突在挂载时抛错、已挂模块不受影响
PASS R3b 字段冲突
PASS R6 卸载后 unsupported；mountRenderQueue 卸载后 queue-unavailable
PASS A1～A5 令牌模式
PASS A4 匿名模式：旧客户端与 promptcut.v1 回显
PASS E1～E8 服务地址登记
PASS A6 main.mjs 回环匿名起得来、/healthz 正常；令牌模式起得来
exit=0
```

测了什么：

- **R1**：示例 `text.` 模块与真队列同一条连接交替发，各回各的；
- **R5**：`handle` 同步抛出和返回被拒的 Promise 都回 `internal`（带 `reqId`），之后同一连接照常；
- **R7**：`/healthz` 实测：
  `{"ok":true,"service":"promptcut-docservice","uptimeMs":25,"connections":1,"protocol":"promptcut.v1","modules":["render-queue","text"],"textOk":true,"queue":true,"publishers":0,"nodes":1,"epoch":"…"}`；
- **R3**：三种类型冲突、`health` 与 `describeConn` 字段重名（与核心、与别的模块）、模块名重复都抛错，已挂模块照常；
- **R6**：卸载后 `unsupported`，`mountRenderQueue` 的卸载函数之后 `queue-unavailable`、角色清空，还能再挂；
- **A1**：原始 TCP 握手：无子协议、只有 `promptcut.v1`、令牌错都是 401；
- **A2**：令牌对 → 101，响应头里 `Sec-WebSocket-Protocol` 行恰好一行 `promptcut.v1`；Node 内置 `WebSocket` 连上，`ws.protocol === 'promptcut.v1'`；
- **A3**：消息里自报 `userId` 不改变 principal；
- **A5**：全部日志、`describe()`、`/healthz` 拼起来找不到令牌原文。拒绝日志实测：
  `["auth.reject",{"remote":"127.0.0.1","reason":"no-protocol"}] … "no-token" … "bad-token"`；
- **E1～E8**：注入 `now` + `autoTick: false` 手动 `tick`；正好 `GRACE_MS` 不删，`+1` 删并推送空列表。

失败即关与部署拒绝（直接跑，未连任何远端）：

```
PROMPTCUT_DOCSERVICE_HOST=0.0.0.0，无令牌        → {"event":"config.error","reason":"token-required"}   exit=1
PROMPTCUT_CLUSTER_TOKEN=short，HOST=127.0.0.1     → {"event":"config.error","reason":"bad-token-format"} exit=1
不设 HOST（缺省 0.0.0.0），无令牌                → token-required                                       exit=1
PROMPTCUT_REMOTE=nobody@invalid.example deploy，无令牌 → 「缺 PROMPTCUT_CLUSTER_TOKEN…」exit=1（ssh 之前就退出）
同上，令牌 abc                                    → 「格式不对」exit=1
```

用现有探针打本机 `main.mjs`（匿名、回环）：`node scripts/probes/ws-client-test.mjs ws://127.0.0.1:8793` → `9/9 passed`，exit=0。这一步用了 8793，落在测试方的 8790～8799 段里；只占了约 1 秒，是我自己起的进程，跑完已结束、端口已释放。以后自测只用端口 0。

没跑：导出确定性、快照重放、画面探针。本次没动渲染、导出、卡片和页面，G0-R 不适用。

## 契约疑点（都按最保守的读法做了，请主 Agent 裁定）

1. **登记模块的工厂名契约没给。** 导出 `endpointsModule(options?)`，与 `renderQueueModule` 对称；另导出别名 `createEndpointsModule` 和 `default`，免得测试方猜的名字对不上。`options` 可以覆盖 `graceMs`、`maxAnnouncers`、`maxUrls`、`maxMetaBytes`、`tickMs`，缺省取 `ENDPOINT_DEFAULTS`。建议契约写明工厂名。
2. **`auth.reject` 由谁记。** G.5 的签名 `createClusterAuth({ token, allowAnonymous })` 里没有 `log`，而 `authenticate` 只回 principal 或 null，组装层拿不到拒绝原因。我加了可选参数 `log`，由 `authenticate` 自己记 `auth.reject { remote, reason }`，`main.mjs` 传入。测试只把 `log` 传给 `createDocService` 时，拒绝不进那份日志（A5 只查「没有令牌原文」，不受影响）。
3. **没设令牌且 `allowAnonymous` 为假**：契约没说。我按全部拒绝处理，原因记 `no-token`。
4. **多个令牌项**：一律按 `bad-token` 拒绝，不猜哪个是真的。
5. **`modules` 字段在两处形状不同**：`/healthz` 的 `modules` 是模块名数组，`describe()` 的 `modules` 按 G.4 是 `{ [name]: describe }` 对象。`describe()` 本来平铺了 `health()`，所以这里以对象为准（覆盖数组）。
6. **核心保留的健康字段多一个 `conns`**：`describe()` 把健康字段和 `conns` 平铺在同一层，模块的 `health()` 用 `conns` 会被挡掉，所以挂载时一并查重名。
7. **挂载时查 `describeConn` 字段**：用一个不存在的连接 id 调一次。所以模块对不认识的连接也要回完整字段集，两个自带模块都是这样做的。`describeConn` / `health` 回非对象时挂载抛 `TypeError`。
8. **有 `tick` 没有 `tickMs`**：不起计时器，只能手动 `tick()`。
9. **`modules` 选项里自带名为 `render-queue` 的模块**：这时不挂占位模块，之后 `mountRenderQueue` 抛「已经挂上」。
10. **登记模块的几处细节**：
    - 没给 `meta` 时条目里是 `meta: null`；
    - 宽限期内从新连接再登记，`urls` 与 `meta` 都没变才不推送、`since` 不变；只有 `meta` 变了也推送（契约只写了 `urls`，这样订阅方不会看到旧 `meta`）。其它情形的替换一律推送、`since` 取新时刻；
    - `service.` 下未知的类型回 `unsupported`；
    - `kinds: []` 合法，什么都看不到；
    - 各回包都带原 `reqId`，推送不带。
11. **`config.error` 同一行写到 stdout 和 stderr**：A6 只说「输出含」，两边都有，免得测试查错流。
12. **空字符串令牌**：`main.mjs` 视为「已设」，所以是 `bad-token-format`、退出码 1（失败即关）；部署脚本视为没设，拒绝部署。
13. **`isLoopbackHost` 只认契约列的三个串**：`127.0.0.1`、`::1`、`localhost`。`127.0.0.2`、`[::1]` 之类不算回环，没令牌时拒绝启动。
14. **宽限时长**：计划第 7 节 M5a 表写的是「过 `RECONNECT_GRACE_MS`」，契约 G.6 定为 `GRACE_MS: 10_000`，按契约做。
15. **`unsupported` 的 `detail` 不再带消息类型名**：旧代码是「还不支持 ${type}」，按 G.2「不含消息原文」改成固定短句。旧测试只查 `reason`，不受影响。
16. **队列模块的 `describe()` 直接回 `q.describe()`**：里面有任务租约的 `claim.token`。那是队列自己的认领令牌，不是集群令牌；要是也不想让它出现在诊断里，可以改成只给摘要。
