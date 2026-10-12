import { randomUUID } from 'node:crypto';
import { accountError, certificateFingerprint } from '../account/client.mjs';
import { instanceTlsBinding } from '../account/agent-instance-authority.mjs';
import { exactShape, hashOf, reference } from '../account/run-asset-protocol.mjs';

const fail = (status, code) => { throw accountError(status, code); };
const observationFields = ['assetInstanceId', 'assetServiceIdentity', 'assetLeaseId', 'agentFingerprint256',
  'agentServiceKid', 'authenticationId', 'channelBinding', 'open'];

/** A private bridge from the current asset mTLS observer to the ONE doc instance authority.
 * The asset attests the Agent's real TLS exporter; only the Agent RAM key can sign it.
 * The supplied registry lookup must force the CURRENT asset instance on every call. */
export function createRunAssetsInstanceAdapter({ agentFingerprint256, agentServiceKid, assetFingerprint256,
  currentAgent, currentAsset } = {}) {
  const agentPin = certificateFingerprint(agentFingerprint256);
  const assetPin = certificateFingerprint(assetFingerprint256);
  if (![agentPin, assetPin].every(hashOf) || agentPin === assetPin || !reference(agentServiceKid) ||
      typeof currentAgent !== 'function' || typeof currentAsset !== 'function') fail(503, 'run-assets-instance-unconfigured');
  const live = new Map(), bySocket = new Map();
  let closed = false;
  const requireOpen = () => { if (closed) fail(503, 'run-assets-instance-unavailable'); };
  function current(observer) {
    requireOpen();
    const socket = observer?.socket;
    if (!socket?.encrypted || socket.authorized !== true || socket.destroyed ||
        certificateFingerprint(socket.getPeerCertificate?.()?.fingerprint256) !== assetPin)
      fail(403, 'asset-observer-forbidden');
    instanceTlsBinding(socket);
    const actual = currentAsset({ socket });
    if (actual?.then || !exactShape(actual, ['assetInstanceId', 'serviceIdentity']) ||
        !reference(actual.assetInstanceId) || !reference(actual.serviceIdentity) ||
        (observer.assetInstanceId !== undefined && observer.assetInstanceId !== actual.assetInstanceId) ||
        (observer.serviceIdentity !== undefined && observer.serviceIdentity !== actual.serviceIdentity))
      fail(403, 'asset-observer-forbidden');
    return { socket, assetInstanceId: actual.assetInstanceId, serviceIdentity: actual.serviceIdentity };
  }
  function currentAgentService() {
    requireOpen();
    const value = currentAgent();
    if (value?.then || value?.serviceId !== 'agent' || value.serviceKid !== agentServiceKid)
      fail(403, 'run-service-forbidden');
    return value;
  }
  function drop(id) {
    const record = live.get(id); if (!record) return;
    live.delete(id);
    const entry = bySocket.get(record.socket); entry?.ids.delete(id);
    if (entry?.ids.size === 0) { record.socket.removeListener('close', entry.onClose); bySocket.delete(record.socket); }
  }
  function open({ observer, observation }) {
    const asset = current(observer); currentAgentService();
    if (!exactShape(observation, observationFields) || observation.open !== true ||
        observation.assetInstanceId !== asset.assetInstanceId ||
        observation.assetServiceIdentity !== asset.serviceIdentity ||
        certificateFingerprint(observation.agentFingerprint256) !== agentPin ||
        observation.agentServiceKid !== agentServiceKid ||
        ![observation.assetLeaseId, observation.authenticationId].every(reference) ||
        !hashOf(observation.channelBinding)) fail(403, 'asset-observer-forbidden');
    const id = `asset-observed:${randomUUID()}`;
    live.set(id, { socket: asset.socket, assetInstanceId: asset.assetInstanceId,
      serviceIdentity: asset.serviceIdentity, channelBinding: observation.channelBinding });
    let entry = bySocket.get(asset.socket);
    if (!entry) {
      entry = { ids: new Set(), onClose: null };
      entry.onClose = () => { for (const currentId of [...entry.ids]) drop(currentId); };
      bySocket.set(asset.socket, entry); asset.socket.once('close', entry.onClose);
    }
    entry.ids.add(id);
    return { servicePrincipal: { service: 'agent', serviceKid: agentServiceKid, authenticationId: id },
      release: () => drop(id) };
  }
  function transportFor(subject) {
    const record = live.get(subject?.authenticationId);
    if (!record || subject.service !== 'agent' || subject.serviceKid !== agentServiceKid)
      fail(403, 'run-service-forbidden');
    current({ socket: record.socket, assetInstanceId: record.assetInstanceId,
      serviceIdentity: record.serviceIdentity });
    currentAgentService();
    return { serviceId: 'agent', serviceKid: agentServiceKid,
      authenticationId: subject.authenticationId, channelBinding: record.channelBinding };
  }
  return Object.freeze({ verifyObserver: current, open, transportFor,
    has: subject => live.has(subject?.authenticationId),
    close() { closed = true; for (const id of [...live.keys()]) drop(id); } });
}
