# AGENT 报告：多项目渲染节点（claude/multi-project-render）

0.7.19 的一项：渲染服务的多项目模式。每个请求只加载它那几帧用到的卡和素材，不让哪个项目占着；取代 0.7.18 的暂行办法「云端 Agent 按轮占用」。

- worktree：`.worktrees/multi-project-render`，分支 `claude/multi-project-render`，从 main `6c571a27` 切。
- 端口段：5880～5889（开发服务器 5880～5882；端到端探针 5880～5889）。
- 语义出处：`docs/semantics/product/rendering.md`「渲染服务的两种模式」（下称「产品那一条」）；`docs/semantics/mechanism/rendering.md`「多项目模式的做法」（下称「机制那一条」）。语义文档一个字没改。

## 状态

做完两轮，等主会话审。第二轮（主会话 2026-10-22 交下来的四件）见下一节。门槛逐条（最终代码上）：

| 门槛 | 结果 |
|---|---|
| 1 类型检查 | `npx tsc -b --force` 零错误 |
| 2 全量测试 | 最终代码上 `npm test`：7461 条，7438 过，8 失败，15 跳过。逐个单跑：其中 7 条所在的 7 个文件单跑全过（时序假失败），剩 1 条是 `account-v2-deploy-config`（路径带 `render` 的假失败，见第二轮第三件）。详见「验证」 |
| 3 画面相同 | 看画面那一路 24/24 帧逐像素相同；**产流那一路 23/23 帧逐像素相同**（第二轮新加）；不同的像素都是 0 |
| 4 队列顺序 | 单测打出实际出队次序；云端排队探针端到端 13/13 过（K=4） |
| 5 隔离 | 单测 MPI1～MPI5；隔离探针端到端 49/49 过（最终代码上） |
| 6 导出像素基线 | 不变（没改导出、舞台、卡片的出图代码；导出确定性 300 帧全同、快照重放一致 PASS） |
| 键（第二轮） | 发布方与节点两条路算的流键 6/6 逐字节相同（真渲染页）；单测 MSK1～MSK6 |
| K（第二轮） | 实测 K=1/2/4/8，定 K=4〔裁〕 |

## 第二轮：主会话 2026-10-22 交下来的四件

### 一、产流也只装用到的部分；键按「这条流展开出的子集」算（主会话定，三级）

先说核查的结果，它决定了改动有多大：

- **单卡流、依赖下层的流的内容键本来就只看这条流**：成员键来自卡片计划里这张卡的内容身份（节点、上游、参数、这张卡自己的代码身份、样式、主题、字体指纹、画幅、采样），与项目里别的片段无关（`card-cache.mjs` 的 `plan`、`card-identity.mjs` 的 `cardSnapshotIdentity`）。整个项目算和子集算本来就逐字节相同——下面的单测 MSK6 与探针 K 都实测确认了，包括真渲染页算出的字体指纹、环境指纹。
- 唯一把**整个项目**带进流的键的地方，是依赖下层的流在「有一层在卡片计划里找不到键」时退回用整个项目的 `entry.key`（`frame-stream.mjs` 的 `belowStreamSpecs`）。
- 把整个项目带进**要求**的地方：切分出的流任务 `requires.cardSources` 要「这一版用到的全部定制卡」（`split.mjs` 的 `allCardSources`），节点得有整个项目的卡才认领得了。
- 把整个项目带进**渲染页**的地方：产流时隔离工程从整个项目建（别的片段作隐藏的源序列留着，`isolatedStreamProject`）。
- 任务书说的 `local` 档 `entry.key`：快照任务从 2026-10-13 起已经停产（`snapshot-tier.mjs` 的 `snapshotTier` 一律回 `'none'`，切分不出快照任务），`local` 档任务现在一个都不会出现。所以没有改它；如果以后恢复快照任务，要按同一套 `subsetFrameKey` 改。

改了什么（发布方与节点用同一套 `render-node/expand.mjs`）：

| 文件 | 改动 |
|---|---|
| `server/render-node/expand.mjs` | 新加 `streamNeed(spec)`：一条流要的是哪一段（回放起点到最后一帧，点名这条流的卡与它下面的层；剪辑段里摊出来的虚拟片段对应到它最外层的剪辑段）。`subsetCardSources(project, need, versions)`：子集里用到的定制卡的代码身份。`multiProjectNode(env)`：`PROMPTCUT_NODE_PROFILE=host`（独立渲染主机、托管方渲染服务的工作进程）就是多项目模式 |
| `server/frame-stream.mjs` | 产流：多项目模式下隔离工程从这条流展开出的子集建（`StreamProducer#isolatedOf`，三个调用点都换了），单项目模式照旧整个项目。依赖下层的流退回整场景时的键改成按子集算（`entry.subsetKey(streamNeed(...))`），没有 `subsetKey` 的旧 entry 照旧用 `entry.key`。`queueStreamOf` 多带 `mountFrame`，切分方据此算出与节点同一个 `need` |
| `server/frame-pipeline.mjs` | 新加 `subsetFrameKey(project, need)`：子集的整场景键，与 `entry()` 同一个算法（素材戳已经在 `entry.project` 上，同步算）；`entry.subsetKey` 挂在每个 entry 上。切分上下文多给 `streamCardSources(stream)` |
| `server/render-node/split.mjs` | 切分方自己那一份流任务的 `requires.cardSources` 只要这条流子集里用到的那几份（`streamSources`）；没给 `streamCardSources` 的旧调用方照旧要全部。导出位图任务照旧要全部（它的形状里没有回放起点，算出的子集与节点的不保证相同，要求取超集不会错） |

证据：

- 单测 `server/test/multi-project-stream-keys.test.mjs` 6/6：MSK1 展开确定（同样的项目、同样的帧算 6 次逐字节相同；在更大的子集上再展开一次结果相同、键相同）；MSK2 切分方拿到的流形状与节点手里的完整的流算出同一个 `need`、同一份代码要求（逐字节）；MSK3 毛玻璃那条流只要 `odometer, caption-track, user-a`，不要这一段以外的 `user-late`，任务 id 与结果键不变；MSK4 退回整场景时发布方（整个项目）与节点（只有子集）算出的内容键、流键逐字节相同，这一段以外的改动不再让它作废、以内的照旧作废；**MSK5 旧键对不上只会重算、不会取错**：旧口径的流键与新键不同（流库里是另一个目录），执行器拿旧键的任务来对，这一版的流里没有它，回 `plan-mismatch`、不产也不当成新键的结果用，换成新键的同一个任务才走到产流；MSK6 单卡流整个项目与子集算出的键逐字节相同。
- 探针 `scripts/probes/multi-project-stream-probe.mjs`（新加，开发服务器 5880，真渲染页）：退出码 0，`{"ok":true,"streams":6,"keysSame":6,"frames":23,"identical":23,"diffPixels":0}`。
  - K（键一致）：6 条流（单卡流 4 条：lottie、punch-pill、particles、mu-number-ticker；依赖下层的流 2 条：blur-text、odometer）。发布方按整个项目算计划，节点只拿这条流的子集（片段 11 个降到 5～10 个）去算计划，**内容键、流键 6/6 逐字节相同**；
  - P（画面一致）：同一条流的隔离工程从整个项目建一遍、从子集建一遍，渲回放起点、第一帧、中间、最后一帧：**23/23 帧逐像素相同，不同的像素 0**。看过的图：`stream-below-c-blur-multi-000090.png`（毛玻璃叠在视频上）、`stream-card-c-particles-multi-000180.png`（粒子卡单独、透明底），拷在 `docs/archive/agent-reports/assets/multi-project-render/`。
  - 跑了两次（改完与最终代码上各一次），两次都全过。
- 缓存失效的代价：只有「依赖下层的流退回整场景」这一种流的键会变，等于这种流作废一次；单卡流、依赖下层的流（按层出键的）的键一个字没变，已有的结果照用。

还没做到的（交主会话）：节点**算计划**那一步仍按「项目@版本」把整份项目交给渲染页（`prerender-executor.mjs` → `planForQueue`），只是**产流**那一步只装子集。原因：计划的结果（entry）按版本缓存、同一版的各个任务共用，层表（`publishLayerMap`）也按它写；改成每个任务按自己的子集算计划，层表会被只含一条流的子集互相覆盖。探针 K 已经证明按子集算计划得到的键逐字节相同，所以改它在键上是安全的，要解决的是 entry 与层表的归属——建议另开一项。另外，隔离工作进程的卡片同步照旧把这个项目的全部定制卡装进来（只是同一个项目的，跨项目的隔离不受影响）；现在流任务的要求已经按子集写了，下一步可以只同步任务要的那几份。

### 二、吞吐：一轮最多连做 K 个，K 按实测定

做法：隔离工作进程上，一个项目一轮最多连做 K 个它自己的请求（看画面：那一轮开始时就已经排着的、先来的 K 个；产流：那一轮开始时排着的任务里最多 K 个），再让给别的项目；项目之间照旧轮流，看画面照旧先于产流，后来的请求不插进这一轮。`look.mjs` 的 `turnRequests`、`isolation.mjs` 的 `TURN_TASKS`，管理进程的环境变量 `PROMPTCUT_RENDER_TURN` 一起改。单测：MPI5（K=2：甲甲 乙乙 甲，装了三次，K=1 要装五次）、HR23-K（产流 K=2：A×2 → B×2 → C×1（它只排着一个）→ A×2）。

实测：`scripts/probes/multi-project-turn-bench.mjs`（新加；本机隔离的托管组合 + 真的渲染服务，两个都带用户卡的项目，甲先登记 6 个看画面请求、乙紧接着登记 6 个）。第二次（干净的一次）结果：

| K | 总用时 | 装了几次 | 一次换装（上一轮结束 → 下一轮就绪），中位 | 渲一帧，中位 | 乙的第一个等了 | 最长等 | 平均等 |
|---|---|---|---|---|---|---|---|
| 1 | 179.7 s | 12 | 8.2 s | 3.2 s | 30.1 s | 179.3 s | 94.8 s |
| 2 | 102.8 s | 6 | 8.1 s | 3.5 s | 37.5 s | 101.9 s | 61.7 s |
| 4 | 72.0 s | 4 | 8.2 s | 1.0 s | 33.2 s | 71.1 s | 37.7 s |
| 8 | 40.1 s | 2 | 8.7 s | 0.9 s | 35.0 s | 39.1 s | 27.2 s |

读法：一次换装本身 8～9 秒（清空数据目录、起 Vite 与 Chrome、连文档服务、同步卡），加上换装后第一帧要冷启动渲染页（K=1、2 时渲一帧的中位 3.2～3.5 秒，K≥4 时 1 秒左右——多出来的就是冷页），一次换装实际吃掉约 14 秒（K=1 比 K=8 多装 10 次、多用 140 秒）。「另一个项目要等多久」= 前面那个项目这一轮还剩几个 × 一帧 + 一次换装：乙的第一个在几种 K 下都是 30～37 秒，大头是甲的第一次冷装，K 只多加几个热渲（这里每个约 1 秒）。

定 **K=4**〔裁，三级〕：换装开销摊到 4 个请求上（每个请求摊约 3.5 秒，与一帧的热渲同一量级），而另一个项目最多多等 3 个热渲加一次换装。K=8 在这次的两项目突发里总用时更短，但另一个项目最坏要多等 7 个请求；真实项目的卡比测试卡重（一帧最长可到 3 分钟上限），7 个请求可能就是好几分钟，所以不取 8。第一次跑 K=1 时乙的一轮工作进程起来以后自己退了，乙排着的 4 个请求被一次结掉——查出是一个原有的问题：隔离工作进程没起成的重试次数被出图的 `retries`（生产是 0）顶掉了，`isoRetries: 3` 从来没生效。已改成按 `isoRetries` 算（`look.mjs`），第二次跑全部出图。两次的原始数字都存了（`turn-bench-lines.txt`、`turn-bench-first-run-lines.txt`）。

改完 K 之后的端到端复验：云端排队探针（缺省 K=4）13/13 过，出图次序 乙-1 → 乙-2 → 甲-2 → 甲-3，看画面这一段只装了 乙、甲 两次（K=1 时是四次）；隔离探针 49/49 过。探针的断言按 K 算出该有的次序（`--turn` 可改）。

另两条路各要动多少、风险在哪：

- **多开 N 个隔离槽**（同时装 N 个项目）：每个槽是一整棵工作进程树（两台 Vite + Chrome），本机实测一棵 1.2～2.2 GB（隔离探针日志里的 `isoRss`）；节点的内存硬上限 6 GB、常驻工作进程另占约 1.9 GB，所以 N=2 是上限且吃紧（本机这几天内存紧时已经频繁背压）。要动：`isolation.mjs` 的状态机改成槽数组（每槽一个当前项目、按最久没用的换），`main.mjs` 每槽一组端口（+3）、一把口令、一个数据目录与进程树文件，`broker.mjs` 的工作进程表、`look.mjs` 按项目找槽，内存看护按槽算受害者。约 300 行、中等风险，主要风险是内存超限与端口规划。
- **按页面而不是按进程隔离**（一棵常驻工作进程，每个请求一个只属于这个项目的浏览器上下文）：能把换装的 8～14 秒基本去掉。但用户卡现在是同步进工作进程数据目录的改动层、由 `src/cards/user/index.ts` 的 `import.meta.glob` 整目录装进页面，同一棵进程同时有两个项目的卡就要：改动层按项目分目录、模块地址带项目前缀（Vite 的转换缓存按路径，不分就可能把甲的模块交给乙）、页面按项目只装自己那一份（动 `src/cards` 的注册方式）、页面请求闸按项目放行模块与素材、Node 一侧的同步文件预检对所有项目的卡在同一个进程里跑。影响 `card-sync.mjs`、`vite-plugin-cards.ts`、`src/cards/user/index.ts`、页面闸、导出页，跨到 `src/`，风险高：Node 一侧的转换与插件成了各项目共用的面，一处漏洞就是跨项目。建议先用 K（已做）与必要时 N=2，按页面隔离要单独评审。

### 三、`account-v2-deploy-config` 那条失败：测试太脆（记一笔）

`server/test/account-v2-deploy-config.test.mjs`「v2 deploy config registers an optional service only when its distinct identity is enabled」断言整份部署配置的序列化结果里不出现字符串 `render`（意思是「没登记渲染服务」）。但结果里带着 `accountOrderModuleFile` 等文件的**绝对路径**，路径里出现 `render` 也会命中。本 worktree 的目录名 `multi-project-render` 就带这个字，所以在这里必失败；main 的代码导出到同一处跑也一样失败。它把「路径里出现某个字」和「配置里登记了某个服务」混在一起判了：任何路径含 `render` 的工作区（包括别的 worktree、装在带这个字的目录下的机器）都会假失败。合进 `C:\Users\admin\Documents\PromptCut` 就不会中。本分支没有改它。

### 四、素材隔离：非账号模式下能按哈希读到别的项目的素材（原有缺陷，本分支没修）

**是什么**：在本机隔离的托管组合里用**自由模式的共享项目**（`server/auth/client.mjs` 的 `createSharedProject`，不是账号项目）建两个项目甲、乙。乙的成员凭乙的 `rw` 素材票据往素材服务写一块（`POST /api/asset/media/…`，探针里是 `createAssetClient(...).put('media', …)`），拿到哈希 H。然后甲的成员向文档服务要一张甲的只读素材票据（`auth.ticket { kind: 'asset', access: 'r' }`），直接 `GET http://127.0.0.1:<素材端口>/api/asset/media/<H>`，带 `Authorization: Bearer <甲的票据>`：**回 200，内容就是乙的那一块**。隔离工作进程里甲的渲染页经 `/@media/<H>` 去取，同样 200（工作进程拿甲的票据向素材服务转取）。复现：`node scripts/probes/hosted-render-isolation-probe.mjs --base-port 5880 --doc-port 5888 --asset-port 5889 --time-scale 3`，结果 JSON 里 `memberCanReadOtherProjectBlobByHash: true`、`residual[0].routes` 里 `other.asset.media-route=200 … <F7-YI-ASSET>`（存在 `isolation-probe-result.json`）。

**和语义冲突**：`product/asset-service.md` 第 19 行（2026-10-08 用户定）：持有别的项目的票据、知道哈希也读不到，素材服务按项目核对归属。

**影响范围**：
- 只在**非账号模式**（局域网、本机、自由模式的共享项目）。机制 `mechanism/asset-service.md` 第 10 行：账号模式下每个项目一个物理库（`<数据目录>/projects/<项目号的 SHA-256>/`），成员读写哪个库由可信接线按票据里的项目选定，乙的哈希不在甲的库里，读回「没有」；同一行写着「局域网和本机项目仍用全局库」——全局库只按哈希找，不看是谁的。账号模式下读不到的单测在 `server/test/asset-project-workers.test.mjs`（A 的 `rw` 票据读 B 的流与块回 404/403）。
- 前提是知道哈希：内容按哈希寻址，不知道哈希无从读起。

**原有还是本次引入**：原有。`auth-contract.md` 第 192 行的〔裁〕写明「持某个项目的有效票据，就能读这台服务上任何已知哈希的内容……按项目分库留到 OSS 之后」；隔离探针 2026-10-07（`5fc5f474`）起就把它记成「残余面」第 1 条、不算失败。2026-10-08 用户定「不能跨项目读」之后，账号模式做了分库，非账号模式留着全局库，于是与产品那一条冲突至今。本分支没碰素材服务（`git diff 6c571a27 -- server/asset-service.ts server/asset-store` 为空），渲染服务这一侧只向代理口要本项目的票据（MPI2）。按主会话的要求没在这个分支里修。

## 先说一个更正：0.7.18 暂行办法在哪

任务书说暂行办法的实现在 `server/render-node/local-node.mjs`、`session.mjs`、`task-runner.mjs`。核过：这三个文件里没有按轮占用的东西（搜「还在」「占住」「roundId」命中的是别的意思）。暂行办法实际在：

| 位置 | 内容 |
|---|---|
| `server/hosted-render/isolation.mjs` | `acquireTurn` / `releaseTurn` / `cancelTurn` / `unlockProject` / `heartbeat` / `checkHeartbeats` / `markModified`，`lockedProject`、`activeTurns`、`queuedTurns`；`HEARTBEAT_TIMEOUT_MS`（2 分钟）、`STREAM_SLICE_MS`、`IDLE_NO_MODIFY_MS`；`tick` 里的「这一轮放开才让位」「产流让位」「真人在线项目五分钟轮换」「流产满且五分钟没修改才关」，以及更早的「空闲满五分钟才让位」`IDLE_MS`、「连续做满五分钟让一轮」`SLICE_MS` |
| `server/hosted-render/look.mjs` | `routeOnce` 里调 `acquireTurn`；`/look/release`、`/look/heartbeat` 两条；排队异常时 `unlockProject`；撤回时 `cancelTurn` |
| `server/hosted-render/main.mjs` | `isoIdleMs` / `isoSliceMs` 配置，把 `isolation` 交给 `createLook` |
| `server/hosted-render/broker.mjs` | 路由表里的 `/look/release`、`/look/heartbeat` |
| `server/agent/service/account-runner.mjs` | 每 30 秒发心跳、收尾 / 被叫停 / 出错时发「结束了」 |
| `server/agent-service/account-task-worker-config.mjs`、`account-master-assembly.mjs`、`look-client.mjs` | 任务进程 → 主服务 → 渲染服务转这两条 |

## 做了什么

### 找出来的渲染服务相关文件（全清单）

托管方的渲染服务（管理进程与工作进程）：`server/hosted-render/` 下 `main.mjs`（管理进程）、`broker.mjs`（代理口与诊断口）、`isolation.mjs`（隔离工作进程编排）、`look.mjs`（看画面的口子与调度）、`render-requests.mjs`（看画面的持久队列）、`worker.mjs`（工作进程看护、按项目的素材作用域）、`limits.mjs`（背压、内存看护）、`directory.mjs`（目录连接）、`page-gate.mjs` / `vite-gate.mjs` / `source-gate.mjs`（页面请求闸、同步文件预检）、`card-presence.mjs`、`audio-js.mjs`、`selfcheck.mjs`、`deploy.mjs`、`keygen.mjs`；工作进程入口 `scripts/render-host.mjs`。
独立渲染主机与渲染节点：`server/render-node/` 下 `host.mjs`（多项目连接与挑活先后）、`local-node.mjs`、`session.mjs`、`task-runner.mjs`、`pick.mjs`、`filter.mjs`、`split.mjs`、`export-plan.mjs`、`content-client.mjs`、`project-client.mjs`、`session-link.mjs` 等。
出图：`server/prerender-executor.mjs`（队列任务 → 计划与产流）、`server/frame-pipeline.mjs`、`server/frame-stream.mjs`、`server/vision/`（看画面的那几条接口）、`server/bakery/`（导出取帧）。
调用方：`server/agent-service/look-client.mjs`、`server/agent/service/frame-dispatcher.mjs`、`account-runner.mjs`。

### 逐文件

新加：

| 文件 | 内容 |
|---|---|
| `server/render-node/multi-queue.mjs` | 多项目模式的出队次序（纯逻辑）：看画面先于产流；同一类里最久没轮到的项目先、出一个就排到最后；同一项目内按来的先后。`orderByPolicy`、`createRotation`、`createMultiQueue`。三处共用：看画面队列、隔离工作进程装哪个项目、独立渲染主机各项目认领的先后 |
| `server/render-node/expand.mjs` | 机制那一条的「展开」：`expandProject(project, { times/frames/spans, clipIds })` 拼一份只含用到的片段的项目——这些帧上挂着的片段（含挂载提前量，前后各多放一帧，取超集）、素材效果卡的节点与输入片段、转场的两段、剪辑段引用的剪辑里按段换算后同一时刻的片段（任意深度、有环就停）、用到的素材与效果库条目；项目级设置原样、序列一条不删、留下的片段原样（同一个对象）、时间位置不变。`lookNeed` / `expandLookBody`：看画面的各条接口（`see_frames`、`bake_card`、`inspect_card_dom`、`get_layout`、`get_gif`、卡片声音）要的是哪几帧、哪张卡；认不出的原样转发。不引 `src/`（独立入口的接缝规矩），挂载提前量抄一份，测试核对与舞台的相等 |
| `scripts/probes/multi-project-expand-probe.mjs` | 「两种模式出的画面相同」的逐帧证据（见下「验证」） |
| `server/test/multi-project-queue.test.mjs` | 出队次序 MPQ1～MPQ5 |
| `server/test/multi-project-expand.test.mjs` | 展开 MPE1～MPE5 |
| `server/test/multi-project-isolation.test.mjs` | 多项目模式下的隔离 MPI1～MPI3 |

改动：

| 文件 | 改了什么、为什么 |
|---|---|
| `server/hosted-render/isolation.mjs` | 状态机换成多项目模式：装哪个项目只看排队的请求谁排第一（有要隔离的看画面请求就是看画面队列里排第一的那个项目；否则是要产流的项目按「各项目轮流」，一个项目做了一个任务——认领数涨了——就轮到下一个，刚装上的先做完它这一个）；排第一的换成别的项目时**不等它空闲**：清单上标排空，手里那一个做完就结束、清空，下一拍装排第一的；没人排队时装着的留作缓存 `cacheMs`，内存吃紧（背压）时空着就结束。删掉按轮占用的全部状态与方法、心跳、五分钟让位、连续做满五分钟、真人在线优先、流产满且五分钟没修改才关。`isolationCandidates` 的 `looks` 收「按看画面队列出队次序排好的项目」，产流候选不再按成员在线排。检出副本与清目录的函数一字未动。（第二轮：一轮最多连做 K 个，见第二轮第二件） |
| `server/hosted-render/look.mjs` | 排着的请求按多项目模式的次序做（各项目轮流、项目内先来先做），排队位次也按这个次序报；要隔离工作进程出的请求严格按这个次序——排在最前的项目没轮上之前，装着的项目的下一个请求不越过它（不然装着的项目一直有活、一直不空，排在前面的永远装不上）；轮到时按要的帧展开项目再转给工作进程（日志 `look.expanded`）；新加 `isoOrder()` 给管理进程定下一个装谁；删掉对隔离编排的按轮调用；`/look/release`、`/look/heartbeat` 只认身份后回 200 `{ ok: true, ignored: true }`（理由见下节）。（第二轮：一轮最多连做 K 个；隔离工作进程没起成的重试按 `isoRetries` 算） |
| `server/hosted-render/main.mjs` | 隔离编排用 `cacheMs`（沿用环境变量 `PROMPTCUT_RENDER_ISO_IDLE_MS`，探针与验收清单里的写法照旧能用）；删 `isoSliceMs` 与 `PROMPTCUT_RENDER_ISO_SLICE_MS`；把看画面的出队次序与背压交给隔离编排 |
| `server/render-node/host.mjs` | 独立渲染主机（以及托管方的常驻工作进程，它就是一台独立渲染主机）每一拍按「最久没轮到的项目先」推进，发出认领的项目排到最后；取消「有成员在线的项目优先」（与产品那一条「同一类里各项目轮流」冲突，见「语义」一节）。`members` 照旧记着、诊断里看得到 |
| `server/agent/service/account-runner.mjs`、`server/agent-service/account-task-worker-config.mjs`、`server/agent-service/look-client.mjs` | 去掉心跳与收尾通知的发送与转发 |
| `server/agent-service/account-master-assembly.mjs` | 任务进程发来的 `release` / `heartbeat` 照样过授权核对，回 200 什么都不做（滚动重启时旧任务进程还会发） |
| `server/agent/service/frame-dispatcher.mjs`、`server/agent/service/instance.mjs` | 两处注释里「按轮占用」「空闲满五分钟才让位」的说法改掉 |
| 测试：`server/test/hosted-render-isolation.test.mjs`（HR23 四条重写）、`hosted-render-look.test.mjs`（HR41 重写）、`hosted-render-queue.test.mjs`（RQ3 重写，RQ1、RQ4 按新次序改）、`hosted-render-service.test.mjs`（HR16「成员在线优先」改成「各项目轮流」）、`hosted-render-usercards.test.mjs`（配置项）、`cloud-see-frames-dispatch.test.mjs`（不再有心跳与收尾通知） | 原来断言的是被取代的规则 |

任务书清单之外改到的文件：`server/agent/**`、`server/agent-service/**` 那几处（为了不把心跳与收尾通知留成死代码），以及上面那几份测试。没有动 `src/online/**`、`src/editor/**`、`src/mobile/**`、`src/ai/cloud/**`、`scripts/probes/playback-probe.mjs`、任何语义文档、任何 `docs/plan/**`。

## 0.7.18 暂行办法：留什么、删什么

| 东西 | 处理 | 理由 |
|---|---|---|
| 按轮占用的状态机（占住、排队的轮、共用、FIFO 防插队、强制解锁） | 删 | 产品那一条：多项目模式「不让哪个项目占着」，0.7.19 起取代暂行办法。留着就是死代码 |
| 「空闲满五分钟才让位」「连续做满五分钟让一轮」 | 删 | 同上；别的项目一排上就不等（机制那一条：「别的项目要用时随时清掉、不等它空闲」） |
| 产流的「真人在线项目先产、两个以上五分钟轮换」「流产满且五分钟没修改才关」 | 删 | 用户 2026-10-16 第 4 节第 4 条原话：多项目模式以后不再被项目独占；改成按任务轮流 |
| 2 分钟没心跳当结束 | 删 | 没有「一轮」了，不用判它结束没有 |
| 任务进程每 30 秒发心跳、收尾 / 被叫停时发「结束了」 | 删（发送方与转发链） | 收的一方什么都不做了，再发就是死代码。被叫停时排着的看画面请求本来就由 `look-client` 按 `signal` 撤回（`/look/cancel`），不靠「结束了」 |
| 渲染服务的 `/look/release`、`/look/heartbeat` 两条路由 | 留，改成认身份后回 200、什么都不做 | 节点上滚动部署时，Agent 服务与渲染服务分开重启，可能有一段时间是 0.7.18 的 Agent 服务对着 0.7.19 的渲染服务；删了它会收到 404（虽然它吞掉错误，但日志里会记失败）。节点上不再有 0.7.18 的 Agent 服务之后可以删，代码注释里写了 |
| 主服务收任务进程的 `release` / `heartbeat` | 留，改成过授权核对后回 200、不转发 | 同一个理由：主服务与任务进程换代不同时 |
| 反过来：0.7.19 的 Agent 服务对着 0.7.18 的渲染服务 | 不发心跳了，旧渲染服务会在 2 分钟后按超时放开这一轮 | 降级而不坏：最多多占 2 分钟。部署顺序先渲染服务后 Agent 服务就没有这一段 |
| 看画面的「排队不计时、渲染一次最多三分钟、超时回调试信息、一次不重试、队列 10 分钟不动回排队异常」 | 留 | 用户 2026-10-16 第 3.4 节定的，不属于「按轮占用」，多项目模式下照样成立 |
| 隔离工作进程本身（只装一个项目、自己的数据目录与端口、口令每轮现生成、换项目前清空） | 留 | 这就是机制那一条第四条「每个请求在只属于它那个项目的隔离环境里执行」的做法；换了的是「什么时候换」 |

## 验证

所有命令都在本 worktree 里跑；跑 `npm test` 之前设了任务书给的两个环境变量（值不写进这里）。机器上同时有别的任务在跑，内存一直吃紧（隔离探针的日志里背压原因是「内存」，可用内存 40～110 MB）。

### 门槛 1：类型检查

`npx tsc -b --force`：退出码 0，没有输出（零错误）。

### 门槛 2：全量测试

第一次 `npm test`（满载）：tests 7452，pass 7432，**fail 5**，skipped 15。第一轮末再跑一次：tests 7453，pass 7437，**fail 1**（下表第三行那一条）。**第二轮最终代码上**：tests 7461，pass 7438，**fail 8**，skipped 15，todo 0；8 条里除 `account-v2-deploy-config` 外，所在的 7 个文件单跑全过：`account-page-link` 1/1、`move-guard` 7/7、`recovery-vault-large` 2/2、`reopen-recovery` 25/25、`sp-hosted` 12/12、`wait-writes-quiet` 9/9、`worker-event-sink-mtls` 1/1（满载时序假失败，都与本分支无关的模块）。逐个单跑复核：

| 失败的用例 | 满载 | 单跑第 1 次 | 单跑第 2 次 | 结论 |
|---|---|---|---|---|
| `server/test/user-editing.test.mjs` UE-S7、UE-S7～S10（两条） | 失败 | 11/11 过 | —— | 时序假失败 |
| `server/test/collect-plugin.test.mjs`「download:done 事件之后……」 | 失败 | 17/17 过 | —— | 时序假失败 |
| `server/test/account-v2-deploy-config.test.mjs`「v2 deploy config registers an optional service……」 | 失败 | 8/9 | 8/9 | **环境造成，不是本分支引入**：用例断言整份结果里不出现字符串 `render`，结果里有 `accountOrderModuleFile` 的绝对路径，本 worktree 的目录名 `multi-project-render` 里就有 `render`。把 main `6c571a27` 的代码导出到本 worktree 下 `out/main-copy` 原样跑，同样 8/9 |
| `server/test/media-tiers.test.mjs` T3-8「应用重启后队列恢复……」 | 失败 | 18/19 | 18/19 | **不是本分支引入**：main `6c571a27` 的代码在同一处原样跑同样 18/19（读队列文件 ENOENT，日志里素材服务 PUT ECONNRESET）。本分支没碰 `server/upload-queue.mjs`、`server/media-tiers.mjs`。最终那次全量里它又过了（时好时坏） |

开发中途另有一次几个文件并行跑时 `cloud-agent-look/page/runs/scope` 四个文件失败 4 条，单跑 47/47 过（时序假失败）。

本分支直接相关的测试单跑：`hosted-render-*.test.mjs` 全部、`multi-project-*.test.mjs`、`cloud-see-frames-dispatch.test.mjs`、`accept-018-rest-queue-account-look.test.mjs`、`cloud-agent-look.test.mjs` 合跑 140/140；`render-host*.test.mjs`、`render-node-*.test.mjs`、`hosted-render-streams.test.mjs`、`c10-host-claim.test.mjs`、`auto-render-node.test.mjs` 合跑 182/182；`accept-018-rest-ssr-seam.test.mjs`（独立入口不许引 `src/`）过。

### 门槛 3：两种模式出的画面相同（逐帧）

探针 `scripts/probes/multi-project-expand-probe.mjs`，开发服务器开在 5880：

```
node scripts/probes/multi-project-expand-probe.mjs --url http://127.0.0.1:5880 --out out/mpe-run3
→ 退出码 0；{"ok":true,"requests":7,"frames":24,"identical":24,"diffPixels":0}
```

测试项目 640×360、30 fps、12 秒，13 个片段：推帧卡（odometer、mu-number-ticker）、毛玻璃这类依赖下层的卡（blur-text，下层是视频）、画布卡（particles）、remotion 式卡（lottie）、两段视频交叉溶解、图片素材、一个剪辑段（引用停放的剪辑，从它的第 1 秒起，里面两张卡 ring-metric、checklist）、一条隐藏序列。7 个请求共 12 帧，挑在挂载边界（1.0 s 前一帧与当帧、8.2 s 推帧卡刚挂上）、交叉溶解重叠段、剪辑段里两张卡重叠处、最后一帧。

每个请求渲两遍：整份项目一遍（单项目模式），按这个请求要的帧展开后一遍（多项目模式）；两条出图路各比一次：

- 导出取帧（`exportUnified`）：12 帧，不同的像素 0；
- 看画面那一路（工作进程的 `renderFrames` 用的 `FramePipeline#see_frames`）：12 帧，不同的像素 0；
- 合计 **24/24 帧逐像素相同（RGBA 逐字节），不同的像素数 0**。

展开后片段从 13 个降到 2～7 个，例如「交叉溶解重叠段」只剩 4 个（blur-text、两段视频、隐藏序列上横跨全片的那张），「末尾」只剩 2 个、素材 0 个。看过的图（拷到了 `docs/archive/agent-reports/assets/multi-project-render/`）：`expand-r4-multi-000138.png`（毛玻璃卡 + 画布卡叠在视频上）、`expand-r6-multi-000255.png`（剪辑段里的 ring-metric 盖在图片上）、`expand-r2-single-000045.png`（毛玻璃卡 + odometer），画面内容正常，不是两遍都空白。第一次跑时序列次序放反了（视频盖住了卡），也是 0 差异，但证据弱，所以调了次序重跑。

另按 `verification.md` 跑了渲染附加项（本分支没有改出图管线，只改了交给它的项目内容；跑一遍为稳）：

- `scripts/verify-unified-frames.mjs`（PC_FRAME_TEST_URL 指 5880）：PASS，退出码 0；
- `scripts/verify-determinism.mjs --url "http://127.0.0.1:5880/?export=1" --frames 0-299`：300 帧全部相同，退出码 0。

导出像素基线：本分支没有改导出、舞台、卡片的画面代码，像素基线不变，不涉及重定基线。

### 门槛 4：队列顺序

单测把实际出队次序打出来：

| 用例 | 场景 | 实际出队次序 |
|---|---|---|
| MPQ1（`multi-project-queue.test.mjs`） | 先来的产流请求、后来的看画面请求 | `look:C → look:A → stream:A → stream:B → stream:A` |
| MPQ2 | A 一口气来 4 个、B 2 个、C 1 个 | `A1 → B1 → C1 → A2 → B2 → A3 → A4` |
| MPQ2b | A 正在一个个出，B 中途来了 | `A1 → B1 → A2 → A3` |
| MPQ4 | 排在前面的 B 此刻做不了 | 先出 `A1 → C1`，B 能做了以后它最久没轮到、排第一 |
| RQ3（`hosted-render-queue.test.mjs`，真的看画面队列） | 甲 3 个、乙 2 个、丙 1 个依次登记 | 转给工作进程的次序 `a1 → b1 → c1 → a2 → b2 → a3`；排队位次 `[0,3,5,1,4,2]` |
| HR23（`hosted-render-isolation.test.mjs`，隔离工作进程） | 三个项目都有很多产流任务 | 依次装 `pA → pB → pC → pA → pB → pC`（每个做了一个任务就换） |
| HR16（`hosted-render-service.test.mjs`，独立渲染主机，真队列） | 按 a1、b1、a2、c1、b2、a3 的先后发布，并发 1 | 认领、做完的次序 `a1 → b1 → c1 → a2 → b2 → a3` |
| MPI1（`multi-project-isolation.test.mjs`，看画面队列 + 隔离编排接在一起） | 甲 3 个、乙 2 个带用户卡 | 出图 `a1 → b1 → a2 → b2 → a3`，隔离工作进程依次装 甲、乙、甲、乙、甲 |

端到端（真进程）：云端排队探针 `scripts/probes/hosted-render-queue-probe.mjs`（本分支改成按多项目模式验）在本机隔离的托管组合 + 真的渲染服务上跑（`--base-port 5880 --doc-port 5888 --asset-port 5889 --time-scale 3`，缓存时长用生产的 5 分钟）：**13/13 过，退出码 0**。三个都带用户卡的项目甲、乙、丙，卡把舞台涂成各自的颜色：
  - Q3a：甲出完图空着，丙发了产流计划，15.8～30.1 秒内换装丙（不等五分钟），甲那一轮结束原因 `rotated`；
  - 丙在产流时甲、乙依次登记 甲-2、甲-3、乙-1、乙-2（另一条乙登记后撤回）：实际出图次序 **乙-1 → 甲-2 → 乙-2 → 甲-3**（Q1），这一段里隔离工作进程依次装 乙、甲、乙、甲，结束原因全是 `rotated`、没有一次是空闲满时长（Q3），丙做完手里那一个就让、四帧出完之前没再装丙（Q2），每一帧的颜色都是自己项目的、都由隔离工作进程出（Q4），任何一拍都没有同时装两个项目、撤回的不留（Q1b）；
  - Q5a～Q5c：请求排着时强杀管理进程整棵树 → 盘上留着；再起时内存吃紧 → 因背压排着、不新起；正常再起 → 先为它（看画面）起来、出图、颜色对；
  - Q6：丙的计划让过了四帧和两次重启，看画面的都出完后 16.8 秒为丙起来把它做完；Q7：一次不重试、到时限回「渲染超时」；Q8：进程与端口都收干净。
  - 这支探针跑了三次：第一次 Q1 不过——探针并发发出四个请求，渲染服务收到的先后与发出的先后不同（服务端照收到的先后做是对的），改成一个一个登记；第二次暴露了两个真问题并修掉（见下「跑探针时修掉的两个问题」）；第三次全过。


### 门槛 5：隔离

单测 `server/test/multi-project-isolation.test.mjs`（连跑 6 次都过）：

- MPI1：两个带用户卡的项目交错要画面，每个请求转出去的那一刻，隔离工作进程装着的就是它自己的项目、带的是那一轮的口令；每次装下一个项目之前，上一轮已经 stop → cleanup（清空）；五个请求用了五个不同的口令。起停记录：`prepare:a start:a stop:rotated cleanup:a prepare:b start:b stop:rotated cleanup:b prepare:a …`；
- MPI2：隔离工作进程这一轮的口令只要得到它那个项目的票据，要别的项目的 403；换了一轮，旧口令 401；
- MPI3：展开后的项目只带本项目素材表里、被用到的素材条目；
- MPI4：排空中工作进程自己退出算换装；同一项目出过图的一轮没了，不算后面排着的请求「起不来」（见下「跑探针时修掉的两个问题」）。

端到端探针 `scripts/probes/hosted-render-isolation-probe.mjs --base-port 5880 --doc-port 5888 --asset-port 5889 --time-scale 3`（本机隔离的托管组合 + 真的渲染服务、真 Chrome、「越权探测卡」夹具）：**49/49 过，退出码 0**。与本项直接相关的几条：

- H：甲的结果里没有乙的内容、乙的卡片源码；乙的结果里没有甲的记号卡；乙那一轮开始之前的全部输出里没有乙的内容与卡片源码；
- I：换项目之前甲那一轮结束并清空（`reason: rotated, cleaned: true`），两轮之间数据目录是空的；每一轮各是一个新进程、结束后进程树不剩；乙那一轮的改动层里只有乙的卡；乙的页面里没有甲的卡片代码；
- L2：看画面这一路的渲染页取不到别的项目（乙）的卡片文件；
- A3：对照——探测卡读自己项目的素材是通的（不是探针瞎了）。

素材：探针的「残余面」第 1 条照旧如实记录——同一台素材服务上，成员凭自己项目的票据按哈希读得到别的项目的块（`memberCanReadOtherProjectBlobByHash: true`），这是 `auth-contract.md` 第 8 节的既有裁定，探针本来就把它记成残余面、不算隔离失败；不是本分支引入的。素材服务按项目分库、拿 A 的票据读不到 B 的流与块的单测在 `server/test/asset-project-workers.test.mjs`（本分支没动，满载与单跑都过）。见下「语义」第 5 条。

这支探针一共跑了五次（端口 5880～5889）：第 1 次没起来（常驻工作进程 180 秒没交诊断被看护重起，探针等就绪 300 秒超时，退出码 2，当时机器可用内存只有几十 MB）；第 2 次加 `--time-scale 3`，49/49 过（那时还没修下面两个问题）；修完后第 3 次 48/49，不过的是 L3「绕过管理进程直接请求工作进程」——常驻与隔离工作进程恰好同时在重起、连不上（ECONNREFUSED），原因见下「Windows 上的事件循环」一段；第 4 次探针自己读状态口 5 秒超时中途退出（退出码 2）；第 5 次（最终代码、机器负载降下来之后）**49/49 过，退出码 0**，上面列的就是这一次。逐条结果与汇总 JSON 存在 `docs/archive/agent-reports/assets/multi-project-render/isolation-probe-checks.txt`、`isolation-probe-result.json`；云端排队探针的同样存在 `queue-probe-checks.txt`、`queue-probe-result.json`。

### 跑探针时修掉的两个问题

1. 排空中的隔离工作进程自己收尾退出（清单标了排空、手里的做完，工作进程退出）时，管理进程有时先看到「进程没了」，把这一轮记成意外退出（`exit`）而不是换装（`rotated`）。改成排空中退出算换装（`isolation.mjs`）。
2. 多项目模式下一个项目的一轮可能先为它前面的请求出过图、之后才没了；原来的规矩把它当成「为后面排着的这个请求起的一轮没起成」，重试次数为 0 时直接回「这次没看成」。改成只有没出过图就没了（`worked` 为假）才算（`look.mjs`）。两条都补了单测 MPI4。

**Windows 上的事件循环**（本分支没改）：管理进程量内存（`limits.mjs` 的 `measureWindows`）与结束进程树（`worker.mjs` 的 `listProcesses`）都用 `spawnSync('powershell.exe', …)`，机器满载时一次能卡住事件循环好几秒；工作进程每 5 秒问一次代理口、连续 3 次问不通就自己退出，于是满载时偶尔看到常驻与隔离工作进程同时以退出码 0 退掉（隔离探针第 3 次跑的 L3 就是撞上这个）。多项目模式换装更频繁，碰上的机会更多。节点是 Linux（走 `/proc`），不受影响；本机跑探针时会受影响。建议另开一项把这两处改成异步。


## 语义里说不通或缺的地方（交给主会话）

1. **「同一类里各项目轮流」与「有成员在线的项目优先」冲突**（代码按语义改了）。`hosted-render-contract.md` 第 4 节与 0.7.18 暂行办法里都有「有真人成员在线的项目先」：独立渲染主机每一拍先推进有成员在线的项目（`host.mjs`），隔离工作进程的候选按成员在线排（`isolation.mjs`）。产品那一条只说各项目轮流，没有成员在线优先，用户 2026-10-16 第 4 节第 4 条也说这是临时的。按原则 2 以语义为准，两处都改成纯轮流，`members` 只留在诊断里。如果要留「有人在看的项目先」，需要在产品那一条里写明（二级）。

2. **「同一项目内先来先做」与「稀疏版排在满密度版前面」、发布方的优先级怎么合**。产品那一条说同一项目内先来先做；同一册「重管线」又说稀疏版排在满密度版前面，发布方还给任务排名次（锚帧段 50、普通段 10，`pick.mjs`）。实现时同一项目内沿用原来的挑法（先按档与名次，同名次再按发布先后），即把「先来先做」读成「同一优先级内先来先做」。请在语义里写明这个读法，或者改。

3. **轮流按「一个请求」算，和「隔离环境」的换装成本**——主会话 2026-10-22 已定方向：一轮最多连做 K 个，K 实测定为 4（见第二轮第二件）。多开隔离槽、按页面隔离两条路的工作量与风险也写在那里。

4. **产流任务的「展开」与键**——主会话 2026-10-22 已定：键按这条流展开出的子集算（见第二轮第一件）。还剩「节点算计划那一步仍装整份项目」，见「没做成的」卡点 1。

5. **素材「不能跨项目读」在非账号模式下没有做到**。产品 `asset-service.md` 第 19 行：持有别的项目的票据、知道哈希也读不到。机制同册第 10 行：账号模式下每个项目一个物理库，「局域网和本机项目仍用全局库」。隔离探针用的是本机托管组合里的自由模式共享项目（不是账号项目），残余面第 1 条实测：甲的成员凭甲的票据按哈希读得到乙的块，隔离工作进程里甲的页面经 `/@media/<哈希>` 也读到了。账号模式下按项目分库、读不到的单测在 `server/test/asset-project-workers.test.mjs`。产品那一条没写例外，机制那一条留了全局库：两边说不通，请定（这不在本分支范围，渲染服务这一侧拿到的票据只给本项目，已经做到）。

6. **0.7.18 的验收清单还引着旧说法**。`scripts/acceptance/v18-manifest.mjs`（`V18-queue-probe`、`V18-queue-probe-prod` 要求 `"realIdle": true`、说明里写「按轮占用」）与 `four-stage-manifest.mjs` 第 165、756 行描述的是 0.7.18 的行为；云端排队探针本分支已改成按多项目模式验。0.7.19 的验收清单请改引新的探针说明（`docs/plan` 下的清单与任务书本分支不动）。


## 要定的三级数字（交给主会话）

主会话 2026-10-22 认可了前四个，照旧标〔裁〕；K 是第二轮实测定的。

| 数字 | 现在用的 | 在哪 | 说明 |
|---|---|---|---|
| 没人排队时隔离工作进程装着的项目留作缓存多久 | 5 分钟〔裁，三级〕 | `isolation.mjs` 的 `ISOLATION_DEFAULTS.CACHE_MS`；环境变量 `PROMPTCUT_RENDER_ISO_IDLE_MS` | 只在没人排队时起作用，别的项目一排上就不等 |
| 内存吃紧时清掉空着的缓存 | 背压原因里有「内存」就清 | `main.mjs` 的 `memoryLow` | 负载高、文档服务慢不算 |
| 换项目时等手里那一个做完的上限 | 120 秒〔裁，三级〕 | `ISOLATION_DEFAULTS.DRAIN_MS`（原有） | 到点让掉认领结束 |
| 展开时判「挂没挂」前后多放的余量 | 一帧（1/fps）〔裁，三级〕 | `expand.mjs` | 取超集，多留不改画面 |
| 隔离槽数 | 1〔裁，三级〕 | 隐含在 `isolation.mjs` | 多开的代价见第二轮第二件 |
| 一个项目一轮最多连做几个（看画面的请求、产流的任务） | **4**〔裁，三级：主会话 2026-10-22 定方向，按实测定数〕 | `look.mjs` 的 `LOOK_DEFAULTS.turnRequests`、`isolation.mjs` 的 `TURN_TASKS`；环境变量 `PROMPTCUT_RENDER_TURN`（1～64） | 实测与取舍见第二轮第二件 |
| 隔离工作进程没起成的重试次数 | 3（原有 `isoRetries`，原来没生效） | `look.mjs` | 第二轮修好，见第二轮第二件末 |

## 没做成的及原因

### 卡点 1：产流任务只加载这个任务用到的卡和素材（第二轮已做到产流这一步，剩计划那一步）

第一轮这一条没做，卡在键上。第二轮主会话定了键的口径（按子集算），**产流**这一步已经只装这条流展开出的子集，流任务的代码要求也按子集写了，画面与键都有逐帧、逐字节的证据（第二轮第一件）。

还剩的：节点**算计划**（`planForQueue`）仍按「项目@版本」装整份项目，隔离工作进程的卡片同步仍装这个项目的全部定制卡。解法表更新：

| # | 轮 | 层 | 父 | 候选 | 改善机制 | g | h | f | 验证 | 状态 | 结果 / 学到 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 三级 | — | 产流那一趟按这一段展开、去掉无关的隐藏源序列 | 渲染页少挂无关的片段与素材 | 2 | 4 | 6 | 产流逐帧比对 | 已试·过（第 2 轮） | `StreamProducer#isolatedOf`；探针 P 23/23 帧相同 |
| 2 | 1 | 三级 | — | 计划阶段只用展开后的项目算 | 计划不再装整份项目 | 4 | 2 | 6 | 发布方与节点键一致 | 开放 | 第 2 轮探针 K 证明按子集算计划键逐字节相同，键上安全；卡在 entry 与层表按版本共用（每个任务一个子集会让层表互相覆盖），要先定层表归谁 |
| 3 | 1 | 三级 | 2 | 隔离工作进程的卡片同步只装任务要的卡 | 页面只加载用到的用户卡 | 3 | 2 | 5 | 隔离探针 I 一类的断言 | 锁在 2 后面 | 流任务的 `requires.cardSources` 已按子集写，要求这一侧已就绪；计划阶段要全项目的卡，2 不成立之前只装一部分会让计划失败 |
| 4 | 1 | 二级 | — | 改任务的键或契约 | —— | —— | —— | —— | —— | 关闭·剪 | 第 2 轮主会话定了三级的键口径，不需要动二级 |
| 5 | 2 | 三级 | — | 键按子集算（主会话定） | 发布方与节点同一算法 | 2 | 1 | 3 | MSK1～MSK6、探针 K | 已试·过 | 唯一受影响的是依赖下层的流退回整场景的键，已改；单卡流的键本来就与别的片段无关 |

### 其它

- 节点（149.88.94.84）上的真实网络验证没跑：任务书不许碰节点。
- 开发服务器的预渲染子进程用的是系统随机分的空闲端口（`vite-plugin-prerender.ts` 的 `freePort`，所有开发服务器都这样），不在 5880～5889 段内；没有占用任何固定端口。

