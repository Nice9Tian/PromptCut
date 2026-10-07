/**
 * 云端 Agent 的反向通道(契约 `docs/plan/cloud-agent-contract.md` 第 28 节;任务书 `docs/plan/cloud-agent-task.md` J)。
 * 跑:node --test server/test/cloud-agent-page.test.mjs(本机回环,模型用模拟提供方,不出网)
 *
 *   CA-REV-01  发起这一轮的那张页面连着:`seek` 经事件流发一条 `page.request`(不带 seq、不进事件记录),页面交回后工具拿到它的结果;
 *              同一位成员的另一张页面(页面号不同)与别的看的人收不到请求;
 *   CA-REV-02  `play`、`pause`、`get_selection` 同一条路;`get_selection` 回的是页面当下的选区,不是发消息时的快照;
 *   CA-REV-03  页面不答:到时限回「发起方不在线」;页面答「没做成」:工具回那句原因;
 *   CA-REV-04  等的中途那条流断了:立刻回「发起方不在线」,不等到时限;之后交回的结果被拒;
 *   CA-REV-05  发起的页面没连着:刚发完消息的宽限内接上就照常执行;离开得久了立刻回「发起方不在线」;
 *              `get_selection` 在这位成员还有别的窗口连着看时退回发消息时的快照;
 *   CA-REV-06  交回结果的核对:别的成员(对话不是他的)当作没有这个对话;同一位成员的另一台设备、页面号不对、
 *              没有的 id、交过的 id、过期的 id、这一轮结束之后,全部被拒,且不影响在等的那一次;
 *   CA-REV-07  参数不合规矩的不发给页面(`seek` 没给 `t`、负数、不是数);多带的字段不往页面传;
 *   CA-REV-08  发消息没报页面号的(旧页面):没有反向通道,`seek` 立刻回「发起方不在线」,`get_selection` 照旧按快照答;
 *   CA-REV-09  一轮脚本里连着调:页面在时做成,页面走了之后同样的调用回「发起方不在线」,这一轮照样跑完;项目版本不因这几个工具而变;
 *   CA-REV-10  HTTP:发消息带 `pageId`、事件流带 `?page=`、`POST …/page-results`;别人的对话 404,不在等的 410,重复交 410;
 *              `page.request` 不出现在补发里;
 *   CA-REV-11  工具表:经反向通道的恰好是这四个;另外四个发起方在线时回 `initiatorOnly` 并写明差什么。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLOUD_INITIATOR_TOOLS, CLOUD_PAGE_TOOLS, CLOUD_TOOL_PLAN, initiatorUnreachable } from '../agent/service/cloud-tools.mjs';
import { startAgentService } from '../agent-service/main.mjs';
import { waitFor } from './fake-ws-kit.mjs';
import { project, script, credentials, modelConfig, startDoc, startKit, readSse } from './cloud-agent-kit.mjs';

const alice = { projectId: 'p-a', userId: 'alice@dev-a', username: 'alice', deviceName: 'A 的电脑', creator: true };
/** 同一位成员(同一个主人键)的另一台设备 */
const alice2 = { projectId: 'p-a', userId: 'alice@dev-a2', username: 'alice', deviceName: 'A 的手机', creator: true };
const bob = { projectId: 'p-a', userId: 'bob@dev-b', username: 'bob', deviceName: 'B 的电脑' };
const PAGE = 'pg-0123456789abcdef';
const OTHER_PAGE = 'pg-fedcba9876543210';
const hold = (ms = 20_000) => script([{ sleepMs: ms }, { say: '完' }]);

/** 一张「页面」:订阅事件流,收到 `page.request` 按 `answer(请求)` 交回(回 undefined 就不答) */
function page(kit, identity, conversationId, pageId, answer = () => ({ ok: true, result: { ok: true } })) {
  const events = [];
  const requests = [];
  const off = kit.service.subscribe(identity, conversationId, 0, (ev) => {
    events.push(ev);
    if (ev.type !== 'page.request') return;
    requests.push(ev);
    const a = answer(ev);
    if (a === undefined) return;
    queueMicrotask(() => { try { kit.service.pageResult(identity, conversationId, { id: ev.id, pageId, ...a }); } catch { /* 这次测的就是被拒 */ } });
  }, { pageId });
  return { events, requests, off };
}

test('云端 Agent 的反向通道(服务层)', async (t) => {
  const kit = await startKit(t, { limits: { pageMs: 700, pageAttachMs: 500 } });
  await kit.doc.seed(project('p-a', '甲'));
  const revOf = async () => (await kit.doc.stateOf('p-a')).rev;

  await t.test('CA-REV-01 seek:只发给发起这一轮的那张页面,不带 seq、不进事件记录;页面交回后工具拿到结果', async () => {
    await kit.service.send(alice, 'c-r1', { prompt: hold(), pageId: PAGE, pageState: { t: 1, selection: [] } });
    const inst = kit.service._instance(alice);
    const me = page(kit, alice, 'c-r1', PAGE, (ev) => ({ ok: true, result: { ok: true, sawT: ev.args.t } }));
    const otherTab = page(kit, alice, 'c-r1', OTHER_PAGE);
    const otherDevice = page(kit, alice2, 'c-r1', PAGE);
    const out = await inst.callTool('seek', { t: 3.5 }, 'c-r1');
    assert.deepEqual(out, { ok: true, sawT: 3.5 });
    assert.equal(me.requests.length, 1);
    const req = me.requests[0];
    assert.deepEqual(Object.keys(req).sort(), ['args', 'id', 'runId', 'timeoutMs', 'tool', 'type']);
    assert.equal(req.seq, undefined, '不带 seq');
    assert.equal(req.tool, 'seek');
    assert.deepEqual(req.args, { t: 3.5 });
    assert.match(req.id, /^[A-Za-z0-9_-]{20,}$/);
    assert.equal(otherTab.requests.length, 0, '同一位成员的另一张页面收不到');
    assert.equal(otherDevice.requests.length, 0, '另一台设备报了同一个页面号也收不到(userId 不同)');
    // 事件记录里没有它:后来补看的人看不到
    const replay = [];
    kit.service.subscribe(alice, 'c-r1', 0, (ev) => replay.push(ev))();
    assert.equal(replay.some((e) => e.type === 'page.request'), false);
    assert.ok(replay.every((e) => Number.isSafeInteger(e.seq)));
    me.off(); otherTab.off(); otherDevice.off();
    kit.service.abort(alice, 'c-r1');
  });

  await t.test('CA-REV-02 play、pause、get_selection:同一条路;选区是页面当下的', async () => {
    await kit.service.send(alice, 'c-r2', { prompt: hold(), pageId: PAGE, pageState: { t: 1, selection: ['c1'] } });
    const inst = kit.service._instance(alice);
    const live = { id: 'c9', trackId: 't1', clip: { id: 'c9', cardId: 'title' } };
    const me = page(kit, alice, 'c-r2', PAGE, (ev) => (ev.tool === 'get_selection' ? { ok: true, result: live } : { ok: true, result: { ok: true } }));
    assert.deepEqual(await inst.callTool('play', {}, 'c-r2'), { ok: true });
    assert.deepEqual(await inst.callTool('pause', { junk: 1 }, 'c-r2'), { ok: true });
    assert.deepEqual(await inst.callTool('get_selection', {}, 'c-r2'), live, '页面当下的选区,不是发消息时的 c1');
    assert.deepEqual(me.requests.map((r) => [r.tool, r.args]), [['play', {}], ['pause', {}], ['get_selection', {}]]);
    // 页面当下没有选中:与本机一样回 null
    me.off();
    const none = page(kit, alice, 'c-r2', PAGE, () => ({ ok: true, result: null }));
    assert.equal(await inst.callTool('get_selection', {}, 'c-r2'), null);
    none.off();
    kit.service.abort(alice, 'c-r2');
  });

  await t.test('CA-REV-03 页面不答到时限回发起方不在线;页面答没做成回那句原因', async () => {
    await kit.service.send(alice, 'c-r3', { prompt: hold(), pageId: PAGE });
    const inst = kit.service._instance(alice);
    const mute = page(kit, alice, 'c-r3', PAGE, () => undefined);
    const t0 = Date.now();
    const out = await inst.callTool('play', {}, 'c-r3');
    const took = Date.now() - t0;
    assert.equal(out.initiatorOffline, true);
    assert.match(out.error, /发起方不在线/);
    assert.ok(took >= 600 && took < 2500, `等了时限那么久(${took} ms)`);
    // 过期的 id 再交:被拒
    assert.throws(() => kit.service.pageResult(alice, 'c-r3', { id: mute.requests[0].id, pageId: PAGE, ok: true, result: { ok: true } }), (e) => e.code === 'page-request-gone' && e.status === 410);
    mute.off();
    const failing = page(kit, alice, 'c-r3', PAGE, () => ({ ok: false, error: '播放器还没准备好' }));
    assert.deepEqual(await inst.callTool('play', {}, 'c-r3'), { ok: false, error: '播放器还没准备好' });
    failing.off();
    kit.service.abort(alice, 'c-r3');
  });

  await t.test('CA-REV-04 等的中途流断了:立刻回发起方不在线;之后交回被拒', async () => {
    await kit.service.send(alice, 'c-r4', { prompt: hold(), pageId: PAGE });
    const inst = kit.service._instance(alice);
    const mute = page(kit, alice, 'c-r4', PAGE, () => undefined);
    const t0 = Date.now();
    const pending = inst.callTool('seek', { t: 2 }, 'c-r4');
    await waitFor(() => mute.requests.length === 1, 2000, '请求发到了页面');
    mute.off();
    const out = await pending;
    assert.equal(out.initiatorOffline, true);
    assert.ok(Date.now() - t0 < 500, '不等到时限');
    assert.throws(() => kit.service.pageResult(alice, 'c-r4', { id: mute.requests[0].id, pageId: PAGE, ok: true, result: { ok: true } }), (e) => e.code === 'page-request-gone');
    kit.service.abort(alice, 'c-r4');
  });

  await t.test('CA-REV-05 页面没连着:宽限内接上照常执行;离开久了立刻回;选区在别的窗口连着时退回快照', async () => {
    await kit.service.send(alice, 'c-r5', { prompt: hold(), pageId: PAGE, pageState: { t: 2, selection: ['c1'] } });
    const inst = kit.service._instance(alice);
    // 刚发完消息,流还没接上:调用先等着,接上就发
    const early = inst.callTool('seek', { t: 1 }, 'c-r5');
    await new Promise((r) => setTimeout(r, 120));
    const me = page(kit, alice, 'c-r5', PAGE);
    assert.deepEqual(await early, { ok: true });
    assert.equal(me.requests.length, 1);
    me.off();
    // 离开超过宽限:立刻回
    await new Promise((r) => setTimeout(r, 650));
    const t0 = Date.now();
    const out = await inst.callTool('seek', { t: 1 }, 'c-r5');
    assert.equal(out.initiatorOffline, true);
    assert.match(out.error, /发起方不在线,seek 要用到他的播放头/);
    assert.ok(Date.now() - t0 < 150, '不等待');
    // 没有任何窗口连着:选区也回不在线(那句用户审过的原话)
    assert.deepEqual(await inst.callTool('get_selection', {}, 'c-r5'), { ok: false, initiatorOffline: true, error: '发起方不在线,读不到页面的选区。请按项目内容继续,不要等待。' });
    // 这位成员的另一张页面连着看(不是发起的那张):选区退回发消息时的快照并注明,播放头仍然回不在线
    const otherTab = page(kit, alice, 'c-r5', OTHER_PAGE);
    const snap = await inst.callTool('get_selection', {}, 'c-r5');
    assert.equal(snap.ok, true);
    assert.deepEqual(snap.ids, ['c1']);
    assert.match(snap.note, /发这条消息时的选区/);
    assert.equal((await inst.callTool('pause', {}, 'c-r5')).initiatorOffline, true);
    assert.equal(otherTab.requests.length, 0);
    otherTab.off();
    kit.service.abort(alice, 'c-r5');
  });

  await t.test('CA-REV-06 交回结果的核对:别的成员、另一台设备、页面号不对、没有的 id、交过的 id、这一轮结束之后', async () => {
    await kit.service.send(alice, 'c-r6', { prompt: hold(), pageId: PAGE });
    const inst = kit.service._instance(alice);
    const mute = page(kit, alice, 'c-r6', PAGE, () => undefined);
    const pending = inst.callTool('seek', { t: 4 }, 'c-r6');
    let settled = false;
    pending.then(() => { settled = true; });
    await waitFor(() => mute.requests.length === 1, 2000, '请求发到了页面');
    const id = mute.requests[0].id;
    const good = { id, pageId: PAGE, ok: true, result: { ok: true, by: 'alice' } };
    const gone = (e) => e.code === 'page-request-gone' && e.status === 410;
    // 成员乙:对话不是他的 —— 当作没有这个对话(HTTP 层 404),在等的那一次不受影响
    assert.equal(kit.service.pageResult(bob, 'c-r6', { ...good, result: { ok: true, by: 'bob' } }), null);
    // 同一位成员的另一台设备(同一个主人键、userId 不同)
    assert.throws(() => kit.service.pageResult(alice2, 'c-r6', good), gone);
    // 页面号不对、没带
    assert.throws(() => kit.service.pageResult(alice, 'c-r6', { ...good, pageId: OTHER_PAGE }), gone);
    assert.throws(() => kit.service.pageResult(alice, 'c-r6', { id, ok: true, result: { ok: true } }), gone);
    // 没有的 id、不是字符串的 id
    assert.throws(() => kit.service.pageResult(alice, 'c-r6', { ...good, id: 'AAAAAAAAAAAAAAAAAAAAAA' }), gone);
    assert.throws(() => kit.service.pageResult(alice, 'c-r6', { ...good, id: { toString: () => id } }), gone);
    // 别的对话里交这个 id
    await kit.service.send(alice, 'c-r6b', { prompt: hold(), pageId: PAGE });
    assert.throws(() => kit.service.pageResult(alice, 'c-r6b', good), gone);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(settled, false, '以上都没有让在等的那一次结束');
    // 对的人交:收下
    assert.deepEqual(kit.service.pageResult(alice, 'c-r6', good), { ok: true });
    assert.deepEqual(await pending, { ok: true, by: 'alice' });
    // 同一个 id 再交:被拒
    assert.throws(() => kit.service.pageResult(alice, 'c-r6', good), gone);
    // 这一轮结束之后:被拒
    const again = inst.callTool('play', {}, 'c-r6');
    await waitFor(() => mute.requests.length === 2, 2000, '第二个请求发到了页面');
    kit.service.abort(alice, 'c-r6');
    assert.equal((await again).initiatorOffline, true, '这一轮被停:在等的请求不再等');
    assert.throws(() => kit.service.pageResult(alice, 'c-r6', { id: mute.requests[1].id, pageId: PAGE, ok: true, result: { ok: true } }), gone);
    mute.off();
    kit.service.abort(alice, 'c-r6b');
  });

  await t.test('CA-REV-07 参数不合规矩的不发给页面;多带的字段不往页面传', async () => {
    await kit.service.send(alice, 'c-r7', { prompt: hold(), pageId: PAGE });
    const inst = kit.service._instance(alice);
    const me = page(kit, alice, 'c-r7', PAGE);
    for (const bad of [{}, { t: -1 }, { t: '3' }, { t: Number.NaN }, { t: null }]) {
      const out = await inst.callTool('seek', bad, 'c-r7');
      assert.equal(out.ok, false, JSON.stringify(bad));
      assert.equal(out.initiatorOffline, undefined);
    }
    assert.equal(me.requests.length, 0, '一条都没有发给页面');
    await inst.callTool('seek', { t: 2, clipId: 'c1', __proto__: { x: 1 } }, 'c-r7');
    assert.deepEqual(me.requests[0].args, { t: 2 });
    me.off();
    kit.service.abort(alice, 'c-r7');
  });

  await t.test('CA-REV-08 发消息没报页面号(旧页面):没有反向通道,seek 立刻回不在线,选区照旧按快照答', async () => {
    await kit.service.send(alice, 'c-r8', { prompt: hold(), pageState: { t: 2, selection: ['c1'] } });
    const inst = kit.service._instance(alice);
    const old = page(kit, alice, 'c-r8', null);
    const t0 = Date.now();
    assert.equal((await inst.callTool('seek', { t: 1 }, 'c-r8')).initiatorOffline, true);
    assert.ok(Date.now() - t0 < 150, '不等待');
    assert.deepEqual((await inst.callTool('get_selection', {}, 'c-r8')).ids, ['c1']);
    assert.equal(old.requests.length, 0);
    // 报了不合规矩的页面号:当作没报
    old.off();
    kit.service.abort(alice, 'c-r8');
    await kit.finished(alice, 'c-r8');
    await kit.service.send(alice, 'c-r8', { prompt: hold(), pageId: '../x' });
    const odd = page(kit, alice, 'c-r8', '../x');
    assert.equal((await inst.callTool('seek', { t: 1 }, 'c-r8')).initiatorOffline, true);
    assert.equal(odd.requests.length, 0);
    odd.off();
    kit.service.abort(alice, 'c-r8');
  });

  await t.test('CA-REV-09 一轮脚本:页面在时做成;页面走了同样的调用回不在线,这一轮照样跑完;项目版本不变', async () => {
    const before = await revOf();
    const steps = [
      { sleepMs: 150 },
      { tool: 'seek', input: { t: 2.5 } },
      { tool: 'play', input: {} },
      { tool: 'pause', input: {} },
      { tool: 'get_selection', input: {} },
      { sleepMs: 1500 },
      { tool: 'seek', input: { t: 5 } },
      { tool: 'play', input: {} },
      { say: '做完了' },
    ];
    await kit.service.send(alice, 'c-r9', { prompt: script(steps), pageId: PAGE, pageState: { t: 0, selection: [] } });
    const me = page(kit, alice, 'c-r9', PAGE, (ev) => ({ ok: true, result: ev.tool === 'get_selection' ? null : { ok: true } }));
    await waitFor(() => me.events.filter((e) => e.type === 'tool_result').length === 4, 15_000, '前四步做完');
    assert.deepEqual(me.requests.map((r) => r.tool), ['seek', 'play', 'pause', 'get_selection']);
    assert.ok(me.events.filter((e) => e.type === 'tool_result').every((e) => e.ok === true));
    me.off(); // 关掉页面
    const events = await kit.finished(alice, 'c-r9');
    const results = events.filter((e) => e.type === 'tool_result');
    assert.equal(results.length, 6);
    assert.deepEqual(results.slice(4).map((e) => e.ok), [false, false], '页面走了之后的两步没做成');
    assert.ok(results.slice(4).every((e) => /发起方不在线/.test(String(e.summary ?? ''))), `结果摘要里写了发起方不在线:${JSON.stringify(results.slice(4).map((e) => e.summary))}`);
    assert.equal(events.at(-1).type, 'end');
    assert.equal(events.at(-1).state, 'idle', '这一轮照样跑完');
    assert.ok(events.some((e) => e.type === 'text' && /做完了/.test(e.delta ?? '')));
    assert.equal(events.some((e) => e.type === 'page.request'), false, '事件记录里没有 page.request');
    assert.equal(await revOf(), before, '这几个工具不改项目');
  });

  await t.test('CA-REV-11 工具表:经反向通道的恰好四个;另外四个在线时回 initiatorOnly 并写明差什么', async () => {
    assert.deepEqual([...CLOUD_PAGE_TOOLS].sort(), ['get_selection', 'pause', 'play', 'seek']);
    assert.equal(CLOUD_INITIATOR_TOOLS.size, 8);
    const rest = [...CLOUD_INITIATOR_TOOLS].filter((n) => !CLOUD_PAGE_TOOLS.has(n)).sort();
    assert.deepEqual(rest, ['collect_login', 'collect_login_check', 'spawn_agent', 'web_handoff']);
    await kit.service.send(alice, 'c-r11', { prompt: hold(), pageId: PAGE });
    const inst = kit.service._instance(alice);
    const me = page(kit, alice, 'c-r11', PAGE);
    for (const name of rest) {
      assert.ok(typeof CLOUD_TOOL_PLAN[name].online === 'string' && CLOUD_TOOL_PLAN[name].online.length > 8, `${name} 写了在线时差什么`);
      const out = await inst.callTool(name, name === 'spawn_agent' ? { role: 'editor', task: 'x' } : {}, 'c-r11');
      assert.deepEqual(out, initiatorUnreachable(name), name);
      assert.equal(out.initiatorOnly, true);
      assert.ok(out.error.includes(CLOUD_TOOL_PLAN[name].online));
    }
    assert.equal(me.requests.length, 0, '这四个不经反向通道');
    me.off();
    kit.service.abort(alice, 'c-r11');
  });
});

test('CA-REV-10 HTTP:pageId、?page=、POST page-results;别人的对话 404,不在等的与重复交的 410', async (t) => {
  const doc = await startDoc(t);
  await doc.seed(project('p-a', '甲'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-cloud-agent-page-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const authenticate = (req) => {
    const m = /^Bearer test:([^:]+):(.+)$/.exec(String(req.headers.authorization ?? ''));
    return m ? { projectId: m[1], userId: m[2], username: m[2].split('@')[0] } : null;
  };
  const svc = await startAgentService({ dataDir, docUrl: doc.url, port: 0, authenticate, credentials, modelConfig, limits: { pageMs: 3000, pageAttachMs: 2000 } });
  t.after(() => svc.close());
  const A = { Authorization: 'Bearer test:p-a:alice@dev-a' };
  const B = { Authorization: 'Bearer test:p-a:bob@dev-b' };
  const post = (p, headers, body) => fetch(`${svc.url}${p}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  const steps = [{ sleepMs: 300 }, { tool: 'seek', input: { t: 6 } }, { tool: 'pause', input: {} }, { sleepMs: 300 }, { say: '好了' }];
  const sent = await post('/v1/conversations/c-h/messages', A, { prompt: script(steps), pageId: PAGE });
  assert.equal(sent.status, 202);
  await sent.arrayBuffer();

  // 发起的那张页面:带 ?page= 读事件流,逐个答
  const statuses = [];
  let firstReq = null;
  const mine = await readSse(`${svc.url}/v1/conversations/c-h/events?after=0&page=${PAGE}`, A, (ev) => {
    if (ev.type === 'page.request') {
      const answer = async () => {
        if (!firstReq) {
          firstReq = ev;
          // 成员乙拿着这个 id 来交:对话不是他的,404
          const r0 = await post('/v1/conversations/c-h/page-results', B, { id: ev.id, pageId: PAGE, ok: true, result: { ok: true } });
          statuses.push(['bob', r0.status, (await r0.json()).code]);
          // 不带票据:401
          const r1 = await post('/v1/conversations/c-h/page-results', {}, { id: ev.id, pageId: PAGE, ok: true, result: { ok: true } });
          statuses.push(['anon', r1.status, (await r1.json()).code]);
        }
        const r = await post('/v1/conversations/c-h/page-results', A, { id: ev.id, pageId: PAGE, ok: true, result: { ok: true } });
        statuses.push(['alice', r.status, (await r.json()).ok]);
        if (ev === firstReq) {
          const dup = await post('/v1/conversations/c-h/page-results', A, { id: ev.id, pageId: PAGE, ok: true, result: { ok: true } });
          statuses.push(['dup', dup.status, (await dup.json()).code]);
        }
      };
      void answer();
    }
    return ev.type === 'end';
  });
  assert.equal(mine.status, 200);
  const reqs = mine.events.filter((e) => e.type === 'page.request');
  assert.deepEqual(reqs.map((r) => [r.tool, r.args]), [['seek', { t: 6 }], ['pause', {}]]);
  assert.ok(reqs.every((r) => r.seq === undefined));
  const results = mine.events.filter((e) => e.type === 'tool_result');
  assert.deepEqual(results.map((e) => [e.name, e.ok]), [['seek', true], ['pause', true]]);
  await waitFor(() => statuses.length === 5, 3000, '各次交回都有了回答');
  assert.deepEqual(statuses.slice(0, 4), [['bob', 404, 'not-found'], ['anon', 401, 'unauthorized'], ['alice', 200, true], ['dup', 410, 'page-request-gone']]);
  assert.deepEqual(statuses[4], ['alice', 200, true]);
  // 这一轮结束之后再交:410;补发里没有 page.request
  const late = await post('/v1/conversations/c-h/page-results', A, { id: firstReq.id, pageId: PAGE, ok: true, result: { ok: true } });
  assert.equal(late.status, 410);
  assert.equal((await late.json()).code, 'page-request-gone');
  const replay = await readSse(`${svc.url}/v1/conversations/c-h/events?after=0`, A);
  assert.equal(replay.events.some((e) => e.type === 'page.request'), false);
  assert.ok(replay.events.every((e) => Number.isSafeInteger(e.seq)));
  // 没有的对话:404;对话 id 不合法:400
  assert.equal((await post('/v1/conversations/c-none/page-results', A, { id: 'x', pageId: PAGE, ok: true })).status, 404);
  assert.equal((await post('/v1/conversations/bad%20id/page-results', A, { id: 'x', pageId: PAGE, ok: true })).status, 400);
});
