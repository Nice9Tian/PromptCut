/**
 * A3a 快照库的单测。跑:node --test server/test/snapshot-store.test.mjs
 *
 * 目录形状是这一层唯一的对外契约(将来上云的那一侧按同一个形状取件),所以路径
 * 逐字钉死、不靠「能读回来就行」:共享档一层键目录、本地档两层(entry.key /
 * 共享键),文件是原始 UTF-8 HTML。index.json 是播放调度每拍都要问的
 * 「哪些本地帧已经有了」,区间合并错一格就会去贴一张不存在的快照。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SnapshotStore, snapshotTier, snapshotDir, mergeRanges, rangeCount, rangeHas, SHARED_DIR, LOCAL_DIR } from '../snapshot-store.mjs';

const withRoot = async body => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-snapshot-store-'));
  try { return await body(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
};

test('directory shape: shared is one level, local is two (entry key / shared key)', () => {
  assert.equal(snapshotDir('R', { tier: 'shared', key: 'K' }), path.join('R', SHARED_DIR, 'K'));
  assert.equal(snapshotDir('R', { tier: 'local', entryKey: 'E', key: 'K' }), path.join('R', LOCAL_DIR, 'E', 'K'));
  // 两层目录,不拼成一个名字 —— 换项目时整棵 <entry.key>/ 一起丢得掉,而共享键那
  // 一层在两种档里同名,将来把某一份提升成共享档只是挪目录。
  assert.notEqual(snapshotDir('R', { tier: 'local', entryKey: 'E', key: 'K' }), path.join('R', LOCAL_DIR, 'E-K'));
  assert.throws(() => snapshotDir('R', { tier: 'local', key: 'K' }), /entry key/);
  assert.throws(() => snapshotDir('R', { tier: 'shared' }), /key is required/);
  assert.throws(() => snapshotDir('R', { tier: 'none', key: 'K' }), /Unknown snapshot tier/);
});

test('tier follows the review table: independent/sourceDependent shared, other stateful local, unknown none', () => {
  const caps = (compositing, frameMode = 'stateful') => ({ compositing, frameMode });
  assert.equal(snapshotTier(caps('independent')), 'shared');
  assert.equal(snapshotTier(caps('sourceDependent')), 'shared');
  // 毛玻璃:结果受下层影响,只能本地档、不上云。
  assert.equal(snapshotTier(caps('belowDependent')), 'local');
  assert.equal(snapshotTier(caps('context')), 'local');
  // 拿不准就不能当死素材贴。
  assert.equal(snapshotTier(caps('unknown')), 'none');
  assert.equal(snapshotTier(caps(undefined)), 'none');
  // 渲染 9:在所有位置都判轻的(非 stateful)不产快照。
  assert.equal(snapshotTier(caps('independent', 'direct')), 'none');
  // 显式声明要预渲染的卡照样算 stateful(审阅表两种写法都认)。
  assert.equal(snapshotTier({ compositing: 'independent', need_prerendering: true }), 'shared');
  assert.equal(snapshotTier({ compositing: 'belowDependent', needPrerendering: true }), 'local');
  assert.equal(snapshotTier(undefined), 'none');
});

test('mergeRanges sorts, merges overlaps and closes one-frame gaps', () => {
  assert.deepEqual(mergeRanges([[3, 4], [0, 1], [2, 2]]), [[0, 4]], 'adjacent ranges are one range');
  assert.deepEqual(mergeRanges([[0, 5], [2, 3]]), [[0, 5]]);
  assert.deepEqual(mergeRanges([[0, 1], [3, 4]]), [[0, 1], [3, 4]], 'a real hole stays a hole');
  // 裸帧号和区间混排。
  assert.deepEqual(mergeRanges([7, [0, 2], 3, 9, 8]), [[0, 3], [7, 9]]);
  // 坏值直接丢掉,不让它把整段区间撑坏。
  assert.deepEqual(mergeRanges([[5, 1], ['a', 'b'], [1.5, 2], null, [0, 0]]), [[0, 0]]);
  assert.deepEqual(mergeRanges(undefined), []);
  assert.equal(rangeCount([[0, 3], [7, 9]]), 7, 'closed intervals: both ends count');
  assert.equal(rangeHas([[0, 3], [7, 9]], 3), true);
  assert.equal(rangeHas([[0, 3], [7, 9]], 5), false);
});

test('put/get round-trips raw UTF-8 HTML in the shared tier and misses return null', async () => withRoot(async root => {
  const store = new SnapshotStore(root);
  const html = '<div data-pc-clip="a">价格 &amp; <span style="width:800px">42</span></div>';
  const file = await store.writeSnapshot({ tier: 'shared', key: 'KEY1', localFrame: 0, html });
  assert.equal(file, path.join(root, SHARED_DIR, 'KEY1', '0.html'));
  // 原始 UTF-8,不 base64、不 deflate:盘上这一个文件就是快照本身。
  assert.equal(await fs.readFile(file, 'utf8'), html);
  assert.equal(await store.readSnapshot({ tier: 'shared', key: 'KEY1', localFrame: 0 }), html);
  // 缺帧返回 null(不抛):缺料那一层透明、播放头不停。
  assert.equal(await store.readSnapshot({ tier: 'shared', key: 'KEY1', localFrame: 9 }), null);
  assert.equal(await store.readSnapshot({ tier: 'shared', key: 'NOPE', localFrame: 0 }), null);
  await assert.rejects(store.writeSnapshot({ tier: 'shared', key: 'KEY1', localFrame: -1, html }), /Invalid local frame/);
}));

test('local tier writes under <root>/controls-local/<entry.key>/<shared key>/ and never collides with shared', async () => withRoot(async root => {
  const store = new SnapshotStore(root);
  await store.writeSnapshot({ tier: 'local', entryKey: 'ENTRY', key: 'KEY1', localFrame: 2, html: 'local' });
  await store.writeSnapshot({ tier: 'shared', key: 'KEY1', localFrame: 2, html: 'shared' });
  assert.equal(await fs.readFile(path.join(root, LOCAL_DIR, 'ENTRY', 'KEY1', '2.html'), 'utf8'), 'local');
  assert.equal(await fs.readFile(path.join(root, SHARED_DIR, 'KEY1', '2.html'), 'utf8'), 'shared');
  // 同一个共享键、两个项目:各自一棵子树。
  await store.writeSnapshot({ tier: 'local', entryKey: 'OTHER', key: 'KEY1', localFrame: 2, html: 'other' });
  assert.equal(await store.readSnapshot({ tier: 'local', entryKey: 'ENTRY', key: 'KEY1', localFrame: 2 }), 'local');
  assert.equal(await store.readSnapshot({ tier: 'local', entryKey: 'OTHER', key: 'KEY1', localFrame: 2 }), 'other');
}));

test('index.json is per key dir, updated per batch, and merges across batches', async () => withRoot(async root => {
  const store = new SnapshotStore(root);
  const target = { tier: 'shared', key: 'KEY1' };
  assert.deepEqual(await store.snapshotIndex(target), { count: 0, frames: [] }, 'no index yet is not an error');
  // fillCardControls 的批大小是 4:写完一批更新一次。
  for (const frame of [0, 1, 2, 3]) await store.writeSnapshot({ ...target, localFrame: frame, html: `f${frame}` });
  assert.deepEqual(await store.updateIndex({ ...target, frames: [0, 1, 2, 3] }), { count: 4, frames: [[0, 3]] });
  for (const frame of [4, 5, 6, 7]) await store.writeSnapshot({ ...target, localFrame: frame, html: `f${frame}` });
  await store.updateIndex({ ...target, frames: [4, 5, 6, 7] });
  // 相邻批次并成一个区间,不是两条。
  assert.deepEqual(await store.snapshotIndex(target), { count: 8, frames: [[0, 7]] });
  // 一段被取消、后来补上的洞:先有 12～13,再补 8～11,最后并成一条。
  for (const frame of [12, 13]) await store.writeSnapshot({ ...target, localFrame: frame, html: `f${frame}` });
  await store.updateIndex({ ...target, frames: [12, 13] });
  assert.deepEqual(await store.snapshotIndex(target), { count: 10, frames: [[0, 7], [12, 13]] });
  for (const frame of [8, 9, 10, 11]) await store.writeSnapshot({ ...target, localFrame: frame, html: `f${frame}` });
  await store.updateIndex({ ...target, frames: [8, 9, 10, 11] });
  assert.deepEqual(await store.snapshotIndex(target), { count: 14, frames: [[0, 13]] });
  const raw = JSON.parse(await fs.readFile(path.join(root, SHARED_DIR, 'KEY1', 'index.json'), 'utf8'));
  assert.deepEqual(raw, { count: 14, frames: [[0, 13]] });
  // index.json 住在键目录里、和帧文件同级:一个键的「有哪些帧」读一个小 JSON 就够,
  // 不用 readdir 几千个文件。
  const names = (await fs.readdir(path.join(root, SHARED_DIR, 'KEY1'))).filter(name => !name.startsWith('.'));
  assert.equal(names.includes('index.json'), true);
  assert.equal(names.filter(name => name.endsWith('.html')).length, 14);
  assert.equal(await store.readSnapshot({ ...target, localFrame: 13 }), 'f13');
}));

test('concurrent batches on one key never lose a range', async () => withRoot(async root => {
  const store = new SnapshotStore(root);
  const target = { tier: 'local', entryKey: 'E', key: 'K' };
  // 读-改-写之间插进另一批就会丢段;`updateIndex` 按目录串行。
  await Promise.all([[0, 1], [2, 3], [4, 5], [10, 11]].map(frames => store.updateIndex({ ...target, frames })));
  assert.deepEqual(await store.snapshotIndex(target), { count: 8, frames: [[0, 5], [10, 11]] });
}));

test('rebuildIndex recovers the index from the frame files on disk', async () => withRoot(async root => {
  const store = new SnapshotStore(root);
  const target = { tier: 'shared', key: 'KEY2' };
  for (const frame of [0, 1, 2, 5]) await store.writeSnapshot({ ...target, localFrame: frame, html: 'x' });
  // 掉过电、index.json 没写成:按盘上实际的 <localFrame>.html 重建。
  assert.deepEqual(await store.rebuildIndex(target), { count: 4, frames: [[0, 2], [5, 5]] });
  assert.deepEqual(await store.snapshotIndex(target), { count: 4, frames: [[0, 2], [5, 5]] });
  assert.deepEqual(await store.rebuildIndex({ tier: 'shared', key: 'ABSENT' }), { count: 0, frames: [] });
}));

/**
 * 整场景路(`record`)写控件 HTML 时必须同时写进快照库。这条是「去向」和「现状」
 * 并存那一段的唯一保障:老的 `entry.controls` → `html-manifest.json` 还在,但新的
 * 目录必须同步长出来,否则第 4 步换读侧的时候盘上一片空。
 *
 * 直接拿 `FramePipeline.prototype` 上的三个方法配一个最小假 entry 跑:这一段不碰
 * Chrome、不碰 ffmpeg,不值得为它起一整条管线。
 */
test('record routes control HTML into the snapshot store, shared and local side by side', async () => withRoot(async root => {
  const { FramePipeline } = await import('../frame-pipeline.mjs');
  const pipeline = { root, _snapshots: new SnapshotStore(root),
    snapshots: FramePipeline.prototype.snapshots,
    snapshotTargets: FramePipeline.prototype.snapshotTargets,
    recordSnapshots: FramePipeline.prototype.recordSnapshots,
    flushSnapshots: FramePipeline.prototype.flushSnapshots };
  const entry = { key: 'ENTRY', cardPlan: [
    { clipId: 'clip-shared', snapshotKey: 'SHARED-KEY', tier: 'shared', capabilities: { compositing: 'independent', frameMode: 'stateful' } },
    // 毛玻璃:只能由整场景路产,走本地档、键目录下再套 entry.key。
    { clipId: 'clip-blur', snapshotKey: 'BLUR-KEY', tier: 'local', capabilities: { compositing: 'belowDependent', frameMode: 'stateful' } },
    // 拿不准的卡不产快照。
    { clipId: 'clip-unknown', snapshotKey: 'U-KEY', tier: 'none', capabilities: { compositing: 'unknown', frameMode: 'stateful' } },
    // 计划里没有共享键的条目(手工构造 / 还没接上键的调用方)直接跳过,不写半张。
    { clipId: 'clip-nokey', capabilities: { compositing: 'independent', frameMode: 'stateful' } },
  ] };
  for (const frame of [0, 1]) {
    pipeline.recordSnapshots(entry, [
      { id: 'clip-shared', frame, html: `<i>shared ${frame}</i>` },
      { id: 'clip-blur', frame, html: `<i>blur ${frame}</i>` },
      { id: 'clip-unknown', frame, html: 'never' },
      { id: 'clip-nokey', frame, html: 'never' },
      { id: 'clip-absent', frame, html: 'never' },        // 图里没有的片段
      { id: 'clip-shared', frame: undefined, html: 'no' }, // 没有本地帧号就没法寻址
    ]);
  }
  await pipeline.flushSnapshots(entry);
  const store = pipeline.snapshots();
  assert.equal(await store.readSnapshot({ tier: 'shared', key: 'SHARED-KEY', localFrame: 1 }), '<i>shared 1</i>');
  assert.equal(await store.readSnapshot({ tier: 'local', entryKey: 'ENTRY', key: 'BLUR-KEY', localFrame: 1 }), '<i>blur 1</i>');
  assert.deepEqual(await store.snapshotIndex({ tier: 'shared', key: 'SHARED-KEY' }), { count: 2, frames: [[0, 1]] });
  assert.deepEqual(await store.snapshotIndex({ tier: 'local', entryKey: 'ENTRY', key: 'BLUR-KEY' }), { count: 2, frames: [[0, 1]] });
  // 共享档目录下不该出现 entry.key 那一层;本地档里也没有 unknown / 无键的卡。
  assert.deepEqual((await fs.readdir(path.join(root, SHARED_DIR))).sort(), ['SHARED-KEY']);
  assert.deepEqual((await fs.readdir(path.join(root, LOCAL_DIR, 'ENTRY'))).sort(), ['BLUR-KEY']);
  // 下一批接着并,不重开一段。
  pipeline.recordSnapshots(entry, [{ id: 'clip-shared', frame: 2, html: '<i>shared 2</i>' }]);
  await pipeline.flushSnapshots(entry);
  assert.deepEqual(await store.snapshotIndex({ tier: 'shared', key: 'SHARED-KEY' }), { count: 3, frames: [[0, 2]] });
  // 没有 cardPlan 的 entry(前台单帧路)什么都不写,也不报错。
  const bare = { key: 'BARE' };
  bare.cardPlan = undefined;
  pipeline.recordSnapshots(bare, [{ id: 'clip-shared', frame: 0, html: 'x' }]);
  await pipeline.flushSnapshots(bare);
  assert.deepEqual((await fs.readdir(path.join(root, LOCAL_DIR))).sort(), ['ENTRY']);
}));
