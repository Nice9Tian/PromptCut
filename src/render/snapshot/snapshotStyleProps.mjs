/**
 * 差异样式内联的属性表和几个纯函数(`snapshot/inlineStyles.ts` 的 `inlineDOMStyles` 用)。
 * 前两张表(继承 / 布局解析值)决定**省掉哪些属性**,见下;后面的 `LAYOUT_UNIT_PROPS` /
 * `snapLayoutUnits` / `COMPOSITED_ANIMATION_PROPS` / `isCurrentAnimation` 决定**写进去的值
 * 怎么才能让重放和活渲逐字节相同**,各自的注释里有出处。
 *
 * 单独成文件有两个理由:
 *   1. 它是**纯数据和纯函数**,`server/test/snapshot-style-props.test.mjs` 要直接 import 来对账
 *      (`npm test` 跑的是 node --test,进不去 .ts);
 *   2. 改这里任何一项都等于改快照内容,所以 `server/frame-code.mjs` 的 `SNAPSHOT_FILES` 把本文件
 *      也写了进去 —— 改了它 `snapshotCode` 就变、旧快照作废。
 *
 * # 三类属性(底稿 A2(8))
 *
 * `inlineDOMStyles` 对每个元素只内联「省掉以后重放会变」的属性,判据按属性分三类:
 *
 *   ① **继承属性**(本文件的 `INHERITED_PROPS`,外加所有 `--*` 自定义属性)——
 *      和**父元素的计算值**比,相等才省。**不能和同标签基线比**:一个继承属性的值
 *      恰好等于基线、却不等于父值时,省掉后重放会继承到父值,画面就错。
 *      快照的顶层元素(整场景 html 的场景根、control 的包裹层直接子节点)一律全内联 ——
 *      重放时它们的父元素是另一棵树,继承进来的东西不受我们控制。
 *
 *   ② **布局解析值属性**(`LAYOUT_USED_VALUE_PROPS`)一律照旧内联、不参与省略。
 *      `getComputedStyle` 给的是**使用值**(`width: auto` 量出来是 `823.5px`),
 *      和基线偶然相等不代表重放时重新排版还相等。
 *
 *   ③ 其余非继承属性和**同标签基线**比(基线 = 同 `namespaceURI` + `tagName` 的一个
 *      干净元素挂在同一张快照页的场景根下量到的计算样式 = UA 默认 + 主题全局样式)。
 *
 * # 为什么这两张表**错了也不会画错**(只影响体积)
 *
 * 重放页加载同一份 bundle 和主题样式,元素的 class / 属性都原样克隆,所以
 * **重放时的层叠 = 生成快照时的层叠**,只差两件事:我们把元素自带的 `style` 属性换掉了、
 * 又写死了 `animation:none / transition:none`。`inlineDOMStyles` 对这两件事各有一道兜底
 * (强制内联「元素自己内联样式里写过的属性」和「被动画 / 过渡改写的属性」)。
 * 除此之外:
 *   - 真继承属性被误判成非继承 → 和基线比,相等才省;省掉后重放从父元素继承,
 *     而父元素的计算值由上一层保证不变,于是拿到的还是原值 —— 安全;
 *   - 真非继承属性被误判成继承 → 和父值比,相等才省;省掉后重放走层叠,
 *     层叠又和生成快照时相同 —— 安全。
 * 唯一真正要紧的是**顶层元素全内联**这一条(它的父元素在重放时换了人)。
 * 所以这两张表宁可写宽一点:写宽只多几个字节,写窄也只是省得少。
 */

/**
 * 继承属性。清单以 Chrome 实测为准 —— `scripts/probes/inherited-props-probe.mjs`
 * 用父子两层干净元素逐个属性验「父设了非初始值、子跟不跟」,
 * `server/test/snapshot-style-props.test.mjs` 按探针跑出来的那一份对账。
 * 另有所有 `--*` 自定义属性(默认继承),不在表里、由 `isInheritedProp` 单独判。
 */
export const INHERITED_PROPS = new Set([
  // 颜色与字体
  'color', 'caret-color', 'accent-color', 'color-scheme',
  'font-family', 'font-size', 'font-size-adjust', 'font-stretch', 'font-style', 'font-weight',
  'font-feature-settings', 'font-kerning', 'font-language-override', 'font-optical-sizing',
  'font-palette', 'font-synthesis-small-caps', 'font-synthesis-style', 'font-synthesis-weight',
  'font-variant', 'font-variant-alternates', 'font-variant-caps', 'font-variant-east-asian',
  'font-variant-emoji', 'font-variant-ligatures', 'font-variant-numeric', 'font-variant-position',
  'font-variation-settings', '-webkit-font-smoothing', '-webkit-locale',
  // 排版
  'letter-spacing', 'line-height', 'word-spacing', 'text-align', 'text-align-last',
  'text-indent', 'text-transform', 'text-shadow', 'text-rendering', 'text-size-adjust',
  '-webkit-text-size-adjust', 'text-justify',
  'text-underline-position', 'text-underline-offset', 'text-decoration-skip-ink',
  'text-emphasis-color', 'text-emphasis-position', 'text-emphasis-style',
  '-webkit-text-fill-color', '-webkit-text-stroke-color', '-webkit-text-stroke-width',
  'white-space', 'white-space-collapse', 'text-wrap', 'text-wrap-mode', 'text-wrap-style',
  'word-break', 'line-break', 'overflow-wrap', 'word-wrap',
  'hyphens', 'hyphenate-character', 'hyphenate-limit-chars',
  'tab-size', 'orphans', 'widows', 'quotes',
  'direction', 'writing-mode', 'text-orientation', 'text-combine-upright', 'unicode-bidi',
  'ruby-align', 'ruby-position',
  // 交互与呈现
  'visibility', 'cursor', 'pointer-events', 'image-rendering', 'image-orientation',
  'print-color-adjust', 'forced-color-adjust', 'scrollbar-color',
  'caret-animation', 'caret-shape', 'math-depth', 'ruby-overhang', 'speak', 'app-region',
  '-webkit-text-security', '-webkit-writing-mode',
  'list-style-image', 'list-style-position', 'list-style-type',
  'border-collapse', 'border-spacing', 'caption-side', 'empty-cells',
  '-webkit-border-horizontal-spacing', '-webkit-border-vertical-spacing',
  '-webkit-tap-highlight-color', '-webkit-user-select', 'user-select',
  // SVG
  'fill', 'fill-opacity', 'fill-rule',
  'stroke', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap', 'stroke-linejoin',
  'stroke-miterlimit', 'stroke-opacity', 'stroke-width',
  'marker-start', 'marker-mid', 'marker-end', 'paint-order',
  'text-anchor', 'dominant-baseline', 'shape-rendering', 'clip-rule',
  'color-interpolation', 'color-interpolation-filters', 'color-rendering', 'glyph-orientation-vertical',
]);

/**
 * 布局解析值属性:`getComputedStyle` 给的是**使用值**,一律照旧内联。
 * 任务书 A2(8) 点名的一组,外加 `inline-size` / `block-size`(Chrome 的计算样式里
 * 它们和 `width` / `height` 一样是使用值,漏了会在写作模式非 horizontal-tb 时出错)。
 */
export const LAYOUT_USED_VALUE_PROPS = new Set([
  'width', 'height', 'inline-size', 'block-size',
  'top', 'right', 'bottom', 'left',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'transform', 'transform-origin', 'perspective-origin',
  'grid-template-rows', 'grid-template-columns',
]);

/**
 * 布局解析值里**落在 LayoutUnit 网格上**的那些:`inlineDOMStyles` 写进快照前先把其中的 px 数
 * 对齐回 1/64 格(`snapLayoutUnits`)。
 *
 * Chrome 排版用 LayoutUnit(1/64 px 的定点数),这些属性的使用值一定是 n/64;但
 * `getComputedStyle` 按 **6 位有效数字**序列化(`316.15625px` → `316.156px`),重放时 Chrome
 * 把 316.156 × 64 = 20233.98 **截断**成 20233,比原值少 1/64 px。硬边元素看不出来,
 * `filter: blur()` 却能因此差出几十级(`restructure_planning/reports/replay-mismatch-report.md` §6)。
 *
 * 为什么对齐回去的一定是原值:6 位有效数字在 10000 px 以内的舍入误差 ≤ 0.005 px,
 * 小于半格(1/128 ≈ 0.0078 px),最近的那一格只能是原值;而 n/64 的十进制写法是有限小数
 * (最多 6 位小数),原样写出去重放时不会再丢。超过 10000 px 的值对齐到的是最近的一格,
 * 仍然不比截断差。
 *
 * 比 `LAYOUT_USED_VALUE_PROPS` 多了逻辑属性写法(`inset-*` / `margin-block-*` …):它们和物理属性
 * 映射到同一个值,两种写法都会出现在快照里,只对齐一边的话,后写的那条会把对齐过的盖回去。
 * 不含 `transform` / `transform-origin` / `perspective-origin`:它们是浮点、不在网格上
 * (实测把这几项换成全精度,像素一个都不变)。
 */
export const LAYOUT_UNIT_PROPS = new Set([
  'width', 'height', 'inline-size', 'block-size',
  'top', 'right', 'bottom', 'left',
  'inset-block-start', 'inset-block-end', 'inset-inline-start', 'inset-inline-end',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'margin-block-start', 'margin-block-end', 'margin-inline-start', 'margin-inline-end',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'padding-block-start', 'padding-block-end', 'padding-inline-start', 'padding-inline-end',
  'grid-template-rows', 'grid-template-columns',
]);

const PX_NUMBER = /(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)px/gi;

/**
 * 把一个计算样式值里的每个 `<数>px` 对齐到最近的 1/64 px,其余原样。
 * `'316.156px'` → `'316.15625px'`,`'105.5px 210.656px'` → `'105.5px 210.65625px'`,`'auto'` 不变。
 */
export function snapLayoutUnits(value) {
  // 整数 px(绝大多数:`0px`、`320px`)本来就在格上,不跑正则 —— lottie 一张卡几千个元素 × 几十个属性
  if (!value.includes('.')) return value;
  return value.replace(PX_NUMBER, (_, n) => {
    const snapped = Math.round(Number(n) * 64) / 64;
    return (snapped === 0 ? 0 : snapped) + 'px';   // 顺手把 -0 写成 0
  });
}

/**
 * 当前动画会让 Chrome **单独提一个合成层**的属性(Blink 的合成原因 `ActiveOpacityAnimation` /
 * `ActiveTransformAnimation` / `ActiveFilterAnimation` / `ActiveBackdropFilterAnimation`,
 * `translate` / `rotate` / `scale` 归在变换一类)。
 *
 * 快照写死了 `animation:none`,重放页里没有动画,这层就没了:元素改画进父层,
 * `filter: blur()` 走的是另一条栅格化路径,和活渲差出上百级(同一张 punch-pill,
 * 活渲的光晕层 `LayerTree.compositingReasons` 实测就是 `ActiveOpacityAnimation`)。
 * 所以 `inlineDOMStyles` 给「此刻有 current 动画改写这些属性」的元素补一条
 * `will-change: <这些属性>` —— 它是 CSS 里唯一能在没有动画时要到同一个合成层的写法。
 */
export const COMPOSITED_ANIMATION_PROPS = new Set([
  'opacity', 'transform', 'translate', 'rotate', 'scale', 'filter', 'backdrop-filter',
]);

/**
 * 一个动画此刻是不是 Web Animations 说的 **current**(Blink 的 `AnimationEffect::IsCurrent`)——
 * Blink 只给 current 的动画挂上面那几种合成原因。current =
 *   - 在活跃段里、且没放完(暂停的也算:`__pcSyncAnims` 钉住的动画全是暂停的);
 *   - 或者正向播放、还在开始前(delay 里);
 *   - 或者反向播放、还在结束后。
 * 放完了、只靠 `fill` 停在终态的**不算**。段的边界照规范:`before-active` / `active-after`
 * 两个边界点归哪一段看播放方向。
 *
 * 纯函数、不碰 DOM,好在 Node 里单测。参数取自 `effect.getComputedTiming()`(毫秒)、
 * `animation.playbackRate`、`animation.playState`。
 */
export function isCurrentAnimation(timing, playbackRate, playState) {
  if (timing.localTime == null) return false;
  const local = Number(timing.localTime), end = Number(timing.endTime), delay = Number(timing.delay ?? 0);
  const beforeActive = Math.max(Math.min(delay, end), 0);
  const activeAfter = Math.max(Math.min(delay + Number(timing.activeDuration), end), 0);
  if (local < beforeActive || (playbackRate < 0 && local === beforeActive)) return playbackRate > 0;
  if (local > activeAfter || (playbackRate >= 0 && local === activeAfter)) return playbackRate < 0;
  return playState !== 'finished';
}

/** `--*` 自定义属性默认继承,不进表、按前缀判 */
export function isInheritedProp(prop) {
  return prop.charCodeAt(0) === 45 && prop.charCodeAt(1) === 45 ? true : INHERITED_PROPS.has(prop);
}
