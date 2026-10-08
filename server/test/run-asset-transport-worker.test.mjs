import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunAssetTransport } from '../agent-service/run-asset-transport.mjs';
import { createRunClient } from '../agent-service/run-client.mjs';
import { createRunResources } from '../agent/service/run-resources.mjs';
import { bytesDigest, runAssetIssueRequest } from '../account/run-asset-protocol.mjs';

const code = expected => error => error?.code === expected;

test('asset transport refuses absent pinned Agent/doc/asset and resource owner configuration', () => {
  assert.throws(() => createRunAssetTransport(), code('run-assets-unconfigured'));
});

test('asset transport rejects caller query, proxy, body path and actor claims before network use', async () => {
  const client = createRunClient({ origin: 'https://doc.example/',
    tls: { key: 'fixture-key', cert: 'fixture-cert', ca: 'fixture-ca' }, serverFingerprint256: 'b'.repeat(64) });
  const resources = createRunResources({ runClient: client });
  const transport = createRunAssetTransport({
    runClient: client,
    assetOrigin: 'https://asset.example/', assetFingerprint256: 'a'.repeat(64),
    assetTls: { key: 'fixture-key', cert: 'fixture-cert', ca: 'fixture-ca' },
    resources,
  });
  for (const input of [
    { url: '/internal/v2/asset/run/media/' + 'a'.repeat(64) + '?t=leak' },
    { url: '/internal/v2/asset/run/media/' + 'a'.repeat(64), bodyFile: 'C:\\secret.txt' },
    { url: '/internal/v2/asset/run/media/' + 'a'.repeat(64), accountId: 'other' },
    { url: '/internal/v2/asset/run/media/' + 'a'.repeat(64), headers: { 'x-forwarded-for': '127.0.0.1' } },
  ]) await assert.rejects(transport.request({ assetHandleId: 'missing', method: 'GET', requestId: 'request_123',
    context: {}, ...input }), code('run-asset-body-invalid'));
  assert.equal(client.instanceIdentity(), null);
  await transport.close();
  await resources.close();
  client.close();
});

test('issue signs the actual descriptor text and invalid run-asset body never starts registration', async () => {
  const body = { projectId: 'sp1', runGrantId: 'grant1', action: 'read', requestId: 'request_123',
    purpose: 'openRead', selector: { mediaId: 'media1', tier: 'original' } };
  const bodyText = `  ${JSON.stringify(body)}\n`;
  const descriptor = runAssetIssueRequest({ body, bodyText });
  assert.equal(descriptor.bodyText, bodyText);
  assert.equal(descriptor.bodyDigest, bytesDigest(Buffer.from(bodyText, 'utf8')));
  assert.notEqual(descriptor.bodyDigest, bytesDigest(Buffer.from(JSON.stringify(body))));
  assert.throws(() => runAssetIssueRequest({ body, bodyText: JSON.stringify({ ...body, action: 'write' }) }),
    code('run-asset-body-invalid'));
  const client = createRunClient({ origin: 'https://doc.example/',
    tls: { key: 'fixture-key', cert: 'fixture-cert', ca: 'fixture-ca' }, serverFingerprint256: 'b'.repeat(64) });
  try { await assert.rejects(client.issueRunAsset({ ...body, accountId: 'forged' }), code('run-asset-body-invalid')); }
  finally { client.close(); }
});
