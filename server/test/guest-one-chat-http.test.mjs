/**
 * 游客每个项目只能开一个云端 Agent 对话：从页面能打到的那个 HTTP 口子（Agent 服务）一路到文档服务的对话权威，用真的 mTLS 跑一遍。
 * 证明两件事：绕过界面直接打接口，第二条新对话照样被拒，页面拿到的就是 403 + `guest-chat-limit`；登录账号在同一个项目里不受影响。
 * 对话权威本身的各种边角（并发、历史多条、名额让出）在 `guest-one-chat.test.mjs`。
 *
 * 跑：npm test -- server/test/guest-one-chat-http.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { freePorts } from './free-ports.mjs';
import { openAccountLedger } from '../account/ledger.mjs';
import { agentReadControlFixture } from './agent-read-control-fixture.mjs';
import { createConversationClient } from '../agent-service/conversation-client.mjs';
import { createHostedAgentService } from '../agent/service/create-agent-service.mjs';
import { createHostedWiring } from '../agent-service/hosted-wiring.mjs';
import { createAgentHttp } from '../agent-service/http.mjs';

const pid = 'sp_' + 'a'.repeat(26), g = 'gst_' + 'a'.repeat(24), a = 'acc_' + 'a'.repeat(24);
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
test('GOC-H1 真 mTLS + 真 HTTP：游客第一条对话 202，第二条被拒 403 guest-chat-limit，老对话照发；账号在同一个项目里照常建多条', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-guest-chat-http-'));
  const cert = certs(dir);
  const [docPort, publicPort] = await freePorts(2);
  const ledger = openAccountLedger({ file: path.join(dir, 'state.sqlite'), authorityId: 'guest-chat-http' });
  // 游客 g 自己的项目，账号 a 是里面的读写成员（比如游客把链接给了朋友，朋友登录后加入）
  ledger.transaction(state => { state.projects[pid] = { status: 'active', creatorAccountId: g,
    members: { [g]: { access: 'rw' }, [a]: { access: 'rw' } }, bans: {}, hosted: { agent: true } }; });
  const principals = Object.fromEntries([g, a].map(id => [`auth:${id}`, { authorizationId: `auth:${id}`, projectId: pid,
    accountId: id, accountName: id === g ? '游客-AAAA' : 'Alice', loginId: `login:${id}`, credentialId: `cred:${id}`, loginGeneration: 1,
    ...(id === g ? { guest: true } : {}) }]));
  const fixture = agentReadControlFixture({ ledger, directory: dir, docTls: cert.doc, agentTls: cert.agent,
    docPin: cert.doc.pin, agentPin: cert.agent.pin, port: docPort,
    accountAuthority: { async authorizePrincipal(ref, { projectId }) {
      const p = principals[ref.authorizationId];
      if (!p || p.projectId !== projectId) throw Object.assign(new Error('revoked'), { status: 401, code: 'credential-revoked' });
      return p;
    } }, checkConsent: async ({ accountId }) => ({ accountId, accepted: true, noticeVersion: 1 }),
    verifySelectionSnapshot: async ({ principal, projectId }) => ({ projectId, accountId: principal.accountId, pageId: 'page_123',
      selection: { clipIds: [] }, sentAt: 100, source: 'sent-snapshot' }),
    async resolveDelegation(ticket) {
      if (!['delegation_guest_1234567890', 'delegation_alice_1234567890'].includes(ticket)) throw Object.assign(new Error('bad'), { status: 401, code: 'delegation-expired' });
      return { authorizationId: `auth:${ticket.includes('guest') ? g : a}`, projectId: pid };
    } });
  const client = fixture.client;
  const wiring = createHostedWiring({ accountMode: true, conversationClient: client });
  const service = createHostedAgentService({ accountMode: true, conversationClient: client });
  const publicServer = http.createServer(createAgentHttp({ service, authenticate: wiring.authenticate }).handle);
  t.after(async () => { await fixture.close(); wiring.close(); service.close(); if (publicServer.listening) await close(publicServer);
    ledger.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await fixture.start(); await listen(publicServer, publicPort);
  const guest = 'delegation_guest_1234567890', alice = 'delegation_alice_1234567890';
  const post = (who, id, requestId) => request(publicPort, who, 'POST', `/v1/conversations/${id}/messages`,
    { prompt: `说一句 ${requestId}`, requestId, selectionSnapshot: { pageId: 'page_123' } });

  const first = await post(guest, 'g-chat-1', 'g1');
  assert.equal(first.status, 202);
  assert.equal(first.body.conversation.ownerAccountId, g);
  // 绕过界面，直接用新对话号打接口：被拒，页面拿到的是 403 和可辨认的码
  const second = await post(guest, 'g-chat-2', 'g2');
  assert.equal(second.status, 403);
  assert.equal(second.body.code, 'guest-chat-limit');
  assert.equal((await request(publicPort, guest, 'GET', '/v1/conversations/g-chat-2')).status, 404, '被拒的没有留下对话');
  // 老对话照发
  assert.equal((await post(guest, 'g-chat-1', 'g3')).status, 202);
  const list = await request(publicPort, guest, 'GET', '/v1/conversations');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.items.filter(x => x.ownerAccountId === g).map(x => x.id), ['g-chat-1']);
  // 账号在同一个项目里不受影响
  for (const [i, id] of ['a-chat-1', 'a-chat-2', 'a-chat-3'].entries()) assert.equal((await post(alice, id, `a${i}`)).status, 202, id);
  assert.equal(Object.values(ledger.read().conversationsV2[pid]).filter(c => c.ownerAccountId === a).length, 3);
  assert.equal(Object.values(ledger.read().conversationsV2[pid]).filter(c => c.ownerAccountId === g).length, 1);
});
