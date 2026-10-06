import { cardJson } from './cardGraph.mjs';

/** 声画一体卡的声音属于原片段，不能当普通素材分离。纯音频图卡不是声画卡。 */
export const isAudiovisualCard = def => !!def && typeof def.audio === 'function' &&
  (typeof def.Component === 'function' || typeof def.Component === 'object' && def.Component !== null || typeof def.card === 'function');
export function assertAudiovisualCardKind(def) {
  if (isAudiovisualCard(def) && def.kind === 'audio') throw new Error('声画卡不能使用 kind:audio，请声明 animation/filter/transition/emphasis 视觉类型');
}
const nodeOf = (p, c) => p.cardNodes?.find(n => n.id === c.nodeId);
export function clipHasEmbeddedAudio(project, clip, getCard = () => undefined) {
  const node = nodeOf(project, clip);
  return isAudiovisualCard(getCard(clip.cardId || node?.cardId)) || clip.embeddedAudio === true || node?.embeddedAudio === true || !!clip.cardAudio;
}
export function clipHasAudio(project, clip, getCard = () => undefined) {
  const node = nodeOf(project, clip), media = project.media?.find(m => m.id === clip.mediaId);
  return clipHasEmbeddedAudio(project, clip, getCard) || node?.adapter === 'card' && node.kind === 'audio' ||
    typeof getCard(clip.cardId || node?.cardId)?.audio === 'function' || media?.kind === 'video' || media?.kind === 'audio';
}
/** 两路共用的源时钟。切分已同时写 mediaOffset/node.timeOffset，绝不能相加。 */
export function cardAudioSourceOffset(project, clip) {
  return clip.mediaOffset ?? nodeOf(project, clip)?.timeOffset ?? 0;
}
export class CardAudioRenditionError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, clip, message) => { throw new CardAudioRenditionError(code, `${clip.id} 的卡片声音${message}`); };

/** 同步纯数据身份：参数/事件表、所有上游素材哈希与映射、代码版本。没有源码的在线端只读已存快照。 */
export function cardAudioIdentity(project, clip, hooks = {}, saved = clip.cardAudio?.identity) {
  const getCard = hooks.getCard ?? (() => undefined), versions = hooks.sourceVersionOf;
  const nodes = new Map((project.cardNodes ?? []).map(n => [n.id, n]));
  const clips = (project.tracks ?? []).flatMap(t => t.clips ?? []);
  const root = nodeOf(project, clip) ?? { cardId: clip.cardId, inputs: {} };
  const visit = (node, owner, fallback, seen = new Set()) => {
    if (seen.has(node)) fail('stale', clip, '输入存在循环，无法生成');
    const nextSeen = new Set(seen).add(node), def = getCard(node.cardId);
    const defaults = def?.defaults ?? fallback?.defaults ?? {};
    const sourceVersion = versions?.(node.cardId) ?? fallback?.sourceVersion;
    if (!sourceVersion) fail('missing', clip, '缺少源码版本，请在本地重新生成');
    const inputs = {};
    for (const [name, raw] of Object.entries(node.inputs ?? {})) {
      const ref = typeof raw === 'string' ? { nodeId: raw } : raw;
      const sourceId = /^@clip\/(.+)\/source$/.exec(ref.nodeId)?.[1];
      const sourceClip = sourceId ? clips.find(c => c.id === sourceId) : undefined;
      if (sourceId) {
        const media = project.media?.find(m => m.id === sourceClip?.mediaId);
        if (!media?.hash) fail('missing', clip, '输入素材缺失或没有内容哈希');
        // 自己的素材已经按源时钟访问，split 的边补偿不能再使身份变化。
        const offset = sourceClip === owner ? (ref.offset ?? 0) + (node.timeOffset ?? 0) : (ref.offset ?? 0) + (sourceClip?.mediaOffset ?? 0);
        inputs[name] = { media: media.hash, offset, rate: ref.rate ?? 1 };
      } else {
        const upstream = nodes.get(ref.nodeId);
        if (!upstream) fail('missing', clip, '输入节点已删除');
        const upstreamOwner = clips.find(c => c.nodeId === upstream.id);
        inputs[name] = { offset: ref.offset ?? 0, rate: ref.rate ?? 1,
          value: visit(upstream, upstreamOwner, fallback?.inputs?.[name]?.value, nextSeen) };
      }
    }
    return { cardId: node.cardId, sourceVersion, defaults, params: { ...defaults, ...(owner?.params ?? node.params ?? {}) }, inputs,
      ...(owner === clip ? {} : { timeOffset: node.timeOffset ?? 0 }) };
  };
  return JSON.parse(cardJson(visit(root, clip, saved)));
}

/** WAV 的 sourceOffset 是它的区间起点；播放偏移是当前源时钟减区间起点。支持原 WAV 覆盖的裁切/切分。 */
export function resolveCardAudioRendition(project, clip, hooks = {}) {
  const r = clip.cardAudio;
  if (!r) fail('missing', clip, '尚未生成，请先生成卡片声音');
  if (r.version !== 1 || r.cardId !== clip.cardId || r.sampleRate !== 48000 || !Number.isSafeInteger(r.frames) || r.frames < 1 ||
      !Number.isInteger(r.channels) || r.channels < 1 || r.channels > 8 || !Number.isFinite(r.sourceOffset) || !r.identity)
    fail('stale', clip, '记录无效，请重新生成');
  const identity = cardAudioIdentity(project, clip, hooks);
  if (cardJson(identity) !== cardJson(r.identity)) fail('stale', clip, '已过期（参数、事件、输入或源码已变化），请重新生成');
  const offset = cardAudioSourceOffset(project, clip) - r.sourceOffset;
  const frames = Math.round((clip.end - clip.start) * r.sampleRate), start = Math.round(offset * r.sampleRate);
  if (!Number.isFinite(offset) || start < 0 || frames < 1 || start + frames > r.frames)
    fail('stale', clip, '预渲染结果未覆盖当前范围，请重新生成');
  const media = project.media?.find(m => m.id === r.mediaId);
  if (!media || media.kind !== 'audio' || !/^[0-9a-f]{64}$/i.test(media.hash ?? '') || !media.url || /^blob:/.test(media.url) || media.pending)
    fail('missing', clip, '素材缺失，请恢复素材或重新生成');
  return { media, offset: start / r.sampleRate, rendition: r };
}
