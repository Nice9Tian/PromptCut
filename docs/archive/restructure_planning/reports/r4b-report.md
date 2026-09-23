# R4b 报告：常驻探针（ProbeGate、后台舞台逐张测、两趟布尔探针、setPlan 下发）

分支 `worktree-agent-a671a2ddb0ba62cca`（worktree `C:\Users\admin\Documents\PromptCut\.claude\worktrees\agent-a671a2ddb0ba62cca`）。
开工时 `git merge --ff-only main` 到 **`62810bb`**（R4a 已合并）。

## 1. 提交

| 提交 | 内容 |
|---|---|
| `9c983eb` | 渲染：`device` 串抽成共享函数 `costDevice.mjs`，离线探针与常驻探针共用一份拼法 |
| `15fa9e2` | 渲染：两趟布尔探针的比对纯函数 `snapshotCompare.mjs` |
| `357fae5` | 舞台：两趟布尔探针（`vtOk` / `seekOk` / `seekMs`）与 `setPlan` 的表 |
| `df8f1d1` | 探针：父页驱动 `probeRunner` 与加载遮罩 `ProbeGate` |
| `5ba405a` | 分派：`setPlan` 下发与 `out/pipeline-tuning.json` 的写入口 |
| `74d3db6` | 探针：`probe-gate-probe` 验收脚本与两张布尔判例卡 |
| `42a6a9a` | 探针：`probe-gate-probe` 跑通（自起 vite、`headless` 不塞演示卡、观察者装在文档之前） |
| `fe9f7c8` | 去掉误提交的临时诊断脚本 |
| `8c2778a` | 舞台：布尔探针拼控件 HTML 的分隔符改成 HTML 注释，别在源码里留不可打印字符 |

## 2. 改了哪些文件

**新增**

- `src/render/costDevice.mjs` / `.d.mts` / `.test.mjs` —— `device` 串的唯一拼法
- `src/render/snapshotCompare.mjs` / `.d.mts` / `.test.mjs` —— 两趟布尔探针的比对纯函数
- `src/render/probeSummary.mjs` / `.d.mts` / `.test.mjs` —— 探针统计口径的唯一实现
- `src/render/wirePlan.ts` / `.test.mjs` —— `setPlan` 在线上的形状（集合 ⇄ 数组）
- `src/editor/probeRunner.ts` —— 父页一侧的探针驱动
- `src/editor/ProbeGate.tsx` / `.css` —— 加载遮罩
- `src/editor/costIdentity.ts` —— 「片段 → `cardCostKey` / 帧模式 / 能力表」，探针和分派表共用
- `src/editor/planDispatch.ts` —— `setPlan` 下发（含角色转正补发那个函数）
- `src/cards/_probe/boolean-probe.tsx` —— 两张布尔判例卡
- `scripts/probes/probe-gate-probe.mjs` —— 验收探针

**改动**

- `src/StageView.tsx`、`src/render/pinAnimations.ts` —— 见下面第 3 节（逐 hunk）
- `src/render/stageRpc.ts` —— `ProbeMode` 加 `'booleans'`、新增 `ProbeBooleans`、`RenderResult` 加 `booleans` / `snapshotSteps`、`RenderAborted` 加 `snapshotSteps`
- `src/render/pipelineTuning.mjs` / `.d.mts` —— 加 `PROBE_BOOL_FRAMES = 8` / `PROBE_BOOL_MS = 200`
- `src/editor/stageBridge.ts` —— `setStageClient` 多收一个宿主能力表，新增 `stageCapabilities(role)`
- `src/editor/Preview.tsx` —— **只有 3 行**：握手时把 `hostCapabilities` 一起登记进 `stageBridge`
- `src/Editor.tsx` —— 在渲 `<Preview />` 那一层加一个 `<ProbeGate />`
- `src/kernel/clock.ts` —— 补 `__pcStagePlan` / `__pcStagePipelineAt` 两个舞台全局的声明
- `src/cards/_probe/index.ts` —— 注册两张判例卡
- `scripts/probe-card-costs.mjs` —— 改成 import `costDevice.mjs` / `probeSummary.mjs`，删掉自己那份拼法和统计（行为不变）
- `server/costs-store.mjs` —— 加 `saveTuning(root, overrides)`
- `server/vite-plugin-costs.ts` —— 加 `PUT /api/data/costs/tuning`，转发函数改成按路径复用
- `server/test/costs.test.mjs` —— +4 条

## 3. 给合并的人：`StageView.tsx` / `pinAnimations.ts` 动了哪几块

R3 同时在改这两个文件。改动**只在 `render` 的探针分支、`setTime` 的 `probe` 那一块、`setPlan`，外加探针要用的几个新局部函数**，没有顺手重排或改格式，JSX 和别的 setter 一个字没动。

### `src/StageView.tsx`（+259 / −38，按块）

| 位置 | 改了什么 |
|---|---|
| import 头 | 加 `ProbeBooleans` / `SnapshotCost` 两个类型、`PROBE_BOOL_FRAMES` / `PROBE_BOOL_MS`、`compareSnapshotHtml`、`pipelineAt`、`revivePlan` / `StagePlan` / `WirePlan`；删掉不再用的 `CardCostRecord` |
| `ref.current.plan` 的类型 | `{ plan: unknown; costs: CardCostRecord[] }` → `StagePlan`（一行） |
| `renderGen` 之后 | 新增 `projectGen` ref（布尔探针那一支不走 `abortPending`，要另有东西分清 `'project'` / `'superseded'`） |
| `remountAt` | **只把「算挂载帧」那 6 行抽成 `mountSecOf(target, fps)`**，`remountAt` 本体只剩一句 `const from = mountSecOf(target, fps)`，其余原样 |
| `legacyJump` 之后 | 新增四个只给探针用的局部函数：`probeWrap()`、`remountClipAt(mountSec)`（K3 的重挂载定位配方，片段粒度）、`probeControlHtml()`、`runBooleanProbe(lastSec, fps, gen)` |
| `setProject` 内 | `renderGen.current++` 旁边加一行 `projectGen.current++` |
| `render` 的 `gen` / `abortPending` 之后 | 加 `if (probeMode === "booleans") { … }` 一整支，原来的 `let remounted = false` 起的那条路一个字没动 |
| `render` 的 `snapshot` 累加器旁 | 加 `const snapshotSteps: SnapshotCost[] = []` |
| `render` 的 `afterFrame` 快照支 | 三行累加之后多一行 `snapshotSteps.push(...)` |
| `render` 的两条回包 | `...(timing ? { steps } : { snapshotSteps })` / `...(timing ? { steps } : probe ? { snapshotSteps } : {})` |
| `setPlan` | 函数体从「存下原样」改成「`revivePlan` 回填成 `Set` 再存」，加一段说明 |
| `__pcCreateSnapshot` 之后 | 加 `window.__pcStagePlan` / `window.__pcStagePipelineAt` 两个查询口子；`return` 的清理里对应 `delete` 两行 |

`setTime` 的 `if (opts.probe)` 那一块**没动**（R4a 已经把四个数量对了）。

### `src/render/pinAnimations.ts`（+53 / −14）

整个文件只有一处结构性改动：把原来 `sync` 里那段钉动画的逻辑抽成局部函数 `pin(a, nowMs)`，然后 `sync` 和新增的 `syncIn` 共用它；另加局部 `inSubtree(el)`。对外多两个方法：

- `resetIn(el)`：`el.getAnimations({ subtree: true })` 逐个从 `anchors` 删（`reset()` 是整份 `WeakMap` 重建，会连带丢掉别的卡的锚点）；
- `syncIn(el, stageMs)`：只遍历子树，**时间基一律全局舞台毫秒**（K5 点名的坑写在注释里）。

K5 要的 `sync(nowMs, skip?)` 第二参**没加**（那是 R5 的活）。R3 那一侧如果也加了同名方法，按这份签名对齐即可。

### 其它 Agent 的文件

`FrameScene.tsx` / `Stage.tsx` / `server/frame-pipeline.mjs` / `server/mirror-store.mjs` / `server/snapshot-store.mjs` / `server/vite-plugin-mirror.ts` / `src/render/dataMirror.ts` / `src/render/snapshotSource.ts` **一个字都没碰**。`src/editor/Preview.tsx` 只改了 3 行（登记宿主能力表）。

## 4. 验收

### 4.1 例行

| | 结果 |
|---|---|
| `npx tsc -b --force` | **零错误** |
| `npm test` | **1583 / 1582 通过 / 0 失败 / 1 跳过**（main 基线 1547 / 1546 / 0 / 1，新增 **36** 条：`costDevice` 8 + `snapshotCompare` 13 + `probeSummary` 8 + `wirePlan` 3 + `costs` 4） |
| `scripts/probes/editor-preview-smoke.mjs`（legacy，缺省） | **过**，`fails: []`、`errors: []` |
| `scripts/probes/editor-preview-smoke.mjs --stage` | **过**，`fails: []` |
| `scripts/probes/stage-rpc-probe.mjs` | **过**，`fails: []`、`pageErrors: []` |

### 4.2 `scripts/probes/probe-gate-probe.mjs`（新）

dev server 端口 **5251**（舞台端口 **5252 / 5253**，`stagePortsOf(5251)` 算出来的），`PROMPTCUT_DATA_DIR` 指到临时目录、仓库 `out/` 没被碰过（收尾 `git status` 干净、`out/` 里只有原有的 `frame-library`）。跑了三趟（`r4b-data/gate-run3.json`、`gate-shared.json`、`gate-final.json`），三趟 `pass: true`、`fails: []`。

| 验收条目 | 结果 |
|---|---|
| 20 张没测过的卡，遮罩停留到全部测完 | ✅ `gateAppearedFirstOpen: true`、测完 `gateStillUp: false`；整轮 **8.5 秒**（三趟 8520 / 8516 / 8530 ms） |
| `out/card-costs.json` 有 20 条 | ✅ `recordCount: 20`（三趟都是） |
| 每条带四个数 + `catchUpMs` + `mode` + `demoted: false` | ✅ 逐条查过 `stepMs` / `inlineMs` / `rasterMs` / `serializeMs` / `catchUpMs` 都是有限数、`mode: 'dev'`、`demoted: false`；另外每条还带 `stepMaxMs` 和两个布尔 |
| 第二次打开遮罩一帧都不出现 | ✅ `secondOpen.gateSeen: false`、`total: 0`（观察者在**文档创建之前**就装好，不是轮询） |
| 探针期间可见舞台 `__pcRealRaf` 帧间隔中位数 ≤ 20 ms | ✅ **p50 = 17.1 ms**（三趟都是）、p90 17.5～17.6 ms。见下面「关于这条的实话」 |
| 后台舞台任何时刻只有一个卡片段（先换缩水项目再 `render`） | ✅ 25 次采样全是 1 |
| 项目中途改了、队列按新项目重排 | ✅ 换项目前 `{ total: 20, done: 6, card: 'scene-3d' }`，换之后 `{ total: 2, done: 2 }`（新项目就 2 张卡），没有把旧项目剩下的 14 张接着测 |
| `setPlan` 把同一张表送到可见舞台 | ✅ 父页 `{ segments: 1, prerender: 8 }`，舞台 `__pcStagePlan()` 回 `{ segments: 1, prerender: 8, costs: 20 }` |
| 页面报错 | ✅ `pageErrors: []` |

**关于帧间隔这条的实话**：按任务书照做带了 `--disable-gpu-vsync --disable-frame-rate-limit`，但在 **headless** 下 rAF 的节拍仍然贴着 16.7 ms（p50 17.1 / p90 17.5），也就是说**这两个参数在 headless 里没把 vsync 解开**，量到的是「有没有被拖成长帧」而不是「主线程有多空」。结论仍然成立（中位数 17.1 ms ≤ 20 ms，说明探针没有把可见舞台拖住），但它是一个上界而不是精确的空闲度。三趟的单帧最大分别是 37.5 / 209 / 1579 ms —— 这台机器上同时有另外两个 Agent 在跑构建和 `render-worker.mjs`（实测到 12 个属于 `worktree-agent-a86dc5e354f604912` 的 headless Chrome），最大值不可复现、不作数；中位数三趟完全一致。R2 报告里「加了这两个参数才量得到主线程停顿」的结论在 headful 下可能成立，headless 下我没复现出来，写在这里备查。

### 4.3 布尔探针的三张判例

| 卡 | `vtOk` | `seekOk` | `seekMs` | 期望 | 结果 |
|---|---|---|---|---|---|
| `probe-css`（只有 CSS `@keyframes` 的 transform 平移，新建） | **true** | **true** | 0.4～0.6 ms | `vtOk` 且 `seekOk` | ✅ |
| `particles-snow`（卡库现成的粒子卡） | **true** | true | 0.3 ms | `vtOk` | ✅ |
| `probe-motion-js`（Motion 的 `useAnimationFrame` 每帧自己写 `transform`，新建） | **false** | false | 0.1～0.2 ms | `vtOk: false` | ✅ |

两张新卡放在 `src/cards/_probe/boolean-probe.tsx`。**为什么要新建**：卡库里那张 `probe` 把 CSS 动画、Motion 元素和一条裸 rAF 计数器混在一张卡上，判出来的布尔是三者取交，说明不了任何一条判据；`particles-snow` 是干净的粒子判例，直接用卡库的。

顺带的一份全量数据（那 20 张卡）：`vtOk: true` 5 张、`false` 15 张；`seekOk: true` 4 张；`capped` **0 张**（和 R4a §6.1 的结论一致）。

### 4.4 常驻探针 vs 离线探针（同一批 20 张卡，同一台 dev server，fps 30 / 4 秒片段）

**`device` 串逐字节相同** —— 两条证据：

1. 直接比字符串：`gate-shared.json` 的 `device` 和 `offline.json` 的 `device` 全等（`===` 为 true）；
2. 更硬的一条：离线探针 `PUT` 完之后服务端回的是 **「新增 0、更新 20」** —— 去重键是 `${identityKey}${device}`，`device` 差一个字节就会是「新增 20」。

串本身：

```
Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/152.0.0.0 Safari/537.36 | ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 (0x00002206) Direct3D11 vs_5_0 ps_5_0, D3D11) | lowMemory=false | offscreenGl=true | glRoute=perDocument | mode=dev | stepP=0.9 | stepN=16
```

`stepMs` 对照（常驻 / 离线，单位 ms）：

| 卡 | 常驻 | 离线 | 比值 | `catchUpMs` 常驻 / 离线 |
|---|---|---|---|---|
| `probe-css` | 0.4 | 0.5 | 0.80× | 32 / 37 |
| `probe-motion-js` | 0.4 | 0.5 | 0.80× | 32 / 39 |
| `particles-snow` | 2.2 | 3.5 | 0.63× | 135 / 219 |
| `mu-number-ticker` | 0.4 | 0.5 | 0.80× | 29 / 38 |
| `mu-blur-fade` | 0.9 | 0.9 | 1.00× | 78 / 78 |
| `mu-circular-progress` | 0.6 | 0.5 | 1.20× | 43 / 32 |
| `mu-typing` | 0.2 | 0.3 | 0.67× | 17 / 21 |
| `mu-word-rotate` | 0.5 | 0.6 | 0.83× | 45 / 50 |
| `lottie` | 0.3 | 0.5 | 0.60× | 20 / 41 |
| `particles` | 1.1 | 1.1 | 1.00× | 68 / 74 |
| `scene-3d` | 0.5 | 0.5 | 1.00× | 118 / 64 |
| `odometer` | 1.1 | 1.2 | 0.92× | 108 / 123 |
| `blur-text` | 0.5 | 0.8 | 0.63× | 39 / 65 |
| `ring-metric` | 0.4 | 0.5 | 0.80× | 32 / 44 |
| `checklist` | 1.1 | 1.2 | 0.92× | 85 / 109 |
| `step-timeline` | 1.1 | 2.8 | 0.39× | 107 / 221 |
| `quote-lockup` | 1.0 | 1.7 | 0.59× | 75 / 115 |
| `punch-pill` | 0.6 | 1.0 | 0.60× | 44 / 64 |
| `term-card` | 1.1 | 1.8 | 0.61× | 95 / 129 |
| `type-shift` | 0.8 | 1.0 | 0.80× | 61 / 84 |

比值 **p50 = 0.80×、min 0.39×、max 1.20×**，**20 / 20 张在同量级**（0.25×～4×）。系统性地偏小一点点，两个原因都写在这里：

- 常驻探针只有一台浏览器在跑，离线探针的宿主页里还挂着一个 1920×1080 的 iframe 加一套 RPC 客户端；
- 离线探针的快照趟是**逐帧发 40 次 `render`**，每次往返之间那台浏览器在处理 postMessage；常驻探针一次往返推完（见第 5 节第 3 条）。

`catchUpMs` 的差异同向、同量级（常驻普遍略小），`scene-3d` 是唯一反过来的一张（118 / 64），它的首帧要建 three.js 场景，两条路的预热时机不同，属于已知噪声。

## 5. 对任务书的更正建议（原句 → 怎么做的 → 为什么）

1. **原句**（K1）：「`stepped` 卡『测完』的信号是 `back` post 的 `{ type: 'probe' }` 消息（第一趟 + 两趟布尔探针都跑完才 post），父页收到它才换下一张卡」。
   **怎么做的**：**父页自己合成整条记录，舞台不 post `probe`**。父页按顺序发计时趟 → 快照趟 → 布尔趟三次 `render`，三个回包都 `await` 到了才换下一张。
   **为什么**：K1 同一节又写「`direct` 卡不 post `probe`，父页收齐 8 个回包后自己合成」，而三个数值来源（`steps` / `snapshotSteps` / `booleans`）本来就全在 `render` 的回包里。让舞台再 post 一遍等于同一份数据走两条路、还要在父页做一次配对。任务书担心的那件事（「不能拿 `render({ probe: true })` 的回包当完成信号，否则下一张的 `setProject` 会把还在跑的布尔探针掐掉」）在这个做法下不存在：布尔趟**自己就是一次 `render`**，它 resolve 了才算完。`probe` 事件的协议面留着没删，将来 L1 的在线浏览器模式如果要让舞台自己排队，可以接回去。

2. **原句**（K1）：两趟布尔探针的基线是「计时 / 快照趟里全局时钟推出来的第 8 帧」。
   **怎么做的**：`probe: 'booleans'` 这一趟**自己先跑一遍基线趟**（复位 → 全局时钟推 8 帧 → 生成快照留在内存），再跑 `vtOk` / `seekOk` / `seekMs`。
   **为什么**：同一节紧接着写「第一趟的第 8 帧 HTML 由 `back` 自己留在内存里当比对基线（不依赖父页回传）」，而计时趟按定义**不生成快照**、快照趟的第 8 帧又可能被一拍预算截掉。让布尔趟自带基线是唯一能同时满足这两句的读法，而且基线趟用的是和计时 / 快照趟**逐字一致**的 `advanceToAsync` + `onFrame` / `afterFrame`，比的仍然是「全局时钟推出来的第 8 帧」。「第 8 帧之前就被截断的卡没有基线，两个布尔一律记 `false`」这条照样成立（基线趟同样受 8 帧 / 200 ms 封顶）。

3. **原句**（K1）：快照趟「`inlineMs` / `rasterMs` / `serializeMs` = 各段的稳健值」，但 `render` 的回包里 `snapshot` 是**整趟的累加**。
   **怎么做的**：`RenderResult` 加一个 `snapshotSteps: SnapshotCost[]`（和 `steps` 对称的逐帧样本），`snapshot` 照旧是累加值。
   **为什么**：累加值换算不回单帧稳健值。离线探针为了拿逐帧数只好一帧发一次 `render`（缺省 40 次往返），那在加载遮罩下要乘以 N 张卡，实测会把整轮从 8.5 秒拖成几分钟。加一个字段一次往返就够，旧调用方（离线脚本）一个字都不用改。

4. **原句**（K1）：「给组件本地 `t`」——K5 说这要靠 `Stage` 的第五个 prop `settling: Map<clipId, stageMs>`。
   **怎么做的**：布尔探针**不碰 `Stage.tsx`**，直接用舞台的全局 `setT`。
   **为什么**：探针**只在缩水项目上跑**（K1 明写「一次只测一个片段」），舞台里恰好一张卡，它的「子树本地时间基」就是舞台的全局 `t`。真正的区别（也是判据本身）在于**全局时钟动不动**：`vtOk` 趟不调 `clock.tick`，被 `stageClock` 接管的 rAF 队列因此没人排空，读全局帧循环时间戳的 Motion JS 动画推不动 —— 这正是要抓的那一类。R5 要在整份项目上对**单张**卡做同样的事时才需要 `settling` prop。建议 K1 里写明这一条，省得 R5 以为探针在等它。

5. **原句**（K1）：「量 `seekMs` 那一趟超了就**中止**、`seekMs` 记 `null`」。
   **怎么做的**：那一趟是**一次同步的 `syncIn` + `flushSync`**，中途没有让出点，中止不了；改成量完之后判 `> PROBE_BOOL_MS` 就记 `null`。
   **为什么**：「从第 0 帧直接钉到最后一帧」按定义只有一步，没有可以插进去的检查点。语义上等价（超上限的值一律记未知），只是多花了那一步的时间。

6. **原句**（K1 / K2）：`device` 串的拼法在 K1 里写了一遍，R4a 报告 §8 第 10 条建议抽成共享函数但没做。
   **怎么做的**：抽成 `src/render/costDevice.mjs` 的 `costDeviceString(parts)`，离线探针和常驻探针都 import 它；要摸 DOM 的那一样（GPU renderer）单独做成 `readGpuRenderer(doc)`，`lowMemory` / `offscreenGl` 一律取**舞台握手报上来的那一份**（新增 `stageBridge.stageCapabilities(role)`）。
   **为什么**：R4a 说的理由成立，而且「两条路测出来对得上」这件事我这一步就要验收。主文档自己再探一遍 `lowMemory` 是第二份实现，会悄悄走偏。

7. **原句**（K1）：统计口径（百分位、外推、旧口径对照）只在离线探针里写过一遍。
   **怎么做的**：抽成 `src/render/probeSummary.mjs` 的 `summarizeProbe(raw, tuning)`，两条路共用。
   **为什么**：同上。这一条任务书没要求，但「常驻探针要和离线探针量出同一口径的数」只有共用同一份代码才验得起来。

8. **原句**（K2「可调系数」）：「覆盖值存本机 `out/pipeline-tuning.json`」，没说写入口。
   **怎么做的**：`PUT /api/data/costs/tuning`，body `{ tuning: {…} | null }`，落盘**夹取之后**的一份，`null` / 非对象 = 删文件（清掉覆盖）。挂在 `/api/data/costs` 这个中间件下（connect 的前缀匹配本来就把子路径收进来了），同源守卫由 `vite-plugin-api-guard` 统一挡（实测跨源 `Origin` 回 403）。转发给预渲染进程的那一段改成按路径复用。不做界面。
   **为什么**：R4a 只做了读，「不改代码就能调」只剩半条。挂在同一个前缀下是因为读写同一份数据、转发链路也能原样复用。落盘夹取后的值是为了和 `loadTuning` 回的一致（不然文件里写着 100、回出去的是 4）。

9. **原句**（K1）：`ProbeGate` 「打开项目时……把所有活跃卡逐张测完才进编辑」「之后新添加的卡、或 `cardCostKey` 变了的卡随即在后台舞台测」。
   **怎么做的**：进度里加一个 `blocking` 位。**只有「这个页面加载后第一轮跑在一个有卡片段的项目上」是 blocking**，那一轮走完（不管有没有真测）`blocking` 就永久为 false，之后的补测在后台跑、遮罩不再出现。
   **为什么**：两句话要同时成立就需要区分「第一轮」和「后来」，而任务书没给判据。空项目那一轮不算（否则真项目到位时遮罩就不出现了）。**副作用要记一笔**：`Editor.tsx:148-158` 在空项目上会塞 10 张演示卡，所以在真实编辑台里「第一轮」测的是那 10 张演示卡；验收探针因此带 `?headless=1`（那条路不塞演示卡）。建议 K1 里把「第一轮」的判据写明。

10. **原句**（K1）：「`direct` 卡……`canvasHeavy` 同法」——离线探针靠 `f.contentWindow.document.querySelector('[data-pc-clip] canvas')` 等画布装起来。
    **怎么做的**：常驻探针**跨源摸不到 iframe 的 document**，改成轮询 `rectsWithBounds({ pixels: 'all', clipIds: [clipId] })` 直到实体框出来（它会让舞台读一次画布像素）。
    **为什么**：E1 之后两个舞台是跨源的，离线探针那条路在常驻探针里根本用不了。这也是上面 §4.4 里 `particles-snow` / `scene-3d` 两条路数值差得最多的原因之一。

11. **一条和任务书无关、但要提醒合并的人**（R4a 引入、非本任务）：`server/costs-store.mjs` 的 `keyOf` 用了一个**字面 NUL 字符**当分隔符，git 因此把这个文件当二进制存（`git diff` 只显示 `Bin 6838 -> 8021 bytes`，逐行 diff 和换行规范化都没了）。我没动它（不在范围、改了要连带想清楚 upsert 的兼容），但它会让这个文件的合并很难受。我自己那一处同样的写法（布尔探针拼控件 HTML）已经在 `8c2778a` 里换成了 HTML 注释。

## 6. 没做成的 / 留给 R5、R6 的

- **`probe-frame` 转发只写到一半（`TODO(R6)`）**：`src/editor/probeRunner.ts` 的 `forwardProbeFrame` 已经按 K1 的形状发 `PUT /api/frames/snapshot`（`{ session, localRev, clipId, localFrame, html }`，`session` / `localRev` 取 `dataMirror.mirrorKey()`），**只转发审阅表 `independent` 的卡**；端点还没合进来，回 404 就置一个标志位、之后整轮不再试，静默丢弃、不报错。R6 合进来之后这一条自然生效，不用改代码。**没有验收过**（端点不存在）。
- **`sendPlanTo(role, { force: true })` 是角色转正时补发那一条（K5 (5) / K3(b) (5)），R5 直接调**。`planDispatch.ts` 里 `currentPlan()` / `currentCosts()` 也一并导出了。舞台侧 `setPlan` 收下的表可以用 `__pcStagePipelineAt(clipId, tSec)` 查，R5 在舞台内部直接读 `ref.current.plan`。
- **K3 / K5 的消费全没做**（不在范围）：`pipelineAt` 的结果没人用，`settling` / `suppressed` / `snapshots` 还只是状态位。
- **`pinAnimations.ts` 的 `sync(nowMs, skip?)` 没加**（K5 要它跳过 `.pc-settling` / `suppressed` 的子树）。只加了 `resetIn` / `syncIn`。
- **`unknown` 卡的 `probe-frame` 不转发**：按 K1 末句只有 `independent` 才存。`unknown`（用户定制卡、带部件的组合卡）走 `belowDependent`，本地档由 C2 的整场景路产。
- **K6 的 `demote` 事件没人接**（R5）。`Preview.tsx` 的事件骨架里那个分支还是空的 —— 我没动它。
- **`ProjectSettingsDialog` 切 fps / `glRoute` 之后重走遮罩**：没做（约束一节的那条，`device` 变了本来就会让全部记录不命中、自然重测，但「遮罩期间不播放」那一半要 R5 的 K4 才有意义）。
- **构建产物（`--mode build`）上没跑**：和 R1 / R4a 一样，宿主页的卡片注册表是 `import('/src/cards/index.ts')` 拿的，只有 dev server 供得起。`mode: 'build'` 的那条路只有类型和 `device` 串就位。
- **快照趟的三个数在两条路上不完全可比**：常驻探针一次 `render` 推完、受一拍预算（B ≈ 23 ms）截断，样本只有几帧，`robustStep` 会退回取最大；离线探针逐帧发 40 次、拿得到 40 个样本。**这三个数不进判重**（K1 / 3.3），所以不影响分派，但报告里并排比的时候要知道口径不同。
- **帧间隔那条的 headless 局限**见 §4.2 的「实话」。

## 7. 收尾

- dev server 用的 **5251**（舞台 5252 / 5253），**全部关掉**：`Get-NetTCPConnection` 查 5251～5253 无监听，带 `--disable-gpu-vsync` 的探针 Chrome 0 个，`vite ... 5251` 的 node 0 个。（机器上另有 12 个 headless Chrome 属于 `worktree-agent-a86dc5e354f604912` 的 `render-worker.mjs`，不是我起的，没动。）
- 没碰 5190～5199 / 5201 / 5211～5249，没读写 `%LOCALAPPDATA%\PromptCut\runtime\app`，没建 junction、没 `npm ci`、没装任何东西。
- 仓库 `out/` 没被污染（验收探针一律走 `PROMPTCUT_DATA_DIR` 指的临时目录，用完删）。
- 原始数据在 `scratchpad\r4b-data\`：`gate-run3.json` / `gate-shared.json` / `gate-final.json`（常驻探针三趟）、`offline.json`（同一批卡的离线探针）。
- 没 push、没合并、没动 main、没动别的 worktree；没调用任何播报 / 通知脚本。
