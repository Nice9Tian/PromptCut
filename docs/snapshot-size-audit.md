# A3c 快照体积审计（高频清单实测）

实测日期 2026-09-17。跑法：`node scripts/probes/snapshot-size-probe.mjs --origin http://127.0.0.1:5197`，
dev 模式的 dev server（`/src/*` 现场变换），后台舞台（`?stage=1&id=back`，`setRole('back', { job: 'probe' })`）。
每张卡一条轨道一个 `4` 秒的 clip、参数取默认值，fps 30；在 0.3 s / 中点 / 收尾前 0.1 s 三个本地时刻各冻一次
（`stateful` 卡用 `render(t, { jump: true, maxCatchUp: Infinity })` 真推到那一刻，`direct` 卡用 `setTime(t)`），
取三次里最大的一帧。量的是 `window.__bfFreeze()` 回来的 `controls[0].html` —— 也就是包裹层 innerHTML、
计算样式已全部内联的**原始**体积，不含投递前的 deflate + base64。

机器：Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/152.0.0.0 Safari/537.36。

## 1. 三条上限（任务书 A3c）

| 口径 | 上限 |
|---|---|
| DOM 卡：单 clip 单帧原始快照 | **≤ 300 KB** |
| canvas 卡：位图 `toDataURL('image/webp', 0.9)`（带 alpha），单帧 | **≤ 1 MB** |
| 一次 `setSnapshots(patch, opts)` 投递 | **≤ 2 MB** |

超出 300 KB 的卡按任务书先做「相对 UA + 主题基线的差异样式内联」。

## 2. 清单与总览

- 高频清单 62 张 = inventory `:19` 的默认可见卡（非粒子卡全要 + 目录标 `featured` 的粒子卡）
  + 12 个 `hud-glass` 文件里的卡。
- 测通 62 张，失败 0 张。
- 全体最大帧：p50 **227.0 KB**、p90 **658.1 KB**、max **23106.8 KB**。
- 超 300 KB 的 DOM 卡 **12** 张；超 1 MB 的 canvas 卡 **0** 张。
- 按 p90 估一次「10 张活跃卡全换」的投递：约 **6.43 MB**，> 2 MB，得按 A3c 拆成两次投递。

## 3. 按族的 p50 / p90 / max

| 族 | 张数 | p50 KB | p90 KB | max KB |
|---|---|---|---|---|
| MagicUI | 6 | 90.0 | 126.7 | 126.7 |
| hud-glass 自家卡 | 11 | 323.8 | 577.0 | 2200.6 |
| lottie-*(DOM/SVG) | 5 | 4649.7 | 23106.8 | 23106.8 |
| particles-*(canvas) | 26 | 227.4 | 430.5 | 658.1 |
| three.js / canvas 通用卡 | 3 | 270.9 | 543.9 | 543.9 |
| 其它自家卡 | 11 | 126.4 | 252.6 | 306.7 |

## 4. 超标的卡

### 4.1 DOM 卡超 300 KB（12 张）

| 卡 | 族 | 最大帧 KB | 整场景 KB | 标签数 | 内联样式 KB | 样式占比 | 建议 |
|---|---|---|---|---|---|---|---|
| lottie-bodymovin | lottie-*(DOM/SVG) | 23106.8 | 23179.3 | 2534 | 22839.9 | 99% | 相对 UA + 主题基线的差异样式内联 |
| lottie-navidad | lottie-*(DOM/SVG) | 19152.0 | 19226.0 | 2090 | 18870.5 | 99% | 相对 UA + 主题基线的差异样式内联 |
| lottie-happy2016 | lottie-*(DOM/SVG) | 4649.7 | 4721.7 | 498 | 4519.8 | 97% | 相对 UA + 主题基线的差异样式内联 |
| lottie-adrock | lottie-*(DOM/SVG) | 4171.0 | 4242.9 | 456 | 4115.3 | 99% | 相对 UA + 主题基线的差异样式内联 |
| odometer | hud-glass 自家卡 | 2200.6 | 2272.5 | 244 | 2193.4 | 100% | 相对 UA + 主题基线的差异样式内联 |
| lottie-gatin | lottie-*(DOM/SVG) | 1659.3 | 1731.2 | 182 | 1640.0 | 99% | 相对 UA + 主题基线的差异样式内联 |
| rank-bars | hud-glass 自家卡 | 577.0 | 649.0 | 64 | 575.4 | 100% | 相对 UA + 主题基线的差异样式内联 |
| step-timeline | hud-glass 自家卡 | 559.2 | 631.2 | 62 | 557.4 | 100% | 相对 UA + 主题基线的差异样式内联 |
| checklist | hud-glass 自家卡 | 541.4 | 613.4 | 60 | 539.1 | 100% | 相对 UA + 主题基线的差异样式内联 |
| growth-curve | hud-glass 自家卡 | 488.1 | 560.1 | 54 | 485.5 | 99% | 相对 UA + 主题基线的差异样式内联 |
| term-card | hud-glass 自家卡 | 323.8 | 395.7 | 36 | 323.2 | 100% | 相对 UA + 主题基线的差异样式内联 |
| focus-card | 其它自家卡 | 306.7 | 378.6 | 34 | 305.7 | 100% | 相对 UA + 主题基线的差异样式内联 |

## 5. 逐卡（三个时刻里最大的一帧）

| 卡 | 族 | 帧模式 | 控件 KB | 整场景 KB | 其中位图 KB | 内联样式 KB | 样式占比 | canvas | 标签数 | 冻结 ms |
|---|---|---|---|---|---|---|---|---|---|---|
| lottie-bodymovin | lottie-*(DOM/SVG) | stateful | 23106.8 | 23179.3 | 0.0 | 22839.9 | 99% |  | 2534 | 2735.0 |
| lottie-navidad | lottie-*(DOM/SVG) | stateful | 19152.0 | 19226.0 | 0.0 | 18870.5 | 99% |  | 2090 | 5822.6 |
| lottie-happy2016 | lottie-*(DOM/SVG) | stateful | 4649.7 | 4721.7 | 0.0 | 4519.8 | 97% |  | 498 | 283.9 |
| lottie-adrock | lottie-*(DOM/SVG) | stateful | 4171.0 | 4242.9 | 0.0 | 4115.3 | 99% |  | 456 | 279.0 |
| odometer | hud-glass 自家卡 | stateful | 2200.6 | 2272.5 | 0.0 | 2193.4 | 100% |  | 244 | 69.0 |
| lottie-gatin | lottie-*(DOM/SVG) | stateful | 1659.3 | 1731.2 | 0.0 | 1640.0 | 99% |  | 182 | 112.4 |
| particles-basic | particles-*(canvas) | stateful | 658.1 | 730.0 | 622.1 | 35.9 | 5% | 是 | 3 | 34.0 |
| rank-bars | hud-glass 自家卡 | stateful | 577.0 | 649.0 | 0.0 | 575.4 | 100% |  | 64 | 21.7 |
| step-timeline | hud-glass 自家卡 | stateful | 559.2 | 631.2 | 0.0 | 557.4 | 100% |  | 62 | 18.1 |
| scene-3d | three.js / canvas 通用卡 | stateful | 543.9 | 615.9 | 508.0 | 35.9 | 7% | 是 | 3 | 54.3 |
| checklist | hud-glass 自家卡 | stateful | 541.4 | 613.4 | 0.0 | 539.1 | 100% |  | 60 | 19.5 |
| growth-curve | hud-glass 自家卡 | stateful | 488.1 | 560.1 | 0.0 | 485.5 | 99% |  | 54 | 18.0 |
| particles-big | particles-*(canvas) | stateful | 435.4 | 507.3 | 399.4 | 35.9 | 8% | 是 | 3 | 24.1 |
| particles-life | particles-*(canvas) | stateful | 430.5 | 502.4 | 394.5 | 35.9 | 8% | 是 | 3 | 31.5 |
| particles-poisson | particles-*(canvas) | stateful | 410.1 | 482.0 | 374.1 | 35.9 | 9% | 是 | 3 | 23.2 |
| particles-bigBlend | particles-*(canvas) | stateful | 349.9 | 421.8 | 313.9 | 35.9 | 10% | 是 | 3 | 21.1 |
| particles-random | particles-*(canvas) | stateful | 341.1 | 413.1 | 305.2 | 35.9 | 11% | 是 | 3 | 26.9 |
| term-card | hud-glass 自家卡 | stateful | 323.8 | 395.7 | 0.0 | 323.2 | 100% |  | 36 | 10.8 |
| particles-parallax | particles-*(canvas) | stateful | 313.7 | 385.7 | 277.7 | 35.9 | 11% | 是 | 3 | 29.5 |
| focus-card | 其它自家卡 | stateful | 306.7 | 378.6 | 0.0 | 305.7 | 100% |  | 34 | 10.1 |
| particles-plasma | particles-*(canvas) | stateful | 282.7 | 354.7 | 246.8 | 35.9 | 13% | 是 | 3 | 25.5 |
| particles-repulse | particles-*(canvas) | stateful | 271.1 | 343.0 | 235.1 | 35.9 | 13% | 是 | 3 | 23.5 |
| terminal-3d | three.js / canvas 通用卡 | stateful | 270.9 | 342.9 | 0.0 | 269.9 | 100% |  | 30 | 19.2 |
| entity-chips | 其它自家卡 | stateful | 252.6 | 324.6 | 0.0 | 251.8 | 100% |  | 28 | 10.9 |
| particles | three.js / canvas 通用卡 | stateful | 240.4 | 312.4 | 204.4 | 35.9 | 15% | 是 | 3 | 60.4 |
| particles-colorAnimation | particles-*(canvas) | stateful | 237.2 | 309.1 | 201.2 | 35.9 | 15% | 是 | 3 | 19.8 |
| stat-proof | hud-glass 自家卡 | stateful | 234.5 | 306.5 | 0.0 | 233.8 | 100% |  | 26 | 8.8 |
| particles-fallingConfetti | particles-*(canvas) | stateful | 230.8 | 302.7 | 194.8 | 35.9 | 16% | 是 | 3 | 18.6 |
| particles-linkTriangles | particles-*(canvas) | stateful | 229.7 | 301.7 | 193.7 | 35.9 | 16% | 是 | 3 | 28.4 |
| particles-slow | particles-*(canvas) | stateful | 227.4 | 299.4 | 191.5 | 35.9 | 16% | 是 | 3 | 24.2 |
| particles-twinkle | particles-*(canvas) | stateful | 227.0 | 298.9 | 191.0 | 35.9 | 16% | 是 | 3 | 19.8 |
| particles-vibrate | particles-*(canvas) | stateful | 225.8 | 297.8 | 189.8 | 35.9 | 16% | 是 | 3 | 19.8 |
| particles-lch | particles-*(canvas) | stateful | 205.1 | 277.1 | 169.2 | 35.9 | 18% | 是 | 3 | 22.8 |
| versus-card | hud-glass 自家卡 | stateful | 198.9 | 270.9 | 0.0 | 198.0 | 100% |  | 22 | 13.3 |
| chapter-bar | hud-glass 自家卡 | stateful | 198.7 | 270.6 | 0.0 | 198.2 | 100% |  | 22 | 13.4 |
| ring-metric | hud-glass 自家卡 | stateful | 198.4 | 270.3 | 0.0 | 197.6 | 100% |  | 22 | 15.9 |
| blur-text | hud-glass 自家卡 | stateful | 197.9 | 269.9 | 0.0 | 197.7 | 100% |  | 22 | 15.0 |
| particles-star | particles-*(canvas) | stateful | 182.1 | 254.0 | 146.1 | 35.9 | 20% | 是 | 3 | 19.0 |
| particles-gradients | particles-*(canvas) | stateful | 174.5 | 246.5 | 138.5 | 35.9 | 21% | 是 | 3 | 17.6 |
| pin-board | 其它自家卡 | stateful | 163.1 | 235.0 | 0.0 | 162.4 | 100% |  | 18 | 11.7 |
| lottie | 其它自家卡 | stateful | 162.8 | 234.8 | 0.0 | 161.9 | 99% |  | 18 | 8.6 |
| particles-strokeAnimation | particles-*(canvas) | stateful | 156.6 | 228.6 | 120.7 | 35.9 | 23% | 是 | 3 | 20.2 |
| particles-groups | particles-*(canvas) | stateful | 147.1 | 219.0 | 111.1 | 35.9 | 24% | 是 | 3 | 21.2 |
| quote-lockup | 其它自家卡 | stateful | 144.8 | 216.7 | 0.0 | 144.3 | 100% |  | 16 | 6.4 |
| particles-triangles | particles-*(canvas) | stateful | 142.2 | 214.1 | 106.2 | 35.9 | 25% | 是 | 3 | 20.1 |
| particles-orbit | particles-*(canvas) | stateful | 137.3 | 209.2 | 101.3 | 35.9 | 26% | 是 | 3 | 22.6 |
| particles-spin | particles-*(canvas) | stateful | 133.7 | 205.7 | 97.7 | 35.9 | 27% | 是 | 3 | 18.3 |
| mu-circular-progress | MagicUI | stateful | 126.7 | 198.6 | 0.0 | 126.0 | 99% |  | 14 | 8.2 |
| ui-callout | 其它自家卡 | stateful | 126.4 | 198.3 | 0.0 | 125.8 | 100% |  | 14 | 9.0 |
| particles-snow | particles-*(canvas) | stateful | 120.2 | 192.1 | 84.2 | 35.9 | 30% | 是 | 3 | 17.5 |
| particles-nasa | particles-*(canvas) | stateful | 116.1 | 188.1 | 80.1 | 36.0 | 31% | 是 | 3 | 20.7 |
| particles-bubble | particles-*(canvas) | stateful | 112.0 | 183.9 | 76.0 | 35.9 | 32% | 是 | 3 | 17.9 |
| type-shift | 其它自家卡 | stateful | 108.3 | 180.2 | 0.0 | 108.0 | 100% |  | 12 | 6.7 |
| probe | 其它自家卡 | stateful | 90.7 | 162.6 | 0.0 | 90.2 | 99% |  | 10 | 9.0 |
| mu-number-ticker | MagicUI | stateful | 90.2 | 162.1 | 0.0 | 89.9 | 100% |  | 10 | 4.8 |
| mu-word-rotate | MagicUI | stateful | 90.0 | 161.9 | 0.0 | 89.8 | 100% |  | 10 | 4.8 |
| punch-pill | 其它自家卡 | stateful | 72.3 | 144.2 | 0.0 | 72.0 | 100% |  | 8 | 4.1 |
| mu-blur-fade | MagicUI | stateful | 54.0 | 125.9 | 0.0 | 53.9 | 100% |  | 6 | 4.1 |
| mu-animated-shiny-text | MagicUI | stateful | 37.0 | 108.9 | 0.0 | 36.5 | 99% |  | 4 | 6.2 |
| mu-typing | MagicUI | stateful | 36.1 | 108.1 | 0.0 | 35.9 | 99% |  | 4 | 5.6 |
| composite | 其它自家卡 | stateful | 18.0 | 90.0 | 0.0 | 18.0 | 100% |  | 2 | 2.6 |
| caption-track | 其它自家卡 | direct | 18.0 | 89.9 | 0.0 | 18.0 | 100% |  | 2 | 2.6 |



## 6. `innerHTML` 解析耗时

A3c 的预算是「拖动 3 秒内舞台主线程 `innerHTML` 解析合计 ≤ 200 ms」。把最大的 10 张卡的快照各赋给一个
**游离 div** 的 `innerHTML`（不进文档，所以量的是解析 + 建树，不含布局与绘制），5 次取中位：

| 卡 | KB | 中位 ms | 最快 ms | 最慢 ms |
|---|---|---|---|---|
| lottie-bodymovin | 23106.8 | 293.00 | 286.90 | 319.30 |
| lottie-navidad | 19152.0 | 259.70 | 234.00 | 295.60 |
| lottie-happy2016 | 4649.7 | 58.10 | 56.70 | 59.20 |
| lottie-adrock | 4171.0 | 51.00 | 50.40 | 53.60 |
| odometer | 2200.6 | 25.90 | 25.60 | 26.10 |
| lottie-gatin | 1659.0 | 20.70 | 20.60 | 22.00 |
| particles-basic | 658.1 | 2.80 | 2.80 | 3.90 |
| rank-bars | 576.9 | 6.70 | 6.60 | 6.90 |
| step-timeline | 558.7 | 6.50 | 6.50 | 6.60 |
| scene-3d | 543.9 | 2.20 | 2.20 | 3.00 |

这 10 张里中位 **25.90 ms**、最慢 **293.00 ms**。
C4 拖一格通常只换一两张卡：按这 10 张里中位的那一张算，3 秒内还能换 **7** 张才吃满 200 ms；
但**最大的那一张单独就要 293 ms**，占整个预算的 **147%** —— 换一次就超了。
换句话说，200 ms 的解析预算**不是被「换得太频繁」吃掉的，是被单张卡的体积吃掉的**，和第 4 节是同一件事。

## 7. 顺带记下的两件事

- **`freezeScene` 的耗时**（上表「冻结 ms」）量的是整场景一次冻结。K1 的 `frameMs` 按任务书**含**这一步，
  所以它直接决定轻重判定：本次实测冻结本身就在 19～5823 ms 量级，
  已经大于 B = 1000/30 × 70% = 23.3 ms。dev 模式偏慢是一部分原因，
  另一部分是 `freezeScene` 对场景里**每一个元素**都要 `getComputedStyle` 并整份内联。
- **canvas 位图现在还是 PNG**：`snapshotFreeze.ts` 里是 `toDataURL()`（默认 PNG）。A3c 要求换成
  `toDataURL('image/webp', 0.9)`，那是 M4 的改动，本审计只按现状量。
