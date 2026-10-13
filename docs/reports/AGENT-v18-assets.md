# 块六：素材隔离（不含轨道流）

分支 `claude/v18-assets`，从 `main` `b4464f2f` 分出，2026-10-13。端口只用了 28060～28069 与 28090（探针和新单测）；跑全量测试时别的测试文件照旧用它们写死的端口。没连节点，没碰 ChatGPT 的分支和工作区，没动语义文档。

几个词：

- **素材协议表**：`docs/plan/three-versions-018-design.md`「素材协议」那张表，一行是一类读写入口。
- **账号模式**：托管组合带 `PROMPTCUT_ACCOUNT_V2=1` 起的那种，素材服务是独立进程，每个项目一个物理库。不带这个变量起的是旧模式（全局库，按哈希读），下文叫**旧模式**。
- **运行素材**：云端 Agent 的一条任务凭「这条任务的授权」读写它所在项目的素材，不借成员的票据。ChatGPT 的报告里叫 run-assets。
- **根登记**：节点上由 root 写的一组文件，证明「现在活着的素材服务进程是哪一个」，文档服务据此才认运行素材的连接。

## 1. 摸底时的一处判断要更正

`AGENT-018-prep.md` 第 1 节写「`main` 上按项目取库只在带了可信上下文时走，别的入口还是全局库」，读起来像成员这条路还没隔离。实际读代码、跑测试的结论是：**账号模式下，成员读写素材的各个入口在 `main` 上已经按项目隔离，撤销关流也已经有**（`server/asset-store/project-{stores,access,revocations,io}.mjs`、`server/hosted/asset-runtime.mjs`，以及 `asset-project-*.test.mjs` 五个文件、`asset-wiring-integration.test.mjs`）。「全局库」那条分支只在没给项目库时走，是局域网和本机项目用的，设计明写这两种不改。

所以这一块真正缺的是三样：一支走真实组合的探针；几个没人点过的入口的单测；运行素材那条线的去留和现状。下面按这三样写。

## 2. 做了什么

| 提交 | 内容 |
|---|---|
| `046d96a5` | 建报告 |
| `53654dae` | 合并 `codex/018-run-assets-current-v2`（20 个提交，运行素材的文档服务一侧：选素材、私有元数据、关闭见证、根登记两版的读端、观察通道绑定，及 14 个测试文件） |
| `faf30ad3` | 独立素材入口的暂存清单 `server/hosted/files.mjs` 补 5 个文件（见 2.1） |
| `0b76f57b` | `scripts/probes/asset-account-isolation-probe.mjs` |
| `f0f90830` | `server/test/asset-project-entries.test.mjs` |
| 最后一个提交 | 本文 |

### 2.1 合并 `codex/018-run-assets-current-v2`〔裁 1〕

整条合进来，没有挑着搬。理由：它的 28 个新文件互相引用，拆开搬等于重写；合进来以后不开开关就不生效（文档服务一侧要 `PROMPTCUT_DOC_RUN_ASSETS_ENABLED=1`，素材服务一侧要 `PROMPTCUT_ASSET_RUN_ENABLED=1`，两处都还要求是 Linux 且根登记文件齐全，否则启动报配置错或内部口回 503）。

- **冲突 1 个**，`server/hosted/doc-agent-assembly.mjs` 末尾的返回对象：`main` 这四天加了「已读控制」（`readControl`、`readControlsHandler`），分支加了运行素材的挂载（`mountRunAssets`、`runAssetsHandler`）。取并集：`main` 的行为一个不少，运行素材的处理函数排在最前面但没挂载时是 `undefined`、直接跳过。没有拿不准的地方。
- **合并后发现并修了一处**：独立素材进程是从一份文件清单拼出来的暂存目录里起的。合并后清单缺 5 个文件：`server/account/agent-read-control.mjs`（`main` 后来加的依赖）和分支自己漏列的 4 个（`run-assets-current-registry.mjs`、`run-assets-current-registry-v2.mjs`、`asset-root-registry-schema-v2.mjs`、`run-assets-observer-binding.mjs`）。不补的话素材服务在节点上起不来。`cloud-run-assets-central-stage.test.mjs` 首跑就是败在这里，补完通过。
- **不开开关时和 `main` 的两处差别**（都只在配了 Agent 且配了素材服务内部口时出现）：素材服务的内部口多了 `/internal/v2/asset/run/` 一组只读元数据接口（只认文档服务的证书）；文档服务多建一个到它的客户端。成员读写素材的路径没变。

### 2.2 `codex/018-cloud-assets-central-glue` 不用〔裁 2〕

逐文件比过：它改过的 41 个文件里，代码和测试共 36 个，其中 22 个和本分支现在一字不差，12 个是本分支文件历史里的旧版本，剩下 2 个（`asset-runtime.mjs`、`doc-assembly.mjs`）是同一处的更早写法（少了运行素材的消费者和根登记）。本分支没有的只有 5 份 ChatGPT 的报告。结论：它的成果已经全在 `current-v2` 里，不合。**这条分支可以清**（报告要不要留由主会话定）。

### 2.3 探针

`scripts/probes/asset-account-isolation-probe.mjs`，文件头有用法。起的是本机隔离的真实组合：VisuHive 的账号后端模块、文档服务托管组合（账号模式）、独立进程的素材服务，服务之间走临时证书的双向 TLS。三个账号：甲建项目一，乙建项目二，丙凭链接加入项目一。

验的入口（每个入口都是：同一个哈希只在项目一时乙读不到；甲和丙照常）：

| 入口 | 验了什么 |
|---|---|
| `/api/asset/<media\|snap\|px>/<hash>` | GET、HEAD、Range、`chunks`、`complete`、查询串票据；甲传了一片没收尾的，乙看不到、收不了尾 |
| `/@media/<hash>`、`/@media/<hash>.<ext>`、`/@media/<hash>/pcm` | 读；PCM 真的解出样本 |
| `/api/media/local`、`tiers`、`tiers/backfill` | 乙问不出项目一有没有 |
| `/api/media/upload-queue`、`…/enqueue`、`…/target` | 乙排不进项目一的哈希；不能把上传目标设成甲的票据 |
| `/api/media/remote`、`prefetch`、`originals` | 乙不能把拉取来源设成甲的票据；预取后仍读不到 |
| `/api/media/file?path=`、`adopt?path=` | 点名项目一的磁盘路径、项目目录外的路径都被拒 |
| `/api/media/upload/<名>` | 丙（成员）整件上传进项目一，甲读得到、乙读不到 |
| `/api/shots/thumb/<名>` | 镜头缩略图 |
| `/stream/<键>/manifest\|init\|seg` | 素材服务自己的流读口（`server/asset-store/stream-store.mjs`，不是 `server/frame-stream.mjs`） |
| 没有票据、自报账号和项目的请求头、带 cookie、查询串里换项目、内部口 | 一律拒 |

然后乙自己上传同样的字节，各读各的，磁盘上是两份。

撤销两种：

- **甲踢掉丙**：丙在 `/api/asset` 三个命名空间和 `/@media` 上各有一条读到一半停住的 40 MB 的流。踢人后，客户端还停着没读，素材服务就把四条流关掉并向文档服务回执（回执要等流真的关掉才发）；丙接着读也读不完；丙的 13 种新请求全被拒、开不出新会话；甲和乙同时在读的流接着读完整件。
- **乙的登录被退出**：乙在读的流被关，文档服务收到的回执里 `closedStreams` 为 1；旧票据的新请求被拒；乙重新登录后读自己项目的照常，仍读不到项目一独有的。

### 2.4 单测

`server/test/asset-project-entries.test.mjs`，3 条，补 `asset-project-http.test.mjs` 没点到的：小尺寸补转、上传队列三个口、预取、原尺寸检查、带扩展名的旧读口；半截分片；`/api/asset` 三命名空间加 `/@media` 四条在读的流在撤销后被关、另一个项目同哈希的流读完整件。用的是注入的权威夹具，端口 28090。

## 3. 验证结果

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误 |
| 探针 | `node scripts/probes/asset-account-isolation-probe.mjs --base-port 28060 --out <临时目录>` | 退出码 0，158 项全过。关键行：`踢人事件：素材服务在客户端仍停着时就关完流并回执 {"kickSeq":4,"cursor":4}`；`踢人后丙正在读的 /api/asset/media 已被服务端掐断 {"complete":false,"bytes":589824}`（另三条同）；`踢人不影响甲正在读的流：接着读完整件 {"complete":true,"bytes":41943040}`；`退出登录：…回执 {"complete":true,"closedStreams":1}`。踢人到关完流并回执 52 毫秒（只记录）。跑前跑后查过，没有新冒出来的可见窗口，28060～28099 没有残留监听 |
| 合并进来的与原有的素材测试（定向） | `npm test -- server/test/cloud-run-assets-*.test.mjs asset-root-registry-schema-v2 run-assets-* asset-run-* run-asset-transport-* account-v2-install-plan asset-project-*` | 首跑 140 条里 138 过、1 败、1 跳过：败的是 2.1 说的暂存清单；修后那一条连同 `asset-entry-stage`、`asset-wiring-integration`、`account-v2-install-plan` 重跑 11/11 |
| 新单测 | `npm test -- server/test/asset-project-entries.test.mjs server/test/windows-hide-silent-spawn.test.mjs` | 首跑 3 条里 1 败（我自己的断言写错：夹具对「查询串票据去写」回 403，我写成了 401），改断言后 7/7 |
| 全量测试 | `npm test`（设了那两个环境变量） | 见第 3.1 节 |

探针前三次没过，都是探针客户端自己的毛病，不是服务端的：集群令牌夹具里有个非法字符；客户端「停住不读」时看不到对面已经关了连接，改成恢复读取后看有没有读完；每收到一块又把自己暂停了一次，以及给自己设的 60 秒空闲超时把不该关的流关了。

### 3.1 全量测试

在最后一个代码提交上跑了一遍：退出码 0，`✓ npm test 最终结果：零失败`。5939 条，5936 过，0 败，0 取消，3 跳过，用时约 76 秒，一次过，没有触发文件级重跑。跳过的 3 条是测试自己按平台跳的（例如「恢复遍历遇 symlink 明确拒绝」写明在 Windows 上不请求符号链接权限），不是这次引入的。比 `main` 多出来的条数来自合并进来的 14 个测试文件和新加的 3 条。

## 4. 对上摸底报告第 2 节的验收行

| 行 | 内容 | 结论 |
|---|---|---|
| 2.3 第 4 行（`cloud-agent-task.md` 完成条件 4，隔离验收，核心项）里素材那一条 | 跨项目拿不到素材；伪造或过期的身份被拒 | **成员这条路：通过**（探针 158 项，本机隔离的托管组合）。**云端 Agent 自己读素材那条路：未跑**，生产入口关着（第 5 节），现有证据只有夹具级测试（`asset-run-mtls`、`run-assets-observer`、`run-assets-authority`，这次重跑通过）。节点上的 S3-r4（越权探测卡读不到）未跑，部署后做 |
| 2.1 第 2 行 | 被踢全设备拒绝 | 素材服务这一侧**通过**：踢人后旧票据的 13 种请求全拒、在读的流被关。其它服务不在本块 |
| 2.1 第 5 行 | 设备退出，全部服务确认 | 素材服务这一侧**通过**：退出登录后素材服务关流并向文档服务回执，回执查得到。整条确认链是块二的 |
| 2.1 第 13 行 | 内部核对口与凭证，未授权均拒，不能只靠回环地址 | 素材服务这一侧**通过**：回环上没有票据照样 401；内部口不在公开端口上；自报请求头不算数。`asset-wiring-integration` 另验了不带客户端证书连文档服务内部口握手失败（重跑通过）。其它服务不在本块 |
| 2.1 第 18 行 | 真实网络环境验收 | **未跑**，部署后做 |

## 5. 没做成的与原因

### 5.1 运行素材的生产登记和传输：没接齐，这一块接不了

合并以后的现状：文档服务和素材服务两侧的代码都在，夹具级测试都过，生产入口缺省关。要让云端 Agent 的任务真的经它读写项目素材，还差五处：

1. **Agent 服务一侧没有调用方**。`server/agent-service/run-asset-transport.mjs`（`createRunAssetTransport`）、`server/agent/service/run-asset-client.mjs`、`project-assets.mjs`（`createProjectAssets`）在生产代码里没有任何地方构造它们，工具拿不到「项目素材」这个对象。接线点在 `server/agent-service/account-executor-assembly.mjs` 一带，那是块一（独立任务进程）正在改的文件，我不能动。
2. **根登记的第二版没挂**。文档服务组合里挂的是第一版的检查点（`createRunAssetCheckpoint`）；第二版（`createRunAssetCurrentRegistryV2`）只有模块和测试，`combo.mjs`、`main.mjs`、`asset-main.mjs` 都没传 `rootProtocol: 'v2'`。ChatGPT 自己的报告写第一版在真实 Linux 上有一次失败记录（ENODEV），不能算通过。
3. **部署清单里没有它**。`server/hosted/deploy/account-v2-install-plan.mjs` 不生成运行素材要的环境变量、根登记目录，也不调用 root 发布器（`asset-root-registry-publisher.mjs`）。
4. **异常停机的衔接没定**。素材服务原有的「上一个实例确实停了」的证明文件（`asset-lifecycle.mjs`）和根登记的见证是两套，怎么对上 ChatGPT 留给主会话裁定，还没裁。
5. **Linux 上的整条链没跑过**：初始化、root 发布、文档服务接受、绑定连接、换代后旧连接被拒新连接通过、重启后仍在。

为什么这一块做不了：第 2、3、5 条的读端在非 Linux 上直接拒绝（要核文件属主是 root、cgroup、进程出生时刻），本机验不了，而通用规矩不许连节点；第 1 条的文件归块一。建议排在块一合入之后、和块十一（和渲染有关的工具与隔离）或工具包的素材那一包一起做，在节点自己的临时目录里验。

### 5.2 留给渲染重构之后的入口

| 入口 | 素材协议表里的要求 | 现状 |
|---|---|---|
| `server/frame-stream.mjs` | 轨道流的衍生键含项目、URL 与下载在服务层核项目 | 没碰。`asset-project-workers.test.mjs` 里已有一条按项目的测试，这次重跑通过；渲染重构后复核 |
| `server/hosted-render/worker.mjs` | 渲染工作进程的素材键、缓存、代理绑定项目 | 没碰 |
| `server/hosted-render/look.mjs`、`server/agent-service/look-client.mjs`、`render-publisher.mjs` | 看画面请求的项目由已验证的服务和任务授权取，请求体换不了 | 只读过：`look-client` 的项目号来自鉴权，不来自工具参数；这三个文件不过素材字节。托管渲染服务还看不到账号项目（摸底报告「五项之外」第 2 条），现在起不来一条能验的链，和工作进程一起留到块十一 |

### 5.3 看到但没改的一处：舞台凭 cookie 读素材认不得账号模式的票据

素材协议表最后一行（`/media-s/` 舞台委托）。`src/online/stagePolicy.mjs` 第 32 行和 `server/hosted/deploy/nginx-site-promptcut-stages.conf` 第 17 行只认 `v1.<…>.<…>` 形状的票据；账号模式发的素材票据是 43 个字符、不带点（`server/docservice/account-hosted.mjs` 第 93 行）。照代码读，账号项目里编辑器页把票据交给舞台换 cookie 这一步会被判成形状不对（400），舞台退回旧办法取素材，卡片执行隔离判为没开（`stageIsolation.ts` 第 182 行的 `grant-failed`）。

这不是跨项目泄漏（票据本身绑着项目，素材服务照样按项目核），是舞台隔离在账号模式下可能整个没生效。没改的原因：改法是把两处的票据形状放宽，但 `src/online/` 在渲染那一带的边上，改完要在线浏览器加真 nginx 才验得出来；我这里只有读代码的结论，没有运行证据。

## 6. 我做的裁定

- 〔裁 1〕`codex/018-run-assets-current-v2` 整条合并，冲突取并集（2.1）。
- 〔裁 2〕`codex/018-cloud-assets-central-glue` 不合（2.2）。
- 〔裁 3〕新单测用固定端口 28090（我这一段里的），没有改夹具去支持随机端口。合入 `main` 后它和别的写死端口的测试一样，两个工作区同时跑全量会撞。
- 〔裁 4〕探针里「流被关」的判据：服务端回执先到（客户端还停着），再让客户端接着读、确认读不完。没有用「客户端停着时看到连接关闭」，因为停着不读的套接字在这台机器上看不到对面关了。

## 7. 对任务书或语义的更正建议

1. `AGENT-018-prep.md` 第 1 节「素材隔离」那一行的「做到哪」「还差」照本报告第 1 节改：成员路径已隔离，还差的是运行素材的生产接线和渲染那两处。
2. `docs/plan/three-versions-018-design.md`「素材协议」开头写「`storeOf(ns)` 在 admit 之前选全局 store，必须改为…」，这句描述的是 10 月 8 日的代码，现在已经改了，建议标成已做。
3. `docs/semantics/product/asset-service.md`「不能跨项目读」一条没有问题，不用改。建议在 `mechanism/asset-service.md` 补一句机制：账号模式下每个项目一个物理库，同一哈希在两个项目里各存一份，不做跨项目去重（设计里已经这么定，语义里还没有）。这是三级。
4. 合进来的测试把端口写死在 6440～6449（`cloud-run-assets-*-tls`、`-mount`），和 `account-v2-install-plan.test.mjs` 用的是同一段；通用规矩里「偶发失败的测试」名单建议加上这一组。

## 8. 要主会话决定或注意的

1. 5.3 那一处要不要现在查实。建议：块十三（在线探针换账号入口）开工前，先用一支在线探针看账号项目里舞台是不是走了 cookie；是坏的就把两处票据形状放宽，一起验。
2. 节点上素材服务必须是账号模式（`PROMPTCUT_ACCOUNT_V2=1` 且 `PROMPTCUT_ACCOUNT_V2_REQUIRED=1`，`account-v2-config.mjs` 已经这么生成）。用旧的 `deploy-hosted` 那套命令部署会起成旧模式，旧模式下「知道哈希就能读」的口子还在。摸底报告第 8 节第 1 条已经说部署清单这一段要重写，这里补一句后果。
3. `codex/018-cloud-assets-central-glue`、`codex/018-run-assets-current` 两条分支的内容已全在本分支里，可以清；`codex/018-run-assets-current-v2` 等本分支合入 `main` 后可以清。
4. 运行素材（5.1）排到哪一块，和块一的接线点怎么约。
