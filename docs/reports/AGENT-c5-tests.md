# AGENT-c5-tests 报告

角色：C5 测试方（分支 `claude/c5-tests`，从 `claude/c5` 拉出）。依据：`claude/c5` 上的 `docs/plan/asset-store-contract.md` 第 2～6 节。
对抗式分工：没看 `claude/c5-impl` 和 `.worktrees/c5-impl`。读过的现有代码：`server/asset-service.ts`、`server/test/asset-service.test.mjs`、`server/vite-plugin-media.ts`（`serveFile`、`resolveHashFile`、`parseRange`）、M5a 的 `server/docservice/`、`server/render-node/ws-transport.mjs`、`server/test/fake-ws-kit.mjs`。

## 做了什么

| 文件 | 内容 |
|---|---|
| `server/test/blob-store-conformance.test.mjs` | K1～K14 对 fs、memory 各跑一遍，K15 跑一次，K16 只对 fs（两条），共 31 条 |
| `server/test/asset-store-http.test.mjs` | H1～H6，共 6 条 |
| `server/test/asset-announce.test.mjs` | N1、N2（两条）、N3、N4，共 5 条 |
| `scripts/probes/asset-lan-probe.mjs` | W2 探针，只用 Node 内置 |

没新增假件：N2、N3 的假端点写在测试文件里。没改任何生产代码，没有标 skip。

写法上的几点：
- 三个测试文件都用动态 `import` 载入被测模块，载不进来时每条用例各自失败、报同一个原因，不会整文件只报一条。
- `asset-store-http.test.mjs` 转译 `asset-service.ts` 时，把源码里**所有相对路径的 import**（静态、动态）改成绝对地址：`.ts` 递归转译，`.mjs` 直接指向仓库文件。实现方新加 `./asset-store/index.mjs` 之类的引用不用在测试里逐条登记。
- 令牌一律 `crypto.randomBytes(32).toString('base64url')` 现场生成；服务一律端口 0。
- H4 模拟局域网来源的办法：在测试服务器里把 `req.socket.remoteAddress` 改掉，不真的绑到局域网网卡上（避免 Windows 防火墙弹窗）。

## 每条编号测什么、当前结果

当前分支上实现还没进来，**42 条全部失败，都是预期内的原因**。

### `blob-store-conformance.test.mjs`（31 条，当前 0 过 31 败）

当前失败原因都一样：`载不进 server/asset-store/index.mjs：Cannot find module`。

| 编号 | 测什么 |
|---|---|
| K1 | 没见过的哈希：`chunks` 全等于 `{ size: null, chunkSize, received: [], complete: false }`；`stat`、`read`（含带区间）为 `null`；`complete` 为 `unknown`；`remove` 为 `false` |
| K2 | `putChunk` 回 `{ status: 'ok', bytes }`；同一片重传结果完全相同；`source` 用可读流、异步可迭代两种都能收；收尾后字节正确 |
| K3 | 报不同 size → `{ status: 'size-mismatch', size: <已登记> }`，`chunks` 不变；原 size 照常能收完 |
| K4 | 最后一片少一字节、多一字节 → `{ status: 'length', expected, got }`；**已收到的一片重传时长度不对，会变回没收到**（契约「先撤掉标记」）；第 0 片超长时**不写坏第 1 片**（收尾后字节正确） |
| K5 | `n = count`、`n` 远超 → `{ status: 'out-of-range', count }`，已收的不动；小于一片的素材 `count` 为 1 |
| K6 | 4 片里收 0、2 → `{ status: 'incomplete', missing: [1, 3] }`，已收的不动；再补 3 → `missing: [1]` |
| K7 | 篡改一个字节 → `{ status: 'hash-mismatch', actual: <实际哈希> }`；之后 `chunks` 回到没见过的形状、`stat` / `read` 为 `null`、`complete` 为 `unknown`；从头重传可入库 |
| K8 | 3 片到齐 → `{ status: 'ok', size, ext }`；`chunks` 全片、`complete: true`；`stat` 的 size、ext、contentType、mtimeMs（memory 必须是入库时刻）；`read` 全件、空选项、7 组闭区间（含跨片边界、单字节、末字节）、只给 `start` |
| K9 | 入库后 `putChunk` → `{ status: 'complete' }`，且 source 被读完；size 不同、长度不对的分片也回 `complete`；再 `complete` → `ok`；字节、ext 不变 |
| K10 | 4 片乱序并发写（source 分小块交错）→ 每片 `ok`，`complete` 结果与顺序写的另一个 store 相同，stat 一致；同一片并发写两次也不坏 |
| K11 | 入库后 `remove` → `true`，之后 `stat` / `read` 为 `null`、`chunks` 为未知、`complete` 为 `unknown`，再 `remove` 为 `false`；只有暂存的哈希也能删；删后可重新上传；fs 下文件与暂存目录确实删了 |
| K12 | `usage` 在登记、入库、hash-mismatch 丢弃、重复上传、`remove` 各步之后的 `{ blobs, bytes, staging }` |
| K13 | 先空、再 mp4、再 webm、再 png → 收尾 ext 是 mp4，contentType 是 video/mp4；从头到尾没给就是 `''` |
| K14 | 大写哈希写、小写哈希查（反之亦然）是同一个；6 种不合法哈希对 6 个方法都抛 `TypeError`（同步抛或返回被拒的 Promise 都算） |
| K15 | `oss` 抛 `code === 'not-implemented'`；`s3`、空串、缺 kind 抛 `TypeError`；`BLOB_CHUNK_SIZE` 是 8 MiB；memory 缺省 chunkSize 是 8 MiB，给了就用给的 |
| K16（布局） | fs 的 chunkSize 是 8 MiB；暂存在 `.chunks/<小写哈希>/`，里面有 `meta.json`（内容 `{ size, ext }`）、`data`、`1.ok`，没收到的片没有标记；入库后 `<dir>/<hash>.mp4` 字节正确、暂存目录没了；`onStored` 收到 hash、file（按文件名比较）、ext、size、contentType（取自 `hooks.contentTypeForExt`）；无扩展名入库为 `<dir>/<hash>` |
| K16（老导入） | 直接放在 `<dir>/<hash>.wav` 的文件经 `hooks.resolveFile` 算已入库：`stat`、`chunks`（complete）、`putChunk` 回 `complete` 且不建暂存、`complete` 回 `ok`、`read` 区间 |

### `asset-store-http.test.mjs`（6 条，当前 0 过 6 败）

| 编号 | 测什么 | 当前失败原因 |
|---|---|---|
| H1 | 缺省 fs 与注入 memory（8 MiB）两台服务跑同一个 40 步剧本：预检（局域网 / 公网来源）、对账、分片上传、中途断线、缺片收尾、补传、入库后重传、GET 全件与大写哈希、5 种 Range（含跨片、416）、HEAD（含带 Range）、hash-mismatch 与丢弃、各种 4xx 校验、405、X-Media-Type 反查。逐步比较状态码、11 个响应头、有无 Last-Modified、回包体（JSON 全等，二进制比长度和 sha256）。另外按第 5 步契约核对十几处关键回包，免得两边一起错 | 载不进 `server/asset-store/index.mjs` |
| H2 | 源码里没有 `from "fs"`、`from "fs/promises"`、`from "node:fs"`、`createReadStream`、`createWriteStream`，也没有换引号、动态 import、require 的 fs 引用；没有 `.chunks` 目录名（`store.chunks(` 方法调用除外，见疑点 2） | 现在的源码里有 `from "fs"` |
| H3 | `isTrusted: () => false` 加令牌：不带令牌、7 种错令牌（别的令牌、多一字符、少一字符、不带 Bearer、Basic、空 Bearer、放在别的头里）对 PUT 和 POST complete 都回 401 `{ ok: false, error: 'unauthorized' }` 且带跨源头；被拒的写不登记 size；令牌对照常；GET、HEAD、Range、chunks、OPTIONS 不要令牌；入库后的幂等 PUT / complete 也要令牌；比一片大的未授权写不落进存储 | 载不进数据层 |
| H4 | `token: null` + 非本机：各种 Authorization 都 401；`isTrusted` 为真照常；缺省 `isTrusted` 按 `remoteAddress` 判（`127.0.0.1`、`127.8.9.10`、`::1`、`::ffff:127.0.0.1` 放行，`192.168.1.50`、`10.0.0.7`、`::ffff:192.168.1.50`、`fe80::1`、`8.8.8.8` 拒）；缺省 token 在创建中间件时读一次 `PROMPTCUT_CLUSTER_TOKEN`，之后改环境变量不影响 | 载不进数据层 |
| H5 | `ASSET_ALLOW_HEADERS` 含 Authorization 且原有五项还在；`/api/asset` 的 PUT、complete、chunks 和 `/@media` 的预检都回 Authorization；`assetPreflightMiddleware` 也回 | 常量里还没有 Authorization |
| H6 | 3 轮 × 11 种请求（被拒、通过、入库后、越界、size 不一致、带令牌的读），抓 console 各级别和 stdout / stderr、每个回包的状态码 + 全部响应头 + 回包体，都不含令牌原文 | 载不进数据层 |

### `asset-announce.test.mjs`（5 条，当前 0 过 5 败）

当前失败原因都一样：`载不进 server/asset-announce.mjs`。

| 编号 | 测什么 |
|---|---|
| N1 | 注入的网卡表：只取非 internal 的 `10/8`、`172.16/12`、`192.168/16` IPv4；排除回环、IPv6（含 fd00::）、`8.8.8.8`、`172.32.*`、`172.15.*`、`169.254.*`、`100.64.*`、`11.*`、`192.169.*`、internal 的私有地址；去重；按字典序（`10.0.0.10` 在 `10.0.0.9` 前）；`basePath` 可改；没 port 返回 `[]`；网卡表里值为 `undefined` 的项跳过；缺省读本机网卡表时结果格式正确、已排序去重 |
| N2（一） | 用假端点：`createEndpoint` 收到 `url`、`token`；连上前不算发；每次 onOpen 发一次 `{ type: 'service.announce', announcerId, kind: 'asset', urls }`，重连再发；收到 `error` 打日志、不重发；其它消息不引起重发 |
| N2（二） | `announcerId` 缺省是 `asset@${os.hostname()}`；`url` 为 `''`、`undefined`、`null` 时不建端点，返回的 `stop()` 可调 |
| N3 | `urls` 为空：不登记，至少打一行 log；连着时 `stop()` 的事件顺序正好是 announce → withdraw → close，withdraw 带 announcerId、`kind: 'asset'`；断着时 `stop()` 发不出 withdraw、照样 close |
| N4 | 真文档服务（端口 0，`endpointsModule`，集群令牌模式）+ 缺省 `createWsEndpoint` + **缺省 announcerId**：订阅方收到一条 kind asset、urls 相符的推送；后来的订阅方在 watch 回包里看到；`stop()` 后订阅方收到空表、登记方连接关掉；登记方日志里没有令牌 |

### 探针 `scripts/probes/asset-lan-probe.mjs`

- `node --check` 通过。
- 不带参数：打印用法，**退出码 2**。
- `--docservice ws://127.0.0.1:5471`（没有服务）：输出一行 JSON，`fails: [{ step: 'connect', detail: '连不上控制面 …' }]`，退出码 2。
- `--asset …` 但没设令牌：退出码 2，说明「没有令牌」。
- 步骤名：`generate`、`put-without-token-401`、`put-0-1-received`、`put-rest-complete`、`cors-get`、`range-206`、`download-sha256`，对应契约的 7 条断言。断言失败的步骤记进 `fails` 后继续跑后面的；连不上直接停，退出码 2。输出前再擦一遍令牌。

## 验证

| 项 | 命令 | 结果 |
|---|---|---|
| 语法 | `node --check` 四个新文件 | 全部通过 |
| 新测试（本分支） | `node --test server/test/<文件>` 逐个跑 | K 31 败、H 6 败、N 5 败，退出码都是 1；原因见上表，全是实现还没合进来 |
| 全量测试 | `npm test` | 第二次：2289 条，过 2246，败 42（正好是新增的 42 条），跳过 1，退出码 1。第一次多败一条 `render-node-ws.test.mjs` 的 T6（`protocol-mismatch` 实得 `unreachable`），单跑 3 次都过，第二次全量也过，是既有的偶发失败，与本分支无关（见风险 6） |
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误 |

### 参考实现自检（没提交，目录已删）

在 worktree 里临时建 `.ref/`（复制 `server/` 和探针），按契约写了一份最小参考实现：`server/asset-store/index.mjs`（fs、memory）、`server/asset-announce.mjs`、改过的 `server/asset-service.ts`（只经数据层、写入鉴权、Authorization 预检）。结果：

- `blob-store-conformance`：31/31 过。
- `asset-store-http`：6/6 过（H2 起初因 `store.chunks(` 误判失败，改了测试，见疑点 2）。
- `asset-announce`：N1～N3 过；**N4 失败**，文档服务回 `bad-message`。把参考实现的缺省 announcerId 换成 `asset:<hostname>` 后 N4 过、N2（二）败。原因见疑点 1。
- 探针：参考素材服务（`isTrusted` 恒假、带令牌，端口 5473）+ 文档服务（5474）+ 登记两个地址（先一个不通的 5479，再 5473）：
  - `--docservice`，20 MB：退出码 0，7 步全过，`source: 'docservice'`，跳过了不通的地址；
  - `--asset`，3 MB：退出码 0；
  - 令牌错：退出码 1，`fails` 里列出 401 和之后的 404；
  - 三次输出里都没有令牌原文。
- 现有 `asset-service.test.mjs` 对参考实现失败：它的 `compile(...)` 替换表里没有 `./asset-store/index.mjs` 这一行。契约允许实现方加这一行，属预期（疑点 3）。
- `.ref/` 已用 `Remove-Item -Recurse` 删掉，`git status` 干净。

## 契约疑点（需要主 Agent 定）

1. **缺省 announcerId 被控制面拒收（最要紧）。** 第 5 节写缺省 `asset@${os.hostname()}`，但 M5a 的 `server/docservice/modules/endpoints.mjs` 要求 announcerId 匹配 `^[A-Za-z0-9._:-]{1,128}$`，不认 `@`，登记回 `error: bad-message`。实现照抄契约的话，编辑器接线用缺省值登记会一直失败，而 `startAssetAnnounce` 收到 error 只打日志，W2 会在现场才暴露。现在 N2（二）断言契约写的字面值，N4 用缺省值走真服务，两条在现契约下不可能同时过。建议把缺省改成 `asset:${hostname}`（或 `asset.${hostname}`），并说明 hostname 里有正则外的字符时怎么处理；改完后 N2（二）的期望值要跟着改（只改一行）。
2. **H2 的 `.chunks` 与方法名撞了。** 第 3 节说源码不许出现 `.chunks`，但第 2 节的方法就叫 `chunks`，`store.chunks(hash)` 天然含这个子串。测试改为按行找 `.chunks` 且后面不是 `(`，即只拦目录名。建议契约写成「不许出现 `.chunks` 目录名（`store.chunks()` 调用除外）」。
3. **`asset-service.test.mjs` 替换表要加行。** 实现方一旦在 `asset-service.ts` 里静态 import `./asset-store/index.mjs`，现有测试的 `compile` 替换表必须加 `['from "./asset-store/index.mjs"', <绝对地址>]` 一行，否则转译产物在临时目录里找不到它。契约第 1 节允许这么做，这里只是提醒验收时核对「只加了行、断言没改」。
4. **`onStored` 的 `file` 是文件名还是全路径没写。** 现在 `writeMediaIndex` 要的是文件名（`<hash>.<ext>`）。K16 按 `path.basename` 比较，两种都放过。建议契约写明是文件名。
5. **几处测得比契约字面更严，依据是「照现在 `asset-service.ts` 的行为」：**
   - K7：hash-mismatch 之后哈希完全回到没见过（`size: null`，`complete` 回 `unknown`）。契约只写了 `received: []`，但同时写了「丢弃这个哈希的全部暂存」，现有 HTTP 测试也断言 404。
   - K4：超长的一片不能写进下一片的位置（现有代码注释「超长的部分不写」）。
   - K9：入库后 `putChunk` 要把 source 读完（契约写「请求体读完丢掉」）。
   - H3：入库后的幂等 PUT / complete 同样要令牌（第 4 节按路由管，没有例外）。
   - 要放宽哪一条告诉我。
6. **鉴权与长度检查谁先，契约没写。** H3 的「比一片大的未授权写」接受 400 或 401 或断连，只要求不落盘。建议写明鉴权最先做（不让未授权方探到校验细节）。
7. **Bearer 是否区分大小写没写。** 测试只用 `Bearer <令牌>`，`bearer` 小写没测。
8. **N1「按地址字典序」按字面理解为字符串序**（`10.0.0.10` 排在 `10.0.0.9` 前）。如果本意是按数值排，改 N1 的期望顺序。
9. **N1 网卡表里的 `undefined` 值**：Node 的类型是 `NodeJS.Dict`，值可能为 `undefined`，测试要求跳过。
10. **探针取地址**：契约写「第一个登记里第一个能通的地址」，探针是按登记顺序把所有登记的所有地址依次试，取第一个通的。只有一个登记时两者一样。另外探针第 2 步（不带令牌回 401）要求探针所在机器相对素材服务不是回环；在编辑器本机上跑，缺省 `isTrusted` 放行，第 2 步必失败。这符合 W2「在笔记本上跑」的设定，但值得在任务书里写一句。

## 契约没覆盖到的风险

1. **`discarded` 没有用例。** 写入过程中暂存被丢弃（`remove` 或并发收尾）→ `putChunk` 回 `discarded`、HTTP 409 `staging-discarded`，第 6 节没列，也不好稳定复现。`remove` 与正在写的分片并发时两种实现怎么表现，没有测。
2. **fs 的 `usage` 在真的媒体目录里会不会把索引文件算成 blob。** 真目录里除了 `<hash>.<ext>` 还有媒体索引文件（`writeMediaIndex` 写的），可能还有老导入的其它文件。K12 用的是干净的临时目录，覆盖不到这一点。
3. **memory 实现的大小上限。** HTTP 层允许 `X-Media-Size` 到 64 GiB；memory 实现若按 size 预分配 Buffer，一个请求就能把进程打挂。memory 只在测试里用，但契约没写「只供测试」。
4. **`mediaPlugin()` 的接线**（绑定地址不是回环、设了 `PROMPTCUT_DOCSERVICE_URL` 才登记、关闭时 stop、出错不影响启动）第 6 节没有单测，只能靠 G0-R 和 W2 间接验证。
5. **登记失败是静默的。** `startAssetAnnounce` 收到 `error` 只打日志、不重试，疑点 1 这类问题上线后只能从日志发现。可以考虑让探针或编辑器诊断页显示登记状态。
6. **既有偶发失败**：`render-node-ws.test.mjs` 的 T6 在全量并行跑时偶尔把 `protocol-mismatch` 报成 `unreachable`（第一次全量出现一次，单跑 3/3 过，第二次全量过）。本分支新增的 fs 用例一次要写上百 MB 临时文件，全量时的 I/O 负载会比以前高，可能让它更容易出现。建议另立一项看 T6。

## 提交

- `743e0de` 测试:建 C5 测试方报告
- `42b0d28` 测试:BlobStore 一致性用例 K1～K16(fs、memory 各跑一遍)
- `8491f98` 测试:素材服务 HTTP 层接数据层与写入鉴权用例 H1～H6
- `684fff1` 测试:素材服务地址登记用例 N1～N4
- `85e2489` 探针:局域网素材服务端到端 asset-lan-probe(W2;地址由控制面下发,只用 Node 内置)
- `a50e8df` 测试:H2 不把 store.chunks() 当目录名;N4 走缺省 announcerId,没收到登记时报出登记方日志
- 本报告的最终版另提交一次。

## 第二轮：按契约第 8 节改测试（2026-09-25）

先 `git merge claude/c5` 拉进第 8 节（合并提交 `8854b7a`），再照改：

| 改动 | 用例 |
|---|---|
| 缺省 announcerId 改为 `asset:${os.hostname()}`；假端点用例里写死的 id 也换成 `asset:…` | N2（二）期望值；N4 断言推送里的 announcerId 等于缺省值 |
| 守门只拦字符串里的目录名：`'.chunks'`、`".chunks"`、`` `.chunks` ``、路径片段 `/.chunks`、`\.chunks`；`store.chunks(` 不算。正则另用 8 个样例核过（方法调用 3 例不拦，目录名 5 例全拦） | H2 |
| `onStored` 的 `file` 断言收紧为等于 `<hash>.mp4` | K16（布局） |
| 先鉴权：未授权写一律 401，新增长度不对、越界、分片号前导零、缺 size 四种未授权写都要 401；比一片大的未授权写只接受 401 或断连 | H3 |
| scheme `bearer`、`BEARER` 放行；令牌改一个字母大小写 → 401 | H3 |
| 排序按 URL 字符串字典序，维持原样 | N1 |
| 新增：memory 遇 size = 256 MiB + 1、64 GiB → `size-mismatch`，不登记、usage 为零；正常大小照常 | K17（只测 memory） |
| 新增：fs 目录里放 `index.json`（媒体索引形状）、`notes.txt`、63 位哈希的文件、64 位哈希名的目录，usage 不变 | K18（只测 fs） |

用例总数 42 → 44（K 33 条、H 6 条、N 5 条）。

当前结果（本分支，实现未合入）：
- `blob-store-conformance`：33 条全败，退出码 1，原因都是载不进 `server/asset-store/index.mjs`。
- `asset-store-http`：6 条全败，退出码 1。H2 败在源码里有 `from "fs"`，H5 败在 `ASSET_ALLOW_HEADERS` 没有 Authorization，其余 4 条载不进数据层。
- `asset-announce`：5 条全败，退出码 1，原因都是载不进 `server/asset-announce.mjs`。
- 三个文件 `node --check` 都通过。参考实现上一轮已删，这一轮没有重跑自检。
