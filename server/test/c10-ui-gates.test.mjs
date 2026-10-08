/**
 * C10 用户卡与图卡、置灰与离线文案、`/api` 棘轮（`docs/plan/c10-contract.md` 第 9、10、17 节）。
 * 跑：node --experimental-test-module-mocks --test server/test/c10-ui-gates.test.mjs
 *
 *   C10-UI-01 表 A 的文案（顶栏五种状态、离线常驻提示、置灰悬停的模板、时间轴徽标「需要本地 PC 渲染辅助」——
 *             2026-09-29 用户定与舞台图标同一句）以原文出现在 `src/` 的非测试源文件里；
 *   C10-UI-02 「该模式暂不支持素材输入的音频图卡」「该模式暂不支持自定义卡」不再出现（第 9 节：并入图标；徽标换了文字）；
 *   C10-UI-03 本页运行不了的用户卡、图卡（内容库同步来的没载入成功的；图卡；低内存档下的全部用户卡）在线时与内置重卡一样：一律按重卡（分派表判轻也一样）、
 *             选帧、报缺口、取字节；暂停态整台「已精确」时它们的快照照挂（停下不追）——2026-09-29 用户改语义，撤销原豁免；
 *   C10-UI-04 桌面（在线开关关着）用户卡、图卡照常选帧，同步表不影响桌面；
 *   C10-RA-01 旧本机 `/api` 清单只减不增；已批准账号入口固定8条字面量，不重复、不接受未知账号路径。
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
  // 内容库同步来的用户卡:本机没有定义,只在同步表里
  registry.setSyncedUserCards([{ id: 'c10-synced-card', name: '同步卡', source: 'src/cards/user/c10-synced-card.tsx' }]);
  plan = { segments: [{ fromSec: 0, toSec: 1000, heavy: new Set(['b', 'g', 'u']) }] };
  for (const id of ['b', 'g', 'u', 's']) src.push({ type: 'layer', clipId: id, kind: 'html', key: `k-${id}`, ranges: [[0, 100]] });
  now += 10_000;
});

// 's' 是同步来的用户卡,分派表里故意不判重(表里没有它):这台设备跑不了的卡一律按重卡
const clips = () => [card('b', 'builtin-heavy'), card('g', 'c10-graph-card'), card('u', 'c10-user-card'), card('s', 'c10-synced-card')];

async function feedOnce(online, { playing = true } = {}) {
  placeholder.setOnlineBrowserMode(online);
  try {
    const head = { project: project(clips()), t: 1, playing };
    const f = feed.planFeed(head);
    const stage = { calls: [], async setSnapshots(patch, opts) { this.calls.push({ patch, opts }); } };
    await feed.deliverSnapshots(stage, 'front', head);
    await new Promise((r) => setImmediate(r));
    return { f, fetched: [...src.fetched] };
  } finally {
    placeholder.setOnlineBrowserMode(false);
  }
}

itUi('C10-UI-03 在线时用户卡、图卡（含同步来的）与内置重卡一样选帧、报缺口、取字节', async () => {
  const { f, fetched } = await feedOnce(true);
  assert.deepEqual(f.heavy, ['b', 'g', 's', 'u'], '同步卡分派表里没判重,在线照样按重卡');
  for (const id of ['b', 'u', 'g', 's']) {
    assert.ok(f.picks.has(id), `${id} 照常选帧`);
    assert.ok(fetched.some((x) => x.includes(`k-${id}`)), `${id} 取了字节：${JSON.stringify(fetched)}`);
  }
  placeholder.setOnlineBrowserMode(true);
  try {
    // 第 150 帧不在就绪区间里:回溯到 100,并报缺口
    const late = feed.planFeed({ project: project(clips()), t: 5, playing: true });
    for (const id of ['b', 'u', 'g', 's']) {
      assert.equal(late.picks.get(id)?.localFrame, 100, `${id} 回溯到最近的就绪帧`);
      assert.ok(late.wanted.some((w) => w.clipId === id), `${id} 照常报缺口`);
    }
  } finally {
    placeholder.setOnlineBrowserMode(false);
  }
  // 暂停态整台「已精确」(K5 第二路互换之后):内置卡不再投,这台设备跑不了的卡停下不追,快照照挂
  placeholder.setOnlineBrowserMode(true);
  try {
    assert.deepEqual(feed.suppressedAt({ project: project(clips()), t: 1, playing: true }), ['b', 'g', 's', 'u'], '播放中一律抑制');
    feed.markAllSettled('front');
    const paused = feed.planFeed({ project: project(clips()), t: 1, playing: false });
    // 2026-10-06(online-card-exec-contract.md 第 6 节):构建时就在包里的用户卡本页能运行,停下照内置卡追精确、不再贴快照
    assert.deepEqual([...paused.picks.keys()].sort(), ['g', 's'], '停下只剩本页运行不了的卡还贴快照');
    // 同步来的卡载入成功(运行状态 ready):不再一律按重,照分派表(表里没判它重)
    registry.setCardRunStates([['c10-synced-card', { state: 'ready', version: 'g1' }]]);
    assert.deepEqual(feed.suppressedAt({ project: project(clips()), t: 1, playing: true }), ['b', 'g', 'u'], '能运行的同步卡不再一律抑制');
    assert.deepEqual([...feed.planFeed({ project: project(clips()), t: 1, playing: false }).picks.keys()].sort(), ['g'], '停下它也追精确');
    registry.setCardRunStates([['c10-synced-card', { state: 'missing-module', detail: 'lodash' }]]);
    assert.deepEqual(feed.suppressedAt({ project: project(clips()), t: 1, playing: true }), ['b', 'g', 's', 'u'], '运行不了的照旧一律抑制');
    // 低内存档不执行用户卡的代码:构建时的用户卡也回到「本页运行不了」
    placeholder.setLocalOnlyLowMemory(true);
    assert.deepEqual([...feed.planFeed({ project: project(clips()), t: 1, playing: false }).picks.keys()].sort(), ['g', 's', 'u'], '低内存档:构建时的用户卡停下也不追');
    placeholder.setLocalOnlyLowMemory(false);
  } finally {
    placeholder.setOnlineBrowserMode(false);
    placeholder.setLocalOnlyLowMemory(false);
    registry.setCardRunStates([]);
  }
});

itUi('C10-UI-04 桌面（在线开关关着）用户卡、图卡照常选帧，同步表不影响桌面', async () => {
  const { f } = await feedOnce(false);
  for (const id of ['b', 'u', 'g']) assert.ok(f.picks.has(id), `${id} 在桌面照常选帧`);
  assert.equal(f.picks.has('s'), false, '桌面按分派表:同步表不起作用(桌面也不设它)');
  feed.markAllSettled('front');
  assert.equal(feed.planFeed({ project: project(clips()), t: 1, playing: false }).picks.size, 0, '桌面暂停态整台精确:一张不投');
});

/* ------------------------------------------------------------------ 棘轮（K9） */

const ratchet = ratchetGate();
// account-binding-task.md / account-binding-contract.md：独立固定官网同源账号入口，
// editor/ 是动态拼接的产物字面量，不能使其它 editor 子路径获得许可。
const ACCOUNT_PATHS = [
  '/api/account/cloud-agent-consent',
  '/api/account/editor/', '/api/account/editor/renew', '/api/account/editor/session',
  '/api/account/login', '/api/account/logout', '/api/account/me', '/api/account/projects',
];
test('C10-RA-03 project members has one separate exact hosted path without enlarging the /api scanner set', () => {
  const list = JSON.parse(fs.readFileSync(repoPath(RATCHET_FILE), 'utf8'));
  const baseline = JSON.parse(fs.readFileSync(repoPath(RATCHET_BASELINE), 'utf8'));
  for (const source of [list, baseline]) {
    assert.deepEqual(source.projectAccountPaths, ['/hosted/shared/account/members']);
    assert.equal(source.paths.some(p => p.startsWith('/hosted/')), false);
  }
  assertRatchet(list.paths, baseline);
});
function assertRatchet(paths, baseline) {
  assert.ok(Array.isArray(paths), `${RATCHET_FILE} 应有 paths 数组`);
  assert.deepEqual(baseline.accountPaths, ACCOUNT_PATHS, '账号许可必须是固定8条，不能扩为前缀');
  assert.equal(new Set(paths).size, paths.length, '清单里有重复');
  const legacy = new Set(baseline.paths);
  assert.ok(baseline.paths.every((p) => !p.startsWith('/api/account/')), '旧基线不能夹带账号许可');
  const added = paths.filter((p) => p.startsWith('/api/account/') ? !ACCOUNT_PATHS.includes(p) : !legacy.has(p));
  assert.deepEqual(added, [], `棘轮清单多出了未许可的路径：${added.join(', ')}`);
  assert.deepEqual(paths.filter((p) => p.startsWith('/api/account/')), ACCOUNT_PATHS, '账号产物清单逐条精确登记');
}
test('C10-RA-01 旧本机 /api 只减不增、账号入口固定8条、不重复', { skip: ratchet.ok ? false : ratchet.reason }, () => {
  const list = JSON.parse(fs.readFileSync(repoPath(RATCHET_FILE), 'utf8'));
  const baseline = JSON.parse(fs.readFileSync(repoPath(RATCHET_BASELINE), 'utf8'));
  assertRatchet(list.paths, baseline);
});
test('C10-RA-02 未知账号、恢复桌面账号入口、旧本机增项和重复仍拒绝', { skip: ratchet.ok ? false : ratchet.reason }, () => {
  const list = JSON.parse(fs.readFileSync(repoPath(RATCHET_FILE), 'utf8'));
  const baseline = JSON.parse(fs.readFileSync(repoPath(RATCHET_BASELINE), 'utf8'));
  for (const extra of ['/api/account/unknown', '/api/account/editor/login', '/api/account/editor/recover', '/api/ai/chat', '/api/new-local']) {
    assert.throws(() => assertRatchet([...list.paths, extra], baseline), { code: 'ERR_ASSERTION' });
  }
  assert.throws(() => assertRatchet([...list.paths, list.paths[0]], baseline), { code: 'ERR_ASSERTION' });
  assert.throws(() => assertRatchet(list.paths, { ...baseline, accountPaths: [...ACCOUNT_PATHS, '/api/account/unknown'] }), { code: 'ERR_ASSERTION' });
  assertRatchet(list.paths.filter((p) => p !== '/api/asset'), baseline); // 旧本机项可继续删除。
});
