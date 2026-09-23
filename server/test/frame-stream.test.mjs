/**
 * R8 轨道流服务端的纯函数单测(`server/frame-stream.mjs`、`frame-playback.mjs` 的排程、
 * `card-identity.mjs` 的流键、`bakery/ffmpeg.mjs` 的命令行)。端到端那一半在
 * `scripts/probes/stream-produce-probe.mjs` / `stream-play-probe.mjs`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import {
  splitFmp4, segmentInfo, initInfo, codecOfAvcC, topLevelBoxes, evenRect, intersectRect, unionRect, padRect,
  groupStreams, peakConcurrency, paintLayers, planStreams, isolatedStreamProject, localPlacement, streamEligible,
  pngAlphaBox, segmentSignature, readySegmentRanges, publicManifest, StreamStore, handleStreamRequest,
  streamsEnabled, streamDecoderBudget, streamPoolLimit, SEGMENT_FRAMES, StreamProducer,
} from '../frame-stream.mjs';
import { planStreamSegments, streamFeasibility, streamFirstMs } from '../frame-playback.mjs';
import { cardStreamIdentity } from '../card-identity.mjs';
import { streamSegmentArgs, streamFilter, STREAM_ENCODERS, STREAM_ENCODER_ORDER, streamEncoderPreference } from '../bakery/ffmpeg.mjs';
import { createReadyIndex } from '../ready-index.mjs';

/* ------------------------------------------------------------ fMP4 合成件 */

const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const box = (type, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'latin1'), body]); };
const full = (version, flags) => u32(((version & 0xff) << 24) | (flags & 0xffffff));

/** 一份最小的 init:ftyp + moov/trak/mdia/(mdhd, minf/stbl/stsd/avc1/avcC) */
function makeInit({ width = 640, height = 736, level = 0x32 } = {}) {
  const avcC = box('avcC', Buffer.from([1, 0x64, 0x00, level, 0xff, 0xe1, 0x00, 0x00, 0x01, 0x00, 0x00]));
  const entry = Buffer.alloc(78);
  entry.writeUInt16BE(1, 6);            // data_reference_index
  entry.writeUInt16BE(width, 24);
  entry.writeUInt16BE(height, 26);
  const avc1 = box('avc1', entry, avcC);
  const stsd = box('stsd', full(0, 0), u32(1), avc1);
  const mdhd = box('mdhd', full(0, 0), u32(0), u32(0), u32(30), u32(0), u32(0));
  const moov = box('moov', box('trak', box('mdia', mdhd, box('minf', box('stbl', stsd)))));
  return Buffer.concat([box('ftyp', Buffer.from('isom'), u32(512)), moov]);
}

/** 一个分段:moof(tfhd 带 default-base-is-moof + 缺省 flags = 非同步样本;trun 带 data_offset + first_sample_flags + 逐样本大小)+ mdat */
function makeSegment(sizes = [10, 4, 4], { firstSync = true } = {}) {
  const tfhd = box('tfhd', full(0, 0x020020), u32(1), u32(0x01010000));
  const trunBody = (dataOffset) => Buffer.concat([full(0, 0x000205), u32(sizes.length), u32(dataOffset), u32(firstSync ? 0x02000000 : 0x01010000), ...sizes.map(u32)]);
  // moof 的尺寸要先算出来才能写 data_offset:两遍
  const probe = box('moof', box('traf', tfhd, box('trun', trunBody(0))));
  const moof = box('moof', box('traf', tfhd, box('trun', trunBody(probe.length + 8))));
  const mdat = box('mdat', Buffer.concat(sizes.map((n, i) => Buffer.alloc(n, i + 1))));
  return Buffer.concat([moof, mdat]);
}

test('splitFmp4: ftyp+moov is the init, each moof+mdat a segment, mfra is dropped', () => {
  const init = makeInit();
  const seg = makeSegment();
  const out = splitFmp4(Buffer.concat([init, seg, box('mfra', Buffer.alloc(8))]));
  assert.deepEqual(out.init, init);
  assert.equal(out.segments.length, 1);
  assert.deepEqual(out.segments[0], seg);
  assert.deepEqual(out.dropped, ['mfra']);
  assert.deepEqual(topLevelBoxes(out.segments[0]).map(b => b.type), ['moof', 'mdat']);
});

test('segmentInfo / initInfo read the sample count, the first-sample sync flag and the codec from avcC', () => {
  const info = segmentInfo(makeSegment([5, 5, 5, 5]));
  assert.deepEqual(info, { moofs: 1, sampleCount: 4, firstSampleIsSync: true });
  assert.equal(segmentInfo(makeSegment([5], { firstSync: false })).firstSampleIsSync, false);
  const meta = initInfo(makeInit({ width: 560, height: 764, level: 0x1f }));
  assert.deepEqual(meta, { codec: 'avc1.64001f', width: 560, height: 764, timescale: 30 });
  // G5:level 随内容变 —— 串一定从 avcC 拼,不写死
  assert.equal(codecOfAvcC(Buffer.from([1, 0x64, 0, 0x33])), 'avc1.640033');
});

/* ------------------------------------------------------------ 矩形 */

test('evenRect rounds out to even width and height inside the limit (yuv420p)', () => {
  const view = { x: 0, y: 0, w: 1920, h: 1080 };
  assert.deepEqual(evenRect({ x: 10.4, y: 3.2, w: 101, h: 51 }, view), { x: 10, y: 3, w: 102, h: 52 });
  // 碰到右 / 下边就往左 / 上扩
  assert.deepEqual(evenRect({ x: 1919, y: 1079, w: 1, h: 1 }, view), { x: 1918, y: 1078, w: 2, h: 2 });
  const r = evenRect({ x: -5, y: -5, w: 3000, h: 3000 }, view);
  assert.deepEqual(r, view);
  for (const v of [r.w, r.h]) assert.equal(v % 2, 0);
});

test('rect helpers', () => {
  assert.deepEqual(intersectRect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }), { x: 5, y: 5, w: 5, h: 5 });
  assert.deepEqual(unionRect(null, { x: 1, y: 2, w: 3, h: 4 }), { x: 1, y: 2, w: 3, h: 4 });
  assert.deepEqual(unionRect({ x: 0, y: 0, w: 2, h: 2 }, { x: 5, y: 5, w: 1, h: 1 }), { x: 0, y: 0, w: 6, h: 6 });
  assert.deepEqual(padRect({ x: 10, y: 10, w: 4, h: 4 }, 2), { x: 8, y: 8, w: 8, h: 8 });
});

test('localPlacement: a small frame is centred in the capture page, the bound leaves room for overflow and is even', () => {
  const stage = { width: 1920, height: 1080 };
  const p = localPlacement({ frame: { x: 0, y: 0, w: 641, h: 361 } }, stage);
  assert.deepEqual(p.box, { w: 641, h: 361 });
  assert.deepEqual(p.offset, { x: 639, y: 359 });
  assert.equal(p.bound.w % 2, 0);
  assert.equal(p.bound.h % 2, 0);
  assert.ok(p.bound.x <= -32 + 1 && p.bound.y <= -32 + 1);
  // 全屏卡(没有框):贴左上角,上界就是整个画面
  const fullStage = localPlacement({}, stage);
  assert.deepEqual(fullStage.offset, { x: 0, y: 0 });
  assert.deepEqual(fullStage.bound, { x: 0, y: 0, w: 1920, h: 1080 });
});

/* ------------------------------------------------------------ 实测实体框 */

function pngOf(width, height, paint) {
  const png = new PNG({ width, height });
  png.data.fill(0);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const a = paint(x, y);
    if (a) { const i = (y * width + x) * 4; png.data[i] = 255; png.data[i + 3] = a; }
  }
  return PNG.sync.write(png, { filterType: -1 });
}

test('pngAlphaBox finds the box of alpha > 0 (faint glow included), null for a fully transparent frame', () => {
  const buf = pngOf(64, 40, (x, y) => (x >= 10 && x < 20 && y >= 5 && y < 8 ? 255 : x === 50 && y === 30 ? 1 : 0));
  assert.deepEqual(pngAlphaBox(buf), { x: 10, y: 5, w: 41, h: 26 });
  assert.equal(pngAlphaBox(pngOf(16, 16, () => 0)), null);
  assert.deepEqual(pngAlphaBox(Buffer.from('not a png')), { full: true });
});

/* ------------------------------------------------------------ 划分 */

const CAPS = { compositing: 'independent', frameMode: 'stateful' };
const control = (clipId, start, end, fps = 30, extra = {}) => ({
  clipId, key: `K-${clipId}`, snapshotKey: `S-${clipId}`, capabilities: CAPS, compositing: 'independent',
  start, end, count: Math.ceil((end - start) * fps), sampling: { firstFrame: Math.ceil(start * fps), fps: { numerator: String(fps), denominator: '1' }, phase: { numerator: '0', denominator: '1' } },
  ...extra,
});

test('streamEligible: only independent cards on visible tracks without a 3-D frame', () => {
  const track = { hidden: false };
  const clip = { id: 'a', cardId: 'x' };
  assert.equal(streamEligible(control('a', 0, 1), clip, track), true);
  assert.equal(streamEligible({ ...control('a', 0, 1), capabilities: { compositing: 'belowDependent' } }, clip, track), false);
  assert.equal(streamEligible({ ...control('a', 0, 1), capabilities: { compositing: 'unknown' } }, clip, track), false);
  assert.equal(streamEligible({ ...control('a', 0, 1), capabilities: { compositing: 'sourceDependent' } }, clip, track), false);
  assert.equal(streamEligible(control('a', 0, 1), clip, { hidden: true }), false);
  assert.equal(streamEligible(control('a', 0, 1), { ...clip, frame: { x: 0, y: 0, rotateY: 20 } }, track), false);
  assert.equal(streamEligible(control('a', 0, 1), { id: 'a', mediaId: 'm' }, track), false);
});

test('peakConcurrency / groupStreams merge only z-adjacent streams, and only while over budget', () => {
  assert.deepEqual(peakConcurrency([{ from: 0, to: 9 }, { from: 5, to: 20 }, { from: 21, to: 30 }]), { peak: 2, at: 5 });
  const layers = [
    { clipId: 'a', order: 1, from: 0, to: 99 },
    { clipId: 'b', order: 2, from: 0, to: 99 },
    { clipId: 'm', order: 3, from: 0, to: 99 }, // 素材层插在 b 和 c 中间
    { clipId: 'c', order: 4, from: 0, to: 99 },
  ];
  const streams = ['a', 'b', 'c'].map((id) => ({ clipIds: [id], order: layers.find(l => l.clipId === id).order, from: 0, to: 99 }));
  assert.equal(groupStreams(streams, layers, 6).length, 3, '没超预算不合并');
  const merged = groupStreams(streams, layers, 2);
  assert.deepEqual(merged.map(s => s.clipIds), [['a', 'b'], ['c']], 'b 和 c 之间隔着素材层,只能合 a+b');
  // 已经合不动(隔着别的层)就停,不死循环
  assert.equal(groupStreams(streams, layers, 1).length, 2);
});

function project(tracks, extra = {}) {
  return { width: 1920, height: 1080, fps: 30, duration: 4, media: [], tracks, ...extra };
}

test('planStreams: one stream per eligible card, global segment numbers, local plane with offset; group when over budget', () => {
  const p = project([
    { id: 't1', clips: [{ id: 'a', cardId: 'x', start: 0.5, end: 2, frame: { x: 0, y: 0, w: 640, h: 360 } }] },
    { id: 't2', clips: [{ id: 'b', cardId: 'y', start: 0, end: 4 }] },
  ]);
  const entry = { key: 'E', project: p, cardPlan: [control('a', 0.5, 2), control('b', 0, 4)] };
  const specs = planStreams(entry, {});
  assert.equal(specs.length, 2);
  const a = specs.find(s => s.clipIds[0] === 'a');
  assert.equal(a.kind, 'card');
  assert.equal(a.plane, 'local');
  assert.equal(a.firstFrame, 15);
  assert.equal(a.firstSegment, 1);
  assert.equal(a.lastSegment, Math.floor(59 / SEGMENT_FRAMES));
  assert.deepEqual(a.offset, { x: 640, y: 360 });
  assert.equal(a.mountFrame, 14, '挂载帧含 LEAD');
  // 预渲染集合之外的卡不产流(pinned 渲染 9)
  assert.equal(planStreams(entry, { picked: id => id === 'b' }).length, 1);
  // 超预算:合成一条组流,舞台坐标,最上面那张在最后
  const grouped = planStreams(entry, { budget: 1 });
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].kind, 'group');
  assert.equal(grouped[0].plane, 'stage');
  assert.deepEqual(grouped[0].clipIds, ['b', 'a'], '画家顺序:t2 在下面,t1 在最上面');
  assert.equal(grouped[0].topClipId, 'a');
  assert.deepEqual(grouped[0].bound, { x: 0, y: 0, w: 1920, h: 1080 });
});

test('stream keys: placement-free for single-card streams, with time placement; group keys use the appearance key', () => {
  const p = project([{ id: 't1', clips: [{ id: 'a', cardId: 'x', start: 0, end: 2 }] }]);
  const key = (ctl, budget = 6) => planStreams({ key: 'E', project: p, cardPlan: [ctl] }, { budget })[0]?.streamKey;
  const base = control('a', 0, 2);
  assert.equal(key(base), key({ ...base, key: 'K-moved-elsewhere' }), '单卡流不看带外观的缓存键(挪位置不作废流)');
  assert.notEqual(key(base), key({ ...base, snapshotKey: 'S-other-params' }), '内容变了就换流键');
  assert.notEqual(key(base), key({ ...base, sampling: { ...base.sampling, firstFrame: 1 } }), '入点挪了一帧就换流键(全局帧号分段)');
  const a = cardStreamIdentity({ kind: 'card', fps: 30, stage: { width: 1920, height: 1080 }, members: [{ key: 'S', sampling: base.sampling, count: 60 }], codeVersion: '1' });
  assert.notEqual(a, cardStreamIdentity({ kind: 'card', fps: 30, stage: { width: 1920, height: 1080 }, members: [{ key: 'S', sampling: base.sampling, count: 60 }], codeVersion: '2' }), '生产代码换了旧流作废');
  assert.notEqual(a, cardStreamIdentity({ kind: 'card', fps: 25, stage: { width: 1920, height: 1080 }, members: [{ key: 'S', sampling: base.sampling, count: 60 }], codeVersion: '1' }), 'fps 进键');
});

test('isolatedStreamProject: only the stream cards paint, other clips stay as hidden sources, time is not shifted; local plane strips the wrapper appearance', () => {
  const p = project([
    { id: 't1', clips: [
      { id: 'a', cardId: 'x', start: 0.5, end: 2, frame: { x: 960, y: 540, w: 640, h: 360, anchor: [0.5, 0.5], scale: 2, rotate: 30 }, motion: { target: 'q' }, opacity: 0.5, fadeIn: 0.2, emphasis: { shadow: 1 } },
      { id: 'sib', cardId: 'z', start: 0, end: 1 },
    ] },
    { id: 't2', clips: [{ id: 'b', cardId: 'y', start: 0, end: 4 }] },
  ]);
  const spec = planStreams({ key: 'E', project: p, cardPlan: [control('a', 0.5, 2)] }, {})[0];
  const iso = isolatedStreamProject(p, spec);
  const visible = iso.tracks.filter(t => !t.hidden);
  assert.equal(visible.length, 1);
  assert.deepEqual(visible[0].clips.map(c => c.id), ['a']);
  const a = visible[0].clips[0];
  assert.equal(a.start, 0.5, '时间不平移');
  assert.deepEqual(a.frame, { x: spec.offset.x, y: spec.offset.y, w: 640, h: 360, anchor: [0, 0] });
  for (const k of ['motion', 'opacity', 'fadeIn', 'fadeOut', 'emphasis']) assert.equal(a[k], undefined, `${k} 不在单卡流里`);
  assert.ok(iso.tracks.some(t => t.hidden && t.sourceOnly && t.clips.some(c => c.id === 'sib')), '同一条序列上的兄弟片段留作隐藏的源');
  assert.ok(iso.tracks.some(t => t.hidden && t.sourceOnly && t.id === 't2'));
  assert.deepEqual(iso._cardRender, { mode: 'final', frames: {}, missing: {} });
  // 组流保留外观
  const group = planStreams({ key: 'E', project: p, cardPlan: [control('a', 0.5, 2), control('b', 0, 4)] }, { budget: 1 })[0];
  const gIso = isolatedStreamProject(p, group);
  assert.equal(gIso.tracks.filter(t => !t.hidden).flatMap(t => t.clips).find(c => c.id === 'a').opacity, 0.5);
});

test('paintLayers orders like FrameScene: the first track is on top', () => {
  const p = project([
    { id: 'top', clips: [{ id: 'a', cardId: 'x', start: 0, end: 1 }] },
    { id: 'mid', clips: [{ id: 'm', mediaId: 'v', start: 0, end: 1 }] },
    { id: 'bottom', clips: [{ id: 'b', cardId: 'y', start: 0, end: 1 }] },
  ], { media: [{ id: 'v', kind: 'video' }] });
  assert.deepEqual(paintLayers(p, 30).map(l => l.clipId), ['b', 'm', 'a']);
});

/* ------------------------------------------------------------ 清单 / 读口 */

test('segmentSignature covers stride, encoder, parameters and rect', () => {
  const base = { streamKey: 'K', segment: 3, stride: 1, encoder: 'libx264', rect: { x: 0, y: 0, w: 2, h: 2 } };
  const sig = segmentSignature(base);
  assert.equal(sig, segmentSignature({ ...base }));
  for (const change of [{ stride: 3 }, { encoder: 'h264_mf' }, { segment: 4 }, { rect: { x: 0, y: 0, w: 4, h: 2 } }]) {
    assert.notEqual(sig, segmentSignature({ ...base, ...change }), JSON.stringify(change));
  }
});

test('readySegmentRanges / publicManifest', () => {
  const manifest = { streamKey: 'K', kind: 'card', plane: 'local', clipIds: ['a'], fps: 30, bound: { x: 0, y: 0, w: 2, h: 2 }, tight: null,
    inits: { i1: { codec: 'avc1.64001f', width: 2, height: 20, rect: { x: 0, y: 0, w: 2, h: 2 }, encoder: 'libx264', bytes: 9 } },
    segments: { 0: { file: '0-a.m4s', init: 'i1', stride: 1, samples: 15, sig: 'x', bytes: 1 }, 1: { file: '1-b.m4s', init: 'i1', stride: 3, samples: 15, sig: 'y', bytes: 1 }, 5: { file: '5-c.m4s', init: 'i1', stride: 1, samples: 15, sig: 'z', bytes: 1 } } };
  assert.deepEqual(readySegmentRanges(manifest), [[0, 1], [5, 5]]);
  const pub = publicManifest(manifest);
  assert.equal(pub.segments[1].sig, undefined, '签名不外露');
  assert.deepEqual(pub.inits.i1, { codec: 'avc1.64001f', width: 2, height: 20, rect: { x: 0, y: 0, w: 2, h: 2 } });
  assert.equal(pub.segmentFrames, 15);
});

test('handleStreamRequest serves the manifest (no-store) and content-addressed files (immutable), rejects anything else', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-stream-test-'));
  try {
    const key = 'a'.repeat(64);
    const store = new StreamStore(root);
    await store.save({ streamKey: key, kind: 'card', plane: 'local', clipIds: ['c'], fps: 30, bound: { x: 0, y: 0, w: 2, h: 2 }, tight: null, inits: {}, segments: { 0: { file: '0-0123456789abcdef.m4s', init: '0123456789abcdef', stride: 1, samples: 15 } } });
    await fs.writeFile(store.initFile(key, '0123456789abcdef'), 'INIT');
    await fs.writeFile(store.segFile(key, '0-0123456789abcdef.m4s'), 'SEG');
    const call = (url) => new Promise((resolve) => {
      const res = { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(body) { resolve({ status: this.statusCode, headers: this.headers, body: String(body ?? '') }); } };
      const handled = handleStreamRequest(store, { method: 'GET' }, res, url);
      if (!handled) resolve(null);
    });
    const manifest = await call(`/stream/${key}/manifest`);
    assert.equal(manifest.status, 200);
    assert.equal(manifest.headers['cache-control'], 'no-store');
    assert.equal(JSON.parse(manifest.body).segments[0].file, '0-0123456789abcdef.m4s');
    const init = await call(`/stream/${key}/init/0123456789abcdef`);
    assert.equal(init.body, 'INIT');
    assert.match(init.headers['cache-control'], /immutable/);
    assert.equal((await call(`/stream/${key}/seg/0-0123456789abcdef.m4s`)).body, 'SEG');
    assert.equal((await call(`/stream/${key}/seg/0-ffffffffffffffff.m4s`)).status, 404);
    assert.equal(await call(`/stream/${key}/seg/../../x`), null);
    assert.equal(await call(`/stream/nothex/manifest`), null);
    // F5:扫盘挂到键上
    const found = await store.scan();
    assert.deepEqual(found.map(f => [f.key, f.ranges]), [[key, [[0, 0]]]]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('StreamProducer.rescan stages stream keys on the ready index (F5); republish sends the stream layer with groupClipIds', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-stream-test-'));
  try {
    const key = 'b'.repeat(64);
    const pipeline = { root, readyIndex: createReadyIndex(), prerenderPicked: () => true, captureCode: () => 'C' };
    const producer = new StreamProducer(pipeline, { env: {} });
    await producer.store.save({ streamKey: key, kind: 'group', plane: 'stage', clipIds: ['x', 'y'], fps: 30, bound: { x: 0, y: 0, w: 2, h: 2 }, tight: null, inits: {}, segments: { 2: { file: '2-0123456789abcdef.m4s', init: 'i', stride: 1, samples: 15 } } });
    producer.store.manifests.clear();
    assert.equal(await producer.rescan(), 1);
    assert.deepEqual(pipeline.readyIndex.stagedKeys(), [{ kind: 'stream', key, ranges: [[2, 2]] }]);
    // 认领(项目到位之后):clipId 反查出来,发全量 layer
    const seen = [];
    pipeline.readyIndex.subscribe(m => seen.push(m));
    pipeline.readyIndex.claim([{ clipId: 'y', kind: 'stream', key }], 1);
    assert.deepEqual(seen.filter(m => m.type === 'layer').at(-1), { type: 'layer', clipId: 'y', kind: 'stream', key, ranges: [[2, 2]] });
    // 生产者手里的流:republish 带 groupClipIds
    producer.streams.set(key, { spec: { streamKey: key, topClipId: 'y', clipIds: ['x', 'y'], kind: 'group' }, manifest: await producer.store.load(key), aliases: new Set() });
    producer.republish();
    assert.deepEqual(seen.at(-1), { type: 'layer', clipId: 'y', kind: 'stream', key, ranges: [[2, 2]], groupClipIds: ['x', 'y'] });
    assert.deepEqual(producer.claimLayers(), [{ clipId: 'y', kind: 'stream', key }]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('switches: streams default on, decoder budget 6, pool 1 (max 2) unless pinned', () => {
  assert.equal(streamsEnabled({}), true);
  assert.equal(streamsEnabled({ PROMPTCUT_STREAMS: '0' }), false);
  assert.equal(streamDecoderBudget({}), 6);
  assert.equal(streamDecoderBudget({ PROMPTCUT_STREAM_DECODERS: '2' }), 2);
  assert.deepEqual(streamPoolLimit({}), { fixed: null });
  assert.deepEqual(streamPoolLimit({ PROMPTCUT_STREAM_POOL: '2' }), { fixed: 2 });
  assert.deepEqual(streamPoolLimit({ PROMPTCUT_STREAM_POOL: '5' }), { fixed: null });
  const producer = new StreamProducer({ root: os.tmpdir(), readyIndex: createReadyIndex() }, { env: {} });
  assert.equal(producer.pool, 1);
  assert.equal(new StreamProducer({ root: os.tmpdir(), readyIndex: createReadyIndex() }, { env: { PROMPTCUT_STREAMS: '0' } }).enabled, false);
});

/* ------------------------------------------------------------ 编码命令行 */

test('segment encoder command line follows G3: premultiplied, out_range=tv, strict GOP, fMP4 to stdout', () => {
  const args = streamSegmentArgs({ encoder: 'libx264', fps: 30 });
  const joined = args.join(' ');
  assert.ok(args.includes('-reinit_filter') && args[args.indexOf('-reinit_filter') + 1] === '0');
  assert.match(joined, /format=gbrap,premultiply=inplace=1,format=rgba/);
  assert.match(joined, /scale=out_range=tv:out_color_matrix=bt709,format=yuv420p/);
  assert.match(joined, /-color_range tv/);
  assert.match(joined, /-c:v libx264 -preset veryfast -crf 16 -g 15 -keyint_min 15 -sc_threshold 0 -bf 0/);
  assert.match(joined, /-video_track_timescale 30/);
  assert.match(joined, /-movflags frag_keyframe\+empty_moov\+default_base_moof -an -f mp4 pipe:1$/);
  // h264_mf 只收 nv12(G0-b (7))
  assert.match(streamFilter(STREAM_ENCODERS.h264_mf.pixFmt), /format=nv12$/);
  assert.deepEqual(STREAM_ENCODER_ORDER, ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264', 'h264_mf']);
  // 缺省只试 libx264(本机硬件编码器都列着跑不了),auto 才按探测顺序
  assert.deepEqual(streamEncoderPreference({}), ['libx264', 'h264_mf']);
  assert.deepEqual(streamEncoderPreference({ PROMPTCUT_STREAM_ENCODER: 'auto' }), STREAM_ENCODER_ORDER);
  assert.throws(() => streamSegmentArgs({ encoder: 'nope', fps: 30 }));
});

/* ------------------------------------------------------------ 排程(G4) */

test('streamFirstMs: only a broken lease pays the reset + fixed cost + replay', () => {
  assert.equal(streamFirstMs({ leaseContinues: true, runStartFrame: 100 }), 0);
  assert.equal(streamFirstMs({ runStartFrame: 30, mountFrame: 10, resetMs: 400, fixedMs: 80, frameMs: 30 }), 400 + 80 + 20 * 30);
});

test('streamFeasibility: raises stride (15 divisors only) before giving up', () => {
  // 30 fps、一个 worker:15 帧的预算是 500 ms;每帧出图 68.9 ms(两个编码器并存)
  const f = streamFeasibility({ n: 4, firstMs: 480, frameMs: 68.9, fps: 30, workers: 1, stride: 1 });
  assert.equal(f.feasible, false);
  assert.equal(f.stride, 3);
  assert.equal(streamFeasibility({ n: 4, frameMs: 20, fps: 30 }).feasible, true);
  assert.equal(streamFeasibility({ n: 1, firstMs: 100000, frameMs: 30, fps: 30 }).stride, null);
});

test('planStreamSegments: continue the lease first, then the nearest unready segment ahead of the playhead, then fill holes', () => {
  const ready = new Set([0, 1, 2]);
  const plan = (o) => planStreamSegments({ fps: 30, firstSegment: 0, lastSegment: 9, ready: n => ready.has(n), ...o });
  // 暂停(rate 0):从播放头所在分段起
  assert.deepEqual(plan({ playheadFrame: 5 * 15, rate: 0 }), { segment: 5, leadSegments: 0, continues: false });
  // 租约接得上就接着做,不为远处断租约
  assert.equal(plan({ playheadFrame: 8 * 15, rate: 0, leaseLastSegment: 3 }).segment, 4);
  assert.equal(plan({ playheadFrame: 8 * 15, rate: 0, leaseLastSegment: 3 }).continues, true);
  // 播放中留提前量
  const playing = plan({ playheadFrame: 3 * 15, rate: 1, frameMs: 30, firstMs: 500 });
  assert.ok(playing.leadSegments >= 1 && playing.segment >= 3 + playing.leadSegments);
  // 后面都齐了回头补洞
  for (let n = 3; n <= 9; n++) ready.add(n);
  ready.delete(1);
  assert.equal(plan({ playheadFrame: 9 * 15, rate: 0 }).segment, 1);
  ready.add(1);
  assert.equal(plan({ playheadFrame: 0, rate: 0 }).segment, null);
  // 预留的不再挑
  ready.delete(7);
  assert.equal(plan({ playheadFrame: 0, rate: 0, reserved: new Set([7]) }).segment, null);
});
