/**
 * 把此刻的舞台**生成一份快照** —— 一份自给自足的 HTML(HTML 采样缓存,见 scripts/replay-frames.mjs)。
 *
 * 原来写在 `scripts/export-frames.mjs`(引擎现为 `server/bakery/chrome.mjs`)的 `PAGE_PRELUDE` 里、
 * 由 `evaluateOnNewDocument` 注入;现在是页面 bundle 的一部分,导出页(`ExportView`)和
 * 舞台页(`StageView`)共用同一份实现,两页的场景根都是 `[data-pc-scene]`,
 * 所以调用点不再写死 `#root.firstElementChild`。
 *
 * # 五步(任务书 3.8)
 *
 *   `cloneScene`      复制 DOM
 *   `inlineDOMStyles` 读计算样式、按差异口径写进 `style`(`snapshot/inlineStyles.ts`)
 *   `rasterizeCanvas` 读像素、压成图片、写实体框(`snapshot/rasterizeCanvas.ts`)
 *   `stripMedia`      素材层只留占位属性
 *   `serializeScene`  `outerHTML`、整场景的 id 改名、逐控件取包裹层 `innerHTML`
 *
 * 中间两步各自一个文件、**互不 import**:canvas 换 `<img>` 时要按 IMG 的基线另算一份
 * 样式串,那个衔接写在这里(`inlineDOMStyles` 交出 `styleAs`,转给 `rasterizeCanvas`)。
 *
 * # 三件实测踩过的事
 *
 *   - 样式内联并写死 animation:none / transition:none —— 注入后不能再有任何还在走的钟;
 *   - 整场景 html 的 id 统一改名并同步改掉 url(#…) / href="#…" —— SVG 渐变按 id 引用,
 *     重放页里要是还能解析到别的同名元素,填充整片错掉(growth-curve 实测);
 *   - canvas 换成同尺寸的图 —— 克隆出来的画布是空的,粒子和三维画面会整个消失。
 *
 * 素材(video / img)只剥 `src`,`data-pc-media-*` 原样留着:重放时由 `__pcPrepareFrameMedia`
 * 按 `data-pc-media-src` / `data-pc-media-time` 把那一帧装回来。判据是 `dataset.pcMediaSrc`,
 * 所以卡片内部自带 `src` 的 `<img>` 不受影响、原样保留。
 *
 * control 快照只记**包裹层的 innerHTML**(卡片组件自己的子树),不含包裹层本身
 * (位置 / opacity / filter / zIndex / isolation —— 挂回时由 Stage 用当前片段照常生成),
 * 不含 `[data-pc-proxy-plane]` 兄弟,也不含素材层(`[data-pc-media]`)。
 * **id 保持原样**:同一份快照会挂到多个片段上,改名在消费侧做(见 `snapshotRename.ts`)。
 *
 * # 三个耗时数(任务书 3.8)
 *
 * `timing` 把生成快照拆成三段单独上报:`inlineMs`(样式内联)、`rasterMs`(画布栅格化)、
 * `serializeMs`(序列化)。它们**不进判重**(判重只看活渲的 `stepMs`),只用来排探针和
 * 预渲染的产能,并让「哪类卡超标」一眼可见:`inlineMs` 高 = DOM 太复杂,`rasterMs` 高 = 画布太大。
 *
 * 任务书只点名三个函数要计时,而五步里 `cloneScene` / `stripMedia` 也要花时间,
 * 又必须让 `inlineMs + rasterMs + serializeMs` 覆盖整趟(3.8 的产能估算是四个数相加)。
 * 这里的归属:**`cloneScene` 并进 `inlineMs`**(同样按元素数线性增长,和「DOM 太复杂」
 * 是同一个病因)、**`stripMedia` 并进 `serializeMs`**(它只扫素材层,量级可以忽略)。
 *
 * 计时用 `window.__pcRealNow`(舞台页由 `stageClock` 挂):导出页把 `performance.now`
 * 改写成了虚拟时间(`kernel/exportClock.ts`),直接用会量出 0。导出页没挂 `__pcRealNow`,
 * 退回 `Date.now()` —— 那一侧不上报这三个数,精度无所谓。
 */

import { inlineDOMStyles, HTML_NS } from "./snapshot/inlineStyles";
import { rasterizeCanvas } from "./snapshot/rasterizeCanvas";

export interface ControlSnapshot {
  /** data-pc-clip */
  id: string;
  /** data-pc-local-frame */
  frame: number;
  /** 包裹层的 innerHTML,id 原样 */
  html: string;
}

/** 生成快照的三段耗时(毫秒)。都不进判重,见文件头。 */
export interface SnapshotTiming {
  /** 复制 DOM + 样式内联 */
  inlineMs: number;
  /** 画布栅格化(没有画布的卡是 0) */
  rasterMs: number;
  /** 素材层占位 + 序列化 + id 改名 + 逐控件切子树 */
  serializeMs: number;
}

export interface SceneSnapshot {
  html: string;
  /** 读不出像素、只能留空画布的 canvas 数 */
  lossy: number;
  controls: ControlSnapshot[];
  timing: SnapshotTiming;
}

const nowMs = (): number => (window.__pcRealNow ?? Date.now)();

/** 第一步:复制 DOM。返回 live 与克隆体一一对应的两个数组。 */
function cloneScene(root: Element): { clone: Element; orig: Element[]; copy: Element[] } {
  const orig = [root, ...root.querySelectorAll("*")];
  const clone = root.cloneNode(true) as Element;
  const copy = [clone, ...clone.querySelectorAll("*")];
  return { clone, orig, copy };
}

/**
 * 第四步:素材层只留占位属性。
 *
 * 只剥 src:快照本身不带外部素材(HTML 重放不能因为这一下就去拉视频),
 * 但 data-pc-media-src / data-pc-media-hidden / data-pc-media-time 必须留着 ——
 * 重放时 __pcPrepareFrameMedia 正是靠它们把这一帧的素材装回来并 seek 到位。
 */
function stripMedia(orig: Element[], copy: Element[]): void {
  for (let i = 0; i < orig.length; i++) {
    const from = orig[i] as HTMLElement;
    if (!from.dataset?.pcMediaSrc) continue;
    const to = copy[i] as HTMLElement;
    to.removeAttribute("src");
    if (from.tagName === "VIDEO") to.setAttribute("preload", "none");
    to.style.visibility = "hidden";
  }
}

/** 第五步:`outerHTML` + 整场景的 id 改名 + 逐控件取包裹层 `innerHTML`。 */
function serializeScene(root: Element, clone: Element): { html: string; controls: ControlSnapshot[] } {
  let html = clone.outerHTML;
  const ids = new Set(
    [...root.querySelectorAll("[id]")].map((e) => e.id).concat(root.id ? [root.id] : []),
  );
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const id of ids) {
    const e = esc(id);
    html = html
      .replace(new RegExp(`(\\sid=")${e}(")`, "g"), `$1${id}__r$2`)
      .replace(new RegExp(`(url\\((?:&quot;|["'])?[^)"'&]*#)${e}((?:&quot;|["'])?\\))`, "g"), `$1${id}__r$2`)
      .replace(new RegExp(`((?:xlink:)?href="#)${e}(")`, "g"), `$1${id}__r$2`);
  }
  // `:not([data-pc-media])` 排除 FrameScene 的素材层 —— 它也带 data-pc-clip + data-pc-local-frame。
  const controls = [...clone.querySelectorAll("[data-pc-clip][data-pc-local-frame]:not([data-pc-media])")].map((el) => {
    const inner = el.cloneNode(true) as Element;
    inner.querySelectorAll("[data-pc-proxy-plane]").forEach((plane) => plane.remove());
    return {
      id: el.getAttribute("data-pc-clip") || "",
      frame: Number(el.getAttribute("data-pc-local-frame")),
      html: inner.innerHTML,
    };
  });
  return { html, controls };
}

export function createSnapshot(root: Element | null): SceneSnapshot {
  if (!root) return { html: "", lossy: 0, controls: [], timing: { inlineMs: 0, rasterMs: 0, serializeMs: 0 } };

  const t0 = nowMs();
  const { clone, orig, copy } = cloneScene(root);
  // "IMG":canvas 换 <img> 那一支要按 IMG 的基线另算(见 rasterizeCanvas.ts)。
  // 基线在这里预热,免得 rasterizeCanvas 第一次问的时候才去挂探针、把时间算进 rasterMs。
  const styles = inlineDOMStyles(root, orig, copy, ["IMG"]);
  const t1 = nowMs();

  const { lossy } = rasterizeCanvas(orig, copy, (el) => styles.styleAs(el, "IMG", HTML_NS));
  const t2 = nowMs();

  stripMedia(orig, copy);
  const { html, controls } = serializeScene(root, clone);
  const t3 = nowMs();

  return { html, lossy, controls, timing: { inlineMs: t1 - t0, rasterMs: t2 - t1, serializeMs: t3 - t2 } };
}
