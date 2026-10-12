# 子 Agent 报告：下层一（依赖下层的卡的流：计划、键、输入签名、隔离工程、切分与认领）

分支 `claude/rr-below-plan`，从 `main`（`b0a1b111`）分出。任务书 `docs/plan/render-refactor-task.md`「戊二」，契约 `docs/plan/prerender-products-contract.md` 第 5.1、5.2 节。

「下层一」是「戊二：依赖下层的卡也产轨道流」拆出的四块里的第一块：只定这种流的身份、失效规则和谁能产。流里的像素怎么取是「下层二」，怎么贴回舞台是「下层三」，在线页面怎么读是「下层四」，都不在这一块。

## 结论

- 做完了派活指令点名的六项，全部放在一个缺省关的开关后面。
- 开关关着时，`planStreams`、切分、层表、认领判定、两种旧流的键、输入签名的输出与分出点逐字相同（同一批夹具两边各算一遍，1,631,517 个字符的 JSON，sha256 相同）。
- 内置卡的键一张没变。
- 没做成的一件、要主会话定的三件，见文末。

## 做了什么

### 1. 计划（`server/frame-stream.mjs`）

- `planStreams` 多一个选项 `below`。打开时，预渲染集合里依不依赖下层这一样是「依赖下层」（`belowDependent`）、旧的统称 `context`、「未知」（`unknown`；没写、认不出的值也按未知）的重卡，各出一条 `kind: 'below'`、`plane: 'stage'` 的流，排在单卡流和组流后面。判据在 `belowStreamEligible`。
- 框用了三维的卡照旧不进。源依赖卡缺省不进。**留好的口子**是常量 `BELOW_STREAM_RULES = { sourceDependent: false, frame3d: false }`：以后要把源依赖卡或三维框的卡并进这条路，把对应一项改成 `true` 就行（三维框的独立卡进不了单卡流，放宽后也走这条路）。隔离工程和键都不用再改：隐藏的序列仍是 `sourceOnly`，源片段找得到；目标卡的缓存内容键顺着输入带上了整条源链。
- 不参加组流合并，但占解码器预算：`groupStreams` 多一个参数 `fixed`（只算进重叠峰值、不被合并、不出现在结果里）。它们把预算顶超了，就合并旁边的独立卡。
- `queueStreamOf` 对这种流另带 `belowClipIds`；别的流交给切分的形状不变。

### 2. 键（`server/card-identity.mjs`）

`cardStreamIdentity` 认 `kind: 'below'`，摘要里是：

- 目标卡：带外观的缓存内容键 `control.cacheContentKey`，加采样的第一帧、相位、帧数；
- 下层：画家顺序排在目标卡下面、时间上有重叠的每一个画面层，各自的缓存内容键、第一帧、相位、帧数，按画家顺序排成一列；
- 画幅、帧率、`codeVersion`，再加一个新的版本号 `BELOW_STREAM_VERSION`。

算不出某个下层的键时（预渲染间不认识那张卡的定义，卡片计划里没有它），整条退回用整个项目的键 `entry.key`，流的规格里标 `belowScene: true`。连 `entry.key` 也没有就不出这条流。

单卡流、组流的摘要一个字没动；`STREAM_CODE_VERSION` 没动。

### 3. 输入签名（`src/render/streamInputSig.mjs`）

- `streamInputs` 加 `below` 一支：目标卡的片段签名、采样窗口、框、不透明度、淡入淡出、轨迹，加每个下层的同样几项，下层按画家顺序。
- 新导出 `belowLayersOf(project, clipId)`：画家顺序排在这个片段下面、时间上有重叠的画面层。**服务端算键、页面算签名、建隔离工程三处用的是这同一个函数**，所以对「哪些层算下层、谁在谁下面」不会各说各话。
- 签名的算法版本没加（新的一种，旧的两种签名不变）。

### 4. 隔离工程（`server/frame-stream.mjs`）

新函数 `isolatedBelowProject(project, spec, { withTarget = true })`：目标卡上面的序列整条藏成 `sourceOnly`；目标卡所在的序列里排在它后面的片段挪进一条隐藏的序列；下面的序列、素材、各层的外观原样；目标卡的外观原样；时间不平移。`isolatedStreamProject` 遇到 `kind: 'below'` 的流转到这里，单卡流和组流那一种不变。

### 5. 切分与认领

- `server/render-node/split.mjs`：这种流只出切分方自己的一份，`requires.transcode: true`、`requires.belowDependent: true`，重度一律记 `heavy`；浏览器那一份不出；`usesLocalMedia` 收到的那一项另带 `streamKind: 'below'` 和 `belowClipIds`。
- `server/render-node/filter.mjs`：规则 7 加一条，纯浏览器不收 `requires.belowDependent` 为真的流任务（原因 `below-dependent`）。
- `server/artifact-transfer.mjs` 的 `layerStreamsOf` 认 `below`（成员只有目标卡一张、`plane` 是 `stage`，形状不对的不列）。
- `server/prerender-executor.mjs` 的 `matchStream`：照旧按内容键认；另核一条「任务说的种类和这一版的流对得上」，对不上报 `plan-mismatch`。关着开关的节点收到这种任务，报的是「本机没有打开这种流」，不可重试。

### 6. 开关〔裁〕

`server/frame-stream.mjs`：

```js
export const BELOW_STREAMS_DEFAULT = false;
export function belowStreamsEnabled(env = process.env) { … PROMPTCUT_TEST_BELOW_STREAMS === '1' }
```

`planStreams` 的 `below` 缺省取 `belowStreamsEnabled()`。打开的办法两个：环境变量 `PROMPTCUT_TEST_BELOW_STREAMS=1`（照 `PROMPTCUT_TEST_PLAN_ONLY` 的写法，生产环境不设），或直接传 `below: true`。只有这一处开关：切分、层表、认领、执行器都只是「给了这种流就认」，`planStreams` 不出，它们就什么都看不到。「下层三」合入时把常量改成 `true`、删掉环境变量。

## 下层二接着做时要知道的

**开关在哪。** 上一节。探针里设 `PROMPTCUT_TEST_BELOW_STREAMS=1` 再起 `FramePipeline`，生产者、队列、层表就都带上这种流。**打开以后不要拿它开编辑器看画面**：生产者会照现在的截图办法（一张图、`hasMedia: false`）把这种流产出来并发层，而舞台还不认这种流。

**隔离工程怎么要。** `isolatedStreamProject(project, spec)`（生产者现在三处都是这么调的，不用改调用点），或直接 `isolatedBelowProject(project, spec)`。要「不带目标卡」的那一张（差分取层的 L）：`isolatedBelowProject(project, spec, { withTarget: false })`。两张的序列先后相同，只差目标卡在不在出画的序列里。

**流的规格里带了哪些字段**（`planStreams` 回的每一项）：

| 字段 | 值 |
|---|---|
| `kind` / `plane` | `'below'` / `'stage'` |
| `clipIds`、`topClipId`、`members` | 只有目标卡一张 |
| `belowClipIds` | 算进键里的下层，画家顺序，下面的在前 |
| `belowScene` | 键是不是退回了整个项目的键 |
| `offset` / `bound` | 零 / 整个画面（收紧留给产流那一趟量） |
| `firstFrame`、`lastFrame`、`firstSegment`、`lastSegment`、`fps`、`stage`、`total` | 同别的流 |
| `replay` | 目标卡和下层的卡片段里有一张是 motion 式的就是 `true`；纯素材段不算 |
| `mountFrame` | 这些有状态的卡里最早的挂载帧 |
| `hasMedia` | 项目里有没有画面素材（`bakeStream` 的 `hasMedia` 现在写死 `false`，下层二要接上） |
| `streamKey`、`contentKey`、`envFingerprint` | 同别的流 |

**要你改的一个数。** `server/card-identity.mjs` 的 `BELOW_STREAM_VERSION` 现在是 0，意思是「流里放什么还没定」。定下差分取层还是原样盖的那一次把它加到 1，以后每改一次流里放的东西再加一。不加的话，开关打开时用旧办法产出来的分段和新办法的同键，会被拿去贴。不要用 `STREAM_CODE_VERSION` 管这件事，那一个管所有的流。

**回放的代价。** 下层有一张从片头就在的 motion 式卡时，`mountFrame` 是 0：接不上租约的每个分段都从第 0 帧推过来。这是对的（导出也这么算），但慢；要优化得在产流那一趟想办法，不要改 `mountFrame` 的算法。

**清单计划那条路不出这种流。** 见「没做成的」。

## 验证结果

环境：Windows 11，Node 24，本工作区，2026-10-13。

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误 |
| 新单测（服务端） | `server/test/below-stream.test.mjs` | 17 条全过 |
| 新单测（经队列） | `server/test/below-stream-queue.test.mjs` | 3 条全过 |
| 输入签名单测 | `src/render/streamInputSig.test.mjs` | 7 条全过（新加 1 条） |
| 全量测试 | `npm test` | 见下 |
| 卡片源码版本 | `node scripts/probes/card-source-version-compare.mjs --base main` | 退出码 0；`"changed":[]`，88 项、61 个身份都没变 |
| 卡片表摘要 | `node scripts/probes/card-table-digest-compare.mjs --expect ,` | 退出码 0；101 张内置卡逐张相同，生成快照的代码指纹改前改后相同 |
| 产流探针 | `node scripts/probes/stream-produce-probe.mjs --origin http://127.0.0.1:27720` | 退出码 0，`PASS`，`fails: []`；三条流都是 `card`，探针项目里那张毛玻璃卡（里程表）照旧不进流 |
| 不回放探针 | `node scripts/probes/stream-noreplay-probe.mjs` | 退出码 0，`"ok": true`，`fails: []` |

### 验收逐条

**开关打开**（单测里给 `planStreams` 传 `below: true`）：

- 「下层任一层改一处参数、位置、时间、顺序，或多一层少一层，键和输入签名都变；上面的层怎么改都不变；目标卡的外观改了键变；两边反应一致」：`BL-key`。键用真的卡片计划算（项目 → `projectCardGraph` → `CardFrameCache.plan()` → `planStreams`），不是手写的假键。39 处改动逐处核对三件事：服务端的键变没变、页面的签名变没变、两者是否相同且是该有的那个。22 处下层的改动、7 处目标卡的改动两边都变；7 处上面的层的改动、3 处不相干的改动两边都不变。
- 「切分出的任务浏览器节点认领不了、带对了 requires」：`BL-split`、`BL-split-media`、`BL-claim`。浏览器节点平常在规则 2（不能转码）就被挡下；把转码和重度都放开，规则 7 仍明说不收。
- 「不参加组流合并、占预算」：`BL-budget`、`BL-budget-frames`。
- 「隔离工程里上面的层隐藏、下面的层和素材都在」：`BL-isolated`；经队列真走一遍时灌进预渲染间的也是这一种：`BLQ-on`。

**开关关着**（缺省）：

- `BL-off`、`BLQ-off`。
- 另做了一次分支与分出点的对拍：同一个脚本（放在工作区外的临时目录，不入库）在分支上、在分出点 `b0a1b111` 上各跑一遍，夹具四个项目（含毛玻璃、未登记的卡、`context`、三维框、remotion 式、素材带像素映射、九条序列逼出组流、只在本机的素材），每个项目三档预算，输出 `planStreams`、`queueStreamOf`、每条流的隔离工程、`layerMapOf`、`layerStreamsOf`、每条流的输入签名与签名输入、五种调用方式下的 `splitPlan`、每个任务对四种节点的 `checkClaimable`，以及 `cardStreamIdentity` 的单卡流和组流、`groupStreams`、`peakConcurrency`。两份 JSON 逐字节相同。
- 现有的 `frame-stream.test.mjs`、`browser-stream-split.test.mjs`、`layer-map-streams.test.mjs`、`env-fingerprint-keys.test.mjs`、`stream-queue.test.mjs` 一个字没改，随全量测试跑。

### 全量测试

`npm test`（同一条命令里设了 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT`、`PROMPTCUT_PASSWORD_ORDER_MODULE`），在最后一次改代码的提交上跑了一遍：

```
ℹ tests 5738
ℹ pass 5734
ℹ fail 0
ℹ cancelled 0
ℹ skipped 4
✓ npm test 最终结果：零失败
exit=0
```

一遍过，没有遇到已知偶发失败的那几个文件出问题，没有单独重跑。4 条跳过的是原来就按环境跳过的（没有只读的账号服务目录、Windows 上不请求符号链接权限、一条集成用例）。新加的 20 条（`BL-` 17 条、`BLQ-` 3 条）都在这一遍里。

这之前起过一遍全量，跑到一半我发现新注释里用了不许用的旧叫法，就把那一遍停了（停的是我自己起的那棵进程树），改完注释再从头跑的上面这一遍。

### 窗口与残留

跑探针前后各查了一次可见窗口，都是空的。自己起的开发服务器（27720，带 `PROMPTCUT_NO_PORT_FILE=1`）验完按进程号收掉了，27720～27739 上没有监听。公共的 `%TEMP%\promptcut\port.json` 没被我改写（它的修改时间是 03:10，早于我开工）。

## 做错的一处

`stream-noreplay-probe.mjs` 自己起开发服务器，认的是 `--port`，缺省 27560。我给它传的是 `--origin`，它没认，于是在 **27560～27562** 上起了一台，不在分给我的 27720～27739 里。探针跑完自己收掉了，事后查过 27560～27562 上没有监听。它经 `no-user-dirs.mjs` 带着 `PROMPTCUT_NO_PORT_FILE=1`，没有写公共的端口文件。结果本身有效，没有重跑。

## 没做成的及原因

**在线页面的清单计划那条路不出这种流。** 契约第 16 节「另外三件」的第一件写：桌面应用、托管方的渲染节点替在线页面产流（含依赖下层的流），要在「甲三」「下层一」里让清单计划也出切分方自己的那一份，并让本机只为清单里的片段产流。这一块没做，原因是要改的两处不在给我的文件里：

- `server/render-node/local-node.mjs` 的 `listPlanOverrides` 把清单计划的流一律标 `browserOnly`（只给浏览器出）。这种流浏览器做不了，所以一份都不出。
- `server/frame-pipeline.mjs` 的 `streamPicked` 只认本机判重的卡。就算切分出了任务，执行器按 `queueStreamSpecs` 也对不回这一版的流。

现在的行为是安全的（不出任务，不会有对不上的任务挂着），单测 `BL-split` 里钉住了「标了 `browserOnly` 的一份都不出」。这件事和「甲三」是同一处改动，建议并给它，或者并给「下层四」。

## 我做的裁定〔裁〕

都是三级（开关关着，用户看不出区别）。

1. **开关的形式**：常量 `BELOW_STREAMS_DEFAULT` 加环境变量 `PROMPTCUT_TEST_BELOW_STREAMS` 加 `planStreams` 的选项，只设在 `planStreams` 一处。
2. **`BELOW_STREAM_VERSION` 进键**，现在是 0。理由见上文「要你改的一个数」。
3. **下层由 `belowLayersOf` 认定，不用契约写的 `paintLayers`。** `paintLayers` 只收有 `cardId` 的片段和画面素材段，漏掉只有 `nodeId`、没有 `cardId` 的出画片段（导出页的 `plannedClips` 里有这一种）。漏掉一层，改它时键不变，旧流会被接着贴。`belowLayersOf` 把有 `nodeId` 的片段都算进来，口径和页面一侧原有的组流签名一致；只出声音的那种也会被算进来，只是多作废。
4. **时间重叠按秒算，两头各放宽 50 毫秒**（卡片的挂载提前量）。宁可多算一层。
5. **键里给每一层另补一项 `extra`**，现在只装素材段的像素映射。见下面「更正建议」第 1 条。
6. **这种流的任务重度一律记 `heavy`**，不看 `weightOf` 给的档。整场景渲；同时多一道不让浏览器认领的闸。
7. **`groupStreams` 在有 `fixed` 时换帧再找**：峰值那一帧上可能挤的都是不能合的流，而别的超预算的帧上有能合的一对。原来的算法只看峰值那一帧，找不到就停。没有 `fixed` 时走的仍是原来那一条，结果不变。
8. **`replay` 与 `mountFrame` 把下层的有状态卡算进去**。只看目标卡的话，下层的 motion 式卡会从半路挂上，画面不对。
9. **执行器多核一条「种类对得上」**。内容键里已经有种类，这一条是多一道防线。

## 对任务书或语义的更正建议

1. **契约第 5.2 节写「素材段的节点身份里有素材本身」，所以用 `cacheContentKey` 就够。不够。** 卡片图（`src/kernel/cardGraph.mjs` 的 `projectCardGraph`）只把滤镜、音频效果、强调串成节点，**像素映射不在图里**。给下层的视频挂上像素映射，这一层的 `cacheContentKey` 不变（`BL-key-pixelmap` 第一条断言钉住了这个事实）。我在键里另补了一项。建议契约补一句；另外这是卡片图本身的缺口，别的地方凡是拿 `cacheContentKey` 当「这一层画面的身份」的都有同样的问题，这次没有去查还有没有别处。
2. **契约第 5.2 节写下层「取自 `paintLayers`」。** 建议改成取自 `belowLayersOf`，理由见裁定第 3 条。`paintLayers` 自己漏只有 `nodeId` 的出画片段这件事也影响组流的「中间隔没隔着别的层」，这次没动它。
3. **契约第 13.2 节「下层一」一行写 `layerStreamsOf` 交给道二当时在做的那一块。** 派活指令改成了归我，已做。
4. **契约第 16 节「另外三件」第一件**把清单计划出切分方那一份记在「甲三」「下层一」名下。下层一的文件清单里没有那两处，见「没做成的」。
5. **`docs/semantics/mechanism/cards.md`「轴三」**不用改。合入「下层三」时可以补一句：下层依赖卡的流按「时间上有重叠的全部下层」失效，不按区域筛。

## 哪些卡的键变了

没有。两个比对脚本都是零变化。这一块没有碰那十个不许改的文件，也没有碰丙组的文件（`streamInputSig.mjs` 不在任何卡的源码闭包里）。

## 和「己一」的交叠

「己一」同时在改 `server/frame-stream.mjs`、`server/card-identity.mjs`、`server/card-cache.mjs`。我在这三个文件里：

- `card-cache.mjs` 没碰。
- `card-identity.mjs`：`cardStreamIdentity` 的签名加了一个参数、函数头上加了一行转发，文件末尾新加一个函数。成员键怎么拼的那一段没碰。
- `frame-stream.mjs`：新函数集中放在「流库」那一节前面的一个新小节里。动到旧代码的只有：`peakConcurrency`、`groupStreams` 各加一个可选参数；`planStreams` 的签名、`groupStreams` 那一行、`return specs` 前一行；`queueStreamOf` 末尾一行；`isolatedStreamProject` 开头一行。`STREAM_CODE_VERSION`、单卡流和组流出键的那几行、`bakeStream` 的调用都没碰。

「己一」合入后把 `main` 合进来时，预料会有文字冲突的只有 `planStreams` 和 `cardStreamIdentity` 的签名附近。
