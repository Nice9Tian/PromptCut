import { UnifiedPreview } from "./preview/UnifiedPreview";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { isScrubbing, subscribeScrub } from "./timeline/useScrub";
import { MediaLayers } from "./preview/MediaLayers";
import { Scene3DView } from "./preview/Scene3DView";
import { themeStyle } from "../themes";
import { actions, getState, useStore } from "../store/project";
import { videoLayersAt, findClip } from "../kernel/project";
import { frameBox, nudgeFrame } from "../kernel/layout";
import { createStageRpc, type HostCapabilities, type StageRpcClient } from "../render/stageRpc";
import { frontStage, markPushed, onStageEvent, setStageClient, syncProject } from "./stageBridge";
import { INITIAL_ROLE_OF, STAGE_IDS, dualStage, stageSrc, stageTargetOrigin, type StageId } from "./previewMode";
import { ControlBar } from "./preview/ControlBar";
import { ToolBar, ToolType } from "./preview/ToolBar";
import { MiniScrubber } from "./preview/MiniScrubber";
import { PreviewContextMenu } from "./preview/PreviewContextMenu";
import { getCard } from "../kernel/registry";
import { useLayoutMode } from "./layoutMode";
import { fitView, frameOrigin, panBy, wheelZoomFactor, zoomAt, type View2D } from "./preview/viewport2d";
import "./preview/preview.css";
import { atFrameGrid } from "../render/frameGrid";
import { contentStartOf } from "./timeline/utils";
import { deliverSnapshots, markBaselineReset, noteSettled, pendingDemotes, pickForSetTime, stopSnapshotFeed, suppressedAt, syncSnapshotSubscription } from "./snapshotFeed";
import { playingCatchUpTargets, runPlayingSwap, runSettleSwap, setSwapHost, swapInFlight } from "./stageSwap";
import { demotedClips, onStageDemote } from "./demote";
import { flushSync } from "react-dom";

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
  /**
   * 两个舞台 iframe(E1)。`A` / `B` **只是实例名,和角色无关** —— 起手 A 当可见舞台、
   * B 当后台舞台(`INITIAL_ROLE_OF`),角色只经 `setRole` 定,K5 的互换之后就换过来了。
   * legacy(缺省)下只挂 A 那一个、同源,和今天一模一样。
   */
  const frameARef = useRef<HTMLIFrameElement>(null);
  const frameBRef = useRef<HTMLIFrameElement>(null);
  const dual = dualStage();
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

  /**
   * 舞台的 RPC 客户端(E0):一个 iframe 实例一个,`pc-stage-ready` 握手到了就换新的、旧的 dispose。
   * 主文档和舞台之间只有 postMessage,不再摸 iframe 里的 window.__pcStage。
   * 右栏的定位工具经 stageBridge 拿同一个客户端(D4 页面侧),这里每换一次就登记一次。
   */
  const rpcRef = useRef<Record<StageId, StageRpcClient | null>>({ A: null, B: null });
  const hostCapsRef = useRef<Record<StageId, HostCapabilities | null>>({ A: null, B: null });
  /**
   * 下面那一堆(拖动、命中、心跳、节拍)问的都是**可见舞台**。
   *
   * 起手是 A,但 **K5 的角色互换之后就不是了** —— 所以问 `stageBridge` 要「此刻谁是 `front`」,
   * 不能写死 `rpcRef.current.A`。legacy 的单舞台照样成立(它只登记了一个 `front`)。
   */
  const stage = useCallback((): StageRpcClient | null => frontStage(), []);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  /*
   * 播放循环。**播放头只停在成片真有的那些帧上。**
   *
   * 以前是按墙上时钟连续推的:显示器 60Hz 就一秒推 60 个 t,而成片是 fps 帧的,
   * 于是有一半的 t 在成片里根本不存在。单看 2D 察觉不到,一切到 3D 就露馅 ——
   * 那边显示的是预渲染好的整帧,两个视图对同一个播放头能差半帧,而进场动画最陡的就是那一段。
   * 量化之后 2D 播放显示的就是导出会写出来的那一帧,3D 贴的也是同一帧。
   *
   * 累加器 acc 必须保持不量化,不然每帧丢掉的那点余数会累起来,播放越走越慢。
   *
   * 播放范围 = 最早的卡片 ~ 最晚的卡片(project.duration 由时间轴按内容末尾同步)。
   * 按播放时播放头不在这个范围里(在第一张卡前面,或者已经播到头),从最早那张卡开始播。
   */
  const contentStart = contentStartOf(project.tracks);
  useEffect(() => {
    /*
     * E6:**非 legacy 下这个循环不启动** —— 播放头由 K4 的 `frame` 事件推进
     * (可见舞台自己按帧节拍,每拍渲完才报)。墙钟循环只留给 `?preview=legacy`。
     */
    if (dual) return;
    if (!playing) return;
    const fps = Math.max(1, project.fps || 30);
    let raf = 0;
    let last = performance.now();
    let acc = tRef.current;      // 真实推进到哪儿(不量化)
    if (acc < contentStart || acc >= project.duration - 0.5 / fps) {
      acc = contentStart;
      actions.seek(contentStart);
    }
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
    // contentStart 不进依赖:播放中挪了第一张卡不该把播放头拽回去
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dual, playing, project.duration, project.fps]);

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

  /*
   * 渲染面就绪:它挂载完会 postMessage 过来(带 J4 的宿主能力表);每来一次就给**那一个实例**
   * 建一个新的 RPC 客户端。跨源时 `targetOrigin` 必须点名舞台的源(不能再用 `location.origin`)。
   *
   * 握手之后立刻发一次 `setRole` 把实例和角色对上:舞台自己的缺省角色是 `front`,
   * B 那个 iframe 不发就会顶着 `front` 的身份收探针(角色闸门会挡下来,但那是兜底不是设计)。
   */
  useEffect(() => {
    const frames: Record<StageId, React.RefObject<HTMLIFrameElement | null>> = { A: frameARef, B: frameBRef };
    const onMessage = (e: MessageEvent) => {
      if ((e.data as { type?: string } | null)?.type !== "pc-stage-ready") return;
      for (const id of STAGE_IDS) {
        const win = frames[id].current?.contentWindow;
        if (!win || e.source !== win) continue;
        /*
         * 这个实例此刻该是什么角色。**不能一律照 `INITIAL_ROLE_OF` 走** ——
         * K5 的互换之后 A 可能已经是后台那一个了,它热重载一次就会顶着 `front` 回来、
         * 把真正的可见舞台顶掉。
         */
        const role = frontIdRef.current === id ? "front" : "back";
        rpcRef.current[id]?.dispose();
        const client = createStageRpc(win, stageTargetOrigin(id));
        rpcRef.current[id] = client;
        const caps = (e.data as { hostCapabilities?: HostCapabilities }).hostCapabilities ?? null;
        hostCapsRef.current[id] = caps;
        // 能力表一起登记:K1 的 device 串要 lowMemory / offscreenGl,而它必须是**舞台**探到的那一份
        setStageClient(role, client, caps);
        void client.setRole(role).catch(() => { /* iframe 又换了,下一次握手会重发 */ });
        // 每来一次就 +1:同一个值再赋一遍不会触发重渲染,而新挂的 iframe 需要重新收一遍 project 和时间
        if (role === "front") setStageReady((n) => n + 1);
        return;
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      for (const id of STAGE_IDS) {
        rpcRef.current[id]?.dispose();
        rpcRef.current[id] = null;
        setStageClient(INITIAL_ROLE_OF[id], null);
      }
    };
  }, []);

  /**
   * 素材和音频按墙钟播:相邻两条 `frame` 到得比这个还慢就暂停它们(K4 / pinned 架构 10;
   * `mediaSync.ts` 的 `IN_SYNC_SEC` 同值)。下一拍准时到达时再放回去 —— 这就是用户能感到的「小卡」。
   */
  const MEDIA_STALL_MS = 40;
  /** E6:播放中 `refreshRects` 改成定时器,别每拍都往返一次 */
  const RECTS_POLL_MS = 500;

  /**
   * 播放中素材层 / 音频是不是被掐住了(K4 的 `mediaStalled`)。
   *
   * **通道写死**:`MediaLayers` 的 `playing` prop 改成 `playing && !mediaStalled`,舞台侧经
   * `setPlaying(false)` 同步。直接对元素 `pause()` 没用 —— `planSync` 在播放态的每个分支
   * 都返回 `play: paused`,下一拍就被 `play()` 回来了。
   */
  const [mediaStalled, setMediaStalled] = useState(false);
  const stalledRef = useRef(false);
  /** 上一条 `frame` 的**真实**到达时刻(首拍以 `play()` 回包时刻为起点) */
  const lastFrameAtRef = useRef(0);

  /*
   * 快照 / 抑制的投递(C4、C5、A3c;排程在 `snapshotFeed.ts`)。
   *
   * 三处叫它:每拍收到 `frame` 之后(播放中)、`setTime` 发完之后(暂停 / 拖动),
   * 以及快照字节 / 新的就绪层到货之后。33 ms 的节流在 `deliverSnapshots` 里,
   * 所以这三处可以放心地多叫几次。
   */
  const dualRef = useRef(dual);
  dualRef.current = dual;
  /** 上一次发出去的抑制集合(拼成一条字符串比,省掉没变也发) */
  const suppressedRef = useRef("");
  const pumpFeed = useCallback(async () => {
    if (!dualRef.current) return;
    const s = frontStage();
    if (!s) return;
    const head = { project: getState().project, t: tRef.current, playing: playingRef.current };
    // 抑制只在播放中有(C5 / K5:拖动和暂停下不抑制、改贴快照)
    const want = head.playing ? suppressedAt(head).join("|") : "";
    if (want !== suppressedRef.current) {
      suppressedRef.current = want;
      void s.setSuppressed(want ? want.split("|") : []).catch(() => {});
    }
    await deliverSnapshots(s, "front", head);
  }, []);
  const pumpRef = useRef(pumpFeed);
  pumpRef.current = pumpFeed;

  /* C3 的就绪索引:页面直连预渲染进程的那条 SSE(`snapshotSource.ts`) */
  useEffect(() => {
    if (!dual) return;
    syncSnapshotSubscription(() => { void pumpRef.current(); });
    return () => stopSnapshotFeed();
  }, [dual, project]);

  /* 换了 iframe:那一份投递基线跟着作废,下一次带 `reset`(A3c) */
  useEffect(() => {
    if (!dual || !stageReady) return;
    markBaselineReset("front");
    suppressedRef.current = "";
  }, [dual, stageReady]);

  /*
   * K5 (4) 的角色互换。**A / B 只是实例名**,谁是 `front` 由这个 state 说了算 ——
   * 起手 A,互换之后就换过来了。两件事必须在**一次 React 提交**里做完:
   * 对调两个 iframe 的可见性,和把「当前 front」指针切过去(`stageBridge` 的登记)。
   *
   * 后台那个只能用 `opacity: 0; pointer-events: none` 藏 —— `display: none` /
   * `visibility: hidden` 会让整份 OOPIF 退出渲染树,`requestVideoFrameCallback` 不再回调,
   * K5 (3) 的 `mediaReady` 就只能等到超时(见 K5 (4) 的说明)。
   */
  const [frontId, setFrontId] = useState<StageId>("A");
  const frontIdRef = useRef<StageId>("A");
  frontIdRef.current = frontId;
  const swapRoles = useCallback(() => {
    const cur = frontIdRef.current;
    const nextId: StageId = cur === "A" ? "B" : "A";
    const nextFront = rpcRef.current[nextId];
    if (!nextFront) return null;
    const nextBack = rpcRef.current[cur];
    frontIdRef.current = nextId;
    flushSync(() => setFrontId(nextId));
    setStageClient("front", nextFront, hostCapsRef.current[nextId]);
    setStageClient("back", nextBack, hostCapsRef.current[cur]);
    /*
     * 两个 iframe 手里本来就都是这份整份项目(第二路的 (1) 给 `back` 灌的就是它),
     * 只是 `setStageClient` 换客户端时把基线清成了 null。补回去,免得互换之后
     * 第一次 `syncProject` 又整份重灌一遍、顺手掐掉刚起的节拍。
     */
    const project = getState().project;
    markPushed("front", project);
    markPushed("back", project);
    // 新 front 的抑制集合从零开始记
    suppressedRef.current = "";
    return { front: nextFront, back: nextBack };
  }, []);
  useEffect(() => {
    if (!dual) return;
    setSwapHost({
      swapRoles,
      // 2D 预览**不加 proxy=1**(见下面 iframe 那段注释),所以互换后重发的也是 false
      proxy: () => false,
      // A1 的换档那条路还没有消费方(R3 只把口子留在签名上)
      localHashes: () => [],
    });
    return () => setSwapHost(null);
  }, [dual, swapRoles]);

  /** 这一轮播放已经为哪几张卡发起过互换(别每拍都发一次) */
  const swapTriedRef = useRef(new Set<string>());

  /* 验收探针的观察口:父页这一侧的状态(哪个 iframe 是 front、素材掐住没有、降级到哪一步) */
  useEffect(() => {
    if (!dual) return;
    const w = window as unknown as { __pcPreviewDiag?: () => unknown };
    w.__pcPreviewDiag = () => ({
      frontId: frontIdRef.current,
      mediaStalled: stalledRef.current,
      suppressed: suppressedRef.current ? suppressedRef.current.split("|") : [],
      pendingDemote: [...pendingDemotes()],
      demoted: [...demotedClips()],
      swapInFlight: swapInFlight(),
    });
    return () => { delete w.__pcPreviewDiag; };
  }, [dual]);

  /*
   * 舞台事件的分发(E0 的七种;来源过滤在 stageBridge 里按角色做完了)。
   *
   * 监听只登记一次,所以里面读的一律是 ref / store,不读闭包里的 state。
   */
  useEffect(() => onStageEvent((e) => {
    switch (e.type) {
      case "frame": {
        // K4:可见舞台每渲完一拍报一次 t,播放头跟它走(那时 Preview 的 rAF 循环不启动)
        const now = performance.now();
        const prev = lastFrameAtRef.current;
        lastFrameAtRef.current = now;
        actions.tick(e.sec);
        // 这一拍的抑制集合和快照(C5:播放中发 setSuppressed(H(t)) + setSnapshots)
        void pumpRef.current();
        /*
         * K3(b) 的 `vtOk = false` 轻卡:播放头刚进入它时整场景在后台补跑后互换。
         * 每张卡这一轮播放只发起一次 —— 补跑一次要几百毫秒,每拍发一次只会互相掐。
         */
        if (!swapInFlight()) {
          const targets = playingCatchUpTargets(getState().project, e.sec).filter((id) => !swapTriedRef.current.has(id));
          if (targets.length) {
            for (const id of targets) swapTriedRef.current.add(id);
            void runPlayingSwap(targets);
          }
        }
        if (!prev) break;
        const stalled = now - prev > MEDIA_STALL_MS;
        if (stalled === stalledRef.current) break;
        stalledRef.current = stalled;
        setMediaStalled(stalled);
        // 舞台侧的素材层同步掐住 / 放回;主文档的音频由 MediaLayers 的 playing prop 管
        void frontStage()?.setPlaying(!stalled && playingRef.current).catch(() => {});
        break;
      }
      case "ended":
        /*
         * K4 播放到头:写 store(`pause()` + `seek(duration)`)。剩下三步
         * (`setPlaying(false)`、`pause()` 拿 `stoppedAt`、`setTime(stoppedAt, { settle: true })`)
         * 和按暂停**是同一段收尾** —— `playing` 翻成 false 之后由下面那个 effect 统一做,
         * 少了最后一步的话最后一帧的重卡永远停在抑制态(pinned 架构 9)。
         */
        actions.pause();
        actions.seek(e.sec);
        break;
      case "settled":
        // K5:暂停态活渲就绪 —— 把这几张卡从投递基线里删掉(A3c),平面舞台自己摘了
        noteSettled("front", e.clipIds);
        break;
      case "demote":
        // K6:这张卡降级,父页整条 PUT { ...旧记录, capped: true, demoted: true }
        void onStageDemote(e.clipId);
        break;
      case "probe":
      case "probe-frame":
        // K1(R4):探针的成绩和它顺手推出来的死素材(消费方在 probeRunner)
        break;
      case "mediaReady":
        // K5 第 (4) 步:后台舞台的素材层画出一帧了(消费方在 catchUp.ts,它自己订阅)
        break;
    }
  }), []);

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
    /*
     * R3:非 legacy 下素材层已经在舞台里了(E7 第 1 条),舞台的 `rects()` / `hitTest`
     * 自己就认得它们(`data-pc-clip` 写在显示着的视频槽位和图片层上,D3 第 4 步)。
     * 再补一份就会同一个 clipId 出现两次、命中时挑到错的那个。
     * 这个 `useCallback` 整个删掉是 R7(D5 的「删主文档的 mediaRects」),那一步 legacy 也不要了。
     */
    if (dual) return [];
    const stageSize = { width: project.width, height: project.height };
    /*
     * `t` 走 ref,**不进依赖**。它每拍都在变,进了依赖就会让 `mediaRects` → `refreshRects`
     * → `sendSetTime` 这一串回调每拍换一个新身份,挂着它们的 effect 跟着每拍重跑一次 ——
     * 其中就有 K4 那个「playing 翻转时起 / 停节拍」的 effect,于是暂停之后它每次
     * `actions.tick(stoppedAt)` 又把自己触发一遍,React 直接报 Maximum update depth。
     * 这个回调只在事件里被叫,读 ref 拿到的本来就是最新值。
     */
    return videoLayersAt(project, tRef.current).map((l) => ({ clipId: l.clip.id, ...frameBox(l.clip.frame, stageSize) }));
  }, [dual, project]);

  /**
   * 一次往返拿全部活跃片段的外框 + 实体范围(rectsWithBounds,合并了以前 rects() 后逐个 bounds() 的 N+1)。
   * 心跳只带 pixels: 'selected':只对选中的卡扫 canvas 像素(选中描边不回退到整块画布),
   * 未选中的卡用元素矩形 —— 它们的框只进 rects 列表、不画描边。'all' 只在用户点击那一次用。
   * 回包乱序时旧的一次不能盖掉新的,用代数守着。
   */
  const rectsGen = useRef(0);
  const refreshRects = useCallback(async (pixels: "selected" | "all" = "selected") => {
    const s = stage();
    const gen = ++rectsGen.current;
    let cards: { clipId: string; left: number; top: number; width: number; height: number }[] = [];
    if (s) {
      try {
        const list = await s.rectsWithBounds(pixels === "selected" ? { pixels, clipIds: selectionRef.current } : { pixels });
        cards = list.map((r) => ({ clipId: r.clipId, ...(r.bounds ?? r.rect) }));
      } catch {
        // iframe 正在换(detached):这一次作废,新的 ready 会再刷一遍
        return;
      }
    }
    if (gen !== rectsGen.current) return;
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
  const hitAt = async (e: { clientX: number; clientY: number; currentTarget: EventTarget & Element }) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / scale;
    const y = (e.clientY - rect.top) / scale;
    const s = stage();
    // 卡片在上层:先问舞台(一次 RPC 往返)。没点中卡片再看素材段(它们在主文档里,舞台看不见)
    let card: { clipId: string; left: number; top: number; width: number; height: number } | null = null;
    if (s) {
      try { card = await s.hitTest(x, y); } catch { card = null; }
    }
    const inside = (r: { left: number; top: number; width: number; height: number }) =>
      x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height;
    const hit =
      card ??
      [...mediaRects()].reverse().find(inside) ??
      (s ? null : [...rects].reverse().find(inside)) ??
      null;
    return { hit, overlayRect: rect };
  };

  // 项目文档变了就发过去:经 stageBridge 只发变了的片段(两层 diff),没有基线时整份 + reset
  useEffect(() => {
    if (!stageReady) return;
    void syncProject("front", project).then(() => refreshRects(), () => {});
  }, [stageReady, project, refreshRects]);

  // 时间变了就下发。播放中是连续推进;拖播放头 / 跳转 / 重播(playToken 变)都按跳转处理:
  // 重挂载 + 从入点补跑到那一刻。两者合在一个 effect 里,一次 seek 只渲染一帧。
  /*
   * 只认「时间真的变了」:stage / refreshRects 这两个回调的引用会跟着项目、缩放一起换,
   * 以前它们一换这个 effect 就重跑,于是 Agent 每写一次项目都多来一次 jump 渲染 ——
   * 重挂载活跃的卡、从入点逐帧补跑到播放头,实测播放头在 60 秒处每次 230~350 ms 的主线程,
   * 而项目变了该不该补跑,setProject 那边(StageView)已经按「哪张卡变了、在不在画面上」判过了。
   */
  /*
   * E0:暂停、拖动只发 setTime(不重挂载、不递增 playToken —— 时钟拨过去、提交 React、钉动画);
   * 父页对可见舞台**不再**发 render(jump)。
   *
   * **E6:这个 effect 拆成了两半。** 发 `setTime(t)` 那半**播放中不跑**(K4 由舞台自己按帧节拍
   * 推进,父页再发就是两个人抢方向盘);`refreshRects()` 那半改成播放中每 500 ms 一次的定时器
   * (见下面那个 effect),结果按请求序号丢弃过期的(`refreshRects` 里的 `rectsGen`)。
   * 先同步项目再拨时间,两条 RPC 顺序不能反(setTime 要在新项目上算活跃卡)。
   */
  const scrubbing = useSyncExternalStore(subscribeScrub, isScrubbing, isScrubbing);
  const scrubbingRef = useRef(scrubbing);
  scrubbingRef.current = scrubbing;
  const lastRenderKey = useRef("");
  /**
   * 给可见舞台拨一次时间。**暂停和拖动的唯一入口**(播放走 K4)。
   *
   * `settle: true` 启动 K5 的暂停态活渲:点时间轴、拖动松开、按暂停、播放到头都带它,
   * **拖动过程中不带**(E3)。
   */
  const sendSetTime = useCallback(async (sec: number, opts: { settle?: true } = {}) => {
    const s = stage();
    if (!s) return;
    try {
      await syncProject("front", getState().project);
      /*
       * C4 的快照增量和 `t` 在**同一次 React 提交**里生效(E0):拖过一张 stateful 卡的
       * 入点时,新挂载的组件和它的快照平面同帧出现、不闪初始态。手里没有的那几帧当场
       * 发起取字节(不等),由 `.pc-awaiting` 藏 500 ms 兜底。
       */
      const feed = dualRef.current ? pickForSetTime({ project: getState().project, t: sec, playing: false })
        : { snapshots: {} as Record<string, string | null>, awaiting: [] as string[] };
      await s.setTime(sec, {
        ...opts,
        ...(Object.keys(feed.snapshots).length ? { snapshots: feed.snapshots } : {}),
        ...(feed.awaiting.length ? { awaiting: feed.awaiting } : {}),
      });
    } catch {
      // iframe 正在换(detached):新的 ready 会重发
      return;
    }
    void refreshRects();
    void pumpRef.current();
    /*
     * K5 第二路:只要这一刻有一张判重卡是 `vtOk = false`,就让后台舞台整场景补跑、
     * 补完互换成精确活渲。`vtOk` 的那些已经在可见舞台里自己追了(K5 第一路,舞台侧)。
     */
    if (dualRef.current && opts.settle) void runSettleSwap(sec).catch(() => { /* 后台舞台正在换:下一次 setTime 会重来 */ });
  }, [stage, refreshRects]);
  /** K4 的起 / 停节拍只认 `playing`,所以那个 effect 读这一份、不把 `sendSetTime` 进依赖 */
  const sendSetTimeRef = useRef(sendSetTime);
  sendSetTimeRef.current = sendSetTime;
  useEffect(() => {
    if (!stageReady) return;
    // K4:播放中播放头由舞台的 `frame` 推,父页一拍都不发
    if (dual && playing) return;
    const key = `${stageReady}|${t}|${playToken}`;
    if (key === lastRenderKey.current) return;
    lastRenderKey.current = key;
    void sendSetTime(t, dual && !scrubbingRef.current ? { settle: true } : {});
  }, [stageReady, dual, playing, t, playToken, sendSetTime]);

  /* E6:播放中 `refreshRects` 改成定时器,一次往返、结果按序号丢过期的 */
  useEffect(() => {
    if (!dual || !stageReady || !playing) return;
    const id = window.setInterval(() => { void refreshRects(); }, RECTS_POLL_MS);
    return () => window.clearInterval(id);
  }, [dual, stageReady, playing, refreshRects]);

  /*
   * K4 的父页侧:`playing` 翻成 true 就 `play(t)` 起节拍,翻成 false 就走收尾
   * (`setPlaying(false)` → `pause()` 拿 `stoppedAt` → `setTime(stoppedAt, { settle: true })`)。
   *
   * **以舞台最后一拍的 `t` 为准,不用 `store.t`**(E0):store 的 `t` 可能比舞台落后一拍,
   * 按它发会走向后跳路径、全场 stateful 卡重挂载。
   * 播放到头(`ended`)走的是同一段 —— 那边只写 store,`playing` 翻 false 之后落到这里。
   */
  useEffect(() => {
    if (!dual || !stageReady) return;
    let alive = true;
    const s = stage();
    if (!s) return;
    if (playing) {
      lastFrameAtRef.current = 0;
      stalledRef.current = false;
      setMediaStalled(false);
      swapTriedRef.current = new Set();
      void (async () => {
        try {
          const reply = await s.play(tRef.current);
          // 首拍的到达间隔以 `play()` 回包时刻为起点(K4)
          if (alive && reply.ok) lastFrameAtRef.current = performance.now();
        } catch { /* iframe 正在换 */ }
      })();
    } else {
      void (async () => {
        // **发 pause() 的这一处同步清空 lastRenderKey**(E6),否则下一次 setTime 被去重吞掉
        lastRenderKey.current = "";
        stalledRef.current = false;
        setMediaStalled(false);
        let stoppedAt = tRef.current;
        try {
          const reply = await s.pause();
          if (reply.ok && typeof reply.stoppedAt === "number") stoppedAt = reply.stoppedAt;
        } catch { /* iframe 正在换 */ }
        if (!alive) return;
        if (Math.abs(getState().t - stoppedAt) > 1e-6) actions.tick(stoppedAt);
        await sendSetTimeRef.current(stoppedAt, { settle: true });
      })();
    }
    return () => { alive = false; };
    /*
     * **依赖只有三项**。`t` 每拍都在变,`stage` / `sendSetTime` 的身份也会跟着换 ——
     * 进了依赖这个 effect 就每拍重跑一次:播放中会把刚起的节拍循环停掉重起,
     * 暂停中那一支的 `actions.tick(stoppedAt)` 会把自己再触发一遍(无限更新)。
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dual, stageReady, playing]);

  /*
   * R3 的最小接线:非 legacy 下素材层在**舞台里**(E7 第 1 条),它要三样东西才动得起来 ——
   * `mediaT`(跟哪一刻)、`scrubbing`(seek 放疏一点)、`playing`(只管素材层,不碰 K4 的节拍循环)。
   *
   * **两个舞台都发**(E3:「素材层 `mediaT = t`,两种角色一样」):K5 第二路互换前
   * `back` 的素材必须已经在目标拍上,不然互换后偏差过 `HARD_SEEK_SEC`、必付一次硬 seek。
   * legacy 下一条都不发 —— 那边素材层还在主文档。
   *
   * `playing` 带上 `mediaStalled`(K4):舞台的素材层和主文档的音频一起掐、一起放。
   */
  useEffect(() => {
    if (!dual || !stageReady) return;
    for (const id of STAGE_IDS) {
      const c = rpcRef.current[id];
      if (!c) continue;
      void c.setScrubbing(scrubbing).catch(() => {});
      void c.setPlaying(playing && !mediaStalled).catch(() => {});
    }
  }, [dual, stageReady, scrubbing, playing, mediaStalled]);
  useEffect(() => {
    if (!dual || !stageReady) return;
    for (const id of STAGE_IDS) {
      const c = rpcRef.current[id];
      if (!c) continue;
      void c.setMediaT(t).catch(() => {});
    }
  }, [dual, stageReady, t]);

  // 画面层和声音层都由 MediaLayers 管:可以同时有多条画面(重叠+淡化=交叉溶解),音频段单独出声

  // 命中测试与拖拽逻辑
  /**
   * 命中是一次异步往返(舞台在 iframe 里),但**起点不能丢**:pointerdown 时先同步抓住指针、记下起点,
   * 再 await hitTest;await 期间到达的 pointermove / pointerup 先累积,命中结果回来后再决定是选中还是开始拖动 ——
   * 「点画布后立刻拖动」的那几个 move 事件不会漏,松手早于回包也不会留下一个永远在拖的状态。
   */
  const handleOverlayPointerDown = async (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const overlay = e.currentTarget as HTMLElement;
    const startX = e.clientX;
    const startY = e.clientY;
    const pointerId = e.pointerId;
    try { overlay.setPointerCapture(pointerId); } catch { /* 指针已经没了,照样能算命中 */ }

    // await 期间的事件先记着
    let lastX = startX;
    let lastY = startY;
    let released = false;
    const onEarlyMove = (ev: PointerEvent) => { if (ev.pointerId === pointerId) { lastX = ev.clientX; lastY = ev.clientY; } };
    const onEarlyUp = (ev: PointerEvent) => { if (ev.pointerId === pointerId) released = true; };
    window.addEventListener("pointermove", onEarlyMove);
    window.addEventListener("pointerup", onEarlyUp);
    window.addEventListener("pointercancel", onEarlyUp);

    const { hit: targetRect } = await hitAt({ clientX: startX, clientY: startY, currentTarget: overlay });

    window.removeEventListener("pointermove", onEarlyMove);
    window.removeEventListener("pointerup", onEarlyUp);
    window.removeEventListener("pointercancel", onEarlyUp);

    const release = () => { try { if (overlay.hasPointerCapture(pointerId)) overlay.releasePointerCapture(pointerId); } catch { /* 已经放开了 */ } };

    if (tool === "select") {
      release();
      // 选择工具：点在实体上则选中并闪一下描边，点空白(或透明区域下面没东西)则取消选中
      if (targetRect) {
        actions.select([targetRect.clipId]);
        flashClip(targetRect.clipId);
        // 点击那一次用 'all':新选中的 canvas 卡描边按像素框来,不回退到整块画布
        void refreshRects("all");
      } else {
        actions.select([]);
      }
    } else if (tool === "move") {
      // 移动工具：按下开始拖拽，移动时更新本地拖拽状态，松开才写入 store 记录撤销
      if (!targetRect) { release(); return; }
      actions.select([targetRect.clipId]);
      flashClip(targetRect.clipId);
      const clipId = targetRect.clipId;

      let currentDx = 0;
      let currentDy = 0;
      const applyMove = (cx: number, cy: number) => {
        // 覆盖层是按 scale 缩放显示的,位移换算回舞台像素,和 frame 用的是同一套单位
        currentDx = (cx - startX) / scale;
        currentDy = (cy - startY) / scale;
        setDragPreview({ clipId, dx: currentDx, dy: currentDy });
      };
      const onMove = (ev: PointerEvent) => { if (ev.pointerId === pointerId) applyMove(ev.clientX, ev.clientY); };
      const onUp = () => {
        setDragPreview(null);
        release();
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
        window.removeEventListener("pointercancel", onUp);
      };

      // 回包之前已经动过 / 松过手的,现在补上
      if (lastX !== startX || lastY !== startY) applyMove(lastX, lastY);
      if (released) { onUp(); return; }
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    } else {
      release();
    }
  };

  // 文字工具逻辑
  const handleOverlayDoubleClick = async (e: React.MouseEvent) => {
    if (tool !== "text") return;
    const { hit: targetRect, overlayRect: rect } = await hitAt(e);
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

  const handleOverlayContextMenu = async (e: React.MouseEvent) => {
    e.preventDefault();
    const { clientX, clientY, currentTarget } = e;
    const { hit: targetRect } = await hitAt({ clientX, clientY, currentTarget });
    if (targetRect) {
      const clip = project.tracks.flatMap((tr) => tr.clips).find((c) => c.id === targetRect.clipId);
      if (clip) {
        actions.select([clip.id]);
        flashClip(clip.id);
        setContextMenu({ x: clientX, y: clientY, clipId: clip.id, cardId: clip.cardId });
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
              {/* K4 的 `mediaStalled`:舞台连着两拍来得比 40 ms 还慢时,音频跟着停一下 */}
              <MediaLayers project={project} t={t} playing={playing && !mediaStalled} masterVolume={muted ? 0 : volume} audioOnly />
              <iframe
                ref={frameARef}
                data-pc="stage-frame"
                title="预览舞台"
                /*
                 * 这里**不加 proxy=1**:2D 预览的契约是「预览所见 = 导出所得」,
                 * 播放时换成色块就把这条破了 —— 用户按播放是要看成片长什么样,
                 * 不是要看构图草图。代理只活在 3D 视图里,而且只是预渲染没跟上时的过渡。
                 */
                src={stageSrc("A")}
                style={{
                  position: "absolute",
                  inset: 0,
                  width: project.width,
                  height: project.height,
                  border: 0,
                  display: "block",
                  background: "transparent",
                  colorScheme: "normal",
                  // R7 才摘掉它(那一步露出舞台);R5 两个 iframe 都照旧全透明
                  opacity: 0,
                  // 后台那个还要挡掉指针 —— K5 互换之后 A 可能就是后台那一个
                  ...(frontId === "A" ? null : { pointerEvents: "none" as const }),
                }}
              />
              {dual && (
                <iframe
                  ref={frameBRef}
                  data-pc="stage-frame-back"
                  title="后台舞台"
                  src={stageSrc("B")}
                  style={{
                    position: "absolute",
                    inset: 0,
                    width: project.width,
                    height: project.height,
                    border: 0,
                    display: "block",
                    background: "transparent",
                    colorScheme: "normal",
                    /*
                     * 后台舞台**只能这么藏**(K5 (4)):`display: none` 会让里面的
                     * `<video>` 和 rAF 停掉、布局全归零,补跑出来的画面和可见舞台对不上;
                     * `visibility: hidden` 会让 `solid.ts` 的 `isSolid` 判它不是实体,
                     * 量出来的实体框退回整屏。`opacity: 0` 保留布局和渲染,只是看不见。
                     */
                    opacity: 0,
                    ...(frontId === "B" ? null : { pointerEvents: "none" as const }),
                  }}
                />
              )}
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
