import { randomUUID } from 'node:crypto';
import { accountError, certificateFingerprint } from '../account/client.mjs';
import { createConversationAuthority } from '../account/conversation-authority.mjs';
import { createConversationInternalHandler } from '../account/conversation-internal.mjs';
import { createRunAuthority } from '../account/run-authority.mjs';
import { createRunInternalHandler } from '../account/run-internal.mjs';
import { canonicalJson } from '../account/ledger.mjs';
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
  const docInstanceId = randomUUID(), subjects = new Map(), deliveries = new Map();
  const transport = createAssetMtlsTransport({ origin: account.origin, tls: account.clientTls,
    serverFingerprint256: account.serverFingerprint256 });
  let stopped = false, runAuthority, certifiedSubject = null;
  const currentService = () => {
    if (stopped) fail(503, 'doc-agent-unavailable');
    try { serviceRegistry?.refresh({ force: true }); } catch { fail(403, 'run-service-forbidden'); }
    const entry = serviceRegistry?.get('agent');
    if (entry?.role !== 'agent' || entry.actsFor !== 'member' || !entry.keys.some(key => key.kid === kid))
      fail(403, 'run-service-forbidden');
  };
  const resolveServicePrincipal = ({ fingerprint256 }) => {
    if (certificateFingerprint(fingerprint256) !== pin) fail(403, 'run-service-forbidden');
    currentService();
    if (!certifiedSubject) {
      const authenticationId = randomUUID();
      certifiedSubject = { service: 'agent', serviceKid: kid, authenticationId };
      subjects.set(authenticationId, canonicalJson(certifiedSubject));
    }
    return structuredClone(certifiedSubject);
  };
  const verifyServiceInState = (_state, subject) => {
    currentService();
    if (!subject || subjects.get(subject.authenticationId) !== canonicalJson(subject)) fail(403, 'run-service-forbidden');
    return { serviceId: 'agent', serviceKid: kid };
  };
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
          complete: false, agentState: 'registration-required', recordedAt: now() };
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
    verifyServiceInState, now, synchronize: () => runtime.authority.synchronize(),
    async verifySender(ref, context) {
      const checked = await accountClient.verifyAcceptedMessage(ref, context);
      await runtime.authority.synchronize();
      if (ledger.read().accountHead < checked.accountEventSeq) fail(503, 'account-event-gap');
      return checked;
    },
    onControl: control => { void deliver(control).catch(error => onDiagnostic({ code: error.code ?? 'run-control-pending', controlId: control.controlId })); },
  });
  const requireRegisteredInstance = () => fail(503, 'run-instance-unavailable');
  // The provider currently persists serviceId/kid but not an instance generation.
  // Do not make public routes or WS use this gap as a free authorization path.
  const provider = {
    checkAccess: requireRegisteredInstance, authorizeQuery: requireRegisteredInstance,
    resolveRunPrincipal: requireRegisteredInstance, admit: requireRegisteredInstance,
    confirmRead: requireRegisteredInstance, queryRead: requireRegisteredInstance, finish: requireRegisteredInstance,
    applyAccessEvent: event => runAuthority.applyAccessEvent(event), synchronize: () => runAuthority.synchronize(),
  };
  const conversationsHandler = createConversationInternalHandler({ conversationAuthority: conversations,
    agentFingerprint256: pin, resolveDelegation: async ticket => {
      currentService(); return runtime.resolveAgentDelegation(ticket);
    } });
  const runsHandler = createRunInternalHandler({ runAuthority: provider, agentFingerprint256: pin,
    resolveServicePrincipal, issueRunTicket: input => runtime.issueRunTicket(input),
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
    async handleInternal(req, res) { return await runsHandler(req, res) || await conversationsHandler(req, res); },
    async start() { for (const control of await runAuthority.synchronize()) await deliver(control); },
    async close() { stopped = true; await Promise.allSettled([...deliveries.values()]); subjects.clear(); transport.close(); },
  };
}
