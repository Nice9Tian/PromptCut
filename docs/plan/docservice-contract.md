# 文档服务本体最小版契约（C6.3）

主 Agent 定稿，2026-09-25（用户授权自动推进）。实现方与测试方**只照本文写**，互不看对方的代码。本文要改只能由主 Agent 改，并同时通知各方。

- 计划：`docs/plan/Master-Execution-Plan.md` C6 一节 C6.3 行
- 设计：`docs/plan/cloud-task.md` 组件表的「文档服务」「内容库」两行、D 节；独立审查 `docs/reports/REVIEW-c6-agy.md` 第 4 节子阶段 3、第 5 节第 4 条
- 语义：`docs/semantics/product/document-service.md`「职责」「版本与身份」
- 现有接口：`render-queue-contract.md` G 节（通用核心与模块）、H 节（频道与背压）

## 0. 范围与一处刻意的留白

**做**：
1. **项目版本模块**：页面每次改完项目，把项目内容的摘要报给文档服务，文档服务按它发 `projectRev`、记版本日志、在 `project:<id>` 频道上广播；
2. **内容库模块**：`content.put` / `get` / `list` / `watch`，`card-source` 这一类按键发 `cardRev`；
3. **挂载模式**：同一份文档服务代码既能独立监听（远程文档服务），也能挂到一个现成的 http 服务器上（本地文档服务，挂进 vite）；
4. **本地文档服务插件** `server/vite-plugin-docservice.ts`；
5. 独立进程 `main.mjs` 挂上新模块，并落盘。

**不做，这是刻意的留白**：
- 操作的格式、页面与 Agent 的写经文档服务（D1）、页面按操作收增量（D2）、撤销与重做。第 6 步没有定义操作格式和撤销语义，属于语义未定，留给 C6.5 交用户裁决。
- 本阶段文档服务**不持有项目内容**，页面仍是项目的真身（`TODO.md`「语义与代码的差距」原有的一条）。「项目版本模块」只做编号与通知，是 D1 之前的过渡。它没有让现状更偏离语义，C6.5 落地后由操作日志取代。
- 页面接入（页面什么时候报摘要）在 M5b 的页面分支做，本阶段只做服务端。

## 1. 项目版本模块（`server/docservice/modules/project.mjs`）

```js
export function projectModule({ store, now? } = {}) → module     // types: ['project.'], channels: ['project']
```

| 入站 | 字段 | 回包 | 其它效果 |
|---|---|---|---|
| `project.open` | `projectId` | `project.state { projectId, projectRev, digest, at }` | 订阅 `project:<projectId>`。从没见过的项目：`projectRev: 0`、`digest: null`、`at: null` |
| `project.announce` | `projectId`、`digest`、`session?` | `project.announced { projectId, projectRev, changed }` | `digest` 与当前不同：`projectRev += 1`，写一条日志，在 `project:<projectId>` 上发布 `project.rev { projectId, projectRev, digest, actor, at }`（合并键 `'project-rev:' + projectId`），`changed: true`。相同：什么都不变，`changed: false` |
| `project.close` | `projectId` | `project.closed { projectId }` | 退订 |

- **校验**（不过就回 `error { reason: 'bad-message' }`，状态不变）：
  - `projectId` 匹配 `/^[A-Za-z0-9._:-]{1,128}$/`；
  - `digest` 匹配 `/^[0-9a-f]{16,128}$/`；
  - `session` 是 1～128 个字符的字符串。
- **身份**：`actor = { userId: principal.userId, session: session ?? null }`，照 B1 的精神。消息里自报的 `userId` 一律不认。
- **回包带 `reqId`**：请求带了 `reqId` 就原样带回，本模块的所有回包都这样。
- **版本号**：`projectRev` 从 1 起，只增不减，跨重启保持（从日志恢复）。
- **日志**：每个项目一条追加日志，每次变更追加一行 JSON：`{ projectId, rev, digest, actor, at }`。
- 不向发起方以外的连接单独回 `project.announced`；频道广播时发起方自己也在订阅者之列，会照样收到 `project.rev`。

## 2. 内容库模块（`server/docservice/modules/content.mjs`）

```js
export function contentModule({ store, now?, maxBodyBytes = 256 * 1024 } = {}) → module   // types: ['content.'], channels: ['content']
```

`kind` ∈ `card-source` | `snapshot-manifest` | `render-manifest` | `event-detail`，取自 `cloud-task.md` 组件表。其它值回 `bad-message`。

| 入站 | 字段 | 回包 |
|---|---|---|
| `content.put` | `kind`、`key`、`body` | `content.stored { kind, key, hash, rev? }` |
| `content.get` | `kind`、`key` | `content.item { kind, key, body, hash, rev? }`，没有就回 `content.item { kind, key, missing: true }` |
| `content.list` | `kind`、`prefix?` | `content.listing { kind, items: [{ key, hash, rev? }], truncated }`，按 `key` 升序，最多 1000 条 |
| `content.watch` | `kinds: string[]` | `content.watching { kinds }`，并订阅 `content:<kind>` |

- **键与正文**：`key` 是 1～512 个字符的字符串；`body` 是任意 JSON 值。
- **`hash`**：`sha256(JSON.stringify(body))`，十六进制。`body` 序列化后超过 `maxBodyBytes` 就回 `error { reason: 'too-large' }`，不落任何状态。
- **`rev`**：只有 `card-source` 有，按 `key` 从 1 起，每次 `put` 加一，内容相同也加（它就是 `cardRev`）。其它 `kind` 没有 `rev`。
- **覆盖**：同一 `(kind, key)` 再 `put`，后写的赢（决议 11 的现行口径）。之后在 `content:<kind>` 上发布 `content.changed { kind, key, hash, rev?, actor, previousActor }`，合并键 `'content:' + kind + ':' + key`。`previousActor` 是被覆盖的那次写入的 `actor`，第一次写入为 `null`。覆盖方与被覆盖方都能知道：前者看 `content.stored`，后者看频道里的 `previousActor`。清单按键怎么拆，留给 C6.4。
- **日志**：每个 `kind` 一条追加日志，每行 `{ kind, key, hash, rev?, actor, at, body }`。重启时回放，恢复每个键的最后状态与 `rev`。

## 3. 日志存储（`server/docservice/store/`）

```js
// server/docservice/store/index.mjs
export function createFileStore({ dir }) → Store      // 追加写 <dir>/projects/<projectId>.ndjson、<dir>/content/<kind>.ndjson
export function createMemoryStore() → Store
Store = {
  append(stream: string, record: object) → void,       // 同步追加一行（fs 实现用 appendFileSync，保证顺序与崩溃后的完整性）
  read(stream: string) → object[],                     // 读出全部记录；坏掉的最后一行（半行）丢弃并记日志
}
```

- `stream` 是 `projects/<projectId>` 或 `content/<kind>` 这样的相对名，实现负责把它映射到文件名；路径穿越要拒绝。
- 只用 Node 内置模块（`render-node-deps` 的 D2 守门同样覆盖 `server/docservice/`）。
- 模块在第一次用到某个 stream 时回放一次，之后只在内存里维护。

## 4. 挂载模式（`server/docservice/service.mjs`）

`createDocService` 新增选项 `server?: http.Server`：
- **不传**：照旧自建 http 服务器，`/healthz` 行为不变，现有测试全过。
- **传了**：
  - 不建服务器，也不答任何 HTTP 请求；
  - 只在 `server` 上挂一个 `upgrade` 监听，只处理 `url.pathname === options.path` 的升级，其余一律不碰。vite 的 HMR 也走 upgrade，不能抢；
  - `listen()` 抛错，因为宿主负责监听；
  - `close()` 只关自己的连接和计时器，移除自己的 `upgrade` 监听，不关宿主服务器；
  - 另外暴露 `health()`，返回与 `/healthz` 相同的对象，由宿主自己挂路由。
- 其余行为（鉴权、心跳、模块、频道、背压）两种模式完全相同。

## 5. 本地文档服务插件（`server/vite-plugin-docservice.ts`，新建）

- 在 `configureServer` 里用挂载模式：`createDocService({ server: server.httpServer, path: '/docservice', authenticate, log })`。
- 挂上五个模块：
  - 渲染任务队列：`createRenderQueue` + `mountRenderQueue`；
  - `endpointsModule()`；
  - `projectModule({ store })`；
  - `contentModule({ store })`；
  - 存储用 `createFileStore({ dir: <root>/out/docservice })`。
- **鉴权**：
  - 请求来自本机回环（按 `http-guard.mjs` 的 `clientAddressOf` 判真实对端）→ `principal = { userId: 'local', tenantId: 'local' }`；
  - 否则走集群令牌（`createClusterAuth({ token: process.env.PROMPTCUT_CLUSTER_TOKEN, allowAnonymous: false })`），没配令牌就一律拒绝。
- **HTTP**：`GET /api/docservice/healthz` 回 `service.health()`。这条路由要进 `http-guard.mjs` 的同源守卫豁免吗？不进：它只给本机和同源用，照现有守卫。
- `httpServer` 关闭时调 `service.close()`。任何一步出错都只打日志，不影响编辑器启动。
- 在 `vite.config.ts` 的插件列表里注册，只加这一个插件。
- **不改**预渲染进程（`vite.prerender.config.ts`）：文档服务只在编辑器进程里一份。

## 6. 独立进程（`server/docservice/main.mjs`）

- 挂上 `projectModule`、`contentModule`；
- 存储目录取环境变量 `PROMPTCUT_DOCSERVICE_DATA`，缺省 `<部署目录>/data`（相对 `main.mjs` 解析为 `../../data`）；
- 部署脚本不用改：拷的还是 `server/docservice/`（含 `modules/`、`store/`）与 `server/render-queue/`。

## 7. 测试（Verification）

**`server/test/docservice-project.test.mjs`**（`createDocService` 独立模式，端口 0，`autoTick: false`，存储用 memory 或临时目录）：

| 编号 | 内容 |
|---|---|
| P1 | `project.open` 没见过的项目：`projectRev: 0`、`digest: null` |
| P2 | `announce` 新摘要：`projectRev` 加一；只有订阅了这个项目的连接收到 `project.rev`，别的项目的订阅者 0 条 |
| P3 | 相同摘要：不加，`changed: false`，没有广播 |
| P4 | 文件存储：服务关掉后在同一目录新建，`projectRev` 与 `digest` 恢复，下一次 `announce` 从恢复值往上加 |
| P5 | 日志文件逐行是合法 JSON，字段齐全，`actor.userId` 来自 principal，不来自消息 |
| P6 | 校验：`projectId`、`digest`、`session` 不合法 → `bad-message`，状态不变 |
| P7 | 日志最后一行被截断（手工写半行）：恢复时丢掉这一行、不崩，之前的记录都在 |

**`server/test/docservice-content.test.mjs`**：

| 编号 | 内容 |
|---|---|
| N1 | `put` 后 `get` 取回相同的 `body`，`hash` = `sha256(JSON.stringify(body))` |
| N2 | `card-source` 同一键连续 `put` 三次：`rev` 为 1、2、3，内容相同也加；其它 `kind` 没有 `rev` |
| N3 | `list` 按 `prefix` 过滤、按 `key` 升序；超过 1000 条时 `truncated: true` |
| N4 | 没有的键回 `missing: true` |
| N5 | `body` 超过 `maxBodyBytes` 回 `too-large`，不落状态 |
| N6 | `content.watch` 的连接在覆盖时收到 `content.changed`，`previousActor` 正确；没 watch 的收不到 |
| N7 | 文件存储重启恢复每个键的最后状态与 `rev` |
| N8 | 不认识的 `kind` 回 `bad-message` |

**`server/test/docservice-attach.test.mjs`**：

| 编号 | 内容 |
|---|---|
| M1 | 挂到一个现成的 http 服务器上。该服务器另有一个 `upgrade` 处理器接管 `/other` 路径，模拟 HMR：`/docservice` 的 WebSocket 能用，`/other` 的升级仍然由原处理器处理，文档服务不碰它 |
| M2 | `close()` 之后宿主服务器仍在监听，别的路径照常；文档服务的连接都断开；`upgrade` 监听已移除 |
| M3 | 挂载模式下 `listen()` 抛错；`health()` 与独立模式 `/healthz` 的字段相同 |
| M4 | 挂载模式与独立模式的模块、频道、鉴权行为相同：同一组 R1、C1 式的断言各跑一遍 |

插件本身是 `.ts`，挂在 vite 里，不写单测，由主 Agent 在集成时起 dev server 实测：
- `/api/docservice/healthz` 可用；
- 本机经 `ws://127.0.0.1:<端口>/docservice` 连上，`principal` 是 `local`；
- vite 的 HMR 照常。

## 8. 文件归属

| 子分支 | 文件 |
|---|---|
| `claude/c6-3-impl` | `server/docservice/service.mjs`、`main.mjs`、`modules/project.mjs`（新）、`modules/content.mjs`（新）、`store/index.mjs`（新）；`server/vite-plugin-docservice.ts`（新）；`vite.config.ts`（只注册插件） |
| `claude/c6-3-tests` | 第 7 节的三个测试文件（新），需要的 `server/test/fake-*.mjs` |
| 主 Agent | 本文；C6.3 报告；集成时的 dev server 实测 |

## 9. 验收

- G0 通用门槛。
- 第 7 节全过。既有的文档服务测试（`docservice*`、`render-node-*`、`render-queue-*`）一字不改、全过。R2 与 D2 守门照旧通过。
- 插件实测（第 7 节末段）通过。
- **G0-R 跑一遍**：改了 `vite.config.ts`，确认没有副作用。只要求 `verify-determinism` 1800/1800 与 `verify-unified-frames` PASS。
- 远端重新部署后，`ws-client-test` 对远端 14/14，`/healthz` 里 `modules` 含 `project`、`content`。

## 10. 定稿后的补充细则（2026-09-25，主 Agent 按实现方疑点裁定）

1. **挂载模式的 `listen()`**：同步抛错。
2. **回包与广播的先后**：同一条请求先回包、后广播，即 `announced` / `stored` 先于 `rev` / `changed`。
3. **`content.watch`**：以最后一条为准，是替换，不是累加。
4. **内容库的 `actor`**：与项目模块相同，是 `{ userId, session }`，`content.put` 接受可选的 `session`；`session: null` 视为没给。
5. **两个新模块不加 `/healthz` 字段**，只提供 `describe()`。
6. **无头实例不挂文档服务**：`PROMPTCUT_HEADLESS === "1"` 时，`vite.config.ts` 不注册 `docservicePlugin()`。无头实例和用户的编辑器共用同一个项目根，两边同时发号会冲突。
7. **日志不经 HTTP 暴露**：`vite.config.ts` 的 `fsDeny` 加 `**/out/docservice/**`，局域网设备读不到日志与卡片源码。
8. **`.gitignore` 加 `/data/`**：`main.mjs` 在仓库里直接跑时的缺省数据目录。
9. **文件名只差大小写的项目**：在 Windows 上会落到同一个日志文件。回放时按记录里的 `projectId` 过滤，结果仍然正确。
10. **stream 名编码成文件名**：存储层把 stream 名映射成文件名时，`[A-Za-z0-9._-]` 原样保留，其余每个字节按 UTF-8 写成 `%XX`（大写十六进制），`%` 本身也编码。例如 `projects/a:b` → `projects/a%3Ab.ndjson`。否则 Windows 上 `:` 会把日志写进一个看不见的备用数据流。
11. **半行补换行**：往文件第一次追加之前，末尾不是换行就先补一个，免得新记录接在截断的半行后面，下次重启时一起丢掉。
12. **路径穿越**：存储层拒绝时抛错，目录外什么都不写。
13. **不合法的内容键**：`key` 不合法回 `bad-message`。`maxBodyBytes` 按序列化后的 UTF-8 字节数算。`body: null` 合法。
14. **升级 socket 的防崩**（覆盖第 6 条）：
    - **插件总是注册**；`PROMPTCUT_HEADLESS === "1"` 时进入停用模式：
      - 不建文档服务、不写日志；
      - `/docservice` 的升级请求回 503 并关闭；
      - `/api/docservice/healthz` 回 `503 { ok: false, disabled: true, reason: 'headless' }`。
    - **所有升级请求的 socket 都挂一个空的 `error` 监听**，两种模式都挂，去重后只挂一次。
    - **原因**：vite 的 HMR 监听遇到不是自己的路径会直接返回，socket 上没有错误监听。客户端一重置连接，就成了未处理的 `ECONNRESET`，整个 dev server 退出。这是 C6.3 之前就有的问题：局域网里任何一台设备都能这样打崩编辑器。
