import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createRunAssetsInternalHandler } from '../account/run-assets-internal.mjs';
import { RUN_ASSET_ROOT, assetHttpTuple, bytesDigest, validateIssue, resourceRevision,
  validateAssetHttpTuple, requestProof } from '../account/run-asset-protocol.mjs';

const empty = bytesDigest(Buffer.alloc(0)), hash = 'a'.repeat(64);
const resource = { projectId: 'sp_project', ns: 'media', hash, size: 5, contentType: 'audio/wav', ext: 'wav' };
const tuple = delta => assetHttpTuple({ projectId: resource.projectId, runGrantId: 'grant-1', action: 'read',
  ticketDigest: 'b'.repeat(64), resourceRev: resourceRevision(resource), nonce: 'nonce-1', requestId: 'request-1',
  method: 'GET', url: `/internal/v2/asset/run/media/${hash}`, contentLength: 0, contentDigest: empty, ...delta });
const issueBody = { projectId: resource.projectId, runGrantId: 'grant-1', action: 'read', requestId: 'issue-1',
  purpose: 'openRead', selector: { mediaId: 'media-1', tier: 'original' } };

test('canonical full HTTP tuple and namespace/action boundary have no identity or global hash escape', () => {
  assert.equal(validateAssetHttpTuple(tuple()).operation, 'openRead');
  assert.equal(validateAssetHttpTuple(tuple({ url: `/internal/v2/asset/run/media/${hash}/chunks` })).operation, 'chunks');
  assert.throws(() => tuple({ contentLength: 1 }), /run-asset-body-invalid/);
  assert.throws(() => tuple({ url: `//remote/media/${hash}` }), /resource-invalid/);
  assert.throws(() => tuple({ url: `/internal/v2/asset/run/media/${hash}?projectId=other` }), /resource-invalid/);
  assert.throws(() => tuple({ url: `/internal/v2/asset/run/px/${hash}` }), /resource-scope-mismatch/);
  assert.throws(() => tuple({ action: 'write' }), /resource-scope-mismatch/);
  assert.throws(() => validateAssetHttpTuple({ ...tuple(), accountId: 'owner' }), /run-asset-body-invalid/);
  assert.throws(() => validateIssue({ ...issueBody, selector: { ...issueBody.selector, hash } }), /resource-invalid/);
  assert.throws(() => requestProof({ instanceId: 'instance-1', instanceGeneration: 1, signature: 'A'.repeat(86), instanceSession: 'cap' }), /instance-proof-invalid/);
  assert.equal(validateAssetHttpTuple(tuple({ method: 'PUT', action: 'write',
    url: `/internal/v2/asset/run/media/${hash}/0`, chunkIndex: 0, importId: 'import-1', contentLength: 5,
    contentDigest: bytesDigest(Buffer.from('audio')) })).operation, 'chunk');
});

function fakeRequest({ body = issueBody, raw, declared, aborted = false, delta = {}, peer = 'c'.repeat(64) } = {}) {
  const bytes = raw ?? Buffer.from(JSON.stringify(body));
  const req = Readable.from([bytes]); req.url = `${RUN_ASSET_ROOT}issue`; req.method = 'POST';
  req.headers = { 'content-length': String(declared ?? bytes.length), 'x-promptcut-instance-proof':
    Buffer.from(JSON.stringify({ instanceId: 'instance-1', instanceGeneration: 1, signature: 'A'.repeat(86) })).toString('base64url') };
  req.aborted = aborted;
  req.socket = { encrypted: true, authorized: true, destroyed: false,
    exportKeyingMaterial: () => Buffer.alloc(32, 4), getPeerCertificate: () => ({ fingerprint256: peer }) };
  Object.assign(req, delta); return req;
}
function result() {
  return { destroyed: false, writableEnded: false, writeHead(status) { this.status = status; },
    end(bytes) { this.body = JSON.parse(bytes); this.writableEnded = true; } };
}
function handler() {
  const calls = [];
  const runAssets = Object.fromEntries(['issue', 'check', 'closeLease', 'eventsSince', 'acknowledgeEvent'].map(name => [name,
    async input => { calls.push({ name, input }); return { called: name }; }]));
  const handle = createRunAssetsInternalHandler({ runAssets, agentFingerprint256: 'c'.repeat(64),
    assetFingerprint256: 'd'.repeat(64), maxBodyBytes: 4096,
    resolveObserver: async () => ({ assetInstanceId: 'asset-1', serviceIdentity: 'asset-key-1' }) });
  return { handle, calls };
}

test('controlled HTTP adapter rejects oversized/truncated/aborted raw body before any factory effect', async () => {
  const { handle, calls } = handler();
  for (const opts of [{ declared: 4097 }, { raw: Buffer.alloc(4097), declared: 4097 },
    { aborted: true }, { declared: 5 }, { raw: Buffer.from('{') }, { delta: { complete: false } }]) {
    const res = result(); await handle(fakeRequest(opts), res); assert.ok([400, 413].includes(res.status));
  }
  assert.equal(calls.length, 0);
  const req = fakeRequest(), res = result(); await handle(req, res); assert.equal(res.status, 200);
  assert.deepEqual(calls[0].input.body, issueBody); assert.equal(calls[0].input.transport, req);
});

test('wire UTF8 is fatal and actual bodyText is delivered unchanged, never replaced or guessed', async () => {
  const { handle, calls } = handler(), res = result();
  const prefix = Buffer.from('{"name":"'), suffix = Buffer.from('"}');
  await handle(fakeRequest({ raw: Buffer.concat([prefix, Buffer.from([0xc3, 0x28]), suffix]) }), res);
  assert.equal(res.status, 400); assert.equal(calls.length, 0);
  const raw = Buffer.from(` \n${JSON.stringify(issueBody)}\n `), legal = result();
  await handle(fakeRequest({ raw }), legal); assert.equal(legal.status, 200);
  assert.equal(calls[0].input.bodyText, raw.toString('utf8'));
});

test('controlled HTTP adapter pins role and refuses method/path/query/proxy and cap/body smuggling', async () => {
  const { handle, calls } = handler();
  for (const req of [fakeRequest({ peer: 'd'.repeat(64) }), fakeRequest({ delta: { method: 'GET' } }),
    fakeRequest({ delta: { url: `${RUN_ASSET_ROOT}issue?ack=2` } }),
    fakeRequest({ delta: { headers: { forwarded: 'for=loopback' } } }),
    fakeRequest({ delta: { socket: { authorized: true, encrypted: false } } })]) {
    const res = result(); await handle(req, res); assert.notEqual(res.status, 200);
  }
  assert.equal(calls.length, 0);
  const res = result(); await handle(fakeRequest({ peer: 'd'.repeat(64),
    delta: { url: `${RUN_ASSET_ROOT}check` }, body: { ticket: 'x', request: tuple(), proof: {}, observation: {}, principal: {} } }), res);
  assert.equal(res.status, 400); assert.equal(calls.length, 0);
  assert.throws(() => createRunAssetsInternalHandler({}), /unconfigured/);
});
