/**
 * 占位平面的**舞台一侧**(rendering.md「兜底顺序」;接口见 `placeholder/contract.ts`)。
 *
 * 管四件事,都不碰 React、不 import 占位组件本身(组件由 `Stage.tsx` 引;B 交付后只换那一行 import):
 *
 *   1. **挂不挂**:只有人看的预览(舞台页、`front` 角色)挂。导出页、预渲染、Agent 的查询渲染从不调
 *      `setPlaceholdersEnabled(true)`;`StageView` 在 `setRole('back')` 时关掉。关着时 `Stage` 一个节点都不渲、
 *      样式表也不注入 —— 导出像素基线不受影响。
 *   2. **显示谁**(`placeholderWanted`,纯函数):T1 兜底链尽头(被抑制、这一拍流 blank、又没挂快照)、
 *      T2 `.pc-awaiting`(快照还没到)、T3 `.pc-settling` 且没挂快照(不可见地追帧)、
 *      T4 等后台补跑互换的轻卡(被抑制、分派表说它这一刻是轻卡)。
 *   3. **显隐**:`StageView` 每拍 / 每次平面提交之后按上面的结果只用 contract 的 `setPlaceholderShown`
 *      切槽位的 `hidden`,不经 React 提交(`applyPlaceholders`)。满 120 ms 才可见由占位组件的 CSS 负责。
 *   4. **几何**(`geometryFor`):流清单的实体框(`tight ?? bound`)→ 这张卡上次活渲时量到的墨迹框 →
 *      都没有就在位置框中心只放一个小沙漏徽标(`badge`,不铺噪点)。坐标一律相对包裹层、舞台像素。
 *
 * # 槽位
 *
 * `Stage` 在每张卡的包裹层里挂一个 `[data-pc-placeholder-slot]`(和快照 / 流平面同级,`position:absolute;
 * inset:0`,默认 `hidden`),占位组件渲在槽位里面。显隐切的是槽位的 `hidden`:contract 没规定组件根元素的
 * 初始显隐,而组件又是无状态的纯渲染 —— 由槽位托着,React 每次提交都不会把手动切过的 `hidden` 冲掉
 * (prop 一直是 `true`,React 不会重写它)。截图、墨迹采样、像素扫描、命中测试对槽位和组件根元素
 * 一视同仁(`isPlaceholderNode`)。
 */
import { PLACEHOLDER_ATTR, setPlaceholderShown, type PlaceholderBox, type PlaceholderGeometry, type PlaceholderReason } from "./placeholder/contract.ts";

/** 包裹层里托着占位组件的槽位 */
export const PLACEHOLDER_SLOT_ATTR = "data-pc-placeholder-slot";
/** 槽位或组件根元素 —— 排除 / 命中都按它 */
export const PLACEHOLDER_SELECTOR = `[${PLACEHOLDER_SLOT_ATTR}],[${PLACEHOLDER_ATTR}]`;

/** 这个节点是不是占位符的一部分(槽位、组件根元素或它们里面的东西) */
export function isPlaceholderNode(el: Element | null | undefined): boolean {
  return !!el && typeof el.closest === "function" && !!el.closest(PLACEHOLDER_SELECTOR);
}

/* ------------------------------------------------------------------ 1. 挂不挂 */

let enabled = false;

/** 只有 `StageView`(舞台页、`front` 角色)会打开。缺省关:导出页 / 预渲染 / 后台舞台一个节点都没有 */
export function setPlaceholdersEnabled(on: boolean): void {
  enabled = !!on;
}

export function placeholdersEnabled(): boolean {
  return enabled;
}

let styleEl: HTMLStyleElement | null = null;
/** 占位组件的整张样式表,打开时注入一次(导出页永远走不到这里) */
export function ensurePlaceholderStyle(css: string): void {
  if (styleEl || typeof document === "undefined" || !css) return;
  styleEl = document.createElement("style");
  styleEl.dataset.pcPlaceholder = "1";
  styleEl.textContent = css;
  document.head.appendChild(styleEl);
}

/**
 * 摘掉样式表(`setRole('back')`):K5 互换之后这一台成了后台舞台,
 * 「后台舞台不注入占位样式」要对它也成立。再转正时 `Stage` 会重新注入。
 */
export function removePlaceholderStyle(): void {
  styleEl?.remove();
  styleEl = null;
}

/* ------------------------------------------------------------------ 2. 显示谁 */

export interface PlaceholderState {
  /** 播放中被抑制的卡(判重 + K3(b) 的额外抑制) */
  suppressed: ReadonlySet<string>;
  /** 此刻挂着快照平面的卡 */
  snapshots: ReadonlyMap<string, unknown> | ReadonlySet<string>;
  /** `.pc-awaiting`:这一帧的快照还没到 */
  awaiting: ReadonlySet<string>;
  /** `.pc-settling`:正在不可见地追帧 */
  settling: ReadonlyMap<string, unknown>;
  /** 这一拍流画面在的卡(`StreamPlayer.showingClips()`) */
  streamShowing: ReadonlySet<string>;
  /** 被抑制但这一刻判轻的卡(K3(b) 的 `vtOk = false` 轻卡在等后台补跑);缺省看 `setCatchingUpClips` 那一份 */
  isLight?: (clipId: string) => boolean;
}

/** T4 的那几张(被抑制、这一刻判轻:等后台补跑互换)。`StageView` 收到 `setSuppressed` 时按分派表算好 */
let catchingUp: ReadonlySet<string> = new Set();
export function setCatchingUpClips(ids: Iterable<string>): void {
  catchingUp = new Set(ids);
}
export function isCatchingUpClip(clipId: string): boolean {
  return catchingUp.has(clipId);
}

/** 这一拍哪几张卡要显示占位符、为什么(T1~T4) */
export function placeholderWanted(s: PlaceholderState): Map<string, PlaceholderReason> {
  const out = new Map<string, PlaceholderReason>();
  for (const id of s.suppressed) {
    if (s.snapshots.has(id) || s.streamShowing.has(id)) continue;
    // T4:等后台补跑后互换的轻卡;其余是 T1(兜底链尽头)
    out.set(id, (s.isLight ?? isCatchingUpClip)(id) ? "catching-up" : "no-data");
  }
  // T2:快照还没到(`.pc-awaiting` 500 ms 兜底之后由舞台摘掉,占位符随之撤)
  for (const id of s.awaiting) out.set(id, "awaiting");
  // T3:不可见地追帧,又没有快照垫着
  for (const id of s.settling.keys()) {
    if (!s.snapshots.has(id) && !out.has(id)) out.set(id, "catching-up");
  }
  return out;
}

/* ------------------------------------------------------------------ 3. 显隐 */

/** 上一次显示着的那几张(下一次要能把它们关掉) */
let shown = new Set<string>();
/** 每张从哪一刻起显示着(真墙钟;探针据此把 120 ms 延迟内的空档单列) */
const since = new Map<string, number>();
/** 舞台页的 `performance.now` / `Date.now` 都被接管成舞台时间,量真实时间要用 `__pcRealNow` */
const realNow = (): number => {
  const w = globalThis as unknown as { __pcRealNow?: () => number };
  return typeof w.__pcRealNow === "function" ? w.__pcRealNow() : Date.now();
};

/**
 * 按 `wanted` 切槽位的 `hidden`。只动这几张:这一拍要显示的 + 上一拍显示着的。
 * `slotOf` 找这张卡包裹层里的槽位(没挂着就跳过:卡刚下场、或者 `Stage` 还没提交)。
 * 回这一次显示着几个(诊断 / 探针用)。
 */
export function applyPlaceholders(wanted: ReadonlyMap<string, PlaceholderReason>, slotOf: (clipId: string) => HTMLElement | null): number {
  let n = 0;
  for (const id of new Set([...wanted.keys(), ...shown])) {
    const slot = slotOf(id);
    if (!slot) continue;
    const on = wanted.has(id);
    setPlaceholderShown(slot, on);
    if (on) {
      n++;
      const reason = wanted.get(id)!;
      if (slot.getAttribute("data-pc-placeholder-reason") !== reason) slot.setAttribute("data-pc-placeholder-reason", reason);
    }
  }
  const now = realNow();
  for (const id of wanted.keys()) if (!shown.has(id) || !since.has(id)) since.set(id, now);
  for (const id of [...since.keys()]) if (!wanted.has(id)) since.delete(id);
  shown = new Set(wanted.keys());
  return n;
}

/** 这张从哪一刻起显示着(真墙钟毫秒);没显示回 undefined */
export function shownSince(clipId: string): number | undefined {
  return since.get(clipId);
}

/** 全部撤下(`setRole('back')`、关掉时) */
export function hideAllPlaceholders(slotOf: (clipId: string) => HTMLElement | null): void {
  applyPlaceholders(new Map(), slotOf);
}

export function shownPlaceholders(): ReadonlySet<string> {
  return shown;
}

/* ------------------------------------------------------------------ 4. 几何 */

/** 流清单的实体框(包裹层坐标)。由 `StageView` 接到 `StreamPlayer.boxOf` 上 */
let streamBoxOf: (clipId: string) => { x: number; y: number; w: number; h: number } | null = () => null;
export function setStreamBoxSource(fn: typeof streamBoxOf): void {
  streamBoxOf = fn;
}

/** 流清单量到过的框,流停了也留着(下一次来不及时还用得上) */
const streamBoxes = new Map<string, PlaceholderBox>();
/** 上次活渲时量到的墨迹框(包裹层坐标) */
const inkBoxes = new Map<string, PlaceholderBox>();

/**
 * 真渲之后量到的墨迹框(`StageView` 暂停态防抖采样)。量不到(`null`:什么都没画,或内容铺满整张卡 ——
 * `measureContentBox` 两者不分)就不记:宁可退到徽标,也不在量不准的时候铺满噪点。
 */
export function noteInkBox(clipId: string, box: PlaceholderBox | null): void {
  if (box && box.width > 0 && box.height > 0) inkBoxes.set(clipId, box);
}

/** 换项目时清掉:clipId 会复用 */
export function resetPlaceholderGeometry(): void {
  streamBoxes.clear();
  inkBoxes.clear();
  geometryCache.clear();
}

const geometryCache = new Map<string, { key: string; geometry: PlaceholderGeometry }>();

/**
 * 这张卡的占位几何(相对包裹层、舞台像素)。`size` 是包裹层(= 位置框)的尺寸。
 * 同样的输入回同一个对象(占位组件是 `React.memo`,几何对象换了才重渲)。
 */
export function geometryFor(clipId: string, size: { width: number; height: number }): PlaceholderGeometry {
  const fresh = streamBoxOf(clipId);
  if (fresh && fresh.w > 0 && fresh.h > 0) streamBoxes.set(clipId, { left: fresh.x, top: fresh.y, width: fresh.w, height: fresh.h });
  const stream = streamBoxes.get(clipId);
  const ink = inkBoxes.get(clipId);
  let geometry: PlaceholderGeometry;
  if (stream) geometry = { kind: "solid", box: stream };
  else if (ink) geometry = { kind: "solid", box: ink };
  else geometry = { kind: "badge", center: { x: size.width / 2, y: size.height / 2 } };
  const key = JSON.stringify(geometry);
  const hit = geometryCache.get(clipId);
  if (hit && hit.key === key) return hit.geometry;
  geometryCache.set(clipId, { key, geometry });
  return geometry;
}
