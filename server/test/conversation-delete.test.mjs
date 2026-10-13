import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * 块五(0.7.18):同项目同一个人最多 50 个对话、不自动删历史;删除入口。
 * 规则出处:docs/plan/account-binding-task.md「已拍板」的「云端 Agent 对话的删除」(2026-10-12 用户定)。
 */
import { fixture, projectId, otherProjectId, ownerId, memberId, creatorId, bystanderId, readerId } from './conversation-delete-fixture.mjs';
import { createConversationAuthority, claimNextInState, MAX_CONVERSATIONS_PER_OWNER, MAX_PENDING_NOTICES, NOTICE_TTL_MS } from '../account/conversation-authority.mjs';
import { openAccountLedger } from '../account/ledger.mjs';

const rows = f => f.ledger.read().conversationsV2?.[projectId] ?? {};

/* ---------------------------------------------------------------- 50 个上限 */

test('RS18-chat 49→50→第51:满额拦新建、原来的 50 个一个不少，不自动删最旧的', async () => {
  const f = fixture();
  try {
    assert.equal(MAX_CONVERSATIONS_PER_OWNER, 50);
    for (let i = 0; i < 49; i++) await f.send(ownerId, `c${i}`, `r${i}`);
    assert.equal(Object.keys(rows(f)).length, 49);
    await f.send(ownerId, 'c49', 'r49'); // 第 50 个还能建
    assert.equal(Object.keys(rows(f)).length, 50);
    await assert.rejects(f.send(ownerId, 'c50', 'r50'), { status: 409, code: 'conversation-limit' });
    assert.equal(Object.keys(rows(f)).length, 50, '满额没有淘汰任何对话');
    assert.ok(rows(f).c0, '最旧的那个还在');
    assert.equal(rows(f).c50, undefined, '被拒的没有留下半个对话');
    // 已有的对话照常续写，不受上限影响
    await f.send(ownerId, 'c0', 'r-more', '续写');
    assert.equal(rows(f).c0.messages.length, 2);
    // 重放第 50 个对话第一条消息的同一个请求：回原结果，不算新建
    assert.equal((await f.send(ownerId, 'c49', 'r49')).messageId, rows(f).c49.messages[0].messageId);
  } finally { f.close(); }
});

test('RS18-chat 上限按「项目 × 开对话的人」各算各的；共有对话里别人发言不算他开了对话', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 50; i++) await f.send(ownerId, `c${i}`, `r${i}`);
    // 另一个人在同一个项目里照常建
    await f.send(memberId, 'm0', 'rm0');
    // 同一个人在另一个项目里照常建
    await f.send(ownerId, 'o0', 'ro0', 'x', otherProjectId);
    // 成员在 owner 满额的共有对话里发言:算他的发言，不占他的名额，也不占 owner 的
    for (let i = 0; i < 60; i++) await f.send(memberId, 'c0', `rx${i}`, `m${i}`);
    const mine = Object.values(rows(f)).filter(c => c.ownerAccountId === memberId);
    assert.equal(mine.length, 1, '成员只开了 m0 这一个');
    assert.equal(rows(f).c0.ownerAccountId, ownerId);
    await assert.rejects(f.send(ownerId, 'c50', 'r50'), { code: 'conversation-limit' });
  } finally { f.close(); }
});

test('RS18-chat 并发创建不越过 50', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 48; i++) await f.send(ownerId, `c${i}`, `r${i}`);
    const results = await Promise.allSettled(['x1', 'x2', 'x3', 'x4'].map(id => f.send(ownerId, id, `r-${id}`)));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 2, '只剩 2 个名额');
    assert.deepEqual(results.filter(r => r.status === 'rejected').map(r => r.reason.code), ['conversation-limit', 'conversation-limit']);
    assert.equal(Object.keys(rows(f)).length, 50);
  } finally { f.close(); }
});

test('RS18-chat 删一个以后立刻让出名额，能再建；删掉的对话号不复活', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 50; i++) await f.send(ownerId, `c${i}`, `r${i}`);
    await assert.rejects(f.send(ownerId, 'new1', 'rn1'), { code: 'conversation-limit' });
    const removed = await f.remove(ownerId, 'c7');
    assert.equal(removed.removed, true);
    assert.equal(Object.keys(rows(f)).length, 49, '删完立刻让出名额');
    await f.send(ownerId, 'new1', 'rn1');
    assert.equal(Object.keys(rows(f)).length, 50);
    await assert.rejects(f.send(ownerId, 'new2', 'rn2'), { code: 'conversation-limit' });
    // 删掉的对话号:新发、重放旧请求都当作没有，不会把它救回来
    await assert.rejects(f.send(ownerId, 'c7', 'brand-new'), { status: 404, code: 'conversation-deleted' });
    await assert.rejects(f.send(ownerId, 'c7', 'r7'), { status: 404, code: 'conversation-deleted' });
    assert.equal(rows(f).c7, undefined);
    // 列表里看不到
    assert.equal((await f.list(ownerId)).some(c => c.id === 'c7'), false);
  } finally { f.close(); }
});

/* ---------------------------------------------------------------- 谁能删 */

test('RS18-chat 谁能删谁的：开对话的人删自己的；创建者删任何人的(含私有)；其他成员不能删别人的', async () => {
  const f = fixture();
  try {
    await f.send(ownerId, 'shared1', 'r1');
    await f.send(ownerId, 'shared2', 'r2');
    await f.send(ownerId, 'shared3', 'r3');
    await f.authority.switchVisibility({ principalRef: f.ref(ownerId), projectId, conversationId: 'shared3', visibility: 'private', requestId: 'p3' });
    await f.send(ownerId, 'shared4', 'r4');
    await f.authority.switchVisibility({ principalRef: f.ref(ownerId), projectId, conversationId: 'shared4', visibility: 'private', requestId: 'p4' });

    // 别的普通成员：共有对话看得见但不能删(403)；私有对话当作没有(404)
    await assert.rejects(f.remove(memberId, 'shared1'), { status: 403, code: 'delete-forbidden' });
    await assert.rejects(f.remove(memberId, 'shared3'), { status: 404, code: 'no-conversation' });
    assert.ok(rows(f).shared1 && rows(f).shared3, '被拒的都还在');
    // 只读成员：连自己的也不行(只读成员不能操作 Agent)
    await assert.rejects(f.remove(readerId, 'shared1'), { status: 403 });
    // 开对话的人删自己的(共有、私有都行)
    assert.equal((await f.remove(ownerId, 'shared1')).removed, true);
    assert.equal((await f.remove(ownerId, 'shared3')).removed, true);
    // 创建者删别人的:共有行，别人的私有也行
    assert.equal((await f.remove(creatorId, 'shared2')).removed, true);
    assert.equal((await f.remove(creatorId, 'shared4')).removed, true);
    assert.deepEqual(Object.keys(rows(f)), []);
  } finally { f.close(); }
});

test('RS18-chat 被踢、登录被撤销的人删不了；不存在的对话 404', async () => {
  const f = fixture();
  try {
    await f.send(memberId, 'm1', 'r1');
    f.ledger.transaction(state => { state.projects[projectId].bans[memberId] = { reason: 'kick' }; });
    await assert.rejects(f.remove(memberId, 'm1'), { status: 403, code: 'banned' });
    f.ledger.transaction(state => { delete state.projects[projectId].bans[memberId]; state.revokedLogins[`login:login:${memberId}`] = { seq: 1 }; });
    await assert.rejects(f.remove(memberId, 'm1'), { status: 401 });
    await assert.rejects(f.remove(creatorId, 'nope'), { status: 404, code: 'no-conversation' });
    assert.ok(rows(f).m1, '都没删掉');
    // 创建者可以替被踢的成员清掉对话(让出的名额不再被占着)
    assert.equal((await f.remove(creatorId, 'm1')).removed, true);
  } finally { f.close(); }
});

test('RS18-chat 请求体里自报身份没用：删除只认文档服务核过的身份(不接受别的字段)', async () => {
  const f = fixture();
  try {
    await f.send(ownerId, 'c1', 'r1');
    // 直接调用时没有 principalRef 就拿不到身份
    await assert.rejects(f.authority.remove({ principalRef: { authorizationId: 'auth:forged' }, projectId, conversationId: 'c1', requestId: 'x' }), { status: 401 });
    await assert.rejects(f.authority.remove({ principalRef: f.ref(ownerId), projectId, conversationId: '../x', requestId: 'x' }), { status: 400 });
    await assert.rejects(f.authority.remove({ principalRef: f.ref(ownerId), projectId, conversationId: 'c1', requestId: '' }), { status: 400 });
    assert.ok(rows(f).c1);
  } finally { f.close(); }
});

/* ---------------------------------------------------------------- 有任务在跑：先停再删 */

test('RS18-chat 有任务在跑：先下「停止」围栏、等 Agent 确认停下，再删；已落地的修改不在这里动', async () => {
  const f = fixture();
  try {
    await f.send(ownerId, 'run-conv', 'r1');
    await f.send(memberId, 'run-conv', 'r2', '排在后面的消息');
    f.startRun('run-conv');
    assert.equal(rows(f)['run-conv'].currentRunId, 'run1');
    const result = await f.remove(ownerId, 'run-conv', 'del-1');
    assert.equal(result.removed, true);
    assert.equal(f.control.fenced.length, 1);
    assert.equal(f.control.fenced[0].kind, 'stop');
    assert.equal(f.control.fenced[0].runId, 'run1');
    assert.equal(f.control.fenced[0].conversationId, 'run-conv');
    assert.deepEqual(f.control.onFenceCalls, [{ projectId, conversationId: 'run-conv', runId: 'run1' }], '等的是这一轮的确认');
    assert.equal(rows(f)['run-conv'], undefined);
    // 排队中的别人的消息一并作废；删干净以后账本里查不到它的文字，墓碑不带任何文字
    const stone = f.ledger.read().conversationTombstonesV2[projectId]['run-conv'];
    assert.equal(JSON.stringify(stone).includes('排在后面的消息'), false);
    assert.equal(JSON.stringify(f.ledger.read()).includes('排在后面的消息'), false);
  } finally { f.close(); }
});

test('RS18-chat 停不下来就不删：围栏没确认、确认了但任务没真停，对话都留着并停在「正在删除」', async () => {
  const f = fixture();
  try {
    await f.send(ownerId, 'c1', 'r1');
    await f.send(memberId, 'c1', 'r2', '排队');
    f.startRun('c1');
    f.control.stopClears = false; // 任务进程还没关干净:围栏下了，currentRunId 还留着
    // ① Agent 一侧还没关干净:onFence 抛 503
    f.control.ackError = Object.assign(new Error('pending'), { status: 503, code: 'agent-fence-pending' });
    await assert.rejects(f.remove(ownerId, 'c1', 'del-a'), { status: 503, code: 'agent-fence-pending' });
    assert.ok(rows(f).c1, '没删');
    assert.equal(rows(f).c1.deletion.byAccountId, ownerId);
    assert.equal((await f.list(ownerId)).find(c => c.id === 'c1').deleting, true, '列表里标出「正在删除」');
    assert.equal(f.ledger.read().conversationTombstonesV2?.[projectId]?.c1, undefined);
    // 删到一半，不再收新消息、不再起新一轮
    await assert.rejects(f.send(memberId, 'c1', 'r3', '又来一条'), { status: 409, code: 'conversation-deleting' });
    assert.throws(() => f.ledger.transaction(state => claimNextInState(state, { projectId, conversationId: 'c1', runId: 'run2', expectedMessageId: 'x' })), { code: 'conversation-deleting' });
    await assert.rejects(f.authority.switchVisibility({ principalRef: f.ref(ownerId), projectId, conversationId: 'c1', visibility: 'private', requestId: 'sw' }), { code: 'conversation-deleting' });
    // 别人(创建者)此时可以接手办(不依赖起头的人回来)：同样要等任务停稳，所以也是 503 还在办，而不是被拒
    await assert.rejects(f.remove(creatorId, 'c1', 'del-creator'), { status: 503, code: 'agent-fence-pending' });
    // 无关的成员不行
    await assert.rejects(f.remove(memberId, 'c1', 'del-member'), { status: 403, code: 'delete-forbidden' });
    // ② 回了 ack:false
    f.control.ackError = null; f.control.ackMissing = true;
    await assert.rejects(f.remove(ownerId, 'c1', 'del-a'), { status: 503, code: 'agent-fence-pending' });
    assert.ok(rows(f).c1);
    // ③ ack 了，但任务其实没停(currentRunId 还在):不删
    f.control.ackMissing = false;
    await assert.rejects(f.remove(ownerId, 'c1', 'del-a'), { status: 503, code: 'agent-fence-pending' });
    assert.ok(rows(f).c1, '确认了但 currentRunId 还在，仍然不删');
    // ④ 停稳了：用同一个请求号重试，删成功
    f.ledger.transaction(state => { const c = state.conversationsV2[projectId].c1; c.currentRunId = null; });
    const done = await f.remove(ownerId, 'c1', 'del-a');
    assert.equal(done.removed, true);
    assert.equal(done.already, false);
    assert.equal(rows(f).c1, undefined);
  } finally { f.close(); }
});

test('RS18-chat 任务进程还活着(有未关的运行授权)时即使 Agent 回了 ack 也不删', async () => {
  const f = fixture();
  try {
    await f.send(ownerId, 'c1', 'r1');
    f.startRun('c1');
    f.control.stopClears = false;
    f.ledger.transaction(state => { state.runGrantsV2 = { g1: { runGrantId: 'g1', projectId, conversationId: 'c1', runId: 'run1', state: 'active' } }; });
    // Agent 回了 ack、currentRunId 也清了，但运行授权还活着:不删
    f.control.afterAck = () => f.ledger.transaction(state => { state.conversationsV2[projectId].c1.currentRunId = null; });
    await assert.rejects(f.remove(ownerId, 'c1', 'del-a'), { code: 'agent-fence-pending' });
    assert.ok(rows(f).c1);
    f.ledger.transaction(state => { state.runGrantsV2.g1.state = 'revoked'; });
    assert.equal((await f.remove(ownerId, 'c1', 'del-a')).removed, true);
  } finally { f.close(); }
});

test('RS18-chat 没有停任务的口子(未配置)时不进「正在删除」，什么都不动', async () => {
  const f = fixture();
  try {
    await f.send(ownerId, 'c1', 'r1');
    f.startRun('c1');
    const bare = createConversationAuthority({ ...f.options, onFence: null });
    await assert.rejects(bare.remove({ principalRef: f.ref(ownerId), projectId, conversationId: 'c1', requestId: 'x' }), { status: 503, code: 'agent-fence-unavailable' });
    assert.equal(rows(f).c1.deletion, undefined, '没有进入删除中状态');
    assert.equal(rows(f).c1.currentRunId, 'run1');
    // 没在跑的对话不需要停任务的口子，照样能删
    await f.send(ownerId, 'idle', 'r2');
    assert.equal((await bare.remove({ principalRef: f.ref(ownerId), projectId, conversationId: 'idle', requestId: 'y' })).removed, true);
  } finally { f.close(); }
});

/* ---------------------------------------------------------------- 重复删、并发删 */

test('RS18-chat 重复删：同一个请求重放得到同一个结果；换请求号再删：开对话的人和创建者得到「已删」，别人当作没有', async () => {
  const f = fixture();
  try {
    await f.send(ownerId, 'c1', 'r1');
    await f.send(memberId, 'c1', 'r2');
    const first = await f.remove(ownerId, 'c1', 'del-1');
    assert.equal(first.already, false);
    assert.deepEqual(await f.remove(ownerId, 'c1', 'del-1'), first, '同一个请求重放：原结果');
    assert.equal((await f.notices(memberId)).length, 1, '重放不重复发通知');
    const again = await f.remove(ownerId, 'c1', 'del-2');
    assert.equal(again.removed, true);
    assert.equal(again.already, true);
    assert.equal((await f.remove(creatorId, 'c1', 'del-3')).already, true);
    await assert.rejects(f.remove(bystanderId, 'c1', 'del-4'), { status: 404 });
    assert.equal((await f.notices(memberId)).length, 1, '怎么重复删，通知都只有一条');
    // 请求号只在一次删除、一个对话内有意义:同一个请求号用在另一个对话上是另一次删除，互不影响
    await f.send(ownerId, 'c2', 'r3');
    await f.send(ownerId, 'c3', 'r4');
    assert.equal((await f.remove(ownerId, 'c2', 'same-id')).already, false);
    assert.equal((await f.remove(ownerId, 'c3', 'same-id')).already, false);
  } finally { f.close(); }
});

test('RS18-chat 并发删：同一个人同时发两个删除、开对话的人与创建者同时删，只删一次、只通知一次', async () => {
  const f = fixture();
  try {
    await f.send(ownerId, 'c1', 'r1');
    await f.send(memberId, 'c1', 'r2');
    const same = await Promise.all([f.remove(ownerId, 'c1', 'a'), f.remove(ownerId, 'c1', 'b')]);
    assert.deepEqual(same.map(r => r.already).sort(), [false, true]);
    assert.equal((await f.notices(memberId)).length, 1);
    await f.send(ownerId, 'c2', 'r3');
    await f.send(memberId, 'c2', 'r4');
    const both = await Promise.allSettled([f.remove(ownerId, 'c2', 'x'), f.remove(creatorId, 'c2', 'y')]);
    assert.equal(both.filter(r => r.status === 'fulfilled' && r.value.already === false).length, 1, '只有一个真的删了');
    assert.equal(rows(f).c2, undefined);
    // 创建者那份是「已删」(同步完成，因为没有在跑的任务)
    assert.ok(both.every(r => r.status === 'fulfilled'));
    assert.equal((await f.notices(memberId)).length, 2, 'c1 一条 + c2 一条，没有重复');
  } finally { f.close(); }
});

/* ---------------------------------------------------------------- 通知 */

test('RS18-chat 通知给谁：创建者删别人的→开对话的人；共有对话→在里面发过消息的其他成员；删的人自己不通知；没发过消息的不通知', async () => {
  const f = fixture();
  try {
    await f.send(ownerId, 'sh', 'r1', '我开的');
    await f.send(memberId, 'sh', 'r2', '成员也说了');
    // bystander 能看见这个共有对话，但没发过消息
    assert.ok((await f.list(bystanderId)).some(c => c.id === 'sh'));
    await f.remove(creatorId, 'sh', 'd1');
    const toOwner = await f.notices(ownerId);
    const toMember = await f.notices(memberId);
    assert.equal(toOwner.length, 1);
    assert.deepEqual([toOwner[0].recipientRole, toOwner[0].deletedByRole, toOwner[0].deletedByAccountId, toOwner[0].deletedByName], ['owner', 'creator', creatorId, 'Creator']);
    assert.equal(toOwner[0].title, '我开的');
    assert.equal(toOwner[0].conversationId, 'sh');
    assert.deepEqual([toMember[0].recipientRole, toMember[0].deletedByRole], ['participant', 'creator']);
    assert.equal((await f.notices(creatorId)).length, 0, '删的人自己不通知');
    assert.equal((await f.notices(bystanderId)).length, 0, '没发过消息的成员不通知');
  } finally { f.close(); }
});

test('RS18-chat 开对话的人自己删共有对话：发过消息的其他成员收到；创建者没发过消息就不收', async () => {
  const f = fixture();
  try {
    await f.send(ownerId, 'sh', 'r1');
    await f.send(memberId, 'sh', 'r2');
    await f.send(memberId, 'sh', 'r3');
    await f.remove(ownerId, 'sh', 'd1');
    assert.equal((await f.notices(ownerId)).length, 0);
    const toMember = await f.notices(memberId);
    assert.equal(toMember.length, 1, '同一个人发多条消息只通知一次');
    assert.deepEqual([toMember[0].recipientRole, toMember[0].deletedByRole, toMember[0].deletedByName], ['participant', 'owner', 'Owner']);
    assert.equal((await f.notices(creatorId)).length, 0);
  } finally { f.close(); }
});

test('RS18-chat 私有对话：开对话的人自己删不通知任何人；创建者删别人的私有→只通知开对话的人，不通知切私有前发过言的成员', async () => {
  const f = fixture();
  try {
    await f.send(ownerId, 'p1', 'r1');
    await f.send(memberId, 'p1', 'r2', '切私有前我发过言');
    await f.authority.switchVisibility({ principalRef: f.ref(ownerId), projectId, conversationId: 'p1', visibility: 'private', requestId: 's1' });
    await f.remove(ownerId, 'p1', 'd1');
    for (const id of [ownerId, memberId, creatorId]) assert.equal((await f.notices(id)).length, 0);

    await f.send(ownerId, 'p2', 'r3');
    await f.send(memberId, 'p2', 'r4');
    await f.authority.switchVisibility({ principalRef: f.ref(ownerId), projectId, conversationId: 'p2', visibility: 'private', requestId: 's2' });
    await f.remove(creatorId, 'p2', 'd2');
    assert.equal((await f.notices(ownerId)).length, 1);
    assert.equal((await f.notices(memberId)).length, 0);
  } finally { f.close(); }
});

test('RS18-chat 不在线的人下次打开补弹一次：通知落在账本里，重开账本还在；弹完回执就不再给；回执只能回自己的', async () => {
  const f = fixture();
  try {
    await f.send(ownerId, 'sh', 'r1');
    await f.send(memberId, 'sh', 'r2');
    await f.remove(ownerId, 'sh', 'd1');
    f.ledger.close();
    const reopened = openAccountLedger({ file: f.file, authorityId: 'conversation-delete-test' });
    f.ledger = reopened;
    const again = createConversationAuthority({ ...f.options, ledger: reopened, accountAuthority: {
      authorizePrincipal: async ref => structuredClone(f.principals[ref.authorizationId]) } });
    const mine = await again.notices({ principalRef: f.ref(memberId), projectId });
    assert.equal(mine.length, 1);
    // 别人的回执回不掉我的通知
    await again.ackNotices({ principalRef: f.ref(bystanderId), projectId, noticeIds: [mine[0].noticeId] });
    assert.equal((await again.notices({ principalRef: f.ref(memberId), projectId })).length, 1);
    assert.deepEqual(await again.ackNotices({ principalRef: f.ref(memberId), projectId, noticeIds: [mine[0].noticeId] }), { acked: 1 });
    assert.equal((await again.notices({ principalRef: f.ref(memberId), projectId })).length, 0, '回执后不再给');
    assert.deepEqual(await again.ackNotices({ principalRef: f.ref(memberId), projectId, noticeIds: [mine[0].noticeId] }), { acked: 0 }, '重复回执无害');
    await assert.rejects(again.ackNotices({ principalRef: f.ref(memberId), projectId, noticeIds: 'x' }), { status: 400 });
    // 被移出项目的人拿不到通知
    f.ledger.transaction(state => { state.projects[projectId].bans[bystanderId] = { reason: 'kick' }; });
    await assert.rejects(again.notices({ principalRef: f.ref(bystanderId), projectId }), { status: 403 });
  } finally { f.close(); }
});

test('RS18-chat 通知数量封顶，超了丢最旧的', async () => {
  const f = fixture();
  try {
    assert.equal(MAX_PENDING_NOTICES, 50);
    for (let i = 0; i < MAX_PENDING_NOTICES + 3; i++) {
      const id = `n${i}`;
      await f.send(memberId, id, `rn${i}`);
      await f.remove(creatorId, id, `dn${i}`);
    }
    const pending = await f.notices(memberId);
    assert.equal(pending.length, MAX_PENDING_NOTICES);
    assert.equal(pending[0].conversationId, 'n3', '最旧的三条被丢了');
  } finally { f.close(); }
});

/* ---------------------------------------------------------------- 存档与清除 */

test('块五第 2 条 删干净：对话行、请求记录里的标题、运行授权与领取/已读/结束记录里的消息与选区快照、墓碑，删后整本账本里查不到这个对话的文字', async () => {
  const f = fixture();
  try {
    const SECRET = '绝密文字-4f7a';
    await f.send(ownerId, 'c1', 'r1', SECRET + '\n第二行');
    await f.send(ownerId, 'keep', 'r2', '别的对话的话不能被清');
    await f.authority.switchVisibility({ principalRef: f.ref(ownerId), projectId, conversationId: 'c1', visibility: 'private', requestId: 's1' });
    await f.authority.switchVisibility({ principalRef: f.ref(ownerId), projectId, conversationId: 'c1', visibility: 'shared', requestId: 's2' });
    await f.authority.rename({ principalRef: f.ref(ownerId), projectId, conversationId: 'c1', title: SECRET + '改名' });
    // 模拟一轮跑完留下的运行记录(和 run-authority 的 admit/read/finish 记的形状一致：整条消息、选区快照都在里面)
    f.ledger.transaction(state => {
      const message = state.conversationsV2[projectId].c1.messages[0];
      state.runGrantsV2 = { g1: { runGrantId: 'g1', projectId, conversationId: 'c1', runId: 'runX', messageId: message.messageId, state: 'finished',
        contentDigest: message.contentDigest, selectionSnapshot: structuredClone(message.selectionSnapshot), initiatorName: 'Owner' },
        gOther: { runGrantId: 'gOther', projectId, conversationId: 'keep', runId: 'runY', state: 'finished', selectionSnapshot: { pageId: 'KEEPME' } } };
      state.runRequestsV2 = { k1: { digest: 'd', result: { runGrantId: 'g1', projectId, conversationId: 'c1', message: structuredClone(message), selectionSnapshot: { pageId: SECRET } } } };
      state.runReadRequestsV2 = { k2: { digest: 'd', result: { projectId, conversationId: 'c1', prompt: SECRET, receiptId: 'rc' } } };
      state.runFinishRequestsV2 = { k3: { digest: 'd', result: { projectId, conversationId: 'c1', outcome: { status: 'done' }, text: SECRET } } };
    });
    assert.ok(JSON.stringify(f.ledger.read()).includes(SECRET), '删之前账本里确实有');
    await f.remove(ownerId, 'c1', 'del-clean');
    const dump = JSON.stringify(f.ledger.read());
    assert.equal(dump.includes(SECRET), false, '删后整本账本里查不到这个对话的文字');
    assert.equal(dump.includes('第二行'), false);
    // 逐处核对：对话行、墓碑、请求记录(发送/切换/改名的结果)、运行授权、领取/已读/结束的结果
    const s = f.ledger.read();
    assert.equal(s.conversationsV2[projectId].c1, undefined);
    assert.deepEqual(Object.keys(s.conversationTombstonesV2[projectId].c1).sort(),
      ['deletedAt', 'deletedByAccountId', 'id', 'notified', 'ownerAccountId', 'projectId', 'requestId', 'visibility']);
    assert.equal(s.runGrantsV2.g1.selectionSnapshot, undefined);
    assert.equal(s.runGrantsV2.g1.state, 'finished', '运行授权记录本身留着(结清与审计按号引用它)，只清文字');
    assert.equal(s.runRequestsV2.k1.result.message, undefined);
    assert.equal(s.runReadRequestsV2.k2.result.prompt, undefined);
    assert.equal(s.runFinishRequestsV2.k3.result.text, undefined);
    // 别的对话的东西不动
    assert.equal(s.conversationsV2[projectId].keep.messages[0].content, '别的对话的话不能被清');
    assert.deepEqual(s.runGrantsV2.gOther.selectionSnapshot, { pageId: 'KEEPME' });
    // 读不到、旧号发不进去
    await assert.rejects(f.authority.get({ principalRef: f.ref(ownerId), projectId, conversationId: 'c1' }), { status: 404, code: 'conversation-deleted' });
    await assert.rejects(f.send(ownerId, 'c1', 'again'), { code: 'conversation-deleted' });
  } finally { f.close(); }
});

test('块五第 2 条 还没弹的通知带着标题(气泡要靠它把话说清楚)，弹完回执就整条删掉，账本里不再有标题', async () => {
  const f = fixture();
  try {
    await f.send(ownerId, 'c1', 'r1', '标题-xyz');
    await f.send(memberId, 'c1', 'r2', '成员的话');
    await f.remove(ownerId, 'c1', 'd1');
    const [n] = await f.notices(memberId);
    assert.equal(n.title, '标题-xyz');
    await f.authority.ackNotices({ principalRef: f.ref(memberId), projectId, noticeIds: [n.noticeId] });
    const dump = JSON.stringify(f.ledger.read());
    assert.equal(dump.includes('标题-xyz'), false);
    assert.equal(dump.includes('成员的话'), false);
  } finally { f.close(); }
});

test('块五第 2 条 被删的号对看得到过它的人说「已删」，对看不到的人仍说「没有」', async () => {
  const f = fixture();
  try {
    await f.send(ownerId, 'sh', 'r1', 'x'); await f.send(ownerId, 'pv', 'r2', 'y');
    await f.authority.switchVisibility({ principalRef: f.ref(ownerId), projectId, conversationId: 'pv', visibility: 'private', requestId: 's' });
    await f.remove(ownerId, 'sh', 'd1'); await f.remove(ownerId, 'pv', 'd2');
    const get = (id, who) => f.authority.get({ principalRef: f.ref(who), projectId, conversationId: id });
    await assert.rejects(get('sh', memberId), { code: 'conversation-deleted' });
    await assert.rejects(get('pv', memberId), { code: 'no-conversation' });
    await assert.rejects(get('pv', ownerId), { code: 'conversation-deleted' });
    await assert.rejects(get('pv', creatorId), { code: 'conversation-deleted' });
  } finally { f.close(); }
});

test('块五第 4 条 只读成员不能删自己开的对话(也不能建)', async () => {
  const f = fixture();
  try {
    f.ledger.transaction(state => { state.conversationsV2 = { [projectId]: { mine: { v: 2, projectId, id: 'mine', ownerAccountId: readerId, visibility: 'shared',
      aclRevision: 1, queueRevision: 0, currentRunId: null, title: 't', createdAt: 1, updatedAt: 1, messages: [] } } }; });
    await assert.rejects(f.remove(readerId, 'mine'), { status: 403 });
    assert.ok(rows(f).mine, '没删掉');
    await assert.rejects(f.send(readerId, 'new', 'r'), { status: 403 });
    assert.equal((await f.remove(creatorId, 'mine')).removed, true, '创建者仍能清掉它');
  } finally { f.close(); }
});

test('块五第 5 条 移出成员时「同时清除他的私有对话」：只清他的私有对话，共有对话与别人的不动；只有创建者能做', async () => {
  const f = fixture();
  try {
    await f.send(memberId, 'm-pv1', 'r1', '私有一'); await f.send(memberId, 'm-pv2', 'r2', '私有二'); await f.send(memberId, 'm-sh', 'r3', '共有的');
    await f.send(ownerId, 'o-pv', 'r4', '别人的私有');
    for (const [id, who] of [['m-pv1', memberId], ['m-pv2', memberId], ['o-pv', ownerId]])
      await f.authority.switchVisibility({ principalRef: f.ref(who), projectId, conversationId: id, visibility: 'private', requestId: 'p-' + id });
    await assert.rejects(f.authority.removeMemberPrivate({ principalRef: f.ref(ownerId), projectId, accountId: memberId, requestId: 'x' }), { status: 403, code: 'creator-required' });
    f.ledger.transaction(state => { delete state.projects[projectId].members[memberId]; state.projects[projectId].bans[memberId] = { reason: 'kick' }; });
    assert.ok(rows(f)['m-pv1']);
    const done = await f.authority.removeMemberPrivate({ principalRef: f.ref(creatorId), projectId, accountId: memberId, requestId: 'clear-1' });
    assert.deepEqual(done, { accountId: memberId, projectId, removed: ['m-pv1', 'm-pv2'], pending: [] });
    assert.deepEqual(Object.keys(rows(f)).sort(), ['m-sh', 'o-pv'], '共有对话保留、别人的私有不动');
    assert.equal(JSON.stringify(f.ledger.read()).includes('私有一'), false);
    // 重放同一个请求：没有可清的了，不报错
    assert.deepEqual((await f.authority.removeMemberPrivate({ principalRef: f.ref(creatorId), projectId, accountId: memberId, requestId: 'clear-1' })).removed, []);
    await assert.rejects(f.authority.removeMemberPrivate({ principalRef: f.ref(creatorId), projectId, accountId: creatorId, requestId: 'c' }), { status: 400 });
  } finally { f.close(); }
});

test('块五第 5 条 清除成员私有对话时有任务在跑：先强制结束再清；停不下来的列在 pending，用同一个请求号再调接着办', async () => {
  const f = fixture();
  try {
    await f.send(memberId, 'm-pv', 'r1', '私有'); await f.authority.switchVisibility({ principalRef: f.ref(memberId), projectId, conversationId: 'm-pv', visibility: 'private', requestId: 'p' });
    f.startRun('m-pv'); f.control.stopClears = false;
    f.control.ackError = Object.assign(new Error('pending'), { status: 503, code: 'agent-fence-pending' });
    const first = await f.authority.removeMemberPrivate({ principalRef: f.ref(creatorId), projectId, accountId: memberId, requestId: 'clear-2' });
    assert.deepEqual([first.removed, first.pending], [[], ['m-pv']]);
    assert.equal(f.control.fenced.at(-1).kind, 'stop');
    f.control.ackError = null; f.ledger.transaction(state => { state.conversationsV2[projectId]['m-pv'].currentRunId = null; });
    const second = await f.authority.removeMemberPrivate({ principalRef: f.ref(creatorId), projectId, accountId: memberId, requestId: 'clear-2' });
    assert.deepEqual([second.removed, second.pending], [['m-pv'], []]);
  } finally { f.close(); }
});

/* ---------------------------------------------------------------- 2026-10-13 审查后追加 */

test('审查 2 开对话的人删到一半被踢，创建者勾「清除私有对话」不会被 409 挡住，这个对话能删完', async () => {
  const f = fixture();
  try {
    await f.send(memberId, 'm-pv', 'r1', '私有'); await f.authority.switchVisibility({ principalRef: f.ref(memberId), projectId, conversationId: 'm-pv', visibility: 'private', requestId: 'p' });
    f.startRun('m-pv'); f.control.stopClears = false;
    f.control.ackError = Object.assign(new Error('pending'), { status: 503, code: 'agent-fence-pending' });
    await assert.rejects(f.remove(memberId, 'm-pv', 'own-del'), { code: 'agent-fence-pending' });   // 成员自己起头删，停不下来
    assert.equal(rows(f)['m-pv'].deletion.byAccountId, memberId);
    f.ledger.transaction(state => { delete state.projects[projectId].members[memberId]; state.projects[projectId].bans[memberId] = { reason: 'kick' }; });
    f.control.ackError = null; f.ledger.transaction(state => { state.conversationsV2[projectId]['m-pv'].currentRunId = null; });
    const out = await f.authority.removeMemberPrivate({ principalRef: f.ref(creatorId), projectId, accountId: memberId, requestId: 'clear-takeover' });
    assert.deepEqual([out.removed, out.pending], [['m-pv'], []]);
  } finally { f.close(); }
});

test('审查 2 没有人再回来也会删完：任务一结清，文档服务自己收尾；围栏还没办完不收尾；收尾后给该通知的人通知，墓碑记起头的人', async () => {
  const f = fixture();
  try {
    await f.send(ownerId, 'c1', 'r1', '开对话'); await f.send(memberId, 'c1', 'r2', '成员发过言');
    f.startRun('c1'); f.control.stopClears = false;
    f.control.ackError = Object.assign(new Error('pending'), { status: 503, code: 'agent-fence-pending' });
    await assert.rejects(f.remove(creatorId, 'c1', 'del-a'), { code: 'agent-fence-pending' });      // 创建者起头，然后再也不回来
    assert.equal(f.authority.completePendingDeletions(), 0, '任务还在：不收尾');
    f.ledger.transaction(state => { state.conversationsV2[projectId].c1.currentRunId = null;
      state.runControlsV2 = { x: { controlId: 'x', requestId: 'delete:del-a', projectId, scope: { conversationId: 'c1' }, state: 'pending' } }; });
    assert.equal(f.authority.completePendingDeletions(), 0, '没有在跑的了，但停止围栏这条控制还没办完：不收尾');
    f.ledger.transaction(state => { state.runControlsV2.x.state = 'complete'; });
    assert.equal(f.authority.completePendingDeletions(), 1);
    assert.equal(rows(f).c1, undefined);
    const stone = f.ledger.read().conversationTombstonesV2[projectId].c1;
    assert.equal(stone.deletedByAccountId, creatorId);
    assert.equal((await f.notices(ownerId)).length, 1); assert.equal((await f.notices(memberId)).length, 1);
    assert.equal(f.authority.completePendingDeletions(), 0, '幂等');
    assert.equal((await f.remove(creatorId, 'c1', 'del-a')).removed, true, '之后任何人重放都得到已删');
  } finally { f.close(); }
});

test('审查 5 未弹的通知：不给已被移出的人存；移出后他名下已有的在下一次删除时清掉；超过 30 天的不再给、也清掉', async () => {
  const f = fixture(); let t = 1_000_000; f.setNow(t);
  try {
    await f.send(ownerId, 'a', 'r1', '标题甲'); await f.send(memberId, 'a', 'r2', '成员话');
    await f.remove(ownerId, 'a', 'd1');
    assert.equal((await f.notices(memberId)).length, 1);
    // 成员被移出：他之前没弹的通知，在下一次删除时被清掉；之后给他的通知根本不存
    f.ledger.transaction(state => { delete state.projects[projectId].members[memberId]; state.projects[projectId].bans[memberId] = { reason: 'kick' }; });
    await f.send(ownerId, 'b', 'r3', '标题乙'); await f.remove(creatorId, 'b', 'd2');
    assert.equal(f.ledger.read().conversationNoticesV2[projectId]?.[memberId], undefined, '被移出的人名下没有未弹通知');
    assert.equal(JSON.stringify(f.ledger.read()).includes('标题甲'), false);
    // 期限：30 天
    await f.send(bystanderId, 'c', 'r4', '标题丙'); await f.send(ownerId, 'c', 'r5', '说话'); await f.remove(creatorId, 'c', 'd3');
    assert.equal((await f.notices(bystanderId)).length, 1);
    t += NOTICE_TTL_MS + 1; f.setNow(t);
    assert.equal((await f.notices(bystanderId)).length, 0, '过期的不再给');
    await f.send(ownerId, 'd', 'r6', 'x'); await f.remove(ownerId, 'd', 'd4');   // 下一次写入顺带清
    assert.equal(JSON.stringify(f.ledger.read().conversationNoticesV2 ?? {}).includes('标题丙'), false);
  } finally { f.close(); }
});

test('审查 4 已删对话在 Agent 一侧是否清过：墓碑上没有回执就列出来，回执后不再列；回执不认没有的号', async () => {
  const f = fixture();
  try {
    await f.send(ownerId, 'c1', 'r1', 'x'); await f.send(ownerId, 'c2', 'r2', 'y');
    await f.remove(ownerId, 'c1', 'd1'); await f.remove(ownerId, 'c2', 'd2');
    assert.deepEqual(f.authority.listUnpurged().map(x => x.conversationId).sort(), ['c1', 'c2']);
    assert.deepEqual(f.authority.ackPurged({ projectId, conversationId: 'c1' }), { acked: true });
    assert.deepEqual(f.authority.listUnpurged().map(x => x.conversationId), ['c2']);
    assert.ok(f.authority.ackPurged({ projectId, conversationId: 'c1' }).acked, '重复回执无害');
    assert.throws(() => f.authority.ackPurged({ projectId, conversationId: 'nope' }), { status: 404 });
    assert.equal(JSON.stringify(f.authority.listUnpurged()).includes('x'), false);
  } finally { f.close(); }
});

test('审查 8 清文字只动确切匹配的记录：别的项目里同一个对话号、同项目别的对话都不动', async () => {
  const f = fixture();
  try {
    await f.send(ownerId, 'same', 'r1', '本项目的话'); await f.send(ownerId, 'same', 'o1', '别的项目的话', otherProjectId);
    f.ledger.transaction(state => {
      state.runGrantsV2 = { g1: { runGrantId: 'g1', projectId, conversationId: 'same', selectionSnapshot: { a: 1 } },
        gOtherProject: { runGrantId: 'gO', projectId: otherProjectId, conversationId: 'same', selectionSnapshot: { b: 2 } },
        gOtherConv: { runGrantId: 'gC', projectId, conversationId: 'different', selectionSnapshot: { c: 3 } } };
      // 对话号等于这个对话号、但不是对话的公开形状(没有 v:2 / ownerAccountId)的记录不动
      state.runRequestsV2 = { k: { digest: 'd', result: { projectId, id: 'same', message: { content: '不是对话形状' } } } };
    });
    await f.remove(ownerId, 'same', 'd1');
    const s = f.ledger.read();
    assert.equal(s.runGrantsV2.g1.selectionSnapshot, undefined);
    assert.deepEqual(s.runGrantsV2.gOtherProject.selectionSnapshot, { b: 2 });
    assert.deepEqual(s.runGrantsV2.gOtherConv.selectionSnapshot, { c: 3 });
    assert.equal(s.runRequestsV2.k.result.message.content, '不是对话形状');
    assert.equal(s.conversationsV2[otherProjectId].same.messages[0].content, '别的项目的话');
  } finally { f.close(); }
});
