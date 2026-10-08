/**
 * 托管方渲染服务按项目隔离地执行用户卡（契约 `docs/plan/hosted-render-contract.md` 第 7.5 节，方案 A）的接线与三道闸。
 * 跑：npm test -- server/test/hosted-render-usercards.test.mjs（不起浏览器、不起真的工作进程；端口一律 0）
 * 编排的状态机本身（一次一个、闲置结束、轮换、清空）在 `hosted-render-isolation.test.mjs` 的 HR23；真实的端到端验收是
 * `scripts/probes/hosted-render-isolation-probe.mjs`（越权探测卡）。
 *
 *   HR23  接线：主机按项目「搁着不认领」（带卡片源码的项目常驻工作进程一个任务也不认领，诊断里报有几个在等）；并发可在运行中压低；
 *         「这个项目带没带卡片代码」的判定（只列键、拿不准就搁着）；代理口按工作进程分口令（隔离工作进程只看得到、只要得到它那一个项目，
 *         口令作废后什么都要不到）；交给工作进程的环境里没有管理进程的配置与名字像秘密的变量
 *   HR28  页面一侧的闸装到开发服务器上：浏览器发来的请求按表放行、其余 403，只记不拦的模式照放；浏览器发的 WebSocket 升级被掐；
 *         卡片外链照常加载；管理代理口仍拒绝浏览器形状请求与无口令调用
 *   HR32  同步文件预检：样式的 `@` 规则白名单、`@import` 的形状、`url()` 的落点；脚本的导入说明符、`import.meta.glob`、动态导入、
 *         `new URL(…, import.meta.url)`；`sourceMappingURL` 与 `@jsxImportSource`；越权探测卡的夹具——主卡与清单过得了，
 *         Node 一侧读盘的那两份被整份拒掉、每一种写法各有一条理由
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

import { createRenderQueue } from '../render-queue/index.mjs';
import { createRenderHost, reconcileHostProjects } from '../render-node/host.mjs';
import { createLoopback } from './fake-loopback-transport.mjs';
import { createTimerClock } from './fake-render-executor.mjs';
import { createBroker } from '../hosted-render/broker.mjs';
import { createCardPresence } from '../hosted-render/card-presence.mjs';
import { scrubWorkerEnv, renderServiceConfig } from '../hosted-render/main.mjs';
import { pageGate } from '../hosted-render/page-gate.mjs';
import { installHostedGate, hostedGateWanted, hostedGateMode, relayAllowed, GATE_PASS_ENV, GATE_PASS_HEADER } from '../hosted-render/vite-gate.mjs';
import { checkSyncedSource, rejectedStub, hostedWorkerKind, scanCss, normalizeBrowserCssImports } from '../hosted-render/source-gate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = path.join(ROOT, 'scripts', 'probes', 'fixtures', 'render-isolation');
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const FP = 'fedcba9876543210';
const CV = 'c0de-uc';
const STEP_MS = 250;

/* ------------------------------------------------------------------ 夹具（照 hosted-render-service.test.mjs） */

function fineTask(projectId, label, { cardSources = {}, userCards = false } = {}) {
  const contentKey = sha256(`ck:${projectId}:${label}`);
  const resultKey = sha256(`${contentKey}\n${FP}`);
  return {
    id: `snapshot:${resultKey}:0-29`, kind: 'snapshot', tier: 'shared', resultKey,
    range: { unit: 'localFrame', from: 0, to: 29 },
    source: { projectId, projectRev: 1 },
    input: { clipId: `clip-${label}`, cardId: `card-${label}`, entryKey: null, contentKey },
    weight: { class: 'medium', estMs: null, frames: 30 },
    requires: { envFingerprint: FP, codeVersion: CV, cardSources, transcode: false, userCards, graphCards: false, belowDependent: false },
    priority: 10,
  };
}
const fakeExecutor = () => ({ async plan() { return { entryKey: 'e', cardPlan: [] }; }, render: (task) => Promise.resolve({ fake: task.id }) });
const fakeSink = () => ({ async has() { return false; }, async put() { return { complete: true, result: {} }; } });

function createSpaces(projectIds) {
  const clock = createTimerClock();
  const spaces = new Map();
  for (const projectId of projectIds) {
    const lb = createLoopback();
    const queue = createRenderQueue({ now: clock.now, send: lb.queueSend, epoch: `epoch-${projectId}` });
    lb.attach(queue);
    const page = lb.connect(`page-${projectId}`, { userId: 'alice@page-device-0001', tenantId: projectId });
    page.onMessage(() => {});
    page.send({ type: 'publisher.hello', publisherId: `page-${projectId}` });
    spaces.set(projectId, { lb, queue, publish: (tasks) => page.send({ type: 'task.publish', tasks }), task: (id) => queue.describe().tasks.find((t) => t.id === id) });
  }
  const all = [...spaces.values()];
  const settle = async () => {
    for (let round = 0; round < 1000; round++) {
      for (const s of all) s.lb.flush();
      for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
      if (all.every((s) => s.lb.pending() === 0)) return;
    }
    throw new Error('消息往返不收敛');
  };
  return { clock, spaces, all, settle };
}
async function drive(env, step, until, maxSteps = 200) {
  for (let i = 0; i < maxSteps; i++) {
    await env.settle();
    step();
    await env.settle();
    for (const s of env.all) s.queue.tick();
    await env.settle();
    if (until()) return i;
    env.clock.advance(STEP_MS);
  }
  assert.fail(`超过 ${maxSteps} 步仍未满足条件`);
}

/* ================================================================== HR23 接线 */

test('HR23 主机按项目搁着不认领：带卡片源码的项目一个任务也不认领，诊断里报有几个在等、这批任务的摘要；放开后照常认领；别的项目不受影响', async () => {
  const env = createSpaces(['proj-cards', 'proj-plain']);
  const holds = { 'proj-cards': true };
  const host = createRenderHost({
    entries: [], dynamic: true,
    connect: (entry) => ({
      endpoint: env.spaces.get(entry.projectId).lb.connect(`host-${entry.projectId}`, { userId: 'service:render@instance-00000001', tenantId: entry.projectId }),
      executor: fakeExecutor(), sink: fakeSink(),
      // 只有带卡片源码的项目给 hold / cards；另一个项目照原来的接线
      ...(entry.projectId === 'proj-cards' ? { hold: () => holds['proj-cards'], cards: () => ({ state: holds['proj-cards'] ? 'some' : 'none', count: 2 }) } : {}),
    }),
    nodeIdOf: (entry) => `hosted-render:test/${entry.projectId}`,
    envFingerprint: FP, codeVersion: CV, maxConcurrent: 2, now: env.clock.now, random: () => 0,
    capabilities: { userCards: false, graphCards: false },
  });
  host.start();
  host.add({ projectId: 'proj-cards' });
  host.add({ projectId: 'proj-plain' });
  // 带卡的项目里：一个要用户卡代码的任务、一个不要的、一个别的环境的（换谁都做不了）
  const needsCard = fineTask('proj-cards', 'uc', { cardSources: { 'my-card': 'v1' }, userCards: true });
  const builtin = fineTask('proj-cards', 'builtin');
  const otherEnv = { ...fineTask('proj-cards', 'other-env'), requires: { ...fineTask('proj-cards', 'other-env').requires, envFingerprint: '0000000000000000' } };
  env.spaces.get('proj-cards').publish([needsCard, builtin, otherEnv]);
  const plain = fineTask('proj-plain', 'p');
  env.spaces.get('proj-plain').publish([plain]);
  await drive(env, () => host.tick(), () => env.spaces.get('proj-plain').task(plain.id)?.state === 'done');
  for (let i = 0; i < 8; i++) await drive(env, () => host.tick(), () => true, 2);
  assert.deepEqual([needsCard, builtin, otherEnv].map((t) => env.spaces.get('proj-cards').task(t.id).state), ['open', 'open', 'open'], '搁着：连它本来做得了的内置卡任务也不认领');
  const node = host.nodes().find((n) => n.projectId === 'proj-cards');
  assert.equal(node.hold, true);
  assert.equal(node.claimed, 0);
  assert.deepEqual(node.cards, { state: 'some', count: 2 });
  assert.equal(node.pending, 2, '在等的 = 换一个带着卡片代码的工作进程就能认领的：要卡的与内置的；别的环境的不算');
  assert.equal(node.claimable, 1, '按本节点手里真有的卡片代码，此刻就能认领的只有内置的那一个');
  assert.match(node.pendingKey, /^[0-9a-f]{16}$/);
  const plainNode = host.nodes().find((n) => n.projectId === 'proj-plain');
  assert.equal('hold' in plainNode, false, '没给 hold 的项目诊断与原来相同');
  // 来了新任务：摘要变
  const more = fineTask('proj-cards', 'uc2', { cardSources: { 'my-card': 'v1' }, userCards: true });
  env.spaces.get('proj-cards').publish([more]);
  await drive(env, () => host.tick(), () => host.nodes().find((n) => n.projectId === 'proj-cards').pending === 3);
  assert.notEqual(host.nodes().find((n) => n.projectId === 'proj-cards').pendingKey, node.pendingKey);
  // 放开：它做得了的照常认领
  holds['proj-cards'] = false;
  await drive(env, () => host.tick(), () => env.spaces.get('proj-cards').task(builtin.id)?.state === 'done');
  assert.equal(env.spaces.get('proj-cards').task(needsCard.id).state, 'open', '要卡片代码的任务它手里没有这份代码，照旧不认领');
  // hold 抛错按搁着算
  holds['proj-cards'] = true;
  const thrower = createRenderHost({
    entries: [{ projectId: 'proj-plain' }], connect: () => ({ endpoint: env.spaces.get('proj-plain').lb.connect('host-x', { userId: 'u@d', tenantId: 'proj-plain' }), executor: fakeExecutor(), sink: fakeSink(), hold: () => { throw new Error('x'); } }),
    envFingerprint: FP, codeVersion: CV, now: env.clock.now,
  });
  thrower.start();
  assert.equal(thrower.nodes()[0].hold, true);
});

test('HR23 并发可在运行中压低：隔离工作进程在跑时常驻的让出名额；清单没给 limit 就恢复', async () => {
  const env = createSpaces(['proj-a']);
  const host = createRenderHost({
    entries: [], dynamic: true,
    connect: (entry) => ({ endpoint: env.spaces.get(entry.projectId).lb.connect(`host-${entry.projectId}`, { userId: 'service:render@instance-00000001', tenantId: entry.projectId }), executor: fakeExecutor(), sink: fakeSink() }),
    envFingerprint: FP, codeVersion: CV, maxConcurrent: 2, now: env.clock.now, random: () => 0,
  });
  host.start();
  assert.equal(host.limit, 2);
  reconcileHostProjects(host, { limit: 0, projects: [{ projectId: 'proj-a' }] }, (item) => ({ projectId: item.projectId }));
  assert.equal(host.limit, 0);
  const a = fineTask('proj-a', 'a');
  env.spaces.get('proj-a').publish([a]);
  for (let i = 0; i < 6; i++) await drive(env, () => host.tick(), () => true, 2);
  assert.equal(env.spaces.get('proj-a').task(a.id).state, 'open', '压到 0：不认领');
  reconcileHostProjects(host, { limit: 1, projects: [{ projectId: 'proj-a' }] }, (item) => ({ projectId: item.projectId }));
  await drive(env, () => host.tick(), () => env.spaces.get('proj-a').task(a.id)?.state === 'done');
  reconcileHostProjects(host, { projects: [{ projectId: 'proj-a' }] }, (item) => ({ projectId: item.projectId }));
  assert.equal(host.limit, 2, '清单没给 limit（旧的管理进程）：不压');
  host.setLimit(9);
  assert.equal(host.limit, 2, '超出范围的恢复成 maxConcurrent');
});

test('HR23 项目带没带卡片代码：只列键；没列出来、列失败、刚有人写了卡都搁着；确知没有才不搁；新会话重新列', async () => {
  const handlers = { message: [], open: [], close: [] };
  const sent = [];
  const endpoint = {
    send: (m) => { sent.push(m); return true; },
    onMessage: (h) => handlers.message.push(h), onOpen: (h) => handlers.open.push(h), onClose: (h) => handlers.close.push(h), connected: false,
  };
  let items = [];
  let fail = false;
  let lists = 0;
  const content = { async list(kind) { lists += 1; assert.equal(kind, 'card-source'); if (fail) throw Object.assign(new Error('x'), { code: 'timeout' }); return { items, truncated: false }; } };
  let now = 1000;
  const p = createCardPresence({ endpoint, content, now: () => now, refreshMs: 15_000, retryMs: 2000 });
  const tickAll = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  assert.equal(p.state(), 'unknown');
  assert.equal(p.hold(), true, '还没列出来：搁着');
  for (const h of handlers.open) h();
  await tickAll();
  assert.equal(p.state(), 'none');
  assert.equal(p.hold(), false, '确知没有卡片代码：不搁');
  assert.deepEqual(sent.map((m) => [m.type, m.kinds]), [['content.watch', ['card-source']]], '只订阅、只列键，没有取任何正文');
  // 有人写了一份卡片源码：当场按「有」算，再重列确认
  items = [{ key: 'src/cards/user/x.tsx' }];
  for (const h of handlers.message) h({ type: 'content.changed', kind: 'card-source', key: 'src/cards/user/x.tsx', rev: 1 });
  assert.equal(p.hold(), true);
  await tickAll();
  assert.deepEqual([p.state(), p.status().count], ['some', 1]);
  for (const h of handlers.message) h({ type: 'content.changed', kind: 'snapshot-manifest', key: 'k' });
  // 别的类不理
  const before = lists;
  await tickAll();
  assert.equal(lists, before);
  // 兜底重列：到点才列；列失败时不往「没有」走
  items = [];
  fail = true;
  now += 15_000;
  p.tick();
  await tickAll();
  assert.equal(p.state(), 'some', '列失败：原来有就还按有');
  fail = false;
  now += 1000;
  p.tick();
  await tickAll();
  assert.equal(p.state(), 'some', '还没到重试的点');
  now += 1500;
  p.tick();
  await tickAll();
  assert.equal(p.state(), 'none');
  // 断开、新会话：不沿用「没有」
  for (const h of handlers.close) h({});
  assert.equal(p.hold(), true);
  for (const h of handlers.open) h();
  await tickAll();
  assert.equal(p.hold(), false);
  p.close();
});

const call = (port, pathname, { key, method = 'GET', body, headers = {} } = {}) => fetch(`http://127.0.0.1:${port}${pathname}`, {
  method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined,
}).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));

test('HR23 代理口按工作进程分口令：隔离工作进程只看得到、只要得到它那一个项目；口令作废后什么都要不到；诊断各记各的；浏览器发来的请求不答', async () => {
  const reports = { resident: [], isolated: [] };
  const tickets = [];
  let iso = { name: 'isolated', key: 'iso-key-round-1', listing: () => ({ docUrl: 'ws://x', paused: false, limit: 1, projects: [{ projectId: 'sp_cards', nodeId: 'hosted-render-iso:i/cards' }] }), report: (b) => reports.isolated.push(b) };
  const logs = [];
  const broker = createBroker({
    key: 'resident-key',
    listing: () => ({ docUrl: 'ws://x', paused: false, limit: 1, projects: [{ projectId: 'sp_cards' }, { projectId: 'sp_other' }] }),
    report: (b) => reports.resident.push(b),
    clients: () => (iso ? [iso] : []),
    ticket: async (projectId, client) => { tickets.push([projectId, client]); return { ticket: `ticket-for-${projectId}` }; },
    status: () => ({ fine: true }),
    log: (event, fields) => logs.push([event, fields]),
  });
  const { port } = await broker.listen(0);
  try {
    const resident = await call(port, '/projects', { key: 'resident-key' });
    assert.deepEqual(resident.body.projects.map((p) => p.projectId), ['sp_cards', 'sp_other']);
    const isoList = await call(port, '/projects', { key: 'iso-key-round-1' });
    assert.deepEqual(isoList.body.projects.map((p) => p.projectId), ['sp_cards'], '隔离工作进程的清单里只有它那一个项目，看不到别的项目的 id');
    assert.equal((await call(port, '/ticket', { key: 'iso-key-round-1', method: 'POST', body: { projectId: 'sp_cards' } })).body.ticket, 'ticket-for-sp_cards');
    const stolen = await call(port, '/ticket', { key: 'iso-key-round-1', method: 'POST', body: { projectId: 'sp_other' } });
    assert.deepEqual([stolen.status, stolen.body.error, stolen.body.ticket], [403, 'not-listed', undefined], '凭隔离工作进程的口令要不到别的项目的票据');
    assert.equal((await call(port, '/ticket', { key: 'resident-key', method: 'POST', body: { projectId: 'sp_other' } })).status, 200);
    assert.deepEqual(tickets, [['sp_cards', 'isolated'], ['sp_other', 'resident']]);
    await call(port, '/report', { key: 'iso-key-round-1', method: 'POST', body: { pid: 2, queue: { who: 'iso' } } });
    await call(port, '/report', { key: 'resident-key', method: 'POST', body: { pid: 1, queue: { who: 'resident' } } });
    assert.deepEqual([reports.resident.map((r) => r.queue.who), reports.isolated.map((r) => r.queue.who)], [['resident'], ['iso']], '诊断各记各的，隔离工作进程盖不掉常驻的');
    // 这一轮结束：口令作废；下一轮是新口令
    iso = null;
    assert.equal((await call(port, '/projects', { key: 'iso-key-round-1' })).status, 401);
    assert.equal((await call(port, '/ticket', { key: 'iso-key-round-1', method: 'POST', body: { projectId: 'sp_cards' } })).status, 401);
    iso = { name: 'isolated', key: 'iso-key-round-2', listing: () => ({ projects: [{ projectId: 'sp_other' }] }), report() {} };
    assert.equal((await call(port, '/projects', { key: 'iso-key-round-1' })).status, 401, '上一轮的口令在下一轮不认');
    assert.deepEqual((await call(port, '/projects', { key: 'iso-key-round-2' })).body.projects.map((p) => p.projectId), ['sp_other']);
    assert.equal((await call(port, '/projects', { key: '' })).status, 401);
    // 浏览器发来的（页面脚本去不掉这两个头）：连状态口也不答，带对了口令也不答
    assert.equal((await call(port, '/status', {})).status, 200);
    assert.equal((await call(port, '/status', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await call(port, '/status', { headers: { origin: 'http://127.0.0.1:5400' } })).status, 403);
    assert.equal((await call(port, '/projects', { key: 'resident-key', headers: { 'sec-fetch-site': 'same-site' } })).status, 403);
    assert.ok(logs.some(([event]) => event === 'broker.browser-refused'));
    assert.ok(!JSON.stringify(logs).includes('resident-key') && !JSON.stringify(logs).includes('iso-key'), '日志里没有口令');
  } finally {
    await broker.close();
  }
});

test('HR23 交给工作进程的环境：没有管理进程的配置、集群令牌、名字像秘密的变量；配置项的缺省与取值', () => {
  const env = scrubWorkerEnv({
    PATH: '/usr/bin', HOME: '/root', LANG: 'C', PUPPETEER_EXECUTABLE_PATH: '/x/chrome', PC_CHROME_ARGS: '--a', PROMPTCUT_PAGE_GATE: 'log', PROMPTCUT_TEST_ENV_FINGERPRINT: 'f',
    PROMPTCUT_RENDER_SECRETS: '/secrets', PROMPTCUT_RENDER_BROKER_KEY: 'old', PROMPTCUT_HOSTED_WORKER: 'isolated', PROMPTCUT_CLUSTER_TOKEN: 't', PROMPTCUT_SHARED_CONFIG: 'c',
    PROMPTCUT_CARD_SYNC: '1', PROMPTCUT_CARD_OVERRIDES: '/elsewhere', AWS_SECRET_ACCESS_KEY: 's', GITHUB_TOKEN: 'g', DB_PASSWORD: 'p', OPENAI_API_KEY: 'k', MY_CREDENTIALS: 'c', SESSION_COOKIE: 'c',
    KEYBOARD_LAYOUT: 'us', MONKEY: 'm',
  });
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'KEYBOARD_LAYOUT', 'LANG', 'MONKEY', 'PATH', 'PC_CHROME_ARGS', 'PROMPTCUT_PAGE_GATE', 'PROMPTCUT_TEST_ENV_FINGERPRINT', 'PUPPETEER_EXECUTABLE_PATH']);
  const base = { PROMPTCUT_RENDER_DATA: path.join(ROOT, 'out', 'x-render') };
  const c = renderServiceConfig(base);
  assert.deepEqual([c.userCards, c.isoPort, c.isoIdleMs, c.isoSliceMs, c.loadHigh], ['isolated', 5410, 60_000, 300_000, null]);
  assert.equal(c.isoDataDir, path.join(c.dataDir, 'iso'));
  const d = renderServiceConfig({ ...base, PROMPTCUT_RENDER_USER_CARDS: 'off', PROMPTCUT_RENDER_PORT: '5730', PROMPTCUT_RENDER_ISO_PORT: '5733', PROMPTCUT_RENDER_ISO_IDLE_MS: '8000', PROMPTCUT_RENDER_LOAD_HIGH: '4' });
  assert.deepEqual([d.userCards, d.isoPort, d.isoIdleMs, d.loadHigh], ['off', 5733, 8000, 4]);
  assert.equal(renderServiceConfig({ ...base, PROMPTCUT_RENDER_PORT: '5730' }).isoPort, 5740, '缺省是工作进程的端口 + 10');
  assert.equal(renderServiceConfig({ ...base, PROMPTCUT_RENDER_USER_CARDS: 'whatever' }).userCards, 'isolated');
  assert.deepEqual([hostedWorkerKind({ PROMPTCUT_HOSTED_WORKER: 'isolated' }), hostedWorkerKind({ PROMPTCUT_HOSTED_WORKER: 'resident' }), hostedWorkerKind({ PROMPTCUT_HOSTED_WORKER: 'x' }), hostedWorkerKind({})], ['isolated', 'resident', null, null]);
});

/* ================================================================== HR28 页面一侧的闸 */

/** 假的开发服务器：记下注册的中间件与升级监听 */
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
      return { passed, status: res.statusCode, headers: res.headers, body: res.body };
    },
  };
}

test('HR28 闸只在托管方的工作进程里装；装上之后浏览器发来的请求按表放行，其余 403；只记不拦的模式照放；浏览器发的升级被掐', async () => {
  assert.equal(hostedGateWanted({}), false);
  assert.equal(hostedGateWanted({ PROMPTCUT_RENDER_BROKER: 'http://127.0.0.1:1' }), true);
  assert.deepEqual([hostedGateMode({}), hostedGateMode({ PROMPTCUT_PAGE_GATE: 'log' }), hostedGateMode({ PROMPTCUT_PAGE_GATE: 'off' })], ['enforce', 'log', 'enforce'], '没有「关掉」这个取值');
  const none = fakeViteServer();
  assert.equal(await installHostedGate(none, { prerender: true, env: {} }), null, '桌面版、普通的独立渲染主机：什么都不装');
  assert.equal(none.stack.length, 0);

  // 编辑器的 Vite：浏览器发来的一律拒；Node 一侧的照旧
  const lines = [];
  const editor = fakeViteServer();
  const envE = { PROMPTCUT_RENDER_BROKER: 'http://127.0.0.1:1' };
  const gateE = await installHostedGate(editor, { prerender: false, env: envE, write: (l) => lines.push(l) });
  assert.equal(gateE.proxy, null, '卡片出口代理不再启用');
  assert.equal(envE.PC_CHROME_ARGS, undefined);
  assert.equal(editor.run({ url: '/api/frames/queue', headers: {} }).passed, true);
  const refused = editor.run({ url: '/api/frames/queue', headers: { 'sec-fetch-site': 'same-site' } });
  assert.deepEqual([refused.passed, refused.status, JSON.parse(refused.body).reason], [false, 403, 'editor-no-pages']);
  assert.equal(editor.run({ url: '/src/main.tsx', headers: { 'sec-fetch-site': 'cross-site', origin: 'http://127.0.0.1:9' } }).passed, false);
  const sockets = [];
  const sock = () => { const s = { destroyed: false, destroy() { this.destroyed = true; } }; sockets.push(s); return s; };
  editor.httpServer.emit('upgrade', { url: '/', headers: { origin: 'http://127.0.0.1:5401', upgrade: 'websocket' } }, sock());
  editor.httpServer.emit('upgrade', { url: '/', headers: { upgrade: 'websocket' } }, sock());
  assert.deepEqual(sockets.map((s) => s.destroyed), [true, false], '带 Origin 的升级（浏览器发的）被掐；Node 一侧的连接照旧');
  assert.ok(lines.some((l) => l.startsWith('[page-gate] deny ') && l.includes('"reason":"websocket"')));
  assert.equal(gateE.counts().total, 3);

  // 预渲染的 Vite：页面结构头与 API 闸独立；没有出口白名单；开发工具的口拒
  const pre = fakeViteServer();
  const envP = { PROMPTCUT_RENDER_BROKER: 'http://127.0.0.1:1', PC_CHROME_ARGS: '--existing' };
  const gateP = await installHostedGate(pre, { prerender: true, env: envP, write: () => {} });
  try {
    const page = pre.run({ url: '/src/main.tsx', headers: { 'sec-fetch-site': 'same-origin' } });
    assert.deepEqual([page.passed, page.headers["connection-allowlist"]], [true, undefined]);
    assert.equal(page.headers['content-security-policy'], undefined, '脚本资源不是结构策略目标');
    assert.equal(pre.run({ url: '/?export=1', headers: { 'sec-fetch-dest': 'document' } }).headers['content-security-policy'], "frame-src 'none'; object-src 'none'; base-uri 'none'");
    assert.equal(pre.run({ url: '/?export=1', headers: { 'sec-fetch-site': 'none' } }).passed, true, 'puppeteer 直接开的导航');
    assert.equal(pre.run({ url: '/api/frames/queue', headers: { 'sec-fetch-site': 'same-origin' } }).status, 403);
    assert.equal(pre.run({ url: '/api/frames/queue/release', method: 'POST', headers: { 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:5555' } }).status, 403);
    assert.equal(pre.run({ url: '/aPi/cards/list', headers: { 'sec-fetch-site': 'same-origin' } }).status, 403, '大小写不敏感');
    assert.equal(pre.run({ url: '/__open-in-editor?file=package.json', headers: { 'sec-fetch-site': 'same-origin' } }).status, 403);
    assert.equal(pre.run({ url: '/api/cards/scopes', headers: { 'sec-fetch-site': 'same-origin' } }).passed, true, '放行表里唯一的一条');
    assert.equal(pre.run({ url: '/src/main.tsx', headers: { 'sec-fetch-site': 'same-site' } }).status, 403, '另一个工作进程的页面');
    assert.equal(pre.run({ url: '/src/main.tsx', headers: { 'sec-fetch-site': 'cross-site', origin: 'null' } }).status, 403, '不透明来源的子框架');
    assert.equal(pre.run({ url: '/api/frames/queue', headers: {} }).passed, true, 'Node 一侧的调用');
    assert.equal(envP.PC_CHROME_ARGS, "--existing", "不追加出口代理或UDP限制参数");
    assert.equal(gateP.proxy, null);
  } finally {
    await gateP.proxy?.close();
  }

  // 预渲染 → 编辑器的转发：预渲染一侧给放行了的浏览器请求盖通行记号；编辑器一侧凭它只放行素材那三类路径的只读请求
  const envShared = { PROMPTCUT_RENDER_BROKER: 'x' };
  const ed = fakeViteServer();
  await installHostedGate(ed, { prerender: false, env: envShared, write: () => {} });
  const passValue = envShared[GATE_PASS_ENV];
  assert.match(passValue, /^[0-9a-f]{48}$/, '编辑器进程生成通行记号，放进环境给它起的预渲染进程');
  const pr = fakeViteServer();
  const gatePr = await installHostedGate(pr, { prerender: true, env: envShared, write: () => {} });
  try {
    assert.equal(envShared[GATE_PASS_ENV], passValue, '预渲染进程只读不改');
    const seen = [];
    pr.stack.push((req) => seen.push(req.headers[GATE_PASS_HEADER]));
    const forwardedHeaders = (req) => { const r = { method: 'GET', headers: {}, resume() {}, ...req }; pr.stack[0](r, { setHeader() {}, end() {} }, () => {}); return r.headers; };
    assert.equal(forwardedHeaders({ url: '/@media/' + 'a'.repeat(64), headers: { 'sec-fetch-site': 'same-origin' } })[GATE_PASS_HEADER], passValue);
    assert.equal(forwardedHeaders({ url: '/@media/' + 'a'.repeat(64), headers: { 'sec-fetch-site': 'same-origin', [GATE_PASS_HEADER]: 'forged-by-page' } })[GATE_PASS_HEADER], passValue, '页面自己带来的同名头先被摘掉');
    assert.equal(forwardedHeaders({ url: '/api/frames/queue', headers: {} })[GATE_PASS_HEADER], undefined, 'Node 一侧的调用不盖');
    const relayed = (url, method = 'GET', value = passValue) => ed.run({ url, method, headers: { 'sec-fetch-site': 'same-origin', [GATE_PASS_HEADER]: value } });
    assert.equal(relayed('/@media/' + 'a'.repeat(64)).passed, true);
    assert.equal(relayed('/api/asset/media/' + 'a'.repeat(64), 'HEAD').passed, true);
    assert.equal(relayed('/api/media/file?path=x').passed, true);
    assert.equal(relayed('/api/media/upload/x', 'POST').status, 403, '写方法不放');
    assert.equal(relayed('/api/frames/queue').status, 403, '不是素材路径不放');
    assert.equal(relayed('/api/cards/list').status, 403);
    assert.equal(relayed('/@media/' + 'a'.repeat(64), 'GET', 'wrong').status, 403, '记号不对');
    assert.equal(relayed('/@media/' + 'a'.repeat(64), 'GET', '').status, 403);
    assert.deepEqual([relayAllowed('/@media/x', 'GET'), relayAllowed('//api//asset/x', 'HEAD'), relayAllowed('/api/media/x', 'POST'), relayAllowed('/api/cards/x', 'GET')], [true, true, false, false]);
  } finally {
    await gatePr.proxy?.close();
  }

  // 只记不拦
  const logOnly = fakeViteServer();
  const noted = [];
  const gateL = await installHostedGate(logOnly, { prerender: false, env: { PROMPTCUT_RENDER_BROKER: 'x', PROMPTCUT_PAGE_GATE: 'log' }, write: (l) => noted.push(l) });
  assert.equal(logOnly.run({ url: '/api/frames/queue', headers: { 'sec-fetch-site': 'same-site' } }).passed, true);
  assert.ok(noted.some((l) => l.startsWith('[page-gate] would-deny ')));
  assert.equal(gateL.mode, 'log');
  // 判定本身（纯函数）与开发工具的口
  assert.deepEqual(pageGate({ url: '/__open-in-editor?file=x', method: 'GET', headers: { 'sec-fetch-site': 'same-origin' }, prerender: true }), { browser: true, allow: false, reason: 'dev-tool' });
});

/* ================================================================== HR32 同步文件预检 */

const ok = (rel, source) => assert.deepEqual(checkSyncedSource(rel, source), { ok: true, errors: [] }, `${rel}: ${source.slice(0, 80)}`);
const bad = (rel, source, pattern) => {
  const r = checkSyncedSource(rel, source);
  assert.equal(r.ok, false, `该拒：${source.slice(0, 100)}`);
  if (pattern) assert.match(r.errors.join(' | '), pattern, source.slice(0, 100));
};

test('HR32 样式：普通规则与不读文件的 @ 规则放行；本地 @import 只许相对路径的 .css 且仍在卡片目录里；@plugin / @config / @source / @reference 等一律拒；url() 不许走出 src', () => {
  const css = 'src/cards/user/a.css';
  ok(css, '.a { color: red; content: "\\201C"; } @media (min-width: 10px) { .b { background: url(./x.png) } }');
  ok(css, '@keyframes k { from { opacity: 0 } to { opacity: 1 } } @font-face { font-family: X; src: url("/src/fonts/x.woff2") format("woff2"); } @layer base { .c { color: blue } } @supports (display: grid) { .d { display: grid } }');
  ok(css, '@import "./b.css"; @import \'../../parts/lib/shared.css\'; .e { background: url(data:image/png;base64,AAAA) url(https://example.invalid/x.png) }');
  ok(css, '/* @plugin "./x.ts" 只是注释 */ .f::after { content: "@import \\"x\\"" } @apply { }');
  bad(css, '@import "/etc/passwd";', /@import 只许相对路径/);
  bad(css, '@import "../../../../etc/passwd.css";', /走出了 src\/cards 或 src\/parts/);
  bad(css, '@import "../../kernel/x.css";', /走出了/);
  bad(css, '@import url("./b.css");', /@import 只许写成/);
  bad(css, '@import "./b.css" layer(x);', /@import 只许写成/);
  bad(css, '@import "tailwindcss" source("/etc");', /@import 只许/);
  bad(css, '@import "./b.css?inline";', /@import 只许相对路径/);
  for (const name of ['plugin', 'config', 'source', 'reference', 'tailwind', 'PLUGIN']) bad(css, `@${name} "./x.ts";`, /不许的 @ 规则/);
  bad(css, '@\\70lugin "./x.ts";', /转义|不许的/);
  bad(css, '.a { background: url("../../../../../../etc/passwd?inline") }', /走出了 src/);
  bad(css, '.a { background: url(../../../../secret.key) }', /走出了 src/);
  bad(css, '.a { background: url("/@fs/etc/passwd?inline") }', /内部路径/);
  // 以 / 开头：开发服务器找不到「相对项目根」的就当文件系统的绝对路径读——只认项目根下确实有的
  bad(css, '.a { background: url("/etc/passwd?inline") }', /根路径只许 \/src\//);
  bad(css, '.a { background: url(/tmp/secret.svg) }', /根路径只许/);
  const rootHas = (p) => p === 'src/cards/a.png' || p === 'public/fonts/x.woff2';
  assert.equal(checkSyncedSource(css, '.a { background: url(/src/cards/a.png); src: url("/fonts/x.woff2") }', { rootHas }).ok, true);
  assert.match(checkSyncedSource(css, '.a { background: url(/src/cards/missing.svg) }', { rootHas }).errors[0], /项目根下没有的文件/);
  assert.match(checkSyncedSource(css, '.a { background: url("/etc/hostname?inline") }', { rootHas }).errors[0], /项目根下没有的文件/);
  bad(css, '.a { background: url("/src/../../x?inline") }', /带 \.\./);
  bad(css, '.a { background: url(file:///etc/passwd) }', /不许的协议 file:/);
  bad(css, '.a { background: url("C:\\\\secret.txt") }', /反斜杠/);
  bad(css, '.a { background-image: image-set("../../../../../etc/passwd?inline" 1x) }', /走出了 src/);
  bad(css, '.a { color: red } /*# sourceMappingURL=../../../../etc/passwd */', /sourceMappingURL/);
  bad('src/kernel/a.css', '.a{}', /不在 src\/cards 或 src\/parts/);
  bad('src/cards/user/../../kernel/a.css', '.a{}', /不在 src\/cards/);
  bad('src/cards/user/a.json', '{}', /只收/);
  assert.deepEqual(scanCss('@media x { a { b: url( "q.png" ) } } /* @x */ @import "y";').atRules.map((r) => r.name), ['media', 'import']);
  assert.equal(rejectedStub('src/cards/user/a.css', ['x']).startsWith('/* '), true);
  assert.match(rejectedStub('src/cards/user/a.tsx', ['why']), /^throw new Error\("托管方渲染服务没有载入这个文件/);
  assert.match(rejectedStub('src/cards/user/a.tsx', ['why'], { raw: true }), /^export default "/);
});

test('HR32 脚本：包名与 src 里的相对路径放行；走出 src、/@fs/、file:、包名里带 ..、非字面量的动态导入、越界的 import.meta.glob 与 new URL 一律拒', () => {
  const ts = 'src/cards/user/a.tsx';
  ok(ts, 'import React, { useEffect } from "react"; import type { CardDef } from "../../kernel/types"; import x from "./lib"; import s from "./a.css"; const three = import("three"); export { y } from "../../parts/lib/y"; export const a = <div />;');
  ok(ts, 'const g = import.meta.glob("./*.tsx", { eager: true, query: "?raw" }); const h = import.meta.glob(["./a/*.ts", "/src/parts/**/*.ts"]); const e = import.meta.env.DEV; const u = new URL("./a.png", import.meta.url); const v = new URL("https://x.invalid/a"); import j from "/src/cards/capabilities.json"; import n from "node:path";');
  ok(ts, 'const f = new Function("u", "return import(u)"); const t: typeof import("three") = null as any;');
  bad(ts, 'import x from "../../../../etc/passwd?raw";', /走出了 src/);
  bad(ts, 'import x from "../../../server/hosted-render/main.mjs";', /走出了 src/);
  bad(ts, 'import x from "/@fs/C:/secret.json?raw";', /内部路径/);
  bad(ts, 'import x from "/etc/passwd?raw";', /根路径只许 \/src\//);
  bad(ts, 'import x from "file:///etc/passwd";', /不许的协议 file:/);
  bad(ts, 'import x from "react/../../../etc/passwd?raw";', /包名里带/);
  bad(ts, 'import x from "//evil.invalid/x.js";', /协议相对/);
  bad(ts, 'export * from "../../../../x";', /走出了 src/);
  bad(ts, 'import x = require("../../../../x");', /走出了 src/);
  bad(ts, 'const m = import(`./${name}.ts`);', /动态 import\(\) 的参数要是字符串字面量/);
  bad(ts, 'const m = import("./" + name);', /字符串字面量/);
  bad(ts, 'const m = import(/* @vite-ignore */ url);', /字符串字面量/);
  bad(ts, 'const m = import("../../../../x.json");', /走出了 src/);
  bad(ts, 'const g = import.meta.glob("../../../../**/*");', /走出了 src/);
  bad(ts, 'const g = import.meta.glob("/../../**/*.json");', /只许 \.\/、\.\.\/ 或 \/src\/ 开头/);
  bad(ts, 'const g = import.meta.glob(pattern);', /字符串字面量/);
  bad(ts, 'const g = import.meta.glob("./*.ts", { base: "/etc" });', /base/);
  bad(ts, 'const g = import.meta.glob("./*.ts", opts);', /对象字面量/);
  bad(ts, 'const g = import.meta.glob; g("../../../**");', /只能直接调用/);
  bad(ts, 'const g = import.meta["glob"]("../../../../**");', /走出了 src/);
  bad(ts, 'const u = new URL("../../../../secret.json", import.meta.url);', /走出了 src/);
  bad(ts, 'const u = new URL(`../${a}.json`, import.meta.url);', /字符串字面量/);
  bad(ts, 'export const a = 1;\n//# sourceMappingURL=../../../../secret.json', /sourceMappingURL/);
  bad(ts, '/** @jsxImportSource ../../../../evil */\nexport const a = <div />;', /jsxImportSource/);
  bad(ts, 'x'.repeat(600 * 1024), /超过/);
  // 行号
  assert.match(checkSyncedSource(ts, 'const a = 1;\n\nimport x from "../../../../x";').errors[0], /^第 3 行/);
});

test('HR32 越权探测卡的夹具：主卡、清单、记号卡、图卡过得了预检；Node 一侧读盘的那两份被整份拒掉，每一种写法各有一条理由', () => {
  const read = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
  for (const name of ['overreach-probe.tsx', 'overreach-probe-lib.ts', 'overreach-marker-jia.tsx', 'overreach-graph.tsx']) {
    assert.deepEqual(checkSyncedSource(`src/cards/user/${name}`, read(name)), { ok: true, errors: [] }, name);
  }
  // 探针怎么填占位符，这里就怎么填（绝对路径与十几层 ..）
  const rel = `${'../'.repeat(16)}tmp/outside/probe-fake-outside.json`;
  const fill = (text) => text.replaceAll('__OUTSIDE_DIR_REL__', rel.replace(/\/[^/]+$/, '')).replaceAll('__OUTSIDE_REL__', rel).replaceAll('__OUTSIDE_DIR__', '/tmp/outside').replaceAll('__OUTSIDE__', '/tmp/outside/probe-fake-outside.json');
  const css = checkSyncedSource('src/cards/user/overreach-node-side.css', fill(read('overreach-node-side.css')));
  assert.equal(css.ok, false);
  const cssWhy = css.errors.join(' | ');
  for (const pattern of [/@import 只许相对路径/, /不许的 @ 规则：@reference/, /不许的 @ 规则：@source/, /不许的 @ 规则：@plugin/, /不许的 @ 规则：@config/, /样式里的路径/]) assert.match(cssWhy, pattern);
  const script = checkSyncedSource('src/cards/user/overreach-node-side.ts', fill(read('overreach-node-side.ts')));
  assert.equal(script.ok, false);
  const why = script.errors.join(' | ');
  for (const pattern of [/导入的模块走出了 src/, /内部路径（\/@…）/, /import\.meta\.glob 的模式走出了 src/, /只许 \.\/、\.\.\/ 或 \/src\/ 开头/, /new URL\(…, import\.meta\.url\) 的路径走出了 src/, /动态 import\(\) 的参数要是字符串字面量/]) assert.match(why, pattern);
  // 夹具文件头都写明了自己是什么
  for (const name of fs.readdirSync(FIXTURES)) {
    const head = read(name).slice(0, 900);
    assert.match(head, /测试夹具/, name);
    assert.match(head, /不是攻击代码/, name);
    if (/^overreach-(probe|graph)|node-side/.test(name)) assert.match(head, /只读/, name);
  }
});

test('HR32 远端 CSS import 留给浏览器；协议相对裸字符串等价转 url，Node 不读远端', async () => {
  const { compile } = await import('tailwindcss');
  const css = 'src/cards/user/remote.css';
  for (const source of [
    '@import "http://example.invalid/a.css";',
    '@import "https://example.invalid/a.css" layer(cards) supports(display: grid) screen;',
    '@import url("https://example.invalid/a.css") layer(cards) screen;',
    '@import url(//example.invalid/a.css) screen;',
    '@import "//example.invalid/a.css" layer(cards) screen;',
    "@import '//example.invalid/a.css' supports(display: grid);",
  ]) {
    ok(css, source);
    const prepared = normalizeBrowserCssImports(source);
    const reads = [];
    const compiled = await compile(prepared, { loadStylesheet: async id => { reads.push(id); throw new Error('远端导入不可触发 Node 文件读取'); } });
    const result = compiled.build([]);
    assert.deepEqual(reads, [], source);
    assert.match(result, /example\.invalid\/a\.css/);
    if (!source.includes('"//') && !source.includes("'//")) assert.equal(prepared, source);
  }
  assert.equal(normalizeBrowserCssImports('/* @import "//x/a.css"; */ @import "./b.css";'), '/* @import "//x/a.css"; */ @import "./b.css";');
  assert.equal(normalizeBrowserCssImports('@import /* "//x/a.css" */ "//x/a.css";'), '@import /* "//x/a.css" */ url("//x/a.css");');
  for (const source of ['@import "file:///etc/a.css";', '@import url(file:///etc/a.css);', '@plugin "./p.ts";', '@config "./p.ts";', '@source "/etc";', '@reference "http://example.invalid/a.css";']) bad(css, source, /@import|不许的|协议/);
});
