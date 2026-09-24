# C6.3 实现方报告（c6-3-impl）

- 分支：`claude/c6-3-impl`（从 `claude/c6-3` 的 `ed7d388` 起）
- 依据：`docs/plan/docservice-contract.md` 第 1～6 节；`docs/plan/render-queue-contract.md` G、H 节
- 端口段：5490～5499（实际用了 5490 与它的舞台端口 5491、5492，跑完已关，三个端口确认空闲）

## 做了什么

| 文件 | 内容 |
|---|---|
| `server/docservice/store/index.mjs`（新） | `createFileStore({ dir, log? })`、`createMemoryStore()`。stream `<命名空间>/<名字>` → `<dir>/<命名空间>/<名字>.ndjson`；`appendFileSync` 一次写一行；读时丢弃解析不了的行并记 `store.bad-line`；本进程第一次往某文件追加前，文件不以换行结尾就先补一个换行（记 `store.repair`），半行不会连累新记录。路径穿越拒绝（命名空间正则、名字禁 `/` `\` NUL、映射后再核一次落在 `dir` 里） |
| `server/docservice/modules/project.mjs`（新） | `projectModule({ store, now })`，`types: ['project.']`，`channels: ['project']`。`open` / `announce` / `close` 照第 1 节；校验不过回 `bad-message`、状态不变；`actor` 取 principal；先落日志再改内存；第一次用到某项目时从日志回放 |
| `server/docservice/modules/content.mjs`（新） | `contentModule({ store, now, maxBodyBytes })`，`types: ['content.']`，`channels: ['content']`。`put` / `get` / `list` / `watch` 照第 2 节；`card-source` 按键发 `rev`；`too-large` 不落状态；覆盖时在 `content:<kind>` 上发 `content.changed`（含 `previousActor`，合并键 `content:<kind>:<key>`）；按 `kind` 回放 |
| `server/docservice/service.mjs` | 新增 `server` 选项（挂载模式）：不建服务器，只在宿主上挂一个 `upgrade` 监听，只接 `path` 的升级，其余路径不回包、不关 socket、不挂错误监听；`listen()` 同步抛错；`close()` 摘监听、关自己的连接（等它们都断开）、停计时器，不关宿主；两种模式都暴露 `health()`。独立模式行为不变（关停中 503、别的路径 404、`/healthz`） |
| `server/docservice/main.mjs` | 挂 `projectModule`、`contentModule`；存储目录 `PROMPTCUT_DOCSERVICE_DATA`，缺省相对本文件的 `../../data`；`listen` 日志多带 `dataDir` |
| `server/vite-plugin-docservice.ts`（新） | `configureServer` 里动态引 `server/docservice/…` 与 `server/render-queue/`，挂载模式挂到 `server.httpServer`，路径 `/docservice`；五件套：队列（`createRenderQueue` + `mountRenderQueue`）、`endpointsModule()`、`projectModule({ store })`、`contentModule({ store })`、`createFileStore({ dir: <root>/out/docservice })`。鉴权：`clientAddressOf` 判为回环 → `{ userId: 'local', tenantId: 'local' }`，否则 `createClusterAuth({ token, allowAnonymous: false })`（没配令牌全拒，令牌格式不对记 `config.error` 后全拒）。`GET/HEAD /api/docservice/healthz` 回 `service.health()`。`httpServer` 关闭时 `service.close()`。任何一步出错只打日志 |
| `vite.config.ts` | 只加一行 import、在插件列表末尾加 `docservicePlugin()` |

`router.mjs`、`ws.mjs`、`auth.mjs`、`modules/render-queue.mjs`、`modules/endpoints.mjs`、`server/render-queue/`、`server/render-node/`、`server/test/` 都没动。

## 验证

### 类型检查

`npx tsc -b --force` → 退出码 0，零错误。（`tsconfig.json` 只含 `src/`，插件 `.ts` 不在检查范围内，与其它插件相同。）

### 全量测试

`npm test` → 退出码 0：`tests 2309 / pass 2308 / fail 0 / skipped 1`。唯一跳过是 `集成:/api/cards/layout 对真实项目返回整数框`（要 5190）。

另外单独跑过一次既有文档服务相关的测试批：
`node --test server/test/docservice*.test.mjs server/test/render-node-*.test.mjs server/test/render-queue-*.test.mjs`
第一次有 1 条失败：`render-node-ws.test.mjs` 的 T6（`resolveDocservice` 的 `mode` 是 `offline`、期望 `remote`），它只起假的 `/healthz` 服务器，不经 `service.mjs`；单独重跑通过（3/3），整批重跑 `259/259`，随后全量 `npm test` 也通过。判断是并行负载下的偶发（测试注释里也提到全量时本机 `/healthz` 偶尔超过 1 s），与本次改动无关。

### 自测（scratch，不提交）

脚本 `c63-selftest.mjs` 放在会话 scratchpad，覆盖契约第 7 节的思路（不是测试方的文件）：

```
node c63-selftest.mjs
ok P1 / ok P2 / ok P3 / ok P6 / ok close 退订 / ok P5 / ok P4/P7 恢复 / ok 半行之后追加不坏
ok N1 / ok N2 / ok N4 / ok N5 / ok N6 / ok N8 / ok N7 / ok N3
ok M1 / ok M2 / ok M3 字段集合
passed 19          （退出码 0）
```

要点：P7 手工追加半行后新实例恢复为 rev 2，再 `announce` 得 rev 3，文件最后一行是合法的 rev 3（补换行生效）；M1 宿主另挂 `/other` 的 `upgrade` 处理器回 418，文档服务挂上后 `/other` 仍回 418、处理器被调 1 次；M2 `close()` 后客户端收到 1001，宿主仍在监听、`upgrade` 监听只剩宿主自己那个、普通 HTTP 照常。

### 插件实测（5490）

`node …/vite/bin/vite.js --port 5490 --strictPort --host 127.0.0.1`，工作目录是本 worktree，后台运行，跑完已停。

- `curl http://127.0.0.1:5490/api/docservice/healthz` → HTTP 200，
  `"modules":["render-queue","endpoints","project","content"]`，`protocol: "promptcut.v1"`，`queue: true`，`endpoints: 0`。
- Node 内置 `WebSocket` 连 `ws://127.0.0.1:5490/docservice`（`promptcut.v1`）：`ws.protocol === 'promptcut.v1'`；
  `project.open` → `projectRev: 0, digest: null`；`project.announce` → `projectRev: 1, changed: true`；
  收到 `project.rev`，`actor: {"userId":"local","session":"live"}`；`content.put`（card-source）→ `rev: 1`。
- 经舞台端口 5491 连 `/docservice` 同样可用（代理转发，按真实对端仍算本机）。
- 伪造非本机对端（回环连接带 `x-pc-stage-client: 192.168.1.50`，走 `clientAddressOf` 的判法）→ `HTTP/1.1 401 Unauthorized`，日志 `auth.reject {"reason":"no-token"}`。
- HMR：Node `WebSocket` 以 `vite-hmr` 子协议连 `ws://127.0.0.1:5490/`，协议回显 `vite-hmr`，首条消息 `{"type":"connected"}`。浏览器窗格打开 `http://127.0.0.1:5490/`：控制台 `[vite] connecting...`、`[vite] connected.`；页面 200、含 `/@vite/client`。唯一的 503 是 `/api/stt/status`（worktree 里没有 Python，与本改动无关）。
- 改插件文件时 vite 自动重启（`server restarted.`），旧实例经 `httpServer` 关闭走 `service.close()`，新实例重新挂上；重启后 `project.open` 旧项目得 `projectRev: 1`（从 `out/docservice/projects/*.ndjson` 恢复）。
- dev server 日志里没有升级相关的报错（`grep -iE "error|upgrade"` 除去 vite 自带的 configLoader 提示外为空）。

### G0-R（5490）

- `node scripts/verify-determinism.mjs --url "http://127.0.0.1:5490/?export=1"` → 退出码 0，`Total Frames: 1800 / Identical: 1800 / Different: 0`。
- `PC_FRAME_TEST_URL=http://127.0.0.1:5490 node scripts/verify-unified-frames.mjs` → 退出码 0，`PASS: no video during B; all HTML frames; exact video seek; random replay; cache hits; cumulative C equals A; streamed video contains all 10 frames.`

## 第二轮：契约第 10 节的补修（主会话裁定）

| 条 | 改动 | 提交 |
|---|---|---|
| 无头实例不挂文档服务 | `vite.config.ts`：`...(headless ? [] : [docservicePlugin()])` | `7f724cd` |
| 日志不经 HTTP 暴露 | `vite.config.ts` 的 `fsDeny` 加 `"**/out/docservice/**"` | `7f724cd` |
| 仓库根不出现 `data/` | `.gitignore` 只加一行 `/data/`（`main.mjs` 缺省仍是 `../../data`） | `7f724cd` |
| 第 10 条：文件名统一编码 | `store/index.mjs`：`[A-Za-z0-9._-]` 原样，其余每个 UTF-8 字节写成 `%XX`（大写），`%` 也编码；去掉原来「保留设备名首字母编码」的特例（本机 Windows 11 实测 `CON.ndjson`、`nul.ndjson`、`COM1.ndjson` 都是普通文件）；读写同一映射；路径穿越照旧拒绝 | `f514d30` |

补换行一条确认已有：本进程第一次往某文件追加前，文件末尾不是换行就先补一个（`store.repair`）。

### 第二轮验证

- `npx tsc -b --force` → 退出码 0。
- `npm test` → 退出码 0，`tests 2309 / pass 2308 / fail 0 / skipped 1`（同上，5190 那条）。
- `git check-ignore -v data/x.ndjson` → `.gitignore:4:/data/`。
- 存储映射自测（scratch `store-map-test.mjs`，退出码 0）：`a:b`→`a%3Ab.ndjson`、`x%y`→`x%25y`、`卡`→`%E5%8D%A1`、`a b`→`a%20b`、`..`→`...ndjson`，读写往返一致；没有生成文件 `a`（没写进备用数据流）；`projects/a/b`、`projects/..\x`、`../x`、`projects/`、`/x`、`Projects/x`、含 NUL 的名字，读写都抛 `TypeError`；半行无换行时，新实例追加前补换行，读回 `[1, 2]`。模块自测 `c63-selftest.mjs` 仍 19/19。
- **fsDeny 实测**（正常模式，5490）：磁盘上 `out/docservice/content/card-source.ndjson` 434 字节，下面几种取法都是 **403**、响应里没有日志内容：
  - `/out/docservice/content/card-source.ndjson`
  - `/@fs/C:/Users/admin/Documents/PromptCut/.worktrees/c6-3-impl/out/docservice/content/card-source.ndjson`（以及加 `?raw`）
  - `/out/docservice/content/card-source.ndjson?import`
  - 改大小写的 `/OUT/DocService/...`、`/@fs/.../OUT/docservice/...`
  - `/out/docservice/projects/live-1790272145851.ndjson`
  - 经舞台端口 `http://127.0.0.1:5491/out/docservice/...`

  `/out/docservice/projects/`（目录）回 200，但内容和随便一个不存在路径一样是 SPA 的 `index.html`，不含文件名。对照：`/package.json` 200；`/api/docservice/healthz` 仍是 JSON。
- **无头实例实测**（`PROMPTCUT_HEADLESS=1`，5490）：启动日志里 `[docservice]` 0 行；`/api/docservice/healthz` 不再是 JSON，落到 SPA 回退的 HTML；`ws://127.0.0.1:5490/docservice` 3 秒内连不上。

### 新发现：没人接的 WebSocket 升级被客户端重置时，dev server 会整个退出（已有问题，不是本次引入）

无头实例实测时 dev server 崩了：`Error: read ECONNRESET … Unhandled 'error' event`，退出码 1。复现脚本（scratch `upgrade-rst.mjs` + `upgrade-rst-driver.mjs`）向 5490 发一个升级请求，1 秒后 RST，再看服务器还在不在：

| 情形 | RST 前的回复 | RST 之后 |
|---|---|---|
| 无头 `/docservice` | 无 | 服务器没了（`ECONNREFUSED`） |
| 正常模式 `/foo` | 无 | 服务器没了（`ECONNREFUSED`） |
| 正常模式 `/docservice` | `101 Switching Protocols` | 服务器仍在（HTTP 200） |

（驱动脚本里「vite process alive: true」一栏不准：它用 `execFileSync` 阻塞了事件循环，读不到子进程退出；以 `ECONNREFUSED` 为准。）

原因：vite 的 HMR 在 `httpServer` 上挂着 `upgrade` 监听，对不是自己的路径直接 return，既不回包也不给 socket 挂 `error` 监听；Node 把升级交给监听者后不再兜底，对端一 RST 就是未处理的 `error`，进程退出。正常模式下任何非 HMR、非 `/docservice` 的路径都能这样打崩编辑器；C6.3 之前 `/docservice` 本身也是这样。按契约第 4 节，挂载模式「别的路径一概不碰」，所以文档服务不该替别的路径兜底，我没改。

它对 M5b 有直接影响：页面接入后，在无头实例里打开的页面会去连 `/docservice`，没人接、握手挂住；页面一刷新或关闭，无头实例就退出。建议另立一项：在插件（或一个独立的小插件）里给**所有**升级的 socket 先挂一个空的 `error` 监听；另外无头实例里 `/docservice` 明确回 404 或 503，别让握手挂着。这要改插件行为和无头实例的路由，需要主会话定。

## 第三轮：崩溃修复（契约第 10 节第 14 条，第 6 条改写）

提交 `922b56a`：
- `vite.config.ts` 改回「总是注册」`docservicePlugin()`，停用逻辑放进插件。
- **停用模式**（`PROMPTCUT_HEADLESS === "1"`）：不建文档服务、不写日志；`/docservice` 的升级用 `ws.mjs` 的 `rejectUpgrade` 回 `503 Service Unavailable` 并关 socket；`GET /api/docservice/healthz` 回 `503 { ok: false, disabled: true, reason: 'headless' }`。
- **所有升级 socket 挂错误监听**：两种模式都在 `httpServer` 上 `prependListener('upgrade', …)`，对每个升级 socket 挂一次空的 `error` 监听（WeakSet 去重），不回包、不关 socket。注释写明为什么前后都安全：`error` 只会在 `upgrade` 同步分发完之后发生。

复现脚本（scratch `upgrade-rst-driver.mjs`：每种情形起一台 5490 dev server，发升级请求，1 秒后客户端 RST，再看进程和 HTTP）：

| 情形 | 修复前（`aded4d5`，把修复暂存掉后跑） | 修复后（`922b56a`） |
|---|---|---|
| 无头 `/docservice` | 无回复；RST 后进程退出，`read ECONNRESET` | healthz `503 {"ok":false,"disabled":true,"reason":"headless"}`；升级 **1 ms 内**收到 `503 Service Unavailable`，服务端关掉 socket；进程在，`/package.json` 200 |
| 正常 `/foo` | 无回复；RST 后进程退出，`read ECONNRESET`，HMR 也连不上 | 无回复（照旧不碰）；RST 后进程在，`/package.json` 200；HMR `vite-hmr` → `{"type":"connected"}` |
| 正常 `/docservice` | 101，进程在 | 101，进程在；HMR `{"type":"connected"}` |

脚本最后一行：修复前 `SOME DIED`，修复后 `ALL ALIVE`。

另在正常模式重跑 `c63-plugin-live.mjs`：healthz 的 `modules` 四个齐全，`promptcut.v1`，`project.rev` 的 `actor.userId` 是 `local`，HMR `connected`，页面 200，`LIVE OK`；日志文件经 HTTP 仍是 403。

- `npx tsc -b --force` → 退出码 0。
- `npm test` → 退出码 0，`tests 2309 / pass 2308 / fail 0 / skipped 1`（同上，5190 那条）。

## 契约疑点与按最保守读法做的决定

1. **`listen()` 抛错的方式**：做成同步 `throw`（契约写「抛错」）。测试若用 `assert.rejects` 会不过，只能二选一。
2. **回包与广播的顺序**：`project.announced` / `content.stored` 先回，`project.rev` / `content.changed` 后发（按契约表格「回包」在「其它效果」之前的顺序）。
3. **挂载模式下的 `service.server`**：返回宿主服务器（本服务不监听、不关它）；另加 `attached: boolean`。`health()` 两种模式都有。
4. **`content.watch` 的语义**：以最后一条为准（替换，不累加），与 `service.watch`、`queue.watch` 的先例一致。`kinds` 去重后原样回显，空数组合法（等于全部退订）。
5. **内容库的 `actor`**：契约没写形状，照项目版本模块取 `{ userId, session }`；`content.put` 接受可选 `session`（规则同项目：1～128 个字符，不合法回 `bad-message`）。不带时 `session: null`。
6. **`session: null`**：项目与内容都当作没给，不回 `bad-message`（契约的 `session ?? null`）。
7. **两个新模块不加 `health()` 字段**：契约没要求，也避免与现有字段名冲突；诊断走 `describe()`（项目：各项目的 rev/digest/at；内容：各 kind 的键数、watch 连接数）。
8. **Windows 文件名不分大小写**：`projectId` 允许大小写，只差大小写的两个项目会落进同一个文件。文件名照契约第 10 节的统一编码（大小写原样保留），由模块回放时按记录里的 `projectId` / `kind` 过滤，结果仍正确（主会话已认可）。
9. **半行的处理**：读时丢弃并记日志，不截断文件；下一次追加前补换行。坏行会一直留在文件里、每次回放都记一条 `store.bad-line`。

## 需要主 Agent 决定或越界未做的

第 1～3 条已按契约第 10 节在第二轮修掉，保留原文备查；第 4、5 条和上面「新发现」仍待定。

1. **无头实例共用日志目录**：`scripts/headless.mjs` 起的无头实例也用 `vite.config.ts`，项目根相同，会和用户那份编辑器同时挂一份本地文档服务、往同一个 `out/docservice` 追加，两边各自在内存里发号，`projectRev` 会冲突。契约只说「预渲染进程不挂」。建议：无头实例（`PROMPTCUT_HEADLESS=1`）不挂，或用单独目录。需要改插件的行为，我没自行决定。
2. **日志文件能被 vite 静态服务取到**：`vite.config.ts` 的 `fsDeny` 不含 `out/docservice`，`GET /out/docservice/content/card-source.ndjson` 会原样返回（同一文件头注释说过 `out/cookies` 的先例）。`npm run dev` 绑 `0.0.0.0` 时局域网设备能读到卡片源码和项目摘要。建议在 `fsDeny` 里加 `**/out/docservice/**`；本任务 `vite.config.ts` 只许注册插件，没改。
3. **`main.mjs` 的缺省数据目录**：在仓库里直接跑 `node server/docservice/main.mjs` 并写入后，会在仓库根生成 `data/`，它不在 `.gitignore` 里。建议加上，或在 `ecosystem.config.cjs` 显式传 `PROMPTCUT_DOCSERVICE_DATA`。都不在本任务的文件清单里。
4. **`auth.reject` 日志里的 `remote`**：`auth.mjs` 记的是 socket 的对端，经舞台端口代理进来的连接记成 `127.0.0.1`，不是 `clientAddressOf` 的真实对端。只影响日志，`auth.mjs` 不在清单里。
5. **远端重新部署**（契约第 9 节末条）不在本任务范围，没做。
