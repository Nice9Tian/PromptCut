import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { randomUUID } from 'node:crypto';
import { assetWiringPki } from './fixtures/asset-wiring-pki.mjs';
import { scopeModel } from './agent-run-scope-fixture.mjs';
import { runFixture, projectId, conversationId } from './run-authority-fixture.mjs';
import { createAccountTaskWorker } from '../agent-service/account-task-worker.mjs';
import { createAgentRunScopeDoc } from '../account/agent-run-scope-doc.mjs';
import { createAgentInstanceAuthority, instanceTlsBinding } from '../account/agent-instance-authority.mjs';
import { createAgentInstanceInternalHandler, instanceRequestProof } from '../account/agent-instance-internal.mjs';
import { createRunInternalHandler } from '../account/run-internal.mjs';
import { createRunAuthority } from '../account/run-authority.mjs';
import { certificateFingerprint } from '../account/client.mjs';
import { inspectAgentScopeSource } from '../hosted/agent-run-scope-reader.mjs';
import { digestOf } from '../account/ledger.mjs';

// Real mTLS/handlers/RAM PoP/exporter/SQLite/JSON chain and same process PID.
// Root publisher cgroup/birth ownership and account sender are controlled here.
// Production Linux reader is NOT replaced or weakened by this Windows target.
const getIdentity = (port, tls, pin) => new Promise((resolve, reject) => {
  let result, error, socket, socketClosed = false, ended = false;
  const finish = () => { if (ended && socketClosed) error ? reject(error) : resolve(result); };
  const req = https.get(`https://127.0.0.1:${port}/internal/v2/agent/run-scope/identity`, {
    ...tls, agent: false, timeout: 5000, rejectUnauthorized: true,
    checkServerIdentity(host, cert) { return checkServerIdentity(host, cert) ||
      (certificateFingerprint(cert.fingerprint256) !== pin ? Error('fixture-identity-pin') : undefined); },
  }, res => { const chunks = []; res.on('data', chunk => chunks.push(chunk));
    res.on('error', reject); res.on('end', () => {
      try { result = { status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }; } catch (cause) { error = cause; }
      ended = true; finish(); }); });
  req.on('socket', value => { socket = value; socket.once('close', () => { socketClosed = true; finish(); }); });
  req.on('error', reject); req.on('timeout', () => req.destroy(Error('fixture-identity-timeout')));
});

test('actual TLS worker key → root record → Doc scope registration/admit; no read/model before bound', { timeout: 45000 }, async t => {
  const f = await runFixture(), m = scopeModel('tls-worker');
  const pki = assetWiringPki(f.dir), chainDir = path.join(f.dir, 'root-chain'); fs.mkdirSync(chainDir);
  m.expected.docAuthorityId = f.ledger.authorityId;
  m.expected.clientFingerprint256 = certificateFingerprint(pki.account.fingerprint256);
  m.expected.serverFingerprint256 = certificateFingerprint(pki.asset.fingerprint256);
  const workerPin = certificateFingerprint(pki.wrong.fingerprint256), masterPin = m.expected.clientFingerprint256;
  const docSockets = new Set(); let worker, scope, instances, provider, instanceHandler, runHandler, modelCalls = 0;
  const doc = https.createServer({ ...pki.doc, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3' }, async (req, res) => {
    try {
      if (await instanceHandler?.(req, res)) return;
      if (await runHandler?.(req, res)) return;
      res.writeHead(503); res.end();
    } catch { if (!res.writableEnded) { res.writeHead(503); res.end(); } }
  });
  doc.on('connection', socket => { docSockets.add(socket); socket.once('close', () => docSockets.delete(socket)); });
  t.after(async () => {
    const closes = await Promise.allSettled([worker?.close(), ...[...docSockets].map(socket => new Promise(resolve => {
      socket.once('close', resolve); socket.destroy(); })), doc.listening ? new Promise(resolve => doc.close(resolve)) : null]);
    instances?.close(); f.close();
    assert.equal(docSockets.size, 0); assert.equal(worker?.describe().identitySockets ?? 0, 0);
    const errors = closes.filter(v => v.status === 'rejected').map(v => v.reason);
    if (!errors.length) fs.rmSync(f.dir, { recursive: true, force: true });
    if (errors.length) throw new AggregateError(errors, 'fixture-close-pending');
  });
  await new Promise((resolve, reject) => { doc.once('error', reject); doc.listen(6700, '127.0.0.1', resolve); });
  const originalWrite = m.io.write, originalInspect = m.io.inspect;
  m.io.write = async (name, value, exclusive) => { await originalWrite(name, value, exclusive);
    fs.writeFileSync(path.join(chainDir, name), JSON.stringify(value), { flag: exclusive ? 'wx' : 'w', mode: 0o600 }); };
  m.io.read = async name => { try { return JSON.parse(fs.readFileSync(path.join(chainDir, name), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  const originalLock = m.io.lock;
  m.io.lock = async () => { const release = await originalLock(); fs.writeFileSync(path.join(chainDir, '.publisher.lock'), '{}');
    return async options => { await release(options); if (options.publicationDurable) fs.rmSync(path.join(chainDir, '.publisher.lock')); }; };
  m.io.inspect = async reservation => { const value = await originalInspect(reservation); value.instance.pid = process.pid; return value; };
  m.io.start = async reservation => {
    worker = createAccountTaskWorker({ expected: m.expected, reservation, identityTls: pki.asset,
      doc: { origin: 'https://127.0.0.1:6700', tls: pki.wrong, serverFingerprint256: pki.doc.fingerprint256 },
      readRootRecord: async () => m.io.read('epoch-1.json') });
    await worker.listen({ port: 6701 });
  };
  m.io.identity = async () => {
    const result = await getIdentity(6701, pki.account, m.expected.serverFingerprint256);
    assert.equal(result.status, 200); return result.body;
  };
  await m.run('initialize');
  const record = await m.io.read('epoch-1.json');
  assert.equal(record.instance.pid, process.pid);
  const wrongController = await getIdentity(6701, pki.wrong, m.expected.serverFingerprint256);
  assert.equal(wrongController.status, 403);
  assert.notEqual(m.expected.clientFingerprint256, workerPin);
  const slot = { expected: m.expected, configuredAnchorDigest: digestOf(await m.io.read('anchor.json')),
    workerServiceKid: 'worker-key', workerFingerprint256: workerPin };
  scope = createAgentRunScopeDoc({ ledger: f.ledger, signingKey: m.doc.privateKey, slots: [slot],
    masterServiceKid: 'master-key', masterFingerprint256: masterPin,
    sourceFactory: () => ({ read: ({ checkpoint }) => inspectAgentScopeSource({ read: m.io.read,
      expected: m.expected, configuredAnchorDigest: slot.configuredAnchorDigest, checkpoint }) }) });
  f.ledger.transaction(s => { s.testServices['worker-key'] = true; s.testServices['master-key'] = true; });
  const socketIds = new WeakMap();
  const peerPrincipal = ({ socket }) => {
    const fingerprint = certificateFingerprint(socket.getPeerCertificate()?.fingerprint256);
    if (socket.authorized !== true || socket.destroyed || ![workerPin, masterPin].includes(fingerprint)) throw Error('fixture-peer');
    if (!socketIds.has(socket)) socketIds.set(socket, randomUUID());
    return { service: 'agent', serviceKid: fingerprint === workerPin ? 'worker-key' : 'master-key',
      scope: 'service', authenticationId: socketIds.get(socket), socket };
  };
  const verifyService = (state, p) => {
    if (!state.testServices[p?.serviceKid] || p?.service !== 'agent' || p.socket?.destroyed || !socketIds.has(p.socket)) throw Error('fixture-current-service');
    return { serviceId: 'agent', serviceKid: p.serviceKid };
  };
  instances = createAgentInstanceAuthority({ ledger: f.ledger, scopeAuthority: scope,
    verifyTransportInState(state, p) { return { ...verifyService(state, p), authenticationId: p.authenticationId,
      channelBinding: instanceTlsBinding(p.socket), fingerprint256: certificateFingerprint(p.socket.getPeerCertificate().fingerprint256) }; } });
  provider = createRunAuthority({ ledger: f.ledger, conversationHooks: f.hooks, instanceAuthority: instances, scopeAuthority: scope,
    verifyServiceInState: verifyService, verifySender: async ref => ({ ...ref, accountEventSeq: f.ledger.read().accountHead }), synchronize: async () => {} });
  instanceHandler = createAgentInstanceInternalHandler({ instanceAuthority: instances, agentFingerprint256: workerPin,
    masterFingerprint256: masterPin, resolveServicePrincipal: peerPrincipal });
  runHandler = createRunInternalHandler({ runAuthority: provider, agentFingerprint256: workerPin,
    masterFingerprint256: masterPin, resolveServicePrincipal: peerPrincipal, requirePendingProof: true,
    authenticateInvocation({ req, servicePrincipal, body, operation }) {
      const cap = instances.authenticate({ servicePrincipal, method: req.method, path: req.url, operation,
        request: body, proof: instanceRequestProof(req) });
      return { servicePrincipal: { ...servicePrincipal, ...cap }, release: () => instances.release(cap.instanceSession) };
    } });
  f.enqueue();
  const task = { projectId, conversationId, requestId: 'worker-admit' }, result = await worker.prepareTask(task);
  assert.equal(result.phase, 'assigned-unbound'); assert.equal(result.executionAllowed, false);
  assert.equal(result.assignment.target.publicKeyDigest, record.worker.publicKeyDigest);
  const registered = f.ledger.read().agentInstancesV2[record.instance.instanceId];
  assert.notEqual(registered.publicKeyDigest, record.worker.publicKeyDigest);
  assert.equal(registered.scopePublicKeyDigest, record.worker.publicKeyDigest);
  assert.equal(registered.purpose, 'run-worker');
  const grant = f.ledger.read().runGrantsV2[result.assignment.target.runGrantId];
  await assert.rejects(worker.assignmentReady(grant), { code: 'account-worker-not-bound' });
  await assert.rejects(worker.startTask({ modelConfig: async () => { modelCalls++; return {}; } }), { code: 'account-worker-not-bound' });
  assert.equal(modelCalls, 0); assert.equal(Object.keys(f.ledger.read().runReceiptsV2).length, 0);
  await m.run('bind', { assignment: result.assignment });
  assert.equal((await worker.assignmentReady(grant)).executionAllowed, true);
  await assert.rejects(worker.prepareTask({ ...task, requestId: 'other-task' }), { code: 'account-worker-task-conflict' });
  assert.equal(Object.keys(f.ledger.read().runGrantsV2).length, 1);
  assert.equal(worker.describe().completionReady, false);
  t.diagnostic('actual role ports: Doc 6700, worker identity 6701; model calls/read receipts before bound: 0/0; OS publisher controlled');
});
