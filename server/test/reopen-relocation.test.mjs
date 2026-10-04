import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { openCredentialStore, forgetCredentialStore } from '../auth/store.mjs';
import { freezeRoom, markRoomMoved, roomUnavailableReason } from '../recovery/relocation.mjs';
import { RecoveryCoordinator } from '../recovery/coordinator.mjs';
import { startHostedCombo } from '../hosted/combo.mjs';
import { buildAuthProtocols } from '../auth/client.mjs';
import { issueInvite } from '../auth/invite.mjs';
import { signTicket } from '../auth/tickets.mjs';
import { createAssetClient } from '../asset-store/client.mjs';
import { createDocEndpoint } from '../render-node/session-link.mjs';
import { wsClient, rawHandshake, createTcpProxy, waitFor } from './fake-ws-kit.mjs';

const secret = n => randomBytes(n ?? 32).toString('base64url');
const txn = () => `move_${randomBytes(16).toString('hex')}`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pc-reopen-fence-'));
const credential = username => ({ ...(username ? { username } : {}), salt: secret(16), key: secret() });
const target = { service: 'https://isolated.invalid', where: 'hosted', deviceId: null };
const manifest = { rev: 1, logDigest: hash('final-doc-log'), assetDigest: hash('complete-asset-manifest') };
function create(store, name = 'isolated-relocation') {
  return store.create({ name, mode: 'restricted', kdf: { alg: 'pbkdf2-sha256', iter: 100000 }, creator: credential('host'), list: [credential('member')] });
}
function fixture() {
  const dir = temporary(), store = openCredentialStore({ dir, log: () => {} }), rec = create(store);
  return { dir, store, rec, options: { store, roomId: rec.projectId, txnId: txn(), expectedEpoch: 1, target, manifest } };
}
test('迁移封禁：可靠落盘后立即改变内存权限，幂等重试并跨存储重开保持', () => {
  const { dir, store, rec, options } = fixture();
  assert.equal(roomUnavailableReason(store.peek(rec.projectId)), null, 'ordinary offline rooms remain available');
  const first = freezeRoom(options), bytes = fs.readFileSync(path.join(dir, 'projects', `${rec.projectId}.json`));
  assert.equal(roomUnavailableReason(store.peek(rec.projectId)), 'relocating');
  assert.equal(hash(JSON.stringify(freezeRoom(options))), hash(JSON.stringify(first)));
  assert.equal(hash(fs.readFileSync(path.join(dir, 'projects', `${rec.projectId}.json`))), hash(bytes));
  const reopened = openCredentialStore({ dir, log: () => {} });
  assert.equal(roomUnavailableReason(reopened.peek(rec.projectId)), 'relocating');
  assert.equal(reopened.peek(rec.projectId).creator.key === rec.creator.key, true, 'fencing does not generate new passwords');
});
test('迁移封禁：竞争事务、过时代数、改变目的地和不完整清单均拒绝且原记录不变', () => {
  const { dir, store, rec, options } = fixture();
  const file = path.join(dir, 'projects', `${rec.projectId}.json`), before = hash(fs.readFileSync(file));
  for (const change of [{ expectedEpoch: 2 }, { target: { ...target, service: 'https://isolated.invalid/?redirect=1' } }, { manifest: { ...manifest, assetDigest: '' } }]) {
    assert.throws(() => freezeRoom({ ...options, ...change }), e => ['bad-relocation', 'relocation-conflict'].includes(e.reason));
    assert.equal(hash(fs.readFileSync(file)), before);
  }
  freezeRoom(options); const fenced = hash(fs.readFileSync(file));
  for (const change of [{ txnId: txn() }, { target: { ...target, service: 'https://other.invalid' } }, { manifest: { ...manifest, rev: 2 } }]) {
    assert.throws(() => freezeRoom({ ...options, ...change }), e => e.reason === 'relocation-conflict');
    assert.equal(hash(fs.readFileSync(file)), fenced);
  }
});
test('迁移封禁：原子写入 ENOSPC 不改变内存或旧记录，能在存储恢复后重试', () => {
  const { dir, store, rec, options } = fixture(), file = path.join(dir, 'projects', `${rec.projectId}.json`);
  const before = hash(fs.readFileSync(file)), rename = fs.renameSync;
  try {
    fs.renameSync = (from, to) => { if (to === file) throw Object.assign(new Error('isolated disk-full fault'), { code: 'ENOSPC' }); return rename(from, to); };
    assert.throws(() => freezeRoom(options), e => e.code === 'ENOSPC');
    assert.equal(roomUnavailableReason(store.peek(rec.projectId)), null);
    assert.equal(hash(fs.readFileSync(file)), before);
  } finally { fs.renameSync = rename; }
  freezeRoom(options); assert.equal(roomUnavailableReason(store.peek(rec.projectId)), 'relocating');
});
test('迁移已完成标记：必须匹配精确事务、房间、代数、目的地和清单，失败不回滚封禁', () => {
  const { dir, store, rec, options } = fixture(), frozen = freezeRoom(options);
  const authority = { roomId: rec.projectId, txnId: frozen.txnId, epoch: frozen.targetEpoch, target, manifest };
  for (const change of [{ roomId: 'sp_aaaaaaaaaaaaaaaaaaaaaaaaaa' }, { txnId: txn() }, { epoch: 1 }, { target: { ...target, service: 'https://other.invalid' } }, { manifest: { ...manifest, logDigest: hash('stale-log') } }]) {
    assert.throws(() => markRoomMoved({ store, roomId: rec.projectId, authority: { ...authority, ...change } }), e => e.reason === 'relocation-conflict');
    assert.equal(roomUnavailableReason(store.peek(rec.projectId)), 'relocating');
  }
  markRoomMoved({ store, roomId: rec.projectId, authority });
  const file = path.join(dir, 'projects', `${rec.projectId}.json`), before = hash(fs.readFileSync(file));
  markRoomMoved({ store, roomId: rec.projectId, authority });
  assert.equal(hash(fs.readFileSync(file)), before);
  assert.equal(roomUnavailableReason(openCredentialStore({ dir, log: () => {} }).peek(rec.projectId)), 'relocated');
  assert.throws(() => freezeRoom({ ...options, txnId: txn() }), e => e.reason === 'relocation-conflict');
});
test('迁移标记损坏失败关闭，不能当成旧文件没有协作信息', () => {
  const { store, rec } = fixture();
  for (const relocation of [null, {}, { version: 2 }, { phase: 'active' }]) {
    store.update(rec.projectId, draft => { draft.relocation = relocation; });
    assert.equal(roomUnavailableReason(store.peek(rec.projectId)), 'relocation-damaged');
  }
});
let sequence = 0;
async function ask(c, message) {
  const reqId = `fence-${++sequence}`; c.send({ ...message, reqId });
  try { return await c.next(m => m.reqId === reqId); } catch { throw new Error('isolated fence reply timed out; secrets omitted'); }
}
test('真实服务：封禁即时阻止旧页面/Agent/渲染节点写入、新连接及旧素材票据，服务重开后仍有效', { timeout: 15000 }, async t => {
  const root = temporary(); let combo = await startHostedCombo({ dataDir: root, docPort: 0, assetPort: 0, host: '127.0.0.1', trustLoopback: true, localDevice: { deviceId: 'source-original-device-01', deviceName: 'isolated-source' }, log: () => {} });
  t.after(() => combo.close());
  const rec = create(combo.credentialStore), roomId = rec.projectId, base = `http://127.0.0.1:${combo.docPort}`;
  const protocols = () => buildAuthProtocols({ base, projectId: roomId, username: 'host', as: 'creator', key: rec.creator.key, deviceId: 'source-original-device-01', deviceName: 'isolated-source' });
  const host = wsClient(base.replace('http:', 'ws:'), await protocols()); await host.opened; t.after(() => host.close());
  await ask(host, { type: 'project.open', projectId: roomId });
  assert.equal((await ask(host, { type: 'project.op', projectId: roomId, opId: 'initial', ops: [{ op: 'set', path: '', value: { id: 'isolated-content', name: 'latest', media: [], tracks: [] } }] })).rev, 1);
  const issued = await ask(host, { type: 'auth.ticket', kind: 'asset', access: 'rw' }); assert.equal(issued.type, 'auth.ticket.ok');
  const bytes = randomBytes(5000), asset = createAssetClient({ base: combo.assetPublicUrl, ticket: async () => issued.ticket });
  const uploaded = await asset.put('media', bytes, { ext: 'bin' }); assert.equal(uploaded.hash, hash(bytes));
  const roles = [];
  for (const role of ['agent', 'render']) {
    const grant = await ask(host, { type: 'auth.ticket', kind: 'conn', role, ...(role === 'agent' ? { conversation: 1 } : { owner: { kind: 'user' } }) });
    assert.equal(grant.type, 'auth.ticket.ok');
    const c = wsClient(base.replace('http:', 'ws:'), ['promptcut.v1', `promptcut.ticket.${grant.ticket}`]); await c.opened; roles.push(c); t.after(() => c.close());
  }
  const freshBeforeFence = await protocols();
  const invitation = issueInvite(combo.credentialStore.serverSecret, { expiresInSec: 1000, maxUses: 2 }, Date.now());
  combo.credentialStore.update(roomId, draft => { draft.invite = invitation.invite; });
  const localBefore = await rawHandshake(combo.docPort, { protocols: ['promptcut.v1', `promptcut.tenant.${roomId}`] });
  assert.equal(localBefore.status, 101); localBefore.sock.destroy();
  const opFile = path.join(combo.paths.tenants, roomId, 'projects', `${roomId}.ops.ndjson`), logBefore = hash(fs.readFileSync(opFile));
  freezeRoom({ store: combo.credentialStore, roomId, txnId: txn(), expectedEpoch: 1, target, manifest: { ...manifest, logDigest: logBefore } });
  // These already authenticated connections remain open, proving safety is not a polite close.
  for (const c of [host, ...roles]) {
    const reply = await ask(c, { type: 'project.op', projectId: roomId, opId: 'late-write', ops: [{ op: 'set', path: '/name', value: 'must-not-land' }] });
    assert.equal(reply.type, 'error'); assert.equal(reply.reason, 'relocating');
    assert.equal((await ask(c, { type: 'auth.ticket', kind: 'asset', access: 'rw' })).reason, 'relocating');
    assert.equal((await ask(c, { type: 'task.claim', taskId: 'late-task' })).reason, 'relocating');
  }
  assert.equal(hash(fs.readFileSync(opFile)), logBefore, 'no old connection changed the frozen document log');
  for (const offered of [freshBeforeFence, ['promptcut.v1', `promptcut.tenant.${roomId}`], ['promptcut.v1', `promptcut.ticket.${issued.ticket}`]]) {
    const denied = await rawHandshake(combo.docPort, { protocols: offered }); assert.equal(denied.status, 401); denied.sock.destroy();
  }
  const after = await fetch(`${combo.assetPublicUrl}/media/${uploaded.hash}`, { headers: { authorization: `Bearer ${issued.ticket}`, 'x-forwarded-for': '198.51.100.1' } });
  assert.equal(after.status, 401, 'an old valid asset ticket must not work at the frozen source');
  assert.throws(() => signTicket(combo.credentialStore.peek(roomId), { k: 'asset', u: 'host@source-original-device-01', r: 'rw' }, Date.now()), e => e.reason === 'relocating');
  for (const which of ['resolve', 'redeem']) {
    const res = await fetch(`${base}/shared/invite/${which}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: invitation.code, username: 'member', deviceId: 'isolated-member-device-01' }) });
    assert.equal(res.status, 503); assert.equal((await res.json()).error, 'relocating');
  }
  assert.equal(combo.credentialStore.peek(roomId).invite.used, 0);
  for (const c of [host, ...roles]) c.close();
  const authDir = path.join(combo.paths.docservice, 'auth'); await combo.close(); forgetCredentialStore(authDir);
  combo = await startHostedCombo({ dataDir: root, docPort: 0, assetPort: 0, host: '127.0.0.1', trustLoopback: false, clusterToken: secret(), log: () => {} });
  assert.equal(roomUnavailableReason(combo.credentialStore.peek(roomId)), 'relocating');
  const response = await fetch(`http://127.0.0.1:${combo.docPort}/shared/challenge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: roomId, username: 'host', as: 'creator', deviceId: 'source-original-device-01' }) });
  assert.equal(response.status, 503); assert.equal((await response.json()).error, 'relocating'); assert.equal(hash(fs.readFileSync(opFile)), logBefore);
});
test('真实会话：封禁后不能用原会话秘密接续，脱开并保留的会话也重新检查持久状态', { timeout: 10000 }, async t => {
  const root = temporary(), combo = await startHostedCombo({ dataDir: root, docPort: 0, assetPort: 0, host: '127.0.0.1', trustLoopback: false, clusterToken: secret(), log: () => {} }); t.after(() => combo.close());
  const rec = create(combo.credentialStore), roomId = rec.projectId, base = `http://127.0.0.1:${combo.docPort}`;
  const proxy = await createTcpProxy({ target: combo.docPort }); t.after(() => proxy.close());
  const endpoint = createDocEndpoint({ url: `ws://127.0.0.1:${proxy.port}`, transport: 'ws', renew: false,
    protocols: () => buildAuthProtocols({ base, projectId: roomId, username: 'host', as: 'creator', key: rec.creator.key, deviceId: 'source-original-device-01', deviceName: 'isolated-source' }),
    backoff: { baseMs: 10, factor: 2, maxMs: 20, jitter: 0 } });
  t.after(() => endpoint.close()); const closed = []; endpoint.onClose(info => closed.push({ code: info.code, reason: info.reason }));
  await waitFor(() => endpoint.connected, 3000);
  freezeRoom({ store: combo.credentialStore, roomId, txnId: txn(), expectedEpoch: 1, target, manifest });
  proxy.cutAll(); await waitFor(() => closed.some(e => e.code === 4410 && e.reason === 'session-closed 1012 relocating'), 5000, 'fenced session refused');
  assert.equal(endpoint.stats().resumes, 0); assert.equal(endpoint.stats().opens, 1);
});
test('旧原主机标记已搬迁：只做可信发现，不重新开启旧主机；已知迁移中不会回滚', async () => {
  const descriptor = { version: 1, roomId: 'sp_aaaaaaaaaaaaaaaaaaaaaaaaaa', service: target.service, where: 'lan' }, states = [];
  let entered = 0, hosted = 0, discovered = 0;
  const coordinator = new RecoveryCoordinator({ state: s => states.push(s), identity: async () => ({ selected: { candidate: { where: 'lan' } }, host: {} }),
    host: async () => { hosted++; throw Object.assign(new Error('sealed old host'), { reason: 'relocated' }); },
    discover: async d => { discovered++; assert.equal(d.service, target.service); return { where: 'hosted' }; },
    enter: async candidate => { entered++; assert.equal(candidate.where, 'hosted'); return { ok: true }; } });
  coordinator.start(descriptor, 'content'); await waitFor(() => states.includes('connected'));
  assert.equal(hosted, 1); assert.equal(discovered, 1); assert.equal(entered, 1); coordinator.cancel();
  const waiting = [], pending = new RecoveryCoordinator({ ...coordinator.hooks, state: s => waiting.push(s),
    host: async () => { throw Object.assign(new Error('pending verified handoff'), { reason: 'relocating' }); },
    discover: async () => { throw new Error('must not discover a half-completed destination'); } });
  pending.start(descriptor, 'content'); await waitFor(() => waiting.includes('waiting-host')); pending.cancel();
  assert.equal(entered, 1);
});
