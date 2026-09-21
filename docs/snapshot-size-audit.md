# A3c 快照体积审计（高频清单实测）

实测日期 2026-09-22。跑法：`node scripts/probes/snapshot-size-probe.mjs --origin http://127.0.0.1:5197`，
dev 模式的 dev server（`/src/*` 现场变换），后台舞台（`?stage=1&id=back`，`setRole('back', { job: 'probe' })`）。
每张卡一条轨道一个 `4` 秒的 clip、参数取默认值，fps 30；在 0.3 s / 中点 / 收尾前 0.1 s 三个本地时刻各生成一次快照
（`stateful` 卡用 `render(t, { jump: true, maxCatchUp: Infinity })` 真推到那一刻，`direct` 卡用 `setTime(t)`），
取三次里最大的一帧。量的是 `window.__pcCreateSnapshot()` 回来的 `controls[0].html` —— 也就是包裹层 innerHTML、
差异样式已内联的**原始**体积，不含投递前的 deflate + base64。

机器：Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/152.0.0.0 Safari/537.36。

## 1. 三条上限（任务书 A3c）

| 口径 | 上限 |
|---|---|
| DOM 卡：单 clip 单帧原始快照 | **≤ 300 KB** |
| canvas 卡：位图 `toDataURL('image/webp', 0.9)`（带 alpha），单帧 | **≤ 1 MB** |
| 一次 `setSnapshots(patch, opts)` 投递 | **≤ 2 MB** |

「相对 UA + 主题基线的差异样式内联」已在 R1 落地（`src/render/snapshot/inlineStyles.ts`），
本次实测是落地**之后**的数。

## 2. 清单与总览

- 高频清单 62 张 = inventory `:19` 的默认可见卡（非粒子卡全要 + 目录标 `featured` 的粒子卡）
  + 12 个 `hud-glass` 文件里的卡。
- 测通 62 张，失败 0 张。
- 全体最大帧：p50 **95.5 KB**、p90 **384.8 KB**、max **915.3 KB**。
- 超 300 KB 的 DOM 卡 **2** 张；超 1 MB 的 canvas 卡 **0** 张。
- 按 p90 估一次「10 张活跃卡全换」的投递：约 **3.76 MB**，> 2 MB，得按 A3c 拆成两次投递。

## 3. 按 DOM / canvas 分列的 p50 / p90 / max

差异样式内联的验收口径是**分列**的（任务书 A2(8)：「不要拿 62 张混算的 p90 当门槛」）——
全体 p50 / p90 那两个样本落在粒子 canvas 卡上，而差异样式内联碰不到它们的位图。

| 口径 | 张数 | p50 KB | p90 KB | max KB |
|---|---|---|---|---|
| **DOM 卡**（门槛 300 KB） | 34 | 23.9 | 185.8 | 915.3 |
| DOM 卡（排除 `lottie-*`） | 29 | 20.9 | 47.8 | 143.1 |
| **canvas 卡**位图（门槛 1 MB） | 28 | 193.6 | 465.6 | 628.0 |
| canvas 卡整份 control | 28 | 204.3 | 476.3 | 638.8 |
| 全体（仅供对照，不是门槛） | 62 | 95.5 | 384.8 | 915.3 |

## 3b. 按族的 p50 / p90 / max

| 族 | 张数 | p50 KB | p90 KB | max KB |
|---|---|---|---|---|
| MagicUI | 6 | 14.6 | 17.4 | 17.4 |
| hud-glass 自家卡 | 11 | 27.9 | 48.9 | 143.1 |
| lottie-*(DOM/SVG) | 5 | 296.3 | 915.3 | 915.3 |
| particles-*(canvas) | 26 | 201.8 | 410.1 | 638.8 |
| three.js / canvas 通用卡 | 3 | 227.1 | 519.1 | 519.1 |
| 其它自家卡 | 11 | 16.2 | 25.2 | 25.5 |

## 4. 超标的卡

### 4.1 DOM 卡超 300 KB（2 张）

| 卡 | 族 | 最大帧 KB | 整场景 KB | 标签数 | 内联样式 KB | 样式占比 | 建议 |
|---|---|---|---|---|---|---|---|
| lottie-bodymovin | lottie-*(DOM/SVG) | 915.3 | 928.2 | 2534 | 648.4 | 71% | 差异样式内联已落地；仍超标的两条路见任务书 R1 末条（改走 lottie 的 canvas 渲染器 / 审阅表标 `prerender: false`） |
| lottie-navidad | lottie-*(DOM/SVG) | 855.0 | 869.5 | 2090 | 573.5 | 67% | 差异样式内联已落地；仍超标的两条路见任务书 R1 末条（改走 lottie 的 canvas 渲染器 / 审阅表标 `prerender: false`） |

## 5. 逐卡（三个时刻里最大的一帧）

| 卡 | 族 | 帧模式 | 控件 KB | 整场景 KB | 其中位图 KB | 内联样式 KB | 样式占比 | canvas | 标签数 | 生成快照 ms | 样式内联 ms | 画布栅格化 ms | 序列化 ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| lottie-bodymovin | lottie-*(DOM/SVG) | stateful | 915.3 | 928.2 | 0.0 | 648.4 | 71% |  | 2534 | 419.4 | 365.6 | 0.1 | 53.7 |
| lottie-navidad | lottie-*(DOM/SVG) | stateful | 855.0 | 869.5 | 0.0 | 573.5 | 67% |  | 2090 | 440.6 | 316.2 | 0.1 | 124.3 |
| particles-basic | particles-*(canvas) | stateful | 638.8 | 651.1 | 628.0 | 10.6 | 2% | 是 | 3 | 26.0 | 2.4 | 22.3 | 1.3 |
| scene-3d | three.js / canvas 通用卡 | stateful | 519.1 | 531.4 | 508.3 | 10.6 | 2% | 是 | 3 | 26.4 | 2.6 | 22.6 | 1.1 |
| particles-life | particles-*(canvas) | stateful | 476.3 | 488.7 | 465.6 | 10.6 | 2% | 是 | 3 | 22.8 | 2.9 | 18.7 | 1.2 |
| particles-big | particles-*(canvas) | stateful | 410.1 | 422.5 | 399.4 | 10.6 | 3% | 是 | 3 | 26.5 | 2.7 | 22.9 | 0.9 |
| particles-poisson | particles-*(canvas) | stateful | 384.8 | 397.2 | 374.1 | 10.6 | 3% | 是 | 3 | 20.8 | 2.5 | 17.3 | 1.0 |
| particles-bigBlend | particles-*(canvas) | stateful | 324.7 | 337.0 | 313.9 | 10.6 | 3% | 是 | 3 | 23.2 | 2.5 | 20.0 | 0.7 |
| particles-random | particles-*(canvas) | stateful | 313.1 | 325.4 | 302.3 | 10.7 | 3% | 是 | 3 | 21.0 | 2.6 | 17.6 | 0.8 |
| lottie-happy2016 | lottie-*(DOM/SVG) | stateful | 296.3 | 308.7 | 0.0 | 166.3 | 56% |  | 498 | 79.9 | 77.2 | 0.0 | 2.7 |
| particles-parallax | particles-*(canvas) | stateful | 288.5 | 300.9 | 277.7 | 10.6 | 4% | 是 | 3 | 23.1 | 2.5 | 20.0 | 0.6 |
| particles-plasma | particles-*(canvas) | stateful | 257.5 | 269.9 | 246.8 | 10.6 | 4% | 是 | 3 | 19.3 | 2.4 | 16.3 | 0.6 |
| particles-repulse | particles-*(canvas) | stateful | 250.7 | 263.1 | 240.0 | 10.6 | 4% | 是 | 3 | 19.2 | 2.4 | 16.2 | 0.6 |
| particles | three.js / canvas 通用卡 | stateful | 227.1 | 239.4 | 216.3 | 10.6 | 5% | 是 | 3 | 24.5 | 2.5 | 21.5 | 0.5 |
| particles-colorAnimation | particles-*(canvas) | stateful | 211.9 | 224.3 | 201.2 | 10.6 | 5% | 是 | 3 | 22.6 | 2.4 | 19.7 | 0.5 |
| particles-linkTriangles | particles-*(canvas) | stateful | 204.4 | 216.7 | 193.6 | 10.6 | 5% | 是 | 3 | 18.5 | 2.4 | 15.5 | 0.6 |
| particles-fallingConfetti | particles-*(canvas) | stateful | 204.3 | 216.7 | 193.6 | 10.6 | 5% | 是 | 3 | 18.8 | 2.4 | 15.8 | 0.6 |
| particles-twinkle | particles-*(canvas) | stateful | 201.8 | 214.2 | 191.1 | 10.6 | 5% | 是 | 3 | 18.7 | 2.4 | 15.9 | 0.4 |
| particles-vibrate | particles-*(canvas) | stateful | 200.6 | 213.0 | 189.9 | 10.6 | 5% | 是 | 3 | 18.9 | 2.6 | 15.8 | 0.5 |
| particles-slow | particles-*(canvas) | stateful | 199.7 | 212.1 | 189.0 | 10.6 | 5% | 是 | 3 | 19.1 | 2.4 | 16.2 | 0.5 |
| lottie-adrock | lottie-*(DOM/SVG) | stateful | 185.8 | 198.2 | 0.0 | 130.2 | 70% |  | 456 | 73.2 | 71.2 | 0.0 | 2.0 |
| particles-lch | particles-*(canvas) | stateful | 179.9 | 192.3 | 169.2 | 10.6 | 6% | 是 | 3 | 18.7 | 2.5 | 15.7 | 0.5 |
| particles-star | particles-*(canvas) | stateful | 156.9 | 169.2 | 146.1 | 10.6 | 7% | 是 | 3 | 22.1 | 2.4 | 19.3 | 0.4 |
| particles-gradients | particles-*(canvas) | stateful | 149.3 | 161.6 | 138.5 | 10.6 | 7% | 是 | 3 | 17.9 | 2.7 | 14.7 | 0.5 |
| odometer | hud-glass 自家卡 | stateful | 143.1 | 155.5 | 0.0 | 135.9 | 95% |  | 244 | 42.6 | 42.1 | 0.0 | 0.5 |
| particles-strokeAnimation | particles-*(canvas) | stateful | 131.4 | 143.8 | 120.7 | 10.6 | 8% | 是 | 3 | 18.0 | 2.4 | 15.1 | 0.4 |
| particles-groups | particles-*(canvas) | stateful | 121.9 | 134.2 | 111.1 | 10.6 | 9% | 是 | 3 | 19.3 | 4.2 | 14.8 | 0.3 |
| particles-triangles | particles-*(canvas) | stateful | 117.0 | 129.3 | 106.2 | 10.6 | 9% | 是 | 3 | 18.7 | 2.4 | 16.0 | 0.3 |
| particles-orbit | particles-*(canvas) | stateful | 112.1 | 124.5 | 101.3 | 10.7 | 10% | 是 | 3 | 20.4 | 2.4 | 17.6 | 0.4 |
| particles-spin | particles-*(canvas) | stateful | 108.5 | 120.8 | 97.7 | 10.6 | 10% | 是 | 3 | 22.0 | 2.4 | 19.2 | 0.4 |
| particles-snow | particles-*(canvas) | stateful | 95.5 | 107.9 | 84.8 | 10.6 | 11% | 是 | 3 | 19.5 | 2.3 | 16.9 | 0.3 |
| particles-nasa | particles-*(canvas) | stateful | 91.6 | 103.9 | 80.6 | 10.8 | 12% | 是 | 3 | 18.1 | 2.4 | 15.5 | 0.2 |
| particles-bubble | particles-*(canvas) | stateful | 86.7 | 99.1 | 76.0 | 10.6 | 12% | 是 | 3 | 20.5 | 2.5 | 17.8 | 0.2 |
| lottie-gatin | lottie-*(DOM/SVG) | stateful | 74.6 | 86.9 | 0.0 | 55.3 | 74% |  | 182 | 29.2 | 28.4 | 0.0 | 0.8 |
| step-timeline | hud-glass 自家卡 | stateful | 48.9 | 61.3 | 0.0 | 47.1 | 96% |  | 62 | 11.8 | 11.7 | 0.0 | 0.1 |
| rank-bars | hud-glass 自家卡 | stateful | 47.8 | 60.1 | 0.0 | 46.1 | 97% |  | 64 | 13.6 | 13.4 | 0.0 | 0.2 |
| checklist | hud-glass 自家卡 | stateful | 46.9 | 59.3 | 0.0 | 44.5 | 95% |  | 60 | 12.4 | 12.1 | 0.0 | 0.3 |
| growth-curve | hud-glass 自家卡 | stateful | 41.4 | 53.8 | 0.0 | 38.8 | 94% |  | 54 | 12.0 | 11.6 | 0.0 | 0.4 |
| term-card | hud-glass 自家卡 | stateful | 27.9 | 40.3 | 0.0 | 27.3 | 98% |  | 36 | 7.9 | 7.7 | 0.0 | 0.2 |
| terminal-3d | three.js / canvas 通用卡 | stateful | 27.3 | 39.7 | 0.0 | 26.3 | 96% |  | 30 | 7.7 | 7.4 | 0.0 | 0.3 |
| focus-card | 其它自家卡 | stateful | 25.5 | 37.8 | 0.0 | 24.4 | 96% |  | 34 | 7.5 | 7.3 | 0.1 | 0.1 |
| entity-chips | 其它自家卡 | stateful | 25.2 | 37.5 | 0.0 | 24.4 | 97% |  | 28 | 6.6 | 6.5 | 0.0 | 0.1 |
| chapter-bar | hud-glass 自家卡 | stateful | 24.6 | 37.0 | 0.0 | 24.1 | 98% |  | 22 | 5.5 | 5.4 | 0.0 | 0.1 |
| stat-proof | hud-glass 自家卡 | stateful | 24.5 | 36.9 | 0.0 | 23.8 | 97% |  | 26 | 6.4 | 6.3 | 0.0 | 0.1 |
| versus-card | hud-glass 自家卡 | stateful | 23.9 | 36.2 | 0.0 | 22.9 | 96% |  | 22 | 6.6 | 6.4 | 0.0 | 0.1 |
| ring-metric | hud-glass 自家卡 | stateful | 21.8 | 34.1 | 0.0 | 21.0 | 96% |  | 22 | 5.6 | 5.3 | 0.0 | 0.3 |
| pin-board | 其它自家卡 | stateful | 21.1 | 33.5 | 0.0 | 20.4 | 97% |  | 18 | 5.1 | 5.0 | 0.0 | 0.1 |
| blur-text | hud-glass 自家卡 | stateful | 20.9 | 33.2 | 0.0 | 20.6 | 99% |  | 22 | 5.7 | 5.5 | 0.0 | 0.2 |
| quote-lockup | 其它自家卡 | stateful | 17.8 | 30.2 | 0.0 | 17.3 | 97% |  | 16 | 4.5 | 4.4 | 0.0 | 0.1 |
| mu-circular-progress | MagicUI | stateful | 17.4 | 29.8 | 0.0 | 16.8 | 96% |  | 14 | 5.6 | 5.4 | 0.0 | 0.2 |
| probe | 其它自家卡 | stateful | 17.4 | 29.8 | 0.0 | 16.9 | 97% |  | 10 | 4.1 | 4.0 | 0.0 | 0.1 |
| ui-callout | 其它自家卡 | stateful | 16.2 | 28.5 | 0.0 | 15.7 | 97% |  | 14 | 4.8 | 4.7 | 0.0 | 0.1 |
| type-shift | 其它自家卡 | stateful | 16.1 | 28.4 | 0.0 | 15.7 | 98% |  | 12 | 4.1 | 3.9 | 0.1 | 0.1 |
| mu-number-ticker | MagicUI | stateful | 15.3 | 27.6 | 0.0 | 15.0 | 98% |  | 10 | 3.8 | 3.8 | 0.0 | 0.0 |
| lottie | 其它自家卡 | stateful | 14.8 | 27.2 | 0.0 | 13.9 | 94% |  | 18 | 6.6 | 6.2 | 0.0 | 0.3 |
| mu-word-rotate | MagicUI | stateful | 14.6 | 26.9 | 0.0 | 14.3 | 98% |  | 10 | 3.5 | 3.3 | 0.0 | 0.2 |
| punch-pill | 其它自家卡 | stateful | 13.6 | 26.0 | 0.0 | 13.4 | 98% |  | 8 | 3.1 | 3.1 | 0.0 | 0.0 |
| mu-animated-shiny-text | MagicUI | stateful | 12.7 | 25.1 | 0.0 | 12.3 | 97% |  | 4 | 2.5 | 2.5 | 0.0 | 0.0 |
| mu-blur-fade | MagicUI | stateful | 12.0 | 24.3 | 0.0 | 11.8 | 99% |  | 6 | 3.8 | 3.6 | 0.0 | 0.2 |
| mu-typing | MagicUI | stateful | 11.7 | 24.1 | 0.0 | 11.5 | 98% |  | 4 | 2.8 | 2.7 | 0.0 | 0.1 |
| composite | 其它自家卡 | stateful | 10.7 | 23.1 | 0.0 | 10.6 | 100% |  | 2 | 2.0 | 2.0 | 0.0 | 0.0 |
| caption-track | 其它自家卡 | direct | 10.2 | 22.6 | 0.0 | 10.2 | 100% |  | 2 | 2.1 | 2.0 | 0.0 | 0.1 |



## 6. `innerHTML` 解析耗时

A3c 的预算是「拖动 3 秒内舞台主线程 `innerHTML` 解析合计 ≤ 200 ms」。把最大的 10 张卡的快照各赋给一个
**游离 div** 的 `innerHTML`（不进文档，所以量的是解析 + 建树，不含布局与绘制），5 次取中位：

| 卡 | KB | 中位 ms | 最快 ms | 最慢 ms |
|---|---|---|---|---|
| lottie-bodymovin | 915.3 | 6.20 | 6.20 | 6.70 |
| lottie-navidad | 855.0 | 5.60 | 5.40 | 5.90 |
| particles-basic | 638.8 | 1.60 | 1.60 | 2.30 |
| scene-3d | 519.1 | 1.30 | 1.10 | 1.70 |
| particles-life | 330.7 | 0.80 | 0.80 | 1.10 |
| particles-big | 390.4 | 1.00 | 0.90 | 1.10 |
| particles-poisson | 380.2 | 0.90 | 0.90 | 1.20 |
| particles-bigBlend | 324.7 | 0.80 | 0.80 | 1.00 |
| particles-random | 313.1 | 0.80 | 0.80 | 1.00 |
| lottie-happy2016 | 296.2 | 1.70 | 1.70 | 2.00 |

这 10 张里中位 **2.07 ms**、最慢 **6.20 ms**。
C4 拖一格通常只换一两张卡；按最慢的一张算，3 秒 90 格里能换 **32** 次最大的卡还留在 200 ms 预算里。

## 7. 顺带记下的两件事

- **`createSnapshot` 的耗时**（上表最后四列）量的是整场景一次生成快照。按任务书 3.8，它**不进判重** ——
  判重只看活渲的 `stepMs`（生成快照只在探针和预渲染时发生，活渲每拍并不做），这三段只用来排
  探针和预渲染的产能。本次实测整场景一次在 19～441 ms 量级
  （B = 1000/30 × 70% = 23.3 ms，仅供对照）。dev 模式偏慢是一部分原因，
  另一部分是样式内联对场景里**每一个元素**都要 `getComputedStyle`。
  哪类卡贵一眼可见：样式内联高 = DOM 太复杂，画布栅格化高 = 画布太大。
- **canvas 位图现在还是 PNG**：`snapshot/rasterizeCanvas.ts` 里是 `toDataURL()`（默认 PNG）。A3c 要求换成
  `toDataURL('image/webp', 0.9)`，那是 M4 的改动，本审计只按现状量。
