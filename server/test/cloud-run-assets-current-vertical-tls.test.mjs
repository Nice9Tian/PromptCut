import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { once } from 'node:events';
import { assetWiringPki } from './fixtures/asset-wiring-pki.mjs';
import { certificateFingerprint } from '../account/client.mjs';
import { createAssetRunClient } from '../hosted/asset-run-client.mjs';
import { createAssetObserverChannels } from '../hosted/run-assets-observer-binding.mjs';
import { createRunAssetMetadataRpc } from '../hosted/run-assets-metadata-rpc.mjs';
import { createRunAssetPrivateClient } from '../hosted/run-assets-metadata-client.mjs';
import { createRunAssetObserverAuthority } from '../hosted/run-assets-observer-authority.mjs';

const send = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
const close = server => new Promise(resolve => {
  if (!server?.listening) return resolve(); server.closeAllConnections?.(); server.close(resolve);
});

test('original asset TLS channel alone answers doc pinned challenge; current epoch gates old socket', { timeout: 45000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-run-assets-current-tls-'));
  const pki = assetWiringPki(dir), docPort = 6448, assetPort = 6449;
  const sockets = new Set(), closes = new Set(); let docServer, assetServer, client, privateClient, channels, docSocket;
  const track = server => server.on('secureConnection', socket => {
    sockets.add(socket); closes.add(new Promise(resolve => socket.once('close', () => { sockets.delete(socket); resolve(); })));
  });
  t.after(async () => {
    privateClient?.close(); await client?.close(); channels?.close();
    for (const socket of sockets) socket.destroy();
    await Promise.all([close(docServer), close(assetServer)]); await Promise.allSettled([...closes]);
    t.diagnostic(`doc-port=${docPort}; asset-port=${assetPort}; owned-tls-sockets=${sockets.size}; listeners=${Number(docServer?.listening === true) + Number(assetServer?.listening === true)}`);
    await fs.rm(dir, { recursive: true, force: true });
  });
  docServer = https.createServer({ ...pki.doc, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3' },
    (req, res) => {
      if (req.method === 'GET' && req.url === '/internal/v2/run-assets/events?after=0')
        return send(res, 200, { ok: true, result: { events: [], headSeq: 0 } });
      send(res, 404, { ok: false, code: 'no-route' });
    });
  track(docServer); docServer.on('secureConnection', socket => { if (!docSocket) docSocket = socket; });
  docServer.listen(docPort, '127.0.0.1'); await once(docServer, 'listening');
  channels = createAssetObserverChannels({ docFingerprint256: pki.doc.fingerprint256 });
  client = createAssetRunClient({ origin: `https://127.0.0.1:${docPort}`, tls: pki.asset,
    serverFingerprint256: pki.doc.fingerprint256, timeoutMs: 5000, maxResponseBytes: 4096,
    onObserverSocket: socket => channels.register(socket) });
  assert.equal((await client.eventsSince(0)).headSeq, 0);
  assert.equal(channels.size, 1);
  const instance = { instanceId: 'asset-root-one', bootId: '11111111-2222-3333-4444-555555555555',
    pid: process.pid, pidBirth: { bootId: '11111111-2222-3333-4444-555555555555', startTicks: '10001' },
    uid: 1050, unit: 'promptcut-asset.service', unitInvocationId: 'd'.repeat(32),
    cgroup: { v2Path: '/sys/fs/cgroup/system.slice/promptcut-asset.service', dev: '1001', ino: '4001',
      bootId: '11111111-2222-3333-4444-555555555555' }, serviceIdentity: 'asset-service',
    clientFingerprint256: certificateFingerprint(pki.asset.fingerprint256),
    serverFingerprint256: certificateFingerprint(pki.asset.fingerprint256) };
  const reservation = { v: 1, protocol: 'promptcut.asset-root-reservation.v1', authorityId: 'doc-one',
    serviceIdentity: instance.serviceIdentity, uid: instance.uid, unit: instance.unit,
    cgroupPath: instance.cgroup.v2Path, clientFingerprint256: instance.clientFingerprint256,
    serverFingerprint256: instance.serverFingerprint256, epoch: 1, instanceId: instance.instanceId };
  const lifecycle = { state: { serviceId: 'asset', state: 'running', serviceIdentity: instance.serviceIdentity,
    instanceId: instance.instanceId, fingerprint256: instance.clientFingerprint256,
    pid: process.pid, startedAt: Date.now() } };
  const rpc = createRunAssetMetadataRpc({ docFingerprint256: pki.doc.fingerprint256,
    internalServerCert: pki.asset.cert, lifecycle, projectStores: { project: () => undefined },
    rootReservation: reservation, observerChannels: channels });
  assetServer = https.createServer({ ...pki.asset, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3' },
    (req, res) => { void rpc.handler(req, res); });
  track(assetServer); assetServer.listen(assetPort, '127.0.0.1'); await once(assetServer, 'listening');
  privateClient = createRunAssetPrivateClient({ origin: `https://127.0.0.1:${assetPort}`,
    tls: pki.doc, serverFingerprint256: pki.asset.fingerprint256 });
  let accepted = false, epoch = 1;
  const checkpoint = { current() {
    if (!accepted) throw Object.assign(new Error('not-accepted'), { status: 503, code: 'asset-current-epoch-unaccepted' });
    return { authorityId: 'doc-one', epoch, recordDigest: epoch === 1 ? 'a'.repeat(64) : 'b'.repeat(64), instance };
  } };
  const authority = createRunAssetObserverAuthority({ checkpoint, privateClient,
    assetFingerprint256: pki.asset.fingerprint256 });
  assert.throws(() => authority.currentAsset({ socket: docSocket }), error => error.code === 'asset-current-epoch-unaccepted');
  accepted = true;
  await assert.rejects(privateClient.proveObserver({ challenge: 'abcdef0123456789abcdef0123456789',
    exporterDigest: '0'.repeat(64), epoch: 1, recordDigest: 'a'.repeat(64), docAuthorityId: 'doc-one',
    purpose: 'run-assets-observer-verify', instance }), error => error.code === 'asset-observer-binding-unavailable');
  assert.deepEqual(await authority.resolveObserver({ socket: docSocket }),
    { assetInstanceId: instance.instanceId, serviceIdentity: instance.serviceIdentity });
  assert.equal(authority.currentAsset({ socket: docSocket }).assetInstanceId, instance.instanceId);
  epoch = 2;
  assert.throws(() => authority.currentAsset({ socket: docSocket }), error => error.code === 'asset-observer-binding-unavailable');
  await assert.rejects(authority.resolveObserver({ socket: docSocket }), error =>
    ['run-asset-observer-forbidden', 'asset-observer-binding-unavailable'].includes(error.code));
  authority.close();
});
