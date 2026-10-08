import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAccountClient, projectIdFromLink, projectLink } from './client.ts';

const account = { id: 'acc_' + 'a'.repeat(24), name: 'Alice' };
const projectId = 'sp_' + 'a'.repeat(26);
const device = { deviceId: 'device-test', deviceName: 'fixture' };
const credential = (at = 100_000) => ({ ok: true, account, loginId: 'editor-test', accessToken: 'access-test', accessExpiresAt: at });
const session = { ok: true, connectionTicket: 'c'.repeat(43), assetTicket: 'a'.repeat(43), agentDelegationTicket: 'd'.repeat(43), expiresAt: 100_000,
  projectId, creator: true, access: 'rw', accessRevision: 1, hosted: { agent: { available: true, enabled: false, url: 'https://visuhive.com/agent/v1' } } };
const reply = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

const memberSnapshot = () => ({ ok: true, v: 2, authorityId: 'doc', projectId, accessRevision: 3,
  self: { accountId: account.id, creator: true, access: 'rw' }, creatorAccountId: account.id, allowLinkJoin: true,
  members: [{ accountId: account.id, accountName: account.name, access: 'rw', joinedAt: 1 }],
  devices: [{ accountId: account.id, accountName: account.name, deviceId: device.deviceId, deviceName: 'fixture', creator: true, conns: [{ role: 'page' }] }], bans: [] });
test('account members is exact bearer/omit route, strict white-listed projection; unknown delivery replays exact admin body and conflict propagates', async () => {
  const calls = []; let failure = true, conflict = false;
  const client = createAccountClient({ online: true, origin: 'https://visuhive.com', device, now: () => 1000,
    fetch: async (url, init) => {
      if (url.pathname.endsWith('/me')) return reply({ ok: true, account, csrfToken: 'csrf' });
      if (url.pathname.includes('/editor/')) return reply(credential());
      calls.push({ path: url.pathname, ...init });
      if (url.pathname.endsWith('/members')) return reply({ ...memberSnapshot(), internalSecret: 'never-return' });
      if (failure) { failure = false; throw Error('lost-response'); }
      if (conflict) return reply({ ok: false, code: 'access-revision-mismatch' }, 409);
      return reply({ ok: true, eventId: 'access:doc:4', accessRevision: 4, completed: false, state: 'pending-services' });
    } });
  await client.restore(); const snapshot = await client.members(projectId);
  assert.equal(snapshot.internalSecret, undefined); assert.equal(snapshot.devices[0].conns[0].role, 'page');
  assert.equal(calls[0].path, '/hosted/shared/account/members'); assert.equal(calls[0].credentials, 'omit');
  assert.equal(calls[0].headers.Authorization, 'Bearer access-test'); assert.deepEqual(JSON.parse(calls[0].body), { projectId });
  const op = { op: 'kick', accountId: 'acc_' + 'b'.repeat(24), expectedAccessRevision: 3, requestId: 'same-request' };
  await assert.rejects(client.memberAdmin(projectId, op), { code: 'network' });
  assert.deepEqual(await client.memberAdmin(projectId, op), { eventId: 'access:doc:4', accessRevision: 4, completed: false, state: 'pending-services' });
  assert.equal(calls[1].body, calls[2].body);
  conflict = true; await assert.rejects(client.memberAdmin(projectId, op), { status: 409, code: 'access-revision-mismatch' });
});
test('member parser refuses wrong scope, duplicate identities/devices, role escalation and bans exposed to ordinary members', async () => {
  const mutations = [v => { v.projectId = 'sp_' + 'b'.repeat(26); }, v => { v.self.accountId = 'acc_' + 'b'.repeat(24); },
    v => { v.members.push(v.members[0]); }, v => { v.devices.push(v.devices[0]); }, v => { v.devices[0].conns[0].role = 'admin'; },
    v => { v.self.creator = false; }, v => { v.accessRevision = -1; }, v => { v.members[0].accountName = '\u0000'; },
    v => { v.creatorAccountId = 'acc_' + 'b'.repeat(24); v.self.creator = false; v.members.push({ accountId: v.creatorAccountId, accountName: 'other', access: 'rw', joinedAt: 1 }); }];
  for (const mutate of mutations) {
    const broken = memberSnapshot(); mutate(broken);
    const client = createAccountClient({ online: false, origin: 'https://visuhive.com', device, now: () => 1000,
      native: async operation => operation === 'recover' ? credential() : broken });
    await client.restore(); await assert.rejects(client.members(projectId), { code: 'account-protocol' });
  }
});

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

test('account session keeps opaque Agent delegation and authoritative creator; admin uses bearer revision', async () => {
  let wire;
  const client = createAccountClient({ online: true, origin: 'https://visuhive.com', device, now: () => 1000,
    fetch: async (url, init) => {
      if (url.pathname.endsWith('/me')) return reply({ ok: true, account, csrfToken: 'csrf' });
      if (url.pathname.includes('/editor/')) return reply(credential());
      if (url.pathname.endsWith('/admin')) { wire = init; return reply({ ok: true, eventId: 'event', accessRevision: 2, completed: false, state: 'pending-services' }); }
      return reply(session);
    } });
  await client.restore(); const actual = await client.session(projectId);
  assert.equal(actual.agentDelegationTicket, 'd'.repeat(43)); assert.equal(actual.creator, true); assert.equal(actual.hosted.agent.enabled, false);
  await client.setAgentEnabled(projectId, true, actual.accessRevision, 'enable-once');
  assert.equal(wire.credentials, 'omit'); assert.equal(wire.headers.Authorization, 'Bearer access-test');
  assert.deepEqual(JSON.parse(wire.body), { projectId, enabled: true, expectedAccessRevision: 1, requestId: 'enable-once', op: 'set-hosted-service', service: 'agent' });
});

test('missing delegation or another project projection cannot become a usable session', async () => {
  for (const broken of [{ ...session, agentDelegationTicket: undefined }, { ...session, projectId: 'other' }, { ...session, creator: 'true' }]) {
    const client = createAccountClient({ online: false, origin: 'https://visuhive.com', device, now: () => 1000,
      native: async operation => operation === 'recover' ? credential() : broken });
    await client.restore(); await assert.rejects(client.session(projectId), { code: 'session-unavailable' });
  }
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

test('online consent uses website cookie+CSRF, never the editor bearer POST route that rejects Origin', async () => {
  let accepted = false;
  const calls = [];
  const client = createAccountClient({ online:true, origin:'https://visuhive.com', device, now:() => 1000,
    fetch:async (url, init) => {
      calls.push({ path:url.pathname, init });
      if (url.pathname.endsWith('/me')) return reply({ ok:true, account, csrfToken:'csrf' });
      if (url.pathname.includes('/editor/')) return reply(credential());
      if (url.pathname.endsWith('/cloud-agent-consent')) {
        if (init.method === 'POST' && (init.headers.Authorization || !init.headers['X-CSRF-Token'])) return reply({ ok:false, code:'bad-origin' }, 403);
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
    assert.equal(call.init.credentials, 'same-origin');
    assert.equal(call.init.headers.Authorization, undefined);
    if (call.init.method === 'POST') assert.equal(call.init.headers['X-CSRF-Token'], 'csrf');
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

test('desktop consent uses only the pinned native bridge with exact bearer request shape', async () => {
  const calls = [];
  const client = createAccountClient({ online:false, origin:'https://visuhive.com', device, now:() => 1000,
    fetch:async () => { throw Error('desktop must not fetch'); },
    native:async (operation, args) => {
      if (operation === 'recover') return credential();
      calls.push({ operation, args });
      return { ok:true, accountId:account.id, accepted:Boolean(args.body), noticeVersion:1 };
    } });
  await client.restore();
  assert.equal((await client.cloudAgentConsent()).accepted, false);
  assert.equal((await client.acceptCloudAgentConsent('native-consent-request')).accepted, true);
  assert.deepEqual(calls.map(x => x.args.path), ['/api/account/cloud-agent-consent','/api/account/cloud-agent-consent']);
  assert.equal(calls[0].args.accessToken, 'access-test');
  assert.equal(calls[0].args.body, undefined);
  assert.deepEqual(calls[1].args.body, { accept:true, noticeVersion:1, requestId:'native-consent-request' });
});
