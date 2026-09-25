/**
 * 独立渲染主机(M6b,契约 `docs/plan/render-host-contract.md` 第 5 节「单测」)。
 * 跑:npm test(全局 setup 占住本机的坏端口;单测一律用端口 0)。
 *
 *   RH1  配置解析:单项、数组、缺字段报错;maxConcurrent 缺省 1、上限 4、环境变量覆盖;render-host 的参数与子进程环境变量
 *   RH2  多项目开多条连接:真文档服务(托管端,凭证握手)上两个共享项目,每项一条 render 连接、一个 host 节点,
 *        node.hello 的 profile / codeVersions / capabilities 对;各自只见、只做自己项目的任务
 *   RH3  plan 跳过:host 节点见到 plan 不发认领(同一队列上的 pc 节点照常认领);细任务照常认领
 *   RH4  并发上限:两个项目共 6 个任务,maxConcurrent 为 1、2 时全部节点的持有 + 在飞任何一拍都不超过上限,且到达上限
 *   RH5  退出时让掉认领:shutdown 对每个持有发 task.release,队列立即放回 open(不等断线宽限),别的节点马上能认领;执行被中止
 *   RH6  代码版本过滤照旧:codeVersion 不同的 host 看得见任务、认领 0 次
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { createRenderQueue } from '../render-queue/index.mjs';
import { createLocalNode } from '../render-node/local-node.mjs';
import { planTaskOf } from '../render-node/split.mjs';
import { checkClaimable } from '../render-node/filter.mjs';
import { createWsEndpoint } from '../render-node/ws-transport.mjs';
import { createRenderHost, loadHostConfig, hostMaxConcurrent, HOST_MAX_CONCURRENT, HOST_CAPABILITIES, renderHostArgs as parseArgs, renderHostEnv as hostEnv } from '../render-node/host.mjs';
import { normalizeEntry, sharedProtocols } from '../auth/shared-config.mjs';
import { createLoopback } from './fake-loopback-transport.mjs';
import { createTimerClock } from './fake-render-executor.mjs';
import { startSharedService, createProject, join, tempDir, deviceId } from './fake-shared-env.mjs';
import { byType } from './fake-ws-kit.mjs';

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const FP = 'fedcba9876543210';
const CV = 'c0de-rh';
const STEP_MS = 250;

/* ------------------------------------------------------------------ 夹具 */

function fineTask(projectId, label, { cv = CV, from = 0, to = 29 } = {}) {
  const contentKey = sha256(`ck:${projectId}:${label}`);
  const resultKey = sha256(`${contentKey}\n${FP}`);
  return {
    id: `snapshot:${resultKey}:${from}-${to}`, kind: 'snapshot', tier: 'shared', resultKey,
    range: { unit: 'localFrame', from, to },
    source: { projectId, projectRev: 1 },
    input: { clipId: `clip-${label}`, cardId: `card-${label}`, entryKey: null, contentKey },
    weight: { class: 'medium', estMs: null, frames: to - from + 1 },
    requires: { envFingerprint: FP, codeVersion: cv, cardSources: {}, transcode: false, userCards: false, graphCards: false, belowDependent: false },
    priority: 10,
  };
}

/** 执行器:`hang` 为真时 render 永不返回(只能被中止),否则立即完成。plan 不该被 host 调到 */
function fakeExecutor({ hang = false } = {}) {
  const calls = { render: [], plan: [], aborted: [] };
  return {
    calls,
    async plan(task) { calls.plan.push(task.id); return { entryKey: 'e', cardPlan: [] }; },
    render(task, { signal } = {}) {
      calls.render.push(task.id);
      signal?.addEventListener('abort', () => calls.aborted.push(task.id), { once: true });
      if (hang) return new Promise(() => {});
      return Promise.resolve({ fake: task.id });
    },
  };
}

function fakeSink() {
  const puts = [];
  return { puts, async has() { return false; }, async put(entry) { puts.push(entry.meta.taskId); return { complete: true, result: {} }; } };
}

/**
 * 进程内拓扑:每个项目一个队列(相当于文档服务上的一个空间)、一条环回传输、一个页面发布方。
 * 主机的 `connect(entry)` 在对应项目的环回上开一条连接。
 */
function createSpaces(projectIds) {
  const clock = createTimerClock();
  const spaces = new Map();
  for (const projectId of projectIds) {
    const lb = createLoopback();
    const queue = createRenderQueue({ now: clock.now, send: lb.queueSend, epoch: `epoch-${projectId}` });
    lb.attach(queue);
    const page = lb.connect(`page-${projectId}`, { userId: 'alice@page-device-0001', tenantId: projectId });
    const inbox = [];
    page.onMessage((m) => inbox.push(m));
    page.send({ type: 'publisher.hello', publisherId: `page-${projectId}` });
    spaces.set(projectId, {
      lb, queue, inbox,
      publish: (tasks) => page.send({ type: 'task.publish', tasks }),
      doneCount: (id) => inbox.filter((m) => m.type === 'task.done' && m.id === id).length,
      sent: (connId) => lb.log().filter((e) => e.dir === 'in' && e.connId === connId).map((e) => e.message),
      task: (id) => queue.describe().tasks.find((t) => t.id === id),
    });
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
  const hygiene = () => {
    for (const s of all) {
      assert.deepEqual(s.lb.errors().map((e) => String(e?.stack ?? e)), [], '端点处理器 / queue.handle 抛出了异常');
      assert.deepEqual(s.lb.nonJson(), [], '有消息不能 JSON 往返');
    }
  };
  return { clock, spaces, all, settle, hygiene };
}

function hostOn(env, { projectIds, cap = 1, cv = CV, executors = new Map(), sinks = new Map() } = {}) {
  const entries = projectIds.map((projectId) => ({ projectId, url: 'ws://unused.invalid/docservice' }));
  const host = createRenderHost({
    entries,
    connect: (entry, index) => ({
      endpoint: env.spaces.get(entry.projectId).lb.connect(`host-${index}`, { userId: 'renderbox@host-device-0001', tenantId: entry.projectId }),
      executor: executors.get(entry.projectId) ?? fakeExecutor(),
      sink: sinks.get(entry.projectId) ?? fakeSink(),
    }),
    nodeIdOf: (_entry, index) => `host:test/p${index}`,
    envFingerprint: FP,
    codeVersion: cv,
    maxConcurrent: cap,
    now: env.clock.now,
    random: () => 0,
  });
  return host;
}

async function drive(env, step, until, maxSteps = 300) {
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

/* ================================================================== RH1 */

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function configFile(content) {
  const dir = tempDir('pc-rh1-');
  dirs.push(dir);
  const file = path.join(dir, 'host.json');
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

const ENTRY = Object.freeze({
  url: 'ws://127.0.0.1:5400/docservice', projectId: 'sp_aaaaaaaaaaaaaaaaaaaaaaaaaa', username: 'renderbox',
  deviceId: 'render-box-device-0001', deviceName: 'Render Box', as: 'member', password: 'secret-pw', role: 'render',
});

test('RH1 配置解析:单项、数组、缺字段报错;maxConcurrent 缺省 1、上限 4、环境变量覆盖', () => {
  assert.equal(loadHostConfig({}), null, '没设环境变量回 null');

  const single = loadHostConfig({ PROMPTCUT_SHARED_CONFIG: configFile(ENTRY) });
  assert.equal(single.entries.length, 1, '单项');
  assert.equal(single.entries[0].projectId, ENTRY.projectId);
  assert.equal(single.entries[0].role, 'render');
  assert.equal(single.maxConcurrent, 1, '缺省 1');

  const second = { ...ENTRY, projectId: 'sp_bbbbbbbbbbbbbbbbbbbbbbbbbb', url: 'ws://127.0.0.1:8787', maxConcurrent: 3 };
  const array = loadHostConfig({ PROMPTCUT_SHARED_CONFIG: configFile([ENTRY, second]) });
  assert.deepEqual(array.entries.map((e) => e.projectId), [ENTRY.projectId, second.projectId], '数组按顺序');
  assert.equal(array.maxConcurrent, 3, '取各项里给的最大值');

  assert.equal(loadHostConfig({ PROMPTCUT_SHARED_CONFIG: configFile([{ ...ENTRY, maxConcurrent: 9 }]) }).maxConcurrent, HOST_MAX_CONCURRENT, '上限 4');
  assert.equal(loadHostConfig({ PROMPTCUT_SHARED_CONFIG: configFile([ENTRY, second]), PROMPTCUT_HOST_MAX_CONCURRENT: '2' }).maxConcurrent, 2, '环境变量覆盖');
  assert.equal(hostMaxConcurrent(0), 1);
  assert.equal(hostMaxConcurrent('x'), 1);
  assert.equal(hostMaxConcurrent(2.7), 2);

  for (const [label, bad] of [
    ['缺 username', { ...ENTRY, username: undefined }],
    ['缺口令与 key', { ...ENTRY, password: undefined }],
    ['缺 url', { ...ENTRY, url: undefined }],
    ['缺 projectId 与 name', { ...ENTRY, projectId: undefined }],
    ['角色不对', { ...ENTRY, role: 'admin' }],
  ]) {
    assert.throws(() => loadHostConfig({ PROMPTCUT_SHARED_CONFIG: configFile([ENTRY, bad]) }), (error) => {
      assert.equal(error.code, 'bad-shared-config', label);
      assert.ok(!String(error.message).includes('secret-pw'), `${label}:错误信息里没有口令`);
      return true;
    }, label);
  }
  assert.throws(() => loadHostConfig({ PROMPTCUT_SHARED_CONFIG: configFile('[]') }), { code: 'bad-shared-config' }, '空数组');
  assert.throws(() => loadHostConfig({ PROMPTCUT_SHARED_CONFIG: configFile('{oops') }), { code: 'bad-shared-config' }, '不是 JSON');
  assert.throws(() => loadHostConfig({ PROMPTCUT_SHARED_CONFIG: path.join(tempDir('pc-rh1-none-'), 'missing.json') }), { code: 'bad-shared-config' }, '文件不存在');
});

test('RH1 render-host:参数解析与子进程环境变量(契约第 2 节)', () => {
  assert.deepEqual(parseArgs(['--config', 'h.json']), { port: 5400, config: 'h.json', data: null, maxConcurrent: null, streams: false, verbose: false }, '缺省端口 5400');
  assert.equal(parseArgs(['--port', '5403', '--max-concurrent', '2', '--streams']).port, 5403);
  assert.throws(() => parseArgs(['--max-concurrent', '5']), /1～4/);
  assert.throws(() => parseArgs(['--nope']), /不认识/);
  const env = hostEnv({ PATH: 'x', PROMPTCUT_CLUSTER_TOKEN: 'tok', PROMPTCUT_DOCSERVICE_URL: 'ws://x', PROMPTCUT_HEADLESS: '1', PROMPTCUT_PUSH: '0', PROMPTCUT_ROLE: 'prerender' },
    { config: 'cfg/host.json', data: path.resolve('d'), streams: false, maxConcurrent: 2 });
  assert.equal(env.PROMPTCUT_QUEUE_NODE, '1');
  assert.equal(env.PROMPTCUT_NODE_PROFILE, 'host');
  assert.equal(env.PROMPTCUT_SHARED_CONFIG, path.resolve('cfg/host.json'), '配置文件用绝对路径');
  assert.equal(env.PROMPTCUT_STREAMS, '0');
  assert.equal(env.PROMPTCUT_HOST_MAX_CONCURRENT, '2');
  assert.equal(env.PROMPTCUT_EXPORT_DIR, path.resolve('d'));
  assert.equal(env.TEMP, path.join(path.resolve('d'), 'tmp'), '临时目录在实例自己的数据目录下(不写公共的 port.json)');
  for (const key of ['PROMPTCUT_CLUSTER_TOKEN', 'PROMPTCUT_DOCSERVICE_URL', 'PROMPTCUT_HEADLESS', 'PROMPTCUT_PUSH', 'PROMPTCUT_ROLE']) assert.equal(env[key], undefined, `${key} 删掉`);
  assert.equal(env.PATH, 'x');
  assert.equal(hostEnv({}, { config: 'a', data: 'd', streams: true }).PROMPTCUT_STREAMS, '1');
});

/* ================================================================== RH2 */

test('RH2 多项目开多条连接:两个共享项目各一条 render 连接、一个 host 节点,各自只做自己项目的任务', async () => {
  const svc = await startSharedService({ mode: 'hosted' });   // isLoopback 一律 false:只能凭证明进入
  const pages = [];
  let host = null;
  const endpoints = [];
  try {
    const a = await createProject(svc.base, { name: 'rh2-a', password: 'pw-a' });
    const b = await createProject(svc.base, { name: 'rh2-b', password: 'pw-b' });
    const device = deviceId('rhbox');
    const entries = [
      normalizeEntry({ url: svc.url, projectId: a.projectId, username: 'renderbox', deviceId: device, deviceName: 'Render Box', password: 'pw-a', role: 'render' }),
      normalizeEntry({ url: svc.url, projectId: b.projectId, username: 'renderbox', deviceId: device, deviceName: 'Render Box', password: 'pw-b', role: 'render' }),
    ];
    const executors = new Map(entries.map((e) => [e.projectId, fakeExecutor()]));
    const sinks = new Map(entries.map((e) => [e.projectId, fakeSink()]));
    host = createRenderHost({
      entries,
      connect: (entry) => {
        const endpoint = createWsEndpoint({ url: entry.url, protocols: sharedProtocols(entry, { role: 'render' }), backoff: { baseMs: 50, maxMs: 200 } });
        endpoints.push(endpoint);
        return { endpoint, executor: executors.get(entry.projectId), sink: sinks.get(entry.projectId) };
      },
      nodeIdOf: (_e, i) => `host:rh2/p${i}`,
      envFingerprint: FP, codeVersion: CV, maxConcurrent: 1, now: Date.now,
    });
    host.start();
    const deadline = Date.now() + 20_000;
    while (!host.nodes().every((n) => n.connected) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.equal(host.nodes().length, 2, '两项配置两个节点');
    assert.ok(host.nodes().every((n) => n.connected), `两条连接都连上:${JSON.stringify(host.nodes())}`);
    assert.deepEqual(host.nodes().map((n) => n.projectId), [a.projectId, b.projectId]);

    // 每个项目里一个成员页面发布一个细任务
    const tasks = new Map();
    for (const [project, pw] of [[a, 'pw-a'], [b, 'pw-b']]) {
      const page = await join(svc.base, { projectId: project.projectId, username: 'alice', deviceId: deviceId('page'), password: pw, role: 'page' });
      pages.push(page);
      await page.opened;
      page.send({ type: 'publisher.hello', publisherId: `page-${project.projectId}` });
      await page.next(byType('publisher.welcome'));
      const task = fineTask(project.projectId, 'rh2');
      tasks.set(project.projectId, task);
      page.send({ type: 'task.publish', tasks: [task] });
      await page.next(byType('task.published'));
    }
    const until = Date.now() + 20_000;
    while (Date.now() < until && !(sinks.get(a.projectId).puts.length && sinks.get(b.projectId).puts.length)) {
      host.tick();
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.deepEqual(sinks.get(a.projectId).puts, [tasks.get(a.projectId).id], '项目 A 的节点只做 A 的任务');
    assert.deepEqual(sinks.get(b.projectId).puts, [tasks.get(b.projectId).id], '项目 B 的节点只做 B 的任务');
    for (const n of host.nodes()) assert.equal(n.seen, 1, `每个节点只见到自己项目的 1 个任务:${JSON.stringify(n)}`);
    assert.deepEqual(executors.get(a.projectId).calls.plan, [], '不认领 plan');

    // node.hello:文档服务侧的记录(role.node)与各空间队列里的节点
    const hellos = svc.logs.filter((l) => l.event === 'role.node');
    assert.equal(hellos.length, 2, `两次 node.hello:${JSON.stringify(hellos)}`);
    for (const h of hellos) {
      assert.equal(h.profile, 'host');
      assert.equal(h.userId, `renderbox@${device}`, '身份是「用户名@设备」');
    }
  } finally {
    host?.shutdown();
    for (const ep of endpoints) ep.close();
    for (const p of pages) p.close?.();
    await svc.close();
  }
});

test('RH2 host 节点的 node.hello 字段(profile / codeVersions / capabilities / maxConcurrent)', async () => {
  const env = createSpaces(['proj-a', 'proj-b']);
  const host = hostOn(env, { projectIds: ['proj-a', 'proj-b'], cap: 3 });
  host.start();
  await env.settle();
  for (const [index, projectId] of ['proj-a', 'proj-b'].entries()) {
    const hello = env.spaces.get(projectId).sent(`host-${index}`).find((m) => m.type === 'node.hello');
    assert.ok(hello, `${projectId} 报到了`);
    assert.equal(hello.profile, 'host');
    assert.deepEqual(hello.codeVersions, [CV], '一个实例一个代码版本');
    assert.deepEqual(hello.capabilities, { ...HOST_CAPABILITIES }, '能力与 PC 相同');
    assert.deepEqual(hello.capabilities, { userCards: true, graphCards: false });
    assert.equal(hello.envFingerprint, FP);
    assert.equal(hello.maxConcurrent, 3);
    assert.equal(hello.nodeId, `host:test/p${index}`);
  }
  env.hygiene();
  host.shutdown();
});

/* ================================================================== RH3 */

test('RH3 plan 跳过:host 见到 plan 不发认领,只认领细任务;同一队列上的 pc 节点照常认领 plan', async () => {
  assert.deepEqual(checkClaimable({ ...planTaskOf({ projectId: 'p', projectRev: 1, codeVersion: CV }), state: 'open', version: 1 },
    { profile: 'host', envFingerprint: FP, codeVersions: [CV], capabilities: HOST_CAPABILITIES }), { ok: false, rule: 6, reason: 'plan-on-host' });

  const env = createSpaces(['proj-a']);
  const space = env.spaces.get('proj-a');
  const executor = fakeExecutor();
  const host = hostOn(env, { projectIds: ['proj-a'], cap: 2, executors: new Map([['proj-a', executor]]) });
  host.start();
  const plan = planTaskOf({ projectId: 'proj-a', projectRev: 1, codeVersion: CV, envFingerprint: FP });
  plan.priority = 100;   // 排在最前:host 若不跳过就一定先认领它
  const fine = fineTask('proj-a', 'rh3');
  space.publish([plan, fine]);
  await drive(env, () => host.tick(), () => space.doneCount(fine.id) === 1);
  for (let i = 0; i < 20; i++) { await env.settle(); host.tick(); env.clock.advance(STEP_MS); }
  await env.settle();
  const claims = space.sent('host-0').filter((m) => m.type === 'task.claim').map((m) => m.id);
  assert.deepEqual(claims, [fine.id], 'host 只认领了细任务');
  assert.deepEqual(executor.calls.plan, [], '执行器的 plan 一次都没被调');
  assert.equal(space.task(plan.id).state, 'open', 'plan 留在队列里');
  assert.ok(host.nodes()[0].seen >= 2, 'plan 是看得见的,只是不认领');

  // 对照:pc 节点在同一队列上认领 plan
  const pcEndpoint = space.lb.connect('pc-0', { userId: 'alice@pc-device-000001', tenantId: 'proj-a' });
  const pc = createLocalNode({
    nodeId: 'pc-0', node: { profile: 'pc', envFingerprint: FP, codeVersions: [CV], capabilities: HOST_CAPABILITIES },
    endpoint: pcEndpoint, now: env.clock.now, random: () => 0, isIdle: () => true, maxConcurrent: 1, codeVersion: CV,
    executor: { plan: async () => ({ entryKey: 'e', cardPlan: [] }), render: async () => null }, sink: fakeSink(),
  });
  pc.start();
  await drive(env, () => { host.tick(); pc.tick(); }, () => space.doneCount(plan.id) === 1);
  assert.deepEqual(space.sent('pc-0').filter((m) => m.type === 'task.claim').map((m) => m.id), [plan.id], 'pc 认领了 plan');
  assert.deepEqual(space.sent('host-0').filter((m) => m.type === 'task.claim').map((m) => m.id), [fine.id], 'host 始终没认领 plan');
  env.hygiene();
  host.shutdown();
  pc.stop();
});

/* ================================================================== RH4 */

for (const cap of [1, 2]) {
  test(`RH4 并发上限 maxConcurrent=${cap}:两个项目共 6 个任务,全部节点的持有 + 在飞任何一拍都不超过 ${cap},且会到达 ${cap}`, async () => {
    const projectIds = ['proj-a', 'proj-b'];
    const env = createSpaces(projectIds);
    const executors = new Map(projectIds.map((p) => [p, fakeExecutor({ hang: true })]));
    const host = hostOn(env, { projectIds, cap, executors });
    host.start();
    for (const p of projectIds) env.spaces.get(p).publish([fineTask(p, 'x'), fineTask(p, 'y'), fineTask(p, 'z')]);
    let peak = 0;
    let peakQueue = 0;
    for (let i = 0; i < 80; i++) {
      await env.settle();
      host.tick();
      assert.ok(host.busy() <= cap, `第 ${i} 拍:持有 + 在飞 ${host.busy()} 超过 ${cap}`);
      peak = Math.max(peak, host.busy());
      await env.settle();
      for (const s of env.all) s.queue.tick();
      const claimedInQueues = env.all.reduce((n, s) => n + s.queue.describe().tasks.filter((t) => t.state === 'claimed').length, 0);
      assert.ok(claimedInQueues <= cap, `第 ${i} 拍:队列里被认领的 ${claimedInQueues} 超过 ${cap}`);
      peakQueue = Math.max(peakQueue, claimedInQueues);
      env.clock.advance(STEP_MS);
    }
    assert.equal(peak, cap, '会用满上限');
    assert.equal(peakQueue, cap, '队列那边同时被认领的也到上限');
    const rendering = [...executors.values()].reduce((n, e) => n + e.calls.render.length, 0);
    assert.equal(rendering, cap, `同时在渲的只有 ${cap} 个(执行器卡住不返回)`);
    assert.equal(host.maxConcurrent, cap);
    env.hygiene();
    host.shutdown();
  });
}

test('RH4 并发上限不超过 4:给 9 按 4 算', () => {
  const env = createSpaces(['proj-a']);
  const host = hostOn(env, { projectIds: ['proj-a'], cap: 9 });
  assert.equal(host.maxConcurrent, 4);
});

/* ================================================================== RH5 */

test('RH5 退出时让掉认领:每个持有发 task.release,队列立即放回 open,别的节点马上能认领;执行被中止', async () => {
  const projectIds = ['proj-a', 'proj-b'];
  const env = createSpaces(projectIds);
  const executors = new Map(projectIds.map((p) => [p, fakeExecutor({ hang: true })]));
  const host = hostOn(env, { projectIds, cap: 2, executors });
  host.start();
  const tasks = new Map(projectIds.map((p) => [p, fineTask(p, 'rh5')]));
  for (const p of projectIds) env.spaces.get(p).publish([tasks.get(p)]);
  await drive(env, () => host.tick(), () => projectIds.every((p) => env.spaces.get(p).task(tasks.get(p).id)?.state === 'claimed'));
  assert.equal(host.busy(), 2);

  const released = host.shutdown('shutdown');
  assert.equal(released, 2, '让掉两个认领');
  await env.settle();
  for (const [index, p] of projectIds.entries()) {
    const releases = env.spaces.get(p).sent(`host-${index}`).filter((m) => m.type === 'task.release');
    assert.deepEqual(releases.map((m) => [m.id, m.reason]), [[tasks.get(p).id, 'shutdown']], `${p}:发了 task.release`);
    assert.equal(env.spaces.get(p).task(tasks.get(p).id).state, 'open', `${p}:队列立即放回 open(没有断线,不靠宽限期)`);
    assert.deepEqual(executors.get(p).calls.aborted, [tasks.get(p).id], `${p}:在跑的执行被中止`);
  }
  await host.settled();   // 卡住的执行器被中止后也能落定
  assert.equal(host.busy(), 0);

  // 让出来的任务马上能被别的节点认领
  const space = env.spaces.get('proj-a');
  const other = createLocalNode({
    nodeId: 'other', node: { profile: 'host', envFingerprint: FP, codeVersions: [CV], capabilities: HOST_CAPABILITIES },
    endpoint: space.lb.connect('other', { userId: 'bob@other-device-000001', tenantId: 'proj-a' }), now: env.clock.now, random: () => 0,
    isIdle: () => true, maxConcurrent: 1, codeVersion: CV, executor: fakeExecutor(), sink: fakeSink(),
  });
  other.start();
  await drive(env, () => { host.tick(); other.tick(); }, () => space.doneCount(tasks.get('proj-a').id) === 1, 20);
  // 停下来的 host 之后一条认领都不再发
  const claimsAfterStop = space.sent('host-0').filter((m) => m.type === 'task.claim').length;
  assert.equal(claimsAfterStop, 1, 'host 停了之后不再认领');
  env.hygiene();
  other.stop();
});

/* ================================================================== RH6 */

test('RH6 代码版本过滤照旧:codeVersion 不同的 host 看得见任务、认领 0 次', async () => {
  const env = createSpaces(['proj-a']);
  const space = env.spaces.get('proj-a');
  const stale = hostOn(env, { projectIds: ['proj-a'], cv: 'other-code-version' });
  stale.start();
  const task = fineTask('proj-a', 'rh6');
  space.publish([task]);
  for (let i = 0; i < 20; i++) { await env.settle(); stale.tick(); env.clock.advance(STEP_MS); }
  await env.settle();
  assert.equal(stale.nodes()[0].seen, 1, '看得见');
  assert.equal(stale.nodes()[0].claimed, 0, '认领 0 次');
  assert.equal(space.sent('host-0').filter((m) => m.type === 'task.claim').length, 0, '一条认领都没发');
  assert.equal(space.task(task.id).state, 'open');
  env.hygiene();
  stale.shutdown();
});
