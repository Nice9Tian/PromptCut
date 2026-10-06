# AGENT 报告：claude/online-cards（第二段：在线浏览器执行用户卡与图卡）

任务书 `docs/plan/sound-online-render-task.md` 的决定 C（在线浏览器执行用户卡与图卡）与第 12～18 条。worktree `.worktrees/online-cards`，分支 `claude/online-cards`，起点 `e7d18340`。

## 第一轮：设计与契约（已交，等主会话审）

### 做了什么

- 写了 `docs/plan/online-card-exec-contract.md`：转译器选型、模块解析、隔离环境与内容安全策略、图卡素材数据流、身份与缓存键、轻重判定的接法、纯浏览器节点认领、退回办法、语义逐字稿、安全与功能验收探针的设计、原有探针要改的断言、文件清单与分工。
- 写了可行性探针 `scripts/probes/online-card-isolation-feasibility-probe.mjs`（不依赖在线构建与新包）。
- 这一轮没改产品代码，没改语义文档，没装依赖（候选转译器在工作区外的临时目录里单独装来量）。

### 验证结果

| 命令 | 结果 |
|---|---|
| `node scripts/probes/online-card-isolation-feasibility-probe.mjs` | 退出码 0；50 项过，2 项记为缺口（不算探针失败）。Chrome for Testing 152.0.7977.75 |
| 临时目录里量体积（esbuild 压缩后 gzip -9） | Sucrase 48 KB；TypeScript 1.02 MB；@babel/standalone 656 KB；esbuild-wasm 3.75 MB；oxc wasm 1.10 MB；swc wasm 5.39 MB；Tailwind 浏览器版 74 KB |
| 临时目录里用 Sucrase 转译仓库 166 个卡片与部件文件 | 166 个全部转出，119 ms（TypeScript 474 ms）；四个用 `import.meta.glob` 的索引文件转得出但执行不了（不是卡片） |
| 单独试 `webrtc 'block'` | Chrome for Testing 152（默认、开实验性网页平台功能）与本机装的 Chrome 154.0.8037.98 都没拦住，STUN 包照样到了本机的 UDP 监听端口 |
| Worker 里有没有 `RTCPeerConnection` | 没有（`undefined`） |

探针过的 50 项分五组：读不到父页对象与编辑器页的存储、票据；非导航与导航类的外传都到不了收集站；对照组（去掉策略与 sandbox）到得了；凭 HttpOnly cookie 取到的图片与视频帧进 2D 画布、WebGL2 纹理读得回像素；宿主递 Blob 的另一条路也读得回。

两项缺口：
1. WebRTC 不受内容安全策略管，STUN / TURN 的包到得了收集站。
2. 用脚本加固（去掉构造器、Trusted Types 拒掉带子框架的 HTML、不给造子框架元素）的初版试了 21 条路，2 条仍能从子框架拿回构造器（XSLT、XHR 以文档类型取回再 `importNode`）。

### 没做成的及原因

- `dns-prefetch` 对域名的解析没法在本机实测（收集站是 IP），留给验收探针用 Chrome 的网络日志核。
- 没在真的在线构建上跑（本轮只做最小探针）。
- `claude/sound-ab` 写本契约时只有一个建报告文件的提交，声音在线合成的接口按任务书 B 的原文约定，实现时要对齐。

### 对任务书或语义的更正建议

- 任务书说「`workflow/editing.md` 里『需要本地 PC 渲染辅助』出现的条件」：一级文档里没有这句话，出现条件在 `product/platforms.md`、`product/rendering.md`、`glossary.md` 与 `c10-contract.md` 第 9 节，一级不用改。
- 任务书第 14 条「不能向任意外部地址发请求带走数据」在今天的 Chrome 上对 WebRTC 做不到浏览器级的保证，契约列为待定 1。
- 任务书写第二段在新节点上「只换静态页面」：本段还要改 nginx（策略头与 `/media-s/` 两条路由），要与换页面一起做。
- 在线页面与舞台现在没有任何内容安全策略；舞台现在拿着素材只读票据（在地址的 `?t=` 里）。两条都由本段补。
- 在线逐帧导出在与编辑器页同源的导出页里活渲，所以导出时用户卡、图卡一律用预渲染原尺寸，不在导出页执行。
- 审阅表不随卡片源码同步，同步来的用户卡在线上按缺省能力处理，建议另立一项。
- 同步来的卡用到的 Tailwind 类名不在在线包的样式表里，要在页面里补生成（用仓库已有的 `tailwindcss`）。

### 等主会话定的

见契约第 13 节，共七条；其中第 1 条（WebRTC 缺口选甲还是乙）建议开工前定。

## 第二轮：块 T（转译接入）

主会话 2026-10-06 的裁定已写进契约（提交 `4db39ec6`）：WebRTC 选甲、总开关、已知缺口断言，末尾有「待用户审」清单。

### 做了什么

- 依赖：`sucrase@3.35.1`（`package.json`、锁文件）；主工作区 `npm install --no-save` 装进共享的 `node_modules`，装完主工作区 `git status --short` 为空。
- 新目录 `src/online/cardRuntime/`：`protocol.ts`（数据形状与包的白名单）、`version.ts`（运行时版本）、`precheck.ts`（写法预检）、`resolve.ts`（导入解析）、`transpile.ts`（转译、打包）、`transpileCache.ts`（IndexedDB 缓存）、`tailwind.ts`（类名补生成）、`codeIdentity.ts`（页面算代码身份）、`gate.ts`（执行的前提与总开关的读法）、`loader.ts`（加载器）、`hostModules.ts`（页面模块表）、`stageRuntime.ts`（舞台一侧的接线，还没挂上）、`transpile.browser.ts`（编辑页面按需载入的入口）。
- `src/render/cardCodeIdentity.mjs`：代码身份的共用算法；`server/vite-plugin-cards.ts` 改为调它（改前改后对仓库 62 张卡逐张比，身份、闭包、`custom` 全部相同）。
- `src/kernel/registry.ts`：运行时载入的卡（`setRuntimeCards`，`getCard` 找不到构建时的才看它）、十种运行状态（`setCardRunStates`、`cardRunState`、`cardRunnableHere`）。
- `src/editor/sync/onlineCardSources.ts`：本页能执行时转译成包、取卡片引的样式文件；不能执行时与原来一字不差。`src/editor/sync/cardRunStates.ts`：编辑页面一侧合出运行状态与面板说明。`src/editor/Preview.tsx`：把这两样接上（转译器按需载入，桌面构建里整行剪掉）。
- `vite.config.ts`：在线构建注入转译器与 Tailwind 的版本。

### 验证结果

| 项 | 结果 |
|---|---|
| `npx tsc -b --force` | 退出码 0 |
| `npm test` | 退出码 0；4448 项、4447 通过、0 失败、1 跳过（本分支起点是 4432 项，新增 16 项） |
| `npm run build` | 退出码 0；产物里没有转译器那一块 |
| `npx vite build --mode online` | 退出码 0；运行时版本注入为 `ocr1:sucrase@3.35.1:tailwindcss@4.3.3` |
| 新增单测 `src/online/cardRuntime/cardRuntime.test.mjs` | OCE-T-01～16 全过 |
| `online-user-cards-probe`（端口 5720～5724） | **没跑通，与本块无关**：用起点代码的在线构建跑同样失败，卡在第一步加入项目（页面显示「连不上服务器」；WebSocket 握手 101、收到 `project.state` rev 0 后连接关闭）。待主会话核对这台机器上它原本过不过 |

在线包体积（`assets/` 下 js 与 css，gzip -9）：

| | 文件数 | 主块 `index.js` | 按需块 | 合计 |
|---|---|---|---|---|
| 起点 | 25 | 4,366,069 → 1,374,711 | — | 1,909,300 |
| 块 T | 26 | 4,380,694 → 1,378,696（+3,985） | `transpile.browser.js` 512,196 → 124,003 | 2,037,678 |
| 块 T 加舞台接线（临时量的，没提交） | 30 | 4,386,706 → 1,377,407 | 另加 `stageRuntime.js` 12,924 → 4,949 | 2,083,761 |

### 与契约不一致的地方

1. 预检用 Sucrase 自己的词法结果（公开接口 `getFormattedTokens`）判，文件是 `precheck.ts` 不是 `precheck.mjs`。顶层 `if` / `for` 块里的 `await` 预检认不出，载入时的语法错同样归为 `unsupported-syntax`。
2. 模块实例按卡分开：两张卡引同一份同步来的文件时各有各的实例（桌面是同一个）。这样闭包里任何文件变了整张卡重新执行，不会有没变的模块攥着旧依赖。
3. 「桌面端改过的内置文件用同步来的那份」没做：页面只列内容库里 `src/cards/user/` 下的键。引到改过的内置文件的用户卡，在线活渲用页面自带的那份，代码身份与桌面不同，浏览器节点不认领它的任务。
4. 页面模块表随舞台那一块一起载入，不是每个模块各自按需载入：后者让打包器把主块拆成一百多个小块（文件数 26 → 134）。
5. Sucrase 按 TypeScript 的规则省略没用到的具名导入（连同它的副作用）；带引号的 Tailwind 任意值（`content-['a']`）取不到候选。
6. 舞台一侧还没接线（按分工留到与块 S 合流）：编辑页面转译出的包还没发给舞台，运行状态已写进注册表但还没有地方读；`gate.ts` 缺省不可执行，所以现在线上行为与起点相同。
7. 测量门：本页能执行时，卡片源码第一次同步的「有了结果」排在第一次转译之后。
8. 锁文件里除 sucrase 及其依赖外，npm 还顺手规范了几处已有条目（`@tailwindcss/oxide-wasm32-wasi` 内嵌依赖的登记、七处 `dev` 标记）。

### 后面几块开工前还缺的

- 块 S 合进来之后要接的线：`stageRpc.ts` 加 `loadUserCards(bundles)` 与状态回报；`StageView.tsx` 按需载入 `stageRuntime.ts`；`Preview.tsx` 把包发给两个舞台、把舞台报的状态交给 `editorRunStates` 的 `stages`；S 的握手与自检调 `setCardExecGate`，读运行配置时调 `siteCardExecOf`；开了 Trusted Types 的话给加载器一个走策略的 `compile`。
- 块 A：声音线程自己的模块表（带占位的那一张）与 Worker 入口，用同一个 `createCardLoader`；等 `claude/sound-ab` 合入。
- 块 G：`mediaSource.ts` 的素材地址（等 S 的 `/media-s/`）、图形能力判定写 `gpu` / `media` 两种状态。
- 块 L：把六处判断换成 `cardRunnableHere`；构建时就在在线包里的仓库用户卡现在也被当成运行不了（`needsLocalPc`），一并改。
- 块 N：`transpile.browser.ts` 的 `codeIdentities()` 已能算出与桌面相同的代码身份，接到 `browserNode.ts` 与 `planPublisher.ts`。

## 块 A、块 L 与有声动效卡的成本身份（接手的子 Agent 做，主会话据其返回落稿）

子 Agent 写报告文件时被会话的工具拦下，本节由主会话按它返回的内容写入。

### 提交

| 提交 | 内容 |
|---|---|
| `1c9325e9` | 有声动效卡的成本身份（单独一个提交，建在 `8a71920b` 上；与 `9057d973` 一起带回第一段） |
| `9913441a` | 接手的未提交改动（九个文件里保留八个与 `soundEngine.ts`；`cardGraph.mjs` 往节点上写 `clipId` 的那一处没采用：节点内容进预渲染结果的键，加字段会让这类卡已有的预渲染结果全部失效） |
| `550e4b7a` | 块 L |
| `a4d0fe3f` | 块 A |
| `9057d973` | `sound-ab-probe.mjs` 跟上有声动效卡判轻后的行为 |

### 有声动效卡即时补测（用户 2026-10-06：「直接自动即时补测试。不要默认判重。」）

- 改法：`src/render/pipelinePlan.mjs` 新增 `clipCostNodes`（按 `clipId` 找不到节点时看片段自己的图卡节点），`clipCostIndex` 多一个可选参数；`src/editor/costIdentity.ts` 把「画面是组件、没有 `card()`」的算进来。图里的节点不动，预渲染结果的键不变。另修一条静默按重的路径：卡片图有悬空输入、摊图抛错时以前整个项目都没有身份、全部不测，现在退一步只按片段自己的卡再摊一遍。
- 仍然按重的情况：低内存档（现有规则，没动）；在线页面里本页运行不了的同步用户卡；在线页面里全部图卡（图卡在线执行还没接上）；桌面与在线画面由 `card()` 出的图卡（测量用的缩水项目不带素材与卡片图节点，GPU 耗时也不在现在量的数里——能否给不带输入的图卡补测待定）；没声明 `direct` 的卡在第一次测完前的几秒；测量这一轮没成（下次项目变动、卡片更新或重开时再测）；记录本身判重。
- 验证：探针 `scripts/probes/av-card-cost-probe.mjs` 7 项全过（两段都有身份、第一次出现就测、每步 1.2 ms 与 0.9 ms、测量期间新建音频上下文 / 元素播放 / 声源启动都是 0 次、判轻且不在预渲染集合里、没有「需要本地 PC 渲染辅助」、重开后不重测）；同一项目在 `8a71920b` 上对照为没有身份、判重、在预渲染集合里；含它与不含它的项目改前改后导出各 120 对 120 帧、0 帧不同、文件逐字节相同；在线普通档 `sound-ab-probe` 新加一条通过。

### 块 L

六处判断共用 `placeholderHost.ts` 的 `needsLocalPc` 一个出口：用户卡只有本页运行不了的才算（构建时就在在线包里的仓库用户卡不算；同步来的只有 `ready` 不算；图卡照旧算）。低内存档照旧不运行仓库用户卡。运行状态变化时分派表重算、测量重排、时间轴片段重绘。测量门等同步卡第一次载入有结果，仍受 10 秒上限。导出：同步卡必须用预渲染原尺寸，判轻的同步卡导出期间并进清单计划（`src/export/exportWanted.ts`）。

### 块 A

线程一侧在 `src/online/cardRuntime/`（`soundStub.ts`、`soundModules.ts`、`soundThread.ts`、`soundWorker.ts`、`soundHost.ts`、`stageSound.ts`、`soundSpawn.ts`）；编辑页面一侧 `src/audio/cardAudio.ts` 加隔离宿主接口 `setIsolatedCardAudioHost` 与路由 `cardAudioRoute`，`src/editor/io/isolatedSound.ts` 把舞台状态和一个 RPC 函数接成宿主。不在线合成的：读素材采样的音频图卡、同步卡与内置卡串联的链路、线程里载入不成或连着两次超时的、低内存档、没有隔离环境的页面。

### 轻量验收

`npx tsc -b --force` 退出码 0；`npm test` tests 4496、pass 4495、fail 0、skipped 1；`npm run build` 与 `npx vite build --mode online` 退出码 0（全部 js 与 css gzip 后 2,016,968 → 2,021,203）；新单测 AVC-01～05、OCE-L-01～07、OCE-A-01～07 共 19 项全过；`online-card-sound-probe` 9 项全过（线程起在舞台源，线程里没有 `document`、`localStorage`、`parent`、`RTCPeerConnection`；采样与页面逐样本相同；死循环 1018 毫秒掐断后能重起）；`sound-ab-probe` 三段 73/73；`sound-preview-probe --mode both` 74/74。按新语义改了断言的旧单测：OU-01、OU-02、C10-UI-03、SL-01、OCE-T-08。

### 等块 S 的接线点

1. `stageRpc.ts` 加 `synthCardAudio(request)`（形状见 `stageSound.ts` 的 `StageSoundRequest`）与声音状态事件；`loadUserCards` 把同一组包也交给声音那一半。
2. `StageView.tsx` 后台舞台按需载入 `stageSound.ts`，调 `createStageSound({ spawn, onState })`；前后台互换时线程跟哪个文档走要定。
3. `Preview.tsx` 用 `createIsolatedSoundLink({ render })` 接上；舞台换了、退回单舞台或改判低内存档时调 `link.setState(null)`。
4. `soundSpawn.ts` 现在从同源模块地址起线程，`worker-src blob:` 下要换成 blob 引导；隔离断言补进安全探针。
5. 线程那一块 3,746,284 字节（gzip 1,092,442），线程打包不拆块；`vite.config.ts` 设 `worker.format: "es"` 可拆。
6. 舞台的 `setTimeout` 是虚拟时钟：`soundHost.ts` 的时限走 `__pcRealSetTimeout`，别的超时也要注意。
7. `setMediaPolicy` 改带 `sid` 时保留 `lowMemory` 字段。
8. 块 T 列过的 `setCardExecGate`、`siteCardExecOf`、Trusted Types 的 `compile`（声音线程的加载器同样要）。

等 N：导出期间并进清单计划的同步卡片段，要 `cardSources` 与 `cardEnvFingerprint` 到位后浏览器节点才能认领；同步卡成本记录的运行时版本放在源码版本里（`user:online:<签名>`）。等 G：放开 `needsLocalPc` 的图卡分支；把 `stageRuntime.ts` 里图卡临时报的 `load-error` 换成真实状态。

### 契约更正建议

第 6 节六处判断实际是一个出口，另需加运行状态的订阅；第 8 节补「判轻的同步卡导出期间并进清单计划」「仓库用户卡在低内存档照旧不运行」；3.5 时限补「走真计时」，模块表 `react-dom` 也给占位；第 5 节运行时版本在源码版本里；同步卡在线生成的声音产物，身份里的默认参数取自静态解析，解析不全时桌面会判它过期；同步卡在编辑页面没有声明的帧模式，一律按推帧测。

### 没做成的

在线页面里真正执行同步卡（等 S 的 RPC）；导出页贴同步卡原尺寸的真实浏览器验证（只有单测）；`setSoundBackfillHandler` 按分工没接；完整渲染附加项与语义文档按分工没动。
