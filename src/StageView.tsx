import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Stage } from "./kernel/Stage";
import { flattenOverlay, type Project } from "./kernel/project";
import { installStageClock } from "./render/stageClock";
import { onFrameGrid } from "./render/frameGrid";
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
  /** 落定补拍的代数:又渲了一帧就作废上一次挂着的补拍(见 renderAt 里 settle 的说明) */
  const settleGen = useRef(0);
  /** 渲染代数:又来一次渲染就作废上一次还在飞的异步补跑(见 renderAt 里的说明) */
  const renderGen = useRef(0);

  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    document.body.style.overflow = "hidden";
    const root = document.getElementById("root");
    if (root) root.style.background = "transparent";
  }, []);

  useEffect(() => {
    if (!clock) return;

    /*
     * 补一拍「落定」。**同步补跑完的那一瞬间,Motion 还没把新值写回 DOM。**
     *
     * Motion 的 JS 动画(transform 这类)确实挂在我们接管的 rAF 上 —— 手动 tick 能推动它,
     * 推出来的值和导出逐位相同。但它解析关键帧要**跨一个任务边界**:实测在同一个 JS 任务里
     * 再补多少拍都没用,让出一个微任务之后只补一拍就够。而跳转那条路是一个同步块跑完的,
     * 于是补跑结束时卡片还停在 initial 那一帧。
     *
     * 实测 chapter-bar 第 9 帧:导出 translateY(-8.65515px),预览 translateY(-120px)——
     * 进场条整个悬在画面外,而且不报错。补上这一拍之后两边逐位相同。
     * 导出那边不需要这个:它每一帧都是真实的浏览器帧,任务边界白捡。
     *
     * 时间不动(还是 target),所以这一拍只让写回发生,不会让动画多走。
     */
    const settle = (target: number) => {
      const gen = ++settleGen.current;
      queueMicrotask(() => {
        if (gen !== settleGen.current || !clock) return;
        const ms = Math.max(0, target) * 1000;
        clock.tick(ms);
        pinner.sync(ms);
      });
    };

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
        renderGen.current++;   // 掐掉可能还在飞的上一次补跑
        flushSync(() => setT(target));
        clock.advanceTo(Math.max(0, target) * 1000, { onFrame: (ms) => pinner.sync(ms) });
        settle(target);
        scheduleSample();
        return;
      }

      // 跳转 / 重播:把这一刻活跃的卡全部重挂载,从各自的入点补跑到 target,
      // 于是画面等于「从入点一路播到 target」的那一帧,而不是「刚开始播」的第一帧。
      const active = clips.filter((c) => target >= c.start - LEAD && target < c.end);

      /*
       * **挂载时刻必须落在帧格上** —— 不然「预览所见 = 导出所得」在每个卡片入点都破一次。
       *
       * 导出是一帧一帧推的:一张卡在第一个 ≥ start-LEAD 的**帧**上挂载,时间原点就是那一帧,
       * 而不是 start-LEAD 本身。跳转这条路以前直接把时钟设到连续的 start-LEAD,原点比导出
       * 早了不到一帧;补跑又按 60fps 走,而导出按项目 fps 走。于是凡是「挂载即播」的卡
       * (绝大多数卡都是)在入点附近和成片对不上。
       *
       * 实测 mu-circular-progress(1.2s easeOut cubic、入点 1.0s、30fps),同一个 t=1.0:
       * 导出 6%,预览 9%。差的就是 33.3ms(一帧)和 50ms(LEAD)这一格。easeOut 开头最陡,
       * 半帧的偏差在画面上就是两位数的百分比 —— 用户切 2D/3D 一眼能看出来。
       */
      const fps = Math.max(1, p.fps || 30);
      const onGrid = (sec: number) => onFrameGrid(sec, fps);
      const rawFrom = active.length ? Math.max(0, Math.min(...active.map((c) => c.start - LEAD))) : Math.max(0, target);
      // 夹一下:target 本身不在帧格上时(编辑器给的 t 理论上都在),对齐后可能反超它
      const from = Math.min(onGrid(rawFrom), Math.max(0, target));

      pinner.reset();
      clock.set(from * 1000);
      flushSync(() => {
        setToken((n) => n + 1);
        setT(from);
      });
      /*
       * **在 from 这一刻空跑两拍**,不是笔误。
       *
       * 第一拍跑卡片自己注册的 rAF —— 那里面才会把动画建起来(数字滚动的 useSpring 就是在
       * 这一拍里 .set() 的)。Motion 建完动画要到**下一拍**才做第一次推进,所以只跑一拍的话,
       * 补跑的第一格被拿去当了动画的起跑线,整条动画比导出慢一帧。
       *
       * 导出那边是白捡的:预热阶段先在挂载点空跑了一帧(warmUp 里 __pcRestartCards 之后那次
       * step(0)),等正式第 0 帧渲的时候动画早就上好膛了。这里补上同一拍,两边起跑线才一致。
       * 两拍的时刻相同,delta 为 0,不会让动画多走 —— 只是把「建立」和「推进」分开。
       */
      clock.tick(from * 1000);
      clock.tick(from * 1000);
      pinner.sync(from * 1000);

      /*
       * **补跑的每一帧都提交一次 React**,和导出一模一样(ExportView 每帧 flushSync)。
       *
       * 以前只在「跨到某张卡的入点」时提交,其余帧只推时钟。省下的是 React 的活儿,丢掉的是
       * 两样东西,而且都不报错:
       *   - **卡片自己改的状态**:同步补跑期间的 setState 一次都没被提交。实测 word-rotate
       *     在 t=1.8s 上整个轮换词**消失**(AnimatePresence 把旧词退场了、新词还没挂上),
       *     导出是「你是 卓越」。
       *   - **按 t 自己往前推的卡**:particles / lottie 这类不注册 rAF,全靠每帧拿到新的 t。
       *     只在最后给一次 t,粒子就从 0 一口气推到 target,累积出来的画面和逐帧推不一样。
       *
       * 试过一条省事的判据「这一帧有 rAF 跑过才提交」,正是被上面第二类卡否掉的 —— 它们一个
       * rAF 都不注册。既然导出就是每帧提交,预览照做才是最不容易再分叉的写法。
       * 代价:跳 6 秒(补跑上限)约 86ms,单次点击跳转感觉不出来。
       *
       * entries 那套(clip 入点 + 组合卡部件的 enterMs)因此不再需要:每帧都提交,
       * 该挂的自然在它该挂的那一帧挂上。
       */

      /*
       * 补跑**每帧之间让出一个微任务**(advanceToAsync),而不是一个同步块跑完。
       *
       * 同步跑完的画面和「一帧一帧推过去」不是同一张:跨不过同步块的东西全被落下 ——
       * Motion 解析关键帧、AnimatePresence 换人、粒子引擎异步装载。实测同一个预览页、
       * 同一个 t=1.8s,跳过去 vs 逐帧推过去:particles 差 12.9 万像素、word-rotate 差 2.2 万。
       * 而导出永远是逐帧推的那一种,所以要对齐的是它。
       *
       * 于是这条路变成异步的。gen 是防串台的:拖播放头时上一次补跑可能还在飞,
       * 新的一次进来就把它掐掉,不然两次补跑会交替往同一个时钟上写。
       */
      const gen = ++renderGen.current;
      void (async () => {
        await clock.advanceToAsync(Math.max(0, target) * 1000, {
          step: 1000 / fps,
          abort: () => gen !== renderGen.current,
          onFrame: (ms) => flushSync(() => setT(ms / 1000)),
          afterFrame: (ms) => pinner.sync(ms),
        });
        if (gen !== renderGen.current) return;
        flushSync(() => setT(target));
        clock.tick(Math.max(0, target) * 1000);
        pinner.sync(Math.max(0, target) * 1000);
        settle(target);
        scheduleSample();
      })();
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
        // 和 ExportView 读同一处(Timeline),不是各读各的 project —— 见 Timeline.themeId 的说明
        ...themeStyle(timeline.themeId),
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
