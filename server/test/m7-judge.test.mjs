/**
 * M7 验收探针 D1-D2-D12 判据（`scripts/probes/m7-judge.mjs`）。夹具取自笔记本在 claude/rq-m7 4047133 上那一轮
 * （h1、h3 的 page 那份中途被 D2 接手，旧判据报 badRanges ["0-59:2"]）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeDualClip } from '../../scripts/probes/m7-judge.mjs';

const RANGES = ['0-59', '60-119', '120-179', '180-239', '240-299'];
const all = (live) => RANGES.map((range) => ({ range, live }));

/** 旧判据（改前的探针）：所有出键合起来每段恰好一份有效 */
function oldJudge({ groups, candidates }) {
  const counts = new Map();
  for (const list of Object.values(groups)) for (const t of list) counts.set(t.range, (counts.get(t.range) ?? 0) + (t.live ? 1 : 0));
  const badRanges = [...counts].filter(([, n]) => n !== 1).map(([r, n]) => `${r}:${n}`);
  return { ok: badRanges.length === 0 && candidates.includes('pc') && candidates.includes('page'), badRanges };
}

test('笔记本那一轮的 h1 / h3：page 做完 0-59 后被 pc 按 D2 接手——旧判据挂、新判据过（接手只作说明）', () => {
  const clip = {
    groups: { page: RANGES.map((range) => ({ range, live: range === '0-59' })), pc: all(true) },
    candidates: ['page', 'pc'], layerFp: 'pc',
  };
  const old = oldJudge(clip);
  assert.equal(old.ok, false);
  assert.deepEqual(old.badRanges, ['0-59:2']);
  const r = judgeDualClip(clip);
  assert.equal(r.ok, true, r.reasons.join('；'));
  assert.equal(r.winner, 'pc');
  assert.deepEqual(r.takenOverMidway, ['page']);
});

test('先认领者得卡（常规）：另一组整份作废，两种判据都过；pc 先得卡也合契约', () => {
  for (const [winner, loser] of [['page', 'pc'], ['pc', 'page']]) {
    const clip = { groups: { [winner]: all(true), [loser]: all(false) }, candidates: ['pc', 'page'], layerFp: winner };
    assert.equal(oldJudge(clip).ok, true);
    const r = judgeDualClip(clip);
    assert.equal(r.ok, true, r.reasons.join('；'));
    assert.deepEqual(r.fullySuperseded, [loser]);
    assert.deepEqual(r.takenOverMidway, []);
  }
});

test('该判挂的照样挂：两组都整份有效（没作废）、接手方缺段、层表缺候选、层没指向其中一组', () => {
  assert.equal(judgeDualClip({ groups: { page: all(true), pc: all(true) }, candidates: ['pc', 'page'], layerFp: 'pc' }).ok, false);
  assert.equal(judgeDualClip({ groups: { page: RANGES.map((range) => ({ range, live: range === '0-59' })), pc: RANGES.map((range) => ({ range, live: range !== '240-299' })) }, candidates: ['pc', 'page'], layerFp: 'pc' }).ok, false);
  assert.equal(judgeDualClip({ groups: { page: all(true), pc: all(false) }, candidates: ['page'], layerFp: 'page' }).ok, false);
  assert.equal(judgeDualClip({ groups: { page: all(true), pc: all(false) }, candidates: ['pc', 'page'], layerFp: null }).ok, false);
});
