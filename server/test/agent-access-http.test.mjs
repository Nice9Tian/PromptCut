import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { openAccountLedger } from '../account/ledger.mjs';
import { agentReadControlFixture } from './agent-read-control-fixture.mjs';
import { createConversationClient } from '../agent-service/conversation-client.mjs';
import { createHostedAgentService } from '../agent/service/create-agent-service.mjs';
import { createHostedWiring } from '../agent-service/hosted-wiring.mjs';
import { createAgentHttp } from '../agent-service/http.mjs';

const pid = 'sp_' + 'a'.repeat(26), a = 'acc_' + 'a'.repeat(24), b = 'acc_' + 'b'.repeat(24), c = 'acc_' + 'c'.repeat(24);
const listen = (server, port) => new Promise((resolve, reject) => {
  server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
});
const close = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); });
function certs(dir) {
  const openssl = process.env.OPENSSL ?? (process.platform === 'win32' ? path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git/usr/bin/openssl.exe') : 'openssl');
  const run = args => { const r = spawnSync(openssl, args, { cwd: dir, windowsHide: true, stdio: 'ignore', timeout: 30000 }); assert.equal(r.status, 0); };
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=Agent v2 test CA', '-keyout', 'ca.key', '-out', 'ca.crt']);
  fs.writeFileSync(path.join(dir, 'ext.txt'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth,clientAuth\n');
  const ca = fs.readFileSync(path.join(dir, 'ca.crt'));
  const leaf = name => {
    run(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${name}`, '-keyout', `${name}.key`, '-out', `${name}.csr`]);
    run(['x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '1', '-extfile', 'ext.txt', '-out', `${name}.crt`]);
    return { key: fs.readFileSync(path.join(dir, `${name}.key`)), cert: fs.readFileSync(path.join(dir, `${name}.crt`)), ca,
      pin: new X509Certificate(fs.readFileSync(path.join(dir, `${name}.crt`))).fingerprint256 };
  };
  return { doc: leaf('doc'), agent: leaf('agent'), wrong: leaf('wrong') };
}
async function request(port, delegation, method, route, body) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { authorization: `Bearer ${delegation}`,
    ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}
async function readUntil(reader, pattern, ms = 3000) {
  const decoder = new TextDecoder(); let text = '';
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    let timer;
    const next = await Promise.race([reader.read(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('SSE timeout')), remaining); })])
      .finally(() => clearTimeout(timer));
    if (next.done) return text;
    text += decoder.decode(next.value);
    if (pattern.test(text)) return text;
  }
  throw new Error('SSE timeout');
}

test('real mTLS doc + HTTP Agent: two accounts, private fence, consent, ACK replay, revocation', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-agent-http-'));
  const cert = certs(dir);
  const ledger = openAccountLedger({ file: path.join(dir, 'state.sqlite'), authorityId: 'agent-http-fixture' });
  ledger.transaction(state => { state.projects[pid] = { status: 'active', creatorAccountId: c,
    members: { [a]: { access: 'rw' }, [b]: { access: 'rw' }, [c]: { access: 'rw' } }, bans: {}, hosted: { agent: true } }; });
  let consent = true;
  const principals = Object.fromEntries([a, b, c].map(id => [`auth:${id}`, { authorizationId: `auth:${id}`, projectId: pid,
    accountId: id, accountName: id === a ? 'Alice' : id === b ? 'Bob' : 'Creator', loginId: `login:${id}`,
    credentialId: `cred:${id}`, loginGeneration: 1 }]));
  const fixture = agentReadControlFixture({ ledger, directory: dir, docTls: cert.doc, agentTls: cert.agent,
    docPin: cert.doc.pin, agentPin: cert.agent.pin, port: 5790,
    accountAuthority: { async authorizePrincipal(ref, { projectId, action }) {
    const p = principals[ref.authorizationId];
    if (!p || p.projectId !== projectId || ledger.read().revokedLogins[`login:${p.loginId}`]) throw Object.assign(new Error('revoked'), { status: 401, code: 'credential-revoked' });
    const access = ledger.read().projects[pid].members[p.accountId]?.access;
    if (action === 'write' && access !== 'rw') throw Object.assign(new Error('readonly'), { status: 403, code: 'not-listed' });
    return p;
  } }, checkConsent: async ({ accountId }) => ({ accountId, accepted: consent, noticeVersion: 1 }),
  verifySelectionSnapshot: async ({ principal, projectId, selectionInput }) => {
    if (selectionInput?.pageId !== 'page_123') return null;
    return { projectId, accountId: principal.accountId, pageId: 'page_123', selection: { clipIds: [] }, sentAt: 100, source: 'sent-snapshot' };
  }, async resolveDelegation(ticket) {
      if (!['delegation_alice_1234567890', 'delegation_bob_1234567890', 'delegation_creator_1234567890'].includes(ticket))
        throw Object.assign(new Error('bad'), { status: 401, code: 'delegation-expired' });
      return { authorizationId: `auth:${ticket.includes('alice') ? a : ticket.includes('bob') ? b : c}`, projectId: pid };
    } });
  const client = fixture.client;
  const wrong = createConversationClient({ origin: 'https://127.0.0.1:5790', tls: cert.wrong, serverFingerprint256: cert.doc.pin });
  const wiring = createHostedWiring({ accountMode: true, conversationClient: client });
  const service = createHostedAgentService({ accountMode: true, conversationClient: client });
  const publicServer = http.createServer(createAgentHttp({ service, authenticate: wiring.authenticate }).handle);
  t.after(async () => { wrong.close(); await fixture.close(); wiring.close(); service.close(); if (publicServer.listening) await close(publicServer);
    ledger.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await fixture.start(); await listen(publicServer, 5791);
  const alice = 'delegation_alice_1234567890', bob = 'delegation_bob_1234567890', creator = 'delegation_creator_1234567890';
  await assert.rejects(wrong.identity({ delegation: alice }), { status: 403 });
  const spoof = await request(5791, bob, 'POST', '/v1/conversations/c1/messages', { prompt: 'Bob text', requestId: 'b1',
    accountId: a, selectionSnapshot: { pageId: 'page_123', accountId: a } });
  assert.equal(spoof.status, 400);
  const first = await request(5791, bob, 'POST', '/v1/conversations/c1/messages', { prompt: 'Bob text', requestId: 'b1',
    selectionSnapshot: { pageId: 'page_123' } });
  assert.equal(first.status, 202);
  assert.equal(first.body.conversation.ownerAccountId, b);
  const falseClaim = await client.send({ delegation: alice, projectId: pid, conversationId: 'c1', requestId: 'x1', content: 'X',
    principalRef: { authorizationId: `auth:${b}` } }).then(() => null, error => error);
  assert.equal(falseClaim.status, 400);
  const missingConsent = await (async () => { consent = false; return request(5791, alice, 'POST', '/v1/conversations/c2/messages',
    { prompt: 'No consent', requestId: 'a0', selectionSnapshot: { pageId: 'page_123' } }); })();
  assert.equal(missingConsent.status, 403); assert.equal(missingConsent.body.code, 'consent-required');
  consent = true;
  const sent = await request(5791, alice, 'POST', '/v1/conversations/c1/messages', { prompt: 'Alice text', requestId: 'a1',
    selectionSnapshot: { pageId: 'page_123' } });
  assert.equal(sent.status, 202); assert.equal(sent.body.queuePosition, 2);
  const retry = await request(5791, alice, 'POST', '/v1/conversations/c1/messages', { prompt: 'Alice text', requestId: 'a1',
    selectionSnapshot: { pageId: 'page_123' } });
  assert.equal(retry.body.messageId, sent.body.messageId);
  assert.equal((await request(5791, bob, 'GET', '/v1/conversations/c1')).body.meta.messages.length, 2);
  const streamAbort = new AbortController();
  const stream = await fetch('http://127.0.0.1:5791/v1/conversations/c1/events?after=0', {
    headers: { authorization: `Bearer ${alice}` }, signal: streamAbort.signal,
  });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  t.after(() => streamAbort.abort());
  assert.match(await readUntil(reader, /Alice text/), /Bob text/);
  const privateAttempt = await request(5791, alice, 'POST', '/v1/conversations/c1/visibility', { visibility: 'private', requestId: 'a-switch' });
  assert.equal(privateAttempt.status, 403);
  const privateResult = await request(5791, bob, 'POST', '/v1/conversations/c1/visibility', { visibility: 'private', requestId: 'b-switch' });
  assert.equal(privateResult.status, 200); assert.deepEqual(privateResult.body.cancelled, [sent.body.messageId]);
  // The signed control closes the real old transport before the private ACK.
  // It cannot enqueue a friendly tail event after installing its output fence.
  let ended = false;
  try { for (;;) { const next = await reader.read(); if (next.done) { ended = true; break; }
    assert.equal(new TextDecoder().decode(next.value).includes('must-not-publish'), false); } }
  catch { ended = true; }
  assert.equal(ended, true);
  streamAbort.abort();
  assert.equal((await request(5791, alice, 'GET', '/v1/conversations/c1')).status, 404);
  const creatorView = await request(5791, creator, 'GET', '/v1/conversations/c1');
  assert.equal(creatorView.status, 200); assert.equal(creatorView.body.meta.creatorReadOnly, true);
  assert.equal((await request(5791, creator, 'POST', '/v1/conversations/c1/messages', { prompt: 'No', requestId: 'c1',
    selectionSnapshot: { pageId: 'page_123' } })).status, 404);
  ledger.transaction(state => { state.revokedLogins[`login:login:${b}`] = { seq: 1 }; });
  assert.equal((await request(5791, bob, 'GET', '/v1/conversations')).status, 401);
});
