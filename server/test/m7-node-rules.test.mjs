/**
 * M7 探针之后主会话裁定的两条节点规则(`docs/plan/m7-contract.md` 第 13 节「探针之后的更正」):
 *   - 节点侧过滤:纯浏览器不收画布卡(`input.canvasHeavy`,逐帧顺推与桌面不等价),规则 7;
 *   - 切分:Lottie 素材卡、画布卡、执行器标了帧超体积上限的卡,不给浏览器另出一份(照旧只出切分方自己那一份)。
 * 跑:node --test server/test/m7-node-rules.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkClaimable } from '../render-node/filter.mjs';
import { splitPlan, BROWSER_EXCLUDED_CARD } from '../render-node/split.mjs';

const BROWSER = { profile: 'browser', nodeId: 'n', userId: 'u@d', envFingerprint: 'bbbbbbbbbbbbbbbb', codeVersions: ['cv'], capabilities: {} };
const task = (input = {}) => ({
  id: 'snapshot:k:0-29', kind: 'snapshot', tier: 'shared', resultKey: 'k', range: { from: 0, to: 29 },
  source: { projectId: 'p', projectRev: 1, userId: 'u@d' },
  input: { clipId: 'c', compositing: 'independent', canvasHeavy: false, ...input },
  weight: { class: 'light' }, requires: { envFingerprint: 'bbbbbbbbbbbbbbbb', codeVersion: 'cv', cardSources: {}, transcode: false, userCards: false, graphCards: false },
});

test('M7-NR-01 纯浏览器不收画布卡(规则 7 canvas-heavy);别的节点照收', () => {
  assert.deepEqual(checkClaimable(task(), BROWSER), { ok: true });
  assert.deepEqual(checkClaimable(task({ canvasHeavy: true }), BROWSER), { ok: false, rule: 7, reason: 'canvas-heavy' });
  const pc = { ...BROWSER, profile: 'pc' };
  assert.equal(checkClaimable(task({ canvasHeavy: true }), pc).ok, true);
});

test('M7-NR-02 切分:Lottie 素材卡、画布卡、标了超体积的卡不给浏览器另出一份;普通独立卡照出两份', () => {
  const planTask = { id: 'plan:p@1#clips:x', kind: 'plan', resultKey: 'p@1#clips:x', source: { projectId: 'p', projectRev: 1 }, input: { clips: [] }, requires: {} };
  const control = (clipId, cardId, extra = {}) => ({ clipId, cardId, snapshotKey: `sk-${clipId}`, contentKey: `ck-${clipId}`, tier: 'shared', start: 0, end: 1, count: 30,
    sampling: { firstFrame: 0, phase: { numerator: 0, denominator: 1 } }, compositing: 'independent', capabilities: { compositing: 'independent' }, ...extra });
  const cardPlan = [
    control('a', 'punch-pill'),
    control('b', 'lottie-bodymovin'),
    control('c', 'lottie'),
    control('d', 'particles', { capabilities: { compositing: 'independent', canvasHeavy: true } }),
    control('e', 'mu-number-ticker', { snapshotOversize: true }),
  ];
  const tasks = splitPlan({ planTask, entryKey: 'e', cardPlan, prerenderSet: new Set(cardPlan.map((c) => c.clipId)), envFingerprint: 'aaaaaaaaaaaaaaaa',
    codeVersion: 'cv', weightOf: () => ({ class: 'medium', estMs: null }), browserFingerprints: ['bbbbbbbbbbbbbbbb'] });
  const fps = (clipId) => tasks.filter((t) => t.input.clipId === clipId).map((t) => t.requires.envFingerprint).sort();
  assert.deepEqual(fps('a'), ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'], '普通独立卡两份');
  for (const id of ['b', 'c', 'd', 'e']) assert.deepEqual(fps(id), ['aaaaaaaaaaaaaaaa'], `${id} 只出切分方那一份`);
  for (const t of tasks.filter((x) => x.input.clipId !== 'a')) assert.equal(t.input.dual, undefined, '只有一份时不带 dual');
  assert.equal(BROWSER_EXCLUDED_CARD.test('lottie-adrock'), true);
  assert.equal(BROWSER_EXCLUDED_CARD.test('lottiefoo'), false);
});
