import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { accountError } from '../../account/client.mjs';
import { canonicalJson, digestOf } from '../../account/ledger.mjs';
import { instanceProofPayload, instanceTlsBinding } from '../../account/agent-instance-authority.mjs';
import { INSTANCE_PROOF_HEADER } from '../../account/agent-instance-internal.mjs';
import { RUN_ASSET_PROOF_HEADER, assetHttpTuple, runAssetIssueRequest } from '../../account/run-asset-protocol.mjs';

const fail = code => { throw accountError(503, code); };
const reference = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const operations = new Set(['admit', 'confirmRead', 'queryRead', 'checkAccess', 'finish', 'resolveRunPrincipal']);

/** One Agent OS process owns one non-exported Ed25519 private key. The request
 * callback is the same pinned mTLS transport later used for run requests.
 * Registration's requestId/key survive an unknown HTTP ACK in this process. */
export function createAgentInstanceSession({ requestRegistration } = {}) {
  if (typeof requestRegistration !== 'function') fail('instance-session-configuration');
  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const requestId = `instance-register_${randomUUID()}`;
  let registered = null, challenge = null, inFlight = null, closed = false;
  const signatureOf = value => sign(null, Buffer.from(canonicalJson(value)), pair.privateKey).toString('base64url');

  async function register() {
    if (closed) fail('instance-session-closed');
    if (registered) return { ...registered };
    if (!inFlight) {
      inFlight = (async () => {
        const current = await requestRegistration('challenge', { requestId, publicKey });
        if (!current || current.domain !== 'promptcut.agent-instance.register.v1' ||
            current.requestId !== requestId || current.serviceId !== 'agent' ||
            !reference(current.authorityId) || !reference(current.serviceKid) ||
            current.publicKeyDigest !== digestOf(publicKey) || !reference(current.challengeId) ||
            !reference(current.nonce) || (challenge && canonicalJson(challenge) !== canonicalJson(current)))
          fail('instance-challenge-protocol');
        challenge = current;
        const result = await requestRegistration('register', { challenge, signature: signatureOf(challenge) });
        if (!result || result.authorityId !== challenge.authorityId || result.serviceId !== 'agent' ||
            result.serviceKid !== challenge.serviceKid || !reference(result.instanceId) ||
            !Number.isSafeInteger(result.instanceGeneration) || result.instanceGeneration < 1)
          fail('instance-register-protocol');
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

  return { register, proofFor, dataProofFor, runAssetIssueProofFor, runAssetHttpProofFor,
    identity: () => registered ? { ...registered } : null,
    close() { closed = true; registered = null; challenge = null; } };
}
