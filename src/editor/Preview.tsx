import { UnifiedPreview } from "./preview/UnifiedPreview";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { isScrubbing, subscribeScrub } from "./timeline/useScrub";
import { MediaLayers } from "./preview/MediaLayers";
import { Scene3DView } from "./preview/Scene3DView";
import { themeStyle } from "../themes";
import { actions, getState, useStore } from "../store/project";
import { findClip } from "../kernel/project";
import { nudgeFrame } from "../kernel/layout";
import { createStageRpc, type HostCapabilities, type StageRpcClient } from "../render/stageRpc";
import { frontStage, onStageEvent, releaseStageClient, setStageClient, swapStageClients, syncProject } from "./stageBridge";
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
import { deliverSnapshots, markBaselineReset, noteSettled, pendingDemotes, pickForSetTime, stopSnapshotFeed, streamPlanesAt, suppressedAt, syncSnapshotSubscription } from "./snapshotFeed";
import { playingCatchUpTargets, runPlayingSwap, runSettleSwap, setSwapHost, swapInFlight } from "./stageSwap";
import { demotedClips, onStageDemote } from "./demote";
import { flushSync } from "react-dom";
import { createSharedGl, type SharedGl } from "../render/gl/glParent";
import { resolveGlRoute } from "../render/costDevice.mjs";

/**
 * A1 的 `localHashes`:**当前连接的素材服务**报 `complete` 的哈希集合,换档判据只看它
 * (`src/render/mediaTier.ts` 的 playbackUrl;`docs/semantics/architecture/asset-storage.md`「同步状态只问素材服务」)。
 * 来源 —— 主文档每 2 秒轮询 `GET media/<hash>/chunks` —— 在第 6 步(`docs/plan/cloud-task.md` A1「换档判据」),
 * 这里先留空集合:空集合 = 一律原片,舞台和主文档的声音都和接换档之前一样。
 */
const LOCAL_HASHES: readonly string[] = [];

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
   * 为什么不能是布尔:iframe 里的渲染面换了一个(开发时热更新整页重载、iframe 重新挂载),
   * 它是空的,得重新收一遍 project 和时间。而 `setStageReady(true)` 在已经是 true 时
   * 不改变 state,下面那两个 effect(下发 project、下发时间)就不会重跑 —— 画面一片空白,
   * 得去碰一下时间轴让 `t` 变一下才回来。(最早撞上它的是切 3D 再切回;现在 3D 页不卸 2D 了,
   * 但热重载照样是「新的渲染面 + 旧的 true」。)
   *
   * 换成代数之后,每来一次 `pc-stage-ready` 都是一个新值,两个 effect 必定重跑。
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
  /**
   * 舞台 iframe 的 ref。**卸掉的那一刻就把它的客户端 dispose 并从 stageBridge 摘下。**
   *
   * 以前只在下一次 `pc-stage-ready` 才换掉旧客户端,中间这段 `frontStage()` 一直交出一个
   * 指向已关窗口的客户端:发给它的请求被浏览器静默丢弃、永不回包(3D 页播放失效就是这么挂住的)。
   * 摘掉之后 `stage()` 回 null,各处本来就有的「没有舞台就先不发」分支接手。
   *
   * 回调要**稳定**(useMemo 只建一次):每次渲染换一个新函数的话,React 会先拿 null 调旧的 ——
   * 那就成了每渲染一次 dispose 一次。
   */
  const frameRefOf = useMemo(() => {
    const bind = (id: StageId, holder: React.RefObject<HTMLIFrameElement | null>) => (el: HTMLIFrameElement | null) => {
      holder.current = el;
      if (el) return;
      const client = rpcRef.current[id];
      if (!client) return;
      rpcRef.current[id] = null;
      hostCapsRef.current[id] = null;
      releaseStageClient(client);
      client.dispose();
    };
    return { A: bind("A", frameARef), B: bind("B", frameBRef) };
  }, []);
  /*
   * R9 路线 2(`shared`):编辑器文档开**一个** GL Worker,两个舞台经各自的 `MessageChannel` 共用它。
   * 懒建:生效路线真是 `shared` 时才建。端口在握手之后、任何 RPC 之前交(见下面 `pc-stage-ready` 那段)。
   */
  const sharedGlRef = useRef<SharedGl | null>(null);
  const glPortTo = useCallback((id: StageId, win: Window, caps: HostCapabilities | null) => {
    if (resolveGlRoute(getState().project.glRoute, !!caps?.lowMemory) !== "shared") return;
    sharedGlRef.current ??= createSharedGl({ lowMemory: !!caps?.lowMemory });
    sharedGlRef.current.connect(win, stageTargetOrigin(id), id);
    if (typeof window !== "undefined") (window as unknown as Record<string, unknown>).__pcSharedGlDiag = () => sharedGlRef.current?.diag() ?? Promise.resolve(null);
  }, []);
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
  /** 舞台那一路的 `playing` effect 依赖只有三项(见那里的说明),播放起点从这里读 */
  const contentStartRef = useRef(contentStart);
  contentStartRef.current = contentStart;
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
        // R9 端口转交协议:路线 2 下,握手之后、发任何 RPC(含下面的 setRole)之前先把 GL 端口交过去
        glPortTo(id, win, caps);
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
      sharedGlRef.current?.dispose();
      sharedGlRef.current = null;
    };
  }, [glPortTo]);

  /*
   * 项目选项切了 `glRoute`(R9 约束第 1 条):切到 `shared` 时给已经握过手的舞台补交端口;
   * 切回 `perDocument` 什么都不用发 —— 舞台收到新项目自己按生效路线重建 `glHost` 那一侧的连接。
   * 重走 `ProbeGate` 遮罩(`device` 变了)不在这里,见 R9 报告。
   */
  const glRoute = project.glRoute;
  const glRouteSeen = useRef(glRoute);
  useEffect(() => {
    if (glRouteSeen.current === glRoute) return;
    glRouteSeen.current = glRoute;
    const frames: Record<StageId, React.RefObject<HTMLIFrameElement | null>> = { A: frameARef, B: frameBRef };
    for (const id of STAGE_IDS) {
      const win = frames[id].current?.contentWindow;
      if (win && rpcRef.current[id]) glPortTo(id, win, hostCapsRef.current[id]);
    }
  }, [glRoute, glPortTo]);

  /**
   * 素材和音频按墙钟播:**一拍的名义时长之外再慢这么多**就暂停它们
   * (K4 / pinned 架构 10;`mediaSync.ts` 的 `IN_SYNC_SEC` 同值)。
   * 下一拍准时到达时再放回去 —— 这就是用户能感到的「小卡」。
   *
   * 阈值按 pinned 固定 40 毫秒、不按帧算;**量的是「停顿」而不是两条 `frame` 之间的
   * 总间隔** —— 一拍本来就要 `1000/fps` 毫秒,把它算进卡顿是把正常节拍当成了停顿。
   * 24 / 25 fps 尤其明显:60 Hz 屏上一拍 41.7 / 40 ms 排不进 16.7 ms 的格子,
   * 实际到达是 33 / 50 交替(`StageView.tsx` 的节拍循环自己也这么说),
   * 按总间隔判的话每隔一拍就误判一次卡顿、音频每 ~80 ms 暂停恢复一次。
   * 按「超出名义拍长多少」判:24 fps 的 50 ms 拍只超出 8.3 ms,60 fps 掉一次 vsync
   * 也只超出 16.7 ms,都进不了 40 ms;而真的卡一下(比如 300 ms)照样当场判出来。
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
  /** 验收口:这一轮播放判过几次卡顿、最大的一次超出名义拍长多少毫秒 */
  const stallCountRef = useRef(0);
  const gapMaxRef = useRef(0);

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
  /** 上一次发出去的流平面(R8;同样拼成字符串比) */
  const streamPlanesRef = useRef("[]");
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
    // R8:和抑制集合同一处发流平面(播放中贴流;暂停 / 拖动时清空,改贴快照)
    const planes = streamPlanesAt(head);
    const planesKey = JSON.stringify(planes);
    if (planesKey !== streamPlanesRef.current) {
      streamPlanesRef.current = planesKey;
      void s.setStreamPlanes(planes).catch(() => {});
    }
    await deliverSnapshots(s, "front", head);
  }, []);
  const pumpRef = useRef(pumpFeed);
  pumpRef.current = pumpFeed;

  /*
   * C3 的就绪索引:页面直连预渲染进程的那条 SSE(`snapshotSource.ts`)。
   *
   * **编辑不重连、不清表**(根因 E):项目每变一次这里只核一下 session(镜像可能刚起来、或换了项目),
   * 同一个 session 什么都不做。以前清理函数挂在带 `project` 的 effect 上 —— 每次编辑先
   * `stopSnapshotFeed()` 把就绪索引、字节缓存、投递基线全清掉再重连,重连空档里播放中的重卡全透明。
   * 拆成两个:核 session 的跟着 `project` 跑,收摊的只在 `dual` 变了 / 卸载时跑。
   */
  useEffect(() => {
    if (!dual) return;
    syncSnapshotSubscription(() => { void pumpRef.current(); });
  }, [dual, project]);
  useEffect(() => {
    if (!dual) return;
    return () => stopSnapshotFeed();
  }, [dual]);

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
    /*
     * 基线跟着客户端走(根因 A):新 front 手里是补跑开始时灌的那一份,**不是**此刻的最新项目。
     * 以前这里 `markPushed(role, getState().project)`,补跑期间的编辑(删片段)就永远补不上;
     * 现在 `swapAndDress` 在互换之后补推一次 `syncProject`,按它真正持有的那份算增量。
     */
    swapStageClients({ client: nextFront, caps: hostCapsRef.current[nextId] }, { client: nextBack, caps: hostCapsRef.current[cur] });
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
      // A1 的换档:舞台的 VideoTrack / 像素映射素材按它选档(T1a 审查 #5);来源见 LOCAL_HASHES
      localHashes: () => [...LOCAL_HASHES],
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
      // K4 / pinned 架构 10:这一轮播放里判过几次卡顿(正常播放应当是 0)
      mediaStallCount: stallCountRef.current,
      mediaGapMaxMs: gapMaxRef.current,
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
        // 一拍的名义时长之外还慢了多少(见 MEDIA_STALL_MS 上面那段)
        const overBeat = now - prev - 1000 / Math.max(1, getState().project.fps || 30);
        if (overBeat > gapMaxRef.current) gapMaxRef.current = overBeat;
        const stalled = overBeat > MEDIA_STALL_MS;
        if (stalled === stalledRef.current) break;
        if (stalled) stallCountRef.current++;
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
  /*
   * R7(D3 第 4 步 / D5):主文档的 `mediaRects` 已经删掉。
   *
   * 素材段现在由舞台自己画(E7 第 1 条,R3 落地),`data-pc-clip` 写在显示着的视频槽位
   * 和图片层上,所以舞台的 `rects()` / `hitTest` 本来就认得它们 —— 主文档再补一份,
   * 同一个 clipId 就会出现两次、命中时挑到错的那个。命中测试和实体框**全部走舞台**的
   * `hitTest` / `rectsWithBounds`。
   */

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
    // R7:素材段也在舞台里了(E7 第 1 条),`rectsWithBounds` 一次就把卡片和素材段都带回来
    setRects(cards);
  }, [stage]);

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
    /*
     * R7:卡片和素材段都在舞台里,一次 `hitTest` 往返就是最终答案(D3)。
     * 主文档只在**完全没有舞台**时(还没握手 / iframe 正在换)退回上一轮 `rects` 找一下。
     */
    let card: { clipId: string; left: number; top: number; width: number; height: number } | null = null;
    if (s) {
      try { card = await s.hitTest(x, y); } catch { card = null; }
    }
    const inside = (r: { left: number; top: number; width: number; height: number }) =>
      x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height;
    const hit = card ?? (s ? null : [...rects].reverse().find(inside)) ?? null;
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
  /** 上一次这个 effect 看到的 `playing` —— 「刚从播放翻成暂停」那一次要让给收尾那个 effect */
  const wasPlayingRef = useRef(false);
  useEffect(() => {
    if (!stageReady) return;
    // K4:播放中播放头由舞台的 `frame` 推,父页一拍都不发
    if (dual && playing) { wasPlayingRef.current = true; return; }
    /*
     * **刚暂停的那一次不在这里发**(E0 / R5-4)。收尾是下面那个 effect 的事,它按
     * `pause()` 回包的 `stoppedAt` 发;这里手上只有 `store.t`,可能比舞台落后一拍,
     * 抢着发一次会走向后跳路径(全场 stateful 卡重挂载、`.pc-settling` 闪一下),
     * 而且把 K5 的追帧 / 互换白启动一遍。播放到头(`ended`)走的是同一段。
     */
    const justPaused = dual && wasPlayingRef.current;
    wasPlayingRef.current = false;
    if (justPaused) return;
    /*
     * **`scrubbing` 也进键**(E3 / pinned 架构 9)。拖动松开、在时间轴上点一下,
     * `t` 都可能一点没变(松手坐标等于最后一次 flush 的位置;点击时 `seek` 和
     * `beginScrub` 在同一个 React 事件里批成一次渲染,那一次 `scrubbing` 已经是 true)。
     * 键里不带这一位的话,拖动 / 点击结束之后永远补不上那条 `settle: true`,
     * 判重卡就停在快照上 —— 正是「点时间轴、拖动松开后不精确活渲」那条。
     * legacy 下 `dual` 为 false,后缀恒定,不会多发。
     */
    const key = `${stageReady}|${t}|${playToken}|${dual && scrubbing ? "scrub" : "settle"}`;
    if (key === lastRenderKey.current) return;
    lastRenderKey.current = key;
    void sendSetTime(t, dual && !scrubbingRef.current ? { settle: true } : {});
  }, [stageReady, dual, playing, t, playToken, scrubbing, sendSetTime]);

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
   *
   * 起播位置见 `playStartOf`:播放头不在内容范围里就回到最早那张卡(和 legacy 循环同一条规矩)。
   */
  /**
   * 这一次按播放从哪一秒起。和 legacy 的墙钟循环(`:155-158`)逐字同一条规矩:
   * 播放头在第一张卡之前、或者已经播到头,就从最早那张卡重播。
   *
   * R7 把缺省翻成舞台之后这条规矩漏了,播到头再按播放会在舞台第一拍就
   * `rawSec >= duration`、立刻 post `ended` —— 按下去什么都不发生(R7-11 的回归)。
   */
  const playStartOf = useCallback((): number => {
    const project = getState().project;
    const fps = Math.max(1, project.fps || 30);
    const start = contentStartRef.current;
    const from = tRef.current;
    if (from >= start && from < project.duration - 0.5 / fps) return from;
    // store 也要跟着回到起点:时间轴、素材层、`ended` 之后的那次 settle 都按 store.t 走
    actions.seek(start);
    return start;
  }, []);
  useEffect(() => {
    if (!dual || !stageReady) return;
    let alive = true;
    const s = stage();
    if (!s) return;
    if (playing) {
      lastFrameAtRef.current = 0;
      stalledRef.current = false;
      stallCountRef.current = 0;
      gapMaxRef.current = 0;
      setMediaStalled(false);
      swapTriedRef.current = new Set();
      void (async () => {
        try {
          /*
           * **先等项目送到这个舞台,再起节拍。**
           *
           * 新 iframe 握手之后 `stageReady` +1,上面那个 effect 发 `syncProject`、这里发 `play` ——
           * 但 `syncProject` 走 stageBridge 的串行链(`chain.then`),真正 postMessage 要晚一个微任务,
           * 而 `play` 是同步发的。于是「带着 `playing` 换 iframe」(切回 2D、舞台热重载)时
           * 舞台先收到 `play`,手里还没有项目,回 `no-project`;这里又不重试 —— 按钮是「暂停」、画面不动。
           * 串在同一条链上等它落定,顺序就钉死了。基线没变时 `syncProject` 什么都不发,不多一次往返。
           */
          await syncProject("front", getState().project);
          if (!alive) return;
          const reply = await s.play(playStartOf());
          if (!alive) return;
          // 首拍的到达间隔以 `play()` 回包时刻为起点(K4)
          if (reply.ok) lastFrameAtRef.current = performance.now();
          /*
           * 舞台说起不了(没项目、角色不对):**把 store 也翻回暂停**,别让界面停在「在播」。
           * 翻回去之后下面那一支照常收尾(`pause()` 拿 `stoppedAt` → `setTime(settle)`),
           * 画面和播放头对齐到舞台真实停着的那一帧;用户再按一次播放就是一次干净的起播。
           */
          else if (getState().playing) actions.pause();
        } catch { /* iframe 正在换:新的握手会让这个 effect 带着 playing 重跑一遍 */ }
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

      {view === "2d" && <ToolBar tool={tool} onToolChange={setTool} zoom={cam.scale} fitted={cam.auto} onFit={fitToWindow} />}

      {/*
        * **2D 这一页在 3D 页下面常驻,只是藏起来,不卸载。**
        *
        * 以前是 `view === "3d" ? <3D/> : <2D/>`,切到 3D 就把舞台 iframe 连同主文档的音频层一起卸掉。
        * 可播放头**跟随舞台**(docs/semantics/architecture/rendering.md「播放头跟随舞台」,K4:
        * 非 legacy 下只有可见舞台的 `frame` 事件在推 `t`)—— 舞台没了,3D 页按播放就什么都不会动,
        * 声音也没了。现在舞台一直在跑,3D 页读的还是同一个 `t`,播放轴和声音和 2D 页一模一样。
        *
        * 藏法只能是 `opacity: 0` + 不收指针(和后台舞台同一个理由,见 iframe B 的注释):
        * `display: none` 会让 iframe 里的 rAF 和 `<video>` 停掉,`visibility: hidden` 会让 `isSolid`
        * 判错实体框。`inert` 顺带挡掉键盘焦点落进看不见的那一页。
        * 藏起来的那一页 `inset: 0` 铺在同一块地方,窗口尺寸不变,切回 2D 不用重新适应缩放。
        */}
      <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      {view === "3d" && (
        <div className="pc-pv-stage" style={{ position: "relative" }}>
          <Scene3DView project={project} t={t} />
        </div>
      )}
      <div
        ref={boxRef}
        className="pc-pv-stage"
        data-pc="preview-2d"
        aria-hidden={view === "3d" || undefined}
        inert={view === "3d"}
        style={view === "3d" ? { position: "absolute", inset: 0, opacity: 0, pointerEvents: "none" } : undefined}
      >
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
              <MediaLayers project={project} t={t} playing={playing && !mediaStalled} masterVolume={muted ? 0 : volume} audioOnly localHashes={LOCAL_HASHES} />
              <iframe
                ref={frameRefOf.A}
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
                  /*
                   * R7:**舞台露出来**(D5)。可见的那一个不再是全透明的,用户看到的
                   * 就是舞台 iframe 本身,不再是主文档里那张整帧 `<img>`。
                   *
                   * 判据是 `dual` 而不是「`?preview=stage`」:舞台页只有在 `dual` 时才
                   * 带上 `&preview=stage`(见 `stageSrc`),也才渲 `FrameScene` 的 live 变体、
                   * 才把素材层画在自己里面。端口被占退回同源单舞台时那一份还是 placeholder 内容,
                   * 露出来会是一张没有素材的画面 —— 那时候要继续用 `UnifiedPreview` 的整帧。
                   */
                  opacity: dual && frontId === "A" ? 1 : 0,
                  // 后台那个还要挡掉指针 —— K5 互换之后 A 可能就是后台那一个
                  ...(frontId === "A" ? null : { pointerEvents: "none" as const }),
                }}
              />
              {dual && (
                <iframe
                  ref={frameRefOf.B}
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
                     *
                     * R7:互换之后 B 可能是可见的那一个,那时它跟着露出来。
                     */
                    opacity: frontId === "B" ? 1 : 0,
                    ...(frontId === "B" ? null : { pointerEvents: "none" as const }),
                  }}
                />
              )}
              {/*
                * R7(D5):整帧 `<img>` / `MovPlayer` canvas **只留在 legacy 分支**。
                * 露出舞台之后再画一层整帧,等于把舞台盖住,而且那一层要等 HTTP
                * ——「暂停拖动画面同一帧内更新、不等待 HTTP」这条就没了。
                */}
              {!dual && <UnifiedPreview project={project} t={t} playing={playing} />}
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
      </div>

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
