# AGENT 报告：渲染重构「丙」改建卡指南

- 分支：`claude/rr-guide`（基于 `main` 的 `a76d3108`；中途合入 main 的 `faf03d4c`，修弹窗那一批）
- 工作区：`.worktrees/rr-guide`
- 任务书：`docs/plan/render-refactor-task.md` 的「丙」一节
- 端口段：7450～7459。探针只用过这一段，用完已按进程号收掉，结束时 7450～7459 上没有监听。

代号说明：「乙」是渲染重构里做 remotion 式框架的那一项（已合入 main），「丙」是本项（改建卡指南）。「remotion 式」= 声明 `frameMode: "direct"` 的卡，「motion 式」= 声明 `frameMode: "stateful"` 的卡。〔裁〕是我在任务书留给执行方定的地方做的决定。

## 状态

七项要做的都做了。**只有一件事要主会话接着办**：派不带上下文的子 Agent 盲写两张卡，用 `scripts/probes/guide-blind-check.mjs` 验（验收里最后一句，本任务按分工不由我做）。

## 做了什么

### 一、指南 `server/card-authoring-guide.md`（重写，约 850 行）

新结构：0 先别急着建卡（原样）→ 1 两种写法 → 2 remotion 式 → 3 motion 式 → 4 CardDef 契约（4.1 素材效果卡、4.2 DOM 卡例子、4.3 字段表、4.4～4.8 部件树、组合卡、素材封装卡、引用素材、默认值）→ 5 控件类型 → 6 硬性约束与依赖 → 7 组件收到什么 → 8 建卡流程与改卡 → 9 转写。

- 第 1 节：两种写法并排的对照表（声明、怎么得到画面、怎么写、适合什么、代价、检查），明写「没有哪一种更推荐」，不规定优先用哪一种。原来「能用 t 算的卡优先使用 direct」那句删掉。
- 第 2 节 remotion 式：框架全部工具的表（名字、参数、缺省值、例子，逐个和 `src/kernel/remotionStyle/` 对过）；点明和 Remotion 库的两处不同（时间是秒不是帧；`interpolate` 范围之外缺省停住）；三个完整例子（取自夹具，和夹具逐字一致）；写法要点（顶层只写常量、不能用记状态的 hook、`useRef` 只写 `useRef(null)`、画布每帧清空重画、异步准备用 `beginFrameWork`）；「建卡时会被当场拒绝的写法」15 行的表；能引用的模块名单；检查查不出来但同样不许的几种。
- 第 3 节 motion 式：适合什么、代价（要从起点推、预渲染存每一帧的快照）、几条硬规矩；现有规矩照旧。
- 素材效果卡的三个 GLSL / 音频例子照旧能建出来，并在 4.1 节写明：声明 `"direct"`、只引名单里的模块，不需要引用框架，但仍要过 2.4 的检查。
- 全文「图卡」改叫「素材效果卡」（「地图卡」「示意图卡」本来就没有）。

### 二、指南里过时或和代码对不上的地方（任务点名的两处加我发现的）

| # | 指南原文 | 代码实际 | 改成 |
|---|---|---|---|
| 1（点名） | `frameMode` 写「建议」 | `checkCardSource` 的 author 口径必填，写成变量也拒（`frame-mode` 规则） | 字段表标 ✓，第 1 节单讲 |
| 2（点名） | 旧值 `react` 按 direct 读 | `normalizeFrameMode`：`react`、`non-react` 都按 stateful 读 | 「都按 motion 式读」 |
| 3 | 例子「价格标签」没有 `frameMode` | 按现在的检查，这个例子自己建不出来 | 补 `frameMode: "stateful"`，并由测试逐个过建卡检查 |
| 4 | 「写了 `compositing` 会被 create_card 拒掉」 | 只拒 `'independent'`，别的值写了不作数 | 改成这个说法 |
| 5 | 「内置卡没有可读回的源码文件，`get_card_source` 对它们会报错」，与同一节前面（内置卡也能读、改）和工具说明自相矛盾 | `/api/cards/source` 对内置卡正常返回 | 删掉这句，改成「先试调参数，确实要动源码再读」 |
| 6 | 「不许新引入 Date.now / setTimeout / setAnimationLoop」 | `RISKY_PATTERNS` 还有 `new Date()`、`setInterval`、`IntersectionObserver` | 补全 |
| 7 | 「绝大多数卡不需要 `t`——挂载即播」 | 对 remotion 式的卡完全反过来（画面就是 t 的函数） | 第 7 节分两种说 |
| 8 | 动画 class、依赖表只有一种口径 | remotion 式有自己的名单与文案 | 依赖表分两列，`animate-*` 一行加注 |
| 9 | `id` 说明漏了 `lottie-` / `particles-` 保留前缀 | 检查里有 | 补上 |

### 三、工具说明与 Agent 提示词（只改文字）

- `server/tools/cards.mjs`：`card_authoring_guide`、`create_card`、`edit_card` 三条说明，提到两种写法、必填的 `frameMode`、remotion 式逐条带行号检查。
- `server/ai-system-prompt.md`（第 19 条和「不要凭印象写卡片源码」一段）；`server/agent/service/cloud-tools.mjs`（云端 Agent 提示词的「卡片」一条）。
- 原来「一律劝人动画交给 motion/react」的句子只在指南里（已改成只出现在讲 motion 式的地方）。
- **没改、但建议主会话看**：`server/vite-plugin-cards.ts` 里给 motion 式或没写 `frameMode` 的卡的三条报错文案（`Date.now()`、定时器那两条仍说「动画交给 motion/react」）。它们只在非 remotion 式的卡上出现，对 motion 式是对的；但一张没写 `frameMode` 又读了真实时间的新卡会看到它。这个文件不在我的清单里。

### 四、测试 `server/test/card-authoring-guide.test.mjs`（11 条）

| 用例 | 钉住什么 |
|---|---|
| GA-01 / 01b / 01c | 指南里标成「完整卡片」的 7 个例子逐个过 `checkCardSource`（建卡口径）；三个 remotion 式的例子和夹具逐字一致；三个素材效果卡例子不引框架、只引名单里的模块 |
| GA-02 / 02b | 第 2.4 节每一行有一个规则代号（下表）；每行的样例真的被拒并指出行号；检查源码里的 12 个代号一个不多一个不少地出现在表里 |
| GA-03 | 第 2.5 节名单 = `REMOTION_IMPORT_ALLOW` |
| GA-04 / 04b | 第 2.1 节工具表 = 框架对外导出的全部名字；缺省值与例子里的数字（`interpolate` 停住、`tween` 缺省缓动、`springDuration` ≈ 1.17、`staggerDuration` = 0.72、`random` 没种子抛错等）和代码对得上 |
| GA-05 | `beginFrameWork` 片段放进卡里过检查 |
| GA-06 | 指南不再说过时的话（`frameMode` 必填、旧值读法、不规定优先、没有「图卡」、没有「烘焙」「冻结」「补渲」） |
| GA-07 | 工具说明与提示词提到两种写法与 `frameMode` |

**指南里的规矩 ↔ 检查里的规则代号（对照表）**

| 指南 2.4 节那一行 | 规则代号 |
|---|---|
| 引用名单之外的模块，动态 `import()`、`require()` | `import` |
| `motion` / `motion/react`、`<motion.div>`、`whileHover` | `motion` |
| `<AnimatePresence>` | `presence` |
| CSS 动画与过渡（样式、`@keyframes`、`animate-*` / `transition*` 类名、`.animate()`、SVG `<animate>`） | `css-animation` |
| `Date.now()`、`new Date()`、`performance` | `real-time` |
| `setTimeout`、`setInterval`、`setImmediate`、`requestIdleCallback` | `timer` |
| `requestAnimationFrame`、`setAnimationLoop` 等 | `frame-callback` |
| `Math.random`、`crypto` | `random` |
| `useState` 等记状态的 hook | `state` |
| `useRef(初值)`、往 `.current` 里写 | `state` |
| 往文件顶层或导入的东西里写 | `state` |
| `window`、`globalThis`、`localStorage`、`eval`、`Function()` | `state` |
| 顶层的 `let` / `var` / `class` / `enum`、直接执行的语句、顶层 `new` / `await` / 赋值 | `top-level` |
| `IntersectionObserver` | `viewport` |
| `frameMode` 写成变量 | `frame-mode` |

12 个代号全覆盖（`state` 对应四行）。表里没有代号对不上的行，也没有检查里有而指南漏掉的规则。

### 五、盲写验收脚本 `scripts/probes/guide-blind-check.mjs`

`node scripts/probes/guide-blind-check.mjs --remotion <文件> --motion <文件> [--port 7450] [--out <目录>]`。起自己的开发服务器（临时改动层，检出目录一个文件不多），经真的 `POST /api/cards/create` 建两张卡，真 Chrome 里渲：remotion 式的做「顺着渲到第 N 帧（缺省 90）对直接渲」逐像素比（5 个检查点，再倒着跳一遍），motion 式的顺着播 2 秒确认画面在变且最后一帧不是空的；截图存 `out/guide-blind-check/`；stdout 最后一行 JSON，不过退出码 1，用法不对 2。

画面台用现有的 `remotion-style-harness.html`，我给它加了一个 `?css=1`（带上编辑器自己的样式；不带参数时行为不变），不然用 Tailwind 类写的卡会排错位置。

自己用夹具跑通：`--remotion rs-title-reveal.tsx --motion price-tag.tsx`（后者取自指南例子）退出码 0，`"fails":[]`；五个检查点顺着/倒着对直接渲的差都是 0 个像素。看了图：`remotion-rs-title-reveal-f020-direct.png`（前两个字白、第三个字起主色过渡、下划线展开到一半）、`motion-price-tag-step00.png`（暗色的 ¥199 居中）和 `step10.png`（亮黄、居中、位置上移完成）。对照：喂一张违规的夹具（`violations/random.tsx`）退出码 1，`remotion-create-status-400`，报错带第 6 行。

### 六、补验两处（只验证、不修）

**① 用框架写的用户卡在在线页面的真浏览器里能载入并渲染——过，但不是用「加入协作项目」那条路。**

- 现象：在线构建的开始页现在只剩账号入口（`src/StartPage.tsx` 的 `OnlineStartPage` 只挂 `AccountProjects`），`data-pc="join-form"` 不在在线构建里。`online-card-exec-probe.mjs`、`online-card-security-probe.mjs`、`online-user-cards-probe.mjs` 这一类靠 `join-form` 加入项目的探针在 main 上已经走不通（我照它搭的第一版就卡在等 `join-form`，页面上是「官网账号与项目列表／请求失败（account-protocol）」）。走账号要冻结的官网加 63xx 固定端口的夹具（`account-user-pages-probe.mjs`），不在这次的范围，没做。
- 做法：新探针 `scripts/probes/online-remotion-card-probe.mjs` 加画面台 `online-runtime-harness.html`。在真 Chrome 里跑**在线页面自己的卡片运行时**：`bundleCards`（Sucrase 转译，含载入时锁只读那一句）、`createCardLoader`（`new Function`、页面自带的模块表 `stageHostModules`）。四张卡：两张夹具原样、一张探针卡（引用框架，把 `interpolate` / `random` 算出的值和「顶层对象是否只读」写成 DOM 数据属性）、一张对照卡（同一张声明成 motion 式）。
- 结果：`node scripts/probes/online-remotion-card-probe.mjs --port 7450` 退出码 0，13 项全过：四张卡转译、载入成功；三张引用了框架的卡的转译结果接着「锁只读」那一句、对照卡不接；示例卡画出它的字；画布卡有像素；探针卡里三个 t（0.5、0.8、1.6）的位置和随机数与本进程里用同一套框架算的逐字相同，先到靠后的 t 再倒回来也相同；探针卡里 `Object.isFrozen(顶层常量)` 为真、对照卡为假；画布卡换几次 t 再回来整张画面逐像素相同；页面没有未捕获错误。看了图：`online-orbit-t1.png`（一圈青色光点）。
- 没覆盖：经账号加入、内容库同步、跨源舞台 iframe 与内容安全策略。真浏览器里的 Chrome 是 152.0.7977.75。
- 附带一个发现（给主会话）：对画布调 `getImageData` 之后，Chrome 会把它换成软件画布，边缘抗锯齿就变；我的第一版比像素是读画布的，同一帧得到两个哈希，改成比截图后好了。以后别人写「画布逐像素比」的探针要注意先比截图、最后再读像素。这是探针的假象，不是卡的问题。

**② 托管方渲染节点的隔离工作进程里能载入、渲染用框架写的用户卡——过。**

- 探针 `scripts/probes/hosted-render-remotion-probe.mjs`（`--base-port 7450`，托管组合 7458、7459），搭法照 `hosted-render-isolation-probe.mjs`：本机隔离的托管组合 + 渲染服务 + 一个共享项目。三张卡经内容库同步：夹具 `rs-title-reveal` 原样、探针卡 `rs-hosted-mark`（引用框架，画一个色块和一行字：色块位置由 `interpolate`、颜色由 `random` 算，顶层对象是只读则标签画成绿色否则红色）、对照卡 `rs-hosted-control`（同一张卡声明成 motion 式，标签应当是红色）。
- 经管理进程的「看画面」`/look`（用一把登记过的 agent 服务私钥签名）要三帧（t = 0.5、0.8、1.6 秒），再发清单计划。
- 结果：退出码 0，13 项全过：两张框架卡的源码过装同步文件前的预检（没有记「被拒」）；清单计划做完、没有失败的细任务；三帧都由隔离工作进程出（`byWorker.isolated` +3，常驻 +0，常驻没有认领）、回了 768×432 的图、画面不是空的；页面请求闸日志里没有一条针对 `/src/kernel/remotionStyle/` 的拒绝，整段渲染里页面一侧的拒绝为 0，闸是开着的（`enforce`）；画面里量：色块左边缘（图上的像素）和本进程里用同一套框架算的相差 0～1 像素（180/180、198.7/199、200/200），三个 t 上位置各不相同；标签绿色 1643 个像素、红色 0；对照卡标签红色 1597 个像素、绿色 0（说明「绿色」不是白给的，锁只读在隔离工作进程里也接上了）；`pageGate` 纯函数对框架的 7 个文件：作为页面自己的请求放行、作为别的源的请求拒绝。看了图：`out/hosted-render-remotion-probe/look-t080.png`（标题逐字弹入、蓝色色块、绿色标签）。
- **结论：页面请求闸放行 `src/kernel/remotionStyle/` 下的文件；框架卡能在隔离工作进程里载入并渲对。没有要改的。**
- 顺带看到的现状：remotion 式的两张卡不出预渲染结果（层表里只有声明成 motion 式的对照卡那个片段），托管节点渲 remotion 式的卡走的是「看画面」这条路。这是现状，不是这次要办的事。
- **另一个发现（要主会话看）**：在合入 `faf03d4c` 之后的两次实跑里，隔离工作进程每一轮结束时清理都报 `isolation.cleanup-failed：…\render\iso 不是隔离工作进程的目录（没有记号），不清`（`cleaned:false`）。合入前（旧代码）同样的探针里是 `cleaned:true`。后果：同一次服务里，第一轮结束（闲置 8 秒）后再起第二轮会 `prepare-failed`，「看画面」回 503，重试到超时回 504。我不改 `server/hosted-render/`，只是把探针改成先看画面、最后才发清单计划，两件事都在第一轮里做完，所以探针过了；但这个现象本身可能是弹窗那一批改动（给子进程加 `windowsHide`）带出来的：进程是否比原来更早退出、Chrome 的用户数据目录里的记号文件被谁先删掉，我没有查。复现办法：在本分支上，把托管探针里「先看画面、后发清单计划」改回「先发清单计划、等它做完和闲置 8 秒、再 `/look`」。

### 七、弹窗一事（任务中途主会话通知的）

- 我第一版托管探针是在没有 `windowsHide` 的旧代码上跑的，探针本身起进程都带了 `windowsHide: true`，弹窗来自 `server/vision/worker-pool.ts` 的 fork（主会话已查明并在 `faf03d4c` 修好）。我没有在跑的当时检查窗口，是我的疏漏。
- 收到通知后：立刻查了没有残留进程、7450～7459 无监听、无可见新窗口；在通知前不再跑托管探针；合入 main 后重跑托管探针 3 次，跑前、跑中（每 5 秒一次，共一百多秒）、跑后都查了 `OpenConsole` 进程数与可见窗口：**OpenConsole 始终 0，除用户自己的那个 chrome（18392）外没有任何可见窗口**。在线页面探针、盲写脚本、全量测试期间同样查过。

## 验证结果

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force`（合入 main 之后） | 退出码 0，输出为空 |
| 全量测试 | `npm test`（同一条命令里设了那两个环境变量，合入 main 之后）| 第一次：5557 条，通过 5552，失败 1，跳过 4。失败的是 `agent-live-selection` 的「account get_selection…」，用时 9.96 秒超时，是任务书点名的机器忙时偶发项；单独重跑 `npm test -- server/test/agent-live-selection.test.mjs`：1 条，通过，零失败，退出码 0。没有改松任何测试 |
| 指南测试 | `node scripts/test-suite.mjs server/test/card-authoring-guide.test.mjs` | 11 条全过 |
| 内置卡的键 | `node scripts/probes/card-source-version-compare.mjs --base main` | `{"ok":true,"base":"main@9fb65425","entries":88,"changed":[],"added":[],"removed":[],"identities":61,"identityChanged":[],"identityAdded":[]}` ——没变（我没碰 kernel、render、cards） |
| 盲写脚本 | 见上，退出码 0；违规卡退出码 1 | 过 |
| 在线页面补验 | `online-remotion-card-probe.mjs`，退出码 0，13 项过 | 过 |
| 托管节点补验 | `hosted-render-remotion-probe.mjs`，退出码 0，13 项过 | 过 |

（合入 main 之前我分三批跑过除托管渲染相关的 10 个文件之外的全部测试，也只有这一条偶发失败。）

## 没做成的及原因

1. 「派不带上下文的子 Agent 只读指南写两张卡」——任务分给了主会话，脚本已备好。
2. 在线页面补验没有经「账号加入」那条路（原因见六①）；第 6 节的 `online-*` 老探针在 main 上走不通，没有修（不在我的范围，也要账号夹具）。

## 〔裁〕

1. 指南里「完整卡片」的例子用 ` ```tsx 完整卡片 ` 作代码块的说明行，测试靠它抽出来；渲染器看到的是普通 `tsx` 代码块。
2. remotion 式三个例子的 `id`（`rs-title-reveal` 等）沿用夹具的，没改，这样测试能逐字比对夹具。Agent 照抄会建出同名卡，需要时自己换 id，指南里写了「`id` 换成自己的」。
3. 「不规定优先用哪一种」我落成：第 1 节明写「没有哪一种更推荐」，并且删去了所有「优先」。
4. 给 `remotion-style-harness.html` 加 `?css=1`：属于我写的盲写脚本的需要，不改变原探针行为。
5. 指南里列「检查查不出来但同样不许」的五种，取自乙的报告「看源码查不出来的那一类」，没有自己新增。

## 对任务书或语义的更正建议

1. **任务书「丙」的「补验」第一处**：在线页面「照在线执行用户卡的现有探针搭」走不通了——在线构建没有 `join-form`，那一类探针都要账号。建议在进度文件里记：`online-card-exec-probe` 等需要改成走账号夹具后才能用，这是另一件事。
2. **`docs/plan/render-standard.md`「remotion 式的规矩」**（乙已建议过）：补一条「画布类的卡每一帧从空白开始整张重画」。我在指南里已经写了，语义文档该有。
3. **指南没写、但可以考虑规定的**：「remotion 式的卡必须引用框架」（乙的〔裁 5〕缺口）。现在的指南说：没引用框架的 remotion 式新卡不会被载入时锁只读，但检查照样查。如果用户决定堵上缺口，要同时改指南 4.1 节三个素材效果卡例子的那一段说明、`card-overlay-probe.mjs` 等夹具。
4. **`vite-plugin-cards.ts` 的三条文案**见「三」末尾。
5. **隔离工作进程清理失败**见「六②」。

## 附：隔离工作进程「没有记号」查因（主会话追问第 1 条）

**结论：不是 `faf03d4c` 带出来的。是 `wipeDir` / `wipeIso` 里一个本来就有的缺陷（2026-10-06 的 `ae43593a`、`35f16683` 引入），被「工作进程停了、它的子进程还没死透」这个时间差触发；这个时间差取决于机器忙不忙，所以偶发。** 其余几项排除如下。

**机制（有证据）**

1. 隔离工作进程结束时，管理进程的 `cleanup` 调 `wipeIso`（`server/hosted-render/main.mjs`）：最多 20 次，每次调 `wipeDir(iso 目录)`，遇到 `iso-not-ours` 直接抛、别的错等 500 毫秒再来。
2. `wipeDir`（`isolation.mjs`）用 `fs.rmSync(整个目录, {recursive, maxRetries: 5, retryDelay: 200})`。Windows 上目录里的 `tmp`、`vite-cache` 被还没死透的 `chrome-headless-shell` / `node` 占着时，`rmSync` 重试约 1 秒后抛 EPERM。而它是按目录顺序删的，**记号文件 `.promptcut-render-iso`（点开头，排第一）已经先删掉了**。
3. `wipeIso` 的第二次调用看到「非空、没有记号」，抛 `iso-not-ours`，而这一种错不重试——日志里就是 `…\iso 不是隔离工作进程的目录（没有记号），不清`。目录里剩下 `tmp`、`vite-cache`，记号再也不会回来：之后同一次服务里每一轮 `prepare` 的 `wipeDir` 都抛同一个错，隔离工作进程起不来（我看到的 `/look` 先回 503「渲染服务现在忙」、重试到超时回 504）。

**证据**

- 确定性复现：`node scripts/probes/hosted-render-wipe-demo.mjs`（新增，只在系统临时目录里操作）。用真的 `wipeDir` 和 `wipeIso` 一样的重试写法，让一个子进程把工作目录停在 `iso/tmp` 里 3 秒：第 1 次 `EPERM`、此刻目录里只剩 `tmp`、`vite-cache`（记号没了）；第 2 次 `iso-not-ours`，不再重试；收尾后下一轮 `wipeDir` 仍是 `iso-not-ours`。
- 真服务里观察：给托管探针加了 `--watch-iso`（只读：每 300 毫秒看一次 `render/iso` 下的名字、记号在不在；管理进程报 `isolation.stop` 之后每秒列一次命令行里带本次临时目录的进程）。其中一轮拍到：停止后 0.9 秒工作进程退出，此刻 iso 目录是 `NO-marker:2:tmp,vite-cache`（记号已被删、其余还在），同时还有 2 个 `chrome-headless-shell.exe` 活着；约 1 秒后它们死了、第二次重试清干净、`cleaned:true`。这一轮是侥幸：Chrome 在 `rmSync` 的重试窗口内死了。窗口外死就是「没有记号」。
- 子进程死透要多久（`--watch-iso` 四轮，`isolation.stop` → 工作进程退出）：0.93、1.07、0.84 秒各一次，另一次 6.3 秒（此时还有 3 个进程撑了 6 秒）。时间差不是固定的。

**对「是不是 faf03d4c」**

- `faf03d4c` 里在这条链上的只有 `server/vision/worker-pool.ts`：给 `fork`（渲染工作进程）和一处 `taskkill` 加 `windowsHide: true`，其余 18 处不在这条探针的路径上（导出、STT、主体检测、ffmpeg、agy、验证脚本）。`worker-pool.ts` 的改动只影响「要不要新开控制台窗口」，不改谁来杀谁、杀的是哪棵树（`taskkill /T` 本来就带 `windowsHide`，那一处是同一条命令），没有改变 Chrome 退出快慢的因果。
- 统计：合入前我看到的清理都是 `cleaned:true`（4 次）；合入后失败 2 次（一次是闲置结束、一次是服务关停），之后 5 次（带 `--watch-iso` 的 4 次加 1 次）都 `cleaned:true`。失败发生在机器忙的时候。次数太少，不能当比较。
- **没做的对照**：把 `worker-pool.ts` 还原成旧样子跑一遍。它在这条路径上会让每个渲染工作进程弹一个窗口，而这次要对比的是一个偶发事件，一次实验得不出结论，所以没有跑；上面的机制证明里没有哪一步依赖 `windowsHide`。其余 18 处不在路径上，还原它们对结果没有意义，也没做。主会话要的话，可以在你在场时跑，我给的 `--watch-iso` 够用。
- 「我的探针改动」「上一次被停掉留下的残留」：排除。每次探针用自己的 `mkdtemp` 目录（路径里有随机串），被停掉的那一次的目录与这一次无关；我先后改了探针的顺序（先看画面、后发计划）是为了绕开这个缺陷，不是原因（失败发生在改之前的两种顺序里）。

**根因所在与最小改法（不改产品代码，交主会话定）**

根因在 `server/hosted-render/isolation.mjs` 的 `wipeDir`：先把记号和别的东西一起删，失败时记号已经丢了。最小改法：记号留到最后，只清记号以外的每一项。

```diff
-    fs.rmSync(abs, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
+    // 记号最后才动：先清记号以外的每一项；某一项被还没死透的进程占着、清不掉时，记号还在，上层（wipeIso）重试才认得这是我们的目录
+    for (const name of names) {
+      if (name === ISO_MARKER) continue;
+      fs.rmSync(path.join(abs, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
+    }
```

（后面本来就有 `mkdirSync` 和写记号，是幂等的。diff 存了一份在 `out/wipe-fix.diff`，不入库。）

**验证过这个改法**：在工作区里临时改了、验证完用 `git checkout` 还原（`git status` 只剩探针文件）：

- `hosted-render-wipe-demo.mjs`：改后第 1～6 次 `EPERM` 但目录里记号一直在，第 7 次（占着的子进程退出后）清掉了，下一轮 `wipeDir` 成功。
- `npm test -- server/test/hosted-render-isolation.test.mjs`：6 条通过，零失败。
- 没有拿它重跑整条托管探针（失败是偶发的，重跑一次说明不了什么）；演示脚本是确定性的，这是验证它的办法。

**另一个小问题（顺带）**：`wipeIso` 遇到 `iso-not-ours` 不重试、后果是整个服务期间隔离工作进程起不来。即使改了 `wipeDir`，建议 `prepare` 失败后管理进程不要无限「同一批任务先不再试」而没有恢复路径；这属于产品逻辑，我只提醒。

**窗口检查**：这一轮的 5 次托管探针（含 3 次连跑）期间每 5 秒查一次，`OpenConsole` 始终 0，没有可见窗口（除用户自己的 chrome 18392）。

## 附二：收尾三件事（主会话追加）

### 一、`wipeDir`（只改这一个函数）

`server/hosted-render/isolation.mjs` 的 `wipeDir`：先清记号以外的每一项，记号最后才动（diff 见上一节）。用例加在 `server/test/hosted-render-isolation.test.mjs`（`HR23 清空清到一半失败…`）：模拟某一项删不掉（临时替换 `fs.rmSync`）——第 1、2 次都抛 `EPERM`（不是 `iso-not-ours`）、记号都还在；放手后再调一次清完、清完只剩记号；没有记号的非空目录照旧抛 `iso-not-ours` 且里面的东西没动；空目录、不存在的目录照旧建出来放记号。对旧实现（还原 `wipeDir`）这条用例红，现在绿。`iso-not-ours` 的恢复逻辑和别的函数没动。`scripts/probes/hosted-render-wipe-demo.mjs` 留着，文件头写明验什么。提交 `c84b3184`、`f209a959`。

### 二、指南文字修订（提交 `3004eea4`）

Gemini 终稿 25 条、盲写 18 条，逐条先对代码再定。**只改文字和组织，没有改规矩**；规矩与例子矛盾的地方以代码实际行为为准。

结构变化：第 3 节末加「3.1 例子：价格标签」（原 4.2 的例子前移）；第 4 节改成 4.1 字段说明（加 `CardDef` 形状）、4.2 默认值规则、4.3 素材效果卡路线、4.4～4.7 不变；「有声动效卡与持久声音」补成第 10 节；交叉引用全部改过，并新加 GA-08、GA-09 两条测试：每一处「第 N.M 节」都必须指向真有的标题。

**Gemini 25 条**

| # | 意见 | 处理 | 理由（对着代码核过的事实） |
|---|---|---|---|
| 1 | `t` 的时间基准两处说法不一 | 采纳，改写 | `Stage.tsx` 第 279、383 行：有 `audio()` 的卡 `t` 等于片段本地秒加 `clip.sourceOffset`，没有 `audio` 的就是本地秒。第 2、7、10 节三处写成一致的话；Gemini 的「源时间」没有照抄 |
| 2 | 「2D 动效卡」收得过窄 | 部分采纳 | 所有卡建卡时都必须写 `frameMode`（`checkCardSource`），但语义上两种写法是针对动效卡定的；写成「PromptCut 的卡都在两种写法里二选一（动效卡、素材效果卡一样）」 |
| 3 | 表格「只用框架」与素材效果卡不需要引用框架冲突 | 采纳，改写 | 检查只要求引用名单内的模块，不要求引用框架（GA-01c 例子证明） |
| 4 | 偏向性句子 | 采纳，改成中性 | 三处：「内置卡大多是这一种…不要求改写」改成「两种写法的都有，都不用改写」；「要跳到哪一帧都一样用 remotion 式」改成只陈述 `random(种子, 序号)` 只依赖种子和序号；「从 motion 式改成 remotion 式按新建算」改成两个方向都说（乙的〔裁 6〕：反过来不再归 2.4 的检查管）。「怎么选」一段加一条中性的「两种都写得出来时差别就是怎么写和代价」，GA-06 钉住 |
| 5 | 第 3 节缺完整例子 | 采纳 | 价格标签前移到 3.1；GA-01 按「完整卡片」标记抽，仍是 7 个 |
| 6 | 第 3 节「见 4.5 节」写错 | 采纳 | 属实，改 4.6 |
| 7 | 例二缺 `timing`（代码未验证） | 采纳，用自己验证过的代码 | 没用 Gemini 的式子（它把 `+0.3` 加在外面、没带 `count`）。夹具 `rs-bar-race.tsx` 加 `timing`：`staggerDuration(count, { each: 0.06, from: "center" }, 1.0)`（柱长高 0.7 秒加起伏淡入 0.3 秒），静态 `lifecycle.settleMs` 改 1400；指南例子与夹具逐字对齐（GA-01b）。夹具相关测试重跑通过 |
| 8 | 例一弹簧常量写在顶层 | 采纳「方案 B」 | 检查不强制哪些值做成参数；2.1 与第 5 节统一成：使用者会调的值做成参数，卡自己的设计常量（缓动形状、弹簧刚度阻尼、上移距离）可以写成文件开头起了名字的 `const`，并写明不是检查强制的 |
| 9 | `beginFrameWork` 例子依赖数组含 `t` | 采纳，改了例子 | 原例子每一帧新建 `Image` 再 `decode`，确实浪费。改成 `useMemo` 按 `src` 缓存图片对象、effect 依赖 `[img, t]`、清理里退票并加 `stale` 标记；GA-05 把这段放进卡里过建卡检查 |
| 10 | 拦截范围多处不一 | 采纳，列全 | 对着 `checkCardSource` 核：create_card 直接拒绝的是三条老规矩（motion 式是文本匹配，注释里写出这几个词也会被拦）、审查表各类、`compositing: 'independent'`、缺字段、语法错误；`new Date()` 新建时不拦、改内置卡时才拦。第 6 节开头重写 |
| 11 | `pingPong` 返回范围 | 采纳 | 代码：`loop` 返回 [0, period)，`pingPong` 返回 [0, period]；GA-04b 钉住 |
| 12 | 领票还票对应不清 | 采纳 | 领票 `beginFrameWork`，就绪 `ready.ready()`，失败 `ready.fail(e)`，退票 `ready.dispose()`（`frameReady.ts`） |
| 13 | motion 式检查「只查硬约束」过轻 | 采纳 | 改成「硬约束与通用合规：必填字段、没装的依赖、动画 class、许可证等（第 6、8 节）」 |
| 14 | three 为什么归 motion 式 | 采纳，写事实 | `scene-3d` 声明 `stateful`；three 不在 2.5 节名单里，用名单外的库的卡只能声明 `stateful`，不要求真的累积状态 |
| 15 | 哪些卡读 `t` | 采纳 | 三维卡、按帧号定位的 `lottie-web` 卡（`lottie.tsx` 把 `t` 换算成帧号）也读 `t`；第 3、7 节改 |
| 16 | 「`t` 是可选属性」 | 采纳 | 改成「`CardProps` 里 `t?: number`，所以解构写 `t = 0`；但 remotion 式的画面就是 `t` 的函数，一定要读」 |
| 17 | 禁止写 `params` 是否适用于 motion 式 | 采纳 | 是通用做法，不是 remotion 式专属；第 7 节写通则，2.6 加指向；检查不强制，写明是写法上的要求 |
| 18 | 第 1 节出现 `CardDef` 术语 | 采纳 | 改成「卡片定义对象（导出的 `CardDef`，字段见第 4.1 节）」 |
| 19 | 同目录文件、样式文件限制不显眼 | 采纳 | 2.4 表格第一行点明；核过 `./xxx`、`./x.css` 都落在 `import` 规则里；GA-02 对照表的键同步改 |
| 20 | `extrapolate` 的合法值 | 采纳 | 只有 `"clamp"`（缺省）和 `"extend"`，没有 Gemini 问的 `identity`（`interpolate.ts` 的类型） |
| 21 | 第 4 节先通用后特殊 | 采纳 | 字段说明前移成 4.1 并加 `CardDef` 形状；默认值规则跟在后面；素材效果卡路线后移 |
| 22 | 同片段视觉与 `audio` 共存的冲突 | 采纳，澄清 | 两件事：同一张 `CardDef` 里写视觉出口加 `audio()`（有声动效卡，片段上是 `clip.cardId`）允许；时间轴上同一片段同时挂纯音频素材效果卡（`kind: "audio"`，`clip.nodeId`）和视觉素材效果卡不行，它们是两个节点。写明了，没有新增规矩 |
| 23 | 「第二档」「第三档」没解释 | 部分采纳 | 报错里原样带 `[第二档·管线暂不支持]` 这样的标签（`TIER_LABEL`），表里不能删，否则对不上报错。加说明：这是内部编号，没有「第一档」，三条老规矩的报错不带标签；表头「档位」改「类型」 |
| 24 | `create_card` 覆盖已有 id | 采纳 | `createUserCard`：已存在又没传 `overwrite` 回 409；第 8 节加「整张推倒重来才传 `overwrite: true`，见 8.1」 |
| 25 | 结尾小节缺序号 | 采纳 | 补成第 10 节，引用改过；4.3 里有声卡处指向它 |

选写法的四个测试画面：粒子球、three 图标第 1 节本来就能选；标题淡入上移两边都说得通，补了第 4 条那句中性的权衡；GLSL 滤镜，第 1 节补了 `frameMode` 怎么选的指向。

**盲写 18 条**（带〔猜〕的 9 条：1、2、4、6、7、8、10、12、16，都补了）

| # | 卡点 | 处理 | 理由 |
|---|---|---|---|
| 1 | 必填参数默认值留空还是放文案；`required` 校验的是什么 | 采纳，两边说成一致 | `validateCardParams`：校验的是 defaults、已有参数、本次写入三者合并之后的结果，所以带非空默认值的 `required` 根本不起作用。4.2 写明这一点；价格标签例子和夹具 `rs-title-reveal` 的 `text` 去掉 `required`；GA-06 钉住例子里不再有这种写法 |
| 2 | 哪些值做成参数没有线 | 采纳 | 同 Gemini 8 |
| 3 | 「写死」两头相反 | 采纳 | 第 6 节第 5 条改成「用固定像素，不用响应式单位（数值要不要做成参数见第 5 节）」 |
| 4 | `parts[].role` 取值 | 采纳 | `types.ts`：`text` / `media` / `list` / `decor` / `group`；4.4 列出，并写「不属于哪块的参数可以不写进任何部件」 |
| 5 | 根部件怎么声明 | 采纳 | `envelope.ts`：没写 `parts` 就是一个 id 叫 `root` 的根部件，所有参数归它 |
| 6 | `settleMs` 是绝对时刻还是时长；两种口径 | 采纳 | 类型注释：相对片段起点的毫秒时刻；Motion 的卡按 delay 加 duration 相加，remotion 式的卡用 `springDuration` / `staggerDuration`（准） |
| 7 | `hold` / `loop` / `evolve` | 采纳 | `types.ts` 注释：hold 停住、loop 循环重播、evolve 一直在变；脉动写 `evolve` |
| 8 | `color` 控件格式；认不出怎么办 | 采纳 | 界面产出 `#rrggbb`（`ParamsForm.tsx` 的 `type="color"`）；`update_clip` 不校验格式；`interpolateColors` 认不出会抛错，写进第 5 节，建议 `hint` 写明 |
| 9 | `min`/`max`/`step` 是约束还是提示 | 采纳 | `ParamsForm.tsx` 只在界面里夹；`cardParams.ts` 只校验是不是数字，不夹值。写明「组件里要自己夹」 |
| 10 | `tween`、`staggerDuration` 签名 | 采纳 | `tween` 的 `duration` 没有缺省，不大于 0 时 `t ≥ delay` 就是 `to`；`staggerDuration` 把 `delay` 算进去；GA-04b 钉住 |
| 11 | HUD 只给了名字 | 采纳 | 读 `hud.ts` 补：`position` 四个取值、缺省值、`getPositionClass` / `accentOf` / `easeExpoOut` 各是什么，并写「不是必须用」 |
| 12 | Motion 只有一个例子；无限循环在导出里行不行 | 部分采纳 | 写：其它写法（spring、关键帧、delay、repeat）照 Motion 文档；`pinAnimations.ts`：虚拟时钟管 Motion 帧循环，CSS 与 Web Animations 钉在「舞台时间减去出现时的舞台时间」，所以无限循环的相位只由时间决定，落定后写 `loop` / `evolve`。没有再展开 Motion 教程 |
| 13 | motion 式哪些会被拒，三处口径不齐 | 采纳 | 同 Gemini 10、13 |
| 14 | 检查是语法树还是文本匹配 | 采纳 | remotion 式的检查是语法树（注释不拦，字符串里的 `animate-*` 等会查）；motion 式老三条是对原文的正则（注释里写出也拦）。2.4 加一条 |
| 15 | `Component` 「三选一」与「至少一个、可同时」矛盾 | 采纳 | 改成「`Component` / `card` / `audio` 至少写一个；`card` 与 `Component` 二选一，`audio` 可单独或同写」 |
| 16 | 固定几行文字用列表参数还是几个参数 | 采纳，一句 | 第 5 节：条数固定的做成几个 `text` 参数，不固定才用分隔格式 |
| 17 | `useWhen` 要先知道近义卡 | 采纳 | 字段表加「不知道有哪些近义卡就先 `list_cards()`；拿不到就写清做什么不做什么，不要引用没确认过的卡 id」（`stat-proof` 查过确实存在，例子保留） |
| 18 | 没有完整的类型定义 | 采纳 | 4.1 加 `CardDef` 的形状（可选性来自 `types.ts`）；`lifecycle.exit` 写「目前写 `["fade"]`」（类型里另有 `"reverse"` 没实现）；`timing.parts` 可以只写会变的部件；`hint` 四种控件都可写；`asset` 控件是素材封装卡用的 |

没有「不采纳」的条；三条「部分采纳」（Gemini 2、23，盲写 12）的缘由见表。没有碰规矩：所有新增的句子都是对现有检查与类型的陈述，一部分事实在 GA-04b、GA-06、GA-08、GA-09 里钉了。

### 三、盲写脚本的判据（提交 `3c02e30d`）

**核实：主会话的判断对了一半。** 卡本身没问题，但差的像素不是「不透明度淡入」造成的。

- 用盲写的 `blind-counter` 在第 20、45、90 帧各比一次：新页与同页的 **DOM（innerHTML）和每个元素的计算样式逐字相同**（三个检查点都是）。
- 去掉所有不透明度淡入（`opacity` 全写成常数）再比，新页对同页仍差 13、59、52 个像素；两个**全新的页面彼此之间**也差（有淡入 16、32、0；无淡入 0、15、14）。所以差异来自 Chrome 每个页面各自的文字光栅化与合成历史（大数字字形边缘），与卡读没读前一帧无关。读了前一帧会差成百上千个像素（有状态对照卡差 13619）。
- 同页顺着渲对倒着跳在每个检查点都是 0。

判据改为：同页顺着渲对倒着跳必须 0；新页直接渲对同页允许不超过总数十万分之五（1920×1080 是 103 个）且最大通道差不超过 2。输出里照样打印实际的像素数和最大通道差，判据与原因写在文件头。

用盲写的两张卡重跑（`blind-counter` 与 `blind-toast`）：退出码 0。两张卡 `POST /api/cards/create` 都回 200；`blind-counter` 第 0、7、20、45、90 帧：同页顺着对倒着 0、0、0、0、0；新页对同页 0、4、17、28、52 个像素，最大通道差 0、1、2、2、2（容差 103 个、2）；`blind-toast` 顺着播 10 步，画面从透明涨到 162524 个像素，最后一帧不空。夹具卡 `rs-title-reveal` 加价格标签重跑也是退出码 0（全 0）。

### 交活前

| 项 | 结果 |
|---|---|
| `npx tsc -b --force` | 退出码 0，输出为空 |
| `npm test`（两个环境变量照旧） | 5560 条，通过 5555，失败 1，跳过 4。失败的是 `account-password-user-path`「改密退出只保留发起网站会话…」：日志是 `EADDRINUSE 127.0.0.1:6680`（别的会话占着的端口）；单独重跑两次，1 条通过、零失败。没有改松任何测试 |
| `card-source-version-compare --base main` | `changed:[]`、`identityChanged:[]`，没变（base `main@644e7b38`） |
| windows-hide 守门测试 | `server/test/windows-hide-silent-spawn.test.mjs` 4 条通过；也在全量测试里过了 |
| 可见窗口 | 全量测试期间每 5 秒查一次，结束后再查：`OpenConsole` 0，除用户自己的 chrome 18392 外没有可见窗口；7450～7459 无监听 |