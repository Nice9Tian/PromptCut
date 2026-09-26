/**
 * 节点侧 HTTP 长轮询端点（契约 `docs/plan/http-transport-contract.md` 第 8 节，验收 HT4）。
 * 跑：node --test server/test/render-node-http-transport.test.mjs
 *
 * 对真文档服务（端口 0）跑。重连退避的计时器照 `render-node-ws.test.mjs` 的写法攒着手动 fire；
 * 「临时错误」「会话不存在」用包一层的 `fetch` 注入（转发给真服务，或直接回合成的响应）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocService } from '../docservice/service.mjs';
import { createSharedDocService } from '../docservice/shared-service.mjs';
import { createAgentLink } from '../agent/doc-link.mjs';
import { authByProtocols, protocolsOf } from './fake-transport-kit.mjs';
import { wsClient, waitFor } from './fake-ws-kit.mjs';

const BACKOFF = { baseMs: 500, factor: 2, maxMs: 15_000, jitter: 0.2 };
const expectedDelay = (n, r, b = BACKOFF) => Math.min(b.maxMs, b.baseMs * b.factor ** n) * (1 + b.jitter * (2 * r - 1));
const approx = (actual, expected, what) => assert.ok(Math.abs(actual - expected) < 1e-6, `${what}：期望 ${expected}，实际 ${actual}`);

const load = () => import('../render-node/http-transport.mjs');

/** 回显模块：`echo` 回 `echo.ok`，记下分发过的值（数重复） */
function echoModule() {
  const seen = [];
  return {
    seen,
    name: 'echo',
    types: ['echo'],
    handle(ctx, connId, m) {
      seen.push(m.v);
      ctx.send(connId, { type: 'echo.ok', reqId: m.reqId, v: m.v, pad: m.pad ?? null });
    },
  };
}

async function startService(t, options = {}) {
  const echo = echoModule();
  const logs = [];
  const service = createDocService({ autoTick: false, authenticate: authByProtocols, modules: [echo], log: (e, f) => logs.push({ event: e, ...f }), ...options });
  const { port } = await service.listen(0, '127.0.0.1');
  t.after(() => service.close());
  return { service, echo, logs, port, base: `http://127.0.0.1:${port}` };
}

/** 重连计时器攒着，测试手动 fire（同 render-node-ws.test.mjs） */
function manualTimers() {
  const pending = [];
  const delays = [];
  return {
    pending,
    delays,
    setTimeout(fn, ms) {
      const h = { fn, ms };
      if (!(ms > 0)) { h.real = setTimeout(fn, 0); return h; }
      delays.push(ms);
      pending.push(h);
      return h;
    },
    clearTimeout(h) {
      if (!h) return;
      if (h.real) clearTimeout(h.real);
      const i = pending.indexOf(h);
      if (i >= 0) pending.splice(i, 1);
    },
    async waitPending(ms = 3000) {
      await waitFor(() => pending.length > 0, ms, '重连计时器');
      return pending[0].ms;
    },
    fire() {
      const h = pending.shift();
      h.fn();
    },
  };
}

/**
 * 包一层的 fetch：按端点名（open / send / recv / close）注入故障，其余转发给真 fetch。
 *   throw          抛网络错误（不转发）
 *   status         直接回合成的状态码与 JSON（不转发）
 *   lost           转发给服务端，但回包丢了（回 502）：测重发
 */
function flakyFetch() {
  const rules = [];
  const calls = [];
  const f = async (url, init) => {
    const route = new URL(url).pathname.split('/').pop();
    calls.push(route);
    const i = rules.findIndex((r) => r.route === route);
    if (i < 0) return fetch(url, init);
    const r = rules[i];
    const use = () => {
      r.times -= 1;
      if (r.times <= 0) rules.splice(rules.indexOf(r), 1);
    };
    if (r.kind === 'throw') { use(); throw new TypeError('fetch failed'); }
    if (r.kind === 'status') { use(); return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: { 'content-type': 'application/json' } }); }
    // lost：转发，回包丢掉。recv 只丢带帧的回包（空回包照常交回，规则留着），这样丢的一定是真有内容的那次
    const res = await fetch(url, init);
    const text = await res.text();
    if (route === 'recv' && res.status === 200 && JSON.parse(text).frames.length === 0) {
      return new Response(text, { status: res.status, headers: { 'content-type': 'application/json' } });
    }
    use();
    return new Response('<html>bad gateway</html>', { status: 502 });
  };
  f.calls = calls;
  f.fail = (route, kind, times = 1, extra = {}) => rules.push({ route, kind, times, ...extra });
  f.pending = () => rules.length;
  f.clear = () => { rules.length = 0; };
  return f;
}

function recorder(ep) {
  const rec = { opens: 0, closes: [], messages: [] };
  ep.onOpen(() => { rec.opens += 1; });
  ep.onClose((info) => rec.closes.push(info));
  ep.onMessage((m) => rec.messages.push(m));
  return rec;
}

// ------------------------------------------------------------------ 出口与参数

test('HT4 出口：index.mjs 导出 createHttpEndpoint / HttpWebSocket / httpWebSocketClass；url 收 http(s) 与 ws(s)，别的同步抛 TypeError', async () => {
  const index = await import('../render-node/index.mjs');
  for (const name of ['createHttpEndpoint', 'HttpWebSocket', 'httpWebSocketClass']) assert.equal(typeof index[name], 'function', name);
  const { createHttpEndpoint } = await load();
  assert.throws(() => createHttpEndpoint({ url: 'ftp://x' }), TypeError);
  assert.throws(() => createHttpEndpoint({ url: 'not a url' }), TypeError);
  const timers = manualTimers();
  const refuse = async () => { throw new TypeError('fetch failed'); };
  for (const url of ['http://127.0.0.1:1', 'https://h.test/hosted', 'ws://127.0.0.1:1', 'wss://h.test/hosted']) {
    const ep = createHttpEndpoint({ url, fetch: refuse, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
    ep.close();
  }
});

test('HT4 往返：连上报 onOpen、protocol；消息按序收发；大量消息分批发送（每批不超过单帧上限 + 64 KiB）', async (t) => {
  const env = await startService(t, { maxPayload: 64 * 1024 });
  const { createHttpEndpoint } = await load();
  const f = flakyFetch();
  const ep = createHttpEndpoint({ url: env.base, fetch: f, protocols: () => protocolsOf({ user: 'alice' }), waitMs: 500 });
  t.after(() => ep.close());
  const rec = recorder(ep);
  await waitFor(() => ep.connected, 3000, '连上');
  assert.equal(rec.opens, 1);
  const N = 60;
  for (let i = 0; i < N; i++) assert.equal(ep.send({ type: 'echo', reqId: i, v: i, pad: 'x'.repeat(10 * 1024) }), true);
  await waitFor(() => rec.messages.length === N, 5000, `收齐 ${N} 条`);
  assert.deepEqual(rec.messages.map((m) => m.v), Array.from({ length: N }, (_, i) => i), '顺序不变');
  assert.deepEqual(env.echo.seen, Array.from({ length: N }, (_, i) => i), '服务端按序分发一次');
  const sends = f.calls.filter((c) => c === 'send').length;
  assert.ok(sends >= 5, `600 KiB 按 128 KiB 一批至少分 5 次发（实际 ${sends}）`);
  const s = ep.stats();
  assert.equal(s.sent, N);
  assert.equal(s.received, N);
  assert.equal(env.service.describe().conns[0].principal.userId, 'alice');
});

test('HT4 退避：建连被拒（401）时按 G.7 公式退避、opens 为 0、不报 onClose；protocols() 每次重连前现取', async (t) => {
  const env = await startService(t);
  const { createHttpEndpoint } = await load();
  const timers = manualTimers();
  let calls = 0;
  const ep = createHttpEndpoint({
    url: env.base, protocols: () => { calls += 1; return protocolsOf({ user: 'deny' }); },
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, random: () => 0.25,
  });
  t.after(() => ep.close());
  const rec = recorder(ep);
  for (let n = 0; n < 4; n++) {
    approx(await timers.waitPending(), expectedDelay(n, 0.25), `第 ${n} 次退避`);
    assert.equal(calls, n + 1, 'protocols() 每次连之前调一次');
    timers.fire();
  }
  assert.equal(ep.stats().opens, 0);
  assert.deepEqual(rec.closes, [], '握手失败不算断开');
});

test('HT4 服务端关掉会话（410 / closed）：报 onClose 带服务端的关闭码，断线期间 send 丢弃计数，按退避重连后 protocols() 现取、再次 onOpen', async (t) => {
  const env = await startService(t);
  const { createHttpEndpoint } = await load();
  const timers = manualTimers();
  let calls = 0;
  const ep = createHttpEndpoint({
    url: env.base, protocols: () => { calls += 1; return protocolsOf({ user: `u${calls}` }); },
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, random: () => 0.5, waitMs: 1000,
  });
  t.after(() => ep.close());
  const rec = recorder(ep);
  await waitFor(() => ep.connected, 3000, '连上');
  const connId = env.service.describe().conns[0].connId;
  env.service.closeConn(connId, 4003, 'kicked');
  await waitFor(() => rec.closes.length === 1, 3000, 'onClose');
  assert.deepEqual(rec.closes[0], { code: 4003, reason: 'kicked' });
  assert.equal(ep.connected, false);
  assert.equal(ep.send({ type: 'echo', v: 'lost' }), false);
  assert.equal(ep.stats().dropped, 1);
  approx(await timers.waitPending(), expectedDelay(0, 0.5), '断开后第 0 次退避');
  timers.fire();
  await waitFor(() => rec.opens === 2, 3000, '重连');
  assert.equal(calls, 2);
  assert.equal(env.service.describe().conns[0].principal.userId, 'u2', '新连接用新取的子协议');
  assert.equal(ep.send({ type: 'echo', reqId: 1, v: 'back' }), true);
  await waitFor(() => rec.messages.some((m) => m.v === 'back'), 3000, '重连后照常收发');
  assert.deepEqual(env.echo.seen, ['back'], '断线期间的消息没有补发');
});

test('HT4 404（会话不存在）与 410（已结束）：报 onClose 并重连', async (t) => {
  const env = await startService(t);
  const { createHttpEndpoint } = await load();
  const timers = manualTimers();
  const f = flakyFetch();
  const ep = createHttpEndpoint({ url: env.base, fetch: f, protocols: () => protocolsOf({ user: 'a' }), setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, random: () => 0.5, waitMs: 200 });
  t.after(() => ep.close());
  const rec = recorder(ep);
  await waitFor(() => ep.connected, 3000, '连上');
  f.fail('recv', 'status', 1, { status: 404, body: { ok: false, error: 'no-session' } });
  await waitFor(() => rec.closes.length === 1, 3000, '404 → onClose');
  assert.equal(rec.closes[0].code, 1006);
  await timers.waitPending();
  timers.fire();
  await waitFor(() => rec.opens === 2, 3000, '404 之后重连');
  f.fail('recv', 'status', 1, { status: 410, body: { ok: false, error: 'session-closed', code: 1006, reason: 'timeout' } });
  await waitFor(() => rec.closes.length === 2, 3000, '410 → onClose');
  assert.deepEqual(rec.closes[1], { code: 1006, reason: 'timeout' });
  await timers.waitPending();
  timers.fire();
  await waitFor(() => rec.opens === 3, 3000, '410 之后重连');
});

test('HT4 临时错误：GET / POST 失败（网络错误、502、回包丢失）在 idleMs/2 之内重试同一请求，不报断线；重发的批次服务端只分发一次、重发的帧只交付一次', async (t) => {
  const env = await startService(t);
  const { createHttpEndpoint } = await load();
  const f = flakyFetch();
  const ep = createHttpEndpoint({ url: env.base, fetch: f, protocols: () => protocolsOf({ user: 'a' }), waitMs: 200 });
  t.after(() => ep.close());
  const rec = recorder(ep);
  await waitFor(() => ep.connected, 3000, '连上');

  f.fail('send', 'lost', 1);          // 服务端收到了，回包丢了 → 重发同一批
  f.fail('send', 'throw', 1);         // 再来一次网络错误
  ep.send({ type: 'echo', reqId: 1, v: 'once' });
  await waitFor(() => rec.messages.some((m) => m.v === 'once'), 5000, '回显');
  assert.deepEqual(env.echo.seen, ['once'], '重发的批次只分发一次');

  // 注入的故障只作用于之后发出的请求：等正挂着的那个 GET 回来、下一个 GET 发出去（waitMs 200）再发消息
  const nextRecv = async () => {
    const n = f.calls.filter((c) => c === 'recv').length;
    await waitFor(() => f.calls.filter((c) => c === 'recv').length > n, 3000, '下一个 GET');
  };
  f.fail('recv', 'lost', 1);          // 帧已经发出，回包丢了 → 带旧 ack 再取，服务端重发，客户端按 seq 去重
  await nextRecv();
  ep.send({ type: 'echo', reqId: 2, v: 'twice?' });
  await waitFor(() => rec.messages.some((m) => m.v === 'twice?'), 5000, '第二条回显');
  await waitFor(() => f.pending() === 0, 3000, 'lost 规则用掉');
  f.fail('recv', 'throw', 2);
  f.fail('recv', 'status', 1, { status: 503, body: { ok: false, error: 'unavailable' } });
  await nextRecv();
  ep.send({ type: 'echo', reqId: 3, v: 'three' });
  await waitFor(() => rec.messages.some((m) => m.v === 'three'), 8000, '第三条回显');
  await waitFor(() => f.pending() === 0, 3000, '注入的故障都用掉了');
  assert.equal(rec.messages.filter((m) => m.v === 'twice?').length, 1, '重发的帧只交付一次');
  assert.equal(env.echo.seen.filter((v) => v === 'twice?').length, 1);
  assert.deepEqual(rec.closes, [], '临时错误不报断线');
  assert.equal(rec.opens, 1);
});

test('HT4 临时错误持续超过 idleMs/2：报 onClose 1006 并重连', async (t) => {
  const env = await startService(t, { httpIdleMs: 600 });
  const { createHttpEndpoint } = await load();
  const timers = manualTimers();
  const f = flakyFetch();
  const ep = createHttpEndpoint({ url: env.base, fetch: f, protocols: () => protocolsOf({ user: 'a' }), setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, random: () => 0.5, waitMs: 100 });
  t.after(() => ep.close());
  const rec = recorder(ep);
  await waitFor(() => ep.connected, 3000, '连上');
  f.fail('recv', 'throw', 1000);
  await waitFor(() => rec.closes.length === 1, 5000, '重试用完 → onClose');
  assert.equal(rec.closes[0].code, 1006);
  f.clear();
  await timers.waitPending();
});

test('HT4 HttpWebSocket 的 WebSocket 形状：CONNECTING 时 send 抛错；close() 发完剩下的再关，close 事件 1000、wasClean；服务端记 conn.close', async (t) => {
  const env = await startService(t);
  const { HttpWebSocket } = await load();
  const ws = new HttpWebSocket(env.base, protocolsOf({ user: 'a' }));
  assert.equal(ws.readyState, HttpWebSocket.CONNECTING);
  assert.throws(() => ws.send('x'));
  const events = [];
  ws.onopen = () => events.push('open');
  ws.addEventListener('message', (e) => events.push(JSON.parse(e.data).v));
  const closed = new Promise((resolve) => ws.addEventListener('close', resolve, { once: true }));
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
  assert.equal(ws.readyState, HttpWebSocket.OPEN);
  assert.equal(ws.protocol, 'promptcut.v1');
  ws.send(JSON.stringify({ type: 'echo', reqId: 1, v: 'last-words' }));
  ws.close(1000, 'bye');
  assert.equal(ws.readyState, HttpWebSocket.CLOSING);
  const ev = await closed;
  assert.deepEqual({ code: ev.code, reason: ev.reason, wasClean: ev.wasClean }, { code: 1000, reason: 'bye', wasClean: true });
  assert.equal(ws.readyState, HttpWebSocket.CLOSED);
  assert.deepEqual(env.echo.seen, ['last-words'], '关之前发完进队的');
  await waitFor(() => env.logs.some((l) => l.event === 'conn.close' && l.transport === 'http' && l.code === 1000), 2000, 'conn.close');
  ws.send('ignored');
  assert.equal(events[0], 'open');

  // 建连失败：先 error 再 close 1006
  const bad = new HttpWebSocket(env.base, protocolsOf({ user: 'deny' }));
  const seq = [];
  bad.addEventListener('error', () => seq.push('error'));
  const ce = await new Promise((resolve) => bad.addEventListener('close', resolve));
  assert.deepEqual(seq, ['error']);
  assert.equal(ce.code, 1006);
});

test('HT4 HttpWebSocket 注入 doc-link：Agent 连接经 HTTP 长轮询读项目副本、提交操作，页面（WebSocket）收到广播', async (t) => {
  const built = createSharedDocService({ mode: 'hosted', dataDir: null, store: null, isLoopback: () => true, localDevice: { deviceId: 'pc-test-device-0001', deviceName: 'test' }, log: () => {}, service: { autoTick: false } });
  const { port } = await built.service.listen(0, '127.0.0.1');
  t.after(() => built.service.close());
  const { httpWebSocketClass } = await load();

  const page = wsClient(`ws://127.0.0.1:${port}`);
  t.after(() => page.close());
  await page.opened;
  page.send({ type: 'project.open', projectId: 'proj-ht4', reqId: 'o' });
  await page.next((m) => m.reqId === 'o');
  page.send({ type: 'project.op', projectId: 'proj-ht4', opId: 'seed', session: 'tab', ops: [{ op: 'set', path: '', value: { name: 'ht4', tracks: [] } }], reqId: 'seed' });
  assert.equal((await page.next((m) => m.reqId === 'seed')).type, 'project.op.ok');

  const link = createAgentLink({
    url: `http://127.0.0.1:${port}`,
    projectId: 'proj-ht4',
    protocolsFor: (n) => ['promptcut.v1', `promptcut.role.agent.${n}`],
    WebSocketImpl: httpWebSocketClass({ waitMs: 1000 }),
  });
  t.after(() => link.close());
  link.conversation(1);
  await link.ready(5000);
  assert.equal(link.replica.rev, 1);
  assert.deepEqual(link.replica.project, { name: 'ht4', tracks: [] }, '经 HTTP 读到项目');

  // 写：同 agent-exec 的做法，自己的提交拿到 ok 后交给副本（广播不回发给提交者）
  const ops = [{ op: 'set', path: '/name', value: 'by-agent' }];
  const reply = await link.conversation(1).request({ type: 'project.op', projectId: 'proj-ht4', opId: 'agent-1', session: 'agent:conv', expectRev: 1, ops });
  assert.deepEqual({ type: reply.type, rev: reply.rev }, { type: 'project.op.ok', rev: 2 }, JSON.stringify(reply));
  link.replica.offer(reply.rev, ops, { opId: 'agent-1', actor: { role: 'agent', conversation: 1, session: 'agent:conv' }, session: 'agent:conv' });
  const seen = await page.next((m) => m.type === 'project.ops' && m.rev === 2);
  assert.equal(seen.actor.role, 'agent');
  assert.equal(seen.actor.conversation, 1);
  // 读：页面再改一次，副本经 HTTP 收到广播跟上
  page.send({ type: 'project.op', projectId: 'proj-ht4', opId: 'page-2', session: 'tab', ops: [{ op: 'set', path: '/tracks', value: [{ id: 't1', clips: [] }] }], reqId: 'p2' });
  assert.equal((await page.next((m) => m.reqId === 'p2')).type, 'project.op.ok');
  assert.equal(await link.replica.waitRev(3, 3000), true, '副本收到 rev 3');
  assert.deepEqual(link.replica.project, { name: 'by-agent', tracks: [{ id: 't1', clips: [] }] }, '副本与真身相同');
  const conn = built.service.describe().conns.find((c) => c.principal.role === 'agent');
  assert.ok(conn, 'Agent 连接登记在核心里');
  assert.ok(built.service.health().transports.http >= 1, '走的是 HTTP 传输');
});
