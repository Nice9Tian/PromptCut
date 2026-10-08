import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createDocService } from '../docservice/service.mjs';
import { wsClient, waitFor } from './fake-ws-kit.mjs';

const principal = { userId: 'account-a', realm: 'account', identityVersion: 2, role: 'page',
  tenantId: 'project-a', projectId: 'project-a', accountId: 'account-a', loginId: 'login-a',
  credentialId: 'credential-a', loginGeneration: 1 };
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function destroyGate(socket) {
  const original = socket._destroy, entered = deferred(); let continuation;
  socket._destroy = function(error, callback) { continuation = () => original.call(this, error, callback); entered.resolve(); };
  return { entered: entered.promise, release() { const next = continuation; continuation = null; next?.(); } };
}
function request(port, route, { agent = false, method = 'GET', sid, body, protocols } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, agent, method,
      headers: { ...(sid ? { authorization: `Bearer ${sid}` } : {}),
        ...(protocols ? { 'x-promptcut-protocols': protocols } : {}),
        ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}) } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      res.on('error', reject);
    });
    req.on('error', reject); req.end(body);
  });
}
const open = (port, agent = false) => request(port, '/lp/open', { agent, method: 'POST', body: '{}',
  protocols: 'promptcut.v1, promptcut.session.new' });
async function setup(t, port, authenticate, modules = [], options = {}) {
  const service = createDocService({ authenticate, modules, enableHttpTransport: true, autoTick: false, log() {}, ...options });
  await service.listen(port, '127.0.0.1'); t.after(() => service.close()); return service;
}

test('security fence waits for actual keep-alive socket close after HTTP end and discards old SID/cache', { timeout: 10000 }, async t => {
  let socket; const service = await setup(t, 5775, req => { socket = req.socket; return principal; });
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 }); t.after(() => agent.destroy());
  const opened = await open(5775, agent); assert.equal(opened.status, 200);
  const id = service.describe().conns[0].connId;
  service.send(id, { type: 'secret', value: 'unsent' });
  await turn(); assert.equal(socket.closed, false);
  const gate = destroyGate(socket); t.after(() => gate.release());
  let completed = false; const barrier = service.fenceConn(id).then(value => { completed = true; return value; });
  await gate.entered; await turn();
  assert.equal(service.describe().conns.length, 0);
  assert.equal(socket.closed, false); assert.equal(completed, false);
  const old = await request(5775, '/lp/recv?wait=0', { sid: opened.body.sid });
  assert.equal(old.status, 410); assert.equal(Object.hasOwn(old.body, 'frames'), false);
  const resumed = await request(5775, '/lp/open', { method: 'POST', body: '{}',
    protocols: `promptcut.v1, promptcut.session.${opened.body.sid}.0` });
  assert.equal(resumed.status, 410);
  gate.release(); const receipt = await barrier;
  assert.equal(socket.closed, true); assert.equal(receipt.actualClosed, true);
});

test('security fence closes held LP receive and incomplete send before returning a receipt', { timeout: 10000 }, async t => {
  const sockets = []; let handled = 0;
  const service = await setup(t, 5776, () => principal, [{ name: 'probe', types: ['probe.'], handle() { handled++; } }]);
  service.server.on('request', req => { if (req.url.startsWith('/lp/recv') || req.url === '/lp/send') sockets.push(req.socket); });
  const opened = await open(5776); assert.equal(opened.status, 200);
  const id = service.describe().conns[0].connId;
  const recv = request(5776, '/lp/recv?wait=30000', { sid: opened.body.sid }).then(() => 'response', () => 'closed');
  const send = http.request({ host: '127.0.0.1', port: 5776, path: '/lp/send', method: 'POST', agent: false,
    headers: { authorization: `Bearer ${opened.body.sid}`, 'content-length': 200 } });
  const sendClosed = new Promise(resolve => { send.on('error', () => {}); send.once('close', resolve); });
  send.write('{"frames":['); await waitFor(() => sockets.length === 2);
  const gates = sockets.map(destroyGate); t.after(() => gates.forEach(gate => gate.release()));
  let completed = false; const barrier = service.fenceConn(id).then(value => { completed = true; return value; });
  await Promise.all(gates.map(gate => gate.entered)); await turn();
  assert.equal(completed, false); assert.equal(handled, 0);
  gates[0].release(); await turn(); assert.equal(completed, false);
  gates[1].release(); const receipt = await barrier;
  assert.equal(receipt.closedHttp, 2); assert.equal(sockets.every(socket => socket.closed), true);
  assert.equal(await recv, 'closed'); await sendClosed; assert.equal(handled, 0);
});

test('security WS fence waits for actual TCP close and rejects session resume', { timeout: 10000 }, async t => {
  let socket; const service = await setup(t, 5777, req => { socket = req.socket; return principal; });
  const client = wsClient('ws://127.0.0.1:5777', ['promptcut.v1', 'promptcut.session.new']);
  t.after(() => client.close()); await client.opened;
  const welcome = await client.next(value => value.type === 'session.welcome');
  const id = service.describe().conns[0].connId, gate = destroyGate(socket); t.after(() => gate.release());
  let completed = false; const barrier = service.fenceConn(id).then(value => { completed = true; return value; });
  await gate.entered; await turn(); assert.equal(completed, false); assert.equal(socket.closed, false);
  assert.equal(service.describe().conns.length, 0);
  gate.release(); const receipt = await barrier; await client.closed;
  assert.equal(receipt.closedWs, 1); assert.equal(socket.closed, true);
  const resume = wsClient('ws://127.0.0.1:5777', ['promptcut.v1', `promptcut.session.${welcome.sid}.0`]);
  await resume.opened; const close = await resume.closed; assert.equal(close.code, 4410);
});

test('logout fence includes asynchronous authentication admission and denies all later old-login admission', { timeout: 10000 }, async t => {
  const entered = deferred(), release = deferred(); let socket;
  const service = await setup(t, 5778, async req => { socket = req.socket; entered.resolve(); await release.promise; return principal; });
  const pending = open(5778).then(() => 'admitted', () => 'closed'); await entered.promise;
  const gate = destroyGate(socket); t.after(() => { release.resolve(); gate.release(); });
  let completed = false;
  const barrier = service.fencePrincipals({ loginIds: ['login-a'], roles: ['page'] }).then(value => { completed = true; return value; });
  await turn(); assert.equal(completed, false); release.resolve(); await gate.entered; await turn();
  assert.equal(completed, false); assert.equal(service.describe().conns.length, 0);
  gate.release(); const receipt = await barrier;
  assert.equal(receipt.pendingAdmissions, 1); assert.equal(receipt.rejectedAdmissions, 1);
  assert.equal(socket.closed, true); assert.equal(await pending, 'closed');
  assert.equal(await open(5778).then(() => 'admitted', () => 'closed'), 'closed');
  assert.equal(service.describe().conns.length, 0);
});

for (const transport of ['ws', 'http']) {
  test(`security fence owns ${transport} resume socket while asynchronous resume gate is pending`, { timeout: 10000 }, async t => {
    const entered = deferred(), release = deferred(); let socket;
    const service = await setup(t, 5779, () => principal, [], { resumeGate: async () => {
      entered.resolve(); await release.promise; return null;
    } });
    let sid;
    if (transport === 'ws') {
      const initial = wsClient('ws://127.0.0.1:5779', ['promptcut.v1', 'promptcut.session.new']);
      await initial.opened; sid = (await initial.next(value => value.type === 'session.welcome')).sid;
      initial.close(); await initial.closed;
      await waitFor(() => service.describe().conns[0]?.detached === true);
      service.server.on('upgrade', req => { socket = req.socket; });
    } else {
      const initial = await open(5779); sid = initial.body.sid;
      service.server.on('request', req => { if (req.url === '/lp/open') socket = req.socket; });
    }
    const id = service.describe().conns[0].connId;
    let resumed, outcome;
    if (transport === 'ws') {
      resumed = wsClient('ws://127.0.0.1:5779', ['promptcut.v1', `promptcut.session.${sid}.0`]);
      outcome = resumed.closed;
    } else {
      outcome = request(5779, '/lp/open', { method: 'POST', body: '{}',
        protocols: `promptcut.v1, promptcut.session.${sid}.0` }).then(() => 'resumed', () => 'closed');
    }
    await entered.promise; const gate = destroyGate(socket);
    t.after(() => { release.resolve(); gate.release(); resumed?.close(); });
    let completed = false; const barrier = service.fenceConn(id).then(value => { completed = true; return value; });
    await gate.entered; await turn(); assert.equal(completed, false); assert.equal(socket.closed, false);
    gate.release(); const receipt = await barrier; assert.equal(receipt.actualClosed, true); assert.equal(socket.closed, true);
    release.resolve(); await outcome; await turn();
    assert.equal(service.describe().conns.length, 0);
    if (resumed) assert.equal(resumed.all.some(value => value.type === 'session.welcome'), false);
  });
}
