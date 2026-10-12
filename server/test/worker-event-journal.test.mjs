import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { digestOf } from '../account/ledger.mjs';
import { createWorkerEventJournal } from '../agent-service/worker-event-journal.mjs';

const binding = { projectId: 'p', conversationId: 'c', messageId: 'm', runId: 'r', runGrantId: 'g',
  instanceId: 'i', instanceGeneration: 1, serviceKid: 'kid', senderAccountId: 'acc' };
const scope = { authorityId: 'doc', rootScopeRef: { rootAuthorityId: 'root', slotId: 'slot', epoch: 1,
  recordDigest: 'a'.repeat(64) }, assignmentDigest: 'b'.repeat(64), binding };
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-worker-journal-'));
  const file = path.join(dir, 'events.sqlite');
  const journal = createWorkerEventJournal({ file, ...scope, ...options });
  t.after(() => { try { journal.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  return { file, journal };
}
function ack(packet) {
  const row = { v: 1, authorityId: packet.authorityId, ...packet.binding, eventId: packet.eventId,
    eventSeq: 7 + packet.sourceSeq, at: 123, event: { ...packet.event, ...packet.binding } };
  return { v: 1, authorityId: packet.authorityId, runGrantId: packet.binding.runGrantId,
    instanceId: packet.binding.instanceId, instanceGeneration: packet.binding.instanceGeneration,
    assignmentDigest: packet.assignmentDigest, sourceSeq: packet.sourceSeq, eventId: packet.eventId,
    packetDigest: digestOf(packet), eventSeq: row.eventSeq, eventDigest: digestOf(row), row };
}
test('FULL local packet survives reopen; ACK is separate durable evidence, not OS closure', t => {
  const { file, journal } = fixture(t);
  const event = { type: 'text_delta', text: 'first' };
  const packet = journal.append({ eventId: 'e1', event }); event.text = 'mutated';
  assert.equal(packet.event.text, 'first'); assert.deepEqual(journal.pending(), [packet]);
  assert.deepEqual(journal.source(packet), packet);
  assert.equal(journal.inspect().synchronous, 2);
  journal.close(); const reopened = createWorkerEventJournal({ file, ...scope });
  try { assert.deepEqual(reopened.pending(), [packet]); reopened.acknowledge(ack(packet));
    assert.deepEqual(reopened.pending(), []); assert.deepEqual(reopened.receipt('e1'), ack(packet));
    assert.equal(reopened.inspect().ackHead, 1);
  } finally { reopened.close(); }
});
test('same event/ACK id is idempotent, changed content/receipt and wrong signed source reject', t => {
  const { journal } = fixture(t), p = journal.append({ eventId: 'e1', event: { type: 'text_delta', text: 'a' } });
  assert.deepEqual(journal.append({ eventId: 'e1', event: p.event }), p);
  assert.throws(() => journal.append({ eventId: 'e1', event: { ...p.event, text: 'b' } }), /conflict/);
  assert.throws(() => journal.source({ ...p, event: { ...p.event, text: 'b' } }), /source/);
  journal.acknowledge(ack(p)); journal.acknowledge(ack(p));
  const changed = ack(p); changed.row.at++; changed.eventDigest = digestOf(changed.row);
  assert.throws(() => journal.acknowledge(changed), /conflict/);
});
test('ACK cannot substitute binding, packet, event contents or sequence', t => {
  const { journal } = fixture(t), p = journal.append({ eventId: 'e1', event: { type: 'text_delta', text: 'a' } });
  const p2 = journal.append({ eventId: 'e2', event: { type: 'tool_call', name: 'get_project' } });
  assert.throws(() => journal.acknowledge(ack(p2)), /sequence/);
  for (const change of [r => r.instanceId = 'other', r => r.packetDigest = 'c'.repeat(64),
    r => { r.row.event.text = 'evil'; r.eventDigest = digestOf(r.row); }, r => r.row.projectId = 'other']) {
    const r = ack(p); change(r); assert.throws(() => journal.acknowledge(r), /receipt/);
  }
  assert.equal(journal.inspect().ackHead, 0); journal.acknowledge(ack(p)); journal.acknowledge(ack(p2));
});
test('append commit failure leaves no packet and latches next append/source/close', t => {
  let broken = true;
  const { file, journal } = fixture(t, { failpoint(point) { if (broken && point === 'packet-before-commit') throw Error('disk-failure'); } });
  assert.throws(() => journal.append({ eventId: 'e1', event: { type: 'text_delta' } }), /disk-failure/);
  broken = false; assert.throws(() => journal.append({ eventId: 'e2', event: { type: 'text_delta' } }), /disk-failure/);
  assert.throws(() => journal.close(), /disk-failure/);
  const reopened = createWorkerEventJournal({ file, ...scope });
  try { assert.deepEqual(reopened.pending(), []); } finally { reopened.close(); }
});
test('ACK commit failure keeps original packet pending and prevents next model boundary', t => {
  const { file, journal } = fixture(t, { failpoint(point) { if (point === 'ack-before-commit') throw Error('ack-disk-failure'); } });
  const p = journal.append({ eventId: 'e1', event: { type: 'text_delta' } });
  assert.throws(() => journal.acknowledge(ack(p)), /ack-disk-failure/);
  assert.throws(() => journal.close(), /ack-disk-failure/);
  const reopened = createWorkerEventJournal({ file, ...scope });
  try { assert.deepEqual(reopened.pending(), [p]); } finally { reopened.close(); }
});
test('deleted tail/middle, mismatched ACK and changed worker scope fail closed on reopen', t => {
  for (const sql of ['DELETE FROM worker_packets WHERE seq=2', 'DELETE FROM worker_packets WHERE seq=1',
    "UPDATE worker_packets SET receipt='{}' WHERE seq=1"]) {
    const { file, journal } = fixture(t);
    const p = journal.append({ eventId: 'e1', event: { type: 'text_delta' } }); journal.acknowledge(ack(p));
    journal.append({ eventId: 'e2', event: { type: 'runner_done', settlement: 'pending' } }); journal.close();
    const db = new DatabaseSync(file); db.exec(sql); db.close();
    assert.throws(() => createWorkerEventJournal({ file, ...scope }), /gap|receipt/);
  }
  const { file, journal } = fixture(t); journal.close();
  assert.throws(() => createWorkerEventJournal({ file, ...scope, binding: { ...binding, instanceGeneration: 2 } }), /scope/);
});
