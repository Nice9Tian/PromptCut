import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { assetWiringPki } from './fixtures/asset-wiring-pki.mjs';
import { openAccountLedger } from '../account/ledger.mjs';
import { createConversationAuthority, claimNextInState, markReadInState, finishInState } from '../account/conversation-authority.mjs';
import { createRunAuthority } from '../account/run-authority.mjs';
import { openReadIntents } from '../agent/service/read-intents.mjs';
import { createAccountRunManager } from '../agent/service/account-runner.mjs';
import { createRunControlServer } from '../agent-service/run-control.mjs';

const projectId = 'sp_' + 'a'.repeat(26), accountId = 'acc_' + 'b'.repeat(24);
const listen = (server, port) => new Promise((resolve, reject) => {
  server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
});
const close = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); });
function post(port, tls, body) {
  return new Promise((resolve, reject) => {
    const bytes = Buffer.from(JSON.stringify(body));
    const req = https.request(`https://127.0.0.1:${port}/internal/v2/agent/control`, {
      method: 'POST', key: tls.key, cert: tls.cert, ca: tls.ca, rejectUnauthorized: true,
      headers: { 'content-type': 'application/json', 'content-length': bytes.length },
    }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject); req.end(bytes);
  });
}

test('doc-pinned mTLS control waits for real socket and child closure; wrong cert and missing witness stay denied', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-agent-control-'));
  const pki = assetWiringPki(dir);
  const ledger = openAccountLedger({ file: path.join(dir, 'doc.sqlite'), authorityId: 'control-test' });
  ledger.transaction(state => { state.projects[projectId] = { status: 'active', creatorAccountId: accountId,
    members: { [accountId]: { access: 'rw' } }, bans: {}, hosted: { agent: true } }; });
  const servicePrincipal = { authenticated: 'temporary-agent-cert' };
  const run = createRunAuthority({ ledger, conversationHooks: { claimNextInState, markReadInState, finishInState },
    verifySender: async ref => ({ ...ref, accountEventSeq: 0 }),
    verifyServiceInState: (_state, source) => source === servicePrincipal ? { serviceId: 'agent', serviceKid: 'kid-fixture' } : null,
    synchronize: async () => {} });
  const principal = { authorizationId: 'valid', projectId, accountId, accountName: 'Alice',
    loginId: 'login-a', credentialId: 'credential-a', loginGeneration: 1 };
  const authority = createConversationAuthority({ ledger, accountAuthority: { authorizePrincipal: async () => principal },
    checkConsent: async () => ({ accountId, accepted: true, noticeVersion: 1 }),
    verifySelectionSnapshot: async () => ({ projectId, accountId, pageId: 'page_123',
      selection: { clipIds: [] }, sentAt: 100, source: 'sent-snapshot' }),
    runHooks: run.hooks, onFence: async input => ({ ack: true, ...input }) });
  const intents = openReadIntents({ file: path.join(dir, 'intents.sqlite') });
  const client = {
    admit: input => run.admit({ ...input, servicePrincipal }),
    confirmRead: input => run.confirmRead({ ...input, servicePrincipal }),
    queryRead: input => run.queryRead({ ...input, servicePrincipal }),
    async checkAccess({ projectId: p, runGrantId, action }) {
      const actor = await run.resolveRunPrincipal({ servicePrincipal, projectId: p, runGrantId });
      return run.checkAccess({ principal: actor, projectId: p, action });
    },
    finish: input => run.finish({ ...input, servicePrincipal }),
    pending: async () => ({ conversations: [] }),
  };
  let socket, server, child, childExited = false, socketClosed = false, started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const manager = createAccountRunManager({ runClient: client, readIntents: intents, serviceKid: 'kid-fixture', instanceId: 'instance-fixture',
    runnerFactory: async () => ({
      async start() {
        server = net.createServer(peer => { socket = peer; });
        await listen(server, 5796);
        const local = net.connect(5796, '127.0.0.1');
        await once(local, 'connect');
        child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
        await once(child, 'spawn');
        const done = new Promise(resolve => {
          const stop = async () => {
            local.destroy(); socket.destroy(); await close(server); socketClosed = true;
            child.kill(); await once(child, 'exit'); childExited = true; resolve();
          };
          this.stop = stop;
        });
        started();
        return { done, abort: () => { void this.stop(); }, async drain() { await done; return { dispatchesOpen: 0 }; } };
      }, close() {},
    }),
    connectionsClosed: async () => socketClosed && socket?.destroyed === true && server?.listening === false,
    childrenClosed: async () => childExited && (child?.exitCode !== null || child?.signalCode !== null),
  });
  const controlServer = createRunControlServer({ tls: pki.asset, docFingerprint256: pki.doc.fingerprint256,
    serviceKid: 'kid-fixture', instanceId: 'instance-fixture', manager });
  try {
    await listen(controlServer, 5795);
    await authority.send({ principalRef: { authorizationId: 'valid' }, projectId,
      conversationId: 'conv1', requestId: 'send1', content: 'Stop the live process' });
    const work = manager.wake(projectId, 'conv1');
    await startedPromise;
    const grant = Object.values(ledger.read().runGrantsV2)[0];
    assert.equal(grant.runId.length > 0, true);
    const control = { controlId: 'control-1', fenceRevision: 1, kind: 'stop', projectId,
      scope: { conversationId: 'conv1' }, operationFences: [{ runIds: [grant.runId] }] };
    const body = { control, targetInstanceId: 'instance-fixture', targetServiceKid: 'kid-fixture' };
    assert.equal((await post(5795, pki.wrong, body)).status, 403);
    assert.equal((await post(5795, pki.doc, { ...body, targetInstanceId: 'forged' })).status, 403);
    const receipt = await post(5795, pki.doc, body);
    assert.equal(receipt.status, 200);
    assert.equal(receipt.body.result.complete, true);
    assert.deepEqual(receipt.body.result.closedRunIds, [grant.runId]);
    assert.equal(childExited && socketClosed && socket.destroyed && !server.listening, true);
    await work;
    const missingWitness = createRunControlServer({ tls: pki.asset, docFingerprint256: pki.doc.fingerprint256,
      serviceKid: 'kid-fixture', instanceId: 'instance-fixture', manager: {
        drainControl: async () => ({ instanceId: 'instance-fixture', serviceKid: 'kid-fixture', closedRunIds: [grant.runId],
          dispatchesOpen: 0, connectionsOpen: 1, childrenOpen: 0, oldInstanceUnknown: false }),
      } });
    await listen(missingWitness, 5797);
    try { assert.equal((await post(5797, pki.doc, body)).status, 503); }
    finally { await close(missingWitness); }
  } finally {
    manager.close(); await close(controlServer);
    if (server?.listening) await close(server);
    if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
    intents.close(); ledger.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});
