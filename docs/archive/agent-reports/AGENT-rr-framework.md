# AGENT 报告：渲染重构「乙」remotion 式的框架

- 分支：`claude/rr-framework`（基于 `main` 的 `a556b7bc`）
- 工作区：`.worktrees/rr-framework`
- 任务书：`docs/plan/render-refactor-task.md` 的「乙」一节
- 端口段：开工时分的是 5840～5849，主会话中途改成 7440～7449。**58xx 上没有起过任何进程**；探针只用过 7440、7441、7442，用完已按进程号收掉。

代号说明：「乙」是渲染重构任务书里的一项，做 remotion 式的框架；「丙」是它后面那一项，改建卡指南；〔裁〕是我在任务书留给执行方定的地方做的决定，等主会话和用户审。「remotion 式的卡」= 声明 `frameMode: "direct"` 的卡，「motion 式的卡」= 声明 `frameMode: "stateful"` 的卡。

## 状态

三部分都做完，验收逐条有证据。基线两条见「验证结果」。有 9 条〔裁〕和 3 条对任务书的更正建议要主会话看。

## 做了什么

### 一、工具（`src/kernel/remotionStyle/`，新目录）

| 文件 | 内容 |
|---|---|
| `index.ts` | 对外的入口。卡片写 `import { … } from "../../kernel/remotionStyle"` |
| `interpolate.ts` | `interpolate`、`interpolateColors`、`tween`、`clamp`、`lerp`、`loop`、`pingPong` |
| `easing.ts` | `Easing`（一张冻住的表） |
| `spring.ts` | `spring`、`springDuration`：阻尼振子的解析解，给 t 直接算位置，不从头推 |
| `stagger.ts` | `stagger`、`staggerDuration` |
| `random.ts` | `random`、`randomRange`、`randomInt`、`randomPick`、`noise`：按「种子 + 序号」直接算，只用 32 位整数运算 |
| `lock.ts` | `lockTopLevel`：载入时把顶层锁成只读（三道只读的第二道）。不从 `index.ts` 导出，卡片不直接引 |

放在 kernel 层：全是纯计算，不引 React、不引别的模块；在线页面的舞台与声音线程本来就把 `src/kernel/**` 整个带上，卡片不用改解析规则就引得到。

### 二、建卡、改卡时的检查（`server/remotion-style-check.mjs`，新文件）

用 TypeScript 的语法树逐条查，每条带行号。接在 `server/vite-plugin-cards.ts` 的两个函数上：

- `checkCardSource`（`mode: 'author'`）：桌面的 `create_card` / 用户卡 `edit_card`，以及云端 Agent 的 `create_card` / `edit_card`，四处调的是同一个函数。
- `checkSourceEdit`：内置卡与共用文件的 `edit_card`（桌面、云端同一个函数）。

`mode: 'install'`（打开项目、内容库同步装卡）不调它。

### 三、三道只读

1. **顶层只许写常量**：上面那套检查里的 `top-level` 一条。
2. **载入时锁只读**：`src/online/cardRuntime/remotionLock.mjs`（新文件）给该锁的卡的源码末尾接一句 `lockTopLevel(...)`；两处载入用户卡的地方用同一份——`server/vite-plugin-cards.ts` 的 `cardOverridesLoader` 新增的 `transform` 钩子（桌面、渲染节点、预渲染进程），`src/online/cardRuntime/transpile.ts`（在线页面）。
3. **框架不提供能跨帧存东西的工具**：守门测试 `remotionStyle.test.mjs` 的 RS-T-05。

### 测试与探针

| 文件 | 验什么 |
|---|---|
| `src/kernel/remotionStyle/remotionStyle.test.mjs` | 工具的单测、两条守门、锁只读的单测（11 条） |
| `server/test/remotion-style.test.mjs` | 检查接进建卡改卡之后的行为（9 条） |
| `src/online/cardRuntime/remotionLock.test.mjs` | 哪些卡该锁、老卡不碰、在线页面载入（7 条） |
| `server/test/cloud-agent-tools.test.mjs` 新增 CA-HT-03b | 云端 Agent 建卡改卡整条链 |
| `server/test/fixtures/remotion-style/` | 14 张违规样例、3 张用框架写的示例卡、1 张「绕一道往顶层写」的卡、1 张有状态的对照卡。都不进卡片库 |
| `scripts/probes/remotion-style-probe.mjs` + `remotion-style-harness.html` | 真的开发服务器、真 Chrome 的端到端探针 |
| `scripts/probes/card-source-version-compare.mjs` | 核对现有卡片的源码版本有没有变 |

改动的已有文件只有四个：`server/vite-plugin-cards.ts`、`src/online/cardRuntime/transpile.ts`、`server/test/cloud-agent-tools.test.mjs`、`src/online/cardRuntime/cardRuntime.test.mjs`（后者只是把 `remotionLock.mjs` 加进「编辑页面一侧的模块里没有执行代码的手段」那条守门的名单）。

## 〔裁〕清单

### 〔裁 1〕工具的名字和参数（写卡的人和 Agent 照着写的接口）

时间一律是秒，就是卡片组件收到的 `t`。

| 名字 | 参数 | 返回 | 一句例子 |
|---|---|---|---|
| `interpolate` | `(t, 时间点[], 取值[], { easing?, extrapolateLeft?, extrapolateRight? })`。时间点从小到大；范围之外缺省停在端点（`"clamp"`），可改成 `"extend"`；`easing` 给一条或一段一条 | 数 | `interpolate(t, [0, 0.4], [0, 1])` |
| `interpolateColors` | `(t, 时间点[], 颜色[], 同上)`。颜色认 `#rgb`、`#rrggbb`、`#rrggbbaa`、`rgb()`、`rgba()` | `"rgba(r, g, b, a)"` | `interpolateColors(t, [0, 1], ["#ff0000", "#0000ff"])` |
| `tween` | `(t, { from = 0, to = 1, delay = 0, duration, easing = Easing.easeOut })` | 数；开始前是 `from`，走完是 `to` | `tween(t, { from: 40, to: 0, delay: 0.2, duration: 0.5 })` |
| `Easing` | `linear` `quad` `cubic` `quart` `sin` `circ` `expo` `bounce`；`back(overshoot)` `elastic(bounciness)`；`in(e)` `out(e)` `inOut(e)`；`bezier(x1, y1, x2, y2)`；`steps(n, atEnd)`；`easeIn` `easeOut` `easeInOut` | 缓动函数 `(p) => 数` | `Easing.bezier(0.16, 1, 0.3, 1)`、`Easing.out(Easing.back(1.4))` |
| `spring` | `(t, { stiffness = 100, damping = 10, mass = 1, from = 0, to = 1, delay = 0, velocity = 0, clamp = false })` | 第 t 秒的位置 | `spring(t, { from: 0.6, to: 1, stiffness: 180, damping: 12 })` |
| `springDuration` | `(同一组参数, restRatio = 0.001)` | 停稳要多少秒（含 `delay`） | `springDuration({ stiffness: 180, damping: 12 })` ≈ 1.17 |
| `stagger` | `(t, index, { each, delay = 0, from = "first" \| "last" \| "center" \| 下标, count? })` | 第 index 个元素自己的时间 | `tween(stagger(t, i, { each: 0.08 }), { duration: 0.4 })` |
| `staggerDuration` | `(count, 同一组参数, 单个元素的时长 = 0)` | 整组走完要多少秒 | `staggerDuration(5, { each: 0.08 }, 0.4)` = 0.72 |
| `random` | `(种子, ...序号)`，种子和序号是数或字符串 | [0, 1) | `random(params.seed, i)`、`random(params.seed, i, "hue")` |
| `randomRange` | `(min, max, 种子, ...序号)` | [min, max) | `randomRange(-20, 20, params.seed, i)` |
| `randomInt` | `(min, max, 种子, ...序号)` | 整数，两头都取得到 | `randomInt(1, 6, params.seed, i)` |
| `randomPick` | `(数组, 种子, ...序号)` | 数组里的一个 | `randomPick(["#f43", "#3af"], params.seed, i)` |
| `noise` | `(x, 种子, ...序号)` | −1～1，随 x 平滑起伏 | `noise(t * 2, params.seed, i) * 12` |
| `clamp` `lerp` `loop` `pingPong` | `clamp(x, lo = 0, hi = 1)`、`lerp(a, b, p)`、`loop(t, period)`、`pingPong(t, period)` | 数 | `loop(t, 2)` 每 2 秒从头走一遍 |

几处取舍：

- 名字尽量和 Remotion 库的同名工具对上（`interpolate`、`spring`、`Easing`、`random`、`interpolateColors`），Agent 凭印象写出来的调用多半就是对的。两处不同要在指南里点明：时间是秒不是帧；`interpolate` 范围之外缺省是停住（Remotion 缺省是延伸）。
- `tween` 缺省缓动是 `easeOut`（进场最常用），`interpolate` 缺省匀速。
- `noise`、`springDuration`、`staggerDuration` 不在任务书列的五样里。`noise` 是「一直在轻轻晃」这类效果的替代品，没有它写卡的人会想去累加状态；后两个给 `lifecycle.settleMs` 用。
- 随机的算法（FNV-1a 加 MurmurHash3 的收尾混合）有 7 个值钉在单测里：换算法会让已经建好的卡画面变。

### 〔裁 2〕remotion 式的卡可以引用的模块

| 模块（用户卡里的写法） | 为什么要 |
|---|---|
| `react`、`react/jsx-runtime` | 组件，和不记状态的 hook（`useMemo`、`useRef(null)`、`useEffect`、`useLayoutEffect`、`useId`） |
| `../../kernel/remotionStyle` | 框架 |
| `../../kernel/types` | `CardDef`、`CardProps` |
| `../../kernel/frameReady` | `beginFrameWork`：异步准备好之前挡住截图 |
| `../../kernel/soundEffects`、`../native/sound-effects` | 声音配方与 `cardSoundBlock`（纯计算） |
| `../../render/cards/graphValues` | 素材效果卡的出口 `glsl`、`draw`、`bitmap` |
| `../native/hud` | 位置与主色的约定 |
| `../magicui/vendor/cn` | 拼类名 |

只带类型的导入（`import type …`）不限。**不在名单里的**：`motion`、`motion/react`（规矩本身）；`lottie-web`、`@tsparticles/*`（自带时钟或内部取随机，Lottie 等「癸」做完由内置的封装卡提供）；`three`（3D 动效卡搁置中，等它的标准）；同目录的别的文件与样式文件（样式文件里的动画建卡时看不见）。名单在 `server/remotion-style-check.mjs` 的 `REMOTION_IMPORT_ALLOW`，放开一样就是加一行。

### 〔裁 3〕「remotion 式的规矩」逐条对上的检查

| 规矩（`render-standard.md`） | 规则代号 | 认什么 | 违规样例 |
|---|---|---|---|
| 只许引用框架 | `import` | 名单之外的导入、动态 `import()`、`require()` | `violations/import.tsx` |
| 读真实时间 | `real-time` | `Date.now()`、不带参数的 `new Date()` / `Date()`、`performance` | `real-time.tsx` |
| 定时器 | `timer` | `setTimeout`、`setInterval`、`setImmediate`、`requestIdleCallback` | `timer.tsx` |
| 逐帧回调 | `frame-callback` | `requestAnimationFrame`、`cancelAnimationFrame`、`setAnimationLoop`、`requestVideoFrameCallback` | `frame-callback.tsx` |
| Motion 的动画与弹簧 | `motion` | 引用 `motion` / `motion/react`、`<motion.x>`、`whileHover` 这类属性 | `motion.tsx` |
| 进出场组件 | `presence` | `<AnimatePresence>` | `presence.tsx` |
| CSS 动画与过渡 | `css-animation` | 样式对象里的 `animation*` / `transition*`（写 `"none"` 的不算）、样式文本里的 `@keyframes` / `animation:` / `transition:`、类名 `animate-*` / `transition*`、元素的 `.animate()`、SVG 的 `<animate>` | `css-animation.tsx` |
| 不带种子的随机 | `random` | `Math.random`、`crypto` | `random.tsx` |
| 跨帧累加的状态 | `state` | `useState`、`useReducer` 等七个记状态的 hook；`useRef(初值)`、往 `.current` 里写；往文件顶层的名字或导入的东西里写（赋值、自增、`delete`、`push` 这类会改内容的方法、`Object.assign`）；`window`、`globalThis`、`self`、本地存储；`eval`、`Function()` | `state.tsx`、`state-ref.tsx`、`state-top-write.tsx`、`state-global.tsx` |
| 顶层只许写常量（第一道只读） | `top-level` | 顶层的 `let` / `var` / `class` / `enum`、直接执行的语句；顶层初始化式里的 `new`、`await`、赋值 | `top-level.tsx` |
| （原有）卡片挂载即播放 | `viewport` | `IntersectionObserver` | — |
| 写法以声明为准 | `frame-mode` | `frameMode` 写成了读不出字面量的东西 | `frame-mode.tsx` |

报错的样子：`[remotion 式] 第 6 行：用了不带种子的随机（Math.random）：……用框架 "../../kernel/remotionStyle" 的 random(种子, 序号)，由种子和序号直接算。` 每条带行号，改法都指向框架或 `t`。原来劝人用 Motion 的那几句（「动画交给 motion/react」「用 motion/react 的 animate」「或改用 motion/react」「要它播就用 initial + animate」「装了的是 react、motion/react……」）在 remotion 式的卡上都不再出现，单测 RSC-02 钉着。

末尾另有一句不带行号的总说明：这张卡声明的是 remotion 式、只用框架写；要从起点一帧帧推进的写法是另一种声明 `frameMode: "stateful"`。它没有劝人用 Motion 这个库，只说另一种声明存在——不然 Agent 遇到确实需要状态的效果，会在 remotion 式里硬凑。**主会话觉得这句也算「指向 Motion」的话，删掉 `TRAILER` 一个常量即可。**

### 〔裁 4〕不许用 `useState` 这类记状态的 hook

React 的状态活得比一帧长，`useState` 加 `useEffect` 就是一个跨帧的累加器，源码上分不出「存加载结果」和「存计数」。代价：靠异步取数据再重渲的 DOM 卡（先 `fetch` 再 `setState`）写不成 remotion 式，只能声明成 motion 式，或者在 effect 里直接画并用 `beginFrameWork` 挡住截图。`useRef` 只许 `useRef(null)`（拿 DOM 节点），不许带初值、不许往 `.current` 里写。

### 〔裁 5〕载入时锁只读只作用在哪些卡上

**只锁用户卡目录下「声明成 remotion 式、并且引用了框架」的文件。**

- 理由：边界要求不弄坏老卡。框架出现之前建的卡不可能引用它，所以这个条件对老卡恒假，是按构造保证的，不靠猜。内置卡不在用户卡目录下，同样不碰（「癸」把 Lottie 改成 remotion 式时顶层可能要放缓存，那是仓库里审过的代码）。
- 没选的另一条：「声明成 remotion 式、并且过得了源码检查的就锁」。它能多锁住一类卡，但一张老卡如果恰好过得了检查、又绕一道变量往顶层的缓存里写，就会在载入后抛错——正是边界不许的事。
- **留下的缺口**：新建的 remotion 式的卡如果一个框架工具都没引用（只用 `t` 做加减乘除的简单卡、只用 `glsl` 的素材效果卡），不过第二道。它仍过第一道（顶层只许常量、直接往顶层写被拒）。要堵上，可以规定「remotion 式的卡必须引用框架」，但那会让现有探针里声明成 remotion 式的建卡夹具（`card-overlay-probe.mjs` 等）和建卡指南的三个 GLSL 例子都建不出来，所以没做，留给主会话和用户定。
- 锁的范围：这张卡文件顶层有值的每个名字，往下一直锁到底（普通对象、数组、函数、正则、Map、Set）。别的模块导出的东西连同它们下面一层不碰（不然卡片顶层写一句 `const R = React` 就会把 React 的内部对象冻住，整页都坏）；带 `$$typeof` 的 React 元素不碰（开发模式的 React 要往里记东西）。锁不住的类型（定长数组、类的实例、Promise、DOM 节点）载入时直接报错，说明是哪个名字。

### 〔裁 6〕改卡用差量口径，新建卡与用框架写的卡用绝对口径

- 新建卡（没有改之前的版本）、引用了框架的卡：每一条违规都拒。
- 改一张框架出现之前建的、没引用框架的 remotion 式的卡：只拒绝这次编辑**新增**的违规（按规则数个数，原样留着的旧行不重复报）。和现有的 `compositing: 'independent'` 用的是同一种口径。
- 理由：任务书说「检查只在建卡、改卡时拒绝」，但如果改卡也用绝对口径，用户让 Agent 给一张老卡调个字号，会被一串早就存在的违规挡住，只能先重写这张卡（画面会变）或改声明。差量口径下，新规矩建出来的卡违规数是 0，之后的编辑等同于绝对口径。
- `Date.now()`、`setTimeout` / `setInterval`、`IntersectionObserver` 三样原来对所有卡就是出现即拒，在 remotion 式的卡上照旧，只是带上了行号、换了文案。
- 老卡一旦在编辑里引用了框架，从那一刻起每一条都要改掉（它载入时会被锁）。
- 从 motion 式改成 remotion 式按新建算；反过来改则不再归这套规矩管。

### 〔裁 7〕内置的 remotion 式的卡改卡时也查

`checkSourceEdit` 对声明成 remotion 式的内置卡片文件同样跑这套检查，差量口径。四张内置卡按新规矩各有几条原来就有的写法（例如 `caption-track` 引了 `./hud.css`，`sound-effects.ts` 里有一处 `setTimeout`），都不追究、内置卡一个字没改；新加的违规被拒并带行号。这类文件上，原来那张「不许新加」的表里说时间与定时器的五条由它代替（那五条的文案是「用 motion 的 animate」）。别的内置文件与共用部件行为不变。

### 〔裁 8〕`frameMode` 读不出字面量时拒绝

`frameMode: MODES[0]` 这种写法，建卡时读不出这张卡是哪种写法，「以声明为准」就落空了，还能用来绕过整套检查。所以建卡时要求它是字面量（或指向一个顶层的字符串常量）。差量口径，老卡不追究。写成 `"stateful"`、旧值 `"react"` / `"non-react"`、认不出的字面量值的卡不受影响：不当 remotion 式查，和原来一样。

### 〔裁 9〕在线页面的转译缓存：该锁的卡另用一个键，运行时版本不动

该锁的卡转译出来的文本多了末尾那一句，旧的转译缓存不能再用。我先是把在线卡片运行时版本从 `ocr2` 加到 `ocr3`，后来撤掉了：这个版本号进纯浏览器节点的环境指纹，一动，在线浏览器里所有卡的键都跟着变。现在的做法是只给该锁的卡的缓存键加一个后缀（`+lock1`），别的卡的键不变。

## 看源码查不出来的那一类

**依赖「谁先加载好」（字体、图片先画一版再变）查不出来。** 原因：一张 `<img>`、一个 `@font-face` 的字体名，源码上没有任何一句不对；画面会不会「先画一版再变」取决于截这一帧时图片解码完没有、字体到没到，那是运行时的网络和缓存决定的。单测 RSC-09 证明这类写法确实过得了检查。

靠什么兜住：

- 预渲染与导出在每一帧截图之前等齐：`server/bakery/frame-ready.mjs` 的 `waitFrameReady` 等 `document.fonts.ready`、每张图片的 `decode()`、以及卡片自己声明的异步准备（`src/kernel/frameReady.ts` 的 `beginFrameWork`），20 秒没齐就报错停下，不会截一张半成品。
- remotion 式的卡不许用记状态的 hook，「加载好了再 `setState` 换一版画面」这条路在组件里走不通。

**同样查不出、也没有兜底的几种，如实列出：**

| 写法 | 为什么查不出 | 现状 |
|---|---|---|
| 画布不清就接着画（上一帧的像素留在画布上） | 画布本身就是活得比一帧长的东西，「有没有整张重画」是画的内容，不是写法 | 没有兜底。示例卡 `rs-orbit-canvas.tsx` 的做法是每帧先 `clearRect`，建议写进指南 |
| 往 DOM 节点上存东西（`el.dataset.n`、往节点上挂属性） | 和正常操作 DOM 的写法一样 | 没有兜底 |
| 往 `params` 里写 | `params` 是函数的参数，不是顶层的名字 | 没有兜底；可以由宿主在传参前冻住，不在这次范围 |
| 绕一道变量往别的模块导出的对象里写（例如 `hud.ts` 的 `hudDefaults`） | 别名看不出；那些对象不是这张卡的，锁只读时特意不碰 | 没有兜底 |
| 没引用框架的 remotion 式新卡，绕一道变量往自己顶层的对象里写 | 见〔裁 5〕的缺口 | 没有兜底 |

这几种的共同点是用户 2026-10-09 否决过的那个办法（把卡从头推到第 N 帧、再直接跳到第 N 帧，比两次画面）才测得出来。这次的探针就是那个比法，只对夹具里的卡跑。

## 验证结果

### 基线

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误 |
| 全量测试 | `npm test`（同一条命令里设了那两个环境变量） | 退出码 0，5531 条里通过 5527、失败 0、跳过 4，详见下「全量测试」 |

### 验收逐条

**1. 工具的单测**——`node scripts/test-suite.mjs src/kernel/remotionStyle/remotionStyle.test.mjs`：11 条全过，退出码 0。

- RS-T-01：把 16 个工具都用一遍当作「一帧的画面」，8 个帧各重复求值 5 次，按 64 位浮点的位模式逐位比，相同。
- RS-T-02：150 帧顺着算一遍；再倒着算、按打乱的次序跳着算、「先第 149 帧再第 0 帧」这样的成对算，每一帧与顺着算的逐位相同。
- RS-T-03：弹簧的解析解与步长十万分之一秒的数值积分对照，欠阻尼、临界、过阻尼、带初速度四组，最大偏差小于千分之二。
- RS-T-04：随机与调用先后无关（中间插 1000 次别的调用再问，同一个数）；没有种子抛错；十万个数分十桶，每桶离一万不超过 4%。

**2. 每条规矩一张违规样例**——`node scripts/test-suite.mjs server/test/remotion-style.test.mjs`：9 条全过。RSC-01 对 14 张样例逐张断言被拒、报错里有违规那一行的行号、且只违反它自己那一条；4 张合规的通过。

**3. 三道只读各有用例**

- 第一道：RSC-03，12 种顶层写法逐个被拒并指出行号，13 种常量写法通过。
- 第二道：RS-T-06（锁的单测，20 种写法逐个抛 `TypeError`）；RL-04（在线页面的加载器里真的执行）；探针第 6 步（真 Chrome 里经开发服务器载入）：
  `"errors":{"write-object":{"name":"TypeError","message":"Cannot assign to read only property 'frames' of object '#<Object>'"},"write-array":{"name":"TypeError","message":"Cannot add property 1, object is not extensible"}},"after":"read-only01"`
- 第三道：RS-T-05，钉住对外导出的名单（17 个）、每个不是函数就是冻住的表、框架的每个源文件顶层没有可变量也不碰时钟与随机。

**4. 示例卡逐像素比**——`node scripts/probes/remotion-style-probe.mjs --port 7440`：退出码 0，`"fails":[]`，Chrome 152.0.7977.75。

三张示例卡（逐字弹入的标题、随机柱状图、画布上的环绕光点）各自：一页上从第 0 帧一帧帧渲到第 90 帧，在第 0、7、20、45、90 帧截图；另开新页直接渲那一帧；同一页上再倒着跳一遍。1920×1080 逐像素比：

| 卡 | 顺着渲 对 直接渲（五个检查点） | 倒着跳 对 直接渲 | 第 7 帧与第 90 帧不同的像素 |
|---|---|---|---|
| `rs-title-reveal` | 0、0、0、0、0 | 0、0、0、0、0 | 54031 |
| `rs-bar-race` | 0、0、0、0、0 | 0、0、0、0、0 | 197990 |
| `rs-orbit-canvas` | 0、0、0、0、0 | 0、0、0、0、0 | 41354 |

对照：有状态的卡（每渲染一次往 ref 里加一）同样的比法差 13619 个像素——这套比法测得出问题。

我看过的图（`out/remotion-style-probe/`，不入库）：`rs-title-reveal-f020-direct.png`（五个字，后三个正从主色过渡到白，下划线展开到一半）、`rs-bar-race-f090-direct.png`（14 根柱子带数字，高度参差）、`rs-orbit-canvas-f045-direct.png`（一圈青色光点，大小与透明度各异）。画面都是预期的样子，不是空的。

这个探针用的是一个只挂卡片组件的画面台，不经过舞台和预渲染管线。remotion 式的卡在舞台上就是带着 `t` 调同一个组件，所以比的是卡片自己；经真的预渲染与导出管线的比对没有做。

**5. 桌面和云端两条路**

- 桌面：探针第 2 步经 `POST /api/cards/create` 提交 14 张违规样例，全部回 400 并指出行号；4 张合规的回 200、源码写进改动层、检出目录一个文件没多。`POST /api/cards/edit` 往示例卡里加一句 `Math.random()` 回 400 并指出第 11 行；改文案回 200。另有单测 RSC-07 直接调 `createUserCard`。
- 云端：`server/test/cloud-agent-tools.test.mjs` 的 CA-HT-03b，起真的云端 Agent 服务，经 `create_card` 提交 10 张违规样例，全部被拒、报错带行号、源码没进内容库；3 张示例卡入库且读回一字不差；`edit_card` 新加违规被拒。9 条全过。

**6. 现有内置卡照常载入**

- 探针第 3 步：页面里装载整套卡片，注册表里 106 张（native 38、magicui 6、素材目录生成的 58、新建的用户卡 4），内置的 102 张一张没被跳过，没有载入警告；声明成 remotion 式的内置卡 `av-pulse`、`caption-track`、`probe-slow`、`sound-keyboard`、`sound-notification` 都在；内置卡模块的文本里没有接「锁只读」那一段。
- RL-02：仓库里 `src/cards/`、`src/parts/` 下每一个文件都不接那一段，在线页面转译出来的文本与原来一字不差。
- RSC-04：一张按新规矩有四条违规的老卡，打开项目与内容库同步两条装卡的路都照旧装得上，源码一个字没动。
- RSC-06：四个内置的 remotion 式的文件原样改一处文案能过。

### 现有内置卡的键有没有变

**没变。** 核对办法：`node scripts/probes/card-source-version-compare.mjs --base main`，把 `main`（`31c03966`）的 `src/` 解到临时目录，两边各对 `src/cards/`、`src/parts/` 下每个文件当入口算一遍源码版本（页面一侧的算法，定义文件连同导入闭包的全文），再各对每张内置卡算一遍服务端的代码身份，逐个比：

`{"ok":true,"base":"main@31c03966","entries":88,"changed":[],"added":[],"removed":[],"identities":61,"identityChanged":[],"identityAdded":[]}`

拿 9 月 20 日之前的一个提交当基准跑同一个脚本，报出 72 个入口变了，说明它比得出差别。

为什么没变：框架是新目录，现有文件没有一个引它（守门测试 RS-T-07 钉着：`src/` 下除了框架自己谁都不引它，它也不引别的模块）；我改的两个已有源文件 `server/vite-plugin-cards.ts`、`src/online/cardRuntime/transpile.ts` 都不在任何卡的导入闭包里；`kernel/types.ts`、`frameMode.mjs`、`cardGraph.mjs` 这些会进闭包的文件一个没碰。在线卡片运行时版本也没动（见〔裁 9〕）。

### 全量测试

命令（两个环境变量的值取自 `docs/local.md`，这里不抄）：

`PROMPTCUT_ACCOUNT_PROVIDER_ROOT=… PROMPTCUT_PASSWORD_ORDER_MODULE=… npm test`

结果：退出码 0，末行 `✓ npm test 最终结果：零失败`。5531 条，通过 5527，失败 0，取消 0，跳过 4，用时 84.7 秒。一次跑过，没有哪个文件被单独重跑。

跳过的 4 条都是原来就有、与这次无关的：一条要另设 `ACCOUNT_PROVIDER_DIR`，两条是 Windows 上不验的（符号链接、POSIX 权限位），一条是 `/api/cards/layout` 的集成用例自己标的跳过。这次新增的用例都在这一趟里跑了。

## 没做成的及原因

1. **没有改 `server/hosted-render/source-gate.mjs`。** 它不是云端 Agent 建卡的检查，是渲染节点装同步文件之前的预检，装老卡也走它；往里加 remotion 式的规矩，老卡在渲染节点上就装不上了，违反边界。云端 Agent 建卡的检查在 `server/agent/service/hosted-tools.mjs` 的 `createCard` / `editCard` 里，调的是和桌面同一个 `checkCardSource`，已经随它接上并验到。单测 RSC-08 钉住预检没有因此变严、用框架写的卡过得了预检。
2. **托管方的渲染节点（隔离工作进程）没有实跑。** 它载入卡片用的是同一个卡片插件，转换钩子会生效，但页面请求闸放不放行 `src/kernel/remotionStyle/lock.ts` 没有在真的隔离工作进程里验。
3. **在线页面没有在真浏览器里跑。** 用的是真的转译和加载器，在 Node 里执行（RL-03、RL-04），舞台与声音线程的模块表按代码读是带着 `src/kernel/**` 的。
4. **在线构建时打进包的用户卡不过第二道。** 在线构建的插件表（`vite.config.ts` 第 184 行）里没有卡片插件，而 `vite.config.ts` 不在我的文件范围里。现在仓库里构建时的用户卡只有 `mu-animated-shiny-text` 一张，是 motion 式，不受影响。
5. **没有经真的预渲染与导出管线比像素**，见验收第 4 条末尾。
6. **建卡指南没改**（那是「丙」）。在它改之前，指南里三个声明成 remotion 式的 GLSL 例子照着抄仍然建得出来（它们只引 `kernel/types` 和 `graphValues`，都在名单里），但指南第 3 节还在说「动画交给 motion/react」。

## 对任务书或语义的更正建议

1. **任务书「乙」的现状一句**：「云端 Agent 建卡走同一套，另加 `server/hosted-render/source-gate.mjs` 的一道」。后半句容易读成 source-gate 是建卡检查的一部分。建议写成：云端 Agent 建卡的检查在 `hosted-tools.mjs` 里调桌面同一个 `checkCardSource`；入库前另过一道渲染节点的装卡预检 `source-gate.mjs`，它装老卡也走，不能随建卡检查加严。
2. **`mechanism/cards.md`「轴一」**（任务书「语义文档要跟着改的」第 9 行）建议写得比那一行多两句：
   - remotion 式的卡只用 remotion 式的框架（`src/kernel/remotionStyle/`）写；建卡、改卡时检查，不合法的当场拒绝并指出哪一行。装卡不查，已经在库里的卡照旧载入。改一张框架出现之前建的卡，只拒绝新增的不合法写法。
   - 用框架写的用户卡载入时把文件顶层的对象锁成只读，往里写当场报错。
3. **`render-standard.md`「remotion 式的规矩」**建议补一条看源码查不出的：画布类的卡每一帧从空白开始整张重画。
4. 给「丙」的提示：指南里写清时间是秒、`interpolate` 范围之外缺省停住、`useState` 不能用、`useRef` 只写 `useRef(null)`、异步准备用 `beginFrameWork`、可以引用的模块名单、顶层只写 `const`。

## 要主会话决定或注意的事

- 〔裁 1〕的接口表要拿给用户审。
- 〔裁 5〕的缺口要不要用「remotion 式的卡必须引用框架」堵上。堵上要同时改现有探针的建卡夹具和指南的例子。
- 〔裁 3〕末尾那句总说明留不留。
- 〔裁 4〕不许 `useState` 的代价能不能接受。
- 探针 `card-source-version-compare.mjs` 别的子 Agent 也能用，改了 kernel、render、卡片载入之后跑一遍就知道有没有把现有卡的键带着变。
