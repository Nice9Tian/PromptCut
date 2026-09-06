import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Stage } from "./kernel/Stage";
import { flattenOverlay, type Project } from "./kernel/project";
import { installStageClock } from "./render/stageClock";
import { createAnimationPinner } from "./render/pinAnimations";
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
  }
}

export default function StageView() {
  const [project, setProject] = useState<Project | null>(null);
  const [t, setT] = useState(0);
  const [token, setToken] = useState(1);
  const ref = useRef({ project: null as Project | null, t: 0, layoutKey: "", settle: 0 });

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
      const entries = active.map((c) => Math.max(0, c.start - LEAD)).filter((s) => s > from).sort((a, b) => a - b);
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
            const rc = el.getBoundingClientRect();
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
      }}
    >
      <Stage timeline={timeline} t={t} playToken={token} />
    </div>
  );
}
