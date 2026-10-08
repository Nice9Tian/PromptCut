import { randomUUID } from 'node:crypto';
import { canonicalJson, digestOf } from './ledger.mjs';
import { accountError } from './client.mjs';

const reject = (status, code) => { throw accountError(status, code); };
const text = x => typeof x === 'string' && x.length > 0 && x.length <= 256;
const copy = x => structuredClone(x);
const identity = ['accountId', 'loginId', 'credentialId', 'loginGeneration'];
const binding = ['projectId', 'conversationId', 'messageId', 'runId'];
const seq = s => {
  const next = (s.runClockV2 ?? 0) + 1;
  if (!Number.isSafeInteger(next)) reject(503, 'run-clock-overflow');
  return s.runClockV2 = next;
};
const tables = s => {
  s.runGrantsV2 ??= {}; s.runRequestsV2 ??= {}; s.runReadRequestsV2 ??= {};
  s.runControlsV2 ??= {}; s.runReceiptsV2 ??= {};
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
    runId: fence.runId ?? null, serviceKid: fence.serviceKid ?? null, requestId: fence.requestId };
}
export const runControlId = fence => `run-control:${digestOf(runControlScope(fence))}`;

/** Durable run authorization, composed with conversation helpers in ONE account ledger
 * transaction. Service authentication is an owner-supplied capability. Complete sent
 * records are independently rebuilt here, never authorized by an HTTP body's hash.
 */
export function createRunAuthority({ ledger, conversationHooks, verifySender, verifyServiceInState,
  validatePromptInState, synchronize, now = Date.now, failpoint = () => {}, onControl = () => {} } = {}) {
  for (const value of [ledger?.transaction, ledger?.read, conversationHooks?.claimNextInState,
    conversationHooks?.markReadInState, conversationHooks?.finishInState, verifySender,
    verifyServiceInState, synchronize])
    if (typeof value !== 'function') reject(503, 'run-authority-configuration');
  const service = (s, principal) => {
    const v = verifyServiceInState(s, principal);
    if (v?.then || !text(v?.serviceId) || !text(v?.serviceKid)) reject(403, 'run-service-forbidden');
    return { serviceId: v.serviceId, serviceKid: v.serviceKid };
  };
  const matchService = (g, v) => {
    if (g.serviceId !== v.serviceId || g.serviceKid !== v.serviceKid) reject(403, 'run-service-mismatch');
  };
  const current = (s, g) => {
    const c = conversation(s, g.projectId, g.conversationId);
    const m = c.messages.find(m => m.messageId === g.messageId);
    if (c.currentRunId !== g.runId || !m || m.runId !== g.runId ||
      identity.some(k => refOf(m)[k] !== g[k])) reject(403, 'run-no-longer-current');
    return { c, m };
  };
  const verifiedSender = async ref => {
    const v = await verifySender(Object.fromEntries(identity.map(k => [k, ref[k]])));
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
    if (!['credential', 'member', 'private', 'stop', 'delete', 'agent-disabled', 'service-revoked'].includes(f.kind)) reject(400, 'invalid-run-fence');
    const scope = runControlScope(f), key = runControlId(f), digest = digestOf(f);
    const old = replay(s.runControlsV2, key, digest); if (old) return copy(old);
    const revision = seq(s), retained = [], revoked = [], cancelled = [];
    const matches = g => (!f.projectId || g.projectId === f.projectId) &&
      (!f.conversationId || g.conversationId === f.conversationId) &&
      (!f.runId || g.runId === f.runId) &&
      (!f.serviceKid || g.serviceKid === f.serviceKid) &&
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
        conversationHooks.finishInState(s, { ...g, state: 'cancelled', reason: f.kind });
      }
    }
    for (const byProject of Object.values(s.conversationsV2 ?? {})) for (const c of Object.values(byProject)) {
      if ((f.projectId && c.projectId !== f.projectId) || (f.conversationId && c.id !== f.conversationId)) continue;
      for (const m of c.messages) {
        if (!['queued', 'preparing'].includes(m.queueState)) continue;
        const candidate = { projectId: c.projectId, conversationId: c.id, runId: m.runId,
          accountId: m.senderAccountId, loginId: m.loginId };
        // Service-key revocation cancels only already assigned work for that service.
        if (f.kind === 'service-revoked' || !matches(candidate) || (f.kind === 'private' && m.senderAccountId === c.ownerAccountId)) continue;
        m.queueState = 'cancelled'; m.cancelReason = f.kind; bumpQueue(s, c);
        cancelled.push(m.messageId);
      }
    }
    const control = { controlId: key, scope, digest, payloadDigest: digest, requestId: f.requestId, kind: f.kind, projectId: f.projectId ?? null,
      fenceRevision: revision, retained, revoked, cancelled, state: 'pending', receipt: null };
    const affected = [...retained, ...revoked].map(id => s.runGrantsV2[id]);
    control.operationFences = [...new Set(affected.map(g => g.projectId))].map(projectId => ({
      id: `${key}:${projectId}`, projectId,
      kind: ['credential', 'member'].includes(f.kind) ? 'credential' : f.kind === 'service-revoked' ? 'agent-disabled' : f.kind,
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
  const sync = async () => {
    await synchronize();
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

  async function admit({ servicePrincipal, projectId, conversationId, requestId }) {
    request(requestId); await sync();
    const before = ledger.read(), svc = service(before, servicePrincipal);
    const key = `${svc.serviceKid}:${requestId}`, digest = digestOf({ projectId, conversationId });
    const prior = replay(before.runRequestsV2 ?? {}, key, digest);
    if (prior) return copy(prior.result);
    const c = conversation(before, projectId, conversationId);
    if (c.currentRunId) reject(409, 'run-not-ready');
    const cancelled = []; let next = null, verified = null;
    for (const candidate of c.messages.filter(m => m.queueState === 'queued').sort((a, b) => a.arrivalSeq - b.arrivalSeq)) {
      try {
        member(before, c, refOf(candidate));
        verified = await verifiedSender(refOf(candidate)); next = candidate; break;
      } catch (error) {
        if (![401, 403].includes(error.status)) throw error;
        cancelled.push({ messageId: candidate.messageId, reason: error.code ?? 'credential-revoked' });
      }
    }
    const ref = next && refOf(next);
    const result = ledger.transaction(s => {
      reconcile(s); service(s, servicePrincipal);
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
      s.runGrantsV2[runGrantId] = g;
      const value = { ...g, message: copy(message) };
      s.runRequestsV2[key] = { digest, result: value };
      failpoint('run-admit-before-commit'); return value;
    });
    failpoint('run-admit-after-commit'); return result;
  }

  function readKey(input, svc) { return `${svc.serviceKid}:${input.requestId}`; }
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
    await sync();
    const before = ledger.read(), svc = service(before, input.servicePrincipal);
    const digest = readDigest(input), key = readKey(input, svc);
    const old = replay(before.runReadRequestsV2 ?? {}, key, digest);
    if (old) return copy(old.result);
    const g = bound(before, input, svc), verified = await verifiedSender(g);
    const result = ledger.transaction(s => {
      reconcile(s); const registered = service(s, input.servicePrincipal);
      const prior = replay(s.runReadRequestsV2, key, digest); if (prior) return prior.result;
      const grant = bound(s, input, registered), { c, m } = current(s, grant);
      if (grant.state !== 'preparing') reject(403, 'run-not-preparing');
      senderAtCommit(s, c, grant, verified);
      const expected = canonicalReadRecord(m, grant);
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
    request(input.requestId); await sync(); const s = ledger.read(), svc = service(s, input.servicePrincipal);
    bound(s, input, svc);
    const old = replay(s.runReadRequestsV2 ?? {}, readKey(input, svc), readDigest(input));
    return old ? copy(old.result) : { confirmed: false };
  }

  async function checkAccess({ principal, projectId, action }) {
    if (!['read', 'write'].includes(action) || principal?.realm !== 'account' || principal.identityVersion !== 2 ||
      principal.role !== 'agent' || principal.projectId !== projectId) reject(403, 'run-principal-invalid');
    await sync();
    const before = ledger.read(), svc = service(before, principal.servicePrincipal);
    const original = bound(before, principal, svc);
    if (identity.some(k => principal[k] !== original[k]) || principal.serviceId !== svc.serviceId || principal.serviceKid !== svc.serviceKid)
      reject(403, 'run-principal-mismatch');
    // Retained references intentionally do not renew/reuse the revoked user's token.
    const verified = original.state === 'active' ? await verifiedSender(original) : null;
    return ledger.transaction(s => {
      reconcile(s); const v = service(s, principal.servicePrincipal), g = bound(s, principal, v);
      const { c } = current(s, g); project(s, projectId);
      if (!['active', 'retained'].includes(g.state) || !g.readReceiptId || !s.runReceiptsV2[g.readReceiptId]) reject(403, 'run-revoked');
      if (c.visibility === 'private' && c.ownerAccountId !== g.accountId) reject(403, 'private-run-forbidden');
      if (g.state === 'active') {
        if (!verified) reject(403, 'run-state-changed'); senderAtCommit(s, c, g, verified);
      } else if (c.visibility !== 'shared' || g.visibilityAtRead !== 'shared') reject(403, 'run-retained-invalid');
      return { allowed: true, projectId, accountId: g.accountId, runGrant: copy(g),
        ...(g.state === 'retained' ? { retainedGrant: { ...g, readConfirmed: true, currentRun: true } } : {}) };
    });
  }
  async function authorizeQuery({ principal, projectId, runGrantId }) {
    if (runGrantId !== principal?.runGrantId) reject(403, 'run-binding-mismatch');
    const { runGrant: g } = await checkAccess({ principal, projectId, action: 'read' });
    return { projectId, runGrantId, initiatorAccountId: g.accountId, initiatorName: g.initiatorName,
      fenceRevision: g.fenceRevision, ...(g.selectionSnapshot ? { selectionSnapshot: copy(g.selectionSnapshot) } : {}) };
  }
  async function resolveRunPrincipal({ servicePrincipal, projectId, runGrantId }) {
    await sync(); const s = ledger.read(), svc = service(s, servicePrincipal);
    const g = s.runGrantsV2?.[runGrantId];
    if (!g || g.projectId !== projectId) reject(403, 'run-binding-mismatch');
    matchService(g, svc);
    const principal = { realm: 'account', identityVersion: 2, role: 'agent', creator: false,
      ...Object.fromEntries([...identity, ...binding, 'runGrantId'].map(k => [k, g[k]])),
      ...svc, servicePrincipal };
    await checkAccess({ principal, projectId, action: 'read' }); return principal;
  }
  async function finish(input) {
    request(input.requestId); await sync();
    return ledger.transaction(s => {
      reconcile(s); const g = bound(s, input, service(s, input.servicePrincipal));
      if (g.state === 'finished') return copy(g);
      if (g.state === 'revoked') reject(403, 'run-revoked');
      current(s, g); g.state = 'finished'; g.fenceRevision = seq(s); g.finishedAt = now();
      conversationHooks.finishInState(s, { ...g, state: 'done' });
      return copy(g);
    });
  }
  function fence(input) {
    const result = ledger.transaction(s => { reconcile(s); return fenceInState(s, input); });
    // Delivery is retriable. Only a separately verified close receipt can complete it.
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
  return { admit, confirmRead, queryRead, finish, checkAccess, authorizeQuery, resolveRunPrincipal, applyAccessEvent, fence, acknowledgeControl,
    hooks: { fenceInState }, synchronize: sync };
}
