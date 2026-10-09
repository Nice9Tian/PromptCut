import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createPublicKey, sign } from 'node:crypto';
import { scopeModel, pair, signed } from './agent-run-scope-fixture.mjs';
import { createDocService } from '../docservice/service.mjs';
import { runFixture, projectId, conversationId, servicePrincipal } from './run-authority-fixture.mjs';
import { canonicalJson, digestOf } from '../account/ledger.mjs';
import { createAgentRunScopeDoc, agentScopeKeyMapping, agentScopeRef } from '../account/agent-run-scope-doc.mjs';
import { createAgentInstanceAuthority, instanceProofPayload, instanceTlsBinding } from '../account/agent-instance-authority.mjs';
import { certificateFingerprint } from '../account/client.mjs';
import { createAgentInstanceInternalHandler, instanceRequestProof } from '../account/agent-instance-internal.mjs';
import { createRunInternalHandler } from '../account/run-internal.mjs';
import { instanceHttpRequest, registerHttpInstance } from './fixtures/agent-instance-request.mjs';
import { assetWiringPki } from './fixtures/asset-wiring-pki.mjs';
import { createRunAuthority, canonicalReadRecord } from '../account/run-authority.mjs';
import { inspectAgentScopeSource } from '../hosted/agent-run-scope-reader.mjs';
import { openOperationHistory } from '../docservice/modules/operation-history.mjs';
import { createPasswordOrder } from '../account/password-order.mjs';

const pem = key => createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' }).export({ format: 'pem', type: 'spki' }).toString();
const signature = (value, key) => sign(null, Buffer.from(canonicalJson(value)), key).toString('base64url');

async function fixture(t, { workerPin = '3'.repeat(64), masterPin = '5'.repeat(64) } = {}) {
  const f = await runFixture(), m = scopeModel(); m.expected.docAuthorityId = f.ledger.authorityId;
  await m.run('initialize');
  const ref = agentScopeRef(m.files.get('epoch-1.json'));
  const slot = { expected: m.expected, configuredAnchorDigest: digestOf(m.files.get('anchor.json')),
    workerServiceKid: servicePrincipal.serviceKid, workerFingerprint256: workerPin };
  // Real SQLite, signatures and complete root-chain validator; OS/transport below
  // are controlled models, NOT kernel/TLS proof or a production source factory.
  const scope = createAgentRunScopeDoc({ ledger: f.ledger, signingKey: m.doc.privateKey, slots: [slot],
    masterServiceKid: 'master-key', masterFingerprint256: masterPin,
    sourceFactory: () => ({ read: ({ checkpoint }) => inspectAgentScopeSource({ read: m.io.read,
      expected: m.expected, configuredAnchorDigest: slot.configuredAnchorDigest, checkpoint }) }) });
  const principal = { ...servicePrincipal, authenticationId: 'test-connection' };
  const transport = (_s, p) => {
    assert.equal(p.authenticationId, principal.authenticationId);
    return { serviceId: 'agent', serviceKid: p.serviceKid, authenticationId: p.authenticationId,
      channelBinding: '4'.repeat(64), fingerprint256: p.serviceKid === 'master-key' ? masterPin : slot.workerFingerprint256 };
  };
  const instances = createAgentInstanceAuthority({ ledger: f.ledger, verifyTransportInState: transport, scopeAuthority: scope });
  const request = { servicePrincipal: principal, requestId: 'register', publicKey: pem(m.workerKey.publicKey), rootScopeRef: ref };
  const challenge = await instances.beginRegistration(request);
  const registration = await instances.register({ servicePrincipal: principal, challenge, signature: signature(challenge, m.workerKey.privateKey) });
  const options = { ledger: f.ledger, conversationHooks: f.hooks, instanceAuthority: instances, scopeAuthority: scope,
    docInstanceId: 'doc-live',
    synchronize: async () => {}, verifySender: async actor => ({ ...actor, accountEventSeq: f.ledger.read().accountHead }),
    verifyServiceInState: (_s, p) => ({ serviceId: p.service, serviceKid: p.serviceKid }) };
  const provider = createRunAuthority(options);
  async function invoke(operation, input) {
    const proof = { instanceId: registration.instanceId, instanceGeneration: registration.instanceGeneration,
      signature: signature(instanceProofPayload({ ...registration, channelBinding: '4'.repeat(64), method: 'POST',
        path: `/test/${operation}`, operation, requestDigest: digestOf(input) }), m.workerKey.privateKey) };
    const cap = instances.authenticate({ servicePrincipal: principal, method: 'POST', path: `/test/${operation}`, operation, request: input, proof });
    try { return await provider[operation]({ ...input, servicePrincipal: { ...principal, ...cap } }); }
    finally { instances.release(cap.instanceSession); }
  }
  t.after(() => { instances.close(); f.close(); fs.rmSync(f.dir, { recursive: true, force: true }); });
  return { ...f, m, ref, scope, instances, request, challenge, registration, options, provider, invoke, principal,
    privateFence: () => f.ledger.transaction(s => f.hooks.privateFenceInState(s, {
      projectId, conversationId, ownerAccountId: 'owner', requestId: 'private', runHooks: provider.hooks })) };
}

test('DER/PEM join proves one key, keeps both digest domains, rejects another key', () => {
  const a = pair(), b = pair(), value = agentScopeKeyMapping(pem(a.publicKey), a.publicKey);
  assert.equal(value.docPublicKeyDigest, digestOf(pem(a.publicKey)));
  assert.equal(value.scopePublicKeyDigest, digestOf(a.publicKey));
  assert.notEqual(value.docPublicKeyDigest, value.scopePublicKeyDigest);
  assert.throws(() => agentScopeKeyMapping(pem(a.publicKey), b.publicKey), { code: 'run-scope-key-mismatch' });
});

test('real mTLS parser separates master/worker, signs full assignment/read requests, and rejects path/body substitution', { timeout: 20000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-worker-doc-tls-')), pki = assetWiringPki(dir);
  const workerPin = certificateFingerprint(pki.asset.fingerprint256), masterPin = certificateFingerprint(pki.account.fingerprint256);
  const f = await fixture(t, { workerPin, masterPin }), sockets = new Map(); let serial = 0;
  const resolveServicePrincipal = ({ socket }) => {
    const pin = certificateFingerprint(socket.getPeerCertificate().fingerprint256);
    if (pin !== workerPin && pin !== masterPin) throw Object.assign(Error('wrong-peer'), { status: 403 });
    const authenticationId = `tls-${++serial}`; sockets.set(authenticationId, socket); socket.once('close', () => sockets.delete(authenticationId));
    return { service: 'agent', serviceKid: pin === masterPin ? 'master-key' : servicePrincipal.serviceKid, authenticationId };
  };
  const instances = createAgentInstanceAuthority({ ledger: f.ledger, scopeAuthority: f.scope,
    verifyTransportInState(_state, p) {
      const socket = sockets.get(p.authenticationId), pin = certificateFingerprint(socket?.getPeerCertificate?.().fingerprint256);
      if (!socket || (p.serviceKid === 'master-key' ? pin !== masterPin : pin !== workerPin)) throw Error('wrong-peer');
      return { serviceId: 'agent', serviceKid: p.serviceKid, authenticationId: p.authenticationId,
        fingerprint256: pin, channelBinding: instanceTlsBinding(socket) };
    } });
  const provider = createRunAuthority({ ...f.options, instanceAuthority: instances });
  const registration = createAgentInstanceInternalHandler({ instanceAuthority: instances, agentFingerprint256: workerPin, masterFingerprint256: masterPin, resolveServicePrincipal });
  const runs = createRunInternalHandler({ runAuthority: provider, agentFingerprint256: workerPin, masterFingerprint256: masterPin,
    requirePendingProof: true, resolveServicePrincipal,
    principalForCheck({ projectId: requestedProject, runGrantId, servicePrincipal }) {
      const grant = f.ledger.read().runGrantsV2[runGrantId];
      assert.equal(grant.projectId, requestedProject);
      // Same trusted-ledger identity construction as the assembly; the actual
      // provider still checks the complete PoP scope and all access gates.
      return { ...grant, realm: 'account', identityVersion: 2, role: 'agent', creator: false, servicePrincipal };
    },
    authenticateInvocation({ req, servicePrincipal, body, operation }) {
      const cap = instances.authenticate({ servicePrincipal, method: req.method, path: req.url, operation, request: body, proof: instanceRequestProof(req) });
      return { servicePrincipal: { ...servicePrincipal, ...cap }, release: () => instances.release(cap.instanceSession) };
    } });
  const server = https.createServer({ ...pki.doc, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3' }, async (req, res) => {
    if (!await registration(req, res) && !await runs(req, res)) { res.writeHead(404); res.end(); }
  });
  const accepted = new Set(); server.on('connection', socket => { accepted.add(socket); socket.once('close', () => accepted.delete(socket)); });
  try {
    server.listen(6712, '127.0.0.1'); await once(server, 'listening');
    const challenge = await instanceHttpRequest({ port: 6712, tls: pki.asset, path: '/internal/v2/instances/challenge',
      body: { requestId: f.request.requestId, publicKey: f.request.publicKey, rootScopeRef: f.ref } });
    assert.equal(challenge.status, 200); assert.deepEqual(challenge.body.result, f.challenge);
    const master = await registerHttpInstance({ port: 6712, tls: pki.account, requestId: 'actual-master' });
    assert.equal(master.purpose, 'control-only');
    const worker = { ...f.registration, privateKey: f.m.workerKey.privateKey };
    const call = (tls, instance, route, operation, body, extra = {}) => instanceHttpRequest({ port: 6712, tls, instance,
      path: `/internal/v2/runs/${route}`, operation, body, ...extra });
    f.enqueue(); const admitBody = { projectId, conversationId, requestId: 'actual-admit' };
    assert.equal((await call(pki.account, master, 'admit', 'admit', admitBody)).status, 403);
    const admitted = await call(pki.asset, worker, 'admit', 'admit', admitBody);
    assert.equal(admitted.status, 200); const grant = admitted.body.result;
    const binding = Object.fromEntries(['projectId', 'conversationId', 'messageId', 'runId', 'runGrantId'].map(k => [k, grant[k]]));
    const body = { ...binding, requestId: 'actual-assignment' };
    assert.equal((await call(pki.asset, worker, 'assignment', 'scopeAssignment', body, { signedPath: '/internal/v2/runs/finish' })).status, 403);
    assert.equal((await call(pki.asset, worker, 'assignment', 'scopeAssignment', body, { signedBody: { ...body, runGrantId: 'other' } })).status, 403);
    const assigned = await call(pki.asset, worker, 'assignment', 'scopeAssignment', body);
    assert.equal(assigned.body.result.executionAllowed, false);
    const prompt = canonicalReadRecord(grant.message, grant), read = { ...binding, requestId: 'actual-read', readIntentId: 'actual-intent', prompt, promptDigest: digestOf(prompt) };
    assert.equal((await call(pki.asset, worker, 'read', 'confirmRead', read)).status, 503);
    await f.m.run('bind', { assignment: assigned.body.result.assignment });
    const readReply = await call(pki.asset, worker, 'read', 'confirmRead', read);
    assert.equal(readReply.status, 200);
    const eventInput = { projectId, runGrantId: grant.runGrantId, assignmentDigest: digestOf(assigned.body.result.assignment) };
    const metadata = await call(pki.account, master, 'worker-event-source', 'workerEventSource', eventInput);
    assert.equal(metadata.status, 200); assert.equal(metadata.body.result.workerFingerprint256, workerPin);
    assert.equal(Object.hasOwn(metadata.body.result.message, 'credentialId'), false);
    assert.equal((await call(pki.asset, worker, 'worker-event-source', 'workerEventSource', eventInput)).status, 403);
    const access = { projectId, runGrantId: grant.runGrantId };
    for (const action of ['read', 'write']) assert.equal((await call(pki.asset, worker, 'check', 'checkAccess', { ...access, action })).status, 200);
    const ticketInput = { ...access, conversationId, purpose: 'run' };
    const beforeTicket = await call(pki.asset, worker, 'ticket', 'resolveRunPrincipal', ticketInput);
    assert.equal(beforeTicket.status, 503); assert.equal(beforeTicket.body.code, 'run-ticket-unavailable');
    // No fake ticket issuer. Before finish the real resolve gate succeeds and
    // reaches missing issuer; after finish it must reject before reaching it.
    const finishInput = { ...binding, requestId: 'actual-finish', readReceiptId: readReply.body.result.receipt.receiptId,
      outcome: { v: 1, status: 'failed', eventId: 'actual-error', eventDigest: '8'.repeat(64) } };
    const finishReply = await call(pki.asset, worker, 'finish', 'finish', finishInput);
    assert.equal(finishReply.status, 200); assert.equal(finishReply.body.result.finishPending, true);
    for (const action of ['read', 'write']) {
      const blocked = await call(pki.asset, worker, 'check', 'checkAccess', { ...access, action });
      assert.equal(blocked.status, 403); assert.equal(blocked.body.code, 'run-revoked');
    }
    const afterTicket = await call(pki.asset, worker, 'ticket', 'resolveRunPrincipal', ticketInput);
    assert.equal(afterTicket.status, 403); assert.equal(afterTicket.body.code, 'run-revoked');
    assert.equal((await call(pki.account, master, 'worker-event-source', 'workerEventSource', eventInput)).status, 403);
    const finishQuery = await call(pki.asset, worker, 'finish/query', 'queryFinish', finishInput);
    assert.equal(finishQuery.status, 200); assert.equal(finishQuery.body.result.finishPending, true);
    const receipt = finishReply.body.result.finishReceipt;
    const prepare = signed(f.scope.preparePayload(f.ledger.read(), f.ledger.read().runGrantsV2[grant.runGrantId], receipt,
      'actual-drain-reference'), f.m.workerKey.privateKey);
    const terminalInput = { ...binding, requestId: 'actual-terminal', finishReceiptId: receipt.finishReceiptId };
    assert.equal((await call(pki.asset, worker, 'scope/prepare', 'scopePrepare', { ...terminalInput, requestId: 'actual-prepare', prepare })).status, 200);
    const pendingTerminal = await call(pki.asset, worker, 'scope/terminal', 'scopeTerminal', terminalInput);
    assert.equal(pendingTerminal.status, 503); assert.equal(pendingTerminal.body.code, 'run-scope-doc-closure-pending');
    f.privateFence();
    assert.equal((await call(pki.account, master, 'worker-event-source', 'workerEventSource', eventInput)).status, 403);
    assert.equal(f.ledger.read().conversationsV2[projectId][conversationId].currentRunId, grant.runId);
    const controlId = f.ledger.read().runGrantsV2[grant.runGrantId].closureControlId;
    const controlInput = { ...eventInput, controlId, rootScopeRef: f.ref };
    assert.equal((await call(pki.account, master, 'scope/control', 'scopeControl', controlInput)).status, 503);
    assert.equal((await call(pki.account, master, 'scope/control', 'scopeControl', { ...controlInput, controlId: 'other' })).status, 403);
    assert.equal((await call(pki.account, master, 'scope/control', 'scopeControl', { ...controlInput, rootScopeRef: { ...f.ref, epoch: 2 } })).status, 403);
    assert.equal((await call(pki.asset, worker, 'scope/control', 'scopeControl', controlInput)).status, 403);
    assert.deepEqual(await provider.reconcileScopeClosures(), []);
    const doc = createDocService({ autoTick: false, log: () => {} });
    const history = openOperationHistory(path.join(f.dir, 'forced-operations.db'));
    history.createProject(projectId, { id: projectId });
    const unavailable = () => { throw Error('fixture-has-no-account-operation'); };
    const operations = createPasswordOrder({ history, account: { get: unavailable }, verifyWitness: unavailable, checkGate: unavailable });
    try {
      // Real Doc inventory and SQLite operation-fence commit, no injected closed
      // row or success callback. This fixture owns zero Doc data connections.
      await f.scope.closeDocControl({ controlId, docInstanceId: 'doc-live', service: doc, operationCoordinator: operations });
      const answer = await call(pki.account, master, 'scope/control', 'scopeControl', controlInput);
      assert.equal(answer.status, 200); assert.equal(answer.body.result.unassigned, false);
      assert.equal(answer.body.result.terminal.fence.controlId, controlId);
      assert.equal((await call(pki.account, master, 'scope/control', 'scopeControl', controlInput,
        { signedBody: { ...controlInput, controlId: 'other' } })).status, 403);
      assert.equal(f.ledger.read().conversationsV2[projectId][conversationId].currentRunId, grant.runId);
      // Explicit controlled root OS model, not a Linux dead-main claim. The
      // independent 9e9854ab Linux proof covers the real pinRetired adapter.
      f.m.io.pinRetired = f.m.io.pinPrevious;
      await f.m.run('forced-close', { terminal: answer.body.result.terminal, intent: null });
      const settled = await provider.reconcileScopeClosures();
      assert.equal(settled.length, 1); assert.equal(settled[0].terminalOutcome.status, 'interrupted');
      assert.equal(f.ledger.read().conversationsV2[projectId][conversationId].currentRunId, null);
      assert.equal((await call(pki.account, master, 'worker-event-source', 'workerEventSource', eventInput)).status, 403);
    } finally { await operations.idle(); history.close(); await doc.close(); }
  } finally {
    const closing = [...accepted].map(socket => new Promise(resolve => { socket.once('close', resolve); socket.destroy(); }));
    await Promise.all(closing); await new Promise(resolve => server.close(resolve));
    instances.close(); fs.rmSync(dir, { recursive: true, force: true });
    t.diagnostic(`actual owned TLS close: sockets=${accepted.size}, listening=${server.listening}, port=6712`);
  }
});

test('SQLite registration pins real root ID/key; assignment stays invisible to read until root bind', async t => {
  const f = await fixture(t);
  assert.equal(f.registration.instanceId, f.m.files.get('epoch-1.json').instance.instanceId);
  assert.equal(f.challenge.publicKeyDigest, f.challenge.docPublicKeyDigest);
  assert.notEqual(f.challenge.publicKeyDigest, f.challenge.scopePublicKeyDigest);
  f.enqueue();
  const grant = await f.invoke('admit', { projectId, conversationId, requestId: 'admit' });
  const binding = Object.fromEntries(['projectId', 'conversationId', 'messageId', 'runId', 'runGrantId'].map(k => [k, grant[k]]));
  const prompt = canonicalReadRecord(grant.message, grant);
  const read = { ...binding, requestId: 'read', readIntentId: 'intent', prompt, promptDigest: digestOf(prompt) };
  const assignment = await f.invoke('scopeAssignment', { ...binding, requestId: 'assignment' });
  assert.equal(assignment.executionAllowed, false);
  assert.equal(assignment.assignment.target.publicKeyDigest, f.challenge.scopePublicKeyDigest);
  await assert.rejects(f.invoke('confirmRead', read), { code: 'run-scope-assignment-not-bound' });
  assert.equal(Object.keys(f.ledger.read().runReceiptsV2).length, 0);
  await f.m.run('bind', { assignment: assignment.assignment });
  assert.equal((await f.invoke('scopeAssignment', { ...binding, requestId: 'assignment' })).executionAllowed, true);
  assert.equal((await f.invoke('confirmRead', read)).confirmed, true);
  assert.deepEqual(await f.instances.beginRegistration(f.request), f.challenge);
  await assert.rejects(f.invoke('finish', { ...binding, requestId: 'finish' }), { code: 'run-finish-invalid' });
  assert.equal(f.ledger.read().conversationsV2[projectId][conversationId].currentRunId, grant.runId);
  f.m.files.set('.publisher.lock', { pid: 1 });
  await assert.rejects(f.invoke('queryRead', read), { code: 'agent-scope-publisher-locked' });
});

test('normal prepare before death plus actual Doc fence and root closed projection releases exact FIFO; missing proof stays pending', async t => {
  const f = await fixture(t); f.enqueue(); f.enqueue('message2');
  const grant = await f.invoke('admit', { projectId, conversationId, requestId: 'admit' });
  const binding = Object.fromEntries(['projectId', 'conversationId', 'messageId', 'runId', 'runGrantId'].map(k => [k, grant[k]]));
  const assignment = (await f.invoke('scopeAssignment', { ...binding, requestId: 'assignment' })).assignment;
  await f.m.run('bind', { assignment });
  const prompt = canonicalReadRecord(grant.message, grant);
  const read = await f.invoke('confirmRead', { ...binding, requestId: 'read', readIntentId: 'intent', prompt, promptDigest: digestOf(prompt) });
  const finishInput = { ...binding, requestId: 'finish', readReceiptId: read.receipt.receiptId,
    outcome: { v: 1, status: 'failed', eventId: 'actual-error-event', eventDigest: '8'.repeat(64) } };
  const finish = await f.invoke('finish', finishInput), receipt = finish.finishReceipt;
  assert.equal(finish.finishPending, true);
  assert.deepEqual(await f.provider.reconcileScopeClosures(), []);
  await assert.rejects(f.invoke('finish', { ...finishInput, outcome: { ...finishInput.outcome, status: 'done' } }), { code: 'run-request-mismatch' });
  const input = { ...binding, requestId: 'terminal', finishReceiptId: receipt.finishReceiptId };
  await assert.rejects(f.invoke('scopeTerminal', input), { code: 'run-scope-prepare-pending' });
  const payload = f.scope.preparePayload(f.ledger.read(), f.ledger.read().runGrantsV2[grant.runGrantId], receipt, 'actual-local-drain');
  const prepare = signed(payload, f.m.workerKey.privateKey);
  await f.invoke('scopePrepare', { ...input, requestId: 'prepare', prepare });
  await assert.rejects(f.invoke('scopeTerminal', input), { code: 'run-scope-doc-closure-pending' });
  const service = createDocService({ autoTick: false, log: () => {} });
  t.after(() => service.close());
  // Actual product inventory/fence, with no connections/listener in this pure
  // test. No fabricated doc closure row or callback returning true.
  await f.scope.closeDocTerminal({ controlId: receipt.controlId, docInstanceId: 'doc-live', service });
  const { terminal } = await f.invoke('scopeTerminal', input);
  assert.equal(terminal.finish.terminalReceiptDigest, digestOf(prepare));
  const intent = signed({ v: 1, protocol: 'promptcut.agent-run-scope.intent.v1', assignmentDigest: digestOf(assignment),
    terminalDigest: digestOf(terminal) }, f.m.workerKey.privateKey);
  assert.equal(f.ledger.read().conversationsV2[projectId][conversationId].currentRunId, grant.runId);
  await f.m.run('close', { terminal, intent });
  const results = await f.provider.reconcileScopeClosures();
  assert.equal(results.length, 1); assert.equal(results[0].finishPending, false);
  assert.equal(results[0].terminalOutcome.status, 'failed');
  const conversation = f.ledger.read().conversationsV2[projectId][conversationId];
  assert.equal(conversation.currentRunId, null); assert.equal(conversation.messages[1].queueState, 'queued');
  assert.equal(conversation.messages[0].terminalOutcome.status, 'failed');
  assert.equal((await f.invoke('queryFinish', finishInput)).finishPending, false);
});

test('required mode persists and cannot reopen without scope module; wrong key/extra ref rejected', async t => {
  const f = await fixture(t);
  await assert.rejects(f.instances.beginRegistration({ ...f.request, requestId: 'wrong-key', publicKey: pem(pair().publicKey) }), { code: 'run-scope-key-mismatch' });
  await assert.rejects(f.instances.beginRegistration({ ...f.request, rootScopeRef: { ...f.ref, free: true } }), { code: 'run-scope-reference' });
  const missing = createAgentInstanceAuthority({ ledger: f.ledger, verifyTransportInState: () => ({
    serviceId: 'agent', serviceKid: servicePrincipal.serviceKid, authenticationId: 'x', channelBinding: '4'.repeat(64) }) });
  assert.throws(() => missing.beginRegistration({ ...f.request, rootScopeRef: undefined }), { code: 'instance-scope-unavailable' });
  missing.close();
});

test('every scoped revoke holds its original FIFO until root closure; shared read credential/member exception remains retained', async t => {
  for (const kind of ['credential', 'member', 'private', 'stop', 'delete', 'agent-disabled']) {
    for (const readConfirmed of [false, true]) {
      const f = await fixture(t); f.enqueue(); f.enqueue('message2');
      const grant = await f.invoke('admit', { projectId, conversationId, requestId: `admit-${kind}` });
      const binding = Object.fromEntries(['projectId', 'conversationId', 'messageId', 'runId', 'runGrantId'].map(k => [k, grant[k]]));
      if (readConfirmed) {
        const assignment = (await f.invoke('scopeAssignment', { ...binding, requestId: 'assignment' })).assignment;
        await f.m.run('bind', { assignment });
        const prompt = canonicalReadRecord(grant.message, grant);
        await f.invoke('confirmRead', { ...binding, requestId: 'read', readIntentId: 'intent', prompt, promptDigest: digestOf(prompt) });
      }
      if (kind === 'private') f.privateFence();
      else f.provider.fence({ kind, projectId, conversationId, requestId: `fence-${kind}`, ...(kind === 'stop' ? { runId: grant.runId } : {}) });
      const state = f.ledger.read(), retained = readConfirmed && ['credential', 'member'].includes(kind);
      assert.equal(state.runGrantsV2[grant.runGrantId].state, retained ? 'retained' : 'revoked', `${kind}/${readConfirmed}`);
      assert.equal(state.conversationsV2[projectId][conversationId].currentRunId, grant.runId);
      assert.deepEqual(await f.provider.reconcileScopeClosures(), []);
      if (!retained) await assert.rejects(f.invoke('scopeAssignment', { ...binding, requestId: 'after-fence' }), { code: 'run-revoked' });
      // This production fence is trusted internal input, not a master RPC that
      // can invent worker-failed evidence or mint a new forced certificate.
    }
  }
});

test('separate trusted master certificate registers control-only and cannot sign itself run access', async t => {
  const f = await fixture(t), masterKey = pair(), principal = { ...f.principal, serviceKid: 'master-key' };
  const request = { servicePrincipal: principal, requestId: 'master', publicKey: pem(masterKey.publicKey) };
  const challenge = await f.instances.beginRegistration(request);
  assert.equal(challenge.purpose, 'control-only');
  assert.equal(Object.hasOwn(challenge, 'rootScopeRef'), false);
  const registration = await f.instances.register({ servicePrincipal: principal, challenge, signature: signature(challenge, masterKey.privateKey) });
  assert.equal(registration.purpose, 'control-only');
  await assert.rejects(f.instances.beginRegistration({ ...request, requestId: 'master-forged-worker', rootScopeRef: f.ref }), { code: 'run-scope-master-scope-forbidden' });
  await assert.rejects(f.instances.beginRegistration({ ...f.request, requestId: 'worker-without-ref', rootScopeRef: undefined }), { code: 'run-scope-reference' });
  for (const operation of ['admit', 'confirmRead', 'scopeAssignment', 'checkAccess', 'resolveRunPrincipal', 'finish']) {
    const input = {}, proof = { ...registration, signature: signature(instanceProofPayload({ ...registration,
      channelBinding: '4'.repeat(64), method: 'POST', path: `/test/${operation}`, operation, requestDigest: digestOf(input) }), masterKey.privateKey) };
    assert.throws(() => f.instances.authenticate({ servicePrincipal: principal, method: 'POST', path: `/test/${operation}`, operation, request: input, proof }),
      { code: 'instance-purpose-forbidden' });
  }
  const operation = 'pendingRuns', requestBody = {}, proof = { ...registration, signature: signature(instanceProofPayload({ ...registration,
    channelBinding: '4'.repeat(64), method: 'POST', path: '/internal/v2/runs/pending', operation, requestDigest: digestOf(requestBody) }), masterKey.privateKey) };
  const cap = f.instances.authenticate({ servicePrincipal: principal, method: 'POST', path: '/internal/v2/runs/pending', operation, request: requestBody, proof });
  assert.equal(f.instances.verifyInState(f.ledger.read(), { ...principal, ...cap }, { operation, input: requestBody }).instanceId, registration.instanceId);
  f.instances.release(cap.instanceSession);
});
