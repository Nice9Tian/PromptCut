/**
 * 差异样式内联的属性表对账(底稿 A2(8))(任务书:「清单以 Chrome 实测为准:用父子两层干净元素逐个属性验
 * 『父设了非初始值、子跟不跟』,与清单不符就失败」)。
 *
 * 实测那一步在 `scripts/probes/inherited-props-probe.mjs` 里跑(要真 Chrome,`npm test`
 * 没有 DOM、也不该在单测里起浏览器)。这里对的是**那一趟跑出来的结果**:
 * 下面两张表是 2026-09-19 在 Chrome 152 上跑出来的原文
 * (`out/inherited-props.json` 的 `inherited` / `notInherited`,已排掉布局解析值属性 ——
 *  给父元素设 width、块级子元素的**使用值**跟着变,那是布局不是继承)。
 *
 * 改 `INHERITED_PROPS` 的人要么让它继续满足这两条,要么重跑探针、把这里的两张表一起换掉。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { INHERITED_PROPS, LAYOUT_USED_VALUE_PROPS, isInheritedProp } from '../../src/render/snapshot/snapshotStyleProps.mjs';

/** Chrome 152 实测「确实继承」的属性(103 个里排掉 width / inline-size 两个布局解析值) */
const CHROME_INHERITED = [
  '-webkit-border-horizontal-spacing', '-webkit-border-vertical-spacing', '-webkit-font-smoothing',
  '-webkit-locale', '-webkit-tap-highlight-color', '-webkit-text-fill-color', '-webkit-text-security',
  '-webkit-text-stroke-color', '-webkit-text-stroke-width', '-webkit-writing-mode', 'accent-color',
  'app-region', 'border-collapse', 'caret-animation', 'caret-color', 'caret-shape', 'clip-rule', 'color',
  'color-interpolation', 'color-interpolation-filters', 'color-rendering', 'color-scheme', 'cursor',
  'direction', 'dominant-baseline', 'fill', 'fill-opacity', 'fill-rule', 'font-family', 'font-kerning',
  'font-optical-sizing', 'font-palette', 'font-size', 'font-size-adjust', 'font-stretch', 'font-style',
  'font-synthesis-small-caps', 'font-synthesis-style', 'font-synthesis-weight', 'font-variant',
  'font-variant-caps', 'font-variant-ligatures', 'font-variant-numeric', 'font-variant-position',
  'font-weight', 'forced-color-adjust', 'hyphenate-character', 'hyphenate-limit-chars', 'hyphens',
  'image-orientation', 'letter-spacing', 'line-break', 'line-height', 'list-style-image', 'list-style-type',
  'marker-end', 'marker-mid', 'marker-start', 'math-depth', 'orphans', 'overflow-wrap', 'paint-order',
  'pointer-events', 'quotes', 'ruby-align', 'ruby-overhang', 'ruby-position', 'shape-rendering', 'speak',
  'stroke', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit',
  'stroke-opacity', 'stroke-width', 'tab-size', 'text-align', 'text-align-last', 'text-anchor',
  'text-decoration-skip-ink', 'text-emphasis-color', 'text-emphasis-position', 'text-emphasis-style',
  'text-indent', 'text-justify', 'text-rendering', 'text-shadow', 'text-size-adjust', 'text-transform',
  'text-underline-offset', 'text-underline-position', 'text-wrap-mode', 'text-wrap-style', 'user-select',
  'visibility', 'widows', 'word-break', 'word-spacing', 'writing-mode',
];

/** 同一趟实测里「确实不继承」的属性。只抽了会被误写进表的那几类留在这里做反向卡口。 */
const CHROME_NOT_INHERITED = [
  'align-items', 'animation-name', 'appearance', 'backdrop-filter', 'background-color', 'background-image',
  'border-bottom-color', 'border-bottom-style', 'border-top-left-radius', 'box-shadow', 'clip-path',
  'column-gap', 'content', 'display', 'filter', 'flex-grow', 'float', 'justify-content', 'mask-image',
  'max-height', 'max-width', 'min-height', 'min-width', 'object-fit', 'object-position', 'opacity', 'order',
  'outline-color', 'outline-style', 'outline-width', 'overflow-x', 'overflow-y', 'perspective',
  'row-gap', 'scale', 'scrollbar-gutter', 'scrollbar-width', 'stop-color', 'stop-opacity',
  'text-decoration-color', 'text-decoration-thickness', 'touch-action', 'transition-property', 'translate',
  'vertical-align', 'view-transition-name', 'will-change', 'z-index', 'zoom',
];

test('表里的每一项都不是 Chrome 实测的「不继承」', () => {
  const wrong = CHROME_NOT_INHERITED.filter((p) => INHERITED_PROPS.has(p));
  assert.deepEqual(wrong, [], `这些属性 Chrome 说不继承,写进 INHERITED_PROPS 会拿它们和父值比:${wrong.join(', ')}`);
});

test('Chrome 实测继承的属性一个不缺 —— 缺了顶层元素就漏内联', () => {
  const missing = CHROME_INHERITED.filter((p) => !INHERITED_PROPS.has(p));
  assert.deepEqual(missing, [], `快照顶层元素靠这张表决定内联哪些继承属性,缺一项重放时就会从别人那里继承:${missing.join(', ')}`);
});

test('两张表不重叠:布局解析值属性一律全内联,不该同时按继承属性判', () => {
  const both = [...LAYOUT_USED_VALUE_PROPS].filter((p) => INHERITED_PROPS.has(p));
  assert.deepEqual(both, []);
});

test('表里没有简写、没有大写、没有重复', () => {
  const list = [...INHERITED_PROPS];
  assert.equal(new Set(list).size, list.length);
  for (const prop of list) assert.equal(prop, prop.toLowerCase(), `${prop} 要写成 getComputedStyle 给的小写连字符形式`);
  // 常见简写一律不写进表:getComputedStyle 枚举的是 longhand,写简写永远命不中
  for (const shorthand of ['font', 'list-style', 'text-emphasis', 'border', 'margin', 'padding', 'background'])
    assert.equal(INHERITED_PROPS.has(shorthand), false, `${shorthand} 是简写`);
});

test('自定义属性按继承处理', () => {
  assert.equal(isInheritedProp('--pc-accent'), true);
  assert.equal(isInheritedProp('color'), true);
  assert.equal(isInheritedProp('display'), false);
});
