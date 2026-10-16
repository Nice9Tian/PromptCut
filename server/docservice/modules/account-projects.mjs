import https from 'node:https';
import { randomBytes, randomUUID } from 'node:crypto';
import { accountError, certificateFingerprint } from '../../account/client.mjs';
import { requireRequestId } from '../../account/protocol.mjs';

const INTERNAL = '/internal/v2/';
const PUBLIC = '/hosted/shared/account';
const isOldVersion = v => {
  if (typeof v !== 'string') return false;
  const parts = v.split('.').map(Number);
  if (parts.length >= 3) {
    if (parts[0] < 0) return true;
    if (parts[0] === 0 && parts[1] < 7) return true;
    if (parts[0] === 0 && parts[1] === 7 && parts[2] <= 17) return true;
  }
  return false;
};
const bad = (status, code, message) => { const err = accountError(status, code); if (message) err.message = message; throw err; };
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
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += buf.length; if (size > 1024 * 1024) bad(413, 'body-too-large'); chunks.push(buf);
  }
  try { const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!body || typeof body !== 'object' || Array.isArray(body)) bad(400, 'invalid-body'); return body; }
  catch (error) { if (error.status) throw error; bad(400, 'invalid-body'); }
}
const send = (res, status, value, cors = false) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    ...(cors ? { 'access-control-allow-origin': '*' } : {}) });
  res.end(JSON.stringify(value));
};

/** Handler seam only. Public bearer and private mTLS listeners must be mounted separately.
 * Caller certificate registration is immutable owner configuration, never body/loopback identity.
 * No cookies, legacy LAN tickets, runGrant body exemptions or automatic logout-complete ACKs.
 */
export function mountAccountProjects({ authority, services = [], issueSession, resolveAssetTicket, membersSnapshot, history }) {
  const registry = new Map();
  for (const entry of services) {
    const fingerprint = certificateFingerprint(entry.fingerprint256);
    if (!['account', 'asset', 'agent', 'render'].includes(entry.serviceId) || !/^[a-f0-9]{64}$/.test(fingerprint) || registry.has(fingerprint)) bad(503, 'service-configuration');
    registry.set(fingerprint, entry.serviceId);
  }

  // Custom project and ID mapping for preserved project IDs (10-14 第 3.3 节)
  const customProjects = new Map();
  const projectIdMap = new Map();

  if (authority && !authority._PC_V18_WRAPPED) {
    authority._PC_V18_WRAPPED = true;
    const origAuthorize = authority.authorizePrincipal?.bind(authority);
    if (origAuthorize) {
      authority.authorizePrincipal = async (actorInput, options = {}) => {
        const reqProjectId = options.projectId;
        const mapped = projectIdMap.get(reqProjectId) ?? reqProjectId;
        const p = await origAuthorize(actorInput, { ...options, projectId: mapped });
        if (p && projectIdMap.has(mapped)) {
          return { ...p, projectId: projectIdMap.get(mapped) };
        }
        return p;
      };
    }
    const origCheckAccess = authority.checkAccess?.bind(authority);
    if (origCheckAccess) {
      authority.checkAccess = async (input) => {
        const reqProjectId = input.projectId;
        const mapped = projectIdMap.get(reqProjectId) ?? reqProjectId;
        const principal = input.principal ? {
          ...input.principal,
          projectId: projectIdMap.get(input.principal.projectId) ?? input.principal.projectId,
        } : input.principal;
        return origCheckAccess({ ...input, principal, projectId: mapped });
      };
    }
    const origStatus = authority.status?.bind(authority);
    if (origStatus) {
      authority.status = (query) => {
        const mapped = projectIdMap.get(query.projectId) ?? query.projectId;
        const s = origStatus({ ...query, projectId: mapped });
        if (s && s.projectId && projectIdMap.has(mapped)) s.projectId = projectIdMap.get(mapped);
        return s;
      };
    }
    const origStatusForPrincipal = authority.statusForPrincipal?.bind(authority);
    if (origStatusForPrincipal) {
      authority.statusForPrincipal = async (actorInput, query) => {
        const mapped = projectIdMap.get(query.projectId) ?? query.projectId;
        const s = await origStatusForPrincipal(actorInput, { ...query, projectId: mapped });
        if (s && s.projectId && projectIdMap.has(mapped)) s.projectId = projectIdMap.get(mapped);
        return s;
      };
    }
    const origJoin = authority.joinProject?.bind(authority);
    if (origJoin) {
      authority.joinProject = async (actorInput, body) => {
        const mapped = projectIdMap.get(body.projectId) ?? body.projectId;
        return origJoin(actorInput, { ...body, projectId: mapped });
      };
    }
    const origAdmin = authority.adminProject?.bind(authority);
    if (origAdmin) {
      authority.adminProject = async (actorInput, body) => {
        const mapped = projectIdMap.get(body.projectId) ?? body.projectId;
        if (body.op === 'regen-link') {
          const p = customProjects.get(body.projectId) || customProjects.get(mapped) || { accessRevision: 1 };
          p.accessRevision = (p.accessRevision || 1) + 1;
          p.linkToken = randomUUID();
          return { ok: true, op: 'regen-link', linkToken: p.linkToken, accessRevision: p.accessRevision, link: `/editor?project=${encodeURIComponent(body.projectId)}&token=${p.linkToken}` };
        }
        if (body.op === 'set-secondary-password') {
          const p = customProjects.get(body.projectId) || customProjects.get(mapped) || { accessRevision: 1 };
          p.secondaryPassword = typeof body.password === 'string' && body.password.trim() ? body.password.trim() : null;
          p.accessRevision = (p.accessRevision || 1) + 1;
          return { ok: true, op: 'set-secondary-password', hasPassword: !!p.secondaryPassword, accessRevision: p.accessRevision };
        }
        return origAdmin(actorInput, { ...body, projectId: mapped });
      };
    }
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
    const mapped = projectIdMap.get(body.projectId) ?? body.projectId;
    const principal = await authority.authorizePrincipal(actor, { projectId: mapped });
    const result = await issueSession({ principal: { ...principal, projectId: body.projectId }, deviceId: body.deviceId, requestId: body.requestId,
      expectedAssetInstanceId: readiness?.instanceId });
    if (!result || typeof result.connectionTicket !== 'string' || !result.connectionTicket ||
      typeof result.assetTicket !== 'string' || !result.assetTicket || !Number.isSafeInteger(result.expiresAt)) bad(503, 'session-unavailable');
    return result;
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
      } else {
        const actor = bearer(req);
        if (req.method === 'POST') {
          const body = await readBody(req);
          // The public route cannot select a service/Agent role or supply an authoritative principal.
          if (['role', 'principal', 'loginId', 'credentialId', 'authorizationId', 'runGrantId', 'creator'].some(k => body[k] !== undefined) ||
            (body.accountId !== undefined && !url.pathname.endsWith('/admin'))) bad(400, 'invalid-authority-claim');
          const versionHeader = req.headers['x-promptcut-version'];
          const clientVer = typeof versionHeader === 'string' ? versionHeader : (typeof body?.clientVersion === 'string' ? body.clientVersion : null);
          if (clientVer && isOldVersion(clientVer)) bad(400, 'version-expired', '当前软件版本已过期，无法搬到云端');

          if (url.pathname === `${PUBLIC}/create`) {
            const customId = typeof body.projectId === 'string' && body.projectId.trim() ? body.projectId.trim() : null;
            if (customId) {
              const existing = customProjects.get(customId);
              if (existing) {
                if (existing.creationRequestId === body.requestId) {
                  result = { projectId: customId, authorityId: authority.authorityId, contentId: existing.contentId, accessRevision: existing.accessRevision };
                  status = 201;
                } else if (existing.creatorAccountId !== actor.accountId) {
                  bad(409, 'name-taken');
                }
              }
            }
            if (!result) {
              const created = await authority.createProject(actor, body);
              if (customId) {
                projectIdMap.set(customId, created.projectId);
                projectIdMap.set(created.projectId, customId);
                const customRecord = {
                  projectId: customId,
                  spId: created.projectId,
                  name: body.name,
                  creatorAccountId: actor.accountId,
                  allowLinkJoin: body.allowLinkJoin ?? true,
                  rev: Number.isSafeInteger(body.rev) ? body.rev : 1,
                  history: Array.isArray(body.history) ? body.history : [],
                  initialProject: body.initialProject ?? null,
                  creationRequestId: body.requestId,
                  accessRevision: created.accessRevision,
                  contentId: created.contentId,
                };
                customProjects.set(customId, customRecord);
                if (history && typeof history.createProject === 'function') {
                  history.createProject(customId, body.initialProject ?? {}, { projectRev: customRecord.rev });
                  if (customRecord.history.length && typeof history.importHistory === 'function') {
                    history.importHistory(customId, customRecord.history);
                  }
                }
                result = { ...created, projectId: customId };
              } else {
                result = created;
              }
              status = 201;
            }
          }
          else if (url.pathname === `${PUBLIC}/join`) {
            if (typeof issueSession !== 'function') bad(503, 'session-unavailable');
            const mapped = projectIdMap.get(body.projectId) ?? body.projectId;
            const membership = await authority.joinProject(actor, { ...body, projectId: mapped });
            result = { membership, ...await session(actor, body, context?.readiness) };
          }
          else if (url.pathname === `${PUBLIC}/admin`) {
            const mapped = projectIdMap.get(body.projectId) ?? body.projectId;
            if (body.op === 'regen-link') {
              const p = customProjects.get(body.projectId) || customProjects.get(mapped) || { accessRevision: 1 };
              p.accessRevision = (p.accessRevision || 1) + 1;
              p.linkToken = randomUUID();
              result = { ok: true, op: 'regen-link', linkToken: p.linkToken, accessRevision: p.accessRevision, link: `/editor?project=${encodeURIComponent(body.projectId)}&token=${p.linkToken}` };
            } else if (body.op === 'set-secondary-password') {
              const p = customProjects.get(body.projectId) || customProjects.get(mapped) || { accessRevision: 1 };
              p.secondaryPassword = typeof body.password === 'string' && body.password.trim() ? body.password.trim() : null;
              p.accessRevision = (p.accessRevision || 1) + 1;
              result = { ok: true, op: 'set-secondary-password', hasPassword: !!p.secondaryPassword, accessRevision: p.accessRevision };
            } else {
              result = await authority.adminProject(actor, { ...body, projectId: mapped });
            }
          }
          else if (url.pathname === `${PUBLIC}/members`) {
            if (typeof membersSnapshot !== 'function') bad(503, 'members-unavailable');
            const mapped = projectIdMap.get(body.projectId) ?? body.projectId;
            result = await membersSnapshot(actor, { ...body, projectId: mapped });
            if (result && result.projectId) result.projectId = body.projectId;
          }
          else if (url.pathname === `${PUBLIC}/session`) {
            result = await session(actor, body, context?.readiness);
          } else bad(404, 'no-route');
        } else if (req.method === 'GET' && url.pathname === `${PUBLIC}/status`) {
          // Authenticate first: an invalid login cannot obtain an authoritative gone result.
          await authority.synchronize();
          const identityProject = url.searchParams.get('projectId');
          const mapped = projectIdMap.get(identityProject) ?? identityProject;
          try { await authority.authorizePrincipal(actor, { projectId: mapped }); }
          catch (error) {
            // Deleted known projects are available only to their creator/member via statusForPrincipal.
            if (error.status !== 404) throw error;
            result = await authority.statusForPrincipal(actor, { authorityId: url.searchParams.get('authorityId'), projectId: mapped });
          }
          result ??= authority.status({ authorityId: url.searchParams.get('authorityId'), projectId: mapped });
          if (result && result.projectId && identityProject) result.projectId = identityProject;
        } else bad(405, 'method-not-allowed');
      }
      send(res, status, { ok: true, ...result }, cors);
    } catch (error) {
      const code = error.code ?? 'authority-unavailable';
      const message = error.message && error.message !== code ? error.message : (code === 'version-expired' ? '当前软件版本已过期，无法搬到云端' : code);
      send(res, error.status ?? (error.code?.startsWith('bad-') ? 400 : 503), { ok: false, error: code, code, message }, cors);
    }
    return true;
  }
  return { authority, customProjects, projectIdMap, handlePublic: (req, res, context) => dispatch(req, res, false, context), handleInternal: (req, res) => dispatch(req, res, true) };
}

export function createAccountProjectsInternalServer({ tls, ...options }) {
  if (!tls?.key || !tls?.cert || !tls?.ca) bad(503, 'internal-configuration');
  const mounted = mountAccountProjects(options);
  return https.createServer({ key: tls.key, cert: tls.cert, ca: tls.ca, requestCert: true,
    rejectUnauthorized: true, minVersion: 'TLSv1.3' }, async (req, res) => {
    if (!await mounted.handleInternal(req, res)) send(res, 404, { ok: false, error: 'no-route' });
  });
}
