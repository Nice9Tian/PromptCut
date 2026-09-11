import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packFrames, unpackFrames } from '../frame-archive.mjs';
import { frameIdentity, trackPrefixes } from '../frame-identity.mjs';
import { FramePipeline } from '../frame-pipeline.mjs';

test('frame archive round trips sparse, empty, repeated and unicode HTML as one base64 field', () => {
  const frames = new Map([[0, '<div>你好🙂</div>'], [1, '<div>你好🙂</div>'], [3, ''], [100, '<svg id="x"/>']]);
  const block = packFrames('key', frames);
  assert.match(block, /^[A-Za-z0-9+/=]+$/);
  assert.deepEqual(unpackFrames(block, 'key'), frames);
  assert.throws(() => unpackFrames(block, 'old-key'));
  assert.throws(() => unpackFrames('broken', 'key'));
});
test('deltas compress repeated computed styles without expanding proc JSON', () => {
  const common = 'color:rgb(1,2,3);'.repeat(1000);
  const frames = new Map(Array.from({ length: 100 }, (_, n) => [n, `<div style="${common}">${n}</div>`]));
  const block = packFrames('key', frames);
  assert.ok(block.length < 4000);
  assert.deepEqual(unpackFrames(block, 'key'), frames);
});
const project = { id: 'p', width: 320, height: 180, fps: 10, duration: 1, media: [], tracks: [
  { id: 'top', clips: [{ id: 'a', cardId: 'a', start: 0, end: 1, params: {} }] },
  { id: 'bottom', clips: [{ id: 'b', cardId: 'b', start: 0, end: 1, params: {} }] },
] };
test('upper track edits preserve lower cumulative cache, lower edits invalidate every dependent prefix', () => {
  const before = trackPrefixes(project, 'code');
  const upper = structuredClone(project); upper.tracks[0].clips[0].params.title = 'changed';
  const after = trackPrefixes(upper, 'code');
  assert.equal(before[0].key, after[0].key);
  assert.notEqual(before[1].key, after[1].key);
  const lower = structuredClone(project); lower.tracks[1].clips[0].params.title = 'changed';
  assert.ok(trackPrefixes(lower, 'code').every((p, i) => p.key !== before[i].key));
  assert.notEqual(frameIdentity(project, 'code'), frameIdentity(project, 'new code'));
});
test('see_frames coalesces concurrent callers, deduplicates and sorts one forward pass', async () => {
  const service = new FramePipeline({ root: '.', origin: () => '' });
  const entry = { key: 'same' };
  service.entry = async () => entry;
  const passes = [];
  service.readFrames = async (_entry, frames) => { passes.push(frames); return new Map(frames.map(n => [n, n])); };
  const [a, b] = await Promise.all([service.see_frames(project, [0.8, 0.2]), service.see_frames(project, [0.4, 0.2])]);
  assert.deepEqual(passes, [[2, 4, 8]]);
  assert.deepEqual([...a.keys()], [8, 2]); assert.deepEqual([...b.keys()], [4, 2]);
  await service.close();
});
test('a cancelled caller does not cancel another caller in the same batch', async () => {
  const service = new FramePipeline({ root: '.', origin: () => '' }); service.entry = async () => ({ key: 'same' });
  service.readFrames = async (_entry, frames) => new Map(frames.map(n => [n, n]));
  const controller = new AbortController(); controller.abort();
  const [a, b] = await Promise.allSettled([service.see_frames(project, [0], { signal: controller.signal }), service.see_frames(project, [0.2])]);
  assert.equal(a.status, 'rejected'); assert.equal(b.status, 'fulfilled');
  await service.close();
});
