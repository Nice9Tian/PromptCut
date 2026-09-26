/**
 * 两种传输的等价性（契约 `docs/plan/http-transport-contract.md` 第 10 节 HT3）：同一组模块流程分别跑在 WebSocket 与
 * HTTP 长轮询上，逐条回包（去掉令牌、epoch 这类每次不同的字段）完全相同。
 * 跑：node --test server/test/docservice-transport-equivalence.test.mjs
 *
 * 覆盖：渲染任务队列的认领 / 完成 / 断线放回；项目的提交 / stale；内容库的 put / watch。
 * 时钟注入，端口 0，`autoTick: false`；principal 由子协议给（`fake-transport-kit.mjs` 的 `authByProtocols`），两种传输同一条路。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocService } from '../docservice/service.mjs';
import { createRenderQueue } from '../render-queue/index.mjs';
import { projectModule } from '../docservice/modules/project.mjs';
import { contentModule } from '../docservice/modules/content.mjs';
import { createMemoryStore } from '../docservice/store/index.mjs';
import { transportClient, authByProtocols, protocolsOf } from './fake-transport-kit.mjs';
import { snapshotTaskInput, waitFor } from './fake-ws-kit.mjs';

const T0 = 1_700_000_000_000;
const GRACE_MS = 10_000;
const KINDS = ['ws', 'http'];

/** 去掉每次运行都不同的字段（认领令牌），其余逐字段比 */
function norm(v) {
  if (Array.isArray(v)) return v.map(norm);
  if (v === null || typeof v !== 'object') return v;
  const out = {};
  for (const k of Object.keys(v).sort()) {
    if (k === 'token') { out[k] = typeof v[k]; continue; }
    out[k] = norm(v[k]);
  }
  return out;
}

async function startEnv(t, kind, { modules = [], queue = false } = {}) {
  const clock = { t: T0 };
  const service = createDocService({ autoTick: false, authenticate: authByProtocols, log: () => {}, now: () => clock.t, modules });
  let q = null;
  if (queue) {
    q = createRenderQueue({ now: () => clock.t, send: service.send, epoch: 'equivalence-epoch', constants: { RECONNECT_GRACE_MS: GRACE_MS } });
    service.mountRenderQueue(q);
  }
  const { port } = await service.listen(0, '127.0.0.1');
  const clients = [];
  t.after(async () => {
    for (const c of clients) c.close();
    await service.close();
  });
  const url = `ws://127.0.0.1:${port}`;
  let seq = 0;
  const connect = async (who) => {
    const c = transportClient(kind, url, protocolsOf(who));
    clients.push(c);
    await c.opened;
    return c;
  };
  const ask = async (c, msg) => {
    const reqId = `q${++seq}`;
    c.send({ ...msg, reqId });
    const reply = await c.next((m) => m.reqId === reqId);
    const { reqId: _drop, ...rest } = reply;
    return rest;
  };
  return { service, clock, connect, ask, url };
}

// ------------------------------------------------------------------ 渲染任务队列

async function queueScenario(t, kind) {
  const env = await startEnv(t, kind, { queue: true });
  const out = [];
  const note = (label, m) => out.push([label, norm(m)]);
  const pub = await env.connect({ user: 'pub' });
  const a = await env.connect({ user: 'node-a' });
  const b = await env.connect({ user: 'node-b' });
  const tasks = [0, 1, 2].map((i) => snapshotTaskInput({ resultKey: `eq-${i}`, projectId: 'p-eq' }));
  const [t1, t2] = tasks.map((x) => x.id);

  note('pub.hello', await env.ask(pub, { type: 'publisher.hello', publisherId: 'pub' }));
  note('pub.publish', await env.ask(pub, { type: 'task.publish', tasks }));
  note('a.hello', await env.ask(a, { type: 'node.hello', nodeId: 'A', profile: 'pc' }));
  note('a.watch', await env.ask(a, { type: 'queue.watch', projects: ['p-eq'] }));
  note('b.hello', await env.ask(b, { type: 'node.hello', nodeId: 'B', profile: 'pc' }));
  note('b.watch', await env.ask(b, { type: 'queue.watch', projects: ['p-eq'] }));

  // 认领：同一个任务两个节点抢，只有一个成功
  const claimA = await env.ask(a, { type: 'task.claim', id: t1, expectVersion: 1 });
  note('a.claim t1', claimA);
  note('b.claim t1', await env.ask(b, { type: 'task.claim', id: t1, expectVersion: 1 }));
  note('b.sees taken', await b.next((m) => m.type === 'task.taken' && m.id === t1));

  // 完成：发布方收到 task.done
  note('a.complete t1', await env.ask(a, { type: 'task.complete', id: t1, token: claimA.token, result: { frames: 30 } }));
  note('pub.done t1', await pub.next((m) => m.type === 'task.done' && m.id === t1));

  // 断线放回：B 认领 t2 后断开，宽限期过后 t2 回到 open，A 看到 task.opened 并认领成功
  const claimB = await env.ask(b, { type: 'task.claim', id: t2, expectVersion: 1 });
  note('b.claim t2', claimB);
  b.close();
  await b.closed;
  await waitFor(() => env.service.describe().modules['render-queue'].nodes.find((n) => n.nodeId === 'B')?.connected === false, 3000, `[${kind}] B 记为断开`);
  env.clock.t += GRACE_MS + 1;
  env.service.tick();
  const reopened = await a.next((m) => m.type === 'task.opened' && m.task?.id === t2);
  note('a.sees reopened t2', reopened);
  const claimA2 = await env.ask(a, { type: 'task.claim', id: t2, expectVersion: reopened.task.version });
  note('a.claim t2', claimA2);
  note('a.complete t2', await env.ask(a, { type: 'task.complete', id: t2, token: claimA2.token, result: { frames: 30 } }));
  note('pub.done t2', await pub.next((m) => m.type === 'task.done' && m.id === t2));

  const d = env.service.describe().modules['render-queue'];
  note('final', d.tasks.map((x) => ({ id: x.id, state: x.state, attempts: x.attempts, lastError: x.lastError ?? null })).sort((x, y) => (x.id < y.id ? -1 : 1)));
  return out;
}

test('HT3 渲染任务队列：认领 / 完成 / 断线放回在 WebSocket 与 HTTP 上逐条相同', { timeout: 30_000 }, async (t) => {
  const runs = {};
  for (const kind of KINDS) runs[kind] = await queueScenario(t, kind);
  const ws = Object.fromEntries(runs.ws);
  // 场景本身成立（不是两边都空）
  assert.equal(ws['a.claim t1'].type, 'task.claimed');
  assert.equal(ws['b.sees taken'].type, 'task.taken');
  assert.equal(ws['b.claim t1'].type, 'task.claim-rejected', JSON.stringify(ws['b.claim t1']));
  assert.equal(ws['pub.done t1'].type, 'task.done');
  assert.equal(ws['b.claim t2'].type, 'task.claimed');
  assert.equal(ws['a.sees reopened t2'].type, 'task.opened');
  assert.equal(ws['a.claim t2'].type, 'task.claimed');
  assert.equal(ws['pub.done t2'].type, 'task.done');
  assert.deepEqual(runs.http, runs.ws);
});

// ------------------------------------------------------------------ 项目

const sample = () => ({ width: 1920, fps: 30, tracks: [{ id: 't1', name: 'A', clips: [{ id: 'c1', start: 0, end: 1 }] }, { id: 't2', name: 'B', clips: [] }], filters: [] });

async function projectScenario(t, kind) {
  const store = createMemoryStore();
  let clockRef = null;
  const now = () => clockRef.t;
  const env = await startEnv(t, kind, { modules: [projectModule({ store, now }), contentModule({ store, now })] });
  clockRef = env.clock;
  const out = [];
  const note = (label, m) => out.push([label, norm(m)]);
  const page = await env.connect({ user: 'alice', role: 'page', dev: 'pc' });
  const agent = await env.connect({ user: 'alice', role: 'agent', conv: 7, dev: 'pc' });
  const op = (c, opId, ops, extra = {}) => env.ask(c, { type: 'project.op', projectId: 'P', opId, ops, ...extra });

  note('page.open', await env.ask(page, { type: 'project.open', projectId: 'P' }));
  note('page.seed', await op(page, 'op-1', [{ op: 'set', path: '', value: sample() }], { session: 'tab-1' }));
  const read = await env.ask(agent, { type: 'project.open', projectId: 'P' });
  note('agent.open', read);
  env.clock.t = T0 + 5000;
  note('page.edit', await op(page, 'op-2', [{ op: 'set', path: '/tracks/@t1/clips/@c1/start', value: 0.5 }], { session: 'tab-1' }));
  note('agent.sees ops', await agent.next((m) => m.type === 'project.ops' && m.rev === 2));
  // 期望版本过时：stale，since 列出期间落地的改动
  note('agent.stale', await op(agent, 'op-3', [{ op: 'set', path: '/tracks/@t1/clips/@c1/end', value: 9 }], { expectRev: read.rev, session: 'conv-7' }));
  const reread = await env.ask(agent, { type: 'project.open', projectId: 'P' });
  note('agent.reopen', reread);
  env.clock.t = T0 + 6000;
  note('agent.write', await op(agent, 'op-4', [{ op: 'set', path: '/tracks/@t1/clips/@c1/end', value: 9 }], { expectRev: reread.rev, session: 'conv-7' }));
  note('page.sees agent ops', await page.next((m) => m.type === 'project.ops' && m.rev === 3));
  note('page.duplicate', await op(page, 'op-2', [{ op: 'set', path: '/fps', value: 99 }], { session: 'tab-1' }));
  note('final', await env.ask(page, { type: 'project.open', projectId: 'P' }));
  return out;
}

test('HT3 项目：提交 / 广播 / stale / 幂等在 WebSocket 与 HTTP 上逐条相同', { timeout: 30_000 }, async (t) => {
  const runs = {};
  for (const kind of KINDS) runs[kind] = await projectScenario(t, kind);
  const ws = Object.fromEntries(runs.ws);
  assert.equal(ws['page.seed'].type, 'project.op.ok');
  assert.equal(ws['agent.stale'].type, 'project.op.rejected');
  assert.equal(ws['agent.stale'].reason, 'stale');
  assert.equal(ws['agent.stale'].since.length, 1);
  assert.equal(ws['agent.write'].type, 'project.op.ok');
  assert.equal(ws['page.sees agent ops'].actor.role, 'agent');
  assert.equal(ws.final.rev, 3);
  assert.deepEqual(runs.http, runs.ws);
});

// ------------------------------------------------------------------ 内容库

async function contentScenario(t, kind) {
  const store = createMemoryStore();
  let clockRef = null;
  const now = () => clockRef.t;
  const env = await startEnv(t, kind, { modules: [contentModule({ store, now })] });
  clockRef = env.clock;
  const out = [];
  const note = (label, m) => out.push([label, norm(m)]);
  const watcher = await env.connect({ user: 'watcher' });
  const alice = await env.connect({ user: 'alice' });
  const bob = await env.connect({ user: 'bob' });

  note('watch', await env.ask(watcher, { type: 'content.watch', kinds: ['card-source'] }));
  note('alice.watch', await env.ask(alice, { type: 'content.watch', kinds: ['card-source'] }));
  // 第一次写入：watch 的连接都收到 content.changed（previousActor 为 null），写入方先收到回包
  note('alice.put', await env.ask(alice, { type: 'content.put', kind: 'card-source', key: 'cards/x', body: { src: 'v1' } }));
  note('watcher.changed 1', await watcher.next((m) => m.type === 'content.changed'));
  note('alice.changed 1', await alice.next((m) => m.type === 'content.changed'));
  env.clock.t = T0 + 1000;
  // 覆盖：previousActor 是被覆盖的那次写入；被覆盖方也在频道里看到
  note('bob.put', await env.ask(bob, { type: 'content.put', kind: 'card-source', key: 'cards/x', body: { src: 'v2' }, session: 'tab-b' }));
  note('watcher.changed 2', await watcher.next((m) => m.type === 'content.changed'));
  note('alice.changed 2', await alice.next((m) => m.type === 'content.changed'));
  note('bob quiet', (await bob.quiet((m) => m.type === 'content.changed', 100)).length);
  note('put other kind', await env.ask(alice, { type: 'content.put', kind: 'snapshot-manifest', key: 'm/1', body: [1, 2, 3] }));
  note('watcher quiet', (await watcher.quiet((m) => m.type === 'content.changed', 150)).length);
  note('get', await env.ask(watcher, { type: 'content.get', kind: 'card-source', key: 'cards/x' }));
  note('list', await env.ask(watcher, { type: 'content.list', kind: 'card-source' }));
  note('missing', await env.ask(watcher, { type: 'content.get', kind: 'card-source', key: 'nope' }));
  return out;
}

test('HT3 内容库：put / watch / get / list 在 WebSocket 与 HTTP 上逐条相同', { timeout: 30_000 }, async (t) => {
  const runs = {};
  for (const kind of KINDS) runs[kind] = await contentScenario(t, kind);
  const ws = Object.fromEntries(runs.ws);
  assert.equal(ws['alice.put'].type, 'content.stored');
  assert.equal(ws['watcher.changed 1'].type, 'content.changed');
  assert.equal(ws['watcher.changed 2'].rev, 2);
  assert.equal(ws['alice.changed 2'].previousActor.userId, 'alice');
  assert.equal(ws['bob quiet'], 0, '没 watch 的连接收不到');
  assert.equal(ws['watcher quiet'], 0, '没 watch 的 kind 不通知');
  assert.equal(ws.get.type, 'content.item');
  assert.deepEqual(runs.http, runs.ws);
});
