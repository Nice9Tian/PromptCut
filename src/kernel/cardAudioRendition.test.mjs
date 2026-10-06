import test from 'node:test';
import assert from 'node:assert/strict';
import { isAudiovisualCard, clipHasEmbeddedAudio, clipHasAudio, cardAudioIdentity, resolveCardAudioRendition } from './cardAudioRendition.mjs';
import { projectCardGraph } from './cardGraph.mjs';
import { applyCardDefinition, cloneCardClipInstance } from './cardAuthoring.mjs';
import { audioPlanOf } from './audioPlan.mjs';
import { buildAudioPlan } from '../../server/bakery/mux-audio.mjs';
const def = { id: 'av', defaults: { gain: .5, events: [0, .2] }, Component() {}, audio() {}, kind: 'animation', inputs: {} };
const hooks = { getCard: id => id === 'av' ? def : undefined, sourceVersionOf: () => 'source-v1' };
const hash = 'a'.repeat(64);
function fixture() {
  const clip = { id: 'c', cardId: 'av', embeddedAudio: true, params: {}, start: 2, end: 4 };
  const project = { tracks: [{ id: 't', clips: [clip] }], media: [{ id: 'wav', kind: 'audio', hash, url: `/@media/${hash}` }] };
  clip.cardAudio = { version: 1, mediaId: 'wav', cardId: 'av', sourceKey: 'key', sourceOffset: 0, duration: 2, sampleRate: 48000,
    frames: 96000, channels: 2, identity: cardAudioIdentity(project, clip, hooks) };
  return { project, clip };
}
test('Component+audio and card+audio are AV; audio-only and ordinary media stay distinct', () => {
  assert.equal(isAudiovisualCard(def), true);
  assert.equal(isAudiovisualCard({ card() {}, audio() {} }), true);
  assert.equal(isAudiovisualCard({ audio() {}, kind: 'audio' }), false);
  assert.equal(clipHasEmbeddedAudio({ cardNodes: [] }, { cardId: 'av' }, hooks.getCard), true);
  assert.equal(clipHasEmbeddedAudio({}, { embeddedAudio: true }), true);
  assert.equal(clipHasAudio({ media: [{ id: 'm', kind: 'video' }] }, { mediaId: 'm' }), true);
  assert.equal(clipHasEmbeddedAudio({ cardNodes: [{ id: 'n', adapter: 'card', kind: 'audio' }] }, { nodeId: 'n' }), false);
});
test('fresh AV apply creates one visual clip and a server-readable marker; empty inputs stay empty', () => {
  const p = { duration: 2, media: [], tracks: [{ id: 't', clips: [] }] };
  const r = applyCardDefinition(p, { cardId: 'av', trackId: 't', start: 0, end: 2, nodeId: 'n' }, hooks.getCard);
  const clip = r.project.tracks[0].clips[0];
  assert.equal(clip.cardId, 'av'); assert.equal(clip.embeddedAudio, true); assert.equal(r.project.tracks[0].clips.length, 1);
  assert.deepEqual(r.project.cardNodes[0].inputs, {});
  assert.throws(() => audioPlanOf(r.project), /尚未生成/);
  assert.equal(projectCardGraph(r.project, hooks.getCard).nodes.find(n => n.id === 'n').embeddedAudio, true);
});
test('persistent AV reopens, emits one audio source, and respects independent mute', () => {
  const { project, clip } = fixture();
  const reopened = JSON.parse(JSON.stringify(project));
  assert.equal(resolveCardAudioRendition(reopened, reopened.tracks[0].clips[0]).media.id, 'wav');
  assert.deepEqual(audioPlanOf(project).map(x => [x.clipId, x.mediaId, x.offset]), [['c', 'wav', 0]]);
  assert.equal(buildAudioPlan(project, '', () => true, () => '/wav').length, 1);
  clip.audioMuted = true; assert.deepEqual(audioPlanOf(project), []);
  assert.equal(clip.cardId, 'av'); clip.audioMuted = false;
  project.tracks[0].muted = true; assert.deepEqual(audioPlanOf(project), []);
});
test('WAV range subtracts origin once and stays usable after split, trim and clone', () => {
  const { project, clip } = fixture();
  clip.start = 3; clip.mediaOffset = 1;
  assert.equal(resolveCardAudioRendition(project, clip, hooks).offset, 1);
  clip.cardAudio.sourceOffset = .5; clip.cardAudio.frames = 72000;
  assert.equal(resolveCardAudioRendition(project, clip, hooks).offset, .5);
  clip.end = 4.1; assert.throws(() => resolveCardAudioRendition(project, clip, hooks), /未覆盖/);
});
test('all parameters/events/source code/input changes invalidate; missing bytes metadata never falls back', () => {
  const { project, clip } = fixture();
  assert.throws(() => resolveCardAudioRendition(project, clip, { ...hooks, sourceVersionOf: () => 'v2' }), /已过期/);
  clip.params = { events: [0, .3] }; assert.throws(() => resolveCardAudioRendition(project, clip, hooks), /已过期/);
  clip.params = {}; project.media[0].url = ''; assert.throws(() => audioPlanOf(project), /素材缺失/);
  project.media[0].url = `blob:invalid`; assert.throws(() => audioPlanOf(project), /素材缺失/);
  delete clip.cardAudio; assert.throws(() => buildAudioPlan(project, '', () => true, () => '/wav'), /尚未生成/);
});
test('explicit own-media offsets survive graph normalization and split identity', () => {
  const { project, clip } = fixture();
  project.media.push({ id: 'v', kind: 'video', hash: 'b'.repeat(64), url: '/v' });
  clip.mediaId = 'v'; clip.nodeId = 'n'; clip.mediaOffset = 2;
  project.cardNodes = [{ id: 'n', adapter: 'card', cardId: 'av', embeddedAudio: true, inputs: { source: { nodeId: '@clip/c/source', offset: 1 } } }];
  const identity = cardAudioIdentity(project, clip, hooks);
  const graph = projectCardGraph(project, hooks.getCard), n = graph.nodes.find(n => n.id === 'n');
  assert.equal(n.timeOffset, 2); assert.equal(n.inputs.source.offset, -1);
  const cloned = cloneCardClipInstance(project, 'c', 'right', 'n', .5);
  const right = { ...clip, id: 'right', nodeId: cloned.nodeId, start: 2.5, mediaOffset: 2.5 };
  cloned.project.tracks = [{ id: 't', clips: [clip, right] }];
  assert.deepEqual(cardAudioIdentity(cloned.project, right, hooks), identity);
  const after = projectCardGraph(cloned.project, hooks.getCard).nodes.find(n => n.id === right.nodeId);
  assert.equal(after.timeOffset, 2.5); assert.equal(after.inputs.source.offset, -1.5);
  project.cardNodes[0].inputs.source.offset = 1.5;
  assert.notDeepEqual(cardAudioIdentity(project, clip, hooks), identity);
});

test('声画卡错误声明audio-only类型时apply在写项目之前明确拒绝', () => {
  const p = { duration: 2, media: [], tracks: [{ id: 't', clips: [] }] };
  for (const visual of [{ Component() {} }, { card() {} }]) {
    const bad = { ...def, Component: undefined, ...visual, kind: 'audio' };
    assert.throws(() => applyCardDefinition(p, { cardId: 'av', trackId: 't', start: 0, end: 1 }, () => bad), /声画卡不能使用 kind:audio/);
    assert.deepEqual(p.tracks[0].clips, []); assert.equal(p.cardNodes, undefined);
  }
});
