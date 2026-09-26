/**
 * 文档服务的 HTTP 长轮询传输，服务端一侧（契约 `docs/plan/http-transport-contract.md` 第 3～7 节，验收 HT1、HT2）。
 * 跑：node --test server/test/docservice-http-transport.test.mjs
 *
 * 直接打四个端点（`fake-transport-kit.mjs` 的 `lp`），不经节点端的客户端。端口一律 0，`autoTick: false`。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocService } from '../docservice/service.mjs';
import { createRenderQueue } from '../render-queue/index.mjs';
import { isLoopbackAddress } from '../auth/handshake.mjs';
import { buildAuthProtocols } from '../auth/client.mjs';
import { lp, recvUntil, authByProtocols, protocolsOf } from './fake-transport-kit.mjs';
import { wsClient, byReq, sleep, waitFor, rawHandshake } from './fake-ws-kit.mjs';
import { startSharedService, createProject, deviceId as newDeviceId } from './fake-shared-env.mjs';

/** 回显模块：`echo` 回 `echo.ok`（带序号，数分发次数）；`flood` 往本连接灌 n 条（可带合并键）；`kick` 关本连接 */
function toolsModule() {
  const seen = [];
  return {
    seen,
    name: 'tools',
    types: ['echo', 'flood', 'kick'],
    handle(ctx, connId, m) {
      if (m.type === 'echo') {
        seen.push(m.v);
        ctx.send(connId, { type: 'echo.ok', reqId: m.reqId, v: m.v });
      } else if (m.type === 'flood') {
        const pad = 'p'.repeat(m.pad ?? 1000);
        for (let i = 0; i < m.n; i++) {
          const key = m.key ? `${m.key}:${i % (m.keys ?? 1)}` : undefined;
          ctx.send(connId, { type: 'flood.item', i, key: key ?? null, pad }, key ? { coalesceKey: key } : undefined);
        }
        ctx.send(connId, { type: 'flood.done', reqId: m.reqId, n: m.n });
      } else if (m.type === 'kick') {
        ctx.close(connId, 4003, 'kicked');
      }
    },
  };
}

async function start(t, options = {}) {
  const logs = [];
  const tools = toolsModule();
  const service = createDocService({
    autoTick: false,
    authenticate: authByProtocols,
    log: (event, fields) => logs.push({ event, ...fields }),
    modules: [tools],
    ...options,
  });
  const { port } = await service.listen(0, '127.0.0.1');
  t.after(() => service.close());
  const base = `http://127.0.0.1:${port}`;
  return { service, port, base, logs, tools, c: lp(base), url: `ws://127.0.0.1:${port}`, healthz: async () => (await fetch(`${base}/healthz`)).json() };
}

async function opened(env, protocols = protocolsOf({ user: 'alice' })) {
  const r = await env.c.open(protocols);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.sid;
}

// ------------------------------------------------------------------ open

test('HT1 open：成功回 sid 与参数；缺头或不是 promptcut.v1 开头 400；鉴权不过 401；回包 JSON、no-store', async (t) => {
  const env = await start(t);
  const r = await env.c.open(protocolsOf({ user: 'alice' }));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const { sid, ...rest } = r.body;
  assert.match(sid, /^[A-Za-z0-9_-]{43}$/, 'sid 是 32 字节的 base64url');
  assert.deepEqual(rest, { ok: true, protocol: 'promptcut.v1', transport: 'http', waitMs: 25_000, idleMs: 60_000, maxFrameBytes: 1024 * 1024 });

  assert.deepEqual((await env.c.open(null)).body, { ok: false, error: 'bad-protocols' });
  assert.equal((await env.c.open(null)).status, 400);
  assert.equal((await env.c.open(['x-user.alice', 'promptcut.v1'])).status, 400, '第一项必须是 promptcut.v1');
  const denied = await env.c.open(protocolsOf({ user: 'deny' }));
  assert.equal(denied.status, 401);
  assert.deepEqual(denied.body, { ok: false, error: 'unauthorized' });

  // 登记进核心：describe 里有这条连接，principal 来自子协议
  const d = env.service.describe();
  assert.equal(d.conns.length, 1);
  assert.equal(d.conns[0].principal.userId, 'alice');
  // sid 不进日志
  assert.ok(!JSON.stringify(env.logs).includes(sid), '日志里不能有 sid');
  const openLog = env.logs.find((l) => l.event === 'conn.open');
  assert.equal(openLog.transport, 'http');
  assert.equal(openLog.remote, '127.0.0.1');
});

test('HT1 open：子协议列表当作 sec-websocket-protocol 交给同一个 authenticate；req.socket 是真实 socket（伪造的头不影响来源）', async (t) => {
  const seen = [];
  const env = await start(t, {
    authenticate(req) {
      seen.push({ protocols: req.headers['sec-websocket-protocol'], remote: req.socket?.remoteAddress, xff: req.headers['x-forwarded-for'], url: req.url });
      return authByProtocols(req);
    },
  });
  const r = await env.c.open(['promptcut.v1', 'x-user.bob'], { 'sec-websocket-protocol': 'promptcut.v1, x-user.mallory', 'x-forwarded-for': '203.0.113.9' });
  assert.equal(r.status, 200);
  assert.deepEqual(seen, [{ protocols: 'promptcut.v1, x-user.bob', remote: '127.0.0.1', xff: '203.0.113.9', url: '/lp/open' }]);
  assert.equal(env.service.describe().conns[0].principal.userId, 'bob', '只认 X-Promptcut-Protocols，客户端自带的 Sec-WebSocket-Protocol 被覆盖');
});

test('HT1 open：共享项目的证明与 WebSocket 同一套——有效证明进、错口令 401、nonce 重用 401、限速对两种传输一起生效', async (t) => {
  const s = await startSharedService();
  t.after(() => s.close());
  const c = lp(`http://127.0.0.1:${s.port}`);
  const proj = await createProject(s.base);
  const dev = newDeviceId('ht');
  const proof = (password = 'project-pw', username = 'bob') => buildAuthProtocols({
    base: s.base, projectId: proj.projectId, username, deviceId: dev, deviceName: 'HT', password, role: 'render', as: 'member',
  });

  const good = await proof();
  const ok = await c.open(good);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const conn = s.service.describe().conns.find((x) => x.principal.username === 'bob');
  assert.ok(conn, '成员身份登记进核心');
  assert.equal(conn.principal.tenantId, proj.projectId);
  assert.equal(conn.principal.role, 'render');
  assert.equal((await c.open(good)).status, 401, '同一个证明（nonce 只能用一次）再来 401');
  assert.equal((await c.open(await proof('wrong-pw'))).status, 401, '错口令 401');
  assert.ok(s.logs.some((l) => l.event === 'auth.reject' && l.reason === 'nonce'), '拒绝原因记 nonce');
  assert.ok(s.logs.some((l) => l.event === 'auth.reject' && l.reason === 'bad-proof'), '拒绝原因记 bad-proof');

  // 限速：同一来源再错到 5 次，之后口令对也 401；WebSocket 握手同样被拒（同一个限速器）
  const held = await proof();
  for (let i = 0; i < 4; i++) assert.equal((await c.open(await proof(`wrong-${i}`))).status, 401);
  assert.equal((await c.open(held)).status, 401, '冷却中口令对也拒');
  assert.ok(s.logs.some((l) => l.event === 'auth.reject' && l.reason === 'rate-limited'));
  const hs = await rawHandshake(s.port, { protocols: held });
  hs.sock.destroy();
  assert.equal(hs.status, 401, 'WebSocket 握手也在冷却里');
});

test('HT1 open：回环信任只按 socket 对端地址算——回环来的不带凭证是本机身份；不认回环时同样的请求 401', async (t) => {
  const trusting = await startSharedService({ isLoopback: (req) => isLoopbackAddress(req?.socket?.remoteAddress) });
  t.after(() => trusting.close());
  const r = await lp(`http://127.0.0.1:${trusting.port}`).open(['promptcut.v1']);
  assert.equal(r.status, 200);
  assert.deepEqual(trusting.service.describe().conns[0].principal, { userId: 'local', tenantId: 'local', scope: 'local', role: 'page' });

  const strict = await startSharedService();
  t.after(() => strict.close());
  const r2 = await lp(`http://127.0.0.1:${strict.port}`).open(['promptcut.v1'], { 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1' });
  assert.equal(r2.status, 401, '转发头不算回环');
});

test('HT1 open：maxConnections 由 WebSocket 与 HTTP 共用；/healthz 的 transports 与 connections 对得上', async (t) => {
  const env = await start(t, { maxConnections: 2 });
  const w = wsClient(env.url, protocolsOf({ user: 'w' }));
  t.after(() => w.close());
  await w.opened;
  const sid = await opened(env);
  const full = await env.c.open(protocolsOf({ user: 'x' }));
  assert.equal(full.status, 503, '一条 WS + 一条 HTTP 已满');
  const hs = await rawHandshake(env.port, { protocols: protocolsOf({ user: 'y' }) });
  hs.sock.destroy();
  assert.equal(hs.status, 503, 'WebSocket 也算进同一个上限');
  const h = await env.healthz();
  assert.equal(h.connections, 2);
  assert.deepEqual(h.transports, { ws: 1, http: 1, httpOpened: 1, httpExpired: 0, httpSuperseded: 0 });
  assert.equal(h.transports.ws + h.transports.http, h.connections);
  assert.equal(h.protocol, 'promptcut.v1', 'protocol 字段不变');
  assert.ok(sid);
});

// ------------------------------------------------------------------ send

test('HT1 send：按批次号顺序逐帧分发；重发同一批幂等；跳号 409 带 expect；格式不对 400', async (t) => {
  const env = await start(t);
  const sid = await opened(env);
  const echo = (v) => ({ type: 'echo', reqId: v, v });
  let r = await env.c.send(sid, 1, [echo('a'), echo('b')]);
  assert.deepEqual([r.status, r.body], [200, { ok: true, ack: 1 }]);
  r = await env.c.send(sid, 2, [echo('c')]);
  assert.deepEqual(r.body, { ok: true, ack: 2 });
  r = await env.c.send(sid, 2, [echo('c')]);
  assert.deepEqual([r.status, r.body], [200, { ok: true, ack: 2 }], '重发回成功');
  r = await env.c.send(sid, 1, [echo('a')]);
  assert.deepEqual(r.body, { ok: true, ack: 2 }, '更早的批次也照样回成功');
  assert.deepEqual(env.tools.seen, ['a', 'b', 'c'], '重发不再分发，顺序照批次与帧序');
  r = await env.c.send(sid, 4, [echo('d')]);
  assert.deepEqual([r.status, r.body], [409, { ok: false, error: 'out-of-order', expect: 3 }]);
  assert.equal((await env.c.sendRaw(sid, '{"seq":"x","frames":[]}')).status, 400);
  assert.equal((await env.c.sendRaw(sid, 'not json')).status, 400);
  assert.equal((await env.c.sendRaw(sid, JSON.stringify({ seq: 3, frames: [1] }))).status, 400, '帧必须是字符串');
  const { frames } = await recvUntil(env.c, sid, (m) => m.v === 'c');
  assert.deepEqual(frames.map((m) => m.v), ['a', 'b', 'c']);
});

test('HT1 send：单帧超过 maxFrameBytes 回 413，会话以 1009 关闭', async (t) => {
  const env = await start(t, { maxPayload: 1024 });
  const sid = await opened(env);
  const r = await env.c.send(sid, 1, ['x'.repeat(1025)]);
  assert.deepEqual([r.status, r.body], [413, { ok: false, error: 'too-large' }]);
  const g = await env.c.recv(sid, 0, 0);
  assert.equal(g.status, 200);
  assert.deepEqual(g.body.closed, { code: 1009, reason: 'too-large' });
  await waitFor(() => env.logs.some((l) => l.event === 'conn.close' && l.code === 1009 && l.transport === 'http'), 2000, 'conn.close 1009');
  // 请求体整个超过上限（单帧上限 + 64 KiB）也回 413
  const sid2 = await opened(env);
  assert.equal((await env.c.sendRaw(sid2, JSON.stringify({ seq: 1, frames: ['y'.repeat(70 * 1024)] }))).status, 413);
});

// ------------------------------------------------------------------ recv

test('HT1 recv：没帧就挂着，到 wait 回空；有新帧立刻回；ack 丢帧，旧 ack 重发', async (t) => {
  const env = await start(t);
  const sid = await opened(env);
  let t0 = Date.now();
  let g = await env.c.recv(sid, 0, 300);
  assert.deepEqual(g.body, { ok: true, frames: [], closed: null });
  assert.ok(Date.now() - t0 >= 250, `挂了 ${Date.now() - t0} ms`);

  // 挂着的时候来了消息：立刻回
  t0 = Date.now();
  const pending = env.c.recv(sid, 0, 5000);
  await sleep(50);
  await env.c.send(sid, 1, [{ type: 'echo', reqId: 1, v: 'one' }]);
  g = await pending;
  assert.ok(Date.now() - t0 < 2000, '被新帧叫醒');
  assert.equal(g.body.frames.length, 1);
  assert.equal(g.body.frames[0].seq, 1);
  assert.equal(JSON.parse(g.body.frames[0].data).v, 'one');

  // 响应丢在路上：客户端还带旧 ack，服务端重发同样的帧
  g = await env.c.recv(sid, 0, 0);
  assert.deepEqual(g.body.frames.map((f) => f.seq), [1], '旧 ack 重发');
  await env.c.send(sid, 2, [{ type: 'echo', reqId: 2, v: 'two' }]);
  await sleep(30);
  g = await env.c.recv(sid, 1, 0);
  assert.deepEqual(g.body.frames.map((f) => [f.seq, JSON.parse(f.data).v]), [[2, 'two']], 'ack 1 之后只剩 2');
  assert.equal((await env.c.recv(sid, 5, 0)).status, 400, 'ack 超过已发的最大序号');
});

test('HT1 recv：一个会话只一个挂起的 GET——新的替换旧的，旧的回 superseded；计入 httpSuperseded', async (t) => {
  const env = await start(t);
  const sid = await opened(env);
  const first = env.c.recv(sid, 0, 5000);
  await sleep(50);
  const second = env.c.recv(sid, 0, 300);
  const a = await first;
  assert.deepEqual(a.body, { ok: true, frames: [], closed: null, superseded: true });
  const b = await second;
  assert.deepEqual(b.body, { ok: true, frames: [], closed: null });
  assert.equal((await env.healthz()).transports.httpSuperseded, 1);
});

test('HT1 recv：服务端关闭会话（模块 ctx.close 4003）时先回完剩下的帧再带 closed，之后 410；未知 sid 404', async (t) => {
  const env = await start(t);
  const sid = await opened(env);
  const hanging = env.c.recv(sid, 0, 5000);
  await sleep(30);
  await env.c.send(sid, 1, [{ type: 'echo', reqId: 1, v: 'last' }, { type: 'kick' }]);
  const g = await hanging;
  // 可能一次就带上 closed，也可能先回 echo 再回 closed
  const frames = [...g.body.frames];
  let closed = g.body.closed;
  if (!closed) {
    const g2 = await env.c.recv(sid, frames.at(-1)?.seq ?? 0, 2000);
    frames.push(...g2.body.frames);
    closed = g2.body.closed;
  }
  assert.deepEqual(frames.map((f) => JSON.parse(f.data).v), ['last'], '剩下的帧先回完');
  assert.deepEqual(closed, { code: 4003, reason: 'kicked' });
  const after = await env.c.recv(sid, 1, 0);
  assert.deepEqual([after.status, after.body], [410, { ok: false, error: 'session-closed', code: 4003, reason: 'kicked' }]);
  assert.equal((await env.c.send(sid, 2, [])).status, 410);
  await waitFor(() => env.service.health().connections === 0, 2000, '核心注销');
  assert.ok(env.logs.some((l) => l.event === 'conn.close' && l.code === 4003 && l.transport === 'http'));

  const bogus = 'A'.repeat(43);
  assert.deepEqual((await env.c.recv(bogus, 0, 0)).body, { ok: false, error: 'no-session' });
  assert.equal((await env.c.recv(bogus, 0, 0)).status, 404);
  assert.equal((await env.c.call('GET', 'recv', { query: '?ack=0' })).status, 404, '不带 Authorization 也是 404');
});

test('HT1 close：挂着的 GET 回 closed，核心注销并打 conn.close；之后 410', async (t) => {
  const env = await start(t);
  const sid = await opened(env);
  const hanging = env.c.recv(sid, 0, 5000);
  await sleep(30);
  const r = await env.c.close(sid, { code: 1000, reason: 'bye' });
  assert.deepEqual([r.status, r.body], [200, { ok: true }]);
  assert.deepEqual((await hanging).body.closed, { code: 1000, reason: 'bye' });
  await waitFor(() => env.service.health().connections === 0, 2000, '核心注销');
  assert.ok(env.logs.some((l) => l.event === 'conn.close' && l.code === 1000 && l.reason === 'bye' && l.transport === 'http'));
  assert.equal((await env.c.recv(sid, 0, 0)).status, 410);
});

test('HT1 过期：既没挂着的 GET、idleMs 内也没来过请求的会话按超时关闭（1006 timeout，conn.timeout）；挂着 GET 的不过期', async (t) => {
  const env = await start(t, { heartbeatMs: 50, httpIdleMs: 200 });
  const idle = await opened(env);
  const busy = await opened(env, protocolsOf({ user: 'busy' }));
  const hanging = env.c.recv(busy, 0, 700);
  await waitFor(() => env.logs.some((l) => l.event === 'conn.timeout' && l.transport === 'http'), 3000, '空闲会话过期');
  const g = await env.c.recv(idle, 0, 0);
  assert.deepEqual([g.status, g.body], [410, { ok: false, error: 'session-closed', code: 1006, reason: 'timeout' }]);
  assert.deepEqual((await hanging).body, { ok: true, frames: [], closed: null }, '挂着 GET 的会话没过期');
  const h = await env.healthz();
  assert.equal(h.transports.httpExpired, 1);
  assert.equal(h.transports.http, 1);
  assert.equal(h.connections, 1);
  assert.equal(env.logs.filter((l) => l.event === 'conn.timeout').length, 1);
});

test('HT1 /healthz 与 describe：transports 字段、conns 里有 HTTP 连接；closeConn 能关 HTTP 连接', async (t) => {
  const env = await start(t);
  const sid = await opened(env);
  const d = env.service.describe();
  assert.equal(d.transports.http, 1);
  const connId = d.conns[0].connId;
  assert.equal(env.service.closeConn(connId, 4004, 'deleted'), true);
  const g = await env.c.recv(sid, 0, 0);
  assert.deepEqual(g.body.closed, { code: 4004, reason: 'deleted' });
  assert.equal(env.service.closeConn(connId, 4004, 'deleted'), false, '已关的再关回 false');
});

test('HT1 跨源：名单里的 Origin 回 ACAO 与 Vary；预检 204 带允许的方法与头；名单外或名单空不回 CORS 头', async (t) => {
  const env = await start(t, { httpCorsOrigins: ['http://app.test'] });
  const pre = await env.c.options('open', { origin: 'http://app.test', 'access-control-request-method': 'POST' });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), 'http://app.test');
  assert.equal(pre.headers.get('vary'), 'Origin');
  assert.equal(pre.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
  assert.equal(pre.headers.get('access-control-allow-headers'), 'Authorization, Content-Type, X-Promptcut-Protocols');
  assert.equal(pre.headers.get('access-control-max-age'), '600');
  assert.equal(env.service.health().connections, 0, '预检不做会话操作');
  const r = await env.c.open(protocolsOf({ user: 'alice' }), { origin: 'http://app.test' });
  assert.equal(r.headers.get('access-control-allow-origin'), 'http://app.test');
  const other = await env.c.open(protocolsOf({ user: 'alice' }), { origin: 'http://evil.test' });
  assert.equal(other.headers.get('access-control-allow-origin'), null);
  const preOther = await env.c.options('recv', { origin: 'http://evil.test' });
  assert.equal(preOther.status, 204);
  assert.equal(preOther.headers.get('access-control-allow-origin'), null);
  assert.equal(preOther.headers.get('access-control-allow-methods'), null);

  const plain = await start(t);
  const p = await plain.c.options('open', { origin: 'http://app.test' });
  assert.equal(p.status, 204);
  assert.equal(p.headers.get('access-control-allow-origin'), null, '名单为空不回 CORS 头');
});

test('HT1 关停：挂着的 GET 立刻回 closed 1001', async (t) => {
  const env = await start(t);
  const sid = await opened(env);
  const hanging = env.c.recv(sid, 0, 10_000);
  await sleep(30);
  const t0 = Date.now();
  await env.service.close();
  const g = await hanging;
  assert.deepEqual(g.body.closed, { code: 1001, reason: 'server shutting down' });
  assert.ok(Date.now() - t0 < 3000);
});

// ------------------------------------------------------------------ HT2 背压

test('HT2 背压：客户端不来取，未确认字节涨到高水位进核心队列、合并键照常生效；超过 maxPendingBytes 以 1013 关闭，下一次 GET 拿到 closed', async (t) => {
  const env = await start(t, { highWaterBytes: 8 * 1024, maxPendingBytes: 64 * 1024 });
  const sid = await opened(env);
  // 合并：同一个键反复发 200 条，只有进了队列的会被合并（前几条直接写进未确认缓冲）
  await env.c.send(sid, 1, [{ type: 'flood', n: 200, key: 'k', keys: 1, pad: 1000, reqId: 'f1' }]);
  let h = await env.healthz();
  assert.ok(h.coalesced > 150, `合并键生效：coalesced=${h.coalesced}`);
  assert.ok(h.pendingBytesMax >= 8 * 1024, `未确认字节算进积压：${h.pendingBytesMax}`);
  assert.equal(h.backpressureCloses, 0);
  // 取走：ack 让缓冲下降，核心接着写队列里的（合并后只剩最后那条与 flood.done）
  const got = await recvUntil(env.c, sid, (m) => m.type === 'flood.done', { wait: 200 });
  const items = got.frames.filter((m) => m.type === 'flood.item');
  assert.ok(items.length < 20, `合并后只收到 ${items.length} 条`);
  assert.equal(items.at(-1).i, 199, '合并留下的是最新的那条');

  // 不合并地灌：超过 maxPendingBytes → 1013
  await env.c.send(sid, 2, [{ type: 'flood', n: 200, pad: 1000, reqId: 'f2' }]);
  h = await env.healthz();
  assert.equal(h.backpressureCloses, 1);
  assert.ok(env.logs.some((l) => l.event === 'conn.backpressure'));
  const tail = await recvUntil(env.c, sid, () => false, { ack: got.ack, wait: 200 });
  assert.deepEqual(tail.closed, { code: 1013, reason: 'backpressure' }, '下一次 GET 拿到 closed 1013');
  await waitFor(() => env.service.health().connections === 0, 2000, '核心注销');
});

test('HT2 背压：真队列的慢 HTTP 节点被 1013 关闭，正常 WebSocket 节点不受影响', { timeout: 30_000 }, async (t) => {
  const logs = [];
  const service = createDocService({ autoTick: false, log: (e, f) => logs.push({ event: e, ...f }), highWaterBytes: 8 * 1024, maxPendingBytes: 64 * 1024 });
  service.mountRenderQueue(createRenderQueue({ now: Date.now, send: service.send }));
  const { port } = await service.listen(0, '127.0.0.1');
  t.after(() => service.close());
  const c = lp(`http://127.0.0.1:${port}`);
  const sid = (await c.open(['promptcut.v1'])).body.sid;
  await c.send(sid, 1, [{ type: 'node.hello', nodeId: 'slow', profile: 'pc', reqId: 'h' }, { type: 'queue.watch', projects: 'all', reqId: 'w' }]);
  const first = await recvUntil(c, sid, (m) => m.reqId === 'w');
  assert.equal(first.frames.find((m) => m.reqId === 'h').type, 'node.welcome');

  const good = wsClient(`ws://127.0.0.1:${port}`);
  t.after(() => good.close());
  await good.opened;
  good.send({ type: 'node.hello', nodeId: 'good', profile: 'pc', reqId: 'gh' });
  await good.next(byReq('gh'));
  good.send({ type: 'queue.watch', projects: 'all', reqId: 'gw' });
  await good.next(byReq('gw'));
  const pub = wsClient(`ws://127.0.0.1:${port}`);
  t.after(() => pub.close());
  await pub.opened;
  pub.send({ type: 'publisher.hello', publisherId: 'pub-ht2', reqId: 'ph' });
  await pub.next(byReq('ph'));

  let n = 0;
  let received = 0;
  good.ws.addEventListener('message', (e) => { if (JSON.parse(e.data).type === 'task.opened') received += 1; });
  const pad = 'z'.repeat(2048);
  while (!logs.some((l) => l.event === 'conn.backpressure') && n < 2000) {
    const tasks = [];
    for (let k = 0; k < 10; k++) {
      n += 1;
      tasks.push({ id: `snapshot:ht2-${n}:0-29`, kind: 'snapshot', tier: 'shared', resultKey: `ht2-${n}`, range: { unit: 'localFrame', from: 0, to: 29 },
        source: { projectId: 'p', projectRev: 1 }, input: { pad }, weight: { class: 'light', estMs: null, frames: 30 }, requires: {}, priority: 0 });
    }
    pub.send({ type: 'task.publish', tasks, reqId: `p${n}` });
    await pub.next(byReq(`p${n}`));
  }
  assert.ok(logs.some((l) => l.event === 'conn.backpressure'), `发了 ${n} 个任务慢节点仍没被关`);
  const tail = await recvUntil(c, sid, () => false, { ack: first.ack, wait: 200, ms: 5000 });
  assert.deepEqual(tail.closed, { code: 1013, reason: 'backpressure' });
  await waitFor(() => received >= n, 5000, `正常 WebSocket 节点收齐 ${n} 条（已收 ${received}）`);
  await waitFor(() => service.describe().modules['render-queue'].nodes.find((x) => x.nodeId === 'slow')?.connected === false, 2000, '慢节点记为断开');
});
