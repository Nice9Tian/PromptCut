/**
 * 云端 Agent 发布预渲染只发重卡(`server/agent/service/render-clips.mjs`「只发重卡」;语义 `product/agent.md`「发出任务后可以离开」:
 * 托管方的渲染节点生成的是**被改动的重卡**给成员预览用的轨道流)。
 * 跑:node --test server/test/render-heavy-gate.test.mjs
 *
 *   HG-01 攒满 delayMs 才判:这段时间里写进来的成本记录用得上;只把判重的交出去;一次判一批
 *   HG-02 退路:判定函数没有、成本记录取不到 → 候选全部交出去(原来的做法);判定抛错同样
 *   HG-03 flush 马上判、马上交;close 之后不再交
 *   HG-04 剪辑段里的卡:候选是虚拟片段 id,判定按同一条规则
 *   HG-05 端到端(真文档服务 + vite 载入缝 + 托管档服务 + 发布替身):Agent 改轻卡 → 不发;改重卡 → 发;没有记录的重卡 → 发;
 *         剪辑段里的卡同一条规则(轻的不发、重的按 `段 id~片段 id` 发)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as kernel from '../../src/kernel/cutFlatten.mjs';
import { createHeavyRenderGate, createRenderClipPicker, loadHeavyJudge } from '../agent/service/render-clips.mjs';
import { waitFor, wsClient } from './fake-ws-kit.mjs';
import { script, startKit } from './cloud-agent-kit.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const card = (id, start, end, extra = {}) => ({ id, cardId: 'punch-pill', params: { text: id }, start, end, ...extra });

function gateKit({ judge = null, records = async () => [], project, delayMs = 60 } = {}) {
  const emitted = [];
  const logs = [];
  const calls = { records: 0, judge: [] };
  let current = project;
  const gate = createHeavyRenderGate({
    picker: createRenderClipPicker(kernel), delayMs,
    replica: () => ({ project: current, rev: 7 }),
    judge: () => (judge ? (p, recs, candidates) => { calls.judge.push({ recs, candidates }); return judge(p, recs, candidates); } : null),
    records: async () => { calls.records += 1; return records(); },
    emit: (clips, info) => emitted.push({ clips, ...info }),
    log: (event, fields) => logs.push({ event, ...fields }),
  });
  return { gate, emitted, logs, calls, setProject: (p) => { current = p; } };
}

/** 替身判定:记录表里 stepMs < 10 的判轻,其余(含没有记录的)判重 */
const byRecords = (_p, recs, candidates) => {
  const light = new Set(recs.filter((r) => r.stepMs < 10).map((r) => r.identityKey));
  return { heavy: candidates.filter((id) => !light.has(id)), light: candidates.filter((id) => light.has(id)) };
};

test('HG-01 攒满才判:攒的这段时间里写进来的记录用得上;只交判重的;一批一次', async () => {
  const p = { tracks: [{ id: 't', clips: [card('a', 0, 1), card('b', 1, 2), { id: 'v', cardId: 'video', start: 0, end: 1 }] }] };
  let recs = [];
  const k = gateKit({ judge: byRecords, records: async () => recs, project: p });
  k.gate.note(['a', 'v']);
  k.gate.note(['b']);
  assert.deepEqual(k.emitted, [], '写入那一刻不交');
  // 在线成员的页面这时测完 a(很轻)写进文档服务
  recs = [{ identityKey: 'a', stepMs: 2 }];
  await waitFor(() => k.emitted.length === 1, 2000, '攒满之后交一次');
  assert.deepEqual(k.emitted, [{ clips: ['b'], rev: 7 }], '轻的 a 不交、素材 v 本来就不是候选');
  assert.equal(k.calls.records, 1);
  assert.deepEqual(k.calls.judge[0].candidates, ['a', 'b']);
  assert.deepEqual(k.logs.find((l) => l.event === 'agent.render.judged'), { event: 'agent.render.judged', candidates: 2, heavy: 1, light: 1, why: 'judged', records: 1 });
  // 全是轻的:什么都不交
  k.gate.note(['a']);
  await sleep(150);
  assert.equal(k.emitted.length, 1);
});

test('HG-02 退路:没有判定函数、取不到记录、判定抛错 → 候选全部交出去', async () => {
  const p = { tracks: [{ id: 't', clips: [card('a', 0, 1), card('b', 1, 2)] }] };
  const noJudge = gateKit({ judge: null, project: p });
  noJudge.gate.note(['a', 'b']);
  await noJudge.gate.flush();
  assert.deepEqual(noJudge.emitted, [{ clips: ['a', 'b'], rev: 7 }]);
  assert.equal(noJudge.logs.at(-1).why, 'no-judge');

  const noRecords = gateKit({ judge: byRecords, records: async () => null, project: p });
  noRecords.gate.note(['a', 'b']);
  await noRecords.gate.flush();
  assert.deepEqual(noRecords.emitted, [{ clips: ['a', 'b'], rev: 7 }], '旧文档服务不许读成本记录:照原来全发');
  assert.equal(noRecords.logs.at(-1).why, 'no-records');

  const throwing = gateKit({ judge: () => { throw new Error('坏了'); }, project: p });
  throwing.gate.note(['a']);
  await throwing.gate.flush();
  assert.deepEqual(throwing.emitted, [{ clips: ['a'], rev: 7 }]);
  assert.ok(throwing.logs.some((l) => l.event === 'agent.render.judge-failed'));
});

test('HG-03 flush 马上判、马上交;close 之后不再交', async () => {
  const p = { tracks: [{ id: 't', clips: [card('a', 0, 1)] }] };
  const k = gateKit({ judge: byRecords, project: p, delayMs: 60_000 });
  k.gate.note(['a']);
  await k.gate.flush();
  assert.deepEqual(k.emitted, [{ clips: ['a'], rev: 7 }]);
  await k.gate.flush();
  assert.equal(k.emitted.length, 1, '没有攒着的就不交');
  k.gate.note(['a']);
  k.gate.close();
  await k.gate.flush();
  k.gate.note(['a']);
  await sleep(50);
  assert.equal(k.emitted.length, 1);
});

test('HG-04 剪辑段里的卡:候选是虚拟片段 id,同一条规则', async () => {
  const seg = (id, start, end) => ({ id, cardId: '', cutId: 'B', start, end });
  const p = { id: 'p', fps: 30, activeCutId: 'A', tracks: [{ id: 'ta', clips: [seg('S', 0, 8), seg('S2', 10, 18)] }],
    cuts: [{ id: 'A', name: '剪辑1' }, { id: 'B', name: '剪辑2', duration: 8, tracks: [{ id: 'b1', clips: [card('L', 0, 4), card('H', 4, 8)] }] }] };
  // 替身判定按片段 id 的最后一节认(真判定按成本身份,同一张卡在各实例同一个键)
  const judge = (_p, _recs, candidates) => ({ heavy: candidates.filter((id) => id.endsWith('~H')), light: candidates.filter((id) => !id.endsWith('~H')) });
  const k = gateKit({ judge, project: p });
  k.gate.note(['L', 'H']);
  await k.gate.flush();
  assert.deepEqual(k.calls.judge[0].candidates.sort(), ['S2~H', 'S2~L', 'S~H', 'S~L']);
  assert.deepEqual(k.emitted.map((e) => e.clips.sort()), [['S2~H', 'S~H']]);
});

/* ------------------------------------------------------------------ HG-05 端到端 */

function fakePublisher() {
  const pub = {
    log: [], handlers: new Map(),
    availability: async () => ({ available: true, enabled: true }),
    codeVersion: () => 'code-v1',
    open: async (projectId, h) => {
      pub.handlers.set(projectId, h);
      return {
        publish: async (task) => { pub.log.push(['publish', projectId, task]); },
        withdraw: async (id) => { pub.log.push(['withdraw', projectId, id]); },
        close: () => { pub.log.push(['close', projectId]); },
      };
    },
    published: () => pub.log.filter((x) => x[0] === 'publish').map((x) => x[2]),
  };
  return pub;
}

const A1 = { projectId: 'p-h', userId: 'alice@d1', username: 'alice', deviceName: '电脑一', mode: 'restricted' };

test('HG-05 端到端:改轻卡不发、改重卡发、没有记录的重卡发;剪辑段里的卡同一条规则', { timeout: 240_000 }, async (t) => {
  const pub = fakePublisher();
  const kit = await startKit(t, { extra: { publisher: pub, renderLimits: { debounceMs: 200, stallMs: 600_000, progressEveryMs: 0 } } });
  const clip = (id, cardId, start, end, params) => ({ id, cardId, start, end, params, label: id });
  const p = {
    version: 1, id: 'p-h', name: '轻重', width: 1920, height: 1080, fps: 30, duration: 40, themeId: 'midnight', media: [], transitions: [],
    activeCutId: 'A',
    tracks: [
      { id: 't1', name: '序列 1', clips: [
        clip('lite', 'particles', 0, 4, {}),
        clip('hvy', 'blur-text', 5, 9, { text: '重卡' }),
        clip('norec', 'blur-text', 10, 14, { text: '没测过' }),
      ] },
      { id: 't2', name: '序列 2', clips: [{ id: 'S', cardId: '', cutId: 'B', start: 20, end: 28, label: '剪辑段' }] },
    ],
    cuts: [
      { id: 'A', name: '剪辑1' },
      { id: 'B', name: '剪辑2', duration: 8, tracks: [{ id: 'b1', name: 'b1', clips: [clip('X', 'particles', 0, 4, { seed: 3 }), clip('Y', 'blur-text', 4, 8, { text: '段里的重卡' })] }] },
    ],
  };
  await kit.doc.seed(p);

  // 页面测好的成本记录(与 Agent 服务判定用的是同一份成本身份:经同一个 vite 载入 `costIdentity.ts`)。粒子卡线上实测约 2.3 ms/帧(轻),
  // 文字卡记 40 ms/帧(超出 30 fps 的预算 23.3 ms,重);`norec` 没有记录。改标签不改成本身份,改前改后各算一份写进去
  const judge = await loadHeavyJudge((id) => kit.vite.ssrLoadModule(id));
  assert.equal(typeof judge, 'function', '判定函数经载入缝载得到');
  const CI = await kit.vite.ssrLoadModule('/src/editor/costIdentity.ts');
  const keysOf = (proj) => { CI.resetClipIdentityCache(); return CI.clipIdentityOf(proj).identityKeys; };
  const relabel = (proj) => JSON.parse(JSON.stringify(proj).replaceAll('"label":"', '"label":"改·'));
  const records = [];
  for (const proj of [p, relabel(p)]) {
    const keys = keysOf(proj);
    for (const [id, ms] of [['lite', 2.3], ['hvy', 40], ['S~X', 2.3], ['S~Y', 40]]) {
      assert.ok(keys[id], `${id} 有成本身份:${JSON.stringify(keys)}`);
      records.push({ identityKey: keys[id], stepMs: ms, samples: 30, measuredAt: Date.now(), mode: 'build' });
    }
    assert.ok(keys.norec, 'norec 有身份(只是没有记录)');
  }
  const page = wsClient(kit.doc.url);
  t.after(() => page.close());
  await page.opened;
  page.send({ type: 'cost.put', projectId: 'p-h', envFingerprint: '00000000000000aa', records, reqId: 'cost-1' });
  const stored = await page.next((m) => m.reqId === 'cost-1', 5000);
  assert.equal(stored.type, 'cost.stored', JSON.stringify(stored));

  const svc = kit.service;
  await svc.send(A1, 'c-h1', { prompt: script([
    { tool: 'update_clip', input: { clipId: 'lite', label: '改·lite' } },
    { tool: 'update_clip', input: { clipId: 'hvy', label: '改·hvy' } },
    { tool: 'update_clip', input: { clipId: 'norec', label: '改·norec' } },
    { tool: 'update_clip', input: { clipId: 'X', label: '改·X' } },
    { tool: 'update_clip', input: { clipId: 'Y', label: '改·Y' } },
    { say: '改好了' },
  ]) });
  await kit.finished(A1, 'c-h1');
  await waitFor(() => pub.published().length >= 1, 30_000, '发出计划');
  await sleep(600);
  const published = [...new Set(pub.published().flatMap((task) => task.input.clips))].sort();
  const judged = kit.logs.filter((l) => l.event === 'agent.render.judged');
  t.diagnostic(`发布:${JSON.stringify(published)};判定:${JSON.stringify(judged)}`);
  assert.ok(judged.length >= 1 && judged.every((l) => l.why === 'judged'), `按成本记录判过:${JSON.stringify(judged)}`);
  assert.deepEqual(published, ['S~Y', 'hvy', 'norec'], '轻卡(lite、段里的 X)不发;重卡与没有记录的 stateful 卡发;段里的卡按 段 id~片段 id 发');
  // 对话里的 render 事件只提判重的片段
  const seen = [];
  svc.subscribe({ ...A1, userId: 'alice@d1#watch' }, 'c-h1', 0, (ev) => seen.push(ev))?.();
  const renderClips = [...new Set(seen.filter((e) => e.type === 'render').flatMap((e) => e.clips ?? []))].sort();
  assert.deepEqual(renderClips, ['S~Y', 'hvy', 'norec']);
});
