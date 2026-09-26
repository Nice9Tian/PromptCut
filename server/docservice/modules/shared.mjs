/**
 * 共享项目的成员与创建者操作模块（契约 `docs/plan/auth-contract.md` 第 7、8 节），类型前缀 `shared.`，外加 `auth.ticket`。
 *
 * | 消息 | 回包 | 说明 |
 * |---|---|---|
 * | `shared.members` | `shared.members.list { devices }` | 本空间在线的设备，按「用户名 + 设备」聚合成一行 |
 * | `shared.watch` | `shared.members.list` | 订阅本空间的成员变化；之后每次有连接进出、创建者操作都再收一条 |
 * | `shared.challenge` | `shared.challenge.ok { nonce, salt, kdf }` | 为一次创建者操作取挑战（绑定这条连接与项目） |
 * | `shared.admin` | `shared.admin.ok { op }` 或 `error` | `{ op, proof: { nonce, m }, … }`，op 见下 |
 * | `auth.ticket` | `auth.ticket.ok { ticket, exp }` | 签发素材票据或连接票据 |
 *
 * 创建者操作：`set-password`、`set-list`、`kick`、`unban`、`delete`。每次都要一份新的创建者证明
 * `m = HMAC-SHA256(K_创建者, "promptcut.admin.v1\n" + projectId + "\n" + 创建者用户名 + "\n" + op + "\n" + nonce)`，
 * `nonce` 须由同一连接刚取的 `shared.challenge` 给出。不带证明、证明不对一律回 `forbidden`；证明不对计入限速
 * （第 9 节），冷却期内回 `rate-limited`。除这五种操作外，创建者和普通成员的一切行为完全相同。
 *
 * 管理身份不在任何空间里（组装层的放行判断已挡住它发 `shared.*`）；`local` 身份没有项目，这里的请求一律 `forbidden`，
 * 只有 `shared.members` / `shared.watch` 照样回本空间（`local`）的连接。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  ROLES, adminPurpose, b64urlDecode, isUsername, isDeviceId, isRole, isConversation, normalizeOwner,
} from '../../auth/protocol.mjs';
import { signTicket, userGeneration } from '../../auth/tickets.mjs';
import { admissionOf, isLoopbackAddress } from '../../auth/handshake.mjs';
import { parseList, isCred } from '../../auth/http.mjs';

export const SHARED_MODULE = 'shared';
export const ADMIN_OPS = Object.freeze(['set-password', 'set-list', 'kick', 'unban', 'delete', 'set-creator-password', 'list-bans']);

/**
 * C6.5 补的两种创建者操作(`docs/plan/c65-design.md` 第 9 节裁定、2026-09-26 主会话裁定):
 * - `set-creator-password { creator: { salt, key } }`:改创建者自己的口令(特权第 1 项「改项目密码」的一部分)。
 *   用户名不变;改完旧口令不能再以创建者身份进入,新口令可以,之后的创建者操作按新口令算证明。
 *   **不加代数**、不作废已发的票据、在线连接不断(只有改项目口令或名单才加代数)。两种进入方式都能用。
 * - `list-bans`:回 `shared.admin.ok { op, bans: [{ username, deviceId }], list?: [用户名] }`,只读(限定进入另带名单里的
 *   用户名,不带盐与 K)。界面「已禁入的设备」「改名单」要它;每次创建者操作前的「验证创建者身份」也用它当一次无副作用的证明核对。
 * - `set-list` 的条目可以写成 `{ username, keep: true }`:沿用这个人现有的口令(创建者拿不到别人的 K,
 *   只增删、只改某几个人时其余的照旧)。名单里没有这个人时整批 bad-message。
 * 另外,`set-password` 成功后给本空间其余在线连接各发一条 `shared.notice { event: 'password-changed' }`,
 * 界面据此出「项目密码已被修改」的气泡(交互稿第 5 节);在线连接照旧不断。
 */

/** 关闭码（第 7 节） */
export const CLOSE_REMOVED = 4003;
export const CLOSE_DELETED = 4004;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isReqId = (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
const spaceOf = (p) => (p?.scope === 'admin' ? null : (typeof p?.tenantId === 'string' && p.tenantId !== '' ? p.tenantId : 'local'));

class Refused extends Error {
  constructor(reason, detail) {
    super(detail ?? reason);
    this.reason = reason;
  }
}

/**
 * @param {object} options
 * @param {() => object | null} options.store 取凭证存储（`../../auth/store.mjs`）
 * @param {ReturnType<import('../../auth/challenges.mjs').createChallenges>} options.challenges 创建者操作的挑战（和 HTTP 端点的进入挑战分开放）
 * @param {ReturnType<import('../../auth/rate-limit.mjs').createRateLimiter>} options.limiter
 * @param {(tenantId: string) => void} [options.dropSpace] 删项目时丢掉这个空间的全部数据
 * @param {(connId: string) => number} [options.claimsOf] 这条连接持有的认领数（「渲染中」标签）
 * @param {(remote: string | null) => boolean} [options.isLoopbackRemote] 回环来源不计限速
 * @param {() => number} [options.now]
 */
export function sharedModule({
  store,
  challenges,
  limiter,
  dropSpace = () => {},
  claimsOf = () => 0,
  isLoopbackRemote = isLoopbackAddress,
  now,
} = {}) {
  const storeOf = typeof store === 'function' ? store : () => store;
  /** connId → { principal, space, watching } */
  const conns = new Map();
  const clock = (ctx) => (typeof now === 'function' ? now() : ctx.now());

  function reply(ctx, connId, message, reqId) {
    if (reqId !== undefined) message.reqId = reqId;
    ctx.send(connId, message);
  }

  function connsIn(space) {
    return [...conns.entries()].filter(([, c]) => c.space === space);
  }

  /** 本空间的成员列表（第 7 节） */
  function devicesOf(space) {
    const rows = new Map();
    for (const [connId, c] of connsIn(space)) {
      const p = c.principal;
      const key = p.userId;
      let row = rows.get(key);
      if (!row) {
        row = {
          deviceId: p.deviceId ?? null,
          deviceName: p.deviceName ?? null,
          username: p.username ?? p.userId,
          displayName: p.username ?? p.userId,
          creator: p.creator === true,
          tags: { editing: false, rendering: false, agents: 0 },
          conns: [],
        };
        rows.set(key, row);
      }
      const role = p.role ?? 'page';
      const item = { role };
      if (p.conversation !== undefined && p.conversation !== null) item.conversation = p.conversation;
      if (p.owner !== undefined && p.owner !== null) item.owner = { ...p.owner };
      row.conns.push(item);
      if (role === 'page') row.tags.editing = true;
      if (role === 'agent') row.tags.agents += 1;
      if (role === 'render' && !row.tags.rendering) {
        let n = 0;
        try { n = Number(claimsOf(connId)) || 0; } catch { n = 0; }
        if (n > 0) row.tags.rendering = true;
      }
    }
    const list = [...rows.values()];
    // 同一用户名出现在不同设备上：这几台都显示为「用户名 (设备名)」
    for (const row of list) {
      const clash = list.some((o) => o !== row && o.username === row.username && o.deviceId !== row.deviceId);
      if (clash) row.displayName = `${row.username} (${row.deviceName ?? row.deviceId})`;
    }
    list.sort((a, b) => (a.username < b.username ? -1 : a.username > b.username ? 1 : String(a.deviceId) < String(b.deviceId) ? -1 : String(a.deviceId) > String(b.deviceId) ? 1 : 0));
    return list;
  }

  function notify(ctx, space) {
    if (space === null) return;
    let devices = null;
    for (const [connId, c] of connsIn(space)) {
      if (!c.watching) continue;
      devices ??= devicesOf(space);
      ctx.send(connId, { type: 'shared.members.list', devices: structuredClone(devices) });
    }
  }

  /** 这条连接是共享项目的成员（含本机声明），且项目还在 */
  function memberRecord(c) {
    if (!c || c.principal.scope !== 'member') throw new Refused('forbidden', '只有共享项目的成员能做这件事');
    const rec = storeOf()?.peek(c.space);
    if (!rec) throw new Refused('forbidden', '项目不存在');
    return rec;
  }

  function checkBlocked(ctx, connId) {
    const remote = ctx.remote?.(connId) ?? null;
    const loop = isLoopbackRemote(remote);
    if (!loop && limiter.blocked(remote)) throw new Refused('rate-limited', '口令错误太多，稍后再试');
    return { remote, loop };
  }

  // ---------- 消息 ----------

  function members(ctx, connId, msg, reqId) {
    const c = conns.get(connId);
    if (!c || c.space === null) throw new Refused('forbidden');
    reply(ctx, connId, { type: 'shared.members.list', devices: devicesOf(c.space) }, reqId);
  }

  function watch(ctx, connId, msg, reqId) {
    const c = conns.get(connId);
    if (!c || c.space === null) throw new Refused('forbidden');
    c.watching = true;
    reply(ctx, connId, { type: 'shared.members.list', devices: devicesOf(c.space) }, reqId);
  }

  function challenge(ctx, connId, msg, reqId) {
    const c = conns.get(connId);
    const rec = memberRecord(c);
    checkBlocked(ctx, connId);
    const nonce = challenges.issue(['admin', connId, c.space]);
    reply(ctx, connId, { type: 'shared.challenge.ok', nonce, salt: rec.creator.salt, kdf: { ...rec.kdf } }, reqId);
  }

  function ticket(ctx, connId, msg, reqId) {
    const c = conns.get(connId);
    const rec = memberRecord(c);
    const p = c.principal;
    if (admissionOf(rec, { username: p.username, deviceId: p.deviceId, creator: p.creator === true })) throw new Refused('forbidden');
    const fields = { u: p.userId, dn: p.deviceName, cr: p.creator === true };
    if (msg.kind === 'asset') {
      const access = msg.access ?? 'r';
      if (access !== 'r' && access !== 'rw') throw new Refused('bad-message', "access 只能是 'r' 或 'rw'");
      Object.assign(fields, { k: 'asset', r: access });
    } else if (msg.kind === 'conn') {
      if (!isRole(msg.role)) throw new Refused('bad-message', `role 只能是 ${ROLES.join(' / ')}`);
      fields.k = 'conn';
      fields.r = msg.role;
      if (msg.role === 'agent') {
        if (!isConversation(msg.conversation)) throw new Refused('bad-message', 'agent 连接要给对话号（正整数）');
        fields.c = msg.conversation;
      } else if (msg.conversation !== undefined && msg.conversation !== null) {
        throw new Refused('bad-message', '只有 agent 连接带对话号');
      }
      if (msg.owner !== undefined && msg.owner !== null) {
        const owner = msg.role === 'render' ? normalizeOwner(msg.owner) : null;
        if (!owner) throw new Refused('bad-message', "owner 只能给 render 连接，取 { kind: 'user' } 或 { kind: 'agent', c }");
        fields.o = owner;
      }
    } else {
      throw new Refused('bad-message', "kind 只能是 'asset' 或 'conn'");
    }
    const out = signTicket(rec, fields, clock(ctx));
    reply(ctx, connId, { type: 'auth.ticket.ok', ticket: out.ticket, exp: out.exp }, reqId);
  }

  /** 关掉本空间里满足条件的连接 */
  function closeWhere(ctx, space, predicate, code, reason) {
    for (const [connId, c] of connsIn(space)) {
      if (predicate(c.principal)) ctx.close?.(connId, code, reason);
    }
  }

  function admin(ctx, connId, msg, reqId) {
    const c = conns.get(connId);
    const rec = memberRecord(c);
    const { remote, loop } = checkBlocked(ctx, connId);
    const proof = msg.proof;
    if (!isObj(proof) || typeof proof.nonce !== 'string' || typeof proof.m !== 'string') throw new Refused('forbidden', '要创建者证明');
    const op = msg.op;
    if (!ADMIN_OPS.includes(op)) throw new Refused('bad-message', `op 只能是 ${ADMIN_OPS.join(' / ')}`);
    const nonceOk = challenges.consume(proof.nonce, ['admin', connId, c.space]);
    const given = b64urlDecode(proof.m);
    let ok = false;
    if (nonceOk && given && given.length === 32) {
      const expected = createHmac('sha256', Buffer.from(rec.creator.key, 'base64url'))
        .update(adminPurpose({ projectId: rec.projectId, username: rec.creator.username, op, nonce: proof.nonce }))
        .digest();
      ok = timingSafeEqual(expected, Buffer.from(given));
    }
    if (!ok) {
      if (!loop) limiter.fail(remote);
      ctx.log('shared.admin.reject', { connId, remote, op, reason: nonceOk ? 'bad-proof' : 'nonce' });
      throw new Refused('forbidden', '创建者证明不对');
    }
    const st = storeOf();
    const space = c.space;
    switch (op) {
      case 'set-password': {
        if (rec.mode !== 'free') throw new Refused('bad-message', '限定进入没有项目口令，改名单用 set-list');
        if (!isCred(msg.project)) throw new Refused('bad-message', 'project 要 { salt, key }');
        st.update(space, (d) => {
          d.project = { salt: msg.project.salt, key: msg.project.key };
          d.generation += 1;
        });
        for (const [other] of connsIn(space)) {
          if (other !== connId) ctx.send(other, { type: 'shared.notice', event: 'password-changed' });
        }
        break;
      }
      case 'set-creator-password': {
        if (!isCred(msg.creator)) throw new Refused('bad-message', 'creator 要 { salt, key }');
        st.update(space, (d) => {
          d.creator = { ...d.creator, salt: msg.creator.salt, key: msg.creator.key };
        });
        break;
      }
      case 'list-bans': {
        const bans = (rec.bans ?? []).map((b) => ({ username: b.username, deviceId: b.deviceId }));
        const out = { type: 'shared.admin.ok', op, bans };
        // 限定进入另带名单里的用户名(不带盐与 K):界面「改名单」要列出现有名单
        if (rec.mode === 'restricted') out.list = (rec.list ?? []).map((e) => e.username);
        ctx.log('shared.admin', { connId, projectId: space, op });
        reply(ctx, connId, out, reqId);
        return;
      }
      case 'set-list': {
        if (rec.mode !== 'restricted') throw new Refused('bad-message', '自由进入没有名单，改口令用 set-password');
        // `{ username, keep: true }`:沿用名单里这个人现有的口令(界面「改名单」只增删、只改某几个人的密码时用;
        // 创建者拿不到别人的 K,也不该拿到)。名单里没有这个人时整批 bad-message
        const current = new Map((rec.list ?? []).map((e) => [e.username, e]));
        const given = Array.isArray(msg.list)
          ? msg.list.map((e) => (isObj(e) && e.keep === true && typeof e.username === 'string' && current.has(e.username)
            ? { username: e.username, salt: current.get(e.username).salt, key: current.get(e.username).key }
            : e))
          : msg.list;
        const list = parseList(given, rec.creator.username);
        if (!list) throw new Refused('bad-message', 'list 要 [{ username, salt, key }]，用户名不重复、不含创建者');
        const keep = new Set(list.map((e) => e.username));
        st.update(space, (d) => {
          d.list = list;
          d.generation += 1;
        });
        closeWhere(ctx, space, (p) => p.creator !== true && p.username !== rec.creator.username && !keep.has(p.username), CLOSE_REMOVED, 'removed');
        break;
      }
      case 'kick': {
        const { username, deviceId } = msg;
        if (!isUsername(username) || !isDeviceId(deviceId)) throw new Refused('bad-message', '要 username 与 deviceId');
        const userId = `${username}@${deviceId}`;
        st.update(space, (d) => {
          d.userGenerations = { ...(d.userGenerations ?? {}), [userId]: userGeneration(d, userId) + 1 };
          d.bans = (d.bans ?? []).filter((b) => !(b.username === username && b.deviceId === deviceId));
          d.bans.push({ username, deviceId });
        });
        closeWhere(ctx, space, (p) => p.username === username && p.deviceId === deviceId, CLOSE_REMOVED, 'kicked');
        break;
      }
      case 'unban': {
        const { username, deviceId } = msg;
        if (!isUsername(username) || !isDeviceId(deviceId)) throw new Refused('bad-message', '要 username 与 deviceId');
        st.update(space, (d) => {
          d.bans = (d.bans ?? []).filter((b) => !(b.username === username && b.deviceId === deviceId));
        });
        break;
      }
      case 'delete': {
        reply(ctx, connId, { type: 'shared.admin.ok', op }, reqId);
        ctx.log('shared.delete', { projectId: space });
        st.remove(space);
        challenges.dropWhere((b) => b[2] === space);
        closeWhere(ctx, space, () => true, CLOSE_DELETED, 'deleted');
        try {
          dropSpace(space);
        } catch (err) {
          ctx.log('module.error', { module: SHARED_MODULE, hook: 'dropSpace', message: String(err?.message ?? err) });
        }
        return;
      }
      default:
        break;
    }
    ctx.log('shared.admin', { connId, projectId: space, op });
    reply(ctx, connId, { type: 'shared.admin.ok', op }, reqId);
    notify(ctx, space);
  }

  const HANDLERS = {
    'shared.members': members,
    'shared.watch': watch,
    'shared.challenge': challenge,
    'shared.admin': admin,
    'auth.ticket': ticket,
  };

  return {
    name: SHARED_MODULE,
    types: ['shared.', 'auth.ticket'],

    connect(ctx, connId, principal) {
      const space = spaceOf(principal);
      conns.set(connId, { principal: { ...principal }, space, watching: false });
      notify(ctx, space);
    },

    disconnect(ctx, connId) {
      const c = conns.get(connId);
      conns.delete(connId);
      challenges.dropWhere((b) => b[0] === 'admin' && b[1] === connId);
      if (c) notify(ctx, c.space);
    },

    handle(ctx, connId, msg) {
      const reqId = isReqId(msg.reqId) ? msg.reqId : undefined;
      const fn = HANDLERS[msg.type];
      if (!fn) return reply(ctx, connId, { type: 'error', reason: 'unsupported', detail: '共享项目模块不支持这种消息' }, reqId);
      try {
        fn(ctx, connId, msg, reqId);
      } catch (err) {
        if (!(err instanceof Refused)) throw err;
        reply(ctx, connId, { type: 'error', reason: err.reason, detail: err.message }, reqId);
      }
    },

    describe() {
      const spaces = {};
      for (const c of conns.values()) {
        if (c.space === null) continue;
        spaces[c.space] = (spaces[c.space] ?? 0) + 1;
      }
      return { spaces };
    },
  };
}

export default sharedModule;
