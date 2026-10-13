import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { assetWiringPki } from './fixtures/asset-wiring-pki.mjs';
import { certificateFingerprint } from '../account/client.mjs';
import { startHostedAssetService } from '../hosted/asset-runtime.mjs';
import { createRunAssetPrivateClient } from '../hosted/run-assets-metadata-client.mjs';

const send = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json', connection: 'close' }); res.end(JSON.stringify(value)); };
const close = server => new Promise(resolve => { if (!server?.listening) return resolve(); server.closeAllConnections?.(); server.close(resolve); });

test('actual asset runtime serves pinned doc-only physical metadata; no run data or synthetic closure', { timeout: 45000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-gcentral-private-tls-'));
  const pki = assetWiringPki(dir), assetDir = path.join(dir, 'asset'); await fs.mkdir(assetDir);
  const sockets = new Set(), socketCloses = new Set(); let docServer, service, privateClient, docPort, internalPort;
  const track = server => server.on('secureConnection', socket => {
    sockets.add(socket); const done = once(socket, 'close').then(() => sockets.delete(socket)); socketCloses.add(done);
  });
  t.after(async () => {
    privateClient?.close(); await service?.close(); await close(docServer);
    for (const socket of sockets) socket.destroy(); await Promise.all([...socketCloses]);
    t.diagnostic(`doc-port=${docPort}; asset-private-port=${internalPort}; owned-tls-sockets=${sockets.size}; doc-listening=${docServer?.listening === true}`);
    await fs.rm(dir, { recursive: true, force: true });
  });
  docServer = https.createServer({ ...pki.doc, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3' }, (req, res) => {
    if (certificateFingerprint(req.socket.getPeerCertificate()?.fingerprint256) !== certificateFingerprint(pki.asset.fingerprint256))
      return send(res, 403, { ok: false, code: 'service-forbidden' });
    if (req.method === 'GET' && req.url === '/internal/v2/access/events?after=0')
      return send(res, 200, { ok: true, headSeq: 0, events: [] });
    send(res, 503, { ok: false, code: 'unexpected-doc-route' });
  });
  docPort = 6440; internalPort = 6442;
  track(docServer); docServer.listen(docPort, '127.0.0.1'); await once(docServer, 'listening');
  service = await startHostedAssetService({ dataDir: assetDir, host: '127.0.0.1', port: 6441, internalPort,
    serviceIdentity: 'asset-service-test', pollMs: 60000,
    doc: { authorityId: 'gcentral-doc', origin: `https://127.0.0.1:${docPort}`,
      tls: pki.asset, serverFingerprint256: pki.doc.fingerprint256 },
    internalTls: pki.asset, docFingerprint256: pki.doc.fingerprint256 });
  privateClient = createRunAssetPrivateClient({ origin: `https://127.0.0.1:${internalPort}`,
    tls: pki.doc, serverFingerprint256: pki.asset.fingerprint256 });
  const identity = await privateClient.identity();
  assert.equal(identity.instanceId, service.instanceId);
  assert.equal(identity.serviceIdentity, 'asset-service-test');
  assert.equal(identity.docClientFingerprint256, certificateFingerprint(pki.asset.fingerprint256));
  const bytes = Buffer.from('derived-video-tier'), hash = createHash('sha256').update(bytes).digest('hex');
  const store = service.projectStores.project('project-one').stores.media;
  await store.putChunk(hash, 0, { size: bytes.length, ext: 'mp4' }, Readable.from([bytes]));
  await assert.rejects(privateClient.resolveTierAssetRef({ projectId: 'project-one', hash, tier: 'small', mediaId: 'clip-one' }),
    error => error.code === 'run-asset-tier-metadata-unavailable');
  assert.equal((await store.complete(hash)).status, 'ok');
  const metadata = await privateClient.resolveTierAssetRef({ projectId: 'project-one', hash, tier: 'small', mediaId: 'clip-one' });
  assert.deepEqual({ projectId: metadata.projectId, hash: metadata.hash, size: metadata.size, ext: metadata.ext },
    { projectId: 'project-one', hash, size: bytes.length, ext: 'mp4' });
  await assert.rejects(privateClient.resolveTierAssetRef({ projectId: 'project-two', hash, tier: 'small', mediaId: 'clip-one' }),
    error => error.code === 'run-asset-tier-metadata-unavailable');
  await assert.rejects(privateClient.closureWitness('lease-one'), error => error.code === 'asset-run-resource-closure-pending');
  const wrong = await new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port: internalPort, path: '/internal/v2/asset/run/identity', method: 'GET',
      ...pki.wrong, minVersion: 'TLSv1.3', agent: false }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end();
  });
  assert.equal(wrong, 403);
  const publicRun = await fetch(`http://127.0.0.1:${service.port}/internal/v2/asset/run/identity`);
  assert.equal(publicRun.status, 404); await publicRun.arrayBuffer();
  privateClient.close(); privateClient = null;
  await service.close(); service = null;
  assert.equal(sockets.size, 0);
});
