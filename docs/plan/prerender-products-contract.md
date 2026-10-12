# 契约：预渲染存什么（戊、戊二、己、庚、癸共用）

2026-10-12 写。戊、戊二、己、庚、癸是任务书 `render-refactor-task.md` 里五项的名字：戊是「remotion 式的卡不存每帧 HTML」，戊二是「依赖下层的卡也产轨道流」，己是「画布与 WebGL 的卡直接流式压进 H.264」，庚是「快照改成结构存一份、每帧只存变了的地方」，癸是「Lottie 改成 remotion 式」。这五项都改「预渲染存什么」，动手前照任务书的要求先写这一份。

读法：

- 本文只写契约，不重复任务书里的范围、验收和用户原话；规矩以任务书「用户的决定」和「戊、己、庚、癸共用的契约」两节为准，本文把它们落成机制。和任务书或语义对不上的地方列在第 15 节，不在正文里自行取舍。
- 文中的「现状」是 2026-10-12 在 `main`（`a556b7bc`）上查代码得到的，行号按这个提交，动手前自己再核一遍。标「未查清」的是没有查到底的，标「未定」的是要主会话或用户定的（汇总在第 14 节）。
- 〔裁〕：按现有语义没有写明、由本文定下、要用户合入前审的地方。汇总在第 11 节的表和第 14 节。
- 甲一、甲二、甲三、丁是同一份任务书里别的项：甲一是在线浏览器经过任务队列产流和播流，甲二是本页自己产流，甲三是云端渲染服务产流的开关，丁是卡片分类登记表。

## 1. 每一类卡存什么

### 1.1 分类和判据

卡分四类，看分类登记表（丁）里的三样：写法、画在什么上、依不依赖下层。

| 类 | 判据 | 快照 | 轨道流 | 位置矩形 |
|---|---|---|---|---|
| R：remotion 式 | 写法是 remotion 式（`frameMode: "direct"`） | 不存 | 判重时产 | 判重时登记 |
| C：画布与 WebGL | 写法是 motion 式，登记为画布卡（丁的表里 `surface` 是 `canvas2d` 或 `webgl`） | 不存 | 判重时产；画面全在画布里的，像素从画布直接取（第 6.1 节） | 判重时登记 |
| M：motion 式的 DOM 卡 | 其余的 motion 式卡（`surface` 是 `dom`，SVG 也算） | 存，每隔 15 帧一张（第 2 节），存法见第 7 节 | 判重时产 | 不另登记（要用时取流清单的框或当场量的框） |
| 依赖下层 | 上面三类里，依不依赖下层这一样不是「独立」的卡 | 照它所属的 R、C、M | 走戊二的流（第 5 节） | 同它所属的类 |

- 「判重」指在预渲染集合里（`mechanism/rendering.md`「分派」）。在所有位置都判轻的卡不产任何预渲染结果，这一条不变。
- 判据只有一份实现：`server/snapshot-tier.mjs` 的 `snapshotTier(capabilities)`。它现在的规则是「不是 `stateful` 回 `none`，独立或源依赖回 `shared`，其余回 `local`」；己落地时加一条「画布卡回 `none`」。页面一侧（`src/editor/snapshotFeed.ts`、`src/editor/probeRunner.ts`）也用这一个函数，不另写一份（`src/editor/browserNodeHost.ts` 已有从 `server/` 引纯模块的先例）。
- 字段照丁（分支 `claude/rr-card-table`，写本文时还没合入，以合入的为准）：表里登记 `writing`（`remotion` / `motion`，取自声明）、`surface`（`dom` / `canvas2d` / `webgl` / `none`）、`compositing`。运行时的能力对象仍只有五项（`frameMode`、`need_prerendering`、`compositing`、`canvasHeavy`、`independentCache`），`surface` 不在里面，画布卡读的是 `canvasHeavy`；丁的守门测试保证两者一致。所以 `snapshotTier` 加的那一条读 `canvasHeavy`。
- 「是画布卡」和「画面全在画布里」是两件事：前者定类别（存不存快照），读登记；后者只定像素怎么取，产流时实测（第 6.1 节）。画布之外还有别的元素的画布卡也算 C 类，这一点任务书的话有两种读法（第 14 节第 12 条）。
- 本契约不往能力对象里加字段、不改 `src/kernel/frameMode.mjs`。能力对象进卡片身份的摘要（`src/kernel/cardGraph.mjs` 的 `projectCardGraph` 把它写在节点上，`server/card-identity.mjs` 把节点整个算进去）；丁的报告另外指出，`frameMode.mjs` 在每张内置卡的源码导入闭包里，改一个字就有 42 张内置卡换键。

现状对照：`snapshotTier` 已经让 R 类不产快照；`server/artifact-transfer.mjs` 的 `layerMapOf`（第 202 行）只列 `kindOfTier(tier)` 不为空的层，所以 R 类的卡现在在层表里一行都没有。C 类现在产快照（`src/render/snapshot/rasterizeCanvas.ts` 把画布转成内嵌的 PNG），依赖下层的卡现在没有流（`server/frame-stream.mjs` 的 `streamEligible`，第 304 行，只收 `independent`）。

### 1.2 键、清单、层表怎么变（总表）

| 东西 | 现状 | 变成 | 哪一项 |
|---|---|---|---|
| 快照的内容键 | `cardSnapshotIdentity`，里面有生成快照的代码指纹 `snapshotCode()` | 加一项显式的存法版本（第 9.3 节） | 庚 |
| 单卡流的内容键 | `cardStreamIdentity`，成员键取 `control.contentKey`，也就是快照的内容键 | 成员键改用不带快照代码指纹的那一份〔裁〕（第 9.3 节） | 己 |
| 依赖下层的流的内容键 | 没有 | `cardStreamIdentity` 新增一种 `kind: 'below'`（第 5.2 节） | 戊二 |
| 流的代码版本 | `STREAM_CODE_VERSION = 1` 拼上 `captureCode()` | 己落地时加到 2 | 己 |
| 快照任务清单（`SnapshotResult`） | `v: 1`，`frames: [[本地帧, 哈希, 字节数]]`，每帧一块整份 HTML | 第一步加 `want`（这一段该有哪几帧，第 2.4 节）；庚落地时 `v: 2`，`frames` 留空，另加 `bases`、`patches`（第 7.3 节） | 戊、庚 |
| 流清单（`StreamResult`） | `header.kind` 是 `card` 或 `group` | 多一种 `below`，`plane` 是 `stage`（第 5.4 节） | 戊二 |
| 层表（内容库 `layers:<项目 id>`，`LAYER_MAP_VERSION = 3`） | 只有 `layers`（快照） | 版本号不动，加 `streams`（甲一加，形状以甲一合入时为准）、`rects`（第 4.1 节）。旧页面只读 `layers`，不认识的字段忽略 | 甲一、戊 |
| 帧库 | `controls-html/`、`controls-local/`、`streams/` | 多一个 `card-rects/`；快照目录里庚落地后是「结构一份加每帧差异」 | 戊、庚 |

甲一的两条分支（`claude/rr-a1-produce`、`claude/rr-a1-play`）写本文时还没合入。本文对齐的是它们 2026-10-12 的样子，合入后以合入的代码为准，对不上的地方由后做的一方改：

- 层表的 `streams` 表（`rr-a1-play` 上 `server/artifact-transfer.mjs` 的 `layerStreamsOf`）：每条流一行 `{ topClipId, clipIds, kind: 'card' | 'group', plane: 'local' | 'stage', contentKey, candidates: [{ envFingerprint, resultKey }], firstSegment, lastSegment, segmentsPerTask, inputSig? }`。
- 流的输入签名（`rr-a1-play` 上新加的 `src/render/streamInputSig.mjs`）：在线页面按当前项目算同一个签名，对不上的流不播。
- 浏览器那一份流任务只给单卡流（`rr-a1-produce` 上 `server/render-node/split.mjs` 的 `browserStreamInputOf`，只认 `kind: 'card'`、`plane: 'local'`）。

## 2. 快照什么时候产、什么时候用

规矩是用户 2026-10-12 逐条定的，原文在任务书「戊、己、庚、癸共用的契约」，这里不改，只写怎么落。

### 2.1 这一套有哪几帧

- 新建 `src/render/snapshotGrid.mjs`（浏览器和 Node 共用，照 `src/render/snapshotPick.mjs` 的先例），里面放 `SNAPSHOT_STRIDE = 15` 和三个纯函数：
  - `gridLocalFrames({ count, firstFrame, anchors })`：这张卡该有快照的本地帧，升序。等于「本地帧 0、15、30……（小于 `count`）」并上「落在这张卡范围里的锚帧」。锚帧是全局帧号，换成本地帧是减 `firstFrame`。
  - `gridWants(...)`：某一帧在不在这一套里。
  - `gridComplete(ranges, ...)`：就绪区间是不是盖住了这一套（或其中一段）。
- 锚帧照旧取 `snapshotPick.mjs` 的 `anchorFrames`。必须带上锚帧：选帧规则「不跨区间」（`pickSnapshotFrame`）不让跨过锚帧去拿更早的一张，只按 15 排的话，每个锚帧后面最多 14 帧选不出快照。
- 15 这个数只写在这一处，语义里写进 `mechanism/rendering.md`（第 12 节）。代码里另有两个 15：轨道流的分段长度 `SEGMENT_FRAMES`、垫在流下面的那张快照的更换间隔 `POSTER_REFRESH_FRAMES`（`src/editor/snapshotFeed.ts` 第 61 行）。三个数各管各的，不要互相引用。
- 只有 M 类的卡有这一套。

### 2.2 产：测量的时候顺便产一套

现状和任务书写的不一样，先说清：测量的快照趟（`src/editor/probeRunner.ts` 的 `probeCardOnce` 第 456 行，`stage.render(lastSec, { jump: true, probe: "snapshot", maxCatchUp: Infinity })`）确实每推一帧生成一次快照，但它受一拍预算截断（`src/StageView.tsx` 的 `render`，第 1840 行：累计墙钟超过 `1000 / fps × 70%` 就停），每张卡实际只产出 0～1 帧（`m7-contract.md` 第 97 行记着探针的实测）。所以落这条规矩不是「改稀」，而是「取消截断、推完整段、每隔 15 帧生成一张」，遮罩下的时间会变长（第 14 节第 3 条）。

要改的地方：

| 文件与函数 | 改什么 |
|---|---|
| `src/StageView.tsx` 的 `render`（`probe: 'snapshot'` 那一支）和它里面的 `afterProbeFrame` | 不再按一拍预算截断；每推一帧只在 `gridWants` 为真的本地帧上调 `createSnapshot` 并 `postProbeFrame`，其余帧只推进。本地帧 0 要在这一套里：现在的快照趟不生成挂载帧，实现时核对本地帧 0 是不是落在推进步上，没有就补一次 |
| `src/render/stageRpc.ts` | `render` 的参数里加这一趟要的东西（锚帧集合由父页给，舞台不自己算） |
| `src/editor/probeRunner.ts` 的 `probeCardOnce`、`planJobs` | 只给 M 类的卡跑快照趟（判据用 `snapshotTier`）。R 类照旧走抽样（现状）；C 类己落地后不跑快照趟。打开项目之后补测的卡，如果用户正在播放，这一趟跳过，这张卡的这一套归「之后要补的」 |
| `src/editor/probeRunner.ts` 的 `forwardProbeFrame` | 桌面照旧：转发到 `PUT /api/frames/snapshot`，预渲染进程写在页面自己的键下（`server/frame-pipeline.mjs` 的 `acceptMeasuredSnapshot`，第 2947 行），只收独立卡。在线页面现在把这些帧丢掉（`backend.forwardFrames` 为假）：改成留在本页用（第 2.5 节） |
| `scripts/probe-card-costs.mjs` | 离线版做同一件事，跟着改 |

生成快照的三段耗时（样式内联、画布栅格化、序列化）照旧从这一趟取，样本变少了，它们只用来排产能，不进判重。

### 2.3 产：之后要补的，只在暂停时产，排在轨道流前面

「之后要补的」指这一套里还缺的帧：测量时被跳过的卡（成本记录命中、不用重测）、测量帧存不下的卡（依赖下层的卡在缩水项目里拿不到下层，只计时不存帧）、帧库被淘汰的、播放中补测时跳过的。补到多密本文按「只补齐这一套，不加密」写，这一点任务书没有写明（第 14 节第 1 条）。

谁来补、改哪里：

| 谁 | 文件与函数 | 改什么 |
|---|---|---|
| 本机预渲染进程的后台趟 | `server/frame-pipeline.mjs` 的 `preload`（第 1763 行）、`fillAnchorSnapshots`（第 2557 行）、`missingSnapshotFrames`（第 2521 行） | 「锚帧趟」扩成「稀疏快照趟」：要渲的全局帧从「锚帧」变成「每张 M 类卡的这一套」的并集，照旧走整场景那条路（`bakeFrames` 带 `targetFrames`，一趟推进沿途生成），共享档和本地档一起产。做完才把流交给生产者（`streamProducer().update(entry)` 现在就排在锚帧趟后面，位置不用动） |
| 同上 | `fillCardControls`（第 2638 行）里的 `missing`、`recordSnapshots`（第 1593 行）、`renderLocalSnapshots` 的入参 | 都只认这一套里的帧，不再顺手把每一帧都写进快照库。`fillCardControls` 给旧整帧通道产 PNG 的那一支不动（任务书「不在范围里」） |
| 同上 | 第 2539、2687、2713、3020 行几处「`index.count + 超限帧数 >= control.count` 算齐」 | 改用 `gridComplete` |
| 队列细任务 | `server/render-node/split.mjs` 的 `priorityOf`（第 218 行）和流任务那一段（第 333 行起） | 流任务的名次改到所有快照任务之下（现在流任务和不含锚帧的快照段同为 10，数大的先做）。具体数由执行方定。快照任务的分段不变（本地帧每 60 帧一段，`SNAPSHOT_SPAN`） |
| 队列细任务的执行 | `server/prerender-executor.mjs` 调的 `FramePipeline.renderCardSnapshotRange`、`renderSceneSnapshotRange` | 一段里只生成这一套里的帧；进度按这一套里的帧数报 |
| 浏览器节点 | `src/online/browserNode.ts`、`src/StageView.tsx` 的 `bakeFrame`（第 2249 行） | 一段里只生成这一套里的帧。`bakeFrame` 的接续条件现在是「上一帧正好是目标帧减一」（第 2264 行），隔 15 帧取一张时每次都会从挂载帧重推：改成「上一帧不晚于目标帧就接着推」 |

「只在暂停时产」靠现有的闲时判据，不新设：认领队列任务看 `server/queue-idle.mjs` 的 `interactionReason`，流的生产看 `FramePipeline.streamBusy()`（第 494 行），浏览器节点看 `browserNodeHost.ts` 的 `isIdle()`。本机后台趟的快照部分有没有同样的闸，未查清（`preload` 里只看到旧播放通道的一处 `this.playback?.playing`）；实现时核对，没有就让稀疏快照趟在两帧之间看 `streamBusy()`。

### 2.4 「这一段齐了没有」的判据要一起改

下面几处现在都按「每一帧都要有」判，改成按这一套判，否则稀疏的一段永远算不齐、会被反复重渲或反复去取：

- `server/artifact-transfer.mjs`：`resultComplete`（第 563 行）、`coversRange`（第 528 行）。清单里加 `want: [本地帧…]`（这一段该有的帧），读的一方按 `want` 判齐，不用自己知道锚帧。
- `server/frame-pipeline.mjs` 的 `adoptFromManifests` 里的 `haveLocally`（第 2210 行）；`server/artifact-push.mjs` 第 106～109 行。
- `src/online/bakeTask.ts` 的 `manifestCovers`（第 100 行）。
- `src/render/snapshotSource.ts` 的 `OnlineSnapshotSource`：清单是不是取满（第 1115 行 `full`）、整段覆盖（`LayerCoverage`）。
- `src/editor/snapshotFeed.ts` 的 `demoteReady`（第 375 行）：降级的就绪判据现在要求快照连续盖住接下来 1 秒，改成「这 1 秒里属于这一套的帧都在」。

稀疏化本身不换键：已有的逐帧快照是这一套的超集，照旧能用，多出来的帧留着不删。

### 2.5 在线页面测量出的这一套

在线页面没有预渲染进程。这一套先落在本页：页面内快照库（`src/online/l2.ts`）存块，`OnlineSnapshotSource` 多一种「本页产的层」，照现有的就绪消息交给 `snapshotFeed.ts`，本页暂停和拖动可用。推不推素材服务，取决于页面一侧能不能算出和渲染节点相同的结果键，这和甲二要解决的是同一个问题（任务书「甲二」的「已知的难点」）：甲二给出页面一侧的键以后，照浏览器节点完成一段的做法（`browserNodeHost.ts` 的 `bakeFrame`、`finishTask`）推块、写清单；在那之前只在本页用（第 14 节第 9 条）。

### 2.6 用

| 规矩 | 现在的代码 | 要不要改 |
|---|---|---|
| 暂停和拖动：有快照先贴快照，没有才贴轨道流的帧 | 快照：`snapshotFeed.ts` 的 `planFeed`、`pickForSetTime`。流：不在播放时不发流平面（`streamPlanesAt`、`suppressedAt`） | 流那一半要接，见第 3 节 |
| 只往回找，不拿后面的 | `snapshotPick.mjs` 的 `latestReadyAtOrBefore`、`pickSnapshotFrame` | 不改 |
| 停下以后回到精确的活渲 | `StageView.tsx` 的追帧与 `settled` 事件 | 不改 |
| 播放时贴流，流这一拍画不出来就露出垫着的快照，再没有才占位 | `planFeed` 给每张重卡照样选一张快照（`tier: 'poster'`），`streamPlayer.ts` 的 `coverSnapshot` | 不改。R、C 类没有快照，自然跳过中间这一步 |
| 垫在流下面的快照相差 15 帧以上才换 | `heldPoster`、`POSTER_REFRESH_FRAMES` | 不改 |

要跟着改的一处：`planFeed` 报给预渲染进程的缺口（`wanted`，第 511～519 行）。现在「选中的不是当前这一帧」就报当前帧，稀疏以后每一拍都会报，而当前帧多半不在这一套里，报了也没有东西可产。改成：只在这一层这一段选不出任何快照时报，报的是「不晚于当前帧的最近一格」；R、C 类不报。

改这一处要留意一件事：预渲染进程判断「用户在播放」靠的是这条消息的新鲜程度（`streamBusy()` 和 `queue-idle.mjs` 的 `interactionReason`：在播、且 5 秒内有过音讯）。看到的代码里，播放中带着 `playing` 发过去的只有缺口上报这一条路（`src/render/dataMirror.ts` 的 `sendWanted`，每 100 毫秒至多一次），播放头那条路播放中不推。缺口报得少了以后，播放中要保证仍有这条音讯（例如没有缺口也按同样的节流发一条空的），否则预渲染进程会在播放中恢复生产，违反「播放时不产」。播放中还有没有别的音讯来源，未查清，实现时核对。

## 3. 暂停和拖动时，没有快照的卡贴什么

接 `claude/scrub-streams` 的原型（任务书「己」）。原型的开关去掉，下面逐条定原型报告里「正式做还差什么」的九条。

### 3.1 谁走这条路（第 1 条）

按类别判，不按「这一帧选不出快照」判：

- R、C 类（不存快照）：不在播放、还没追到精确活渲时，这一帧有流盖着就抑制并贴流的目标帧。它们不进 `awaiting`、不报快照缺口。没有流盖着时：R 类露出活组件当场算（现状）；C 类显示占位符，不露出没推到位的活组件。
- M 类（存快照）：先按第 2.6 节选快照，选得出就贴快照；这一帧选不出、又有流盖着，贴流的目标帧（用户原话「没有才贴轨道流的帧」）；都没有照现状（`awaiting` 藏 500 毫秒，占位符照现有规则）。
- 判据在父页一侧用 `snapshotTier`。原型里探针用的「当作没有快照」钩子（`setPretendNoSnapshot`）保留给探针。
- 低内存档的分支照现状保留（任务书「不在范围里」）。

### 3.2 暂停态的解码器预算（第 2 条）〔裁〕

- 同时活着的解码器仍不超过 `DECODER_BUDGET`（6，`src/render/streamPlayer.ts` 第 43 行），和播放时是同一个数。
- 暂停和拖动时每条流只要目标那一帧：解出来画到平面的画布上以后，解码器可以让给下一条流，画布上的画面留着。所以同屏走流的卡不设上限，超出 6 条的按从上到下的层序排队。
- 排队中的那一层：留着上一张画面，最多 `SCRUB_HOLD_MS`（原型定的 500 毫秒）；到时还没画上就显示占位符。不露出没推到位的活组件。
- 这是本文的判断，原型没有做（原型照搬播放时的预算，超出的卡不抑制、露出活组件）。要补单测和探针：同屏 8 张这类卡，逐张拖到位。

### 3.3 起步那一下（第 3、4 条）〔裁〕

量得出来的口径：**一层「什么都不画」的连续时间不超过 120 毫秒**。「什么都不画」指这一层同时满足：流平面没有画面、活子树被藏着、快照平面没有、占位符没有显示出来。120 毫秒就是占位符的显示延迟 `PLACEHOLDER_SHOW_DELAY_MS`（`src/render/placeholder/contract.ts`），语义里本来就写着「来不及的状态持续满 120 毫秒才显示占位符」，所以这个口径不新增数字：短于它的空档现在就是允许的，长于它的必须已经是占位符。

做法（原型里拖动起步已经这样做，推广到另外两处）：

- R、C 类的卡被点名抑制时，流的第一帧画出来之前不藏活子树，最多等 `SCRUB_HOLD_MS`；画出来或到时才藏。适用于三处：拖动起步、点一下跳过去、起播和播放中跳转后的第一拍。
- 点一下跳过去时，舞台对这类卡的不可见追帧等到流的第一帧画出来（或到时）再开始，这段时间里露着的是跳之前那一刻的活画面。
- 暂停着的时候，把播放头附近这类卡的流清单和开头文件先取好（不建解码器），缩短第一帧的等待。取多大范围由执行方定。

没有垫着的快照以后，播放中流这一拍画不出来，这类卡直接落到占位符（满 120 毫秒才显示）。这是任务书定的（「没有快照的卡跳过中间这一步」）。

### 3.4 稀疏段（第 5 条）

流先铺的那一版每 3 帧一张（`SPARSE_STRIDE`）。拖到稀疏段时贴的是不晚于目标帧的最近一格，最多差 2 帧，算数：它和快照「只往回找」是同一种性质，松手以后回到精确活渲。探针里「呈现的帧号等于目标帧」只对满帧段断言，稀疏段断言「呈现的帧号是不晚于目标帧的最近一格」。

### 3.5 组流（第 6 条）

组流里各卡的外观已经画进同一条流，不能只撤一张：

- 组内此刻在场的成员全都属于「这一帧走流」时才贴组流平面；有一张不是，这一组不贴，各成员按各自的规则。
- 追到精确活渲时整组一起撤：组内最后一张追上才撤组流平面和全组的抑制；先追上的成员继续被抑制。
- 原型没有验这一段，要补单测和探针。

### 3.6 其余三条

- 低内存档和在线页面（第 7 条）：低内存档不生效；在线页面等甲一合入以后在在线构建里重验，探针加在线的一遍。
- 流里的细线比活渲淡（第 8 条）：己改成从画布直接取像素以后重量，数字写进报告。从流换回精确活渲那一下的轻微变化是看得到的，列在第 11 节。
- 两处老问题（第 9 条）：先修，排在第 13 节最前面。

### 3.7 证明「不比现在差」的探针口径

沿用并扩 `scripts/probes/scrub-stream-probe.mjs`。同一个项目、同一条拖动轨迹（至少 10 处，含往回跳、落在非关键帧、跨分段、远跳、只挪两帧），在开工前的提交上带快照跑一遍作对照，再在新代码上跑：

1. 每一处呈现的帧号等于目标帧（满帧段）。
2. 全程按动画帧采样，每一层「什么都不画」的最长连续时间不超过 120 毫秒；流已经齐的时候占位符显示的段数是 0。这两个数不大于对照那一遍。
3. 取至少 4 处和精确活渲比像素：颜色平均差不超过 2（满分 255），并且同一处和别的时刻比的平均差至少是它的 3 倍（任务书要求带对照）。精确画面一律从更早的时刻往前到达后取。
4. 起播第一拍、播放中跳转后的第一拍：透明拍数是 0（断言）。
5. 松手到精确活渲的时间、换分段的那一步的耗时：只记录，新旧各一个数。
6. 桌面跑一遍；甲一合入后在线再跑一遍。

## 4. 位置矩形；产流时 remotion 式的卡不从挂载帧回放（戊）

### 4.1 位置矩形登记在哪

「位置矩形」是一张卡整段时间里画出内容的范围的并集，一张卡一个，包裹层坐标（和单卡流清单里的 `bound`、`tight` 同一个坐标系）。

- **给谁登记**：预渲染集合里不存快照的卡（R、C 类）。任务书写的是「remotion 式的重卡」；`render-standard.md` 的表写的是当场算得过来的也登记，本文按任务书（第 15 节第 6 条）。
- **谁量、怎么量**：预渲染进程（桌面、渲染主机）。有流的卡取流清单的 `tight ?? bound`（`frame-stream.mjs` 的 `measurePng`、`maybeTighten` 已经在量）。流还没有的，在稀疏快照趟（第 2.3 节）每到一帧顺手量：对这些卡调页面里的实体框量法 `window.__pcSolid.rectsWithBounds`（`frame-pipeline.mjs` 第 3313 行附近已有调用的先例），取并集，外扩 `LOCAL_OVERFLOW_PX`。
- **帧库**：`<库根>/card-rects/<共享快照键>.json`，内容 `{ v: 1, kind: 'card-rect', resultKey, contentKey, envFingerprint, rect: { x, y, w, h } | null, frames }`。键用 `control.snapshotKey`：它不含片段的摆放，同一张卡摆两处共用一份，和矩形的坐标系对得上。
- **素材服务这边**：写进层表，新加一张 `rects` 表：`[{ clipId, contentKey, envFingerprint, rect, inputSig }]`。`inputSig` 和快照层的是同一个（`src/render/layerInputSig.mjs`），页面照「旧输入的层不贴」的规则判过期。不升层表版本号。
- **桌面页面**：就绪索引（`server/ready-index.mjs`）加一种消息 `{ type: 'rect', clipId, key, rect }`。桌面的页面和预渲染进程是同一个版本，没有新旧兼容问题。
- **谁用**：`src/render/placeholderHost.ts` 的 `geometryFor`（第 406 行）。取框的顺序从「流清单的框、当场量的墨迹框、徽标」变成「流清单的框、登记的位置矩形、墨迹框、徽标」。照 `setStreamBoxSource` 的样子加一个来源。

在线又没有任何切分节点的时候，层表没有人写。甲二的页面写层表时一并写 `rects`（取本页测量时量到的框），这一条等甲二的执行方确认（第 14 节第 8 条）。

### 4.2 产流时不从挂载帧回放

现状：`server/bakery/bake.mjs` 的 `bakeStream`（第 445 行）接不上租约时，从 `min(fromFrame, mountFrame)` 起回放（第 462 行），再预热 3 帧（`warmUpAt`）；不分写法。在线一侧 `StageView.tsx` 的 `bakeFrame` 接不上时 `remountAt` 再逐帧推到目标帧。

改法：

- `frame-stream.mjs` 的 `planStreams`：每条流多带一项「要不要回放」，成员里有一张 motion 式的卡就要。成员的写法取 `control.frameMode`（`card-cache.mjs` 的 `plan` 已经带着）。
- `StreamProducer.runSegment`（第 998 行）：不要回放的流不传 `mountFrame`，预热帧数传 0（`bakeStream` 的 `warm`）。`bakeStream` 现在对「没给 `mountFrame`」的处理就是从 `fromFrame` 起，所以这一块可以不动 `server/bakery/bake.mjs`。尽量不动：它在生成快照和截图两份代码指纹的名单里，改一个字全部快照和全部流的键就换一次（第 9.3 节）。
- 这类流断了租约也只是重灌一次页面，分段可以不按顺序产。
- 在线一侧：`StageView.bakeFrame` 对隔离工程里唯一那张卡是 remotion 式的情形，直接把时钟拨到目标帧，不走 `remountAt` 加逐帧推。这一句和甲一在 `bakeFrame` 上加的「交出像素」是同一个函数，排在甲一之后改。
- 证明：探针或日志里 `StreamProducer.status()` 的 `resets`、`bakeStream` 回的 `replayed`，对这类流 `replayed` 恒为 0。

## 5. 依赖下层的卡的流（戊二）

### 5.1 哪些卡、谁能产

- 进这条路的卡：预渲染集合里、依不依赖下层这一样是「依赖下层」「旧的统称 `context`」或「未知」的卡（审阅表没覆盖到的卡按未知，用户和 Agent 建的卡都是）。源依赖卡（转场、接素材的素材效果卡）现在不进流，这次是否一并走这条路，未定，缺省不进。
- 框用了三维的卡照旧不进（`streamEligible` 里的 `frame3d`）。
- 这种流不参加组流合并（`groupStreams` 只合并独立卡的流），但占解码器预算；超出预算的层照现有规则从快照那一步开始兜底。
- 谁能产：桌面应用和渲染主机。浏览器节点和本页产流不产。`split.mjs` 里这种流的任务：`requires.transcode: true`、`requires.belowDependent: true`、`capabilities.streams` 照旧；浏览器那一份不会出（甲一的 `browserStreamInputOf` 只认单卡流）；用到只在发布方本机的素材时带 `requires.localMedia`（`usesLocalMedia` 要把下层的素材算进去）。

### 5.2 键里怎么带上下层

`server/card-identity.mjs` 的 `cardStreamIdentity` 新增 `kind: 'below'`，摘要里是：

- 目标卡：带外观的缓存内容键 `control.cacheContentKey`（位置、缩放、旋转、不透明度、淡入淡出、轨迹都在里面，因为这种流按舞台坐标产，外观画进流里），加采样的第一帧、相位、帧数。
- 下层：画家顺序排在目标卡下面、活跃时间和目标卡有重叠的每一个画面层（卡片段和画面素材段，取自 `frame-stream.mjs` 的 `paintLayers`），各取它的 `cacheContentKey`、第一帧、相位、帧数，按画家顺序排成一列。`card-cache.mjs` 的 `plan` 对每个可见输出（含素材段）都算了 `cacheContentKey`，素材段的节点身份里有素材本身。
- 画幅、帧率、`codeVersion`，同别的流。

这样下层任一控件的参数、位置、时间、顺序变了，或者下层多了少了一层，键就变，旧流不再贴；上面的层怎么改都不影响。这和 `mechanism/cards.md`「轴三」的失效规则是同一条。

没有按「会不会碰到这块区域」再筛下层：第一版按时间重叠算，宁可多作废。按区域筛是以后的优化（第 14 节第 5 条）。算不出某个下层的键时，退回用整个项目的键 `entry.key`（本地档快照现在就是这样，更粗但不会错）。

在线页面那一头要能自己判出「下层改了，这条流不能再贴」，不能等渲染节点重写层表：甲一加的流的输入签名（`src/render/streamInputSig.mjs` 的 `streamInputs`）加 `below` 一支，进签名的是目标卡的片段签名、采样窗口、外观，加时间重叠的每个下层的片段签名、采样窗口、外观和画家顺序。层表的 `streams` 表（`layerStreamsOf`）现在只认 `card` 和 `group`，要认 `below`。

### 5.3 流里放什么〔裁〕

用户原话是「带着下面卡片一起产流，流只包含这个目标卡片的矩形区域」。产的时候照做：隔离工程里留着目标卡和它下面的全部层，上面的层隐藏（`isolatedStreamProject` 现在把非成员全隐藏，要改成只隐藏上面的）。

流里存什么，本文定为**差分取层**：每一帧截两张，一张带目标卡（记作 R），一张把目标卡藏起来（记作 L），算出一层 S，使「S 按普通的叠加盖在 L 上」正好等于 R，流里存 S。按预乘色，每个像素：

- R 和 L 相同：S 全透明。
- 否则 S 的不透明度 a 取下面几个数里最大的，夹在 0 和 1 之间：`(R 的不透明度 − L 的不透明度) / (1 − L 的不透明度)`；每个颜色通道的 `1 − R色 / L色`（保证 S 的颜色不为负）；每个颜色通道的 `(R色 − L色) / (1 − L色)`（保证 S 的颜色不超过 a）。
- S 的颜色 = `R色 − L色 × (1 − a)`。

为什么不直接存 R（「原样盖」）：

- 2026-10-12 在 Chrome 152 里实测，毛玻璃的画法是「滤过的下层盖在没滤过的下层上面」，不是替换（把 `backdrop-filter` 写成 `opacity(0)`，画面和不写完全一样；写成 `opacity(0.5)`，不透明度从 26 升到 38）。所以 R 总能写成「某一层盖在 L 上」，上面的算法有解。
- 直接把 R 盖在舞台上活着的下层上面，下层半透明的地方（阴影、抗锯齿的边、半透明色块）会叠两遍。同一个测试场景（半透明色块加阴影上面压一张毛玻璃卡，400×300）里：原样盖平均差 2.55、最大 63.7（满分 255）；差分取层平均差 0.035、最大 9.9（8 位量化以后，没有经过编码）。
- 差分取层出来的 S，在目标卡没有改动的地方是全透明的。所以现有的「稀疏那一趟量不透明像素的包围盒、第二趟收紧」（`measurePng`、`maybeTighten`）照旧能用，流自然只含目标卡那一块；审阅表没覆盖到、其实是独立的卡，S 就是它自己的画面，舞台上的下层原样露着，没有一整块被换成编码过的画面。
- 想过用 `backdrop-filter: opacity(0)` 让流平面把自己矩形里的下层擦掉再画，实测擦不掉，这条路不通。

没验的：差分取层只做了上面的静态小实验，没有接进产流、没有量每帧截两张的耗时、没有量编码以后的误差。它和用户原话字面上有出入（流里不放没被目标卡改动的下层）。做不成或代价太大时退回「原样盖」，并把上面的误差数字报给用户。这一条标〔裁〕，要用户审。

### 5.4 贴回舞台时怎么盖、和上面的层怎么叠〔裁〕

- 平面：舞台坐标，照组流平面的现成机制（`src/render/Stage.tsx` 第 480～487 行的 `[data-pc-group-plane]`）：挂在舞台根下，层序取目标卡那一层的 `zIndex`，`pointer-events: none`。流清单的 `header.kind` 是 `below`，`plane` 是 `stage`。
- 目标卡的包裹层照播放时的规则抑制（藏子树）。平面不受包裹层的不透明度、滤镜、轨迹影响，这些已经画进流里。
- 下层不动：照常活渲或贴它们自己的流、快照。平面按普通的叠加盖在它们上面。
- 上面的层不动：层序比目标卡高，照常画在平面上面。
- 命中和实体框：照组流成员的现成做法退回包裹层的框（`data-pc-stream-member`）。
- 下层这一拍不是它该有的画面时（下层自己的流画不出来、露的是 15 帧前的快照或占位符），S 盖上去只在目标卡改动过的地方是对的。这和现在播放中各层各自兜底是同一种情况，不另处理。
- 暂停回到精确活渲时平面撤下，同单卡流。

## 6. 画布卡直接取像素（己）

### 6.1 什么算「卡片的画面全在画布里」

它只决定这条流的像素怎么取，不决定存不存快照（存不存快照看是不是画布卡，第 1.1 节）。两道，都过才走直取：

1. **登记**：这张卡登记为画布卡。现在登记的有通用粒子卡 `particles`、53 张粒子素材封装卡（`particles-*`）、`scene-3d` 和探针卡 `r6-canvas`。
2. **产流时实测**：隔离工程里这张卡挂好以后的第一帧，以及之后每个分段的第一帧，把「从画布取出的像素按画布在包裹层里的位置摆好」的图和这一帧的截图比，颜色和不透明度的平均差不超过 1（满分 255）才算过。不过的卡这一条流照现在的办法（截图、PNG、ffmpeg），并在诊断里记一条。

实测这一道兜住的是：画布外面还有别的元素；画布或它的祖先带着不透明度、滤镜、变形；画布的像素尺寸和排版尺寸不一致。现有的画布卡除了画布还渲不渲别的元素，本文没有逐张读源码核，靠这一道在产流时判；己的第一块把结果记进报告。

画布怎么认：包裹层里唯一的 `<canvas>`。共享 WebGL 渲染器的平面（`[data-pc-gl-plane]`）取之前照 `rasterizeCanvas.ts` 的办法核帧号（`data-pc-gl-frame` 等于包裹层的 `data-pc-local-frame`），对不上按这一帧取不到处理，不许交出空图。

### 6.2 像素怎么到编码器：两条路

| | 把原始像素交给 ffmpeg | 浏览器自带的编码器 |
|---|---|---|
| 做法 | 页面里读出画布的 RGBA，交给 Node，`server/bakery/ffmpeg.mjs` 的 `openStreamSegmentEncoder` 多一种输入（`rawvideo`、`rgba`），后面的滤镜链和编码器不变 | 页面里把画布拼成上半颜色、下半不透明度，送进 `VideoEncoder`，用甲一的 `src/render/streamMux.ts` 封成分段，把分段字节交给 Node |
| 前提 | 没有新的：ffmpeg 本来就在 | 预渲染用的 Chrome 里有 H.264 编码器，并且认拼合后的尺寸（1080p 拼合后是 1920×2176）；甲一的压和封装两个模块已经合入 |
| 风险 | 每帧要把整块原始像素从页面搬到 Node（1080p 一帧 8.3 MB），搬法决定快慢；省掉的是 Chrome 压 PNG 和 ffmpeg 解 PNG | 节点（Linux、没有显卡、无头 Chrome）上有没有这个编码器、支持到哪个档次和尺寸，没有量过；码率和画质的控制方式和 ffmpeg 不同；颜色从 RGB 转 YUV 由浏览器做，和 ffmpeg 那条链可能有色差；多一套封装 |
| 和现有东西的关系 | 编码器名字、分段签名、清单都不变 | `encoder` 要一个新名字；分段签名里的编码参数哈希要给它一份 |

两条路都要：带透明的流仍拼成上半颜色、下半不透明度；矩形仍是流的 `bound` 或 `tight`（偶数宽高）；一个分段仍是 15 帧、首帧是关键帧。组流、依赖下层的流、过不了第 6.1 节实测的卡照旧走截图。

像素从页面到 Node 的搬法（协议调用回传、页面向本机端口发请求等）由执行方定，判据是下面量出来的每帧耗时。

### 6.3 定之前在节点上量什么（由主会话安排）

在节点（Linux、没有显卡、无头 Chrome）和这台 PC 上各量一遍，画面 960×540 和 1920×1080 两种，各 90 帧，用一张粒子卡和 `scene-3d`：

1. 节点上预渲染用的是哪个 Chrome（版本、是不是带专有编码器的构建）。
2. `VideoEncoder.isConfigSupported`：基线、主、高三个档次，拼合后的两种尺寸，分别问「不限」和「只用软件」。
3. 浏览器自带的编码器：每秒压多少帧；解回来 90 帧是不是都在；和原画比颜色、不透明度的平均差。用甲一分支上的 `scripts/probes/browser-stream-encode-probe.mjs`。
4. 原始像素交给 ffmpeg：每帧读像素、搬到 Node、编码三段各多少毫秒；解回来和原画的差。
5. 现在的办法（截图、PNG、ffmpeg）在同一台机器上的同样三段耗时，作基线。

判据：

- 某条路在某台机器上「可用」：编得出来、解回来帧数对、颜色平均差不到 1、不透明度平均差不到 0.5（颜色那个数取自任务书己的验收，不透明度那个数是本文定的；`render-standard.md` 在这台 PC 上实测是 0.2～0.35 和不到 0.04）。
- 节点上浏览器自带的编码器不可用：节点走 ffmpeg 那条。
- 两条都可用时：端到端每帧耗时差不到五成，取 ffmpeg 那条（编码器、画质、清单都不变，要验的东西少）；浏览器那条快出五成以上，才考虑它，或者两处各用各的。
- 两条路都不比现在的办法快：己的「直接取像素」不做，只做「不存快照」和「拖动贴流」，报给用户。

本文的推荐是缺省走 ffmpeg 那条，量完由主会话定。

### 6.4 不再存每帧快照以后的影响

| 地方 | 影响 |
|---|---|
| 暂停、拖动 | 画面改从流取（第 3 节） |
| 播放 | 流这一拍画不出来时没有快照可露，直接占位符 |
| 测量 | 这类卡不跑快照趟；成本记录里画布栅格化那个耗时不再有意义，字段留着 |
| 体积上限 | 画布位图 1 MB 那一档（`server/snapshot-store.mjs` 的 `CANVAS_SNAPSHOT_LIMIT`）没有东西可判了，随己删掉或留着不用，由执行方定；语义里那半句要改（第 12 节） |
| 预渲染小尺寸 | 小尺寸是从快照缩出来的，这类卡从此没有小尺寸；轨道流没有小尺寸。低内存档下这类卡没有可贴的东西（第 14 节第 10 条） |
| 层表 | 这类卡在 `layers` 里没有行，只在 `streams`、`rects` 里有 |
| 降级的就绪判据 | 只看流（`demoteReady` 的流那一支） |
| 旧整帧通道 | 每张卡另存的 PNG 是搭在快照清单里送到别的节点的（清单的 `pngs`，`artifact-transfer.mjs` 的 `collectPngFrames`）。没有快照任务的卡，这些 PNG 不再随清单走；旧整帧通道这次不动，记一笔 |
| 整场景的 HTML | 不变。Agent 看画面、导出用的那一份里画布仍然栅格成图片（`rasterizeCanvas.ts` 不删） |
| 浏览器节点 | 本来就不做画布卡，不变 |

## 7. 快照的新存法（庚）

范围照任务书：每张卡自己的快照（M 类）。整场景的 HTML 不动，`createSnapshot` 回的 `html` 一个字节不许变（基线脚本靠它，第 10 节）。

### 7.1 结构基准和每帧差异

- **结构基准**：一份完整的控件 HTML（就是现在一帧快照的内容）。一张卡在一个产出方手里，第一份基准是本地帧 0 的快照。
- **每帧差异**：这一帧相对它的基准有哪些地方不同，一份 JSON：`{ base: <基准的哈希前 16 位>, ops: [...] }`。`ops` 的形状照实验探针（分支 `claude/browser-stream-encode` 上的 `scripts/probes/snapshot-diff-apply-probe.mjs`）：`[节点序号, 0, 样式属性, 值, 优先级]`、`[节点序号, 1, 属性名, 值或 null]`、`[节点序号, 2, 文字]`。节点序号是把基准解析以后按文档顺序走一遍（元素、文字、注释）的序号。
- **和实验不同的一点**：实验里每帧存的是相对上一帧的差异；这里每帧存的是相对基准的差异。这样任意一帧都能单独贴出来，不依赖上一帧。
- **结构变了的帧**（节点多了少了、换了标签）：这一帧自己当一份新的基准，之后的帧相对最近的一份基准。每一份差异都写明自己的基准，所以不同产出方、不同分段各用各的基准也不会错；内容相同的基准按哈希自然去重。
- 差异在页面里算（Node 一侧没有 DOM）。新建 `src/render/snapshot/diffSnapshot.ts`，放两个纯函数：算差异、把差异贴到一个平面上。这个文件要加进 `server/frame-code.mjs` 的 `SNAPSHOT_FILES`。

### 7.2 落盘

快照目录（`controls-html/<键>/`、`controls-local/<项目键>/<键>/`）里：

- `base-<哈希前 16 位>.html`：结构基准。
- `<本地帧>.patch.json`：每帧差异。基准帧自己的差异是空的 `ops`。
- `index.json`：照旧记就绪的帧区间和超限的帧，另加 `format: 2`。

写入仍只走 `server/snapshot-store.mjs` 的 `commitSnapshots` 一个入口。预渲染小尺寸（`<本地帧>.small.webp`）照旧，从这一帧的完整 HTML 画，生成的时候完整 HTML 就在手上。

### 7.3 素材服务里的块和清单

- 块：基准和差异都进 `snap`，按内容哈希。
- 清单 `SnapshotResult`：`v: 2`；`frames: []`（留空）；`want`（第 2.4 节）；`bases: { <哈希前 16 位>: { hash, bytes } }`；`patches: [[本地帧, 哈希, 字节数, 基准的哈希前 16 位]]`；`small` 照旧。
- 为什么 `frames` 留空、版本号加一：旧的渲染节点见到 `v` 不是 1 就不认（`manifestMatches`），不会把差异当整份 HTML 拉回去；旧的在线页面不看 `v`，只读 `frames` 和 `small`，`frames` 是空的它就当这一段还没有原尺寸，小尺寸照旧能用，不会把一段 JSON 当 HTML 贴上去。
- 推送、拉取（`collectSnapshotResult`、`pushResult`、`applySnapshotResult`）和清单体积上限照旧，按新形状走。

### 7.4 浏览器节点产的那一份

`StageView.tsx` 的 `bakeFrame` 生成这一帧以后，在舞台里算它相对基准的差异（基准跟着这一次生成的会话留在舞台里）；`bake-frame` 事件带回差异，第一次用到某份基准时一并带回基准。`browserNodeHost.ts` 的 `bakeFrame` 推块，`src/online/bakeTask.ts` 的 `snapshotManifest` 出 `v: 2` 的清单。

### 7.5 取用和贴

- 页面取字节：桌面的读口（`server/vite-plugin-frames.ts` 的 `GET /api/frames/snapshot/<档>/<键>/<本地帧>`）改成回差异，另加取基准的读口；在线的 `OnlineSnapshotSource` 读清单的 `bases`、`patches`。两边的 `fetchSnapshot` 回「基准的标识、差异」，基准按哈希缓存，只取一次。
- 投递：`setSnapshots` 的每一项从一段 HTML 变成「基准的标识、差异；舞台上没有这份基准时带上基准的 HTML」。投递基线照旧按 iframe 各一份；一次投递不超过 2 MB 的上限（`SNAPSHOT_DELIVERY_MAX_BYTES`）按实际发出去的字节算。
- 舞台贴（`src/render/Stage.tsx` 的快照平面、`StageView.tsx` 的 `applySnapshots`）：
  - 平面上没有东西，或者基准不同：整块写入基准，再贴这一帧的差异。
  - 基准相同：只改不同的地方。从第 N 帧跳到第 M 帧时，N 动过而 M 没动的那些地方要改回基准里的值，所以舞台上留一份没动过的基准用来查原值。
  - 平面的 `innerHTML` 交给 React 的那个属性保持是基准（同一个对象，React 不重写），差异在提交之后直接改 DOM。
  - 差异里的属性值和样式值同样要过按片段的 id 改名（`src/render/snapshotRename.ts`），否则 `url(#…)` 会指错。
- **压住过渡**：快照平面和它里面的所有元素加「不许过渡、不许动画」（写在 `src/render/planeStyle.ts` 的平面样式表里，带 `!important`）。快照把样式整个内联了，里面可能带着过渡时长，只改一个数值会被浏览器当成要做过渡。
- 新页面两种都认：读到 `v: 1` 的清单（旧节点产的整份 HTML）照旧能贴，当作「每帧自己是基准、没有差异」。

### 7.6 体积上限〔裁〕

现在的规则：DOM 卡一帧快照超过 300 KB 不投递，那一层按缺料处理（`snapshot-store.mjs` 的 `DOM_SNAPSHOT_LIMIT`、`noteSnapshotSize`）。它管的是一次投递的成本。

换存法以后按块判：**结构基准一块不超过 300 KB，每帧差异一块不超过 300 KB**；哪一块超了，用到它的帧照现在的超限处理（照常落盘、不进就绪区间、记进 `oversize`、不投递）。

- 这样判，现在合格的卡不会变成不合格（基准就是一帧完整的快照，差异不会比完整的一帧大），现在不合格的卡仍然不合格。
- 没有趁机放宽基准的上限。放宽了，一些现在超限的大 DOM 卡会变得可用，那是用户看得到的变化，记待用户项（第 14 节第 7 条）。
- 在线页面每拍换快照的成本估算式（`src/render/beatSwap.mjs` 的 `swapCostOfSize`）是按整块替换标定的，换存法以后偏高（偏高只会多显示占位，不会掉帧）。先按「这一次实际发出去的字节」沿用，重新标定记待办。

### 7.7 验收里要有的一条

除任务书列的以外：`createSnapshot` 回的整场景 `html` 改前改后逐字节相同（庚只许动控件那一份的存法）。

## 8. Lottie 改成 remotion 式以后（癸）

- **类别**：两处声明改掉以后（`src/cards/native/lottie.tsx` 第 162 行、`src/cards/assets/index.ts` 第 46、86 行），Lottie 是 R 类：不产快照；测量走抽样那一支；判重时产轨道流；登记位置矩形。它画在 SVG 上，不是 C 类，产流走截图，不走第 6 节的直取。丁的表里 6 条 Lottie 现在登记的是 `writing: "motion"`，声明改了表要一起改，不然丁的守门测试会红。
- **判重时的流**：Lottie 在审阅表里是独立卡，走现有的单卡流；产流时不从挂载帧回放（第 4.2 节），这就是「预渲染不再从挂载帧重推」的证据来源。
- **浏览器节点**：`split.mjs` 的 `BROWSER_EXCLUDED_CARD` 照旧把 Lottie 排除在外（任务书：缺省不放开，评估写进报告）。
- **键**：声明一改，能力对象里的写法就变，Lottie 卡的节点身份、快照内容键、流键、成本记录的键都跟着变，旧的预渲染结果自然不再命中。
- **随机数那三样缺省打开**（改写表达式里的随机函数、外面那一层、属性值不留旧数）：会改画面（带随机表达式的素材换一次数，`happy2016` 有 76 帧微变），所以键也必须变。通用 Lottie 卡 `lottie` 的源码版本走导入闭包，`lottie.tsx` 改了它的键就变。5 张封装卡不一样：它们的源码版本不走闭包，只取声明里的几项（第 9.2 节），`lottie.tsx` 怎么改它们的键都不变；它们的键只在声明里的 `frameMode` 改掉的那一次变。
- **所以两件事必须同一次合入**：声明改写和随机数缺省打开放在同一次合入里。分开合的话，后合的那一次 5 张封装卡「键没变、画面变了」，旧的流和 PNG 会被错用。
- 原型还改了 `src/kernel/pinEntropy.ts`。它现在不在任何卡的源码导入闭包里；原型让 `lottie.tsx` 引它以后，只进 `lottie` 这一张的闭包（在原型分支上核过）。Lottie 没有声音，卡片声音不受影响。
- **素材的随机种子**取自素材内容的散列（原型的 `lottieSeedOf`），不取片段、不取位置：同一份素材摆在两处画面相同，和快照、流按内容寻址对得上。
- 当场算一帧要多久，量出来写进 `render-standard.md`（任务书的要求），用来判断它在弱设备上会不会判重。

## 9. 旧的预渲染结果怎么作废；新旧同时在线怎么读

### 9.1 键会从三条路变

| 路 | 是什么 | 进哪些东西 | 进不进卡片声音 |
|---|---|---|---|
| 源码版本 | `src/render/cardSourceVersion.mjs` 的 `cardSourceVersion`：这张卡的源文件，加上它一路相对导入到的文件的全文，类型导入也算。只在 `src/cards`、`src/parts`、`src/render`、`src/kernel` 四个目录里找（`src/render/cardSourceFiles.mjs`） | 预渲染结果的各种键（节点身份、快照内容键、流键、每卡 PNG 的键）、成本键 | **进**。卡片声音的身份里有它（`src/kernel/cardAudioRendition.mjs` 的 `cardAudioIdentity`）；对不上，已生成的声音被判「已过期，请重新生成」（`resolveCardAudioRendition`） |
| 代码指纹 | `server/frame-code.mjs` 的 `snapshotCode()`（名单 `SNAPSHOT_FILES`）和 `captureCode()`（名单 `CAPTURE_FILES`） | 前者进快照的内容键（单卡流的键现在取快照的内容键，也跟着变）；后者进流的 `codeVersion` 和每卡 PNG 的校验 | 不进 |
| 显式版本号 | `STREAM_CODE_VERSION`、键里写死的版本字段 | 各自那一种键 | 不进 |

用户同意过的只有「换了快照的存法以后，旧的预渲染结果作废重渲一遍」，没有同意过卡片声音被判过期。所以源码版本这一路要管住。

### 9.2 源码版本这一路：哪些文件不许碰，哪些卡躲不开

主会话 2026-10-12 转来丁的实测：`src/kernel/frameMode.mjs` 加一行注释，42 张内置卡的键全变，已生成的卡片声音被判过期（分支 `claude/rr-card-table` 的 `docs/reports/AGENT-rr-card-table.md`）。本文照 `cardSourceVersion.mjs` 的算法在 `main`（`a556b7bc`）上把闭包走了一遍（脚本没有入库；丁合入后以它的 `scripts/probes/card-table-digest-compare.mjs` 为准），分三组：

| 组 | 文件 | 在谁的闭包里 | 改了会怎样 |
|---|---|---|---|
| 甲：全体 | `src/kernel/types.ts`、`src/kernel/frameMode.mjs`、`src/kernel/cardGraph.mjs`、`src/kernel/emphasis.ts`、`src/kernel/cardGpu.ts`、`src/render/cards/gpuExecutor.ts` | 每一张按 id 找得到自己源文件的内置卡（丁实测 42 张）；用户卡只要引了 `kernel/types` 也在 | 这些卡的键全变；有声音的卡，声音被判过期 |
| 乙：有声卡另外带的 | `src/kernel/soundEffects.ts`、`src/kernel/typingEvents.ts`、`src/cards/native/sound-effects.ts`、`src/cards/native/av-pulse.tsx` | 内置的三张有声卡 `av-pulse`、`sound-notification`、`sound-keyboard` | 这三张的键变，声音被判过期 |
| 丙：经 `kernel/clock.ts` 连到渲染层的 | `src/kernel/clock.ts`、`src/kernel/registry.ts`、`src/kernel/project.ts`、`src/render/stageRpc.ts`、`src/render/streamPlayer.ts`、`src/render/placeholderHost.ts`、`src/render/createSnapshot.ts`、`src/render/snapshot/` 下四个文件、`src/render/solid.ts`、`src/render/frameWindow.mjs`、`src/render/cardCostKey.mjs` 等 29 个 | 引了 `kernel/clock` 的四个卡片文件里的五个 id：`lottie`、`focus-card`、`terminal-3d`、`probe-slow`、`probe-slow-stepped` | 这五个 id 的键变。它们都没有声音 |

58 张素材封装卡（5 张 Lottie、53 张粒子）和组合卡的源码版本不走闭包，取的是声明里的几项（id、缺省参数、控件、生命周期、`frameMode` 等）：改文件的文字不影响它们，改声明才影响。

五项各自会碰到什么：

| 项 | 会改到的、在闭包里的文件 | 源码版本这一路换键的卡 | 卡片声音 |
|---|---|---|---|
| 稀疏快照（第 2 节） | 丙组的 `stageRpc.ts` | 丙组五个 id | 不受影响 |
| 戊 | 丙组的 `placeholderHost.ts` | 丙组五个 id | 不受影响 |
| 戊二 | 丙组的 `streamPlayer.ts` | 丙组五个 id | 不受影响 |
| 己 | 丙组的 `streamPlayer.ts`、`stageRpc.ts`。`src/render/gl/` 下的文件不在任何带 id 的卡片文件的闭包里 | 丙组五个 id | 不受影响 |
| 庚 | 丙组的 `stageRpc.ts`、`snapshot/` 下的文件；`createSnapshot.ts` 如果要引新模块也算 | 丙组五个 id | 不受影响 |
| 癸 | `src/cards/native/lottie.tsx`；`src/cards/assets/index.ts` 里的声明；`src/kernel/pinEntropy.ts`（现在不在任何闭包里，原型让 `lottie.tsx` 引它以后只进 `lottie` 这一张的闭包） | 6 张 Lottie 卡，本来就要换 | 不受影响，Lottie 没有声音 |
| 先修一（粒子） | `src/cards/native/particles.tsx` | 通用粒子卡 `particles` 一张；53 张封装卡不变 | 不受影响 |

结论和规矩：

- **五项都不需要改甲、乙两组的文件，照做的话已生成的卡片声音不受牵连。** 甲、乙两组的文件五项一律不改，注释也不加。哪一块发现非改不可，停下报主会话，不自己改：那会让卡片声音被判过期，用户没有同意过。
- **丙组躲不开。** 那几个文件正是这五项要改的地方（甲一也改到了 `streamPlayer.ts`、`stageRpc.ts`）。五个 id 的键每合入一块换一次，开发用的帧库重渲这几张卡；对用户仍是发版时一次，而且只是预渲染结果。
- 新加的模块（`snapshotGrid.mjs`、`diffSnapshot.ts`、己取像素的页面钩子）不要让甲、乙两组的文件去引，否则等于改了它们的闭包。
- 守住的办法两条：每一块合入前跑丁的比对脚本，「源码版本变了」的卡只许是上表里列的，写进报告；另加一条守门测试，钉住三张内置有声卡的源码版本，值一变就红（要改这个值，先问过用户）。后一条排在第 13 节。

以后有别的改动非动甲、乙两组不可时（不在这五项里），本文想到两个办法，都没有验：

- 集中成一次：攒到一起改，并在同一次里让类型导入不进闭包（丁的报告的第 3 条建议），以后这类文件少牵连。这一次卡片声音会被判过期：预览里提示重新生成，导出开始时自动重新生成（`product/rendering.md`「有声动效卡」）。要先问用户。
- 让声音完全不被牵连：先发一版，声音的身份新旧两种算法都认（新算法只取和声音有关的文件），认上旧的就把记录改写成新的；等到存量项目都被打开过，再动公共文件。改写记录是写项目数据，要另立契约。

### 9.3 代码指纹和显式版本号这两路

现在的键里已经带着两个代码指纹：`snapshotCode()`（`server/frame-code.mjs` 的 `SNAPSHOT_FILES`，其中有 `server/bakery/` 下七个模块和 `createSnapshot.ts`、`snapshot/` 下四个文件）进快照的内容键，`captureCode()` 进流的 `codeVersion`。这五项只要改到名单里的文件，全部快照或全部流的键就会自己变一次，和改的是不是画面无关：

- 戊的「不回放」可以不动 `server/bakery/bake.mjs`：`runSegment` 不传 `mountFrame`、把预热帧数传成 0（`bakeStream` 的 `warm`）就够了，尽量这样做。
- 己的直取像素、戊二的差分取层、庚的存法要动名单里的文件，各会让全部快照或全部流作废一次。这三块排在相邻的合入里。

也不能指望它自己变：新加的文件不在名单里，改了也不换键。所以每一项落地时显式换：

| 项 | 换什么 | 作废什么 |
|---|---|---|
| 稀疏快照（第 2 节） | 不换 | 不作废。已有的逐帧快照是这一套的超集 |
| 庚 | `cardSnapshotIdentity` 的 `snapshot` 那一段加一项存法版本 `format: 2`；`diffSnapshot.ts` 进 `SNAPSHOT_FILES` | 全部快照 |
| 己 | `STREAM_CODE_VERSION` 加到 2；取像素的新文件进 `CAPTURE_FILES`；流的成员键不再带快照代码指纹（见下） | 全部轨道流 |
| 戊二 | 新的 `kind`，不动旧键 | 不作废 |
| 戊（不回放、位置矩形） | 不换。不回放不改画面（remotion 式的卡画面只由时间和参数决定），由探针核对。不动 `bake.mjs` 的话代码指纹也不变 | 不作废 |
| 癸 | 靠声明和源码版本自然变（第 8 节） | Lottie 卡的流、PNG、成本记录 |

**流的成员键去掉快照代码指纹〔裁〕**：单卡流的内容键现在取 `control.contentKey`，里面有 `snapshotCode()`。结果是改一次生成快照的代码，所有单卡流跟着作废，包括根本没有快照的 R、C 类。己落地时给 `card-cache.mjs` 的 `plan` 多算一份不带快照代码指纹的内容键，`planStreams` 用它。这一改和 `STREAM_CODE_VERSION` 加一放在同一次合入，流只作废一次。

**集中成几次。** 用户同意的是「换这一次」。对用户，三条路上的换键都落在同一次发版里，是一次。对开发用的帧库做不到一次，能做到的是：

- 全部快照的键：庚换一次（存法版本和代码指纹同一次合入）。
- 全部流的键：己换一次（`STREAM_CODE_VERSION`、成员键的算法、代码指纹同一次合入）；戊二的差分取层如果改到 `CAPTURE_FILES` 里的文件，和己排在相邻的合入里。
- 丙组五个 id：每合入一块换一次，躲不开（第 9.2 节）。
- 6 张 Lottie 卡：癸换一次。
- 卡片声音：一次都不换。

旧结果不用删：换了键以后它们不再被引用，帧库按容量上限和最近使用淘汰（`product/platforms.md`「预渲染缓存」），素材服务的像素产物同样有淘汰。

### 9.4 新旧同时在线

| 情形 | 怎么读 |
|---|---|
| 新页面读旧产物（旧渲染节点还在线，层表里是旧键、`v: 1` 的清单） | 能读，照旧贴整份 HTML（第 7.5 节末条）。层表里没有 `streams`、`rects` 就当没有 |
| 旧页面读新产物（新节点写的层表、`v: 2` 的清单） | 旧页面只读 `layers` 和清单的 `frames`、`small`：`frames` 是空的，原尺寸快照当作还没有，小尺寸照旧。`streams`、`rects` 它不认识，忽略。重卡显示占位或露活组件，不会贴错东西 |
| 新旧渲染节点同在一个项目里 | 代码版本不同，任务的 `requires.codeVersion` 把它们分在两个池子里（`server/render-node/filter.mjs` 规则 1），不会互相认领、互相接着产；键也不同，产物不混 |
| 旧浏览器节点（旧页面当节点） | 同上，认领不到新版本切出来的任务 |
| 桌面：页面和预渲染进程 | 同一个安装包，同一个版本，没有这个问题 |

已知而没有解决的一处：层表是一个项目一条，谁切分谁重写。新旧两个能切分的节点同时在线时会轮流改写它，页面上的层时有时无。线上靠部署规矩避免（几样服务同一个提交）；项目放本机、几台桌面版本不同的情形有没有别的门槛，未查清（第 14 节第 13 条）。

## 10. 基线脚本

- **`scripts/verify-unified-frames.mjs`：断言不用调。** 它验的是整场景的 HTML（`bakeFrames` 的 `onSnapshot` 回的 `html`）重放两次相同、Agent 取帧和后台趟的结果逐字节相同、导出和取帧逐字节相同，再加后台趟能跑到 `ready`、整场景的 PNG 表有全部 10 帧。这些都不是每张卡自己的快照。庚碰到它的地方只有两处：`createSnapshot`（第 7.7 节要求整场景 `html` 不变）和后台趟（`preload` 仍要跑到 `ready`）。五项里每一项合入前都跑它，结果写进报告。
- 如果实现中发现必须调它（例如后台趟不再产某样它断言的东西），照任务书的规矩：新断言覆盖同样的画面，调整前后各跑一遍，结果写进报告，记待用户审。本文没有预见到这种情况。
- **`scripts/probes/export-baseline-compare.mjs`、`scripts/verify-determinism.mjs`：不动。** 它们走导出的整帧截图，不经过每张卡的快照和流。导出像素基线照任务书「验证」一节，不许自行重定。
- **庚要另加的断言**（放在庚自己的探针里，不放进上面的脚本）：新贴法贴出来的 DOM 和整块替换逐节点相同（顺着贴、跳着贴）；由「基准加差异」还原出来的整帧 HTML 和旧存法的逐字节相同。
- **跟着稀疏化和新存法要核对的单测和探针**（按标识符搜出来用到了「一段齐了没有」的判据、快照趟或清单形状的，没有逐个读，改的时候逐个核）：`server/test/` 下的 `artifact-transfer`、`artifact-adopt`、`artifact-dedup`、`artifact-push`、`artifact-png`、`prerender-executor`、`prerender-schedule`、`card-lock-pipeline`、`small-tier`、`render-node-logic`、`render-queue-protocol`、`queue-node-wiring`、`ready-session-isolation` 各测试；`src/online/bakeTask.test.mjs`；`scripts/probes/m7-*`、`scripts/probes/c10-browser-probe.mjs`、`scripts/probes/preview-fallback-probe.mjs`、`scripts/probes/stream-produce-probe.mjs`。改的时候同样不许放松：原来对「每一帧」的断言改成对「这一套里的每一帧」，不许改成「有几帧算几帧」。

## 11. 用户看得到区别的地方

| # | 什么情形 | 改前 | 改后 | 谁定的 |
|---|---|---|---|---|
| 1 | 拖动、点击后还没追到精确画面时，motion 式的 DOM 重卡 | 贴这一帧的快照（产齐以后逐帧跟手） | 贴不晚于这一帧的最近一张，每 15 帧一跳；松手后是精确画面 | 用户 2026-10-12 已定 |
| 2 | 同上，画布卡 | 贴这一帧的快照 | 贴轨道流的这一帧。起步等流的第一帧时露着上一刻的画面，最多 500 毫秒；流里的细线比活渲淡，松手换回活渲时有轻微变化 | 〔裁〕第 3 节 |
| 3 | 同上，remotion 式的重卡 | 露出活组件当场算 | 有流贴流的这一帧，没有流照旧 | 〔裁〕第 3 节 |
| 4 | 播放中流有一拍画不出来，画布卡和 remotion 式的重卡 | 画布卡露出垫着的快照 | 没有快照可露，满 120 毫秒显示占位符 | 用户已定（没有快照的卡跳过这一步） |
| 5 | 在线浏览器播放没有轨道流的 motion 式 DOM 重卡 | 每拍换一张快照 | 每 15 帧换一张 | 未定，第 14 节第 2 条 |
| 6 | 播放依赖下层的重卡（毛玻璃一类、没登记的卡） | motion 式的每拍贴本地档快照；remotion 式的一直占位 | 贴轨道流 | 用户已定要产流；流里放什么、怎么盖是〔裁〕第 5.3、5.4 节 |
| 7 | 打开项目时的测量遮罩 | 快照趟每张卡只做 0～1 帧 | 推完整段、每 15 帧一张，遮罩时间变长（多少要量） | 用户已定在测量时产；时间未量，第 14 节第 3 条 |
| 8 | 升级后第一次打开旧项目 | — | 快照和轨道流重渲一遍 | 用户已同意 |
| 9 | 占位符的位置，remotion 式和画布的重卡 | 没有流时只在位置框中心放一个小徽标（或用当场量的框） | 有登记的位置矩形，显示成实体框上的沙漏加噪点 | 〔裁〕第 4.1 节 |
| 10 | 快照的体积上限 | 一帧超过 300 KB 不投递 | 按块判，现在合格的卡不变 | 〔裁〕第 7.6 节 |
| 11 | 低内存档、最低一档的设备上，画布卡和 remotion 式的重卡 | 画布卡有预渲染小尺寸可贴 | 没有小尺寸，只有占位，停下后逐层渲 | 未定，第 14 节第 10 条 |
| 12 | 带随机表达式的 Lottie；`happy2016` | 每次挂载画面不同；顺着推和直接跳差 74 个像素 | 每次相同（数换一次）；`happy2016` 有 76 帧微变 | 用户已定 |
| 13 | 已经生成的卡片声音（`av-pulse`、提示音、键盘声，以及带声音的用户卡） | 有效 | 照第 9.2 节做，不受影响，一次都不会被判过期。只有哪一块改了第 9.2 节甲、乙两组里的文件才会被判「已过期，请重新生成」（预览里提示，导出开始时自动重新生成）；用户没有同意过，所以不许发生，非改不可先问用户 | 用户没有同意过；本文定为不许发生 |
| 14 | 升级后第一次打开旧项目，丙组五个 id（`lottie`、`focus-card`、`terminal-3d` 和两张探针卡）与 6 张 Lottie 卡 | — | 成本记录重测一次、预渲染结果重渲一次。和第 8 行是同一次，不另外多出一次 | 随第 8 行 |

对外数据格式的改动（三级，用户看不出区别，照规则标〔裁〕）：快照清单 `v: 2` 与 `want`、`bases`、`patches`；流清单的 `kind: 'below'`；层表的 `rects`；流的成员键换算法；流任务的名次排到快照任务之下。

## 12. 语义文档要跟着改的

任务书「语义文档要跟着改的」那张表的第 7、11 行，具体措辞如下。都在 `docs/semantics/mechanism/rendering.md`，三级。执行到对应那一项时改，随那一项合入；本文不改语义文档。

### 第 7 行：「重管线：预渲染」的「两种形态」（戊、戊二、己、庚）

修改前：

> - 两种形态：
>   - **快照**：用于暂停和拖动，也是播放中的兜底。每张重卡每帧一份 HTML 快照，只含该卡的子树，画布已栅格成带实体框的图片。
>   - **轨道流**：用于播放。每张重卡一条上下拼合 alpha 的 H.264 视频流，裁到实体框。同时活跃的流超过硬件解码器预算时，把相邻重卡合并成一条组流。
> - 超过体积上限的快照帧（DOM 卡 300 KB、画布位图 1 MB）不投递，那一层按缺料处理。

修改后：

> - 两种形态：
>   - **快照**：用于暂停和拖动，也是播放中的兜底。只含该卡的子树。结构存一份，每帧只存和它不同的地方；任意一帧都能单独贴出来，贴的时候只改不同的地方。不是每帧都存，见「测量」。
>   - **轨道流**：用于播放；没有快照的卡在暂停和拖动时也贴它。每张或每组重卡一条上下拼合 alpha 的 H.264 视频流，裁到实体框。同时活跃的流超过硬件解码器预算时，把相邻的独立重卡合并成一条组流。
> - 预渲染存什么，按写法和画在什么上分：
>   - remotion 式的卡不存快照，只登记整张卡的位置矩形；判重时产轨道流。
>   - 画面全在画布里的卡（画布与 WebGL）只产轨道流，画面从画布直接送进编码器，不存每帧图片；同样登记位置矩形。
>   - motion 式的 DOM 卡快照和轨道流都产。
> - 轨道流怎么产，按依不依赖下层分：独立卡单独产流；依赖下层的卡（含审阅表没覆盖到的卡）连同下层一起渲染来产流，流只含目标卡改动的那一块区域，这段时间里下层任一控件变了就作废重产。
> - 快照的结构那一份、每帧差异那一份各不超过 300 KB；超了的帧不投递，那一层按缺料处理。

说明：最后两条里「流只含目标卡改动的那一块区域」和体积上限的判法是〔裁〕（第 5.3、7.6 节）。用户审过之前，措辞按用户审定的写；被推翻时这两句照推翻后的做法改。

### 第 11 行：「测量」与「重管线：预渲染」（戊、庚）

「测量」一节，修改前：

> - 测量分两趟：第一趟只计时、不生成快照；第二趟才生成快照并存下。「太慢」按单帧判，不按整趟的累计时间截断。

修改后：

> - 测量分两趟：第一趟只计时、不生成快照；第二趟顺便产一套快照并存下，每隔 15 帧一张（另加每个片段挂载、退场的那几帧），只给存快照的卡做。「太慢」按单帧判，不按整趟的累计时间截断。

「重管线：预渲染」一节，修改前：

> - 预渲染只在闲时进行，不服务用户的即时交互。

修改后：

> - 预渲染只在闲时进行，不服务用户的即时交互。快照在打开项目、测量卡片的时候顺便产一套；之后要补的只在暂停时产，播放时不产；先后上快照排在轨道流前面。

「兜底顺序」第一条的第 3 步后面补半句：

> 3. 同一区间内最近的一帧快照（向前回溯，不跨区间；不存快照的卡没有这一步）

### 本文另外查到、任务书的表里没有的

只列出来，不给定稿措辞，由主会话决定加不加进任务书的表：

- `mechanism/rendering.md`「兜底顺序」的「在线浏览器没有轨道流：重层每拍换一次 HTML 快照」和 `product/platforms.md`「在线浏览器」的「播放」（任务书第 3、6 行改过以后仍写着没有流的层每拍换快照）：快照每 15 帧才有一张以后，这句话不成立。`platforms.md` 那一处是二级（第 15 节第 2 条）。
- `mechanism/rendering.md`「降级」的「就绪」：快照的「覆盖」要读成「这一套里的帧都在」。
- `product/rendering.md`「兜底顺序」的占位符：量不到实体框时放徽标，这句不用改；登记的位置矩形算「量得到」。

## 13. 施工拆分

文件按「道」分，同一条道里的块串行，不同的道可以并行；每个文件只属于一条道。每一块属于哪一项写在表里。档位是建议。

### 13.1 各道的文件

| 道 | 文件 |
|---|---|
| 一：流的计划与生产 | `server/frame-stream.mjs`、`server/bakery/bake.mjs`、`server/bakery/ffmpeg.mjs`、`server/bakery/capture-frame.mjs`、`server/card-identity.mjs`、`server/card-cache.mjs`、`server/frame-code.mjs`、`server/render-node/split.mjs`、`server/render-node/filter.mjs`、`src/render/streamInputSig.mjs`（甲一加的）；己取像素的页面钩子：`src/ExportView.tsx`、`src/render/gl/` |
| 二：快照库与清单 | `server/frame-pipeline.mjs`、`server/snapshot-store.mjs`、`server/snapshot-tier.mjs`、`server/artifact-transfer.mjs`、`server/artifact-push.mjs`、`server/prerender-executor.mjs`、`server/ready-index.mjs`、`server/vite-plugin-frames.ts`、`src/render/snapshotGrid.mjs`（新）、`src/render/createSnapshot.ts`、`src/render/snapshot/` |
| 三：舞台与父页 | `src/StageView.tsx`、`src/render/Stage.tsx`、`src/render/streamPlayer.ts`、`src/render/planeStyle.ts`、`src/render/placeholderHost.ts`、`src/render/stageRpc.ts`、`src/editor/snapshotFeed.ts`、`src/editor/Preview.tsx`、`src/editor/probeRunner.ts`、`scripts/probe-card-costs.mjs` |
| 四：在线来源与浏览器节点 | `src/render/snapshotSource.ts`、`src/online/bakeTask.ts`、`src/online/browserNode.ts`、`src/editor/browserNodeHost.ts`、`src/editor/stageBake.ts`、`src/online/l2.ts` |
| 五：Lottie | `src/cards/native/lottie.tsx`、`src/cards/assets/index.ts`、`src/kernel/pinEntropy.ts`、`src/cards/capabilities.json` 与 `capabilities.md` 里 Lottie 的 6 条、`scripts/probes/lottie-*`、`render-standard.md` 的 Lottie 一节 |
| 六：粒子卡 | `src/cards/native/particles.tsx` 和它用的粒子视图；根因落在舞台时钟时加 `src/render/stageClock.ts`。根因落在 `src/StageView.tsx` 的追帧一段时，这一块并进道三，排在道三最前面 |

每一块自己的新探针、新单测归这一块。道一的 `card-cache.mjs`、道二的 `snapshot-tier.mjs` 这种一两行的改动，如果别的道的块要用，由拥有它的道先做、先合。

所有块共同的两条：

- **不许改的文件**（第 9.2 节甲、乙两组）：`src/kernel/types.ts`、`src/kernel/frameMode.mjs`、`src/kernel/cardGraph.mjs`、`src/kernel/emphasis.ts`、`src/kernel/cardGpu.ts`、`src/render/cards/gpuExecutor.ts`、`src/kernel/soundEffects.ts`、`src/kernel/typingEvents.ts`、`src/cards/native/sound-effects.ts`、`src/cards/native/av-pulse.tsx`。派活时写进每一块的文件清单；非改不可就停下报主会话。
- 每一块合入前跑丁的 `scripts/probes/card-table-digest-compare.mjs`，「源码版本变了」的卡只许是第 9.2 节表里列的，结果写进这一块的报告。

### 13.2 各块

| 块 | 项 | 做什么 | 道 | 等谁 | 验收探针 | 档位 |
|---|---|---|---|---|---|---|
| 先修一 | 己之前 | 粒子卡往回跳以后停下，画面不是这一刻的（任务书「己」的「先要修的两处」第 1 条） | 六 | 不等 | 新探针：同一帧往回跳到达和往前到达，两张的差在编码误差量级以内，并且和别的时刻比明显更大；逐帧比对这张卡改前改后的导出 | Opus high（根因不明） |
| 先修二 | 己之前 | 手按着标尺不动时快照贴不上（同上第 2 条）：`deliverSnapshots` 被节流挡掉以后补一次 | 三 | 不等 | 新探针：按住 12 处各 2.5 秒，12 处都贴上 | Sonnet high |
| 网格 | 戊、庚 | `snapshotGrid.mjs` 和单测；`snapshotTier` 给页面一侧用的入口 | 二 | 不等 | 单测 | Sonnet high |
| 守门 | 全部 | 一条新的守门测试：钉住三张内置有声卡（`av-pulse`、`sound-notification`、`sound-keyboard`）的源码版本，值变了就红；顺带断言第 9.2 节甲、乙两组的文件清单没有变长（新文件进了有声卡的闭包也红）。只加测试文件，不改产品代码 | 单独一个新文件，不属于哪条道 | 丁（借它读内置卡声明的夹具 `src/testing/loadBuiltinCards.mjs`） | 故意在 `src/kernel/frameMode.mjs` 末尾加一行注释，测试变红；还原后变绿 | Sonnet medium |
| 稀疏一 | 戊、庚 | 预渲染进程：稀疏快照趟、几处「齐了没有」、清单的 `want`、先快照后流（第 2.3、2.4 节） | 二 | 网格 | 探针：预渲染完，M 类卡的快照目录里正好是这一套；流在快照齐了之后才开始产；`verify-unified-frames.mjs` 照过 | Opus medium |
| 稀疏二 | 戊、庚 | 测量的快照趟（第 2.2 节）、缺口上报、降级的就绪判据（第 2.6 节） | 三 | 网格、先修二 | 探针：打开项目后每张 M 类独立卡的这一套是齐的；遮罩时间改前改后各记一个数；拖动时每 15 帧一跳、只往回找 | Opus medium |
| 稀疏三 | 戊、庚 | 在线来源、浏览器节点、清单判齐、在线测量帧留用（第 2.3、2.4、2.5 节） | 四 | 网格、甲一 | 浏览器节点的验收探针（`m7-*`）按新判据照过；只开在线页面时拖动能贴上本页测量出的快照 | Opus medium |
| 不回放 | 戊 | 产流不回放（第 4.2 节）；`planStreams` 带上成员的写法。不动 `server/bakery/bake.mjs` | 一 | 甲一（在线那一句） | 探针：remotion 式重卡的流 `replayed` 为 0；流的画面和回放着产的逐帧相同；生成快照的代码指纹改前改后相同 | Sonnet high |
| 矩形一 | 戊 | 位置矩形：量、帧库、层表、就绪消息（第 4.1 节的服务端一半） | 二 | 稀疏一 | 任务书戊的探针里「有位置矩形」那一条 | Sonnet high |
| 矩形二 | 戊 | 位置矩形的取用（`placeholderHost`、在线读层表的 `rects`） | 三、四各一小块 | 矩形一 | 占位符探针：没有流时 remotion 式重卡的占位符是实体框，不是徽标 | Sonnet high |
| 己零 | 己 | 在节点和 PC 上量两条路（第 6.3 节） | 不改产品代码 | 甲一的压和封装两个模块（没合入时直接用分支 `claude/browser-stream-encode` 上的探针） | 报告里有第 6.3 节的全部数字 | 主会话安排 |
| 己一 | 己 | 「画面全在画布里」的登记核对和实测判定；直取像素进编码器；`STREAM_CODE_VERSION` 加一；流的成员键去掉快照代码指纹 | 一 | 己零、不回放、丁 | 任务书己的验收：新旧两条路的流逐帧比；预渲染耗时改前改后 | Opus high |
| 己二 | 己 | 画布卡不存快照（`snapshotTier` 加一条、测量不跑快照趟、体积上限那一档） | 二、三各一小块 | 己三（拖动先接好再撤快照） | 帧库和素材服务里没有画布卡的每帧快照 | Sonnet high |
| 己三 | 己 | 暂停和拖动贴流：合入原型分支，去掉开关，照第 3 节定的做 | 三 | 先修一、先修二、稀疏二 | 第 3.7 节 | Opus high |
| 下层一 | 戊二 | 依赖下层的流：计划、键、输入签名的 `below` 一支、隔离工程、切分与认领（第 5.1、5.2 节）。层表的 `layerStreamsOf` 认 `below` 是道二的一行改动，交给道二当时在做的那一块 | 一 | 不回放、甲一 | 单测：下层改一处键和输入签名就变、上层改不变；切分出的任务浏览器节点认领不了 | Opus high |
| 下层二 | 戊二 | 差分取层的产流（第 5.3 节）；先做探针量耗时和编码后的误差，再定用不用 | 一 | 下层一 | 任务书戊二的探针；另加一个带半透明下层的场景，比差分取层和原样盖的误差 | Opus Extra |
| 下层三 | 戊二 | 贴回舞台（第 5.4 节） | 三 | 下层二、己三 | 同上 | Opus medium |
| 下层四 | 戊二 | 在线来源读 `below` 的行和清单、按输入签名判过期（甲一的解析现在只认 `card`、`group`，别的行跳过） | 四 | 下层一、甲一 | 在线页面：桌面产好依赖下层的流，页面播放时贴上；改下层一张卡，旧流立刻不贴 | Sonnet high |
| 庚一 | 庚 | `diffSnapshot.ts`、落盘、存法版本（第 7.1、7.2、9.3 节） | 二 | 稀疏一、矩形一 | 还原出的整帧 HTML 和旧存法逐字节相同；整场景 `html` 不变；占用空间改前改后 | Opus high |
| 庚二 | 庚 | 清单 `v: 2`、推送拉取、读口（第 7.3、7.5 节的服务端） | 二 | 庚一 | 两台节点之间推拉一段再贴；旧清单照旧能读 | Opus medium |
| 庚三 | 庚 | 舞台贴法、压住过渡、投递（第 7.5 节的页面一半） | 三 | 庚二、下层三 | 任务书庚的验收：逐节点相同、跳着贴、贴一帧的耗时改前改后 | Opus high |
| 庚四 | 庚 | 在线取用、浏览器节点产的那一份（第 7.4、7.5 节） | 四 | 庚二、稀疏三 | 在线的暂停、拖动截图和改之前一致 | Opus medium |
| 癸一 | 癸 | 留底；合入原型分支；两处声明和随机数三样缺省打开同一次合入；开关到得了导出页和舞台 | 五 | 不回放、丁 | 任务书癸的验收；原型的 `lottie-seed-probe.mjs` | Opus medium |
| 癸二 | 癸 | 量当场算一帧的耗时；评估浏览器节点产 Lottie 的流；补测原型没测到的几样 | 五 | 癸一 | 报告 | Sonnet high |

### 13.3 先后

1. 不等甲一就能开的：先修一、先修二、网格、稀疏一、癸的留底。守门等丁合入就做，排在别的块合入之前。
2. 甲一合入以后：稀疏二、稀疏三、不回放、己零。
3. 之后三条线并着走：道一上「不回放、己一、下层一、下层二」；道二上「稀疏一、矩形一、庚一、庚二」；道三上「先修二、稀疏二、己三、矩形二、下层三、庚三」。道四跟着道二、道三的对应块走。道五独立。
4. 会让全部快照或全部流换键的块（己一、庚一，以及下层二如果动到截图那几个文件）尽量挨着合入（第 9.3 节）。
5. 己二排在己三之后：先让拖动贴得上流，再撤快照，中间不出现「没有快照、也贴不了流」的一段。

## 14. 拿不准、要主会话或用户定的

| # | 什么事 | 选项 | 本文的推荐和理由 |
|---|---|---|---|
| 1 | 「之后要补的」补到多密 | 甲：只补齐每 15 帧一张的这一套。乙：暂停时接着加密到每帧。丙：只在播放头附近加密 | 甲。用户说的是「之后要补的」，没有说加密；并且快照排在流前面，加密到每帧会把流一直挡在后面。本文全篇按甲写，密度只在 `snapshotGrid.mjs` 一处，改成乙或丙不用动别处。选甲的后果见第 2、15 条 |
| 2 | 在线浏览器播放没有流的 motion 式 DOM 重卡，从每拍换一张变成每 15 帧一张 | 甲：接受，改 `product/platforms.md`（二级）。乙：托管方的渲染节点缺省产流。丙：这种卡在没有流时继续每帧产快照 | 报用户。甲三缺省关的理由只说了暂停时不靠渲染节点，没有说播放；身份为手机的页面自己不产流，托管方不开流时，它播放这类卡只剩每 15 帧一张 |
| 3 | 测量的快照趟推完整段，遮罩变长 | 甲：照用户原话在遮罩下产完。乙：遮罩下每张卡给一个墙钟上限，到时就停，没产到的归「之后要补的」。丙：遮罩下不产，遮罩后在后台舞台产 | 乙，上限的数量过再定。用户定了「测量时顺便产」，但当时听到的现状是「每帧都拍」；实际现状每张卡只产 0～1 帧，一张 20 秒的卡推完整段在在线页面里约 3 秒 |
| 4 | 依赖下层的流里放什么、怎么盖 | 甲：差分取层。乙：原样盖 | 甲，理由和实测在第 5.3 节。和用户原话字面有出入，要用户审 |
| 5 | 依赖下层的流的键带多少下层 | 甲：时间重叠的全部下层。乙：再按区域筛。丙：整个项目的键 | 甲。乙要可靠的区域判断（下层的内容会溢出自己的框），先不做 |
| 6 | 画布卡的像素走哪条路 | 第 6.2 节两条 | 量完再定；缺省 ffmpeg 那条 |
| 7 | 换存法以后的体积上限 | 甲：基准和差异各不超过 300 KB。乙：按还原出来的整帧判。丙：放宽基准的上限 | 甲。丙会让现在超限的大卡变得可用，是用户看得到的变化，要用户定 |
| 8 | 在线又没有切分节点时，位置矩形谁写进层表 | 甲：甲二的页面写层表时一并写。乙：这种情况不登记，占位符退回徽标 | 甲，等甲二的执行方确认 |
| 9 | 在线页面测量出的快照推不推素材服务 | 甲：跟着甲二，页面能算键以后推。乙：只在本页用 | 甲 |
| 10 | 低内存档和最低一档的设备上，画布卡和 remotion 式的重卡没有小尺寸可贴 | 甲：接受，等 0.7.19 撤掉低内存档。乙：低内存档也贴流（要动任务书说照现状保留的分支）。丙：给这些卡每 15 帧另产一张小图 | 报用户。不处理的话这些设备上画布卡比现在差 |
| 11 | 暂停时同屏第 7 张走流的卡 | 甲：解完一帧让出解码器、排队。乙：占位符。丙：露活组件（原型现状） | 甲 |
| 12 | 画布之外还有别的元素的画布卡，存不存快照。任务书「己」写这种卡「照现在的办法」，可以读成只指像素怎么取，也可以读成连快照也照旧存 | 甲：算 C 类，不存快照，流走截图。乙：照旧存快照（要在丁的表里多登记一样，并且动得到 `frameMode.mjs` 或能力对象，会连带换键） | 甲。不用加字段、不换键，也合「不存图片」。内置卡里现在有没有这种卡，未逐张核 |
| 13 | 新旧两个能切分的节点同在一个项目里，层表被轮流改写 | 甲：靠部署规矩（同一个提交）。乙：层表按代码版本分键 | 甲。项目放本机、桌面版本不同的情形未查清 |
| 14 | 源依赖卡（转场、接素材的素材效果卡）进不进戊二的流 | 进、不进 | 这次不进，任务书没有点名 |
| 15 | 选了第 1 条的甲以后，庚还做不做全套 | 甲：照做。乙：只做落盘，不改贴法 | 报用户。快照已经稀了 15 倍，庚省下的空间和贴一帧的耗时都只剩原来十五分之一的量级；任务书定的是全做，本文按全做写 |
| 16 | 哪一块发现非改第 9.2 节甲、乙两组的文件不可（会让已生成的卡片声音被判过期） | 甲：不改，换做法。乙：攒成一次改，同一次里让类型导入不进源码闭包，先问用户。丙：先发一版让声音的身份新旧两种算法都认，再改 | 甲。五项按本文的做法都用不着改这些文件；乙、丙是给别的项（例如乙的框架如果要动 `kernel/types.ts`）留的，没有验 |
| 17 | 丙组五个 id 每合入一块换一次键 | 甲：接受（对用户是一次，只是预渲染结果）。乙：根治。渲染层是被 `kernel/clock.ts` 的全局类型声明里那几句 `import('../render/…')` 带进闭包的，源码版本的算法把它们当成了导入；要么改算法让类型导入不算，要么挪走这几句。前一种会让全部内置卡换键、卡片声音被判过期（同第 16 条的乙）；后一种改的是 `clock.ts`，只让这五个 id 换一次键 | 甲。乙不在这五项的范围里，记待办 |

## 15. 和任务书、语义对不上的地方

只列出来，不自行取舍。

1. **任务书说「现在测量的快照趟是每帧拍一次，要改稀」。** 实际上它受一拍预算截断，每张卡只产出 0～1 帧（第 2.2 节）。落成「一套」是加量，不是减量。
2. **`product/platforms.md`「在线浏览器」的「播放」写没有流的重卡每拍换一张快照**（任务书第 3 行改过以后也是）。每 15 帧一张以后不成立，这是二级的改动，任务书的表里没有（第 14 节第 2 条）。
3. **`mechanism/rendering.md`「测量」写「不按整趟的累计时间截断」**，代码里快照趟按累计时间截断。这是现状里代码和语义的出入，第 2.2 节的改法顺带消掉它。
4. **任务书「戊二」写「流里已经带着下层的画面」。** 本文推荐的差分取层，流里只有目标卡改动的那一块（第 5.3 节，〔裁〕）。
5. **任务书「甲三」缺省关的理由**是暂停时不靠渲染节点也能看任意一帧。快照稀疏以后，播放流不流畅完全靠流，这个理由没有覆盖播放（第 14 节第 2 条）。
6. **`render-standard.md`「预渲染的产物」的表写 remotion 式、当场算得过来的卡也登记位置矩形**；任务书「戊」写的是给重卡登记。本文按任务书：不判重的卡一直活渲，用不到矩形，并且「在所有位置都判轻的卡不产任何预渲染结果」这一条不变。
7. **任务书「己」写不再为画布卡存每帧快照。** 预渲染小尺寸是从快照缩出来的，这类卡从此没有小尺寸（第 6.4 节、第 14 节第 10 条）；`product/rendering.md`「两档」写渲染节点产出原尺寸后一并生成小尺寸，对这类卡不再成立。
8. **任务书「庚」写「任意一帧都要能直接贴出来」**，同一份任务书定了每隔 15 帧一张。两句不冲突，但放在一起以后庚的收益变小（第 14 节第 15 条）。
9. **`render-standard.md`「预渲染的产物」的现状描述**（每张重卡每一帧存一份 HTML、每张重卡一条轨道流）任务书已经指出不准；另外它写快照「也是在线浏览器播放重卡的唯一来源」，甲一合入后不再是。
