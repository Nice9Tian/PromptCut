/**
 * 托管方服务的目录模块（契约 `docs/plan/hosted-render-contract.md` 第 1.3、2 节），类型前缀 `hosted.`。
 * 只在独立模式（托管端）且组装方给了服务登记表时挂；局域网主机不挂。
 *
 * 托管方服务（渲染服务；以后的 Agent 服务）的**控制连接**在这里看「这台节点上有哪些项目」，并为每个项目要一张连接票据：
 *
 * | 消息 | 回包 |
 * |---|---|
 * | `hosted.watch` | `hosted.projects { full: true, projects: [{ projectId, enabled, active, members, hosted }] }`；之后每次变化推 `hosted.project { projectId, enabled, active, members, hosted }` 或 `hosted.project { projectId, removed: true }` |
 * | `hosted.ticket { projectId }` | `hosted.ticket.ok { ticket, exp }`；或 `error { reason }`：`no-project`、`service-disabled`、`relocating` / `relocated`、`service-revoked` |
 * | `hosted.demand { projectId, holdMs? }` | `hosted.demand.ok { projectId, until }`：声明「这个项目有活要别的托管方服务做」 |
 * | `hosted.delegate.verify { delegation }` | `hosted.delegate.ok { projectId, userId, username, …, acc, ownerKey }`：核验云端 Agent 的委托，不签任何东西；只对代成员进项目的服务开（见 `delegateVerify`） |
 *
 * - 清单里是没在搬迁的全部共享项目；`enabled` 是这个项目对**订阅的那个服务**的开关（渲染服务看渲染的，Agent 服务看 Agent 的）；
 *   `hosted` 是各服务的 `{ available, enabled }`（与成员列表顶层同形状），一种服务据此知道另一种的开关（Agent 服务要知道渲染开没开）。
 * - `active`〔裁：主会话 2026-10-06，为「发起人退出后云端照常运转」〕按订阅的服务各算各的：这个项目的空间里此刻有
 *   **不是本服务自己**的连接（成员，或别的托管方服务如 Agent 服务），或者别的托管方服务声明过这个项目有活（`hosted.demand`，
 *   还没到期）。某一类连接的最后一条离开后再保持 `lingerMs`（缺省 60 s）。服务自己的连接不算，不然它连上之后永远不会断开。
 * - `members`：此刻有没有成员连接（不含保持期）。渲染服务据此让有人在线的项目优先（契约第 4 节）。
 * - `hosted.demand`：只有控制连接能发；`holdMs` 缺省 2 分钟、上限 10 分钟，到期前重发即续期。它只影响**别的**服务看到的 `active`
 *   （发的那个服务自己不受影响），不绕过开关：项目关掉了某个服务，那个服务照样进不来。发的服务自己的公钥被撤后声明作废。
 * - 推：凭证存储的变更通知（建、删、改开关、搬迁）与连接的进出当场推；保持期与声明到期由 `tick` 推。
 * - 拉：重新发 `hosted.watch` 得到完整清单（`full: true`），服务据此对账。
 * - 票据是普通的连接票据（2 分钟，那个项目的 `ticketKey` 签），多带 `sv`（服务名）与 `sk`（服务此刻所用公钥的 `kid`），
 *   `u` 是 `service:<服务名>@<instanceId>`，角色取登记表。
 * - `hosted.ticket` 的分发点：代成员进项目的服务（登记表 `actsFor: 'member'`，云端 Agent）凭对话委托换代成员的连接票据、
 *   或要只用来发布补渲计划的票据（`purpose: 'publish'`），见 `memberServiceTicket`；渲染服务带这几个字段回 `forbidden`。
 * - 只有控制连接（`scope: 'service'`、不在任何空间里）能发这几种消息，别的身份一律 `forbidden`（组装层的 gate 也挡一次）。
 * - `tick` 另看一眼登记表：公钥已不在表里的服务连接（控制连接与各项目里的数据连接）以 4003 `service-revoked` 关闭。
 */
import { isProjectId, serviceUserId, isConversation, isConversationId } from '../../auth/protocol.mjs';
import { checkDelegation, delegationDigest } from '../../auth/delegation.mjs';
import { signTicket } from '../../auth/tickets.mjs';
import { serviceAdmission, serviceEnabled, hostedStateOf } from '../../auth/service-identity.mjs';
import { roomUnavailableReason } from '../../recovery/relocation.mjs';

export const HOSTED_MODULE = 'hosted';
export const HOSTED_DEFAULTS = Object.freeze({ LINGER_MS: 60_000, TICK_MS: 1000, DEMAND_MS: 120_000, DEMAND_MAX_MS: 600_000 });
/** 服务的公钥被撤后关连接用的关闭码（与被移出名单同一个码） */
export const CLOSE_SERVICE = 4003;

const isReqId = (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
const MEMBER = 'member';
const serviceKey = (name) => `service:${name}`;

/**
 * @param {object} options
 * @param {() => object | null} options.store 取凭证存储
 * @param {() => object | null} options.registry 取服务登记表
 * @param {() => number} [options.now]
 * @param {number} [options.lingerMs] 某一类连接的最后一条离开后 `active` 再保持多久
 * @param {number} [options.tickMs]
 */
export function hostedModule({ store, registry, now, lingerMs = HOSTED_DEFAULTS.LINGER_MS, tickMs = HOSTED_DEFAULTS.TICK_MS } = {}) {
  const storeOf = typeof store === 'function' ? store : () => store;
  const registryOf = typeof registry === 'function' ? registry : () => registry;
  /** connId → { principal, watching, sent: Map<projectId, JSON> } */
  const conns = new Map();
  /** projectId → Map<类别, 连接数>；类别是 'member' 或 'service:<服务名>' */
  const present = new Map();
  /** projectId → Map<类别, 保持到的时刻> */
  const lingering = new Map();
  /** projectId → Map<声明的服务名, 到期时刻> */
  const demands = new Map();
  let ctxRef = null;
  let subscribedTo = null;
  let unsubscribe = null;
  let registryVersion = null;

  const clock = (ctx) => (typeof now === 'function' ? now() : ctx.now());
  const inSpace = (p) => typeof p?.tenantId === 'string' && isProjectId(p.tenantId);
  const isControl = (p) => p?.scope === 'service' && !inSpace(p);
  /** 这条连接在它的项目里算哪一类；不在共享项目里的回 null */
  const classOf = (p) => (!inSpace(p) ? null : typeof p.service === 'string' ? serviceKey(p.service) : p.scope === 'member' ? MEMBER : null);

  function reply(ctx, connId, message, reqId) {
    if (reqId !== undefined) message.reqId = reqId;
    ctx.send(connId, message);
  }

  /** 凭证存储可能晚于模块建好（或换过）：用到时再订它的变更通知 */
  function bind(ctx) {
    if (ctx) ctxRef = ctx;
    const st = storeOf();
    if (st === subscribedTo) return;
    try { unsubscribe?.(); } catch { /* 旧的存储已经不在了 */ }
    unsubscribe = null;
    subscribedTo = st;
    if (st && typeof st.onChange === 'function') unsubscribe = st.onChange(() => { if (ctxRef) sync(ctxRef); });
  }

  function bump(map, projectId, key, delta) {
    let inner = map.get(projectId);
    if (!inner) map.set(projectId, (inner = new Map()));
    const next = (inner.get(key) ?? 0) + delta;
    if (next > 0) inner.set(key, next);
    else inner.delete(key);
    if (inner.size === 0) map.delete(projectId);
    return Math.max(0, next);
  }

  /** 到期的保持与声明清掉 */
  function prune(at) {
    for (const map of [lingering, demands]) {
      for (const [projectId, inner] of map) {
        for (const [key, until] of inner) if (until <= at) inner.delete(key);
        if (inner.size === 0) map.delete(projectId);
      }
    }
  }

  /** 对服务 `service` 来说这个项目此刻算不算有活：有不是它自己的连接（含保持期），或别的服务声明过 */
  function activeFor(service, projectId, at) {
    const own = serviceKey(service);
    for (const key of present.get(projectId)?.keys() ?? []) if (key !== own) return true;
    for (const [key, until] of lingering.get(projectId) ?? []) if (key !== own && until > at) return true;
    for (const [by, until] of demands.get(projectId) ?? []) if (by !== service && until > at) return true;
    return false;
  }

  /** 这个服务此刻该看到的清单：projectId → { projectId, enabled, active, members } */
  function viewFor(service, at) {
    const out = new Map();
    const st = storeOf();
    if (!st) return out;
    for (const { projectId } of st.list()) {
      const rec = st.peek(projectId);
      if (!rec || roomUnavailableReason(rec)) continue;
      out.set(projectId, {
        projectId,
        enabled: serviceEnabled(rec, service),
        active: activeFor(service, projectId, at),
        members: (present.get(projectId)?.get(MEMBER) ?? 0) > 0,
        hosted: hostedStateOf(registryOf(), rec),
      });
    }
    return out;
  }

  /** 给每条订阅着的控制连接补发与上次不同的条目 */
  function sync(ctx) {
    const at = clock(ctx);
    prune(at);
    for (const [connId, c] of conns) {
      if (!c.watching) continue;
      const view = viewFor(c.principal.service, at);
      for (const [projectId, item] of view) {
        const text = JSON.stringify(item);
        if (c.sent.get(projectId) === text) continue;
        c.sent.set(projectId, text);
        ctx.send(connId, { type: 'hosted.project', ...item });
      }
      for (const projectId of [...c.sent.keys()]) {
        if (view.has(projectId)) continue;
        c.sent.delete(projectId);
        ctx.send(connId, { type: 'hosted.project', projectId, removed: true });
      }
    }
  }

  function watch(ctx, connId, c, msg, reqId) {
    const at = clock(ctx);
    prune(at);
    const view = viewFor(c.principal.service, at);
    c.watching = true;
    c.sent = new Map([...view].map(([projectId, item]) => [projectId, JSON.stringify(item)]));
    reply(ctx, connId, { type: 'hosted.projects', full: true, projects: [...view.values()] }, reqId);
  }

  function ticket(ctx, connId, c, msg, reqId) {
    const refuse = (reason, detail) => reply(ctx, connId, { type: 'error', reason, ...(detail ? { detail } : {}) }, reqId);
    const p = c.principal;
    // 分发点：代成员进项目的服务（云端 Agent）的两种票据，见 `memberServiceTicket`。
    // 以自己的身份进项目的服务（渲染服务）带了这几个字段一律拒：它没有「代成员」这回事
    const actsForMember = registryOf()?.get(p.service)?.actsFor === 'member';
    if (actsForMember) return memberServiceTicket(ctx, connId, c, msg, reqId);
    if (msg.conversation !== undefined || msg.conversationId !== undefined || msg.delegation !== undefined || msg.purpose !== undefined) {
      return refuse('forbidden', '这个服务要不到代成员的票据');
    }
    if (!isProjectId(msg.projectId)) return refuse('bad-message', '要 projectId');
    const rec = storeOf()?.peek(msg.projectId) ?? null;
    const refused = serviceAdmission({ registry: registryOf(), record: rec, service: p.service, kid: p.serviceKid });
    if (refused) return refuse(refused);
    const role = registryOf().get(p.service).role;
    let out;
    try {
      out = signTicket(rec, { k: 'conn', u: serviceUserId(p.service, p.deviceId), r: role, dn: p.deviceName, sv: p.service, sk: p.serviceKid }, clock(ctx));
    } catch (err) {
      return refuse(typeof err?.reason === 'string' ? err.reason : 'forbidden');
    }
    ctx.log('hosted.ticket', { connId, service: p.service, projectId: msg.projectId });
    reply(ctx, connId, { type: 'hosted.ticket.ok', ticket: out.ticket, exp: out.exp }, reqId);
  }

  function demand(ctx, connId, c, msg, reqId) {
    const refuse = (reason, detail) => reply(ctx, connId, { type: 'error', reason, ...(detail ? { detail } : {}) }, reqId);
    if (!isProjectId(msg.projectId)) return refuse('bad-message', '要 projectId');
    let holdMs = HOSTED_DEFAULTS.DEMAND_MS;
    if (msg.holdMs !== undefined && msg.holdMs !== null) {
      if (!Number.isSafeInteger(msg.holdMs) || msg.holdMs < 0 || msg.holdMs > HOSTED_DEFAULTS.DEMAND_MAX_MS) {
        return refuse('bad-message', `holdMs 要是 0～${HOSTED_DEFAULTS.DEMAND_MAX_MS} 的整数（0 表示撤回）`);
      }
      holdMs = msg.holdMs;
    }
    const p = c.principal;
    const rec = storeOf()?.peek(msg.projectId) ?? null;
    if (!rec) return refuse('no-project');
    const unavailable = roomUnavailableReason(rec);
    if (unavailable) return refuse(unavailable);
    if (!registryOf()?.has(p.service, p.serviceKid)) return refuse('service-revoked');
    const at = clock(ctx);
    const until = at + holdMs;
    let inner = demands.get(msg.projectId);
    if (!inner) demands.set(msg.projectId, (inner = new Map()));
    if (holdMs === 0) inner.delete(p.service);
    else inner.set(p.service, until);
    if (inner.size === 0) demands.delete(msg.projectId);
    reply(ctx, connId, { type: 'hosted.demand.ok', projectId: msg.projectId, until }, reqId);
    sync(ctx);
  }

  /** 登记表变了：公钥已不在表里的服务连接全部关掉，它们发的声明作废 */
  function revoke(ctx) {
    const reg = registryOf();
    if (!reg) return;
    try { reg.refresh?.(); } catch { /* 读不了按原样 */ }
    if (reg.version === registryVersion) return;
    registryVersion = reg.version;
    for (const [connId, c] of conns) {
      const p = c.principal;
      if (typeof p?.service !== 'string') continue;
      if (reg.has(p.service, p.serviceKid)) continue;
      ctx.log('hosted.revoked', { connId, service: p.service, kid: p.serviceKid });
      ctx.close?.(connId, CLOSE_SERVICE, 'service-revoked');
    }
    for (const [projectId, inner] of demands) {
      for (const by of [...inner.keys()]) if (!reg.get(by)) inner.delete(by);
      if (inner.size === 0) demands.delete(projectId);
    }
  }

  /**
   * 代成员进项目的服务（登记表 `actsFor: 'member'`，云端 Agent 服务）要票据（`docs/plan/cloud-agent-contract.md` 第 4.3 ③、16.3 R2）。两种，别的一律 `forbidden`：
   * - `{ projectId, conversation: <对话号>, conversationId: <对话 id>, delegation: <对话委托> }` → 代那位成员的连接票据：
   *   `u`、`ug` 是成员的，带 `sv`、`sk`、`c`、`acc`、`dn`、`cr?`。只认对话委托（带 `cid`、`run`），短的委托票据换不出；
   *   委托的 `p` 必须等于 `projectId`、`cid` 必须等于 `conversationId`；登记表、开关、名单、禁入表、代数都重新核一次，**不看成员在不在线**。
   *   回 `hosted.ticket.ok { ticket, exp, userId, username, access, ownerKey, conversation, conversationId }`；
   * - `{ projectId, purpose: 'publish' }`（不带委托）→ 只用来发布补渲计划的连接票据：`u` 是服务自己的 `service:<服务名>@<instanceId>`，
   *   带 `pu: 'publish'`，不带任何成员的身份与权限。回 `hosted.ticket.ok { ticket, exp }`。
   * 它没有「服务自己读写项目」这回事：不带委托又不是发布用的，`forbidden`。
   * 委托不对时的 `reason`（只在这条受信的连接上给）：`format`、`signature`、`expired`、`generation`、`audience`、`no-project`、
   * `service-disabled`、`service-revoked`、`banned`、`not-listed`、`not-grant`（不是对话委托）、`project`、`conversation`（与报的对不上）。
   */
  function memberServiceTicket(ctx, connId, c, msg, reqId) {
    const refuse = (reason, detail) => reply(ctx, connId, { type: 'error', reason, ...(detail ? { detail } : {}) }, reqId);
    const p = c.principal;
    if (!isProjectId(msg.projectId)) return refuse('bad-message', '要 projectId');
    const role = registryOf().get(p.service).role;
    const at = clock(ctx);

    if (msg.delegation === undefined || msg.delegation === null) {
      if (msg.purpose !== 'publish' || msg.conversation !== undefined || msg.conversationId !== undefined) {
        return refuse('forbidden', '不带对话委托只能要发布用的票据');
      }
      const rec = storeOf()?.peek(msg.projectId) ?? null;
      const refused = serviceAdmission({ registry: registryOf(), record: rec, service: p.service, kid: p.serviceKid });
      if (refused) return refuse(refused);
      let out;
      try {
        out = signTicket(rec, { k: 'conn', u: serviceUserId(p.service, p.deviceId), r: role, dn: p.deviceName, sv: p.service, sk: p.serviceKid, pu: 'publish' }, at);
      } catch (err) {
        return refuse(typeof err?.reason === 'string' ? err.reason : 'forbidden');
      }
      ctx.log('hosted.ticket', { connId, service: p.service, projectId: msg.projectId, purpose: 'publish' });
      return reply(ctx, connId, { type: 'hosted.ticket.ok', ticket: out.ticket, exp: out.exp }, reqId);
    }

    if (msg.purpose !== undefined) return refuse('forbidden', '带对话委托的票据没有 purpose');
    if (typeof msg.delegation !== 'string') return refuse('bad-message', 'delegation 要是字符串');
    if (role === 'agent' ? !isConversation(msg.conversation) : msg.conversation !== undefined) return refuse('bad-message', 'conversation 要是对话号（正整数）');
    if (!isConversationId(msg.conversationId)) return refuse('bad-message', 'conversationId 要是对话 id');
    const v = checkDelegation({ ticket: msg.delegation, lookup: (id) => storeOf()?.peek(id) ?? null, registry: registryOf(), service: p.service, kid: p.serviceKid, now: at });
    const digest = delegationDigest(msg.delegation);
    const deny = (reason) => {
      ctx.log('hosted.delegate.reject', { connId, service: p.service, projectId: msg.projectId, reason, delegation: digest });
      return refuse(reason);
    };
    if (!v.ok) return deny(v.reason);
    if (!v.grant) return deny('not-grant');
    if (v.payload.p !== msg.projectId) return deny('project');
    if (v.payload.cid !== msg.conversationId) return deny('conversation');
    const fields = { k: 'conn', u: v.payload.u, r: role, sv: p.service, sk: p.serviceKid, acc: v.access, cr: v.creator };
    if (role === 'agent') fields.c = msg.conversation;
    if (v.payload.dn !== undefined) fields.dn = v.payload.dn;
    let out;
    try {
      out = signTicket(v.record, fields, at);
    } catch (err) {
      return refuse(typeof err?.reason === 'string' ? err.reason : 'forbidden');
    }
    ctx.log('hosted.ticket', { connId, service: p.service, projectId: msg.projectId, conversation: msg.conversation, access: v.access, delegation: digest });
    reply(ctx, connId, {
      type: 'hosted.ticket.ok', ticket: out.ticket, exp: out.exp,
      userId: v.payload.u, username: v.username, access: v.access, ownerKey: v.ownerKey, conversation: msg.conversation, conversationId: msg.conversationId,
    }, reqId);
  }

  /**
   * 只核验不签的入口（`docs/plan/cloud-agent-contract.md` 第 4.3 ①）：`hosted.delegate.verify { delegation }`，只对代成员进项目的服务
   * （云端 Agent）开，渲染服务发它回 `forbidden`。委托票据与对话委托都认。成功回
   * `hosted.delegate.ok { projectId, userId, username, deviceId, deviceName, creator, mode, acc, exp, ownerKey, grant, conversationId? }`；
   * 失败回 `error { reason }`，`reason` 同 `memberServiceTicket`（没有 `not-grant`、`project`、`conversation`）。
   */
  function delegateVerify(ctx, connId, c, msg, reqId) {
    const refuse = (reason, detail) => reply(ctx, connId, { type: 'error', reason, ...(detail ? { detail } : {}) }, reqId);
    const p = c.principal;
    if (registryOf()?.get(p.service)?.actsFor !== 'member') return refuse('forbidden', '这个服务不能核验委托');
    if (typeof msg.delegation !== 'string') return refuse('bad-message', 'delegation 要是字符串');
    const v = checkDelegation({ ticket: msg.delegation, lookup: (id) => storeOf()?.peek(id) ?? null, registry: registryOf(), service: p.service, kid: p.serviceKid, now: clock(ctx) });
    if (!v.ok) {
      ctx.log('hosted.delegate.reject', { connId, service: p.service, reason: v.reason, delegation: delegationDigest(msg.delegation) });
      return refuse(v.reason);
    }
    reply(ctx, connId, {
      type: 'hosted.delegate.ok',
      projectId: v.payload.p, userId: v.payload.u, username: v.username, deviceId: v.deviceId, deviceName: v.payload.dn ?? v.deviceId,
      creator: v.creator, mode: v.record.mode, acc: v.access, exp: v.payload.exp, ownerKey: v.ownerKey,
      grant: v.grant, ...(v.grant ? { conversationId: v.payload.cid } : {}),
    }, reqId);
  }

  const HANDLERS = { 'hosted.watch': watch, 'hosted.ticket': ticket, 'hosted.demand': demand, 'hosted.delegate.verify': delegateVerify };

  return {
    name: HOSTED_MODULE,
    types: ['hosted.'],
    tickMs,

    connect(ctx, connId, principal) {
      bind(ctx);
      conns.set(connId, { principal: { ...principal }, watching: false, sent: new Map() });
      const key = classOf(principal);
      if (key !== null) {
        bump(present, principal.tenantId, key, 1);
        lingering.get(principal.tenantId)?.delete(key);
        sync(ctx);
      }
    },

    disconnect(ctx, connId) {
      bind(ctx);
      const c = conns.get(connId);
      conns.delete(connId);
      const key = c ? classOf(c.principal) : null;
      if (key !== null) {
        const id = c.principal.tenantId;
        if (bump(present, id, key, -1) === 0) {
          let inner = lingering.get(id);
          if (!inner) lingering.set(id, (inner = new Map()));
          inner.set(key, clock(ctx) + lingerMs);
        }
        sync(ctx);
      }
    },

    handle(ctx, connId, msg) {
      bind(ctx);
      const reqId = isReqId(msg.reqId) ? msg.reqId : undefined;
      const c = conns.get(connId);
      if (!c || !isControl(c.principal)) return reply(ctx, connId, { type: 'error', reason: 'forbidden', detail: '只有托管方服务的控制连接能用目录' }, reqId);
      const fn = HANDLERS[msg.type];
      if (!fn) return reply(ctx, connId, { type: 'error', reason: 'unsupported', detail: '目录模块不支持这种消息' }, reqId);
      return fn(ctx, connId, c, msg, reqId);
    },

    tick(ctx) {
      bind(ctx);
      revoke(ctx);
      sync(ctx);
    },

    describe() {
      return {
        watchers: [...conns.values()].filter((c) => c.watching).map((c) => ({ service: c.principal.service, kid: c.principal.serviceKid, projects: c.sent.size })),
        present: Object.fromEntries([...present].sort().map(([id, inner]) => [id, Object.fromEntries(inner)])),
        demands: Object.fromEntries([...demands].sort().map(([id, inner]) => [id, [...inner.keys()].sort()])),
      };
    },
  };
}

export default hostedModule;
