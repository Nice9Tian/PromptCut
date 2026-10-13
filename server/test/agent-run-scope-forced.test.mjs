import test from 'node:test';
import assert from 'node:assert/strict';
import { scopeModel, signed } from './agent-run-scope-fixture.mjs';
import { digestOf } from '../account/ledger.mjs';
import { inspectAgentScopeSource } from '../hosted/agent-run-scope-reader.mjs';

const inspect = m => inspectAgentScopeSource({ read: m.io.read, expected: m.expected,
  configuredAnchorDigest: digestOf(m.files.get('anchor.json')) });
async function ready() {
  const m = scopeModel(); await m.run('initialize');
  // Controlled OS model only. Actual dead-main support must pass the root Linux probe.
  m.io.pinRetired = m.io.pinPrevious;
  return m;
}
function retirement(m) {
  const r = m.files.get('epoch-1.json');
  return { v: 1, protocol: 'promptcut.agent-run-scope.unassigned-retirement.v1', authorityId: r.authorityId,
    slotId: r.slotId, epoch: r.epoch, recordDigest: digestOf(r), reason: 'registration-failed' };
}
function forced(m) {
  const r = m.files.get('epoch-1.json');
  return signed({ v: 1, protocol: 'promptcut.agent-run-scope.forced-terminal.v1', authorityId: r.authorityId,
    slotId: r.slotId, epoch: r.epoch, recordDigest: digestOf(r), docAuthorityId: m.expected.docAuthorityId,
    assignmentDigest: digestOf(m.files.get('assignment-1.json')), fence: { controlId: 'control:private',
      fenceRevision: 1, payloadDigest: 'a'.repeat(64), kind: 'private', outcome: 'interrupted' } }, m.doc.privateKey);
}
test('forced close has Doc fence signature and no synthetic worker intent; next epoch keeps full chain', async () => {
  const m = await ready(); await m.run('bind', { assignment: m.assignment() });
  await m.run('forced-close', { terminal: forced(m) });
  const value = await inspect(m);
  assert.equal(value.closure.protocol, 'promptcut.agent-run-scope.forced-closure.v1');
  assert.equal(value.closure.intentDigest, null);
  assert.equal(m.files.get('intent-1.json'), null);
  await m.run('start'); assert.equal((await inspect(m)).record.epoch, 2);
});
test('unassigned retirement closes only a ready slot without assignment or task outcome', async () => {
  const m = await ready(); await m.run('retire', { terminal: retirement(m) });
  const value = await inspect(m);
  assert.equal(value.assignment, null); assert.equal(value.closure.assignmentDigest, null);
  assert.equal(m.files.has('publication-1-bound.json'), false);
  await m.run('start'); assert.equal((await inspect(m)).record.epoch, 2);
});
test('child still populated cannot close or release, forged forced signature and normal/forced confusion reject', async t => {
  for (const variant of ['populated', 'signature', 'normal-mode', 'fake-intent', 'missing-runtime']) await t.test(variant, async () => {
    const m = await ready(); await m.run('bind', { assignment: m.assignment() });
    const terminal = forced(m); let mode = 'forced-close', intent = null;
    if (variant === 'populated') m.faults.populated = 1;
    if (variant === 'signature') terminal.fence.outcome = 'failed';
    if (variant === 'normal-mode') mode = 'close';
    if (variant === 'fake-intent') intent = m.closing().intent;
    if (variant === 'missing-runtime') delete m.io.pinRetired;
    await assert.rejects(m.run(mode, { terminal, intent }));
    assert.equal(m.calls.includes('release'), false);
    assert.equal(m.files.has('publication-1-closed.json'), false);
    assert.ok(m.files.has('.publisher.lock'));
    await assert.rejects(inspect(m), { code: 'agent-scope-publisher-locked' });
  });
});
test('retirement cannot erase bound grant or be passed to normal close', async t => {
  for (const mode of ['retire', 'close']) await t.test(mode, async () => {
    const m = await ready(); await m.run('bind', { assignment: m.assignment() });
    await assert.rejects(m.run(mode, { terminal: retirement(m) })); assert.equal(m.calls.includes('stop'), false);
  });
});
