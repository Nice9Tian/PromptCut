import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import { createAccountAuthority } from '../account/authority.mjs';
import { canonicalReadRecord } from '../account/run-authority.mjs';
import { digestOf } from '../account/ledger.mjs';
import { createDocAgentAssembly } from '../hosted/doc-agent-assembly.mjs';
import { createDocService } from '../docservice/service.mjs';
import { createRunClient } from '../agent-service/run-client.mjs';
import { createRunDataClient } from '../agent-service/run-data-client.mjs';
import { createRunControlServer } from '../agent-service/run-control.mjs';
import { assetWiringPki } from './fixtures/asset-wiring-pki.mjs';
import { runFixture, projectId, conversationId } from './run-authority-fixture.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const listen = (server, port) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
const close = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); });

test('real doc TLS/WS closes exact terminal grant; signed empty counts cannot manufacture an independent resource witness', { timeout: 30000 }, async t => {
  const f = await runFixture(), pki = assetWiringPki(f.dir);
  let assembly, service, server, controlServer, client, otherClient, dataClient, file;
  const diagnostics = [], managerEntered = deferred(), permitDrain = deferred();
  let fileClosed = false, dataClosed = false, cancelCalls = 0, completeCalls = 0, proofMode = 'normal', savedProof;
  const accountClient = { events: async () => ({ events: [], headSeq: 0 }),
    verifyAcceptedMessage: async ref => ({ ...ref, accountEventSeq: 0 }) };
  const authority = createAccountAuthority({ ledger: f.ledger, accountClient, pollMs: 0 });
  t.after(async () => {
    permitDrain.resolve();
    if (file) await file.close();
    await dataClient?.close(); client?.close(); otherClient?.close();
    await assembly?.close(); await service?.close();
    if (controlServer?.listening) await close(controlServer);
    if (server?.listening) await close(server);
    authority.close(); f.close(); fs.rmSync(f.dir, { recursive: true });
    t.diagnostic(`owned TLS ports 6600/6601 listening=${server?.listening === true}/${controlServer?.listening === true}; dataClosed=${dataClosed}; fileClosed=${fileClosed}`);
  });
  f.enqueue(); f.enqueue('next-message');
  assembly = createDocAgentAssembly({ ledger: f.ledger, accountClient,
    account: { origin: 'https://127.0.0.1:6600', clientTls: pki.doc, serverFingerprint256: pki.doc.fingerprint256,
      agent: { fingerprint256: pki.asset.fingerprint256, serviceKid: 'agent-test-key',
        controlOrigin: 'https://127.0.0.1:6601', controlServerFingerprint256: pki.asset.fingerprint256 } },
    runtime: { authority, docInstanceId: 'actual-doc-terminal-1' },
    serviceRegistry: { refresh() {}, get: () => ({ role: 'agent', actsFor: 'member', keys: [{ kid: 'agent-test-key' }] }) },
    getDocAssembly: () => ({ fence() { throw Error('normal finish must not cancel an operation'); } }),
    getService: () => service, onDiagnostic: e => diagnostics.push(e) });
  service = createDocService({ autoTick: false, log() {}, transportAuthenticate: assembly.transportAuthenticate,
    transportConnected: assembly.transportConnected, dispatchInvocation: assembly.dispatchInvocation });
  server = https.createServer({ ...pki.doc, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3' }, async (req, res) => {
    if (!await assembly.handleInternal(req, res)) { res.writeHead(404); res.end(); }
  });
  service.attachTransportServer(server);
  await listen(server, 6600);
  client = createRunClient({ origin: 'https://127.0.0.1:6600', tls: pki.asset, serverFingerprint256: pki.doc.fingerprint256 });
  const registered = await client.registerInstance();
  const grant = await client.admit({ projectId, conversationId, requestId: 'admit-real-terminal' });
  const prompt = canonicalReadRecord(grant.message, grant);
  const read = await client.confirmRead({ projectId, conversationId, messageId: grant.messageId, runId: grant.runId,
    runGrantId: grant.runGrantId, requestId: 'read-real-terminal', readIntentId: 'actual-read', prompt, promptDigest: digestOf(prompt) });
  dataClient = createRunDataClient({ origin: 'https://127.0.0.1:6600', tls: pki.asset,
    serverFingerprint256: pki.doc.fingerprint256, runClient: client });
  const Socket = dataClient.webSocketFor(grant), ws = new Socket('wss://127.0.0.1:6600/', ['promptcut.v1', 'promptcut.session.new']);
  const closed = new Promise(resolve => ws.addEventListener('close', () => { dataClosed = true; resolve(); }));
  await new Promise((resolve, reject) => { ws.addEventListener('message', e => {
    if (JSON.parse(e.data).type === 'session.welcome') resolve(); }); ws.addEventListener('error', e => reject(e.error)); });
  file = await fs.promises.open(`${f.dir}/owned-terminal-data`, 'w'); await file.writeFile('owned test data');
  const outcome = { v: 1, status: 'failed', eventId: `event:${grant.runGrantId}:1`, eventDigest: digestOf({ type: 'error', code: 'controlled-error' }) };
  const manager = { async drainControl() { cancelCalls++; throw Error('terminal must not cancel'); },
    async prepareTerminalClosure(control) {
      completeCalls++; managerEntered.resolve();
      assert.equal(control.target.instanceGeneration, registered.instanceGeneration);
      assert.equal(control.target.runGrantId, grant.runGrantId);
      await permitDrain.promise; await closed;
      if (file) { const current = file; file = null; await current.close(); fileClosed = true; }
      // This explicit unverified reference is a negative fixture, not a root
      // witness. Actual file/WS close and valid RAM signature remain insufficient.
      return { v: 1, drainReceiptId: 'actual-drain-1', resourceScopeId: 'current-owned-scope',
        resourceWitnessId: 'missing-independent-root-witness', eventId: outcome.eventId, eventDigest: outcome.eventDigest,
        dispatchesOpen: 0, connectionsOpen: dataClient.openCount(), streamsOpen: fileClosed ? 0 : 1,
        childrenOpen: 0, pendingRegistrations: 0, oldInstanceUnknown: false };
    } };
  controlServer = createRunControlServer({ tls: pki.asset, docFingerprint256: pki.doc.fingerprint256,
    serviceKid: registered.serviceKid, instanceId: registered.instanceId, instanceGeneration: registered.instanceGeneration,
    instanceSession: { identity: client.instanceIdentity, terminalControlProofFor(args) {
      if (proofMode === 'replay') return savedProof;
      if (proofMode === 'new-instance') return otherClient.terminalControlProofFor(args);
      const proof = client.terminalControlProofFor(proofMode === 'wrong-nonce' ? { ...args, nonce: `${args.nonce}:changed` } : args);
      if (proofMode === 'normal') savedProof = proof;
      return proof;
    } }, manager });
  await listen(controlServer, 6601);
  const body = { ...Object.fromEntries(['projectId', 'conversationId', 'messageId', 'runId', 'runGrantId'].map(k => [k, grant[k]])),
    requestId: `finish:${grant.runGrantId}`, readReceiptId: read.receipt.receiptId, outcome };
  const finished = await client.finish(body);
  await managerEntered.promise; await closed;
  assert.equal(finished.finishPending, true); assert.equal(fileClosed, false); assert.equal(cancelCalls, 0);
  const controlId = finished.finishReceipt.controlId;
  const docClosure = f.ledger.read().docRunClosuresV2[controlId].instances['actual-doc-terminal-1'];
  assert.equal(docClosure.state, 'closed'); assert.equal(docClosure.closed.actualClosed, true);
  assert.equal(docClosure.closed.connections.length, 1); assert.equal(docClosure.closed.connections[0].closedWs, 1);
  assert.equal(f.ledger.read().runFinishReceiptsV2[finished.finishReceipt.finishReceiptId].complete, false);
  permitDrain.resolve();
  const queried = await client.queryFinish(body);
  assert.equal(queried.recorded, true); assert.equal(queried.finishPending, true);
  assert.equal(fileClosed, true); assert.equal(dataClosed, true); assert.equal(cancelCalls, 0); assert.ok(completeCalls >= 1);
  const state = f.ledger.read();
  assert.ok(state.runTerminalAgentReceiptsV1[controlId], 'same RAM key/actual TLS receipt verified and persisted');
  assert.equal(state.runTerminalResourceClosuresV1, undefined, 'no network receipt creates an independent witness');
  assert.equal(state.conversationsV2[projectId][conversationId].currentRunId, grant.runId);
  await assert.rejects(client.admit({ projectId, conversationId, requestId: 'still-queued' }), { code: 'run-not-ready' });
  const changed = { ...body, outcome: { ...body.outcome, status: 'done' } };
  await assert.rejects(client.queryFinish(changed), { code: 'run-request-mismatch' });
  proofMode = 'replay';
  await assert.rejects(client.queryFinish(body), { code: 'terminal-instance-proof-invalid' });
  proofMode = 'wrong-nonce';
  await assert.rejects(client.queryFinish(body), { code: 'terminal-instance-proof-invalid' });
  otherClient = createRunClient({ origin: 'https://127.0.0.1:6600', tls: pki.asset, serverFingerprint256: pki.doc.fingerprint256 });
  const other = await otherClient.registerInstance();
  assert.notEqual(other.instanceId, registered.instanceId);
  await assert.rejects(otherClient.queryFinish(body), { code: 'run-instance-mismatch' });
  proofMode = 'new-instance';
  const stillPending = await client.queryFinish(body);
  assert.equal(stillPending.finishPending, true);
  assert.equal(f.ledger.read().runTerminalAgentReceiptsV1[controlId].instanceId, registered.instanceId);
  assert.equal(f.ledger.read().runFinishReceiptsV2[finished.finishReceipt.finishReceiptId].complete, false);
});
