/**
 * 改密退出的逐项撤回:执行器经真的有序提交、真的账号服务(VisuHive 的 password-order)、真的操作历史和项目模块落地。
 * 需要 PROMPTCUT_ACCOUNT_PROVIDER_ROOT / PROMPTCUT_PASSWORD_ORDER_MODULE 指向带撤回证明的账号后端。
 *
 * RB-01 区间与逐项:改密前的、别人的、新登录的不碰;区间里旧登录的撤、被别人接着改过的留;
 *       在线成员各收一条气泡「〈用户名〉撤回了内容」,之后才连上的不补;不写任何人的待合并表、不弹窗口(安全论证 1、2、4、5)
 * RB-02 幂等与重启:定序的请求丢了 → 下一轮把那次作废、换号重算;账号服务办了但回应丢了 → 认出已落地的同一次;
 *       进程重启后不再落第二次、不补发气泡;报给账号服务只报一次(安全论证 6)
 * RB-03 不是「改密后选退出」的事件、或写入身份对不上的,有序提交拒绝(补偿操作不能被借去改别的)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { operationFixture } from './operation-wiring-fixture.mjs';
import { ask } from './fake-docservice-env.mjs';
import { createLogoutRollback, rollbackThrough } from '../account/logout-rollback.mjs';

const actual = { skip: !process.env.PROMPTCUT_ACCOUNT_PROVIDER_ROOT && 'Explicit actual account provider required' };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pc-logout-rollback-'));
const open = (c, projectId) => ask(c, { type: 'project.open', projectId }, 10000);
const submit = (c, projectId, opId, ops) => ask(c, { type: 'project.op', projectId, opId, ops }, 10000);

/** 一次「改密 → 区间里各方改 → 选退出」;回事件号与各连接 */
async function scenario(f) {
  await f.authority.joinProject({ accessToken: f.sessions.c.accessToken }, { projectId: f.projectId, requestId: 'join-other' });
  const a = await f.connect('a'), c = await f.connect('c');
  await open(a, f.projectId); await open(c, f.projectId);
  // 改密之前旧登录做的:不撤
  assert.equal((await submit(a, f.projectId, 'pre', [{ op: 'set', path: '/title', value: 'pre' }])).type, 'project.op.ok');
  const event = f.account.change();
  // 区间里:旧登录 a 改了三处
  assert.equal((await submit(a, f.projectId, 'w1', [{ op: 'set', path: '/clips/@stable/value', value: 2 }, { op: 'set', path: '/extra', value: 'a-window' }])).type, 'project.op.ok');
  assert.equal((await submit(a, f.projectId, 'w2', [{ op: 'insert', path: '/clips', index: 1, value: { id: 'n1', value: 9 } }])).type, 'project.op.ok');
  // 别人在它基础上又改了 stable.value:这一项冲突,保留
  assert.equal((await submit(c, f.projectId, 'other', [{ op: 'set', path: '/clips/@stable/value', value: 3 }])).type, 'project.op.ok');
  // 同一账号改密之后的新登录:是合法修改,不碰
  f.sessions.d = f.account.credentials.createEditor({ account: f.account.store.accountById(f.account.credentials.verify(f.sessions.a.accessToken).accountId),
    deviceId: 'fixture-d', requestId: 'fixture-login-d' });
  const d = await f.connect('d'); await open(d, f.projectId);
  assert.equal((await submit(d, f.projectId, 'new-login', [{ op: 'set', path: '/note', value: 'new-login' }])).type, 'project.op.ok');
  f.account.choose(event, true);
  await f.authority.synchronize();
  return { eventId: event.event_id, a, c, d };
}
/** 退出确认里文档服务那份证据的「位置」(0.7.18 记下的旧登录在各项目最后一条被接受的操作的顺序号) */
function proofOf(f, loginIds) {
  const mine = f.history.accepted(f.projectId).filter(op => loginIds.includes(op.actor.loginId));
  return { projectCursors: [{ projectId: f.projectId, projectRev: f.history.snapshot(f.projectId).projectRev, lastAcceptedOrderSeq: Math.max(0, ...mine.map(op => op.witness.orderSeq)) }] };
}
function executor(f, reports, extra = {}) {
  return createLogoutRollback({ ledger: f.ledger, ...extra,
    operations: () => ({ rollbackProject: input => rollbackThrough({ history: f.history, coordinator: f.coordinator }, input) }),
    report: async (eventId, body) => { reports.push({ eventId, ...body }); return { recorded: true }; },
    onDiagnostic: event => { if (process.env.RB_DEBUG) console.log("diag", JSON.stringify(event)); } });
}

test('RB-01 区间与逐项:只撤区间里旧登录的、冲突的保留;在线成员收到气泡,不在线的不补;不进待合并表', actual, async t => {
  const f = await operationFixture({ dir: tmp() }); t.after(() => f.close());
  const { eventId, c, d } = await scenario(f);
  const barrier = f.ledger.read().barriers[`event:${eventId}`];
  assert.ok(barrier.loginIds.length >= 2, '旧登录一组');
  const reports = [], rollback = executor(f, reports);
  const out = await rollback.run(barrier, proofOf(f, barrier.loginIds));
  assert.equal(out.done, true);
  const value = f.history.snapshot(f.projectId).value;
  assert.equal(value.title, 'pre', '改密之前旧登录改的不撤');
  assert.equal(value.clips.find(x => x.id === 'stable').value, 3, '别人接着改过的保留现状');
  assert.equal(value.extra, undefined, '区间里旧登录新加的属性撤掉');
  assert.equal(value.clips.some(x => x.id === 'n1'), false, '区间里旧登录新加的元素撤掉');
  assert.equal(value.note, 'new-login', '同一账号新登录的修改不碰');
  assert.deepEqual(reports.map(r => [r.reverted, r.kept, r.projects]), [[2, 1, 1]]);
  // 补偿操作:有序提交里的一步,写入身份是账号 + 事件号,不借任何登录
  const last = f.history.accepted(f.projectId).at(-1);
  assert.deepEqual([last.actor.accountId, last.actor.rollbackEventId, last.actor.loginId],
    [f.account.credentials.verify(f.sessions.d.accessToken).accountId, eventId, undefined]);
  assert.equal(last.witness.authorization.kind, 'logout-rollback');
  // 在线成员:各收一条气泡,名字是改密那个账号;项目内容随 project.ops 到达
  for (const page of [c, d]) {
    const notice = await page.next(m => m.type === 'shared.notice' && m.event === 'content-rolled-back', 5000);
    assert.equal(notice.projectId, f.projectId);
    assert.equal(notice.name, f.ledger.read().projects[f.projectId].members[last.actor.accountId].accountNameAtJoin);
    const ops = await page.next(m => m.type === 'project.ops' && m.opId.startsWith('logout-rollback:'), 5000);
    // 发给页面的写入身份与操作号里不带事件号(安全专审 Q5/SEC-01:事件号是占号的凭据),只标明是撤回
    assert.equal(ops.actor.rollback, true); assert.equal(ops.actor.rollbackEventId, undefined);
    assert.equal(ops.opId.includes(eventId), false);
    assert.equal(page.all.filter(m => m.type === 'shared.notice' && m.event === 'content-rolled-back').length, 1, '只一条');
    assert.equal(page.all.some(m => String(m.type).startsWith('merge.')), false, '改密退出触发的撤回不进待合并表、不弹窗口');
  }
  // 之后才连上的:不补弹
  const later = await f.connect('c'); await open(later, f.projectId);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(later.all.some(m => m.type === 'shared.notice'), false, '不在线的不补弹');
  const row = rollback.status(eventId);
  assert.equal(row.state, 'done'); assert.equal(row.projects[f.projectId].notice, 'sent'); assert.equal(row.reported, true);
});

test('RB-02 幂等与重启:定序请求丢了换号重算;回应丢了认出同一次;重启后不落第二次、不补气泡、只报一次', actual, async t => {
  const dir = tmp(); let lose = null;
  let f = await operationFixture({ dir, request: async (args, invoke) => {
    if (lose === 'request' && args.path.endsWith('/seal') && args.body?.rollbackProof) { lose = null; throw Object.assign(new Error('lost'), { code: 'order-outcome-unknown', status: 503 }); }
    const result = await invoke(args);
    if (lose === 'response' && args.path.endsWith('/seal') && args.body?.rollbackProof) { lose = null; throw Object.assign(new Error('lost'), { code: 'order-outcome-unknown', status: 503 }); }
    return result;
  } });
  t.after(() => f.close());
  const { eventId } = await scenario(f);
  const barrier = f.ledger.read().barriers[`event:${eventId}`], proof = proofOf(f, barrier.loginIds);
  const reports = [];
  // 一、定序的请求没送到:这一轮没办完;下一轮把那次作废(没定序),第二次换号重算、落地
  lose = 'request';
  let rollback = executor(f, reports);
  assert.equal((await rollback.run(barrier, proof)).done, false);
  let second = await rollback.run(barrier, proof);
  if (!second.done) second = await rollback.run(barrier, proof);
  assert.equal(second.done, true);
  const ops = f.history.accepted(f.projectId).filter(op => op.opId.startsWith(`logout-rollback:${eventId}`));
  assert.deepEqual(ops.map(op => op.opId), [`logout-rollback:${eventId}:2`], '只落了一次,是第二个号');
  assert.equal(f.history.get(f.projectId, `logout-rollback:${eventId}:1`).state, 'cancelled', '第一次没定序就作废了');
  assert.equal(rollback.status(eventId).projects[f.projectId].lastOpId, `logout-rollback:${eventId}:2`);
  // 二、办完以后再跑:不落第二次、不再报
  const rev = f.history.snapshot(f.projectId).projectRev;
  for (let i = 0; i < 3; i++) assert.equal((await rollback.run(barrier, proof)).done, true);
  assert.equal(f.history.snapshot(f.projectId).projectRev, rev);
  assert.equal(reports.length, 1, '报给账号服务只报一次');
  // 三、重启(同一个数据目录,另起一套):账本说办完了,什么都不做
  await f.close();
  f = await operationFixture({ dir });
  rollback = executor(f, reports);
  assert.equal((await rollback.run(barrier, proof)).done, true);
  assert.equal(f.history.snapshot(f.projectId).projectRev, rev); assert.equal(reports.length, 1);
});

test('RB-02b 账号服务办了但回应丢了、进程随即重启:重启后认出已落地的同一次,不落第二次、不补发气泡', actual, async t => {
  const dir = tmp(); let lose = null;
  let f = await operationFixture({ dir, request: async (args, invoke) => {
    const result = await invoke(args);
    if (lose && args.path.endsWith('/seal') && args.body?.rollbackProof) { lose = null; throw Object.assign(new Error('lost'), { code: 'order-outcome-unknown', status: 503 }); }
    return result;
  } });
  t.after(() => f.close());
  const { eventId } = await scenario(f);
  const barrier = f.ledger.read().barriers[`event:${eventId}`], proof = proofOf(f, barrier.loginIds), reports = [];
  lose = 'response';
  assert.equal((await executor(f, reports).run(barrier, proof)).done, false, '回应丢了:这一轮不算办完');
  await f.close();
  f = await operationFixture({ dir });
  const c = await f.connect('c'); await open(c, f.projectId);
  const rollback = executor(f, reports);
  assert.equal((await rollback.run(barrier, proof)).done, true);
  const ops = f.history.accepted(f.projectId).filter(op => op.opId.startsWith(`logout-rollback:${eventId}`));
  assert.deepEqual(ops.map(op => op.opId), [`logout-rollback:${eventId}:1`], '账号服务那边已定序的那一次在恢复时落地;没有第二次');
  assert.equal(rollback.status(eventId).projects[f.projectId].notice, 'not-resent');
  await new Promise(r => setTimeout(r, 300));
  assert.equal(c.all.some(m => m.type === 'shared.notice'), false, '重启后不补发气泡');
  assert.deepEqual(reports.map(r => [r.reverted, r.kept]), [[2, 1]]);
});

test('RB-03 不是改密后选退出的事件、或写入身份对不上:有序提交拒绝补偿操作', actual, async t => {
  const f = await operationFixture({ dir: tmp() }); t.after(() => f.close());
  const accountId = f.account.credentials.verify(f.sessions.a.accessToken).accountId;
  const plan = () => ({ ops: [{ op: 'set', path: '/title', value: 'forged' }], reverted: [{ path: '/title' }], kept: [] });
  const a = await f.connect('a'); await open(a, f.projectId);
  assert.equal((await submit(a, f.projectId, 'init', [{ op: 'set', path: '/title', value: 'before' }])).type, 'project.op.ok');
  // 没有这个事件(或只是改了密、选了「不退出」)
  await assert.rejects(f.coordinator.rollback({ projectId: f.projectId, eventId: 'pw_unknown', accountId, attempt: 1, plan }), { code: 'operation-forbidden' });
  const kept = f.account.change('retain-change'); f.account.choose(kept, false); await f.authority.synchronize();
  await assert.rejects(f.coordinator.rollback({ projectId: f.projectId, eventId: kept.event_id, accountId, attempt: 1, plan }), { code: 'operation-forbidden' });
  // 事件是真的,但拿别的账号号去撤
  const event = f.account.change('exit-change'); f.account.choose(event, true); await f.authority.synchronize();
  await assert.rejects(f.coordinator.rollback({ projectId: f.projectId, eventId: event.event_id, accountId: `acc_${'9'.repeat(24)}`, attempt: 1, plan }), { code: 'operation-forbidden' });
  assert.equal(f.history.snapshot(f.projectId).value.title, 'before');
});

test('RB-04 补偿操作号的前缀留给文档服务:页面提交用它一律拒(安全专审 SEC-01),撤回照常办完', actual, async t => {
  const f = await operationFixture({ dir: tmp() }); t.after(() => f.close());
  const { eventId, c } = await scenario(f);
  for (const opId of [`logout-rollback:${eventId}:1`, `logout-rollback:${eventId}:2`, 'logout-rollback:anything']) {
    const reply = await submit(c, f.projectId, opId, [{ op: 'set', path: '/note', value: 'taken' }]);
    assert.equal(reply.type, 'project.op.rejected'); assert.equal(reply.reason, 'reserved-op-id');
  }
  const barrier = f.ledger.read().barriers[`event:${eventId}`];
  const out = await executor(f, []).run(barrier, proofOf(f, barrier.loginIds));
  assert.equal(out.done, true);
  assert.equal(f.history.snapshot(f.projectId).value.extra, undefined);
});

test('RB-05 要撤的很多:分批落地、批与批之间让出事件循环;总数对、气泡只一条;超过上限的记进保留和账本(安全专审 SEC-03)', actual, async t => {
  const f = await operationFixture({ dir: tmp() }); t.after(() => f.close());
  await f.authority.joinProject({ accessToken: f.sessions.c.accessToken }, { projectId: f.projectId, requestId: 'join-other' });
  const a = await f.connect('a'), c = await f.connect('c');
  await open(a, f.projectId); await open(c, f.projectId);
  const event = f.account.change();
  for (let part = 0; part < 5; part++) {
    const ops = Array.from({ length: 100 }, (_, i) => ({ op: 'set', path: `/bag${part}x${i}`, value: i }));
    assert.equal((await submit(a, f.projectId, `bulk${part}`, ops)).type, 'project.op.ok');
  }
  f.account.choose(event, true); await f.authority.synchronize();
  const barrier = f.ledger.read().barriers[`event:${event.event_id}`];
  let ticks = 0; const beat = setInterval(() => { ticks++; }, 0);
  const rollback = executor(f, [], { batchItems: 120, itemLimit: 450 });
  const out = await rollback.run(barrier, proofOf(f, barrier.loginIds));
  clearInterval(beat);
  assert.equal(out.done, true);
  const parts = f.history.accepted(f.projectId).filter(op => op.actor.rollbackEventId === event.event_id);
  assert.equal(parts.length, 4, '450 项按 120 一批:4 批');
  const row = rollback.status(event.event_id).projects[f.projectId];
  assert.deepEqual([row.reverted, row.kept, row.overLimit, row.parts], [450, 50, 50, 4], '超过上限的 50 项记进保留与账本,不悄悄丢');
  assert.equal(rollback.status(event.event_id).totals.overLimit, 50);
  assert.ok(ticks > 0, '批与批之间让出了事件循环');
  const value = f.history.snapshot(f.projectId).value;
  assert.equal(Object.keys(value).filter(k => k.startsWith('bag')).length, 50, '没撤的正好是超过上限的那 50 项');
  await new Promise(r => setTimeout(r, 200));
  assert.equal(c.all.filter(m => m.type === 'shared.notice' && m.event === 'content-rolled-back').length, 1, '分批撤也只一条气泡');
});
