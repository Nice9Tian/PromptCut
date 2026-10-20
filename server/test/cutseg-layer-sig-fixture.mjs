/**
 * `cutseg-layer-sig.test.mjs` 的 LS-3 用的输入:一个没有剪辑段的项目(三张卡),卡片计划两层快照,流表里一条单卡流、一条组流、
 * 一条依赖下层的流、一条源依赖卡的单独成流(`solo: 'source'`)。只放纯数据,不 import 本仓库的模块 ——
 * 这样同一份输入能喂给改动前(主工作区)的 `layerMapOf` 算基准值。
 */
const hex = (c) => c.repeat(64);
export function plainLayerMapInput() {
  const project = {
    id: 'proj-plain', width: 1920, height: 1080, fps: 30, duration: 6, themeId: 'dark', style: {}, media: [], filters: [], pixelMaps: [], cardNodes: [],
    tracks: [
      { id: 't-a', clips: [{ id: 'clip-a', cardId: 'punch-pill', start: 0, end: 2, params: { text: 'a' }, frame: { x: 100, y: 100, w: 640, h: 360 } }] },
      { id: 't-b', clips: [{ id: 'clip-b', cardId: 'particles', start: 1, end: 5, params: { seed: 3 } }] },
      { id: 't-c', clips: [{ id: 'clip-c', cardId: 'glass', start: 0.5, end: 4, params: {} }] },
    ],
  };
  const control = (clipId, key, firstFrame, count) => ({ clipId, key: `key-${clipId}`, snapshotKey: key, contentKey: `ck-${clipId}`, envFingerprint: 'fp-own', tier: 'shared',
    sampling: { firstFrame }, count, capabilities: { compositing: 'independent' } });
  const entry = { key: 'entry-plain', project, cardPlan: [control('clip-a', hex('a'), 0, 60), control('clip-b', hex('b'), 30, 120)] };
  const s = (over) => ({ contentKey: `sk-${over.topClipId}-${over.kind}`, originFrame: 0, firstSegment: 0, lastSegment: 3, envFingerprint: 'fp-own', ...over });
  const streams = [
    s({ topClipId: 'clip-a', clipIds: ['clip-a'], kind: 'card', plane: 'local' }),
    s({ topClipId: 'clip-b', clipIds: ['clip-a', 'clip-b'], kind: 'group', plane: 'stage', originFrame: 30 }),
    s({ topClipId: 'clip-c', clipIds: ['clip-c'], kind: 'below', plane: 'stage', originFrame: 15 }),
    s({ topClipId: 'clip-b', clipIds: ['clip-b'], kind: 'card', plane: 'local', solo: 'source', originFrame: 30, contentKey: 'sk-solo' }),
  ];
  return { entry, options: { fingerprint: 'fp-own', now: 12345, candidatesOf: () => ['fp-browser'], streams, streamCandidatesOf: () => ['fp-browser'] } };
}
