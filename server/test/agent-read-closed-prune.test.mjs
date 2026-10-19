// Agent 主服务本地「已关读取」回执账本不再无限变大（2026-10-19 节点上攒到 10.6 MB，每次读取都整段重写，
// 列对话、发消息、取 info 一个个排着等 2～7 秒）。见 conversation-control-client.mjs 的 CONFIRMED_CLOSE_KEEP_MS。
// 真 mTLS、真读取控制流、真 SQLite；只有账号凭证的签发方是测试替身（同 agent-read-control-transport.test.mjs）。
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
import { freePorts } from './free-ports.mjs';
import { assetWiringPki } from './fixtures/asset-wiring-pki.mjs';

const listen = (server, port) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
const close = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); });
const until = async (fn, ms = 5000) => { const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timeout'); await new Promise(r => setTimeout(r, 10)); } };

test('本地已关读取回执：别的实例的整批删、确认关掉过了留存期的删；删过以后围栏照常收口', { timeout: 30000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-agent-read-prune-'));
  const authorityId = 'read-prune-doc';
  const ledger = openAccountLedger({ file: path.join(dir, 'doc.sqlite'), authorityId });
  const receiptFile = path.join(dir, 'agent-read.sqlite');
  // 节点上那本账的样子：上一代进程留下的几百行（别的实例），新进程一行都用不上
  const seed = openAccountLedger({ file: receiptFile, authorityId });
  seed.transaction(s => { const rows = s.agentReadClosedV1 = {};
    for (let i = 0; i < 500; i++) rows[`read_old_${i}`] = { readHandleId: `read_old_${i}`, instanceId: 'instance_old', instanceGeneration: 1 }; });
  seed.close();
  const pki = assetWiringPki(dir), projectId = 'sp_' + 'c'.repeat(26), conversationId = 'prune_conv';
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
    return { service: 'agent', serviceKid: 'prune-test-agent-key', authenticationId: sockets.get(socket) };
  };
  const instances = createAgentInstanceAuthority({ ledger, verifyTransportInState(_state, principal) {
    const socket = subjects.get(principal.authenticationId);
    assert.ok(socket && !socket.destroyed);
    return { serviceId: 'agent', serviceKid: 'prune-test-agent-key', authenticationId: principal.authenticationId,
      channelBinding: instanceTlsBinding(socket) };
  } });
  const readControl = createAgentReadControl({ ledger, instanceAuthority: instances,
    authorizeRead: async () => account.authorizePrincipal({ authorizationId: trusted.authorizationId }, { projectId, action: 'read' }),
    checkReadInState: conversationReadInState });
  const conversations = createConversationAuthority({ ledger, accountAuthority: account,
    checkConsent: async ({ accountId }) => ({ accountId, accepted: true, noticeVersion: 1 }),
    verifySelectionSnapshot: async ({ principal }) => ({ projectId, accountId: principal.accountId,
      pageId: 'page_prune', selection: {}, source: 'sent-snapshot', sentAt: 1 }),
    runHooks: { fenceInState: (state, input) => readControl.hooks.fenceInState(state, input) },
    onFence: async input => { await readControl.waitCompletion(input); return { ack: true, ...input }; },
  });
  await conversations.send({ principalRef: { accessToken: owner }, projectId, conversationId, requestId: 'm1', content: 'hello' });
  const conversationsHandler = createConversationInternalHandler({ conversationAuthority: conversations, requireReadControl: true,
    agentFingerprint256: pki.asset.fingerprint256, resolveDelegation: async () => trusted });
  const instancesHandler = createAgentInstanceInternalHandler({ instanceAuthority: instances,
    agentFingerprint256: pki.asset.fingerprint256, resolveServicePrincipal });
  const controlsHandler = createAgentReadControlHandler({ control: readControl, instanceAuthority: instances, resolveServicePrincipal });
  const doc = https.createServer({ ...pki.doc, requestCert: true, rejectUnauthorized: true }, async (req, res) => {
    if (!await instancesHandler(req, res) && !await controlsHandler(req, res) && !await conversationsHandler(req, res)) { res.writeHead(404); res.end(); }
  });
  const [docPort, agentPort] = await freePorts(2);
  const options = { origin: `https://127.0.0.1:${docPort}`, tls: pki.asset, serverFingerprint256: pki.doc.fingerprint256 };
  const client = createConversationClient(options), runClient = createRunClient(options);
  let clock = Date.now();
  const controlClient = createConversationControlClient({ ...options, runClient, receiptFile, now: () => clock, confirmedKeepMs: 60_000 });
  client.useReadControl(controlClient);
  const service = createAccountConversationService({ conversationClient: client });
  const api = createAgentHttp({ service, authenticate: async () => ({ accountMode: true, projectId,
    userId: member, accountId: member, delegation: 'temporary-delegation' }) });
  const agent = http.createServer((req, res) => { void api.handle(req, res); });
  t.after(async () => { await controlClient.close(); client.close(); runClient.close();
    readControl.close(); await close(agent); await close(doc); instances.close(); account.close(); ledger.close();
    fs.rmSync(dir, { recursive: true, force: true }); });
  await listen(doc, docPort); await listen(agent, agentPort);
  await controlClient.start();
  await until(() => controlClient.describe().connected);

  const list = () => new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${agentPort}/v1/conversations`, res => { const chunks = [];
      res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() })); })
      .once('error', reject);
  });
  const docClosed = () => Object.values(ledger.read().agentReadsV1?.handles ?? {}).filter(h => h.state === 'closed').length;

  // 第一次读：本地记一行时把上一代留下的 500 行一起删掉
  let r = await list();
  assert.equal(r.status, 200, r.body);
  await until(() => docClosed() >= 1);
  assert.equal(controlClient.describe().localClosedReceipts, 1, '旧实例的 500 行删掉，只剩这一次读取的那一行');

  // 留存期内：确认关掉的行还留着（读取控制流若晚一步点名它，还能在本地查到）
  for (let i = 0; i < 5; i++) { r = await list(); assert.equal(r.status, 200); }
  await until(() => docClosed() >= 6);
  assert.equal(controlClient.describe().localClosedReceipts, 6);
  // 文档服务记「已关」先于本机收到关闭请求的回应(那时才记「确认」)：等 6 行都确认了再拨时钟，否则满负载下最后一行的确认落在拨钟之后
  await until(() => controlClient.describe().confirmedClosedReceipts >= 6);

  // 过了留存期：下一次记行时把它们删掉
  clock += 61_000;
  r = await list(); assert.equal(r.status, 200);
  await until(() => docClosed() >= 7);
  assert.equal(controlClient.describe().localClosedReceipts, 1, '确认关掉、过了留存期的行删掉');

  // 删过以后围栏照常收口：设为私有要等读取控制收回执，等得到才算办完
  const switched = await conversations.switchVisibility({ principalRef: { accessToken: owner }, projectId, conversationId,
    visibility: 'private', requestId: 'private1' });
  assert.equal(switched.visibility, 'private');
  t.diagnostic(JSON.stringify({ oldRowsSeeded: 500, afterFirstRead: 1, afterKeep: 1 }));
});
