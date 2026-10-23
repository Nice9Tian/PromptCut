/**
 * 游客是一种主体，不是「没有账号」（claude/guest-enter）：`client.principal`、成员名单里的游客、云端 Agent 告知。
 *
 * 0.7.21 线上：游客建好项目、点进去报「请先登录账号。」—— 进项目那一步看的是 `client.account`（网站账号），游客那里必是 null。
 *
 * 跑：npm test -- src/account/guestPrincipal.test.mjs
 */
import '../testing/registerTs.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createAccountClient, PRINCIPAL_ID_RE } = await import('./client.ts');

const device = { deviceId: 'device-test', deviceName: 'fixture' };
const projectId = 'sp_' + 'a'.repeat(26);
const reply = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const G = 'gst_' + '0'.repeat(20) + '7f3a';
const A = 'acc_' + '1'.repeat(24);

function withStorage(t) {
  const map = new Map();
  const fake = { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k) };
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true, writable: true });
  t.after(() => { if (had) Object.defineProperty(globalThis, 'localStorage', had); else delete globalThis.localStorage; });
}
function server(routes = {}) {
  const calls = [];
  const fetcher = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push(url.pathname);
    if (url.pathname === '/hosted/shared/account/guest') return reply({ ok: true, guestId: G, token: `tok-${G}`, expiresAt: 1000 + 86_400_000 });
    if (routes[url.pathname]) return routes[url.pathname](body);
    return reply({ ok: false, code: 'login-required' }, 401);
  };
  return { calls, fetcher };
}
const client = fetcher => createAccountClient({ online: true, origin: 'https://visuhive.com', device, now: () => 1000, fetch: fetcher });

test('游客模式下 principal 是游客,account 仍是 null(凭账号的事照旧不做)', async t => {
  withStorage(t);
  const c = client(server().fetcher);
  assert.equal(c.principal, null, '还没进来:谁都不是');
  await c.enterAsGuest();
  assert.deepEqual(c.principal, { id: G, name: '游客-7F3A' });
  assert.equal(c.account, null, '网站账号那一栏不冒充');
  c.leaveGuest();
  assert.equal(c.principal, null, '不当游客了就不是谁');
});

test('主体编号:账号和游客两种都认', () => {
  assert.ok(PRINCIPAL_ID_RE.test(A));
  assert.ok(PRINCIPAL_ID_RE.test(G));
  assert.ok(!PRINCIPAL_ID_RE.test('gst_xyz'));
});

test('成员名单里有游客:不当协议错误;游客没名字时显示「游客-XXXX」', async t => {
  withStorage(t);
  const members = () => reply({ ok: true, v: 2, authorityId: 'doc', projectId, accessRevision: 3, creatorAccountId: G, allowLinkJoin: true,
    self: { accountId: G, creator: true, access: 'rw' },
    members: [{ accountId: G, accountName: null, access: 'rw', joinedAt: 1 }, { accountId: A, accountName: 'Alice', access: 'rw', joinedAt: 2 }],
    devices: [{ accountId: G, accountName: null, deviceId: 'dev-1', deviceName: 'dev-1', creator: true, conns: [{ role: 'page' }] }],
    bans: [], requests: [] });
  const c = client(server({ '/hosted/shared/account/members': members }).fetcher);
  await c.enterAsGuest();
  const snap = await c.members(projectId);
  assert.equal(snap.creatorAccountId, G);
  assert.deepEqual(snap.members.map(m => m.accountName), ['游客-7F3A', 'Alice']);
  assert.equal(snap.devices[0].accountName, '游客-7F3A');
});

test('创建者可以踢游客(编号是 gst_ 的也收)', async t => {
  withStorage(t);
  let sent = null;
  const admin = body => { sent = body; return reply({ ok: true, eventId: 'e1', accessRevision: 4, completed: false, state: 'pending-services' }); };
  const c = client(server({ '/hosted/shared/account/admin': admin }).fetcher);
  await c.enterAsGuest();
  const out = await c.memberAdmin(projectId, { op: 'kick', accountId: G, expectedAccessRevision: 3, requestId: 'r1' });
  assert.equal(out.accessRevision, 4);
  assert.equal(sent.accountId, G);
});

test('游客问云端 Agent 告知:明说用不了,不去打网站账号的接口', async t => {
  withStorage(t);
  const { calls, fetcher } = server();
  const c = client(fetcher);
  await c.enterAsGuest();
  const before = calls.length;
  await assert.rejects(c.cloudAgentConsent(), { code: 'guest-agent-unavailable', status: 403, message: /游客暂时用不了云端 Agent/ });
  await assert.rejects(c.acceptCloudAgentConsent(), { code: 'guest-agent-unavailable' });
  assert.equal(calls.length, before, '一个请求也没发');
});
