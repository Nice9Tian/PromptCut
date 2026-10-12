/** Doc authority for one original asset→doc TLS channel. A later identity
 * query over another socket can never label this socket as a new OS instance. */
import { randomBytes } from 'node:crypto';
import { accountError, certificateFingerprint } from '../account/client.mjs';
import { digestOf } from '../account/ledger.mjs';
import { assetObserverExporterDigest, verifyAssetObserverSocket } from './run-assets-observer-binding.mjs';

const fail = () => { throw accountError(503, 'asset-observer-binding-unavailable'); };
const same = (a, b) => a && b && digestOf(a) === digestOf(b);

export function createRunAssetObserverAuthority({ checkpoint, privateClient, assetFingerprint256 } = {}) {
  const pin = certificateFingerprint(assetFingerprint256);
  if (!/^[a-f0-9]{64}$/.test(pin) || typeof checkpoint?.current !== 'function' ||
      typeof privateClient?.proveObserver !== 'function') fail();
  const bound = new WeakMap(); let closed = false;
  function socketOf(input) {
    const socket = input?.socket;
    if (closed || !socket?.encrypted || socket.authorized !== true || socket.destroyed ||
        certificateFingerprint(socket.getPeerCertificate?.()?.fingerprint256) !== pin) fail();
    return socket;
  }
  function currentAsset(input) {
    const socket = socketOf(input), binding = bound.get(socket), current = checkpoint.current();
    if (!binding || binding.recordDigest !== current.recordDigest || binding.epoch !== current.epoch ||
        !same(binding.instance, current.instance)) fail();
    return { assetInstanceId: binding.instance.instanceId, serviceIdentity: binding.instance.serviceIdentity };
  }
  async function resolveObserver(input) {
    const socket = socketOf(input), first = checkpoint.current();
    const proofInput = { challenge: randomBytes(24).toString('base64url'),
      exporterDigest: assetObserverExporterDigest(socket), epoch: first.epoch,
      recordDigest: first.recordDigest, docAuthorityId: first.authorityId,
      purpose: 'run-assets-observer-verify', instance: first.instance };
    const value = await privateClient.proveObserver(proofInput);
    if (socket.destroyed || value?.identity?.authorityId !== first.authorityId ||
        value.identity.epoch !== first.epoch || value.identity.instanceId !== first.instance.instanceId ||
        value.identity.serviceIdentity !== first.instance.serviceIdentity ||
        value.identity.pid !== first.instance.pid ||
        value.identity.docClientFingerprint256 !== first.instance.clientFingerprint256 ||
        value.identity.internalServerFingerprint256 !== first.instance.serverFingerprint256 ||
        !verifyAssetObserverSocket(socket, proofInput, value.proof)) fail();
    const second = checkpoint.current();
    if (!same(first, second) || socket.destroyed) fail();
    bound.set(socket, { epoch: second.epoch, recordDigest: second.recordDigest, instance: second.instance });
    socket.once('close', () => bound.delete(socket));
    return { ...currentAsset({ socket }), authorityId: second.authorityId,
      epoch: second.epoch, recordDigest: second.recordDigest };
  }
  return Object.freeze({ currentAsset, resolveObserver, close() { closed = true; } });
}
