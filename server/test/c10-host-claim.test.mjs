/** A5 failure diagnosis: actual queue views, static eligibility, hidden tick errors and secret exclusion.
 * These checks do not prove a lane is free or replace the real full C10 host completion assertion.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { clipsPlanTaskOf } from '../render-queue/messages.mjs';
import { createRenderQueue } from '../render-queue/index.mjs';
import { createRenderHost } from '../render-node/host.mjs';
import { createLoopback } from './fake-loopback-transport.mjs';
import { splitPlan } from '../render-node/split.mjs';
import { cardSnapshotIdentity } from '../card-identity.mjs';

// Exercise the script in its own Node process; server modules do not import scripts.
const entry = new URL('../../scripts/render-host.mjs', import.meta.url).href;
const judgeEntry = new URL('../../scripts/probes/c10-judge.mjs', import.meta.url).href;
function traceOf(frames, view, fixture = null) {
  const code = `import { createC10Trace, hostDidWork, hostRenderedClip } from ${JSON.stringify(judgeEntry)};
    let input=''; for await(const part of process.stdin) input+=part;
    const {frames,view,fixture}=JSON.parse(input), trace=createC10Trace();
    for(const f of frames) f.boundary ? trace.boundary(f.channel,f.boundary) : trace.observe(f.message,{channel:f.channel,at:0});
    console.log(JSON.stringify({worked:hostDidWork(view),...trace.snapshot(),fixture:fixture?hostRenderedClip(trace.snapshot(),fixture.events,fixture):null}));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    input: JSON.stringify({ frames, view, fixture }), encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  assert.equal(child.status, 0, '独立诊断子进程实际退出');
  return JSON.parse(child.stdout);
}
function hostClaimStatusOf(queue, events = [], tasks = null) {
  const code = `import { hostClaimStatusOf } from ${JSON.stringify(entry)};
    let input = ''; for await (const part of process.stdin) input += part;
    console.log(JSON.stringify(hostClaimStatusOf(...JSON.parse(input))));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    input: JSON.stringify([queue, events, tasks]), encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  assert.equal(child.status, 0, '诊断脚本子进程应成功退出');
  return JSON.parse(child.stdout);
}

const queueView = () => ({ profile: 'host', codeVersion: 'v1', envFingerprint: '0c10b0e5f1a9e7d2', maxConcurrent: 1,
  capabilities: { userCards: true, graphCards: false, streams: false, transcode: false },
  nodes: [{ projectId: 'sp_a', nodeId: 'host-a', connected: true, seen: 1, watching: ['sp_a'], held: [], running: [] }] });
const plan = (version = 'v1') => ({ ...clipsPlanTaskOf({ projectId: 'sp_a', projectRev: 2, clips: ['clip-a'], codeVersion: version }), state: 'open' });

test('A5 diagnosis distinguishes unseen observer data, eligible list plan and code-version filtering without weakening the filter', () => {
  const q = queueView();
  assert.equal(hostClaimStatusOf(q).nodes[0].eligible, null);
  const eligible = hostClaimStatusOf(q, [], [plan()]);
  assert.equal(eligible.nodes[0].eligible, 1, '禁流主机能接清单 plan');
  assert.deepEqual(eligible.nodes[0].filters, {});
  const blocked = hostClaimStatusOf(q, [], [plan('v2')]);
  assert.equal(blocked.nodes[0].eligible, 0);
  assert.deepEqual(blocked.nodes[0].filters, { 'code-version': 1 });
  assert.equal(blocked.nodes[0].seen, 1, 'seen 不等于可认领');
  assert.equal(eligible.eligibility, 'observer-static-filter-only', '静态过滤不能冒称 lane/时序闸已通过');
});

test('A5 diagnosis omits credentials/payload/error text and reports unknown card identities instead of fabricating a failure', () => {
  const q = queueView();
  const secret = 'fixture-value-never-log';
  q.password = secret; q.nodes[0].session = { token: secret }; q.capabilities.accessToken = secret;
  const fine = { ...plan(), kind: 'snapshot', requires: { cardSources: { card: 'r1' } }, input: { token: secret } };
  const before = structuredClone(q);
  const status = hostClaimStatusOf(q, [{ event: 'queue.tick-error', message: `${secret} is not a function` },
    { event: 'queue.tick-error', message: `${secret} is not a function` }], [fine]);
  assert.equal(status.nodes[0].unknownCardSources, 1);
  assert.equal(status.nodes[0].eligible, 0);
  assert.equal(status.tickErrors.length, 1);
  assert.equal(status.tickErrors[0].category, 'not-a-function');
  assert.match(status.tickErrors[0].hash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(status).includes(secret), false);
  assert.deepEqual(q, before);
  assert.deepEqual(hostClaimStatusOf(null).nodes, []);
});

test('A5 queue/provider control: a host with idle serial lane claims and splits the real list plan despite streams=false', async () => {
  const lb = createLoopback();
  const q = createRenderQueue({ now: () => 1000, send: lb.queueSend, epoch: 'c10-diag' });
  lb.attach(q);
  const pub = lb.connect('page', { userId: 'member', tenantId: 'sp_a' });
  pub.send({ type: 'publisher.hello', publisherId: 'page' });
  pub.send({ type: 'task.publish', tasks: [plan()] });
  const view = queueView();
  const host = createRenderHost({ entries: [{ projectId: 'sp_a' }], codeVersion: view.codeVersion, envFingerprint: view.envFingerprint,
    capabilities: view.capabilities, now: () => 1000,
    connect: () => ({ endpoint: lb.connect('host', { userId: 'member', tenantId: 'sp_a' }),
      executor: { laneOf: t => ['plan', 'snapshot'].includes(t.kind) ? 'queue' : null, laneBusy: () => 0,
        async plan() { return { entryKey: 'entry', cardPlan: [] }; }, async render() { assert.fail('空计划不应制造细任务'); } },
      sink: { async has() { return false; }, async put() { assert.fail('空计划不应推产物'); } } }) });
  try {
    host.start(); lb.flush(); host.tick(); lb.flush();
    await new Promise(resolve => setImmediate(resolve)); lb.flush();
    assert.equal(host.nodes()[0].claimed, 1);
    assert.equal(host.nodes()[0].plans, 1);
    assert.deepEqual(lb.errors(), []);
    assert.deepEqual(lb.nonJson(), []);
    assert.ok(lb.log().some(e => e.connId === 'host' && e.dir === 'in' && e.message.type === 'task.claim'));
  } finally { host.shutdown(); lb.flush(); await host.settled(); }
});

test('A5 real queue counterexample: browser wins every dual fine task while host splits successfully and completion stays false', async t => {
  const lb = createLoopback(), q = createRenderQueue({ now: () => 1000, send: lb.queueSend, epoch: 'c10-dual' }); lb.attach(q);
  const frames = [], principal = { userId: 'member', tenantId: 'sp_a' }, browserFp = 'bbbbbbbbbbbbbbbb';
  const connect = (id, channel) => { const ep = lb.connect(id, principal); ep.onMessage(message => frames.push({ channel, message })); return ep; };
  const publisher = connect('publisher', 'publisher'); publisher.send({ type: 'publisher.hello', publisherId: 'page' });
  const observer = connect('observer', 'observer');
  observer.send({ type: 'node.hello', nodeId: 'observer', profile: 'pc', codeVersions: [], capabilities: {}, maxConcurrent: 1 });
  observer.send({ type: 'queue.watch', projects: ['sp_a'] });
  const browser = connect('browser', 'browser');
  browser.send({ type: 'node.hello', nodeId: 'browser', profile: 'browser', envFingerprint: browserFp, codeVersions: ['v1'], capabilities: {}, maxConcurrent: 8 });
  browser.send({ type: 'queue.watch', projects: ['sp_a'] });
  browser.onMessage(message => {
    if (message.type === 'task.opened' && message.task?.kind === 'snapshot') browser.send({ type: 'task.claim', id: message.task.id, expectVersion: message.task.version });
    if (message.type === 'task.claimed' && message.task?.kind === 'snapshot') browser.send({ type: 'task.complete', id: message.id, token: message.token, result: { ranges: [message.task.range] } });
  });
  publisher.send({ type: 'task.publish', tasks: [plan()] }); lb.flush();
  const view = queueView(); let renders = 0;
  const host = createRenderHost({ entries: [{ projectId: 'sp_a' }], codeVersion: 'v1', envFingerprint: view.envFingerprint,
    capabilities: view.capabilities, now: () => 1000,
    connect: () => ({ endpoint: connect('host', 'host'), executor: {
      laneOf: task => ['plan', 'snapshot'].includes(task.kind) ? 'queue' : null, laneBusy: () => 0,
      async plan() { return { entryKey: 'entry', cardPlan: [{ clipId: 'clip-a', cardId: 'chapter-bar', snapshotKey: 'content-a', contentKey: 'content-a',
        tier: 'shared', compositing: 'independent', capabilities: { compositing: 'independent', frameMode: 'stateful' },
        start: 0, end: 4, count: 120, sampling: { firstFrame: 0, fps: { numerator: 30, denominator: 1 }, phase: { numerator: 0, denominator: 1 } } }],
        weightOf: () => ({ class: 'medium', estMs: null }) }; },
      async render() { renders++; assert.fail('浏览器已先获得两段，主机不应再执行'); },
    }, sink: { async has() { return false; }, async put() { assert.fail('主机无细任务不能写产物'); } } }) });
  try {
    host.start(); lb.flush(); host.tick(); lb.flush();
    for (let i = 0; i < 12 && host.nodes()[0].plans !== 1; i++) { await new Promise(resolve => setImmediate(resolve)); lb.flush(); }
    host.tick(); lb.flush(); await new Promise(resolve => setImmediate(resolve)); lb.flush();
    const node = host.nodes()[0];
    t.diagnostic(JSON.stringify({ trace: frames.filter(f => ['error', 'task.claim-rejected', 'task.claimed'].includes(f.message.type)).map(f => ({
      channel: f.channel, type: f.message.type, reason: f.message.reason, kind: f.message.task?.kind,
      fingerprint: f.message.task?.requires?.envFingerprint, browserFingerprints: f.message.browserFingerprints })) }));
    assert.equal(node.claimed, 1); assert.equal(node.plans, 1); assert.equal(node.completed, 0); assert.equal(node.dedup, 0);
    assert.deepEqual(node.held, []); assert.deepEqual(host.running(), []); assert.equal(renders, 0);
    const fineDone = frames.filter(f => f.channel === 'publisher' && f.message.type === 'task.done' && f.message.id.startsWith('snapshot:'));
    const superseded = frames.filter(f => f.channel === 'publisher' && f.message.type === 'task.failed' && f.message.error === 'superseded');
    assert.equal(fineDone.length, 2); assert.equal(superseded.length, 2);
    const evidence = traceOf(frames, { nodes: [node] }); assert.equal(evidence.worked, false, '保留旧完成标准，此合法队列结果不能宣称主机实际渲染');
    assert.equal(evidence.events.filter(e => e.type === 'task.done' && e.derived?.length === 4).length, 1, 'plan 完成 ACK 带原四个派生 ID');
    assert.equal(evidence.events.filter(e => e.channel === 'host' && e.type === 'task.published' && e.results.length === 4).length, 1);
    assert.equal(evidence.records.filter(r => r.channel === 'observer' && r.kind === 'snapshot' && r.winner?.fingerprint === browserFp).length, 2);
    assert.ok(evidence.records.filter(r => r.channel === 'observer' && r.requires.envFingerprint === view.envFingerprint).every(r => r.closed?.state === 'failed'));
    t.diagnostic(JSON.stringify({ counterexample: 'browser-wins-all', host: { claimed: node.claimed, plans: node.plans, completed: node.completed },
      browserDone: fineDone.length, hostSuperseded: superseded.length, originalCompletion: evidence.worked, productionRenderer: false }));
    assert.deepEqual(lb.errors(), []); assert.deepEqual(lb.nonJson(), []);
  } finally { host.shutdown(); lb.flush(); await host.settled(); publisher.close(); observer.close(); browser.close(); }
});

test('A5 evidence keeps same-ID generations and connection gaps distinct; unversioned failure cannot label a later close', () => {
  const task = { ...plan(), version: 1 };
  const evidence = traceOf([
    { channel: 'observer', message: { type: 'task.opened', task } },
    { channel: 'publisher', message: { type: 'task.failed', id: task.id, error: 'superseded' } },
    { channel: 'observer', message: { type: 'task.closed', id: task.id, state: 'failed' } },
    { channel: 'observer', message: { type: 'task.opened', task } },
    { channel: 'observer', message: { type: 'task.closed', id: task.id, state: 'failed' } },
    { channel: 'observer', boundary: 'new-session' },
    { channel: 'observer', message: { type: 'queue.snapshot', tasks: [task] } },
  ], queueView());
  assert.deepEqual(evidence.records.map(r => r.generation), [1, 2, 3]);
  assert.equal(evidence.records[0].closed.reason, 'unknown'); assert.equal(evidence.records[1].closed.reason, 'unknown');
  assert.equal(evidence.records[1].continuous, false); assert.equal(evidence.records[2].completeFromOpen, false);
  assert.equal(evidence.events.find(e => e.reason === 'superseded').association, 'unversioned-not-correlated');
});

test('A5 task evidence excludes arbitrary payload, credentials and error text without changing host completion', () => {
  const secret = 'fixture-value-excluded';
  const task = { ...plan(), version: 1, input: { password: secret, dual: true }, requires: { token: secret, cardSources: { private: secret } } };
  const evidence = traceOf([{ channel: 'observer', message: { type: 'task.opened', task, token: secret } },
    { channel: 'publisher', message: { type: 'task.failed', id: task.id, error: secret } },
    { channel: 'publisher', message: { type: 'task.done', id: task.id, result: { secret } } }], { nodes: [{ claimed: 2, completed: 1 }] });
  assert.equal(JSON.stringify(evidence).includes(secret), false); assert.equal(evidence.worked, true);
  assert.equal(evidence.records[0].requires.cardSourceCount, 1); assert.equal(evidence.records[0].dual, true);
});

test('A5 evidence requires a complete open/version chain for winner evidence and separates a restarted queue', () => {
  const task = { ...plan(), version: 1 };
  const evidence = traceOf([
    { channel: 'observer', message: { type: 'queue.snapshot', epoch: 'first', tasks: [task] } },
    { channel: 'observer', message: { type: 'task.taken', epoch: 'first', id: task.id, version: 7 } },
    { channel: 'observer', message: { type: 'queue.snapshot', epoch: 'restart', tasks: [task] } },
  ], queueView());
  assert.equal(evidence.records.length, 2); assert.ok(evidence.records.every(r => r.winner === null && r.completeFromOpen === false));
  assert.equal(evidence.records[0].continuous, false);
  assert.equal(evidence.events.filter(e => e.type === 'boundary' && e.reason === 'queue-epoch').length, 1);
});

test('A5 already-selected canvas control tests splitting only, not measured inclusion; exact completion excludes dedup and other clips', () => {
  const capabilities = JSON.parse(fs.readFileSync(new URL('../../src/cards/capabilities.json', import.meta.url), 'utf8'))['r6-canvas'];
  assert.equal(capabilities.canvasHeavy, true); assert.equal(capabilities.compositing, 'independent');
  const node = { cardId: 'r6-canvas', params: {} }, identity = duration => cardSnapshotIdentity(node, { duration, fps: { numerator: 30, denominator: 1 } });
  assert.notEqual(identity(1.01), identity(1.02), '真实片段时长改变共享内容身份，不靠伪参数或clip ID');
  const control = { clipId: 'new-canvas', cardId: 'r6-canvas', contentKey: identity(1.01), snapshotKey: identity(1.01),
    tier: 'shared', compositing: capabilities.compositing, capabilities, start: 11, end: 12.01, count: 31 };
  const tasks = splitPlan({ planTask: plan(), entryKey: 'entry', cardPlan: [control], browserFingerprints: ['bbbbbbbbbbbbbbbb'],
    envFingerprint: queueView().envFingerprint, codeVersion: 'v1', weightOf: c => ({ class: c.capabilities.canvasHeavy ? 'heavy' : 'medium', estMs: null }) });
  assert.equal(tasks.length, 1); assert.equal(tasks[0].input.dual, undefined); assert.equal(tasks[0].requires.envFingerprint, queueView().envFingerprint);
  const task = { ...tasks[0], state: 'open', version: 1 }, frames = [
    { channel: 'observer', message: { type: 'task.opened', task } },
    { channel: 'observer', message: { type: 'task.taken', id: task.id, version: 2 } },
    { channel: 'observer', message: { type: 'task.closed', id: task.id, state: 'done' } },
  ];
  const fixture = { clipId: control.clipId, fingerprint: queueView().envFingerprint, events: [{ event: 'node.completed', id: task.id }],
    layer: { clipId: control.clipId, envFingerprint: queueView().envFingerprint, resultKey: task.resultKey, ready: 31 } };
  assert.equal(traceOf(frames, queueView(), fixture).fixture.ready, true);
  for (const change of [ { clipId: 'different' }, { fingerprint: 'bbbbbbbbbbbbbbbb' },
    { events: [{ event: 'node.dedup', id: task.id }] }, { events: [{ event: 'node.completed', id: 'different' }] },
    { events: [...fixture.events, { event: 'node.dedup', id: task.id }] } ]) {
    assert.equal(traceOf(frames, queueView(), { ...fixture, ...change }).fixture.rendered, false);
  }
  assert.equal(traceOf(frames, queueView(), { ...fixture, layer: { ...fixture.layer, resultKey: 'old' } }).fixture.ready, false);
});

function readinessOf(input) {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import { hostFixtureReadiness } from ${JSON.stringify(judgeEntry)};
    let input=''; for await (const part of process.stdin) input+=part;
    console.log(JSON.stringify(hostFixtureReadiness(JSON.parse(input))));`], {
    input: JSON.stringify(input), encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  assert.equal(child.status, 0); return JSON.parse(child.stdout);
}

test('A5 host prerequisite rejects actual light-cost shape, unsettled/missing costs and stale or omitted target plans', () => {
  // Controlled observations exercise the gate; these numbers do not claim that
  // the browser actually measured particles. The wide probe must supply that.
  const input = {
    fixture: { clipId: 'new-particles', cardId: 'particles', projectId: 'sp_a', createdAt: 10 }, fps: 30,
    job: { clipId: 'new-particles', cardId: 'particles', identityKey: 'measured-id', at: 11 }, probe: { running: false },
    record: { identityKey: 'measured-id', fps: 30, stepMs: 40, inlineMs: 1, rasterMs: 1, serializeMs: 1,
      catchUpMs: 120, kind: 'stepped', mode: 'build', device: 'test-device', measuredAt: 12 }, pipeline: 'heavy',
    publisher: { measured: true, want: { projectId: 'sp_a', projectRev: 4 }, last: 'plan:sp_a@4#clips:target', lastClips: ['new-particles'],
      log: [{ ok: true, id: 'plan:sp_a@4#clips:target', state: 'open' }] },
  };
  assert.equal(readinessOf(input).ready, true);
  const light = readinessOf({ ...input, record: { ...input.record, stepMs: 0.2, catchUpMs: 0.2 } });
  assert.equal(light.ready, false); assert.equal(light.terminal, true); assert.ok(light.reasons.includes('measured-light'));
  for (const change of [
    { record: null }, { probe: { running: true } }, { record: { ...input.record, stepMs: undefined } },
    { record: { ...input.record, mode: 'dev' } }, { record: { ...input.record, identityKey: 'old-id' } },
    { record: { ...input.record, measuredAt: 9 } }, { job: { ...input.job, at: 9 } },
    { pipeline: 'light' }, { publisher: { ...input.publisher, lastClips: ['main'] } },
    { publisher: { ...input.publisher, want: { projectId: 'sp_a', projectRev: 5 } } },
    { publisher: { ...input.publisher, last: 'plan:sp_a@3#clips:old' } },
    { fixture: { ...input.fixture, projectId: 'sp_other' } },
  ]) assert.equal(readinessOf({ ...input, ...change }).ready, false, JSON.stringify(change));
  assert.equal(readinessOf({ ...input, record: null }).terminal, false, '声明重兜底不能冒充实测重');
  const cpu = { ...input, fixture: { ...input.fixture, requireStepOverBudget: true } };
  assert.equal(readinessOf(cpu).ready, true);
  for (const flags of [{ pinnedHeavy: true }, { capped: true }, { demoted: true }, { catchUpMs: 10000 }]) {
    const pinnedOnly = readinessOf({ ...cpu, record: { ...cpu.record, stepMs: 0.2, ...flags } });
    assert.equal(pinnedOnly.ready, false); assert.equal(pinnedOnly.terminal, true);
    assert.ok(pinnedOnly.reasons.includes('measured-step-not-over-budget'));
  }
});

test('A5 ordinary user CPU field parses, bundles, computes its pixels and keeps real unknown/local eligibility', t => {
  const root = new URL('../../', import.meta.url);
  const code = `import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    import { heavyUserCardSource } from ${JSON.stringify(judgeEntry)};
    import { parseCardSource } from ${JSON.stringify(new URL('src/kernel/cardSourceParse.mjs', root).href)};
    import { cardCapabilities } from ${JSON.stringify(new URL('src/kernel/frameMode.mjs', root).href)};
    import { snapshotTier } from ${JSON.stringify(new URL('server/snapshot-tier.mjs', root).href)};
    import { bundleCard } from ${JSON.stringify(new URL('src/online/cardRuntime/transpile.ts', root).href)};
    const require = createRequire(${JSON.stringify(new URL('package.json', root).href)});
    const React=require('react'), {renderToStaticMarkup}=require('react-dom/server');
    const id='c10-cpu-field-test', key='src/cards/user/'+id+'.tsx', source=heavyUserCardSource(id);
    assert.equal(/__pc|Date\\.|performance|isExportMode|canvasHeavy|compositing|fetch\\(/.test(source), false);
    const parsed=parseCardSource(source,{key}); assert.equal(parsed.length,1); assert.equal(parsed[0].id,id);
    const result=await bundleCard({runtime:'test',entry:key,read:k=>k===key?{body:source,hash:'fixture-source'}:null,hasBuiltin:()=>false});
    assert.equal(result.ok,true,JSON.stringify(result)); assert.equal(result.bundle.modules.length,1);
    const mod={exports:{}}; new Function('require','module','exports',result.bundle.modules[0].js)(require,mod,mod.exports);
    const def=mod.exports.cpuField, caps=cardCapabilities(def), tier=snapshotTier(caps);
    assert.equal(caps.frameMode,'stateful'); assert.equal(caps.compositing,'unknown'); assert.equal(caps.canvasHeavy,false); assert.equal(tier,'local');
    const render=(seed,t)=>renderToStaticMarkup(React.createElement(def.Component,{params:{seed},t}));
    const start=performance.now(), first=render(1,0), same=render(1,0), changed=render(17,0.125);
    assert.equal(first,same); assert.notEqual(first,changed); assert.equal((first.match(/background:hsl/g)||[]).length,128);
    console.log(JSON.stringify({cardId:id,caps,tier,sourceChars:source.length,cpuDiagnosticMs:performance.now()-start,browserMeasurement:false}));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(child.status, 0, child.stderr);
  const actual = JSON.parse(child.stdout); t.diagnostic(JSON.stringify(actual));
  const control = { clipId: 'actual-user', cardId: actual.cardId, snapshotKey: 'content', tier: actual.tier,
    compositing: actual.caps.compositing, capabilities: actual.caps, start: 11, end: 11.26, count: 8 };
  // Selection is not forged here: this is explicitly the post-selection split.
  // The actual browser prerequisite must establish selected/heavy before host.
  const tasks = splitPlan({ planTask: plan(), entryKey: 'project-entry', cardPlan: [control],
    envFingerprint: queueView().envFingerprint, codeVersion: 'v1', browserFingerprints: ['bbbbbbbbbbbbbbbb'],
    isUserCard: () => true, cardSourceVersions: { [actual.cardId]: 'user:fixture-source' } });
  assert.equal(tasks.length, 1); assert.equal(tasks[0].tier, 'local');
  assert.equal(tasks[0].input.dual, undefined); assert.equal(tasks[0].requires.userCards, true);
  assert.equal(tasks[0].requires.envFingerprint, queueView().envFingerprint);
  assert.equal(tasks[0].weight.class, 'heavy');
});

test('A5 particles candidate uses real independent canvas capability and content identity; heaviness remains subject to measurement', () => {
  const capabilities = JSON.parse(fs.readFileSync(new URL('../../src/cards/capabilities.json', import.meta.url), 'utf8')).particles;
  assert.equal(capabilities.canvasHeavy, true); assert.equal(capabilities.compositing, 'independent');
  const node = { cardId: 'particles', params: { config: '', quantity: 400, links: 'yes', seed: 123, speed: 1.2, size: 3 } };
  const options = { duration: 3.01, fps: { numerator: 30, denominator: 1 } };
  assert.notEqual(cardSnapshotIdentity(node, options), cardSnapshotIdentity(node, { ...options, duration: 3.02 }));
  assert.notEqual(cardSnapshotIdentity(node, options), cardSnapshotIdentity({ ...node, params: { ...node.params, seed: 124 } }, options));
});

test('A5 synced metadata uses real project-edit action without registering an editor component', () => {
  const root = new URL('../../', import.meta.url).href;
  const code = `import assert from 'node:assert/strict';
    await import(${JSON.stringify(root + 'src/testing/registerTs.mjs')});
    const { OnlineCardSources } = await import(${JSON.stringify(root + 'src/editor/sync/onlineCardSources.ts')});
    const { bundleCard } = await import(${JSON.stringify(root + 'src/online/cardRuntime/transpile.ts')});
    const registry = await import(${JSON.stringify(root + 'src/kernel/registry.ts')});
    const { clips } = await import(${JSON.stringify(root + 'src/store/actions/clips.ts')});
    const { projectMeta } = await import(${JSON.stringify(root + 'src/store/actions/projectMeta.ts')});
    const core = await import(${JSON.stringify(root + 'src/store/core.ts')});
    const { heavyUserCardSource, editHeavyFixtureClip } = await import(${JSON.stringify(judgeEntry)});
    const cardId='c10-cpu-field-store-test', key='src/cards/user/'+cardId+'.tsx', source=heavyUserCardSource(cardId), link={};
    let bundles=[];
    const sync=new OnlineCardSources({linkKey:()=>link, request:async m=>m.type==='content.list'
      ? {type:'content.listing',items:[{key,hash:'source-hash',rev:1}]}
      : {type:'content.item',key,hash:'source-hash',rev:1,body:source},
      bundling:{enabled:()=>true,run:({entries,read})=>Promise.all(entries.map(entry=>bundleCard({runtime:'test',entry,read,hasBuiltin:()=>false}))),onBundles:b=>{bundles=b;}}});
    try {
      await sync.sync(); assert.equal(bundles[0].ok,true); assert.ok(registry.syncedCardView(cardId));
      assert.equal(registry.getCard(cardId),undefined);
      assert.equal(clips.addClipOnNewTrack({cardId,start:11,duration:.26}),null);
      assert.equal(clips.addCardClip(cardId,11,{duration:.26}),null);
      const store={getState:core.getState,actions:{...clips,...projectMeta}};
      const before=core.getState().project, beforeText=JSON.stringify(before), originalTracks=before.tracks;
      const spec={cardId,sourceKey:key,clipId:'c-a5-pure',trackId:'t-a5-pure',start:11,duration:.26,params:{},createdAt:10};
      const result=editHeavyFixtureClip(spec,store,sync.debug());
      const after=core.getState().project;
      assert.equal(JSON.stringify(before),beforeText); assert.notEqual(after,before);
      assert.equal(after.tracks.length,originalTracks.length+1);
      assert.ok(originalTracks.every((track,i)=>after.tracks[i+1]===track));
      assert.equal(result.cardId,cardId); assert.equal(result.params.seed,1);
      assert.ok(Math.abs(result.duration-.26)<1e-9); assert.equal(after.duration>=result.end,true);
      assert.equal(registry.getCard(cardId),undefined,'不能借假Component注册绕编辑页隔离');
      assert.throws(()=>editHeavyFixtureClip(spec,store,sync.debug()),/fixture-id-conflict/);
      assert.throws(()=>editHeavyFixtureClip({...spec,clipId:'other',sourceKey:'different'},store,sync.debug()),/fixture-source-metadata-missing/);
      console.log(JSON.stringify({originalActionNull:true,normalProjectEdit:true,editorComponentRegistered:false,immutable:true,actualDocCommit:false}));
    } finally { sync.stop(); }`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).normalProjectEdit, true);
});

test('A5 project readback requires actual matching revision/digest and complete chunks', () => {
  const code = `import assert from 'node:assert/strict'; import {createHash} from 'node:crypto';
    import {readFixtureProject} from ${JSON.stringify(judgeEntry)};
    const project={id:'doc',tracks:[]}, text=JSON.stringify(project), digest=createHash('sha256').update(text).digest('hex');
    const head={type:'project.state',projectId:'doc',rev:3,digest,reqId:'read'};
    async function read(frames){let handler,off=0;const ep={onMessage:h=>{handler=h;return()=>off++;},send:m=>{
      assert.deepEqual(m,{type:'project.open',projectId:'doc',reqId:'read'});
      queueMicrotask(()=>frames.forEach(f=>handler(f)));return true;}};
      try{return await readFixtureProject(ep,'doc','read',1000);}finally{assert.equal(off,1);}}
    assert.deepEqual(await read([{...head,project}]),{project,rev:3,digest});
    const frames=[{...head,parts:2},{type:'project.state.part',projectId:'doc',rev:3,count:2,index:0,data:text.slice(0,8),reqId:'read'},
      {type:'project.state.part',projectId:'doc',rev:3,count:2,index:1,data:text.slice(8),reqId:'read'},
      {type:'project.state.end',projectId:'doc',rev:3,digest,reqId:'read'}];
    assert.deepEqual(await read(frames),{project,rev:3,digest});
    await assert.rejects(read([{...head,project,digest:'0'.repeat(64)}]),/digest-mismatch/);
    await assert.rejects(read([frames[0],frames[1],frames[3]]),/parts-missing/);
    await assert.rejects(read([frames[0],{...frames[1],rev:2},frames[2],frames[3]]),/parts-invalid/);
    console.log(JSON.stringify({inline:true,chunked:true,badDigestRejected:true,missingPartRejected:true,mixedRevisionRejected:true}));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(child.status, 0, child.stderr);
});
