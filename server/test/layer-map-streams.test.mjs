/**
 * 层表的 `streams` 表(`server/artifact-transfer.mjs` 的 `layerMapOf` / `layerStreamsOf` / `splitStreamCandidatesOf`;
 * `docs/plan/browser-stream-task.md` 第五处):每条轨道流一行,在线页面按它找流清单。
 * 跑:node --test server/test/layer-map-streams.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layerMapOf, layerStreamsOf, splitCandidatesOf, splitStreamCandidatesOf, streamCandidateKey, STREAM_CANDIDATE_PREFIX, LAYER_MAP_VERSION } from '../artifact-transfer.mjs';
import { resultKeyOf } from '../render-node/fingerprint.mjs';
import { planStreams } from '../frame-stream.mjs';
import { QUEUE_DEFAULTS } from '../render-queue/constants.mjs';
import { streamInputSig } from '../../src/render/streamInputSig.mjs';

const OWN = 'fp-own-00000001';
const BROWSER = 'fp-browser-0002';

const project = () => ({
  id: 'proj-streams', width: 1920, height: 1080, fps: 30, duration: 6, themeId: 'dark', style: {}, media: [], filters: [], pixelMaps: [], cardNodes: [],
  tracks: [
    { id: 't-a', clips: [{ id: 'clip-a', cardId: 'punch-pill', start: 0, end: 2, params: { text: 'a' }, frame: { x: 100, y: 100, w: 640, h: 360 } }] },
    { id: 't-b', clips: [{ id: 'clip-b', cardId: 'particles', start: 1, end: 5, params: { seed: 3 } }] },
  ],
});
const control = (clipId, firstFrame, count, extra = {}) => ({
  clipId, key: `key-${clipId}`, snapshotKey: resultKeyOf(`ck-${clipId}`, OWN), contentKey: `ck-${clipId}`, envFingerprint: OWN, tier: 'shared',
  sampling: { firstFrame }, count, capabilities: { compositing: 'independent' }, ...extra,
});
const entryOf = (p = project()) => ({ key: 'entry-1', project: p, cardPlan: [control('clip-a', 0, 60), control('clip-b', 30, 120)] });
const specsOf = (entry, budget = 6) => planStreams(entry, { budget, codeVersion: '1:test', envFingerprint: OWN });

test('没有流时:层表不带 streams,与以前一字不差', () => {
  const entry = entryOf();
  const before = layerMapOf(entry, { fingerprint: OWN, now: 1 });
  assert.equal('streams' in before, false);
  assert.equal(before.v, LAYER_MAP_VERSION, '不升版本号');
  assert.deepEqual(layerMapOf(entry, { fingerprint: OWN, now: 1, streams: [] }), before, '给了空的流表也不带');
  assert.deepEqual(layerMapOf(entry, { fingerprint: OWN, now: 1, streams: null, streamCandidatesOf: () => [BROWSER] }), before);
});

test('单卡流:每条流一行,字段齐;layers 那一半不受影响', () => {
  const entry = entryOf();
  const specs = specsOf(entry);
  assert.equal(specs.length, 2, 'planStreams 出两条单卡流');
  const map = layerMapOf(entry, { fingerprint: OWN, now: 1, streams: specs });
  assert.deepEqual(map.layers, layerMapOf(entry, { fingerprint: OWN, now: 1 }).layers);
  assert.equal(map.v, LAYER_MAP_VERSION);
  assert.equal(map.streams.length, 2);
  for (const spec of specs) {
    const row = map.streams.find((r) => r.topClipId === spec.topClipId);
    assert.ok(row, `有 ${spec.topClipId} 这一行`);
    assert.deepEqual(row.clipIds, spec.clipIds);
    assert.equal(row.kind, 'card');
    assert.equal(row.plane, 'local');
    assert.equal(row.contentKey, spec.contentKey);
    assert.deepEqual(row.candidates, [{ envFingerprint: OWN, resultKey: spec.streamKey }], '只有自己一个候选,结果键就是流键');
    assert.equal(row.firstSegment, spec.firstSegment);
    assert.equal(row.lastSegment, spec.lastSegment);
    assert.equal(row.segmentsPerTask, QUEUE_DEFAULTS.STREAM_SEGMENTS);
    assert.equal(row.inputSig, streamInputSig(entry.project, { clipIds: spec.clipIds, kind: 'card' }));
    assert.match(row.inputSig, /^s1-[0-9a-f]{16}$/);
  }
  // clip-b 从第 30 帧起:第一段是 2
  assert.equal(map.streams.find((r) => r.topClipId === 'clip-b').firstSegment, 2);
});

test('组流:解码器预算压到 1 时两张卡并成一条,行里带全部成员,挂在最上面那张上', () => {
  const entry = entryOf();
  const specs = specsOf(entry, 1);
  assert.equal(specs.length, 1);
  assert.equal(specs[0].kind, 'group');
  const [row] = layerStreamsOf(entry, { streams: specs, fingerprint: OWN });
  assert.equal(row.kind, 'group');
  assert.equal(row.plane, 'stage');
  assert.deepEqual(row.clipIds, specs[0].clipIds);
  assert.equal(row.topClipId, specs[0].clipIds[specs[0].clipIds.length - 1]);
  assert.deepEqual(row.candidates, [{ envFingerprint: OWN, resultKey: specs[0].streamKey }]);
  assert.equal(row.inputSig, streamInputSig(entry.project, { clipIds: specs[0].clipIds, kind: 'group' }));
});

test('候选:切分实际出键的指纹在前(按发布顺序),再补上自己的;结果键 = 内容键 × 指纹', () => {
  const entry = entryOf();
  const [spec] = specsOf(entry);
  const row = (candidatesOf) => layerStreamsOf(entry, { streams: [spec], fingerprint: OWN, candidatesOf })[0];
  // 切分给浏览器另出了一份:切分方自己的在前
  assert.deepEqual(row(() => [OWN, BROWSER]).candidates, [
    { envFingerprint: OWN, resultKey: resultKeyOf(spec.contentKey, OWN) },
    { envFingerprint: BROWSER, resultKey: resultKeyOf(spec.contentKey, BROWSER) },
  ]);
  // 锁在浏览器指纹上(只出了浏览器那一份):它在前,自己的补在最后
  assert.deepEqual(row(() => [BROWSER]).candidates.map((c) => c.envFingerprint), [BROWSER, OWN]);
  // 没记过、回空、抛错:只有自己一个
  for (const fn of [() => null, () => [], () => { throw new Error('x'); }]) assert.deepEqual(row(fn).candidates.map((c) => c.envFingerprint), [OWN]);
  // 重复的、不是字符串的去掉
  assert.deepEqual(row(() => [BROWSER, BROWSER, '', 7, OWN]).candidates.map((c) => c.envFingerprint), [BROWSER, OWN]);
  // 经 layerMapOf 进来的是 streamCandidatesOf,不是快照层的 candidatesOf
  const map = layerMapOf(entry, { fingerprint: OWN, streams: [spec], candidatesOf: () => ['fp-snap-only'], streamCandidatesOf: () => [OWN, BROWSER] });
  assert.deepEqual(map.streams[0].candidates.map((c) => c.envFingerprint), [OWN, BROWSER]);
});

test('每份清单几段:缺省取队列常量,调用方可以给;形状不对的流跳过,不抛', () => {
  const entry = entryOf();
  const [spec] = specsOf(entry);
  assert.equal(layerStreamsOf(entry, { streams: [spec], fingerprint: OWN, segmentsPerTask: 4 })[0].segmentsPerTask, 4);
  assert.equal(layerStreamsOf(entry, { streams: [spec], fingerprint: OWN, segmentsPerTask: 0 })[0].segmentsPerTask, QUEUE_DEFAULTS.STREAM_SEGMENTS);
  const bad = [
    null, {}, { ...spec, contentKey: '' }, { ...spec, clipIds: [] }, { ...spec, clipIds: ['a', 7] }, { ...spec, kind: 'video' }, { ...spec, plane: 'x' },
    { ...spec, firstSegment: 3, lastSegment: 2 }, { ...spec, firstSegment: -1 }, { ...spec, lastSegment: 1.5 },
  ];
  assert.deepEqual(layerStreamsOf(entry, { streams: bad, fingerprint: OWN }), []);
  // 一个指纹都没有(流自己没带、调用方也没给):凑不出候选,不列
  assert.deepEqual(layerStreamsOf(entry, { streams: [{ ...spec, envFingerprint: undefined }], fingerprint: null }), []);
  assert.deepEqual(layerStreamsOf(entry, { streams: 'nope', fingerprint: OWN }), []);
});

test('同一条流挂在两个片段上(同卡同参数同入点):两行,键相同、topClipId 不同', () => {
  const p = project();
  p.tracks.push({ id: 't-a2', clips: [{ ...p.tracks[0].clips[0], id: 'clip-a2' }] });
  const entry = { key: 'entry-1', project: p, cardPlan: [control('clip-a', 0, 60), control('clip-a2', 0, 60, { contentKey: 'ck-clip-a', snapshotKey: resultKeyOf('ck-clip-a', OWN) })] };
  const rows = layerStreamsOf(entry, { streams: specsOf(entry), fingerprint: OWN });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].contentKey, rows[1].contentKey);
  assert.deepEqual(rows.map((r) => r.topClipId).sort(), ['clip-a', 'clip-a2']);
});

test('splitStreamCandidatesOf:只收流任务,按内容键记指纹(发布顺序);快照那一份照旧只收快照', () => {
  const stream = (ck, fp, from, extra = {}) => ({ id: `stream:${resultKeyOf(ck, fp)}:${from}-${from + 7}`, kind: 'stream', resultKey: resultKeyOf(ck, fp),
    range: { unit: 'segment', from, to: from + 7 }, input: { clipId: 'clip-a', cardId: null, entryKey: null, contentKey: ck, ...extra }, requires: { envFingerprint: fp, transcode: true } });
  const snap = (ck, fp) => ({ id: `snapshot:${ck}:0-59`, kind: 'snapshot', tier: 'shared', resultKey: resultKeyOf(ck, fp), range: { from: 0, to: 59 }, input: { contentKey: ck }, requires: { envFingerprint: fp } });
  const tasks = [
    snap('ck-card', OWN), snap('ck-card', BROWSER),
    stream('sk-1', OWN, 0), stream('sk-1', OWN, 8),
    // 「产」那一半让切分给浏览器多出的一份单卡流:只认通用字段(kind、input.contentKey、requires.envFingerprint),别的字段不看
    stream('sk-1', BROWSER, 0, { dual: true, stream: { kind: 'card', plane: 'local' } }),
    stream('sk-2', BROWSER, 2),
    { kind: 'stream', input: {}, requires: { envFingerprint: OWN } }, { kind: 'stream', input: { contentKey: 'sk-3' }, requires: {} }, null,
  ];
  assert.deepEqual([...splitStreamCandidatesOf(tasks)], [['sk-1', [OWN, BROWSER]], ['sk-2', [BROWSER]]]);
  assert.deepEqual([...splitCandidatesOf(tasks)], [['ck-card', [OWN, BROWSER]]], '流任务不混进快照的候选');
  assert.deepEqual([...splitStreamCandidatesOf(null)], []);
  assert.equal(streamCandidateKey('sk-1'), `${STREAM_CANDIDATE_PREFIX}sk-1`);
  assert.equal(streamCandidateKey(''), null);
});

test('执行器 afterSplit:流的候选记在同一份记录里(键带 stream: 前缀);没有流任务时只记一次', async () => {
  const { createPrerenderExecutor } = await import('../prerender-executor.mjs');
  const recorded = [];
  const pipeline = { recordSplitCandidates: (m) => recorded.push([...m.entries()]) };
  const exec = createPrerenderExecutor({ pipeline, projects: { get: async () => ({ tracks: [], duration: 1 }) } });
  const planTask = { id: 'plan:x', kind: 'plan', resultKey: 'x', source: { projectId: 'proj-streams', projectRev: 1 }, input: {} };
  const snap = { kind: 'snapshot', tier: 'shared', input: { contentKey: 'ck-card' }, requires: { envFingerprint: OWN } };
  const str = (fp) => ({ kind: 'stream', input: { contentKey: 'sk-1' }, requires: { envFingerprint: fp } });
  await exec.afterSplit(planTask, { tasks: [snap] });
  assert.deepEqual(recorded, [[['ck-card', [OWN]]]], '没有流任务:和以前一样只记一次');
  recorded.length = 0;
  await exec.afterSplit(planTask, { tasks: [snap, str(OWN), str(BROWSER)] });
  assert.deepEqual(recorded, [[['ck-card', [OWN]]], [['stream:sk-1', [OWN, BROWSER]]]]);
});
