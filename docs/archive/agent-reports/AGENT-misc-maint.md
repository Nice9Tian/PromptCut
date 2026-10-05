# AGENT-misc-maint

分支 `claude/misc-maint`（起点 main `98e042d0`），worktree `.worktrees/misc-maint`。端口段 5720～5729。

三件事：

- 任务 B：在线舞台握手成功后又断——重载握不回来时退回单舞台；
- 任务 I：`cardSourceParse.mjs` 跟着 import 解析同目录用户卡文件里的控件；`select` / `asset` 缺字段的推断与提示；
- 任务 G：探针 `PC_CHROME_ARGS` 的用法说明。

## 提交

| 提交 | 内容 |
|---|---|
| `554a15ee` | 建本报告 |
| `abc89247` | 任务 G：探针文件头与 `scripts/README.md` 的 `PC_CHROME_ARGS` 用法说明 |
| `301b6d7d` | 任务 B：握手之后的看守、Preview 接线、单测 C10-SW-00～07、探针 `online-stage-watch-probe.mjs`、契约第 2 节〔裁〕 |
| `a8ae4399` | 任务 I：跨文件解析、内置模块表、同步器跟着 import 取文件、面板逐条说明、单测 CSI-01～10 / OU-06 / PV-05、契约第 9 节〔裁〕 |
| （本提交） | 报告 |

## 任务 G：`PC_CHROME_ARGS` 用法说明

只改说明文字，不改逻辑。同一句话（只把参数原样透传给探针起的 Chrome；典型用途是云端 Linux 以 root 运行要 `--no-sandbox`；不要用它关 TLS 校验，例如 `--ignore-certificate-errors`，否则对远端站点的探针在证书有问题时照样通过、掩盖真问题）写进：

- `scripts/probes/` 里用到它的 6 个探针文件头：`c10-browser-probe`、`c10a-demo-probe`、`c66-t9-probe`、`ht-w-probe`、`m7-browser-probe`、`m8-outbound-probe`；
- `scripts/README.md`：「测法」一节新增「给探针起的 Chrome 加启动参数」小节；导出参数表里 `PC_CHROME_ARGS` 那一行补「只透传,不要用来关 TLS 校验,见『测法』」。

没动 `scripts/headless.mjs`、`scripts/review-loop-run.mjs`（不是探针）和 `server/bakery/chrome.mjs`（在快照键文件表里，改了会让共享快照作废）。`node --check` 6 个探针全过。

## 任务 B：握手成功后又断

### 查到的现状

`AGENT-c10-browser.md`「没做完的」第 4 条说的「沿用原来的 iframe 重载」，实际只有一处：卡片代码没换上时整页重载那一台（`stageCards.ts` 的 `whenStagesHaveCards`）。握手之后没有任何心跳，跨源舞台的渲染进程崩了父页收不到事件、`contentWindow` 也不会关，可见舞台那一台一断，预览就一直空白。

### 做法

- `src/online/stageWatch.ts`（render 层，时钟与定时器可注入）：
  - 心跳：每 5 秒经 RPC 问每台已握手的舞台一次（Preview 用最便宜的 `size()`，舞台侧不用改）；15 秒一次回包都没有算断开。
  - 页面隐藏时不判；父页自己的定时器晚到超过 10 秒（父页主线程卡住）那一拍也不判，计时重新起算。
  - 断开 → 先照原来的做法整页重载那一台（丢掉它的 RPC 客户端、`frame.src = frame.src`）。
  - 重载后 20 秒（`STAGE_RECONNECT_TIMEOUT_MS = STAGE_HANDSHAKE_TIMEOUT_MS`）内没等到那一台的 `pc-stage-ready`，或 10 分钟内已重载 3 次又断，就调 `markStageHandshake("failed")`，也就是首次握不上手时的同一条退回路径。重载期间页面隐藏时，这 20 秒顺延。
  - 退回后看守作废，定时器全停。`markStageHandshake` 本来就不从 failed 翻回去，所以不再重载、也不再回到双舞台。
- `src/editor/Preview.tsx`：在 `ONLINE && dual` 时建看守，`pc-stage-ready` 里调 `ready(id)`；观察口 `window.__pcStageWatch()`（两台状态、重载次数、是否退回、握手状态与原因）。
- 数字都是三级参数（5 秒、15 秒、20 秒、3 次 / 10 分钟），实测见下面的探针。

### 验证

- 单测 `src/online/stageWatch.test.mjs`，8 条全过：
  - C10-SW-00：数字关系；
  - C10-SW-01：心跳正常时不重载；
  - C10-SW-02：握手后断开 → 重载 → 握回来，恢复双舞台；
  - C10-SW-03：重载也握不上 → 20 秒到点退回单舞台（`stageLayout` 为 single）；
  - C10-SW-04：退回后不反复重载，定时器清零、不再发心跳，迟到的 ok 也翻不回来；
  - C10-SW-05：反复断到第 4 次直接退回；
  - C10-SW-06：页面隐藏、父页卡住时不判，重载期间隐藏则时限顺延；
  - C10-SW-07：没握手的不看守，没有客户端不算回包。
- 探针 `scripts/probes/online-stage-watch-probe.mjs`（新写，本机托管组合 + 三源代理 + 在线构建，端口 5720～5724）。弄崩舞台用 CDP 对跨源 iframe 目标发 `Page.crash`；「源坏了」由探针代理对那台舞台源的舞台页回 503 模拟。最终构建上跑的结果 `ok: true`、`fails: []`：
  - W1：两台握手 ok，双舞台，可见舞台画出片段。
  - W2：弄崩 B，19.0 秒后重载 B，19.5 秒握回来；再等 25 秒仍是双舞台、没退回，只重载一次，编辑器页没崩。
  - W3：让 A 的源回 503 再弄崩 A（此刻的可见舞台），34.9 秒退回同源单舞台，原因「舞台 A 断开后重载,20 秒内没握回来」。退回后只剩一个舞台 iframe，在编辑器页的源 5720 上，同一时刻画回片段。截图 `w3-single.png` 看过：预览里有卡、不空白。
  - W4：退回后 60 秒里两个舞台源都没再收到舞台页请求（5721、5722 各 2 次没变），`reloads` 停在 2，握手仍是 failed。
  - 同一探针在任务 I 之前的构建上也跑过一遍，同样通过（19.2 / 34.8 秒）。

### 语义

不冲突。`docs/semantics/` 没写在线舞台的退回；契约第 2 节只写了首次握手失败的退回，这次加了一条〔裁〕（见「契约改动」）。要把它写进语义的话，dry run 见最后一节。

## 任务 I：静态解析跨文件引进来的控件

### 先查清的事

- 在线页面拿源码的路子：`onlineCardSources.ts` 经页面自己的文档服务连接 `content.list({ kind: 'card-source', prefix: 'src/cards/user/' })`，按哈希逐条 `content.get`。
- 被引文件拿不拿得到：拿得到。桌面版同步的是卡的导入闭包里 `src/cards/`、`src/parts/` 下的 `.ts` / `.tsx` / `.css`（`server/vite-plugin-cards.ts` 的 `cardSyncKeys` → `importClosure`），用户卡目录下被引的文件本来就在内容库里，键是仓库相对路径。以前页面在列表里把非入口文件过滤掉了。
- 引到仓库内置模块的：列表前缀只有 `src/cards/user/`，内置模块页面自己就带着，所以用页面里那份现成的值。

### 做法

- `src/kernel/cardSourceParse.mjs`：
  - 每个文件扫出导入表（具名、别名、默认、`* as ns`）和导出表（`export const`、`export default` 对象或表达式或标识符、`export { a as b }`、转出 `export { a } from`、`export * from`、`export * as ns from`）。
  - 求值器遇到导入的名字就跨文件求值，认 `ns.x`。跨文件的环按「文件#名字」检测，同文件的环照旧按名字检测。
  - 内置模块只收纯数据（深拷贝交出）；`pureCall` 登记的纯函数以字面量为参数时才调。
  - 仍然不执行用户源码、不 eval。
  - 新导出 `resolveSpecifier`、`importSpecifiers`、`cardSourceImports`、`controlFix`、`pureCall`、`PURE_CALL`。
  - `parseCardSource(source, { key, files, builtins })`，三个选项都可省；省了行为和以前一样。
- `select` / `asset` 缺字段：
  - `select` 的 `options` 认三种写法：`{ value, label }`（缺 `label` 用 `value`）、字符串数组、`{ 值: 标签 }` 对象。缺了或认不出照旧跳过，并写明原因。
  - `asset` 缺 `kind` 时，选项与默认值的地址都指向同一种素材目录（`/catalog/lottie/…` 或 `/catalog/particles/…`），就推断为那一种；推断不了跳过并写明原因。
- 每张卡新增 `skippedControls`：逐条记被跳过的控件（认得出的 key / label / type 与原因），例如「展开的 GONE 取不到:内容库里没有 ./gone 这个文件」「下拉缺选项(options)」。
- `src/cards/builtinSourceExports.ts`（新）：登记页面可以交出的内置模块值——`src/cards/native/hud.ts` 的 `hudControls`、`hudDefaults`、`hudOffsetControls`、`hudOffsetDefaults`，以及 `src/cards/catalogAssets.ts` 的 `assetOptions`（纯函数）。
- `src/editor/sync/onlineCardSources.ts`：
  - 列表收用户卡目录下所有 `.ts` / `.tsx` / `.mjs` / `.js`；
  - 从入口文件出发，沿相对导入取列表里有的被引文件，按哈希缓存、有环不重取、不再被引的丢掉，最多 200 个；
  - 任何一份正文变了就整份重解析；
  - `builtins` 由 Preview 注入。没被入口引到的文件不取，所以 OU-04 里「只取 2 条」照旧成立。
- `src/kernel/registry.ts`：同步条目与只读视图带 `skippedControls`。
- `src/editor/left/paramsView.ts`、`ParamsForm.tsx`：原来那句「在线浏览器模式暂不支持修改这张卡的（其余）参数」文字不变，下面加一行 `data-pc="params-skipped"`，内容形如「没认出的参数:「位置」(side):下拉缺选项(options);……」，最多列 5 条，多了写「等 N 条」。
- `cardSourceParse.mjs` 在 `src/` 下，frameCode 会变（预期之内）；它不在快照键文件表里，两个指纹不变（见下）。

### 验证

- 新单测 `src/kernel/cardSourceImports.test.mjs` 10 条全过：
  - CSI-01：同目录相对 import 的对象与数组；
  - CSI-02：各种 re-export；
  - CSI-03：别名、默认导入、`ns.x`、多级目录与 `index.ts`，以及引进来的 id / name / description；
  - CSI-04：循环引用不死循环（互相引、自引、互相 `export *`）；
  - CSI-05：引不到的几种情况照旧提示，并写明是哪一条；
  - CSI-06：内置模块的值与纯函数调用，非纯数据与函数不认；
  - CSI-07：`select` 缺字段的 8 种写法；
  - CSI-08：`asset` 缺字段的 7 种写法；
  - CSI-09：仓库语料。给了读文件的函数之后，`src/cards/native/*.tsx` 共 24 张卡里全认出的由 2 张升到 21 张，146 个控件里认出的由 105 个升到 145 个，认出的与模块里的逐个相同；
  - CSI-10：候选路径。
- `src/editor/onlineUserCards.test.mjs` 新增 OU-06：
  - 只取被引到的文件，环上的不重取；
  - 引进来的控件、`../native/hud` 经 `builtins` 进得了视图；
  - 被引文件改了只重取它；缺的文件同步上来后提示撤掉，删了又回到提示。
- `src/editor/left/paramsView.test.mjs` 新增 PV-05（逐条说明的文案）。
- 原有的 `cardSourceParse.test.mjs` 8 条、OU-01～05、PV-01～04 全过；`registrySynced.test.mjs` 的视图期望补了 `skippedControls: []`。
- 端到端：`online-user-cards-probe` 在最终构建上 `ok: true`。它没专门覆盖跨文件的卡，这一路由 OU-06 覆盖到同步器为止；Preview 里 `builtins` 的接线只有类型检查。

## 验证总表（最终提交 `a8ae4399` 上）

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，0 行输出 |
| 全量测试 | `npm test` | 第一遍：3983 条，3980 过、0 失败、1 取消、2 跳过。取消的是 `C66-I2-01`（媒体补转，60 秒超时；同一轮 `C66-T1-01` 转码用了 101 秒，是并行负载），单独重跑 `server/test/c66-integ.test.mjs` 6/6 过，这条 0.4 秒。第二遍整套：**3983 条，3981 过、0 失败、0 取消、2 跳过，退出码 0**（main 上 3963 条，新增 20 条） |
| 代码指纹 | `node -e "import('./server/frame-code.mjs').then(m=>console.log(m.snapshotCode(process.cwd()), m.captureCode(process.cwd())))"` | `00a5264bf8a062ff6e0b5ed0516cccd1 86e443cb6fa838aef64788af6822fd68`，与要求一致；快照键与捕获代码文件表里的文件一个没动 |
| 在线构建 | `npx vite build --mode online --outDir out/dist-online` | 退出码 0 |
| 用户卡探针 | `node scripts/probes/online-user-cards-probe.mjs --dist out/dist-online --base-port 5720` | 退出码 0，`ok: true`、`fails: []` |
| 握手看守探针 | `node scripts/probes/online-stage-watch-probe.mjs --dist out/dist-online --base-port 5720` | 退出码 0，`ok: true`（数字见任务 B） |

- 机器负载：同机另有子 Agent 在跑测试与探针。抽查 `Win32_Processor.LoadPercentage` 为 5%，负载是阵发的。第一遍全量测试那次超时就是赶上了负载。两个探针都是一遍过，没有重跑。
- 探针自己起的进程（托管组合、代理、Chrome）都在 `finally` 里关掉；跑完查过，5720～5729 没有监听。
- G0-R 没跑，按任务书由主会话在合流时跑。

## 契约改动（`docs/plan/c10-contract.md`，都标了〔裁〕）

1. 第 2 节「页面取舞台源」后加一条「握手之后又断」：心跳 5 秒、15 秒无回包算断（隐藏与父页卡住不判）；先重载那一台；20 秒内握不回来或 10 分钟内第 4 次断就走首次握不上手的同一条路退回同源单舞台；退回后本页会话内不再重载、不再回到双舞台；写明实现与验收探针。
2. 第 9 节「识别」那段末尾加「跟着 import 找」：
   - 同目录被引文件一并解析；
   - 内置模块用页面现成的值（登记表）；
   - 始终不执行用户源码；
   - `select` / `asset` 缺字段的补齐与推断；
   - 面板逐条说明没认出的参数，最多 5 条。

## 对语义的更正建议（dry run，交主会话定；本分支没改 `docs/semantics/`）

两条都不是冲突，是语义里没写、现在做了的事。要不要写进语义由主会话定。

**① 在线舞台握手之后又断（三级，`mechanism/rendering.md`「舞台」一节）**

- 修改前：第 11～13 行只写「舞台有两个，角色可以互换」及两台各自的职责，没写在线双舞台握不上手或断开时怎么办（首次握手失败的退回也只在契约里）。
- 修改后：在第 13 行之后加一条——「在线浏览器模式（普通档）的两个舞台跨源，握不上手，或握上之后某一台断开（心跳没有回包）、重载后又在限定时间内握不回来，就退回同源单舞台，本页会话内不再回到双舞台；预览不因舞台断开而一直空白。」时限数字留在契约或代码里。
- 级别：三级。用户只会觉察到「预览没卡死」；拿不准时按二级办，放 `product/platforms.md`「在线浏览器模式」，写成承诺句「舞台断开时预览自动退回单舞台，不一直空白」。

**② 同步来的用户卡参数面板（二级，`product/platforms.md`「在线浏览器模式」）**

- 修改前：`product/platforms.md` 没写同步卡的参数面板能改哪些参数、认不出时怎么提示（都在契约第 9 节）。
- 修改后：加一句——「内容库同步来的用户卡在在线页面照常能改参数：页面从源码（含它从同一目录别的文件、从页面自带的内置模块引进来的部分）静态读出参数，不执行源码；读不出的参数面板逐条说明是哪一个、为什么。」
- 级别：二级。用户看得到的是「能改哪些参数」和「提示写了什么」。

## 没做成的与限制

- 跨文件的**卡片对象**（入口文件只写 `export { card } from "./impl"`，卡对象在别的文件里）仍认不出。控件的值能跨文件跟，卡片识别仍只看入口文件里的对象字面量。卡对象里展开从别处引进来的对象（`...baseCard`）也一样。任务书只要求把控件拼回来，没扩到这一步。
- 内置模块只登记了 `native/hud` 与 `catalogAssets` 两个（仓库里卡片从别处引控件，实际就这两种）。别的内置模块照旧认不出，面板会说明是哪一条。要加就往 `src/cards/builtinSourceExports.ts` 里添。桌面上改过的内置文件（例如改过的 `native/hud.ts`）同步进内容库的那份，在线页面不看，用的是页面自带的原版。
- `online-user-cards-probe` 没加跨文件那张卡的端到端断言（改动大、耗时长）。跨文件这一路的证据是单测 OU-06、CSI-*。需要的话可以另派，在该探针里加一张引 `./shared.ts` 的同步卡。
- 任务 B 的数字没在笔记本上复核。15 秒断开判定对「舞台里一次同步补跑很久」留了余量，但带耗时门槛的项按 `verification.md` 以笔记本为准，本次只在 PC 上跑过（两遍都过）。

## 越出原任务书文件范围的改动

任务书没给文件清单，下面按需要动的都列出来：

- 任务 B：`src/online/stageWatch.ts`（新）、`src/online/stageWatch.test.mjs`（新）、`src/editor/Preview.tsx`、`scripts/probes/online-stage-watch-probe.mjs`（新）。
- 任务 I：
  - `src/kernel/cardSourceParse.mjs` / `.d.mts`；
  - `src/kernel/cardSourceImports.test.mjs`（新）；
  - `src/kernel/registry.ts`、`src/kernel/registrySynced.test.mjs`（期望补一个字段）；
  - `src/cards/builtinSourceExports.ts`（新）；
  - `src/editor/sync/onlineCardSources.ts`、`src/editor/onlineUserCards.test.mjs`；
  - `src/editor/left/paramsView.ts` / `.test.mjs`、`src/editor/left/ParamsForm.tsx`；
  - `src/editor/Preview.tsx`（注入 `builtins`）。
- 任务 G：6 个探针文件头、`scripts/README.md`。
- 契约：`docs/plan/c10-contract.md` 第 2、9 节。

## 主会话审查（2026-09-30，笔记本主会话）

- 审过跨文件解析：没有任何执行源码的写法（无 eval / new Function / 动态 import）；舞台看守放在 render 层、时钟可注入。
- 合流上空闲笔记本重跑 `online-stage-watch-probe`：弄崩舞台 B 19.2 s 重载、19.7 s 握回来仍双舞台；A 的源回 503 再弄崩 A，34.8 s 退回同源单舞台并画出画面，之后不再请求舞台源；页面错误 0。`online-user-cards-probe` 过。
- 语义建议里三级那条（在线双舞台的退回）已写进 `mechanism/rendering.md`「舞台」〔裁〕；二级那条（`product/platforms.md` 写同步卡能改参数）没写，列为待用户定。合入 main `0efcd41d`。
