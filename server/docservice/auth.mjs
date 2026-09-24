/**
 * 集群令牌鉴权：建连时按 `Sec-WebSocket-Protocol` 里带的令牌定 principal。
 *
 * 契约见 `docs/plan/render-queue-contract.md` G.5。客户端在子协议里给两项：`promptcut.v1` 与
 * `promptcut.token.<令牌>`（浏览器的 WebSocket 设不了自定义请求头，所以不走 Authorization；也不放 URL 查询串，
 * 免得进访问日志）。服务端握手成功时只回显 `promptcut.v1`，从不回显令牌那一项。
 *
 * 集群令牌只证明「是集群成员」，分不出用户和租户：通过的连接一律是 `{ userId: 'cluster', tenantId: 'cluster' }`。
 * 细粒度的用户、租户凭证在后续阶段（计划第 3 节 S3）。
 *
 * 令牌原文不进任何日志、错误信息、诊断输出：比对前两边各取 sha256，再定长比较。
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export const PROTOCOL = 'promptcut.v1';
const TOKEN_PREFIX = 'promptcut.token.';
const TOKEN_RE = /^[A-Za-z0-9_-]{32,256}$/;

const CLUSTER = Object.freeze({ userId: 'cluster', tenantId: 'cluster' });
const ANONYMOUS = Object.freeze({ userId: 'anonymous', tenantId: null });

/** 回环地址：只绑这些地址时允许匿名 */
export function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

/** 令牌格式：base64url 字符，32～256 个 */
export function checkTokenFormat(token) {
  return typeof token === 'string' && TOKEN_RE.test(token);
}

/** 握手请求里客户端给的子协议列表（多个头、逗号分隔都拆开） */
export function offeredProtocols(req) {
  const raw = req?.headers?.['sec-websocket-protocol'];
  if (raw === undefined) return [];
  const text = Array.isArray(raw) ? raw.join(',') : String(raw);
  return text.split(',').map((s) => s.trim()).filter((s) => s !== '');
}

const digest = (text) => createHash('sha256').update(text, 'utf8').digest();

/**
 * @param {object} options
 * @param {string} [options.token] 集群令牌；设了就是令牌模式
 * @param {boolean} [options.allowAnonymous] 没设令牌时是否放行匿名连接；不放行就全部拒绝
 * @param {(event: string, fields: object) => void} [options.log] 握手被拒时记 `auth.reject { remote, reason }`
 */
export function createClusterAuth({ token, allowAnonymous = false, log = () => {} } = {}) {
  const tokenMode = token !== undefined && token !== null;
  if (tokenMode && !checkTokenFormat(token)) throw new TypeError('createClusterAuth: 集群令牌格式不对（要 32～256 个 base64url 字符）');
  const expected = tokenMode ? digest(token) : null;

  function reject(req, reason) {
    log('auth.reject', { remote: req?.socket?.remoteAddress ?? null, reason });
    return null;
  }

  return {
    /** 返回 principal；null 表示拒绝（握手回 401） */
    authenticate(req) {
      if (!tokenMode) return allowAnonymous ? { ...ANONYMOUS } : reject(req, 'no-token');
      const offered = offeredProtocols(req);
      if (!offered.includes(PROTOCOL)) return reject(req, 'no-protocol');
      const given = offered.filter((p) => p.startsWith(TOKEN_PREFIX));
      if (given.length === 0) return reject(req, 'no-token');
      // 给了多个令牌项不猜哪个是真的，一律按不符处理
      if (given.length !== 1) return reject(req, 'bad-token');
      const ok = timingSafeEqual(digest(given[0].slice(TOKEN_PREFIX.length)), expected);
      return ok ? { ...CLUSTER } : reject(req, 'bad-token');
    },

    /** 握手成功时要回显的子协议；客户端没给 `promptcut.v1` 就不回 */
    protocolFor(req) {
      return offeredProtocols(req).includes(PROTOCOL) ? PROTOCOL : null;
    },
  };
}
