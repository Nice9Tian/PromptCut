/**
 * 多项目模式下的隔离（语义 `product/rendering.md`「渲染服务的两种模式」：不同项目的卡不在同一个页面里执行，素材只能读本项目的；
 * 机制 `mechanism/rendering.md`「多项目模式的做法」第四条：每个请求在只属于它那个项目的隔离环境里执行）。
 * 跑：npm test -- server/test/multi-project-isolation.test.mjs（不起浏览器、不起真进程：看画面的队列、隔离工作进程的编排、代理口三样真模块接在一起，
 * 工作进程换成记账的替身）
 *
 *   MPI1  两个带用户卡的项目交错要画面：按多项目模式轮流出图；每一个请求都只转给**正装着它自己那个项目**的隔离工作进程（口令是那一轮的），
 *         没有一个请求在装着别的项目时被转出；换项目之前上一轮结束并清空（stop → cleanup → 下一轮 prepare）
 *   MPI2  隔离工作进程这一轮的口令只要得到它自己那个项目的票据（别的项目 403）；换了一轮，旧口令什么都要不到
 *   MPI3  展开后的项目只带本项目用到的素材；请求里夹着别的项目的素材引用也不会多出别的项目的素材条目
 *
 * 端到端（真进程、真 Chrome、越权探测卡）的隔离验收是 `scripts/probes/hosted-render-isolation-probe.mjs`；素材服务按项目分库、
 * 拿 A 的票据读不到 B 的块的单测在 `server/test/asset-project-workers.test.mjs`。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createLook, LOOK_KEY_HEADER } from '../hosted-render/look.mjs';
import { createIsolation, isolationCandidates } from '../hosted-render/isolation.mjs';
import { createBroker } from '../hosted-render/broker.mjs';
import { expandProject } from '../render-node/expand.mjs';

const PA = `sp_${'a'.repeat(26)}`;
const PB = `sp_${'b'.repeat(26)}`;
const CARDS = { 'src/cards/user/x.tsx': 1 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rid = (n) => `mpi-${String(n).padStart(4, '0')}-abcdefghijkl`;

/** 看画面的队列 + 隔离工作进程的编排，接在一起跑；工作进程是记账的替身 */
function rig({ turn = 1 } = {}) {
  const calls = [];
  let key = null;
  let gen = 0;
  const iso = createIsolation({
    nodeIdOf: (p) => `iso/${p}`, cacheMs: 60_000, drainMs: 5000, turnTasks: turn,
    runner: {
      async prepare(p) { calls.push(`prepare:${p.slice(3, 4)}`); gen += 1; key = `iso-key-${p.slice(3, 4)}-${gen}`; },
      start(p) { calls.push(`start:${p.slice(3, 4)}`); },
      async stop(reason) { calls.push(`stop:${reason}`); key = null; },
      async cleanup(p) { calls.push(`cleanup:${p.slice(3, 4)}`); },
      exited: () => false,
    },
  });
  const isoState = () => {
    const cur = iso.current;
    const ready = cur && (cur.phase === 'running' || cur.phase === 'draining');
    return {
      enabled: true, port: 7100, key,
      current: cur ? { projectId: cur.projectId, phase: cur.phase } : null,
      report: ready ? { queue: { nodes: [{ projectId: cur.projectId, connected: true, cards: { state: 'synced' } }], cardCode: { settled: true }, cardSync: [{ projectId: cur.projectId, records: CARDS, notices: [] }] } } : null,
      lastRun: iso.status().lastRun,
    };
  };
  const sent = [];
  const look = createLook({
    verify: (auth) => (auth === 'agent' ? { ok: true, service: 'agent', kid: 'k', instanceId: 'agent-1' } : { ok: false, reason: 'signature' }),
    project: () => ({ enabled: true, active: true, hosted: { agent: { enabled: true } } }),
    resident: () => ({ port: 7000, key: 'resident', running: true, node: () => null }),
    iso: isoState,
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      sent.push({ project: body.project.id, n: body.n, key: init.headers[LOOK_KEY_HEADER], loaded: iso.current?.projectId ?? null, phase: iso.current?.phase ?? null, runKey: key });
      await sleep(15);
      return { status: 200, json: async () => ({ ok: true }) };
    },
    limits: { pollMs: 5, cardWaitMs: 50, turnRequests: turn },
  });
  const directory = [PA, PB].map((projectId, i) => ({ projectId, enabled: true, active: true, members: true, since: i }));
  let stop = false;
  const driver = (async () => {
    while (!stop) {
      const cur = iso.current;
      iso.tick({
        candidates: isolationCandidates({ directory, residentNodes: [], looks: look.isoOrder() }),
        report: cur ? { at: Date.now(), queue: { nodes: [{ projectId: cur.projectId, held: [], running: [], claimable: 0, claimed: 0 }] } } : null,
        looks: { wanted: look.wanted, busy: look.busyOn() === 'isolated' ? look.busyProject() : null },
      });
      await sleep(5);
    }
  })();
  return {
    calls, sent, look, iso,
    submit: (projectId, n, i) => look.handle({ auth: 'agent', bodyText: JSON.stringify({ projectId, path: '/api/vision/snapshot', body: { project: { id: projectId, fps: 30, duration: 5, tracks: [] }, t: 1, n }, cards: CARDS, requestId: rid(i) }) }),
    poll: (i) => look.poll({ auth: 'agent', bodyText: JSON.stringify({ requestId: rid(i), waitMs: 5000 }) }),
    async close() { stop = true; await driver; look.close(); await iso.stop('shutdown'); },
  };
}

test('MPI1 两个带用户卡的项目交错要画面（一轮一个，K=1）：轮流出图；每个请求只转给正装着它自己项目的隔离工作进程；换项目先结束并清空上一轮', async () => {
  const r = rig({ turn: 1 });
  try {
    const plan = [[PA, 1], [PA, 2], [PA, 3], [PB, 1], [PB, 2]];
    for (const [i, [p, n]] of plan.entries()) assert.equal((await r.submit(p, n, i)).status, 202);
    for (let i = 0; i < plan.length; i += 1) assert.equal((await r.poll(i)).status, 200, `请求 ${i} 出图`);
    const order = r.sent.map((s) => `${s.project.slice(3, 4)}${s.n}`);
    console.log('[MPI1] 出图次序', order.join(' → '));
    console.log('[MPI1] 隔离工作进程的起停', r.calls.join(' '));
    assert.deepEqual(order, ['a1', 'b1', 'a2', 'b2', 'a3'], '各项目轮流（同一项目内先来先做）');
    for (const s of r.sent) {
      assert.equal(s.loaded, s.project, `${s.project.slice(3, 4)}${s.n}：转出去的那一刻装着的就是它自己的项目`);
      assert.equal(s.key, s.runKey, '带的是这一轮的口令');
    }
    // 每次换项目：上一轮 stop → cleanup，之后才 prepare 下一个；同一时刻只有一个项目
    const runs = [];
    for (const c of r.calls) if (c.startsWith('prepare:')) runs.push(c.slice(8));
    assert.deepEqual(runs, ['a', 'b', 'a', 'b', 'a']);
    let open = null;
    for (const c of r.calls) {
      if (c.startsWith('prepare:')) { assert.equal(open, null, `装 ${c.slice(8)} 之前上一轮（${open}）已经结束并清空`); open = c.slice(8); }
      if (c.startsWith('cleanup:')) { assert.equal(c.slice(8), open); open = null; }
    }
    // 口令每一轮都不同：上一轮的口令带不走
    assert.equal(new Set(r.sent.map((s) => s.key)).size, 5);
  } finally { await r.close(); }
});

test('MPI2 隔离工作进程这一轮的口令只要得到它自己那个项目的票据；换了一轮，旧口令什么都要不到', async () => {
  let iso = { key: 'iso-key-a-1', projectId: PA };
  const tickets = [];
  const broker = createBroker({
    key: 'resident-key', listing: () => ({ projects: [] }), report() {}, status: () => ({}),
    clients: () => (iso ? [{ name: 'isolated', key: iso.key, listing: () => ({ projects: [{ projectId: iso.projectId }] }), report() {} }] : []),
    ticket: async (projectId) => { tickets.push(projectId); return { ticket: `ticket-for-${projectId}` }; },
  });
  const addr = await broker.listen(0);
  const ask = (key, projectId) => new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: addr.port, method: 'POST', path: '/ticket', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' } }, (res) => {
      let text = ''; res.on('data', (c) => { text += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.end(JSON.stringify({ projectId }));
  });
  try {
    assert.deepEqual(await ask('iso-key-a-1', PA), { status: 200, body: { ok: true, ticket: `ticket-for-${PA}` } });
    assert.equal((await ask('iso-key-a-1', PB)).status, 403, '装着甲的这一轮要不到乙的票据');
    // 换成乙的一轮：口令换了
    iso = { key: 'iso-key-b-2', projectId: PB };
    assert.equal((await ask('iso-key-a-1', PA)).status, 401, '甲那一轮的口令作废');
    assert.equal((await ask('iso-key-b-2', PA)).status, 403, '乙这一轮要不到甲的票据');
    assert.equal((await ask('iso-key-b-2', PB)).status, 200);
    assert.deepEqual(tickets, [PA, PB], '只为清单里的那个项目签过票据');
  } finally { await broker.close(); }
});

test('MPI3 展开后的项目只带本项目用到的素材；参数里引用了不在本项目素材表里的哈希，也不会凭空多出素材条目', () => {
  const H_OWN = 'a'.repeat(64), H_OTHER = 'b'.repeat(64);
  const project = {
    id: PA, fps: 30, duration: 10, width: 320, height: 180,
    media: [{ id: 'own', kind: 'image', hash: H_OWN, url: `/@media/${H_OWN}` }, { id: 'own-unused', kind: 'image', hash: 'c'.repeat(64) }],
    tracks: [{ id: 't', clips: [
      { id: 'img', mediaId: 'own', cardId: '', start: 0, end: 5, params: {} },
      { id: 'card', cardId: 'user-x', start: 0, end: 5, params: { src: `/@media/${H_OTHER}` } },
    ] }],
  };
  const r = expandProject(project, { times: [1] });
  assert.deepEqual(r.mediaIds, ['own'], '只有本项目素材表里、被用到的条目');
  assert.ok(r.project.media.every((m) => m.hash !== H_OTHER));
});

test('MPI4 换装时的两种退出：排空中工作进程自己退了算轮换；同一项目的一轮出过图之后没了，不算后面排着的请求「起不来」', async () => {
  // 排空中自己退了
  let exited = false;
  const calls = [];
  const iso = createIsolation({
    nodeIdOf: (p) => p, cacheMs: 60_000,
    runner: { async prepare() {}, start() { exited = false; }, async stop(reason) { calls.push(reason); }, async cleanup() {}, exited: () => exited },
  });
  const report = (p, extra = {}) => ({ at: Date.now() + 1000, queue: { nodes: [{ projectId: p, held: [], running: [], claimable: 0, claimed: 0, ...extra }] } });
  const cand = (p, extra = {}) => ({ projectId: p, members: false, pending: 1, pendingKey: p, ...extra });
  iso.tick({ candidates: [cand(PA)] });
  await iso.settled();
  iso.tick({ candidates: [cand(PA)], report: report(PA, { held: ['t'] }) });
  iso.tick({ candidates: [cand(PB, { look: true }), cand(PA)], report: report(PA, { held: ['t'] }) });
  assert.equal(iso.current.phase, 'draining');
  exited = true;
  iso.tick({ candidates: [cand(PB, { look: true })], report: report(PA) });
  await iso.settled();
  assert.deepEqual(calls, ['rotated']);
  assert.equal(iso.status().lastRun.reason, 'rotated');

  // 甲的一轮出过图（worked）之后没了：甲后面排着的请求接着排，不按「起不来」结掉
  const lastRun = { projectId: PA, reason: 'exit', worked: true, at: Date.now() + 60_000 };
  const look = createLook({
    verify: () => ({ ok: true, service: 'agent', kid: 'k', instanceId: 'agent-1' }),
    project: () => ({ enabled: true, active: true, hosted: { agent: { enabled: true } } }),
    resident: () => ({ port: 1, key: 'r', running: true, node: () => null }),
    iso: () => ({ enabled: true, port: 2, key: null, current: null, report: null, lastRun }),
    fetch: async () => { throw new Error('不该转出'); },
    limits: { pollMs: 5, retries: 0, isoRetries: 0 },
  });
  try {
    await look.handle({ auth: 'agent', bodyText: JSON.stringify({ projectId: PA, path: '/api/vision/snapshot', body: { project: { id: PA, tracks: [] }, t: 0 }, cards: CARDS, requestId: rid(90) }) });
    await sleep(60);
    const p = await look.poll({ auth: 'agent', bodyText: JSON.stringify({ requestId: rid(90), waitMs: 0 }) });
    assert.deepEqual([p.status, p.body.state, p.body.attempts], [202, 'queued', 0], '还排着，没算一次失败');
    lastRun.worked = false;
    await sleep(60);
    const q = await look.poll({ auth: 'agent', bodyText: JSON.stringify({ requestId: rid(90), waitMs: 0 }) });
    assert.equal(q.body.look, 'iso-failed', '真是为它起的一轮没起成（没出过图就没了）：照旧算');
  } finally { look.close(); }
});

test('MPI5 一轮最多连做 K 个（那一轮开始时已经排着的、它自己的）：K=2 时 甲甲 乙乙 甲；后来的不插进这一轮；每个请求照旧只转给装着自己项目的那一轮', async () => {
  const r = rig({ turn: 2 });
  try {
    const plan = [[PA, 1], [PA, 2], [PA, 3], [PB, 1], [PB, 2]];
    for (const [i, [p, n]] of plan.entries()) assert.equal((await r.submit(p, n, i)).status, 202);
    for (let i = 0; i < plan.length; i += 1) assert.equal((await r.poll(i)).status, 200);
    const order = r.sent.map((s) => `${s.project.slice(3, 4)}${s.n}`);
    console.log('[MPI5] K=2 出图次序', order.join(' → '), '｜装的次序', r.calls.filter((c) => c.startsWith('prepare:')).map((c) => c.slice(8)).join(' → '));
    assert.deepEqual(order, ['a1', 'a2', 'b1', 'b2', 'a3']);
    assert.deepEqual(r.calls.filter((c) => c.startsWith('prepare:')).map((c) => c.slice(8)), ['a', 'b', 'a'], '换了两次（K=1 要换四次）');
    for (const s of r.sent) assert.equal(s.loaded, s.project);
  } finally { await r.close(); }
});
