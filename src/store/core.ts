// 本文件导出的内部可变状态与写入原语(state、listeners、history、future、emit、set、
// setProject 以及各个纯函数辅助)只给 src/store/actions 用,属于包内可见性;
// 外部一律走 project.ts —— 它只转出 EditorState / planPlacement / getState /
// subscribe / useStore / actions 这几个公开名字。
import { useSyncExternalStore } from "react";
import { createEmptyProject, type Project, type Track, type TrackClip } from "../kernel/project";
import { type Transition } from "../kernel/transitions";

/**
 * 编辑器状态存储(单例)。所有面板、时间轴、MCP 工具都通过这里读写,不直接改 Project 对象。
 * 用法:const project = useStore(s => s.project);  actions.addClip(...)
 * 每个 action 都是同步的、产生新对象(不可变更新),方便撤销和 React 重渲染。
 */

export interface EditorState {
  project: Project;
  /** 播放头(秒) */
  t: number;
  playing: boolean;
  /** 每次 seek/重播 +1,Stage 用它重新挂载卡片 */
  playToken: number;
  /** 选中的 clip id(可多选,第一个是主选) */
  selection: string[];
  /** 项目文件路径(未保存为 null) */
  filePath: string | null;
  dirty: boolean;
  /** 用户手动拖范围卡标设定的总时长，没设过就是 null */
  durationManual: number | null;
  /**
   * 上一次用过的三维视角。关掉三维(camera3dFov 被抹掉)时记在这儿,再打开就回到那个值。
   *
   * **不落盘**:存盘结果要和从没开过三维一样。放在 store 而不是模块变量,是因为模块变量
   * 跨项目存活 —— A 项目调过 60、关掉,再打开一个从没开过三维的 B 项目,B 会莫名其妙拿到 60。
   * 挂在这儿,loadProject 顺手清掉就干净了。
   */
  lastCamera3dFov: number | null;
  /** 预览总音量 0–1(只影响预览,不写进项目;导出由 ffmpeg 合成原音) */
  volume: number;
  /** 预览静音开关,和 volume 分开记,取消静音能回到原音量 */
  muted: boolean;
}

type Listener = () => void;

/** 预览音量记在本机,跟项目无关 */
export const VOLUME_KEY = "pc.volume";
export function readVolume(): number {
  try {
    const v = parseFloat(localStorage.getItem(VOLUME_KEY) ?? "");
    if (Number.isFinite(v)) return Math.max(0, Math.min(1, v));
  } catch {}
  return 0.7;
}

export let state: EditorState = {
  project: createEmptyProject(),
  t: 0,
  playing: false,
  playToken: 1,
  selection: [],
  filePath: null,
  dirty: false,
  durationManual: null,
  lastCamera3dFov: null,
  volume: readVolume(),
  muted: false,
};
export const listeners = new Set<Listener>();
export const history: Project[] = [];
export const future: Project[] = [];

export function emit() {
  for (const l of listeners) l();
}

export function set(patch: Partial<EditorState>) {
  state = { ...state, ...patch };
  emit();
}

export interface SetProjectOptions {
  /** false:不进撤销栈 */
  undoable?: boolean;
  /**
   * 数字框连续输入:同一个 key、300 ms 内的修改合并成撤销栈上的一步。
   * 不传就和以前一样,每次一步。
   */
  mergeKey?: string;
}

/**
 * 连上文档服务时接管项目写入与撤销的一方(docsync.ts 的 bindStore 装上)。
 * 没装时(缺省)一切照旧:整份替换 + history / future 快照栈。
 * 两种模式对 actions 与界面的接口一样:setProject / undo / redo / canUndo / canRedo。
 */
export interface ProjectSyncHooks {
  /** 本地改成 next;返回真正落地的那一份(键的顺序可能与 next 不同,内容相同) */
  commit(prev: Project, next: Project, opts: SetProjectOptions): Project;
  /** 整份换成另一份内容(打开 .proc 等);返回落地的那一份 */
  load(project: Project): Project;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  /** 等所有本地修改都拿到文档服务的确认(.proc 保存前等它);没接文档服务时没有这一项 */
  whenSettled?(opts?: { timeoutMs?: number }): Promise<{ rev: number; project: Project }>;
}

let projectSync: ProjectSyncHooks | null = null;

export function attachProjectSync(hooks: ProjectSyncHooks | null) {
  projectSync = hooks;
}

export function getProjectSync(): ProjectSyncHooks | null {
  return projectSync;
}

/** 快照栈模式下的合并判据:上一次带 mergeKey 的修改,以及它落地后的那一份项目 */
let lastMerge: { key: string; at: number; project: Project } | null = null;
export const MERGE_WINDOW_MS = 300;

/** 改项目文档(会进撤销栈) */
export function setProject(next: Project, opts: SetProjectOptions = {}) {
  if (projectSync) {
    const landed = projectSync.commit(state.project, next, opts);
    set({ project: landed, dirty: true });
    return;
  }
  if (opts.undoable !== false) {
    const now = Date.now();
    // 同一个数字框的连续输入:上一步就是它、中间没有别的修改、300 ms 内 → 不另起一步
    const merge = !!opts.mergeKey && lastMerge !== null && lastMerge.key === opts.mergeKey && lastMerge.project === state.project && now - lastMerge.at <= MERGE_WINDOW_MS && history.length > 0;
    if (!merge) {
      history.push(state.project);
      if (history.length > 100) history.shift();
    }
    future.length = 0;
    lastMerge = opts.mergeKey ? { key: opts.mergeKey, at: now, project: next } : null;
  }
  set({ project: next, dirty: true });
}

/** 把一条转场写下的淡化擦掉(片段可能已经不在了,擦不到就跳过) */
export function clearTransitionFades(p: Project, tr: Transition): Project {
  const clear = (clipId: string | undefined, side: "fadeIn" | "fadeOut") => {
    if (!clipId) return;
    p = {
      ...p,
      tracks: p.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => (c.id === clipId ? { ...c, [side]: 0 } : c)),
      })),
    };
  };
  if (tr.kind === "crossfade") {
    clear(tr.aId, "fadeOut");
    clear(tr.bId, "fadeIn");
  } else {
    clear(tr.aId, tr.kind === "fadeIn" ? "fadeIn" : "fadeOut");
  }
  return p;
}

export function updateTrack(p: Project, trackId: string, fn: (t: Track) => Track): Project {
  return { ...p, tracks: p.tracks.map((t) => (t.id === trackId ? fn(t) : t)) };
}

/**
 * 删片段 / 删序列之后剔掉没人要的图卡节点。
 *
 * cardNodes 的写入方只有 cardAuthoring,片段是它唯一的入口,所以判据就是
 * 「从还在的片段出发走不走得到」。走不到的、以及输入指着已删片段那个合成源
 * (`@clip/<id>/source`)的,连同它的下游一起剔掉 —— 留着的话 projectCardGraph
 * 每次都要靠丢边规则兜,而那条规则是留给「图已经存盘」的旧项目的。
 */
export function pruneCardNodes(p: Project): Project {
  const nodes = p.cardNodes;
  if (!nodes?.length) return p;
  const clips = p.tracks.flatMap((t) => t.clips);
  const liveClipIds = new Set(clips.map((c) => c.id));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const refsOf = (n: (typeof nodes)[number]) =>
    Object.values(n.inputs ?? {}).map((r) => (typeof r === "string" ? r : r?.nodeId)).filter((x): x is string => !!x);
  const keep = new Set<string>();
  const walk = (id?: string) => {
    if (!id || keep.has(id) || !byId.has(id)) return;
    keep.add(id);
    for (const ref of refsOf(byId.get(id)!)) walk(ref);
  };
  for (const clip of clips) walk(clip.nodeId);
  for (let changed = true; changed; ) {
    changed = false;
    for (const id of [...keep]) {
      const dangling = refsOf(byId.get(id)!).some((ref) => {
        if (ref.startsWith("@clip/")) {
          const owner = /^@clip\/(.+)\/[^/]+$/.exec(ref);
          return !owner || !liveClipIds.has(owner[1]);
        }
        return !keep.has(ref);
      });
      if (dangling) { keep.delete(id); changed = true; }
    }
  }
  if (keep.size === nodes.length) return p;
  const next: Project = { ...p, cardNodes: nodes.filter((n) => keep.has(n.id)) };
  if (!clips.some((c) => c.nodeId && !keep.has(c.nodeId))) return next;
  // 节点没了的片段把 nodeId 一并擦掉:留着就是一个指向不存在节点的引用
  return { ...next, tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => {
    if (!c.nodeId || keep.has(c.nodeId)) return c;
    const { nodeId: _gone, ...rest } = c;
    return rest;
  }) })) };
}

/**
 * 把一组片段整体平移 dt 秒。轨内不能重叠、不能被推到 0 之前 —— 有一处放不下就整组不动
 * (返回 null),不做「挪一半」这种半吊子结果。组内的相对关系原样保留,所以转场不会散。
 */
export function shiftClipsBy(p: Project, ids: string[], dt: number): Project | null {
  const set = new Set(ids);
  let found = 0;
  const tracks = p.tracks.map((t) => ({
    ...t,
    clips: sortClips(
      t.clips.map((c) => {
        if (!set.has(c.id)) return c;
        found++;
        return { ...c, start: c.start + dt, end: c.end + dt };
      }),
    ),
  }));
  if (found !== set.size) return null;
  for (const t of tracks) {
    for (let i = 0; i < t.clips.length; i++) {
      if (t.clips[i].start < -1e-6) return null;
      if (i > 0 && t.clips[i].start < t.clips[i - 1].end - 1e-6) return null;
    }
  }
  return { ...p, tracks };
}

export function sortClips(clips: TrackClip[]): TrackClip[] {
  return [...clips].sort((a, b) => a.start - b.start);
}

/**
 * 轨内不重叠:把 clip 夹到相邻 clip 之间,时长不变。
 * 空档放不下整段时返回 null(调用方拒绝这次移动),不再把 clip 压扁。
 */
export function resolveOverlap(track: Track, clip: TrackClip): TrackClip | null {
  const others = track.clips.filter((c) => c.id !== clip.id);
  let { start, end } = clip;
  const len = Math.max(0.1, end - start);
  const mid = start + len / 2;
  const prev = others.filter((c) => c.end <= mid).sort((a, b) => b.end - a.end)[0];
  const next = others.filter((c) => c.start >= mid).sort((a, b) => a.start - b.start)[0];
  const lo = prev ? prev.end : 0;
  const hi = next ? next.start : Infinity;
  if (hi - lo < len - 1e-6) return null;
  start = Math.max(lo, Math.min(start, hi - len));
  end = start + len;
  return { ...clip, start: Math.max(0, start), end };
}

/** 新增用:原位放不下就往后找第一个放得下的空档(时长不变)。 */
export function placeOrShift(track: Track, clip: TrackClip): TrackClip {
  const fit = resolveOverlap(track, clip);
  if (fit) return fit;
  const len = Math.max(0.1, clip.end - clip.start);
  const sorted = [...track.clips].filter((c) => c.id !== clip.id).sort((a, b) => a.start - b.start);
  let cursor = clip.start;
  for (const c of sorted) {
    if (c.end <= cursor) continue;
    if (c.start - cursor >= len) break;
    cursor = Math.max(cursor, c.end);
  }
  return { ...clip, start: cursor, end: cursor + len };
}

/**
 * 落点预演:用和落卡完全相同的规则算一遍新片段会落在哪,但不改文档。
 * 时间轴的落点预览用它,保证「拖动时看到的位置」和松手后真正落下的位置一致。
 * shifted = 原位放不下、被顺延到了后面的空档。
 */
export function planPlacement(track: Track, start: number, dur: number): { start: number; end: number; shifted: boolean } {
  const from = Math.max(0, start);
  const probe: TrackClip = { id: "__probe", cardId: "", start: from, end: from + dur, params: {} };
  const placed = placeOrShift(track, probe);
  return { start: placed.start, end: placed.end, shifted: Math.abs(placed.start - from) > 1e-6 };
}

/**
 * 不指定序列时该落在哪条:挑第一条这个时间段空着的序列(序列不分种类了,所以只看占没占)。
 * 都放不下就用第一条没锁的,由 placeOrShift 往后顺延。
 */
export function pickTrack(p: Project, start: number, dur: number): Track | undefined {
  const free = p.tracks.find(
    (t) => !t.locked && !t.clips.some((c) => Math.max(start, c.start) < Math.min(start + dur, c.end)),
  );
  return free ?? p.tracks.find((t) => !t.locked) ?? p.tracks[0];
}


;

export function getState(): EditorState {
  return state;
}

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useStore<T>(selector: (s: EditorState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state), () => selector(state));
}