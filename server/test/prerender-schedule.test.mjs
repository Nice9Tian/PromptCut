/**
 * C4 的服务端消费侧(4 帧批次边界读 `wanted`、把含它的批提前)和预渲染集合的
 * 窄接口。跑:node --test server/test/prerender-schedule.test.mjs
 *
 * `nextBatchStart` 只在批与批之间被调 —— 它**不打断正在跑的那一批**,只决定
 * 下一批从哪儿开始。直接拿 `FramePipeline.prototype` 上的那两个方法配一个最小
 * 假对象跑:这一段不碰 Chrome。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { FramePipeline } from '../frame-pipeline.mjs';
import { declaredHeavy, prerenderSetOf, prerenderSetOfPlan } from '../prerender-set.mjs';

const control = (clipId, count, firstFrame = 0) => ({ clipId, count, sampling: { firstFrame } });
const scheduler = wanted => ({
  playhead: () => ({ t: 0, playing: true, wanted }),
  playheadWanted: FramePipeline.prototype.playheadWanted,
  nextBatchStart: FramePipeline.prototype.nextBatchStart,
});

test('没有 wanted 时就是顺序批', () => {
  const pipeline = scheduler(undefined);
  const pending = new Set([0, 4, 8, 12]);
  assert.equal(pipeline.nextBatchStart(pending, control('a', 16)), 0);
  pending.delete(0);
  assert.equal(pipeline.nextBatchStart(pending, control('a', 16)), 4);
});

test('wanted 落在哪一批,哪一批就提前(本地帧 = 全局帧 - firstFrame)', () => {
  // 片段从全局第 100 帧开始;播放头想要全局第 1000 帧 → 本地 900 → 第 900 批
  const pipeline = scheduler([{ clipId: 'a', frame: 1000 }]);
  const pending = new Set(Array.from({ length: 250 }, (_, i) => i * 4));
  assert.equal(pipeline.nextBatchStart(pending, control('a', 1000, 100)), 900);
  // 901 / 902 / 903 都落在同一批里
  assert.equal(scheduler([{ clipId: 'a', frame: 1003 }]).nextBatchStart(pending, control('a', 1000, 100)), 900);
  // 别的片段的 wanted 不动这张卡的顺序
  assert.equal(scheduler([{ clipId: 'other', frame: 1000 }]).nextBatchStart(pending, control('a', 1000, 100)), 0);
  // 已经产过的那一批不在 pending 里 —— 不重排,回到顺序批
  const done = new Set([0, 4, 8]);
  assert.equal(pipeline.nextBatchStart(done, control('a', 1000, 100)), 0);
  // 片段还没挂载 / 已经退场的帧号丢掉
  assert.equal(scheduler([{ clipId: 'a', frame: 50 }]).nextBatchStart(pending, control('a', 1000, 100)), 0);
  assert.equal(scheduler([{ clipId: 'a', frame: 99999 }]).nextBatchStart(pending, control('a', 1000, 100)), 0);
  // 读不到播放头(编辑器还没推过)时不抛
  const blind = { playhead: () => { throw new Error('没有镜像'); }, playheadWanted: FramePipeline.prototype.playheadWanted, nextBatchStart: FramePipeline.prototype.nextBatchStart };
  assert.equal(blind.nextBatchStart(pending, control('a', 1000, 100)), 0);
});

test('wanted 指向的正是顺序批时不重排(也就不会刷日志)', () => {
  const pipeline = scheduler([{ clipId: 'a', frame: 2 }]);
  const pending = new Set([0, 4, 8]);
  assert.equal(pipeline.nextBatchStart(pending, control('a', 12)), 0);
});

test('prerenderSetOf 的兜底口径:direct 不产,其余都产(TODO(R4a) 接真的那份)', () => {
  assert.equal(declaredHeavy({ frameMode: 'direct' }), false);
  assert.equal(declaredHeavy({ frameMode: 'stateful' }), true);
  // unknown 也照测照产(计划 3.1(2):按下层依赖卡处理)
  assert.equal(declaredHeavy({ frameMode: 'stateful', compositing: 'unknown' }), true);
  assert.equal(declaredHeavy({ need_prerendering: true }), true);
  assert.equal(declaredHeavy({ needPrerendering: true }), true);
  assert.equal(declaredHeavy({ need_prerendering: true, frameMode: 'direct' }), false, '声明冲突时以 frameMode 为准');
  assert.equal(declaredHeavy(undefined), false);

  assert.deepEqual([...prerenderSetOfPlan([
    { clipId: 'a', capabilities: { frameMode: 'stateful' } },
    { clipId: 'b', capabilities: { frameMode: 'direct' } },
    { clipId: 'c', capabilities: { frameMode: 'stateful', compositing: 'unknown' } },
    { capabilities: { frameMode: 'stateful' } },
  ])], ['a', 'c']);

  const project = { fps: 30, tracks: [{ clips: [
    { id: 'card-1', cardId: 'particles', mode: 'stateful' },
    { id: 'card-2', cardId: 'caption', mode: 'direct' },
    { id: 'media-1' },
  ] }] };
  assert.deepEqual([...prerenderSetOf(project)], ['card-1'], '素材段不进预渲染集合');
});
