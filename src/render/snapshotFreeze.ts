/**
 * 把此刻的舞台冻结成一份自给自足的 HTML(HTML 采样缓存,见 scripts/replay-frames.mjs)。
 *
 * 原来写在 `scripts/export-frames.mjs`(引擎现为 `server/bakery/chrome.mjs`)的 `PAGE_PRELUDE` 里、由 `evaluateOnNewDocument` 注入;
 * 现在是页面 bundle 的一部分,导出页(`ExportView`)和舞台页(`StageView`)共用同一份实现,
 * 两页的场景根都是 `[data-pc-scene]`,所以调用点不再写死 `#root.firstElementChild`。
 *
 * 三件事都是实测踩过的:
 *   - 全部计算样式内联,并写死 animation:none / transition:none —— 注入后不能再有任何还在走的钟;
 *   - 整场景 html 的 id 统一改名并同步改掉 url(#…) / href="#…" —— SVG 渐变按 id 引用,重放页里要是还能
 *     解析到别的同名元素,填充整片错掉(growth-curve 实测);
 *   - canvas 换成同尺寸的图(读得出像素的话)—— 克隆出来的画布是空的,粒子和三维画面会整个消失。
 *     读不出来(被污染、WebGL 没开 preserveDrawingBuffer)就留空画布,返回里 lossy 计数。
 *
 * 素材(video / img)只剥 `src`,`data-pc-media-*` 原样留着:重放时由 `__pcPrepareFrameMedia`
 * 按 `data-pc-media-src` / `data-pc-media-time` 把那一帧装回来。判据是 `dataset.pcMediaSrc`,
 * 所以卡片内部自带 `src` 的 `<img>` 不受影响、原样保留。
 *
 * control 快照只记**包裹层的 innerHTML**(卡片组件自己的子树),不含包裹层本身
 * (位置 / opacity / filter / zIndex / isolation —— 挂回时由 Stage 用当前片段照常生成),
 * 不含 `[data-pc-proxy-plane]` 兄弟,也不含素材层(`[data-pc-media]`)。
 * **id 保持原样**:同一份快照会挂到多个片段上,改名在消费侧做(见 `snapshotRename.ts`)。
 */

import { canvasPaintedBox } from "./solid";

export interface FrozenControl {
  /** data-pc-clip */
  id: string;
  /** data-pc-local-frame */
  frame: number;
  /** 包裹层的 innerHTML,id 原样 */
  html: string;
}

export interface FrozenScene {
  html: string;
  /** 读不出像素、只能留空画布的 canvas 数 */
  lossy: number;
  controls: FrozenControl[];
}

export function freezeScene(root: Element | null): FrozenScene {
  if (!root) return { html: "", lossy: 0, controls: [] };
  const clone = root.cloneNode(true) as Element;
  const orig = [root, ...root.querySelectorAll("*")];
  const copy = [clone, ...clone.querySelectorAll("*")];
  let lossy = 0;
  for (let i = 0; i < orig.length; i++) {
    const from = orig[i] as HTMLElement;
    const to = copy[i] as HTMLElement;
    const cs = getComputedStyle(from);
    let s = "";
    for (let k = 0; k < cs.length; k++) {
      const q = cs.item(k);
      s += q + ":" + cs.getPropertyValue(q) + ";";
    }
    s += "animation:none !important;transition:none !important;";
    to.setAttribute("style", s);
    /*
     * 素材层(FrameScene 的 <img data-pc-media-src> / <video data-pc-media-src>)。
     * 只剥 src:快照本身不带外部素材(HTML 重放不能因为这一下就去拉视频),
     * 但 data-pc-media-src / data-pc-media-hidden / data-pc-media-time 必须留着 ——
     * 重放时 __pcPrepareFrameMedia 正是靠它们把这一帧的素材装回来并 seek 到位。
     */
    if (from.dataset?.pcMediaSrc) {
      to.removeAttribute("src");
      if (from.tagName === "VIDEO") to.setAttribute("preload", "none");
      to.style.visibility = "hidden";
    }
    if (from.tagName === "CANVAS") {
      let src: string | null = null;
      try {
        src = (from as HTMLCanvasElement).toDataURL("image/png");
      } catch {
        src = null;
      }
      if (src && src.length > 22) {
        const img = document.createElement("img");
        img.setAttribute("style", s);
        img.setAttribute("width", String((from as HTMLCanvasElement).width));
        img.setAttribute("height", String((from as HTMLCanvasElement).height));
        /*
         * A2(4):实体框写成 data-pc-painted-box="x,y,w,h",**画布像素坐标**(已按取样步长外扩一格、夹回画布内),
         * 不是视口坐标 —— 同一份共享快照会挂到不同位置、不同框的片段上,消费方按 <img> 当前的外框和
         * width / height 属性之比换算(solid.ts 的 paintedBoxRect)。直接 import solid.ts 算,不经 window.__pcCanvasBox。
         * 扫像素读不出来(整块空白 / 污染)就不写属性,消费方退回元素矩形。
         */
        const painted = canvasPaintedBox(from as HTMLCanvasElement);
        if (painted) img.setAttribute("data-pc-painted-box", [painted.x, painted.y, painted.w, painted.h].map((v) => String(Math.round(v))).join(","));
        img.src = src;
        to.replaceWith(img);
      } else lossy++;
    }
  }
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
  return { html, lossy, controls };
}
