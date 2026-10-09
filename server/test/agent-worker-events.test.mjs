import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createAccountRunEvents } from '../agent/service/account-run-events.mjs';
import { createWorkerEventInternalHandler, WORKER_EVENT_PATH, WORKER_EVENT_PROOF_HEADER,
  workerEventRequest, workerEventProofPayload, workerEventTlsBinding } from '../agent-service/worker-event-internal.mjs';
import { canonicalJson, digestOf } from '../account/ledger.mjs';

// Real FULL SQLite and Ed25519. Doc getter, TLS/exporter and request streams are
// controlled adapters, with no HTTP/TLS listener; not the production observer.
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-worker-remote-events-')), file = path.join(dir, 'events.sqlite');
  const key = generateKeyPairSync('ed25519'), publicKey = key.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const binding = { projectId: 'p', conversationId: 'c', messageId: 'm', runId: 'r', runGrantId: 'g',
    instanceId: 'i', instanceGeneration: 1, serviceKid: 'worker-kid', senderAccountId: 'a' };
  const packet = { v: 1, authorityId: 'doc', rootScopeRef: { rootAuthorityId: 'root', slotId: 'slot', epoch: 1, recordDigest: 'a'.repeat(64) },
    assignmentDigest: 'b'.repeat(64), binding, sourceSeq: 1, eventId: 'worker-event:1', event: { type: 'text', delta: 'actual text' } };
  const source = { allowed: true, runGrant: { ...binding, accountId: 'a', state: 'active', readReceiptId: 'read' },
    rootScopeRef: packet.rootScopeRef, assignmentDigest: packet.assignmentDigest, scopePublicKey: publicKey,
    scopePublicKeyDigest: digestOf(publicKey), workerFingerprint256: 'c'.repeat(64), fenceRevision: 1, authorityRevision: 1,
    message: { messageId: 'm', requestId: 'send', arrivalSeq: 1, senderAccountId: 'a', senderNameAtSend: 'Sender',
      content: 'original queued text', contentDigest: digestOf('original queued text'), createdAt: 1, attachments: [],
      selectionSnapshot: { projectId: 'p', accountId: 'a', messageId: 'm' } } };
  const open = () => createAccountRunEvents({ file, authorityId: 'doc', verifyGrant: async () => { throw Error('not-a-worker-getter'); } });
  return { dir, file, key, packet, source, open, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('master atomically commits trusted original message + ordered worker event + exact replay ACK', async () => {
  const f = fixture(); let store = f.open(), checked = 0;
  const readSource = async () => { checked++; return f.source; };
  try {
    const first = await store.appendWorker({ packet: f.packet, readSource });
    assert.equal(first.eventSeq, 2); assert.equal(first.sourceSeq, 1);
    const rows = store.after({ ...f.packet.binding, after: 0 }).events;
    assert.deepEqual(rows.map(r => r.event.type), ['user', 'text']);
    assert.equal(rows[0].event.prompt, f.source.message.content); assert.equal(rows[0].event.senderNameAtSend, 'Sender');
    assert.equal(rows[1].event.runId, 'r');
    await store.close(); store = f.open();
    assert.deepEqual(await store.appendWorker({ packet: f.packet, readSource }), first);
    assert.equal(checked, 2); assert.equal(store.after({ ...f.packet.binding }).head, 2);
    await assert.rejects(store.appendWorker({ packet: { ...f.packet, event: { type: 'text', delta: 'changed' } }, readSource }), { code: 'worker-event-conflict' });
    await assert.rejects(store.appendWorker({ packet: { ...f.packet, sourceSeq: 3, eventId: 'worker-event:3' }, readSource }), { code: 'worker-event-sequence' });
    const next = { ...f.packet, sourceSeq: 2, eventId: 'worker-event:2', event: { type: 'tool_result', output: { internal: true } } };
    const receipt = await store.appendWorker({ packet: next, readSource });
    assert.equal(receipt.eventSeq, 3); assert.equal(receipt.row.event.output, undefined); assert.equal(receipt.row.event.outputOmitted, true);
    await assert.rejects(store.appendWorker({ packet: next, readSource: async () => ({ ...f.source, runGrant: { ...f.source.runGrant, state: 'revoked' } }) }), { code: 'worker-event-source' });
  } finally { await store.close(); f.cleanup(); }
});

test('SQLite event failure rolls back original mirror/source ACK and latches future writer failure', async () => {
  const f = fixture(), store = f.open();
  try {
    const db = new DatabaseSync(f.file);
    try { db.exec("CREATE TRIGGER fail_worker_packet BEFORE INSERT ON worker_source_packets BEGIN SELECT RAISE(ABORT,'worker-packet-disk-failure'); END;"); }
    finally { db.close(); }
    await assert.rejects(store.appendWorker({ packet: f.packet, readSource: async () => f.source }), /worker-packet-disk-failure/);
    assert.equal(store.after({ ...f.packet.binding }).head, 0);
    const inspect = new DatabaseSync(f.file);
    try { for (const table of ['worker_source_packets', 'worker_source_heads', 'accepted_messages'])
      assert.equal(inspect.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0); }
    finally { inspect.close(); }
    await assert.rejects(store.appendWorker({ packet: f.packet, readSource: async () => f.source }), /worker-packet-disk-failure/);
    await assert.rejects(store.close(), /worker-packet-disk-failure/);
  } finally { await store.close().catch(() => {}); f.cleanup(); }
});

test('missing durable tail cannot be reported as a lower source head or replayed ACK', async () => {
  const f = fixture(), store = f.open();
  try {
    await store.appendWorker({ packet: f.packet, readSource: async () => f.source });
    const db = new DatabaseSync(f.file);
    try { db.exec('DELETE FROM worker_source_packets'); } finally { db.close(); }
    await assert.rejects(store.appendWorker({ packet: f.packet, readSource: async () => f.source }), { code: 'worker-event-gap' });
    await assert.rejects(store.close(), { code: 'worker-event-gap' });
  } finally { await store.close().catch(() => {}); f.cleanup(); }
});

test('receiver verifies full raw bytes/key/peer/current source and nonce; never trusts body capability', async () => {
  const f = fixture(), store = f.open(); let calls = 0, denied = false;
  const socket = { encrypted: true, authorized: true, destroyed: false,
    exportKeyingMaterial: () => Buffer.alloc(32, 8), getPeerCertificate: () => ({ fingerprint256: 'c'.repeat(64) }) };
  const handler = createWorkerEventInternalHandler({ eventStore: store, resolveWorker: async input => {
    calls++; assert.deepEqual(Object.keys(input).sort(), ['assignmentDigest', 'projectId', 'runGrantId']);
    if (denied) throw Object.assign(Error('run-revoked'), { status: 403, code: 'run-revoked' }); return f.source;
  } });
  const request = async ({ bytes = Buffer.from(JSON.stringify(f.packet)), signText = bytes.toString('utf8'), nonce = 'n', peer = socket } = {}) => {
    const input = workerEventRequest({ body: f.packet, bodyText: signText });
    const signature = sign(null, Buffer.from(canonicalJson(workerEventProofPayload({ request: input,
      channelBinding: workerEventTlsBinding(socket), nonce }))), f.key.privateKey).toString('base64url');
    const req = Readable.from([bytes]); req.socket = peer; req.url = WORKER_EVENT_PATH; req.method = 'POST';
    req.headers = { [WORKER_EVENT_PROOF_HEADER]: Buffer.from(JSON.stringify({ v: 1, nonce, signature })).toString('base64url') };
    let status, body; const res = { writeHead(code) { status = code; }, end(text) { body = JSON.parse(text); } };
    assert.equal(await handler(req, res), true); return { status, body };
  };
  try {
    assert.equal((await request()).status, 200);
    assert.equal((await request()).body.code, 'worker-event-replay');
    assert.equal((await request({ nonce: 'n2', bytes: Buffer.from(' ' + JSON.stringify(f.packet)), signText: JSON.stringify(f.packet) })).body.code, 'worker-event-signature');
    assert.equal((await request({ nonce: 'n3', peer: { ...socket, getPeerCertificate: () => ({ fingerprint256: 'd'.repeat(64) }) } })).body.code, 'worker-event-peer');
    const beforeInvalid = calls;
    assert.equal((await request({ nonce: 'n4', bytes: Buffer.from([0xff]), signText: JSON.stringify(f.packet) })).status, 400);
    assert.equal(calls, beforeInvalid);
    denied = true;
    assert.equal((await request({ nonce: 'n5' })).body.code, 'run-revoked');
    assert.equal(store.after({ ...f.packet.binding }).head, 2);
    assert.throws(() => createWorkerEventInternalHandler({ eventStore: store }), { code: 'worker-event-configuration' });
  } finally { await store.close(); f.cleanup(); }
});
