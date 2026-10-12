import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { verify } from 'node:crypto';
import { assetWiringPki } from './fixtures/asset-wiring-pki.mjs';
import { scopeModel } from './agent-run-scope-fixture.mjs';
import { createAgentInstanceSession } from '../agent/service/agent-instance-session.mjs';
import { createAccountRunEvents } from '../agent/service/account-run-events.mjs';
import { createWorkerEventInternalHandler } from '../agent-service/worker-event-internal.mjs';
import { createWorkerEventJournal } from '../agent-service/worker-event-journal.mjs';
import { createWorkerEventSink } from '../agent-service/worker-event-sink.mjs';
import { canonicalJson, digestOf } from '../account/ledger.mjs';

// Actual mTLS/exporter/original RAM signer/Ed25519/FULL worker+master SQLite.
// Registration, root OS and current Doc getter are CONTROLLED in this component
// target. It does not prove production Doc/UID/OS-worker admission or settlement.
test('durable worker → signed actual TLS → durable master → durable ACK; lost ACK replays only packet', { timeout: 45000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-worker-sink-tls-'));
  const pki = assetWiringPki(dir), model = scopeModel('event-tls');
  let journal, sink, drop = false, denied = false, getterCalls = 0, wireKey;
  const session = createAgentInstanceSession({ registrationPurpose: 'run-worker', workerEventSource: async packet => journal.source(packet),
    requestRegistration: async (name, body) => {
      if (name === 'challenge') {
        wireKey = body.publicKey;
        return { domain: 'promptcut.agent-instance.register.v1', authorityId: 'doc', serviceId: 'agent', serviceKid: 'agent-kid',
          requestId: body.requestId, challengeId: 'challenge', nonce: 'nonce', publicKeyDigest: digestOf(body.publicKey),
          purpose: 'run-worker', rootScopeRef: body.rootScopeRef, docPublicKeyDigest: digestOf(body.publicKey),
          scopePublicKeyDigest: session.scopeIdentity().scopePublicKeyDigest };
      }
      assert.ok(verify(null, Buffer.from(canonicalJson(body.challenge)), wireKey, Buffer.from(body.signature, 'base64url')));
      return { authorityId: 'doc', serviceId: 'agent', serviceKid: 'agent-kid',
        instanceId: model.files.get('epoch-1.json').instance.instanceId, instanceGeneration: 1,
        purpose: 'run-worker', rootScopeRef: body.challenge.rootScopeRef };
    } });
  const key = session.scopeIdentity(), identity = model.io.identity;
  model.io.identity = async reservation => ({ ...await identity(reservation), publicKey: key.scopePublicKey, publicKeyDigest: key.scopePublicKeyDigest });
  await model.run('initialize');
  const record = model.files.get('epoch-1.json'), assignment = model.assignment();
  session.configureRegistrationScope({ expected: model.expected, record }); await session.register();
  session.bindScope({ expected: model.expected, record, assignment });
  const binding = { ...Object.fromEntries(['projectId', 'conversationId', 'messageId', 'runId', 'runGrantId',
    'instanceId', 'instanceGeneration', 'serviceKid'].map(k => [k, assignment.target[k]])), senderAccountId: 'account-a' };
  const scope = { authorityId: 'doc', rootScopeRef: { rootAuthorityId: model.expected.authorityId, slotId: model.expected.slotId,
    epoch: record.epoch, recordDigest: digestOf(record) }, assignmentDigest: digestOf(assignment), binding };
  const grant = { ...binding, accountId: binding.senderAccountId, state: 'active', readReceiptId: 'read' };
  const source = { allowed: true, assignmentDigest: scope.assignmentDigest, rootScopeRef: scope.rootScopeRef,
    scopePublicKey: key.scopePublicKey, scopePublicKeyDigest: key.scopePublicKeyDigest, workerFingerprint256: pki.wrong.fingerprint256,
    runGrant: grant, fenceRevision: 1, authorityRevision: 1,
    message: { messageId: binding.messageId, requestId: 'send', arrivalSeq: 1, createdAt: 1, content: 'original',
      contentDigest: digestOf('original'), senderAccountId: 'account-a', senderNameAtSend: 'Sender', attachments: [],
      selectionSnapshot: { projectId: binding.projectId, accountId: 'account-a', messageId: binding.messageId } } };
  const store = createAccountRunEvents({ file: path.join(dir, 'master.sqlite'), authorityId: 'doc', verifyGrant: async () => { throw Error('not-a-human-gate'); } });
  const handler = createWorkerEventInternalHandler({ eventStore: store, resolveWorker: async input => {
    getterCalls++; assert.deepEqual(input, { projectId: binding.projectId, runGrantId: binding.runGrantId, assignmentDigest: scope.assignmentDigest });
    if (denied) throw Object.assign(Error('current-run-revoked'), { status: 403, code: 'current-run-revoked' });
    return source;
  } });
  const sockets = new Set();
  const server = https.createServer({ ...pki.asset, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3' }, (req, res) => {
    if (drop) { drop = false; res.end = () => { res.destroy(); }; }
    void handler(req, res).catch(() => res.destroy());
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  t.after(async () => {
    const closes = await Promise.allSettled([sink?.close().catch(error => {
      // This target intentionally latches transport/revocation failure; require
      // that exact closure failure instead of pretending successful delivery.
      assert.match(error.message, /worker-sink-close-pending/);
    }), ...[...sockets].map(socket => new Promise(resolve => { socket.once('close', resolve); socket.destroy(); })),
    server.listening ? new Promise(resolve => server.close(resolve)) : null, store.close()]);
    session.close(); assert.equal(sockets.size, 0);
    assert.deepEqual(sink?.describe(), { requests: 0, sockets: 0, responses: 0, writerCreated: false });
    const errors = closes.filter(r => r.status === 'rejected').map(r => r.reason);
    if (errors.length) throw new AggregateError(errors, 'worker-sink-fixture-close');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(6702, '127.0.0.1', resolve); });
  const open = () => {
    journal = createWorkerEventJournal({ file: path.join(dir, 'worker.sqlite'), ...scope });
    sink = createWorkerEventSink({ journal, runClient: session, origin: 'https://127.0.0.1:6702', tls: pki.wrong,
      serverFingerprint256: pki.asset.fingerprint256, timeoutMs: 5000, verifyGrant: async () => ({ allowed: true, runGrant: grant }) });
  };
  open(); const writer = await sink.writer({ grant });
  writer.emit({ type: 'text', delta: 'actual text' }); writer.emit({ type: 'tool_result', output: { internal: true } });
  await writer.beforeCall(); assert.equal(journal.inspect().ackHead, 2);
  assert.equal(journal.receipt(`event:${binding.runGrantId}:2`).row.event.output, undefined);
  assert.deepEqual(store.after({ ...binding }).events.map(row => row.event.type), ['user', 'text', 'tool_result']);
  drop = true; writer.emit({ type: 'text', delta: 'ACK will be lost' });
  await writer.failed; await assert.rejects(writer.flush());
  assert.equal(journal.pending().length, 1); assert.equal(store.after({ ...binding }).head, 4);
  const pending = journal.pending()[0], readsBefore = getterCalls;
  await assert.rejects(sink.close(), /worker-sink-close-pending/);
  open(); await assert.rejects(sink.writer({ grant }), /execution-replay-pending/);
  await sink.replayPending(); assert.equal(journal.inspect().ackHead, 3);
  assert.equal(journal.receipt(pending.eventId).sourceSeq, pending.sourceSeq);
  assert.equal(store.after({ ...binding }).head, 4); assert.equal(getterCalls, readsBefore + 1);
  denied = true;
  journal.append({ eventId: 'revoked-event', event: { type: 'text', delta: 'must not become visible' } });
  await assert.rejects(sink.replayPending(), { code: 'current-run-revoked' });
  assert.equal(store.after({ ...binding }).head, 4); assert.equal(journal.pending().length, 1);
  assert.equal(sink.describe().sockets, 0); assert.equal(sink.describe().requests, 0); assert.equal(sink.describe().responses, 0);
  t.diagnostic('owned master HTTPS 6702; real worker/master FULL journals and exporter signatures; controlled registration/root OS/Doc getter; settlement pending');
});
