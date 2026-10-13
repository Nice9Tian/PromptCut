import { randomUUID } from 'node:crypto';
import { accountError } from './client.mjs';
import { digestOf } from './ledger.mjs';

const fail = (status, code) => { throw accountError(status, code); };
const idOK = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const requestOK = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const safePositive = value => Number.isSafeInteger(value) && value > 0;
/** 同一个项目里同一个人最多这么多个云端 Agent 对话(共有对话算在开它的人名下)。满了不让新建，也不自动删历史。 */
export const MAX_CONVERSATIONS_PER_OWNER = 50;
/** 每个人在每个项目里最多留这么多条还没弹过的删除通知(超了丢最旧的) */
export const MAX_PENDING_NOTICES = 50;
const clock = state => { state.conversationClockV2 = (state.conversationClockV2 ?? 0) + 1; return state.conversationClockV2; };
const rows = state => (state.conversationsV2 ??= {});
const requests = state => (state.conversationRequestsV2 ??= {});
const tombstones = state => (state.conversationTombstonesV2 ??= {});
const notices = state => (state.conversationNoticesV2 ??= {});
const tombstoneOf = (state, projectId, conversationId) => state.conversationTombstonesV2?.[projectId]?.[conversationId] ?? null;
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
  // 项目创建者对别人的私有对话：能读(只读)、能删(2026-10-12 用户定)，其余动作仍当作没有这个对话
  if (conversation.visibility === 'private' && !owner && !(['read', 'delete'].includes(action) && creatorReadOnly)) fail(404, 'no-conversation');
  if (action === 'switch' && !owner) fail(403, 'owner-required');
  if (action === 'delete' && !owner && !creator) fail(403, 'delete-forbidden');
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
    updatedAt: conversation.updatedAt, creatorReadOnly, ...(conversation.deletion ? { deleting: true } : {}) };
}

// Used inside the read-inventory transaction, after a real account/delegation
// verification. A list has project scope; an individual read keeps the exact
// conversation and creator's existing read-only exception.
export function conversationReadInState(state, principal, { projectId, conversationId, action, after = 0 }) {
  const { creator } = projectAccessInState(state, principal, projectId, 'read');
  if (action === 'list' && conversationId === null) return Object.values(rows(state)[projectId] ?? {})
    .filter(c => c.visibility === 'shared' || c.ownerAccountId === principal.accountId || creator)
    .map(c => publicConversation(c, c.visibility === 'private' && creator && c.ownerAccountId !== principal.accountId));
  if (!['get', 'access'].includes(action) || !idOK(conversationId) || !Number.isSafeInteger(after) || after < 0)
    fail(400, 'read-request-invalid');
  const { conversation, creatorReadOnly } = conversationAccessInState(state, principal, projectId, conversationId, 'read');
  if (action === 'access') return { allowed: true, accountId: principal.accountId, projectId,
    aclRevision: conversation.aclRevision, visibility: conversation.visibility,
    ownerAccountId: conversation.ownerAccountId, creatorReadOnly };
  return { ...publicConversation(conversation, creatorReadOnly),
    messages: conversation.messages.filter(m => m.arrivalSeq > after).map(publicMessage) };
}

/** Synchronous helpers compose with run-authority inside one openAccountLedger.transaction. */
export function claimNextInState(state, { projectId, conversationId, runId, expectedMessageId }) {
  if (!idOK(runId) || !idOK(expectedMessageId)) fail(400, 'invalid-run');
  const conversation = conversationOf(state, projectId, conversationId);
  if (!conversation) fail(404, 'no-conversation');
  if (conversation.deletion) fail(409, 'conversation-deleting');
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
  runHooks, now = Date.now, onFence = null,
  // 〔裁〕用户还没定「删掉的对话，文字在服务器上是不是彻底清除」：缺省保守，只对所有人隐藏、留存档，不清除。
  purgeDeletedContent = false } = {}) {
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
      else if (tombstoneOf(ledger.read(), projectId, conversationId)) fail(404, 'conversation-deleted');
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
        // 删掉的对话号不复活：重放旧的发送请求、拿旧对话号重新发都当作没有
        if (tombstoneOf(state, projectId, conversationId)) fail(404, 'conversation-deleted');
        // 满额只拦新建，不自动删任何历史(2026-10-08 用户定)；删除入口见 remove()
        const owned = Object.values(rows(state)[projectId] ?? {}).filter(row => row.ownerAccountId === principal.accountId);
        if (owned.length >= MAX_CONVERSATIONS_PER_OWNER) fail(409, 'conversation-limit');
        conversation = { v: 2, projectId, id: conversationId, ownerAccountId: principal.accountId, visibility: 'shared',
          aclRevision: clock(state), queueRevision: 0, currentRunId: null, title: content.trim().split('\n')[0].slice(0, 80),
          createdAt: now(), updatedAt: now(), messages: [] };
        (rows(state)[projectId] ??= {})[conversationId] = conversation;
      } else {
        conversationAccessInState(state, principal, projectId, conversationId, 'write');
        if (conversation.deletion) fail(409, 'conversation-deleting');
      }
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
      if (conversation.deletion) fail(409, 'conversation-deleting');
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
      if (conversation.deletion) fail(409, 'conversation-deleting');
      conversation.title = title.trim(); conversation.updatedAt = now(); return publicConversation(conversation);
    });
  }

  /* ---------- 删除(2026-10-12 用户定，见 docs/plan/account-binding-task.md「云端 Agent 对话的删除」) ----------
   * 谁能删：开这个对话的人删自己的；项目创建者删任何成员的(含私有)。只读成员不能删(和其它 Agent 操作一致)。
   * 有任务在跑：先对这个对话下一条「停止」围栏，等 Agent 一侧确认任务真的停下、资源收干净(onFence 回 ack)，才删；
   * 停不下来(围栏还在办)就不删，对话停在「正在删除」状态，用同一个请求号重试即可，期间不再收新消息。
   * 删完：对话从列表和计数里拿掉(立刻让出名额)，留一条存档；给该通知的人各存一条通知，打开项目时取走。 */
  function finishRemoval(state, { principal, conversation, deleterName }) {
    const { projectId } = conversation;
    const deleter = principal.accountId;
    const deletedByRole = conversation.ownerAccountId === deleter ? 'owner' : 'creator';
    // 通知谁：开对话的人(删的不是他自己时)；共有对话里发过消息的其他成员。删的人自己不通知，没发过消息的成员不通知。
    const recipients = new Map();
    if (conversation.ownerAccountId !== deleter) recipients.set(conversation.ownerAccountId, 'owner');
    if (conversation.visibility === 'shared') for (const message of conversation.messages) {
      const sender = message.senderAccountId;
      if (sender !== deleter && !recipients.has(sender)) recipients.set(sender, 'participant');
    }
    const at = now();
    for (const [accountId, recipientRole] of recipients) {
      const list = ((notices(state)[projectId] ??= {})[accountId] ??= []);
      list.push({ noticeId: randomUUID(), kind: 'conversation-deleted', projectId, conversationId: conversation.id,
        title: conversation.title, deletedByAccountId: deleter, deletedByName: deleterName, deletedByRole, recipientRole, createdAt: at });
      while (list.length > MAX_PENDING_NOTICES) list.shift();
    }
    const stone = { id: conversation.id, projectId, ownerAccountId: conversation.ownerAccountId, visibility: conversation.visibility,
      deletedAt: at, deletedByAccountId: deleter, requestId: conversation.deletion.requestId, notified: recipients.size,
      participantAccountIds: [...new Set(conversation.messages.map(m => m.senderAccountId))],
      archive: purgeDeletedContent ? null : structuredClone(conversation) };
    (tombstones(state)[projectId] ??= {})[conversation.id] = stone;
    delete rows(state)[projectId][conversation.id];
    return removalResult(stone, false);
  }
  const removalResult = (stone, already) => ({ conversationId: stone.id, projectId: stone.projectId, removed: true, already,
    deletedAt: stone.deletedAt, notified: stone.notified });
  const liveRunOf = (state, projectId, conversationId) => Object.values(state.runGrantsV2 ?? {}).some(grant =>
    grant.projectId === projectId && grant.conversationId === conversationId && ['preparing', 'active', 'retained'].includes(grant.state));

  async function remove({ principalRef, projectId, conversationId, requestId }) {
    if (!idOK(conversationId) || !requestOK(requestId)) fail(400, 'invalid-delete-request');
    const principal = await verify(principalRef, projectId, 'write');
    const deleterName = principal.accountName ?? principal.username ?? principal.accountId;
    const key = requestKey('remove', { projectId, conversationId, accountId: principal.accountId, requestId });
    const digest = digestOf({ projectId, conversationId });
    // 删除已经完成时的重复请求(同一个请求重放，或另一个请求撞上已经删掉的)：开对话的人和创建者得到「已删」，别人当作没有
    const settled = (state, project) => {
      const stone = tombstoneOf(state, projectId, conversationId);
      if (!stone || (stone.ownerAccountId !== principal.accountId && project.creatorAccountId !== principal.accountId)) fail(404, 'no-conversation');
      const result = removalResult(stone, true);
      requests(state)[key] = { digest, result };
      return { done: result };
    };
    const begun = ledger.transaction(state => {
      const { project } = projectAccessInState(state, principal, projectId, 'write');
      const prior = requests(state)[key];
      if (prior) { if (prior.digest !== digest) fail(409, 'request-mismatch'); return { done: prior.result }; }
      const conversation = conversationOf(state, projectId, conversationId);
      if (!conversation) return settled(state, project);
      conversationAccessInState(state, principal, projectId, conversationId, 'delete');
      if (conversation.deletion && conversation.deletion.byAccountId !== principal.accountId) fail(409, 'conversation-deleting');
      const runId = conversation.currentRunId;
      // 有任务在跑却没有停任务的口子：什么都不动，不进「正在删除」
      if (runId && typeof runHooks?.fenceInState !== 'function') fail(503, 'run-authority-unavailable');
      if (runId && typeof onFence !== 'function') fail(503, 'agent-fence-unavailable');
      if (!conversation.deletion) {
        conversation.deletion = { requestId, byAccountId: principal.accountId, byName: deleterName, at: now() };
        conversation.aclRevision = clock(state);
        for (const message of conversation.messages) if (message.queueState === 'queued') {
          message.queueState = 'cancelled'; message.reason = 'deleted';
        }
        conversation.queueRevision = clock(state);
      }
      if (runId) {
        // 围栏的请求号取第一次删除的请求号，换请求号重试也落在同一条控制记录上
        runHooks.fenceInState(state, { kind: 'stop', projectId, conversationId, runId, requestId: `delete:${conversation.deletion.requestId}` });
        return { runId };
      }
      const result = finishRemoval(state, { principal, conversation, deleterName });
      requests(state)[key] = { digest, result };
      return { done: result };
    });
    if (begun.done) return begun.done;
    const ack = await onFence({ projectId, conversationId, runId: begun.runId });
    if (ack?.ack !== true || ack.runId !== begun.runId) fail(503, 'agent-fence-pending');
    return ledger.transaction(state => {
      const { project } = projectAccessInState(state, principal, projectId, 'write');
      const conversation = conversationOf(state, projectId, conversationId);
      if (!conversation) return settled(state, project).done;
      conversationAccessInState(state, principal, projectId, conversationId, 'delete');
      if (!conversation.deletion || conversation.deletion.byAccountId !== principal.accountId) fail(409, 'conversation-deleting');
      // 任务没有真停下：不删
      if (conversation.currentRunId || liveRunOf(state, projectId, conversationId)) fail(503, 'agent-fence-pending');
      const result = finishRemoval(state, { principal, conversation, deleterName });
      requests(state)[key] = { digest, result };
      return result;
    });
  }

  /** 这位成员在这个项目里还没弹过的删除通知(打开项目时取，弹完用 ackNotices 回执) */
  async function pendingNotices({ principalRef, projectId }) {
    const principal = await verify(principalRef, projectId, 'read');
    const state = ledger.read();
    projectAccessInState(state, principal, projectId, 'read');
    return structuredClone(state.conversationNoticesV2?.[projectId]?.[principal.accountId] ?? []);
  }
  async function ackNotices({ principalRef, projectId, noticeIds }) {
    if (!Array.isArray(noticeIds) || noticeIds.length > 200 || !noticeIds.every(id => typeof id === 'string' && id.length <= 64)) fail(400, 'invalid-notice-ack');
    const principal = await verify(principalRef, projectId, 'read');
    return ledger.transaction(state => {
      projectAccessInState(state, principal, projectId, 'read');
      const byProject = notices(state)[projectId] ??= {};
      const before = byProject[principal.accountId] ?? [];
      const ids = new Set(noticeIds);
      byProject[principal.accountId] = before.filter(notice => !ids.has(notice.noticeId));
      return { acked: before.length - byProject[principal.accountId].length };
    });
  }
  return { identity, access: auth, list, get, send, switchVisibility, stop, rename, remove, notices: pendingNotices, ackNotices,
    hooks: { claimNextInState, markReadInState, finishInState, privateFenceInState },
    describe: () => ({ conversations: Object.values(ledger.read().conversationsV2 ?? {}).reduce((n, group) => n + Object.keys(group).length, 0) }) };
}
