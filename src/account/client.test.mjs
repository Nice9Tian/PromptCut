import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAccountClient, linkTokenFromLink, projectIdFromLink, projectLink } from './client.ts';

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

test('generated links carry no software version: direct address without a token, share link with one; old links still parse', () => {
  const token = 'AbCdEfGhIjKlMnOpQrStUv';
  assert.equal(projectLink('https://visuhive.com/whatever', projectId), `https://visuhive.com/editor/p/${projectId}`);
  assert.equal(projectLink('https://visuhive.com', projectId, token), `https://visuhive.com/editor/s/${projectId}/${token}`);
  assert.equal(projectIdFromLink(projectLink('https://visuhive.com', projectId, token), 'https://visuhive.com'), projectId);
  assert.equal(linkTokenFromLink(projectLink('https://visuhive.com', projectId, token)), token);
  assert.equal(linkTokenFromLink(projectLink('https://visuhive.com', projectId)), undefined);
  // 旧链接照常能用
  assert.equal(projectIdFromLink(`https://visuhive.com/editor?project=${projectId}&token=${token}`, 'https://visuhive.com'), projectId);
  assert.equal(linkTokenFromLink(`https://visuhive.com/editor?project=${projectId}&token=${token}`), token);
  assert.equal(linkTokenFromLink(`https://visuhive.com/editor?project=${projectId}&linkToken=${token}`), token);
  assert.equal(linkTokenFromLink(projectId), undefined);
  // 新形式同样只认当前云端服务的源
  assert.throws(() => projectIdFromLink(`https://attacker.example/editor/p/${projectId}`, 'https://visuhive.com'));
  assert.throws(() => projectIdFromLink(`https://visuhive.com/editor/p/${projectId}/extra`, 'https://visuhive.com'));
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

test('account session carries the hosted render node (with its streams option) only when the doc service reports a well-formed one; creator toggles use the bearer admin route', async () => {
  const wires = []; let hosted = session.hosted;
  const client = createAccountClient({ online: true, origin: 'https://visuhive.com', device, now: () => 1000,
    fetch: async (url, init) => {
      if (url.pathname.endsWith('/me')) return reply({ ok: true, account, csrfToken: 'csrf' });
      if (url.pathname.includes('/editor/')) return reply(credential());
      if (url.pathname.endsWith('/admin')) { wires.push(init); return reply({ ok: true, eventId: 'event', accessRevision: 2, completed: false, state: 'pending-services' }); }
      return reply({ ...session, hosted });
    } });
  await client.restore();
  // old doc service: no render entry -> the page shows neither row
  assert.equal('render' in (await client.session(projectId)).hosted, false);
  hosted = { ...session.hosted, render: { available: true, enabled: true, streams: false, extra: 'ignored' } };
  assert.deepEqual((await client.session(projectId)).hosted.render, { available: true, enabled: true, streams: false });
  // a doc service that reports the node but not the option: node row only
  hosted = { ...session.hosted, render: { available: true, enabled: false } };
  assert.deepEqual((await client.session(projectId)).hosted.render, { available: true, enabled: false });
  // malformed entries are dropped, the session itself stays valid
  for (const bad of [{ available: 'yes', enabled: true }, { available: true }, 'on', null, { available: true, enabled: true, streams: 'yes' }]) {
    hosted = { ...session.hosted, render: bad };
    const got = (await client.session(projectId)).hosted;
    if (bad && typeof bad === 'object' && typeof bad.available === 'boolean' && typeof bad.enabled === 'boolean') assert.deepEqual(got.render, { available: true, enabled: true });
    else assert.equal('render' in got, false);
    assert.equal(got.agent.enabled, false);
  }
  await client.setHostedService(projectId, 'render', true, 1, 'render-on');
  await client.setHostedOption(projectId, 'render', 'streams', true, 1, 'streams-on');
  assert.deepEqual(wires.map(w => [w.credentials, w.headers.Authorization]), [['omit', 'Bearer access-test'], ['omit', 'Bearer access-test']]);
  assert.deepEqual(JSON.parse(wires[0].body), { projectId, enabled: true, expectedAccessRevision: 1, requestId: 'render-on', op: 'set-hosted-service', service: 'render' });
  assert.deepEqual(JSON.parse(wires[1].body), { projectId, enabled: true, expectedAccessRevision: 1, requestId: 'streams-on', op: 'set-hosted-option', service: 'render', option: 'streams' });
});

test('STF1 account session keeps render.streamsAllowed (permission group verdict); a 403 permission-denied on set-hosted-option surfaces the readable reason', async () => {
  let hosted = session.hosted, deny = false;
  const client = createAccountClient({ online: true, origin: 'https://visuhive.com', device, now: () => 1000,
    fetch: async (url) => {
      if (url.pathname.endsWith('/me')) return reply({ ok: true, account, csrfToken: 'csrf' });
      if (url.pathname.includes('/editor/')) return reply(credential());
      if (url.pathname.endsWith('/admin')) return deny ? reply({ ok: false, error: 'permission-denied', code: 'permission-denied' }, 403)
        : reply({ ok: true, eventId: 'event', accessRevision: 2, completed: false, state: 'pending-services' });
      return reply({ ...session, hosted });
    } });
  await client.restore();
  // 不在分组:文档服务下发 streamsAllowed:false,页面必须收下(原来这里被丢掉,开关不置灰)
  hosted = { ...session.hosted, render: { available: true, enabled: true, streams: false, streamsAllowed: false } };
  assert.deepEqual((await client.session(projectId)).hosted.render, { available: true, enabled: true, streams: false, streamsAllowed: false });
  hosted = { ...session.hosted, render: { available: true, enabled: true, streams: true, streamsAllowed: true } };
  assert.deepEqual((await client.session(projectId)).hosted.render, { available: true, enabled: true, streams: true, streamsAllowed: true });
  // 不是布尔不收,其余照收
  hosted = { ...session.hosted, render: { available: true, enabled: true, streams: false, streamsAllowed: 'no' } };
  assert.deepEqual((await client.session(projectId)).hosted.render, { available: true, enabled: true, streams: false });
  deny = true;
  await assert.rejects(client.setHostedOption(projectId, 'render', 'streams', true, 1, 'streams-on'),
    { status: 403, code: 'permission-denied', message: '你的账号没有开启这一项的权限，请联系托管方。' });
});

// —— 第三方登录（VisuHive 仓库 docs/third-party-login.md）——
// 后半段和密码登录是同一套：建立网站会话之后由 ensureLogin() 换编辑器令牌，所以这里要盯住
// 「真的走到了 /api/account/editor/session」，不然只是建了网站会话、编辑器其实没登进去。

/** 起一个只认第三方那几条路的假后端；`on` 里可以逐条改回包 */
function thirdPartyClient(on = {}) {
  const calls = [];
  const client = createAccountClient({ online: true, origin: 'https://visuhive.com', device, now: () => 1000,
    fetch: async (url, init) => {
      const path = url.pathname;
      calls.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined,
        csrf: init?.headers?.['X-CSRF-Token'], credentials: init?.credentials, auth: init?.headers?.Authorization });
      if (Object.hasOwn(on, path)) { const r = on[path]; return typeof r === 'function' ? r() : r; }
      if (path.endsWith('/me')) return reply({ ok: true, account, csrfToken: 'csrf' });
      if (path.includes('/editor/')) return reply(credential());
      return reply({ ok: false, code: 'not-found' }, 404);
    } });
  return { client, calls };
}

test('第三方登录：问后端开没开；后端是旧版（没这条接口）就当没开，不是报错', async () => {
  const open = thirdPartyClient({ '/api/account/third-party/config': reply({ ok: true, providers: [
    { provider: 'google', clientId: 'cid.apps.googleusercontent.com' },
    { provider: 'google', clientId: '' },            // 没有 clientId，丢掉
    { provider: 'facebook', clientId: 'x' },         // 不认识的，丢掉
    null,
  ] }) });
  assert.deepEqual(await open.client.thirdPartyProviders(), [{ provider: 'google', clientId: 'cid.apps.googleusercontent.com' }]);
  assert.equal(open.calls[0].method, 'GET');

  // 旧后端没有这条路由 → 回空数组，界面据此整块不显示
  const old = thirdPartyClient();
  assert.deepEqual(await old.client.thirdPartyProviders(), []);
  // 后端整个连不上也一样，不该把登录页拖垮
  const down = thirdPartyClient({ '/api/account/third-party/config': () => { throw Error('offline'); } });
  assert.deepEqual(await down.client.thirdPartyProviders(), []);
});

test('第三方登录：第一次用这个 Google 账号 → need-name，并且不去换编辑器令牌', async () => {
  const { client, calls } = thirdPartyClient({
    '/api/account/third-party/login': reply({ ok: true, next: 'need-name', ticket: 'tkt-1', email: 'a@example.com' }),
  });
  const result = await client.loginWithThirdParty('google', 'id-token-abc', true);
  assert.deepEqual(result, { kind: 'need-name', ticket: 'tkt-1', email: 'a@example.com' });
  // 还没有账号，这一步绝不能去要编辑器令牌
  assert.equal(calls.some((c) => c.path.includes('/editor/')), false);
  // 令牌原样转走，这一层不解析它
  const post = calls.find((c) => c.path.endsWith('/third-party/login'));
  assert.deepEqual(post.body, { provider: 'google', token: 'id-token-abc', remember: true });
  assert.equal(post.credentials, 'same-origin');   // 要带 cookie
  assert.equal(post.csrf, 'csrf');                 // 要带 CSRF
  assert.equal(post.auth, undefined);              // 不是 bearer 那条路
});

test('第三方登录：已关联过 → 建立网站会话再换编辑器令牌，account 来自编辑器那一步', async () => {
  const { client, calls } = thirdPartyClient({
    '/api/account/third-party/login': reply({ ok: true, account, csrfToken: 'csrf-2' }),
  });
  const result = await client.loginWithThirdParty('google', 'id-token-abc', false);
  assert.equal(result.kind, 'signed-in');
  assert.deepEqual(result.account, account);
  const order = calls.map((c) => c.path);
  assert.ok(order.includes('/api/account/third-party/login'));
  assert.ok(order.includes('/api/account/editor/session'), `没走到换编辑器令牌那一步：${order.join(' → ')}`);
  assert.ok(order.indexOf('/api/account/editor/session') > order.indexOf('/api/account/third-party/login'));
});

test('第三方登录：建账号那一步会带上小票；账号名被占时说的是账号名，不是项目名', async () => {
  const ok = thirdPartyClient({ '/api/account/third-party/register': reply({ ok: true, account, csrfToken: 'csrf-3' }) });
  assert.deepEqual(await ok.client.registerWithThirdParty('tkt-1', '张三丰', true), account);
  const post = ok.calls.find((c) => c.path.endsWith('/third-party/register'));
  assert.deepEqual(post.body, { ticket: 'tkt-1', name: '张三丰', remember: true });
  assert.ok(ok.calls.some((c) => c.path === '/api/account/editor/session'));

  // name-taken 这个码两处在用：建项目时指项目名，建账号时指账号名。这里必须说账号名
  const taken = thirdPartyClient({ '/api/account/third-party/register': reply({ ok: false, code: 'name-taken' }, 409) });
  await assert.rejects(taken.client.registerWithThirdParty('tkt-1', '张三丰', true), (e) => {
    assert.equal(e.code, 'name-taken');
    assert.match(e.message, /账号名/);
    assert.doesNotMatch(e.message, /项目名/, '这里不该说「项目名已被使用」');
    return true;
  });
});

test('第三方登录：邮箱被别的账号绑着时，话里要告诉他怎么办', async () => {
  const { client } = thirdPartyClient({ '/api/account/third-party/login': reply({ ok: false, code: 'email-taken' }, 409) });
  await assert.rejects(client.loginWithThirdParty('google', 'tok', true), (e) => {
    assert.equal(e.code, 'email-taken');
    assert.match(e.message, /账号页绑定/);
    return true;
  });
});

test('第三方登录：桌面版如实说不支持，不假装能用', async () => {
  const client = createAccountClient({ online: false, origin: 'https://visuhive.com', device, now: () => 1000,
    native: async () => ({ ok: true }) });
  assert.deepEqual(await client.thirdPartyProviders(), []);
  await assert.rejects(client.loginWithThirdParty('google', 'tok', true), { code: 'third-party-desktop' });
  await assert.rejects(client.registerWithThirdParty('tkt', 'n', true), { code: 'third-party-desktop' });
});
