/**
 * 共享项目的 HTTP 端点（契约 `docs/plan/auth-contract.md` 第 4 节）。
 *
 * | 端点 | 说明 |
 * |---|---|
 * | `POST shared/create` | 建项目，客户端交派生好的 `K`；201 / 400 / 403 / 409 / 429 |
 * | `GET shared/lookup?name=` | 按名字查项目 id；200 / 404 |
 * | `POST shared/challenge` | 取进入挑战；200 / 400 / 404 / 429 |
 * | `POST shared/invite/resolve` | 凭邀请码查项目（C10a）：200 / 404 `invite-invalid` / 429 |
 * | `POST shared/invite/redeem` | 凭邀请码兑换（C10a）：200 / 400 / 401 `banned` / 404 `invite-invalid` / 429 |
 *
 * 独立模式挂在文档服务自己的 http 服务器上（路径 `/shared/…`），挂载模式挂在 `<WS 路径>/shared/…`
 * （vite 里是 `/docservice/shared/…`）。本模块只认调用方给的前缀，其余路径一概不碰。
 *
 * 全部回 JSON、`Cache-Control: no-store`、`Access-Control-Allow-Origin: *`（不带凭证），答 `OPTIONS` 预检。
 * 请求体上限 64 KiB，超出回 413。错误统一为 `{ ok: false, error: '<原因>' }`。
 *
 * 谁能建〔裁〕：
 * - 托管端（`mode: 'hosted'`，独立模式）：任何来源都能建；同一来源每小时最多 10 个，整台服务最多 1000 个，超出 429；
 * - 局域网主机（`mode: 'lan'`，挂载模式）：只有本机回环来源能建，别的 403。
 *
 * 回环来源（`isLoopback`）：局域网主机只让回环建项目；回环的挑战、邀请码失败不计入限速。本机信任关掉时
 * （`PROMPTCUT_TRUST_LOOPBACK=0`，托管端在反向代理之后，`docs/plan/http-transport-contract.md` 第 10 节），
 * 组装方（`createSharedDocService`）传进来的 `isLoopback` 一律回 false，回环与别的来源一样受限。
 *
 * 名单外的用户名（以及 `as: 'creator'` 而不是创建者）回伪盐：`HMAC-SHA256(serverSecret, projectId + '\n' + username)`
 * 的前 16 字节，同一用户名每次都一样，形状与真盐相同。
 */
import { createHmac } from 'node:crypto';
import {
  KEY_BYTES, SALT_BYTES, isProjectId, isProjectName, isUsername, isDeviceId, isB64Bytes, isKdf,
} from './protocol.mjs';
import { credentialFor } from './handshake.mjs';
import { isInviteCode, inviteDigest, inviteActive, redeemOn } from './invite.mjs';

export const SHARED_HTTP_DEFAULTS = Object.freeze({
  MAX_BODY: 64 * 1024,
  CREATE_PER_HOUR: 10,
  MAX_PROJECTS: 1000,
  HOUR_MS: 3_600_000,
});

const ALLOW_HEADERS = 'Content-Type';
const ALLOW_METHODS = 'GET, POST, OPTIONS';

function send(res, status, body) {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(JSON.stringify(body));
}

const fail = (res, status, error) => send(res, status, { ok: false, error });

class TooLarge extends Error {}

/** 读请求体（上限 maxBody）；超出抛 TooLarge */
function readBody(req, maxBody) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBody) {
      reject(new TooLarge());
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > maxBody) {
        done = true;
        reject(new TooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isCred = (v) => isObj(v) && isB64Bytes(v.salt, SALT_BYTES) && isB64Bytes(v.key, KEY_BYTES);

/** 校验 `shared/create` 的请求体；合格回规整后的对象，否则 null */
export function parseCreate(body) {
  if (!isObj(body)) return null;
  const { name, mode, kdf, creator, project, list } = body;
  if (!isProjectName(name) || (mode !== 'free' && mode !== 'restricted') || !isKdf(kdf)) return null;
  if (!isCred(creator) || !isUsername(creator.username)) return null;
  const out = { name, mode, kdf: { alg: kdf.alg, iter: kdf.iter }, creator: { username: creator.username, salt: creator.salt, key: creator.key } };
  if (mode === 'free') {
    if (!isCred(project) || list !== undefined) return null;
    out.project = { salt: project.salt, key: project.key };
  } else {
    if (project !== undefined) return null;
    const entries = list ?? [];
    if (!Array.isArray(entries) || entries.length > 1000) return null;
    const seen = new Set([creator.username]);
    out.list = [];
    for (const e of entries) {
      if (!isCred(e) || !isUsername(e.username) || seen.has(e.username)) return null;
      seen.add(e.username);
      out.list.push({ username: e.username, salt: e.salt, key: e.key });
    }
  }
  return out;
}

/** 校验名单（`set-list` 也用）：`[{ username, salt, key }]`，不重名、不含创建者 */
export function parseList(list, creatorName) {
  if (!Array.isArray(list) || list.length > 1000) return null;
  const seen = new Set([creatorName]);
  const out = [];
  for (const e of list) {
    if (!isCred(e) || !isUsername(e.username) || seen.has(e.username)) return null;
    seen.add(e.username);
    out.push({ username: e.username, salt: e.salt, key: e.key });
  }
  return out;
}

export { isCred };

/** 伪盐：`HMAC-SHA256(serverSecret, projectId + '\n' + username)` 的前 16 字节 */
export function fakeSalt(serverSecret, projectId, username) {
  return createHmac('sha256', serverSecret).update(`${projectId}\n${username}`, 'utf8').digest().subarray(0, SALT_BYTES).toString('base64url');
}

/**
 * @param {object} options
 * @param {() => object | null} options.store 取凭证存储；取不到时全部端点回 503 `auth-store`
 * @param {ReturnType<import('./challenges.mjs').createChallenges>} options.challenges
 * @param {ReturnType<import('./rate-limit.mjs').createRateLimiter>} options.limiter
 * @param {'hosted' | 'lan'} options.mode
 * @param {(req) => boolean} options.isLoopback
 * @param {(req) => string | null} [options.remoteOf]
 * @param {() => number} [options.now]
 * @param {(event: string, fields: object) => void} [options.log]
 * @param {number} [options.createPerHour]
 * @param {number} [options.maxProjects]
 * @param {number} [options.maxBody]
 * @param {(projectId: string) => void} [options.onCreate]
 */
export function createSharedHttp({
  store,
  challenges,
  limiter,
  mode,
  isLoopback,
  remoteOf = (req) => req?.socket?.remoteAddress ?? null,
  now = Date.now,
  log = () => {},
  createPerHour = SHARED_HTTP_DEFAULTS.CREATE_PER_HOUR,
  maxProjects = SHARED_HTTP_DEFAULTS.MAX_PROJECTS,
  maxBody = SHARED_HTTP_DEFAULTS.MAX_BODY,
  onCreate = () => {},
}) {
  if (mode !== 'hosted' && mode !== 'lan') throw new TypeError("createSharedHttp: mode 只能是 'hosted' 或 'lan'");
  const storeOf = typeof store === 'function' ? store : () => store;
  /** 来源 → 最近一小时建项目的时刻 */
  const creates = new Map();

  const loopbackOf = (req) => {
    try {
      return !!isLoopback(req);
    } catch {
      return false;
    }
  };

  async function jsonBody(req, res) {
    let text;
    try {
      text = await readBody(req, maxBody);
    } catch (err) {
      if (err instanceof TooLarge) {
        res.setHeader('Connection', 'close');
        fail(res, 413, 'too-large');
        req.resume();
        return undefined;
      }
      fail(res, 400, 'bad-request');
      return undefined;
    }
    try {
      return JSON.parse(text);
    } catch {
      fail(res, 400, 'bad-request');
      return undefined;
    }
  }

  async function create(req, res, st) {
    const remote = remoteOf(req);
    const loopback = loopbackOf(req);
    if (mode === 'lan' && !loopback) {
      req.resume();
      return fail(res, 403, 'forbidden');
    }
    const body = await jsonBody(req, res);
    if (body === undefined) return;
    const parsed = parseCreate(body);
    if (!parsed) return fail(res, 400, 'bad-request');
    if (mode === 'hosted') {
      const at = now();
      const recent = (creates.get(remote) ?? []).filter((t) => t > at - SHARED_HTTP_DEFAULTS.HOUR_MS);
      if (recent.length >= createPerHour || st.count() >= maxProjects) {
        creates.set(remote, recent);
        return fail(res, 429, 'rate-limited');
      }
      if (st.nameTaken(parsed.name)) return fail(res, 409, 'name-taken');
      recent.push(at);
      creates.set(remote, recent);
    } else if (st.nameTaken(parsed.name)) {
      return fail(res, 409, 'name-taken');
    }
    let rec;
    try {
      rec = st.create(parsed);
    } catch (err) {
      if (err?.code === 'name-taken') return fail(res, 409, 'name-taken');
      throw err;
    }
    log('shared.create', { remote, projectId: rec.projectId, mode: rec.mode });
    try { onCreate(rec.projectId); } catch { /* 通知失败不影响建项目 */ }
    send(res, 201, { ok: true, projectId: rec.projectId, name: rec.name, mode: rec.mode });
  }

  function lookup(req, res, st, url) {
    const name = url.searchParams.get('name');
    const rec = typeof name === 'string' && name !== '' ? st.byName(name) : null;
    if (!rec) return fail(res, 404, 'no-project');
    send(res, 200, { ok: true, projectId: rec.projectId, name: rec.name, mode: rec.mode });
  }

  async function challenge(req, res, st) {
    const remote = remoteOf(req);
    const loopback = loopbackOf(req);
    if (!loopback && limiter.blocked(remote)) {
      req.resume();
      return tooMany(res, remote);
    }
    const body = await jsonBody(req, res);
    if (body === undefined) return;
    if (!isObj(body)) return fail(res, 400, 'bad-request');
    const { projectId, username, deviceId, as } = body;
    if (!isProjectId(projectId) || !isUsername(username) || !isDeviceId(deviceId) || (as !== 'member' && as !== 'creator')) {
      return fail(res, 400, 'bad-request');
    }
    const rec = st.peek(projectId);
    if (!rec) return fail(res, 404, 'no-project');
    const cred = credentialFor(rec, username, as);
    const salt = cred ? cred.salt : fakeSalt(st.serverSecret, projectId, username);
    const nonce = challenges.issue(['join', projectId, username, deviceId, as]);
    send(res, 200, { ok: true, nonce, salt, kdf: { ...rec.kdf }, mode: rec.mode });
  }

  /**
   * 429 `rate-limited` 带 `Retry-After` 头（冷却还剩的秒数，并在 CORS 里放出这个头）；`withBody` 时回包另带 `retryAfter`。
   * C10a 主会话裁定（2026-09-27）：HTTP 端点被限速回 429 时带这两样，界面照契约第 14 节表 A 写「请 {秒数} 秒后再试」。
   * 邀请码两个端点两样都带；`shared/challenge` 只带头、回包体照 auth 契约原样（AU8 契约测试逐字比对它，改动留给契约修订后再做）。
   */
  function tooMany(res, remote, { withBody = false } = {}) {
    const sec = Math.max(1, Math.ceil(limiter.retryAfterMs?.(remote) / 1000 || 0));
    if (!res.headersSent) {
      res.setHeader('Retry-After', String(sec));
      res.setHeader('Access-Control-Expose-Headers', 'Retry-After');
    }
    if (withBody) return send(res, 429, { ok: false, error: 'rate-limited', retryAfter: sec });
    return fail(res, 429, 'rate-limited');
  }

  /**
   * 邀请码的两个端点（C10a 契约第 5 节）：`POST shared/invite/resolve { code }`、`POST shared/invite/redeem { code, username, deviceId }`。
   *
   * - 未知、已作废、已过期、次数用完一律 404 `invite-invalid`（一个口径，不让人试探邀请码处在什么状态）；
   * - 兑换时 `(username, deviceId)` 在禁入表里回 401 `banned`；
   * - 两种失败都计入第 9 节的口令错误限速（回环来源不计，与挑战一致）；冷却期内回 429（`Retry-After` 头与回包 `retryAfter`）；
   * - 形状不对的邀请码（不是 43 个 base64url 字符）同样回 404 `invite-invalid`、同样计数；
   * - 限定进入：用户名在名单里（或是创建者）才扣次数，不在名单的回包相同、不扣（主会话裁定）；
   * - `resolve` 不扣次数；`redeem` 先核对再扣一次，同一 `userId` 再兑换不重复扣（`invite.mjs` 的 `redeemOn`）；
   * - 自由进入的兑换回项目口令的 `K`（`kdf` 与 `project: { salt, key }`），客户端据此照常握手；限定进入不回 `K`；
   * - 不记录请求体：日志里只有来源、项目号与结果，没有邀请码、用户名。
   */
  async function invite(req, res, st, which) {
    const remote = remoteOf(req);
    const loopback = loopbackOf(req);
    if (!loopback && limiter.blocked(remote)) {
      req.resume();
      return tooMany(res, remote, { withBody: true });
    }
    const body = await jsonBody(req, res);
    if (body === undefined) return;
    if (!isObj(body)) return fail(res, 400, 'bad-request');
    if (which === 'redeem' && (!isUsername(body.username) || !isDeviceId(body.deviceId))) return fail(res, 400, 'bad-request');
    const at = now();
    const invalid = () => {
      if (!loopback) limiter.fail(remote);
      log('shared.invite.reject', { remote, route: which, reason: 'invite-invalid' });
      return fail(res, 404, 'invite-invalid');
    };
    // 形状不对的邀请码也按「无效」回，同样计数：猜码的人从回包里分不出是格式错还是没有这个码
    if (!isInviteCode(body.code)) return invalid();
    const rec = st.peekByInviteDigest(inviteDigest(st.serverSecret, body.code));
    if (!rec || !rec.invite) return invalid();
    const base = { ok: true, projectId: rec.projectId, name: rec.name, mode: rec.mode };
    if (which === 'resolve') {
      if (!inviteActive(rec.invite, at)) return invalid();
      return send(res, 200, base);
    }
    const { username, deviceId } = body;
    const userId = `${username}@${deviceId}`;
    // 先在副本上试一次：无效就不写盘；同一 userId 兑换过（again）也不写
    const trial = redeemOn(structuredClone(rec.invite), userId, at);
    if (trial === 'invalid') return invalid();
    if ((rec.bans ?? []).some((b) => b.username === username && b.deviceId === deviceId)) {
      if (!loopback) limiter.fail(remote);
      log('shared.invite.reject', { remote, route: which, projectId: rec.projectId, reason: 'banned' });
      return fail(res, 401, 'banned');
    }
    // 限定进入：用户名在名单里（或是创建者）才扣次数；不在名单的回包一模一样、不扣（主会话裁定 2026-09-27：
    // 兑换时不核对口令，否则拿到链接的人换个设备名就能耗光次数；回包相同，不泄露名单）
    const listed = rec.mode !== 'restricted' || rec.creator.username === username || (rec.list ?? []).some((e) => e.username === username);
    const counted = trial === 'ok' && listed;
    if (counted) st.update(rec.projectId, (d) => { redeemOn(d.invite, userId, at); });
    log('shared.invite.redeem', { remote, projectId: rec.projectId, counted });
    if (rec.mode === 'free' && rec.project) {
      return send(res, 200, { ...base, kdf: { ...rec.kdf }, project: { salt: rec.project.salt, key: rec.project.key } });
    }
    return send(res, 200, base);
  }

  /**
   * 处理一个请求。`prefix` 是共享端点所在的前缀（独立模式 `''`，挂载模式 `/docservice`）。
   * 路径不是 `<prefix>/shared/…` 的回 false、什么都不动；是的回 true（已经或将要回包）。
   */
  function handle(req, res, prefix = '') {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      return false;
    }
    const base = `${prefix}/shared/`;
    if (!url.pathname.startsWith(base)) return false;
    const route = url.pathname.slice(base.length);
    const method = String(req.method || 'GET').toUpperCase();
    if (method === 'OPTIONS') {
      res.statusCode = 204;
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', ALLOW_METHODS);
      res.setHeader('Access-Control-Allow-Headers', ALLOW_HEADERS);
      res.setHeader('Access-Control-Max-Age', '600');
      res.setHeader('Cache-Control', 'no-store');
      res.end();
      return true;
    }
    const st = storeOf();
    const run = async () => {
      if (!st) {
        req.resume();
        return fail(res, 503, 'auth-store');
      }
      if (route === 'create') {
        if (method !== 'POST') return fail(res, 405, 'method');
        return create(req, res, st);
      }
      if (route === 'lookup') {
        if (method !== 'GET') return fail(res, 405, 'method');
        return lookup(req, res, st, url);
      }
      if (route === 'challenge') {
        if (method !== 'POST') return fail(res, 405, 'method');
        return challenge(req, res, st);
      }
      if (route === 'invite/resolve' || route === 'invite/redeem') {
        if (method !== 'POST') return fail(res, 405, 'method');
        return invite(req, res, st, route.slice('invite/'.length));
      }
      req.resume();
      return fail(res, 404, 'not-found');
    };
    run().catch((err) => {
      log('shared.http-error', { route, message: String(err?.message ?? err) });
      fail(res, 500, 'internal');
    });
    return true;
  }

  return { handle };
}
