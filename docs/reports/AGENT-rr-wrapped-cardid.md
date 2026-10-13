# AGENT 报告:rr-wrapped-cardid

分支 `claude/rr-wrapped-cardid`,从 main `53e7a9ca` 分出。没有推送、没有合并。

## 要修的毛病

片段挂了强调、滤镜时,卡片图(`src/kernel/cardGraph.mjs` 的 `projectCardGraph`)给它的输出节点是外面那一层(`@clip/<id>/emphasis`、`@clip/<id>/filter`),卡片自己在这一层的 `inputs.source` 后面。`server/frame-pipeline.mjs` 的 `planForQueue` 给控件补 `cardId` 时只看输出节点,补出来是 `null`。`server/render-node/split.mjs` 靠这个 `cardId` 判几件事,套了一层的片段于是都判错。出处是 `docs/reports/AGENT-rr-emphasis-key.md`「查出的别的事」第 1 条。

改之前,同一张卡「不挂」和「挂强调 / 挂滤镜」两种片段切出来的任务差在哪(单测 `server/test/wrapped-cardid-split.test.mjs` 在改之前的写法上跑出来的,4 条全红,提交 `ba2eb92e`):

| 卡 | 不挂 | 挂了强调或滤镜(改之前) |
|---|---|---|
| Lottie 素材卡 | 浏览器 0 份 | 快照、流各多出浏览器那一份(共 2 个浏览器任务) |
| 改过源码的内置卡(改动层) | `requires.cardSources` 是这张卡的代码身份,不给浏览器 | `cardSources` 是空的,还另出浏览器那一份:手里没有这份代码的节点能认领 |
| 用户卡 | `requires.userCards: true` | `userCards: false` |
| 普通内置卡 | `input.cardId` 是这张卡 | `input.cardId: null` |
| 画布卡(审阅表 `canvasHeavy`,例 `particles`) | 重度「重」,不给浏览器 | 重度「中」,另出浏览器那一份 |

最后一行是做第 3 步(查别处)时查出来的同一类毛病:外面那一层的能力表是从上游推的,只有「要不要预渲染」「依不依赖下层」两项,画布卡这一项丢了。画布卡在浏览器里逐帧顺推与桌面不等价(这是原来不给浏览器的理由),所以一并修了。

## 做了什么

只动了三个文件:`server/render-node/split.mjs`、`server/frame-pipeline.mjs`(只有 `planForQueue` 里三处和一行 import)、新单测 `server/test/wrapped-cardid-split.test.mjs`。`server/card-cache.mjs` 没有动:里面那张卡在 `planForQueue` 手里的卡片图上就查得到,不用让 `plan` 多带字段,键的算法一个字没碰。

`split.mjs` 新增四个导出的小函数:

- `innerCardIds(graph)`:一个节点里面有哪几张卡。节点自己的 `cardId` 在前,再顺着 `inputs` 一层层往上游收到底(输入按名字排序、去重);同时回 `unsure`(这个节点或某个上游在图里找不到,或成环)和 `canvasHeavy`(自己或某个上游是画布卡)。
- `withInnerCards(cardPlan, graph)`:给每个控件补 `cardId`、`cardIds`,需要时补 `cardIdsUnsure`、`innerCanvasHeavy`。`planForQueue` 原来那一行 `cardId: control.cardId ?? cardIdOf.get(control.nodeId) ?? null` 换成调它。
- `cardIdsOf(control)`:控件里面的卡。有 `cardIds` 用它;没有(旧调用方、现有单测只给 `cardId`)就是 `cardId` 那一张。
- `isUserCardControl(control, sourceVersions)`:`planForQueue` 交给切分的 `isUserCard` 换成它。

`splitPlan` 里改了四处判断,都从「看 `control.cardId`」换成「看 `cardIdsOf(control)`」:给不给浏览器(Lottie)、共享档快照任务的 `requires.cardSources`、单卡流浏览器那一份的 `requires.cardSources`、重度。

## 裁定〔裁〕

没有改语义文档。下面三条都是用户看不出区别的取法(三级)。

1. 〔裁〕**套了不止一层**(又挂滤镜又挂强调):顺着输入走到底,里面还是那一张卡,和不挂一样办。
2. 〔裁〕**里面不止一张卡**(外面一层接着两段,转场的样子;或者输出节点自己是卡片、上游还有别的卡):
   - `input.cardId`:输出节点自己是卡片就是它(与原来相同);否则不取,写 `null`。
   - `requires.cardSources`:里面每张定制卡各一项,都要。
   - `requires.userCards`:里面任何一张是用户卡就为真。
   - 浏览器节点不做(页面的隔离单卡工程只认一张卡)。
3. 〔裁〕**拿不准**(输出节点或某个上游在图里找不到):要这一版全部定制卡的代码;这一版只要有用户卡就算用户卡;浏览器节点不做。`validateCardGraph` 过了的图不会出现这种情形,这一支是兜底。

原则是往多里要、往少里给:宁可让一个本来能做的节点不认领,不让没有代码的节点认领。

## 没修的(同一类,文件不在清单里,或者不能动)

1. **挂了强调、滤镜的画布卡,任务的 `input.canvasHeavy` 仍是 `false`**。这个值决定清单的体积上限(画布卡 1 MB,其它 300 KB),推送那一侧(`frame-pipeline.mjs` 的 `enqueueSnapshotPush`、`cardPushPriority`)按控件的能力表算同一个值,两边必须一致,而那一侧不在 `planForQueue` 里。只改切分一侧会让两边对不上,所以没动。后果(只读了代码,没有经管线跑):这种片段的快照按 300 KB 的上限判,超了的帧不进就绪索引。根子在 `src/kernel/cardGraph.mjs` 给外面那一层推能力表时不带 `canvasHeavy`,那是不许改的十个文件之一。
2. **`queueSinglePass`、`queueWeightClass`、`cardPushPriority` 读的是 `entry.cardPlan` 里控件的能力表**,同样看不到里面的画布卡:挂了强调的画布卡在执行器里会走一趟顺推(画布卡本来不走)、推送优先级按普通卡算。切分这一侧的重度我在 `splitPlan` 里补了,这三处在 `planForQueue` 之外,没动。
3. **成本键**(`card-cache.mjs` 的 `costKey`,页面一侧 `src/render/pipelinePlan.mjs` 同口径):源码版本取的是输出节点的 `cardId`,套了一层的片段取到 `null`,里面那张卡的源码变了成本键不变。这是键的算法,派活指令不许动;只影响成本记录,不影响画面。
4. **在线页面的清单计划**(`src/online/pageStreamPlan.ts`):也是只看输出节点的 `cardId`,套了一层的片段判成「不是内置卡」,页面不产它的流(另有一道 `wrapped-node` 的闸)。这是往保守判,不会让页面错做;不动 `src/`。
5. 输出节点的 `frameMode` 也丢了(`docs/reports/AGENT-rr-emphasis-key.md` 第 3 条已记),与这次无关。

查过没有问题的:执行器把任务对回这一版用的是 `input.clipId`,不看 `cardId`(`server/prerender-executor.mjs`);层表里没有 `cardId`;`server/frame-stream.mjs` 用的是片段上的 `clip.cardId`,不是控件的;`input.cardId` 在 `server/`、`src/`、`desktop/` 里没有读它的地方。

## 验证结果

全部在最后一个代码提交 `bfd2d08d` 上跑(探针里 `stream-produce-probe` 是在 `d1bfe8b8` 上跑的,之后只改了 `split.mjs` 与它的单测,`frame-pipeline.mjs` 与 `src/` 没再动)。

| 项 | 命令 | 结果 |
|---|---|---|
| 新单测(改之前) | `npm test -- server/test/wrapped-cardid-split.test.mjs`,提交 `ba2eb92e` | 退出码 1,WC-01～WC-04 四条全红 |
| 新单测(改之后) | 同上 | 退出码 0,10 条通过(WC-01～WC-10) |
| 现有切分单测 | `npm test -- server/test/browser-stream-split.test.mjs server/test/m7-split.test.mjs`(与上一项一起跑) | 三个文件共 31 条通过,0 失败 |
| 不套一层的片段与 main 相同 | WC-06:Lottie、普通内置卡、人物聚焦卡、用户卡、画布卡各一个不挂的片段,照 main 的写法和新写法各出一遍控件、各切一遍 | 控件只多 `cardIds` 一栏;切出的任务 `deepEqual`(有定制卡、没有定制卡两种情形) |
| 类型检查 | `npx tsc -b --force` | 退出码 0 |
| 全量测试 | `npm test`(设了那两个环境变量) | 退出码 0,5868 条里通过 5864、失败 0、跳过 4,末行「零失败」。跑了两遍(`d1bfe8b8` 上一遍 5866 条、`bfd2d08d` 上一遍),都是一次过,没有遇到已知的偶发失败 |
| 卡片源码版本 | `node scripts/probes/card-source-version-compare.mjs --base main` | 退出码 0,88 项 0 变,61 个身份 0 变 |
| 内置卡逐张 | `node scripts/probes/card-table-digest-compare.mjs --base main --expect ,` | 退出码 0,101 张逐张相同,生成快照的代码指纹相同 |
| 在线构建 | `npx vite build --mode online --outDir out/rr-wrapped-cardid/dist-online --emptyOutDir` | 退出码 0 |
| 现有探针 | `node scripts/probes/m7-node-probe.mjs --dist out/rr-wrapped-cardid/dist-online --base-port 27870` | 退出码 0,`"fails":[]`(`d1bfe8b8`、`bfd2d08d` 各跑一遍) |
| 现有探针 | `node scripts/probes/stream-produce-probe.mjs --origin http://127.0.0.1:27860` | 退出码 0,`PASS`,`fails: []` |

另跑了一支没点名的:`node scripts/probes/card-plan-key-compare.mjs --base main` 退出码 1,但 12 个片段「变了的键」全是「无」。它是上一块修键时写的,写死了「带上游的片段必须变三个键」;基准现在已经含那次修,所以它报不符。对这一块来说它说明的是:`plan` 出的键一个没变。

没跑 `verify-determinism`、`verify-unified-frames`:派活指令说不用(不出画面)。没有看图:这一块不出画面。

dev server 用 `scripts/lib/dev-server.mjs` 起在 27860(舞台端口 27861、27862),带 `PROMPTCUT_NO_PORT_FILE=1` 和临时数据目录、导出目录;`m7-node-probe` 用 27870～27874。跑探针前后查可见窗口都是 0 个。跑完 27860～27879 上没有监听,命令行里带本工作区路径的 node、chrome、ffmpeg 进程没有残留。

没有经真的管线端到端跑「挂了强调的 Lottie、用户卡」:`planForQueue` 要预渲染间给卡片计划,这一块的判断全在切分里,单测是照 `planForQueue` 的拼法(同一个 `withInnerCards`、同一个 `isUserCardControl`)喂的真卡片图和真 `CardFrameCache.plan`。

## 哪些卡的键变了

没有。内置卡 101 张逐张相同;`CardFrameCache.plan` 出的键一个没变(没有动 `card-cache.mjs`)。任务 id 由结果键和段算出,也不变。变的只是套了一层的片段的任务上 `requires`、`input.cardId`、重度,以及出不出浏览器那一份。

## 对任务书或语义的更正建议

- `docs/reports/AGENT-rr-emphasis-key.md` 那一条说「用户卡挂了强调以后 `requires.cardSources` 是空的」。实测用户卡不在审阅表里,是本地档,`cardSources` 本来就写全部定制卡,挂不挂都不空;错的是 `userCards` 变成了 `false`。`cardSources` 变空的是**改过源码的内置卡**(共享档)。
- 「没修的」第 1、2 条的根子是外面那一层的能力表不带 `canvasHeavy`。要彻底修得改 `src/kernel/cardGraph.mjs`(十个不许改的文件之一,改了内置卡的键会变),或者让 `card-cache.mjs` 的 `plan` 给控件多带一栏、再把 `frame-pipeline.mjs` 里读 `capabilities.canvasHeavy` 的五处一起换。要主会话定。
- 语义文档不用改。

## 提交

- `269ee34f` 报告:建报告文件
- `ba2eb92e` 测试:坐实现象,WC-01～WC-04 四条红
- `d1bfe8b8` 修:`planForQueue` 顺着输入找到里面的卡,切分按里面的卡判
- `bfd2d08d` 修:挂了强调、滤镜的画布卡切分时照画布卡办;WC-09、WC-10
- 本报告的提交
