import test from 'node:test';
import assert from 'node:assert/strict';
import { bytesDigest } from '../account/run-asset-protocol.mjs';
import { describeRunMedia, materializeRunMedia } from '../hosted/media-selector.mjs';

const projectId = 'project_media_g';
const original = bytesDigest(Buffer.from('original'));
const small = bytesDigest(Buffer.from('small'));
const snapshot = { projectRev: 7, value: { id: projectId, media: [{ id: 'media-one', kind: 'video', name: 'film.mp4',
  url: '/old', path: 'C:/wrong-project/private.mp4', hash: original, size: 8, ext: 'mp4',
  tiers: { original, small } }] } };
const mime = ext => ({ mp4: 'video/mp4', mov: 'video/quicktime' })[ext];

test('locked history selector uses only the project media row and original metadata', async () => {
  const selected = describeRunMedia({ projectId, snapshot, purpose: 'openRead', selector: { mediaId: 'media-one', tier: 'original' } });
  const result = await materializeRunMedia(selected, { contentTypeForExt: mime });
  assert.deepEqual(result.resource, { projectId, ns: 'media', hash: original, size: 8, ext: 'mp4', contentType: 'video/mp4' });
  assert.equal(result.projectRev, 7);
  assert.match(result.mediaRev, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes('private.mp4'), false);
  assert.throws(() => describeRunMedia({ projectId: 'other', snapshot, purpose: 'openRead',
    selector: { mediaId: 'media-one', tier: 'original' } }), { code: 'run-asset-project-unavailable' });
  assert.throws(() => describeRunMedia({ projectId, snapshot, purpose: 'openRead',
    selector: { mediaId: 'old-path', tier: 'original' } }), { code: 'run-asset-media-missing' });
});

test('small tier requires its own pinned asset metadata, never original size/extension', async () => {
  const selected = describeRunMedia({ projectId, snapshot, purpose: 'openRead', selector: { mediaId: 'media-one', tier: 'small' } });
  await assert.rejects(materializeRunMedia(selected), { code: 'run-asset-tier-metadata-unavailable' });
  await assert.rejects(materializeRunMedia(selected, { resolveTierAssetRef: async () => ({
    projectId: 'other', hash: small, size: 3, ext: 'mov', contentType: 'video/quicktime' }) }),
  { code: 'run-asset-tier-metadata-unavailable' });
  const answer = await materializeRunMedia(selected, { resolveTierAssetRef: async input => {
    assert.deepEqual(input, { projectId, hash: small, tier: 'small', mediaId: 'media-one' });
    return { projectId, hash: small, size: 5, ext: 'mov', contentType: 'video/quicktime' };
  } });
  assert.deepEqual(answer.resource, { projectId, ns: 'media', hash: small, size: 5, ext: 'mov', contentType: 'video/quicktime' });
  assert.notEqual(answer.mediaRev, (await materializeRunMedia(describeRunMedia({ projectId, snapshot,
    purpose: 'openRead', selector: { mediaId: 'media-one', tier: 'original' } }), { contentTypeForExt: mime })).mediaRev);
});

test('import/verifyRef bind only claimed bytes to current project; neither invents a history media row', async () => {
  const upload = await materializeRunMedia(describeRunMedia({ projectId, snapshot, purpose: 'import',
    selector: { hash: original, size: 8, ext: 'mp4', name: 'film.mp4', kind: 'video', importId: 'one' } }),
  { contentTypeForExt: mime });
  assert.deepEqual(upload.resource, { projectId, ns: 'media', hash: original, size: 8, ext: 'mp4', contentType: 'video/mp4' });
  assert.equal(upload.mediaRev, undefined);
  const check = await materializeRunMedia(describeRunMedia({ projectId, snapshot, purpose: 'verifyRef',
    selector: { hash: original, size: 8 } }));
  assert.deepEqual(check.resource, { projectId, ns: 'media', hash: original, size: 8, contentType: 'application/octet-stream' });
  assert.equal(check.mediaRev, undefined);
});
