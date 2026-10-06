/**
 * 浏览器逐帧导出的合成(`docs/plan/c10a-contract.md` 第 11.1 节「逐帧」)。
 *
 * # 做法
 *
 * 1. **场景**:页面里开一个同源的导出页(`?export=1`,`src/ExportView.tsx`,和预渲染进程、桌面导出同一份页面与钉时间的办法),
 *    灌进项目,每一帧照 `server/bakery/bake.mjs` 的步子推:`__pcSetT` → 排空 → 等一拍 → `__pcSyncAnims` → 排空 → `__pcFrameReady`,
 *    再生成整场景快照(`__pcCreateSnapshot`:样式内联、画布换成图、素材层只留占位)。
 * 2. **重卡**:在预渲染集合里的片段(层表,渲染节点的判定),包裹层里的活组件换成**预渲染原尺寸**的 HTML 快照
 *    (素材服务 `snap/<hash>`,按清单取)—— 重卡用已有的原尺寸,不重渲(语义 `product/platforms.md`「面向的平台」)。
 * 3. **素材**:导出页按素材原尺寸的地址装素材(`__pcPrepareFrameMedia`:`<video>` 按 Range 取当前需要的那一段,不整片读进内存),
 *    装好后把这一帧的画面画成图、替进快照里素材的占位(层序、框、裁切、滤镜都跟着占位元素走)。
 * 4. **栅格化**:整张快照包成 SVG `foreignObject`,以 `data:` 地址载成图画到复用的原尺寸画布上。
 *    Chrome 实测:`data:` 地址的 foreignObject 图不污染画布(能 `new VideoFrame(canvas)`),`blob:` 地址的会污染。
 *    快照里只用系统字体、图片全是 `data:`(`createSnapshot` 的约定),SVG 图里取不到外部资源也不缺东西;
 *    卡片自带的外部字体(如 KaTeX)在这条路上会退回系统字体 —— 误差见报告。
 *
 * 一次只合成一帧,画布复用(原尺寸一张);素材帧转成 JPEG(质量 0.95)的 data 地址,用完即丢。
 */
import type { Project } from "../kernel/project";
import { renameSnapshotIds } from "../render/snapshotRename";
import { withTicket } from "./ticketRenewal";
import { syncedUserCards } from "../kernel/registry";

type ExportWindow = Window & typeof globalThis & {
  __pcReady?: boolean;
  __pcSetT?: (sec: number, directSec?: number) => void;
  __bfSettle?: () => Promise<void>;
  __pcSyncAnims?: () => void;
  __pcStaticProbe?: () => { finished?: number } | null;
  __pcFrameReady?: () => Promise<void>;
  __pcCreateSnapshot?: () => { html: string; lossy?: number | boolean };
  __pcPrepareFrameMedia?: () => Promise<void>;
  __pcHideFrameMedia?: () => void;
  __pcLoadProject?: (p: unknown, o?: unknown) => Promise<void>;
  /** 导出页:接同步来的用户卡的表(在线导出把它们的包裹层挂出来,好换成预渲染原尺寸) */
  __pcSetSyncedUserCards?: (entries: unknown[]) => void;
  __pcRealRaf?: (cb: FrameRequestCallback) => number;
  /** `?rafControl=1` 时由 `src/render/stageClockEntry.ts` 装:跑一轮排着的 rAF 回调(一拍),回跑了几个 */
  __pcBrowserBeginFrame?: () => number;
  __pcRafFallbacks?: number;
  __pcSetFrameWindow?: (clipIds: string[] | null, startTime: number, directTime?: number) => void;
  __pcRestartCards?: () => void;
  __pcResetAnims?: () => void;
};

export interface HeavyOriginals {
  /** 这一刻(全局帧)这张卡要用的预渲染原尺寸 HTML 快照;不在预渲染集合里给 undefined(照活渲) */
  htmlFor(clipId: string, globalFrame: number): Promise<string | undefined>;
}

export interface CompositorOptions {
  project: Project;
  /** 导出页地址(同源,`?export=1`);不给就按当前页面拼 */
  exportUrl?: string;
  /** 重卡的原尺寸;不给 = 全部活渲(只给探针 / 桌面对照用) */
  originals?: HeavyOriginals | null;
  /** 素材帧的 JPEG 质量 */
  mediaQuality?: number;
  /** 背景色(成片不透明) */
  background?: string;
  signal?: AbortSignal;
  /**
   * 当前的只读票据(C10 契约第 12 节:导出途中按时限续签)。给了就在每一帧装素材之前,把导出页里素材地址的 `?t=` 换成这一张 ——
   * 导出页每一帧都按 `data-pc-media-src` 重新装素材(`frameMedia.ts`),所以跨过票据时限也照常取得到。
   */
  freshTicket?: () => string | null;
}

const EMPTY = (p: Project) => ({ width: p.width, height: p.height, fps: p.fps, duration: 1, tracks: [], media: [] });

/**
 * 同源导出页的地址:当前页面的路径 + `?export=1&rafControl=1` + 空项目(项目随后经 `__pcLoadProject` 灌进去)。
 * `rafControl=1`:导出页的 rAF 由这里手动推(`src/render/stageClockEntry.ts`),一拍对应桌面导出的一次 beginFrame。
 */
export function exportPageUrl(project: Project, loc: Pick<Location, "origin" | "pathname"> = location): string {
  const timeline = "data:application/json," + encodeURIComponent(JSON.stringify(EMPTY(project)));
  return `${loc.origin}${loc.pathname}?export=1&rafControl=1&timeline=${encodeURIComponent(timeline)}`;
}

/** 快照 HTML → 放进 SVG foreignObject 的 XHTML(外面包一层和舞台同尺寸的根) */
export function sceneToSvg(nodes: Iterable<Node>, width: number, height: number, css = ""): string {
  const ser = new XMLSerializer();
  let body = "";
  for (const n of nodes) body += ser.serializeToString(n);
  const style = css ? `<style><![CDATA[${css.replace(/\]\]>/g, "]]]]><![CDATA[>")}]]></style>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject x="0" y="0" width="${width}" height="${height}">`
    + `<div xmlns="http://www.w3.org/1999/xhtml" style="position:relative;width:${width}px;height:${height}px;overflow:hidden">${style}${body}</div></foreignObject></svg>`;
}

/**
 * 导出页的样式表全文(读得到规则的那些)。快照的样式内联按「和同标签基线比、相等就省」的口径
 * (`src/render/snapshot/inlineStyles.ts`),基线含页面的全局样式(Tailwind 的 preflight:`box-sizing: border-box`、
 * `margin: 0`、`border: 0 solid` 等),所以快照要挂在带同一套样式的页面里重放(舞台页就是这样)。
 * SVG foreignObject 里没有页面样式,省掉的这些会退回浏览器缺省值 —— 实测 `box-sizing` 退回 `content-box`,
 * 药丸、章节条的内边距被加在内联的宽高之外,整块变大。所以栅格化时把导出页的样式表一并放进去。
 */
export function pageCssText(doc: Document): string {
  let out = "";
  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList;
    try { rules = sheet.cssRules; } catch { continue; } // 跨源样式表读不到规则
    for (const r of Array.from(rules)) out += r.cssText + "\n";
  }
  return out;
}

export class ExportCompositor {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private frameEl: HTMLIFrameElement;
  private w: ExportWindow;
  private opts: CompositorOptions;
  private scratch: HTMLCanvasElement;
  readonly stats = { frames: 0, stepMs: 0, snapshotMs: 0, mediaMs: 0, rasterMs: 0, heavyReplaced: 0, mediaFrames: 0, manualTicks: 0, rafFallbacks: 0, ticketSwaps: 0 };

  private constructor(frameEl: HTMLIFrameElement, opts: CompositorOptions) {
    this.frameEl = frameEl;
    this.w = frameEl.contentWindow as ExportWindow;
    this.opts = opts;
    this.canvas = document.createElement("canvas");
    this.canvas.width = opts.project.width;
    this.canvas.height = opts.project.height;
    this.ctx = this.canvas.getContext("2d", { alpha: false, willReadFrequently: true })!;
    this.scratch = document.createElement("canvas");
  }

  /** 开导出页、灌项目、等就绪 */
  static async open(opts: CompositorOptions): Promise<ExportCompositor> {
    const p = opts.project;
    const el = document.createElement("iframe");
    el.setAttribute("aria-hidden", "true");
    el.title = "逐帧导出";
    el.dataset.pc = "browser-export-frame";
    // 只能 opacity:0 藏:display:none / visibility:hidden 会停掉里面的 rAF 与 <video>(和后台舞台同一个理由)
    el.style.cssText = `position:fixed;left:0;top:0;width:${p.width}px;height:${p.height}px;border:0;opacity:0;pointer-events:none;z-index:-1`;
    el.src = opts.exportUrl ?? exportPageUrl(p);
    document.body.appendChild(el);
    const c = new ExportCompositor(el, opts);
    try {
      await c.waitFor(() => c.w?.__pcReady === true && typeof c.w.__pcLoadProject === "function", 60_000, "导出页 60 秒没就绪");
      // 同步来的用户卡在导出页里没有定义:把同步表交给它,让这些卡的包裹层挂出来,逐帧换成预渲染原尺寸
      if (syncedUserCards().size) c.w.__pcSetSyncedUserCards?.([...syncedUserCards().values()]);
      await c.w.__pcLoadProject!(p);
      await c.waitFor(() => c.w.__pcReady === true && typeof c.w.__pcSetT === "function", 60_000, "导出页 60 秒没装好项目");
    } catch (e) {
      c.close();
      throw e;
    }
    return c;
  }

  private async waitFor(ok: () => boolean, ms: number, message: string): Promise<void> {
    const t0 = performance.now();
    for (;;) {
      this.throwIfAborted();
      try { if (ok()) return; } catch { /* 页面还没起来 */ }
      if (performance.now() - t0 > ms) throw new Error(message);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  private throwIfAborted() {
    if (this.opts.signal?.aborted) throw Object.assign(new Error("已取消"), { cancelled: true });
  }

  /**
   * 导出页里推一拍。导出页带 `rafControl=1` 时手动跑一轮 rAF 回调,不等真 vsync —— Motion 的帧循环不会在合成期间自己多走;
   * 没有手动推的口子(外部给的 exportUrl)时退回等一次真 rAF。
   */
  private raf(): Promise<void> {
    const begin = this.w.__pcBrowserBeginFrame;
    if (typeof begin === "function") {
      begin();
      this.stats.manualTicks++;
      this.stats.rafFallbacks = this.w.__pcRafFallbacks ?? 0;
      // 回调里排的宏任务(React 调度器的 MessageChannel 等)让它落地,和等过一次真 rAF 之后的状态一致
      return new Promise((resolve) => setTimeout(resolve, 0));
    }
    const raf = this.w.__pcRealRaf ?? this.w.requestAnimationFrame.bind(this.w);
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      raf(() => finish());
      // 页面被判不可见时 rAF 可能停:封一个上限,不让导出挂死
      setTimeout(finish, 250);
    });
  }

  private async settle() { await this.w.__bfSettle?.(); }

  /** 推到这一帧(照 `bake.mjs` 的 `createStepper`,拍由 rAF 给) */
  private async stepTo(frame: number, fps: number) {
    const sec = frame / fps;
    this.w.__pcHideFrameMedia?.();
    this.w.__pcSetT!(sec, sec);
    await this.settle();
    await this.raf();
    await this.settle();
    this.w.__pcSyncAnims?.();
    await this.settle();
    const probe = this.w.__pcStaticProbe?.();
    if (probe?.finished) {
      for (let pass = 0; pass < 2; pass++) {
        await this.raf();
        await this.settle();
        this.w.__pcSyncAnims?.();
        await this.settle();
      }
    }
    await this.w.__pcFrameReady?.();
    await this.w.document.fonts.ready;
    // 生成快照之前画两拍:Motion 的 JS 帧循环只在真画一帧时把新值写进 style(`bake.mjs` 的 flushFrameLoop)
    await this.raf();
    await this.raf();
    await this.settle();
    this.w.__pcSyncAnims?.();
  }

  /** 素材元素的这一帧画成 JPEG 的 data 地址;画不出(没载上、跨源被污染)给 null */
  private mediaFrameUrl(el: HTMLVideoElement | HTMLImageElement): string | null {
    const isVideo = el.tagName === "VIDEO";
    const w = isVideo ? (el as HTMLVideoElement).videoWidth : (el as HTMLImageElement).naturalWidth;
    const h = isVideo ? (el as HTMLVideoElement).videoHeight : (el as HTMLImageElement).naturalHeight;
    if (!w || !h) return null;
    this.scratch.width = w;
    this.scratch.height = h;
    const g = this.scratch.getContext("2d")!;
    g.clearRect(0, 0, w, h);
    try {
      g.drawImage(el, 0, 0, w, h);
      return isVideo ? this.scratch.toDataURL("image/jpeg", this.opts.mediaQuality ?? 0.95) : this.scratch.toDataURL("image/png");
    } catch {
      return null;
    }
  }

  private warmed = -1;
  /** 导出页的样式表全文,第一帧读一次(`pageCssText`) */
  private css: string | null = null;
  /**
   * 从 `startFrame` 起一趟连续出帧之前的预热(照 `bake.mjs` 的 `__pcSetFrameWindow` + `warmUpAt`):全部卡按活跃判据挂载、
   * 时钟拨到起点、推 3 拍、重挂载卡片并清动画锚点、再推一拍。少了这一步,Motion 的弹簧等动画的锚点落在载入项目那一刻,
   * 和桌面导出差出相位。
   */
  private async warmUp(startFrame: number, fps: number) {
    const sec = startFrame / fps;
    this.w.__pcSetFrameWindow?.(null, sec, sec);
    for (let i = 0; i < 3; i++) { await this.stepTo(startFrame, fps); await this.raf(); }
    this.w.__pcRestartCards?.();
    this.w.__pcResetAnims?.();
    await this.stepTo(startFrame, fps);
    await this.raf();
    this.w.__pcResetAnims?.();
    this.warmed = startFrame;
  }

  /** 合成第 `frame` 帧到 `canvas`,回画布(同一张,下一帧会被覆盖)。帧号要从起点逐帧递增(和桌面导出一样顺推) */
  async frame(frame: number): Promise<HTMLCanvasElement> {
    this.throwIfAborted();
    const p = this.opts.project;
    const fps = Math.max(1, p.fps || 30);
    const doc = this.w.document;
    let t0 = performance.now();
    if (this.warmed < 0) await this.warmUp(frame, fps);
    await this.stepTo(frame, fps);
    this.stats.stepMs += performance.now() - t0;

    t0 = performance.now();
    const snap = this.w.__pcCreateSnapshot!();
    if (snap.lossy) throw new Error("这一帧有读不出像素的画布,导不出来");
    const tpl = document.createElement("template");
    tpl.innerHTML = snap.html;
    // 重卡:包裹层里换成预渲染原尺寸
    if (this.opts.originals) {
      for (const wrap of tpl.content.querySelectorAll<HTMLElement>("[data-pc-clip]")) {
        if (wrap.hasAttribute("data-pc-media")) continue;
        const clipId = wrap.getAttribute("data-pc-clip")!;
        const html = await this.opts.originals.htmlFor(clipId, frame);
        if (html === undefined) continue;
        wrap.innerHTML = renameSnapshotIds(html, clipId);
        this.stats.heavyReplaced++;
      }
    }
    this.stats.snapshotMs += performance.now() - t0;

    // 素材:原尺寸按这一帧装好,画成图替进占位(跨源素材要按 CORS 取,否则画布被污染)
    t0 = performance.now();
    const live = [...doc.querySelectorAll<HTMLVideoElement | HTMLImageElement>("[data-pc-scene] video[data-pc-media-src], [data-pc-scene] img[data-pc-media-src]")];
    if (live.length) {
      for (const el of live) if (!el.crossOrigin) el.crossOrigin = "anonymous";
      const ticket = this.opts.freshTicket?.() ?? null;
      if (ticket) {
        for (const el of live) {
          const src = el.getAttribute("data-pc-media-src") ?? "";
          const next = withTicket(src, ticket);
          if (next !== src) { el.setAttribute("data-pc-media-src", next); this.stats.ticketSwaps++; }
        }
      }
      await this.w.__pcPrepareFrameMedia?.();
      const holes = [...tpl.content.querySelectorAll<HTMLElement>("video[data-pc-media-src], img[data-pc-media-src]")];
      holes.forEach((hole, i) => {
        const el = live[i];
        if (!el) return;
        const shown = el.style.visibility !== "hidden" && hole.getAttribute("data-pc-media-hidden") !== "true";
        const url = shown ? this.mediaFrameUrl(el) : null;
        const img = document.createElement("img");
        for (const attr of [...hole.attributes]) if (attr.name !== "src" && !attr.name.startsWith("data-pc-media")) img.setAttribute(attr.name, attr.value);
        img.style.visibility = url ? "visible" : "hidden";
        if (url) { img.setAttribute("src", url); this.stats.mediaFrames++; }
        hole.replaceWith(img);
      });
      this.w.__pcHideFrameMedia?.();
    }
    this.stats.mediaMs += performance.now() - t0;

    // 栅格化:整张快照 → SVG foreignObject(data 地址,不污染画布)→ 原尺寸画布
    t0 = performance.now();
    this.css ??= pageCssText(doc);
    const svg = sceneToSvg(tpl.content.childNodes, p.width, p.height, this.css);
    const img = new Image();
    img.decoding = "sync";
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    await img.decode();
    this.ctx.fillStyle = this.opts.background ?? "#000";
    this.ctx.fillRect(0, 0, p.width, p.height);
    this.ctx.drawImage(img, 0, 0, p.width, p.height);
    this.stats.rasterMs += performance.now() - t0;
    this.stats.frames++;
    return this.canvas;
  }

  close(): void {
    try { this.frameEl.remove(); } catch { /* 已经摘了 */ }
    this.scratch.width = this.scratch.height = 0;
  }
}
