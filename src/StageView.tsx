import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Stage } from "./kernel/Stage";
import { partsTiming } from "./kernel/parts";
import { getPart } from "./parts/registry";
import { flattenOverlay, type Project } from "./kernel/project";
import { installStageClock } from "./render/stageClock";
import { createAnimationPinner } from "./render/pinAnimations";
import { canvasBox } from "./editor/left/contentBox";
import { ensureProxyStyle, proxyAllowed, proxyOf, resetInk, sampleAll } from "./render/solidMode";
import { themeStyle } from "./themes";
import "./cards";

/**
 * 渲染面(?stage=1)。编辑器把它放在一个 iframe 里,只下发「现在是时间轴的第几秒」,
 * 由它渲染出那一秒的画面。它自己不按墙上时钟播:时间被 stageClock 接管,
 * 卡片的 Motion 帧循环和 rAF 都由 render() 显式推进,所以
 *   - 拖播放头到片段中间 = 直接出那一刻的画面(不会从头重播一遍进场动画)
 *   - 播放 = 编辑器每帧下发新的 t,这里推进一帧
 * 和导出视图(?export=1)是同一套办法、同一份卡片代码,预览所见 = 导出所得。
 */

const isStageRoute = typeof window !== "undefined" && new URLSearchParams(location.search).has("stage");
// 时间必须在任何卡片挂载之前接管
const clock = isStageRoute ? installStageClock() : null;
const pinner = createAnimationPinner();

/** 和 Stage 里的提前量保持一致:卡片提前 0.05s 挂载,进场动画的第一帧正卡在 start 上 */
const LEAD = 0.05;
/** 时间差小于这个值(秒)且往前走,当成连续播放,只推进不重挂载 */
const CONTINUOUS_MAX = 0.5;

/** 改参数停手多久之后重算这一帧(毫秒) */
const SETTLE_MS = 200;

/** 「这一帧长什么样」只取决于这些;它变了才需要重挂载重跑,改卡片参数不算 */
function layoutKeyOf(p: Project): string {
  const clips = flattenOverlay(p).clips.map((c) => `${c.id}:${c.cardId}:${c.start}:${c.end}`).join("|");
  return `${p.width}x${p.height}#${p.themeId}#${clips}`;
}

export interface PcStageApi {
  /** 换项目文档(卡片参数、轨道、主题变了都走它) */
  setProject(project: Project): void;
  /** 渲染时间轴 t 秒那一帧。jump=true 强制按跳转处理,replay=true 重挂载重播 */
  render(t: number, opts?: { jump?: boolean; replay?: boolean }): void;
  /** 舞台尺寸,给编辑器算缩放 */
  size(): { width: number; height: number };
  /**
   * 实体模式:true = 画色块(浏览、播放、拖动时用),false = 真渲(暂停时用)。
   * 只在 ?stage=1&proxy=1 的页面上有效,别处调了不生效也不报错。
   */
  setProxy(on: boolean): void;
  /** 取活跃卡片的位置(包裹层的外框——每张卡都是整屏的,只能当兜底用) */
  rects(): { clipId: string; left: number; top: number; width: number; height: number }[];
  /**
   * 实体命中测试:舞台坐标 (x, y) 处,从最上层往下找第一个「画了东西」的元素——
   * 文字、图片、视频、有底色 / 描边的盒子——透明的容器一律穿过去。
   * 返回它属于哪个片段,以及那个实体元素自己的外框;什么都没点到返回 null。
   */
  hitTest(x: number, y: number): StageHit | null;
  /**
   * 片段的实体范围:它所有实体元素外框的并集。给选中描边用——
   * 字幕卡包裹层占满整屏,描边要贴着字幕本身而不是绕屏幕一圈。
   */
  bounds(clipId: string): StageRect | null;
}

export interface StageRect {
  left: number;
  top: number;
  width: number;
  height: number;
}
export interface StageHit extends StageRect {
  clipId: string;
}

declare global {
  interface Window {
    __pcStage?: PcStageApi;
    /**
     * 编辑器主窗口用:拿到预览 iframe 里的 __pcStage(Preview.tsx 挂上去)。
     * 给 AI 工具量卡片的实体内容框(get_layout 的 contentBox)—— bounds() 只在 iframe 里有,
     * 而工具跑在主窗口。
     */
    __pcPreviewStage?: () => PcStageApi | null;
  }
}

export default function StageView() {
  const [project, setProject] = useState<Project | null>(null);
  const [t, setT] = useState(0);
  const [token, setToken] = useState(1);
  /*
   * 实体模式开关。只有 ?stage=1&proxy=1 这条路能打开(见 render/solidMode.ts),
   * 导出页 ?export=1 拿不到它 —— 退化方向必须是「慢但正确」。
   */
  const [proxy, setProxy] = useState(false);
  const ref = useRef({ project: null as Project | null, t: 0, layoutKey: "", settle: 0, proxy: false });

  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    document.body.style.overflow = "hidden";
    const root = document.getElementById("root");
    if (root) root.style.background = "transparent";
  }, []);

  useEffect(() => {
    if (!clock) return;

    const renderAt = (target: number, opts: { jump?: boolean; replay?: boolean } = {}) => {
      const p = ref.current.project;
      if (!p) {
        ref.current.t = target;
        return;
      }
      const clips = flattenOverlay(p).clips;
      const prev = ref.current.t;
      const dt = target - prev;
      ref.current.t = target;

      // 连续播放:接着往下跑一两帧就行
      if (!opts.jump && !opts.replay && dt >= 0 && dt < CONTINUOUS_MAX) {
        flushSync(() => setT(target));
        clock.advanceTo(Math.max(0, target) * 1000, { onFrame: (ms) => pinner.sync(ms) });
        scheduleSample();
        return;
      }

      // 跳转 / 重播:把这一刻活跃的卡全部重挂载,从各自的入点补跑到 target,
      // 于是画面等于「从入点一路播到 target」的那一帧,而不是「刚开始播」的第一帧。
      const active = clips.filter((c) => target >= c.start - LEAD && target < c.end);
      const from = active.length ? Math.max(0, Math.min(...active.map((c) => c.start - LEAD))) : Math.max(0, target);

      pinner.reset();
      clock.set(from * 1000);
      flushSync(() => {
        setToken((n) => n + 1);
        setT(from);
      });
      clock.tick(from * 1000);
      pinner.sync(from * 1000);

      // 补跑途中跨到别的卡的入点时才提交一次 React(让它挂载),其余帧只推时钟
      // 组合卡里 enterMs > 0 的部件在 clip 入点那次提交时还没到点,不挂载;中途不提交它就一直不挂,
      // 直到最后 setT 才挂,进场动画就从 target 才开始跑,画面停在入场首帧。所以它们的进场点也算提交点。
      const partEntries = active.flatMap((c) =>
        c.cardId === "composite" && c.parts?.length
          ? [...partsTiming(c.parts, getPart).parts.values()].filter((e) => e.enterMs > 0).map((e) => Math.max(0, c.start + e.enterMs / 1000 - LEAD))
          : [],
      );
      const entries = [...active.map((c) => Math.max(0, c.start - LEAD)), ...partEntries].filter((s) => s > from).sort((a, b) => a - b);
      let ei = 0;
      clock.advanceTo(Math.max(0, target) * 1000, {
        onFrame: (ms) => {
          const sec = ms / 1000;
          while (ei < entries.length && sec >= entries[ei]) {
            flushSync(() => setT(sec));
            ei += 1;
          }
          pinner.sync(ms);
        },
      });

      flushSync(() => setT(target));
      clock.tick(Math.max(0, target) * 1000);
      pinner.sync(Math.max(0, target) * 1000);
      scheduleSample();
    };

    /*
     * 真渲之后采一次墨色(实体模式的色块要用)。
     *
     * 「每次真渲都是一次采样机会」—— 用得越久,实体模式越准:用户改了主色、换了文案,
     * 方块跟着变。播放中是实体模式,不会走到这里,所以不会拖慢播放。
     * 防抖是因为连续拖播放头会一帧一个 renderAt,而采样要遍历每张卡的所有元素读 computed style。
     */
    let sampleTimer = 0;
    const scheduleSample = () => {
      if (!proxyAllowed() || ref.current.proxy) return;
      window.clearTimeout(sampleTimer);
      sampleTimer = window.setTimeout(() => {
        const stageEl = document.querySelector<HTMLElement>(".pc-stage");
        if (stageEl && !ref.current.proxy) sampleAll(stageEl);
      }, 120);
    };

    /** 舞台左上角在文档里的位置,把元素外框换算成舞台坐标 */
    const stageOrigin = () => {
      const stageEl = document.querySelector(".pc-stage");
      return stageEl ? stageEl.getBoundingClientRect() : null;
    };
    const toStage = (r: DOMRect, origin: DOMRect): StageRect => ({
      left: r.left - origin.left,
      top: r.top - origin.top,
      width: r.width,
      height: r.height,
    });

    /**
     * 这个元素在这一点上算不算「实体」。
     * 实体 = 用户看得见、点下去合理的东西:文字、图片 / 视频 / 画布 / SVG 图形,
     * 或者自己画了底色、背景图、描边、阴影的盒子。只做布局用的透明容器不算——
     * 卡片的包裹层是整屏的,不穿过它就永远点不到下面那张卡。
     */
    const REPLACED = new Set(["IMG", "VIDEO", "CANVAS", "svg", "path", "rect", "circle", "ellipse", "line", "polygon", "polyline", "text", "use"]);
    const paintedColor = (v: string) => {
      // rgba(0,0,0,0) / transparent 都算没画;其余只要 alpha > 0 就算画了
      if (!v || v === "transparent") return false;
      const m = /rgba?\(([^)]+)\)/.exec(v);
      if (!m) return true; // 关键字色、color() 等,当作画了
      const parts = m[1].split(/[\s,/]+/).filter(Boolean);
      return parts.length < 4 || parseFloat(parts[3]) > 0;
    };
    const isSolid = (el: Element): boolean => {
      if (el === document.documentElement || el === document.body) return false;
      if (el.classList.contains("pc-stage") || (el as HTMLElement).hasAttribute?.("data-pc-clip")) return false;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || parseFloat(cs.opacity) === 0 || cs.pointerEvents === "none") return false;
      if (REPLACED.has(el.tagName)) return true;
      // 直接持有非空白文本节点 → 是文字本身
      for (const n of el.childNodes) {
        if (n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim()) return true;
      }
      if (paintedColor(cs.backgroundColor)) return true;
      if (cs.backgroundImage && cs.backgroundImage !== "none") return true;
      if (cs.boxShadow && cs.boxShadow !== "none") return true;
      const bw = ["borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth"] as const;
      const bc = ["borderTopColor", "borderRightColor", "borderBottomColor", "borderLeftColor"] as const;
      for (let i = 0; i < 4; i++) {
        if (parseFloat(cs[bw[i]]) > 0 && paintedColor(cs[bc[i]])) return true;
      }
      return false;
    };

    const api: PcStageApi = {
      hitTest(x, y) {
        const origin = stageOrigin();
        if (!origin) return null;
        // elementsFromPoint 按绘制顺序从最上层往下给;透明容器一路穿过去
        const stack = document.elementsFromPoint(x + origin.left, y + origin.top);
        for (const el of stack) {
          if (!isSolid(el)) continue;
          const wrap = el.closest("[data-pc-clip]");
          const clipId = wrap?.getAttribute("data-pc-clip");
          if (!clipId) continue;
          return { clipId, ...toStage(el.getBoundingClientRect(), origin) };
        }
        return null;
      },
      bounds(clipId) {
        const origin = stageOrigin();
        if (!origin) return null;
        const wrap = document.querySelector(`[data-pc-clip="${CSS.escape(clipId)}"]`);
        if (!wrap) return null;
        let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
        const walk = (el: Element) => {
          if (isSolid(el)) {
            /*
             * canvas 要先扫像素:元素矩形永远是整块画布,而三维卡(scene-3d)、粒子卡多半
             * 铺满整幅、四周全是透明的。不扫的话 get_layout 的 contentBox 会报「这张卡占满全屏」,
             * 而工具描述明写「判断会不会盖住人看 contentBox」—— Agent 会以为字幕无处可放。
             * 扫不出来(画布被污染、真的整块都画了)就退回元素矩形。
             */
            const painted = el.tagName === "CANVAS" ? canvasBox(el as HTMLCanvasElement) : null;
            const rc = painted ?? el.getBoundingClientRect();
            if (rc.width > 0 && rc.height > 0) {
              l = Math.min(l, rc.left); t = Math.min(t, rc.top);
              r = Math.max(r, rc.right); b = Math.max(b, rc.bottom);
            }
            return; // 实体元素的子孙都在它外框里,不用再往下
          }
          for (const c of el.children) walk(c);
        };
        for (const c of wrap.children) walk(c);
        // 一个实体都没有(纯透明卡)退回包裹层外框,至少还能选中
        const rc = Number.isFinite(l) ? new DOMRect(l, t, r - l, b - t) : wrap.getBoundingClientRect();
        // 夹回舞台内:文字动画常把元素甩到屏幕外,描边不该跟着跑出去
        const cl = Math.max(rc.left, origin.left), ct = Math.max(rc.top, origin.top);
        const cr = Math.min(rc.right, origin.right), cb = Math.min(rc.bottom, origin.bottom);
        if (cr <= cl || cb <= ct) return toStage(wrap.getBoundingClientRect(), origin);
        return toStage(new DOMRect(cl, ct, cr - cl, cb - ct), origin);
      },
      setProject(next) {
        // clipId 会在不同项目里复用,不清掉就会张冠李戴
        if (next !== ref.current.project) resetInk();
        const prevKey = ref.current.layoutKey;
        const nextKey = layoutKeyOf(next);
        ref.current.project = next;
        ref.current.layoutKey = nextKey;
        flushSync(() => setProject(next));
        window.clearTimeout(ref.current.settle);
        if (prevKey !== nextKey) {
          // 片段的位置 / 时长 / 用哪张卡 / 画布尺寸变了 → 这一帧立刻重算
          renderAt(ref.current.t, { jump: true });
          return;
        }
        // 只改了卡片参数:先原样重渲染(打字时画面不闪),停手 200ms 后再重算这一帧。
        // 不重算不行——改参数可能让卡片长出新的动画,而新动画在没人推时钟时会停在 initial。
        ref.current.settle = window.setTimeout(() => renderAt(ref.current.t, { jump: true }), SETTLE_MS);
      },
      render: renderAt,
      size() {
        const p = ref.current.project;
        return { width: p?.width ?? 1920, height: p?.height ?? 1080 };
      },
      setProxy(on) {
        // 只有显式带了 ?proxy=1 的页面才允许开。导出页永远进不来这一条。
        if (!proxyAllowed()) return;
        const want = !!on;
        if (want === ref.current.proxy) return;
        ref.current.proxy = want;
        if (want) ensureProxyStyle();
        /*
         * 从实体切回真渲的那一刻要采一次样,而不是切进实体时采 ——
         * 实体模式下画面上只有色块,量它等于把上一次的结论抄一遍再劣化。
         * 采样排在这一帧提交之后(真卡已经画出来了),所以放 flushSync 后面。
         */
        flushSync(() => setProxy(want));
        if (!want) {
          const stageEl = document.querySelector<HTMLElement>(".pc-stage");
          if (stageEl) sampleAll(stageEl);
        }
      },
      rects() {
        const stageEl = document.querySelector(".pc-stage");
        if (!stageEl) return [];
        const stageRect = stageEl.getBoundingClientRect();
        const els = document.querySelectorAll("[data-pc-clip]");
        const result: { clipId: string; left: number; top: number; width: number; height: number }[] = [];
        for (let i = 0; i < els.length; i++) {
          const el = els[i] as HTMLElement;
          const rect = el.getBoundingClientRect();
          const clipId = el.getAttribute("data-pc-clip");
          if (clipId) {
            result.push({
              clipId,
              left: rect.left - stageRect.left,
              top: rect.top - stageRect.top,
              width: rect.width,
              height: rect.height,
            });
          }
        }
        return result;
      },
    };
    window.__pcStage = api;
    window.parent?.postMessage({ type: "pc-stage-ready" }, "*");
    return () => {
      window.clearTimeout(ref.current.settle);
      if (window.__pcStage === api) delete window.__pcStage;
    };
  }, []);

  if (!project) return null;
  const timeline = flattenOverlay(project);

  return (
    <div
      style={{
        position: "relative",
        width: project.width,
        height: project.height,
        overflow: "hidden",
        background: "transparent",
        ...themeStyle(project.themeId),
        /*
         * 三维的 perspective **不在这里**。这一格和卡片之间还隔着 .pc-stage 和 AnimClock
         * 两层 div,而 CSS 的 perspective 只作用于直接子元素 —— 挂在这里等于没挂
         * (实测卡片高度纹丝不动,rotateY 只剩仿射拉伸,而且不报错)。
         * 它挂在 kernel/Stage.tsx 里卡片的直接父元素上,预览和导出共用同一处。
         */
      }}
    >
      <Stage timeline={timeline} t={t} playToken={token} proxy={proxy ? proxyOf : undefined} />
    </div>
  );
}
