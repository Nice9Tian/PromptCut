import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { openAccountLedger } from '../account/ledger.mjs';
import { certificateFingerprint } from '../account/client.mjs';
import { createAgentInstanceAuthority, instanceTlsBinding } from '../account/agent-instance-authority.mjs';
import { createAgentInstanceInternalHandler, instanceRequestProof } from '../account/agent-instance-internal.mjs';
import { createAgentReadControl, createAgentReadControlHandler } from '../account/agent-read-control.mjs';
import { createConversationAuthority, conversationReadInState, claimNextInState, markReadInState, finishInState } from '../account/conversation-authority.mjs';
import { createConversationInternalHandler } from '../account/conversation-internal.mjs';
import { createRunAuthority } from '../account/run-authority.mjs';
import { createRunInternalHandler } from '../account/run-internal.mjs';
import { createConversationClient } from '../agent-service/conversation-client.mjs';
import { createConversationControlClient } from '../agent-service/conversation-control-client.mjs';
import { createRunClient } from '../agent-service/run-client.mjs';
import { createAccountExecutorAssembly } from '../agent-service/account-executor-assembly.mjs';
import { createAgentHttp } from '../agent-service/http.mjs';
import { assetWiringPki } from './fixtures/asset-wiring-pki.mjs';

// Actual doc SQLite/RAM registration/exporter proof/read inventory/HTTP/SSE.
// Account verification, selection, service registry and model/tool driver are
// controlled adapters. This is not VH, actual model, WSS data or OS-tree proof.
test('one registered RAM instance assembles real mTLS run/read clients; POST mirrors doc original and SSE replays durable eventSeq',
  { timeout: 30000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-account-executor-mtls-'));
    const pki = assetWiringPki(dir), sockets = new Set(), subjects = new Map(), socketIds = new WeakMap();
    const ledger = openAccountLedger({ file: path.join(dir, 'doc.sqlite'), authorityId: 'executor-doc' });
    const projectId = 'sp_' + 'a'.repeat(26), accountId = 'acc_' + 'b'.repeat(24), conversationId = 'conversation_a';
    ledger.transaction(s => { s.projects[projectId] = { status: 'active', creatorAccountId: accountId,
      members: { [accountId]: { access: 'rw' } }, bans: {}, hosted: { agent: true } }; });
    const actor = { projectId, accountId, accountName: 'Controlled actor', loginId: 'login_a',
      credentialId: 'credential_a', loginGeneration: 1, authorizationId: 'controlled' };
    const resolveDelegation = async ticket => {
      if (ticket !== 'controlled-delegation') throw Object.assign(Error('delegation-forbidden'), { status: 403 });
      return { authorizationId: 'controlled', projectId };
    };
    const accountAuthority = { authorizePrincipal: async () => actor };
    const principalOf = ({ socket }) => {
      assert.equal(socket.authorized, true);
      assert.equal(certificateFingerprint(socket.getPeerCertificate().fingerprint256), certificateFingerprint(pki.asset.fingerprint256));
      if (!socketIds.has(socket)) { const id = randomUUID(); socketIds.set(socket, id); subjects.set(id, socket);
        socket.once('close', () => subjects.delete(id)); }
      return { service: 'agent', serviceKid: 'controlled-agent-kid', authenticationId: socketIds.get(socket) };
    };
    const instances = createAgentInstanceAuthority({ ledger, verifyTransportInState(_s, p) {
      const socket = subjects.get(p.authenticationId);
      if (!socket || socket.destroyed) throw Error('actual-tls-closed');
      return { serviceId: 'agent', serviceKid: p.serviceKid, authenticationId: p.authenticationId,
        channelBinding: instanceTlsBinding(socket) };
    } });
    const reads = createAgentReadControl({ ledger, instanceAuthority: instances,
      authorizeRead: async body => { await resolveDelegation(body.delegation); return actor; },
      checkReadInState: conversationReadInState });
    const run = createRunAuthority({ ledger, instanceAuthority: instances,
      conversationHooks: { claimNextInState, markReadInState, finishInState },
      verifySender: async ref => ({ ...ref, accountEventSeq: 0 }), synchronize: async () => {},
      verifyServiceInState: (_s, p) => ({ serviceId: 'agent', serviceKid: p.serviceKid }) });
    const conversations = createConversationAuthority({ ledger, accountAuthority,
      checkConsent: async () => ({ accountId, accepted: true, noticeVersion: 1 }),
      verifySelectionSnapshot: async () => ({ projectId, accountId, pageId: 'page_a',
        selection: { clipIds: [] }, sentAt: Date.now(), source: 'sent-snapshot' }),
      runHooks: { ...run.hooks, fenceInState(state, input) {
        reads.hooks.fenceInState(state, input); return run.hooks.fenceInState(state, input);
      } }, onFence: async () => { throw Object.assign(Error('closure-producer-unavailable'), { status: 503 }); } });
    const handlers = [
      createAgentInstanceInternalHandler({ instanceAuthority: instances, agentFingerprint256: pki.asset.fingerprint256, resolveServicePrincipal: principalOf }),
      createAgentReadControlHandler({ control: reads, instanceAuthority: instances, resolveServicePrincipal: principalOf }),
      createConversationInternalHandler({ conversationAuthority: conversations, requireReadControl: true,
        agentFingerprint256: pki.asset.fingerprint256, resolveDelegation }),
      createRunInternalHandler({ runAuthority: run, agentFingerprint256: pki.asset.fingerprint256,
        resolveServicePrincipal: principalOf,
        authenticateInvocation({ req, servicePrincipal, body, operation }) {
          const cap = instances.authenticate({ servicePrincipal, method: req.method, path: req.url,
            operation, request: body, proof: instanceRequestProof(req) });
          return { servicePrincipal: { ...servicePrincipal, ...cap }, release: () => instances.release(cap.instanceSession) };
        }, principalForCheck({ projectId: p, runGrantId, servicePrincipal }) {
          const g = ledger.read().runGrantsV2[runGrantId];
          return { ...g, realm: 'account', identityVersion: 2, role: 'agent', creator: false,
            serviceId: 'agent', projectId: p, servicePrincipal };
        }, listPendingRuns: async () => ({ conversations: [] }) }),
    ];
    const docServer = https.createServer({ ...pki.doc, requestCert: true, rejectUnauthorized: true }, async (req, res) => {
      for (const handle of handlers) if (await handle(req, res)) return;
      res.writeHead(404); res.end();
    });
    const track = server => server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    track(docServer);
    const listen = (server, port) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    let assembly, publicServer, controlClient, client, runClient;
    const abort = new AbortController(); let models = 0, tools = 0, failure = null;
    const diagnostics = [];
    try {
      await listen(docServer, 6640);
      const doc = { origin: 'https://127.0.0.1:6640', tls: pki.asset, serverFingerprint256: pki.doc.fingerprint256 };
      client = createConversationClient(doc); runClient = createRunClient(doc);
      controlClient = createConversationControlClient({ ...doc, runClient, receiptFile: path.join(dir, 'read-closures.sqlite') });
      client.useReadControl(controlClient);
      assembly = await createAccountExecutorAssembly({ dataDir: dir, doc, runClient, conversationClient: client, readControl: controlClient,
        controlPort: 6642, root: dir, loadModule: async () => { throw Error('no-real-model-module'); }, modelConfig: async () => ({}),
        log: (event, fields) => diagnostics.push({ event, code: fields.code }),
        runnerFactory: async ({ onEvent, onModelCall, beforeToolCall }) => ({ async start() {
          onEvent({ type: 'run' }); await onModelCall(); models++;
          onEvent({ type: 'text', delta: 'Controlled result' });
          onEvent({ type: 'tool_call', name: 'get_project' }); await beforeToolCall(); tools++;
          onEvent({ type: 'tool_result', output: 'private-result' }); onEvent({ type: 'done' });
          return { done: Promise.resolve(), abort() {} };
        }, async drain() {}, close() {} }) });
      const api = createAgentHttp({ service: assembly.service, authenticate: async req => req.headers.authorization === 'Bearer controlled-delegation'
        ? { accountMode: true, delegation: 'controlled-delegation', projectId, accountId, userId: accountId } : null });
      publicServer = http.createServer((req, res) => { void api.handle(req, res); }); track(publicServer); await listen(publicServer, 6641);
      const base = `http://127.0.0.1:6641/v1/conversations/${conversationId}`, headers = { Authorization: 'Bearer controlled-delegation', 'Content-Type': 'application/json' };
      const response = await fetch(base + '/messages', { method: 'POST', headers, body: JSON.stringify({ prompt: 'Doc accepted original', requestId: 'send_a' }) });
      assert.equal(response.status, 202); const accepted = await response.json();
      assert.ok(Number.isSafeInteger(accepted.queuePosition) && accepted.queuePosition >= 1);
      assert.equal(accepted.runId, null);
      const deadline = Date.now() + 5000;
      while (assembly.service.runEvents.after({ projectId, conversationId }).head < 6) {
        if (Date.now() >= deadline) throw Error('durable-events-timeout'); await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(models, 1); assert.equal(tools, 1);
      const rows = assembly.service.runEvents.after({ projectId, conversationId }).events;
      assert.equal(rows[0].event.type, 'user'); assert.equal(rows[0].event.prompt, 'Doc accepted original');
      assert.equal(rows.filter(r => r.event.type === 'user').length, 1);
      assert.equal(rows.at(-1).event.type, 'runner_done'); assert.equal(rows.at(-1).event.settlement, 'pending');
      assert.equal(rows.find(r => r.event.type === 'tool_result').event.output, undefined);
      const grant = Object.values(ledger.read().runGrantsV2)[0];
      assert.equal(grant.instanceId, assembly.identity.instanceId); assert.equal(grant.state, 'active');
      assert.equal(ledger.read().conversationsV2[projectId][conversationId].currentRunId, grant.runId);
      const stream = await fetch(base + '/events?after=1', { headers, signal: abort.signal }); assert.equal(stream.status, 200);
      let bytes = ''; const reader = stream.body.getReader();
      while (!bytes.includes('runner_done')) { const chunk = await reader.read(); assert.equal(chunk.done, false); bytes += new TextDecoder().decode(chunk.value); }
      const replay = bytes.split('\n').filter(s => s.startsWith('data: ')).map(s => JSON.parse(s.slice(6))).filter(row => Number.isSafeInteger(row.seq));
      assert.deepEqual(replay.map(row => row.seq), rows.slice(1).map(row => row.eventSeq));
      assert.equal(replay.some(row => row.type === 'user'), false); abort.abort(); await reader.cancel().catch(() => {});
      while (!diagnostics.some(row => row.event === 'agent.account.run.pending' && row.code === 'run-outcome-unavailable')) {
        if (Date.now() >= deadline) throw Error('actual-driver-drain-timeout'); await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(assembly.service.runManager.describe().activeRuns, 0);
      assert.equal(assembly.describe().completionReady, false);
    } catch (error) { failure = error;
    } finally {
      abort.abort();
      if (publicServer?.listening) { publicServer.closeAllConnections(); await new Promise(resolve => publicServer.close(resolve)); }
      // A rejected owned close must not skip any later server/socket/db cleanup.
      // Inspect every result, retain the primary assertion, and fail on cleanup.
      // Assembly exclusively owns its read client. Concurrently closing the
      // same SQLite receipt store twice is not an independent closure witness.
      const results = await Promise.allSettled([assembly ? assembly.close() : controlClient?.close()]);
      const errors = results.filter(row => row.status === 'rejected').map(row => row.reason);
      client?.close(); runClient?.close(); reads.close();
      await Promise.all([...sockets].map(socket => new Promise(resolve => { socket.once('close', resolve); socket.destroy(); })));
      if (docServer.listening) await new Promise(resolve => docServer.close(resolve));
      instances.close(); ledger.close(); assert.equal(sockets.size, 0); fs.rmSync(dir, { recursive: true, force: true });
      if (failure) { if (errors.length) failure.cleanupErrors = errors; throw failure; }
      if (errors.length) throw new AggregateError(errors, 'fixture-owned-close-failed');
    }
  });
