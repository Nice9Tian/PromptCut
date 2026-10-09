import test from 'node:test';
import assert from 'node:assert/strict';
import { digestOf } from '../account/ledger.mjs';
import { scopeModel } from './agent-run-scope-fixture.mjs';
import { inspectAgentScopeSource } from '../hosted/agent-run-scope-reader.mjs';

const inspect = m => inspectAgentScopeSource({ read: m.io.read, expected: m.expected,
  configuredAnchorDigest: digestOf(m.files.get('anchor.json')) });

test('root failure publication preserves bound phase and never stops or claims populated group closed', async () => {
  const m = scopeModel(); await m.run('initialize'); await m.run('bind', { assignment: m.assignment() });
  m.faults.mainGone = true;
  const result = await m.run('observe-failure');
  assert.equal(result.head.phase, 'bound'); assert.equal(result.failure.observed.populated, 1);
  assert.equal(Object.hasOwn(result.failure.observed, 'closed'), false);
  assert.equal(m.calls.includes('stop'), false); assert.equal(m.calls.includes('release'), false);
  const projection = await inspect(m); assert.deepEqual(projection.failures[1], result.failure);
  assert.equal(projection.closure, null);
  assert.deepEqual(await m.run('observe-failure'), result);
});

test('live main observation fails closed with lock; no fabricated failure publication', async () => {
  const m = scopeModel(); await m.run('initialize');
  await assert.rejects(m.run('observe-failure'), /main-still-live/);
  assert.equal(m.files.has('failure-1.json'), false); assert.equal(m.files.has('.publisher.lock'), true);
  await assert.rejects(inspect(m), { code: 'agent-scope-publisher-locked' });
});

test('failure-only publication between two absent reads cannot hide behind unchanged current head', async () => {
  const m = scopeModel(); await m.run('initialize'); m.faults.mainGone = true;
  let firstRead = true, published = false;
  await assert.rejects(inspectAgentScopeSource({ expected: m.expected,
    configuredAnchorDigest: digestOf(m.files.get('anchor.json')), async read(name) {
      if (name === 'failure-1.json') {
        if (firstRead) firstRead = false;
        else if (!published) { published = true; await m.run('observe-failure'); }
      }
      return m.io.read(name);
    } }), { code: 'agent-scope-source-changed' });
  assert.equal(published, true);
});

for (const kind of ['missing-marker', 'mixed-record', 'fake-empty', 'post-marker-fsync']) test(`failure proof rejects ${kind}`, async () => {
  const m = scopeModel(); await m.run('initialize'); m.faults.mainGone = true;
  if (kind === 'post-marker-fsync') m.faults.afterWrite = name => name === 'failure-publication-1.json';
  if (kind === 'post-marker-fsync') {
    await assert.rejects(m.run('observe-failure'), /fsync-after-visible/);
    assert.equal(m.files.has('failure-publication-1.json'), true);
    await assert.rejects(inspect(m), { code: 'agent-scope-publisher-locked' }); return;
  }
  await m.run('observe-failure');
  if (kind === 'missing-marker') m.files.delete('failure-publication-1.json');
  if (kind === 'mixed-record') m.files.get('failure-1.json').recordDigest = 'f'.repeat(64);
  if (kind === 'fake-empty') m.files.get('failure-1.json').observed.closed = true;
  await assert.rejects(inspect(m), /agent-scope-failure-/);
});
