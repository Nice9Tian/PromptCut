/** Doc callbacks for A's live lease/control ACKs. A legacy instance or missing
 * independent asset witness leaves the durable doc lease pending. */
import { accountError } from '../account/client.mjs';
import { digestOf } from '../account/ledger.mjs';
import { reference } from '../account/run-asset-protocol.mjs';

const fail = () => { throw accountError(503, 'asset-resource-closure-pending'); };
const same = (left, right) => {
  if (left === undefined || right === undefined) return false;
  try { return digestOf(left) === digestOf(right); } catch { return false; }
};

export function createRunAssetClosure({ privateClient, currentAsset } = {}) {
  if (typeof privateClient?.identity !== 'function' || typeof privateClient?.closureWitness !== 'function' ||
      typeof privateClient?.controlWitness !== 'function' || typeof currentAsset !== 'function') fail();
  const current = observer => {
    const value = currentAsset({ socket: observer?.socket });
    if (value?.then || !reference(value?.assetInstanceId) || !reference(value.serviceIdentity) ||
        observer?.assetInstanceId !== value.assetInstanceId || observer.serviceIdentity !== value.serviceIdentity ||
        observer.socket?.destroyed) fail();
    return value;
  };
  const verifyIdentity = async observer => {
    const registered = current(observer), actual = await privateClient.identity();
    if (actual.instanceId !== registered.assetInstanceId || actual.serviceIdentity !== registered.serviceIdentity ||
        actual.state !== 'running') fail();
    current(observer); return registered;
  };
  return Object.freeze({
    async verifyLeaseClosure({ observer, lease, receipt } = {}) {
      const before = await verifyIdentity(observer);
      if (!reference(lease?.leaseId)) fail();
      const witness = await privateClient.closureWitness(lease.leaseId);
      if (witness.assetInstanceId !== before.assetInstanceId || witness.serviceIdentity !== before.serviceIdentity ||
          !same(witness.receipt, receipt) ||
          !same(witness.binding, { projectId: lease.resource?.projectId,
            runGrantId: lease.grantBinding?.runGrantId,
            instanceId: lease.grantBinding?.instanceId,
            instanceGeneration: lease.grantBinding?.instanceGeneration })) fail();
      await verifyIdentity(observer);
      return true;
    },
    async verifyControlReceipt({ observer, event, receipt } = {}) {
      const before = await verifyIdentity(observer);
      if (!reference(event?.eventId)) fail();
      const witness = await privateClient.controlWitness(event.eventId);
      if (witness.assetInstanceId !== before.assetInstanceId || witness.serviceIdentity !== before.serviceIdentity ||
          !same(witness.receipt, receipt)) fail();
      await verifyIdentity(observer);
      return true;
    },
  });
}
