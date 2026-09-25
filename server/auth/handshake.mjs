/**
 * WebSocket 握手鉴权（契约 `docs/plan/auth-contract.md` 第 5、6、9、10 节）。
 *
 * 客户端在 `Sec-WebSocket-Protocol` 里给 `promptcut.v1`，再加下面至多一项（给了多项一律 401）：
 * - 证明 `promptcut.auth.<base64url(JSON)>` → 该项目的成员身份；
 * - 连接票据 `promptcut.ticket.<票据>` → 签发票据的那个身份，角色按票据；
 * - 本机声明 `promptcut.tenant.<projectId>`（可再加 `promptcut.role.<角色>`），只在回环来源上认 → 本机信任的该项目身份；
 * - 集群令牌 `promptcut.token.<令牌>` → 管理身份，只能用管理接口（只在调用方允许时认，挂载模式一律不认）。
 * 回环来源什么都不带 → 本机身份 `{ userId: 'local', tenantId: 'local', scope: 'local', role: 'page' }`。
 * 回环来源连 `promptcut.v1` 都不带的旧客户端，也按本机身份放行（M5 的行为）。
 *
 * 失败一律回 null（组装层回 401，响应体不说原因），日志记 `auth.reject { remote, reason }`，
 * `reason` ∈ `no-credential`、`bad-proof`、`nonce`、`banned`、`not-listed`、`no-project`、`rate-limited`、
 * `bad-format`、`multiple`。不记任何口令、`K`、证明、票据、令牌的原文。
 *
 * 本机声明的角色项可以写 `promptcut.role.agent.<对话号>`，把对话号一起带上（契约只写了 `promptcut.role.<角色>`，
 * 而 `agent` 连接必须有对话号，这是本实现的补充）。
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  PROTOCOL, AUTH_PREFIX, TICKET_PREFIX, TENANT_PREFIX, ROLE_PREFIX, TOKEN_PREFIX, MAX_PROTOCOL_JSON,
  b64urlDecode, utf8Text, authPurpose, isProjectId, isUsername, isDeviceId, isDeviceName, isRole, isConversation,
  normalizeOwner, splitUserId,
} from './protocol.mjs';
import { verifyTicket } from './tickets.mjs';

const TOKEN_RE = /^[A-Za-z0-9_-]{32,256}$/;

export const LOCAL_PRINCIPAL = Object.freeze({ userId: 'local', tenantId: 'local', scope: 'local', role: 'page' });
export const ADMIN_PRINCIPAL = Object.freeze({ userId: 'admin', tenantId: null, scope: 'admin' });

/** 集群令牌格式：base64url 字符，32～256 个 */
export const checkTokenFormat = (token) => typeof token === 'string' && TOKEN_RE.test(token);

/** 握手请求里客户端给的子协议列表（多个头、逗号分隔都拆开） */
export function offeredProtocols(req) {
  const raw = req?.headers?.['sec-websocket-protocol'];
  if (raw === undefined) return [];
  const text = Array.isArray(raw) ? raw.join(',') : String(raw);
  return text.split(',').map((s) => s.trim()).filter((s) => s !== '');
}

/** 回环地址（含 IPv4 映射的 IPv6） */
export function isLoopbackAddress(address) {
  const a = String(address ?? '').toLowerCase();
  return a === '::1' || /^127\./.test(a) || /^::ffff:127\./.test(a);
}

const digest = (text) => createHash('sha256').update(text, 'utf8').digest();
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 一个成员（或创建者）身份的 principal */
function memberPrincipal({ projectId, username, deviceId, deviceName, creator, role, conversation, owner }) {
  return {
    userId: `${username}@${deviceId}`,
    tenantId: projectId,
    scope: 'member',
    username,
    deviceId,
    deviceName,
    creator: creator === true,
    role,
    conversation: conversation ?? null,
    owner: owner ?? null,
  };
}

/**
 * 按模式与用户名找这次进入该对的 `K`（base64url）；找不到回 null（名单外、不是创建者）。
 * 限定进入下创建者自动算名单的一员：`as: 'member'` 而用户名是创建者的，用创建者的 `K`。
 */
export function credentialFor(rec, username, as) {
  if (as === 'creator') return rec.creator.username === username ? rec.creator : null;
  if (rec.mode === 'free') return rec.project ?? null;
  if (rec.creator.username === username) return rec.creator;
  return (rec.list ?? []).find((e) => e.username === username) ?? null;
}

/** 这个身份现在还能不能在这个项目里（禁入表、限定进入的名单）；能回 null，不能回原因 */
export function admissionOf(rec, { username, deviceId, creator }) {
  if ((rec.bans ?? []).some((b) => b.username === username && b.deviceId === deviceId)) return 'banned';
  if (rec.mode === 'restricted' && !creator && rec.creator.username !== username && !(rec.list ?? []).some((e) => e.username === username)) {
    return 'not-listed';
  }
  return null;
}

/**
 * @param {object} options
 * @param {() => object | null} options.store 取凭证存储（可以是 null：存储没加载时只认本机身份与令牌）
 * @param {ReturnType<import('./challenges.mjs').createChallenges>} options.challenges
 * @param {ReturnType<import('./rate-limit.mjs').createRateLimiter>} options.limiter
 * @param {string} [options.clusterToken] 集群令牌；不给或 `acceptToken` 为 false 时令牌项一律 401
 * @param {boolean} [options.acceptToken] 认不认集群令牌（挂载模式 false）
 * @param {(req) => boolean} options.isLoopback 这条请求是不是本机回环来的
 * @param {(req) => string | null} [options.remoteOf] 日志与限速用的来源地址
 * @param {{ deviceId: string, deviceName: string }} [options.localDevice] 本机声明用的本机设备信息
 * @param {() => number} [options.now]
 * @param {(event: string, fields: object) => void} [options.log]
 */
export function createHandshakeAuth({
  store,
  challenges,
  limiter,
  clusterToken,
  acceptToken = true,
  isLoopback,
  remoteOf = (req) => req?.socket?.remoteAddress ?? null,
  localDevice,
  now = Date.now,
  log = () => {},
}) {
  if (clusterToken !== undefined && clusterToken !== null && !checkTokenFormat(clusterToken)) {
    throw new TypeError('createHandshakeAuth: 集群令牌格式不对（要 32～256 个 base64url 字符）');
  }
  const tokenDigest = acceptToken && clusterToken ? digest(clusterToken) : null;
  const storeOf = typeof store === 'function' ? store : () => store;

  function authenticate(req) {
    const remote = remoteOf(req);
    const reject = (reason) => {
      log('auth.reject', { remote, reason });
      return null;
    };
    let loopback = false;
    try {
      loopback = !!isLoopback(req);
    } catch {
      loopback = false;
    }
    const offered = offeredProtocols(req);
    const items = offered.filter((p) => p !== PROTOCOL);
    const kinds = items.filter((p) => p.startsWith(AUTH_PREFIX) || p.startsWith(TICKET_PREFIX) || p.startsWith(TENANT_PREFIX) || p.startsWith(TOKEN_PREFIX));
    const roleItems = items.filter((p) => p.startsWith(ROLE_PREFIX));

    if (kinds.length > 1) return reject('multiple');
    if (kinds.length === 0) {
      if (roleItems.length > 0) return reject('bad-format');
      return loopback ? { ...LOCAL_PRINCIPAL } : reject('no-credential');
    }
    if (!offered.includes(PROTOCOL)) return reject('bad-format');
    const item = kinds[0];

    // ---------- 集群令牌 ----------
    if (item.startsWith(TOKEN_PREFIX)) {
      if (roleItems.length > 0) return reject('bad-format');
      if (!tokenDigest) return reject('no-credential');
      const ok = timingSafeEqual(digest(item.slice(TOKEN_PREFIX.length)), tokenDigest);
      return ok ? { ...ADMIN_PRINCIPAL } : reject('bad-proof');
    }

    // ---------- 本机声明 ----------
    if (item.startsWith(TENANT_PREFIX)) {
      if (!loopback) return reject('no-credential');
      if (roleItems.length > 1) return reject('multiple');
      const projectId = item.slice(TENANT_PREFIX.length);
      let role = 'page';
      let conversation = null;
      if (roleItems.length === 1) {
        const m = /^(page|agent|render)(?:\.([1-9][0-9]{0,14}))?$/.exec(roleItems[0].slice(ROLE_PREFIX.length));
        if (!m) return reject('bad-format');
        role = m[1];
        if (m[2] !== undefined) {
          if (role !== 'agent') return reject('bad-format');
          conversation = Number(m[2]);
        }
      }
      if (role === 'agent' && conversation === null) return reject('bad-format');
      if (!isProjectId(projectId)) return reject('bad-format');
      const rec = storeOf()?.peek(projectId);
      if (!rec) return reject('no-project');
      if (!localDevice || !isDeviceId(localDevice.deviceId)) return reject('no-credential');
      return memberPrincipal({
        projectId, username: 'local', deviceId: localDevice.deviceId, deviceName: localDevice.deviceName,
        creator: true, role, conversation,
      });
    }

    if (roleItems.length > 0) return reject('bad-format');
    // 冷却期内：非回环来源凭证明、票据一律拒（口令对也拒）
    if (!loopback && limiter.blocked(remote)) return reject('rate-limited');

    // ---------- 连接票据 ----------
    if (item.startsWith(TICKET_PREFIX)) {
      const st = storeOf();
      if (!st) return reject('no-project');
      const v = verifyTicket(item.slice(TICKET_PREFIX.length), { lookup: (id) => st.peek(id), now: now(), kind: 'conn' });
      if (!v.ok) return reject(v.reason === 'no-project' ? 'no-project' : 'bad-proof');
      const p = v.payload;
      const who = splitUserId(p.u);
      const creator = p.cr === true;
      const denied = admissionOf(v.record, { username: who.username, deviceId: who.deviceId, creator });
      if (denied) return reject(denied);
      return memberPrincipal({
        projectId: p.p, username: who.username, deviceId: who.deviceId, deviceName: p.dn ?? who.deviceId,
        creator, role: p.r, conversation: p.c, owner: p.o,
      });
    }

    // ---------- 证明 ----------
    const fail = (reason) => {
      if (!loopback) limiter.fail(remote);
      return reject(reason);
    };
    const raw = b64urlDecode(item.slice(AUTH_PREFIX.length));
    if (!raw || raw.length > MAX_PROTOCOL_JSON) return reject('bad-format');
    const text = utf8Text(raw);
    let j;
    try {
      j = text === null ? null : JSON.parse(text);
    } catch {
      j = null;
    }
    if (!isObj(j) || j.v !== 1) return reject('bad-format');
    const { p: projectId, u: username, d: deviceId, dn: deviceName, as, nonce, m, r: role, c, o } = j;
    if (!isProjectId(projectId) || !isUsername(username) || !isDeviceId(deviceId) || !isDeviceName(deviceName)) return reject('bad-format');
    if ((as !== 'member' && as !== 'creator') || typeof nonce !== 'string' || typeof m !== 'string') return reject('bad-format');
    // nonce 先核对：不论后面成败都已作废
    if (!challenges.consume(nonce, ['join', projectId, username, deviceId, as])) return fail('nonce');
    if (!isRole(role)) return reject('bad-format');
    if (role === 'agent' ? !isConversation(c) : (c !== undefined && c !== null)) return reject('bad-format');
    let owner = null;
    if (o !== undefined && o !== null) {
      if (role !== 'render') return reject('bad-format');
      owner = normalizeOwner(o);
      if (!owner) return reject('bad-format');
    }
    const st = storeOf();
    const rec = st?.peek(projectId);
    if (!rec) return reject('no-project');
    const cred = credentialFor(rec, username, as);
    if (!cred) return fail('not-listed');
    const given = b64urlDecode(m);
    if (!given || given.length !== 32) return fail('bad-proof');
    const expected = createHmac('sha256', Buffer.from(cred.key, 'base64url'))
      .update(authPurpose({ projectId, username, deviceId, as, nonce }))
      .digest();
    if (!timingSafeEqual(expected, Buffer.from(given))) return fail('bad-proof');
    const creator = as === 'creator' || (rec.mode === 'restricted' && cred === rec.creator);
    const denied = admissionOf(rec, { username, deviceId, creator });
    if (denied) return reject(denied);
    return memberPrincipal({ projectId, username, deviceId, deviceName, creator, role, conversation: role === 'agent' ? c : null, owner });
  }

  return {
    authenticate,
    /** 握手成功时要回显的子协议：只回 `promptcut.v1` */
    protocolFor(req) {
      return offeredProtocols(req).includes(PROTOCOL) ? PROTOCOL : null;
    },
  };
}
