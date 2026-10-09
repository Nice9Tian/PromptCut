import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { once } from 'node:events';
import { verify } from 'node:crypto';
import { createRunClient } from '../agent-service/run-client.mjs';
import { createAgentInstanceSession } from '../agent/service/agent-instance-session.mjs';
import { createDocService } from '../docservice/service.mjs';
import { createAgentRunScopeDoc, agentScopeRef } from '../account/agent-run-scope-doc.mjs';
import { createAgentInstanceAuthority, instanceTlsBinding, instanceProofPayload } from '../account/agent-instance-authority.mjs';
import { createAgentInstanceInternalHandler, instanceRequestProof } from '../account/agent-instance-internal.mjs';
import { createRunInternalHandler } from '../account/run-internal.mjs';
import { createRunAuthority, canonicalReadRecord } from '../account/run-authority.mjs';
import { inspectAgentScopeSource } from '../hosted/agent-run-scope-reader.mjs';
import { openOperationHistory } from '../docservice/modules/operation-history.mjs';
import { createPasswordOrder } from '../account/password-order.mjs';
import { certificateFingerprint } from '../account/client.mjs';
import { canonicalJson, digestOf } from '../account/ledger.mjs';
import { runFixture, projectId, conversationId, servicePrincipal } from './run-authority-fixture.mjs';
import { scopeModel } from './agent-run-scope-fixture.mjs';
import { assetWiringPki } from './fixtures/asset-wiring-pki.mjs';

// Real clients/original non-exported RAM keys, mTLS/exporter, Doc handlers,
// SQLite authority and product Doc closure inventory. Root OS and accepted
// account issuance are explicit controlled fixtures, not a production executor.
async function fixture(t, { source = true } = {}) {
  const f = await runFixture(), pki = assetWiringPki(f.dir), m = scopeModel();
  const workerPin = certificateFingerprint(pki.asset.fingerprint256);
  const masterPin = certificateFingerprint(pki.account.fingerprint256);
  let expectedPrepare = null;
  const config = { origin: 'https://127.0.0.1:6713', serverFingerprint256: pki.doc.fingerprint256 };
  const worker = createRunClient({ ...config, tls: pki.asset, registrationPurpose: 'run-worker',
    ...(source ? { scopePrepareSource: async value => {
      // Explicit private source adapter. No model/drain producer is claimed.
      assert.equal(canonicalJson(value), canonicalJson(expectedPrepare)); return structuredClone(expectedPrepare);
    } } : {}) });
  const master = createRunClient({ ...config, tls: pki.account, registrationPurpose: 'control-only' });
  m.expected.docAuthorityId = f.ledger.authorityId;
  const key = worker.scopeIdentity(), originalIdentity = m.io.identity;
  m.io.identity = async reservation => ({ ...await originalIdentity(reservation),
    publicKey: key.scopePublicKey, publicKeyDigest: key.scopePublicKeyDigest });
  await m.run('initialize');
  const record = m.files.get('epoch-1.json'), ref = agentScopeRef(record);
  worker.configureRegistrationScope({ expected: m.expected, record });
  const slot = { expected: m.expected, configuredAnchorDigest: digestOf(m.files.get('anchor.json')),
    workerServiceKid: servicePrincipal.serviceKid, workerFingerprint256: workerPin };
  const scope = createAgentRunScopeDoc({ ledger: f.ledger, signingKey: m.doc.privateKey, slots: [slot],
    masterServiceKid: 'master-key', masterFingerprint256: masterPin,
    sourceFactory: () => ({ read: ({ checkpoint }) => inspectAgentScopeSource({ read: m.io.read,
      expected: m.expected, configuredAnchorDigest: slot.configuredAnchorDigest, checkpoint }) }) });
  const transports = new Map(), accepted = new Set(); let serial = 0;
  const resolveServicePrincipal = ({ socket }) => {
    const pin = certificateFingerprint(socket.getPeerCertificate().fingerprint256);
    if (![workerPin, masterPin].includes(pin)) throw Error('wrong-peer');
    const authenticationId = `actual-tls-${++serial}`;
    transports.set(authenticationId, socket); socket.once('close', () => transports.delete(authenticationId));
    return { service: 'agent', serviceKid: pin === masterPin ? 'master-key' : servicePrincipal.serviceKid, authenticationId };
  };
  const instances = createAgentInstanceAuthority({ ledger: f.ledger, scopeAuthority: scope,
    verifyTransportInState(_state, principal) {
      const socket = transports.get(principal.authenticationId);
      const pin = certificateFingerprint(socket?.getPeerCertificate?.().fingerprint256);
      assert.equal(pin, principal.serviceKid === 'master-key' ? masterPin : workerPin);
      return { serviceId: 'agent', serviceKid: principal.serviceKid, authenticationId: principal.authenticationId,
        fingerprint256: pin, channelBinding: instanceTlsBinding(socket) };
    } });
  const provider = createRunAuthority({ ledger: f.ledger, conversationHooks: f.hooks, instanceAuthority: instances,
    scopeAuthority: scope, docInstanceId: 'doc-live', synchronize: async () => {},
    verifySender: async actor => ({ ...actor, accountEventSeq: f.ledger.read().accountHead }),
    verifyServiceInState: (_state, principal) => ({ serviceId: principal.service, serviceKid: principal.serviceKid }) });
  const registration = createAgentInstanceInternalHandler({ instanceAuthority: instances,
    agentFingerprint256: workerPin, masterFingerprint256: masterPin, resolveServicePrincipal });
  const runs = createRunInternalHandler({ runAuthority: provider, agentFingerprint256: workerPin,
    masterFingerprint256: masterPin, resolveServicePrincipal,
    principalForCheck({ projectId: requestedProject, runGrantId, servicePrincipal: principal }) {
      const grant = f.ledger.read().runGrantsV2[runGrantId]; assert.equal(grant.projectId, requestedProject);
      return { ...grant, realm: 'account', identityVersion: 2, role: 'agent', creator: false, servicePrincipal: principal };
    },
    authenticateInvocation({ req, servicePrincipal: principal, body, operation }) {
      const cap = instances.authenticate({ servicePrincipal: principal, method: req.method, path: req.url,
        operation, request: body, proof: instanceRequestProof(req) });
      return { servicePrincipal: { ...principal, ...cap }, release: () => instances.release(cap.instanceSession) };
    } });
  const server = https.createServer({ ...pki.doc, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3' }, async (req, res) => {
    if (!await registration(req, res) && !await runs(req, res)) { res.writeHead(404); res.end(); }
  });
  server.on('connection', socket => { accepted.add(socket); socket.once('close', () => accepted.delete(socket)); });
  t.after(async () => {
    await Promise.all([worker.close(), master.close()]);
    await Promise.all([...accepted].map(socket => new Promise(resolve => { socket.once('close', resolve); socket.destroy(); })));
    if (server.listening) await new Promise(resolve => server.close(resolve));
    instances.close(); f.close();
    assert.equal(accepted.size, 0); assert.equal(transports.size, 0); assert.equal(server.listening, false);
    fs.rmSync(f.dir, { recursive: true, force: true });
    t.diagnostic('6713 actual owned TLS sockets/transports=0; server listening=false; root OS is controlled');
  });
  server.listen(6713, '127.0.0.1'); await once(server, 'listening');
  f.enqueue(); f.enqueue('message2');
  const grant = await worker.admit({ projectId, conversationId, requestId: 'admit' });
  const binding = Object.fromEntries(['projectId', 'conversationId', 'messageId', 'runId', 'runGrantId'].map(k => [k, grant[k]]));
  const assignment = (await worker.scopeAssignment({ ...binding, requestId: 'assignment' })).assignment;
  worker.bindScope({ expected: m.expected, record, assignment });
  await m.run('bind', { assignment });
  const prompt = canonicalReadRecord(grant.message, grant);
  const read = await worker.confirmRead({ ...binding, requestId: 'read', readIntentId: 'intent', prompt, promptDigest: digestOf(prompt) });
  const finish = { ...binding, requestId: 'finish', readReceiptId: read.receipt.receiptId,
    outcome: { v: 1, status: 'failed', eventId: 'real-error-event', eventDigest: '8'.repeat(64) } };
  return { ...f, m, scope, ref, record, assignment, provider, worker, master, grant, binding, finish,
    prepare(receipt) { expectedPrepare = scope.preparePayload(f.ledger.read(), f.ledger.read().runGrantsV2[grant.runGrantId],
      receipt, 'controlled-local-drain'); return worker.scopePrepareFor(expectedPrepare); },
    privateFence() { return f.ledger.transaction(state => f.hooks.privateFenceInState(state, {
      projectId, conversationId, ownerAccountId: 'owner', requestId: 'private', runHooks: provider.hooks })); } };
}

test('actual run client normal settlement remains pending until original RAM prepare, Doc close and root close', { timeout: 20000 }, async t => {
  const f = await fixture(t), { worker, binding, finish } = f;
  for (const name of ['queryFinish', 'scopePrepare', 'scopeTerminal', 'scopeControl']) assert.equal(typeof worker[name], 'function', name);
  const first = await worker.finish(finish); assert.equal(first.finishPending, true);
  assert.deepEqual(await worker.finish(finish), first);
  assert.equal((await worker.queryFinish(finish)).finishPending, true);
  await assert.rejects(worker.queryFinish({ ...finish, outcome: { ...finish.outcome, status: 'done' } }), { code: 'run-request-mismatch' });
  await assert.rejects(worker.finish({ ...finish, outcome: { ...finish.outcome, status: 'done' } }), { code: 'run-request-mismatch' });
  const input = { ...binding, requestId: 'terminal', finishReceiptId: first.finishReceipt.finishReceiptId };
  await assert.rejects(worker.scopeTerminal(input), { code: 'run-scope-prepare-pending' });
  const prepare = await f.prepare(first.finishReceipt);
  await worker.scopePrepare({ ...input, requestId: 'prepare', prepare });
  await assert.rejects(worker.scopePrepare({ ...input, requestId: 'changed', prepare: { ...prepare, drainReceiptId: 'other' } }),
    { code: 'instance-scope-prepare-source' });
  await assert.rejects(worker.scopeTerminal(input), { code: 'run-scope-doc-closure-pending' });
  await assert.rejects(f.master.scopeTerminal(input), { code: 'instance-purpose-forbidden' });
  await assert.rejects(f.master.queryFinish(finish), { code: 'instance-purpose-forbidden' });
  const doc = createDocService({ autoTick: false, log: () => {} });
  try {
    await f.scope.closeDocTerminal({ controlId: first.finishReceipt.controlId, docInstanceId: 'doc-live', service: doc });
    const result = await worker.scopeTerminal(input);
    assert.equal(result.terminal.finish.terminalReceiptDigest, digestOf(prepare));
    const intent = worker.scopeIntentFor({ assignment: f.assignment, terminal: result.terminal });
    assert.equal((await worker.queryFinish(finish)).finishPending, true);
    assert.equal(f.ledger.read().conversationsV2[projectId][conversationId].currentRunId, f.grant.runId);
    await f.m.run('close', { terminal: result.terminal, intent });
    await f.provider.reconcileScopeClosures();
    const settled = await worker.queryFinish(finish);
    assert.equal(settled.finishPending, false); assert.equal(settled.terminalOutcome.status, 'failed');
    const conversation = f.ledger.read().conversationsV2[projectId][conversationId];
    assert.equal(conversation.currentRunId, null); assert.equal(conversation.messages[1].queueState, 'queued');
  } finally { await doc.close(); }
});

test('missing private source cannot mint prepare; private race needs master exact control and independent closure', { timeout: 20000 }, async t => {
  const f = await fixture(t, { source: false }), { worker, finish, binding } = f;
  const first = await worker.finish(finish);
  await assert.rejects(f.prepare(first.finishReceipt), { code: 'instance-scope-prepare-unavailable' });
  f.privateFence();
  const terminalInput = { ...binding, requestId: 'terminal', finishReceiptId: first.finishReceipt.finishReceiptId };
  await assert.rejects(worker.scopeTerminal(terminalInput), { code: 'run-revoked' });
  const controlId = f.ledger.read().runGrantsV2[f.grant.runGrantId].closureControlId;
  const input = { projectId, runGrantId: f.grant.runGrantId, controlId,
    assignmentDigest: digestOf(f.assignment), rootScopeRef: f.ref };
  await assert.rejects(worker.scopeControl(input), { code: 'instance-purpose-forbidden' });
  await assert.rejects(f.master.scopeControl(input), { code: 'run-scope-doc-closure-pending' });
  await assert.rejects(f.master.scopeControl({ ...input, controlId: 'other' }), { status: 403 });
  const doc = createDocService({ autoTick: false, log: () => {} });
  const history = openOperationHistory(path.join(f.dir, 'operations.db')); history.createProject(projectId, { id: projectId });
  const unavailable = () => { throw Error('no-account-operation'); };
  const operations = createPasswordOrder({ history, account: { get: unavailable }, verifyWitness: unavailable, checkGate: unavailable });
  try {
    await f.scope.closeDocControl({ controlId, docInstanceId: 'doc-live', service: doc, operationCoordinator: operations });
    const answer = await f.master.scopeControl(input);
    assert.equal(answer.terminal.fence.controlId, controlId);
    assert.equal((await worker.queryFinish(finish)).finishPending, true);
    assert.equal(f.ledger.read().conversationsV2[projectId][conversationId].currentRunId, f.grant.runId);
    await f.m.run('forced-close', { terminal: answer.terminal, intent: null });
    const settled = await f.provider.reconcileScopeClosures();
    assert.equal(settled[0].terminalOutcome.status, 'interrupted');
    assert.equal(f.ledger.read().conversationsV2[projectId][conversationId].currentRunId, null);
  } finally { await operations.idle(); history.close(); await doc.close(); }
});

test('legacy finish and scoped outcome proofs bind complete body/path/operation/generation/socket; no generic signer', async () => {
  // Controlled registration/exporter inputs, real original RAM Ed25519 crypto.
  // The preceding cases separately exercise the actual TLS/authority boundary.
  const session = createAgentInstanceSession({ requestRegistration: async (name, body) => name === 'challenge'
    ? { domain: 'promptcut.agent-instance.register.v1', authorityId: 'doc', serviceId: 'agent', serviceKid: 'kid',
      requestId: body.requestId, challengeId: 'challenge', nonce: 'nonce', publicKeyDigest: digestOf(body.publicKey) }
    : { authorityId: 'doc', serviceId: 'agent', serviceKid: 'kid', instanceId: 'instance', instanceGeneration: 3 } });
  try {
    const identity = await session.register(), key = session.scopeIdentity().publicKey;
    const socket = { encrypted: true, authorized: true, destroyed: false, exportKeyingMaterial: () => Buffer.alloc(32, 1) };
    const original = { projectId: 'p', conversationId: 'c', messageId: 'm', runId: 'r', runGrantId: 'g', requestId: 'f' };
    for (const body of [original, { ...original, readReceiptId: 'read', outcome: {
      v: 1, status: 'interrupted', eventId: 'event', eventDigest: 'a'.repeat(64) } }]) {
      const request = { socket, method: 'POST', path: '/internal/v2/runs/finish', operation: 'finish', body };
      const proof = JSON.parse(Buffer.from(session.proofFor(request).value, 'base64url'));
      const payload = instanceProofPayload({ ...identity, channelBinding: instanceTlsBinding(socket), method: request.method,
        path: request.path, operation: request.operation, requestDigest: digestOf(body) });
      const valid = value => verify(null, Buffer.from(canonicalJson(value)), key, Buffer.from(proof.signature, 'base64url'));
      assert.equal(valid(payload), true);
      for (const change of [{ path: '/internal/v2/runs/finish/query' }, { operation: 'queryFinish' },
        { instanceGeneration: 4 }, { channelBinding: instanceTlsBinding({ ...socket, exportKeyingMaterial: () => Buffer.alloc(32, 2) }) },
        { requestDigest: digestOf({ ...body, readReceiptId: 'substituted' }) }]) assert.equal(valid({ ...payload, ...change }), false);
      if (body.outcome) assert.equal(valid({ ...payload, requestDigest: digestOf({ ...body, outcome: { ...body.outcome, status: 'done' } }) }), false);
      assert.throws(() => session.proofFor({ ...request, path: '/internal/v2/runs/finish/query' }), { code: 'instance-proof-input' });
      assert.throws(() => session.proofFor({ ...request, body: { ...body, closed: true } }), { code: 'instance-proof-input' });
    }
    assert.throws(() => session.proofFor({ socket, method: 'POST', path: '/internal/v2/runs/finish', operation: 'finish',
      body: { ...original, readReceiptId: 'read' } }), { code: 'instance-proof-input' });
  } finally { session.close(); }
});
