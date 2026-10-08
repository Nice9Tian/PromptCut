import { randomUUID } from 'node:crypto';
import { accountError } from './client.mjs';
import { digestOf } from './ledger.mjs';

const fail = (status, code) => { throw accountError(status, code); };
const idOK = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const requestOK = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const safePositive = value => Number.isSafeInteger(value) && value > 0;
const clock = state => { state.conversationClockV2 = (state.conversationClockV2 ?? 0) + 1; return state.conversationClockV2; };
const rows = state => (state.conversationsV2 ??= {});
const requests = state => (state.conversationRequestsV2 ??= {});
// Request IDs are local to one action on one conversation. Canonical hashing also
// avoids delimiter ambiguity in otherwise valid IDs.
const requestKey = (action, { projectId, conversationId, accountId, requestId }) =>
  `conversation:${digestOf({ action, projectId, conversationId, accountId, requestId })}`;
const conversationOf = (state, projectId, conversationId) => rows(state)[projectId]?.[conversationId] ?? null;
const queued = conversation => conversation.messages.filter(message => message.queueState === 'queued').sort((a, b) => a.arrivalSeq - b.arrivalSeq);

function projectAccessInState(state, principal, projectId, action) {
  if (!principal || principal.projectId !== projectId || typeof principal.accountId !== 'string' ||
    !principal.loginId || !principal.credentialId || !safePositive(principal.loginGeneration)) fail(401, 'principal-mismatch');
  const project = state.projects?.[projectId];
  if (!project || project.status !== 'active') fail(404, 'no-project');
  if (state.revokedLogins?.[`login:${principal.loginId}`]) fail(401, 'credential-revoked');
  if (project.hosted?.agent !== true) fail(403, 'agent-disabled');
  if (Object.hasOwn(project.bans ?? {}, principal.accountId)) fail(403, 'banned');
  const member = principal.accountId === project.creatorAccountId ? { access: 'rw' } : project.members?.[principal.accountId];
  if (!member?.access || (action === 'write' && member.access !== 'rw')) fail(403, 'not-listed');
  return { project, access: member.access, creator: project.creatorAccountId === principal.accountId };
}

function conversationAccessInState(state, principal, projectId, conversationId, action) {
  const { project, creator } = projectAccessInState(state, principal, projectId, action === 'read' ? 'read' : 'write');
  const conversation = conversationOf(state, projectId, conversationId);
  if (!conversation) fail(404, 'no-conversation');
  const owner = conversation.ownerAccountId === principal.accountId;
  const creatorReadOnly = conversation.visibility === 'private' && creator && !owner;
  if (conversation.visibility === 'private' && !owner && !(action === 'read' && creatorReadOnly)) fail(404, 'no-conversation');
  if (action === 'switch' && !owner) fail(403, 'owner-required');
  return { conversation, project, owner, creator, creatorReadOnly };
}

function publicMessage(message) {
  const { credentialId: _credentialId, loginId: _loginId, loginGeneration: _loginGeneration, ...visible } = message;
  return visible;
}
function publicConversation(conversation, creatorReadOnly = false) {
  return { v: 2, id: conversation.id, projectId: conversation.projectId, ownerAccountId: conversation.ownerAccountId,
    visibility: conversation.visibility, aclRevision: conversation.aclRevision, queueRevision: conversation.queueRevision,
    currentRunId: conversation.currentRunId, title: conversation.title, createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt, creatorReadOnly };
}

/** Synchronous helpers compose with run-authority inside one openAccountLedger.transaction. */
export function claimNextInState(state, { projectId, conversationId, runId, expectedMessageId }) {
  if (!idOK(runId) || !idOK(expectedMessageId)) fail(400, 'invalid-run');
  const conversation = conversationOf(state, projectId, conversationId);
  if (!conversation) fail(404, 'no-conversation');
  if (conversation.currentRunId) fail(409, 'busy-conversation');
  const cancelled = [];
  let message = null;
  for (const candidate of queued(conversation)) {
    if (conversation.visibility === 'private' && candidate.senderAccountId !== conversation.ownerAccountId) {
      candidate.queueState = 'cancelled'; candidate.reason = 'private'; cancelled.push(candidate.messageId); continue;
    }
    try {
      // Credential/project gates run again inside the same commit that selects a run.
      projectAccessInState(state, { projectId, accountId: candidate.senderAccountId, loginId: candidate.loginId,
        credentialId: candidate.credentialId, loginGeneration: candidate.loginGeneration }, projectId, 'write');
      message = candidate; break;
    } catch (error) {
      if (!['credential-revoked', 'banned', 'not-listed'].includes(error?.code)) throw error;
      candidate.queueState = 'cancelled'; candidate.reason = error.code; cancelled.push(candidate.messageId);
    }
  }
  if (!message) {
    if (cancelled.length) conversation.queueRevision = clock(state);
    return { conversation: structuredClone(conversation), message: null, cancelled };
  }
  if (message.messageId !== expectedMessageId) {
    if (!cancelled.length) fail(409, 'queue-shifted');
    conversation.queueRevision = clock(state);
    return { conversation: structuredClone(conversation), message: null, cancelled, retry: true };
  }
  message.queueState = 'preparing'; message.runId = runId;
  conversation.currentRunId = runId; conversation.queueRevision = clock(state);
  return { conversation: structuredClone(conversation), message: structuredClone(message), cancelled };
}

export function markReadInState(state, { projectId, conversationId, messageId, runId, readReceiptId }) {
  const conversation = conversationOf(state, projectId, conversationId);
  const message = conversation?.messages.find(row => row.messageId === messageId);
  if (!message || conversation.currentRunId !== runId || message.runId !== runId || message.queueState !== 'preparing') fail(409, 'run-fenced');
  if (!idOK(readReceiptId)) fail(400, 'invalid-receipt');
  message.readReceiptId = readReceiptId; message.queueState = 'running';
  conversation.queueRevision = clock(state);
  return structuredClone(message);
}

export function finishInState(state, { projectId, conversationId, messageId, runId, state: finalState, reason = null }) {
  if (!['done', 'cancelled'].includes(finalState)) fail(400, 'invalid-state');
  const conversation = conversationOf(state, projectId, conversationId);
  const message = conversation?.messages.find(row => row.messageId === messageId);
  if (!message || message.runId !== runId) fail(404, 'no-run');
  if (message.queueState === finalState && conversation.currentRunId !== runId) return structuredClone(message);
  if (conversation.currentRunId !== runId || !['preparing', 'running'].includes(message.queueState)) fail(409, 'run-fenced');
  message.queueState = finalState; message.reason = reason;
  conversation.currentRunId = null; conversation.queueRevision = clock(state);
  return structuredClone(message);
}

export function privateFenceInState(state, { projectId, conversationId, ownerAccountId, runHooks, requestId }) {
  const conversation = conversationOf(state, projectId, conversationId);
  if (!conversation || conversation.ownerAccountId !== ownerAccountId) fail(403, 'owner-required');
  if (conversation.visibility === 'private') return { conversation: structuredClone(conversation), cancelled: [] };
  conversation.visibility = 'private'; conversation.aclRevision = clock(state); conversation.queueRevision = clock(state);
  const cancelled = [];
  for (const message of conversation.messages) {
    if (message.queueState === 'queued' && message.senderAccountId !== ownerAccountId) {
      message.queueState = 'cancelled'; message.reason = 'private'; cancelled.push(message.messageId);
    }
  }
  if (typeof runHooks?.fenceInState !== 'function') fail(503, 'run-authority-unavailable');
  runHooks.fenceInState(state, { kind: 'private', projectId, conversationId, requestId });
  return { conversation: structuredClone(conversation), cancelled };
}

/** Doc-owned conversation and FIFO authority. Caller must provide a trusted principal reference,
 * current account consent and a server-verified selection snapshot; no body sender fields are used.
 */
export function createConversationAuthority({ ledger, accountAuthority, checkConsent, verifySelectionSnapshot,
  runHooks, now = Date.now, onFence = null } = {}) {
  if (!ledger?.transaction || !ledger?.read || !accountAuthority?.authorizePrincipal) fail(503, 'conversation-configuration');
  const verify = async (principalRef, projectId, action) => {
    const principal = await accountAuthority.authorizePrincipal(principalRef, { projectId, action });
    if (!principal?.authorizationId || principal.projectId !== projectId || !principal.accountId || !principal.loginId ||
      !principal.credentialId || !safePositive(principal.loginGeneration)) fail(503, 'principal-protocol');
    return principal;
  };
  const read = (principal, projectId, conversationId, action = 'read') => {
    const state = ledger.read();
    const checked = conversationAccessInState(state, principal, projectId, conversationId, action);
    return { state, ...checked };
  };
  const auth = async ({ principalRef, projectId, conversationId, action = 'read' }) => {
    const principal = await verify(principalRef, projectId, action === 'read' ? 'read' : 'write');
    const { conversation, creatorReadOnly } = read(principal, projectId, conversationId, action);
    return { allowed: true, accountId: principal.accountId, projectId, aclRevision: conversation.aclRevision,
      visibility: conversation.visibility, ownerAccountId: conversation.ownerAccountId, creatorReadOnly };
  };
  async function identity({ principalRef, projectId }) {
    const principal = await verify(principalRef, projectId, 'read');
    const { creator, access } = projectAccessInState(ledger.read(), principal, projectId, 'read');
    return { projectId, accountId: principal.accountId, loginId: principal.loginId, credentialId: principal.credentialId,
      loginGeneration: principal.loginGeneration, username: principal.accountName ?? principal.username ?? principal.accountId,
      access, creator };
  }
  async function list({ principalRef, projectId }) {
    const principal = await verify(principalRef, projectId, 'read');
    const state = ledger.read(); const { creator } = projectAccessInState(state, principal, projectId, 'read');
    return Object.values(rows(state)[projectId] ?? {}).filter(conversation => conversation.visibility === 'shared' ||
      conversation.ownerAccountId === principal.accountId || creator).map(conversation =>
      publicConversation(conversation, conversation.visibility === 'private' && creator && conversation.ownerAccountId !== principal.accountId));
  }
  async function get({ principalRef, projectId, conversationId, after = 0 }) {
    const principal = await verify(principalRef, projectId, 'read');
    const { conversation, creatorReadOnly } = read(principal, projectId, conversationId);
    return { ...publicConversation(conversation, creatorReadOnly), messages: conversation.messages.filter(m => m.arrivalSeq > after).map(publicMessage) };
  }
  async function send({ principalRef, projectId, conversationId, requestId, content, selectionInput = null }) {
    if (!idOK(conversationId) || !requestOK(requestId) || typeof content !== 'string' || !content.trim() ||
      Buffer.byteLength(content) > 256 * 1024) fail(400, 'invalid-message');
    const principal = await verify(principalRef, projectId, 'write');
    if (typeof checkConsent !== 'function') fail(503, 'consent-unavailable');
    const consent = await checkConsent({ accountId: principal.accountId, principal });
    if (consent?.accountId !== principal.accountId || consent.accepted !== true || consent.noticeVersion !== 1) fail(403, 'consent-required');
    const key = requestKey('send', { projectId, conversationId, accountId: principal.accountId, requestId });
    const digest = digestOf({ projectId, conversationId, requestId, content });
    const prior = ledger.read().conversationRequestsV2?.[key];
    if (prior) {
      if (prior.digest !== digest) fail(409, 'request-mismatch');
      projectAccessInState(ledger.read(), principal, projectId, 'write');
      if (conversationOf(ledger.read(), projectId, conversationId))
        conversationAccessInState(ledger.read(), principal, projectId, conversationId, 'write');
      return structuredClone(prior.result);
    }
    if (typeof verifySelectionSnapshot !== 'function') fail(503, 'selection-unavailable');
    const snapshot = await verifySelectionSnapshot({ principal, projectId, selectionInput });
    if (!snapshot || snapshot.projectId !== projectId || snapshot.accountId !== principal.accountId || snapshot.source !== 'sent-snapshot' ||
      !idOK(snapshot.pageId) || !snapshot.selection || !Number.isSafeInteger(snapshot.sentAt)) fail(503, 'selection-unavailable');
    // A lost 202 ACK may be retried after the page selection has moved. The original
    // server-verified snapshot belongs to the original request and must be replayed.
    return ledger.transaction(state => {
      const { project } = projectAccessInState(state, principal, projectId, 'write');
      const previous = requests(state)[key];
      if (previous) { if (previous.digest !== digest) fail(409, 'request-mismatch');
        conversationAccessInState(state, principal, projectId, conversationId, 'write'); return previous.result; }
      let conversation = conversationOf(state, projectId, conversationId);
      if (!conversation) {
        const owned = Object.values(rows(state)[projectId] ?? {}).filter(row => row.ownerAccountId === principal.accountId);
        if (owned.length >= 50) fail(409, 'conversation-limit');
        conversation = { v: 2, projectId, id: conversationId, ownerAccountId: principal.accountId, visibility: 'shared',
          aclRevision: clock(state), queueRevision: 0, currentRunId: null, title: content.trim().split('\n')[0].slice(0, 80),
          createdAt: now(), updatedAt: now(), messages: [] };
        (rows(state)[projectId] ??= {})[conversationId] = conversation;
      } else conversationAccessInState(state, principal, projectId, conversationId, 'write');
      if (project.hosted?.agent !== true) fail(403, 'agent-disabled');
      const arrivalSeq = clock(state); const messageId = randomUUID();
      const message = { messageId, requestId, arrivalSeq, senderAccountId: principal.accountId,
        senderNameAtSend: principal.accountName ?? principal.username ?? principal.accountId, loginId: principal.loginId,
        credentialId: principal.credentialId, loginGeneration: principal.loginGeneration, createdAt: now(),
        content, contentDigest: digestOf(content), selectionSnapshot: { ...snapshot, messageId }, attachments: [], queueState: 'queued' };
      conversation.messages.push(message); conversation.queueRevision = arrivalSeq; conversation.updatedAt = now();
      const result = { messageId, runId: null, seq: arrivalSeq, queuePosition: queued(conversation).findIndex(row => row.messageId === messageId) + 1,
        queueRevision: conversation.queueRevision, conversation: publicConversation(conversation) };
      requests(state)[key] = { digest, result };
      return result;
    });
  }
  async function switchVisibility({ principalRef, projectId, conversationId, visibility, requestId }) {
    if (!['shared', 'private'].includes(visibility) || !requestOK(requestId)) fail(400, 'invalid-visibility');
    if (visibility === 'private' && typeof onFence !== 'function') fail(503, 'agent-fence-unavailable');
    const principal = await verify(principalRef, projectId, 'write');
    const result = ledger.transaction(state => {
      const { conversation } = conversationAccessInState(state, principal, projectId, conversationId, 'switch');
      const key = requestKey('switch', { projectId, conversationId, accountId: principal.accountId, requestId });
      const digest = digestOf({ projectId, conversationId, visibility });
      const prior = requests(state)[key];
      if (prior) {
        if (prior.digest !== digest) fail(409, 'request-mismatch');
        if (conversation.aclRevision !== prior.result.aclRevision) fail(409, 'request-stale');
        return prior.result;
      }
      if (conversation.visibility === visibility) {
        const same = { ...publicConversation(conversation), cancelled: [] };
        requests(state)[key] = { digest, result: same }; return same;
      }
      if (visibility === 'private') {
        const fenced = privateFenceInState(state, { projectId, conversationId, ownerAccountId: principal.accountId, runHooks, requestId });
        const changed = { ...publicConversation(fenced.conversation), cancelled: fenced.cancelled };
        requests(state)[key] = { digest, result: changed }; return changed;
      }
      conversation.visibility = 'shared'; conversation.aclRevision = clock(state); conversation.updatedAt = now();
      const changed = { ...publicConversation(conversation), cancelled: [] };
      requests(state)[key] = { digest, result: changed }; return changed;
    });
    if (visibility === 'private') {
      const ack = await onFence({ projectId, conversationId, aclRevision: result.aclRevision });
      if (ack?.ack !== true || ack.aclRevision !== result.aclRevision) fail(503, 'agent-fence-pending');
    }
    return result;
  }
  async function stop({ principalRef, projectId, conversationId, runId, requestId }) {
    if (!idOK(runId) || !requestOK(requestId)) fail(400, 'invalid-run');
    if (typeof onFence !== 'function') fail(503, 'agent-fence-unavailable');
    const principal = await verify(principalRef, projectId, 'read');
    const result = ledger.transaction(state => {
      const { conversation, creator } = conversationAccessInState(state, principal, projectId, conversationId, 'read');
      const key = requestKey('stop', { projectId, conversationId, accountId: principal.accountId, requestId });
      const digest = digestOf({ projectId, conversationId, runId });
      const prior = requests(state)[key];
      if (prior) { if (prior.digest !== digest) fail(409, 'request-mismatch'); return prior.result; }
      const message = conversation.messages.find(row => row.runId === runId);
      if (!message || conversation.currentRunId !== runId) fail(404, 'no-run');
      if (!creator && message.senderAccountId !== principal.accountId) fail(403, 'initiator-required');
      if (typeof runHooks?.fenceInState !== 'function') fail(503, 'run-authority-unavailable');
      runHooks.fenceInState(state, { kind: 'stop', projectId, conversationId, runId, requestId });
      const result = { ok: true, runId }; requests(state)[key] = { digest, result }; return result;
    });
    const ack = await onFence({ projectId, conversationId, runId });
    if (ack?.ack !== true || ack.runId !== runId) fail(503, 'agent-fence-pending');
    return result;
  }
  async function rename({ principalRef, projectId, conversationId, title }) {
    if (typeof title !== 'string' || title.length > 80) fail(400, 'invalid-title');
    const principal = await verify(principalRef, projectId, 'write');
    return ledger.transaction(state => {
      const { conversation } = conversationAccessInState(state, principal, projectId, conversationId, 'switch');
      conversation.title = title.trim(); conversation.updatedAt = now(); return publicConversation(conversation);
    });
  }
  return { identity, access: auth, list, get, send, switchVisibility, stop, rename,
    hooks: { claimNextInState, markReadInState, finishInState, privateFenceInState },
    describe: () => ({ conversations: Object.values(ledger.read().conversationsV2 ?? {}).reduce((n, group) => n + Object.keys(group).length, 0) }) };
}
