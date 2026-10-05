import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { startHostedCombo } from '../hosted/combo.mjs';
import { buildAuthProtocols } from '../auth/client.mjs';
import { forgetCredentialStore } from '../auth/store.mjs';
import { mirrorOf } from '../hosting/host.mjs';
import { requestRelocation } from '../hosting/relocation-client.mjs';
import { discoverRoom, relayFetch, authorizeRelayAsset } from '../hosting/client.mjs';
import { createAssetClient } from '../asset-store/client.mjs';
import { prepareRelocationSnapshot, relocationFileStream, receiveRelocationIndex, receiveRelocationFile } from '../recovery/relocation-files.mjs';
import { transferRelocationToHosted } from '../recovery/relocation-transfer.mjs';
import { pullRelocationToLocal } from '../recovery/relocation-pull.mjs';
import { startHostingHost } from '../hosting/host.mjs';
import { roomUnavailableReason } from '../recovery/relocation.mjs';
import { wsClient, waitFor } from './fake-ws-kit.mjs';
import { hostedPorts } from './sp-kit.mjs';
const key = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pc-relocation-http-'));
const cred = username => ({ ...(username ? { username } : {}), salt: randomBytes(16).toString('base64url'), key: key() });
const assetsOf = c => Object.fromEntries(['media', 'snap', 'px'].map(ns => [ns, { root: path.join(c.paths.assets, ns), shard: true }]));
let seq = 0;
async function ask(client, body) { const reqId = `relocation-http-${++seq}`; client.send({ ...body, reqId }); return client.next(m => m.reqId === reqId); }
async function connect(base, rec, username, as, deviceId, route = null) {
  const credential = as === 'creator' ? rec.creator : rec.project;
  const protocols = await buildAuthProtocols({ base, projectId: rec.projectId, username, as, deviceId, deviceName: 'isolated-device', key: credential.key, ...(route ? { fetch: relayFetch(route.access) } : {}) });
  const client = wsClient(base.replace('http:', 'ws:'), [...protocols, ...(route ? [route.routeProtocol] : [])]); await client.opened; return client;
}
test('独立主机到真实云端 HTTP 迁移：部分传输后双方停止重开，自动暂存/确认/发布/激活，原成员中继双向编辑和三类票据读取', { timeout: 30000 }, async t => {
  const sourceRoot = temp(), cloudRoot = temp(), options = { host: '127.0.0.1', docPort: 0, assetPort: 0, trustLoopback: false, clusterToken: key(), log: () => {} };
  const startSource = async () => startHostedCombo({ ...options, ...await hostedPorts(), dataDir: sourceRoot });
  const startCloud = async docPort => startHostedCombo({ ...options, ...await hostedPorts(), ...(docPort ? { docPort } : {}), dataDir: cloudRoot, localDevice: { deviceId: 'isolated-cloud-device-01', deviceName: 'isolated-cloud' } });
  let source = await startSource(), cloud = await startCloud();
  t.after(async () => { await source.close(); await cloud.close(); });
  const service = `http://127.0.0.1:${cloud.docPort}`, cloudPort = cloud.docPort, device = 'isolated-original-host-01', registrationKey = key();
  const rec = source.credentialStore.create({ name: 'isolated-network-move', mode: 'free', kdf: { alg: 'pbkdf2-sha256', iter: 100000 }, creator: cred('host'), project: cred() });
  const host = await connect(`http://127.0.0.1:${source.docPort}`, rec, 'host', 'creator', device); t.after(() => host.close());
  await ask(host, { type: 'project.open', projectId: rec.projectId });
  await ask(host, { type: 'project.op', projectId: rec.projectId, opId: 'root', ops: [{ op: 'set', path: '', value: { id: 'same-content', name: 'latest', media: [], tracks: [] } }] });
  const ticket = await ask(host, { type: 'auth.ticket', kind: 'asset', access: 'rw' }), digests = {};
  const writer = createAssetClient({ base: source.assetPublicUrl, ticket: async () => ticket.ticket });
  for (const ns of ['media', 'snap', 'px']) { const bytes = randomBytes(50000); digests[ns] = hash(bytes); await writer.put(ns, bytes, { ext: 'bin' }); }
  const register = await fetch(`${service}/hosting/register`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${registrationKey}` }, body: JSON.stringify({ roomId: rec.projectId, deviceId: device, instance: key(), mirror: mirrorOf(rec) }) }); assert.equal(register.status, 200);
  const txnId = `move_${randomBytes(16).toString('hex')}`, target = { service, where: 'hosted', deviceId: null };
  let snapshot = prepareRelocationSnapshot({ dataDir: source.paths.docservice, store: source.credentialStore, roomId: rec.projectId, txnId, expectedEpoch: 1, target, assets: assetsOf(source) });
  const post = async (operation, body, secret = registrationKey) => {
    const response = await fetch(`${service}/hosting/relocation/import-${operation}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` }, body: JSON.stringify({ roomId: rec.projectId, txnId, ...body }) }); return { status: response.status, json: await response.json() };
  };
  assert.equal((await post('init', { target }, key())).status, 403); assert.equal((await post('init', { target: { ...target, service: 'https://untrusted.invalid' } })).status, 409);
  const initialized = await post('init', { target }); assert.equal(initialized.status, 200); assert.equal(Object.hasOwn(initialized.json, 'registrationKey'), false);
  const transaction = { roomId: rec.projectId, txnId, expectedEpoch: 1, target, manifest: snapshot.index.manifest, targetVerifier: initialized.json.targetVerifier };
  await requestRelocation({ service, trustedService: service, operation: 'begin', body: transaction, registrationKey });
  assert.equal((await post('index', { index: snapshot.index })).status, 200);
  const first = snapshot.index.entries[0], u = new URL(`${service}/hosting/relocation/import-file`); u.searchParams.set('roomId', rec.projectId); u.searchParams.set('txnId', txnId); u.searchParams.set('path', first.path);
  const partial = await fetch(u, { method: 'PUT', headers: { authorization: `Bearer ${registrationKey}`, 'content-length': String(first.size) }, body: relocationFileStream({ snapshot, relative: first.path }), duplex: 'half' }); assert.equal(partial.status, 200); await partial.arrayBuffer();
  await cloud.close(); forgetCredentialStore(cloud.paths.auth); await source.close(); forgetCredentialStore(source.paths.auth);
  cloud = await startCloud(cloudPort); source = await startSource();
  snapshot = prepareRelocationSnapshot({ dataDir: source.paths.docservice, store: source.credentialStore, roomId: rec.projectId, txnId, expectedEpoch: 1, target, assets: assetsOf(source) });
  const location = await transferRelocationToHosted({ snapshot, service, trustedService: service, registrationKey, store: source.credentialStore }); assert.equal(location.epoch, 2);
  assert.equal(roomUnavailableReason(source.credentialStore.peek(rec.projectId)), 'relocated'); assert.equal(roomUnavailableReason(cloud.credentialStore.peek(rec.projectId)), null);
  await waitFor(() => cloud.hosting.online(rec.projectId), 5000);
  const route = await discoverRoom({ service, roomId: rec.projectId, username: 'member', as: 'member', deviceId: 'isolated-member-device-01', key: rec.project.key }); assert.equal(route.where, 'hosted');
  const member = await connect(route.base, rec, 'member', 'member', 'isolated-member-device-01', route), creator = await connect(service, rec, 'host', 'creator', device); t.after(() => member.close()); t.after(() => creator.close());
  assert.equal((await ask(member, { type: 'project.open', projectId: rec.projectId })).rev, 1);
  assert.equal((await ask(member, { type: 'project.op', projectId: rec.projectId, opId: 'member-after', expectRev: 1, ops: [{ op: 'set', path: '/name', value: 'member-after' }] })).rev, 2);
  assert.equal((await ask(creator, { type: 'project.open', projectId: rec.projectId })).project.name, 'member-after');
  assert.equal((await ask(creator, { type: 'project.op', projectId: rec.projectId, opId: 'creator-after', expectRev: 2, ops: [{ op: 'set', path: '/name', value: 'creator-after' }] })).rev, 3);
  assert.equal((await ask(member, { type: 'project.open', projectId: rec.projectId })).project.name, 'creator-after');
  const fresh = await ask(member, { type: 'auth.ticket', kind: 'asset', access: 'r' }); await authorizeRelayAsset(route, fresh.ticket);
  const reader = createAssetClient({ base: route.asset, ticket: async () => fresh.ticket }); for (const ns of ['media', 'snap', 'px']) assert.equal(hash(Buffer.from(await reader.get(ns, digests[ns]))), digests[ns]);
  assert.equal((await post('activate', {}, key())).status, 403);
  assert.equal((await transferRelocationToHosted({ snapshot, service, trustedService: service, registrationKey, store: source.credentialStore })).epoch, 2, 'completed retry does not generate another key, room or epoch');
  await cloud.close(); forgetCredentialStore(cloud.paths.auth); cloud = await startCloud(cloudPort);
  await waitFor(() => cloud.hosting.online(rec.projectId), 5000);
  const final = await connect(service, rec, 'member', 'member', 'isolated-member-device-01'); t.after(() => final.close()); assert.equal((await ask(final, { type: 'project.open', projectId: rec.projectId })).rev, 3);
});
for (const roundtrip of [false, true]) test(`${roundtrip ? '本机→云端→原本机往返' : '原生云端→本机：部分传输后双方停止重开'}：真实 HTTP 源成员授权和完整安装，原版本/身份保留，云端旧主机封锁`, { timeout: 30000 }, async t => {
  const cloudRoot = temp(), targetRoot = temp(), device = { deviceId: 'isolated-destination-001', deviceName: 'isolated-destination' };
  const options = { host: '127.0.0.1', trustLoopback: false, clusterToken: key(), log: () => {} };
  let cloud = await startHostedCombo({ ...options, ...await hostedPorts(), dataDir: cloudRoot, localDevice: { deviceId: 'isolated-source-cloud-01', deviceName: 'isolated-cloud' } });
  let target = await startHostedCombo({ ...options, ...await hostedPorts(), dataDir: targetRoot, localDevice: device });
  t.after(async () => { await cloud.close(); await target.close(); });
  const service = `http://127.0.0.1:${cloud.docPort}`, cloudPort = cloud.docPort, source = roundtrip ? target : cloud;
  const rec = source.credentialStore.create({ name: 'isolated-roundtrip-room', mode: 'free', kdf: { alg: 'pbkdf2-sha256', iter: 100000 }, creator: cred('host'), project: cred() });
  const writer = await connect(`http://127.0.0.1:${source.docPort}`, rec, 'host', 'creator', device.deviceId); t.after(() => writer.close());
  await ask(writer, { type: 'project.open', projectId: rec.projectId });
  const ticket = await ask(writer, { type: 'auth.ticket', kind: 'asset', access: 'rw' }), digests = {};
  const asset = createAssetClient({ base: source.assetPublicUrl, ticket: async () => ticket.ticket });
  for (const ns of ['media', 'snap', 'px']) { const bytes = randomBytes(50000); digests[ns] = hash(bytes); await asset.put(ns, bytes, { ext: 'bin' }); }
  await ask(writer, { type: 'project.op', projectId: rec.projectId, opId: 'root', ops: [{ op: 'set', path: '', value: { id: 'unchanged-content', name: 'before-move', media: [{ id: 'media', kind: 'video', hash: digests.media, url: `/@media/${digests.media}`, tiers: { original: digests.media, small: digests.media } }], tracks: [] } }] });
  if (roundtrip) {
    const registrationKey = key();
    assert.equal((await fetch(`${service}/hosting/register`, { method: 'POST', headers: { authorization: `Bearer ${registrationKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ roomId: rec.projectId, deviceId: device.deviceId, instance: key(), mirror: mirrorOf(rec) }) })).status, 200);
    const snapshot = prepareRelocationSnapshot({ dataDir: target.paths.docservice, store: target.credentialStore, roomId: rec.projectId, txnId: `move_${randomBytes(16).toString('hex')}`, expectedEpoch: 1, target: { service, where: 'hosted', deviceId: null }, assets: assetsOf(target) });
    await transferRelocationToHosted({ snapshot, service, trustedService: service, registrationKey, store: target.credentialStore });
    const latest = await connect(service, rec, 'member', 'member', 'isolated-cloud-member-01'); t.after(() => latest.close()); await ask(latest, { type: 'project.open', projectId: rec.projectId });
    assert.equal((await ask(latest, { type: 'project.op', projectId: rec.projectId, opId: 'cloud-latest', expectRev: 1, ops: [{ op: 'set', path: '/name', value: 'cloud-latest' }] })).rev, 2);
  }
  const move = { descriptor: { version: 1, roomId: rec.projectId, service, where: 'hosted' }, txnId: `move_${randomBytes(16).toString('hex')}`, registrationKey: key(), sourceCapability: key() };
  const identity = { as: 'member', username: 'member', key: rec.project.key, candidate: { projectId: rec.projectId, service, base: service, where: 'hosted' } };
  await assert.rejects(() => pullRelocationToLocal({ dataDir: target.paths.docservice, store: target.credentialStore, assets: assetsOf(target), reloadSpace: target.service.reloadSpace, move: { ...move, descriptor: { ...move.descriptor, service: 'https://untrusted.invalid' } }, identity, device }), e => e.reason === 'auth');
  if (!roundtrip) {
    const protocols = await buildAuthProtocols({ base: service, projectId: rec.projectId, username: identity.username, as: identity.as,
      key: identity.key, deviceId: device.deviceId, deviceName: device.deviceName });
    const begin = await fetch(`${service}/hosting/relocation/export-start`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${move.sourceCapability}` },
      body: JSON.stringify({ roomId: rec.projectId, txnId: move.txnId, target: { service, where: 'lan', deviceId: device.deviceId },
        targetVerifier: hash(move.registrationKey), sourceCapability: move.sourceCapability, protocols }) });
    assert.equal(begin.status, 200); const authority = await begin.json();
    const url = new URL(`${service}/hosting/relocation/export-index`); url.searchParams.set('roomId', rec.projectId); url.searchParams.set('txnId', move.txnId);
    const indexResponse = await fetch(url, { headers: { authorization: `Bearer ${move.sourceCapability}` } }); assert.equal(indexResponse.status, 200);
    const stage = receiveRelocationIndex({ dataDir: target.paths.docservice, index: (await indexResponse.json()).index, authority });
    const first = stage.index.entries[0]; url.pathname = '/hosting/relocation/export-file'; url.searchParams.set('path', first.path);
    const partial = await fetch(url, { headers: { authorization: `Bearer ${move.sourceCapability}` } }); assert.equal(partial.status, 200);
    await receiveRelocationFile({ dataDir: target.paths.docservice, txnId: move.txnId, relative: first.path, stream: Readable.fromWeb(partial.body) });
    assert.equal(roomUnavailableReason(cloud.credentialStore.peek(rec.projectId)), 'relocating');
    await cloud.close(); forgetCredentialStore(cloud.paths.auth); await target.close(); forgetCredentialStore(target.paths.auth);
    cloud = await startHostedCombo({ ...options, ...await hostedPorts(), docPort: cloudPort, dataDir: cloudRoot, localDevice: { deviceId: 'isolated-source-cloud-01', deviceName: 'isolated-cloud' } });
    target = await startHostedCombo({ ...options, ...await hostedPorts(), dataDir: targetRoot, localDevice: device });
    assert.equal(roomUnavailableReason(cloud.credentialStore.peek(rec.projectId)), 'relocating');
    // The old source now refuses fresh member challenges. The persisted
    // transaction capability must resume the same partially received snapshot.
    await assert.rejects(() => buildAuthProtocols({ base: service, projectId: rec.projectId, username: identity.username, as: identity.as,
      key: identity.key, deviceId: device.deviceId, deviceName: device.deviceName }), e => e.reason === 'relocating');
  }
  const location = await pullRelocationToLocal({ dataDir: target.paths.docservice, store: target.credentialStore, assets: assetsOf(target), reloadSpace: target.service.reloadSpace, move, identity, device }); assert.equal(location.epoch, roundtrip ? 3 : 2);
  assert.equal(roomUnavailableReason(cloud.credentialStore.peek(rec.projectId)), 'relocated'); assert.equal(roomUnavailableReason(target.credentialStore.peek(rec.projectId)), null);
  const oldChallenge = await fetch(`${service}/shared/challenge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: rec.projectId, username: 'member', as: 'member', deviceId: device.deviceId }) }); assert.equal(oldChallenge.status, 409);
  const worker = startHostingHost({ service, roomId: rec.projectId, hostKey: move.registrationKey, deviceId: device.deviceId, instance: key(), record: () => target.credentialStore.peek(rec.projectId), docBase: `http://127.0.0.1:${target.docPort}`, assetBase: `http://127.0.0.1:${target.assetPort}`, state: () => {} }); t.after(() => worker.stop()); await waitFor(() => cloud.hosting.online(rec.projectId), 5000);
  const route = await discoverRoom({ service, roomId: rec.projectId, username: 'member', as: 'member', key: rec.project.key, deviceId: 'isolated-other-member-01' }); assert.equal(route.where, 'lan');
  const member = await connect(route.base, rec, 'member', 'member', 'isolated-other-member-01', route), host = await connect(`http://127.0.0.1:${target.docPort}`, rec, 'host', 'creator', device.deviceId); t.after(() => member.close()); t.after(() => host.close());
  const expectedRev = roundtrip ? 2 : 1; assert.equal((await ask(member, { type: 'project.open', projectId: rec.projectId })).rev, expectedRev);
  assert.equal((await ask(member, { type: 'project.op', projectId: rec.projectId, opId: 'member-back', expectRev: expectedRev, ops: [{ op: 'set', path: '/name', value: 'member-back' }] })).rev, expectedRev + 1);
  assert.equal((await ask(host, { type: 'project.open', projectId: rec.projectId })).project.name, 'member-back');
  assert.equal((await ask(host, { type: 'project.op', projectId: rec.projectId, opId: 'host-back', expectRev: expectedRev + 1, ops: [{ op: 'set', path: '/name', value: 'host-back' }] })).rev, expectedRev + 2);
  assert.equal((await ask(member, { type: 'project.open', projectId: rec.projectId })).project.name, 'host-back');
  const fresh = await ask(member, { type: 'auth.ticket', kind: 'asset', access: 'r' }); await authorizeRelayAsset(route, fresh.ticket);
  const reader = createAssetClient({ base: route.asset, ticket: async () => fresh.ticket }); for (const ns of ['media', 'snap', 'px']) assert.equal(hash(Buffer.from(await reader.get(ns, digests[ns]))), digests[ns]);
  assert.equal((await pullRelocationToLocal({ dataDir: target.paths.docservice, store: target.credentialStore, assets: assetsOf(target), reloadSpace: target.service.reloadSpace, move, identity, device })).epoch, location.epoch);
  assert.equal((await ask(member, { type: 'project.open', projectId: rec.projectId })).project.name, 'host-back', 'completed retry preserves later edits');
  await worker.stop(); member.close(); host.close(); await cloud.close(); forgetCredentialStore(cloud.paths.auth); await target.close(); forgetCredentialStore(target.paths.auth);
  cloud = await startHostedCombo({ ...options, ...await hostedPorts(), docPort: cloudPort, dataDir: cloudRoot, localDevice: { deviceId: 'isolated-source-cloud-01', deviceName: 'isolated-cloud' } }); target = await startHostedCombo({ ...options, ...await hostedPorts(), dataDir: targetRoot, localDevice: device });
  assert.equal(roomUnavailableReason(cloud.credentialStore.peek(rec.projectId)), 'relocated'); assert.equal(roomUnavailableReason(target.credentialStore.peek(rec.projectId)), null);
  const reopened = await connect(`http://127.0.0.1:${target.docPort}`, rec, 'member', 'member', 'isolated-other-member-01'); t.after(() => reopened.close()); assert.equal((await ask(reopened, { type: 'project.open', projectId: rec.projectId })).rev, expectedRev + 2);
});
