import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderQueue } from '../render-queue/index.mjs';
import { createQueueHarness } from './fake-render-queue-env.mjs';
import { snapTask, importRepo } from './m7-kit.mjs';
import { judgeDualClip, observedSuperseded, observeLayerEnvironments } from '../../scripts/probes/m7-judge.mjs';

const PC = '1111111111111111', PAGE = '2222222222222222';

test('M7 observation: real queue supersedes then removes on locked republish between two samples', t => {
  const h = createQueueHarness(createRenderQueue);
  h.publisher('page', 'pub-page', { userId: 'member@device' });
  h.node('pc', 'pc-node', { profile: 'pc', userId: 'observer@device', watch: ['p1'] });
  h.node('br', 'br-node', { profile: 'browser', userId: 'member@device', watch: ['p1'], hello: { envFingerprint: PAGE } });
  const pc = snapTask({ contentKey: 'observation-gap', fp: PC, seg: 0, input: { dual: true } });
  const page = snapTask({ contentKey: 'observation-gap', fp: PAGE, seg: 0, input: { dual: true } });
  h.publish('page', [pc, page]);
  const sampled = new Map(h.describe().tasks.map(task => [task.id, task]));
  assert.equal(sampled.get(pc.id).state, 'open');
  const claim = h.claim('br', page.id, h.task(page.id).version).one('br', 'task.claimed');
  assert.equal(h.task(pc.id).lastError, 'superseded');
  assert.ok(h.bus.of('page', 'task.failed').some(e => e.id === pc.id && e.error === 'superseded'));
  const terminal = h.bus.of('pc', 'task.closed').find(e => e.id === pc.id && e.state === 'failed');
  assert.ok(terminal);
  const republish = h.publish('page', [pc]).one('page', 'task.published');
  assert.equal(republish.results[0].error, 'card-locked');
  assert.equal(h.task(pc.id), null);
  // Exactly the old god-view update: absent entries are never removed.
  for (const task of h.describe().tasks) sampled.set(task.id, task);
  const clip = pcLive => ({ groups: { pc: [{ range: '0-59', live: pcLive }], page: [{ range: '0-59', live: true }] }, candidates: ['pc', 'page'], layerFp: 'page' });
  assert.equal(judgeDualClip(clip(sampled.get(pc.id).state !== 'failed')).ok, false);
  const proven = observedSuperseded({ current: h.task(pc.id), closed: terminal, publisherSuperseded: true });
  assert.equal(proven, true);
  assert.equal(judgeDualClip(clip(!proven)).ok, true);
  h.complete('br', page.id, claim.token, { v: 1 });
  t.diagnostic(JSON.stringify({ sampled: sampled.get(pc.id).state, current: h.task(pc.id), published: republish.results[0].error, publisher: 'superseded', watcher: terminal.state }));
});

test('M7 observation: absent, generic failure, or old superseded after reopen cannot prove cancellation', () => {
  assert.equal(observedSuperseded({}), false);
  assert.equal(observedSuperseded({ closed: { state: 'failed' } }), false);
  assert.equal(observedSuperseded({ publisherSuperseded: true }), false);
  assert.equal(observedSuperseded({ closed: { state: 'done' }, publisherSuperseded: true }), false);
  for (const state of ['open', 'claimed', 'done']) assert.equal(observedSuperseded({ current: { state }, closed: { state: 'failed' }, publisherSuperseded: true }), false);
  assert.equal(observedSuperseded({ current: { state: 'failed', lastError: 'decode-error' }, closed: { state: 'failed' }, publisherSuperseded: true }), false);
  assert.equal(observedSuperseded({ current: { state: 'failed', lastError: 'superseded' } }), true);
});

test('M7 observation: real OnlineSnapshotSource complete can precede the layer-map reply', async t => {
  const { OnlineSnapshotSource } = await importRepo('src/render/snapshotSource.ts');
  const candidate = fp => ({ envFingerprint: fp, resultKey: `result-${fp}`, key: `wire-${fp}` });
  const layer = { clipId: 'h1', kind: 'html', ...candidate(PC), firstFrame: 0, count: 60, contentKey: 'clip-content', candidates: [candidate(PC)] };
  let map = { v: 3, kind: 'layer-map', projectId: 'p1', fps: 30, span: 60, layers: [layer] };
  let pendingMap = false, release;
  const gate = new Promise(resolve => { release = resolve; });
  const source = new OnlineSnapshotSource({
    request: async request => request.key === 'layers:p1'
      ? { type: 'content.item', body: structuredClone(pendingMap ? await gate : map) }
      : { type: 'content.item', missing: true },
    assetBase: () => 'http://unused.invalid', authHeaders: async () => ({}),
    setTimer: () => 0, clearTimer() {},
  }, { tier: 'original' });
  t.after(() => { release(map); source.stop(); });
  source.setProject('p1');
  await source.tickNow();
  assert.equal(source.debug().layers[0].envFingerprint, PC);
  pendingMap = true;
  source.refresh();
  source.markAlive(candidate(PAGE).resultKey);
  assert.equal(source.debug().aliveKeys, 1);
  assert.equal(source.debug().layers[0].envFingerprint, PC, 'complete does not supply the missing candidate map');
  let clock = 0;
  const observation = await observeLayerEnvironments(() => source.debug(), {
    clips: ['h1'], fingerprint: PAGE, timeoutMs: 100, now: () => clock,
    sleep: async () => {
      clock++;
      map = { ...map, layers: [{ ...layer, candidates: [candidate(PC), candidate(PAGE)] }] };
      release(map);
      await source.tickNow();
    },
  });
  assert.equal(observation.first[0].fp, PC);
  assert.equal(observation.layers[0].fp, PAGE);
  assert.equal(observation.ok, true);
  assert.equal(observation.samples, 2);
  t.diagnostic(JSON.stringify(observation));
});

test('M7 observation: deadline preserves failure when the real layer never changes', async () => {
  let clock = 0;
  const observed = await observeLayerEnvironments(async () => ({ layers: [{ clipId: 'h1', envFingerprint: PC, ready: 0 }] }), {
    clips: ['h1'], fingerprint: PAGE, timeoutMs: 2, pollMs: 1, now: () => clock, sleep: async ms => { clock += ms; },
  });
  assert.equal(observed.ok, false);
  assert.equal(observed.samples, 3);
  assert.equal(observed.waitedMs, 2);
  assert.deepEqual(observed.layers, observed.first);
});
