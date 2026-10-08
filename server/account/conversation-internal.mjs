import https from 'node:https';
import { certificateFingerprint, accountError } from './client.mjs';

const ROOT = '/internal/v2/conversations/';
const fail = (status, code) => { throw accountError(status, code); };
const response = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
async function bodyOf(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) fail(413, 'conversation-body-too-large');
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'invalid-body'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid-body');
  return body;
}

/** Only the pinned Agent service certificate can use this internal route. The delegation
 * is resolved by doc RAM authority; caller-supplied principal/role/account fields are rejected.
 */
export function createConversationInternalHandler({ conversationAuthority, resolveDelegation, agentFingerprint256 }) {
  const pin = certificateFingerprint(agentFingerprint256);
  if (!/^[a-f0-9]{64}$/.test(pin) || !conversationAuthority || typeof resolveDelegation !== 'function') fail(503, 'conversation-internal-configuration');
  return async function handle(req, res) {
    const url = new URL(req.url, 'https://internal.invalid');
    if (!url.pathname.startsWith(ROOT)) return false;
    try {
      const cert = req.socket?.getPeerCertificate?.();
      if (req.socket?.authorized !== true || certificateFingerprint(cert?.fingerprint256) !== pin) fail(403, 'service-forbidden');
      if (req.method !== 'POST') fail(405, 'method-not-allowed');
      const action = url.pathname.slice(ROOT.length);
      if (!['identity', 'access', 'list', 'get', 'send', 'switch', 'stop', 'rename'].includes(action)) fail(404, 'no-route');
      const body = await bodyOf(req);
      if (['principal', 'principalRef', 'authorizationId', 'accountId', 'loginId', 'credentialId', 'loginGeneration',
        'senderAccountId', 'senderNameAtSend', 'creator', 'serviceId', 'servicePrincipal', 'readReceiptId', 'runGrantId'].some(k => body[k] !== undefined))
        fail(400, 'invalid-authority-claim');
      if (typeof body.delegation !== 'string' || !body.delegation) fail(401, 'delegation-required');
      const trusted = await resolveDelegation(body.delegation, { serviceId: 'agent', action });
      if (!trusted?.authorizationId || !trusted.projectId || (body.projectId !== undefined && body.projectId !== trusted.projectId)) fail(403, 'project-mismatch');
      const input = { principalRef: { authorizationId: trusted.authorizationId }, projectId: trusted.projectId,
        conversationId: body.conversationId };
      let result;
      switch (action) {
        case 'identity': result = await conversationAuthority.identity(input); break;
        case 'access': result = await conversationAuthority.access({ ...input, action: body.action }); break;
        case 'list': result = await conversationAuthority.list(input); break;
        case 'get': result = await conversationAuthority.get({ ...input, after: body.after }); break;
        case 'send': result = await conversationAuthority.send({ ...input, requestId: body.requestId,
          content: body.content, selectionInput: body.selectionInput }); break;
        case 'switch': result = await conversationAuthority.switchVisibility({ ...input, visibility: body.visibility, requestId: body.requestId }); break;
        case 'stop': result = await conversationAuthority.stop({ ...input, runId: body.runId, requestId: body.requestId }); break;
        case 'rename': result = await conversationAuthority.rename({ ...input, title: body.title }); break;
      }
      response(res, 200, { ok: true, result });
    } catch (error) {
      const code = error?.code ?? 'conversation-unavailable';
      response(res, error?.status ?? 503, { ok: false, code });
    }
    return true;
  };
}

export function createConversationInternalServer({ tls, ...options }) {
  if (!tls?.key || !tls?.cert || !tls?.ca) fail(503, 'conversation-internal-configuration');
  const handle = createConversationInternalHandler(options);
  return https.createServer({ key: tls.key, cert: tls.cert, ca: tls.ca, requestCert: true,
    rejectUnauthorized: true, minVersion: 'TLSv1.3' }, async (req, res) => {
    if (!await handle(req, res)) response(res, 404, { ok: false, code: 'no-route' });
  });
}
