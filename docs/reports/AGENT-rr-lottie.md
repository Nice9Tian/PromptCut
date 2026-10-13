# AGENT 报告:渲染重构「癸一」——Lottie 改成 remotion 式,随机数固定住(分支 `claude/rr-lottie`)

「癸一」指 `docs/plan/render-refactor-task.md`「癸:Lottie 改成 remotion 式」里除「要不要放开浏览器节点产 Lottie 的流」之外的部分(那一半留给「癸二」)。「remotion 式」在代码里就是声明 `frameMode: "direct"`:这一帧的画面只由时间、参数、素材算出来,不用从片段起点推过来。

日期 2026-10-13。机器:PC,Intel i7-14700KF,20 个逻辑核;Chrome 152.0.7977.75(无头);lottie-web 5.13.0。量的时候机器上同时有别的子 Agent 在跑。

## 结论

- 做成了:6 张 Lottie 卡声明改成 remotion 式,随机数三样缺省打开,和声明改写在同一个提交里(`02a6cd58`);登记表、建卡指南、`render-standard.md` 跟着改。
- 验收各条都过,有两处和任务书预料的不一样,都查清了(见「验证结果」第 1 条):`navidad` 有 32 帧变了,是这次顺手修掉的浏览器毛病;通用粒子卡 `particles` 的键也跟着变了,是源码版本找入口文件的老毛病牵连的。
- 补测时另查到三处会让「顺着推」和「直接跳」不同的地方,都在 `lottie.tsx` 里固定住了,标〔裁〕等主会话和用户审。
- 一个现有探针因为这次改动的前提变了而不过:`scripts/probes/stream-produce-probe.mjs`(它拿 Lottie 当「按声明就是重卡」的卡)。不在我的文件清单里,没动,见「要主会话决定或注意的事」。

## 做了什么

提交(都在 `claude/rr-lottie` 上,没推送、没合并):

| 提交 | 内容 |
|---|---|
| `697a5f99` | 建本报告 |
| `8db80e64` | 留底用的探针 `scripts/probes/lottie-baseline-probe.mjs`(在动 Lottie 代码之前提交、之前跑) |
| `0dbffade` | 合并原型 `claude/lottie-seed`(没有冲突) |
| `02a6cd58` | 声明改写、三样缺省打开、登记表、建卡指南、补测探针、补测查到的三处 |
| `b214c95d` | 合并 `main`(带进「不回放」的服务端一半) |
| `94dee11a` | 真管线探针 `scripts/probes/lottie-pipeline-probe.mjs` |
| 本次 | `render-standard.md` 的 Lottie 一节、本报告 |

逐项(对着派活指令的「要做的」):

1. **先留底。** 用 `main` 的代码(`2adfce53`)跑 `lottie-baseline-probe.mjs capture`:真页面 1920×1080 截图,5 个自带素材加通用卡自带的演示动画,各取顺推全长、回跳 8 帧、直接跳 8 帧,共 895 张,在 `out/lottie-baseline/before/`(不入库)。后来为了查清 `navidad`,又把两个 Lottie 文件临时换回 `main` 的版本补了一份「每一帧都新开页面直接跳」的(`out/lottie-baseline/before-jumpall/`),换回来以后核过工作区和提交一致。
2. **合入原型,照「接的时候要做的」六条:**
   - 第 1、6 条:三样(换掉表达式里的随机函数、外面那一层、属性值不留旧数)缺省打开。舞台、导出页、在线页面用同一份代码、同一个缺省,所以「开关到得了导出页和舞台」不再需要传开关。关掉只为探针对照(页面地址 `lottieExpr=0`、`lottieExact=0`,或 `window.__pcLottieExpr = false`)。开关一(给播放库内部那一串播种)照任务书留着做对照,缺省关。
   - 第 2 条:补测探针 `scripts/probes/lottie-seed-extra-probe.mjs`,八样都测了,见「验证结果」第 3 条。
   - 第 3 条:`LottieView` 和部件 `src/parts/lib/media-lottie.tsx`(它用的就是 `LottieView`,没改)都走 `loadLottie` 给的 `goTo`。`lottie-seed-probe.mjs` 加了一条:扫 `src/`,除卡片自己外不许别处引播放库或直接调它的跳帧。现在放行两个文件:`src/online/cardRuntime/hostModules.ts`(把播放库交给在线页面里用户自己写的卡)、`soundStub.ts`(只在注释里)。
   - 第 4 条:带坏表达式的素材画面仍可能随到达方式变,没处理,写进了 `lottie.tsx` 的文件头。
   - 第 5 条:「升级播放库之前重跑两个探针」写在 `lottie.tsx` 文件头、两个探针的文件头和 `render-standard.md`;`lottie-seed-probe.mjs` 里记着核对过的版本号(`LOTTIE_WEB_VERIFIED = '5.13.0'`),版本不一样直接判失败。
3. **两处声明改成 remotion 式**(`src/cards/native/lottie.tsx`、`src/cards/assets/index.ts`),两处注释改对。和三样缺省打开在同一个提交里。
4. **登记表** `src/cards/capabilities.json` 6 条的 `writing` 改成 `remotion`,`capabilities.md` 的汇总(5 张变 11 张)和两处逐张说明跟着改。
5. **建卡指南** `server/card-authoring-guide.md` 改了 7 句:放 Lottie 用现成的 `lottie` 卡和素材封装卡(内置的 remotion 式卡);用户卡自己直接引 `lottie-web` 的照旧只能声明 `"stateful"`,并写明它拿不到随机数那层固定。**remotion 式可引用的模块名单没有放开 `lottie-web`**,指南说得通。
6. `server/render-node/split.mjs` 没动。

## 验证结果

### 1. 改前改后逐帧比(留底)

命令:`node scripts/probes/lottie-baseline-probe.mjs capture --out out/lottie-baseline/after --port 27600 --jump-all`(退出码 0,页面报错 0 条),再 `compare --a out/lottie-baseline/before-jumpall --b out/lottie-baseline/after`(退出码 0)。同一份代码连跑两遍留底互相比,除 `navidad` 第 48 帧偶尔差 1 个像素外全部相同,这是这把尺子的底噪。

顺推全长,改后对改前:

| 素材 | 全长 | 不同的帧 | 原因 | 在任务书预料之内吗 |
|---|---:|---|---|---|
| `adrock` | 392 | 0 | | 是 |
| `gatin` | 80 | 像素 0 帧;第 59～66 帧 SVG 文本不同、像素相同 | 属性值不留旧数 | 任务书写「一帧不变」,指的是像素;文本这 8 帧它没列。帧号按素材帧率换算出来不是整数(25 帧每秒),所以和原型量的不完全一样 |
| `bodymovin` | 103 | 像素 0 帧;第 31、60 帧文本不同、像素相同 | 同上 | 任务书预料 1 帧(第 60 帧),多了第 31 帧,同样像素相同 |
| `happy2016` | 99 | 第 23～98 帧共 76 帧:67 帧像素不同(最多 3 个像素,最大差 30),9 帧只是文本不同 | 同上 | 是,正是预料的 76 帧。任务书的「最多 74 个像素」是把 SVG 另转成图片量的,真页面截图是 3 个 |
| `navidad` | 125 | 第 51～82 帧共 32 帧像素不同,最多 172421 个像素;第 82 帧只差 1 个像素(底噪) | **浏览器不重画嵌套的蒙版**,见下 | **不在预料之内**,查清了 |
| 演示动画 | 60 | 0 | | 是 |

回跳、直接跳各 8 帧:6 份素材像素全部相同(`bodymovin` 回跳第 31 帧文本不同、像素相同)。

**`navidad` 那 31 帧。** 留底时就看到改之前顺推和直接跳在第 62 帧差 110401 个像素,而两边看得见的 SVG 文本逐字节相同。看了图:顺推的那张小怪物脸上没有底色,直接跳的那张有。在顺推到第 62 帧的页面上分别试了几种办法:等 500 毫秒没用;把挂着 `mask` 的元素的属性摘掉再挂回去,画面变成和直接跳的逐像素相同;只动里面套了 `<g>` 的 5 张 `<mask>` 也行,只动另外 43 张不行。所以是 Chrome(152)在 `<mask>` 里面那一层变了以后不重画用它的图层,和播放库、和这次改动都无关,`main` 上预览和导出都中招。做法见下面〔裁〕第 3 条。改后的顺推和改前「每一帧新开页面直接跳」逐帧比:`navidad` 125 帧只有 1 帧差 1 个像素,`bodymovin`、`gatin`、`happy2016` 全部相同。也就是说这次没有造出新画面,只是让顺推也得到原来直接跳的那个画面。

**还剩的一点差别**(改前改后一样,帧号也一样,不是这次带来的):真页面像素上顺推和直接跳,`adrock` 4 帧(第 39、59、323、326 帧,最多 16 个像素、最大差 6)、演示动画 4 帧(第 48、49、54、57 帧,最多 98 个像素、最大差 9)、`navidad` 2 帧各 1 个像素。SVG 文本逐字节相同,差在浏览器只重画变了的一块和整张重画时边缘的取整,卡片管不到。导出管线里没有量到这种差别(见第 4 条:372 帧三种导法逐像素相同)。

看过的图:`before/happy2016/seq-0098.png`(彩色的「2016」完整)、`before/navidad/seq-0062.png`(脸上没有底色)、`before/navidad/jump-0062.png`(有底色)、`after/navidad/seq-0062.png`(有底色)。

### 2. 原型探针

`node scripts/probes/lottie-seed-probe.mjs --port 27601 --out out/lottie-seed-probe`:退出码 0,`{"ok":true,"fails":[]}`,用时 371.9 秒。五份测试素材(带随机表达式的三份、表达式用例、随机顺序文字)在六种情形下(顺推、回跳、同页新建、新页新建、别的卡在前、别的 Lottie 在前)的结果:

| 素材 | 关 | 替换+不留旧数(正式的一组) |
|---|---|---|
| fixture | 0/20 | 20/20 |
| fixtureasync | 0/20 | 20/20 |
| fixtureip | 0/13 | 13/13 |
| exprcases | 0/11 | 11/11 |
| textrandom | 2/11 | 11/11 |
| 自带 5 个 | `happy2016` 3/8,其余 8/8 | 全部 8/8 |

真卡片(React 挂 `LottieView`)新加「缺省」一组(地址上什么都不带):fixture、fixtureasync、fixtureip、textrandom、happy2016 的直接挂、从第 0 帧推过来、别的卡在前,都和 `loadLottie` 直接跳的相同。关着(地址带 `lottieExpr=0&lottieExact=0`)和提交 `7e7ae968` 的卡片比:115 帧原文逐字节相同。交替画帧 29/29×3。「跳帧入口」那一条:0 个文件。

第一次跑没过一条:我新加的「跳帧入口」把 `hostModules.ts`、`soundStub.ts` 也算进去了,看过以后放行(见上)。

### 3. 补测(原型没测到的)

`node scripts/probes/lottie-seed-extra-probe.mjs --port 27602`:退出码 0,`{"ok":true,"fails":[]}`,用时 133.5 秒。「开着」是缺省;「关着」是对照,说明用例确实踩到了。

| 用例 | 开着:六份画面相同的 N | 关着 | 另核 |
|---|---|---|---|
| `posterizeTime()` 之后再调随机函数 | 12/12 | 0/12 | 第 0～15 帧取到几个不同的数,开和关一样:random 16 对 16,seedRandom 1 对 1,wiggle 11 对 11(观感没变) |
| 表达式求值到一半读另一个带随机表达式的属性 | 9/9 | 0/9 | 读的那一层先求值、后求值各一份 |
| 表达式绕过去用 `globalThis.Math.random`、`globalThis.crypto` | 7/7 | 0/7 | 数确实随帧变(16 帧 16 个);两个新页面读到的相同 |
| 表达式改文字内容再配随机顺序 | 12/12 | 0/12 | 第 0、16、40 帧画面三种,文字确实换了 |
| 合成嵌套三层、各放几份 | 7/7 | 0/7 | 最里面那一层 15 份,开着时 15 份互不相同(各动各的);改写 30 处 |
| 带网络字体、装载是异步的 | 8/8 | 0/8 | 建实例那一下确实还没装载完。字体是把本机 `arial.ttf` 当网络字体发出去的 |
| 生产构建(vite build,缺省压缩) | 7 份素材共 32 个 N 全部相同 | — | 和开发构建直接跳的画面 32/32 相同;缺省开关读到 关/开/开;几处靠播放库内部名字的钩子都包上了,页面没有 `[lottie]` 警告 |
| 大素材复制合成(只记录) | — | — | 150 层的合成放 30 份:素材 92 KB,改写后 3493 KB,改写 4500 处 44.8 毫秒;建一份 438 对 629 毫秒;堆 164 对 179 MB |

第一次跑没过两条,都是真的,见下面〔裁〕第 1、2 条:绕过去用全局随机数的第 0 帧(回跳、同页新建、别的 Lottie 在前和顺推不同);表达式改文字内容的 6 个 N。改完以后全过。

### 4. 真的管线:播放、暂停、拖动;预览和导出一致;不产快照、走单卡流

`node scripts/probes/lottie-pipeline-probe.mjs --port 27610`,三项分三次跑(`--only export`、`stage`、`streams`),退出码都是 0,`fails` 都是空的。它自己起一台隔离的编辑器(带 `PROMPTCUT_NO_PORT_FILE=1`,经 `no-user-dirs.mjs`),项目是四张 Lottie 片段:`lottie-navidad`、`lottie-happy2016`、通用卡放带随机表达式的测试素材、通用卡放带随机顺序文字的测试素材。

- **导出**(`exportUnified`,真的导出页):单路顺着导 18 秒、分 4 路导 12 秒、只导抽的 20 帧 2.8 秒。分片是 `0-92 93-185 186-278 279-371`,三刀都切在 Lottie 片段中间(声明成 remotion 式以后才允许这样切),后三路是直接跳进去的。单路对 4 路 372 帧不同 0 帧;单路对抽帧 20 帧不同 0 帧。看过 `export-4/frames/000289.png`(第 4 路里的一帧,带随机表达式的那几个方块和圆都在)。
- **可见舞台(桌面的编辑台,双舞台)**:暂停着在时间轴上点 78 次(往前 23 次、往回和跨片段 14 次、一帧一帧往前挪 31 次、往回挪 10 次),每次等它回到精确活渲,读这张卡看得见的 SVG 文本,78 次都和导出页同一帧的相同,同一帧先后到的也相同。播放 4 段各 1.5 秒:途中抽到的样本都落在整帧上,21/21、21/21、20/20、18/18 和导出页相同;暂停后停下的那一帧(第 91、206、302、361 帧)也相同。这就是「预览和导出一致」的实测;比的是 DOM(舞台预览是缩放过的,没法和导出的 PNG 逐像素比)。
- **预渲染**:卡片计划里 4 张都是 `frameMode: direct`、`snapshotTier` 是 `none`(改之前是 `stateful`、`shared`);不钉的话它们按声明是轻卡,根本不进预渲染。钉成重卡(`pipeline.streamPicked = () => true`,做法同 `stream-noreplay-probe.mjs`)以后 51.6 秒产完 4 条单卡流;就绪索引里这 4 张只有 `stream` 层;库里 `controls-html`、`controls-local` 都是空的。
- **「预渲染不再从挂载帧重推」**(合了 `main` 的 `f007ed86` 以后自己补的):4 条流 `replay` 都是 `false`,产完 `replayedFrames` 都是 0;把每条流中间三段作废重产(每段都重灌页面)以后仍是 0。另把 13 个分段各用两条路产一遍——不回放直接产、从挂载帧回放着产——逐帧 PNG 逐像素相同,13 段有差别的 0 段。看过 `stream-navidad-seg4-direct.png` 等 4 张。
- **在线页面**:没有单独验。在线页面和桌面用的是同一份卡片代码、同一个缺省(生产构建那一项验了打包压缩以后的代码);在线页面的播放、暂停要起整套托管组合,这次没有做,记在「没做成的」。

### 5. 基线

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0,零输出(改完 `lottie.tsx` 以后跑的最后一次) |
| 全量测试 | `npm test`(设了两个环境变量) | 见下 |
| 导出确定性 | `node scripts/verify-determinism.mjs --url "http://127.0.0.1:27614/?export=1"` | 退出码 0;1800 帧,Identical 1800,Different 0 |
| 导出与快照重放一致 | `PC_FRAME_TEST_URL=http://127.0.0.1:27614 node scripts/verify-unified-frames.mjs` | 退出码 0,`PASS: …` 整条。头两次是我的环境没配对(脚本把测试视频写到 `out/media`,我起的服务器的素材目录在临时目录,404),把 `PC_FRAME_MEDIA_DIR` 指到服务器的素材目录以后过;不是代码的问题 |

全量测试:第一遍 5695 条,通过 5684,失败 5,跳过 4。失败的 5 条在 4 个文件里:`agent-live-selection`、`asset-project-workers`、`c66-integ`、`operation-wiring-crash`(3 个子用例算 1 条加 2 条),都和 Lottie、渲染无关,其中 `agent-live-selection` 在通用规矩列的「机器忙时偶发」名单里,另外三个不在名单里(当时别的子 Agent 也在跑)。单独重跑这 4 个文件:`npm test -- <4 个文件>`,42 条通过 42,失败 0,退出码 0。

收尾的一遍(最后一个代码提交之后,`tsc` 同样退出码 0):5695 条,通过 5686,失败 4,跳过 4。失败的在 3 个文件里:`agent-live-selection`、`asset-project-workers`、`operation-wiring-crash`(日志里有 `listen EADDRINUSE 127.0.0.1:5761`,端口被别的进程占着)。单独重跑这 3 个文件:36 条通过 36,失败 0,退出码 0。**所以全量测试两遍都没有做到一次零失败**,失败的每一条单独重跑都过,都不是 Lottie 或渲染的测试;没有改松或跳过任何测试。请主会话在机器空下来的时候自己重跑一遍为准。

守门测试 `src/cards/capabilities.test.mjs`、`server/test/card-authoring-guide.test.mjs`、`src/render/audioCardSourceVersion.test.mjs`、`src/kernel/pinEntropy.test.mjs`、`server/test/port-file.test.mjs`、`server/test/windows-hide-silent-spawn.test.mjs` 都在全量里,没有失败。

### 6. 键的核对

- `node scripts/probes/card-source-version-compare.mjs --base main`:源码版本变了的入口文件 5 个——`src/cards/native/lottie.tsx`、`src/cards/native/index.ts`、`src/cards/index.ts`、`src/cards/assets/index.ts`、`src/parts/lib/media-lottie.tsx`,都是闭包里有 `lottie.tsx` 的。服务端代码身份变了的两个 id:`lottie`、`animation`(后一个是 Lottie 卡里那个部件的 id,被按 id 找文件的算法当成了卡)。
- `node scripts/probes/card-table-digest-compare.mjs --base main --expect lottie,lottie-adrock,lottie-bodymovin,lottie-gatin,lottie-happy2016,lottie-navidad,particles`:退出码 0,「只有 --expect 里的 7 张变了,其余 94 张的能力表、源码版本、三个键逐张相同」;生成快照的代码指纹没变。
- **多出来的一张 `particles`**(只写 6 张 Lottie 时这个脚本报「不在 --expect 里却变了的卡 1 张: particles」):通用粒子卡的能力表、注册的定义都没变,变的是源码版本。原因是 `cardSourceVersion` 按 `id: "particles"` 这个写法去源码表里找入口文件,先找到的是 `src/cards/assets/index.ts`(粒子封装卡的部件 id 也叫 `particles`),不是 `native/particles.tsx`。所以通用粒子卡的源码版本一直是 `assets/index.ts` 连同它的闭包(里面有 `lottie.tsx`)。这次必须改 `assets/index.ts` 里 Lottie 的声明,躲不开。粒子卡没有声音;53 张粒子封装卡不变;三张有声卡不变。
- **`pinEntropy.ts` 进了谁的闭包**:只经 `lottie.tsx` 进。有它的:卡 `lottie`、部件 `media-lottie`,以及上面说的 `particles`(经 `assets/index.ts`)。5 张 Lottie 封装卡和 53 张粒子封装卡的源码版本不走闭包。`kernel/clock.ts` 等几个文件只在注释里提到它,丙组五个 id 这次没变(`lottie` 除外)。

### 7. 窗口和进程

每次跑探针前后查过可见窗口(`Get-Process | Where-Object { $_.MainWindowHandle -ne 0 … }`),一直是空的。自己起过一台开发服务器(27614,给两个基线脚本用,带了 `PROMPTCUT_NO_PORT_FILE=1`),用完按进程号停了;探针自己起的编辑器(27610～27612)和 vite(27600～27603)各自收掉。交活前 27600～27619 没有监听。**没有起过不带 `PROMPTCUT_NO_PORT_FILE=1` 的编辑器**:三个探针自己起的 vite 是 `configFile: false` 的(不读项目配置,不是编辑器,不写 port.json)。

## 我做的裁定〔裁〕

三条都是补测、留底时查到的「顺着推和直接跳不同」,都改在 `src/cards/native/lottie.tsx` 的 `loadLottie` 里,只对开着正式那一组的实例生效。按三级办(机制),但都会让个别素材的画面和现在不同,请主会话和用户审:

1. **装载完成后按帧号原地重画一遍。** 原型只在开关一下这样做。播放库装载完成时自己画的那一帧是在「建图层」那一段里画的,全页的随机数用的是另一串,而且前面被取走几个还跟页面里之前有没有别的 Lottie 有关。受影响的只有表达式绕过去直接用全局 `Math.random`、`crypto` 的素材。代价:每份实例装载时多画一次。
2. **文字内容的表达式不留旧内容。** 播放库的毛病,和随机数无关:表达式把文字换掉又换回关键帧上的原文时,画出来的仍是上一段文字(`getExpressionValue` 原样留用手里那份排版)。在已经包着的那个文字原型上多包了这一处。受影响的只有文字内容带表达式的素材(自带的没有)。
3. **逐帧提醒浏览器重画嵌套的蒙版。** 见「验证结果」第 1 条。每跳一帧把里面套了东西的 `<mask>` 的第一个子节点摘下来原位放回,DOM 文本一个字不变。**这一条会让自带的 `lottie-navidad` 的预览和导出在 31 帧上和现在不同**(变成对的)。关掉只为探针对照:`lottieRepaint=0`。没有选「每帧逼整棵 SVG 重排」:那样边缘像素会和不逼时差一点(`gatin` 80 帧全变)。

另两处小的:`LottieMode` 多了 `repaint` 字段;三个开关的地址参数现在认 `=0`(原来只认 `=1`)。

## 没做成的及原因

- **在线页面的播放、暂停、拖动没有单独验。** 原因和等价的证据见「验证结果」第 4 条末尾。
- **`scripts/probes/stream-produce-probe.mjs` 现在不过**:`node scripts/probes/stream-produce-probe.mjs --origin http://127.0.0.1:27614`,退出码 1,`"流数应当是 3 :: 2"`。它的项目(`stream-probe-project.mjs`)拿通用 Lottie 卡当「审阅表里 independent 的有状态卡,没有成本记录时按声明进预渲染集合」的三张之一;声明改成 remotion 式以后它按声明是轻卡,不进集合,少一条流。`stream-play-probe.mjs`、`scripts/acceptance/four-stage-manifest.mjs` 用同一个项目,没跑,估计同样受影响。这几个文件不在我的清单里,没动。
- **带坏表达式的素材**(表达式第一次求值就抛错)画面仍可能随到达方式变:任务书说已知不处理,照办。
- **画布画法**没管(卡片只用 SVG)。
- 耗时是在机器忙的时候量的,数字偏大,只能看量级。

## 要主会话决定或注意的事

1. **`particles` 的键跟着变了**(第 6 条)。契约第 9.2 节写癸只换 6 张 Lottie 卡的键,实际是 7 张。
2. **`stream-produce-probe.mjs` 等要改项目**:把那张 Lottie 换成别的 independent 的有状态卡,或者像 `stream-noreplay-probe.mjs` 那样钉成重卡。
3. **三条〔裁〕**,尤其第 3 条(改了自带素材 `navidad` 的画面)。
4. **`docs/reports/AGENT-lottie-seed.md`** 随原型分支合进来了,归档时一并处理。
5. 浏览器节点要不要放开产 Lottie 的流(「癸二」)可以参考:现在它不产快照,原来「快照超过体积上限」的理由没有了;5 个自带素材在这台 PC 上当场算一帧不到 5 毫秒,多数情况下根本不判重。
6. 原型分支带进来 `src/kernel/pinEntropy.test.mjs` 的改动(`withSeededRandom` 的 4 个单测)。派活指令的文件范围只写了 `pinEntropy.ts`,测试文件是随它来的,说明一下。

## 对任务书或语义的更正建议

没有改 `docs/semantics/` 下的任何文件。

- `docs/plan/render-refactor-task.md`「癸」的验收:「改之后逐帧相同」要加上 `navidad` 的 31 帧(浏览器不重画嵌套的蒙版),并注明任务书里各素材变了几帧是把 SVG 另转成图片量的,真页面截图的像素数不一样(`happy2016` 是 3 个不是 74 个)。
- 同一节「现状」里「改了以后它不再产快照」可以补一句:按声明它成了轻卡,没有成本记录时根本不进预渲染集合,要量出来判重才产流。
- `docs/plan/prerender-products-contract.md` 第 8、9.2 节:癸换键的卡是 7 张(多 `particles`);「`pinEntropy.ts` 只进 `lottie` 这一张的闭包」改成「经 `lottie.tsx` 进 `lottie`、部件 `media-lottie`,以及按 id 找入口时落到 `assets/index.ts` 的 `particles`」。
- `src/render/cardSourceVersion.mjs` 按 `id: "…"` 找入口文件会认错(`particles` 落到 `assets/index.ts`,部件 id `animation` 被当成卡)。改它会让键变,建议记进「下一次本来就要让缓存作废时顺手收掉」的清单(`capabilities.md` 第 3 节那一类)。
- `docs/semantics/mechanism/cards.md` 拿「按帧号定位的 Lottie」当 remotion 式的例子:现在成立了,可以补一句「播放库里的随机数、属性值留旧数由卡片固定住」。主会话合入时看要不要加。
- `docs/semantics/mechanism/rendering.md` 如果有地方写 Lottie 的快照体积或把它列为有状态卡,合入时一并核对(我没有逐句查)。

## 改了哪些文件

`src/cards/native/lottie.tsx`、`src/cards/assets/index.ts`、`src/kernel/pinEntropy.ts` 与 `src/kernel/pinEntropy.test.mjs`(原型带来的,我没再改)、`src/cards/capabilities.json`、`src/cards/capabilities.md`、`server/card-authoring-guide.md`、`docs/plan/render-standard.md`(Lottie 一节)、`scripts/probes/lottie-seed-probe.mjs`、新增 `scripts/probes/lottie-baseline-probe.mjs`、`lottie-seed-extra-probe.mjs`、`lottie-pipeline-probe.mjs`、原型的三份测试素材 `scripts/probes/fixtures/lottie-seed/`、原型的报告 `docs/reports/AGENT-lottie-seed.md`、本报告。十个不许改的文件没有碰。

## 合入前的准备(2026-10-13)

背景:用户 2026-10-13 已对「癸一让 `lottie-navidad` 有 31 帧画面和原来不同」点头(`docs/plan/user-decisions-2026-10-13.md` 第 1 节第 17 条),这一节是合入前的准备:合并最新的 `main`、改对前提不成立的探针、重跑验收和基线、重新确认变了的帧。机器:同上,PC;量的时候别的子 Agent 在跑。端口只用了 27940～27960。

### 提交

| 提交 | 内容 |
|---|---|
| `d67249ff` | `git merge main`(合入时 main 在 `b09b4733`,几十块) |
| 合并第二次 | main 在做的过程中多了一条只改 `docs/plan/` 的提交(`8163c6cb`),又合了一次 |
| `探针:stream-produce-probe 的探针项目…` | 探针项目换卡,见下 |
| `探针:lottie-baseline-probe 放宽端口范围…` | 见下;外加改前改后对比图 |
| 本次 | 本节 |

### 合并冲突

**没有冲突**,两次合并都是自动完成。没有两边逻辑要取舍的地方。

### 前提不成立的探针和测试

- **`scripts/probes/stream-probe-project.mjs`(`stream-produce-probe.mjs`、`stream-play-probe.mjs`、`scripts/acceptance/four-stage-manifest.mjs` 里的 GR-7/GR-8 共用的探针项目)**:原来三张重卡之一是通用 `lottie` 卡(0.5～2 秒,框 800×450)。Lottie 声明成 remotion 式以后按声明是轻卡,没有成本记录时不进预渲染集合,流数少一条。**换成 `entity-chips`(实体名牌)**:审阅表里是 `motion` / `independent`,声明仍是 `stateful`,没有成本记录时按声明进集合;时间、框、轨道位置照旧(0.5～2 秒,框 800×450,入点不在分段边界上),探针要验的东西不变:三条流、入点不在分段边界、和粒子背景叠着时的隔离(检查的是药丸的蓝不出现在粒子流里,与这张卡无关)。选它而不是 `focus-card`:`focus-card` 是丙组五个 id 之一,键本来就可能被别的块改,用 `entity-chips` 不受牵连。只改了项目文件和它文件头的注释,另外两支探针和清单一个字没动。
- **`scripts/probes/snapshot-hash-probe.mjs`**(清单里标「历史」,不在整套里):默认的 10 张卡里有 `lottie-adrock`,注释写「审阅表里 independent、stateful 的卡」,现在不成立。换成同样是 MagicUI 的 `mu-blur-fade`(`motion` / `independent`),注释里去掉「SVG(lottie)」。**这一项没有重跑**:要起两套编辑器和预渲染进程、约 20 分钟,它测的是即将作废的每张卡的 HTML 快照,换卡只保证默认列表里没有现在不产快照的卡。
- `scripts/probes/lottie-baseline-probe.mjs`:`--port` 原来只认 27600～27619,放宽到「20000 以上」(同别的 Lottie 探针)。别的用到 `lottie` 卡 id 的探针(`m7-bake-*` 用的是「异步装载的 DOM 卡」这个性质,`seek-back-exact-probe` 比的是回跳到达方式,`swap-cost-probe`、`snapshot-*`、`queue-single-pass-probe` 只是列卡)不依赖「Lottie 是有状态卡」,没动。
- 测试:`npm test` 里没有哪个测试因此红(见下)。`server/test/page-stream-plan.test.mjs`、`browser-stream-split.test.mjs`、`wrapped-cardid-split.test.mjs` 里的 `lottie` 是它们自己注入的假审阅表,不受声明影响。

### 验证结果

| 项 | 命令(`--origin` / 端口都是自己的) | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force`(第一次合并后) | 退出码 0,零输出 |
| 流生产 | `node scripts/probes/stream-produce-probe.mjs --origin http://127.0.0.1:27940` | 退出码 0,`PASS`,`fails: []`,三条流,满密度 70.3 秒 |
| 流生产,组流 | 同上加 `--group` | 退出码 0,`PASS` |
| 流播放 | `node scripts/probes/stream-play-probe.mjs --origin …` | 第一遍退出码 1,唯一一条失败是「冷 seek 到解出目标帧 ≤ 60 ms」:91 ms(机器忙时的耗时,耗时不当闸门);原样重跑一遍:退出码 0,`PASS`,`fails: []` |
| 导出确定性 | `node scripts/verify-determinism.mjs --url "http://127.0.0.1:27940/?export=1"` | 退出码 0,1800 帧,Identical 1800,Different 0 |
| 导出与快照重放 | `PC_FRAME_TEST_URL=http://127.0.0.1:27940 node scripts/verify-unified-frames.mjs` | 退出码 0,`PASS` |
| 种子原型探针 | `node scripts/probes/lottie-seed-probe.mjs --port 27950 --out out/lottie-seed-probe` | 退出码 0,`{"ok":true,"fails":[]}` |
| 补测探针 | `node scripts/probes/lottie-seed-extra-probe.mjs --port 27951` | 退出码 0,`{"ok":true,"fails":[]}` |
| 真管线探针 | `lottie-pipeline-probe.mjs --port 27960 --only export / stage / streams` 各一次 | 三次退出码都是 0,都是 `{"ok":true,"fails":[]}`(导出:372 帧缺 0,单路对 4 路不同 0 帧,单路对抽帧不同 0 帧;舞台:78 次暂停点击全部和导出页相同;预渲染:4 条流 `replay=false`、`replayedFrames=0`) |
| 源码版本比对 | `node scripts/probes/card-source-version-compare.mjs --base main` | 入口文件变了 5 个:`src/cards/assets/index.ts`、`src/cards/index.ts`、`src/cards/native/index.ts`、`src/cards/native/lottie.tsx`、`src/parts/lib/media-lottie.tsx`;服务端代码身份变了 2 个 id:`lottie`、`animation`;`added`、`removed` 都是空。和合并前一样,main 带来的几十块没有让这条口径多出别的 |
| 能力表比对 | `node scripts/probes/card-table-digest-compare.mjs --base main --expect ,` | `--expect ,` 时退出码非 0(列出 7 张):`lottie`、`lottie-adrock`、`lottie-bodymovin`、`lottie-gatin`、`lottie-happy2016`、`lottie-navidad`、`particles`。能力表变的是 6 张 Lottie 卡(`stateful`→`direct`,`need_prerendering` true→false,`compositing`、`canvasHeavy`、`independentCache` 不变);`particles` 能力表和注册表定义都没变,只有源码版本(及键)变,原因同上一节「键的核对」。用 `--expect lottie,lottie-adrock,lottie-bodymovin,lottie-gatin,lottie-happy2016,lottie-navidad,particles` 重跑:退出码 0,「其余 94 张的能力表、源码版本、三个键逐张相同」 |
| 全量测试 | `npm test`(设了两个环境变量) | 6483 条,通过 6463,失败 2,跳过 12,todo 6。失败 2 条是同一个测试(`server/test/user-editing.test.mjs` 的 UE-S7 及其外层 UE-S7～S10,等了 20 秒超时,机器忙);单独 `npm test -- server/test/user-editing.test.mjs`:11 条通过 11,失败 0,退出码 0。另有一条 `accept-018-files-proc-damage` 的 ACC018-DMG-5 标「⚠ 产品问题」,是 todo 条目,不算失败 |

演示项目(导出确定性、统一帧用的)里有没有用到这几张 Lottie 卡:我在 `src/`、`server/`、`scripts/` 里没有找到演示项目数据引用任何 `lottie*` 的卡 id;确定性那一遍 1800 帧零差异也佐证。导出像素基线由主会话合入前跑,这里不报。

### 变了的帧重新确认(`lottie-baseline-probe.mjs`,真页面 1920×1080 截图)

做法:改前用 `main` 的完整检出(`git archive main` 解出的临时目录,探针文件拷过去)、改后用本分支,各对 `navidad` 和 `happy2016` 跑 `capture`(顺推全长、回跳 8 帧、直接跳 8 帧),再 `compare`。

- **`navidad`(125 帧)**:顺推逐帧比,像素不同的帧是第 51～81 帧(31 帧,最大差 255,最多 172421 个像素)加第 48 帧(只差 **1 个像素**,是这把尺子的底噪,上一轮就写过);回跳 8 张、直接跳 8 张改前改后逐像素相同。原因没变:`main` 上顺着推到这些帧时,Chrome 不重画嵌套的蒙版,小怪物脸上的底色不出来;改后每跳一帧提醒浏览器重画。**再核了一遍原因**:在 `main` 上对 125 帧每一帧都新开页面直接跳(`--jump-all`,存成 `jumpall-NNNN.png`),拿它和改后的顺推逐帧逐像素比:**125 帧 0 帧不同**;同一份 `main` 的直接跳和它自己的顺推比:第 48(1 个像素)、51～81 帧不同。就是说改后的顺推画面 = 改前「直接跳到这一帧」的画面,没有造出新画面。
- **`happy2016`(99 帧)**:顺推第 23～98 帧共 76 帧和改前不同:其中 67 帧像素不同(第 29、33～98 帧,最多 **3 个像素**,最大差 30),另 9 帧(第 23～28、30～32 帧)只是 SVG 文本不同、像素相同(属性值不留旧数);回跳、直接跳各 8 张相同。和上次一样。
- 对比图(左改前 `main`,右改后本分支,各缩成 960 宽并排):`docs/reports/assets/rr-lottie/navidad-f55-before-after.png`、`navidad-f62-before-after.png`、`navidad-f75-before-after.png`。我都看过:改前小怪物的脸是黑的(第 62 帧只露出嘴和一根签子,第 75 帧整张脸缺失只看到零散的五官),改后脸上有奶油色的底色,和「直接跳」的画面一致,第 55 帧改后多出了一块奶油色的身子。

### 进程和窗口

自己起过一台 vite(27940)、三个探针自己起的 vite 和无头 Chrome、基线探针自己起的 vite(27952、27953)。都已收掉;27940～27965 现在没有监听;每次跑前后查过可见窗口,没有。没有起过不带 `PROMPTCUT_NO_PORT_FILE=1` 的编辑器(27940 的 vite 带了)。临时目录 `.worktrees/_rr-main-tmp`(`git archive main` 的解出物,不入库,仅为了渲「改前」)已删除。

### 要主会话注意的

1. 全量测试这一遍有 1 个文件(`user-editing`)忙时超时,单独重跑过;没有一次零失败的全量,请机器空下来时自己重跑为准。
2. `snapshot-hash-probe.mjs` 改了默认卡但没重跑(见上)。
3. 合并后没有再改过 `src/`、`server/`;探针项目换卡是 `scripts/` 下的改动,不进「代码版本」口径。
