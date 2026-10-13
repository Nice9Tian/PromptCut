import { randomUUID } from 'node:crypto';
import { AgentServiceError } from './create-agent-service.mjs';
import { queryUsage } from './usage.mjs';

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
export function createAccountConversationService({ conversationClient, usageDir = null, now = Date.now,
  /** 对话被删以后清 Agent 服务一侧自己存的这个对话的东西(conversation-purge.mjs)；没有存储的装配不给 */
  purger = null,
  /**
   * 〔接缝〕对话被删时无条件收掉这个对话在 Agent 一侧还占着的东西(云端浏览器、感知子进程等)：`async ({ projectId, conversationId }) => void`。
   * 文档服务确认删掉(含重复删除得到「已删」)以后调用；失败回页面 503 `purge-failed`，页面用同一个请求号重试会再调一次，所以实现要幂等。
   * 缺省什么都不做；claude/v18-wire(云端工具表接线)合入后由装配把它接到 hosted-tools 的「收掉这个对话的子进程」上。
   */
  onConversationDeleted = null,
  /** 删除时对话里有任务在跑：围栏(强制结束)下去以后，替页面等 root 把进程关掉、文档服务结清，最多等这么久(毫秒)，同「停止最多等 15 秒」 */
  deleteWaitMs = 15_000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (!conversationClient || ['identity', 'access', 'list', 'get', 'send', 'switchVisibility', 'stop', 'rename']
    .some(name => typeof conversationClient[name] !== 'function')) throw new AgentServiceError('conversation-unavailable', 'doc conversation client is required', 503);
  const call = async (fn, identity, conversationId, fields = {}) => {
    requireIdentity(identity);
    try { return await conversationClient[fn]({ ...context(identity, conversationId), ...fields }); }
    catch (error) { throw translated(error); }
  };
  /** 文档服务确认删掉以后，Agent 一侧各处清干净；任何一处失败都抛 503，页面重试同一个请求会再来一遍 */
  async function afterDeleted(projectId, conversationId) {
    try {
      await purger?.purge({ projectId, conversationId });
      await onConversationDeleted?.({ projectId, conversationId });
    } catch (error) { throw new AgentServiceError('purge-failed', 'purge-failed', 503); }
  }
  return {
    accountMode: true,
    get readTransports() { return conversationClient.readTransports ?? null; },
    egressTestAllow: false, look: false, collect: false, collectTestRunner: false,
    conversations: identity => call('list', identity),
    conversation: (identity, conversationId, after = 0) => call('get', identity, conversationId, { after }),
    access: (identity, conversationId, action = 'read') => call('access', identity, conversationId, { action }),
    async send(identity, conversationId, body = {}) {
      if (typeof body.prompt !== 'string' || !body.prompt.trim()) throw new AgentServiceError('bad-request', 'message is empty', 400);
      // 附件要先由挂了附件存储的服务核过（`account-master-assembly.mjs` 的 send 把核过的引用放在 `verifiedAttachments` 里）；
      // 没挂存储的这一份照旧拒绝，不把页面自报的地址交给文档服务。
      const attachments = body.verifiedAttachments ?? null;
      if (Array.isArray(body.attachments) && body.attachments.length && !attachments) throw new AgentServiceError('attachment-unavailable', 'attachment authority is not mounted', 503);
      const requestId = typeof body.requestId === 'string' ? body.requestId : randomUUID();
      return call('send', identity, conversationId, { requestId, content: body.prompt, selectionInput: body.selectionSnapshot ?? null,
        ...(attachments?.length ? { attachments } : {}) });
    },
    switchVisibility: (identity, conversationId, visibility, requestId = randomUUID()) =>
      call('switchVisibility', identity, conversationId, { visibility, requestId }),
    rename: (identity, conversationId, title) => call('rename', identity, conversationId, { title }),
    abort: (identity, conversationId, runId, requestId = randomUUID()) => call('stop', identity, conversationId, { runId, requestId }),
    async info(identity) { await call('identity', identity); return { enabled: true, accountMode: true, executorMounted: false, running: [] }; },
    /** 本项目的用量(契约第 6.3 节:项目内的成员可查总量与各成员、各模型的量)。身份由文档服务按账号核对:
     * `identity` 对不上这个项目的成员(没登录、不是成员、被踢)就在这里抛错,不回任何数字;只回自己项目的流水。
     * 没挂用量目录(没有执行器)仍然回 503,不编造零。成员只给显示名,不给账号编号。 */
    async usage(identity, since = null) {
      await call('identity', identity);
      if (typeof usageDir !== 'string' || !usageDir) throw new AgentServiceError('usage-unavailable', 'usage authority is not mounted', 503);
      const q = queryUsage(usageDir, { projectId: identity.projectId, since: Number.isFinite(since) && since > 0 ? since : null });
      const p = q.projects[identity.projectId];
      const people = (members, pick) => Object.entries(members ?? {}).map(([userId, m]) => ({ username: m.username || '', ...pick(m) }));
      return {
        project: { tokens: p?.tokens ?? 0, calls: p?.calls ?? 0, input: p?.input ?? 0, output: p?.output ?? 0 },
        members: people(p?.members, m => ({ tokens: m.tokens, calls: m.calls })),
        models: Object.entries(p?.models ?? {}).map(([model, m]) => ({ model, tokens: m.tokens, calls: m.calls })),
        services: Object.entries(p?.services ?? {}).map(([key, sv]) => ({ service: key.split('/')[0], vendor: key.split('/').slice(1).join('/'),
          calls: sv.calls, units: sv.units, unit: sv.unit, members: people(sv.members, m => ({ calls: m.calls, units: m.units })) })),
      };
    },
    async attach(identity) { await call('identity', identity); throw new AgentServiceError('attachment-unavailable', 'attachment authority is not mounted', 503); },
    async pageResult(identity) { await call('identity', identity); throw new AgentServiceError('run-unavailable', 'run authority is not mounted', 503); },
    /** 删除(2026-10-12 用户定)：权限、确认前的名额与停任务都由文档服务的对话权威判；这里只转发。requestId 由页面给，同一次删除重试沿用 */
    async remove(identity, conversationId, requestId = randomUUID()) {
      if (typeof conversationClient.remove !== 'function') throw new AgentServiceError('deletion-unavailable', 'conversation deletion is not mounted', 503);
      const deadline = now() + deleteWaitMs;
      let result;
      // 有任务在跑：文档服务先下强制结束的围栏、等 root 关进程，没办完回 503 agent-fence-pending；同一个请求号隔一会儿再问
      for (;;) {
        try { result = await call('remove', identity, conversationId, { requestId }); break; }
        catch (error) { if (error?.code !== 'agent-fence-pending' || now() >= deadline) throw error; await sleep(200); }
      }
      await afterDeleted(identity.projectId, conversationId);
      return result;
    },
    /** 移出成员时顺带清他的私有对话(项目创建者做)：文档服务逐个删，这里再把删掉的各个清干净 */
    async removeMemberPrivate(identity, accountId, requestId = randomUUID()) {
      if (typeof conversationClient.removeMemberPrivate !== 'function') throw new AgentServiceError('deletion-unavailable', 'conversation deletion is not mounted', 503);
      const deadline = now() + deleteWaitMs;
      let result;
      for (;;) {
        result = await call('removeMemberPrivate', identity, undefined, { targetAccountId: accountId, requestId });
        if (!result.pending?.length || now() >= deadline) break;
        await sleep(200);
      }
      for (const id of result.removed) await afterDeleted(identity.projectId, id);
      return result;
    },
    /** 别人删了和你有关的对话时留给你的通知(打开项目时取，弹完回执) */
    async notices(identity) {
      if (typeof conversationClient.notices !== 'function') throw new AgentServiceError('notices-unavailable', 'conversation notices are not mounted', 503);
      return call('notices', identity);
    },
    async ackNotices(identity, noticeIds) {
      if (typeof conversationClient.ackNotices !== 'function') throw new AgentServiceError('notices-unavailable', 'conversation notices are not mounted', 503);
      return call('ackNotices', identity, undefined, { noticeIds });
    },
    onRevoke: () => () => {},
    close() {},
    describe: () => ({ accountMode: true, runAuthorityMounted: false, at: now() }),
  };
}
