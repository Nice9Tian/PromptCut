# AGENT 报告：在线浏览器模式用户卡的五处遗留（claude/online-user-cards-2）

分支 `claude/online-user-cards-2`，worktree `.worktrees/online-user-cards-2`，起点 main `2e1518a3`（v0.7.1，含上一轮 `claude/online-user-cards` 的全部改动）。端口段 5740～5749。

代号说明：「C10 契约」指 `docs/plan/c10-contract.md`（在线浏览器模式的实现契约），第 9 节是用户卡与图卡；「K1」是常驻探针（打开项目时在加载遮罩下测每张卡的成本）；「K5」是前后台两个舞台互换。

## 状态

五处都已做完，验收项全部通过（见「验证」）。导出像素基线没跑（任务书约定由主会话在 PC 上跑）。等主会话审查。

## 提交

| 提交 | 内容 |
|---|---|
| `c4d7174b` | 建本报告 |
| `6bc772f2` | 第 1 处：同步来的用户卡在线能改参数 |
| `48ceba4e` | 第 4 处：在线页面的测量等卡片源码第一次同步完再开始 |
| `9526ef93` | 第 2、3、5 处：图标不叠、不被片段缩小；沙漏按预览缩放放大；刚打开页面不闪图标 |
| `7246dce1` | `online-user-cards-probe` 按五处扩展 |
| `6fcc5cc0` | `preview-fallback-probe` 补沙漏屏幕尺寸的断言 |
| （本次） | 报告写完 |

## 五处各自怎么做的

### 1. 同步来的用户卡在线能改参数

- **解析器**（`src/kernel/cardSourceParse.mjs`）：在原来的词法器上加了一个字面量求值器（`Evaluator`），仍不执行源码。认字符串、没有替换的模板字符串、数字（含负数、十六进制、`1_000`、`1e3`）、布尔、null、数组、对象、括号、尾随的 `as const` / `satisfies X`，以及同文件顶层 `const X = …` 的引用（含对象、数组里的展开和简写属性 `{ defaults }`）。常量互相引用成环时当认不出。
  - `defaults`：不是字面量的键丢掉（嵌套值整个是字面量才留）。
  - `controls`：逐个控件解析（`controlOf`）。`key` / `type` / `label` 不是字面量或缺的那一个跳过；`required`、`hint`、`min`、`max`、`step`、`options`、`kind` 个别不是字面量就丢掉那个字段；类型只认 text / number / select / color / asset。
  - `description` 是字面量就取。
  - 输出多了 `controlsIncomplete`：有控件被跳过，或整个 `controls` 不是字面量时为 true。
- **跳过规则的两处补充**（任务书没写到，按「画得出来」补的）：`select` 丢了 `options`、`asset` 丢了 `kind` 时整个控件跳过（`ParamsForm` 对这两种要 `options.map`，没有会崩）；`asset` 丢了 `options` 按空表（`asset` 本来就不限定取值，手填框照样能用）。
- **同步表**（`src/kernel/registry.ts` 的 `SyncedUserCard`、`src/editor/sync/onlineCardSources.ts` 的 `entriesOf`）：条目带上 `description`、`defaults`、`controls`、`controlsIncomplete`；「内容没变」按这些一起判。舞台的 RPC `setSyncedUserCards` 照旧（多带的字段舞台存着不用）。
- **只读视图** `syncedCardView(id)`：回 `{ id, name, description?, defaults, controls, controlsIncomplete, synced: true }`，冻结，没有组件。**不进主注册表**，`getCard`、`allCards()` 照旧看不到；和构建时的卡撞车的不给视图（内置赢）。换表时这张卡没变就回同一个对象（界面按引用判改动）。
- **界面**：新文件 `src/editor/left/paramsView.ts`（纯函数）。`paramsCardView` 先 `getCard`，没有再用视图；`paramsEmptyText` 在视图的 `controls` 为空且 `controlsIncomplete` 时回 `onlineUnsupported("修改这张卡的参数")`，否则「这张卡没有可调参数」；`clipSubtitleOf` 是时间轴副标题的口径（第一个 text 控件的值 → 默认值 → 说明）。`Inspector.tsx`（订阅同步表，片段头部的卡名也用视图的名字）、`ParamsForm.tsx`（空态加了 `data-pc="params-empty"`）、`ClipView.tsx` 改用它们。
- **改参数的后续流程（核对，没改）**：`actions.setClipParams` 照常经文档服务提交；探针核到另一成员看得到，而且页面随项目版本号变了重发清单计划、仍含这一片段（`planPublisher` 的 `check()` 按 `projectRev` 判）。渲染节点重渲、层表换键之后，在线来源的 `loadMap` 按新键重算就绪、换上新结果——这是已有流程。

### 2. 「需要本地 PC 渲染辅助」图标：不叠、不被片段缩小

- 选了 **JS 算**（没用 CSS 变量加容器查询）：容器查询的条件里不能用 `var()`，排法要按「预览缩放 × 这一层的缩放」换，CSS 做不稳。
- **纯函数** `src/render/placeholderFit.ts`：
  - 目标倍数 `k = viewInverse(预览缩放) / 这一层的 frame.scale`（`viewInverse` = `1 / 预览缩放`，夹在 1/8～16）。
  - 三种排法未放大时的外框（舞台像素，与样式对得上）：横排 198×40、竖排 160×62、只留图标 52×40。
  - 框里能用的宽高 = 框减两倍边距，边距取「4 个屏幕像素」与「框短边的 8%」里小的那个。
  - 按横排 → 竖排 → 只留图标的次序，挑第一个 `尺寸 × k` 放得下的；都放不下就只留图标、按框等比缩小（不小于 0.05 倍）。
  - 框：徽标形态看位置框（`frameBox`），铺满形态看实体框。
- **舞台**（`src/render/placeholderHost.ts`）：父页的预览缩放存在模块里（`setPlaceholderViewScale`）；`placeholderFitFor(clipId, reason, geometry, size, layerScale)` 按上面算，同样的输入回同一个对象（占位组件是 `React.memo`）。`Stage.tsx` 渲占位组件时把 `fit` 传进去（`clip.frame?.scale ?? 1`）。
- **组件**（`placeholder/placeholderPlane.tsx`、`placeholder/contract.ts` 的 `PlaceholderPlaneProps` 加可选 `fit`）：
  - 小徽标：根元素 `translate(-50%, -50%) scale(fit.scale)`，中心在位置框中心；
  - 铺满：里面的图标加字 `scale(fit.scale)`；
  - 根元素带 `data-pc-placeholder-layout`；只留图标时字 `display:none`，`aria-label` 照旧是全文。
- **样式**：排法规则只放在 `PLACEHOLDER_ONLINE_CSS`（只在在线浏览器模式注入），桌面注入的那一份没有排法规则。原来的 CSS 变量 `--pc-ph-ui-scale` 与 `placeholderUiScale` 删掉了。
- 位置与层级：槽位仍在包裹层里、仍按包裹层定位，中心同一处，叠放次序同这一层。

### 3. 沙漏也按预览缩放放大

- `hourglassFit`：倍数 = `min(viewInverse(预览缩放), 框能放下的倍数)`。只抵消预览缩放、**不**抵消这一层的缩放；同样不超出框。
  - 徽标形态：28×28 的圆按倍数放大（根元素 `transform: scale(s)`）；
  - 铺满形态：只放大中间那个 `.pc-ph-center`，噪点照旧铺满实体框、不缩放。
  - 倍数为 1 时不写 transform，DOM 与以前相同。
- `setViewScale` 改成**桌面和在线都发**（`Preview.tsx` 握手时与缩放变化时），舞台都记下。倍数变了、占位开着时 `commitPlanes()` 重渲一次（`StageView.tsx`）。任务书写的是「舞台都设变量」，我实际存在舞台的模块状态里、由 `Stage` 算进内联样式，没再用 CSS 变量：这样才能和第 2 处的排法一起算。效果相同。
- 导出、预渲染、Agent 看到的画面、后台舞台照旧没有占位符：只有前台预览舞台打开占位（`setPlaceholdersEnabled`），这条路没动。导出页（`ExportView`）从不渲占位组件，改动碰不到导出像素。
- 「同屏多个时只有一个沙漏在转」「120 ms 后才显示」没动（转动动画在 svg 上，缩放在外层；显示延迟是根元素的 opacity 动画）。

### 4. 打开页面后最初约 5 秒不测同步卡

- **测量门** `src/editor/measureGate.ts`：在线页面（`onlinePage()`）一开始关着；卡片源码第一次同步有了结果（成功，或回了失败）就开；一直没回音时满 `MEASURE_GATE_MAX_MS = 10_000` 自己开；开了不再关。桌面一开始就开着。
- **接线**：
  - `probeRunner.ts` 的 `runLoop`：在 `whenStageReady("back")` 之后、第一次取成本记录之前 `await whenMeasureGateOpen()`；
  - `Preview.tsx` 低内存档界限搜索的 `tick`：门没开不开工；
  - `Preview.tsx` 卡片源码那段 effect：开始时 `holdMeasureForCardSources()`；`OnlineCardSources` 新增 `onFirstSettled(ok)`，第一次连着共享项目的那一轮列完、取完、写进表时叫 true，列表取不到或回包不对时叫 false，只叫一次；还没连上共享项目的那几轮不算。
- **诊断**：`probeRunner.probeRunDiag()` 记测过的片段（最近 200 条）；`__pcPreviewDiag()` 带出 `probeRun` 与 `measureGate`。

### 5. 刚打开页面时不闪图标：结果在路上时显示沙漏

- **在线来源**（`src/render/snapshotSource.ts`）：
  - `LayerCoverage` 多一个 `unknown`：层表没取到 → `unknown`；层表取到、没有可用的层 → `none`；有哪一段的清单从没取到过 → `unknown`；每段都取到过、这一档的帧不齐 → `partial`；齐 → `full`。
  - 新方法 `frameConfirmedMissing(clipId, localFrame)`：层表已取到、这片段没有可用的层 → true；这一帧所在那一段的清单已取到（内容库回「没有这一段」也算取到）、这一帧这一档不在里面 → true；其余 false。本地帧夹进层的帧数里。
- **父页**（`src/editor/localOnlyMissing.ts` 纯函数 + `Preview.tsx`）：按当前时刻挑出在场（含 LEAD）、本机跑不了的片段，本地帧 = `round((t − start) × fps)`，问在线来源，得到「已确认没有结果」的集合。时刻、项目、覆盖订阅、同步表变了都重算，按舞台记下上次发的，变了才发；握手时重发。
- **新 RPC** `setLocalOnlyMissing(clipIds)`（`stageRpc.ts`）：舞台存进 `placeholderHost` 的 `setLocalOnlyConfirmed`，变了就 `commitPlanes()`。
- **舞台**：
  - `placeholderWanted` 对本机跑不了、又贴不上快照 / 流的片段：已确认 → `unsupported`，否则 → `awaiting`，暂停时也一样；
  - `Stage.tsx` 里原来写死的 `reason="unsupported"` 改成 `localOnlyReason(clip.id)`，槽位的组件能在沙漏与图标之间切。
- **时间轴徽标**（`src/editor/timeline/localPcBadge.ts`）：只有 `none` / `partial` 才出；`unknown` 与「还没有在线来源」（null）不出；覆盖齐了撤掉。

## 验证

笔记本，2026-09-29，命令都在 worktree 根目录跑。在线构建输出到本会话的临时目录 `<tmp>/dist-online`。

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零输出 |
| 全量测试 | `npm test`（PATH 补上 ffmpeg，见 `docs/local.md`） | 3831 条：通过 3829、失败 0、跳过 2，退出码 0 |
| 改到与新增的单测 | `node --experimental-test-module-mocks --test <文件>` | 见下表，全过 |
| 在线构建 | `npx vite build --mode online --outDir <tmp>/dist-online --emptyOutDir` | 退出码 0 |
| `online-user-cards-probe`（5744～5748） | `node scripts/probes/online-user-cards-probe.mjs --dist <tmp>/dist-online --out <tmp>/ouc-shots` | 退出码 0，`ok:true`，`fails:[]` |
| `c10-ui-probe`（5740～5743） | `node scripts/probes/c10-ui-probe.mjs --dist <tmp>/dist-online --proxy-port 5740 --proxy2-port 5741 --doc-port 5742 --asset-port 5743 --out <空目录>` | 退出码 0，`ok:true`，`fails:[]`，A8 `status 501` |
| `preview-fallback-probe`（桌面） | 先起 dev server：`npx vite --port 5747 --strictPort --host 127.0.0.1`（舞台端口 5748 / 5749，在本 worktree 里起）；再跑 `node scripts/probes/preview-fallback-probe.mjs --origin http://127.0.0.1:5747 --out <tmp>/pfb --json <tmp>/pfb.json` | 退出码 0，`PASS`，`fails:[]`；302 拍、透明拍 0、`placeholder-delay` 57 拍；后台舞台 0 个占位节点、没注入样式；生成快照不带占位节点；点中占位符命中所在的卡。dev server 跑完就停了 |

单测明细：

| 文件 | 条数 |
|---|---|
| `src/kernel/cardSourceParse.test.mjs` | 7/7（新增字面量夹具一条；仓库用户卡的 defaults / controls / description 逐字相同；全部 `src/cards` 语料认出的与模块一致、认不全的都标了 `controlsIncomplete`） |
| `src/kernel/registrySynced.test.mjs` | 2/2（新增 `syncedCardView`） |
| `src/editor/left/paramsView.test.mjs`（新） | 3/3 |
| `src/editor/onlineUserCards.test.mjs` | 6/6（新增 OU-04c；OU-03 按「还不知道不出徽标」改） |
| `src/editor/measureGate.test.mjs`（新） | 6/6（桌面恒开、同步成功开、失败开、10 秒兜底、`onFirstSettled`、接线按源码核） |
| `src/editor/localOnlyMissing.test.mjs`（新） | 2/2 |
| `src/render/placeholderFit.test.mjs`（新） | 4/4（含「相邻两个小片段图标不相交」） |
| `src/render/placeholderHost.test.mjs` | 12/12（`placeholderWanted` 改成确认 / 沙漏两路；新增 `placeholderFitFor`；删掉 `placeholderUiScale`） |
| `src/render/placeholder/placeholder.test.mjs` | 7/7（`fit` 与排法规则） |
| `src/render/stageLocalOnly.test.mjs` | 2/2（服务端渲染核：没确认是沙漏、确认了是图标、25% 预览下图标只留图标 `scale(4)`、内置卡沙漏 `scale(4)`；桌面 50% 预览下沙漏 `scale(2)`） |
| `src/render/onlineSnapshotSource.test.mjs` | 13/13（新增两条：层表没到时 `unknown`、不算确认；清单没取到那一段不算确认） |
| `server/test/c10-ui-gates.test.mjs` 与 `snapshotFeed`、`c10a-l17-*`、`c10-cost-plan` | 合跑 48 条，失败 0 |

`online-user-cards-probe` 最后一行 JSON（节选，数字原样）：

```
{"ok":true,"fails":[],
 "sizes":{"column_s2":{"layout":"column","screen":{"w":156.6,"h":62.2},"clipScreen":{"w":170.1,"h":95.7},"textShown":true},
  "icon_s4":{"layout":"icon","screen":{"x":502.4,"y":211.9,"w":52,"h":40},"clipScreen":{"x":485.9,"w":85,"h":47.8},"textShown":false},
  "icon_s5":{"layout":"icon","screen":{"x":587.4,"y":211.9,"w":52,"h":40},"clipScreen":{"x":570.9,"w":85,"h":47.8},"textShown":false},
  "row_s6":{"layout":"row","screen":{"w":194.6,"h":40},"clipScreen":{"w":255.1,"h":143.5},"textShown":true},
  "hourglass_s7":{"reason":"awaiting","screen":{"w":28,"h":28}}},
 "dense":{"samples":16,"firstAt":0,"lastAt":1978,"kinds":{"u":[],"s1":[],"s2":["unsupported"],"s3":["unsupported"]},"firstMapAt":1194,"firstS2IconAt":1194,"firstSnapAt":1978,"bad":[]},
 "params":{"text":"synced","size":"48","side":"left","tint":"#ff8800","types":["input:text","input:number","select:","input:text"]},
 "paramsRemote":{"text":"ouc edited"}, …}
测量:甲测过 ["ouc-b","ouc-x"]、门 synced;乙测过 ["ouc-b","ouc-x"]、门 synced
```

### 屏幕尺寸实测（预览缩放 26.57%，视口 1600×900）

| 情形 | 片段 | 排法 | 屏幕像素 |
|---|---|---|---|
| 图标横排 | s6：框 1920×1080、`frame.scale 0.5` | row | 194.6 × 40.0（片段屏幕框 255×144 之内） |
| 图标竖排 | s2：框 640×360、不缩放 | column | 156.6 × 62.2（片段屏幕框 170×96 之内） |
| 只留图标 | s4、s5：两个 320×180 左右挨着 | icon | 各 52.0 × 40.0，不相交（s4 右缘 554.4 < s5 左缘 587.4），各在自己框内，字藏起来、`aria-label` 是全文 |
| 沙漏（在线） | s7：有层、清单齐、字节取不到 | 徽标 | 28.0 × 28.0 |
| 沙漏（桌面） | `preview-fallback-probe` 的两张药丸 | 铺满 | 预览缩放 0.914、倍数 1.094 → 不计这一层缩放是 28.0；缩放 0.6 的那张跟着这一层缩（语义：继承该层的缩放） |

看过的图（都在 `<tmp>/ouc-shots` 与 `<tmp>/pfb`）：
- `normal-1-stage.png`：u、s1 贴着快照；s2、s3 是竖排图标，各在自己的格子里，不叠。
- `normal-4-sizes-stage.png`：s4、s5 只留图标、并排不叠；s6 横排；s7 是沙漏。
- `normal-4-s4.png`、`normal-4-s6.png`、`normal-4-s7.png`：放大看这三个。
- `normal-3-member-b.png`：乙打开后的样子。
- `after-占位符-旋转与缩放.png`：桌面两张药丸的沙漏与噪点；缩放 0.6 的沙漏跟着这一层变小。

第 5 处的采样：乙从点「加入」起每 100 ms 采样一次，共 16 次、约 2 秒。
- u、s1 在任何一次采样里都没有图标、没有徽标。
- s2、s3 的图标与徽标都在层表取到之后才出（`bad: []`）。
- 这一轮 s2、s3 没采到沙漏：层表在舞台的 120 ms 显示延迟之内就到了，沙漏还没来得及露出来就换成了图标。结果在路上时的沙漏由 s7 与单测核。

## 没做成的及原因

- **导出像素基线**（`verify-determinism`、`verify-unified-frames`）没跑：任务书约定主会话在 PC 上跑。桌面这边改到的只有预览舞台的占位组件（沙漏放大）和 `setViewScale` 的发送，导出页不渲占位组件。
- **「没有它的成本记录」**只核了测量记录：`probeRunDiag` 里没有同步卡片段。L2 的 `costs` 表按身份键存，同步卡在线没有身份，写不进去，所以没另读 L2。
- **换项目之后**：测量门只管页面打开后的第一次同步，开了不再关。换到另一个共享项目时，卡片源码表会清空重取，那几秒里新项目的同步卡又是未知 id，理论上可能被测一次。任务书只要求第一次；要补的话，可以在 `OnlineCardSources` 连接换了时重新关门。
- **观察到的现象（没改）**：未知 id `probe-unknown-card`（两边都没有定义）在两个页面都被常驻探针测过，乙那页有一轮测了 3 次。它有身份键、`Stage` 又不画它，测出来是空的。这不是同步卡，也不是这次的范围，记在这里。

## 与任务书不一致的地方

- 第 1 处：`select` 没了 `options`、`asset` 没了 `kind` 时整个控件跳过，`asset` 没了 `options` 按空表（理由见上）。
- 第 3 处：「舞台都设变量」实际做成舞台模块状态加内联样式，CSS 变量删了（理由见上）。
- 内置卡语料里很多卡展开了从别的文件引进来的 `hudControls`。按「只认同文件字面量」的规矩认不出，会标 `controlsIncomplete`。语料单测因此只要求大头认得出（39 张卡里 17 张全认出，166 个控件认出 125 个）。仓库里的用户卡全认出。

## 建议主会话补进契约第 9 节的句子

- 「识别」末尾补：页面从源码里取卡片的 id 与名字，另取字面量写成的说明、参数默认值与参数控件，给参数面板用。控件逐个解析，认不出的跳过；一个都认不出时，参数面板说明「在线浏览器模式暂不支持修改这张卡的参数」。这份视图不进主注册表，本机仍不运行这张卡。
- 「预览」补：只有父页确认这一帧没有可贴的结果时才出图标。确认的意思是：层表已取到、这片段没有可用的层；或者这一帧所在那一段的清单已取到、这一帧不在里面。层表没取到、清单没到、字节还在路上时显示普通加载占位（沙漏），暂停时也一样。
- 「预览」再补（屏幕大小；数字属三级，可放进 `mechanism/rendering.md`）：图标在屏幕上的大小抵消预览缩放和该层自身的缩放，但不超出该层的框（徽标看位置框，铺满看实体框）。放得下横排就横排，窄了竖排，再小只留图标（全文留在无障碍标签里），图标都放不下时按框等比缩小。沙漏只抵消预览缩放，同样不超出框。
- 「时间轴」补：覆盖情况还不知道时（层表没取到，或有哪一段的清单从没取到过）不挂徽标；只有确认没覆盖整段才挂。
- 新增一条「测量」：在线页面的测量（常驻探针、低内存档的界限搜索）等卡片源码第一次同步有了结果再开始（成功或失败都算），最多等约 10 秒，免得同步卡在认出来之前被当成未知卡去测。

## 需要主会话决定的事

- 审查后合并，还是返工上面「与任务书不一致」的几处。
- 「换项目之后测量门不再关」要不要另开任务补。

## 续做（2026-09-29，主会话转达用户要求：遗留全部修掉）

接着 `8d25fed4` 做，同一分支。

### 提交

| 提交 | 内容 |
|---|---|
| `0ef61804` | 第 3 项：参数面板读不全的参数给提示 |
| `76e61b99` | 第 2 项：两边都没有定义的未知卡不测、不进预渲染集合、不进清单计划 |
| `55377f68` | 第 1 项：换项目时测量门重新关上 |
| `79db9e49` | 测量门诊断加 `links`；探针加换项目与未知卡两段 |
| （本次） | 报告续做一节 |

### 1. 换项目时测量门重新关上

- `src/editor/measureGate.ts` 改成**按连接算**：门记下是为哪条共享项目连接开的（`openFor`）。连接由 `setMeasureGateLink` 给：在线页面的 `Preview` 接到 `currentSharedLink()`，和卡片源码同步用的是同一个取法。
- 问门时（`measureGateOpen` / `whenMeasureGateOpen`），如果此刻的连接不是 null、又不是门开时那一条，就重新关上，重新计时 `MEASURE_GATE_MAX_MS`。换项目、重连到另一个项目、离开再进都走这条。
  - 新连接的卡片源码第一次同步有了结果就开（`releaseMeasureGate(ok, link)`），失败也开，满上限自己开。
  - 旧连接晚到的结果不算。
  - 门开着时新连接的卡片源码先同步完了（还没人问门），直接记下门为它开过，之后不再为它关。
  - 没连着（null）时不关；桌面从不关。
- `OnlineCardSources`：连接换了，新连接的第一轮再叫一次 `onFirstSettled(ok, link)`，带上那一轮用的连接。
- `probeRunner.ts`：
  - 等门从 `runLoop` 开头挪进**每一轮**开头；
  - 一轮里门又关上了就收摊（`gen !== generation || !measureGateOpen()`），下一轮开头再等门。
- 诊断：`measureGateDiag()` 多了三项。`holds` 是关过几次门；`links` 是门为几条连接开过；`confirmedAt` 是最近一次卡片源码同步有结果的时刻。
- 单测 `measureGate.test.mjs` 8/8，新增两条：
  - MG-07：换连接重新关、旧结果不算、满上限开、失败开、先同步完不关、没连着不关、桌面不关；
  - MG-08：`OnlineCardSources` 每条连接叫一次。
- 探针：乙在页面里点「首页」，用同一张表单加入项目二（不刷新页面）。项目二由丁先摆好同步卡片段 `ouc2-s`，卡片源码是另一张同步卡 `probe-synced-card-b`。
  - 断言一：测量门为新连接开过（`links` 1→2），而且是在项目二的卡片源码同步完之后（`confirmedAt` 更新了，`reason: synced`）；
  - 断言二：`ouc2-s` 没被测过。
  - **说明**：这一轮实测里项目二的卡片源码在测量问门之前就同步完了（`holds` 仍是 1），走的是「门开着、记下为新连接开过」那条路。「问门时新连接还没同步完 → 重新关上 → 等」那条路浏览器里没碰上，由 MG-07 单测覆盖。
  - 另外第 2 项之后，同步表到之前被当成未知 id 的同步卡本来就没有测量身份，测不到。测量门这一层是双保险。

### 2. 两边都没有定义的未知卡：不测、不进预渲染集合、不进清单计划

- `src/kernel/registry.ts`：新增两个函数。
  - `isKnownCardId(id)`：注册表里有定义，或者是用户卡（构建时登记的、同步来的）；
  - `unknownCardClipIds(clips)`：写了 `cardId`、两边都不认得的片段。只有 `nodeId` 的图卡片段、素材段不算。
- `src/editor/costIdentity.ts`：桌面与在线都去掉未知卡片段的身份，常驻探针和低内存档界限搜索按身份挑卡，于是都不挑它。
  - 记忆化的键在桌面也带上注册表与同步表的代数：卡片定义到了（热更新、同步到了），未知卡变成认得的卡，身份跟着给。
- `src/editor/planDispatch.ts`：新增 `knownCardsOnly(project)`，喂给 `planPipelines` 之前去掉未知卡片段。
  - 结果：它们不在分派表的任何段里，不当重卡，不进 `prerenderSet`；
  - 页面发的清单计划与低内存档补渲都按 `prerenderSet` 取片段，随之不含它们；
  - 另加 `onCardsUpdated(() => schedule())`：卡片代码换了就重算表。
- 单测：`onlineUserCards.test.mjs` 7/7，新增 OU-05：桌面与在线、普通档与低内存档的两张表都不含未知卡；定义到了以后照常给身份、按声明判重。
- **改了的老测试**（原因都是夹具里的卡没注册，以前被当成「没有身份的重卡」）：
  - `src/render/c10-cost-plan.test.mjs` 的 CP-02、`src/render/c10a-l17-lowmem.test.mjs` 的 C10A-L17-H2：夹具片段的 `card-a` / `card-b` / `card-c` 从没注册过，现在是未知卡、会被去掉。补上注册以后，断言一字未改。
  - `onlineUserCards.test.mjs` 的 OU-01：原来断言桌面上未知 id 有身份，按新规矩改成没有身份。
- **桌面预渲染进程这一侧（核对，没改）**：
  - 页面只少掉未知卡，而舞台本来就不画它，所以什么都没少。
  - 预渲染进程自己的预渲染集合（`server/prerender-set.mjs`，用 `card-cache.mjs` 的 card plan）照旧含未知卡。它在图里有节点，能力按没有定义算：`stateful`、要预渲染。
  - 以前页面测过它、写了一条很轻的成本记录，两端键相同，预渲染进程因此判它轻；现在页面不测，那边查不到记录，按声明判重，会**多**预渲染一段空画面。页面不贴它（它不在页面的预渲染集合里），不影响画面，只是多花点算力。K2（两端各算一张表、应当逐字段相同）对未知卡不再一致。
  - 要彻底一致，得让 card plan 跳过没有定义的卡。那一层挨着生成快照的键，这次没动，建议另开任务。
- 探针：甲、乙两页的测量从头到尾没测过 `ouc-x`；两页的清单计划 `lastClips` 都不含它；低内存档补渲在等的片段与日志里也没有它。

### 3. 读不全的参数给提示

- `src/editor/left/paramsView.ts` 新增 `paramsPartialText`：同步卡的控件只认出一部分时（`controlsIncomplete` 为 true、`controls` 非空），回 `onlineUnsupported("修改这张卡的其余参数")`；其余情形回 null。一个都没认出的，照旧走空态那句。
- `ParamsForm.tsx`：认出的控件照常画，下面加一行提示（`data-pc="params-partial"`）。
- 单测 `paramsView.test.mjs` 4/4，新增 PV-04。

### 验证（笔记本，2026-09-29）

| 项 | 结果 |
|---|---|
| `npx tsc -b --force` | 退出码 0，零输出 |
| 改到的单测 | `paramsView` 4/4、`onlineUserCards` 7/7、`measureGate` 8/8、`c10-cost-plan` 6/6、`c10a-l17-lowmem` 7/7 |
| `npm test` | 3835 条：通过 3833、失败 0、跳过 2，退出码 0 |
| 在线构建 `npx vite build --mode online --outDir <tmp>/dist-online --emptyOutDir` | 退出码 0 |
| `online-user-cards-probe`（5744～5748） | 退出码 0，`ok:true`，`fails:[]` |
| `c10-ui-probe`（5740～5743） | 退出码 0，`ok:true`，`fails:[]`，A8 `status 501` |
| `preview-fallback-probe`（dev server 起在 5747，舞台 5748/5749，跑完停掉） | 退出码 0，`PASS`，`fails:[]`；313 拍、透明拍 0；沙漏不计这一层缩放是 28 屏幕像素；后台舞台 0 个占位节点；生成快照不带占位节点 |

`online-user-cards-probe` 最后一行 JSON（节选）：

```
{"ok":true,"fails":[],
 "sizes":{"column_s2":{"screen":{"w":156.6,"h":62.2}},"icon_s4":{"screen":{"w":52,"h":40}},"icon_s5":{"screen":{"w":52,"h":40}},"row_s6":{"screen":{"w":194.6,"h":40}},"hourglass_s7":{"screen":{"w":28,"h":28}}},
 "dense":{"samples":13,"firstMapAt":1807,"firstS2IconAt":2474,"firstSnapAt":2474,"bad":[]},
 "params":{"text":"synced","size":"48","side":"left","tint":"#ff8800"},"paramsRemote":{"text":"ouc edited"},
 "measure":{"a":{"probed":[{"clipId":"ouc-b"}],"gate":{"reason":"synced","holds":1,"links":1}},"b":{"probed":[{"clipId":"ouc-b"}],"gate":{"reason":"synced"}}},
 "switchProject":{"gateBefore":{"links":1,"confirmedAt":1790643499621},"gate":{"reason":"synced","holds":1,"links":2,"confirmedAt":1790643510179},"probed":[{"clipId":"ouc-b"}]},
 "unknownX":{"a":{"probed":[{"clipId":"ouc-b"}],"plan":["ouc-s1","ouc-s2","ouc-s3","ouc-s4","ouc-s5","ouc-s6","ouc-s7","ouc-u"]},"b":{"probed":[{"clipId":"ouc-b"}],"plan":["ouc2-s"]}},
 "lowmem":{"backfill":{"waiting":["ouc-s3","ouc-s4","ouc-s5","ouc-s6","ouc-s7"]}}}
```

### 续做后的遗留

- ~~预渲染进程对未知卡按声明判重、多预渲染一段空画面（见第 2 项）~~：已在「续做（二）」修掉。
- 换项目时「重新关门再等」那条路只有单测覆盖，浏览器里新项目的卡片源码都赶在问门之前同步完了（见第 1 项）。
- 导出像素基线仍待主会话在 PC 上跑。

### 建议主会话补进契约第 9 节的句子（续）

- 「识别」再补：两边都没有定义的未知卡，不测、不进预渲染集合、不进清单计划与补渲，桌面与在线一致。
- 「测量」那条补：测量门按连接算，换项目、重连到另一个项目、离开再进时重新等新项目的卡片源码第一次同步有结果，上限同样约 10 秒。
- 参数面板：同步卡的控件只认出一部分时，照常画认出的，下面提示「在线浏览器模式暂不支持修改这张卡的其余参数」。

## 续做（二）：预渲染进程这一侧与页面一致（2026-09-29）

接着 `636716e1` 做，同一分支。

### 提交

| 提交 | 内容 |
|---|---|
| `f3f40b19` | 未知卡片不进预渲染进程的卡片计划 |
| （本次） | 报告续做（二） |

### 做了什么

- **哪里判重**：预渲染进程的卡片计划来自预渲染间页面（`ExportView.tsx`）的 `__pcCardPlan()`：图由 `projectCardGraph(project, getCard)` 算。
  - 查不到定义的卡片段照样有一个 `chrome` 节点，能力按 `cardCapabilities(undefined)` 取：`frameMode: stateful`、`need_prerendering: true`、`compositing: unknown`。
  - `CardFrameCache.plan()`（`server/card-cache.mjs`）给它出一个本地档控件；服务端的预渲染集合（`server/prerender-set.mjs`）没有成本记录时走 `declaredHeavy`、有成本记录时走 `planPipelines` 里的 `clipWeight` 兜底，两条路都按这份缺省能力判它重。
- **做法**：只把「这些片段不出控件」这件事加进去，图、节点、身份算法一律不动。
  - `ExportView.tsx` 的 `__pcCardPlan()` 多回一项 `unknownClipIds`：预渲染间自己的注册表里查不到定义的卡片段，用第 2 项加的 `registry.unknownCardClipIds`。预渲染进程里没有同步表，所以这就是「构建时表和同步表都没有」。
  - `CardFrameCache.plan()` 读它，遍历输出时跳过这些片段。节点身份（`cardNodeIdentities`）在跳过之前照整张图算，所以别的片段的键逐字不变，未知卡当别的卡的输入时也一样。
  - 服务端所有预渲染工作都从 `entry.cardPlan`（即 `plan()` 的结果）出发：`recordCardPlan`、`adoptCardPlan`、预渲染集合、渲染节点细任务、层表 `layerMapOf`、`renderState` 的缺口。所以未知卡不排预渲染、不进服务端预渲染集合，层表里也没有它那一层。「按没有定义的缺省能力判重」那两处（`declaredHeavy`、`clipWeight` 的兜底）不再碰得到它。`cardCapabilities(undefined)` 本身没改：它参与节点身份，改了会动键。
- **没动的文件**：`createSnapshot.ts`、`src/render/snapshot/*`、`snapshotRename.ts`、`server/bakery/*`、`frame-code.mjs`、`server/frame-pipeline.mjs`、`server/frame-identity.mjs` 都没动（`git diff 636716e1 --stat` 对这些路径为空）。`card-cache.mjs` 不在 `CAPTURE_FILES` / `SNAPSHOT_FILES` 里。

### 核对

- **键不变**（新单测 `server/test/card-cache-unknown.test.mjs`，4/4）：
  - CU-01：同一个项目带或不带一个未知卡片段，其余片段的 `key`、`contentKey`、`snapshotKey`、`cacheContentKey`、`costKey`、结果键逐字相同；未知卡片段没有控件；跳过前后只少了它这一项。
  - CU-02：图卡滤镜节点吃未知卡片段的输出（`@clip/x/source`），另一个片段指向这个滤镜。那个片段照常有控件，键与不跳过时逐字相同。
  - CU-03：`prerenderSetOfPlan` 两条路（没有成本记录、有成本记录）都不含未知卡片段；不带 `unknownClipIds`（旧行为）时它按缺省能力判重，这就是修掉的副作用。
  - CU-04：导出页 `__pcCardPlan` 带上 `unknownClipIds`（按源码核）。
- **桌面打开带未知卡的项目，预渲染进程不再为它排活**（小实验，不入库）：
  - 做法：vite 服务端载入真的 `src/cards/index.ts`（注册表 99 张卡），加真 `projectCardGraph`、导出页同一算法的 `unknownClipIds`、真 `CardFrameCache.plan`、真 `prerenderSetOfPlan`。项目里有内置卡 `punch-pill`、仓库用户卡 `mu-animated-shiny-text`、未知 id `probe-unknown-card`。
  - 改前：计划里有 x（`tier: local`、`compositing: unknown`、`needPrerendering: true`），没有成本记录时的预渲染集合是 `["b","u","x"]`。
  - 改后：计划里只有 u、b，预渲染集合是 `["b","u"]`；u、b 的控件与改前逐字节相同（`othersSame: true`）。
- **在线页面贴图、补渲不受影响**：
  - 页面侧只读层表与清单。未知卡本来就不在页面的预渲染集合里（第 2 项），页面既不贴它也不为它补渲。桌面节点少写的只是未知卡那一层空画面。
  - `online-user-cards-probe` 照旧全过：有层的 u、s1 贴快照，s2 补层后几秒内换上，低内存档补渲清单是 `["ouc-s3","ouc-s4","ouc-s5","ouc-s6","ouc-s7"]`、没有 `ouc-x`。
  - `c10-ui-probe` 的 A6（用户卡与内置卡照取清单与字节、覆盖齐不挂徽标）照旧全过。

### 验证（笔记本，2026-09-29）

| 项 | 结果 |
|---|---|
| `npx tsc -b --force` | 退出码 0，零输出 |
| 新增单测 `server/test/card-cache-unknown.test.mjs` | 4/4 |
| `npm test` | 3839 条：通过 3837、失败 0、跳过 2，退出码 0（原有的 `card-cache`、`env-fingerprint-keys`、`prerender-executor` 等都在内） |
| 在线构建 | 退出码 0 |
| `online-user-cards-probe`（5744～5748） | 退出码 0，`ok:true`，`fails:[]` |
| `c10-ui-probe`（5740～5743） | 退出码 0，`ok:true`，`fails:[]`，A8 `status 501` |
| `preview-fallback-probe`（dev server 起在 5747，舞台 5748/5749，跑完停掉） | 退出码 0，`PASS`，`fails:[]`；289 拍、透明拍 0；沙漏 28 屏幕像素；后台舞台 0 个占位节点；生成快照不带占位节点；页面错误 0 |

`online-user-cards-probe` 最后一行 JSON（节选）：

```
{"ok":true,"fails":[],
 "sizes":{"column_s2":{"screen":{"w":156.6,"h":62.2}},"icon_s4":{"screen":{"w":52,"h":40}},"icon_s5":{"screen":{"w":52,"h":40}},"row_s6":{"screen":{"w":194.6,"h":40}},"hourglass_s7":{"screen":{"w":28,"h":28}}},
 "dense":{"samples":13,"firstMapAt":1230,"firstS2IconAt":1695,"firstSnapAt":2021,"bad":[]},
 "paramsRemote":{"text":"ouc edited"},
 "switchProject":{"gateBefore":{"links":1},"gate":{"reason":"synced","links":2},"probed":[{"clipId":"ouc-b"}]},
 "unknownX":{"a":{"probed":[{"clipId":"ouc-b"}],"plan":["ouc-s1","ouc-s2","ouc-s3","ouc-s4","ouc-s5","ouc-s6","ouc-s7","ouc-u"]},"b":{"probed":[{"clipId":"ouc-b"}],"plan":["ouc2-s"]}},
 "lowmem":{"backfill":{"waiting":["ouc-s3","ouc-s4","ouc-s5","ouc-s6","ouc-s7"]}}}
```

### 与 0.7.x 混用

- 旧版桌面节点（没有这次改动）照旧会为未知卡排活、写那一层空画面，新页面不贴它，不影响。
- 新版桌面节点收到旧页面发的清单计划时：旧页面的清单计划里可能带着未知卡片段（旧页面测过它，判轻就不带；没测到才带）。新节点的卡片计划里没有它，这一段不产结果，同样不影响画面。
