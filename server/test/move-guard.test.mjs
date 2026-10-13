/**
 * 「搬到云端」旧流程的防呆：动手改本机状态之前先问目标节点接不接受旧办法的导入。
 * - 账号模式节点：本机房间逐项不变（记录、操作日志、封锁、托管、还能编辑），云端只收到一个只读的健康检查，
 *   一个字节都没写；节点一侧的整房导入口也关着。
 * - 旧模式节点：整条搬迁照旧走完。
 * 端口一律向系统要，不写死。账号模式节点是真实的账号夹具（需要同全量测试一样的两个环境变量）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { startHostedCombo } from '../hosted/combo.mjs';
import { buildAuthProtocols } from '../auth/client.mjs';
import { mirrorOf } from '../hosting/host.mjs';
import { openRecoveryVault } from '../recovery/vault.mjs';
import { recoveryHttp } from '../recovery/http.mjs';
import { legacyImportAccepted } from '../recovery/relocation-preflight.mjs';
import { roomUnavailableReason } from '../recovery/relocation.mjs';
import { wsClient, waitFor } from './fake-ws-kit.mjs';
import { hostedPorts } from './sp-kit.mjs';
import { freePorts } from './free-ports.mjs';
import { startCloudQueueUserFixture } from './fixtures/cloud-queue-user-path.mjs';

const key = () => randomBytes(32).toString('base64url');
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pc-move-guard-'));
const cred = username => ({ ...(username ? { username } : {}), salt: randomBytes(16).toString('base64url'), key: key() });
const assetsOf = c => Object.fromEntries(['media', 'snap', 'px'].map(ns => [ns, { root: path.join(c.paths.assets, ns), shard: true }]));
let seq = 0;
const ask = async (client, body) => { const reqId = `move-guard-${++seq}`; client.send({ ...body, reqId }); return client.next(m => m.reqId === reqId); };
const DEVICE = 'isolated-original-host-01';

/** 桌面版一侧的替身：一个旧办法的本机房间（真实的托管组合当本机文档服务）、房间里已有内容、加上本机恢复接口 */
async function desktopRoom(t, { service, registerWith = null }) {
  const root = temp(), options = { host: '127.0.0.1', docPort: 0, assetPort: 0, trustLoopback: false, clusterToken: key(), log: () => {} };
  const source = await startHostedCombo({ ...options, ...await hostedPorts(), dataDir: root });
  const rec = source.credentialStore.create({ name: 'move-guard-room', mode: 'free', kdf: { alg: 'pbkdf2-sha256', iter: 100000 }, creator: cred('host'), project: cred() });
  const base = `http://127.0.0.1:${source.docPort}`;
  const protocols = await buildAuthProtocols({ base, projectId: rec.projectId, username: 'host', as: 'creator', deviceId: DEVICE, deviceName: 'isolated-device', key: rec.creator.key });
  const host = wsClient(base.replace('http:', 'ws:'), protocols); await host.opened;
  await ask(host, { type: 'project.open', projectId: rec.projectId });
  await ask(host, { type: 'project.op', projectId: rec.projectId, opId: 'root', ops: [{ op: 'set', path: '', value: { id: 'same-content', name: 'before', media: [], tracks: [] } }] });
  const descriptor = { version: 1, roomId: rec.projectId, service, where: 'lan' };
  const vaultDir = temp(), vault = openRecoveryVault({ dir: vaultDir }), hostBinding = vault.bindHost(descriptor, DEVICE);
  if (registerWith) {
    // 旧办法的本机房间在旧模式节点上登记过（登记密钥就是本机保存的主机密钥）；账号模式节点上不需要
    const r = await fetch(`${registerWith}/hosting/register`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${hostBinding.registrationKey}` },
      body: JSON.stringify({ roomId: rec.projectId, deviceId: DEVICE, instance: key(), mirror: mirrorOf(rec) }) });
    assert.equal(r.status, 200);
  }
  let close; const handler = recoveryHttp({ dir: vaultDir, dataDir: source.paths.docservice, store: source.credentialStore,
    device: { deviceId: DEVICE, deviceName: 'isolated-device' }, baseOf: () => base, assetBaseOf: () => `http://127.0.0.1:${source.assetPort}`,
    assets: assetsOf(source), reloadSpace: source.reloadSpace, onClose: fn => { close = fn; } });
  const call = async (route, extra = {}) => {
    const body = JSON.stringify({ descriptor, task: 'move-guard', taskVersion: 1, ...extra });
    const req = { url: `/api/collaboration/${route}`, method: 'POST', headers: { 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { yield body; } };
    let status, result; await handler(req, { writeHead(code) { status = code; }, end(text) { result = JSON.parse(text); }, headersSent: false }, () => assert.fail('recovery route must be handled'));
    return { status, result };
  };
  t.after(async () => { close(); host.close(); await source.close(); });
  const snapshot = () => ({ record: JSON.stringify(source.credentialStore.peek(rec.projectId)), host: JSON.stringify(vault.host(descriptor)),
    ops: fs.readFileSync(path.join(source.paths.docservice, 'tenants', rec.projectId, 'projects', `${rec.projectId}.ops.ndjson`), 'utf8'),
    stage: fs.existsSync(path.join(source.paths.docservice, 'relocation')) });
  return { source, rec, host, descriptor, vault, call, snapshot, root };
}

/** 转发到真实节点、并记下每个请求的记录器：看云端到底收到了什么 */
async function recordingProxy(t, targetPort) {
  const log = [];
  const server = http.createServer((req, res) => {
    log.push(`${req.method} ${String(req.url).split('?')[0]}`);
    const up = http.request({ hostname: '127.0.0.1', port: targetPort, method: req.method, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${targetPort}` } }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); }));
  return { url: `http://127.0.0.1:${server.address().port}`, log };
}

test('预检：账号模式、读不到、答得不像文档服务都不放行；旧模式放行', async () => {
  const answer = (status, body) => async () => ({ ok: status === 200, status, json: async () => { if (body === undefined) throw new SyntaxError('not json'); return body; } });
  const check = fetchImpl => legacyImportAccepted({ service: 'https://node.example/hosted', fetchImpl, attempts: 1 });
  assert.deepEqual(await check(answer(200, { ok: true, service: 'promptcut-docservice' })), { ok: true });
  assert.deepEqual(await check(answer(200, { ok: true, accountMode: 'v2', accountRequired: true, assetReady: true })), { ok: false, error: 'account-mode' });
  assert.deepEqual(await check(answer(200, { ok: true, accountMode: 'legacy', accountRequired: false })), { ok: false, error: 'account-mode' }, '带账号模式字段的一律不当旧模式');
  assert.deepEqual(await check(answer(200, { ok: true, accountRequired: true })), { ok: false, error: 'account-mode' });
  assert.deepEqual(await check(answer(404, { ok: false })), { ok: false, error: 'relocation-network' });
  assert.deepEqual(await check(answer(200, undefined)), { ok: false, error: 'relocation-network' });
  assert.deepEqual(await check(answer(200, { service: 'something-else' })), { ok: false, error: 'relocation-network' });
  assert.deepEqual(await check(async () => { throw new TypeError('fetch failed'); }), { ok: false, error: 'relocation-network' });
  assert.deepEqual(await legacyImportAccepted({ service: 'not a url', fetchImpl: async () => assert.fail('bad address is never asked') }), { ok: false, error: 'relocation-network' });
  let calls = 0;
  assert.deepEqual(await legacyImportAccepted({ service: 'https://node.example', attempts: 2, fetchImpl: async () => { calls++; if (calls === 1) throw new TypeError('reset'); return { ok: true, json: async () => ({ ok: true }) }; } }), { ok: true }, '暂时性失败退避后再问一次');
});

test('账号模式节点：点搬到云端后本机房间逐项不变、云端只收到只读的健康检查，整房导入口也关着', { timeout: 120_000 }, async t => {
  const [agentPort, ...ports] = await freePorts(8);
  const cloud = await startCloudQueueUserFixture({ ports, agentPort });
  t.after(() => cloud.close());
  const proxy = await recordingProxy(t, cloud.ports.doc);
  const room = await desktopRoom(t, { service: proxy.url });
  const before = room.snapshot(), cloudBefore = proxy.log.length;
  assert.equal(roomUnavailableReason(room.source.credentialStore.peek(room.rec.projectId)), null);

  const moved = await room.call('move-hosted');
  assert.equal(moved.status, 409); assert.deepEqual(moved.result, { ok: false, error: 'account-mode' });
  assert.deepEqual(proxy.log.slice(cloudBefore), ['GET /healthz'], '云端只收到一个只读的健康检查');
  assert.deepEqual(room.snapshot(), before, '房间记录、主机绑定、操作日志逐项不变，没建搬迁暂存');
  assert.equal(roomUnavailableReason(room.source.credentialStore.peek(room.rec.projectId)), null, '没封锁');
  const status = await room.call('move-status');
  assert.equal(status.status, 200); assert.equal(status.result.state, 'idle');
  assert.equal((await room.call('restore-host')).status, 200, '成员重连用的恢复接口照常放行');
  // 本机房间还能编辑
  const edited = await ask(room.host, { type: 'project.op', projectId: room.rec.projectId, opId: 'after-refusal', expectRev: 1, ops: [{ op: 'set', path: '/name', value: 'after-refusal' }] });
  assert.equal(edited.rev, 2, JSON.stringify(edited));
  // 再点一次结果相同，也不留任何东西
  assert.equal((await room.call('move-hosted', { taskVersion: 2 })).result.error, 'account-mode');
  assert.equal(room.snapshot().stage, false);

  // 节点一侧：旧办法的整房导入口在账号模式下关着，不收写入
  const cloudData = path.join(cloud.fixtureDir, 'doc');
  const hadStage = fs.existsSync(path.join(cloudData, 'secrets', 'relocation'));
  const binding = room.vault.host(room.descriptor);
  const door = await fetch(`${proxy.url}/hosting/relocation/import-init`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${binding.registrationKey}` },
    body: JSON.stringify({ roomId: room.rec.projectId, txnId: `move_${randomBytes(16).toString('hex')}`, target: { service: proxy.url, where: 'hosted', deviceId: null } }) });
  assert.equal(door.status, 403); assert.equal((await door.json()).error, 'account-required');
  assert.equal(fs.existsSync(path.join(cloudData, 'secrets', 'relocation')), hadStage, '导入口没有在云端留下搬迁暂存');
});

test('预检问不到节点：同样停在动手之前，本机房间不变', { timeout: 60_000 }, async t => {
  const [dead] = await freePorts(1);
  const room = await desktopRoom(t, { service: `http://127.0.0.1:${dead}` });
  const before = room.snapshot();
  const moved = await room.call('move-hosted');
  assert.equal(moved.status, 503); assert.deepEqual(moved.result, { ok: false, error: 'relocation-network' });
  assert.deepEqual(room.snapshot(), before);
  assert.equal(roomUnavailableReason(room.source.credentialStore.peek(room.rec.projectId)), null);
});

test('旧模式节点：搬到云端照旧走完，本机房间记为已搬走，云端拿到原房间', { timeout: 60_000 }, async t => {
  const root = temp(), options = { host: '127.0.0.1', docPort: 0, assetPort: 0, trustLoopback: false, clusterToken: key(), log: () => {} };
  const cloud = await startHostedCombo({ ...options, ...await hostedPorts(), dataDir: root, localDevice: { deviceId: 'isolated-cloud-device-01', deviceName: 'isolated-cloud' } });
  t.after(() => cloud.close());
  const service = `http://127.0.0.1:${cloud.docPort}`;
  const health = await (await fetch(`${service}/healthz`)).json();
  assert.equal(health.accountMode, undefined, '旧模式节点的健康检查不报账号模式');
  const room = await desktopRoom(t, { service, registerWith: service });
  const moved = await room.call('move-hosted');
  assert.equal(moved.status, 200, JSON.stringify(moved.result)); assert.equal(moved.result.ok, true);
  await waitFor(async () => (await room.call('move-status', { taskVersion: 3 })).result.state === 'complete', 30000, 'move complete');
  assert.equal(roomUnavailableReason(room.source.credentialStore.peek(room.rec.projectId)), 'relocated');
  assert.equal(roomUnavailableReason(cloud.credentialStore.peek(room.rec.projectId)), null);
  assert.ok(cloud.credentialStore.peek(room.rec.projectId), '云端拿到原房间');
});
