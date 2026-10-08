import { accountError, certificateFingerprint } from './client.mjs';

export const INSTANCE_PROOF_HEADER = 'x-promptcut-instance-proof';
export const INSTANCE_DATA_PROOF_HEADER = 'x-promptcut-data-proof';
/** Classify the complete message name. This is a proof scope, not permission:
 * the service whitelist and live authority still gate every dispatched message. */
export function instanceMessageAction(type) {
  return /^(?:(?:project\.(?:op|upload|snapshot\.put)|content\.put|presence\.(?:set|clear|send))$|(?:events|task|publisher|node)\.)/.test(type) ? 'write' : 'read';
}
const ROOT = '/internal/v2/instances/';
const fail = (status, code) => { throw accountError(status, code); };
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
const reply = (res, status, value) => {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
};

export function assertInstanceDirectTransport(req) {
  if (Object.keys(req.headers ?? {}).some(name => name === 'forwarded' || name === 'x-real-ip' || name.startsWith('x-forwarded-')))
    fail(403, 'instance-proxy-forbidden');
}

/** Proof is a signature, not an invocation/session capability. The authority
 * independently supplies the current TLS binding and registry service identity. */
export function instanceRequestProof(req) {
  assertInstanceDirectTransport(req);
  const encoded = req.headers?.[INSTANCE_PROOF_HEADER];
  if (typeof encoded !== 'string' || encoded.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(encoded))
    fail(403, 'instance-proof-required');
  let proof;
  try { proof = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); }
  catch { fail(400, 'instance-proof-invalid'); }
  if (!exact(proof, ['instanceId', 'instanceGeneration', 'signature']) ||
      typeof proof.instanceId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(proof.instanceId) ||
      !Number.isSafeInteger(proof.instanceGeneration) || proof.instanceGeneration < 1 ||
      typeof proof.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(proof.signature))
    fail(400, 'instance-proof-invalid');
  return proof;
}

/** Public signing tuple. Callers independently obtain all actual transport
 * values; the receiver never treats these fields as actor authorization. */
export function instanceConnectionRequest({ projectId, runGrantId, nonce, purpose, url, protocols, bodyText = '', sessionItem }) {
  return { projectId, runGrantId, nonce, purpose, url, protocols, bodyText,
    ...(sessionItem ? { sessionItem } : {}) };
}
export function instanceProtocolHeaders(headers = {}) {
  return { websocket: headers['sec-websocket-protocol'] ?? null, http: headers['x-promptcut-protocols'] ?? null,
    fallback: headers['x-promptcut-fallback'] ?? null };
}
export function instanceDataRequest({ projectId, runGrantId, connId, nonce, kind, url, protocols, bodyText = '', text,
  frameIndex, action }) {
  return { projectId, runGrantId, connId, nonce, kind, url, protocols, bodyText,
    ...(text !== undefined ? { text } : {}), ...(frameIndex !== undefined ? { frameIndex } : {}),
    ...(action !== undefined ? { action } : {}) };
}

export function createAgentInstanceInternalHandler({ instanceAuthority, agentFingerprint256, resolveServicePrincipal } = {}) {
  const pin = certificateFingerprint(agentFingerprint256);
  if (!/^[a-f0-9]{64}$/.test(pin) || typeof resolveServicePrincipal !== 'function' ||
      typeof instanceAuthority?.beginRegistration !== 'function' || typeof instanceAuthority?.register !== 'function')
    fail(503, 'instance-internal-configuration');
  return async function handle(req, res) {
    const route = new URL(req.url ?? '/', 'https://internal.invalid').pathname;
    if (!route.startsWith(ROOT)) return false;
    try {
      assertInstanceDirectTransport(req);
      if (req.socket?.authorized !== true || certificateFingerprint(req.socket?.getPeerCertificate?.()?.fingerprint256) !== pin)
        fail(403, 'service-forbidden');
      if (req.method !== 'POST') fail(405, 'method-not-allowed');
      const action = route.slice(ROOT.length);
      if (!['challenge', 'register'].includes(action)) fail(404, 'no-route');
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 16 * 1024) fail(413, 'instance-body-too-large'); chunks.push(chunk); }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'invalid-body'); }
      if (!exact(body, action === 'challenge' ? ['requestId', 'publicKey'] : ['challenge', 'signature']))
        fail(400, 'invalid-instance-body');
      const servicePrincipal = await resolveServicePrincipal({ socket: req.socket });
      const result = action === 'challenge' ? instanceAuthority.beginRegistration({ ...body, servicePrincipal }) :
        instanceAuthority.register({ ...body, servicePrincipal });
      // Only persistent public challenge/registration results reach the wire.
      reply(res, 200, { ok: true, result });
    } catch (error) { reply(res, error.status ?? 503, { ok: false, code: error.code ?? 'instance-unavailable' }); }
    return true;
  };
}
