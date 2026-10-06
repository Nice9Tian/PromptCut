/**
 * 云端 Agent 服务接真身份、真队列的那一层(`server/agent-service/hosted-wiring.mjs`、`render-publisher.mjs`)与部署脚本
 * (`server/agent-service/deploy.mjs`)。契约 `docs/plan/cloud-agent-contract.md` 第 4.3、4.5、16 节。
 * 跑:node scripts/test-suite.mjs server/test/cloud-agent-wiring.test.mjs
 *
 *   CA-WIRE-01  委托票据的核验:结果按票据摘要缓存 15 秒;`service-disabled` 回 403 disabled;控制连接断着回 503 unavailable;
 *               别的原因一律当没有身份(401);撤销后缓存清掉
 *   CA-WIRE-02  对话委托:不是对话委托、别的项目、别的成员、别的对话的,都不放行;换票据被拒时带着文档服务给的原因
 *   CA-WIRE-03  目录推送:开关被关 → 撤销(disabled);项目从目录里消失 → 文档服务说没有这个项目才当删除,搬迁只停不删,问不到不动
 *   CA-PUB-01   发布通道:计划切完后按细任务逐个到齐才算完成,每条完成通知都报进度;有细任务失败报失败
 *   CA-PUB-02   别的发布方先发过、已经切完的计划(或断线后重发):改发补渲档的同一份清单核对一次,做完的补到齐即完成
 *   CA-PUB-03   撤回:退订计划与它切出的细任务;关闭时撤回「这个项目有活」的声明;连接自己断了通知上层重开
 *   CA-DEPLOY-01 部署脚本:四个子命令的脚本里没有没填的占位符、不含任何秘密;参数不对拒绝;PM2 配置的内存上限与入口
 *
 * 全部不出网:服务客户端与 WebSocket 都是进程内的替身。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostedWiring, bearerOf } from '../agent-service/hosted-wiring.mjs';
import { createQueuePublisher } from '../agent-service/render-publisher.mjs';
import { planAgentCommand, agentInstance, agentPm2Config } from '../agent-service/deploy.mjs';
import { AgentServiceError } from '../agent/service/create-agent-service.mjs';
import { clipsPlanTaskOf, backfillPlanTaskOf } from '../render-queue/messages.mjs';

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
const T = (name) => `v1.${Buffer.from(name).toString('base64url')}.${'s'.repeat(43)}`;
const reqOf = (ticket) => ({ headers: ticket === null ? {} : { authorization: `Bearer ${ticket}` } });

function fakeClient(over = {}) {
  const calls = { verify: 0, ticket: [], publish: [], demand: [] };
  let watcher = null;
  const client = {
    instanceId: 'agent-inst-0001', connected: true, calls,
    watch(w) { watcher = w; return Promise.resolve({ ok: true, projects: [] }); },
    push: (item) => watcher.onProject(item),
    full: (list) => watcher.onProjects(list),
    async verifyDelegation(t) {
      calls.verify += 1;
      return over.verify ? over.verify(t) : { ok: false, reason: 'signature' };
    },
    async memberTicket(f) { calls.ticket.push(f); return over.ticket ? over.ticket(f) : { ok: true, ticket: 'conn-ticket' }; },
    async publishTicket(projectId) { calls.publish.push(projectId); return over.publish ? over.publish(projectId) : { ok: true, ticket: 'pub-ticket' }; },
    async demand(projectId, holdMs) { calls.demand.push([projectId, holdMs]); return { ok: true }; },
    dataProtocols: (ticket) => ['promptcut.v1', `promptcut.ticket.${ticket}`],
  };
  return client;
}
const who = (o = {}) => ({ ok: true, projectId: 'sp_a', userId: 'alice@dev1', username: 'alice', deviceId: 'dev1', deviceName: '电脑', creator: false, mode: 'restricted', acc: 'rw', access: 'rw', exp: Date.now() + 120_000, ownerKey: 'user:alice', grant: false, ...o });

test('CA-WIRE-01 委托票据的核验:缓存 15 秒、disabled 回 403、连不上回 503、其余当没有身份', async () => {
  let at = 1_000_000;
  let answer = () => who();
  const client = fakeClient({ verify: (t) => answer(t) });
  const w = createHostedWiring({ client, docUrl: 'ws://127.0.0.1:1', root: '.', now: () => at });
  assert.equal(bearerOf(reqOf(null)), null);
  assert.equal(bearerOf({ headers: { authorization: 'Basic abc' } }), null);
  assert.equal(await w.authenticate(reqOf(null)), null, '不带票据');
  assert.equal(client.calls.verify, 0, '不带票据不去问文档服务');
  const a = await w.authenticate(reqOf(T('one')));
  assert.deepEqual({ projectId: a.projectId, userId: a.userId, ownerKey: a.ownerKey, access: a.access }, { projectId: 'sp_a', userId: 'alice@dev1', ownerKey: 'user:alice', access: 'rw' });
  await w.authenticate(reqOf(T('one')));
  assert.equal(client.calls.verify, 1, '15 秒内同一张票据不重问');
  at += 15_001;
  await w.authenticate(reqOf(T('one')));
  assert.equal(client.calls.verify, 2, '过了 15 秒重问');
  // 撤销清缓存:被踢的成员不靠缓存再读 15 秒
  const listeners = [];
  w.attach({ onRevoke: (fn) => listeners.push(fn), revoke() {} });
  listeners[0]({ projectId: 'sp_a', userId: 'alice@dev1', reason: 'kicked' });
  answer = () => ({ ok: false, reason: 'banned' });
  assert.equal(await w.authenticate(reqOf(T('one'))), null, '撤销后同一张票据立刻重问、被拒');
  answer = () => ({ ok: false, reason: 'service-disabled' });
  await assert.rejects(() => w.authenticate(reqOf(T('two'))), (e) => e instanceof AgentServiceError && e.code === 'disabled' && e.status === 403);
  answer = () => ({ ok: false, reason: 'unavailable' });
  await assert.rejects(() => w.authenticate(reqOf(T('three'))), (e) => e instanceof AgentServiceError && e.code === 'unavailable' && e.status === 503);
  for (const reason of ['expired', 'signature', 'generation', 'not-listed', 'audience']) {
    answer = () => ({ ok: false, reason });
    assert.equal(await w.authenticate(reqOf(T(`bad-${reason}`))), null, reason);
  }
  w.close();
});

test('CA-WIRE-02 对话委托只认这个项目、这位成员、这个对话的;换票据被拒时带着原因', async () => {
  const table = {
    [T('grant')]: who({ grant: true, conversationId: 'c1' }),
    [T('short')]: who(),
    [T('other-conv')]: who({ grant: true, conversationId: 'c2' }),
    [T('other-user')]: who({ grant: true, conversationId: 'c1', userId: 'bob@dev2' }),
    [T('other-project')]: who({ grant: true, conversationId: 'c1', projectId: 'sp_b' }),
  };
  let ticketAnswer = { ok: true, ticket: 'conn-1' };
  const client = fakeClient({ verify: (t) => table[t] ?? { ok: false, reason: 'expired' }, ticket: () => ticketAnswer });
  const w = createHostedWiring({ client, docUrl: 'ws://127.0.0.1:1', root: '.' });
  const identity = { projectId: 'sp_a', userId: 'alice@dev1' };
  await w.credentials.admitGrant(identity, 'c1', T('grant'));
  const reasonOf = async (g) => { try { await w.credentials.admitGrant(identity, 'c1', g); return 'ok'; } catch (e) { return e.reason; } };
  assert.equal(await reasonOf(null), 'not-grant');
  assert.equal(await reasonOf(T('short')), 'not-grant');
  assert.equal(await reasonOf(T('other-conv')), 'conversation');
  assert.equal(await reasonOf(T('other-user')), 'forbidden');
  assert.equal(await reasonOf(T('other-project')), 'project');
  assert.equal(await reasonOf(T('gone')), 'expired');
  assert.deepEqual(await w.credentials.protocolsFor(identity, 3, { conversationId: 'c1', grant: T('grant') }), ['promptcut.v1', 'promptcut.ticket.conn-1']);
  assert.deepEqual(client.calls.ticket.at(-1), { projectId: 'sp_a', conversation: 3, conversationId: 'c1', delegation: T('grant') });
  await assert.rejects(() => w.credentials.protocolsFor(identity, 1, { conversationId: 'c1', grant: null }), (e) => e.reason === 'not-grant');
  for (const reason of ['expired', 'generation', 'service-disabled', 'banned', 'not-listed', 'no-project', 'unavailable', 'timeout']) {
    ticketAnswer = { ok: false, reason };
    await assert.rejects(() => w.credentials.protocolsFor(identity, 1, { conversationId: 'c1', grant: T('grant') }), (e) => e.reason === reason, reason);
  }
  w.close();
});

test('CA-WIRE-03 目录推送:关开关即撤销;项目消失时删除与搬迁分开办,问不到不动', async () => {
  let publish = () => ({ ok: true, ticket: 'x' });
  const client = fakeClient({ publish: (id) => publish(id) });
  const w = createHostedWiring({ client, docUrl: 'ws://127.0.0.1:1', root: '.' });
  const revoked = [];
  w.attach({ onRevoke() {}, revoke: (r) => revoked.push(`${r.projectId}:${r.reason}`) });
  const item = (projectId, enabled, render = true) => ({ projectId, enabled, active: false, members: false, hosted: { render: { available: true, enabled: render }, agent: { available: true, enabled } } });
  client.full([item('sp_a', true), item('sp_b', true, false)]);
  assert.equal(w.projectState.agentEnabled('sp_a'), true);
  assert.equal(w.projectState.renderEnabled('sp_b'), false);
  assert.deepEqual(w.publisher.availability('sp_b'), { available: true, enabled: false });
  assert.deepEqual(w.publisher.availability('sp_unknown'), { available: false, enabled: false }, '目录里没有的项目不发补渲');
  assert.equal(w.projectState.agentEnabled('sp_unknown'), true, '目录里还没有的项目按缺省(开)答,真假由文档服务核验把关');
  client.push(item('sp_a', false));
  assert.deepEqual(revoked, ['sp_a:disabled']);
  assert.equal(w.projectState.agentEnabled('sp_a'), false);
  client.push(item('sp_a', false));
  assert.deepEqual(revoked, ['sp_a:disabled'], '已经关着的不重复撤销');
  client.push(item('sp_a', true));
  // 消失:文档服务说没有这个项目 → 删除
  publish = () => ({ ok: false, reason: 'no-project' });
  client.push({ projectId: 'sp_a', removed: true });
  await tick();
  assert.deepEqual(revoked.slice(1), ['sp_a:deleted']);
  // 消失:在搬迁 → 只停不删
  publish = () => ({ ok: false, reason: 'relocating' });
  client.push({ projectId: 'sp_b', removed: true });
  await tick();
  assert.deepEqual(revoked.slice(2), ['sp_b:relocating']);
  // 消失:问不到 → 不动
  client.full([item('sp_c', true)]);
  publish = () => ({ ok: false, reason: 'unavailable' });
  client.full([]);
  await tick();
  assert.equal(revoked.length, 3, '问不到文档服务时什么都不停');
  w.close();
});

/* ------------------------------------------------------------------ 发布通道:替身 WebSocket 扮文档服务的队列 */

function fakeQueue() {
  const sockets = [];
  class FakeWS {
    constructor(url, protocols) {
      this.url = url; this.protocols = protocols; this.sent = []; this.listeners = new Map(); this.closed = false;
      sockets.push(this);
      setTimeout(() => this.fire('open', {}), 0);
    }
    addEventListener(type, fn, opts) { const l = this.listeners.get(type) ?? []; l.push({ fn, once: opts?.once === true }); this.listeners.set(type, l); }
    fire(type, ev) { const l = this.listeners.get(type) ?? []; this.listeners.set(type, l.filter((x) => !x.once)); for (const x of l) x.fn(ev); }
    send(text) {
      const m = JSON.parse(text);
      this.sent.push(m);
      queueMicrotask(() => {
        if (m.type === 'publisher.hello') this.reply({ type: 'publisher.welcome', publisherId: m.publisherId, reqId: m.reqId });
        else if (m.type === 'task.publish') this.reply({ type: 'task.published', reqId: m.reqId, results: m.tasks.map((t) => this.onPublish?.(t) ?? { id: t.id, state: 'open', version: 1, created: true }) });
        else if (m.type === 'task.unsubscribe') this.reply({ type: 'task.unsubscribed', reqId: m.reqId, ids: m.ids });
      });
    }
    reply(m) { this.fire('message', { data: JSON.stringify(m) }); }
    close(code = 1000, reason = '') { if (this.closed) return; this.closed = true; setTimeout(() => this.fire('close', { code, reason }), 0); }
  }
  return { FakeWS, sockets };
}

async function openPublisher(over = {}) {
  const q = fakeQueue();
  const client = fakeClient();
  const pub = createQueuePublisher({ client, docUrl: 'ws://127.0.0.1:1', root: '.', renderState: () => ({ available: true, enabled: true }), WebSocketImpl: q.FakeWS, codeVersionOf: () => 'code-1', ...over });
  const seen = { progress: [], done: [], fail: [], close: 0 };
  const handle = await pub.open('sp_a', { onProgress: (p) => seen.progress.push(p), onDone: (d) => seen.done.push(d.id), onFail: (f) => seen.fail.push(f), onClose: () => { seen.close += 1; } });
  return { pub, client, handle, seen, ws: q.sockets[0], q };
}
const planOf = (rev, clips = ['c1', 'c2']) => clipsPlanTaskOf({ projectId: 'sp_a', projectRev: rev, clips, codeVersion: 'code-1' });

test('CA-PUB-01 计划切完后细任务逐个到齐才算完成,每条完成通知都报进度;有细任务失败报失败', async () => {
  const { pub, client, handle, seen, ws } = await openPublisher();
  assert.deepEqual(ws.protocols, ['promptcut.v1', 'promptcut.ticket.pub-ticket'], '用发布票据握手');
  assert.equal(ws.sent[0].type, 'publisher.hello');
  assert.deepEqual(client.calls.demand[0], ['sp_a', 120_000], '开着期间声明这个项目有活');
  assert.equal(pub.codeVersion(), 'code-1');
  const plan = planOf(5);
  await handle.publish(plan);
  // 切分时已有的细任务先各补一条完成(在计划自己的完成之前到)
  ws.reply({ type: 'task.done', id: 'fine-1' });
  ws.reply({ type: 'task.done', id: plan.id, result: { derived: ['fine-1', 'fine-2', 'fine-3'] } });
  assert.deepEqual(seen.done, [], '还有两段没做完');
  assert.deepEqual(seen.progress.at(-1), { id: plan.id, done: 1, total: 3 });
  ws.reply({ type: 'task.done', id: 'fine-2' });
  assert.deepEqual(seen.progress.at(-1), { id: plan.id, done: 2, total: 3 });
  ws.reply({ type: 'task.done', id: 'fine-3' });
  assert.deepEqual(seen.done, [plan.id]);
  // 第二个计划:有一段失败
  const plan2 = planOf(6);
  await handle.publish(plan2);
  ws.reply({ type: 'task.done', id: plan2.id, result: { derived: ['fine-1', 'fine-9'] } });
  assert.equal(seen.fail.length, 0, 'fine-1 之前见过完成,fine-9 还没结果');
  ws.reply({ type: 'task.failed', id: 'fine-9', error: 'render-crash' });
  assert.equal(seen.fail.length, 1);
  assert.equal(seen.fail[0].id, plan2.id);
  assert.match(seen.fail[0].reason, /render-crash/);
  // 没切出任何细任务的计划(清单里都是不用渲的):当场完成
  const plan3 = planOf(7, ['c9']);
  await handle.publish(plan3);
  ws.reply({ type: 'task.done', id: plan3.id, result: { derived: [] } });
  assert.deepEqual(seen.done, [plan.id, plan3.id]);
  pub.close();
});

test('CA-PUB-02 已经切完的计划(别人先发过,或断线后重发):改发补渲档的同一份清单核对一次', async () => {
  const { pub, handle, seen, ws } = await openPublisher();
  const plan = planOf(8);
  const verifyId = backfillPlanTaskOf({ projectId: 'sp_a', projectRev: 8, clips: ['c1', 'c2'] }).id;
  ws.onPublish = (t) => {
    if (t.id === plan.id) { queueMicrotask(() => ws.reply({ type: 'task.done', id: plan.id, result: { derived: ['f1', 'f2'] } })); return { id: t.id, state: 'done', version: 3, created: false }; }
    return { id: t.id, state: 'open', version: 1, created: true };
  };
  await handle.publish(plan);
  await tick();
  const verify = ws.sent.filter((m) => m.type === 'task.publish').at(-1).tasks[0];
  assert.equal(verify.id, verifyId, '核对用的是补渲档的同一份清单');
  assert.equal(verify.priority, 'backfill');
  assert.deepEqual(verify.requires, { codeVersion: 'code-1' });
  assert.deepEqual(seen.done, []);
  // 渲染节点重新切:做完的细任务把发布方并进订阅者,当场各补一条
  ws.reply({ type: 'task.done', id: 'f1' });
  ws.reply({ type: 'task.done', id: 'f2' });
  ws.reply({ type: 'task.done', id: verifyId, result: { derived: ['f1', 'f2'] } });
  assert.deepEqual(seen.done, [plan.id], '核对到齐,原计划完成');
  assert.equal(ws.sent.filter((m) => m.type === 'task.publish').length, 2, '同一份清单只核对一次');
  pub.close();
});

test('CA-PUB-03 撤回退订计划与细任务;关闭撤回声明;连接自己断了通知上层重开,重发后之前见过的完成仍然算数', async () => {
  const { pub, client, handle, seen, ws, q } = await openPublisher();
  const plan = planOf(9);
  await handle.publish(plan);
  ws.reply({ type: 'task.done', id: plan.id, result: { derived: ['g1', 'g2'] } });
  ws.reply({ type: 'task.done', id: 'g1' });
  // 连接自己断了
  ws.close(1006, '');
  await tick(20);
  assert.equal(seen.close, 1, '通知上层重开');
  const again = await pub.open('sp_a', { onDone: (d) => seen.done.push(d.id), onProgress() {}, onFail() {}, onClose() {} });
  const ws2 = q.sockets[1];
  assert.equal(ws2.sent[0].publisherId, ws.sent[0].publisherId, '重开用同一个发布方 id(宽限期内接得上原来的订阅)');
  ws2.onPublish = (t) => (t.id === plan.id ? { id: t.id, state: 'done', version: 2, created: false } : { id: t.id, state: 'open', version: 1, created: true });
  await again.publish(plan);
  ws2.reply({ type: 'task.done', id: plan.id, result: { derived: ['g1', 'g2'] } });
  await tick();
  assert.equal(ws2.sent.filter((m) => m.type === 'task.publish').length, 2, 'g2 的结果没见过:核对一次');
  ws2.reply({ type: 'task.done', id: 'g2' });
  assert.deepEqual(seen.done, [plan.id], '断线前见过的 g1 仍然算数');
  // 撤回
  const plan2 = planOf(10);
  await again.publish(plan2);
  ws2.reply({ type: 'task.done', id: plan2.id, result: { derived: ['h1'] } });
  await again.withdraw(plan2.id);
  assert.deepEqual(ws2.sent.at(-1), { type: 'task.unsubscribe', ids: [plan2.id, 'h1'], reqId: ws2.sent.at(-1).reqId });
  ws2.reply({ type: 'task.done', id: 'h1' });
  assert.deepEqual(seen.done, [plan.id], '撤回之后不再报它');
  again.close();
  assert.deepEqual(client.calls.demand.at(-1), ['sp_a', 0], '关闭时撤回声明');
  pub.close();
});

test('CA-DEPLOY-01 Agent 服务的部署脚本:没有没填的占位符、不含秘密、参数不对拒绝', () => {
  const env = {};
  const inst = agentInstance(env);
  assert.equal(inst.app, 'promptcut-agent');
  assert.equal(inst.current, '/opt/promptcut-render/current', '与渲染服务共用检出');
  const pm2 = agentPm2Config(inst);
  assert.ok(!pm2.includes('{{') && !pm2.includes('}}'));
  assert.match(pm2, /script: 'server\/agent-service\/main\.mjs'/);
  assert.match(pm2, /node_args: '--max-old-space-size=1536'/);
  assert.match(pm2, /max_memory_restart: '2G'/);
  assert.match(pm2, /kill_timeout: 8000/);
  assert.match(pm2, /PROMPTCUT_AGENT_HOST: '127\.0\.0\.1'/);
  assert.match(pm2, /PROMPTCUT_AGENT_ASSET_URL: 'http:\/\/127\.0\.0\.1:8788'/);
  assert.ok(!/^\s*PROMPTCUT_AGENT_EGRESS_TEST_ALLOW\s*:/m.test(pm2), '生产配置不设出网闸的测试例外');
  assert.throws(() => agentInstance({ PROMPTCUT_AGENT_ASSET_URL: 'http://example.com:8788' }), /ASSET_URL/);
  const status = planAgentCommand('status-agent', ['--dry-run'], env).script;
  assert.ok(status.includes('c.api') && !status.includes('set-key.mjs'), '状态脚本读 api.vendor / api.model,提示加密分发');
  for (const [cmd, argv] of [['deploy-agent', []], ['deploy-agent', ['--no-start']], ['deploy-agent', ['--save']], ['status-agent', []], ['stop-agent', []], ['stop-agent', ['--delete']], ['keygen-agent', []], ['keygen-agent', ['--list']], ['keygen-agent', ['--retire', 'abcdEFGH']]]) {
    const plan = planAgentCommand(cmd, [...argv, '--dry-run'], env);
    assert.equal(plan.dryRun, true);
    assert.ok(plan.script.startsWith('set -euo pipefail\n'), cmd);
    assert.ok(!plan.script.includes('{{'), `${cmd} 没有没填的占位符`);
    assert.ok(!/CLUSTER_TOKEN|priv|BEGIN [A-Z ]*PRIVATE/.test(plan.script), `${cmd} 不含秘密`);
  }
  assert.match(planAgentCommand('keygen-agent', [], env).script, /--service agent/);
  assert.match(planAgentCommand('deploy-agent', ['--no-start'], env).script, /没有动 PM2/);
  assert.ok(!planAgentCommand('deploy-agent', ['--no-start'], env).script.includes('pm2 startOrReload'));
  assert.throws(() => planAgentCommand('deploy-agent', ['--commit', 'abc'], env), /不认识的参数/);
  assert.throws(() => planAgentCommand('status-agent', ['--save'], env), /不收/);
  assert.throws(() => planAgentCommand('keygen-agent', ['--retire', 'short'], env), /kid/);
  assert.throws(() => agentInstance({ PROMPTCUT_AGENT_PORT: '80' }), /PROMPTCUT_AGENT_PORT/);
  assert.throws(() => agentInstance({ PROMPTCUT_AGENT_DATA: 'relative/dir' }), /绝对路径/);
  assert.throws(() => agentInstance({ PROMPTCUT_AGENT_PUBLIC_ORIGIN: 'https://x.example/agent' }), /PUBLIC_ORIGIN/);
});
