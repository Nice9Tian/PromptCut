import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { openAccountLedger } from '../account/ledger.mjs';
import { createAccountAuthority } from '../account/authority.mjs';
import { createConversationAuthority, conversationReadInState } from '../account/conversation-authority.mjs';
import { createConversationInternalHandler } from '../account/conversation-internal.mjs';
import { createAgentReadControl, createAgentReadControlHandler } from '../account/agent-read-control.mjs';
import { createAgentInstanceAuthority, instanceTlsBinding } from '../account/agent-instance-authority.mjs';
import { createAgentInstanceInternalHandler } from '../account/agent-instance-internal.mjs';
import { createRunClient } from '../agent-service/run-client.mjs';
import { createConversationControlClient } from '../agent-service/conversation-control-client.mjs';
import { certificateFingerprint } from '../account/client.mjs';
import { createConversationClient } from '../agent-service/conversation-client.mjs';
import { createAccountConversationService } from '../agent/service/conversation-policy.mjs';
import { createAgentHttp } from '../agent-service/http.mjs';
import { assetWiringPki } from './fixtures/asset-wiring-pki.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const listen = (server, port) => new Promise((resolve, reject) => {
  server.once('error', reject); server.listen(port, '127.0.0.1', resolve);
});
const close = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); });

// Original first-red at 3fa5fcd8 used the old HTTP path. This regression keeps
// that exact old-RPC-result boundary, with actual instance/control TLS connected.
// The account credential issuer alone is controlled; access.allowed is doc ACL.
test('Agent history cannot send an old real access RPC result after a private fence', { timeout: 15000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-agent-read-race-'));
  const ledger = openAccountLedger({ file: path.join(dir, 'doc.sqlite'), authorityId: 'read-race-doc' });
  const pki = assetWiringPki(dir), projectId = 'sp_' + 'a'.repeat(26), conversationId = 'read_race';
  const owner = 'acc_' + 'a'.repeat(24), member = 'acc_' + 'b'.repeat(24);
  const principals = new Map([owner, member].map(accountId => [accountId, {
    identityVersion: 2, realm: 'account', accountId, accountName: accountId === owner ? 'Owner' : 'Member',
    loginId: `login-${accountId}`, credentialId: `cred-${accountId}`, loginGeneration: 1,
    expiresAt: Date.now() + 60000, accountEventSeq: 0,
  }]));
  const account = createAccountAuthority({ ledger, pollMs: 0, accountClient: {
    async verify(token) { const p = principals.get(token); assert.ok(p); return structuredClone(p); },
    async events() { return { events: [], headSeq: 0 }; },
  } });
  ledger.transaction(s => { s.projects[projectId] = { projectId, creatorAccountId: owner, status: 'active',
    hosted: { agent: true }, bans: {}, members: { [owner]: { access: 'rw' }, [member]: { access: 'rw' } }, accessRevision: 1 }; });
  const trusted = await account.authorizePrincipal({ accessToken: member }, { projectId, action: 'read' });
  const subjects = new Map(), sockets = new WeakMap();
  const resolveServicePrincipal = ({ socket }) => {
    assert.equal(socket.authorized, true);
    assert.equal(certificateFingerprint(socket.getPeerCertificate().fingerprint256), certificateFingerprint(pki.asset.fingerprint256));
    if (!sockets.has(socket)) { const id = randomUUID(); sockets.set(socket, id); subjects.set(id, socket);
      socket.once('close', () => subjects.delete(id)); }
    return { service: 'agent', serviceKid: 'real-test-agent-key', authenticationId: sockets.get(socket) };
  };
  const instances = createAgentInstanceAuthority({ ledger, verifyTransportInState(_state, principal) {
    const socket = subjects.get(principal.authenticationId);
    assert.ok(socket && !socket.destroyed);
    return { serviceId: 'agent', serviceKid: 'real-test-agent-key', authenticationId: principal.authenticationId,
      channelBinding: instanceTlsBinding(socket) };
  } });
  const readControl = createAgentReadControl({ ledger, instanceAuthority: instances,
    authorizeRead: async body => { assert.equal(body.delegation, 'temporary-delegation');
      return account.authorizePrincipal({ authorizationId: trusted.authorizationId }, { projectId, action: 'read' }); },
    checkReadInState: conversationReadInState });
  const fenced = deferred();
  const conversations = createConversationAuthority({ ledger, accountAuthority: account,
    checkConsent: async ({ accountId }) => ({ accountId, accepted: true, noticeVersion: 1 }),
    verifySelectionSnapshot: async ({ principal }) => ({ projectId, accountId: principal.accountId,
      pageId: 'page_race', selection: {}, source: 'sent-snapshot', sentAt: 1 }),
    runHooks: { fenceInState(state, input) { const result = readControl.hooks.fenceInState(state, input);
      queueMicrotask(() => fenced.resolve()); return result; } },
    onFence: async input => { await readControl.waitCompletion(input); return { ack: true, ...input }; },
  });
  await conversations.send({ principalRef: { accessToken: owner }, projectId, conversationId,
    requestId: 'message1', content: 'PRIVATE_RACE_SENTINEL' });
  const conversationsHandler = createConversationInternalHandler({ conversationAuthority: conversations, requireReadControl: true,
    agentFingerprint256: pki.asset.fingerprint256,
    resolveDelegation: async value => { assert.equal(value, 'temporary-delegation'); return trusted; } });
  const instancesHandler = createAgentInstanceInternalHandler({ instanceAuthority: instances,
    agentFingerprint256: pki.asset.fingerprint256, resolveServicePrincipal });
  const controlsHandler = createAgentReadControlHandler({ control: readControl, instanceAuthority: instances, resolveServicePrincipal });
  const doc = https.createServer({ ...pki.doc, requestCert: true, rejectUnauthorized: true }, async (req, res) => {
    if (!await instancesHandler(req, res) && !await controlsHandler(req, res) && !await conversationsHandler(req, res)) {
      res.writeHead(404); res.end(); }
  });
  const options = { origin: 'https://127.0.0.1:6600', tls: pki.asset, serverFingerprint256: pki.doc.fingerprint256 };
  const client = createConversationClient(options), runClient = createRunClient(options);
  const controlClient = createConversationControlClient({ ...options, runClient, receiptFile: path.join(dir, 'agent-read.sqlite') });
  client.useReadControl(controlClient);
  const checked = deferred(), release = deferred(); let held = false, actualAllowed = null;
  const originalAccess = client.access;
  client.access = async input => {
    const result = await originalAccess(input);
    if (!held) { held = true; actualAllowed = result.allowed; checked.resolve(); await release.promise; }
    return result;
  };
  const service = createAccountConversationService({ conversationClient: client });
  const api = createAgentHttp({ service, authenticate: async () => ({ accountMode: true, projectId,
    userId: member, accountId: member, delegation: 'temporary-delegation' }) });
  const agent = http.createServer((req, res) => { void api.handle(req, res); });
  let request;
  t.after(async () => { release.resolve(); request?.destroy(); await controlClient.close(); client.close(); runClient.close();
    readControl.close(); await close(agent); await close(doc); instances.close();
    account.close(); ledger.close(); fs.rmSync(dir, { recursive: true }); });
  await listen(doc, 6600); await listen(agent, 6601);
  await controlClient.start();
  const deadline = Date.now() + 5000;
  while (!controlClient.describe().connected) { if (Date.now() > deadline) throw new Error('control-not-ready');
    await new Promise(resolve => setTimeout(resolve, 5)); }
  const body = new Promise((resolve, reject) => {
    request = http.get(`http://127.0.0.1:6601/v1/conversations/${conversationId}/events`, res => {
      const chunks = []; res.on('data', bytes => chunks.push(bytes));
      res.once('close', () => resolve(Buffer.concat(chunks).toString('utf8'))); res.on('error', () => {});
    }); request.once('error', reject);
  });
  await checked.promise;
  let complete = false;
  const switching = conversations.switchVisibility({ principalRef: { accessToken: owner }, projectId, conversationId,
    visibility: 'private', requestId: 'private1' }).then(result => { complete = true; return result; });
  await fenced.promise;
  assert.equal(ledger.read().conversationsV2[projectId][conversationId].visibility, 'private');
  assert.equal(actualAllowed, true);
  const received = await body;
  assert.equal(complete, false, 'actual socket close alone cannot skip an unresolved dispatch');
  release.resolve();
  assert.equal((await switching).visibility, 'private');
  t.diagnostic(JSON.stringify({ actualDocRpc: true, realSqlitePrivate: true, actualAllowed,
    leakedSentinel: received.includes('PRIVATE_RACE_SENTINEL'), complete, actualCloseBeforeAck: true, executorMounted: false }));
  assert.equal(received.includes('PRIVATE_RACE_SENTINEL'), false, 'old lawful RPC result must not escape after the fence');
});
