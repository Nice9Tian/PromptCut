import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { startHostedCombo } from '../hosted/combo.mjs';
import { createHostingService } from '../hosting/service.mjs';
import { startHostingHost, mirrorOf } from '../hosting/host.mjs';
import { requestRelocation } from '../hosting/relocation-client.mjs';
import { discoverRoom, relayFetch, authorizeRelayAsset } from '../hosting/client.mjs';
import { buildAuthProtocols } from '../auth/client.mjs';
import { createAssetClient } from '../asset-store/client.mjs';
import { forgetCredentialStore } from '../auth/store.mjs';
import { issueInvite } from '../auth/invite.mjs';
import { markRoomMoved, roomUnavailableReason } from '../recovery/relocation.mjs';
import { prepareRelocationSnapshot, copyRelocationStage, loadRelocationStage, installRelocationStage, activateRelocationStage } from '../recovery/relocation-files.mjs';
import { wsClient, waitFor } from './fake-ws-kit.mjs';
import { hostedPorts, freePorts } from './sp-kit.mjs';

const key = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
const cred = username => ({ ...(username ? { username } : {}), salt: randomBytes(16).toString('base64url'), key: key() });
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pc-relocation-files-'));
const assetsOf = c => Object.fromEntries(['media', 'snap', 'px'].map(ns => [ns, { root: path.join(c.paths.assets, ns), shard: true }]));
const start = async dataDir => startHostedCombo({ dataDir, ...await hostedPorts(), host: '127.0.0.1', trustLoopback: false, clusterToken: key(), log: () => {} });
let seq = 0;
async function ask(c, body) {
  const reqId = `move-files-${++seq}`; c.send({ ...body, reqId });
  try { return await c.next(m => m.reqId === reqId); } catch { throw new Error('Isolated relocation reply timeout; secrets omitted'); }
}
async function connect(c, rec, username, as, deviceId, candidate = null) {
  const base = candidate?.base ?? `http://127.0.0.1:${c.docPort}`;
  const credential = as === 'creator' ? rec.creator : rec.mode === 'free' ? rec.project : rec.list.find(e => e.username === username);
  const protocols = await buildAuthProtocols({ base, ...(candidate ? { fetch: relayFetch(candidate.access) } : {}), projectId: rec.projectId, username, as, key: credential.key, deviceId, deviceName: 'isolated-device' });
  const client = wsClient(base.replace('http:', 'ws:'), [...protocols, ...(candidate ? [candidate.routeProtocol] : [])]); await client.opened; return client;
}
async function snapshotFixture(t) {
  const source = await start(temp()); t.after(() => source.close());
  const rec = source.credentialStore.create({ name: 'isolated-stage-failure', mode: 'free', kdf: { alg: 'pbkdf2-sha256', iter: 100000 }, creator: cred('host'), project: cred() });
  const client = await connect(source, rec, 'host', 'creator', 'isolated-source-device-01'); t.after(() => client.close());
  await ask(client, { type: 'project.open', projectId: rec.projectId });
  const bytes = randomBytes(9000), digest = hash(bytes), ticket = await ask(client, { type: 'auth.ticket', kind: 'asset', access: 'rw' });
  await createAssetClient({ base: source.assetPublicUrl, ticket: async () => ticket.ticket }).put('media', bytes, { ext: 'bin' });
  await ask(client, { type: 'project.op', projectId: rec.projectId, opId: 'root', ops: [{ op: 'set', path: '', value: { id: 'content-stable', name: 'stage-latest', media: [{ id: 'material', kind: 'image', hash: digest, url: `/@media/${digest}` }], tracks: [] } }] });
  const txnId = `move_${randomBytes(16).toString('hex')}`, destination = { service: 'https://isolated-authority.invalid', where: 'hosted', deviceId: null };
  const snapshot = prepareRelocationSnapshot({ dataDir: source.paths.docservice, store: source.credentialStore, roomId: rec.projectId, txnId, expectedEpoch: 1, target: destination, assets: assetsOf(source) });
  return { source, rec, snapshot, bytes, digest, txnId };
}
for (const fault of ['before-doc-rename', 'after-doc-rename', 'asset-copy']) test(`目标安装中断 ${fault}：保持不可接入，实际服务重开后同事务补齐并激活`, { timeout: 20000 }, async t => {
  const f = await snapshotFixture(t), targetRoot = temp(); let target = await start(targetRoot); t.after(() => target.close());
  let stage = copyRelocationStage({ snapshot: f.snapshot, dataDir: target.paths.docservice });
  const rename = fs.renameSync, copy = fs.copyFileSync; let injected = false;
  try {
    fs.renameSync = (a, b) => {
      if (!injected && b === path.join(target.paths.tenants, f.rec.projectId) && fault !== 'asset-copy') {
        injected = true; if (fault === 'after-doc-rename') rename(a, b);
        throw Object.assign(new Error('isolated installation interruption'), { code: 'ENOSPC' });
      }
      return rename(a, b);
    };
    fs.copyFileSync = (a, b, flags) => {
      if (!injected && fault === 'asset-copy' && b.startsWith(target.paths.assets + path.sep)) { injected = true; throw Object.assign(new Error('isolated material interruption'), { code: 'ENOSPC' }); }
      return copy(a, b, flags);
    };
    assert.throws(() => installRelocationStage({ stage, dataDir: target.paths.docservice, store: target.credentialStore, assets: assetsOf(target), reloadSpace: target.service.reloadSpace }), e => e.code === 'ENOSPC');
  } finally { fs.renameSync = rename; fs.copyFileSync = copy; }
  assert.equal(injected, true); assert.equal(roomUnavailableReason(target.credentialStore.peek(f.rec.projectId)), 'relocating');
  assert.throws(() => activateRelocationStage({ stage, dataDir: target.paths.docservice, store: target.credentialStore, assets: assetsOf(target), authority: { roomId: f.rec.projectId, txnId: f.txnId, epoch: 2, target: stage.index.target, manifest: stage.index.manifest } }));
  await target.close(); forgetCredentialStore(target.paths.auth); target = await start(targetRoot); stage = loadRelocationStage({ dataDir: target.paths.docservice, txnId: f.txnId });
  assert.equal(roomUnavailableReason(target.credentialStore.peek(f.rec.projectId)), 'relocating');
  const installed = installRelocationStage({ stage, dataDir: target.paths.docservice, store: target.credentialStore, assets: assetsOf(target), reloadSpace: target.service.reloadSpace });
  activateRelocationStage({ stage, dataDir: target.paths.docservice, store: target.credentialStore, assets: assetsOf(target), authority: installed });
  const member = await connect(target, f.rec, 'member', 'member', 'isolated-member-device-01'); t.after(() => member.close());
  assert.equal((await ask(member, { type: 'project.open', projectId: f.rec.projectId })).project.name, 'stage-latest');
  const ticket = await ask(member, { type: 'auth.ticket', kind: 'asset', access: 'r' }); assert.equal(hash(Buffer.from(await createAssetClient({ base: target.assetPublicUrl, ticket: async () => ticket.ticket }).get('media', f.digest))), f.digest);
});
test('项目引用的素材原尺寸/小尺寸缺失单独报告，保留身份与可编辑源房间，不生成半完成暂存', async t => {
  const source = await start(temp()); t.after(() => source.close());
  const rec = source.credentialStore.create({ name: 'isolated-missing-material', mode: 'free', kdf: { alg: 'pbkdf2-sha256', iter: 100000 }, creator: cred('host'), project: cred() });
  const client = await connect(source, rec, 'host', 'creator', 'isolated-source-device-01'); t.after(() => client.close());
  await ask(client, { type: 'project.open', projectId: rec.projectId });
  await ask(client, { type: 'project.op', projectId: rec.projectId, opId: 'root', ops: [{ op: 'set', path: '', value: { name: 'kept', media: [{ hash: hash('missing-original'), tiers: { original: hash('missing-original'), small: hash('missing-small') } }], tracks: [] } }] });
  const before = JSON.stringify(source.credentialStore.peek(rec.projectId)), txnId = `move_${randomBytes(16).toString('hex')}`;
  assert.throws(() => prepareRelocationSnapshot({ dataDir: source.paths.docservice, store: source.credentialStore, roomId: rec.projectId, txnId, expectedEpoch: 1, target: { service: 'https://isolated-authority.invalid', where: 'hosted', deviceId: null }, assets: assetsOf(source) }), e => e.reason === 'relocation-materials-missing' && e.missingCount === 2);
  assert.equal(JSON.stringify(source.credentialStore.peek(rec.projectId)), before); assert.equal(fs.existsSync(path.join(source.paths.docservice, 'relocation', txnId, 'index.json')), false);
  assert.equal((await ask(client, { type: 'project.op', projectId: rec.projectId, opId: 'still-writable', ops: [{ op: 'set', path: '/name', value: 'still-writable' }] })).rev, 2);
});
test('篡改暂存文档路径或素材字节在目标凭证安装前拒绝，原暂存与目标保留', async t => {
  const f = await snapshotFixture(t), target = await start(temp()); t.after(() => target.close());
  const stage = copyRelocationStage({ snapshot: f.snapshot, dataDir: target.paths.docservice }), file = path.join(stage.root, 'index.json'), original = fs.readFileSync(file);
  const corrupt = structuredClone(stage.index); corrupt.entries.find(e => e.path.startsWith('doc/')).path = 'doc/../../escape'; fs.writeFileSync(file, JSON.stringify(corrupt));
  assert.throws(() => installRelocationStage({ stage: { root: stage.root, index: corrupt }, dataDir: target.paths.docservice, store: target.credentialStore, assets: assetsOf(target) }), e => e.reason === 'bad-relocation-path');
  assert.equal(target.credentialStore.peek(f.rec.projectId), null); fs.writeFileSync(file, original);
  const asset = stage.index.entries.find(e => e.path.startsWith('assets/')); fs.appendFileSync(path.join(stage.root, ...asset.path.split('/')), 'tampered');
  assert.throws(() => installRelocationStage({ stage, dataDir: target.paths.docservice, store: target.credentialStore, assets: assetsOf(target) }), e => e.reason === 'relocation-data-changed'); assert.equal(target.credentialStore.peek(f.rec.projectId), null);
});
for (const where of ['lan', 'hosted']) test(`完整服务数据 ${where}：实际暂存、重开、可信发布后保留原身份/版本/邀请，双向编辑与三类票据素材`, { timeout: 20000 }, async t => {
  const sourceRoot = temp(), targetRoot = temp(), directoryRoot = temp();
  let source = await start(sourceRoot), target = await start(targetRoot), directory = createHostingService({ dir: directoryRoot });
  const address = await directory.listen((await freePorts(1))[0]), service = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await source.close(); await target.close(); await directory.close(); });
  const rec = source.credentialStore.create({ name: 'isolated-complete-move', mode: 'restricted', kdf: { alg: 'pbkdf2-sha256', iter: 100000 }, creator: cred('host'), list: [cred('member')] });
  const roomId = rec.projectId, device = 'source-original-device-01', targetDevice = 'destination-device-0001', hostKey = key(), targetKey = key();
  const original = await connect(source, rec, 'host', 'creator', device); t.after(() => original.close());
  await ask(original, { type: 'project.open', projectId: roomId });
  assert.equal((await ask(original, { type: 'project.op', projectId: roomId, opId: 'initial', ops: [{ op: 'set', path: '', value: { id: 'content-stable', name: 'initial', media: [], tracks: [] } }] })).rev, 1);
  assert.equal((await ask(original, { type: 'project.op', projectId: roomId, opId: 'latest-before-move', ops: [{ op: 'set', path: '/name', value: 'authoritative-latest' }] })).rev, 2);
  const issued = await ask(original, { type: 'auth.ticket', kind: 'asset', access: 'rw' }); assert.equal(issued.type, 'auth.ticket.ok');
  const asset = createAssetClient({ base: source.assetPublicUrl, ticket: async () => issued.ticket }), hashes = {};
  for (const ns of ['media', 'snap', 'px']) { const bytes = randomBytes(50000); hashes[ns] = hash(bytes); assert.equal((await asset.put(ns, bytes, { ext: 'bin' })).hash, hashes[ns]); }
  assert.equal((await ask(original, { type: 'project.op', projectId: roomId, opId: 'material-reference', ops: [{ op: 'set', path: '/media', value: [{ id: 'isolated-media', kind: 'video', name: 'isolated.bin', hash: hashes.media, url: `/@media/${hashes.media}`, tiers: { original: hashes.media, small: hashes.media } }] }] })).rev, 3);
  const invitation = issueInvite(source.credentialStore.serverSecret, { expiresInSec: 10000, maxUses: 3 }, Date.now());
  source.credentialStore.update(roomId, d => { d.invite = invitation.invite; d.bans = [{ username: 'removed', deviceId: 'removed-device-000001' }]; });
  const tenant = path.join(source.paths.tenants, roomId);
  for (const ns of ['content', 'events', 'costs']) {
    fs.mkdirSync(path.join(tenant, ns), { recursive: true }); fs.writeFileSync(path.join(tenant, ns, 'isolated.ndjson'), JSON.stringify({ kind: ns, revision: 2, value: 'retained-service-state' }) + '\n');
  }
  const worker = startHostingHost({ service, roomId, hostKey, deviceId: device, instance: key(), record: () => source.credentialStore.peek(roomId), docBase: `http://127.0.0.1:${source.docPort}`, assetBase: `http://127.0.0.1:${source.assetPort}`, state: () => {}, renewMs: 1000 });
  t.after(() => worker.stop()); await waitFor(() => directory.online(roomId), 5000);
  const oldRoute = await discoverRoom({ service, roomId, username: 'member', as: 'member', deviceId: 'member-original-device-01', key: rec.list[0].key });
  await authorizeRelayAsset(oldRoute, issued.ticket);
  const txnId = `move_${randomBytes(16).toString('hex')}`, destination = { service, where, deviceId: where === 'lan' ? targetDevice : null };
  let snapshot = prepareRelocationSnapshot({ dataDir: source.paths.docservice, store: source.credentialStore, roomId, txnId, expectedEpoch: 1, target: destination, assets: assetsOf(source) });
  assert.equal(snapshot.index.manifest.rev, 3); assert.equal(roomUnavailableReason(source.credentialStore.peek(roomId)), 'relocating');
  assert.equal((await ask(original, { type: 'project.op', projectId: roomId, opId: 'too-late', ops: [{ op: 'set', path: '/name', value: 'must-not-land' }] })).reason, 'relocating');
  let stage = copyRelocationStage({ snapshot, dataDir: target.paths.docservice });
  const transaction = { roomId, txnId, expectedEpoch: 1, target: destination, manifest: snapshot.index.manifest, targetVerifier: hash(targetKey) };
  const post = async (route, body, secret = hostKey) => {
    if (route.startsWith('relocation/')) {
      try { return { status: 200, json: await requestRelocation({ service, trustedService: service, operation: route.slice(11), body, registrationKey: secret }) }; }
      catch (e) { return { status: e.status, json: { error: e.reason } }; }
    }
    const r = await fetch(`${service}/hosting/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() };
  };
  assert.equal((await post('relocation/begin', transaction)).status, 200);
  assert.equal((await fetch(`${oldRoute.asset}/media/${hashes.media}`, { headers: { authorization: `Bearer ${issued.ticket}` } })).status, 401, 'old gateway grant is revoked immediately');
  const installed = installRelocationStage({ stage, dataDir: target.paths.docservice, store: target.credentialStore, assets: assetsOf(target), reloadSpace: target.service.reloadSpace });
  assert.equal(roomUnavailableReason(target.credentialStore.peek(roomId)), 'relocating');
  const challenge = async combo => fetch(`http://127.0.0.1:${combo.docPort}/shared/challenge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: roomId, username: 'host', as: 'creator', deviceId: targetDevice }) });
  assert.equal((await challenge(target)).status, 503);
  assert.throws(() => activateRelocationStage({ stage, dataDir: target.paths.docservice, store: target.credentialStore, assets: assetsOf(target), authority: { ...installed, epoch: 1 } }), e => e.reason === 'relocation-conflict');
  assert.equal((await post('relocation/publish', transaction)).status, 409);
  await target.close(); forgetCredentialStore(target.paths.auth); target = await start(targetRoot);
  stage = loadRelocationStage({ dataDir: target.paths.docservice, txnId });
  assert.equal((await challenge(target)).status, 503); assert.equal(installRelocationStage({ stage, dataDir: target.paths.docservice, store: target.credentialStore, assets: assetsOf(target), reloadSpace: target.service.reloadSpace }).epoch, 2);
  await source.close(); forgetCredentialStore(source.paths.auth); source = await start(sourceRoot);
  snapshot = prepareRelocationSnapshot({ dataDir: source.paths.docservice, store: source.credentialStore, roomId, txnId, expectedEpoch: 1, target: destination, assets: assetsOf(source) });
  assert.equal(snapshot.index.manifest.rev, 3);
  assert.equal((await post('relocation/ready', { ...installed, deviceId: targetDevice }, targetKey)).status, 200);
  await directory.close(); directory = createHostingService({ dir: directoryRoot, authorityService: service }); await directory.listen(address.port);
  const published = await post('relocation/publish', transaction); assert.equal(published.status, 200);
  activateRelocationStage({ stage, dataDir: target.paths.docservice, store: target.credentialStore, assets: assetsOf(target), authority: published.json.location });
  markRoomMoved({ store: source.credentialStore, roomId, authority: published.json.location });
  assert.equal(roomUnavailableReason(source.credentialStore.peek(roomId)), 'relocated');
  assert.equal(target.credentialStore.peek(roomId).creator.key === rec.creator.key, true); assert.equal(target.credentialStore.peek(roomId).list[0].key === rec.list[0].key, true);
  assert.equal(target.credentialStore.peek(roomId).bans.length, 1); assert.equal((await challenge(source)).status, 409);
  const next = startHostingHost({ service, roomId, hostKey: targetKey, deviceId: targetDevice, instance: key(), record: () => target.credentialStore.peek(roomId), docBase: `http://127.0.0.1:${target.docPort}`, assetBase: `http://127.0.0.1:${target.assetPort}`, state: () => {}, renewMs: 500 });
  t.after(() => next.stop()); await waitFor(() => directory.online(roomId), 5000);
  const route = await discoverRoom({ service, roomId, username: 'member', as: 'member', deviceId: 'member-original-device-01', key: rec.list[0].key }); assert.equal(route.where, where);
  const member = await connect(target, rec, 'member', 'member', 'member-original-device-01', route), host = await connect(target, rec, 'host', 'creator', device); t.after(() => member.close()); t.after(() => host.close());
  assert.equal((await ask(member, { type: 'project.open', projectId: roomId })).project.name, 'authoritative-latest');
  assert.equal((await ask(member, { type: 'project.op', projectId: roomId, opId: 'member-after-move', expectRev: 3, ops: [{ op: 'set', path: '/name', value: 'member-after-move' }] })).rev, 4);
  assert.equal((await ask(host, { type: 'project.open', projectId: roomId })).project.name, 'member-after-move');
  assert.equal((await ask(host, { type: 'project.op', projectId: roomId, opId: 'host-after-move', expectRev: 4, ops: [{ op: 'set', path: '/name', value: 'host-after-move' }] })).rev, 5);
  assert.equal((await ask(member, { type: 'project.open', projectId: roomId })).project.name, 'host-after-move');
  const ticket = await ask(member, { type: 'auth.ticket', kind: 'asset', access: 'r' }); await authorizeRelayAsset(route, ticket.ticket);
  const reads = createAssetClient({ base: route.asset, ticket: async () => ticket.ticket }); for (const ns of ['media', 'snap', 'px']) assert.equal(hash(Buffer.from(await reads.get(ns, hashes[ns]))), hashes[ns]);
  assert.equal((await fetch(`${target.assetPublicUrl}/media/${hashes.media}`, { headers: { authorization: `Bearer ${issued.ticket}` } })).status, 401, 'source generation tickets do not work at destination');
  const invite = await fetch(`http://127.0.0.1:${target.docPort}/shared/invite/resolve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: invitation.code }) }); assert.equal(invite.status, 200);
  for (const ns of ['content', 'events', 'costs']) assert.equal(hash(fs.readFileSync(path.join(target.paths.tenants, roomId, ns, 'isolated.ndjson'))), hash(fs.readFileSync(path.join(tenant, ns, 'isolated.ndjson'))));
  assert.equal((await post('register', { roomId, deviceId: device, instance: key(), mirror: mirrorOf(source.credentialStore.peek(roomId)) })).status, 403);
  await next.stop(); member.close(); host.close();
  await target.close(); forgetCredentialStore(target.paths.auth); target = await start(targetRoot);
  await source.close(); forgetCredentialStore(source.paths.auth); source = await start(sourceRoot);
  assert.equal((await challenge(source)).status, 409); assert.equal(roomUnavailableReason(target.credentialStore.peek(roomId)), null);
  const reopened = await connect(target, rec, 'member', 'member', 'member-original-device-01'); t.after(() => reopened.close());
  const latest = await ask(reopened, { type: 'project.open', projectId: roomId }); assert.equal(latest.rev, 5); assert.equal(latest.project.name, 'host-after-move'); assert.equal(latest.project.media[0].hash, hashes.media);
  const fresh = await ask(reopened, { type: 'auth.ticket', kind: 'asset', access: 'r' }); const finalReads = createAssetClient({ base: target.assetPublicUrl, ticket: async () => fresh.ticket });
  for (const ns of ['media', 'snap', 'px']) assert.equal(hash(Buffer.from(await finalReads.get(ns, hashes[ns]))), hashes[ns]);
});
