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
import { assetWiringPki } from './fixtures/asset-wiring-pki.mjs';

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
      api.send(connId, { type: 'fixture.reply', reqId: frame.reqId, projectId });
    } }],
    async transportAuthenticate(req, _fallback, { internal }) {
      assert.equal(internal, true);
      const url = new URL(req.url, 'https://fixture.invalid'), base = principalOf(req.socket);
      const request = instanceConnectionRequest({ projectId, runGrantId,
        nonce: Number(url.searchParams.get('nonce')), purpose: 'run-connection', url: req.url,
        protocols: instanceProtocolHeaders(req.transportProtocolHeaders ?? req.headers),
        bodyText: req.transportBodyText ?? '' });
      let cap;
      try { cap = authority.authenticate({ servicePrincipal: base, method: req.method, path: url.pathname,
        operation: 'resolveRunPrincipal', request, proof: instanceRequestProof(req) }); }
      catch (error) { t.diagnostic(`fixture authenticate denied: ${error.code ?? error.message}`); throw error; }
      authority.release(cap.instanceSession);
      return { userId: 'fixture-agent', tenantId: projectId, projectId, realm: 'account', role: 'agent',
        identityVersion: 2, instanceId: cap.instanceId, instanceGeneration: cap.instanceGeneration };
    },
    async dispatchInvocation(input, next) {
      const { req, socket } = input.transport, url = new URL(req.url, 'https://fixture.invalid');
      const base = principalOf(socket);
      if (input.kind === 'resume') {
        const request = instanceConnectionRequest({ projectId, runGrantId,
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
      request = instanceDataRequest({ projectId, runGrantId, connId: input.connId, nonce: envelope.nonce,
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
});
