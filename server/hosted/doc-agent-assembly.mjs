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
import { createAgentRunScopeDoc } from '../account/agent-run-scope-doc.mjs';
import { createRunAssetsInstanceAdapter } from './run-assets-instance-adapter.mjs';
import { createRunAssets } from '../account/run-assets.mjs';
import { createRunAssetsInternalHandler } from '../account/run-assets-internal.mjs';
import { createRunAssetClosure } from './run-assets-closure.mjs';

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
  const scopeAuthority = account.agent.runScopes ? createAgentRunScopeDoc({ ledger,
    signingKey: account.agent.runScopes.signingKey, slots: account.agent.runScopes.slots,
    masterServiceKid: account.agent.runScopes.masterServiceKid, masterFingerprint256: account.agent.runScopes.masterFingerprint256,
    // 〔裁〕只给受控测试：换掉「读 root 记录」的来源（生产的读端只在 Linux 上跑，核文件属主是 root）。
    // 这一项只有在进程内直接调本函数的调用方给得了；`main.mjs` 从环境变量拼配置时不设它，也没有对应的环境变量。
    ...(typeof account.agent.runScopes.sourceFactory === 'function' ? { sourceFactory: account.agent.runScopes.sourceFactory } : {}) }) : null;
  const masterPin = scopeAuthority ? certificateFingerprint(account.agent.runScopes.masterFingerprint256) : null;
  const masterKid = scopeAuthority ? account.agent.runScopes.masterServiceKid : null;
  if (scopeAuthority && (masterPin === pin || masterKid === kid)) fail(503, 'doc-agent-role-configuration');
  const servicePins = new Map([[kid, pin], ...(scopeAuthority ? [[masterKid, masterPin]] : [])]);
  let stopped = false, runAuthority, assetInstanceAdapter = null, runAssets = null, runAssetsHandler = null;
  // 不带参数时核的是跑任务的那个身份（运行素材那一侧这样调）；带参数时核指定的那个（任务身份或只做控制的主身份）。
  const currentService = (serviceKid = kid) => {
    if (stopped) fail(503, 'doc-agent-unavailable');
    try { serviceRegistry?.refresh({ force: true }); } catch { fail(403, 'run-service-forbidden'); }
    const entry = serviceRegistry?.get('agent');
    if (!servicePins.has(serviceKid) || entry?.role !== 'agent' || entry.actsFor !== 'member' || !entry.keys.some(key => key.kid === serviceKid))
      fail(403, 'run-service-forbidden');
    return { serviceId: 'agent', serviceKid };
  };
  const resolveServicePrincipal = ({ socket }) => {
    const fingerprint = certificateFingerprint(socket?.getPeerCertificate?.()?.fingerprint256);
    const serviceKid = [...servicePins].find(([_kid, allowed]) => allowed === fingerprint)?.[0];
    if (!socket?.encrypted || socket.authorized !== true || socket.destroyed ||
        !serviceKid) fail(403, 'run-service-forbidden');
    currentService(serviceKid);
    instanceTlsBinding(socket); // exporter is taken only from the real peer socket.
    let subject = sockets.get(socket);
    if (!subject) {
      const authenticationId = randomUUID();
      subject = { service: 'agent', serviceKid, authenticationId };
      sockets.set(socket, subject); subjects.set(authenticationId, socket);
      socket.once('close', () => { subjects.delete(authenticationId); sockets.delete(socket); handshakeNonces.delete(socket); });
    }
    return structuredClone(subject);
  };
  const verifyServiceInState = (_state, subject) => {
    if (assetInstanceAdapter?.has(subject)) {
      const observed = assetInstanceAdapter.transportFor(subject);
      return { serviceId: observed.serviceId, serviceKid: observed.serviceKid };
    }
    currentService(subject?.serviceKid);
    const socket = subjects.get(subject?.authenticationId);
    if (!socket || subject.service !== 'agent' || socket.destroyed ||
        socket.authorized !== true || certificateFingerprint(socket.getPeerCertificate?.()?.fingerprint256) !== servicePins.get(subject.serviceKid))
      fail(403, 'run-service-forbidden');
    return { serviceId: 'agent', serviceKid: subject.serviceKid };
  };
  const instanceAuthority = createAgentInstanceAuthority({ ledger, scopeAuthority,
    verifyTransportInState(state, subject) {
      if (assetInstanceAdapter?.has(subject)) return assetInstanceAdapter.transportFor(subject);
      const service = verifyServiceInState(state, subject);
      return { ...service, authenticationId: subject.authenticationId,
        fingerprint256: certificateFingerprint(subjects.get(subject.authenticationId)?.getPeerCertificate?.()?.fingerprint256),
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
  /** Agent 这一项对一条访问事件的确认：读取都关了，并且要中止的任务都凭 root 的关闭记录结清了，才往文档服务的账本里记
   * 「Agent 已确认」。没办完就保持待办，下次再试；办完以后重复调用不会记第二次。
   * 判断任务那一半见 `agent-read-control.mjs` 的 `accessEventRunClosure`：保留下来继续跑的共有已读任务不在等的范围里。 */
  function completeReadAccessEvents() {
    const state = ledger.read(), pending = [];
    for (const event of state.accessEvents) {
      if (runtime.authority.hasAgentReadClosure(event.eventId) ||
          !state.agentReadsV1?.controls.some(c => c.accessSeq === event.seq)) continue;
      try {
        const closure = readControl.finalizeAccessEvent({ eventId: event.eventId, scoped: Boolean(scopeAuthority) });
        runtime.authority.ackAccessEvent(event.eventId, 'agent', { receiptId: `agent-read:${event.eventId}`,
          cursor: event.seq, complete: true, agentReadClosureDigest: closure.digest,
          closedStreams: closure.payload.receipts.flatMap(r => r.closedReadHandleIds),
          stoppedRuns: (closure.payload.stoppedRuns ?? []).map(run => run.runId), rejectedCredentials: event.loginIds ?? [] });
      } catch (error) {
        if (!['read-close-pending', 'agent-run-closure-pending'].includes(error.code)) throw error;
        pending.push({ eventId: event.eventId, code: error.code });
      }
    }
    return { pending };
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
      if (scopeAuthority && (persisted.kind === 'terminal' || persisted.revoked.length)) {
        await scopeAuthority.closeDocControl({ controlId: persisted.controlId, docInstanceId, service, operationCoordinator: doc });
        return { pending: true, controlId: persisted.controlId };
      }
      // fencePrincipals installs logical/admission barriers and terminates owned
      // transports synchronously before its first await. Establish the read
      // barrier before operation recovery can yield to any cache/push callback.
      const closingIds = persisted.kind === 'terminal' ? persisted.closing : persisted.revoked;
      const closing = closingIds.length ? service.fencePrincipals({ runGrantIds: closingIds, roles: ['agent'] }) : Promise.resolve(null);
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
          controlId: control.controlId, payloadDigest: control.payloadDigest, fenceRevision: control.fenceRevision, instances: {} };
        if (scopeAuthority) {
          record.instances[docInstanceId] = { docInstanceId, operationReceipts, closed, state: 'closed', recordedAt: now() };
          return;
        }
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
      // 任务在独立进程里跑时，这条控制要等 root 把进程关掉、这里读到关闭记录才办完。这里读一次：
      // 已经关了就当场结清并回成功；还没关就照旧回「还在办」，调用方用同一个请求号再问。
      if (scopeAuthority) await runAuthority.reconcileScopeClosures();
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
    verifyServiceInState, instanceAuthority, scopeAuthority, docInstanceId, now, synchronize: () => runtime.authority.synchronize(),
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
      if (scopeAuthority) ledger.transaction(state => {
        ((state.runDocInstancesV1 ??= {})[runGrantId] ??= {})[docInstanceId] = { docInstanceId };
      });
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
  const instancesHandler = createAgentInstanceInternalHandler({ instanceAuthority, agentFingerprint256: pin, masterFingerprint256: masterPin, resolveServicePrincipal });
  function createRunAssetAuthentication({ assetFingerprint256, currentAsset } = {}) {
    if (assetInstanceAdapter) fail(503, 'run-assets-instance-already-bound');
    const adapter = createRunAssetsInstanceAdapter({ agentFingerprint256: pin, agentServiceKid: kid,
      assetFingerprint256, currentAgent: currentService, currentAsset });
    assetInstanceAdapter = adapter;
    const authenticateDirect = ({ transport, proof, method, path, operation, request }) => {
      assertInstanceDirectTransport(transport);
      const base = resolveServicePrincipal({ socket: transport.socket });
      // 〔裁〕运行素材只给跑任务的身份用。开了「一条任务一个进程」以后这个入口还认得只做控制的主身份的证书，
      // 这里先拒掉它，不等到后面按实例用途去拒。
      if (base.serviceKid !== kid) fail(403, 'run-service-forbidden');
      const cap = instanceAuthority.authenticate({ servicePrincipal: base, method, path, operation, request, proof });
      return { servicePrincipal: { ...base, ...cap }, release: () => instanceAuthority.release(cap.instanceSession) };
    };
    const authenticateObserved = ({ observer, observation, proof, method, path, operation, request }) => {
      const observed = adapter.open({ observer, observation });
      try {
        const cap = instanceAuthority.authenticate({ servicePrincipal: observed.servicePrincipal,
          method, path, operation, request, proof });
        return { servicePrincipal: { ...observed.servicePrincipal, ...cap },
          release() { instanceAuthority.release(cap.instanceSession); observed.release(); } };
      } catch (error) { observed.release(); throw error; }
    };
    return Object.freeze({ authenticateDirect, authenticateObserved, verifyObserver: adapter.verifyObserver });
  }
  function mountRunAssets({ assetFingerprint256, currentAsset, resolveObserver, privateClient,
    ticketTtlMs, maxBodyBytes, now: runNow = now } = {}) {
    if (runAssets || typeof resolveObserver !== 'function' || typeof privateClient?.identity !== 'function')
      fail(503, 'run-assets-unconfigured');
    const doc = getDocAssembly();
    if (typeof doc?.resolveRunMedia !== 'function') fail(503, 'run-assets-unconfigured');
    const authentication = createRunAssetAuthentication({ assetFingerprint256, currentAsset });
    let authority;
    try {
      const closure = createRunAssetClosure({ privateClient, currentAsset });
      authority = createRunAssets({ ledger, runProvider: provider,
        authenticateDirect: authentication.authenticateDirect,
        authenticateObserved: authentication.authenticateObserved,
        verifyObserver: authentication.verifyObserver,
        resolveMedia: input => doc.resolveRunMedia(input),
        verifyLeaseClosure: input => closure.verifyLeaseClosure(input),
        verifyControlReceipt: input => closure.verifyControlReceipt(input),
        now: runNow, ticketTtlMs });
      const handler = createRunAssetsInternalHandler({ runAssets: authority,
        agentFingerprint256: pin, assetFingerprint256, resolveObserver, maxBodyBytes });
      runAssets = authority; runAssetsHandler = handler;
      return Object.freeze({ authority, handler });
    } catch (error) { authority?.close(); assetInstanceAdapter?.close(); assetInstanceAdapter = null; throw error; }
  }
  const conversationsHandler = createConversationInternalHandler({ conversationAuthority: conversations,
    agentFingerprint256: masterPin ?? pin, requireReadControl: true, resolveDelegation: async ticket => {
      currentService(); return runtime.resolveAgentDelegation(ticket);
    } });
  const readControlsHandler = createAgentReadControlHandler({ control: readControl, resolveServicePrincipal, instanceAuthority });
  // 「一条任务一个进程」要的那几个接口（领分配、查结束、签准备、取终态、主身份取强制终态与事件来源）只在开了这个模式时
  // 交给内部口；不开时内部口对它们照旧回 503。交给别处（数据连接、运行素材）的 provider 不变。
  const internalRunAuthority = scopeAuthority ? { ...provider,
    queryFinish: input => runAuthority.queryFinish(input), scopeAssignment: input => runAuthority.scopeAssignment(input),
    scopePrepare: input => runAuthority.scopePrepare(input), scopeTerminal: input => runAuthority.scopeTerminal(input),
    scopeControl: input => runAuthority.scopeControl(input), workerEventSource: input => runAuthority.workerEventSource(input) } : provider;
  const runsHandler = createRunInternalHandler({ runAuthority: internalRunAuthority, agentFingerprint256: pin,
    masterFingerprint256: masterPin, requirePendingProof: Boolean(scopeAuthority), includeScopeControls: Boolean(scopeAuthority), resolveServicePrincipal,
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
      if (scopeAuthority) {
        instanceAuthority.verifyInState(ledger.read(), servicePrincipal, { operation: 'pendingRuns', input: {} });
        if (ledger.read().agentInstancesV2?.[servicePrincipal.instanceId]?.purpose !== 'control-only') fail(403, 'instance-purpose-forbidden');
        for (const control of await runAuthority.reconcileScopeFailures()) await deliver(control);
        // 文档服务自己这一侧的连接没关完，终态和强制终态都签不出来。第一次没关成的（当时出错、进程重启过），
        // 主服务每次来问时补做一遍；已经关过的不重复。
        for (const control of Object.values(ledger.read().runControlsV2 ?? {}))
          if (control.state === 'pending' && (control.kind === 'terminal' || control.revoked?.length) &&
              ledger.read().docRunClosuresV2?.[control.controlId]?.instances?.[docInstanceId]?.state !== 'closed')
            await deliver(control).catch(error => onDiagnostic({ code: error.code ?? 'run-control-pending', controlId: control.controlId }));
        await runAuthority.reconcileScopeClosures();
      }
      const state = ledger.read(), rows = [];
      for (const [projectId, group] of Object.entries(state.conversationsV2 ?? {})) {
        if (state.projects[projectId]?.status !== 'active' || state.projects[projectId].hosted?.agent !== true) continue;
        for (const conversation of Object.values(group)) {
          // 一条任务一个进程时：这个对话的上一条还没结清（`currentRunId` 还在）就先不报给调度。报了也领不到（409 `run-not-ready`），
          // 调度却会为它白开一代进程、再退掉。结清以后这里自然就报出来了。
          if (scopeAuthority && conversation.currentRunId) continue;
          if (conversation.messages.some(message => message.queueState === 'queued'))
            rows.push({ projectId, conversationId: conversation.id, queueRevision: conversation.queueRevision });
        }
      }
      return { conversations: rows, ...(scopeAuthority ? { scopeControls: runAuthority.listScopeControls({ servicePrincipal }) } : {}) };
    } });
  return { conversations, readControl, runProvider: provider, runHooks, deliver, createRunAssetAuthentication, mountRunAssets,
    /** 退出确认的续办口：把读取已关、任务已结清的访问事件记成「Agent 已确认」。开了「一条任务一个进程」时先读一次
     * root 的关闭记录，这样主身份还没来问的时候（比如文档服务刚重启）也能结清。 */
    async completeAccessEvents() {
      if (scopeAuthority) await runAuthority.reconcileScopeClosures();
      return completeReadAccessEvents();
    },
    transportAuthenticate, transportConnected, dispatchInvocation,
    async handleInternal(req, res) { return await runAssetsHandler?.(req, res) || await instancesHandler(req, res) || await readControlsHandler(req, res) ||
      await runsHandler(req, res) || await conversationsHandler(req, res); },
    async start() { for (const control of await runAuthority.synchronize()) await deliver(control);
      if (scopeAuthority) {
        for (const control of await runAuthority.reconcileScopeFailures()) await deliver(control);
        await runAuthority.reconcileScopeClosures();
      } },
    async close() { stopped = true; readControl.close(); await Promise.allSettled([...deliveries.values()]); runAssets?.close(); assetInstanceAdapter?.close(); instanceAuthority.close(); subjects.clear();
      usedNonces.clear(); handshakeNonces.clear(); dispatchContext.disable(); transport.close(); },
  };
}
