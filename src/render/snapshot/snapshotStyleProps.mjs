/**
 * 差异样式内联的两张属性表(`snapshot/inlineStyles.ts` 的 `inlineDOMStyles` 用)。
 *
 * 单独成文件有两个理由:
 *   1. 它是**纯数据**,`server/test/snapshot-style-props.test.mjs` 要直接 import 来对账
 *      (`npm test` 跑的是 node --test,进不去 .ts);
 *   2. 改这两张表等于改快照内容,所以 `server/frame-code.mjs` 的 `SNAPSHOT_FILES` 把本文件
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

/** `--*` 自定义属性默认继承,不进表、按前缀判 */
export function isInheritedProp(prop) {
  return prop.charCodeAt(0) === 45 && prop.charCodeAt(1) === 45 ? true : INHERITED_PROPS.has(prop);
}
