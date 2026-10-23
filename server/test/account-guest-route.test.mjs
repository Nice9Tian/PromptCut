/**
 * 游客这条路在 HTTP 层整条走一遍（2026-10-23 用户定，语义 dry run 见 `docs/plan/guest-identity-semantics-dryrun.md`）：
 *
 *   GR-1  领令牌 → 建项目 → 发会话票据：全程不碰账号服务，公开路由走得通
 *   GR-2  第二个项目被拒（guest-project-limit）；换个游客身份又能建
 *   GR-3  游客凭链接加入别人的项目：进得去，但会话里 `access` 是 `r`，`creator` 是假
 *   GR-4  领令牌那一条不要 Bearer；别的路由没有 Bearer 照旧 401
 *   GR-5  没配密钥的部署：领令牌回 503 guest-unavailable，账号那条路照常
 *
 * 跑：npm test -- server/test/account-guest-route.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { openAccountLedger } from '../account/ledger.mjs';
import { createAccountHostedRuntime } from '../docservice/account-hosted.mjs';
import { mountAccountProjects } from '../docservice/modules/account-projects.mjs';
import { GUEST_ID_RE, GUEST_LIMITS } from '../account/guest.mjs';
import { createGuestRateLimit } from '../account/guest-rate.mjs';

const A = 'acc_' + 'a'.repeat(24);

async function fixture(t, { guestKey = randomBytes(32), guestRateLimit = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-guest-route-'));
  const ledger = openAccountLedger({ file: path.join(dir, 'doc.sqlite'), authorityId: 'doc-guest-fixture' });
  const accountClient = {
    verify: async (token) => {
      if (token !== 'tok-a') throw Object.assign(new Error('login-required'), { status: 401, code: 'login-required' });
      return { accountId: A, accountName: 'Alice', loginId: 'login-a', credentialId: 'cred-a', loginGeneration: 1,
        expiresAt: Date.now() + 3_600_000, accountEventSeq: 0, kind: 'editor' };
    },
    events: async () => ({ events: [], headSeq: 0 }),
  };
  const runtime = createAccountHostedRuntime({ ledger, accountClient, dataDir: null, authorityUrl: 'https://fixture.invalid',
    allowFixtureAssetReady: true, pollMs: 0, guestKey });
  runtime.setAssetReady(true);
  const registry = { refresh() {}, get: () => null };
  runtime.bindService({ describe: () => ({ conns: [] }), fencePrincipals: async () => ({ actualClosed: true }) }, { registry, urls: {} });
  await runtime.start();
  t.after(() => { try { runtime.close(); } catch { /* 已关 */ } fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

  const mounted = mountAccountProjects({ authority: runtime.authority, issueSession: (o) => runtime.issueSession(o),
    ...(guestRateLimit ? { guestRateLimit } : {}) });
  /**
   * 打一条公开路由。`token` 给 null 就不带 Bearer（领游客令牌那一条就是这样）；
   * `peer` 是套接字对端，限流按它算（`server/account/guest-rate.mjs`）。
   */
  const post = async (token, pathname, body, { peer = '203.0.113.1', extraHeaders = {} } = {}) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method: 'POST', url: pathname, socket: { remoteAddress: peer },
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extraHeaders } });
    let status, value, headers;
    assert.equal(await mounted.handlePublic(req, { writeHead: (s, h) => { status = s; headers = h; }, end: (text) => { value = JSON.parse(text); } }, {}), true);
    return { status, value, headers };
  };
  /** 领一张游客令牌（不带 Bearer）。`previous` 给了就是续期 */
  const guest = async (previous) => {
    const out = await post(null, '/hosted/shared/account/guest', previous ? { token: previous } : {});
    assert.equal(out.status, 200, JSON.stringify(out.value));
    return out.value;
  };
  let serial = 0;
  const create = (token, name = `游客的项目 ${++serial}`) =>
    post(token, '/hosted/shared/account/create', { name, requestId: `create-${serial}`, initialProject: { tracks: [] } });
  return { runtime, ledger, post, guest, create };
}

test('GR-1 领令牌 → 建项目 → 发会话票据，全程不碰账号服务', async t => {
  const f = await fixture(t);
  const g = await f.guest();
  assert.match(g.guestId, GUEST_ID_RE);
  assert.equal(g.renewed, false);
  // 令牌要当 Bearer 送,所以整串只能有 `bearer()` 认的字符(带点号会被当成没登录)
  assert.match(g.token, /^gst1[A-Za-z0-9_-]+$/);
  assert.ok(g.token.length <= 256);

  const made = await f.create(g.token);
  assert.equal(made.status, 201, JSON.stringify(made.value));
  const projectId = made.value.projectId;
  assert.equal(f.ledger.read().projects[projectId].creatorAccountId, g.guestId, '项目的创建者就是这个游客');

  const session = await f.post(g.token, '/hosted/shared/account/session', { projectId, deviceId: 'device-guest', requestId: 'session-1' });
  assert.equal(session.status, 200, JSON.stringify(session.value));
  assert.equal(session.value.creator, true);
  assert.equal(session.value.access, 'rw', '自己建的项目里照常读写');
  assert.ok(session.value.connectionTicket && session.value.assetTicket, '票据照常发');

  // 续期:同一个编号,新令牌照样能用
  const again = await f.guest(g.token);
  assert.equal(again.guestId, g.guestId);
  assert.equal(again.renewed, true);
  assert.equal((await f.post(again.token, '/hosted/shared/account/session',
    { projectId, deviceId: 'device-guest', requestId: 'session-2' })).status, 200);
});

test('GR-2 第二个项目被拒；换个身份又能建', async t => {
  const f = await fixture(t);
  const g = await f.guest();
  assert.equal((await f.create(g.token)).status, 201);
  const second = await f.create(g.token);
  assert.equal(second.status, 403);
  assert.equal(second.value.code, 'guest-project-limit');
  assert.equal(GUEST_LIMITS.projects, 1);
  assert.equal((await f.create((await f.guest()).token)).status, 201, '另一个游客照样建得了');
});

test('GR-3 加入别人的项目：进得去，但只读', async t => {
  const f = await fixture(t);
  const owner = await f.create('tok-a', '账号的项目');
  assert.equal(owner.status, 201);
  const projectId = owner.value.projectId;

  const g = await f.guest();
  const joined = await f.post(g.token, '/hosted/shared/account/join', { projectId, requestId: 'join-1', deviceId: 'device-guest' });
  assert.equal(joined.status, 200, JSON.stringify(joined.value));
  assert.equal(joined.value.membership.access, 'r');
  assert.equal(joined.value.access, 'r', '会话里也该是只读');
  assert.equal(joined.value.creator, false);
  assert.ok(joined.value.connectionTicket, '只读也发票据，不然连都连不上，看不了');

  // 改设置这类只有创建者能做的,照旧拒
  const admin = await f.post(g.token, '/hosted/shared/account/admin',
    { projectId, op: 'set-entry', allowLinkJoin: false, expectedAccessRevision: joined.value.accessRevision, requestId: 'admin-1' });
  assert.equal(admin.status, 403);
  assert.equal(admin.value.code, 'creator-required');
});

test('GR-4 领令牌不要 Bearer；别的路由没有 Bearer 照旧 401', async t => {
  const f = await fixture(t);
  const g = await f.guest();                                   // 不带 Bearer 也拿得到
  assert.ok(g.token);
  const noAuth = await f.post(null, '/hosted/shared/account/create', { name: '偷偷建', requestId: 'c-1', initialProject: { tracks: [] } });
  assert.equal(noAuth.status, 401);
  assert.equal(noAuth.value.code, 'login-required');
  // 请求体里写编号不算数:回的编号和写的那个不一样
  const claimed = await f.post(null, '/hosted/shared/account/guest', { guestId: 'gst_' + 'f'.repeat(24), accountId: 'gst_' + 'e'.repeat(24) });
  assert.equal(claimed.status, 200);
  assert.notEqual(claimed.value.guestId, 'gst_' + 'f'.repeat(24));
  assert.notEqual(claimed.value.guestId, g.guestId);
});

test('GR-5 没配密钥的部署：游客这条路回 503，账号那条路照常', async t => {
  const f = await fixture(t, { guestKey: null });
  const out = await f.post(null, '/hosted/shared/account/guest', {});
  assert.equal(out.status, 503);
  assert.equal(out.value.code, 'guest-unavailable');
  assert.equal((await f.create('tok-a', '账号的项目')).status, 201, '账号那条路不该受影响');
});

test('GR-6 领令牌按 IP 限流：到数回 429 并带 Retry-After，换个 IP 不受牵连', async t => {
  let at = 1_000_000;
  const f = await fixture(t, { guestRateLimit: createGuestRateLimit({ max: 2, windowMs: 60_000, now: () => at }) });
  const claim = (peer, headers) => f.post(null, '/hosted/shared/account/guest', {}, { peer, extraHeaders: headers });

  for (let i = 0; i < 2; i++) assert.equal((await claim('198.51.100.5')).status, 200, `第 ${i + 1} 次`);
  const refused = await claim('198.51.100.5');
  assert.equal(refused.status, 429);
  assert.equal(refused.value.code, 'guest-rate-limited');
  assert.equal(refused.headers['retry-after'], '60', '要告诉页面等多久，不然它原地重试');

  assert.equal((await claim('198.51.100.6')).status, 200, '换个 IP 不该被牵连');
  // 经 nginx 进来按最后一跳算:伪造前面那几跳绕不过去
  assert.equal((await claim('127.0.0.1', { 'x-forwarded-for': '1.1.1.1, 198.51.100.5' })).status, 429);
  assert.equal((await claim('127.0.0.1', { 'x-forwarded-for': '198.51.100.5, 9.9.9.9' })).status, 200, '最后一跳是别人就是别人');

  // 窗口滚过去就又能领
  at += 60_001;
  assert.equal((await claim('198.51.100.5')).status, 200);
});

test('GR-7 续期不算进限流：同一个 IP 到数之后，带着旧令牌来照样续上（审查 E）', async t => {
  let at = Date.now();
  const f = await fixture(t, { guestRateLimit: createGuestRateLimit({ max: 2, windowMs: 60_000, now: () => at }) });
  const claim = (body) => f.post(null, '/hosted/shared/account/guest', body, { peer: '198.51.100.9' });
  const first = (await claim({})).value;
  assert.equal((await claim({})).status, 200);
  assert.equal((await claim({})).status, 429, '发新身份到数');
  for (let i = 0; i < 30; i++) {
    const r = await claim({ token: first.token });
    assert.equal(r.status, 200, `第 ${i + 1} 次续期`);
    assert.equal(r.value.guestId, first.guestId);
  }
  // 拿不出有效旧令牌的（乱写的）算发新身份，照样数
  assert.equal((await claim({ token: 'gst1garbage' })).status, 429);
});

test('GR-8 带 revoke 作废手里那一张：之后拿它进不了、续不了（审查 S9）', async t => {
  const f = await fixture(t);
  const g = await f.guest();
  const made = await f.create(g.token);
  assert.equal(made.status, 201);
  const out = await f.post(null, '/hosted/shared/account/guest', { token: g.token, revoke: true });
  assert.deepEqual([out.status, out.value.revoked], [200, true]);
  assert.equal((await f.create(g.token)).status, 401, '作废的令牌核不过');
  const again = await f.guest(g.token);
  assert.notEqual(again.guestId, g.guestId, '作废的续不了期');
});
