/**
 * 任务书 `docs/plan/render-refactor-task.md`「甲三」渲染服务那一半:云端的渲染服务以能产轨道流的方式起,产不产由每个项目的
 * 「生成轨道流」(项目记录 `hosted.render.streams`,缺省关)定;在线页面发的清单计划连切分方自己的那一份流一起出。
 *
 *   HRS-01  管理进程给工作进程的清单:每一项的 `streams` = 渲染节点开着并且这一项显式开着(`broker.mjs` 的 `selectProjects`)
 *   HRS-02  工作进程一侧问「这个项目产不产流」(`project-streams.mjs`):没问到过、过期了按不产;每次被问顺手更新
 *   HRS-03  `listPlanOverrides`:`ownListStreams` 为真才出切分方自己的那一份,而且只给单卡流;不为真照旧只给浏览器
 *   HRS-04  local-node 切清单计划:自己的一份与浏览器的一份成对(`dual`),自己那一份要本机转码
 *   HRS-05  local-node 的认领闸:执行器说不接(`accepts`)的流任务不认领,快照任务照常;没有 `accepts` 的执行器行为不变
 *   HRS-06  执行器:`accepts` 按项目问;不按项目管(桌面、普通渲染主机)时都接;切分清单计划时按项目收 `ownListStreams`
 *   HRS-07  执行器把清单计划的流任务对回这一版:本机这一版的流里没有它,按任务的片段现算单卡流再对;不是清单计划的照旧对不上
 *   HRS-08  管理进程的配置:`PROMPTCUT_RENDER_STREAMS=1` 才以能产流的方式起
 *
 * 跑:node --test server/test/hosted-render-streams.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectProjects, streamsOn } from '../hosted-render/broker.mjs';
import { createProjectStreams, workerProjectStreams, BROKER_URL_ENV, BROKER_KEY_ENV } from '../hosted-render/project-streams.mjs';
import { renderServiceConfig } from '../hosted-render/main.mjs';
import { createLocalNode, listPlanOverrides } from '../render-node/local-node.mjs';
import { createPrerenderExecutor } from '../prerender-executor.mjs';
import { planListStreams, planStreams, queueStreamOf } from '../frame-stream.mjs';
import { resultKeyOf } from '../render-node/fingerprint.mjs';
import { rk, clipsPlan } from './m7-kit.mjs';

const OWN = '1111111111111111';
const BR = '2222222222222222';

/* ================================================================== HRS-01 */

test('HRS-01 清单里每一项的 streams:渲染节点开着并且「生成轨道流」显式开着才是 true;只关这一项的项目照样列', () => {
  const hosted = (enabled, streams) => ({ render: { available: true, enabled, ...(streams === undefined ? {} : { streams }) }, agent: { available: false, enabled: true } });
  const dir = [
    { projectId: 'sp_on', enabled: true, active: true, members: true, since: 1, hosted: hosted(true, true) },
    { projectId: 'sp_off', enabled: true, active: true, members: true, since: 2, hosted: hosted(true, false) },
    // 旧文档服务不报这一项:按关
    { projectId: 'sp_old', enabled: true, active: true, members: true, since: 3, hosted: hosted(true) },
    { projectId: 'sp_nohosted', enabled: true, active: true, members: true, since: 4, hosted: null },
    // 渲染节点关着:不列(这一项开着也没用)
    { projectId: 'sp_render_off', enabled: false, active: true, members: true, since: 5, hosted: hosted(false, true) },
    // 排空中的项目同样带
    { projectId: 'sp_drain', enabled: true, active: false, members: false, since: null, hosted: hosted(true, true) },
  ];
  const out = selectProjects({ directory: dir, held: { sp_drain: 1 }, maxProjects: 16, instanceId: 'instance-0123456789' });
  assert.deepEqual(out.projects.map((p) => [p.projectId, p.streams, p.drain]), [
    ['sp_on', true, false], ['sp_off', false, false], ['sp_old', false, false], ['sp_nohosted', false, false], ['sp_drain', true, true],
  ]);
  assert.equal(streamsOn({ enabled: false, hosted: hosted(false, true) }), false, '渲染节点关着:这一项开着也不产');
  assert.equal(streamsOn({ enabled: true, hosted: { render: { streams: 'yes' } } }), false, '不是布尔 true 不算开');
  assert.equal(streamsOn(null), false);
  // 别的字段没变(原有的断言在 hosted-render-service.test.mjs 的 HR17)
  assert.deepEqual(Object.keys(out.projects[0]).sort(), ['drain', 'members', 'nodeId', 'projectId', 'streams']);
});

/* ================================================================== HRS-02 */

function fakeBroker() {
  const state = { projects: [], status: 200, calls: 0, auth: [], fail: false, hold: null };
  const fetch = async (url, init) => {
    state.calls += 1;
    state.auth.push([String(url), init?.headers?.authorization]);
    if (state.hold) await state.hold;
    if (state.fail) throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
    return { status: state.status, json: async () => (state.status === 200 ? { ok: true, docUrl: 'ws://x', paused: false, projects: state.projects } : { ok: false, error: 'unauthorized' }) };
  };
  return { state, fetch };
}
const turn = () => new Promise((resolve) => setImmediate(resolve));

test('HRS-02 工作进程问「产不产流」:没问到过、过期了都按不产;每次被问顺手更新;问不到时手里没过期的照用;口令只进请求头', async () => {
  const { state, fetch } = fakeBroker();
  let t = 1000;
  const ps = createProjectStreams({ url: 'http://127.0.0.1:5399/', key: 'k-secret', fetch, now: () => t, refreshAfterMs: 300, maxAgeMs: 1200 });
  state.projects = [{ projectId: 'sp_on', streams: true }, { projectId: 'sp_off', streams: false }, { projectId: 'sp_old' }];
  assert.equal(ps.allowed('sp_on'), false, '从没问到过:不认领');
  assert.equal(state.calls, 1, '顺手在后台问了一次');
  await turn(); await turn();
  assert.equal(ps.allowed('sp_on'), true, '下一拍:照问到的清单');
  assert.equal(ps.allowed('sp_off'), false);
  assert.equal(ps.allowed('sp_old'), false, '清单里没带这一项:不产');
  assert.equal(ps.allowed('sp_unknown'), false, '清单里没有这个项目:不产');
  assert.equal(state.calls, 1, '刚问到的不重复问');
  assert.deepEqual(state.auth[0], ['http://127.0.0.1:5399/projects', 'Bearer k-secret']);

  // 认领闸每一拍(500 ms)问一次:每一拍答的是上一拍问到的,同时再问一次
  // 创建者在这两拍之间关掉这一项:这一拍还按上一拍的答(最多晚一拍),下一拍就是 false
  t += 500;
  state.projects = [{ projectId: 'sp_on', streams: false }];
  assert.equal(ps.allowed('sp_on'), true, '这一拍按上一拍问到的');
  assert.equal(state.calls, 2, '同时再问一次');
  await turn(); await turn();
  t += 500;
  assert.equal(ps.allowed('sp_on'), false, '下一拍生效');
  await turn(); await turn();

  // 手里占满、一阵子没问过:清单过期,腾出手来的第一拍不认领(哪怕上一次问到的是开着),先问到新的
  state.projects = [{ projectId: 'sp_on', streams: true }];
  t += 500;
  ps.allowed('sp_on');
  await turn(); await turn();
  assert.equal(ps.allowed('sp_on'), true);
  state.projects = [{ projectId: 'sp_on', streams: false }];
  t += 5000;
  assert.equal(ps.allowed('sp_on'), false, '过期的清单不作数:这一拍不认领');
  await turn(); await turn();
  assert.equal(ps.allowed('sp_on'), false, '问到新的:确实关了');

  // fresh:先问到新的再答
  state.projects = [{ projectId: 'sp_on', streams: true }];
  t += 500;
  const before = state.calls;
  assert.equal(await ps.fresh('sp_on'), true);
  assert.equal(state.calls, before + 1);
  assert.equal(await ps.fresh('sp_on'), true);
  assert.equal(state.calls, before + 1, '刚问到的不重复问');

  // 问不到(管理进程不在):手里的还没过期就照用,不抛;过期了答 false
  state.fail = true;
  t += 500;
  assert.equal(await ps.fresh('sp_on'), true);
  assert.equal(ps.status().lastError, 'ECONNREFUSED');
  t += 1000;
  assert.equal(await ps.fresh('sp_on'), false, '问不到、手里的又过期了:不产');
  assert.equal(ps.allowed('sp_on'), false);
  await turn(); await turn();
  // 被拒(口令不对):同样
  state.fail = false; state.status = 401;
  assert.equal(await ps.fresh('sp_on'), false);
  assert.equal(ps.status().lastError, 'unauthorized');
  assert.equal(JSON.stringify(ps.status()).includes('k-secret'), false, '诊断里没有口令');

  // 同一时刻只问一次
  state.status = 200;
  let release;
  state.hold = new Promise((resolve) => { release = resolve; });
  t += 1000;
  const n = state.calls;
  ps.allowed('sp_on'); ps.allowed('sp_on');
  const waiting = ps.fresh('sp_on');
  assert.equal(state.calls, n + 1);
  release(); state.hold = null;
  assert.equal(await waiting, true);
});

test('HRS-02 不是托管方渲染服务的工作进程(没有代理口的环境变量):没有这道闸', () => {
  assert.equal(workerProjectStreams({}), null);
  assert.equal(workerProjectStreams({ [BROKER_URL_ENV]: '  ' }), null);
  const a = workerProjectStreams({ [BROKER_URL_ENV]: 'http://127.0.0.1:1', [BROKER_KEY_ENV]: 'k1' });
  assert.equal(typeof a.allowed, 'function');
  assert.equal(workerProjectStreams({ [BROKER_URL_ENV]: 'http://127.0.0.1:1', [BROKER_KEY_ENV]: 'k1' }), a, '同一个进程里共用一份');
});

/* ================================================================== HRS-03 */

function control(clipId, extra = {}) {
  return {
    clipId, cardId: `card-${clipId}`, snapshotKey: rk(`ck-${clipId}`, OWN), contentKey: `ck-${clipId}`, tier: 'shared',
    start: 1.5, end: 5.5, count: 120, sampling: { firstFrame: 45, phase: { numerator: 0, denominator: 1 } },
    compositing: 'independent', capabilities: { compositing: 'independent' }, ...extra,
  };
}
const weightOf = () => ({ class: 'medium', estMs: null });
function cardStream(clipId, extra = {}) {
  return {
    streamKey: rk(`sk-${clipId}`, OWN), contentKey: `sk-${clipId}`, topClipId: clipId, firstSegment: 3, lastSegment: 10,
    kind: 'card', plane: 'local', clipIds: [clipId], fps: 30, bound: { x: -32, y: -32, w: 464, h: 304 }, offset: { x: 760, y: 420 },
    firstFrame: 45, lastFrame: 164, total: 300, ...extra,
  };
}
const groupStream = () => cardStream('b', { streamKey: rk('sk-g', OWN), contentKey: 'sk-g', kind: 'group', plane: 'stage', clipIds: ['a', 'b'] });

test('HRS-03 listPlanOverrides:ownListStreams 为真才出切分方自己的那一份(只给单卡流);不为真、补渲计划、旧执行器照旧', () => {
  const list = clipsPlan({ clips: ['a', 'b'] });
  const browserStreamsFor = () => [cardStream('a'), groupStream()];
  const off = listPlanOverrides(list, { browserStreamsFor });
  assert.deepEqual(off.streams.map((s) => [s.topClipId, s.kind, s.browserOnly === true]), [['a', 'card', true], ['b', 'group', true]], '不为真:都只给浏览器');
  assert.deepEqual(listPlanOverrides(list, { browserStreamsFor, ownListStreams: false }).streams, off.streams);
  assert.deepEqual(listPlanOverrides(list, { browserStreamsFor, ownListStreams: 1 }).streams, off.streams, '只认布尔 true');
  const on = listPlanOverrides(list, { browserStreamsFor, ownListStreams: true });
  assert.deepEqual(on.streams.map((s) => [s.topClipId, s.kind, 'browserOnly' in s]), [['a', 'card', false], ['b', 'group', true]], '为真:单卡流连自己的一份;组流仍不出');
  assert.deepEqual([...on.prerenderSet], ['a', 'b']);
  assert.equal(on.lane, 'normal');
  // 补渲计划不切流;旧执行器(不给 browserStreamsFor)不切流;不是带清单的计划不改
  const backfill = { ...list, id: list.id.replace('#clips:', '#backfill:'), resultKey: list.resultKey.replace('#clips:', '#backfill:'), priority: 'backfill' };
  assert.deepEqual(listPlanOverrides(backfill, { browserStreamsFor, ownListStreams: true }).streams, []);
  assert.deepEqual(listPlanOverrides(list, { ownListStreams: true }).streams, []);
  assert.deepEqual(listPlanOverrides({ id: 'plan:p1@1', kind: 'plan', resultKey: 'p1@1', input: {} }, { browserStreamsFor, ownListStreams: true }), {});
});

/* ================================================================== HRS-04 / HRS-05 */

/** 假端点上的一个节点:回它发出去的消息与往里塞消息的口子 */
function nodeOn({ executor, canClaim, capabilities = { transcode: true, streams: true }, profile = 'host' }) {
  const sent = [];
  let handler = () => {};
  const endpoint = { send: (m) => { sent.push(m); }, onMessage: (h) => { handler = h; } };
  const node = createLocalNode({
    nodeId: 'n-host', node: { profile, envFingerprint: OWN, codeVersions: ['cv-1'], capabilities },
    endpoint, now: () => 1000, codeVersion: 'cv-1', projects: ['p1'], maxConcurrent: 1,
    executor, sink: { has: async () => false, put: async () => ({ complete: false }) },
    ...(canClaim ? { canClaim } : {}),
  });
  node.start();
  handler({ type: 'node.welcome', nodeId: 'n-host', epoch: 1 });
  return { node, sent, deliver: (m) => handler(m) };
}
const open = (task) => ({ ...task, state: 'open', version: 1, source: { ...task.source, userId: 'u@d' } });

async function publishedBy({ planTask, plan }) {
  const { node, sent, deliver } = nodeOn({ executor: { plan: async () => plan, render: async () => null }, profile: 'pc' });
  const view = open(planTask);
  deliver({ type: 'queue.snapshot', epoch: 1, tasks: [view] });
  node.tick();
  assert.ok(sent.find((m) => m.type === 'task.claim'), '节点认领了 plan');
  deliver({ type: 'task.claimed', id: planTask.id, token: 1, task: view, browserFingerprints: [BR], epoch: 1 });
  for (let i = 0; i < 20 && !sent.some((m) => m.type === 'task.publish'); i++) await turn();
  const publish = sent.find((m) => m.type === 'task.publish');
  node.stop();
  return publish?.tasks ?? null;
}

test('HRS-04 local-node 切清单计划:ownListStreams 为真时流出两份(自己的、浏览器的),成对;为假时只有浏览器那一份', async () => {
  const base = { entryKey: 'entry-1', cardPlan: [control('a')], weightOf, streams: [], browserStreamsFor: () => [cardStream('a')] };
  const list = clipsPlan({ clips: ['a'] });
  const both = (await publishedBy({ planTask: list, plan: { ...base, ownListStreams: true } })).filter((t) => t.kind === 'stream');
  assert.deepEqual(both.map((t) => t.requires.envFingerprint), [OWN, BR], '切分方自己的在前');
  const [own, br] = both;
  assert.equal(own.resultKey, rk('sk-a', OWN));
  assert.equal(own.requires.transcode, true, '自己那一份要本机转码');
  assert.deepEqual(own.requires.capabilities, { streams: true });
  assert.deepEqual(own.input, { clipId: 'a', cardId: null, entryKey: null, contentKey: 'sk-a', dual: true });
  assert.equal(br.requires.transcode, false);
  assert.equal(br.input.dual, true);
  assert.equal(own.source.derivedFrom, list.id, '带着清单计划的 id(执行器靠它认「清单计划切出的」)');
  assert.equal(own.priority, 10, '清单计划照 normal 的名次');
  const only = (await publishedBy({ planTask: list, plan: { ...base, ownListStreams: false } })).filter((t) => t.kind === 'stream');
  assert.deepEqual(only.map((t) => t.requires.envFingerprint), [BR]);
  assert.equal('dual' in only[0].input, false);
});

const streamTaskFor = (projectId = 'p1') => ({
  id: `stream:${rk('sk-a', OWN)}:3-10`, kind: 'stream', resultKey: rk('sk-a', OWN), range: { unit: 'segment', from: 3, to: 10 },
  source: { projectId, projectRev: 1, derivedFrom: clipsPlan({ projectId, clips: ['a'] }).id },
  input: { clipId: 'a', cardId: null, entryKey: null, contentKey: 'sk-a' }, weight: { class: 'medium', estMs: null, frames: 120 },
  requires: { envFingerprint: OWN, codeVersion: 'cv-1', cardSources: {}, transcode: true, userCards: false, graphCards: false, belowDependent: false, capabilities: { streams: true } },
  priority: 10,
});
const snapTaskFor = (projectId = 'p1') => ({
  id: `snapshot:${rk('ck-a', OWN)}:0-59`, kind: 'snapshot', tier: 'shared', resultKey: rk('ck-a', OWN), range: { unit: 'localFrame', from: 0, to: 59 },
  source: { projectId, projectRev: 1, derivedFrom: clipsPlan({ projectId, clips: ['a'] }).id },
  input: { clipId: 'a', cardId: 'card-a', entryKey: null, contentKey: 'ck-a', canvasHeavy: false }, weight: { class: 'medium', estMs: null, frames: 60 },
  requires: { envFingerprint: OWN, codeVersion: 'cv-1', cardSources: {}, transcode: false, userCards: false, graphCards: false, belowDependent: false },
  priority: 10,
});

test('HRS-05 认领闸:执行器说不接的流任务不认领,快照任务照常;放开后下一拍就认领;没有 accepts 的执行器行为不变', () => {
  let allow = false;
  const asked = [];
  const executor = { plan: async () => ({}), render: () => new Promise(() => {}), accepts: (task) => { asked.push(task.kind); return task.kind !== 'stream' || allow; } };
  const stream = open(streamTaskFor()), snap = open(snapTaskFor());

  // 只有流任务:关着时一拍也不认领
  const a = nodeOn({ executor });
  a.deliver({ type: 'queue.snapshot', epoch: 1, tasks: [stream] });
  a.node.tick(); a.node.tick();
  assert.equal(a.sent.filter((m) => m.type === 'task.claim').length, 0, '没打开:不认领流任务');
  assert.ok(asked.includes('stream'));
  // 打开之后下一拍认领
  allow = true;
  a.node.tick();
  assert.deepEqual(a.sent.filter((m) => m.type === 'task.claim').map((m) => m.id), [stream.id]);
  a.node.stop();

  // 流任务与快照任务都在:关着时只认领快照
  allow = false;
  const b = nodeOn({ executor });
  b.deliver({ type: 'queue.snapshot', epoch: 1, tasks: [stream, snap] });
  b.node.tick();
  assert.deepEqual(b.sent.filter((m) => m.type === 'task.claim').map((m) => m.id), [snap.id], '快照任务照常');
  b.node.stop();

  // 调用方另给了 canClaim(独立渲染主机的 lane 闸):两道都过才认领
  allow = true;
  const seen = [];
  const c = nodeOn({ executor, canClaim: (task) => { seen.push(task.id); return false; } });
  c.deliver({ type: 'queue.snapshot', epoch: 1, tasks: [stream] });
  c.node.tick();
  assert.equal(c.sent.filter((m) => m.type === 'task.claim').length, 0);
  assert.deepEqual(seen, [stream.id], '执行器接了才问到调用方那一道');
  c.node.stop();

  // accepts 抛错按不接
  const d = nodeOn({ executor: { ...executor, accepts: () => { throw new Error('boom'); } } });
  d.deliver({ type: 'queue.snapshot', epoch: 1, tasks: [snap] });
  d.node.tick();
  assert.equal(d.sent.filter((m) => m.type === 'task.claim').length, 0);
  d.node.stop();

  // 没有 accepts(测试替身、旧执行器):与原来相同,流任务照认领
  const e = nodeOn({ executor: { plan: async () => ({}), render: () => new Promise(() => {}) } });
  e.deliver({ type: 'queue.snapshot', epoch: 1, tasks: [stream] });
  e.node.tick();
  assert.deepEqual(e.sent.filter((m) => m.type === 'task.claim').map((m) => m.id), [stream.id]);
  e.node.stop();
});

/* ================================================================== HRS-06 / HRS-07 */

/** 最小的 entry:两张独立卡,`planStreams` 认得的形状(同 browser-stream-split.test.mjs 的 entryOf) */
function entryOf() {
  const project = { id: 'p1', width: 1920, height: 1080, fps: 30, duration: 10, tracks: [
    { id: 't1', clips: [{ id: 'a', cardId: 'punch-pill', start: 1.5, end: 5.5, frame: { x: 960, y: 540, w: 400, h: 240, anchor: [0.5, 0.5] } }] },
    { id: 't2', clips: [{ id: 'b', cardId: 'punch-pill', start: 0, end: 2 }] },
  ] };
  const cardPlan = [
    { clipId: 'a', contentKey: 'c'.repeat(64), snapshotKey: 'd'.repeat(64), count: 120, sampling: { firstFrame: 45 }, capabilities: { compositing: 'independent' } },
    { clipId: 'b', contentKey: 'e'.repeat(64), snapshotKey: 'f'.repeat(64), count: 60, sampling: { firstFrame: 0 }, capabilities: { compositing: 'independent' } },
  ];
  return { key: 'entry-1', project, cardPlan };
}

/** 假管线:本机这一版的流是 `ownSpecs`(本机判重的);`listStreamSpecs` 用真的 `planListStreams` */
function fakePipeline({ entry = entryOf(), ownSpecs = [], ownListStreams = true, capable = true } = {}) {
  const produced = [];
  const backfilled = [];
  const picked = new Set();
  const pipeline = {
    envFingerprint: OWN, entries: new Map(),
    queueHandles: () => true,
    planForQueue: async () => ({ entry, context: { entryKey: entry.key, cardPlan: entry.cardPlan, streams: ownSpecs.map(queueStreamOf), browserStreamsFor: (clips) => pipeline.listStreamSpecs(entry, clips).map(queueStreamOf), ownListStreams }, streamSpecs: ownSpecs }),
    listStreamSpecs: (e, clips) => planListStreams(e, clips, { envFingerprint: OWN, codeVersion: 'cv' }),
    streamCapable: async () => capable,
    renderStreamRange: async (e, spec, range) => { produced.push({ streamKey: spec.streamKey, kind: spec.kind, clipIds: spec.clipIds, range }); return null; },
    prerenderPicked: (e, clipId) => picked.has(clipId),
    addBackfill: (e, clips) => { for (const id of clips) { picked.add(id); backfilled.push(id); } return clips.length; },
  };
  return { pipeline, produced, backfilled, entry };
}
const projectsOf = (entry) => ({ get: async () => entry.project });
const gate = (table) => ({ allowed: (id) => table[id] === true, fresh: async (id) => table[id] === true });

test('HRS-06 执行器 accepts:托管方的工作进程按项目问,没打开的项目不接流任务、快照与计划照常;不按项目管时都接', async () => {
  const { pipeline, entry } = fakePipeline();
  const table = { p_on: true, p_off: false };
  const hosted = createPrerenderExecutor({ pipeline, projects: projectsOf(entry), projectStreams: gate(table) });
  assert.equal(hosted.accepts(streamTaskFor('p_on')), true);
  assert.equal(hosted.accepts(streamTaskFor('p_off')), false);
  assert.equal(hosted.accepts(streamTaskFor('p_unknown')), false, '问不到的项目按不产');
  assert.equal(hosted.accepts(snapTaskFor('p_off')), true, '快照任务照常');
  assert.equal(hosted.accepts(clipsPlan({ projectId: 'p_off' })), true, '计划任务照常');
  // 创建者中途关掉:下一次问就不接;手里已经认领的不归这里管(render 里不看这一项)
  table.p_on = false;
  assert.equal(hosted.accepts(streamTaskFor('p_on')), false);
  // 问的那一头出错:按不产
  const broken = createPrerenderExecutor({ pipeline, projects: projectsOf(entry), projectStreams: { allowed: () => { throw new Error('x'); } } });
  assert.equal(broken.accepts(streamTaskFor('p_on')), false);
  assert.equal(broken.accepts(snapTaskFor('p_on')), true);
  // 桌面应用、普通的独立渲染主机:这一项不管它们
  const desktop = createPrerenderExecutor({ pipeline, projects: projectsOf(entry), projectStreams: null });
  assert.equal(desktop.accepts(streamTaskFor('p_off')), true);
  // 缺省(这个测试进程不是托管方的工作进程):同上
  assert.equal(createPrerenderExecutor({ pipeline, projects: projectsOf(entry) }).accepts(streamTaskFor('p_off')), true);
});

test('HRS-06 执行器 plan:清单计划里切分方自己的那一份,托管方按项目收;本机不能产时不出;桌面照自己能不能产来', async () => {
  const table = { p1: false };
  const list = clipsPlan({ projectId: 'p1', clips: ['a'] });
  const mk = (opts, projectStreams) => { const f = fakePipeline(opts); return createPrerenderExecutor({ pipeline: f.pipeline, projects: projectsOf(f.entry), projectStreams }); };
  assert.equal((await mk({ ownListStreams: true }, gate(table)).plan(list)).ownListStreams, false, '托管方、这一项关着:不出自己的那一份');
  table.p1 = true;
  assert.equal((await mk({ ownListStreams: true }, gate(table)).plan(list)).ownListStreams, true, '托管方、这一项开着:出');
  assert.equal((await mk({ ownListStreams: false }, gate(table)).plan(list)).ownListStreams, false, '本机不能产流(没有编码器、关着流开关):这一项开着也不出');
  assert.equal((await mk({ ownListStreams: true }, null).plan(list)).ownListStreams, true, '桌面:本机能产就出');
  assert.equal((await mk({ ownListStreams: false }, null).plan(list)).ownListStreams, false, '桌面:本机不能产就不出');
  // 同一个执行器、同一版(上下文有缓存):关掉之后再切,跟着变;缓存里的上下文没被改
  const f = fakePipeline({ ownListStreams: true });
  const exec = createPrerenderExecutor({ pipeline: f.pipeline, projects: projectsOf(f.entry), projectStreams: gate(table) });
  assert.equal((await exec.plan(list)).ownListStreams, true);
  table.p1 = false;
  assert.equal((await exec.plan(list)).ownListStreams, false);
  table.p1 = true;
  assert.equal((await exec.plan(list)).ownListStreams, true);
  // 这一版的 entry 上记着「这个项目此刻不产流」(本机写层表时不列自己这一版的流);桌面不按项目管,不写这个记号
  assert.equal(f.entry.ownStreamsOff, false);
  table.p1 = false;
  await exec.plan(list);
  assert.equal(f.entry.ownStreamsOff, true);
  const d = fakePipeline({ ownListStreams: true });
  await createPrerenderExecutor({ pipeline: d.pipeline, projects: projectsOf(d.entry), projectStreams: null }).plan(list);
  assert.equal('ownStreamsOff' in d.entry, false);
  // 这道闸接到 listPlanOverrides 上:关着 → 只给浏览器
  table.p1 = false;
  assert.ok(listPlanOverrides(list, await exec.plan(list)).streams.every((s) => s.browserOnly === true));
  table.p1 = true;
  assert.deepEqual(listPlanOverrides(list, await exec.plan(list)).streams.map((s) => 'browserOnly' in s), [false]);
});

test('HRS-07 执行器把清单计划的流任务对回这一版:本机没判重的卡按任务的片段现算单卡流;结果键、分段范围照核;不是清单计划的照旧对不上', async () => {
  const entry = entryOf();
  const [single] = planListStreams(entry, ['a'], { envFingerprint: OWN, codeVersion: 'cv' });
  assert.equal(single.kind, 'card');
  const taskOf = (extra = {}) => ({
    id: `stream:${single.streamKey}:3-10`, kind: 'stream', resultKey: single.streamKey, range: { unit: 'segment', from: 3, to: 10 },
    source: { projectId: 'p1', projectRev: 1, derivedFrom: clipsPlan({ clips: ['a'] }).id },
    input: { clipId: 'a', cardId: null, entryKey: null, contentKey: single.contentKey }, requires: { envFingerprint: OWN }, ...extra,
  });
  // 本机这一版一条流都没有(渲染服务不判重):照任务的片段对上,交给生产者
  const f = fakePipeline({ entry, ownSpecs: [] });
  const exec = createPrerenderExecutor({ pipeline: f.pipeline, projects: projectsOf(entry), projectStreams: null });
  await exec.render(taskOf(), { progress: () => {} });
  assert.deepEqual(f.produced, [{ streamKey: single.streamKey, kind: 'card', clipIds: ['a'], range: { from: 3, to: 10 } }]);
  assert.deepEqual(f.backfilled, ['a'], '这张卡记进预渲染集合(本机写的层表才列得出这条流)');
  // 本机这一版把 a、b 并成了组流(解码器预算 1):清单计划的单卡流照样对得上
  const grouped = planStreams(entry, { budget: 1, envFingerprint: OWN, codeVersion: 'cv' });
  assert.deepEqual(grouped.map((s) => s.kind), ['group']);
  const g = fakePipeline({ entry, ownSpecs: grouped });
  await createPrerenderExecutor({ pipeline: g.pipeline, projects: projectsOf(entry), projectStreams: null }).render(taskOf(), { progress: () => {} });
  assert.equal(g.produced[0].streamKey, single.streamKey);
  // 本机这一版里本来就有这条流:照旧直接对上
  const h = fakePipeline({ entry, ownSpecs: [single] });
  await createPrerenderExecutor({ pipeline: h.pipeline, projects: projectsOf(entry), projectStreams: null }).render(taskOf(), { progress: () => {} });
  assert.equal(h.produced.length, 1);

  const rejects = async (task, pattern, fake = fakePipeline({ entry, ownSpecs: [] })) => {
    await assert.rejects(() => createPrerenderExecutor({ pipeline: fake.pipeline, projects: projectsOf(entry), projectStreams: null }).render(task, { progress: () => {} }),
      (error) => error.code === 'plan-mismatch' && error.retryable === false && pattern.test(error.message));
    assert.equal(fake.produced.length, 0);
  };
  // 不是清单计划切出的(桌面普通计划的流任务):不走这条回退
  await rejects(taskOf({ source: { projectId: 'p1', projectRev: 1, derivedFrom: 'plan:p1@1' } }), /这一版没有内容键/);
  // 内容键对不上(这张卡改过了)
  await rejects(taskOf({ input: { clipId: 'a', cardId: null, entryKey: null, contentKey: 'f'.repeat(64) } }), /这一版没有内容键/);
  // 结果键不是本机指纹的
  await rejects(taskOf({ resultKey: resultKeyOf(single.contentKey, BR) }), /结果键不是本机指纹的键/);
  // 分段范围越界
  await rejects(taskOf({ range: { unit: 'segment', from: 3, to: 99 } }), /分段范围/);
  // 本机不能产流:不可重试的 no-streams(照旧)
  const no = fakePipeline({ entry, capable: false });
  await assert.rejects(() => createPrerenderExecutor({ pipeline: no.pipeline, projects: projectsOf(entry), projectStreams: null }).render(taskOf(), { progress: () => {} }), (e) => e.code === 'no-streams');
});

/* ================================================================== HRS-08 */

test('HRS-08 管理进程的配置:PROMPTCUT_RENDER_STREAMS=1 才以能产流的方式起工作进程;不设、别的值都是不能产', () => {
  assert.equal(renderServiceConfig({}).streams, false);
  assert.equal(renderServiceConfig({ PROMPTCUT_RENDER_STREAMS: '1' }).streams, true);
  assert.equal(renderServiceConfig({ PROMPTCUT_RENDER_STREAMS: '0' }).streams, false);
  assert.equal(renderServiceConfig({ PROMPTCUT_RENDER_STREAMS: 'true' }).streams, false);
});
