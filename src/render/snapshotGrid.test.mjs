/**
 * 快照网格的单测。跑:node --test src/render/snapshotGrid.test.mjs
 * 契约:docs/plan/prerender-products-contract.md 第 2.1、2.4 节。
 *
 * 三个纯函数:gridLocalFrames(这一套有哪几帧)、gridWants(某帧在不在)、gridComplete(就绪区间盖住了没有,
 * 能只问一段)。外加一条守门:SNAPSHOT_STRIDE 在仓库里只定义一处。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SNAPSHOT_STRIDE, gridComplete, gridLocalFrames, gridWants } from './snapshotGrid.mjs';
import { pickSnapshotFrame, segmentStartOf } from './snapshotPick.mjs';

test('stride is 15', () => {
  assert.equal(SNAPSHOT_STRIDE, 15);
});

test('gridLocalFrames: multiples of 15 below count, no anchors', () => {
  assert.deepEqual(gridLocalFrames({ count: 45 }), [0, 15, 30], 'count 是 15 的整数倍:不含 count 本身');
  assert.deepEqual(gridLocalFrames({ count: 46 }), [0, 15, 30, 45]);
  assert.deepEqual(gridLocalFrames({ count: 44 }), [0, 15, 30], 'count 不是 15 的整数倍:末尾不补');
  assert.deepEqual(gridLocalFrames({ count: 16 }), [0, 15]);
  assert.deepEqual(gridLocalFrames({ count: 15 }), [0]);
});

test('gridLocalFrames: count 1 gives only frame 0; invalid count gives nothing', () => {
  assert.deepEqual(gridLocalFrames({ count: 1 }), [0]);
  assert.deepEqual(gridLocalFrames({ count: 0 }), []);
  assert.deepEqual(gridLocalFrames({ count: -3 }), []);
  assert.deepEqual(gridLocalFrames({ count: 2.5 }), []);
  assert.deepEqual(gridLocalFrames({ count: Infinity }), []);
  assert.deepEqual(gridLocalFrames({}), []);
  assert.deepEqual(gridLocalFrames(), []);
});

test('gridLocalFrames: anchors on the grid add nothing, between the grid are added', () => {
  assert.deepEqual(gridLocalFrames({ count: 50, anchors: [0, 15, 30] }), [0, 15, 30, 45], '落在格上:不重复');
  assert.deepEqual(gridLocalFrames({ count: 50, anchors: [0, 7, 22, 22] }), [0, 7, 15, 22, 30, 45], '落在格间:并进来,去重,升序');
  assert.deepEqual(gridLocalFrames({ count: 50, anchors: [40, 7] }), [0, 7, 15, 30, 40, 45], '锚帧乱序也升序');
});

test('gridLocalFrames: anchors outside the card are dropped', () => {
  assert.deepEqual(gridLocalFrames({ count: 40, anchors: [40, 41, 1000] }), [0, 15, 30], '>= count 的丢掉');
  assert.deepEqual(gridLocalFrames({ count: 40, firstFrame: 100, anchors: [0, 50, 99, 140, 141] }), [0, 15, 30], '在卡前面、在卡后面的丢掉');
  assert.deepEqual(gridLocalFrames({ count: 40, anchors: [-5] }), [0, 15, 30]);
  assert.deepEqual(gridLocalFrames({ count: 40, anchors: [3.5, NaN, '7', null] }), [0, 15, 30], '不是整数的丢掉');
});

test('gridLocalFrames: firstFrame shifts anchors to local frames', () => {
  // 全局帧 100 开始的卡,锚帧 100(本地 0)、107(本地 7)、130(本地 30,在格上)、150(本地 50,count 45 之外)
  assert.deepEqual(gridLocalFrames({ count: 45, firstFrame: 100, anchors: [100, 107, 130, 150] }), [0, 7, 15, 30]);
  // 格点永远按本地帧排,不按全局帧排:firstFrame 不是 15 的倍数也一样
  assert.deepEqual(gridLocalFrames({ count: 31, firstFrame: 7 }), [0, 15, 30]);
  assert.deepEqual(gridLocalFrames({ count: 31, firstFrame: 7, anchors: [15] }), [0, 8, 15, 30], '全局 15 = 本地 8');
});

test('gridLocalFrames: the card mount frame as an anchor is the local frame 0 (no duplicate)', () => {
  assert.deepEqual(gridLocalFrames({ count: 20, firstFrame: 33, anchors: [0, 33, 53] }), [0, 15]);
});

test('gridLocalFrames does not mutate its inputs', () => {
  const anchors = [40, 7, 7];
  gridLocalFrames({ count: 50, anchors });
  assert.deepEqual(anchors, [40, 7, 7]);
});

test('gridWants agrees with gridLocalFrames on every frame', () => {
  const cases = [
    { count: 100 },
    { count: 1 },
    { count: 46, anchors: [0, 7, 22, 45] },
    { count: 60, firstFrame: 100, anchors: [100, 107, 130, 159, 160] },
    { count: 15, firstFrame: 5, anchors: [9] },
  ];
  for (const shape of cases) {
    const frames = new Set(gridLocalFrames(shape));
    for (let localFrame = -2; localFrame < shape.count + 3; localFrame += 1) {
      assert.equal(gridWants({ ...shape, localFrame }), frames.has(localFrame), `${JSON.stringify(shape)} 本地帧 ${localFrame}`);
    }
  }
});

test('gridWants: edges', () => {
  assert.equal(gridWants({ count: 45, localFrame: 45 }), false, '等于 count 越界');
  assert.equal(gridWants({ count: 45, localFrame: 30 }), true);
  assert.equal(gridWants({ count: 45, localFrame: 31 }), false);
  assert.equal(gridWants({ count: 45, localFrame: 1.5 }), false);
  assert.equal(gridWants({ count: 45, localFrame: -15 }), false);
  assert.equal(gridWants({ count: 45 }), false, '没给帧');
  assert.equal(gridWants({ count: 0, localFrame: 0 }), false);
  assert.equal(gridWants({ count: 45, firstFrame: 100, anchors: [107], localFrame: 7 }), true);
  assert.equal(gridWants({ count: 45, firstFrame: 100, anchors: [107], localFrame: 107 }), false, '本地帧不能当全局帧用');
});

test('gridComplete: whole set', () => {
  assert.equal(gridComplete({ ranges: [[0, 99]], count: 100 }), true, '逐帧都有:当然齐');
  assert.equal(gridComplete({ ranges: [[0, 0], [15, 15], [30, 30], [45, 45]], count: 60 }), true, '只有格点:齐');
  assert.equal(gridComplete({ ranges: [[0, 0], [15, 15], [45, 45]], count: 60 }), false, '缺 30');
  assert.equal(gridComplete({ ranges: [], count: 60 }), false);
  assert.equal(gridComplete({ ranges: undefined, count: 60 }), false);
  assert.equal(gridComplete({ ranges: [[0, 0]], count: 1 }), true, 'count 为 1:只要第 0 帧');
  assert.equal(gridComplete({ ranges: [], count: 1 }), false);
  assert.equal(gridComplete({ ranges: [[1, 59]], count: 60 }), false, '没有第 0 帧');
});

test('gridComplete: count not a multiple of 15 needs no extra tail frame', () => {
  assert.equal(gridComplete({ ranges: [[0, 0], [15, 15], [30, 30]], count: 44 }), true);
  assert.equal(gridComplete({ ranges: [[0, 0], [15, 15], [30, 30]], count: 46 }), false, '46 帧要有第 45 帧');
});

test('gridComplete: anchors between the grid must be ready too', () => {
  const grid = [[0, 0], [15, 15], [30, 30]];
  assert.equal(gridComplete({ ranges: grid, count: 40, anchors: [0] }), true, '锚帧在格上');
  assert.equal(gridComplete({ ranges: grid, count: 40, anchors: [22] }), false, '格间的锚帧没就绪');
  assert.equal(gridComplete({ ranges: [...grid, [22, 22]], count: 40, anchors: [22] }), true);
  assert.equal(gridComplete({ ranges: grid, count: 40, anchors: [200] }), true, '范围外的锚帧不要求');
  assert.equal(gridComplete({ ranges: grid, count: 40, firstFrame: 100, anchors: [122] }), false, '全局 122 = 本地 22');
  assert.equal(gridComplete({ ranges: grid, count: 40, firstFrame: 100, anchors: [22] }), true, '全局 22 在卡前面,不要求');
});

test('gridComplete: hole in the ready ranges', () => {
  assert.equal(gridComplete({ ranges: [[0, 29], [45, 100]], count: 101 }), false, '30 在洞里');
  assert.equal(gridComplete({ ranges: [[0, 29], [30, 100]], count: 101 }), true, '相邻的区间拼起来');
  assert.equal(gridComplete({ ranges: [[0, 14], [15, 100]], count: 101 }), true);
  assert.equal(gridComplete({ ranges: [[0, 100], [200, 300]], count: 101 }), true, '多出来的区间无妨');
  // 洞在两个格点之间:没有格点在洞里,照样齐
  assert.equal(gridComplete({ ranges: [[0, 0], [15, 15], [16, 20], [30, 30]], count: 31 }), true);
  // 0 在 [0,5],15 在 [10,20],30 在 [25,40] 都有,45 不在任何区间里
  assert.equal(gridComplete({ ranges: [[0, 5], [10, 20], [25, 40]], count: 41 }), true);
  assert.equal(gridComplete({ ranges: [[0, 5], [10, 20], [25, 40]], count: 46 }), false, '45 不在任何区间里');
});

test('gridComplete: unsorted, overlapping and malformed ranges', () => {
  assert.equal(gridComplete({ ranges: [[30, 30], [0, 0], [15, 15]], count: 31 }), true, '乱序');
  assert.equal(gridComplete({ ranges: [[0, 20], [10, 40]], count: 41 }), true, '重叠');
  assert.equal(gridComplete({ ranges: [[0, 0], null, [5], [9, 3], ['a', 'b'], [15, 15]], count: 16 }), true, '坏区间丢掉');
  assert.equal(gridComplete({ ranges: [[9, 3]], count: 16 }), false, '只有坏区间:没就绪');
});

test('gridComplete: asking about one segment only', () => {
  // 0 和 15 就绪,30、45 没有
  const ranges = [[0, 0], [15, 15]];
  assert.equal(gridComplete({ ranges, count: 60 }), false);
  assert.equal(gridComplete({ ranges, count: 60, from: 0, to: 29 }), true, '这一段里的格点是 0 和 15');
  assert.equal(gridComplete({ ranges, count: 60, from: 0, to: 30 }), false, '到 30 就要 30');
  assert.equal(gridComplete({ ranges, count: 60, from: 15, to: 15 }), true, '一帧一段');
  assert.equal(gridComplete({ ranges, count: 60, from: 30, to: 59 }), false);
  assert.equal(gridComplete({ ranges, count: 60, from: 16, to: 29 }), true, '这一段里没有格点:没有要等的');
  assert.equal(gridComplete({ ranges: [], count: 60, from: 16, to: 29 }), true, '没有格点就是空区间也算齐');
  assert.equal(gridComplete({ ranges: [], count: 60, from: 15, to: 29 }), false);
  assert.equal(gridComplete({ ranges, count: 60, from: 40 }), false, '只给起点:到末尾');
  assert.equal(gridComplete({ ranges, count: 60, to: 29 }), true, '只给终点:从头');
  // 起止夹到 [0, count - 1]
  assert.equal(gridComplete({ ranges, count: 31, from: -50, to: 29 }), true);
  assert.equal(gridComplete({ ranges, count: 31, from: 0, to: 500 }), false, '夹到 30,30 没就绪');
  assert.equal(gridComplete({ ranges, count: 31, from: 20, to: 10 }), true, '起点比终点大:空段');
  assert.equal(gridComplete({ ranges, count: 31, from: 500, to: 600 }), true, '整段在卡外:空段');
});

test('gridComplete: a segment boundary at an anchor between the grid', () => {
  const ranges = [[0, 0], [15, 15], [30, 30]];
  // 锚帧 22 把 [22, 29] 切成一段:这一段的第一张是 22
  assert.equal(gridComplete({ ranges, count: 40, anchors: [22], from: 22, to: 29 }), false);
  assert.equal(gridComplete({ ranges: [...ranges, [22, 22]], count: 40, anchors: [22], from: 22, to: 29 }), true);
  assert.equal(gridComplete({ ranges, count: 40, anchors: [22], from: 0, to: 21 }), true, '前一段不受 22 影响');
});

test('gridComplete: count invalid has nothing to wait for', () => {
  assert.equal(gridComplete({ ranges: [], count: 0 }), true);
  assert.equal(gridComplete({ ranges: [] }), true);
});

test('with the grid ready, the C4 pick rule finds a snapshot at every frame within the card', () => {
  // 把锚帧并进格里,每一帧都选得出(最多往回一格);只按 15 排而不并锚帧时,锚帧后面会选不出。
  const count = 100, firstFrame = 0, anchors = [0, 22, 61];
  const ready = gridLocalFrames({ count, firstFrame, anchors }).map((f) => [f, f]);
  for (let localFrame = 0; localFrame < count; localFrame += 1) {
    const picked = pickSnapshotFrame({ ranges: ready, localFrame, segmentStart: segmentStartOf(anchors, localFrame) });
    assert.notEqual(picked, null, `本地帧 ${localFrame} 选不出快照`);
    assert.ok(localFrame - picked < SNAPSHOT_STRIDE, `本地帧 ${localFrame} 选到 ${picked},隔了不止一格`);
  }
  const gridOnly = Array.from({ length: Math.ceil(count / SNAPSHOT_STRIDE) }, (_, i) => [i * SNAPSHOT_STRIDE, i * SNAPSHOT_STRIDE]);
  assert.equal(pickSnapshotFrame({ ranges: gridOnly, localFrame: 23, segmentStart: segmentStartOf(anchors, 23) }), null, '只按 15 排:锚帧 22 后面选不出(这就是要并锚帧的原因)');
});

// ── 守门:SNAPSHOT_STRIDE 只在 snapshotGrid.mjs 里定义 ──────────────────────────
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP_DIRS = new Set(['node_modules', '.git', '.worktrees', 'dist', 'archive']);
function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx|mjs|js|cjs|mts|cts|jsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('SNAPSHOT_STRIDE is defined in exactly one file', () => {
  const self = fileURLToPath(import.meta.url);
  // 定义 = 声明或赋值;`.d.mts` 里的类型声明、本测试里写的正则文字不算
  const definition = /(?:\b(?:const|let|var)\s+SNAPSHOT_STRIDE\b|\bSNAPSHOT_STRIDE\s*=(?!=))/;
  const hits = [];
  for (const top of ['src', 'server', 'scripts', 'desktop', 'tools']) {
    const dir = path.join(ROOT, top);
    if (!fs.existsSync(dir)) continue;
    for (const file of walk(dir)) {
      if (file === self || file.endsWith('.d.mts') || file.endsWith('.d.ts')) continue;
      if (definition.test(fs.readFileSync(file, 'utf8'))) hits.push(path.relative(ROOT, file).replace(/\\/g, '/'));
    }
  }
  assert.deepEqual(hits, ['src/render/snapshotGrid.mjs'], 'SNAPSHOT_STRIDE 只许在 src/render/snapshotGrid.mjs 定义一处(契约第 2.1 节);别的文件要用就 import');
  assert.match(fs.readFileSync(path.join(ROOT, 'src/render/snapshotGrid.mjs'), 'utf8'), /export const SNAPSHOT_STRIDE = 15;/);
});
