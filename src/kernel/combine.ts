/**
 * 三方合并两份项目:base(启动 Skill 时的快照)、ours(用户现在手里的)、theirs(agent 改完的)。
 *
 * 为什么不用 git:装好的软件里没有 git,用户机器上也未必有;.proc 是一份 JSON,
 * git 按行合并遇到数组重排就乱,冲突时直接产出非法 JSON;最后还是得写一个懂结构的
 * 合并 —— 那就是这个文件。
 *
 * 规则(都按 id 对齐,不看顺序):
 *   - 素材:theirs 有、ours 没有 → 加进来。ours 明确删过(base 里有)的,只在 theirs 的 clip
 *     还引用它时才捞回来,并记一条说明;
 *   - 剪辑 / 序列:theirs 新建的整条搬过来;两边都有的逐条合并;
 *   - clip(核心):
 *       theirs 新加           → 加到 theirs 放它的那条序列;那条序列不在、或落点和现有 clip 重叠,
 *                                就放进一条新建的「Skill 结果」序列,不让它盖掉用户的东西;
 *       theirs 改了、ours 没改 → 采用 theirs;
 *       两边都改了              → **保留 ours**,记进 conflicts,由人决定;
 *       theirs 删了、ours 没改 → 删;ours 改过 → 保留 ours,记冲突;
 *       ours 删了、theirs 改了 → 保持删除,记冲突;
 *   - 时长:theirs 的 clip 超出当前时长就拉长,不截断。
 *
 * 纯函数,不碰 store,输入三份 Project 输出新 Project,好在 node 里测(combine.test.mjs)。
 */
import { normalizeCuts } from "./cuts.ts";
import type { Cut, MediaAsset, Project, Track, TrackClip } from "./project.ts";

export interface CombineConflict {
  clipId: string;
  cutId: string;
  /** 一句人话:为什么没合进来 */
  reason: string;
}

export interface CombineReport {
  addedMedia: number;
  addedCuts: number;
  addedTracks: number;
  addedClips: number;
  updatedClips: number;
  deletedClips: number;
  /** 放进「Skill 结果」序列的 clip 数(落点重叠或原序列不在) */
  parkedClips: number;
  conflicts: CombineConflict[];
  notes: string[];
}

export interface CombineResult {
  project: Project;
  report: CombineReport;
}

/** 新建序列的名字。同一条剪辑里多次合并会复用它 */
export const RESULT_TRACK_NAME = "Skill 结果";

/**
 * 「没有 base」时用的空基线。
 *
 * 用户随手挑了一份别处来的 .proc 来合并,那时并没有共同祖先。**不能拿 ours 当 base** ——
 * 那样「我有、对方没有」的每张卡都会被判成「对方删掉的」而静默删除,整个项目被外来文件
 * 整盘替换掉(实测:a,b,c 合一份只有 z 的文件,结果只剩 z)。
 *
 * 空基线让三方合并退化成安全的一边:两边有的都算「新加的」—— 对方多出来的加进来,自己的
 * 一张不动,同一个 id 上内容对不上就记冲突、保留自己的。
 *
 * cut 的 id 用一个真实文件里不可能出现的名字:走 normalizeCuts 时不能补出 `cut-1` 这种
 * 默认 id 去和用户真的剪辑撞上 —— 撞上了那条剪辑就又有 base 了,前面那套误删逻辑会复活。
 */
export function emptyBase(): Project {
  const id = "__pc-no-base__";
  return {
    version: 1, name: "", width: 1920, height: 1080, fps: 30, duration: 0,
    themeId: "default", media: [], tracks: [],
    cuts: [{ id, name: "" }], activeCutId: id,
  };
}

/** 键排序后序列化,用来判断「改没改过」。不看顺序、不看 undefined */
function fingerprint(v: unknown): string {
  return JSON.stringify(v, (_k, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const o = val as Record<string, unknown>;
      return Object.keys(o)
        .sort()
        .filter((k) => o[k] !== undefined)
        .reduce<Record<string, unknown>>((acc, k) => ((acc[k] = o[k]), acc), {});
    }
    return val;
  });
}

const same = (a: unknown, b: unknown) => fingerprint(a) === fingerprint(b);

/** 一条剪辑的内容,不管它在 Project 里是激活的还是停放的 */
interface CutContent {
  id: string;
  name: string;
  tracks: Track[];
  duration: number;
  t?: number;
}

/** 把 Project 摊成「每条剪辑各自带内容」的形状,激活那条的内容从 Project 顶层取 */
function cutContents(p: Project): CutContent[] {
  const n = normalizeCuts(p);
  return (n.cuts ?? []).map((c) =>
    c.id === n.activeCutId
      ? { id: c.id, name: c.name, tracks: n.tracks, duration: n.duration, t: c.t }
      : { id: c.id, name: c.name, tracks: c.tracks ?? [], duration: c.duration ?? 0, t: c.t },
  );
}

/** 反过来:把摊平的剪辑装回 Project */
function assemble(ours: Project, cuts: CutContent[]): Project {
  const n = normalizeCuts(ours);
  const activeId = n.activeCutId!;
  const active = cuts.find((c) => c.id === activeId) ?? cuts[0];
  const parked: Cut[] = cuts.map((c) =>
    c.id === active.id
      ? { id: c.id, name: c.name, ...(c.t !== undefined ? { t: c.t } : {}) }
      : { id: c.id, name: c.name, tracks: c.tracks, duration: c.duration, ...(c.t !== undefined ? { t: c.t } : {}) },
  );
  return { ...n, tracks: active.tracks, duration: active.duration, cuts: parked, activeCutId: active.id };
}

interface ClipAt {
  clip: TrackClip;
  trackId: string;
}

/** 一条剪辑里所有 clip 按 id 索引,顺带记住在哪条序列上 */
function indexClips(tracks: Track[]): Map<string, ClipAt> {
  const m = new Map<string, ClipAt>();
  for (const t of tracks) for (const c of t.clips) m.set(c.id, { clip: c, trackId: t.id });
  return m;
}

const overlaps = (a: TrackClip, b: TrackClip) => Math.max(a.start, b.start) < Math.min(a.end, b.end);

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** 合并一条剪辑。三份里可能缺某一份(比如 theirs 新建的剪辑 base/ours 都没有) */
function combineCut(
  base: CutContent | undefined,
  ours: CutContent | undefined,
  theirs: CutContent | undefined,
  report: CombineReport,
): CutContent | null {
  // ours 没有:要么 theirs 新建,要么 ours 删了
  if (!ours) {
    if (!theirs) return null;
    if (!base) {
      report.addedCuts += 1;
      report.addedTracks += theirs.tracks.length;
      report.addedClips += theirs.tracks.reduce((n, t) => n + t.clips.length, 0);
      return deepClone(theirs);
    }
    // ours 删掉了这条剪辑。theirs 要是没动它就随 ours;动了就记一笔,但不复活整条剪辑
    if (!same(base.tracks, theirs.tracks)) {
      report.notes.push(`剪辑「${theirs.name}」你已经删掉,Skill 那边还改过它,这些改动没有合进来`);
    }
    return null;
  }
  if (!theirs) {
    // theirs 删了整条剪辑:ours 没动就删,动过就留
    if (base && same(base.tracks, ours.tracks)) {
      report.deletedClips += ours.tracks.reduce((n, t) => n + t.clips.length, 0);
      return null;
    }
    return deepClone(ours);
  }

  const out: CutContent = deepClone(ours);
  const baseIdx = indexClips(base?.tracks ?? []);
  const ourIdx = indexClips(ours.tracks);
  const theirIdx = indexClips(theirs.tracks);

  // theirs 新建的序列先摆一条**空壳**过来,卡片一张都不跟着搬。
  //
  // 曾经是整条深拷贝(连 clip 一起),再靠下面那个循环「已经搬过就跳过」去重。但那个跳过只认
  // `!o && !b`(真正的新卡),于是两条路漏出来,而且都是静默的数据损坏:
  //   1. 两边都改过同一张卡 → 记完「保留你的」就 continue,ours 那份留在原序列,
  //      theirs 的副本已经在新序列里 → 同一个 clip id 同时活在两条序列上;
  //   2. 用户已经删掉、Skill 那边改过 → 记完「保持删除」就 continue,副本照样进来 → 卡复活。
  // 两种情况下合并报告写的结果和磁盘上的结果是反的。
  //
  // 所以序列归属和卡片归属彻底分开:这里只负责「多出一条序列」,每张卡去哪条序列一律交给
  // 下面按 id 的统一循环(place / park),那里才有 base / ours / theirs 三边的完整信息。
  const carriedTracks = new Set<string>();
  for (const t of theirs.tracks) {
    // 空序列不搬:normalizeCuts 给停放的剪辑补的空序列 id 每次都是新的,base / ours / theirs
    // 三边各补一套,按 id 对不上就会被当成 agent 新建的 —— 合一次多出四条空序列。
    // 真正有内容的新序列照搬;空的对谁都没有信息。
    if (t.clips.length === 0) continue;
    if (!ours.tracks.some((x) => x.id === t.id) && !(base?.tracks ?? []).some((x) => x.id === t.id)) {
      out.tracks.push({ ...deepClone(t), clips: [] });
      carriedTracks.add(t.id);
    }
  }

  const trackOf = (id: string) => out.tracks.find((t) => t.id === id);
  let resultTrack: Track | null = null;
  const park = (clip: TrackClip) => {
    if (!resultTrack) {
      resultTrack = out.tracks.find((t) => t.name === RESULT_TRACK_NAME) ?? null;
      if (!resultTrack) {
        // 后缀不能只有时间戳:一次 combineProjects 是同步跑完的,多条剪辑各自新建结果序列
        // 时 Date.now() 一模一样,几条序列会拿到同一个 id
        resultTrack = { id: `t-skill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, name: RESULT_TRACK_NAME, clips: [] };
        out.tracks.push(resultTrack);
        report.addedTracks += 1;
      }
    }
    // 结果序列里也不能重叠;再撞就往后顺延到空位
    let c = clip;
    while (resultTrack.clips.some((x) => overlaps(x, c))) {
      const last = Math.max(...resultTrack.clips.map((x) => x.end));
      c = { ...c, start: last, end: last + (clip.end - clip.start) };
    }
    resultTrack.clips.push(c);
    resultTrack.clips.sort((a, b) => a.start - b.start);
    report.parkedClips += 1;
  };
  /** 把 clip 放到某条序列上;放不下就进结果序列 */
  const place = (clip: TrackClip, preferTrackId: string, removeFromId?: string) => {
    if (removeFromId) {
      const from = trackOf(removeFromId);
      if (from) from.clips = from.clips.filter((c) => c.id !== clip.id);
    }
    const target = trackOf(preferTrackId);
    if (target && !target.clips.some((c) => c.id !== clip.id && overlaps(c, clip))) {
      target.clips = target.clips.filter((c) => c.id !== clip.id);
      target.clips.push(clip);
      target.clips.sort((a, b) => a.start - b.start);
      return;
    }
    park(clip);
  };

  const ids = new Set<string>([...baseIdx.keys(), ...ourIdx.keys(), ...theirIdx.keys()]);
  for (const id of ids) {
    const b = baseIdx.get(id);
    const o = ourIdx.get(id);
    const t = theirIdx.get(id);

    if (!o) {
      if (!t) continue; // 只有 base 有:两边都删了
      if (!b) {
        // theirs 新加
        place(deepClone(t.clip), t.trackId);
        report.addedClips += 1;
      } else if (!same(b.clip, t.clip)) {
        report.conflicts.push({ clipId: id, cutId: ours.id, reason: "你删掉了这张卡,Skill 那边还改过它;保持删除" });
      }
      continue;
    }
    if (!t) {
      if (!b) continue; // ours 新加的,theirs 从没见过 → 留着
      // 「你没动过」要连它在哪条序列上一起算:只把卡从一条序列拖到另一条,clip 本身
      // 一个字节都没变,光比 same(b.clip, o.clip) 会判成没动,于是静默同意对方的删除,
      // 用户排好的层次白排了
      if (same(b.clip, o.clip) && o.trackId === b.trackId) {
        const tr = trackOf(o.trackId);
        if (tr) tr.clips = tr.clips.filter((c) => c.id !== id);
        report.deletedClips += 1;
      } else {
        report.conflicts.push({ clipId: id, cutId: ours.id, reason: "Skill 删掉了这张卡,你这边改过它;保留你的" });
      }
      continue;
    }
    // 三边都有(或 base 没有但两边都有)
    const theirsChanged = !b || !same(b.clip, t.clip) || b.trackId !== t.trackId;
    const oursChanged = !b || !same(b.clip, o.clip) || b.trackId !== o.trackId;
    if (!theirsChanged) continue;
    if (same(o.clip, t.clip) && o.trackId === t.trackId) continue; // 两边改成了一样的
    if (oursChanged) {
      report.conflicts.push({ clipId: id, cutId: ours.id, reason: "两边都改了这张卡;保留你的" });
      continue;
    }
    place(deepClone(t.clip), t.trackId, o.trackId);
    report.updatedClips += 1;
  }

  // 空壳序列的收尾:上面摆过去的新序列,卡片是由统一循环一张张放进来的。要是它那些卡最后
  // 全被判成「保留你的」或者「保持删除」,这条序列就一张卡都没有 —— 撤掉它,也别报「新增序列」。
  for (const id of carriedTracks) {
    const tr = out.tracks.find((t) => t.id === id);
    if (!tr) continue;
    if (tr.clips.length === 0) out.tracks = out.tracks.filter((t) => t.id !== id);
    else report.addedTracks += 1;
  }

  // 时长:别把 theirs 拉长的部分截掉
  const maxEnd = out.tracks.reduce((m, tr) => Math.max(m, ...tr.clips.map((c) => c.end)), 0);
  if (maxEnd > out.duration) {
    report.notes.push(`剪辑「${out.name}」时长从 ${out.duration}s 拉长到 ${maxEnd}s,装下 Skill 加的内容`);
    out.duration = maxEnd;
  }
  return out;
}

function combineMedia(base: Project, ours: Project, theirs: Project, referenced: Set<string>, report: CombineReport): MediaAsset[] {
  const out = ours.media.map(deepClone);
  const has = (id: string) => out.some((m) => m.id === id);
  for (const m of theirs.media) {
    if (has(m.id)) continue;
    const oursDeleted = base.media.some((x) => x.id === m.id);
    if (oursDeleted && !referenced.has(m.id)) continue;
    if (oursDeleted) report.notes.push(`素材「${m.name}」你已经删掉,但 Skill 加的卡还在用它,已经捞回来`);
    out.push(deepClone(m));
    report.addedMedia += 1;
  }
  return out;
}

export function combineProjects(base: Project, ours: Project, theirs: Project): CombineResult {
  const report: CombineReport = {
    addedMedia: 0, addedCuts: 0, addedTracks: 0, addedClips: 0,
    updatedClips: 0, deletedClips: 0, parkedClips: 0, conflicts: [], notes: [],
  };
  const bCuts = cutContents(base);
  const oCuts = cutContents(ours);
  const tCuts = cutContents(theirs);
  const ids: string[] = [];
  for (const c of [...oCuts, ...tCuts, ...bCuts]) if (!ids.includes(c.id)) ids.push(c.id);

  const merged: CutContent[] = [];
  for (const id of ids) {
    const r = combineCut(bCuts.find((c) => c.id === id), oCuts.find((c) => c.id === id), tCuts.find((c) => c.id === id), report);
    if (r) merged.push(r);
  }
  // ours 一条都不剩的话(理论上不会),至少留一条空的
  if (merged.length === 0) merged.push({ id: "cut-1", name: "剪辑1", tracks: [], duration: 30 });

  const referenced = new Set<string>();
  for (const c of merged) for (const t of c.tracks) for (const clip of t.clips) if (clip.mediaId) referenced.add(clip.mediaId);

  const project = assemble(ours, merged);
  project.media = combineMedia(normalizeCuts(base), normalizeCuts(ours), normalizeCuts(theirs), referenced, report);
  return { project, report };
}

/** 报告压成几行人话,给对话框和 toast 用 */
export function describeReport(r: CombineReport): string[] {
  const lines: string[] = [];
  const bits: string[] = [];
  if (r.addedClips) bits.push(`新增 ${r.addedClips} 张卡`);
  if (r.updatedClips) bits.push(`更新 ${r.updatedClips} 张`);
  if (r.deletedClips) bits.push(`删除 ${r.deletedClips} 张`);
  if (r.addedTracks) bits.push(`新增 ${r.addedTracks} 条序列`);
  if (r.addedCuts) bits.push(`新增 ${r.addedCuts} 条剪辑`);
  if (r.addedMedia) bits.push(`新增 ${r.addedMedia} 个素材`);
  lines.push(bits.length ? bits.join(",") : "没有需要合并的改动");
  if (r.parkedClips) lines.push(`${r.parkedClips} 张卡的落点和你的内容重叠,放进了「${RESULT_TRACK_NAME}」序列`);
  for (const c of r.conflicts) lines.push(`冲突 ${c.clipId}:${c.reason}`);
  lines.push(...r.notes);
  return lines;
}
