import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import https from 'node:https';
import { createHash, randomBytes, generateKeyPairSync } from 'node:crypto';
import { startHostedCombo } from '../hosted/combo.mjs';
import { stageHostedAssetFiles } from '../hosted/files.mjs';
import { createAssetDocClient, createAssetReadyProbe } from '../hosted/asset-doc-client.mjs';
import { StreamStore } from '../asset-store/stream-store.mjs';
import { publicationMarker } from '../asset-store/project-io.mjs';
import { assetWiringPki } from './fixtures/asset-wiring-pki.mjs';

const providerDir = process.env.PROMPTCUT_ACCOUNT_PROVIDER_ROOT ?? 'C:/Users/admin/Documents/VisuHive/.worktrees/018-account-foundation';
const available = fs.existsSync(path.join(providerDir, 'account/internal.mjs'));
const close = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); });
const waitFor = async (check, label, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 25)); } throw Error(`timeout: ${label}`); };
const web = async (origin, method, route, body, token) => { const res = await fetch(origin + route, { method, signal: AbortSignal.timeout(5000),
  headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: res.status, body: await res.json() }; };
const wav = () => { const b = Buffer.alloc(44 + 4800 * 2); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(48000, 24); b.writeUInt32LE(96000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(b.length - 44, 40); for (let i = 0; i < 4800; i++) b.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 48000) * 16000), 44 + i * 2); return b; };

test('真实provider→combo→独立stage asset入口：mTLS/head就绪、全读写隔离、PCM/stream/thumb与重启', { skip: !available && 'frozen account provider unavailable', timeout: 60000 }, async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pc-asset-wire-real-'));
  let accountServer, combo, provider, proxy, child, childClosed, stdout = '', stderr = '';
  const children = [];
  t.after(async () => { for (const c of children) { if (c.exitCode === null && c.signalCode === null) c.kill(); await c.closed; }
    if (proxy?.listening) await close(proxy); await combo?.close(); if (accountServer?.listening) await close(accountServer); provider?.close();
    const childLog = path.join(os.tmpdir(), `promptcut-asset-wiring-entry-child-${Date.now()}.log`); await fsp.writeFile(childLog, stdout + stderr); t.diagnostic(childLog);
    await fsp.rm(dir, { recursive: true, force: true }); });
  const pki = assetWiringPki(dir), modules = await Promise.all(['store', 'credentials', 'internal'].map(n => import(pathToFileURL(path.join(providerDir, `account/${n}.mjs`)))));
  provider = modules[0].openStore(path.join(dir, 'provider.sqlite'));
  const credentials = modules[1].createCredentials({ store: provider, key: randomBytes(32) });
  const ids = ['acc_0123456789abcdef01234567', 'acc_abcdef0123456789abcdef01'];
  const editors = ids.map((id, i) => { provider.createAccount({ id, name: `Asset Fixture ${i}`, nameKey: `asset-fixture-${i}`, pw: 'fixture-only', now: Date.now() }); return credentials.createEditor({ account: provider.accountById(id), deviceId: `asset-device-${i}`, requestId: `asset-login-${i}` }); });
  accountServer = modules[2].createInternalServer({ tls: pki.account, store: provider, credentials, services: [{ serviceId: 'doc', fingerprint256: pki.doc.fingerprint256 }] });
  await new Promise(resolve => accountServer.listen(5860, '127.0.0.1', resolve));
  const docDir = path.join(dir, 'doc'), assetDir = path.join(dir, 'asset'), app = path.join(dir, 'app'); await fsp.mkdir(docDir); await fsp.mkdir(assetDir); stageHostedAssetFiles(path.resolve('.'), app);
  const authorityId = 'asset-wire-doc', statusConfig = { origin: 'https://127.0.0.1:5864', tls: pki.doc, serverFingerprint256: pki.asset.fingerprint256 };
  combo = await startHostedCombo({ dataDir: docDir, docPort: 5861, assetPort: 5869, host: '127.0.0.1', trustLoopback: false, clusterToken: 'fixture-cluster-token-32-characters',
    accountRequired: true, assetPublicUrl: 'http://127.0.0.1:5863/api/asset', assetStatus: statusConfig,
    account: { origin: 'https://127.0.0.1:5860', clientTls: pki.doc, serverFingerprint256: pki.account.fingerprint256, authorityId,
      authorityUrl: 'https://fixture.invalid/editor', signingKey: generateKeyPairSync('ed25519').privateKey, keyId: 'fixture', internalTls: pki.doc, internalPort: 5862,
      services: [{ serviceId: 'asset', fingerprint256: pki.asset.fingerprint256 }] } });
  assert.equal(combo.assetPort, null, 'combo does not mount v1 public assets in account mode');
  const origin = 'http://127.0.0.1:5861', assetOrigin = 'http://127.0.0.1:5863';
  const projects = [];
  for (let i = 0; i < 2; i++) { const created = await web(origin, 'POST', '/hosted/shared/account/create', { name: `Project ${i}`, requestId: `create-${i}`, allowLinkJoin: true, initialProject: { tracks: [] } }, editors[i].accessToken); assert.equal(created.status, 201, JSON.stringify(created.body)); projects.push(created.body.projectId); }
  const session = (i, requestId) => web(origin, 'POST', '/hosted/shared/account/session', { projectId: projects[i], deviceId: `asset-device-${i}`, requestId }, editors[i].accessToken);
  assert.equal((await session(0, 'before-asset')).status, 503);
  assert.equal((await web(origin, 'POST', '/hosted/shared/account/join', { projectId: projects[0], requestId: 'unready-join' }, editors[1].accessToken)).status, 503);
  assert.equal(combo.accountRuntime.authority.listProjects(ids[1]).joined.length, 0);
  const env = { ...process.env, PROMPTCUT_ASSET_DATA_DIR: assetDir, PROMPTCUT_ASSET_HOST: '127.0.0.1', PROMPTCUT_ASSET_PORT: '5863', PROMPTCUT_ASSET_INTERNAL_PORT: '5864',
    PROMPTCUT_ASSET_PUBLIC_URL: assetOrigin + '/api/asset', PROMPTCUT_ASSET_DOC_AUTHORITY_ID: authorityId, PROMPTCUT_ASSET_DOC_ORIGIN: 'https://127.0.0.1:5862',
    PROMPTCUT_ASSET_DOC_FINGERPRINT256: pki.doc.fingerprint256, PROMPTCUT_ASSET_DOC_CLIENT_FINGERPRINT256: pki.doc.fingerprint256,
    PROMPTCUT_ASSET_DOC_CA_FILE: path.join(dir, 'ca.crt'), PROMPTCUT_ASSET_CLIENT_KEY_FILE: path.join(dir, 'asset.key'), PROMPTCUT_ASSET_CLIENT_CERT_FILE: path.join(dir, 'asset.crt'),
    PROMPTCUT_ASSET_INTERNAL_KEY_FILE: path.join(dir, 'asset.key'), PROMPTCUT_ASSET_INTERNAL_CERT_FILE: path.join(dir, 'asset.crt') };
  const start = async () => { child = spawn(process.execPath, ['server/hosted/asset-main.mjs'], { cwd: app, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    childClosed = new Promise(resolve => child.once('close', resolve)); child.closed = childClosed; children.push(child);
    child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    await waitFor(async () => { if (child.exitCode !== null) throw Error('asset entry exited: ' + stdout + stderr); try { return (await fetch(assetOrigin + '/healthz')).ok; } catch { return false; } }, 'asset entry listen'); };
  await start();
  const joined = await web(origin, 'POST', '/hosted/shared/account/join', { projectId: projects[0], requestId: 'ready-join', deviceId: 'asset-device-1' }, editors[1].accessToken);
  assert.equal(joined.status, 200, JSON.stringify(joined.body)); assert.equal(combo.accountRuntime.authority.listProjects(ids[1]).joined.length, 1);
  const sessions = [];
  for (let i = 0; i < 2; i++) { const got = await session(i, `ready-${i}`); assert.equal(got.status, 200, JSON.stringify(got.body)); sessions.push(got.body); }
  const request = (i, route, options = {}) => fetch(assetOrigin + route, { ...options, signal: AbortSignal.timeout(5000), headers: { authorization: `Bearer ${sessions[i].assetTicket}`, ...options.headers } });
  const bytes = wav(), hash = createHash('sha256').update(bytes).digest('hex');
  for (const ns of ['media', 'snap', 'px']) {
    const route = `/api/asset/${ns}/${hash}`;
    const put = i => request(i, route + '/0', { method: 'PUT', headers: { 'x-media-size': String(bytes.length), 'x-media-ext': 'wav' }, body: bytes });
    assert.equal((await put(0)).status, 200); assert.equal((await request(0, route + '/complete', { method: 'POST' })).status, 200);
    for (const options of [{}, { method: 'HEAD' }, { headers: { Range: 'bytes=2-6' } }]) { assert.equal((await request(1, route, options)).status, 404); const a = await request(0, route, options); assert.equal(a.status, options.headers ? 206 : 200); await a.arrayBuffer(); }
    assert.equal((await (await request(1, route + '/chunks')).json()).size, null); assert.equal((await request(1, route + '/complete', { method: 'POST' })).status, 404);
    assert.equal((await put(1)).status, 200); assert.equal((await request(1, route + '/complete', { method: 'POST' })).status, 200);
    assert.deepEqual(Buffer.from(await (await request(1, route)).arrayBuffer()), bytes);
  }
  assert.equal((await fetch(assetOrigin + `/api/asset/media/${hash}`)).status, 401);
  assert.equal((await fetch(assetOrigin + `/api/asset/media/${hash}`, { headers: { 'x-account-id': ids[0], 'x-project-id': projects[0] } })).status, 401);
  assert.equal((await request(0, `/api/asset/media/${hash}?projectId=${projects[1]}`)).status, 403);
  assert.equal((await fetch(assetOrigin + `/api/asset/media/${hash}?t=${sessions[0].assetTicket}`)).status, 200);
  assert.equal((await request(0, '/internal/v2/asset/status')).status, 404);
  assert.equal((await request(0, '/admin/')).status, 404);
  const docClient = createAssetDocClient({ origin: 'https://127.0.0.1:5862', authorityId, tls: pki.asset, serverFingerprint256: pki.doc.fingerprint256 }); t.after(() => docClient.close());
  await assert.rejects(docClient.resolveAssetTicket('fake-ticket'), { status: 401 });
  const wrongClient = createAssetDocClient({ origin: 'https://127.0.0.1:5862', authorityId, tls: pki.wrong, serverFingerprint256: pki.doc.fingerprint256 }); t.after(() => wrongClient.close()); await assert.rejects(wrongClient.resolveAssetTicket(sessions[0].assetTicket), { status: 403 });
  const noCertificate = await new Promise(resolve => { const req = https.request('https://127.0.0.1:5862/internal/v2/access/events', { ca: pki.ca, agent: false, timeout: 3000 }, res => { res.resume(); res.once('end', () => resolve(false)); }); req.once('error', () => resolve(true)); req.once('timeout', () => req.destroy()); req.end(); });
  assert.equal(noCertificate, true, 'loopback without client certificate fails the actual TLS handshake');
  const upload = await request(0, '/api/media/upload/real.wav', { method: 'POST', body: bytes }); assert.equal(upload.status, 200); assert.equal((await upload.json()).hash, hash);
  const pcm = await request(0, `/@media/${hash}/pcm?start=0&count=480&sampleRate=48000`); assert.equal(pcm.status, 200); const pcmBytes = Buffer.from(await pcm.arrayBuffer()); assert.equal(pcmBytes.length, 480 * 2 * 4); assert.ok(pcmBytes.some(b => b !== 0), 'real ffmpeg PCM contains samples');
  const aStore = new StreamStore(path.join(assetDir, 'streams'), { ownership: { projectId: projects[0], assert: async () => {} } });
  const streamKey = 'a'.repeat(64), initId = 'b'.repeat(16), segment = `0-${'c'.repeat(16)}.m4s`;
  await aStore.writeFile(aStore.initFile(streamKey, initId), bytes); await aStore.writeFile(aStore.segFile(streamKey, segment), bytes);
  await aStore.save({ streamKey, kind: 'card', fps: 30, inits: { [initId]: { codec: 'fixture' } }, segments: { 0: { init: initId, file: segment, stride: 1, samples: 15 } } });
  for (const tail of ['manifest', `init/${initId}`, `seg/${segment}`]) { assert.equal((await request(0, `/stream/${streamKey}/${tail}`)).status, 200); assert.equal((await request(1, `/stream/${streamKey}/${tail}`)).status, 404); }
  await fsp.writeFile(publicationMarker(aStore.initFile(streamKey, initId)), '{}'); assert.equal((await request(0, `/stream/${streamKey}/init/${initId}`)).status, 404); await fsp.rm(publicationMarker(aStore.initFile(streamKey, initId)));
  const { projectStorageKey } = await import('../asset-store/project-stores.mjs');
  const ownedRoot = path.join(assetDir, 'assets-v2', 'projects', projectStorageKey(projects[0]));
  const mediaFile = path.join(ownedRoot, 'out', 'media', `${hash}.wav`);
  assert.equal((await request(1, '/api/media/file?path=' + encodeURIComponent(mediaFile))).status, 403);
  assert.equal((await request(1, '/api/media/adopt?path=' + encodeURIComponent(mediaFile), { method: 'POST' })).status, 403);
  const local = path.join(ownedRoot, 'out', 'media', 'owned.wav'); await fsp.writeFile(local, bytes);
  assert.equal((await request(0, '/api/media/adopt?path=' + encodeURIComponent(local), { method: 'POST' })).status, 200);
  assert.deepEqual(await fsp.readFile(local), bytes, 'adoption does not modify input');
  const thumbDir = path.join(ownedRoot, 'out', 'shots'); await fsp.mkdir(thumbDir, { recursive: true }); await fsp.writeFile(path.join(thumbDir, 'same.jpg'), bytes);
  assert.equal((await request(0, '/api/shots/thumb/same.jpg')).status, 200); assert.equal((await request(1, '/api/shots/thumb/same.jpg')).status, 404);
  const old = JSON.parse(await fsp.readFile(path.join(assetDir, 'asset-instance.json'))); child.kill(); await childClosed;
  // Windows termination is unclean; no resources/workers remain after this owned child actually closed.
  assert.equal((await session(0, 'asset-offline')).status, 503);
  await start().catch(error => { assert.match(error.message, /asset entry exited/); });
  assert.equal(child.exitCode, 1, 'missing trusted restart fence is rejected');
  assert.match(stdout, /asset-recovery-required/);
  await childClosed;
  // root准确清理失败启动自身遗留claim的停机期模拟；生产runtime不能自动删。
  const failedClaimFile = path.join(assetDir, '.asset-start.claim'), failedClaim = JSON.parse(await fsp.readFile(failedClaimFile));
  assert.equal(failedClaim.pid, child.pid); assert.equal(failedClaim.phase, 'starting'); assert.ok(failedClaim.nonce); await fsp.rm(failedClaimFile);
  assert.equal((await session(0, 'still-offline')).status, 503);
  // Production root/cgroup proof is deliberately not fabricated by this Windows test.
  assert.equal(old.state, 'running');

  // 受控真实网络丢ACK响应：代理只在doc已经持久接受后断socket，不伪造成功/权限。
  let dropAck = true, dropped = false;
  proxy = https.createServer({ ...pki.doc, requestCert: true, rejectUnauthorized: true }, (req, res) => {
    const upstream = https.request('https://127.0.0.1:5862' + req.url, { ...pki.asset, method: req.method, headers: req.headers, agent: false }, answer => {
      const chunks = []; answer.on('data', b => chunks.push(b)); answer.on('end', () => {
        if (dropAck && /\/events\/[^/]+\/ack$/.test(req.url) && answer.statusCode === 200) { dropped = true; res.destroy(); return; }
        res.writeHead(answer.statusCode, answer.headers); res.end(Buffer.concat(chunks));
      });
    }); upstream.on('error', () => res.destroy()); req.pipe(upstream);
  });
  await new Promise(resolve => proxy.listen(5866, '127.0.0.1', resolve));
  const recoveryFence = path.join(dir, 'owned-fence.json'), configFile = path.join(dir, 'controlled.json');
  const fence = async () => { const previous = JSON.parse(await fsp.readFile(path.join(assetDir, 'asset-instance.json')));
    await fsp.writeFile(recoveryFence, JSON.stringify({ v: 1, serviceId: 'asset', previousInstanceId: previous.instanceId, previousPid: previous.pid,
      previousServiceFingerprint256: previous.fingerprint256, closed: true, observedAt: Date.now(), kind: 'owned-tree-close', scope: 'this-test-owned-asset-child' })); };
  await fence();
  await fsp.writeFile(configFile, JSON.stringify({ runtimeFile: path.join(app, 'server/hosted/asset-runtime.mjs'), dataDir: assetDir, authorityId,
    docOrigin: 'https://127.0.0.1:5866', docPin: pki.doc.fingerprint256, caFile: path.join(dir, 'ca.crt'),
    assetKey: path.join(dir, 'asset.key'), assetCert: path.join(dir, 'asset.crt'), recoveryFence }));
  const messages = [];
  const controlled = async () => {
    child = spawn(process.execPath, [path.resolve('server/test/fixtures/asset-entry-controlled.mjs'), configFile], { env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    childClosed = new Promise(resolve => child.once('close', resolve)); child.closed = childClosed; children.push(child);
    child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    child.on('message', message => messages.push(message));
    await waitFor(async () => { if (child.exitCode !== null) throw Error('controlled asset exited: ' + stderr); return messages.some(m => m.event === 'started'); }, 'controlled asset start');
  };
  // 起步head已有创建事件，不应把预热ACK作为故障窗口。
  dropAck = false; await controlled(); dropAck = true;
  const finishedBody = Buffer.from(await (await request(0, `/api/asset/media/${hash}`)).arrayBuffer()); assert.deepEqual(finishedBody, bytes);
  await waitFor(() => messages.some(m => m.event === 'destroy-gated'), 'source destroy gate');
  const gate = messages.find(m => m.event === 'destroy-gated'); assert.equal(gate.closed, false); assert.equal(typeof gate.fd, 'number', 'real source fd remains open after HTTP body finished');
  const logout = provider.logoutLogin(editors[0].loginId, Date.now()); await combo.accountRuntime.authority.synchronize();
  await new Promise(r => setTimeout(r, 150));
  const pending = combo.accountRuntime.authority.revocationStatus(logout.eventId); assert.equal(pending.serviceAcks.asset, null, 'no complete receipt/ACK before real source close');
  assert.ok(JSON.parse(await fsp.readFile(path.join(assetDir, 'access-cursor.json'))).cursor < pending.accessSeq);
  child.send({ type: 'release', id: gate.id });
  await waitFor(() => messages.some(m => m.event === 'actual-close' && m.id === gate.id), 'actual fd close');
  await waitFor(() => dropped, 'doc accepted ACK then response dropped');
  const accepted = combo.accountRuntime.authority.revocationStatus(logout.eventId).serviceAcks.asset; assert.equal(accepted.complete, true); assert.ok(accepted.closedStreams.length > 0);
  const saved = JSON.parse(await fsp.readFile(path.join(assetDir, 'access-cursor.json'))); assert.equal(saved.pending.receipt.receiptId, accepted.receiptId);
  child.kill(); await childClosed; await fence(); dropAck = false; messages.length = 0; await controlled();
  await waitFor(async () => JSON.parse(await fsp.readFile(path.join(assetDir, 'access-cursor.json'))).cursor >= pending.accessSeq, 'real restart pending receipt replay');
  assert.deepEqual(combo.accountRuntime.authority.revocationStatus(logout.eventId).serviceAcks.asset, accepted, 'lost ACK replay keeps the exact immutable receipt');
  assert.equal((await request(0, `/api/asset/media/${hash}`)).status, 401);
  assert.equal((await request(1, `/api/asset/media/${hash}`, { method: 'HEAD' })).status, 200);
  child.send({ type: 'close' }); await childClosed;
  assert.equal(JSON.parse(await fsp.readFile(path.join(assetDir, 'asset-instance.json'))).state, 'clean');
  await start();
  assert.equal((await session(1, 'after-clean-restart')).status, 200, 'real status automatically readies fresh instance after clean restart');
  const newLogin = credentials.createEditor({ account: provider.accountById(ids[0]), deviceId: 'replacement-device', requestId: 'replacement-login' });
  const current = await web(origin, 'GET', `/hosted/shared/account/status?authorityId=${authorityId}&projectId=${projects[0]}`, null, newLogin.accessToken);
  assert.equal(current.status, 200);
  const deleted = await web(origin, 'POST', '/hosted/shared/account/admin', { projectId: projects[0], op: 'delete', requestId: 'delete-A', expectedAccessRevision: current.body.accessRevision }, newLogin.accessToken);
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal((await fetch(assetOrigin + `/api/asset/media/${hash}`, { headers: { authorization: `Bearer ${joined.body.assetTicket}` } })).status, 404, 'deleted A cannot be read via a still-valid other member login');
  const survived = await request(1, `/api/asset/media/${hash}`); assert.equal(survived.status, 200); assert.deepEqual(Buffer.from(await survived.arrayBuffer()), bytes, 'deleting A does not affect B same hash');
});
