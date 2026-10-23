/**
 * 手机版缩略时间轴的主要内容(`mainContent.ts` 文件头的两步取法):任何项目形状都取得出块、两端都有块、
 * 同一时刻只有一块、块按时间排、当前帧标记的换算不坏。任务书 `docs/plan/mobile-thumbstrip-task.md` 验收 1～4。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mainClipsOf, mainTrackOf, planReorder, timeAtCardPos, cardPosAtTime } from './mainContent.ts';

const media = [
  { id: 'mv', kind: 'video', name: '海浪.mp4', url: 'x' },
  { id: 'mi', kind: 'image', name: '合照.jpg', url: 'y' },
  { id: 'ma', kind: 'audio', name: '吉他.mp3', url: 'z' },
];
const project = (tracks, transitions = []) => ({ version: 1, name: 'p', width: 1920, height: 1080, fps: 30, duration: 30, themeId: 'm', media, tracks, transitions, cuts: [{ id: 'k1', name: '片头' }] });
const clip = (id, start, end, extra = {}) => ({ id, cardId: 'c', start, end, params: {}, ...extra });
const vid = (id, start, end, extra = {}) => clip(id, start, end, { cardId: '', mediaId: 'mv', ...extra });
const span = (cs) => cs.map((c) => [c.id, c.start, c.end]);

/** 每个形状都要成立的几条:不空、第一块从可见内容的起点开始、最后一块到结尾、按时间排、互不交叉(溶解的两段除外) */
function shapeOk(p, label, { overlapOk = false } = {}) {
  const m = mainClipsOf(p);
  assert.ok(m.length > 0, `${label}:不该是空的`);
  const vis = p.tracks.filter((t) => !t.hidden).flatMap((t) => t.clips).filter((c) => c.mediaId !== 'ma');
  assert.equal(m[0].start, Math.min(...vis.map((c) => c.start)), `${label}:第一块从最早的可见内容开始`);
  assert.equal(Math.max(...m.map((c) => c.end)), Math.max(...vis.map((c) => c.end)), `${label}:最后一块到结尾`);
  for (let i = 1; i < m.length; i++) {
    assert.ok(m[i].start >= m[i - 1].start, `${label}:按时间排`);
    if (!overlapOk) assert.ok(m[i].start >= m[i - 1].end - 1e-6, `${label}:同一时刻只有一块`);
  }
  // 当前帧标记:两端的时刻落在第一块开头、最后一块结尾;中间的换算来回一致
  assert.equal(timeAtCardPos(m, 0), m[0].start);
  assert.equal(timeAtCardPos(m, m.length), m[m.length - 1].end);
  if (!overlapOk) {
    for (const c of m) {
      const mid = (c.start + c.end) / 2;
      assert.ok(Math.abs(timeAtCardPos(m, cardPosAtTime(m, mid)) - mid) < 1e-9, `${label}:${c.id} 中点来回换算一致`);
    }
  }
  return m;
}

test('MCA1 只有卡片段:层叠的卡片按「这一刻最长的那段」取,同一时刻只留一块', () => {
  const p = project([
    { id: 't1', name: '字', clips: [clip('title', 0, 2), clip('sub', 5, 6)] },
    { id: 't2', name: '底', clips: [clip('bg', 0, 8)] },
  ]);
  const m = shapeOk(p, '只有卡片');
  assert.deepEqual(span(m), [['bg', 0, 8]], '底下 8 秒的背景卡盖住了整条,上面的字卡不冒出来');
});

test('MCA2 只有卡片段,一段接一段在不同序列上:全部按时间接起来', () => {
  const p = project([
    { id: 't1', name: '上', clips: [clip('b', 3, 5)] },
    { id: 't2', name: '下', clips: [clip('a', 0, 3), clip('c', 5, 9)] },
  ]);
  assert.deepEqual(span(shapeOk(p, '卡片接力')), [['a', 0, 3], ['b', 3, 5], ['c', 5, 9]]);
});

test('MCA3 只有一个段:视频一段、卡片一段、很短的卡片一段都取得到', () => {
  assert.deepEqual(span(shapeOk(project([{ id: 't', name: 's', clips: [vid('v', 0, 4)] }]), '一段视频')), [['v', 0, 4]]);
  assert.deepEqual(span(shapeOk(project([{ id: 't', name: 's', clips: [clip('k', 0, 4)] }]), '一段卡片')), [['k', 0, 4]]);
  assert.deepEqual(span(shapeOk(project([{ id: 't', name: 's', clips: [clip('k', 0, 0.2)] }]), '0.2 秒的卡片')), [['k', 0, 0.2]]);
  assert.deepEqual(mainClipsOf(project([{ id: 't', name: 's', clips: [] }])), [], '一段都没有时为空(标题行提示添加素材)');
});

test('MCA4 段之间有空档:空档里有别的段就补,补进来的只取落在空档里的那一截;空档里什么都没有就留着', () => {
  const p = project([
    { id: 't1', name: '上', clips: [clip('intro', 0, 3), clip('mid', 5, 9), clip('outro', 11, 14)] },
    { id: 't2', name: '下', clips: [vid('v1', 2, 6), vid('v2', 8, 12)] },
  ]);
  const m = shapeOk(p, '空档');
  assert.deepEqual(span(m), [['intro', 0, 2], ['v1', 2, 6], ['mid', 6, 8], ['v2', 8, 12], ['outro', 12, 14]]);
  assert.equal(mainTrackOf(p).id, 't2');
  // 没有东西可补的空档:不补,块之间照旧有空档(标记落在空档里算下一段开头)
  const bare = project([{ id: 't', name: 's', clips: [vid('a', 0, 2), vid('b', 5, 7)] }]);
  assert.deepEqual(span(mainClipsOf(bare)), [['a', 0, 2], ['b', 5, 7]]);
  // 补进来的视频段剪掉了开头,入点跟着往后挪,缩略图取的是这一截开头那一帧
  const pip = project([
    { id: 't1', name: '上', clips: [vid('over', 0, 6, { mediaOffset: 1 })] },
    { id: 't2', name: '下', clips: [vid('main', 0, 3)] },
  ]);
  const over = mainClipsOf(pip).find((c) => c.id === 'over');
  assert.deepEqual([over.start, over.end, over.mediaOffset], [3, 6, 4]);
  assert.equal(pip.tracks[0].clips[0].start, 0, '项目里的段没被改');
});

test('MCA5 短于门槛的空档不补;声音段、隐藏序列上的段不补', () => {
  const p = project([
    { id: 'th', name: '藏', hidden: true, clips: [clip('hid', 4, 10)] },
    { id: 'ta', name: '声', clips: [clip('music', 0, 12, { cardId: '', mediaId: 'ma' })] },
    { id: 't1', name: '上', clips: [clip('blip', 4, 4.3), clip('tail', 10, 12)] },
    { id: 't2', name: '下', clips: [vid('a', 0, 4), vid('b', 4.3, 10)] },
  ]);
  assert.deepEqual(span(mainClipsOf(p)), [['a', 0, 4], ['b', 4.3, 10], ['tail', 10, 12]]);
});

test('MCA6 时长相同挑序列更靠下的;更长的优先', () => {
  const tie = project([
    { id: 't1', name: '上', clips: [clip('up', 0, 3)] },
    { id: 't2', name: '下', clips: [clip('down', 0, 3)] },
  ]);
  assert.deepEqual(span(mainClipsOf(tie)), [['down', 0, 3]]);
  const longer = project([
    { id: 't1', name: '上', clips: [clip('long', 0, 5)] },
    { id: 't2', name: '下', clips: [clip('short', 0, 3)] },
  ]);
  assert.deepEqual(span(mainClipsOf(longer)), [['long', 0, 5]]);
});

test('MCA7 有转场:溶解过去的后一段照旧算;只有卡片的溶解也取得到两段', () => {
  const p = project([
    { id: 't1', name: '上', clips: [vid('v2', 3.5, 7)] },
    { id: 't2', name: '下', clips: [vid('v1', 0, 4)] },
  ], [{ id: 'x', kind: 'crossfade', aId: 'v1', bId: 'v2', dur: 0.5 }]);
  assert.deepEqual(span(shapeOk(p, '视频溶解', { overlapOk: true })), [['v1', 0, 4], ['v2', 3.5, 7]]);
  const cards = project([
    { id: 't1', name: '上', clips: [clip('k2', 2.5, 6)] },
    { id: 't2', name: '下', clips: [clip('k1', 0, 3)] },
  ], [{ id: 'x', kind: 'crossfade', aId: 'k1', bId: 'k2', dur: 0.5 }]);
  assert.deepEqual(span(shapeOk(cards, '卡片溶解')), [['k1', 0, 3], ['k2', 3, 6]]);
});

test('MCA8 有剪辑段嵌套:剪辑段是主要内容,前后的卡片补到两端', () => {
  const p = project([
    { id: 't1', name: '上', clips: [clip('open', 0, 2), clip('end', 7, 9)] },
    { id: 't2', name: '下', clips: [clip('k', 2, 7, { cardId: '', cutId: 'k1' })] },
  ]);
  assert.deepEqual(span(shapeOk(p, '剪辑段')), [['open', 0, 2], ['k', 2, 7], ['end', 7, 9]]);
});

test('MCA9 换顺序:补进来的段(不在主轨上或只取了一截)不能挪,主轨上的段照常挪', () => {
  const p = project([
    { id: 't1', name: '上', clips: [clip('card', 4, 6)] },
    { id: 't2', name: '下', clips: [vid('a', 0, 2), vid('b', 2, 4)] },
  ]);
  assert.deepEqual(mainClipsOf(p).map((c) => c.id), ['a', 'b', 'card']);
  assert.deepEqual(planReorder(p, ['b', 'a', 'card']), { moves: [{ id: 'b', start: 0 }, { id: 'a', start: 2 }] });
  assert.ok('error' in planReorder(p, ['card', 'a', 'b']));
});

test('MCA10 一段垫底的长卡片可以在几处空档各补一截,两端都有块', () => {
  const p = project([
    { id: 't1', name: '上', clips: [vid('v1', 2, 5), vid('v2', 7, 10)] },
    { id: 't2', name: '底', clips: [clip('bg', 0, 12)] },
  ]);
  assert.equal(mainTrackOf(p).id, 't1');
  assert.deepEqual(span(shapeOk(p, '垫底卡片')), [['bg', 0, 2], ['v1', 2, 5], ['bg', 5, 7], ['v2', 7, 10], ['bg', 10, 12]]);
});
