import { UnifiedPreview } from "./preview/UnifiedPreview";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { MediaLayers } from "./preview/MediaLayers";
import { Scene3DView } from "./preview/Scene3DView";
import { themeStyle } from "../themes";
import { actions, getState, useStore } from "../store/project";
import { videoLayersAt, findClip } from "../kernel/project";
import { frameBox, nudgeFrame } from "../kernel/layout";
import type { PcStageApi } from "../StageView";
import { ControlBar } from "./preview/ControlBar";
import { ToolBar, ToolType } from "./preview/ToolBar";
import { MiniScrubber } from "./preview/MiniScrubber";
import { PreviewContextMenu } from "./preview/PreviewContextMenu";
import { getCard } from "../kernel/registry";
import { useLayoutMode } from "./layoutMode";
import { fitView, frameOrigin, panBy, wheelZoomFactor, zoomAt, type View2D } from "./preview/viewport2d";
import "./preview/preview.css";
import { atFrameGrid } from "../render/frameGrid";

/**
 * 中央预览:视频层 + 动效渲染面,按容器缩放。播放循环也在这里(rAF 推进 store.t)。
 *
 * 动效不在这个文档里播:它跑在下面那个 ?stage=1 的 iframe(渲染面)里,时间被接管,
 * 这里只下发「现在是时间轴第几秒」,渲染面渲染出那一帧。所以拖播放头到片段中间
 * 看到的是那一刻该有的画面,而不是把进场动画从头重播一遍。详见 src/StageView.tsx。
 *
 * 视频层:按 videoClipAt 找当前该播的素材段,src 变了换源,时间对不上(>0.2s)就 seek。
 */
export function Preview({ chatLayout }: { chatLayout?: boolean }) {
  const layoutMode = useLayoutMode();
  // prop 是显式覆盖用的，平时不传就按当前 layoutMode 是否为 chat 决定
  const showMiniScrubber = chatLayout !== undefined ? chatLayout : layoutMode === "chat";

  const project = useStore((s) => s.project);
  const t = useStore((s) => s.t);
  const playing = useStore((s) => s.playing);
  const playToken = useStore((s) => s.playToken);
  const volume = useStore((s) => s.volume);
  const muted = useStore((s) => s.muted);
  const selection = useStore((s) => s.selection);
  const boxRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  /**
   * 怎么看这块画布:缩放多少、平移到哪、是不是还跟着窗口自动适应。换算见 preview/viewport2d.ts。
   *
   * `scale` 下面还有七八处在用(命中测试、拖动换算、描边框),所以在这里解出来一个同名的量,
   * 那些地方一个字都不用改 —— 它们本来就只关心「一个画面像素在屏幕上是几像素」。
   */
  const [cam, setCam] = useState<View2D>({ scale: 0.4, tx: 0, ty: 0, auto: true });
  const scale = cam.scale;
  const camRef = useRef(cam);
  camRef.current = cam;
  /**
   * 预览窗口有多大。**画框摆在哪儿由我们自己算**,所以这个尺寸得一直拿在手上。
   *
   * 本来是想省掉它的:外层是 grid + place-items:center,画面自己就在正中,
   * 只要再叠一个「相对中心的偏移」就行。**实测发现这条路不通**:画框一旦比窗口高,
   * 浏览器就不再居中了,而是把顶边贴到 0(grid 的 safe 对齐,怕内容溢出到够不着的地方)。
   * 试过 `align-items: unsafe center` 强制真居中 —— 计算样式确实变了,画框照样贴顶。
   * 而「画框比窗口大」正是放大之后的常态,也正是最需要拖动的时候。
   * 于是改成:画框绝对定位在左上角,位置完全由 frameOrigin 算出来,浏览器不掺和。
   */
  const [boxSize, setBoxSize] = useState<{ width: number; height: number } | null>(null);
  /**
   * 渲染面就绪的**代数**,不是一个布尔。0 = 还没就绪,之后每换一个新的渲染面就 +1。
   *
   * 为什么不能是布尔:2D 那一页整棵子树(连同 iframe)挂在 `view === "3d" ? … : …` 的
   * 另一支上,切到 3D 再切回来是**卸载再挂载**,iframe 是新的、里面的渲染面是空的。
   * 而 `setStageReady(true)` 在已经是 true 时不改变 state,下面那两个 effect(下发
   * project、下发时间)就不会重跑 —— 于是切回 2D 是一片空白,得去碰一下时间轴,
   * 让 `t` 变一下把 render 那个 effect 逼出来,画面才回来。
   *
   * 换成代数之后,每来一次 `pc-stage-ready` 都是一个新值,两个 effect 必定重跑。
   * 顺带也管住了别的换渲染面的路子(改画幅换 key、开发时热更新整页重载),
   * 那些同样是「新的 iframe + 旧的 true」。
   *
   * `!stageReady` 对 0 照样成立,所以下面那几处判断一个字都不用改。
   */
  const [stageReady, setStageReady] = useState(0);
  const tRef = useRef(t);
  tRef.current = t;
  const playingRef = useRef(playing);
  playingRef.current = playing;

  /*
   * 预览分两页。2D 是成片(预览所见 = 导出所得),3D 是"这些东西在空间里怎么摆"。
   * 两页各自回答一个问题,不要互相迁就 —— 2D 里出现代理色块就是把它的契约破了。
   */
  const [view, setView] = useState<"2d" | "3d">("2d");
  const [tool, setTool] = useState<ToolType>("select");
  const [rects, setRects] = useState<{ clipId: string; left: number; top: number; width: number; height: number }[]>([]);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; clipId: string; cardId: string } | null>(null);
  const [editingText, setEditingText] = useState<{ clipId: string; key: string; value: string; x: number; y: number } | null>(null);
  
  // 记录拖动工具过程中的位移预览状态
  const [dragPreview, setDragPreview] = useState<{ clipId: string; dx: number; dy: number } | null>(null);

  const stage = useCallback((): PcStageApi | null => {
    return frameRef.current?.contentWindow?.__pcStage ?? null;
  }, []);

  // 把 getter 挂到主窗口,AI 的定位工具(get_layout 等)靠它量卡片的实体内容框。
  // 挂的是 getter 不是 api 本身:iframe 重载后 api 会换,getter 每次都取最新的。
  useEffect(() => {
    window.__pcPreviewStage = stage;
    return () => {
      if (window.__pcPreviewStage === stage) delete window.__pcPreviewStage;
    };
  }, [stage]);

  /*
   * 播放循环。**播放头只停在成片真有的那些帧上。**
   *
   * 以前是按墙上时钟连续推的:显示器 60Hz 就一秒推 60 个 t,而成片是 fps 帧的,
   * 于是有一半的 t 在成片里根本不存在。单看 2D 察觉不到,一切到 3D 就露馅 ——
   * 那边显示的是烘好的整帧,两个视图对同一个播放头能差半帧,而进场动画最陡的就是那一段。
   * 量化之后 2D 播放显示的就是导出会写出来的那一帧,3D 贴的也是同一帧。
   *
   * 累加器 acc 必须保持不量化,不然每帧丢掉的那点余数会累起来,播放越走越慢。
   */
  useEffect(() => {
    if (!playing) return;
    const fps = Math.max(1, project.fps || 30);
    let raf = 0;
    let last = performance.now();
    let acc = tRef.current;      // 真实推进到哪儿(不量化)
    let wrote = atFrameGrid(acc, fps);  // 上一次交出去的帧时刻
    const tick = (now: number) => {
      /*
       * 播放中外面也可能 seek(点时间轴、拖播放头),那时以外面的为准。
       * 判据是「差得比一帧还多」而不是「不相等」:tRef 在 render 里才赋值,量化之后 store 的 t
       * 可能比这里晚一帧,那不是 seek —— 按 seek 处理会让播放隔几帧倒退一格。
       */
      if (Math.abs(tRef.current - wrote) > 1.5 / fps) acc = tRef.current;
      acc += (now - last) / 1000;
      last = now;
      if (acc >= project.duration) {
        actions.pause();
        actions.seek(project.duration);
        return;
      }
      wrote = atFrameGrid(acc, fps);
      actions.tick(wrote);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, project.duration, project.fps]);

  /*
   * 量一次窗口有多大,顺便在「自动适应」还开着时重新算缩放比。
   *
   * 两件事都要做,原因不同:
   *   - 窗口尺寸**必须一直跟着量**,因为画框摆在哪儿是我们自己算的(见下面 frameOrigin),
   *     算式里就有窗口宽高;
   *   - 缩放比只在 auto 时重算。以前这里是无条件重算的,那时候没有手动缩放也就无所谓。
   *     现在不行了:用户放大到 200% 去调一个字的位置,拖一下侧栏宽度(ResizeObserver 就响了),
   *     画面「啪」地跳回适应窗口,刚找好的地方就没了。
   *
   * 用 useLayoutEffect 而不是 useEffect:第一次渲染时还不知道窗口多大,画框会先摆在左上角。
   * 布局效应在浏览器绘制**之前**同步跑完并触发重渲染,所以那一帧用户看不见。
   */
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      setBoxSize({ width: r.width, height: r.height });
      if (camRef.current.auto) setCam(fitView(project, r));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [project.width, project.height, view]);

  /** 回到「适应窗口」。工具行那个徽章点一下就走这儿 */
  const fitToWindow = useCallback(() => {
    const el = boxRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    setCam(fitView({ width: project.width, height: project.height }, r));
  }, [project.width, project.height]);

  /*
   * 滚轮缩放 + 中键拖动平移。
   *
   * 为什么不用 React 的 onWheel:React 17 起把 wheel 绑成**被动**监听器,
   * 里面调 preventDefault 不但不起作用,还会在控制台报一行警告 ——
   * 于是滚轮在缩放画面的同时把整个面板也滚了。只能自己 addEventListener 并显式关掉 passive。
   *
   * 依赖里只有画幅:cam 走 ref 读最新值,否则每缩放一格就要重新解绑重绑一次监听器。
   */
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const box = () => el.getBoundingClientRect();
    const size = { width: project.width, height: project.height };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = box();
      const factor = wheelZoomFactor(e.deltaY, e.deltaMode);
      if (factor === 1) return;
      const cur = camRef.current;
      setCam(zoomAt(cur, size, r, { x: e.clientX - r.left, y: e.clientY - r.top }, cur.scale * factor));
    };

    /*
     * 中键拖动:按住不放拖动画布。左键留给选择 / 移动工具(它自己判 button !== 0 就退出),
     * 右键留给菜单,所以平移只认中键 —— 三个键各管一件事,不用按修饰键。
     */
    let panning = false;
    let lastX = 0;
    let lastY = 0;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 1) return;
      // 中键在很多浏览器上是「自动滚动」,不拦住就会弹出那个圆形滚动光标
      e.preventDefault();
      panning = true;
      lastX = e.clientX;
      lastY = e.clientY;
      // 抓住指针,拖出预览区也照样跟手。指针要是已经没了(松开得比这行还早)会抛,不该因此中断拖动
      try { el.setPointerCapture(e.pointerId); } catch { /* 没抓住就算了,照样能拖,只是出了区域会断 */ }
      el.style.cursor = "grabbing";
    };
    const onMove = (e: PointerEvent) => {
      if (!panning) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      setCam(panBy(camRef.current, size, box(), dx, dy));
    };
    const stopPan = (e: PointerEvent) => {
      if (!panning) return;
      panning = false;
      try { if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId); } catch { /* 已经放开了 */ }
      el.style.cursor = "";
    };
    // 中键按下默认会开自动滚动,auxclick 也要拦一下,否则松开时还会触发
    const onAux = (e: MouseEvent) => { if (e.button === 1) e.preventDefault(); };

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", stopPan);
    el.addEventListener("pointercancel", stopPan);
    el.addEventListener("auxclick", onAux);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", stopPan);
      el.removeEventListener("pointercancel", stopPan);
      el.removeEventListener("auxclick", onAux);
    };
  }, [project.width, project.height, view]);

  // 渲染面就绪:它挂载完会 postMessage 过来;刷新顺序不定,onLoad 里再探一次
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      // 每来一次就 +1:同一个值再赋一遍不会触发重渲染,而新挂的 iframe 需要重新收一遍 project 和时间
      if (e.source === frameRef.current?.contentWindow && (e.data as any)?.type === "pc-stage-ready") setStageReady((n) => n + 1);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  /**
   * 选中描边用的外框:不用包裹层(每张卡都占满整屏),用片段的实体范围——
   * 字幕卡的描边贴着字幕本身,而不是绕屏幕一圈。老渲染面没有 bounds 就退回包裹层。
   */
  /**
   * 此刻画面上的素材段(视频 / 图片)和它们的矩形。
   *
   * 它们由**主文档**的 MediaLayers 画,不在舞台 iframe 里 —— 所以 iframe 的 hitTest
   * 看不见它们,点一下视频等于点了个寂寞(选不中、拖不动)。这里把它们补上,
   * 和卡片一起参与命中和描边。矩形就是片段的框,没设框就是整幅画面。
   */
  const mediaRects = useCallback((): { clipId: string; left: number; top: number; width: number; height: number }[] => {
    const stageSize = { width: project.width, height: project.height };
    return videoLayersAt(project, t).map((l) => ({ clipId: l.clip.id, ...frameBox(l.clip.frame, stageSize) }));
  }, [project, t]);

  const refreshRects = useCallback(() => {
    const s = stage();
    const list = s?.rects ? s.rects() : [];
    const cards = s?.bounds
      ? list.map((r) => {
          const b = s.bounds!(r.clipId);
          return b ? { clipId: r.clipId, ...b } : r;
        })
      : list;
    // 素材段在下、卡片在上(DOM 里 MediaLayers 排在舞台 iframe 前面),命中时也按这个顺序找
    setRects([...mediaRects(), ...cards]);
  }, [stage, mediaRects]);

  /** 刚被点中的片段:描边闪一下,让用户看清点到的是谁 */
  const [flash, setFlash] = useState<{ clipId: string; token: number } | null>(null);
  const flashClip = (clipId: string) => setFlash({ clipId, token: Date.now() });

  /**
   * 实体命中:问渲染面这一点上从最上层往下第一个「画了东西」的元素属于哪个片段。
   * 透明容器穿过去——字幕卡在最上层也不会挡住下面的卡。老渲染面没有 hitTest 时
   * 退回按包裹层外框找最上层的那个。
   */
  const hitAt = (e: { clientX: number; clientY: number; currentTarget: EventTarget & Element }) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / scale;
    const y = (e.clientY - rect.top) / scale;
    const s = stage();
    // 卡片在上层:先问舞台。没点中卡片再看素材段(它们在主文档里,舞台看不见)
    const card = s?.hitTest ? s.hitTest(x, y) : null;
    const inside = (r: { left: number; top: number; width: number; height: number }) =>
      x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height;
    const hit =
      card ??
      [...mediaRects()].reverse().find(inside) ??
      (s?.hitTest ? null : [...rects].reverse().find(inside)) ??
      null;
    return { hit, overlayRect: rect };
  };

  // 项目文档变了就整份发过去(渲染面自己判断要不要重跑这一帧)
  useEffect(() => {
    if (!stageReady) return;
    stage()?.setProject(project);
    setTimeout(refreshRects, 50);
  }, [stageReady, project, stage, refreshRects]);

  // 时间变了就下发。播放中是连续推进;拖播放头 / 跳转 / 重播(playToken 变)都按跳转处理:
  // 重挂载 + 从入点补跑到那一刻。两者合在一个 effect 里,一次 seek 只渲染一帧。
  /*
   * 只认「时间真的变了」:stage / refreshRects 这两个回调的引用会跟着项目、缩放一起换,
   * 以前它们一换这个 effect 就重跑,于是 Agent 每写一次项目都多来一次 jump 渲染 ——
   * 重挂载活跃的卡、从入点逐帧补跑到播放头,实测播放头在 60 秒处每次 230~350 ms 的主线程,
   * 而项目变了该不该补跑,setProject 那边(StageView)已经按「哪张卡变了、在不在画面上」判过了。
   */
  const lastRenderKey = useRef("");
  useEffect(() => {
    if (!stageReady) return;
    const key = `${stageReady}|${t}|${playToken}`;
    if (key === lastRenderKey.current) return;
    lastRenderKey.current = key;
    stage()?.render(t, { jump: !playingRef.current });
    refreshRects();
  }, [stageReady, t, playToken, stage, refreshRects]);

  // 画面层和声音层都由 MediaLayers 管:可以同时有多条画面(重叠+淡化=交叉溶解),音频段单独出声

  // 命中测试与拖拽逻辑
  const handleOverlayPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const { hit: targetRect } = hitAt(e);

    if (tool === "select") {
      // 选择工具：点在实体上则选中并闪一下描边，点空白(或透明区域下面没东西)则取消选中
      if (targetRect) {
        actions.select([targetRect.clipId]);
        flashClip(targetRect.clipId);
      } else {
        actions.select([]);
      }
    } else if (tool === "move") {
      // 移动工具：按下开始拖拽，移动时更新本地拖拽状态，松开才写入 store 记录撤销
      if (!targetRect) return;
      actions.select([targetRect.clipId]);
      flashClip(targetRect.clipId);
      const clipId = targetRect.clipId;
      const startX = e.clientX;
      const startY = e.clientY;

      let currentDx = 0;
      let currentDy = 0;

      const onMove = (ev: PointerEvent) => {
        // 覆盖层是按 scale 缩放显示的,位移换算回舞台像素,和 frame 用的是同一套单位
        currentDx = (ev.clientX - startX) / scale;
        currentDy = (ev.clientY - startY) / scale;
        setDragPreview({ clipId, dx: currentDx, dy: currentDy });
      };

      const onUp = () => {
        setDragPreview(null);
        if (Math.abs(currentDx) > 0.5 || Math.abs(currentDy) > 0.5) {
          /*
           * 拖动改的是 clip 的 frame(位置框),不是卡片参数:卡片没有 x / y 参数,以前往 params 里
           * 写 x / y 等于什么都没改 —— 描边跟着鼠标走了一段,松手就弹回去。
           * 走 nudgeFrame 和 Agent 的 nudge / set_position 是同一条路:没有 frame 的卡先按铺满舞台
           * 算出当前位置再加位移,松手只写一次,一次拖动 = 一步撤销。
           */
          const hit = findClip(getState().project, clipId);
          if (hit) {
            const stageSize = { width: getState().project.width, height: getState().project.height };
            actions.setClipFrame(clipId, nudgeFrame({ dx: Math.round(currentDx), dy: Math.round(currentDy) }, hit.clip.frame, stageSize));
          }
        }
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    }
  };

  // 文字工具逻辑
  const handleOverlayDoubleClick = (e: React.MouseEvent) => {
    if (tool !== "text") return;
    const { hit: targetRect, overlayRect: rect } = hitAt(e);
    if (!targetRect) return;
    flashClip(targetRect.clipId);

    const clip = project.tracks.flatMap((tr) => tr.clips).find((c) => c.id === targetRect.clipId);
    if (!clip) return;
    const def = getCard(clip.cardId);
    if (!def) return;
    const textControl = def.controls.find((c) => c.type === "text");
    if (!textControl) return;

    const val = (clip.params[textControl.key] as string) ?? def.defaults[textControl.key] ?? "";
    
    // 输入框位置定位到卡片左上角（根据命中的目标矩形来换算）
    const inputX = targetRect.left * scale + rect.left;
    const inputY = targetRect.top * scale + rect.top;

    setEditingText({
      clipId: clip.id,
      key: textControl.key,
      value: val,
      x: inputX,
      y: inputY,
    });
  };

  const handleOverlayContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const { hit: targetRect } = hitAt(e);
    if (targetRect) {
      const clip = project.tracks.flatMap((tr) => tr.clips).find((c) => c.id === targetRect.clipId);
      if (clip) {
        actions.select([clip.id]);
        flashClip(clip.id);
        setContextMenu({ x: e.clientX, y: e.clientY, clipId: clip.id, cardId: clip.cardId });
      }
    }
  };

  const submitTextEdit = () => {
    if (editingText) {
      actions.setClipParams(editingText.clipId, { [editingText.key]: editingText.value }, { merge: true });
    }
    setEditingText(null);
  };

  /** 画框左上角该摆在窗口的哪个位置。还没量到窗口大小时先不摆(那一帧在绘制前就过去了) */
  const frameXY = boxSize ? frameOrigin(cam, project, boxSize) : null;

  return (
    <div className="pc-pv" data-pc="preview">
      <div className="pc-pv-tabs" data-pc="preview-tabs">
        {([["2d", "2D"], ["3d", "3D"]] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={view === id ? "is-on" : undefined}
            onClick={() => setView(id)}
            title={id === "2d" ? "成片预览:所见即导出所得" : "三维视图:像 Blender 那样绕着看这些卡在空间里怎么摆"}
          >
            {label}
          </button>
        ))}
      </div>

      {view === "3d" ? (
        <div className="pc-pv-stage" style={{ position: "relative" }}>
          <Scene3DView project={project} t={t} />
        </div>
      ) : (
      <>
      <ToolBar tool={tool} onToolChange={setTool} zoom={cam.scale} fitted={cam.auto} onFit={fitToWindow} />

      <div ref={boxRef} className="pc-pv-stage">
        <div
          className="pc-pv-frame pc-checker"
          style={{
            width: project.width * scale,
            height: project.height * scale,
            /*
             * 位置完全由自己算(见 boxSize 那段说明:靠浏览器居中在放大之后会失准)。
             * 绝对定位到左上角,再用 transform 挪到该在的地方 —— transform 不触发重排,
             * 拖动时每一帧都在改它,用 left/top 会一路重排。
             */
            position: "absolute",
            left: 0,
            top: 0,
            transform: frameXY ? `translate(${frameXY.x}px, ${frameXY.y}px)` : undefined,
            /*
             * 透明棋盘格搬到 .pc-checker 了(见 preview/preview.css)。
             *
             * 原来这儿内联写着另一套偏暗的值,理由是「配色规范 04 条:透明格要比周围画布更暗更弱」。
             * 那条规矩本身没错,但它和这块底真正要回答的问题冲突:**这儿是不是什么都没有?**
             * 底一暗,一张深色的卡和「什么都没画」就长得一模一样 —— see_frames 和 3D 视图
             * 都因为这个踩过坑。而且 2D 和 3D 两页各用一套值,同一个项目在两页里
             * 「透明」长得都不一样。所以统一到中灰那一套,和 see_frames 逐值对齐。
             */
          }}
        >
          <div style={{ transform: `scale(${scale})`, transformOrigin: "0 0", position: "absolute", left: 0, top: 0, ...themeStyle(project.themeId) }}>
            <div style={{ position: "relative", width: project.width, height: project.height }}>
              <MediaLayers project={project} t={t} playing={playing} masterVolume={muted ? 0 : volume} audioOnly />
              <iframe
                ref={frameRef}
                data-pc="stage-frame"
                title="预览舞台"
                /*
                 * 这里**不加 proxy=1**:2D 预览的契约是「预览所见 = 导出所得」,
                 * 播放时换成色块就把这条破了 —— 用户按播放是要看成片长什么样,
                 * 不是要看构图草图。代理只活在 3D 视图里,而且只是烘焙没跟上时的过渡。
                 */
                src={`${location.pathname}?stage=1`}
                onLoad={() => {
                  // 和上面的 postMessage 同一条路:也要 +1,不然消息比 onLoad 早到时这一次就白探了
                  if (frameRef.current?.contentWindow?.__pcStage) setStageReady((n) => n + 1);
                }}
                style={{
                  position: "absolute",
                  inset: 0,
                  width: project.width,
                  height: project.height,
                  border: 0,
                  display: "block",
                  background: "transparent",
                  colorScheme: "normal",
                  opacity: 0,
                }}
              />
              <UnifiedPreview project={project} t={t} playing={playing} />
            </div>
          </div>
          
          {/* 四角标记:设计稿画面四角各一个 16 方的 L 形,提示这是可编辑画布 */}
          <span className="pc-pv-corner tl" aria-hidden="true" />
          <span className="pc-pv-corner tr" aria-hidden="true" />
          <span className="pc-pv-corner bl" aria-hidden="true" />
          <span className="pc-pv-corner br" aria-hidden="true" />

          {/* 画布覆盖层，处理命中测试以及拖拽绘制 */}
          <div
            style={{ position: "absolute", inset: 0, zIndex: 10 }}
            onPointerDown={handleOverlayPointerDown}
            onDoubleClick={handleOverlayDoubleClick}
            onContextMenu={handleOverlayContextMenu}
          >
            {rects.map((r) => {
              const isSelected = selection.includes(r.clipId);
              if (!isSelected) return null;
              const dragDx = (dragPreview?.clipId === r.clipId) ? dragPreview.dx : 0;
              const dragDy = (dragPreview?.clipId === r.clipId) ? dragPreview.dy : 0;

              // 描边贴着实体范围;刚点中的那个用 key 带上 token,每次点击都重新跑一遍脉冲动画
              const pulsing = flash?.clipId === r.clipId;
              return (
                <div
                  key={pulsing ? `${r.clipId}:${flash!.token}` : r.clipId}
                  className={`pc-pv-hit${pulsing ? " is-pulse" : ""}`}
                  style={{
                    left: (r.left + dragDx) * scale,
                    top: (r.top + dragDy) * scale,
                    width: r.width * scale,
                    height: r.height * scale,
                  }}
                />
              );
            })}
          </div>
        </div>
      </div>
      </>
      )}
      
      <ControlBar />
      {showMiniScrubber && <MiniScrubber />}
      
      {contextMenu && (
        <PreviewContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          clipId={contextMenu.clipId}
          cardId={contextMenu.cardId}
          onClose={() => setContextMenu(null)}
        />
      )}
      
      {editingText && (
        <div style={{ position: "fixed", left: editingText.x, top: editingText.y, zIndex: 9999 }}>
          <input
            autoFocus
            type="text"
            value={editingText.value}
            onChange={(e) => setEditingText({ ...editingText, value: e.target.value })}
            onBlur={submitTextEdit}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitTextEdit();
              if (e.key === "Escape") setEditingText(null);
            }}
            style={{
              padding: "4px 8px",
              border: "1px solid var(--ui-accent)",
              borderRadius: 4,
              background: "var(--ui-panel-2)",
              color: "var(--ui-fg)",
              outline: "none",
              fontSize: 14,
            }}
          />
        </div>
      )}
    </div>
  );
}
