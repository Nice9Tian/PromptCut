import test from 'node:test';
import assert from 'node:assert/strict';
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

/**
 * 块五(0.7.18):从页面的 HTTP 请求一路到文档服务的对话权威（真的 mTLS、真的 SQLite 账本、真的 SSE）:
 * 删除、满额、别人删之后的通知与补弹、正在看的对话被删时流上的事件。端口 28180、28181。
 */
const until = async (predicate, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (!(await predicate())) { if (Date.now() >= deadline) throw Error('observation-timeout'); await new Promise(resolve => setTimeout(resolve, 10)); }
};

test('HTTP 全链路:删除、满额、通知补弹、被删时流上的事件', { timeout: 30000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-conv-delete-http-'));
  const ledger = openAccountLedger({ file: path.join(dir, 'doc.sqlite'), authorityId: 'delete-http-doc' });
  const pki = assetWiringPki(dir), projectId = 'sp_' + 'a'.repeat(26);
  const a = 'acc_' + 'a'.repeat(24), b = 'acc_' + 'b'.repeat(24), creator = 'acc_' + 'c'.repeat(24);
  const nameOf = { [a]: 'Alice', [b]: 'Bob', [creator]: 'Creator' };
  const principals = new Map([a, b, creator].map(accountId => [accountId, { identityVersion: 2, realm: 'account', accountId,
    accountName: nameOf[accountId], loginId: `login-${accountId}`, credentialId: `cred-${accountId}`,
    loginGeneration: 1, expiresAt: Date.now() + 60000, accountEventSeq: 0 }]));
  ledger.transaction(s => { s.projects[projectId] = { projectId, creatorAccountId: creator, status: 'active', accessRevision: 1,
    hosted: { agent: true }, bans: {}, members: Object.fromEntries([a, b, creator].map(id => [id, { access: 'rw' }])) }; });
  let fixture;
  const authority = createAccountAuthority({ ledger, pollMs: 0, accountClient: {
    async verify(token) { assert.ok(principals.has(token)); return structuredClone(principals.get(token)); },
    async events() { return { events: [], headSeq: 0 }; } },
    runHooks: { fenceInState: (state, fence) => fixture.control.hooks.fenceInState(state, fence) } });
  const trusted = {};
  for (const id of [a, b, creator]) trusted[`delegation-${id}`] = await authority.authorizePrincipal({ accessToken: id }, { projectId, action: 'read' });
  fixture = agentReadControlFixture({ ledger, directory: dir, docTls: pki.doc, agentTls: pki.asset,
    docPin: pki.doc.fingerprint256, agentPin: pki.asset.fingerprint256, port: 28180, accountAuthority: authority,
    resolveDelegation: async value => { assert.ok(trusted[value], 'known delegation'); return trusted[value]; },
    checkConsent: async ({ accountId }) => ({ accountId, accepted: true, noticeVersion: 1 }),
    verifySelectionSnapshot: async ({ principal }) => ({ projectId, accountId: principal.accountId, source: 'sent-snapshot',
      pageId: 'page-1', selection: {}, sentAt: 1 }) });
  const service = createAccountConversationService({ conversationClient: fixture.client });
  const api = createAgentHttp({ service, authenticate: async req => ({ accountMode: true, projectId,
    accountId: req.headers['x-test-account'], userId: req.headers['x-test-account'], delegation: `delegation-${req.headers['x-test-account']}` }) });
  const server = http.createServer((req, res) => { void api.handle(req, res); });
  const streams = [];
  t.after(async () => { for (const s of streams) s.destroy(); await fixture.close();
    if (server.listening) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    service.close(); authority.close(); ledger.close(); fs.rmSync(dir, { recursive: true }); });
  await fixture.start(); await new Promise(resolve => server.listen(28181, '127.0.0.1', resolve));

  const call = (account, method, url, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(`http://127.0.0.1:28181${url}`, { method, headers: { 'x-test-account': account,
      ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject); req.end(payload ?? undefined);
  });
  const post = (account, conversationId, prompt, requestId) => call(account, 'POST', `/v1/conversations/${conversationId}/messages`,
    { prompt, requestId, selectionSnapshot: { pageId: 'page-1' } });

  // 共有对话：Alice 开、Bob 说了一句；Creator 没说过
  assert.equal((await post(a, 'conv-1', '改一下封面文案', 'r1')).status, 202);
  assert.equal((await post(b, 'conv-1', '我也补一句', 'r2')).status, 202);

  // Bob 开着这个共有对话的事件流；之后它被删，流上要来一条 conversation.deleted，然后关
  let wire = '', streamClosed = false;
  const stream = http.get('http://127.0.0.1:28181/v1/conversations/conv-1/events?after=0', { headers: { 'x-test-account': b } }, res => {
    res.on('data', chunk => { wire += chunk; }); res.once('close', () => { streamClosed = true; }); res.on('error', () => {});
  }); stream.on('error', () => {}); streams.push(stream);
  await until(() => wire.includes('"type":"user"'));

  // 不是开对话的人、也不是创建者：删不了（共有对话看得见，但没权限）
  const denied = await call(b, 'DELETE', '/v1/conversations/conv-1', { requestId: 'del-b' });
  assert.equal(denied.status, 403); assert.equal(denied.body.code, 'delete-forbidden');
  assert.ok(ledger.read().conversationsV2[projectId]['conv-1'], '没删掉');

  // 项目创建者删 Alice 的共有对话
  const removed = await call(creator, 'DELETE', '/v1/conversations/conv-1', { requestId: 'del-1' });
  assert.equal(removed.status, 200); assert.equal(removed.body.removed, true); assert.equal(removed.body.already, false);
  assert.equal(ledger.read().conversationsV2[projectId]['conv-1'], undefined);
  await until(() => wire.includes('conversation.deleted') && streamClosed);
  assert.equal(wire.includes('access.revoked'), false, '被删和被撤权分开说');
  // 重复删：同一个请求原结果、换请求号得到「已删」
  assert.deepEqual((await call(creator, 'DELETE', '/v1/conversations/conv-1', { requestId: 'del-1' })).body, removed.body);
  assert.equal((await call(creator, 'DELETE', '/v1/conversations/conv-1', { requestId: 'del-2' })).body.already, true);
  assert.equal((await call(a, 'DELETE', '/v1/conversations/conv-1', {})).body.already, true, '没带请求号也行(服务端起一个)');

  // 通知：Alice(开对话的人)和 Bob(发过消息)各一条，Creator(删的人)没有
  const noticesA = await call(a, 'GET', '/v1/notices'), noticesB = await call(b, 'GET', '/v1/notices'), noticesC = await call(creator, 'GET', '/v1/notices');
  assert.equal(noticesA.body.items.length, 1); assert.equal(noticesA.body.items[0].recipientRole, 'owner');
  assert.equal(noticesA.body.items[0].deletedByName, 'Creator'); assert.equal(noticesA.body.items[0].title, '改一下封面文案');
  assert.equal(noticesB.body.items.length, 1); assert.equal(noticesB.body.items[0].recipientRole, 'participant');
  assert.equal(noticesC.body.items.length, 0);
  // 没弹到就还在（补弹）；回执以后不再给；别人的回执回不掉我的
  assert.equal((await call(b, 'GET', '/v1/notices')).body.items.length, 1);
  assert.equal((await call(a, 'POST', '/v1/notices/ack', { noticeIds: [noticesB.body.items[0].noticeId] })).body.acked, 0);
  assert.equal((await call(b, 'POST', '/v1/notices/ack', { noticeIds: [noticesB.body.items[0].noticeId] })).body.acked, 1);
  assert.equal((await call(b, 'GET', '/v1/notices')).body.items.length, 0);
  assert.equal((await call(b, 'POST', '/v1/notices/ack', { noticeIds: 'x' })).status, 400);

  // 满额：Alice 再开 49 个，第 51 个被拒(409)，已有的一个不少；删一个以后又能开
  for (let i = 0; i < 50; i++) assert.equal((await post(a, `conv-a${i}`, `第 ${i} 个`, `ra${i}`)).status, 202, `第 ${i + 1} 个`);
  const full = await post(a, 'conv-over', '第 51 个', 'ra-over');
  assert.equal(full.status, 409); assert.equal(full.body.code, 'conversation-limit');
  assert.equal((await call(a, 'GET', '/v1/conversations')).body.items.length, 50, '满额没有淘汰任何对话');
  assert.equal((await call(a, 'DELETE', '/v1/conversations/conv-a0', { requestId: 'del-a0' })).status, 200);
  assert.equal((await post(a, 'conv-over', '第 51 个', 'ra-over2')).status, 202, '删一个以后立刻能新建');
  // 没有这个对话 / 别人的私有对话：404
  assert.equal((await call(a, 'DELETE', '/v1/conversations/not-there', { requestId: 'x' })).status, 404);
});
