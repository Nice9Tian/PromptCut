// W2(本人页面反向通道)单测。运行授权、对话权限、文档服务的在场表、请求记录都是真的 SQLite 底座(见 cloud-tools-w2-fixture.mjs)。
// 跑:npm test -- server/test/cloud-tools-w2-bridge.test.mjs
//
//   W2-BIND   发起人与发起页只从文档服务的授权里取:请求只写给那一条流;调用方、模型都指定不了页面;伪造的运行上下文被拒
//   W2-OFF    发起页不在线的每一种:离开了文档服务、没挂事件流、等的中途断了、在场表取不到;同账号别的页面不算
//   W2-LATE   晚到的结果被拒且不产生效果:超时、这一轮结束、被停止、对话转私有(两种)、发起人被踢出、发起人退出登录
//   W2-DUP    重复交回同一份结果幂等;同号不同内容冲突;同一个请求号重复调用不让页面执行两次
//   W2-FORGE  伪造的页面号、请求号、随机数、别的成员、别的对话、别的项目的结果被拒,且不影响在等的那一次
//   W2-RESTART 重启后没答完的请求查得到、说得清,不是消失
//   W2-HANDOFF web_handoff 的提供方(云端浏览器那一半是假实现)
//   W2-SEL    get_selection 不走这条通道
import test from 'node:test';
import assert from 'node:assert/strict';
import { w2Fixture, projectId, conversationId, sleep, until } from './cloud-tools-w2-fixture.mjs';
import { createPageBridge, createPageControlTools, PageBridgeError, PAGE_BRIDGE_TOOLS, PAGE_CONTROL_TOOL_NAMES, checkedPageArgs } from '../agent/service/page-bridge.mjs';
import { createHandoffTools, HANDOFF_TEXT, HANDOFF_TOOL_NAMES } from '../agent/service/hosted-handoff.mjs';
import { initiatorOffline } from '../agent/service/cloud-tools.mjs';

const RID = (n) => `request-${String(n).padStart(4, '0')}`;
const gone = { code: 'page-request-gone', status: 410 };
const firstEvent = (page) => until(() => page.events[0], { what: 'page.request on the stream' });

test('W2 factory refuses to start without its dependencies', () => {
  assert.throws(() => createPageBridge({}), (e) => e instanceof PageBridgeError && e.code === 'page-bridge-configuration' && e.status === 503);
  assert.throws(() => createPageControlTools({}), { code: 'page-bridge-configuration' });
  assert.throws(() => createHandoffTools({}), { code: 'page-bridge-configuration' });
});

test('W2-BIND seek reaches only the page the doc-confirmed sender used; other pages of the same account and other members get nothing', async (t) => {
  const f = await w2Fixture(t);
  const second = await f.openPage('sender', 'page-second-tab');     // 发起人的另一个页签
  const member = await f.openPage('other', 'page-other-member');    // 另一个成员
  const liar = await f.openPage('other', 'page-liar');              // 另一个成员,向 Agent 服务谎报发起人的页面号
  f.initiatorPage.attach(f.bridge); second.attach(f.bridge); member.attach(f.bridge);
  liar.attach(f.bridge, { reportPageId: 'page-initiator' });

  const pending = f.control.call('seek', { t: 12.5 }, f.context, { requestId: RID(1) });
  const event = await firstEvent(f.initiatorPage);
  assert.deepEqual({ ...event, nonce: '<nonce>', timeoutMs: 0 }, { type: 'page.request', v: 2, id: RID(1), nonce: '<nonce>', runId: f.grant.runId,
    pageId: 'page-initiator', tool: 'seek', args: { t: 12.5 }, timeoutMs: 0 });
  assert.match(event.nonce, /^[A-Za-z0-9_-]{16,64}$/);
  assert.equal(event.seq, undefined, '不带 seq,不进事件记录');
  assert.deepEqual([second.events, member.events, liar.events], [[], [], []]);
  assert.equal(f.row(RID(1)).state, 'pending');
  assert.equal(f.row(RID(1)).nonce_digest.includes(event.nonce), false, '库里不存随机数原文');

  assert.deepEqual(await f.initiatorPage.answer(f.bridge, event), { ok: true });
  assert.deepEqual(await pending, { ok: true });
  assert.deepEqual(f.playheads, [{ runId: f.grant.runId, t: 12.5 }], 'seek 做成后才通知宿主改播放头');
  const row = f.row(RID(1));
  assert.deepEqual([row.state, row.initiator_account_id, row.page_id, row.run_id, row.grant_id], ['answered', 'sender', 'page-initiator', f.grant.runId, f.grant.runGrantId]);

  // play / pause 同一条路
  const play = f.control.call('play', {}, f.context, { requestId: RID(2) });
  const playEvent = await until(() => f.initiatorPage.events[1], { what: 'play request' });
  assert.deepEqual([playEvent.tool, playEvent.args], ['play', {}]);
  await f.initiatorPage.answer(f.bridge, playEvent);
  assert.deepEqual(await play, { ok: true });
  // 页面说没做成:原样告诉模型,不算不在线
  const pause = f.control.call('pause', undefined, f.context, { requestId: RID(3) });
  const pauseEvent = await until(() => f.initiatorPage.events[2], { what: 'pause request' });
  await f.initiatorPage.answer(f.bridge, pauseEvent, { answer: { ok: false, error: '播放器坏了' } });
  assert.deepEqual(await pause, { ok: false, error: '播放器坏了' });
  assert.deepEqual([second.events, member.events, liar.events], [[], [], []]);
  assert.equal(f.logs.some((line) => JSON.stringify(line).includes(event.nonce) || JSON.stringify(line).includes('page-initiator')), false, '日志里没有随机数与页面号');
});

test('W2-BIND neither the caller nor the model can choose the page; a forged run context is refused before anything is sent', async (t) => {
  const f = await w2Fixture(t);
  const second = await f.openPage('sender', 'page-second-tab');
  const member = await f.openPage('other', 'page-other-member');
  f.initiatorPage.attach(f.bridge); second.attach(f.bridge); member.attach(f.bridge);
  const base = { run: f.context, tool: 'seek', args: { t: 1 } };
  // 调用方想挑同账号的另一个页签、别的成员的页面、或换一个发起人
  await assert.rejects(f.bridge.requestPage({ ...base, initiatorAccountId: 'sender', pageId: 'page-second-tab', requestId: RID(10) }), { code: 'page-binding-mismatch', status: 403 });
  await assert.rejects(f.bridge.requestPage({ ...base, initiatorAccountId: 'other', pageId: 'page-other-member', requestId: RID(11) }), { code: 'page-binding-mismatch' });
  await assert.rejects(f.bridge.requestPage({ ...base, initiatorAccountId: 'other', pageId: 'page-initiator', requestId: RID(12) }), { code: 'page-binding-mismatch' });
  await assert.rejects(f.bridge.requestPage({ ...base, initiatorAccountId: 'sender', pageId: null, requestId: RID(13) }), { code: 'page-binding-mismatch' });
  // 模型在参数里塞页面号、账号、项目:播放控制回一句参数不对,不发
  assert.deepEqual(await f.control.call('seek', { t: 1, pageId: 'page-second-tab' }, f.context), { ok: false, error: 'seek 要给 t(秒,不小于 0 的数)。' });
  assert.equal((await f.control.call('play', { pageId: 'page-second-tab', accountId: 'other' }, f.context)).ok, false);
  assert.equal((await f.control.call('seek', { t: -1 }, f.context)).ok, false);
  assert.throws(() => checkedPageArgs('seek', { t: 1, projectId }), { code: 'bad-args' });
  // 伪造的运行上下文(换一轮的号、换发送者、少字段)
  const who = await f.bridge.initiator(f.context);
  for (const forged of [{ ...f.context, runId: 'run_forged' }, { ...f.context, senderAccountId: 'other' }, { ...f.context, conversationId: 'another_conversation' }, { projectId, runGrantId: f.grant.runGrantId }]) {
    await assert.rejects(f.bridge.requestPage({ ...base, run: forged, initiatorAccountId: who.initiatorAccountId, pageId: who.pageId, requestId: RID(14) }),
      (e) => ['tool-context-untrusted', 'tool-context-invalid', 'run-access-denied'].includes(e.code));
    await assert.rejects(f.control.call('seek', { t: 1 }, forged));
  }
  await assert.rejects(f.bridge.requestPage({ ...base, initiatorAccountId: who.initiatorAccountId, pageId: who.pageId, requestId: 'x' }), { code: 'bad-request-id' });
  await assert.rejects(f.bridge.requestPage({ ...base, initiatorAccountId: who.initiatorAccountId, pageId: who.pageId, requestId: RID(15), page: 'page-second-tab' }), { code: 'bad-request' });
  assert.deepEqual([f.initiatorPage.events, second.events, member.events], [[], [], []], '一条请求都没发出去');
  assert.deepEqual(f.rows(), [], '也没有留下记录');
  assert.deepEqual(who, { initiatorAccountId: 'sender', pageId: 'page-initiator', grantState: 'active' });
});

test('W2-OFF initiator page gone from the doc service: offline at once, even though the same account has another page attached', async (t) => {
  const f = await w2Fixture(t, { limits: { pageMs: 5_000, attachMs: 3_000 } });
  const second = await f.openPage('sender', 'page-second-tab');
  second.attach(f.bridge);
  f.initiatorPage.attach(f.bridge);
  f.initiatorPage.leaveDoc();                       // 发起页关了(它到 Agent 服务的那条流还没来得及断)
  const started = Date.now();
  assert.deepEqual(await f.control.call('seek', { t: 3 }, f.context, { requestId: RID(20) }), initiatorOffline('seek'));
  assert.ok(Date.now() - started < 1_000, '不等时限,立刻回');
  assert.deepEqual([f.initiatorPage.events, second.events], [[], []], '同账号的另一个页签不顶替');
  assert.deepEqual([f.row(RID(20)).state, f.row(RID(20)).reason], ['offline', 'page-not-live']);
  assert.equal(f.playheads.length, 0);
  // 在场表取不到(文档服务没答)也按不在线办
  const g = await w2Fixture(t);
  g.initiatorPage.attach(g.bridge);
  g.flags.presenceDown = true;
  assert.deepEqual(await g.control.call('play', {}, g.context, { requestId: RID(21) }), initiatorOffline('play'));
  assert.equal(g.row(RID(21)).reason, 'presence-unavailable');
  assert.deepEqual(g.initiatorPage.events, []);
});

test('W2-OFF page is at the doc service but its event stream is not attached: wait briefly, then offline; attaching in time delivers', async (t) => {
  const f = await w2Fixture(t, { limits: { pageMs: 2_000, attachMs: 200 } });
  const second = await f.openPage('sender', 'page-second-tab');
  second.attach(f.bridge);
  const started = Date.now();
  assert.deepEqual(await f.control.call('pause', {}, f.context, { requestId: RID(30) }), initiatorOffline('pause'));
  const waited = Date.now() - started;
  assert.ok(waited >= 150 && waited < 1_500, `等了 ${waited}ms`);
  assert.equal(f.row(RID(30)).reason, 'page-not-attached');
  assert.deepEqual(second.events, []);
  // 刚发完消息、流晚一点才接上:接上就照常发
  const pending = f.control.call('seek', { t: 4 }, f.context, { requestId: RID(31) });
  await sleep(60);
  f.initiatorPage.attach(f.bridge);
  const event = await firstEvent(f.initiatorPage);
  await f.initiatorPage.answer(f.bridge, event);
  assert.deepEqual(await pending, { ok: true });
});

test('W2-OFF stream drops while waiting: offline immediately, and the result that arrives afterwards is refused', async (t) => {
  const f = await w2Fixture(t, { limits: { pageMs: 5_000, attachMs: 100 } });
  f.initiatorPage.attach(f.bridge);
  const pending = f.control.call('seek', { t: 8 }, f.context, { requestId: RID(40) });
  const event = await firstEvent(f.initiatorPage);
  const started = Date.now();
  f.initiatorPage.detach();
  assert.deepEqual(await pending, initiatorOffline('seek'));
  assert.ok(Date.now() - started < 1_000);
  await assert.rejects(f.initiatorPage.answer(f.bridge, event), { code: 'page-request-offline', status: 410 });
  assert.deepEqual([f.row(RID(40)).state, f.row(RID(40)).reason, f.playheads.length], ['offline', 'page-disconnected', 0]);
  // 同一张页面重连(页面号不变):之后的请求照常
  f.initiatorPage.events.length = 0;
  f.initiatorPage.attach(f.bridge);
  const again = f.control.call('seek', { t: 9 }, f.context, { requestId: RID(41) });
  await f.initiatorPage.answer(f.bridge, await firstEvent(f.initiatorPage));
  assert.deepEqual(await again, { ok: true });
});

test('W2-LATE timeout: the tool gets offline and the late result is refused without effect', async (t) => {
  const f = await w2Fixture(t, { limits: { pageMs: 150, attachMs: 50 } });
  f.initiatorPage.attach(f.bridge);
  const pending = f.control.call('seek', { t: 5 }, f.context, { requestId: RID(50) });
  const event = await firstEvent(f.initiatorPage);
  assert.deepEqual(await pending, initiatorOffline('seek'));
  await assert.rejects(f.initiatorPage.answer(f.bridge, event), { code: 'page-request-expired', status: 410 });
  assert.deepEqual([f.row(RID(50)).state, f.row(RID(50)).answer, f.playheads.length], ['expired', null, 0]);
  // 调用方给的时限再长也有上限;给一个已经过去的时限直接算过期
  f.initiatorPage.events.length = 0;
  assert.deepEqual(await f.request('play', {}, RID(51), { deadline: Date.now() - 1 }), { delivered: false, offline: true, why: 'deadline', state: 'expired' });
  assert.deepEqual(f.initiatorPage.events, []);
});

test('W2-LATE run ended or cancelled by the host: waiting requests are closed and late results refused', async (t) => {
  const f = await w2Fixture(t, { limits: { pageMs: 5_000 } });
  f.initiatorPage.attach(f.bridge);
  const controller = new AbortController();
  const a = f.control.call('seek', { t: 5 }, f.context, { requestId: RID(60) });
  const b = f.control.call('play', {}, f.context, { requestId: RID(61), signal: controller.signal });
  const [first, second] = [await firstEvent(f.initiatorPage), await until(() => f.initiatorPage.events[1], { what: 'second request' })];
  controller.abort();
  assert.deepEqual(await b, initiatorOffline('play'));
  assert.equal(f.bridge.cancelRun({ projectId, conversationId, runId: 'another-run' }), 0, '别的一轮的不动');
  assert.equal(f.bridge.cancelRun({ projectId, conversationId, runId: f.grant.runId }, 'run-finished'), 1);
  assert.deepEqual(await a, initiatorOffline('seek'));
  await assert.rejects(f.initiatorPage.answer(f.bridge, first), { code: 'page-request-cancelled', status: 410 });
  await assert.rejects(f.initiatorPage.answer(f.bridge, second), { code: 'page-request-cancelled' });
  assert.deepEqual(f.rows().map((r) => [r.state, r.reason]), [['cancelled', 'run-finished'], ['cancelled', 'run-cancelled']]);
  assert.equal(f.playheads.length, 0);
});

test('W2-LATE stopped by the user (doc stop fence) before the result arrives: refused, and new requests fail closed', async (t) => {
  const f = await w2Fixture(t, { limits: { pageMs: 5_000 } });
  f.initiatorPage.attach(f.bridge);
  const pending = f.control.call('seek', { t: 5 }, f.context, { requestId: RID(70) });
  const event = await firstEvent(f.initiatorPage);
  f.stopRun();
  await assert.rejects(f.initiatorPage.answer(f.bridge, event), { code: 'page-request-run-revoked', status: 410 });
  assert.deepEqual(await pending, initiatorOffline('seek'));
  assert.deepEqual([f.row(RID(70)).state, f.row(RID(70)).reason, f.playheads.length], ['rejected', 'run-revoked', 0]);
  await assert.rejects(f.control.call('play', {}, f.context, { requestId: RID(71) }), { code: 'run-access-denied', status: 403 });
  assert.equal(f.initiatorPage.events.length, 1, '授权不在之后一条都不再发');
});

test('W2-LATE conversation made private while a member\'s run is waiting: that run is revoked and the late result refused', async (t) => {
  const f = await w2Fixture(t, { limits: { pageMs: 5_000 } });     // sender 发起,对话的主人是 owner
  f.initiatorPage.attach(f.bridge);
  const pending = f.control.call('seek', { t: 5 }, f.context, { requestId: RID(80) });
  const event = await firstEvent(f.initiatorPage);
  f.makePrivate();
  await assert.rejects(f.initiatorPage.answer(f.bridge, event), (e) => e.status === 410 && e.code !== 'page-request-gone');
  assert.deepEqual(await pending, initiatorOffline('seek'));
  assert.deepEqual([f.row(RID(80)).state, f.row(RID(80)).reason, f.playheads.length], ['rejected', 'submitter-denied', 0]);
});

test('W2-LATE owner makes their own conversation private mid-request: the in-flight result is refused, later requests work again', async (t) => {
  const f = await w2Fixture(t, { initiator: 'owner', limits: { pageMs: 5_000 } });
  f.initiatorPage.attach(f.bridge);
  const pending = f.control.call('seek', { t: 5 }, f.context, { requestId: RID(90) });
  const event = await firstEvent(f.initiatorPage);
  f.makePrivate();                                   // 主人自己的这一轮照常保留,但对话的权限版本变了
  await assert.rejects(f.initiatorPage.answer(f.bridge, event), { code: 'page-request-conversation-changed', status: 410 });
  assert.deepEqual(await pending, initiatorOffline('seek'));
  assert.deepEqual([f.row(RID(90)).state, f.row(RID(90)).reason, f.playheads.length], ['rejected', 'conversation-changed', 0]);
  const again = f.control.call('seek', { t: 6 }, f.context, { requestId: RID(91) });
  const next = await until(() => f.initiatorPage.events[1], { what: 'request after the switch' });
  assert.deepEqual(await f.initiatorPage.answer(f.bridge, next), { ok: true });
  assert.deepEqual(await again, { ok: true });
  assert.deepEqual(f.playheads, [{ runId: f.grant.runId, t: 6 }]);
});

test('W2-LATE initiator kicked out: their page no longer counts, the late result is refused, the retained run keeps going with offline answers', async (t) => {
  const f = await w2Fixture(t, { limits: { pageMs: 5_000 } });
  f.initiatorPage.attach(f.bridge);
  const pending = f.control.call('seek', { t: 5 }, f.context, { requestId: RID(100) });
  const event = await firstEvent(f.initiatorPage);
  f.kick('sender');
  await assert.rejects(f.initiatorPage.answer(f.bridge, event), { code: 'page-request-submitter-denied', status: 410 });
  assert.deepEqual(await pending, initiatorOffline('seek'));
  assert.deepEqual([f.row(RID(100)).state, f.playheads.length], ['rejected', 0]);
  // 已读的共有任务按例外保留着跑:工具不抛错,明确回「发起方不在线」,Agent 据此继续
  assert.equal((await f.resources.authorize(f.context, 'read')).grantState, 'retained');
  assert.deepEqual(await f.control.call('play', {}, f.context, { requestId: RID(101) }), initiatorOffline('play'));
  assert.deepEqual([f.row(RID(101)).state, f.row(RID(101)).reason], ['offline', 'initiator-revoked']);
  assert.equal(f.initiatorPage.events.length, 1);
});

test('W2-LATE initiator logged out everywhere (credential revoked): result from the old login is refused', async (t) => {
  const f = await w2Fixture(t, { limits: { pageMs: 5_000 } });
  f.initiatorPage.attach(f.bridge);
  const pending = f.control.call('pause', {}, f.context, { requestId: RID(110) });
  const event = await firstEvent(f.initiatorPage);
  f.authority.provider.applyAccessEvent(f.authority.exit('sender'));
  await assert.rejects(f.initiatorPage.answer(f.bridge, event), (e) => e.status === 410 && e.code !== 'page-request-gone');
  assert.deepEqual(await pending, initiatorOffline('pause'));
  assert.equal(f.row(RID(110)).state, 'rejected');
  // 核对身份的上游不可达:同样拒收(不猜)
  const g = await w2Fixture(t, { limits: { pageMs: 5_000 } });
  g.initiatorPage.attach(g.bridge);
  const waiting = g.control.call('pause', {}, g.context, { requestId: RID(111) });
  const ev = await firstEvent(g.initiatorPage);
  g.flags.authorityDown = true;
  await assert.rejects(g.initiatorPage.answer(g.bridge, ev), { status: 410 });
  g.flags.authorityDown = false;
  assert.deepEqual(await waiting, initiatorOffline('pause'));
  assert.equal(g.row(RID(111)).state, 'rejected');
});

test('W2-DUP the same result handed back twice is idempotent; a different one conflicts; a repeated requestId never runs the page twice', async (t) => {
  const f = await w2Fixture(t, { limits: { pageMs: 5_000 } });
  f.initiatorPage.attach(f.bridge);
  const pending = f.request('seek', { t: 7 }, RID(120));
  const same = f.request('seek', { t: 7 }, RID(120));               // 宿主重试同一次调用(还在等)
  await assert.rejects(f.request('seek', { t: 99 }, RID(120)), { code: 'idempotency-conflict', status: 409 });
  const event = await firstEvent(f.initiatorPage);
  const [x, y] = await Promise.all([f.initiatorPage.answer(f.bridge, event), f.initiatorPage.answer(f.bridge, event).catch((e) => e)]);
  assert.deepEqual(x, { ok: true });
  assert.ok(y?.duplicate === true || y?.ok === true, '并发的两次交回只有一次生效');
  assert.deepEqual(await f.initiatorPage.answer(f.bridge, event), { ok: true, duplicate: true });
  assert.deepEqual(await f.initiatorPage.answer(f.bridge, event), { ok: true, duplicate: true });
  await assert.rejects(f.initiatorPage.answer(f.bridge, event, { answer: { ok: true, result: { ok: true, t: 99 } } }), { code: 'page-result-conflict', status: 409 });
  const outcome = { delivered: true, answer: { ok: true, result: { ok: true } } };
  assert.deepEqual([await pending, await same], [outcome, outcome]);
  assert.deepEqual(await f.request('seek', { t: 7 }, RID(120)), outcome, '答完之后再用同一个号:回存下的结果');
  await assert.rejects(f.request('play', {}, RID(120)), { code: 'idempotency-conflict' });
  assert.equal(f.initiatorPage.events.length, 1, '页面只收到一次');
  assert.equal(f.rows().length, 1);
});

test('W2-FORGE forged page id, request id, nonce, another member, another conversation or project: all refused the same way and the real answer still lands', async (t) => {
  const f = await w2Fixture(t, { limits: { pageMs: 5_000 } });
  const second = await f.openPage('sender', 'page-second-tab');
  const member = await f.openPage('other', 'page-other-member');
  f.initiatorPage.attach(f.bridge); second.attach(f.bridge); member.attach(f.bridge);
  const pending = f.control.call('seek', { t: 2 }, f.context, { requestId: RID(130) });
  const event = await firstEvent(f.initiatorPage);
  const page = f.initiatorPage;
  const attempts = [
    ['别的成员拿着全部正确的字段交', { as: member.identity }],
    ['别的成员用自己的页面号交', { as: member.identity, over: { pageId: 'page-other-member' } }],
    ['同账号的另一个页签用自己的页面号交', { over: { pageId: 'page-second-tab' } }],
    ['编的页面号', { over: { pageId: 'page-made-up' } }],
    ['编的请求号', { over: { id: 'request-9999' } }],
    ['编的随机数', { over: { nonce: 'AAAAAAAAAAAAAAAAAAAAAAAA' } }],
    ['换一轮的号', { over: { runId: 'run_another' } }],
    ['交到别的对话上', { conversation: 'another_conversation' }],
    ['别的项目的同名账号', { as: { accountMode: true, accountId: 'sender', projectId: 'sp_another' } }],
  ];
  for (const [what, options] of attempts) {
    await assert.rejects(page.answer(f.bridge, event, options), gone, what);
    assert.equal(f.row(RID(130)).state, 'pending', `${what}:没有让在等的那一次结束`);
  }
  for (const bad of [{ over: { v: 1 } }, { over: { ok: 'yes' } }, { over: { extra: 1 } }, { over: { error: 5 } }]) await assert.rejects(page.answer(f.bridge, event, bad), { code: 'bad-request', status: 400 });
  await assert.rejects(f.bridge.acceptResult({ identity: null, conversationId, body: {} }), { code: 'bad-request' });
  assert.equal(f.playheads.length, 0);
  assert.deepEqual(await page.answer(f.bridge, event), { ok: true });
  assert.deepEqual(await pending, { ok: true });
  assert.deepEqual(f.playheads, [{ runId: f.grant.runId, t: 2 }]);
  // 太大的结果:413,这一次按页面没做成收掉,不让 Agent 干等
  const big = f.control.call('play', {}, f.context, { requestId: RID(131) });
  const bigEvent = await until(() => page.events[1], { what: 'second request' });
  await assert.rejects(page.answer(f.bridge, bigEvent, { answer: { ok: true, result: { blob: 'x'.repeat(70_000) } } }), { code: 'page-result-too-large', status: 413 });
  assert.deepEqual(await big, initiatorOffline('play'));
  assert.deepEqual([second.events, member.events], [[], []]);
});

test('W2-RESTART a request still waiting when the Agent service restarts is kept as interrupted: its state can be read and a late result is refused clearly', async (t) => {
  const f = await w2Fixture(t, { limits: { pageMs: 30_000 } });
  f.initiatorPage.attach(f.bridge);
  const pending = f.control.call('seek', { t: 5 }, f.context, { requestId: RID(140) });
  void pending.catch(() => {});
  const event = await firstEvent(f.initiatorPage);
  const done = f.request('play', {}, RID(141));
  await f.initiatorPage.answer(f.bridge, await until(() => f.initiatorPage.events[1], { what: 'second request' }));
  await done;
  assert.equal(f.row(RID(140)).state, 'pending');

  // 新进程打开同一个库(旧进程没来得及收尾就没了)
  const reborn = f.openBridge();
  assert.deepEqual(f.rows(), [{ request_id: RID(140), tool: 'seek', state: 'interrupted', reason: 'agent-restart' }, { request_id: RID(141), tool: 'play', state: 'answered', reason: null }]);
  const status = await reborn.status(f.context, RID(140));
  assert.deepEqual({ ...status, createdAt: 0, deadlineAt: 0, updatedAt: 0 }, { requestId: RID(140), projectId, conversationId, runId: f.grant.runId, tool: 'seek',
    state: 'interrupted', reason: 'agent-restart', createdAt: 0, deadlineAt: 0, updatedAt: 0 });
  assert.equal((await reborn.status(f.context, RID(141))).state, 'answered');
  await assert.rejects(reborn.status(f.context, 'request-0000'), { code: 'page-request-not-found', status: 404 });
  await assert.rejects(reborn.status({ ...f.context, runId: 'run_forged' }, RID(140)), (e) => e.status === 403);
  // 页面这时才交回:明确说是重启中断,不是「没有这个请求」;别人来交仍然是同一个 410
  f.initiatorPage.attach(reborn);
  await assert.rejects(f.initiatorPage.answer(reborn, event), { code: 'page-request-interrupted', status: 410 });
  const member = await f.openPage('other', 'page-other-member');
  await assert.rejects(f.initiatorPage.answer(reborn, event, { as: member.identity }), gone);
  // 同一个请求号在新进程里再调:回中断,不重新发给页面(旧实例的请求不复活)
  const who = await reborn.initiator(f.context);
  assert.deepEqual(await reborn.requestPage({ run: f.context, initiatorAccountId: who.initiatorAccountId, pageId: who.pageId, tool: 'seek', args: { t: 5 }, requestId: RID(140) }),
    { delivered: false, offline: true, why: 'agent-restart', state: 'interrupted' });
  assert.equal(f.initiatorPage.events.length, 2);
  // 已经答完的那一次:重启后重复交回仍然幂等
  assert.deepEqual(await f.initiatorPage.answer(reborn, f.initiatorPage.events[1]), { ok: true, duplicate: true });
  assert.equal(f.playheads.length, 0);
  assert.equal(f.row(RID(140)).answer, null);
});

test('W2 close(): waiting requests are cancelled, nothing is left pending, and later calls are refused', async (t) => {
  const f = await w2Fixture(t, { limits: { pageMs: 30_000 } });
  f.initiatorPage.attach(f.bridge);
  const pending = f.control.call('seek', { t: 5 }, f.context, { requestId: RID(150) });
  const event = await firstEvent(f.initiatorPage);
  assert.deepEqual(f.bridge.describe(), { waiting: 1, streams: 1, closed: false });
  assert.deepEqual(f.bridge.close('agent-off'), { streamsClosed: true, workPending: 0 });
  assert.deepEqual(await pending, initiatorOffline('seek'));
  assert.deepEqual(f.bridge.describe(), { waiting: 0, streams: 0, closed: true });
  assert.deepEqual([f.row(RID(150)).state, f.row(RID(150)).reason], ['cancelled', 'host-close']);
  await assert.rejects(f.initiatorPage.answer(f.bridge, event), { code: 'page-bridge-closed', status: 503 });
  await assert.rejects(f.control.call('play', {}, f.context), { code: 'page-bridge-closed' });
  assert.deepEqual(await f.control.close('agent-off'), { childrenClosed: true, streamsClosed: true, workPending: 0 });
});

test('W2-HANDOFF web_handoff asks only the initiator page, carries the cloud browser address, and never claims success it did not get', async (t) => {
  const f = await w2Fixture(t, { limits: { pageMs: 5_000, attachMs: 50 } });
  const second = await f.openPage('sender', 'page-second-tab');
  second.attach(f.bridge);
  f.initiatorPage.attach(f.bridge);
  const page = f.initiatorPage;
  assert.deepEqual([...f.handoff.handles], HANDOFF_TOOL_NAMES);
  // 模型不能指定地址或页面
  assert.equal((await f.handoff.call('web_handoff', { url: 'https://evil.example/' }, f.context)).ok, false);
  assert.equal((await f.handoff.call('web_handoff', { reason: 'x', pageId: 'page-second-tab' }, f.context)).ok, false);
  assert.equal((await f.handoff.call('web_handoff', { reason: 'x'.repeat(500) }, f.context)).ok, false);
  assert.equal(page.events.length, 0);

  const shown = f.handoff.call('web_handoff', { reason: 'B 站扫码登录' }, f.context, { requestId: RID(160) });
  const event = await firstEvent(page);
  assert.deepEqual([event.tool, event.args], ['web_handoff', { reason: 'B 站扫码登录', url: 'https://example.com/login' }]);
  await page.answer(f.bridge, event, { answer: { ok: true, result: { ok: true, visible: true } } });
  assert.deepEqual(await shown, { ok: true, visible: true, initiatorPage: true, message: HANDOFF_TEXT.shown('B 站扫码登录') });
  assert.deepEqual(second.events, []);

  const hidden = f.handoff.call('web_handoff', { hide: true }, f.context, { requestId: RID(161) });
  const hideEvent = await until(() => page.events[1], { what: 'hide request' });
  assert.deepEqual(hideEvent.args, { hide: true }, '收回时不带地址');
  await page.answer(f.bridge, hideEvent, { answer: { ok: true, result: { ok: true, visible: false } } });
  assert.deepEqual(await hidden, { ok: true, visible: false, initiatorPage: true, message: HANDOFF_TEXT.hidden });

  // 发起人用的是网页版(没有本机浏览器)
  const web = f.handoff.call('web_handoff', {}, f.context, { requestId: RID(162) });
  await page.answer(f.bridge, await until(() => page.events[2], { what: 'third request' }), { answer: { ok: false, code: 'unsupported', error: '这个页面没有可以交给用户的本机浏览器。' } });
  assert.deepEqual(await web, { ok: false, initiatorOnly: true, error: HANDOFF_TEXT.unsupported });
  // 云端浏览器没有开着的页、或当前页不是公开地址:不发给页面
  for (const target of [null, { url: 'file:///etc/passwd' }, { url: 'https://user:pw@example.com/' }]) {
    f.browser.target = target;
    assert.deepEqual(await f.handoff.call('web_handoff', {}, f.context), { ok: false, error: HANDOFF_TEXT.noPage });
  }
  assert.equal(page.events.length, 3);
  // 发起方不在线
  f.browser.target = { url: 'https://example.com/login' };
  page.detach();
  assert.deepEqual(await f.handoff.call('web_handoff', {}, f.context, { requestId: RID(163) }), initiatorOffline('web_handoff'));
  // 云端的网页操作(W1)还没接上:如实说,不假装交出去了
  const bare = createHandoffTools({ bridge: f.bridge });
  assert.deepEqual(await bare.call('web_handoff', { reason: 'x' }, f.context), { ok: false, cloudUnavailable: true, code: 'handoff-browser-unmounted', error: HANDOFF_TEXT.unmounted });
  assert.throws(() => createHandoffTools({ bridge: f.bridge, browser: {} }), { code: 'handoff-browser-configuration' });
  await assert.rejects(f.handoff.call('web_open', {}, f.context), { code: 'page-tool-unknown' });
  // 这一轮被停之后:授权错误照常往上抛,不回一句含糊的话
  f.stopRun();
  await assert.rejects(f.handoff.call('web_handoff', {}, f.context), { code: 'run-access-denied' });
});

test('W2-SEL get_selection never travels on this channel', async (t) => {
  const f = await w2Fixture(t);
  f.initiatorPage.attach(f.bridge);
  assert.deepEqual([...PAGE_BRIDGE_TOOLS], ['seek', 'play', 'pause', 'web_handoff']);
  assert.deepEqual([...f.control.handles], [...PAGE_CONTROL_TOOL_NAMES]);
  assert.equal(f.control.handles.has('get_selection'), false);
  await assert.rejects(f.request('get_selection', {}, RID(170)), { code: 'page-tool-unknown', status: 404 });
  await assert.rejects(f.control.call('get_selection', {}, f.context), { code: 'page-tool-unknown' });
  assert.deepEqual(f.initiatorPage.events, []);
  // 账号模式的 get_selection 的答案来自文档服务的在场表(夹具里是同一个真模块):发起人在线时是实时的,不是发消息时那一份
  const state = await f.selection.querySelections({ principal: { service: 'agent', tenantId: projectId }, projectId, runGrantId: f.grant.runGrantId });
  const me = state.members.find((m) => m.isInitiator);
  assert.deepEqual(me.pages.map((p) => [p.pageId, p.live, p.source ?? null]), [['page-initiator', true, null]]);
});
