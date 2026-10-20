/**
 * 剪辑段的「渲染身份」:激活剪辑经剪辑段(任意深度)能走到的那些剪辑的内容。
 *
 * 画面的缓存与预渲染的身份(镜像的项目哈希 `render/changedClips.mjs` 的 `projectHash`、帧服务的
 * `server/frame-identity.mjs`、快照签名 `render/frameClient.ts`)原来只看激活剪辑的 `tracks`。
 * 剪辑段引用的剪辑住在 `cuts[]` 里,不把它们算进去的话,改了被引用剪辑旧缓存不失效
 * (Argon 审核意见「缓存与预渲染的身份把被引用剪辑内容算进去」)。
 *
 * 没有剪辑段的项目返回空数组,调用方据此**不往身份里加任何东西**:老项目的哈希、缓存键一个字节不变。
 *
 * 纯 JS(.mjs):服务端的帧服务、镜像插件直接 import,不经 TS。和 `cutSegments.ts` 的存法同一口径。
 */

function activeIdOf(p) {
  const cuts = Array.isArray(p?.cuts) ? p.cuts : [];
  if (!cuts.length) return undefined;
  return p.activeCutId && cuts.some((c) => c.id === p.activeCutId) ? p.activeCutId : cuts[0].id;
}

function contentOf(p, cutId) {
  const cuts = Array.isArray(p?.cuts) ? p.cuts : [];
  const entry = cuts.find((c) => c?.id === cutId);
  if (!entry) return null;
  if (cutId === activeIdOf(p)) return { id: cutId, tracks: p.tracks ?? [], duration: p.duration, transitions: p.transitions ?? [] };
  if (!Array.isArray(entry.tracks)) return null;
  return { id: cutId, tracks: entry.tracks, duration: entry.duration, transitions: entry.transitions ?? [] };
}

function targetsOf(tracks) {
  const out = [];
  for (const tr of tracks ?? []) for (const c of tr?.clips ?? []) {
    if (typeof c?.cutId === 'string' && c.cutId && !out.includes(c.cutId)) out.push(c.cutId);
  }
  return out;
}

const memo = new WeakMap();

/**
 * 从 `tracks`(缺省激活剪辑的)出发,经剪辑段能走到的剪辑的内容,按 id 排好。
 * 激活剪辑自己不在里面(它就是 tracks);成环的那条边到已经走过的剪辑为止。
 */
export function reachableCutContents(project, tracks = project?.tracks) {
  if (!project || !Array.isArray(project.cuts)) return [];
  const useMemo = tracks === project.tracks;
  if (useMemo && memo.has(project)) return memo.get(project);
  const root = activeIdOf(project);
  const seen = new Set(root ? [root] : []);
  const out = [];
  const stack = targetsOf(tracks);
  while (stack.length) {
    const id = stack.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const content = contentOf(project, id);
    if (!content) continue;
    out.push(content);
    for (const next of targetsOf(content.tracks)) if (!seen.has(next)) stack.push(next);
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (useMemo) memo.set(project, out);
  return out;
}

/** `tracks` 里用到的素材 id,连同经剪辑段走到的剪辑里用到的 */
export function reachableMediaIds(project, tracks = project?.tracks) {
  const ids = new Set();
  const add = (list) => { for (const tr of list ?? []) for (const c of tr?.clips ?? []) if (c?.mediaId) ids.add(c.mediaId); };
  add(tracks);
  for (const c of reachableCutContents(project, tracks)) add(c.tracks);
  return ids;
}

/* ───────────────────── 剪辑段当一张卡参与测量与预渲染:它的内容身份 ───────────────────── */

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** 节点 id → 节点(`cardNodes` 是数组;旧数据也可能是按 id 存的对象) */
function nodesById(project) {
  const raw = project?.cardNodes;
  const list = Array.isArray(raw) ? raw : isObj(raw) ? Object.values(raw) : [];
  const out = new Map();
  for (const node of list) if (node && typeof node.id === 'string' && !out.has(node.id)) out.set(node.id, node);
  return out;
}

/**
 * 一个剪辑段(激活剪辑序列上的那个 `TrackClip`)画面所依赖的全部项目数据,给它的内容身份用
 * (`kernel/cutSegments.ts` 的 `withCutSegmentOutputs` 把它放进剪辑段那个卡片图节点:预渲染的键、成本键;
 * `render/layerInputSig.mjs` 的输入签名)。改了被引用剪辑(任意深度)里的任何东西,这一份就变,旧的测量与轨道流跟着失效。
 *
 *   - `cutId`、`cutOffset`:引用哪条、从第几秒起;
 *   - `contents`:从这一段出发经剪辑段(任意深度)能走到的剪辑的内容(`reachableCutContents`,按 id 排);
 *   - `media`:这些内容里用到的素材(按 id 排;每项只取 id、种类、哈希,没有哈希的取地址);
 *   - `nodes`:这些内容里的片段挂着的素材效果卡节点,连同沿 `inputs` 能走到的(按 id 排);
 *   - `filters` / `pixelMaps`:这些内容里的片段引用到的效果库条目(按 id 排);
 *   - `cardIds`:里面用到的卡片 id(片段的 `cardId`、节点的 `cardId`;排好),调用方据此带上各自的源码版本。
 *
 * 宁可多作废(内容里的声音字段改了也算),不可漏。纯数据、可 JSON 序列化;剪辑段找不到(悬空)时 `contents` 为空。
 */
export function cutSegmentContent(project, clip) {
  const contents = clip && typeof clip.cutId === 'string' && clip.cutId
    ? reachableCutContents(project, [{ clips: [clip] }])
    : [];
  const mediaIds = new Set();
  const nodeIds = new Set();
  const filterIds = new Set();
  const pixelMapIds = new Set();
  const cardIds = new Set();
  for (const c of contents) for (const tr of c.tracks ?? []) for (const cl of tr?.clips ?? []) {
    if (typeof cl?.mediaId === 'string' && cl.mediaId) mediaIds.add(cl.mediaId);
    if (typeof cl?.cardId === 'string' && cl.cardId) cardIds.add(cl.cardId);
    if (typeof cl?.nodeId === 'string' && cl.nodeId) nodeIds.add(cl.nodeId);
    if (isObj(cl?.filter) && typeof cl.filter.id === 'string') filterIds.add(cl.filter.id);
    if (isObj(cl?.pixelMap) && typeof cl.pixelMap.id === 'string') pixelMapIds.add(cl.pixelMap.id);
  }
  // 素材效果卡节点沿输入往上游收(输入指向别的片段 `@clip/<id>/…` 的,那个片段已经在内容里)
  const byId = nodesById(project);
  const nodes = [];
  const queue = [...nodeIds];
  const seen = new Set();
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (!node) continue;
    nodes.push(node);
    if (typeof node.cardId === 'string' && node.cardId) cardIds.add(node.cardId);
    for (const ref of Object.values(isObj(node.inputs) ? node.inputs : {})) {
      const target = typeof ref === 'string' ? ref : isObj(ref) ? ref.nodeId : null;
      if (typeof target === 'string' && target && !seen.has(target)) queue.push(target);
    }
  }
  const byIdSort = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const pick = (list, ids) => (Array.isArray(list) ? list : []).filter((x) => x && ids.has(x.id)).slice().sort(byIdSort);
  return {
    cutId: clip?.cutId,
    cutOffset: Math.max(0, Number(clip?.cutOffset) || 0),
    contents,
    // 素材只取认得出内容的几项:哈希(没有哈希的旧素材退回地址)、种类。页面与预渲染进程手里的素材条目别的字段可能不一样
    media: pick(project?.media, mediaIds).map((m) => ({ id: m.id, kind: m.kind, hash: m.hash ?? null, ...(m.hash ? null : { url: m.url ?? null }) })),
    nodes: nodes.sort(byIdSort),
    filters: pick(project?.filters, filterIds),
    pixelMaps: pick(project?.pixelMaps, pixelMapIds),
    cardIds: [...cardIds].sort(),
  };
}

/** 剪辑段里有没有画面素材(视频、图片):产它的轨道流时截图前要等素材就位 */
export function cutSegmentHasVisualMedia(project, clip) {
  const visual = new Set((Array.isArray(project?.media) ? project.media : []).filter((m) => m && m.kind !== 'audio').map((m) => m.id));
  for (const c of clip && clip.cutId ? reachableCutContents(project, [{ clips: [clip] }]) : []) {
    for (const tr of c.tracks ?? []) {
      if (tr?.hidden) continue;
      for (const cl of tr?.clips ?? []) if (typeof cl?.mediaId === 'string' && visual.has(cl.mediaId)) return true;
    }
  }
  return false;
}
