import { randomUUID } from 'node:crypto';
import { AgentServiceError } from './create-agent-service.mjs';

const translated = error => {
  if (error instanceof AgentServiceError) return error;
  const status = Number.isInteger(error?.status) ? error.status : 503;
  return new AgentServiceError(error?.code ?? 'conversation-unavailable', error?.code ?? 'conversation-unavailable', status);
};
const context = (identity, conversationId) => ({ delegation: identity.delegation,
  projectId: identity.projectId, ...(conversationId ? { conversationId } : {}) });
const requireIdentity = identity => {
  if (!identity || identity.accountMode !== true || typeof identity.delegation !== 'string' || !identity.delegation ||
    typeof identity.projectId !== 'string' || !identity.projectId || typeof identity.accountId !== 'string' || !identity.accountId)
    throw new AgentServiceError('unauthorized', 'unauthorized', 401);
};

/** Account-v2 HTTP surface. It relies on doc mTLS for every read and write. Runs stay queued
 * until the run-authority/read-intent executor is mounted; this module never fabricates ACKs.
 */
export function createAccountConversationService({ conversationClient, now = Date.now } = {}) {
  if (!conversationClient || ['identity', 'access', 'list', 'get', 'send', 'switchVisibility', 'stop', 'rename']
    .some(name => typeof conversationClient[name] !== 'function')) throw new AgentServiceError('conversation-unavailable', 'doc conversation client is required', 503);
  const call = async (fn, identity, conversationId, fields = {}) => {
    requireIdentity(identity);
    try { return await conversationClient[fn]({ ...context(identity, conversationId), ...fields }); }
    catch (error) { throw translated(error); }
  };
  return {
    accountMode: true,
    egressTestAllow: false, look: false, collect: false, collectTestRunner: false,
    conversations: identity => call('list', identity),
    conversation: (identity, conversationId, after = 0) => call('get', identity, conversationId, { after }),
    access: (identity, conversationId, action = 'read') => call('access', identity, conversationId, { action }),
    async send(identity, conversationId, body = {}) {
      if (typeof body.prompt !== 'string' || !body.prompt.trim()) throw new AgentServiceError('bad-request', 'message is empty', 400);
      if (Array.isArray(body.attachments) && body.attachments.length) throw new AgentServiceError('attachment-unavailable', 'attachment authority is not mounted', 503);
      const requestId = typeof body.requestId === 'string' ? body.requestId : randomUUID();
      return call('send', identity, conversationId, { requestId, content: body.prompt, selectionInput: body.selectionSnapshot ?? null });
    },
    switchVisibility: (identity, conversationId, visibility, requestId = randomUUID()) =>
      call('switchVisibility', identity, conversationId, { visibility, requestId }),
    rename: (identity, conversationId, title) => call('rename', identity, conversationId, { title }),
    abort: (identity, conversationId, runId, requestId = randomUUID()) => call('stop', identity, conversationId, { runId, requestId }),
    async info(identity) { await call('identity', identity); return { enabled: true, accountMode: true, running: [] }; },
    async usage(identity) { await call('identity', identity); throw new AgentServiceError('usage-unavailable', 'usage authority is not mounted', 503); },
    async attach(identity) { await call('identity', identity); throw new AgentServiceError('attachment-unavailable', 'attachment authority is not mounted', 503); },
    async pageResult(identity) { await call('identity', identity); throw new AgentServiceError('run-unavailable', 'run authority is not mounted', 503); },
    async remove(identity) { await call('identity', identity); throw new AgentServiceError('deletion-pending', 'conversation deletion policy is pending', 503); },
    onRevoke: () => () => {},
    close() {},
    describe: () => ({ accountMode: true, runAuthorityMounted: false, at: now() }),
  };
}
