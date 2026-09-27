/**
 * 按哈希把本地内容库里已有的素材交给上传队列(C10a 集成返工:开启「放云端」时,开启前就在项目里的素材也要上云)。
 * 跑:node --test server/test/upload-enqueue-existing.test.mjs
 *
 * `enqueueLocalMedia`(`server/upload-queue.mjs`)接 `POST /api/media/upload-queue/enqueue` 的请求体;队列用真的
 * `createUploadQueue`(只在内存,目标是一个记录用的假素材服务客户端),看进队的档位、先小后大、只收本地有的、缺的回报。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createUploadQueue, enqueueLocalMedia } from '../upload-queue.mjs';

const h = (c) => c.repeat(64);
const V_ORIG = h('a'), V_SMALL = h('b'), IMG = h('c'), GONE = h('d'), GONE_SMALL = h('e');
const LOCAL = new Map([[V_ORIG, `/lib/${V_ORIG}.mp4`], [V_SMALL, `/lib/${V_SMALL}.mp4`], [IMG, `/lib/${IMG}.png`]]);
const resolveFile = (hash) => LOCAL.get(hash) ?? null;

function queueWith({ remote = true } = {}) {
  const client = { putFile: async () => ({ uploaded: true, sent: 1 }), chunks: async () => ({ complete: true }) };
  return createUploadQueue({ file: null, target: () => (remote ? { client, base: 'http://h/api/asset' } : null), resolveFile });
}

test('UQE-1 视频两档按先小后大进队,图片只有原片一档;扩展名取本地文件的', async () => {
  const q = queueWith();
  const r = await enqueueLocalMedia(q, { items: [{ name: 'v.mp4', original: V_ORIG, small: V_SMALL }, { name: 'i.png', original: IMG }] }, resolveFile);
  assert.deepEqual(r, { queued: [V_ORIG, IMG], missing: [], bad: 0, local: false });
  const s = q.stats();
  assert.deepEqual(s.items.map((i) => [i.id, i.tiers]), [[V_ORIG, ['small', 'original']], [IMG, ['original']]]);
});

test('UQE-2 只收本地有的:原片没有 → 整个素材不进队、回报缺失;小版没有 → 只传原片、回报小版缺失', async () => {
  const q = queueWith();
  const r = await enqueueLocalMedia(q, { items: [{ original: GONE, small: V_SMALL }, { original: V_ORIG, small: GONE_SMALL }] }, resolveFile);
  assert.deepEqual(r.queued, [V_ORIG]);
  assert.deepEqual(r.missing, [GONE, GONE_SMALL]);
  assert.deepEqual(q.stats().items.map((i) => [i.id, i.tiers]), [[V_ORIG, ['original']]]);
});

test('UQE-3 也收 { hashes }(每个当原片一档);形状不对的计 bad;同一原片再进队只合并档位', async () => {
  const q = queueWith();
  const r = await enqueueLocalMedia(q, { hashes: [V_ORIG, 'not-a-hash', IMG] }, resolveFile);
  assert.deepEqual(r, { queued: [V_ORIG, IMG], missing: [], bad: 1, local: false });
  await enqueueLocalMedia(q, { items: [{ original: V_ORIG, small: V_SMALL }] }, resolveFile);
  const s = q.stats();
  assert.equal(s.merged, 1);
  assert.deepEqual(s.items[0].tiers, ['small', 'original'], '合并后仍先小后大');
});

test('UQE-4 当前连的是本机素材服务(队列空操作):回 local,什么都不进', async () => {
  const q = queueWith({ remote: false });
  const r = await enqueueLocalMedia(q, { items: [{ original: V_ORIG }, { original: IMG }] }, resolveFile);
  assert.equal(r.local, true);
  assert.deepEqual(r.queued, []);
  assert.equal(q.stats().items.length, 0);
});
