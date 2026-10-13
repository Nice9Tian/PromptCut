# AGENT 报告：rr-sparse-streams（稀疏流一，第一期）

分支 `claude/rr-sparse-streams`，工作区 `.worktrees/rr-sparse-streams`，端口段 27860～27899。

这块活分两期。本报告是第一期：**轨道流分段的起点从「项目的第 0 帧」换成「这条流自己的第一帧」**（用户 2026-10-13 对「每张卡的 HTML 快照作废」第 10 条选乙，`docs/plan/html-snapshot-removal-dryrun.md` 第 10.5 节）。第二期（稀疏版每个分段只截第一帧、稀疏流任务、位置矩形进清单）没有做，建议的切法在第 9 节。

## 状态

第一期做完，等主会话审。语义文档没有改（第 8 节是更正建议）。

## 1. 做了什么

原来：一条流的第 n 个分段是项目的第 `n × 15` 帧起的 15 帧。片段从第 100 帧开始时，它的流从第 6 段（第 90～104 帧）起，前 10 帧是片段入场之前的透明帧。

现在：分段从这条流自己的第一帧（下文叫「第一帧」，字段名 `originFrame`，项目帧号）起每 15 帧一段，分段号恒从 0 起。片段从第 100 帧开始：第 0 段是第 100～114 帧，第 1 段是第 115～129 帧……

- 单卡流的第一帧是片段的第一帧（卡的本地帧 0）；组流是成员里最早的那个第一帧；依赖下层的流是目标卡的第一帧。三种都是流的计划里原来就有的 `firstFrame`，所以**没有哪种流缺一个确定的第一帧**，没有遇到要建解法表的卡点。
- 换算只有一处：新文件 `src/render/streamSegments.mjs`（纯函数，服务端和页面共用）。产的一侧和读的一侧都从它算，守门单测核对几个「15」是同一个数。
- 最后一个分段到**这条流自己的最后一帧**为止，可以不满 15 帧〔裁 1〕。原来是到项目的最后一帧为止（片段结束以后到分段末尾那几帧也产，是透明的）。
- 流的代码版本 `STREAM_CODE_VERSION` 从 2 加到 3（页面一侧对拍的 `PAGE_STREAM_CODE_VERSION` 同步），已经产出来的流全部换键重产。

## 2. 所有按项目帧号算分段的地方

先用搜索列全（`SEGMENT_FRAMES`、`STREAM_SEGMENT`、`firstSegment` / `lastSegment`、字面的 `/ 15`、`* 15`、`% 15`、`unit: 'segment'`），再逐处改。产品代码里一共这些：

### 产的一侧

| 文件 | 原来 | 现在 |
|---|---|---|
| `server/frame-stream.mjs` `planStreams`（单卡流、组流） | `firstSegment = floor(第一帧 / 15)`、`lastSegment = floor(最后一帧 / 15)` | `streamSegmentSpan(第一帧, 最后一帧)`：带出 `originFrame`，`firstSegment` 恒为 0 |
| 同上 `belowStreamSpecs`（依赖下层的流） | 同上 | 同上，第一帧取目标卡的 |
| 同上 `queueStreamOf`（交给切分的形状） | 不带第一帧 | 带 `originFrame` |
| 同上 `StreamProducer.runSegment` | `fromFrame = 分段号 × 15`，`toFrame` 截到项目末帧 | `streamSegmentFirstFrame` / `streamSegmentLastFrame`，截到流的最后一帧 |
| 同上 `produceRange`（进度的帧数） | 按项目总帧数算末段 | `streamSegmentFrameCount` |
| 同上 `nextTask`（接不接得上租约、离播放头多远） | `(lastFrame + 1) % 15 === 0`、`分段号 × 15` | 按这条流的分段边界判 |
| 同上 `measurePng` / `measureRgba`（稀疏趟量实体框记在哪一段） | `floor(帧 / 15)` | `streamSegmentOf(帧, originFrame)` |
| 同上 `freshManifest`、`adoptionState`、`status()`、`publish()`、`claimLayers()` | 不带第一帧 | 带 `originFrame` |
| 同上 `streamAdoption`（收别的节点产的清单） | 只查 `header.clipIds` | 另查 `header.originFrame`，不带的不收〔裁 4〕 |
| `server/frame-playback.mjs` `planStreamSegments`（播放头在哪一段） | `floor(播放头帧 / 15)` | 多收一个 `originFrame`，用同一处换算 |
| `server/render-node/split.mjs` | 自己写了一个 `15`；浏览器那一份任务的 `input.stream` 不带第一帧；任务的帧数按满段估 | 取共用的数；`input.stream` 带 `originFrame`、`lastFrame`；帧数按实际算 |
| `server/artifact-transfer.mjs` `layerStreamsOf`（层表的行） | 行里写 `firstSegment`、`lastSegment` | 行里写 `originFrame`、`lastSegment`，不写 `firstSegment`〔裁 2〕 |
| 同上 `collectStreamResult`（任务清单的头）、`manifestMatches` | 头里没有第一帧 | 头里带 `originFrame`；`manifestMatches` 要它 |
| `server/asset-store/stream-store.mjs` `publicManifest` | — | 原样带出 `originFrame` |
| `server/ready-index.mjs` | `layer` 消息不带第一帧 | `stream` 层带 `originFrame`（`setLayer` / `addFrames` / `claim` / `absorb` 都传下去） |
| `src/online/browserNode.ts` `streamTaskFrames`（浏览器节点：这一段任务做哪些帧） | 项目帧 `n × 15` 起，截到项目末帧，卡范围以外的帧送全透明 | 从 `originFrame` 起，截到 `lastFrame`；任务没带这两项的不做 |
| 同上 `streamManifest` / `streamManifestCovers` | 头里没有第一帧 | 带、要 |
| `src/online/pageStreamPlan.ts` `planPageStreams`、`pageStreamTasks`、`pageStreamRow`、`layerStreamCandidates`（本页产流，和切分方对拍的那一份） | 同服务端的旧算法 | 同服务端的新算法；「先查」不把没带第一帧的旧行当现成的 |

不用改、但核对过的：`server/frame-pipeline.mjs`（推送、拉回别的环境产的流、层表选项，都只用分段号和流的计划）、`server/prerender-executor.mjs`（只核任务的分段范围在不在计划里）、`src/online/pageStreams.ts`、`src/editor/browserNodeHost.ts`（按 `streamTaskFrames` 给的帧做）、`src/render/streamEncode.ts`（本来就按「这条流里的第几帧」数，只改了一句注释）、`server/bakery/bake.mjs` 的 `bakeStream`（收的是项目帧区间；稀疏时「每隔几帧截一张」本来就相对这一趟的第一帧数）。`server/bakery/` 下的文件一个字没动（截图代码的指纹不变）。

### 读的一侧（只改了分段换算这一件事）

| 文件 | 改了哪几处 |
|---|---|
| `src/render/streamPlayer.ts` | ①文件头注释；②`SEGMENT_FRAMES` 改成从共用模块取；③`StreamPlaneRequest`、`StreamManifest` 各加一个 `originFrame`；④`streamPlanesFor` 按每一层自己的第一帧换算，新导出 `streamLayerHas`；⑤`planesWithinBudget`、`StreamPlayer.setPlanes` 不收没带第一帧的平面；⑥`StreamPlaneSender.decorate` 把第一帧带过去；⑦`StreamTrack` 里 9 处 `floor(f / 15)`、`分段号 × 15` 换成 `segmentOf` / `segmentStart`（`onFrame`、`seek`、`rectOf`、`level`、`present`、`pump`）；⑧`setPlane`：同一条流的第一帧变了就整条重来 |
| `src/editor/snapshotFeed.ts` | `streamLayers()` 只收带第一帧的层；`demoteReady`（降级卡「从当前位置起 1 秒都有流」）按层的第一帧换算 |
| `src/render/snapshotSource.ts`（在线页面读取） | `ReadyMessage` / `ReadyIndex` 加 `originFrame`，`applyReadyMessage` 带上；`OnlineStream` 加 `originFrame`；`parseLayerStreams` 只认带第一帧的行；`streamWindow` 改成按每条流各算各的窗口（原来所有流共用一个按项目帧号算的窗口）；`loadStreamWindow`、`prefetchStreams` 跟着；`streamMessage`、`buildStreamPlane` 带上第一帧 |
| `src/StageView.tsx` | `setStreamPlanes` 的处理里把 `originFrame` 一并收下、诊断里带出（两行） |
| `src/render/Stage.tsx` | `StreamPlaneGroup` 类型加一个可选字段（`Stage` 不看它） |
| `src/render/stageRpc.ts` | 只加了三行注释 |

后面的块要在这些文件上接着做的话：`streamPlayer.ts` 里凡是要把项目帧号换成分段号的地方用 `this.segmentOf(f)`，不要再写 `/ SEGMENT_FRAMES`。

### 探针和测试

- 新增单测：`src/render/streamSegments.test.mjs`（换算本身）、`src/render/streamOrigin.test.mjs`（播放器逐帧核对，假解码器 + 真的 fMP4）、`server/test/stream-origin.test.mjs`（产流三种流逐帧核对）。
- 跟着改的单测 26 个文件（清单见第一个代码提交）。没有放松断言；数字变了的地方都写了为什么。`server/test/artifact-push.test.mjs` 的 W6 里 `stream.json` 的钉值更新了一个（清单多了 `originFrame`、`version` 从 2 到 3，别的文件的钉值没变）。
- 新增探针：`scripts/probes/stream-origin-probe.mjs`。跟着改的探针 9 支：`stream-produce-probe`、`stream-below-probe`、`stream-play-probe`、`stream-noreplay-probe`、`browser-stream-node-probe`、`page-stream-probe`、`browser-stream-e2e-probe`、`online-stream-play-probe`、`hosted-render-streams-probe`。
- **没有改、也没有跑**的探针（里面有按项目帧号的写法或流平面没带第一帧，下次用到时要先改）：`preview-fallback-probe`、`stream-canvas-direct-probe`、`stream-editor-e2e`、`hosted-stream-entry-probe`、`scrub-hold-snapshot-probe`，以及 `stream-common.mjs` 那一组早期原型探针（`stream-cadence`、`stream-sparse` 等）。

## 3. 新字段，键和签名里动了什么

**新字段只有一个名字：`originFrame`**——这条流自己的第一帧，项目帧号，非负整数。它出现在：

| 在哪 | 谁写 | 谁读 |
|---|---|---|
| 流的计划（`planStreams` / `planPageStreams` 的每一项） | 计划的一侧按当前项目算 | 生产者、切分、层表 |
| 流的清单 `stream.json`、读口给页面的清单 | 生产者 | 只作记录（探针、收别的节点的流时建状态） |
| 任务清单 `StreamResult` 的 `header` | 产这一段的节点（桌面、渲染服务、浏览器节点） | `manifestMatches`、`streamAdoption`；不带的不收 |
| 就绪消息里 `kind: 'stream'` 的层 | 生产者照当前计划发 | 父页（`snapshotFeed`）→ 流平面 → 舞台的播放器 |
| 层表 `streams` 表的行 | 写层表的一侧（切分方，或本页产流的页面） | 在线页面 |
| 浏览器流任务的 `input.stream`（另加 `lastFrame`） | 切分方 | 浏览器节点 |

**流键（内容键、结果键）的算法没有改。** 键里原来就没有「分段的全局帧号」这种成分：`cardStreamIdentity` 的摘要是成员的内容键、采样窗口（第一帧、相位、帧数）、帧率、画幅、代码版本。`originFrame` 自己不另进键——它就是成员采样窗口里的第一帧（组流是其中最小的），已经在里面。键变是因为代码版本加了一：分段号的含义变了，旧流不能再认。

**分段签名**（`segmentSignature`：流键、分段号、间隔、编码器、编码参数、矩形）的算法也没有改，里面的分段号从「项目的」变成了「这条流自己的」，是相对的，没有项目帧号。

**输入签名**（`streamInputSig`，层表的行里那一项）没有改，版本前缀仍是 `s1-`：它管的是「这一版项目的输入和产流时一样不一样」，和分段怎么分无关。片段在时间轴上的位置仍在里面（这次不动，见第 4 节）。

## 4. 给「片段挪动以后流不失效」留的口子

用户给的两条理由里这一条记了待办，这次不做：流键和输入签名里仍带着片段在时间轴上的位置，挪动以后照旧重产。为了以后做的时候只需要把位置从键和签名里拿掉、不用再动分段和清单，这次这样安排：

1. **分段号和每段几帧只由这条流有多少帧决定**，和它摆在时间轴的哪里无关（`streamSegments.test.mjs` 有一条专门核这件事：同样帧数的流摆在第 0、1、7、15、100、12345 帧，分段的形状相同）。这就是第 1 节〔裁 1〕把末段截到流自己的最后一帧的原因：照原来截到项目末帧的话，片段挪到项目结尾附近时末段的样本数会变。
2. **分段签名、分段文件名里没有项目帧号**；分段的字节里也没有（ffmpeg 每段单独编，浏览器的编码器按「这条流里的第几帧」给时间戳）。解码时的时间戳是读的一侧按项目帧号现给的。
3. **读的一侧只认计划给的第一帧，不读清单里记的那一个。** 就绪消息的层、层表的行、流平面里的 `originFrame` 都是计划的一侧按当前项目算出来的；清单里那一项只是「产这条流时它在第几帧」的记录。以后同一条流被摆到别的帧上时，读的一侧自然跟着新位置走。播放器的 `setPlane` 已经处理了「同一个流键、第一帧变了」（手里按旧位置记的帧全部放掉、从头解），`streamOrigin.test.mjs` 有用例。
4. **生产者 `anchorManifest`**（`server/frame-stream.mjs`）：计划换了一版时把清单里记的第一帧跟上计划的。现在流键带着位置，这一步什么都不改；以后是它把旧位置换成当前的。

以后做这件事时还要动的（都在键和签名这一侧，不在分段和清单里）：

- `cardStreamIdentity` 成员的 `sampling.firstFrame`、`streamInputSig` 的 `window.firstFrame` 与 `last` 拿掉；采样相位和帧数要留着（入点落在两帧之间时，挂载帧相对第一帧提前几帧随相位变）。
- 片段伸出项目结尾时流会被项目时长截短（`planStreams` 的 `lastFrame = min(项目末帧, …)`），截短以后的帧数现在不在键里。位置从键里拿掉以后，这个长度要进键，或者改成不截。
- 组流（成员之间的相对位置要留在键里）和依赖下层的流（下层的位置，用户已说明这类卡挪动后仍然失效）各自另看。
- 产流的隔离工程不平移时间（片段留在原来的时刻），所以「内容和位置无关」要靠卡的画面只由本地时间决定来保证；按全局时刻取值的卡（如果有）要另外处理。

## 5. 验证结果

机器上同时有别的子 Agent 在跑。除特别说明，探针都跑在合并 `main` 之前的提交 `2f401106` 上（在线构建也是那时建的）；合并 `main`（`8e5b8c67`）之后重跑的写在最后一小节。

### 5.1 验收 1：片段不从 15 的倍数帧开始，逐帧比像素

**单测（不靠肉眼，逐帧）**

- `src/render/streamOrigin.test.mjs`：片段第 100～149 帧（50 帧）。随机访问逐帧：对每一帧新建播放器、要这一帧，核对「先取的是第 `floor((F−100)/15)` 段、从段首关键帧解到第 `(F−100)%15` 个样本、每一块的时间戳是它自己的项目帧号」，50 帧全对；顺序播放 50 帧每帧恰好喂一次、不重置解码器；早于第一帧不取字节、不建解码器；没带第一帧的平面不收。
- `server/test/stream-origin.test.mjs`：单卡流（第 100～149 帧、第 40～129 帧、第 0～239 帧）、组流（第 40～149 帧）、依赖下层的流（第 55～99 帧，开关打开）。每条流把队列任务全部做完，核对每一趟出的帧区间、落盘分段里的每一帧（顺序、个数）、清单的样本数；稀疏分段（间隔 3）每个样本放的是不晚于它的最近一张；「接得上租约」按流自己的分段边界判。

**探针 `stream-origin-probe.mjs`（真的 Chrome、真的 ffmpeg，像素比对）**。项目里两张每帧横移 10 像素的卡：`clip-b` 第 40～129 帧，`clip-a` 第 100～149 帧。

```
node scripts/probes/stream-origin-probe.mjs --origin http://127.0.0.1:27860            退出码 0  PASS
node scripts/probes/stream-origin-probe.mjs --origin http://127.0.0.1:27860 --group    退出码 0  PASS
```

| | 单卡流 `clip-a`（第一帧 100） | 单卡流 `clip-b`（第一帧 40） | 组流（第一帧 40） |
|---|---|---|---|
| 产流逐帧：解出来的每个样本最像哪一帧（比它自己、前后各两帧） | 50 帧，错 0 | 90 帧，错 0 | 110 帧，错 0 |
| 第二像的那一帧的差 ÷ 它自己的差，最小值 | 9.13 倍 | 7.63 倍 | 7.7 倍 |
| 和它自己那一帧的平均差（满分 255） | 0.718 | 0.639 | 0.202 |
| 参照：同一幅画面原样过一遍编码器 | 0.718 | 0.639 | 0.202 |
| 对照：和下一帧比 | 6.744 | 6.742 | 2.197 |
| 对照：和「按项目帧号数分段」会对上的那一帧比 | 40.997 | 53.192 | 17.398 |

「和它自己」与「参照」两行逐位相同，说明流里的分段和「拿参照画面直接编」是同一批帧。

舞台贴流（测试页扮演父页，流平面用产品里的 `streamPlanesFor` 合成；打乱顺序逐帧把时间设过去，等流平面画出这一帧，截舞台，和导出页同一帧比，也和前一帧、后一帧比）：

| | 单卡流两条 | 组流 |
|---|---|---|
| 逐帧（拖动）：第 40～149 帧 | 110 帧，最像的都是同一帧，错 0，没画出来的 0 | 110 帧，错 0，没画出来的 0 |
| 和导出同一帧的平均差 / 差超过 48 的像素数（每帧平均） | 0.09 / 138 | 0.09 / 136 |
| 对照：和导出的下一帧 | 0.85 / 7189 | 0.86 / 7190 |
| 真的播放：从第 95 帧起播、暂停在第 123 帧 | 不跳帧；流平面停在第 123 帧；和导出第 122、123、124 帧的平均差 1.19、0.14、1.19 | 同左：1.2、0.14、1.2 |
| 早于第一帧（第 0、25、39 帧） | 父页不出流平面；硬给流平面，舞台也什么都不画 | 同左 |

看过的图：`out/rr-sparse/origin-group/stage-scrub-105-group.png`（舞台贴组流的第 105 帧）和 `export-105.png`（导出页第 105 帧），两块字的位置相同；`out/rr-sparse/origin-single/stage-scrub-105.png` 同样。

关于「暂停后拖动」：`main` 上父页只在播放中发流平面（`streamPlanesAt` 暂停时回空），暂停、拖动时贴的是快照，流不参与。所以产品路径上「暂停后拖动」这次没有对象；探针核的是「流平面挂着的时候把时间设到任意一帧」，这正是以后「暂停和拖动贴流」那一块要走的路。

**依赖下层的流：`stream-below-probe.mjs`**（开关由探针打开；目标卡 0.2 秒入场，第一帧是第 6 帧；流是第 6～89 帧，6 个分段，末段 9 帧）。

```
node scripts/probes/stream-below-probe.mjs --origin http://127.0.0.1:27860 --media-port 27870 --scenes b --sizes 960x540    退出码 0  ok: true
```

84 帧逐帧把解出来的那一层盖回「只有下层的导出画面」上、和「整幅的导出画面」比：平均差 0.73，参照（整幅画面原样过一遍编码器）1.078，对照（7 帧以后的整幅画面）5.548。流里没有入场之前的帧（原来头一个分段里有 6 帧）。只跑了乙场景（下层是半透明的药丸）；甲场景（下层有视频）没跑，为了省时间。

### 5.2 验收 2：现有的流相关探针

| 探针 | 命令要点 | 结果 |
|---|---|---|
| `stream-produce-probe` | `--origin http://127.0.0.1:27860` | 退出码 0，PASS。三条流的第一帧 0、15、0，分段 10、3、4 个。`--group` 那一遍没跑（组流的产流由 `stream-origin-probe --group` 核了） |
| `page-stream-probe` | `--dist out/rr-sparse/dist-online --base-port 27870` | 退出码 0，`ok: true`，三场（solo、splitter、desk）各 0 条不过。卡从第 12 帧起，132 帧，分段 0～8（末段 12 帧） |
| `browser-stream-e2e-probe` | `--dist … --base-port 27880` | 第一次退出码 1：`端口 27883 被占用`（当时有别的进程在听这个口，几十秒后自己没了，不是我起的）。原样重跑：退出码 0，`ok: true`，两轮（切分方关着流、开着流）各 0 条不过；层表的行 `originFrame: 12`、没有 `firstSegment` |
| `online-stream-play-probe` | `--base-port 27870` | 退出码 0，`ok: true`。b 改成从第 18 帧起：行里 `originFrame` 是 18 和 0；组流那一轮第一帧 0 |
| `hosted-render-streams-probe` | `--dist … --base-port 27870` | 退出码 0，`ok: true`。卡从第 12 帧起，252 帧，三个流任务 0～7、8～15、16～16 |
| 另外跑的：`stream-play-probe` | `--origin …` | 退出码 0，PASS |
| 另外跑的：`stream-noreplay-probe` | `--port 27890` | 退出码 0，`ok: true` |
| 另外跑的：`browser-stream-node-probe` | `--dist … --base-port 27880` | 改完期望值后退出码 0，`ok: true`。浏览器产的流和桌面参照流逐帧比 48 帧：颜色平均差 0.218，对照（隔 24 帧）是同一帧的 8.3 倍；末段只有 3 帧 |

为了让这几支探针保持原来的分段个数，三支把卡的时长加了 12 帧（`page-stream-probe`、`browser-stream-e2e-probe` 4.0 → 4.4 秒，`hosted-render-streams-probe` 8.0 → 8.4 秒）：原来「第 12 帧起、120 帧」按项目帧号分是 9 段，按流自己的第一帧分只有 8 段，两个流任务就变成一个了。

### 5.3 验收 3：导出与键

- `node scripts/verify-determinism.mjs --url "http://127.0.0.1:27860/?export=1"`：退出码 0，`Total Frames: 1800 / Identical: 1800 / Different: 0`。
- `PC_FRAME_TEST_URL=http://127.0.0.1:27860 node scripts/verify-unified-frames.mjs`：退出码 0，`PASS: no video during B; all HTML frames; exact video seek; random replay; cache hits; cumulative C equals A; …`。
- 键的比对（合并 `main` 之后跑，基准是 `main` 的 `dddd2db0`）：
  - `node scripts/probes/card-source-version-compare.mjs --base main`：88 个入口变 10 个，61 个身份变 0。变的 10 个入口都是经 `kernel/clock` 连到 `streamPlayer.ts` 的那一族（契约第 9.2 节的丙组）：`_probe/slow.tsx`、`native/focus-card.tsx`、`native/lottie.tsx`、`native/terminal-3d.tsx`、`parts/lib/media-lottie.tsx` 和几个汇总文件。退出码 1 是这支脚本「有变就 1」的写法。
  - `node scripts/probes/card-table-digest-compare.mjs --expect ,`：变了 6 张：`focus-card`、`lottie`、`probe-slow`、`probe-slow-stepped`、`terminal-3d`（丙组五个 id，预料中），和 **`particles`**（不在契约列的五个里，原因见第 10 节第 2 条，不是这次引入的）。六张都是「能力表同、注册表里的定义同、源码版本变、键（定源码）同」。三张有声卡没变，卡片声音不受影响。
- 流的键全部换（代码版本 2 → 3），预料中。生成快照的代码指纹、截图代码的指纹都没变（没有动 `server/bakery/` 和 `SNAPSHOT_FILES` 里的文件）。

### 5.4 验收 4：基线（合并 `main` 之后）

（等全量测试跑完填）

## 6. 没做成的与原因

- 第二期整期（按派活指令，这次不做）。
- `stream-below-probe` 的甲场景、`stream-produce-probe --group` 没跑（省时间；组流和依赖下层的流各有别的探针核过）。
- 第 2 节末尾列的五支探针和早期原型探针没有改。
- 「暂停后拖动」在产品路径上流不参与，见 5.1。

## 7. 〔裁〕

都是三级（用户看不出区别），都没有改语义文档。没有遇到卡点，没有建解法表。

1. **流的最后一个分段到这条流自己的最后一帧为止**（原来到项目的最后一帧）。理由：第 4 节第 1 条的口子；顺带少产几帧没人看的透明帧。影响：末段不满 15 帧的情形从「只有项目结尾」变成「每条帧数不是 15 的倍数的流」，播放器、浏览器编码器原来就支持不满的末段，单测和探针都核了。
2. **层表 `streams` 表的行带 `originFrame`、不再写 `firstSegment`；页面只认带 `originFrame` 的行。** 理由：改分段规则之前的页面（用户没刷新的标签页）按 `firstSegment` 和项目帧号找分段，读到新行会把画面贴错位；不写这一项，旧页面的解析就跳过这一行，当作这张卡没有流（退到快照），不会错位。反过来新页面不认旧行。层表版本号没有升（升了旧页面会把整张表连同快照层一起丢掉）。
3. **读的一侧的第一帧取就绪消息 / 层表的行 / 流平面带的，不取清单里记的。** 理由：第 4 节第 3 条。
4. **任务清单的头必须带 `originFrame`**，不带的 `manifestMatches` 判不匹配、`streamAdoption` 拒收。理由：免得把按项目帧号分的旧结果当新的贴（新旧结果键本来就不同，这是第二道保险）。
5. **浏览器流任务的 `input.stream` 加 `originFrame`、`lastFrame`，都必填**；原来的 `total` 照旧带着但不再用来截末段。

## 8. 对任务书或语义的更正建议

1. `mechanism/rendering.md`「兜底顺序」里「轨道流另有自己的输入签名…… **流按全局帧号分段，片段在时间轴上挪了，旧流每一帧都对不上时刻**」这一句的理由过时了。建议改成：「流的分段从这条流自己的第一帧起数；片段在时间轴上的位置仍在流键和输入签名里，挪了以后旧流不贴（挪动以后流不失效记了待办）。」
2. `mechanism/rendering.md`「重管线：预渲染」形态那一条照对照文档第 10.5 节改以后，建议再补半句：「最后一个分段到这条流的最后一帧为止，可以不满 15 帧。」
3. `html-snapshot-removal-dryrun.md` 第 4.7 节第 6 条、第 5 节表里「流键不变……不用为这件事升 `STREAM_CODE_VERSION`」：那是只改间隔时的结论。分段起点换了以后代码版本已经加到 3，旧流全部重产（第 10.5 节自己写了「已经产出来的流全部要重产一次」，两处对不上，以第 10.5 节为准）。
4. 同一份文档第 5 节「片段开头最多空 14 帧 → 截帧带上锚帧」、第 4.5 节组流「加每个成员挂载、退场落在分段中间的那几帧」：分段从流自己的第一帧起以后，单卡流的开头不空了，这两处的锚帧都不需要（第 10.5 节已经改成「不再另加锚帧」；组流里后入场的成员在它入场的那个分段里要等到下一个分段才出现，是稀疏版的已知退化，第二期定要不要管）。
5. 契约 `prerender-products-contract.md` 第 9.2 节丙组「五个 id」：现在是六个，多一个 `particles`（第 10 节第 2 条）。
6. `docs/plan/browser-stream-task.md`（第一处的 `input.stream`、第五处层表的行）、`artifact-transfer-contract.md` 第 3 节（`StreamResult` 的头）、`hosted-render-contract.md` 里写到流的分段范围的地方：字段跟着第 3 节的表改。
7. 派活指令里写的 `src/kernel/snapshotGrid.mjs`，实际在 `src/render/snapshotGrid.mjs`。
8. `server/frame-stream.mjs` 的 `SPARSE_STRIDE = 3`、`frame-playback.mjs` `streamFeasibility` 里的候选间隔 3、5、15、`MEASURE_PAD_PX` 的注释「稀疏趟只量了三分之一的帧」：第二期改间隔时一并改。这次新写的代码和测试没有把 3 写死成前提（用的是 `SPARSE_STRIDE` 这个名字）。

## 9. 第二期建议怎么切

建议切三块，串行（都在道一，后两块要碰读的一侧）：

- **二甲：稀疏版改成每个分段只截第一帧。** `SPARSE_STRIDE` 不再是独立的数，取分段的帧数；`runSegment` 稀疏时只截分段的第一帧、重复写满这一段（`bakeStream` 已经支持：间隔给 15 就是只截第一张）；remotion 式的流不逐帧推、直接跳到要截的帧（现在不回放的流已经是这样）。同一块里把位置矩形记进清单：每个稀疏分段量一个收紧的框，记在清单的这个分段上（建议 `segments[n].box`，平面坐标）；整条流的 `tight` 仍由它们的并集定。只量十五分之一的帧以后收紧矩形可能偏小：把依赖下层的流已有的「满密度趟发现超出就放大、按新矩形重产」（`widenTight`）推广到所有流，探针核「收紧矩形不裁掉任何一帧的内容」。`snapshotGrid.mjs` 建议删掉：分段起点换成流自己的第一帧以后，「每 15 帧一张」就是「每个分段的第一帧」，由 `streamSegments.mjs` 给，不需要另一处网格；锚帧也不要了。
- **二乙：稀疏排在满密度前面，覆盖队列那条路。** 预渲染进程一打开项目先把所有重卡的稀疏版产完再补满密度（不连文档服务时现在已经是「先稀疏后补密」，要改的是排到别的后台预渲染前面、和去掉每 3 帧那一档）。连着文档服务时新增稀疏流任务：建议任务形状不变、`input.density: 'sparse'`，任务 id 另加后缀（和同一段的满密度任务区分），名次高于满密度；完成判据照对照文档第 4.7 节第 2 条。结果清单的形状不变（每个分段带间隔），和满密度的清单写同一个键（`<结果键>:<起>-<止>`），满密度产出来以后覆盖——这样层表和在线页面的读法都不用动。浏览器节点和本页产流：`pageStreams.ts` 已经有「产几趟、每趟多密」的口子（单测 PS-09 用的就是间隔 15），接上即可。
- **二丙：读的一侧用上位置矩形。** 占位符照这一帧所在分段的框画（`placeholderHost.ts`、`streamPlayer.ts` 的 `box`）；这一块和「己三」是同一件事，可以并过去。

第一期为第二期留好的：清单的每个分段本来就记着间隔（1 是满密度，大于 1 是稀疏），页面只看它是不是大于 1；分段号和起止帧都从 `streamSegments.mjs` 取，稀疏版要截的帧就是 `streamSegmentFirstFrame(n, originFrame)`。

## 10. 顺带查到的

1. **流的帧异步画出来以后，占位符不会自己撤。** 流平面挂着、没有节拍（只设了一次时间）的时候，流要等字节和解码，晚几十毫秒才画出目标帧；如果这一层此前已经超过 120 毫秒没有画面、占位符已经显示，它会一直盖在画好的流上，直到父页下一次来消息（`setStreamPlanes`、`setTime`）才重算。播放中每拍都重算，所以现在的产品看不到。`stream-origin-probe` 第一版 110 帧里有 7 帧截到的是占位符（图：`out/rr-sparse/origin-single/stage-mismatch-104.png`），照父页每拍的做法补发一次流平面以后 0 帧。这是舞台现有的行为，和分段怎么分无关，这次没有改；**「暂停和拖动贴流」那一块会直接撞上它**，建议在那一块里让流画出目标帧时顺带重算占位符。
2. **`particles` 这张卡的源码版本跟着丙组变。** `cardSourceVersion` 按「文件里有没有 `id: "<卡的 id>"`」找这张卡的入口文件，`src/cards/assets/index.ts` 第 94 行 `parts: [{ id: "particles", … }]` 先被匹配上（文件名排在 `native/particles.tsx` 前面），于是 `particles` 的入口成了 `assets/index.ts`，它引了 `lottie.tsx`，闭包里就有了舞台那一族文件。结果：以后凡是动丙组的文件，`particles` 的键都跟着换一次（只是预渲染结果的键，它没有声音）。53 张粒子封装卡不受影响。这是 `main` 上已有的情形，要不要修由主会话定；修法是让入口查找只认卡片定义顶层的 `id`。
3. **拿「帧号 ÷ 30」当秒数写片段的入点，第一帧可能多出一帧。** 例如 `start: 100 / 30` 算出来的第一帧是 101（采样窗口按有理数精确算，3.3333333333333335 × 30 略大于 100）。写测试和探针时把入点写成落在两帧之间的小数（如 3.32）才稳。只影响写测试的人，产品里入点本来就是任意小数。
4. `scripts/probes/online-stream-play-probe.mjs` 原来注释写「b 从 0.5 秒起，入点不在分段边界上」，其实 0.5 秒正好是第 15 帧、在边界上。这次把 b 改成从 0.6 秒（第 18 帧）起。

## 11. 提交与收尾

（等基线跑完填）
