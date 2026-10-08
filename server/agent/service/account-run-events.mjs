import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson, digestOf } from '../../account/ledger.mjs';

const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
const text = v => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(v);
const fields = ['projectId', 'conversationId', 'messageId', 'runId', 'runGrantId',
  'instanceId', 'instanceGeneration', 'serviceKid', 'senderAccountId'];
const bindingOf = grant => Object.fromEntries(fields.map(k => [k,
  k === 'senderAccountId' ? grant?.accountId : grant?.[k]]));
function validateBinding(value) {
  if (!value || fields.some(k => k === 'instanceGeneration'
    ? !Number.isSafeInteger(value[k]) || value[k] < 1 : !text(value[k]))) fail(403, 'run-event-binding');
}

/** Private Agent execution evidence, not a replacement for doc message/ACL/run
 * authority. verifyGrant must invoke the current signed doc run gate. Never expose
 * registerRun/append to an HTTP body or treat an event binding as a credential. */
export function createAccountRunEvents({ file, authorityId, verifyGrant, failpoint = () => {}, now = Date.now } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || !text(authorityId) || typeof verifyGrant !== 'function') fail(503, 'run-events-configuration');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS event_authority (id INTEGER PRIMARY KEY CHECK(id=1), authority TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS run_bindings (grant_id TEXT PRIMARY KEY, binding TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_heads (project_id TEXT, conversation_id TEXT, head INTEGER NOT NULL,
        PRIMARY KEY(project_id,conversation_id));
      CREATE TABLE IF NOT EXISTS accepted_messages (project_id TEXT, conversation_id TEXT, message_id TEXT,
        arrival_seq INTEGER NOT NULL, content TEXT NOT NULL, event_seq INTEGER NOT NULL,
        PRIMARY KEY(project_id,conversation_id,message_id), UNIQUE(project_id,conversation_id,arrival_seq));
      CREATE TABLE IF NOT EXISTS run_events (project_id TEXT, conversation_id TEXT, seq INTEGER NOT NULL,
        grant_id TEXT NOT NULL, event_id TEXT NOT NULL, content TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY(project_id,conversation_id,seq), UNIQUE(grant_id,event_id));`);
    const prior = db.prepare('SELECT authority FROM event_authority WHERE id=1').get();
    if (prior && prior.authority !== authorityId) fail(503, 'run-events-authority');
    if (!prior) db.prepare('INSERT INTO event_authority VALUES(1,?)').run(authorityId);
    fs.chmodSync(file, 0o600);
  } catch (error) { db.close(); throw error; }
  let tail = Promise.resolve(), fatal = null, closing = false, closed = false;
  function usable() { if (fatal) throw fatal; if (closed) fail(503, 'run-events-closed'); }
  function transaction(point, fn) {
    usable(); db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); failpoint(`${point}-before-commit`); db.exec('COMMIT'); return structuredClone(result); }
    catch (error) { try { db.exec('ROLLBACK'); } catch { /* Preserve the original persistence error. */ }
      if (!error.status || error.status >= 500) {
        error.status ??= 503; error.code ??= 'run-events-persistence'; fatal = error;
      }
      throw error;
    }
  }
  const bound = binding => {
    validateBinding(binding);
    const found = db.prepare('SELECT binding FROM run_bindings WHERE grant_id=?').get(binding.runGrantId);
    if (!found || found.binding !== canonicalJson(binding)) fail(403, 'run-event-binding');
  };
  const headOf = (projectId, conversationId) => db.prepare('SELECT head FROM conversation_heads WHERE project_id=? AND conversation_id=?').get(projectId, conversationId)?.head ?? 0;
  function insertEvent(binding, eventId, event, grantKey, content) {
    const args = [binding.projectId, binding.conversationId];
    const eventSeq = headOf(...args) + 1;
    if (!Number.isSafeInteger(eventSeq)) fail(503, 'run-event-overflow');
    const row = { v: 1, authorityId, ...binding, eventId, eventSeq, at: now(), event };
    db.prepare('INSERT INTO run_events VALUES(?,?,?,?,?,?,?)').run(...args, eventSeq, grantKey, eventId, content, JSON.stringify(row));
    db.prepare('INSERT INTO conversation_heads VALUES(?,?,?) ON CONFLICT(project_id,conversation_id) DO UPDATE SET head=excluded.head').run(...args, eventSeq);
    return row;
  }
  async function registerRun({ grant }) {
    usable(); if (closing) fail(503, 'run-events-closed');
    const source = structuredClone(grant), binding = bindingOf(source); validateBinding(binding);
    const checked = await verifyGrant(source);
    if (checked?.allowed !== true || canonicalJson(bindingOf(checked.runGrant)) !== canonicalJson(binding)) fail(403, 'run-event-grant');
    if (closing) fail(503, 'run-events-closed');
    return transaction('binding', () => {
      const prior = db.prepare('SELECT binding FROM run_bindings WHERE grant_id=?').get(binding.runGrantId);
      if (prior && prior.binding !== canonicalJson(binding)) fail(409, 'run-event-binding-conflict');
      if (!prior) db.prepare('INSERT INTO run_bindings VALUES(?,?)').run(binding.runGrantId, canonicalJson(binding));
      return binding;
    });
  }
  function append(input) {
    // Copy before yielding: runner code may reuse/mutate the event object after emit.
    let captured;
    try { captured = structuredClone(input); } catch { return Promise.reject(Object.assign(new Error('run-event-invalid'), { status: 400 })); }
    if (closing) return Promise.reject(Object.assign(new Error('run-events-closed'), { status: 503 }));
    const work = tail.then(() => transaction('event', () => {
      const { binding, eventId } = captured; bound(binding);
      if (!text(eventId) || !text(captured.event?.type)) fail(400, 'run-event-invalid');
      const event = { ...captured.event, ...binding };
      if (event.type === 'tool_result') { delete event.output; event.outputOmitted = true; }
      const content = canonicalJson({ binding, event });
      const prior = db.prepare('SELECT content,payload FROM run_events WHERE grant_id=? AND event_id=?').get(binding.runGrantId, eventId);
      if (prior) { if (prior.content !== content) fail(409, 'run-event-conflict'); return JSON.parse(prior.payload); }
      return insertEvent(binding, eventId, event, binding.runGrantId, content);
    }));
    // Supervise immediately; the returned original promise still rejects for its owner.
    tail = work.catch(() => {}); return work;
  }
  /** Private caller supplies a fresh doc conversation read, never messages from a
   * public send body. Production must own the actual read-control HTTP/SSE scope;
   * absence of that scope is propagated, never replaced by an ACL bypass. */
  async function mirrorAccepted({ projectId, conversationId, read }) {
    usable(); if (closing) fail(503, 'run-events-closed');
    if (typeof read !== 'function') fail(503, 'accepted-message-source');
    if (!text(projectId) || !text(conversationId)) fail(403, 'accepted-message-scope');
    const snapshot = structuredClone(await read());
    if (snapshot?.v !== 2 || snapshot.projectId !== projectId || snapshot.id !== conversationId ||
        !Array.isArray(snapshot.messages)) fail(403, 'accepted-message-scope');
    if (closing) fail(503, 'run-events-closed');
    // Mutable queue/read/run references do not change the accepted original.
    const seen = new Set(), arrivals = new Set();
    const records = snapshot.messages.map(message => {
      if (!text(message?.messageId) || !text(message.requestId) || !text(message.senderAccountId) ||
          typeof message.senderNameAtSend !== 'string' || typeof message.content !== 'string' ||
          message.contentDigest !== digestOf(message.content) || !Number.isSafeInteger(message.arrivalSeq) || message.arrivalSeq < 1 ||
          !Number.isSafeInteger(message.createdAt) || message.createdAt < 0 || !Array.isArray(message.attachments) ||
          message.selectionSnapshot?.projectId !== projectId || message.selectionSnapshot?.accountId !== message.senderAccountId ||
          message.selectionSnapshot?.messageId !== message.messageId || seen.has(message.messageId) || arrivals.has(message.arrivalSeq))
        fail(403, 'accepted-message-record');
      seen.add(message.messageId); arrivals.add(message.arrivalSeq);
      return Object.fromEntries(['messageId', 'requestId', 'arrivalSeq', 'senderAccountId', 'senderNameAtSend',
        'createdAt', 'content', 'contentDigest', 'selectionSnapshot', 'attachments'].map(k => [k, message[k]]));
    }).sort((a, b) => a.arrivalSeq - b.arrivalSeq);
    const work = tail.then(() => transaction('accepted-message', () => {
      let appended = 0;
      for (const record of records) {
        const args = [projectId, conversationId, record.messageId], content = canonicalJson(record);
        const prior = db.prepare('SELECT content,event_seq FROM accepted_messages WHERE project_id=? AND conversation_id=? AND message_id=?').get(...args);
        if (prior) {
          if (prior.content !== content) fail(409, 'accepted-message-conflict');
          const event = db.prepare('SELECT content FROM run_events WHERE project_id=? AND conversation_id=? AND seq=?').get(projectId, conversationId, prior.event_seq);
          if (!event || event.content !== content) fail(503, 'accepted-message-gap');
          continue;
        }
        const binding = { projectId, conversationId, messageId: record.messageId, senderAccountId: record.senderAccountId,
          runId: null, runGrantId: null, instanceId: null, instanceGeneration: null, serviceKid: null };
        const event = { type: 'user', messageId: record.messageId, prompt: record.content,
          senderAccountId: record.senderAccountId, senderNameAtSend: record.senderNameAtSend,
          arrivalSeq: record.arrivalSeq, createdAt: record.createdAt,
          selectionSnapshot: record.selectionSnapshot, attachments: record.attachments };
        // @ is excluded from grant IDs, so message keys cannot collide with runs.
        const row = insertEvent(binding, `message:${record.messageId}`, event, `@message:${projectId}:${conversationId}`, content);
        db.prepare('INSERT INTO accepted_messages VALUES(?,?,?,?,?,?)').run(...args, record.arrivalSeq, content, row.eventSeq);
        appended++;
      }
      return { appended, head: headOf(projectId, conversationId) };
    }));
    tail = work.catch(() => {}); return work;
  }
  function after({ projectId, conversationId, after = 0 }) {
    if (closed) fail(503, 'run-events-closed');
    if (!text(projectId) || !text(conversationId) || !Number.isSafeInteger(after) || after < 0) fail(400, 'run-event-cursor');
    const head = db.prepare('SELECT head FROM conversation_heads WHERE project_id=? AND conversation_id=?').get(projectId, conversationId)?.head ?? 0;
    const count = db.prepare('SELECT COUNT(*) AS count,MAX(seq) AS last FROM run_events WHERE project_id=? AND conversation_id=?').get(projectId, conversationId);
    if (count.count !== head || (count.last ?? 0) !== head) fail(503, 'run-event-gap');
    if (after > head) fail(409, 'run-event-cursor');
    return { authorityId, projectId, conversationId, head,
      events: db.prepare('SELECT payload FROM run_events WHERE project_id=? AND conversation_id=? AND seq>? ORDER BY seq').all(projectId, conversationId, after).map(r => JSON.parse(r.payload)) };
  }
  async function writer({ grant }) {
    const binding = await registerRun({ grant });
    let serial = Promise.resolve(), error = null, next = 0, resolveFailure;
    const failed = new Promise(resolve => { resolveFailure = resolve; });
    const stop = cause => { if (!error) { error = cause; resolveFailure(cause); } };
    return { binding, failed, stop,
      emit(event) {
        if (error) return;
        let copy;
        try { copy = structuredClone(event); } catch (cause) { stop(cause); return; }
        const eventId = `event:${binding.runGrantId}:${++next}`;
        const work = serial.then(() => { if (error) throw error; return append({ binding, eventId, event: copy }); });
        serial = work.catch(stop);
      },
      async flush() { await serial; if (error) throw error; usable(); },
      async beforeCall() { await serial; if (error) throw error; usable(); },
    };
  }
  return { registerRun, append, after, writer, mirrorAccepted, failure: () => fatal,
    inspect: () => ({ synchronous: db.prepare('PRAGMA synchronous').get().synchronous,
      journalMode: db.prepare('PRAGMA journal_mode').get().journal_mode, integrity: db.prepare('PRAGMA integrity_check').get().integrity_check }),
    async close() { if (closed) { if (fatal) throw fatal; return; }
      closing = true; await tail; if (!closed) { closed = true; db.close(); }
      if (fatal) throw fatal;
    },
  };
}
