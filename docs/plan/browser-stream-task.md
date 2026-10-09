# 在线浏览器生成和播放轨道流：接入任务

2026-10-09 用户定「在线浏览器也要能生成和播放轨道流」（见 `render-standard.md`「预渲染的产物」），2026-10-10 用户说「做成，然后合入」。本文件记下已经做了什么、还差哪几处、每一处改哪里。还没动手的部分都标了「未做」。

## 已经做了的（分支 `claude/browser-stream-encode`，未合入 main）

| 文件 | 做什么 |
|---|---|
| `src/render/streamMux.ts` | 把 H.264 封成现有的分段格式 |
| `src/render/streamEncode.ts` | 把每帧画面拼成上半颜色、下半透明度，用浏览器自带的编码器压，每 15 帧交一段 |
| 两份单测、两个探针 | 见 `render-standard.md` |

这两个文件还没有任何地方调用。

## 现在的流程是怎样的（查代码得出）

1. 在线页面只发布「给这一版项目做计划」这一个粗任务（`src/online/planPublisher.ts`）。
2. **切分只有桌面应用和独立渲染主机能做**：它们认领粗任务，在自己的 Chrome 里算出每张卡的键，切成细任务发回队列（`server/render-node/local-node.mjs` 调 `split.mjs` 的 `splitPlan`）。浏览器节点不能认领粗任务（`server/render-queue/queue.mjs`）。
3. 切分时，浏览器做得了的卡（共享档、独立卡、轻或中等、不是画布卡、不是 Lottie）的**快照任务**会多出一份给浏览器的；**轨道流任务**只出切分方自己的一份，而且要求节点有转码能力，浏览器节点报的是「不能产流」（`src/online/browserNode.ts` 里 `streams: false`）。
4. 浏览器节点认领到快照任务后，后台舞台逐帧生成快照，推到素材服务，往内容库写一份清单（`src/editor/browserNodeHost.ts`）。
5. 在线页面播放时，靠内容库里的「层表」知道每张卡有哪些快照（`src/render/snapshotSource.ts` 的 `OnlineSnapshotSource`）。层表里只有快照，没有轨道流，所以在线页面的就绪索引里永远没有流，播放器不会启用。
6. 播放器本身（`src/render/streamPlayer.ts`）和父页挑流的逻辑（`src/editor/snapshotFeed.ts`）不分桌面和在线，只要就绪索引里有流、字节取得到就能播。

一个要先知道的事实：**线上现在没有能切分的节点**（渲染主机没部署，0.7.17 桌面版连不上云端）。在它们出现之前，浏览器节点连快照任务都收不到，轨道流任务同样收不到。

## 还差的七处（全部未做）

### 一、切分：单卡流多出一份给浏览器的

`server/render-node/split.mjs` 的流任务那一段。条件照快照那一套（`browserEligible`），另外只给单卡流（组流不给，组流要把几张卡连同摆放一起画，浏览器这条路画不了）。浏览器那一份：

- 结果键 = 流的内容键 × 浏览器指纹；`requires.envFingerprint` 是浏览器指纹；`requires.transcode` 为假；仍要求 `capabilities.streams`。
- `input` 里带页面要的东西：`dual`、`compositing`、`bake`（同快照那一份），再加 `stream`：`{ kind: 'card', plane: 'local', clipIds, fps, bound, offset, firstFrame, count, total }`。页面不自己算这些。
- 调用方（`local-node.mjs`）要把 `planStreams` 算出的每条流连同成员卡的信息传进来，现在只传了流键和分段范围。

### 二、节点侧过滤：流任务不再一律要求转码

`server/render-node/filter.mjs` 规则 2 现在写的是「流任务或者要求转码的任务，节点必须能转码」。改成只看任务自己写的 `requires.transcode`。桌面的流任务本来就写了 `transcode: true`，行为不变。队列（文档服务）用的是同一个文件，**要重新部署文档服务才对浏览器生效**。

### 三、舞台：生成一帧时顺带交出像素

`src/render/stageRpc.ts` 的 `BakeFrameRequest` 加一项「要像素」，带一个矩形（平面坐标，就是流的 `bound`）。`src/StageView.tsx` 的 `bakeFrame` 在生成快照之后，照 `src/render/bakeSmall.ts` 的办法（把快照包进 SVG 画上画布，要内嵌页面的样式表），按原尺寸、平移到矩形左上角画出来，把位图随事件交给父页。`bakeSmall.ts` 已经验证过这条路和桌面截图只差不到 1% 的像素。

### 四、浏览器节点：认领并执行流任务

- `src/online/browserNode.ts`：能力位 `streams` 改成由宿主报（`probeStreamEncoder` 说能压才报真）；`render` 里放行 `kind: 'stream'`，交给宿主的新方法。
- `src/editor/browserNodeHost.ts`：新方法做这几件事——按任务的 `input.bake` 建隔离单卡工程；任务范围里每个分段 15 帧，全局帧号减去 `firstFrame` 得本地帧，不在卡的范围里的帧送全透明；每帧向舞台要像素，送进 `openStreamEncoder`；每段出来后算哈希，把开头文件和分段推到素材服务的像素那一类；全部做完往内容库写一份流清单（`render-manifest`，键是 `<结果键>:<起>-<止>`），再报完成。让路、中止、丢认领照快照任务的规矩。

清单的形状必须和桌面产的一样，桌面才能把浏览器产的流拉回去用（`server/artifact-transfer.mjs` 的 `collectStreamResult` 是样板）：

```
{ v: 1, kind: 'stream', resultKey, range: { from, to },
  header: { kind: 'card', plane: 'local', clipIds, fps, bound, offset, tight: null },
  inits:    { <开头文件哈希的前 16 位>: { hash, bytes, codec, width, height, timescale, rect, encoder } },
  segments: { <分段号>: { hash, bytes, init, stride: 1, samples, sig: null, encoder } } }
```

浏览器只产满密度的分段（`stride: 1`），矩形固定用 `bound`，不做「先稀疏、再收紧」那两步。`encoder` 写一个新名字（例如 `webcodecs-avc`），让人看得出是浏览器压的。

### 五、层表：把流写进去

`server/artifact-transfer.mjs` 生成层表的地方加一张 `streams` 表：每条流一行，带顶层卡的 id、成员、内容键、候选（指纹和结果键）、分段范围、每个任务几段。旧页面只读 `layers`，不认识的字段会忽略，所以不用升版本号。

### 六、在线页面：读流清单，发给舞台

`src/render/snapshotSource.ts` 的 `OnlineSnapshotSource`：读层表里的 `streams`，按播放头附近的范围去内容库取流清单，把已有的分段号合成就绪区间，照现有的就绪消息（`kind: 'stream'`）交给订阅方。这样 `snapshotFeed.ts` 不用改。

### 七、舞台：在线模式下从素材服务取流的字节

`src/render/streamPlayer.ts` 已经有可替换的字节来源接口（`StreamSource`）。加一个在线的实现：清单由父页随流平面一起发给舞台，开头文件和分段按哈希从素材服务取。舞台现在怎么带票据取素材还要再看一眼（`src/StageView.tsx` 里 `setMediaPolicy` 那一段），两个办法二选一：舞台自己带票据取，或者父页取了传给舞台。

## 语义文档要跟着改的

- `product/platforms.md`：「在线浏览器……没有轨道流」「认领自己做得了的快照任务，产 HTML 快照」两处。
- `mechanism/rendering.md`：「在线浏览器没有轨道流：重层每拍换一次 HTML 快照……」那一段。有流的层走流，没流的层才照原来每拍换快照。
- 渲染节点能力表里浏览器那一行加上「单卡轨道流」。

## 怎么验

- 每一处配单测（切分、过滤、清单形状、在线来源的就绪区间）。
- 端到端探针：起文档服务、素材服务、一个桌面预渲染进程当切分方、一个在线页面当浏览器节点，确认浏览器认领了流任务、内容库里有流清单、另一个在线页面播放时舞台上是流在画（不是快照在换）；再让桌面把这条流拉回去，确认桌面能播。可以照现有的浏览器节点验收探针（`scripts/probes/m7-*`）搭。
- 基线：类型检查、全量测试（要带 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT` 和 `PROMPTCUT_PASSWORD_ORDER_MODULE` 两个环境变量）。

## 合入之后还要做的

- 文档服务、素材服务、在线编辑器都要重新部署才生效。
- 线上要有一个能切分的节点（桌面应用或渲染主机）。

## 没有覆盖的

- 组流、画布卡、Lottie、重度为「重」的卡：浏览器不产，照旧等桌面或渲染主机。
- 手机、平板、Safari、Firefox：没测；浏览器节点本来就只认 Chromium 内核、身份为电脑的页面。
