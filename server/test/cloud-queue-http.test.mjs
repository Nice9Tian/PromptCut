import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createAgentHttp } from '../agent-service/http.mjs';
import { createAccountConversationService } from '../agent/service/conversation-policy.mjs';
import { openAccountLedger } from '../account/ledger.mjs';
import { createAccountAuthority } from '../account/authority.mjs';
import { agentReadControlFixture } from './agent-read-control-fixture.mjs';
import { assetWiringPki } from './fixtures/asset-wiring-pki.mjs';

test('account history without a real read transport fails closed before invoking its consumer', async () => {
  let invoked = 0, wire = '', status;
  const client = Object.fromEntries(['identity','access','list','get','send','switchVisibility','stop','rename']
    .map(name => [name, async () => { invoked++; return {}; }]));
  const service = createAccountConversationService({ conversationClient: client });
  const api = createAgentHttp({ service, authenticate: async () => ({ accountMode: true }) });
  const req = new Readable({ read() {} }); req.url = '/v1/conversations/conv/events'; req.method = 'GET'; req.headers = {};
  const res = new Writable({ write(chunk, _encoding, done) { wire += chunk; done(); } });
  res.writeHead = value => { status = value; };
  await api.handle(req, res);
  assert.equal(status, 503); assert.equal(JSON.parse(wire).code, 'read-control-unavailable'); assert.equal(invoked, 0);
  req.destroy(); res.destroy(); service.close();
});

const until = async predicate => {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() >= deadline) throw Error('queue-observation-timeout');
    await new Promise(resolve => setTimeout(resolve, 5)); }
};

// Original queue snapshot/duplicate/plaintext assertions now use a real RAM
// instance, TLS doc RPC, SQLite queue and owned HTTP/SSE transport.
test('real account SSE publishes queue revisions without duplicates and fences a fetched plaintext batch', { timeout: 15000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-cloud-queue-read-'));
  const ledger = openAccountLedger({ file: path.join(dir, 'doc.sqlite'), authorityId: 'queue-doc' });
  const pki = assetWiringPki(dir), projectId = 'sp_' + 'a'.repeat(26), conversationId = 'conversation';
  const a = 'acc_' + 'a'.repeat(24), b = 'acc_' + 'b'.repeat(24), creator = 'acc_' + 'c'.repeat(24);
  const principals = new Map([a, b, creator].map(accountId => [accountId, { identityVersion: 2, realm: 'account', accountId,
    accountName: accountId === a ? 'Alice' : 'Bob', loginId: `login-${accountId}`, credentialId: `cred-${accountId}`,
    loginGeneration: 1, expiresAt: Date.now() + 60000, accountEventSeq: 0 }]));
  ledger.transaction(s => { s.projects[projectId] = { projectId, creatorAccountId: creator, status: 'active', accessRevision: 1,
    hosted: { agent: true }, bans: {}, members: Object.fromEntries([a,b,creator].map(id => [id, { access: 'rw' }])) }; });
  let fixture;
  const authority = createAccountAuthority({ ledger, pollMs: 0, accountClient: {
    async verify(token) { assert.ok(principals.has(token)); return structuredClone(principals.get(token)); },
    async events() { return { events: [], headSeq: 0 }; } },
    runHooks: { fenceInState: (state, fence) => fixture.control.hooks.fenceInState(state, fence) } });
  const trusted = await authority.authorizePrincipal({ accessToken: a }, { projectId, action: 'read' });
  fixture = agentReadControlFixture({ ledger, directory: dir, docTls: pki.doc, agentTls: pki.asset,
    docPin: pki.doc.fingerprint256, agentPin: pki.asset.fingerprint256, port: 6602, accountAuthority: authority,
    resolveDelegation: async value => { assert.equal(value, 'queue-delegation'); return trusted; },
    checkConsent: async ({ accountId }) => ({ accountId, accepted: true, noticeVersion: 1 }),
    verifySelectionSnapshot: async ({ principal }) => ({ projectId, accountId: principal.accountId, source: 'sent-snapshot',
      pageId: 'queue-page', selection: {}, sentAt: 1 }) });
  const identity = { accountMode: true, projectId, accountId: a, userId: a, delegation: 'queue-delegation' };
  const service = createAccountConversationService({ conversationClient: fixture.client });
  const api = createAgentHttp({ service, authenticate: async () => identity });
  const server = http.createServer((req, res) => { void api.handle(req, res); });
  let request, releaseHeld;
  t.after(async () => { releaseHeld?.(); request?.destroy(); await fixture.close();
    if (server.listening) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    service.close(); authority.close(); ledger.close(); fs.rmSync(dir, { recursive: true }); });
  await fixture.start(); await new Promise(resolve => server.listen(6603, '127.0.0.1', resolve));
  const send = (accountId, content, requestId) => fixture.conversations.send({ principalRef: { accessToken: accountId },
    projectId, conversationId, content, requestId });
  const first = await send(a, 'first', 'one'), second = await send(b, 'second', 'two');
  assert.equal((await service.info(identity)).executorMounted, false);
  let wire = '', responseStatus, transportClosed = false;
  const closed = new Promise(resolve => {
    request = http.get('http://127.0.0.1:6603/v1/conversations/conversation/events?after=0', res => {
      responseStatus = res.statusCode; res.on('data', chunk => { wire += chunk; });
      res.on('error', () => {}); res.once('close', () => { transportClosed = true; resolve(); });
    }); request.on('error', () => {});
  });
  const events = () => wire.split('\n\n').slice(0, -1).filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  await until(() => events().some(event => event.type === 'queue.state'));
  assert.equal(responseStatus, 200); assert.equal(events().filter(event => event.type === 'user').length, 2);
  const initial = events().find(event => event.type === 'queue.state'); assert.equal(initial.seq, undefined);
  assert.deepEqual(initial.items.map(item => [item.messageId, item.position]), [[first.messageId, 1], [second.messageId, 2]]);
  await fixture.conversations.switchVisibility({ principalRef: { accessToken: a }, projectId, conversationId,
    visibility: 'private', requestId: 'private' });
  await until(() => events().filter(event => event.type === 'queue.state').length > 1);
  const updated = events().filter(event => event.type === 'queue.state').at(-1);
  assert.ok(updated.queueRevision > initial.queueRevision);
  assert.equal(events().filter(event => event.type === 'user').length, 2);
  assert.equal(ledger.read().conversationsV2[projectId][conversationId].messages[1].queueState, 'cancelled');
  let fetched = false;
  const held = new Promise(resolve => { releaseHeld = resolve; }), get = fixture.client.get;
  fixture.client.get = async input => { const result = await get(input);
    if (result.messages.some(row => row.content === 'must-not-publish')) { fetched = true; await held; }
    return result; };
  await send(a, 'must-not-publish', 'three'); await until(() => fetched);
  const kicked = await authority.adminProject({ accessToken: creator }, { projectId, op: 'kick', accountId: a,
    requestId: 'kick', expectedAccessRevision: 1 });
  await closed;
  assert.equal(transportClosed, true); assert.equal(kicked.completed, false);
  releaseHeld(); await until(() => fixture.control.completion({ projectId }).complete);
  assert.equal(wire.includes('must-not-publish'), false);
  await assert.rejects(fixture.conversations.get({ principalRef: { accessToken: a }, projectId, conversationId }), { code: 'banned' });
});
