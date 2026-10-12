# 在线浏览器生成和播放轨道流：接入任务

2026-10-09 用户定「在线浏览器也要能生成和播放轨道流」（见 `render-standard.md`「预渲染的产物」），2026-10-10 用户说「做成，然后合入」。本文件记下这件事做了什么、每一处改在哪里、怎么验的、合入之后还差什么。

**2026-10-12 用户定：产流走两条路，这次一起做。** 一条是本文件写的、经过任务队列的路（下面的七处，任务书 `render-refactor-task.md` 的「甲一」）；另一条不经过任务队列：线上没有能切分的节点时，在线页面给本页能运行的重卡自己压、自己播。第二条的要求和验收写在 `render-refactor-task.md` 的「甲二」，做法与〔裁〕在本文件的「本页产流」一节，前面的七处不变。

**状态（2026-10-13）：七处都已做完，另补了把两半接起来的一环，在集成分支 `claude/rr-a1` 上，待合入 `main`。** 三份子 Agent 报告：`docs/reports/AGENT-rr-a1-produce.md`（第一到四处）、`AGENT-rr-a1-play.md`（第五到七处）、`AGENT-rr-a1-integ.md`（接起来的一环、整条链的端到端验收）。

## 先有的两个模块

| 文件 | 做什么 |
|---|---|
| `src/render/streamMux.ts` | 把 H.264 封成现有的分段格式 |
| `src/render/streamEncode.ts` | 把每帧画面拼成上半颜色、下半透明度，用浏览器自带的编码器压，每 15 帧交一段 |
| 两份单测、两个探针 | 见 `render-standard.md` |

这两个文件原样接上了，没有改。

## 流程（做完之后）

1. 在线页面只发布「给这一版项目做计划」这一个粗任务，带着自己判重的片段清单（清单计划，`src/online/planPublisher.ts`）。
2. **切分只有桌面应用和独立渲染主机能做**：它们认领粗任务，在自己的 Chrome 里算出每张卡的键，切成细任务发回队列（`server/render-node/local-node.mjs` 调 `split.mjs` 的 `splitPlan`）。浏览器节点不能认领粗任务（`server/render-queue/queue.mjs`）。
3. 切分时，浏览器做得了的卡（共享档、独立卡、轻或中等、不是画布卡、不是 Lottie）的快照任务多出一份给浏览器的；这张卡的**单卡流**同样多出一份给浏览器的。**清单计划原来一条流任务都不切**（`listPlanOverrides` 写死 `streams: []`）；「甲一」起按清单里的片段算流、给浏览器出一份；**「甲三」起切分方自己能产流时连自己的那一份一起出**（只出单卡流；托管方的渲染节点另要这个项目的「生成轨道流」开着，见 `hosted-render-contract.md` 第 3.1 节）。切分方自己不能产流（没有生产者、关着流开关、托管方的这一项关着）时只有浏览器那一份。
4. 浏览器节点认领到快照任务后，后台舞台逐帧生成快照，推到素材服务，往内容库写一份清单；认领到流任务后，逐段逐帧向舞台要像素、用浏览器自带的编码器压、把开头文件和分段推到素材服务的像素那一类、往内容库写一份流清单（`src/editor/browserNodeHost.ts`）。
5. 切分完成后，切分方按实际出键写层表。层表除了每张卡的快照层，另带一张 `streams` 表：每条流一行，候选里是实际被派过这条流的指纹。
6. 在线页面靠层表知道每张卡有哪些快照、哪些流（`src/render/snapshotSource.ts` 的 `OnlineSnapshotSource`）：按播放头附近的范围取流清单，把清单里的开头文件和分段取到本页，字节到了的分段才算就绪。
7. 父页挑流的逻辑（`src/editor/snapshotFeed.ts`）和播放器（`src/render/streamPlayer.ts`）不分桌面和在线。在线页面里流的清单和字节由父页随流平面一起推给舞台，舞台不自己取。

## 七处（都已做）

### 一、切分：单卡流多出一份给浏览器的（已做）

`server/render-node/split.mjs` 的流任务那一段。条件照快照那一套（`browserEligible`），另外只给单卡流（组流不给，组流要把几张卡连同摆放一起画，浏览器这条路画不了）。浏览器那一份：

- 结果键 = 流的内容键 × 浏览器指纹（用户卡、素材效果卡用页面的 `cardEnvFingerprint`）；`requires.envFingerprint` 同它；`requires.transcode` 为假；仍要求 `capabilities.streams`。
- `input` 里带页面要的东西：`dual`、`compositing`、`bake`（同快照那一份），再加 `stream`：`{ kind: 'card', plane: 'local', clipIds, fps, bound, offset, firstFrame, count, total }`。页面不自己算这些。
- 流标了 `browserOnly` 时不出切分方自己的那一份（清单计划用）。浏览器指纹与切分方指纹相同时不另出。
- 调用方：只传流键和分段范围的那一处在 `server/frame-pipeline.mjs` 的 `planForQueue`（不是 `local-node.mjs`）。现在每条流经 `server/frame-stream.mjs` 的 `queueStreamOf` 连同形状交给切分；清单计划的流由 `planForQueue` 给的 `browserStreamsFor`（`listStreamSpecs`）按清单里的片段算，`local-node.mjs` 的 `listPlanOverrides` 给它们标上 `browserOnly`。

### 二、节点侧过滤：流任务不再一律要求转码（已做）

`server/render-node/filter.mjs` 规则 2 改成只看任务自己写的 `requires.transcode`。桌面的流任务本来就写了 `transcode: true`，行为不变。另在规则 7 加了浏览器流任务的形状闸：纯浏览器只收 `input.stream` 是单卡流、带 `input.bake`、独立卡、不是画布卡的流任务。

过滤只在节点一侧跑：`server/render-queue/queue.mjs` 不引 `filter.mjs`，**文档服务不用为这一处重新部署**。要重新部署的是在线编辑器（页面包里带着 `filter.mjs`）和切分方（桌面应用、渲染主机）。

### 三、舞台：生成一帧时顺带交出像素（已做）

`src/render/stageRpc.ts` 的 `BakeFrameRequest` 加了 `pixels: { rect }`（平面坐标，就是流的 `bound`）和 `html`（只要像素的调用方不收 HTML 字节）。`src/StageView.tsx` 的 `bakeFrame` 在生成快照之后，照 `src/render/bakeSmall.ts` 的办法按原尺寸把矩形画成位图（`ImageBitmap`），随 `bake-frame` 事件转移给父页；画不出来回 `pixels-failed`。

父页对跨源舞台的事件只留认得的字段，所以**父页的消息守卫 `src/online/stageMessageGuard.ts` 也要放行**：`bake-frame` 事件里的位图要真是 `ImageBitmap`、大小与矩形一致、矩形为整数且不超过 8192。

### 四、浏览器节点：认领并执行流任务（已做）

- `src/online/browserNode.ts`：能力位 `streams` 由宿主报（`probeStreamEncoder` 说能压才报真）；`render` 里放行 `kind: 'stream'`，交给宿主的新方法探编码器在 Worker 里问（`streamEncode.ts` 的 `askConfigSupportInWorker`）：在主线程上第一次问会留下一个 50～120 毫秒的长任务，正落在「生成快照期间主文档没有长任务」的时间段里；问不了才退回主线程。
- `src/editor/browserNodeHost.ts`：按任务的 `input.bake` 建隔离单卡工程；任务范围里每个分段 15 帧，全局帧号减去 `firstFrame` 得本地帧，不在卡的范围里的帧送全透明；每帧向舞台要像素，送进 `openStreamEncoder`；每段出来后算哈希，把开头文件和分段推到素材服务的像素那一类；全部做完往内容库写一份流清单（`render-manifest`，键是 `<结果键>:<起>-<止>`），再报完成。让路、中止、丢认领照快照任务的规矩；让路时已经满了的分段留着，重新认领只补缺的。

清单的形状和桌面产的一样，桌面能把浏览器产的流拉回去落盘（`server/artifact-transfer.mjs` 的 `collectStreamResult` 是样板，这一处不用改）：

```
{ v: 1, kind: 'stream', resultKey, range: { from, to },
  header: { kind: 'card', plane: 'local', clipIds, fps, bound, offset, tight: null },
  inits:    { <开头文件哈希的前 16 位>: { hash, bytes, codec, width, height, timescale, rect, encoder } },
  segments: { <分段号>: { hash, bytes, init, stride: 1, samples, sig: null, encoder } } }
```

浏览器只产满密度的分段（`stride: 1`），矩形固定用 `bound`，不做「先稀疏、再收紧」那两步。`encoder` 写 `webcodecs-avc`。

### 五、层表：把流写进去（已做）

`server/artifact-transfer.mjs` 的 `layerMapOf` 多一张 `streams` 表（`layerStreamsOf`），每条流一行：

```
{ topClipId, clipIds, kind: 'card' | 'group', plane: 'local' | 'stage', contentKey,
  candidates: [{ envFingerprint, resultKey }], firstSegment, lastSegment, segmentsPerTask, inputSig? }
```

- 候选照快照层的做法：切分实际出键的指纹在前（按发布顺序，`splitStreamCandidatesOf` 收集，记在管线的切分候选记录里，键带 `stream:` 前缀），再补上这条流自己的指纹。
- `inputSig` 是流的输入签名（`src/render/streamInputSig.mjs`）：比快照层的签名多算了片段在时间轴上的位置（流按全局帧号分段）；组流另算成员的摆放和上下顺序。页面按当前项目算同一个签名，对不上就不播。
- 旧页面只读 `layers`，不认识的字段会忽略，所以没升版本号（仍是 3）。没有流时不带 `streams` 这一项，层表与以前逐字相同。
- **哪些流进表**（`server/frame-pipeline.mjs` 的 `layerMapStreamOptions`，写层表的两处都经它）：一是切分方自己这一版要产的流（与生产者同一份流计划；没有生产者或关着流开关时没有这一部分）；二是切分给别的指纹出过键、切分方自己不产的单卡流（`issuedStreamSpecs`：按切分候选记录认，清单计划给浏览器出的那一份就在这里）。第二部分的候选只列实际出键的指纹，不补切分方自己的。

### 六、在线页面：读流清单，发给舞台（已做）

`src/render/snapshotSource.ts` 的 `OnlineSnapshotSource`（只在普通档；低内存档照旧不消费流）：读层表里的 `streams`，按播放头附近的范围（往回 1 段、往前 2 秒）去内容库取流清单，把清单里的开头文件和分段按哈希从素材服务取到本页内存（上限 64 MiB），**字节到了本页的分段才算就绪**，合成区间后照现有的就绪消息（`kind: 'stream'`）交给订阅方。`snapshotFeed.ts` 没有改。候选的认定同快照层：`task.done` 认定活着的优先，被作废的不用，都没认定取第一个。输入签名对不上的流马上撤掉。

### 七、舞台：流的字节由父页取了传给舞台（已做）

定的是**父页取了传给舞台**，不是舞台自己带票据取。理由：隔离的跨源舞台读素材只有自己源上的 `/media-s/<会话号>/media/<哈希>`，像素那一类不在放行的路径里；收到过票据的舞台文档永久不执行用户卡与素材效果卡，让舞台带票据取流等于关掉在线执行；父页本来就有层表、清单、候选、票据续签这条路。

做法（`src/render/streamPlayer.ts`）：流平面的请求多两个可选项 `manifest`、`blocks`，借现有的 `setStreamPlanes` 发；父页一侧 `StreamPlaneSender` 一台舞台一本账，块只带这台舞台还没有的；舞台一侧 `PushedStreamSource` 只从推来的块里取字节。桌面的流平面不带清单，行为不变。

## 本页产流（不经过任务队列；任务书「甲二」，已做）

线上没有能切分的节点时，身份为电脑的在线页面在后台舞台闲时自己产单卡轨道流、推素材服务、自己播；别的成员的页面、之后上线的桌面预渲染进程直接用这份产物。子 Agent 报告：`docs/reports/AGENT-rr-page-streams.md`。

### 同一种东西

同一条流不管从哪条路产，结果键、流任务的形状、清单、层表里的那一行都相同。

- **流的计划搬了一份到页面一侧**（`src/online/pageStreamPlan.ts`）：每张卡的采样窗口与能力（照 `CardFrameCache.plan`）、成员键（照 `cardSnapshotIdentity`）、流的内容键（照 `cardStreamIdentity`）、结果键、矩形与摆放（照 `localPlacement`）、超过解码器预算时的合并（照 `groupStreams`）、流任务（照 `split.mjs` 给浏览器出的那一份）、层表的行（照 `layerStreamsOf`）。`server/test/page-stream-plan.test.mjs` 拿同一份输入与服务端那几个函数逐字段对拍。
- **成员键只有一处**：`pageStreamPlan.ts` 的 `streamMemberKey`。服务端换成员键的算法（「己一」）之后只改这一个函数，再把 `PAGE_STREAM_CODE_VERSION` 改成服务端的 `STREAM_CODE_VERSION`，对拍就又对得上。
- **键里的两项代码指纹由在线构建嵌进页面**：`vite.config.ts` 用服务端同一套算法（`server/frame-code.mjs` 的 `captureCode`、`snapshotCode`）在构建时算出，以 `__PC_STREAM_CODES__` 嵌入。开发构建没有这两项，不产。
- **卡片图与源码版本**取页面自己的注册表（`browserNodeHost.ts` 的 `pageCardPlanValue`，与导出页 `window.__pcCardPlan()` 同形），项目取清单计划发布时留存的那一版已确认项目。
- 产的那一段复用队列那条路的 `bakeStream`（同一份活、同一个编码器、同一份「已推完的分段」登记，按任务 id 记）：任务 id 与切分方出的相同，所以本页产到一半有切分方接了活，它的节点认领同一个任务之后只补缺的分段。

### 什么时候轮到本页自己产〔裁〕

判据与次序在 `src/online/pageStreams.ts`，四条都成立才动手：

1. 本页是浏览器节点（当节点的条件成立、报到拿到了指纹、探到了编码器）。身份为手机的页面、低内存档、开发构建不当节点，也就不产。
2. 本页这一版的清单计划已经发出去，清单里有本页能产的单卡流还没有产物。清单是本页自己判重的片段：只为自己打开的项目、自己要播的卡。
3. **线上没有能切分的节点接这份计划：计划发出去满 5 秒（`PAGE_STREAM_WAIT_MS`）仍然没人认领。** 怎么知道：把同一个计划任务再发布一次（队列对同一个结果键只合并，不另起、不改状态），回包带它此刻的状态（`planPublisher.ts` 的 `probe()`）；有活要做的期间每 2 秒问一次（`PAGE_STREAM_POLL_MS`），没活了不问。`open` 是没人认领；`claimed`、`done` 是有节点接了活，不产，正在产的做完当前这一帧就停；`failed`（切分方试过、做不成）按没人接。5 秒的理由：空闲的切分方认领计划在一秒以内，留出它正忙着别的活的余量；等久了用户看着卡片一直是活渲或占位。
4. 闲：宿主的闲的判据（页面可见、不在播放、不在拖动、离上一次交互过了 500 毫秒、后台舞台没有更急的活），再加本页的节点手里没有认领。两条路共用后台舞台的同一份活，本页在产时节点也不认领。

### 先查，没有才产

每一段任务动手之前查两处：本页自己的键在内容库里有没有覆盖这一段的满密度清单、块都在素材服务上；层表里这张卡、**同一个内容键**的流有没有别的候选（桌面、渲染主机、别的指纹的页面），它的清单覆盖这一段、块都在。查到就直接用。产的途中每 5 秒再查一次，别处已经有了就做完当前这一帧停下，改用现成的。

### 层表

没有切分方时层表没人写：本页开工前把自己的那一行并进内容库里的层表（读、并、写；`mergeLayerStreams` 只动 `streams` 里自己这几行，`layers` 与别的卡的行不动；没有层表时新写一张，`layers` 为空）。同一张卡旧内容键的行去掉，本页的候选排在最前。之后每 20 秒核对一次还在不在（两个页面同时写，后写的会盖掉先写的）。有切分方接了活之后不再写。

### 桌面预渲染进程不重产、拉回去播

`server/frame-pipeline.mjs` 的 `adoptForeignStreams`，在两处调：切分之前（`planForQueue`）、页面会话打开一版时（`preload`）。它读内容库里这个项目的层表，对这一版的每条单卡流找同内容键的别的候选；候选的清单整条满密度就拉回本机流库，把这条流锁到那个指纹上（`streamLocks`：内容键 → 指纹，落盘在库根的 `stream-locks.json`）。之后：

- 本机的流计划照锁出键（`frame-stream.mjs` 的 `relockStreams`，`planStreams` 的最后一步）：生产者不重产，舞台播的就是拉回来的那一条，层表的候选是那个指纹；
- 切分照锁只出一份（锁并进 `cardLocks`，`split.mjs` 原有的「锁在别的指纹上」那条路）：在线页面的节点认领它、去重即完成，本机不出自己的那一份；
- 拉回来的流在本机流库里不齐了（被清掉）就解锁，回到自己的键。

### 给以后留的口子

用户已定轨道流先产「每 15 帧一张的稀疏版」再补满密度、稀疏版在打开项目测量时就产（`html-snapshot-removal-dryrun.md` 第 4.2、4.3 节，等用户确认）。现在只产满密度的一趟、只在闲时产，但没有写死：产几趟、每趟多密由 `createPageStreams` 的 `passes` 定（现在是 `[{ name: 'dense', stride: 1 }]`），宿主的 `bakeStream` 认 `stride`（每几帧向舞台取一张，取到的那一张连着送 `stride` 次）；什么时候可以动手由注入的 `isIdle()` 与 `planState()` 两个判据定，换触发时机换这两个函数。契约里说的「页面写层表时一并写位置矩形」没有做（位置矩形取消了）。

### 这一块的〔裁〕

1. 〔裁〕「线上没有能切分的节点」按「本页的清单计划发出去 5 秒仍是 `open`」认，不另加在线节点的查询接口（文档服务不用改）。后果：能切分的节点在线但正忙（比如桌面用户自己在播放）超过 5 秒时，本页也会自己产；它闲下来认领计划之后本页停手。
2. 〔裁〕「先查」按内容键认，不按「这张卡在层表里有没有一条输入签名对得上的流」认。后者更宽（播放那一侧就是这么认的），但代码换了版本之后旧流的输入签名照样对得上，页面就永远不会按新代码重产。
3. 〔裁〕本页只产页面自带的内置卡片的流。同步来的用户卡，页面一侧算不出与桌面相同的源码版本串（它们不在页面的主注册表里），算错的后果是改了卡的代码键不变；这类卡照旧等桌面或渲染主机，或者经队列（那条路的键由切分方算）。
4. 〔裁〕本页不产输出节点不是卡片自己的片段（片段上另挂了滤镜、强调）。切分方现在给这种片段算的成员键只由外面那一层决定，不含卡的参数（见报告「发现的问题」），页面不跟。
5. 〔裁〕字体指纹取父页文档已加载的字体。导出页取它自己文档的。仓库里没有注册任何网页字体，两边都是空表的哈希；以后有了，两边加载的不一样时键不同，后果只是桌面不认这条流、按自己的键另产。
6. 〔裁〕两个页面同时在线、同时发现没有切分方时可能各产一遍（指纹相同就是同一个键下后写的清单赢，指纹不同各在各的键下）。没有做页面之间的认领；每段开工前和产的途中都查，别处产完了就停。
7. 〔裁〕桌面只在别的候选**整条满密度**时才换键，部分的不换（照旧按自己的键产）。独立渲染主机没有接（它的内容库与素材服务客户端不在管线上，见报告）。

## 语义文档要跟着改的

合入 `main` 时由主会话改（改前改后的文字在 `render-refactor-task.md` 的语义表，第 1～6 行）：

- `product/platforms.md`：「在线浏览器……没有轨道流」「认领自己做得了的快照任务，产 HTML 快照」两处；渲染节点能力表里浏览器那一行加上「单卡轨道流」。
- `mechanism/rendering.md`：「在线浏览器没有轨道流：重层每拍换一次 HTML 快照……」那一段。有流的层走流，没流的层才照原来每拍换快照。建议在「旧输入的层不贴」里补一句流的签名多算了时间位置。

## 怎么验的

- 单测：切分与过滤（`server/test/browser-stream-split.test.mjs`）、清单形状与桌面拉回（`server/test/browser-stream-manifest.test.mjs`）、帧号换算与让路（`src/online/browserStream.test.mjs`）、层表的流（`server/test/layer-map-streams.test.mjs`，含清单计划的流进层表、切分方不产流时照列、没有流时层表逐字相同）、流的输入签名、在线来源的就绪区间、父页推块（`src/render/streamInputSig.test.mjs`、`onlineStreams.test.mjs`、`streamPush.test.mjs`）。
- 端到端探针三支，都在本机：
  - `scripts/probes/browser-stream-node-probe.mjs`：产这一半。桌面预渲染进程只切分，在线构建的页面当浏览器节点；浏览器产的流与 ffmpeg 产的参照流逐帧比；桌面把流拉回去落盘。
  - `scripts/probes/online-stream-play-probe.mjs`：播这一半。预渲染管线自己产流、自己推，在线页面播；含缺块、组流。页面用的是在线模式的开发服务。
  - `scripts/probes/browser-stream-e2e-probe.mjs`：整条链。桌面预渲染进程只切分，在线构建的页面甲产流，另一个浏览器里的页面乙播；跑两轮（切分方关着、开着流开关）。断言见探针文件头。
- 在线构建的开始页现在只有账号入口，等 `[data-pc="join-form"]` 的旧探针都进不了项目。进项目改走「刷新后回到项目」那条产品路径，共用 `scripts/probes/lib/online-resume-entry.mjs`；`m7-browser-probe.mjs`、`m7-node-probe.mjs`、`online-stale-layer-probe.mjs` 已换。
- 基线：类型检查、全量测试（要带 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT` 和 `PROMPTCUT_PASSWORD_ORDER_MODULE` 两个环境变量）。

## 合入之后还要做的

- **在线编辑器、切分方（桌面应用、渲染主机）要重新部署才生效。** 文档服务与素材服务的代码这次没有改；跟着 0.7.18 一起部署即可，不是这件事的前提。
- **线上要有一个能切分的节点**（桌面应用或渲染主机）。在它出现之前浏览器节点收不到任何细任务；那种情形由本页自己产流接住（「甲二」已做，见上面「本页产流」）。
- **桌面把别的环境产的流拉回去以后自己的舞台播它**：「甲二」已做（`adoptForeignStreams` 与 `relockStreams`，见上面「桌面预渲染进程不重产、拉回去播」）。只管「别的环境已经有整条」的情形；经队列成对出键、浏览器先认领的那种，桌面这一版仍按自己的指纹列流（它那一份被队列作废，不产），要等下一次切分或打开时先查到才换键。
- **桌面和渲染主机替在线页面的清单计划产流**（切分方自己的那一份）：「甲三」已做（`docs/reports/AGENT-rr-hosted-streams.md`）。`listPlanOverrides` 按执行器给的 `ownListStreams` 出切分方自己的那一份（单卡流）；流任务回来时执行器按任务的片段现算单卡流把它对回这一版；层表里这些流的候选照切分候选记录列（切分方的指纹在前、浏览器的在后），没有改写法。组流不出。
- **后进来的页面拿不到快照层的活候选**（这次端到端查出，快照那一半原有的行为，不是流引入的）：层表里快照层的候选是「切分方自己的在前、浏览器的在后」，哪一份活着靠页面收到的 `task.done` 与 `superseded` 认定；任务做完之后才打开的页面两样都没收到，取第一个，也就是切分方那一份。切分方没产（只切分，或它那一份被作废了）时，这个页面这张卡就没有快照：流照播，但每次起播的头 500 毫秒舞台给这一层盖「等快照」的沙漏，流缺段时也没有快照可退。`m7-contract.md` 的 D12 写的是「按 `task.done` 与清单认定」，按清单认定的那一半没有实现。待定怎么补（例如选中的候选取不到清单、别的候选取得到时改认后者）。
- **在线页面按拍换快照的预算还把海报层算进去**（`snapshotFeed.ts` 的 `applyBeatBudget`）：流覆盖着的层 15 帧才换一次快照，却每拍占一份换帧成本。不比原来差，有流之后可以更好。
- 流的字节在页面里只放内存，刷新之后要重取。

## 没有覆盖的

- 组流、画布卡、Lottie、重度为「重」的卡：浏览器不产，照旧等桌面或渲染主机。
- 手机、平板、Safari、Firefox：没测；浏览器节点本来就只认 Chromium 内核、身份为电脑的页面。
