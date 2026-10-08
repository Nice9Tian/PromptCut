/** A doc-only physical metadata read. Authorization stays in the doc's two
 * coordinator reads; this function never enters either revocation queue. */
import { accountError } from '../account/client.mjs';
import { hashOf, reference } from '../account/run-asset-protocol.mjs';

const fail = (code, status = 503) => { throw accountError(status, code); };

export function createRunAssetMetadata({ projectStores } = {}) {
  if (typeof projectStores?.project !== 'function') fail('run-asset-metadata-unconfigured');
  return Object.freeze({
    async resolveTierAssetRef({ projectId, hash, tier, mediaId } = {}) {
      if (!reference(projectId) || !reference(mediaId) || !hashOf(hash) || tier !== 'small')
        fail('run-asset-tier-metadata-invalid', 400);
      const scope = projectStores.project(projectId);
      if (scope?.projectId !== projectId || typeof scope.assertActive !== 'function' ||
          typeof scope.stores?.media?.stat !== 'function') fail('run-asset-tier-metadata-unavailable');
      await scope.assertActive();
      const stat = await scope.stores.media.stat(hash);
      await scope.assertActive();
      if (!stat || !Number.isSafeInteger(stat.size) || stat.size < 0 ||
          typeof stat.ext !== 'string' || !/^[a-z0-9]{1,16}$/.test(stat.ext) ||
          typeof stat.contentType !== 'string' || !stat.contentType)
        fail('run-asset-tier-metadata-unavailable');
      return { projectId, hash, size: stat.size, ext: stat.ext, contentType: stat.contentType };
    },
  });
}
