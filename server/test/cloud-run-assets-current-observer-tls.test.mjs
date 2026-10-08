import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { once } from 'node:events';
import { assetWiringPki } from './fixtures/asset-wiring-pki.mjs';
import { instanceTlsBinding } from '../account/agent-instance-authority.mjs';
import { createAssetObserverChannels, assetObserverExporterDigest,
  verifyAssetObserverSocket } from '../hosted/run-assets-observer-binding.mjs';

test('actual original pinned TLS channel proves domain-separated exporter to opposite socket', { timeout: 45000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-run-asset-observer-'));
  const pki = assetWiringPki(dir), port = 6448;
  const server = tls.createServer({ ...pki.doc, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3' });
  const owned = new Set(), closed = new Set(); let client, channels, closing = false;
  server.on('tlsClientError', error => t.diagnostic(`tls-client-error=${error.code ?? 'unknown'}`));
  server.on('secureConnection', socket => { owned.add(socket); closed.add(new Promise(resolve => socket.once('close', () => {
    owned.delete(socket); resolve();
  }))); });
  t.after(async () => {
    channels?.close(); client?.destroy(); for (const socket of owned) socket.destroy();
    await Promise.allSettled([...closed]); await new Promise(resolve => server.close(resolve));
    t.diagnostic(`observer-tls-port=${port}; owned-tls-sockets=${owned.size}; listening=${server.listening}`);
    await fs.rm(dir, { recursive: true, force: true });
  });
  server.listen(port, '127.0.0.1'); await once(server, 'listening');
  const serverSocketPromise = once(server, 'secureConnection').then(([socket]) => socket);
  serverSocketPromise.catch(() => {});
  client = tls.connect({ host: '127.0.0.1', servername: 'localhost', port, ...pki.asset, minVersion: 'TLSv1.3', rejectUnauthorized: true });
  client.on('error', error => { if (!closing) t.diagnostic(`observer-client-error=${error.code ?? 'unknown'}`); });
  await once(client, 'secureConnect'); const docSocket = await serverSocketPromise;
  channels = createAssetObserverChannels({ docFingerprint256: pki.doc.fingerprint256 });
  const registration = channels.register(client), digest = registration.exporterDigest;
  assert.throws(() => channels.register(client), error => error.code === 'asset-observer-binding-unavailable');
  assert.equal(digest, assetObserverExporterDigest(docSocket));
  assert.notEqual(digest, instanceTlsBinding(client));
  const challenge = 'abcdef0123456789abcdef0123456789';
  const instance = { instanceId: 'asset-one', bootId: '11111111-2222-3333-4444-555555555555', pid: 1201,
    pidBirth: { bootId: '11111111-2222-3333-4444-555555555555', startTicks: '12345' }, uid: 1050,
    unit: 'promptcut-asset.service', unitInvocationId: 'd'.repeat(32),
    cgroup: { v2Path: '/sys/fs/cgroup/system.slice/promptcut-asset.service', dev: '1001', ino: '4001',
      bootId: '11111111-2222-3333-4444-555555555555' }, serviceIdentity: 'asset-service',
    clientFingerprint256: 'a'.repeat(64), serverFingerprint256: 'b'.repeat(64) };
  const input = { challenge, exporterDigest: digest, epoch: 1, recordDigest: 'c'.repeat(64),
    docAuthorityId: 'doc-one', purpose: 'run-assets-observer-verify', instance };
  const proof = channels.prove(input);
  assert.equal(verifyAssetObserverSocket(docSocket, input, proof), true);
  assert.throws(() => verifyAssetObserverSocket(docSocket, { ...input, challenge: 'fedcba0123456789abcdef0123456789' }, proof),
    error => error.code === 'asset-observer-binding-unavailable');
  assert.throws(() => verifyAssetObserverSocket(docSocket, { ...input, epoch: 2 }, proof),
    error => error.code === 'asset-observer-binding-unavailable');
  assert.throws(() => verifyAssetObserverSocket(docSocket, { ...input, instance: { ...instance, pid: 1202 } }, proof),
    error => error.code === 'asset-observer-binding-unavailable');
  registration.unregister(); assert.equal(channels.size, 0);
  assert.throws(() => channels.prove(input), error => error.code === 'asset-observer-binding-unavailable');
  closing = true; const clientClosed = new Promise(resolve => client.once('close', resolve));
  client.destroy(); await clientClosed; await Promise.allSettled([...closed]);
  assert.equal(owned.size, 0);
});
