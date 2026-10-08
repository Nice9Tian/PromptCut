/**
 * 托管方渲染服务的「看画面」口子（契约 `docs/plan/hosted-render-contract.md` 第 8a 节；`server/hosted-render/look.mjs`）。
 *
 * HR38 认身份：只认登记表里角色是 agent 的服务 `agent` 的签名；别的服务、撤掉的公钥、改过的请求体、过期的时刻、重放、没有登记表都进不来。
 * HR39 路由：没有卡片源码的项目走常驻工作进程；有卡片源码的只走隔离工作进程，而且要等它这一轮正是这个项目、卡片同步到位；
 *      绝不把一个项目的内容交给正在跑另一个项目的隔离工作进程；项目不在目录里、渲染节点或云端 Agent 的开关关着、整条路关着时要不到。
 * HR40 并发与时限：同一时刻只转发一个，其余排队，排满回忙；背压暂停时不接；到时限回「这次没看成」，不挂着。
 * HR41 隔离工作进程的编排：要看画面的项目没有任务等着也算候选并排最前；出图的半路上不因闲置、轮换而结束。
 * HR42 代理口上的 `/look`：浏览器形状的请求 403；工作进程的口令要不到画面；Agent 服务的签名要不到清单与票据。
 * HR43 工作进程的页面请求闸：看画面的那批接口，Node 一侧的请求也要带这个工作进程自己的口令；浏览器发来的照旧 403。
 * CA-LOOK-01 Agent 服务一侧的客户端：地址只许回环；项目由宿主定；「这次没看成」原话抛出；云端不存可视化记录。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  createLook, createLookVerifier, signLookRequest, lookPurpose, LOOK_AUTH_HEADER, LOOK_KEY_HEADER, LOOK_ROUTES, LOOK_ERRORS,
} from '../hosted-render/look.mjs';
import { createBroker } from '../hosted-render/broker.mjs';
import { createIsolation, isolationCandidates } from '../hosted-render/isolation.mjs';
import { installHostedGate, isLookPath } from '../hosted-render/vite-gate.mjs';
import { renderServiceConfig } from '../hosted-render/main.mjs';
import { generateServiceKeyPair, newInstanceId } from '../auth/service-identity.mjs';
import { createLookClient, parseLookUrl } from '../agent-service/look-client.mjs';

const P1 = `sp_${'a'.repeat(26)}`;
const P2 = `sp_${'b'.repeat(26)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function keyOf(service) {
  const pair = generateServiceKeyPair();
  return { service, kid: pair.kid, priv: pair.priv, pub: pair.pub, instanceId: newInstanceId(), instanceName: `${service}-test` };
}
/** 登记表的替身：`{ agent: { role, keys } }` */
const registryOf = (services) => ({ get: (name) => (Object.hasOwn(services, name) ? services[name] : null) });
const entryOf = (key, role = key.service) => ({ role, actsFor: 'member', keys: [{ kid: key.kid, alg: 'ed25519', pub: key.pub, addedAt: 0 }] });

test('HR38 认身份：只认登记表里角色是 agent 的服务 agent；别的服务、撤掉的公钥、改过的请求体、过期、重放、没有登记表都进不来', () => {
  const agent = keyOf('agent');
  const render = keyOf('render');
  let at = 1_000_000;
  const verify = createLookVerifier({ registry: registryOf({ agent: entryOf(agent), render: entryOf(render, 'render') }), now: () => at });
  const body = JSON.stringify({ projectId: P1, path: '/api/vision/snapshot', body: { project: { tracks: [] } } });

  const good = signLookRequest(agent, body, { now: at });
  assert.deepEqual(verify(good, body), { ok: true, service: 'agent', kid: agent.kid, instanceId: agent.instanceId });
  assert.deepEqual(verify(good, body), { ok: false, reason: 'replay' }, '同一个签名只能用一次');

  assert.equal(verify(signLookRequest(agent, body, { now: at }), `${body} `).reason, 'signature', '请求体改过一个字节');
  assert.equal(verify(signLookRequest(agent, body, { now: at - 61_000 }), body).reason, 'expired');
  assert.equal(verify(signLookRequest(agent, body, { now: at + 61_000 }), body).reason, 'expired');
  // 渲染服务自己的私钥（它也在登记表里）冒充不了 Agent 服务
  assert.equal(verify(signLookRequest(render, body, { now: at }), body).reason, 'service');
  // 把自己的私钥签的东西标成 agent：登记表里没有这把公钥
  assert.equal(verify(signLookRequest({ ...render, service: 'agent' }, body, { now: at }), body).reason, 'revoked');
  // 用登记的 kid、别人的私钥：签名对不上
  assert.equal(verify(signLookRequest({ ...render, service: 'agent', kid: agent.kid }, body, { now: at }), body).reason, 'signature');
  for (const bad of [undefined, '', 'v1.', 'v1.!!!', 'Bearer abc', `v1.${Buffer.from('{"v":2}').toString('base64url')}`, 'x'.repeat(3000)]) {
    assert.equal(verify(bad, body).ok, false, String(bad).slice(0, 20));
  }
  // 握手的签名挪不过来：用途串不同
  assert.notEqual(lookPurpose({ service: 'agent', instanceId: 'i', ts: 1, nonce: 'n', digest: 'd' }).toString(), `promptcut.service.v1\nagent\ni\nn`);

  // 登记表里 agent 的角色不是 agent、公钥撤了、整个没有：都进不来
  assert.equal(createLookVerifier({ registry: registryOf({ agent: entryOf(agent, 'render') }), now: () => at })(signLookRequest(agent, body, { now: at }), body).reason, 'not-registered');
  assert.equal(createLookVerifier({ registry: registryOf({ agent: { role: 'agent', keys: [] } }), now: () => at })(signLookRequest(agent, body, { now: at }), body).reason, 'revoked');
  assert.equal(createLookVerifier({ registry: registryOf({}), now: () => at })(signLookRequest(agent, body, { now: at }), body).reason, 'not-registered');
  assert.equal(createLookVerifier({ registry: null })(signLookRequest(agent, body), body).reason, 'no-registry');
  // 过了窗口，记过的随机数清掉也不要紧：时刻那一关已经过不了
  at += 200_000;
  assert.equal(verify(good, body).reason, 'expired');
});

/** 一套可拨的替身：目录、常驻与隔离工作进程的样子、被转发的请求 */
function lookKit({ limits = {}, enabled = true } = {}) {
  const state = {
    projects: new Map([[P1, { enabled: true, active: true, hosted: { agent: { enabled: true } } }], [P2, { enabled: true, active: true, hosted: { agent: { enabled: true } } }]]),
    paused: false,
    residentNodes: new Map([[P1, { projectId: P1, connected: true, cards: { state: 'none' } }]]),
    iso: { enabled: true, port: 7003, key: null, current: null, report: null, lastRun: null },
    wants: [],
    sent: [],
    reply: async () => ({ status: 200, json: { ok: true, t: 1, __image: { mime: 'image/png', base64: 'AAAA' } } }),
  };
  const look = createLook({
    enabled,
    verify: (auth) => (auth === 'good' ? { ok: true, service: 'agent', kid: 'k', instanceId: 'instance-0001' } : { ok: false, reason: 'signature' }),
    project: (id) => state.projects.get(id) ?? null,
    paused: () => state.paused,
    resident: () => ({ port: 7000, key: 'resident-key', running: true, node: (id) => state.residentNodes.get(id) ?? null }),
    iso: () => state.iso,
    want: (projectId, until) => state.wants.push({ projectId, until }),
    fetch: async (url, init) => {
      state.sent.push({ url, key: init.headers[LOOK_KEY_HEADER], body: JSON.parse(init.body) });
      const r = await state.reply(url, init);
      return { status: r.status, json: async () => r.json };
    },
    limits: { pollMs: 10, settleMs: 200, cardWaitMs: 150, ...limits },
  });
  const ask = (msg, auth = 'good') => look.handle({ auth, bodyText: JSON.stringify(msg) });
  const snap = (projectId, extra = {}) => ({ projectId, path: '/api/vision/snapshot', body: { project: { id: projectId, tracks: [] }, t: 1 }, timeoutMs: 2000, ...extra });
  const isoReady = (projectId, records = {}) => {
    state.iso = {
      ...state.iso, key: `iso-key-${projectId.slice(3, 5)}`, current: { projectId, phase: 'running' },
      report: { queue: { nodes: [{ projectId, connected: true, cards: { state: 'synced' } }], cardCode: { settled: true }, cardSync: [{ projectId, records, notices: [] }] } },
    };
  };
  return { state, look, ask, snap, isoReady };
}

test('HR39 路由：没有卡的走常驻；有卡的只走这一轮正是它的隔离工作进程；别的项目的一轮在跑时要不到；开关与目录', async () => {
  const k = lookKit();
  // 没有卡片源码：常驻工作进程，带它自己的口令
  const a = await k.ask(k.snap(P1));
  assert.equal(a.status, 200);
  assert.equal(a.body.ok, true);
  assert.deepEqual(k.state.sent.map((s) => [s.url, s.key]), [['http://127.0.0.1:7000/api/vision/snapshot', 'resident-key']]);
  assert.deepEqual(k.state.sent[0].body, { project: { id: P1, tracks: [] }, t: 1 }, '请求体原样转过去');
  assert.equal(k.state.wants.length, 0, '没有卡的项目不登记隔离的需求');
  assert.deepEqual(k.look.status().byWorker, { resident: 1, isolated: 0 });

  // 身份不对：401，什么都不说，也不转
  const forged = await k.ask(k.snap(P1), 'forged');
  assert.deepEqual([forged.status, forged.body], [401, { ok: false, error: 'unauthorized' }]);
  // 形状不对、路径不在表里、可视化记录（不是 get_gif）：400
  for (const bad of [{ ...k.snap(P1), path: '/api/frames/queue' }, { ...k.snap(P1), path: '/api/frames/queue/release' }, { ...k.snap(P1), projectId: '../x' }, { ...k.snap(P1), body: null },
    { projectId: P1, path: '/api/ai/visual', body: { tool: 'see_frames', images: [] } }, { projectId: P1, path: '/api/vision/bake-evict', body: { keys: [] } }]) {
    assert.equal((await k.ask(bad)).status, 400, bad.path);
  }
  assert.equal((await k.ask({ projectId: P1, path: '/api/ai/visual', body: { tool: 'get_gif', clipId: 'c', after: { tracks: [] } } })).status, 200, '写动图规格的那一次放行');
  assert.equal(k.state.sent.length, 2);

  // 目录里没有、渲染节点关着、云端 Agent 关着
  assert.deepEqual([(await k.ask(k.snap(`sp_${'c'.repeat(26)}`))).body.look], ['no-project']);
  k.state.projects.get(P1).enabled = false;
  const off = await k.ask(k.snap(P1));
  assert.deepEqual([off.status, off.body.look, off.body.error], [403, 'service-disabled', LOOK_ERRORS['service-disabled']]);
  k.state.projects.get(P1).enabled = true;
  k.state.projects.get(P1).hosted.agent.enabled = false;
  assert.equal((await k.ask(k.snap(P1))).body.look, 'agent-disabled');
  k.state.projects.get(P1).hosted.agent.enabled = true;
  assert.equal(k.state.sent.length, 2, '被拒的一个都没转');

  // 有卡片源码（Agent 服务报的）：登记需求，等隔离工作进程这一轮正是它、卡同步到要的版本
  const cards = { 'src/cards/user/x.tsx': 3 };
  const pending = k.ask(k.snap(P1, { cards, timeoutMs: 3000 }));
  await sleep(60);
  assert.ok(k.state.wants.some((w) => w.projectId === P1), '登记了看画面的需求');
  assert.equal(k.state.sent.length, 2, '隔离工作进程没就绪时不转，更不转给常驻的');
  k.isoReady(P1, { 'src/cards/user/x.tsx': 2 });
  await sleep(60);
  assert.equal(k.state.sent.length, 2, '卡还没装到要的版本：等');
  k.isoReady(P1, { 'src/cards/user/x.tsx': 3 });
  const b = await pending;
  assert.equal(b.status, 200);
  assert.deepEqual([k.state.sent[2].url, k.state.sent[2].key], ['http://127.0.0.1:7003/api/vision/snapshot', k.state.iso.key]);
  assert.deepEqual(k.look.status().byWorker, { resident: 2, isolated: 1 });

  // 常驻工作进程报「有卡」（Agent 服务那份还是空的）：同样只走隔离
  k.state.residentNodes.set(P1, { projectId: P1, connected: true, cards: { state: 'some' } });
  const c = await k.ask(k.snap(P1));
  assert.equal(c.status, 200);
  assert.equal(k.state.sent[3].url.includes(':7003/'), true);

  // 隔离工作进程这一轮是别的项目：项目甲的内容绝不交给它；到时限回「排队」
  k.isoReady(P2, {});
  const before = k.state.sent.length;
  const d = await k.ask(k.snap(P1, { cards, timeoutMs: 2000 }));
  assert.deepEqual([d.status, d.body.ok, d.body.look], [504, false, 'iso-busy']);
  assert.match(d.body.error, /^这次没看成/);
  assert.equal(k.state.sent.length, before, '一个都没转');

  // 等过头了卡还没对上：照渲，结果里注明
  k.isoReady(P1, { 'src/cards/user/x.tsx': 2 });
  const e = await k.ask(k.snap(P1, { cards, timeoutMs: 3000 }));
  assert.equal(e.status, 200);
  assert.match(e.body.note, /可能还没同步到渲染节点/);

  // 这台节点没开用户卡的隔离：带卡的项目看不了
  k.state.iso = { ...k.state.iso, enabled: false };
  assert.equal((await k.ask(k.snap(P1, { cards }))).body.look, 'iso-off');
  // 为它起过又没起成：不干等
  k.state.iso = { enabled: true, port: 7003, key: null, current: null, report: null, lastRun: { projectId: P1, reason: 'oom', at: Date.now() + 1000 } };
  assert.equal((await k.ask(k.snap(P1, { cards, timeoutMs: 3000 }))).body.look, 'iso-failed');

  // 常驻工作进程还没报出这个项目带没带卡：等到它确知「没有」
  k.state.residentNodes.set(P2, { projectId: P2, connected: true, cards: { state: 'unknown' } });
  const waiting = k.ask(k.snap(P2, { timeoutMs: 3000 }));
  await sleep(50);
  const n = k.state.sent.length;
  k.state.residentNodes.set(P2, { projectId: P2, connected: true, cards: { state: 'none' } });
  assert.equal((await waiting).status, 200);
  assert.equal(k.state.sent.length, n + 1);
  // 一直没连上这个项目：到点回「还没连上」
  k.state.residentNodes.delete(P2);
  assert.equal((await k.ask(k.snap(P2, { timeoutMs: 2000 }))).body.look, 'not-ready');

  // 整条路关着：与没有这条路一样（先于认身份）
  const closed = lookKit({ enabled: false });
  const z = await closed.ask(closed.snap(P1));
  assert.deepEqual([z.status, z.body.look], [404, 'off']);
  assert.equal(closed.state.sent.length, 0);
});

test('HR40 并发与时限：同一时刻只转发一个，其余排队；排满回忙；背压暂停时不接；工作进程不回就按时限回「这次没看成」', async () => {
  const k = lookKit({ limits: { maxWaiting: 2 } });
  let inFlight = 0;
  let peak = 0;
  k.state.reply = async () => { inFlight += 1; peak = Math.max(peak, inFlight); await sleep(80); inFlight -= 1; return { status: 200, json: { ok: true } }; };
  const all = await Promise.all([1, 2, 3, 4, 5].map(() => k.ask(k.snap(P1, { timeoutMs: 5000 }))));
  assert.equal(peak, 1, '同一时刻只有一个在工作进程上');
  assert.deepEqual(all.map((r) => r.status).sort(), [200, 200, 200, 503, 503], '一个在途、最多再排 2 个，再多回忙');
  assert.equal(all.find((r) => r.status === 503).body.look, 'busy');
  assert.equal(k.look.busyOn(), null);

  // 在途时报出正在哪个工作进程上（管理进程据此让出一个并发名额）
  let seen = null;
  k.state.reply = async () => { seen = [k.look.busyOn(), k.look.busyProject()]; return { status: 200, json: { ok: true } }; };
  await k.ask(k.snap(P1));
  assert.deepEqual(seen, ['resident', P1]);

  k.state.paused = true;
  const p = await k.ask(k.snap(P1));
  assert.deepEqual([p.status, p.body.look], [503, 'busy']);
  k.state.paused = false;

  // 工作进程不回：按时限回，不挂着
  k.state.reply = (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' }))));
  const t0 = Date.now();
  const t = await k.ask(k.snap(P1, { timeoutMs: 2000 }));
  assert.deepEqual([t.status, t.body.ok, t.body.look], [504, false, 'timeout']);
  assert.ok(Date.now() - t0 < 4000);
  // 工作进程回了不是 JSON 的东西、连不上：明说出错
  k.state.reply = async () => ({ status: 502, json: null });
  assert.equal((await k.ask(k.snap(P1))).body.look, 'failed');
  k.state.reply = async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
  const f = await k.ask(k.snap(P1));
  assert.equal(f.body.look, 'failed');
  assert.match(f.body.error, /ECONNREFUSED/);
  // 工作进程自己的「不成」（例如片段不存在）原样带回
  k.state.reply = async () => ({ status: 404, json: { ok: false, error: '时间轴上没有 id 为 c9 的片段。' } });
  assert.deepEqual((await k.ask(k.snap(P1))).body, { ok: false, error: '时间轴上没有 id 为 c9 的片段。' });
  const s = k.look.status();
  assert.equal(s.inFlight, null);
  assert.equal(s.waiting, 0);
});

test('HR41 隔离工作进程的编排：要看画面的项目没有任务也算候选并排最前；出图的半路上不结束、不轮换；有需求就不算闲置', async () => {
  const directory = [{ projectId: P1, enabled: true, active: true, members: false, since: 1 }, { projectId: P2, enabled: true, active: true, members: true, since: 2 }];
  const residentNodes = [{ projectId: P2, cards: { state: 'some' }, pending: 2, pendingKey: 'k2' }];
  assert.deepEqual(isolationCandidates({ directory, residentNodes }).map((c) => c.projectId), [P2]);
  // 甲没有任务、常驻的也还没报它有卡：有看画面的需求就是候选，而且排在有成员在线的乙前面
  const withLook = isolationCandidates({ directory, residentNodes, looks: new Map([[P1, 7]]) });
  assert.deepEqual(withLook.map((c) => [c.projectId, c.look === true, c.pendingKey]), [[P1, true, '|look:7'], [P2, false, 'k2']]);
  // 开关关着、没活的项目：有需求也不是候选
  assert.deepEqual(isolationCandidates({ directory: [{ projectId: P1, enabled: false, active: true }], residentNodes: [], looks: new Map([[P1, 1]]) }), []);

  let at = 0;
  const calls = [];
  let exited = false;
  const iso = createIsolation({
    nodeIdOf: (id) => `iso/${id.slice(3, 5)}`, now: () => at, idleMs: 1000, sliceMs: 10_000, lookSliceMs: 3000, drainMs: 500,
    runner: {
      async prepare(id) { calls.push(`prepare:${id.slice(3, 5)}`); },
      start(id) { calls.push(`start:${id.slice(3, 5)}`); exited = false; },
      async stop(reason) { calls.push(`stop:${reason}`); exited = true; },
      async cleanup() { calls.push('cleanup'); },
      exited: () => exited,
    },
  });
  const report = (projectId, extra = {}) => ({ at, queue: { nodes: [{ projectId, held: [], running: [], claimable: 0, claimed: 0, ...extra }] } });
  const settle = async () => { await iso.settled(); await sleep(0); };

  // 两个候选：乙有任务，甲只为看画面——先起甲
  iso.tick({ candidates: withLook });
  await settle();
  assert.deepEqual(calls, ['prepare:aa', 'start:aa']);
  at = 100;
  iso.tick({ candidates: withLook, report: report(P1), looks: { wanted: () => true, busy: null } });
  assert.equal(iso.current.phase, 'running');
  // 一直有需求：超过闲置时限也不结束
  at = 2500;
  iso.tick({ candidates: withLook, report: report(P1), looks: { wanted: () => true, busy: null } });
  assert.equal(iso.current?.projectId, P1);
  // 正在出图：到了轮换的时刻也不走（乙在等）
  at = 20_000;
  iso.tick({ candidates: withLook, report: report(P1), looks: { wanted: () => true, busy: P1 } });
  assert.equal(iso.current.phase, 'running', '出图的半路上不轮换');
  assert.equal(iso.current.worked, true, '出过图算这一轮干了活');
  // 出完了：乙在等，轮换；手里没有任务就结束，换乙
  iso.tick({ candidates: withLook, report: report(P1), looks: { wanted: () => true, busy: null } });
  await settle();
  assert.ok(calls.includes('stop:rotated'));
  assert.equal(iso.current, null);

  // 乙在跑、甲要看画面在等：乙最多再做 lookSliceMs 就轮换（不是 sliceMs）
  calls.length = 0;
  const onlyB = isolationCandidates({ directory, residentNodes });
  iso.tick({ candidates: onlyB });
  await settle();
  assert.deepEqual(calls, ['prepare:bb', 'start:bb']);
  at = 21_000;
  iso.tick({ candidates: onlyB, report: report(P2, { held: ['t1'] }) });
  assert.equal(iso.current.phase, 'running');
  at = 23_000;
  iso.tick({ candidates: withLook, report: report(P2, { held: ['t1'] }), looks: { wanted: (id) => id === P1, busy: null } });
  assert.equal(iso.current.phase, 'running', '还不到 lookSliceMs');
  at = 24_500;
  iso.tick({ candidates: withLook, report: report(P2, { held: ['t1'] }), looks: { wanted: (id) => id === P1, busy: null } });
  assert.equal(iso.current.phase, 'draining', '有人等着看画面：提前轮换');
  iso.tick({ candidates: withLook, report: report(P2, { held: [] }), looks: { wanted: (id) => id === P1, busy: null } });
  await settle();
  assert.ok(calls.includes('stop:rotated'));

  // 需求过期、没有任务：照旧按闲置结束
  calls.length = 0;
  iso.tick({ candidates: withLook });
  await settle();
  at = 30_000;
  iso.tick({ candidates: [], report: report(P1), looks: { wanted: () => false, busy: null } });
  at = 31_500;
  iso.tick({ candidates: [], report: report(P1), looks: { wanted: () => false, busy: null } });
  await settle();
  assert.ok(calls.includes('stop:idle'));
});

test('HR42 代理口上的 /look：浏览器形状的请求 403；工作进程的口令要不到画面；Agent 服务的签名要不到清单与票据；没给口子就没有这条路', async () => {
  const handled = [];
  const look = {
    limits: { maxBodyBytes: 4096 },
    async handle(input) { handled.push(input); return input.auth === 'sig' ? { status: 200, body: { ok: true, frame: 1 } } : { status: 401, body: { ok: false, error: 'unauthorized' } }; },
  };
  const broker = createBroker({ key: 'worker-key', listing: () => ({ projects: [{ projectId: P1 }] }), ticket: async () => ({ ticket: 't' }), report() {}, status: () => ({}), look });
  const addr = await broker.listen(0);
  const base = `http://127.0.0.1:${addr.port}`;
  const post = async (path, { headers = {}, body = '{}' } = {}) => { const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body }); return [r.status, await r.json()]; };
  try {
    assert.deepEqual(await post('/look', { headers: { [LOOK_AUTH_HEADER]: 'sig' }, body: '{"a":1}' }), [200, { ok: true, frame: 1 }]);
    assert.deepEqual(handled[0], { auth: 'sig', bodyText: '{"a":1}' }, '请求体原样交给核对（签名按原文算）');
    // 工作进程的口令（卡片代码即使拿下了工作进程）要不到画面
    assert.deepEqual((await post('/look', { headers: { authorization: 'Bearer worker-key' } }))[0], 401);
    // 浏览器形状的请求：进不到核对那一步
    const n = handled.length;
    assert.deepEqual((await post('/look', { headers: { [LOOK_AUTH_HEADER]: 'sig', 'sec-fetch-site': 'same-site' } }))[0], 403);
    assert.deepEqual((await post('/look', { headers: { [LOOK_AUTH_HEADER]: 'sig', origin: 'http://127.0.0.1:5401' } }))[0], 403);
    assert.equal(handled.length, n);
    // 太大
    assert.deepEqual((await post('/look', { headers: { [LOOK_AUTH_HEADER]: 'sig' }, body: JSON.stringify({ x: 'y'.repeat(5000) }) }))[0], 413);
    // Agent 服务的签名不是工作进程的口令：要不到清单与票据
    const r = await fetch(`${base}/projects`, { headers: { [LOOK_AUTH_HEADER]: 'sig' } });
    assert.equal(r.status, 401);
    assert.equal((await post('/ticket', { headers: { [LOOK_AUTH_HEADER]: 'sig' }, body: JSON.stringify({ projectId: P1 }) }))[0], 401);
  } finally {
    await broker.close();
  }
  const none = createBroker({ key: 'worker-key', listing: () => ({ projects: [] }), ticket: async () => ({ ticket: 't' }), report() {}, status: () => ({}) });
  const a2 = await none.listen(0);
  try {
    const r = await fetch(`http://127.0.0.1:${a2.port}/look`, { method: 'POST', headers: { [LOOK_AUTH_HEADER]: 'sig' }, body: '{}' });
    assert.equal(r.status, 404);
  } finally {
    await none.close();
  }
  // 配置：缺省开；off 关；登记表的路径可给
  assert.deepEqual([renderServiceConfig({}).look, renderServiceConfig({ PROMPTCUT_RENDER_LOOK: 'off' }).look, renderServiceConfig({ PROMPTCUT_RENDER_LOOK: 'x' }).look], ['on', 'off', 'on']);
  assert.equal(renderServiceConfig({}).lookServicesFile, '/var/lib/promptcut/hosted/secrets/services.json');
  assert.equal(renderServiceConfig({ PROMPTCUT_RENDER_LOOK_SERVICES: '/x/services.json' }).lookServicesFile, '/x/services.json');
});

function fakeViteServer() {
  const stack = [];
  const httpServer = new EventEmitter();
  httpServer.address = () => ({ port: 5555 });
  return {
    stack, httpServer,
    middlewares: { use: (fn) => stack.push(fn) },
    run(req) {
      const res = { headers: {}, statusCode: 200, body: null, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b ?? ''; } };
      let passed = false;
      stack[0]({ method: 'GET', headers: {}, resume() {}, ...req }, res, () => { passed = true; });
      return { passed, status: res.statusCode, body: res.body };
    },
  };
}

test('HR43 工作进程的页面请求闸：看画面的那批接口，Node 一侧的请求也要带这个工作进程自己的口令；浏览器发来的照旧 403；别的接口不变', async () => {
  for (const [url, yes] of [['/api/vision/snapshot', true], ['/API/Vision/bake?x=1', true], ['//api//vision/bake-evict', true], ['/api/ai/visual', true], ['/api/ai/visual/render', true],
    ['/api/ai/visual/gif/0123456789abcdef.gif', true], ['/api/cards/dom', true], ['/api/cards/layout', true], ['/api/ai/visualx', false], ['/api/cards/domx', false],
    ['/api/cards/scopes', false], ['/api/frames/queue', false], ['/src/main.tsx', false]]) assert.equal(isLookPath(url), yes, url);

  for (const prerender of [false, true]) {
    const server = fakeViteServer();
    const env = { PROMPTCUT_RENDER_BROKER: 'http://127.0.0.1:1', PROMPTCUT_RENDER_BROKER_KEY: 'this-worker-key', PROMPTCUT_HOSTED_GATE_PASS: 'pass-1' };
    const lines = [];
    const gate = await installHostedGate(server, { prerender, env, write: (l) => lines.push(l) });
    try {
      // Node 一侧、不带口令：别的接口照旧放行，看画面的那批 403
      assert.equal(server.run({ url: '/api/frames/queue', headers: {} }).passed, true);
      const no = server.run({ method: 'POST', url: '/api/vision/snapshot', headers: {} });
      assert.deepEqual([no.passed, no.status, JSON.parse(no.body).error], [false, 403, 'look-key']);
      assert.equal(server.run({ method: 'POST', url: '/api/cards/dom', headers: { [LOOK_KEY_HEADER]: 'other-worker-key' } }).status, 403, '别的工作进程的口令不行');
      assert.equal(server.run({ method: 'POST', url: '/api/ai/visual/render', headers: { [LOOK_KEY_HEADER]: '' } }).status, 403);
      // 带对了口令（管理进程转来的）：放行
      for (const url of Object.keys(LOOK_ROUTES)) assert.equal(server.run({ method: 'POST', url, headers: { [LOOK_KEY_HEADER]: 'this-worker-key' } }).passed, true, url);
      // 浏览器发来的：带不带口令都 403（页面本来也读不到口令）
      const page = server.run({ method: 'POST', url: '/api/vision/snapshot', headers: { 'sec-fetch-site': 'same-origin', [LOOK_KEY_HEADER]: 'this-worker-key' } });
      assert.deepEqual([page.passed, page.status], [false, 403]);
      assert.ok(lines.some((l) => l.includes('"reason":"look-key"')));
    } finally {
      await gate.proxy?.close();
    }
  }
  // 没有给口令的环境（不该有）：谁也过不了
  const bare = fakeViteServer();
  await installHostedGate(bare, { prerender: false, env: { PROMPTCUT_RENDER_BROKER: 'http://127.0.0.1:1' }, write: () => {} });
  assert.equal(bare.run({ method: 'POST', url: '/api/vision/snapshot', headers: { [LOOK_KEY_HEADER]: '' } }).status, 403);
  assert.equal(bare.run({ method: 'POST', url: '/api/vision/snapshot', headers: {} }).status, 403);
});

test('CA-LOOK-01 Agent 服务一侧的客户端：地址只许回环；项目由宿主定；请求带服务私钥的签名；「这次没看成」原话抛出；云端不存可视化记录', async () => {
  for (const [raw, want] of [['http://127.0.0.1:5399', 'http://127.0.0.1:5399'], ['http://localhost:5399/', 'http://localhost:5399'], ['http://[::1]:5399', 'http://[::1]:5399'],
    ['https://127.0.0.1:5399', null], ['http://10.0.0.5:5399', null], ['http://example.com', null], ['http://127.0.0.1:5399/look', null], ['http://u:p@127.0.0.1:5399', null], ['', null], [undefined, null]]) {
    assert.equal(parseLookUrl(raw), want, String(raw));
  }
  const key = keyOf('agent');
  assert.throws(() => createLookClient({ url: 'http://10.0.0.5:5399', key }), /回环/);
  const verify = createLookVerifier({ registry: registryOf({ agent: entryOf(key) }) });
  const sent = [];
  let reply = { status: 200, json: { ok: true, t: 1, __image: { mime: 'image/png', base64: 'AAAA' } } };
  const client = createLookClient({
    url: 'http://127.0.0.1:5399', key,
    fetch: async (url, init) => { sent.push({ url, init }); return { status: reply.status, json: async () => reply.json }; },
  });
  const post = client.forProject(P1, { cards: () => ({ 'src/cards/user/x.tsx': 4 }) });
  const out = await post('/api/vision/snapshot', { project: { tracks: [] }, t: 1 }, { timeoutMs: 30_000 });
  assert.equal(out.ok, true);
  assert.equal(sent[0].url, 'http://127.0.0.1:5399/look');
  const msg = JSON.parse(sent[0].init.body);
  assert.deepEqual([msg.projectId, msg.path, msg.cards, msg.timeoutMs], [P1, '/api/vision/snapshot', { 'src/cards/user/x.tsx': 4 }, 30_000]);
  assert.equal(verify(sent[0].init.headers[LOOK_AUTH_HEADER], sent[0].init.body).ok, true, '签名按发出去的请求体原文算，对端核得过');
  // 项目是绑死的：工具给的请求体里写别的项目也改不了信封上的项目
  await post('/api/vision/snapshot', { project: { id: P2, tracks: [] }, projectId: P2 });
  assert.equal(JSON.parse(sent[1].init.body).projectId, P1);
  // 云端不存可视化记录：不发请求；get_gif 写规格的那一次照发
  const n = sent.length;
  assert.deepEqual(await post('/api/ai/visual', { tool: 'see_frames', images: [] }), { ok: false, error: '云端不存可视化记录' });
  assert.deepEqual(await post('/api/ai/visual', { tool: 'update_clip', clipId: 'c', before: {}, after: {} }), { ok: false, error: '云端不存可视化记录' });
  assert.equal(sent.length, n);
  await post('/api/ai/visual', { tool: 'get_gif', clipId: 'c', after: { tracks: [] } });
  assert.equal(sent.length, n + 1);
  await assert.rejects(() => post('/api/frames/queue', {}), /不提供/);
  // 「这次没看成」：原话抛出（工具把它交给模型）
  reply = { status: 504, json: { ok: false, look: 'iso-busy', error: LOOK_ERRORS['iso-busy'] } };
  await assert.rejects(() => post('/api/vision/snapshot', { project: { tracks: [] } }), (err) => err.message === LOOK_ERRORS['iso-busy']);
  reply = { status: 401, json: { ok: false, error: 'unauthorized' } };
  await assert.rejects(() => post('/api/vision/snapshot', { project: { tracks: [] } }), (err) => err.message.startsWith('这次没看成'));
  reply = { status: 404, json: { ok: false, look: 'off', error: LOOK_ERRORS.off } };
  await assert.rejects(() => post('/api/vision/snapshot', { project: { tracks: [] } }), (err) => err.message === LOOK_ERRORS.off);
  // 工作进程自己的回答（片段不存在）原样交回，由工具照桌面版的办法处理
  reply = { status: 200, json: { ok: false, error: '时间轴上没有 id 为 c9 的片段。' } };
  assert.deepEqual(await post('/api/vision/snapshot', { project: { tracks: [] }, clipId: 'c9' }), { ok: false, error: '时间轴上没有 id 为 c9 的片段。' });
  // 连不上
  const down = createLookClient({ url: 'http://127.0.0.1:5399', key, fetch: async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); } });
  await assert.rejects(() => down.forProject(P1)('/api/vision/snapshot', { project: { tracks: [] } }), /这次没看成：连不上/);
  assert.equal(client.describe().url, 'http://127.0.0.1:5399');
});
