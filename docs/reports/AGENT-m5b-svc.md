# M5b 文档服务侧（m5b-svc）报告

分支 `claude/rq-m5b-svc`（从 `claude/rq-m5b` 的 5c4635f 起），worktree `.worktrees/rq-m5b-svc`。
依据：`docs/plan/render-queue-contract.md` J.1、J.2、J.3（`endpoint.mjs`、`index.mjs` 两条）、J.8 svc 行；
`docservice-contract.md`（C6.3，含第 10 节）；`render-queue-contract.md` G.7、G.11；`manifest-contract.md` 第 2 节。

## 1. 做了什么

只动了 J.8 svc 行的五个文件，外加本报告。

| 文件 | 改动 |
|---|---|
| `server/docservice/store/index.mjs` | 文件存储与内存存储都加 `writeBlob(name, text)`、`readBlob(name) → string \| null`。文件存储先写同目录临时文件、`fsync`，再改名盖过目标；Windows 上改名遇到 `EPERM` / `EBUSY` / `EACCES` 时短暂重试最多 5 次；出错删掉临时文件 |
| `server/docservice/modules/project.mjs` | 加 `project.snapshot.put` / `project.snapshot.get`；另导出 `SNAPSHOT_LIMITS`、`SNAPSHOT_PACE`、`snapshotBlobName`、`splitSnapshotText`；`describe()` 多一个 `snapshots` 计数对象。原有的 open、announce、close 行为不变 |
| `server/render-node/project-client.mjs`（新） | `createProjectClient(endpoint, { timeoutMs = 30_000 })`，提供 `announce`、`putSnapshot`、`get`、`pending`，另导出 `PROJECT_CLIENT_DEFAULTS` |
| `server/render-node/endpoint.mjs` | `resolveDocservice` 加编辑器那一项，顺序是环境变量地址 → 编辑器 → 回环 8787 → 离线；新增 `mode: 'editor'` |
| `server/render-node/index.mjs` | 加出 `createProjectClient`、`PROJECT_CLIENT_DEFAULTS` |

### 1.1 快照：服务端（J.1）

- **上传**：
  - 校验：`projectId`、`digest` 的规则照 C6.3；`projectRev` 是正整数；`count` 是 1～64；`0 ≤ index < count`；`data` 是字符串且 UTF-8 字节数不超过 512 KiB。不过就回 `bad-message`。
  - 版本号没 announce 过，回 `unknown-rev`。
  - 消息里的 `digest` 与这一版登记的摘要不同，回 `digest-mismatch`，已收的分片丢弃。
  - 分片按 `(projectId, projectRev)` 汇在一起，可以乱序、重传、来自不同连接。
  - 收齐后算 `sha256(全文)`：不符回 `digest-mismatch` 并丢掉分片；相符就 `writeBlob('projects/<fileNameOf(projectId)>@<rev>.json', 全文)`，回 `stored { complete: true }`。
- **取回**：
  - 版本没登记过、文件不存在、文件内容的 sha256 与这一版登记的摘要不同，这三种都回 `part { missing: true }`。
  - 否则按每片 ≤ 256 KiB（JSON 转义后）重新切片，依次发 `part`，最后发 `end { digest }`，每条都带 `reqId`。
- **存储不支持**：存储没有 `writeBlob` / `readBlob` 时，快照消息回 `unsupported`。

### 1.2 客户端（J.2）

请求配对、超时、断线的写法照 `content-client.mjs`：
- `reqId` 的形式是 `project#<实例号>-<n>`；
- 回 `error` 时拒绝，错误带 `reason`，`code` 与它相同；
- 超时回 `code: 'timeout'`；
- 发不出去或连接断开时，在途请求立即以 `code: 'disconnected'` 失败。

与 `content-client` 不同的地方：
- `putSnapshot` 按「JSON 转义后 ≤ 512 KiB」切片，逐片等 `stored`；最后一片的回包不是 `complete: true` 时报 `incomplete`；切出来超过 64 片报 `too-large`。
- `get` 逐片核对 `index` 连续、`count` 一致，不对报 `bad-reply`；拼好后核对 `end.digest`，不符报 `digest-mismatch`；解析失败报 `bad-json`；`missing` 回 `null`。
- `get` 的超时是两条回包之间的间隔，每收到一片重新计时（见第 4 节第 6 条）。

### 1.3 编辑器里挂的文档服务（J.3）

- `PROMPTCUT_EDITOR_URL` 只取源站，路径忽略：
  - `http:` 推出 `ws://<源>/docservice`，`https:` 推出 `wss://<源>/docservice`；
  - 探活用 `GET <源>/api/docservice/healthz`，要求 `ok === true`、`protocol === 'promptcut.v1'`；
  - 可用时返回 `mode: 'editor'`。
- 没设或设为空串就不试，`tried` 里也不出现。不是 http(s) 的地址记 `bad-url`，继续试下一项。
- 没设 `PROMPTCUT_EDITOR_URL` 时行为与原来逐字相同，所以既有 T6 不受影响。

## 2. 验证

### 2.1 基线

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误 |
| 全量测试 | `npm test`（第二次） | 退出码 0；tests 2394，pass 2393，fail 0，skipped 1（`集成:/api/cards/layout 对真实项目返回整数框`，需要 5190 的那条） |

**第一次全量测试**：
- 结果：退出码 1，fail 1。
- 失败用例：`docservice-content.test.mjs` 的 N7，报错是 `连接失败：ws://127.0.0.1:3659/?user=alice … close=1006`，发生在测试夹具 `fake-docservice-env.mjs` 建连的时候，还没走到存储和内容模块的逻辑。
- 复查：单独跑这个文件 5 次，全过；第二次全量跑全绿。
- 同类现象：并行跑 `docservice-*` 时，`docservice-endpoints.test.mjs` 的两条 E8 也出现过一次，也是 WebSocket 握手阶段的 `连接失败`；单独跑 6 次全过。
- 判断：并行负载下的偶发握手失败，与本分支的改动无关，但没有在基线分支上复现过。建议主 Agent 合并后留意；如果再出现，另立一项查测试夹具。

### 2.2 自测（scratch 脚本，不提交）

**脚本与命令**：
- 脚本在 scratchpad：`selftest.mjs`（快照与端点解析）、`burst.mjs`（出站背压实验）。
- 命令：`node selftest.mjs <scratchpad>`，退出码 0，`合计 PASS 35，FAIL 0`。

**环境**：真文档服务，端口 0，文件存储放在临时目录；客户端是 `createWsEndpoint` 加 `createProjectClient`。

**项目内容**：项目 JSON 里有中文、引号、反斜杠和 emoji。

结果：

```
PASS announce 发号 {"projectRev":1,"changed":true}
  put 1361004 字节（1.30 MiB）用了 37 ms
PASS 落盘文件名按 C6.3 编码 …/ds-data/projects/proj%3Ademo@1.json
PASS 落盘内容逐字节相同
PASS 目录里没有残留临时文件 ["proj%3Ademo.ndjson","proj%3Ademo@1.json"]
  get 用了 922 ms
PASS get 解析后与原 JSON 相同
PASS 原始协议：分片按 index 升序、end 最后、都带 reqId parts=5
PASS 原始协议：拼起来逐字节相同、end.digest 正确
PASS 乱序、重传：received 1,2,2,3，最后 complete [["p0",1,false],["p1",2,false],["p2",2,false],["p3",3,true]]
PASS 乱序上传后取回相同
PASS 摘要与登记的不符 → digest-mismatch
PASS 内容与摘要不符（收齐后校验）→ digest-mismatch
PASS 摘要不符后已收分片丢弃 [["q0","project.snapshot.stored",1],["q1","error","digest-mismatch"],["q2","project.snapshot.stored",1]]
PASS 没 announce 过的版本 → unknown-rev
PASS 没见过的项目 → unknown-rev
PASS 登记过但没上传快照的版本 → null
PASS 不存在的版本 → null
PASS 原始协议：missing 回包形状 {"type":"project.snapshot.part","projectId":"proj:none","projectRev":1,"missing":true,"reqId":"m1"}
PASS 并发两份取回不串
PASS 重启后仍能取回（1.3 MiB 那份）
PASS 重启后仍能取回（乱序上传那份）
PASS 重启后不存在的版本仍是 null
PASS 重启后版本号接着往上加 {"projectRev":5,"changed":true}
PASS 断线：在途请求 code disconnected
PASS 较大快照（5.4 MiB）取回相同
PASS 超时：code timeout
PASS 没连上：code disconnected
PASS 没有背压断开 []
  限速 16 MiB/s 取回 5.4 MiB：same 5467ms；backpressure 日志 0 条
  限速 2 MiB/s 取回 5.4 MiB：same 5488ms；backpressure 日志 0 条
  限速 1.2 MiB/s 取回 5.4 MiB：same 5589ms；backpressure 日志 0 条
  限速 0.5 MiB/s 取回 5.4 MiB：err disconnected 3988ms；backpressure 日志 1 条
PASS 编辑器健康检查通 → mode editor、url ws://<源>/docservice
PASS 顺序：环境变量地址在编辑器之前 → remote
PASS 顺序：环境变量地址不通 → editor（在回环之前） [{"url":"ws://127.0.0.1:14622","ok":false,"reason":"unreachable"},{"url":"ws://127.0.0.1:14619/docservice","ok":true}]
PASS 编辑器不通 → local
PASS 编辑器协议不符 → protocol-mismatch、offline
PASS 编辑器地址不是 http(s) → bad-url，继续
PASS 编辑器地址空串视为没设
PASS https 编辑器 → wss://<源>/docservice，探活 https://<源>/api/docservice/healthz
合计 PASS 35，FAIL 0
```

编辑器那一项用的是假 http 服务：它只在 `/api/docservice/healthz` 回 `{ ok: true, protocol: 'promptcut.v1' }`。自测确认它确实被请求到了。

**限速一行的做法**：用一个 TCP 代理，把服务端到客户端方向的吞吐限到给定速率，看取回会不会被核心以 1013 断开。第 4 节第 1 条要用到这组数据。

**背压实验**（`burst.mjs`，默认参数，本机回环）：一个模块在一条请求里同步连发 N 条 512 KiB 的消息。

| 发法 | N = 2 | N = 3 | N = 8 |
|---|---|---|---|
| 同步连发 | 正常 | 正常 | 被 1013 断开，收到 3 条 |
| 每条之间让一次事件循环 | 正常 | 正常 | 正常 |

所以快照取回不能一次同步发完。

## 3. 没做成的

没有。J.7 的测试文件归 `claude/rq-m5b-tests`，本分支没有写。

## 4. 契约疑点与更正建议

按最保守读法实现，下列各条请主 Agent 裁定。

1. **取回快照会撞上核心的出站上限（H.2）**。这是最重要的一条。
   - **问题**：一次同步发出超过约 1 MiB 的回包，积压超过 `maxPendingBytes`（1 MiB），核心会以 1013 断开整条连接（第 2.2 节的背压实验）。节点的这条连接同时承载队列会话，断开就会丢租约。
   - **原因**：模块拿不到积压字节数，`ctx` 里只有 `send`、`now`、`log`、`subscribe`、`unsubscribe`、`publish`。
   - **现在的做法**，都在 `project.mjs` 里：
     - 发回的分片每片不超过 256 KiB；
     - 同一条连接上的多次取回排队依次发；
     - 核心提供了 `ctx.pendingBytes(connId)` 的话，就等积压降到一片以下再发（现在的核心没有这个接口，代码里按特性检测）；
     - 没有的话，按「开头窗口 512 KiB + 每秒 1 MiB」估算节奏。
   - **代价**：
     - 本机回环上取 1.3 MiB 要约 0.9 s，取 5.4 MiB 要约 5.5 s；
     - 链路吞吐低于约 1 MiB/s 时仍会被断开：限速 0.5 MiB/s 时复现到了。
   - **建议**：在 `router.mjs` 的模块 `ctx` 上加 `pendingBytes(connId)`。它不在本分支的文件清单里，所以我没动。加上之后本模块自动改用它，速率估算只作兜底。W4 的笔记本如果走慢速 Wi-Fi，这一条会直接影响结果。
2. **「每片 ≤ 512 KiB」的口径**：
   - 服务端按原文的 UTF-8 字节数核对。
   - 客户端按 JSON 转义后的字节数切：满是引号的文本转义后能涨到约 2 倍，按原文切的话，整条消息可能超过文档服务 1 MiB 的单条上限。
   - 代价：转义多的文档，64 片能装下的总量小于 32 MiB。
3. **取回时的分片方式与上传时不同**：取回按 256 KiB 重新切，`count` 是服务端这次的片数，与上传时的 `count` 无关。契约没有要求两者相同。
4. **快照文件名的编码**：
   - 契约写的是 `projects/<编码后的 projectId>@<projectRev>.json`，`@` 原样保留。所以 `writeBlob` / `readBlob` 的名字由调用方先编码（模块用存储层导出的 `fileNameOf`），存储层不再编码，只核对名字只含 `[A-Za-z0-9._@%-]`、不全是点、不越出目录。
   - 如果存储层也照 stream 的规则编码，`@` 会变成 `%40`，与契约字面不符。
5. **只差大小写的项目 id**：在 Windows 上，它们的同一版快照会落进同一个文件，后写的盖掉先写的。取回时先核对 sha256 与这一版登记的摘要，对不上就回 `missing`，不会发出别的项目的内容；代价是被盖掉的那个项目取不到快照。
6. **客户端超时**：取回快照的回包是一串，所以 `timeoutMs` 按「两条回包之间」算，每收到一片就重新计时，不是整次取回的总时长。否则大快照配上第 1 条的节奏，30 s 可能不够。
7. **摘要校验提前**：消息里的 `digest` 与登记的不同，第一片就回 `digest-mismatch`，不等收齐。收齐后另外还校验 `sha256(全文)`。
8. **同一版换了切法重传**：`count` 与之前收到的不同时，丢掉旧分片，按新的 `count` 从头收，不报错。
9. **未收齐的上传**：放在内存里，最多 32 份，闲置 10 分钟丢弃，超过份数时丢最旧的；重启后全部丢失。之后客户端最后一片的回包就不是 `complete: true`，客户端报 `incomplete`。
10. **`get` 一个没登记过的版本**：回 `missing`，不回 `unknown-rev`。契约只给 `get` 定义了 `missing`。
11. **`mode: 'editor'` 是新的取值**：J.5 的接线方写的是「不是 `offline` 时开队列模式」，照写就能用上它。只列举 `remote` / `local` 的调用方要补上这一项。
12. **`describe()`**：多了一个 `snapshots` 对象（`snapshotsStored`、`snapshotsServed`、`digestMismatches`、`uploadsEvicted`、`pendingUploads`），`/healthz` 不变，照 C6.3 第 10 节第 5 条。

## 5. 提交

在 5c4635f 之后，按时间顺序：

| 提交 | 内容 |
|---|---|
| e244fc4 | 报告开工 |
| 9a42a3d | 存储：`writeBlob` / `readBlob` |
| e703739 | 项目模块：快照上传与取回 |
| 607caae | `project-client`、`endpoint`、`index` |
| ab70846 | 取回节奏降到每秒 1 MiB |

之后还有一个提交，只改本报告。
