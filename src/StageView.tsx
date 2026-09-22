import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Stage, type StreamPlaneGroup } from "./render/Stage";
import { FrameScene } from "./render/FrameScene";
import { flattenOverlay, type Project } from "./kernel/project";
import { projectCardGraph } from "./kernel/cardGraph.mjs";
import { getCard } from "./kernel/registry";
import { installStageClock } from "./render/stageClock";
import { cardMountedAt, mountFrameOf } from "./render/frameWindow.mjs";
import { createAnimationPinner } from "./render/pinAnimations";
import { createSnapshot } from "./render/createSnapshot";
import { clipWrapper, hitTest as solidHitTest, rectsWithBounds as solidRectsWithBounds } from "./render/solid";
import { applyProjectPatch, type ProjectPatch } from "./render/changedClips.mjs";
import {
  detectHostCapabilities,
  postStageEvent,
  postStageReady,
  serveStageRpc,
  type BackJob,
  type PlayReply,
  type ProbeBooleans,
  type RenderReply,
  type SetTimeReply,
  type SnapshotCost,
  type StageRole,
  type StageRpcApi,
} from "./render/stageRpc";
import { PROBE_BOOL_FRAMES, PROBE_BOOL_MS, PROBE_MAX_FRAMES, PROBE_MAX_MS } from "./render/pipelineTuning.mjs";
import { compareSnapshotHtml } from "./render/snapshotCompare.mjs";
import { budgetOf, CATCHUP_STEPS_PER_BEAT, clipWeight, pipelineAt } from "./render/pipelinePlan.mjs";
import { reviveStagePlan, type StagePlan, type WirePlan } from "./render/wirePlan";
import { ensureProxyStyle, proxyAllowed, proxyOf, resetInk, sampleAll } from "./render/solidMode";
import { themeStyle } from "./themes";
import "./cards";

/**
 * 渲染面(?stage=1)。编辑器把它放在一个 iframe 里,只下发「现在是时间轴的第几秒」,
 * 由它渲染出那一秒的画面。它自己不按墙上时钟播:时间被 stageClock 接管,
 * 卡片的 Motion 帧循环和 rAF 都由这里显式推进,所以
 *   - 拖播放头到片段中间 = 直接出那一刻的画面(不会从头重播一遍进场动画)
 *   - 播放 = 编辑器每帧下发新的 t,这里推进一帧
 * 和导出视图(?export=1)是同一套办法、同一份卡片代码,预览所见 = 导出所得。
 *
 * **和父页只经 postMessage RPC 说话(E0,见 render/stageRpc.ts),时间一律秒。**
 * 角色(`front` / `back`)是运行时状态(J4):同一份代码,`front` 是可见的播放器舞台,
 * `back` 是探针 / 补跑用的后台舞台。**查询串里的 `id=A` / `id=B` 只是实例名,不是角色**
 * (E1);默认角色是 `front`,父页握手之后立刻用 `setRole` 把两个实例各就各位。
 * `render` 和带 `probe: true` 的 `setTime` 有**角色闸门**:不是 `back` 就回
 * `{ aborted: true, reason: 'role' }`,父页当错误、不重发。
 *
 * 两条路:
 *   - `setTime(t)`:暂停 / 拖动时父页发它。**不重挂载、不递增 playToken**:时钟拨过去、提交 React、
 *     钉动画 —— 任何 dt 都一样(唯一例外:往前且不到半秒,按连续播放同步推几帧)。
 *     stateful 卡往回拖 / 远跳之后的组件状态是错的,第 4 步由快照平面盖住(C3 / C4);
 *     direct 卡、素材层、`data-pc-local-frame`、命中测试都跟着它走。
 *   - `render(t, { jump })`:只给后台舞台(K1 探针):重挂载 + 从挂载帧逐帧推到 t,
 *     Promise 在推完之后才 resolve;被新的 render / setProject 掐掉时按 `superseded` / `project` 回。
 *
 * `?preview=legacy`:保留旧路(setProject 立刻按跳转重算这一帧),给对比和回退用。
 */

const isStageRoute = typeof window !== "undefined" && new URLSearchParams(location.search).has("stage");
const LEGACY = typeof window !== "undefined" && new URLSearchParams(location.search).get("preview") === "legacy";
/**
 * 舞台内容走哪条路(R3)。**`?preview=stage` 由父页写进 iframe 的 src**
 * (`editor/previewMode.ts` 的 `stageSrc`),只有真的开了双舞台的那一次才带。
 *
 * 带了 = 渲 `FrameScene` 的 **live 变体**:素材层在舞台里(E7 第 1 条)、六个平面 prop 生效。
 * 不带(缺省,今天用户手里那份编辑台)= 照旧只渲 `Stage`,一个字都不变。
 */
const LIVE = typeof window !== "undefined" && new URLSearchParams(location.search).get("preview") === "stage";

/** `.pc-awaiting` 的兜底时长(E0):快照没来也要在这之后露出活组件,不能永久隐身 */
const AWAIT_FALLBACK_MS = 500;

/**
 * K4 的节拍按**绝对时刻**排:`nextDue = playStart + n × 1000 / fps`。等到 `nextDue − 这个值`
 * 就开工 —— 真 rAF 的粒度是一个垂直同步(60 Hz 上 16.6 ms),差这一点点不该再多等一整帧。
 */
const BEAT_SLACK_MS = 1;

/**
 * 武装停(`pause({ atSec })`)的兜底(真墙钟,E4b)。武装的那一拍正常情况下几十毫秒就到,
 * 但要是循环因为别的原因卡住了,RPC 不能永不回包 —— 超时按「循环此刻停在哪儿」回。
 */
const ARM_TIMEOUT_MS = 5000;

/** K6 的窗口长度(ms) */
const K6_WINDOW_MS = 1000;

/** 按片段追帧每推这么多步就让出一个宏任务(E4 的调用约定) */
const CATCHUP_YIELD_STEPS = 8;

/** E3:拖动中向后重推节流到每 100 ms 至多一次,其间保持上一状态 */
const SCRUB_REPUSH_MS = 100;
// 时间必须在任何卡片挂载之前接管
const clock = isStageRoute ? installStageClock() : null;
const pinner = createAnimationPinner();

/** 时间差小于这个值(秒)且往前走,当成连续播放,只推进不重挂载 */
const CONTINUOUS_MAX = 0.5;

/** 改参数停手多久之后重算这一帧(毫秒)—— 只在 legacy 路上用 */
const SETTLE_MS = 200;

/** 「这一帧长什么样」只取决于这些;它变了才需要重挂载重跑,改卡片参数不算(legacy 路) */
function layoutKeyOf(p: Project): string {
  const clips = flattenOverlay(p).clips.map((c) => `${c.id}:${c.cardId}:${c.start}:${c.end}`).join("|");
  return `${p.width}x${p.height}#${p.themeId}#${clips}`;
}

/** 真墙钟:接管之后 performance.now 是舞台时间,量耗时要用 stageClock 留下的那份 */
const realNow = () => (window.__pcRealNow ?? (() => Date.now()))();
/** 等浏览器真画一帧(接管之后 requestAnimationFrame 进的是舞台队列) */
const realRaf = () => new Promise<void>((r) => (window.__pcRealRaf ?? window.requestAnimationFrame)(() => r()));
/**
 * **舞台自身的墙钟定时器一律用真实的**(E4b)。`window.setTimeout` 被 `stageClock` 换成了
 * 登记在虚拟时钟上的 fake timer —— 暂停态虚拟时钟不动,用它的话 `.pc-awaiting` 的 500 ms 兜底
 * 一辈子不响、卡片永久隐身;legacy 那条 `SETTLE_MS` 防抖同理会永远不触发。
 * 虚拟定时器的 id 从 1e9 起,所以被接管后的 `clearTimeout` 对真 id 会自己转交回去,直接用即可。
 */
const realSetTimeout = (cb: () => void, ms: number): number =>
  (window.__pcRealSetTimeout ?? window.setTimeout.bind(window))(cb, ms);

const isProjectPatch = (v: unknown): v is ProjectPatch =>
  !!v && typeof v === "object" && (((v as ProjectPatch).kind === "full" && "project" in (v as object)) || ((v as ProjectPatch).kind === "tracks" && "order" in (v as object)));

/**
 * 两份项目之间变了的卡片段(按对象引用比:store 是不可变更新,没动过的 clip 引用不变)。
 * 新增 / 删除的也算变了。只看卡片段:素材段由视频层画,和舞台无关。(legacy 路用)
 */
function changedCardClips(prev: Project | null, next: Project): { id: string; start: number; end: number }[] {
  const before = new Map<string, unknown>();
  if (prev) for (const tr of prev.tracks) for (const c of tr.clips) if (c.cardId) before.set(c.id, c);
  const out: { id: string; start: number; end: number }[] = [];
  const seen = new Set<string>();
  for (const tr of next.tracks) {
    for (const c of tr.clips) {
      if (!c.cardId) continue;
      seen.add(c.id);
      if (before.get(c.id) !== c) out.push({ id: c.id, start: c.start, end: c.end });
    }
  }
  for (const [id, c] of before) if (!seen.has(id)) out.push({ id, start: (c as { start: number }).start, end: (c as { end: number }).end });
  return out;
}

interface PendingRender {
  gen: number;
  startedAt: number;
  frames: () => number;
  resolve: (r: RenderReply) => void;
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
  /** 场景根:带 data-pc-scene 的那个 relative div。实体几何(solid.ts)的一切查询都从它出发 */
  const rootRef = useRef<HTMLDivElement>(null);
  const ref = useRef({
    project: null as Project | null,
    t: 0,
    layoutKey: "",
    settle: 0,
    proxy: false,
    role: "front" as StageRole,
    job: undefined as BackJob | undefined,
    /** K2 的分派表(已回填成 `Set`)+ K1 的每卡记录。查询走下面的 `pipelineOf` */
    plan: null as StagePlan | null,
    /*
     * 下面这几个集合**一律整份替换,不就地改**:`Stage` 靠「上一次 render 的 suppressed 集合」
     * 判「谁刚进入抑制」,就地 mutate 的话它看到的前后两份是同一个对象,永远判不出变化。
     */
    snapshots: new Map<string, string>() as ReadonlyMap<string, string>,
    suppressed: new Set<string>() as ReadonlySet<string>,
    streamPlanes: [] as readonly StreamPlaneGroup[],
    /** 这一帧的快照还没到、先藏着等的片段(E0 的 `setTime({ awaiting })`) */
    awaiting: new Set<string>() as ReadonlySet<string>,
    /** `.pc-awaiting` 的 500 ms 兜底(真定时器:暂停态虚拟时钟不动) */
    awaitTimer: 0,
    /** 正在用子树虚拟时间追帧的片段 → 它此刻的全局舞台毫秒(K5 第一路,R5 才填) */
    settling: new Map<string, number>() as ReadonlyMap<string, number>,
    /** K3:按片段重挂载的代数(空表时 `Stage` 退回整舞台 playToken) */
    remountGen: new Map<string, number>() as ReadonlyMap<string, number>,
    /** 正在跑的按片段追帧(K3(a) / K3(b) / K5 第一路共用一套驱动) */
    catchUps: new Map<string, { clipId: string; stageMs: number; targetMs: number; stepMs: number; announce: boolean; gen: number }>(),
    /** 这个片段上一次的目标帧号(K3(a′):目标帧变小 = 向后跳,要先走重挂载定位配方) */
    lastTargetFrame: new Map<string, number>(),
    /** 这个片段上一次重推的真实时刻(E3:拖动中向后重推节流到每 100 ms 至多一次) */
    repushAt: new Map<string, number>(),
    /** 上一拍活跃的卡(K3(b):播放头**刚进入**哪张卡) */
    lastActive: new Set<string>() as ReadonlySet<string>,
    scrubbing: false,
    playing: false,
    mediaT: 0,
    localHashes: [] as readonly string[],
    /** K4 的节拍循环停着没有(`setRole('back')` / `pause()` 要能停它) */
    beatPaused: true,
    /** 循环真的还在跑(`pause()` 置了 `beatPaused` 之后本拍还要走完) */
    beatRunning: false,
    /** 最后一拍的 `sec`:`pause()` 回包的 `stoppedAt` */
    beatLastSec: 0,
    /** 最后一拍的**帧序号**(武装停按它比,不比浮点) */
    beatLastFrame: -1,
    /** 武装停(`pause({ atSec })`):post 完这一拍就停 */
    beatArmed: null as { frame: number; atSec: number; resolve: (r: PlayReply) => void; timer: number } | null,
    /** 等循环停下来的那些 `pause()` 调用 */
    beatWaiters: [] as ((r: PlayReply) => void)[],
    /** K6 的一秒窗口:每拍的总耗时和每张卡的耗时(都用 `__pcRealNow`) */
    k6: { beats: [] as { at: number; over: number; byClip: Map<string, number> }[], pending: new Set<string>() as ReadonlySet<string> },
    /** 这一拍每张卡的 React 渲染耗时(`<Profiler>` 报的,每拍清空) */
    cardCost: new Map<string, number>(),
    pending: null as PendingRender | null,
  });
  /**
   * 平面状态(快照 / 抑制 / 流 / 等待 / 追帧)改了就敲一下,让这一帧重渲。
   * 真值放在 `ref.current` 里 —— RPC 方法要能**同步**读到最新值,React state 做不到;
   * 而渲染只要一个「变了」的信号,读的仍是 `ref.current`。
   */
  const [, bumpPlanes] = useReducer((n: number) => n + 1, 0);
  /**
   * 第一路追帧的代数(K5):`setRole('back')` 和任何新的 `setTime` / `play` / `setProject`
   * 都递增它,把可见舞台里正在进行的子树追帧中止掉。R5 往里填实现时不用再动这里。
   */
  const catchUpGen = useRef(0);
  /** 落定补拍的代数:又渲了一帧就作废上一次挂着的补拍(见 settle 的说明) */
  const settleGen = useRef(0);
  /** 渲染代数:又来一次渲染 / 换项目就作废上一次还在飞的异步补跑;和 RPC 请求一一对应 */
  const renderGen = useRef(0);
  /**
   * 换了几次项目。两趟布尔探针那一支不走 `abortPending`(它自己 `return`,不是 resolve
   * 挂着的那个 pending),所以要另有一样东西分得清「被 `setProject` 掐的」和「被新 `render`
   * 掐的」—— 两者的重发规矩不一样(E0:`'project'` 重发,`'superseded'` 丢弃)。
   */
  const projectGen = useRef(0);

  /*
   * 卡片图(H3):图卡的输入在这里解。projectCardGraph 对悬空输入会 throw
   * (删片段不清 cardNodes),所以包 try —— 一张坏卡不能让整台舞台卸载。
   * 放在 `if (!project) return null` 之前:hooks 不能条件调用。
   */
  const graph = useMemo(() => {
    if (!project) return undefined;
    try {
      return projectCardGraph(project, getCard);
    } catch {
      return undefined;
    }
  }, [project]);

  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    document.body.style.overflow = "hidden";
    const root = document.getElementById("root");
    if (root) root.style.background = "transparent";
  }, []);

  /**
   * 全局钉动画时要跳过谁(K5 第一路 / E7 第 5 条):正在用子树虚拟时间追帧(`.pc-settling`)
   * 和被抑制(`.pc-suppressed`)的片段,它们的动画不能被全局时钟拨回去。
   * 收的是**包裹层**(`[data-pc-clip]`),`pinner.sync` 对每条动画取目标元素往上最近的那个查表。
   */
  const skipWrappers = useCallback((): ReadonlySet<Element> | undefined => {
    const { settling, suppressed } = ref.current;
    if (!settling.size && !suppressed.size) return undefined;
    const root = rootRef.current;
    if (!root) return undefined;
    const out = new Set<Element>();
    for (const id of [...settling.keys(), ...suppressed]) {
      const el = clipWrapper(root, id);
      if (el) out.add(el);
    }
    return out.size ? out : undefined;
  }, []);

  /**
   * 素材层画出一帧了(K5 第 (4) 步)。**只有 `back` 报**:父页要的是「后台舞台的素材也到位了,
   * 可以互换」这一条;可见舞台在播放时每帧都有新的视频帧,照报就是每秒几十条 postMessage。
   * 父页按 `event.source` 只认当前 `back` 发来的 `mediaReady`,这里再把源头收一道。
   */
  const onMediaFrame = useCallback(() => {
    if (ref.current.role !== "back") return;
    postStageEvent({ type: "mediaReady", sec: ref.current.mediaT });
  }, []);

  /**
   * 这一拍这张卡花了多少毫秒(K6)。`FrameScene` 的 live 路给每个片段套了一个
   * `<Profiler>`,一拍里同一个片段可能提交不止一次,所以是累加;每拍开头清空。
   */
  const onCardCost = useCallback((clipId: string, ms: number) => {
    const cur = ref.current.cardCost;
    cur.set(clipId, (cur.get(clipId) ?? 0) + ms);
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
        pinner.sync(ms, skipWrappers());
      });
    };

    /*
     * 真渲之后采一次墨色(实体模式的色块要用)。
     *
     * 「每次真渲都是一次采样机会」—— 用得越久,实体模式越准:用户改了主色、换了文案,
     * 方块跟着变。播放中是实体模式,不会走到这里,所以不会拖慢播放。
     * 防抖是因为连续拖播放头会一帧一个 setTime,而采样要遍历每张卡的所有元素读 computed style。
     */
    let sampleTimer = 0;
    const scheduleSample = () => {
      if (!proxyAllowed() || ref.current.proxy) return;
      window.clearTimeout(sampleTimer);
      sampleTimer = realSetTimeout(() => {
        const root = rootRef.current;
        if (root && !ref.current.proxy) sampleAll(root);
      }, 120);
    };

    /** 平面状态改了:同步一次 React 提交,让这一帧就带上新的类和平面 */
    const commitPlanes = () => flushSync(() => bumpPlanes());

    /**
     * 应用一次快照增量(A3c):`null` = 摘掉,`reset` = 先清空全部再应用。
     * **整份换一个新 Map**,不就地改 —— `Stage` 按引用判「谁刚变」。
     * 快照到了的片段同时从 `awaiting` 里去掉:`.pc-snapshot` 接管,不用再等兜底。
     * 回的是本次投递的字节数(父页按它判「一次投递 ≤ 2 MB」要不要拆)。
     */
    const applySnapshots = (patch: Record<string, string | null>, reset: boolean): number => {
      const next = new Map(reset ? [] : ref.current.snapshots);
      const arrived: string[] = [];
      let bytes = 0;
      for (const [id, html] of Object.entries(patch)) {
        if (html === null) next.delete(id);
        else {
          next.set(id, html);
          bytes += html.length;
          arrived.push(id);
        }
      }
      ref.current.snapshots = next;
      if (arrived.some((id) => ref.current.awaiting.has(id))) {
        const rest = new Set(ref.current.awaiting);
        for (const id of arrived) rest.delete(id);
        setAwaiting(rest);
      }
      return bytes;
    };

    /**
     * `.pc-awaiting` 的两条退出路(E0,**必有一个**):快照到达(上面那条),
     * 或 **500 ms 兜底**超时后摘掉、改露活组件 —— 宁可露初始态也不能永久隐身:
     * `visibility:hidden` 会让 `solid.ts` 的 `isSolid` 判它不是实体,`hitTest` 点不中、
     * `bounds` 退回整屏框。兜底用**真** `setTimeout`:暂停态虚拟时钟不动,虚拟定时器永远不响。
     */
    const setAwaiting = (ids: Iterable<string>) => {
      ref.current.awaiting = new Set(ids);
      window.clearTimeout(ref.current.awaitTimer);
      ref.current.awaitTimer = 0;
      if (!ref.current.awaiting.size) return;
      ref.current.awaitTimer = realSetTimeout(() => {
        ref.current.awaitTimer = 0;
        if (!ref.current.awaiting.size) return;
        ref.current.awaiting = new Set();
        commitPlanes();
      }, AWAIT_FALLBACK_MS);
    };

    /** 掐掉还在飞的 render:回包按 reason 给,不允许静默丢 */
    const abortPending = (reason: "superseded" | "project") => {
      const p = ref.current.pending;
      if (!p) return;
      ref.current.pending = null;
      p.resolve({ aborted: true, reason, elapsedMs: realNow() - p.startedAt, frames: p.frames() });
    };

    /** 片段的入点(冻结 probe-frame 时算本地帧号用) */
    const clipStart = (clipId: string): number => {
      const p = ref.current.project;
      if (!p) return 0;
      for (const tr of p.tracks) for (const c of tr.clips) if (c.id === clipId) return c.start;
      return 0;
    };

    /**
     * 此刻活跃的卡里最早的那个挂载帧(秒)。
     *
     * **挂载时刻必须落在帧格上** —— 不然「预览所见 = 导出所得」在每个卡片入点都破一次。
     *
     * 导出是一帧一帧推的:一张卡在第一个 ≥ start-LEAD 的**帧**上挂载,时间原点就是那一帧,
     * 而不是 start-LEAD 本身。挂载帧统一由 frameWindow.mjs 的 mountFrameOf 给
     * (预览、导出、分片同一个算式)。夹一下:target 本身不在帧格上时,对齐后可能反超它。
     */
    const mountSecOf = (target: number, fps: number): number => {
      const p = ref.current.project;
      const active = p ? flattenOverlay(p).clips.filter((c) => cardMountedAt(c, target)) : [];
      return active.length
        ? Math.min(Math.min(...active.map((c) => mountFrameOf(c, fps))) / fps, Math.max(0, target))
        : Math.max(0, target);
    };

    /**
     * 重挂载定位:把此刻活跃的卡全部重挂载,时钟拨到它们里最早的挂载帧,空跑两拍。
     * 返回从哪一秒起推。render(jump) 用;legacy 的 setProject 也走它。
     */
    const remountAt = (target: number, fps: number): number => {
      const from = mountSecOf(target, fps);
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
      pinner.sync(from * 1000, skipWrappers());
      return from;
    };

    /**
     * legacy 路的跳转渲染(?preview=legacy):重挂载 + 异步逐帧补跑到 target,不回包。
     * 和第 3 步之前的 renderAt 一样;新路不走它。
     */
    const legacyJump = (target: number) => {
      const p = ref.current.project;
      if (!p) return;
      const fps = Math.max(1, p.fps || 30);
      remountAt(target, fps);
      const gen = ++renderGen.current;
      void (async () => {
        await clock.advanceToAsync(Math.max(0, target) * 1000, {
          step: 1000 / fps,
          abort: () => gen !== renderGen.current,
          onFrame: (ms) => flushSync(() => setT(ms / 1000)),
          afterFrame: (ms) => pinner.sync(ms, skipWrappers()),
        });
        if (gen !== renderGen.current) return;
        flushSync(() => setT(target));
        clock.tick(Math.max(0, target) * 1000);
        pinner.sync(Math.max(0, target) * 1000, skipWrappers());
        settle(target);
        scheduleSample();
      })();
    };

    /* ------------------------------------------ K3 / K5 第一路:按片段的子树虚拟时间追帧 */

    /** 项目里这个片段(入点出点) */
    const clipById = (clipId: string): { id: string; start: number; end: number } | null => {
      const p = ref.current.project;
      if (!p) return null;
      for (const tr of p.tracks) for (const c of tr.clips) if (c.id === clipId) return c;
      return null;
    };

    /** 这张卡的包裹层(`Stage` 挂的 `[data-pc-clip]`) */
    const wrapOf = (clipId: string): Element | null => {
      const root = rootRef.current;
      return root ? clipWrapper(root, clipId) : null;
    };

    /** `settling` 表整份换一个(`Stage` 按引用判「谁刚变」) */
    const setSettlingAt = (clipId: string, stageMs: number | null): void => {
      const next = new Map(ref.current.settling);
      if (stageMs === null) next.delete(clipId);
      else next.set(clipId, stageMs);
      ref.current.settling = next;
    };

    /**
     * **重挂载定位配方**,片段粒度(K3;K3(a′) 向后跳、K3(a) 的重推、K5 第一路的起步都用它)。
     * 一步都不许省:
     *
     *   `resetIn(包裹层)` → 重挂载(`remountGen` 递增)+ `flushSync`
     *   → `clock.tick(clock.now())` **两次** → `pinner.syncIn(包裹层, mountMs)`
     *
     * `tick` 传**当前全局毫秒**、不是 `mountMs`:`tick(ms)` 先 `now = ms` 再排空 rAF 队列,
     * 传 `mountMs` 会把可见舞台的全局时钟拨回挂载帧、settle 结束后没人还原,
     * 下一次 `play` 第一拍要同步补 6000 ms。传当前值时钟不动,只是把队列排空 ——
     * 第一拍跑卡片自己注册的 rAF 把动画建起来,第二拍让 Motion 做第一次推进。
     *
     * 最后钉一次**挂载帧**锚点:`patchAnimate` 让新动画出生即 `pause()` + `currentTime = 0`,
     * 少了这一次锚点会记成目标毫秒、画面停在第 0 帧。
     *
     * **配方到钉挂载帧锚点为止**,之后怎么走由调用方定。
     */
    const remountClipRecipe = (clipId: string, mountMs: number): Element | null => {
      const before = wrapOf(clipId);
      if (before) pinner.resetIn(before);
      // 组件这一次要按**挂载帧**渲(`Stage` 的 `localTOf` 读 `settling`),所以先写表再提交
      setSettlingAt(clipId, mountMs);
      const next = new Map(ref.current.remountGen);
      next.set(clipId, (next.get(clipId) ?? 0) + 1);
      ref.current.remountGen = next;
      flushSync(() => bumpPlanes());
      clock.tick(clock.now());
      clock.tick(clock.now());
      const after = wrapOf(clipId);
      if (after) pinner.syncIn(after, mountMs);
      return after;
    };

    /** 一次按片段的追帧 */
    interface CatchUpTask {
      clipId: string;
      /** 已经推到的全局舞台毫秒 */
      stageMs: number;
      targetMs: number;
      stepMs: number;
      /** 追上之后 post `{ type: 'settled', clipIds: [clipId] }`(K5 第一路 / 重卡才要) */
      announce: boolean;
      gen: number;
    }

    /** 追帧被中止 / 追完:摘 `.pc-settling`,**把该片段留在 `snapshots` 里**(平面还挂着,不闪) */
    const endCatchUp = (task: CatchUpTask, caughtUp: boolean): void => {
      ref.current.catchUps.delete(task.clipId);
      setSettlingAt(task.clipId, null);
      if (caughtUp && task.announce) {
        // 舞台自己摘掉这张卡的快照平面;父页收到 `settled` 把 clipId 从投递基线里删掉(A3c)
        const rest = new Map(ref.current.snapshots);
        rest.delete(task.clipId);
        ref.current.snapshots = rest;
      }
      commitPlanes();
      if (caughtUp && task.announce) postStageEvent({ type: "settled", sec: ref.current.t, clipIds: [task.clipId] });
    };

    /**
     * 往前推几步。**只推它子树的本地时间**:每步 `stageMs += 1000 / fps`,
     * `pinner.syncIn(包裹层, stageMs)` + 给该组件 `t = stageMs / 1000`(`settling` 表)+ `flushSync`。
     * **全局时钟不动**,全局的 `pinner.sync(nowMs, skip)` 跳过 `.pc-settling` 子树(`skipWrappers`)。
     *
     * 回 `true` 表示追上了(或被中止),调用方该收摊。
     */
    const advanceCatchUp = (task: CatchUpTask, steps: number): boolean => {
      if (task.gen !== catchUpGen.current) {
        endCatchUp(task, false);
        return true;
      }
      const wrap = wrapOf(task.clipId);
      for (let i = 0; i < steps && task.stageMs < task.targetMs; i++) {
        task.stageMs = Math.min(task.targetMs, task.stageMs + task.stepMs);
        if (wrap) pinner.syncIn(wrap, task.stageMs);
        setSettlingAt(task.clipId, task.stageMs);
        flushSync(() => bumpPlanes());
      }
      if (task.stageMs < task.targetMs) return false;
      /*
       * 追到目标那一步:锚点本来就在全局基上,交回全局 `pinner.sync` 天然连续,
       * 不需要额外动作 —— 摘了 `.pc-settling` 它就是精确的活组件。
       */
      endCatchUp(task, true);
      return true;
    };

    /**
     * 一路推到底,**每 8 步让出一个宏任务**(E4;让出点检查 `catchUpGen`)。
     * K3(b) 的跳转 / 拖动、K5 第一路的暂停态追帧走它。
     */
    const runCatchUpAsync = async (task: CatchUpTask): Promise<void> => {
      const breathe = () => new Promise<void>((r) => realSetTimeout(r, 0));
      for (;;) {
        if (advanceCatchUp(task, CATCHUP_YIELD_STEPS)) return;
        await breathe();
      }
    };

    /**
     * 一拍内推完(K3(a)):帧间**只让微任务**、不让宏任务 —— 微任务之间浏览器不绘制,
     * 所以中间态一帧都画不出来。`catchUpMs` 是估计值,所以带**墙钟兜底**:
     * 累计超过 `1000 / fps` 还没推完就改走 (b)(K3:不让主线程被估错的卡长时间占住)。
     */
    const runCatchUpSync = async (task: CatchUpTask, budgetMs: number): Promise<void> => {
      const started = realNow();
      for (;;) {
        if (advanceCatchUp(task, 1)) return;
        if (realNow() - started > budgetMs) {
          // 改走 (b):后面的步数每 8 步让一个宏任务,画面继续被 `.pc-settling` 藏着
          void runCatchUpAsync(task);
          return;
        }
        await Promise.resolve();
      }
    };

    /** 登记一个追帧任务:先走重挂载定位配方,再从挂载帧逐步推 */
    const startCatchUp = (clipId: string, targetMs: number, fps: number, announce: boolean): CatchUpTask | null => {
      const clip = clipById(clipId);
      if (!clip) return null;
      const mountMs = (mountFrameOf(clip, fps) / fps) * 1000;
      if (mountMs >= targetMs) return null;
      const old = ref.current.catchUps.get(clipId);
      if (old) endCatchUp(old, false);
      remountClipRecipe(clipId, mountMs);
      const task: CatchUpTask = { clipId, stageMs: mountMs, targetMs, stepMs: 1000 / fps, announce, gen: catchUpGen.current };
      ref.current.catchUps.set(clipId, task);
      return task;
    };

    /** 全部中止(新的 `setTime` / `play` / `setProject` / `setRole` / `setSuppressed` 都走它) */
    const abortCatchUps = (): void => {
      if (!ref.current.catchUps.size) return;
      for (const task of [...ref.current.catchUps.values()]) endCatchUp(task, false);
    };

    /**
     * K4 每一拍多推几步(K3(b) 的播放态追帧):每拍除本拍那一帧外最多再多推
     * `CATCHUP_STEPS_PER_BEAT` 步本地时间(即最快 5 倍速)。每拍的追帧成本按实测计入
     * K6 的一秒窗口 —— 追帧把窗口顶爆就由 K6 降最贵的那张。
     */
    const stepCatchUps = (fps: number): void => {
      if (!ref.current.catchUps.size) return;
      const nowMs = ref.current.t * 1000;
      for (const task of [...ref.current.catchUps.values()]) {
        // 播放中目标跟着播放头走:不然追上的那一刻它已经落后了
        task.targetMs = Math.max(task.targetMs, nowMs);
        task.stepMs = 1000 / fps;
        advanceCatchUp(task, CATCHUP_STEPS_PER_BEAT);
      }
    };

    /* ------------------------------------------------ K3:三条跳转路 */

    /** 这一刻活跃的**卡**片段(口径同 `Stage`:含 LEAD) */
    const cardClipsAt = (sec: number): { id: string; start: number; end: number }[] => {
      const p = ref.current.project;
      if (!p) return [];
      return flattenOverlay(p).clips
        .filter((c) => (c as { cardId?: string; nodeId?: string }).cardId || (c as { nodeId?: string }).nodeId)
        .filter((c) => cardMountedAt(c, sec));
    };

    const mountMsOf = (clip: { start: number; end: number }, fps: number): number => (mountFrameOf(clip, fps) / fps) * 1000;

    /**
     * 这张卡走哪一档 —— 用的是 K2 的 `clipWeight`,**和父页、预渲染进程同一份纯函数**
     * (`tuning` 随 `setPlan` 一起下来,两边系数一致)。
     * `tier`: `direct` / `seek`(a′) / `catchup-a`(a) / `catchup-b`(b) / `capped` / `over-catchup` / 声明兜底。
     */
    const tierOf = (clipId: string, fps: number) => {
      const sp = ref.current.plan;
      const record = sp?.byClip.get(clipId);
      return { tier: clipWeight(record, sp?.frameModes.get(clipId), fps, sp?.tuning).tier as string, record };
    };

    /** 拖动中向后重推的节流(E3):这张卡刚推过就保持上一状态 */
    const repushAllowed = (clipId: string, now: number): boolean => {
      if (!ref.current.scrubbing) return true;
      const last = ref.current.repushAt.get(clipId);
      if (last !== undefined && now - last < SCRUB_REPUSH_MS) return false;
      ref.current.repushAt.set(clipId, now);
      return true;
    };

    /**
     * K5 第一路的起步:`setTime(t, { settle: true })` 之后,`vtOk` 的**重卡**在可见舞台里
     * 用子树虚拟时间追到精确活渲。`vtOk = false` 的由父页走第二路(整场景在后台补跑后互换),
     * 舞台这边什么都不做。
     */
    const routeSettle = (target: number, fps: number): void => {
      const plan = ref.current.plan?.plan ?? null;
      for (const clip of cardClipsAt(target)) {
        if (pipelineAt(plan, clip.id, target) !== "heavy") continue;
        const { record } = tierOf(clip.id, fps);
        if (record?.vtOk !== true) continue;
        const task = startCatchUp(clip.id, target * 1000, fps, true);
        if (task) void runCatchUpAsync(task);
      }
    };

    /**
     * K3 的三条跳转路(远跳 / 向后那一支;向前且 `dt < CONTINUOUS_MAX` 的连续路在 `setTime` 里
     * 已经由全局 `advanceTo` 走完了)。**可见舞台里永远看不到推帧过程。**
     *
     * - **(a′) `seekOk` 且 `seekMs ≤ B`**:直接定位。向前不用做什么(全局 `pinner.sync` 已经钉过);
     *   **向后**要先走重挂载定位配方 —— 越过结尾的动画被 `finish()` 收了、此后永久跳过,
     *   不重挂载就停在终态。
     * - **(a) `catchUpMs ≤ B`**:按片段重挂载 + 从 `mountFrameOf` 逐帧推,帧间**只让微任务**
     *   (中间态一帧都画不出来),带墙钟兜底,超了改走 (b)。
     * - **(b)**:`vtOk` 的在可见舞台里用子树虚拟时间追(每 8 步让宏任务,追上摘 `.pc-settling`);
     *   `vtOk = false` 的走 K5 第二路(父页的事)。
     */
    const routeJump = (target: number, fps: number): void => {
      const targetMs = target * 1000;
      const targetFrame = Math.round(target * fps);
      const now = realNow();
      const plan = ref.current.plan?.plan ?? null;
      for (const clip of cardClipsAt(target)) {
        const prevFrame = ref.current.lastTargetFrame.get(clip.id);
        const backwards = prevFrame !== undefined && targetFrame < prevFrame;
        ref.current.lastTargetFrame.set(clip.id, targetFrame);
        // 重卡在跳转里贴快照,追到活渲是 `settle` 的事(routeSettle)
        if (pipelineAt(plan, clip.id, target) === "heavy") continue;
        const { tier, record } = tierOf(clip.id, fps);
        if (tier === "direct" || tier === "declared-light") continue;   // 随机访问:跟着 setTime 走
        if (tier === "seek") {
          if (!backwards) continue;
          if (!repushAllowed(clip.id, now)) continue;
          const wrap = remountClipRecipe(clip.id, mountMsOf(clip, fps));
          // 一步到位:钉目标毫秒,组件 `t` 交回全局(把它从 `settling` 里拿掉)
          setSettlingAt(clip.id, null);
          if (wrap) pinner.syncIn(wrap, targetMs);
          commitPlanes();
          continue;
        }
        if (tier === "catchup-a") {
          if (!repushAllowed(clip.id, now)) continue;
          const task = startCatchUp(clip.id, targetMs, fps, false);
          if (task) void runCatchUpSync(task, 1000 / fps);
          continue;
        }
        if (tier === "catchup-b") {
          if (record?.vtOk !== true) continue;   // 第二路由父页发起
          if (!repushAllowed(clip.id, now)) continue;
          const task = startCatchUp(clip.id, targetMs, fps, false);
          if (task) void runCatchUpAsync(task);
        }
      }
    };

    /**
     * 播放头**刚进入**一张 (b) 档 `vtOk` 轻卡:让它从 `mountFrameOf` 起追(K3(b))。
     * 追上之前这一层透明 —— 轻卡没有快照平面,`.pc-settling` 是 `visibility: hidden`。
     */
    const enterCatchUps = (sec: number, fps: number): void => {
      const plan = ref.current.plan?.plan ?? null;
      const active = new Set<string>();
      for (const clip of cardClipsAt(sec)) {
        active.add(clip.id);
        if (ref.current.lastActive.has(clip.id)) continue;
        if (ref.current.catchUps.has(clip.id)) continue;
        if (pipelineAt(plan, clip.id, sec) !== "light") continue;
        const { tier, record } = tierOf(clip.id, fps);
        if (tier !== "catchup-b" || record?.vtOk !== true) continue;
        startCatchUp(clip.id, sec * 1000, fps, false);
      }
      ref.current.lastActive = active;
    };

    /* ------------------------------------------------ K1 的两趟布尔探针(vtOk / seekOk / seekMs) */

    /**
     * 这一张卡的包裹层(`Stage.tsx` 挂的 `[data-pc-clip]`)。
     *
     * 探针**只在缩水项目上跑**(K1:一条轨道一个 clip),所以舞台里恰好一棵卡片子树,
     * 第一个匹配就是最外层那个包裹层 —— 组合卡的部件包裹层嵌在它里面,
     * `getAnimations({ subtree: true })` 一并覆盖。`:not([data-pc-media])` 排掉素材层
     * (`FrameScene` 的素材层也带 `data-pc-clip`)。
     */
    const probeWrap = (): Element | null =>
      rootRef.current?.querySelector("[data-pc-clip]:not([data-pc-media])") ?? null;

    /**
     * **K3 的「重挂载定位配方」,片段粒度**(K1 的两趟布尔探针复位用;K3(a′) 向后跳、
     * K5 第一路起步是 R5 的事,用的是同一段)。一步都不许省:
     *
     *   `resetIn(包裹层)` → 重挂载(`remountGen` / 这里是 `playToken`)
     *   → `clock.tick(clock.now())` **两次** → `pinner.syncIn(包裹层, mountMs)`
     *
     * 为什么要复位:计时趟已经把这张卡推到了片段最后一帧,越过结尾的动画被
     * `pinAnimations` 的 `finish()` 收了、此后永久跳过 —— 不复位就是在终态实例上比对,
     * 两个布尔必然记 `false`。
     *
     * 为什么 `tick` 传 `clock.now()` 而不是 `mountMs`:`tick(ms)` 先 `now = ms` 再排空 rAF 队列,
     * 传别的值等于把全局时钟拨走。这里上一行刚 `clock.set(mountMs)`,两者正好相等,
     * 写成 `clock.now()` 是为了和 K3 里「当前全局毫秒」那条统一。
     *
     * 为什么最后要钉一次挂载帧锚点:`patchAnimate` 让新动画出生即 `pause()` + `currentTime = 0`,
     * 少了这一次,锚点会记成第一次 `syncIn` 的目标毫秒,画面停在第 0 帧。
     */
    const remountClipAt = (mountSec: number): Element | null => {
      const before = probeWrap();
      // 探针的缩水项目里只有这一张卡,没有包裹层(还没挂上)时退回整份重建
      if (before) pinner.resetIn(before);
      else pinner.reset();
      clock.set(mountSec * 1000);
      flushSync(() => {
        setToken((n) => n + 1);
        setT(mountSec);
      });
      clock.tick(clock.now());
      clock.tick(clock.now());
      const after = probeWrap();
      if (after) pinner.syncIn(after, mountSec * 1000);
      return after;
    };

    /**
     * 此刻这张卡的控件 HTML(比对的那一份)。`lossy > 0` 时回 null ——
     * WebGL 画布读不出像素、两趟都是空画布,比对没有意义,K1 明写这时两个布尔一律记 `false`。
     * 组合卡有多个控件,按文档序拼起来一起比(两趟序列化的是同一棵树,顺序一致)。
     * 分隔符用一条 HTML 注释:`compareSnapshotHtml` 的词法分析把它当一个 comment 记号逐字比,
     * 两边都有、位置一样,不会影响判定;比用不可打印字符省心(源码里留不可打印字符会让
     * git 把整个文件当二进制,而 R3 正在同时改这个文件)。
     */
    const probeControlHtml = (): string | null => {
      const root = rootRef.current;
      if (!root) return null;
      const snap = createSnapshot(root);
      if (snap.lossy > 0) return null;
      return snap.controls.map((c) => c.html).join("<!--pc-next-control-->");
    };

    /**
     * 两趟布尔探针(K1 / pinned 划分轴一「如何区分 SeekOK」)。四趟,各自先走复位配方:
     *
     *   1. **基线趟**:全局时钟从挂载帧逐帧推 8 帧,第 8 帧的控件 HTML 留在**内存里**
     *      (K1:不依赖父页回传)。推法和计时 / 快照趟逐字一致 —— 同一个 `advanceToAsync`、
     *      同一组 `onFrame` / `afterFrame`,否则比的就不是同一件事了。
     *   2. **`vtOk` 趟**:**不动全局时钟**,只 `pinner.syncIn(包裹层, 该帧的全局舞台毫秒)`
     *      + 给组件本地 `t`,推 8 帧。全局 rAF 队列没人排空,读全局帧循环时间戳的
     *      Motion JS 动画因此推不动 —— 这正是 `vtOk = false` 要抓的那一类。
     *      帧间同样只让微任务(和基线趟的 `advanceToAsync` 一致),不多让也不少让。
     *   3. **`seekOk` 趟**:一步钉到第 8 帧(不经 1～7 帧),再比。
     *   4. **`seekMs`**:从第 0 帧直接钉到片段最后一帧,`__pcRealNow` 量这一次的墙钟。
     *
     * 「给组件本地 `t`」在这里就是 `setT` —— 缩水项目里只有这一张卡,舞台的全局 `t` 就是它的
     * 本地时间基。R5 要在整份项目上对**单张**卡做同样的事时才需要 `Stage` 的 `settling` prop
     * (K5 第一路),探针不需要,所以这一步不碰 `Stage.tsx`。
     *
     * 各趟 `PROBE_BOOL_FRAMES` 帧或 `PROBE_BOOL_MS` 毫秒封顶;比对趟超了记 `false`,
     * 量 `seekMs` 那一趟超了记 `null`。**生成的快照一律不 post `probe-frame`**(K1)。
     */
    const runBooleanProbe = async (lastSec: number, fps: number, gen: number): Promise<{ booleans?: ProbeBooleans; aborted?: true }> => {
      const step = 1000 / fps;
      const mountSec = mountSecOf(lastSec, fps);
      const mountMs = mountSec * 1000;
      const frames = PROBE_BOOL_FRAMES;
      const stale = () => gen !== renderGen.current;
      /** 帧间让出一个宏任务:让父页的 RPC 消息、iframe 自己的 resize 有机会进来(趟与趟之间用) */
      const breathe = () => new Promise<void>((r) => (window.__pcRealSetTimeout ?? window.setTimeout)(r, 0));

      /* ---- 1. 基线趟:全局时钟推 8 帧 ---- */
      remountClipAt(mountSec);
      let pushed = 0;
      const baseStarted = realNow();
      await clock.advanceToAsync(mountMs + frames * step, {
        step,
        maxCatchUp: Infinity,
        abort: () => stale() || pushed >= frames || realNow() - baseStarted > PROBE_BOOL_MS,
        onFrame: (ms) => flushSync(() => setT(ms / 1000)),
        afterFrame: (ms) => {
          pinner.sync(ms);
          pushed++;
        },
      });
      if (stale()) return { aborted: true };
      // 第 8 帧之前就被截断的卡没有基线,两个布尔一律记 false、不比对(K1)
      const baseline = pushed >= frames ? probeControlHtml() : null;

      /* ---- 2. vtOk 趟:只推子树虚拟时间 ---- */
      await breathe();
      if (stale()) return { aborted: true };
      let vtHtml: string | null = null;
      if (baseline !== null) {
        const wrap = remountClipAt(mountSec);
        const vtStarted = realNow();
        let done = 0;
        for (let k = 1; k <= frames; k++) {
          // 和基线趟的 advanceToAsync 一样:帧间只让微任务(Motion 解析关键帧要一个边界)
          await Promise.resolve();
          if (stale()) return { aborted: true };
          if (realNow() - vtStarted > PROBE_BOOL_MS) break;
          const ms = mountMs + k * step;
          if (wrap) pinner.syncIn(wrap, ms);
          flushSync(() => setT(ms / 1000));
          done++;
        }
        if (done >= frames) vtHtml = probeControlHtml();
      }
      const vtOk = baseline !== null && vtHtml !== null && compareSnapshotHtml(baseline, vtHtml).same;

      /* ---- 3. seekOk 趟:一步钉到第 8 帧 ---- */
      await breathe();
      if (stale()) return { aborted: true };
      let seekHtml: string | null = null;
      if (baseline !== null) {
        const wrap = remountClipAt(mountSec);
        const seekStarted = realNow();
        const ms = mountMs + frames * step;
        if (wrap) pinner.syncIn(wrap, ms);
        flushSync(() => setT(ms / 1000));
        if (realNow() - seekStarted <= PROBE_BOOL_MS) seekHtml = probeControlHtml();
      }
      const seekOk = baseline !== null && seekHtml !== null && compareSnapshotHtml(baseline, seekHtml).same;

      /* ---- 4. seekMs:第 0 帧直接钉到最后一帧的墙钟 ---- */
      await breathe();
      if (stale()) return { aborted: true };
      const wrap = remountClipAt(mountSec);
      const lastMs = Math.max(mountMs, lastSec * 1000);
      const seekStarted = realNow();
      if (wrap) pinner.syncIn(wrap, lastMs);
      flushSync(() => setT(lastMs / 1000));
      const elapsed = realNow() - seekStarted;
      ref.current.t = lastMs / 1000;

      return { booleans: { vtOk, seekOk, seekMs: elapsed > PROBE_BOOL_MS ? null : elapsed } };
    };

    /* ------------------------------------------------------------------ K4 节拍器 */

    /**
     * K6 自动再平衡(**只降不升**)。任一 1 秒窗口内累计超时(每拍耗时超出 1/fps 的部分之和)
     * > 1/fps,就把本窗口**实测**累计耗时最大的那张轻卡降级:post `{ type: 'demote', clipId }`,
     * 父页查旧记录整条 PUT `{ ...旧记录, capped: true, demoted: true }`。
     *
     * 「最贵」按实测算、不按探针的 `stepMs`(pinned 渲染 6)。
     *
     * **`pendingDemote` 的卡不计入窗口、也不当候选**:死素材就绪之前它照常活渲(用户看到的
     * 画面不变),它这一拍的耗时照记诊断 —— 但再让它参与判定的话,它会继续把窗口顶爆,
     * 每秒再降一张,直到轻管线为空。就绪后父页把它切进 `suppressed`,那时才从集合里移出。
     */
    const checkDemote = (fps: number, sec: number): void => {
      const beats = ref.current.k6.beats;
      if (beats.length < 2) return;
      let over = 0;
      for (const b of beats) over += b.over;
      if (over <= 1000 / fps) return;
      const pending = ref.current.k6.pending;
      const plan = ref.current.plan?.plan ?? null;
      const total = new Map<string, number>();
      for (const b of beats) {
        for (const [id, ms] of b.byClip) {
          if (pending.has(id)) continue;
          // 只降轻卡:重卡本来就在贴死素材,降它没有意义
          if (pipelineAt(plan, id, sec) !== "light") continue;
          total.set(id, (total.get(id) ?? 0) + ms);
        }
      }
      let worst: string | null = null;
      let worstMs = 0;
      // 同分时按 clipId 定序,免得两次跑降到不同的卡上
      for (const id of [...total.keys()].sort()) {
        const ms = total.get(id)!;
        if (ms > worstMs) { worst = id; worstMs = ms; }
      }
      if (!worst) return;
      ref.current.k6.pending = new Set([...pending, worst]);
      // 窗口清零:下一张要重新攒够超时才降,不然一秒之内会连降好几张
      ref.current.k6.beats = [];
      postStageEvent({ type: "demote", clipId: worst });
    };

    /**
     * 这一拍的账(K6 的一秒窗口)。**超时**只算每拍耗时超出 1/fps 的那一部分;
     * 每张卡的耗时来自 `<Profiler>`(`FrameScene` 的 live 路每个片段一个,E7),
     * 每拍清空一次。窗口只留最近 `K6_WINDOW_MS` 毫秒。
     *
     * 降级的判定在 `checkDemote`(K6),这里只记账 —— 记账本身是节拍的一部分。
     */
    const noteBeat = (beatCost: number, fps: number, sec: number): void => {
      const at = realNow();
      const byClip = new Map(ref.current.cardCost);
      /*
       * **`pendingDemote` 的卡这一拍的耗时不计入窗口**(K6)。只把它从「谁最贵」的候选里
       * 摘掉是不够的 —— 它照常活渲、照常把这一拍拖到 60 ms,窗口还是每秒都爆,
       * 于是每秒再降一张,直到轻管线为空(实测:两张卡的项目里第二张也被降了)。
       * 所以连**它那一份耗时**一起从这一拍的超时里扣掉。
       */
      let excused = 0;
      for (const id of ref.current.k6.pending) excused += byClip.get(id) ?? 0;
      const over = Math.max(0, beatCost - excused - 1000 / fps);
      const beats = ref.current.k6.beats;
      beats.push({ at, over, byClip });
      while (beats.length && at - beats[0].at > K6_WINDOW_MS) beats.shift();
      checkDemote(fps, sec);
    };

    /**
     * 停下节拍循环,并把等着的 `pause()` 回包落定。
     *
     * **三处入口**:`pause()`(立即停)、武装停到达、`setRole('back')` / 播放到头。
     * 不管从哪儿来,挂着的 RPC 都必须回包 —— 循环停了没人再去 resolve 它们。
     */
    const settleBeatWaiters = (): void => {
      const armed = ref.current.beatArmed;
      const waiters = ref.current.beatWaiters;
      ref.current.beatArmed = null;
      ref.current.beatWaiters = [];
      const stoppedAt = ref.current.beatLastSec;
      if (armed) {
        window.clearTimeout(armed.timer);
        armed.resolve({ ok: true, stoppedAt });
      }
      for (const resolve of waiters) resolve({ ok: true, stoppedAt });
    };

    /** 停循环(`setRole('back')`、`pause()`、播放到头都走它) */
    const stopBeat = (): void => {
      ref.current.beatPaused = true;
      if (!ref.current.beatRunning) settleBeatWaiters();
    };

    /**
     * 节拍循环(K4)。**只有 `front` 跑**,每拍:
     *
     *   `t += 1 / fps` → `clock.advanceTo(t × 1000, { step: 1000 / fps })` 推轻卡并提交
     *   → 贴平面(平面状态在 `ref` 里,和 `setT` 同一次提交) → 等**真实**一帧
     *   → 补一拍落定(`clock.tick` + `pinner.sync`,让 Motion 把新值写回 DOM)
     *   → post `{ type: 'frame', sec }` → 下一拍。
     *
     * **节拍按绝对时刻排**:`nextDue = playStart + n × 1000 / fps`(`__pcRealNow`),
     * 一拍的活干完之后 `await __pcRealRaf()` 直到 `__pcRealNow() ≥ nextDue − 1 ms`。
     * 60 Hz 屏上一次 rAF 只有 16.6 ms,30 fps 等一次等不满一拍,所以是个循环;
     * 24 / 25 fps 自然落成 2 / 3 帧交替,均值仍是 1000 / fps。
     *
     * **慢帧就等**:只有**这一拍的活本身**超过了 `nextDue` 才把时间轴整体后移
     * (`playStart += 超出量`),不补、不跳帧、不往前冲 —— 所以连续两条 `frame` 的
     * `sec` 差恒为 1/fps。等 rAF 那一下的粒度溢出**不后移**:每拍都后移一点的话,
     * 30 fps 以外的帧率会被一路推成「每拍整数个垂直同步」,均值就不是 1000/fps 了。
     */
    const runBeatLoop = async (fromSec: number): Promise<void> => {
      const p = ref.current.project;
      if (!p) return;
      const fps = Math.max(1, p.fps || 30);
      const period = 1000 / fps;
      const duration = Math.max(0, Number(p.duration) || 0);
      // 拍序号按帧格算,`sec` 一律是 `帧号 / fps` —— 连续累加浮点会飘
      const fromFrame = Math.round(fromSec * fps);
      let playStart = realNow();
      ref.current.beatRunning = true;
      try {
        for (let n = 1; ; n++) {
          // 每拍开头查 `paused` / 角色(E0)
          if (ref.current.beatPaused || ref.current.role !== "front") break;
          const rawSec = (fromFrame + n) / fps;
          const ended = rawSec >= duration - 1e-9;
          const sec = ended ? duration : rawSec;
          const beatStarted = realNow();

          /* ---- 一拍的活 ---- */
          ref.current.t = sec;
          ref.current.cardCost.clear();
          flushSync(() => setT(sec));
          clock.advanceTo(sec * 1000, { step: period, onFrame: (ms) => pinner.sync(ms, skipWrappers()) });
          // K3(b) 的播放态追帧:这一拍除了本拍那一帧,再多推几步它自己的本地时间
          enterCatchUps(sec, fps);
          stepCatchUps(fps);
          await realRaf();
          /*
           * 补一拍落定。`settle()` 排的是微任务,而这里本来就在 `await` 之后 ——
           * 直接同步做完即可,顺手作废还挂着的那一次(又渲了一帧,上一次补拍不作数)。
           */
          settleGen.current++;
          clock.tick(sec * 1000);
          pinner.sync(sec * 1000, skipWrappers());
          const beatCost = realNow() - beatStarted;

          // post `frame` 之前再查一次角色(E0):互换那一拍新 `back` 不能还在报
          if (ref.current.role !== "front") break;
          ref.current.beatLastSec = sec;
          ref.current.beatLastFrame = fromFrame + n;
          if (ended) {
            postStageEvent({ type: "ended", sec: duration });
            break;
          }
          postStageEvent({ type: "frame", sec });
          noteBeat(beatCost, fps, sec);

          // 武装停(E0):post 完 `frame(atSec)` 那一拍就停在那一帧,平面不摘
          const armed = ref.current.beatArmed;
          if (armed && ref.current.beatLastFrame >= armed.frame) break;

          /* ---- 等到下一拍的绝对时刻 ---- */
          const nextDue = playStart + n * period;
          const workEnd = realNow();
          if (workEnd > nextDue) {
            playStart += workEnd - nextDue;
          } else {
            while (realNow() < nextDue - BEAT_SLACK_MS) {
              await realRaf();
              if (ref.current.beatPaused || ref.current.role !== "front") break;
            }
          }
        }
      } finally {
        ref.current.beatRunning = false;
        ref.current.beatPaused = true;
        settleBeatWaiters();
      }
    };

    const api: StageRpcApi = {
      /**
       * 换项目文档。patch 复用 A7 的 changedClips 结构,合并时**保持未变片段的对象引用**
       * (applyProjectPatch 就是这么做的);full 带 reset。
       * 两种角色都**不再**按跳转重算这一帧:front 只更新项目(第 4 步 D5 接「按 changedClips
       * 让变了的层重新查索引」);back 在飞的探针推帧被掐断后回 { aborted, reason: 'project' }。
       */
      async setProject(next, opts = {}) {
        const prev = ref.current.project;
        let full: Project;
        if (isProjectPatch(next)) {
          if (next.kind === "full") full = next.project;
          else {
            if (!prev) throw new Error("setProject: 收到增量补丁但舞台上还没有项目(先发一份 full)");
            full = applyProjectPatch(prev, next);
          }
        } else {
          full = next;
        }
        if (opts.reset || full !== prev) {
          // clipId 会在不同项目里复用,不清掉就会张冠李戴
          if (full !== prev) resetInk();
        }
        const prevKey = ref.current.layoutKey;
        const nextKey = layoutKeyOf(full);
        ref.current.project = full;
        ref.current.layoutKey = nextKey;
        flushSync(() => setProject(full));
        window.clearTimeout(ref.current.settle);
        // 项目变了,在飞的补跑作废:探针会按新项目重发
        renderGen.current++;
        projectGen.current++;
        abortPending("project");
        // 换项目同样中止第一路追帧(K5:五个 RPC 各递增一次)
        catchUpGen.current++;
        abortCatchUps();
        if (LEGACY) {
          if (prevKey !== nextKey) {
            legacyJump(ref.current.t);
          } else {
            const changed = changedCardClips(prev, full);
            const tt = ref.current.t;
            if (changed.length && changed.some((c) => cardMountedAt(c, tt))) {
              ref.current.settle = realSetTimeout(() => legacyJump(ref.current.t), SETTLE_MS);
            }
          }
        }
        return { ok: true as const };
      },

      /**
       * 拨到 tSec(暂停 / 拖动的唯一入口)。独立路径,不复用 render:
       *   clock.set → flushSync(setT) → pinner.sync → settle。不递增 playToken,组件实例不变。
       * 唯一例外:往前且不到 CONTINUOUS_MAX 秒,按连续播放用 advanceTo 同步推几帧(≤ 30 步)。
       * 远跳或向后一律不 advanceTo(会同步空转几百次 tick)。
       * probe: 一律走跳转路径(量的必须是单帧),等一次真 rAF、冻一次控件 HTML,回包带 elapsedMs。
       *
       * **`snapshots` / `awaiting` 和 `t` 在同一次 React 提交里生效**(E0):拖过一张 stateful 卡的
       * 入点时,新挂载的组件和它的快照平面同帧出现,不闪初始态。所以这两样在 `flushSync(setT)`
       * **之前**写进 `ref.current` —— 渲染读的就是它。`settle` 是 K5 的暂停态活渲(R5)。
       */
      async setTime(tSec, opts = {}) {
        /*
         * 角色闸门(E1)。带 `probe: true` 的这一支量的是 K1 的成绩,只有后台舞台能接 ——
         * 可见舞台正在给用户播画面,在它上面跑探针既量不准(要和用户的交互抢主线程),
         * 又会把画面拨到探针的时刻去。不带 `probe` 的 `setTime` 两种角色都收
         * (拖动发给 `front`、D4 的页面侧测量发给 `back`),所以闸门只挡 `probe`。
         */
        if (opts.probe && ref.current.role !== "back") return { aborted: true, reason: "role" as const };
        const target = Math.max(0, Number(tSec) || 0);
        const started = realNow();
        const p = ref.current.project;
        const prev = ref.current.t;
        const dt = target - prev;
        ref.current.t = target;
        if (opts.snapshots) applySnapshots(opts.snapshots, false);
        // 本次要加 `.pc-awaiting` 的片段由父页点名(E0:两个判据只有父页知道)
        setAwaiting(opts.awaiting ?? []);
        if (!p) return { path: "set" } satisfies SetTimeReply;
        // 暂停 / 拖动时来了 setTime,就没有「还在飞的补跑」这回事了
        renderGen.current++;
        abortPending("superseded");
        // 新的 setTime 中止正在进行的第一路追帧(K5:五个 RPC 各递增一次)
        catchUpGen.current++;
        abortCatchUps();
        const fps = Math.max(1, p.fps || 30);

        if (!opts.probe && dt >= 0 && dt < CONTINUOUS_MAX) {
          // 连续播放:接着往下跑一两帧就行(≤ 30 步,同步)。轻卡跟着全局时钟走,K3 不用再分路
          flushSync(() => setT(target));
          clock.advanceTo(target * 1000, { step: 1000 / fps, maxCatchUp: CONTINUOUS_MAX * 1000, onFrame: (ms) => pinner.sync(ms, skipWrappers()) });
          for (const clip of cardClipsAt(target)) ref.current.lastTargetFrame.set(clip.id, Math.round(target * fps));
          settle(target);
          scheduleSample();
          if (opts.settle) routeSettle(target, fps);
          return { path: "continuous" } satisfies SetTimeReply;
        }

        clock.set(target * 1000);
        flushSync(() => setT(target));
        pinner.sync(target * 1000, skipWrappers());
        settle(target);
        scheduleSample();
        if (!opts.probe) {
          // K3 的三条跳转路;`settle: true` 时再起 K5 第一路
          routeJump(target, fps);
          if (opts.settle) routeSettle(target, fps);
        }
        if (opts.probe) {
          /*
           * K1 的四个数(任务书 3.8)。`stepMs` 在**等 rAF 之前**取 —— 那一次真 rAF 至少是一个
           * 垂直同步(60 Hz 屏约 17 ms),计进去的话随机访问卡的成绩全是这个常数,
           * 而它不属于活渲、也不属于生成快照的任何一段(3.8 末条点名要修的量法问题)。
           */
          const stepMs = realNow() - started;
          await realRaf();
          const root = rootRef.current;
          const snap = root ? createSnapshot(root).timing : { inlineMs: 0, rasterMs: 0, serializeMs: 0 };
          return { path: "set", elapsedMs: realNow() - started, stepMs,
            snapshot: { inlineMs: snap.inlineMs, rasterMs: snap.rasterMs, serializeMs: snap.serializeMs } } satisfies SetTimeReply;
        }
        return { path: "set" } satisfies SetTimeReply;
      },

      /**
       * 后台舞台的补跑(K1 探针 / K3(b) 续推)。
       *   jump: true  —— 重挂载并从 mountFrameOf 推到 tSec;
       *                  `probe: 'snapshot'`(或 `true`)每推一帧就生成控件快照并 post `probe-frame`,
       *                  maxFrames 到或累计墙钟超过 B(1000/fps×70%)就截断;
       *                  `probe: 'time'` 只推进、不生成快照、不 post,按 PROBE_MAX_FRAMES /
       *                  PROBE_MAX_MS 封顶,回包带每帧的活渲耗时 `steps`(K1 的计时趟)。
       *                  截断都回 { aborted: true, reason: 'timeout', elapsedMs, frames, truncated: true }。
       *   jump 缺省   —— 续推:不重挂载、不动 playToken,从 clock.now() 推到 tSec;
       *                  tSec 在当前时刻之前直接回 { aborted, reason: 'superseded' }。
       * Promise 在推完之后才 resolve;被新 render 掐掉回 'superseded',被 setProject 掐掉回 'project'。
       */
      async render(tSec, opts = {}) {
        /*
         * 角色闸门(E1)。`render` 会重挂载整台戏、逐帧推过去 —— 落在可见舞台上就是
         * 用户眼前的画面从入点重播一遍。父页本来就只发给 `back`,这道闸门是**兜底**:
         * 角色互换(K5)那一拍父页手里的「谁是 back」可能比舞台晚一步,宁可回
         * `{ aborted: true, reason: 'role' }` 让父页当错误,也不能让可见舞台开始推帧。
         * 父页收到 `role` 不重发 —— 重发也还是同一个角色。
         */
        if (ref.current.role !== "back") return { aborted: true, reason: "role" } satisfies RenderReply;
        const target = Math.max(0, Number(tSec) || 0);
        const started = realNow();
        const p = ref.current.project;
        if (!p) return { aborted: true, reason: "project", elapsedMs: 0 } satisfies RenderReply;
        const fps = Math.max(1, p.fps || 30);
        const budgetMs = (1000 / fps) * 0.7;
        // K1 的两趟(任务书 K1):`true` 按老调用方的意思等于快照趟
        const probeMode = opts.probe === true ? "snapshot" : opts.probe || null;
        const probe = probeMode !== null;
        const timing = probeMode === "time";
        const maxFrames = opts.maxFrames ?? (timing ? PROBE_MAX_FRAMES : Infinity);

        const gen = ++renderGen.current;
        abortPending("superseded");
        window.clearTimeout(ref.current.settle);

        /*
         * 两趟布尔探针走自己那一支:它不是「推到 tSec」,而是四趟各自复位再比对
         * (K1)。`tSec` 在这里的含义是**片段最后一帧**,只用来量 `seekMs`。
         * 掐断和别的探针一样按 `renderGen` 判,回 `superseded` / `project`。
         */
        if (probeMode === "booleans") {
          const pg = projectGen.current;
          const out = await runBooleanProbe(target, fps, gen);
          const elapsedMs = realNow() - started;
          if (out.aborted || gen !== renderGen.current) {
            // 和别的路一样:被 setProject 掐的回 'project',被新 render 掐的回 'superseded'
            return { aborted: true, reason: projectGen.current !== pg ? "project" : "superseded", elapsedMs } satisfies RenderReply;
          }
          scheduleSample();
          return { remounted: true, caughtUpAtSec: clock.now() / 1000, elapsedMs, stepMs: elapsedMs,
            booleans: out.booleans } satisfies RenderReply;
        }

        let remounted = false;
        if (opts.jump) {
          remountAt(target, fps);
          remounted = true;
        } else if (target * 1000 < clock.now()) {
          // 续推不支持倒退
          return { aborted: true, reason: "superseded", elapsedMs: realNow() - started } satisfies RenderReply;
        }

        let frames = 0;
        let truncated = false;
        /*
         * 生成快照的三段耗时按帧累加(任务书 3.8)。`stepMs = elapsedMs − 这三段之和` ——
         * 判重只看 `stepMs`(3.3),生成快照的时间只排探针和预渲染的产能。
         */
        const snapshot = { inlineMs: 0, rasterMs: 0, serializeMs: 0 };
        const stepOf = (elapsed: number) => Math.max(0, elapsed - snapshot.inlineMs - snapshot.rasterMs - snapshot.serializeMs);
        /* 计时趟:每帧的活渲耗时(提交 React → 跑 rAF 回调 → 钉动画),帧间让出的时间不算进来 */
        const steps: number[] = [];
        /* 快照趟:每帧三段的耗时。`snapshot` 是它们的累加,而成本记录要的是单帧稳健值 */
        const snapshotSteps: SnapshotCost[] = [];
        let frameStarted = 0;
        return await new Promise<RenderReply>((resolve) => {
          ref.current.pending = { gen, startedAt: started, frames: () => frames, resolve };
          void (async () => {
            await clock.advanceToAsync(target * 1000, {
              step: 1000 / fps,
              maxCatchUp: opts.maxCatchUp,
              yieldEvery: 8,
              abort: () => {
                if (gen !== renderGen.current) return true;
                /*
                 * 计时趟**不按一拍预算截断**(任务书 K1):那样 61 张推帧卡全部只推得了 1～10 帧,
                 * catchUpMs 靠含挂载成本的前几帧外推、偏大 1.7～3.6 倍。这里的封顶只为长片段留,
                 * 剩下的帧由父页按「首帧实测 + 其余帧中位数 × 剩余帧数」外推。
                 */
                if (timing) {
                  if (frames >= maxFrames || realNow() - started > PROBE_MAX_MS) {
                    truncated = true;
                    return true;
                  }
                  return false;
                }
                if (probe && (frames >= maxFrames || realNow() - started > budgetMs)) {
                  truncated = true;
                  return true;
                }
                return false;
              },
              onFrame: (ms) => {
                if (timing) frameStarted = realNow();
                flushSync(() => setT(ms / 1000));
              },
              afterFrame: (ms) => {
                pinner.sync(ms, skipWrappers());
                if (!probe) return;
                frames++;
                // 计时趟:只留下这一帧的耗时,不生成快照、不 post probe-frame
                if (timing) {
                  steps.push(realNow() - frameStarted);
                  return;
                }
                const root = rootRef.current;
                if (!root) return;
                // 探针推过的帧直接存成死素材(K1):本地帧号按探针自己的步序算,不取 data-pc-local-frame
                const snap = createSnapshot(root);
                snapshot.inlineMs += snap.timing.inlineMs;
                snapshot.rasterMs += snap.timing.rasterMs;
                snapshot.serializeMs += snap.timing.serializeMs;
                snapshotSteps.push({ inlineMs: snap.timing.inlineMs, rasterMs: snap.timing.rasterMs, serializeMs: snap.timing.serializeMs });
                for (const c of snap.controls) {
                  postStageEvent({ type: "probe-frame", clipId: c.id, localFrame: Math.round((ms / 1000 - clipStart(c.id)) * fps), html: c.html });
                }
              },
            });
            if (gen !== renderGen.current) return; // 已被 abortPending 按 reason 回包
            ref.current.pending = null;
            const elapsedMs = realNow() - started;
            if (truncated) {
              resolve({ aborted: true, reason: "timeout", elapsedMs, stepMs: stepOf(elapsedMs), frames, truncated: true, snapshot,
                ...(timing ? { steps } : { snapshotSteps }) });
              return;
            }
            flushSync(() => setT(target));
            clock.tick(target * 1000);
            pinner.sync(target * 1000, skipWrappers());
            settle(target);
            scheduleSample();
            ref.current.t = target;
            resolve({ remounted, caughtUpAtSec: clock.now() / 1000, elapsedMs, stepMs: stepOf(elapsedMs),
              ...(probe ? { frames, truncated: false, snapshot } : {}),
              ...(timing ? { steps } : probe ? { snapshotSteps } : {}) });
          })();
        });
      },

      async hitTest(x, y) {
        const root = rootRef.current;
        return root ? solidHitTest(root, x, y) : null;
      },
      async rectsWithBounds(opts = { pixels: "none" }) {
        const root = rootRef.current;
        return root ? solidRectsWithBounds(root, opts) : [];
      },
      async size() {
        const p = ref.current.project;
        return { width: p?.width ?? 1920, height: p?.height ?? 1080 };
      },
      async setProxy(on) {
        // 只有显式带了 ?proxy=1 的页面才允许开。导出页永远进不来这一条。
        if (!proxyAllowed()) return { ok: true as const };
        const want = !!on;
        if (want === ref.current.proxy) return { ok: true as const };
        ref.current.proxy = want;
        if (want) ensureProxyStyle();
        /*
         * 从实体切回真渲的那一刻要采一次样,而不是切进实体时采 ——
         * 实体模式下画面上只有色块,量它等于把上一次的结论抄一遍再劣化。
         * 采样排在这一帧提交之后(真卡已经画出来了),所以放 flushSync 后面。
         */
        flushSync(() => setProxy(want));
        if (!want) {
          const root = rootRef.current;
          if (root) sampleAll(root);
        }
        return { ok: true as const };
      },
      /**
       * 角色是运行时状态(J4)。收到 `back` 就地转成后台舞台,**组件不重挂载** ——
       * 互换(K5)靠的正是「同一棵树换个身份」,重挂载等于把追了半天的状态扔掉。
       *
       * 清理的全集(E0 的 `setRole` 那条,两条互换路都不再逐条列):
       *   1. 停 K4 的节拍循环(循环每拍开头和 post `frame` 之前都查 `beatPaused` / 角色);
       *   2. 清空 `suppressed` / `snapshots` / `streamPlanes` —— `back` 永远不收它们的非空集合;
       *   3. 停 `streamPlayer` 并 `close()` 所有 `VideoFrame`(R8 的轨道流,这一步还没有);
       *   4. 去掉全部平面和类(快照 / 抑制 / 等待 / 追帧);
       *   5. 中止可见舞台里正在进行的第一路追帧(`catchUpGen` 递增)并清空 `settling` / `awaiting`。
       * R3 把第 2、4、5 条接到真实状态上(平面本体已经有了);循环本体(第 1 条)和
       * `streamPlayer`(第 3 条)分别在 R5 / R8。
       *
       * `bake` 在本地模式不支持(预渲染者是预渲染进程),回 `unsupported`、不抛。
       */
      async setRole(role, opts = {}) {
        if (role === "back" && opts.job === "bake") return { ok: false, reason: "unsupported" as const };
        /*
         * K5 (6):**从 `back` 转正**的舞台要报一次 `settled`(`clipIds` 为空数组)。
         *
         * 判据是「上一刻是不是 `back`」,**不看工作项** —— 单飞队列在补跑那个活做完之后
         * 会把工作项交还成 `'probe'`(`stageJobs` 的 `pump`),那条 `setRole('back', { job: 'probe' })`
         * 和互换的 `setRole('front')` 是两条并行的 RPC,谁先到没有保证。按工作项判的话
         * 交还先到就永远报不出 `settled`,父页那边等到超时。
         */
        const wasBack = ref.current.role === "back";
        ref.current.role = role;
        ref.current.job = role === "back" ? opts.job ?? "probe" : undefined;
        if (role === "back") {
          // 1. 停 K4 的节拍循环(挂着的 pause() 回包一并落定)
          stopBeat();
          ref.current.snapshots = new Map();
          ref.current.suppressed = new Set();
          ref.current.streamPlanes = [];
          ref.current.settling = new Map();
          ref.current.catchUps.clear();
          ref.current.lastActive = new Set();
          setAwaiting([]);
          catchUpGen.current++;
          // 同一次提交里把全部平面和类去掉 —— 互换那一拍新 `back` 不能还盖着旧画面
          commitPlanes();
        } else if (wasBack) {
          // K5 (6):新 `front` post 一次 `{ type: 'settled', sec, clipIds: [] }`
          postStageEvent({ type: "settled", sec: ref.current.t, clipIds: [] });
        }
        return { ok: true };
      },
      /**
       * K2 的分派表 + K1 的每卡记录(E0)。父页在 `costs` / 项目 / `tuning` 变了时算好发过来,
       * **集合在线上是数组**(`wirePlan.ts`),这里回填成 `Set`,消费侧照常用 `pipelineAt`。
       *
       * `back` 也收得下(只是存着不用):角色转正(K5 (5) / K3(b) (5))时父页会在
       * `setRole('front')` 之后的同一批里先补发一次,那时它就派上用场了。
       *
       * 消费它的是 K3 / K5(R5):`pipelineAt(plan, clipId, t)` 决定这一拍活渲还是贴死素材,
       * `costs` 里的 `vtOk` / `seekOk` / `catchUpMs` 决定走 (a′) / (a) / (b) 和 K5 的两路。
       * 这一步只把表存进来、并把查询口子放好。
       */
      async setPlan(plan) {
        const wire = (plan?.plan ?? null) as WirePlan | null;
        ref.current.plan = reviveStagePlan(wire, Array.isArray(plan?.costs) ? plan.costs : []);
        return { ok: true as const };
      },
      /**
       * K4:可见舞台是节拍器。`play(fromSec)` 只是**起**循环 —— 立刻回包,不等第一拍,
       * 父页拿它的回包时刻当「相邻两条 `frame` 的到达间隔」的起点(`mediaStalled`)。
       *
       * 只有 `front` 跑:`back` 要么在做探针、要么在补跑,起循环会把它的时钟一路推走。
       */
      async play(fromSec) {
        if (ref.current.role !== "front") return { ok: false, reason: "role" };
        const p = ref.current.project;
        if (!p) return { ok: false, reason: "no-project" };
        const from = Math.max(0, Number(fromSec) || 0);
        // 连着来两条 `play`:先让上一轮收摊,不然两个循环会各推各的时钟
        if (ref.current.beatRunning) {
          ref.current.beatPaused = true;
          await new Promise<PlayReply>((resolve) => { ref.current.beatWaiters.push(resolve); });
        }
        const fps = Math.max(1, p.fps || 30);
        ref.current.beatLastSec = from;
        ref.current.beatLastFrame = Math.round(from * fps);
        ref.current.k6.beats = [];
        ref.current.lastActive = new Set();
        ref.current.beatPaused = false;
        // 按下播放同样中止第一路追帧(K5:五个 RPC 各递增一次)
        catchUpGen.current++;
        abortCatchUps();
        void runBeatLoop(from);
        return { ok: true, stoppedAt: from };
      },
      /**
       * `pause()` 立即停:**本拍走完、post 完这一拍的 `frame` 后**停,回 `{ stoppedAt }`
       * (= 最后一拍的 `sec`)。循环已经停着(`ended` 之后、重复 `pause()`)立即回最后一拍。
       *
       * `pause({ atSec })` 是**武装停**(K3(b) 的播放态互换用):post 完 `frame(atSec)`
       * 那一拍就停在那一帧、平面不摘,回 `{ stoppedAt: atSec }`。那一拍**已经 post 过**
       * (当前拍序号 ≥ `atSec` 的拍序号,**等号也算过了**)时不停、回 `{ passed: true }` ——
       * 否则永远等不到那一拍、RPC 永不回包。拍序号按帧号比,不比浮点。
       */
      async pause(opts = {}) {
        const atSec = opts?.atSec;
        const fps = Math.max(1, ref.current.project?.fps || 30);
        if (!ref.current.beatRunning) return { ok: true, stoppedAt: ref.current.beatLastSec };
        if (typeof atSec === "number" && Number.isFinite(atSec)) {
          const frame = Math.round(atSec * fps);
          if (ref.current.beatLastFrame >= frame) return { ok: true, passed: true };
          // 只保留最后一次武装:上一次作废(按 `passed` 回,告诉父页别再等它)
          const prev = ref.current.beatArmed;
          if (prev) {
            window.clearTimeout(prev.timer);
            ref.current.beatArmed = null;
            prev.resolve({ ok: true, passed: true });
          }
          return await new Promise<PlayReply>((resolve) => {
            // 兜底用**真** setTimeout(E4b):循环要是卡住了,RPC 不能永不回包
            const timer = realSetTimeout(() => {
              if (ref.current.beatArmed?.timer !== timer) return;
              ref.current.beatArmed = null;
              resolve({ ok: true, stoppedAt: ref.current.beatLastSec });
            }, ARM_TIMEOUT_MS);
            ref.current.beatArmed = { frame, atSec, resolve, timer };
          });
        }
        return await new Promise<PlayReply>((resolve) => {
          ref.current.beatWaiters.push(resolve);
          stopBeat();
        });
      },
      /**
       * 播放中被判重的卡(E7 第 5 条):`Stage` 给包裹层加 `.pc-suppressed`、藏子树,
       * 传给组件的那个 `t` 冻在抑制开始那一刻;包裹层留在布局树里,几何不变,
       * `rects()` / `hitTest` 照常点得中它。
       *
       * **`.pc-suppressed` 与 `.pc-settling` 互斥**:K6 在追帧中途把一张卡降为重时走的就是这条,
       * 所以这里先把它从 `settling` 里删掉、并递增 `catchUpGen` 中止那一路追帧,再同一次提交里
       * 加上抑制 —— 两个类不会同帧共存。
       */
      async setSuppressed(clipIds) {
        const next = new Set(clipIds);
        ref.current.suppressed = next;
        /*
         * K6:被切进 `suppressed` 就说明死素材就绪了,从 `pendingDemote` 里移出 ——
         * 它此后是重卡,本来就不参加 K6 的判定。
         */
        if (ref.current.k6.pending.size) {
          const rest = new Set(ref.current.k6.pending);
          for (const id of next) rest.delete(id);
          if (rest.size !== ref.current.k6.pending.size) ref.current.k6.pending = rest;
        }
        if (ref.current.settling.size) {
          const rest = new Map(ref.current.settling);
          let changed = false;
          for (const id of next) if (rest.delete(id)) changed = true;
          if (changed) {
            ref.current.settling = rest;
            catchUpGen.current++;
          }
        }
        commitPlanes();
        return { ok: true as const };
      },
      /** G1 的流平面分组(R8 之前父页恒发空表);渲染位置在 `Stage`(包裹层里 / 舞台根下) */
      async setStreamPlanes(planes) {
        ref.current.streamPlanes = planes.map((g) => ({ clipIds: [...g.clipIds] }));
        commitPlanes();
        return { ok: true as const };
      },
      /** 手按着播放头拖:素材层 seek 放疏一点(`mediaSync` 的 SCRUB_SEEK_MIN_MS) */
      async setScrubbing(on) {
        ref.current.scrubbing = !!on;
        commitPlanes();
        return { ok: true as const };
      },
      /** **只管素材层**(`VideoTrack` 的 `playing`):不碰 K4 的节拍循环,那个只由 play / pause / setRole 起停 */
      async setPlaying(on) {
        ref.current.playing = !!on;
        commitPlanes();
        return { ok: true as const };
      },
      /**
       * 素材层跟的时刻。平时等于 `t`;K5 第二路补跑时父页单独给 `back` 下发目标拍 ——
       * `VideoTrack` 见偏差过了 `PAUSED_SEEK_SEC` 就补注册一次 rVFC,出画即 post `mediaReady`,
       * 不用等满 300 ms 兜底。
       */
      async setMediaT(tSec) {
        ref.current.mediaT = Number(tSec) || 0;
        commitPlanes();
        return { ok: true as const };
      },
      /** A1 的本地素材哈希表。R3 只存,换档那条路在 A1 / L */
      async setLocalHashes(hashes) {
        ref.current.localHashes = [...hashes];
        return { ok: true as const };
      },
      /**
       * A3c:patch 是相对上次投递的增量(null = 摘掉),reset = 先清空全部再应用。
       * 回包的 `bytes` 就是「一次投递 ≤ 2 MB」的实测口子,父页超了就拆。
       */
      async setSnapshots(patch, opts = {}) {
        const bytes = applySnapshots(patch, !!opts.reset);
        commitPlanes();
        return { ok: true as const, bytes };
      },
    };

    const stopRpc = serveStageRpc(api);
    window.__pcStage = api;
    // K1 探针 / L1 / probe-frame 生成快照都在舞台页调它;导出页挂的是同一个 createSnapshot(J1)。
    // 场景根就是 rootRef 指着的那个 [data-pc-scene] div(不走 document.querySelector:预渲染页上 #root 只是 display:none)。
    window.__pcCreateSnapshot = () => {
      const root = rootRef.current;
      if (!root) throw new Error("stage: 还没有项目,没什么可生成快照的");
      return createSnapshot(root);
    };
    /*
     * K2 的表的查询口子。R5 的 K3 / K5 在舞台内部直接读 `ref.current.plan`,
     * 挂在 window 上这一份是给验收探针和 puppeteer 看的(表到没到、这一刻判轻还是判重)。
     * 没有表时 `pipelineAt` 回 `'heavy'` —— 保守侧,和「没有记录按声明兜底」同一个方向。
     */
    window.__pcStagePlan = () => ref.current.plan;
    /*
     * 验收探针的观察口(K4 / K3 / K5 / K6):跨源摸不到 iframe 的 document,
     * 所以把「此刻的内部状态」摊成一个可结构化克隆的对象,探针用 CDP 在舞台上下文里读。
     * 只读,没有副作用。
     */
    window.__pcStageDiag = () => ({
      role: ref.current.role,
      job: ref.current.job ?? null,
      t: ref.current.t,
      beatRunning: ref.current.beatRunning,
      beatPaused: ref.current.beatPaused,
      beatLastSec: ref.current.beatLastSec,
      beatLastFrame: ref.current.beatLastFrame,
      armedFrame: ref.current.beatArmed?.frame ?? null,
      settling: [...ref.current.settling.keys()],
      suppressed: [...ref.current.suppressed],
      snapshots: [...ref.current.snapshots.keys()],
      awaiting: [...ref.current.awaiting],
      remountGen: [...ref.current.remountGen.entries()],
      catchUps: [...ref.current.catchUps.values()].map((c) => ({ clipId: c.clipId, stageMs: c.stageMs, targetMs: c.targetMs })),
      pendingDemote: [...ref.current.k6.pending],
      k6Beats: ref.current.k6.beats.length,
      k6Over: ref.current.k6.beats.reduce((n, b) => n + b.over, 0),
      /** 最后一拍每张卡的耗时(`<Profiler>` 报的);K6 挑「最贵的那张」就按它 */
      cardCost: [...ref.current.cardCost.entries()],
    });
    window.__pcStagePipelineAt = (clipId: string, tSec: number) => pipelineAt(ref.current.plan?.plan ?? null, clipId, tSec);
    postStageReady(detectHostCapabilities());
    return () => {
      stopRpc();
      window.clearTimeout(ref.current.settle);
      window.clearTimeout(ref.current.awaitTimer);
      window.clearTimeout(sampleTimer);
      if (window.__pcStage === api) delete window.__pcStage;
      delete window.__pcStagePlan;
      delete window.__pcStageDiag;
      delete window.__pcStagePipelineAt;
    };
  }, [skipWrappers]);

  if (!project) return null;
  const timeline = flattenOverlay(project, graph);

  return (
    <div
      ref={rootRef}
      data-pc-scene=""
      style={{
        position: "relative",
        width: project.width,
        height: project.height,
        overflow: "hidden",
        background: "transparent",
        // 和 ExportView 读同一处(Timeline),不是各读各的 project —— 见 Timeline.themeId 的说明
        ...themeStyle(timeline.themeId),
        /*
         * 三维的 perspective **不在这里**。这一格和卡片之间还隔着 Stage 的根和 AnimClock
         * 两层 div,而 CSS 的 perspective 只作用于直接子元素 —— 挂在这里等于没挂
         * (实测卡片高度纹丝不动,rotateY 只剩仿射拉伸,而且不报错)。
         * 它挂在 render/Stage.tsx 里卡片的直接父元素上,预览和导出共用同一处。
         */
      }}
    >
      {LIVE ? (
        /*
         * E7:舞台页渲 `FrameScene` 的**活播放变体** —— 素材层在舞台里(第 1 条)、
         * 卡片活跃判据用 `cardMountedAt`(第 2 条)、六个平面 prop 原样透传(第 3～5 条)。
         * `graph` 就是上面那个 `useMemo`:**漏传的话** `graphVisualNode` 恒为 false、
         * 素材段被画两层,而且 `timeline.graph` 为空、图卡解不出输入,编译器不会拦。
         */
        <FrameScene
          project={project}
          graph={graph}
          t={t}
          directT={t}
          mediaT={ref.current.mediaT}
          playToken={token}
          mediaMode="live"
          proxy={proxy ? proxyOf : undefined}
          scrubbing={ref.current.scrubbing}
          playing={ref.current.playing}
          suppressed={ref.current.suppressed}
          streamPlanes={ref.current.streamPlanes}
          snapshots={ref.current.snapshots}
          remountGen={ref.current.remountGen}
          settling={ref.current.settling}
          awaiting={ref.current.awaiting}
          localHashes={ref.current.localHashes}
          onMediaFrame={onMediaFrame}
          onCardCost={onCardCost}
        />
      ) : (
        <Stage timeline={timeline} t={t} playToken={token} proxy={proxy ? proxyOf : undefined} />
      )}
    </div>
  );
}
