// 0.7.18 验收证据补充（conv 组）：Agent 共有/私有、发送者、谁能切换、谁能停任务、创建者没有特权、
// 撤销一个登录不误伤别人；以及「同项目同一个人最多 50 个对话」中 main 上能验的部分。
//
// 真的组合见 accept-018-conv-stack.mjs：VisuHive 账号库与凭证、文档服务的账号权限、对话权威、任务授权，同一份 SQLite 账本。
// 需要环境变量 PROMPTCUT_ACCOUNT_PROVIDER_ROOT；没有就跳过（不是通过）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startStack, skipReason, servicePrincipal } from './accept-018-conv-stack.mjs';
import { canonicalReadRecord } from '../account/run-authority.mjs';
import { digestOf } from '../account/ledger.mjs';

const opts = { skip: skipReason };
async function scene(t) {
  const s = await startStack(); t.after(() => s.close());
  const creator = s.account('creator'), alice = s.account('alice'), bob = s.account('bob'), xavier = s.account('xavier');
  const c1 = creator.login('creator-pc'), a1 = alice.login('alice-pc'), a2 = alice.login('alice-phone'), b1 = bob.login('bob-pc'), x1 = xavier.login('xavier-pc');
  const { projectId, admin } = await s.project(c1, [a1, b1]); // xavier 不是成员
  return { s, creator, alice, bob, xavier, c1, a1, a2, b1, x1, projectId, admin };
}
/** 取队首消息的一轮任务并确认 Agent 已读。 */
async function startRun(s, projectId, conversationId, requestId) {
  const g = await s.f.provider.admit({ servicePrincipal, projectId, conversationId, requestId });
  assert.ok(g.runGrantId, `没有领到任务：${JSON.stringify(g)}`);
  const prompt = canonicalReadRecord(g.message, g);
  await s.f.provider.confirmRead({ servicePrincipal, projectId, conversationId, messageId: g.messageId, runId: g.runId, runGrantId: g.runGrantId,
    requestId: `read-${requestId}`, readIntentId: `intent-${requestId}`, prompt, promptDigest: digestOf(prompt) });
  return g;
}
const grant = (s, g) => s.ledger().runGrantsV2[g.runGrantId];
const conv = (s, projectId, id) => s.ledger().conversationsV2[projectId][id];
const rejectedWith = (status, code) => error => (status === undefined || error.status === status) && (code === undefined || error.code === code);

test('2.1-3 新建默认共有；A/B 读完整历史、回复、发消息且逐条记实际作者；项目外账号与未登录被拒；同账号换设备可继续', opts, async t => {
  const { s, alice, bob, a1, a2, b1, c1, x1, projectId } = await scene(t);
  const first = await s.send(projectId, a1, 'conv_shared', 'a-1', '甲先发');
  assert.equal(first.conversation.visibility, 'shared', '新建默认共有');
  assert.equal(first.conversation.ownerAccountId, alice.id);
  const second = await s.send(projectId, b1, 'conv_shared', 'b-1', '乙回复');
  assert.equal(second.queuePosition, 2);
  // 乙能读到甲发的完整历史；创建者也能读共有对话。
  for (const entry of [b1, c1]) {
    const view = await s.call('get', projectId, entry, { conversationId: 'conv_shared' });
    assert.deepEqual(view.messages.map(m => [m.senderAccountId, m.content]), [[alice.id, '甲先发'], [bob.id, '乙回复']]);
    assert.deepEqual(view.messages.map(m => m.senderNameAtSend), ['alice', 'bob'], '逐条记实际作者，不是对话所属账号');
    assert.equal((await s.call('list', projectId, entry, {})).length, 1);
  }
  // 同账号换一台设备：看得到全部历史，也能继续发消息，作者仍是同一个账号。
  const phone = await s.call('get', projectId, a2, { conversationId: 'conv_shared' });
  assert.equal(phone.messages.length, 2);
  await s.send(projectId, a2, 'conv_shared', 'a-2', '甲在手机上发');
  const last = (await s.call('get', projectId, a1, { conversationId: 'conv_shared' })).messages.at(-1);
  assert.equal(last.senderAccountId, alice.id);
  // 项目外账号：列表、读、发都被拒（文档服务核对不在名单里）。
  await assert.rejects(s.call('list', projectId, x1, {}), rejectedWith(403, 'not-listed'));
  await assert.rejects(s.call('get', projectId, x1, { conversationId: 'conv_shared' }), rejectedWith(403, 'not-listed'));
  await assert.rejects(s.send(projectId, x1, 'conv_shared', 'x-1', '外人想发'), rejectedWith(403, 'not-listed'));
  // 未登录：没有授权引用、授权引用不存在，都是 401；消息表里没有外人的字。
  await assert.rejects(s.conversationAuthority.list({ principalRef: {}, projectId }), rejectedWith(401, 'login-required'));
  await assert.rejects(s.conversationAuthority.get({ principalRef: { authorizationId: 'never-issued' }, projectId, conversationId: 'conv_shared' }), rejectedWith(401, 'authorization-expired'));
  await assert.rejects(s.conversationAuthority.send({ principalRef: { authorizationId: 'never-issued' }, projectId, conversationId: 'conv_shared', requestId: 'anon-1', content: 'x', selectionInput: { pageId: 'p' } }), rejectedWith(401, 'authorization-expired'));
  assert.deepEqual(conv(s, projectId, 'conv_shared').messages.map(m => m.senderAccountId), [alice.id, bob.id, alice.id]);
});

test('2.1-3 私有：仅所属账号能用；创建者能看不能发；别的成员读和发都被拒；只有开对话的人能切换；切私有后别的成员立刻看不到', opts, async t => {
  const { s, alice, a1, b1, c1, projectId } = await scene(t);
  await s.send(projectId, a1, 'conv_x', 'a-1', '甲的对话');
  await s.send(projectId, b1, 'conv_x', 'b-1', '乙在共有对话里发的');
  // 不是开对话的人（乙、创建者）都切不了：403 owner-required。
  for (const entry of [b1, c1]) await assert.rejects(s.call('switchVisibility', projectId, entry,
    { conversationId: 'conv_x', visibility: 'private', requestId: `sw-${entry.device}` }), rejectedWith(403, 'owner-required'));
  assert.equal(conv(s, projectId, 'conv_x').visibility, 'shared');
  // 乙此刻读得到；开对话的人切成私有以后，同一个乙的下一次读就是看不到（404，不是 403，不泄露存在）。
  assert.equal((await s.call('get', projectId, b1, { conversationId: 'conv_x' })).messages.length, 2);
  const switched = await s.call('switchVisibility', projectId, a1, { conversationId: 'conv_x', visibility: 'private', requestId: 'sw-a' });
  assert.equal(switched.visibility, 'private');
  assert.deepEqual(switched.cancelled.length, 1, '乙排着没轮到的那条消息作废');
  await assert.rejects(s.call('get', projectId, b1, { conversationId: 'conv_x' }), rejectedWith(404, 'no-conversation'));
  await assert.rejects(s.send(projectId, b1, 'conv_x', 'b-2', '乙再发'), rejectedWith(404, 'no-conversation'));
  assert.equal((await s.call('list', projectId, b1, {})).length, 0, '乙的历史列表里没有这个对话');
  // 所属账号自己：照常读写。
  assert.equal((await s.call('get', projectId, a1, { conversationId: 'conv_x' })).messages.length, 2);
  await s.send(projectId, a1, 'conv_x', 'a-2', '私有后甲继续');
  // 创建者：列表里有（只读标记），能读全部内容，发消息和切换都被拒。
  const row = (await s.call('list', projectId, c1, {})).find(c => c.id === 'conv_x');
  assert.equal(row.creatorReadOnly, true);
  const view = await s.call('get', projectId, c1, { conversationId: 'conv_x' });
  assert.equal(view.creatorReadOnly, true); assert.equal(view.messages.length, 3);
  await assert.rejects(s.send(projectId, c1, 'conv_x', 'c-1', '创建者想在私有里发'), rejectedWith(404, 'no-conversation'));
  await assert.rejects(s.call('switchVisibility', projectId, c1, { conversationId: 'conv_x', visibility: 'shared', requestId: 'sw-c' }), rejectedWith(404, 'no-conversation'));
  // 乙也不能偷偷切回共有。
  await assert.rejects(s.call('switchVisibility', projectId, b1, { conversationId: 'conv_x', visibility: 'shared', requestId: 'sw-b' }), rejectedWith(404, 'no-conversation'));
  // 所属账号切回共有，乙又看得到。
  assert.equal((await s.call('switchVisibility', projectId, a1, { conversationId: 'conv_x', visibility: 'shared', requestId: 'sw-a2' })).visibility, 'shared');
  assert.equal((await s.call('get', projectId, b1, { conversationId: 'conv_x' })).messages.length, 3);
  assert.equal(conv(s, projectId, 'conv_x').ownerAccountId, alice.id);
});

test('2.1-3 停任务的权限：每个人只能停自己发起的那一轮，创建者能停任何人的（含别人私有对话里的），外人和未登录不能', opts, async t => {
  const { s, alice, bob, a1, b1, c1, x1, projectId } = await scene(t);
  // 共有对话：甲先发、乙后发，先跑甲那一轮。
  await s.send(projectId, a1, 'conv_stop', 'a-1', '甲的任务');
  await s.send(projectId, b1, 'conv_stop', 'b-1', '乙的任务');
  const ga = await startRun(s, projectId, 'conv_stop', 'admit-a');
  assert.equal(ga.accountId, alice.id);
  const stop = (entry, runId, requestId) => s.call('stop', projectId, entry, { conversationId: 'conv_stop', runId, requestId });
  // 乙不是发起人、也不是创建者：停不了甲的。
  await assert.rejects(stop(b1, ga.runId, 'stop-b'), rejectedWith(403, 'initiator-required'));
  await assert.rejects(stop(x1, ga.runId, 'stop-x'), rejectedWith(403, 'not-listed'));
  await assert.rejects(s.conversationAuthority.stop({ principalRef: {}, projectId, conversationId: 'conv_stop', runId: ga.runId, requestId: 'stop-anon' }), rejectedWith(401, 'login-required'));
  assert.equal(grant(s, ga).state, 'active', '被拒的停止没有动那一轮');
  assert.equal(conv(s, projectId, 'conv_stop').currentRunId, ga.runId);
  // 甲停自己的：这一轮的授权作废，对话空出来；乙排着的消息不受影响。
  assert.deepEqual(await stop(a1, ga.runId, 'stop-a'), { ok: true, runId: ga.runId });
  assert.equal(grant(s, ga).state, 'revoked'); assert.equal(grant(s, ga).reason, 'stop');
  assert.equal(conv(s, projectId, 'conv_stop').currentRunId, null);
  assert.equal(conv(s, projectId, 'conv_stop').messages.find(m => m.messageId === ga.messageId).queueState, 'cancelled');
  assert.equal(conv(s, projectId, 'conv_stop').messages.find(m => m.requestId === 'b-1').queueState, 'queued', '停甲的任务不误伤乙排着的消息');
  // 已经停掉的那一轮再停：404，不是成功。
  await assert.rejects(stop(a1, ga.runId, 'stop-a-again'), rejectedWith(404, 'no-run'));
  // 乙那一轮：对话所属人甲也停不了（只能停自己发起的）；创建者能停。
  const gb = await startRun(s, projectId, 'conv_stop', 'admit-b');
  assert.equal(gb.accountId, bob.id);
  await assert.rejects(stop(a1, gb.runId, 'stop-a-on-b'), rejectedWith(403, 'initiator-required'));
  assert.equal(grant(s, gb).state, 'active');
  assert.deepEqual(await stop(c1, gb.runId, 'stop-c-on-b'), { ok: true, runId: gb.runId });
  assert.equal(grant(s, gb).state, 'revoked');
  // 乙自己停自己的：另起一轮验证。
  await s.send(projectId, b1, 'conv_stop', 'b-2', '乙再发一条');
  const gb2 = await startRun(s, projectId, 'conv_stop', 'admit-b2');
  assert.deepEqual(await stop(b1, gb2.runId, 'stop-b-own'), { ok: true, runId: gb2.runId });
  // 别人私有对话里的任务：创建者仍然能停（创建者能停任何人的任务），其他成员连对话都看不到。
  await s.send(projectId, b1, 'conv_priv', 'b-p1', '乙的私有任务');
  await s.call('switchVisibility', projectId, b1, { conversationId: 'conv_priv', visibility: 'private', requestId: 'sw-b' });
  const gp = await startRun(s, projectId, 'conv_priv', 'admit-p');
  await assert.rejects(s.call('stop', projectId, a1, { conversationId: 'conv_priv', runId: gp.runId, requestId: 'stop-a-priv' }), rejectedWith(404, 'no-conversation'));
  assert.deepEqual(await s.call('stop', projectId, c1, { conversationId: 'conv_priv', runId: gp.runId, requestId: 'stop-c-priv' }), { ok: true, runId: gp.runId });
  assert.equal(grant(s, gp).state, 'revoked');
});

test('2.1-3 创建者与参与者发起的 Agent 能做的事相同：创建者特权一律被拒；撤销一个登录不误伤同账号别的登录和别的成员', opts, async t => {
  const { s, creator, alice, a1, a2, b1, c1, projectId } = await scene(t);
  await s.send(projectId, c1, 'conv_same', 'c-1', '创建者发起');
  await s.send(projectId, a1, 'conv_same', 'a-1', '参与者发起');
  const gc = await startRun(s, projectId, 'conv_same', 'admit-c');
  const principalC = await s.f.provider.resolveRunPrincipal({ servicePrincipal, projectId, runGrantId: gc.runGrantId });
  const accessC = await s.f.provider.checkAccess({ principal: principalC, projectId, action: 'write' });
  assert.equal(principalC.creator, false, '创建者发起的这一轮，Agent 身份里没有创建者标记');
  assert.equal(accessC.allowed, true);
  await assert.rejects(s.f.provider.checkAccess({ principal: principalC, projectId, action: 'admin' }), rejectedWith(403, 'run-principal-invalid'));
  await s.f.provider.finish({ servicePrincipal, projectId, conversationId: 'conv_same', messageId: gc.messageId, runId: gc.runId, runGrantId: gc.runGrantId, requestId: 'finish-c' });
  const ga = await startRun(s, projectId, 'conv_same', 'admit-a');
  assert.equal(ga.accountId, alice.id);
  const principalA = await s.f.provider.resolveRunPrincipal({ servicePrincipal, projectId, runGrantId: ga.runGrantId });
  const accessA = await s.f.provider.checkAccess({ principal: principalA, projectId, action: 'write' });
  assert.equal(principalA.creator, false);
  assert.deepEqual(Object.keys(accessA).sort(), Object.keys(accessC).sort(), '两种发起人拿到的结果形状一样');
  await assert.rejects(s.f.provider.checkAccess({ principal: principalA, projectId, action: 'admin' }), rejectedWith(403, 'run-principal-invalid'));
  // 文档服务一侧：Agent 身份(trustedRole=agent)要管理项目，创建者本人和参与者一样被拒。
  for (const entry of [c1, a1]) await assert.rejects(s.authority.authorizePrincipal({ accessToken: entry.accessToken }, { projectId, action: 'admin', trustedRole: 'agent' }), rejectedWith(403, 'creator-required'));
  assert.equal(creator.id, s.ledger().projects[projectId].creatorAccountId);

  // 撤销一个旧登录：甲的手机登录和乙都不受影响。
  await s.f.provider.finish({ servicePrincipal, projectId, conversationId: 'conv_same', messageId: ga.messageId, runId: ga.runId, runGrantId: ga.runGrantId, requestId: 'finish-a' });
  await s.send(projectId, a1, 'conv_same', 'a-2', '旧登录排着的');
  await s.send(projectId, b1, 'conv_same', 'b-1', '乙排着的');
  s.store.logoutLogin(a1.loginId, Date.now()); await s.authority.synchronize();
  await assert.rejects(s.send(projectId, a1, 'conv_same', 'a-3', '旧登录再发'), rejectedWith(401, 'credential-revoked'));
  await s.send(projectId, a2, 'conv_same', 'a-4', '同账号别的设备照常发');
  await s.send(projectId, b1, 'conv_same', 'b-2', '乙照常发');
  const next = await s.f.provider.admit({ servicePrincipal, projectId, conversationId: 'conv_same', requestId: 'admit-after-revoke' });
  const queue = conv(s, projectId, 'conv_same').messages;
  assert.equal(queue.find(m => m.requestId === 'a-2').queueState, 'cancelled', '被撤销的那个登录排着的消息作废');
  assert.equal(next.accountId, s.ledger().conversationsV2[projectId].conv_same.messages.find(m => m.requestId === 'b-1').senderAccountId, '轮到的是乙，不是被误伤');
  assert.equal(queue.find(m => m.requestId === 'a-4').queueState, 'queued');
});

test('RS18-chat 同项目同一个人 49→50→第 51：只拦新建，已有对话照常；另一个人、另一个项目不受影响；共享对话里多个发送者', opts, async t => {
  const { s, alice, bob, a1, b1, c1, projectId } = await scene(t);
  for (let i = 1; i <= 49; i++) await s.send(projectId, a1, `conv_${i}`, `a-${i}`);
  assert.equal(Object.values(s.ledger().conversationsV2[projectId]).filter(c => c.ownerAccountId === alice.id).length, 49);
  await s.send(projectId, a1, 'conv_50', 'a-50'); // 第 50 个：放行
  await assert.rejects(s.send(projectId, a1, 'conv_51', 'a-51'), rejectedWith(409, 'conversation-limit'));
  assert.equal(conv(s, projectId, 'conv_51'), undefined, '第 51 个没有建出来');
  assert.equal(Object.keys(s.ledger().conversationsV2[projectId]).length, 50, '没有淘汰最早的');
  // 已有对话里继续发消息不算新建。
  await s.send(projectId, a1, 'conv_1', 'a-1-more', '老对话里接着发');
  // 同项目的另一个人：自己的名额是满的 50 个；在别人的共有对话里发言不占自己的名额。
  await s.send(projectId, b1, 'conv_1', 'b-in-1', '乙在甲的共有对话里发言');
  await s.send(projectId, b1, 'conv_from_bob', 'b-new', '乙自己新建');
  assert.equal(conv(s, projectId, 'conv_1').messages.map(m => m.senderAccountId).join() , [alice.id, alice.id, bob.id].join(), '同一个共有对话里多个发送者逐条记作者');
  assert.equal(Object.values(s.ledger().conversationsV2[projectId]).filter(c => c.ownerAccountId === bob.id).length, 1);
  // 创建者也有自己的名额。
  await s.send(projectId, c1, 'conv_from_creator', 'c-new', '创建者新建');
  // 另一个项目（同一个甲）：名额按项目算，甲在那里可以新建。
  const second = await s.project(c1, [a1]);
  await s.send(second.projectId, a1, 'conv_other_project', 'a-other', '另一个项目里的第 1 个');
  assert.equal(Object.keys(s.ledger().conversationsV2[second.projectId]).length, 1);
  // 同一个编号的对话不会被另一个人在同一项目里冒用成自己的：乙对 conv_2 发言是进别人的共有对话，不是新建。
  await s.send(projectId, b1, 'conv_2', 'b-in-2', '乙进甲的第 2 个对话');
  assert.equal(conv(s, projectId, 'conv_2').ownerAccountId, alice.id);
});

test('RS18-chat 并发新建不超过 50：同一个人一次并发发出 60 个新对话，恰好 50 个成功、10 个被拦；重复请求幂等', opts, async t => {
  const { s, bob, b1, projectId } = await scene(t);
  const results = await Promise.allSettled(Array.from({ length: 60 }, (_, i) => s.send(projectId, b1, `conv_par_${i}`, `par-${i}`)));
  const ok = results.filter(r => r.status === 'fulfilled'), blocked = results.filter(r => r.status === 'rejected');
  assert.equal(ok.length, 50); assert.equal(blocked.length, 10);
  assert.ok(blocked.every(r => r.reason.status === 409 && r.reason.code === 'conversation-limit'), JSON.stringify(blocked.map(r => r.reason?.code)));
  assert.equal(Object.values(s.ledger().conversationsV2[projectId]).filter(c => c.ownerAccountId === bob.id).length, 50);
  // 同一个请求编号并发重复发：只落一条消息。
  const dup = await Promise.all([s.send(projectId, b1, 'conv_par_0', 'dup-1', '重复'), s.send(projectId, b1, 'conv_par_0', 'dup-1', '重复')]);
  assert.equal(dup[0].messageId, dup[1].messageId);
  assert.equal(conv(s, projectId, 'conv_par_0').messages.filter(m => m.requestId === 'dup-1').length, 1);
});
