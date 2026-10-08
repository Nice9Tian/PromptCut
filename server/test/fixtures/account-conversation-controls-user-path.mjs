/**
 * Isolated v2 account fixture for the conversation-control browser probe.
 * It creates two real accounts, a creator/member project, the document authority,
 * a separate TLS asset process, and a real Agent HTTP service. The caller owns close().
 * Required environment: PROMPTCUT_ACCOUNT_PROVIDER_ROOT and
 * PROMPTCUT_PASSWORD_ORDER_MODULE, both pointing at the frozen real provider.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { startHostedCombo, hostedPaths } from '../../hosted/combo.mjs';
import { stageHostedAssetFiles } from '../../hosted/files.mjs';
import { createAssetReadyProbe } from '../../hosted/asset-doc-client.mjs';
import { assetWiringPki } from './asset-wiring-pki.mjs';
import WebSocket from 'ws';
import { addServiceKey, generateServiceKeyPair } from '../../auth/service-identity.mjs';
import { createConversationClient } from '../../agent-service/conversation-client.mjs';
import { createHostedWiring } from '../../agent-service/hosted-wiring.mjs';
import { createHostedAgentService } from '../../agent/service/create-agent-service.mjs';
import { createAgentHttp } from '../../agent-service/http.mjs';

const waitFor = async (check, label, ms = 20_000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw Error(`timeout: ${label}`);
};
const closeServer = server => new Promise(resolve => {
  if (!server?.listening) return resolve();
  server.close(resolve);
  server.closeAllConnections?.();
});
const listen = (server, port) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
});
const jsonRequest = (url, { method = 'GET', body, headers = {}, ca } = {}) => new Promise((resolve, reject) => {
  const address = new URL(url);
  const data = body === undefined ? null : JSON.stringify(body);
  const request = (address.protocol === 'https:' ? https : http).request(address, {
    method, ca, rejectUnauthorized: true, timeout: 5000,
    headers: { ...(data === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }), ...headers },
  }, response => {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.once('error', reject);
    response.once('end', () => {
      try { resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        cookie: response.headers['set-cookie']?.[0]?.split(';')[0] }); } catch (error) { reject(error); }
    });
  });
  request.once('error', reject);
  request.once('timeout', () => request.destroy(Error('HTTP request timeout')));
  request.end(data);
});
const siteActor = (origin, ca) => {
  let cookie = '', csrf = '';
  const request = async (method, route, body) => {
    const result = await jsonRequest(`${origin}/api/account${route}`, { method, body, ca, headers: {
      ...(cookie ? { cookie } : {}), ...(method === 'POST' ? { origin,
        'sec-fetch-site': 'same-origin', 'x-csrf-token': csrf } : {}) } });
    if (result.cookie) cookie = result.cookie;
    if (result.body.csrfToken) csrf = result.body.csrfToken;
    return result;
  };
  return { request, get cookie() { return cookie; } };
};
const docRequest = (origin, method, route, body, token, ca) => jsonRequest(`${origin}${route}`, { method, body, ca,
  headers: token ? { authorization: `Bearer ${token}` } : {} });
const mediaRequest = (url, { ca, cookie }) => new Promise((resolve, reject) => {
  const request = https.get(url, { ca, rejectUnauthorized: true, timeout: 5000,
    headers: { cookie } }, response => {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.once('error', reject);
    response.once('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks) }));
  });
  request.once('error', reject);
  request.once('timeout', () => request.destroy(Error('media request timeout')));
});
async function openHostedProjectOverWebSocket({ origin, ca, ticket, projectId }) {
  const socket = new WebSocket(`${origin.replace(/^https:/, 'wss:')}/hosted/`,
    ['promptcut.v1', `promptcut.account.${ticket}`], { ca, origin, handshakeTimeout: 5000 });
  const closed = new Promise(resolve => socket.once('close', resolve));
  try {
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    assert.equal(socket.protocol, 'promptcut.v1');
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('WebSocket project.open timeout')), 5000);
      const onMessage = bytes => {
        let message;
        try { message = JSON.parse(bytes.toString('utf8')); } catch { return; }
        if (message.reqId !== 'edge-project-open') return;
        clearTimeout(timer); socket.off('message', onMessage); resolve(message);
      };
      socket.on('message', onMessage);
      socket.once('error', error => { clearTimeout(timer); socket.off('message', onMessage); reject(error); });
    });
    socket.send(JSON.stringify({ type: 'project.open', projectId, reqId: 'edge-project-open' }));
    const message = await result;
    assert.equal(message.rev, 1, JSON.stringify(message));
    return { opened: true, projectRevision: message.rev };
  } finally {
    if (socket.readyState === WebSocket.OPEN) socket.close(); else socket.terminate();
    await closed;
  }
}

export async function runAccountConversationControlsUserPath({ ports = [6620, 6621, 6622, 6623, 6624, 6625, 6626], agentPort = 6627, keepOpen = false,
  providerRoot = process.env.PROMPTCUT_ACCOUNT_PROVIDER_ROOT,
  passwordOrderModule = process.env.PROMPTCUT_PASSWORD_ORDER_MODULE,
  publicHandler = null,
  diagnostic = () => {} } = {}) {
  assert.equal(ports.length, 7);
  assert.ok(Number.isInteger(agentPort) && agentPort >= 6620 && agentPort <= 6639 && !ports.includes(agentPort), 'agentPort must be a free probe-owned port');
  assert.ok(path.isAbsolute(providerRoot ?? '') && fs.existsSync(path.join(providerRoot, 'account/internal.mjs')),
    'real v2 account provider root is required');
  assert.ok(path.isAbsolute(passwordOrderModule ?? '') && fs.existsSync(passwordOrderModule),
    'real password order module is required');
  assert.ok(publicHandler === null || typeof publicHandler === 'function', 'publicHandler must be a function');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pc-control-account-path-'));
  if (process.platform !== 'win32') await fsp.chmod(dir, 0o700);
  const [sitePort, accountPort, docPort, docInternalPort, assetPort, assetInternalPort, edgePort] = ports;
  const edgeOrigin = `https://127.0.0.1:${edgePort}`;
  const siteOrigin = edgeOrigin;
  const accountOrigin = `https://127.0.0.1:${accountPort}`;
  const docOrigin = edgeOrigin;
  const assetOrigin = edgeOrigin;
  const authorityId = 'dual-account-doc';
  const pki = assetWiringPki(dir);
  const agentKey = generateServiceKeyPair();
  let agentServer, agentClient, agentService;
  const staged = path.join(dir, 'staged-asset');
  const docDir = path.join(dir, 'doc');
  const assetDir = path.join(dir, 'asset');
  let store, docAuthorityClient, accountServer, siteServer, edgeServer, combo, child, childClose;
  let childStdout = '', childStderr = '';
  let cleanupComplete = false, handedOff = false, assetPid = null;
  const upgradePairs = new Set();
  const stopChild = async () => {
    if (!child) return;
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await childClose;
    child = null;
  };
  const close = async () => {
    if (cleanupComplete) return { closed: true, childClosed: child === null, assetPid, ports };
    await stopChild();
    await Promise.all([...upgradePairs].map(pair => {
      pair.client.destroy(); pair.upstream.destroy(); return pair.closed;
    }));
    await closeServer(edgeServer);
    await closeServer(agentServer); agentService?.close(); agentClient?.close();
    await combo?.close();
    await closeServer(siteServer);
    await closeServer(accountServer);
    docAuthorityClient?.close();
    store?.close();
    cleanupComplete = true;
    diagnostic({ cleanupComplete, childClosed: child === null });
    return { closed: true, childClosed: child === null, assetPid, ports, fixtureDir: dir };
  };
  try {
    await Promise.all([fsp.mkdir(docDir), fsp.mkdir(assetDir)]);
    stageHostedAssetFiles(path.resolve('.'), staged);
    const load = name => import(pathToFileURL(path.join(providerRoot, `account/${name}.mjs`)));
    const [storeModule, credentialsModule, internalModule, appModule, orderModule] = await Promise.all([
      load('store'), load('credentials'), load('internal'), load('app'), import(pathToFileURL(passwordOrderModule))]);
    store = storeModule.openStore(path.join(dir, 'accounts.sqlite'));
    const credentials = credentialsModule.createCredentials({ store, key: randomBytes(32) });
    const orderKeys = { account: generateKeyPairSync('ed25519'), doc: generateKeyPairSync('ed25519') };
    const order = orderModule.createPasswordOrder({ store, credentials,
      accountOrderSigningKey: orderKeys.account.privateKey, accountOrderKeyId: 'dual-path-order',
      docAttestationPublicKey: orderKeys.doc.publicKey });
    accountServer = internalModule.createInternalServer({ tls: pki.account, store, credentials, order,
      services: [{ serviceId: 'doc', fingerprint256: pki.doc.fingerprint256 }] });
    await listen(accountServer, accountPort);
    docAuthorityClient = internalModule.createDocAuthorityClient({ origin: `https://127.0.0.1:${docInternalPort}`, tls: pki.account, serverFingerprint256: pki.doc.fingerprint256 });
    siteServer = http.createServer(appModule.createApp({ store, credentials,
      origins: [edgeOrigin], cookieSecure: true, docAuthority: docAuthorityClient }));
    await listen(siteServer, sitePort);
    edgeServer = https.createServer({ key: pki.wrong.key, cert: pki.wrong.cert, minVersion: 'TLSv1.3' }, (req, res) => {
      const incoming = new URL(req.url, edgeOrigin), route = incoming.pathname;
      const hosted = route === '/hosted' || route.startsWith('/hosted/');
      const assetPath = route.startsWith('/media/api/asset') ? route.slice('/media'.length) : route;
      const asset = assetPath.startsWith('/api/asset/') || assetPath === '/api/asset' ||
        route.startsWith('/api/media/') || route.startsWith('/@media/');
      const agent = route.startsWith('/agent/');
      const target = route.startsWith('/api/account') ? sitePort : hosted ? docPort : asset ? assetPort : agent ? agentPort : null;
      if (!target) {
        if (route.startsWith('/api/') || route.startsWith('/media/')) { res.writeHead(404); res.end(); return; }
        if (!publicHandler) { res.writeHead(404); res.end(); return; }
        void Promise.resolve().then(() => publicHandler(req, res)).then(handled => {
          if (handled === false && !res.headersSent && !res.writableEnded) { res.writeHead(404); res.end(); }
        }, () => { if (!res.headersSent && !res.writableEnded) res.writeHead(500); res.end(); });
        return;
      }
      // The document WebSocket uses upstream /, while public account HTTP
      // remains /hosted/shared/account/* in the currently mounted v2 handler.
      const accountHttp = /^\/hosted\/shared\/account(?:\/|$)/.test(route);
      const upstreamPath = (hosted && !accountHttp ? route.slice('/hosted'.length) || '/' : asset ? assetPath : agent ? route.slice('/agent'.length) : route) + incoming.search;
      const headers = { ...req.headers, host: `127.0.0.1:${target}` };
      // Same-origin <img>/<video> attach the website cookie even when fetch uses
      // credentials:omit. Only the edge removes it; the asset service still
      // rejects cookies and checks the actual project-bound ticket itself.
      if (target === assetPort || target === agentPort) delete headers.cookie;
      const upstream = http.request({ hostname: '127.0.0.1', port: target, method: req.method, path: upstreamPath,
        headers }, response => {
        res.writeHead(response.statusCode, response.headers); response.pipe(res);
      });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(upstream);
    });
    edgeServer.on('upgrade', (req, client, head) => {
      const incoming = new URL(req.url, edgeOrigin), route = incoming.pathname;
      if (route !== '/hosted' && !route.startsWith('/hosted/')) {
        client.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return;
      }
      const upstreamPath = (route.slice('/hosted'.length) || '/') + incoming.search;
      const upstream = net.connect(docPort, '127.0.0.1');
      let clientClosed = false, upstreamClosed = false, resolveClosed;
      const pair = { client, upstream, closed: new Promise(resolve => { resolveClosed = resolve; }) };
      upgradePairs.add(pair);
      const closeHalf = which => {
        if (which === 'client') clientClosed = true; else upstreamClosed = true;
        if (clientClosed && upstreamClosed) { upgradePairs.delete(pair); resolveClosed(); }
      };
      client.once('close', () => closeHalf('client'));
      upstream.once('close', () => closeHalf('upstream'));
      client.on('error', () => upstream.destroy());
      upstream.on('error', () => client.destroy());
      upstream.once('connect', () => {
        // Copy the actual Origin and complete Sec-WebSocket-Protocol list. Do
        // not parse, print, replace or persist the short-lived account ticket.
        const lines = [`${req.method} ${upstreamPath} HTTP/1.1`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
        upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (head?.length) upstream.write(head);
        upstream.pipe(client); client.pipe(upstream);
      });
    });
    await listen(edgeServer, edgePort);
    const statusConfig = { origin: `https://127.0.0.1:${assetInternalPort}`, tls: pki.doc,
      serverFingerprint256: pki.asset.fingerprint256 };
    addServiceKey(hostedPaths(docDir).servicesFile, { service: 'agent', role: 'agent', actsFor: 'member', kid: agentKey.kid, pub: agentKey.pub });
    combo = await startHostedCombo({ dataDir: docDir, docPort, assetPort: 6539, host: '127.0.0.1',
      trustLoopback: false, clusterToken: 'dual-path-test-cluster-token-32-characters',
      accountRequired: true, docPublicUrl: `${edgeOrigin}/hosted/`,
      assetPublicUrl: `${assetOrigin}/media/api/asset`, assetStatus: statusConfig,
      agentPublicUrl: `${edgeOrigin}/agent/v1`,
      account: { origin: accountOrigin, clientTls: pki.doc, serverFingerprint256: pki.account.fingerprint256,
        authorityId, authorityUrl: `${edgeOrigin}/editor`, signingKey: generateKeyPairSync('ed25519').privateKey,
        keyId: 'dual-path-doc', internalTls: pki.doc, internalPort: docInternalPort,
        services: [{ serviceId: 'account', fingerprint256: pki.account.fingerprint256 },
          { serviceId: 'asset', fingerprint256: pki.asset.fingerprint256 }, { serviceId: 'agent', fingerprint256: pki.wrong.fingerprint256 }],
        agent: { fingerprint256: pki.wrong.fingerprint256, serviceKid: agentKey.kid },
        order: { witnessKeys: { 'dual-path-order': orderKeys.account.publicKey },
          docAttestationPrivateKey: orderKeys.doc.privateKey } } });
    assert.equal(combo.assetPort, null, 'account mode uses the separate asset process');
    agentClient = createConversationClient({ origin: `https://127.0.0.1:${docInternalPort}`, tls: pki.wrong,
      serverFingerprint256: pki.doc.fingerprint256 });
    const wiring = createHostedWiring({ accountMode: true, conversationClient: agentClient });
    agentService = createHostedAgentService({ accountMode: true, conversationClient: agentClient });
    const agentHttp = createAgentHttp({ service: agentService, authenticate: wiring.authenticate });
    agentServer = http.createServer((req, res) => { void agentHttp.handle(req, res); });
    await listen(agentServer, agentPort);
    const actors = [siteActor(siteOrigin, pki.ca), siteActor(siteOrigin, pki.ca)];
    const doc = (method, route, body, token) => docRequest(docOrigin, method, route, body, token, pki.ca);
    const accounts = [];
    const editors = [];
    for (let i = 0; i < 2; i++) {
      const before = await actors[i].request('GET', '/me');
      assert.equal(before.status, 200);
      assert.equal(typeof before.body.csrfToken, 'string');
      const registered = await actors[i].request('POST', '/register', {
        name: `dualUser${i}`, password: `temporary-dual-password-${i}` });
      assert.equal(registered.status, 200, JSON.stringify(registered.body));
      accounts.push(registered.body.account.id);
      const editor = await actors[i].request('POST', '/editor/session', {
        deviceId: `dual-device-${i}`, deviceName: `Dual page ${i}`, requestId: `editor-${i}` });
      assert.equal(editor.status, 200, JSON.stringify(editor.body));
      editors.push(editor.body.accessToken);
    }
    assert.notEqual(accounts[0], accounts[1]);
    const project = await doc('POST', '/hosted/shared/account/create', {
      name: 'Shared dual account project', requestId: 'dual-create', allowLinkJoin: true,
      initialProject: { tracks: [] } }, editors[0]);
    assert.equal(project.status, 201, JSON.stringify(project.body));
    const projectId = project.body.projectId;
    const siteAFirst = await actors[0].request('GET', '/projects');
    assert.equal(siteAFirst.status, 200, JSON.stringify(siteAFirst.body));
    assert.deepEqual(siteAFirst.body.owned.map(item => item.projectId), [projectId]);
    assert.deepEqual(siteAFirst.body.joined, []);
    const pendingJoin = { projectId, requestId: 'dual-join-same-request', deviceId: 'dual-device-1' };
    const blocked = await doc('POST', '/hosted/shared/account/join', pendingJoin, editors[1]);
    assert.equal(blocked.status, 503, JSON.stringify(blocked.body));
    assert.equal((await doc('POST', '/hosted/shared/account/session', {
      projectId, deviceId: 'dual-device-0', requestId: 'dual-before-asset' }, editors[0])).status, 503);
    assert.deepEqual(combo.accountRuntime.authority.listProjects(accounts[1]).joined, [], 'blocked join does not persist membership');
    const siteBBefore = await actors[1].request('GET', '/projects');
    assert.equal(siteBBefore.status, 200);
    assert.deepEqual(siteBBefore.body.owned, []);
    assert.deepEqual(siteBBefore.body.joined, []);

    const env = { ...process.env, PROMPTCUT_ASSET_DATA_DIR: assetDir, PROMPTCUT_ASSET_HOST: '127.0.0.1',
      PROMPTCUT_ASSET_PORT: String(assetPort), PROMPTCUT_ASSET_INTERNAL_PORT: String(assetInternalPort),
      PROMPTCUT_ASSET_PUBLIC_URL: `${assetOrigin}/media/api/asset`, PROMPTCUT_ASSET_DOC_AUTHORITY_ID: authorityId,
      PROMPTCUT_ASSET_DOC_ORIGIN: `https://127.0.0.1:${docInternalPort}`,
      PROMPTCUT_ASSET_DOC_FINGERPRINT256: pki.doc.fingerprint256,
      PROMPTCUT_ASSET_DOC_CLIENT_FINGERPRINT256: pki.doc.fingerprint256,
      PROMPTCUT_ASSET_DOC_CA_FILE: path.join(dir, 'ca.crt'),
      PROMPTCUT_ASSET_CLIENT_KEY_FILE: path.join(dir, 'asset.key'),
      PROMPTCUT_ASSET_CLIENT_CERT_FILE: path.join(dir, 'asset.crt'),
      PROMPTCUT_ASSET_INTERNAL_KEY_FILE: path.join(dir, 'asset.key'),
      PROMPTCUT_ASSET_INTERNAL_CERT_FILE: path.join(dir, 'asset.crt') };
    child = spawn(process.execPath, ['server/hosted/asset-main.mjs'], { cwd: staged, env,
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    assetPid = child.pid;
    childClose = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    child.stdout.on('data', bytes => { childStdout += bytes; });
    child.stderr.on('data', bytes => { childStderr += bytes; });
    await waitFor(async () => {
      if (child.exitCode !== null) throw Error(`asset child exited: ${child.exitCode}; ${childStdout}${childStderr}`);
      try { return (await jsonRequest(`http://127.0.0.1:${assetPort}/healthz`)).status === 200; } catch { return false; }
    }, 'independent asset process');
    const probe = createAssetReadyProbe(statusConfig);
    let readiness;
    try {
      await waitFor(async () => {
        await combo.accountRuntime.authority.synchronize();
        const requiredAccessHead = combo.accountRuntime.authority.eventsSince(0).headSeq;
        try { readiness = await probe({ authorityId, requiredAccessHead }); return true; } catch { return false; }
      }, 'actual asset consumer access head');
    } finally { probe.close(); }
    assert.equal(readiness.accessCursor, readiness.accessHead);
    assert.ok(readiness.accessHead > 0);
    const joined = await doc('POST', '/hosted/shared/account/join', pendingJoin, editors[1]);
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    const sessionA = await doc('POST', '/hosted/shared/account/session', {
      projectId, deviceId: 'dual-device-0', requestId: 'dual-ready-a' }, editors[0]);
    const sessionB = await doc('POST', '/hosted/shared/account/session', {
      projectId, deviceId: 'dual-device-1', requestId: 'dual-ready-b' }, editors[1]);
    assert.equal(sessionA.status, 200, JSON.stringify(sessionA.body));
    assert.equal(sessionB.status, 200, JSON.stringify(sessionB.body));
    assert.equal(typeof sessionA.body.connectionTicket, 'string');
    assert.equal(typeof sessionB.body.connectionTicket, 'string');
    const [siteA, siteB] = await Promise.all(actors.map(actor => actor.request('GET', '/projects')));
    assert.equal(siteA.status, 200, JSON.stringify(siteA.body));
    assert.equal(siteB.status, 200, JSON.stringify(siteB.body));
    assert.deepEqual(siteA.body.owned.map(item => item.projectId), [projectId]);
    assert.deepEqual(siteA.body.joined, []);
    assert.deepEqual(siteB.body.owned, []);
    assert.deepEqual(siteB.body.joined.map(item => item.projectId), [projectId]);
    assert.equal(siteA.body.authorityId, authorityId);
    assert.equal(siteB.body.authorityId, authorityId);
    assert.equal(siteB.body.joined[0].creatorAccountId, accounts[0]);
    let publicHandlerServed = null;
    if (publicHandler) {
      const page = await mediaRequest(`${edgeOrigin}/editor`, { ca: pki.ca, cookie: '' });
      assert.equal(page.status, 200, 'non-API public handler serves the editor page');
      publicHandlerServed = true;
    }
    const webSocket = await openHostedProjectOverWebSocket({ origin: edgeOrigin, ca: pki.ca,
      ticket: sessionA.body.connectionTicket, projectId });
    const websiteMe = await actors[0].request('GET', '/me');
    assert.equal(websiteMe.status, 200);
    assert.equal(websiteMe.body.account.id, accounts[0], 'account cookie remains on the account route');
    const mediaBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
    const mediaHash = createHash('sha256').update(mediaBytes).digest('hex');
    const mediaPath = `/api/asset/media/${mediaHash}`;
    const edgeMediaPath = `/media${mediaPath}`;
    const put = await fetch(`http://127.0.0.1:${assetPort}${mediaPath}/0`, { method: 'PUT',
      headers: { authorization: `Bearer ${sessionA.body.assetTicket}`,
        'x-media-size': String(mediaBytes.length), 'x-media-ext': 'png' }, body: mediaBytes });
    assert.equal(put.status, 200); await put.arrayBuffer();
    const complete = await fetch(`http://127.0.0.1:${assetPort}${mediaPath}/complete`, { method: 'POST',
      headers: { authorization: `Bearer ${sessionA.body.assetTicket}` } });
    assert.equal(complete.status, 200); await complete.arrayBuffer();
    const directWithCookie = await fetch(`http://127.0.0.1:${assetPort}${mediaPath}?t=${sessionA.body.assetTicket}`, {
      headers: { cookie: actors[0].cookie } });
    assert.equal(directWithCookie.status, 400, 'asset itself still refuses website cookies');
    await directWithCookie.arrayBuffer();
    const validMedia = await mediaRequest(`${edgeOrigin}${edgeMediaPath}?t=${sessionA.body.assetTicket}`, {
      ca: pki.ca, cookie: actors[0].cookie });
    assert.equal(validMedia.status, 200);
    assert.deepEqual(validMedia.body, mediaBytes);
    const invalidMedia = await mediaRequest(`${edgeOrigin}${edgeMediaPath}?t=invalid-ticket`, {
      ca: pki.ca, cookie: actors[0].cookie });
    assert.equal(invalidMedia.status, 401);
    if (keepOpen) {
      handedOff = true;
      return { origin: edgeOrigin, leafFingerprint256: pki.wrong.fingerprint256,
        caFile: path.join(dir, 'ca.crt'), projectId, fixtureDir: dir, assetPid,
        accounts: [{ name: 'dualUser0', password: 'temporary-dual-password-0' },
          { name: 'dualUser1', password: 'temporary-dual-password-1' }],
        ports: { site: sitePort, accountInternal: accountPort, doc: docPort,
          docInternal: docInternalPort, asset: assetPort, assetInternal: assetInternalPort, agent: agentPort, edge: edgePort },
        close };
    }
    const revoked = await docRequest(siteOrigin + '/api/account', 'POST', '/editor/logout', {}, editors[1], pki.ca);
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    const lost = await doc('POST', '/hosted/shared/account/session', {
      projectId, deviceId: 'dual-device-1', requestId: 'dual-after-logout' }, editors[1]);
    assert.equal(lost.status, 401, JSON.stringify(lost.body));
    await stopChild();
    const offline = await doc('POST', '/hosted/shared/account/session', {
      projectId, deviceId: 'dual-device-0', requestId: 'dual-asset-offline' }, editors[0]);
    assert.equal(offline.status, 503, JSON.stringify(offline.body));
    const result = { provider: 'actual-v2-app-store-internal', accountCount: accounts.length,
      created: project.status, blockedJoin: blocked.status, joined: joined.status,
      ownerProjects: siteA.body.owned.length, memberProjects: siteB.body.joined.length,
      sessions: [sessionA.status, sessionB.status], revokedSession: lost.status,
      assetOfflineSession: offline.status, accountCookie: websiteMe.status,
      mediaWithWebsiteCookie: validMedia.status, mediaWithInvalidTicket: invalidMedia.status,
      webSocketProjectRevision: webSocket.projectRevision, publicHandlerServed,
      assetHead: readiness.accessHead,
      assetInstanceMatched: typeof readiness.instanceId === 'string',
      ports: { site: sitePort, accountInternal: accountPort, doc: docPort, docInternal: docInternalPort,
        asset: assetPort, assetInternal: assetInternalPort, edge: edgePort },
      leafFingerprint256: pki.wrong.fingerprint256, childClosed: true };
    diagnostic(result);
    return result;
  } finally { if (!handedOff) await close(); }
}

/** A live fixture for the trusted native/web page probe; caller must await close(). */
export const startAccountConversationControlsUserFixture = options => runAccountConversationControlsUserPath({ ...options, keepOpen: true });
