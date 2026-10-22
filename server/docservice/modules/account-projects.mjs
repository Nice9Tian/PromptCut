import https from 'node:https';
import { accountError, certificateFingerprint } from '../../account/client.mjs';
import { requireRequestId } from '../../account/protocol.mjs';
import { clientKeyOf, createGuestRateLimit } from '../../account/guest-rate.mjs';

const INTERNAL = '/internal/v2/';
const PUBLIC = '/hosted/shared/account';
/** 0.7.18 不再支持旧版本客户端(10-14 第 3.3 节);旧版点「搬到云端」时云端回的那一句 */
export const VERSION_EXPIRED_TEXT = '当前软件版本已过期，无法搬到云端';
/** 请求体里显式写着的客户端版本是不是 0.7.17 及更早(没写的不算:新客户端不带这一项) */
const isOldVersion = v => {
  const m = typeof v === 'string' ? /^(\d+)\.(\d+)\.(\d+)/.exec(v) : null;
  if (!m) return false;
  const [major, minor, patch] = m.slice(1).map(Number);
  return major === 0 && (minor < 7 || (minor === 7 && patch <= 17));
};
const bad = (status, code) => { throw accountError(status, code); };
const bearer = req => {
  if (req.headers.cookie) bad(400, 'bearer-required');
  const match = /^Bearer ([A-Za-z0-9_-]{1,256})$/.exec(req.headers.authorization ?? '');
  if (!match) bad(401, 'login-required');
  return { accessToken: match[1] };
};
async function readBody(req) {
  if (String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') bad(415, 'json-required');
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += b.length; if (size > 1024 * 1024) bad(413, 'body-too-large'); chunks.push(b);
  }
  try { const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!body || typeof body !== 'object' || Array.isArray(body)) bad(400, 'invalid-body'); return body; }
  catch (error) { if (error.status) throw error; bad(400, 'invalid-body'); }
}
const send = (res, status, value, cors = false, extra = {}) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    ...(cors ? { 'access-control-allow-origin': '*' } : {}), ...extra });
  res.end(JSON.stringify(value));
};

/** Handler seam only. Public bearer and private mTLS listeners must be mounted separately.
 * Caller certificate registration is immutable owner configuration, never body/loopback identity.
 * No cookies, legacy LAN tickets, runGrant body exemptions or automatic logout-complete ACKs.
 */
export function mountAccountProjects({ authority, services = [], issueSession, resolveAssetTicket, membersSnapshot,
  guestRateLimit = createGuestRateLimit() }) {
  const registry = new Map();
  for (const entry of services) {
    const fingerprint = certificateFingerprint(entry.fingerprint256);
    if (!['account', 'asset', 'agent', 'render'].includes(entry.serviceId) || !/^[a-f0-9]{64}$/.test(fingerprint) || registry.has(fingerprint)) bad(503, 'service-configuration');
    registry.set(fingerprint, entry.serviceId);
  }
  const serviceIdentity = req => {
    if (!req.socket.encrypted || req.socket.authorized !== true) bad(403, 'service-forbidden');
    const service = registry.get(certificateFingerprint(req.socket.getPeerCertificate()?.fingerprint256));
    if (!service) bad(403, 'service-forbidden'); return service;
  };
  const session = async (actor, body, readiness) => {
    if (typeof issueSession !== 'function') bad(503, 'session-unavailable');
    requireRequestId(body.requestId);
    if (typeof body.deviceId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(body.deviceId)) bad(400, 'invalid-device');
    const principal = await authority.authorizePrincipal(actor, { projectId: body.projectId });
    // 项目二级密码改过、这个成员还没输过新的:不发票据,页面请他输一次再走 `/join`;创建者另带当前的链接口令
    const entry = typeof authority.entryState === 'function' ? authority.entryState(principal) : {};
    const result = await issueSession({ principal, deviceId: body.deviceId, requestId: body.requestId,
      expectedAssetInstanceId: readiness?.instanceId });
    if (!result || typeof result.connectionTicket !== 'string' || !result.connectionTicket ||
      typeof result.assetTicket !== 'string' || !result.assetTicket || !Number.isSafeInteger(result.expiresAt)) bad(503, 'session-unavailable');
    return { ...result, ...entry };
  };
  async function dispatch(req, res, internal, context) {
    const url = new URL(req.url, 'http://route.invalid');
    if (internal ? !url.pathname.startsWith(INTERNAL) : !url.pathname.startsWith(PUBLIC)) return false;
    let cors = false;
    try {
      let result, status = 200;
      if (internal) {
        const service = serviceIdentity(req);
        if (url.pathname === '/internal/v2/projects' && req.method === 'GET' && service === 'account') {
          await authority.synchronize(); result = authority.listProjects(url.searchParams.get('accountId'));
        } else if (['asset', 'agent', 'render'].includes(service)) {
          if (url.pathname === '/internal/v2/access/check' && req.method === 'POST') {
            const body = await readBody(req);
            if (body.serviceId !== undefined || body.runGrantId !== undefined) bad(400, 'invalid-authority-claim');
            if (body.assetTicket !== undefined) {
              if (typeof resolveAssetTicket !== 'function') bad(503, 'asset-ticket-unavailable');
              if (typeof body.assetTicket !== 'string' || body.principal !== undefined) bad(400, 'invalid-authority-claim');
              const principal = await resolveAssetTicket(body.assetTicket);
              result = await authority.checkAccess({ principal, projectId: body.projectId === undefined ? principal.projectId : body.projectId,
                action: body.action, resource: body.resource });
            } else result = await authority.checkAccess(body);
          } else if (url.pathname === '/internal/v2/access/events' && req.method === 'GET') {
            await authority.synchronize(); const after = Number(url.searchParams.get('after') ?? '0'); result = authority.eventsSince(after);
          } else {
            const ack = /^\/internal\/v2\/access\/events\/([^/]+)\/ack$/.exec(url.pathname);
            if (!ack || req.method !== 'POST') bad(403, 'service-forbidden');
            const receipt = await readBody(req); if (receipt.serviceId !== undefined) bad(400, 'invalid-authority-claim');
            // The authoritative transaction validates the persisted doc closure;
            // a service certificate and a body complete flag are not that proof.
            if (service === 'agent' && !/^[a-f0-9]{64}$/.test(receipt?.agentReadClosureDigest ?? '')) bad(503, 'agent-read-closure-required');
            result = authority.ackAccessEvent(decodeURIComponent(ack[1]), service, receipt);
          }
        } else bad(403, 'service-forbidden');
      } else if (req.method === 'GET' && url.pathname === `${PUBLIC}/gone`) {
        // 旧办法建的云端项目没有账号成员可核：这一项不带登录也答，只答登记过墓碑的旧项目号（`authority.legacyGoneStatus`）。
        // 回的是签名过的证明，桌面版的页面跨源来问，所以连同错误一起放开只读的跨源读取（不带凭证）。
        cors = true;
        result = authority.legacyGoneStatus({ authorityId: url.searchParams.get('authorityId'), projectId: url.searchParams.get('projectId') });
      } else if (req.method === 'POST' && url.pathname === `${PUBLIC}/guest`) {
        // 领一张游客令牌（`docs/semantics/product/document-service.md`「游客」）。这一条**不要** Bearer：
        // 他还没有身份，要的就是这一张。带着旧令牌来就续期、编号不变；不带或者过期就随机一个新身份。
        // 编号只由服务端生成，请求体里写什么都不收（`authority.issueGuest`）。
        if (typeof authority.issueGuest !== 'function') bad(503, 'guest-unavailable');
        // 按来访 IP 限流（2026-10-23 用户定「先用 IP 拦」）：不要登录的路由，不拦的话谁都能反复领新身份。
        // 只挡得住随手刷的，换 IP 就绕过去了；真正挡得住的是验证码或账号，这一版不做（`guest-rate.mjs`）
        const verdict = guestRateLimit.take(clientKeyOf(req));
        if (!verdict.ok) throw Object.assign(accountError(429, 'guest-rate-limited'), { retryAfterSec: verdict.retryAfterSec });
        const body = await readBody(req);
        result = authority.issueGuest(typeof body.token === 'string' ? body.token : null);
      } else {
        const actor = bearer(req);
        if (req.method === 'POST') {
          const body = await readBody(req);
          // The public route cannot select a service/Agent role or supply an authoritative principal.
          if (['role', 'principal', 'loginId', 'credentialId', 'authorizationId', 'runGrantId', 'creator'].some(k => body[k] !== undefined) ||
            (body.accountId !== undefined && !url.pathname.endsWith('/admin'))) bad(400, 'invalid-authority-claim');
          if (url.pathname === `${PUBLIC}/create`) {
            // 显式写着 0.7.17 及更早版本号的新建请求按旧版本拒(真正的旧版本走的是 `/shared/*` 与整房导入口,那两处另有同一句)
            const ver = req.headers['x-promptcut-version'] ?? body.clientVersion;
            if (isOldVersion(ver)) bad(400, 'version-expired');
            result = await authority.createProject(actor, body); status = 201;
          }
          else if (url.pathname === `${PUBLIC}/join`) {
            // 申请加入(发申请、查自己那一条)也走这条路由,不另开:桌面外壳的账号桥只放行 create / join / session / admin / members
            // 五条(`desktop/src-tauri/src/account_vault.rs`),新路由要换外壳。带 `joinRequest` 的请求不进项目、不发票据
            if (body.joinRequest !== undefined) result = await authority.joinRequest(actor, body);
            else {
              if (typeof issueSession !== 'function') bad(503, 'session-unavailable');
              const membership = await authority.joinProject(actor, body); result = { membership, ...await session(actor, body, context?.readiness) };
            }
          }
          // 创建者「通过」「拒绝」申请也走 `/admin`(同上,不另开路由);只核点名的那一条申请,不核访问版本号(`authority.decideJoinRequest`)
          else if (url.pathname === `${PUBLIC}/admin`) result = ['approve-join', 'reject-join'].includes(body.op)
            ? await authority.decideJoinRequest(actor, body) : await authority.adminProject(actor, body);
          else if (url.pathname === `${PUBLIC}/members`) {
            if (typeof membersSnapshot !== 'function') bad(503, 'members-unavailable');
            result = await membersSnapshot(actor, body);
          }
          else if (url.pathname === `${PUBLIC}/session`) {
            result = await session(actor, body, context?.readiness);
          } else bad(404, 'no-route');
        } else if (req.method === 'GET' && url.pathname === `${PUBLIC}/status`) {
          // Authenticate first: an invalid login cannot obtain an authoritative gone result.
          await authority.synchronize();
          const identityProject = url.searchParams.get('projectId');
          try { await authority.authorizePrincipal(actor, { projectId: identityProject }); }
          catch (error) {
            // Deleted known projects are available only to their creator/member via statusForPrincipal.
            if (error.status !== 404) throw error;
            result = await authority.statusForPrincipal(actor, { authorityId: url.searchParams.get('authorityId'), projectId: identityProject });
          }
          result ??= authority.status({ authorityId: url.searchParams.get('authorityId'), projectId: identityProject });
        } else bad(405, 'method-not-allowed');
      }
      send(res, status, { ok: true, ...result }, cors);
    } catch (error) {
      const code = error.code ?? 'authority-unavailable';
      const message = code === 'version-expired' ? VERSION_EXPIRED_TEXT : code;
      // 限流回 429 时带上 Retry-After:让页面知道等多久,不要原地重试
      const extra = Number.isSafeInteger(error.retryAfterSec) ? { 'retry-after': String(error.retryAfterSec) } : {};
      send(res, error.status ?? (error.code?.startsWith('bad-') ? 400 : 503), { ok: false, error: code, code, message }, cors, extra);
    }
    return true;
  }
  return { authority, handlePublic: (req, res, context) => dispatch(req, res, false, context), handleInternal: (req, res) => dispatch(req, res, true) };
}

export function createAccountProjectsInternalServer({ tls, ...options }) {
  if (!tls?.key || !tls?.cert || !tls?.ca) bad(503, 'internal-configuration');
  const mounted = mountAccountProjects(options);
  return https.createServer({ key: tls.key, cert: tls.cert, ca: tls.ca, requestCert: true,
    rejectUnauthorized: true, minVersion: 'TLSv1.3' }, async (req, res) => {
    if (!await mounted.handleInternal(req, res)) send(res, 404, { ok: false, error: 'no-route' });
  });
}
