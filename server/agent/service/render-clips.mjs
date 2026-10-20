/**
 * 云端 Agent 一次写入落地后,要发布预渲染的片段(`render-request.mjs` 的清单计划用)。
 *
 * 顶层片段照旧按这次写到的片段 id 挑(`renderableClips`)。剪辑段里的卡(用户 2026-10-21 定:剪辑段里的卡和没有剪辑段时一样,
 * 重卡各自走轨道流)在计划一侧是摊平视图里的虚拟片段(`src/kernel/cutFlatten.mjs`,id `<段 id>~…~<卡的片段 id>`),渲染节点
 * 按这个 id 产流。所以还要收:
 *   - 路径上有这次写到的片段 id 的虚拟片段(改了被引用剪辑里的卡、改了某一层剪辑段;任意深度,同一剪辑被引用几次就有几份);
 *   - 和上一次相比内容变了或新出现的虚拟片段(`before`:上一次写入之后的签名表)。别的剪辑里的改动、切换激活剪辑这类写入,
 *     ops 里点不出激活剪辑里的片段 id,只能靠比对摊平视图看出来。没有上一次的签名表时(这一代进程的第一次写入)全部收,
 *     宁可多发(渲染节点已经有的流照锁复用,不重产)。
 * 素材片段不收。没有剪辑段的项目结果与 `renderableClips` 逐项相同。
 */
import { flatPlanProject, hasFlatSegments, isFlatClipId, FLAT_SEP } from '../../../src/kernel/cutFlatten.mjs';
import { MEDIA_CARD_IDS, renderableClips } from './render-request.mjs';

/** 激活剪辑摊平视图里每张剪辑段里的卡(虚拟片段)的内容签名;没有剪辑段回空表 */
export function flatCardSigs(project) {
  const out = new Map();
  if (!project || !hasFlatSegments(project)) return out;
  for (const tr of flatPlanProject(project).tracks ?? []) {
    if (!tr || tr.hidden || tr.sourceOnly) continue;
    for (const c of tr.clips ?? []) {
      if (!c || !isFlatClipId(c.id) || typeof c.cardId !== 'string' || !c.cardId || MEDIA_CARD_IDS.has(c.cardId)) continue;
      out.set(c.id, JSON.stringify(c));
    }
  }
  return out;
}

/**
 * @param {any} project 写入之后的项目
 * @param {string[]} clipIds 这次写到的片段 id(`user-editing.mjs` 的 `clipIdsOfOps`)
 * @param {{ before?: Map<string, string> | null, sigs?: Map<string, string> }} [o]
 */
export function renderClipsOf(project, clipIds, { before = null, sigs = flatCardSigs(project) } = {}) {
  const out = renderableClips(project, clipIds);
  if (!sigs.size) return out;
  const want = new Set(Array.isArray(clipIds) ? clipIds : []);
  const seen = new Set(out);
  for (const [id, sig] of sigs) {
    const hit = id.split(FLAT_SEP).some((part) => want.has(part)) || !before || before.get(id) !== sig;
    if (hit && !seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}

/** 有状态的挑法:记着上一次写入之后的签名表(一个对话 / 一个任务进程一份) */
export function createRenderClipPicker() {
  let before = null;
  return {
    pick(project, clipIds) {
      const sigs = flatCardSigs(project);
      const clips = renderClipsOf(project, clipIds, { before, sigs });
      before = sigs;
      return clips;
    },
    /** 先记一份(绑定之后、第一次写入之前),第一次写入就只收变了的 */
    prime(project) { before = flatCardSigs(project); },
  };
}
