import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRunInternalServer } from '../account/run-internal.mjs';
import { openAccountLedger } from '../account/ledger.mjs';
import { createAgentInstanceAuthority, instanceTlsBinding } from '../account/agent-instance-authority.mjs';
import { createAgentInstanceInternalHandler, instanceRequestProof } from '../account/agent-instance-internal.mjs';
import { instanceHttpRequest, registerHttpInstance } from './fixtures/agent-instance-request.mjs';
import { assetWiringPki } from './fixtures/asset-wiring-pki.mjs';

const closeServer = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });

test('run internal routes pin Agent cert, inject trusted service only, bind grants and keep pending metadata narrow', { timeout: 15000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-run-internal-')); let server, port, instances;
  const ledger = openAccountLedger({ file: path.join(dir, 'doc.sqlite'), authorityId: 'actual-instance-fixture' });
  t.after(async () => { if (server?.listening) await closeServer(server); instances?.close(); ledger.close(); t.diagnostic(`owned run route port=${port ?? 'not-opened'} listening=${server?.listening === true}`); fs.rmSync(dir, { recursive: true, force: true }); });
  const pki = assetWiringPki(dir), calls = [];
  const sockets = new Map(), identities = new WeakMap(); let released = 0;
  const resolveServicePrincipal = ({ socket }) => {
    let id = identities.get(socket);
    if (!id) { id = randomUUID(); identities.set(socket, id); sockets.set(id, socket); socket.once('close', () => sockets.delete(id)); }
    return { service: 'agent', serviceKid: 'fixture-kid', authenticationId: id };
  };
  instances = createAgentInstanceAuthority({ ledger, verifyTransportInState(_state, principal) {
    const socket = sockets.get(principal.authenticationId);
    return { serviceId: 'agent', serviceKid: principal.serviceKid, authenticationId: principal.authenticationId,
      channelBinding: instanceTlsBinding(socket) };
  } });
  const binding = { projectId: 'project-a', conversationId: 'conversation-a', messageId: 'message-a', runId: 'run-a', runGrantId: 'grant-a' };
  let live = true, leakedMetadata = false;
  const authority = Object.fromEntries(['admit', 'confirmRead', 'queryRead', 'finish'].map(method => [method, async input => {
    instances.verifyInState(ledger.read(), input.servicePrincipal, { operation: method, input }); calls.push({ method, input }); return { method };
  }]));
  authority.resolveRunPrincipal = async input => {
    instances.verifyInState(ledger.read(), input.servicePrincipal, { operation: 'resolveRunPrincipal', input });
    if (!live) throw Object.assign(Error('run-revoked'), { status: 403, code: 'run-revoked' });
    assert.equal(input.runGrantId, binding.runGrantId);
    return { ...binding, realm: 'account', identityVersion: 2, role: 'agent', creator: false,
      serviceId: 'agent', serviceKid: input.servicePrincipal.serviceKid, servicePrincipal: input.servicePrincipal };
  };
  authority.checkAccess = async input => {
    instances.verifyInState(ledger.read(), input.principal.servicePrincipal, { operation: 'checkAccess', input });
    calls.push({ method: 'checkAccess', input });
    return { allowed: live, runGrant: { ...binding, fenceRevision: 7 } };
  };
  server = createRunInternalServer({ tls: pki.doc, agentFingerprint256: pki.asset.fingerprint256,
    runAuthority: authority, resolveServicePrincipal,
    authenticateInvocation({ req, servicePrincipal, body, operation }) {
      const cap = instances.authenticate({ servicePrincipal, method: req.method, path: req.url,
        operation, request: body, proof: instanceRequestProof(req) });
      return { servicePrincipal: { ...servicePrincipal, ...cap }, release: () => { released++; instances.release(cap.instanceSession); } };
    }, principalForCheck: async input => ({ ...binding, realm: 'account', identityVersion: 2, role: 'agent', creator: false,
      serviceId: 'agent', serviceKid: input.servicePrincipal.serviceKid, servicePrincipal: input.servicePrincipal,
      instanceSession: 'must-not-be-serialized' }), issueRunTicket: async input => {
      assert.equal(input.principal.creator, false); assert.equal(input.principal.servicePrincipal, input.servicePrincipal);
      return { connectionTicket: 'fixture-opaque-kind-run', expiresAt: 1_900_000_000_000 };
    }, listPendingRuns: async () => ({ conversations: [{ projectId: 'project-a', conversationId: 'conversation-a', queueRevision: 7,
      ...(leakedMetadata ? { message: 'must-not-leak' } : {}) }] }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); port = server.address().port;
  const runsListener = server.listeners('request')[0]; server.removeAllListeners('request');
  const registerHandler = createAgentInstanceInternalHandler({ instanceAuthority: instances,
    agentFingerprint256: pki.asset.fingerprint256, resolveServicePrincipal });
  server.on('request', async (req, res) => { if (!await registerHandler(req, res)) await runsListener(req, res); });
  const instance = await registerHttpInstance({ port, tls: pki.asset, requestId: 'fixture-os' });
  const operations = { admit: 'admit', read: 'confirmRead', 'read/query': 'queryRead', finish: 'finish', check: 'checkAccess', ticket: 'resolveRunPrincipal' };
  const call = (tls, route, body, method = 'POST', extra = {}) => instanceHttpRequest({ port, tls,
    path: '/internal/v2/runs/' + route, body, method, instance: route === 'pending' ? undefined : instance,
    operation: operations[route], ...extra });
  const admit = { projectId: binding.projectId, conversationId: binding.conversationId, requestId: 'admit-a' };
  assert.equal((await call(pki.wrong, 'admit', admit)).status, 403); assert.equal(calls.length, 0);
  assert.equal((await call(pki.asset, 'admit', { ...admit, accountId: 'forged' })).status, 400);
  assert.equal((await call(pki.asset, 'admit', { ...admit, servicePrincipal: { service: 'agent' } })).status, 400);
  assert.equal((await call(pki.asset, 'admit', admit, 'POST', { instance: undefined })).status, 403);
  assert.equal((await call(pki.asset, 'admit', admit, 'POST', { signedBody: { ...admit, requestId: 'changed' } })).status, 403);
  assert.equal((await call(pki.asset, 'admit', admit, 'POST', { signedPath: '/internal/v2/runs/finish' })).status, 403);
  assert.equal((await call(pki.asset, 'admit', admit, 'POST', { headers: { 'x-forwarded-for': '127.0.0.1' } })).status, 403);
  assert.equal((await call(pki.asset, 'admit', admit)).status, 200); assert.equal(calls.at(-1).method, 'admit');
  const read = { ...binding, requestId: 'read-a', readIntentId: 'intent-a', promptDigest: 'a'.repeat(64), prompt: { complete: 'fixture' } };
  assert.equal((await call(pki.asset, 'read', read)).status, 200);
  assert.equal((await call(pki.asset, 'read/query', read)).status, 200);
  assert.equal((await call(pki.asset, 'read', { ...read, prompt: undefined })).status, 400);
  assert.equal((await call(pki.asset, 'finish', { ...binding, requestId: 'finish-a' })).status, 200);
  assert.equal((await call(pki.asset, 'finish', { ...binding, requestId: 'finish-a', actor: {} })).status, 400);
  const checked = await call(pki.asset, 'check', { projectId: binding.projectId, runGrantId: binding.runGrantId, action: 'write' });
  assert.equal(checked.status, 200); assert.equal(checked.body.result.principal.creator, false);
  assert.equal(JSON.stringify(checked.body).includes('instanceSession'), false);
  assert.equal(JSON.stringify(checked.body).includes('authenticationId'), false);
  assert.equal(calls.at(-1).input.action, 'write');
  const ticket = { projectId: binding.projectId, runGrantId: binding.runGrantId, conversationId: binding.conversationId, purpose: 'run' };
  assert.equal((await call(pki.asset, 'ticket', { ...ticket, conversationId: 'wrong-conversation' })).status, 403);
  assert.equal((await call(pki.asset, 'ticket', { ...ticket, purpose: 'delegate' })).status, 400);
  assert.equal((await call(pki.asset, 'ticket', ticket)).body.result.connectionTicket, 'fixture-opaque-kind-run');
  live = false; assert.equal((await call(pki.asset, 'ticket', ticket)).status, 403); live = true;
  assert.deepEqual((await call(pki.asset, 'pending', {})).body.result,
    { conversations: [{ projectId: 'project-a', conversationId: 'conversation-a', queueRevision: 7 }] });
  leakedMetadata = true; assert.equal((await call(pki.asset, 'pending', {})).status, 503);
  assert.equal((await call(pki.asset, 'pending', { serviceId: 'agent' })).status, 400);
  assert.equal((await call(pki.asset, 'check', {}, 'GET')).status, 405);
  assert.equal((await call(pki.asset, 'unknown', {})).status, 404);
  assert.ok(released >= 8, 'all successful and failed authenticated dispatches release their RAM invocation');
});
