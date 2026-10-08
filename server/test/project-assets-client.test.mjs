import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import crypto from 'node:crypto';
import { createProjectAssetStores } from '../asset-store/project-stores.mjs';
import { createProjectAssets } from '../agent/service/project-assets.mjs';
import { createRunAssetClient } from '../agent/service/run-asset-client.mjs';
import { createRunResources } from '../agent/service/run-resources.mjs';
import { createWorkspaces } from '../agent/service/workspace.mjs';
import { resourceRevision, assetRefId } from '../account/run-asset-protocol.mjs';

const context = { projectId: 'A', conversationId: 'conv', runId: 'run', runGrantId: 'grant', instanceId: 'agent-instance',
  instanceGeneration: 1, senderAccountId: 'sender', messageId: 'message' };
const payload = Buffer.from('genuine project bytes; controlled wire adapter');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const closed = stream => stream.closed ? Promise.resolve() : new Promise(r => stream.once('close', r));
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-project-assets-consumer-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const stores = createProjectAssetStores({ dir: path.join(dir, 'asset'), chunkSize: 8 });
  let allowed = true, calls = 0, sourceJobAllowed = true; const handles = new Map();
  const contextAccess = { fromGrant: async () => ({ ...context }), authorize: async supplied => {
    calls++; if (!allowed || Object.keys(context).some(k => supplied[k] !== context[k]) || Object.keys(supplied).length !== 8) throw new Error('untrusted-context');
    return { allowed: true, fenceRevision: 1, grantState: 'active' }; } };
  const resources = createRunResources({ contextAccess });
  // No network/crypto claim: this wire adapter exercises consumers with real
  // physical project stores, actual fd/Readable close and genuine hashes only.
  const transport = {
    async issue({ context: ctx, purpose, selector }) {
      const resource = { projectId: ctx.projectId, ns: 'media', hash: purpose === 'openRead' ? hash(payload) : selector.hash,
        size: purpose === 'openRead' ? payload.length : selector.size, ext: 'wav', contentType: 'audio/wav' };
      const assetHandleId = `handle-${handles.size}`; handles.set(assetHandleId, resource);
      return { assetHandleId, resource, resourceRev: resourceRevision(resource), expiresAt: 1000, fenceRevision: 1, grantState: 'active',
        ...(purpose === 'openRead' ? { mediaRev: hash(payload), projectRev: 1, kind: 'audio' } : {}) };
    },
    async request({ context: ctx, assetHandleId, method, url, body }) {
      const ref = handles.get(assetHandleId), store = stores.store(ctx.projectId, 'media'); let result, stream, status = 200;
      if (method === 'PUT') result = await store.putChunk(ref.hash, Number(url.split('/').at(-1)), { size: ref.size, ext: ref.ext }, Readable.from([body]));
      else if (url.endsWith('/complete')) result = await store.complete(ref.hash);
      else if (url.endsWith('/chunks')) result = await store.chunks(ref.hash);
      else if (url.endsWith('/verify')) { const stat = await store.stat(ref.hash); if (!stat) { status = 404; result = 'asset-missing'; }
        else result = { assetRefId: assetRefId(ref), assetRef: ref, resourceRev: resourceRevision(ref) }; }
      else { stream = await store.read(ref.hash); if (!stream) { status = 404; result = 'asset-missing'; } }
      stream ??= Readable.from([Buffer.from(JSON.stringify(status < 400 ? { ok: true, result } : { ok: false, code: result }))]);
      return { status, headers: {}, stream, closed: closed(stream) };
    },
  };
  const client = createRunAssetClient({ transport, maxResponseBytes: 4096 });
  const workspaces = createWorkspaces({ dataDir: path.join(dir, 'agent') }); const workspace = workspaces.open({ projectId: 'A', ownerKey: 'owner123', conversationId: 'conv' });
  const assets = createProjectAssets({ contextAccess, runAssetClient: client, resources, workspace: async () => workspace,
    maxImportBytes: 4096, reserveImport: async (_context, adding) => { if (workspace.usage().bytes + adding > 4096) throw new Error('quota'); },
    verifySourceJob: async () => sourceJobAllowed });
  t.after(() => assets.close());
  return { assets, client, stores, resources, workspace, setAllowed(v) { allowed = v; }, setJobAllowed(v) { sourceJobAllowed = v; }, get calls() { return calls; } };
}

test('ProjectAssets import physically stores hash/size, returns stored not registered; read/verify do not cross project', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const result = await f.assets.import({ ...context }, Readable.from([payload.subarray(0, 5), payload.subarray(5)]), { name: 'voice.wav', kind: 'audio', requestId: 'import-1' });
  assert.equal(result.state, 'stored'); assert.equal(result.assetRef.hash, hash(payload)); assert.equal(result.assetRef.size, payload.length);
  assert.equal(Object.hasOwn(result, 'mediaId'), false); assert.equal((await f.stores.store('A', 'media').stat(hash(payload))).size, payload.length);
  assert.equal(await f.stores.store('B', 'media').stat(hash(payload)), null);
  const verified = await f.assets.verifyRef(context, { projectId: 'A', hash: hash(payload), size: payload.length });
  assert.equal(verified.assetRefId, assetRefId(result.assetRef)); assert.equal(Object.hasOwn(verified, 'registeredMedia'), false);
  const read = await f.assets.openRead(context, 'media-1'); const pieces = []; for await (const piece of read.stream) pieces.push(piece); await read.closed;
  assert.deepEqual(Buffer.concat(pieces), payload); assert.equal(read.kind, 'audio'); assert.ok(f.calls > 10);
  await assert.rejects(f.assets.verifyRef(context, { projectId: 'B', hash: hash(payload), size: payload.length }), /project-mismatch/);
  assert.deepEqual(f.workspace.list(), []);
});

test('forged context/job, source abort and late permission loss cannot publish a successful import result', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await assert.rejects(f.assets.import({ ...context, runId: 'forged' }, Readable.from([payload]), { name: 'x.wav', kind: 'audio', requestId: 'forged' }), /untrusted-context/);
  f.setJobAllowed(false); await assert.rejects(f.assets.import(context, Readable.from([payload]), { name: 'x.wav', kind: 'audio', requestId: 'job', sourceJobId: 'other-job' }), /job-mismatch/);
  const source = new Readable({ read() { this.destroy(new Error('source-abort')); } });
  await assert.rejects(f.assets.import(context, source, { name: 'x.wav', kind: 'audio', requestId: 'abort' }), /source-abort/);
  assert.equal(source.closed, true); assert.equal(await f.stores.store('A', 'media').stat(hash(payload)), null);
  const handle = await f.client.issue(context, 'verifyRef', { hash: hash(payload), size: payload.length }, 'scope');
  await assert.rejects(f.client.request({ ...context, runGrantId: 'other' }, handle, { method: 'GET', requestId: 'read' }), /handle-untrusted/);
  f.setAllowed(false); await assert.rejects(f.assets.openRead(context, 'media-1'), /untrusted-context/);
  assert.deepEqual(f.workspace.list(), []);
});

test('byte array imports preserve whole bytes; invalid sources fail before any workspace fd opens', async t => {
  const f = await fixture(t);
  await assert.rejects(f.assets.import(context, { path: 'caller-path' }, { name: 'x.wav', kind: 'audio', requestId: 'bad-source' }), /source-invalid/);
  assert.deepEqual(f.workspace.list(), []);
  const result = await f.assets.import(context, new Uint8Array(payload), { name: 'x.wav', kind: 'audio', requestId: 'bytes' });
  assert.equal(result.assetRef.hash, hash(payload)); assert.equal(result.assetRef.size, payload.length);
  assert.deepEqual(f.workspace.list(), []);
});
