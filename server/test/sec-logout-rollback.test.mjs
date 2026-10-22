/**
 * 对抗性安全专审(claude/sec-logout-rollback)对改密退出撤回(0.7.20,claude/logout-rollback)的反例。
 * 每一条断言写的是「应当如此」;在被审的实现上它们是红的,红的原因就是报告 `docs/reports/AGENT-claude-sec-logout-rollback.md` 里那一条。
 *
 * SEC-01 补偿操作号与页面提交共用一个命名空间:项目里任一成员先用 `logout-rollback:<事件号>:<第几次>` 交一笔页面提交,
 *        执行器每一轮都撞 operation-id-mismatch、不换号,这次退出一直办不完(需要真的账号后端,同 RB-01)
 * SEC-02 普通字符串数组(例如卡片参数里的词表)和原本为空的普通数组:区间里旧登录改的,既不撤、也不算「保留」(悄悄漏掉)
 * SEC-03 planRollback 的耗时随区间里的修改项数平方增长(同步执行,占住文档服务的主线程)
 * SEC-04 退出确认续办器一遍里逐个等撤回:一个事件的撤回卡住或很慢,别的账号的退出也跟着办不完
 * SEC-05 账本里记的撤回 / 保留路径不限长度:路径里的键是项目内容里的键,能把整本账本撑大
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyOps } from '../docservice/json-ops.mjs';
import { recordChanges } from '../docservice/modules/operation-history.mjs';
import { planRollback, candidateOf, createLogoutRollback, rollbackThrough } from '../account/logout-rollback.mjs';
import { createLogoutConfirmer } from '../account/logout-confirmer.mjs';

const OLD = { accountId: 'acc_a', loginId: 'login-old' };

/** 与 logout-rollback-plan.test.mjs 同一造法:照文档服务的操作历史造一串被接受的操作 */
function history(initial, steps) {
  let value = structuredClone(initial); const versions = {}; const accepted = [];
  steps.forEach(([actor, orderSeq, ops], i) => {
    const after = applyOps(value, ops).root;
    const changes = recordChanges(value, after, { ops, versions, nextVersion: `${i + 2}:op${i}` });
    for (const c of changes) versions[c.itemKey] = c.afterVersion;
    accepted.push({ opId: `op${i}`, projectId: 'p1', projectRev: i + 2, state: 'materialized', actor, changes, witness: { orderSeq } });
    value = after;
  });
  return { accepted, current: { value, versions } };
}
const inWindow = () => candidateOf({ projectId: 'p1', loginIds: ['login-old'], changeSeq: 10, endSeq: 1_000_000 });

test('SEC-02 普通字符串数组、原本为空的普通数组:区间里旧登录改的要么撤回、要么记成保留,不能悄悄漏掉', () => {
  const C1 = '/tracks/@t1/clips/@c1';
  const h = history({ tracks: [{ id: 't1', clips: [{ id: 'c1', params: { words: ['开场', '欢迎'], lines: [] } }] }] }, [
    // 旧登录在区间里改了词表里的一个词(没换顺序),又往原本为空的字幕行里加了一行
    [OLD, 11, [{ op: 'set', path: `${C1}/params/words`, value: ['开场', '已被改动'] }]],
    [OLD, 12, [{ op: 'set', path: `${C1}/params/lines`, value: [{ start: 0, end: 1, text: '已被改动' }] }]],
  ]);
  const out = planRollback({ accepted: h.accepted, current: h.current, isCandidate: inWindow() });
  const accounted = [...out.reverted.map((r) => r.path), ...out.kept.map((k) => k.path)];
  assert.ok(accounted.includes(`${C1}/params/words`),
    `词表的修改既没撤也没记保留:reverted=${JSON.stringify(out.reverted)} kept=${JSON.stringify(out.kept)}`);
  assert.ok(accounted.includes(`${C1}/params/lines`),
    `原本为空的数组的修改既没撤也没记保留:reverted=${JSON.stringify(out.reverted)} kept=${JSON.stringify(out.kept)}`);
});

/** 区间里旧登录在一个对象下新加 k 个键(每笔 500 个),量 planRollback 的耗时 */
function timedPlan(k) {
  const steps = []; let n = 0, seq = 11;
  while (n < k) {
    const ops = [];
    for (let j = 0; j < 500 && n < k; j++, n++) ops.push({ op: 'set', path: `/bag/k${n}`, value: n });
    steps.push([OLD, seq++, ops]);
  }
  const h = history({ name: 'x', bag: { seed: 0 } }, steps);
  const t0 = performance.now();
  const out = planRollback({ accepted: h.accepted, current: h.current, isCandidate: inWindow() });
  const ms = performance.now() - t0;
  assert.equal(out.reverted.length, k);
  return ms;
}

test('SEC-03 planRollback 的耗时应当随区间里的修改项数大致线性增长(这里量 2000 与 16000 项)', () => {
  timedPlan(2000); // 预热
  const small = timedPlan(2000), large = timedPlan(16000);
  // 规模 8 倍:线性约 8 倍,平方约 64 倍。阈值取 16,机器快慢不影响判断。这一条检查的是增长阶,不是耗时闸门。
  assert.ok(large / small < 16, `2000 项 ${Math.round(small)} ms,16000 项 ${Math.round(large)} ms,倍数 ${(large / small).toFixed(1)}:按平方增长,且全程同步占住主线程(整个 Node 事件循环冻住)`);
});

/** 一本只在内存里的账本,够撤回执行器与续办器用 */
function memoryLedger(state) {
  return { read: () => state, transaction: (fn) => { const out = fn(state); return out === undefined ? undefined : structuredClone(out); } };
}
function rollbackState(eventId, loginId = 'login-old') {
  return {
    accountEvents: {
      1: { event: { type: 'password-changed', eventId, accountId: 'acc_a', changeSeq: 10 } },
      2: { event: { type: 'credentials-revoked', eventId, accountId: 'acc_a', changeSeq: 10 } },
    },
    barriers: { [`event:${eventId}`]: { eventId, loginIds: [loginId], accessEventId: `access-${eventId}`, accountEventSeq: 2, accessSeq: 1, state: 'pending' } },
    revokedLogins: { [`login:${loginId}`]: { eventId } },
    projects: {}, runControlsV2: {}, runGrantsV2: {},
  };
}

test('SEC-05 账本里每个项目记下的撤回 / 保留路径应当有长度上限(路径里的键来自项目内容)', async () => {
  // 旧登录在区间里新加了 50 个键很长的属性(键长 20 000 个字符;一笔页面提交能带到 256 KiB)
  const long = (i) => `${String(i).padStart(4, '0')}${'k'.repeat(20_000)}`;
  const h = history({ bag: {} }, Array.from({ length: 50 }, (_, i) => [OLD, 11 + i, [{ op: 'set', path: `/bag/${long(i)}`, value: i }]]));
  const state = rollbackState('pw_long');
  const rollback = createLogoutRollback({ ledger: memoryLedger(state), now: () => 1,
    operations: () => ({ async rollbackProject({ candidate }) {
      const out = planRollback({ accepted: h.accepted, current: h.current, isCandidate: candidateOf(candidate) });
      return { state: 'done', opId: 'logout-rollback:pw_long:1', reverted: out.reverted, kept: out.kept, notified: false };
    } }) });
  const out = await rollback.run(state.barriers['event:pw_long'], { projectCursors: [{ projectId: 'p1', projectRev: 60, lastAcceptedOrderSeq: 60 }] });
  assert.equal(out.done, true);
  const bytes = Buffer.byteLength(JSON.stringify(state.logoutRollbacksV1.pw_long));
  assert.ok(bytes <= 64 * 1024, `一次退出、一个项目就在账本里留了 ${bytes} 字节(账本每次落盘整段重写)`);
});

test('SEC-04 一个事件的撤回卡住时,别的事件照样能登记结束见证', async () => {
  const state = { barriers: {}, docLogoutBarriersV1: {}, accessEvents: [] };
  for (const eventId of ['pw_stuck', 'pw_other']) {
    state.barriers[`event:${eventId}`] = { eventId, loginIds: [`login-${eventId}`], accessEventId: `access-${eventId}`, accountEventSeq: 1, accessSeq: 1, state: 'pending' };
    state.docLogoutBarriersV1[eventId] = { proof: { projectCursors: [], connections: [] } };
  }
  const sealed = [];
  const confirmer = createLogoutConfirmer({ ledger: memoryLedger(state), pollMs: 0,
    authority: {
      async flushAccountAcknowledgements() {},
      revocationStatus: (eventId) => ({ ...state.barriers[`event:${eventId}`], pendingServices: [], serviceAcks: {} }),
      ackAccessEvent() {},
      completeLogoutBarrier(eventId) { state.barriers[`event:${eventId}`].state = 'complete'; sealed.push(eventId); },
      recordLogoutTimeout: () => ({ timeout: null }),
    },
    transportEvidence: () => null,
    operations: () => ({ sealLogout: async () => ({ witness: { kind: 'logout-complete' } }) }),
    // pw_stuck 的撤回一直办不完(例如要撤的修改项很多、项目锁一直被占);pw_other 的撤回立刻办完
    rollback: { run: (barrier) => barrier.eventId === 'pw_stuck' ? new Promise(() => {}) : Promise.resolve({ done: true }) } });
  void confirmer.tick();
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(sealed.includes('pw_other'), `别的账号的退出被 pw_stuck 的撤回挡住了:sealed=${JSON.stringify(sealed)}`);
});

// ---------------------------------------------------------------- 需要真的账号后端(同 RB-01)

const actual = { skip: !process.env.PROMPTCUT_ACCOUNT_PROVIDER_ROOT && 'Explicit actual account provider required' };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pc-sec-logout-rollback-'));

test('SEC-01 页面提交占用了补偿操作号:应当被拒,或者撤回仍能办完;不能让这次退出一直办不完', actual, async (t) => {
  const { operationFixture } = await import('./operation-wiring-fixture.mjs');
  const { ask } = await import('./fake-docservice-env.mjs');
  const open = (c, projectId) => ask(c, { type: 'project.open', projectId }, 10000);
  const submit = (c, projectId, opId, ops) => ask(c, { type: 'project.op', projectId, opId, ops }, 10000);
  const f = await operationFixture({ dir: tmp() }); t.after(() => f.close());
  await f.authority.joinProject({ accessToken: f.sessions.c.accessToken }, { projectId: f.projectId, requestId: 'join-other' });
  const a = await f.connect('a'), c = await f.connect('c');
  await open(a, f.projectId); await open(c, f.projectId);
  const event = f.account.change();
  // 区间里旧登录 a 改了一处
  assert.equal((await submit(a, f.projectId, 'w1', [{ op: 'set', path: '/extra', value: 'a-window' }])).type, 'project.op.ok');
  // 另一位成员 c 用补偿操作的号交了一笔普通提交(这里直接用测试手里的事件号;实际怎么拿到见报告 SEC-01)
  const taken = await submit(c, f.projectId, `logout-rollback:${event.event_id}:1`, [{ op: 'set', path: '/note', value: 'c' }]);
  f.account.choose(event, true); await f.authority.synchronize();
  const barrier = f.ledger.read().barriers[`event:${event.event_id}`];
  const mine = f.history.accepted(f.projectId).filter((op) => barrier.loginIds.includes(op.actor.loginId));
  const proof = { projectCursors: [{ projectId: f.projectId, projectRev: f.history.snapshot(f.projectId).projectRev,
    lastAcceptedOrderSeq: Math.max(0, ...mine.map((op) => op.witness.orderSeq)) }] };
  const diagnostics = [];
  const rollback = createLogoutRollback({ ledger: f.ledger,
    operations: () => ({ rollbackProject: (input) => rollbackThrough({ history: f.history, coordinator: f.coordinator }, input) }),
    report: async () => ({ recorded: true }), onDiagnostic: (d) => diagnostics.push(d.code) });
  let done = false;
  for (let i = 0; i < 4 && !done; i++) done = (await rollback.run(barrier, proof)).done;
  const row = rollback.status(event.event_id);
  assert.ok(taken.type === 'project.op.rejected' || taken.type === 'error' || done,
    `页面提交(${taken.type})占住了补偿操作号;执行器跑了 4 轮仍未办完(第 ${row?.projects?.[f.projectId]?.attempt ?? 1} 次、诊断 ${[...new Set(diagnostics)].join(',')});` +
    `续办器因此一直不登记结束见证,区间里旧登录写的 /extra=${JSON.stringify(f.history.snapshot(f.projectId).value.extra)} 也没撤`);
});
