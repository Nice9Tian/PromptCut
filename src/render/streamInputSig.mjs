/**
 * 层表 `streams` 表每一行的「输入签名」(`inputSig`):生成这条轨道流的那一版项目输入的摘要。在线页面按当前项目算同一个签名,
 * 对不上就是旧输入的流,不播(`mechanism/rendering.md`「兜底顺序」的「旧输入的层不贴」,这里用在流上)。
 *
 * 为什么不直接用快照层的 `clipInputSig`(`layerInputSig.mjs`):流和快照装的东西不一样。
 *   - 快照按片段的**本地帧**取,位置、缩放、淡入淡出都不在快照里,所以片段整帧平移、挪位置都照贴;
 *   - 流按**全局帧号**分段(`streamPlayer.ts`),片段在时间轴上挪了,旧流的每一帧就都对不上时刻;
 *   - 组流画在舞台坐标里,成员的摆放(位置、缩放、旋转、不透明度、淡入淡出、motion)和成员之间的上下顺序都画进了流。
 *
 * 进签名:
 *   - 每个成员的 `clipInputSig`(片段自己的输入,口径见 `layerInputSig.mjs`);
 *   - 每个成员在时间轴上的采样窗口:第一帧的全局帧号、帧数(同预渲染的 `cardSampling`)、被项目时长截到哪一帧;
 *   - 组流另加:每个成员的框、不透明度、淡入淡出、motion;成员按画家顺序排的 id 序列;夹在成员之间、时间上重叠的别的画面层
 *     (写层表时一定是空的;页面上不空,说明有人往组中间插了一层,这条组流的上下关系已经不对)。
 * 不进签名:卡片源码、字体、环境(页面拿不到同口径的值),这几样变了靠渲染节点换键重写层表。
 *
 * 签名带算法版本前缀(`s1-`),比法同 `inputSigStale`:两边都有、同一版本、而且不同才算过期。
 * 纯函数;服务端(`server/artifact-transfer.mjs` 的 `layerMapOf`)与页面(`snapshotSource.ts`)共用这一份。
 */
import { cardJson } from "../kernel/cardGraph.mjs";
import { hashString } from "./changedClips.mjs";
import { clipInputSig } from "./layerInputSig.mjs";

/** 签名算法的版本;改了进签名的内容就加一 */
export const STREAM_INPUT_SIG_VERSION = 1;
const PREFIX = `s${STREAM_INPUT_SIG_VERSION}-`;

/** 片段的采样窗口(与 `snapshotFeed.ts` 的 `samplingOf`、预渲染的 `cardSampling` 同一个算式),再按项目时长截断 */
function windowOf(clip, fps, total) {
  const start = Number(clip.start) || 0;
  const end = Number(clip.end) || 0;
  const firstFrame = Math.max(0, Math.ceil(start * fps - 1e-9));
  const phase = firstFrame / fps - start;
  const count = Math.max(1, Math.ceil((end - start - phase) * fps - 1e-9));
  return { firstFrame, count, last: Math.min(total - 1, firstFrame + count - 1) };
}

/**
 * 这条流的签名输入(还没哈希的那份对象);有成员不在项目里、或成员的片段签名算不出时回 null。导出给单测看口径。
 * @param {any} project
 * @param {{ clipIds: readonly string[], kind?: string }} stream
 */
export function streamInputs(project, stream) {
  const ids = Array.isArray(stream?.clipIds) ? stream.clipIds.filter((id) => typeof id === "string" && id) : [];
  if (!ids.length) return null;
  const fps = Math.max(1, Number(project?.fps) || 30);
  const total = Math.max(1, Math.floor((Number(project?.duration) || 0) * fps));
  const tracks = Array.isArray(project?.tracks) ? project.tracks : [];
  const media = new Map((Array.isArray(project?.media) ? project.media : []).filter((m) => m && typeof m.id === "string").map((m) => [m.id, m]));
  /** 片段 id → { clip, order, visual };`order` 是画家顺序(第一条序列在最上面,同一条序列里后面的盖前面的) */
  const where = new Map();
  tracks.forEach((track, ti) => {
    (Array.isArray(track?.clips) ? track.clips : []).forEach((clip, ci) => {
      if (!clip || typeof clip.id !== "string" || where.has(clip.id)) return;
      const m = typeof clip.mediaId === "string" ? media.get(clip.mediaId) : null;
      const visual = !track.hidden && !track.sourceOnly && (!!clip.cardId || !!clip.nodeId || (!!m && m.kind !== "audio"));
      where.set(clip.id, { clip, order: (tracks.length - 1 - ti) * 1e6 + ci, visual });
    });
  });
  const group = stream?.kind === "group" || ids.length > 1;
  const members = [];
  for (const id of ids) {
    const at = where.get(id);
    if (!at) return null;
    const sig = clipInputSig(project, id);
    if (!sig) return null;
    const { clip } = at;
    members.push({
      id, sig, window: windowOf(clip, fps, total),
      ...(group ? { frame: clip.frame, opacity: clip.opacity, fadeIn: clip.fadeIn, fadeOut: clip.fadeOut, motion: clip.motion } : {}),
    });
  }
  if (!group) return { v: STREAM_INPUT_SIG_VERSION, kind: "card", members };
  const set = new Set(ids);
  const orders = ids.map((id) => where.get(id).order);
  const lo = Math.min(...orders), hi = Math.max(...orders);
  const from = Math.min(...ids.map((id) => Number(where.get(id).clip.start) || 0));
  const to = Math.max(...ids.map((id) => Number(where.get(id).clip.end) || 0));
  const between = [];
  for (const [id, at] of where) {
    if (set.has(id) || !at.visual || at.order <= lo || at.order >= hi) continue;
    if ((Number(at.clip.start) || 0) < to && (Number(at.clip.end) || 0) > from) between.push(id);
  }
  return {
    v: STREAM_INPUT_SIG_VERSION, kind: "group", members,
    paint: [...ids].sort((a, b) => where.get(a).order - where.get(b).order),
    between: between.sort(),
  };
}

/**
 * 这条流的输入签名(`s1-<16 位十六进制>`);算不出回 null(不比)。
 * @param {any} project
 * @param {{ clipIds: readonly string[], kind?: string }} stream
 * @returns {string | null}
 */
export function streamInputSig(project, stream) {
  try {
    const inputs = streamInputs(project, stream);
    if (!inputs) return null;
    return PREFIX + hashString(cardJson(inputs));
  } catch {
    return null;
  }
}

/** 层表那一行的签名与页面算的签名:两边都有、同一算法版本、而且不同 → 这条流已过期。别的情况不判过期(向后兼容) */
export function streamSigStale(rowSig, pageSig) {
  if (typeof rowSig !== "string" || typeof pageSig !== "string") return false;
  if (!rowSig.startsWith(PREFIX) || !pageSig.startsWith(PREFIX)) return false;
  return rowSig !== pageSig;
}
