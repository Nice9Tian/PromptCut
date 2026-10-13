import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { canonicalJson, digestOf } from './ledger.mjs';
import { accountError } from './client.mjs';
import { conversationControlOperations, conversationControlScope } from './agent-read-control.mjs';

const deny = (status, code) => { throw accountError(status, code); };
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const generation = value => Number.isSafeInteger(value) && value > 0;
const clone = value => structuredClone(value);
export const INSTANCE_EXPORTER_LABEL = 'EXPORTER-PromptCut-Agent-Instance-v1';
export const INSTANCE_PROOF_DOMAIN = 'promptcut.agent-instance.request.v1';
const tables = state => {
  state.agentInstancesV2 ??= {}; state.agentRegistrationsV2 ??= {};
  state.agentInstanceFencesV2 ??= {};
};

/** Called with the real, already peer-authenticated socket, never a header value.
 * The registry/pinned-certificate owner still verifies the current service key.
 */
export function instanceTlsBinding(socket) {
  if (!socket?.encrypted || socket.authorized !== true || socket.destroyed ||
      typeof socket.exportKeyingMaterial !== 'function') deny(503, 'instance-transport-unavailable');
  try {
    const material = socket.exportKeyingMaterial(32, INSTANCE_EXPORTER_LABEL);
    if (material.length !== 32) deny(503, 'instance-transport-unavailable');
    return createHash('sha256').update(material).digest('hex');
  } catch { deny(503, 'instance-transport-unavailable'); }
}

/** Public deterministic signing input. Only a trusted transport adapter supplies
 * binding/current service identity; receiving this object from a body is unsafe.
 */
export function instanceProofPayload({ authorityId, instanceId, instanceGeneration,
  serviceId, serviceKid, channelBinding, method, path, operation, requestDigest }) {
  return { domain: INSTANCE_PROOF_DOMAIN, authorityId, instanceId, instanceGeneration,
    serviceId, serviceKid, channelBinding, method, path, operation, requestDigest };
}

// API scopes contain only the authority inputs. Derived actor fields are rebuilt
// from the grant; a caller cannot enlarge an invocation by adding body identity.
export function instanceRunScope(operation, input) {
  if (Object.values(conversationControlOperations).includes(operation)) return conversationControlScope(operation, input);
  if (operation === 'pendingRuns') return { operation };
  if (operation === 'workerEventSource') return { operation, projectId: input.projectId,
    runGrantId: input.runGrantId, assignmentDigest: input.assignmentDigest };
  if (operation === 'scopeControl') return { operation, projectId: input.projectId, controlId: input.controlId,
    runGrantId: input.runGrantId, assignmentDigest: input.assignmentDigest, rootScopeRef: input.rootScopeRef };
  const p = input?.principal ?? input ?? {};
  const target = { projectId: input?.projectId, runGrantId: input?.runGrantId ?? p.runGrantId };
  if (operation === 'admit') return { operation, projectId: input.projectId,
    conversationId: input.conversationId, requestId: input.requestId };
  if (['resolveRunPrincipal', 'authorizeQuery'].includes(operation)) return { operation, ...target };
  if (operation === 'checkAccess') return { operation, ...target, action: input.action };
  if (['confirmRead', 'queryRead', 'finish', 'queryFinish', 'scopeAssignment', 'scopePrepare', 'scopeTerminal'].includes(operation)) {
    const value = { operation, ...Object.fromEntries(['projectId', 'conversationId', 'messageId', 'runId',
      'runGrantId', 'requestId'].map(key => [key, input[key]])) };
    if (['confirmRead', 'queryRead'].includes(operation)) Object.assign(value, { readIntentId: input.readIntentId, promptDigest: input.promptDigest });
    if (['finish', 'queryFinish'].includes(operation) && ('outcome' in input || 'readReceiptId' in input))
      Object.assign(value, { outcome: input.outcome, readReceiptId: input.readReceiptId });
    if (['scopePrepare', 'scopeTerminal'].includes(operation)) value.finishReceiptId = input.finishReceiptId;
    if (operation === 'scopePrepare') value.prepare = input.prepare;
    return value;
  }
  deny(403, 'instance-operation-forbidden');
}

function publicKey(value) {
  try {
    const key = createPublicKey(value);
    if (key.asymmetricKeyType !== 'ed25519') deny(400, 'instance-key-invalid');
    return key.export({ type: 'spki', format: 'pem' }).toString();
  } catch { deny(400, 'instance-key-invalid'); }
}
function signed(payload, signature, key) {
  try {
    if (typeof signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
    return verify(null, Buffer.from(canonicalJson(payload)), key, Buffer.from(signature, 'base64url'));
  } catch { return false; }
}

/** A registration is persistent; an invocation capability is RAM-only and never
 * sent to Agent. An Agent process keeps its private key exclusively in memory.
 * This proves key possession on the live TLS channel, not OS/cgroup closure.
 */
export function createAgentInstanceAuthority({ ledger, verifyTransportInState,
  verifyClosureWitnessInState, scopeAuthority, failpoint = () => {} } = {}) {
  if (!ledger?.transaction || !ledger?.read || typeof verifyTransportInState !== 'function')
    deny(503, 'instance-authority-configuration');
  const invocations = new Map();
  function transport(state, principal) {
    const v = verifyTransportInState(state, principal);
    if (v?.then || v?.serviceId !== 'agent' || !text(v?.serviceKid) || !text(v?.authenticationId) ||
        !/^[a-f0-9]{64}$/.test(v?.channelBinding ?? '')) deny(403, 'instance-transport-forbidden');
    return v;
  }
  function record(state, id, gen) {
    const value = state.agentInstancesV2?.[id];
    if (!value || !generation(gen) || value.instanceGeneration !== gen) deny(403, 'instance-binding-mismatch');
    return value;
  }
  function current(state, id, gen, svc) {
    const value = record(state, id, gen);
    if (value.state !== 'active') deny(403, 'instance-revoked');
    if (value.serviceId !== svc.serviceId || value.serviceKid !== svc.serviceKid) deny(403, 'instance-service-mismatch');
    return value;
  }
  function beginRegistration({ servicePrincipal, requestId, publicKey: requestedKey, rootScopeRef }) {
    if (!text(requestId)) deny(400, 'instance-request-invalid');
    const key = publicKey(requestedKey);
    const begin = () => ledger.transaction(state => {
      tables(state); const svc = transport(state, servicePrincipal);
      if ((rootScopeRef || state.agentRunScopesV1?.required) && !scopeAuthority) deny(503, 'instance-scope-unavailable');
      const scoped = scopeAuthority ? scopeAuthority.registrationInState(state, { publicKey: key, rootScopeRef, transport: svc }) : null;
      const id = digestOf({ serviceId: svc.serviceId, serviceKid: svc.serviceKid, requestId });
      const old = state.agentRegistrationsV2[id];
      if (old) {
        if (old.publicKey !== key || canonicalJson(old.challenge.rootScopeRef ?? null) !== canonicalJson(rootScopeRef ?? null)) deny(409, 'instance-registration-mismatch');
        return clone(old.challenge);
      }
      const challenge = { domain: 'promptcut.agent-instance.register.v1', authorityId: ledger.authorityId,
        serviceId: svc.serviceId, serviceKid: svc.serviceKid, requestId, challengeId: `instance-challenge_${randomUUID()}`,
        nonce: randomUUID(), publicKeyDigest: digestOf(key), ...(scoped ? { purpose: scoped.purpose } : {}), ...(scoped?.purpose === 'run-worker' ? {
          rootScopeRef: scoped.rootScopeRef, docPublicKeyDigest: scoped.docPublicKeyDigest,
          scopePublicKeyDigest: scoped.scopePublicKeyDigest } : {}) };
      state.agentRegistrationsV2[id] = { publicKey: key, challenge, result: null };
      failpoint('instance-challenge-before-commit'); return clone(challenge);
    });
    return scopeAuthority ? scopeAuthority.prepareRegistration({ rootScopeRef,
      transport: transport(ledger.read(), servicePrincipal) }).then(begin) : begin();
  }
  function register({ servicePrincipal, challenge, signature }) {
    const commit = () => { const result = ledger.transaction(state => {
      tables(state); const svc = transport(state, servicePrincipal);
      const id = digestOf({ serviceId: svc.serviceId, serviceKid: svc.serviceKid, requestId: challenge?.requestId });
      const registration = state.agentRegistrationsV2[id];
      if (!registration || canonicalJson(registration.challenge) !== canonicalJson(challenge) ||
          !signed(registration.challenge, signature, registration.publicKey)) deny(403, 'instance-registration-unverified');
      if ((challenge.rootScopeRef || state.agentRunScopesV1?.required) && !scopeAuthority) deny(503, 'instance-scope-unavailable');
      if (registration.result) return clone(registration.result);
      const scoped = scopeAuthority ? scopeAuthority.registrationInState(state, {
        publicKey: registration.publicKey, rootScopeRef: challenge.rootScopeRef, transport: svc }) : null;
      if (scoped?.instanceId && state.agentInstancesV2[scoped.instanceId]) deny(409, 'instance-already-registered');
      const next = (state.agentInstanceGenerationV2 ?? 0) + 1;
      if (!generation(next)) deny(503, 'instance-generation-overflow');
      const value = { v: 2, instanceId: scoped?.instanceId ?? `instance_${randomUUID()}`, instanceGeneration: next,
        serviceId: svc.serviceId, serviceKid: svc.serviceKid, publicKey: registration.publicKey,
        registrationId: id, state: 'active', closure: null, ...(scoped ? { purpose: scoped.purpose } : {}), ...(scoped?.purpose === 'run-worker' ? { rootScopeRef: scoped.rootScopeRef,
          docPublicKeyDigest: scoped.docPublicKeyDigest, scopePublicKeyDigest: scoped.scopePublicKeyDigest } : {}) };
      state.agentInstanceGenerationV2 = next; state.agentInstancesV2[value.instanceId] = value;
      registration.result = { instanceId: value.instanceId, instanceGeneration: next,
        authorityId: ledger.authorityId, serviceId: svc.serviceId, serviceKid: svc.serviceKid,
        ...(scoped ? { purpose: scoped.purpose } : {}), ...(scoped?.purpose === 'run-worker' ? { rootScopeRef: scoped.rootScopeRef } : {}) };
      failpoint('instance-register-before-commit'); return clone(registration.result);
    });
    failpoint('instance-register-after-commit'); return result; };
    return scopeAuthority ? scopeAuthority.prepareRegistration({ rootScopeRef: challenge?.rootScopeRef,
      transport: transport(ledger.read(), servicePrincipal) }).then(commit) : commit();
  }
  function authenticate({ servicePrincipal, method, path, operation, request, proof }) {
    if (!text(method) || method !== method.toUpperCase() || !text(path) || !path.startsWith('/'))
      deny(400, 'instance-request-invalid');
    const state = ledger.read(), svc = transport(state, servicePrincipal);
    const instance = current(state, proof?.instanceId, proof?.instanceGeneration, svc);
    if (instance.purpose === 'control-only' && ![...Object.values(conversationControlOperations), 'pendingRuns', 'workerEventSource', 'scopeControl'].includes(operation))
      deny(403, 'instance-purpose-forbidden');
    const payload = instanceProofPayload({ authorityId: ledger.authorityId, ...instance,
      channelBinding: svc.channelBinding, method, path, operation, requestDigest: digestOf(request) });
    if (!signed(payload, proof?.signature, instance.publicKey)) deny(403, 'instance-proof-invalid');
    const scopeDigest = digestOf(instanceRunScope(operation, request));
    const instanceSession = `instance-invocation_${randomUUID()}`;
    invocations.set(instanceSession, { instanceId: instance.instanceId, instanceGeneration: instance.instanceGeneration,
      serviceId: svc.serviceId, serviceKid: svc.serviceKid, authenticationId: svc.authenticationId,
      channelBinding: svc.channelBinding, method, path, requestDigest: digestOf(request), operation, scopeDigest });
    // Internal capability: adapter must not serialize this in an HTTP response.
    return { instanceSession, instanceId: instance.instanceId, instanceGeneration: instance.instanceGeneration };
  }
  function verifyInState(state, principal, { operation, input }) {
    const svc = transport(state, principal), cap = invocations.get(principal?.instanceSession);
    if (!cap || cap.authenticationId !== svc.authenticationId || cap.channelBinding !== svc.channelBinding ||
        cap.serviceId !== svc.serviceId || cap.serviceKid !== svc.serviceKid || cap.operation !== operation ||
        principal.instanceId !== cap.instanceId || principal.instanceGeneration !== cap.instanceGeneration ||
        cap.scopeDigest !== digestOf(instanceRunScope(operation, input))) deny(403, 'instance-invocation-forbidden');
    const value = current(state, cap.instanceId, cap.instanceGeneration, svc);
    return { serviceId: svc.serviceId, serviceKid: svc.serviceKid,
      instanceId: value.instanceId, instanceGeneration: value.instanceGeneration };
  }
  function fenceInState(state, { instanceId, instanceGeneration, requestId, reason }) {
    tables(state); if (!text(requestId) || !text(reason)) deny(400, 'instance-fence-invalid');
    const value = record(state, instanceId, instanceGeneration);
    const id = digestOf({ instanceId, instanceGeneration, requestId }), digest = digestOf({ reason });
    const prior = state.agentInstanceFencesV2[id];
    if (prior) { if (prior.digest !== digest) deny(409, 'instance-fence-mismatch'); return clone(prior); }
    if (value.state === 'active') value.state = 'fenced';
    const result = { instanceId, instanceGeneration, requestId, reason, digest, state: 'pending' };
    state.agentInstanceFencesV2[id] = result; return clone(result);
  }
  function confirmClosed({ instanceId, instanceGeneration, witness }) {
    if (typeof verifyClosureWitnessInState !== 'function') deny(503, 'instance-closure-verifier-unavailable');
    return ledger.transaction(state => {
      const value = record(state, instanceId, instanceGeneration);
      if (value.state === 'active') deny(403, 'instance-not-fenced');
      if (value.closure) {
        if (canonicalJson(value.closure) !== canonicalJson(witness)) deny(409, 'instance-closure-mismatch');
        return clone(value);
      }
      if (witness?.instanceId !== instanceId || witness?.instanceGeneration !== instanceGeneration ||
          witness?.complete !== true || !text(witness?.witnessId) ||
          verifyClosureWitnessInState(state, clone(value), clone(witness)) !== true) deny(403, 'instance-closure-unverified');
      value.closure = clone(witness); value.state = 'closed'; return clone(value);
    });
  }
  return { beginRegistration, register, authenticate, verifyInState, fenceInState, confirmClosed,
    release: instanceSession => invocations.delete(instanceSession),
    close: () => invocations.clear() };
}
