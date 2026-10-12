/**
 * 轨道流的输入签名(`streamInputSig.mjs`):层表 `streams` 表每行记一份,页面按当前项目算同一个,对不上的流不播。
 * 跑:node --test src/render/streamInputSig.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streamInputSig, streamInputs, streamSigStale, STREAM_INPUT_SIG_VERSION } from './streamInputSig.mjs';
import { clipInputSig } from './layerInputSig.mjs';

const project = () => ({
  id: 'p', width: 1920, height: 1080, fps: 30, duration: 10, themeId: 'dark', style: {}, media: [{ id: 'm1', kind: 'video', hash: 'h1' }], filters: [], pixelMaps: [], cardNodes: [],
  tracks: [
    { id: 't-top', clips: [{ id: 'a', cardId: 'punch-pill', start: 1, end: 3, params: { text: 'a' }, frame: { x: 10, y: 20, w: 640, h: 360 }, opacity: 1 }] },
    { id: 't-mid', clips: [{ id: 'b', cardId: 'particles', start: 0, end: 4, params: { seed: 3 } }] },
    { id: 't-low', clips: [{ id: 'v', mediaId: 'm1', start: 0, end: 10 }] },
  ],
});
const edit = (fn) => { const p = structuredClone(project()); fn(p); return p; };
const clipOf = (p, id) => p.tracks.flatMap((t) => t.clips).find((c) => c.id === id);
const card = { clipIds: ['a'], kind: 'card' };
const group = { clipIds: ['b', 'a'], kind: 'group' };

test('形状:带版本前缀;同一份输入两边算出同一个;经 JSON 走一遍也一样', () => {
  const p = project();
  const sig = streamInputSig(p, card);
  assert.match(sig, new RegExp(`^s${STREAM_INPUT_SIG_VERSION}-[0-9a-f]{16}$`));
  assert.equal(streamInputSig(JSON.parse(JSON.stringify(p)), card), sig);
  assert.equal(streamInputSig(p, { clipIds: ['a'] }), sig, '没写 kind 的单成员按单卡流算');
  assert.notEqual(streamInputSig(p, group), sig);
});

test('成员不在项目里、没有成员:回 null(不比)', () => {
  assert.equal(streamInputSig(project(), { clipIds: ['nope'], kind: 'card' }), null);
  assert.equal(streamInputSig(project(), { clipIds: [], kind: 'card' }), null);
  assert.equal(streamInputSig(project(), { clipIds: ['a', 'nope'], kind: 'group' }), null);
  assert.equal(streamInputSig(null, card), null);
});

test('单卡流:参数、片段整帧平移、时长变了都算变;位置、不透明度、淡入淡出不算', () => {
  const base = streamInputSig(project(), card);
  assert.notEqual(streamInputSig(edit((p) => { clipOf(p, 'a').params.text = 'b'; }), card), base, '参数');
  // 快照层的签名不管整帧平移(快照按本地帧取);流按全局帧号分段,平移了每一帧都对不上
  const moved = edit((p) => { const c = clipOf(p, 'a'); c.start += 1; c.end += 1; });
  assert.equal(clipInputSig(moved, 'a'), clipInputSig(project(), 'a'), '对照:快照层的签名不变');
  assert.notEqual(streamInputSig(moved, card), base, '整帧平移');
  assert.notEqual(streamInputSig(edit((p) => { clipOf(p, 'a').end = 3.5; }), card), base, '时长');
  // 单卡流画在包裹层自己的坐标里,这些由舞台的包裹层加
  assert.equal(streamInputSig(edit((p) => { const c = clipOf(p, 'a'); c.frame.x = 500; c.frame.y = 9; c.opacity = 0.5; c.fadeIn = 0.3; }), card), base, '位置、不透明度、淡入');
  assert.notEqual(streamInputSig(edit((p) => { clipOf(p, 'a').frame.w = 800; }), card), base, '框的宽高');
  // 别的片段怎么改都不相干
  assert.equal(streamInputSig(edit((p) => { clipOf(p, 'b').params.seed = 9; clipOf(p, 'b').start = 0.5; }), card), base);
});

test('项目时长:截到这条流才算变', () => {
  const base = streamInputSig(project(), card);
  assert.equal(streamInputSig(edit((p) => { p.duration = 20; }), card), base, '加长,流没被截');
  assert.notEqual(streamInputSig(edit((p) => { p.duration = 2; }), card), base, '缩到片段中间,流被截短');
});

test('组流:成员的摆放、上下顺序、中间插进别的层都算变', () => {
  const base = streamInputSig(project(), group);
  assert.notEqual(streamInputSig(edit((p) => { clipOf(p, 'a').frame.x = 500; }), group), base, '位置');
  assert.notEqual(streamInputSig(edit((p) => { clipOf(p, 'a').opacity = 0.5; }), group), base, '不透明度');
  assert.notEqual(streamInputSig(edit((p) => { clipOf(p, 'b').fadeOut = 0.4; }), group), base, '淡出');
  assert.notEqual(streamInputSig(edit((p) => { clipOf(p, 'b').params.seed = 9; }), group), base, '成员的参数');
  assert.notEqual(streamInputSig(edit((p) => { p.tracks = [p.tracks[1], p.tracks[0], p.tracks[2]]; }), group), base, '两个成员上下对调');
  // 往两个成员中间插一条序列(时间上重叠):组流的上下关系不对了
  const between = edit((p) => { p.tracks.splice(1, 0, { id: 't-new', clips: [{ id: 'x', cardId: 'odometer', start: 2, end: 2.5 }] }); });
  assert.notEqual(streamInputSig(between, group), base, '中间插了一层');
  assert.deepEqual(streamInputs(between, group).between, ['x']);
  // 插在外面、或者中间那层时间上不重叠、或者是隐藏的序列:不相干
  assert.equal(streamInputSig(edit((p) => { p.tracks.unshift({ id: 't-new', clips: [{ id: 'x', cardId: 'odometer', start: 2, end: 2.5 }] }); }), group), base, '插在最上面');
  assert.equal(streamInputSig(edit((p) => { p.tracks.splice(1, 0, { id: 't-new', clips: [{ id: 'x', cardId: 'odometer', start: 6, end: 7 }] }); }), group), base, '中间的层时间上不重叠');
  assert.equal(streamInputSig(edit((p) => { p.tracks.splice(1, 0, { id: 't-new', hidden: true, clips: [{ id: 'x', cardId: 'odometer', start: 2, end: 2.5 }] }); }), group), base, '中间是隐藏的序列');
  assert.deepEqual(streamInputs(project(), group).paint, ['b', 'a'], '画家顺序:下面的在前');
});

test('streamSigStale:两边都有、同版本、不同才算过期', () => {
  assert.equal(streamSigStale('s1-aaaa', 's1-bbbb'), true);
  assert.equal(streamSigStale('s1-aaaa', 's1-aaaa'), false);
  assert.equal(streamSigStale(undefined, 's1-aaaa'), false);
  assert.equal(streamSigStale('s1-aaaa', null), false);
  assert.equal(streamSigStale('s9-aaaa', 's1-aaaa'), false, '版本不同不比');
  assert.equal(streamSigStale('i1-aaaa', 's1-aaaa'), false, '不是流的签名不比');
});
