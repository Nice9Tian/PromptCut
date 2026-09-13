import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardNodeIdentities, cardSampling, cardLocalTime, cardCacheIdentity } from '../card-identity.mjs';
import { frameIdentity } from '../frame-identity.mjs';
const graph = () => ({ definitions: [{ id: 'd', source: 'code', styleKeys: ['color'] }], nodes: [
  { id: 'source', adapter: 'media', media: { stamp: '1' } },
  { id: 'effect', adapter: 'python', definitionId: 'd', inputs: { source: 'source' } },
  { id: 'unrelated', adapter: 'media', media: { stamp: '2' } },
], outputs: [{ nodeId: 'effect', start: 10, end: 11 }] });
test('node identity invalidates downstream source/code/used style, preserves unrelated nodes', () => {
  const value = graph();
  const base = cardNodeIdentities(value, { style: { color: 'red', font: 'sans' } });
  value.outputs[0].start = 20;
  const moved = cardNodeIdentities(value, { style: { color: 'red', font: 'serif' } });
  assert.deepEqual(base, moved);
  const restyled = cardNodeIdentities(value, { style: { color: 'blue' } });
  assert.equal(base.get('source'), restyled.get('source'));
  assert.notEqual(base.get('effect'), restyled.get('effect'));
  value.nodes[0].media.stamp = 'edited';
  const edit = cardNodeIdentities(value);
  assert.notEqual(edit.get('effect'), base.get('effect'));
  assert.equal(edit.get('unrelated'), base.get('unrelated'));
});
test('local MOV sampling retains subframe phase and reuses integer-frame translations', () => {
  const sample = cardSampling(10.005, 60);
  assert.equal(sample.firstFrame, 601);
  assert.deepEqual(sample.phase, { numerator: '7', denominator: '600' });
  assert.equal(cardLocalTime(sample, 0).seconds, 7 / 600);
  assert.equal(cardLocalTime(sample, 1).seconds, 17 / 600);
  const shifted = cardSampling(20.005, 60);
  assert.equal(cardCacheIdentity('same', sample, 1), cardCacheIdentity('same', shifted, 1));
  assert.notEqual(cardCacheIdentity('same', sample, 1), cardCacheIdentity('same', cardSampling(10.006, 60), 1));
  assert.equal(cardSampling(0.1, 30).phase.numerator, '0');
});
test('whole scene cache includes Python source, graph and global style', () => {
  const project = { tracks: [], media: [], cardDefinitions: [{ source: 'a' }], cardNodes: [], style: { tint: 'red' } };
  const before = frameIdentity(project);
  project.cardDefinitions[0].source = 'b'; assert.notEqual(frameIdentity(project), before);
  const code = frameIdentity(project); project.style.tint = 'blue'; assert.notEqual(frameIdentity(project), code);
});
test('Chrome TSX source versions and stamped media invalidate only their downstream card key', () => {
  const value = { definitions: [], nodes: [
    { id: 'media', adapter: 'media', media: { id: 'm', _frameSourceStamp: '10:1' }, inputs: {} },
    { id: 'tsx', adapter: 'chrome', cardId: 'tsx-card', inputs: { source: { nodeId: 'media' } } },
  ], outputs: [{ nodeId: 'tsx' }] };
  const before = cardNodeIdentities(value, { sourceVersions: { 'tsx-card': 'component-v1' } });
  const sourceEdit = cardNodeIdentities(value, { sourceVersions: { 'tsx-card': 'component-v2' } });
  assert.equal(before.get('media'), sourceEdit.get('media'));
  assert.notEqual(before.get('tsx'), sourceEdit.get('tsx'));
  value.nodes[0].media._frameSourceStamp = '11:2';
  const mediaEdit = cardNodeIdentities(value, { sourceVersions: { 'tsx-card': 'component-v2' } });
  assert.notEqual(sourceEdit.get('tsx'), mediaEdit.get('tsx'));
});
