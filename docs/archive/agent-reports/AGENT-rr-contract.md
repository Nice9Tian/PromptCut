# 子 Agent 报告：戊、戊二、己、庚、癸共用的契约

分支 `claude/rr-contract`，工作区 `.worktrees/rr-contract`，基于 `main`（`a556b7bc`）。2026-10-12。

任务：写 `docs/plan/prerender-products-contract.md`。戊、戊二、己、庚、癸是任务书 `docs/plan/render-refactor-task.md` 里五项的名字（remotion 式的卡不存每帧 HTML、依赖下层的卡也产轨道流、画布卡直接压流、快照换存法、Lottie 改成 remotion 式），它们都改「预渲染存什么」，这份契约是它们动手前共用的约定。只写契约，不写产品代码，不改语义文档，不改任务书。

## 做了什么

- 写了契约，15 节：四类卡存什么；快照什么时候产和用；暂停拖动时没有快照的卡贴什么；位置矩形和产流不回放；依赖下层的卡的流；画布卡取像素的两条路和要在节点上量的东西；快照的新存法；Lottie；旧结果怎么作废和新旧共存；基线脚本；用户看得到的区别；语义文档第 7、11 行的措辞；施工拆分；待定表；和任务书、语义对不上的地方。
- 中途主会话转来两件事，都处理了：端口段改为 7470～7479（见「端口」）；卡片的源码版本含导入闭包、卡片声音的身份也含它（契约第 9.1、9.2 节，第 11 节第 13 行，第 13、14 节各加了相应的条目）。
- 没有改任何代码、语义文档、任务书。新增的只有契约和本报告。

## 读了什么

规则：`AGENTS.md`，`docs/semantics/developer_guide.md` 和 `guide_files/` 六份。

计划：`render-refactor-task.md` 全文、`render-standard.md` 全文、`browser-stream-task.md` 全文；`m7-contract.md` 里和测量快照趟有关的几行。

语义：`product/rendering.md`、`product/cards.md`、`product/platforms.md`、`product/asset-service.md`、`mechanism/rendering.md`、`mechanism/cards.md`、`mechanism/asset-service.md`；`glossary.md` 里渲染相关的词条。

原型报告（各自分支上）：`claude/scrub-streams`、`claude/lottie-seed` 的报告全文，`claude/hosted-stream-entry` 的报告；`scrub-streams` 的代码差异看了改动清单和新增的常量、开关；`claude/browser-stream-encode` 上的 `snapshot-diff-apply-probe.mjs` 读了差异的表示法和贴法。

同时在做的分支（写契约期间看了两次，第二次它们已经有实现）：`claude/rr-card-table`（丁）的登记表、`capabilities.md` 和报告全文；`claude/rr-a1-play` 的层表 `streams` 表（`layerStreamsOf`）和 `streamInputSig.mjs`；`claude/rr-a1-produce` 的切分改动（`browserStreamInputOf`）。

代码（`main`）：

- 全文读过：`server/snapshot-tier.mjs`、`server/frame-stream.mjs`、`server/bakery/bake.mjs`、`server/card-cache.mjs`、`server/card-identity.mjs`、`server/frame-code.mjs`、`server/snapshot-store.mjs`、`server/asset-store/stream-store.mjs`、`server/artifact-transfer.mjs`、`server/render-node/split.mjs`、`src/editor/probeRunner.ts`、`src/editor/snapshotFeed.ts`、`src/render/snapshotPick.mjs`、`src/render/createSnapshot.ts`、`src/render/snapshot/rasterizeCanvas.ts`、`src/render/Stage.tsx`、`src/kernel/frameMode.mjs`、`src/kernel/cardGraph.mjs`、`src/render/cardSourceVersion.mjs`、`src/render/cardSourceFiles.mjs`、`scripts/verify-unified-frames.mjs`。
- 读了有关的函数和段落：`server/frame-pipeline.mjs`（`preload`、`fillAnchorSnapshots`、`missingSnapshotFrames`、`fillCardControls`、`recordSnapshots`、`snapshotTargets`、`acceptMeasuredSnapshot`、`publishLayerMap`、`adoptFromManifests`、`planForQueue`、`streamBusy`）、`src/StageView.tsx`（`render` 的探针分支、`bakeFrame`、`remountAt`、`setSuppressed`、`setStreamPlanes`、`setSnapshots`）、`src/render/snapshotSource.ts`（在线来源的说明、层表的类型、清单取满的判据）、`src/editor/browserNodeHost.ts`（前 330 行）、`src/render/placeholderHost.ts`（显示谁、几何）、`src/render/dataMirror.ts`（播放头和缺口上报）、`src/kernel/cardAudioRendition.mjs`（声音的身份）、`server/render-node/filter.mjs`（规则说明）、`server/queue-idle.mjs`、`server/ready-index.mjs`（文件头）、`scripts/probes/export-baseline-compare.mjs`（文件头）。
- 只按标识符搜过、没有读实现的：`src/render/streamPlayer.ts`（常量和函数名）、`src/online/bakeTask.ts`、`src/online/browserNode.ts`、`server/prerender-executor.mjs`、`server/artifact-push.mjs`、`server/render-node/pick.mjs`，以及契约第 10 节列的那些测试和探针。

## 哪些结论是查代码得出的

契约里凡是写「现状」、带文件和函数名的都是。几条要紧的：

1. **测量的快照趟不是「每帧拍一次」那么简单。** 它每推一帧生成一次快照，但受一拍预算截断（`src/StageView.tsx` 的 `render`，累计墙钟超过 `1000 / fps × 70%` 就停），`m7-contract.md` 第 97 行记着探针实测每张卡只产出 0～1 帧。任务书写的是「要改稀」，实际落地是取消截断、推完整段、每 15 帧一张，遮罩会变长。
2. **「这一段齐了没有」的判据散在八九处**，都按每一帧都要有来判（契约第 2.3、2.4 节逐处列了）。不一起改，稀疏的一段永远算不齐。
3. **remotion 式的卡现在在层表里一行都没有**（`layerMapOf` 只列有快照档位的层）。
4. **产流接不上租约时一律从挂载帧回放**（`bakeStream`）；不传 `mountFrame`、预热传 0 就能不回放，可以不动 `bake.mjs`。
5. **单卡流的内容键取的是快照的内容键**，里面有生成快照的代码指纹。改一次生成快照的代码，所有单卡流跟着作废。
6. **`bake.mjs` 在生成快照和截图两份代码指纹的名单里**，改一个字，全部快照和全部流的键换一次。
7. **卡片的源码版本**（主会话转来、丁实测，我照算法复核了一遍）：见下面「做过的三个小实验」第三个。
8. **卡片声音的身份**是卡 id、源码版本、参数、输入，不含能力表、不含代码指纹（`cardAudioIdentity`）。
9. **封装卡的源码版本不走闭包**（`cardSourceVersion` 找不到入口文件时取声明里的几项，含 `frameMode`）。所以 5 张 Lottie 封装卡的键只在声明改掉那一次变，`lottie.tsx` 怎么改都不变。
10. **预渲染进程判断「用户在播放」靠缺口上报带过去的 `playing`**（`dataMirror.ts` 的 `sendWanted`；播放头那条路播放中不推）。这一条我只看到这一个来源，有没有别的没有查到底，契约里标了未查清。
11. **`verify-unified-frames.mjs` 验的全是整场景的 HTML 和整帧通道**，没有一条断言落在每张卡自己的快照上。

## 做过的三个小实验

都是只读或者无头浏览器里的静态页面，脚本放在会话的临时目录里，没有入库，没有占用任何端口，没有起开发服务器。Chrome 是仓库里 puppeteer 带的 152.0.7977.75。

**一、流平面能不能用 `backdrop-filter: opacity(0)` 把自己矩形里的下层擦掉再画。** 不能。400×300 的页面，下面两层（不透明红块、50% 蓝块），上面一块带这个样式的画布。取 7 个点的像素，和不带这个样式时逐点相同（例如平面里画布透明、下面是红块的那一点，两种都是 `255,0,0,255`）。包裹层带 `isolation`、带滤镜时同样。命令退出码 0。

**二、Chrome 里毛玻璃是「替换」还是「盖在上面」，以及「差分取层」的还原误差。**

- 把目标块的样式分别写成 `blur(12px)`、`opacity(0)`、`opacity(0.5)`、`invert(1)`、`blur(12px) opacity(0)`，各截一张带目标的、一张不带目标的：`opacity(0)` 两种写法都是 0 个像素变化；`opacity(0.5)` 时空白处的不透明度从 26 变成 38（等于滤过的 13 盖在原来的 26 上）；五种写法里「不透明度比下层低的像素」都是 0。结论：滤过的下层是盖在没滤过的下层上面的。
- 一个带半透明色块、阴影、文字的下层，上面压一张带模糊、半透明底色、边框、阴影的卡。带目标截一张 R、不带截一张 L，照契约第 5.3 节的算法算出 S，量化成 8 位以后盖回 L，和 R 比（预乘色，满分 255，全图 12 万像素）：平均差 0.035，最大 9.9；直接把 R 盖在 L 上：平均差 2.55，最大 63.7。S 里不透明度大于零的像素的包围盒是 `[70,58]～[351,269]`，就是目标卡加它的阴影那一块。
- 第一版算法只按不透明度的方程取值，最大差是 28.9：下层接近不透明时分母很小，量化噪声被放大。加上「颜色不为负、颜色不超过不透明度」两个下界以后降到 9.9。契约里写的是后一版。
- 没有做的：没有接进产流，没有量每帧截两张的耗时，没有过编码。

**三、卡片源码版本的导入闭包。** 照 `cardSourceVersion.mjs` 的正则和解析顺序，在 `main` 上对 `src/cards` 下 62 个文件各走一遍：

- 6 个文件在 50 个卡片文件的闭包里：`kernel/types.ts`、`kernel/frameMode.mjs`、`kernel/cardGraph.mjs`、`kernel/emphasis.ts`、`kernel/cardGpu.ts`、`render/cards/gpuExecutor.ts`。
- 三张内置有声卡（`av-pulse`、`sound-notification`、`sound-keyboard`）的闭包另外只多 `kernel/soundEffects.ts`、`kernel/typingEvents.ts` 和它们自己的两个源文件。
- 引了 `kernel/clock` 的四个卡片文件（五个 id：`lottie`、`focus-card`、`terminal-3d`、`probe-slow`、`probe-slow-stepped`）的闭包里另有 29 个文件，含 `render/stageRpc.ts`、`render/streamPlayer.ts`、`render/placeholderHost.ts`、`render/createSnapshot.ts`、`render/snapshot/` 下四个。原因是 `kernel/clock.ts` 的全局类型声明里有几句 `import('../render/…')`，源码版本的正则把它们当成了导入。
- 在 `claude/rr-a1-play`、`claude/rr-a1-produce`、`claude/lottie-seed` 三个分支的源码上（用 `git archive` 解到临时目录）各跑了一遍：甲一新加的 `streamInputSig.mjs`、`streamMux.ts`、`streamEncode.ts` 不在任何闭包里；`lottie-seed` 上 `kernel/pinEntropy.ts` 只进了 `lottie.tsx` 的闭包。
- 没有做的：没有真的去算键。哪张卡的键变不变以丁的 `card-table-digest-compare.mjs` 为准，我的脚本只回答「哪个文件在谁的闭包里」。

## 哪些是我的判断

契约里标〔裁〕或写「本文的判断」「本文的推荐」的都是。汇总：

1. 「之后要补的」只补齐每 15 帧一张的那一套，不加密（待定表第 1 条）。
2. 画布卡这一类按「登记为画布卡」定，「画面全在画布里」只管像素怎么取、产流时实测（待定表第 12 条）。
3. 暂停和拖动贴流的五条定法：按类别走；超出 6 条的排队轮转解码器；「什么都不画」不超过 120 毫秒的口径和等流首帧再藏活子树；稀疏段算数；组流按组进退。其中轮转解码器和组流按组进退原型都没做过。
4. 位置矩形登记在帧库 `card-rects/` 和层表的 `rects`，只给预渲染集合里不存快照的卡登记；占位符取框的顺序。
5. 依赖下层的流用「差分取层」，平面照组流的机制挂在舞台根下；键按时间重叠的全部下层算。
6. 画布卡取像素缺省走把原始像素交给 ffmpeg 的那条；节点上量什么、怎么判。
7. 快照新存法的全部设计：每帧存相对基准的差异（不是相对上一帧）、结构变了自己当基准、清单 `v: 2` 且 `frames` 留空、新页面两种都认、体积上限按块判。
8. 流的成员键去掉快照代码指纹；各项显式换版本号。
9. 甲、乙两组文件五项一律不改；加一条钉住有声卡源码版本的守门测试。
10. 施工拆分的六条道、块的先后和档位。
11. 测量趟推完整段时给遮罩下每张卡一个墙钟上限（待定表第 3 条的推荐）。

## 没做成的、没查清的

没做成的没有。契约里标「未查清」的有这几处，都要实现的人核对：

- 本机后台趟的快照部分有没有「播放中让路」的闸。
- 播放中预渲染进程除了缺口上报，还有没有别的音讯来源知道用户在播放。
- 现有的画布卡（粒子一族、`scene-3d`、`r6-canvas`）的组件除了画布还渲不渲别的元素（契约里改成产流时实测来判）。
- 项目放本机、几台桌面版本不同时，有没有别的门槛拦住新旧节点同在一个项目里。
- 契约第 10 节列的那些测试和探针是按标识符搜出来的，没有逐个读它们的断言。

没有验的设计：差分取层接进产流以后的耗时和编码后的误差；暂停态轮转解码器；快照新存法的全部（只有 `render-standard.md` 里那次相对上一帧的实验可以参考）。

## 对任务书或语义的更正建议

都写在契约第 15 节，这里只列标题：

1. 任务书说测量的快照趟「每帧拍一次，要改稀」，实际每张卡只产出 0～1 帧。
2. `product/platforms.md`「播放」写没有流的重卡每拍换一张快照，每 15 帧一张以后不成立，是二级改动，任务书的表里没有。
3. `mechanism/rendering.md`「测量」写不按累计时间截断，代码里快照趟按累计时间截断。
4. 任务书「戊二」写流里已经带着下层的画面，差分取层以后流里只有目标卡改动的那一块。
5. 任务书「甲三」缺省关的理由只覆盖暂停，快照稀疏以后播放流不流畅完全靠流。
6. `render-standard.md` 的表写当场算得过来的 remotion 式卡也登记位置矩形，任务书写的是给重卡登记。
7. 画布卡不存快照以后没有预渲染小尺寸，低内存档下比现在差。
8. 快照稀了 15 倍以后，庚的收益只剩原来十五分之一的量级。
9. `render-standard.md` 对现状的几处描述过时。

另外两条给主会话的提醒，不在五项里：

- 乙（remotion 式的框架）如果要动 `src/kernel/types.ts`，全部内置卡换键，已生成的卡片声音会被判过期。
- 丁的报告建议的「类型导入不进源码闭包」能根治这类牵连，但改算法的那一次同样会让全部内置卡换键、卡片声音被判过期，要先问用户。

## 端口

开工时分到 5870～5879，中途主会话改为 7470～7479。两段我都没有用：三个小实验用的是无头浏览器里的静态页面和读文件，没有监听任何端口，没有起开发服务器，没有碰用户常驻的端口，没有结束任何进程。

## 验证

没有改代码，按任务的验收不用跑 `npm test`，也没有跑类型检查。提交前核对过：`git status` 里只有契约和本报告两个文件；两个文件里都搜过，没有 `constraints.md`「用词」和任务通用规矩禁用的那四个旧词。

## 提交

见最终回复里的列表。
