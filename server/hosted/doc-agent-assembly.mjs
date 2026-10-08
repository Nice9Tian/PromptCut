import { randomUUID } from 'node:crypto';
import { accountError, certificateFingerprint } from '../account/client.mjs';
import { createConversationAuthority } from '../account/conversation-authority.mjs';
import { createConversationInternalHandler } from '../account/conversation-internal.mjs';
import { createRunAuthority } from '../account/run-authority.mjs';
import { createRunInternalHandler } from '../account/run-internal.mjs';
import { createAgentInstanceAuthority, instanceTlsBinding } from '../account/agent-instance-authority.mjs';
import { createAgentInstanceInternalHandler, instanceRequestProof } from '../account/agent-instance-internal.mjs';
import { createAssetMtlsTransport } from './asset-doc-client.mjs';

const fail = (status, code) => { throw accountError(status, code); };

/** Compose the already verified authorities in the doc's ONE durable ledger.
 * The registry and certificate supply a service subject; no request supplies an
 * actor, project permission, instance generation or resource-close evidence.
 */
export function createDocAgentAssembly({ ledger, accountClient, account, runtime, serviceRegistry,
  getDocAssembly, getService, now = Date.now, onDiagnostic = () => {} } = {}) {
  const pin = certificateFingerprint(account?.agent?.fingerprint256);
  const kid = account?.agent?.serviceKid;
  if (!/^[a-f0-9]{64}$/.test(pin) || typeof kid !== 'string' || !kid || !ledger?.transaction ||
      !runtime?.authority || typeof accountClient?.verifyAcceptedMessage !== 'function' ||
      typeof getDocAssembly !== 'function' || typeof getService !== 'function') fail(503, 'doc-agent-configuration');
  const docInstanceId = runtime.docInstanceId, subjects = new Map(), sockets = new WeakMap(), deliveries = new Map();
  const transport = createAssetMtlsTransport({ origin: account.origin, tls: account.clientTls,
    serverFingerprint256: account.serverFingerprint256 });
  let stopped = false, runAuthority;
  const currentService = () => {
    if (stopped) fail(503, 'doc-agent-unavailable');
    try { serviceRegistry?.refresh({ force: true }); } catch { fail(403, 'run-service-forbidden'); }
    const entry = serviceRegistry?.get('agent');
    if (entry?.role !== 'agent' || entry.actsFor !== 'member' || !entry.keys.some(key => key.kid === kid))
      fail(403, 'run-service-forbidden');
  };
  const resolveServicePrincipal = ({ socket }) => {
    if (!socket?.encrypted || socket.authorized !== true || socket.destroyed ||
        certificateFingerprint(socket.getPeerCertificate?.()?.fingerprint256) !== pin) fail(403, 'run-service-forbidden');
    currentService();
    instanceTlsBinding(socket); // exporter is taken only from the real peer socket.
    let subject = sockets.get(socket);
    if (!subject) {
      const authenticationId = randomUUID();
      subject = { service: 'agent', serviceKid: kid, authenticationId };
      sockets.set(socket, subject); subjects.set(authenticationId, socket);
      socket.once('close', () => { subjects.delete(authenticationId); sockets.delete(socket); });
    }
    return structuredClone(subject);
  };
  const verifyServiceInState = (_state, subject) => {
    currentService();
    const socket = subjects.get(subject?.authenticationId);
    if (!socket || subject.service !== 'agent' || subject.serviceKid !== kid || socket.destroyed ||
        socket.authorized !== true || certificateFingerprint(socket.getPeerCertificate?.()?.fingerprint256) !== pin)
      fail(403, 'run-service-forbidden');
    return { serviceId: 'agent', serviceKid: kid };
  };
  const instanceAuthority = createAgentInstanceAuthority({ ledger,
    verifyTransportInState(state, subject) {
      const service = verifyServiceInState(state, subject);
      return { ...service, authenticationId: subject.authenticationId,
        channelBinding: instanceTlsBinding(subjects.get(subject.authenticationId)) };
    } });
  // Operation and doc-transport closure are real partial evidence. Until the
  // registered Agent instance/resource witness exists, no control is ACKed.
  async function deliver(control) {
    if (deliveries.has(control.controlId)) return deliveries.get(control.controlId);
    const pending = (async () => {
      const persisted = ledger.read().runControlsV2?.[control.controlId];
      if (!persisted || persisted.payloadDigest !== control.payloadDigest || persisted.fenceRevision !== control.fenceRevision)
        fail(403, 'run-control-mismatch');
      const doc = getDocAssembly(), service = getService();
      if (!doc || !service) fail(503, 'doc-agent-unavailable');
      const operationReceipts = [];
      for (const fence of persisted.operationFences ?? []) operationReceipts.push(await doc.fence(fence));
      const closed = persisted.revoked.length ? await service.fencePrincipals({ runGrantIds: persisted.revoked, roles: ['agent'] }) : null;
      ledger.transaction(state => {
        const current = state.runControlsV2?.[control.controlId];
        if (!current || current.payloadDigest !== persisted.payloadDigest || current.fenceRevision !== persisted.fenceRevision)
          fail(403, 'run-control-mismatch');
        const record = (state.docRunClosuresV2 ??= {})[control.controlId] ??= {
          controlId: control.controlId, fenceRevision: control.fenceRevision, instances: {} };
        record.instances[docInstanceId] ??= { docInstanceId, operationReceipts, closed,
          // This is deliberately not a complete receipt or old-instance proof.
          complete: false, agentState: 'resource-closure-required', recordedAt: now() };
      });
      return { pending: true, controlId: control.controlId };
    })();
    deliveries.set(control.controlId, pending);
    try { return await pending; } finally { deliveries.delete(control.controlId); }
  }
  const runHooks = { fenceInState: (state, fence) => runAuthority.hooks.fenceInState(state, fence) };
  const conversations = createConversationAuthority({ ledger, accountAuthority: runtime.authority, runHooks, now,
    async checkConsent({ accountId }) {
      const answer = await transport.request('GET', `/internal/v2/consents?accountId=${encodeURIComponent(accountId)}`);
      if (answer.accountId !== accountId || typeof answer.accepted !== 'boolean' || answer.noticeVersion !== 1)
        fail(503, 'consent-protocol');
      return { accountId, accepted: answer.accepted, noticeVersion: answer.noticeVersion };
    },
    verifySelectionSnapshot: input => {
      const doc = getDocAssembly(); if (!doc) fail(503, 'selection-unavailable');
      return doc.captureSnapshot(input);
    },
    async onFence(input) {
      const controls = await runAuthority.synchronize();
      for (const control of controls.filter(control => control.projectId === input.projectId &&
        control.scope.conversationId === input.conversationId && (!input.runId || control.scope.runId === input.runId))) await deliver(control);
      // Neither an empty local manager nor a body instanceId proves old resources
      // closed. The conversation change remains durable and pending for retry.
      fail(503, 'agent-fence-pending');
    },
  });
  runAuthority = createRunAuthority({ ledger, conversationHooks: conversations.hooks,
    verifyServiceInState, instanceAuthority, now, synchronize: () => runtime.authority.synchronize(),
    async verifySender(ref, context) {
      const checked = await accountClient.verifyAcceptedMessage(ref, context);
      await runtime.authority.synchronize();
      if (ledger.read().accountHead < checked.accountEventSeq) fail(503, 'account-event-gap');
      return checked;
    },
    onControl: control => { void deliver(control).catch(error => onDiagnostic({ code: error.code ?? 'run-control-pending', controlId: control.controlId })); },
  });
  const provider = {
    checkAccess: input => runAuthority.checkAccess(input), authorizeQuery: input => runAuthority.authorizeQuery(input),
    resolveRunPrincipal: input => runAuthority.resolveRunPrincipal(input), admit: input => runAuthority.admit(input),
    confirmRead: input => runAuthority.confirmRead(input), queryRead: input => runAuthority.queryRead(input), finish: input => runAuthority.finish(input),
    applyAccessEvent: event => runAuthority.applyAccessEvent(event), synchronize: () => runAuthority.synchronize(),
  };
  const instancesHandler = createAgentInstanceInternalHandler({ instanceAuthority, agentFingerprint256: pin, resolveServicePrincipal });
  const conversationsHandler = createConversationInternalHandler({ conversationAuthority: conversations,
    agentFingerprint256: pin, resolveDelegation: async ticket => {
      currentService(); return runtime.resolveAgentDelegation(ticket);
    } });
  const runsHandler = createRunInternalHandler({ runAuthority: provider, agentFingerprint256: pin,
    resolveServicePrincipal,
    authenticateInvocation({ req, servicePrincipal, body, operation }) {
      const cap = instanceAuthority.authenticate({ servicePrincipal, method: req.method,
        path: new URL(req.url, 'https://internal.invalid').pathname, operation, request: body, proof: instanceRequestProof(req) });
      return { servicePrincipal: { ...servicePrincipal, ...cap },
        release: () => instanceAuthority.release(cap.instanceSession) };
    },
    principalForCheck({ projectId, runGrantId, servicePrincipal }) {
      const grant = ledger.read().runGrantsV2?.[runGrantId];
      if (!grant || grant.projectId !== projectId) fail(403, 'run-binding-mismatch');
      return { ...Object.fromEntries(['projectId', 'conversationId', 'messageId', 'runId', 'runGrantId',
        'accountId', 'loginId', 'credentialId', 'loginGeneration', 'serviceId', 'serviceKid',
        'instanceId', 'instanceGeneration'].map(field => [field, grant[field]])),
        realm: 'account', identityVersion: 2, role: 'agent', creator: false, servicePrincipal };
    },
    // A resolve invocation proves this read, not a long-lived data connection.
    // Until the scoped data dispatch is mounted, no reusable run ticket is issued.
    issueRunTicket: () => fail(503, 'run-data-proof-unavailable'),
    async listPendingRuns({ servicePrincipal }) {
      await runtime.authority.synchronize(); verifyServiceInState(ledger.read(), servicePrincipal);
      const state = ledger.read(), rows = [];
      for (const [projectId, group] of Object.entries(state.conversationsV2 ?? {})) {
        if (state.projects[projectId]?.status !== 'active' || state.projects[projectId].hosted?.agent !== true) continue;
        for (const conversation of Object.values(group)) if (conversation.messages.some(message => message.queueState === 'queued'))
          rows.push({ projectId, conversationId: conversation.id, queueRevision: conversation.queueRevision });
      }
      return { conversations: rows };
    } });
  return { conversations, runProvider: provider, runHooks, deliver,
    async handleInternal(req, res) { return await instancesHandler(req, res) || await runsHandler(req, res) || await conversationsHandler(req, res); },
    async start() { for (const control of await runAuthority.synchronize()) await deliver(control); },
    async close() { stopped = true; await Promise.allSettled([...deliveries.values()]); instanceAuthority.close(); subjects.clear(); transport.close(); },
  };
}
