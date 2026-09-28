/**
 * C10 用户卡与图卡、置灰与离线文案、`/api` 棘轮（`docs/plan/c10-contract.md` 第 9、10、17 节）。
 * 跑：node --experimental-test-module-mocks --test server/test/c10-ui-gates.test.mjs
 *
 *   C10-UI-01 表 A 的文案（顶栏五种状态、离线常驻提示、置灰悬停的模板、时间轴提示「该模式暂不支持自定义卡」）
 *             以原文出现在 `src/` 的非测试源文件里；
 *   C10-UI-02 「该模式暂不支持素材输入的音频图卡」不再单独出现（第 9 节：并入图标，不另报错）；
 *   C10-UI-03 用户卡、图卡那一层不发快照请求：在线时 `planFeed` 不给它们选帧、不报缺口，`deliverSnapshots` 不为它们取字节；
 *             同一时刻的内置重卡照常；
 *   C10-UI-04 桌面（在线开关关着）用户卡、图卡照常选帧——在线的豁免不漏到桌面；
 *   C10-RA-01 `/api` 棘轮清单只减不增：清单是基线的子集，不重复。
 *
 * 置灰入口「点了不发请求、不露报错」要在真页面里点，归探针与验收 C10-A7（主会话），这里只核文案。
 * 假设见 `c10-kit.mjs` 的 K7、K8、K9。门不开时整组 skip。
 */
import test, { mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  uiGate, ratchetGate, TABLE_A, DROPPED_TEXTS, srcFilesContaining, repoPath, RATCHET_FILE, RATCHET_BASELINE, useTs, repoUrl,
} from './c10-kit.mjs';

const ui = uiGate();
const itUi = (name, fn) => test(name, { skip: ui.ok ? false : ui.reason }, fn);

itUi('C10-UI-01 表 A 的文案以原文出现在 src/ 的非测试源文件里', () => {
  const missing = TABLE_A.filter((text) => srcFilesContaining(text).length === 0);
  assert.deepEqual(missing, [], `这些文案在 src/ 里找不到：\n${missing.join('\n')}`);
});

itUi('C10-UI-02 「该模式暂不支持素材输入的音频图卡」不再单独出现', () => {
  for (const text of DROPPED_TEXTS) assert.deepEqual(srcFilesContaining(text), [], `「${text}」还在`);
});

/* ------------------------------------------------------------------ 用户卡、图卡不发快照请求（K7） */

let feed = null, registry = null, placeholder = null;
let plan = { segments: [] };
let now = 1000;
async function load() {
  if (feed) return;
  await useTs();
  const srcUrl = (rel) => repoUrl(`src/${rel}`);
  mock.module(srcUrl('editor/planDispatch.ts'), { exports: { currentPlan: () => plan } });
  mock.module(srcUrl('render/dataMirror.ts'), { exports: { mirrorKey: () => ({ session: 's', localRev: 1 }), pushWanted: () => {} } });
  performance.now = () => now;
  feed = await import(srcUrl('editor/snapshotFeed.ts'));
  registry = await import(srcUrl('kernel/registry.ts'));
  placeholder = await import(srcUrl('render/placeholderHost.ts'));
}

const FPS = 30;
const card = (id, cardId) => ({ id, cardId, start: 0, end: 10, params: {} });
const project = (clips) => ({ version: 1, name: 'p', width: 1920, height: 1080, fps: FPS, duration: 20, media: [], tracks: [{ id: 't', name: 't', clips }] });
let src = null;
function fakeSource() {
  const s = {
    push: null,
    fetched: [],
    subscribeReady(_s, _r, onMessage) { s.push = onMessage; return () => { s.push = null; }; },
    async fetchSnapshot(kind, key, frame) { s.fetched.push(`${kind}/${key}/${frame}`); return `html:${key}/${frame}`; },
  };
  return s;
}

beforeEach(async () => {
  if (!ui.ok) return;
  await load();
  feed.resetSnapshotFeed();
  src = fakeSource();
  feed.setSnapshotSource(src);
  feed.syncSnapshotSubscription(() => {});
  feed.setExtraSuppressed([]);
  registry.registerCards([
    { id: 'c10-user-card', name: 'u', Component: () => null },
    { id: 'c10-graph-card', name: 'g', card: () => ({}), Component: () => null },
  ]);
  registry.setUserCardSources({ 'c10-user-card.tsx': '' }, { 'c10-user-card': 'c10-user-card.tsx' });
  plan = { segments: [{ fromSec: 0, toSec: 1000, heavy: new Set(['b', 'g', 'u']) }] };
  for (const id of ['b', 'g', 'u']) src.push({ type: 'layer', clipId: id, kind: 'html', key: `k-${id}`, ranges: [[0, 100]] });
  now += 10_000;
});

const clips = () => [card('b', 'builtin-heavy'), card('g', 'c10-graph-card'), card('u', 'c10-user-card')];

async function feedOnce(online) {
  placeholder.setOnlineBrowserMode(online);
  try {
    const head = { project: project(clips()), t: 1, playing: true };
    const f = feed.planFeed(head);
    const stage = { calls: [], async setSnapshots(patch, opts) { this.calls.push({ patch, opts }); } };
    await feed.deliverSnapshots(stage, 'front', head);
    await new Promise((r) => setImmediate(r));
    return { f, fetched: [...src.fetched] };
  } finally {
    placeholder.setOnlineBrowserMode(false);
  }
}

itUi('C10-UI-03 在线时用户卡、图卡那一层不发快照请求；内置重卡照常', async () => {
  const { f, fetched } = await feedOnce(true);
  assert.ok(f.picks.has('b'), '内置重卡照常选帧');
  for (const id of ['u', 'g']) {
    assert.equal(f.picks.has(id), false, `${id} 不该选帧`);
    assert.equal(f.wanted.some((w) => w.clipId === id), false, `${id} 不该报缺口`);
    assert.equal(fetched.some((x) => x.includes(`k-${id}`)), false, `${id} 不该取字节：${JSON.stringify(fetched)}`);
  }
  assert.ok(fetched.some((x) => x.includes('k-b')), '内置重卡取了字节');
});

itUi('C10-UI-04 桌面（在线开关关着）用户卡、图卡照常选帧', async () => {
  const { f } = await feedOnce(false);
  for (const id of ['b', 'u', 'g']) assert.ok(f.picks.has(id), `${id} 在桌面照常选帧`);
});

/* ------------------------------------------------------------------ 棘轮（K9） */

const ratchet = ratchetGate();
test('C10-RA-01 /api 棘轮清单只减不增：是基线的子集、不重复', { skip: ratchet.ok ? false : ratchet.reason }, () => {
  const list = JSON.parse(fs.readFileSync(repoPath(RATCHET_FILE), 'utf8'));
  const base = new Set(JSON.parse(fs.readFileSync(repoPath(RATCHET_BASELINE), 'utf8')).paths);
  assert.ok(Array.isArray(list.paths), `${RATCHET_FILE} 应有 paths 数组`);
  const added = list.paths.filter((p) => !base.has(p));
  assert.deepEqual(added, [], `棘轮清单多出了基线里没有的路径：${added.join(', ')}`);
  assert.equal(new Set(list.paths).size, list.paths.length, '清单里有重复');
});
