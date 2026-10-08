import { digestOf } from '../account/ledger.mjs';
import { validateAssetRef, hashOf, reference } from '../account/run-asset-protocol.mjs';
import { historyError } from '../docservice/modules/operation-history.mjs';

const fail = (code, status = 503) => { throw historyError(code, status); };
const validSize = value => Number.isSafeInteger(value) && value >= 0;
const validExt = value => typeof value === 'string' && /^[a-z0-9]{1,16}$/.test(value);

/** Select only a row from a recovered, locked project snapshot. Paths and URLs
 * in old project records are deliberately ignored. */
export function describeRunMedia({ snapshot, projectId, purpose, selector }) {
  if (!reference(projectId) || !snapshot || !Number.isSafeInteger(snapshot.projectRev) ||
      snapshot.projectRev < 0 || snapshot.value?.id && snapshot.value.id !== projectId)
    fail('run-asset-project-unavailable');
  const projectRev = snapshot.projectRev;
  if (purpose === 'import') {
    if (!hashOf(selector?.hash) || !validSize(selector.size) || !validExt(selector.ext)) fail('run-asset-resource-unavailable');
    return { projectId, projectRev, purpose, selector: structuredClone(selector) };
  }
  if (purpose === 'verifyRef') {
    if (!hashOf(selector?.hash) || !validSize(selector.size)) fail('run-asset-resource-unavailable');
    return { projectId, projectRev, purpose, selector: structuredClone(selector) };
  }
  if (purpose !== 'openRead' || !reference(selector?.mediaId) || !['original', 'small'].includes(selector.tier))
    fail('run-asset-resource-unavailable');
  const media = snapshot.value?.media?.find(item => item?.id === selector.mediaId);
  if (!media || media.pending === true || !['image', 'audio', 'video'].includes(media.kind))
    fail('run-asset-media-missing', 404);
  const original = media.tiers?.original ?? media.hash;
  if (!hashOf(media.hash) || !hashOf(original) || original !== media.hash) fail('run-asset-resource-unavailable');
  const hash = selector.tier === 'small' ? media.tiers?.small : original;
  if (!hashOf(hash)) fail('run-asset-tier-unavailable');
  return { projectId, projectRev, purpose, mediaId: media.id, tier: selector.tier,
    hash, kind: media.kind, mediaDigest: digestOf(media),
    ...(selector.tier === 'original' ? { size: media.size, ext: media.ext } : {}) };
}

/** The small tier has a different file/format from original. Its metadata must
 * be read from the pinned asset service's project store, outside the doc lock. */
export async function materializeRunMedia(description, { resolveTierAssetRef, contentTypeForExt } = {}) {
  const { projectId, projectRev, purpose } = description;
  let resource;
  if (purpose === 'verifyRef') {
    resource = { projectId, ns: 'media', hash: description.selector.hash, size: description.selector.size,
      contentType: 'application/octet-stream' };
  } else if (purpose === 'import') {
    if (typeof contentTypeForExt !== 'function') fail('run-asset-resource-unavailable');
    resource = { projectId, ns: 'media', hash: description.selector.hash, size: description.selector.size,
      ext: description.selector.ext, contentType: contentTypeForExt(description.selector.ext) };
  } else if (description.tier === 'original') {
    if (!validSize(description.size) || !validExt(description.ext) || typeof contentTypeForExt !== 'function')
      fail('run-asset-resource-unavailable');
    resource = { projectId, ns: 'media', hash: description.hash, size: description.size,
      ext: description.ext, contentType: contentTypeForExt(description.ext) };
  } else {
    if (typeof resolveTierAssetRef !== 'function') fail('run-asset-tier-metadata-unavailable');
    const resolved = await resolveTierAssetRef({ projectId, hash: description.hash, tier: 'small',
      mediaId: description.mediaId });
    if (resolved?.projectId !== projectId || resolved.hash !== description.hash ||
        !validSize(resolved.size) || !validExt(resolved.ext) ||
        typeof resolved.contentType !== 'string' || !resolved.contentType)
      fail('run-asset-tier-metadata-unavailable');
    resource = { projectId, ns: 'media', hash: description.hash, size: resolved.size,
      ext: resolved.ext, contentType: resolved.contentType };
  }
  try { resource = validateAssetRef(resource); }
  catch { fail('run-asset-resource-unavailable'); }
  return { resource, projectRev, ...(purpose === 'openRead' ? {
    mediaRev: digestOf({ v: 1, projectId, mediaId: description.mediaId, tier: description.tier,
      mediaDigest: description.mediaDigest, kind: description.kind, resource }), kind: description.kind } : {}) };
}
