# 占位平面验证报告

## 候选方案与依据

| 方案 | 来源 | 合成线程条件与取舍 |
| --- | --- | --- |
| 静态 16×16 SVG 噪点贴图平铺，内联 SVG 沙漏旋转（采用） | [MDN：SVG 可作为 CSS 背景图片](https://developer.mozilla.org/en-US/docs/Web/SVG/Guides/SVG_as_an_image)、[MDN：背景重复](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/background-repeat)、[web.dev：仅合成属性与层数](https://web.dev/articles/stick-to-compositor-only-properties-and-manage-layer-count) | 噪点只在初次显示时绘制；逐帧只改 `transform`，显现只改 `opacity`。贴图解码后为 16×16×4＝1024 字节。无额外文件或解码器。 |
| SVG `feTurbulence` 生成噪点后预先栅格化，再作静态贴图 | [MDN：feTurbulence](https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Element/feTurbulence)、[web.dev：仅合成属性](https://web.dev/articles/stick-to-compositor-only-properties-and-manage-layer-count) | 如果在构建前栅格化并只把结果用作静态背景，逐帧仍仅合成。浏览器实时运行滤镜的版本不能保证这点，因此未选。 |
| 极小 PNG 噪点 data URI 平铺，CSS 沙漏旋转 | [MDN：背景重复](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/background-repeat)、[Chrome：非合成动画的判据](https://developer.chrome.com/docs/lighthouse/performance/non-composited-animations) | PNG 解码一次、保持静态；沙漏仅转动 `transform` 可合成。性能路径可行，但贴图内嵌的二进制不便审阅或调整。 |

这些来源解释了方案成立的条件，不代替浏览器实测。最终方案的噪点 SVG 只含固定色块和路径，不含滤镜、脚本或动画。组件无 state、effect、计时器、rAF 或布局读取，使用 `React.memo`。`solid` 铺噪点并居中放沙漏；`badge` 是 28×28 沙漏徽标，无噪点。舞台应只给人看的预览注入 `PLACEHOLDER_CSS`，再用 contract 的 `setPlaceholderShown` 切换根节点 `hidden`。

## 浏览器实测

命令：`node scripts/probes/placeholder-probe.mjs`。探针自行启动并关闭 Vite（5240，舞台端口 5241、5242）和 Chrome，另用 `serve` 在 5243 提供测试页入口；截图及 `metrics.json` 在 `%TEMP%\promptcut-placeholder-5kWFEu`。测试页包含 1、10、30、60 个实例及旋转 45°、缩放 0.3/3、三维透视、父级淡出、multiply/screen 混合模式。30 个实例持续 5 秒的 CDP 追踪丢弃首尾各 200 ms。

| 项目 | 实测 | 标准 | 结果 |
| --- | --- | --- | --- |
| 稳态 Paint / Layout / RecalculateStyles | 0 / 0 / 0 次（4.617 s 有效追踪） | 各 0 | 达标 |
| 占位组件每帧脚本 | 0 ms；组件没有逐帧回调，追踪期间测试台也未运行节拍回调 | 0 | 达标 |
| 30 fps 节拍中 `pinAnimations` 过滤调用 p90 增量 | 0.1 ms（隐藏 0.1 ms，显示 0.2 ms；150 拍） | ≤0.1 ms | 达标，贴着边界 |
| 30 个实例新增合成层 | 1 层（隐藏 20、显示 21） | ≤31 层 | 达标 |
| 1 / 10 / 60 个实例新增合成层 | 1 / 1 / 1 层 | 各 ≤n+1 | 达标 |
| 同包裹层参考框的截图像素边界 | 普通 0 px、旋转 45° 1 px、缩放 0.3 为 1 px、缩放 3 为 0 px、三维透视 0 px；淡出与混合模式的 DOM 矩形边误差各 0 px | ≤1 px | 达标 |
| 显现防抖 | 80 ms 短窗口透明度 0；再次显示后 46.7、93.8、105.8 ms 为 0，151 ms 为 1 | 满 120 ms 才可见 | 达标 |
| badge 噪点 | `background-image: none` | 无噪点 | 达标 |
| 舞台动画钉时 | 真实 `createAnimationPinner` 不过滤时沙漏矩阵保持不变；用 `isPlaceholderAnimation` 过滤后 180 ms 内矩阵变化 | 沙漏持续转动 | 达标 |

截图目录：`C:\Users\admin\AppData\Local\Temp\promptcut-placeholder-5kWFEu`。其中有 `geometry-1.png`、`geometry-10.png`、`geometry-30.png`、`geometry-60.png`、`visible-after-delay.png`、`blend-normal.png`、`blend-multiply.png`，以及五种变换各一对 `reference-*.png` 和 `placeholder-*.png`。临时目录不会进入仓库。

混合模式实测：multiply 下噪点采样 RGB 从 `(48,52,61)` 变成 `(18,26,39)`。子节点的 `mix-blend-mode: normal` 无法抵消祖先包裹层的混合。当前实现保持继承，因此混合卡上会变暗。若产品要求绝对中性噪点，舞台需在占位期间暂时调整包裹层混合模式，或在包裹层外另挂一份同步几何的占位平面；后者需双方改接口，不能由组件单方面处理。

`maxAnimated = 1`：同屏第一个沙漏持续旋转，额外实例需由舞台给根节点加 `data-pc-placeholder-static`，保留静态沙漏。测试台按此标记实测。`layersFor(n)` 按稳定测试场景的测值返回 `n>0 ? 1 : 0`。层数与节拍数据属于本机 Chrome 测试环境，不保证所有 GPU/浏览器相同。

## 构建与测试

| 命令 | 结果 |
| --- | --- |
| `npx tsc -b --force` | 退出 0，零错误 |
| `node --experimental-test-module-mocks --test src/render/placeholder/placeholder.test.mjs` | 3 通过，0 失败 |
| `node scripts/probes/placeholder-probe.mjs` | 退出 0，全部探针检查通过 |
| `npm test` | 1837 项，1836 通过、1 跳过、0 失败 |

未跑导出确定性与快照重放验证：本分支只新增预览专用组件和未接入舞台的测试台，导出页与快照路径尚未改变；交接到 A 并接入舞台后应由集成分支运行。

## 交接建议与已知限制

1. contract 只有 `{clipId, geometry, reason}`，没有预算序号或 `animated` 字段。现行实现需要舞台按实例顺序给第 2 个起的根节点加 `data-pc-placeholder-static`。建议双方确认该 DOM 标记为接口的一部分，或给 props 增加显式 `animated`，再由组件自行渲染静止态；本任务未修改 contract。
2. `docs/semantics/architecture/rendering.md` 目前写「缺了就让该层透明」，与 contract 已定的预览占位语义冲突。建议集成方更新语义文档为「人看的预览在兜底链尽头显示占位平面；导出和查询渲染不显示」。本任务获准修改的文件不包括该文档。
3. 根节点上 `[hidden]` 不被样式表覆盖，120 ms 显现动画的名字是 `pc-ph-reveal`；旋转名是 `pc-ph-turn`。舞台的动画钉时循环必须在 `pause/currentTime` 前以 `isPlaceholderAnimation` 跳过这两种动画。测试台用真实 pinner 证明了未豁免会被钉住。
