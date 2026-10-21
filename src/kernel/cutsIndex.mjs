/**
 * 停放剪辑的片段索引:给 Agent 先读的那几样东西(get_project、list_cuts、工具回包里的 timeline)用。
 *
 * 为什么有它:这些读出来的 tracks / timeline 都只是**激活剪辑**的。模型要改别的剪辑里的片段,先得有 clipId;
 * 没有索引时,它想「看进」剪辑2 的办法就是 switch_cut,而激活的剪辑是所有成员共享的状态,切换会让每个人的界面
 * 一起翻(`product/project-model.md` 「剪辑」,2026-10-21 用户定:按片段 id 改属性的工具就地改别的剪辑里的片段,不切换)。
 * 线上 2026-10-21:工具说明与系统提示词都写了「不用切」,模型仍 switch_cut -> update_clip -> switch_cut。
 * 把 clipId 直接摆在它第一眼读到的地方,切换就失去了理由。
 *
 * 纯 JS(.mjs):页面侧 handler 与服务端的 projectView 共用,不经 TS。只读,不碰 store。
 * 输出有上限(总片段数、每条剪辑片段数),超出的给计数并指向 list_cuts({cutId}) —— 那一个给整条剪辑。
 */

/** 默认上限:总共最多列这么多片段 / 每条剪辑最多这么多 / 标签最长这么多字 */
export const CUTS_INDEX_LIMITS = Object.freeze({ maxClips: 60, perCutMax: 30, labelMax: 24 });

/** 写给模型看的一句话。get_project / list_cuts 的索引里带一份 */
export const PARKED_EDIT_NOTE =
  "这些是没有激活的剪辑里的片段。改它们不用 switch_cut:把 clipId 直接交给 update_clip / set_clip / get_clip / " +
  "set_position / set_rect / align / nudge / set_emphasis / set_clip_volume / set_clip_muted,它们就地改那条剪辑里的片段。" +
  "激活的剪辑是所有成员共享的,switch_cut 会让每个人的界面一起翻,只有要在别的剪辑里新增 / 删除 / 切分 / 复制片段或看画面时才切。" +
  "trackId 要用那条剪辑自己的序列 id(下面每个片段带着)。";

const round2 = (n) => Math.round(n * 100) / 100;

function activeIdOf(p) {
  const cuts = Array.isArray(p?.cuts) ? p.cuts : [];
  if (!cuts.length) return undefined;
  return p.activeCutId && cuts.some((c) => c?.id === p.activeCutId) ? p.activeCutId : cuts[0].id;
}

/**
 * @param {object} project
 * @param {{ maxClips?: number, perCutMax?: number, labelMax?: number, cardName?: (cardId: string) => string | undefined }} [opts]
 *   `cardName`:页面侧有卡片注册表时传,片段多带一个卡片的显示名,方便按「粒子背景」这类说法对上号
 * @returns {null | {
 *   activeCutId: string, note: string,
 *   cuts: { cutId: string, name: string, duration: number, clipCount: number, trackCount: number,
 *           clips: object[], omitted?: number, more?: string }[]
 * }} 项目只有一条剪辑(没有停放的)时返回 null
 */
export function parkedCutsIndex(project, opts = {}) {
  const cuts = Array.isArray(project?.cuts) ? project.cuts : [];
  if (cuts.length < 2) return null;
  const activeCutId = activeIdOf(project);
  const maxClips = Math.max(0, opts.maxClips ?? CUTS_INDEX_LIMITS.maxClips);
  const perCutMax = Math.max(0, opts.perCutMax ?? CUTS_INDEX_LIMITS.perCutMax);
  const labelMax = Math.max(1, opts.labelMax ?? CUTS_INDEX_LIMITS.labelMax);
  let budget = maxClips;
  const out = [];
  for (const c of cuts) {
    if (!c || c.id === activeCutId) continue;
    const tracks = Array.isArray(c.tracks) ? c.tracks : [];
    const flat = [];
    for (const tr of tracks) for (const cl of Array.isArray(tr?.clips) ? tr.clips : []) flat.push([tr, cl]);
    const take = Math.min(perCutMax, budget, flat.length);
    budget -= take;
    const clips = flat.slice(0, take).map(([tr, cl]) => {
      const label = typeof cl.label === "string" && cl.label ? (cl.label.length > labelMax ? `${cl.label.slice(0, labelMax)}…` : cl.label) : undefined;
      const name = cl.cardId && opts.cardName ? opts.cardName(cl.cardId) : undefined;
      return {
        id: cl.id,
        trackId: tr.id,
        ...(cl.cutId ? { cutSegmentOf: cl.cutId } : cl.cardId ? { cardId: cl.cardId } : cl.mediaId ? { mediaId: cl.mediaId } : null),
        ...(name ? { cardName: name } : null),
        ...(label ? { label } : null),
        start: round2(cl.start),
        end: round2(cl.end),
      };
    });
    const omitted = flat.length - clips.length;
    out.push({
      cutId: c.id,
      name: c.name,
      duration: round2(typeof c.duration === "number" && c.duration > 0 ? c.duration : 30),
      trackCount: tracks.length,
      clipCount: flat.length,
      clips,
      ...(omitted > 0 ? { omitted, more: `还有 ${omitted} 个片段没列出,用 list_cuts({ cutId: "${c.id}" }) 看这条的全部` } : null),
    });
  }
  return { activeCutId, note: PARKED_EDIT_NOTE, cuts: out };
}

/**
 * 工具回包里 timeline 旁边的轻量提示:有哪些别的剪辑、各有几个片段。不列片段(每次回包都带,要省),
 * 指路到 get_project 的 parkedCuts / list_cuts({ cutId })。没有别的有内容的剪辑时返回 null。
 * @param {object} project
 * @returns {null | { cuts: { cutId: string, name: string, clipCount: number }[], hint: string }}
 */
export function otherCutsHint(project) {
  const cuts = Array.isArray(project?.cuts) ? project.cuts : [];
  if (cuts.length < 2) return null;
  const activeCutId = activeIdOf(project);
  const rest = [];
  for (const c of cuts) {
    if (!c || c.id === activeCutId) continue;
    let n = 0;
    for (const tr of Array.isArray(c.tracks) ? c.tracks : []) n += Array.isArray(tr?.clips) ? tr.clips.length : 0;
    if (n > 0) rest.push({ cutId: c.id, name: c.name, clipCount: n });
  }
  if (!rest.length) return null;
  return {
    cuts: rest,
    hint: "上面的 timeline 只是激活剪辑的。别的剪辑里的片段不用 switch_cut:clipId 在 get_project 的 parkedCuts 或 list_cuts({ cutId }) 里,直接交给 update_clip 等就地改。",
  };
}
