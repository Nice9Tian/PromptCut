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
import { createDocService } from '../docservice/service.mjs';
import { createFileStore } from '../docservice/store/index.mjs';
import { stateBlobName } from '../docservice/modules/project.mjs';
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
function wsCaptured(url, protocols) {
  const ws = new WebSocket(url, protocols);
  const inbox = [], waiters = [];
  ws.addEventListener('message', event => {
    const value = JSON.parse(event.data);
    const index = waiters.findIndex(waiter => waiter.match(value));
    if (index >= 0) waiters.splice(index, 1)[0].resolve(value);
    else inbox.push(value);
  });
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('websocket rejected')), { once: true });
  });
  return { ws, opened, next(match) {
    const index = inbox.findIndex(match);
    if (index >= 0) return Promise.resolve(inbox.splice(index, 1)[0]);
    return timeout(new Promise(resolve => waiters.push({ match, resolve })), 'WS message');
  } };
}
const next = (ws, type, stage = type) => new Promise((resolve, reject) => {
  const seen = [];
  const timer = setTimeout(() => { ws.removeEventListener('message', onMessage); reject(new Error(`missing ${stage}; seen ${seen.join(',')}`)); }, 3000);
  const onMessage = event => { const value = JSON.parse(event.data); seen.push(`${value.type}:${value.reason ?? ''}`); if (value.type === type) { clearTimeout(timer); ws.removeEventListener('message', onMessage); resolve(value); } };
  ws.addEventListener('message', onMessage);
});
const timeout = (promise, label, ms = 3000) => Promise.race([promise,
  new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); timer.unref?.(); })]);

test('two asynchronous WS authentications cannot exceed maxConnections=1', async t => {
  let entered = 0, release, reached;
  const barrier = new Promise(resolve => { release = resolve; });
  const both = new Promise(resolve => { reached = resolve; });
  const service = createDocService({ maxConnections: 1, autoTick: false, log: () => {},
    authenticate: async () => { if (++entered === 2) reached(); await barrier; return { userId: 'capacity-fixture' }; } });
  const addr = await service.listen(5827, '127.0.0.1');
  const clients = [new WebSocket(`ws://127.0.0.1:${addr.port}`, ['promptcut.v1']),
    new WebSocket(`ws://127.0.0.1:${addr.port}`, ['promptcut.v1'])];
  t.after(async () => { release(); for (const client of clients) client.close(); await service.close(); });
  const outcomes = Promise.all(clients.map(client => new Promise(resolve => {
    client.addEventListener('open', () => resolve(true), { once: true });
    client.addEventListener('error', () => resolve(false), { once: true });
  })));
  await timeout(both, 'WS auth fence'); release();
  const admitted = await timeout(outcomes, 'WS admission');
  assert.equal(entered, 2); assert.equal(admitted.filter(Boolean).length, 1);
  assert.equal(service.describe().conns.length, 1);
});

test('two asynchronous HTTP long-poll authentications cannot exceed maxConnections=1', async t => {
  let entered = 0, release, reached;
  const barrier = new Promise(resolve => { release = resolve; });
  const both = new Promise(resolve => { reached = resolve; });
  const service = createDocService({ maxConnections: 1, enableHttpTransport: true, autoTick: false, log: () => {},
    authenticate: async () => { if (++entered === 2) reached(); await barrier; return { userId: 'capacity-fixture' }; } });
  const addr = await service.listen(5828, '127.0.0.1');
  t.after(async () => { release(); await service.close(); });
  const requests = [0, 1].map(() => fetch(`http://127.0.0.1:${addr.port}/lp/open`, {
    method: 'POST', headers: { 'x-promptcut-protocols': 'promptcut.v1, promptcut.session.new' }, body: '{}',
  }).then(res => res.status));
  await timeout(both, 'LP auth fence'); release();
  const statuses = await timeout(Promise.all(requests), 'LP admission');
  assert.equal(entered, 2); assert.deepEqual(statuses.sort(), [200, 503]);
  assert.equal(service.describe().conns.length, 1);
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
    let ws, wsB, wsB2, sessionWs, resumedWs, recovery;
    t.after(async () => {
      try { ws?.close(); } catch {}
      try { sessionWs?.close(); resumedWs?.close(); } catch {}
      try { wsB?.close(); wsB2?.close(); } catch {}
      await doc.service.close(); await close(internal); runtime.close(); recovery?.close(); await close(accountServer); provider.close();
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
    const beforeSession = new Set(doc.service.describe().conns.map(conn => conn.connId));
    const firstSession = wsCaptured(`ws://127.0.0.1:${addr.port}`,
      ['promptcut.v1', 'promptcut.session.new', `promptcut.account.${connectionTicket}`]);
    sessionWs = firstSession.ws; await firstSession.opened;
    const welcome = await firstSession.next(item => item.type === 'session.welcome');
    const sessionConn = doc.service.describe().conns.find(conn => !beforeSession.has(conn.connId))?.connId;
    assert.ok(sessionConn);
    doc.service.send(sessionConn, { type: 'project.pushed', reason: 'account-resume' });
    const pushed = await firstSession.next(item => item.type === 'project.pushed');
    assert.equal(pushed.seq, 1);
    const oldClosed = new Promise(resolve => sessionWs.addEventListener('close', resolve, { once: true }));
    const resumed = wsCaptured(`ws://127.0.0.1:${addr.port}`,
      ['promptcut.v1', `promptcut.session.${welcome.sid}.0`]);
    resumedWs = resumed.ws; await resumed.opened;
    const resumedWelcome = await resumed.next(item => item.type === 'session.welcome');
    assert.equal(resumedWelcome.resumed, true); assert.equal(resumedWelcome.sid, welcome.sid);
    assert.equal((await resumed.next(item => item.type === 'project.pushed')).seq, 1);
    assert.equal((await timeout(oldClosed, 'superseded WS')).code, 4009);
    assert.equal(doc.service.describe().conns.find(conn => conn.connId === sessionConn)?.resumes, 1);
    const asset = await request(privateOrigin, tls.asset, 'POST', '/internal/v2/access/check', { assetTicket, projectId, action: 'read', resource: { ns: 'media' } });
    assert.equal(asset.status, 200); assert.equal(asset.body.allowed, true);
    assert.equal((await request(privateOrigin, tls.wrong, 'POST', '/internal/v2/access/check', { assetTicket, projectId, action: 'read' })).status, 403);
    assert.equal((await request(privateOrigin, { ca: tls.ca }, 'POST', '/internal/v2/access/check', { assetTicket, projectId, action: 'read' })).failed, true);
    assert.equal((await request(privateOrigin, tls.asset, 'POST', '/internal/v2/access/check', { principal: { accountId: idA }, projectId, action: 'read' })).status, 401);
    assert.equal((await request(privateOrigin, tls.asset, 'POST', '/internal/v2/access/check', { assetTicket, projectId: `sp_${'a'.repeat(26)}`, action: 'read' })).status, 403);
    const lp = await fetch(`${origin}/lp/open`, { method: 'POST', headers: { 'x-promptcut-protocols': `promptcut.v1, promptcut.session.new, promptcut.account.${connectionTicket}` }, body: '{}' });
    assert.equal(lp.status, 200);
    const lpBody = await lp.json();
    const lpConn = doc.service.describe().conns.find(conn => conn.transport === 'http' && conn.principal?.accountId === idA)?.connId;
    assert.ok(lpConn);
    doc.service.send(lpConn, { type: 'project.pushed', reason: 'account-lp-resume' });
    const lpResumed = await web(origin, 'POST', '/lp/open', null,
      { 'x-promptcut-protocols': `promptcut.v1, promptcut.session.${lpBody.sid}.0` });
    assert.equal(lpResumed.status, 200); assert.equal(lpResumed.body.resumed, true);
    const lpFrames = await fetch(`${origin}/lp/recv?ack=0&wait=0`, { headers: { authorization: `Bearer ${lpBody.sid}` } });
    assert.equal(lpFrames.status, 200);
    assert.equal(JSON.parse((await lpFrames.json()).frames[0]).seq, 1);
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
    const lpB = await web(origin, 'POST', '/lp/open', null,
      { 'x-promptcut-protocols': `promptcut.v1, promptcut.session.new, promptcut.account.${joinB.body.connectionTicket}` });
    assert.equal(lpB.status, 200);
    const closedB = new Promise(resolve => wsB.addEventListener('close', resolve, { once: true }));
    const closedB2 = new Promise(resolve => wsB2.addEventListener('close', resolve, { once: true }));
    const accessRevision = runtime.authority.listProjects(idA).owned.find(item => item.projectId === projectId).accessRevision;
    const kicked = await web(origin, 'POST', '/hosted/shared/account/admin',
      { projectId, op: 'kick', accountId: idB, expectedAccessRevision: accessRevision, requestId: 'kick-b' }, bearerA);
    assert.equal(kicked.status, 200, kicked.body.code ?? kicked.body.error);
    await Promise.all([closedB, closedB2]);
    const kickedResume = await web(origin, 'POST', '/lp/open', null,
      { 'x-promptcut-protocols': `promptcut.v1, promptcut.session.${lpB.body.sid}.0` });
    assert.equal(kickedResume.status, 410);
    assert.equal((await web(origin, 'POST', '/hosted/shared/account/session', { projectId, deviceId: 'device-b', requestId: 'denied-b' }, bearerB)).status, 403);
    await close(accountServer);
    const unavailableResume = await web(origin, 'POST', '/lp/open', null,
      { 'x-promptcut-protocols': `promptcut.v1, promptcut.session.${lpBody.sid}.0` });
    assert.equal(unavailableResume.status, 503);
    const unavailableWs = new WebSocket(`ws://127.0.0.1:${addr.port}`,
      ['promptcut.v1', `promptcut.session.${welcome.sid}.0`]);
    unavailableWs.addEventListener('error', () => {});
    const unavailableWsClose = await timeout(new Promise(resolve => unavailableWs.addEventListener('close', resolve, { once: true })),
      'unavailable WS resume');
    assert.equal(unavailableWsClose.code, 1012);
    await listen(accountServer, 5823);
    const crashRoot = path.join(dir, 'crash'); fs.mkdirSync(crashRoot);
    const crashLedgerFile = path.join(crashRoot, 'ledger.sqlite');
    const crashDataDir = path.join(crashRoot, 'docservice');
    const crashBody = { name: 'Crash-retry project', requestId: 'crash-retry-create', initialProject: { tracks: [{ id: 'persisted' }] } };
    const privateKeyFile = path.join(crashRoot, 'signing.pem');
    fs.writeFileSync(privateKeyFile, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const moduleUrl = rel => pathToFileURL(path.resolve(rel)).href;
    const childFile = path.join(crashRoot, 'crash-child.mjs');
    fs.writeFileSync(childFile, `
import fs from 'node:fs';
import path from 'node:path';
import { openAccountLedger } from ${JSON.stringify(moduleUrl('server/account/ledger.mjs'))};
import { createAccountClient } from ${JSON.stringify(moduleUrl('server/account/client.mjs'))};
import { createAccountHostedRuntime } from ${JSON.stringify(moduleUrl('server/docservice/account-hosted.mjs'))};
const root = process.env.PC_CRASH_ROOT;
const originalOpen = fs.openSync, originalSync = fs.fsyncSync;
const files = new Map();
fs.openSync = (file, ...rest) => { const fd = originalOpen(file, ...rest); files.set(fd, String(file)); return fd; };
fs.fsyncSync = fd => {
  originalSync(fd);
  const file = files.get(fd) || '';
  if (file.includes('tenants') && file.endsWith('.json') && !file.includes('.tmp-')) {
    fs.writeSync(1, 'crashed-after-initializer-snapshot-fsync\\n');
    process.exit(86);
  }
};
const tls = { key: fs.readFileSync(path.join(root, 'doc.key')),
  cert: fs.readFileSync(path.join(root, 'doc.crt')), ca: fs.readFileSync(path.join(root, 'ca.crt')) };
const client = createAccountClient({ origin: process.env.PC_ACCOUNT_ORIGIN, tls,
  serverFingerprint256: process.env.PC_ACCOUNT_PIN });
const ledger = openAccountLedger({ file: process.env.PC_CRASH_LEDGER, authorityId: 'doc-crash-fixture' });
const runtime = createAccountHostedRuntime({ ledger, accountClient: client, dataDir: process.env.PC_CRASH_DATA,
  authorityUrl: 'https://fixture.invalid/editor', signingKey: fs.readFileSync(path.join(root, 'crash/signing.pem')),
  keyId: 'fixture', pollMs: 0 });
await runtime.start();
await runtime.authority.createProject({ accessToken: process.env.PC_ACCOUNT_TOKEN }, ${JSON.stringify(crashBody)});
process.exit(0);
`);
    const crashResult = await new Promise(resolve => {
      const child = spawn(process.execPath, [childFile], { windowsHide: true,
        env: { ...process.env, PC_CRASH_ROOT: dir, PC_CRASH_LEDGER: crashLedgerFile, PC_CRASH_DATA: crashDataDir,
          PC_ACCOUNT_ORIGIN: `https://127.0.0.1:5823`,
          PC_ACCOUNT_PIN: new X509Certificate(tls.account.cert).fingerprint256,
          PC_ACCOUNT_TOKEN: editorA.accessToken } });
      let output = ''; child.stdout.on('data', chunk => { output += chunk.toString(); });
      child.stderr.on('data', chunk => { output += chunk.toString(); });
      child.on('close', code => resolve({ code, output }));
    });
    assert.equal(crashResult.code, 86, crashResult.output);
    assert.match(crashResult.output, /crashed-after-initializer-snapshot-fsync/);
    const recoveryLedger = openAccountLedger({ file: crashLedgerFile, authorityId: 'doc-crash-fixture' });
    const pending = Object.values(recoveryLedger.read().projects);
    assert.equal(pending.length, 1); assert.equal(pending[0].status, 'pending');
    const persisted = createFileStore({ dir: path.join(crashDataDir, 'tenants', pending[0].projectId), log: () => {} });
    assert.ok(persisted.readBlob(stateBlobName(pending[0].projectId)));
    assert.equal(persisted.read(`projects/${pending[0].projectId}`).length, 1);
    const recoveryClient = createAccountClient({ origin: `https://127.0.0.1:5823`, tls: tls.doc,
      serverFingerprint256: new X509Certificate(tls.account.cert).fingerprint256 });
    recovery = createAccountHostedRuntime({ ledger: recoveryLedger, accountClient: recoveryClient, dataDir: crashDataDir,
      authorityUrl: 'https://fixture.invalid/editor', signingKey: fs.readFileSync(privateKeyFile), keyId: 'fixture', pollMs: 0 });
    await recovery.start();
    const retried = await recovery.authority.createProject({ accessToken: editorA.accessToken }, crashBody);
    const repeat = await recovery.authority.createProject({ accessToken: editorA.accessToken }, crashBody);
    assert.deepEqual(repeat, retried); assert.equal(retried.projectId, pending[0].projectId);
    assert.equal(recoveryLedger.read().projects[retried.projectId].status, 'active');
    assert.equal(persisted.read(`projects/${retried.projectId}`).length, 1);
    const logout = provider.logoutLogin(editorA.loginId, Date.now());
    const after = next(ws, 'error', 'revoked-error'); ws.send(JSON.stringify({ type: 'project.open', projectId }));
    assert.ok(['credential-revoked', 'authorization-expired'].includes((await after).reason));
    assert.equal((await request(privateOrigin, tls.asset, 'POST', '/internal/v2/access/check', { assetTicket, projectId, action: 'read' })).status, 401);
    ws.close();
    await runtime.authority.synchronize();
    const barrier = runtime.authority.revocationStatus(logout.eventId);
    assert.equal(barrier.logoutComplete, false); assert.ok(barrier.pendingServices.includes('doc'));
  });
