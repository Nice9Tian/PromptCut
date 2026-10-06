/**
 * 托管方渲染服务隔离工作进程的底层零件（契约 `docs/plan/hosted-render-contract.md` 第 7.5 节，方案 A；用例 HR23、HR28）。
 * 跑：npm test -- server/test/hosted-render-isolation.test.mjs（不起浏览器、不起进程）
 *
 * 这些零件**还没有接进管理进程**（`main.mjs` 没有引它们）：现在渲染服务的行为仍等同方案 B。
 *
 *   HR23  隔离工作进程的编排（状态机）：一次只做一个项目；60 s 没有它能做的任务就结束；几个项目都在等时轮流、每个最多 5 分钟一换；
 *         换项目之前清空；起不来、什么都没认领到的不反复重来；检出副本与数据目录的建与清（只清带记号的目录、Windows 上不建链接）
 *   HR28  页面请求闸（纯函数）：浏览器发来的请求——编辑器的 Vite 一律拒；预渲染的 Vite 只认同源，`/api/**` 只放行表里的几条；
 *         Node 一侧的调用（不带 `Sec-Fetch-Site` / `Origin`）照旧放行
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createIsolation, isolationCandidates, isoNodeIdFor, prepareCheckout, wipeDir, leftoverCount, nearestNodeModules, ISO_MARKER, ISOLATION_DEFAULTS,
} from '../hosted-render/isolation.mjs';
import { pageGate, PAGE_API_ALLOW } from '../hosted-render/page-gate.mjs';
import { nodeIdFor } from '../hosted-render/broker.mjs';

/* ------------------------------------------------------------------ HR23 */

test('HR23 要隔离且有活等着的项目：开关开着、有活、常驻工作进程报了有卡且有任务等着；有成员在线的在前', () => {
  const directory = [
    { projectId: 'sp_a', enabled: true, active: true, members: false, since: 1 },
    { projectId: 'sp_b', enabled: true, active: true, members: true, since: 2 },
    { projectId: 'sp_c', enabled: false, active: true, members: true, since: 0 },
    { projectId: 'sp_d', enabled: true, active: false, members: false, since: null },
    { projectId: 'sp_e', enabled: true, active: true, members: true, since: 3 },
    { projectId: 'sp_f', enabled: true, active: true, members: true, since: 4 },
  ];
  const residentNodes = [
    { projectId: 'sp_a', cards: { state: 'some', count: 2 }, pending: 3, pendingKey: 'ka' },
    { projectId: 'sp_b', cards: { state: 'some', count: 1 }, pending: 1, pendingKey: 'kb' },
    { projectId: 'sp_c', cards: { state: 'some', count: 1 }, pending: 1, pendingKey: 'kc' }, // 开关关着
    { projectId: 'sp_d', cards: { state: 'some', count: 1 }, pending: 1, pendingKey: 'kd' }, // 没活
    { projectId: 'sp_e', cards: { state: 'none', count: 0 }, pending: 5, pendingKey: 'ke' }, // 没有卡：常驻的做
    { projectId: 'sp_f', cards: { state: 'some', count: 1 }, pending: 0, pendingKey: '' },   // 有卡但没任务等着
  ];
  assert.deepEqual(isolationCandidates({ directory, residentNodes }), [
    { projectId: 'sp_b', members: true, pending: 1, pendingKey: 'kb' },
    { projectId: 'sp_a', members: false, pending: 3, pendingKey: 'ka' },
  ]);
  assert.deepEqual(isolationCandidates({ directory, residentNodes: [] }), []);
  assert.notEqual(isoNodeIdFor('inst-0123456789abcdef', 'sp_abcdefgh1234'), nodeIdFor('inst-0123456789abcdef', 'sp_abcdefgh1234'), '与常驻工作进程的节点 id 不同');
});

/** 记下 runner 被叫到的每一步；`report` 由用例自己喂 */
function isoRig(overrides = {}) {
  let t = 1_000_000;
  const calls = [];
  const logs = [];
  let exited = false;
  let failPrepare = false;
  const runner = {
    async prepare(projectId) { calls.push(`prepare:${projectId}`); if (failPrepare) throw new Error('boom'); },
    start(projectId) { calls.push(`start:${projectId}`); exited = false; },
    async stop(reason) { calls.push(`stop:${reason}`); },
    async cleanup(projectId) { calls.push(`cleanup:${projectId}`); },
    exited: () => exited,
  };
  const iso = createIsolation({ runner, nodeIdOf: (p) => `iso/${p}`, now: () => t, log: (event, fields) => logs.push({ event, ...fields }), ...overrides });
  const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r)); };
  const cand = (projectId, extra = {}) => ({ projectId, members: true, pending: 1, pendingKey: `k-${projectId}`, ...extra });
  const report = (projectId, node = {}) => ({ at: t, queue: { nodes: [{ projectId, held: [], running: [], claimable: 0, claimed: 0, ...node }] } });
  return {
    iso, calls, logs, flush, cand, report,
    advance(ms) { t += ms; },
    setExited(v) { exited = v; },
    setFailPrepare(v) { failPrepare = v; },
  };
}

test('HR23 一次只做一个项目：先清空再起；60 s 没有它能做的任务就结束，结束后再清一遍；清单里最多一项', async () => {
  const r = isoRig();
  assert.deepEqual(r.iso.listing(), []);
  r.iso.tick({ candidates: [r.cand('pA'), r.cand('pB')] });
  await r.flush();
  assert.deepEqual(r.calls, ['prepare:pA', 'start:pA'], '先清空（prepare）再起');
  assert.deepEqual(r.iso.listing(), [{ projectId: 'pA', members: true, drain: false, nodeId: 'iso/pA' }], '只给这一个项目');
  // 另一个项目在等，但当前这个没结束之前不起第二个
  r.iso.tick({ candidates: [r.cand('pA'), r.cand('pB')] });
  await r.flush();
  assert.equal(r.calls.filter((c) => c.startsWith('start:')).length, 1);
  assert.equal(r.iso.current.phase, 'starting', '还没交过诊断：算没起来');

  // 交了诊断：算起来了。手里有活就不算闲
  r.advance(20_000);
  r.iso.tick({ candidates: [r.cand('pB')], report: r.report('pA', { held: ['t1'], claimed: 1 }) });
  assert.equal(r.iso.current.phase, 'running');
  r.advance(59_000);
  r.iso.tick({ candidates: [r.cand('pB')], report: r.report('pA', { held: ['t1'], claimed: 1 }) });
  r.advance(59_000);
  r.iso.tick({ candidates: [r.cand('pB')], report: r.report('pA', { claimable: 1, claimed: 1 }) });
  assert.equal(r.iso.current.phase, 'running', '还有可认领的任务：不算闲');
  // 60 s 既没有手里的、也没有可认领的 → 结束
  r.advance(59_000);
  r.iso.tick({ candidates: [r.cand('pB')], report: r.report('pA', { claimed: 1 }) });
  assert.equal(r.iso.current.phase, 'running');
  r.advance(1_000);
  r.iso.tick({ candidates: [r.cand('pB')], report: r.report('pA', { claimed: 1 }) });
  await r.flush();
  assert.deepEqual(r.calls.slice(2), ['stop:idle', 'cleanup:pA'], '结束后清空');
  assert.equal(r.iso.current, null);
  assert.equal(r.iso.status().lastRun.reason, 'idle');
  assert.equal(r.iso.status().lastRun.worked, true);

  // 下一拍才轮到 pB：同样先清空再起
  r.iso.tick({ candidates: [r.cand('pB')] });
  await r.flush();
  assert.deepEqual(r.calls.slice(4), ['prepare:pB', 'start:pB']);
  assert.deepEqual(r.iso.listing().map((p) => p.projectId), ['pB']);
});

test('HR23 轮流：另有项目在等时每个最多 5 分钟；到点先排空（不再认领、手里的做完）再换；排空超时就让掉；没人等就不换', async () => {
  const r = isoRig();
  r.iso.tick({ candidates: [r.cand('pA')] });
  await r.flush();
  r.iso.tick({ candidates: [r.cand('pA')], report: r.report('pA', { held: ['t'], claimed: 1 }) });
  // 没有别的项目在等：过了 5 分钟也不换
  r.advance(ISOLATION_DEFAULTS.SLICE_MS + 1000);
  r.iso.tick({ candidates: [r.cand('pA')], report: r.report('pA', { held: ['t'], claimed: 5 }) });
  assert.equal(r.iso.current.phase, 'running');
  // pB 来等了：这一轮已经超过 5 分钟 → 排空
  r.iso.tick({ candidates: [r.cand('pA'), r.cand('pB')], report: r.report('pA', { held: ['t'], claimed: 5 }) });
  assert.equal(r.iso.current.phase, 'draining');
  assert.equal(r.iso.listing()[0].drain, true, '清单上标排空：工作进程不再认领新的');
  assert.deepEqual(r.iso.status().waiting, ['pB']);
  // 手里的做完 → 结束、清空，下一拍轮到 pB（不是又回到 pA）
  r.iso.tick({ candidates: [r.cand('pA'), r.cand('pB')], report: r.report('pA', { claimed: 6 }) });
  await r.flush();
  assert.deepEqual(r.calls.slice(2), ['stop:rotated', 'cleanup:pA']);
  r.iso.tick({ candidates: [r.cand('pA'), r.cand('pB')] });
  await r.flush();
  assert.deepEqual(r.calls.slice(4), ['prepare:pB', 'start:pB'], '轮流：上一轮做的排到最后');

  // pB 排空超时：到点让掉
  r.iso.tick({ candidates: [r.cand('pA')], report: r.report('pB', { held: ['x'], claimed: 1 }) });
  r.advance(ISOLATION_DEFAULTS.SLICE_MS);
  r.iso.tick({ candidates: [r.cand('pA')], report: r.report('pB', { held: ['x'], claimed: 1 }) });
  assert.equal(r.iso.current.phase, 'draining');
  r.advance(ISOLATION_DEFAULTS.DRAIN_MS);
  r.iso.tick({ candidates: [r.cand('pA')], report: r.report('pB', { held: ['x'], claimed: 1 }) });
  await r.flush();
  assert.deepEqual(r.calls.slice(6), ['stop:rotate-timeout', 'cleanup:pB']);
});

test('HR23 不反复重来：一轮下来什么都没认领到（等着的任务它做不了）就先不再为同一批任务起；任务变了才再起；起不来、进程自己没了、项目被关掉都收尾并清空', async () => {
  const r = isoRig();
  r.iso.tick({ candidates: [r.cand('pA')] });
  await r.flush();
  r.iso.tick({ candidates: [r.cand('pA')], report: r.report('pA') });
  r.advance(60_000);
  r.iso.tick({ candidates: [r.cand('pA')], report: r.report('pA') });
  await r.flush();
  assert.deepEqual(r.calls, ['prepare:pA', 'start:pA', 'stop:idle', 'cleanup:pA']);
  // 同一批任务（pendingKey 没变）：不再起
  r.iso.tick({ candidates: [r.cand('pA')] });
  await r.flush();
  assert.equal(r.calls.length, 4);
  assert.equal(r.iso.status().skipped.length, 1);
  // 任务变了：再起
  r.iso.tick({ candidates: [r.cand('pA', { pendingKey: 'k-new' })] });
  await r.flush();
  assert.deepEqual(r.calls.slice(4), ['prepare:pA', 'start:pA']);

  // 进程自己没了：收尾、清空
  r.setExited(true);
  r.iso.tick({ candidates: [] });
  await r.flush();
  assert.deepEqual(r.calls.slice(6), ['stop:exit', 'cleanup:pA']);

  // 起来太久没交诊断：算起不来
  r.iso.tick({ candidates: [r.cand('pB')] });
  await r.flush();
  r.advance(ISOLATION_DEFAULTS.START_TIMEOUT_MS);
  r.iso.tick({ candidates: [r.cand('pB')] });
  await r.flush();
  assert.deepEqual(r.calls.slice(8), ['prepare:pB', 'start:pB', 'stop:start-timeout', 'cleanup:pB']);

  // 项目被关掉（不再该做）：手里没东西就结束
  r.iso.tick({ candidates: [r.cand('pC')] });
  await r.flush();
  r.iso.tick({ candidates: [], report: r.report('pC', { claimed: 1 }), eligible: () => true });
  r.iso.tick({ candidates: [], report: r.report('pC', { claimed: 1 }), eligible: () => false });
  await r.flush();
  assert.deepEqual(r.calls.slice(12), ['prepare:pC', 'start:pC', 'stop:not-listed', 'cleanup:pC']);

  // 准备阶段失败（副本建不出来）：不起、清一遍、这一批先不再试
  r.setFailPrepare(true);
  r.iso.tick({ candidates: [r.cand('pD')] });
  await r.flush();
  assert.deepEqual(r.calls.slice(16), ['prepare:pD', 'cleanup:pD']);
  assert.equal(r.iso.current, null);
  r.iso.tick({ candidates: [r.cand('pD')] });
  await r.flush();
  assert.equal(r.calls.length, 18, '同一批任务不再反复准备');

  // 管理进程退出时：立即结束当前这一轮
  r.setFailPrepare(false);
  r.iso.tick({ candidates: [r.cand('pE')] });
  await r.flush();
  await r.iso.stop('shutdown');
  assert.deepEqual(r.calls.slice(18), ['prepare:pE', 'start:pE', 'stop:shutdown', 'cleanup:pE']);
  assert.equal(r.iso.active, false);
});

test('HR23 检出副本与数据目录：只拷源码、不拷依赖与数据；清空只清带记号的目录；副本在依赖所在目录之内时不建链接，之外时 Windows 上拒绝', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-hr23-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  // 假的发布目录
  const root = path.join(tmp, 'release');
  for (const [rel, text] of Object.entries({
    'package.json': '{}', 'vite.config.ts': '//', '.gitignore': 'out', '.env.local': 'SECRET=1', 'debug.log': 'x',
    'src/cards/a.tsx': 'a', 'src/cards/user/index.ts': 'i', 'server/x.mjs': 'x', 'scripts/render-host.mjs': 'r',
    'node_modules/dep/index.js': 'd', 'out/frame-library/big.bin': 'b', 'docs/readme.md': 'd', 'src/node_modules/nested/i.js': 'n',
  })) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  assert.equal(nearestNodeModules(path.join(root, 'server')), root);

  // 副本在发布目录之内：靠向上解析，不建任何链接
  const inside = path.join(root, '.pc-work', 'iso', 'checkout');
  const made = prepareCheckout({ root, dest: inside });
  assert.equal(made.nodeModules, 'upward');
  const has = (rel) => fs.existsSync(path.join(inside, rel));
  for (const rel of ['package.json', 'vite.config.ts', '.gitignore', 'src/cards/a.tsx', 'src/cards/user/index.ts', 'server/x.mjs', 'scripts/render-host.mjs', ISO_MARKER]) assert.equal(has(rel), true, rel);
  for (const rel of ['node_modules', 'out', 'docs', '.env.local', 'debug.log', 'src/node_modules']) assert.equal(has(rel), false, `${rel} 不该拷进副本`);

  // 装进来一张「用户卡」，重建副本后它没了（换项目之前清空）
  fs.writeFileSync(path.join(inside, 'src', 'cards', 'user', 'evil.tsx'), 'evil');
  prepareCheckout({ root, dest: inside });
  assert.equal(has('src/cards/user/evil.tsx'), false);
  assert.equal(has('src/cards/a.tsx'), true);

  // 数据目录：清空后只剩记号；没有记号的非空目录不清
  const data = path.join(tmp, 'iso-data');
  wipeDir(data);
  fs.mkdirSync(path.join(data, 'data', 'card-overrides', 'src', 'cards', 'user'), { recursive: true });
  fs.writeFileSync(path.join(data, 'data', 'card-overrides', 'src', 'cards', 'user', 'evil.tsx'), 'evil');
  assert.equal(leftoverCount(data), 1);
  wipeDir(data);
  assert.equal(leftoverCount(data), 0);
  assert.deepEqual(fs.readdirSync(data), [ISO_MARKER]);
  const foreign = path.join(tmp, 'not-ours');
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, 'precious.txt'), 'keep');
  assert.throws(() => wipeDir(foreign), (err) => err.code === 'iso-not-ours');
  assert.equal(fs.readFileSync(path.join(foreign, 'precious.txt'), 'utf8'), 'keep');

  // 副本放在依赖所在目录之外：Windows 上拒绝（不建 junction）；别的平台建符号链接
  const outside = path.join(tmp, 'elsewhere', 'checkout');
  assert.throws(() => prepareCheckout({ root, dest: outside, platform: 'win32' }), (err) => err.code === 'iso-node-modules');
  assert.equal(fs.existsSync(outside), false, '拒绝时什么都没建');
  if (process.platform !== 'win32') {
    const linked = prepareCheckout({ root, dest: outside });
    assert.equal(linked.nodeModules, 'symlink');
    assert.equal(fs.lstatSync(path.join(outside, 'node_modules')).isSymbolicLink(), true);
    // 重建副本只拆链接，发布目录的依赖还在
    prepareCheckout({ root, dest: outside });
    assert.equal(fs.existsSync(path.join(root, 'node_modules', 'dep', 'index.js')), true);
  }
  // 副本不能就是发布目录或它的上级
  assert.throws(() => prepareCheckout({ root, dest: root }), (err) => err.code === 'iso-bad-checkout');
  assert.throws(() => prepareCheckout({ root, dest: tmp }), (err) => err.code === 'iso-bad-checkout');
});

/* ------------------------------------------------------------------ HR28 */

test('HR28 页面请求闸：Node 一侧的调用照旧放行；编辑器的 Vite 不答任何浏览器请求；预渲染的 Vite 只认同源，/api 只放行表里的几条', () => {
  const page = (site, extra = {}) => ({ 'sec-fetch-site': site, host: '127.0.0.1:5001', ...extra });
  const gate = (o) => pageGate({ method: 'GET', prerender: true, ...o });
  // Node 一侧（不带 Sec-Fetch-Site、不带 Origin）：两个 Vite 都放行
  for (const prerender of [true, false]) {
    assert.deepEqual(pageGate({ url: '/api/frames/queue', method: 'GET', headers: { host: '127.0.0.1:5001' }, prerender }), { browser: false, allow: true });
    assert.deepEqual(pageGate({ url: '/api/frames/queue/release', method: 'POST', headers: { host: 'x', 'content-type': 'application/json' }, prerender }), { browser: false, allow: true });
  }
  // 编辑器的 Vite：浏览器发来的一律拒（同源也拒：它没有页面）
  for (const site of ['same-origin', 'same-site', 'cross-site', 'none']) {
    assert.equal(pageGate({ url: '/src/main.tsx', method: 'GET', headers: page(site), prerender: false }).allow, false);
    assert.equal(pageGate({ url: '/api/cards/source', method: 'GET', headers: page(site), prerender: false }).reason, 'editor-no-pages');
  }
  // 预渲染的 Vite：别的源（另一个工作进程的页面是「同站」）一律拒，连模块也不给
  for (const site of ['same-site', 'cross-site']) {
    assert.equal(gate({ url: '/src/cards/index.ts', headers: page(site) }).reason, 'cross-origin');
    assert.equal(gate({ url: '/api/export/abc', headers: page(site) }).reason, 'cross-origin');
    assert.equal(gate({ url: '/@fs/C:/x/y.ts', headers: page(site) }).reason, 'cross-origin');
  }
  // 没有 Sec-Fetch-Site 但带 Origin（WebSocket 握手）：Origin 与 Host 对不上就拒
  assert.equal(gate({ url: '/', headers: { host: '127.0.0.1:5001', origin: 'http://127.0.0.1:5999' } }).reason, 'cross-origin');
  assert.equal(gate({ url: '/', headers: { host: '127.0.0.1:5001', origin: 'http://127.0.0.1:5001' } }).allow, true);
  // 同源：模块、样式、素材照常；/api 只放行表里的
  for (const url of ['/', '/?export=1', '/src/cards/user/x.tsx', '/@fs/C:/repo/node_modules/react/index.js', '/@media/abc', '/catalog/lottie/a.json']) {
    assert.equal(gate({ url, headers: page('same-origin') }).allow, true, url);
  }
  assert.equal(gate({ url: '/?export=1', headers: page('none') }).allow, true, 'puppeteer 直接开的导航');
  for (const rule of PAGE_API_ALLOW) {
    assert.equal(gate({ url: rule.prefix ? `${rule.path}x?y=1` : rule.path, method: rule.method, headers: page('same-origin') }).allow, true, rule.path);
  }
  assert.equal(gate({ url: `/api/asset/snap/${'a'.repeat(64)}`, headers: page('same-origin') }).allow, true, '按哈希读素材');
  assert.equal(gate({ url: `/api/asset/snap/${'a'.repeat(64)}/chunks`, method: 'POST', headers: page('same-origin') }).allow, false, '页面不许写素材');
  for (const [method, url] of [
    ['GET', '/api/cards/source?id=x'], ['POST', '/api/cards/create'], ['POST', '/api/cards/edit'], ['GET', '/api/frames/queue'], ['POST', '/api/frames/queue/release'],
    ['GET', '/api/data/project'], ['GET', '/api/media/local?path=/etc/passwd'], ['POST', '/api/media/upload/x'], ['POST', '/api/export'], ['GET', '/api/storage'],
    ['GET', '/api/render-node/ticket-request'], ['GET', '/api/ai/config'], ['GET', '/aPi/cards/source'], ['GET', '//api/cards/source'], ['POST', '/api/export/media/x'],
  ]) {
    assert.equal(gate({ url, method, headers: page('same-origin') }).reason, 'api-not-allowed', `${method} ${url}`);
  }
});
