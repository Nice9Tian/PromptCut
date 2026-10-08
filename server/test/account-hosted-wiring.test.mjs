import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { spawn, spawnSync } from 'node:child_process';
import { X509Certificate, generateKeyPairSync, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createAccountClient } from '../account/client.mjs';
import { openAccountLedger } from '../account/ledger.mjs';
import { createAccountHostedRuntime } from '../docservice/account-hosted.mjs';
import { createAccountProjectsInternalServer, mountAccountProjects } from '../docservice/modules/account-projects.mjs';
import { createSharedDocService } from '../docservice/shared-service.mjs';
import { stageHostedFiles } from '../hosted/files.mjs';

const providerDir = process.env.PROMPTCUT_ACCOUNT_PROVIDER_ROOT ?? 'C:/Users/admin/Documents/VisuHive/.worktrees/018-account-foundation';
const available = fs.existsSync(path.join(providerDir, 'account/internal.mjs'));
const idA = 'acc_0123456789abcdef01234567';
const idB = 'acc_abcdef0123456789abcdef01';
const listen = (server, port) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
});
const close = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); });

function certificates(dir) {
  const openssl = process.env.OPENSSL ?? (process.platform === 'win32' ? path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git/usr/bin/openssl.exe') : 'openssl');
  const run = args => { const result = spawnSync(openssl, args, { cwd: dir, windowsHide: true, stdio: 'ignore', timeout: 30000 }); assert.equal(result.status, 0); };
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=Temporary account wiring CA', '-keyout', 'ca.key', '-out', 'ca.crt']);
  fs.writeFileSync(path.join(dir, 'extensions.txt'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth,clientAuth\n');
  const ca = fs.readFileSync(path.join(dir, 'ca.crt'));
  const leaf = name => {
    run(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${name}`, '-keyout', `${name}.key`, '-out', `${name}.csr`]);
    run(['x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '1', '-extfile', 'extensions.txt', '-out', `${name}.crt`]);
    return { key: fs.readFileSync(path.join(dir, `${name}.key`)), cert: fs.readFileSync(path.join(dir, `${name}.crt`)), ca };
  };
  return { account: leaf('account'), doc: leaf('doc'), accountCaller: leaf('account-caller'), asset: leaf('asset'), wrong: leaf('wrong'), ca };
}
function request(origin, tls, method, route, body, headers = {}) {
  return new Promise(resolve => {
    const req = https.request(origin + route, { ...tls, agent: false, method, timeout: 3000,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }); } catch { resolve({ failed: true }); }
      });
    });
    req.on('error', () => resolve({ failed: true })); req.on('timeout', () => req.destroy());
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
const web = (origin, method, route, body, headers = {}) => fetch(origin + route, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined }).then(async res => ({ status: res.status, body: await res.json() }));
const wsOpen = (url, protocols) => new Promise((resolve, reject) => {
  const ws = new WebSocket(url, protocols); ws.addEventListener('open', () => resolve(ws), { once: true });
  ws.addEventListener('error', () => reject(new Error('websocket rejected')), { once: true });
});
const next = (ws, type, stage = type) => new Promise((resolve, reject) => {
  const seen = [];
  const timer = setTimeout(() => { ws.removeEventListener('message', onMessage); reject(new Error(`missing ${stage}; seen ${seen.join(',')}`)); }, 3000);
  const onMessage = event => { const value = JSON.parse(event.data); seen.push(`${value.type}:${value.reason ?? ''}`); if (value.type === type) { clearTimeout(timer); ws.removeEventListener('message', onMessage); resolve(value); } };
  ws.addEventListener('message', onMessage);
});

test('staged hosted account dependencies are present and required mode fails closed without configuration', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-account-stage-'));
  try {
    const stage = path.join(dir, 'app');
    stageHostedFiles(path.resolve('.'), stage);
    assert.ok(fs.existsSync(path.join(stage, 'server/account/client.mjs')));
    assert.ok(fs.existsSync(path.join(stage, 'server/docservice/account-hosted.mjs')));
    const imports = spawnSync(process.execPath, ['--input-type=module', '-e',
      "await import('./server/hosted/combo.mjs'); await import('./server/account/client.mjs'); await import('./server/docservice/account-hosted.mjs')"],
    { cwd: stage, windowsHide: true, encoding: 'utf8' });
    assert.equal(imports.status, 0, imports.stderr);
    const data = path.join(dir, 'data'); fs.mkdirSync(data);
    const entry = spawnSync(process.execPath, [path.join(stage, 'server/hosted/main.mjs')], {
      cwd: stage, windowsHide: true, encoding: 'utf8', timeout: 5000,
      env: { ...process.env, PROMPTCUT_DATA_DIR: data, PROMPTCUT_DOCSERVICE_HOST: '127.0.0.1',
        PROMPTCUT_ACCOUNT_V2_REQUIRED: '1', PROMPTCUT_ACCOUNT_V2: '0' },
    });
    assert.equal(entry.status, 1, entry.stdout + entry.stderr);
    assert.match(entry.stdout, /"reason":"account-v2-required"/);
  } finally {
    const target = path.resolve(dir); assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('hosted account v2: mTLS credential, durable create, WS/HTTP admission, message gate and internal ticket check',
  { skip: !available && 'frozen account provider unavailable' }, async t => {
    const modules = await Promise.all(['store', 'credentials', 'internal'].map(name => import(pathToFileURL(path.join(providerDir, `account/${name}.mjs`)).href)));
    const [storeModule, credentialModule, internalModule] = modules;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-account-wiring-'));
    const tls = certificates(dir);
    const provider = storeModule.openStore(path.join(dir, 'provider.sqlite'));
    const credentials = credentialModule.createCredentials({ store: provider, key: randomBytes(32) });
    for (const [id, suffix] of [[idA, 'a'], [idB, 'b']]) provider.createAccount({ id, name: `Fixture ${suffix}`, nameKey: `fixture-${suffix}`, pw: 'fixture-only', now: Date.now() });
    const editorA = credentials.createEditor({ account: provider.accountById(idA), deviceId: 'device-a', requestId: 'login-a' });
    const editorB = credentials.createEditor({ account: provider.accountById(idB), deviceId: 'device-b', requestId: 'login-b' });
    const editorB2 = credentials.createEditor({ account: provider.accountById(idB), deviceId: 'device-b2', requestId: 'login-b2' });
    const accountServer = internalModule.createInternalServer({ tls: tls.account, store: provider, credentials,
      services: [{ serviceId: 'doc', fingerprint256: new X509Certificate(tls.doc.cert).fingerprint256 }] });
    await listen(accountServer, 5823);
    const client = createAccountClient({ origin: `https://127.0.0.1:${accountServer.address().port}`, tls: tls.doc,
      serverFingerprint256: new X509Certificate(tls.account.cert).fingerprint256 });
    const ledger = openAccountLedger({ file: path.join(dir, 'doc.sqlite'), authorityId: 'doc-wiring-fixture' });
    const keys = generateKeyPairSync('ed25519');
    const runtime = createAccountHostedRuntime({ ledger, accountClient: client, dataDir: path.join(dir, 'docservice'),
      authorityUrl: 'https://fixture.invalid/editor', signingKey: keys.privateKey, keyId: 'fixture', pollMs: 0 });
    await runtime.start();
    const accountProjects = mountAccountProjects({ authority: runtime.authority,
      issueSession: input => runtime.issueSession(input), resolveAssetTicket: ticket => runtime.resolveAssetTicket(ticket) });
    const doc = createSharedDocService({ mode: 'hosted', dataDir: path.join(dir, 'docservice'), accountRuntime: runtime, accountProjects,
      trustLoopback: false, service: { autoTick: false }, log: () => {} });
    const addr = await doc.service.listen(5824, '127.0.0.1');
    const origin = `http://127.0.0.1:${addr.port}`;
    assert.deepEqual(await web(origin, 'GET', '/healthz').then(({ body }) =>
      [body.accountMode, body.accountRequired, body.assetReady]), ['v2', false, false]);
    const internal = createAccountProjectsInternalServer({ tls: tls.doc, authority: runtime.authority,
      resolveAssetTicket: ticket => runtime.resolveAssetTicket(ticket),
      services: [{ serviceId: 'account', fingerprint256: new X509Certificate(tls.accountCaller.cert).fingerprint256 },
        { serviceId: 'asset', fingerprint256: new X509Certificate(tls.asset.cert).fingerprint256 }] });
    await listen(internal, 5825);
    const privateOrigin = `https://127.0.0.1:${internal.address().port}`;
    let ws, wsB, wsB2;
    t.after(async () => {
      try { ws?.close(); } catch {}
      try { wsB?.close(); wsB2?.close(); } catch {}
      await doc.service.close(); await close(internal); runtime.close(); await close(accountServer); provider.close();
      const target = path.resolve(dir); assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
      fs.rmSync(target, { recursive: true, force: true });
    });
    const bearerA = { authorization: `Bearer ${editorA.accessToken}` };
    const bearerB = { authorization: `Bearer ${editorB.accessToken}` };
    const created = await web(origin, 'POST', '/hosted/shared/account/create', { name: 'Wired project', requestId: 'create-wired',
      allowLinkJoin: true, initialProject: { tracks: [] } }, bearerA);
    assert.equal(created.status, 201, created.body.code ?? created.body.error);
    const projectId = created.body.projectId;
    assert.equal((await web(origin, 'POST', '/hosted/shared/account/session', { projectId, deviceId: 'device-a', requestId: 'blocked' }, bearerA)).status, 503);
    assert.equal((await web(origin, 'POST', '/hosted/shared/account/join', { projectId, requestId: 'blocked-join' }, bearerB)).status, 503);
    assert.equal(runtime.authority.listProjects(idB).joined.length, 0);
    runtime.setAssetReady(true); // Fixture mounts the real doc-side mTLS asset ticket check below.
    assert.equal((await web(origin, 'GET', '/healthz')).body.assetReady, true);
    const session = await web(origin, 'POST', '/hosted/shared/account/session', { projectId, deviceId: 'device-a', requestId: 'session-a' }, bearerA);
    assert.equal(session.status, 200);
    const { connectionTicket, assetTicket } = session.body;
    ws = await wsOpen(`ws://127.0.0.1:${addr.port}`, ['promptcut.v1', `promptcut.account.${connectionTicket}`]);
    const joinedPrincipal = doc.service.describe().conns.find(conn => conn.principal?.realm === 'account')?.principal;
    assert.equal(joinedPrincipal?.tenantId, projectId, 'WS account principal is bound to the issued project');
    assert.equal(await runtime.gate(joinedPrincipal, 'project.open', { projectId }), null);
    const opened = next(ws, 'project.state'); ws.send(JSON.stringify({ type: 'project.open', projectId }));
    assert.deepEqual((await opened).project, { tracks: [] });
    const wrongProject = `sp_${'a'.repeat(26)}`;
    const livePrincipal = doc.service.describe().conns.find(conn => conn.principal?.realm === 'account')?.principal;
    assert.equal(livePrincipal?.realm, 'account');
    assert.equal(await runtime.gate(livePrincipal, 'project.open', { projectId: wrongProject }), 'project-mismatch');
    const denied = next(ws, 'error', 'cross-project-error'); ws.send(JSON.stringify({ type: 'project.open', projectId: wrongProject }));
    assert.equal((await denied).reason, 'project-mismatch');
    const asset = await request(privateOrigin, tls.asset, 'POST', '/internal/v2/access/check', { assetTicket, projectId, action: 'read', resource: { ns: 'media' } });
    assert.equal(asset.status, 200); assert.equal(asset.body.allowed, true);
    assert.equal((await request(privateOrigin, tls.wrong, 'POST', '/internal/v2/access/check', { assetTicket, projectId, action: 'read' })).status, 403);
    assert.equal((await request(privateOrigin, { ca: tls.ca }, 'POST', '/internal/v2/access/check', { assetTicket, projectId, action: 'read' })).failed, true);
    assert.equal((await request(privateOrigin, tls.asset, 'POST', '/internal/v2/access/check', { principal: { accountId: idA }, projectId, action: 'read' })).status, 401);
    assert.equal((await request(privateOrigin, tls.asset, 'POST', '/internal/v2/access/check', { assetTicket, projectId: `sp_${'a'.repeat(26)}`, action: 'read' })).status, 403);
    const lp = await fetch(`${origin}/lp/open`, { method: 'POST', headers: { 'x-promptcut-protocols': `promptcut.v1, promptcut.session.new, promptcut.account.${connectionTicket}` }, body: '{}' });
    assert.equal(lp.status, 200);
    const probeOut = path.join(dir, 'probe');
    const probeResult = await new Promise(resolve => {
      const child = spawn(process.execPath, [path.resolve('scripts/probes/account-hosted-wiring-probe.mjs'), '--url', origin, '--out', probeOut], {
        windowsHide: true, env: { ...process.env, PROMPTCUT_ACCOUNT_PROBE_TOKEN: editorA.accessToken,
          PROMPTCUT_ACCOUNT_PROBE_PROJECT_ID: projectId, PROMPTCUT_ACCOUNT_PROBE_AUTHORITY_ID: 'doc-wiring-fixture' } });
      let output = ''; child.stdout.on('data', chunk => { output += chunk.toString(); });
      child.stderr.on('data', chunk => { output += chunk.toString(); });
      child.on('close', code => resolve({ code, output }));
    });
    assert.equal(probeResult.code, 0, probeResult.output);
    assert.equal(JSON.parse(fs.readFileSync(path.join(probeOut, 'account-hosted-wiring.json'))).checks.length, 4);
    const joinB = await web(origin, 'POST', '/hosted/shared/account/join', { projectId, deviceId: 'device-b', requestId: 'join-b' }, bearerB);
    assert.equal(joinB.status, 200, joinB.body.code ?? joinB.body.error);
    const joinB2 = await web(origin, 'POST', '/hosted/shared/account/join', { projectId, deviceId: 'device-b2', requestId: 'join-b2' },
      { authorization: `Bearer ${editorB2.accessToken}` });
    assert.equal(joinB2.status, 200, joinB2.body.code ?? joinB2.body.error);
    wsB = await wsOpen(`ws://127.0.0.1:${addr.port}`, ['promptcut.v1', `promptcut.account.${joinB.body.connectionTicket}`]);
    wsB2 = await wsOpen(`ws://127.0.0.1:${addr.port}`, ['promptcut.v1', `promptcut.account.${joinB2.body.connectionTicket}`]);
    const closedB = new Promise(resolve => wsB.addEventListener('close', resolve, { once: true }));
    const closedB2 = new Promise(resolve => wsB2.addEventListener('close', resolve, { once: true }));
    const accessRevision = runtime.authority.listProjects(idA).owned.find(item => item.projectId === projectId).accessRevision;
    const kicked = await web(origin, 'POST', '/hosted/shared/account/admin',
      { projectId, op: 'kick', accountId: idB, expectedAccessRevision: accessRevision, requestId: 'kick-b' }, bearerA);
    assert.equal(kicked.status, 200, kicked.body.code ?? kicked.body.error);
    await Promise.all([closedB, closedB2]);
    assert.equal((await web(origin, 'POST', '/hosted/shared/account/session', { projectId, deviceId: 'device-b', requestId: 'denied-b' }, bearerB)).status, 403);
    const logout = provider.logoutLogin(editorA.loginId, Date.now());
    const after = next(ws, 'error', 'revoked-error'); ws.send(JSON.stringify({ type: 'project.open', projectId }));
    assert.ok(['credential-revoked', 'authorization-expired'].includes((await after).reason));
    assert.equal((await request(privateOrigin, tls.asset, 'POST', '/internal/v2/access/check', { assetTicket, projectId, action: 'read' })).status, 401);
    ws.close();
    await runtime.authority.synchronize();
    const barrier = runtime.authority.revocationStatus(logout.eventId);
    assert.equal(barrier.logoutComplete, false); assert.ok(barrier.pendingServices.includes('doc'));
  });
