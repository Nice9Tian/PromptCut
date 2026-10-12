/**
 * 片段外面套了一层(挂强调、滤镜)时,经队列切分的那一步要认得出里面是哪张卡。
 *
 * 卡片图(`src/kernel/cardGraph.mjs` 的 `projectCardGraph`)给这种片段的输出节点是外面那一层(`@clip/<id>/emphasis`、
 * `@clip/<id>/filter`),卡片自己在它的 `inputs.source` 后面。`server/frame-pipeline.mjs` 的 `planForQueue` 给控件补
 * `cardId` 时原先只看输出节点,补出来是 null;`server/render-node/split.mjs` 靠它判「给不给浏览器节点」「要哪张卡的代码」
 * 「是不是用户卡」,于是套了一层的片段都判错。
 *
 * 这里同一张卡放三个片段(不挂、挂强调、挂滤镜;同一时刻起止),照 `planForQueue` 的拼法出控件、切分,断言三个片段的
 * 任务除了键以外逐项相同:每一份的指纹、段、`requires.cardSources`、`requires.userCards`、`input.cardId`、带不带页面要的输入。
 *
 *   WC-01  Lottie 素材卡:不给浏览器节点,挂了强调、滤镜也不给
 *   WC-02  改过源码的内置卡(改动层):任务要这张卡的代码身份,挂了也要;不给浏览器节点
 *   WC-03  用户卡:`requires.userCards` 为真、要全部定制卡的代码,挂了也一样
 *   WC-04  普通内置卡:给浏览器节点,`input.cardId` 是这张卡,挂了也一样
 *
 * 跑:npm test -- server/test/wrapped-cardid-split.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CardFrameCache } from '../card-cache.mjs';
import { planStreams, queueStreamOf } from '../frame-stream.mjs';
import { splitPlan } from '../render-node/split.mjs';
import { snapshotTier } from '../snapshot-store.mjs';
import { projectCardGraph } from '../../src/kernel/cardGraph.mjs';
import { clipsPlan } from './m7-kit.mjs';

const OWN = '1111111111111111';
const BR = '2222222222222222';
const ENVIRONMENT = { width: 1920, height: 1080, fps: 30, theme: 'dark', fontFingerprint: 'ff00ff00' };

/** `lottie`、`punch-pill` 在审阅表里是独立卡(共享档);`my-card` 不在表里(用户卡,按未知处理,本地档) */
const DEFS = {
  lottie: { id: 'lottie', defaults: { src: '' } },
  'punch-pill': { id: 'punch-pill', defaults: { text: '' } },
  'focus-card': { id: 'focus-card', defaults: { text: '' } },
  'my-card': { id: 'my-card', defaults: { text: '' } },
};
const getCard = id => DEFS[id];
const SOURCE_VERSIONS = { lottie: 'builtin:lottie-v1', 'punch-pill': 'builtin:pill-v1', 'focus-card': 'builtin:focus-v1', 'my-card': 'user:mine-v1' };

const EMPHASIS = { kind: 'outline', color: '#ffffff', size: 6 };
const FILTERS = [{ id: 'f-warm', name: '暖色', ops: [{ op: 'sepia', amount: 0.4 }] }];
const FRAME = { x: 200, y: 200, w: 400, h: 240 };

/** 三条序列各一个片段,同一时刻起止:不挂、挂强调、挂滤镜 */
const projectOf = (card, extra = {}) => ({
  id: 'p', width: 1920, height: 1080, fps: 30, duration: 4, themeId: 'dark', style: {},
  media: [], filters: FILTERS, audioFx: [], pixelMaps: [], cardNodes: [],
  ...extra,
  tracks: [
    { id: 'tr-bare', hidden: false, clips: [{ id: 'clip-bare', start: 1, end: 3, frame: FRAME, ...card }] },
    { id: 'tr-emph', hidden: false, clips: [{ id: 'clip-emph', start: 1, end: 3, frame: FRAME, ...card, emphasis: EMPHASIS }] },
    { id: 'tr-filt', hidden: false, clips: [{ id: 'clip-filt', start: 1, end: 3, frame: FRAME, ...card, filter: { id: 'f-warm', params: {} } }] },
  ],
});

/** `FramePipeline.queueHandles` */
const queueHandles = control => {
  if (!control?.snapshotKey || !control.clipId) return false;
  const tier = control.tier || snapshotTier(control.capabilities);
  return tier === 'local' || (tier === 'shared' && control.cacheable === true);
};
/** `FramePipeline.queueWeightClass` */
const weightOf = control => {
  const caps = control?.capabilities ?? {};
  const compositing = control?.compositing ?? caps.compositing;
  if ((control?.tier || snapshotTier(caps)) === 'local') return { class: 'heavy', estMs: null };
  if (caps.canvasHeavy === true || compositing === 'belowDependent' || compositing === 'unknown') return { class: 'heavy', estMs: null };
  return { class: 'medium', estMs: null };
};

/** `planForQueue` 给控件补卡片 id 的那一步(改之前的写法:只看输出节点) */
function queueCardPlan(controls, graph) {
  const cardIdOf = new Map((graph?.nodes ?? []).map(node => [node?.id, node?.cardId ?? null]));
  return controls.filter(queueHandles).map(control => ({ ...control, cardId: control.cardId ?? cardIdOf.get(control.nodeId) ?? null }));
}
/** `planForQueue` 的 `isUserCard`(改之前的写法) */
const isUserCardOf = sourceVersions => control => String(sourceVersions[control?.cardId] ?? '').startsWith('user:');

/** 照 `planForQueue` 拼出切分的输入,切分;`cardSources` 是这一版用到的定制卡的代码身份(`entry.cardSources`) */
function splitOf(card, { cardSources = {}, sourceVersions = SOURCE_VERSIONS, extra } = {}) {
  const project = projectOf(card, extra);
  const graph = projectCardGraph(project, getCard);
  const controls = new CardFrameCache({ root: 'unused', project, envFingerprint: OWN }).plan({ graph, sourceVersions, environment: ENVIRONMENT });
  const cardPlan = queueCardPlan(controls, graph);
  const streams = planStreams({ project, cardPlan: controls }, { envFingerprint: OWN, codeVersion: 'test-code', budget: 8, below: false }).map(queueStreamOf);
  const tasks = splitPlan({
    planTask: clipsPlan({ clips: cardPlan.map(control => control.clipId) }), entryKey: 'entry-1', cardPlan, prerenderSet: null, streams,
    envFingerprint: OWN, codeVersion: 'cv-1', cardSourceVersions: cardSources, weightOf, isUserCard: isUserCardOf(sourceVersions),
    browser: { nodeId: 'n-br', envFingerprint: BR },
  });
  return { controls, cardPlan, streams, tasks };
}

/** 一个片段的任务,去掉键以后的样子(键本来就各不相同:外面那一层在键里) */
function shapeOf(tasks, clipId) {
  return tasks.filter(task => task.input.clipId === clipId).map(task => ({
    kind: task.kind, tier: task.tier ?? null, fingerprint: task.requires.envFingerprint, range: task.range,
    cardId: task.input.cardId, cardSources: task.requires.cardSources, userCards: task.requires.userCards, graphCards: task.requires.graphCards,
    transcode: task.requires.transcode, dual: task.input.dual === true, forBrowser: 'bake' in task.input, weight: task.weight.class,
  })).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
}
const browserTasks = (tasks, clipId) => tasks.filter(task => task.input.clipId === clipId && task.requires.envFingerprint === BR);
const WRAPPED = ['clip-emph', 'clip-filt'];

/** 三个片段的任务逐项相同;回不挂的那个片段的样子 */
function assertSame(tasks) {
  const bare = shapeOf(tasks, 'clip-bare');
  assert.ok(bare.length > 0, '不挂的片段要有任务');
  for (const clipId of WRAPPED) assert.deepEqual(shapeOf(tasks, clipId), bare, `${clipId} 的任务要和不挂的片段逐项相同`);
  return bare;
}

test('WC-01 Lottie 素材卡:挂了强调、滤镜也不给浏览器节点', () => {
  const { cardPlan, tasks } = splitOf({ cardId: 'lottie', params: { src: 'a.json' } });
  for (const control of cardPlan) assert.equal(control.tier, 'shared', `${control.clipId} 是共享档`);
  assert.equal(browserTasks(tasks, 'clip-bare').length, 0, '不挂的不给浏览器');
  for (const clipId of WRAPPED) assert.equal(browserTasks(tasks, clipId).length, 0, `${clipId} 不给浏览器`);
  const bare = assertSame(tasks);
  for (const item of bare.filter(item => item.kind === 'snapshot')) assert.equal(item.cardId, 'lottie');
});

test('WC-02 改过源码的内置卡:挂了也要这张卡的代码身份,不给浏览器节点', () => {
  const cardSources = { 'punch-pill': 'override:abc', 'focus-card': 'override:def' };
  const { cardPlan, tasks } = splitOf({ cardId: 'punch-pill', params: { text: '甲' } }, { cardSources });
  for (const control of cardPlan) assert.equal(control.tier, 'shared', `${control.clipId} 是共享档`);
  const bare = assertSame(tasks);
  // 共享档只要这一张卡的;没有这份代码的节点不认领
  for (const item of bare.filter(item => item.kind === 'snapshot')) assert.deepEqual(item.cardSources, { 'punch-pill': 'override:abc' });
  for (const clipId of ['clip-bare', ...WRAPPED]) assert.equal(browserTasks(tasks, clipId).length, 0, `${clipId} 不给浏览器`);
});

test('WC-03 用户卡:挂了也算用户卡、要定制卡的代码', () => {
  const cardSources = { 'my-card': 'user:mine-v1' };
  const { tasks } = splitOf({ cardId: 'my-card', params: { text: '甲' } }, { cardSources });
  const bare = assertSame(tasks);
  const snapshots = bare.filter(item => item.kind === 'snapshot');
  assert.ok(snapshots.length > 0);
  for (const item of snapshots) {
    assert.equal(item.userCards, true);
    assert.equal(item.cardId, 'my-card');
    assert.deepEqual(item.cardSources, cardSources);
  }
  for (const clipId of ['clip-bare', ...WRAPPED]) assert.equal(browserTasks(tasks, clipId).length, 0, `${clipId} 不给浏览器`);
});

test('WC-04 普通内置卡:挂了也给浏览器节点,input.cardId 是这张卡', () => {
  const { tasks } = splitOf({ cardId: 'punch-pill', params: { text: '甲' } });
  const bare = assertSame(tasks);
  for (const item of bare.filter(item => item.kind === 'snapshot')) {
    assert.equal(item.cardId, 'punch-pill');
    assert.deepEqual(item.cardSources, {});
    assert.equal(item.userCards, false);
  }
  for (const clipId of ['clip-bare', ...WRAPPED]) assert.ok(browserTasks(tasks, clipId).some(task => task.kind === 'snapshot'), `${clipId} 的快照给浏览器`);
});
