/**
 * 云端 Agent 的补渲在「项目一直往前走」时不以失败收场(契约 `docs/plan/cloud-agent-contract.md` 第 16.4 节、
 * `docs/plan/render-queue-contract.md` J.15;用例 CA-RR-01～CA-RR-07)。
 * 跑:npm test -- server/test/cloud-agent-rerender.test.mjs(不起浏览器、不开端口)
 *
 * 2026-10-06 的缺陷:云端 Agent 的写入之间隔得比补渲的防抖长时,Agent 服务每写一次就发一个指着当时版本的清单计划;项目接着往前走,
 * 有真身的项目文档服务只给得出当前版本,渲染节点取不到旧版本的项目快照,计划与细任务以「文档服务上没有项目快照」失败。
 *
 *   CA-RR-01  间隔长的多次写入:每次写入各发一个计划,其间项目继续往前走(计划被认领时已经不是它指的那一版、细任务排到时内容已换)。
 *             没有任务以失败收场,最后一版全部渲完,层表是最后一版的,渲染节点没有为已被取代的内容开工。
 *   CA-RR-02  旧计划被取代:还没被认领的旧计划被撤掉(不是失败);已经切出、还没开工的旧细任务内容没变的照做(并进新计划)、
 *             内容换了的作废;对话记录里只有「已发布 / 进度 / 完成」。
 *   CA-RR-03  发布方断线重连重发:断开期间细任务做完、超过队列的宽限期、项目又往前走了;重发旧计划后经核对的那一次切分对上,
 *             没有失败,最后一版渲完。
 *   CA-RR-04  渲染节点中途重启:手里的一段被队列收回,新进程(执行器与管线的记忆都是空的)接着做;旧版本取不到就按当前版本核对,
 *             内容没变的照做(清单计划切出的细任务按任务记进预渲染集合),内容换了的作废。没有失败。
 *   CA-RR-05  执行器:取不到旧版本时按文档服务回的当前版本算;计划带回实际切的版本;细任务内容没变照做、换了抛 superseded;
 *             文档服务没说当前版本时照旧是 no-snapshot;不是清单计划的任务有缓存的旧版本照旧按旧版本做。
 *   CA-RR-06  文档服务与项目客户端:有真身的项目取旧版本回 missing 加 currentRev;取当前版本照给;没有真身的项目不带 currentRev。
 *   CA-RR-07  发布通道:细任务作废不算失败(计划照常收尾,带作废数);计划有了结局就退订它的细任务(别的计划还要的不退),
 *             账上它们的失败与作废一并清掉;以最新一次切分给的清单为准。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { createRenderQueue } from '../render-queue/index.mjs';
import { clipsPlanTaskOf } from '../render-queue/messages.mjs';
import { createRenderHost } from '../render-node/host.mjs';
import { resultKeyOf } from '../render-node/fingerprint.mjs';
import { splitPlan } from '../render-node/split.mjs';
import { createProjectClient } from '../render-node/project-client.mjs';
import { createPrerenderExecutor, SUPERSEDED } from '../prerender-executor.mjs';
import { createRenderRequests } from '../agent/service/render-request.mjs';
import { createQueuePublisher } from '../agent-service/render-publisher.mjs';
import { createLoopback } from './fake-loopback-transport.mjs';
import { createTimerClock } from './fake-render-executor.mjs';
import { loadStore, loadProject, startStandalone, ask } from './fake-docservice-env.mjs';
import { connectEndpoint } from './fake-manifest-env.mjs';

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const PID = 'sp_rr';
const FP = 'aaaabbbbccccdddd';
const CV = 'code-rr';
const FPS = 30;
const AGENT = { userId: 'service:agent@agent-instance-0001', tenantId: PID };
const RENDER = { userId: 'service:render@render-instance-001', tenantId: PID };
const NODE_ID = 'hosted-render:test/sp_rr';
const realTick = (ms = 2) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

/* ------------------------------------------------------------------ 项目与内容键 */

const clipOf = (id, text, seconds = 1) => ({ id, kind: 'card', cardId: `card-${id}`, start: 0, end: seconds, params: { text } });
const projectOf = (clips) => ({ id: 'doc-rr', fps: FPS, width: 1280, height: 720, duration: 2, tracks: clips.map((c, i) => ({ id: `tr-${i}`, clips: [c] })) });
const clipsOf = (project) => project.tracks.flatMap((t) => t.clips);
/** 一个片段的内容键:只看它自己的输入(卡、参数、时长),与项目版本无关 */
const contentKeyOf = (clip) => sha256(JSON.stringify([clip.cardId, clip.params, clip.end - clip.start]));
const framesOf = (clip) => Math.round((clip.end - clip.start) * FPS);
const taskIdsFor = (clip) => {
  const resultKey = resultKeyOf(contentKeyOf(clip), FP);
  const out = [];
  for (let from = 0; from < framesOf(clip); from += 60) out.push(`snapshot:${resultKey}:${from}-${Math.min(framesOf(clip), from + 60) - 1}`);
  return out;
};

/* ------------------------------------------------------------------ 管线替身(执行器是真的) */

/**
 * `FramePipeline` 里执行器用到的那几样。预渲染集合起初是空的:只有记成补渲的片段才渲得出东西(与真管线对「本机判轻的片段」的处理相同:
 * 不在集合里的不产帧,产物库就收不全)。
 */
function fakePipeline(world) {
  const picked = new Set();
  const identity = (control) => `${control.clipId}|${control.contentKey}`;
  return {
    envFingerprint: FP,
    planned: [],
    async planForQueue(project) {
      this.planned.push(project.rev);
      const cardPlan = clipsOf(project).map((c) => {
        const contentKey = contentKeyOf(c);
        return { clipId: c.id, cardId: c.cardId, nodeId: c.id, contentKey, snapshotKey: resultKeyOf(contentKey, FP), count: framesOf(c), tier: 'shared', cacheable: true, compositing: 'independent', capabilities: {} };
      });
      const entry = { key: `entry-${sha256(JSON.stringify(project)).slice(0, 12)}`, project, cardPlan };
      const context = { entryKey: entry.key, cardPlan, streams: [], anchorFrames: [], cardSourceVersions: {}, cardLocks: new Map(), weightOf: () => ({ class: 'medium', estMs: null }) };
      return { entry, context, streamSpecs: [] };
    },
    queueHandles: (control) => !!control?.snapshotKey && !!control.clipId,
    prerenderPicked: (entry, clipId) => { const c = entry.cardPlan.find((x) => x.clipId === clipId); return !!c && picked.has(identity(c)); },
    addBackfill(entry, clipIds) {
      let added = 0;
      for (const c of entry.cardPlan) if (clipIds.includes(c.clipId) && !picked.has(identity(c))) { picked.add(identity(c)); added += 1; }
      return added;
    },
    recordSplitCandidates() {},
    async renderCardSnapshotRange(entry, control, range, { progress } = {}) {
      const now = clipsOf(world.doc.body).find((c) => c.id === control.clipId);
      const item = { clipId: control.clipId, contentKey: control.contentKey, from: range.from, to: range.to, byRev: entry.project.rev, headRev: world.doc.rev, current: !!now && contentKeyOf(now) === control.contentKey };
      world.started.push(item);
      if (world.gate.render) await world.gate.render.promise;
      if (!this.prerenderPicked(entry, control.clipId)) return;   // 不在预渲染集合里:什么都不产
      world.produced.add(`${control.snapshotKey}:${range.from}-${range.to}`);
      world.rendered.push(item);
      progress?.(range.to - range.from + 1);
    },
  };
}

/* ------------------------------------------------------------------ 一整套:队列、渲染节点、Agent 服务的补渲 */

function createWorld(t, { clips, reopenMs = 15 }) {
  const clock = createTimerClock();
  const lb = createLoopback();
  const queue = createRenderQueue({ now: clock.now, send: lb.queueSend });
  lb.attach(queue);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-ca-rr-'));
  const world = {
    clock, lb, queue,
    /** 文档服务里的项目:有真身,只给得出当前这一版 */
    doc: { rev: 1, body: { ...projectOf(clips), rev: 1 } },
    gate: { render: null, locate: null },
    started: [], rendered: [], produced: new Set(), stored: new Set(), layerMaps: [], locates: [], nodeEvents: [], hosts: [], sockets: [], events: [],
  };

  /** 项目客户端替身:与文档服务对有真身项目的回答相同(当前版本照给;别的版本回没有、带当前版本号) */
  world.projects = () => ({
    async locate(projectId, projectRev) {
      if (world.gate.locate) await world.gate.locate.promise;
      world.locates.push(projectRev);
      if (projectId === PID && projectRev === world.doc.rev) return { project: structuredClone(world.doc.body), projectRev };
      return { project: null, currentRev: projectId === PID ? world.doc.rev : null };
    },
    async get(projectId, projectRev) { return (await this.locate(projectId, projectRev)).project; },
  });

  const sink = {
    async has(ref) { return world.stored.has(`${ref.resultKey}:${ref.range.from}-${ref.range.to}`); },
    async put(ref) {
      const key = `${ref.resultKey}:${ref.range.from}-${ref.range.to}`;
      if (!world.produced.has(key)) return { complete: false, reason: '这一段没有产出帧' };
      world.stored.add(key);
      return { complete: true, result: {} };
    },
  };

  /** 起一台渲染节点(托管方渲染服务的工作进程):新的执行器、新的管线记忆 */
  world.startHost = () => {
    const pipeline = fakePipeline(world);
    const executor = createPrerenderExecutor({
      pipeline, projects: world.projects(),
      publishLayerMap: (entry) => world.layerMaps.push({ rev: entry.project.rev, clips: entry.cardPlan.filter((c) => pipeline.prerenderPicked(entry, c.clipId)).map((c) => `${c.clipId}|${c.contentKey}`) }),
    });
    const record = { pipeline, executor, endpoint: null, host: null, dead: false };
    record.host = createRenderHost({
      entries: [], dynamic: true,
      connect: () => { record.endpoint = lb.connect(`host-${world.hosts.length}`, RENDER); return { endpoint: record.endpoint, executor, sink, close() {} }; },
      nodeIdOf: () => NODE_ID,
      envFingerprint: FP, codeVersion: CV, maxConcurrent: 1, now: clock.now, random: () => 0,
      onEvent: (e) => world.nodeEvents.push(e),
    });
    record.host.start();
    record.host.add({ projectId: PID });
    world.hosts.push(record);
    return record;
  };
  /** 进程被杀:连接断了,手里的认领不放回(等队列按宽限期收回) */
  world.killHost = (record) => { record.dead = true; record.endpoint?.close(); };

  /* ---- Agent 服务一侧:真的补渲与发布通道,WebSocket 换成接到同一个队列上的替身 */
  let wsSeq = 0;
  class BridgeWS {
    constructor() {
      this.listeners = new Map(); this.closed = false; this.connId = `agent-ws-${++wsSeq}`; this.ep = null;
      world.sockets.push(this);
      setTimeout(() => {
        if (this.closed) return;
        this.ep = lb.connect(this.connId, AGENT);
        this.ep.onMessage((m) => this.fire('message', { data: JSON.stringify(m) }));
        this.fire('open', {});
      }, 0);
    }
    addEventListener(type, fn, opts) { const l = this.listeners.get(type) ?? []; l.push({ fn, once: opts?.once === true }); this.listeners.set(type, l); }
    fire(type, ev) { const l = this.listeners.get(type) ?? []; this.listeners.set(type, l.filter((x) => !x.once)); for (const x of l) x.fn(ev); }
    send(text) { this.ep.send(JSON.parse(text)); }
    close(code = 1000, reason = '') { if (this.closed) return; lb.flush(); this.closed = true; this.ep?.close(); setTimeout(() => this.fire('close', { code, reason }), 0); }
    /** 服务端那一头断了(不是我们关的) */
    drop() { if (this.closed) return; this.closed = true; this.ep?.close(); this.fire('close', { code: 1006, reason: '' }); }
  }
  const client = { instanceId: 'agent-instance-0001', connected: true, publishTicket: async () => ({ ok: true, ticket: 'pub-ticket' }), dataProtocols: () => ['promptcut.v1'], demand: async () => {} };
  world.publisher = createQueuePublisher({ client, docUrl: 'ws://127.0.0.1:1', root: '.', renderState: () => ({ available: true, enabled: true }), WebSocketImpl: BridgeWS, codeVersionOf: () => CV });
  world.conv = { projectId: PID, ownerKey: 'creator', id: 'conv-1' };
  const store = { dirOf: () => dir, get: () => world.conv, emit: (_conv, e) => world.events.push(e), * walk() {} };
  // 防抖设得极长:什么时候发由测试用 flush 定(一次写入之后隔得比防抖长 = 写完就 flush)
  world.requests = createRenderRequests({ publisher: world.publisher, store, limits: { debounceMs: 3_600_000, reopenMs: [reopenMs, reopenMs, reopenMs, reopenMs], progressEveryMs: 0 } });

  /** 推一会儿:消息往返、渲染节点的节拍、队列的扫描、真实计时器(发布通道的握手)。`until` 为真就停 */
  world.pump = async (until = () => false, { steps = 600, advance = 250, what = '' } = {}) => {
    for (let i = 0; i < steps; i += 1) {
      lb.flush();
      for (const h of world.hosts) if (!h.dead) h.host.tick();
      queue.tick();
      lb.flush();
      await realTick();
      lb.flush();
      if (until()) return i;
      clock.advance(advance);
    }
    assert.fail(`推了 ${steps} 步仍未满足:${what}\n事件:${JSON.stringify(world.events.map((e) => e.state))}\n队列:${JSON.stringify(queue.describe().tasks.map((x) => [x.id.slice(0, 40), x.state, x.lastError]))}`);
  };
  /** 等一个 promise 落定,期间照常推 */
  world.run = async (promise, what = '') => {
    let done = false;
    let error = null;
    promise.then(() => { done = true; }, (e) => { done = true; error = e; });
    await world.pump(() => done, { what });
    if (error) throw error;
  };
  /** 别的成员改了项目(Agent 服务不知道) */
  world.otherWrite = (mutate) => {
    const body = structuredClone(world.doc.body);
    mutate(Object.fromEntries(clipsOf(body).map((c) => [c.id, c])));
    world.doc = { rev: world.doc.rev + 1, body: { ...body, rev: world.doc.rev + 1 } };
  };
  /** 云端 Agent 的一次写入落地;`publish` 为真 = 这次写入之后隔得比防抖长,计划已经发出去 */
  world.agentWrite = async (mutate, clipIds, { publish = true } = {}) => {
    world.otherWrite(mutate);
    world.requests.noteWrite(world.conv, { clipIds, rev: world.doc.rev, project: world.doc.body, runId: 'run-1' });
    if (publish) await world.run(world.requests.flush(world.conv), `第 ${world.doc.rev} 版的计划发出去`);
  };
  world.task = (id) => queue.describe().tasks.find((x) => x.id === id) ?? null;
  /** Agent 服务的发布方此刻订着这个任务吗 */
  world.agentSubscribed = (id) => (world.task(id)?.subscribers ?? []).some((x) => x.startsWith('agent-pub-'));
  world.planId = (rev, clipIds) => clipsPlanTaskOf({ projectId: PID, projectRev: rev, clips: clipIds, codeVersion: CV }).id;
  world.renderStates = () => world.events.filter((e) => e.type === 'render').map((e) => e.state);
  /** 不看进度的那几条 */
  world.outcomes = () => world.renderStates().filter((s) => s !== 'progress');
  world.idle = () => queue.describe().tasks.every((x) => x.state === 'done' || x.state === 'failed') && lb.pending() === 0;

  /** 每条用例收尾都核的四件事 */
  world.assertNothingFailed = () => {
    const failedTasks = queue.describe().tasks.filter((x) => x.state === 'failed' && x.lastError !== SUPERSEDED);
    assert.deepEqual(failedTasks.map((x) => [x.id, x.lastError]), [], '队列里没有以失败收场的任务(作废的不算)');
    const failedMsgs = lb.log().filter((e) => e.dir === 'out' && e.message.type === 'task.failed' && e.message.error !== SUPERSEDED);
    assert.deepEqual(failedMsgs.map((e) => [e.connId, e.message.id, e.message.error]), [], '队列没有给任何人发过失败通知(作废的不算)');
    assert.deepEqual(world.nodeEvents.filter((e) => e.type === 'failed').map((e) => [e.id, e.error]), [], '渲染节点没有一个任务记成失败');
    assert.equal(world.hosts.reduce((n, h) => n + (h.host.nodes()[0]?.failed ?? 0), 0), 0, '渲染节点诊断里的 failed 是 0');
    assert.deepEqual(world.events.filter((e) => e.type === 'render' && (e.state === 'failed' || e.state === 'unavailable')), [], '对话记录里没有补渲失败');
    assert.deepEqual(world.started.filter((x) => !x.current).map((x) => [x.clipId, x.byRev, x.headRev]), [], '渲染节点没有为已被新版本取代的内容开工');
    assert.deepEqual(lb.errors().map((e) => String(e?.message ?? e)), [], '消息处理没有抛错');
  };
  /** 最后一版里这些片段的每一段都在产物库里 */
  world.assertFinalRendered = (clipIds) => {
    for (const id of clipIds) {
      const clip = clipsOf(world.doc.body).find((c) => c.id === id);
      const key = resultKeyOf(contentKeyOf(clip), FP);
      for (let from = 0; from < framesOf(clip); from += 60) assert.ok(world.stored.has(`${key}:${from}-${Math.min(framesOf(clip), from + 60) - 1}`), `最后一版的 ${id} 第 ${from} 帧起的那一段入库了`);
    }
  };

  t.after(() => {
    world.requests.close();
    world.publisher.close();
    for (const h of world.hosts) { try { h.host.shutdown('test-end'); } catch { /* 已停 */ } }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return world;
}

const baseClips = () => [clipOf('a', 'a1'), clipOf('b', 'b1'), clipOf('c', 'c1')];

/* ================================================================== CA-RR-01 */

test('CA-RR-01 间隔长的多次写入:每次写入各发一个计划、项目接着往前走——没有任务以失败收场,最后一版全部渲完', async (t) => {
  const w = createWorld(t, { clips: baseClips() });
  w.startHost();

  // 第 1 次写入(第 2 版),隔得够久:计划发出去、渲完
  await w.agentWrite((c) => { c.a.params.text = 'a2'; }, ['a']);
  await w.pump(() => w.renderStates().at(-1) === 'done', { what: '第 2 版渲完' });
  assert.deepEqual(w.outcomes(), ['published', 'done']);

  // 第 2、3 次写入:渲染节点认领第 3 版的计划时取项目慢了一步,那时项目已经是第 4 版
  w.gate.locate = deferred();
  await w.agentWrite((c) => { c.b.params.text = 'b3'; }, ['b']);
  await w.pump(() => w.task(w.planId(3, ['b']))?.state === 'claimed', { what: '第 3 版的计划被认领' });
  await w.agentWrite((c) => { c.c.params.text = 'c4'; }, ['c']);
  assert.equal(w.agentSubscribed(w.planId(3, ['b'])), false, '旧计划已撤回(不再订)');
  w.gate.locate.resolve();
  w.gate.locate = null;
  await w.pump(() => w.renderStates().at(-1) === 'done' && w.idle(), { what: '第 4 版渲完' });
  assert.ok(w.locates.includes(3), '渲染节点去取过第 3 版');
  assert.equal(w.hosts[0].pipeline.planned.includes(3), false, '第 3 版已经取不到,没有按它算');
  assert.deepEqual(w.rendered.map((x) => [x.clipId, x.byRev]), [['a', 2], ['b', 4], ['c', 4]], '第 3 版的计划按当前版本(第 4 版)切;b 只渲一次');

  // 第 4～6 次写入:渲染节点手里压着一段(第 5 版的 a),其间又写了两次
  w.gate.render = deferred();
  let n = w.started.length;
  await w.agentWrite((c) => { c.a.params.text = 'a5'; }, ['a']);
  await w.pump(() => w.started.length === n + 1, { what: '第 5 版的 a 开工' });
  await w.agentWrite((c) => { c.c.params.text = 'c6'; }, ['c']);
  await w.agentWrite((c) => { c.b.params.text = 'b7'; }, ['b']);
  assert.equal(w.task(w.planId(6, ['a', 'c'])), null, '第 6 版的计划还没人认领就被第 7 版的取代:撤掉了,不是失败');
  w.gate.render.resolve();
  w.gate.render = null;
  await w.pump(() => w.renderStates().at(-1) === 'done' && w.idle(), { what: '第 7 版渲完' });

  // 第 7、8 次写入:第 8 版切出的 c 还没开工,第 9 版又把 c 改了
  w.gate.render = deferred();
  n = w.started.length;
  await w.agentWrite((c) => { c.b.params.text = 'b8'; c.c.params.text = 'c8'; }, ['b', 'c']);
  await w.pump(() => w.started.length === n + 1, { what: '第 8 版的一段开工' });
  const stale = w.started.at(-1).clipId === 'b' ? 'c' : 'b';
  const staleIds = taskIdsFor(clipsOf(w.doc.body).find((c) => c.id === stale));
  assert.equal(w.task(staleIds[0])?.state, 'open', '第 8 版的另一段还在排队');
  await w.agentWrite((c) => { c[stale].params.text = `${stale}9`; }, [stale]);
  w.gate.render.resolve();
  w.gate.render = null;
  await w.pump(() => w.renderStates().at(-1) === 'done' && w.idle(), { what: '第 9 版渲完' });

  assert.equal(w.task(staleIds[0])?.lastError ?? SUPERSEDED, SUPERSEDED, '排队中被取代的那一段:作废(或已撤掉),不是失败');
  assert.equal(w.rendered.some((x) => x.clipId === stale && x.byRev === 8), false, '被取代的那一段没有渲');
  assert.ok(w.nodeEvents.filter((e) => e.type === 'superseded').length >= 1, '渲染节点把它记成作废');
  assert.equal(w.hosts[0].host.nodes()[0].superseded, w.nodeEvents.filter((e) => e.type === 'superseded').length, '诊断里的 superseded 计数');
  w.assertNothingFailed();
  w.assertFinalRendered(['a', 'b', 'c']);
  assert.equal(w.renderStates().at(-1), 'done', '对话记录的补渲结局是完成');
  assert.equal(w.renderStates().filter((s) => s === 'published').length, 8, '8 次写入各发了一次计划(中途就开始渲,不等一轮结束)');
  assert.equal(w.layerMaps.at(-1).rev, 9, '最后写的层表是最后一版的');
  const last = new Set(w.layerMaps.at(-1).clips);
  for (const c of clipsOf(w.doc.body)) assert.ok(last.has(`${c.id}|${contentKeyOf(c)}`), `最后一版的层表里有 ${c.id} 的当前内容`);
  let revSeen = 0;
  for (const m of w.layerMaps) { assert.ok(m.rev >= revSeen, `层表不被迟到的旧计划写回旧版本:${JSON.stringify(w.layerMaps.map((x) => x.rev))}`); revSeen = m.rev; }
});

/* ================================================================== CA-RR-02 */

test('CA-RR-02 旧计划被取代:没人认领的撤掉;切出来还没开工的,内容没变照做、内容换了作废;都不是失败', async (t) => {
  const w = createWorld(t, { clips: baseClips() });
  w.startHost();
  w.gate.render = deferred();
  // 第 2 版:a、b、c 都要渲。渲染节点切出三段,开工第一段后被压住
  await w.agentWrite((c) => { c.a.params.text = 'a2'; c.b.params.text = 'b2'; c.c.params.text = 'c2'; }, ['a', 'b', 'c']);
  await w.pump(() => w.started.length === 1, { what: '第一段开工' });
  const v2 = Object.fromEntries(clipsOf(w.doc.body).map((c) => [c.id, taskIdsFor(c)[0]]));
  const first = w.started[0].clipId;
  const [kept, changed] = ['a', 'b', 'c'].filter((id) => id !== first);
  assert.deepEqual([w.task(v2[kept])?.state, w.task(v2[changed])?.state], ['open', 'open']);

  // 第 3 版只改 changed;第 4 版又改一次(第 3 版的计划还没人认领)
  await w.agentWrite((c) => { c[changed].params.text = `${changed}3`; }, [changed]);
  const plan3 = w.planId(3, ['a', 'b', 'c']);
  assert.equal(w.task(plan3)?.state, 'open');
  await w.agentWrite((c) => { c[changed].params.text = `${changed}4`; }, [changed]);
  assert.equal(w.task(plan3), null, '没人认领的旧计划:从队列里撤掉了');
  assert.equal(lbFailed(w, plan3), 0, '撤掉不发失败通知');

  w.gate.render.resolve();
  w.gate.render = null;
  await w.pump(() => w.renderStates().at(-1) === 'done' && w.idle(), { what: '最后一版渲完' });

  assert.equal(w.task(v2[kept])?.state, 'done', '内容没变的旧细任务照做(新计划切出的是同一个任务)');
  assert.equal(w.rendered.filter((x) => x.clipId === kept).length, 1, '只渲一次');
  const old = w.task(v2[changed]);
  assert.ok(old === null || (old.state === 'failed' && old.lastError === SUPERSEDED), `内容换了的旧细任务:作废或已撤掉(${JSON.stringify(old)})`);
  assert.deepEqual(w.rendered.filter((x) => x.clipId === changed).map((x) => x.byRev), [4], '只渲了最后那份内容');
  assert.deepEqual(w.outcomes(), ['published', 'published', 'published', 'done'], '对话记录里只有已发布、进度、完成');
  w.assertNothingFailed();
  w.assertFinalRendered(['a', 'b', 'c']);
});
const lbFailed = (w, id) => w.lb.log().filter((e) => e.dir === 'out' && e.message.type === 'task.failed' && e.message.id === id).length;

/* ================================================================== CA-RR-03 */

test('CA-RR-03 发布方断线重连重发:断开期间细任务做完、过了宽限期、项目又往前走——重发后对得上,没有失败', async (t) => {
  const w = createWorld(t, { clips: baseClips(), reopenMs: 400 });
  const h = w.startHost();
  w.gate.render = deferred();
  await w.agentWrite((c) => { c.a.params.text = 'a2'; c.b.params.text = 'b2'; }, ['a', 'b']);
  await w.pump(() => w.started.length === 1, { what: '第一段开工' });
  const plan2 = w.planId(2, ['a', 'b']);
  const v2 = Object.fromEntries(clipsOf(w.doc.body).map((c) => [c.id, taskIdsFor(c)[0]]));

  // 发布连接从服务端那一头断了;断开期间两段都做完(完成通知发不到)
  const sockets = w.sockets.length;
  w.sockets.at(-1).drop();
  w.gate.render.resolve();
  w.gate.render = null;
  await w.pump(() => w.task(v2.a)?.state === 'done' && w.task(v2.b)?.state === 'done', { steps: 60, what: '断开期间两段做完' });
  assert.equal(w.sockets.length, sockets, '还没重连');
  assert.deepEqual(w.outcomes(), ['published'], '完成通知没到:对话记录里还没有结局');
  // 过了队列留订阅的宽限期:它在这两段上的订阅没了
  w.clock.advance(11_000);
  w.queue.tick();
  assert.equal(w.agentSubscribed(v2.a), false);
  // 其间 Agent 又把 b 改了(第 3 版,计划还没发);渲染节点手里也不再有第 2 版(缓存只留最近几版)
  await w.agentWrite((c) => { c.b.params.text = 'b3'; }, ['b'], { publish: false });
  h.executor.forget();

  // 重连:把没收到结局的旧计划(指着第 2 版)原样重发
  await w.pump(() => w.outcomes().at(-1) === 'done' && w.idle(), { what: '重连重发后收尾' });
  assert.ok(w.sockets.length > sockets, '发布通道重开过');
  assert.equal(w.task(plan2)?.state, 'done');
  assert.ok(w.lb.log().some((e) => e.dir === 'in' && e.message.type === 'task.publish' && e.message.tasks?.[0]?.id?.includes('#backfill:')), '重发后发现计划已经切完:改发补渲档的同一份清单核对一次');
  assert.deepEqual(h.pipeline.planned, [2, 3], '核对的那一次切分:第 2 版已经取不到,按当前版本(第 3 版)切');
  assert.deepEqual(w.outcomes(), ['published', 'done'], '旧计划对上了:完成,不是失败');
  w.assertNothingFailed();
  w.assertFinalRendered(['a', 'b']);

  // 防抖到点,第 3 版的计划发出去:b 的新内容核对时已经渲过,直接完成
  const before = w.rendered.length;
  await w.run(w.requests.flush(w.conv), '第 3 版的计划发出去');
  await w.pump(() => w.outcomes().at(-1) === 'done' && w.idle(), { what: '第 3 版收尾' });
  assert.deepEqual(w.outcomes(), ['published', 'done', 'published', 'done']);
  assert.equal(w.rendered.length, before, '不重复渲');
  w.assertNothingFailed();
  w.assertFinalRendered(['a', 'b']);
});

/* ================================================================== CA-RR-04 */

test('CA-RR-04 渲染节点中途重启:收回的那一段由新进程接着做,旧版本取不到就按当前版本核对——没有失败', async (t) => {
  const w = createWorld(t, { clips: baseClips() });
  const h1 = w.startHost();
  w.gate.render = deferred();   // 第一台的这一段永远做不完
  await w.agentWrite((c) => { c.a.params.text = 'a2'; c.b.params.text = 'b2'; }, ['a', 'b']);
  await w.pump(() => w.started.length === 1, { what: '第一段开工' });
  const first = w.started[0].clipId;
  const other = first === 'a' ? 'b' : 'a';
  const ids = Object.fromEntries(clipsOf(w.doc.body).map((c) => [c.id, taskIdsFor(c)[0]]));
  assert.equal(w.task(ids[first])?.state, 'claimed');

  // 进程被杀;别的成员把还没开工的那一段的片段改了(第 3 版)
  w.killHost(h1);
  w.gate.render = null;
  w.otherWrite((c) => { c[other].params.text = `${other}3`; });
  w.clock.advance(11_000);
  w.queue.tick();
  w.lb.flush();
  assert.equal(w.task(ids[first])?.state, 'open', '队列按宽限期收回了它手里的那一段');
  assert.equal(w.task(ids[first])?.attempts, 1);

  // 新进程:执行器的缓存、管线的预渲染集合都是空的
  const h2 = w.startHost();
  await w.pump(() => w.renderStates().at(-1) === 'done' && w.idle(), { what: '新进程做完' });
  assert.deepEqual(h2.pipeline.planned, [3], '旧版本取不到,新进程只按当前版本算了一次');
  assert.equal(w.task(ids[first])?.state, 'done', '内容没变的那一段:新进程做完了');
  assert.ok(w.stored.has(ids[first].replace('snapshot:', '')), '入库了(清单计划切出的细任务按任务记进预渲染集合)');
  assert.deepEqual([w.task(ids[other])?.state, w.task(ids[other])?.lastError], ['failed', SUPERSEDED], '内容换了的那一段:作废');
  assert.equal(w.rendered.some((x) => x.clipId === other), false, '没有为它开工');
  assert.equal(h2.host.nodes()[0].superseded, 1);
  assert.equal(w.events.findLast((e) => e.type === 'render').state, 'done', '对话记录的补渲结局是完成');
  w.assertNothingFailed();

  // Agent 再写那一段:最后一版全部渲完
  await w.agentWrite((c) => { c[other].params.text = `${other}4`; }, [other]);
  await w.pump(() => w.renderStates().at(-1) === 'done' && w.idle() && w.rendered.some((x) => x.clipId === other), { what: '最后一版渲完' });
  w.assertNothingFailed();
  w.assertFinalRendered(['a', 'b']);
});

/* ================================================================== CA-RR-05 */

test('CA-RR-05 执行器:取不到旧版本按当前版本算;内容没变照做、换了抛 superseded;没说当前版本照旧 no-snapshot;非清单任务照旧', async () => {
  const world = { doc: { rev: 5, body: { ...projectOf(baseClips()), rev: 5 } }, gate: {}, started: [], rendered: [], produced: new Set(), locates: [] };
  const projects = {
    hint: true,
    async locate(projectId, projectRev) {
      world.locates.push(projectRev);
      if (projectRev === world.doc.rev) return { project: structuredClone(world.doc.body), projectRev };
      return { project: null, currentRev: this.hint ? world.doc.rev : null };
    },
    async get(projectId, projectRev) { return (await this.locate(projectId, projectRev)).project; },
  };
  const pipeline = fakePipeline(world);
  const logs = [];
  const layerMaps = [];
  const executor = createPrerenderExecutor({ pipeline, projects, log: (event, fields) => logs.push({ event, ...fields }), publishLayerMap: (entry) => layerMaps.push(entry.project.rev) });
  const detailOf = (planTask, context, clipId) => splitPlan({ ...context, planTask, envFingerprint: FP, codeVersion: CV, prerenderSet: new Set(planTask.input?.clips ?? ['a', 'b', 'c']) }).find((x) => x.input.clipId === clipId);

  // 计划指的第 3 版已经没有:按当前(第 5 版)切,带回 actualRev
  const plan3 = clipsPlanTaskOf({ projectId: PID, projectRev: 3, clips: ['a', 'b'], codeVersion: CV });
  const ctx = await executor.plan(plan3);
  assert.equal(ctx.actualRev, 5);
  assert.deepEqual(world.locates, [3, 5]);
  assert.ok(logs.some((l) => l.event === 'executor.drift' && l.actual === 5));
  await executor.afterSplit(plan3, { tasks: [] });
  assert.deepEqual(layerMaps, [5], '层表按实际切的那一版写');

  // 当前版本的计划:不带 actualRev(原样)
  const plan5 = clipsPlanTaskOf({ projectId: PID, projectRev: 5, clips: ['a', 'b'], codeVersion: CV });
  const ctx5 = await executor.plan(plan5);
  assert.equal('actualRev' in ctx5, false);

  // 旧版本的细任务:内容没变 → 照做
  const taskA = { ...detailOf(plan3, ctx, 'a'), state: 'claimed' };
  assert.equal(taskA.source.projectRev, 3);
  await executor.render(taskA, {});
  assert.deepEqual(world.rendered.map((x) => [x.clipId, x.byRev]), [['a', 5]]);

  // 项目又往前走(第 6 版,b 换了内容):执行器还没算过第 6 版时,旧任务对着它算过的最新一版(第 5 版)核,内容还在 → 照做
  const taskB = detailOf(plan3, ctx, 'b');
  world.doc = { rev: 6, body: { ...projectOf([clipOf('a', 'a1'), clipOf('b', 'b6'), clipOf('c', 'c1')]), rev: 6 } };
  // 第 6 版的计划被认领之后,旧内容的 b 就作废了
  await executor.plan(clipsPlanTaskOf({ projectId: PID, projectRev: 6, clips: ['b'], codeVersion: CV }));
  await assert.rejects(() => executor.render(taskB, {}), (error) => error.superseded === true && error.retryable === false && error.message === SUPERSEDED && /内容在新版本里换了/.test(error.detail));
  // 片段整个没了也是作废
  await assert.rejects(() => executor.render({ ...taskB, input: { ...taskB.input, clipId: 'gone' } }, {}), (error) => error.superseded === true && /没有片段/.test(error.detail));
  // 同一版里对不上的(不是版本往前走造成的)照旧是 plan-mismatch
  const fresh = createPrerenderExecutor({ pipeline: fakePipeline(world), projects });
  const plan6 = clipsPlanTaskOf({ projectId: PID, projectRev: 6, clips: ['b'], codeVersion: CV });
  const ctx6 = await fresh.plan(plan6);
  const taskB6 = detailOf(plan6, ctx6, 'b');
  await assert.rejects(() => fresh.render({ ...taskB6, input: { ...taskB6.input, contentKey: 'x'.repeat(64) } }, {}), (error) => error.code === 'plan-mismatch' && error.superseded !== true);

  // 文档服务没说当前版本(没有真身的项目):照旧 no-snapshot、可重试
  projects.hint = false;
  const cold = createPrerenderExecutor({ pipeline: fakePipeline(world), projects });
  await assert.rejects(() => cold.plan(clipsPlanTaskOf({ projectId: PID, projectRev: 2, clips: ['a'], codeVersion: CV })), (error) => error.code === 'no-snapshot' && error.retryable === true && /文档服务上没有项目快照/.test(error.message));
  // 只有 get 的旧项目客户端:同上
  const legacy = createPrerenderExecutor({ pipeline: fakePipeline(world), projects: { get: async () => null } });
  await assert.rejects(() => legacy.plan(plan3), (error) => error.code === 'no-snapshot');

  // 不是清单计划切出的任务(桌面版的计划):手里有那一版的缓存就照旧按那一版做,不因为算过更新的一版而改
  projects.hint = true;
  world.doc = { rev: 7, body: { ...projectOf([clipOf('a', 'a7'), clipOf('b', 'b6'), clipOf('c', 'c1')]), rev: 7 } };
  const desk = createPrerenderExecutor({ pipeline: fakePipeline(world), projects });
  const deskPlan7 = { id: `plan:${PID}@7`, kind: 'plan', resultKey: `${PID}@7`, range: null, source: { projectId: PID, projectRev: 7 }, input: {}, priority: 0 };
  const deskCtx7 = await desk.plan(deskPlan7);
  const deskTask = splitPlan({ ...deskCtx7, planTask: deskPlan7, envFingerprint: FP, codeVersion: CV }).find((x) => x.input.clipId === 'a');
  world.doc = { rev: 8, body: { ...projectOf([clipOf('a', 'a8'), clipOf('b', 'b6'), clipOf('c', 'c1')]), rev: 8 } };
  await desk.plan({ ...deskPlan7, id: `plan:${PID}@8`, resultKey: `${PID}@8`, source: { projectId: PID, projectRev: 8 } });
  const before = world.started.length;
  await desk.render(deskTask, {});
  assert.deepEqual([world.started.length - before, world.started.at(-1).byRev], [1, 7]);
});

/* ================================================================== CA-RR-06 */

test('CA-RR-06 文档服务:有真身的项目取旧版本回 missing 加 currentRev,取当前版本照给;没有真身的不带;项目客户端的 locate', async (t) => {
  const { createMemoryStore } = await loadStore();
  const makeProject = await loadProject();
  const env = await startStandalone({ modules: [makeProject({ store: createMemoryStore(), now: () => 1_700_000_000_000 })], now: () => 1_700_000_000_000 });
  const endpoints = new Set();
  t.after(async () => { for (const ep of endpoints) { try { ep.close(); } catch { /* 已关 */ } } await env.cleanup(); });
  const c = await env.connect('member-a');
  const commit = async (n, ops) => { const r = await ask(c, { type: 'project.op', projectId: 'sp_body', opId: `op-${n}`, session: 's1', ops }); assert.equal(r.type, 'project.op.ok', JSON.stringify(r)); return r; };
  const body = projectOf(baseClips());
  await commit(1, [{ op: 'set', path: '', value: body }]);
  await commit(2, [{ op: 'set', path: '/duration', value: 3 }]);
  await commit(3, [{ op: 'set', path: '/duration', value: 4 }]);

  const old = await ask(c, { type: 'project.snapshot.get', projectId: 'sp_body', projectRev: 1 });
  assert.deepEqual({ type: old.type, missing: old.missing, currentRev: old.currentRev }, { type: 'project.snapshot.part', missing: true, currentRev: 3 });
  const future = await ask(c, { type: 'project.snapshot.get', projectId: 'sp_body', projectRev: 9 });
  assert.deepEqual([future.missing, future.currentRev], [true, 3]);

  const client = createProjectClient(await connectEndpoint(`ws://127.0.0.1:${env.port}/?user=render-node`, { env: { endpoints } }));
  assert.deepEqual(await client.locate('sp_body', 2), { project: null, currentRev: 3 });
  const now = await client.locate('sp_body', 3);
  assert.equal(now.projectRev, 3);
  assert.deepEqual(now.project, { ...body, duration: 4 });
  assert.equal(await client.get('sp_body', 2), null, 'get 照旧:没有回 null');
  assert.deepEqual(await client.get('sp_body', 3), { ...body, duration: 4 });

  // 没有真身的项目(只登记过摘要):照旧,不带 currentRev
  const text = JSON.stringify(body);
  const a = await client.announce('sp_plain', sha256(text));
  assert.equal(a.projectRev, 1);
  const plain = await ask(c, { type: 'project.snapshot.get', projectId: 'sp_plain', projectRev: 1 });
  assert.equal(plain.missing, true);
  assert.equal('currentRev' in plain, false);
  assert.deepEqual(await client.locate('sp_plain', 1), { project: null, currentRev: null });
  assert.deepEqual(await client.locate('sp_none', 4), { project: null, currentRev: null });
});

/* ================================================================== CA-RR-07 */

function fakeQueueWs() {
  const sockets = [];
  class FakeWS {
    constructor() { this.sent = []; this.listeners = new Map(); this.closed = false; sockets.push(this); setTimeout(() => this.fire('open', {}), 0); }
    addEventListener(type, fn, opts) { const l = this.listeners.get(type) ?? []; l.push({ fn, once: opts?.once === true }); this.listeners.set(type, l); }
    fire(type, ev) { const l = this.listeners.get(type) ?? []; this.listeners.set(type, l.filter((x) => !x.once)); for (const x of l) x.fn(ev); }
    send(text) {
      const m = JSON.parse(text);
      this.sent.push(m);
      queueMicrotask(() => {
        if (m.type === 'publisher.hello') this.reply({ type: 'publisher.welcome', publisherId: m.publisherId, reqId: m.reqId });
        else if (m.type === 'task.publish') this.reply({ type: 'task.published', reqId: m.reqId, results: m.tasks.map((x) => ({ id: x.id, state: 'open', version: 1, created: true })) });
        else if (m.type === 'task.unsubscribe') this.reply({ type: 'task.unsubscribed', reqId: m.reqId, ids: m.ids });
      });
    }
    reply(m) { this.fire('message', { data: JSON.stringify(m) }); }
    close(code = 1000, reason = '') { if (this.closed) return; this.closed = true; setTimeout(() => this.fire('close', { code, reason }), 0); }
  }
  return { FakeWS, sockets };
}

test('CA-RR-07 发布通道:细任务作废不算失败;计划有了结局就退订它的细任务(别的计划还要的不退)、清掉旧账;以最新一次切分的清单为准', async (t) => {
  const q = fakeQueueWs();
  const client = { instanceId: 'agent-instance-0001', connected: true, publishTicket: async () => ({ ok: true, ticket: 'pub-ticket' }), dataProtocols: () => ['promptcut.v1'], demand: async () => {} };
  const pub = createQueuePublisher({ client, docUrl: 'ws://127.0.0.1:1', root: '.', renderState: () => ({ available: true, enabled: true }), WebSocketImpl: q.FakeWS, codeVersionOf: () => CV });
  t.after(() => pub.close());
  const seen = { done: [], fail: [], progress: 0 };
  const handle = await pub.open(PID, { onProgress: () => { seen.progress += 1; }, onDone: (d) => seen.done.push(d), onFail: (f) => seen.fail.push(f), onClose: () => {} });
  const ws = q.sockets[0];
  const tickMs = () => new Promise((resolve) => setTimeout(resolve, 5));
  const unsubscribed = () => ws.sent.filter((m) => m.type === 'task.unsubscribe').map((m) => m.ids);
  const planA = clipsPlanTaskOf({ projectId: PID, projectRev: 2, clips: ['a', 'b'], codeVersion: CV });
  const planB = clipsPlanTaskOf({ projectId: PID, projectRev: 3, clips: ['a', 'b'], codeVersion: CV });

  // 计划 A 切出 t1、t2;t2 的内容被新版本取代(作废),t1 做完 → A 完成,带作废数,不报失败
  await handle.publish(planA);
  ws.reply({ type: 'task.done', id: planA.id, result: { derived: ['t1', 't2'] } });
  ws.reply({ type: 'task.failed', id: 't2', error: 'superseded' });
  assert.deepEqual([seen.done, seen.fail], [[], []], '还差 t1');
  ws.reply({ type: 'task.done', id: 't1', result: {} });
  assert.deepEqual(seen.done, [{ id: planA.id, superseded: 1 }]);
  assert.deepEqual(seen.fail, []);
  await tickMs();
  assert.deepEqual(unsubscribed(), [[planA.id, 't1', 't2']], '有了结局:退订计划与它的细任务');

  // 计划 B 又切出 t2(队列把作废的重建了)与 t3:不能凭旧账把 t2 当成有了结局
  await handle.publish(planB);
  ws.reply({ type: 'task.done', id: planB.id, result: { derived: ['t2', 't3'] } });
  ws.reply({ type: 'task.done', id: 't3', result: {} });
  assert.equal(seen.done.length, 1, 't2 还没有结局,B 不算完成');
  // 同时另一个计划 C 也要 t3:B 收尾时不退 t3
  const planC = clipsPlanTaskOf({ projectId: PID, projectRev: 4, clips: ['b', 'c'], codeVersion: CV });
  await handle.publish(planC);
  ws.reply({ type: 'task.done', id: planC.id, result: { derived: ['t3', 't4'] } });
  ws.reply({ type: 'task.done', id: 't2', result: {} });
  assert.deepEqual(seen.done.at(-1), { id: planB.id });
  await tickMs();
  assert.deepEqual(unsubscribed().at(-1), [planB.id, 't2'], 'C 还要 t3:不退');

  // 真失败照旧报失败,带原因;收尾后失败记录清掉,下一个计划遇到同一个细任务要等队列再说
  ws.reply({ type: 'task.failed', id: 't4', error: 'render-crashed' });
  assert.equal(seen.fail.length, 1);
  assert.match(seen.fail[0].reason, /渲染节点报告失败:render-crashed/);
  await tickMs();
  assert.deepEqual(unsubscribed().at(-1), [planC.id, 't3', 't4']);
  const planD = clipsPlanTaskOf({ projectId: PID, projectRev: 5, clips: ['c'], codeVersion: CV });
  await handle.publish(planD);
  ws.reply({ type: 'task.done', id: planD.id, result: { derived: ['t4'] } });
  assert.equal(seen.fail.length, 1, '不凭旧账判失败');
  ws.reply({ type: 'task.done', id: 't4', result: {} });
  assert.deepEqual(seen.done.at(-1), { id: planD.id });

  // 核对用的那一次切分(渲染节点按更新的版本切的)给的清单与原来不同:以新的为准,旧清单里不再有的不等
  const planE = clipsPlanTaskOf({ projectId: PID, projectRev: 6, clips: ['a'], codeVersion: CV });
  await handle.publish(planE);
  ws.reply({ type: 'task.done', id: planE.id, result: { derived: ['old-1'] } });
  ws.reply({ type: 'task.done', id: planE.id, result: { derived: ['new-1'] } });
  ws.reply({ type: 'task.done', id: 'new-1', result: {} });
  assert.deepEqual(seen.done.at(-1), { id: planE.id });
  await tickMs();
  assert.deepEqual(unsubscribed().at(-1), [planE.id, 'old-1', 'new-1'], '切出过的都退订');

  // 撤回:同样不退别的计划还要的
  const planF = clipsPlanTaskOf({ projectId: PID, projectRev: 7, clips: ['a'], codeVersion: CV });
  const planG = clipsPlanTaskOf({ projectId: PID, projectRev: 8, clips: ['a', 'b'], codeVersion: CV });
  await handle.publish(planF);
  ws.reply({ type: 'task.done', id: planF.id, result: { derived: ['f1', 'shared'] } });
  await handle.publish(planG);
  ws.reply({ type: 'task.done', id: planG.id, result: { derived: ['shared', 'g1'] } });
  await handle.withdraw(planF.id);
  assert.deepEqual(unsubscribed().at(-1), [planF.id, 'f1']);
  assert.deepEqual(seen.fail.length, 1);
});
