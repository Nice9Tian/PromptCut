import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import { openAccountLedger } from '../account/ledger.mjs';
import { certificateFingerprint } from '../account/client.mjs';
import { createAgentInstanceAuthority, instanceTlsBinding } from '../account/agent-instance-authority.mjs';
import { createAgentInstanceInternalHandler, instanceRequestProof } from '../account/agent-instance-internal.mjs';
import { assetHttpTuple, bytesDigest, decodeRunAssetBody, requestProof, resourceRevision,
  runAssetIssueRequest, ticketDigest } from '../account/run-asset-protocol.mjs';
import { createRunClient } from '../agent-service/run-client.mjs';
import { createRunAssetTransport } from '../agent-service/run-asset-transport.mjs';
import { createRunResources } from '../agent/service/run-resources.mjs';
import { assetWiringPki } from './fixtures/asset-wiring-pki.mjs';

const projectId = 'project_asset_worker', runGrantId = 'grant_asset_worker';
const hash = bytesDigest(Buffer.from('asset bytes'));
const assetRef = Object.freeze({ projectId, ns: 'media', hash, size: 11, contentType: 'text/plain', ext: 'txt' });
const clientBytes = Buffer.from('asset bytes');
const largeBytes = Buffer.alloc(512 * 1024, 7);
const largeHash = bytesDigest(largeBytes);
const largeRef = Object.freeze({ projectId, ns: 'media', hash: largeHash, size: largeBytes.length,
  contentType: 'application/octet-stream', ext: 'bin' });
const reply = (res, status, value) => {
  if (!res.destroyed && !res.writableEnded) {
    res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
    res.end(JSON.stringify(value));
  }
};
const collect = async req => { const chunks = []; for await (const part of req) chunks.push(part); return Buffer.concat(chunks); };
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => server.close(resolve));

test('same Agent RAM key signs actual doc issue and asset bytes on their distinct mTLS exporters',
  { timeout: 45000 }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-run-asset-worker-tls-'));
    const pki = assetWiringPki(dir);
    const ledger = openAccountLedger({ file: path.join(dir, 'doc.db'), authorityId: 'doc-asset-worker' });
    const sockets = new Map(), socketIds = new WeakMap(), liveDoc = new Set(), liveAsset = new Set();
    let serial = 0, expectedContext, capturedHeaders, capturedTuple, capturedPutHeaders, capturedPutTuple;
    let currentFence = 1, currentState = 'active';
    const tickets = new Map(), uploadChunks = new Map();
    let doc, asset, runClient, resources, transport;
    const servicePrincipal = socket => {
      let authenticationId = socketIds.get(socket);
      if (!authenticationId) {
        authenticationId = `asset-worker-auth-${++serial}`;
        socketIds.set(socket, authenticationId); sockets.set(authenticationId, socket);
        socket.once('close', () => sockets.delete(authenticationId));
      }
      return { service: 'agent', serviceKid: 'worker-asset-kid', authenticationId };
    };
    const instances = createAgentInstanceAuthority({ ledger, verifyTransportInState(_state, principal) {
      const socket = sockets.get(principal.authenticationId);
      return { serviceId: 'agent', serviceKid: principal.serviceKid,
        authenticationId: principal.authenticationId, channelBinding: instanceTlsBinding(socket) };
    } });
    t.after(async () => {
      await transport?.close(); await resources?.close(); runClient?.close();
      for (const socket of [...liveDoc, ...liveAsset]) socket.destroy();
      if (doc?.listening) await close(doc);
      if (asset?.listening) await close(asset);
      instances.close(); ledger.close(); fs.rmSync(dir, { recursive: true, force: true });
      t.diagnostic(`owned-doc-tls=${liveDoc.size}; owned-asset-tls=${liveAsset.size}; live-auth=${sockets.size}`);
    });
    const registration = createAgentInstanceInternalHandler({ instanceAuthority: instances,
      agentFingerprint256: pki.asset.fingerprint256,
      resolveServicePrincipal: async ({ socket }) => servicePrincipal(socket) });
    doc = https.createServer({ key: pki.doc.key, cert: pki.doc.cert, ca: pki.ca,
      requestCert: true, rejectUnauthorized: true }, async (req, res) => {
      if (await registration(req, res)) return;
      try {
        if (req.method !== 'POST' || req.url !== '/internal/v2/run-assets/issue' ||
            certificateFingerprint(req.socket.getPeerCertificate().fingerprint256) !== certificateFingerprint(pki.asset.fingerprint256))
          throw Object.assign(Error('service-forbidden'), { status: 403, code: 'service-forbidden' });
        const { body, bodyText } = decodeRunAssetBody(await collect(req));
        const descriptor = runAssetIssueRequest({ body, bodyText });
        const cap = instances.authenticate({ servicePrincipal: servicePrincipal(req.socket), method: req.method,
          path: req.url, operation: 'checkAccess', request: descriptor, proof: instanceRequestProof(req) });
        try {
          assert.equal(body.projectId, projectId); assert.equal(body.runGrantId, runGrantId);
          const resource = body.selector?.mediaId === 'large_asset_worker' ? largeRef : assetRef;
          const ticket = randomBytes(32).toString('base64url');
          tickets.set(ticket, { body, resource });
          reply(res, 200, { ok: true, result: { ticket, ticketId: `ticket_worker_${tickets.size}`,
            expiresAt: Date.now() + 60000, resource, resourceRev: resourceRevision(resource),
            ...(body.purpose === 'openRead' ? { mediaRev: 'b'.repeat(64), projectRev: 2, kind: 'image' } : {}),
            fenceRevision: currentFence, grantState: currentState, docEpoch: 'epoch_worker' } });
        } finally { instances.release(cap.instanceSession); }
      } catch (error) { reply(res, error.status ?? 503, { ok: false, code: error.code ?? 'doc-issue-failed' }); }
    });
    doc.on('secureConnection', socket => { liveDoc.add(socket); socket.once('close', () => liveDoc.delete(socket)); });
    const docPort = await listen(doc);
    asset = https.createServer({ key: pki.account.key, cert: pki.account.cert, ca: pki.ca,
      requestCert: true, rejectUnauthorized: true }, async (req, res) => {
      try {
        if (certificateFingerprint(req.socket.getPeerCertificate().fingerprint256) !== certificateFingerprint(pki.asset.fingerprint256))
          throw Object.assign(Error('service-forbidden'), { status: 403, code: 'service-forbidden' });
        const bytes = await collect(req);
        const h = req.headers;
        const ticket = /^Bearer ([A-Za-z0-9_-]+)$/.exec(h.authorization ?? '')?.[1];
        const issued = tickets.get(ticket);
        if (!issued) throw Object.assign(Error('ticket-invalid'), { status: 401, code: 'ticket-invalid' });
        const { body: issueBody, resource } = issued;
        const mediaRoot = `/internal/v2/asset/run/media/${resource.hash}`;
        const action = issueBody.purpose === 'import' ? 'write' : 'read';
        const matchChunk = /^\/internal\/v2\/asset\/run\/media\/[a-f0-9]{64}\/(0|[1-9][0-9]*)$/.exec(req.url);
        const tuple = assetHttpTuple({ projectId: h['x-promptcut-run-project-id'],
          runGrantId: h['x-promptcut-run-grant-id'], resourceRev: h['x-promptcut-run-resource-rev'],
          nonce: h['x-promptcut-run-nonce'], requestId: h['x-promptcut-run-request-id'],
          ticketDigest: ticketDigest(ticket), action, method: req.method, url: req.url,
          range: h.range ?? null, contentLength: bytes.length, contentDigest: bytesDigest(bytes),
          contentType: h['content-type'] ?? null,
          ...(h['x-promptcut-run-import-id'] ? { importId: h['x-promptcut-run-import-id'] } : {}),
          ...(matchChunk ? { chunkIndex: Number(matchChunk[1]) } : {}) });
        const proof = requestProof(JSON.parse(Buffer.from(h['x-promptcut-run-asset-proof'] ?? '', 'base64url').toString('utf8')));
        const cap = instances.authenticate({ servicePrincipal: servicePrincipal(req.socket), method: req.method,
          path: req.url, operation: 'checkAccess', request: tuple, proof });
        try {
          assert.equal(tuple.projectId, projectId); assert.equal(tuple.runGrantId, runGrantId);
          assert.equal(tuple.resourceRev, resourceRevision(resource));
          if (issueBody.purpose === 'openRead' && ['GET', 'HEAD'].includes(req.method) && req.url === mediaRoot) {
            assert.equal(bytes.length, 0);
            const actual = resource.hash === largeHash ? largeBytes : clientBytes;
            const range = h.range === 'bytes=0-4';
            const payload = range ? actual.subarray(0, 5) : actual;
            if (req.method === 'GET' && !range && resource.hash === hash && !capturedHeaders) {
              capturedHeaders = { ...h }; capturedTuple = tuple;
            }
            res.writeHead(range ? 206 : 200, { 'content-type': resource.contentType,
              'content-length': payload.length, ...(range ? { 'content-range': `bytes 0-4/${actual.length}` } : {}),
              connection: 'close' });
            res.end(req.method === 'HEAD' ? undefined : payload);
          } else if (issueBody.purpose === 'import' && req.method === 'PUT' &&
              req.url === `${mediaRoot}/0` && tuple.importId === issueBody.selector.importId &&
              tuple.chunkIndex === 0 && tuple.contentDigest === bytesDigest(bytes)) {
            capturedPutHeaders = { ...h }; capturedPutTuple = tuple;
            uploadChunks.set(tuple.importId, bytes);
            reply(res, 200, { ok: true, result: { received: bytes.length, complete: false } });
          } else if (issueBody.purpose === 'import' && req.method === 'POST' &&
              req.url === `${mediaRoot}/complete` && tuple.importId === issueBody.selector.importId &&
              uploadChunks.get(tuple.importId)?.equals(clientBytes)) {
            reply(res, 200, { ok: true, result: { assetRef: resource, resourceRev: resourceRevision(resource) } });
          } else if (issueBody.purpose === 'verifyRef' && req.method === 'POST' &&
              req.url === '/internal/v2/asset/run/refs/verify') {
            reply(res, 200, { ok: true, result: { assetRef: resource, resourceRev: resourceRevision(resource) } });
          } else throw Object.assign(Error('resource-scope-mismatch'), { status: 403, code: 'resource-scope-mismatch' });
        } finally { instances.release(cap.instanceSession); }
      } catch (error) { reply(res, error.status ?? 503, { ok: false, code: error.code ?? 'asset-request-failed' }); }
    });
    asset.on('secureConnection', socket => { liveAsset.add(socket); socket.once('close', () => liveAsset.delete(socket)); });
    const assetPort = await listen(asset);
    t.diagnostic(`owned-pid=${process.pid}; doc-port=${docPort}; asset-port=${assetPort}`);
    runClient = createRunClient({ origin: `https://127.0.0.1:${docPort}/`, tls: pki.asset,
      serverFingerprint256: pki.doc.fingerprint256 });
    const instance = await runClient.registerInstance();
    expectedContext = Object.freeze({ projectId, conversationId: 'conversation_asset_worker',
      runId: 'run_asset_worker', runGrantId, instanceId: instance.instanceId,
      instanceGeneration: instance.instanceGeneration, senderAccountId: 'sender_asset_worker',
      messageId: 'message_asset_worker' });
    // Controlled run ACL is deliberately limited to this worker crypto/closure fixture;
    // it is not a substitute for the real doc run provider in A/B integration.
    const contextAccess = {
      fromGrant: async () => expectedContext,
      async authorize(context, action) {
        if (JSON.stringify(context) !== JSON.stringify(expectedContext) || !['read', 'write'].includes(action) ||
            (currentState === 'retained' && action === 'write'))
          throw Object.assign(Error('run-revoked'), { status: 403, code: 'run-revoked' });
        return { allowed: true, fenceRevision: currentFence, grantState: currentState };
      },
    };
    resources = createRunResources({ contextAccess });
    transport = createRunAssetTransport({ runClient, resources, assetOrigin: `https://127.0.0.1:${assetPort}/`,
      assetTls: pki.asset, assetFingerprint256: pki.account.fingerprint256 });
    const issued = await transport.issue({ context: expectedContext, purpose: 'openRead',
      selector: { mediaId: 'media_asset_worker', tier: 'original' }, requestId: 'issue_asset_worker' });
    assert.equal(issued.resourceRev, resourceRevision(assetRef));
    assert.deepEqual([issued.mediaRev, issued.projectRev, issued.kind], ['b'.repeat(64), 2, 'image']);
    assert.equal(Object.hasOwn(issued, 'ticket'), false);
    const result = await transport.request({ context: expectedContext, assetHandleId: issued.assetHandleId,
      method: 'GET', url: `/internal/v2/asset/run/media/${hash}`, requestId: 'fetch_asset_worker' });
    assert.equal(result.status, 200);
    const chunks = []; for await (const part of result.stream) chunks.push(part);
    assert.deepEqual(Buffer.concat(chunks), clientBytes);
    await result.closed;
    assert.equal(capturedTuple.contentDigest, bytesDigest(Buffer.alloc(0)));
    assert.equal(liveDoc.size, 0); assert.equal(liveAsset.size, 0);
    const head = await transport.request({ context: expectedContext, assetHandleId: issued.assetHandleId,
      method: 'HEAD', url: `/internal/v2/asset/run/media/${hash}`, requestId: 'head_asset_worker' });
    assert.equal(head.status, 200); assert.equal(head.headers['content-length'], String(clientBytes.length));
    for await (const _ of head.stream) { assert.fail('HEAD returned bytes'); }
    await head.closed;
    const ranged = await transport.request({ context: expectedContext, assetHandleId: issued.assetHandleId,
      method: 'GET', url: `/internal/v2/asset/run/media/${hash}`, range: 'bytes=0-4',
      requestId: 'range_asset_worker' });
    assert.equal(ranged.status, 206); assert.equal(ranged.headers['content-range'], 'bytes 0-4/11');
    const rangedParts = []; for await (const part of ranged.stream) rangedParts.push(part);
    assert.deepEqual(Buffer.concat(rangedParts), clientBytes.subarray(0, 5)); await ranged.closed;

    const imported = await transport.issue({ context: expectedContext, purpose: 'import',
      selector: { hash, size: clientBytes.length, ext: 'txt', name: 'worker.txt', kind: 'image',
        importId: 'import_asset_worker' }, requestId: 'issue_import_worker' });
    const put = await transport.request({ context: expectedContext, assetHandleId: imported.assetHandleId,
      method: 'PUT', url: `/internal/v2/asset/run/media/${hash}/0`, requestId: 'put_asset_worker',
      importId: 'import_asset_worker', chunkIndex: 0, contentType: 'text/plain', body: clientBytes });
    assert.equal(put.status, 200);
    const putParts = []; for await (const part of put.stream) putParts.push(part);
    assert.equal(JSON.parse(Buffer.concat(putParts).toString()).result.received, clientBytes.length);
    await put.closed;
    // A correctly signed tuple for the old bytes cannot authorize changed bytes on this new TLS socket.
    const altered = Buffer.from(clientBytes); altered[0] ^= 1;
    const changedBody = await new Promise((resolve, reject) => {
      const req = https.request({ host: '127.0.0.1', port: assetPort,
        path: `/internal/v2/asset/run/media/${hash}/0`, method: 'PUT', key: pki.asset.key,
        cert: pki.asset.cert, ca: pki.ca, minVersion: 'TLSv1.3', agent: false,
        headers: { ...capturedPutHeaders, connection: 'close' } }, res => {
        const parts = []; res.on('data', part => parts.push(part));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(parts) }));
      });
      req.on('error', reject);
      req.on('socket', socket => socket.once('secureConnect', () => {
        const proof = runClient.runAssetHttpProofFor({ socket, tuple: capturedPutTuple });
        req.setHeader(proof.name, proof.value); req.end(altered);
      }));
    });
    assert.equal(changedBody.status, 403);
    assert.equal(JSON.parse(changedBody.body.toString('utf8')).code, 'instance-proof-invalid');
    const completeBody = Buffer.from(JSON.stringify({ importId: 'import_asset_worker' }));
    const complete = await transport.request({ context: expectedContext, assetHandleId: imported.assetHandleId,
      method: 'POST', url: `/internal/v2/asset/run/media/${hash}/complete`, requestId: 'complete_asset_worker',
      importId: 'import_asset_worker', contentType: 'application/json', body: completeBody });
    assert.equal(complete.status, 200);
    for await (const _ of complete.stream) { /* Consume the actual JSON envelope. */ }
    await complete.closed;
    const verified = await transport.issue({ context: expectedContext, purpose: 'verifyRef',
      selector: { hash, size: clientBytes.length }, requestId: 'issue_verify_worker' });
    const verify = await transport.request({ context: expectedContext, assetHandleId: verified.assetHandleId,
      method: 'POST', url: '/internal/v2/asset/run/refs/verify', requestId: 'verify_worker',
      contentType: 'application/json', body: Buffer.from('{}') });
    assert.equal(verify.status, 200); for await (const _ of verify.stream) { /* Body is scoped JSON. */ }
    await verify.closed;

    currentFence = 2; currentState = 'retained';
    const retained = await transport.request({ context: expectedContext, assetHandleId: issued.assetHandleId,
      method: 'GET', url: `/internal/v2/asset/run/media/${hash}`, requestId: 'retained_read_worker' });
    assert.equal(retained.status, 200);
    const retainedParts = []; for await (const part of retained.stream) retainedParts.push(part);
    assert.deepEqual(Buffer.concat(retainedParts), clientBytes); await retained.closed;
    await assert.rejects(transport.request({ context: expectedContext, assetHandleId: imported.assetHandleId,
      method: 'PUT', url: `/internal/v2/asset/run/media/${hash}/0`, requestId: 'retained_write_worker',
      importId: 'import_asset_worker', chunkIndex: 0, body: clientBytes }), /run-revoked|unauthorized/);

    // Exact proof from the previous TLS exporter cannot be replayed on a new socket.
    const replay = await new Promise((resolve, reject) => {
      const req = https.request({ host: '127.0.0.1', port: assetPort,
        path: `/internal/v2/asset/run/media/${hash}`, method: 'GET', key: pki.asset.key,
        cert: pki.asset.cert, ca: pki.ca, minVersion: 'TLSv1.3', agent: false,
        headers: { ...capturedHeaders, connection: 'close' } }, res => {
        const parts = []; res.on('data', part => parts.push(part));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(parts) }));
      });
      req.on('error', reject); req.end();
    });
    assert.equal(replay.status, 403);
    assert.equal(JSON.parse(replay.body.toString('utf8')).code, 'instance-proof-invalid');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(liveAsset.size, 0);

    const large = await transport.issue({ context: expectedContext, purpose: 'openRead',
      selector: { mediaId: 'large_asset_worker', tier: 'original' }, requestId: 'issue_large_worker' });
    const blocked = await transport.request({ context: expectedContext, assetHandleId: large.assetHandleId,
      method: 'GET', url: `/internal/v2/asset/run/media/${largeHash}`, requestId: 'backpressure_worker' });
    assert.equal(blocked.status, 200);
    // Deliberately leave the output unread. The registry must close both sides of the real TLS stream.
    const receipt = await resources.abortForFence(expectedContext, 'stop');
    await blocked.closed;
    assert.equal(receipt.complete, false); // No child-tree witness was supplied.
    assert.equal(liveAsset.size, 0);
  });
