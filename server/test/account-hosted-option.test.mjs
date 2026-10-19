/**
 * 账号项目那条路的「托管方的渲染节点」与「生成轨道流」(任务书 `docs/plan/render-refactor-task.md`「甲三」;
 * 契约 `docs/plan/hosted-render-contract.md` 第 3.1 节):创建者经 `/hosted/shared/account/admin` 改,成员只读(从会话里读)。
 *
 *   AHO-1  新建的账号项目:托管方的两个服务缺省开(`product/document-service.md`、`product/agent.md`),「生成轨道流」缺省关:
 *          会话里 `hosted.render` 是 `{ available, enabled: true, streams: false }`、`hosted.agent.enabled` 为真;`available` 看登记表里有没有渲染服务的公钥
 *          (2026-10-20 按语义更正:原先断言两个开关缺省关,与语义冲突,见 `docs/reports/AGENT-see-frames-fail.md`)
 *   AHO-2  创建者 `set-hosted-option { service: 'render', option: 'streams' }`:记进账本的 `hostedOptions.render.streams`,会话跟着变;
 *          与服务的开关互不冲掉;记一条访问事件(不带受影响的成员,不停任何任务);同一个 requestId 重放回同一个结果
 *   AHO-3  校验:服务、选项、布尔值不对回 400 `invalid-option`;版本号对不上回 409;不落账
 *   AHO-4  成员(不是创建者)改:403 `creator-required`,账本不变;成员的会话照样读得到这两项
 *   AHO-5  公开路由 `/hosted/shared/account/admin` 走通同一件事(凭登录令牌)
 *
 * 跑:node --test server/test/account-hosted-option.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { openAccountLedger } from '../account/ledger.mjs';
import { HOSTED_OPTIONS as ACCOUNT_OPTIONS, accountRenderState } from '../account/authority.mjs';
import { HOSTED_OPTIONS } from '../auth/service-identity.mjs';
import { createAccountHostedRuntime } from '../docservice/account-hosted.mjs';
import { mountAccountProjects } from '../docservice/modules/account-projects.mjs';

const A = 'acc_' + 'a'.repeat(24);
const B = 'acc_' + 'b'.repeat(24);
const TOKENS = { 'tok-a': A, 'tok-b': B };

async function fixture(t, { render = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-account-option-'));
  const ledger = openAccountLedger({ file: path.join(dir, 'doc.sqlite'), authorityId: 'doc-option-fixture' });
  const accountClient = {
    verify: async (token) => {
      const accountId = TOKENS[token];
      if (!accountId) throw Object.assign(new Error('login-required'), { status: 401, code: 'login-required' });
      return { accountId, accountName: accountId === A ? 'Alice' : 'Bob', loginId: `login-${token}`, credentialId: `cred-${token}`, loginGeneration: 1,
        expiresAt: Date.now() + 3_600_000, accountEventSeq: 0, kind: 'editor' };
    },
    events: async () => ({ events: [], headSeq: 0 }),
  };
  const runtime = createAccountHostedRuntime({ ledger, accountClient, dataDir: null, authorityUrl: 'https://fixture.invalid', allowFixtureAssetReady: true, pollMs: 0 });
  runtime.setAssetReady(true);
  // 登记表:有没有渲染服务的公钥(决定会话里 `hosted.render.available`)
  const registry = { refresh() {}, get: (name) => (name === 'render' && render ? { role: 'render', actsFor: 'self', keys: [{ kid: 'k1' }] } : null) };
  runtime.bindService({ describe: () => ({ conns: [] }), fencePrincipals: async () => ({ actualClosed: true }) }, { registry, urls: {} });
  await runtime.start();
  t.after(() => { try { runtime.close(); } catch { /* 已关 */ } fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const authority = runtime.authority;
  const created = await authority.createProject({ accessToken: 'tok-a' }, { name: `甲三 ${Math.random().toString(36).slice(2, 8)}`, requestId: 'create-1', initialProject: { tracks: [] } });
  const projectId = created.projectId;
  await authority.joinProject({ accessToken: 'tok-b' }, { projectId, requestId: 'join-b' });
  const session = async (token) => runtime.issueSession({ principal: await authority.authorizePrincipal({ accessToken: token }, { projectId }), deviceId: `device-${token}` });
  const admin = async (token, body) => {
    const { accessRevision } = await authority.authorizePrincipal({ accessToken: token }, { projectId });
    return authority.adminProject({ accessToken: token }, { projectId, expectedAccessRevision: accessRevision, ...body });
  };
  const record = () => ledger.read().projects[projectId];
  return { ledger, runtime, authority, projectId, session, admin, record };
}
const fails = async (fn, status, code) => assert.rejects(fn, (error) => error.status === status && error.code === code);

test('AHO-1 新建的账号项目:渲染节点与云端 Agent 缺省开,「生成轨道流」缺省关;available 看登记表里有没有渲染服务', async (t) => {
  const f = await fixture(t);
  const s = await f.session('tok-a');
  assert.deepEqual(s.hosted.render, { available: true, enabled: true, streams: false });
  assert.equal(s.creator, true);
  assert.deepEqual(s.hosted.agent, { available: false, enabled: true, url: null }, '云端 Agent 缺省开(登记表里没有 Agent 服务,available 为假)');
  assert.deepEqual(f.record().hosted, { render: true, agent: true }, '账本里两个开关缺省开');
  assert.equal(f.record().hostedOptions, undefined, '子选项没有记,就是关');
  const none = await fixture(t, { render: false });
  assert.deepEqual((await none.session('tok-a')).hosted.render, { available: false, enabled: true, streams: false }, '登记表里没有渲染服务:available 为假(页面上不出这两行)');
  // 登记与口令项目那条路是同一份
  assert.deepEqual(ACCOUNT_OPTIONS, HOSTED_OPTIONS);
  assert.deepEqual(accountRenderState({}), { enabled: false, streams: false });
  assert.deepEqual(accountRenderState({ hosted: { render: true }, hostedOptions: { render: { streams: 'yes' } } }), { enabled: true, streams: false }, '只有显式为 true 才算开');
});

test('AHO-2 创建者改「生成轨道流」:落账、会话跟着变、与服务开关互不冲掉、记访问事件、重放回同一个结果', async (t) => {
  const f = await fixture(t);
  const headBefore = f.ledger.read().accessHead;
  const request = { projectId: f.projectId, expectedAccessRevision: (await f.authority.authorizePrincipal({ accessToken: 'tok-a' }, { projectId: f.projectId })).accessRevision,
    op: 'set-hosted-option', service: 'render', option: 'streams', enabled: true, requestId: 'streams-on' };
  const on = await f.authority.adminProject({ accessToken: 'tok-a' }, request);
  assert.equal(on.completed, false);
  assert.equal(on.state, 'pending-services');
  assert.deepEqual(f.record().hostedOptions, { render: { streams: true } });
  assert.deepEqual(f.record().hosted, { render: true, agent: true }, '服务的开关仍是布尔,没有被动到');
  assert.deepEqual((await f.session('tok-a')).hosted.render, { available: true, enabled: true, streams: true });
  const state = f.ledger.read();
  assert.equal(state.accessHead, headBefore + 1);
  const event = state.accessEvents.at(-1);
  assert.deepEqual({ type: event.type, reason: event.reason, service: event.service, option: event.option, enabled: event.enabled, accountIds: event.accountIds },
    { type: 'project-access-changed', reason: 'set-hosted-option', service: 'render', option: 'streams', enabled: true, accountIds: [] });
  // 同一个 requestId、同一份请求再发:回同一个结果,不再落一次
  const again = await f.authority.adminProject({ accessToken: 'tok-a' }, request);
  assert.equal(f.ledger.read().accessHead, headBefore + 1, '重放不再落账');
  assert.deepEqual(again, on, '重放回同一个结果');
  // 同一个 requestId 换了内容:拒
  await fails(() => f.authority.adminProject({ accessToken: 'tok-a' }, { ...request, enabled: false }), 409, 'request-mismatch');

  // 关、开渲染节点:不冲掉子选项;关子选项:不冲掉渲染节点的开关
  await f.admin('tok-a', { op: 'set-hosted-service', service: 'render', enabled: false, requestId: 'render-off' });
  assert.deepEqual((await f.session('tok-a')).hosted.render, { available: true, enabled: false, streams: true }, '渲染节点关着时子选项照旧(界面置灰)');
  await f.admin('tok-a', { op: 'set-hosted-service', service: 'render', enabled: true, requestId: 'render-on' });
  assert.deepEqual((await f.session('tok-a')).hosted.render, { available: true, enabled: true, streams: true });
  await f.admin('tok-a', { op: 'set-hosted-option', service: 'render', option: 'streams', enabled: false, requestId: 'streams-off' });
  assert.deepEqual((await f.session('tok-a')).hosted.render, { available: true, enabled: true, streams: false });
  assert.deepEqual(f.record().hostedOptions, { render: { streams: false } });
  assert.equal(f.record().hosted.render, true);
});

test('AHO-3 校验:服务、选项、布尔值不对回 400 invalid-option;版本号对不上回 409;都不落账', async (t) => {
  const f = await fixture(t);
  const head = f.ledger.read().accessHead;
  for (const [i, body] of [
    { service: 'render', option: 'nope', enabled: true },
    { service: 'agent', option: 'streams', enabled: true },
    { service: 'asset', option: 'streams', enabled: true },
    { service: 'constructor', option: 'streams', enabled: true },
    { service: 'render', option: 'streams', enabled: 'yes' },
    { service: 'render', option: 'streams' },
    { service: 'render', enabled: true },
  ].entries()) await fails(() => f.admin('tok-a', { op: 'set-hosted-option', requestId: `bad-${i}`, ...body }), 400, 'invalid-option');
  await fails(() => f.authority.adminProject({ accessToken: 'tok-a' }, { projectId: f.projectId, expectedAccessRevision: 999, op: 'set-hosted-option', service: 'render', option: 'streams', enabled: true, requestId: 'stale' }), 409, 'access-revision-mismatch');
  assert.equal(f.ledger.read().accessHead, head);
  assert.equal(f.record().hostedOptions, undefined);
});

test('AHO-4 成员改不了(403 creator-required),但会话里读得到', async (t) => {
  const f = await fixture(t);
  await fails(() => f.admin('tok-b', { op: 'set-hosted-option', service: 'render', option: 'streams', enabled: true, requestId: 'b-on' }), 403, 'creator-required');
  await fails(() => f.admin('tok-b', { op: 'set-hosted-service', service: 'render', enabled: true, requestId: 'b-render' }), 403, 'creator-required');
  assert.equal(f.record().hostedOptions, undefined);
  await f.admin('tok-a', { op: 'set-hosted-service', service: 'render', enabled: true, requestId: 'a-render' });
  await f.admin('tok-a', { op: 'set-hosted-option', service: 'render', option: 'streams', enabled: true, requestId: 'a-on' });
  const member = await f.session('tok-b');
  assert.equal(member.creator, false);
  assert.deepEqual(member.hosted.render, { available: true, enabled: true, streams: true }, '成员只读:从会话里看到创建者定的状态');
});

test('AHO-5 公开路由 /hosted/shared/account/admin:创建者凭登录令牌改得了,成员 403', async (t) => {
  const f = await fixture(t);
  const mounted = mountAccountProjects({ authority: f.authority, issueSession: (o) => f.runtime.issueSession(o) });
  const post = async (token, pathname, body) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method: 'POST', url: pathname, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } });
    let status, value;
    assert.equal(await mounted.handlePublic(req, { writeHead: (s) => { status = s; }, end: (text) => { value = JSON.parse(text); } }), true);
    return { status, value };
  };
  const before = await post('tok-a', '/hosted/shared/account/session', { projectId: f.projectId, deviceId: 'device-a', requestId: 'session-1' });
  assert.equal(before.status, 200);
  assert.deepEqual(before.value.hosted.render, { available: true, enabled: true, streams: false });
  const body = { projectId: f.projectId, op: 'set-hosted-option', service: 'render', option: 'streams', enabled: true, expectedAccessRevision: before.value.accessRevision, requestId: 'route-on' };
  const denied = await post('tok-b', '/hosted/shared/account/admin', { ...body, requestId: 'route-b' });
  assert.deepEqual([denied.status, denied.value.code], [403, 'creator-required']);
  const ok = await post('tok-a', '/hosted/shared/account/admin', body);
  assert.equal(ok.status, 200);
  assert.equal(ok.value.state, 'pending-services');
  const after = await post('tok-b', '/hosted/shared/account/session', { projectId: f.projectId, deviceId: 'device-b', requestId: 'session-2' });
  assert.deepEqual(after.value.hosted.render, { available: true, enabled: true, streams: true });
  assert.equal(after.value.creator, false);
});

test('AHO-6 权限组:创建者开启 streams 需要 render_streams 权限组，无权限报 403 permission-denied;会话返回 streamsAllowed 并在无权限时强制 streams 为 false', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-account-perm-'));
  const ledger = openAccountLedger({ file: path.join(dir, 'doc.sqlite'), authorityId: 'doc-perm-fixture' });
  const allowedAccounts = new Set();
  const accountClient = {
    verify: async (token) => {
      const accountId = TOKENS[token];
      if (!accountId) throw Object.assign(new Error('login-required'), { status: 401, code: 'login-required' });
      return { accountId, accountName: accountId === A ? 'Alice' : 'Bob', loginId: `login-${token}`, credentialId: `cred-${token}`, loginGeneration: 1,
        expiresAt: Date.now() + 3_600_000, accountEventSeq: 0, kind: 'editor' };
    },
    events: async () => ({ events: [], headSeq: 0 }),
    permissions: async ({ accountId, group }) => ({ ok: true, allowed: group === 'render_streams' && allowedAccounts.has(accountId) }),
  };
  const runtime = createAccountHostedRuntime({ ledger, accountClient, dataDir: null, authorityUrl: 'https://fixture.invalid', allowFixtureAssetReady: true, pollMs: 0 });
  runtime.setAssetReady(true);
  const registry = { refresh() {}, get: (name) => (name === 'render' ? { role: 'render', actsFor: 'self', keys: [{ kid: 'k1' }] } : null) };
  runtime.bindService({ describe: () => ({ conns: [] }), fencePrincipals: async () => ({ actualClosed: true }) }, { registry, urls: {} });
  await runtime.start();
  t.after(() => { try { runtime.close(); } catch { /* 已关 */ } fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

  const authority = runtime.authority;
  const created = await authority.createProject({ accessToken: 'tok-a' }, { name: '权限测试', requestId: 'create-perm', initialProject: { tracks: [] } });
  const projectId = created.projectId;

  // Alice initially NOT in group:
  // 1. Session returns streamsAllowed: false
  const s1 = await runtime.issueSession({ principal: await authority.authorizePrincipal({ accessToken: 'tok-a' }, { projectId }), deviceId: 'dev-1' });
  assert.deepEqual(s1.hosted.render, { available: true, enabled: true, streams: false, streamsAllowed: false });

  // 2. Alice tries to enable streams: rejected with 403 permission-denied
  const reqOn = { projectId, expectedAccessRevision: (await authority.authorizePrincipal({ accessToken: 'tok-a' }, { projectId })).accessRevision,
    op: 'set-hosted-option', service: 'render', option: 'streams', enabled: true, requestId: 'req-fail' };
  await fails(() => authority.adminProject({ accessToken: 'tok-a' }, reqOn), 403, 'permission-denied');

  // 3. Add Alice to group: Alice can enable streams
  allowedAccounts.add(A);
  const s2 = await runtime.issueSession({ principal: await authority.authorizePrincipal({ accessToken: 'tok-a' }, { projectId }), deviceId: 'dev-2' });
  assert.deepEqual(s2.hosted.render, { available: true, enabled: true, streams: false, streamsAllowed: true });

  const ok = await authority.adminProject({ accessToken: 'tok-a' }, { ...reqOn, requestId: 'req-ok' });
  assert.equal(ok.state, 'pending-services');

  const s3 = await runtime.issueSession({ principal: await authority.authorizePrincipal({ accessToken: 'tok-a' }, { projectId }), deviceId: 'dev-3' });
  assert.deepEqual(s3.hosted.render, { available: true, enabled: true, streams: true, streamsAllowed: true });

  // 4. Remove Alice from group: previously enabled project returns streams: false and streamsAllowed: false
  allowedAccounts.delete(A);
  const s4 = await runtime.issueSession({ principal: await authority.authorizePrincipal({ accessToken: 'tok-a' }, { projectId }), deviceId: 'dev-4' });
  assert.deepEqual(s4.hosted.render, { available: true, enabled: true, streams: false, streamsAllowed: false });

  // 5. Turning OFF streams is allowed even without permission
  const rev = (await authority.authorizePrincipal({ accessToken: 'tok-a' }, { projectId })).accessRevision;
  const off = await authority.adminProject({ accessToken: 'tok-a' }, { projectId, expectedAccessRevision: rev, op: 'set-hosted-option', service: 'render', option: 'streams', enabled: false, requestId: 'req-off' });
  assert.equal(off.state, 'pending-services');
});
