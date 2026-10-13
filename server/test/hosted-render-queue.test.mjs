/**
 * 托管方渲染服务的云端排队（0.7.18 第 3 项里「云端一次只有一个活跃项目并排队」那一半；验收映射 RS18-queue，
 * `docs/plan/account-binding-task.md`「新增验收映射」）。跑：npm test -- server/test/hosted-render-queue.test.mjs（不起浏览器、不起进程）
 *
 *   RQ1  两个都带用户卡的项目先后有活：第二个排队，不被拒、不回「忙 / 已满」；轮到了照常出图
 *   RQ2  云端 Agent 要看画面的请求优先于预渲染任务：隔离工作进程下一轮先给要看画面的项目；常驻工作进程先替排着的请求留出名额
 *   RQ3  让位要满五分钟：装着的项目空闲满五分钟才结束，别的项目在排队、有人等着看画面都不提前；一直有活的最多连续做五分钟
 *   RQ4  重启后排着的请求还在：队列落盘，新起的管理进程接回来按原来的次序做；正在做的那一个回到排队；出了结果的留着给调用方取
 *   RQ5  重试：渲染这一段每次最多一分钟，没成自动重试三次；次数到了回「这次没看成」；中途成了就成了；隔离工作进程起不来同样算次数
 *   RQ6  内存或磁盘吃紧：背压暂停、产物到了容量上限时排着等（记下等的原因），过去了接着做；登记的到了硬上限时调用方过一会儿再登记
 *   RQ7  撤回、没人来问、排队等到头：都有明确的结局，不占着队列
 *   RQ8  Agent 服务一侧的客户端：登记 → 一趟一趟问 → 出结果；渲染服务重启期间接着问；它不认识了就再登记；这一轮被停掉就撤回
 *   RQ9  代理口上的 /look/poll、/look/cancel：同样只认 Agent 服务的签名
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLook, createLookVerifier, LOOK_AUTH_HEADER, LOOK_DEFAULTS, LOOK_ERRORS } from '../hosted-render/look.mjs';
import { createRenderRequests } from '../hosted-render/render-requests.mjs';
import { createIsolation, isolationCandidates, ISOLATION_DEFAULTS } from '../hosted-render/isolation.mjs';
import { createBroker } from '../hosted-render/broker.mjs';
import { renderServiceConfig } from '../hosted-render/main.mjs';
import { generateServiceKeyPair, newInstanceId } from '../auth/service-identity.mjs';
import { createLookClient } from '../agent-service/look-client.mjs';

const P1 = `sp_${'a'.repeat(26)}`;
const P2 = `sp_${'b'.repeat(26)}`;
const P3 = `sp_${'c'.repeat(26)}`;
const CARDS = { 'src/cards/user/x.tsx': 1 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rid = (n) => `req-${String(n).padStart(4, '0')}-abcdefghijkl`;
const tmpDir = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-look-queue-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

/** 一套可拨的替身：目录、常驻与隔离工作进程的样子、被转发的请求；`dir` 给了就落盘 */
function kit({ limits = {}, dir = null, state: stateIn = null } = {}) {
  const state = stateIn ?? {
    projects: new Map([P1, P2, P3].map((id) => [id, { enabled: true, active: true, hosted: { agent: { enabled: true } } }])),
    paused: false, storagePaused: false,
    residentNodes: new Map([[P3, { projectId: P3, connected: true, cards: { state: 'none' } }]]),
    iso: { enabled: true, port: 7003, key: null, current: null, report: null, lastRun: null },
    wants: [], sent: [],
    reply: async () => ({ status: 200, json: { ok: true, frame: 1 } }),
  };
  const logs = [];
  const requests = createRenderRequests({ dir, log: (event, fields) => logs.push({ event, ...fields }) });
  const loaded = requests.load();
  const look = createLook({
    verify: (auth) => (typeof auth === 'string' && auth.startsWith('agent') ? { ok: true, service: 'agent', kid: 'k', instanceId: auth } : { ok: false, reason: 'signature' }),
    project: (id) => state.projects.get(id) ?? null,
    directoryReady: () => state.directoryReady !== false,
    paused: () => state.paused,
    storagePaused: () => state.storagePaused,
    resident: () => ({ port: 7000, key: 'resident-key', running: true, node: (id) => state.residentNodes.get(id) ?? null }),
    iso: () => state.iso,
    want: (projectId, until, o) => state.wants.push({ projectId, until, fresh: o?.fresh === true }),
    requests,
    fetch: async (url, init) => {
      state.sent.push({ url, projectId: JSON.parse(init.body).project?.id ?? null });
      const r = await state.reply(url, init);
      return { status: r.status, json: async () => r.json };
    },
    log: (event, fields) => logs.push({ event, ...fields }),
    limits: { pollMs: 10, cardWaitMs: 100, ...limits },
  });
  const msg = (projectId, extra = {}) => ({ projectId, path: '/api/vision/snapshot', body: { project: { id: projectId, tracks: [] }, t: 1 }, ...(projectId === P3 ? {} : { cards: CARDS }), ...extra });
  const call = (op, body, auth = 'agent-instance-1') => look[op]({ auth, bodyText: JSON.stringify(body) });
  /** 隔离工作进程这一轮装着这个项目、卡同步好了 */
  const isoRuns = (projectId) => {
    state.iso = {
      ...state.iso, key: `iso-key-${projectId.slice(3, 5)}`, current: { projectId, phase: 'running' }, lastRun: null,
      report: { queue: { nodes: [{ projectId, connected: true, cards: { state: 'synced' } }], cardCode: { settled: true }, cardSync: [{ projectId, records: CARDS, notices: [] }] } },
    };
  };
  return { state, look, requests, logs, loaded, msg, isoRuns, submit: (b, auth) => call('handle', b, auth), poll: (b, auth) => call('poll', b, auth), cancel: (b, auth) => call('cancel', b, auth) };
}

test('RQ1 两个都带用户卡的项目先后有活：第二个排队而不是被拒；轮到了照常出图；项目甲的内容绝不交给装着项目乙的隔离工作进程', async () => {
  const k = kit();
  k.isoRuns(P1);
  // 甲：隔离工作进程这一轮正是它，登记后马上轮到
  const a = await k.submit(k.msg(P1, { requestId: rid(1) }));
  assert.deepEqual([a.status, a.body.ok, a.body.state, a.body.queuePosition], [202, true, 'queued', 0]);
  const a2 = await k.poll({ requestId: rid(1), waitMs: 2000 });
  assert.deepEqual([a2.status, a2.body], [200, { ok: true, frame: 1 }]);

  // 乙：隔离工作进程装着甲。不拒、不回「忙」，排着
  const b = await k.submit(k.msg(P2, { requestId: rid(2) }));
  assert.deepEqual([b.status, b.body.state], [202, 'queued']);
  const b2 = await k.poll({ requestId: rid(2), waitMs: 150 });
  assert.deepEqual([b2.status, b2.body.ok, b2.body.state, b2.body.blockedReason], [202, true, 'queued', 'iso-other-project']);
  assert.equal(b2.body.look, undefined, '没有「忙 / 已满」的原因码');
  assert.ok(k.state.wants.some((w) => w.projectId === P2), '排着的时候一直登记着需求（隔离的编排据此把乙当候选）');
  assert.deepEqual(k.state.sent.map((s) => s.projectId), [P1], '乙的内容没有交给装着甲的隔离工作进程');
  assert.equal(k.look.status().queue.queued, 1);

  // 甲再来一个：它的项目正装着，不被排在前面的乙挡住
  const a3 = await k.submit(k.msg(P1, { requestId: rid(3) }));
  assert.equal(a3.status, 202);
  assert.equal((await k.poll({ requestId: rid(3), waitMs: 2000 })).status, 200);
  assert.equal((await k.poll({ requestId: rid(2), waitMs: 50 })).body.state, 'queued', '乙还排着');

  // 轮到乙（甲让位之后隔离工作进程装上乙）：照常出图
  k.isoRuns(P2);
  const b3 = await k.poll({ requestId: rid(2), waitMs: 2000 });
  assert.deepEqual([b3.status, b3.body.ok], [200, true]);
  assert.deepEqual(k.state.sent.map((s) => s.projectId), [P1, P1, P2]);
  const s = k.look.status();
  assert.deepEqual([s.served, s.failed, s.refused, s.queue.queued], [3, 0, 0, 0]);
  // 出了结果的再问一次还是那一份（调用方没收到回执就重问）
  assert.equal((await k.poll({ requestId: rid(2) })).status, 200);
  // 别的调用方凭 id 问不到、也占不了这个 id
  assert.equal((await k.poll({ requestId: rid(2) }, 'agent-instance-2')).status, 404);
  assert.equal((await k.submit(k.msg(P2, { requestId: rid(2) }), 'agent-instance-2')).status, 409);

  // 隔离工作进程的编排：两个带卡的项目都有活，一次只装一个，另一个在等（不是被拒）
  const calls = [];
  const iso = createIsolation({ nodeIdOf: (id) => `iso/${id}`, now: () => 0, runner: { async prepare(id) { calls.push(`prepare:${id}`); }, start(id) { calls.push(`start:${id}`); }, async stop() {}, async cleanup() {}, exited: () => false } });
  const cands = isolationCandidates({
    directory: [{ projectId: P1, enabled: true, active: true, members: true, since: 1 }, { projectId: P2, enabled: true, active: true, members: true, since: 2 }],
    residentNodes: [{ projectId: P1, cards: { state: 'some' }, pending: 2, pendingKey: 'a' }, { projectId: P2, cards: { state: 'some' }, pending: 2, pendingKey: 'b' }],
  });
  iso.tick({ candidates: cands });
  await iso.settled();
  iso.tick({ candidates: cands });
  await iso.settled();
  assert.deepEqual(calls, [`prepare:${P1}`, `start:${P1}`], '只起了一个');
  assert.deepEqual(iso.listing().map((p) => p.projectId), [P1], '清单里只有一个项目');
  assert.deepEqual(iso.status().waiting, [P2], '第二个记在等的名单里');
});

test('RQ2 云端 Agent 要看画面的请求优先于预渲染任务：下一轮先给要看画面的项目；常驻工作进程先替排着的请求留出名额', async () => {
  // 隔离工作进程：乙、丙先来的且只有预渲染任务，甲后来但有人要看画面——下一轮先起甲
  const directory = [P1, P2, P3].map((projectId, i) => ({ projectId, enabled: true, active: true, members: i > 0, since: 10 - i }));
  const residentNodes = [{ projectId: P2, cards: { state: 'some' }, pending: 9, pendingKey: 'b' }, { projectId: P3, cards: { state: 'some' }, pending: 9, pendingKey: 'c' }];
  const cands = isolationCandidates({ directory, residentNodes, looks: new Map([[P1, 1]]) });
  assert.deepEqual(cands.map((c) => [c.projectId, c.look === true]), [[P1, true], [P3, false], [P2, false]], '要看画面的排在只有预渲染任务的项目前面');
  const calls = [];
  const iso = createIsolation({ nodeIdOf: (id) => id, now: () => 0, runner: { async prepare(id) { calls.push(id); }, start() {}, async stop() {}, async cleanup() {}, exited: () => false } });
  iso.tick({ candidates: cands });
  await iso.settled();
  assert.deepEqual(calls, [P1]);

  // 常驻工作进程：排着的请求里有该它出的（这里被背压挡着），先替它留出一个并发名额；出图期间照旧让出
  const k = kit();
  k.state.paused = true;
  await k.submit(k.msg(P3, { requestId: rid(1) }));
  await sleep(40);
  assert.equal(k.look.reserveOn(), 'resident', '排着时就留名额：等它轮到时预渲染任务没有把名额占满');
  assert.equal(k.look.busyOn(), null);
  let during = null;
  k.state.reply = async () => { during = [k.look.busyOn(), k.look.busyProject()]; return { status: 200, json: { ok: true } }; };
  k.state.paused = false;
  assert.equal((await k.poll({ requestId: rid(1), waitMs: 2000 })).status, 200);
  assert.deepEqual(during, ['resident', P3]);
  assert.equal(k.look.reserveOn(), null, '没有排着的了：名额还给预渲染任务');
  // 带卡的项目的请求不占常驻工作进程的名额
  k.isoRuns(P2);
  await k.submit(k.msg(P1, { requestId: rid(2) }));
  await sleep(40);
  assert.equal(k.look.reserveOn(), null);
  assert.equal(k.look.wanted(P1), true, '排着的项目一直算有需求（隔离工作进程不因闲置结束）');
});

test('RQ3 让位要满五分钟：空闲满五分钟才结束，别的项目在排队、有人等着看画面都不提前；一直有活的最多连续做五分钟；到点正闲着的等它闲满', async () => {
  assert.equal(ISOLATION_DEFAULTS.IDLE_MS, 5 * 60_000);
  assert.equal(ISOLATION_DEFAULTS.SLICE_MS, 5 * 60_000);
  assert.equal(ISOLATION_DEFAULTS.LOOK_SLICE_MS, undefined, '有人等着看画面时 45 秒就换的旧规矩已取消');
  assert.equal(renderServiceConfig({}).isoIdleMs, 5 * 60_000, '管理进程的缺省也是五分钟');
  const MIN = 60_000;
  let at = 0;
  const calls = [];
  const iso = createIsolation({
    nodeIdOf: (id) => id, now: () => at,
    runner: { async prepare(id) { calls.push(`prepare:${id.slice(3, 4)}`); }, start() {}, async stop(reason) { calls.push(`stop:${reason}`); }, async cleanup() {}, exited: () => false },
  });
  const settle = async () => { await iso.settled(); await sleep(0); };
  const report = (projectId, extra = {}) => ({ at, queue: { nodes: [{ projectId, held: [], running: [], claimable: 0, claimed: 1, ...extra }] } });
  const A = { projectId: P1, members: true, pending: 1, pendingKey: 'a' };
  const B = { projectId: P2, members: true, pending: 1, pendingKey: 'b' };
  const Blook = { ...B, look: true, pendingKey: 'b|look:1' };
  const noLooks = { wanted: () => false, busy: null };

  // 甲装上、做了一会儿活，然后闲下来；乙在排队，而且有人等着看乙的画面
  iso.tick({ candidates: [A] });
  await settle();
  iso.tick({ candidates: [A], report: report(P1, { held: ['t'] }), looks: noLooks });
  at = 1 * MIN;
  iso.tick({ candidates: [Blook], report: report(P1, { held: ['t'] }), looks: noLooks });
  assert.equal(iso.current.phase, 'running');
  // 从 1 分钟起闲着。闲 45 秒（旧的看画面切换）、60 秒（旧的闲置回收）、4 分 59 秒：都不让位
  for (const idle of [45_000, 60_000, 3 * MIN, 5 * MIN - 1000]) {
    at = 1 * MIN + idle;
    iso.tick({ candidates: [Blook], report: report(P1), looks: noLooks });
    await settle();
    assert.equal(iso.current?.projectId, P1, `闲了 ${idle / 1000} 秒：不让位（乙在排队、有人等着看画面也一样）`);
    assert.equal(iso.current.phase, 'running');
  }
  // 闲满五分钟：让位，下一拍起乙
  at = 6 * MIN;
  iso.tick({ candidates: [Blook], report: report(P1), looks: noLooks });
  await settle();
  assert.deepEqual(calls, ['prepare:a', 'stop:idle']);
  assert.equal(iso.status().lastRun.reason, 'idle');
  iso.tick({ candidates: [Blook] });
  await settle();
  assert.equal(iso.current.projectId, P2);

  // 乙一直有活、甲在等：做满五分钟才排空让位（不是无限占着）
  const t0 = at;
  iso.tick({ candidates: [A], report: report(P2, { held: ['x'] }), looks: noLooks });
  at = t0 + 5 * MIN - 1000;
  iso.tick({ candidates: [A], report: report(P2, { held: ['x'] }), looks: noLooks });
  assert.equal(iso.current.phase, 'running');
  at = t0 + 5 * MIN;
  iso.tick({ candidates: [A], report: report(P2, { held: ['x'] }), looks: noLooks });
  assert.equal(iso.current.phase, 'draining');
  iso.tick({ candidates: [A], report: report(P2), looks: noLooks });
  await settle();
  assert.equal(calls.at(-1), 'stop:rotated');

  // 到了五分钟而此刻正闲着的：不按「连续做满」换，等它闲满五分钟
  iso.tick({ candidates: [A] });
  await settle();
  const t1 = at;
  iso.tick({ candidates: [A, B], report: report(P1, { held: ['y'] }), looks: noLooks });
  at = t1 + 4 * MIN; // 做到第 4 分钟
  iso.tick({ candidates: [B], report: report(P1, { held: ['y'] }), looks: noLooks });
  at = t1 + 5 * MIN + 1000; // 第 4 分钟起闲着；装上已经过了五分钟，但只闲了一分钟
  iso.tick({ candidates: [B], report: report(P1), looks: noLooks });
  assert.equal(iso.current.phase, 'running', '装上满五分钟但只闲了一分钟：不让位');
  at = t1 + 9 * MIN - 1000;
  iso.tick({ candidates: [B], report: report(P1), looks: noLooks });
  assert.equal(iso.current.phase, 'running');
  at = t1 + 9 * MIN;
  iso.tick({ candidates: [B], report: report(P1), looks: noLooks });
  await settle();
  assert.equal(calls.at(-1), 'stop:idle', '闲满五分钟才让位');
});

test('RQ4 重启后排着的请求还在：队列落盘，新起的管理进程接回来按原来的次序做；正在做的回到排队；出了结果的留着给调用方取', async (t) => {
  const dir = tmpDir(t);
  const k1 = kit({ dir });
  k1.isoRuns(P1);
  let release;
  // 一个已经出了结果的、一个正在做的、两个排着的（乙的在前，丙的在后）
  k1.state.reply = async () => ({ status: 200, json: { ok: true, n: 0 } });
  await k1.submit(k1.msg(P1, { requestId: rid(0) }));
  assert.equal((await k1.poll({ requestId: rid(0), waitMs: 2000 })).status, 200);
  k1.state.reply = () => new Promise((resolve) => { release = () => resolve({ status: 200, json: { ok: true } }); });
  await k1.submit(k1.msg(P1, { requestId: rid(1) }));
  await k1.submit(k1.msg(P2, { requestId: rid(2) }));
  await sleep(60);
  k1.state.paused = true;
  await k1.submit(k1.msg(P3, { requestId: rid(3) }));
  await sleep(60);
  assert.equal(k1.requests.running()?.id, rid(1));
  assert.deepEqual(k1.requests.queued().map((e) => e.id), [rid(2), rid(3)]);
  // 盘上：请求体 0600 落着；出了结果的那一个请求体已删、结果留着
  const names = fs.readdirSync(dir).sort();
  assert.deepEqual(names, [0, 1, 2, 3].flatMap((n) => (n === 0 ? [`${rid(0)}.state.json`] : [`${rid(n)}.req.json`, `${rid(n)}.state.json`])).sort());
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, `${rid(2)}.req.json`)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, `${rid(2)}.req.json`), 'utf8')).body.project.id, P2);

  // 管理进程没了（不走收尾）：内存里的全丢。新起一个，读同一个目录
  k1.look.close();
  const k2 = kit({ dir });
  assert.deepEqual(k2.loaded, { restored: 3, results: 1, dropped: 0 });
  // 管理进程刚起来、目录清单还没拿到：这时「目录里没有这个项目」不作数，接回来的请求排着等，不被当成项目不在了
  const real = k2.state.projects;
  k2.state.projects = new Map();
  k2.state.directoryReady = false;
  k2.look.resume();
  await sleep(60);
  assert.deepEqual(k2.look.status().queue.blocked, { directory: 3 });
  k2.state.projects = real;
  k2.state.directoryReady = true;
  assert.deepEqual(k2.requests.queued().map((e) => [e.id, e.projectId, e.attempts]), [[rid(1), P1, 0], [rid(2), P2, 0], [rid(3), P3, 0]], '次序不变；正在做的那一个回到排队，那一次不算重试次数');
  // 调用方接着问：出过结果的那一份还在；排着的还是排着（隔离工作进程还没起来）
  assert.deepEqual((await k2.poll({ requestId: rid(0) })).body, { ok: true, n: 0 });
  k2.look.resume();
  const p1 = await k2.poll({ requestId: rid(1), waitMs: 100 });
  assert.deepEqual([p1.status, p1.body.state, p1.body.blockedReason], [202, 'queued', 'iso-loading']);
  assert.ok(k2.state.wants.some((w) => w.projectId === P1) && k2.state.wants.some((w) => w.projectId === P2), '接回来的请求重新登记需求：隔离工作进程会为它们起来');
  // 丙（不带卡，常驻工作进程出）马上做完；隔离工作进程先后装上甲、乙，各自做完
  assert.deepEqual((await k2.poll({ requestId: rid(3), waitMs: 2000 })).body, { ok: true, frame: 1 });
  k2.isoRuns(P1);
  assert.equal((await k2.poll({ requestId: rid(1), waitMs: 2000 })).status, 200);
  k2.isoRuns(P2);
  assert.equal((await k2.poll({ requestId: rid(2), waitMs: 2000 })).status, 200);
  assert.deepEqual(k2.state.sent.map((s) => s.projectId), [P3, P1, P2]);
  assert.ok(k2.logs.some((l) => l.event === 'look.done' && l.restored === true), '日志里看得出这是重启后接回来的');
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.req.json')), [], '做完的请求体都删了');
  release?.();

  // 调用方取走过的结果只再留一小会儿（它没收到回执会重问），之后清掉：带图的结果不在内存和盘上攒着
  let clock = 0;
  const kept = createRenderRequests({ now: () => clock, limits: { deliveredKeepMs: 1000, resultKeepMs: 100_000 } });
  const one = kept.add({ id: rid(7), owner: 'o', projectId: P1, path: '/api/vision/snapshot', body: { a: 1 } }).entry;
  const two = kept.add({ id: rid(8), owner: 'o', projectId: P1, path: '/api/vision/snapshot', body: { a: 1 } }).entry;
  for (const e of [one, two]) kept.finish(e, 'done', { status: 200, body: { ok: true } });
  kept.delivered(one);
  clock = 999; kept.sweep();
  assert.ok(kept.get(rid(7), 'o') && kept.get(rid(8), 'o'));
  clock = 1000; kept.sweep();
  assert.deepEqual([kept.get(rid(7), 'o'), !!kept.get(rid(8), 'o')], [null, true], '取走过的清了，没取走的留到保留期');
  clock = 100_000; kept.sweep();
  assert.equal(kept.get(rid(8), 'o'), null);

  // 结果过了保留期：下次起来清掉
  const k3 = createRenderRequests({ dir, now: () => Date.now() + 11 * 60_000 });
  assert.deepEqual(k3.load(), { restored: 0, results: 0, dropped: 4 });
  assert.deepEqual(fs.readdirSync(dir), []);
  // 落盘失败（目录写不了）：不拒绝，只在内存里排，日志里明说
  const file = path.join(dir, 'not-a-dir');
  fs.writeFileSync(file, 'x');
  const logs = [];
  const bad = createRenderRequests({ dir: path.join(file, 'sub'), log: (event, f) => logs.push({ event, ...f }) });
  const added = bad.add({ id: rid(9), owner: 'o', projectId: P1, path: '/api/vision/snapshot', body: { a: 1 }, persist: true });
  assert.deepEqual([added.created, added.entry.persisted, added.entry.state], [true, false, 'queued']);
  assert.ok(logs.some((l) => l.event === 'requests.persist-failed'));
  // 同步等的调用法不落盘（连接随重启就断了）
  const mem = kit({ dir });
  const sync = await mem.submit(mem.msg(P3));
  assert.equal(sync.status, 200);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('sync-')), []);
});

test('RQ5 重试：渲染这一段每次最多一分钟，没成自动重试三次；次数到了回「这次没看成」；中途成了就成了；隔离工作进程起不来同样算次数', async () => {
  assert.deepEqual([LOOK_DEFAULTS.attemptMs, LOOK_DEFAULTS.retries], [60_000, 3], '2026-10-09 用户定：每次一分钟，允许三次重试');
  const hang = (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' }))));

  // 一直不出图：试 1 + 3 次，每次到时限，然后回「这次没看成」
  const k = kit({ limits: { attemptMs: 80 } });
  k.state.reply = hang;
  const t0 = Date.now();
  await k.submit(k.msg(P3, { requestId: rid(1) }));
  const out = await k.poll({ requestId: rid(1), waitMs: 5000 });
  const took = Date.now() - t0;
  assert.deepEqual([out.status, out.body.ok, out.body.look, out.body.error], [504, false, 'timeout', LOOK_ERRORS.timeout]);
  assert.equal(k.state.sent.length, 4, '第一次之外再重试三次');
  assert.ok(took >= 4 * 80 - 20 && took < 2000, `四次各等满时限：${took} ms`);
  assert.deepEqual(k.logs.filter((l) => l.event === 'look.retry').map((l) => [l.why, l.attempts]), [['timeout', 1], ['timeout', 2], ['timeout', 3]]);
  const done = k.logs.find((l) => l.event === 'look.done');
  assert.deepEqual([done.state, done.attempts, done.look], ['failed', 4, 'timeout']);
  assert.equal(k.look.status().retried, 3);

  // 前两次没成、第三次成了：调用方只看到成了
  const k2 = kit({ limits: { attemptMs: 80 } });
  let n = 0;
  k2.state.reply = (url, init) => { n += 1; return n < 3 ? (n === 1 ? hang(url, init) : Promise.reject(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } }))) : Promise.resolve({ status: 200, json: { ok: true, n } }); };
  await k2.submit(k2.msg(P3, { requestId: rid(2) }));
  assert.deepEqual((await k2.poll({ requestId: rid(2), waitMs: 5000 })).body, { ok: true, n: 3 });
  assert.deepEqual(k2.logs.filter((l) => l.event === 'look.retry').map((l) => l.why), ['timeout', 'error']);
  // 重试的那一个排在后来的请求前面（次序不变）
  // 工作进程一直出错：次数到了明说出错
  const k3 = kit();
  k3.state.reply = async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
  await k3.submit(k3.msg(P3, { requestId: rid(3) }));
  const f = await k3.poll({ requestId: rid(3), waitMs: 5000 });
  assert.deepEqual([f.status, f.body.look], [502, 'failed']);
  assert.match(f.body.error, /^这次没看成.*ECONNREFUSED/);
  assert.equal(k3.state.sent.length, 4);
  // 工作进程自己的回答（片段不存在）是结果，不重试
  const k4 = kit();
  k4.state.reply = async () => ({ status: 404, json: { ok: false, error: '时间轴上没有 id 为 c9 的片段。' } });
  await k4.submit(k4.msg(P3, { requestId: rid(4) }));
  assert.deepEqual((await k4.poll({ requestId: rid(4), waitMs: 2000 })).body, { ok: false, error: '时间轴上没有 id 为 c9 的片段。' });
  assert.equal(k4.state.sent.length, 1);

  // 排队的时间不算在一分钟里：排了比 attemptMs 久得多，轮到了照样有完整的一次
  const k5 = kit({ limits: { attemptMs: 80 } });
  k5.state.paused = true;
  await k5.submit(k5.msg(P3, { requestId: rid(5) }));
  await sleep(300);
  k5.state.paused = false;
  assert.equal((await k5.poll({ requestId: rid(5), waitMs: 2000 })).status, 200);
  assert.equal(k5.logs.filter((l) => l.event === 'look.retry').length, 0);
  assert.ok(k5.logs.find((l) => l.event === 'look.done').queuedMs >= 250, '排队的时间单独记');

  // 为它起的隔离工作进程没起成（内存超限、起不来）：算一次，再要一轮；四次都没起成才回「没起来」
  const k6 = kit();
  await k6.submit(k6.msg(P1, { requestId: rid(6) }));
  for (let i = 1; i <= 4; i += 1) {
    await sleep(40);
    const p = await k6.poll({ requestId: rid(6) });
    if (i <= 3) assert.deepEqual([p.status, p.body.attempts], [202, i - 1], `第 ${i} 轮之前还排着`);
    k6.state.iso = { ...k6.state.iso, current: null, lastRun: { projectId: P1, reason: i % 2 ? 'oom' : 'start-timeout', at: Date.now() } };
  }
  const g = await k6.poll({ requestId: rid(6), waitMs: 2000 });
  assert.deepEqual([g.status, g.body.look, g.body.error], [503, 'iso-failed', LOOK_ERRORS['iso-failed']]);
  assert.equal(k6.state.wants.filter((w) => w.fresh).length, 3, '每次重试都当成一批新的需求（隔离的编排不按「同一批先不再起」跳过）');
  assert.equal(k6.state.sent.length, 0);
});

test('RQ6 内存或磁盘吃紧：背压暂停、产物到了容量上限时排着等并记下原因，过去了接着做；登记的到了硬上限时不算没看成', async (t) => {
  const k = kit({ dir: tmpDir(t) });
  k.isoRuns(P1);
  // 背压暂停（内存低、负载高、文档服务慢）：带卡的、不带卡的都排着，不回忙
  k.state.paused = true;
  for (const [i, p] of [[1, P1], [2, P3]]) assert.equal((await k.submit(k.msg(p, { requestId: rid(i) }))).status, 202);
  await sleep(60);
  assert.deepEqual(k.look.status().queue.blocked, { backpressure: 2 });
  assert.equal(k.state.sent.length, 0, '暂停期间一个都没转');
  assert.ok(k.state.wants.some((w) => w.projectId === P1), '暂停期间需求照样登记着（隔离工作进程不因闲置结束）');
  k.state.paused = false;
  assert.equal((await k.poll({ requestId: rid(1), waitMs: 2000 })).status, 200);
  assert.equal((await k.poll({ requestId: rid(2), waitMs: 2000 })).status, 200);

  // 产物到了容量上限（素材服务回 507）：要写产物的 bake_card 排着等；看一帧不写产物，照常出
  k.state.storagePaused = true;
  await k.submit(k.msg(P3, { requestId: rid(3), path: '/api/vision/bake' }));
  await k.submit(k.msg(P3, { requestId: rid(4) }));
  assert.equal((await k.poll({ requestId: rid(4), waitMs: 2000 })).status, 200);
  const held = await k.poll({ requestId: rid(3), waitMs: 60 });
  assert.deepEqual([held.status, held.body.state, held.body.blockedReason], [202, 'queued', 'storage-pressure']);
  k.state.storagePaused = false;
  assert.equal((await k.poll({ requestId: rid(3), waitMs: 2000 })).status, 200);
  assert.deepEqual([k.look.status().failed, k.look.status().refused], [0, 0], '吃紧期间没有一个请求被记成失败或被拒');

  // 登记的到了硬上限（防磁盘被请求体占满）：回 503，调用方过一会儿再登记（RQ8 里验它不把这交给模型）
  const small = createLook({
    verify: () => ({ ok: true, service: 'agent', kid: 'k', instanceId: 'agent-1' }), project: () => ({ enabled: true, active: true }), paused: () => true,
    resident: () => ({ port: 1, key: 'k', running: true, node: () => null }), iso: () => ({ enabled: true, current: null }),
    requests: createRenderRequests({ limits: { maxQueued: 2 } }), limits: { pollMs: 10 },
  });
  const ask = (n) => small.handle({ auth: 'a', bodyText: JSON.stringify({ ...k.msg(P3), requestId: rid(n) }) });
  assert.deepEqual([(await ask(1)).status, (await ask(2)).status, (await ask(3)).status, (await ask(1)).status], [202, 202, 503, 202], '第三个登记不进；已登记的重发不占新名额');
  small.close();
});

test('RQ7 撤回、没人来问、排队等到头：都有明确的结局，不占着队列', async () => {
  // 撤回排着的
  const k = kit({ limits: { orphanMs: 150, maxQueueMs: 400 } });
  k.state.paused = true;
  await k.submit(k.msg(P3, { requestId: rid(1) }));
  const c = await k.cancel({ requestId: rid(1) });
  assert.deepEqual([c.status, c.body], [200, { ok: true, requestId: rid(1), state: 'cancelled' }]);
  const after = await k.poll({ requestId: rid(1) });
  assert.deepEqual([after.status, after.body.look], [499, 'cancelled']);
  assert.equal((await k.cancel({ requestId: rid(8) })).status, 404);
  assert.equal(k.look.status().queue.queued, 0);

  // 调用方不再来问（它自己没了）：撤掉。一直有人问的不撤
  await k.submit(k.msg(P3, { requestId: rid(2) }));
  await k.submit(k.msg(P3, { requestId: rid(3) }));
  for (let i = 0; i < 6; i += 1) { await sleep(50); await k.poll({ requestId: rid(3) }); }
  assert.deepEqual(k.requests.queued().map((e) => e.id), [rid(3)], '没人问的那个撤了，有人问的还排着');
  assert.ok(k.logs.some((l) => l.event === 'look.orphaned'));

  // 排队等到头（防呆上限）：如实回「这次没看成」
  let last;
  for (let i = 0; i < 20 && (last = await k.poll({ requestId: rid(3), waitMs: 50 })).status === 202; i += 1) { /* 一直问着 */ }
  assert.deepEqual([last.status, last.body.ok, last.body.look], [504, false, 'timeout']);
  assert.match(last.body.error, /^这次没看成/);
  assert.equal(k.state.sent.length, 0);

  // 撤回正在做的：掐掉那一次，后面排着的接着做
  const k2 = kit();
  let aborted = false;
  k2.state.reply = (_u, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => { aborted = true; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }));
  await k2.submit(k2.msg(P3, { requestId: rid(4) }));
  await k2.submit(k2.msg(P3, { requestId: rid(5) }));
  await sleep(50);
  assert.equal(k2.requests.running()?.id, rid(4));
  k2.state.reply = async () => ({ status: 200, json: { ok: true } });
  assert.equal((await k2.cancel({ requestId: rid(4) })).body.state, 'cancelled');
  assert.equal((await k2.poll({ requestId: rid(5), waitMs: 2000 })).status, 200);
  assert.equal(aborted, true);
  assert.equal(k2.logs.filter((l) => l.event === 'look.retry').length, 0, '撤回的不重试');

  // 排着的时候项目的开关被关掉：结掉（不是一直排着），原因是开关
  const k3 = kit();
  k3.state.paused = true;
  await k3.submit(k3.msg(P3, { requestId: rid(6) }));
  k3.state.projects.get(P3).enabled = false;
  const off = await k3.poll({ requestId: rid(6), waitMs: 2000 });
  assert.deepEqual([off.status, off.body.look], [403, 'service-disabled']);
  // 形状不对的 id
  assert.equal((await k3.submit(k3.msg(P3, { requestId: '../x' }))).status, 400);
  assert.equal((await k3.poll({ requestId: 'short' })).status, 400);
  assert.equal((await k3.poll({ requestId: rid(6) }, 'forged')).status, 401);
});

function keyOf(service) {
  const pair = generateServiceKeyPair();
  return { service, kid: pair.kid, priv: pair.priv, pub: pair.pub, instanceId: newInstanceId(), instanceName: `${service}-test` };
}

test('RQ8 Agent 服务一侧的客户端：登记 → 一趟一趟问 → 出结果；渲染服务重启期间接着问；它不认识了就再登记；登记满了过一会儿再来；被停掉就撤回', async () => {
  const key = keyOf('agent');
  const verify = createLookVerifier({ registry: { get: (n) => (n === 'agent' ? { role: 'agent', keys: [{ kid: key.kid, pub: key.pub }] } : null) } });
  const sent = [];
  /** 按次序回：每项是 `{ status, json }` 或要抛的错 */
  const script = [];
  const logs = [];
  const client = createLookClient({
    url: 'http://127.0.0.1:5399', key, limits: { backoffMs: [5], reconnectMs: 400 }, log: (event, f) => logs.push({ event, ...f }),
    fetch: async (url, init) => {
      sent.push({ path: new URL(url).pathname, body: JSON.parse(init.body), auth: init.headers[LOOK_AUTH_HEADER], text: init.body });
      const next = script.shift() ?? { status: 200, json: { ok: true, frame: 1 } };
      if (next instanceof Error) throw next;
      // 挂着不回，直到调用方自己掐掉
      if (next.hang) await new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted'))));
      return { status: next.status, json: async () => next.json };
    },
  });
  const post = client.forProject(P1, { cards: () => CARDS });
  const down = () => Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  const queued = (extra = {}) => ({ status: 202, json: { ok: true, state: 'queued', queuePosition: 1, ...extra } });

  // 登记（202）→ 问两趟还排着 → 出结果
  script.push(queued(), queued({ blockedReason: 'iso-other-project' }), queued({ state: 'running', queuePosition: 0 }), { status: 200, json: { ok: true, t: 1 } });
  assert.deepEqual(await post('/api/vision/snapshot', { project: { tracks: [] }, t: 1 }), { ok: true, t: 1 });
  assert.deepEqual(sent.map((s) => s.path), ['/look', '/look/poll', '/look/poll', '/look/poll']);
  const id = sent[0].body.requestId;
  assert.deepEqual([sent[0].body.projectId, sent[0].body.cards], [P1, CARDS]);
  assert.ok(sent.slice(1).every((s) => s.body.requestId === id && s.body.waitMs > 0 && s.body.project === undefined), '问的时候只带 id，不再带项目内容');
  assert.ok(sent.every((s) => verify(s.auth, s.text).ok), '每一趟都带服务私钥的签名（各自的一次性随机数）');
  assert.equal(logs.filter((l) => l.event === 'agent.look.queued').length, 1);

  // 渲染服务重启：登记后连不上了几趟，起来后请求还在 → 接着问到出结果。模型看不到中间的事
  sent.length = 0;
  script.push(queued(), down(), down(), down(), queued(), { status: 200, json: { ok: true, t: 2 } });
  assert.deepEqual(await post('/api/vision/snapshot', { project: { tracks: [] } }), { ok: true, t: 2 });
  assert.deepEqual(sent.map((s) => s.path), ['/look', '/look/poll', '/look/poll', '/look/poll', '/look/poll', '/look/poll']);
  assert.ok(logs.some((l) => l.event === 'agent.look.reconnected'));

  // 起来后它不认识这个请求（落盘失败）：拿同一个 id 照原样再登记
  sent.length = 0;
  script.push(queued(), { status: 404, json: { ok: false, error: 'unknown-request' } }, queued(), { status: 200, json: { ok: true, t: 3 } });
  assert.deepEqual(await post('/api/vision/snapshot', { project: { tracks: [] } }), { ok: true, t: 3 });
  assert.deepEqual(sent.map((s) => s.path), ['/look', '/look/poll', '/look', '/look/poll']);
  assert.equal(sent[2].body.requestId, sent[0].body.requestId);
  assert.deepEqual(sent[2].body.body, sent[0].body.body);

  // 登记的到了上限（503 busy）：过一会儿再登记，不抛给模型
  sent.length = 0;
  script.push({ status: 503, json: { ok: false, look: 'busy', error: LOOK_ERRORS.busy } }, { status: 503, json: { ok: false, look: 'busy', error: LOOK_ERRORS.busy } }, queued(), { status: 200, json: { ok: true, t: 4 } });
  assert.deepEqual(await post('/api/vision/snapshot', { project: { tracks: [] } }), { ok: true, t: 4 });
  assert.deepEqual(sent.map((s) => s.path), ['/look', '/look', '/look', '/look/poll']);

  // 重试用完、排队等到头：渲染服务说「这次没看成」，原话抛出，这里不再重试
  sent.length = 0;
  script.push(queued(), { status: 504, json: { ok: false, look: 'timeout', error: LOOK_ERRORS.timeout } });
  await assert.rejects(() => post('/api/vision/snapshot', { project: { tracks: [] } }), (err) => err.message === LOOK_ERRORS.timeout);
  assert.equal(sent.length, 2);

  // 这一轮被停掉：撤回排着的请求
  sent.length = 0;
  const ac = new AbortController();
  script.push(queued(), queued(), { hang: true });
  const pending = post('/api/vision/snapshot', { project: { tracks: [] } }, { signal: ac.signal });
  await sleep(20);
  ac.abort(new Error('stopped'));
  await assert.rejects(pending);
  await sleep(20);
  assert.equal(sent.at(-1).path, '/look/cancel');
  assert.equal(sent.at(-1).body.requestId, sent[0].body.requestId);

  // 这一轮的信号交在 forProject 上（账号任务的执行器这样接）：它一响同样撤回
  sent.length = 0;
  const run = new AbortController();
  script.push(queued(), { hang: true });
  const viaRun = client.forProject(P2, { signal: run.signal })('/api/vision/snapshot', { project: { tracks: [] } });
  await sleep(20);
  run.abort(new Error('run-fenced'));
  await assert.rejects(viaRun);
  await sleep(20);
  assert.deepEqual([sent.at(-1).path, sent.at(-1).body.requestId], ['/look/cancel', sent[0].body.requestId]);
  script.length = 0;

  // 一直连不上（过了重连的时限）才放弃
  sent.length = 0;
  for (let i = 0; i < 200; i += 1) script.push(down());
  await assert.rejects(() => post('/api/vision/snapshot', { project: { tracks: [] } }), /这次没看成：连不上/);
  assert.ok(sent.length > 3, '中间一直在重连');
  const d = client.describe();
  assert.ok(d.ok >= 4 && d.reconnects >= 3 && d.resubmits === 1 && d.cancelled === 2);
});

test('RQ9 代理口上的 /look/poll、/look/cancel：只认 Agent 服务的签名；浏览器形状的请求 403；工作进程的口令问不到；没给口子就没有这两条路', async () => {
  const seen = [];
  const look = {
    limits: { maxBodyBytes: 1 << 20 },
    async handle(i) { seen.push(['handle', i.bodyText]); return { status: 202, body: { ok: true, state: 'queued' } }; },
    async poll(i) { seen.push(['poll', i.bodyText]); return i.auth === 'sig' ? { status: 200, body: { ok: true, frame: 1 } } : { status: 401, body: { ok: false, error: 'unauthorized' } }; },
    async cancel(i) { seen.push(['cancel', i.bodyText]); return { status: 200, body: { ok: true, state: 'cancelled' } }; },
  };
  const broker = createBroker({ key: 'worker-key', listing: () => ({ projects: [] }), ticket: async () => ({ ticket: 't' }), report() {}, status: () => ({}), look });
  const addr = await broker.listen(0);
  const post = async (p, { headers = {}, body = '{}' } = {}) => { const r = await fetch(`http://127.0.0.1:${addr.port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body }); return [r.status, await r.json()]; };
  try {
    assert.deepEqual(await post('/look', { headers: { [LOOK_AUTH_HEADER]: 'sig' }, body: '{"requestId":"x"}' }), [202, { ok: true, state: 'queued' }]);
    assert.deepEqual(await post('/look/poll', { headers: { [LOOK_AUTH_HEADER]: 'sig' }, body: '{"requestId":"x"}' }), [200, { ok: true, frame: 1 }]);
    assert.deepEqual(await post('/look/cancel', { headers: { [LOOK_AUTH_HEADER]: 'sig' }, body: '{"requestId":"x"}' }), [200, { ok: true, state: 'cancelled' }]);
    assert.deepEqual(seen, [['handle', '{"requestId":"x"}'], ['poll', '{"requestId":"x"}'], ['cancel', '{"requestId":"x"}']], '请求体原样交给核对');
    assert.equal((await post('/look/poll', { headers: { authorization: 'Bearer worker-key' } }))[0], 401, '工作进程的口令问不到结果');
    const n = seen.length;
    assert.equal((await post('/look/poll', { headers: { [LOOK_AUTH_HEADER]: 'sig', origin: 'http://127.0.0.1:5401' } }))[0], 403);
    assert.equal((await post('/look/cancel', { headers: { [LOOK_AUTH_HEADER]: 'sig', 'sec-fetch-site': 'same-origin' } }))[0], 403);
    assert.equal((await post('/look/poll', { headers: { [LOOK_AUTH_HEADER]: 'sig' }, body: JSON.stringify({ x: 'y'.repeat(5000) }) }))[0], 413, '问结果的请求体只有一个 id，不给大上限');
    assert.equal(seen.length, n);
  } finally {
    await broker.close();
  }
  const old = createBroker({ key: 'worker-key', listing: () => ({ projects: [] }), ticket: async () => ({ ticket: 't' }), report() {}, status: () => ({}), look: { limits: look.limits, handle: look.handle } });
  const a2 = await old.listen(0);
  try {
    const r = await fetch(`http://127.0.0.1:${a2.port}/look/poll`, { method: 'POST', headers: { [LOOK_AUTH_HEADER]: 'sig' }, body: '{}' });
    assert.equal(r.status, 404);
  } finally {
    await old.close();
  }
  // 配置：队列的目录缺省在数据目录下，可另给；时限缺省照用户定的
  const c = renderServiceConfig({ PROMPTCUT_RENDER_DATA: path.join(os.tmpdir(), 'pc-render-x') });
  assert.equal(c.lookQueueDir, path.join(os.tmpdir(), 'pc-render-x', 'look-queue'));
  assert.deepEqual([c.lookAttemptMs, c.lookRetries, c.lookMaxQueueMs, c.lookOrphanMs], [60_000, 3, 30 * 60_000, 120_000]);
  assert.equal(renderServiceConfig({ PROMPTCUT_RENDER_LOOK_QUEUE: path.join(os.tmpdir(), 'q') }).lookQueueDir, path.join(os.tmpdir(), 'q'));
});
