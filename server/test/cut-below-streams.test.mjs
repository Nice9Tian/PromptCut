/**
 * 剪辑段里的卡做通产流(〔裁〕R01、R02;`docs/plan/user-decisions-2026-10-22.md` 第 2 节第 4 条)。用例名以 `CB-` 开头。
 * 跑:npm test -- server/test/cut-below-streams.test.mjs
 *
 * R01 剪辑段里依赖下层的卡(毛玻璃、没登记的卡)带着下层一起产「依赖下层的流」。剪辑段的画面是被引用剪辑的整帧合成
 * (`product/project-model.md`),嵌套场景是毛玻璃的采样边界(`CutSegmentScene` 的 `clip-path`),所以这条流的下层只算**同一个嵌套场景里**
 * 排在它下面的层,按嵌套场景自己的坐标产,贴在嵌套舞台里、层序取这张卡那一层;段的框、不透明度、淡入淡出在贴的时候由外面那几层照常加。
 *
 *   CB-golden  顶层的流(没有剪辑段的项目;有剪辑段的项目里原来就有的那几条)键、形状、签名与开工提交逐字相同
 *   CB-plan    剪辑段里依赖下层、没登记的卡各出一条 `kind: 'below'` 的流,下层只算同一个嵌套场景里的(段外的、上面的都不算)
 *   CB-key     身份键:带 `within`(这条流只算哪个嵌套场景里的下层),与不带的键不同;段里的下层、目标卡变了键和签名都变;
 *              段外的层、段的框与不透明度、段里上面的层怎么改都不变;段的时间摆放变了会变
 *   CB-iso     隔离工程:剪辑段链去掉外观、只留链上的段;最里面那条剪辑里留目标卡和它下面的层,上面的藏起来;目标卡外观原样
 *   CB-mount   回放从嵌套场景最早挂上的那一帧起
 * R02 在线浏览器也替剪辑段里的重卡产流:
 *   CB-split   切分方给浏览器出剪辑段里独立卡(平面的)那一份流任务;外框三维的、依赖下层的照旧不给
 *   CB-page    本页产流的计划也算剪辑段里的独立卡,键与切分方给浏览器那一份逐字段相同
 *   CB-bake    浏览器那一份的隔离工程带着剪辑段链(`bakeTask.ts` 的 `isolatedBakeProject`)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { planStreams, planListStreams, queueStreamOf, isolatedStreamProject, STREAM_CODE_VERSION } from '../frame-stream.mjs';
import { cardStreamIdentity } from '../card-identity.mjs';
import { CardFrameCache } from '../card-cache.mjs';
import { captureCode } from '../frame-code.mjs';
import { splitPlan } from '../render-node/split.mjs';
import { clipsPlanTaskOf } from '../render-queue/index.mjs';
import { resultKeyOf as serverResultKeyOf } from '../render-node/fingerprint.mjs';
import { streamInputSig } from '../../src/render/streamInputSig.mjs';
import { mountFrameOf } from '../../src/render/frameWindow.mjs';
import { planPageStreams, pageStreamTasks } from '../../src/online/pageStreamPlan.ts';
import { cutProject, topProject, entryOf, pageValueOf, FP, CV } from './cut-below-fixtures.mjs';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const h = v => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);
const plan = p => planStreams(entryOf(p), { envFingerprint: FP, codeVersion: CV, below: true });
const belowOf = (p, id) => plan(p).find(s => s.kind === 'below' && s.topClipId === id) ?? null;

/* ================================================================== R01 */

test('CB-golden 顶层的流与开工提交 b362e254 逐字相同', () => {
  // 金样:在开工提交上用同一份场景算的(`server/test/cut-below-fixtures.mjs`)。顶层场景整张流表一个字不变
  assert.equal(h(plan(topProject())), 'db48e54f777d7075', '没有剪辑段的项目:流表逐字相同');
  // 有剪辑段的项目里原来就有的那几条:各自逐字相同(新出的依赖下层的流另算)
  const specs = plan(cutProject());
  const want = { over: 'a57b0a81f71a7164', 'S~S2~cc': '07137a4a745f84ef', 'S~m': 'beb789a62032aa21', 'S~up': '8c58df6f775c843d', topg: '9119466bf5b98bdf' };
  for (const [id, hash] of Object.entries(want)) {
    const spec = specs.find(s => s.topClipId === id);
    assert.ok(spec, `${id} 的流还在`);
    assert.equal(h(spec), hash, `${id} 的流逐字相同`);
  }
  assert.equal(streamInputSig(topProject(), { clipIds: ['glass'], kind: 'below' }), 's1-c03e47ff075c67d9');
  assert.equal(streamInputSig(cutProject(), { clipIds: ['topg'], kind: 'below' }), 's1-b008c155a4d05838');
});

test('CB-plan 剪辑段里依赖下层、没登记的卡各出一条依赖下层的流;下层只算同一个嵌套场景里的', () => {
  const p = cutProject();
  const specs = plan(p);
  const g = specs.find(s => s.topClipId === 'S~g');
  assert.ok(g, `毛玻璃 S~g 有流:${specs.map(s => `${s.kind}:${s.topClipId}`).join(' ')}`);
  assert.equal(g.kind, 'below');
  assert.equal(g.plane, 'stage');
  assert.deepEqual(g.clipIds, ['S~g']);
  assert.deepEqual(g.belowClipIds, ['S~S2~cc', 'S~u', 'S~m'], '下层按画家顺序(下面的在前),只有段里的;段外的视频、上面的卡都不算');
  assert.equal(g.within, 'S~', '这条流只算嵌套场景 S~ 里的下层');
  assert.deepEqual(g.bound, { x: 0, y: 0, w: 1280, h: 720 }, '嵌套场景的坐标(和项目同画幅)');
  assert.equal(g.firstFrame, 30, '露出窗口 [1, 7) 秒');
  assert.equal(g.lastFrame, 209);
  const u = specs.find(s => s.topClipId === 'S~u');
  assert.ok(u && u.kind === 'below', '没登记的卡按依赖下层出流');
  assert.deepEqual(u.belowClipIds, ['S~S2~cc']);
  // 段里的独立卡照旧各一条 solo flat 的单卡流(不变),段本身没有流
  assert.ok(!specs.some(s => s.clipIds.includes('S')));
  // 顶层那张毛玻璃的下层里照旧有剪辑段里的卡(它在段上面,滤的是整个舞台)
  assert.ok(specs.find(s => s.topClipId === 'topg').belowClipIds.includes('S~g'));
  // 发给切分的那一份带着下层
  assert.deepEqual(queueStreamOf(g).belowClipIds, ['S~S2~cc', 'S~u', 'S~m']);
});

test('CB-key 身份键带 within;段里的下层变了键和签名都变,段外、段的外观、上面的层不变', () => {
  const base = belowOf(cutProject(), 'S~g');
  const sig = p => streamInputSig(p, { clipIds: ['S~g'], kind: 'below' });
  assert.ok(base && sig(cutProject()));
  assert.equal(base.inputSig, sig(cutProject()), '计划里记的签名就是页面按同一份项目算的那一个');
  // within 进了键:同样的成员和下层、不带 within 时键不同(不会和别的流撞上、不会被当成不带下层的流命中)
  const entry = entryOf(cutProject());
  const controlOf = id => entry.cardPlan.find(c => c.clipId === id);
  const member = c => ({ key: c.cacheContentKey ?? c.key, sampling: c.sampling, count: c.count, extra: undefined });
  const layers = base.belowClipIds.map(id => member(controlOf(id)));
  const stage = { width: 1280, height: 720, camera3dFov: undefined };
  const withWithin = cardStreamIdentity({ kind: 'below', fps: 30, stage, codeVersion: CV, members: [member(controlOf('S~g'))], below: { layers, within: 'S~' } });
  const without = cardStreamIdentity({ kind: 'below', fps: 30, stage, codeVersion: CV, members: [member(controlOf('S~g'))], below: { layers } });
  assert.equal(base.contentKey, withWithin, '键就是带 within 的那一个');
  assert.notEqual(withWithin, without);
  // 单卡流的键(不带下层)也不同
  assert.notEqual(base.contentKey, cardStreamIdentity({ kind: 'card', fps: 30, stage, codeVersion: CV, members: [{ key: controlOf('S~g').streamMemberKey, sampling: controlOf('S~g').sampling, count: controlOf('S~g').count }] }));
  const same = (opts, why) => {
    const p = cutProject(opts);
    assert.equal(belowOf(p, 'S~g').contentKey, base.contentKey, `${why}:键不变`);
    assert.equal(sig(p), base.inputSig, `${why}:签名不变`);
  };
  const changed = (opts, why) => {
    const p = cutProject(opts);
    assert.notEqual(belowOf(p, 'S~g').contentKey, base.contentKey, `${why}:键变`);
    assert.notEqual(sig(p), base.inputSig, `${why}:签名变`);
  };
  same({ outerText: '外面改了' }, '段外上面的卡');
  same({ extraOuter: true }, '段外多一层');
  same({ segFrame: { x: 0, y: 0, w: 640, h: 360 } }, '段的框');
  same({ segOpacity: 0.5 }, '段的不透明度');
  same({ upText: '上面改了' }, '段里上面的卡');
  changed({ midText: '下层改了' }, '段里的下层');
  changed({ glassValue: 99 }, '目标卡自己');
  // 段在时间轴上挪了(露出的窗口、截头变了)
  const moved = cutProject();
  moved.tracks.find(t => t.id === 'ts').clips[0].cutOffset = 2;
  assert.notEqual(belowOf(moved, 'S~g').contentKey, base.contentKey, '段的偏移:键变');
});

test('CB-iso 隔离工程:剪辑段链去掉外观;最里面那条剪辑留目标卡和它下面的层', () => {
  const p = cutProject({ segOpacity: 0.5 });
  const g = belowOf(p, 'S~g');
  const iso = isolatedStreamProject(p, g);
  const shown = iso.tracks.filter(t => !t.hidden && !t.sourceOnly).flatMap(t => t.clips);
  assert.deepEqual(shown.map(c => c.id), ['S'], '顶层只留剪辑段 S');
  for (const key of ['frame', 'opacity', 'fadeIn', 'fadeOut']) assert.equal(shown[0][key], undefined, `段的 ${key} 拿掉(嵌套场景 1:1 铺满)`);
  assert.equal(shown[0].cutOffset, 1, '时间摆放原样');
  const B = iso.cuts.find(c => c.id === 'B');
  const visible = B.tracks.filter(t => !t.hidden && !t.sourceOnly).map(t => [t.id, t.clips.map(c => c.id)]);
  assert.deepEqual(visible, [['b-glass', ['g']], ['b-mid', ['m']], ['b-user', ['u']], ['b-seg', ['S2']]], '上面的 b-up 藏起来,下面的原样');
  const target = B.tracks.find(t => t.id === 'b-glass').clips[0];
  assert.deepEqual(target.frame, { x: 100, y: 100, w: 600, h: 300 }, '目标卡外观原样(这种流按场景坐标产,外观画进流里)');
  assert.ok(B.tracks.some(t => t.id === 'b-up' && t.hidden && t.sourceOnly));
  assert.deepEqual(iso.cuts.find(c => c.id === 'C'), p.cuts.find(c => c.id === 'C'), '嵌套剪辑段引用的剪辑原样');
  assert.deepEqual(iso._cardRender, { mode: 'final', frames: {}, missing: {} });
});

test('CB-mount 回放:从嵌套场景最早挂上的那一帧起', () => {
  const g = belowOf(cutProject(), 'S~g');
  assert.equal(g.replay, true, '目标卡是 motion 式');
  assert.equal(g.mountFrame, mountFrameOf({ start: 0 }, 30), 'max(0, 段起点 1 − 偏移 1) = 0');
});

/* ================================================================== R02 */

const OWN = '1111111111111111';
const BROWSER = '2222222222222222';
const CODES = { capture: captureCode(ROOT) };
const CODE_VERSION = 'code-version-for-test';

/** 服务端这条链:card plan → 清单计划的流 → 切分给浏览器出的那一份(同 `page-stream-plan.test.mjs`) */
function serverSide(project, value, clips) {
  const wire = JSON.parse(JSON.stringify(value));
  const cache = new CardFrameCache({ root: path.join(os.tmpdir(), 'pc-cut-below-split'), project, envFingerprint: OWN });
  const cardIdOf = new Map(wire.graph.nodes.map(node => [node.id, node.cardId ?? null]));
  const cardPlan = cache.plan(wire).map(control => ({ ...control, cardId: cardIdOf.get(control.nodeId) ?? null }));
  const entry = { key: 'entry-cut', project, cardPlan };
  const specs = planListStreams(entry, clips, { codeVersion: `${STREAM_CODE_VERSION}:${CODES.capture}`, envFingerprint: OWN });
  const planTask = clipsPlanTaskOf({ projectId: project.id, projectRev: 7, clips, codeVersion: CODE_VERSION });
  const tasks = splitPlan({
    planTask, entryKey: entry.key, cardPlan, prerenderSet: new Set(clips),
    streams: specs.map(queueStreamOf).map(s => ({ ...s, browserOnly: true })),
    envFingerprint: OWN, codeVersion: CODE_VERSION, browserFingerprints: [BROWSER],
    weightOf: control => ({ class: ['belowDependent', 'unknown'].includes(control?.compositing ?? control?.capabilities?.compositing) ? 'heavy' : 'medium', estMs: null }),
  }).filter(t => t.kind === 'stream');
  return { specs, tasks, planTask };
}

/** 剪辑段里的重卡:独立卡(平面的)、外框三维的独立卡、毛玻璃 */
function r02Project() {
  const p = cutProject();
  const B = p.cuts.find(c => c.id === 'B');
  B.tracks.push({ id: 'b-3d', clips: [{ id: 'd3', cardId: 'caption-track', start: 0, end: 8, params: { text: 'd3' }, frame: { x: 0, y: 0, w: 300, h: 200, rotateY: 30 } }] });
  return p;
}

test('CB-split 切分方给浏览器出剪辑段里平面独立卡的那一份;外框三维的、依赖下层的不给', () => {
  const p = r02Project();
  const clips = ['S~up', 'S~m', 'S~S2~cc', 'S~d3', 'S~g'];
  const { specs, tasks } = serverSide(p, pageValueOf(p), clips);
  assert.ok(specs.some(s => s.topClipId === 'S~d3' && s.solo === 'flat'), '三维外框的那张照旧是切分方自己的 solo flat 单卡流');
  const forBrowser = new Set(tasks.filter(t => t.requires.envFingerprint === BROWSER).map(t => t.input.clipId));
  for (const id of ['S~up', 'S~m', 'S~S2~cc']) assert.ok(forBrowser.has(id), `${id} 有浏览器那一份:${[...forBrowser].join(' ')}`);
  assert.ok(!forBrowser.has('S~d3'), '外框三维的不给浏览器');
  assert.ok(!forBrowser.has('S~g'), '依赖下层的不给浏览器(和顶层一样)');
  const m = tasks.find(t => t.input.clipId === 'S~m');
  assert.equal(m.input.stream.kind, 'card');
  assert.equal(m.input.stream.plane, 'local');
  assert.equal(m.input.bake.sampling.firstFrame, 60, '露出窗口 [2, 6) 秒的第一帧');
});

test('CB-page 本页产流的计划也算剪辑段里的平面独立卡,键与切分方给浏览器那一份逐字段相同', async () => {
  const p = r02Project();
  const value = pageValueOf(p);
  const clips = ['S~up', 'S~m', 'S~S2~cc', 'S~d3', 'S~g'];
  const server = serverSide(p, value, clips);
  const page = await planPageStreams({ project: p, value, clips, codes: CODES, envFingerprint: BROWSER });
  const ids = page.specs.map(s => s.topClipId).sort();
  assert.deepEqual(ids, ['S~S2~cc', 'S~m', 'S~up'], `页面产这三条:${JSON.stringify(page.skipped)}`);
  assert.equal(page.skipped['S~d3'], 'frame-3d');
  assert.equal(page.skipped['S~g'], 'not-independent');
  for (const got of page.specs) {
    const want = server.specs.find(s => s.topClipId === got.topClipId);
    assert.ok(want, got.topClipId);
    assert.equal(got.contentKey, want.contentKey, `${got.topClipId} 内容键与切分方相同`);
    assert.equal(got.streamKey, serverResultKeyOf(want.contentKey, BROWSER));
    for (const field of ['kind', 'plane', 'firstFrame', 'lastFrame', 'firstSegment', 'lastSegment', 'originFrame']) assert.deepEqual(got[field], want[field], `${got.topClipId}.${field}`);
    assert.deepEqual(got.bound, want.bound);
    assert.deepEqual(got.offset, want.offset);
  }
  // 流任务与切分方给浏览器出的那一份相同
  const norm = v => JSON.parse(JSON.stringify(v));
  const mine = page.specs.flatMap(spec => pageStreamTasks(spec, { projectId: p.id, projectRev: 7, codeVersion: CODE_VERSION, derivedFrom: server.planTask.id }));
  for (const t of mine) {
    const theirs = server.tasks.find(x => x.id === t.id);
    assert.ok(theirs, `切分方也出了 ${t.id}`);
    assert.deepEqual(norm(t.input), norm(theirs.input), `${t.id} 的 input`);
    assert.deepEqual(norm(t.range), norm(theirs.range));
  }
});

test('CB-bake 浏览器那一份的隔离工程带着剪辑段链;顶层卡照旧', async () => {
  const { isolatedBakeProject } = await import('../../src/online/bakeTask.ts');
  const p = cutProject();
  const input = { clipId: 'S~m', start: 2, end: 6, count: 120, sampling: { firstFrame: 60, phase: { numerator: '0', denominator: '1' } } };
  const iso = isolatedBakeProject(p, input);
  assert.deepEqual(iso.tracks.filter(t => !t.hidden).flatMap(t => t.clips).map(c => c.id), ['S'], '顶层只留剪辑段');
  const B = iso.cuts.find(c => c.id === 'B');
  assert.deepEqual(B.tracks.filter(t => !t.hidden).flatMap(t => t.clips).map(c => c.id), ['m'], '剪辑里只留目标卡');
  assert.equal(iso.tracks.find(t => !t.hidden).clips[0].start, 1, '时间不平移');
  // 顶层卡照旧是平移到 -phase 的那一份
  const top = isolatedBakeProject(p, { clipId: 'over', start: 0, end: 8, count: 240, sampling: { firstFrame: 0, phase: { numerator: '0', denominator: '1' } } });
  assert.deepEqual(top.tracks.filter(t => !t.hidden).flatMap(t => t.clips).map(c => [c.id, c.start]), [['over', 0]]);
});
