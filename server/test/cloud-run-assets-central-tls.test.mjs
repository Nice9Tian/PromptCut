import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { assetWiringPki } from './fixtures/asset-wiring-pki.mjs';
import { openAccountLedger, canonicalJson, digestOf } from '../account/ledger.mjs';
import { certificateFingerprint } from '../account/client.mjs';
import { createDocAgentAssembly } from '../hosted/doc-agent-assembly.mjs';
import { instanceTlsBinding, instanceProofPayload } from '../account/agent-instance-authority.mjs';
import { instanceRequestProof } from '../account/agent-instance-internal.mjs';
import { instanceHttpRequest, registerHttpInstance } from './fixtures/agent-instance-request.mjs';

const request = { projectId: 'project-central-tls', runGrantId: 'grant-central-tls', action: 'read' };
const dataPath = '/internal/v2/asset/run/media/' + 'a'.repeat(64);
const reply = (res, status, result) => { res.writeHead(status, { 'content-type': 'application/json', connection: 'close' }); res.end(JSON.stringify(result)); };
const bodyOf = async req => { const chunks = []; for await (const bytes of req) chunks.push(bytes); return JSON.parse(Buffer.concat(chunks).toString('utf8')); };
const closeServer = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });

test('doc reuses its registered RAM instance for direct Agent and pinned observed asset TLS exporters',
  { timeout: 45000 }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-gdoc-asset-tls-'));
    const pki = assetWiringPki(dir), ledger = openAccountLedger({ file: path.join(dir, 'doc.db'), authorityId: 'gdoc-tls' });
    const agentPin = certificateFingerprint(pki.account.fingerprint256);
    const assetPin = certificateFingerprint(pki.asset.fingerprint256);
    const sockets = new Set(), closeEvents = new Set();
    let doc, asset, currentAssetId = 'asset-os-one', currentAgent = true;
    const registry = { refresh() {}, get(name) { return currentAgent && name === 'agent' ?
      { role: 'agent', actsFor: 'member', keys: [{ kid: 'agent-kid' }] } : null; } };
    const assembly = createDocAgentAssembly({ ledger, accountClient: { verifyAcceptedMessage: async () => { throw Error('not-used'); } },
      account: { agent: { fingerprint256: agentPin, serviceKid: 'agent-kid' }, origin: 'https://127.0.0.1:1',
        clientTls: pki.doc, serverFingerprint256: pki.account.fingerprint256 },
      runtime: { docInstanceId: 'doc-gdoc', authority: { authorizePrincipal: async () => { throw Error('not-used'); },
        synchronize: async () => {} } }, serviceRegistry: registry, getDocAssembly: () => null,
      getService: () => null });
    const adapter = assembly.createRunAssetAuthentication({ assetFingerprint256: assetPin,
      currentAsset({ socket }) { assert.equal(socket.authorized, true); return currentAssetId ?
        { assetInstanceId: currentAssetId, serviceIdentity: 'asset-service-kid' } : null; } });
    const track = server => server.on('secureConnection', socket => {
      sockets.add(socket); const closed = once(socket, 'close').then(() => sockets.delete(socket)); closeEvents.add(closed);
    });
    t.after(async () => {
      await assembly.close(); for (const socket of sockets) socket.destroy();
      await Promise.all([...closeEvents]);
      if (asset?.listening) await closeServer(asset);
      if (doc?.listening) await closeServer(doc);
      ledger.close(); fs.rmSync(dir, { recursive: true, force: true });
      t.diagnostic(`owned-tls-sockets=${sockets.size}; doc-listening=${doc?.listening === true}; asset-listening=${asset?.listening === true}`);
    });
    doc = https.createServer({ ...pki.doc, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3' }, async (req, res) => {
      try {
        if (req.url === '/central/direct') {
          const value = await bodyOf(req);
          const cap = adapter.authenticateDirect({ transport: req, method: req.method, path: req.url,
            operation: 'checkAccess', request: value, proof: instanceRequestProof(req) });
          cap.release(); reply(res, 200, { ok: true }); return;
        }
        if (req.url === '/central/observed') {
          const { proof, observation, signedRequest } = await bodyOf(req);
          const observer = { socket: req.socket, assetInstanceId: observation.assetInstanceId,
            serviceIdentity: observation.assetServiceIdentity };
          adapter.verifyObserver(observer);
          const cap = adapter.authenticateObserved({ observer, observation, proof,
            method: 'GET', path: dataPath, operation: 'checkAccess', request: signedRequest });
          cap.release(); reply(res, 200, { ok: true }); return;
        }
        if (!await assembly.handleInternal(req, res)) reply(res, 404, { ok: false, code: 'no-route' });
      } catch (error) { reply(res, error.status ?? 503, { ok: false, code: error.code ?? 'internal-failed' }); }
    });
    track(doc); doc.listen(0, '127.0.0.1'); await once(doc, 'listening');
    const docPort = doc.address().port;
    const process = await registerHttpInstance({ port: docPort, tls: pki.account, requestId: 'agent-os-one' });
    const signValue = (key, value) => sign(null, Buffer.from(canonicalJson(value)), key).toString('base64url');
    const direct = await instanceHttpRequest({ port: docPort, tls: pki.account, path: '/central/direct',
      body: request, signedBody: request, operation: 'checkAccess', instance: process });
    assert.equal(direct.status, 200);
    const wrongRole = await instanceHttpRequest({ port: docPort, tls: pki.wrong, path: '/central/direct',
      body: request, signedBody: request, operation: 'checkAccess', instance: process });
    assert.equal(wrongRole.status, 403);
    asset = https.createServer({ ...pki.asset, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3' }, async (req, res) => {
      try {
        if (certificateFingerprint(req.socket.getPeerCertificate().fingerprint256) !== agentPin) throw Error('wrong-agent');
        const proof = JSON.parse(Buffer.from(req.headers['x-gdoc-proof'], 'base64url').toString('utf8'));
        const observation = { assetInstanceId: 'asset-os-one', assetServiceIdentity: 'asset-service-kid',
          assetLeaseId: 'lease-one', agentFingerprint256: agentPin, agentServiceKid: 'agent-kid',
          authenticationId: 'untrusted-body-id', channelBinding: instanceTlsBinding(req.socket), open: true };
        const forwarded = await new Promise((resolve, reject) => {
          const outbound = https.request({ host: '127.0.0.1', port: docPort, path: '/central/observed', method: 'POST',
            ...pki.asset, minVersion: 'TLSv1.3', agent: false, headers: { 'content-type': 'application/json' } }, incoming => {
            const chunks = []; incoming.on('data', chunk => chunks.push(chunk)); incoming.on('end', () =>
              resolve({ status: incoming.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
            incoming.on('error', reject);
          });
          outbound.on('error', reject); outbound.end(JSON.stringify({ proof, observation, signedRequest: request }));
        });
        reply(res, forwarded.status, forwarded.body);
      } catch (error) { reply(res, error.status ?? 503, { ok: false, code: error.code ?? 'asset-test-failed' }); }
    });
    track(asset); asset.listen(0, '127.0.0.1'); await once(asset, 'listening');
    const assetPort = asset.address().port;
    t.diagnostic(`owned-doc-port=${docPort}; owned-asset-port=${assetPort}; pid=${globalThis.process.pid}`);
    async function observed({ tls = pki.account, key = process.privateKey, altered = request } = {}) {
      return new Promise((resolve, reject) => {
        let outcome, closed = false;
        const finish = () => { if (outcome && closed) resolve(outcome); };
        const call = https.request({ host: '127.0.0.1', port: assetPort, path: dataPath, method: 'GET',
          ...tls, minVersion: 'TLSv1.3', agent: false }, incoming => {
          const chunks = []; incoming.on('data', chunk => chunks.push(chunk)); incoming.on('error', reject);
          incoming.on('end', () => { outcome = { status: incoming.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }; finish(); });
        });
        call.on('error', reject); call.on('socket', socket => {
          socket.once('close', () => { closed = true; finish(); });
          socket.once('secureConnect', () => {
            try {
              const payload = instanceProofPayload({ authorityId: process.authorityId,
                instanceId: process.instanceId, instanceGeneration: process.instanceGeneration,
                serviceId: 'agent', serviceKid: 'agent-kid', channelBinding: instanceTlsBinding(socket),
                method: 'GET', path: dataPath, operation: 'checkAccess', requestDigest: digestOf(altered) });
              call.setHeader('x-gdoc-proof', Buffer.from(JSON.stringify({ instanceId: process.instanceId,
                instanceGeneration: process.instanceGeneration, signature: signValue(key, payload) })).toString('base64url'));
              call.end();
            } catch (error) { call.destroy(error); }
          });
        });
      });
    }
    assert.equal((await observed()).status, 200);
    assert.equal((await observed({ altered: { ...request, projectId: 'different' } })).status, 403);
    assert.equal((await observed({ key: generateKeyPairSync('ed25519').privateKey })).status, 403);
    currentAssetId = 'asset-os-two'; assert.equal((await observed()).status, 403);
    currentAssetId = null; assert.equal((await observed()).status, 403);
    currentAssetId = 'asset-os-one'; currentAgent = false; assert.equal((await observed()).status, 403);
  });
