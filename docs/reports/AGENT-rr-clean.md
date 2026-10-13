# AGENT 报告：rr-clean（干净版那一次合入）

分支 `claude/rr-clean`，工作区 `.worktrees/rr-clean`，从 main `369c834e` 建，2026-10-13。期间并过三次 main（最后一次是 `5ad05da7`，带着 `claude/rr-lottie`）。不推送、不合并。

几个词：

- **那十个公共文件**：`src/kernel/types.ts`、`frameMode.mjs`、`cardGraph.mjs`、`emphasis.ts`、`cardGpu.ts`、`src/render/cards/gpuExecutor.ts`、`src/kernel/soundEffects.ts`、`typingEvents.ts`、`src/cards/native/sound-effects.ts`、`av-pulse.tsx`。它们在每张内置卡的源码闭包里，改一个字，内置卡的预渲染结果的键全变，已生成的卡片声音被判「已过期，请重新生成」一次。
- **源码版本**：一张卡的定义文件连同它一路导入到的文件的全文（`src/render/cardSourceVersion.mjs`），进预渲染结果的键和卡片声音的身份。
- **能力对象**：`cardCapabilities` 的返回（写法、要不要预渲染、依不依赖下层、是不是画布卡、能不能进独立缓存），整个进卡片身份的摘要。
- **守门测试**：`src/render/audioCardSourceVersion.test.mjs`，钉着三张内置有声卡的源码版本和闭包文件清单。
- **第 14、15、16 条**：`docs/plan/user-decisions-2026-10-13.md` 第 1 节那张表的行号。

## 做了什么

这一次合入里**那十个文件只动了一个**：`src/kernel/frameMode.mjs`。

### 1. 干净版（提交 `b0a41955`）

`cardCapabilities` 里「审阅表写了 `frameMode` 就盖过卡的声明」那一句删了，写法只取 `cardFrameMode(def, params)`。表里照旧不许出现 `frameMode` 这个键，守门测试 `src/cards/capabilities.test.mjs` 的报错文字跟着改。

改的文件：`src/kernel/frameMode.mjs`、`src/cards/capabilities.test.mjs`。

### 2. 画布卡由 `surface` 推出（提交 `7a441095`，类型声明补在 `7a4d00c6`）

- `src/kernel/frameMode.mjs` 新增 `reviewedCanvas(id)`：审阅表的 `surface` 是 `canvas2d` 或 `webgl` 就是画布卡；表里没有这张卡返回 `undefined`。`cardCapabilities` 的画布卡一项改成「表说是画布卡，或卡自己写了 `canvasHeavy`」。和原来逐张等价：原来表里不是画布卡的条目同样落到卡自己的声明上。
- `src/cards/capabilities.json` 里四处 `"canvasHeavy": true` 删掉（`particles`、`particles-*`、`r6-canvas`、`scene-3d`）。
- 读表里 `canvasHeavy` 的别处一起改：`src/editor/swapCost.ts`（改用 `reviewedCanvas`）、`server/vision-project.mjs`（`surface` 缺了不再回退到 `canvasHeavy`）、探针 `scripts/probe-card-costs.mjs`、`scripts/probes/snapshot-size-probe.mjs`、`swap-cost-probe.mjs`、`stream-canvas-direct-probe.mjs`。
- 守门测试改成表里不许再写 `canvasHeavy`（写 true、写 false 都报）；加了两处判画布卡一致的断言。
- `src/cards/capabilities.md` 第 3 节改写成「这两处是怎么收掉的」，第 1、2、9 节相关的句子跟着改。
- `src/kernel/frameMode.d.mts`：补 `reviewedCanvas` 的声明，审阅表条目的类型改成现在登记的三样。这个声明文件不在卡片的源码闭包里。
- `scripts/probes/card-table-digest-compare.mjs` 加开关 `--caps-only`：只核能力表、注册表里的定义、定源码的键三栏。原因：这支探针不带它时，源码版本一变就算「变了」退出码 1，而这一次本来就要让源码版本变。

### 3. Easing 四个别名、spring 两种报错（提交 `a36b9608`）

照 `docs/plan/html-snapshot-removal-dryrun.md` 第 8.3 节的原文，只添加。

- `src/kernel/remotionStyle/easing.ts`：`circle`（和 `circ` 是同一个函数）、`exp`（和 `expo` 是同一个函数）、`ease`（贝塞尔 `(0.42, 0, 1, 1)`）、`poly(n)`；`poly` 的次数不是有限的数时报错，文案照原文。
- `src/kernel/remotionStyle/spring.ts`：第一个参数不是数直接抛；第二个参数里出现 `frame`、`fps`、`config` 直接抛；`springDuration` 对第二种同样检查。两句文案照原文，〈类型〉填「对象」「字符串」「undefined」「NaN」「null」等。
- `ease` 的曲线：本机 `node_modules` 里没有 Remotion，没法对它的源码。我凭 React Native 和 Remotion 的 `Easing.ease` 都是 `bezier(0.42, 0, 1, 1)` 的记忆采用了任务书给的四个数，另用二分法独立反解这条贝塞尔算了五个点，和实现差在 1e-6 以内，钉进了单测。**「Remotion 的 `ease` 就是这四个数」这一句仍然没有对过源码。**
- 单测 `src/kernel/remotionStyle/remotionStyle.test.mjs` 加两条；建卡指南 `server/card-authoring-guide.md` 第 2.1 节的工具表加四个名字和 spring 的说明。

### 4. 堵缺口：remotion 式的卡必须引用框架（提交 `09a2024f`）

- `server/remotion-style-check.mjs` 加规则 `framework`：声明成 remotion 式、没有一句会留到运行时的框架导入就拒绝，报错指到 `frameMode: "direct"` 那一行，文案照第 8.2 节的草稿。只带类型的导入不算（`import type …`、`import { type X } …` 两种写法都不算）。
- 口径照任务书：新建的卡、原来引用了框架的卡、从 motion 式改成 remotion 式的卡，拒绝；改一张框架出现之前建的、没引用框架的老卡不强求。这是靠原有的「老卡只拒这次新增的违规」那条差量口径自然得到的，没有另写分支。
- 建卡指南：第 1 节「怎么写」那一行、第 2.4 节的拒绝表加一行、第 2.5 节名单、第 4.3 节那句「不需要引用框架」改成要引用；第 4.3 节三个素材效果卡例子各加一行裸导入。
- 夹具：`server/test/fixtures/remotion-style/` 加违规样例 `violations/framework.tsx`、合规样例 `rs-bare-import.tsx`；`violations/css-animation.tsx`、`violations/motion.tsx` 各加一行裸导入（它们各自只该违反一条规则）。
- 单测：`server/test/remotion-style.test.mjs` 加 RSC-10；`server/test/card-authoring-guide.test.mjs` 的对照表加一行、三个例子的断言改成「有裸导入、去掉就被拒」；`src/online/cardRuntime/remotionLock.test.mjs` 加 RL-08。
- 第 8.2 节两处没查清的，都补了单测并查清了：
  - 在线页面转译那一侧（`remotionLock.mjs`）**认裸导入**：把它当「只为副作用的导入」，算引用了框架，照样锁。
  - 只有 `audio()` 的卡在声音线程里载入时**同样接锁**：声音线程用的是同一个打包函数和同一个加载器；单测里往锁住的顶层对象写，这一块回的是错误，不是悄悄带着状态。
- 探针里经过建卡检查的夹具：按字样搜到的十几支里，真的经建卡或改卡接口的只有四支。`framework-card-pipeline-probe.mjs` 本来就引用框架；`card-overlay-probe.mjs`、`card-sync-probe.mjs`、`c66-t9-probe.mjs` 三支的建卡夹具各加一行裸导入。其余的（`online-card-*-probe`、`video-source-cadence-probe`、五支 `verify-*`、两个夹具文件）不经建卡检查，没动。
- 它不让已有的卡换键：没有动任何卡片或框架的运行时文件。

### 5. 并入 `claude/v18-missing`（合并提交 `d20c22f3`）

`git merge --no-ff claude/v18-missing`，**文本上没有冲突**。两边都改过的文件只有 `server/account/authority.mjs`，改在不同的地方，自动合上。任务书点名的 main 今天动过的三个文件（`server/recovery/http.mjs`、`src/editor/io/procp.ts`、`src/editor/sync/CollabSection.tsx`）那条分支没有改，不冲突。

它也**没有动那十个公共文件**。它让所有卡的快照键变，是因为它改了 `src/render/` 下的文件，生成快照的代码指纹跟着变（见「换键的卡」）。

语义上的核对见「验证结果」。合并之后做的两处小改：

- 提交 `50ddc736`：main 上 `accept-018-files-proc-damage.test.mjs`、`accept-018-files-recovery-states.test.mjs` 有四条标了 `todo` 的用例（ACC018-DMG-5、DMG-6、STATE-4、STATE-5），文件头写着「分支 claude/v18-missing 改了这两处；合入后这两条应转绿，届时去掉 todo」。并入后它们确实转绿，我照那句话把 `todo` 去掉了。
- 提交 `fcf3af00`：`scripts/probes/cross-machine-proc-probe.mjs` 导出前先等预渲染进程就绪，报「没就绪」时退避重试最多三次。原因见「验证结果」的跨机器探针。

信任表 `server/recovery/gone-proof.mjs` 的 `TRUSTED_GONE_AUTHORITIES` 没有动，仍是空的。

### 6. 并 main 时解的一处冲突（合并提交 `8f6fe58a`）

`claude/rr-lottie` 合进 main 之后，`server/card-authoring-guide.md` 第 1 节「怎么写」那一行两边都改了。解法：以 main 那一侧的整段为底（它在 motion 式那一格加了 Lottie 的说明，「适合」那一行去掉了 `lottie-web`），把 remotion 式那一格里的「不一定要引用框架：……也写 `"direct"`。」换成我这边的「**必须有一句引用框架的 import**：……用不到工具就写一行裸导入」。两边的话都在。

## 验证结果

### 能力对象不变（1～4 做完、并入 `claude/v18-missing` 之前）

`node scripts/probes/card-table-digest-compare.mjs --base main --expect , --caps-only`，退出码 0：

```
内置卡:改前 101 张,改后 101 张;逐张相同 59 张,有变化 42 张
只核能力表这一路:能力表变 0 张 / 注册表里的定义变 0 张 / 键(定源码)变 0 张 / 源码版本变 42 张 / 键变 42 张
✔ 能力表、注册表里的定义、键(定源码)三栏:除 --expect 里的 0 张外一张没变
```

生成快照的代码指纹改前改后相同。不带 `--caps-only` 时同一条命令退出码 1（42 张卡的源码版本和键变了，这正是预期）。

### 并入之后、并了最后一次 main 之后（基准 main `5ad05da7`）

同一条命令加 `--json`，退出码 1：

```
生成快照的代码指纹:改前 5974bb911f19f320ff157257abd66a60 改后 696ae608c6b2eb262d46e21baa3847b5(不同!)
只核能力表这一路:能力表变 0 张 / 注册表里的定义变 0 张 / 键(定源码)变 101 张 / 源码版本变 42 张 / 键变 101 张
```

按键分开数（从 JSON 里数的）：节点身份变 42 张、成本键变 42 张、快照内容键变 101 张；把源码版本定住以后，节点身份和成本键 0 张变，快照内容键 101 张变。也就是：**能力对象仍然一张没变**；`claude/v18-missing` 带来的只有「生成快照的代码指纹」这一路，它让全部 101 张卡的快照内容键变；源码版本这一路仍是那 42 张，`claude/v18-missing` 没有多带一张。

`node scripts/probes/card-source-version-compare.mjs --base main`，退出码 1（预期：这支探针的通过标准是一个都不变）：

```
{"step":"versions","base":88,"head":88,"changed":77,"added":0,"removed":0}
{"step":"identities","base":61,"head":61,"changed":0,"added":0}
```

88 个入口文件里 77 个的源码版本变了：`src/cards/native` 31、`src/parts/lib` 26、`src/cards/magicui` 6、`src/cards/_probe` 6、`src/cards/assets` 2、`src/cards/user` 2，另有四个索引类文件。服务端的代码身份 61 个里 0 个变。并入前后这两行数字相同。

### 换键的卡

- **源码版本变的 42 张**（它们的节点身份、成本键、快照键都变）：按 id 找得到自己源文件的内置卡。自家卡 26 张（`composite` 之外的全部，含三张有声卡 `av-pulse`、`sound-notification`、`sound-keyboard`）、MagicUI 5 张、探针卡 11 张。原因只有一个：`src/kernel/frameMode.mjs` 变了。
- **源码版本没变的 59 张**：58 张素材封装卡（Lottie 5、粒子 53）和组合卡 `composite`。和预期一致。并入 `claude/v18-missing` 之后它们的快照内容键也变了（代码指纹那一路），节点身份和成本键没变。
- **用户卡**：引了 `../../kernel/types` 的用户卡，源码版本同样变（随仓库带的 `mu-animated-shiny-text` 在变了的 77 个入口里）。引了框架 `../../kernel/remotionStyle` 的用户卡，因为第 3 项改了 `easing.ts`、`spring.ts`，同样变。
- `claude/rr-lottie` 让 7 张卡换键，已经在基准 main 里，不算在上面。

**卡片声音过期的范围**：三张内置有声卡已经生成的声音，和带声音的用户卡的（它们的源码版本都变了）。预览里提示「已过期，请重新生成」，导出开始时自动重新生成。素材封装卡和组合卡没有声音，不涉及。

### 守门测试（最后一个提交）

`src/render/audioCardSourceVersion.test.mjs` 改了四个钉值，另在文件头加了一段改动记录：

| 钉的是什么 | 原来 | 现在 |
|---|---|---|
| `av-pulse` 的源码版本 | `c3404bf5…` | `535ba03a7f19c0270c176c9bdbe84b4e698f8ae9bc2f75a6266431830d996e92` |
| `sound-notification` 的源码版本 | `7e159196…` | `1a663d9c7b086d16d9988114246eb4e876f375845d2d1f4e248f63b9fb431a81` |
| `sound-keyboard` 的源码版本 | `7e159196…` | 同上（两张共用一个入口文件） |
| `/src/kernel/frameMode.mjs` 的全文哈希 | `008d7ccc…` | `45b246838e3a3d571e9cdcb2f869d257de0d6c78bbd44b94ccc3cbe392b2da31` |

**闭包的文件清单没有变**：并入 `claude/v18-missing` 之后跑这支测试，三张卡「闭包里的文件没多没少」那三条仍然通过，红的只有三条源码版本，报的变了的闭包文件只有 `/src/kernel/frameMode.mjs` 一个。另外九个文件的哈希没动。

### `claude/v18-missing` 自己的验收重跑

单测（并入后单独跑的一遍，`npm test -- <文件…>`，退出码 0）：它报告里列的七个文件加它带来的其余测试、0.7.18 的文件验收、分层守门、静默起进程守门，共 126 条，122 过、0 失败、4 条 `todo`（就是上面去掉 `todo` 的那四条，当时已经是通过的）。

探针：

- `node scripts/probes/v18-missing-probe.mjs --port 27960 --doc-port 27970 --dead-port 27979`：退出码 0，`fails: []`。导出：没有片段被跳过，5 个片段都在；占位帧均值 37.5、标准差 4.6，正常画面标准差 64；丢失的旁白那一段 -24.3 dB，放完以后 -120 dB；重开时对假文档服务的请求数 1 → 2 → 2。离线改过那一格转换后序列是 `序列 1、序列 2、画面、配音、离线加的序列`。坏文件七种都报错。这一遍是并入之后、并最后一次 main 之前跑的；最后一次 main 带进来的 `claude/rr-lottie` 只动 Lottie 卡，没有重跑。
- `node scripts/probes/v18-missing-online-probe.mjs --base 27984 --doc-port 27981 --asset-port 27982`（先 `npx vite build --mode online`，退出码 0）：退出码 0，`fails: []`。在线导出占位帧均值 35.9、标准差 7.4 / 7.5；缺失的旁白那一段 -21.2 dB，之后 -120 dB；设了静音的缺失视频那一段 -120 dB。这一遍是在最终的树上跑的。
- `node scripts/probes/cross-machine-proc-probe.mjs --port-a 27960 --port-b 27963 --port-c 27966`：**前三次退出码 1，第四次退出码 0**，如实记：
  - 第一次：实例 C 从顶栏导出，报「导出页 60 秒没就绪(window.__pcReady 一直不是 true)」。
  - 第二次：同一步报「预渲染进程还没就绪,这一项要它才能完成。」
  - 第三次（我给 C 的导出加了「报没就绪就退避重试」之后）：更早的一步，实例 B 的导出报同一句「预渲染进程还没就绪」。
  - 第四次（B、C 导出前都先等 `/api/prerender/info` 回就绪）：退出码 0，`fails: []`，导出一次就成（输出里 `exportAttempts` 只有一条「导出完成」）。0.5 s、2.5 s 标准差 63.6 / 63.5，1.5 s 均值 37.4、标准差 3.9（占位）；2.05 s 起那一截 660 Hz、-24.5 dB。
  - 我的判断：前三次是实例刚起、预渲染进程或导出页还没就绪（通用规矩里记的已知老问题），不是缺素材那条路的毛病。依据：失败的是 B 的普通导出和 C 的导出两处，报的都是「没就绪」；同一棵树上桌面探针的导出一次就过。**没有查实的**：第四次等待只用了 2 毫秒就回了就绪，所以「先等就绪」这一改是不是它转绿的原因，我说不准；当时机器处理器占用只有 16%，也不像是忙。三次里第一次的「导出页 60 秒没就绪」我没有找到根因。主会话合入前跑导出像素基线时如果又遇到，值得单独查。

看过的图（桌面探针这一遍生成的）：`04-preview-missing-visual.png`（预览 6 秒处，深色底白字「找不到素材丢失的镜头-….mp4」，左下角没有「等待上传方」角标，字很小）、`06-export-frame-missing-visual.png`（导出成片那一帧，1920×1080，同一句占位，中文没有乱码）。其余的没有逐张看。

### 画面不变

自己起的开发服务器在 27990（带 `PROMPTCUT_NO_PORT_FILE=1`），最终的树上：

- `node scripts/verify-determinism.mjs --url "http://127.0.0.1:27990/?export=1"`：退出码 0，`Total Frames: 1800 / Identical: 1800 / Different: 0`。
- `node scripts/verify-unified-frames.mjs`（`PC_FRAME_TEST_URL` 指到同一台）：退出码 0，`PASS: no video during B; all HTML frames; exact video seek; random replay; cache hits; cumulative C equals A; PNG table and frames/ hold all 10 frames; no preview.mp4 / full.mov.`

另外 `node scripts/probes/card-overlay-probe.mjs --port 27960`（第 4 项做完后）：退出码 0，`fails: []`，带裸导入的卡经真的 `/api/cards/create` 建得出来。`card-sync-probe.mjs`、`c66-t9-probe.mjs` 只加了那一行，没有跑。

### 基线

- `npx tsc -b --force`：退出码 0，零输出（最终的树上）。中途有过一次红：第 2 项做完时 `src/editor/swapCost.ts` 报找不到 `reviewedCanvas`，因为类型声明 `frameMode.d.mts` 没跟着改，补上后零错误。
- `npm test`（设了那两个环境变量）第一遍，1～4 做完、并入之前：退出码 1。6488 条，6448 过，20 失败，2 取消，12 跳过。失败的在 8 个文件里：
  - `src/render/audioCardSourceVersion.test.mjs` 3 条：预期的，那时钉值还没更新。
  - `server/test/cloud-tools-w1-browser.test.mjs`（15 条）、`account-master-production`、`account-runner-process`、`asset-project-workers`、`c66-integ`（一条 60 秒超时）：都不是这一块动过的地方。
  - 另三个文件（`accept-018-files-proc-damage`、`accept-018-files-recovery-states`、`accept-018-rest-ssr-seam`）在日志里出现的是标 `todo` 的用例，不算失败。
  - 把守门测试之外的这些文件单独重跑：`npm test -- <8 个文件>`，退出码 0，56 条，0 失败。
- `npm test` 第二遍，最终的树上（钉值已更新）：见文末「最后一遍全量」。

### 行尾、窗口、进程

- 可见窗口：每次跑探针前后查，都是 0 个。
- 端口：都在 27960～27999。开发服务器（27990～27992）验完按进程号连进程树停掉；交活时这一段没有监听。
- 没有碰 5190～5192 等保留端口，没有结束不是自己启动的进程。

## 没做成的及原因

1. **`card-sync-probe.mjs`、`c66-t9-probe.mjs` 没有跑**。它们要两台编辑器或协作环境，只做了加一行裸导入的静态改动。
2. **跨机器探针前三次失败的根因没有查实**，见上。
3. **Remotion 的 `Easing.ease` 没有对过源码**，见第 3 项。
4. `claude/v18-missing` 报告里「没做成的」那些（账号项目的文件不带关联、两格只有单测、真实旧文件验收、不是装好的桌面壳、人声没人听过等）原样还在，不归这一块。
5. 导出像素基线照指令没跑。

## 我做的裁定〔裁〕

1. 〔裁〕**允许裸导入**（`import "../../kernel/remotionStyle";`）算引用框架。这是 `html-snapshot-removal-dryrun.md` 第 8.2 节里写明的那一处小裁定，用户第 15 条选甲时已经带着它。
2. 〔裁〕**从 motion 式改成 remotion 式的卡按新建算，没引用框架就拒**。任务书只写了「新建的卡、原来就引用了框架的卡拒绝；老卡不强求」，没有写这一种。我按检查里原有的口径办（改声明按新建算，别的规则也是这样）。
3. 〔裁〕**只带类型的导入在检查里不算引用，但载入时照样会上锁**（`remotionLock.mjs` 认说明符，不分是不是只带类型）。两处判据在这一种写法上不完全相同：检查更严。后果只是这种卡建不出来，不会出现「建得出来却不上锁」。没有去改 `remotionLock.mjs`。
4. 〔裁〕`cardCapabilities` 的画布卡一项保留了「表里不是画布卡的，再看卡自己写的 `canvasHeavy`」。任务书说的是「改由 `surface` 推出」；完全只看 `surface` 的话，不在表里的用户卡自己写的 `canvasHeavy` 就失效了，能力对象会变。为了「能力对象不变」保留了原来的回退。
5. 〔裁〕去掉了 main 上四条用例的 `todo`（见第 5 项），依据是那两个测试文件头自己写的话。
6. 〔裁〕给 `card-table-digest-compare.mjs` 加了 `--caps-only`，给 `cross-machine-proc-probe.mjs` 加了等就绪和重试。都是探针，不进产品。

## 对任务书或语义的更正建议

- `docs/plan/html-snapshot-removal-dryrun.md` 第 8.1 节写「`frameMode.mjs` 那一个文件的全文哈希」「闭包的文件清单不变」，属实。它另写「按 id 找得到自己源文件的 42 张内置卡」，属实（实测 42）。
- 任务书说 `claude/v18-missing`「动了上面十个文件里的几个」「落后 main 两百多个提交，要你解决冲突」。实测：它**没有动那十个文件**，和 main 也**没有文本冲突**；它让全部卡换的是快照内容键（代码指纹一路），不是源码版本。所以**它本身不让卡片声音过期**；卡片声音过期一次只来自 `frameMode.mjs` 和 `remotionStyle/` 的改动。`docs/plan/render-refactor-progress.md`「用户已经定的」第 2 条里「10 个源码版本变」我没有复现出来（并入前后源码版本变的入口数都是 77，卡都是 42 张）。
- `docs/semantics/` 没有动。`mechanism/cards.md`「三个划分轴」如果写着表里有 `canvasHeavy` 这个字段，合入时要跟着改；我没有去核那一处。
- `server/card-authoring-guide.md` 第 2.4 节「另外」里原有一句「引用了框架的卡载入时……锁成只读」，现在补了「新建的 remotion 式的卡都必须引用框架，所以都会上锁」。

## 要主会话决定或注意的事

1. **发版前要填信任表**（`TRUSTED_GONE_AUTHORITIES`），照指令我没有填。
2. **导出像素基线**：没有缺素材的项目，我没有发现哪一处会让导出画面变。`claude/v18-missing` 在 `FrameScene.tsx`、`VideoTrack.tsx` 里的改动都挡在「素材带着确认缺失的记录」这个条件后面；`server/export-compose.mjs` 里只是把算摆放位置的那一行挪到了前面，值不变。确定性探针 1800 帧全同。**会变的只有带缺失素材的项目**：以前缺失的片段不画、导出时跳过，现在是一屏不透明的占位，会盖住下层（那条分支的报告「要用户定的事」第 6 条）。
3. 跨机器探针前三次失败那件事，合入前值得你那边再跑一次。
4. `claude/v18-missing` 报告里要用户定的七件事（提示文字、素材库里的名字要不要带「(缺失) 」、缺失的视频要不要出人声、占位盖住下层等）随这次合入一起进 main，还没有人定过。
5. 报告文件 `docs/reports/AGENT-v18-missing.md` 和 21 张截图随合并进了这条分支。

## 发版说明里建议写的那一句

> 这一版调整了卡片的内部结构：已经生成的卡片声音会显示「已过期，请重新生成」，需要重新生成一次；导出时会自动重新生成，不用手动处理。画面不受影响。

## 最后一遍全量

最终的树上（并了 `claude/v18-missing` 和 main `5ad05da7`，守门测试的钉值已更新），`npm test`（设了那两个环境变量）：**退出码 1**。6547 条，6532 过，1 失败，0 取消，12 跳过，2 条 `todo`。

- 失败的一条：`server/test/cloud-tools-p4-subject.test.mjs` 第 451 行的 `subject_install`，断言「不要重复启动」。不是这一块动过的地方；`claude/v18-missing` 的报告里记过它在全量里失败过两次、单独跑都过，通用规矩的偶发名单里没有它。
- 单独重跑：`npm test -- server/test/cloud-tools-p4-subject.test.mjs`，退出码 0，29 条全过。我没有去查它在全量里为什么失败；全量没有再跑第二遍。
- 两条 `todo` 是 `accept-018-rest-ssr-seam.test.mjs` 的 SEAM-1、SEAM-2，main 上原有的，和这一块无关。
- 守门测试 `src/render/audioCardSourceVersion.test.mjs`：7 条全过。
- 交活时端口段 27960～27999 没有监听，没有残留的后台 shell、开发服务器、Chrome。
