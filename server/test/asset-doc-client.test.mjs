import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { accountError } from '../account/client.mjs';
import { createAccountProjectsInternalServer } from '../docservice/modules/account-projects.mjs';
import { createAssetDocClient, createAssetReadyProbe, createAssetMtlsTransport } from '../hosted/asset-doc-client.mjs';
import { assetWiringPki } from './fixtures/asset-wiring-pki.mjs';

const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(5865, '127.0.0.1', resolve); });
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
test('独立asset doc mTLS client契约：opaque引用、pin/证书拒、事件连续与精确ACK；这是RPC单测', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-asset-client-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const pki = assetWiringPki(dir), ack = [], events = [{ seq: 1, eventId: 'event-1', type: 'login-revoked', loginIds: ['login-a'] }];
  const p = { accountId: 'account-a', loginId: 'login-a', credentialId: 'credential-a', loginGeneration: 1, projectId: 'A',
    authorizationId: 'opaque-ref', authorityId: 'doc-a', access: 'rw', accessRevision: 1, revocationSeq: 1 };
  const authority = {
    async checkAccess(body) { if (body.principal?.authorizationId !== p.authorizationId) throw accountError(401, 'authorization-expired'); if (body.projectId !== 'A') throw accountError(403, 'project-mismatch'); return { allowed: true, ...p }; },
    async synchronize() {}, eventsSince: after => ({ events: events.filter(e => e.seq > after), headSeq: 1 }),
    ackAccessEvent(id, service, receipt) { ack.push({ id, service, receipt }); return receipt; },
  };
  const server = createAccountProjectsInternalServer({ tls: pki.doc, authority, services: [{ serviceId: 'asset', fingerprint256: pki.asset.fingerprint256 }],
    resolveAssetTicket: async ticket => { if (ticket !== 'known-ticket') throw accountError(401, 'ticket-expired'); return p; } });
  await listen(server); t.after(() => close(server));
  const config = { origin: 'https://127.0.0.1:5865', authorityId: 'doc-a', tls: pki.asset, serverFingerprint256: pki.doc.fingerprint256 };
  const client = createAssetDocClient(config); t.after(() => client.close());
  assert.deepEqual(await client.resolveAssetTicket('known-ticket', 'A').then(p => [p.accountId, p.projectId, p.authorizationId]), ['account-a', 'A', 'opaque-ref']);
  await assert.rejects(client.resolveAssetTicket('known-ticket', 'B'), { status: 403 });
  await assert.rejects(client.checkAccess({ principal: { ...p, authorizationId: 'fake' }, projectId: 'A', action: 'read' }), { status: 401 });
  const wrong = createAssetDocClient({ ...config, tls: pki.wrong }); t.after(() => wrong.close()); await assert.rejects(wrong.resolveAssetTicket('known-ticket', 'A'), { status: 403 });
  const pin = createAssetDocClient({ ...config, serverFingerprint256: '0'.repeat(64) }); t.after(() => pin.close()); await assert.rejects(pin.resolveAssetTicket('known-ticket', 'A'), { status: 503 });
  const wakes = []; client.subscribeRevocations({}, e => wakes.push(e.eventId)); await client.eventsSince(0); await client.eventsSince(0); assert.deepEqual(wakes, ['event-1']);
  const receipt = { receiptId: 'receipt-a', cursor: 1, complete: true, closedStreams: ['lease-a'], stoppedRuns: [], rejectedCredentials: [] };
  await client.ackAccessEvent('event-1', 'asset', receipt); assert.deepEqual(ack, [{ id: 'event-1', service: 'asset', receipt }]);
  assert.throws(() => client.ackAccessEvent('event-1', 'agent', receipt), { status: 403 });
});

test('doc status probe真实mTLS且精确head，无证书/错身份/错误head不能ready', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-asset-status-client-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const pki = assetWiringPki(dir);
  const server = https.createServer({ ...pki.asset, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3' }, (req, res) => {
    const authorized = req.socket.getPeerCertificate().fingerprint256 === pki.doc.fingerprint256;
    res.writeHead(authorized ? 200 : 403, { 'content-type': 'application/json' }); res.end(JSON.stringify(authorized ?
      { ok: true, ready: true, authorityId: 'doc-a', instanceId: 'instance-a', accessCursor: 7, accessHead: 7 } : { ok: false, code: 'service-forbidden' }));
  });
  await listen(server); t.after(() => close(server));
  const config = { origin: 'https://127.0.0.1:5865', tls: pki.doc, serverFingerprint256: pki.asset.fingerprint256 };
  const probe = createAssetReadyProbe(config); t.after(() => probe.close()); assert.equal((await probe({ authorityId: 'doc-a', requiredAccessHead: 7 })).instanceId, 'instance-a');
  await assert.rejects(probe({ authorityId: 'doc-a', requiredAccessHead: 6 }), { status: 503 });
  const wrong = createAssetReadyProbe({ ...config, tls: pki.wrong }); t.after(() => wrong.close()); await assert.rejects(wrong({ authorityId: 'doc-a', requiredAccessHead: 7 }), { status: 403 });
  assert.throws(() => createAssetMtlsTransport({ ...config, tls: { ca: pki.ca } }), { status: 503 });
});
