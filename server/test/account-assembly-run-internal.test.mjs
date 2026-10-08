import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { createRunInternalServer } from '../account/run-internal.mjs';
import { assetWiringPki } from './fixtures/asset-wiring-pki.mjs';

const closeServer = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
function call(tls, route, body, method = 'POST') {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(JSON.stringify(body));
    const req = https.request({ host: '127.0.0.1', port: 5772, path: '/internal/v2/runs/' + route,
      method, key: tls.key, cert: tls.cert, ca: tls.ca, minVersion: 'TLSv1.3', agent: false,
      headers: { 'content-type': 'application/json', 'content-length': encoded.length } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      res.on('error', reject);
    }); req.on('error', reject); req.end(encoded);
  });
}

test('run internal routes pin Agent cert, inject trusted service only, bind grants and keep pending metadata narrow', { timeout: 15000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-run-internal-')); let server;
  t.after(async () => { if (server?.listening) await closeServer(server); fs.rmSync(dir, { recursive: true, force: true }); });
  const pki = assetWiringPki(dir), calls = [];
  const servicePrincipal = { service: 'agent', serviceKid: 'fixture-kid', scope: 'service', authentication: 'pinned-mtls' };
  const binding = { projectId: 'project-a', conversationId: 'conversation-a', messageId: 'message-a', runId: 'run-a', runGrantId: 'grant-a' };
  let live = true, leakedMetadata = false;
  const authority = Object.fromEntries(['admit', 'confirmRead', 'queryRead', 'finish'].map(method => [method, async input => {
    assert.equal(input.servicePrincipal, servicePrincipal); calls.push({ method, input }); return { method };
  }]));
  authority.resolveRunPrincipal = async input => {
    assert.equal(input.servicePrincipal, servicePrincipal); assert.equal(input.runGrantId, binding.runGrantId);
    return { ...binding, realm: 'account', identityVersion: 2, role: 'agent', creator: false,
      serviceId: 'agent', serviceKid: servicePrincipal.serviceKid, servicePrincipal };
  };
  authority.checkAccess = async input => {
    assert.equal(input.principal.servicePrincipal, servicePrincipal); calls.push({ method: 'checkAccess', input });
    return { allowed: live, runGrant: { ...binding, fenceRevision: 7 } };
  };
  server = createRunInternalServer({ tls: pki.doc, agentFingerprint256: pki.asset.fingerprint256,
    runAuthority: authority, resolveServicePrincipal: async ({ fingerprint256 }) => {
      assert.equal(fingerprint256, pki.asset.fingerprint256.replaceAll(':', '').toLowerCase()); return servicePrincipal;
    }, issueRunTicket: async input => {
      assert.equal(input.principal.creator, false); assert.equal(input.servicePrincipal, servicePrincipal);
      return { connectionTicket: 'fixture-opaque-kind-run', expiresAt: 1_900_000_000_000 };
    }, listPendingRuns: async () => ({ conversations: [{ projectId: 'project-a', conversationId: 'conversation-a', queueRevision: 7,
      ...(leakedMetadata ? { message: 'must-not-leak' } : {}) }] }) });
  await new Promise(resolve => server.listen(5772, '127.0.0.1', resolve));
  const admit = { projectId: binding.projectId, conversationId: binding.conversationId, requestId: 'admit-a' };
  assert.equal((await call(pki.wrong, 'admit', admit)).status, 403); assert.equal(calls.length, 0);
  assert.equal((await call(pki.asset, 'admit', { ...admit, accountId: 'forged' })).status, 400);
  assert.equal((await call(pki.asset, 'admit', { ...admit, servicePrincipal })).status, 400);
  assert.equal((await call(pki.asset, 'admit', admit)).status, 200); assert.equal(calls.at(-1).method, 'admit');
  const read = { ...binding, requestId: 'read-a', readIntentId: 'intent-a', promptDigest: 'a'.repeat(64), prompt: { complete: 'fixture' } };
  assert.equal((await call(pki.asset, 'read', read)).status, 200);
  assert.equal((await call(pki.asset, 'read/query', read)).status, 200);
  assert.equal((await call(pki.asset, 'read', { ...read, prompt: undefined })).status, 400);
  assert.equal((await call(pki.asset, 'finish', { ...binding, requestId: 'finish-a' })).status, 200);
  assert.equal((await call(pki.asset, 'finish', { ...binding, requestId: 'finish-a', actor: {} })).status, 400);
  const checked = await call(pki.asset, 'check', { projectId: binding.projectId, runGrantId: binding.runGrantId, action: 'write' });
  assert.equal(checked.status, 200); assert.equal(checked.body.result.principal.creator, false);
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
});
