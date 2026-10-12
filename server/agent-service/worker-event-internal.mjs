import { createHash, createPublicKey, verify } from 'node:crypto';
import { canonicalJson, digestOf } from '../account/ledger.mjs';
import { certificateFingerprint } from '../account/client.mjs';

export const WORKER_EVENT_PATH = '/internal/v2/worker/events/append';
export const WORKER_EVENT_PROOF_HEADER = 'x-promptcut-worker-event-proof';
export const WORKER_EVENT_EXPORTER_LABEL = 'EXPORTER-PromptCut-Agent-Worker-Event-v1';
export const WORKER_EVENT_DOMAIN = 'promptcut.agent-worker.event.v1';
export const WORKER_EVENT_BINDING_FIELDS = Object.freeze(['projectId', 'conversationId', 'messageId',
  'runId', 'runGrantId', 'instanceId', 'instanceGeneration', 'serviceKid', 'senderAccountId']);
const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
const ref = v => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(v);
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) &&
  Object.keys(v).sort().join(',') === [...keys].sort().join(',');

/** A public descriptor is not authority. Only the receiving service's fresh
 * Doc workerEventSource result may authorize its exact run/instance/key. */
export function validateWorkerEventPacket(input) {
  let v;
  try { v = structuredClone(input); } catch { fail(400, 'worker-event-packet'); }
  if (!exact(v, ['v', 'authorityId', 'rootScopeRef', 'assignmentDigest', 'binding', 'sourceSeq', 'eventId', 'event']) ||
      v.v !== 1 || !ref(v.authorityId) || !hash(v.assignmentDigest) ||
      !exact(v.rootScopeRef, ['rootAuthorityId', 'slotId', 'epoch', 'recordDigest']) ||
      !ref(v.rootScopeRef.rootAuthorityId) || !ref(v.rootScopeRef.slotId) || !hash(v.rootScopeRef.recordDigest) ||
      !Number.isSafeInteger(v.rootScopeRef.epoch) || v.rootScopeRef.epoch < 1 ||
      !exact(v.binding, WORKER_EVENT_BINDING_FIELDS) || WORKER_EVENT_BINDING_FIELDS.some(k => k === 'instanceGeneration'
        ? !Number.isSafeInteger(v.binding[k]) || v.binding[k] < 1 : !ref(v.binding[k])) ||
      !Number.isSafeInteger(v.sourceSeq) || v.sourceSeq < 1 || !ref(v.eventId) ||
      !v.event || typeof v.event !== 'object' || Array.isArray(v.event) || !ref(v.event.type) ||
      WORKER_EVENT_BINDING_FIELDS.some(k => v.event[k] !== undefined && v.event[k] !== v.binding[k]))
    fail(400, 'worker-event-packet');
  // Reject values with a different wire JSON meaning (undefined, NaN, exotic
  // structured-clone objects). The original UTF-8 bytes are signed separately.
  try { if (canonicalJson(JSON.parse(JSON.stringify(v))) !== canonicalJson(v)) fail(400, 'worker-event-packet'); }
  catch { fail(400, 'worker-event-packet'); }
  return v;
}

export function workerEventRequest({ body, bodyText } = {}) {
  if (typeof bodyText !== 'string' || Buffer.byteLength(bodyText, 'utf8') > 1024 * 1024)
    fail(400, 'worker-event-body');
  let parsed;
  try { parsed = JSON.parse(bodyText); } catch { fail(400, 'worker-event-body'); }
  const packet = validateWorkerEventPacket(body);
  if (canonicalJson(parsed) !== canonicalJson(packet)) fail(400, 'worker-event-body');
  return { packet, bodyHash: createHash('sha256').update(bodyText, 'utf8').digest('hex') };
}

/** Never reconstruct this value from a header or proxy-forwarded binding. */
export function workerEventTlsBinding(socket) {
  if (!socket?.encrypted || socket.authorized !== true || socket.destroyed ||
      typeof socket.exportKeyingMaterial !== 'function') fail(503, 'worker-event-transport');
  try {
    const bytes = socket.exportKeyingMaterial(32, WORKER_EVENT_EXPORTER_LABEL);
    if (bytes.length !== 32) fail(503, 'worker-event-transport');
    return createHash('sha256').update(bytes).digest('hex');
  } catch { fail(503, 'worker-event-transport'); }
}

export function workerEventProofPayload({ request, channelBinding, nonce } = {}) {
  if (!request || !hash(request.bodyHash) || !hash(channelBinding) || !ref(nonce)) fail(400, 'worker-event-proof');
  const p = validateWorkerEventPacket(request.packet);
  return { v: 1, domain: WORKER_EVENT_DOMAIN, method: 'POST', path: WORKER_EVENT_PATH,
    authorityId: p.authorityId, rootScopeRef: p.rootScopeRef, assignmentDigest: p.assignmentDigest,
    binding: p.binding, sourceSeq: p.sourceSeq, eventId: p.eventId, packetDigest: digestOf(p),
    bodyHash: request.bodyHash, channelBinding, nonce };
}

/** Mount only on a direct mTLS master endpoint. resolveWorker must call the
 * control-only master's current pinned Doc getter, never a cached root record.
 * The callback runs inside the event store's serialized append, immediately
 * before its synchronous FULL transaction. This route does not grant execution.
 */
export function createWorkerEventInternalHandler({ eventStore, resolveWorker } = {}) {
  if (typeof eventStore?.appendWorker !== 'function' || typeof resolveWorker !== 'function')
    fail(503, 'worker-event-configuration');
  const used = new WeakMap();
  return async function handle(req, res) {
    if (req.url !== WORKER_EVENT_PATH) return false;
    const reply = (status, body) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method !== 'POST') fail(405, 'method-not-allowed');
      if (req.socket?.encrypted !== true || req.socket.authorized !== true || req.socket.destroyed ||
          Object.keys(req.headers ?? {}).some(k => k === 'forwarded' || k === 'x-real-ip' || k.startsWith('x-forwarded-')))
        fail(403, 'worker-event-peer');
      const peer = certificateFingerprint(req.socket.getPeerCertificate?.()?.fingerprint256);
      if (!hash(peer)) fail(403, 'worker-event-peer');
      const encoded = req.headers?.[WORKER_EVENT_PROOF_HEADER];
      if (typeof encoded !== 'string' || encoded.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(encoded)) fail(403, 'worker-event-proof');
      let proof;
      try { proof = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { fail(403, 'worker-event-proof'); }
      if (!exact(proof, ['v', 'nonce', 'signature']) || proof.v !== 1 || !ref(proof.nonce) ||
          typeof proof.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(proof.signature)) fail(403, 'worker-event-proof');
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length; if (size > 1024 * 1024) fail(413, 'worker-event-body'); chunks.push(chunk);
      }
      let bodyText, body;
      try { bodyText = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); body = JSON.parse(bodyText); }
      catch { fail(400, 'worker-event-body'); }
      const request = workerEventRequest({ body, bodyText });
      const result = await eventStore.appendWorker({ packet: request.packet, readSource: async packet => {
        const source = await resolveWorker({ projectId: packet.binding.projectId, runGrantId: packet.binding.runGrantId,
          assignmentDigest: packet.assignmentDigest });
        if (source?.allowed !== true || certificateFingerprint(source.workerFingerprint256) !== peer ||
            source.scopePublicKeyDigest !== digestOf(source.scopePublicKey)) fail(403, 'worker-event-peer');
        let key;
        try {
          key = createPublicKey({ key: Buffer.from(source.scopePublicKey, 'base64'), format: 'der', type: 'spki' });
          if (key.asymmetricKeyType !== 'ed25519' || key.export({ format: 'der', type: 'spki' }).toString('base64') !== source.scopePublicKey)
            fail(403, 'worker-event-key');
        } catch { fail(403, 'worker-event-key'); }
        const payload = workerEventProofPayload({ request, nonce: proof.nonce, channelBinding: workerEventTlsBinding(req.socket) });
        if (!verify(null, Buffer.from(canonicalJson(payload)), key, Buffer.from(proof.signature, 'base64url')))
          fail(403, 'worker-event-signature');
        const nonces = used.get(req.socket) ?? new Set();
        if (nonces.has(proof.nonce)) fail(403, 'worker-event-replay');
        nonces.add(proof.nonce); used.set(req.socket, nonces);
        return source;
      } });
      reply(200, { ok: true, result });
    } catch (error) { reply(error.status ?? 503, { ok: false, code: error.code ?? 'worker-event-unavailable' }); }
    return true;
  };
}
