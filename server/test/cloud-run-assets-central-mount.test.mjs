import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { once } from 'node:events';
import { openAccountLedger } from '../account/ledger.mjs';
import { certificateFingerprint } from '../account/client.mjs';
import { createDocAgentAssembly } from '../hosted/doc-agent-assembly.mjs';
import { assetWiringPki } from './fixtures/asset-wiring-pki.mjs';

const closeServer = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
const request = (port, tls) => new Promise((resolve, reject) => {
  let response, socketClosed = false;
  const finish = () => { if (response && socketClosed) resolve(response); };
  const call = https.request({ host: '127.0.0.1', port, method: 'GET',
    path: '/internal/v2/run-assets/events?after=0', ...tls, minVersion: 'TLSv1.3', agent: false }, res => {
    const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.once('error', reject);
    res.once('end', () => { response = { status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }; finish(); });
  });
  call.once('error', reject);
  call.once('socket', socket => socket.once('close', () => { socketClosed = true; finish(); }));
  call.end();
});

test('run-assets internal route mounts only with trusted live asset observer and keeps its own authority ledger',
  { timeout: 45000 }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-run-assets-mount-'));
    const pki = assetWiringPki(dir), ledger = openAccountLedger({ file: path.join(dir, 'doc.db'), authorityId: 'mount-authority' });
    const agentPin = certificateFingerprint(pki.account.fingerprint256), assetPin = certificateFingerprint(pki.asset.fingerprint256);
    const sockets = new Set(), socketCloses = new Set();
    let service, current = true;
    const assembly = createDocAgentAssembly({ ledger,
      accountClient: { async verifyAcceptedMessage() { throw Error('not-used'); } },
      account: { agent: { fingerprint256: agentPin, serviceKid: 'agent-key' }, origin: 'https://127.0.0.1:1',
        clientTls: pki.doc, serverFingerprint256: pki.account.fingerprint256 },
      runtime: { docInstanceId: 'doc-mount', authority: {
        async authorizePrincipal() { throw Error('not-used'); }, synchronize: async () => {} } },
      serviceRegistry: { refresh() {}, get(id) { return id === 'agent' ?
        { role: 'agent', actsFor: 'member', keys: [{ kid: 'agent-key' }] } : null; } },
      getDocAssembly: () => ({ async resolveRunMedia() { throw Error('not-used'); } }), getService: () => null });
    t.after(async () => {
      await assembly.close();
      for (const socket of sockets) socket.destroy();
      await Promise.all([...socketCloses]);
      if (service?.listening) await closeServer(service);
      ledger.close(); fs.rmSync(dir, { recursive: true, force: true });
      t.diagnostic(`owned-run-asset-port=6447; sockets=${sockets.size}; listening=${service?.listening === true}`);
    });
    const actual = ({ socket }) => {
      if (!current || socket.destroyed || socket.authorized !== true ||
          certificateFingerprint(socket.getPeerCertificate()?.fingerprint256) !== assetPin) return null;
      return { assetInstanceId: 'controlled-asset-instance', serviceIdentity: 'controlled-asset-service' };
    };
    assembly.mountRunAssets({ assetFingerprint256: assetPin, currentAsset: actual,
      resolveObserver: async ({ socket }) => actual({ socket }),
      privateClient: { identity: async () => { throw Error('not-used'); },
        closureWitness: async () => { throw Error('not-used'); }, controlWitness: async () => { throw Error('not-used'); } },
      ticketTtlMs: 10000, maxBodyBytes: 1024 * 1024 });
    service = https.createServer({ ...pki.doc, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3' }, async (req, res) => {
      if (!await assembly.handleInternal(req, res)) { res.writeHead(404); res.end(); }
    });
    service.on('secureConnection', socket => { sockets.add(socket);
      socketCloses.add(once(socket, 'close').then(() => sockets.delete(socket))); });
    service.listen(6447, '127.0.0.1'); await once(service, 'listening');
    const page = await request(6447, pki.asset);
    assert.equal(page.status, 200); assert.equal(page.body.ok, true);
    assert.deepEqual(page.body.result, { events: [], headSeq: 0 });
    assert.equal((await request(6447, pki.account)).status, 403);
    current = false;
    assert.equal((await request(6447, pki.asset)).status, 403);
  });
