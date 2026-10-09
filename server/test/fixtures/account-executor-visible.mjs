import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { openAccountLedger } from '../../account/ledger.mjs';
import { certificateFingerprint } from '../../account/client.mjs';
import { createAgentInstanceAuthority, instanceTlsBinding } from '../../account/agent-instance-authority.mjs';
import { createAgentInstanceInternalHandler, instanceRequestProof } from '../../account/agent-instance-internal.mjs';
import { createAgentReadControl, createAgentReadControlHandler } from '../../account/agent-read-control.mjs';
import { createConversationAuthority, conversationReadInState, claimNextInState, markReadInState, finishInState } from '../../account/conversation-authority.mjs';
import { createConversationInternalHandler } from '../../account/conversation-internal.mjs';
import { createRunAuthority } from '../../account/run-authority.mjs';
import { createRunInternalHandler } from '../../account/run-internal.mjs';
import { createConversationClient } from '../../agent-service/conversation-client.mjs';
import { createConversationControlClient } from '../../agent-service/conversation-control-client.mjs';
import { createRunClient } from '../../agent-service/run-client.mjs';
import { createAccountExecutorAssembly } from '../../agent-service/account-executor-assembly.mjs';
import { createAgentHttp } from '../../agent-service/http.mjs';
import { assetWiringPki } from './asset-wiring-pki.mjs';

// Controlled actor/service registry/selection/model/tool driver; real doc SQLite,
// RAM instance key/exporter proof/read inventory, Agent HTTP and durable SSE.
// This helper cannot prove VH, an actual model, data WS or OS-tree closure.
export async function startAccountExecutorVisibleFixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-account-executor-visible-'));
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
    let models = 0, tools = 0, closing; const diagnostics = [];
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
          onEvent({ type: 'tool_call', name: 'get_project', callId: 'visible_call' }); await beforeToolCall(); tools++;
          onEvent({ type: 'tool_result', name: 'get_project', callId: 'visible_call', ok: true, summary: 'Controlled project read', output: 'private-result' }); onEvent({ type: 'done' });
          return { done: Promise.resolve(), abort() {} };
        }, async drain() {}, close() {} }) });
      const api = createAgentHttp({ service: assembly.service, authenticate: async req => req.headers.authorization === 'Bearer controlled-delegation'
        ? { accountMode: true, delegation: 'controlled-delegation', projectId, accountId, userId: accountId } : null });
      publicServer = http.createServer((req, res) => { void api.handle(req, res); }); track(publicServer); await listen(publicServer, 6641);

      return { origin: 'http://127.0.0.1:6641', projectId, conversationId, ports: [6640, 6641, 6642],
        ticket: 'controlled-delegation', close, rows: () => assembly.service.runEvents.after({ projectId, conversationId }),
        describe: () => ({ ...assembly.describe(), models, tools, sockets: sockets.size,
          activeRuns: assembly.service.runManager.describe().activeRuns,
          grants: Object.values(ledger.read().runGrantsV2).map(g => ({ runId: g.runId, state: g.state })) }) };
    } catch (error) { await close().catch(closeError => { error.cleanupCode = closeError.code ?? closeError.name; }); throw error; }
    async function close() {
      if (closing) return closing;
      closing = (async () => {
        if (publicServer?.listening) { publicServer.closeAllConnections(); await new Promise(resolve => publicServer.close(resolve)); }
        const results = await Promise.allSettled([assembly ? assembly.close() : controlClient?.close()]);
        const errors = results.filter(r => r.status === 'rejected').map(r => r.reason);
        client?.close(); runClient?.close(); reads.close();
        await Promise.all([...sockets].map(socket => new Promise(resolve => { socket.once('close', resolve); socket.destroy(); })));
        if (docServer.listening) await new Promise(resolve => docServer.close(resolve));
        instances.close(); ledger.close();
        assert.equal(sockets.size, 0); fs.rmSync(dir, { recursive: true, force: true });
        if (errors.length) throw new AggregateError(errors, 'visible-fixture-owned-close-failed');
        return { closed: true, sockets: 0, ports: [6640, 6641, 6642] };
      })();
      return closing;
    }
}
