/**
 * 账号模式的预渲染重试(`server/agent-service/account-render-requests.mjs`;语义 `docs/semantics/product/agent.md`
 * 「发出任务后可以离开」「出错留痕」,`product/rendering.md`「谁产流与托管方开关」)。用例 AR-01～AR-09:
 *
 *   AR-01  「生成轨道流」开着:任务进程报的片段由主服务按核过的项目发清单计划;对话里 published → done,挂在那一轮名下
 *   AR-02  渲染失败:对话里记 failed 并带原因,不报「完成」
 *   AR-03  「生成轨道流」关着:不开发布连接、不发;对话里记 off(页面文案:没开生成轨道流,云端没有预渲染)
 *   AR-04  没配发布通道:每次记 unavailable,不悄悄丢
 *   AR-05  隔离:项目号只取文档服务核过的绑定;两个项目各发各的,事件里夹带的别的项目号不起作用
 *   AR-06  文档服务明确不给发布票据:记 failed 并说原因,不无限重试
 *   AR-07  一轮收尾(runner_done)马上发,不等防抖;主服务重启后按盘上的清单重发;对话删了清掉目录
 *   AR-08  主服务的发布通道:按目录里的渲染节点与「生成轨道流」开关答 availability
 *   AR-09  (要账号后端)真实任务进程里 Agent 加一张重卡:render_request 经内部口进主服务,主服务发计划,渲完对话里有「完成」;
 *          同一节点关掉「生成轨道流」后再改:不发、对话里是 off
 *   AR-13  判定摘要:render_request 带 judged 时主服务记 agent.render.judged(项目号取核过的绑定);片段为空、只带摘要的事件
 *          (一张重的都没有)只记日志、不发布、不记 render 事件;旧事件不带摘要照旧;摘要形状不对的项不记
 *   AR-12  (要账号后端)真实任务进程:一张重卡一张轻卡 → 主服务日志 judged heavy:1、只发重的;只改轻卡 → 主服务日志 judged heavy:0、不发
 * 跑:npm test -- server/test/account-render-publish.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAccountRenderRequests, createAccountRenderPublisher, RENDER_REQUEST_EVENT } from '../agent-service/account-render-requests.mjs';
import { renderStatusText } from '../../src/ai/cloud/events.ts';
import { JUDGED_CLIP_IDS } from '../agent/service/render-clips.mjs';

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, what, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`等不到:${what}`);
    await tick(10);
  }
}
const bindingFor = (projectId, conversationId, runId = 'run_1') => ({ projectId, conversationId, messageId: `m_${runId}`, runId,
  runGrantId: `g_${runId}`, instanceId: 'inst_1', instanceGeneration: 1, serviceKid: 'kid_1', senderAccountId: 'acct_a' });
const receiptOf = (binding, event) => ({ row: { v: 1, ...binding, eventId: `e_${Math.random()}`, event: { ...event, ...binding } } });

function fakeStore() {
  const rows = [];
  return { rows, async append({ binding, eventId, event }) { rows.push({ binding, eventId, event: { ...event, ...binding } }); return { ok: true }; },
    render: () => rows.filter((r) => r.event.type === 'render').map((r) => r.event) };
}
function fakePublisher(state = { available: true, enabled: true, streams: true }) {
  const p = { state, opened: [], tasks: [], handlers: new Map(), refuse: null,
    availability: () => ({ ...p.state }),
    codeVersion: () => 'cv-test',
    async open(projectId, handlers) {
      if (p.refuse) throw Object.assign(new Error('refused'), { reason: p.refuse });
      p.opened.push(projectId); p.handlers.set(projectId, handlers);
      return { publish: (task) => { p.tasks.push(task); }, withdraw() {}, close() {} };
    } };
  return p;
}
const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-render-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const make = (t, publisher, limits = {}) => {
  const store = fakeStore();
  const rr = createAccountRenderRequests({ dir: path.join(tmp(t), 'rr'), eventStore: store, publisher, limits: { debounceMs: 20, ...limits } });
  t.after(() => rr.close());
  return { store, rr };
};

test('AR-01 生成轨道流开着:按核过的项目发清单计划,对话里 published → done,挂在那一轮名下', async (t) => {
  const pub = fakePublisher();
  const { store, rr } = make(t, pub);
  const b = bindingFor('sp_a', 'conv_1');
  rr.observe(receiptOf(b, { type: RENDER_REQUEST_EVENT, clips: ['c1', 'c2'], rev: 7, userCards: false }));
  await until(() => pub.tasks.length === 1, '发出计划');
  const task = pub.tasks[0];
  assert.equal(task.source.projectId, 'sp_a'); assert.equal(task.source.projectRev, 7);
  assert.deepEqual(task.input.clips, ['c1', 'c2']);
  await until(() => store.render().some((e) => e.state === 'published'), 'published 事件');
  pub.handlers.get('sp_a').onDone({ id: task.id });
  await until(() => store.render().some((e) => e.state === 'done'), 'done 事件');
  const done = store.render().find((e) => e.state === 'done');
  assert.equal(done.runId, 'run_1'); assert.equal(done.runGrantId, 'g_run_1'); assert.equal(done.conversationId, 'conv_1');
  assert.deepEqual(done.clips.sort(), ['c1', 'c2']);
  assert.equal(renderStatusText(done), '云端渲染完成');
});

test('AR-02 渲染失败:记 failed 带原因,不报完成', async (t) => {
  const pub = fakePublisher();
  const { store, rr } = make(t, pub);
  rr.observe(receiptOf(bindingFor('sp_a', 'conv_1'), { type: RENDER_REQUEST_EVENT, clips: ['c1'], rev: 3 }));
  await until(() => pub.tasks.length === 1, '发出计划');
  pub.handlers.get('sp_a').onFail({ id: pub.tasks[0].id, reason: '渲染节点报告失败:卡片抛错' });
  await until(() => store.render().some((e) => e.state === 'failed'), 'failed 事件');
  const failed = store.render().find((e) => e.state === 'failed');
  assert.match(renderStatusText(failed), /^云端渲染失败:渲染节点报告失败:卡片抛错/);
  assert.equal(store.render().some((e) => e.state === 'done'), false);
});

test('AR-03 生成轨道流关着:不开发布连接、不发;对话里如实写 off', async (t) => {
  const pub = fakePublisher({ available: true, enabled: true, streams: false });
  const { store, rr } = make(t, pub);
  rr.observe(receiptOf(bindingFor('sp_a', 'conv_1'), { type: RENDER_REQUEST_EVENT, clips: ['c1'], rev: 3 }));
  await until(() => store.render().length === 1, 'off 事件');
  await tick(60);
  assert.deepEqual(store.render().map((e) => e.state), ['off']);
  assert.equal(pub.opened.length, 0); assert.equal(pub.tasks.length, 0);
  const text = renderStatusText(store.render()[0]);
  assert.match(text, /没开「生成轨道流」/); assert.match(text, /云端不为预览生成轨道流/); assert.doesNotMatch(text, /完成/);
});

test('AR-04 没配发布通道:每次记 unavailable,不悄悄丢', async (t) => {
  const { store, rr } = make(t, null);
  rr.observe(receiptOf(bindingFor('sp_a', 'conv_1'), { type: RENDER_REQUEST_EVENT, clips: ['c1'], rev: 3 }));
  await until(() => store.render().length === 1, 'unavailable 事件');
  assert.equal(store.render()[0].state, 'unavailable');
  assert.doesNotMatch(renderStatusText(store.render()[0]), /完成/);
});

test('AR-05 隔离:项目号只取核过的绑定;两个项目各发各的,事件里夹带的项目号不起作用', async (t) => {
  const pub = fakePublisher();
  const { store, rr } = make(t, pub);
  const a = bindingFor('sp_a', 'conv_a', 'run_a'), b = bindingFor('sp_b', 'conv_b', 'run_b');
  // 事件正文里写别的项目:回执里 event 被绑定覆盖(主服务的事件库就是这么存的),这里再故意只改 event 一侧
  const forged = receiptOf(a, { type: RENDER_REQUEST_EVENT, clips: ['ca'], rev: 1 });
  forged.row.event.projectId = 'sp_other';
  rr.observe(forged);
  rr.observe(receiptOf(b, { type: RENDER_REQUEST_EVENT, clips: ['cb'], rev: 2 }));
  await until(() => pub.tasks.length === 2, '两个计划');
  assert.deepEqual(pub.opened.sort(), ['sp_a', 'sp_b']);
  const byProject = Object.fromEntries(pub.tasks.map((x) => [x.source.projectId, x.input.clips]));
  assert.deepEqual(byProject, { sp_a: ['ca'], sp_b: ['cb'] });
  await until(() => store.render().filter((e) => e.state === 'published').length === 2, '各自 published');
  for (const e of store.render()) assert.equal(e.projectId, e.conversationId === 'conv_a' ? 'sp_a' : 'sp_b');
  // 不是 render_request 的事件、绑定不全的、片段为空的:都不发
  rr.observe(receiptOf(a, { type: 'tool_result', clips: ['x'], rev: 9 }));
  rr.observe({ row: { event: { type: RENDER_REQUEST_EVENT, clips: ['x'], rev: 9 } } });
  rr.observe(receiptOf(a, { type: RENDER_REQUEST_EVENT, clips: [], rev: 9 }));
  await tick(80);
  assert.equal(pub.tasks.length, 2);
});

test('AR-06 文档服务明确不给发布票据:记 failed 说原因,不无限重试', async (t) => {
  const pub = fakePublisher();
  pub.refuse = 'no-project';
  const { store, rr } = make(t, pub);
  rr.observe(receiptOf(bindingFor('sp_a', 'conv_1'), { type: RENDER_REQUEST_EVENT, clips: ['c1'], rev: 3 }));
  await until(() => store.render().length === 1, 'failed 事件');
  const e = store.render()[0];
  assert.equal(e.state, 'failed'); assert.match(e.reason, /no-project/);
  await tick(150);
  assert.equal(store.render().length, 1, '只记一次,不反复重试');
});

test('AR-07 一轮收尾马上发;主服务重启后按盘上的清单重发;对话删了清掉目录', async (t) => {
  const dir = path.join(tmp(t), 'rr');
  const pub = fakePublisher();
  const store = fakeStore();
  const rr = createAccountRenderRequests({ dir, eventStore: store, publisher: pub, limits: { debounceMs: 60_000 } });
  const b = bindingFor('sp_a', 'conv_1');
  rr.observe(receiptOf(b, { type: RENDER_REQUEST_EVENT, clips: ['c1'], rev: 4 }));
  await tick(30);
  assert.equal(pub.tasks.length, 0, '防抖期间没发');
  rr.observe(receiptOf(b, { type: 'runner_done', outcome: 'done' }));
  await until(() => pub.tasks.length === 1, '收尾马上发');
  rr.close();
  // 重启:新进程、空内存,按盘上的清单重发
  const pub2 = fakePublisher();
  const store2 = fakeStore();
  const rr2 = createAccountRenderRequests({ dir, eventStore: store2, publisher: pub2, limits: { debounceMs: 20 } });
  t.after(() => rr2.close());
  assert.equal(await rr2.restore(), 1);
  await until(() => pub2.tasks.length === 1, '重启后重发');
  assert.equal(pub2.tasks[0].source.projectId, 'sp_a'); assert.deepEqual(pub2.tasks[0].input.clips, ['c1']);
  await until(() => store2.render().some((e) => e.state === 'published'), '重发记在原对话');
  assert.equal(store2.render()[0].conversationId, 'conv_1');
  rr2.forget('sp_a', 'conv_1');
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('AR-13 判定摘要:主服务记 agent.render.judged;片段为空只记日志不发布;旧事件照旧;形状不对的项不记', async (t) => {
  const pub = fakePublisher();
  const store = fakeStore();
  const logs = [];
  const rr = createAccountRenderRequests({ dir: path.join(tmp(t), 'rr'), eventStore: store, publisher: pub, limits: { debounceMs: 20 },
    log: (event, fields) => logs.push({ event, ...fields }) });
  t.after(() => rr.close());
  const judgedLogs = () => logs.filter((l) => l.event === 'agent.render.judged');
  const b = bindingFor('sp_a', 'conv_1', 'run_7');
  // 有判重的:记日志,照发
  rr.observe(receiptOf(b, { type: RENDER_REQUEST_EVENT, clips: ['h1'], rev: 5, userCards: false,
    judged: { candidates: 3, heavy: 1, light: 2, why: 'judged', records: 4, estimated: 1, lightClips: ['l1', 'l2'] } }));
  await until(() => pub.tasks.length === 1, '发出计划');
  assert.deepEqual(judgedLogs(), [{ event: 'agent.render.judged', projectId: 'sp_a', runId: 'run_7', candidates: 3, heavy: 1, light: 2,
    records: 4, estimated: 1, why: 'judged', lightClips: ['l1', 'l2'] }]);
  // 一张重的都没有:片段为空、rev 为 null、只带摘要 → 记日志,不发布,不记 render 事件
  await until(() => store.render().some((e) => e.state === 'published'), 'published 事件');
  const before = store.render().length;
  rr.observe(receiptOf(b, { type: RENDER_REQUEST_EVENT, clips: [], rev: null, userCards: false,
    judged: { candidates: 1, heavy: 0, light: 1, why: 'judged', records: 4, lightClips: ['l1'] } }));
  await tick(80);
  assert.equal(judgedLogs().length, 2);
  assert.deepEqual(judgedLogs()[1], { event: 'agent.render.judged', projectId: 'sp_a', runId: 'run_7', candidates: 1, heavy: 0, light: 1, records: 4, why: 'judged', lightClips: ['l1'] });
  assert.equal(pub.tasks.length, 1, '没有发新计划');
  assert.equal(store.render().length, before, '没有新的 render 事件');
  // 旧任务进程的事件不带摘要:照旧发,不记判定日志
  rr.observe(receiptOf(bindingFor('sp_a', 'conv_2', 'run_8'), { type: RENDER_REQUEST_EVENT, clips: ['h2'], rev: 6 }));
  await until(() => pub.tasks.length === 2, '旧事件照发');
  assert.equal(judgedLogs().length, 2);
  // 摘要形状不对:认不得的项、坏的 id 丢掉;连候选张数都没有的整条不记;判轻的 id 最多 JUDGED_CLIP_IDS 个
  rr.observe(receiptOf(b, { type: RENDER_REQUEST_EVENT, clips: [], rev: null,
    judged: { candidates: 2, heavy: -1, light: 'x', why: 'Bad Why!', token: 'secret', lightClips: ['ok', 'bad\nid', 7, ...Array.from({ length: 20 }, (_, i) => `z${i}`)] } }));
  rr.observe(receiptOf(b, { type: RENDER_REQUEST_EVENT, clips: [], rev: null, judged: { why: 'judged' } }));
  rr.observe(receiptOf(b, { type: RENDER_REQUEST_EVENT, clips: [], rev: null, judged: ['x'] }));
  await tick(40);
  assert.equal(judgedLogs().length, 3);
  const odd = judgedLogs()[2];
  assert.deepEqual(Object.keys(odd).sort(), ['candidates', 'event', 'lightClips', 'projectId', 'runId']);
  assert.equal(odd.lightClips.length, JUDGED_CLIP_IDS); assert.equal(odd.lightClips[0], 'ok');
});

test('AR-08 主服务的发布通道:按目录里的渲染节点与生成轨道流答 availability', async () => {
  let watcher = null;
  const client = { connected: true, instanceId: 'agent-inst', watch(h) { watcher = h; return Promise.resolve(); }, publishTicket: async () => ({ ok: false, reason: 'no-project' }),
    demand: async () => {}, dataProtocols: () => [] };
  const w = createAccountRenderPublisher({ client, docUrl: 'ws://127.0.0.1:1', root: process.cwd(), publisherOptions: { codeVersionOf: () => 'cv' } });
  assert.deepEqual(w.publisher.availability('sp_a'), { available: false, enabled: false }, '目录没到:不可用,不猜关着');
  watcher.onProjects([
    { projectId: 'sp_on', hosted: { render: { available: true, enabled: true, streams: true } } },
    { projectId: 'sp_off', hosted: { render: { available: true, enabled: true, streams: false } } },
    { projectId: 'sp_node_off', hosted: { render: { available: true, enabled: false, streams: true } } },
  ]);
  assert.deepEqual(w.publisher.availability('sp_on'), { available: true, enabled: true, streams: true });
  assert.equal(w.publisher.availability('sp_off').streams, false);
  assert.equal(w.publisher.availability('sp_node_off').streams, false, '渲染节点关着也不产流');
  assert.equal(w.publisher.availability('sp_missing').streams, undefined);
  watcher.onProject({ projectId: 'sp_off', hosted: { render: { available: true, enabled: true, streams: true } } });
  assert.equal(w.publisher.availability('sp_off').streams, true, '目录推送改了就跟着改');
  watcher.onProject({ projectId: 'sp_on', removed: true });
  assert.equal(w.publisher.availability('sp_on').available, false);
  w.close();
});

// ---------------------------------------------------------------- AR-09 真实任务进程
const have = Boolean(process.env.PROMPTCUT_ACCOUNT_PROVIDER_ROOT && process.env.PROMPTCUT_PASSWORD_ORDER_MODULE);
const script = (steps) => `按脚本做。\n\`\`\`mock-script\n${JSON.stringify(steps)}\n\`\`\``;

test('AR-09 真实任务进程:Agent 加重卡 → 主服务以服务身份发计划 → 渲完对话里有「云端渲染完成」;关掉生成轨道流后如实写 off',
  { skip: !have && 'account provider env not set', timeout: 300_000 }, async (t) => {
    const { startRunnerProcessFixture } = await import('./fixtures/account-runner-process.mjs');
    const { runnerPorts } = await import('./free-ports.mjs');
    const pub = fakePublisher();
    const f = await startRunnerProcessFixture({ ports: await runnerPorts(), productionMaster: true, render: { publisher: pub, limits: { debounceMs: 200 } } });
    let actor;
    t.after(async () => { await actor?.close().catch(() => {}); await f.close(); });
    actor = await f.connectActor(0);
    const send = async (conversationId, requestId, steps) => {
      const posted = await actor.agent(`/conversations/${conversationId}/messages`, { prompt: script(steps), requestId, selectionSnapshot: { pageId: actor.pageId } });
      assert.equal(posted.status, 202, JSON.stringify(posted.body));
      return f.messageOf(conversationId, requestId).messageId;
    };
    const finished = (id) => f.grantOf(id)?.state === 'finished';
    const renderStates = (conv) => f.events(conv).filter((r) => r.event.type === 'render').map((r) => r.event.state);

    // ---------- 先关着「生成轨道流」:Agent 加一张重卡,不发计划,对话里如实写 off ----------
    pub.state = { available: true, enabled: true, streams: false };
    const off = await send('ar_conv_off', 'ar_req_off', [
      { tool: 'add_track', input: { name: '主序列' } },
      { tool: 'add_clip', input: { cardId: 'blur-text', start: 0, duration: 4, params: { text: '重卡', staggerMs: 100 } } },
      { say: '加好了' }]);
    await f.scheduler.start();
    await until(() => finished(off), '关着的那一条结清', 120_000);
    const noteOff = f.events('ar_conv_off').find((r) => r.event.type === RENDER_REQUEST_EVENT);
    assert.ok(noteOff, `任务进程报了要预渲染的片段:${JSON.stringify(f.events('ar_conv_off').map((r) => r.event.type))}`);
    assert.equal(noteOff.projectId, f.projectId); assert.equal(noteOff.runGrantId, f.grantOf(off).runGrantId);
    const clip = (await actor.project()).project.tracks.flatMap((tr) => tr.clips).find((c) => c.cardId === 'blur-text');
    assert.ok(clip); assert.deepEqual(noteOff.event.clips, [clip.id]);
    await until(() => renderStates('ar_conv_off').length > 0, '关着那一条的渲染事件', 20_000);
    await tick(400);
    assert.deepEqual(renderStates('ar_conv_off'), ['off']);
    assert.equal(pub.tasks.length, 0, '关着时没有发计划'); assert.equal(pub.opened.length, 0);

    // ---------- 打开「生成轨道流」再改这张卡:主服务以服务身份发计划,成员都离线后渲完,对话里补上「云端渲染完成」 ----------
    pub.state = { available: true, enabled: true, streams: true };
    const on = await send('ar_conv_on', 'ar_req_on', [
      { tool: 'update_clip', input: { clipId: clip.id, params: { text: '改过的重卡' } } }, { say: '改好了' }]);
    await until(() => finished(on), '开着的那一条结清', 120_000);
    const g1 = f.grantOf(on);
    // 一轮已经结清(没等渲染);计划只针对这个项目、这一片段
    await until(() => pub.tasks.length >= 1, '主服务发出计划', 20_000);
    assert.deepEqual(pub.opened, [f.projectId]);
    assert.equal(pub.tasks.at(-1).source.projectId, f.projectId); assert.deepEqual(pub.tasks.at(-1).input.clips, [clip.id]);
    // 成员都离线:断开唯一的成员,渲染节点做完
    await actor.close(); actor = null;
    pub.handlers.get(f.projectId).onDone({ id: pub.tasks.at(-1).id });
    await until(() => renderStates('ar_conv_on').includes('done'), '对话里有渲染完成', 20_000);
    const all = f.events('ar_conv_on');
    const done = all.find((r) => r.event.type === 'render' && r.event.state === 'done');
    assert.equal(done.event.runId, g1.runId); assert.equal(renderStatusText(done.event), '云端渲染完成');
    const endAt = all.findIndex((r) => r.event.type === 'runner_done');
    assert.ok(endAt >= 0 && endAt < all.indexOf(done), `渲染结果在那一轮收尾之后补进对话:${JSON.stringify(all.map((r) => [r.event.type, r.event.state ?? null]))}`);
    t.diagnostic(`ar_conv_on: ${JSON.stringify(all.map((r) => [r.event.type, r.event.state ?? null]))}`);
  });

// ---------------------------------------------------------------- AR-11 真实任务进程:改被引用剪辑里的卡
test('AR-11 真实任务进程:剪辑1 引用剪辑2,Agent 切到剪辑2 加卡再切回 → 发布清单里有父剪辑那份「段 id~卡 id」',
  { skip: !have && 'account provider env not set', timeout: 300_000 }, async (t) => {
    const { startRunnerProcessFixture } = await import('./fixtures/account-runner-process.mjs');
    const { runnerPorts } = await import('./free-ports.mjs');
    const pub = fakePublisher();
    const f = await startRunnerProcessFixture({ ports: await runnerPorts(), productionMaster: true, render: { publisher: pub, limits: { debounceMs: 200 } } });
    let actor;
    t.after(async () => { await actor?.close().catch(() => {}); await f.close(); });
    actor = await f.connectActor(0);
    const send = async (conversationId, requestId, steps) => {
      const posted = await actor.agent(`/conversations/${conversationId}/messages`, { prompt: script(steps), requestId, selectionSnapshot: { pageId: actor.pageId } });
      assert.equal(posted.status, 202, JSON.stringify(posted.body));
      return f.messageOf(conversationId, requestId).messageId;
    };
    const finished = (id) => f.grantOf(id)?.state === 'finished';
    pub.state = { available: true, enabled: true, streams: true };
    await f.scheduler.start();
    // 一、建剪辑2(建完切过去),切回剪辑1,放一个引用剪辑2 的剪辑段
    const first = await send('ar_cut_a', 'ar_cut_req_a', [
      { tool: 'add_cut', input: { name: '剪辑2' } },
      { tool: 'switch_cut', input: { name: '剪辑1' } },
      { tool: 'add_track', input: { name: '主序列' } },
      { tool: 'add_cut_segment', input: { name: '剪辑2', start: 0, duration: 4 } },
      { say: '放好了' }]);
    await until(() => finished(first), '放剪辑段的那一轮结清', 120_000);
    const before = pub.tasks.length;
    // 二、切到剪辑2 加一张卡,再切回剪辑1(和线上「云端 Agent 往剪辑2 里加卡」同一种写法)
    const second = await send('ar_cut_b', 'ar_cut_req_b', [
      { tool: 'switch_cut', input: { name: '剪辑2' } },
      { tool: 'add_clip', input: { cardId: 'punch-pill', start: 0, duration: 4, params: { text: '剪辑2 里的卡' } } },
      { tool: 'switch_cut', input: { name: '剪辑1' } },
      { say: '加好了' }]);
    await until(() => finished(second), '加卡的那一轮结清', 120_000);
    const doc = (await actor.project()).project;
    const seg = doc.tracks.flatMap((tr) => tr.clips).find((c) => typeof c.cutId === 'string' && c.cutId);
    assert.ok(seg, `激活剪辑(剪辑1)里有剪辑段:${JSON.stringify(doc.tracks)}`);
    const cut2 = (doc.cuts ?? []).find((c) => c.id === seg.cutId);
    const inner = (cut2?.tracks ?? []).flatMap((tr) => tr.clips).find((c) => c.cardId === 'punch-pill');
    assert.ok(inner, '剪辑2 里有那张卡');
    const want = `${seg.id}~${inner.id}`;
    await until(() => pub.tasks.slice(before).some((task) => task.input.clips.includes(want)), `发布清单里有 ${want}`, 20_000);
    t.diagnostic(`AR-11 清单:${JSON.stringify(pub.tasks.slice(before).map((task) => task.input.clips))}`);
  });

// ---------------------------------------------------------------- AR-12 真实任务进程:判定摘要进主服务日志
test('AR-12 真实任务进程:一重一轻 → 主服务日志 judged heavy:1、只发重的;只改轻卡 → 主服务日志 judged heavy:0、不发',
  { skip: !have && 'account provider env not set', timeout: 300_000 }, async (t) => {
    const { startRunnerProcessFixture } = await import('./fixtures/account-runner-process.mjs');
    const { runnerPorts } = await import('./free-ports.mjs');
    const pub = fakePublisher();
    const f = await startRunnerProcessFixture({ ports: await runnerPorts(), productionMaster: true, render: { publisher: pub, limits: { debounceMs: 200 } } });
    let actor;
    t.after(async () => { await actor?.close().catch(() => {}); await f.close(); });
    actor = await f.connectActor(0);
    const send = async (conversationId, requestId, steps) => {
      const posted = await actor.agent(`/conversations/${conversationId}/messages`, { prompt: script(steps), requestId, selectionSnapshot: { pageId: actor.pageId } });
      assert.equal(posted.status, 202, JSON.stringify(posted.body));
      return f.messageOf(conversationId, requestId).messageId;
    };
    const finished = (id) => f.grantOf(id)?.state === 'finished';
    const judged = () => f.log.filter((l) => l.event === 'master.agent.render.judged');
    pub.state = { available: true, enabled: true, streams: true };
    await f.scheduler.start();
    // 一、一张 stateful 的重卡(没有成本记录,同一张卡也没有)+ 一张声明 direct 的卡(没有记录按兜底判轻)
    const first = await send('ar_judged', 'ar_judged_a', [
      { tool: 'add_track', input: { name: '主序列' } },
      { tool: 'add_clip', input: { cardId: 'blur-text', start: 0, duration: 4, params: { text: '重卡' } } },
      { tool: 'add_clip', input: { cardId: 'lottie', start: 5, duration: 4 } },
      { say: '加好了' }]);
    await until(() => finished(first), '第一轮结清', 120_000);
    await until(() => pub.tasks.length >= 1 && judged().length >= 1, '发出计划、主服务记了判定', 20_000);
    const clips = (await actor.project()).project.tracks.flatMap((tr) => tr.clips);
    const heavyClip = clips.find((c) => c.cardId === 'blur-text'), lightClip = clips.find((c) => c.cardId === 'lottie');
    assert.ok(heavyClip && lightClip, JSON.stringify(clips));
    assert.deepEqual([...new Set(pub.tasks.flatMap((task) => task.input.clips))], [heavyClip.id], '只发重的');
    const j1 = judged().at(-1);
    assert.equal(j1.projectId, f.projectId); assert.equal(j1.why, 'judged'); assert.equal(j1.heavy, 1); assert.equal(j1.light, 1);
    assert.deepEqual(j1.lightClips, [lightClip.id]);
    const ev1 = f.events('ar_judged').filter((r) => r.event.type === RENDER_REQUEST_EVENT);
    assert.ok(ev1.some((r) => r.event.judged?.heavy === 1), `render_request 带摘要:${JSON.stringify(ev1.map((r) => r.event))}`);
    // 二、只改轻卡:一张重的都没有 → 不发,主服务照样记一条 heavy:0
    const tasksBefore = pub.tasks.length, judgedBefore = judged().length;
    const second = await send('ar_judged', 'ar_judged_b', [
      { tool: 'update_clip', input: { clipId: lightClip.id, params: { speed: 2 } } }, { say: '改好了' }]);
    await until(() => finished(second), '第二轮结清', 120_000);
    await until(() => judged().length > judgedBefore, '主服务记了 heavy:0 的判定', 20_000);
    const j2 = judged().at(-1);
    t.diagnostic(`AR-12 判定日志:${JSON.stringify(judged())}`);
    assert.equal(j2.heavy, 0); assert.equal(j2.light, 1); assert.equal(j2.why, 'judged'); assert.deepEqual(j2.lightClips, [lightClip.id]);
    await tick(400);
    assert.equal(pub.tasks.length, tasksBefore, '轻卡不发');
  });
