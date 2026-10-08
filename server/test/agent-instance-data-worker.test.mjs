import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { once } from 'node:events';
import { openAccountLedger } from '../account/ledger.mjs';
import { createAgentInstanceAuthority, instanceTlsBinding } from '../account/agent-instance-authority.mjs';
import { createAgentInstanceInternalHandler, instanceRequestProof,
  instanceConnectionRequest, instanceDataRequest, instanceProtocolHeaders } from '../account/agent-instance-internal.mjs';
import { createDocService } from '../docservice/service.mjs';
import { createRunClient } from '../agent-service/run-client.mjs';
import { createRunDataClient } from '../agent-service/run-data-client.mjs';
import { createAccountRunManager, createExistingHostedRunnerFactory } from '../agent/service/account-runner.mjs';
import { canonicalReadRecord } from '../account/run-authority.mjs';
import { assetWiringPki } from './fixtures/asset-wiring-pki.mjs';
import { runFixture, projectId as queuedProjectId, conversationId as queuedConversationId,
  servicePrincipal as queuedServicePrincipal } from './run-authority-fixture.mjs';

const projectId = 'sp_fixture_project', runGrantId = 'grant_fixture';
const reply = (ws, match, ms = 5000) => new Promise((resolve, reject) => {
  const cleanup = () => { clearTimeout(timer); ws.removeEventListener('message', receive); ws.removeEventListener('error', failure); ws.removeEventListener('close', failure); };
  const timer = setTimeout(() => { cleanup(); reject(Error('reply-timeout')); }, ms);
  function failure(event) { cleanup(); reject(event.error ?? Error(`transport-closed:${event.code ?? ''}`)); }
  function receive(event) { const value = JSON.parse(event.data); if (!match(value)) return;
    cleanup(); resolve(value); }
  ws.addEventListener('message', receive); ws.addEventListener('error', failure); ws.addEventListener('close', failure);
});

test('Agent data client signs real TLS WS/LP requests and closes owned sockets', { timeout: 30000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-agent-data-worker-'));
  const pki = assetWiringPki(dir), ledger = openAccountLedger({ file: path.join(dir, 'doc.db'), authorityId: 'worker-data-test' });
  const known = new WeakMap(), sockets = new Set(); let authSeq = 0, checkedFrames = 0, queryProofs = 0;
  let withholdProjectState = false, observedProjectOpen, sendLateProjectState;
  let projectOpenObserved = new Promise(resolve => { observedProjectOpen = resolve; });
  const principalOf = socket => {
    if (!known.has(socket)) known.set(socket, `tls-${++authSeq}`);
    return { service: 'agent', scope: 'service', authenticated: true,
      serviceKid: 'worker-kid', authenticationId: known.get(socket), socket };
  };
  const authority = createAgentInstanceAuthority({ ledger,
    verifyTransportInState(_state, principal) {
      return { serviceId: 'agent', serviceKid: 'worker-kid', authenticationId: principal.authenticationId,
        channelBinding: instanceTlsBinding(principal.socket) };
    } });
  const handler = createAgentInstanceInternalHandler({ instanceAuthority: authority,
    agentFingerprint256: pki.asset.fingerprint256, resolveServicePrincipal: ({ socket }) => principalOf(socket) });
  const service = createDocService({ autoTick: false, enableHttpTransport: true,
    authenticate: () => null,
    modules: [{ name: 'fixture', types: ['fixture.', 'selection.', 'project.'], handle(api, connId, frame) {
      if (withholdProjectState && frame.type === 'project.open') {
        sendLateProjectState = () => api.send(connId, { type: 'project.state', projectId: frame.projectId,
          rev: 1, body: { clips: [] } });
        observedProjectOpen(); return;
      }
      api.send(connId, { type: 'fixture.reply', reqId: frame.reqId, projectId });
    } }],
    async transportAuthenticate(req, _fallback, { internal }) {
      assert.equal(internal, true);
      const url = new URL(req.url, 'https://fixture.invalid'), base = principalOf(req.socket);
      const request = instanceConnectionRequest({ projectId: url.searchParams.get('projectId'),
        runGrantId: url.searchParams.get('runGrantId'),
        nonce: Number(url.searchParams.get('nonce')), purpose: 'run-connection', url: req.url,
        protocols: instanceProtocolHeaders(req.transportProtocolHeaders ?? req.headers),
        bodyText: req.transportBodyText ?? '' });
      let cap;
      try { cap = authority.authenticate({ servicePrincipal: base, method: req.method, path: url.pathname,
        operation: 'resolveRunPrincipal', request, proof: instanceRequestProof(req) }); }
      catch (error) { t.diagnostic(`fixture authenticate denied: ${error.code ?? error.message}`); throw error; }
      authority.release(cap.instanceSession);
      return { userId: 'fixture-agent', tenantId: request.projectId, projectId: request.projectId, realm: 'account', role: 'agent',
        identityVersion: 2, instanceId: cap.instanceId, instanceGeneration: cap.instanceGeneration };
    },
    async dispatchInvocation(input, next) {
      const { req, socket } = input.transport, url = new URL(req.url, 'https://fixture.invalid');
      const base = principalOf(socket);
      if (input.kind === 'resume') {
        const request = instanceConnectionRequest({ projectId: url.searchParams.get('projectId'),
          runGrantId: url.searchParams.get('runGrantId'),
          nonce: Number(url.searchParams.get('nonce')), purpose: 'run-resume', url: req.url,
          protocols: instanceProtocolHeaders(req.headers), bodyText: input.bodyText ?? '',
          sessionItem: input.sessionItem });
        const cap = authority.authenticate({ servicePrincipal: base, method: req.method, path: url.pathname,
          operation: 'checkAccess', request: { ...request, action: 'read' }, proof: instanceRequestProof(req) });
        authority.release(cap.instanceSession); return next();
      }
      let envelope, frame, bodyText = input.bodyText ?? '', request;
      if (input.transport.kind === 'ws') { envelope = JSON.parse(input.text); frame = envelope.frame;
        bodyText = ''; }
      else if (input.kind === 'message') {
        const sent = JSON.parse(Buffer.from(req.headers['x-promptcut-data-proof'], 'base64url').toString());
        envelope = sent.frames[input.frameIndex]; frame = JSON.parse(input.text);
      } else envelope = JSON.parse(Buffer.from(req.headers['x-promptcut-data-proof'], 'base64url').toString());
      request = instanceDataRequest({ projectId: input.transport.kind === 'ws' ? url.searchParams.get('projectId') : projectId,
        runGrantId: input.transport.kind === 'ws' ? url.searchParams.get('runGrantId') : runGrantId,
        connId: input.connId, nonce: envelope.nonce,
        kind: input.kind, url: req.url, protocols: instanceProtocolHeaders(req.headers), bodyText,
        ...(frame ? { text: JSON.stringify(frame) } : {}),
        ...(input.frameIndex !== undefined ? { frameIndex: input.frameIndex } : {}) });
      const action = frame?.type === 'project.op' ? 'write' : 'read';
      assert.equal(envelope.proofs.length, frame?.type === 'selection.query' ? 2 : 1);
      if (frame?.type === 'selection.query') queryProofs++;
      for (const proof of envelope.proofs) {
        const operation = proof.operation;
        if (operation === 'checkAccess') assert.equal(proof.action, action);
        const cap = authority.authenticate({ servicePrincipal: base,
          method: input.transport.kind === 'ws' ? 'WS' : req.method, path: url.pathname, operation,
          request: operation === 'checkAccess' ? { ...request, action } : request, proof });
        authority.release(cap.instanceSession);
      }
      checkedFrames++;
      return next(frame ? JSON.stringify(frame) : input.text, async () => {});
    } });
  const server = https.createServer({ ...pki.doc, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3' }, async (req, res) => {
    if (await handler(req, res)) return;
    if (service.handleTransportHttp(req, res)) return;
    res.writeHead(404); res.end('{}');
  });
  service.attachTransportServer(server);
  server.on('secureConnection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port, origin = `https://127.0.0.1:${port}`;
  const runClient = createRunClient({ origin, tls: pki.asset, serverFingerprint256: pki.doc.fingerprint256 });
  const data = createRunDataClient({ origin, tls: pki.asset, serverFingerprint256: pki.doc.fingerprint256, runClient });
  t.after(async () => { await data.close(); runClient.close(); await service.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    authority.close(); ledger.close(); fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(sockets.size, 0); t.diagnostic(`owned mTLS port=${port}; actual sockets closed`); });
  const WebSocketImpl = data.webSocketFor({ projectId, runGrantId });
  const ws = new WebSocketImpl(data.wsUrl, ['promptcut.v1', 'promptcut.session.new']);
  const welcomePromise = reply(ws, frame => frame.type === 'session.welcome');
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  const welcome = await welcomePromise; assert.equal(typeof welcome.connId, 'string');
  const one = reply(ws, frame => frame.reqId === 'first');
  ws.send(JSON.stringify({ type: 'fixture.echo', reqId: 'first', seq: 1, ack: 0 }));
  assert.equal((await one).type, 'fixture.reply');
  const openedProject = reply(ws, frame => frame.reqId === 'project-read');
  ws.send(JSON.stringify({ type: 'project.open', reqId: 'project-read', projectId, seq: 2, ack: 0 }));
  assert.equal((await openedProject).type, 'fixture.reply');
  const wroteProject = reply(ws, frame => frame.reqId === 'project-write');
  ws.send(JSON.stringify({ type: 'project.op', reqId: 'project-write', projectId, opId: 'fixture-op', seq: 3, ack: 0 }));
  assert.equal((await wroteProject).type, 'fixture.reply');
  const selection = reply(ws, frame => frame.reqId === 'query');
  ws.send(JSON.stringify({ type: 'selection.query', reqId: 'query', projectId, runGrantId, seq: 4, ack: 0 }));
  assert.equal((await selection).type, 'fixture.reply');
  assert.equal(queryProofs, 1);
  ws.terminate();
  const resumed = new WebSocketImpl(data.wsUrl, ['promptcut.v1', `promptcut.session.${welcome.sid}.0`]);
  const resumedWelcome = reply(resumed, frame => frame.type === 'session.welcome');
  await new Promise((resolve, reject) => { resumed.addEventListener('open', resolve); resumed.addEventListener('error', reject); });
  assert.equal((await resumedWelcome).connId, welcome.connId);
  const afterResume = reply(resumed, frame => frame.reqId === 'resumed');
  resumed.send(JSON.stringify({ type: 'fixture.echo', reqId: 'resumed', seq: 5, ack: 0 }));
  assert.equal((await afterResume).type, 'fixture.reply');
  assert.throws(() => ws.send(JSON.stringify({ type: 'fixture.echo', reqId: 'stale', seq: 6, ack: 0 })), /run-data-not-open/);
  await WebSocketImpl.closeOwned(); assert.equal(data.openCount(), 0);
  const lp = data.longPollFor({ projectId, runGrantId });
  const opened = await lp.open(); assert.equal(typeof opened.connId, 'string');
  const sent = await lp.send([JSON.stringify({ type: 'fixture.echo', reqId: 'lp', seq: 1, ack: 0 })]);
  assert.equal(sent.ack, 1);
  const lpRead = await lp.send([JSON.stringify({ type: 'project.open', reqId: 'lp-read', projectId, seq: 2, ack: 0 })]);
  assert.equal(lpRead.ack, 2);
  const lpWrite = await lp.send([JSON.stringify({ type: 'project.op', reqId: 'lp-write', projectId, opId: 'lp-op', seq: 3, ack: 0 })]);
  assert.equal(lpWrite.ack, 3);
  const received = await lp.recv({ ack: 0, wait: 0 });
  assert.equal(received.frames.some(text => JSON.parse(text).reqId === 'lp'), true);
  const lpResumed = await lp.open({ resume: { sid: opened.sid, ack: 0 } });
  assert.equal(lpResumed.connId, opened.connId);
  await lp.closeSession(); assert.ok(checkedFrames >= 5); assert.equal(data.openCount(), 0);

  // Counterexample: the transport has welcomed the Agent, but doc has not
  // supplied project.state. A private fence must close the real socket now,
  // before any model/tool work or control ACK.
  const queued = await runFixture(); queued.enqueue();
  const client = {
    admit: input => queued.provider.admit({ ...input, servicePrincipal: queuedServicePrincipal }),
    confirmRead: input => queued.provider.confirmRead({ ...input, servicePrincipal: queuedServicePrincipal }),
    queryRead: input => queued.provider.queryRead({ ...input, servicePrincipal: queuedServicePrincipal }),
    async checkAccess({ projectId: p, runGrantId: id, action }) {
      const principal = await queued.provider.resolveRunPrincipal({ servicePrincipal: queuedServicePrincipal,
        projectId: p, runGrantId: id });
      return queued.provider.checkAccess({ principal, projectId: p, action });
    },
    finish: input => queued.provider.finish({ ...input, servicePrincipal: queuedServicePrincipal }),
    pending: async () => ({ conversations: [] }),
  };
  let allowLateState;
  const lateState = new Promise(resolve => { allowLateState = resolve; });
  let modelCalls = 0, toolCalls = 0;
  const manager = createAccountRunManager({ runClient: client, readIntents: queued.intents,
    serviceKid: queued.agentProcess.registration.serviceKid,
    instanceId: queued.agentProcess.registration.instanceId,
    connectionsClosed: async () => data.openCount() === 0, childrenClosed: async () => true,
    runnerFactory: async ({ grant, signal }) => {
      const BoundWebSocket = data.webSocketFor(grant);
      const pendingSocket = new BoundWebSocket(data.wsUrl, ['promptcut.v1', 'promptcut.session.new']);
      try {
        await reply(pendingSocket, frame => frame.type === 'session.welcome');
        pendingSocket.send(JSON.stringify({ type: 'project.open', projectId: grant.projectId, seq: 1, ack: 0 }));
        await Promise.race([lateState, new Promise((_, reject) => {
          if (signal?.aborted) reject(Error('run-fenced'));
          signal?.addEventListener('abort', () => { void BoundWebSocket.closeOwned().then(() => reject(Error('run-fenced'))); }, { once: true });
        })]);
        return { async start() { modelCalls++; toolCalls++; return { done: Promise.resolve(), abort() {}, async drain() {} }; },
          close() { pendingSocket.terminate(); } };
      } catch (error) { await BoundWebSocket.closeOwned(); throw error; }
    } });
  withholdProjectState = true;
  const work = manager.wake(queuedProjectId, queuedConversationId).catch(() => {});
  try {
    await projectOpenObserved;
    const grant = Object.values(queued.ledger.read().runGrantsV2)[0];
    assert.equal(Object.keys(queued.ledger.read().runReceiptsV2).length, 1);
    queued.privateFence();
    const control = { kind: 'private', projectId: queuedProjectId, scope: { conversationId: queuedConversationId },
      operationFences: [{ runIds: [grant.runId] }] };
    const receipt = await Promise.race([manager.drainControl(control),
      new Promise(resolve => setTimeout(() => resolve(null), 300))]);
    assert.equal(receipt?.connectionsOpen, 0, 'private must close pending-bind TLS before receipt');
    assert.deepEqual(receipt.closedRunIds, [grant.runId]);
    assert.equal(data.openCount(), 0);
    assert.equal(modelCalls, 0); assert.equal(toolCalls, 0);
    sendLateProjectState(); allowLateState(); await work;
    assert.equal(modelCalls, 0); assert.equal(toolCalls, 0);
    const withoutWitness = createAccountRunManager({ runClient: client, readIntents: queued.intents,
      serviceKid: queued.agentProcess.registration.serviceKid,
      instanceId: queued.agentProcess.registration.instanceId, runnerFactory: async () => { throw Error('not-used'); } });
    const pendingReceipt = await withoutWitness.drainControl(control);
    assert.equal(pendingReceipt.connectionsOpen, 1);
    assert.equal(pendingReceipt.childrenOpen, 1);
    assert.equal(pendingReceipt.oldInstanceUnknown, true);
    withoutWitness.close();

    // Exercise the product factory's bind/ready cancellation separately from
    // the controlled manager adapter above. Its real Agent link must close the
    // signed socket even if the withheld project.state arrives after abort.
    projectOpenObserved = new Promise(resolve => { observedProjectOpen = resolve; });
    const actualFactory = createExistingHostedRunnerFactory({ root: process.cwd(),
      loadModule: async () => ({}), dataClient: data, dataDir: path.join(dir, 'agent'),
      modelConfig: async () => ({ vendor: 'mock', model: 'mock' }) });
    const storedMessage = queued.ledger.read().conversationsV2[queuedProjectId][queuedConversationId].messages[0];
    const controller = new AbortController();
    const binding = actualFactory({ grant, record: canonicalReadRecord(storedMessage, grant),
      onModelCall: async () => { modelCalls++; }, beforeToolCall: async () => { toolCalls++; },
      signal: controller.signal });
    await projectOpenObserved;
    controller.abort();
    await assert.rejects(binding, /run-fenced/);
    assert.equal(data.openCount(), 0);
    sendLateProjectState();
    assert.equal(modelCalls, 0); assert.equal(toolCalls, 0);
  } finally {
    allowLateState(); manager.close(); await data.close(); await work;
    queued.close(); fs.rmSync(queued.dir, { recursive: true, force: true });
  }
});
