import { createRequire } from 'node:module';

/**
 * 审阅表（`src/cards/capabilities.json`）的 Node 侧加载。**表缺失不是错误**：
 * 这份文件是人工审阅的产物，装机包里可以没有它，那时每张卡都按 `unknown` 走，
 * 也就是最保守的那条路（保留下层场景），而不是让整条视觉链路加载失败。
 */
let REVIEW;
function reviewTable() {
  if (REVIEW) return REVIEW;
  try {
    REVIEW = createRequire(import.meta.url)('../src/cards/capabilities.json');
  } catch {
    REVIEW = {};
  }
  return REVIEW;
}

/** 先精确 id，再取最长的 `前缀-*` 通配（和 `frameMode.mjs` 的 `reviewedCard` 同一口径）。 */
export function reviewedCapabilities(cardId) {
  if (typeof cardId !== 'string' || !cardId) return undefined;
  const table = reviewTable();
  const exact = table[cardId];
  if (exact && typeof exact === 'object') return exact;
  let best, bestLen = -1;
  for (const key of Object.keys(table)) {
    if (!key.endsWith('-*')) continue;
    const prefix = key.slice(0, -1);
    if (cardId.startsWith(prefix) && prefix.length > bestLen) { best = table[key]; bestLen = prefix.length; }
  }
  return best && typeof best === 'object' ? best : undefined;
}

/** Hide unrelated outputs without deleting graph inputs. A clip's source can
 * live on its own track, another track, or an otherwise unused card node. */
export function isolateClip(project, clipId, { preserveContext = false, capabilities = reviewedCapabilities } = {}) {
  const targetIndex = (project.tracks || []).findIndex(track => (track.clips || []).some(clip => clip.id === clipId));
  if (targetIndex < 0) return null;
  const targetTrack = project.tracks[targetIndex];
  const clipIndex = targetTrack.clips.findIndex(clip => clip.id === clipId);
  const clip = targetTrack.clips[clipIndex];
  const node = (project.cardNodes || []).find(node => node.id === clip.nodeId);
  // Unknown Chrome composition must keep its lower browser scene. Reviewed
  // independent 图卡 still resolve hidden inputs through sourceProject.
  const context = preserveContext && (node ? capabilities(clip.cardId)?.compositing !== 'independent' : !!clip.cardId);
  const ids = new Set(project.tracks.map(track => track.id));
  const tracks = project.tracks.flatMap((track, index) => {
    if (index !== targetIndex) return [{ ...track, ...(context && index > targetIndex ? {} : { hidden: true, sourceOnly: true }) }];
    const visible = context ? track.clips.slice(0, clipIndex + 1) : [clip];
    const siblings = track.clips.filter(item => !visible.includes(item));
    const result = [{ ...track, hidden: false, sourceOnly: false, clips: visible }];
    if (siblings.length) {
      let id = `__pc_vision_source_${track.id}`, suffix = 1;
      while (ids.has(id)) id = `__pc_vision_source_${track.id}_${suffix++}`;
      ids.add(id);
      result.push({ ...track, id, hidden: true, sourceOnly: true, clips: siblings });
    }
    return result;
  });
  return { clip, context, project: { ...project, tracks } };
}
