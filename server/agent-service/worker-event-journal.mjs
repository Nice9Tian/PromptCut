import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson, digestOf } from '../account/ledger.mjs';
import { validateWorkerEventPacket, WORKER_EVENT_BINDING_FIELDS } from './worker-event-internal.mjs';

const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
const receiptKeys = ['v', 'authorityId', 'runGrantId', 'instanceId', 'instanceGeneration', 'assignmentDigest',
  'sourceSeq', 'eventId', 'packetDigest', 'eventSeq', 'eventDigest', 'row'];
/** This file belongs to ONE worker instance/assignment. Reopening permits packet
 * inspection/retransmission, never model/tool replay or a new RAM identity. The
 * remote proof must still use the live original instance key and current Doc gate.
 * ACK means durable event delivery, not execution settlement or OS closure. */
export function createWorkerEventJournal({ file, authorityId, rootScopeRef, assignmentDigest, binding,
  failpoint = () => {} } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || typeof failpoint !== 'function') fail(503, 'worker-journal-configuration');
  const sample = validateWorkerEventPacket({ v: 1, authorityId, rootScopeRef, assignmentDigest, binding,
    sourceSeq: 1, eventId: 'configuration', event: { type: 'configuration' } });
  const scope = Object.fromEntries(['authorityId', 'rootScopeRef', 'assignmentDigest', 'binding'].map(k => [k, sample[k]]));
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file); let fatal = null, closed = false;
  function usable() { if (fatal) throw fatal; if (closed) fail(503, 'worker-journal-closed'); }
  function transaction(point, fn) {
    usable();
    try {
      db.exec('BEGIN IMMEDIATE'); const result = fn(); failpoint(`${point}-before-commit`);
      db.exec('COMMIT'); return structuredClone(result);
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* Preserve the first I/O failure. */ }
      if (!error.status || error.status >= 500) { error.status ??= 503; error.code ??= 'worker-journal-persistence'; fatal ??= error; }
      throw error;
    }
  }
  function validateReceipt(receipt, packet) {
    const r = structuredClone(receipt), b = packet.binding;
    const publicEvent = { ...packet.event, ...b };
    if (publicEvent.type === 'tool_result') { delete publicEvent.output; publicEvent.outputOmitted = true; }
    if (!r || Object.keys(r).sort().join(',') !== [...receiptKeys].sort().join(',') || r.v !== 1 ||
        r.authorityId !== packet.authorityId || r.runGrantId !== b.runGrantId || r.instanceId !== b.instanceId ||
        r.instanceGeneration !== b.instanceGeneration || r.assignmentDigest !== packet.assignmentDigest ||
        r.sourceSeq !== packet.sourceSeq || r.eventId !== packet.eventId || r.packetDigest !== digestOf(packet) ||
        !Number.isSafeInteger(r.eventSeq) || r.eventSeq < 1 || r.row?.eventSeq !== r.eventSeq ||
        r.row.v !== 1 || r.row.authorityId !== packet.authorityId || r.row.eventId !== packet.eventId ||
        WORKER_EVENT_BINDING_FIELDS.some(k => r.row[k] !== b[k]) ||
        canonicalJson(r.row.event) !== canonicalJson(publicEvent) || r.eventDigest !== digestOf(r.row)) fail(403, 'worker-journal-receipt');
    return r;
  }
  function inventory() {
    usable();
    const meta = db.prepare('SELECT * FROM worker_scope WHERE id=1').get();
    if (!meta || meta.scope !== canonicalJson(scope)) fail(503, 'worker-journal-scope');
    const rows = db.prepare('SELECT * FROM worker_packets ORDER BY seq').all();
    if (rows.length !== meta.head || meta.ack_head < 0 || meta.ack_head > meta.head) fail(503, 'worker-journal-gap');
    let previousEventSeq = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]; let packet;
      try { packet = validateWorkerEventPacket(JSON.parse(row.packet)); } catch { fail(503, 'worker-journal-gap'); }
      if (row.seq !== i + 1 || packet.sourceSeq !== row.seq || packet.eventId !== row.event_id ||
          canonicalJson(Object.fromEntries(Object.keys(scope).map(k => [k, packet[k]]))) !== canonicalJson(scope) ||
          row.packet !== canonicalJson(packet) || (row.seq <= meta.ack_head) !== (row.receipt !== null)) fail(503, 'worker-journal-gap');
      if (row.receipt !== null) {
        let r; try { r = validateReceipt(JSON.parse(row.receipt), packet); } catch { fail(503, 'worker-journal-receipt'); }
        if (r.eventSeq <= previousEventSeq) fail(503, 'worker-journal-gap'); previousEventSeq = r.eventSeq;
      }
    }
    return { meta, rows };
  }
  try {
    // Exclusive SQLite ownership lasts until close; a second live writer cannot
    // share this instance journal. A stale OS is handled by root, not PID guessing.
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE;
      CREATE TABLE IF NOT EXISTS worker_scope(id INTEGER PRIMARY KEY CHECK(id=1),scope TEXT NOT NULL,head INTEGER NOT NULL,ack_head INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS worker_packets(seq INTEGER PRIMARY KEY,event_id TEXT NOT NULL UNIQUE,packet TEXT NOT NULL,receipt TEXT);`);
    transaction('scope', () => {
      const prior = db.prepare('SELECT scope FROM worker_scope WHERE id=1').get();
      if (prior && prior.scope !== canonicalJson(scope)) fail(503, 'worker-journal-scope');
      if (!prior) db.prepare('INSERT INTO worker_scope VALUES(1,?,0,0)').run(canonicalJson(scope));
    });
    inventory(); fs.chmodSync(file, 0o600);
  } catch (error) { db.close(); throw error; }
  function append({ eventId, event } = {}) {
    const state = inventory();
    const prior = state.rows.find(row => row.event_id === eventId);
    const packet = validateWorkerEventPacket({ v: 1, ...scope, sourceSeq: prior?.seq ?? state.meta.head + 1, eventId, event });
    if (prior) { if (prior.packet !== canonicalJson(packet)) fail(409, 'worker-journal-conflict'); return structuredClone(packet); }
    return transaction('packet', () => {
      db.prepare('INSERT INTO worker_packets VALUES(?,?,?,NULL)').run(packet.sourceSeq, eventId, canonicalJson(packet));
      db.prepare('UPDATE worker_scope SET head=? WHERE id=1').run(packet.sourceSeq); return packet;
    });
  }
  function acknowledge(receipt) {
    const { meta, rows } = inventory();
    const found = rows.find(row => row.seq === receipt?.sourceSeq);
    if (!found) fail(403, 'worker-journal-receipt');
    const r = validateReceipt(receipt, JSON.parse(found.packet));
    if (found.receipt !== null) {
      if (found.receipt !== canonicalJson(r)) fail(409, 'worker-journal-receipt-conflict'); return structuredClone(r);
    }
    if (r.sourceSeq !== meta.ack_head + 1) fail(409, 'worker-journal-ack-sequence');
    const previous = rows.find(row => row.seq === meta.ack_head);
    if (previous && JSON.parse(previous.receipt).eventSeq >= r.eventSeq) fail(403, 'worker-journal-receipt');
    return transaction('ack', () => {
      db.prepare('UPDATE worker_packets SET receipt=? WHERE seq=?').run(canonicalJson(r), r.sourceSeq);
      db.prepare('UPDATE worker_scope SET ack_head=? WHERE id=1').run(r.sourceSeq); return r;
    });
  }
  return { append, acknowledge,
    source(packet) {
      const { rows } = inventory(), found = rows.find(row => row.seq === packet?.sourceSeq);
      if (!found || found.packet !== canonicalJson(packet)) fail(503, 'worker-journal-source'); return JSON.parse(found.packet);
    },
    pending: () => inventory().rows.filter(row => row.receipt === null).map(row => JSON.parse(row.packet)),
    receipt(eventId) { const found = inventory().rows.find(row => row.event_id === eventId); return found?.receipt ? JSON.parse(found.receipt) : null; },
    inspect() { const { meta } = inventory(); return { head: meta.head, ackHead: meta.ack_head,
      synchronous: db.prepare('PRAGMA synchronous').get().synchronous, integrity: db.prepare('PRAGMA integrity_check').get().integrity_check }; },
    close() { if (!closed) { closed = true; db.close(); } if (fatal) throw fatal; },
  };
}
