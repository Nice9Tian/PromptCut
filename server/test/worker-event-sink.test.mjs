import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkerEventJournal } from '../agent-service/worker-event-journal.mjs';
import { createWorkerEventSink } from '../agent-service/worker-event-sink.mjs';
const binding = { projectId: 'p', conversationId: 'c', messageId: 'm', runId: 'r', runGrantId: 'g',
  instanceId: 'i', instanceGeneration: 1, serviceKid: 'kid', senderAccountId: 'acc' };
const scope = { authorityId: 'doc', rootScopeRef: { rootAuthorityId: 'root', slotId: 'slot', epoch: 1,
  recordDigest: 'a'.repeat(64) }, assignmentDigest: 'b'.repeat(64), binding };
// No network is reached by these rejection/persistence targets. TLS and current
// Doc verify are constructor seams only; actual crypto is a separate target.
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-worker-sink-pure-'));
  const journal = createWorkerEventJournal({ file: path.join(dir, 'journal.sqlite'), ...scope, ...options });
  let calls = 0;
  const grant = { ...binding, accountId: 'acc' };
  const sink = createWorkerEventSink({ journal, runClient: { workerEventProofFor() { calls++; throw Error('network-not-allowed'); } },
    origin: 'https://127.0.0.1:6702', tls: { key: 'unused', cert: 'unused', ca: 'unused' }, serverFingerprint256: 'c'.repeat(64),
    verifyGrant: async () => ({ allowed: true, runGrant: grant }) });
  t.after(async () => { await sink.close().catch(() => {}); fs.rmSync(dir, { recursive: true, force: true }); });
  return { sink, journal, grant, calls: () => calls };
}
test('local disk failure is supervised immediately and stops next boundary before any TLS', async t => {
  const f = fixture(t, { failpoint(point) { if (point === 'packet-before-commit') throw Error('local-disk-failure'); } });
  const unhandled = []; const listener = e => unhandled.push(e); process.on('unhandledRejection', listener);
  try {
    const writer = await f.sink.writer({ grant: f.grant }); writer.emit({ type: 'text', delta: 'one' });
    assert.match((await writer.failed).message, /local-disk-failure/);
    await assert.rejects(writer.beforeCall(), /local-disk-failure/); writer.emit({ type: 'tool_call' });
    await assert.rejects(writer.flush(), /local-disk-failure/);
    await assert.rejects(f.sink.close(), /worker-sink-close-pending/);
    assert.equal(f.calls(), 0); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(unhandled, []);
  } finally { process.off('unhandledRejection', listener); }
});
test('unknown existing journal cannot start or restart model execution', async t => {
  const f = fixture(t); f.journal.append({ eventId: 'previous', event: { type: 'text' } });
  await assert.rejects(f.sink.writer({ grant: f.grant }), /execution-replay-pending/);
  assert.equal(f.calls(), 0); assert.equal(f.journal.pending().length, 1);
});
test('foreign grant and missing original Doc message reject without creating writer/transport', async t => {
  const f = fixture(t);
  await assert.rejects(f.sink.writer({ grant: { ...f.grant, runId: 'other' } }), /binding/);
  await assert.rejects(f.sink.mirrorRunMessage({ grant: f.grant }), /message/);
  assert.equal(f.sink.describe().writerCreated, false); assert.equal(f.calls(), 0);
});
