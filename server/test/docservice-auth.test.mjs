/**
 * 文档服务的集群令牌鉴权（契约 `docs/plan/render-queue-contract.md` G.5，用例 A1～A6）。
 * 跑：node --test server/test/docservice-auth.test.mjs
 *
 * 只照契约写，不看实现。令牌在测试里现生成（32 字节 base64url），不写死。
 *
 * 接法照契约 G.12：`createDocService({ authenticate: auth.authenticate, log })`，
 * `auth = createClusterAuth({ token, allowAnonymous, log })`，同一个 `log` 两边都传（A5 收 `auth.reject`）；
 * 子协议回显由组装层自己做（`protocol` 选项缺省 `promptcut.v1`），不另外配置。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDocService } from '../docservice/service.mjs';
import { createRenderQueue } from '../render-queue/index.mjs';
import { rawHandshake, randomToken, wsClient, byReq, byType, waitFor } from './fake-ws-kit.mjs';

const MAIN = fileURLToPath(new URL('../docservice/main.mjs', import.meta.url));

async function loadAuth() {
  return import('../docservice/auth.mjs');
}

/**
 * 起服务：token 给了就是令牌模式，否则匿名模式。日志收进 logs（组装层的和鉴权模块的都收）。
 */
async function startService({ token, allowAnonymous = token === undefined, mount = true } = {}) {
  const { createClusterAuth } = await loadAuth();
  const logs = [];
  const log = (event, fields) => logs.push({ event, ...fields });
  const auth = createClusterAuth({ token, allowAnonymous, log });
  const service = createDocService({ log, authenticate: auth.authenticate, autoTick: false });
  let queue = null;
  if (mount) {
    queue = createRenderQueue({ now: Date.now, send: service.send });
    service.mountRenderQueue(queue);
  }
  const { port } = await service.listen(0, '127.0.0.1');
  return { service, queue, port, logs, auth, url: `ws://127.0.0.1:${port}` };
}

const tokenProtocols = (token) => ['promptcut.v1', `promptcut.token.${token}`];

/** 造一个只有 headers / socket 的假请求，测 auth 模块本身 */
function fakeReq(protocolHeader, remote = '10.0.0.5') {
  const headers = {};
  if (protocolHeader !== undefined) headers['sec-websocket-protocol'] = protocolHeader;
  return { headers, socket: { remoteAddress: remote }, url: '/', method: 'GET' };
}

// ------------------------------------------------------------------ A1

test('A1 令牌模式：不带子协议、只带 promptcut.v1、令牌错 → 401', async (t) => {
  const token = randomToken();
  const { service, port } = await startService({ token });
  t.after(() => service.close());

  const cases = [
    ['不带子协议', undefined],
    ['只带 promptcut.v1', ['promptcut.v1']],
    ['令牌错', tokenProtocols(randomToken())],
    ['只带令牌项、缺 promptcut.v1', [`promptcut.token.${token}`]],
    ['令牌前缀对但被截短', tokenProtocols(token.slice(0, -1))],
  ];
  for (const [what, protocols] of cases) {
    const r = await rawHandshake(port, { protocols });
    r.sock.destroy();
    assert.equal(r.status, 401, `${what}：${r.rawHead}`);
  }
  assert.equal(service.describe().connections, 0);
});

test('A1 auth 模块本身：令牌模式下缺协议、缺令牌、令牌错都回 null；常量与工具函数', async () => {
  const { createClusterAuth, PROTOCOL, isLoopbackHost, checkTokenFormat } = await loadAuth();
  assert.equal(PROTOCOL, 'promptcut.v1');
  const token = randomToken();
  const auth = createClusterAuth({ token, allowAnonymous: false });
  assert.equal(auth.authenticate(fakeReq(undefined)), null);
  assert.equal(auth.authenticate(fakeReq('promptcut.v1')), null);
  assert.equal(auth.authenticate(fakeReq(`promptcut.v1, promptcut.token.${randomToken()}`)), null);
  assert.deepEqual(auth.authenticate(fakeReq(`promptcut.v1, promptcut.token.${token}`)), { userId: 'cluster', tenantId: 'cluster' });
  assert.equal(auth.protocolFor(fakeReq(`promptcut.v1, promptcut.token.${token}`)), 'promptcut.v1');
  assert.equal(auth.protocolFor(fakeReq(undefined)), null);

  for (const h of ['127.0.0.1', '::1', 'localhost']) assert.equal(isLoopbackHost(h), true, h);
  for (const h of ['0.0.0.0', '192.168.1.2', '', '::']) assert.equal(isLoopbackHost(h), false, h);

  assert.equal(checkTokenFormat(token), true);
  assert.equal(checkTokenFormat('a'.repeat(32)), true);
  assert.equal(checkTokenFormat('a'.repeat(256)), true);
  assert.equal(checkTokenFormat('a'.repeat(31)), false);
  assert.equal(checkTokenFormat('a'.repeat(257)), false);
  assert.equal(checkTokenFormat(`${'a'.repeat(32)}=`), false);
  assert.equal(checkTokenFormat(`${'a'.repeat(32)} `), false);
  assert.equal(checkTokenFormat(''), false);
  assert.equal(checkTokenFormat(undefined), false);
});

// ------------------------------------------------------------------ A2

test('A2 令牌对 → 101，响应头 Sec-WebSocket-Protocol 恰好是 promptcut.v1；内置 WebSocket 能连上', async (t) => {
  const token = randomToken();
  const { service, port, url } = await startService({ token });
  t.after(() => service.close());

  const r = await rawHandshake(port, { protocols: tokenProtocols(token) });
  r.sock.destroy();
  assert.equal(r.status, 101, r.rawHead);
  assert.equal(r.acceptOk, true);
  assert.equal(r.headers['sec-websocket-protocol'], 'promptcut.v1', '只回显 promptcut.v1，从不回显令牌项');
  assert.ok(!r.rawHead.includes(token), '响应头里不出现令牌');

  // 客户端给的顺序反过来也一样
  const r2 = await rawHandshake(port, { protocols: [`promptcut.token.${token}`, 'promptcut.v1'] });
  r2.sock.destroy();
  assert.equal(r2.status, 101);
  assert.equal(r2.headers['sec-websocket-protocol'], 'promptcut.v1');

  const c = wsClient(url, tokenProtocols(token));
  t.after(() => c.close());
  await c.opened;
  assert.equal(c.ws.protocol, 'promptcut.v1');
  c.send({ type: 'publisher.hello', reqId: 1, publisherId: 'pg' });
  assert.equal((await c.next(byReq(1))).type, 'publisher.welcome');
});

// ------------------------------------------------------------------ A3

test('A3 通过后 principal 为 { userId: cluster, tenantId: cluster }；消息里自报的 userId 不改变它', async (t) => {
  const token = randomToken();
  const { service, url } = await startService({ token });
  t.after(() => service.close());

  const page = wsClient(url, tokenProtocols(token));
  const node = wsClient(url, tokenProtocols(token));
  t.after(() => { page.close(); node.close(); });
  await Promise.all([page.opened, node.opened]);

  node.send({ type: 'node.hello', reqId: 'n', nodeId: 'nd', profile: 'host', userId: 'mallory', tenantId: 'evil' });
  await node.next(byReq('n'));
  node.send({ type: 'queue.watch', reqId: 'w', projects: 'all' });
  await node.next(byReq('w'));

  page.send({ type: 'publisher.hello', reqId: 'p', publisherId: 'pg', userId: 'mallory', tenantId: 'evil' });
  await page.next(byReq('p'));
  const rk = 'rk-a3';
  page.send({
    type: 'task.publish', reqId: 'pub', userId: 'mallory',
    tasks: [{
      id: `snapshot:${rk}:0-9`, kind: 'snapshot', tier: 'shared', resultKey: rk, range: { unit: 'localFrame', from: 0, to: 9 },
      source: { projectId: 'proj', projectRev: 1, userId: 'mallory', tenantId: 'evil' },
    }],
  });
  await page.next(byReq('pub'));
  const opened = await node.next(byType('task.opened'));
  assert.equal(opened.task.source.userId, 'cluster', '任务的 userId 取连接的 principal');
  assert.equal(opened.task.source.tenantId, 'cluster');

  for (const conn of service.describe().conns) {
    assert.deepEqual(conn.principal, { userId: 'cluster', tenantId: 'cluster' });
  }
});

// ------------------------------------------------------------------ A4

test('A4 匿名模式：不带子协议的旧客户端能连上；带 promptcut.v1 的得到回显', async (t) => {
  const { service, port, url } = await startService({ allowAnonymous: true });
  t.after(() => service.close());

  const r0 = await rawHandshake(port);
  r0.sock.destroy();
  assert.equal(r0.status, 101);
  assert.equal(r0.headers['sec-websocket-protocol'], undefined, '客户端没要子协议就不回');

  const r1 = await rawHandshake(port, { protocols: ['promptcut.v1'] });
  r1.sock.destroy();
  assert.equal(r1.status, 101);
  assert.equal(r1.headers['sec-websocket-protocol'], 'promptcut.v1');

  // 匿名模式不看令牌项：带了（哪怕是随便的）也照样通过，回显仍只有 promptcut.v1
  const r2 = await rawHandshake(port, { protocols: tokenProtocols(randomToken()) });
  r2.sock.destroy();
  assert.equal(r2.status, 101);
  assert.equal(r2.headers['sec-websocket-protocol'], 'promptcut.v1');

  const old = wsClient(url);
  const modern = wsClient(url, ['promptcut.v1']);
  t.after(() => { old.close(); modern.close(); });
  await Promise.all([old.opened, modern.opened]);
  assert.equal(old.ws.protocol, '');
  assert.equal(modern.ws.protocol, 'promptcut.v1');
  // 前面三次原始握手的连接只断了 TCP、没发关闭帧，服务端未必马上清掉（见报告「风险」），这里只数到至少 2 条
  await waitFor(() => service.describe().connections >= 2, 2000, '两条连接登记');
  for (const conn of service.describe().conns) assert.deepEqual(conn.principal, { userId: 'anonymous', tenantId: null });
});

test('A4 auth 模块本身：匿名模式回 anonymous，protocolFor 只在客户端给了 promptcut.v1 时回它', async () => {
  const { createClusterAuth } = await loadAuth();
  const auth = createClusterAuth({ allowAnonymous: true });
  assert.deepEqual(auth.authenticate(fakeReq(undefined)), { userId: 'anonymous', tenantId: null });
  assert.deepEqual(auth.authenticate(fakeReq('promptcut.v1')), { userId: 'anonymous', tenantId: null });
  assert.equal(auth.protocolFor(fakeReq(undefined)), null);
  assert.equal(auth.protocolFor(fakeReq('promptcut.v1')), 'promptcut.v1');
  assert.equal(auth.protocolFor(fakeReq('other.proto')), null);
});

// ------------------------------------------------------------------ A5

test('A5 被拒、通过各试几次：全部日志、describe、healthz 里都找不到令牌原文；被拒记 auth.reject', async (t) => {
  const token = randomToken();
  const wrong = randomToken();
  // 连同 stdout / stderr 一起收：实现若绕过注入的 log 直接写标准输出，也要查到
  const captured = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk, ...rest) => { captured.push(String(chunk)); return origOut(chunk, ...rest); };
  process.stderr.write = (chunk, ...rest) => { captured.push(String(chunk)); return origErr(chunk, ...rest); };
  const restore = () => { process.stdout.write = origOut; process.stderr.write = origErr; };
  t.after(restore);

  const { service, port, url, logs } = await startService({ token });
  t.after(() => service.close());

  for (let i = 0; i < 3; i++) {
    for (const protocols of [undefined, ['promptcut.v1'], tokenProtocols(wrong), tokenProtocols(token)]) {
      const r = await rawHandshake(port, { protocols });
      r.sock.destroy();
    }
  }
  const c = wsClient(url, tokenProtocols(token));
  await c.opened;
  c.send({ type: 'publisher.hello', reqId: 1, publisherId: 'pg' });
  await c.next(byReq(1));
  c.send({ type: 'nonsense.type', reqId: 2, token });
  await c.next(byReq(2));
  const healthText = await (await fetch(`http://127.0.0.1:${port}/healthz`)).text();
  const describeText = JSON.stringify(service.describe());
  c.close();
  await c.closed;
  await new Promise((resolve) => setTimeout(resolve, 50)); // 让关闭日志落定
  restore();

  const logText = JSON.stringify(logs);
  for (const secret of [token, wrong]) {
    assert.ok(!logText.includes(secret), '注入的日志里出现了令牌');
    assert.ok(!captured.join('').includes(secret), '标准输出里出现了令牌');
    assert.ok(!describeText.includes(secret), 'describe() 里出现了令牌');
    assert.ok(!healthText.includes(secret), '/healthz 里出现了令牌');
  }
  const rejects = logs.filter((l) => l.event === 'auth.reject');
  const reasons = new Set(rejects.map((l) => l.reason));
  assert.deepEqual([...reasons].sort(), ['bad-token', 'no-protocol', 'no-token'], `auth.reject：${JSON.stringify(rejects)}`);
  assert.ok(rejects.every((l) => 'remote' in l), 'auth.reject 带 remote');
  assert.equal(rejects.length, 9, '每次被拒记一条');
});

// ------------------------------------------------------------------ A6

/** 起 main.mjs 子进程，收输出；返回 { child, output(), exited } */
function runMain(env) {
  const base = { ...process.env };
  for (const k of ['PROMPTCUT_CLUSTER_TOKEN', 'PROMPTCUT_DOCSERVICE_HOST', 'PROMPTCUT_DOCSERVICE_PORT', 'PROMPTCUT_DOCSERVICE_URL']) delete base[k];
  const child = spawn(process.execPath, [MAIN], { env: { ...base, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  return { child, output: () => out, exited };
}

/** 等子进程退出，最多 ms；超时就杀掉并回 { timedOut: true } */
async function exitWithin(run, ms) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), ms); });
  const r = await Promise.race([run.exited, timeout]);
  clearTimeout(timer);
  if (r.timedOut) { run.child.kill(); await run.exited; }
  return r;
}

test('A6 main.mjs：非回环地址且未设令牌 → 退出码 1、输出含 token-required', { timeout: 20_000 }, async () => {
  const run = runMain({ PROMPTCUT_DOCSERVICE_HOST: '0.0.0.0', PROMPTCUT_DOCSERVICE_PORT: '0' });
  const r = await exitWithin(run, 8000);
  assert.ok(!r.timedOut, `没有退出（应当失败即关）；输出：${run.output()}`);
  assert.equal(r.code, 1, run.output());
  assert.match(run.output(), /token-required/);
  assert.match(run.output(), /config\.error/);
});

test('A6 main.mjs：令牌格式不对 → 退出码 1、输出含 bad-token-format，且不回显令牌', { timeout: 20_000 }, async () => {
  const bad = 'short-token!';
  const run = runMain({ PROMPTCUT_DOCSERVICE_HOST: '127.0.0.1', PROMPTCUT_DOCSERVICE_PORT: '0', PROMPTCUT_CLUSTER_TOKEN: bad });
  const r = await exitWithin(run, 8000);
  assert.ok(!r.timedOut, `没有退出；输出：${run.output()}`);
  assert.equal(r.code, 1, run.output());
  assert.match(run.output(), /bad-token-format/);
  assert.ok(!run.output().includes(bad), '输出里出现了令牌原文');
});

/** 等子进程打出 listen 行，取端口 */
async function listenPort(run, ms = 8000) {
  return waitFor(() => {
    for (const line of run.output().split('\n')) {
      try {
        const j = JSON.parse(line);
        if (j.event === 'listen' && Number.isInteger(j.port)) return j.port;
      } catch { /* 不是 JSON 行 */ }
    }
    return null;
  }, ms, `main.mjs 打出 listen 行（已有输出：${run.output().slice(0, 400)}）`);
}

test('A6 main.mjs：回环且未设令牌 → 起得来，/healthz 正常，匿名可连', { timeout: 20_000 }, async (t) => {
  const run = runMain({ PROMPTCUT_DOCSERVICE_HOST: '127.0.0.1', PROMPTCUT_DOCSERVICE_PORT: '0' });
  t.after(async () => { if (run.child.exitCode === null) { run.child.kill(); await run.exited; } });
  const port = await listenPort(run);
  const h = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  assert.equal(h.ok, true);
  assert.equal(h.protocol, 'promptcut.v1');
  assert.equal(h.queue, true, 'main.mjs 挂着队列');
  assert.ok(Array.isArray(h.modules));
  const r = await rawHandshake(port);
  r.sock.destroy();
  assert.equal(r.status, 101, '匿名模式');
});

test('A6 main.mjs：设了合法令牌 → 令牌模式（缺令牌 401、带令牌 101），输出里没有令牌', { timeout: 20_000 }, async (t) => {
  const token = randomToken();
  const run = runMain({ PROMPTCUT_DOCSERVICE_HOST: '127.0.0.1', PROMPTCUT_DOCSERVICE_PORT: '0', PROMPTCUT_CLUSTER_TOKEN: token });
  t.after(async () => { if (run.child.exitCode === null) { run.child.kill(); await run.exited; } });
  const port = await listenPort(run);
  const r0 = await rawHandshake(port, { protocols: ['promptcut.v1'] });
  r0.sock.destroy();
  assert.equal(r0.status, 401);
  const r1 = await rawHandshake(port, { protocols: tokenProtocols(token) });
  r1.sock.destroy();
  assert.equal(r1.status, 101);
  assert.equal(r1.headers['sec-websocket-protocol'], 'promptcut.v1');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(!run.output().includes(token), '输出里出现了令牌原文');
});
