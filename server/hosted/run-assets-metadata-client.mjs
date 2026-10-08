/** Doc-side client for asset-private read endpoints. This carries no bytes or
 * user tickets; the caller must recheck the current asset registry on both
 * sides of every asynchronous read. */
import { accountError, certificateFingerprint } from '../account/client.mjs';
import { hashOf, reference } from '../account/run-asset-protocol.mjs';
import { createAssetMtlsTransport } from './asset-doc-client.mjs';

const fail = code => { throw accountError(503, code); };
const fields = (value, names) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...names].sort().join(',');

export function createRunAssetPrivateClient(config) {
  const pin = certificateFingerprint(config?.serverFingerprint256);
  if (!hashOf(pin)) fail('run-asset-private-client-unconfigured');
  const transport = createAssetMtlsTransport(config);
  const read = async route => (await transport.request('GET', route)).result;
  return Object.freeze({
    async identity() {
      const value = await read('/internal/v2/asset/run/identity');
      if (!fields(value, ['v', 'serviceId', 'serviceIdentity', 'instanceId', 'pid', 'startedAt',
        'docClientFingerprint256', 'internalServerFingerprint256', 'state']) ||
          value.v !== 1 || value.serviceId !== 'asset' || value.state !== 'running' ||
          !reference(value.serviceIdentity) || !reference(value.instanceId) ||
          !Number.isSafeInteger(value.pid) || value.pid < 1 ||
          !Number.isSafeInteger(value.startedAt) || value.startedAt < 0 ||
          !hashOf(value.docClientFingerprint256) || value.internalServerFingerprint256 !== pin)
        fail('asset-current-identity-invalid');
      return value;
    },
    async resolveTierAssetRef({ projectId, hash, tier, mediaId }) {
      if (![projectId, mediaId].every(reference) || !hashOf(hash) || tier !== 'small') fail('run-asset-tier-metadata-invalid');
      const url = `/internal/v2/asset/run/metadata?projectId=${encodeURIComponent(projectId)}&hash=${hash}&tier=small&mediaId=${encodeURIComponent(mediaId)}`;
      const value = await read(url);
      if (!fields(value, ['projectId', 'hash', 'size', 'ext', 'contentType', 'assetInstanceId']) ||
          value.projectId !== projectId || value.hash !== hash || !reference(value.assetInstanceId) ||
          !Number.isSafeInteger(value.size) || value.size < 0 ||
          typeof value.ext !== 'string' || !/^[a-z0-9]{1,16}$/.test(value.ext) ||
          typeof value.contentType !== 'string' || !value.contentType)
        fail('run-asset-tier-metadata-invalid');
      return value;
    },
    async closureWitness(leaseId) {
      if (!reference(leaseId)) fail('asset-resource-closure-pending');
      const value = await read(`/internal/v2/asset/run/leases/${encodeURIComponent(leaseId)}/closure`);
      if (!fields(value, ['assetInstanceId', 'serviceIdentity', 'receipt', 'binding']) ||
          !reference(value.assetInstanceId) || !reference(value.serviceIdentity) ||
          value.receipt?.leaseId !== leaseId || value.receipt.complete !== true ||
          !hashOf(value.receipt.evidenceDigest) || !reference(value.receipt.receiptId) ||
          !fields(value.binding, ['projectId', 'runGrantId', 'instanceId', 'instanceGeneration']) ||
          ![value.binding.projectId, value.binding.runGrantId, value.binding.instanceId].every(reference) ||
          !Number.isSafeInteger(value.binding.instanceGeneration) || value.binding.instanceGeneration < 1)
        fail('asset-resource-closure-pending');
      return value;
    },
    async controlWitness(eventId) {
      if (!reference(eventId)) fail('asset-resource-closure-pending');
      const value = await read(`/internal/v2/asset/run/events/${encodeURIComponent(eventId)}/closure`);
      if (!fields(value, ['assetInstanceId', 'serviceIdentity', 'receipt']) ||
          !reference(value.assetInstanceId) || !reference(value.serviceIdentity) ||
          value.receipt?.eventId !== eventId || value.receipt.complete !== true ||
          !hashOf(value.receipt.evidenceDigest) || !reference(value.receipt.receiptId))
        fail('asset-resource-closure-pending');
      return value;
    },
    close: () => transport.close(),
  });
}
