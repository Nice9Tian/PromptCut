/**
 * 账号项目里云端 Agent 服务的「只能发布」票据(`server/docservice/account-hosted.mjs`、`modules/hosted.mjs`;
 * 语义 `docs/semantics/product/agent.md`「发出任务后可以离开」「身份」,`product/rendering.md`「谁产流与托管方开关」)。
 *
 *   APT-1  签票:渲染节点与「生成轨道流」都开着才签;关着回 service-disabled;项目不在回 no-project;
 *          不是 agent、用途不是 publish 一律 forbidden
 *   APT-2  凭票连进来:身份是 scope: service、purpose: publish、本项目;开关在连接期间被关掉,复核即拒
 *   APT-3  逐消息:只许发本项目的带片段清单的计划;发别的项目的计划、别的消息种类(改项目、读项目、认领、票据)都拒;
 *          不走任务授权
 *   APT-4  目录模块:Agent 服务的控制连接为账号项目要 purpose: publish 的票据走账号运行时;公钥不在登记表回 service-revoked;
 *          不带 purpose 的照旧 forbidden
 * 跑:node --test server/test/account-agent-publish-ticket.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openAccountLedger } from '../account/ledger.mjs';
import { createAccountHostedRuntime } from '../docservice/account-hosted.mjs';
import { serviceGate } from '../docservice/service-gate.mjs';
import { clipsPlanTaskOf } from '../render-queue/messages.mjs';

const A = 'acc_' + 'a'.repeat(24);
const TOKENS = { 'tok-a': A };

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-agent-publish-'));
  const ledger = openAccountLedger({ file: path.join(dir, 'doc.sqlite'), authorityId: 'doc-publish-fixture' });
  const accountClient = {
    verify: async (token) => {
      const accountId = TOKENS[token];
      if (!accountId) throw Object.assign(new Error('login-required'), { status: 401, code: 'login-required' });
      return { accountId, accountName: 'Alice', loginId: `login-${token}`, credentialId: `cred-${token}`, loginGeneration: 1,
        expiresAt: Date.now() + 3_600_000, accountEventSeq: 0, kind: 'editor' };
    },
    events: async () => ({ events: [], headSeq: 0 }),
  };
  const runtime = createAccountHostedRuntime({ ledger, accountClient, dataDir: null, authorityUrl: 'https://fixture.invalid', allowFixtureAssetReady: true, pollMs: 0 });
  runtime.setAssetReady(true);
  const registry = { refresh() {}, get: (name) => (name === 'render' || name === 'agent' ? { role: name, actsFor: name === 'agent' ? 'member' : 'self', keys: [{ kid: 'k1' }] } : null), has: () => true };
  runtime.bindService({ describe: () => ({ conns: [] }), fencePrincipals: async () => ({ actualClosed: true }) }, { registry, urls: {} });
  await runtime.start();
  t.after(() => { try { runtime.close(); } catch { /* 已关 */ } fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const authority = runtime.authority;
  const mk = async (requestId) => (await authority.createProject({ accessToken: 'tok-a' }, { name: `发布 ${requestId}`, requestId, initialProject: { tracks: [] } })).projectId;
  const projectId = await mk('create-1');
  const other = await mk('create-2');
  const admin = async (pid, body) => {
    const { accessRevision } = await authority.authorizePrincipal({ accessToken: 'tok-a' }, { projectId: pid });
    return authority.adminProject({ accessToken: 'tok-a' }, { projectId: pid, expectedAccessRevision: accessRevision, ...body });
  };
  const streams = (pid, value, requestId) => admin(pid, { op: 'set-hosted-option', service: 'render', option: 'streams', enabled: value, requestId });
  return { runtime, ledger, projectId, other, admin, streams };
}
const issue = (f, over = {}) => f.runtime.issueServiceTicket({ service: 'agent', serviceKid: 'k1', deviceId: 'agent-inst', deviceName: 'agent', projectId: f.projectId, purpose: 'publish', ...over });
const reqOf = (ticket) => ({ headers: { 'sec-websocket-protocol': `promptcut.v1, promptcut.ticket.${ticket}` } });
const throwsCode = (fn, code) => assert.throws(fn, (e) => e.code === code);
const planFor = (projectId) => clipsPlanTaskOf({ projectId, projectRev: 1, clips: ['c1'], codeVersion: 'cv' });

test('APT-1 签票:渲染节点与生成轨道流都开着才签;关着、项目不在、不是 agent、用途不对都拒', async (t) => {
  const f = await fixture(t);
  throwsCode(() => issue(f), 'service-disabled');                       // 新项目「生成轨道流」缺省关
  await f.streams(f.projectId, true, 'streams-on');
  const out = issue(f);
  assert.equal(typeof out.ticket, 'string'); assert.ok(out.exp > Date.now());
  throwsCode(() => issue(f, { projectId: 'sp_' + 'z'.repeat(26) }), 'no-project');
  throwsCode(() => issue(f, { service: 'render' }), 'forbidden');
  throwsCode(() => issue(f, { purpose: 'run' }), 'forbidden');
  // 渲染节点关了(「生成轨道流」还开着):同样不签
  await f.admin(f.projectId, { op: 'set-hosted-service', service: 'render', enabled: false, requestId: 'render-off' });
  assert.equal(f.ledger.read().projects[f.projectId].hosted?.render, false);
  throwsCode(() => issue(f), 'service-disabled');
});

test('APT-2 凭票连进来:scope service、purpose publish、本项目;开关关掉后复核即拒', async (t) => {
  const f = await fixture(t);
  await f.streams(f.projectId, true, 'streams-on');
  const { ticket } = issue(f);
  assert.equal(f.runtime.hasServiceTicket(ticket), true);
  const p = await f.runtime.authenticate(reqOf(ticket));
  assert.deepEqual([p.scope, p.service, p.purpose, p.tenantId, p.realm, p.identityVersion], ['service', 'agent', 'publish', f.projectId, 'account', 2]);
  assert.equal(p.accountId, undefined, '不带任何成员的身份');
  assert.notEqual(p.role, 'agent', '不是任务连接的角色(任务连接要实例调用证明、走任务授权)');
  assert.equal(await f.runtime.resumeGate(p), null);
  await f.streams(f.projectId, false, 'streams-off');
  assert.equal(await f.runtime.resumeGate(p), 'service-disabled');
  await assert.rejects(() => f.runtime.authenticate(reqOf(ticket)), (e) => e.code === 'service-disabled');
});

test('APT-3 逐消息:只许本项目的片段清单计划;别的项目、别的种类都拒;不走任务授权', async (t) => {
  const f = await fixture(t);
  await f.streams(f.projectId, true, 'streams-on');
  const p = await f.runtime.authenticate(reqOf(issue(f).ticket));
  const gate = async (type, msg) => serviceGate(p, type, msg) ?? await f.runtime.gate(p, type, msg);
  assert.equal(await gate('publisher.hello', { publisherId: 'x' }), null);
  assert.equal(await gate('task.publish', { tasks: [planFor(f.projectId)] }), null, '本项目的清单计划放行');
  assert.equal(await gate('task.unsubscribe', { ids: ['x'] }), null);
  assert.equal(await gate('task.publish', { tasks: [planFor(f.other)] }), 'project-mismatch', '别的项目的计划');
  assert.equal(await gate('task.publish', { tasks: [planFor(f.projectId), planFor(f.other)] }), 'project-mismatch');
  for (const type of ['project.op', 'project.open', 'project.snapshot.get', 'content.put', 'content.get', 'task.claim', 'node.hello', 'auth.ticket', 'events.create', 'presence.set', 'selection.query', 'hosted.ticket'])
    assert.equal(await gate(type, { projectId: f.projectId }), 'forbidden', `${type} 不许`);
  // 细任务(不是清单计划)也不许
  assert.equal(await gate('task.publish', { tasks: [{ ...planFor(f.projectId), kind: 'segment' }] }), 'forbidden');
  // 别的项目开着、本项目关了:按本项目算
  await f.streams(f.other, true, 'other-on');
  await f.streams(f.projectId, false, 'streams-off');
  assert.equal(await gate('task.publish', { tasks: [planFor(f.projectId)] }), 'service-disabled');
  // 伪造的用途、别的服务带用途:拒
  assert.equal(await f.runtime.gate({ ...p, purpose: 'run' }, 'task.publish', { tasks: [planFor(f.projectId)] }), 'forbidden');
});

test('APT-4 目录模块:账号项目的 purpose publish 票据走账号运行时;公钥不在登记表 service-revoked;不带 purpose 照旧 forbidden', async () => {
  const { hostedModule } = await import('../docservice/modules/hosted.mjs');
  const projectId = 'sp_' + 'q'.repeat(26);
  const calls = [];
  let has = true;
  const accountRuntime = {
    authority: { listActiveProjects: () => [], projectState: (id) => (id === projectId ? { projectId, status: 'active' } : null) },
    issueServiceTicket: (o) => { calls.push(o); if (o.projectId !== projectId) throw Object.assign(new Error('x'), { code: 'no-project' }); return { ticket: 'T', exp: 1 }; },
  };
  const registry = { version: 1, get: (name) => (name === 'agent' ? { role: 'agent', actsFor: 'member', keys: [{ kid: 'k1' }] } : null), has: () => has };
  const sent = [];
  const ctx = { now: () => 1000, send: (connId, msg) => sent.push(msg), log: () => {} };
  const mod = hostedModule({ store: () => null, registry: () => registry, now: () => 1000, accountRuntime });
  mod.connect(ctx, 'ctrl-agent', { userId: 'service:agent@inst', tenantId: null, scope: 'service', service: 'agent', serviceKid: 'k1', deviceId: 'inst', deviceName: 'agent' });
  mod.handle(ctx, 'ctrl-agent', { type: 'hosted.ticket', projectId, purpose: 'publish', reqId: 1 });
  assert.deepEqual(sent.pop(), { type: 'hosted.ticket.ok', ticket: 'T', exp: 1, reqId: 1 });
  assert.deepEqual(calls.pop(), { service: 'agent', serviceKid: 'k1', deviceId: 'inst', deviceName: 'agent', projectId, purpose: 'publish' });
  mod.handle(ctx, 'ctrl-agent', { type: 'hosted.ticket', projectId, reqId: 2 });
  assert.equal(sent.pop().reason, 'forbidden', '不带委托也不带 purpose:没有「服务自己读写项目」这回事');
  has = false;
  mod.handle(ctx, 'ctrl-agent', { type: 'hosted.ticket', projectId, purpose: 'publish', reqId: 3 });
  assert.equal(sent.pop().reason, 'service-revoked');
  assert.equal(calls.length, 0);
});
