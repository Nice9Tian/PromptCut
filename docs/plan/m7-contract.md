# M7 契约：纯浏览器节点

状态：契约第 1 版，2026-09-28 PC 主会话定稿（起草：主会话派出的只读调查子 Agent，核对的代码是 main `2c7cee2`、`origin/claude/c10-integ` `fcbff6c`、`origin/claude/c10-browser` `9ad7429`）；发给用户审但不等（主执行计划第 10 节）。正文里写「建议」的，经主会话逐条审定，裁定见第 13 节〔裁〕；写「未证实」的由第 8 节的可行性探针回答。实现排在 C10 合入 main 之后，先派探针。

依据：

- 语义：
  - `docs/semantics/product/platforms.md`「面向的平台」（低内存档不当节点）、「渲染节点」（纯浏览器只认领本人产生的、不需要本机转码的快照任务，一期只限内置卡片；播放拖动时不认领新任务、手里那一批做完为止；绝不替别的用户干活）、「在线浏览器模式」；`docs/semantics/mechanism/platforms.md`「渲染节点」；
  - `docs/semantics/product/document-service.md`「渲染任务队列」（只记账不分配；只把权限关，纯浏览器只见本人任务、由文档服务保证）、「会话与传输」；`docs/semantics/mechanism/document-service.md`「渲染任务队列」（拉取式、节点自己挑、指纹前置过滤、完成、断开与超时、优先级）、「会话与传输」；
  - `docs/semantics/product/rendering.md`「重管线：预渲染」（不同环境的结果不混用；两档）；`docs/semantics/mechanism/rendering.md`「舞台」「重管线：预渲染」（卡片级指纹锁、预渲染结果的复用与接手）。
- 计划：`docs/plan/Master-Execution-Plan.md` 第 6.5 节 W7、第 7 节 M7、第 8 节、第 9 节；`docs/plan/TASK-distributed-prerender-queue.md` 第 2 节 M7 行、第 6 节 E5；`docs/plan/distributed-prerender-queue.md` 第 2、2.1、4.2～4.4 节与 Q1、Q2；`docs/plan/render-queue-contract.md` A、B、D、F、I、J 节；`docs/plan/c10-contract.md` 第 2、5、7、8、18 节；`docs/plan/c10-research.md` Q4、Q5；`docs/plan/http-transport-contract.md` 第 4、9 节与 `docs/reports/REPORT-HT-a.md`；`docs/plan/auth-contract.md` 第 5、6、8 节；`docs/plan/c10a-contract.md` 第 8、9 节；`docs/plan/cloud-task.md` L1 与 L 节验收；`docs/plan/m6c-contract.md` X3～X5。

## 0. 前置核对（代码现状）

| # | M7 要用的东西 | 现状 | 证据 | 缺口 |
|---|---|---|---|---|
| 1 | 队列的 `profile: 'browser'` 与能力过滤 | 有 | `server/render-queue/messages.mjs:13`（`PROFILES` 含 browser）；`server/render-node/filter.mjs` 的 `DEFAULT_WEIGHT_POLICY.browser = ['light','medium']` 与规则 0～6（`checkClaimable`）；队列侧 `queue.mjs:702` browser 认领 plan 回 `plan-profile`、`:519` browser `watch 'all'` 回 forbidden；`server/docservice/modules/render-queue.mjs:196` browser 订阅摘要回 forbidden | `profile` 是 `node.hello` 自报的，`onNodeHello`（`queue.mjs:438-453`）照收，服务端不核对（D9） |
| 2 | 按 userId 挡别人的任务（E5 两层） | 有 | 分发：`queue.mjs:107`（`canSee`）；认领：`queue.mjs:697-699`（回 `forbidden`，不带 state）；真凭证下「同名不同设备」已验：`server/test/auth-members.test.mjs:406` AU10；进程内：`render-queue-inproc` I5 | 没有「真页面当节点 + 第二成员」的端到端；同一 `nodeId` 的新连接直接取代旧连接，不看 userId（`queue.mjs:440-445`） |
| 3 | light / medium 分级（B2） | 有（节点侧） | filter 规则 4；切分方给的重度 `server/frame-pipeline.mjs:2498-2504` `queueWeightClass`：本地档、canvasHeavy、belowDependent、unknown 记 heavy，其余 medium，没有 light；流任务走规则 2（要转码） | 无代码缺口。语义规定能力过滤由节点自己做，服务端不加 B2 闸（`product/document-service.md`「只记账，不分配」） |
| 4 | 节点会话状态机能否在页面跑 | 部分 | `server/render-node/session.mjs` 本身纯逻辑，但第 1 行从 `../render-queue/index.mjs` 取常量，`index.mjs` 转出 `queue.mjs`，后者 `:23` 引 `node:crypto`；页面现在只直接引 `session-link.mjs`（`src/editor/sync/link.ts:21`）。`local-node.mjs` 经 `split.mjs` 引 `fingerprint.mjs:1`（`node:crypto`）；`content-client.mjs:15`、`server/asset-store/client.mjs:25` 同样引 `node:crypto` | 页面构建会不会因此失败：未证实。`session.mjs` 改从 `constants.mjs` 取常量（一行）即可去掉（D11）。〔探针 P6 后更正：要改两处（另有 `filter.mjs`），风险是「在线构建不失败、开发服务器白屏」，见第 13 节「探针之后的更正」第 1 条〕 |
| 5 | 页面拿认领用的凭证（子协议） | 有零件 | 页面连接上签 `auth.ticket { kind: 'conn', role: 'render' }` 服务端支持（`modules/shared.mjs:197-227`）；页面已这样签过 agent、page 票据（`src/editor/sync/syncManager.ts:386`、`:402`）；子协议 `promptcut.ticket.<票据>`（`server/auth/client.mjs:214` `ticketProtocols`；服务端 `handshake.mjs:195-198` 按 `kind: 'conn'` 核）；`node.hello` 只许 render 角色（`modules/render-queue.mjs:48` `mayRegisterNode`、`:274`）；连接票据 2 分钟（`auth-contract.md` 第 8 节）；会话层 `createDocEndpoint` 每建会话现取 `protocols()`（`http-transport-contract.md` 第 9 节） | 页面没有开 render 连接的代码 |
| 6 | 后台舞台执行快照任务的执行器 | 部分（C10 分支） | 父页判空闲、经 RPC 开停：`c10-browser` `src/editor/backWorkGate.ts`、`StageView` 的 `backGate` 与 `setBackWork`；舞台逐帧 `setTimeout(0)`（`advanceToAsync` 的 `yieldEvery: ONLINE ? 1 : 8` 与 `gate`）；每控件快照 `createSnapshot` 的 `controls[].html`；大块产出压成可转移 `ArrayBuffer`（`compressHtml`、`probe-frame.htmlGz`）；后台活单飞队列 `src/editor/stageJobs.ts`，RPC 工作项早就留了 `'bake'`（`src/render/stageRpc.ts:26`，`stageJobs.ts:37` 注「J4」） | 没有生成快照 RPC：探针的快照趟受一拍预算截断、推的是整场景；桌面预渲染按隔离单卡工程、4 帧一批生成快照（`frame-pipeline.mjs:2220-2260`、`isolatedCardProject` `:2598-2630`），页面没有对应物。桌面只把**独立卡**的页面测量帧当预渲染结果（`server/vite-plugin-frames.ts:1205` `NOT_INDEPENDENT`） |
| 7 | 产物推送（写票据） | 部分 | 写票据 `auth.ticket { kind: 'asset', access: 'rw' }` 页面签过（`src/editor/media/assetTiers.ts:471`，桌面转交编辑器进程上传）；素材服务分片接口（`server/asset-service.ts` 文件头：`GET <ns>/<hash>/chunks`、`PUT <ns>/<hash>/<n>`、`POST <ns>/<hash>/complete`，snap 同规则）；续签器 `c10-browser` `src/export/ticketRenewal.ts` | 在线页面不上传（C10 第 10 节）；Node 客户端 `asset-store/client.mjs` 进不了页面。要一个页面上传器 |
| 8 | 清单写内容库 | 部分 | `content.put` 类 `snapshot-manifest`，无角色限制（`server/docservice/modules/content.mjs`）；清单形状 `server/artifact-transfer.mjs:283-290`（`collectSnapshotResult`）、校验 `:145-161`（`manifestMatches`）、写入 `:530-547`（`writeManifest`）；页面 `request` 能发 content.*（C10 `planPublisher`） | `artifact-transfer.mjs` 引 `node:fs` 与 `node:crypto`，页面要照形状另组清单（单测对拍） |
| 9 | 卡片级指纹锁的上报 | 队列侧有，生产没人用 | `card.lock` 只在 `PUBLISHER_TYPES`（`messages.mjs:23`），处理在 `queue.mjs:843-853`；锁在第一次认领时建（`queue.mjs:760-763`）；认领、完成刷新 `touchedAt`（`:762`、`:810`），续约不刷新（`onProgress` `:790-797`）；`card-locked` 回包只带 `lockedBy`（`:752`）。生产代码没有一方发 `card.lock`（grep 只命中队列本身） | 队列锁不会因闲置被接手：`local-node.mjs:213` `takeoverLocked` 缺省 false，没有调用方传它；语义要求「锁定方已经有一段时间没有再产出，就用自己的指纹接手整张卡」（`mechanism/rendering.md`），对队列锁代码比语义严（D2） |
| 10 | 浏览器自己的环境指纹 | 缺 | 页面只报原始值（`src/editor/pageEnvironment.mjs` 文件头「页面只报原始值，不自己算指纹」），测量帧入库时由服务端按 `describeEnvironment` 算（`vite-plugin-frames.ts:1210-1216`）；`node.hello` 要字符串 `envFingerprint`（`messages.mjs:252-259`）。`chromeMajorOf` 对不带 `Chrome/` 的 UA 取第一个数（`fingerprint.mjs:70-77`），Firefox、Safari 都得 5，指纹会撞 | D10、D14 |
| 11 | 任务落到浏览器的环境 | 缺（核心） | 切分方对没锁的卡按自己的指纹出键（`distributed-prerender-queue.md` 2.1；`local-node.mjs` 把 `node.envFingerprint` 交 `splitPlan`）；页面的清单计划不带指纹（`c10-browser` `src/online/planPublisher.ts` 文件头）；指纹前置过滤只给节点看同指纹的任务（`queue.mjs:108`，契约 I.2） | 今天不会有 `requires.envFingerprint` 等于浏览器指纹的细任务，纯浏览器节点一个任务也看不见（D1） |
| 12 | 执行用哪一版项目 | 部分 | 细任务带 `source.projectRev`（继承 plan，`queue.mjs:590`）；`project.snapshot.get` 只发当前版本或有人上传过快照的版本（`modules/project.mjs:833-860`）；页面 `DocSync` 留着已确认版本（`src/store/docsync.ts:304-305` 私有 `confirmed`、`confirmedRev`）；桌面执行器按内容键把任务对回 control（`server/prerender-executor.mjs:99` `matchControl`），页面算不了内容键 | D6 |
| 13 | 预渲染小尺寸 | 缺 | 桌面用 CDP 截图出 WebP（`server/bakery/small-bitmap.mjs:84`）；完成条件「两档都推送成功」（`c10a-contract.md` 第 9 节；`artifact-transfer.mjs:615-625`）。可借的路：在线导出把快照包成 SVG `foreignObject`、以 `data:` 地址画上画布，实测不污染画布（`src/export/frameCompositor.ts:13-14`） | D5 |
| 14 | 层表 | C10 分支上是 v 2 | 每层带 `contentKey`、`envFingerprint`（`c10-browser` `server/artifact-transfer.mjs` `layerMapOf`）；独立主机在**切分之前**按本机视图写层表（`c10-browser` `server/prerender-executor.mjs` `plan()` 的 `publishLayerMap`），`card-locked` 之后照锁定方重切的最终出键不回写 | D12 |
| 15 | 低内存档不当节点 | 有 | C10a 能力闸：不开后台舞台、不跑探针、不认领（`c10a-contract.md` 第 8 节）；C10 分支 `stageLayout`、`ProbeGate` 按低内存档关（`AGENT-c10-browser.md`「第 2 节」） | 只缺验收 |
| 16 | `createSnapshot` 平方复杂度的维护项 | 已做 | main `bb01107`（合并 `claude/snapshot-ids`，1400 个带 id 元素 6.3 s → 0.85 s，输出逐字节不变） | 无 |
| 17 | C10 本身 | 未合入 main | `c10-browser` 没合进 `c10-integ`；C10-A4「暂停后追到精确活渲」没过，A9、A10 没跑（HANDOFF-2026-09-28 第 2 节） | A4 与 M7 共用后台舞台的角色互换与单飞队列，是硬前置 |

## 1. 范围

| 在范围内 | 不在范围内（去处） |
|---|---|
| 在线普通档的后台舞台当 `profile: 'browser'` 节点：开 render 连接、报到、只 watch 本项目、认领、续约、让路、放回（第 2、5 节） | 低内存档当节点：不做（语义） |
| 浏览器可做的卡怎样落到浏览器的环境；锁闲置接手（第 3 节，D1、D2） | 纯浏览器认领 plan、切分：不做（设计规则 6、队列 `plan-profile`）。没有能切分的节点在线时浏览器不干活 |
| 生成快照执行器：后台舞台的 `bake` 工作项，逐帧生成快照，压缩交父页（第 4 节，D3） | 轨道流、要转码的任务、本地档（整场景）快照、用户卡、图卡、改过源码的卡：不认领（语义「一期只限内置卡片」；规则 1～4） |
| 两档产物：原尺寸 HTML 快照与小尺寸 WebP，推素材服务、清单写内容库、`task.complete`（第 4 节，D5） | 替别的用户干活，含同名不同设备：不做（E5） |
| 自产的块进页面内快照库；层表与实际出键一致（第 4 节，D12） | 非 Chromium 内核的浏览器当节点：一期不做（D14） |
| 凭证：render 连接票据、子协议、HT-a 会话层、写票据续签；profile 与凭证绑定（第 5 节，D9、D10） | 放本机的项目（局域网主机、明文 http 页面）里当节点：随 PC 窗口项（C10 第 13 节） |
| 诊断（第 7 节）；可行性探针（第 8 节） | 多成员同时切分同一版时层表的收敛、断网与重启等混沌项：M8 |
| 验收：E5、B2、承接 L1 的两条、W7 跨机（第 10 节） | HT-b、队列持久化：不在本阶段 |

## 2. 生命周期：何时当节点、何时让路

- **当节点的条件**（全部成立才开 render 连接）：
  - 在线构建且嵌了代码版本（`c10-browser` `src/online/buildInfo.ts` 的 `CODE_VERSION` 非空）；开发构建不当节点（D16）；
  - 普通档，两个跨源舞台都握上手（C10 第 2 节 `stageLayout`）；低内存档、退回同源单舞台的一律不当；
  - Chromium 内核（D14）；
  - 以成员身份连着放云端的共享项目（页面连接在线）；
  - 打开项目的测量已落定（加载遮罩撤下）。
- **上线**：父页开 render 连接（第 5 节）→ `node.hello`（`profile: 'browser'`，`maxConcurrent: 1`）→ `queue.watch { projects: [<项目 id>] }`（不许 `'all'`，`queue.mjs:519`）。
- **闲的判据 `isIdle()`**（父页判，舞台不判；C10 第 2 节）：
  - `backWorkGate` 判为开：页面可见、父页 rAF 间隔不持续超过 500 ms、父页 rIC 1 s 内回调过（`judgeBackWork`）；
  - 不在播放、不在拖动，且离上一次播放或拖动已过 `INTERACTION_QUIET_MS`（建议沿用桌面节点的 500 ms，`server/queue-idle.mjs`）；
  - 后台舞台单飞队列里没有更急的活（补跑、测量、探针）；
  - render 会话在。
- **让路**（语义「手里在做的那一批做完为止」，一批 = 一帧，C10 第 8 节；D8）：
  - 播放、拖动开始：不再认领；当前这一帧做完；随后 `task.release`（C2：不计失败）。已产的帧留在本页，重新认领到同一任务时只补缺的帧；
  - 更急的后台活来了（补跑、测量）：单飞队列的 abort 通知到，当前帧做完即停，放回同上；
  - 页面隐藏、父页 rAF 断档：不等当前帧，立即放回（隐藏页的计时器被节流，续约不可靠；c10-research Q4）。
- **下线**：离开项目、运行中改判低内存档（c10a 第 8 节 `webglcontextlost`）、双舞台退回单舞台、被踢（4003）、项目被删（4004）：放回全部、结束会话，4003 与 4004 不重连（HT-a）。`pagehide`：尽力放回并结束会话；来不及的由队列按宽限回收（`RECONNECT_GRACE_MS` 10 s）。
- **摆放与节拍**照 C10 第 2 节：后台舞台留在视口里 `opacity: 0`；舞台逐帧 `setTimeout(0)`，帧间查停止标志；舞台里不用 rIC。
- 界面不加后台提示（C10 第 8 节）；成员列表的「渲染中」标签照 `auth-contract.md` 第 7 节自然出现。

## 3. 认领什么：任务、环境指纹与锁

### 3.1 文档服务替节点挡掉的

- 只见本人：`source.userId === principal.userId`，`userId` 是「用户名@设备」（`auth-contract.md` 第 1 节）；认领别人的回 `forbidden`。
- 指纹前置过滤：只见 `requires.envFingerprint` 等于本节点指纹、且这张卡没锁在别的环境上的任务（契约 I.2）。
- plan 一律 `plan-profile`；`watch 'all'`、摘要订阅一律 forbidden。

### 3.2 节点自己挑的（`filterClaimable`，现有规则 0～6）

- 快照任务、`tier: 'shared'`、重度 `light` / `medium`；
- 不要转码、不是流；不是用户卡、图卡；`requires.cardSources` 为空（没改过的内置卡由 `codeVersion` 覆盖，契约 B.4 末）；
- `requires.codeVersion` 等于页面嵌入的代码版本；
- 建议另加浏览器自己的一条：只接独立卡（审阅表 `compositing: 'independent'`），切分方在给浏览器的那一份细任务里写 `input.compositing`（D4）。

### 3.3 任务怎样落到浏览器的环境（建议：D1 选项 d）

- 页面发布清单计划时，本页是可接活的纯浏览器节点，就在 `input.browser` 写 `{ nodeId, envFingerprint }`（`envFingerprint` 取 `node.welcome` 回的，第 5 节）。计划任务的 id 不变（`#clips:` 键只看清单）；清单计划的入站校验展开保留 `input` 的其它字段（`c10-browser` `server/render-queue/messages.mjs:174-179`）。
- 同 id 的计划已存在时，重复发布只合并订阅者、不改 `input`（契约 A.7.1）。所以页面等 render 会话报到完、拿到指纹，再发这一版的第一份清单计划；建议最多等 3 s（三级数字），超时照发不带意向，下一版计划再带。
- 认领清单计划的切分方（pc 或 host），对清单里浏览器可做的片段（共享档、medium、独立卡、非用户卡图卡、`cardSources` 为空、没锁在第三种环境上）：
  - 照旧按自己的指纹出一份细任务；
  - 再按浏览器的指纹出一份：结果键 = 内容键 × 浏览器指纹，`requires.envFingerprint` = 浏览器指纹，`input` 另带 `bake`（第 4.3 节）与 `compositing`；
  - 两份都带 `input.dual: true`，都不带 `takeover`。
- 谁先认领这张卡的任一段，谁得锁（`queue.mjs:760-763`）；另一份此后谁也认领不到（第 3a 步 `card-locked`；前置过滤撤回 `task.closed { state: 'hidden' }`）。
- 建议队列在认领建锁时，把同锁键、异指纹、`input.dual` 为真、还是 `open` 的任务作废（`failed: superseded`，照 `takeoverLock` 的收尾，`queue.mjs:343-369`；不发 `lease-lost`，它们没人认领），免得死任务堆到 `MAX_TASKS_PER_PROJECT`。不带 `dual` 的任务行为不变。
- 效果：宿主闲着就由它做，浏览器闲着也能抢，按卡分开，一层只出自一种环境；浏览器没认领就走了，切分方那一份照常接住。
- 其余照旧：已锁在别的环境上的卡按锁出键（契约 F.2、F.7）。
- （原有一条「可选优化：复用测量时推过的帧」，已删：探针 P2 实测测量快照趟每张卡只产出 0～1 帧，见第 13 节「探针之后的更正」第 9 条。）

### 3.4 锁闲置接手（建议：D2）

- 队列在 `card-locked` 的发布回包与认领回包里另带 `lockIdleMs`（此刻减 `touchedAt`）与 `lockedByProfile`。
- pc、host 切分时：`lockIdleMs > CARD_LOCK_IDLE_MS`（30 s，与本机锁库同一个数，`server/card-lock.mjs`）就带 `takeover` 按自己的指纹重发（给 `local-node.mjs` 的 `takeoverLocked` 传判定函数）。
- 建议续约（`task.progress`）也刷新 `touchedAt`：一段 60 帧的重卡在浏览器上要几秒到几十秒（M7 探针 P1 实测：每帧烧 40 ms 的推帧卡顺推约 3 s；Lottie 约 50 s 且每帧超 300 KB 被丢弃，这类卡不派给浏览器，见第 13 节「探针之后的更正」第 6 条），产出中不该被判闲置。
- 限制：接手只在有人重新切分时发生（有页面或编辑器发布新计划）。没人发布时，锁在走掉的浏览器身上的卡一直缺。M7 接受并写进报告，M8 混沌项复测。
- **页面只是忙不算闲置**〔裁，2026-09-30，`claude/queue-maint`，报告 `docs/reports/AGENT-queue-maint.md` 任务 D〕：M7 实测（`REPORT-M7.md` 第 4 节第 7 条、第 11 节第 1 行）页面锁着卡 h1、手里在做别的锚帧段（经公网慢），这张卡 30 s 没有产出就被 pc 接手，已做的帧白费。只看产出分不出「页面还在、只是忙」与「页面走了」。改法（三级，形状向后兼容）：
  - `node.welcome` 多带 `activeIntervalMs`（10 s，`NODE_ACTIVE_INTERVAL_MS`，三级数字，须明显小于 30 s）；
  - 新的节点消息 `node.active { busy?: string ≤ 32 字 }`，不回包：页面手里有认领（`busy: 'bake'`）或后台舞台单飞队列里有更急的活（补跑、测量、探针，`'stage'`）时按间隔发；闲着、页面隐藏或父页 rAF 断档、只是在播放或拖动而后台没活时不发；
  - 队列的锁记下最后为它产出（认领、续约、完成）的节点。回包的 `lockIdleMs` 改为「此刻减锁定方最后一次产出**或报忙**」：那个节点此刻连着、指纹仍是锁上的、报过 `node.active` 时，取它的 `activeAt` 与最后一次产出里晚的那个；断开（宽限期内也算断开）、停报、从没报过（旧页面）就只看产出，与改前相同。切分方的判定（`idleLockTakeover`）不改；
  - 向后兼容：旧队列不带 `activeIntervalMs`，新页面一条也不发；旧页面不发，新队列按产出算，同改前；旧切分方读的还是 `lockIdleMs`，照样受益。别的节点（同指纹的另一个页面、别的用户）报忙不作数。
  - 语义措辞建议（三级，未写，交主会话定）：见报告任务 D 的 dry run。

### 3.5 顺序与并发

- `maxConcurrent: 1`；挑选照 `pickCandidate`（normal 档；锚帧段 `priority` 50 先于 10，`split.mjs`）。

## 4. 执行：生成快照、交父页、推送、清单、完成

### 4.1 开工

- 认领到就 `progress(0)`（照 `local-node.mjs:266`：停滞规则要覆盖卡死的执行器）。
- 去重：按 `<resultKey>:<from>-<to>` 查内容库清单；清单在、覆盖整段、每块 `GET snap/<hash>/chunks` 都 complete，就直接 `complete`（带清单、`dedup: true`；照 `createAssetSink.has`，`artifact-transfer.mjs:577-604`）。

### 4.2 取项目（D6）

- 用任务 `source.projectRev` 那一版。纯浏览器只见本人的任务，这些任务都出自本页发布的清单计划，所以：
  - 页面发布清单计划时，把当时的已确认版本（`DocSync` 的 `confirmed`）按版本号留在内存，建议最多 4 版（同执行器的 `PLAN_CACHE_SIZE`）；
  - 没有就 `project.snapshot.get`；
  - 还没有就放回（`reason: 'no-snapshot'`）并记诊断。不拿别的版本渲。

### 4.3 生成快照（后台舞台；D3 建议选项 i）

- `stageJobs` 加第四种活 `bake`，最不急：补跑 > 测量 > 探针 > 生成快照；RPC 工作项用早留的 `'bake'`。
- 新 RPC `bake({ project, clipId, from, to, fps })`，舞台做：
  - 载入**隔离单卡工程**，与桌面 `isolatedCardProject` 同一变换。建议把这个函数挪进页面与服务端共用的纯模块，桌面改引它（G0-R 守住输出不变）；它要的 `start`、`end`、`count`、`sampling` 由切分方写在浏览器那一份的 `input.bake` 里，页面不算 `cardSampling`；
  - 推帧口径：逐帧顺推（探针 P2 证明 DOM、Motion 独立卡与桌面 4 帧一批从头推等价、便宜 4～7 倍；画布卡不等价，不进浏览器）；每帧先过与 `waitFrameReady` 相同的就绪闸，超时这一段 `fail`，不出空白帧（第 13 节「探针之后的更正」第 2、3 条）；
  - 不受一拍预算截断；帧间查停止标志（`backGate`）；`setTimeout(0)` 逐帧；
  - 每帧生成快照，取本控件的 `html`；有读不出像素的画布（`lossy`）这一段 `fail`（不可重试，同 `server/bakery/bake.mjs:225`）；
  - 每帧发事件 `bake-frame { clipId, localFrame, hash, bytes, htmlGz, small? }`：`hash` 是原始 HTML 字节的 sha256（舞台里用 WebCrypto 算），`htmlGz` 随消息转移。
- 舞台互换（K5）时生成快照跟着后台位置走：互换前单飞队列已让补跑先行、生成快照停在帧边界；互换后在新的后台舞台上重开，做到哪一帧记在父页。
  - 〔裁，2026-09-30，`claude/queue-maint` 任务 F〕互换剧本 `src/editor/stageBake.test.mjs`（QM-F-01～05）查出：一帧**在飞时**后台位置换了人（没有补跑先行的互换、iframe 重载、补跑刚完就开出的活），旧舞台回 `cancelled` / `role`，或帧做完了而 `bake-frame` 事件在互换后才到、被按角色滤掉，宿主原来按可重试失败交回（计一次失败）。改为：后台位置确实换了人就在新后台上重灌、重做这一帧，每帧最多 2 次（`SWAP_REDO_MAX`，三级数字），不计失败；没换人照旧交回失败。活与每帧的舞台往返从 `browserNodeHost.ts` 拆到 `src/editor/stageBake.ts`（行为不变，只多这一条）。

### 4.4 小尺寸（D5 建议选项 a）

- 舞台把这一帧的 HTML 快照按 `smallScale`（等比缩进 800×600 以内，`small-bitmap.mjs`）包进 SVG `foreignObject`，以 `data:` 地址画上画布，出 WebP（质量 80，c10a 第 9 节）。原尺寸 HTML 不变。
- `foreignObject` 里必须内嵌页面的全局样式表（快照省略的属性靠它补）。外部字体在这条路上会退回系统字体，只影响用户卡（内置卡只用系统字体，用户卡不进浏览器）；带样式表之后内置卡与桌面 CDP 截的小位图差 ≤ 0.9% 像素（探针 P3，第 13 节「探针之后的更正」第 5 条）。

### 4.5 父页

- 收到 `bake-frame`：块进页面内快照库（`snap/<hash>`，小尺寸 `px/<hash>`）；推素材服务（`chunks` → `PUT …/0` → `complete`，`Authorization: Bearer <写票据>`）；`progress(done)`。
- 全段齐后组清单，形状同 `collectSnapshotResult`：`v: 1`、`kind: 'snapshot'`、`tier: 'shared'`、`resultKey`、`dirKey = resultKey`、`entryKey: null`、`range`、`canvasHeavy`、`frames: [[localFrame, hash, bytes]]`，有小尺寸就带 `small`；≤ 256 KiB。超体积的帧（DOM 300 KB、画布位图 1 MB）照桌面列进清单，由拉取方判。
- 写内容库 `content.put('snapshot-manifest', '<resultKey>:<from>-<to>', 清单)`；失败只记日志（同 `writeManifest`）。
- `task.complete { ranges: [[from, to]], ...清单 }`。
- 自产的层：页面内快照库写 `ranges`、通知在线来源（层表见 D12）。
- 推送放在父页还是舞台：建议父页（D7）；验收加「生成快照期间主文档长任务 0」。

### 4.6 出错与丢认领

- 推块或写清单失败：`fail`（可重试）；项目取不到：放回。
- 收到 `task.lease-lost`：中止舞台这次生成快照、丢弃结果；已推的块不回收（按内容寻址，下一个认领者去重时用得上）。

## 5. 凭证与传输

- **render 连接**由父页开（不放舞台里：舞台会互换角色），地址与页面连接相同（`/hosted/`）。
  - `protocols()`：每建一次会话，向页面连接签一张 `auth.ticket { kind: 'conn', role: 'render' }`，交 `ticketProtocols(票据)`；票据 2 分钟有效，所以每次现签；页面连接不在就不建。
  - 会话层 `createDocEndpoint`：保留期内传输断开就接续，不重交凭证、不重发 `hello.resume`；新会话在 `onOpen` 里发 `node.hello`（带手里的 `resume`）与 `queue.watch`（`http-transport-contract.md` 第 4.4 节）。
  - 回显只回 `promptcut.v1`；票据不进地址、日志、诊断（`auth-contract.md` 第 5 节；c10-research Q5）。
- **身份**：票据的 `u` 就是页面的 `userId`；成员列表同一行多一个「渲染中」。
- **profile 与凭证绑定**（建议：D9）：
  - 页面签 render 票据时带 `owner: { kind: 'browser' }`（`auth-contract.md` 第 5、8 节加一种归属）；
  - 队列模块见到这种连接：`node.hello` 的 `profile` 不是 `browser` 回 `forbidden`；
  - `nodeId` 第一次报到后绑到这个 `userId`，别的 `userId` 拿同一个 `nodeId` 报到回 `forbidden`。
- **环境指纹**（建议：D10）：`node.hello` 带原始值 `environment: { platform, userAgent, renderer, vendor }`（`pageEnvironment()`）；队列模块按 `describeEnvironment` 算指纹、写进节点记录，`node.welcome` 回 `envFingerprint`；页面不自己算（与测量帧入库路由同一做法）。
- **写票据**：`auth.ticket { kind: 'asset', access: 'rw' }`，15 分钟，剩 1/3 续（复用 C10 的 `createTicketRenewer`）；401 换一张重试一次。
- **页面用到的 server 模块**要浏览器可用：`session.mjs` 改从 `constants.mjs` 引常量；细任务执行的编排见 D11。

## 6. 与桌面节点、独立渲染主机共存

- 切分只由 pc、host 做。没有能切分的节点在线时，清单计划等着，纯浏览器不干活、不报错（C10 第 7 节）。
- 别人的 pc、host：看得见本项目全部任务（D9 第 6 条），前置过滤挡掉浏览器指纹那一份；按 3.3 各做各的那一份，谁先谁得卡。
- 同一用户的桌面版与在线页面：设备不同，`userId` 就不同。桌面节点可以做在线页面发布的任务；在线页面的纯浏览器节点做不了桌面发布的任务。
- 桌面拉浏览器产的结果：照 `applyResult` 落本机帧库；清单里没有 PNG，`?preview=legacy` 下这一层是占位（M6c X7 的已知限制）。
- 一层只出自一种环境：由卡片级指纹锁保证。桌面的本机锁库与队列锁是两本账；桌面在队列模式下按发布回包的 `lockedBy` 重切（F.7），本阶段不另改。
- 优先级：两份都在 normal 档，锚帧段 50、其余 10。

## 7. 诊断

- 页面：
  - `__pcBrowserNode()`：`state`（`off` / `idle` / `busy` / `baking`）与原因、`nodeId`、`envFingerprint`、`codeVersion`、持有的任务；
  - 计数：认领、完成、去重、放回（按原因：让路、隐藏、更急的活、取不到项目）、失败、丢认领、生成快照帧数与每帧耗时 p50 / p95、推了几块、跳过几块、推了多少字节、小尺寸几帧；最近一次错误；
  - `backWorkDiag()`、`planPublisher.debug()` 照旧。
- 舞台：`bake` 的逐帧耗时；被门挡住的时长单记，不算进耗时（同 C10 的 `pausedMs`）。
- 文档服务：`describe()` 的节点记录带 `profile: 'browser'` 与认领数；日志 `role.node` 带 `userId`；`/healthz` 的节点数。票据原文一律不出现。

## 8. 可行性探针（建议先于实现，分支 `claude/m7-probe`）

照 C10 的做法（`claude/c10-probe`），先答下面几问再定稿：

| 编号 | 问题 | 怎么判 |
|---|---|---|
| P1 | 后台舞台生成快照隔离单卡工程的节拍与隔离：三种卡（Motion 卡、重的推帧卡、canvas 卡）每秒几帧；主文档长任务 | 同站跨源 + OAC 下主文档长任务 0；记每秒帧数 |
| P2 | 浏览器生成的快照帧对不对：同一张 DOM 独立卡、同一 Chrome 主版本，舞台生成快照与预渲染间生成快照的 HTML 比；与活渲截图比；逐帧顺推与 4 帧一批从头推比 | DOM 卡的 HTML 逐字节相同，或差别能逐条解释 |
| P3 | `foreignObject` 出小尺寸：与 CDP 截的小位图比；画布污染；每帧耗时 | 不污染；差别量化 |
| P4 | 页面上传一段（60 块 + 60 小尺寸）：WebCrypto 哈希、分片接口、耗时、主文档长任务 | 长任务 0；记耗时 |
| P5 | 真 Chrome 里 `visibilitychange`、页面被浏览器挂起（frozen）对续约与会话的影响（C10 探针 P2 留下的未证实项） | 隐藏后多久停；放回是否及时 |
| P6 | `session.mjs` 改 import 前后 `vite build --mode online` 能不能构建 | 改后能构建 |

## 9. 分支与端口（建议）

| 分支 | Agent | 内容 | 端口段 |
|---|---|---|---|
| `claude/m7-probe` | `opus-dev` | 第 8 节 P1～P6；报告 | 5710～5719 |
| `claude/rq-m7-queue` | `opus-dev-high` | 队列与切分方：`input.browser` 的双份出键、建锁时作废 `dual` 死任务、`lockIdleMs` / `lockedByProfile`、续约刷新 `touchedAt`、`takeoverLocked` 判定；层表按实际出键（D12）；指纹由队列模块算（D10）；profile / nodeId 与凭证绑定（D9）；`session.mjs` 的 import；`isolatedCardProject` 挪进共用模块 | 5720～5729 |
| `claude/rq-m7-node` | `opus-dev-high` | 页面：节点编排、render 连接与票据、闲时判据与让路、项目版本留存、上传器、清单、页面内快照库；舞台：`bake` 工作项与 RPC、小尺寸；诊断 | 5440～5449 |
| `claude/rq-m7-tests` | `opus-dev` | 照本契约独立写 M7-T 与探针 `m7-browser-probe`，不看实现 | 5450～5459 |

- 5440～5449、5450～5459 是主计划第 7 节 M7 行给的；5710～5729 在第 9 节没有分配过，`docs/plan`、`scripts`、`server/test` 里都 grep 不到。集成与 G0-R 由主会话在 5690～5699 做。
- 主计划 M7 行原写两个分支、都用 `opus-dev`；上表把服务端拆出来，是为了队列与页面两边文件不重叠；执行器与协议改动是核心难点，所以用 `opus-dev-high`。

## 10. 验收

G0 + G0-R（改了预渲染与快照路径）；桌面导出像素基线不变。环境是纯浏览器：本机用托管组合加同形代理与两个跨源舞台（C10 探针那一套），部署后在阿里云外网复验。带耗时门槛的项在笔记本判（`guide_files/verification.md`「性能基准机」）。

| 编号 | 标准 |
|---|---|
| M7-A1 | E5 分发：成员 B 的纯浏览器节点在 A 一整轮发布、切分、完成期间，收到 A 的任务消息 0 条（`queue.snapshot`、`task.opened`、`task.taken`、`task.closed`）；B 用与 A 同名、不同设备进入时同样 0 条 |
| M7-A2 | E5 认领：B 的节点拿 A 的任务 id 认领一律回 `forbidden`（不带 state）；认领 plan 回 `plan-profile`；D9 做了的话，B 以 `pc` 报到回 `forbidden` |
| M7-A3 | B2：本人任务里各放 heavy 快照、流、plan、本地档、用户卡、改过源码的卡若干，跑满 60 s：这些被纯浏览器认领 0 次；light / medium 共享档照常认领并完成 |
| M7-A4 | 承接 L1（笔记本判）：新项目、10 秒时间轴、3 张没被预渲染过、实测为重的独立内置卡〔裁：原写「3 张重 Motion 卡」；Motion 卡在快机器上会判轻、不产任务，验收探针 `claude/m7-accept-probe` 查出，主会话 2026-09-28 改述〕；能切分的节点在线；页面可见且空闲。从加载遮罩撤下起 30 秒内，3 张卡的锚帧段都由纯浏览器认领并完成：`snap/` 块在素材服务、清单在内容库、页面内快照库有条目、层表指向浏览器指纹（D15） |
| M7-A5 | 承接 L1：生成快照中开始连续拖动 3 秒：拖动开始后发出的 `task.claim` 0 条；拖动开始后新完成的帧 ≤ 1；那一帧之后放回 1 次、`attempts` 不变；拖动期间页面内快照库不再新增生成快照产出的块；停下超过 500 ms 后恢复认领 |
| M7-A6 | 让路的其余情形：播放同 A5；页面隐藏后立即放回、隐藏期间认领 0 次，回到前台后恢复；补跑来了生成快照停在帧边界 |
| M7-A7 | 低内存档不当节点：低内存档页面整场开 render 连接 0 条、`node.hello` 0 条；退回单舞台的普通档页面同样 0 条 |
| M7-A8 | 产物互通：浏览器产的清单过 `manifestMatches`；桌面成员经 `applyResult` 取回并显示；同一层所有帧的指纹相同，没有一层混两种环境；每个任务恰好一次 `task.done`（作废的不算） |
| M7-A9 | 小尺寸：浏览器产的每一帧都有 `px/` 的 WebP；低内存档页面对这些层贴小尺寸，不显示占位（D5 选 a 时） |
| M7-A10 | 共存与接手：宿主全开时两份任务谁先谁得卡、每张卡只出自一种环境；浏览器认领一段后关掉页面，下一次有人发布计划、锁闲置超过 30 s 后，pc 或 host 接手整张卡，页面整层换键 |
| M7-A11 | 凭证：握手只回显 `promptcut.v1`；票据不出现在地址、服务端日志、`describe()`；render 票据过期后重建会话照常 |
| M7-A12 | 主文档：生成快照期间主文档长任务 0；播放 10 秒期间认领 0 次、主文档长任务 0（C10-A1 回归） |
| W7 | 跨机（第 6.5 节；云端已归档）：PC 主会话以用户 A 建放云端的项目并发布（桌面版或在线页面），笔记本上的 Chrome（或 PC 上另一个浏览器配置文件）以成员 B 进入当纯浏览器节点：M7-A1、A2、A3 过；M7-A4 的计时在笔记本判；原始输出贴进报告 |
| 通用 | G0 + G0-R；桌面导出像素基线不变 |

## 11. 待定点

每条：问题｜选项｜建议与理由｜语义级别。

- **D1 任务怎样落到浏览器的环境**
  - 问题：切分方只按自己的指纹出键，纯浏览器看不见任何任务（第 0 节第 11 行）。
  - 选项：(a) 清单计划带浏览器意向，切分方只按浏览器指纹出这些卡；(b) 语义原有的路：测量帧入库、`card.lock` 锁到浏览器环境，再照锁出键；(c) 放宽前置过滤，让浏览器看见本人的异指纹任务、认领时自己接手；(d) 切分方双份出键，先认领者得卡（第 3.3 节）。
  - 建议 (d)。理由：(a) 下这些卡只有浏览器能做，用户一播放就没人产、宿主闲着，还要另做「浏览器不来就收回」；(b) 页面在切分前拿不到内容键（页面不算键，Q1），推测量帧总晚于切分方的第一次认领，基本抢不到，且只覆盖独立卡；(c) 要改三级语义「指纹前置过滤」，要页面算结果键，还会打断别的节点正在做的活。(d) 保持拉取式与「最先产出的环境锁定」，宿主与浏览器按卡分活，浏览器走了也不卡。代价：任务数翻倍（只限浏览器可做的卡）；要在建锁时作废 `dual` 死任务；层表要能表达两个候选（D12）。
  - 级别：计划级（设计 2.1「没被锁的卡按自己的指纹出键」加一个例外；契约 F.1 建锁时的收尾）。语义不改。
- **D2 队列锁闲置接手**
  - 问题：队列锁没有闲置接手；浏览器认领后走掉，这张卡别的环境永远接不了。
  - 选项：(a) 回包带 `lockIdleMs` / `lockedByProfile`，pc、host 切分时闲置超 30 s 就带 `takeover` 重发，续约也刷新 `touchedAt`；(b) 另加：浏览器节点断开、同指纹再无节点在线时，队列删它建的锁；(c) 不做。
  - 建议 (a)，(b) 留到 M8 看需要。理由：(a) 是让代码向已写好的三级语义靠（「锁定方已经有一段时间没有再产出，就用自己的指纹接手整张卡」），数字沿用本机锁库的 30 s；(b) 改队列的记账规则更多。
  - 级别：三级（语义已写，代码补齐）；30 s 是三级数字。
- **D3 生成快照在哪儿跑**
  - 选项：(i) 后台舞台（StageView）加 `bake` RPC（`cloud-task.md` L1 原设计、J4 早留的 `'bake'`）；(ii) 在后台舞台的进程里嵌一个导出页（与预渲染间同一页、同一套推帧，`frameCompositor.ts` 已移植到浏览器）；(iii) 第三个源的专用 iframe。
  - 建议 (i)，P2 不过再退 (ii)。理由：C10 第 2 节已定后台舞台兼做认领；跨源舞台在独立进程，不卡编辑界面；桌面已接受页面舞台测出的独立卡帧当预渲染结果。(ii) 与桌面同一页、最稳，但每次互换都要重开一个应用文档；(iii) 要新子域、证书和第三个进程的内存。
  - 级别：三级（`mechanism/rendering.md`「舞台」要加一句后台舞台在在线模式下兼做节点，见 D18）。
- **D4 浏览器可做的卡的范围**
  - 选项：(a) 共享档 medium 全收（含 sourceDependent）；(b) 只收独立卡。
  - 建议 (b)。理由：桌面只把独立卡的页面测量帧当预渲染结果（`NOT_INDEPENDENT`）；sourceDependent 的帧取决于素材逐帧定位，浏览器与预渲染间对齐与否未证实。
  - 级别：计划级（比二级「只认领……快照任务」更窄，属节点自选）。
- **D5 预渲染小尺寸由谁产**
  - 选项：(a) 浏览器用 `foreignObject` 栅格化原尺寸快照、出 WebP；(b) 浏览器只推原尺寸，小尺寸由 pc、host 补（C10 推迟的「已有产物补小尺寸」提前做）；(c) 浏览器产的层不给小尺寸，低内存档对它显示占位。
  - 建议 (a)。理由：二级语义要求「渲染节点产出原尺寸后一并生成小尺寸，两档都推送到素材服务」（`product/rendering.md`「两档」），完成条件也要求两档（c10a 第 9 节）；(a) 不改语义，差别只在外部字体，P3 量化。(b)、(c) 都要改二级。
  - 级别：二级（选 b、c 要按「对齐」走：二级最小修改、当场播报、用户审）。
- **D6 执行用哪一版项目**
  - 选项：(a) 用任务的 `projectRev`：页面留存自己发布计划时的已确认版本，取不到再 `project.snapshot.get`，都不行就放回；(b) 用页面当前版本。
  - 建议 (a)。理由：页面算不了内容键，没法像桌面那样把任务对回 control；用同一份 JSON 才能保证生成的快照帧配得上任务的键。(b) 在片段改过之后会把新内容写到旧键下，污染所有节点的去重。
  - 级别：计划级。
- **D7 推送在父页还是舞台**
  - 选项：(a) 父页（主文档）推；(b) 舞台推到自己源上的 `/media`，写票据经 RPC 下发。
  - 建议 (a)。理由：页面已有票据与请求的全套；哈希、解压、上传都是异步；字节反正要回父页进页面内快照库。(b) 要把写票据交给舞台，并让两个舞台子域的 nginx 放行写入。验收用 M7-A12 盯主文档长任务，超了再改 (b)。
  - 级别：三级 / 计划级。
- **D8 让路的细则**
  - 选项：(a) 当前帧做完就放回；(b) 当前帧做完就暂停、保持认领。
  - 建议 (a)，隐藏时不等当前帧。理由：保持认领时续约照发、进度不动，长播放超过 `STALL_MS`（120 s）会被判停滞、计一次失败，三次进 `failed`；放回不计失败（C2）。设计 4.4 也写「做完当前这一批就 `task.release`」。
  - 级别：二级措辞「手里在做的那一批做完为止」照做；放回的细则属三级。
- **D9 profile 与 nodeId 是否绑到凭证**
  - 问题：`profile` 与 `nodeId` 都是自报，页面自称 `pc` 就能看见并认领同项目所有成员的任务。
  - 选项：(a) 维持自报；(b) render 票据带 `owner: { kind: 'browser' }`，队列模块按它固定 profile、把 nodeId 绑到 userId。
  - 建议 (b)。理由：语义写的是「这两条都由文档服务保证，不靠节点自己过滤」；(b) 让边界落在凭证上，诚实页面的代码出错也越不过去。它挡不住恶意成员另开桌面版，但那本来就是成员的权限。
  - 级别：二级（语义符合度）；实现是计划级（`auth-contract.md` 加一种归属）。
- **D10 浏览器的环境指纹谁算**
  - 选项：(a) 页面报原始值，队列模块按 `describeEnvironment` 算，`node.welcome` 回给页面；(b) `fingerprint.mjs` 改用 `server/auth/pure.mjs` 的 sha256 变成同构，页面自己算。
  - 建议 (a)。理由：守住「页面只报原始值，归一规则只有一处」（`pageEnvironment.mjs`），与测量帧入库路由同一做法；(b) 要动桌面全部键的热路径。
  - 级别：计划级。
- **D11 节点代码怎样进页面**
  - 选项：(a) `session.mjs` 改一行 import；把 `local-node.mjs` 里细任务那一段抽成不引 `split.mjs` 的同构模块，桌面与页面共用；(b) 只改 `session.mjs`，页面另写细任务编排；(c) 同构整理全部（`queue.mjs`、`fingerprint.mjs`、`content-client.mjs` 都去掉 `node:crypto`），页面直接用 `createLocalNode`。
  - 建议 (a)。理由：细任务的规矩（先报 0、去重、丢认领丢结果、放回）只写一处；(c) 牵动桌面键的哈希。
  - 级别：三级 / 工程。
- **D12 层表与实际出键一致**
  - 问题：层表每层只有一个结果键；主机在切分前按本机视图写，重切与双份出键之后对不上，页面会去找没人产的键。
  - 选项：(a) 层表每层带候选（切分方自己的、浏览器的），页面按 `task.done` 与清单认定哪一份活着，此后只用那一份；(b) 切分方在发布回包之后按最终出键重写层表；(c) 层表按片段拆成多条，由完成的节点写自己那一层。
  - 建议 M7 做 (a)，并在 (b) 的时机写（切分完成后写一次）；(c) 留到 M8 看多成员并发。
  - 级别：计划级（C10 契约第 5 节、第 18 节第 3 条的层表 v 2 升 v 3）。
  - 补充〔裁，2026-09-29 stale-layer〕：v 3 的层可另带 `inputSig`（生成这一层的片段输入的签名），页面对不上就不贴这一层；不升版本号，见 C10 契约第 9 节「旧参数的层」、第 18 节 2026-09-29 那一条。
- **D13 同键任务的归属**
  - 问题：任务 id 按内容定，先建的人的 `userId` 留在任务上。别的成员先切出同一个键的任务，本人的纯浏览器就认领不了，哪怕本人的计划也要它。
  - 选项：(a) 维持 Q2（按 `source.userId`）；(b) 队列记「请求过它的用户集合」，纯浏览器按集合判。
  - 建议 M7 维持 (a)，把情形写进报告；(b) 要改用户定过的 Q2，先问用户。
  - 级别：二级（「当前登录用户自己产生的任务」的读法）。
- **D14 非 Chromium 内核的浏览器**
  - 问题：`chromeMajorOf` 对 Firefox、Safari 都得 5，指纹相撞，两种引擎的帧可能拼进同一层。
  - 选项：(a) 一期只在 Chromium 内核当节点；(b) 指纹加引擎与主版本。
  - 建议 (a)。理由：用户看不出区别（没有节点界面），也不动三级指纹定义；(b) 会让全部键再换一次。
  - 级别：三级（指纹定义在 `mechanism/rendering.md`）。
- **D15 承接 L1 的 30 秒验收口径**
  - 问题：选 D1 (d) 后，宿主在线时多半抢先，验收里浏览器可能一张卡都没做。
  - 建议：计时起点是加载遮罩撤下；夹具照 `cloud-task.md` L 节「3 张重 Motion 卡」；切分方用只在测试里开的开关只切分、不认领细任务（如 `PROMPTCUT_TEST_PLAN_ONLY=1`，生产不设），另跑一轮宿主全开验 M7-A10；在笔记本判。
  - 级别：计划级。
- **D16 开发构建没有代码版本**
  - 问题：`CODE_VERSION` 只在在线构建里有；开发构建报不出 `codeVersions`，带 `codeVersion` 的任务一个都认领不了。
  - 建议：开发构建不当节点；本机验收一律用 `vite build --mode online` 的产物，与渲染节点同一份源码。
  - 级别：计划级。
- **D17 W7 的角色**
  - 问题：云端已归档。
  - 建议：PC 主会话当用户 A（建项目、发布、跑宿主）；笔记本辅助节点的 Chrome 当成员 B（它也是性能基准机，M7-A4 的计时在那里判）；笔记本不在线时，用 PC 上另一个浏览器配置文件当 B（设备不同即另一身份）作本机替身，真跨机记待复核。
  - 级别：计划级。
- **D18 三级语义措辞**
  - 问题：`mechanism/rendering.md`「舞台」只写后台舞台测量与补跑；`mechanism/platforms.md`「渲染节点」没写纯浏览器的指纹与内核限制。
  - 建议：定计划时 dry run 给用户：「舞台」加「在线浏览器模式下，后台舞台在闲时生成快照认领到的快照任务」；「渲染节点」加「纯浏览器节点的环境指纹由文档服务按页面报的原始值算；一期只在 Chromium 内核的浏览器上当节点」。
  - 级别：三级（定计划时先 dry run，用户确认后写）。

## 12. 结论

前置不齐。队列与凭证的零件大多在：`profile: 'browser'` 的两层用户把关（分发与认领）、B2 的节点侧策略、render 角色与连接票据子协议、HT-a 会话层都已在 main；后台舞台的摆放与节拍、页面内快照库、清单计划与层表 v 2 在 C10 分支上。缺四样：① 任务落不到浏览器的环境——切分方只按自己的指纹出键、页面的计划不带指纹，指纹前置过滤之下纯浏览器今天一个任务也看不见；队列锁也不会因闲置被接手（D1、D2）。② 页面里没有执行器——没有生成快照 RPC、页面上传器、清单组装、小尺寸生成，节点模块进页面还要改一处 import（D3、D5、D7、D11）。③ 浏览器的环境指纹与 profile 没有落到凭证上，非 Chromium 浏览器的指纹会撞（D9、D10、D14）。④ C10 本身未合入 main：`c10-browser` 还没合进集成分支，C10-A4 没过，而 M7 与它共用后台舞台的互换与单飞队列。建议 C10 合入 main 后开工：先派可行性探针 `claude/m7-probe`（`opus-dev`，5710～5719）答 P1～P6，再定稿；实现分三个分支——`claude/rq-m7-queue`（`opus-dev-high`，5720～5729：队列与切分方、层表、指纹与凭证绑定）、`claude/rq-m7-node`（`opus-dev-high`，5440～5449：页面节点、render 连接、舞台生成快照、上传与清单）、`claude/rq-m7-tests`（`opus-dev`，5450～5459：照契约独立写测试与探针）；集成与 G0-R 由主会话在 5690～5699 做，带耗时门槛的 M7-A4 与 W7 在笔记本判。

## 13. 主会话裁定（2026-09-28，PC 主会话）

第 11 节各待定点的「建议」逐条审过，裁定如下〔裁〕。理由见第 11 节对应条目，这里只写结论与补充。

| 待定点 | 裁定 | 补充 |
|---|---|---|
| D1 任务怎样落到浏览器的环境 | 取 (d)：切分方对浏览器可做的卡按两种指纹各出一份，先认领者得卡、建锁时作废另一份 | 计划级：设计 2.1「没被锁的卡按自己的指纹出键」加这一个例外；语义不改 |
| D2 队列锁闲置接手 | 取 (a)：回包带 `lockIdleMs` / `lockedByProfile`，闲置超 30 s 切分方带 `takeover` 重发，续约也刷新 `touchedAt`；(b) 留到 M8 | 三级：代码向已写好的语义靠；30 s 是三级数字 |
| D3 在哪儿生成快照 | 取 (i)：后台舞台加 `bake` 工作项；探针 P2 不过再退 (ii) | 桌面只认独立卡的页面测量帧当预渲染结果，与 D4 一致 |
| D4 浏览器可做的卡 | 取 (b)：只收独立卡 | 比二级「只认领……快照任务」更窄，属节点自选 |
| D5 预渲染小尺寸由谁产 | 取 (a)：浏览器用 `foreignObject` 把原尺寸快照栅格化成 WebP | 不改二级语义（两档都由产出方推）；与桌面 CDP 截的差别由探针 P3 量化，写进报告 |
| D6 执行用哪一版项目 | 取 (a)：用任务的 `projectRev`；页面留存发布时的已确认版本，取不到再 `project.snapshot.get`，都不行就放回 | 计划级 |
| D7 推送在父页还是舞台 | 取 (a)：父页推 | 验收 M7-A12 盯主文档长任务，超了再改 (b) |
| D8 让路的细则 | 取 (a)：当前帧做完就放回；页面隐藏时不等当前帧 | 二级措辞「手里在做的那一批做完为止」照做，放回细则属三级 |
| D9 profile 与 nodeId 绑到凭证 | 取 (b)：render 票据带 `owner: { kind: 'browser' }`，队列模块据此固定 profile、把 nodeId 绑到 userId | 让「纯浏览器只见本人任务」落在文档服务上（语义「由文档服务保证」）；`auth-contract.md` 加一种归属 |
| D10 浏览器的环境指纹谁算 | 取 (a)：页面报原始值，队列模块按 `describeEnvironment` 算，`node.welcome` 回给页面 | 归一规则只有一处 |
| D11 节点代码怎样进页面 | 取 (a)：`session.mjs` 改从 `constants.mjs` 取常量；细任务编排抽成不引 `split.mjs` 的同构模块，桌面与页面共用 | 工程；桌面键的哈希路径不动 |
| D12 层表与实际出键一致 | 取 (a)：层表每层带候选（切分方自己的、浏览器的），页面按 `task.done` 与清单认定哪一份活着；在切分完成后写一次（(b) 的时机）；(c) 留到 M8 | 层表 v 2 升 v 3；读旧 v 2 的页面当「一个候选」处理 |
| D13 同键任务的归属 | 维持 (a)（用户定过的 Q2，按 `source.userId`），情形写进报告 | 要改须先问用户，本阶段不改 |
| D14 非 Chromium 内核的浏览器 | 取 (a)：一期只在 Chromium 内核的浏览器上当节点 | 三级；用户看不出区别 |
| D15 承接 L1 的 30 秒验收口径 | 照建议：计时起点是加载遮罩撤下；夹具照 `cloud-task.md` L 节「3 张重 Motion 卡」〔裁：改为「3 张实测为重的独立内置卡」，见第 10 节 M7-A4〕；切分方用只在测试里开的开关只切分、不认领细任务（`PROMPTCUT_TEST_PLAN_ONLY=1`，生产不设；已实现：pc 节点的节点描述带 `planOnly`，节点侧过滤规则 8，`server/vite-plugin-frames.ts`），另跑一轮宿主全开验 M7-A10 | 带耗时门槛，在笔记本（性能基准机）判 |
| D16 开发构建没有代码版本 | 开发构建不当节点；本机验收一律用 `vite build --mode online` 的产物，与渲染节点同一份源码 | 计划级 |
| D17 W7 的角色 | PC 主会话当用户 A（建项目、发布、跑宿主）；笔记本辅助节点的 Chrome 当成员 B（兼性能基准机）；笔记本不在线时用 PC 上另一个浏览器配置文件当 B 作本机替身，真跨机记待复核 | 云端已归档（用户 2026-09-28 定），不再列 |
| D18 三级语义措辞 | 按下面的「修改前 / 修改后」dry run 发给用户，不等；M7 合入 main 时写进语义，用户有异议就改回 | 三级 |

**D18 的 dry run**（三级，`docs/semantics/mechanism/`）：

1. `mechanism/rendering.md`「舞台」：
   - 修改前：「**后台舞台**：负责测量卡片成本，以及为只能靠全局时钟推进的卡整场景补跑，补跑完与可见舞台互换。」
   - 修改后：「**后台舞台**：负责测量卡片成本，以及为只能靠全局时钟推进的卡整场景补跑，补跑完与可见舞台互换。在线浏览器模式（普通档）下，它还在闲时为认领到的快照任务逐帧生成快照。」
2. `mechanism/platforms.md`「渲染节点」，在现有一条之后加一条：
   - 修改前：（无）
   - 修改后：「纯浏览器节点的环境指纹由文档服务按页面报来的原始值算，页面不自己算；一期只在 Chromium 内核的浏览器上当节点。」

**开工顺序**：C10 合入 main 之后，先派第 8 节的可行性探针（`claude/m7-probe`，`opus-dev`，端口 5710～5719）答 P1～P6，按结果改本文再派实现三个分支（第 9 节）。

### 探针之后的更正（〔裁〕，2026-09-28，PC 主会话；非语义）

依据：`docs/archive/agent-reports/AGENT-m7-probe.md`（原在分支 `claude/m7-probe` 的 `docs/reports/`，M7 阶段报告时归档）「对 M7 契约的更正建议」。主会话逐条裁定照做，页面侧由 `claude/rq-m7-node` 落实（下表「落实」列）。

| # | 改哪里 | 更正 | 落实 |
|---|---|---|---|
| 1 | D11、第 0 节第 4 行 | 要改两处 import：`session.mjs` 改从 `constants.mjs`、`filter.mjs` 改从 `messages.mjs`（队列分支已改）。风险改述为「在线构建不失败（摇树），但开发服务器整页白屏」 | 守门测试 `src/pageNodeImports.test.mjs`：从 `src/main.tsx` 起顺着静态 import 走遍页面会载入的模块（`src/` 与 `server/`），出现 Node 内置模块就判红并给出引用链（变异验证：`session.mjs` 改回引 `index.mjs` 即红） |
| 2 | D3、第 4.3 节 | 生成快照每一帧先等与 `waitFrameReady` 同样的就绪（控件异步活、字体、图片），等待期间照常 tick；超时（20 s）或控件报错就 `fail` 这一段，不出空白帧 | 舞台 `bakeFrame` 的就绪闸，不就绪回 `not-ready`，节点按可重试失败交回（同桌面 `waitFrameReady` 抛错） |
| 3 | 第 4.3 节 | 用逐帧顺推（DOM、Motion 卡与桌面等价且便宜 4～7 倍）；`canvasHeavy` 卡顺推不等价，节点侧 `filter.mjs` 的纯浏览器规则再挡一次 | 缺省 `mode: 'seq'`；`filter.mjs` 规则 7 加 `canvas-heavy`；切分也不给浏览器另出画布卡那一份 |
| 4 | D1 (d)、D10 | 在线构建关掉 CSS 压缩，再用 `m7-bake-probe` 的 compare 比在线构建与桌面；`will-change` 若仍有差异照实报，是否在快照序列化里去掉它另定（会让现有快照键一次性失效） | `vite.config.ts` 在线构建 `build.cssMinify: false`，另关 Tailwind 插件的构建期优化（`optimize: false`：Lightning CSS 不压缩也把 `0.4` 改写成 `.4`）。compare 结果见 `docs/archive/agent-reports/AGENT-rq-m7-node.md`：ticker、slow 60/60 逐字节相同；pill 46/60 相同，其余 14 帧只差 `will-change`（未动） |
| 5 | D5、第 4.4 节 | 小尺寸必须内嵌页面的全局样式表；外部字体的顾虑改述为「只影响用户卡」 | `src/render/bakeSmall.ts` 把舞台页的样式表整份放进 `foreignObject` |
| 6 | 第 3.4 节 | 「60 帧 8～15 s」换成实测（40 ms 推帧卡约 3 s；Lottie 约 50 s 且每帧超 300 KB 被丢弃）；切分方不把这类卡（Lottie 素材卡、预计帧超体积上限的）派给纯浏览器 | `split.mjs` 的浏览器可做判定挡掉 `lottie` / `lottie-*`、画布卡、执行器标了 `snapshotOversize` 的卡（只出切分方那一份）。标记由执行器（`server/prerender-executor.mjs` 的 `markSnapshotOversize`）每次切分前按本机快照库现读：共享档卡在本机指纹的键、或锁定方指纹的键下有 `oversize` 记录就整张卡标（不按段：卡片级指纹锁下按段挡不住，浏览器认领任一段就锁住整张卡）；记录只在本机，别的机器渲过或拉回过才有（2026-09-30，`claude/queue-maint` 任务 E） |
| 7 | （M7 之外） | 在线构建与托管端没带 `/catalog/`，Lottie 素材卡在线是空白 | 主会话另派人修；修之前第 2 条的就绪闸把这些段 `fail` 掉（实测 `not-ready: 控件尚未就绪 (lottie): HTTP 404`） |
| 8 | 第 4.5 节 | 上传器按哈希单飞；`complete` 回 `incomplete` 时先重查 chunks 再重试 | `src/online/snapUploader.ts` |
| 9 | 第 3.3 节 | 删掉「复用测量帧」这项优化 | 已删 |
| 10 | 第 2、5 节 | 冻结后恢复一律当重连；可选：监听 `freeze` 事件，再试一次 release | 宿主听 `freeze` 再尽力放回一次；`resume` 时结束这条 render 会话、马上重建、重新报到 |
