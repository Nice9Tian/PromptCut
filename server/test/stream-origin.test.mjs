/**
 * 轨道流的分段从这条流自己的第一帧起数(`src/render/streamSegments.mjs`;`docs/plan/html-snapshot-removal-dryrun.md` 第 10.5 节)
 * 在产流一侧的单测:计划 → 切分 → 执行器 → `StreamProducer.runSegment` → 清单,一路核对「第 n 段盖住项目的哪几帧」。
 * 跑:npm test -- server/test/stream-origin.test.mjs
 *
 * 片段都**不从 15 的倍数帧开始**,有的时长也不是 15 的倍数。三种流各一条:单卡流、组流(解码器预算压到 1)、
 * 依赖下层的流(产品里缺省开着;前两种的用例把 `PROMPTCUT_TEST_BELOW_STREAMS` 设成 0 关掉它,只看自己那一种)。不用 Chrome、不用 ffmpeg:假的预渲染间 / `bakeStream` / 编码器同
 * `stream-noreplay.test.mjs`,假 `bakeStream` 把每一趟要出的帧区间记下来,编码器把喂进来的每一帧记进分段的字节里。
 * 真的画面(逐帧比像素)由探针 `scripts/probes/stream-origin-probe.mjs` 核对。
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';

/** 一张真的 PNG(4×4,中间 2×2 不透明):稀疏那一趟要从截图里量实体框,假截图也得读得懂。每一帧在它后面缀上 `<<f帧号>>` */
const SHOT = (() => {
  const png = new PNG({ width: 4, height: 4 });
  for (const [x, y] of [[1, 1], [2, 1], [1, 2], [2, 2]]) png.data.fill(255, (y * 4 + x) * 4, (y * 4 + x) * 4 + 4);
  return PNG.sync.write(png);
})();
const shotOf = (frame) => Buffer.concat([SHOT, Buffer.from(`<<f${frame}>>`)]);

let scene = null;
const bakes = [];

function fakeBakery() {
  const bakery = {
    closed: false,
    page: { setViewport: async () => {}, evaluate: async () => structuredClone(scene.browserPlan) },
    client: { send: async () => {} },
    loadProject: async () => {},
    reset: async () => { bakery.page = { ...bakery.page }; },
    close: async () => { bakery.closed = true; },
  };
  return bakery;
}

mock.module(new URL('../bakery/index.mjs', import.meta.url).href, {
  exports: {
    openBakery: async () => fakeBakery(),
    findFfmpeg: async () => 'ffmpeg-fake',
    streamPngVideo: () => { throw new Error('单测不编码 MOV'); },
    bakeFrames: async () => { throw new Error('这个测试不渲快照'); },
  },
});

mock.module(new URL('../bakery/bake.mjs', import.meta.url).href, {
  exports: {
    bakeFrames: async () => { throw new Error('这个测试不渲快照'); },
    dirtyStreamLease: (bakery) => { if (bakery?.streamLease) bakery.streamLease.dirty = true; },
    // 照真的 `bakeStream`:从 `fromFrame` 起每 `stride` 帧截一张(相对 `fromFrame` 数),逐张交给 `onFrame`
    bakeStream: async (bakery, opts) => {
      const { streamSignature, fromFrame, toFrame, signal } = opts;
      const stride = Math.max(1, Math.round(Number(opts.stride) || 1));
      const lease = bakery.streamLease;
      const continues = !!lease && !lease.dirty && lease.page === bakery.page && lease.streamSignature === streamSignature && fromFrame === lease.lastFrame + 1;
      const shots = [];
      for (let frame = fromFrame; frame <= toFrame; frame += stride) {
        if (signal?.aborted) throw Object.assign(new Error('已取消'), { cancelled: true });
        shots.push(frame);
        await opts.onFrame?.(frame, shotOf(frame));
      }
      bakes.push({ streamSignature, fromFrame, toFrame, stride, continues, shots });
      bakery.streamLease = { streamSignature, lastFrame: toFrame, lastShot: toFrame, dirty: false, page: bakery.page };
      return { reset: !continues, replayed: 0, captured: shots.length, captureMs: shots.length, stepMs: 0 };
    },
  },
});

const realFfmpeg = await import('../bakery/ffmpeg.mjs');
const box = (type, payload = Buffer.alloc(0)) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, payload]);
};
/** 结构合法的一段 fMP4;`mdat` 里是喂进编码器的每一帧(假截图,末尾缀着 `<<f帧号>>`;稀疏的分段里同一帧连着写几遍) */
function fakeFmp4(written, encoder) {
  const ftyp = box('ftyp', Buffer.from('isom\0\0\0\0isomavc1', 'latin1'));
  const moov = box('moov', box('udta', Buffer.from(`enc:${encoder}`, 'latin1')));
  const tfhd = Buffer.alloc(8); tfhd.writeUInt32BE(0, 0); tfhd.writeUInt32BE(1, 4);
  const trun = Buffer.alloc(12); trun.writeUInt32BE(0x000004, 0); trun.writeUInt32BE(written.length, 4); trun.writeUInt32BE(0x02000000, 8);
  const moof = box('moof', box('traf', Buffer.concat([box('tfhd', tfhd), box('trun', trun)])));
  const mdat = box('mdat', Buffer.concat(written));
  return Buffer.concat([ftyp, moov, moof, mdat]);
}
mock.module(new URL('../bakery/ffmpeg.mjs', import.meta.url).href, {
  exports: {
    ...realFfmpeg,
    findFfmpeg: async () => 'ffmpeg-fake',
    pickStreamEncoder: async () => ({ encoder: 'libx264', results: [] }),
    openStreamSegmentEncoder: (ffmpeg, { encoder = 'libx264' }) => {
      const written = [];
      return {
        write: async (png) => { written.push(Buffer.from(png)); },
        finish: async () => ({ bytes: fakeFmp4(written, encoder), encodeMs: 1, tailMs: 0 }),
        abort: async () => {},
      };
    },
  },
});

const { FramePipeline } = await import('../frame-pipeline.mjs');
const { describeEnvironment } = await import('../render-node/fingerprint.mjs');
const { planTaskOf, splitPlan } = await import('../render-node/split.mjs');
const { createPrerenderExecutor } = await import('../prerender-executor.mjs');
const { SPARSE_STRIDE, publicManifest } = await import('../frame-stream.mjs');
const { layerStreamsOf } = await import('../artifact-transfer.mjs');
const { streamSegmentFirstFrame, streamSegmentLastFrame, streamSegmentOf } = await import('../../src/render/streamSegments.mjs');

const FPS = 30;
const OWN_ENV = describeEnvironment({
  platform: 'win32',
  renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
  vendor: 'Google Inc. (Google)', chromeVersion: 'HeadlessChrome/138.0.7204.49',
});
const OWN = OWN_ENV.fingerprint;
const PID = 'stream-origin';
const REV = 5;

/**
 * 从上到下四条序列(8 秒,240 帧)。入点都按帧给,没有一个是 15 的倍数:
 *   clip-top  独立卡,第 0～239 帧            —— 盖在最上面,整段都在
 *   clip-g    毛玻璃(依赖下层),第 55～99 帧   —— 45 帧
 *   clip-a    独立卡,第 100～149 帧          —— 50 帧,时长不是 15 的倍数(末段 5 帧)
 *   clip-b    独立卡,第 40～129 帧           —— 90 帧
 */
const FRAMES = { 'clip-top': [0, 239], 'clip-g': [55, 99], 'clip-a': [100, 149], 'clip-b': [40, 129] };
const CLIPS = Object.keys(FRAMES);
/**
 * 入点、出点按秒写,落在两帧之间(第一帧是入点之后的第一个整帧,采样相位不为 0):帧号除以 30 多数不是有限小数,
 * 直接拿 `帧号 / 30` 当秒数,第一帧会因为浮点误差多出一帧。下面每一对换成帧就是上面 `FRAMES` 那一行。
 */
const START = { 'clip-top': 0, 'clip-g': 1.82, 'clip-a': 3.32, 'clip-b': 1.32 };
const END = { 'clip-top': 8, 'clip-g': 3.32, 'clip-a': 4.99, 'clip-b': 4.32 };
const CARD = { 'clip-top': 'demo-top', 'clip-g': 'glass', 'clip-a': 'demo-a', 'clip-b': 'demo-b' };
const CAPS = {
  'clip-top': { compositing: 'independent', frameMode: 'stateful' },
  'clip-g': { compositing: 'belowDependent', frameMode: 'stateful' },
  'clip-a': { compositing: 'independent', frameMode: 'stateful' },
  'clip-b': { compositing: 'independent', frameMode: 'stateful' },
};
function projectJson() {
  return {
    id: PID, fps: FPS, width: 320, height: 180, duration: 8, style: {}, media: [],
    tracks: CLIPS.map((clipId, i) => ({ id: `t${i + 1}`, clips: [{ id: clipId, cardId: CARD[clipId], start: START[clipId], end: END[clipId] }] })),
  };
}
scene = {
  browserPlan: {
    graph: {
      definitions: [],
      nodes: CLIPS.map((clipId) => ({ id: `n:${clipId}`, adapter: 'chrome', cardId: CARD[clipId], capabilities: { ...CAPS[clipId] }, inputs: {} })),
      outputs: CLIPS.map((clipId) => ({ nodeId: `n:${clipId}`, clipId, start: START[clipId], end: END[clipId], opacity: 1 })),
    },
    sourceVersions: { 'demo-top': 'builtin:1', glass: 'builtin:2', 'demo-a': 'builtin:3', 'demo-b': 'builtin:4' },
    environment: { width: 320, height: 180, fps: FPS },
  },
};

const roots = [];
const pipes = [];
async function cleanup() {
  await Promise.allSettled(pipes.splice(0).map((p) => p.close()));
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));
}
async function streamPipeline({ budget = null } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-stream-origin-'));
  roots.push(root);
  const saved = process.env.PROMPTCUT_STREAMS;
  delete process.env.PROMPTCUT_STREAMS;
  let pipeline;
  try {
    pipeline = new FramePipeline({ root, origin: () => 'http://127.0.0.1:1', environment: OWN_ENV, dataRoot: root, interactive: true });
    pipes.push(pipeline);
    // 这几张卡声明上不一定判重;这里都钉成要产流的
    pipeline.streamPicked = () => true;
    const producer = pipeline.streamProducer();
    producer.encoderName = 'libx264';
    producer.ffmpeg = 'ffmpeg-fake';
    if (budget !== null) producer.budget = budget;
    producer.attachRoute();
  } finally {
    if (saved !== undefined) process.env.PROMPTCUT_STREAMS = saved;
  }
  return pipeline;
}
const executorFor = (pipeline) => createPrerenderExecutor({
  pipeline, projects: { get: async (projectId, projectRev) => (projectId === PID && projectRev === REV ? projectJson() : null) },
  prepareProject: (json) => structuredClone(json),
});
const view = (task) => ({ ...structuredClone(task), state: 'claimed', version: 1, attempts: 1 });
const signalNone = () => new AbortController().signal;
async function withBelow(on, fn) {
  const saved = process.env.PROMPTCUT_TEST_BELOW_STREAMS;
  process.env.PROMPTCUT_TEST_BELOW_STREAMS = on ? '1' : '0';
  try { return await fn(); } finally {
    if (saved === undefined) delete process.env.PROMPTCUT_TEST_BELOW_STREAMS; else process.env.PROMPTCUT_TEST_BELOW_STREAMS = saved;
  }
}
const manifestOf = async (pipeline, key) => JSON.parse(await fs.readFile(path.join(pipeline.root, 'streams', key, 'stream.json'), 'utf8'));
/** 分段文件的 `mdat` 里记着喂进编码器的每一帧 → 帧号数组 */
async function framesInSegment(pipeline, key, file) {
  const bytes = await fs.readFile(path.join(pipeline.root, 'streams', key, file));
  return [...bytes.toString('latin1').matchAll(/<<f(\d+)>>/g)].map((m) => Number(m[1]));
}

/**
 * 把这条流的全部队列任务做完,逐段核对:假 `bakeStream` 收到的帧区间、落盘分段里的每一帧、清单里的样本数,
 * 都是「从 `origin` 起每 15 帧一段,末段到 `last` 为止」。回清单。
 */
async function produceAndCheck(pipeline, executor, ctx, spec, { origin, last }) {
  const planTask = planTaskOf({ projectId: PID, projectRev: REV });
  const tasks = splitPlan({ ...ctx, planTask, envFingerprint: OWN, codeVersion: 'cv' }).filter((x) => x.kind === 'stream' && x.resultKey === spec.streamKey);
  const lastSegment = Math.floor((last - origin) / 15);
  assert.deepEqual([spec.originFrame, spec.firstFrame, spec.lastFrame, spec.firstSegment, spec.lastSegment], [origin, origin, last, 0, lastSegment], `${spec.kind}:${spec.topClipId} 的计划`);
  assert.equal(tasks[0].range.from, 0, '任务的分段号从 0 起');
  assert.equal(tasks.at(-1).range.to, lastSegment);
  assert.equal(tasks.reduce((n, x) => n + x.weight.frames, 0), last - origin + 1, '任务的帧数加起来正好是这条流的帧数');
  const mark = bakes.length;
  for (const task of tasks) await executor.render(view(task), { signal: signalNone(), progress: () => {} });
  const mine = bakes.slice(mark).filter((b) => b.streamSignature === spec.streamKey);
  const expectRuns = Array.from({ length: lastSegment + 1 }, (_, n) => [origin + n * 15, Math.min(origin + n * 15 + 14, last)]);
  assert.deepEqual(mine.map((b) => [b.fromFrame, b.toFrame]), expectRuns, `${spec.topClipId}:每一趟出的帧区间`);
  assert.ok(mine.every((b) => b.stride === 1));
  const manifest = await manifestOf(pipeline, spec.streamKey);
  assert.equal(manifest.originFrame, origin, '清单记着这条流的第一帧');
  assert.deepEqual(Object.keys(manifest.segments).map(Number).sort((x, y) => x - y), Array.from({ length: lastSegment + 1 }, (_, n) => n));
  let covered = 0;
  for (let n = 0; n <= lastSegment; n++) {
    const [from, to] = expectRuns[n];
    assert.equal(manifest.segments[n].samples, to - from + 1, `分段 ${n} 的样本数`);
    assert.deepEqual(await framesInSegment(pipeline, spec.streamKey, manifest.segments[n].file), Array.from({ length: to - from + 1 }, (_, i) => from + i),
      `分段 ${n} 里是项目的第 ${from}～${to} 帧,一帧不多、一帧不少、顺序不乱`);
    // 同一处换算:这一段的每一帧换回去都是第 n 段
    for (let f = from; f <= to; f++) assert.equal(streamSegmentOf(f, manifest.originFrame), n);
    assert.equal(streamSegmentFirstFrame(n, manifest.originFrame), from);
    assert.equal(streamSegmentLastFrame(n, manifest.originFrame, last), to);
    covered += to - from + 1;
  }
  assert.equal(covered, last - origin + 1);
  assert.equal(publicManifest(manifest).originFrame, origin, '页面读到的清单也带着');
  return manifest;
}

test('SO-01 单卡流:片段从第 100 帧开始、共 50 帧 —— 分段是 100～114、115～129、130～144、145～149;从第 40 帧开始的那条照它自己的第一帧分', { timeout: 60_000 }, async (t) => {
  t.after(cleanup);
  await withBelow(false, async () => {
    const A = await streamPipeline();
    const executor = executorFor(A);
    const ctx = await executor.plan(view(planTaskOf({ projectId: PID, projectRev: REV })), { signal: signalNone() });
    assert.deepEqual(ctx.streams.map((s) => `${s.kind}:${s.topClipId}`).sort(), ['card:clip-a', 'card:clip-b', 'card:clip-top']);
    const specs = await A.queueStreamSpecs([...A.entries.values()][0]);
    const of = (id) => specs.find((s) => s.topClipId === id);
    const a = await produceAndCheck(A, executor, ctx, of('clip-a'), { origin: 100, last: 149 });
    assert.equal(a.segments[3].samples, 5, '末段不满 15 帧');
    await produceAndCheck(A, executor, ctx, of('clip-b'), { origin: 40, last: 129 });
    await produceAndCheck(A, executor, ctx, of('clip-top'), { origin: 0, last: 239 });
    // 生产者交给页面的层(认领表)和诊断口都带着第一帧
    const producer = A.streamProducer();
    assert.deepEqual(producer.claimLayers().map((l) => [l.clipId, l.originFrame]).sort(), [['clip-a', 100], ['clip-b', 40], ['clip-top', 0]]);
    assert.deepEqual(producer.status().streams.map((s) => [s.clipIds[0], s.originFrame, s.firstSegment, s.lastSegment]).sort(),
      [['clip-a', 100, 0, 3], ['clip-b', 40, 0, 5], ['clip-top', 0, 0, 15]]);
    // 层表的那一行:带第一帧,不写 firstSegment
    const entry = [...A.entries.values()][0];
    const rows = layerStreamsOf(entry, A.layerMapStreamOptions(entry));
    assert.deepEqual(rows.map((r) => [r.topClipId, r.originFrame, r.lastSegment, 'firstSegment' in r]).sort(), [['clip-a', 100, 3, false], ['clip-b', 40, 5, false], ['clip-top', 0, 15, false]]);
  });
});

test('SO-02 组流:解码器预算压到 1,clip-b 和 clip-a 并成一条 —— 第一帧是成员里最早的(第 40 帧),末段到最晚的那一帧(第 149 帧)', { timeout: 60_000 }, async (t) => {
  t.after(cleanup);
  await withBelow(false, async () => {
    const A = await streamPipeline({ budget: 1 });
    const executor = executorFor(A);
    const ctx = await executor.plan(view(planTaskOf({ projectId: PID, projectRev: REV })), { signal: signalNone() });
    const specs = await A.queueStreamSpecs([...A.entries.values()][0]);
    const group = specs.find((s) => s.kind === 'group');
    assert.ok(group, `有一条组流(${specs.map((s) => `${s.kind}:${s.clipIds.join('+')}`).join(' ')})`);
    assert.deepEqual([...group.clipIds].sort(), ['clip-a', 'clip-b']);
    // 40～149:110 帧,分段 0～7,末段是第 145～149 帧
    const manifest = await produceAndCheck(A, executor, ctx, group, { origin: 40, last: 149 });
    assert.equal(manifest.kind, 'group');
    assert.equal(manifest.segments[7].samples, 5);
    // 组里各成员自己的第一帧不参与分段:第 100 帧(clip-a 的第一帧)在组流的第 4 段的第 0 个样本
    assert.equal(streamSegmentOf(100, manifest.originFrame), 4);
    assert.equal(streamSegmentFirstFrame(4, manifest.originFrame), 100);
    assert.equal(streamSegmentOf(99, manifest.originFrame), 3);
  });
});

test('SO-03 依赖下层的流(开关打开):第一帧是目标卡的第一帧(第 55 帧),分段是 55～69、70～84、85～99', { timeout: 60_000 }, async (t) => {
  t.after(cleanup);
  await withBelow(true, async () => {
    const A = await streamPipeline();
    const executor = executorFor(A);
    const ctx = await executor.plan(view(planTaskOf({ projectId: PID, projectRev: REV })), { signal: signalNone() });
    const specs = await A.queueStreamSpecs([...A.entries.values()][0]);
    const below = specs.find((s) => s.kind === 'below');
    assert.ok(below, '开关打开以后有这种流');
    assert.equal(below.topClipId, 'clip-g');
    const manifest = await produceAndCheck(A, executor, ctx, below, { origin: 55, last: 99 });
    assert.equal(manifest.kind, 'below');
    // 下层的卡各有各的第一帧(clip-b 从第 40 帧起),这条流照目标卡的算
    assert.deepEqual(below.belowClipIds.includes('clip-b'), true);
  });
});

test('SO-04 稀疏的分段(自动生产那条路,行为照旧):每 3 帧截一张、每张重复写满,都相对分段自己的第一帧数;末段不满时最后一张只重复到流的最后一帧', { timeout: 60_000 }, async (t) => {
  t.after(cleanup);
  await withBelow(false, async () => {
    const A = await streamPipeline();
    const executor = executorFor(A);
    await executor.plan(view(planTaskOf({ projectId: PID, projectRev: REV })), { signal: signalNone() });
    const entry = [...A.entries.values()][0];
    const spec = (await A.queueStreamSpecs(entry)).find((s) => s.topClipId === 'clip-a');
    const producer = A.streamProducer();
    const state = await producer.queueState(entry, spec);
    const bakery = await A.leaseStreamBakery();
    try {
      for (const segment of [0, 3]) {
        const mark = bakes.length;
        const task = { state, segment, stride: SPARSE_STRIDE };
        assert.equal(await producer.runSegment(bakery, task), true);
        await task.job;
        const [run] = bakes.slice(mark);
        const from = 100 + segment * 15, to = Math.min(from + 14, 149);
        assert.deepEqual([run.fromFrame, run.toFrame, run.stride], [from, to, SPARSE_STRIDE]);
        const shots = [];
        for (let f = from; f <= to; f += SPARSE_STRIDE) shots.push(f);
        assert.deepEqual(run.shots, shots, `分段 ${segment} 截的帧`);
        const seg = state.manifest.segments[segment];
        assert.deepEqual([seg.stride, seg.samples], [SPARSE_STRIDE, to - from + 1]);
        // 每一帧位置上放的是不晚于它的最近一张
        const expected = Array.from({ length: to - from + 1 }, (_, i) => from + Math.floor(i / SPARSE_STRIDE) * SPARSE_STRIDE);
        assert.deepEqual(await framesInSegment(A, spec.streamKey, seg.file), expected, `分段 ${segment} 里每个样本是哪一帧的画面`);
        assert.equal(state.measuredSegments.has(segment), true, '量实体框记的是这条流自己的分段号');
      }
      assert.deepEqual([...state.measuredSegments].sort(), [0, 3]);
      // 「接得上租约」按这条流自己的分段边界判:租约停在第 129 帧(第 1 段的最后一帧)时接着做第 2 段(第 130 帧起),
      // 哪怕更靠前的第 1 段还没有;停在第 128 帧(不在分段边界上)就不算接得上,照常从播放头往后找第一个没有的(第 1 段)。
      // 按项目帧号判的话边界在第 134、149 帧,这两种情形分不出来
      delete state.queueOnly;   // 这条流是按队列任务建的;去掉这个标记,自动生产才会挑它
      const leaseAt = (lastFrame) => { bakery.streamLease = { streamSignature: spec.streamKey, lastFrame, dirty: false, page: bakery.page }; return producer.nextTask(bakery); };
      const mine = (task) => (task?.state === state ? task.segment : null);
      assert.equal(mine(leaseAt(129)), 2, '第 129 帧是第 1 段的最后一帧:接着做第 2 段');
      assert.equal(mine(leaseAt(128)), 1, '第 128 帧不在分段边界上:不算接得上');
      assert.equal(mine(leaseAt(134)), 1, '第 134 帧是按项目帧号数的分段边界,不是这条流的');
      assert.equal(mine(leaseAt(149)), 1, '第 149 帧是末段的最后一帧:后面没有分段了,回头补第 1 段');
    } finally { A.returnStreamBakery(bakery); }
  });
});
