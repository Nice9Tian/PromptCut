/**
 * 云端项目的「任何知道链接的人都可加入」勾选、账号名单与申请加入(2026-10-22 用户定,`docs/semantics/workflow/project.md`
 * 「多用户协作」第 26、27 条;报告 `docs/reports/AGENT-claude-join-requests.md`)。真的账本(SQLite)、真的权威与成员投影、
 * 真的公开路由;账号服务只换成可控的替身(哪个令牌是谁、令牌作废、核对时卡住一会儿)。
 *
 *   JR-1  勾选与名单:取消勾选那一刻的成员都在名单里、照旧能进;之后的新人 `/join` 回 403 `not-listed`;只有创建者能改勾选
 *   JR-2  名单快照的并发规则:以账本里两笔写入的先后为准,不以请求先到为准;创建者拿旧版本号取消勾选回 409,重读后再取消
 *   JR-3  发申请、查自己那一条;已在等的不另起一条;创建者在成员投影里看到申请,普通成员看不到
 *   JR-4  没登录、令牌不认、登录已作废、带 cookie:都发不了申请
 *   JR-5  被踢的账号发不了、查不了;创建者解除禁入后才能发;被踢时挂着的申请一并清掉
 *   JR-6  伪造与跨项目:请求体里写别人的账号号被拒、权威层也不认;别的项目的创建者通过不了这里的申请;
 *         申请号拿到别的项目用回 404;一个项目的通过进不了另一个项目;项目票据当登录令牌用回 401
 *   JR-7  「通过」「拒绝」只有创建者能做(服务端核):普通成员、被踢的、申请人自己、项目外的人、创建者的 Agent 身份都回 403
 *   JR-8  通过之后进项目仍过全部关卡:二级密码、禁入、登录有效、项目还在;链接作废过也不用新链接
 *   JR-9  被拒:申请人看到「被拒」;可以再发,一共 3 次,用完回 429 `join-request-limit`
 *   JR-10 幂等:同一个请求号重放、换请求号再做同样的决定、相反的决定、申请号对不上、回包丢了的发申请重试
 *   JR-11 上限:一个项目挂着的条数、一个账号跨项目挂着的条数、被拒记录留几条;缺省值
 *   JR-12 申请记录存在哪、谁读得到:账本里只有账号号、名字、时间、状态;邮箱、登录号、凭证号、设备不进账本也不进任何回包;删项目连申请一起清
 *   JR-13 知道链接就能进时不收申请;等着的人在创建者改回勾选后自己凭链接进来,申请记录随之清掉
 *
 * 跑:node --test server/test/account-join-requests.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { openAccountLedger } from '../account/ledger.mjs';
import { createAccountAuthority, JOIN_REQUEST_LIMITS, joinRequestView } from '../account/authority.mjs';
import { createAccountHostedRuntime } from '../docservice/account-hosted.mjs';
import { mountAccountProjects } from '../docservice/modules/account-projects.mjs';

const idOf = n => `acc_${n.toString(16).padStart(24, '0')}`;
/** 令牌 → 账号(号、名字)。账号号只能是十六进制,所以按序号给 */
const PEOPLE = { a: [1, 'Alice'], b: [2, 'Bob'], c: [3, 'Carol'], d: [4, 'Dave'], e: [5, 'Erin'], k: [6, 'Kim'], x: [7, 'Xavier'], y: [8, 'Yuki'] };
const ID = Object.fromEntries(Object.entries(PEOPLE).map(([token, [n]]) => [token, idOf(n)]));

/** 账号服务的替身:认得 `PEOPLE` 和后加的令牌;`gate(token)` 让这个令牌的核对卡住,直到放行;`revoke(token)` 让它作废 */
function accountService() {
  const people = new Map(Object.entries(PEOPLE).map(([token, [n, name]]) => [token, { accountId: idOf(n), accountName: name }]));
  const gates = new Map(), revoked = new Set();
  const client = {
    events: async () => ({ events: [], headSeq: 0 }),
    verify: async token => {
      const gate = gates.get(token); if (gate) await gate;
      if (revoked.has(token)) throw Object.assign(Error('credential-revoked'), { status: 401, code: 'credential-revoked' });
      const who = people.get(token);
      if (!who) throw Object.assign(Error('login-required'), { status: 401, code: 'login-required' });
      // 账号服务回的登录里还有别的字段(这里放一个邮箱):权威只能用账号号和名字,其余一样都不能落进申请记录或回包
      return { ...who, loginId: `login-${token}`, credentialId: `cred-${token}`, loginGeneration: 1, accountEventSeq: 0,
        expiresAt: Date.now() + 3_600_000, kind: 'editor', email: `${token}@mail.invalid` };
    },
  };
  return {
    client,
    add: (token, n, name) => people.set(token, { accountId: idOf(n), accountName: name }),
    gate(token) { let open; gates.set(token, new Promise(resolve => { open = resolve; })); return () => { gates.delete(token); open(); }; },
    revoke: token => revoked.add(token),
  };
}
const tmpLedger = (t, name) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pc-join-requests-${name}-`));
  const ledger = openAccountLedger({ file: path.join(dir, 'doc.sqlite'), authorityId: `doc-${name}` });
  t.after(() => { try { ledger.close(); } catch { /* 已关 */ } fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  return ledger;
};

/** 整条:权威 + 成员投影 + 发会话 + 公开路由(与文档服务里挂的同一份 `mountAccountProjects`) */
async function stack(t) {
  const ledger = tmpLedger(t, 'stack');
  const accounts = accountService();
  const runtime = createAccountHostedRuntime({ ledger, accountClient: accounts.client, dataDir: null, authorityUrl: 'https://fixture.invalid',
    allowFixtureAssetReady: true, pollMs: 0 });
  runtime.setAssetReady(true);
  runtime.bindService({ describe: () => ({ conns: [] }), fencePrincipals: async () => ({ actualClosed: true }), fenceConn: async () => {} },
    { registry: { refresh() {}, get: () => null }, urls: {} });
  await runtime.start();
  t.after(() => { try { runtime.close(); } catch { /* 已关 */ } });
  const authority = runtime.authority;
  const mounted = mountAccountProjects({ authority, issueSession: o => runtime.issueSession(o), membersSnapshot: runtime.membersSnapshot });
  let seq = 0;
  const call = async (token, route, body, extraHeaders = {}) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method: 'POST', url: `/hosted/shared/account/${route}`,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extraHeaders } });
    let status, value;
    assert.equal(await mounted.handlePublic(req, { writeHead: s => { status = s; }, end: text => { value = JSON.parse(text); } }), true);
    return { status, value };
  };
  const rid = label => `${label}-${++seq}`;
  const create = async (token, { allowLinkJoin = true, name = `项目 ${rid('n')}` } = {}) =>
    (await authority.createProject({ accessToken: token }, { name, requestId: rid('create'), allowLinkJoin, initialProject: { tracks: [] } })).projectId;
  const projectId = await create('a');
  const record = (id = projectId) => ledger.read().projects[id];
  const join = (token, id = projectId, extra = {}) => call(token, 'join', { projectId: id, deviceId: `dev-${token}`, requestId: rid(`join-${token}`), ...extra });
  const session = (token, id = projectId) => call(token, 'session', { projectId: id, deviceId: `dev-${token}`, requestId: rid(`session-${token}`) });
  const members = (token, id = projectId) => call(token, 'members', { projectId: id });
  const send = (token, id = projectId, extra = {}) => call(token, 'join', { projectId: id, requestId: rid(`send-${token}`), joinRequest: 'send', ...extra });
  const status = (token, id = projectId) => call(token, 'join', { projectId: id, joinRequest: 'status' });
  const admin = async (token, body, id = projectId) => {
    const expectedAccessRevision = record(id).accessRevision;
    return call(token, 'admin', { projectId: id, expectedAccessRevision, requestId: rid(`admin-${token}`), ...body });
  };
  const decide = (token, op, applicant, joinRequestId, id = projectId, requestId = rid(`${op}-${token}`)) =>
    call(token, 'admin', { projectId: id, op, accountId: ID[applicant] ?? applicant, joinRequestId, requestId });
  const pendingId = (applicant, id = projectId) => record(id).joinRequests?.[ID[applicant]]?.id;
  return { ledger, accounts, runtime, authority, projectId, call, create, record, join, session, members, send, status, admin, decide, pendingId, rid };
}
const listOnly = async s => { const r = await s.admin('a', { op: 'set-entry', allowLinkJoin: false }); assert.equal(r.status, 200, JSON.stringify(r.value)); };
const expectCode = (r, status, code, label) => assert.deepEqual([r.status, r.value?.code], [status, code], `${label ?? ''} ${JSON.stringify(r.value)}`);

test('JR-1 取消勾选:那一刻的成员都在账号名单里、照旧能进;之后的新人 not-listed;只有创建者能改勾选', async t => {
  const s = await stack(t);
  assert.equal((await s.join('b')).status, 200, '勾着的时候知道链接、登录了就能进');
  expectCode(await s.admin('b', { op: 'set-entry', allowLinkJoin: false }), 403, 'creator-required', '普通成员不能改勾选');
  assert.equal(s.record().allowLinkJoin, true);
  await listOnly(s);
  const snap = await s.members('a');
  assert.equal(snap.value.allowLinkJoin, false);
  assert.deepEqual(snap.value.members.map(m => m.accountId).sort(), [ID.a, ID.b].sort(), '名单 = 取消勾选那一刻的成员');
  assert.equal((await s.session('b')).status, 200, '名单里的成员照旧拿得到会话');
  assert.equal((await s.join('b')).status, 200, '名单里的成员再走一次 /join 也照旧进');
  expectCode(await s.join('c'), 403, 'not-listed', '之后的新人只能申请');
  expectCode(await s.session('c'), 403, 'not-listed');
  // 不提供输入账号名加人:页面上没有这一项;再勾上,知道链接的人又能直接进
  await s.admin('a', { op: 'set-entry', allowLinkJoin: true });
  assert.equal((await s.join('c')).status, 200);
});

test('JR-2 名单快照的并发规则:以账本里落账的先后为准;创建者拿旧版本号取消勾选回 409,重读后再取消,名单含中间进来的人', async t => {
  const s = await stack(t);
  // (a) 丙的加入先到(核对登录时卡住),甲的取消勾选后到、先落账:丙按落账时的状态判,被拒
  const releaseC = s.accounts.gate('c');
  const lateJoin = s.join('c');
  await listOnly(s);
  releaseC();
  expectCode(await lateJoin, 403, 'not-listed', '请求先到不算数,落账时已经只放名单');
  assert.equal(s.record().members[ID.c], undefined);
  // (b) 甲读到版本号之后、取消勾选落账之前,丁凭链接进来了:甲那一次拿的是旧版本号,回 409;重读后再取消,丁在名单里
  await s.admin('a', { op: 'set-entry', allowLinkJoin: true });
  const stale = s.record().accessRevision;
  assert.equal((await s.join('d')).status, 200);
  const refused = await s.call('a', 'admin', { projectId: s.projectId, op: 'set-entry', allowLinkJoin: false, expectedAccessRevision: stale, requestId: s.rid('stale') });
  expectCode(refused, 409, 'access-revision-mismatch', '中间有人进来,旧版本号不认');
  assert.equal(s.record().allowLinkJoin, true, '被拒的那一次什么都没改');
  await listOnly(s);
  assert.ok(s.record().members[ID.d]?.joinedAt, '取消勾选落账之前进来的丁在名单里');
  assert.equal((await s.session('d')).status, 200);
  // (c) 反过来:丁的取消勾选请求(甲)核对登录时卡住,戊先凭链接进来、先落账 → 甲带着进来前的版本号到达,回 409,戊不受影响
  await s.admin('a', { op: 'set-entry', allowLinkJoin: true });
  const before = s.record().accessRevision;
  const releaseA = s.accounts.gate('a');
  const slowUncheck = s.call('a', 'admin', { projectId: s.projectId, op: 'set-entry', allowLinkJoin: false, expectedAccessRevision: before, requestId: s.rid('slow') });
  assert.equal((await s.join('e')).status, 200, '戊先落账');
  releaseA();
  expectCode(await slowUncheck, 409, 'access-revision-mismatch');
  assert.ok(s.record().members[ID.e]?.joinedAt);
});

test('JR-3 发申请、查自己那一条;已在等的不另起一条;创建者在成员投影里看到申请,普通成员看不到', async t => {
  const s = await stack(t);
  assert.equal((await s.join('b')).status, 200);
  await listOnly(s);
  expectCode(await s.join('c'), 403, 'not-listed');
  assert.deepEqual((await s.status('c')).value, { ok: true, projectId: s.projectId, joinRequest: { state: 'none', entry: 'list', canApply: true } });
  const sent = await s.send('c');
  assert.equal(sent.status, 200);
  assert.deepEqual(sent.value.joinRequest, { state: 'pending', entry: 'list', canApply: false });
  const first = s.pendingId('c');
  assert.match(first, /^jr_[a-f0-9]{24}$/);
  assert.deepEqual((await s.send('c')).value.joinRequest.state, 'pending', '再点一次:还是那一条');
  assert.equal(s.pendingId('c'), first, '没有另起一条');
  assert.equal(s.record().joinRequests[ID.c].attempt, 1, '也不算第二次');
  assert.equal(s.record().members[ID.c], undefined, '申请不给任何权限');
  expectCode(await s.session('c'), 403, 'not-listed');
  const revision = s.record().accessRevision;
  assert.equal((await s.send('d')).status, 200);
  assert.equal(s.record().accessRevision, revision, '发申请不动访问版本号(不打断创建者手里的操作)');
  const creator = await s.members('a');
  assert.deepEqual(creator.value.requests.map(r => [r.accountId, r.accountName]), [[ID.c, 'Carol'], [ID.d, 'Dave']], '按申请时间排');
  for (const row of creator.value.requests) assert.deepEqual(Object.keys(row).sort(), ['accountId', 'accountName', 'createdAt', 'joinRequestId']);
  const member = await s.members('b');
  assert.equal(member.status, 200);
  assert.equal(member.value.requests, undefined, '普通成员看不到申请');
  assert.equal(member.value.bans, undefined);
  // 创建者自己、已经在名单里的成员:查到的都是「已是成员」,发申请也不起记录
  assert.deepEqual((await s.status('a')).value.joinRequest, { state: 'member', entry: 'list', canApply: false });
  assert.deepEqual((await s.send('b')).value.joinRequest, { state: 'member', entry: 'list', canApply: false });
  assert.equal(s.record().joinRequests[ID.b], undefined);
  // 请求体不对
  expectCode(await s.call('c', 'join', { projectId: s.projectId, joinRequest: 'withdraw' }), 400, 'invalid-join-request');
  expectCode(await s.call('c', 'join', { projectId: s.projectId, joinRequest: 'send' }), 400, 'bad-request-id', '发申请要带请求号');
});

test('JR-4 没登录、令牌不认、登录已作废、带 cookie:都发不了申请,也查不了', async t => {
  const s = await stack(t);
  await listOnly(s);
  expectCode(await s.call(null, 'join', { projectId: s.projectId, requestId: 'anon', joinRequest: 'send' }), 401, 'login-required', '没登录');
  expectCode(await s.call(null, 'join', { projectId: s.projectId, joinRequest: 'status' }), 401, 'login-required');
  expectCode(await s.send('nobody'), 401, 'login-required', '账号服务不认的令牌');
  s.accounts.revoke('c');
  expectCode(await s.send('c'), 401, 'credential-revoked', '登录已作废');
  expectCode(await s.status('c'), 401, 'credential-revoked');
  expectCode(await s.call('d', 'join', { projectId: s.projectId, requestId: 'cookie', joinRequest: 'send' }, { cookie: 'session=whatever' }), 400, 'bearer-required', '带网站 cookie 的不收(防跨站伪造)');
  assert.equal(s.record().joinRequests, undefined, '一条都没记下');
});

test('JR-5 被踢的账号发不了也查不了,要先由创建者解除禁入;被踢时挂着的申请一并清掉', async t => {
  const s = await stack(t);
  assert.equal((await s.join('k')).status, 200);
  await listOnly(s);
  expectCode(await s.admin('a', { op: 'kick', accountId: ID.k }), 200, undefined);
  expectCode(await s.send('k'), 403, 'banned', '被踢的不能申请');
  expectCode(await s.status('k'), 403, 'banned');
  expectCode(await s.join('k'), 403, 'banned');
  assert.equal(s.record().joinRequests?.[ID.k], undefined);
  // 挂着申请的人被创建者禁入(踢一个非成员):申请一并清掉,创建者的列表里也没了
  assert.equal((await s.send('c')).status, 200);
  expectCode(await s.admin('a', { op: 'kick', accountId: ID.c }), 200, undefined);
  assert.equal(s.record().joinRequests?.[ID.c], undefined, '被禁入时申请记录清掉');
  assert.deepEqual((await s.members('a')).value.requests, []);
  expectCode(await s.send('c'), 403, 'banned');
  // 创建者在「已禁入的账号」里解除:之后可以重新申请(不是直接进:名单里没有他)
  expectCode(await s.admin('a', { op: 'unban', accountId: ID.k }), 200, undefined);
  expectCode(await s.join('k'), 403, 'not-listed', '解除禁入不等于回到名单');
  assert.deepEqual((await s.status('k')).value.joinRequest, { state: 'none', entry: 'list', canApply: true });
  assert.deepEqual((await s.send('k')).value.joinRequest.state, 'pending');
});

test('JR-6 伪造与跨项目:写别人的账号号被拒;别的项目的创建者通过不了;申请号拿到别的项目用回 404;票据当登录令牌用回 401', async t => {
  const s = await stack(t);
  await listOnly(s);
  // 公开路由不收请求体里的账号号(只有创建者的 /admin 收,那里是被操作的人)
  expectCode(await s.send('c', s.projectId, { accountId: ID.d }), 400, 'invalid-authority-claim');
  for (const field of ['role', 'principal', 'loginId', 'credentialId', 'authorizationId', 'creator'])
    expectCode(await s.send('c', s.projectId, { [field]: 'x' }), 400, 'invalid-authority-claim', field);
  // 权威这一层也不认请求体里的身份:记下的永远是令牌背后的账号
  await s.authority.joinRequest({ accessToken: 'c' }, { projectId: s.projectId, requestId: 'forged', joinRequest: 'send', accountId: ID.d, accountName: 'Dave' });
  assert.equal(s.record().joinRequests[ID.d], undefined, '没有替丁记一条');
  assert.equal(s.record().joinRequests[ID.c].accountName, 'Carol', '名字取自核过的登录,不取请求体');
  // 另一个项目(己建、只放名单):丙也申请了那边
  const other = await s.create('x', { allowLinkJoin: false });
  assert.equal((await s.send('c', other)).status, 200);
  const here = s.pendingId('c'), there = s.pendingId('c', other);
  assert.notEqual(here, there, '申请号按项目各是各的');
  expectCode(await s.decide('a', 'approve-join', 'c', there, other), 403, 'creator-required', '甲不是那个项目的创建者');
  expectCode(await s.decide('a', 'approve-join', 'c', there), 404, 'no-join-request', '那边的申请号拿到这边用');
  expectCode(await s.decide('x', 'approve-join', 'c', here, s.projectId), 403, 'creator-required', '己不是这个项目的创建者');
  assert.equal((await s.decide('x', 'approve-join', 'c', there, other)).status, 200, '那边的创建者通过那边的');
  assert.equal((await s.join('c', other)).status, 200);
  expectCode(await s.join('c'), 403, 'not-listed', '那边的通过进不了这边');
  assert.equal(s.record().joinRequests[ID.c].state, 'pending', '这边那一条不受影响');
  // 项目里用的票据(连接票据)当账号的登录令牌用:账号服务不认
  assert.equal((await s.join('b', other)).status, 403);
  await s.admin('a', { op: 'set-entry', allowLinkJoin: true });
  const bSession = await s.join('b');
  assert.equal(bSession.status, 200);
  expectCode(await s.send(bSession.value.connectionTicket, other), 401, 'login-required');
  expectCode(await s.status(bSession.value.assetTicket, other), 401, 'login-required');
  // 不存在的项目、形状不对的项目号
  expectCode(await s.status('c', `sp_${'b'.repeat(26)}`), 404, 'no-project');
  expectCode(await s.send('c', 'x'), 400, 'invalid-project');
});

test('JR-7 「通过」「拒绝」只有创建者能做:普通成员、被踢的、申请人自己、项目外的人、创建者的 Agent 身份都被服务端拒', async t => {
  const s = await stack(t);
  assert.equal((await s.join('b')).status, 200);
  assert.equal((await s.join('k')).status, 200);
  await listOnly(s);
  expectCode(await s.admin('a', { op: 'kick', accountId: ID.k }), 200, undefined);
  assert.equal((await s.send('c')).status, 200);
  const jr = s.pendingId('c');
  const before = JSON.stringify(s.record());
  for (const [who, label] of [['b', '普通成员'], ['k', '被踢的'], ['c', '申请人自己'], ['x', '项目外的人'], ['d', '另一个申请人']])
    for (const op of ['approve-join', 'reject-join']) expectCode(await s.decide(who, op, 'c', jr), 403, 'creator-required', `${label} ${op}`);
  // 创建者本人,但用的是 Agent 身份(云端 Agent 代创建者):创建者特权 Agent 一律做不了
  const agent = await s.authority.authorizePrincipal({ accessToken: 'a' }, { projectId: s.projectId, trustedRole: 'agent' });
  await assert.rejects(s.authority.decideJoinRequest({ authorizationId: agent.authorizationId },
    { projectId: s.projectId, op: 'approve-join', accountId: ID.c, joinRequestId: jr, requestId: 'agent-approve' }), { status: 403, code: 'creator-required' });
  // Agent 身份发申请、查状态也不行(只认页面)
  const bAgent = await s.authority.authorizePrincipal({ accessToken: 'b' }, { projectId: s.projectId, trustedRole: 'agent' });
  const other = await s.create('x', { allowLinkJoin: false });
  await assert.rejects(s.authority.joinRequest({ authorizationId: bAgent.authorizationId }, { projectId: other, requestId: 'agent-send', joinRequest: 'send' }), { status: 403, code: 'invalid-role' });
  assert.equal(JSON.stringify(s.record()), before, '被拒的几次一样都没改');
  assert.equal((await s.decide('a', 'approve-join', 'c', jr)).status, 200, '创建者本人的页面能办');
  // 公开路由不能自报角色
  expectCode(await s.call('a', 'admin', { projectId: s.projectId, op: 'reject-join', accountId: ID.d, joinRequestId: jr, requestId: 'role', role: 'page' }), 400, 'invalid-authority-claim');
});

test('JR-8 通过之后进项目仍过全部关卡:二级密码、禁入、登录有效、项目还在;作废过的旧链接不挡被通过的人', async t => {
  const s = await stack(t);
  await listOnly(s);
  expectCode(await s.admin('a', { op: 'set-secondary-password', password: '二级 密码' }), 200, undefined);
  const linkToken = (await s.admin('a', { op: 'regen-link' })).value.linkToken;
  assert.equal(typeof linkToken, 'string');
  assert.equal((await s.send('c')).status, 200);
  const revision = s.record().accessRevision;
  const approved = await s.decide('a', 'approve-join', 'c', s.pendingId('c'));
  assert.equal(approved.status, 200);
  assert.deepEqual(approved.value.joinRequest, { accountId: ID.c, joinRequestId: s.record().members[ID.c].joinRequestId, state: 'approved' });
  assert.equal(s.record().accessRevision, revision + 1, '通过改了名单:访问版本号 +1');
  assert.deepEqual((await s.status('c')).value.joinRequest, { state: 'member', entry: 'list', canApply: false });
  assert.equal(s.record().joinRequests[ID.c], undefined, '申请记录删掉,成员记录上留申请号');
  // 二级密码:通过了也要输一次
  expectCode(await s.join('c'), 403, 'secondary-password-required');
  expectCode(await s.session('c'), 403, 'secondary-password-required', '/session 也拦');
  expectCode(await s.join('c', s.projectId, { secondaryPassword: '二级密码' }), 403, 'bad-secondary-password');
  const entered = await s.join('c', s.projectId, { secondaryPassword: '二级 密码' });
  assert.equal(entered.status, 200, '输对了就进(不用新链接:创建者通过的人不核链接口令)');
  assert.equal(typeof entered.value.connectionTicket, 'string');
  assert.equal((await s.session('c')).status, 200, '输过一次以后不再问');
  // 通过之后、进来之前被踢:禁入照样挡
  assert.equal((await s.send('d')).status, 200);
  assert.equal((await s.decide('a', 'approve-join', 'd', s.pendingId('d'))).status, 200);
  expectCode(await s.admin('a', { op: 'kick', accountId: ID.d }), 200, undefined);
  expectCode(await s.join('d', s.projectId, { secondaryPassword: '二级 密码' }), 403, 'banned');
  // 通过之后登录作废:照样挡
  assert.equal((await s.send('e')).status, 200);
  assert.equal((await s.decide('a', 'approve-join', 'e', s.pendingId('e'))).status, 200);
  s.accounts.revoke('e');
  expectCode(await s.join('e', s.projectId, { secondaryPassword: '二级 密码' }), 401, 'credential-revoked');
  // 没被通过的人拿着最新的链接口令也进不来(只放名单时口令不顶用)
  expectCode(await s.join('y', s.projectId, { linkToken, secondaryPassword: '二级 密码' }), 403, 'not-listed');
  // 通过之后项目被删:进不来
  assert.equal((await s.send('y')).status, 200);
  assert.equal((await s.decide('a', 'approve-join', 'y', s.pendingId('y'))).status, 200);
  expectCode(await s.admin('a', { op: 'delete' }), 200, undefined);
  expectCode(await s.join('y', s.projectId, { secondaryPassword: '二级 密码' }), 404, 'no-project');
});

test('JR-9 被拒:申请人看到「被拒」,不给任何权限;可以再发,一共 3 次,用完回 429', async t => {
  const s = await stack(t);
  await listOnly(s);
  for (let attempt = 1; attempt <= JOIN_REQUEST_LIMITS.accountAttempts; attempt++) {
    const sent = await s.send('d');
    assert.equal(sent.value.joinRequest.state, 'pending', `第 ${attempt} 次`);
    assert.equal(s.record().joinRequests[ID.d].attempt, attempt);
    assert.equal((await s.decide('a', 'reject-join', 'd', s.pendingId('d'))).status, 200);
    const seen = (await s.status('d')).value.joinRequest;
    assert.deepEqual(seen, { state: 'rejected', entry: 'list', canApply: attempt < JOIN_REQUEST_LIMITS.accountAttempts });
    expectCode(await s.join('d'), 403, 'not-listed', '被拒的人进不来');
    assert.equal(s.record().members[ID.d], undefined);
  }
  expectCode(await s.send('d'), 429, 'join-request-limit', '次数用完');
  assert.deepEqual((await s.members('a')).value.requests, [], '被拒的不在创建者的列表里');
});

test('JR-10 幂等:重放、换请求号再做同样的决定、相反的决定、申请号对不上、回包丢了的发申请重试', async t => {
  const s = await stack(t);
  await listOnly(s);
  assert.equal((await s.send('c')).status, 200);
  const jr = s.pendingId('c');
  const first = await s.decide('a', 'approve-join', 'c', jr, s.projectId, 'approve-once');
  assert.equal(first.status, 200);
  const revision = s.record().accessRevision, member = JSON.stringify(s.record().members[ID.c]);
  const replay = await s.decide('a', 'approve-join', 'c', jr, s.projectId, 'approve-once');
  assert.deepEqual(replay.value, first.value, '同一个请求号重放:原样回');
  const again = await s.decide('a', 'approve-join', 'c', jr);
  assert.equal(again.status, 200, '换了请求号再点一次通过(另一台设备、网络重试):照样成功');
  assert.equal(again.value.joinRequest.state, 'approved');
  assert.equal(s.record().accessRevision, revision, '不再改账');
  assert.equal(JSON.stringify(s.record().members[ID.c]), member);
  expectCode(await s.decide('a', 'reject-join', 'c', jr), 409, 'join-request-decided', '通过之后再拒');
  expectCode(await s.call('a', 'admin', { projectId: s.projectId, op: 'reject-join', accountId: ID.c, joinRequestId: jr, requestId: 'approve-once' }), 409, 'request-mismatch', '同一个请求号换了内容');
  // 拒绝那一侧
  assert.equal((await s.send('d')).status, 200);
  const dr = s.pendingId('d');
  assert.equal((await s.decide('a', 'reject-join', 'd', dr)).status, 200);
  const rejected = JSON.stringify(s.record().joinRequests[ID.d]);
  assert.equal((await s.decide('a', 'reject-join', 'd', dr)).status, 200, '再拒一次:照样成功');
  assert.equal(JSON.stringify(s.record().joinRequests[ID.d]), rejected, '不再改账');
  expectCode(await s.decide('a', 'approve-join', 'd', dr), 409, 'join-request-decided', '拒了之后再通过');
  // 申请号对不上
  expectCode(await s.decide('a', 'approve-join', 'e', `jr_${'0'.repeat(24)}`), 404, 'no-join-request', '没申请过的人');
  expectCode(await s.decide('a', 'approve-join', 'd', 'jr_bad'), 400, 'invalid-join-request', '申请号形状不对');
  // 发申请的回包丢了,同一个请求号重试:这期间被拒了的,回「被拒」,不当成第二次
  const lost = { projectId: s.projectId, requestId: 'send-lost', joinRequest: 'send' };
  assert.equal((await s.call('e', 'join', lost)).status, 200);
  assert.equal((await s.decide('a', 'reject-join', 'e', s.pendingId('e'))).status, 200);
  const retried = await s.call('e', 'join', lost);
  assert.equal(retried.value.joinRequest.state, 'rejected');
  assert.equal(s.record().joinRequests[ID.e].attempt, 1);
  // 同一个请求号拿去另一个项目
  const other = await s.create('x', { allowLinkJoin: false });
  expectCode(await s.call('e', 'join', { ...lost, projectId: other }), 409, 'request-mismatch');
});

test('JR-11 上限:一个项目挂着的条数、一个账号跨项目挂着的条数、被拒记录留几条;缺省值', async t => {
  assert.deepEqual({ ...JOIN_REQUEST_LIMITS }, { projectPending: 50, accountAttempts: 3, accountPending: 20, rejectedKept: 200 });
  assert.ok(Object.isFrozen(JOIN_REQUEST_LIMITS));
  const ledger = tmpLedger(t, 'limits');
  const accounts = accountService();
  for (let n = 100; n < 106; n++) accounts.add(`u${n}`, n, `用户${n}`);
  assert.throws(() => createAccountAuthority({ ledger, accountClient: accounts.client, joinRequestLimits: { projectPending: 0, accountAttempts: 3, accountPending: 1, rejectedKept: 1 } }),
    { code: 'join-request-configuration' });
  const authority = createAccountAuthority({ ledger, accountClient: accounts.client, pollMs: 0, authorityUrl: 'https://fixture.invalid',
    initializeProject: async () => ({ contentId: 'content' }), joinRequestLimits: { projectPending: 2, accountAttempts: 3, accountPending: 2, rejectedKept: 2 } });
  t.after(() => authority.close());
  let n = 0;
  const create = async () => (await authority.createProject({ accessToken: 'a' }, { name: `上限 ${++n}`, requestId: `c-${n}`, allowLinkJoin: false })).projectId;
  const send = (token, projectId) => authority.joinRequest({ accessToken: token }, { projectId, requestId: `s-${token}-${projectId}-${++n}`, joinRequest: 'send' });
  const decide = (op, token, projectId) => {
    const accountId = idOf(Number(token.slice(1)));
    return authority.decideJoinRequest({ accessToken: 'a' }, { projectId, op, accountId,
      joinRequestId: ledger.read().projects[projectId].joinRequests[accountId].id, requestId: `d-${++n}` });
  };
  const [p1, p2, p3] = [await create(), await create(), await create()];
  // 一个项目最多挂 2 条
  await send('u100', p1); await send('u101', p1);
  await assert.rejects(send('u102', p1), { status: 429, code: 'join-request-full' });
  // 处理掉一条就又能收
  await decide('reject-join', 'u100', p1);
  assert.equal((await send('u102', p1)).joinRequest.state, 'pending');
  // 一个账号跨项目最多同时挂 2 条
  await send('u103', p1).catch(error => assert.equal(error.code, 'join-request-full'));
  await send('u103', p2); await send('u103', p3).catch(() => {});
  const p4 = await create();
  await assert.rejects(send('u103', p4), { status: 429, code: 'join-request-account-limit' });
  // 被拒的记录每个项目最多留 2 条:第 3 条拒掉时,最早被拒的那条清掉(那人看到的又是「没申请过」)
  await decide('reject-join', 'u101', p1);
  await decide('reject-join', 'u102', p1);
  assert.deepEqual(Object.values(ledger.read().projects[p1].joinRequests).map(r => r.state).sort(), ['rejected', 'rejected']);
  assert.equal(ledger.read().projects[p1].joinRequests[idOf(100)], undefined, '最早被拒的 u100 那条清掉了');
  assert.deepEqual((await authority.joinRequest({ accessToken: 'u100' }, { projectId: p1, joinRequest: 'status' })).joinRequest, { state: 'none', entry: 'list', canApply: true });
  // 缺省的 50 条:第 51 个人被拒
  const big = createAccountAuthority({ ledger: tmpLedger(t, 'default-limit'), accountClient: accounts.client, pollMs: 0, authorityUrl: 'https://fixture.invalid',
    initializeProject: async () => ({ contentId: 'content' }) });
  t.after(() => big.close());
  for (let i = 200; i <= 250; i++) accounts.add(`u${i}`, i, `用户${i}`);
  const crowded = (await big.createProject({ accessToken: 'a' }, { name: '挤满', requestId: 'crowded', allowLinkJoin: false })).projectId;
  for (let i = 200; i < 250; i++) await big.joinRequest({ accessToken: `u${i}` }, { projectId: crowded, requestId: `r${i}`, joinRequest: 'send' });
  await assert.rejects(big.joinRequest({ accessToken: 'u250' }, { projectId: crowded, requestId: 'r250', joinRequest: 'send' }), { status: 429, code: 'join-request-full' });
});

test('JR-12 申请记录存在账本里、只有这几样;邮箱、登录号、凭证号、设备不进账本也不进任何回包;删项目连申请一起清', async t => {
  const s = await stack(t);
  assert.equal((await s.join('b')).status, 200);
  await listOnly(s);
  const sent = await s.send('c', s.projectId, { deviceId: 'device-of-c' });
  assert.equal(sent.status, 200);
  const stored = s.record().joinRequests[ID.c];
  assert.deepEqual(Object.keys(stored).sort(), ['accountName', 'attempt', 'createdAt', 'id', 'state']);
  const ledgerText = JSON.stringify(s.ledger.read());
  for (const secret of ['c@mail.invalid', 'login-c', 'cred-c', 'device-of-c']) {
    assert.equal(ledgerText.includes(secret), false, `账本里没有 ${secret}`);
  }
  const outputs = [sent.value, (await s.status('c')).value, (await s.members('a')).value, (await s.members('b')).value];
  assert.equal((await s.decide('a', 'reject-join', 'c', stored.id)).status, 200);
  outputs.push((await s.status('c')).value);
  for (const value of outputs) {
    const text = JSON.stringify(value);
    for (const secret of ['mail.invalid', 'login-', 'cred-', 'device-of-c', 'accessToken']) assert.equal(text.includes(secret), false, `${secret} 不进回包:${text}`);
  }
  assert.deepEqual(Object.keys(outputs[1].joinRequest).sort(), ['canApply', 'entry', 'state'], '申请人只看到自己这一条的状态');
  // 「我加入的」:挂着的不算,被通过的算
  assert.equal((await s.send('d')).status, 200);
  assert.deepEqual(s.authority.listProjects(ID.d).joined, []);
  assert.equal((await s.decide('a', 'approve-join', 'd', s.pendingId('d'))).status, 200);
  assert.deepEqual(s.authority.listProjects(ID.d).joined.map(p => p.projectId), [s.projectId]);
  // 删项目:墓碑里不留申请记录
  assert.equal((await s.send('e')).status, 200);
  expectCode(await s.admin('a', { op: 'delete' }), 200, undefined);
  assert.equal(s.record().joinRequests, undefined);
  expectCode(await s.status('e'), 404, 'no-project');
});

test('JR-13 知道链接就能进时不收申请;等着的人在创建者改回勾选后自己凭链接进来,申请记录随之清掉', async t => {
  const s = await stack(t);
  expectCode(await s.send('c'), 409, 'entry-open', '勾着的时候不用申请');
  assert.deepEqual((await s.status('c')).value.joinRequest, { state: 'none', entry: 'link', canApply: false });
  await listOnly(s);
  assert.equal((await s.send('c')).status, 200);
  await s.admin('a', { op: 'set-entry', allowLinkJoin: true });
  assert.deepEqual((await s.status('c')).value.joinRequest, { state: 'pending', entry: 'link', canApply: false }, '还挂着,但进入方式已经是知道链接就能进');
  assert.equal((await s.join('c')).status, 200);
  assert.equal(s.record().joinRequests[ID.c], undefined, '进来了,申请记录清掉');
  assert.deepEqual((await s.members('a')).value.requests, []);
  // 纯函数:同一套判断
  assert.deepEqual(joinRequestView({ allowLinkJoin: false, creatorAccountId: ID.a, members: {}, joinRequests: { [ID.d]: { state: 'rejected', attempt: 3 } } }, ID.d),
    { state: 'rejected', entry: 'list', canApply: false });
});
