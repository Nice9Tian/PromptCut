import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { assetWiringPki } from './fixtures/asset-wiring-pki.mjs';
import { runFixture, projectId, conversationId } from './run-authority-fixture.mjs';
import { createRunAuthority, canonicalReadRecord } from '../account/run-authority.mjs';
import { createAgentInstanceAuthority, instanceTlsBinding, instanceProofPayload } from '../account/agent-instance-authority.mjs';
import { createAgentInstanceInternalHandler, INSTANCE_PROOF_HEADER, instanceRequestProof } from '../account/agent-instance-internal.mjs';
import { createRunInternalHandler } from '../account/run-internal.mjs';
import { createRunAssets } from '../account/run-assets.mjs';
import { createRunAssetsInternalHandler } from '../account/run-assets-internal.mjs';
import { canonicalJson, digestOf } from '../account/ledger.mjs';
import { certificateFingerprint } from '../account/client.mjs';
import { assetHttpTuple, bytesDigest, ticketDigest, runAssetIssueRequest, RUN_ASSET_PROOF_HEADER } from '../account/run-asset-protocol.mjs';
import { createProjectAssetStores } from '../asset-store/project-stores.mjs';
import { createAssetRunClient } from '../hosted/asset-run-client.mjs';
import { createAssetRunAccess, createAssetRunConsumer } from '../hosted/asset-run-access.mjs';

// Actual TLS/cryptography/SQLite/run gates, three distinct role certificates.
// Account sender/current registry/media projection remain controlled adapters.
// Both servers are in this test process: NOT an independent UID/OS closure proof.
test('real TLS project data entry imports physical bytes and rechecks exact registered run; retained and revoked boundaries', { timeout: 60000 }, async t => {
  const f = await runFixture(), pki = assetWiringPki(f.dir), keys = generateKeyPairSync('ed25519');
  const agentPin = certificateFingerprint(pki.account.fingerprint256), assetPin = certificateFingerprint(pki.asset.fingerprint256);
  const serviceKid = 'mtls-agent-key', resource = { projectId, ns: 'media', hash: bytesDigest(Buffer.from('audio')),
    size: 5, ext: 'wav', contentType: 'audio/wav' };
  const subjects = new WeakMap(), connectionIds = new WeakMap(), sockets = new Set(), socketCloses = new Set();
  let rawRun, assets, registration, lastDataProof, consumer, dataAccess, runClient;
  const stores = createProjectAssetStores({ dir: path.join(f.dir, 'asset-data'), chunkSize: 2 });
  const agents = [], servers = [];
  const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  const pinned = (socket, pin) => socket && !socket.destroyed && socket.authorized === true &&
    certificateFingerprint(socket.getPeerCertificate().fingerprint256) === pin;
  const transport = socket => {
    if (!pinned(socket, agentPin)) throw new Error('fixture-agent-pin');
    const token = {}, subject = { service: 'agent', serviceKid, transportToken: token };
    subjects.set(token, { socket, direct: true }); return subject;
  };
  const verified = subject => {
    const value = subjects.get(subject?.transportToken);
    if (!value || !pinned(value.socket, value.direct ? agentPin : assetPin)) throw new Error('fixture-current-transport');
    return value;
  };
  const instanceAuthority = createAgentInstanceAuthority({ ledger: f.ledger,
    verifyTransportInState(_s, subject) {
      const value = verified(subject);
      return { serviceId: 'agent', serviceKid,
        authenticationId: value.authenticationId ?? connectionIds.get(value.socket),
        channelBinding: value.binding ?? instanceTlsBinding(value.socket) };
    } });
  rawRun = createRunAuthority({ ledger: f.ledger, conversationHooks: f.hooks, instanceAuthority,
    verifyServiceInState: (_s, subject) => { verified(subject); return { serviceId: 'agent', serviceKid }; },
    verifySender: async ref => {
      if (f.ledger.read().revokedLogins[`login:${ref.loginId}`]) throw new Error('credential-revoked');
      return { ...ref, accountEventSeq: f.ledger.read().accountHead };
    }, synchronize: async () => {}, now: () => f.clock.now });
  const invocation = ({ servicePrincipal, req, body, operation, proof, method, path, request }) => {
    const cap = instanceAuthority.authenticate({ servicePrincipal, method: method ?? req.method,
      path: path ?? req.url, operation, request: request ?? body, proof: proof ?? instanceRequestProof(req) });
    return { servicePrincipal: { ...servicePrincipal, ...cap }, release: () => instanceAuthority.release(cap.instanceSession) };
  };
  const observerOf = observer => {
    if (!pinned(observer.socket, assetPin) || observer.assetInstanceId !== 'asset-live-test' || observer.serviceIdentity !== 'asset-key-test')
      throw new Error('fixture-observer-forbidden');
    return observer;
  };
  assets = createRunAssets({ ledger: f.ledger, runProvider: rawRun, ticketTtlMs: 10000, now: () => f.clock.now,
    authenticateDirect: args => invocation({ ...args, servicePrincipal: transport(args.transport.socket) }),
    authenticateObserved(args) {
      observerOf(args.observer);
      if (args.observation.agentFingerprint256 !== agentPin || args.observation.agentServiceKid !== serviceKid)
        throw new Error('fixture-observed-agent');
      const token = {}, subject = { service: 'agent', serviceKid, transportToken: token };
      subjects.set(token, { socket: args.observer.socket, authenticationId: args.observation.authenticationId,
        binding: args.observation.channelBinding, direct: false });
      return invocation({ ...args, servicePrincipal: subject });
    }, verifyObserver: observerOf,
    resolveMedia: async () => ({ resource, mediaRev: digestOf(resource), projectRev: 1 }),
    verifyLeaseClosure: async ({ lease, receipt }) => {
      const witness = consumer.closureWitness(lease.leaseId);
      return witness.assetInstanceId === lease.assetInstanceId && witness.serviceIdentity === lease.serviceIdentity &&
        digestOf(witness.receipt) === digestOf(receipt) && witness.binding.runGrantId === lease.grantBinding.runGrantId;
    },
    verifyControlReceipt: async ({ event, receipt }) => digestOf(consumer.controlWitness(event.eventId).receipt) === digestOf(receipt) });
  const instances = createAgentInstanceInternalHandler({ instanceAuthority, agentFingerprint256: agentPin,
    resolveServicePrincipal: ({ socket }) => transport(socket) });
  const runs = createRunInternalHandler({ runAuthority: rawRun, agentFingerprint256: agentPin,
    resolveServicePrincipal: ({ socket }) => transport(socket), authenticateInvocation: invocation });
  const assetRoutes = createRunAssetsInternalHandler({ runAssets: assets, agentFingerprint256: agentPin,
    assetFingerprint256: assetPin, maxBodyBytes: 1024 * 1024,
    resolveObserver: ({ socket }) => { if (!pinned(socket, assetPin)) throw new Error('fixture-observer-forbidden');
      return { assetInstanceId: 'asset-live-test', serviceIdentity: 'asset-key-test' }; } });
  const server = https.createServer({ ...pki.doc, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3' }, async (req, res) => {
    if (!await instances(req, res) && !await runs(req, res) && !await assetRoutes(req, res)) json(res, 404, { ok: false });
  });
  function track(server) {
    servers.push(server); server.on('secureConnection', socket => {
      connectionIds.set(socket, randomUUID()); sockets.add(socket);
      const closed = once(socket, 'close').then(() => sockets.delete(socket)); socketCloses.add(closed);
    });
  }
  t.after(async () => {
    // Destroy owned data sockets first; their actual close drives the real
    // lease receipt RPC while the doc server is still available.
    for (const socket of sockets) if (certificateFingerprint(socket.getPeerCertificate()?.fingerprint256) === agentPin) socket.destroy();
    if (dataAccess) await dataAccess.close(); if (consumer) await consumer.close(); if (runClient) await runClient.close();
    for (const agent of agents) agent.destroy();
    for (const socket of sockets) socket.destroy();
    await Promise.all([...socketCloses]);
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    assets.close(); instanceAuthority.close(); f.close();
    fs.rmSync(f.dir, { recursive: true });
    assert.equal(sockets.size, 0); assert.ok(servers.every(s => s.listening === false));
    t.diagnostic('Actual teardown completed: owned TLS socket set empty, both HTTPS servers closed, TMP removed.');
  });
  track(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const docOrigin = `https://127.0.0.1:${server.address().port}`;
  const signValue = value => sign(null, Buffer.from(canonicalJson(value)), keys.privateKey).toString('base64url');
  const signRequest = (socket, method, path, request, operation = 'checkAccess') => ({
    instanceId: registration.instanceId, instanceGeneration: registration.instanceGeneration,
    signature: signValue(instanceProofPayload({ authorityId: f.ledger.authorityId, ...registration,
      channelBinding: instanceTlsBinding(socket), method, path, operation, requestDigest: digestOf(request) })) });
  function call(origin, path, identity, { body, bodyText, method = 'POST', request, operation, headerName = INSTANCE_PROOF_HEADER,
    agent = false, replay, headers = {} } = {}) {
    const bytes = Buffer.from(bodyText ?? (body === undefined ? '' : JSON.stringify(body)));
    return new Promise((resolve, reject) => {
      const req = https.request(`${origin}${path}`, { ...identity, method, agent, headers: {
        ...(method === 'POST' && origin === docOrigin ? { 'content-type': 'application/json', 'content-length': bytes.length } : {}), ...headers } }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.once('error', reject);
        res.once('end', () => { const data = Buffer.concat(chunks); let value;
          try { value = JSON.parse(data.toString()); } catch { value = data.toString(); }
          resolve({ status: res.statusCode, value }); });
      });
      req.setTimeout(10000, () => req.destroy(new Error('fixture-request-timeout')));
      req.once('error', reject); req.once('socket', socket => {
        const send = () => {
          try {
            const expected = origin === docOrigin ? pki.doc.fingerprint256 : pki.asset.fingerprint256;
            if (!pinned(socket, certificateFingerprint(expected))) throw new Error('fixture-server-pin');
            if (request) {
              const proof = replay ?? signRequest(socket, method, path, request, operation);
              if (headerName === RUN_ASSET_PROOF_HEADER) lastDataProof = proof;
              req.setHeader(headerName, Buffer.from(JSON.stringify(proof)).toString('base64url'));
            }
            req.end(bytes);
          } catch (error) { req.destroy(); reject(error); }
        };
        if (socket.encrypted && !socket.connecting && socket.authorized) send(); else socket.once('secureConnect', send);
      });
    });
  }
  runClient = createAssetRunClient({ origin: docOrigin, tls: pki.asset, serverFingerprint256: pki.doc.fingerprint256,
    timeoutMs: 10000, maxResponseBytes: 1024 * 1024 });
  consumer = createAssetRunConsumer({ client: runClient, file: path.join(f.dir, 'asset-run-state.json'),
    assetInstanceId: 'asset-live-test', serviceIdentity: 'asset-key-test', verifyLifecycle: async () => true });
  await consumer.start();
  dataAccess = createAssetRunAccess({ client: runClient, consumer, projectStores: stores,
    humanConsumer: { ready: true, sync: async () => {} }, assetInstanceId: 'asset-live-test', serviceIdentity: 'asset-key-test',
    agentFingerprint256: agentPin, resolveAgentTransport: ({ socket }) => {
      if (!pinned(socket, agentPin)) throw new Error('fixture-current-service'); return { serviceKid };
    }, maxBodyBytes: 1024 * 1024 });
  const assetServer = https.createServer({ ...pki.asset, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3' }, async (req, res) => {
    try { if (!await dataAccess.handler(req, res)) json(res, 404, { ok: false, code: 'no-route' }); }
    catch { res.destroy(); }
  });
  track(assetServer); assetServer.listen(0, '127.0.0.1'); await once(assetServer, 'listening');
  const assetOrigin = `https://127.0.0.1:${assetServer.address().port}`;
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const challengeResponse = await call(docOrigin, '/internal/v2/instances/challenge', pki.account,
    { body: { requestId: 'actual-register', publicKey } }); assert.equal(challengeResponse.status, 200);
  const challenge = challengeResponse.value.result;
  const registered = await call(docOrigin, '/internal/v2/instances/register', pki.account,
    { body: { challenge, signature: signValue(challenge) } }); assert.equal(registered.status, 200); registration = registered.value.result;
  f.enqueue(); const admitBody = { projectId, conversationId, requestId: 'actual-admit' };
  const admitted = await call(docOrigin, '/internal/v2/runs/admit', pki.account,
    { body: admitBody, request: admitBody, operation: 'admit' }); assert.equal(admitted.status, 200);
  const g = admitted.value.result, prompt = canonicalReadRecord(g.message, g);
  const readBody = { projectId, conversationId, messageId: g.messageId, runId: g.runId, runGrantId: g.runGrantId,
    requestId: 'actual-read', readIntentId: 'intent-live', prompt, promptDigest: digestOf(prompt) };
  assert.equal((await call(docOrigin, '/internal/v2/runs/read', pki.account,
    { body: readBody, request: readBody, operation: 'confirmRead' })).status, 200);
  const issueBody = { projectId, runGrantId: g.runGrantId, action: 'read', requestId: 'actual-issue',
    purpose: 'openRead', selector: { mediaId: 'media-live', tier: 'original' } };
  const issueText = JSON.stringify(issueBody), issueRequest = runAssetIssueRequest({ body: issueBody, bodyText: issueText });
  const issued = await call(docOrigin, '/internal/v2/run-assets/issue', pki.account,
    { bodyText: issueText, request: issueRequest }); assert.equal(issued.status, 200);
  assert.equal((await call(docOrigin, '/internal/v2/run-assets/issue', pki.account,
    { bodyText: ` ${issueText}`, request: issueRequest })).status, 403);
  assert.equal((await call(docOrigin, '/internal/v2/run-assets/issue', pki.wrong,
    { bodyText: issueText })).status, 403);
  async function issue(purpose, selector, requestId) {
    const body = { projectId, runGrantId: g.runGrantId, action: purpose === 'import' ? 'write' : 'read', purpose, selector, requestId };
    const bodyText = JSON.stringify(body);
    const response = await call(docOrigin, '/internal/v2/run-assets/issue', pki.account,
      { bodyText, request: runAssetIssueRequest({ body, bodyText }) }); assert.equal(response.status, 200); return response.value.result;
  }
  async function data(handle, nonce, { method = 'GET', suffix = '', bodyText = '', range = null, replay, importId, verify = false,
    tamperHeaders = {}, wireBodyText = bodyText } = {}) {
    const url = verify ? '/internal/v2/asset/run/refs/verify' : `/internal/v2/asset/run/media/${resource.hash}${suffix}`;
    const request = assetHttpTuple({ projectId, runGrantId: g.runGrantId, action: handle === write ? 'write' : 'read',
      ticketDigest: ticketDigest(handle.ticket), resourceRev: handle.resourceRev, nonce, requestId: `read-${nonce}`,
      method, url, range, contentLength: Buffer.byteLength(bodyText), contentDigest: bytesDigest(Buffer.from(bodyText)),
      contentType: method === 'POST' && verify ? 'application/json' : null,
      ...(importId ? { importId } : {}), ...(method === 'PUT' ? { chunkIndex: Number(suffix.slice(1)) } : {}) });
    const response = await call(assetOrigin, url, pki.account, { method, request, replay, bodyText: wireBodyText,
      headerName: RUN_ASSET_PROOF_HEADER, headers: { authorization: `Bearer ${handle.ticket}`,
        'content-length': String(Buffer.byteLength(wireBodyText)),
        'x-promptcut-run-project-id': projectId, 'x-promptcut-run-grant-id': g.runGrantId,
        'x-promptcut-run-resource-rev': handle.resourceRev, 'x-promptcut-run-nonce': nonce,
        'x-promptcut-run-request-id': request.requestId,
        ...(importId ? { 'x-promptcut-run-import-id': importId } : {}),
        ...(range ? { range } : {}), ...(request.contentType ? { 'content-type': request.contentType } : {}), ...tamperHeaders } });
    await dataAccess.idle(); return response;
  }
  const write = await issue('import', { hash: resource.hash, size: 5, ext: 'wav', name: 'voice.wav', kind: 'audio', importId: 'real-import' }, 'issue-import');
  assert.equal((await data(issued.value.result, 'missing-read')).status, 404);
  assert.equal(await stores.store('another-project', 'media').stat(resource.hash), null);
  for (let n = 0; n < 3; n++) {
    const response = await data(write, `put-${n}`, { method: 'PUT', suffix: `/${n}`, bodyText: 'audio'.slice(n * 2, n * 2 + 2), importId: 'real-import' });
    assert.equal(response.status, 200);
  }
  assert.equal((await data(write, 'complete', { method: 'POST', suffix: '/complete', importId: 'real-import' })).status, 200);
  assert.equal((await stores.store(projectId, 'media').stat(resource.hash)).size, 5);
  assert.equal(await stores.store('another-project', 'media').stat(resource.hash), null);
  assert.deepEqual(await data(issued.value.result, 'nonce-one'), { status: 200, value: 'audio' }); const originalProof = lastDataProof;
  assert.equal((await data(issued.value.result, 'nonce-head', { method: 'HEAD' })).status, 200);
  assert.deepEqual(await data(issued.value.result, 'nonce-range', { range: 'bytes=1-3' }), { status: 206, value: 'udi' });
  assert.equal((await data(issued.value.result, 'nonce-two', { replay: originalProof })).status, 403);
  assert.equal((await data(issued.value.result, 'nonce-one')).status, 403);
  assert.equal((await data(issued.value.result, 'wrong-project', { tamperHeaders: { 'x-promptcut-run-project-id': 'another-project' } })).status, 403);
  const verifyHandle = await issue('verifyRef', { hash: resource.hash, size: 5 }, 'issue-verify');
  const verifyBody = JSON.stringify({ projectId, hash: resource.hash, size: 5 });
  assert.equal((await data(verifyHandle, 'verify', { method: 'POST', verify: true, bodyText: verifyBody })).status, 200);
  assert.equal((await data(verifyHandle, 'wire-tamper', { method: 'POST', verify: true, bodyText: verifyBody, wireBodyText: ` ${verifyBody}` })).status, 403);
  rawRun.applyAccessEvent(f.exit()); assert.equal((await data(issued.value.result, 'nonce-retained')).status, 200);
  rawRun.fence({ kind: 'stop', requestId: 'actual-stop', projectId, runId: g.runId });
  await consumer.sync(); assert.equal((await data(issued.value.result, 'nonce-stopped')).status, 403);
  assert.ok(Object.values(f.ledger.read().runAssetLeasesV1).every(l => l.state === 'closed'));
  t.diagnostic(`Actual doc/asset ephemeral ports ${server.address().port}/${assetServer.address().port}; all owned TLS sockets and servers close in teardown. No keys/tickets/proofs/exporters emitted.`);
});
