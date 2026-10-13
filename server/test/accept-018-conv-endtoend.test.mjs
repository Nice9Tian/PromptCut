// 0.7.18 验收证据补充（conv 组）：云端 Agent 端到端（账号模式）——改文案、挪片段、调卡片参数各一次；署名；
// 两个成员各开一个对话互不串。
//
// 真的：VisuHive 账号后端、文档服务组合(账本、操作历史、WSS)、独立的素材服务进程、Agent 服务的执行器(真实工具、真实项目修改)、
//       页面一侧的连接用真的 WebSocket。受控的：只有模型——用仓库里的脚本式模拟提供方(```mock-script```)，不连任何真实模型。
// 端口：28691～28699(原来用本组的 28580～28588，和同组的 accept-018-conv-controls、accept-018-conv-readexception 是同一组写死的端口，
// 一次全量里并着跑会撞；这个文件挪到生产入口那一块的段里)。「停止」那一条另用 28705～28712、28735～28739。需要环境变量 PROMPTCUT_ACCOUNT_PROVIDER_ROOT / PROMPTCUT_PASSWORD_ORDER_MODULE，没有就跳过。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startAccountRealRunnerFixtureAt } from './accept-018-conv-runner-fixture.mjs';
import { startRunnerProcessFixture } from './fixtures/account-runner-process.mjs';

const have = Boolean(process.env.PROMPTCUT_ACCOUNT_PROVIDER_ROOT && process.env.PROMPTCUT_PASSWORD_ORDER_MODULE);
// 端口:缺省 28691 起那几段(见上);验收运行器给 ACCEPT018_E2E_BASE=<起点> 时三组都落在 起点～起点+24 里,免得和别的会话写死的段相撞
const E2E_BASE = Number(process.env.ACCEPT018_E2E_BASE) || 0;
const portAt = (legacy, offset) => (E2E_BASE ? E2E_BASE + offset : legacy);
const script = steps => '按脚本执行。\n```mock-script\n' + JSON.stringify(steps) + '\n```';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, what, ms = 40_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check(); if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await sleep(40);
  }
}

test('2.3-6 账号模式端到端：改文案、挪片段、调卡片参数各一次；署名；两个成员各开一个对话互不串', { skip: !have && 'account provider env not set', timeout: 240_000 }, async t => {
  const fixture = await startAccountRealRunnerFixtureAt({ base: portAt(28691, 0) });
  t.after(() => fixture.close());
  const a = await fixture.connectActor(0), b = await fixture.connectActor(1);
  t.after(() => Promise.allSettled([a.close(), b.close()]));
  const projectId = fixture.projectId;
  const rowsOf = conversationId => fixture.rows(projectId, conversationId);
  const post = async (actor, conversationId, steps) => {
    const posted = await actor.agent(`/conversations/${conversationId}/messages`, { prompt: script(steps), requestId: `req-${conversationId}`, selectionSnapshot: { pageId: actor.pageId } });
    assert.equal(posted.status, 202, JSON.stringify(posted.body));
    await until(() => rowsOf(conversationId).some(row => row.event.type === 'runner_done'), `${conversationId} 跑完`);
    return rowsOf(conversationId);
  };
  const tools = rows => rows.filter(row => row.event.type === 'tool_result').map(row => ({ name: row.event.name, ok: row.event.ok }));
  const projectOf = async actor => (await actor.send({ type: 'project.open', projectId })).project;
  const clipsOf = project => project.tracks.flatMap(track => track.clips);

  // 甲让 Agent 加一张文字卡，作为后面三次修改的对象。
  const addRows = await post(a, 'e2e_add', [{ tool: 'add_track', input: { name: '主序列' } }, { tool: 'add_clip', input: { cardId: 'blur-text', start: 0, duration: 4, params: { text: '原文案', staggerMs: 100 } } }, { say: '加好了' }]);
  assert.deepEqual(tools(addRows), [{ name: 'add_track', ok: true }, { name: 'add_clip', ok: true }], JSON.stringify(addRows.filter(row => row.event.type === 'tool_result').map(row => row.event).map(e => ({ ...e, summary: String(e.summary ?? e.result ?? e.output ?? '').slice(0, 400) }))));
  let project = await projectOf(a);
  const clip = clipsOf(project).find(c => c.cardId === 'blur-text');
  assert.ok(clip, '文字卡落进了项目'); assert.equal(clip.params.text, '原文案');

  // 三次修改，各是一个独立的对话和一轮任务：改文案、挪片段、调卡片参数。
  const edits = [
    ['改文案', 'e2e_text', { tool: 'update_clip', input: { clipId: clip.id, params: { text: '新文案' } } }, c => assert.equal(c.params.text, '新文案')],
    ['挪片段', 'e2e_move', { tool: 'update_clip', input: { clipId: clip.id, start: 2, end: 6 } }, c => { assert.equal(c.start, 2); assert.equal(c.end, 6); }],
    ['调卡片参数', 'e2e_param', { tool: 'update_clip', input: { clipId: clip.id, params: { staggerMs: 300 } } }, c => assert.equal(c.params.staggerMs, 300)],
  ];
  const framesBefore = b.frames.length;
  for (const [label, conversationId, step, verify] of edits) {
    const rows = await post(a, conversationId, [step, { say: `${label}完成` }]);
    assert.deepEqual(tools(rows).map(x => `${x.name}:${x.ok}`), [`${step.tool}:true`], `${label}：工具执行成功`);
    project = await projectOf(a);
    verify(clipsOf(project).find(c => c.id === clip.id));
    t.diagnostic(`${label} ok`);
  }
  // 署名：另一位成员收到的每一次写入广播，署名都是发起这一轮的甲(身份里带 service: agent)，不是乙，也不是匿名。
  const broadcasts = b.frames.slice(framesBefore).filter(frame => frame.type === 'project.ops');
  assert.ok(broadcasts.length >= 3, `乙至少收到三次写入广播，实际 ${broadcasts.length}`);
  const actors = new Set(broadcasts.map(frame => JSON.stringify([frame.actor?.userId ?? frame.actor?.accountId, frame.actor?.service, frame.actor?.role])));
  t.diagnostic(`broadcast actors: ${[...actors].join(' | ')}`);
  assert.equal(actors.size, 1, '三次写入署名一致');
  const senderOfA = rowsOf('e2e_text').find(row => row.event.type === 'run')?.senderAccountId ?? rowsOf('e2e_text')[0]?.senderAccountId;
  assert.ok(senderOfA, '运行记录里有发起人');
  assert.ok(broadcasts.every(frame => frame.actor?.userId === senderOfA && frame.actor?.service === 'agent'), '署名是发起这一轮的甲');

  // 两个成员各自开一个对话，同时让 Agent 做事：互不串。
  const [rowsA, rowsB] = await Promise.all([
    post(a, 'e2e_a_side', [{ tool: 'update_clip', input: { clipId: clip.id, label: '甲的标签' } }, { say: '甲的对话完成' }]),
    post(b, 'e2e_b_side', [{ sleepMs: 2500 }, { tool: 'get_project', input: {} }, { tool: 'update_clip', input: { clipId: clip.id, opacity: 0.5 } }, { say: '乙的对话完成' }]),
  ]);
  assert.deepEqual(tools(rowsA).map(x => `${x.name}:${x.ok}`), ['update_clip:true']); assert.deepEqual(tools(rowsB).map(x => `${x.name}:${x.ok}`), ['get_project:true', 'update_clip:true']);
  const textOf = rows => rows.filter(row => row.event.type === 'text').map(row => row.event.delta).join('');
  assert.equal(textOf(rowsA), '甲的对话完成'); assert.equal(textOf(rowsB), '乙的对话完成');
  const initiators = rows => new Set(rows.filter(row => row.event.type === 'run').map(row => row.runGrantId));
  const senders = rows => new Set(rows.map(row => row.senderAccountId).filter(Boolean));
  assert.equal(senders(rowsA).size, 1); assert.equal(senders(rowsB).size, 1);
  assert.notDeepEqual([...senders(rowsA)], [...senders(rowsB)], '两个对话的发起人是两个不同的账号');
  assert.ok(rowsA.every(row => row.conversationId === 'e2e_a_side') && rowsB.every(row => row.conversationId === 'e2e_b_side'), '各自的事件只属于各自的对话');
  assert.ok(!rowsA.some(row => row.event.type === 'text' && row.event.delta.includes('乙')) && !rowsB.some(row => row.event.type === 'text' && row.event.delta.includes('甲')), '回复里没有对方对话的内容');
  const final = clipsOf(await projectOf(a)).find(c => c.id === clip.id);
  t.diagnostic(`final clip: ${JSON.stringify(final)}`);
  assert.equal(final.label, '甲的标签'); assert.equal(final.blend?.opacity ?? final.opacity ?? final.params?.opacity, 0.5, '两个成员的修改都落进了同一个项目');
  assert.notDeepEqual([...initiators(rowsA)], [...initiators(rowsB)], '两个对话各自的任务授权不同');

  // 产品问题(见段落「产品问题」)：两个成员的 Agent 同时改同一处，后写的那个被正确拒绝了(项目没被覆盖)，
  // 但账号模式下文档服务的拒绝回包不带当前版本号和期间的改动，模型读到的是「现在是 rev undefined」。
  await t.test('过期写入被拒时，回给模型的话里要有当前版本号', async () => {
    const [, staleRows] = await Promise.all([
      post(a, 'e2e_stale_a', [{ sleepMs: 800 }, { tool: 'update_clip', input: { clipId: clip.id, label: '抢先写' } }, { say: '甲写完' }]),
      post(b, 'e2e_stale_b', [{ tool: 'get_project', input: {} }, { sleepMs: 3000 }, { tool: 'update_clip', input: { clipId: clip.id, label: '后写的' } }, { say: '乙写完' }]),
    ]);
    const result = staleRows.find(row => row.event.type === 'tool_result' && row.event.name === 'update_clip');
    assert.equal(result.event.ok, false, '后写的被拒(项目没被覆盖)');
    assert.equal(clipsOf(await projectOf(a)).find(c => c.id === clip.id).label, '抢先写');
    assert.match(String(result.event.summary), /现在是 rev [0-9]+/, '回给模型的话里该有当前版本号：' + String(result.event.summary).slice(0, 200));
  });
});

// ---------------------------------------------------------------------------------------------
// 2.3-5 在线页面 AI 栏背后的那组接口(账号模式)：接入方式信息、发消息 202、流式回复、工具调用过程、重开、停止。
// 页面本身(宽屏下的 AI 栏、接入方式下拉里的「云端」、手机仿真下的占位)要真实浏览器，见段落里的说明；这里验的是页面调的那一组真接口。
import fs from 'node:fs';
import https from 'node:https';

test('2.3-5 账号模式下 AI 栏背后的接口：info、发消息、流式回复、工具调用过程、重开；停止', { skip: !have && 'account provider env not set', timeout: 240_000 }, async t => {
  const fixture = await startAccountRealRunnerFixtureAt({ base: portAt(28691, 0) });
  const streams = new Set();
  t.after(async () => { for (const stream of streams) stream.destroy(); await fixture.close(); });
  const a = await fixture.connectActor(0);
  t.after(() => a.close());
  const projectId = fixture.projectId, ca = fs.readFileSync(fixture.caFile);
  const rowsOf = id => fixture.rows(projectId, id);
  const kind = e => (e.event ?? e).type;
  const openStream = (conversationId, into) => { const state = { status: null };
    const req = https.get(`${fixture.origin}/agent/v1/conversations/${conversationId}/events?after=0`, { ca,
      headers: { authorization: `Bearer ${a.session.agentDelegationTicket}` } }, res => {
      state.status = res.statusCode; res.setEncoding('utf8');
      res.on('data', chunk => { for (const line of chunk.split('\n')) if (line.startsWith('data:')) { try { into.push(JSON.parse(line.slice(5))); } catch { /* 心跳 */ } } });
    });
    req.on('error', () => {}); streams.add(req); return state; };

  // 接入方式信息：服务在账号模式、云端 Agent 已开(注意：这套组合里 info.executorMounted 回 false，而任务确实在执行，见段落说明)。
  const info = await a.agent('/info');
  assert.equal(info.status, 200, JSON.stringify(info.body));
  assert.equal(info.body.accountMode, true, JSON.stringify(info.body)); assert.equal(info.body.enabled, true, JSON.stringify(info.body));

  // 发消息回 202；事件流是流式的——工具调用的结果在这一轮结束之前就到了页面(这一轮后面还要等 5 秒)。
  const conversationId = 'panel_api';
  const posted = await a.agent(`/conversations/${conversationId}/messages`, { requestId: 'panel-1', selectionSnapshot: { pageId: a.pageId },
    prompt: script([{ tool: 'get_project', input: {} }, { sleepMs: 5000 }, { say: '收尾的话。' }]) });
  assert.equal(posted.status, 202, JSON.stringify(posted.body));
  const seen = []; const live = openStream(conversationId, seen);
  await until(() => live.status === 200 && seen.some(e => kind(e) === 'tool_result'), '流里出现工具调用结果', 30_000);
  assert.ok(rowsOf(conversationId).every(row => row.event.type !== 'runner_done'), '工具调用结果到页面时这一轮还没有结束(流式)');
  assert.deepEqual(seen.filter(e => kind(e) === 'tool_result').map(e => (e.event ?? e).name), ['get_project'], '工具调用过程在流里');

  // 重开：这一轮还在跑时，换一个新的连接从头读，过程是完整的；对话详情、历史列表里都有它。
  assert.equal((await a.agent(`/conversations/${conversationId}`)).status, 200);
  assert.ok((await a.agent('/conversations')).body.items.some(item => item.id === conversationId), '历史列表里有这个对话');
  const replay = []; const reopened = openStream(conversationId, replay);
  await until(() => reopened.status === 200 && replay.some(e => kind(e) === 'tool_result') && replay.some(e => kind(e) === 'user'), '重开读回用户消息与工具调用', 30_000);
  // 这一轮照常结束，收尾的话也到了流里。
  await until(() => rowsOf(conversationId).some(row => row.event.type === 'runner_done'), '这一轮结束', 60_000);
  await until(() => seen.some(e => kind(e) === 'text' && String((e.event ?? e).delta).includes('收尾的话')), '收尾的话到了流里', 30_000);

  // 停止：照页面的做法对一轮正在跑的任务发「停止」。
  // 这一条换了夹具：上面那套组合是「在主进程里跑任务」的进程内执行器，它没有关闭结算，停止永远确认不了（原先这里标着 todo）。
  // 账号模式真正的跑法是一条任务一个进程：主服务用生产的装配（`account-master-assembly.mjs`，只做控制），任务在真的子进程里跑，
  // 停止由 root 那一侧把进程关掉、文档服务结清。所以这里另起一套那样的组合来验（哪些是真的见 fixtures/account-runner-process.mjs 的开头）。
  // 端口 28705～28712、28735～28739（生产入口那一块的段）。
  await t.test('停止：这一轮停下、停之后才会说的话没有出现', async () => {
    const f = await startRunnerProcessFixture({ productionMaster: true, ports: { combo: [0, 1, 2, 3, 4, 5, 6].map(n => portAt(28705 + n, 10 + n)), agent: portAt(28712, 17),
      masterEvents: portAt(28735, 20), look: portAt(28736, 21), renderWorker: portAt(28737, 22), identityBase: portAt(28737, 22), controlBase: portAt(28738, 23) } });
    let actor = null, stream = null;
    try {
      actor = await f.connectActor(0);
      const stopId = 'panel_stop', stopSeen = [], stopRows = () => f.events(stopId);
      const sent = await actor.agent(`/conversations/${stopId}/messages`, { requestId: 'panel-2', selectionSnapshot: { pageId: actor.pageId },
        prompt: script([{ tool: 'get_project', input: {} }, { sleepMs: 6000 }, { say: '停之后才会说的话。' }]) });
      assert.equal(sent.status, 202);
      stream = await actor.stream(stopId, stopSeen);
      await f.scheduler.start();
      const run = await until(() => stopRows().find(row => row.event.type === 'run'), '拿到 runId', 60_000);
      const aborted = await actor.agent(`/conversations/${stopId}/abort`, { runId: run.runId, requestId: 'panel-stop-1' });
      assert.equal(aborted.status, 200, JSON.stringify(aborted.body));
      await until(() => f.scheduler.describe().every(slot => slot.phase === 'idle'), '没有在跑的任务', 3000);
      assert.ok(!stopRows().some(row => row.event.type === 'text' && String(row.event.delta).includes('停之后才会说的话')));
      assert.ok(!stopSeen.some(e => kind(e) === 'text' && String((e.event ?? e).delta).includes('停之后才会说的话')), '页面的流里也没有');
      // 这一轮是真的结束了：任务结清、结果是「被中断」，跑它的那个进程被关掉了
      const grant = f.grantOf(f.messageOf(stopId, 'panel-2').messageId);
      assert.equal(grant.state, 'finished'); assert.equal(grant.terminalOutcome.status, 'interrupted'); assert.equal(grant.terminalOutcome.reason, 'stop');
      assert.equal(f.stops.at(-1).how, 'killed'); assert.equal(f.conversation(stopId).currentRunId, null);
    } finally {
      stream?.close(); await actor?.close().catch(() => {});
      const closed = await f.close();
      assert.equal(closed.alive, 0, '收尾后不该还有活着的任务子进程');
    }
  });
});
