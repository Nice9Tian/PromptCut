/**
 * 页面这一侧的游客路（`client.ts` 的 `enterAsGuest` / `newGuest` / `leaveGuest`）：
 * 领令牌、带着旧的续期、用它去打 `/hosted/shared/account/*`、过期先续再打。
 *
 * 跑：npm test -- src/account/guestClient.test.mjs
 */
import '../testing/registerTs.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createAccountClient } = await import('./client.ts');
const { GUEST_STORAGE_KEY, loadGuest } = await import('./guest.ts');

const device = { deviceId: 'device-test', deviceName: 'fixture' };
const projectId = 'sp_' + 'a'.repeat(26);
const reply = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
const guestId = n => 'gst_' + String(n).padStart(24, '0');

/** Node 里没有 localStorage，给一个假的；每个用例自己清干净 */
function withStorage(t) {
  const map = new Map();
  const fake = { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k) };
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true, writable: true });
  t.after(() => { if (had) Object.defineProperty(globalThis, 'localStorage', had); else delete globalThis.localStorage; });
  return map;
}

/** 假服务端：记下每次请求，游客路由按「带没带旧令牌」答 */
function server({ expires = 100_000, now = () => 1000 } = {}) {
  const calls = [];
  let serial = 0, issued = 0;
  const fetcher = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ path: url.pathname, body, auth: init?.headers?.Authorization ?? null, credentials: init?.credentials });
    if (url.pathname === '/hosted/shared/account/guest') {
      // 带着旧令牌就续期、编号不变；不带就换一个新身份（服务端的实现在 server/account/guest.mjs）
      const id = typeof body?.token === 'string' ? body.token.split(':')[1] : guestId(++serial);
      return reply({ ok: true, guestId: id, token: `tok:${id}:${++issued}`, expiresAt: now() + expires });
    }
    if (url.pathname.endsWith('/session') || url.pathname.endsWith('/join')) {
      return reply({ ok: true, connectionTicket: 'c'.repeat(43), assetTicket: 'a'.repeat(43), agentDelegationTicket: 'd'.repeat(43),
        expiresAt: now() + 60_000, projectId, creator: false, access: 'r', accessRevision: 1,
        hosted: { agent: { available: false, enabled: false, url: null } } });
    }
    if (url.pathname.endsWith('/create')) return reply({ ok: true, projectId, authorityId: 'doc', contentId: 'c', accessRevision: 1 });
    return reply({ ok: false, code: 'no-route' });
  };
  return { calls, fetcher };
}
const client = (fetcher, now = () => 1000) => createAccountClient({ online: true, origin: 'https://visuhive.com', device, now, fetch: fetcher });

test('第一次进来：不带旧令牌，服务端给一个新身份，存回本机', async t => {
  const store = withStorage(t);
  const { calls, fetcher } = server();
  const c = client(fetcher);
  assert.equal(c.guest, null, '一开始不是游客');
  const g = await c.enterAsGuest();
  assert.equal(g.id, guestId(1));
  assert.equal(g.name, '游客-0001');
  assert.equal(c.guest?.token, g.token);
  assert.deepEqual(calls.map(x => [x.path, x.body]), [['/hosted/shared/account/guest', {}]], '没有旧令牌就不带');
  // 存回本机了:编号、名字、令牌都在
  const saved = JSON.parse(store.get(GUEST_STORAGE_KEY));
  assert.equal(saved.id, g.id);
  assert.equal(saved.token, g.token);
  assert.equal(loadGuest()?.id, g.id);
});

test('再进来：把本机那一张交回去续期，编号不变', async t => {
  withStorage(t);
  const { calls, fetcher } = server();
  const first = await client(fetcher).enterAsGuest();
  // 换一个 client（等于刷新了页面），本机存档还在
  const again = await client(fetcher).enterAsGuest();
  assert.equal(again.id, first.id, '刷新之后还是同一个人');
  assert.notEqual(again.token, first.token, '令牌换了新的');
  assert.deepEqual(calls[1].body, { token: first.token }, '第二次该把旧令牌交回去');
});

test('「换一个」不交旧令牌，于是换了个人；本机存档跟着换', async t => {
  withStorage(t);
  const { fetcher } = server();
  const c = client(fetcher);
  const first = await c.enterAsGuest();
  const second = await c.newGuest();
  assert.notEqual(second.id, first.id);
  assert.equal(loadGuest()?.id, second.id);
  assert.equal(c.guest?.id, second.id);
});

test('拿游客令牌去打账号那几条路由：Bearer 是它，不带 cookie', async t => {
  withStorage(t);
  const { calls, fetcher } = server();
  const c = client(fetcher);
  const g = await c.enterAsGuest();
  await c.session(projectId);
  const call = calls.find(x => x.path.endsWith('/session'));
  assert.equal(call.auth, `Bearer ${g.token}`);
  assert.equal(call.credentials, 'omit', '带了令牌就不该再带 cookie');
  assert.equal(calls.some(x => x.path.startsWith('/api/account/')), false, '游客不该去问网站账号');
});

test('令牌快过期了：打之前先续一张，再用新的那张去打', async t => {
  withStorage(t);
  let clock = 1000;
  const { calls, fetcher } = server({ expires: 30_000, now: () => clock });
  const c = client(fetcher, () => clock);
  const first = await c.enterAsGuest();
  clock += 29_000; // 只剩 1 秒，不够 10 秒的余量
  await c.session(projectId);
  const guestCalls = calls.filter(x => x.path.endsWith('/guest'));
  assert.equal(guestCalls.length, 2, '该先续一张');
  assert.deepEqual(guestCalls[1].body, { token: first.token });
  assert.equal(calls.find(x => x.path.endsWith('/session')).auth, `Bearer ${c.guest.token}`);
  assert.notEqual(c.guest.token, first.token);
});

test('不当游客了：本机存档清掉，之后再进来是新身份', async t => {
  const store = withStorage(t);
  const { fetcher } = server();
  const c = client(fetcher);
  const first = await c.enterAsGuest();
  c.leaveGuest();
  assert.equal(c.guest, null);
  assert.equal(store.has(GUEST_STORAGE_KEY), false, '留着会被下次进入捡回来');
  assert.notEqual((await c.enterAsGuest()).id, first.id);
});

test('服务端答得不成样子就报协议错，不把坏身份存下来', async t => {
  const store = withStorage(t);
  for (const bad of [{ ok: true, guestId: 'acc_' + 'a'.repeat(24), token: 't', expiresAt: 99_000 },
    { ok: true, guestId: guestId(1), token: '', expiresAt: 99_000 },
    { ok: true, guestId: guestId(1), token: 't', expiresAt: 1000 },
    { ok: true, guestId: guestId(1), token: 't' }]) {
    const c = client(async () => reply(bad));
    await assert.rejects(() => c.enterAsGuest(), e => e.code === 'account-protocol', JSON.stringify(bad));
    assert.equal(c.guest, null);
    assert.equal(store.has(GUEST_STORAGE_KEY), false);
  }
});

test('登录账号那一刻游客身份作废，之后拿的是账号的令牌', async t => {
  const store = withStorage(t);
  const calls = [];
  const account = { id: 'acc_' + 'a'.repeat(24), name: 'Alice' };
  const fetcher = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ path: url.pathname, auth: init?.headers?.Authorization ?? null });
    if (url.pathname === '/hosted/shared/account/guest') return reply({ ok: true, guestId: guestId(1), token: 'guest-tok', expiresAt: 100_000 });
    if (url.pathname.endsWith('/me')) return reply({ ok: true, account: body === undefined ? null : account, csrfToken: 'csrf' });
    if (url.pathname.endsWith('/login')) return reply({ ok: true, account, csrfToken: 'csrf' });
    if (url.pathname.includes('/editor/')) return reply({ ok: true, account, loginId: 'editor-1', accessToken: 'account-tok', accessExpiresAt: 100_000 });
    if (url.pathname.endsWith('/session')) return reply({ ok: true, connectionTicket: 'c'.repeat(43), assetTicket: 'a'.repeat(43),
      agentDelegationTicket: 'd'.repeat(43), expiresAt: 60_000, projectId, creator: true, access: 'rw', accessRevision: 1,
      hosted: { agent: { available: false, enabled: false, url: null } } });
    return reply({ ok: false, code: 'no-route' });
  };
  // `/me` 在登录前要答「没登录」,登录后答这个账号:用一个开关代替
  let signedIn = false;
  const c = client(async (url, init) => {
    if (url.pathname.endsWith('/me')) { calls.push({ path: url.pathname, auth: null });
      return reply({ ok: true, account: signedIn ? account : null, csrfToken: 'csrf' }); }
    if (url.pathname.endsWith('/login')) signedIn = true;
    return fetcher(url, init);
  });
  await c.enterAsGuest();
  assert.equal(c.guest?.id, guestId(1));
  await c.login('alice', 'pw', false);
  assert.equal(c.guest, null, '登录之后不该还是游客');
  assert.equal(store.has(GUEST_STORAGE_KEY), false, '本机那一份也该清掉');
  await c.session(projectId);
  assert.equal(calls.filter(x => x.path.endsWith('/session')).at(-1).auth, 'Bearer account-tok', '该用账号的令牌，不是游客的');
});
