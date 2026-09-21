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
  type RenderReply,
  type SetTimeReply,
  type StageRole,
  type StageRpcApi,
} from "./render/stageRpc";
import type { CardCostRecord } from "./render/cardCostKey.mjs";
import { PROBE_MAX_FRAMES, PROBE_MAX_MS } from "./render/pipelineTuning.mjs";
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
    plan: null as { plan: unknown; costs: CardCostRecord[] } | null,
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
    /** K3:按片段重挂载的代数(R5 才填;空表时 `Stage` 退回整舞台 playToken) */
    remountGen: new Map<string, number>() as ReadonlyMap<string, number>,
    scrubbing: false,
    playing: false,
    mediaT: 0,
    localHashes: [] as readonly string[],
    /** K4 的节拍循环停着没有(R5 才有循环本体;`setRole('back')` 要能停它) */
    beatPaused: true,
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
     * 重挂载定位:把此刻活跃的卡全部重挂载,时钟拨到它们里最早的挂载帧,空跑两拍。
     * 返回从哪一秒起推。render(jump) 用;legacy 的 setProject 也走它。
     */
    const remountAt = (target: number, fps: number): number => {
      const p = ref.current.project!;
      const clips = flattenOverlay(p).clips;
      const active = clips.filter((c) => cardMountedAt(c, target));
      /*
       * **挂载时刻必须落在帧格上** —— 不然「预览所见 = 导出所得」在每个卡片入点都破一次。
       *
       * 导出是一帧一帧推的:一张卡在第一个 ≥ start-LEAD 的**帧**上挂载,时间原点就是那一帧,
       * 而不是 start-LEAD 本身。挂载帧统一由 frameWindow.mjs 的 mountFrameOf 给
       * (预览、导出、分片同一个算式)。夹一下:target 本身不在帧格上时,对齐后可能反超它。
       */
      const from = active.length
        ? Math.min(Math.min(...active.map((c) => mountFrameOf(c, fps))) / fps, Math.max(0, target))
        : Math.max(0, target);
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
        abortPending("project");
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
        // 新的 setTime 同样中止正在进行的第一路追帧(K5;R5 填实现)
        catchUpGen.current++;
        const fps = Math.max(1, p.fps || 30);

        if (!opts.probe && dt >= 0 && dt < CONTINUOUS_MAX) {
          // 连续播放:接着往下跑一两帧就行(≤ 30 步,同步)
          flushSync(() => setT(target));
          clock.advanceTo(target * 1000, { step: 1000 / fps, maxCatchUp: CONTINUOUS_MAX * 1000, onFrame: (ms) => pinner.sync(ms, skipWrappers()) });
          settle(target);
          scheduleSample();
          return { path: "continuous" } satisfies SetTimeReply;
        }

        clock.set(target * 1000);
        flushSync(() => setT(target));
        pinner.sync(target * 1000, skipWrappers());
        settle(target);
        scheduleSample();
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
                ...(timing ? { steps } : {}) });
              return;
            }
            flushSync(() => setT(target));
            clock.tick(target * 1000);
            pinner.sync(target * 1000, skipWrappers());
            settle(target);
            scheduleSample();
            ref.current.t = target;
            resolve({ remounted, caughtUpAtSec: clock.now() / 1000, elapsedMs, stepMs: stepOf(elapsedMs),
              ...(probe ? { frames, truncated: false, snapshot } : {}), ...(timing ? { steps } : {}) });
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
        ref.current.role = role;
        ref.current.job = role === "back" ? opts.job ?? "probe" : undefined;
        if (role === "back") {
          ref.current.beatPaused = true;
          ref.current.snapshots = new Map();
          ref.current.suppressed = new Set();
          ref.current.streamPlanes = [];
          ref.current.settling = new Map();
          setAwaiting([]);
          catchUpGen.current++;
          // 同一次提交里把全部平面和类去掉 —— 互换那一拍新 `back` 不能还盖着旧画面
          commitPlanes();
        }
        return { ok: true };
      },
      async setPlan(plan) {
        ref.current.plan = plan;
        return { ok: true as const };
      },
      /*
       * K4(R5):可见舞台自己按帧节拍播放。R2 里节拍循环本体还没有,父页照旧每帧发 `setTime`,
       * 这两个仍然明确说不支持 —— 但回包已经是统一后的 `PlayReply`(`ok` 不可选),
       * R5 往里填循环时只改这两个函数体,协议面不用再动。
       */
      async play() {
        return { ok: false, reason: "unsupported" };
      },
      async pause() {
        return { ok: false, reason: "unsupported" };
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
    postStageReady(detectHostCapabilities());
    return () => {
      stopRpc();
      window.clearTimeout(ref.current.settle);
      window.clearTimeout(ref.current.awaitTimer);
      window.clearTimeout(sampleTimer);
      if (window.__pcStage === api) delete window.__pcStage;
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
        />
      ) : (
        <Stage timeline={timeline} t={t} playToken={token} proxy={proxy ? proxyOf : undefined} />
      )}
    </div>
  );
}
