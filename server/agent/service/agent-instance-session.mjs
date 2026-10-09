import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { accountError } from '../../account/client.mjs';
import { canonicalJson, digestOf } from '../../account/ledger.mjs';
import { instanceProofPayload, instanceTlsBinding } from '../../account/agent-instance-authority.mjs';
import { INSTANCE_PROOF_HEADER } from '../../account/agent-instance-internal.mjs';
import { RUN_ASSET_PROOF_HEADER, assetHttpTuple, runAssetIssueRequest } from '../../account/run-asset-protocol.mjs';
import { CONVERSATION_CONTROL_ROOT, conversationControlOperations, conversationControlScope } from '../../account/agent-read-control.mjs';
import { exactScope, validateAgentScopeExpected, validateAgentScopeRecord,
  validateAgentScopeAssignment, validateAgentScopeTerminal } from '../../hosted/agent-run-scope-schema.mjs';

const fail = code => { throw accountError(503, code); };
const reference = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const operations = new Set(['admit', 'confirmRead', 'queryRead', 'checkAccess', 'finish', 'resolveRunPrincipal']);

/** One Agent OS process owns one non-exported Ed25519 private key. The request
 * callback is the same pinned mTLS transport later used for run requests.
 * Registration's requestId/key survive an unknown HTTP ACK in this process. */
export function createAgentInstanceSession({ requestRegistration, scopePrepareSource = null } = {}) {
  if (typeof requestRegistration !== 'function') fail('instance-session-configuration');
  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const scopePublicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const docPublicKeyDigest = digestOf(publicKey), scopePublicKeyDigest = digestOf(scopePublicKey);
  const requestId = `instance-register_${randomUUID()}`;
  let registered = null, challenge = null, inFlight = null, closed = false;
  let registrationScope = null, boundScope = null, prepared = null;
  const signatureOf = value => sign(null, Buffer.from(canonicalJson(value)), pair.privateKey).toString('base64url');
  const scopeSignatureOf = value => sign(null, Buffer.from(digestOf(value)), pair.privateKey).toString('base64url');

  function checkedScope({ expected, record }) {
    const value = { expected: validateAgentScopeExpected(expected), record: validateAgentScopeRecord(record, expected) };
    if (value.record.worker.publicKey !== scopePublicKey || value.record.worker.publicKeyDigest !== scopePublicKeyDigest)
      fail('instance-scope-key');
    return value;
  }
  const rootRefOf = ({ expected, record }) => ({ rootAuthorityId: expected.authorityId,
    slotId: expected.slotId, epoch: record.epoch, recordDigest: digestOf(record) });
  function configureRegistrationScope(input) {
    if (closed) fail('instance-session-closed');
    if (registered || challenge || inFlight) fail('instance-scope-registration-started');
    const value = checkedScope(input);
    if (registrationScope && canonicalJson(value) !== canonicalJson(registrationScope)) fail('instance-scope-binding');
    registrationScope = value;
    return rootRefOf(value);
  }
  function scopeIdentity() {
    if (closed) fail('instance-session-closed');
    // These digest names deliberately distinguish the existing Doc PEM grammar
    // from the root schema's DER grammar. Neither is a transferable capability.
    return { publicKey, docPublicKeyDigest, scopePublicKey, scopePublicKeyDigest,
      identity: registered ? { ...registered } : null };
  }
  function bindScope(input) {
    if (closed) fail('instance-session-closed');
    if (!registered) fail('instance-not-registered');
    const value = checkedScope(input);
    const assignment = validateAgentScopeAssignment(input.assignment, value.expected, value.record);
    if (registered.authorityId !== value.expected.docAuthorityId ||
        ['serviceId', 'serviceKid', 'instanceId', 'instanceGeneration'].some(k => registered[k] !== assignment.target[k]) ||
        (registrationScope && canonicalJson(value) !== canonicalJson(registrationScope))) fail('instance-scope-binding');
    const next = { ...value, assignment };
    if (boundScope && canonicalJson(next) !== canonicalJson(boundScope)) fail('instance-scope-binding');
    boundScope ??= next;
    return { assignmentDigest: digestOf(assignment) };
  }
  async function scopePrepareFor(input) {
    if (closed) fail('instance-session-closed');
    if (!registered || !boundScope) fail('instance-scope-unbound');
    const value = structuredClone(input), scope = boundScope;
    const expectedScope = { authorityId: scope.expected.authorityId, slotId: scope.expected.slotId,
      epoch: scope.record.epoch, recordDigest: digestOf(scope.record), assignmentDigest: digestOf(scope.assignment) };
    if (!exactScope(value, ['v', 'domain', 'scope', 'target', 'readReceiptId', 'finishReceiptId', 'outcomeDigest',
      'eventId', 'eventDigest', 'drainReceiptId', 'docControlId', 'docFenceRevision']) || value.v !== 1 ||
        value.domain !== 'promptcut.agent-run.prepare.v1' || canonicalJson(value.scope) !== canonicalJson(expectedScope) ||
        canonicalJson(value.target) !== canonicalJson(scope.assignment.target) ||
        ['readReceiptId', 'finishReceiptId', 'eventId', 'drainReceiptId', 'docControlId'].some(k => !reference(value[k])) ||
        ['outcomeDigest', 'eventDigest'].some(k => !/^[a-f0-9]{64}$/.test(value[k])) ||
        !Number.isSafeInteger(value.docFenceRevision) || value.docFenceRevision < 0) fail('instance-scope-prepare');
    const { signature: _signature, ...prior } = prepared ?? {};
    if (prepared) {
      if (canonicalJson(prior) !== canonicalJson(value)) fail('instance-scope-prepare-conflict');
      return structuredClone(prepared);
    }
    if (typeof scopePrepareSource !== 'function') fail('instance-scope-prepare-unavailable');
    // The private source must read durable events/drain evidence. A network body
    // alone can never authorize this signer; failure is propagated to its owner.
    const observed = await scopePrepareSource(structuredClone(value));
    if (closed) fail('instance-session-closed');
    if (boundScope !== scope || canonicalJson(observed) !== canonicalJson(value)) fail('instance-scope-prepare-source');
    if (prepared) {
      const { signature: _otherSignature, ...other } = prepared;
      if (canonicalJson(other) !== canonicalJson(value)) fail('instance-scope-prepare-conflict');
    } else prepared = { ...value, signature: scopeSignatureOf(value) };
    return structuredClone(prepared);
  }
  function scopeIntentFor({ assignment, terminal }) {
    if (closed) fail('instance-session-closed');
    if (!registered || !boundScope || !prepared) fail('instance-scope-prepare-unavailable');
    if (canonicalJson(assignment) !== canonicalJson(boundScope.assignment) ||
        terminal?.finish?.readReceiptId !== prepared.readReceiptId || terminal?.finish?.finishReceiptId !== prepared.finishReceiptId ||
        terminal?.finish?.outcomeDigest !== prepared.outcomeDigest || terminal?.finish?.terminalReceiptDigest !== digestOf(prepared))
      fail('instance-scope-terminal');
    const payload = { v: 1, protocol: 'promptcut.agent-run-scope.intent.v1',
      assignmentDigest: digestOf(assignment), terminalDigest: digestOf(terminal) };
    const intent = { ...payload, signature: scopeSignatureOf(payload) };
    validateAgentScopeTerminal(terminal, intent, boundScope.expected, boundScope.record, boundScope.assignment);
    return intent;
  }

  async function register() {
    if (closed) fail('instance-session-closed');
    if (registered) return { ...registered };
    if (!inFlight) {
      inFlight = (async () => {
        const rootScopeRef = registrationScope ? rootRefOf(registrationScope) : null;
        const current = await requestRegistration('challenge', { requestId, publicKey,
          ...(rootScopeRef ? { rootScopeRef } : {}) });
        if (!current || current.domain !== 'promptcut.agent-instance.register.v1' ||
            current.requestId !== requestId || current.serviceId !== 'agent' ||
            !reference(current.authorityId) || !reference(current.serviceKid) ||
            current.publicKeyDigest !== digestOf(publicKey) || !reference(current.challengeId) ||
            !reference(current.nonce) || (challenge && canonicalJson(challenge) !== canonicalJson(current)))
          fail('instance-challenge-protocol');
        if (rootScopeRef && (canonicalJson(current.rootScopeRef) !== canonicalJson(rootScopeRef) ||
            current.docPublicKeyDigest !== docPublicKeyDigest || current.scopePublicKeyDigest !== scopePublicKeyDigest ||
            current.authorityId !== registrationScope.expected.docAuthorityId)) fail('instance-challenge-scope');
        challenge = current;
        const result = await requestRegistration('register', { challenge, signature: signatureOf(challenge) });
        if (!result || result.authorityId !== challenge.authorityId || result.serviceId !== 'agent' ||
            result.serviceKid !== challenge.serviceKid || !reference(result.instanceId) ||
            !Number.isSafeInteger(result.instanceGeneration) || result.instanceGeneration < 1)
          fail('instance-register-protocol');
        if (rootScopeRef && (canonicalJson(result.rootScopeRef) !== canonicalJson(rootScopeRef) ||
            result.instanceId !== registrationScope.record.instance.instanceId)) fail('instance-register-scope');
        if (closed) fail('instance-session-closed');
        registered = Object.freeze({ authorityId: result.authorityId, serviceId: 'agent',
          serviceKid: result.serviceKid, instanceId: result.instanceId, instanceGeneration: result.instanceGeneration });
        return { ...registered };
      })().finally(() => { inFlight = null; });
    }
    return inFlight;
  }

  function proofFor({ socket, method, path, operation, body }) {
    if (closed || !registered) fail('instance-not-registered');
    if (method !== 'POST' || typeof path !== 'string' || !path.startsWith('/internal/v2/runs/') ||
        !operations.has(operation) || !body || typeof body !== 'object' || Array.isArray(body) ||
        (operation === 'checkAccess' && !['read', 'write'].includes(body.action)))
      fail('instance-proof-input');
    const payload = instanceProofPayload({ ...registered, channelBinding: instanceTlsBinding(socket),
      method, path, operation, requestDigest: digestOf(body) });
    const proof = { instanceId: registered.instanceId, instanceGeneration: registered.instanceGeneration,
      signature: signatureOf(payload) };
    return { name: INSTANCE_PROOF_HEADER, value: Buffer.from(JSON.stringify(proof)).toString('base64url') };
  }

  function dataProofFor({ socket, method, path, operation, request }) {
    if (closed || !registered) fail('instance-not-registered');
    if (!['GET', 'POST', 'WS'].includes(method) || (path !== '/' && !/^\/lp\/(open|send|recv|close)$/.test(path)) ||
        !['resolveRunPrincipal', 'checkAccess', 'authorizeQuery'].includes(operation) ||
        !request || typeof request !== 'object' || Array.isArray(request) ||
        (operation === 'checkAccess' && !['read', 'write'].includes(request.action)))
      fail('instance-data-proof-input');
    const payload = instanceProofPayload({ ...registered, channelBinding: instanceTlsBinding(socket),
      method, path, operation, requestDigest: digestOf(request) });
    return { operation, instanceId: registered.instanceId, instanceGeneration: registered.instanceGeneration,
      signature: signatureOf(payload), ...(operation === 'checkAccess' ? { action: request.action } : {}) };
  }

  function runAssetIssueProofFor({ socket, body, bodyText }) {
    if (closed || !registered) fail('instance-not-registered');
    const request = runAssetIssueRequest({ body, bodyText });
    const payload = instanceProofPayload({ ...registered, channelBinding: instanceTlsBinding(socket),
      method: 'POST', path: '/internal/v2/run-assets/issue', operation: 'checkAccess',
      requestDigest: digestOf(request) });
    return { name: INSTANCE_PROOF_HEADER, value: Buffer.from(JSON.stringify({
      instanceId: registered.instanceId, instanceGeneration: registered.instanceGeneration,
      signature: signatureOf(payload),
    })).toString('base64url') };
  }

  function runAssetHttpProofFor({ socket, tuple }) {
    if (closed || !registered) fail('instance-not-registered');
    const request = assetHttpTuple(tuple);
    const payload = instanceProofPayload({ ...registered, channelBinding: instanceTlsBinding(socket),
      method: request.method, path: request.url, operation: 'checkAccess',
      requestDigest: digestOf(request) });
    return { name: RUN_ASSET_PROOF_HEADER, value: Buffer.from(JSON.stringify({
      instanceId: registered.instanceId, instanceGeneration: registered.instanceGeneration,
      signature: signatureOf(payload),
    })).toString('base64url') };
  }

  function conversationControlProofFor({ socket, path, operation, body }) {
    if (closed || !registered) fail('instance-not-registered');
    const action = Object.keys(conversationControlOperations).find(key => conversationControlOperations[key] === operation);
    if (!action || path !== CONVERSATION_CONTROL_ROOT + action) fail('instance-proof-input');
    conversationControlScope(operation, body);
    const payload = instanceProofPayload({ ...registered, channelBinding: instanceTlsBinding(socket),
      method: 'POST', path, operation, requestDigest: digestOf(body) });
    return { name: INSTANCE_PROOF_HEADER, value: Buffer.from(JSON.stringify({ instanceId: registered.instanceId,
      instanceGeneration: registered.instanceGeneration, signature: signatureOf(payload) })).toString('base64url') };
  }
  return { register, proofFor, dataProofFor, runAssetIssueProofFor, runAssetHttpProofFor, conversationControlProofFor,
    scopeIdentity, configureRegistrationScope, bindScope, scopePrepareFor, scopeIntentFor,
    identity: () => registered ? { ...registered } : null,
    close() { closed = true; registered = null; challenge = null; boundScope = null; prepared = null; registrationScope = null; } };
}
