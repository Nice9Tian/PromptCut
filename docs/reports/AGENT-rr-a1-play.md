# AGENT 报告：rr-a1-play（渲染重构「甲一」的「播」这一半）

分支 `claude/rr-a1-play`，工作区 `.worktrees/rr-a1-play`。端口段开工时是 5820～5829，中途主会话改成 7420～7429（全量测试里有几个文件把 58xx 的端口写死了）；改之前在 58xx 上跑过的探针都已自己收掉，改之后的运行全在 7420～7428。

任务：在线页面读到并播放轨道流。对应 `docs/plan/browser-stream-task.md`「还差的七处」里的第五处（层表写流）、第六处（在线页面读流）、第七处（舞台取流的字节）。「甲一」指任务书 `render-refactor-task.md` 里「在线浏览器生成和播放轨道流，经过任务队列」那一项；另一半「产」（第一到第四处）由另一个子 Agent 在 `claude/rr-a1-produce` 上做。

## 提交

| 提交 | 内容 |
|---|---|
| `455d9002` | 建报告文件 |
| `980de3f6` | 实现：层表写流、在线页面读流清单、舞台从父页推来的块取流的字节 |
| `55890a08` | 单测四份 |
| `eb91bc4c` | 端到端探针 `scripts/probes/online-stream-play-probe.mjs` |
| 本次 | 报告 |

## 做了什么

### 第五处：层表写流

- `server/artifact-transfer.mjs`
  - `layerMapOf` 多三个选项：`streams`（`planStreams` 的结果，调用方算好给进来）、`streamCandidatesOf`、`streamSegments`。有流时层表多一项 `streams`；**没有流时不带这一项**，层表与以前逐字相同。版本号仍是 3。
  - 新函数 `layerStreamsOf`：每条流一行，形状就是主会话定的那一份，字段名没有改：
    `{ topClipId, clipIds, kind: 'card' | 'group', plane, contentKey, candidates: [{ envFingerprint, resultKey }], firstSegment, lastSegment, segmentsPerTask, inputSig? }`。
    候选照快照层的做法：切分实际出键的指纹在前（按发布顺序），再补上这条流自己的指纹。两个片段共用一条流时是两行，键相同、`topClipId` 不同。形状不对的流跳过，不抛。
  - 新函数 `splitStreamCandidatesOf(tasks)`：只看流任务通用的三个字段（`kind: 'stream'`、`input.contentKey`、`requires.envFingerprint`），不依赖「产」那一半的代码。原来的 `splitCandidatesOf` 没动。
  - `STREAM_CANDIDATE_PREFIX` / `streamCandidateKey`：流的候选记在管线原有的切分候选记录里，键带 `stream:` 前缀，和卡的内容键分开。
- 写层表的两处都经管线的新方法 `FramePipeline.layerMapStreamOptions(entry)` 带上这一版的流：
  - `server/frame-pipeline.mjs` 的 `publishLayerMap`（本机推送队列那一路）；
  - `server/vite-plugin-frames.ts` 里独立渲染主机的 `publishLayerMap`（只加了一行展开）。
  - 流的算法和参数与生产者、与队列切分相同，所以流键相同。没有生产者或 `PROMPTCUT_STREAMS=0` 时不带 `streams`。
- `server/prerender-executor.mjs` 的 `afterSplit`：这一次切分里有流任务时，把流的候选另记一次（键带前缀）；没有流任务时和以前一样只记一次。

### 流的输入签名（新文件）

- `src/render/streamInputSig.mjs`（配 `streamInputSig.d.mts`）：层表每行流的 `inputSig`，服务端写、页面按当前项目算同一个比对。
- 为什么不直接用快照层的签名：快照按片段的本地帧取，片段整帧平移、挪位置都照贴；流按全局帧号分段，片段在时间轴上挪了，旧流每一帧都对不上时刻；组流还把成员的摆放和上下顺序画了进去。
- 进签名的：每个成员的片段签名、采样窗口（第一帧的全局帧号、帧数、被项目时长截到哪一帧）；组流另加成员的框、不透明度、淡入淡出、motion、成员的画家顺序、夹在成员之间的别的画面层。
- 这两个文件不在任务给的可改清单里，是第五、第六处共用的新模块，没有改清单外的现有文件。见「要主会话决定或注意的」。

### 第六处：在线页面读流

`src/render/snapshotSource.ts`：

- `parseLayerMap` 读 `streams`（`parseLayerStreams`），旧层表解析成空表。v 2 以下不读这张表。
- `OnlineSnapshotSource`（只在普通档；低内存档照旧不消费流）：
  - 按播放头附近的分段（往回 1 段、往前 2 秒）取流清单（内容库 `render-manifest`，键 `<结果键>:<起>-<止>`，从 `firstSegment` 起每 `segmentsPerTask` 段一份）。没满的清单每 2 秒重取；稀疏段也算没满，换成满密度之后跟着换。
  - 清单里的开头文件与分段按哈希从素材服务取到本页内存（`px/<哈希>`，同一张只读票据），取回来核对哈希；上限 64 MiB，按最近用过的留。失败的块 2 秒后再取。
  - **字节到了本页的分段才算就绪**，合成区间后照现有的就绪消息发（`kind: 'stream'`，键是结果键，组流带 `groupClipIds`）。
  - 候选的认定同快照层：`task.done` 认定活着的优先，`superseded` 作废的不用，都没认定取第一个。
  - 过期签名：行里的 `inputSig` 与页面算的对不上，这条流马上撤掉（发空层）、不再取。
  - 新方法 `streamPlane(key)`：给父页发流平面时带的清单与字节；`streamRev`：清单或字节变了就加一。
- `src/editor/snapshotFeed.ts` **一行没改**。

### 第七处：舞台取流的字节

**定的是：父页取了传给舞台。** 看过 `setMediaPolicy` 那一段和 `src/online/stagePolicy.mjs` 之后的理由：

1. 隔离的跨源舞台取不到。它读素材只有自己源上的 `/media-s/<会话号>/media/<哈希>`，`px/` 不在放行的路径里；要放行得改策略文件、nginx 模板并重新部署舞台源。
2. 票据不能进舞台的脚本。`px/<哈希>` 要带只读票据；而收到过票据的舞台文档永久不执行用户卡与素材效果卡（`online/isolation/execGate.ts`）。让舞台带票据取流，等于关掉在线执行。
3. 父页本来就有这条路：层表、清单、候选、票据续签、并发与超时都在在线来源里。

做法（`src/render/streamPlayer.ts`）：

- `StreamPlaneRequest` 多两个可选项：`manifest`、`blocks`。借现有的 `setStreamPlanes`，没有加新的消息种类，`src/render/stageRpc.ts` 没动。
- 父页一侧 `StreamPlaneSender`：一台舞台一本账，每次发流平面带上清单，块只带这台舞台还没有的。
- 舞台一侧 `PushedStreamSource`（`StreamSource` 的在线实现）：收下新块，这一批清单没用到的块当场丢掉。两边按同一条规矩记账，父页不用问舞台缺什么；调用失败就清账重发。
- 带了清单的流平面：清单当场生效，字节只从推来的块里拿，不碰预渲染进程的地址。桌面的流平面不带清单，行为不变。
- `src/StageView.tsx`：在线页面的播放器用只认推来的块的字节源；`setStreamPlanes` 把清单与字节交给播放器。在线页面里流平面的分组没变时不为它多做一次 React 提交（播放中每取到一段就会来一次）；桌面照旧每次都提交。
- `src/editor/Preview.tsx`：握手时把 `StreamPlaneSender` 接在这台舞台的 RPC 客户端上，所以每一处发流平面的（`pumpFeed`、`stageSwap.ts` 换班那一次）都经过它，`stageSwap.ts` 没改。`pumpFeed` 的比较键加了 `streamRev` 和「发给了哪一台舞台」。

### 兜底顺序

没改：有流的层走流；流这一段的字节没到本页时父页不发这条流平面，这一层照旧每拍换快照；流在画时垫着的是海报快照；连快照也没有才占位。低内存档的分支没动。

## 验证结果

### 基线

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误 |
| 全量测试，第一次 | `npm test`（带两个环境变量） | 退出码 1：5568 条，过 5563，失败 1，跳过 4。失败的是 `server/test/agent-live-selection.test.mjs`（等一步超时 8000 ms） |
| 那个文件单独重跑 | `npm test -- server/test/agent-live-selection.test.mjs` | 退出码 0，1 条过 |
| 全量测试，第二次 | `npm test` | **退出码 0：5568 条，过 5564，失败 0，跳过 4** |

第一次那一条与本改动无关（账号与 Agent 的测试），当时机器上别的工作区也在跑测试。

### 新单测（4 份，39 条，全过）

- `server/test/layer-map-streams.test.mjs`（8 条）：没有流时的表、单卡流、组流、候选的顺序、每份清单几段与坏形状、同一条流挂两个片段、`splitStreamCandidatesOf`、执行器记流的候选。
- `src/render/streamInputSig.test.mjs`（6 条）。
- `src/render/onlineStreams.test.mjs`（16 条）：旧形状的层表页面行为不变、分段号到区间、清单没满时重取与稀疏换满密度、候选切换、过期签名、缺块、开头文件取不到、票据过期重取、哈希对不上、`streamPlane`、组流、新订阅方与撤流、低内存档不消费流。
- `src/render/streamPush.test.mjs`（9 条）：按哈希取、两边的账、缺块、清账重发、同一块只发一份、带清单的平面不碰预渲染进程、新清单当场换上、桌面的平面照旧。

### 端到端探针（新写）

`node scripts/probes/online-stream-play-probe.mjs --out out/rr-a1-play/e2e/run5 --keep-temp`，退出码 0，`fails: []`。本机托管组合（文档服务 + 素材服务）、进程内的预渲染管线（和预渲染进程同一份代码，产流、推素材服务、写层表）、一个在线页面（双舞台、两个舞台各在自己的源上、普通档）。两张重卡各 5 秒。

| 断言 | 关键数 |
|---|---|
| S1 层表 | v 3，`layers` 2 层，`streams` 2 行；每行的键查得到流清单，分段齐；b 的流从第 1 段起 |
| S2 就绪索引 | 页面认出两条流，各 5 段就绪，没有过期的；`px/` 请求 13 次全在编辑器页的源上，两个舞台的源 0 次 |
| S3 流在画 | 两条轨道 `pushed: true`、解码器已配置、0 错误；播 29 帧，`drawn` 从 1 涨到 35，`lastDrawn` 从 23 到 52；包裹层一直被抑制，没有占位符；快照平面只变动 2 次（每拍换的话是 58 次上下） |
| S4 像素（单卡流） | 流正画第 31～33 帧时截图。与第 32 帧的精确活渲比：平均差 0.211、差得多的像素 0.145%。对照（与往后 2 秒比）：平均差 1.036、差得多的像素 1.199% |
| S5 缺块 | a 的第 4 段回 404。那一段里 8 个样本：a 没有流画面 8/8、快照可见 8/8、占位符 0、仍被抑制 8/8；b 是流 8/8。过了那一段 a 的流接上 14/14。那一刻的截图与精确活渲比：平均差 0.126、差得多的像素 0.095%（对照 1.137%）。补上那一块后页面自己重取成功 |
| S6 组流 | 解码器预算压到 1：层表换成一行组流，成员 `osp-b,osp-a`，挂在 `osp-a` 上；页面只剩一条组流、7 段就绪；舞台根下 1920×1080 的组流画布在出帧，只有一条轨道。像素：平均差 0.182、差得多的像素 0.125%（对照 1.176%） |
| S7 页面错误 | 0 |

通过线：平均差 ≤ 1.5、差得多的像素 ≤ 0.2%，对照至少是它的 4 倍再加 0.2%。「差得多」指任一通道差超过 48。

截图自己看过（`out/rr-a1-play/e2e/run5/`）：`s4-card-stream.png` 两块橙块清楚、位置与 `s4-card-live-same.png` 一致，`s4-card-live-far.png` 里两块都往右挪了；`s5-missing-playing.png` 里 a 是快照、b 是流，两块都不透明；`s6-group-stream.png` 两块出自同一块组流画布。流的画面里橙块左边（运动的后沿）比活渲宽出一两个像素，是编码留下的拖尾，在通过线以内。

耗时（只记录）：第一轮两条单卡流连同快照产完并推完 104 秒；第二轮组流 22 秒；整支探针约 5 分钟。编码器 libx264。

探针迭代过五次，前四次的失败都是探针自己的问题（数据目录没建、连接参数的形状、暂停后放播放头的时机、截图放大造成的边缘发糊），已在探针里改掉，没有改产品代码。

### 回归

**现有的在线探针，开工前与交活前各跑一遍，结果相同，都不过，卡在同一处。**

| 探针 | 开工前（`455d9002`） | 交活前（`eb91bc4c`） |
|---|---|---|
| `online-stale-layer-probe` | 退出码 1，等不到 `[data-pc="join-form"]` | 同 |
| `c10-browser-probe` | 退出码 1，创建者那一步过（94 秒），成员页等不到 `[data-pc="join-invite-project"]` | 同 |
| `m7-browser-probe` | 退出码 1，node 角色中止，A1～A12 都没走到 | 同 |

原因不在本改动：在线构建的首屏现在只有官网账号入口（`src/StartPage.tsx` 的 `OnlineStartPage` 只渲 `AccountProjects`），这三支探针走的还是原来的「加入别人的项目」表单；本机托管组合没有账号服务，页面显示「请求失败（account-protocol）」（截图 `out/rr-a1-play/base/c10/fatal-member.png`）。所以这三支探针眼下验不了「在线页面播放和快照」，我的改动对它们的影响没法用它们量。

补的回归：

- 在线构建：`vite build --mode online`，开工前、交活前都退出码 0。
- 桌面的流播放：`scripts/probes/stream-play-probe.mjs`（对一台临时的桌面开发服务，7426），退出码 0，`fails: []`，轨道 `pushed: false`。说明桌面取字节的路没被动到。
- 快照那一半：新单测里「旧形状的层表」一条，加上原有的 `onlineSnapshotSource`、`m7-alive-source`、`staleLayer`、`c10-l3-source` 单测照过。

### 开工前的对照

- `npx tsc -b --force`：退出码 0。
- `npm test`：退出码 1，5529 条里失败 3 条，都是素材服务 mTLS 的测试（`asset-wiring-integration.test.mjs` 等），日志里有 `EADDRINUSE 127.0.0.1:5865`，是别的工作区占着写死的端口。交活前的两次全量里这三条都过了。

## 没做成的及原因

1. **端到端没有走「队列切分出流任务」那条路。** 探针里的流是预渲染管线自己产、自己推的（桌面预渲染进程打开项目后的那条路）。原因：在线页面发的清单计划眼下不切流，`server/render-node/local-node.mjs` 的 `listPlanOverrides` 写死了 `streams: []`，那是「产」正在改的地方。切分候选的收集只有单测盖着。
2. **端到端的页面用的是在线模式的开发服务，不是在线构建。** 原因同上面三支探针：在线构建进不了项目。探针在页面里直接调 `syncManager.enterShared`，连接、同步、票据、内容库都是真的。副作用：开发服务没有舞台入口 `stage.html`，舞台的隔离自检不过，所以**隔离的跨源舞台（票据换 cookie 那种）没有在端到端里验到**；流的字节在两种舞台上走的是同一条路（父页推），但这一点只有代码和单测为证。
3. **流的字节只放内存，没有进页面内快照库。** 刷新之后要重取（浏览器的 HTTP 缓存能挡一部分）。没做是因为不在验收里，库的接口是按快照帧设计的。
4. **`mu-word-rotate` 的不稳定、14 张有状态卡的重跑**：任务书「甲一」里列的两件核对不在这一半的范围里，没碰。

## 裁定

都是三级（用户看不出区别），都没有改语义文档，所以文档里没有标〔裁〕；列在这里供审。

1. 〔裁〕舞台取流的字节：父页取了传给舞台。理由见上。
2. 〔裁〕流的就绪按「字节已在本页」算，不按「清单里列着」算。这样流平面发出去时字节跟着到；字节没到的那一段父页当它没有流，照旧每拍换快照，不会停在一张 15 帧才换一次的海报上。
3. 〔裁〕没有流时层表不带 `streams`，不写空数组。
4. 〔裁〕流另设一种输入签名（`s1-` 前缀），把片段在时间轴上的位置算进去。
5. 〔裁〕新设的三个数：流字节的内存上限 64 MiB、预取往回 1 段、取块失败后 2 秒再取。
6. 〔裁〕在线页面的舞台收到流平面时，分组没变就不多做一次 React 提交。

## 对任务书或语义的更正建议

- `browser-stream-task.md` 第七处写的是「两个办法二选一」，建议改成已定的那一个（父页取了传给舞台）并附理由；第五处的字段表补上 `kind`、`plane`、`inputSig`。
- `browser-stream-task.md`「怎么验」写「可以照 `m7-*` 搭」：这几支探针现在都进不了项目，建议注明要先修它们的入口，或照本探针用开发服务。
- 语义要跟着改的（我没改）：`mechanism/rendering.md`「在线浏览器没有轨道流」那一段；`product/platforms.md` 的两处；建议在 `mechanism/rendering.md`「旧输入的层不贴」里补一句流的签名多算了时间位置。
- 全量测试里写死 58xx 端口的那几个文件，几个工作区同时跑就互相撞。建议改成随机端口。

## 要主会话决定或注意的

1. **「产」那一半合进来之后，流要经队列到在线页面，还差两处，都在它的文件里**：`listPlanOverrides` 的 `streams: []`；以及 `FramePipeline.streamPicked` 只认本机判重的卡，清单计划里补进来的片段不产流。我这边的层表会照 `planStreams` 的结果列，列了没人产不会出错，页面取不到清单就照旧换快照。
2. **新建了 `src/render/streamInputSig.mjs` 与 `.d.mts`**，不在给的可改清单里。没有它，片段在时间轴上挪了之后页面会接着播旧流，直到渲染节点重写层表。不要的话可以退回只用成员的片段签名，代价是上面那种错位。
3. **三支现有在线探针在集成分支上本来就不过**（账号入口），这次没法用它们做回归。
4. **在线页面按拍换快照的预算还把海报算进去**（`snapshotFeed.ts` 的 `applyBeatBudget`，没改）：流覆盖着的层 15 帧才换一次快照，却每拍占一份换帧成本，层多的时候会把下面没有流的层挤成占位符。不比现在差，但有流之后可以更好；`planDispatch` 里重卡每拍的固定成本同理。改它要动 `snapshotFeed.ts`，这次按「不用改」没碰。
5. 合并时 `src/StageView.tsx` 与「产」有同文件的改动：我只动了建播放器那一行和 `setStreamPlanes`，没碰 `bakeFrame`。
6. `out/rr-a1-play/` 下留着对照与探针的输出（不入库）；探针起的进程都已收掉，7420～7429 上没有监听。
