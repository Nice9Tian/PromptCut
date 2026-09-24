/**
 * 父页侧的快照 / 抑制投递（C4、C5、A3c 的消费方）。
 *
 * R6 把「拿得到」那一半做完了（`snapshotSource.ts` 的就绪索引 SSE + 取字节、
 * `snapshotPick.mjs` 的回溯选帧纯函数、`dataMirror.pushWanted`）；这个文件是排程那一半：
 *
 * - 每个播放头位置按 `planDispatch.currentPlan()` 的 `pipelineAt` 分出这一刻的重卡集合 `H(t)`，
 *   给每张重卡按就绪索引选一帧（`pickLayerSnapshot`，同区间内回溯、不跨区间、**不等待**）；
 * - **投递基线按 iframe 各一份**（A3c）：`patch` 是相对上次投递的增量，`null` = 摘掉；
 *   `setProject` 整份替换、K5 的角色互换要带 `reset`；`settled` 消息把 clipId 从基线里删掉，
 *   否则下次 C4 选到同一帧会按基线判「已挂着」不投、露出过期的活组件；
 * - **换 DOM 有节流**：每 ≥ 33 ms 一次（C4）。带 `reset` 的那次（互换后的首投）不受节流；
 * - **一次投递 ≤ 2 MB**（A3c）：超了就拆成多次。
 *
 * # 为什么取字节不能挡住 `setTime`
 *
 * 总规则是「永远不等」。所以这里分成同步和异步两半：`pickForSetTime(t)` **同步**回
 * 手里已经有的那些字节（`have`），缺的那几帧当场发起 `fetchSnapshot`，到货之后走
 * 独立的 `setSnapshots` 投递。拖过一张 stateful 卡的入点时，缓存命中的那一份和 `t`
 * 在同一次 React 提交里生效（不闪初始态）；没命中的那一层由 `.pc-awaiting` 藏 500 ms。
 *
 * # 现在恒无流
 *
 * `streams` 开关在 R8 之前恒为关，所以 `kind: 'stream'` 的表永远是空的：**播放中的抑制卡
 * 照常投快照**（A3c：「`streams` 关着或这一拍缺分段时，C4 照常给抑制卡选最近快照投进去」）。
 */
import { cardMountedAt } from "../render/frameWindow.mjs";
import { anchorFrames, pickLayerSnapshot } from "../render/snapshotPick.mjs";
import type { ReadyKind } from "../render/snapshotPick.mjs";
import { applyReadyMessage, HttpSnapshotSource, layerOf, type ReadyIndex, type ReadyMessage, type SnapshotSource } from "../render/snapshotSource";
import { pipelineAt } from "../render/pipelinePlan.mjs";
import { mirrorKey, pushWanted } from "../render/dataMirror";
import type { Project, TrackClip } from "../kernel/project";
import type { StageRole, StageRpcClient } from "../render/stageRpc";
import { currentPlan } from "./planDispatch";
import { rangesHave, SEGMENT_FRAMES, streamPlanesFor, type StreamPlaneRequest } from "../render/streamPlayer";

/** C4：换 DOM 每 rAF 至多一次、间隔 ≥ 33 ms */
export const SNAPSHOT_THROTTLE_MS = 33;
/** A3c：一次 `setSnapshots` 投递 ≤ 2 MB（回包的 `bytes` 是实测口子，超了就拆） */
export const SNAPSHOT_DELIVERY_MAX_BYTES = 2 * 1024 * 1024;
/** C4：一次最多报 8 条缺口给预渲染进程 */
export const MAX_WANTED = 8;
/**
 * 快照按 `html`、再 `local` 的顺序选（A3a 的档位由预渲染进程按审阅表定，这里只看有没有）。
 * **`stream` 不是快照**：它的区间单位是分段号、字节是 fMP4，由舞台里的 `streamPlayer` 解（R8）。
 */
const KIND_ORDER: ReadyKind[] = ["html", "local"];

/** 这张卡此刻所在的分段有没有流（单卡流挂在它自己身上；组流挂在组里最上面那张上、带 `groupClipIds`） */
function streamCovers(clipId: string, globalFrame: number): boolean {
  const seg = Math.floor(Math.max(0, globalFrame) / SEGMENT_FRAMES);
  for (const [owner, byKind] of readyIndex) {
    const layer = byKind.get("stream");
    if (!layer) continue;
    const members = layer.groupClipIds?.length ? layer.groupClipIds : [owner];
    if (members.includes(clipId) && rangesHave(layer.ranges, seg)) return true;
  }
  return false;
}

/** 这一刻某张卡选中的那一帧 */
export interface Pick {
  clipId: string;
  kind: ReadyKind;
  key: string;
  localFrame: number;
  /** 投递基线的比较键：换了它才换 DOM */
  id: string;
}

interface Baseline {
  /** 这个 iframe 上此刻挂着的快照（clipId → `Pick.id`） */
  mounted: Map<string, string>;
  /** 下一次投递要带 `reset`（`setProject` 整份替换 / 角色互换） */
  needsReset: boolean;
  lastSentAt: number;
  /** 暂停态已经 settled(精确活渲、舞台自己摘了快照)的卡:暂停中不再投(根因 B) */
  settled: Set<string>;
  /** 暂停态第二路互换之后:整台都精确 */
  settledAll: boolean;
}

const newBaseline = (): Baseline => ({ mounted: new Map(), needsReset: false, lastSentAt: 0, settled: new Set(), settledAll: false });

const baselines: Record<StageRole, Baseline> = { front: newBaseline(), back: newBaseline() };

/** 已经拿到手的字节（`Pick.id` → HTML）。`HttpSnapshotSource` 自己也有一份 LRU，这一份是**同步**可读的 */
const have = new Map<string, string>();
/** 正在飞的那些，别重复发起 */
const flying = new Set<string>();

let source: SnapshotSource = new HttpSnapshotSource();
let readyIndex: ReadyIndex = new Map();
let unsubscribe: (() => void) | null = null;
let subscribedTo = "";
/** 到货之后要重投一次：由宿主（`Preview`）挂上 */
let onArrive: (() => void) | null = null;

/** 测试 / 探针:换一个快照来源 */
export function setSnapshotSource(next: SnapshotSource): void {
  source = next;
}

/** 就绪索引此刻的样子（验收探针看） */
export function currentReadyIndex(): ReadyIndex {
  return readyIndex;
}

/**
 * 订阅就绪索引（C3 的 SSE，页面直连预渲染进程）。**只按 session 做键**（根因 E）：
 * 编辑一次 `localRev` + 1，以前这里就清表、重连，而服务端 `/api/frames/ready` 根本不看
 * session / localRev —— 重连空档里播放中的重卡一律透明。现在客户端不抢先清表：旧的层按
 * 「沿用旧的预渲染结果」顶着，等预渲染进程换了 entry 发 `reset` 再清（`adoptCardPlan`）。
 * 换项目（session 变了）才重连。
 */
export function syncSnapshotSubscription(notify: () => void): void {
  onArrive = notify;
  const key = mirrorKey();
  const want = key ? key.session : "";
  if (want === subscribedTo) return;
  unsubscribe?.();
  unsubscribe = null;
  subscribedTo = want;
  readyIndex = new Map();
  if (!key) return;
  unsubscribe = source.subscribeReady(key.session, key.localRev, (message: ReadyMessage) => {
    applyReadyMessage(readyIndex, message);
    // 新的一层到了：这一刻也许就能贴上，让宿主重算一次
    if (message.type !== "done") onArrive?.();
  });
}

export function stopSnapshotFeed(): void {
  unsubscribe?.();
  unsubscribe = null;
  subscribedTo = "";
  onArrive = null;
  readyIndex = new Map();
  have.clear();
  flying.clear();
  baselines.front = newBaseline();
  baselines.back = newBaseline();
}

/** `setProject` 整份替换 / K5 的角色互换：下一次投递带 `reset` */
export function markBaselineReset(role: StageRole): void {
  baselines[role].needsReset = true;
}

/**
 * K5 第一路 settled（A3c）：舞台自己摘了这几张卡的快照平面，父页要把它们从基线里删掉 ——
 * 否则下次 C4 选到同一帧会按基线判「已经挂着」而不投，露出过期的活组件。
 */
export function noteSettled(role: StageRole, clipIds: readonly string[]): void {
  const base = baselines[role];
  for (const id of clipIds) {
    base.mounted.delete(id);
    base.settled.add(id);
  }
}

/**
 * K5 第二路暂停态互换之后:新 `front` 是后台整场景补跑出来的,**整台**都是精确活渲(根因 B)。
 * 暂停中不再给任何卡投快照,直到下一次 `setTime` / 播放。
 */
export function markAllSettled(role: StageRole): void {
  baselines[role].settledAll = true;
}

/**
 * 「停下就撤兜底」(rendering.md「兜底顺序」末条):暂停态已经追到精确活渲的卡,暂停中不再盖回快照。
 * 下一次 `setTime`(`pickForSetTime`)或播放时清空。
 */
function clearSettled(role: StageRole): void {
  const base = baselines[role];
  if (base.settled.size) base.settled = new Set();
  base.settledAll = false;
}

function isSettled(role: StageRole, clipId: string): boolean {
  const base = baselines[role];
  return base.settledAll || base.settled.has(clipId);
}

/* --------------------------------------------------------------- 选帧 */

/** 这一层的采样窗口。`firstFrame` 和预渲染进程的 `cardSampling(start, fps)` 同一个算式 */
function samplingOf(clip: { start: number; end: number }, fps: number): { firstFrame: number; count: number } {
  const firstFrame = Math.max(0, Math.ceil(clip.start * fps - 1e-9));
  const phase = firstFrame / fps - clip.start;
  const count = Math.max(1, Math.ceil((clip.end - clip.start - phase) * fps - 1e-9));
  return { firstFrame, count };
}

let anchorsFor: { project: Project; fps: number; anchors: number[] } | null = null;
function anchorsOf(project: Project, fps: number): number[] {
  if (anchorsFor && anchorsFor.project === project && anchorsFor.fps === fps) return anchorsFor.anchors;
  const clips = project.tracks.flatMap((tr) => tr.clips);
  const anchors = anchorFrames(clips, fps) as number[];
  anchorsFor = { project, fps, anchors };
  return anchors;
}

/**
 * K6：已经降级、但死素材还没就绪的卡。**照常活渲**（用户看到的画面不变，只是可能慢），
 * 就绪之后的下一拍才切进 `suppressed` / `snapshots` —— 和别的重卡同一机制。
 *
 * 「就绪」写死为（K6）：`readyIndex` 里该 clipId 的 `'stream'` 表至少一个分段，或
 * `'html'` / `'local'` 任一表的 `ranges` **从当前播放头所在本地帧起**覆盖
 * `min(fps, 该片段剩余帧数)` 帧。用 `'html'` 还是 `'local'` 由 A3a 的档位决定，
 * 这里不猜档位、两张表哪张够就算哪张（毛玻璃卡只产 `controls-local`，不看 `local` 它永远不就绪）。
 */
const pendingDemote = new Set<string>();

export function markPendingDemote(clipId: string): void {
  pendingDemote.add(clipId);
}

export function pendingDemotes(): ReadonlySet<string> {
  return pendingDemote;
}

/** 闭区间表（已合并有序）有没有整段盖住 `[from, to]` */
function rangesCover(ranges: readonly (readonly number[])[] | undefined, from: number, to: number): boolean {
  if (to < from) return true;
  for (const range of ranges ?? []) {
    if (range[0] <= from && range[1] >= to) return true;
  }
  return false;
}

function demoteReady(clipId: string, localFrame: number, count: number, fps: number): boolean {
  const stream = layerOf(readyIndex, clipId, "stream");
  if (stream && stream.ranges.length) return true;
  const need = Math.max(0, Math.min(fps, count - localFrame) - 1);
  for (const kind of ["html", "local"] as const) {
    const layer = layerOf(readyIndex, clipId, kind);
    if (layer && rangesCover(layer.ranges, localFrame, localFrame + need)) return true;
  }
  return false;
}

/** 这一刻活跃的卡片段（口径同 `Stage` / `FrameScene` 的 live 路：含 LEAD） */
function activeCardClips(project: Project, t: number): TrackClip[] {
  const out: TrackClip[] = [];
  for (const tr of project.tracks) {
    if (tr.hidden) continue;
    for (const clip of tr.clips) {
      if (!clip.cardId && !clip.nodeId) continue;
      if (cardMountedAt(clip, t)) out.push(clip);
    }
  }
  return out;
}

export interface Playhead {
  project: Project;
  t: number;
  /** 播放中才有抑制集合（C5 / K5：拖动和暂停下不抑制、改贴快照） */
  playing: boolean;
}

export interface FeedPlan {
  /** 这一刻判重的卡（播放中就是 `setSuppressed` 的实参） */
  heavy: string[];
  /** 每张重卡选中的那一帧；选不出来的不在表里（那一层这一拍透明） */
  picks: Map<string, Pick>;
  /** 这一刻该报给预渲染进程的缺口（全局帧号） */
  wanted: { clipId: string; frame: number }[];
}

/**
 * 这一刻的投递计划。**纯算，不 fetch、不发 RPC**，所以验收探针可以单独看它。
 */
export function planFeed({ project, t, playing }: Playhead): FeedPlan {
  const plan = currentPlan();
  const fps = Math.max(1, project.fps || 30);
  const globalFrame = Math.max(0, Math.floor(t * fps + 1e-6));
  const anchors = anchorsOf(project, fps);
  const heavy: string[] = [];
  const picks = new Map<string, Pick>();
  const wanted: { clipId: string; frame: number }[] = [];
  for (const clip of activeCardClips(project, t)) {
    if (pipelineAt(plan, clip.id, t) !== "heavy") continue;
    const { firstFrame, count } = samplingOf(clip, fps);
    if (pendingDemote.has(clip.id)) {
      // K6：死素材就绪之前照常活渲，**不进 heavy**（也就不会被抑制、不会贴快照）
      if (!demoteReady(clip.id, globalFrame - firstFrame, count, fps)) continue;
      pendingDemote.delete(clip.id);
    }
    heavy.push(clip.id);
    // 根因 B:暂停态已经追到精确活渲的卡不再选快照(停下就撤兜底,直到下一次 setTime / 播放)
    if (!playing && isSettled("front", clip.id)) continue;
    // A3c：播放中**有流分段**的抑制卡不投快照（贴流）；缺分段 / 暂停 / 拖动时照投
    if (playing && streamCovers(clip.id, globalFrame)) continue;
    let picked: Pick | null = null;
    for (const kind of KIND_ORDER) {
      const layer = layerOf(readyIndex, clip.id, kind);
      if (!layer) continue;
      const hit = pickLayerSnapshot({ layer, globalFrame, firstFrame, count, anchors }) as
        { kind: ReadyKind; key: string; localFrame: number } | null;
      if (!hit) continue;
      picked = { clipId: clip.id, kind: hit.kind, key: hit.key, localFrame: hit.localFrame, id: `${hit.kind}/${hit.key}/${hit.localFrame}` };
      break;
    }
    if (picked) picks.set(clip.id, picked);
    /*
     * 缺口报给预渲染进程（C4）：本次回溯了（选中的不是当前这一帧）或者干脆缺料的层，
     * 各报它**当前想要的**那一帧。全局帧号。
     */
    const wantLocal = globalFrame - firstFrame;
    if (wantLocal >= 0 && wantLocal < count && (!picked || picked.localFrame !== wantLocal) && wanted.length < MAX_WANTED) {
      wanted.push({ clipId: clip.id, frame: globalFrame });
    }
  }
  return { heavy: heavy.sort(), picks, wanted };
}

/** 缺的那几帧发起取字节；到货后叫一次 `onArrive` 让宿主重投 */
function fetchMissing(picks: Map<string, Pick>): void {
  for (const pick of picks.values()) {
    if (have.has(pick.id) || flying.has(pick.id)) continue;
    flying.add(pick.id);
    void source.fetchSnapshot(pick.kind, pick.key, pick.localFrame)
      .then((html) => {
        have.set(pick.id, html);
        onArrive?.();
      })
      .catch(() => { /* 还没就绪：那一层这一拍透明，下一次 C4 会再选一次 */ })
      .finally(() => { flying.delete(pick.id); });
  }
}

/**
 * 手里已经有的那些拼成一份增量（相对该 iframe 的基线）。**不改基线** ——
 * 真的发出去之后才改（`commit`）。
 */
function diffAgainst(role: StageRole, picks: Map<string, Pick>, reset = false): { patch: Record<string, string | null>; next: Map<string, string> } {
  const base = baselines[role];
  // 带 `reset` 的那一次:舞台上的快照会被先清空,所以基线也要从零算起、把该挂的重新投一遍
  const mounted = reset ? new Map<string, string>() : base.mounted;
  const patch: Record<string, string | null> = {};
  const next = new Map(mounted);
  for (const [clipId, pick] of picks) {
    if (mounted.get(clipId) === pick.id) continue;
    const html = have.get(pick.id);
    if (html === undefined) continue;   // 还没到货：这一层保持上一张，不闪
    patch[clipId] = html;
    next.set(clipId, pick.id);
  }
  // 不再判重 / 不再活跃 / 选不出帧的：摘掉
  for (const clipId of mounted.keys()) {
    if (picks.has(clipId)) continue;
    patch[clipId] = null;
    next.delete(clipId);
  }
  return { patch, next };
}

/** A3c：一次投递 ≤ 2 MB，超了就拆 */
function splitPatch(patch: Record<string, string | null>): Record<string, string | null>[] {
  const entries = Object.entries(patch);
  const chunks: Record<string, string | null>[] = [];
  let cur: Record<string, string | null> = {};
  let bytes = 0;
  for (const [clipId, html] of entries) {
    const size = html === null ? 0 : html.length;
    if (bytes && bytes + size > SNAPSHOT_DELIVERY_MAX_BYTES) {
      chunks.push(cur);
      cur = {};
      bytes = 0;
    }
    cur[clipId] = html;
    bytes += size;
  }
  if (Object.keys(cur).length || !chunks.length) chunks.push(cur);
  return chunks;
}

/**
 * 同步取出「这一次 `setTime` 能一起带过去」的那一份（E0：和 `t` 在同一次 React 提交里生效），
 * 顺带把缺的那几帧发起取字节、把缺口报给预渲染进程。
 *
 * `awaiting`（E0）**只给**「当前位置判重、且就绪索引里有这一层的表」的片段，而且只在
 * 「本次新挂载又没带快照」或「从活渲切回 `snapshots` 又没带快照」时加 —— 两个判据只有父页
 * 知道，所以由父页点名。判轻位置上的卡、被抑制的卡、轻卡从不带它（任务书「不做」）。
 */
export function pickForSetTime(head: Playhead): { snapshots: Record<string, string | null>; awaiting: string[] } {
  // 新的一次 setTime:上一次暂停态的 settled 作废(这一刻重新按兜底顺序选)
  clearSettled("front");
  const feed = planFeed(head);
  fetchMissing(feed.picks);
  if (feed.wanted.length) pushWanted(feed.wanted);
  const base = baselines.front;
  const { patch, next } = diffAgainst("front", feed.picks);
  const awaiting: string[] = [];
  for (const clipId of feed.heavy) {
    // 这一层有表（预渲染进程认这张卡）才等；没有表的层等也等不来，只会白藏 500 ms
    const hasTable = KIND_ORDER.some((kind) => layerOf(readyIndex, clipId, kind));
    if (!hasTable) continue;
    // 这一次带上快照了 / 上一帧就挂着同一张 → 不用等
    if (patch[clipId] !== undefined && patch[clipId] !== null) continue;
    if (base.mounted.has(clipId) && patch[clipId] !== null) continue;
    awaiting.push(clipId);
  }
  base.mounted = next;
  base.lastSentAt = performance.now();
  /*
   * `setTime` 自己会把 `snapshots` 当增量应用（不 reset），所以这一次算把基线兑现了；
   * 真要 `reset` 的话由 `deliver` 那条路走（它发的是 `setSnapshots`）。
   */
  base.needsReset = false;
  return { snapshots: patch, awaiting };
}

/**
 * 投一次（播放中、或者字节到货之后的补投）。`reset` 时不受 33 ms 节流（A3c：
 * 互换后的首次投递）。回的是这次真的发了几条 —— 没什么可发的时候一条 RPC 都不发。
 */
export async function deliverSnapshots(stage: StageRpcClient, role: StageRole, head: Playhead): Promise<number> {
  // 播放中没有「停下就精确」这回事:settled 作废
  if (head.playing) clearSettled(role);
  const feed = planFeed(head);
  fetchMissing(feed.picks);
  if (feed.wanted.length) pushWanted(feed.wanted);
  const base = baselines[role];
  const now = performance.now();
  if (!base.needsReset && now - base.lastSentAt < SNAPSHOT_THROTTLE_MS) return 0;
  const reset = base.needsReset;
  const { patch, next } = diffAgainst(role, feed.picks, reset);
  if (!reset && !Object.keys(patch).length) return 0;
  const chunks = splitPatch(patch);
  base.mounted = next;
  base.needsReset = false;
  base.lastSentAt = now;
  let sent = 0;
  for (let i = 0; i < chunks.length; i++) {
    try {
      await stage.setSnapshots(chunks[i], i === 0 && reset ? { reset: true } : {});
      sent++;
    } catch {
      // iframe 正在换：基线跟着客户端作废，下一次带 reset
      base.needsReset = true;
      break;
    }
  }
  return sent;
}

/**
 * K3(b)：播放中正在等后台补跑的 `vtOk = false` **轻卡**也要抑制（藏子树、`t` 冻住）。
 * 它没有流平面也没有快照，抑制 = 透明 —— 这就是 pinned 渲染 6 的「不可见」，
 * 等待期间用户看不到它用错状态跳变。互换之后这份就清空（新 `front` 的 `H(T)` 里没有它）。
 */
let extraSuppressed: readonly string[] = [];
export function setExtraSuppressed(clipIds: readonly string[]): void {
  extraSuppressed = [...clipIds];
}

/**
 * R8：这一刻的流平面（C3 末段：由就绪索引里 `kind: 'stream'` 的层合成）。只在播放中、只给被抑制的卡。
 * 父页在发 `setSuppressed(H(t))` 的同一处发 `setStreamPlanes(...)`。
 */
export function streamPlanesAt(head: Playhead): StreamPlaneRequest[] {
  if (!head.playing) return [];
  const layers: { clipId: string; key: string; ranges: Array<[number, number]>; groupClipIds?: string[] }[] = [];
  for (const [clipId, byKind] of readyIndex) {
    const layer = byKind.get("stream");
    if (layer) layers.push({ clipId, key: layer.key, ranges: layer.ranges as Array<[number, number]>, groupClipIds: layer.groupClipIds });
  }
  if (!layers.length) return [];
  const fps = Math.max(1, head.project.fps || 30);
  return streamPlanesFor(layers, new Set(suppressedAt(head)), Math.floor(head.t * fps + 1e-6));
}

/** 这一刻该抑制哪几张（播放中才有，C5 / K5） */
export function suppressedAt(head: Playhead): string[] {
  if (!head.playing) return [];
  const heavy = planFeed(head).heavy;
  if (!extraSuppressed.length) return heavy;
  return [...new Set([...heavy, ...extraSuppressed])].sort();
}

/** 测试用 */
export function resetSnapshotFeed(): void {
  stopSnapshotFeed();
  anchorsFor = null;
  source = new HttpSnapshotSource();
}
