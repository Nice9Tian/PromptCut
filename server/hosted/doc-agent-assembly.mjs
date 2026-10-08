import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { accountError, certificateFingerprint } from '../account/client.mjs';
import { createConversationAuthority, conversationReadInState } from '../account/conversation-authority.mjs';
import { createAgentReadControl, createAgentReadControlHandler } from '../account/agent-read-control.mjs';
import { createConversationInternalHandler } from '../account/conversation-internal.mjs';
import { createRunAuthority } from '../account/run-authority.mjs';
import { createRunInternalHandler } from '../account/run-internal.mjs';
import { createAgentInstanceAuthority, instanceTlsBinding } from '../account/agent-instance-authority.mjs';
import { createAgentInstanceInternalHandler, instanceRequestProof, assertInstanceDirectTransport,
  INSTANCE_PROOF_HEADER, INSTANCE_DATA_PROOF_HEADER, instanceConnectionRequest, instanceDataRequest, instanceProtocolHeaders, instanceMessageAction } from '../account/agent-instance-internal.mjs';
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
  const dispatchContext = new AsyncLocalStorage(), usedNonces = new Map(), handshakeNonces = new Map(), initialNonces = new WeakMap();
  const actorBinding = ['accountId', 'loginId', 'credentialId', 'loginGeneration', 'projectId', 'conversationId',
    'messageId', 'runId', 'runGrantId', 'serviceId', 'serviceKid', 'instanceId', 'instanceGeneration'];
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
      socket.once('close', () => { subjects.delete(authenticationId); sockets.delete(socket); handshakeNonces.delete(socket); });
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
  const readControl = createAgentReadControl({ ledger, instanceAuthority,
    synchronize: () => runtime.authority.synchronize(),
    async authorizeRead(body) {
      currentService();
      const trusted = await runtime.resolveAgentDelegation(body.delegation);
      if (trusted.projectId !== body.projectId) fail(403, 'project-mismatch');
      return runtime.authority.authorizePrincipal({ authorizationId: trusted.authorizationId },
        { projectId: trusted.projectId, action: 'read' });
    }, checkReadInState: conversationReadInState,
    onProgress: () => { try { completeReadAccessEvents(); } catch (error) {
      onDiagnostic({ code: error.code ?? 'agent-read-close-pending' }); } } });
  function completeReadAccessEvents() {
    const state = ledger.read();
    for (const event of state.accessEvents) {
      if (runtime.authority.hasAgentReadClosure(event.eventId) ||
          !state.agentReadsV1?.controls.some(c => c.accessSeq === event.seq)) continue;
      try {
        const closure = readControl.finalizeAccessEvent({ eventId: event.eventId });
        runtime.authority.ackAccessEvent(event.eventId, 'agent', { receiptId: `agent-read:${event.eventId}`,
          cursor: event.seq, complete: true, agentReadClosureDigest: closure.digest,
          closedStreams: closure.payload.receipts.flatMap(r => r.closedReadHandleIds),
          stoppedRuns: [], rejectedCredentials: event.loginIds ?? [] });
      } catch (error) { if (!['read-close-pending', 'agent-run-closure-pending'].includes(error.code)) throw error; }
    }
  }
  // Operation and doc-transport closure are real partial evidence. Until the
  // registered Agent instance/resource witness exists, no control is ACKed.
  async function deliver(control) {
    readControl.publish();
    if (deliveries.has(control.controlId)) return deliveries.get(control.controlId);
    const pending = (async () => {
      const persisted = ledger.read().runControlsV2?.[control.controlId];
      if (!persisted || persisted.payloadDigest !== control.payloadDigest || persisted.fenceRevision !== control.fenceRevision)
        fail(403, 'run-control-mismatch');
      const doc = getDocAssembly(), service = getService();
      if (!doc || !service) fail(503, 'doc-agent-unavailable');
      // fencePrincipals installs logical/admission barriers and terminates owned
      // transports synchronously before its first await. Establish the read
      // barrier before operation recovery can yield to any cache/push callback.
      const closing = persisted.revoked.length ? service.fencePrincipals({ runGrantIds: persisted.revoked, roles: ['agent'] }) : Promise.resolve(null);
      const closingResult = closing.then(value => ({ value }), error => ({ error }));
      const operationReceipts = [];
      for (const fence of persisted.operationFences ?? []) operationReceipts.push(await doc.fence(fence));
      const closeOutcome = await closingResult;
      if (closeOutcome.error) throw closeOutcome.error;
      const closed = closeOutcome.value;
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
  const runHooks = { fenceInState(state, fence) {
    readControl.hooks.fenceInState(state, fence);
    return runAuthority.hooks.fenceInState(state, fence);
  } };
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
      const matches = control => control.state === 'pending' && control.projectId === input.projectId &&
        control.scope.conversationId === input.conversationId && (!input.runId || control.scope.runId === input.runId);
      const immediate = Object.values(ledger.read().runControlsV2 ?? {}).filter(matches).map(deliver);
      await Promise.all(immediate);
      const controls = await runAuthority.synchronize();
      await Promise.all(controls.filter(matches).map(deliver));
      const relevant = Object.values(ledger.read().runControlsV2 ?? {}).filter(matches);
      if (relevant.every(control => control.instances.length === 0 && control.retained.length === 0 && control.revoked.length === 0)) {
        const readClosed = await readControl.waitCompletion({ projectId: input.projectId, conversationId: input.conversationId });
        // This phase mounts human HTTP reads only. Empty run inventory is checked
        // in the transaction; it cannot stand in for a historical OS/runner close.
        for (const control of relevant) runAuthority.acknowledgeControl({ controlId: control.controlId,
          receipt: { controlId: control.controlId, fenceRevision: control.fenceRevision, complete: true,
            receiptId: `read-only:${control.controlId}`, readControlIds: readClosed.controlIds } }, (state, current) =>
          current.instances.length === 0 && current.retained.length === 0 && current.revoked.length === 0 &&
          readControl.completion({ projectId: input.projectId, conversationId: input.conversationId }).complete);
        return { ack: true, ...input };
      }
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
  function scopedInput(input, operation) {
    const ctx = dispatchContext.getStore();
    if (!ctx) return input;
    if (input.projectId !== ctx.principal.projectId ||
        actorBinding.some(field => input.principal?.[field] !== ctx.principal[field])) fail(403, 'instance-dispatch-binding-mismatch');
    const cap = ctx.caps.find(value => value.operation === operation &&
      (operation !== 'checkAccess' || value.action === input.action));
    if (!cap) fail(403, 'instance-operation-forbidden');
    return { ...input, principal: { ...input.principal, servicePrincipal: cap.subject } };
  }
  const provider = {
    checkAccess: input => runAuthority.checkAccess(scopedInput(input, 'checkAccess')),
    authorizeQuery: input => runAuthority.authorizeQuery(scopedInput(input, 'authorizeQuery')),
    resolveRunPrincipal: input => runAuthority.resolveRunPrincipal(input), admit: input => runAuthority.admit(input),
    confirmRead: input => runAuthority.confirmRead(input), queryRead: input => runAuthority.queryRead(input), finish: input => runAuthority.finish(input),
    applyAccessEvent: event => runAuthority.applyAccessEvent(event), synchronize: () => runAuthority.synchronize(),
  };
  function nonce(value) { if (!Number.isSafeInteger(value) || value < 1) fail(400, 'instance-nonce-invalid'); return value; }
  function claimNonce(table, key, value) {
    const used = table.get(key) ?? new Set();
    if (used.has(value)) fail(403, 'instance-nonce-replayed');
    used.add(value); table.set(key, used);
  }
  const sameShape = (body, keys) => body && typeof body === 'object' && !Array.isArray(body) &&
    Object.keys(body).length === keys.length && keys.every(key => Object.hasOwn(body, key));
  function dataEnvelope(encoded) {
    if (typeof encoded !== 'string' || encoded.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(encoded)) fail(403, 'instance-data-proof-required');
    try { return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); }
    catch { fail(400, 'instance-data-proof-invalid'); }
  }
  function grantPrincipal(projectId, runGrantId, servicePrincipal) {
    const grant = ledger.read().runGrantsV2?.[runGrantId];
    if (!grant || grant.projectId !== projectId) fail(403, 'run-binding-mismatch');
    return { ...Object.fromEntries(actorBinding.map(field => [field, grant[field]])),
      realm: 'account', identityVersion: 2, role: 'agent', creator: false, servicePrincipal };
  }
  async function transportAuthenticate(req, fallback, { internal } = {}) {
    const url = new URL(req.url ?? '/', 'https://internal.invalid');
    const attempted = internal || req.headers?.['x-promptcut-instance-proof'] !== undefined ||
      req.headers?.[INSTANCE_DATA_PROOF_HEADER] !== undefined || url.searchParams.has('runGrantId');
    if (!attempted) return fallback(req);
    if (!internal) fail(403, 'instance-internal-transport-required');
    assertInstanceDirectTransport(req);
    if (url.searchParams.size !== 3 || [...url.searchParams.keys()].some(key => !['projectId', 'runGrantId', 'nonce'].includes(key)))
      fail(400, 'instance-connection-query-invalid');
    const projectId = url.searchParams.get('projectId'), runGrantId = url.searchParams.get('runGrantId');
    const requestNonce = nonce(Number(url.searchParams.get('nonce')));
    const base = resolveServicePrincipal({ socket: req.socket });
    const request = instanceConnectionRequest({ projectId, runGrantId, nonce: requestNonce, purpose: 'run-connection',
      url: req.url, protocols: instanceProtocolHeaders(req.transportProtocolHeaders ?? req.headers), bodyText: req.transportBodyText ?? '' });
    const cap = instanceAuthority.authenticate({ servicePrincipal: base, method: req.method, path: url.pathname,
      operation: 'resolveRunPrincipal', request, proof: instanceRequestProof(req) });
    try {
      claimNonce(handshakeNonces, req.socket, requestNonce);
      const principal = await runAuthority.resolveRunPrincipal({ servicePrincipal: { ...base, ...cap }, projectId, runGrantId });
      initialNonces.set(req.socket, requestNonce);
      return { ...principal, servicePrincipal: base, userId: principal.accountId, tenantId: projectId,
        service: 'agent', scope: 'member' };
    } finally { instanceAuthority.release(cap.instanceSession); }
  }
  function transportConnected({ connId, req }) {
    const initial = initialNonces.get(req.socket);
    if (initial === undefined) return;
    claimNonce(usedNonces, connId, initial); initialNonces.delete(req.socket);
  }
  async function dispatchInvocation(input, next) {
    const { principal, connId, transport, kind } = input;
    if (principal?.realm !== 'account' || principal.role !== 'agent') {
      if (transport?.internal || transport?.req?.headers?.[INSTANCE_PROOF_HEADER] ||
          transport?.req?.headers?.[INSTANCE_DATA_PROOF_HEADER] ||
          new URL(transport?.req?.url ?? '/', 'http://localhost').searchParams.has('runGrantId'))
        fail(403, 'run-principal-invalid');
      return next(input.text);
    }
    if (!transport?.internal) fail(403, 'instance-internal-transport-required');
    const req = transport.req; assertInstanceDirectTransport(req);
    const base = resolveServicePrincipal({ socket: transport.socket });
    const url = new URL(req.url, 'https://internal.invalid');
    const caps = []; let requestNonce, proofs, text = input.text, requestBase;
    try {
      if (kind === 'resume') {
        if (url.searchParams.size !== 3 || url.searchParams.get('projectId') !== principal.projectId ||
            url.searchParams.get('runGrantId') !== principal.runGrantId) fail(403, 'run-binding-mismatch');
        requestNonce = nonce(Number(url.searchParams.get('nonce')));
        requestBase = instanceConnectionRequest({ projectId: principal.projectId, runGrantId: principal.runGrantId,
          nonce: requestNonce, purpose: 'run-resume', url: req.url, protocols: instanceProtocolHeaders(req.headers),
          bodyText: input.bodyText ?? '', sessionItem: input.sessionItem });
        proofs = [{ ...instanceRequestProof(req), operation: 'checkAccess', action: 'read' }];
      } else {
        let envelope;
        if (transport.kind === 'ws') {
          try { envelope = JSON.parse(input.text); } catch { fail(400, 'instance-data-proof-invalid'); }
          if (!sameShape(envelope, ['nonce', 'frame', 'proofs']) || !envelope.frame || typeof envelope.frame !== 'object' || Array.isArray(envelope.frame))
            fail(400, 'instance-data-proof-invalid');
          text = JSON.stringify(envelope.frame);
        } else {
          envelope = dataEnvelope(req.headers?.[INSTANCE_DATA_PROOF_HEADER]);
          if (kind === 'message') {
            if (!sameShape(envelope, ['frames']) || !Array.isArray(envelope.frames) || envelope.frames.length !== input.frameCount)
              fail(400, 'instance-data-proof-invalid');
            envelope = envelope.frames[input.frameIndex];
          }
          if (!sameShape(envelope, ['nonce', 'proofs'])) fail(400, 'instance-data-proof-invalid');
        }
        requestNonce = nonce(envelope.nonce); proofs = envelope.proofs;
        requestBase = instanceDataRequest({ projectId: principal.projectId, runGrantId: principal.runGrantId, connId,
          nonce: requestNonce, kind, url: req.url, protocols: instanceProtocolHeaders(req.headers), bodyText: input.bodyText ?? '',
          text: kind === 'message' ? text : undefined, frameIndex: input.frameIndex });
      }
      let frame;
      if (kind === 'message') { try { frame = JSON.parse(text); } catch { fail(400, 'instance-data-proof-invalid'); } }
      const action = instanceMessageAction(frame?.type);
      const operations = frame?.type === 'selection.query' ? ['checkAccess', 'authorizeQuery'] : ['checkAccess'];
      if (!Array.isArray(proofs) || proofs.length !== operations.length) fail(400, 'instance-data-proof-invalid');
      for (const operation of operations) {
        const proof = proofs.find(value => value.operation === operation);
        if (!sameShape(proof, ['operation', 'instanceId', 'instanceGeneration', 'signature',
          ...(operation === 'checkAccess' ? ['action'] : [])]) || operation === 'checkAccess' && proof.action !== action)
          fail(403, 'instance-operation-forbidden');
        const request = operation === 'checkAccess' ? { ...requestBase, action } : requestBase;
        const cap = instanceAuthority.authenticate({ servicePrincipal: base, method: transport.kind === 'ws' && kind === 'message' ? 'WS' : req.method,
          path: url.pathname, operation, request, proof });
        const subject = { ...base, ...cap }; caps.push({ ...cap, subject, operation, action });
        if (cap.instanceId !== principal.instanceId || cap.instanceGeneration !== principal.instanceGeneration)
          fail(403, 'run-instance-mismatch');
      }
      claimNonce(usedNonces, connId, requestNonce);
      const check = () => runAuthority.checkAccess({ principal: { ...principal, servicePrincipal: caps[0].subject }, projectId: principal.projectId, action });
      await check();
      return await dispatchContext.run({ principal, caps }, () => next(text, check));
    } finally { for (const cap of caps) instanceAuthority.release(cap.instanceSession); }
  }
  const instancesHandler = createAgentInstanceInternalHandler({ instanceAuthority, agentFingerprint256: pin, resolveServicePrincipal });
  const conversationsHandler = createConversationInternalHandler({ conversationAuthority: conversations,
    agentFingerprint256: pin, requireReadControl: true, resolveDelegation: async ticket => {
      currentService(); return runtime.resolveAgentDelegation(ticket);
    } });
  const readControlsHandler = createAgentReadControlHandler({ control: readControl, resolveServicePrincipal, instanceAuthority });
  const runsHandler = createRunInternalHandler({ runAuthority: provider, agentFingerprint256: pin,
    resolveServicePrincipal,
    authenticateInvocation({ req, servicePrincipal, body, operation }) {
      const cap = instanceAuthority.authenticate({ servicePrincipal, method: req.method,
        path: new URL(req.url, 'https://internal.invalid').pathname, operation, request: body, proof: instanceRequestProof(req) });
      return { servicePrincipal: { ...servicePrincipal, ...cap },
        release: () => instanceAuthority.release(cap.instanceSession) };
    },
    principalForCheck: ({ projectId, runGrantId, servicePrincipal }) => grantPrincipal(projectId, runGrantId, servicePrincipal),
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
  return { conversations, readControl, runProvider: provider, runHooks, deliver, transportAuthenticate, transportConnected, dispatchInvocation,
    async handleInternal(req, res) { return await instancesHandler(req, res) || await readControlsHandler(req, res) || await runsHandler(req, res) || await conversationsHandler(req, res); },
    async start() { for (const control of await runAuthority.synchronize()) await deliver(control); },
    async close() { stopped = true; readControl.close(); await Promise.allSettled([...deliveries.values()]); instanceAuthority.close(); subjects.clear();
      usedNonces.clear(); handshakeNonces.clear(); dispatchContext.disable(); transport.close(); },
  };
}
