import https from 'node:https';
import { accountError, certificateFingerprint } from '../../account/client.mjs';
import { requireRequestId } from '../../account/protocol.mjs';

const INTERNAL = '/internal/v2/';
const PUBLIC = '/hosted/shared/account';
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
  for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) bad(413, 'body-too-large'); chunks.push(chunk); }
  try { const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!body || typeof body !== 'object' || Array.isArray(body)) bad(400, 'invalid-body'); return body; }
  catch (error) { if (error.status) throw error; bad(400, 'invalid-body'); }
}
const send = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(value));
};

/** Handler seam only. Public bearer and private mTLS listeners must be mounted separately.
 * Caller certificate registration is immutable owner configuration, never body/loopback identity.
 * No cookies, legacy LAN tickets, runGrant body exemptions or automatic logout-complete ACKs.
 */
export function mountAccountProjects({ authority, services = [], issueSession, resolveAssetTicket }) {
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
    const result = await issueSession({ principal, deviceId: body.deviceId, requestId: body.requestId,
      expectedAssetInstanceId: readiness?.instanceId });
    if (!result || typeof result.connectionTicket !== 'string' || !result.connectionTicket ||
      typeof result.assetTicket !== 'string' || !result.assetTicket || !Number.isSafeInteger(result.expiresAt)) bad(503, 'session-unavailable');
    return result;
  };
  async function dispatch(req, res, internal, context) {
    const url = new URL(req.url, 'http://route.invalid');
    if (internal ? !url.pathname.startsWith(INTERNAL) : !url.pathname.startsWith(PUBLIC)) return false;
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
            result = authority.ackAccessEvent(decodeURIComponent(ack[1]), service, receipt);
          }
        } else bad(403, 'service-forbidden');
      } else {
        const actor = bearer(req);
        if (req.method === 'POST') {
          const body = await readBody(req);
          // The public route cannot select a service/Agent role or supply an authoritative principal.
          if (['role', 'principal', 'loginId', 'credentialId', 'authorizationId', 'runGrantId', 'creator'].some(k => body[k] !== undefined) ||
            (body.accountId !== undefined && !url.pathname.endsWith('/admin'))) bad(400, 'invalid-authority-claim');
          if (url.pathname === `${PUBLIC}/create`) { result = await authority.createProject(actor, body); status = 201; }
          else if (url.pathname === `${PUBLIC}/join`) {
            if (typeof issueSession !== 'function') bad(503, 'session-unavailable');
            const membership = await authority.joinProject(actor, body); result = { membership, ...await session(actor, body, context?.readiness) };
          }
          else if (url.pathname === `${PUBLIC}/admin`) result = await authority.adminProject(actor, body);
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
      send(res, status, { ok: true, ...result });
    } catch (error) {
      const code = error.code ?? 'authority-unavailable';
      send(res, error.status ?? (error.code?.startsWith('bad-') ? 400 : 503), { ok: false, error: code, code, message: code });
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
