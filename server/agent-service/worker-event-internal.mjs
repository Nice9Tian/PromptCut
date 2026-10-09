import { createHash } from 'node:crypto';
import { canonicalJson, digestOf } from '../account/ledger.mjs';

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
