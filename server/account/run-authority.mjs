import { randomUUID } from 'node:crypto';
import { canonicalJson, digestOf } from './ledger.mjs';
import { accountError } from './client.mjs';

const reject = (status, code) => { throw accountError(status, code); };
const text = x => typeof x === 'string' && x.length > 0 && x.length <= 256;
const copy = x => structuredClone(x);
const identity = ['accountId', 'loginId', 'credentialId', 'loginGeneration'];
const binding = ['projectId', 'conversationId', 'messageId', 'runId'];
const instanceBinding = ['instanceId', 'instanceGeneration'];
export const RUN_FINISH_FIELDS = [...binding, 'runGrantId', 'requestId', 'readReceiptId', 'outcome'];
export function validateRunFinishInput(input) {
  if (!input || Object.keys(input).some(k => ![...RUN_FINISH_FIELDS, 'servicePrincipal'].includes(k)) ||
      RUN_FINISH_FIELDS.filter(k => k !== 'outcome').some(k => !text(input[k]))) reject(400, 'run-finish-invalid');
  const o = input.outcome;
  if (!o || Object.keys(o).sort().join(',') !== 'eventDigest,eventId,status,v' || o.v !== 1 ||
      !['done', 'failed', 'interrupted'].includes(o.status) || !text(o.eventId) || !/^[a-f0-9]{64}$/.test(o.eventDigest ?? ''))
    reject(400, 'run-outcome-invalid');
  return copy(o);
}
const seq = s => {
  const next = (s.runClockV2 ?? 0) + 1;
  if (!Number.isSafeInteger(next)) reject(503, 'run-clock-overflow');
  return s.runClockV2 = next;
};
const tables = s => {
  s.runGrantsV2 ??= {}; s.runRequestsV2 ??= {}; s.runReadRequestsV2 ??= {};
  s.runControlsV2 ??= {}; s.runReceiptsV2 ??= {};
  s.runFinishRequestsV2 ??= {}; s.runFinishReceiptsV2 ??= {};
};
const bumpQueue = (s, c) => {
  const revision = Math.max(s.conversationClockV2 ?? 0, c.queueRevision ?? 0) + 1;
  if (!Number.isSafeInteger(revision)) reject(503, 'conversation-clock-overflow');
  c.queueRevision = s.conversationClockV2 = revision;
};
const conversation = (s, projectId, id) => {
  const c = s.conversationsV2?.[projectId]?.[id];
  if (!c) reject(404, 'conversation-not-found');
  return c;
};
const project = (s, projectId) => {
  const p = s.projects[projectId];
  if (!p || p.status !== 'active' || p.hosted?.agent !== true) reject(403, 'agent-unavailable');
  return p;
};
const refOf = m => ({ accountId: m.senderAccountId, loginId: m.loginId,
  credentialId: m.credentialId, loginGeneration: m.loginGeneration });
/** The complete persisted sent-message identity; mutable queue/read state is excluded.
 * Model-private system/tool context may have a separate Agent inputDigest.
 */
export function canonicalReadRecord(message, { projectId, conversationId }) {
  return { v: 2, projectId, conversationId, messageId: message.messageId, runId: message.runId,
    requestId: message.requestId, senderAccountId: message.senderAccountId,
    senderNameAtSend: message.senderNameAtSend, loginId: message.loginId,
    credentialId: message.credentialId, loginGeneration: message.loginGeneration,
    content: copy(message.content), contentDigest: message.contentDigest,
    selectionSnapshot: copy(message.selectionSnapshot ?? null), attachments: copy(message.attachments ?? []) };
}
export function acceptedMessageRef(message, context) {
  const { runId: _runId, ...record } = canonicalReadRecord(message, context);
  return { projectId: context.projectId, conversationId: context.conversationId,
    messageId: message.messageId, recordDigest: digestOf(record) };
}
const member = (s, c, ref) => {
  const p = project(s, c.projectId);
  if (s.revokedLogins[`login:${ref.loginId}`]) reject(403, 'credential-revoked');
  if (p.bans?.[ref.accountId] || (p.creatorAccountId !== ref.accountId && p.members?.[ref.accountId]?.access !== 'rw')) reject(403, 'member-revoked');
  if (c.visibility === 'private' && c.ownerAccountId !== ref.accountId) reject(403, 'private-run-forbidden');
};
// Request IDs are local to a logical operation scope. Targets within the operation
// (login/account lists) belong to the payload digest, so changing them is a conflict.
export function runControlScope(fence) {
  return { kind: fence.kind, projectId: fence.projectId ?? null, conversationId: fence.conversationId ?? null,
    runId: fence.runId ?? null, serviceKid: fence.serviceKid ?? null,
    instanceId: fence.instanceId ?? null, instanceGeneration: fence.instanceGeneration ?? null, requestId: fence.requestId };
}
export const runControlId = fence => `run-control:${digestOf(runControlScope(fence))}`;

/** Durable run authorization, composed with conversation helpers in ONE account ledger
 * transaction. Service authentication is an owner-supplied capability. Complete sent
 * records are independently rebuilt here, never authorized by an HTTP body's hash.
 */
export function createRunAuthority({ ledger, conversationHooks, verifySender, verifyServiceInState, instanceAuthority,
  scopeAuthority, docInstanceId, validatePromptInState, synchronize, now = Date.now, failpoint = () => {}, onControl = () => {} } = {}) {
  for (const value of [ledger?.transaction, ledger?.read, conversationHooks?.claimNextInState,
    conversationHooks?.markReadInState, conversationHooks?.finishInState, verifySender,
    verifyServiceInState, instanceAuthority?.verifyInState, instanceAuthority?.fenceInState, synchronize])
    if (typeof value !== 'function') reject(503, 'run-authority-configuration');
  const service = (s, principal, invocation) => {
    if (s.agentRunScopesV1?.required && !scopeAuthority) reject(503, 'run-scope-unavailable');
    const v = verifyServiceInState(s, principal);
    if (v?.then || !text(v?.serviceId) || !text(v?.serviceKid)) reject(403, 'run-service-forbidden');
    const registered = instanceAuthority.verifyInState(s, principal, invocation);
    if (registered?.then || registered?.serviceId !== v.serviceId || registered.serviceKid !== v.serviceKid ||
        !text(registered.instanceId) || !Number.isSafeInteger(registered.instanceGeneration) || registered.instanceGeneration < 1)
      reject(403, 'run-instance-forbidden');
    return { serviceId: v.serviceId, serviceKid: v.serviceKid,
      instanceId: registered.instanceId, instanceGeneration: registered.instanceGeneration };
  };
  const matchService = (g, v) => {
    if (g.serviceId !== v.serviceId || g.serviceKid !== v.serviceKid) reject(403, 'run-service-mismatch');
    if (instanceBinding.some(k => g[k] !== v[k])) reject(403, 'run-instance-mismatch');
  };
  const current = (s, g) => {
    const c = conversation(s, g.projectId, g.conversationId);
    const m = c.messages.find(m => m.messageId === g.messageId);
    if (c.currentRunId !== g.runId || !m || m.runId !== g.runId ||
      identity.some(k => refOf(m)[k] !== g[k])) reject(403, 'run-no-longer-current');
    return { c, m };
  };
  const verifiedSender = async (ref, messageRef) => {
    const v = await verifySender(Object.fromEntries(identity.map(k => [k, ref[k]])),
      { purpose: 'accepted-message', messageRef: copy(messageRef) });
    if (!v || identity.some(k => v[k] !== ref[k]) || !Number.isSafeInteger(v.accountEventSeq) || v.accountEventSeq < 0)
      reject(403, 'run-sender-mismatch');
    return v;
  };
  const senderAtCommit = (s, c, ref, v) => {
    if (s.accountHead < v.accountEventSeq) reject(503, 'account-event-gap');
    member(s, c, ref);
  };
  const request = value => { if (!text(value)) reject(400, 'invalid-request-id'); };
  const replay = (table, key, digest) => {
    const old = table[key];
    if (old && old.digest !== digest) reject(409, 'run-request-mismatch');
    return old;
  };

  function fenceInState(s, f) {
    tables(s); request(f.requestId);
    if (!['credential', 'member', 'private', 'stop', 'delete', 'agent-disabled', 'service-revoked', 'instance-revoked'].includes(f.kind)) reject(400, 'invalid-run-fence');
    const scope = runControlScope(f), key = runControlId(f), digest = digestOf(f);
    const old = replay(s.runControlsV2, key, digest); if (old) return copy(old);
    const revision = seq(s), retained = [], revoked = [], cancelled = [];
    const matches = g => (!f.projectId || g.projectId === f.projectId) &&
      (!f.conversationId || g.conversationId === f.conversationId) &&
      (!f.runId || g.runId === f.runId) &&
      (!f.serviceKid || g.serviceKid === f.serviceKid) &&
      (!f.instanceId || (g.instanceId === f.instanceId && g.instanceGeneration === f.instanceGeneration)) &&
      (!f.loginIds || f.loginIds.includes(g.loginId)) &&
      (!f.accountIds || f.accountIds.includes(g.accountId));
    for (const g of Object.values(s.runGrantsV2)) {
      if (!['preparing', 'active', 'retained'].includes(g.state) || !matches(g) ||
        (f.accessSeq && f.accessSeq <= g.accessHeadAtAdmission)) continue;
      const c = conversation(s, g.projectId, g.conversationId);
      if (f.kind === 'private' && g.accountId === c.ownerAccountId) continue;
      const keep = ['credential', 'member'].includes(f.kind) && c.visibility === 'shared' &&
        g.visibilityAtRead === 'shared' && g.readReceiptId && c.currentRunId === g.runId &&
        ['active', 'retained'].includes(g.state);
      g.fenceRevision = revision; g.reason = f.kind;
      if (keep) { g.state = 'retained'; retained.push(g.runGrantId); }
      else {
        g.state = 'revoked'; revoked.push(g.runGrantId);
        if (!g.scopeBinding) conversationHooks.finishInState(s, { ...g, state: 'cancelled', reason: f.kind });
      }
    }
    for (const byProject of Object.values(s.conversationsV2 ?? {})) for (const c of Object.values(byProject)) {
      if ((f.projectId && c.projectId !== f.projectId) || (f.conversationId && c.id !== f.conversationId)) continue;
      for (const m of c.messages) {
        if (!['queued', 'preparing'].includes(m.queueState)) continue;
        if (m.runId && Object.values(s.runGrantsV2).some(g => g.runId === m.runId && g.scopeBinding)) continue;
        const candidate = { projectId: c.projectId, conversationId: c.id, runId: m.runId,
          accountId: m.senderAccountId, loginId: m.loginId };
        // Service-key revocation cancels only already assigned work for that service.
        if (['service-revoked', 'instance-revoked'].includes(f.kind) || !matches(candidate) || (f.kind === 'private' && m.senderAccountId === c.ownerAccountId)) continue;
        m.queueState = 'cancelled'; m.cancelReason = f.kind; bumpQueue(s, c);
        cancelled.push(m.messageId);
      }
    }
    const control = { controlId: key, scope, digest, payloadDigest: digest, requestId: f.requestId, kind: f.kind, projectId: f.projectId ?? null,
      fenceRevision: revision, retained, revoked, cancelled, state: 'pending', receipt: null };
    const affected = [...retained, ...revoked].map(id => s.runGrantsV2[id]);
    if (scopeAuthority) {
      control.docInstanceIds = [...new Set([...affected.flatMap(g => Object.keys(s.runDocInstancesV1?.[g.runGrantId] ?? {})),
        ...(text(docInstanceId) ? [docInstanceId] : [])])];
      for (const id of revoked) {
        const g = s.runGrantsV2[id];
        if (g.scopeBinding) { g.closureControlId = key; scopeAuthority.forcedInState(s, g, control); }
      }
    }
    control.instances = [...new Map(affected.map(g => [g.instanceId,
      Object.fromEntries(['serviceId', 'serviceKid', ...instanceBinding].map(k => [k, g[k]]))])).values()];
    if (f.kind === 'instance-revoked') {
      const registered = s.agentInstancesV2?.[f.instanceId];
      if (!registered || registered.instanceGeneration !== f.instanceGeneration || registered.state === 'active')
        reject(403, 'run-instance-fence-unverified');
      // Idle/pre-admission instances still own OS resources. A zero-grant fence
      // must retain this instance in the close inventory rather than imply none.
      control.instances = [Object.fromEntries(['serviceId', 'serviceKid', ...instanceBinding].map(k => [k, registered[k]]))];
    }
    control.operationFences = [...new Set(affected.map(g => g.projectId))].map(projectId => ({
      id: `${key}:${projectId}`, projectId,
      kind: ['credential', 'member'].includes(f.kind) ? 'credential' : ['service-revoked', 'instance-revoked'].includes(f.kind) ? 'agent-disabled' : f.kind,
      loginIds: [...new Set(affected.filter(g => g.projectId === projectId).map(g => g.loginId))],
      runIds: revoked.map(id => s.runGrantsV2[id]).filter(g => g.projectId === projectId).map(g => g.runId),
      ...(f.runId ? { runId: f.runId } : {}),
      ...(f.conversationId ? { conversationId: f.conversationId,
        ownerAccountId: conversation(s, projectId, f.conversationId).ownerAccountId } : {}),
      retainedRuns: retained.map(id => s.runGrantsV2[id]).filter(g => g.projectId === projectId).map(g =>
        Object.fromEntries([...identity, ...binding, 'runGrantId'].map(k => [k, g[k]]))),
    }));
    s.runControlsV2[key] = control;
    failpoint('run-fence-before-commit');
    return copy(control);
  }

  // A durable fallback closes the read-vs-exit gap even before notification delivery.
  // Central still MUST call the hook in its authority transaction to send/ACK controls.
  function reconcile(s) {
    tables(s);
    for (const e of s.accessEvents) {
      if (e.seq <= (s.runAccessCursorV2 ?? 0)) continue;
      const base = { requestId: `access:${e.eventId}`, accessSeq: e.seq, ...(e.projectId ? { projectId: e.projectId } : {}) };
      if (e.type === 'login-revoked') fenceInState(s, { ...base, kind: 'credential', loginIds: e.loginIds });
      else if (e.type === 'project-access-changed') {
        if (e.reason === 'delete') fenceInState(s, { ...base, kind: 'delete' });
        else if (e.reason === 'set-hosted-service' && e.service === 'agent' && e.enabled === false)
          fenceInState(s, { ...base, kind: 'agent-disabled' });
        else if (e.reason === 'set-hosted-service' && (e.service === undefined || e.enabled === undefined))
          reject(503, 'run-service-event-incomplete');
        else if (e.accountIds?.length) fenceInState(s, { ...base, kind: 'member', accountIds: e.accountIds });
      }
      s.runAccessCursorV2 = e.seq;
    }
  }
  const refreshScope = async input => {
    if (!scopeAuthority || !input) return;
    const principal = input.servicePrincipal ?? input.principal?.servicePrincipal;
    const instance = ledger.read().agentInstancesV2?.[principal?.instanceId];
    await scopeAuthority.refresh(instance?.rootScopeRef);
  };
  const sync = async input => {
    await synchronize();
    await refreshScope(input);
    return ledger.transaction(s => { reconcile(s); return Object.values(s.runControlsV2).filter(c => c.state === 'pending'); });
  };
  function applyAccessEvent(event) {
    const controls = ledger.transaction(s => {
      const stored = s.accessEvents.find(e => e.eventId === event?.eventId && e.seq === event?.seq);
      if (!stored || canonicalJson(stored) !== canonicalJson(event)) reject(403, 'run-event-unverified');
      reconcile(s);
      return Object.values(s.runControlsV2).filter(c => c.requestId === `access:${event.eventId}`);
    });
    for (const control of controls) onControl(copy(control)); return controls;
  }

  async function admit(input) {
    const { servicePrincipal, projectId, conversationId, requestId } = input;
    const invocation = { operation: 'admit', input };
    request(requestId); await sync(input);
    const before = ledger.read(), svc = service(before, servicePrincipal, invocation);
    const key = `${svc.instanceId}:${svc.instanceGeneration}:${requestId}`, digest = digestOf({ projectId, conversationId });
    const prior = replay(before.runRequestsV2 ?? {}, key, digest);
    if (prior) return copy(prior.result);
    const c = conversation(before, projectId, conversationId);
    if (c.currentRunId) reject(409, 'run-not-ready');
    const cancelled = []; let next = null, verified = null;
    for (const candidate of c.messages.filter(m => m.queueState === 'queued').sort((a, b) => a.arrivalSeq - b.arrivalSeq)) {
      try {
        member(before, c, refOf(candidate));
        verified = await verifiedSender(refOf(candidate), acceptedMessageRef(candidate, { projectId, conversationId })); next = candidate; break;
      } catch (error) {
        if (![401, 403].includes(error.status)) throw error;
        cancelled.push({ messageId: candidate.messageId, reason: error.code ?? 'credential-revoked' });
      }
    }
    const ref = next && refOf(next);
    await refreshScope(input);
    const result = ledger.transaction(s => {
      reconcile(s); service(s, servicePrincipal, invocation);
      const old = replay(s.runRequestsV2, key, digest); if (old) return old.result;
      const conv = conversation(s, projectId, conversationId);
      for (const cancelledMessage of cancelled) {
        const m = conv.messages.find(row => row.messageId === cancelledMessage.messageId);
        if (m?.queueState === 'queued') { m.queueState = 'cancelled'; m.reason = cancelledMessage.reason; bumpQueue(s, conv); }
      }
      if (!next) return { empty: true, cancelled: cancelled.map(m => m.messageId) };
      senderAtCommit(s, conv, ref, verified);
      const runId = `run_${randomUUID()}`, runGrantId = `grant_${randomUUID()}`;
      const claimed = conversationHooks.claimNextInState(s, { projectId, conversationId, runId, expectedMessageId: next.messageId });
      const { message } = claimed;
      if (!message) return { empty: !claimed.retry, retry: claimed.retry === true,
        cancelled: [...new Set([...cancelled.map(m => m.messageId), ...(claimed.cancelled ?? [])])] };
      if (message.messageId !== next.messageId || identity.some(k => refOf(message)[k] !== ref[k])) reject(409, 'run-queue-changed');
      const g = { v: 2, runGrantId, projectId, conversationId, runId, messageId: message.messageId,
        ...ref, ...svc, initiatorAccountId: ref.accountId, initiatorName: message.senderNameAtSend,
        selectionSnapshot: message.selectionSnapshot ?? null, state: 'preparing', readReceiptId: null,
        visibilityAtRead: null, fenceRevision: seq(s), accessHeadAtAdmission: s.accessHead,
        admittedAt: now(), contentDigest: message.contentDigest };
      g.messageRef = acceptedMessageRef(message, { projectId, conversationId });
      if (scopeAuthority) g.scopeBinding = scopeAuthority.assignInState(s, g);
      s.runGrantsV2[runGrantId] = g;
      const value = { ...g, message: copy(message) };
      s.runRequestsV2[key] = { digest, result: value };
      failpoint('run-admit-before-commit'); return value;
    });
    failpoint('run-admit-after-commit'); return result;
  }

  function readKey(input, svc) { return `${svc.instanceId}:${svc.instanceGeneration}:${input.requestId}`; }
  function readDigest(input) {
    return digestOf(Object.fromEntries([...binding, 'runGrantId', 'readIntentId', 'promptDigest'].map(k => [k, input[k]])));
  }
  function bound(s, input, svc) {
    const g = s.runGrantsV2?.[input.runGrantId];
    if (!g || binding.some(k => input[k] !== g[k])) reject(403, 'run-binding-mismatch');
    matchService(g, svc); return g;
  }
  async function confirmRead(input) {
    request(input.requestId); request(input.readIntentId);
    if (typeof input.promptDigest !== 'string' || digestOf(input.prompt) !== input.promptDigest) reject(400, 'prompt-digest-mismatch');
    await sync(input);
    const invocation = { operation: 'confirmRead', input };
    const before = ledger.read(), svc = service(before, input.servicePrincipal, invocation);
    if (scopeAuthority) scopeAuthority.assignmentInState(before, bound(before, input, svc), { requireBound: true });
    const digest = readDigest(input), key = readKey(input, svc);
    const old = replay(before.runReadRequestsV2 ?? {}, key, digest);
    if (old) return copy(old.result);
    const g = bound(before, input, svc), verified = await verifiedSender(g, g.messageRef);
    await refreshScope(input);
    const result = ledger.transaction(s => {
      reconcile(s); const registered = service(s, input.servicePrincipal, invocation);
      if (scopeAuthority) scopeAuthority.assignmentInState(s, bound(s, input, registered), { requireBound: true });
      const prior = replay(s.runReadRequestsV2, key, digest); if (prior) return prior.result;
      const grant = bound(s, input, registered), { c, m } = current(s, grant);
      if (scopeAuthority) scopeAuthority.assignmentInState(s, grant, { requireBound: true });
      if (grant.state !== 'preparing') reject(403, 'run-not-preparing');
      senderAtCommit(s, c, grant, verified);
      const expected = canonicalReadRecord(m, grant);
      if (canonicalJson(acceptedMessageRef(m, grant)) !== canonicalJson(grant.messageRef)) reject(503, 'accepted-message-changed');
      if (canonicalJson(expected) !== canonicalJson(input.prompt)) reject(403, 'complete-prompt-unverified');
      if (validatePromptInState && validatePromptInState(s, { conversation: c, message: m,
        prompt: copy(input.prompt), promptDigest: input.promptDigest }) !== true) reject(403, 'complete-prompt-unverified');
      const receiptId = `read_${randomUUID()}`, authoritySeq = seq(s);
      const receipt = { receiptId, ...Object.fromEntries(binding.map(k => [k, grant[k]])), runGrantId: grant.runGrantId,
        requestId: input.requestId, readIntentId: input.readIntentId, promptDigest: input.promptDigest,
        authoritySeq, readAt: now(), ...registered };
      s.runReceiptsV2[receiptId] = { ...receipt, prompt: copy(input.prompt) };
      grant.state = 'active'; grant.readReceiptId = receiptId; grant.promptDigest = input.promptDigest;
      grant.visibilityAtRead = c.visibility; grant.fenceRevision = authoritySeq;
      conversationHooks.markReadInState(s, { ...grant, readReceiptId: receiptId });
      const value = { confirmed: true, receipt: copy(receipt), runGrant: copy(grant) };
      s.runReadRequestsV2[key] = { digest, result: value };
      failpoint('run-read-before-commit'); return value;
    });
    failpoint('run-read-after-commit'); return result;
  }
  async function queryRead(input) {
    request(input.requestId); await sync(input); const s = ledger.read(), svc = service(s, input.servicePrincipal, { operation: 'queryRead', input });
    const grant = bound(s, input, svc);
    if (scopeAuthority) scopeAuthority.assignmentInState(s, grant, { requireBound: true });
    const old = replay(s.runReadRequestsV2 ?? {}, readKey(input, svc), readDigest(input));
    return old ? copy(old.result) : { confirmed: false };
  }

  async function checkWithScope({ principal, projectId, action }, invocation) {
    if (!['read', 'write'].includes(action) || principal?.realm !== 'account' || principal.identityVersion !== 2 ||
      principal.role !== 'agent' || principal.projectId !== projectId) reject(403, 'run-principal-invalid');
    await sync({ principal });
    const before = ledger.read(), svc = service(before, principal.servicePrincipal, invocation);
    const original = bound(before, principal, svc);
    if ([...identity, ...instanceBinding].some(k => principal[k] !== original[k]) || principal.serviceId !== svc.serviceId || principal.serviceKid !== svc.serviceKid)
      reject(403, 'run-principal-mismatch');
    // Retained references intentionally do not renew/reuse the revoked user's token.
    const verified = original.state === 'active' ? await verifiedSender(original, original.messageRef) : null;
    await refreshScope({ principal });
    return ledger.transaction(s => {
      reconcile(s); const v = service(s, principal.servicePrincipal, invocation), g = bound(s, principal, v);
      const { c, m } = current(s, g); project(s, projectId);
      if (scopeAuthority) scopeAuthority.assignmentInState(s, g, { requireBound: true });
      if (canonicalJson(acceptedMessageRef(m, g)) !== canonicalJson(g.messageRef)) reject(503, 'accepted-message-changed');
      if (!['active', 'retained'].includes(g.state) || g.finishReceiptId || !g.readReceiptId || !s.runReceiptsV2[g.readReceiptId]) reject(403, 'run-revoked');
      if (c.visibility === 'private' && c.ownerAccountId !== g.accountId) reject(403, 'private-run-forbidden');
      if (g.state === 'active') {
        if (!verified) reject(403, 'run-state-changed'); senderAtCommit(s, c, g, verified);
      } else if (c.visibility !== 'shared' || g.visibilityAtRead !== 'shared') reject(403, 'run-retained-invalid');
      return { allowed: true, projectId, accountId: g.accountId, runGrant: copy(g),
        ...(g.state === 'active' ? { activeGrant: { ...g, readConfirmed: true, currentRun: true } } : {}),
        ...(g.state === 'retained' ? { retainedGrant: { ...g, readConfirmed: true, currentRun: true } } : {}) };
    });
  }
  const checkAccess = input => checkWithScope(input, { operation: 'checkAccess', input });
  async function authorizeQuery(input) {
    const { principal, projectId, runGrantId } = input;
    if (runGrantId !== principal?.runGrantId) reject(403, 'run-binding-mismatch');
    const { runGrant: g } = await checkWithScope({ principal, projectId, action: 'read' }, { operation: 'authorizeQuery', input });
    return { projectId, runGrantId, initiatorAccountId: g.accountId, initiatorName: g.initiatorName,
      fenceRevision: g.fenceRevision, ...(g.selectionSnapshot ? { selectionSnapshot: copy(g.selectionSnapshot) } : {}) };
  }
  async function resolveRunPrincipal(input) {
    const { servicePrincipal, projectId, runGrantId } = input, invocation = { operation: 'resolveRunPrincipal', input };
    await sync(input); const s = ledger.read(), svc = service(s, servicePrincipal, invocation);
    const g = s.runGrantsV2?.[runGrantId];
    if (!g || g.projectId !== projectId) reject(403, 'run-binding-mismatch');
    matchService(g, svc);
    const principal = { realm: 'account', identityVersion: 2, role: 'agent', creator: false,
      ...Object.fromEntries([...identity, ...binding, 'runGrantId'].map(k => [k, g[k]])),
      ...svc, servicePrincipal };
    await checkWithScope({ principal, projectId, action: 'read' }, invocation); return principal;
  }
  async function finish(input) {
    if (scopeAuthority) return recordFinish(input);
    if (ledger.read().agentRunScopesV1?.required) reject(503, 'run-scope-unavailable');
    request(input.requestId); await sync();
    return ledger.transaction(s => {
      reconcile(s); const g = bound(s, input, service(s, input.servicePrincipal, { operation: 'finish', input }));
      if (g.state === 'finished') return copy(g);
      if (g.state === 'revoked') reject(403, 'run-revoked');
      current(s, g); g.state = 'finished'; g.fenceRevision = seq(s); g.finishedAt = now();
      conversationHooks.finishInState(s, { ...g, state: 'done' });
      return copy(g);
    });
  }
  function finishView(s, g) {
    const receipt = s.runFinishReceiptsV2?.[g.finishReceiptId];
    return { ...copy(g), finishPending: receipt?.complete !== true, finishReceipt: copy(receipt) };
  }
  async function recordFinish(input) {
    const outcome = validateRunFinishInput(input); await sync(input);
    const result = ledger.transaction(s => {
      reconcile(s); const svc = service(s, input.servicePrincipal, { operation: 'finish', input }), g = bound(s, input, svc);
      const key = digestOf({ ...svc, runGrantId: g.runGrantId, requestId: input.requestId });
      const digest = digestOf(Object.fromEntries(RUN_FINISH_FIELDS.map(k => [k, input[k]])));
      const old = replay(s.runFinishRequestsV2, key, digest); if (old) return finishView(s, g);
      if (g.finishReceiptId) reject(409, 'run-finish-conflict');
      current(s, g); scopeAuthority.assignmentInState(s, g, { requireBound: true });
      if (!['active', 'retained'].includes(g.state)) reject(403, 'run-revoked');
      const read = s.runReceiptsV2[input.readReceiptId];
      if (!read || input.readReceiptId !== g.readReceiptId || read.promptDigest !== g.promptDigest ||
          [...binding, 'runGrantId', ...instanceBinding].some(k => read[k] !== g[k])) reject(403, 'run-read-receipt-mismatch');
      const receipt = { v: 1, finishReceiptId: `finish_${randomUUID()}`, authorityId: ledger.authorityId,
        ...Object.fromEntries([...binding, 'runGrantId'].map(k => [k, g[k]])), ...svc, requestId: input.requestId,
        readReceiptId: input.readReceiptId, outcome, outcomeDigest: digestOf(outcome), requestDigest: digest,
        authoritySeq: seq(s), recordedAt: now(), complete: false };
      const target = { ...Object.fromEntries([...binding, 'runGrantId', ...instanceBinding, 'serviceId', 'serviceKid'].map(k => [k, g[k]])),
        finishReceiptId: receipt.finishReceiptId, readReceiptId: receipt.readReceiptId, outcomeDigest: receipt.outcomeDigest };
      const controlId = `terminal-control:${digestOf(target)}`; receipt.controlId = controlId;
      s.runFinishReceiptsV2[receipt.finishReceiptId] = receipt; g.finishReceiptId = receipt.finishReceiptId;
      s.runControlsV2[controlId] = { controlId, kind: 'terminal', target, payloadDigest: digestOf(target),
        projectId: g.projectId, fenceRevision: receipt.authoritySeq, state: 'pending', receipt: null,
        docInstanceIds: [...new Set([...Object.keys(s.runDocInstancesV1?.[g.runGrantId] ?? {}), ...(text(docInstanceId) ? [docInstanceId] : [])])],
        closing: [g.runGrantId], revoked: [], retained: [], cancelled: [], instances: [svc], operationFences: [] };
      s.runFinishRequestsV2[key] = { digest }; return finishView(s, g);
    });
    onControl(copy(ledger.read().runControlsV2[result.finishReceipt.controlId])); return result;
  }
  async function queryFinish(input) {
    validateRunFinishInput(input); await sync(input);
    return ledger.transaction(s => {
      reconcile(s); const svc = service(s, input.servicePrincipal, { operation: 'queryFinish', input }), g = bound(s, input, svc);
      const key = digestOf({ ...svc, runGrantId: g.runGrantId, requestId: input.requestId });
      if (!replay(s.runFinishRequestsV2, key, digestOf(Object.fromEntries(RUN_FINISH_FIELDS.map(k => [k, input[k]]))))) return { recorded: false };
      return { recorded: true, ...finishView(s, g) };
    });
  }
  async function scopeTerminalCall(input, operation) {
    request(input.requestId); await sync(input);
    if (!scopeAuthority) reject(503, 'run-scope-unavailable');
    return ledger.transaction(s => {
      reconcile(s); const g = bound(s, input, service(s, input.servicePrincipal, { operation, input }));
      current(s, g);
      if (!['active', 'retained'].includes(g.state)) reject(403, 'run-revoked');
      const receipt = s.runFinishReceiptsV2?.[input.finishReceiptId];
      if (!receipt || g.finishReceiptId !== input.finishReceiptId || receipt.runGrantId !== g.runGrantId) reject(403, 'run-finish-binding-mismatch');
      return operation === 'scopePrepare' ? scopeAuthority.recordPrepareInState(s, g, receipt, input.prepare)
        : scopeAuthority.terminalInState(s, g, receipt);
    });
  }
  const scopePrepare = input => scopeTerminalCall(input, 'scopePrepare');
  const scopeTerminal = input => scopeTerminalCall(input, 'scopeTerminal');
  async function reconcileScopeClosures() {
    if (!scopeAuthority) return [];
    const completed = [];
    for (const initial of Object.values(ledger.read().runGrantsV2 ?? {}).filter(g => g.scopeBinding && g.state !== 'finished')) {
      try {
        await scopeAuthority.refresh(initial.scopeBinding.rootScopeRef);
        const result = ledger.transaction(s => {
          reconcile(s); const g = s.runGrantsV2[initial.runGrantId];
          if (g.state === 'finished') return null;
          const receipt = s.runFinishReceiptsV2?.[g.finishReceiptId];
          if ((!receipt && g.state !== 'revoked') || !['active', 'retained', 'revoked'].includes(g.state)) reject(503, 'run-forced-closure-pending');
          const { c, m } = current(s, g);
          const forced = g.state === 'revoked';
          if (!forced && c.visibility === 'private' && c.ownerAccountId !== g.accountId) reject(403, 'private-run-forbidden');
          const evidence = scopeAuthority.closedInState(s, g, receipt);
          const outcome = forced ? { v: 1, status: 'interrupted', reason: g.reason, source: 'doc-fence-root-closed' } : receipt.outcome;
          conversationHooks.finishInState(s, { ...g, state: forced ? 'cancelled' : 'done', reason: outcome.status });
          m.terminalOutcome = copy(outcome); g.terminalOutcome = copy(outcome); g.state = 'finished';
          if (receipt) { receipt.complete = true; receipt.resourceWitnessDigest = evidence.closureWitnessDigest; }
          if (!forced) {
            const control = s.runControlsV2[receipt.controlId]; control.state = 'complete';
            control.receipt = { finishReceiptId: receipt.finishReceiptId, closureWitnessDigest: evidence.closureWitnessDigest };
          }
          return receipt ? finishView(s, g) : { ...copy(g), finishPending: false };
        });
        if (result) completed.push(result);
      } catch (error) {
        if (error.status === 503 || /^(agent-scope|run-scope)-/.test(error.code ?? '')) continue;
        throw error;
      }
    }
    return completed;
  }
  async function scopeAssignment(input) {
    request(input.requestId); await sync(input);
    if (!scopeAuthority) reject(503, 'run-scope-unavailable');
    return ledger.transaction(s => {
      reconcile(s); const g = bound(s, input, service(s, input.servicePrincipal, { operation: 'scopeAssignment', input }));
      current(s, g);
      if (!['preparing', 'active', 'retained'].includes(g.state)) reject(403, 'run-revoked');
      return scopeAuthority.assignmentInState(s, g);
    });
  }
  async function workerEventSource(input) {
    if (!scopeAuthority || !/^[a-f0-9]{64}$/.test(input.assignmentDigest ?? '')) reject(503, 'run-scope-unavailable');
    await sync();
    const before = ledger.read(), svc = service(before, input.servicePrincipal, { operation: 'workerEventSource', input });
    if (before.agentInstancesV2[svc.instanceId]?.purpose !== 'control-only') reject(403, 'instance-purpose-forbidden');
    const initial = before.runGrantsV2?.[input.runGrantId];
    if (!initial || initial.projectId !== input.projectId || initial.scopeBinding?.assignmentDigest !== input.assignmentDigest)
      reject(403, 'run-binding-mismatch');
    const verified = initial.state === 'active' ? await verifiedSender(initial, initial.messageRef) : null;
    await scopeAuthority.refresh(initial.scopeBinding.rootScopeRef);
    return ledger.transaction(s => {
      reconcile(s); service(s, input.servicePrincipal, { operation: 'workerEventSource', input });
      const g = s.runGrantsV2[input.runGrantId], { c, m } = current(s, g);
      if (!['active', 'retained'].includes(g.state) || g.finishReceiptId || !g.readReceiptId || !s.runReceiptsV2[g.readReceiptId]) reject(403, 'run-revoked');
      if (c.visibility === 'private' && c.ownerAccountId !== g.accountId) reject(403, 'private-run-forbidden');
      if (g.state === 'active') { if (!verified) reject(403, 'run-state-changed'); senderAtCommit(s, c, g, verified); }
      else if (c.visibility !== 'shared' || g.visibilityAtRead !== 'shared') reject(403, 'run-retained-invalid');
      return { allowed: true, ...scopeAuthority.eventSourceInState(s, g, s.agentInstancesV2[svc.instanceId]),
        message: copy(Object.fromEntries(['messageId', 'requestId', 'arrivalSeq', 'createdAt', 'content', 'contentDigest', 'attachments', 'selectionSnapshot',
          'senderAccountId', 'senderNameAtSend'].map(k => [k, m[k]]))), fenceRevision: g.fenceRevision, authorityRevision: s.revision };
    });
  }
  async function scopeControl(input) {
    if (!scopeAuthority) reject(503, 'run-scope-unavailable');
    await sync();
    const initial = ledger.read(), svc = service(initial, input.servicePrincipal, { operation: 'scopeControl', input });
    if (initial.agentInstancesV2[svc.instanceId]?.purpose !== 'control-only') reject(403, 'instance-purpose-forbidden');
    const g = initial.runGrantsV2?.[input.runGrantId];
    if (!g || g.projectId !== input.projectId) reject(403, 'run-binding-mismatch');
    await scopeAuthority.refresh(g.scopeBinding?.rootScopeRef);
    return ledger.transaction(s => {
      reconcile(s); service(s, input.servicePrincipal, { operation: 'scopeControl', input });
      return scopeAuthority.controlSourceInState(s, s.runGrantsV2[input.runGrantId], s.agentInstancesV2[svc.instanceId], input);
    });
  }
  function fence(input) {
    const result = ledger.transaction(s => { reconcile(s); return fenceInState(s, input); });
    // Delivery is retriable. Only a separately verified close receipt can complete it.
    onControl(copy(result)); return result;
  }
  function fenceInstance(input) {
    // An instance fence covers all of its projects/runs. Extra caller filters may
    // not truncate the close inventory or leave an assigned grant outside it.
    const exact = Object.fromEntries(['instanceId', 'instanceGeneration', 'requestId', 'reason'].map(k => [k, input[k]]));
    const result = ledger.transaction(s => {
      reconcile(s); instanceAuthority.fenceInState(s, exact);
      return fenceInState(s, { ...exact, kind: 'instance-revoked' });
    });
    onControl(copy(result)); return result;
  }
  function acknowledgeControl({ controlId, receipt }, validateReceiptInState) {
    if (typeof validateReceiptInState !== 'function') reject(503, 'run-control-verifier-unavailable');
    return ledger.transaction(s => {
      const control = s.runControlsV2?.[controlId]; if (!control) reject(404, 'run-control-not-found');
      if (receipt?.controlId !== control.controlId || receipt.fenceRevision !== control.fenceRevision ||
        receipt.complete !== true || !text(receipt.receiptId)) reject(403, 'run-control-receipt-mismatch');
      if (control.receipt) {
        if (canonicalJson(control.receipt) !== canonicalJson(receipt)) reject(409, 'run-control-ack-mismatch');
        return copy(control);
      }
      if (validateReceiptInState(s, copy(control), copy(receipt)) !== true) reject(403, 'run-control-incomplete');
      control.receipt = copy(receipt); control.state = 'complete'; return copy(control);
    });
  }
  return { admit, confirmRead, queryRead, finish, queryFinish, scopeAssignment, scopePrepare, scopeTerminal, reconcileScopeClosures, workerEventSource, scopeControl,
    checkAccess, authorizeQuery, resolveRunPrincipal, applyAccessEvent, fence, fenceInstance, acknowledgeControl,
    hooks: { fenceInState }, synchronize: sync };
}
