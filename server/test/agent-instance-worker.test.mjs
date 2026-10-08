import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openAccountLedger } from '../account/ledger.mjs';
import { createAgentInstanceAuthority, instanceTlsBinding } from '../account/agent-instance-authority.mjs';
import { createAgentInstanceInternalHandler, instanceRequestProof } from '../account/agent-instance-internal.mjs';
import { createRunInternalServer } from '../account/run-internal.mjs';
import { assetWiringPki } from './fixtures/asset-wiring-pki.mjs';
import { startAgentService, AgentConfigError } from '../agent-service/main.mjs';

test('required account service uses doc conversation authority and keeps runner unmounted until data proof exists', { timeout: 30000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-agent-instance-entry-'));
  const calls = [];
  const conversationClient = {
    identity: async input => { calls.push(['identity', input]); return { accountId: 'acc-fixture', projectId: 'project-fixture',
      loginId: 'login-fixture', loginGeneration: 1 }; },
    access: async () => ({ allowed: true }), list: async () => ({ conversations: [] }), get: async () => ({ messages: [] }),
    send: async input => { calls.push(['send', input]); return { queued: true }; },
    switchVisibility: async () => ({}), stop: async () => ({}), rename: async () => ({}), close() {},
  };
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(startAgentService({ dataDir: dir, docUrl: 'ws://127.0.0.1:9999', port: 0,
    accountMode: true, conversationClient }), error => error instanceof AgentConfigError && error.reason === 'account-v2');
  const service = await startAgentService({ dataDir: dir, docUrl: 'wss://127.0.0.1:9999', port: 0,
    accountMode: true, conversationClient });
  t.after(async () => { await service.close(); });
  assert.equal(service.service.accountMode, true);
  assert.equal(service.service.describe().runAuthorityMounted, false);
  await service.service.send({ accountMode: true, accountId: 'acc-fixture', projectId: 'project-fixture',
    delegation: 'doc-opaque-fixture' }, 'conversation-fixture', { prompt: 'Queued until actual data proof' });
  assert.equal(calls.at(-1)[0], 'send');
  assert.equal(service.service.runManager, undefined);
});

test('Agent OS RAM keys register through actual mTLS; signed run requests bind exact socket/body/action and close', { timeout: 30000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-agent-instance-worker-'));
  const pki = assetWiringPki(dir);
  fs.writeFileSync(path.join(dir, 'doc.fingerprint'), pki.doc.fingerprint256);
  const ledger = openAccountLedger({ file: path.join(dir, 'doc.sqlite'), authorityId: 'worker-instance-test' });
  const sockets = new Map(), ids = new WeakMap(); let seq = 0, server, port, first = null, checkAction = null;
  let dropRegisterAck = true;
  const children = [];
  const principalOf = ({ socket }) => {
    let authenticationId = ids.get(socket);
    if (!authenticationId) { authenticationId = `auth-${++seq}`; ids.set(socket, authenticationId);
      sockets.set(authenticationId, socket); socket.once('close', () => sockets.delete(authenticationId)); }
    return { service: 'agent', serviceKid: 'worker-kid', authenticationId };
  };
  const instances = createAgentInstanceAuthority({ ledger, verifyTransportInState(_state, principal) {
    const socket = sockets.get(principal.authenticationId);
    return { serviceId: 'agent', serviceKid: principal.serviceKid,
      authenticationId: principal.authenticationId, channelBinding: instanceTlsBinding(socket) };
  } });
  const authority = {
    async admit(input) {
      const instance = instances.verifyInState(ledger.read(), input.servicePrincipal, { operation: 'admit', input });
      if (!first) first = instance;
      if (instance.instanceId !== first.instanceId || instance.instanceGeneration !== first.instanceGeneration)
        throw Object.assign(Error('old-grant-bound'), { status: 403, code: 'old-grant-bound' });
      return { instanceId: instance.instanceId, instanceGeneration: instance.instanceGeneration };
    },
    async confirmRead() { throw Error('unused'); }, async queryRead() { throw Error('unused'); },
    async finish() { throw Error('unused'); },
    async resolveRunPrincipal(input) {
      instances.verifyInState(ledger.read(), input.servicePrincipal, { operation: 'resolveRunPrincipal', input });
      throw Object.assign(Error('run-data-proof-unavailable'), { status: 503, code: 'run-data-proof-unavailable' });
    },
    async checkAccess(input) {
      instances.verifyInState(ledger.read(), input.principal.servicePrincipal, { operation: 'checkAccess', input });
      checkAction = input.action; return { allowed: true, runGrant: { runGrantId: input.principal.runGrantId } };
    },
  };
  server = createRunInternalServer({ tls: pki.doc, agentFingerprint256: pki.asset.fingerprint256,
    runAuthority: authority, resolveServicePrincipal: principalOf,
    authenticateInvocation({ req, servicePrincipal, body, operation }) {
      const cap = instances.authenticate({ servicePrincipal, method: req.method, path: req.url,
        operation, request: body, proof: instanceRequestProof(req) });
      return { servicePrincipal: { ...servicePrincipal, ...cap }, release: () => instances.release(cap.instanceSession) };
    }, principalForCheck: async input => {
      instances.verifyInState(ledger.read(), input.servicePrincipal, { operation: 'checkAccess', input });
      return { realm: 'account', identityVersion: 2, role: 'agent', creator: false, serviceId: 'agent',
        serviceKid: input.servicePrincipal.serviceKid, servicePrincipal: input.servicePrincipal,
        projectId: input.projectId, runGrantId: input.runGrantId };
    }, listPendingRuns: async () => ({ conversations: [] }) });
  const runs = server.listeners('request')[0]; server.removeAllListeners('request');
  const register = createAgentInstanceInternalHandler({ instanceAuthority: instances,
    agentFingerprint256: pki.asset.fingerprint256, resolveServicePrincipal: principalOf });
  server.on('request', async (req, res) => {
    if (dropRegisterAck && req.url === '/internal/v2/instances/register') {
      dropRegisterAck = false;
      let text = ''; for await (const chunk of req) text += chunk;
      instances.register({ ...JSON.parse(text), servicePrincipal: principalOf({ socket: req.socket }) });
      req.socket.destroy(); // Durable register committed; only its HTTP ACK is lost.
      return;
    }
    if (!await register(req, res)) await runs(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); port = server.address().port;
  async function child() {
    const process = fork(fileURLToPath(new URL('./agent-instance-worker-child.mjs', import.meta.url)), [dir, String(port)],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const closed = once(process, 'close'); children.push({ process, closed });
    let next = 0;
    return { process, closed, call: (action, input) => new Promise((resolve, reject) => {
      const id = ++next;
      const onMessage = message => { if (message.id !== id) return; process.off('message', onMessage);
        message.error ? reject(Object.assign(Error(message.error.code), message.error)) : resolve(message.result); };
      process.on('message', onMessage); process.send({ id, action, input });
    }) };
  }
  t.after(async () => {
    for (const item of children) if (item.process.connected) item.process.disconnect();
    for (const item of children) if (item.process.exitCode === null) item.process.kill();
    await Promise.all(children.map(item => item.closed));
    for (const socket of sockets.values()) socket.destroy();
    await new Promise(resolve => server.close(resolve)); instances.close(); ledger.close();
    fs.rmSync(dir, { recursive: true, force: true });
    t.diagnostic(`owned-port=${port}; active-tls-sockets=${sockets.size}; child-close-events=${children.length}`);
  });
  const old = await child();
  await assert.rejects(old.call('register'), e => e.status === 503 && e.code === 'run-client-unavailable');
  assert.equal(Object.keys(ledger.read().agentInstancesV2).length, 1, 'lost ACK was after durable registration');
  const one = await old.call('register');
  assert.equal(one.serviceId, 'agent');
  assert.deepEqual(await old.call('register'), one, 'same process retries registration without a new key');
  const admitted = await old.call('admit', { projectId: 'project-a', conversationId: 'conversation-a', requestId: 'first' });
  assert.equal(admitted.instanceId, one.instanceId);
  assert.deepEqual(await old.call('pending'), { conversations: [] });
  await assert.rejects(old.call('check', { projectId: 'project-a', runGrantId: 'grant-a' }), e => e.status === 400 && e.code === 'invalid-run-action');
  assert.equal((await old.call('check', { projectId: 'project-a', runGrantId: 'grant-a', action: 'read' })).allowed, true);
  assert.equal(checkAction, 'read');
  assert.equal((await old.call('check', { projectId: 'project-a', runGrantId: 'grant-a', action: 'write' })).allowed, true);
  assert.equal(checkAction, 'write');
  assert.equal(sockets.size, 0, 'HTTP client resolves only after actual TLS close');
  const next = await child(), two = await next.call('register');
  assert.notEqual(two.instanceId, one.instanceId);
  assert.ok(two.instanceGeneration > one.instanceGeneration);
  await assert.rejects(next.call('admit', { projectId: 'project-a', conversationId: 'conversation-a', requestId: 'first' }),
    e => e.status === 403 && e.code === 'old-grant-bound');
  assert.equal((await old.call('admit', { projectId: 'project-a', conversationId: 'conversation-a', requestId: 'next' })).instanceId, one.instanceId);
  await old.call('close'); await next.call('close');
  assert.equal((await old.closed)[0], 0); assert.equal((await next.closed)[0], 0);
  assert.equal(sockets.size, 0);
  t.diagnostic('two independent Agent OS processes used distinct RAM keys; old OS could continue, new OS could not inherit its bound grant');
});
