import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { X509Certificate, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { fixture, accountFixture, keys, actor, actorOther, spec } from '../../../../server/test/password-order-fixture.mjs';

function certificates(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const exe = process.env.OPENSSL ?? (process.platform === 'win32' ? path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git/usr/bin/openssl.exe') : 'openssl');
  const run = (args) => { const r = spawnSync(exe, args, { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 30_000 }); if (r.status !== 0) throw new Error('Fixture certificate generation failed'); };
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=Order Probe CA', '-keyout', 'ca.key', '-out', 'ca.crt']);
  fs.writeFileSync(path.join(dir, 'extensions.txt'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth,clientAuth\n');
  const ca = fs.readFileSync(path.join(dir, 'ca.crt'));
  function leaf(name) {
    run(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${name}`, '-keyout', `${name}.key`, '-out', `${name}.csr`]);
    run(['x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '1', '-extfile', 'extensions.txt', '-out', `${name}.crt`]);
    return { key: fs.readFileSync(path.join(dir, `${name}.key`)), cert: fs.readFileSync(path.join(dir, `${name}.crt`)), ca };
  }
  return { server: leaf('account-server'), doc: leaf('doc'), asset: leaf('asset'), ca };
}
const listen = (server, port) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
const close = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
export async function runLiveProbe({ url, out }) {
  const target = new URL(url);
  const port = Number(target.port);
  if (target.hostname !== '127.0.0.1' || target.protocol !== 'http:' || port < 5760 || port > 5768) throw new Error('Probe owns only isolated loopback ports 5760–5769');
  fs.mkdirSync(out, { recursive: true });
  const pair = keys(); const account = await accountFixture({ dir: out, pair, actual: true });
  const { createInternalApp } = await import(pathToFileURL(path.join(process.env.PROMPTCUT_ACCOUNT_PROVIDER_ROOT, 'account/internal.mjs')).href);
  const tls = certificates(path.join(out, 'certificates'));
  const token = randomBytes(24).toString('hex');
  let signalSealed; const sealedAtAccount = new Promise((resolve) => { signalSealed = resolve; });
  let releaseSeal; const sealReply = new Promise((resolve) => { releaseSeal = resolve; });
  let dropOnce = true;
  const app = createInternalApp({ store: account.store, credentials: account.credentials,
    services: [{ serviceId: 'doc', fingerprint256: new X509Certificate(tls.doc.cert).fingerprint256 }, { serviceId: 'asset', fingerprint256: new X509Certificate(tls.asset.cert).fingerprint256 }],
    order: { async handle(args) { const result = account.handle(args); if (args.path.endsWith('/seal') && dropOnce) { signalSealed(); await sealReply; } return result; } } });
  const accountServer = https.createServer({ ...tls.server, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3' }, (req, res) => {
    if (req.url.endsWith('/seal') && dropOnce) { const end = res.end; res.end = function (...args) { if (dropOnce) { dropOnce = false; this.destroy(); return this; } return end.apply(this, args); }; }
    app(req, res);
  });
  await listen(accountServer, port + 1);
  function transport(args, auth = tls.doc) {
    return new Promise((resolve, reject) => {
      const req = https.request(`https://127.0.0.1:${port + 1}${args.path}`, { ...auth, method: args.method, agent: false, timeout: 3000, headers: args.body ? { 'content-type': 'application/json' } : {} }, (res) => {
        const chunks = []; res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => { const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (res.statusCode !== 200) reject(Object.assign(new Error(body.code), { code: body.code, status: res.statusCode })); else resolve(body); });
      });
      req.on('error', (error) => reject(Object.assign(new Error('transport-outcome-unknown'), { code: 'order-outcome-unknown', cause: error.code })));
      req.on('timeout', () => req.destroy()); req.end(args.body ? JSON.stringify(args.body) : undefined);
    });
  }
  let readClosed = false; let fencedSignal; const requested = new Promise((resolve) => { fencedSignal = resolve; });
  const streams = new Set(); let privateBytes = 0;
  const f = await fixture({ dir: out, pair, account, request: (args) => transport(args),
    onFenceRequested: () => { readClosed = true; for (const stream of streams) stream.end(); streams.clear(); fencedSignal(); },
    acknowledgeFence: async (value) => { const fd = fs.openSync(path.join(out, 'private-service-ack.json'), 'w'); try { fs.writeSync(fd, JSON.stringify({ id: value.id, durable: true, streamsClosed: true, taskDispatchDenied: true })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } return { durable: true, receiptId: 'private-ack', streamsClosed: true, taskDispatchDenied: true }; },
  });
  const principal = { ...actor, runGrantId: 'grant', runId: 'run', messageId: 'message', conversationId: 'conversation' };
  const fence = { id: 'private', projectId: 'project-one', kind: 'private', conversationId: 'conversation', ownerAccountId: actorOther.accountId, runIds: ['run'] };
  const docServer = http.createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers['x-fixture'] !== token) return send(403, { code: 'fixture-forbidden' });
    try {
      if (req.method === 'GET' && req.url === '/view') return readClosed ? send(403, { code: 'private' }) : send(200, { title: f.history.snapshot('project-one').value.title });
      if (req.method === 'GET' && req.url === '/events') {
        if (readClosed) return send(403, { code: 'private' });
        res.writeHead(200, { 'content-type': 'text/event-stream' }); const data = 'data: fixture private bytes\n\n'; res.write(data); privateBytes += Buffer.byteLength(data); streams.add(res); res.on('close', () => streams.delete(res)); return;
      }
      if (req.method === 'POST' && req.url === '/private') return send(200, await f.coordinator.fence(fence));
      if (req.method === 'POST' && req.url === '/operation') {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        return send(200, await f.coordinator.submit(spec(body.opId, { projectId: body.projectId ?? 'project-one', expectedRev: body.expectedRev ?? 0, principal })));
      }
      return send(404, { code: 'not-found' });
    } catch (error) { send(error.status ?? 503, { code: error.code ?? 'failed' }); }
  });
  await listen(docServer, port);
  const call = (route, body) => fetch(new URL(route, target), { method: body ? 'POST' : 'GET', headers: { 'x-fixture': token, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const results = [];
  try {
    await assert.rejects(transport({ method: 'GET', path: '/internal/v2/order/no-such' }, tls.asset), { code: 'service-forbidden' });
    await assert.rejects(transport({ method: 'GET', path: '/internal/v2/order/no-such' }, { ca: tls.ca }), { code: 'order-outcome-unknown' });
    results.push({ check: 'real-mTLS-doc-only', passed: true });
    const stream = await call('/events'); assert.equal(stream.status, 200); const reader = stream.body.getReader(); await reader.read();
    const bytesBefore = privateBytes;
    const operation = call('/operation', { opId: 'sealed-before-private' });
    await sealedAtAccount;
    let completed = false; const switching = call('/private', {}).then((r) => { completed = true; return r; });
    await requested;
    assert.equal(completed, false); assert.equal((await call('/view')).status, 403); assert.equal(streams.size, 0);
    assert.equal(privateBytes, bytesBefore); results.push({ check: 'pending-private-closes-reads-before-seal-ACK', passed: true, privateBytesAfterFence: 0 });
    releaseSeal();
    assert.equal((await operation).status, 503); const response = await switching; assert.equal(response.status, 200); assert.equal((await response.json()).complete, true);
    assert.equal(f.history.snapshot('project-one').projectRev, 1); assert.equal(f.history.accepted('project-one').length, 1);
    assert.equal((await call('/operation', { opId: 'late', expectedRev: 1 })).status, 403);
    assert.equal((await call('/view')).status, 403); assert.equal((await call('/events')).status, 403); assert.equal(privateBytes, bytesBefore);
    assert.equal((await call('/operation', { opId: 'independent', projectId: 'project-two' })).status, 200);
    await reader.cancel();
    results.push({ check: 'lost-real-seal-response-settles-original-before-private-complete', passed: true, accepted: 1, extraWrites: 0, extraPrivateBytes: 0 });
    results.push({ check: 'other-project-remains-writable', passed: true });
    assert.equal(f.history.fenceReceipt('private').durable, true);
    fs.writeFileSync(path.join(out, 'live-results.json'), JSON.stringify({ mode: 'actual-provider-mTLS-and-HTTP-fixture', results }, null, 2));
    return results;
  } finally { releaseSeal(); await close(docServer); await close(accountServer); f.close(); account.close(); }
}
