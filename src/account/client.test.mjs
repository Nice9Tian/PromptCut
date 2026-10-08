import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAccountClient, projectIdFromLink, projectLink } from './client.ts';

const account = { id: 'acc_' + 'a'.repeat(24), name: 'Alice' };
const projectId = 'sp_' + 'a'.repeat(26);
const device = { deviceId: 'device-test', deviceName: 'fixture' };
const credential = (at = 100_000) => ({ ok: true, account, loginId: 'editor-test', accessToken: 'access-test', accessExpiresAt: at });
const session = { ok: true, connectionTicket: 'c'.repeat(43), assetTicket: 'a'.repeat(43), expiresAt: 100_000 };
const reply = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

test('online account uses cookie+CSRF for website and omit+bearer for exact project; renewal never silently relogs', async () => {
  let clock = 1000; const calls = [];
  const client = createAccountClient({ online: true, origin: 'https://visuhive.com', device, now: () => clock,
    fetch: async (url, init) => { calls.push({ path: url.pathname, ...init });
      if (url.pathname.endsWith('/me')) return reply({ ok: true, account, csrfToken: 'csrf-test' });
      if (url.pathname.endsWith('/projects')) return reply({ ok: true, owned: [], joined: [] });
      if (url.pathname.includes('/editor/')) return reply(credential(clock + 20_000));
      return reply(session);
    } });
  assert.deepEqual(await client.restore(), account);
  await client.session(projectId);
  const cookie = calls.find(call => call.path.endsWith('/editor/session'));
  assert.equal(cookie.credentials, 'same-origin'); assert.equal(cookie.headers['X-CSRF-Token'], 'csrf-test');
  assert.equal(cookie.headers.Authorization, undefined);
  const cloud = calls.find(call => call.path === '/hosted/shared/account/session');
  assert.equal(cloud.credentials, 'omit'); assert.equal(cloud.headers.Authorization, 'Bearer access-test');
  assert.equal(cloud.headers['X-CSRF-Token'], undefined);
  clock = 12_000; await client.session(projectId);
  const renewal = calls.find(call => call.path.endsWith('/editor/renew'));
  assert.equal(JSON.parse(renewal.body).loginId, 'editor-test');
  assert.equal(calls.filter(call => call.path.endsWith('/editor/session')).length, 1);
});

test('desktop password and recovery use only native bridge; caller request IDs are stable for retry', async () => {
  const calls = []; const client = createAccountClient({ online: false, origin: 'https://visuhive.com', device, now: () => 1000,
    fetch: () => { throw new Error('desktop must not fetch credentials'); },
    native: async (operation, args) => { calls.push({ operation, args }); return operation === 'request' ? { ok: true, projectId, authorityId: 'doc-test' } : credential(); } });
  await client.restore(); await client.login('Alice', 'not-recorded', false, 'login-request');
  await client.create('new', { version: 1 }, 'create-request'); await client.create('new', { version: 1 }, 'create-request');
  assert.deepEqual(calls[0], { operation: 'recover', args: device });
  assert.equal(calls[1].args.name, 'Alice'); assert.equal(calls[1].args.identifier, undefined);
  assert.equal(calls[2].args.body.requestId, calls[3].args.body.requestId);
  await assert.rejects(client.lists(), /官网登录/);
});

test('readiness503, membership403 and malformed tickets remain failures; no fallback project or empty list', async () => {
  let code = 'asset-unavailable', status = 503;
  const client = createAccountClient({ online: true, origin: 'https://visuhive.com', device, now: () => 1000,
    fetch: async url => url.pathname.endsWith('/me') ? reply({ ok: true, account, csrfToken: 'csrf' }) :
      url.pathname.includes('/editor/') ? reply(credential()) : reply({ ok: false, code }, status) });
  await client.restore();
  await assert.rejects(client.join(projectId, 'join-request'), error => error.status === 503 && error.code === 'asset-unavailable');
  code = 'banned'; status = 403;
  await assert.rejects(client.join(projectId, 'join-request'), error => error.status === 403 && error.code === 'banned');
  await assert.rejects(client.lists(), error => error.code === 'banned');
  const broken = createAccountClient({ online: false, origin: 'https://visuhive.com', device, now: () => 1000,
    native: async operation => operation === 'recover' ? credential() : { ok: true, connectionTicket: 'short', assetTicket: 'short', expiresAt: 100_000 } });
  await broken.restore(); await assert.rejects(broken.session(projectId), error => error.code === 'session-unavailable');
});

test('project links are bound to one trusted origin, never carry credential material', () => {
  assert.equal(projectIdFromLink(projectLink('https://visuhive.com', projectId), 'https://visuhive.com'), projectId);
  assert.equal(projectIdFromLink(projectId, 'https://visuhive.com'), projectId);
  assert.throws(() => projectIdFromLink(`https://attacker.example/editor?project=${projectId}`, 'https://visuhive.com'));
  assert.throws(() => projectIdFromLink('https://user:pass@visuhive.com/editor?project=' + projectId, 'https://visuhive.com'));
  assert.throws(() => projectIdFromLink('missing', 'https://visuhive.com'));
});

test('logout failures preserve the visible authenticated state; only confirmed exit or native401 clears it', async () => {
  let nativeStatus = 503;
  const desktop = createAccountClient({ online:false, origin:'https://visuhive.com', device, now:() => 1000,
    native:async operation => operation === 'recover' ? credential() : { ok:false, status:nativeStatus, code:'desktop-account-bridge' } });
  await desktop.restore();
  await assert.rejects(desktop.logout(), error => error.status === 503);
  assert.deepEqual(desktop.account, account);
  nativeStatus = 401; await desktop.logout(); assert.equal(desktop.account, null);

  let webStatus = 503;
  const online = createAccountClient({ online:true, origin:'https://visuhive.com', device, now:() => 1000,
    fetch:async url => url.pathname.endsWith('/me') ? reply({ ok:true, account, csrfToken:'csrf' }) :
      url.pathname.includes('/editor/') ? reply(credential()) : webStatus === 200 ? reply({ ok:true }) : reply({ ok:false, code:'account-unavailable' }, webStatus) });
  await online.restore();
  await assert.rejects(online.logout(), error => error.status === 503);
  assert.deepEqual(online.account, account);
  webStatus = 200; await online.logout(); assert.equal(online.account, null);
});

test('consent reads and accepts only the current account through exact bearer route', async () => {
  let accepted = false;
  const calls = [];
  const client = createAccountClient({ online:true, origin:'https://visuhive.com', device, now:() => 1000,
    fetch:async (url, init) => {
      calls.push({ path:url.pathname, init });
      if (url.pathname.endsWith('/me')) return reply({ ok:true, account, csrfToken:'csrf' });
      if (url.pathname.includes('/editor/')) return reply(credential());
      if (url.pathname.endsWith('/cloud-agent-consent')) {
        if (init.method === 'POST') { assert.deepEqual(Object.keys(JSON.parse(init.body)).sort(), ['accept','noticeVersion','requestId']); accepted = true; }
        return reply({ ok:true, accountId:account.id, accepted, noticeVersion:1, ...(accepted ? { acceptedAt:5 } : {}) });
      }
      throw new Error('unexpected route');
    } });
  await client.restore();
  assert.equal((await client.cloudAgentConsent()).accepted, false);
  assert.equal(calls.filter(x => x.path.endsWith('/cloud-agent-consent') && x.init.method === 'POST').length, 0);
  assert.equal((await client.acceptCloudAgentConsent('stable-request')).accepted, true);
  assert.equal((await client.cloudAgentConsent()).accepted, true);
  for (const call of calls.filter(x => x.path.endsWith('/cloud-agent-consent'))) {
    assert.equal(call.init.credentials, 'omit');
    assert.equal(call.init.headers.Authorization, 'Bearer access-test');
    assert.equal(call.init.headers['X-CSRF-Token'], undefined);
  }
});

test('consent rejects a forged account reply and a logout during an in-flight read', async () => {
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  let defer = false;
  const client = createAccountClient({ online:false, origin:'https://visuhive.com', device, now:() => 1000,
    native: async (operation, args) => operation === 'recover' ? credential() : operation === 'logout' ? { ok:true } :
      args.path === '/api/account/cloud-agent-consent' ? (defer ? delayed : { ok:true, accountId:'acc_'+'b'.repeat(24), accepted:true, noticeVersion:1 }) : { ok:false, status:503 } });
  await client.restore();
  await assert.rejects(client.cloudAgentConsent(), error => error.code === 'account-protocol');
  defer = true;
  const pending = client.cloudAgentConsent();
  await client.logout();
  release({ ok:true, accountId:account.id, accepted:true, noticeVersion:1 });
  await assert.rejects(pending, error => error.code === 'credential-revoked');
});
