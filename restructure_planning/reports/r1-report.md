# R1 差异样式内联收尾 — 执行报告

- worktree: `C:\Users\admin\Documents\PromptCut\.claude\worktrees\agent-adeb228e063d62f45`
- 分支: `worktree-agent-adeb228e063d62f45`（未 push、未合并、没动 main、没动别的 worktree）
- 基线: `7f10ebe`（开工时 worktree HEAD 停在 `c98a3cc`，落后 main 三个提交，已 `git reset --hard 7f10ebe` 对齐）
- 日期: 2026-09-22
- 探针原始输出: 同目录 `r1-data/`

## 提交

| | |
|---|---|
| `4692f00` | 生成快照:snapshotFreeze 改名拆成 createSnapshot 三件套,样式内联改按差异口径 |
| `4108b55` | 探针:成本记录从一个 frameMs 拆成 stepMs / inlineMs / rasterMs / serializeMs,判重只看 stepMs |
| `778ed62` | 探针:新增 snapshot-diff-compare(同一页同一时刻出新旧两份快照,逐像素比对) |
| `688ead5` | 审计:按新实现重跑快照体积探针,报告改成 DOM / canvas 分列 |

> 提交结尾的 Co-Authored-By 用的是系统给定的 `Claude Opus 5 (1M context)`，不是派单里写的
> `Claude Fable 5.1` —— 本次实际跑的模型是 Opus 5，写别的会话署名不符事实。要改随时可以 rebase 改写。

---

## 1. 改名拆文件（任务书 3.8）

| 旧 | 新 |
|---|---|
| `src/render/snapshotFreeze.ts` / `freezeScene(root)` | `src/render/createSnapshot.ts` / `createSnapshot(root)`（`git mv`，历史保留） |
| （无） | `src/render/snapshot/inlineStyles.ts` — `inlineDOMStyles` |
| （无） | `src/render/snapshot/rasterizeCanvas.ts` — `rasterizeCanvas` |
| （无） | `src/render/snapshot/snapshotStyleProps.mjs` + `.d.mts` — 两张属性表 |
| `window.__bfFreeze` | `window.__pcCreateSnapshot` |
| `freezeCode` / `FREEZE_FILES` | `snapshotCode` / `SNAPSHOT_FILES` |
| `FrozenScene` / `FrozenControl` | `SceneSnapshot` / `ControlSnapshot` |
| （无） | `server/test/snapshot-style-props.test.mjs`、`scripts/probes/inherited-props-probe.mjs`、`scripts/probes/snapshot-diff-compare.mjs` |

`createSnapshot` 里按 3.8 的顺序调五步：`cloneScene` → `inlineDOMStyles` → `rasterizeCanvas` →
`stripMedia` → `serializeScene`。`inlineStyles.ts` 与 `rasterizeCanvas.ts` **互不 import**：
canvas 换 `<img>` 要按 IMG 基线另算一份样式串，衔接写在 `createSnapshot.ts` ——
`inlineDOMStyles` 返回 `styleAs(el, tag, ns)`，`createSnapshot` 把它转给 `rasterizeCanvas`；
IMG 的基线由 `inlineDOMStyles(root, orig, copy, ["IMG"])` 的第四个参数预热，
这样 `rasterizeCanvas` 第一次问基线时不会临时挂探针、把时间算进 `rasterMs`。

`SNAPSHOT_FILES` = 七个 `server/bakery/*` + `capture-snapshot.mjs` + `src/render/createSnapshot.ts`
+ `snapshot/inlineStyles.ts` + `snapshot/rasterizeCanvas.ts` + `snapshot/snapshotStyleProps.mjs`
+ `src/render/snapshotRename.ts`。**旧快照全部作废，预期之内。**

文档和注释里不再用「冻结」指这件事（`src/`、`server/`、`scripts/`、`docs/` 全扫过一遍），
改叫生成快照 / 样式内联 / 画布栅格化。

## 2. 差异样式内联（底稿 A2(8)）

逻辑整体取自参考实现（`agent-af0dae85c12674862`），`ensureBaselines` / `animatedProps` /
`forcedProps` / `buildStyle` 整体归 `inlineStyles.ts`。口径完全照底稿：

- **继承属性**和父元素的计算值比（快照顶层元素 = 场景根 / 包裹层直接子节点，一律全内联）；
- **布局解析值属性**一律内联；
- 其余非继承属性和**同标签基线**比；
- 基线按 `namespaceURI + tagName + themeId`（themeId 用场景根的内联 `style` 串当版本号）缓存在
  场景根的 `WeakMap` 上，SVG 用 `createElementNS`（塞进一个真 `<svg>` 里），**一次挂、一次读、一次摘**，
  探针容器绝对定位、零尺寸、挪到视口外；
- canvas 换 `<img>` 那一支按 **IMG 的基线**另算；
- `animation:none !important;transition:none !important;` 照旧每个元素都写；
- 两道兜底强制内联：元素自己 `style` 里写过的属性、被动画 / 过渡改写的属性
  （整棵树一次 `root.getAnimations({ subtree: true })`，不逐元素问）。

## 3. 探针与成本记录（任务书 3.3 / 3.8）

- 舞台 `render` / `setTime` 的 probe 回包按帧累加生成快照的三段耗时；
  `stepMs = elapsedMs − (inlineMs + rasterMs + serializeMs)`；`catchUpMs` 跟着只算活渲。
- **`setTime(probe)` 的 `stepMs` 在等那一次真 rAF 之前取值** —— 3.8 末条点名要修的量法问题已修。
- `capped = stepMs > B`，`direct` 和 `stateful` 两条路都改了。
- `frameMs` 删干净（`src` / `server` / `scripts` 里零命中；`server/frame-playback.mjs` 的同名字段
  是播放节拍的另一件事，没动）。
- 记录加 `mode: 'dev' | 'build'`，**`mode` 同时拼进 `device` 串** —— 去重键是 `(identityKey, device)`，
  不拼进去两种模式会互相覆盖。`--mode` 缺省按 `/@vite/client` 的 Content-Type 自动判。
- `filterCosts(costs, device, mode)`，缺 `mode` 字段的旧记录当 `'dev'`；`GET /api/data/costs` 支持 `&mode=`。
- 探针写回显式带 `demoted: false`，**完全不碰 `pinnedHeavy`**（实测落盘的 62 条里 0 条带这个字段）。
- `src/render/cardCostKey.d.mts` 的 `CardCostRecord`、`src/render/stageRpc.ts` 的 `probe` 事件类型、
  `docs/snapshot-size-audit.md` 的列都同步了。
- `probe-card-costs.mjs` 加 `--mode` 和 `--json`。

## 4. `configurePreviewServer` —— **没做**

任务书说「能干净地移过来就移，费事就不做」。**费事，没做**，理由：

1. 它只为在 `vite preview` 的构建产物（`mode=build`）上跑探针服务，而任务书 3.1 已经把
   「分派只认 build 记录」作废了 —— 桌面版跑的就是 dev server，**dev 才是真实运行环境**，
   本次验收要的也是 dev 的数。build 记录只对将来的在线浏览器模式有意义。
2. 光补四个插件的 `configurePreviewServer` 还不够用：`probe-card-costs.mjs` 的宿主页是直接
   `import('/src/cards/index.ts')` 拿卡片注册表的，`dist/` 里没有 `/src/**`，必须再加一套把注册表
   单独打包成探针 kit 的东西（参考实现的 `scripts/probes/probe-kit.ts` +
   `build-probe-kit.mjs`，74 + 44 行，还要在 puppeteer 里加一层请求拦截来挂载 `/__probe/**`）。
   这一整块都没有验收过，风险和收益不成比例。

代码里留了指路：`scripts/probe-card-costs.mjs` 文件头「dev 还是 build」一节末尾写明了缺什么、
去哪儿抄；`mode` 这一半（检测 + 拼 device + 记录字段 + 过滤）**已经全部做好**，
将来补上 kit 和 preview server 就能直接跑 build 那一趟。

## 5. 两张仍超 300 KB 的 `lottie-*`（不选，请主会话定）

按新实现重测（dev server 5197，62 张全部测通）：

| | 前（`docs/snapshot-size-audit.md` 2026-09-17） | 后（2026-09-22） |
|---|---|---|
| 单帧快照 max | 23107 KB | **915.3 KB** |
| 超 300 KB 的 DOM 卡 | 12 张 | **2 张**（`lottie-bodymovin` 915.3、`lottie-navidad` 855.0） |
| DOM 卡 p90（全体 34 张） | — | **185.8 KB**（≤ 300 KB，过） |
| DOM 卡 p90（排除 `lottie-*`，29 张） | — | **47.8 KB** |
| canvas 卡位图 p90 / max（28 张） | — | **465.6 / 628.0 KB**（上限 1 MB，过） |

两张卡的细节（差异内联已经把它们各砍掉 96～97%）：

| 卡 | control KB | 整场景 KB | 标签数 | 内联样式 KB | 样式占比 | 2 核 60 fps 下的样式内联 ms |
|---|---|---|---|---|---|---|
| `lottie-bodymovin` | 915.3 | 928.2 | 2534 | 648.4 | 71% | 466.2 |
| `lottie-navidad` | 855.0 | 869.5 | 2090 | 573.5 | 67% | 525.1 |

**两条路各自的代价**（我不选）：

**(甲) 改走 lottie 的 canvas 渲染器**（`lottie-web` 的 `renderer: 'canvas'`）
- 收益：这两张卡从「2000+ 个 SVG 节点、每个都要内联差异样式」变成「1 个 canvas」。
  按同机 canvas 卡的实测推算，快照体积落到位图那一档（p90 465.6 KB / max 628.0 KB，都在 1 MB 内），
  `inlineMs` 从 466～525 ms 掉到 2～3 ms，`serializeMs` 从 48～177 ms 掉到 1～3 ms。
  A3c 的三条上限一次全过，`lottie-*` 这一族不再是特例。
- 代价与风险：
  1. **画面会变**，而且是必然变的那种 —— SVG 走矢量光栅化、canvas 走位图，文字抗锯齿和描边末位
     一定对不上。导出逐字节基线（`docs/export-baseline-compare.md`）会在这两张卡上破，
     得重新立基线；`scripts/verify-determinism.mjs` 一类的也要复核。
  2. canvas 渲染器**没有 DOM 实体框** —— 实体几何（`solid.ts` 的 `rects` / `hitTest`）现在靠
     SVG 子树量，改完只剩 `canvasPaintedBox` 扫像素这一条，点选和边界框的精度会掉一档。
  3. 这五张卡（`lottie-*`）会从 DOM 卡变成 canvas 卡，**轴二分类改变** → 审阅表要改
     （`canvasHeavy`）、`snapshotTier` / 共享键 / 分派都跟着走另一条分支；R9 的共享 WebGL
     渲染器落地时它们也要跟着迁。
  4. 改动面在卡片实现里（`src/cards/` 的 lottie 卡 + 审阅表），不在 R1 的范围内；
     落地后所有 lottie 快照作废一次。
  5. lottie-web 的 canvas 渲染器不支持部分 SVG 特性（表达式、部分蒙版 / 遮罩模式）。
     **这五个 .json 用没用到，我没查** —— 真要走这条路，先花一次时间逐个核。

**(乙) 审阅表加 `prerender: false` 开关**
- 收益：改动最小、最快，只在审阅表加一个布尔量 + 分派时读它。画面一个像素都不变，
  导出基线不动，实体几何不动，轴二分类不动。
- 代价与风险：
  1. 这不是「把卡变小」，是**承认它进不了预渲染** —— 这两张卡永远活渲。
     按 2 核 60 fps 的实测，它们的 `stepMs` 只有 5.5（navidad）/ 3.5（bodymovin）ms，
     远在 B = 11.67 ms 之内，**活渲完全跑得动**，所以「永远活渲」在今天是安全的。
  2. 但它和 pinned 渲染 7「任一位置判重的整段完整预渲染」有张力：`prerender: false` 是一个
     **声明**，而用户目标反复强调「靠实测、不靠声明」。要不要开这个口子，是目标层面的事，
     必须你来定（我倾向：如果开，就把它限定成「体积超上限时的兜底」，判据仍是实测体积，
     不让它变成一个可以随手标的通用开关）。
  3. 一旦这张卡在某个位置真的判重（换机器、换 fps、叠卡），它就没有死素材可贴 ——
     按现在的规则那一层透明。这是 (乙) 唯一真正的画面风险。
  4. 新开关要落到 `src/kernel/frameMode.mjs` 的审阅表、`server/snapshot-store.mjs` 的
     `snapshotTier`、K2 的 `planPipelines` 三处，并在 R4 之前定下来。

**我的观察（供参考，不是结论）**：(乙) 在今天够用且零画面风险，(甲) 是治本但会破坏导出基线
并改变一族卡的分类。如果 R8 轨道流按第 7 节第 2 条排进来，(乙) 的第 3 条风险会自动消失
（判重的卡有流可贴），那时 (乙) 的性价比更高。

---

## 6. 验收

dev server = 5197（我自己起的，跑完已关，端口已确认释放）；
基线 dev server = 5198（临时 worktree `.claude/worktrees/r1-baseline-7f10ebe`，`7f10ebe`，
**已 `git worktree remove`，没建 junction、没跑 `npm ci`**）。
开跑前 `Get-Counter '\Processor(_Total)\% Processor Time'` = 5.3 / 7.0 / 11.7%。

### 6.1 `npx tsc -b --force`
**零错误**（每个提交后都跑，最后又跑了一次）。

### 6.2 `npm test`
**tests 1472 / pass 1471 / fail 0 / skipped 1**。
新增 5 条：`server/test/snapshot-style-props.test.mjs` 4 条（属性表按 Chrome 152 实测对账）
+ `server/test/costs.test.mjs` 的 `filterCosts 按 mode 过滤` 1 条。
（基线 `7f10ebe` 是 1467 / 1466 / 0 / 1。）

### 6.3 `node scripts/verify-bake-protocol.mjs`
`PASS: 25 个 window.__* 全部在 docs/bake-page-protocol.md 的两栏里（HTML 路 17 / PNG 路 8），
导出页与舞台页都挂了 __pcCreateSnapshot。`

### 6.4 `node scripts/verify-unified-frames.mjs` —— **main 上就不过，不是 R1 引入的**

同一条命令在两棵树上跑，**失败点逐字相同**：

| | R1 分支（5197） | 基线 `7f10ebe`（5198） |
|---|---|---|
| `:46 assert.equal(…see_frames(project,[.8]).get(8).source, 'rendered')` | `AssertionError: 'mov' !== 'rendered'` | **一模一样** |
| 放宽 `:46` 后继续跑到 `:55 'export must exactly match see_frames'` | `AssertionError` | **一模一样** |

放宽 `:46` 的那一趟里，**R1 真正关心的两条都过了**：
`:45 track bitmap round-trip differs by at most two channel levels` 和
`:50 C must exactly match the A pipeline` —— 后者正是「HTML 快照 → `captureSnapshot` →
`see_frames`」这条链，也是差异样式内联唯一碰得到的地方。

原始输出：`r1-data/verify-unified-frames-r1.log`、`r1-data/verify-unified-frames-baseline.log`。
**结论：`verify-unified-frames.mjs` 在 `7f10ebe` 上已经坏了两处**（`see_frames` 第二次取帧
从 mov 出、导出与 see_frames 不再逐字节相等）。要不要修、归谁修，请你定 —— 它是 R0 清账级别的事。

### 6.5 差异样式内联前后的位图逐像素比对 —— **全部逐字节相同**

`node scripts/probes/snapshot-diff-compare.mjs --origin http://127.0.0.1:5197`
（同一页、同一时刻出新旧两份 HTML，各走一次 `captureSnapshot`，1280×720，帧 12 / 45）：

| 卡 | 帧 | 结果 | control 快照 KB（前 → 后） | 省 |
|---|---|---|---|---|
| `lottie-bodymovin` | 12 | 逐字节相同 | 22804.8 → 606.4 | 97% |
| `lottie-bodymovin` | 45 | 逐字节相同 | 23048.3 → 856.2 | 96% |
| `growth-curve` | 12 / 45 | 逐字节相同 | 488.1 → 41.4 | 92% |
| `odometer` | 12 / 45 | 逐字节相同 | 2200.6 → 143.1 | 93% |
| `scene-3d` | 12 | 逐字节相同 | 300.4 → 275.2 | 8% |
| `scene-3d` | 45 | 逐字节相同 | 218.5 → 193.3 | 12% |

（`scene-3d` 省得少，是因为它的 control 里绝大部分字节是 canvas 位图的 data URI，差异内联碰不到。）
PNG 与 JSON：`r1-data/snapshot-diff/`。

### 6.6 导出逐字节基线 —— **240 / 240 逐字节相同**

按 `docs/export-baseline-compare.md` 的跑法，fixture 照该文档第 1 节那张表自己造
（1280×720 / 30 fps / 8 秒 / 240 帧，六条轨道：`punch-pill` + `odometer` + `mu-word-rotate`、
`chapter-bar`、`growth-curve`、`scene-3d`、`particles`、一段 `testsrc2` 视频；
fixture 在 `r1-data/export-fixture/project.json`）。

```
基线（7f10ebe 那棵树的脚本 + 5198）240 帧，15.2 s
候选（R1 分支 + 5197）           240 帧，15.0 s
逐字节：相同 240/240
✅ 全长导出逐字节相同
```

这一条覆盖的是导出里真正走 `__pcCreateSnapshot` 的那条路（`bake.mjs` 的 `shoot()` 在
非 `glassFrames` / 非 `fullFrame` 时就是用 HTML 快照栅格化），所以它**不是**护栏而是实打实的验收。

### 6.7 快照体积（`scripts/probes/snapshot-size-probe.mjs`，dev 5197，62 张全测通）

见第 5 节的表。报告已重新生成到 `docs/snapshot-size-audit.md`（新增第 3 节 DOM / canvas 分列；
逐卡表的「冻结 ms」一列换成生成快照 / 样式内联 / 画布栅格化 / 序列化四列）。
原始数据：`r1-data/snapshot-size.json`。

### 6.8 成本探针 —— dev server，62 张高频卡，fps 30，B = 23.33 ms

`node scripts/probe-card-costs.mjs --origin http://127.0.0.1:5197 --fps 30 --force`
（先跑一趟 `--dry-run` 取数，再跑一趟真写；62 条全部 PUT 成功、GET 回来一条不缺，
`mode: 'dev'` 62 条、`demoted: false` 62 条、带 `pinnedHeavy` 0 条、带 `frameMs` 0 条）

| 量 | p50 / p90 / max |
|---|---|
| **`stepMs`（活渲单帧最差，唯一进判重）** | **1.30 / 2.70 / 6.60 ms** |
| `inlineMs`（样式内联） | 6.10 / 23.00 / 367.20 ms |
| `rasterMs`（画布栅格化） | 0.10 / 35.70 / 93.60 ms |
| `serializeMs`（序列化） | 0.80 / 1.90 / 148.90 ms |
| **按 `stepMs > B` 判重的张数** | **0 张** |

和任务书第 2 节那张表里的 dev 行（`stepMs` p50/p90/max = 1.3 / 2.5 / 6.9）**基本重合**，
口径换了之后数没漂，说明四数拆分没有改变测的是什么。

最贵的几张，哪类病一眼可见（3.8 想要的效果）：
- `inlineMs`（DOM 太复杂）：`lottie-bodymovin` 367.2、`lottie-navidad` 316.0、`lottie-adrock` 131.4、
  `lottie-happy2016` 79.2、`odometer` 41.3
- `rasterMs`（画布太大）：`particles` 93.6、`particles-colorAnimation` 37.7、`particles-star` 36.8
- `serializeMs`：`lottie-navidad` 148.9、`lottie-bodymovin` 45.6（其余全在 6 ms 以内）
- `stepMs`：`particles-groups` 6.6、`focus-card` 4.5、`particles-basic` 3.7

原始数据：`r1-data/costs-dev-fps30.json`（dry-run）、`costs-dev-fps30-put.json`（真写）、
`out/card-costs.json`（落盘的 62 条）。

### 6.9 成本探针 —— 钉 2 个核（`start /affinity 3`）、fps 60，B = 11.67 ms

dev server 和探针都用 `cmd /c start /affinity 3 /b [/wait] node …` 起；
已确认 vite 进程的 `ProcessorAffinity = 3`（探针的 Chrome 由同一条 `start /affinity 3` 派生，继承掩码）。

**`lottie-navidad` 这次测完了 —— 62 / 62，零失败。**
上一次（任务书 2.1(a)）它在生成快照上超时、只跑完 61 张；
四数拆分之后生成快照不再挤在同一个预算里，它的成绩是
`stepMs 5.5 / inlineMs 525.1 / rasterMs 0.2 / serializeMs 177.0 / catchUpMs 306`。

| 量 | 2 核 60 fps（本次） | 任务书 2.1(a) 的同口径 |
|---|---|---|
| `stepMs` p50 / p90 / max | **2.40 / 4.90 / 21.20 ms** | 2.7 / 8.2 / 33 ms |
| 按 `stepMs > B` 判重 | **3 张**：`particles-lch` 21.2、`lottie-happy2016` 18.5、`scene-3d` 15.1 | 3 张：`particles-orbit` 33、`particles-snow` 31.8、`particles-slow` 19.9 |
| 连 30 fps 的 23.33 ms 也超的 | **0 张** | 2 张 |
| `inlineMs` p50 / p90 / max | 11.70 / 49.60 / 525.10 ms | — |
| `rasterMs` p50 / p90 / max | 0.20 / 35.50 / 116.50 ms | — |
| `serializeMs` p50 / p90 / max | 0.60 / 2.50 / 177.00 ms | — |

**「判重 3 张」这个数稳，「是哪 3 张」不稳** —— 两次跑出来的三张完全不重合，
而且都落在 12～33 ms 这一段（噪声量级和信号量级相当）。2 核上的单帧最差本来就抖，
任务书第 7 节第 2 条「2 核 60 fps 下有 3 张粒子卡判重」这个结论**方向仍然成立**
（低配 / 60 fps 下确实有卡越线，重管线不是可有可无），
但**不该按卡名下结论**。建议那句改成「有个位数张卡越线，具体哪几张随机器与噪声浮动」。

原始数据：`r1-data/costs-2core-fps60.json` / `.log`。

---

## 7. 任务书 / 底稿要改的句子（逐条）

1. **3.8「探针分开上报」**：「`stepMs`（活渲单帧最差，**唯一进判重的数**）」这句和现状里
   「`stepMs`：随机访问卡为 `null`」冲突。`frameMs` 一删，随机访问卡就没有能进判重的数了。
   **改**：明确写「`direct` 卡的 `stepMs` 由 `setTime(t, { probe: true })` 在**等那一次真 rAF 之前**
   取值，不再是 `null`；`CardCostRecord.stepMs` 的类型从 `number | null` 收紧成 `number`」。（已按此实现。）

2. **3.8「代码结构」那一段列了五个函数，但「探针分开上报」只给了三个耗时数**，
   `cloneScene` 和 `stripMedia` 的时间没有归属，而同段又要求「预渲染一帧的成本 ≈
   `stepMs + inlineMs + rasterMs + serializeMs`」（要求三个数覆盖整趟）。
   **改**：补一句归属 —— 「`cloneScene` 并进 `inlineMs`（同样按元素数线性增长，和『DOM 太复杂』
   是同一个病因），`stripMedia` 并进 `serializeMs`」。（已按此实现，理由写在 `createSnapshot.ts` 文件头。）

3. **3.8「跟着改名的地方」里 `FREEZE_FILES` 的说法**：原文只说「`FREEZE_FILES` 清单同步新文件」，
   但 `server/frame-code.mjs` 里那段注释明确写着「J1 之后**这里不再加文件**」——照字面做就不会加，
   拆出来的三个模块会漏出指纹外，改它们不作废快照，共享快照会被错误复用。
   **改**：把那句注释改成「只在快照代码自己拆文件时跟着加，集合要恰好覆盖决定快照内容的那些文件」。（已改。）

4. **3.1 / 3.8 与「`configurePreviewServer`」的关系**：底稿 A2(8) 说「探针用
   `--origin http://127.0.0.1:5191` 打 `vite preview`；K2 只认 `'build'` 的记录」，
   这两句已被 3.1 作废（分派用当前运行模式），但**底稿原文还在**，容易误导下一个人。
   **改**：底稿 A2(8) 那两句加一条「已被 `render_pipeline_restructure.md` 3.1 作废」的旁注。
   另外要补一句：**光补四个插件的 `configurePreviewServer` 跑不起来**，
   宿主页还要一套把卡片注册表打成独立 kit 的东西（`dist/` 里没有 `/src/**`）。

5. **底稿 A2(8) 的 `INHERITED_PROPS` 清单**（「`color`、`font` 各分量、…」那一长串）写的是**简写**
   （`font`、`list-style`、`text-emphasis`），而 `getComputedStyle` 枚举的是 longhand，
   写简写永远命不中。**改**：那一串前面加「以下按族写，落地时一律展开成 longhand」，
   或者直接指向 `src/render/snapshot/snapshotStyleProps.mjs`（已有单测钉住「表里不许有简写」）。

6. **R1 的验收清单里「`scripts/verify-unified-frames.mjs` 通过」做不到**，
   因为它在 `7f10ebe` 上就已经不过（见 6.4）。**改**：把它挪到 R0 清账，
   先查「`see_frames` 第二次取帧从 mov 出」和「导出与 see_frames 不再逐字节相等」这两处是谁弄坏的。

7. **第 7 节第 2 条「2 核、60 fps 下有 3 张粒子卡判重」**：张数对，卡名不对（见 6.9）。
   **改**：「有个位数张卡越线，具体哪几张随机器与噪声浮动（两次实测的三张完全不重合）」。

8. **3.3「`catchUpMs` 只有一个定义:逐帧推进耗时之和、不含冻结；…被预算截断时按已推帧的平均外推」**：
   实测下来**62 张全部被截断**——`StageView.render` 的截断判据是「本次 `render` 自开始起累计
   墙钟 > B」，而不是「单帧 > B」，整段推完必然远超 B，所以 `catchUpMs` **永远是外推值**，
   从来不是「实测总时间」。这是 R1 之前就有的行为，我没动。
   **改**：要么把 3.3 那句改成「`catchUpMs` 一律按已推帧的平均外推到整段」（承认现状），
   要么在 R4 把截断判据改成按帧计。**请你定**，我只记录。

9. **文档措辞**：`docs/snapshot-size-audit.md` 的「A3c 快照体积审计」标题和第 1 节仍写
   「超出 300 KB 的卡按任务书先做『相对 UA + 主题基线的差异样式内联』」——已改成「已在 R1 落地，
   本次实测是落地之后的数」。（已改。）

---

## 8. 没做完 / 没把握的地方

1. **`configurePreviewServer` 和 `mode=build` 那一趟没跑**（见第 4 节）。`mode` 的代码路径全做好了，
   但 build 记录一条都没有。R4 如果要 build 数，得先补探针 kit。
2. **`verify-unified-frames.mjs` 的两处失败没修** —— 不在 R1 范围，而且 main 上就坏了（见 6.4）。
3. **`vtOk` / `seekOk` / `seekMs` 照旧离线不测**（那是 R4 常驻探针的事，父页够不到 `pinner`）。
4. **`src/render/solid.ts` 没进 `SNAPSHOT_FILES`**：`rasterizeCanvas` import 了它的 `canvasPaintedBox`，
   改那个函数会改 `data-pc-painted-box` 的值。拆分前 `snapshotFreeze.ts` 也是这样，我**保持了原状**
   没扩大失效面。严格说它该进（那是写进快照 HTML 的属性），但加进去会把 `solid.ts` 的每次改动
   都变成一次全量快照作废。请你定要不要加。
5. **2 核 60 fps 那一趟的「判重是哪几张」不可复现**（见 6.9）。如果 R4 的分派要拿这个数当依据，
   得先解决 2 核下单帧最差的噪声（比如同一卡多跑几趟取中位，而不是取单次 max）。
6. **lottie 的 canvas 渲染器支不支持这五个 `.json` 用到的全部特性，我没查**（第 5 节 (甲) 第 5 条）。
7. **`git worktree` 的临时基线树已经删干净**，`git worktree list` 里只剩本来就有的那几个；
   `out/media/pc-baseline-fixture.mp4` 和 `out/card-costs.json` 留在我的 worktree 的 `out/` 里
   （`out/` 本来就不进版本控制）。

## 9. 跑过的命令（可复现）

```bash
# dev server（我的 worktree 根）
npx vite --port 5197 --strictPort --host 127.0.0.1

npx tsc -b --force
npm test
node scripts/verify-bake-protocol.mjs
node scripts/probes/snapshot-diff-compare.mjs --origin http://127.0.0.1:5197 --out <r1-data>/snapshot-diff
node scripts/probes/snapshot-size-probe.mjs  --origin http://127.0.0.1:5197 --json <r1-data>/snapshot-size.json
node scripts/probe-card-costs.mjs --origin http://127.0.0.1:5197 --fps 30 --force --dry-run --json <r1-data>/costs-dev-fps30.json
node scripts/probe-card-costs.mjs --origin http://127.0.0.1:5197 --fps 30 --force          --json <r1-data>/costs-dev-fps30-put.json

# 导出逐字节基线（基线树 = 7f10ebe 的临时 worktree + 5198）
node scripts/probes/export-baseline-compare.mjs run --tree <baseline-tree> --origin http://127.0.0.1:5198 \
  --project <r1-data>/export-fixture/project.json --out <r1-data>/export-fixture/baseline
node scripts/probes/export-baseline-compare.mjs run --origin http://127.0.0.1:5197 \
  --project <r1-data>/export-fixture/project.json --out <r1-data>/export-fixture/candidate \
  --baseline <r1-data>/export-fixture/baseline/frames

# 钉 2 个核、60 fps
cmd /c "start /affinity 3 /b cmd /c \"node <repo>/node_modules/vite/bin/vite.js --port 5197 --strictPort --host 127.0.0.1\""
cmd /c "start /affinity 3 /b /wait cmd /c \"node scripts\probe-card-costs.mjs --origin http://127.0.0.1:5197 --fps 60 --force --dry-run --json <r1-data>\costs-2core-fps60.json\""
```
