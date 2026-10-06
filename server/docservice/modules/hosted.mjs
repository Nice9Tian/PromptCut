/**
 * 托管方服务的目录模块（契约 `docs/plan/hosted-render-contract.md` 第 1.3、2 节），类型前缀 `hosted.`。
 * 只在独立模式（托管端）且组装方给了服务登记表时挂；局域网主机不挂。
 *
 * 托管方服务（渲染服务；以后的 Agent 服务）的**控制连接**在这里看「这台节点上有哪些项目」，并为每个项目要一张连接票据：
 *
 * | 消息 | 回包 |
 * |---|---|
 * | `hosted.watch` | `hosted.projects { full: true, projects: [{ projectId, enabled, active }] }`；之后每次变化推 `hosted.project { projectId, enabled, active }` 或 `hosted.project { projectId, removed: true }` |
 * | `hosted.ticket { projectId }` | `hosted.ticket.ok { ticket, exp }`；或 `error { reason }`：`no-project`、`service-disabled`、`relocating` / `relocated`、`service-revoked` |
 *
 * - 清单里是没在搬迁的全部共享项目；`enabled` 是这个项目对这个服务的开关（渲染服务看 `hostedRender.enabled`）；
 *   `active` 是这个项目的空间里此刻有成员连接，最后一个成员离开后再保持 `lingerMs`（缺省 60 s）；
 * - 推：凭证存储的变更通知（建、删、改开关、搬迁）与成员连接的进出当场推；`active` 的保持到期由 `tick` 推；
 * - 拉：重新发 `hosted.watch` 得到完整清单（`full: true`），服务据此对账；
 * - 票据是普通的连接票据（2 分钟，那个项目的 `ticketKey` 签），多带 `sv`（服务名）与 `sk`（服务此刻所用公钥的 `kid`），
 *   `u` 是 `service:<服务名>@<instanceId>`，角色取登记表；
 * - `hosted.ticket` 的 `conversation`、`delegation` 两个字段位留给第四段（云端 Agent 服务），本段给了就回 `unsupported`；
 * - 只有控制连接（`scope: 'service'`、不在任何空间里）能发这两种消息，别的身份一律 `forbidden`（组装层的 gate 也挡一次）；
 * - `tick` 另看一眼登记表：公钥已不在表里的服务连接（控制连接与各项目里的数据连接）以 4003 `service-revoked` 关闭。
 */
import { isProjectId, serviceUserId } from '../../auth/protocol.mjs';
import { signTicket } from '../../auth/tickets.mjs';
import { serviceAdmission, serviceEnabled } from '../../auth/service-identity.mjs';
import { roomUnavailableReason } from '../../recovery/relocation.mjs';

export const HOSTED_MODULE = 'hosted';
export const HOSTED_DEFAULTS = Object.freeze({ LINGER_MS: 60_000, TICK_MS: 1000 });
/** 服务的公钥被撤后关连接用的关闭码（与被移出名单同一个码） */
export const CLOSE_SERVICE = 4003;

const isReqId = (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));

/**
 * @param {object} options
 * @param {() => object | null} options.store 取凭证存储
 * @param {() => object | null} options.registry 取服务登记表
 * @param {() => number} [options.now]
 * @param {number} [options.lingerMs] 最后一个成员离开后 `active` 再保持多久
 * @param {number} [options.tickMs]
 */
export function hostedModule({ store, registry, now, lingerMs = HOSTED_DEFAULTS.LINGER_MS, tickMs = HOSTED_DEFAULTS.TICK_MS } = {}) {
  const storeOf = typeof store === 'function' ? store : () => store;
  const registryOf = typeof registry === 'function' ? registry : () => registry;
  /** connId → { principal, watching, sent: Map<projectId, JSON> } */
  const conns = new Map();
  /** projectId → 成员连接数 */
  const members = new Map();
  /** projectId → 最后一个成员离开后保持到的时刻 */
  const lingerUntil = new Map();
  let ctxRef = null;
  let subscribedTo = null;
  let unsubscribe = null;
  let registryVersion = null;

  const clock = (ctx) => (typeof now === 'function' ? now() : ctx.now());
  const isControl = (p) => p?.scope === 'service' && !(typeof p.tenantId === 'string' && p.tenantId !== '');
  const isMember = (p) => p?.scope === 'member' && isProjectId(p.tenantId);

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

  /** 这个服务此刻该看到的清单：projectId → { projectId, enabled, active } */
  function viewFor(service, at) {
    const out = new Map();
    const st = storeOf();
    if (!st) return out;
    for (const { projectId } of st.list()) {
      const rec = st.peek(projectId);
      if (!rec || roomUnavailableReason(rec)) continue;
      const active = (members.get(projectId) ?? 0) > 0 || (lingerUntil.get(projectId) ?? -Infinity) > at;
      out.set(projectId, { projectId, enabled: serviceEnabled(rec, service), active });
    }
    return out;
  }

  /** 给每条订阅着的控制连接补发与上次不同的条目 */
  function sync(ctx) {
    const at = clock(ctx);
    for (const [projectId, until] of lingerUntil) if (until <= at) lingerUntil.delete(projectId);
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
    const view = viewFor(c.principal.service, clock(ctx));
    c.watching = true;
    c.sent = new Map([...view].map(([projectId, item]) => [projectId, JSON.stringify(item)]));
    reply(ctx, connId, { type: 'hosted.projects', full: true, projects: [...view.values()] }, reqId);
  }

  function ticket(ctx, connId, c, msg, reqId) {
    const refuse = (reason, detail) => reply(ctx, connId, { type: 'error', reason, ...(detail ? { detail } : {}) }, reqId);
    if (msg.conversation !== undefined || msg.delegation !== undefined) return refuse('unsupported', 'conversation / delegation 留给以后的服务，本服务不认');
    if (!isProjectId(msg.projectId)) return refuse('bad-message', '要 projectId');
    const p = c.principal;
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

  /** 登记表变了：公钥已不在表里的服务连接全部关掉 */
  function revoke(ctx) {
    const reg = registryOf();
    if (!reg) return;
    try { reg.refresh?.(); } catch { /* 读不了按原样 */ }
    if (reg.version === registryVersion) return;
    registryVersion = reg.version;
    for (const [connId, c] of conns) {
      const p = c.principal;
      if (p?.scope !== 'service') continue;
      if (reg.has(p.service, p.serviceKid)) continue;
      ctx.log('hosted.revoked', { connId, service: p.service, kid: p.serviceKid });
      ctx.close?.(connId, CLOSE_SERVICE, 'service-revoked');
    }
  }

  return {
    name: HOSTED_MODULE,
    types: ['hosted.'],
    tickMs,

    connect(ctx, connId, principal) {
      bind(ctx);
      conns.set(connId, { principal: { ...principal }, watching: false, sent: new Map() });
      if (isMember(principal)) {
        const id = principal.tenantId;
        members.set(id, (members.get(id) ?? 0) + 1);
        lingerUntil.delete(id);
        sync(ctx);
      }
    },

    disconnect(ctx, connId) {
      bind(ctx);
      const c = conns.get(connId);
      conns.delete(connId);
      if (c && isMember(c.principal)) {
        const id = c.principal.tenantId;
        const left = (members.get(id) ?? 1) - 1;
        if (left > 0) members.set(id, left);
        else {
          members.delete(id);
          lingerUntil.set(id, clock(ctx) + lingerMs);
        }
        sync(ctx);
      }
    },

    handle(ctx, connId, msg) {
      bind(ctx);
      const reqId = isReqId(msg.reqId) ? msg.reqId : undefined;
      const c = conns.get(connId);
      if (!c || !isControl(c.principal)) return reply(ctx, connId, { type: 'error', reason: 'forbidden', detail: '只有托管方服务的控制连接能用目录' }, reqId);
      if (msg.type === 'hosted.watch') return watch(ctx, connId, c, msg, reqId);
      if (msg.type === 'hosted.ticket') return ticket(ctx, connId, c, msg, reqId);
      return reply(ctx, connId, { type: 'error', reason: 'unsupported', detail: '目录模块不支持这种消息' }, reqId);
    },

    tick(ctx) {
      bind(ctx);
      revoke(ctx);
      sync(ctx);
    },

    describe() {
      return {
        watchers: [...conns.values()].filter((c) => c.watching).map((c) => ({ service: c.principal.service, kid: c.principal.serviceKid, projects: c.sent.size })),
        active: [...members.keys()].sort(),
      };
    },
  };
}

export default hostedModule;
