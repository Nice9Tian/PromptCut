# 卡片能力审阅表（`capabilities.json` 的注释本）

JSON 放不下注释，所以审阅结论和理由写在这里。**改 `capabilities.json` 必须同时改这份文档。**

审阅日期：2026-09-17（目标 A0）。范围：仓库默认注册的 **89 张卡**
（`docs/archive/topics/default-animation-card-inventory.md`：MagicUI 6 + 自家功能卡 24 + Lottie 素材卡 5 + 粒子素材卡 53 + 探针 1）。

## 1. 这张表管什么

| 字段 | 取值 | 谁说了算 |
|---|---|---|
| `compositing` | `independent` / `sourceDependent` / `belowDependent` | **只有这张表**。源码里写的这三个值一律忽略（`frameMode.mjs` 的 `reviewedCompositing`） |
| `canvasHeavy` | `true` | 表优先，表里没有才读 `CardDef.canvasHeavy` |
| `frameMode` | `direct` / `stateful` | 表优先，表里没有才读 `CardDef.frameMode`（A0.1 已经把 31 个文件写死了，所以这张表**一条都不写** `frameMode`，避免两处真相） |

轴三（pinned「卡片划分」轴三）的口径：

- `independent` —— 只画自己。可以单独预渲染、上云共享。
- `sourceDependent` —— 拿指定的另一段画面当输入（转场）。向上追溯整条链路，链上任一控件的参数哈希变了就失效。
- `belowDependent` —— 毛玻璃 / 后处理：同一时刻下层任一控件的参数哈希变了就失效。
- 表里没有、`CardDef` 也没有 → `unknown`（A0.5）：按重管线处理但没有死素材（透明）、不进任何缓存、不进流。

`context` 是 `sourceDependent` / `belowDependent` 的旧统称，只为读老 `.proc` 保留，**新审阅不许再写**。

### 通配

键可以写成 `前缀-*`。查表顺序：先精确 id，再取**最长**的 `前缀-*`。
表里只有一条通配 `"particles-*"`，覆盖 53 张粒子素材卡。注意 `particles-*` 的前缀带连字符，
所以它**不**匹配通用粒子卡 `particles`（那张单列了一条）。

### 一改就作废

`cardCapabilities` 的结果经 `cardGraph.mjs` 的 `capabilities` 进身份 digest。
**改这张表 = 全部共享键和本地缓存作废**，这是 A0.1(b) 接受的代价。

## 2. 结论汇总

| compositing | 张数 | 卡 |
|---|---:|---|
| `independent` | 77 | 除下面 12 张之外的全部（含 53 张粒子、5 张 Lottie、组合卡） |
| `belowDependent` | 12 | 12 个用 `hud-glass` 的自家卡 |
| `sourceDependent` | 0 | 仓库里现在没有「拿另一段画面当输入」的注册卡 |
| `unknown` | 0 | 验收要求 |

`canvasHeavy: true` 共 **55** 张：53 张粒子素材卡（通配）+ 通用粒子卡 `particles` + `scene-3d`。

## 3. 判据

**`belowDependent` 的唯一来源是 `hud-glass`。** `src/cards/native/hud.css:30` 的 `.hud-glass`
带 `backdrop-filter: blur(var(--pc-glass-blur, 24px))` —— 它采样自己身后已经合成好的画面，
所以下层任何一张卡的参数变了，这张卡的预渲染结果就不作数。全仓库 `backdrop-filter` 只有这一处
（另一处 `src/ExportView.tsx:218` 是注释，`src/themes/index.ts:10` 是变量说明）。
用 `className="hud-glass"` 的正好 12 个文件，和规格里说的「12 个 `hud-glass` 文件」对上。

**读像素零命中。** `getImageData` / 跨层 `drawImage(` 在 `src/cards` 下没有卡片使用。
`scene-3d.tsx:148` 出现 `drawImage(canvas)` 是注释，讲的是**编辑器**去读这张卡的画布，
方向相反，不构成对下层的依赖。

**`canvasHeavy` 的判据是「画面载体是 canvas / WebGL」**，不是「重」。
`particles`（tsParticles，Canvas 2D）和 `scene-3d`（three.js，WebGL）是仅有的两张；
`terminal-3d` 的立体感来自 CSS 透视，**没有 canvas**；Lottie 用的是 SVG renderer，按 DOM 卡算
（和 A0.3「Lottie 5 张按 DOM 卡」一致）。`focus-card` 里的是 `<video>`，不是 canvas。

**自身 `filter: blur()` 不算依赖下层。** `punch-pill.tsx:17` 和 `blur-text.tsx:34` 的 `blur()`
模糊的是自己的元素，不采样身后画面。`blur-text` 判 `belowDependent` 是因为它另外用了 `hud-glass`，
不是因为这个 `filter`。

## 4. 高频清单逐张（62 张）

高频清单 = inventory `:19` 的「首次面板展示 62 张」= 36 张非粒子卡 + 26 张精选粒子卡。

### 4.1 MagicUI（6 张，全 `independent`）

| id | 决定 | 理由 |
|---|---|---|
| `mu-number-ticker` | independent | Motion 弹簧改数字，纯 DOM 文本 |
| `mu-blur-fade` | independent | Motion 对自身做 `filter: blur` + 位移，不采样身后 |
| `mu-circular-progress` | independent | rAF 插值 + SVG 描边 |
| `mu-typing` | independent | rAF 改已显示字符，纯文本 |
| `mu-word-rotate` | independent | AnimatePresence 换词 |
| `mu-animated-shiny-text` | independent | CSS keyframes 高光，`background-clip` 作用在自己身上 |

### 4.2 自家功能卡（24 张）

| id | 决定 | 理由 |
|---|---|---|
| `composite` | **不进表**，由部件推导 | 见第 5 节 |
| `lottie` | independent | `LottieView` 走 SVG renderer，只画自己；非 canvas |
| `particles` | independent + `canvasHeavy` | tsParticles 画在自己的 canvas 上；画布不透明区之外是透明的，不读下层 |
| `scene-3d` | independent + `canvasHeavy` | three.js WebGL，按 `t` 算姿态后显式 render；只画自己 |
| `caption-track` | independent | 唯一的 `direct` 卡，纯文本字幕；虽然 `import "./hud.css"`，但没有用 `hud-glass` |
| `entity-chips` | independent | 同上：引了 hud.css，用的是定位类，不是玻璃板 |
| `pin-board` | independent | 同上 |
| `punch-pill` | independent | 同上；`filter: blur(32px)` 是自己的辉光底 |
| `quote-lockup` | independent | 同上 |
| `type-shift` | independent | 同上 |
| `ui-callout` | independent | 同上（DOM + SVG 引导线） |
| `focus-card` | independent | 人物窗口用 `<video>` + Motion，画自己。放的是它自己参数里的素材，不是别的片段的画面，所以不是 `sourceDependent` |
| `blur-text` | **belowDependent** | `blur-text.tsx:29` `<div className="hud-glass">` |
| `chapter-bar` | **belowDependent** | `chapter-bar.tsx:55` |
| `checklist` | **belowDependent** | `checklist.tsx:60` |
| `growth-curve` | **belowDependent** | `growth-curve.tsx:95` |
| `odometer` | **belowDependent** | `odometer.tsx:44` |
| `rank-bars` | **belowDependent** | `rank-bars.tsx:48` |
| `ring-metric` | **belowDependent** | `ring-metric.tsx:41` |
| `stat-proof` | **belowDependent** | `stat-proof.tsx:42` |
| `step-timeline` | **belowDependent** | `step-timeline.tsx:21` |
| `term-card` | **belowDependent** | `term-card.tsx:16` |
| `terminal-3d` | **belowDependent** | `terminal-3d.tsx:62`；它的 3D 是 CSS 透视，不是 canvas |
| `versus-card` | **belowDependent** | `versus-card.tsx:31`、`:57` 两块玻璃板 |

### 4.3 Lottie 素材卡（5 张，全 `independent`）

`lottie-adrock` / `lottie-bodymovin` / `lottie-gatin` / `lottie-happy2016` / `lottie-navidad`。
五张共用 `LottieView`（SVG renderer），各自只画自己的动画，互不采样，也不是 canvas 卡。

### 4.4 探针（1 张）

`probe` —— 一个绝对定位的文本 div，`independent`。

### 4.5 精选粒子卡（26 张，通配 `particles-*` 覆盖）

`basic` `big` `bigBlend` `bubble` `colorAnimation` `fallingConfetti` `gradients` `groups` `lch`
`life` `linkTriangles` `nasa` `orbit` `parallax` `plasma` `poisson` `random` `repulse` `slow`
`snow` `spin` `star` `strokeAnimation` `triangles` `twinkle` `vibrate`（id 前缀 `particles-`）。

53 张全部共用 `ParticlesView` + `translateParticlesConfig`，差别只在 JSON 配置：同一个渲染器、
同一块自有 canvas、同一套「只画自己」的结论，所以合并成一条通配。非精选的另外 27 张
（`backgroundCanvas` `bigBlendCombo` `clickPause` `collisionsAbsorb` `collisionsBounce` `delay`
`delayColor` `delayOpacity` `delaySize` `delayStrokeColor` `destroy` `destroyExplode` `effectBubble`
`effectFilter` `effectParticles` `effectTrailTransform` `grabRandomColor` `lightHover` `mouseAttract`
`mouseDestroy` `mouseDrag` `mouseParticle2` `moveAngle` `moveDistance` `moveInside` `moveOutside`
`noClear`）走同一条通配，结论相同。

> 配置名里的 `mouse*` / `clickPause` / `lightHover` 是上游示例的交互演示。舞台上没有鼠标，
> 这些交互不触发；它们仍然只画自己的 canvas，`independent` 不受影响。

## 5. 组合卡（A0.4）

`composite` **不写进表**，由部件树推导，最保守者胜
（保守程度 `independent` < `sourceDependent` < `belowDependent` < `context` < `unknown`）。
实现：`frameMode.mjs` 的 `derivedCompositing(parts)` + `DERIVED_FROM_PARTS`。

推导拿的是**部件出处的卡 id**（`PartDef.from`，26 个部件全都写了）。
但是 `clip.parts` 上存的是 `PartInstance.partId`（部件 id），要换成卡 id 得查部件注册表
（`src/kernel/partRegistry.ts`，只有浏览器侧的 `.tsx` 能加载）。`cardGraph.mjs` 两端都跑，
**不能一端查得到、一端查不到**，否则身份 digest 会在浏览器和 Node 之间分叉。
所以 `cardGraph.mjs` 只把 `clip.parts` 原样传进去，解析不出卡 id 的部件按 `unknown` 计：

- 没有部件的组合卡（只有占位文字）→ `independent`；
- 有部件的组合卡 → `unknown`（A0.5 的保守档），等把部件注册表接到两端之后再收紧。

真出现「审阅表说 independent、实际却有毛玻璃」的情况，由第 6 节的运行期兜底接住。

## 6. 运行期兜底（A0.2 末句）

`src/render/capabilityGuard.ts` 在卡片挂载后扫一遍子树的 computed style，
量到 `backdrop-filter !== 'none'` 而审阅表说 `independent` 的，`console.warn` 并调
`degradeCard(id)`。`cardCapabilities` 读这张降级表，本次会话内把它当 `belowDependent`。
闸门在 `shouldGuard()`：只有 `import.meta.env.DEV`、且 URL 上没有 `export=` / `frames=` / `bake=` 才跑；
每张卡一辈子只量一次（`resetGuardScans` 只给单测用）。导出、预渲染、冻结快照那条路上
一个 `getComputedStyle` 都不会执行，逐像素基线不受影响。`Stage.tsx` 只多了一个 `ref`，DOM 一个字不变。

## 7. 不在这张表里的卡

**用户项目内嵌卡。** `.pc-work/opened/` 下 27 个 `.proc` 一共内嵌 4 张卡，已经审过：

| id | 画面 | 该判 |
|---|---|---|
| `wa-texture` | 源码里有 `backdrop-filter` | `belowDependent` |
| `tokyo7-cta` | 纯 DOM | `independent` |
| `tokyo7-map` | 纯 DOM / SVG | `independent` |
| `zen-title` | 纯 DOM | `independent` |

它们**不写进 `capabilities.json`**：这份表随仓库发布，不能被某一台机器上的项目改写；
项目内嵌卡跟着 `.proc` 走，该有自己的随项目审阅表（后续目标）。在那之前它们按 A0.5 判
`unknown` —— 比上表的结论更保守，不会画错，只是不进缓存。

**部件（`src/parts/lib/*`，26 个）** 不是 `CardDef`，不单独计入 89 张，也不进这张表；
它们的能力经第 5 节的推导从出处卡带过来。
