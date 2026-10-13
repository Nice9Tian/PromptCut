/**
 * 任务书 `docs/plan/render-refactor-task.md`「甲三」渲染服务那一半:云端的渲染服务以能产轨道流的方式起,产不产由每个项目的
 * 「生成轨道流」(项目记录 `hosted.render.streams`,缺省关)定;在线页面发的清单计划连切分方自己的那一份流一起出。
 *
 *   HRS-01  管理进程给工作进程的清单:每一项的 `streams` = 渲染节点开着并且这一项显式开着(`broker.mjs` 的 `selectProjects`)
 *   HRS-02  主机按项目「产不产轨道流」(`render-node/host.mjs`):不产的项目不认领流任务、快照与计划照常;按连接所属的项目认,
 *           不看任务里写的 `source.projectId`;运行中开、关当拍生效;关掉不放回手里的认领;「等着的任务数」不数没人做的流任务;
 *           对账把清单里的 `streams` 带到每个项目上;不带这一项的配置(普通的独立渲染主机)不按项目管
 *   HRS-03  `listPlanOverrides`:`ownListStreams` 为真才出切分方自己的那一份,而且只给单卡流;不为真照旧只给浏览器
 *   HRS-04  local-node 切清单计划:自己的一份与浏览器的一份成对(`dual`),自己那一份要本机转码
 *   HRS-06  执行器切清单计划:按项目收 `ownListStreams`;计划写着「页面看到这一项开着」而本机还没看到时等一等
 *   HRS-07  执行器把清单计划的流任务对回这一版:本机这一版的流里没有它,按任务的片段现算单卡流再对;不是清单计划的照旧对不上
 *   HRS-08  管理进程的配置:`PROMPTCUT_RENDER_STREAMS=1` 才以能产流的方式起
 *
 * 跑:node --test server/test/hosted-render-streams.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectProjects, streamsOn } from '../hosted-render/broker.mjs';
import { createRenderHost, reconcileHostProjects } from '../render-node/host.mjs';
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

const turn = () => new Promise((resolve) => setImmediate(resolve));
const open = (task) => ({ ...task, state: 'open', version: 1, source: { ...task.source, userId: 'u@d' } });
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

/** 假端点上的一台主机:每个项目一条假连接,记它发出去的消息,留往里塞消息的口子。`hold` 给了就带(诊断里才有 pending / claimable) */
function hostOn(entries, { maxConcurrent = 1, hold = null, dynamic = false } = {}) {
  const wires = new Map();
  const host = createRenderHost({
    entries, dynamic, maxConcurrent, envFingerprint: OWN, codeVersion: 'cv-1', capabilities: { userCards: false, graphCards: false, transcode: true, streams: true }, now: () => 1000,
    nodeIdOf: (entry) => `n-${entry.projectId}`,
    connect: (entry, index, live) => {
      const sent = [];
      let handler = () => {};
      const handlers = [];
      const endpoint = { send: (m) => { sent.push(m); }, onMessage: (h) => { handlers.push(h); handler = (m) => { for (const f of handlers) f(m); }; } };
      wires.set(entry.projectId, { sent, deliver: (m) => handler(m), live, claims: () => sent.filter((m) => m.type === 'task.claim').map((m) => m.id) });
      return { endpoint, executor: { plan: async () => ({}), render: () => new Promise(() => {}) }, sink: { has: async () => false, put: async () => ({ complete: false }) }, ...(hold ? { hold } : {}) };
    },
  });
  host.start();
  for (const [projectId, w] of wires) w.deliver({ type: 'node.welcome', nodeId: `n-${projectId}`, epoch: 1 });
  return { host, wires, of: (projectId) => wires.get(projectId) };
}
const snapshotOf = (w, tasks) => w.deliver({ type: 'queue.snapshot', epoch: 1, tasks });

test('HRS-02 主机按项目产不产轨道流:不产的项目不认领流任务、快照任务照常;按连接所属的项目认,不看任务里写的项目 id;开了当拍认领', () => {
  const stream = open(streamTaskFor('p_off')), snap = open(snapTaskFor('p_off'));
  // 只有流任务:这个项目不产,一拍也不认领
  const a = hostOn([{ projectId: 'p_off', streams: false }]);
  snapshotOf(a.of('p_off'), [stream]);
  a.host.tick(); a.host.tick();
  assert.deepEqual(a.of('p_off').claims(), [], '没打开:不认领流任务');
  assert.equal(a.host.nodes()[0].streams, false, '诊断里看得到这一项');
  // 创建者打开(清单变了,对账调 setStreams):下一拍认领
  a.host.setStreams('p_off', true);
  a.host.tick();
  assert.deepEqual(a.of('p_off').claims(), [stream.id]);

  // 流任务与快照任务都在:不产时只认领快照
  const b = hostOn([{ projectId: 'p_off', streams: false }]);
  snapshotOf(b.of('p_off'), [stream, snap]);
  b.host.tick();
  assert.deepEqual(b.of('p_off').claims(), [snap.id], '快照任务照常');

  // 任务里写的 source.projectId 与连接所属的项目不是同一个 id(发布方用了别的项目文档 id):照连接所属的项目办
  const odd = open(streamTaskFor('some-other-doc-id'));
  const c = hostOn([{ projectId: 'sp_on', streams: true }, { projectId: 'sp_off', streams: false }], { maxConcurrent: 2 });
  snapshotOf(c.of('sp_on'), [odd]);
  snapshotOf(c.of('sp_off'), [{ ...odd, id: `${odd.id}x`, resultKey: `${odd.resultKey}x` }]);
  c.host.tick();
  assert.deepEqual(c.of('sp_on').claims(), [odd.id], '开着的项目:认领,哪怕任务里写的是别的项目文档 id');
  assert.deepEqual(c.of('sp_off').claims(), [], '关着的项目:不认领');

  // 两个项目各有一个流任务:一个开着一个关着,互不影响
  const d = hostOn([{ projectId: 'p1', streams: true }, { projectId: 'p2', streams: false }], { maxConcurrent: 2 });
  snapshotOf(d.of('p1'), [open(streamTaskFor('p1'))]);
  snapshotOf(d.of('p2'), [open(streamTaskFor('p2'))]);
  d.host.tick(); d.host.tick();
  assert.equal(d.of('p1').claims().length, 1);
  assert.equal(d.of('p2').claims().length, 0);
});

test('HRS-02 关掉这一项:手里的流任务不放回、不中止,只是不再认领新的;连接照旧', () => {
  const first = open(streamTaskFor('p1'));
  const second = { ...first, id: first.id.replace(':3-10', ':11-18'), range: { unit: 'segment', from: 11, to: 18 } };
  const h = hostOn([{ projectId: 'p1', streams: true }], { maxConcurrent: 2 });
  const w = h.of('p1');
  snapshotOf(w, [first, second]);
  h.host.tick();
  const claimed = w.claims()[0];
  w.deliver({ type: 'task.claimed', id: claimed, token: 1, task: claimed === first.id ? first : second, epoch: 1 });
  assert.deepEqual(h.host.nodes()[0].held, [claimed], '手里有一个流任务');
  h.host.setStreams('p1', false);
  h.host.tick(); h.host.tick();
  assert.deepEqual(w.claims(), [claimed], '另一个不再认领');
  assert.equal(w.sent.filter((m) => m.type === 'task.release').length, 0, '没有放回');
  assert.deepEqual(h.host.nodes()[0].held, [claimed], '手里的还在');
  assert.equal(h.host.nodes()[0].released, 0);
  assert.equal(h.host.projects().length, 1, '项目还连着');
  // 只认布尔:别的值不改
  h.host.setStreams('p1', 'yes');
  assert.equal(h.host.nodes()[0].streams, false);
});

test('HRS-02 「等着的任务数」不数没人做的流任务(不然管理进程会为它们起隔离工作进程);开着时照数', () => {
  const stream = open(streamTaskFor('p1')), snap = open(snapTaskFor('p1'));
  const h = hostOn([{ projectId: 'p1', streams: false }], { hold: () => true });
  snapshotOf(h.of('p1'), [stream, snap]);
  h.host.tick();
  let n = h.host.nodes()[0];
  assert.deepEqual([n.hold, n.pending, n.claimable], [true, 1, 1], '关着:只数快照任务');
  const keyOff = n.pendingKey;
  // 只剩流任务:一个也不算
  snapshotOf(h.of('p1'), [stream]);
  n = h.host.nodes()[0];
  assert.deepEqual([n.pending, n.claimable, n.pendingKey], [0, 0, ''], '关着、只有流任务:没有等着的');
  h.host.setStreams('p1', true);
  snapshotOf(h.of('p1'), [stream, snap]);
  n = h.host.nodes()[0];
  assert.deepEqual([n.pending, n.claimable], [2, 2], '开着:流任务也数');
  assert.notEqual(n.pendingKey, keyOff);
});

test('HRS-02 对账把清单里的 streams 带到每个项目上;接线时拿到现读的口子;不带这一项的配置不按项目管', () => {
  const h = hostOn([], { dynamic: true });
  const entryOf = (item) => ({ url: 'ws://x', projectId: item.projectId, members: item.members === true, nodeId: `n-${item.projectId}`, streams: item.streams === true });
  reconcileHostProjects(h.host, { projects: [{ projectId: 'p1', members: true, streams: false }, { projectId: 'p2', members: true }] }, entryOf);
  assert.deepEqual(h.host.nodes().map((n) => [n.projectId, n.streams]), [['p1', false], ['p2', false]], '清单里没有这一项按不产算');
  assert.equal(h.of('p1').live.streams(), false);
  // 清单变了:已经在的项目跟着改,不重连
  reconcileHostProjects(h.host, { projects: [{ projectId: 'p1', members: true, streams: true }, { projectId: 'p2', members: true, streams: false }] }, entryOf);
  assert.deepEqual(h.host.nodes().map((n) => [n.projectId, n.streams]), [['p1', true], ['p2', false]]);
  assert.equal(h.of('p1').live.streams(), true, '执行器手里的口子读到的是现值');
  assert.equal(h.wires.size, 2, '没有重新接线');
  reconcileHostProjects(h.host, { projects: [{ projectId: 'p1', members: true, streams: false }, { projectId: 'p2', members: true, streams: false }] }, entryOf);
  assert.equal(h.of('p1').live.streams(), false);

  // 普通的独立渲染主机(配置项不带 streams):不按项目管,流任务照认领,诊断里没有这一项
  const plain = hostOn([{ projectId: 'p1' }]);
  assert.equal(plain.of('p1').live.streams(), null);
  assert.equal('streams' in plain.host.nodes()[0], false);
  snapshotOf(plain.of('p1'), [open(streamTaskFor('p1'))]);
  plain.host.tick();
  assert.equal(plain.of('p1').claims().length, 1);
  plain.host.setStreams('p1', false);
  assert.equal(plain.host.nodes()[0].streams, false, '之后明说了才按它');
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
    streamKey: rk(`sk-${clipId}`, OWN), contentKey: `sk-${clipId}`, topClipId: clipId, originFrame: 45, firstSegment: 0, lastSegment: 7,
    kind: 'card', plane: 'local', clipIds: [clipId], fps: 30, bound: { x: -32, y: -32, w: 464, h: 304 }, offset: { x: 760, y: 420 },
    firstFrame: 45, lastFrame: 164, total: 300, ...extra,
  };
}
const groupStream = () => cardStream('b', { streamKey: rk('sk-g', OWN), contentKey: 'sk-g', kind: 'group', plane: 'stage', clipIds: ['a', 'b'] });

test('HRS-03 listPlanOverrides:ownListStreams 为真才出切分方自己的那一份(只给单卡流);不为真、预渲染重试计划、旧执行器照旧', () => {
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
  // 预渲染重试计划(backfill)不切流;旧执行器(不给 browserStreamsFor)不切流;不是带清单的计划不改
  const backfill = { ...list, id: list.id.replace('#clips:', '#backfill:'), resultKey: list.resultKey.replace('#clips:', '#backfill:'), priority: 'backfill' };
  assert.deepEqual(listPlanOverrides(backfill, { browserStreamsFor, ownListStreams: true }).streams, []);
  assert.deepEqual(listPlanOverrides(list, { ownListStreams: true }).streams, []);
  assert.deepEqual(listPlanOverrides({ id: 'plan:p1@1', kind: 'plan', resultKey: 'p1@1', input: {} }, { browserStreamsFor, ownListStreams: true }), {});
});

/* ================================================================== HRS-04 */

/** 假端点上的一个节点:回它发出去的消息与往里塞消息的口子 */
function nodeOn({ executor, canClaim, capabilities = { transcode: true, streams: true }, profile = 'host', planOnly = false }) {
  const sent = [];
  let handler = () => {};
  const endpoint = { send: (m) => { sent.push(m); }, onMessage: (h) => { handler = h; } };
  const node = createLocalNode({
    nodeId: 'n-host', node: { profile, envFingerprint: OWN, codeVersions: ['cv-1'], capabilities, ...(planOnly ? { planOnly: true } : {}) },
    endpoint, now: () => 1000, codeVersion: 'cv-1', projects: ['p1'], maxConcurrent: 1,
    executor, sink: { has: async () => false, put: async () => ({ complete: false }) },
    ...(canClaim ? { canClaim } : {}),
  });
  node.start();
  handler({ type: 'node.welcome', nodeId: 'n-host', epoch: 1 });
  return { node, sent, deliver: (m) => handler(m) };
}
async function publishedBy({ planTask, plan, planOnly = false }) {
  const { node, sent, deliver } = nodeOn({ executor: { plan: async () => plan, render: async () => null }, profile: 'pc', planOnly });
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
  assert.notEqual(own.priority, 'backfill', '清单计划照 normal 的名次(不是 backfill 档;具体名次由切分定)');
  const only = (await publishedBy({ planTask: list, plan: { ...base, ownListStreams: false } })).filter((t) => t.kind === 'stream');
  assert.deepEqual(only.map((t) => t.requires.envFingerprint), [BR]);
  assert.equal('dual' in only[0].input, false);
  // 只切分、不认领细任务的节点(仅供测试的 planOnly):它不会去做,所以不出自己的那一份
  const planOnly = (await publishedBy({ planTask: list, plan: { ...base, ownListStreams: true }, planOnly: true })).filter((t) => t.kind === 'stream');
  assert.deepEqual(planOnly.map((t) => t.requires.envFingerprint), [BR]);
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
test('HRS-06 执行器 plan:清单计划里切分方自己的那一份,托管方按项目收;本机不能产时不出;桌面照自己能不能产来', async () => {
  let on = false;
  const enabled = () => on;
  const list = clipsPlan({ projectId: 'p1', clips: ['a'] });
  const mk = (opts, streamsEnabled) => { const f = fakePipeline(opts); return createPrerenderExecutor({ pipeline: f.pipeline, projects: projectsOf(f.entry), ...(streamsEnabled === undefined ? {} : { streamsEnabled }) }); };
  assert.equal((await mk({ ownListStreams: true }, enabled).plan(list)).ownListStreams, false, '托管方、这一项关着:不出自己的那一份');
  on = true;
  assert.equal((await mk({ ownListStreams: true }, enabled).plan(list)).ownListStreams, true, '托管方、这一项开着:出');
  assert.equal((await mk({ ownListStreams: false }, enabled).plan(list)).ownListStreams, false, '本机不能产流(没有编码器、关着流开关):这一项开着也不出');
  assert.equal((await mk({ ownListStreams: true }, null).plan(list)).ownListStreams, true, '桌面:本机能产就出');
  assert.equal((await mk({ ownListStreams: true }).plan(list)).ownListStreams, true, '缺省不按项目管');
  assert.equal((await mk({ ownListStreams: false }, null).plan(list)).ownListStreams, false, '桌面:本机不能产就不出');
  assert.equal((await mk({ ownListStreams: true }, () => { throw new Error('x'); }).plan(list)).ownListStreams, false, '问的那一头出错按不产');
  // 同一个执行器、同一版(上下文有缓存):关掉之后再切,跟着变;缓存里的上下文没被改
  const f = fakePipeline({ ownListStreams: true });
  const exec = createPrerenderExecutor({ pipeline: f.pipeline, projects: projectsOf(f.entry), streamsEnabled: enabled });
  assert.equal((await exec.plan(list)).ownListStreams, true);
  on = false;
  assert.equal((await exec.plan(list)).ownListStreams, false);
  on = true;
  assert.equal((await exec.plan(list)).ownListStreams, true);
  // 这一版的 entry 上记着「这个项目此刻不产流」(本机写层表时不列自己这一版的流);桌面不按项目管,不写这个记号
  assert.equal(f.entry.ownStreamsOff, false);
  on = false;
  await exec.plan(list);
  assert.equal(f.entry.ownStreamsOff, true);
  const d = fakePipeline({ ownListStreams: true });
  await createPrerenderExecutor({ pipeline: d.pipeline, projects: projectsOf(d.entry), streamsEnabled: null }).plan(list);
  assert.equal('ownStreamsOff' in d.entry, false);
  // 这道闸接到 listPlanOverrides 上:关着 → 只给浏览器
  assert.ok(listPlanOverrides(list, await exec.plan(list)).streams.every((s) => s.browserOnly === true));
  on = true;
  assert.deepEqual(listPlanOverrides(list, await exec.plan(list)).streams.map((s) => 'browserOnly' in s), [false]);
  // 执行器不再有认领的钩子:认领闸在主机上(HRS-02),不留两条路
  assert.equal('accepts' in exec, false);
});

test('HRS-06 创建者刚打开的那一下:清单计划写着「页面看到这一项开着」而本机还没看到,等到本机也看到再切;等满了照本机手里的切;没写这一项不等', async () => {
  const marked = clipsPlan({ projectId: 'p1', clips: ['a'], input: { streams: true } });
  const plain = clipsPlan({ projectId: 'p1', clips: ['a'] });
  const run = async ({ planTask, turnsOnAfter = Infinity, settleMs = 1000 }) => {
    let on = false, sleeps = 0;
    const f = fakePipeline({ ownListStreams: true });
    const exec = createPrerenderExecutor({ pipeline: f.pipeline, projects: projectsOf(f.entry), streamsEnabled: () => on, streamsSettleMs: settleMs,
      sleep: async () => { sleeps += 1; if (sleeps >= turnsOnAfter) on = true; await turn(); } });
    const started = Date.now();
    const ctx = await exec.plan(planTask);
    return { own: ctx.ownListStreams, sleeps, ms: Date.now() - started, off: f.entry.ownStreamsOff };
  };
  // 页面先到、本机的清单晚几拍:等到了,出自己的那一份
  const late = await run({ planTask: marked, turnsOnAfter: 3 });
  assert.deepEqual([late.own, late.sleeps, late.off], [true, 3, false]);
  // 没写这一项(旧页面、这一项关着的项目):不等,照本机手里的
  const unmarked = await run({ planTask: plain, turnsOnAfter: 3 });
  assert.deepEqual([unmarked.own, unmarked.sleeps], [false, 0]);
  // 写了但本机一直看不到(页面自报的不作数:创建者其实没开,或刚又关了):等满就照关着切,不出自己的那一份
  const never = await run({ planTask: marked, settleMs: 30 });
  assert.equal(never.own, false);
  assert.ok(never.sleeps >= 1 && never.ms < 2000, '等了、但有上限');
  // 本机已经看到开着:不等
  let on = true, sleeps = 0;
  const f = fakePipeline({ ownListStreams: true });
  const exec = createPrerenderExecutor({ pipeline: f.pipeline, projects: projectsOf(f.entry), streamsEnabled: () => on, sleep: async () => { sleeps += 1; } });
  assert.equal((await exec.plan(marked)).ownListStreams, true);
  assert.equal(sleeps, 0);
  // 不按项目管的(桌面):这一项对它没有意义,不等
  const desk = fakePipeline({ ownListStreams: true });
  let deskSleeps = 0;
  await createPrerenderExecutor({ pipeline: desk.pipeline, projects: projectsOf(desk.entry), sleep: async () => { deskSleeps += 1; } }).plan(marked);
  assert.equal(deskSleeps, 0);
});

test('HRS-07 执行器把清单计划的流任务对回这一版:本机没判重的卡按任务的片段现算单卡流;结果键、分段范围照核;不是清单计划的照旧对不上', async () => {
  const entry = entryOf();
  const [single] = planListStreams(entry, ['a'], { envFingerprint: OWN, codeVersion: 'cv' });
  assert.equal(single.kind, 'card');
  const taskOf = (extra = {}) => ({
    id: `stream:${single.streamKey}:0-7`, kind: 'stream', resultKey: single.streamKey, range: { unit: 'segment', from: 0, to: 7 },
    source: { projectId: 'p1', projectRev: 1, derivedFrom: clipsPlan({ clips: ['a'] }).id },
    input: { clipId: 'a', cardId: null, entryKey: null, contentKey: single.contentKey }, requires: { envFingerprint: OWN }, ...extra,
  });
  // 本机这一版一条流都没有(渲染服务不判重):照任务的片段对上,交给生产者
  const f = fakePipeline({ entry, ownSpecs: [] });
  const exec = createPrerenderExecutor({ pipeline: f.pipeline, projects: projectsOf(entry) });
  await exec.render(taskOf(), { progress: () => {} });
  assert.deepEqual(f.produced, [{ streamKey: single.streamKey, kind: 'card', clipIds: ['a'], range: { from: 0, to: 7 } }]);
  assert.deepEqual(f.backfilled, ['a'], '这张卡记进预渲染集合(本机写的层表才列得出这条流)');
  // 本机这一版把 a、b 并成了组流(解码器预算 1):清单计划的单卡流照样对得上
  const grouped = planStreams(entry, { budget: 1, envFingerprint: OWN, codeVersion: 'cv' });
  assert.deepEqual(grouped.map((s) => s.kind), ['group']);
  const g = fakePipeline({ entry, ownSpecs: grouped });
  await createPrerenderExecutor({ pipeline: g.pipeline, projects: projectsOf(entry) }).render(taskOf(), { progress: () => {} });
  assert.equal(g.produced[0].streamKey, single.streamKey);
  // 本机这一版里本来就有这条流:照旧直接对上
  const h = fakePipeline({ entry, ownSpecs: [single] });
  await createPrerenderExecutor({ pipeline: h.pipeline, projects: projectsOf(entry) }).render(taskOf(), { progress: () => {} });
  assert.equal(h.produced.length, 1);

  const rejects = async (task, pattern, fake = fakePipeline({ entry, ownSpecs: [] })) => {
    await assert.rejects(() => createPrerenderExecutor({ pipeline: fake.pipeline, projects: projectsOf(entry) }).render(task, { progress: () => {} }),
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
  await rejects(taskOf({ range: { unit: 'segment', from: 0, to: 99 } }), /分段范围/);
  // 本机不能产流:不可重试的 no-streams(照旧)
  const no = fakePipeline({ entry, capable: false });
  await assert.rejects(() => createPrerenderExecutor({ pipeline: no.pipeline, projects: projectsOf(entry) }).render(taskOf(), { progress: () => {} }), (e) => e.code === 'no-streams');
});

/* ================================================================== HRS-08 */

test('HRS-08 管理进程的配置:PROMPTCUT_RENDER_STREAMS=1 才以能产流的方式起工作进程;不设、别的值都是不能产', () => {
  assert.equal(renderServiceConfig({}).streams, false);
  assert.equal(renderServiceConfig({ PROMPTCUT_RENDER_STREAMS: '1' }).streams, true);
  assert.equal(renderServiceConfig({ PROMPTCUT_RENDER_STREAMS: '0' }).streams, false);
  assert.equal(renderServiceConfig({ PROMPTCUT_RENDER_STREAMS: 'true' }).streams, false);
});
