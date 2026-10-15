import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderQueue, taskIdOf } from '../render-queue/index.mjs';
import { renderQueueModule } from '../docservice/modules/render-queue.mjs';
import { createNodeSession, deviceRank } from '../render-node/session.mjs';
import { splitPlan, isMotionCard } from '../render-node/split.mjs';
import { pageStreamTasks, isMotionCard as isMotionCardPage } from '../../src/online/pageStreamPlan.ts';
import { createFakeClock, createMessageCollector, T0 } from './fake-render-queue-env.mjs';

const FP_PC = 'pppppppppppppppp';
const FP_HOST = 'hhhhhhhhhhhhhhhh';
const FP_BROWSER = 'bbbbbbbbbbbbbbbb';
const CV = 'c0de5a';
const PROJECT = 'proj-preempt';

/* ------------------------------------------------------------------ 1. 卡片 Writing / FrameMode 判定 */

test('MP-01 isMotionCard: 识别 remotion 式与 motion 式卡片', () => {
  // 内置 motion 式卡片（审阅表）
  assert.equal(isMotionCard({ cardId: 'focus-card' }), true, 'focus-card 为 motion');
  assert.equal(isMotionCard({ cardId: 'punch-pill' }), true, 'punch-pill 为 motion');
  assert.equal(isMotionCard({ cardId: 'scene-3d' }), true, 'scene-3d 为 motion');

  // 内置 remotion 式卡片（审阅表）
  assert.equal(isMotionCard({ cardId: 'caption-track' }), false, 'caption-track 为 remotion');
  assert.equal(isMotionCard({ cardId: 'lottie' }), false, 'lottie 为 remotion');

  // 显式 writing 覆盖
  assert.equal(isMotionCard({ writing: 'motion' }), true);
  assert.equal(isMotionCard({ writing: 'remotion' }), false);
  assert.equal(isMotionCard({ capabilities: { writing: 'motion' } }), true);
  assert.equal(isMotionCard({ capabilities: { writing: 'remotion' } }), false);

  // frameMode 声明
  assert.equal(isMotionCard({ frameMode: 'stateful' }), true);
  assert.equal(isMotionCard({ frameMode: 'direct' }), false);

  // 页面端实现对拍
  assert.equal(isMotionCardPage({ cardId: 'focus-card' }), true);
  assert.equal(isMotionCardPage({ cardId: 'caption-track' }), false);
  assert.equal(isMotionCardPage({ writing: 'motion' }), true);
  assert.equal(isMotionCardPage({ writing: 'remotion' }), false);
  assert.equal(isMotionCardPage({ frameMode: 'stateful' }), true);
  assert.equal(isMotionCardPage({ frameMode: 'direct' }), false);
});

/* ------------------------------------------------------------------ 2. 分段切块大小 */

test('MP-02 切分流任务：motion 卡至少 30 秒（60段），短于 30s 仅 1 个任务；remotion 保持 8 段；sparse 整卡 1 任务', () => {
  const baseTask = {
    id: 'plan-1', kind: 'plan', resultKey: `${PROJECT}@1`, range: null,
    source: { projectId: PROJECT, projectRev: 1 }, input: {}, weight: { class: 'medium' }, requires: {}, priority: 1,
  };

  // (a) Motion 卡：10 段（150 帧，5 秒，< 30 秒） -> 仅 1 个任务 [0, 9]
  const motionShortStreams = [{
    streamKey: 'stream-motion-short', topClipId: 'c-m1', firstSegment: 0, lastSegment: 9, fps: 30,
    cardId: 'focus-card',
  }];
  const tasksMotionShort = splitPlan({
    planTask: baseTask, streams: motionShortStreams, envFingerprint: FP_PC, codeVersion: CV,
  }).filter(t => t.kind === 'stream');
  assert.equal(tasksMotionShort.length, 1, '短于 30 秒的 motion 卡只切 1 个任务');
  assert.deepEqual([tasksMotionShort[0].range.from, tasksMotionShort[0].range.to], [0, 9]);

  // (b) Motion 卡：75 段（> 30 秒 / 60 段） -> 切成 2 个任务：[0, 59] 和 [60, 74]
  const motionLongStreams = [{
    streamKey: 'stream-motion-long', topClipId: 'c-m2', firstSegment: 0, lastSegment: 74, fps: 30,
    cardId: 'focus-card',
  }];
  const tasksMotionLong = splitPlan({
    planTask: baseTask, streams: motionLongStreams, envFingerprint: FP_PC, codeVersion: CV,
  }).filter(t => t.kind === 'stream');
  assert.equal(tasksMotionLong.length, 2, '超过 30 秒的 motion 卡每 60 段一份');
  assert.deepEqual([tasksMotionLong[0].range.from, tasksMotionLong[0].range.to], [0, 59]);
  assert.deepEqual([tasksMotionLong[1].range.from, tasksMotionLong[1].range.to], [60, 74]);

  // (c) Remotion 卡：10 段 -> 仍按 8 段切分：[0, 7] 和 [8, 9]
  const remotionStreams = [{
    streamKey: 'stream-remotion', topClipId: 'c-r1', firstSegment: 0, lastSegment: 9, fps: 30,
    cardId: 'caption-track',
  }];
  const tasksRemotion = splitPlan({
    planTask: baseTask, streams: remotionStreams, envFingerprint: FP_PC, codeVersion: CV,
  }).filter(t => t.kind === 'stream');
  assert.equal(tasksRemotion.length, 2, 'remotion 卡保持 8 段切分');
  assert.deepEqual([tasksRemotion[0].range.from, tasksRemotion[0].range.to], [0, 7]);
  assert.deepEqual([tasksRemotion[1].range.from, tasksRemotion[1].range.to], [8, 9]);

  // (d) 稀疏流任务（sparse）：整张卡 1 个任务
  const sparseStreams = [{
    streamKey: 'stream-sparse', topClipId: 'c-sp', firstSegment: 0, lastSegment: 74, fps: 30,
    cardId: 'focus-card',
  }];
  const tasksSparse = splitPlan({
    planTask: baseTask, streams: sparseStreams, envFingerprint: FP_PC, codeVersion: CV, sparseStreams: true,
  }).filter(t => t.kind === 'stream' && t.id.endsWith(':sparse'));
  assert.equal(tasksSparse.length, 1, '稀疏流任务整张卡仅 1 个任务');
  assert.deepEqual([tasksSparse[0].range.from, tasksSparse[0].range.to], [0, 74]);
});

/* ------------------------------------------------------------------ 3. 设备等级判定 */

test('MP-03 deviceRank：桌面版 (3) > 托管方渲染服务且带 streams (2) > 浏览器 / 不带 streams (1)', () => {
  assert.equal(deviceRank({ profile: 'pc' }), 3);
  assert.equal(deviceRank({ profile: 'host', capabilities: { streams: true } }), 2);
  assert.equal(deviceRank({ profile: 'host', capabilities: { streams: false } }), 1);
  assert.equal(deviceRank({ profile: 'host' }), 1);
  assert.equal(deviceRank({ profile: 'browser' }), 1);
  assert.equal(deviceRank(null), 0);
});

/* ------------------------------------------------------------------ 4. 队列跨层抢占机制 */

function setupQueueEnv(startAt = T0) {
  const clock = createFakeClock(startAt);
  const collector = createMessageCollector();
  const q = createRenderQueue({ now: clock.now, send: collector.send });
  const mod = renderQueueModule(q);
  const ctx = {
    now: clock.now,
    send: (connId, msg) => collector.send(connId, msg),
    log: () => {},
    publish: (ch, msg, opts) => {},
    subscribe: () => {},
    unsubscribe: () => {},
  };
  return { clock, collector, q, mod, ctx };
}

function publishStreamTask(env, pubConnId, taskId, { priority = 10, fps = 30, userId = 'u1' } = {}) {
  const parts = taskId.split(':');
  const resultKey = parts[1];
  const [from, to] = parts[2].split('-').map(Number);
  const sparse = parts[3] === 'sparse';
  const range = { unit: 'segment', from, to };
  const input = { clipId: 'clip-1', contentKey: 'ck-1', ...(sparse ? { density: 'sparse' } : {}) };
  const task = {
    id: taskId, kind: 'stream', resultKey, range,
    source: { projectId: PROJECT, projectRev: 1 }, input,
    weight: { class: 'medium', estMs: null, frames: (to - from + 1) * 15 }, requires: {}, priority,
  };
  env.mod.connect(env.ctx, pubConnId, { scope: 'local', userId });
  env.mod.handle(env.ctx, pubConnId, { type: 'publisher.hello', publisherId: 'pub-1' });
  env.mod.handle(env.ctx, pubConnId, { type: 'task.publish', tasks: [task] });
  return task;
}

test('MP-04 跨层抢占：PC (rank 3) 抢占浏览器 (rank 1) 执行中的 stream 任务', () => {
  const env = setupQueueEnv();
  const taskId = 'stream:rk-test:0-9';
  publishStreamTask(env, 'pub-1', taskId);

  // 1. 浏览器连接并认领任务
  const browserConn = 'conn-browser';
  env.mod.connect(env.ctx, browserConn, { role: 'render', userId: 'u1' });
  env.mod.handle(env.ctx, browserConn, {
    type: 'node.hello', nodeId: 'node-browser', profile: 'browser',
    environment: { platform: 'Win32', userAgent: 'Chrome/120.0.0.0', renderer: 'WebGL', vendor: 'Google' },
  });
  env.mod.handle(env.ctx, browserConn, { type: 'queue.watch', projects: [PROJECT] });
  env.mod.handle(env.ctx, browserConn, { type: 'task.claim', id: taskId, expectVersion: 1 });

  const bClaimed = env.collector.of(browserConn, 'task.claimed');
  assert.equal(bClaimed.length, 1);
  const browserToken = bClaimed[0].token;
  assert.ok(browserToken);

  // 2. PC 连接
  const pcConn = 'conn-pc';
  env.mod.connect(env.ctx, pcConn, { role: 'render', userId: 'u1' });
  env.mod.handle(env.ctx, pcConn, {
    type: 'node.hello', nodeId: 'node-pc', profile: 'pc', envFingerprint: FP_PC,
  });
  env.mod.handle(env.ctx, pcConn, { type: 'queue.watch', projects: 'all' });

  // 3. PC 发起抢占认领
  env.mod.handle(env.ctx, pcConn, { type: 'task.claim', id: taskId, expectVersion: 1 });

  // 4. 断言：浏览器收到 task.lease-lost 且 reason 为 preempted
  const lost = env.collector.of(browserConn, 'task.lease-lost');
  assert.equal(lost.length, 1, '浏览器应收到 1 条 lease-lost');
  assert.equal(lost[0].id, taskId);
  assert.equal(lost[0].reason, 'preempted');
  assert.equal(lost[0].token, browserToken);

  // 5. 断言：PC 成功获得该任务（收到 task.claimed）
  const pcClaimed = env.collector.of(pcConn, 'task.claimed');
  assert.equal(pcClaimed.length, 1, 'PC 应成功认领被抢占的任务');
  assert.equal(pcClaimed[0].id, taskId);
});

test('MP-05 跨层抢占：Host (rank 2) 抢占浏览器 (rank 1)；但同层浏览器之间不可相互抢占', () => {
  const env = setupQueueEnv();
  const taskId = 'stream:rk-test2:0-9';
  publishStreamTask(env, 'pub-1', taskId);

  // 1. 浏览器 A 认领
  const b1Conn = 'conn-b1';
  env.mod.connect(env.ctx, b1Conn, { role: 'render', userId: 'u1' });
  env.mod.handle(env.ctx, b1Conn, {
    type: 'node.hello', nodeId: 'node-b1', profile: 'browser',
    environment: { platform: 'Win32', userAgent: 'Chrome/120.0.0.0', renderer: 'WebGL', vendor: 'Google' },
  });
  env.mod.handle(env.ctx, b1Conn, { type: 'task.claim', id: taskId, expectVersion: 1 });
  assert.equal(env.collector.of(b1Conn, 'task.claimed').length, 1);

  // 2. 浏览器 B 尝试抢占浏览器 A -> 失败（返回 taken）
  const b2Conn = 'conn-b2';
  env.mod.connect(env.ctx, b2Conn, { role: 'render', userId: 'u1' });
  env.mod.handle(env.ctx, b2Conn, {
    type: 'node.hello', nodeId: 'node-b2', profile: 'browser',
    environment: { platform: 'Win32', userAgent: 'Chrome/120.0.0.0', renderer: 'WebGL', vendor: 'Google' },
  });
  env.mod.handle(env.ctx, b2Conn, { type: 'task.claim', id: taskId, expectVersion: 1 });
  const b2Rejected = env.collector.of(b2Conn, 'task.claim-rejected');
  assert.equal(b2Rejected.length, 1);
  assert.equal(b2Rejected[0].reason, 'taken');
  assert.equal(env.collector.of(b1Conn, 'task.lease-lost').length, 0, '浏览器 A 租约未丢失');

  // 3. 带 streams 能力的 Host (rank 2) 抢占浏览器 A -> 成功
  const hostConn = 'conn-host';
  env.mod.connect(env.ctx, hostConn, { role: 'render', userId: 'u1' });
  env.mod.handle(env.ctx, hostConn, {
    type: 'node.hello', nodeId: 'node-host', profile: 'host', envFingerprint: FP_HOST,
    capabilities: { streams: true },
  });
  env.mod.handle(env.ctx, hostConn, { type: 'task.claim', id: taskId, expectVersion: 1 });

  // 浏览器 A 收到 lease-lost preempted
  const lost = env.collector.of(b1Conn, 'task.lease-lost');
  assert.equal(lost.length, 1);
  assert.equal(lost[0].reason, 'preempted');

  // Host 认领成功
  const hostClaimed = env.collector.of(hostConn, 'task.claimed');
  assert.equal(hostClaimed.length, 1);
  assert.equal(hostClaimed[0].id, taskId);
});

test('MP-06 非 stream 任务（快照与计划）不被抢占', () => {
  const env = setupQueueEnv();
  const snapId = 'snapshot:rk-snap:0-59';
  const task = {
    id: snapId, kind: 'snapshot', tier: 'shared', resultKey: 'rk-snap', range: { unit: 'localFrame', from: 0, to: 59 },
    source: { projectId: PROJECT, projectRev: 1 }, input: { clipId: 'c1' },
    weight: { class: 'medium' }, requires: {}, priority: 10,
  };
  env.mod.connect(env.ctx, 'pub-1', { scope: 'local', userId: 'u1' });
  env.mod.handle(env.ctx, 'pub-1', { type: 'publisher.hello', publisherId: 'pub-1' });
  env.mod.handle(env.ctx, 'pub-1', { type: 'task.publish', tasks: [task] });

  // 浏览器认领快照
  const bConn = 'conn-b';
  env.mod.connect(env.ctx, bConn, { role: 'render', userId: 'u1' });
  env.mod.handle(env.ctx, bConn, {
    type: 'node.hello', nodeId: 'node-b', profile: 'browser',
    environment: { platform: 'Win32', userAgent: 'Chrome/120.0.0.0', renderer: 'WebGL', vendor: 'Google' },
  });
  env.mod.handle(env.ctx, bConn, { type: 'task.claim', id: snapId, expectVersion: 1 });
  assert.equal(env.collector.of(bConn, 'task.claimed').length, 1);

  // PC 尝试抢占 -> 拒绝（taken）
  const pcConn = 'conn-pc';
  env.mod.connect(env.ctx, pcConn, { role: 'render', userId: 'u1' });
  env.mod.handle(env.ctx, pcConn, { type: 'node.hello', nodeId: 'node-pc', profile: 'pc' });
  env.mod.handle(env.ctx, pcConn, { type: 'task.claim', id: snapId, expectVersion: 1 });

  const rejected = env.collector.of(pcConn, 'task.claim-rejected');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason, 'taken');
  assert.equal(env.collector.of(bConn, 'task.lease-lost').length, 0);
});

/* ------------------------------------------------------------------ 5. 会话状态机：无 open 任务时抢占候选选择 */

test('MP-07 节点会话：无 open 候选时，PC 自动发起对弱设备 stream 任务的抢占，且优先抢占稀疏流', () => {
  const sent = [];
  const clock = createFakeClock();
  const session = createNodeSession({
    nodeId: 'pc-1',
    node: { profile: 'pc', envFingerprint: FP_PC, capabilities: { streams: true } },
    send: msg => sent.push(msg),
    now: clock.now,
  });
  session.start();
  sent.length = 0;

  // 收到快照，没有 open 任务，但有弱设备（browser）持有的两条 stream 任务（一条满密度，一条 sparse）
  session.receive({
    type: 'queue.snapshot',
    tasks: [],
    claimedStreams: [
      { id: 'stream:rk-dense:0-59', version: 2, holderProfile: 'browser', holderRank: 1, density: null },
      { id: 'stream:rk-sparse:0-59:sparse', version: 2, holderProfile: 'browser', holderRank: 1, density: 'sparse' },
    ],
  });

  // tick 触发认领
  session.tick();

  // 断言：发送了 task.claim，且优先抢占 sparse 任务
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'task.claim');
  assert.equal(sent[0].id, 'stream:rk-sparse:0-59:sparse', 'sparse 流任务优先被抢占');
  assert.equal(sent[0].expectVersion, 2);
});

/* ------------------------------------------------------------------ 6. 穿梭/拖动保活 (Scrubbing Keepalive) */

test('MP-08 拖动/穿梭保活：浏览器报 node.active (busy: scrub) 刷新租约与停滞计时，免于超时并防同层抢占', () => {
  const env = setupQueueEnv();
  const taskId = 'stream:rk-scrub:0-9';
  publishStreamTask(env, 'pub-1', taskId);

  // 浏览器认领
  const bConn = 'conn-b';
  env.mod.connect(env.ctx, bConn, { role: 'render', userId: 'u1' });
  env.mod.handle(env.ctx, bConn, {
    type: 'node.hello', nodeId: 'node-b', profile: 'browser',
    environment: { platform: 'Win32', userAgent: 'Chrome/120.0.0.0', renderer: 'WebGL', vendor: 'Google' },
  });
  env.mod.handle(env.ctx, bConn, { type: 'task.claim', id: taskId, expectVersion: 1 });
  assert.equal(env.collector.of(bConn, 'task.claimed').length, 1);

  // 时间推进 25 秒（未超 LEASE_MS 30s，但若不刷新即将过期）
  env.clock.advance(25_000);

  // 用户正在穿梭拖动，浏览器报 node.active { busy: 'scrub' }
  env.mod.handle(env.ctx, bConn, { type: 'node.active', busy: 'scrub' });

  // 时间再推进 10 秒（累计 35 秒，超过原先 30 秒的 leaseUntil）
  env.clock.advance(10_000);

  // 触发队列 tick 扫描
  env.mod.tick(env.ctx);

  // 校验任务状态：未被 lease-expired 回收，仍处于 claimed
  const d = env.q.describe();
  const task = d.tasks.find(t => t.id === taskId);
  assert.equal(task.state, 'claimed', '因 scrub 保活，任务未超时回收');
  assert.equal(task.claim.nodeId, 'node-b');

  // 同层浏览器尝试认领 -> 依旧被拒（taken）
  const b2Conn = 'conn-b2';
  env.mod.connect(env.ctx, b2Conn, { role: 'render', userId: 'u1' });
  env.mod.handle(env.ctx, b2Conn, {
    type: 'node.hello', nodeId: 'node-b2', profile: 'browser',
    environment: { platform: 'Win32', userAgent: 'Chrome/120.0.0.0', renderer: 'WebGL', vendor: 'Google' },
  });
  env.mod.handle(env.ctx, b2Conn, { type: 'task.claim', id: taskId, expectVersion: 1 });
  assert.equal(env.collector.of(b2Conn, 'task.claim-rejected').length, 1);

  // 但更强设备（PC）仍可跨层抢占
  const pcConn = 'conn-pc';
  env.mod.connect(env.ctx, pcConn, { role: 'render', userId: 'u1' });
  env.mod.handle(env.ctx, pcConn, { type: 'node.hello', nodeId: 'node-pc', profile: 'pc' });
  env.mod.handle(env.ctx, pcConn, { type: 'task.claim', id: taskId, expectVersion: task.version });

  assert.equal(env.collector.of(bConn, 'task.lease-lost').length, 1);
  assert.equal(env.collector.of(bConn, 'task.lease-lost')[0].reason, 'preempted');
  assert.equal(env.collector.of(pcConn, 'task.claimed').length, 1);
});

test('MP-09 被抢占的浏览器节点：收到 task.lease-lost (preempted) 立即中止 runController 并停工', async () => {
  const { createBrowserNode } = await import('../../src/online/browserNode.ts');
  const flush = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
  const sent = [];
  const jobs = [];
  const taskId = 'stream:rk-preempt-b:0-7';
  const task = {
    id: taskId, kind: 'stream', resultKey: 'rk-preempt-b', range: { unit: 'segment', from: 0, to: 7 },
    source: { projectId: PROJECT, projectRev: 1, userId: 'u1' },
    input: {
      clipId: 'clip-1', cardId: 'focus-card', contentKey: 'ck-1', compositing: 'independent',
      bake: { start: 0, end: 4, count: 120, sampling: { firstFrame: 0, phase: { numerator: 0, denominator: 1 } } },
      stream: { kind: 'card', plane: 'local', clipIds: ['clip-1'], fps: 30, bound: { x: 0, y: 0, w: 100, h: 100 }, offset: { x: 0, y: 0 }, firstFrame: 0, count: 120, total: 120, originFrame: 0, lastFrame: 119 },
    },
    weight: { class: 'medium', estMs: null, frames: 120 }, requires: { capabilities: { streams: true } }, priority: 10,
  };

  const node = createBrowserNode({
    nodeId: 'browser-test',
    projectId: PROJECT,
    userId: 'u1',
    codeVersion: CV,
    environment: { platform: 'Win32', userAgent: 'Chrome/120.0.0.0', renderer: 'WebGL', vendor: 'Google' },
    now: () => 1000,
    isIdle: () => true,
    send: msg => { sent.push(msg); return true; },
    keptProject: () => ({ id: PROJECT }),
    fetchSnapshot: async () => ({ id: PROJECT }),
    bakeFrame: async () => {},
    finishTask: async () => {},
    streams: () => true,
    bakeStream: async (job) => new Promise((resolve, reject) => jobs.push({ job, resolve, reject })),
    finishStream: async () => ({}),
  });

  node.start();
  // 模拟文档服务报到成功
  node.receive({ type: 'node.welcome', nodeId: 'browser-test', envFingerprint: FP_BROWSER, resumed: [], lost: [] });
  // 模拟认领任务
  node.receive({ type: 'task.claimed', id: taskId, token: 11, task });
  await flush();

  // 校验任务已交给 bakeStream 开始执行
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].job.signal.aborted, false, '开工时 signal 未中止');

  // 模拟收到抢占导致的 lease-lost
  node.receive({ type: 'task.lease-lost', id: taskId, token: 11, reason: 'preempted' });
  await flush();

  // 断言：执行器立即中止（signal.aborted 为 true）
  assert.equal(jobs[0].job.signal.aborted, true, '被抢占后 signal 立即中止');
  assert.equal(node.debug().counters.lost, 1, 'lost 计数加 1');

  // 即使 bakeStream 随后迟到返回，也不再发 task.complete
  jobs[0].resolve({ manifest: { header: {}, segments: {} } });
  await flush();
  assert.equal(sent.filter(m => m.type === 'task.complete').length, 0, '迟到的产出被丢弃，不发 task.complete');
});
