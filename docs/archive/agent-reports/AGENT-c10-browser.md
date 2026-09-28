# AGENT 报告：claude/c10-browser

分支 `claude/c10-browser`，工作区 `.worktrees/c10-browser`，从 `claude/c10-integ` 的 `e067d0b` 拉出。端口段 5420～5429。
任务：C10 契约（`docs/plan/c10-contract.md`，在线浏览器模式普通档，下称「契约」）第 2～7、12 节，加第 18 节第 1、2、3、5、7 条；执行中主会话追加了第 18 节第 9 条（页面发布「清单计划」、对 M6c X4 的修改）与「页面的 plan 不带 envFingerprint / preferNode」的约束。

状态：**收口（主会话要求交接）**。实现全部落地并有单测；G0 全过；G0-R 六项在 PC 上全过、带耗时门槛的一项在笔记本上与 main 对照不比 main 差；本机真浏览器验收 A1、A2、A3、A5 过，**A4 的「暂停后追到精确活渲」没过（原因查到一半，见「没做完的」）**，A9、A10 没跑。

代号：C10-A1～A10 是契约第 20 节的验收条目；K1～K12 是 `claude/c10-tests` 的接口假设（`server/test/c10-kit.mjs` 文件头）；M6c X4 是「plan 只给 pc、发布方独占窗口」那条队列规则（`docs/plan/m6c-contract.md`）；G0 是通用门槛（类型检查、全量测试、两种构建），G0-R 是改了预览与导出路径时加跑的七项回归（`docs/semantics/guide_files/verification.md`）。

## 提交

| 提交 | 内容 |
|---|---|
| `1a08a2b` | 建报告 |
| `c4031c5` | 页面内快照库 L2（`src/online/l2.ts`）、按拍换快照预算（`src/render/beatSwap.mjs`）、分派 deadMs、播放中不受 33 ms 节流 |
| `c0f0d32` | 对 M6c X4 的修改：清单计划 `#clips:`，带片段清单的 plan host 能认领 |
| `f9b9683` | 层表 v 2（contentKey、envFingerprint）；在线来源加原尺寸一档进 L2；低内存档 LRU 换 L2 |
| `0ab4ff7` | 两个跨源舞台、运行配置、后台活开停 RPC、探针帧可转移字节、测量进 L2 costs 与订阅口、页面发布清单计划与 task.done、逐帧导出续签、`deploy-hosted --stage-origins` |
| `ed04c09` | 已占用由宿主注入、投递单测；三级数字写进 mechanism；媒体策略按票据寿命续；测试用环境指纹覆盖 |
| `012fc7d` | 独立渲染主机认领清单计划时写层表（**PC 跑 G0-R 用的是这个提交**） |
| `d43ba69` | 探针 `scripts/probes/c10-browser-probe.mjs`；按拍投递计数 |
| `40dad55`、`c8e927a`、`1fbca36` | 探针卡 `probe-slow-stepped`（`probe-slow` 的推帧版，审阅表 independent，只在舞台里烧时间）；`40dad55` 给 probe-slow 加的审阅项在 `c8e927a` 撤掉 |
| `5b26993` | 在线来源等 L2 打开再取（修 A2 重开重复请求）；探针帧压缩发完再回 render；探针卡被抑制时不烧 |
| `61512d6` | 页面发布的清单只列卡片段；探针检查修正 |
| 之后三个 | 诊断：settled 的清与设、暂停态第二路结果、最近的 setTime；探针 `--hold-min` |

`012fc7d` 之后的运行时代码改动：`5b26993`（snapshotSource 等 L2、StageView 探针帧 flush）、`61512d6`（Preview 清单只列卡片段）、探针卡、以及只加诊断的几处（snapshotFeed、stageSwap、Preview）。桌面导出路径没有再动。

## 做了什么（按契约节）

### 第 2 节 两个舞台
- `src/online/stageOrigins.ts`：`parseStageOrigins(config)`、`stageLayout({ lowMemory, origins, handshake, pageOrigin })`、`stageAssetBase(base, pageOrigin)`、运行配置 `/editor/runtime-config.json` 的读取（`loadStageConfig`，`src/online/boot.ts` 页面载入时取，舞台页不取）与本页状态（握手成败）。
- `src/editor/previewMode.ts`：在线时 `dualStage()` 按运行配置 + 低内存档 + 握手决定；舞台端口表在线上不看。舞台 src 带 `dual=1`（照实报能力）与 `lm=0|1`（跨源舞台读不到编辑器页那个源的设备设置，照父页的档）。
- `src/editor/Preview.tsx`：运行配置没取完不挂 iframe；两个舞台 20 秒内没都握上手就 `markStageHandshake('failed')` 退回同源单舞台；RPC 回包发给 iframe 真实的源；跨源舞台的素材基址换成相对路径（读自己源上反代的 `/media`）。
- `src/render/stageRpc.ts`：`HostCapabilities` 加 `measure`、`catchUp`（有后台舞台且不是低内存档为真；`prerender` 仍为假）；新 RPC `setBackWork(on)`；`probe-frame` 事件可带 `htmlGz: ArrayBuffer`（`compressHtml` / `probeFrameHtml`），`postStageEvent` 支持转移。
- 后台舞台节拍：`src/editor/backWorkGate.ts`（父页判：页面可见 ∧ rAF 间隔 ≤ 500 ms ∧ 父页 rIC 1 秒内回调过，经 RPC 开停；只在在线双舞台开）；`src/render/stageClock.ts` 的 `advanceToAsync` 加 `gate`（帧间查停止标志；桌面不传，帧序不变）；`src/StageView.tsx` 的 `backGate`（render 帧间、布尔探针趟间、探针 setTime 前；停着的时间不算进耗时；在线后台逐帧 `setTimeout(0)`）。后台舞台 `opacity: 0` 原位叠放沿用原有样式。
- `scripts/remote/docservice.mjs deploy-hosted --stage-origins <A>,<B>` + `server/hosted/deploy.mjs`（`checkStageOrigins`、`runtimeConfigLines`；写进 `<部署目录>/editor/runtime-config.json`，之后只给 `--editor` 换代时保留）。子域、证书、nginx（含三方 OAC 头）由主会话部署时做。
- 低内存档仍单舞台（`stageLayout` 与 `ProbeGate` 都按低内存档关）。

### 第 3 节 测量（普通档）
- `src/editor/ProbeGate.tsx`：在线普通档恢复，低内存档关。
- `src/editor/probeRunner.ts`：成本后端可换（`setCostBackend`），在线普通档用 `src/online/l2Costs.ts`（L2 的 `costs` 表，键「卡片身份 + device 串」，记录 `mode=build`）；在线不转发探针帧给预渲染进程（只计数：`probeFrameDiag()`）。
- **订阅口（第 18 节第 7 条）**：`probeRunner.ts` 的 `onCostRecords((records, { stored }) => …)`，每写一次成本记录就发出这次测得的记录。`claude/c10-cost` 的共享成本记录模块接在这里。

### 第 4 节 L2（第 18 节第 2 条）
- `src/online/l2.ts`：`openL2({ indexedDB, lowMemory, estimate, now })`，一个库 `promptcut-l2` 三张表 `costs` / `snapshots` / `ranges`；`putBlock`（软上限内同一事务先删 LRU 再写；`QuotaExceededError` 时另开一个删除事务腾出 `max(16 MiB, 块大小)` 至多 64 MiB，再另开写事务重试一次，仍失败只放内存）、`getBlock`、`putCost` / `getCost` / `listCosts`、`putRange`（写入即通知 `subscribeReady`）、`getRanges`；事务 `error` 与 `abort` 都接；不调 `persist()`；`pageL2({ lowMemory })` 本页单例。导出常量 `L2_SOFT_LIMIT_NORMAL`（256 MiB）、`L2_SOFT_LIMIT_LOW`（64 MiB）、`L2_RECLAIM_MIN` / `MAX`。
- LRU 次序：写入时刻落盘，读命中只改内存里的次序（不为改时间戳重写整块字节），重开后退回按写入时刻——近似 LRU。
- 低内存档：`OnlineSnapshotSource` 的小尺寸一档把块存进 L2（只存 `px/`），内存只留 16 MiB 刚用过的。
- 三级数字写进 `docs/semantics/mechanism/platforms.md`「在线浏览器模式」（标出处）。
- 单测 `src/online/l2.test.mjs`（内存版 IndexedDB `src/testing/fakeIndexedDB.mjs`）。

### 第 5 节 L3（第 18 节第 3 条）
- `server/artifact-transfer.mjs`：`LAYER_MAP_VERSION = 2`，`layerMapOf` 每层加 `contentKey`（取不到为 null）与 `envFingerprint`，这两项只在这里定形。
- `src/render/snapshotSource.ts`：`parseLayerMap` 认 v 1、v 2，不认得的 v 整张当没有；`usableLayer` / `layerRefOf`（普通档只认 v 2 且两项齐）；`OnlineSnapshotSource` 加 `tier: 'original'`：按清单 `frames` 表凭只读票据拉 `snap/<hash>`，写 L2、`putRange`，就绪 = 清单里有且已写进 L2 的帧；已在 L2 的块不请求；预取播放头前后 2 秒；`refresh()`（收到 task.done 马上重取）。一层只取层表那一层的结果键（= 内容键 × 那个环境的指纹）的清单，所以一层只出自一种环境。
- 独立渲染主机没有推送队列，认领清单计划时由 `server/prerender-executor.mjs` 的 `publishLayerMap` 钩子（`server/vite-plugin-frames.ts` 的 `startHostNode` 按连接的内容库写）写这一版的层表。

### 第 6 节 L4 与 K5（第 18 节第 1 条）
- `src/render/beatSwap.mjs`：`SWAP_MS = 3`、`fitBeatSwaps({ fps, occupiedMs, layers, swapMs })`（`deadMs = max(0, budgetOf(fps) − 已占用)`、`floor(deadMs / swapMs)`、按层序取）。
- `src/editor/planDispatch.ts`：`setPlanDeadMs(ms)`（在线普通档分派时 `opts.deadMs = SWAP_MS`）、`lightCostAt(t)`（已占用 = 这一段轻管线的 `clipWeight().w` 之和）。
- `src/editor/snapshotFeed.ts`：`setBeatSwap(on, { swapMs, occupied })`，开着时播放中的投递不受 33 ms 节流、每拍按预算取重层（从上到下：轨道先后、同轨后面的在上），装不下的这一拍摘掉快照由舞台显示占位；`beatSwapDebug()`。
- 暂停追活渲：在线普通档开了双舞台，K5 两路原样走（桌面同一套）。**这一条本机验收没过，见下。**
- `SWAP_MS` 缺省写进 `mechanism/rendering.md`「兜底顺序」（按卡种实测的数还没测）。

### 第 7 节 页面发布 plan（第 18 节第 9 条）
- `src/online/planPublisher.ts`：`createPlanPublisher({ request | endpoint, publisherId, clips, codeVersion, debounceMs })`，`measured()` / `changed()` / `reset()` / `dispose()`；任务 `clipsPlanTask`（`plan:<projectId>@<projectRev>#clips:<sig>`，清单升序去重，`priority: 'normal'`，`requires` 只可能有 `codeVersion`）。发不出去、没人认领都不抛。
- `codeVersion`：**选了「构建时算出并嵌入」**。`vite.config.ts` 的在线构建调 `server/frame-code.mjs` 的 `frameCode(cwd)`（节点同一套算法，换行统一 LF），以 `__PC_CODE_VERSION__` 注入（`src/online/buildInfo.ts`）；开发构建里没有就不写。理由：语义要求节点与发布方代码一致，能算就写，版本不同的节点不认领；算不出时靠第 5 节「层表对不上当没有」兜底。
- `Preview.tsx`：测量落定（`probeSettledFor`）后发、项目确认版本或清单变了防抖重发；清单 = 预渲染集合里的卡片段、去掉用户卡与图卡。`src/editor/sync/syncManager.ts` 加 `subscribeQueueEvents`，收到 `task.done` 让在线来源 `refresh()`。

### 第 12 节 逐帧导出续签（第 18 节第 5 条）
- `src/export/ticketRenewal.ts`：`createTicketRenewer({ fetchTicket, now })`，`start()` / 同步 `ticket()` / `stop()` / `stats()`；剩三分之一寿命续签，失败不换旧的、过期前再试；`withTicket(url, t)`。
- `src/editor/media/assetTiers.ts`：`assetTicketSource` 按这一张实际寿命判是否该换（不写死 15 分钟），返回函数带 `info({ force })`；`remoteAssetTicketInfo(force)`。
- `src/export/onlineExport.ts`、`browserExport.ts`、`frameCompositor.ts`：导出开始建续签器，素材地址用当前票据，每一帧装素材前把导出页里 `data-pc-media-src` 的 `?t=` 换成新的（`freshTicket`）。
- 测试用：`server/auth/protocol.mjs` 认 `PROMPTCUT_TEST_ASSET_TICKET_TTL_MS`（5 秒～15 分钟才认，生产不设）。`Preview` 的媒体策略改为按票据寿命的一半续（原来固定 5 分钟）。

### 对 M6c X4 的修改（第 18 节第 9 条〔裁〕）
- 改了什么：`server/render-queue/messages.mjs` 加 `CLIPS_KEY_MARK = '#clips:'`、`clipsPlanTaskOf`、`isClipsPlan`、`isListPlan`，入站校验（normal 档、清单非空、签名合法）；`queue.mjs` 的 `plan-profile` 只对「不带清单的 plan 遇 host」与「任何 plan 遇 browser」回；`render-node/filter.mjs` 规则 6 同步；`local-node.mjs` 的清单切分（`listPlanOverrides`：清单当预渲染集合、不切流，档跟着 plan：补渲 backfill、清单计划 normal）；`prerender-executor.mjs` 的 `addBackfill` 对两种清单 plan 都做；`session.mjs`、`host.mjs` 注释。
- 为什么：X4 让 host 永远不认领 plan，第 7 节「独立渲染主机认领、切分」与 C10-A5 做不到（主会话裁定）。补渲计划仍用 `#backfill:` 键（C10a 的规则不变）；清单计划另用 `#clips:` 键——同一份清单同一个键、不另起任务；与补渲清单相同时两个 plan 各一个，但切出的细任务结果键相同，队列按现有规则合并、normal 把 backfill 升档。
- 单测 `server/test/c10-list-plan.test.mjs`：LP1 形状与校验；LP2 清单 plan host 能认领、**桌面 plan host 认领 0 次**、browser 一律不认领；LP3 节点侧规则 6；LP4 host（FP_B）认领清单计划、用自己的指纹切分、只切清单里的片段、不切流、normal 档，**锁在 FP_A 的卡按锁的指纹出任务**。原有 X4 单测（`m6c-queue-impl`、`m6c-contract`、`render-host`）不改照过。

## 验证

### G0（笔记本；收口时重跑过）
- `npx tsc -b --force`：0。
- `npm test`（带 ffmpeg 的 PATH）：`012fc7d` 前后跑过两次，收口时（诊断提交之后）又跑一次，都是 3435 条，3433 过、0 失败、2 跳过。
- `npm run build`：成功；`npx vite build --mode online`：成功，产物里嵌着代码版本（与 `frameCode` 同值，核过）。

### G0-R（主会话交 PC 跑，提交 `012fc7d`；基准是 PC 自己的 main `d70fce7` 帧；用时是 PC 数值，不作性能验收）
① verify-determinism：1800 / 1800 相同、0 不同；② 与 PC 基准帧逐像素：total 1800、identical 1800、different 0、missing 0、extra 0；③ verify-unified-frames：PASS；④ ready-index-probe：ok、fails []；⑤ stream-produce-probe --group：PASS、fails []；⑥ preview-fallback-probe：beats 280、transparentBeats 0；`--page-preload`：beats 279、transparentBeats 0。dev server 日志里舞台端口都带 OAC 头。

带耗时门槛的 `stream-produce-probe`（不带 `--group`），笔记本同一时段 A-B-A（端口 5420）：

| 轮 | 提交 | 1080p 全幅 15 帧编码 p50（ms） | 药丸 p50 | 失败项 |
|---|---|---|---|---|
| A | c10-browser `012fc7d` | 704（672/704/762） | 396 | 只有「1080p ≤ 300 ms」 |
| B | main-g0r `2a3d763` | 1592（922/1592/1593） | 260 | 只有「1080p ≤ 300 ms」 |
| A | c10-browser `012fc7d` | 614（586/614/638） | 192 | 只有「1080p ≤ 300 ms」 |

「1080p ≤ 300 ms」在 main 上本来就挂（TODO 里的 M8 之前必修项）；本分支不比 main 差，其余各条全过。

### 本机真浏览器验收（`scripts/probes/c10-browser-probe.mjs`）
本机替身：托管组合（127.0.0.1:5423/5424）+ 三个源的仿 nginx 前缀代理（编辑器页 5420、舞台 5421、5422，全部响应带 `Origin-Agent-Cluster: ?1`，`/editor/runtime-config.json` 给两个舞台源）；创建者 = 桌面 dev server 5425（队列节点 pc）建项目（视频 + chapter-bar + `probe-slow-stepped` 主重卡 0～10 秒 + 8 张同款 0～1 秒 + probe-typewriter）、放云端、预渲染；成员 = 无头 Chrome 普通档凭邀请链接进入。最后一轮完整结果是 probe7（probe8 同样结论），数字如下。

| 编号 | 结果 | 证据 |
|---|---|---|
| A1 | **过** | 两个舞台 iframe 的源是 5421、5422（与编辑器页 5420 同站跨源）；编辑器页与两个舞台页文档响应都带 `origin-agent-cluster: ?1`；CDP `Target.getTargets` 里 5421、5422 各是一个 `iframe` 目标；宿主能力 A、B 都是 `measure: true, catchUp: true, prerender: false, lowMemory: false`；播放 10 秒主文档长任务 **0**；主重卡快照平面换了 55 帧（65 次采样）；按拍投递 268 次、其中不到 33 ms 的也投了；探针帧 2 帧全部以 gzip 字节（6968 字节）转移交出、字符串 0。 |
| A2 | **过** | 首次打开加载遮罩出现又退下；L2 `costs` 4 条、`mode` 全是 `build`；刷新后遮罩不再出现、costs 不变；刷新前已取的 423 个 `snap/` 块刷新后重新请求 **0**，L2 命中 4（修 `5b26993` 之前是 83 个重复请求）。 |
| A3 | **过** | 成员页请求：`snap/` 408、`px/` **0**；在线来源 `tier: original`、层表 v 2；每层 `envFingerprint` 都是创建者节点的 `258acaaa7c5fe509`；跨源舞台的 `/media` 请求都打自己的源（5421→5421、5422→5422）。 |
| A4 | **一半** | 装不下的层显示占位：过（0.1 秒处 10 张重层、`fit` 7、`deadMs` 23.33，两层显示占位符、没有快照平面）。**暂停后追到精确活渲：没过**（见「没做完的」）。 |
| A5 | **过** | 关掉创建者（没有节点在线）后改主重卡文字：页面发布 `plan:<项目>@2#clips:…`、`state: open`、页面无报错；起独立渲染主机（`scripts/render-host.mjs`，host 档，测试指纹 `0c10b0e5f1a9e7d2`，与页面环境 `258acaaa7c5fe509`、创建者都不同）：主机认领 3（plan + 细任务）、完成；页面的层换了新键、环境是主机的指纹、就绪 60 帧；播放中主重卡贴着新快照（快照文字 `main-v2`）。probe6 的输出里「主机认领」一条是探针自己的判据写错（已在 `61512d6` 修），数字本身齐。 |
| A9 | **没跑** | 收口前没排到（`lowmem-online-probe`、`small-tier-probe`、`c10a-demo-probe --local` 都要占我的整段端口、各跑十几到几十分钟）。低内存档的单测（`c10a-*`、`onlineSnapshotSource`、新加的 `C10-L3-5`）全过。 |
| A10 | **没跑** | 探针已支持 `--a10 --ticket-ttl-ms 20000`（托管端缩短素材票据时限，成员页逐帧导出跨过时限，核 `renewal.renewals ≥ 1`、素材地址换票次数），没来得及跑。续签器单测 `C10-TR-01～03` 过（两分钟里 30 秒寿命的票据续签 ≥ 5 次、手里始终是没过期的那张）。 |

新增单测（都在 `npm test` 里）：`src/online/l2.test.mjs`（8）、`src/render/beatSwap.test.mjs`（4）、`src/render/c10-l3-source.test.mjs`（5）、`src/online/stageOrigins.test.mjs`（5）、`src/online/planPublisher.test.mjs`（4）、`src/export/ticketRenewal.test.mjs`（3）、`src/editor/backWorkGate.test.mjs`（4）、`src/editor/c10-beat-feed.test.mjs`（2）、`server/test/c10-list-plan.test.mjs`（4）、`server/test/c10-deploy-stage-origins.test.mjs`（3）。

## 没做完的与下一步

1. **A4「暂停后追到精确活渲」没过**。现象：播放到头再点到 0.5 秒，重层停在快照上（前台舞台 B 挂着 10 张快照、没有 `pc-settling`、没有补跑任务），120 秒都没变。诊断（probe8、probe9 停下来看的）：
   - 页面发出了 `setTime(10, settle)` 和 `setTime(0.5, settle)`，都没有报错；
   - 暂停态第二路（`stageSwap.ts` 的 `runSettleSwap`，这张卡测出来 `vtOk: false`，所以走后台补跑后互换）只在最早 `seek(0)` 那一次做过（`stale 10, ready, swapped`），**10 秒与 0.5 秒两次没有留下记录**——要么 `staleOnBackCatchUp` 算出 0（没有判重又 `vtOk = false` 的卡），要么 `runSettleSwap` 进门就返回了；记录只在 `stale > 0` 时写，还分不出是哪一种；
   - 同一时刻 `settledAll` 为 false（播放时清掉之后没再设）。
   - 下一步：在 `runSettleSwap` 入口与 `staleOnBackCatchUp` 里各记一笔（入参 t、返回原因、`needsBackCatchUp` 每张卡为什么跳过），用 `--hold-min` 停住再看；怀疑点依次是 `pipelineAt(currentPlan(), …, 0.5)` 的判重、`recordOf` 按 identityKey 找记录（在线成本记录来自 L2）、`running` 标志。桌面双舞台这一路 G0-R 的 preview-fallback-probe 是过的，所以先查在线独有的输入（L2 的 costs、在线分派的 deadMs 3）。
2. A9、A10 没跑（见上表）。
3. `SWAP_MS` 按卡种的实测没做，仍是缺省 3 ms。
4. 在线舞台在 20 秒内握不上手才退回单舞台；握手中途某一台卡死之后的处理（已握手后又断）沿用原有的 iframe 重载逻辑，没有另做退回。

## 偏离契约之处

- **清单计划用 `#clips:` 键，不与补渲共用 `#backfill:` 键**（第 18 节第 9 条允许「另起一个构造函数」）：保住 C10a 对补渲计划「必须标 backfill」的校验与单测；同键不另起、normal 升 backfill 在细任务那一级照现有规则成立。
- **L3 就绪 = 清单里有且块已写进 L2**（原尺寸一档）；**低内存档小尺寸一档的就绪仍按清单**（C10a 的做法），只是缓存换成 L2——避免低内存档行为变化。
- **L2 的 LRU 是近似的**：读命中不落盘（见第 4 节）。
- **播放中装不下预算的重层**：这一拍摘掉快照，由舞台的占位逻辑显示占位符（120 ms 之后）。
- **探针卡**：为了本机验收加了 `probe-slow-stepped`（`src/cards/_probe/slow.tsx`、审阅表 `independent`），它只在舞台里、每个新时刻烧一次时间；`direct` 的 `probe-slow` 在预渲染管线里不产快照，用不了。
- **测试用开关**两个（生产不设）：`PROMPTCUT_TEST_ASSET_TICKET_TTL_MS`（`server/auth/protocol.mjs`）、`PROMPTCUT_TEST_ENV_FINGERPRINT`（`server/frame-pipeline.mjs` 的 `ensureEnvironment`）。
- **独立渲染主机写层表**：契约没写，但 A5 离不开（主机没有推送队列，不写层表页面就找不到新键）。
- 越出原任务书文件范围的改动（按主会话追加的裁定或验收需要）：`server/render-queue/*`、`server/render-node/{filter,local-node,split,index,session,host}.mjs`、`server/prerender-executor.mjs`、`server/vite-plugin-frames.ts`（主机写层表）、`server/auth/protocol.mjs`、`server/frame-pipeline.mjs`、`src/editor/sync/syncManager.ts`（`subscribeQueueEvents`）、`src/cards/_probe/*` 与审阅表、`vite.config.ts`（在线构建嵌代码版本）。

## 与 c10-tests 的接口对账提示（K1～K12）

| 假设 | 本分支的名字 | 对不上的地方 |
|---|---|---|
| K2 L2 | `src/online/l2.ts` `openL2`，方法 `putBlock/getBlock/putCost/getCost/putRange/subscribeReady/close` | 无 |
| K3 按拍换帧 | `src/render/beatSwap.mjs` `SWAP_MS`、`fitBeatSwaps`；`snapshotFeed.ts` `setBeatSwap` | 播放中每拍的预算要宿主给 `occupied`（缺省 0） |
| K4 层表 | `src/render/snapshotSource.ts` `layerRefOf(table, clipId, { lowMemory })` | 按第 18 节第 3 条要 `v: 2` 与 `kind: 'layer-map'`；kit 的 `layerTable` 只有 `{ layers }`，会被当作「对不上」 |
| K5 舞台 | `src/online/stageOrigins.ts` `parseStageOrigins`、`stageLayout` | 无 |
| K6 发布 plan | `src/online/planPublisher.ts` `createPlanPublisher` | 按第 18 节第 9 条发的是清单计划 `#clips:`，结果键不是 `<projectId>@<projectRev>`；要给 `clips()`，清单空不发 |
| K12 续签 | `src/export/ticketRenewal.ts` `createTicketRenewer` | 无 |

## 给集成方的接线说明

- **成本记录订阅口**（第 18 节第 7 条）：`import { onCostRecords } from "src/editor/probeRunner"`，回调 `(records, { stored })`。在线普通档写进 L2 之后发；桌面写 `/api/data/costs` 之后也发（桌面那一侧由编辑器进程转写，集成时按需只在 `ONLINE` 接）。低内存档的界限搜索要读写本机测得的记录：`src/online/l2Costs.ts` 的 `l2CostBackend(pageL2({ lowMemory: true }))` 给 `load / save`，键 `costKeyOf(record)`。
- **部署**：`deploy-hosted --stage-origins https://s1.<主机>,https://s2.<主机>`；nginx 在两个子域上提供 `/editor`（同一份在线构建）与 `/media` 反代，三方响应都加 `Origin-Agent-Cluster: ?1`；`/editor/runtime-config.json` 建议 `no-store`。
- **在线构建的代码版本**：`vite build --mode online` 必须在与渲染节点同一份源码上跑（`frameCode` 对整个 `src/` 与几份 server 文件求哈希），否则节点不认领页面的清单计划（层表对不上当没有，页面不报错）。
- **层表 v 2**：渲染节点（桌面、独立主机）要用本分支的 `layerMapOf`，旧节点写的 v 1 层表普通档当没有（低内存档照用）。
- **队列**：文档服务要用本分支的 `server/render-queue`（清单计划的校验与 host 认领）。

## 需要主会话定的事

1. A4「暂停后追到精确活渲」的排查继续由谁做（诊断口子与 `--hold-min` 已在分支上）。
2. 清单计划用独立的 `#clips:` 键（而不是与补渲共用键）是否接受。
3. 独立渲染主机写层表（`publishLayerMap` 钩子）是否接受；两个测试用环境变量是否接受。
4. A9、A10 由谁来跑（命令：`node scripts/probes/c10-browser-probe.mjs --a10 --ticket-ttl-ms 20000`；A9 照各探针文件头，端口挑空闲的一段）。

## 进程与端口

收口时本分支起的进程已全部结束（探针、创建者 dev server、预渲染进程、独立渲染主机、代理与托管组合），5420～5429 无监听（`netstat` 核过）。
