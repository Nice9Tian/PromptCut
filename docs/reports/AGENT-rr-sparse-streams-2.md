# AGENT 报告：rr-sparse-streams-2（稀疏流一，第二期）

分支 `claude/rr-sparse-streams-2`，工作区 `.worktrees/rr-sparse-streams-2`，端口段 27860～27899。

第二期照第一期报告第 9 节的切法做前两块，串行：

- **二甲**：稀疏版每个分段只截分段的第一帧、其余帧重复它（只有这一档）；位置矩形记进流的清单；删 `src/render/snapshotGrid.mjs`。
- **二乙**：稀疏版排在满密度版前面；任务队列里加稀疏流任务；云端「生成轨道流」关着时渲染服务只产稀疏版。

语义依据：`docs/semantics/mechanism/rendering.md`「重管线：预渲染」「兜底顺序」「测量」、`docs/semantics/workflow/project.md`「项目设置」（主会话已改定，本任务没有动语义文档）。

## 状态

两块都做完。已合并 main 三次：第二次并进了「暂停和拖动贴流」那一路（`6d114b4e`），第三次并进的是云端 Agent 工具表接线（`53f15c6e`，和渲染没有交集）。基线在每次合并之后都重跑了，探针在第二次合并之后重跑了一部分，结果见第 8 节。没做成的见第 9 节，要主会话决定的见第 10 节。

## 1. 做了什么

### 二甲

- `server/frame-stream.mjs`
  - `SPARSE_STRIDE` 等于一个分段的帧数（取 `src/render/streamSegments.mjs` 的 `STREAM_SEGMENT_FRAMES`），稀疏只有这一档；「每 3 帧一张」那一档和它的代码去掉。
  - 稀疏的分段只截这一段的第一帧，连送整段的样本数。要回放的流（motion 式）照旧把这一段每一帧都推过去（下一段接着租约推）；不要回放的流（remotion 式）只推到第一帧就停，下一段在同一个页面上直接跳过去，不重灌工程（探针里 7 个分段只重灌 1 次）。
  - 每个稀疏分段量位置矩形 `box`，记进清单这个分段的条目（见第 2 节）。补成满密度时沿用被换掉的稀疏分段的 `box`。
  - 收紧矩形：稀疏版齐了以后取各分段 `box` 的并集，外扩 `MEASURE_PAD_PX`（8）、夹回上界、外扩到偶数；省不到 `TIGHTEN_MIN_SAVING` 不收紧。
  - 补密时每帧核对画面有没有顶到收紧矩形的边（稀疏版一段只量了一张，中间帧可能走出去）。顶到了：这个分段重来一趟，顶到的那几边放到上界、每帧都量，收紧矩形照量到的边界放大（多留的一截等于超出的距离，最多 `TIGHT_WIDEN_MARGIN_PX` 64），再按它产。次数有上界（四条边各一次），不算失败。
  - 清单里没有分段再用的变体（稀疏版换完以后的上界变体、放大以前的变体）去掉，开头文件 5 秒后删。
  - 流的代码版本 `STREAM_CODE_VERSION` 3 → 4（`src/online/pageStreamPlan.ts` 的 `PAGE_STREAM_CODE_VERSION` 同步）。
- `server/asset-store/stream-store.mjs`（对外清单）、`server/artifact-transfer.mjs`（任务清单）带出 `box`。
- 删 `src/render/snapshotGrid.mjs`、`.d.mts`、`.test.mjs`；`src/render/streamSegments.test.mjs` 加守门：`15` 这个数只在 `src/render/streamSegments.mjs`（和导出用的 `server/bakery/ffmpeg.mjs`）里出现。
- 单测里写死的 `stride: 3` 换成「一个分段的帧数」（`bake-stream`、`capture-canvas`、`frame-stream`、`stream-direct`、`below-capture`、`stream-queue`）。

### 二乙

- **任务**（`server/render-queue/messages.mjs`）：稀疏流任务是 `kind: 'stream'`、`input.density: 'sparse'`，id 在满密度任务的 id 末尾多一段 `:sparse`（`taskIdOf` 多收一个 `density`）；结果键、范围、内容库里的清单键与同一段的满密度任务相同。入站时 `input.density` 只认 `'sparse'`，别的值去掉。`isSparseStreamTask(task)` 给各处判。
- **队列**（`server/render-queue/queue.mjs`）：`node.welcome` 多带 `sparseStreams: true`。切分方看到这一项才切稀疏流任务；连的是旧文档服务（不带这一项，校验 id 时也不认 `:sparse`）就照原来只切满密度的。
- **切分**（`server/render-node/split.mjs`）：每一份流（切分方自己的、浏览器的）先出一组稀疏流任务、再出满密度任务，范围逐个相同；稀疏流任务的名次 `SPARSE_STREAM_PRIORITY` 30（满密度流任务和普通快照任务是 10，锚帧 50）。
- **认领与执行**：`server/prerender-executor.mjs` 把任务的密度交给 `FramePipeline.renderStreamRange` → `StreamProducer.produceRange(…, { density })`。稀疏流任务只补一张都没有的分段；满密度任务补到满密度为止；已经是满密度的分段，稀疏流任务不动它。
- **结果清单**（`server/artifact-transfer.mjs`、`server/artifact-push.mjs`）：满密度任务不拿稀疏版当结果（`wantsDenseStream`：本机覆盖、内容库清单完整、`put` 三处都看）；写内容库前先取已有的那一份合并（`mergeStreamResult`）：不降级、不丢别的分段、位置矩形带到满密度的清单里。
- **拉取**（`StreamProducer.adoptable`）：本机只有稀疏版、对方是满密度的，收；两边都是稀疏或本机已经满密度，不收。
- **浏览器节点**（`src/online/browserNode.ts`、`src/editor/browserNodeHost.ts`）：认领到稀疏流任务按一个分段的帧数取帧（每段只向舞台要第一帧），在页面里量位置矩形（位图读回、扫不透明像素）；清单带 `box`；写清单前同样合并；满密度任务去重时不认稀疏版的清单。
- **托管方的渲染服务**：`server/render-node/host.mjs` 的认领闸在「生成轨道流」关着时只挡满密度的流任务；`server/prerender-executor.mjs` 切清单计划时这一项关着就给 `ownListSparseStreams`，`server/render-node/local-node.mjs` 的 `listPlanOverrides` 把单卡流标成 `ownSparseOnly`，切分方自己的那一份只出稀疏流任务（见第 7 节〔裁〕一）。
- **界面**：`src/editor/sync/hostedServices.ts`「生成轨道流」没打开时的说明换成用户认可的原文。
- **预渲染进程（不走队列时）**：自动生产原来就是「还有哪一段连稀疏的都没有，就只做稀疏那一趟」，这次没有改次序，只是稀疏那一趟变便宜了；探针里看盘核对过（第 8 节）。

## 2. 清单里新增的字段、位置矩形的坐标系

流清单（本机 `streams/<流键>/stream.json`、对外的 `/api/frames/streams/<流键>/manifest`、内容库 `render-manifest` 键 `<结果键>:<起>-<止>`）每个分段的条目多一项：

```
segments[n].box = { x, y, w, h } | null      // 没量过的分段不带这一项
```

- **是什么**：产稀疏版时截的那一张（这个分段的第一帧）里**不透明像素（alpha > 0）的外接框**，不外扩。`null` 表示那一张全透明。
- **坐标系**：平面坐标，和清单里的 `bound`、`tight`、`inits[id].rect` 同一个。单卡流（`plane: 'local'`）是卡的包裹层自己的坐标（框的左上角是原点，`bound` 比框大一圈 `LOCAL_OVERFLOW_PX`）；组流、依赖下层的流（`plane: 'stage'`）是舞台坐标。换到舞台坐标加清单里的 `offset`。
- **量法**：桌面在预渲染间里截图后扫 alpha（`rgbaAlphaBox` / `pngAlphaBox`）；浏览器节点把舞台交来的位图画进离屏画布读回、扫 alpha（`alphaBoxOf`，单测与桌面的对拍）。
- **什么时候有**：稀疏版落盘时写；补成满密度后原样留着（本机清单沿用，内容库清单靠合并带过来）。拉来的旧分段、读不懂的截图没有这一项。
- `segments[n].stride`：等于 15 是稀疏版，1 是满密度（字段原来就有，取值从 3 / 1 变成 15 / 1）。

没有建帧库里的 `card-rects/`，层表里没有 `rects`。

## 3. 稀疏与满密度的排队规则落在哪

| 场合 | 规则 | 代码 |
|---|---|---|
| 本机自动生产（不走队列） | 所有流里只要还有一个分段连稀疏的都没有，就只做稀疏那一趟；齐了才补满密度。闲时闸 `streamBusy` 照旧 | `StreamProducer.nextTask` / `needsSparseAnywhere` |
| 队列 | 稀疏流任务名次 30，满密度流任务 10，认领按名次；同一条流里稀疏流任务排在前面发 | `split.mjs` 的 `SPARSE_STREAM_PRIORITY` |
| 托管方渲染服务，「生成轨道流」关着 | 只切、只认领稀疏流任务 | `prerender-executor.mjs` 的 `plan`、`local-node.mjs` 的 `listPlanOverrides`、`host.mjs` 的 `streamsPass` |
| 结果 | 同一个键；满密度盖稀疏，稀疏不盖满密度 | `mergeStreamResult`、`mergeStreamManifest`、`adoptable` |

## 4. 在线页面那一块接着做时要知道的

- **任务形状**：`src/online/pageStreamPlan.ts` 的 `pageStreamTasks(spec, { …, density: 'sparse' })` 出的稀疏流任务与切分方给浏览器出的逐字段相同（单测 `PSP-sparse` 对拍），之后切分方把同一个任务发进队列时 id 对得上。
- **产**：`browserNodeHost.ts` 的 `bakeStream` 收 `stride`；不给时照任务的密度定（`streamTaskStride`）。`src/online/pageStreams.ts` 的 `passes` 口子没动，现在仍是 `[{ name: 'dense', stride: 1 }]`；加稀疏的一趟就是在前面加 `{ name: 'sparse', stride: STREAM_SEGMENT_FRAMES }`，稀疏的一趟会自动量 `box`。
- **已推完的分段按任务 id 留着**（`streamKept`）：稀疏、满密度两个任务 id 不同，各留各的。本页产流那条路如果两趟用同一个任务对象，`have(n)` 按「已有的不比这一趟稀」判，稀疏的不会挡住满密度。
- **写清单**：`putStreamManifest` 一律先取已有的合并，所以稀疏、满密度谁先谁后写都不会降级，`box` 不会丢。
- **去重**：`streamRangePresent`（本页产流用的）原来就要求满密度；给稀疏那一趟查「有没有」要另写一个不要求密度的（`streamManifestCovers(body, ref)` 不带 `{ dense: true }` 就是）。
- **在线来源认任务完成**：`src/render/snapshotSource.ts` 的 `noteQueueEvent` 按 `^(snapshot|stream):(.+):\d+-\d+$` 从 id 里取结果键，稀疏流任务的 id 多一段 `:sparse`，这条正则对不上；消息自带 `resultKey` 时不受影响（探针里页面照常认出了流）。这个文件我没有动，接手时把正则放宽即可。
- **稀疏版先到**：页面认出流、分段就绪时拿到的可能还是稀疏版。要「每一帧自己的画面」得看清单里 `stride === 1`（两支探针都因此改了等待条件）。
- **本页自己先产的竞态**：清单计划发出去 5 秒没人认领，本页就自己产（原有行为）。那样队列后来的四个流任务都走去重。`browser-stream-e2e-probe` 现在认得出这种情况，不白等 15 分钟。

## 5. 给「暂停和拖动贴流」那一块留了什么

那一路在我交活前已经并进 main（`6d114b4e`），我第二次合并时并了进来。

- 占位符用的位置矩形：第 2 节的 `segments[n].box`，对外清单里就有；一条流的整体范围可以取各分段 `box` 的并集，或者直接用 `tight`。那一路这次没有用它，占位符照旧定位。
- 合并前我在旧的流播放器上撞到两件事，那一路的改动都已经盖住，这里只留记录：重问清单的节流原来按舞台的虚拟时钟算，暂停着就一直不重问；被换掉的稀疏分段文件删了以后，拿着旧清单去取会 404。合并后播放器改按真实时钟节流、停在稀疏段上有定时重问，探针里停着的那一帧在满密度补齐后自己换上（第 8 节）。
- 仍然留着的一点：被换掉的稀疏分段文件 5 秒后删（`REPLACED_DELETE_MS`）。播放器 2 秒重问一次，正常赶得上；页面被挂起超过 5 秒再回来时，第一拍可能取到已删的文件，要等它重问清单。没有实测到，只是按代码推的。
- 探针 `scripts/probes/sparse-stream-probe.mjs` 第 4、6 条是舞台贴稀疏版、换上满密度的像素核对，以后改播放器可以直接拿来跑。

## 6. 动了舞台一侧哪几行

点名的五个文件里只动了 `src/render/streamPlayer.ts`，3 处（相对 main 共 +9 −3 行，合并那一路之后仍是这 3 处）：

1. `interface SegmentData` 多一项 `rect: StreamRect | null`（加一行注释）。
2. `loadSegment` 里存这一段字节的那一行，多记 `rect: this.manifest?.inits[meta.init]?.rect ?? null`。
3. `rectOf(f)` 开头多两行：手里有这一段的字节就用拉它时记下的矩形。

为什么改：稀疏版按上界产、满密度按收紧矩形产，两个变体的矩形不一样。播放着的时候播放器重问清单，当前这一段在清单里已经换成满密度的变体，而换文件只在分段起点做，段中间画的还是手里稀疏版解出来的帧；原来按新清单的矩形摆，这几拍的画面被摆到错的位置、错的大小。这是原有的毛病（原来每 3 帧一张的稀疏版也是按上界产的）。

实测的范围要说清楚：**合并那一路之前**，探针逐拍走时撞到了它——不改时换上之前的十几拍和导出页每一帧都对不上，改后 0 拍画错。**合并之后**探针走的是另一条路（停着时定时重问、整段重解），不再经过这几行；「播放途中重问清单」那条路现在没有探针盖着，这 3 处是照代码留着的。

`Stage.tsx`、`StageView.tsx`、`snapshotFeed.ts`、`snapshotSource.ts` 没有动。

## 7. 〔裁〕

都是三级（用户看不出区别）的实现选择，语义文档没有动。

- **〔裁〕一：「生成轨道流」关着、而有浏览器能产这条流时，渲染服务不出自己的稀疏版。** 一条流只归一个指纹产（切分的锁）。渲染服务自己这份只有稀疏版，它要是抢到了锁，浏览器那一份（稀疏加满密度）就被作废，结果反而比原来少了满密度。所以这时只出浏览器那一份；没有浏览器能产（成员用的是手机、Safari、Firefox，或者是组流）才出渲染服务自己的稀疏版。语义原文是「没打开时托管方的渲染节点只为这个项目生成稀疏的轨道流」，按字面也可以读成「总是产」。另一种做法是让渲染服务的稀疏版不参与锁，但那样层表里一条流有两个候选键，在线页面挑哪个要改 `snapshotSource.ts`，不在我的范围里。
- **〔裁〕二：稀疏流任务用新的任务 id（末尾 `:sparse`），不新增任务种类。** 新种类要动节点过滤、lane、锁键几处；加后缀只动 id 的算法和校验。代价是旧文档服务不认，用 `node.welcome.sparseStreams` 挡住（旧队列下不切稀疏流任务，行为与原来相同）。
- **〔裁〕三：补密时顶到收紧矩形的边，重量一趟再放大。** 第一版是按固定步长往外放，`stream-produce-probe` 里药丸卡放了三次放到上界（等于没收紧）。改成量准了再放。
- **〔裁〕四：流的代码版本加一（3 → 4）。** 同一个键下稀疏分段的内容变了（每 3 帧一张变成每段一张），旧清单里 `stride: 3` 的分段会被当成合法的稀疏版留着，所以键必须换。已经产出来的流全部重产一次。

## 8. 验证

命令都在工作区里跑；dev server 用 27860（探针自己起或 `--origin`），在线构建在 `out/rr-sparse/dist-online`。

标「合并后」的探针是在第二次合并 main（含「暂停和拖动贴流」）之后的代码上跑的；其余探针是在第一次合并前后跑的，没有重跑。第三次合并进来的改动都在云端 Agent 那一侧，之后只重跑了类型检查和全量测试。

| 项 | 结果 |
|---|---|
| `npx tsc -b --force`（第三次合并后） | 退出码 0，零错误 |
| `npm test` 全量（第二次合并后） | 退出码 0：6690 条，过 6675，失败 0，跳过 13，待办 2 |
| `npm test` 全量（第三次合并后） | 退出码 1：6723 条，过 6706，失败 1，跳过 15，待办 1。失败的是 `server/test/accept-018-conv-endtoend.test.mjs`「2.3-6 账号模式端到端」，素材服务子进程起不来（`EADDRINUSE`，端口被占），与流无关；单独重跑这个文件 4 条全过 |
| `sparse-stream-probe`（新；合并后） | PASS，退出码 0 |
| `stream-origin-probe`（不带 `--group` 的合并后又跑了一遍；`--group` 是合并前跑的） | 都 PASS：产流逐帧 50 + 90 帧 / 组流 110 帧，错 0；舞台拖动 110 帧错 0；播放不跳帧 |
| `stream-scrub-stage-probe`（那一路带来的；合并后） | PASS |
| `stream-produce-probe` | PASS（改了一处文案）。药丸卡收紧矩形 566×386（上界 704×424），每条流 1 个变体，失败 0 |
| `stream-below-probe` | PASS |
| `browser-stream-e2e-probe`（两轮） | PASS：浏览器节点认领 4 个流任务（稀疏、满密度各 2 个）各做一次，送进编码器 264 帧（2 × 132），失败 0；清单最后是满密度、9 个分段都带位置矩形 |
| `hosted-render-streams-probe` | PASS：关着时 3 个稀疏流任务各做一次、17 个分段都是稀疏版带位置矩形、没有满密度任务；打开后同一个键补成满密度、位置矩形还在 |
| `online-stream-play-probe`、`page-stream-probe` | 都 PASS |
| `verify-determinism` | 1800 帧逐字节相同 |
| `verify-unified-frames` | PASS |
| 两支键的比对（合并后） | 见第 11 节 |

四支用在线构建的探针（`browser-stream-e2e`、`hosted-render-streams`、`online-stream-play`、`page-stream`）是在第二次合并之前跑的，合并后没有重新构建、重跑。

`sparse-stream-probe` 的数（合并后的那一次）：

- 次序：甲 16 个分段先各落一版稀疏的（事件序号 0～31），第一个满密度分段开工在序号 32；乙 7 个分段同样。
- 稀疏版：每段 `stride` 15、样本数等于这一段的帧数；每段里的样本逐字节相同；最像的都是分段第一帧，错 0。
- 位置矩形：甲的字块每段 `x` 差 150（每帧横移 10 像素 × 15 帧），乙的橙块每段 `x` 差 5，与参照画面的不透明区域各边差不超过 1 像素。
- 补密：甲两条流各放大一次（宽 716 → 920 / 788），裁掉内容的帧 0。
- 舞台：贴稀疏版时 9 处抽查画的都是分段第一帧的画面（看过截图 `stage-sparse-47.png` 对 `export-47.png`：药丸在 x≈218，导出第 47 帧在 x≈288）。满密度补齐后停着的第 47 帧自己换成了这一帧的画面；之后逐帧走 165 拍、过 11 个分段边界，154 拍是这一帧自己、11 拍是分段第一帧（两版同一幅），画错 0。
- 队列那条路：稀疏流任务产 3 段（每段一张、带位置矩形）→ 再做一次一帧不截 → 满密度任务补 3 段 → 晚到的稀疏流任务不截、不降级。

第一次合并后还跑过一遍全量（6666 条，失败 1：`server/test/reopen-hosting.test.mjs`「真实中继 free」读到空的 `expiresAt`，与流无关，单独重跑通过）；以最后那一遍为准。

## 9. 没做成的

- **预渲染进程里稀疏版没有排到锚帧快照前面。** 现在的次序是锚帧快照 → 流（先稀疏后满密度）→ 其余快照。语义写的是「打开项目、测量卡片时先给每张重卡产一套稀疏的轨道流」；快照正由另一块撤掉，撤完这一条自然成立，我没有去挪那一行（会和撤快照的改动撞）。
- **`src/render/onlineStreams.test.mjs` 里还有一处 `stride: 3, samples: 5`**（假造的稀疏分段）。这个测试文件跟着 `snapshotSource.ts`，没动。
- `scripts/probes/stream-sparse.mjs` 是当初量「每 3 帧一张体积是满密度几成」的一次性测量脚本，没人再跑，没动。
- 流播放器的那 3 处改动没有单测，合并后也没有探针经过它（第 6 节）。
- 界面上「生成轨道流」另外三句话（打开后的说明、关闭的提示、关闭的确认）还写着「不再为这个项目生成轨道流」，和现在的行为（关着仍产稀疏版）不完全一致。用户只认可了没打开时那一句，其余没动。
- 四支用在线构建的探针没有在第二次、第三次合并后重跑（第 8 节）。
- 第三次合并后的全量测试有 1 条失败（端口被占，单独重跑通过），没有再跑第四遍全量。

## 10. 要主会话决定或注意的

1. 〔裁〕一的读法要用户过目（第 7 节）。
2. 部署次序：文档服务要先于渲染节点、桌面升级，否则只是不切稀疏流任务，不出错。
3. 6 张卡的键变了（第 11 节），原因是动了 `streamPlayer.ts`。
4. 第 6 节那 3 处现在没有测试盖着：留着、补一条「播放途中重问清单」的测试，还是先拿掉，请定。
5. 第 9 节界面另外三句话要不要改，等用户给原文。
6. 四支在线探针建议主会话闸门时在合并后的代码上重跑一遍。

## 11. 键

- **流的键**：全部换（代码版本 3 → 4），已产出的流重产一次。
- **卡的键**（`card-table-digest-compare`，对第二次合并后的 main；第三次合并没有动卡片和渲染）：6 张变了——`focus-card`、`lottie`、`particles`、`probe-slow`、`probe-slow-stepped`、`terminal-3d`，其余 95 张的能力表、源码版本、三个键逐张相同。和第一期是同一组卡，原因同样是它们的源码版本算进了 `src/render/streamPlayer.ts`。
- `server/bakery/` 没有动，截图代码指纹不变；导出不受影响（`verify-determinism` 1800 帧相同）。

## 12. 提交

```
85e4e04a 报告:开工
c825d256 流(二甲):稀疏版每个分段只截第一帧;位置矩形进清单;删 snapshotGrid;代码版本 3→4
7f6d0469 流(二乙):任务队列里加稀疏流任务;渲染服务关着时仍产稀疏版
f0a1a655 流(二乙续):拉来的满密度能把稀疏升上去;流播放器按拉分段时的矩形摆;新探针
69531a8e 流(二甲续):顶到收紧矩形的边改成重量一趟;去掉没人用的变体;stride 3 的测试换掉
f868fd6b 合并 main
9e7acff9 流(二乙续):位置矩形带到满密度的清单里;browser-stream-e2e-probe 跟上两趟
ffd87a54 探针:hosted-render-streams-probe 跟上「关着时只产稀疏版」
844220ab 报告
f983c6da 合并 main(含「暂停和拖动贴流」)
1afaf176 探针:sparse-stream-probe 第 6 条跟上合并进来的流播放器
c4a3c126 报告
a9134212 合并 main(云端 Agent 工具表接线)
(之后) 报告定稿
```

## 13. 进程

自己起的 dev server（27860，连同它的预渲染子进程）和启动脚本已按进程号收掉；探针自己起的 dev server、无头 Chrome、文档服务、渲染服务由探针自己收。最后查过：27860～27899 没有监听；没有父进程已经不在的 chrome、node、ffmpeg 是我留下的（查到的两个是用户自己的程序，没有碰）。有一次我用 `timeout` 掐掉了跑到一半的 `browser-stream-e2e-probe`，事后按上面的办法查过，没有留下东西。
