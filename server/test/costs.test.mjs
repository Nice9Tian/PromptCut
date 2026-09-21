import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadCosts, upsertCosts, mergeCosts, filterCosts, costsPath } from '../costs-store.mjs';

/** 每个用例一个干净的根;PROMPTCUT_DATA_DIR 会把落点挪走,测试期间一律摘掉 */
function withRoot(fn) {
  const saved = process.env.PROMPTCUT_DATA_DIR;
  delete process.env.PROMPTCUT_DATA_DIR;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-costs-'));
  try {
    return fn(root);
  } finally {
    if (saved === undefined) delete process.env.PROMPTCUT_DATA_DIR;
    else process.env.PROMPTCUT_DATA_DIR = saved;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const rec = (over = {}) => ({
  identityKey: 'k1', fps: 30, stepMs: 3, inlineMs: 40, rasterMs: 0, serializeMs: 6, catchUpMs: 120,
  kind: 'stepped', measuredAt: 1, device: 'dev-A', ...over,
});

test('空 / 坏文件都当空表,不抛', () => {
  withRoot((root) => {
    assert.deepEqual(loadCosts(root), []);
    fs.mkdirSync(path.dirname(costsPath(root)), { recursive: true });
    fs.writeFileSync(costsPath(root), '{ 半截', 'utf8');
    assert.deepEqual(loadCosts(root), []);
  });
});

test('按 (identityKey, device) 去重:同键覆盖、异 device 并存', () => {
  withRoot((root) => {
    const first = upsertCosts(root, [rec(), rec({ device: 'dev-B', stepMs: 40 })]);
    assert.equal(first.count, 2);
    assert.equal(first.added, 2);

    const second = upsertCosts(root, [rec({ stepMs: 9, measuredAt: 2 })]);
    assert.equal(second.count, 2, '同键不新增一行');
    assert.equal(second.updated, 1);

    const all = loadCosts(root);
    assert.equal(all.length, 2);
    assert.equal(all.find((r) => r.device === 'dev-A').stepMs, 9);
    assert.equal(all.find((r) => r.device === 'dev-B').stepMs, 40, '另一台机器的成绩不受影响');
  });
});

test('同一 device 上不同 identityKey 各占一行', () => {
  withRoot((root) => {
    upsertCosts(root, [rec(), rec({ identityKey: 'k2' })]);
    assert.equal(loadCosts(root).length, 2);
  });
});

test('demoted / pinnedHeavy 在复测时粘住,显式带值才覆盖', () => {
  withRoot((root) => {
    upsertCosts(root, [rec({ demoted: true, pinnedHeavy: true })]);
    // 探针复测上报的记录里没有这两个字段
    upsertCosts(root, [rec({ stepMs: 11 })]);
    const kept = loadCosts(root)[0];
    assert.equal(kept.stepMs, 11);
    assert.equal(kept.demoted, true, '降级旗被抹掉的话 K1 会永远跳过这张卡');
    assert.equal(kept.pinnedHeavy, true);

    // 显式写 false 就以新的为准(K6 撤销降级走这条)
    upsertCosts(root, [rec({ demoted: false })]);
    assert.equal(loadCosts(root)[0].demoted, false);
    assert.equal(loadCosts(root)[0].pinnedHeavy, true, '没提到的那一面旗照旧粘着');
  });
});

test('缺键的记录整条丢掉,不污染存档', () => {
  withRoot((root) => {
    const out = upsertCosts(root, [rec(), { fps: 30 }, { identityKey: 'x' }, { device: 'dev-A' }, null, 'nope']);
    assert.equal(out.count, 1);
    assert.equal(out.added, 1);
  });
});

test('mergeCosts 是纯函数:不改入参', () => {
  const existing = [rec({ demoted: true })];
  const snapshot = JSON.stringify(existing);
  const out = mergeCosts(existing, [rec({ stepMs: 7 })]);
  assert.equal(JSON.stringify(existing), snapshot);
  assert.equal(out.costs[0].stepMs, 7);
  assert.equal(out.costs[0].demoted, true);
});

test('filterCosts 按 mode 过滤;缺字段的旧记录当 dev', () => {
  const costs = [rec({ mode: 'dev' }), rec({ identityKey: 'k2', mode: 'build' }), rec({ identityKey: 'k3' })];
  assert.deepEqual(filterCosts(costs, null, 'dev').map((r) => r.identityKey), ['k1', 'k3'], 'R1 之前的记录没有 mode,它们全是 dev 模式量的');
  assert.deepEqual(filterCosts(costs, null, 'build').map((r) => r.identityKey), ['k2']);
  assert.equal(filterCosts(costs, null, null).length, 3, '不给 mode 就不筛');
  assert.equal(filterCosts(costs, 'dev-A', 'build').length, 1, '两个条件一起生效');
});

test('filterCosts 按 device 过滤;不给 device 就全给', () => {
  const costs = [rec(), rec({ identityKey: 'k2', device: 'dev-B' })];
  assert.equal(filterCosts(costs, 'dev-A').length, 1);
  assert.equal(filterCosts(costs, 'dev-A')[0].identityKey, 'k1');
  assert.equal(filterCosts(costs, 'nobody').length, 0);
  assert.equal(filterCosts(costs, null).length, 2);
  assert.equal(filterCosts(costs, '').length, 2);
});

test('落盘是原子的:存档文件之外不留临时文件', () => {
  withRoot((root) => {
    upsertCosts(root, [rec()]);
    const dir = path.dirname(costsPath(root));
    assert.deepEqual(fs.readdirSync(dir), ['card-costs.json']);
    const raw = JSON.parse(fs.readFileSync(costsPath(root), 'utf8'));
    assert.equal(raw.version, 1);
    assert.equal(raw.costs.length, 1);
  });
});

test('PROMPTCUT_DATA_DIR 覆盖落点', () => {
  const saved = process.env.PROMPTCUT_DATA_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-costs-env-'));
  process.env.PROMPTCUT_DATA_DIR = dir;
  try {
    assert.equal(costsPath('C:/nowhere'), path.join(dir, 'card-costs.json'));
    upsertCosts('C:/nowhere', [rec()]);
    assert.equal(loadCosts('C:/nowhere').length, 1);
  } finally {
    if (saved === undefined) delete process.env.PROMPTCUT_DATA_DIR;
    else process.env.PROMPTCUT_DATA_DIR = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
