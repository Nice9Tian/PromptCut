/**
 * 客户端会话层 `createDocEndpoint`（`server/render-node/session-link.mjs`，契约 `docs/plan/http-transport-contract.md`
 * 第 3、4、9、16 节）对着真的文档服务跑。跑：node --test server/test/session-link.test.mjs
 *
 * 服务端会话层在 `claude/http-transport` 上，还没合进来：这里用 `session-gateway-kit.mjs` 的会话网关（测试用的
 * 最小会话服务端桩）挡在真文档服务前面讲会话，网关背后每个会话一条旧式连接。断线用 `fake-ws-kit.mjs` 的 TCP 代理。
 * 另测对旧服务端（没有会话层）的退化、`transport` 的取值、`renew: false` 与 `onConnectFail`。
 * 假 WebSocket 逐步驱动的用例在测试方的 `ht4-client.test.mjs`（`claude/ht-tests`）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocService } from '../docservice/service.mjs';
import { createDocEndpoint, transportOf, wsUrlOf, httpUrlOf, utf8Length, SESSION_DEFAULTS } from '../render-node/session-link.mjs';
import { createTcpProxy, waitFor, sleep } from './fake-ws-kit.mjs';
import { startSessionGateway, startLegacyFront } from './session-gateway-kit.mjs';

const BACKOFF = { baseMs: 20, factor: 2, maxMs: 100, jitter: 0 };

/** 测试模块 `sl`：`sl.echo { n }` → `sl.echoed { n }`；记下看到的消息与连接生命周期 */
function slModule() {
  const mod = {
    name: 'sl',
    types: ['sl.'],
    seen: [],
    connects: [],
    disconnects: [],
    ctx: null,
    connect(ctx, connId) { mod.ctx = ctx; mod.connects.push(connId); },
    disconnect(ctx, connId) { mod.disconnects.push(connId); },
    handle(ctx, connId, msg) {
      mod.ctx = ctx;
      mod.seen.push({ connId, msg });
      if (msg.type === 'sl.echo') ctx.send(connId, { type: 'sl.echoed', n: msg.n });
    },
  };
  return mod;
}

async function startDoc(t, { deny = false } = {}) {
  const mod = slModule();
  const service = createDocService({
    log: () => {},
    autoTick: false,
    modules: [mod],
    authenticate: () => (deny ? null : { userId: 'u-sl', tenantId: 't-sl' }),
  });
  const { port } = await service.listen(0, '127.0.0.1');
  t.after(() => service.close());
  return { service, mod, port, url: `ws://127.0.0.1:${port}/` };
}

function watch(ep) {
  const ev = { opens: 0, resumes: 0, closes: [], got: [], fails: [] };
  ep.onOpen(() => { ev.opens += 1; });
  ep.onResume(() => { ev.resumes += 1; });
  ep.onClose((info) => ev.closes.push(info));
  ep.onMessage((m) => ev.got.push(m));
  ep.onConnectFail((info) => ev.fails.push(info));
  return ev;
}

async function gatewayPair(t, { retainMs = 60_000 } = {}) {
  const doc = await startDoc(t);
  const gw = await startSessionGateway({ upstream: doc.url, retainMs });
  t.after(() => gw.close());
  const proxy = await createTcpProxy({ target: gw.port });
  t.after(() => proxy.close());
  const logs = [];
  const ep = createDocEndpoint({
    url: `http://127.0.0.1:${proxy.port}/`,
    protocols: () => ['promptcut.v1'],
    backoff: BACKOFF,
    transport: 'ws',
    log: (event, fields) => logs.push({ event, ...fields }),
  });
  t.after(() => ep.close());
  const ev = watch(ep);
  await waitFor(() => ev.opens === 1, 3000, '建会话');
  return { doc, gw, proxy, ep, ev, logs };
}

test('SL-resume 传输被掐断：自动接续，断开期间两边的消息各到一次、按序；核心只见一条连接；日志不含会话号', async (t) => {
  const { doc, gw, proxy, ep, ev, logs } = await gatewayPair(t);
  assert.equal(ep.stats().legacy, false);
  ep.send({ type: 'sl.echo', n: 1 });
  await waitFor(() => ev.got.some((m) => m.n === 1), 2000, '第 1 条回包');
  proxy.cutAll();
  ep.send({ type: 'sl.echo', n: 2 });
  ep.send({ type: 'sl.echo', n: 3 });
  await waitFor(() => gw.stats.resumed >= 0 && [...gw.sessions.values()].some((s) => s.ws === null), 2000, '网关脱开');
  doc.mod.ctx.send(doc.mod.connects[0], { type: 'sl.pushed' });
  await waitFor(() => ev.got.filter((m) => m.type === 'sl.echoed').length === 3 && ev.got.some((m) => m.type === 'sl.pushed'), 5000, '接续后到齐');
  assert.equal(ev.resumes, 1);
  assert.equal(ev.opens, 1);
  assert.deepEqual(ev.closes, []);
  assert.deepEqual(doc.mod.seen.map((s) => s.msg.n), [1, 2, 3], '模块每条一次、按序');
  assert.deepEqual(ev.got.filter((m) => m.type === 'sl.echoed').map((m) => m.n), [1, 2, 3]);
  for (const m of ev.got) assert.ok(!('seq' in m) && !('ack' in m), `上层看不到 seq / ack：${JSON.stringify(m)}`);
  assert.equal(doc.mod.connects.length, 1);
  assert.equal(doc.mod.disconnects.length, 0);
  assert.equal(ep.stats().resumes, 1);
  assert.equal(ep.stats().transport, 'ws');
  await waitFor(() => ep.stats().pendingBytes === 0, 3000, '确认释放');
  const sid = [...gw.sessions.keys()][0];
  assert.ok(!JSON.stringify(logs).includes(sid), '会话号不进日志');
  assert.ok(logs.some((l) => l.event === 'session.detach') && logs.some((l) => l.event === 'session.resume'));
});

test('SL-drop-transport dropTransport() 只断传输：会话接续，onClose 不调', async (t) => {
  const { gw, ep, ev } = await gatewayPair(t);
  assert.equal(ep.dropTransport(), true);
  ep.send({ type: 'sl.echo', n: 7 });
  await waitFor(() => ev.got.some((m) => m.n === 7), 3000, '接续后回包');
  assert.equal(ev.resumes, 1);
  assert.deepEqual(ev.closes, []);
  assert.equal(gw.stats.opened, 1);
});

test('SL-4410 会话在服务端已过期：接续被 4410 关，onClose 一次、重建会话', async (t) => {
  const { doc, proxy, ev } = await gatewayPair(t, { retainMs: 200 });
  proxy.mode = 'reject';
  proxy.cutAll();
  await waitFor(() => doc.mod.disconnects.length === 1, 3000, '网关保留期满、上游断线');
  proxy.mode = 'pass';
  await waitFor(() => ev.opens === 2, 5000, '重建会话');
  assert.equal(ev.closes.length, 1);
  assert.ok([4410, 1006].includes(ev.closes[0].code), JSON.stringify(ev.closes));
  assert.equal(doc.mod.connects.length, 2);
});

test('SL-4404 换了一个服务端（会话不存在）：接续被 4404 关，立刻重建，不等保留期', async (t) => {
  const { proxy, ev } = await gatewayPair(t, { retainMs: 60_000 });
  const doc2 = await startDoc(t);
  const gw2 = await startSessionGateway({ upstream: doc2.url });
  t.after(() => gw2.close());
  proxy.retarget(gw2.port);
  const t0 = Date.now();
  proxy.cutAll();
  await waitFor(() => ev.opens === 2, 5000, '在新服务上重建会话');
  assert.ok(Date.now() - t0 < 5000);
  assert.deepEqual(ev.closes.map((c) => c.code), [4404]);
  assert.equal(doc2.mod.connects.length, 1);
});

test('SL-server-end 服务端以 4003 结束会话：onClose { 4003 }、不接续、建新会话', async (t) => {
  const { gw, ev } = await gatewayPair(t);
  gw.endAll(4003, 'kicked');
  await waitFor(() => ev.closes.length === 1, 3000, 'onClose');
  assert.deepEqual(ev.closes[0], { code: 4003, reason: 'kicked' });
  await waitFor(() => ev.opens === 2, 3000, '新会话');
  assert.equal(ev.resumes, 0);
  assert.equal(gw.stats.resumed, 0);
});

test('SL-close close()：服务端立刻结束会话（上游断线），端点不再重连', async (t) => {
  const { doc, gw, ep, ev } = await gatewayPair(t);
  ep.close();
  await waitFor(() => doc.mod.disconnects.length === 1, 3000, '上游断线');
  assert.equal(gw.sessions.size, 0);
  await sleep(150);
  assert.equal(gw.stats.opened, 1);
  assert.deepEqual(ev.closes, [{ code: 1000, reason: 'closed' }]);
});

test('SL-legacy 旧服务端（没有会话层）：退化为一条传输一个会话，收发照常，探测的 error 不交上层，断了报 onClose 再建', async (t) => {
  const doc = await startDoc(t);
  const front = await startLegacyFront({ upstream: doc.url });
  t.after(() => front.close());
  const proxy = await createTcpProxy({ target: front.port });
  t.after(() => proxy.close());
  const ep = createDocEndpoint({ url: `ws://127.0.0.1:${proxy.port}/`, backoff: BACKOFF, transport: 'ws', log: () => {} });
  t.after(() => ep.close());
  const ev = watch(ep);
  await waitFor(() => ev.opens === 1, 3000, '旧服务端上建成');
  assert.equal(ep.stats().legacy, true);
  ep.send({ type: 'sl.echo', n: 1 });
  await waitFor(() => ev.got.some((m) => m.n === 1), 2000, '回包');
  await sleep(100);
  assert.deepEqual(ev.got, [{ type: 'sl.echoed', n: 1 }], '探测的 error unsupported 不交上层，消息原样');
  assert.deepEqual(doc.mod.seen.map((s) => s.msg), [{ type: 'sl.echo', n: 1 }], '旧服务端收到的消息不带 seq');
  proxy.cutAll();
  await waitFor(() => ev.closes.length === 1, 3000, '断了就是会话结束');
  assert.equal(ep.send({ type: 'sl.echo', n: 2 }), false, '断开期间丢弃');
  await waitFor(() => ev.opens === 2, 3000, '再建');
  assert.equal(ev.resumes, 0);
});

test('SL-renew-false 握手被拒：onConnectFail，端点自己关掉，不再重试；会话结束同样关掉', async (t) => {
  const doc = await startDoc(t, { deny: true });
  const ep = createDocEndpoint({ url: doc.url, backoff: BACKOFF, transport: 'ws', renew: false, log: () => {} });
  t.after(() => ep.close());
  const ev = watch(ep);
  await waitFor(() => ev.fails.length === 1, 3000, 'onConnectFail');
  assert.equal(ep.closed, true);
  await sleep(150);
  assert.equal(ev.fails.length, 1);
  assert.equal(ev.opens, 0);

  const { gw } = await gatewayPair(t);
  const ep2 = createDocEndpoint({ url: gw.url, backoff: BACKOFF, transport: 'ws', renew: false, log: () => {} });
  t.after(() => ep2.close());
  const ev2 = watch(ep2);
  await waitFor(() => ev2.opens === 1, 3000, '建会话');
  gw.endAll(4003, 'kicked');
  await waitFor(() => ev2.closes.length === 1, 3000, 'onClose');
  assert.equal(ep2.closed, true);
  await sleep(150);
  assert.equal(ev2.opens, 1, '不再建新会话');
});

test('SL-transport 传输取值：auto / ws 照认，http 在 HT-a 回未启用，其余抛错；环境变量在选项之后', () => {
  assert.equal(transportOf(undefined, undefined), 'auto');
  assert.equal(transportOf('WS', undefined), 'ws');
  assert.equal(transportOf(undefined, 'ws'), 'ws');
  assert.equal(transportOf('auto', 'ws'), 'auto');
  assert.throws(() => transportOf('http', undefined), (e) => e.code === 'transport-unavailable');
  assert.throws(() => transportOf(undefined, 'http'), (e) => e.code === 'transport-unavailable');
  assert.throws(() => transportOf('sse', undefined), TypeError);
  assert.throws(() => createDocEndpoint({ url: 'ws://127.0.0.1:1/', transport: 'http' }), (e) => e.code === 'transport-unavailable');
  assert.equal(wsUrlOf('https://h.test/hosted'), 'wss://h.test/hosted');
  assert.equal(wsUrlOf('ws://h.test:8787/'), 'ws://h.test:8787/');
  assert.equal(httpUrlOf('wss://h.test/hosted'), 'https://h.test/hosted');
  assert.throws(() => wsUrlOf('ftp://h.test/'), TypeError);
  assert.equal(utf8Length('aé中😀'), 1 + 2 + 3 + 4);
});

test('SL-agent-link Agent 服务端的连接（doc-link）走会话：传输被掐断，在途请求照样拿到回包，连接不算断线', async (t) => {
  const http = await import('node:http');
  const { createSharedDocService } = await import('../docservice/shared-service.mjs');
  const { createAgentLink } = await import('../agent/doc-link.mjs');
  const server = http.createServer((req, res) => { res.statusCode = 404; res.end(); });
  const built = createSharedDocService({ mode: 'lan', dataDir: null, store: null, server, path: '/docservice', isLoopback: () => true, localDevice: { deviceId: 'pc-test-device-0001', deviceName: 'test' }, log: () => {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await built.service.close(); await new Promise((resolve) => server.close(resolve)); });
  const gw = await startSessionGateway({ upstream: `ws://127.0.0.1:${server.address().port}/docservice` });
  t.after(() => gw.close());
  const proxy = await createTcpProxy({ target: gw.port });
  t.after(() => proxy.close());
  const logs = [];
  const link = createAgentLink({ url: `ws://127.0.0.1:${proxy.port}/`, projectId: 'p-sl', protocolsFor: (n) => ['promptcut.v1', `promptcut.role.agent.${n}`], log: (event, fields) => logs.push({ event, ...fields }) });
  t.after(() => link.close());
  const conv = link.conversation(1);
  await link.ready(5000);
  proxy.cutAll();
  const reply = await conv.request({ type: 'project.op', projectId: 'p-sl', opId: 'sl-op-1', session: 'agent-sl', ops: [{ op: 'set', path: '', value: { id: 'p-sl', tracks: [] } }] });
  assert.equal(reply.type, 'project.op.ok', JSON.stringify(reply));
  assert.ok(logs.some((l) => l.event === 'agent.link.resume'), `接续过：${JSON.stringify(logs.map((l) => l.event))}`);
  assert.ok(!logs.some((l) => l.event === 'agent.link.close'), '没有断线');
  assert.equal(gw.stats.opened, 1, '只建过一个会话');
  assert.equal(link.describe().conversations[0].state, 'open');
});

/** 最小的假 WebSocket：测试手动触发 open / message，记下客户端发出的消息 */
function fakeSocketClass() {
  const sockets = [];
  class FakeWs {
    constructor(url, protocols) {
      this.url = url; this.protocols = protocols; this.readyState = 0; this.sent = []; this.l = {};
      sockets.push(this);
    }
    addEventListener(type, fn) { (this.l[type] ??= []).push(fn); }
    emit(type, ev) { for (const fn of this.l[type] ?? []) fn(ev); }
    send(text) { this.sent.push(JSON.parse(text)); }
    close() { this.readyState = 3; }
    open(welcome) { this.readyState = 1; this.emit('open', {}); this.emit('message', { data: JSON.stringify({ type: 'session.welcome', sid: 'S'.repeat(43), resumed: false, ack: 0, retainMs: 60_000, transport: 'ws', ...welcome }) }); }
    push(msg) { this.emit('message', { data: JSON.stringify(msg) }); }
    acks() { return this.sent.filter((m) => m.type === 'session.ack'); }
  }
  return { FakeWs, sockets };
}

test('SL-ack-bytes 收到的未确认原文满 64 KiB 就立刻单发 session.ack，不等 1 s（〔裁〕2026-09-27，两端同一条）', () => {
  const { FakeWs, sockets } = fakeSocketClass();
  const ep = createDocEndpoint({ url: 'ws://doc.test/', WebSocket: FakeWs, transport: 'ws', log: () => {}, legacyProbeMs: -1 });
  try {
    const got = [];
    ep.onMessage((m) => got.push(m));
    const s = sockets[0];
    s.open();
    const pad = 'p'.repeat(40 * 1024);
    s.push({ type: 'x', seq: 1, pad });
    assert.deepEqual(s.acks(), [], '40 KiB：还不到 64 KiB，不立刻确认');
    s.push({ type: 'x', seq: 2, pad });
    assert.deepEqual(s.acks(), [{ type: 'session.ack', ack: 2 }], '累计过 64 KiB：当场确认到 2');
    s.push({ type: 'x', seq: 3, pad: 'q' });
    assert.equal(s.acks().length, 1, '计数从确认处重新算：一条小消息不立刻确认');
    for (let n = 4; n <= 34; n++) s.push({ type: 'x', seq: n });
    assert.deepEqual(s.acks().at(-1), { type: 'session.ack', ack: 34 }, '满 32 条照旧立刻确认');
    assert.equal(got.length, 34);
    assert.deepEqual(SESSION_DEFAULTS.ackBytes, 64 * 1024);
  } finally {
    ep.close();
  }
});
