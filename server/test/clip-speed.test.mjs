/**
 * 片段速度(`TrackClip.speed`,`src/kernel/clipTime.mjs`)横跨各处的口径:
 *   - 缺省 1(没有字段)时各处身份键逐字不变:下面的固定值是开工提交 5a8f375a 上同一份样例算出来的(`out/speed/golden.mjs`);
 *   - 变速段的画面各处按「素材时刻 = mediaOffset + (t − start) × speed」取;
 *   - 〔裁〕第一版变速段的原声不出(导出混音、预览声音层同一条 `speedMutesSource`);
 *   - store 改速度保住入点、按新速度重算终点,改回 1 删掉字段。
 * 跑:npm test -- server/test/clip-speed.test.mjs
 */
import { srcUrl } from '../../src/testing/registerTs.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { frameIdentity, trackPrefixes } from '../frame-identity.mjs';
import { cardSnapshotInputKeys, cardNodeIdentities } from '../card-identity.mjs';
import { clipInputSig } from '../../src/render/layerInputSig.mjs';
import { projectHash } from '../../src/render/changedClips.mjs';
import { projectCardGraph } from '../../src/kernel/cardGraph.mjs';
import { audioPlanOf } from '../../src/kernel/audioPlan.mjs';
import { flatPlanProject } from '../../src/kernel/cutFlatten.mjs';
import { withMediaRates } from '../../src/kernel/clipTime.mjs';
import { buildAudioPlan } from '../bakery/mux-audio.mjs';
import { mediaLayersAt } from '../vision-compose.mjs';
import { buildComposeArgs } from '../export-compose.mjs';

const fixture = () => ({
  id: 'p', width: 1280, height: 720, fps: 30, duration: 12, themeId: 'dark',
  media: [{ id: 'v1', kind: 'video', url: '/@media/v1.mp4', hash: 'h-v1', duration: 20 }, { id: 'a1', kind: 'audio', url: '/@media/a1.mp3', duration: 30 }],
  cardNodes: [{ id: 'n1', adapter: 'card', cardId: 'fx-tint', kind: 'filter', params: {}, inputs: { source: '@clip/v-fx/source' } }],
  tracks: [
    { id: 't1', name: '序列 1', clips: [{ id: 'c1', cardId: 'punch-pill', start: 0, end: 2, params: { text: 'a' } }] },
    { id: 't2', name: '序列 2', clips: [
      { id: 'v-plain', cardId: '', mediaId: 'v1', mediaOffset: 1.5, start: 0, end: 4, params: {} },
      { id: 'v-fx', cardId: '', mediaId: 'v1', mediaOffset: 0.2, start: 4, end: 8, params: {}, nodeId: 'n1' },
    ] },
    { id: 't3', name: '序列 3', clips: [{ id: 'a-1', cardId: '', mediaId: 'a1', mediaOffset: 3, start: 0, end: 10, params: {} }] },
  ],
});
const DEFS = { 'fx-tint': { id: 'fx-tint', kind: 'filter', defaults: {}, card() {} }, 'punch-pill': { id: 'punch-pill', defaults: { text: '' } } };
const withClip = (p, id, patch) => ({ ...p, tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)) })) });
// 出画面、出键的几处都是 projectCardGraph 之后接 withMediaRates(cardGraph.mjs 在有声卡的源码闭包里,不能改它)
const graphOf = (p) => withMediaRates(p, projectCardGraph(p, (id) => DEFS[id]));
const graphKeys = (p) => {
  const graph = graphOf(p);
  return { inputKeys: Object.fromEntries(cardSnapshotInputKeys(graph)), nodeIds: Object.fromEntries(cardNodeIdentities(graph)) };
};

/* ---------- 缺省 1:身份逐字不变 ---------- */

// 开工提交 5a8f375a(与像素基线提交 5f4523d0 相同)上算的固定值
const GOLDEN = {
  frameIdentity: 'aed6ffcff5fd4e233c5701c6033d2b74df9d06db110d05056106cfa632cb6163',
  trackPrefixes: [
    'd36693eb5c81c63e67a2980a9d1afa342337df3c61c7c0cf22fe039c429ff974',
    '1054781b6b5080c3db98fc2c3f4aefa2c1800cdd52b5ed12e22cc65e0a9f08f2',
    'aed6ffcff5fd4e233c5701c6033d2b74df9d06db110d05056106cfa632cb6163',
  ],
  projectHash: '18303b68ed969381',
  sigs: { c1: 'i1-d3f5f71cb7d2238e', 'v-plain': 'i1-e565d029c406bc63', 'v-fx': 'i1-a72af12d3494e2f9', 'a-1': 'i1-f6d1bc7e18872ea9' },
  fxInputKey: '3194e3a40b920851181c0125b3ad2de14f3703bb540815ed1138bfcb926b649b',
};

test('缺省 1:帧身份、轨道前缀、镜像哈希、输入签名、卡片图上游键与开工提交逐字相同', () => {
  const p = fixture();
  assert.equal(frameIdentity(p, 'code'), GOLDEN.frameIdentity);
  assert.deepEqual(trackPrefixes(p, 'code').map((x) => x.key), GOLDEN.trackPrefixes);
  assert.equal(projectHash(p), GOLDEN.projectHash);
  for (const [id, sig] of Object.entries(GOLDEN.sigs)) assert.equal(clipInputSig(p, id), sig, id);
  assert.equal(graphKeys(p).inputKeys.n1.source.key, GOLDEN.fxInputKey);
  // 素材节点上没有 rate 这一项(缺省 1 不进节点)
  const graph = graphOf(p);
  assert.equal('rate' in graph.nodes.find((n) => n.id === '@clip/v-fx/source'), false);
  const raw = projectCardGraph(p, (id) => DEFS[id]);
  assert.equal(withMediaRates(p, raw), raw, '没有变速段时回同一个对象');
});

test('变速:层表输入签名、卡片图素材节点、接它的素材效果卡上游键都跟着变;别的片段不变', () => {
  const p = fixture();
  const fast = withClip(p, 'v-fx', { speed: 2 });
  assert.notEqual(clipInputSig(fast, 'v-fx'), clipInputSig(p, 'v-fx'), '变速段自己的签名要变');
  assert.equal(clipInputSig(fast, 'v-plain'), clipInputSig(p, 'v-plain'), '别的片段不变');
  const node = graphOf(fast).nodes.find((n) => n.id === '@clip/v-fx/source');
  assert.equal(node.rate, 2, '素材节点带上倍率');
  assert.notEqual(graphKeys(fast).inputKeys.n1.source.key, GOLDEN.fxInputKey, '接变速素材的素材效果卡上游键要变(否则命中旧快照)');
  assert.notEqual(graphKeys(fast).nodeIds['@clip/v-fx/source'], graphKeys(p).nodeIds['@clip/v-fx/source']);
  // 整份序列进哈希的几处:多了一个键自然就变
  assert.notEqual(frameIdentity(fast, 'code'), GOLDEN.frameIdentity);
  assert.notEqual(projectHash(fast), GOLDEN.projectHash);
  // speed: 1 显式写着也按缺省算(签名口径不因多写一个 1 而变)
  assert.equal(clipInputSig(withClip(p, 'v-fx', { speed: 1 }), 'v-fx'), GOLDEN.sigs['v-fx']);
});

/* ---------- 画面取哪一帧 ---------- */

test('看画面(vision-compose):素材时刻按速度换算', () => {
  const p = withClip(fixture(), 'v-plain', { speed: 2 });
  const layer = mediaLayersAt(p, 1).find((l) => l.clip.id === 'v-plain');
  assert.equal(layer.mediaTime, 1.5 + 1 * 2);
  const slow = withClip(fixture(), 'v-plain', { speed: 0.5 });
  assert.equal(mediaLayersAt(slow, 3).find((l) => l.clip.id === 'v-plain').mediaTime, 1.5 + 3 * 0.5);
});

test('导出兼容旁路(export-compose):变速段按倍率把素材时间戳压到时间轴上,读的素材长度乘倍率', () => {
  const media = { id: 'v1', kind: 'video', name: 'a.mp4', url: '/@media/a.mp4' };
  const frame = { x: 0, y: 0, w: 1920, h: 1080, anchor: [0, 0], scale: 1, rotate: 0 };
  const build = (speed) => buildComposeArgs({ width: 1920, height: 1080, fps: 30, startFrame: 0, endFrame: 89, cardsPattern: 'f/%06d.png', out: 'o.mp4',
    layers: [{ clip: { id: 'c', mediaId: 'v1', mediaOffset: 10, start: 0, end: 3, frame, ...(speed ? { speed } : {}) }, media, src: '/m/a.mp4' }] });
  const one = build(undefined), two = build(2);
  const ssOf = (r) => r.args[r.args.indexOf('-ss') + 1], tOf = (r) => r.args[r.args.indexOf('-t') + 1];
  assert.equal(ssOf(one), '9.5');
  assert.equal(ssOf(two), '9.5', '入点不变');
  assert.equal(tOf(one), '4');
  assert.equal(tOf(two), '7', '素材要读 3 秒 × 2 + 两头余量');
  assert.match(one.graph, /setpts=PTS\+-0\.5\/TB,fps=30/, '缺省 1 的写法不变');
  assert.match(two.graph, /setpts=PTS\/2\+-0\.25\/TB,fps=30/, '时间戳除以倍率再平移:素材 m 秒落到 start + (m − off)/2');
});

test('素材效果卡的素材节点(withMediaRates):取帧时刻乘倍率,缺省不带倍率', () => {
  const p = withClip(fixture(), 'v-fx', { speed: 0.5 });
  const node = graphOf(p).nodes.find((n) => n.id === '@clip/v-fx/source');
  assert.deepEqual([node.offset, node.rate], [0.2, 0.5]);
});

/* ---------- 声音:变速段原声不出 ---------- */

test('导出混音清单(audioPlanOf):变速的视频段不出原声,别的段原样', () => {
  const base = audioPlanOf(fixture());
  const p = withClip(fixture(), 'v-plain', { speed: 2 });
  const plan = audioPlanOf(p);
  assert.equal(plan.some((e) => e.clipId === 'v-plain'), false, '变速段不在混音清单里');
  assert.deepEqual(plan, base.filter((e) => e.clipId !== 'v-plain'), '其余条目逐字相同');
  // ffmpeg 那条老路(mux-audio)用同一份清单
  const files = buildAudioPlan(p, 'out', () => true, (m) => `/x/${m.id}`);
  assert.equal(files.some((e) => e.clipId === 'v-plain'), false);
  assert.ok(files.some((e) => e.clipId === 'v-fx'));
});

/* ---------- 剪辑段里的变速段 ---------- */

test('剪辑段摊平(cutFlatten):截掉的那一截按倍率推进素材起点,速度带下去', () => {
  const p = {
    id: 'p', width: 1280, height: 720, fps: 30, duration: 20, media: [{ id: 'v1', kind: 'video', url: '/@media/v1.mp4' }],
    tracks: [{ id: 'ta', name: '序列 1', clips: [{ id: 'seg', cardId: '', cutId: 'B', cutOffset: 1, start: 2, end: 6, params: {} }] }],
    cuts: [{ id: 'A', name: '剪辑A' }, { id: 'B', name: '剪辑B', duration: 8, transitions: [], tracks: [{ id: 'tb', name: '序列 1', clips: [{ id: 'b1', cardId: '', mediaId: 'v1', mediaOffset: 3, speed: 2, start: 0, end: 8, params: {} }] }] }],
    activeCutId: 'A',
  };
  const v = flatPlanProject(p).tracks.flatMap((t) => t.clips).find((c) => c.id === 'seg~b1');
  assert.ok(v, '摊出来的虚拟片段');
  assert.equal(v.speed, 2);
  assert.equal(v.mediaOffset, 3 + 1 * 2, '截掉 1 秒时间轴 = 2 秒素材');
});

/* ---------- 实时播放的速率 ---------- */

test('预览同步(mediaSync.planSync):播放速率以片段速度为基准,纠偏在它上面浮动', async () => {
  const { planSync, MAX_RATE_SKEW } = await import(srcUrl('render/mediaSync.ts'));
  const base = { seeking: false, paused: false, playing: true, now: 10_000, lastSeekAt: 0 };
  assert.equal(planSync({ ...base, elTime: 5, target: 5 }).rate, 1, '缺省照旧是 1');
  assert.equal(planSync({ ...base, elTime: 5, target: 5, baseRate: 2 }).rate, 2, '对齐时按 2 倍放');
  const behind = planSync({ ...base, elTime: 5, target: 5.25, baseRate: 2 }).rate;
  assert.ok(behind > 2 && behind <= 2 * (1 + MAX_RATE_SKEW), `落后时在 2 倍上加速,实得 ${behind}`);
  assert.equal(planSync({ ...base, playing: false, paused: true, elTime: 5, target: 5, baseRate: 0.5 }).rate, 0.5, '暂停时停在基准速率');
});

/* ---------- 字幕、跟随轨迹 ---------- */

test('字幕铺放(captions):素材秒按速度换到时间轴,句长除以倍率', async () => {
  const { mapMediaTime, captionsFromTranscript } = await import(srcUrl('kernel/captions.ts'));
  const clips = [{ mediaId: 'v1', start: 10, end: 20, mediaOffset: 4, speed: 2 }];
  assert.equal(mapMediaTime(clips, 'v1', 8), 12, '素材第 8 秒 = 时间轴 10 + (8 − 4)/2');
  const plan = captionsFromTranscript(clips, 'v1', [{ start: 8, end: 10, text: '你好' }]);
  assert.deepEqual([plan.from, plan.to], [12, 13]);
});

test('跟随轨迹(motion):起点帧按速度换算,存的步长是时间轴上的秒', async () => {
  const { buildClipMotion } = await import(srcUrl('kernel/motion.ts'));
  const xy = Array.from({ length: 100 }, (_, i) => [i, 0]);
  const visible = xy.map(() => true);
  const common = { xy, visible, media: { id: 'v1', width: 1280, height: 720, duration: 10 }, stage: { width: 1280, height: 720 }, card: { start: 2, end: 3 }, pointIndex: 0, whenHidden: 'hold' };
  const one = buildClipMotion({ ...common, clipOfMedia: { start: 0, mediaOffset: 1 } });
  const two = buildClipMotion({ ...common, clipOfMedia: { start: 0, mediaOffset: 1, speed: 2 } });
  assert.equal(one.motion.frameStep, 0.1);
  assert.equal(two.motion.frameStep, 0.05, '素材 0.1 秒一点,2 倍速下时间轴 0.05 秒一点');
  assert.equal(two.motion.offsets.length, 21, '卡片 1 秒覆盖素材 2 秒 = 20 点 + 1');
  assert.equal(one.motion.offsets.length, 11);
});

/* ---------- store ---------- */

test('store.setClipSpeed:保住入点、按新速度重算终点,改回 1 删字段;切分的后半段按倍率推进素材起点', async () => {
  const { actions, getState } = await import(srcUrl('store/project.ts'));
  actions.loadProject({ version: 1, id: 'p-speed', name: 't', width: 1280, height: 720, fps: 30, duration: 20, themeId: 'midnight',
    media: [{ id: 'v1', kind: 'video', name: 'v.mp4', url: '/@media/v1.mp4', duration: 30 }, { id: 'i1', kind: 'image', name: 'i.png', url: '/@media/i.png' }],
    tracks: [{ id: 'ta', name: '序列 1', clips: [
      { id: 'v', cardId: '', mediaId: 'v1', mediaOffset: 2, start: 1, end: 5, params: {} },
      { id: 'img', cardId: '', mediaId: 'i1', start: 10, end: 12, params: {} },
    ] }] });
  const clip = (id) => getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === id);
  let r = actions.setClipSpeed('v', 2);
  assert.equal(r.ok, true);
  assert.deepEqual([clip('v').start, clip('v').end, clip('v').mediaOffset, clip('v').speed], [1, 3, 2, 2], '4 秒素材 2 倍速 = 2 秒');
  r = actions.setClipSpeed('v', 0.5);
  assert.deepEqual([clip('v').start, clip('v').end, clip('v').speed], [1, 9, 0.5], '同一截素材 0.5 倍 = 8 秒');
  r = actions.setClipSpeed('v', 0.5 * 4);
  r = actions.setClipSpeed('v', 1);
  assert.equal(r.ok, true);
  assert.equal('speed' in clip('v'), false, '改回 1 不留 speed 字段(身份键逐字回到原样)');
  assert.deepEqual([clip('v').start, clip('v').end], [1, 5]);
  // 后面挤不下:截到下一段的起点
  actions.setClipSpeed('v', 0.25);
  assert.equal(clip('v').end, 10, '0.25 倍要 16 秒,后面 10 秒处有图片,截到 10');
  // 图片段不能变速
  assert.equal(actions.setClipSpeed('img', 2).ok, false);
  // 切分:后半段素材起点 = 2 + (5 − 1) × 0.25,带着速度
  const right = actions.splitClip('v', 5);
  assert.equal(right.speed, 0.25);
  assert.equal(right.mediaOffset, 2 + 4 * 0.25);
  // 变速段不能音画分离(原声已经不出)
  const sep = actions.separateAudio('v');
  assert.equal(sep.ok, false);
  assert.match(sep.error, /变速/);
  // 一次改速度 = 一步撤销
  actions.undo(); actions.undo();
  assert.equal(clip('v').speed, undefined);
});
