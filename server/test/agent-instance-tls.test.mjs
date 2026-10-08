import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { openAccountLedger } from '../account/ledger.mjs';
import { createAgentInstanceAuthority, instanceTlsBinding } from '../account/agent-instance-authority.mjs';
import { assetWiringPki } from './fixtures/asset-wiring-pki.mjs';

test('real mTLS exporters match; new socket/OS replay denied; live original key survives doc restart; actual child close required', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-instance-tls-')), pki = assetWiringPki(dir);
  let ledger = openAccountLedger({ file: path.join(dir, 'doc.db'), authorityId: 'tls-instance-test' });
  const connections = new WeakMap(), sockets = new Set(); let connectionSeq = 0, currentKid = true;
  const verifyTransportInState = (_state, principal) => {
    const socket = principal?.socket;
    if (!currentKid || !socket || socket.getPeerCertificate().fingerprint256 !== pki.asset.fingerprint256)
      throw Object.assign(new Error('current-key-required'), { status: 403, code: 'current-key-required' });
    return { serviceId: 'agent', serviceKid: 'test-agent-kid', authenticationId: connections.get(socket),
      channelBinding: instanceTlsBinding(socket) };
  };
  const closedInstances = new Set();
  const makeAuthority = () => createAgentInstanceAuthority({ ledger, verifyTransportInState,
    verifyClosureWitnessInState: (_state, record, witness) => witness.resourceKind === 'owned-child-close' &&
      closedInstances.has(record.instanceId) });
  let authority = makeAuthority();
  const server = https.createServer({ ...pki.doc, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3' }, async (req, res) => {
    const servicePrincipal = { socket: req.socket }; let cap;
    try {
      let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw);
      let answer;
      if (req.url === '/begin') answer = { challenge: authority.beginRegistration({ servicePrincipal, ...body }) };
      else if (req.url === '/register') answer = { registration: authority.register({ servicePrincipal, ...body }) };
      else {
        const proof = JSON.parse(Buffer.from(req.headers['x-test-instance-proof'], 'base64url').toString());
        cap = authority.authenticate({ servicePrincipal, method: req.method, path: req.url, operation: 'admit', request: body, proof });
        answer = { verified: authority.verifyInState(ledger.read(), { ...servicePrincipal, ...cap }, { operation: 'admit', input: body }) };
      }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(answer));
    } catch (error) { res.writeHead(error.status ?? 500); res.end(JSON.stringify({ code: error.code ?? 'fixture-handler-failed' })); }
    finally { if (cap) authority.release(cap.instanceSession); }
  });
  server.on('secureConnection', socket => { connections.set(socket, `tls-${++connectionSeq}`); sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port;
  const children = [];
  async function child() {
    const process = fork(fileURLToPath(new URL('./agent-instance-tls-child.mjs', import.meta.url)), [dir, String(port)],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const closed = once(process, 'close'); children.push({ process, closed });
    await once(process, 'message'); let requestSeq = 0;
    const call = command => new Promise((resolve, reject) => {
      const id = ++requestSeq;
      const receive = message => { if (message.id !== id) return; process.off('message', receive);
        if (message.error) reject(new Error(message.error)); else resolve(message.result); };
      process.on('message', receive); process.send({ id, ...command });
    });
    return { call, process, closed };
  }
  t.after(async () => {
    for (const item of children) { if (item.process.exitCode === null && item.process.connected) item.process.disconnect(); }
    await Promise.all(children.map(item => item.closed));
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve)); authority.close(); ledger.close(); fs.rmSync(dir, { recursive: true });
  });
  const old = await child(), registration = await old.call({ kind: 'register', requestId: 'boot-one' });
  assert.equal(registration.status, 200); assert.equal(registration.duplicateSame, true);
  const input = { projectId: 'project', conversationId: 'conversation', requestId: 'admit-one' };
  const first = await old.call({ kind: 'call', request: input }); assert.equal(first.status, 200);
  assert.equal((await old.call({ kind: 'call', request: input, replay: true })).status, 403);
  assert.equal((await old.call({ kind: 'call', request: input })).status, 200); // same process, new TLS
  authority.close(); ledger.close(); ledger = openAccountLedger({ file: path.join(dir, 'doc.db'), authorityId: 'tls-instance-test' }); authority = makeAuthority();
  assert.equal((await old.call({ kind: 'call', request: input })).status, 200); // same live key, recovered doc
  const next = await child(), nextRegistration = await next.call({ kind: 'register', requestId: 'boot-two' });
  assert.equal(nextRegistration.registration.instanceGeneration, registration.registration.instanceGeneration + 1);
  assert.equal((await next.call({ kind: 'call', request: input, target: registration.registration })).status, 403);
  currentKid = false; assert.equal((await old.call({ kind: 'call', request: input })).status, 403); currentKid = true;
  ledger.transaction(state => authority.fenceInState(state, { ...registration.registration, requestId: 'shutdown-one', reason: 'shutdown' }));
  const witness = { ...registration.registration, witnessId: 'owned-close-one', complete: true, resourceKind: 'owned-child-close' };
  assert.throws(() => authority.confirmClosed({ ...registration.registration, witness }), /instance-closure-unverified/);
  await old.call({ kind: 'stop' }); const [exitCode] = await old.closed; assert.equal(exitCode, 0);
  closedInstances.add(registration.registration.instanceId);
  assert.equal(authority.confirmClosed({ ...registration.registration, witness }).state, 'closed');
  await next.call({ kind: 'stop' }); assert.equal((await next.closed)[0], 0);
  t.diagnostic('Two real Agent child processes closed with exit 0; TLS connection replay rejected; no key/proof/exporter values emitted.');
});
