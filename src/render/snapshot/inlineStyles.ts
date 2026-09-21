/**
 * 生成快照的第二步:**样式内联**(任务书 3.8;比对口径是底稿 A2(8))。
 *
 * 读 live 元素的计算样式,按「省掉以后重放会变」的口径写进克隆体的 `style` 属性。
 * 瓶颈是**元素数 × 属性数**:lottie 那种两千多节点的卡,`inlineMs` 高就是这一步。
 *
 * 本文件**不 import `rasterizeCanvas`**(任务书 3.8 点名的约束),两步的衔接写在
 * `createSnapshot.ts` 里 —— canvas 换 `<img>` 时要按 IMG 的基线另算一份样式串,
 * 所以这里把 `styleAs(el, tag)` 作为结果的一部分交出去,由 `createSnapshot` 转给
 * `rasterizeCanvas`。两边谁也不认识谁。
 *
 * # 三类判据(底稿 A2(8))
 *
 *   ① **继承属性**(`snapshotStyleProps.mjs` 的 `INHERITED_PROPS`,外加所有 `--*`)——
 *      和**父元素的计算值**比,相等才省。**不能和同标签基线比**:一个继承属性的值恰好
 *      等于基线、却不等于父值时,省掉后重放会继承到父值,画面就错。快照的顶层元素
 *      (整场景 html 的场景根、control 的包裹层直接子节点)继承属性一律照旧全内联 ——
 *      重放时它们的父元素是另一棵树,继承进来的东西不受我们控制。
 *   ② **布局解析值属性**(`LAYOUT_USED_VALUE_PROPS`)一律照旧内联、不参与省略:
 *      `getComputedStyle` 给的是**使用值**(`width: auto` 量出来是 `823.5px`),
 *      和基线偶然相等不代表重放时重新排版还相等。
 *   ③ 其余非继承属性和**同标签基线**比。基线 = 同 `namespaceURI` + `tagName` 的一个
 *      干净元素(无 class、无内联样式)挂在同一张快照页的场景根下量到的计算样式
 *      (= UA 默认 + 主题全局样式),按 `namespaceURI + tagName + themeId` 缓存。
 *
 * 末尾的 `animation:none !important;transition:none !important;` 照旧**每个元素都写** ——
 * 注入后不能再有任何还在走的钟。
 *
 * # 两条必须有的兜底
 *
 * 「重放时的层叠 = 冻结时的层叠」这个前提有两个缺口:
 *   1. **元素自己 `style` 属性里写过的属性**:我们把整个 `style` 换成自己的串,原来的
 *      内联声明就没了。Motion 就是靠内联 `style` 驱动的,`opacity` 动到 1 恰好等于基线的话,
 *      省掉之后重放会掉回类规则里的 `opacity: 0`。
 *   2. **被动画 / 过渡改写的属性**:我们写死了 `animation:none !important`,重放时
 *      `@keyframes` 不再生效、属性掉回声明值。入场动画 `opacity: 0 → 1` 停在 1(= 基线)时
 *      省掉,重放就是 0。
 * 两条都靠「强制内联」解决:前者读 `el.style`,后者读一次 `root.getAnimations({ subtree: true })`
 * 的关键帧属性名。
 */

import { INHERITED_PROPS, LAYOUT_USED_VALUE_PROPS } from "./snapshotStyleProps.mjs";

export const HTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";
/** 每个元素末尾都写的那一条:注入后不能再有任何还在走的钟 */
export const STOP_CLOCKS = "animation:none !important;transition:none !important;";

type Baseline = Map<string, string>;
type BaselineSet = { themeKey: string; byTag: Map<string, Baseline> };

/**
 * 基线缓存挂在**场景根**上(不是全局):同一个文档里可能有别的宿主,而主题是写在场景根的
 * 内联 `style` 上的(`StageView.tsx` / `ExportView.tsx` 都 spread `themeStyle(themeId)`),
 * 所以拿那一串当版本号 —— 换主题就重量一遍(这就是口径里那个 `themeId`)。
 */
const baselineCache = new WeakMap<Element, BaselineSet>();

const tagKey = (ns: string, tag: string) => ns + "|" + tag;
const keyOf = (el: Element) => tagKey(el.namespaceURI || HTML_NS, el.tagName);
const isInherited = (prop: string) =>
  prop.charCodeAt(0) === 45 && prop.charCodeAt(1) === 45 ? true : INHERITED_PROPS.has(prop);

/** 包裹层?control 快照 = 它的 innerHTML,所以它的直接子节点就是快照的顶层元素 */
function isClipWrapper(el: Element | null): boolean {
  return !!el && el.hasAttribute("data-pc-clip") && el.hasAttribute("data-pc-local-frame") && !el.hasAttribute("data-pc-media");
}

/**
 * 量基线:每个 (命名空间, 标签) 一个干净元素挂在场景根下量一次,**一次挂、一次读、一次摘**
 * (别在逐元素循环里反复进出 live DOM —— 每进出一次就是一次强制重排)。
 *
 * - SVG 元素用 `createElementNS` 造并塞进一个真 `<svg>` 里:`createElement` 造出来的是
 *   `HTMLUnknownElement`,`fill` / `stroke` / `display` 的初始值全不对(lottie 五张和
 *   `growth-curve` 正是 SVG)。
 * - 探针整体装在一个挪到视口外、零尺寸、绝对定位的容器里,免得把场景根的布局顶歪。
 */
function ensureBaselines(root: Element, needed: Map<string, { ns: string; tag: string }>): Map<string, Baseline> {
  const themeKey = root.getAttribute("style") || "";
  let entry = baselineCache.get(root);
  if (!entry || entry.themeKey !== themeKey) {
    entry = { themeKey, byTag: new Map() };
    baselineCache.set(root, entry);
  }
  const missing: Array<[string, { ns: string; tag: string }]> = [];
  for (const item of needed) if (!entry.byTag.has(item[0])) missing.push(item);
  if (!missing.length) return entry.byTag;

  const holder = document.createElement("div");
  holder.setAttribute("data-pc-snapshot-baseline", "");
  holder.setAttribute("style", "position:absolute!important;left:-99999px!important;top:0!important;width:0!important;height:0!important;overflow:hidden!important;pointer-events:none!important;visibility:visible!important");
  const probes: Array<[string, Element]> = [];
  for (const [key, { ns, tag }] of missing) {
    let probe: Element | null = null;
    try {
      if (ns === SVG_NS) {
        const svg = document.createElementNS(SVG_NS, "svg");
        probe = tag.toLowerCase() === "svg" ? svg : document.createElementNS(SVG_NS, tag);
        if (probe !== svg) svg.appendChild(probe);
        holder.appendChild(svg);
      } else if (ns && ns !== HTML_NS) {
        probe = document.createElementNS(ns, tag);
        holder.appendChild(probe);
      } else {
        probe = document.createElement(tag);
        holder.appendChild(probe);
      }
    } catch {
      probe = null;   // 造不出来(奇怪的标签名)就没有基线:那一类元素全内联,安全
    }
    if (probe) probes.push([key, probe]);
    else entry.byTag.set(key, new Map());
  }
  root.appendChild(holder);
  for (const [key, probe] of probes) {
    const cs = getComputedStyle(probe);
    const map: Baseline = new Map();
    for (let i = 0; i < cs.length; i++) {
      const prop = cs.item(i);
      map.set(prop, cs.getPropertyValue(prop));
    }
    entry.byTag.set(key, map);
  }
  holder.remove();
  return entry.byTag;
}

const DASH = /[A-Z]/g;
const dashed = (name: string) => (name.startsWith("--") ? name : name.replace(DASH, (c) => "-" + c.toLowerCase()));
const KEYFRAME_META = new Set(["offset", "computedOffset", "easing", "composite"]);

/**
 * 哪些元素的哪些属性正被动画 / 过渡改写。整棵树一次 `getAnimations`,不逐元素问
 * (lottie 那种几千节点的卡逐元素问会把样式内联的时间吃掉)。
 */
function animatedProps(root: Element): Map<Element, Set<string>> {
  const out = new Map<Element, Set<string>>();
  let list: Animation[];
  try {
    list = root.getAnimations({ subtree: true });
  } catch {
    return out;
  }
  for (const anim of list) {
    const effect = anim.effect as KeyframeEffect | null;
    const target = effect && (effect as unknown as { target?: Element }).target;
    if (!target || typeof (effect as unknown as { getKeyframes?: unknown }).getKeyframes !== "function") continue;
    let set = out.get(target);
    if (!set) out.set(target, (set = new Set()));
    let frames: Keyframe[] = [];
    try {
      frames = effect!.getKeyframes();
    } catch { /* 有些实现对没有关键帧的效果会抛 */ }
    for (const frame of frames) for (const name in frame) if (!KEYFRAME_META.has(name)) set.add(dashed(name));
  }
  return out;
}

/** 元素自带的内联样式属性 + 动画改写的属性 —— 这两类一律强制内联,见文件头 */
function forcedProps(el: Element, animated: Map<Element, Set<string>>): Set<string> | null {
  const inline = (el as HTMLElement).style;
  const fromAnim = animated.get(el);
  const count = inline ? inline.length : 0;
  if (!count && !fromAnim) return null;
  const out = fromAnim ? new Set(fromAnim) : new Set<string>();
  for (let i = 0; i < count; i++) out.add(inline.item(i));
  return out;
}

type BuiltStyle = { text: string; inherited: Record<string, string> | null };

/**
 * 按三类判据拼一个元素的样式串,同时把它自己的继承属性值留给子元素做比对。
 *
 * 返回的 `inherited` 在「一个都没变」时**直接复用父元素那个对象**,不新建 —— lottie 一张卡
 * 几千个元素,每个都存一份上百项的记录会把内存吃光。
 */
function buildStyle(
  cs: CSSStyleDeclaration,
  isTop: boolean,
  parentInherited: Record<string, string> | null,
  forced: Set<string> | null,
  baseline: Baseline | undefined,
): BuiltStyle {
  const compareParent = !isTop && parentInherited;
  let inherited: Record<string, string> | null = compareParent ? parentInherited : null;
  let own: Record<string, string> | null = null;
  const ensureOwn = () => {
    if (!own) {
      own = compareParent ? Object.assign(Object.create(null), parentInherited) : Object.create(null);
      inherited = own;
    }
    return own!;
  };
  let text = "";
  for (let k = 0; k < cs.length; k++) {
    const prop = cs.item(k);
    const value = cs.getPropertyValue(prop);
    if (isInherited(prop)) {
      // ① 继承属性:和父元素的计算值比。顶层元素没有可信的父元素,一律内联。
      if (compareParent && parentInherited![prop] === value && !(forced && forced.has(prop))) continue;
      text += prop + ":" + value + ";";
      ensureOwn()[prop] = value;
      continue;
    }
    // ② 布局解析值照旧全内联;强制内联的两类兜底同此
    if (LAYOUT_USED_VALUE_PROPS.has(prop) || (forced && forced.has(prop))) { text += prop + ":" + value + ";"; continue; }
    // ③ 其余非继承属性和同标签基线比
    if (!baseline || baseline.get(prop) !== value) text += prop + ":" + value + ";";
  }
  return { text, inherited };
}

export interface InlineStylesResult {
  /**
   * 按**另一个标签**的基线重算某个 live 元素的样式串(含末尾的 `STOP_CLOCKS`)。
   * 给 `rasterizeCanvas` 用:canvas 换成 `<img>` 之后,IMG 独有的 `overflow: clip` /
   * 替换元素默认尺寸规则和 CANVAS 不一样,复用 CANVAS 的差异串会漏属性。
   * 要用到的标签得先写进 `inlineDOMStyles` 的 `extraBaselineTags`,否则这里没有基线、
   * 退化成整份内联(只多几个字节,不会画错)。
   */
  styleAs(el: Element, tag: string, ns?: string): string;
}

/**
 * 逐元素把差异样式写进克隆体。
 *
 * @param root  live 场景根(`[data-pc-scene]`)。基线探针挂在它下面。
 * @param orig  live 元素数组,`[root, ...root.querySelectorAll('*')]`
 * @param copy  和 `orig` 一一对应的克隆体元素数组
 * @param extraBaselineTags  除了树里出现过的标签,还要预热哪些基线(HTML 命名空间)
 */
export function inlineDOMStyles(
  root: Element,
  orig: Element[],
  copy: Element[],
  extraBaselineTags: string[] = [],
): InlineStylesResult {
  const needed = new Map<string, { ns: string; tag: string }>();
  for (const el of orig) {
    const key = keyOf(el);
    if (!needed.has(key)) needed.set(key, { ns: el.namespaceURI || HTML_NS, tag: el.tagName });
  }
  for (const tag of extraBaselineTags) needed.set(tagKey(HTML_NS, tag), { ns: HTML_NS, tag });
  const baselines = ensureBaselines(root, needed);
  const animated = animatedProps(root);

  const inheritedOf = new Map<Element, Record<string, string> | null>();
  const topOf = new Map<Element, boolean>();
  for (let i = 0; i < orig.length; i++) {
    const from = orig[i];
    const cs = getComputedStyle(from);
    const parent = from.parentElement;
    // 顶层 = 整场景 html 的场景根,或 control 快照里包裹层的直接子节点
    const isTop = from === root || isClipWrapper(parent);
    const parentInherited = isTop || !parent ? null : inheritedOf.get(parent) ?? null;
    const built = buildStyle(cs, isTop, parentInherited, forcedProps(from, animated), baselines.get(keyOf(from)));
    inheritedOf.set(from, built.inherited);
    topOf.set(from, isTop);
    copy[i].setAttribute("style", built.text + STOP_CLOCKS);
  }

  return {
    styleAs(el, tag, ns = HTML_NS) {
      const parent = el.parentElement;
      const isTop = topOf.get(el) ?? (el === root || isClipWrapper(parent));
      const parentInherited = isTop || !parent ? null : inheritedOf.get(parent) ?? null;
      const built = buildStyle(getComputedStyle(el), isTop, parentInherited, forcedProps(el, animated), baselines.get(tagKey(ns, tag)));
      return built.text + STOP_CLOCKS;
    },
  };
}
