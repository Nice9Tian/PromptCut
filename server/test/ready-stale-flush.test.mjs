/**
 * 疑点 F:`flushSnapshots` 在 `adoptCardPlan` 换了一版项目(reset 了就绪索引)之后,
 * 还会把**旧 entry** 那一批的层发布出去 —— 页面刚清完表,又收到旧键的层,
 * 同一个 clipId 的新层被旧层整层替换(C3 是全量语义)。跑:node --test server/test/ready-stale-flush.test.mjs
 *
 * 真的:`ready-index.mjs`、`FramePipeline.prototype` 上的 `adoptCardPlan` / `publishLayer` / `flushSnapshots`。
 * 假的:快照库的批(`close()` 直接回一份 index),不碰 Chrome、不碰盘。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { FramePipeline } from '../frame-pipeline.mjs';
import { createReadyIndex } from '../ready-index.mjs';

const control = (clipId, snapshotKey) => ({ clipId, snapshotKey, tier: 'shared', capabilities: { frameMode: 'stateful', compositing: 'independent' } });
const fakeBatch = (clipId, key) => ({ clipId, key, tier: 'shared', entryKey: undefined, written: true, close: async () => ({ frames: [[0, 9]] }) });

function pipelineWith(readyIndex) {
  return {
    readyIndex,
    prerenderPicked: FramePipeline.prototype.prerenderPicked,
    adoptCardPlan: FramePipeline.prototype.adoptCardPlan,
    publishLayer: FramePipeline.prototype.publishLayer,
    flushSnapshots: FramePipeline.prototype.flushSnapshots,
  };
}

test('换了一版项目之后,旧 entry 攒着的那一批不再发布到就绪索引', async () => {
  const readyIndex = createReadyIndex();
  const seen = [];
  readyIndex.subscribe((m) => seen.push(m));
  const pipeline = pipelineWith(readyIndex);

  // 第一版:卡 h 的共享键 KA,后台正在攒一批
  const entryA = { key: 'E1', project: { fps: 30 } };
  pipeline.adoptCardPlan(entryA, [control('h', 'KA')]);
  entryA.snapshotPending = new Map([['a', fakeBatch('h', 'KA')]]);

  // 用户改了卡的参数:第二版,h 的共享键换成 KB,页面清表并收到新层
  const entryB = { key: 'E2', project: { fps: 30 } };
  pipeline.adoptCardPlan(entryB, [control('h', 'KB')]);
  pipeline.publishLayer(control('h', 'KB'), 'shared', [[0, 4]]);
  seen.length = 0;

  // 旧 entry 的那一批这时才交完
  await pipeline.flushSnapshots(entryA);
  const stale = seen.filter((m) => m.type === 'layer' && m.key === 'KA');
  assert.deepEqual(stale, [], `旧版的层不该在 reset 之后再发出去:${JSON.stringify(seen)}`);
  assert.equal(readyIndex.list().find((l) => l.clipId === 'h')?.key, 'KB', '就绪索引里 h 仍是新版的键');
});

test('当前这一版自己的批照常发布', async () => {
  const readyIndex = createReadyIndex();
  const pipeline = pipelineWith(readyIndex);
  const entry = { key: 'E1', project: { fps: 30 } };
  pipeline.adoptCardPlan(entry, [control('h', 'KA')]);
  entry.snapshotPending = new Map([['a', fakeBatch('h', 'KA')]]);
  await pipeline.flushSnapshots(entry);
  assert.deepEqual(readyIndex.list().find((l) => l.clipId === 'h')?.ranges, [[0, 9]]);
});
