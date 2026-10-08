import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { createProjectAssetStores } from '../asset-store/project-stores.mjs';
import { createRunAssetMetadata } from '../hosted/run-assets-metadata.mjs';
import { createRunAssetMetadataRpc } from '../hosted/run-assets-metadata-rpc.mjs';
import { assetWiringPki } from './fixtures/asset-wiring-pki.mjs';

test('small metadata comes from the selected project’s completed physical file', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-run-metadata-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bytes = Buffer.from('small project A bytes');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const projects = createProjectAssetStores({ dir, contentTypeForExt: ext => ext === 'mp4' ? 'video/mp4' : 'application/octet-stream' });
  const metadata = createRunAssetMetadata({ projectStores: projects });
  const query = projectId => ({ projectId, hash, tier: 'small', mediaId: 'media-one' });
  assert.equal(await metadata.resolveTierAssetRef(query('project-B')).catch(error => error.code), 'run-asset-tier-metadata-unavailable');
  const store = projects.project('project-A').stores.media;
  await store.putChunk(hash, 0, { size: bytes.length, ext: 'mp4' }, Readable.from([bytes]));
  assert.equal(await metadata.resolveTierAssetRef(query('project-A')).catch(error => error.code), 'run-asset-tier-metadata-unavailable');
  assert.equal((await store.complete(hash)).status, 'ok');
  assert.deepEqual(await metadata.resolveTierAssetRef(query('project-A')), {
    projectId: 'project-A', hash, size: bytes.length, ext: 'mp4', contentType: 'video/mp4',
  });
  assert.equal(await metadata.resolveTierAssetRef(query('project-B')).catch(error => error.code), 'run-asset-tier-metadata-unavailable');
  await assert.rejects(metadata.resolveTierAssetRef({ ...query('project-A'), hash: '../x' }), error => error.code === 'run-asset-tier-metadata-invalid');
});

test('doc-only private reads expose current lifecycle and durable witness without entering a consumer queue', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-run-metadata-rpc-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const pki = assetWiringPki(dir);
  const projectStores = createProjectAssetStores({ dir: path.join(dir, 'stores') });
  const consumer = {
    sync() { throw new Error('must not reenter consumer queue'); },
    closureWitness(leaseId) { assert.equal(leaseId, 'lease:one'); return { assetInstanceId: 'asset-os-one',
      serviceIdentity: 'asset-kid', receipt: { leaseId, complete: true }, binding: { projectId: 'project-A' } }; },
    controlWitness(eventId) { assert.equal(eventId, 'run-asset:control-one'); return { assetInstanceId: 'asset-os-one',
      serviceIdentity: 'asset-kid', receipt: { eventId, complete: true } }; },
  };
  let open = true;
  const rpc = createRunAssetMetadataRpc({ docFingerprint256: pki.doc.fingerprint256,
    internalServerCert: pki.account.cert, projectStores, consumer, isOpen: () => open,
    lifecycle: { state: { serviceId: 'asset', serviceIdentity: 'asset-kid', instanceId: 'asset-os-one',
      pid: 99, startedAt: 1, fingerprint256: pki.asset.fingerprint256.replaceAll(':', '').toLowerCase(), state: 'running' } } });
  const invoke = async (url, fingerprint256 = pki.doc.fingerprint256) => {
    const res = { destroyed: false, headersSent: false, writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; },
      end(value) { this.value = JSON.parse(value); } };
    const handled = await rpc.handler({ method: 'GET', url, headers: {},
      socket: { authorized: true, destroyed: false, getPeerCertificate: () => ({ fingerprint256 }) } }, res);
    assert.equal(handled, true); return res;
  };
  const identity = await invoke('/internal/v2/asset/run/identity');
  assert.equal(identity.status, 200);
  assert.deepEqual([identity.value.result.docClientFingerprint256, identity.value.result.internalServerFingerprint256],
    [pki.asset.fingerprint256.replaceAll(':', '').toLowerCase(), pki.account.fingerprint256.replaceAll(':', '').toLowerCase()]);
  assert.equal((await invoke('/internal/v2/asset/run/leases/lease%3Aone/closure')).value.result.receipt.leaseId, 'lease:one');
  assert.equal((await invoke('/internal/v2/asset/run/events/run-asset%3Acontrol-one/closure')).value.result.receipt.eventId,
    'run-asset:control-one');
  assert.equal((await invoke('/internal/v2/asset/run/identity', pki.wrong.fingerprint256)).status, 403);
  open = false;
  assert.equal((await invoke('/internal/v2/asset/run/identity')).status, 503);
});
