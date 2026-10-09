/** Doc-side scope assignment. Root IO is a read-only source, never a network
 * supplied closed row. The optional sourceFactory is only for controlled tests;
 * production assembly uses the fixed root-file reader and configured anchors. */
import { createPublicKey, sign } from 'node:crypto';
import { accountError } from './client.mjs';
import { digestOf, canonicalJson } from './ledger.mjs';
import { createAgentScopeReader } from '../hosted/agent-run-scope-reader.mjs';
import { exactScope, validateAgentScopeAssignment } from '../hosted/agent-run-scope-schema.mjs';

const fail = (status, code) => { throw accountError(status, `run-scope-${code}`); };
const copy = structuredClone;
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const refFields = ['rootAuthorityId', 'slotId', 'epoch', 'recordDigest'];
const targetFields = ['projectId', 'conversationId', 'messageId', 'runId', 'runGrantId',
  'serviceId', 'serviceKid', 'instanceId', 'instanceGeneration'];
export const agentScopeRef = record => ({ rootAuthorityId: record.authorityId, slotId: record.slotId,
  epoch: record.epoch, recordDigest: digestOf(record) });

/** Keep the original Doc PEM digest and the root DER digest distinct. Equality
 * of key bytes, not equality of unrelated hashes, joins the two identities. */
export function agentScopeKeyMapping(publicKey, rootPublicKey) {
  let key;
  try { key = createPublicKey(publicKey); } catch { fail(403, 'key-invalid'); }
  if (key.asymmetricKeyType !== 'ed25519') fail(403, 'key-invalid');
  const pem = key.export({ format: 'pem', type: 'spki' }).toString();
  const der = key.export({ format: 'der', type: 'spki' }).toString('base64');
  if (der !== rootPublicKey) fail(403, 'key-mismatch');
  return { publicKey: pem, publicKeyDigest: digestOf(pem), docPublicKeyDigest: digestOf(pem),
    scopePublicKey: der, scopePublicKeyDigest: digestOf(der) };
}

export function createAgentRunScopeDoc({ ledger, signingKey, slots, sourceFactory = createAgentScopeReader } = {}) {
  if (!ledger?.transaction || !ledger?.read || !signingKey || !Array.isArray(slots) || !slots.length)
    fail(503, 'configuration');
  const publicKey = createPublicKey(signingKey).export({ format: 'der', type: 'spki' }).toString('base64');
  const configs = new Map(), sources = new Map(), live = new Map();
  const keyOf = ref => `${ref.rootAuthorityId}:${ref.slotId}`;
  for (const slot of slots) {
    const e = slot.expected, key = keyOf({ rootAuthorityId: e?.authorityId, slotId: e?.slotId });
    if (e?.docAuthorityId !== ledger.authorityId || e.docPublicKey !== publicKey || configs.has(key) ||
        !hash(slot.workerFingerprint256) || typeof slot.workerServiceKid !== 'string' || !slot.workerServiceKid)
      fail(503, 'configuration');
    configs.set(key, slot); sources.set(key, sourceFactory(slot));
  }
  ledger.transaction(s => {
    s.agentRunScopesV1 ??= { required: true, checkpoints: {}, assignments: {} };
    s.agentRunScopesV1.required = true;
  });
  function requireRef(ref) {
    if (!exactScope(ref, refFields) || !Number.isSafeInteger(ref.epoch) || ref.epoch < 1 || !hash(ref.recordDigest) ||
        !configs.has(keyOf(ref))) fail(403, 'reference');
    return keyOf(ref);
  }
  async function refresh(ref) {
    const key = requireRef(ref), checkpoint = ledger.read().agentRunScopesV1.checkpoints[key] ?? null;
    live.delete(key); // Failed/locked refresh must never leave an older allow cached.
    const projection = await sources.get(key).read({ checkpoint });
    if (canonicalJson(agentScopeRef(projection.record)) !== canonicalJson(ref)) fail(403, 'epoch-changed');
    ledger.transaction(s => {
      const old = s.agentRunScopesV1.checkpoints[key];
      if (canonicalJson(old ?? null) !== canonicalJson(checkpoint)) fail(409, 'refresh-race');
      s.agentRunScopesV1.checkpoints[key] = projection.checkpoint;
    });
    live.set(key, copy(projection)); return copy(projection);
  }
  function projectionFor(ref) {
    const value = live.get(requireRef(ref));
    if (!value || canonicalJson(agentScopeRef(value.record)) !== canonicalJson(ref)) fail(503, 'source-unavailable');
    return value;
  }
  function registrationInState(s, { publicKey: requestedKey, rootScopeRef, transport }) {
    const value = projectionFor(rootScopeRef), cfg = configs.get(keyOf(rootScopeRef));
    // Root controller's identity-RPC client cert is NOT the worker Doc client.
    if (transport.serviceId !== 'agent' || transport.serviceKid !== cfg.workerServiceKid ||
        transport.fingerprint256 !== cfg.workerFingerprint256) fail(403, 'worker-transport');
    const mapping = agentScopeKeyMapping(requestedKey, value.record.worker.publicKey);
    if (mapping.scopePublicKeyDigest !== value.record.worker.publicKeyDigest) fail(403, 'key-mismatch');
    const prior = s.agentInstancesV2?.[value.record.instance.instanceId];
    if (value.checkpoint.head.phase !== 'ready' && !(value.checkpoint.head.phase === 'bound' && prior?.state === 'active'))
      fail(403, 'not-ready');
    if (prior && (prior.publicKey !== mapping.publicKey || canonicalJson(prior.rootScopeRef) !== canonicalJson(rootScopeRef)))
      fail(409, 'instance-reused');
    return { rootScopeRef: copy(rootScopeRef), instanceId: value.record.instance.instanceId, ...mapping };
  }
  function assignInState(s, grant) {
    const instance = s.agentInstancesV2?.[grant.instanceId];
    if (!instance?.rootScopeRef || instance.instanceGeneration !== grant.instanceGeneration) fail(403, 'instance-unbound');
    const ref = instance.rootScopeRef, projection = projectionFor(ref), key = `${keyOf(ref)}:${ref.epoch}`;
    const prior = s.agentRunScopesV1.assignments[key];
    if (prior) {
      if (prior.target.runGrantId !== grant.runGrantId) fail(409, 'slot-already-assigned');
      return { rootScopeRef: copy(ref), assignmentDigest: digestOf(prior), phase: 'assigned-unbound' };
    }
    if (projection.checkpoint.head.phase !== 'ready') fail(403, 'not-ready');
    const cfg = configs.get(keyOf(ref));
    const payload = { v: 1, protocol: 'promptcut.agent-run-scope.assignment.v1',
      authorityId: ref.rootAuthorityId, slotId: ref.slotId, epoch: ref.epoch, recordDigest: ref.recordDigest,
      docAuthorityId: ledger.authorityId, target: { ...Object.fromEntries(targetFields.map(k => [k, grant[k]])),
        publicKeyDigest: agentScopeKeyMapping(instance.publicKey, projection.record.worker.publicKey).scopePublicKeyDigest } };
    const assignment = { ...payload, signature: sign(null, Buffer.from(digestOf(payload)), signingKey).toString('base64url') };
    validateAgentScopeAssignment(assignment, cfg.expected, projection.record);
    s.agentRunScopesV1.assignments[key] = assignment;
    return { rootScopeRef: copy(ref), assignmentDigest: digestOf(assignment), phase: 'assigned-unbound' };
  }
  function assignmentInState(s, grant, { requireBound = false } = {}) {
    const ref = grant.scopeBinding?.rootScopeRef;
    if (!ref) fail(403, 'assignment-missing');
    const projection = projectionFor(ref), assignment = s.agentRunScopesV1.assignments[`${keyOf(ref)}:${ref.epoch}`];
    if (!assignment || digestOf(assignment) !== grant.scopeBinding.assignmentDigest ||
        targetFields.some(k => assignment.target[k] !== grant[k])) fail(403, 'assignment-mismatch');
    const phase = projection.checkpoint.head.phase;
    if (phase === 'closed') fail(403, 'already-closed');
    const bound = phase === 'bound' && canonicalJson(projection.assignment) === canonicalJson(assignment);
    if (phase === 'bound' && !bound) fail(403, 'root-assignment-mismatch');
    if (requireBound && !bound) fail(503, 'assignment-not-bound');
    return { assignment: copy(assignment), phase: bound ? 'bound' : 'assigned-unbound', executionAllowed: bound };
  }
  async function synchronize() {
    const state = ledger.read(), refs = Object.values(state.agentInstancesV2 ?? {}).filter(i => i.state === 'active' && i.rootScopeRef)
      .map(i => i.rootScopeRef);
    for (const ref of refs) await refresh(ref);
  }
  return Object.freeze({ refresh, synchronize, registrationInState, assignInState, assignmentInState });
}
