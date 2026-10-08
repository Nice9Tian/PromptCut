import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import { canonicalJson, digestOf } from '../account/ledger.mjs';
import { createAgentInstanceAuthority, instanceProofPayload } from '../account/agent-instance-authority.mjs';

export const signInstance = (key, payload) => sign(null, Buffer.from(canonicalJson(payload)), key).toString('base64url');
/** Controlled transport only. The actual TLSSocket test separately proves channel
 * binding; this fixture does not claim that arbitrary strings attest an OS PID.
 */
export function instanceFixture(ledger, { verifyServiceInState, failpoint, verifyClosureWitnessInState } = {}) {
  const channels = new Map();
  const verifyTransportInState = (state, principal) => {
    const identity = verifyServiceInState?.(state, principal) ?? { serviceId: 'agent', serviceKid: 'agent-test-key' };
    const channel = channels.get(principal?.authenticationId);
    if (!channel?.open) throw new Error('instance-transport-closed');
    return { ...identity, authenticationId: principal.authenticationId, channelBinding: channel.binding };
  };
  let authority = createAgentInstanceAuthority({ ledger, verifyTransportInState, failpoint, verifyClosureWitnessInState });
  function connection(fields = {}) {
    const authenticationId = randomUUID(); channels.set(authenticationId, { open: true, binding: digestOf(randomUUID()) });
    return { service: 'agent', scope: 'service', serviceKid: 'agent-test-key', authenticated: true, ...fields, authenticationId };
  }
  function boot({ principal = connection(), requestId = randomUUID(), keys = generateKeyPairSync('ed25519') } = {}) {
    const challenge = authority.beginRegistration({ servicePrincipal: principal, requestId,
      publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() });
    const args = { servicePrincipal: principal, challenge, signature: signInstance(keys.privateKey, challenge) };
    const registration = authority.register(args);
    return { principal, keys, registration, registerArgs: args };
  }
  function authorize(process, operation, request, { principal = process.principal, method = 'POST', path = `/internal/v2/runs/${operation}` } = {}) {
    const svc = verifyTransportInState(ledger.read(), principal);
    const payload = instanceProofPayload({ authorityId: ledger.authorityId, ...process.registration, ...svc,
      method, path, operation, requestDigest: digestOf(request) });
    const proof = { ...process.registration, signature: signInstance(process.keys.privateKey, payload) };
    const args = { servicePrincipal: principal, method, path, operation, request, proof };
    return { principal: { ...principal, ...authority.authenticate(args) }, args, payload };
  }
  return { get authority() { return authority; }, boot, authorize, connection,
    disconnect(principal) { channels.get(principal.authenticationId).open = false; },
    restart() { authority.close(); authority = createAgentInstanceAuthority({ ledger, verifyTransportInState, failpoint, verifyClosureWitnessInState }); },
    close() { authority.close(); channels.clear(); } };
}
