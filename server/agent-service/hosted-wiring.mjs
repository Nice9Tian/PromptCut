/**
 * 托管档 Agent 服务接真身份、真队列的那一层(契约 `docs/plan/cloud-agent-contract.md` 第 4、16 节;
 * `docs/plan/auth-contract.md` 第 17 节;`docs/plan/hosted-render-contract.md` 第 5a 节)。
 *
 * 用一个托管方服务的客户端(`server/auth/service-client.mjs`,服务名 `agent`,凭服务私钥连文档服务的控制连接)
 * 拼出 `startAgentService` 要的五个接口位:
 *
 *   authenticate(req)          请求头里的委托票据 → 文档服务核验 → 身份。按票据摘要缓存 15 秒;
 *                              `service-disabled` 抛 403 `disabled`,控制连接断着抛 503 `unavailable`,其余回 null(401,不说原因)
 *   credentials.admitGrant     发消息时先核一遍对话委托:是对话委托、是这个项目、这位成员、这个对话的
 *   credentials.protocolsFor   凭对话委托换一张代这位成员的连接票据(2 分钟,只在握手时用),拼成数据连接的子协议。
 *                              文档服务明确不给时抛带 `reason` 的错(这一轮按原因收尾);`unavailable`、`timeout` 是暂时性的
 *   projectState               各项目的「云端 Agent」「渲染节点」开关,由控制连接上的目录推送喂
 *   publisher                  补渲的发布通道(`render-publisher.mjs`):服务身份的发布票据 + 文档服务的任务队列
 *
 * 目录推送还管两件事(契约第 4.5 节):项目的云端 Agent 开关被关、项目没了,即使这个项目此刻没有进行中的对话
 * (没有数据连接可被文档服务关掉),也把它的实例关掉、补渲清单撤回。项目从目录里消失有两种可能——删除与搬迁;
 * 只有文档服务明确说「没有这个项目」时才当删除处理(删对话记录),搬迁只停不删。
 *
 * 委托、票据、私钥的原文不进日志:日志里只有事件名、项目 id、原因码与票据摘要的前 8 位。
 * 本文件不引用 `src/`。
 */
import { createHash } from 'node:crypto';
import { AgentServiceError } from '../agent/service/create-agent-service.mjs';
import { createQueuePublisher } from './render-publisher.mjs';

export const WIRING_DEFAULTS = Object.freeze({
  /** 委托票据的核验结果缓存多久(契约第 4.3 节①:被踢的成员最多再读这么久自己的对话列表) */
  verifyCacheMs: 15_000,
  /** 核验缓存最多多少条 */
  verifyCacheMax: 2000,
});

const digestOf = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex');
const reasonError = (reason, message) => Object.assign(new Error(message ?? `文档服务没有给凭证(${reason})`), { reason });

/** 请求头里的委托票据;没有或形状不对回 null */
export function bearerOf(req) {
  const h = req?.headers?.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer\s+([A-Za-z0-9._~+/=-]{16,4096})$/.exec(h.trim());
  return m ? m[1] : null;
}

/**
 * @param {object} o
 * @param {ReturnType<import('../auth/service-client.mjs').createServiceClient>} o.client 服务名必须是 `agent`
 * @param {string} o.docUrl 文档服务的 ws(s) 地址(发布连接连它)
 * @param {string} o.root 仓库根目录(算代码版本用)
 * @param {() => number} [o.now]
 * @param {(event: string, fields?: object) => void} [o.log]
 * @param {object} [o.limits] 覆盖 `WIRING_DEFAULTS`
 * @param {object} [o.publisherOptions] 透传给 `createQueuePublisher`(测试)
 */
export function createHostedWiring({ client, docUrl, root, now = () => Date.now(), log = () => {}, limits: limitsIn = {}, publisherOptions = {},
  accountMode = false, conversationClient = null } = {}) {
  if (accountMode === true) {
    if (typeof conversationClient?.identity !== 'function') throw new AgentServiceError('conversation-unavailable', 'doc conversation client is required', 503);
    return {
      accountMode: true,
      async authenticate(req) {
        const delegation = bearerOf(req);
        if (!delegation) return null;
        let checked;
        try { checked = await conversationClient.identity({ delegation }); }
        catch (error) { if (error?.code === 'agent-disabled') throw new AgentServiceError('disabled', 'cloud Agent is disabled', 403);
          if (error?.status === 401 || error?.status === 403) return null;
          throw new AgentServiceError('unavailable', 'doc conversation authority is unavailable', 503); }
        if (!checked || typeof checked.accountId !== 'string' || typeof checked.projectId !== 'string' ||
          typeof checked.loginId !== 'string' || !Number.isSafeInteger(checked.loginGeneration))
          throw new AgentServiceError('unavailable', 'doc conversation identity is incomplete', 503);
        return { ...checked, accountMode: true, delegation, userId: checked.accountId };
      },
      attach() {},
      describe: () => ({ accountMode: true, verified: 0, control: true }),
      close() { conversationClient.close?.(); },
    };
  }
  if (!client || typeof client.verifyDelegation !== 'function') throw new TypeError('createHostedWiring: 要服务客户端');
  const limits = { ...WIRING_DEFAULTS, ...limitsIn };
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* 日志失败不影响服务 */ } };

  /** 票据摘要 → { identity, until } */
  const verified = new Map();
  /** projectId → { agent: boolean, render: { available, enabled } };目录推送喂。没有的项目按「都开着」答(缺省开) */
  const projects = new Map();
  /** 目录至少完整到过一次 */
  let synced = false;
  let service = null;

  function dropVerified(projectId, userId = null) {
    for (const [k, v] of verified) {
      if (v.identity.projectId === projectId && (userId === null || v.identity.userId === userId)) verified.delete(k);
    }
  }

  /** 项目从目录里消失了:问一次文档服务它到底是没了还是在搬迁 */
  async function onVanished(projectId) {
    projects.delete(projectId);
    dropVerified(projectId);
    const r = await client.publishTicket(projectId);
    // 又回来了(搬迁取消、目录抖动)、或问不到(控制连接断着、超时):什么都不停,等下一次对账
    if (r.ok || (r.reason !== 'no-project' && r.reason !== 'relocating' && r.reason !== 'relocated')) return;
    const reason = r.reason === 'no-project' ? 'deleted' : 'relocating';
    say('agent.directory.gone', { projectId, reason });
    try { service?.revoke({ projectId, reason }); } catch (err) { say('agent.revoke-failed', { projectId, message: String(err?.message ?? err).slice(0, 120) }); }
  }

  function put(item) {
    if (!item || typeof item.projectId !== 'string') return;
    if (item.removed === true) { if (projects.has(item.projectId) || synced) void onVanished(item.projectId); return; }
    const prev = projects.get(item.projectId);
    const next = {
      agent: item.enabled === true,
      render: { available: item.hosted?.render?.available === true, enabled: item.hosted?.render?.enabled === true },
    };
    projects.set(item.projectId, next);
    // 开关刚被关掉(或一连上就发现它关着):没有进行中对话的闲置实例没有数据连接可被文档服务关,这里补一刀
    if (!next.agent && (prev === undefined || prev.agent)) {
      dropVerified(item.projectId);
      say('agent.directory.disabled', { projectId: item.projectId });
      try { service?.revoke({ projectId: item.projectId, reason: 'disabled' }); } catch { /* 实例已经关了 */ }
    }
  }

  const watching = client.watch({
    onProjects(list) {
      const keep = new Set(list.map((p) => p?.projectId));
      for (const id of [...projects.keys()]) if (!keep.has(id)) void onVanished(id);
      for (const item of list) put(item);
      synced = true;
    },
    onProject: put,
  });
  // 控制连接还没连上时第一次订阅会落空:连上之后客户端自己重订(`rewatch`),这里不用管
  void Promise.resolve(watching).catch(() => {});

  const publisher = createQueuePublisher({
    client, docUrl, root, now, log: say,
    renderState: (projectId) => projects.get(projectId)?.render ?? (synced ? { available: false, enabled: false } : { available: true, enabled: true }),
    ...publisherOptions,
  });

  async function authenticate(req) {
    const ticket = bearerOf(req);
    if (!ticket) return null;
    const key = digestOf(ticket);
    const hit = verified.get(key);
    const at = now();
    if (hit && hit.until > at) return hit.identity;
    if (hit) verified.delete(key);
    const r = await client.verifyDelegation(ticket);
    if (!r.ok) {
      if (r.reason === 'service-disabled') throw new AgentServiceError('disabled', '项目创建者已关闭云端 Agent。', 403);
      if (r.reason === 'unavailable' || r.reason === 'timeout' || r.reason === 'closed') throw new AgentServiceError('unavailable', '云端 Agent 暂时连不上文档服务,请稍后再试。', 503);
      say('agent.auth.reject', { reason: r.reason, delegation: key.slice(0, 8) });
      return null;
    }
    const identity = {
      projectId: r.projectId, userId: r.userId, username: r.username ?? '', deviceId: r.deviceId ?? null, deviceName: r.deviceName ?? null,
      creator: r.creator === true, mode: r.mode ?? null, access: r.access ?? r.acc ?? 'rw', ownerKey: r.ownerKey,
    };
    if (typeof identity.projectId !== 'string' || typeof identity.userId !== 'string' || typeof identity.ownerKey !== 'string') return null;
    // 缓存到期不晚于票据自己到期
    const exp = Number.isFinite(r.exp) ? (r.exp < 1e12 ? r.exp * 1000 : r.exp) : at + limits.verifyCacheMs;
    if (verified.size >= limits.verifyCacheMax) {
      for (const [k, v] of verified) { if (v.until <= at) verified.delete(k); }
      if (verified.size >= limits.verifyCacheMax) verified.delete(verified.keys().next().value);
    }
    verified.set(key, { identity, until: Math.min(at + limits.verifyCacheMs, exp) });
    return identity;
  }

  const credentials = {
    /** 发消息时带来的对话委托:必须是对话委托,而且是这个项目、这位成员、这个对话的(契约第 4.2 节) */
    async admitGrant(identity, conversationId, grant) {
      if (typeof grant !== 'string' || !grant) throw reasonError('not-grant', '这条消息没有带对话委托');
      const r = await client.verifyDelegation(grant);
      if (!r.ok) throw reasonError(r.reason);
      if (r.grant !== true) throw reasonError('not-grant');
      if (r.projectId !== identity.projectId) throw reasonError('project');
      if (r.userId !== identity.userId) throw reasonError('forbidden');
      if (r.conversationId !== conversationId) throw reasonError('conversation');
    },

    /** 实例的第 n 条数据连接用的子协议:拿这个对话的对话委托现换一张连接票据。不需要页面在场 */
    async protocolsFor(identity, n, { conversationId, grant } = {}) {
      if (typeof grant !== 'string' || !grant || typeof conversationId !== 'string' || !conversationId) throw reasonError('not-grant', '这个对话手里没有对话委托');
      const r = await client.memberTicket({ projectId: identity.projectId, conversation: n, conversationId, delegation: grant });
      if (!r.ok) {
        say('agent.ticket.refused', { projectId: identity.projectId, reason: r.reason });
        throw reasonError(r.reason);
      }
      return client.dataProtocols(r.ticket);
    },
  };

  const projectState = {
    agentEnabled: (projectId) => projects.get(projectId)?.agent !== false,
    renderEnabled: (projectId) => projects.get(projectId)?.render?.enabled !== false,
  };

  return {
    authenticate,
    credentials,
    projectState,
    publisher,
    /** 起服务之后把它交回来:目录推送据此撤销;服务撤销时清掉核验缓存 */
    attach(svc) {
      service = svc;
      svc.onRevoke?.(({ projectId, userId }) => dropVerified(projectId, userId ?? null));
    },
    /** 诊断:不含任何票据 */
    describe: () => ({ control: client.connected === true, synced, projects: projects.size, verified: verified.size, publisher: publisher.describe() }),
    close() {
      verified.clear();
      publisher.close();
    },
  };
}
