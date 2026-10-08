import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createProjectAssetStores } from '../asset-store/project-stores.mjs';
import { createAssetRunAccess, createAssetRunConsumer } from '../hosted/asset-run-access.mjs';
import { resourceRevision, validateAssetHttpTuple, bytesDigest } from '../account/run-asset-protocol.mjs';

const bytes = Buffer.from('independent bytes for both projects');
const hash = bytesDigest(bytes), pin = 'b'.repeat(64);
class ControlledSocket extends EventEmitter {
  encrypted = true; authorized = true; destroyed = false; closed = false;
  exportKeyingMaterial() { return Buffer.alloc(32, 3); }
  getPeerCertificate() { return { fingerprint256: pin }; }
  destroy() { if (this.destroyed) return; this.destroyed = true; setImmediate(() => { this.closed = true; this.emit('close'); }); }
}
class ControlledResponse extends Writable {
  constructor(socket) { super(); this.parts = []; this.statusCode = 200; this.headersSent = false;
    this.once('finish', () => socket.destroy()); this.once('close', () => socket.destroy()); }
  _write(chunk, _encoding, cb) { this.parts.push(Buffer.from(chunk)); cb(); }
  writeHead(status, headers) { this.statusCode = status; this.headers = headers; this.headersSent = true; }
  get body() { return Buffer.concat(this.parts); }
}
const closed = item => item.closed ? Promise.resolve() : new Promise(r => item.once('close', r));

async function fixture(t, publication = {}, faults = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-asset-run-handler-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const stores = createProjectAssetStores({ dir, chunkSize: 8 }); let allowed = true, admissions = 0, checks = 0;
  const tickets = new Map(), sockets = new Map(); let observerCloses = 0;
  const ref = projectId => ({ projectId, ns: 'media', hash, size: bytes.length, ext: 'wav', contentType: 'audio/wav' });
  const ticket = (projectId, action) => { const raw = crypto.randomBytes(32).toString('base64url'); tickets.set(raw, { resource: ref(projectId), action }); return raw; };
  // This adapter deliberately owns no cryptographic authority. The fixture
  // tests actual bytes/physical stores/lease/fd/publication with controlled TLS
  // objects; genuine three-role mTLS is a separate, not-yet-run target.
  const client = { eventsSince: async () => ({ events: [], headSeq: 0 }), acknowledgeEvent: async () => {},
    openLease(input) { const id = `lease-${++admissions}`, grant = tickets.get(input.ticket), observer = new ControlledSocket(); let first = true;
      return { leaseId: id, async check() {
        checks++; validateAssetHttpTuple(input.request);
        if (!allowed) throw Object.assign(new Error('run-revoked'), { status: 403, code: 'run-revoked' });
        if (!grant || grant.resource.projectId !== input.request.projectId || grant.action !== input.request.action ||
            resourceRevision(grant.resource) !== input.request.resourceRev) throw Object.assign(new Error('resource-scope-mismatch'), { status: 403, code: 'resource-scope-mismatch' });
        first = false;
        return { allowed: true, leaseId: id, projectId: grant.resource.projectId, action: grant.action, resource: grant.resource,
          resourceRev: resourceRevision(grant.resource), grantState: 'active', fenceRevision: 1, accessHead: 0, runAssetHead: 0 };
      }, async closeLease(receipt) { assert.equal(first, false); assert.equal(receipt.complete, true);
        const owned = sockets.get(input.observation.assetLeaseId); assert.equal(owned.socket.closed, true); assert.equal(owned.response.closed, true);
        if (faults.closeLeaseError) throw faults.closeLeaseError;
      }, async close() { observer.destroy(); await closed(observer); observerCloses++; } };
    } };
  const consumer = createAssetRunConsumer({ client, file: path.join(dir, 'run-state.json'), assetInstanceId: 'asset-one', serviceIdentity: 'asset-key', verifyLifecycle: async () => true }); await consumer.start();
  let currentSocket, currentResponse;
  const original = client.openLease;
  client.openLease = input => { sockets.set(input.observation.assetLeaseId, { socket: currentSocket, response: currentResponse }); return original(input); };
  const access = createAssetRunAccess({ client, consumer, projectStores: stores, humanConsumer: { ready: true, sync: async () => {} },
    assetInstanceId: 'asset-one', serviceIdentity: 'asset-key', agentFingerprint256: pin, resolveAgentTransport: async () => ({ serviceKid: 'agent-key' }),
    maxBodyBytes: 4096, publicationIO: { ...fs, ...publication } });
  t.after(async () => {
    if (faults.closeLeaseError) { await access.close().catch(error => assert.equal(error, faults.closeLeaseError)); await consumer.close().catch(error => assert.equal(error, faults.closeLeaseError)); }
    else { await access.close(); await consumer.close(); }
  });
  let seq = 0;
  async function request(projectId, method, suffix = '', body = Buffer.alloc(0), extras = {}) {
    const socket = new ControlledSocket(), req = Readable.from(body.length ? [body] : []); req.socket = socket; req.complete = true;
    req.method = method; req.url = `/internal/v2/asset/run/media/${hash}${suffix}`;
    const action = method === 'PUT' || suffix === '/complete' ? 'write' : 'read';
    req.headers = { authorization: `Bearer ${ticket(projectId, action)}`, 'content-length': String(body.length),
      'x-promptcut-run-project-id': projectId, 'x-promptcut-run-grant-id': 'grant', 'x-promptcut-run-resource-rev': resourceRevision(ref(projectId)),
      'x-promptcut-run-nonce': `nonce-${++seq}`, 'x-promptcut-run-request-id': `request-${seq}`, 'x-promptcut-run-import-id': 'import-one',
      'x-promptcut-run-asset-proof': Buffer.from(JSON.stringify({ instanceId: 'agent-one', instanceGeneration: 1, signature: 'A'.repeat(86) })).toString('base64url'), ...extras.headers };
    if (extras.url) req.url = extras.url; if (extras.complete !== undefined) req.complete = extras.complete;
    const response = new ControlledResponse(socket); currentSocket = socket; currentResponse = response;
    await access.handler(req, response); await Promise.all([closed(socket), closed(response)]);
    // Await the actual owned lease receipt dispatches before starting another
    // controlled request; no listener or simulated finish-only receipt.
    await access.idle();
    return response;
  }
  return { stores, ref, ticket, client, consumer, dir, setAllowed(v) { allowed = v; }, get checks() { return checks; },
    get observerCloses() { return observerCloses; },
    request, access };
}

test('asset data entry has no public hash/project/loopback fallback and rejects incomplete wire before admission', async t => {
  const f = await fixture(t);
  const response = await f.request('A', 'PUT', '/0', bytes.subarray(0, 8), { headers: { 'content-length': '9' } });
  assert.equal(response.statusCode, 400); assert.equal(f.checks, 0); assert.equal(await f.stores.store('A', 'media').stat(hash), null);
});

test('physical run import hash mismatch cannot publish a whole project asset', async t => {
  const f = await fixture(t);
  const wrong = Buffer.alloc(bytes.length, 1);
  for (let n = 0; n < Math.ceil(wrong.length / 8); n++) {
    const response = await f.request('A', 'PUT', `/${n}`, wrong.subarray(n * 8, (n + 1) * 8));
    assert.equal(response.statusCode, 200);
  }
  const response = await f.request('A', 'POST', '/complete'); assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).code, 'hash-mismatch');
  assert.equal(await f.stores.store('A', 'media').stat(hash), null);
  assert.equal(await f.stores.store('B', 'media').stat(hash), null);
});

test('physical import publishes only selected project; GET HEAD Range chunks and verifyRef see accepted content', async t => {
  const f = await fixture(t);
  for (const projectId of ['A', 'B']) {
    const missing = await f.request(projectId, 'GET'); assert.equal(missing.statusCode, 404);
    for (let n = 0; n < Math.ceil(bytes.length / 8); n++) {
      const response = await f.request(projectId, 'PUT', `/${n}`, bytes.subarray(n * 8, (n + 1) * 8)); assert.equal(response.statusCode, 200);
    }
    const staged = await f.request(projectId, 'GET', '/chunks'); assert.equal(JSON.parse(staged.body).result.complete, false);
    const completed = await f.request(projectId, 'POST', '/complete'); assert.equal(completed.statusCode, 200);
    const get = await f.request(projectId, 'GET'); assert.deepEqual(get.body, bytes);
    const head = await f.request(projectId, 'HEAD'); assert.equal(head.statusCode, 200); assert.equal(head.body.length, 0);
    const range = await f.request(projectId, 'GET', '', Buffer.alloc(0), { headers: { range: 'bytes=2-5' } });
    assert.equal(range.statusCode, 206); assert.deepEqual(range.body, bytes.subarray(2, 6));
    const verify = await f.request(projectId, 'POST', '', Buffer.from(JSON.stringify({ projectId, hash, size: bytes.length })),
      { url: '/internal/v2/asset/run/refs/verify', headers: { 'content-type': 'application/json' } });
    assert.equal(verify.statusCode, 200); assert.equal(JSON.parse(verify.body).result.assetRef.hash, hash);
    if (projectId === 'A') assert.equal(await f.stores.store('B', 'media').stat(hash), null);
  }
  await f.stores.removeProject('A'); assert.equal((await f.stores.store('B', 'media').stat(hash)).size, bytes.length);
});

for (const cut of ['marker-created', 'renamed-under-marker']) test(`run revoke at ${cut} rolls back only its unpublished target`, async t => {
  let f, saw = false;
  const publication = cut === 'marker-created' ? { async open(file, ...args) {
    const handle = await fs.open(file, ...args); if (file.endsWith('.project-publication.json')) { saw = true; f.setAllowed(false); }
    return handle;
  } } : { async rename(from, to) {
    await fs.rename(from, to);
    if (to.endsWith(`${hash}.wav`)) { saw = true; assert.equal(await f.stores.store('A', 'media').stat(hash), null); f.setAllowed(false); }
  } };
  f = await fixture(t, publication);
  for (let n = 0; n < Math.ceil(bytes.length / 8); n++) assert.equal((await f.request('A', 'PUT', `/${n}`, bytes.subarray(n * 8, (n + 1) * 8))).statusCode, 200);
  const response = await f.request('A', 'POST', '/complete'); assert.equal(response.statusCode, 403); assert.equal(saw, true);
  assert.equal(await f.stores.store('A', 'media').stat(hash), null); assert.equal(await f.stores.store('B', 'media').stat(hash), null);
});

test('real admission persistence failure closes observer and stays a visible idle/close failure without a closure ACK', { timeout: 5000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-asset-run-admit-fault-')), file = path.join(dir, 'state.json');
  const ref = { projectId: 'A', ns: 'media', hash, size: bytes.length, ext: 'wav', contentType: 'audio/wav' };
  let channelCloses = 0, closureACKs = 0;
  const client = { eventsSince: async () => ({ events: [], headSeq: 0 }), acknowledgeEvent: async () => { throw new Error('must-not-ACK'); },
    openLease: () => ({ leaseId: 'persist-fault-lease', async check() {
      // Real filesystem fault, not a mocked persist method: rename cannot
      // replace this directory with the consumer's durable state file.
      await fs.mkdir(file, { recursive: true });
      return { allowed: true, projectId: 'A', action: 'read', resource: ref, resourceRev: resourceRevision(ref),
        grantState: 'active', fenceRevision: 1, runAssetHead: 0 };
    }, async closeLease() { closureACKs++; }, async close() { channelCloses++; } }) };
  const consumer = createAssetRunConsumer({ client, file, assetInstanceId: 'asset-one', serviceIdentity: 'asset-key', verifyLifecycle: async () => true });
  await consumer.start();
  const access = createAssetRunAccess({ client, consumer, projectStores: { project() { throw new Error('must-not-reach-bytes'); } },
    humanConsumer: { ready: true, sync: async () => {} }, assetInstanceId: 'asset-one', serviceIdentity: 'asset-key',
    agentFingerprint256: pin, resolveAgentTransport: async () => ({ serviceKid: 'agent-key' }), maxBodyBytes: 4096 });
  const socket = new ControlledSocket(), req = Readable.from([]), response = new ControlledResponse(socket);
  req.socket = socket; req.complete = true; req.method = 'GET'; req.url = `/internal/v2/asset/run/media/${hash}`;
  req.headers = { authorization: `Bearer ${'A'.repeat(43)}`, 'content-length': '0', 'x-promptcut-run-project-id': 'A',
    'x-promptcut-run-grant-id': 'grant', 'x-promptcut-run-resource-rev': resourceRevision(ref), 'x-promptcut-run-nonce': 'fault-nonce',
    'x-promptcut-run-request-id': 'fault-request',
    'x-promptcut-run-asset-proof': Buffer.from(JSON.stringify({ instanceId: 'agent-one', instanceGeneration: 1, signature: 'A'.repeat(86) })).toString('base64url') };
  t.after(async () => { socket.destroy(); response.destroy(); await Promise.all([closed(socket), closed(response)]);
    await access.close().catch(() => {}); await consumer.close().catch(() => {}); await fs.rm(dir, { recursive: true, force: true }); });
  const actualIOFailure = error => error instanceof AggregateError
    ? error.errors.length > 0 && error.errors.every(actualIOFailure)
    : ['EPERM', 'EISDIR', 'ENOTEMPTY', 'EEXIST'].includes(error?.code);
  let handlerFailure; try { await access.handler(req, response); } catch (error) { handlerFailure = error; }
  await Promise.all([closed(socket), closed(response)]);
  assert.equal(response.statusCode, 503); assert.equal(socket.closed, true); assert.equal(req.closed, true); assert.equal(response.closed, true);
  // An HTTP error is not completion: the real failed durable task remains
  // observable even after all physical owned resources and channel close.
  await assert.rejects(access.idle(), actualIOFailure); assert.ok(actualIOFailure(handlerFailure));
  await assert.rejects(access.close(), actualIOFailure);
  assert.equal(channelCloses, 1); assert.equal(closureACKs, 0); assert.equal(consumer.ready, false);
  assert.equal(access.status().runAssetsReady, false);
  assert.throws(() => consumer.closureWitness('persist-fault-lease'), /closure-pending/);
  assert.equal((await fs.stat(file)).isDirectory(), true);
});

test('doc closeLease RPC rejection still awaits owned observer close and preserves the pending durable receipt', async t => {
  const failure = new Error('doc-close-rejected'), f = await fixture(t, {}, { closeLeaseError: failure });
  await assert.rejects(f.request('A', 'GET'), error => error === failure);
  assert.equal(f.observerCloses, 1); await assert.rejects(f.access.idle(), error => error === failure);
  assert.equal(f.access.status().runAssetsReady, false);
  const persisted = JSON.parse(await fs.readFile(path.join(f.dir, 'run-state.json'), 'utf8'));
  assert.equal(persisted.leases['lease-1'].state, 'closing'); // Real close evidence persisted; doc never accepted the ACK.
  assert.deepEqual(f.consumer.closureWitness('lease-1').receipt, persisted.leases['lease-1'].receipt);
});
