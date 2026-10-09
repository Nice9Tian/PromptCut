import https from 'node:https';
import { accountError, certificateFingerprint } from './client.mjs';
import { assertInstanceDirectTransport } from './agent-instance-internal.mjs';

const ROOT = '/internal/v2/runs/';
const binding = ['projectId', 'conversationId', 'messageId', 'runId', 'runGrantId'];
const readFields = [...binding, 'requestId', 'readIntentId', 'promptDigest', 'prompt'];
const shapes = Object.freeze({ admit: ['projectId', 'conversationId', 'requestId'], read: readFields,
  'read/query': readFields, check: ['projectId', 'runGrantId'], finish: [...binding, 'requestId'],
  assignment: [...binding, 'requestId'], ticket: ['projectId', 'runGrantId', 'conversationId', 'purpose'], pending: [] });
const fail = (status, code) => { throw accountError(status, code); };
const reference = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const response = (res, status, body) => {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
async function bodyOf(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length; if (size > 1024 * 1024) fail(413, 'run-body-too-large'); chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'invalid-body'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid-body');
  return body;
}
function validateBody(action, body) {
  const fields = shapes[action], optional = action === 'check' ? ['action'] : [];
  if (Object.keys(body).some(field => !fields.includes(field) && !optional.includes(field)) ||
      fields.some(field => !Object.hasOwn(body, field))) fail(400, 'invalid-run-body');
  for (const field of fields.filter(field => !['prompt', 'promptDigest', 'purpose'].includes(field)))
    if (!reference(body[field])) fail(400, 'invalid-run-reference');
  if (action === 'read' || action === 'read/query') {
    if (!body.prompt || typeof body.prompt !== 'object' || Array.isArray(body.prompt) ||
        !/^[0-9a-f]{64}$/.test(body.promptDigest ?? '')) fail(400, 'invalid-read-record');
    // The authority independently rebuilds the complete persistent message.
    // A digest or actor inside this prompt is not an authorization capability.
  }
  if (action === 'ticket' && body.purpose !== 'run') fail(400, 'invalid-run-purpose');
  if (action === 'check' && body.action !== undefined && !['read', 'write'].includes(body.action)) fail(400, 'invalid-run-action');
}

/** Only a pinned Agent leaf certificate reaches these routes. All service and
 * actor identities come from trusted callbacks/ledger, never from the body. */
export function createRunInternalHandler({ runAuthority, agentFingerprint256, resolveServicePrincipal,
  authenticateInvocation, principalForCheck, issueRunTicket, listPendingRuns } = {}) {
  const pin = certificateFingerprint(agentFingerprint256);
  if (!/^[a-f0-9]{64}$/.test(pin) || typeof resolveServicePrincipal !== 'function' ||
      !['admit', 'confirmRead', 'queryRead', 'checkAccess', 'resolveRunPrincipal', 'finish'].every(method =>
        typeof runAuthority?.[method] === 'function')) fail(503, 'run-internal-configuration');
  return async function handle(req, res) {
    const url = new URL(req.url, 'https://internal.invalid');
    if (!url.pathname.startsWith(ROOT)) return false;
    let invocation = null;
    try {
      assertInstanceDirectTransport(req);
      const peer = req.socket?.getPeerCertificate?.(), fingerprint256 = certificateFingerprint(peer?.fingerprint256);
      if (req.socket?.authorized !== true || fingerprint256 !== pin) fail(403, 'service-forbidden');
      if (req.method !== 'POST') fail(405, 'method-not-allowed');
      const action = url.pathname.slice(ROOT.length);
      if (!Object.hasOwn(shapes, action)) fail(404, 'no-route');
      const body = await bodyOf(req); validateBody(action, body);
      let servicePrincipal = await resolveServicePrincipal({ fingerprint256, socket: req.socket });
      if (!servicePrincipal || servicePrincipal.service !== 'agent' || !reference(servicePrincipal.serviceKid))
        fail(403, 'run-service-forbidden');
      if (action !== 'pending') {
        if (typeof authenticateInvocation !== 'function') fail(503, 'instance-consumer-unavailable');
        if (action === 'check' && !['read', 'write'].includes(body.action)) fail(400, 'invalid-run-action');
        invocation = await authenticateInvocation({ req, servicePrincipal, body,
          operation: ({ admit: 'admit', read: 'confirmRead', 'read/query': 'queryRead', finish: 'finish',
            assignment: 'scopeAssignment', check: 'checkAccess', ticket: 'resolveRunPrincipal' })[action] });
        if (!invocation?.servicePrincipal || typeof invocation.release !== 'function') fail(503, 'instance-consumer-unavailable');
        servicePrincipal = invocation.servicePrincipal;
      }
      const input = { ...body, servicePrincipal }; let result;
      if (action === 'admit') result = await runAuthority.admit(input);
      else if (action === 'read') result = await runAuthority.confirmRead(input);
      else if (action === 'read/query') result = await runAuthority.queryRead(input);
      else if (action === 'finish') result = await runAuthority.finish(input);
      else if (action === 'assignment') {
        if (typeof runAuthority.scopeAssignment !== 'function') fail(503, 'run-scope-unavailable');
        result = await runAuthority.scopeAssignment(input);
      }
      else if (action === 'pending') {
        if (typeof listPendingRuns !== 'function') fail(503, 'run-pending-unavailable');
        result = await listPendingRuns({ servicePrincipal });
        if (!result || Object.keys(result).length !== 1 || !Array.isArray(result.conversations) ||
            result.conversations.some(row => !row || Object.keys(row).length !== 3 ||
              !reference(row.projectId) || !reference(row.conversationId) ||
              !Number.isSafeInteger(row.queueRevision) || row.queueRevision < 0))
          fail(503, 'run-pending-protocol');
      } else {
        if (action === 'check' && typeof principalForCheck !== 'function') fail(503, 'instance-consumer-unavailable');
        const principal = action === 'check' ? await principalForCheck(input) :
          await runAuthority.resolveRunPrincipal({ servicePrincipal, projectId: body.projectId, runGrantId: body.runGrantId });
        if (principal?.realm !== 'account' || principal.identityVersion !== 2 || principal.role !== 'agent' ||
            principal.creator !== false || principal.serviceId !== 'agent' ||
            principal.projectId !== body.projectId || principal.runGrantId !== body.runGrantId ||
            principal.servicePrincipal !== servicePrincipal || principal.serviceKid !== servicePrincipal.serviceKid)
          fail(403, 'run-principal-mismatch');
        if (action === 'check') {
          const checked = await runAuthority.checkAccess({ principal, projectId: body.projectId, action: body.action });
          if (checked?.allowed !== true) fail(403, 'run-revoked');
          // The internal instanceSession/servicePrincipal never reaches HTTP.
          const publicPrincipal = Object.fromEntries(['realm', 'identityVersion', 'role', 'creator',
            ...binding, 'accountId', 'loginId', 'credentialId', 'loginGeneration', 'serviceId', 'serviceKid',
            'instanceId', 'instanceGeneration'].filter(field => principal[field] !== undefined)
            .map(field => [field, principal[field]]));
          result = { ...checked, principal: publicPrincipal };
        }
        else {
          if (principal.conversationId !== body.conversationId) fail(403, 'run-binding-mismatch');
          if (typeof issueRunTicket !== 'function') fail(503, 'run-ticket-unavailable');
          result = await issueRunTicket({ principal, servicePrincipal, purpose: 'run' });
          if (!result || typeof result.connectionTicket !== 'string' || !result.connectionTicket ||
              !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= 0) fail(503, 'run-ticket-protocol');
        }
      }
      response(res, 200, { ok: true, result });
    } catch (error) { response(res, error?.status ?? 503, { ok: false, code: error?.code ?? 'run-unavailable' }); }
    finally { invocation?.release?.(); }
    return true;
  };
}

export function createRunInternalServer({ tls, ...options } = {}) {
  if (!tls?.key || !tls?.cert || !tls?.ca) fail(503, 'run-internal-configuration');
  const handle = createRunInternalHandler(options);
  return https.createServer({ key: tls.key, cert: tls.cert, ca: tls.ca, requestCert: true,
    rejectUnauthorized: true, minVersion: 'TLSv1.3' }, async (req, res) => {
    if (!await handle(req, res)) response(res, 404, { ok: false, code: 'no-route' });
  });
}
