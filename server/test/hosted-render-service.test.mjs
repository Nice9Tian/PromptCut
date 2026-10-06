/**
 * 托管方渲染服务（契约 `docs/plan/hosted-render-contract.md` 第 2、4、5a、7 节；用例 HR16～HR20、HR25）。
 * 跑：npm test -- server/test/hosted-render-service.test.mjs（不起浏览器、不起真的工作进程；端口一律 0）
 *
 *   HR16  主机运行中增删项目：加、摘（让掉认领）、排空（做完再摘）、暂停认领、有成员在线的项目优先；按代理口的清单对账
 *   HR17  管理进程的项目维护：从目录清单与手里的认领定出该连的项目（上限、排队、排空）；控制连接客户端对真文档服务——
 *         连上取清单、变化跟着推、要票据、断线重连后对账；本机代理口的口令与清单外的项目
 *   HR18  背压与内存看护：读数 → 暂停与恢复；超过硬上限 → 结束工作进程、退避重起、三次后并发降为 1；起工作进程的命令（有无 cgroup）
 *   HR19  自检：每个 reason 各一例，告警不算失败；没有 systemd 时报 no-cgroup 并继续
 *   HR20  Chrome 启动参数：Linux 的 root / 容器 / 环境变量自动带 --no-sandbox；Windows 上与原来逐项相同
 *   HR26  产物到了容量上限（素材服务回 507 service-quota）：任务按不可重试失败，全部项目暂停认领 10 分钟，到点恢复
 *   HR27  工作进程起来了却不交诊断：管理进程判得出来；Vite 缓存目录放数据目录下并进自检
 *   HR25  没有成员在线时的预渲染（队列一侧）：服务身份发布的清单计划主机认领得了；发布方断开超过宽限期后，已切出的细任务
 *         不丢、能做完；计划还没被认领时发布方走了则计划被撤；发布方收得到每个细任务的完成通知（进度）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { createRenderQueue } from '../render-queue/index.mjs';
import { QUEUE_DEFAULTS } from '../render-queue/constants.mjs';
import { clipsPlanTaskOf, backfillPlanTaskOf } from '../render-queue/messages.mjs';
import { checkClaimable } from '../render-node/filter.mjs';
import { createRenderHost, reconcileHostProjects, createBrokerClient, renderHostArgs, renderHostEnv, HOST_CAPABILITIES, hostedRenderCapabilities, QUOTA_PAUSE_MS } from '../render-node/host.mjs';
import { isServiceQuotaError, SERVICE_QUOTA } from '../artifact-transfer.mjs';
import { createLoopback } from './fake-loopback-transport.mjs';
import { createTimerClock } from './fake-render-executor.mjs';
import { createProject, join, adminOp, sleep, waitFor, PROTOCOL } from './auth-kit.mjs';
import { serviceHostFor } from './hosted-render-kit.mjs';
import { selectProjects, nodeIdFor, createBroker } from '../hosted-render/broker.mjs';
import { createDirectory } from '../hosted-render/directory.mjs';
import { createWorker } from '../hosted-render/worker.mjs';
import {
  createBackpressure, createOomTracker, workerCommand, cgroupSupport, parseBytes, sumTree, memAvailable, LIMIT_DEFAULTS, loadHighFor,
} from '../hosted-render/limits.mjs';
import { runSelfcheck, nodeVersionOk, SELFCHECK_EXIT } from '../hosted-render/selfcheck.mjs';
import { renderServiceConfig, compareCodeVersions, editorHasCodeVersion, reportStale } from '../hosted-render/main.mjs';
import { chromeLaunchArgs, noSandboxReason } from '../bakery/chrome.mjs';

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const FP = 'fedcba9876543210';
const CV = 'c0de-hr';
const STEP_MS = 250;

/* ------------------------------------------------------------------ 夹具（照 render-host.test.mjs） */

function fineTask(projectId, label, { from = 0, to = 29 } = {}) {
  const contentKey = sha256(`ck:${projectId}:${label}`);
  const resultKey = sha256(`${contentKey}\n${FP}`);
  return {
    id: `snapshot:${resultKey}:${from}-${to}`, kind: 'snapshot', tier: 'shared', resultKey,
    range: { unit: 'localFrame', from, to },
    source: { projectId, projectRev: 1 },
    input: { clipId: `clip-${label}`, cardId: `card-${label}`, entryKey: null, contentKey },
    weight: { class: 'medium', estMs: null, frames: to - from + 1 },
    requires: { envFingerprint: FP, codeVersion: CV, cardSources: {}, transcode: false, userCards: false, graphCards: false, belowDependent: false },
    priority: 10,
  };
}

/** 执行器：`gate` 给了就等它放行（可控的「正在做」），`hang` 为真永不返回，否则立即完成 */
function fakeExecutor({ hang = false, gate = null } = {}) {
  const calls = { render: [], aborted: [] };
  return {
    calls,
    async plan() { return { entryKey: 'e', cardPlan: [] }; },
    render(task, { signal } = {}) {
      calls.render.push(task.id);
      signal?.addEventListener('abort', () => calls.aborted.push(task.id), { once: true });
      if (hang) return new Promise(() => {});
      if (gate) return gate.then(() => ({ fake: task.id }));
      return Promise.resolve({ fake: task.id });
    },
  };
}
const fakeSink = () => ({ async has() { return false; }, async put() { return { complete: true, result: {} }; } });

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
  return { clock, spaces, all, settle };
}

function dynamicHost(env, { cap = 1, executors = new Map() } = {}) {
  const closed = [];
  const events = [];
  const host = createRenderHost({
    entries: [],
    dynamic: true,
    connect: (entry, index) => ({
      endpoint: env.spaces.get(entry.projectId).lb.connect(`host-${entry.projectId}`, { userId: 'service:render@instance-00000001', tenantId: entry.projectId }),
      executor: executors.get(entry.projectId) ?? fakeExecutor(),
      sink: fakeSink(),
      close: () => closed.push(entry.projectId),
    }),
    nodeIdOf: (entry) => entry.nodeId ?? `hosted-render:test/${entry.projectId}`,
    envFingerprint: FP, codeVersion: CV, maxConcurrent: cap, now: env.clock.now, random: () => 0,
    onEvent: (e) => events.push(e),
  });
  return { host, closed, events };
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

/* ================================================================== HR16 */

test('HR16 主机运行中增删项目：空着起；加一个项目就接它的活；摘掉时让掉认领并关连接', async () => {
  const env = createSpaces(['proj-a', 'proj-b']);
  assert.throws(() => createRenderHost({ entries: [], connect() {}, envFingerprint: FP, codeVersion: CV, now: env.clock.now }), /至少一项/, '不带 dynamic 时空的 entries 照旧不行');
  const hangB = fakeExecutor({ hang: true });
  const { host, closed, events } = dynamicHost(env, { cap: 2, executors: new Map([['proj-b', hangB]]) });
  host.start();
  assert.deepEqual(host.projects(), []);
  assert.deepEqual(host.nodes(), []);

  const a = fineTask('proj-a', 'hr16-a');
  env.spaces.get('proj-a').publish([a]);
  await drive(env, () => host.tick(), () => true, 3);
  assert.equal(env.spaces.get('proj-a').task(a.id).state, 'open', '还没加这个项目：没人认领');

  assert.equal(host.add({ projectId: 'proj-a', members: true }), true);
  assert.equal(host.add({ projectId: 'proj-a', members: false }), false, '同一个项目再加只更新 members');
  await drive(env, () => host.tick(), () => env.spaces.get('proj-a').task(a.id)?.state === 'done');
  const hello = env.spaces.get('proj-a').sent('host-proj-a').find((m) => m.type === 'node.hello');
  assert.deepEqual([hello.profile, hello.nodeId], ['host', 'hosted-render:test/proj-a']);

  // 再加一个，认领一个卡住的任务，然后摘掉：发 task.release、任务回到 open、执行被中止、close 被调
  host.add({ projectId: 'proj-b' });
  const b = fineTask('proj-b', 'hr16-b');
  env.spaces.get('proj-b').publish([b]);
  await drive(env, () => host.tick(), () => env.spaces.get('proj-b').task(b.id)?.state === 'claimed');
  assert.equal(host.remove('proj-b', { reason: 'service-disabled' }), 1, '让掉 1 个认领');
  await env.settle();
  assert.equal(env.spaces.get('proj-b').task(b.id).state, 'open', '队列立即放回（不靠断线宽限期）');
  assert.deepEqual(env.spaces.get('proj-b').sent('host-proj-b').filter((m) => m.type === 'task.release').map((m) => m.reason), ['service-disabled']);
  assert.deepEqual(hangB.calls.aborted, [b.id]);
  assert.deepEqual(closed, ['proj-b']);
  assert.deepEqual(host.projects(), ['proj-a']);
  assert.equal(host.remove('proj-b'), -1, '已经不在了');
  assert.ok(events.some((e) => e.type === 'project-removed' && e.projectId === 'proj-b' && e.reason === 'service-disabled'));
  // 摘掉之后再发的任务它不认领
  const b2 = fineTask('proj-b', 'hr16-b2');
  env.spaces.get('proj-b').publish([b2]);
  await drive(env, () => host.tick(), () => true, 5);
  assert.equal(env.spaces.get('proj-b').task(b2.id).state, 'open');
  // 摘掉的项目可以再加回来（新的连接、新的序号）
  assert.equal(host.add({ projectId: 'proj-b' }), true);
  assert.deepEqual(host.nodes().map((n) => n.index), [0, 2], '序号不复用');
});

test('HR16 排空：不再认领新的，手里的做完才摘掉、才关连接', async () => {
  const env = createSpaces(['proj-a']);
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  const { host, closed } = dynamicHost(env, { cap: 2, executors: new Map([['proj-a', fakeExecutor({ gate })]]) });
  host.start();
  host.add({ projectId: 'proj-a' });
  const t1 = fineTask('proj-a', 'drain-1');
  env.spaces.get('proj-a').publish([t1]);
  await drive(env, () => host.tick(), () => env.spaces.get('proj-a').task(t1.id)?.state === 'claimed');
  assert.equal(host.remove('proj-a', { drain: true }), 0);
  assert.equal(host.nodes()[0].draining, true);
  const t2 = fineTask('proj-a', 'drain-2');
  env.spaces.get('proj-a').publish([t2]);
  await drive(env, () => host.tick(), () => true, 6);
  assert.equal(env.spaces.get('proj-a').task(t2.id).state, 'open', '排空中不认领新的');
  assert.equal(env.spaces.get('proj-a').task(t1.id).state, 'claimed', '手里的没有让掉');
  assert.deepEqual(closed, []);
  open();
  await drive(env, () => host.tick(), () => closed.length === 1);
  assert.equal(env.spaces.get('proj-a').task(t1.id).state, 'done', '做完了');
  assert.deepEqual(host.projects(), []);
  // 排空途中又有活了：再 add 就取消排空
  host.add({ projectId: 'proj-a' });
  await drive(env, () => host.tick(), () => env.spaces.get('proj-a').task(t2.id)?.state === 'done');
});

test('HR16 暂停认领（背压）：手里的照做，新的不认领；放开后恢复', async () => {
  const env = createSpaces(['proj-a']);
  const { host } = dynamicHost(env, { cap: 2 });
  host.start();
  host.add({ projectId: 'proj-a' });
  host.setPaused(true);
  const t = fineTask('proj-a', 'paused');
  env.spaces.get('proj-a').publish([t]);
  await drive(env, () => host.tick(), () => true, 8);
  assert.equal(env.spaces.get('proj-a').task(t.id).state, 'open');
  assert.equal(env.spaces.get('proj-a').sent('host-proj-a').filter((m) => m.type === 'task.claim').length, 0, '暂停时一条认领都不发');
  host.setPaused(false);
  await drive(env, () => host.tick(), () => env.spaces.get('proj-a').task(t.id)?.state === 'done');
});

test('HR16 有成员在线的项目优先：并发只有 1 时，空位先给 members 为真的项目，与加入的先后无关', async () => {
  for (const order of [['proj-a', 'proj-b'], ['proj-b', 'proj-a']]) {
    const env = createSpaces(['proj-a', 'proj-b']);
    const executors = new Map([['proj-a', fakeExecutor({ hang: true })], ['proj-b', fakeExecutor({ hang: true })]]);
    const { host } = dynamicHost(env, { cap: 1, executors });
    host.start();
    // proj-b 有成员在线，proj-a 没有（靠别的托管方服务才有活）
    for (const p of order) host.add({ projectId: p, members: p === 'proj-b' });
    const tasks = { 'proj-a': fineTask('proj-a', 'prio'), 'proj-b': fineTask('proj-b', 'prio') };
    for (const p of order) env.spaces.get(p).publish([tasks[p]]);
    await drive(env, () => host.tick(), () => host.busy() === 1);
    assert.equal(env.spaces.get('proj-b').task(tasks['proj-b'].id).state, 'claimed', `加入顺序 ${order}：有成员在线的先认领`);
    assert.equal(env.spaces.get('proj-a').task(tasks['proj-a'].id).state, 'open');
    // 成员走了、另一个项目来了成员：下一个空位换给它
    host.shutdown('test');
  }
  const env = createSpaces(['proj-a', 'proj-b']);
  const { host } = dynamicHost(env, { cap: 1 });
  host.start();
  host.add({ projectId: 'proj-a', members: false });
  host.add({ projectId: 'proj-b', members: false });
  host.setMembers('proj-b', true);
  assert.deepEqual(host.nodes().map((n) => [n.projectId, n.prefer]), [['proj-a', false], ['proj-b', true]]);
});

test('HR16 按代理口的清单对账：该加的加、不在清单里的摘、标了排空的排空、暂停与成员在线跟着改；代理模式的参数与环境变量', async () => {
  const calls = [];
  const have = new Set(['old', 'keep', 'drainme']);
  const host = {
    projects: () => [...have],
    add(entry) { calls.push(['add', entry.projectId, entry.members, entry.url, entry.nodeId]); if (have.has(entry.projectId)) return false; have.add(entry.projectId); return true; },
    remove(projectId, opts = {}) { calls.push(['remove', projectId, opts.drain === true]); if (!opts.drain) have.delete(projectId); return 0; },
    setMembers(projectId, online) { calls.push(['members', projectId, online]); },
    setPaused(v) { calls.push(['paused', v]); },
  };
  const listing = {
    docUrl: 'ws://127.0.0.1:8787', paused: true,
    projects: [
      { projectId: 'keep', members: true, drain: false, nodeId: 'n-keep' },
      { projectId: 'new', members: false, drain: false, nodeId: 'n-new' },
      { projectId: 'drainme', members: false, drain: true, nodeId: 'n-drain' },
    ],
  };
  const diff = reconcileHostProjects(host, listing, (item) => ({ url: listing.docUrl, projectId: item.projectId, members: item.members === true, nodeId: item.nodeId }));
  assert.deepEqual(diff, { added: ['new'], removed: ['old'], drained: ['drainme'] });
  assert.deepEqual(calls, [
    ['paused', true], ['remove', 'old', false],
    ['add', 'keep', true, 'ws://127.0.0.1:8787', 'n-keep'], ['members', 'keep', true],
    ['add', 'new', false, 'ws://127.0.0.1:8787', 'n-new'],
    ['remove', 'drainme', true],
  ]);

  // 代理模式：不要 --config；子进程环境里没有 PROMPTCUT_SHARED_CONFIG
  const opts = renderHostArgs(['--port', '5730', '--data', 'D', '--cwd', 'C', '--max-concurrent', '2']);
  assert.deepEqual([opts.port, opts.cwd, opts.maxConcurrent, opts.config], [5730, 'C', 2, null]);
  const env = renderHostEnv({ PROMPTCUT_SHARED_CONFIG: 'x.json', PROMPTCUT_CLUSTER_TOKEN: 'secret', PROMPTCUT_RENDER_BROKER: 'http://127.0.0.1:1' }, { config: null, data: path.resolve('D'), streams: false, maxConcurrent: 2 });
  assert.equal('PROMPTCUT_SHARED_CONFIG' in env, false);
  assert.equal('PROMPTCUT_CLUSTER_TOKEN' in env, false, '集群令牌不进工作进程');
  assert.deepEqual([env.PROMPTCUT_NODE_PROFILE, env.PROMPTCUT_QUEUE_NODE, env.PROMPTCUT_HOST_MAX_CONCURRENT, env.PROMPTCUT_RENDER_BROKER], ['host', '1', '2', 'http://127.0.0.1:1']);
});

/* ================================================================== HR17 */

test('HR17 从目录清单定出该连的项目：开关、有活、手里有认领的排空、上限与排队、有成员在线的先连', () => {
  const dir = [
    { projectId: 'sp_a', enabled: true, active: true, members: false, since: 10 },
    { projectId: 'sp_b', enabled: true, active: true, members: true, since: 30 },
    { projectId: 'sp_c', enabled: false, active: true, members: true, since: 5 },
    { projectId: 'sp_d', enabled: true, active: false, members: false, since: null },
    { projectId: 'sp_e', enabled: true, active: false, members: false, since: null },
    { projectId: 'sp_f', enabled: true, active: true, members: false, since: 20 },
  ];
  const pick = (o) => selectProjects({ directory: dir, instanceId: 'instance-0123456789', maxProjects: 16, ...o });
  const all = pick({ held: { sp_e: 1 } });
  assert.deepEqual(all.projects.map((p) => [p.projectId, p.members, p.drain]), [
    ['sp_b', true, false], ['sp_a', false, false], ['sp_f', false, false], ['sp_e', false, true],
  ], '有成员在线的在前，其余按变成有活的先后；没活但手里有认领的排空；开关关着的、没活没认领的不列');
  assert.deepEqual(all.waiting, []);
  assert.equal(all.projects[0].nodeId, nodeIdFor('instance-0123456789', 'sp_b'));
  assert.equal(nodeIdFor('instance-0123456789', 'sp_abcdefghijklmnop'), 'hosted-render:instance-012/abcdefgh');
  const capped = pick({ maxProjects: 2, held: { sp_e: 1 } });
  assert.deepEqual(capped.projects.map((p) => p.projectId), ['sp_b', 'sp_e'], '上限 2：排空中的占一个名额，剩下的给有成员在线的');
  assert.deepEqual(capped.waiting, ['sp_a', 'sp_f']);
  assert.deepEqual(pick({ held: { sp_c: 3 } }).projects.some((p) => p.projectId === 'sp_c'), false, '开关关了：手里有认领也不列（让掉）');
});

test('HR17 控制连接客户端对真文档服务：连上取清单、变化跟着推、要票据、被拒给原因；断线重连后按完整清单对账', async (t) => {
  const env = await serviceHostFor(t, { lingerMs: 500 });
  const proj = await createProject(env, { mode: 'free' });
  const logs = [];
  const dir = createDirectory({ url: `ws://127.0.0.1:${env.port}`, key: env.keys.render, log: (event, fields) => logs.push({ event, ...fields }), rewatchMs: 300 });
  t.after(() => dir.stop());
  let changes = 0;
  dir.onChange(() => { changes += 1; });
  await assert.rejects(() => dir.ticket(proj.projectId), (e) => e.code === 'directory-offline', '没连上时要不到票据');
  dir.start();
  await waitFor(() => dir.connected && dir.list().length === 1, 5000, '控制连接连上并拿到清单');
  assert.deepEqual(dir.list().map((p) => [p.projectId, p.enabled, p.active, p.members]), [[proj.projectId, true, false, false]]);

  const creator = await join(env, proj, { username: proj.creator.username, as: 'creator' });
  await waitFor(() => dir.get(proj.projectId)?.active === true, 3000, '成员进来后 active');
  assert.equal(dir.get(proj.projectId).members, true);
  assert.equal(typeof dir.get(proj.projectId).since, 'number');
  const tk = await dir.ticket(proj.projectId);
  assert.equal(typeof tk.ticket, 'string');
  assert.equal((await env.handshake([PROTOCOL, `promptcut.ticket.${tk.ticket}`])).status, 101, '票据进得去');
  await assert.rejects(() => dir.ticket('sp_aaaaaaaaaaaaaaaaaaaaaaaaaa'), (e) => e.code === 'no-project');

  await adminOp(creator, proj, 'set-hosted-service', { service: 'render', enabled: false });
  await waitFor(() => dir.get(proj.projectId)?.enabled === false, 3000, '关开关推过来');
  await assert.rejects(() => dir.ticket(proj.projectId), (e) => e.code === 'service-disabled');
  assert.ok(changes >= 3);

  // 断线：服务端把控制连接关掉；断着的时候清单保持、要不到票据；这期间建的项目、改的开关，重连后按完整清单对上
  const controlConn = env.service.describe().conns.find((c) => c.principal.scope === 'service');
  env.service.closeConn(controlConn.connId ?? controlConn.id, 1012, 'test');
  await waitFor(() => !dir.connected, 3000, '断开');
  assert.equal(dir.list().length, 1, '断着的时候清单保持最后一次的样子');
  await adminOp(creator, proj, 'set-hosted-service', { service: 'render', enabled: true });
  const other = await createProject(env, { mode: 'free' });
  await waitFor(() => dir.connected && dir.list().length === 2 && dir.get(proj.projectId).enabled === true, 8000, '重连后对账');
  assert.ok(dir.get(other.projectId));
  assert.ok(dir.status().opens >= 2);
  // 删项目：清单里没有了
  const del = await adminOp(creator, proj, 'delete');
  assert.equal(del.type, 'shared.admin.ok');
  await waitFor(() => dir.get(proj.projectId) === null, 3000, '删项目后从清单消失');
  const text = JSON.stringify(logs);
  assert.ok(!text.includes(env.keys.render.priv) && !text.includes(tk.ticket), '日志里没有私钥与票据');
});

test('HR17 本机代理口：要口令；只给清单里的项目签票据；/status 不要口令、不含口令；工作进程一侧的客户端对得上', async (t) => {
  const reports = [];
  const tickets = [];
  let projects = [{ projectId: 'sp_listed', members: true, drain: false, nodeId: 'n1' }];
  const broker = createBroker({
    key: 'broker-secret-key',
    listing: () => ({ docUrl: 'ws://127.0.0.1:1', paused: false, projects }),
    ticket: async (projectId) => { tickets.push(projectId); if (projectId === 'sp_listed') return { ticket: 'TICKET-1' }; throw Object.assign(new Error('x'), { code: 'service-disabled' }); },
    report: (body) => reports.push(body),
    status: () => ({ hello: 'world' }),
  });
  const addr = await broker.listen(0);
  t.after(() => broker.close());
  const url = `http://127.0.0.1:${addr.port}`;
  const st = await (await fetch(`${url}/status`)).json();
  assert.deepEqual(st, { ok: true, hello: 'world' });
  assert.equal((await fetch(`${url}/projects`)).status, 401, '没口令');
  assert.equal((await fetch(`${url}/projects`, { headers: { authorization: 'Bearer wrong' } })).status, 401, '口令不对');
  assert.equal((await fetch(`${url}/ticket`, { method: 'POST', headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' }, body: '{"projectId":"sp_listed"}' })).status, 401);

  const client = createBrokerClient({ url: `${url}/`, key: 'broker-secret-key' });
  assert.deepEqual((await client.projects()).projects, projects);
  assert.equal(await client.ticket('sp_listed'), 'TICKET-1');
  await assert.rejects(() => client.ticket('sp_other'), (e) => e.code === 'not-listed', '清单外的项目要不到票据');
  assert.deepEqual(tickets, ['sp_listed'], '清单外的没有转给目录');
  projects = [...projects, { projectId: 'sp_off', members: false, drain: false, nodeId: 'n2' }];
  await assert.rejects(() => client.ticket('sp_off'), (e) => e.code === 'service-disabled', '目录拒绝的原因带回来');
  await client.report({ pid: 1, queue: { nodes: [] } });
  assert.deepEqual(reports, [{ pid: 1, queue: { nodes: [] } }]);
  assert.ok(!JSON.stringify(st).includes('broker-secret-key'));
});

/* ================================================================== HR18 */

test('HR18 背压：可用内存低、文档服务自检连续三次慢、负载高 → 暂停；全部恢复满 30 s 才放开', () => {
  let now = 0;
  const bp = createBackpressure({ now: () => now, cores: 8 });
  const ok = { memAvailable: 8 * 1024 ** 3, healthMs: 20, load1: 1 };
  assert.deepEqual(bp.sample(ok), { paused: false, reasons: [] });
  assert.deepEqual(bp.sample({ ...ok, memAvailable: 1.5 * 1024 ** 3 }), { paused: true, reasons: ['memory'] });
  now += 5000;
  assert.equal(bp.sample(ok).paused, true, '刚恢复：还没满 30 s');
  now += 29_000;
  assert.equal(bp.sample(ok).paused, true);
  now += 1000;
  assert.deepEqual(bp.sample(ok), { paused: false, reasons: [] }, '恢复满 30 s 放开');

  assert.equal(bp.sample({ ...ok, healthMs: 600 }).paused, false, '慢一次不算');
  assert.equal(bp.sample({ ...ok, healthMs: null }).paused, false, '问不通同样算慢，两次');
  assert.deepEqual(bp.sample({ ...ok, healthMs: 501 }), { paused: true, reasons: ['docservice'] }, '连续三次');
  now += 60_000;
  assert.equal(bp.sample(ok).paused, true, '恢复后要再满 30 s');
  now += 30_000;
  assert.equal(bp.sample(ok).paused, false);
  assert.deepEqual(bp.sample({ ...ok, load1: 8.5 }), { paused: true, reasons: ['load'] });
  assert.equal(bp.sample({ ...ok, load1: 8 }).paused, true, '等于线不算高，但还在恢复期');
  // 恢复期内又越线：重新计时
  now += 20_000;
  bp.sample({ ...ok, memAvailable: 100 });
  now += 20_000;
  assert.equal(bp.sample(ok).paused, true);
  now += 30_000;
  assert.equal(bp.sample(ok).paused, false);
  // 负载的线按核数算：4 核的机器上高于 4 就暂停（原来写死 8）；也可以直接给
  assert.deepEqual([loadHighFor(8), loadHighFor(4), loadHighFor(1), loadHighFor(0)], [8, 4, 1, 1]);
  assert.deepEqual(createBackpressure({ now: () => now, cores: 4 }).sample({ ...ok, load1: 4.5 }), { paused: true, reasons: ['load'] });
  assert.equal(createBackpressure({ now: () => now, cores: 4 }).sample({ ...ok, load1: 4 }).paused, false);
  assert.equal(createBackpressure({ now: () => now, cores: 4, loadHigh: 16 }).sample({ ...ok, load1: 12 }).paused, false);
  // 可调的线（演练用）
  const loose = createBackpressure({ now: () => now, memLowBytes: 256 * 1024 ** 2 });
  assert.equal(loose.sample({ ...ok, memAvailable: 1024 ** 3 }).paused, false);
  assert.equal(memAvailable({ platform: 'linux', read: () => 'MemTotal: 100 kB\nMemAvailable:   2048 kB\n' }), 2048 * 1024);
});

test('HR18 内存：10 分钟内第 3 次超限并发降到 1；进程树的常驻内存求和；上限写法', () => {
  let now = 0;
  const oom = createOomTracker({ now: () => now });
  assert.deepEqual(oom.note(), { count: 1, degrade: false });
  now += 60_000;
  assert.deepEqual(oom.note(), { count: 2, degrade: false });
  now += 9 * 60_000 + 1;
  assert.deepEqual(oom.note(), { count: 2, degrade: false }, '第一次已经出了 10 分钟的窗口');
  now += 1000;
  assert.deepEqual(oom.note(), { count: 3, degrade: true });
  assert.equal(oom.degraded, true);

  const procs = new Map([[1, { ppid: 0, rss: 10 }], [2, { ppid: 1, rss: 20 }], [3, { ppid: 2, rss: 30 }], [4, { ppid: 9, rss: 400 }], [5, { ppid: 1, rss: 5 }]]);
  assert.equal(sumTree(1, procs), 65, '整棵树');
  assert.equal(sumTree(2, procs), 50);
  assert.equal(sumTree(77, procs), null, '根不在');
  assert.deepEqual([parseBytes('6G'), parseBytes('512M'), parseBytes('150m'), parseBytes('1.5G'), parseBytes('abc'), parseBytes('0')], [6 * 1024 ** 3, 512 * 1024 ** 2, 150 * 1024 ** 2, 1.5 * 1024 ** 3, null, null]);
});

test('HR18 起工作进程的命令：有 systemd 与 cgroup v2 时包 systemd-run 并带全部上限；没有时 Linux 包 nice、其余原样', () => {
  const yes = (list) => (p) => list.includes(p);
  assert.deepEqual(cgroupSupport({ platform: 'linux', exists: yes(['/run/systemd/system', '/sys/fs/cgroup/cgroup.controllers']), which: () => '/usr/bin/systemd-run' }), { ok: true, reason: null });
  assert.equal(cgroupSupport({ platform: 'linux', exists: yes(['/sys/fs/cgroup/cgroup.controllers']), which: () => '/usr/bin/systemd-run' }).reason, 'no-systemd', '容器里没有 systemd');
  assert.equal(cgroupSupport({ platform: 'linux', exists: yes(['/run/systemd/system']), which: () => 'x' }).reason, 'no-cgroup-v2');
  assert.equal(cgroupSupport({ platform: 'linux', exists: () => true, which: () => null }).reason, 'no-systemd-run');
  assert.equal(cgroupSupport({ platform: 'win32' }).reason, 'not-linux');

  const base = { node: '/usr/bin/node', args: ['scripts/render-host.mjs', '--port', '5400'] };
  const cg = workerCommand({ ...base, support: { ok: true }, user: 'promptcut-render', platform: 'linux' });
  assert.equal(cg.mode, 'cgroup');
  assert.equal(cg.cmd, 'systemd-run');
  const text = cg.args.join(' ');
  for (const part of ['--scope', '--slice=promptcut-render.slice', '--uid=promptcut-render', 'MemoryMax=6G', 'MemoryHigh=5G', 'CPUQuota=400%', 'CPUWeight=20', 'IOWeight=20', 'TasksMax=4096', 'OOMScoreAdjust=500', 'Nice=10']) {
    assert.ok(text.includes(part), `systemd-run 参数里有 ${part}：${text}`);
  }
  assert.deepEqual(cg.args.slice(-4), ['/usr/bin/node', ...base.args], '最后是原来的命令');
  assert.ok(!workerCommand({ ...base, support: { ok: true }, platform: 'linux' }).args.some((a) => a.startsWith('--uid')), '没给用户就不带 --uid');
  assert.ok(workerCommand({ ...base, support: { ok: true }, platform: 'linux', limits: { memoryMax: '2G' } }).args.includes('MemoryMax=2G'));
  assert.deepEqual(workerCommand({ ...base, support: { ok: false }, platform: 'linux', hasNice: true }), { cmd: 'nice', args: ['-n', '10', '/usr/bin/node', ...base.args], mode: 'nice' });
  assert.deepEqual(workerCommand({ ...base, support: { ok: false }, platform: 'linux', hasNice: false }), { cmd: '/usr/bin/node', args: base.args, mode: 'plain' });
  assert.deepEqual(workerCommand({ ...base, support: { ok: false }, platform: 'win32' }), { cmd: '/usr/bin/node', args: base.args, mode: 'plain' });
  assert.deepEqual([LIMIT_DEFAULTS.maxConcurrent, LIMIT_DEFAULTS.maxProjects, LIMIT_DEFAULTS.memoryMax, LIMIT_DEFAULTS.cpuQuota], [2, 16, '6G', '400%']);
});

test('HR18 工作进程看护：退出按退避重起（1 s、2 s、4 s…封顶 60 s），跑稳了退避归零；kill 记原因；stop 之后不再起', async () => {
  let now = 0;
  const timers = [];
  const spawned = [];
  const logs = [];
  const fakeSpawn = (cmd, args, opts) => {
    if (cmd === 'taskkill') { const p = spawned.at(-1); setImmediate(() => p.emit('exit', 1, null)); return new EventEmitter(); }
    const proc = new EventEmitter();
    proc.pid = 1000 + spawned.length;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.connected = true;
    proc.send = (m) => { proc.sent = m; setImmediate(() => proc.emit('exit', 0, null)); };
    proc.opts = opts;
    spawned.push(proc);
    return proc;
  };
  let concurrency = 2;
  const worker = createWorker({
    command: () => ({ cmd: 'node', args: ['w', String(concurrency)], env: { A: '1' }, cwd: '/x' }),
    log: (event, fields) => logs.push({ event, ...fields }),
    now: () => now, spawn: fakeSpawn, platform: 'win32',
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
  });
  const fire = () => timers.shift().fn();
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  worker.start();
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].opts.windowsHide, true, '窗口隐藏');
  assert.deepEqual(worker.status().ready, false);
  spawned[0].stdout.emit('data', Buffer.from('[render-host] ready {"port":1}\n'));
  assert.equal(worker.ready, true);

  const waits = [];
  for (let i = 0; i < 8; i += 1) {
    now += 500; // 每次都很快就死
    spawned.at(-1).emit('exit', 1, null);
    waits.push(timers.at(-1).ms);
    fire();
  }
  assert.deepEqual(waits, [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000], '退避翻倍、封顶 60 s');
  assert.equal(spawned.length, 9);
  now += 61_000; // 这一次跑稳了
  spawned.at(-1).emit('exit', 1, null);
  assert.equal(timers.at(-1).ms, 1000, '跑满 60 s 后退避归零');
  fire();

  // kill：记原因，照常重起；并发降级后命令跟着变
  concurrency = 1;
  assert.equal(worker.kill('oom'), true);
  await tick();
  assert.deepEqual(logs.filter((l) => l.event === 'worker.exit').at(-1).reason, 'oom');
  fire();
  assert.deepEqual(spawned.at(-1).opts.cwd, '/x');
  assert.equal(worker.running, true);

  // stop：先请它收尾（Windows 经 IPC），退了就不再起
  const before = spawned.length;
  await worker.stop();
  assert.deepEqual(spawned.at(-1).sent, { type: 'shutdown' });
  assert.equal(worker.running, false);
  assert.equal(spawned.length, before, 'stop 之后不再起');
  assert.equal(logs.filter((l) => l.event === 'worker.exit').at(-1).reason, 'stop');
});

/* ================================================================== HR19 */

test('HR19 自检：每个 reason 各一例；告警不算失败；没有 systemd 时报 no-cgroup 并继续', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-hr19-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const good = {
    nodeVersion: '24.21.0',
    readKey: () => ({ service: 'render', kid: 'KIDKIDKI', instanceId: 'instance-0000000001', priv: 'SECRET-PRIV' }),
    checkDir: () => {},
    chrome: async () => ({ ok: true, version: 'HeadlessChrome/141.0.0.0', cjk: true, noSandbox: null }),
    ffmpeg: () => ({ ok: true, h264: true, version: '6.1' }),
    cgroup: () => ({ ok: true, reason: null }),
  };
  const config = { secretsDir: path.join(dir, 'secrets'), dataDir: path.join(dir, 'data') };
  const run = (over) => runSelfcheck(config, { ...good, ...over });
  const all = await run({});
  assert.deepEqual([all.ok, all.errors, all.warnings], [true, [], []]);
  assert.deepEqual(all.info, { node: '24.21.0', service: { service: 'render', kid: 'KIDKIDKI', instanceId: 'instance-0000000001' }, chrome: 'HeadlessChrome/141.0.0.0', chromeSandbox: 'on', ffmpeg: '6.1', cgroup: 'systemd-scope' });
  assert.ok(!JSON.stringify(all).includes('SECRET-PRIV'), '结果里没有私钥');

  const reasonsOf = async (over) => (await run(over)).errors.map((e) => e.reason);
  assert.deepEqual(await reasonsOf({ nodeVersion: '22.17.9' }), ['node-version']);
  assert.deepEqual(await reasonsOf({ nodeVersion: '20.11.0' }), ['node-version']);
  assert.deepEqual([nodeVersionOk('22.18.0'), nodeVersionOk('22.22.0'), nodeVersionOk('24.0.0'), nodeVersionOk('22.17.0')], [true, true, true, false]);
  assert.deepEqual(await reasonsOf({ readKey: () => { throw Object.assign(new Error('私钥文件的权限比 0600 宽'), { code: 'service-key' }); } }), ['service-key']);
  assert.deepEqual(await reasonsOf({ checkDir: () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } }), ['data-dir']);
  assert.deepEqual(await reasonsOf({ chrome: async () => ({ ok: false, stage: 'no-chrome', detail: 'Could not find Chrome' }) }), ['no-chrome']);
  assert.deepEqual(await reasonsOf({ chrome: async () => ({ ok: false, stage: 'chrome-launch', detail: 'Running as root without --no-sandbox is not supported' }) }), ['chrome-launch']);
  assert.deepEqual(await reasonsOf({ chrome: async () => { throw new Error('boom'); } }), ['chrome-launch']);
  const noFont = await run({ chrome: async () => ({ ok: true, version: 'v', cjk: false, noSandbox: null }) });
  assert.deepEqual(noFont.errors.map((e) => e.reason), ['no-cjk-font']);
  assert.match(noFont.errors[0].detail, /fonts-noto-cjk/, '报错里写明要装什么');
  assert.deepEqual(await reasonsOf({ ffmpeg: () => ({ ok: false, detail: 'ENOENT' }) }), ['no-ffmpeg']);
  // 几项一起坏：都列出来
  assert.deepEqual(await reasonsOf({ nodeVersion: '18.0.0', ffmpeg: () => ({ ok: false }), chrome: async () => ({ ok: true, cjk: false }) }), ['node-version', 'no-cjk-font', 'no-ffmpeg']);

  // 告警：照常启动
  const container = await run({ cgroup: () => ({ ok: false, reason: 'no-systemd' }), chrome: async () => ({ ok: true, version: 'v', cjk: true, noSandbox: 'root' }), ffmpeg: () => ({ ok: true, h264: false, version: '4' }) });
  assert.equal(container.ok, true, '没有 systemd、root 下关沙箱、没有 H.264 编码器都只是告警');
  assert.deepEqual(container.warnings.map((w) => w.reason), ['no-sandbox', 'no-h264', 'no-cgroup']);
  assert.match(container.warnings.at(-1).detail, /无 cgroup 上限.*只靠进程内看护/);
  assert.equal(container.info.cgroup, 'none:no-systemd');
  assert.equal(container.info.chromeSandbox, 'off:root', '自检结果里写明沙箱关着与原因');
  assert.equal(SELFCHECK_EXIT, 78);

  // 真的两项：私钥目录不存在、数据目录建得出来
  const real = await runSelfcheck(config, { nodeVersion: good.nodeVersion, chrome: good.chrome, ffmpeg: good.ffmpeg, cgroup: good.cgroup });
  assert.deepEqual(real.errors.map((e) => e.reason), ['service-key']);
  assert.ok(fs.existsSync(config.dataDir), '数据目录没有就建');
});

test('HR19 配置与代码版本：环境变量读成配置，写错的报 bad-config；在线页面的构建里找不到自己的代码版本就明说', (t) => {
  const c = renderServiceConfig({});
  assert.deepEqual(
    [c.docUrl, c.healthUrl, c.port, c.statusPort, c.maxConcurrent, c.maxProjects, c.memoryMax, c.memoryHigh, c.cpuQuota, c.user, c.cgroup, c.userCards, c.streams, c.memLowBytes],
    ['ws://127.0.0.1:8787', 'http://127.0.0.1:8787/healthz', 5400, 5399, 2, 16, '6G', '5G', '400%', '', 'auto', 'isolated', false, 2 * 1024 ** 3],
  );
  assert.equal(c.secretsDir, '/var/lib/promptcut/render-secrets');
  assert.equal(c.editorDir, '/opt/promptcut-hosted/editor');
  for (const bad of [{ PROMPTCUT_RENDER_MAX_CONCURRENT: '5' }, { PROMPTCUT_RENDER_MAX_CONCURRENT: 'two' }, { PROMPTCUT_RENDER_DOC_URL: 'http://x' }, { PROMPTCUT_RENDER_MEMORY_MAX: 'lots' }, { PROMPTCUT_RENDER_MEM_LOW: 'x' }]) {
    assert.throws(() => renderServiceConfig(bad), (e) => e.code === 'bad-config' || e instanceof TypeError, JSON.stringify(bad));
  }
  assert.equal(renderServiceConfig({ PROMPTCUT_RENDER_DOC_URL: 'wss://h.example/hosted/' }).healthUrl, 'https://h.example/hosted/healthz');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-hr19-editor-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const self = 'a'.repeat(64);
  const other = 'b'.repeat(64);
  assert.equal(editorHasCodeVersion(path.join(dir, 'missing'), self), null, '目录不在：没法比');
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<script src="assets/index-abc.js"></script>');
  fs.writeFileSync(path.join(dir, 'assets', 'index-abc.js'), `const V="${other}";`);
  assert.equal(editorHasCodeVersion(dir, self), false);
  assert.deepEqual(compareCodeVersions({ self, editorDir: dir }), { self, editor: 'different', agent: 'unknown', expect: null, match: false });
  fs.writeFileSync(path.join(dir, 'assets', 'index-abc.js'), `const V="${self}";`);
  assert.deepEqual(compareCodeVersions({ self, editorDir: dir, agentVersion: self }), { self, editor: 'same', agent: 'same', expect: null, match: true });
  assert.equal(compareCodeVersions({ self, editorDir: dir, agentVersion: other }).match, false, 'Agent 服务不是同一个提交');
  assert.equal(compareCodeVersions({ self, editorDir: path.join(dir, 'missing') }).match, null, '都取不到：不知道，不乱报');
  assert.equal(compareCodeVersions({ self, expect: other }).match, false, '直接给了应该一致的版本');
  assert.equal(compareCodeVersions({ self: null }).match, null);
});

/* ================================================================== HR20 */

/** 桌面版一直在用的那一串（钉住：这个测试失败说明有人动了桌面的 Chrome 启动参数） */
const DESKTOP_CHROME_ARGS = [
  '--window-position=-32000,-32000', '--no-first-run', '--no-default-browser-check',
  '--enable-begin-frame-control', '--run-all-compositor-stages-before-draw',
  '--hide-scrollbars',
  '--disable-gpu', '--disable-gpu-rasterization', '--disable-gpu-compositing',
  '--font-render-hinting=none', '--force-device-scale-factor=1',
  '--disable-partial-raster',
  '--disable-threaded-animation',
  '--enable-unsafe-swiftshader',
];

test('HR20 Chrome 启动参数：Windows / macOS 上与原来逐项相同；Linux 的 root、容器、环境变量自动带 --no-sandbox', () => {
  const none = () => false;
  for (const platform of ['win32', 'darwin']) {
    for (const env of [{}, { PROMPTCUT_CHROME_NO_SANDBOX: '1' }]) {
      assert.deepEqual(chromeLaunchArgs({ platform, env, getuid: () => 0, exists: () => true }), DESKTOP_CHROME_ARGS, `${platform}：不管是不是管理员、环境变量怎么设，参数不变`);
      assert.equal(noSandboxReason({ platform, env, getuid: () => 0, exists: () => true }), null);
    }
  }
  assert.deepEqual(chromeLaunchArgs({ platform: 'win32', env: { PC_CHROME_ARGS: '--flag-a  --flag-b' } }), [...DESKTOP_CHROME_ARGS, '--flag-a', '--flag-b'], 'PC_CHROME_ARGS 照旧追加');
  // 这台机器上真实的结果：不是 Linux 时与桌面那一串逐项相同
  if (process.platform !== 'linux') assert.deepEqual(chromeLaunchArgs({ env: {} }), DESKTOP_CHROME_ARGS);

  const linux = (o) => ({ platform: 'linux', env: {}, getuid: () => 1000, exists: none, ...o });
  assert.equal(noSandboxReason(linux({})), null, '普通用户、不在容器里：沙箱照常开');
  assert.deepEqual(chromeLaunchArgs(linux({})), DESKTOP_CHROME_ARGS);
  assert.equal(noSandboxReason(linux({ getuid: () => 0 })), 'root');
  assert.equal(noSandboxReason(linux({ exists: (p) => p === '/.dockerenv' })), 'container');
  assert.equal(noSandboxReason(linux({ exists: (p) => p === '/run/.containerenv' })), 'container');
  assert.equal(noSandboxReason(linux({ env: { PROMPTCUT_CHROME_NO_SANDBOX: '1' } })), 'env');
  assert.equal(noSandboxReason(linux({ getuid: () => 0, env: { PROMPTCUT_CHROME_NO_SANDBOX: '0' } })), null, '显式设 0：root 下也不加（让 Chrome 自己报错）');
  assert.equal(noSandboxReason(linux({ getuid: undefined })), null);
  for (const o of [{ getuid: () => 0 }, { exists: (p) => p === '/.dockerenv' }, { env: { PROMPTCUT_CHROME_NO_SANDBOX: '1' } }]) {
    assert.deepEqual(chromeLaunchArgs(linux(o)), [...DESKTOP_CHROME_ARGS, '--no-sandbox']);
  }
  assert.deepEqual(chromeLaunchArgs(linux({ getuid: () => 0, env: { PC_CHROME_ARGS: '--x' } })), [...DESKTOP_CHROME_ARGS, '--no-sandbox', '--x']);
});

test('HR20 托管方渲染服务的能力位（集中的一张表）：不同步卡的常驻工作进程不报 userCards，要用户卡的任务它不认领；隔离工作进程才报', () => {
  const measured = { userCards: true, graphCards: false, transcode: true, streams: true };
  assert.deepEqual(hostedRenderCapabilities(measured, { cardSync: false }), { userCards: false, graphCards: false, transcode: true, streams: true });
  assert.deepEqual(hostedRenderCapabilities(measured, { cardSync: true }), { userCards: true, graphCards: false, transcode: true, streams: true });
  assert.deepEqual(HOST_CAPABILITIES, { userCards: true, graphCards: false }, '独立渲染主机（成员自己配的）不变');
  const resident = { profile: 'host', nodeId: 'hosted-render:x/y', envFingerprint: FP, codeVersions: [CV], capabilities: hostedRenderCapabilities(measured, { cardSync: false }) };
  const plain = fineTask('doc-1', 'cap-plain');
  const userCard = { ...plain, requires: { ...plain.requires, userCards: true } };
  assert.deepEqual(checkClaimable(plain, resident), { ok: true });
  assert.equal(checkClaimable(userCard, resident).ok, false, '常驻工作进程不接要用户卡的任务');
  assert.deepEqual(checkClaimable(userCard, { ...resident, capabilities: hostedRenderCapabilities(measured, { cardSync: true }) }), { ok: true });
});

/* ================================================================== HR25 */

/** 直接驱动一个队列：记下发给每条连接的消息 */
function bareQueue() {
  let now = 1_000_000;
  const out = new Map();
  const q = createRenderQueue({ now: () => now, send: (connId, message) => { if (!out.has(connId)) out.set(connId, []); out.get(connId).push(structuredClone(message)); } });
  return {
    q,
    advance(ms) { now += ms; },
    msgs: (connId, type) => (out.get(connId) ?? []).filter((m) => !type || m.type === type),
    task: (id) => q.describe().tasks.find((t) => t.id === id),
  };
}

test('HR25 没有成员在线时的预渲染（队列一侧）：服务身份发布的清单计划主机认领得了；发布方走了之后细任务不丢、能做完；发布方看得到进度', () => {
  const { q, advance, msgs, task } = bareQueue();
  const PROJECT = 'doc-1';
  // 发布方：云端 Agent 服务的发布连接（服务身份，不是页面、不是成员）
  const agent = { userId: 'service:agent@agent-instance-0001', tenantId: 'sp_x', scope: 'service', service: 'agent', role: 'agent' };
  const render = { userId: 'service:render@render-instance-001', tenantId: 'sp_x', scope: 'service', service: 'render', role: 'render' };
  q.connect('agent', agent);
  q.handle('agent', { type: 'publisher.hello', publisherId: 'agent-pub-1', reqId: 'a1' });
  assert.equal(msgs('agent', 'publisher.welcome').length, 1, '队列不按发布方的身份种类拒（R2）');
  const plan = clipsPlanTaskOf({ projectId: PROJECT, projectRev: 7, clips: ['clip-b', 'clip-a'], codeVersion: CV });
  const backfill = backfillPlanTaskOf({ projectId: PROJECT, projectRev: 7, clips: ['clip-a'], codeVersion: CV });
  q.handle('agent', { type: 'task.publish', tasks: [plan, backfill], reqId: 'a2' });
  assert.deepEqual(msgs('agent', 'task.published')[0].results.map((r) => [r.id, r.created]), [[plan.id, true], [backfill.id, true]]);

  // 渲染服务（host 档）：节点侧过滤认领得了这两种带片段清单的计划，与发布方是谁无关（R3）
  const hostNode = { profile: 'host', nodeId: 'hosted-render:x/y', envFingerprint: FP, codeVersions: [CV], capabilities: HOST_CAPABILITIES };
  q.connect('render', render);
  q.handle('render', { type: 'node.hello', nodeId: hostNode.nodeId, profile: 'host', envFingerprint: FP, codeVersions: [CV], capabilities: HOST_CAPABILITIES, reqId: 'r1' });
  q.handle('render', { type: 'publisher.hello', publisherId: hostNode.nodeId, reqId: 'r2' });
  q.handle('render', { type: 'queue.watch', projects: [PROJECT], reqId: 'r3' });
  const seen = msgs('render', 'queue.snapshot').at(-1).tasks;
  for (const id of [plan.id, backfill.id]) {
    const view = seen.find((t) => t.id === id);
    assert.ok(view, '主机看得见服务身份发布的计划');
    assert.deepEqual(checkClaimable(view, hostNode), { ok: true }, `${id}：主机认领得了`);
  }
  assert.equal(checkClaimable({ ...seen.find((t) => t.id === plan.id), resultKey: `${PROJECT}@7`, id: `plan:${PROJECT}@7` }, hostNode).ok, false, '不带片段清单的计划主机不接（照旧）');

  q.handle('render', { type: 'task.claim', id: plan.id, expectVersion: 1, reqId: 'r4' });
  const claimed = msgs('render', 'task.claimed').at(-1);
  assert.equal(claimed.id, plan.id);
  // 切分：按自己的指纹发两段细任务（derivedFrom 指向计划）
  const fine = ['seg-1', 'seg-2'].map((label) => ({ ...fineTask(PROJECT, label), source: { projectId: PROJECT, projectRev: 7, derivedFrom: plan.id } }));
  q.handle('render', { type: 'task.publish', tasks: fine, reqId: 'r5' });
  q.handle('render', { type: 'task.complete', id: plan.id, token: claimed.token, result: {}, reqId: 'r6' });
  assert.equal(task(plan.id).state, 'done');
  assert.deepEqual(task(fine[0].id).subscribers.sort(), ['agent-pub-1', hostNode.nodeId].sort(), '细任务的订阅者 = 切分方 + 计划的订阅者');
  assert.equal(msgs('agent', 'task.done').filter((m) => m.id === plan.id).length, 1, '发布方收到计划完成');

  // 第一段做完：发布方收到这一段的完成通知——这就是它看得到的进度（按段，不是按帧）
  q.handle('render', { type: 'task.claim', id: fine[0].id, expectVersion: 1, reqId: 'r7' });
  const c1 = msgs('render', 'task.claimed').at(-1);
  q.handle('render', { type: 'task.progress', id: fine[0].id, token: c1.token, done: 10, reqId: 'r8' });
  assert.equal(msgs('agent').filter((m) => /progress|renewed/.test(m.type)).length, 0, '帧级的进度不转给发布方');
  q.handle('render', { type: 'task.complete', id: fine[0].id, token: c1.token, result: { manifest: 'm1' }, reqId: 'r9' });
  assert.deepEqual(msgs('agent', 'task.done').map((m) => m.id), [plan.id, fine[0].id], '每做完一段，发布方收到一条 task.done');

  // 发布方断开，超过宽限期：它的订阅被移除；还没认领的第二段**不丢**（切分方自己也是订阅者），照样能认领、做完（R4）
  q.disconnect('agent');
  advance(QUEUE_DEFAULTS.RECONNECT_GRACE_MS + 1);
  q.tick();
  assert.deepEqual(q.describe().publishers.map((p) => p.publisherId), [hostNode.nodeId], '发布方的记录过了宽限期被清掉');
  assert.equal(task(fine[1].id)?.state, 'open', '第二段还在');
  assert.deepEqual(task(fine[1].id).subscribers, [hostNode.nodeId]);
  q.handle('render', { type: 'task.claim', id: fine[1].id, expectVersion: 1, reqId: 'r10' });
  const c2 = msgs('render', 'task.claimed').at(-1);
  q.handle('render', { type: 'task.complete', id: fine[1].id, token: c2.token, result: { manifest: 'm2' }, reqId: 'r11' });
  assert.equal(task(fine[1].id).state, 'done', '发布方不在，照样做完');

  // 宽限期内重连（同一个 publisherId）：订阅还在，什么都不丢
  const { q: q2, advance: adv2, msgs: msgs2, task: task2 } = bareQueue();
  q2.connect('agent', agent);
  q2.handle('agent', { type: 'publisher.hello', publisherId: 'agent-pub-1' });
  q2.handle('agent', { type: 'task.publish', tasks: [plan] });
  q2.disconnect('agent');
  adv2(QUEUE_DEFAULTS.RECONNECT_GRACE_MS - 1000);
  q2.tick();
  assert.equal(task2(plan.id)?.state, 'open', '宽限期内计划还在');
  q2.connect('agent-2', agent);
  q2.handle('agent-2', { type: 'publisher.hello', publisherId: 'agent-pub-1' });
  adv2(5000);
  q2.tick();
  assert.equal(task2(plan.id)?.state, 'open', '重连接上了，计划不撤');
  // 边界：计划还没被任何节点认领，发布方走了并超过宽限期 → 计划被撤（没人要了）。所以发布连接至少要保持到计划被认领
  q2.disconnect('agent-2');
  adv2(QUEUE_DEFAULTS.RECONNECT_GRACE_MS + 1);
  q2.tick();
  assert.equal(task2(plan.id), undefined, '没认领的计划随发布方一起撤掉');
  void msgs2;
});

/* ================================================================== HR26、HR27 */

test('HR26 产物到了容量上限：素材服务回 507 service-quota 时任务按不可重试失败，主机全部项目暂停认领 10 分钟，到点恢复', async () => {
  // 识别：素材客户端对 5xx 重试用尽后抛的错
  const quotaErr = Object.assign(new Error('asset 507'), { status: 507, body: { error: 'service-quota' } });
  assert.equal(isServiceQuotaError(quotaErr), true);
  assert.equal(isServiceQuotaError(Object.assign(new Error('x'), { status: 507, body: { error: 'disk-full' } })), false, '别的 507 不算');
  assert.equal(isServiceQuotaError(Object.assign(new Error('x'), { status: 500, body: { error: 'service-quota' } })), false);
  assert.equal(isServiceQuotaError(null), false);
  assert.equal(QUOTA_PAUSE_MS, 10 * 60_000);

  // 产物库遇到它抛不可重试的 service-quota：见 artifact-transfer.test.mjs 的 T6

  // 主机：任务以 service-quota 失败 → 这个项目与别的项目都暂停认领 10 分钟
  const env = createSpaces(['proj-a', 'proj-b']);
  let quota = true;
  const sinkOf = () => ({
    async has() { return false; },
    async put() { if (quota) throw Object.assign(new Error(SERVICE_QUOTA), { code: SERVICE_QUOTA, status: 507, retryable: false }); return { complete: true, result: {} }; },
  });
  const events = [];
  const host = createRenderHost({
    entries: [], dynamic: true,
    connect: (entry) => ({
      endpoint: env.spaces.get(entry.projectId).lb.connect(`host-${entry.projectId}`, { userId: 'service:render@instance-00000001', tenantId: entry.projectId }),
      executor: fakeExecutor(), sink: sinkOf(),
    }),
    nodeIdOf: (entry) => `hosted-render:test/${entry.projectId}`,
    envFingerprint: FP, codeVersion: CV, maxConcurrent: 2, now: env.clock.now, random: () => 0,
    onEvent: (e) => events.push(e),
  });
  host.start();
  host.add({ projectId: 'proj-a' });
  host.add({ projectId: 'proj-b' });
  assert.equal(host.quotaPausedUntil, null);
  const a1 = fineTask('proj-a', 'quota-1');
  env.spaces.get('proj-a').publish([a1]);
  await drive(env, () => host.tick(), () => events.some((e) => e.type === 'quota-paused'));
  const failMsg = env.spaces.get('proj-a').sent('host-proj-a').find((m) => m.type === 'task.fail');
  assert.deepEqual([failMsg.error, failMsg.retryable], [SERVICE_QUOTA, false], '报给队列的是不可重试的失败');
  assert.equal(env.spaces.get('proj-a').task(a1.id).state, 'failed', '队列不再把它放回去重试');
  const until = host.quotaPausedUntil;
  assert.equal(until, events.find((e) => e.type === 'quota-paused').until);
  assert.ok(until - env.clock.now() > QUOTA_PAUSE_MS - 5000);

  quota = false;
  const b1 = fineTask('proj-b', 'quota-2');
  env.spaces.get('proj-b').publish([b1]);
  const claimsBefore = env.spaces.get('proj-b').sent('host-proj-b').filter((m) => m.type === 'task.claim').length;
  await drive(env, () => host.tick(), () => true, 12);
  assert.equal(env.spaces.get('proj-b').task(b1.id).state, 'open', '暂停期间别的项目的任务也不认领');
  assert.equal(env.spaces.get('proj-b').sent('host-proj-b').filter((m) => m.type === 'task.claim').length, claimsBefore);
  env.clock.advance(until - env.clock.now() + 1);
  assert.equal(host.quotaPausedUntil, null, '到点');
  await drive(env, () => host.tick(), () => env.spaces.get('proj-b').task(b1.id)?.state === 'done');
  host.shutdown('test');
});

test('HR27 工作进程起来了却不交诊断：超过时限判为卡住；Vite 缓存目录在数据目录下、不可写时自检报 data-dir', async () => {
  const base = { running: true, ready: true, startedAt: 1000, reportAt: 0, limitMs: 180_000 };
  assert.equal(reportStale({ ...base, now: 1000 + 180_000 }), false, '刚到时限不算');
  assert.equal(reportStale({ ...base, now: 1000 + 180_001 }), true, '起来后从没交过诊断');
  assert.equal(reportStale({ ...base, reportAt: 100_000, now: 100_000 + 180_001 }), true, '交到一半停了');
  assert.equal(reportStale({ ...base, reportAt: 100_000, now: 200_000 }), false);
  assert.equal(reportStale({ ...base, reportAt: 500, startedAt: 300_000, now: 400_000 }), false, '重起之后按新的起点算，不看上一个进程的诊断');
  assert.equal(reportStale({ ...base, ready: false, now: 9e9 }), false, '还没就绪（在起）不算');
  assert.equal(reportStale({ ...base, running: false, now: 9e9 }), false);

  const c = renderServiceConfig({ PROMPTCUT_RENDER_DATA: path.join(os.tmpdir(), 'pc-hr27-data') });
  assert.equal(c.viteCacheDir, path.join(c.dataDir, 'vite-cache'));
  assert.equal(c.reportTimeoutMs, 180_000);
  assert.throws(() => renderServiceConfig({ PROMPTCUT_RENDER_REPORT_TIMEOUT_MS: '10' }), (e) => e.code === 'bad-config');
  const seen = [];
  const good = {
    nodeVersion: '24.21.0', readKey: () => ({ service: 'render', kid: 'K', instanceId: 'instance-0000000001' }),
    chrome: async () => ({ ok: true, version: 'v', cjk: true, noSandbox: null }), ffmpeg: () => ({ ok: true, h264: true, version: '6' }), cgroup: () => ({ ok: true }),
  };
  const ok = await runSelfcheck({ secretsDir: 'S', dataDir: 'D', viteCacheDir: 'D/vite-cache' }, { ...good, checkDir: (d) => { seen.push(d); } });
  assert.deepEqual([ok.ok, seen], [true, ['D', 'D/vite-cache']]);
  const bad = await runSelfcheck({ secretsDir: 'S', dataDir: 'D', viteCacheDir: 'D/vite-cache' }, { ...good, checkDir: (d) => { if (d.endsWith('vite-cache')) throw Object.assign(new Error('x'), { code: 'EACCES' }); } });
  assert.deepEqual(bad.errors.map((e) => e.reason), ['data-dir']);
  assert.match(bad.errors[0].detail, /Vite 缓存目录.*EACCES/);
});
