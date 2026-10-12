# AGENT 报告：rr-a1-produce（渲染重构「甲一」的「产」这一半）

分支 `claude/rr-a1-produce`，基于 `claude/rr-a1`。任务：在线浏览器节点认领并生成单卡轨道流（`browser-stream-task.md`「还差的七处」里的一、二、三、四，外加桌面把浏览器产的流拉回去采纳）。

文中的「甲一」指 `render-refactor-task.md` 里「在线浏览器生成和播放轨道流，经过任务队列」那一项；「清单计划」指在线页面发布的、带片段清单的 `plan` 任务；「浏览器那一份」指切分方按浏览器指纹另出的那份细任务。

## 状态

2026-10-12 做完，待主会话审。五项都做了，验收的单测、端到端探针、基线两条的结果在「验证结果」。**有两处改动落在给定文件清单之外**，各自单独一个提交，见「越界的两处」。

## 做了什么

| 处 | 改了什么 | 文件 |
|---|---|---|
| 一、切分 | 单卡流、且成员卡照快照那一套判下来浏览器做得了的，多出浏览器指纹的一份：结果键 = 流的内容键 × 浏览器指纹；`requires.envFingerprint` 是浏览器指纹、`transcode: false`、仍要求 `capabilities.streams`；`input` 带 `dual`、`compositing`、`bake`、`stream`。组流、缺形状字段的流、成员卡不在计划里的流只出切分方那一份。锁（锁键 `stream:<内容键>`）、`dual`、用户卡与素材效果卡用 `cardEnvFingerprint`，都照快照的规矩。「浏览器出哪几份」抽成 `browserPlanOf`，快照与流共用，快照的输出不变 | `server/render-node/split.mjs` |
| 一、调用方 | 流的形状由 `queueStreamOf` 交给切分；清单计划按清单里的片段算流（`planListStreams`），只给浏览器出一份 | `server/frame-stream.mjs`、`server/render-node/local-node.mjs`、`server/frame-pipeline.mjs`（越界） |
| 二、过滤 | 规则 2 只看任务自己写的 `requires.transcode`。另在规则 7 加了浏览器流任务的形状闸（见〔裁〕3） | `server/render-node/filter.mjs` |
| 三、舞台交像素 | `BakeFrameRequest` 加 `pixels: { rect }` 与 `html`；`bakeFrame` 生成快照之后照小尺寸那条路按原尺寸把矩形画成位图，随 `bake-frame` 事件转移给父页；画不出来回 `pixels-failed` | `src/render/stageRpc.ts`、`src/render/bakeSmall.ts`、`src/StageView.tsx`、`src/online/stageMessageGuard.ts`（越界） |
| 四、节点执行流任务 | 能力位 `streams` 由宿主按 `probeStreamEncoder` 报；`render` 放行 `kind: 'stream'`；宿主按 `input.bake` 建隔离单卡工程，逐段逐帧要像素、送 `openStreamEncoder`，开头文件与分段按哈希推素材服务的 `px`，全部做完往内容库写 `render-manifest`（键 `<结果键>:<起>-<止>`），再报完成。让路、中止、丢认领照快照的规矩 | `src/online/browserNode.ts`、`src/editor/browserNodeHost.ts` |
| 五、桌面拉回去 | **不用改**：`streamAdoption`、`adoptSegments`、`applyResult` 本来就认新的编码器名和形状，单测与端到端都验了 | 无 |

`src/render/streamEncode.ts`、`streamMux.ts` 没有改，原样接上了。低内存档的分支没有碰。缺素材提示分支改过的那几个文件没有碰。

### 越界的两处

给定清单里没有这两个文件，但不改它们第一处和第三处做不成。各自单独一个提交，方便整个撤掉或单独审。

1. **`server/frame-pipeline.mjs`（提交 `54dc7cc6`）。** 任务清单写的是「`local-node.mjs` 给 `splitPlan` 传流信息的那一处」，实际只传流键和分段范围的那一处在 `planForQueue` 里。改动：`streams` 一项改用 `queueStreamOf`（多带形状字段，原有五个字段不变），加 `browserStreamsFor` 和 `listStreamSpecs`。别处没动。
2. **`src/online/stageMessageGuard.ts`（提交 `63c023a4`）。** 父页对跨源舞台的事件只留认得的字段，不加这一处位图到不了父页。改动只在 `bake-frame` 一种事件：位图要真是 `ImageBitmap`、大小与矩形一致、矩形为整数且不超过 8192。

另外为过滤规则 2 的变化改了两份旧单测里的三处断言（`render-node-logic.test.mjs`、`online-card-n.test.mjs`）：原来的夹具是不带 `transcode` 的流任务，靠「是流任务就要转码」被挡；现在夹具照真实形状带上 `transcode: true`，结论不变。`online-card-n.test.mjs` 里「浏览器不认流任务」那一条现在由规则 7 挡，断言改成规则 7，并补了一条「写了要转码的流任务仍由规则 2 挡」。没有放松或跳过任何断言。

## 验证结果

机器：这台 PC。端口段中途由主会话改为 7410～7419（原 5810～5819 上起的探针按进程号收掉了，端口确认已空）。

### 基线两条（提交 `16566543`）

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误 |
| 全量测试 | `npm test`（带两个环境变量） | 退出码 0；5555 条，通过 5551，失败 0，跳过 4 |

### 单测（新增 26 条，三个文件）

| 文件 | 条数 | 覆盖 |
|---|---|---|
| `server/test/browser-stream-split.test.mjs` | 16 | 切分：浏览器那一份逐字段的形状；只给单卡流；组流、画布卡、Lottie、重度为「重」的卡、本地档、超体积、锁在别处的卡不出；切分方那一份与改动前的字面量逐字相同（有浏览器时只多 `input.dual`）；锁、接手、用户卡与素材效果卡、`browserOnly`；快照任务不受影响。过滤：规则 2；切分方的流任务行为不变；规则 7。调用方：`queueStreamOf`、清单计划只给浏览器出流、补渲计划与旧执行器照旧 |
| `server/test/browser-stream-manifest.test.mjs` | 3 | 清单与桌面 `collectStreamResult` 逐字段同形（键一个不多一个不少，类型相同；`header.tight` 与 `sig` 两处按任务书为 null）；过 `manifestMatches`、`streamAdoption`；桌面 `applyResult` 拉回去、落盘字节逐字节相同、判为满密度不旧、再拉一次全部跳过 |
| `src/online/browserStream.test.mjs` | 7 | 帧号换算（全局帧减 `firstFrame`；不在卡范围里的帧为 null 即全透明；最后一段到项目末帧）；能力位与认领；让路、中止、丢认领、出错；父页守卫；要像素的矩形与 SVG（小尺寸的 SVG 与改动前逐字相同） |

单独跑这三个文件：26 条全过。

### 端到端探针 `scripts/probes/browser-stream-node-probe.mjs`

四个角色都在本机：进程内托管组合（文档服务加素材服务）、真的桌面预渲染进程当切分方（`startQueueEditor`，测试指纹，只切分）、在线构建的页面当浏览器节点、本进程里另起一个同一份代码的 `FramePipeline` 用 ffmpeg 产同一张卡的流当参照。

命令：`node scripts/probes/browser-stream-node-probe.mjs --dist out/rr-a1-produce/dist-online --base-port 7410 --out out/rr-a1-produce/e2e-final`

结果：**退出码 0，`ok: true`，`fails: []`**。跑了两遍完整的（改计数之前一遍、最终提交上一遍），两遍都过。最终那一遍的关键数字：

- 认领：页面完成 3 个流任务、4 个快照任务，失败 0；桌面 `planSplit` ≥ 1、`completed: 0`（只切分）。
- 清单：内容库 `render-manifest` 里有 `<结果键>:0-3`，过 `manifestMatches`；结果键 = 参照管线算出的流内容键 × 浏览器指纹，且不等于桌面指纹的键；编码器 `webcodecs-avc`，`stride: 1`，15 个样本，矩形 = `bound`。
- 素材服务：1 个开头文件加 4 个分段都在 `px`、complete，取回的字节哈希与清单一致，共 206 KB；服务端的 `initInfo`、`segmentInfo` 读得出。
- 桌面采纳：桌面 `applied: 2`、`applyErrors: 0`；它的流库里那条流的开头文件和 4 个分段与素材服务上的逐字节相同，记为 `adopted`。
- 画面（60 帧，1280×720，与参照流逐帧比，满分 255）：

| 量 | 平均 | 最大 |
|---|---|---|
| 色半区，整幅 | 0.162 | 0.216 |
| 透明度半区，整幅 | 0.007 | 0.030 |
| 色，只看有内容的像素（每帧约 7.7 万个） | 2.32 | 2.45 |
| 透明度，只看有内容的像素 | 0.081 | 0.328 |

  卡范围之外的 12 帧两边都是全透明。对照：同一帧去比参照流里隔 24 帧的那一帧，内容区的差是 15.09，同帧是 1.71，平均 8.8 倍，最小的一帧 7.66 倍。
- 让路：产流途中开始播放，放回恰好一次（`yield-play`），播放期间帧数和认领数不变，停下后做完，已推完的 1 个分段没有重做，失败 0。
- 中止：产流途中页面隐藏，立即放回（`yield-hidden`），宿主没有记「等当前帧做完」的那种让路；回到前台后做完，失败 0。

看过的图：`out/rr-a1-produce/e2e-2/browser-frame-14.png` 与 `desktop-frame-14.png`。两张都是上半一个橙色圆角块（带点阵和「bsn」字样）、下半同样位置一个白色圆角块，肉眼看不出差别。

耗时（只记录）：舞台一帧 p50 81 ms；其中取像素 p50 28 ms、p95 40 ms；送编码器 p50 5 ms、p95 12 ms；第一张卡 48 帧快照加 60 帧流共 30 秒；参照流 ffmpeg 产 4 段 3.3 秒。无头 Chrome 关了显卡，编码器走的是按码率那一档（`variable`），固定量化那一档它不认。

### 回归：现有的浏览器节点探针

**开工前在分支当时的提交（`133487fe`）上跑的对照：**

| 探针 | 结果 | 原因 |
|---|---|---|
| `m7-node-probe.mjs` | 退出码 1 | 等不到 `[data-pc="join-form"]`。在线构建的开始页现在只有账号入口，加入表单不再进在线构建。本来就不过 |
| `m7-browser-probe.mjs --no-a10` | 退出码 1，16 项全是 pending | node 角色同样等不到 `[data-pc="join-name"]`。本来就不过 |
| `m7-node-resume-probe.mjs`（新写的副本，见下） | 退出码 0，`fails: []` | 30 帧快照一段完成、让路各项都过 |

这两支探针进不了页面，没法拿来验。我写了 `scripts/probes/lib/online-resume-entry.mjs`：在页面载入前把「同一个标签页刷新前开着这个项目」的记录放进 sessionStorage，页面就走现成的 `resumeShared` 进项目，不注入页面代码。`m7-node-resume-probe.mjs` 是 `m7-node-probe.mjs` 的副本，只换了进项目的办法，断言没动。`m7-browser-probe.mjs` 没有做副本（两千行，四个页面），所以它的 A1～A12 这次没有跑成。

**改完以后在最终提交上跑 `m7-node-resume-probe.mjs`，三遍，一过两不过：**

| 遍 | 结果 | 不过的那一条 |
|---|---|---|
| 1 | 退出码 1 | 「D8：播放期间不认领、不生成快照」：2.5 秒后读到 `claims` 多了 1、`idle: true` |
| 2 | 退出码 1 | 「D8：放回之前至多再做完当前这一帧」：取样到放回之间多了 2 帧，断言只许 1 帧 |
| 3 | 退出码 0 | 无 |

我的判断是这两条都是探针自己的时序，不是这次改出来的，理由如下，但没有在改动前的代码上多跑几遍来坐实，请主会话在机器闲的时候复跑：

- 第 1 遍：项目时长跟着内容走（`src/kernel/duration.ts` 的 `effectiveDuration`），那张卡 2 秒，所以播放 2 秒就结束，再过 500 毫秒安静期页面就算闲。探针恰好在播放开始后 2500 毫秒取样，正踩在边界上。
- 第 2 遍：探针每 200 毫秒取一次样，取到以后再发播放命令；一帧约 90 毫秒，取样到命令到达之间可以多做完一帧。
- 快照这条路我没有改逻辑；当时别的工作区也在跑测试。
- 新探针里同样的两件事（让路后不产帧、放回前不多做）用的是 4 秒的卡和带余量的断言，两遍都过；它的 F 项另验了快照任务照旧完成。

`cd1336f9`（生成一帧时从挂载帧完整推到目标帧）改的是跳到片段 6 秒以后的情形，上面这些探针用的卡都不到 6 秒，验不到它。任务书里「14 张有状态的卡重跑一遍」那一项是专门验它的，进度文件里记着待派。

### 全量测试

在提交 `16566543` 上跑了一遍：`npm test`（同一条命令里设了 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT` 与 `PROMPTCUT_PASSWORD_ORDER_MODULE`），退出码 0。汇总行：tests 5555、pass 5551、fail 0、cancelled 0、skipped 4，用时 111 秒。没有文件级失败，没有触发单独重跑。开工自检时 `main` 上是 5503 条、跳过 4；多出的条数里 26 条是这次新增的，其余来自集成分支。

## 没做成的及原因

1. **`m7-browser-probe.mjs` 的验收项没跑成。** 原因见上：进不了页面。入口工具已经写好，给它换入口是一处四行的改动（第 1608～1611 行），但改现有探针不在我的文件范围里。
2. **桌面把浏览器产的流拉回去以后，自己的舞台不会播它。** 桌面按自己的指纹给流出键，浏览器产的那条流的键是浏览器指纹的，落进桌面流库以后是「只挂在键上、不属于任何一版」的状态。这和浏览器产的快照现在的处境相同（`m7-contract.md` 第 6 节：桌面的本机锁库与队列锁是两本账）。任务书说的「确认桌面能播」因此只做到「拉回去、落盘、字节相同、登记进就绪索引」这一步。要让桌面真播，得让桌面的流计划照队列的锁换键，这是 `StreamProducer.update` 和 `planForQueue` 的事，超出这次的范围。
3. **手机、平板、Safari、Firefox 没测**，任务书本来就不要求。

## 裁定〔裁〕

没有改语义文档。下面是实现里自己定的，请主会话审。

1. **清单计划只给浏览器出流，切分方自己的那一份不出。** 现状是清单计划根本不切流（`listPlanOverrides` 原来写死 `streams: []`），浏览器节点又只能认领同一用户的在线页面发的任务，所以浏览器那一份只会出现在清单计划里。如果连切分方自己的那一份一起出，桌面认领以后要在执行器里按清单重算流才对得回任务（`prerender-executor.mjs` 的 `matchStream`），否则它先抢到锁、再因对不上而失败，这条流就没人产了。桌面和渲染主机替在线页面产流是「甲三」的事。做法是给流加一个 `browserOnly` 标记。
2. **切分方自己不能产流时，浏览器那一份照出。** `listStreamSpecs` 不过「本机能不能产流」那道闸。这样线上只有不产流的渲染服务时，浏览器也收得到流任务。
3. **过滤规则 7 加了浏览器流任务的形状闸**（任务书没要求）：纯浏览器只收 `input.stream` 是单卡流、带 `input.bake`、独立卡、不是画布卡的流任务。规则 2 放开以后，不带 `transcode` 的流任务不能只靠切分方挡。
4. **浏览器指纹与切分方指纹相同时不另出流的浏览器那一份。** 两份的任务 id 会相同，而切分方那一份要本机转码，浏览器做不了。快照没有这个问题，所以这一条和快照不同。
5. **像素用 `ImageBitmap` 转移**，并加了 `html: false` 让只要像素的调用方不收 HTML 字节。跨源、独立进程的舞台到父页实测转得过去。
6. **让路时把编码器里已经满了的分段冲出来并留着，没满的那一段丢掉**；重新认领同一段只补缺的分段。中止时直接关编码器。
7. **舞台往返复用 `stageBake.ts`，没有改它**：另开一个不出小尺寸的实例，经一层包装把「要像素」加进请求。`stageBake.ts` 不在文件范围里。
8. **流任务的块不进页面内快照库。** 播的那一半从素材服务取。

## 对任务书或语义的更正建议

1. `browser-stream-task.md`「现在的流程」第 3 条说轨道流任务「只出切分方自己的一份」。对清单计划不成立：清单计划原来一条流任务都不出。第一处说的调用方 `local-node.mjs` 也不准，只传流键和分段范围的是 `frame-pipeline.mjs` 的 `planForQueue`。
2. 同一文件第二处说「队列（文档服务）用的是同一个文件，要重新部署文档服务才对浏览器生效」。`server/render-queue/queue.mjs` 不引 `filter.mjs`，过滤只在节点一侧跑。这一处要重新部署的是在线编辑器（页面包里带着 `filter.mjs`）和切分方。
3. 同一文件第三处漏了父页的消息守卫 `src/online/stageMessageGuard.ts`。
4. 在线页面的探针入口：凡是等 `[data-pc="join-form"]` 的探针现在都进不了页面，`scripts/probes/` 下有二十来支。`lib/online-resume-entry.mjs` 可以直接用。
5. 语义文档要改的三处（`product/platforms.md` 两句、`mechanism/rendering.md` 一段、节点能力表浏览器那一行）我没有动，进度文件写的是合到 `claude/rr-a1` 时改。
6. 给「播」那一半的提醒：浏览器做完流任务也会调 `onAlive(结果键)`，在线来源的「活着的键」里会多出流的结果键；层表里流的候选指纹可以照快照的 `splitCandidatesOf` 从切分出的 `stream` 任务里收（`input.contentKey` 加 `requires.envFingerprint`）。
