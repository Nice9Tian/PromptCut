import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountSlotScheduler } from '../agent-service/account-slot-scheduler.mjs';

// 只验调度自己的次序：root 和文档服务都换成一张可摆布的表。它们真的那一半在 account-worker-lifecycle.test.mjs。
const latch = () => { let open; const promise = new Promise(resolve => { open = resolve; }); return { promise, open }; };
const settle = () => new Promise(resolve => setImmediate(resolve));
async function quiet(rounds = 8) { for (let i = 0; i < rounds; i++) await settle(); }

function world({ slotIds = ['slot-a'], current = () => null } = {}) {
  const calls = [], pending = { conversations: [], scopeControls: [] }, controls = new Map();
  const slots = slotIds.map(slotId => {
    let epoch = 0; const slot = { slotId, worker: null, faults: {}, gates: {} };
    const ref = () => ({ rootAuthorityId: `root-${slotId}`, slotId, epoch, recordDigest: String(epoch).repeat(64).slice(0, 64).padEnd(64, 'a') });
    const step = async (name, ...args) => {
      calls.push(`${slotId}:${name}:${epoch}`);
      if (slot.gates[name]) await slot.gates[name].promise;
      if (slot.faults[name]) throw Object.assign(Error(slot.faults[name]), { code: slot.faults[name] });
      return slot.on?.[name]?.(...args);
    };
    Object.assign(slot, { ref,
      current: async () => current(slotId),
      async open() {
        epoch += 1; await step('open');
        const settlement = latch(), exited = latch(); let alive = true;
        slot.worker = { settlement, exited, prepared: { assignment: { epoch }, phase: 'assigned-unbound', executionAllowed: false },
          die() { alive = false; exited.open({ exitCode: 3 }); } };
        return { rootScopeRef: ref(), worker: {
          prepare: async task => { calls.push(`${slotId}:prepare:${epoch}:${task.conversationId}:${task.requestId}`);
            if (slot.worker.prepareError) throw slot.worker.prepareError; return slot.worker.prepared; },
          start: async () => { calls.push(`${slotId}:start:${epoch}`); if (slot.worker.startError) throw slot.worker.startError; },
          settlement: settlement.promise, exited: exited.promise, alive: () => alive,
          stop: async () => { calls.push(`${slotId}:worker-stop:${epoch}`); slot.worker.die(); } } };
      },
      bind: assignment => step('bind', assignment),
      async close(input) { await step('close', input); slot.worker.die(); },
      async forcedClose(input) { await step('forcedClose', input); slot.worker?.die(); },
      async retire(input) { calls.push(`${slotId}:retire-reason:${input.reason}`); await step('retire', input); slot.worker?.die(); },
      observeFailure: () => step('observeFailure'),
    });
    return slot;
  });
  const master = {
    async pending() { calls.push('pending'); return structuredClone(pending); },
    async scopeControl(row) { calls.push(`scopeControl:${row.controlId}`); const answer = controls.get(row.controlId);
      if (answer instanceof Error) throw answer; return answer; },
  };
  const log = [];
  const scheduler = createAccountSlotScheduler({ slots, master, pollMs: 10, log: (event, fields) => log.push({ event, ...fields }) });
  const conversation = id => ({ projectId: 'p', conversationId: id, queueRevision: 1 });
  const controlRow = (slot, controlId) => ({ projectId: 'p', controlId, runGrantId: 'g', assignmentDigest: 'b'.repeat(64), rootScopeRef: slot.ref() });
  return { scheduler, slots, calls, pending, controls, log, conversation, controlRow,
    phases: () => scheduler.describe().map(row => row.phase), clear: () => { calls.length = 0; } };
}
const without = (calls, name) => calls.filter(call => call !== name);

test('有排队的对话就开一代、领取、绑定、开跑；同一个对话在这一代关掉之前不会再开第二代', async () => {
  const w = world(); w.pending.conversations = [w.conversation('c1')];
  await w.scheduler.tick(); await quiet();
  assert.deepEqual(without(w.calls, 'pending'), ['slot-a:open:1', 'slot-a:prepare:1:c1:dispatch:slot-a:1', 'slot-a:bind:1', 'slot-a:start:1']);
  assert.deepEqual(w.phases(), ['running']);
  w.clear(); await w.scheduler.tick(); await w.scheduler.tick(); await quiet();
  assert.deepEqual(w.calls, ['pending', 'pending'], '对话还列在排队里，但这一代没关，不再开');
  // 交来终态和意向：让 root 正常关，关完立刻再问一次文档服务。
  w.clear(); w.slots[0].worker.settlement.open({ kind: 'normal', terminal: { t: 1 }, intent: { i: 1 } });
  await quiet();
  assert.deepEqual(w.calls, ['slot-a:close:1']); assert.deepEqual(w.phases(), ['idle']);
  w.clear(); await w.scheduler.tick(); await quiet();
  assert.deepEqual(without(w.calls, 'pending').slice(0, 2), ['slot-a:open:2', 'slot-a:prepare:2:c1:dispatch:slot-a:2'], '关掉以后才给同一个对话开下一代');
});

test('任务进程放弃正常结算时什么都不关，等文档服务的强制终态；文档服务没准备好就下一轮再问', async () => {
  const w = world(); w.pending.conversations = [w.conversation('c1')];
  await w.scheduler.tick(); await quiet();
  w.slots[0].worker.settlement.open({ kind: 'abandoned', code: 'run-revoked' }); await quiet();
  assert.equal(w.calls.some(call => /close|forcedClose|retire/.test(call)), false);
  w.pending.scopeControls = [w.controlRow(w.slots[0], 'stop-1')];
  w.controls.set('stop-1', Object.assign(Error('run-scope-doc-closure-pending'), { status: 503, code: 'run-scope-doc-closure-pending' }));
  w.clear(); await w.scheduler.tick(); await quiet();
  assert.deepEqual(w.calls, ['pending', 'scopeControl:stop-1']); assert.deepEqual(w.phases(), ['running']);
  w.controls.set('stop-1', { unassigned: false, terminal: { forced: true } });
  w.clear(); await w.scheduler.tick(); await quiet();
  assert.deepEqual(w.calls.slice(0, 3), ['pending', 'scopeControl:stop-1', 'slot-a:forcedClose:1']); assert.deepEqual(w.phases(), ['idle']);
  assert.equal(w.calls.includes('slot-a:observeFailure:1'), false, '自己强制关掉的进程退出不算故障');
});

test('正常终态和强制终态一前一后到：一次只做一个，先到的做完这一代就算关了，后到的不再做', async () => {
  const w = world(); w.pending.conversations = [w.conversation('c1')];
  await w.scheduler.tick(); await quiet(); w.pending.conversations = [];
  const slot = w.slots[0]; slot.gates.close = latch();
  slot.worker.settlement.open({ kind: 'normal', terminal: { t: 1 }, intent: { i: 1 } }); await quiet();
  w.pending.scopeControls = [w.controlRow(slot, 'stop-1')]; w.controls.set('stop-1', { unassigned: false, terminal: { forced: true } });
  w.clear(); await w.scheduler.tick(); await w.scheduler.tick(); await quiet();
  assert.deepEqual(w.calls, ['pending', 'pending'], '正常关还在做，强制关排在后面，连强制终态都还没去取');
  slot.gates.close.open(); await quiet();
  assert.equal(w.calls.includes('slot-a:forcedClose:1'), false); assert.equal(w.calls.includes('scopeControl:stop-1'), false);
  assert.deepEqual(w.phases(), ['idle']);

  // 反过来：强制关先开始，正常终态后到。
  const v = world(); v.pending.conversations = [v.conversation('c1')];
  await v.scheduler.tick(); await quiet(); v.pending.conversations = [];
  const other = v.slots[0]; other.gates.forcedClose = latch();
  v.pending.scopeControls = [v.controlRow(other, 'stop-2')]; v.controls.set('stop-2', { unassigned: false, terminal: { forced: true } });
  await v.scheduler.tick(); await quiet();
  other.worker.settlement.open({ kind: 'normal', terminal: { t: 1 }, intent: { i: 1 } }); await quiet();
  other.gates.forcedClose.open(); await quiet();
  assert.equal(v.calls.filter(call => call === 'slot-a:forcedClose:1').length, 1); assert.equal(v.calls.includes('slot-a:close:1'), false);
  assert.deepEqual(v.phases(), ['idle']);
});

test('没领到任务就退掉这一代，同一个对话隔一会儿才再试；文档服务说没绑定的强制终态也按退槽办', async () => {
  const w = world(); w.pending.conversations = [w.conversation('c1')];
  const original = w.slots[0].open.bind(w.slots[0]);
  w.slots[0].open = async () => { const opened = await original(); w.slots[0].worker.prepared = { noTask: true, stage: 'admission', code: 'run-not-ready' }; return opened; };
  await w.scheduler.tick(); await quiet();
  assert.deepEqual(without(w.calls, 'pending'), ['slot-a:open:1', 'slot-a:prepare:1:c1:dispatch:slot-a:1', 'slot-a:retire-reason:assignment-failed', 'slot-a:retire:1']);
  assert.deepEqual(w.phases(), ['idle']);
  w.clear(); await w.scheduler.tick(); await quiet();
  assert.deepEqual(w.calls, ['pending'], '刚领不到，不马上为它再开一个进程');

  const v = world(); v.pending.conversations = [v.conversation('c1')];
  await v.scheduler.tick(); await quiet(); v.pending.conversations = [];
  v.pending.scopeControls = [v.controlRow(v.slots[0], 'private-1')]; v.controls.set('private-1', { unassigned: true });
  v.clear(); await v.scheduler.tick(); await quiet();
  assert.deepEqual(v.calls.slice(1), ['scopeControl:private-1', 'slot-a:retire-reason:assignment-failed', 'slot-a:retire:1']);
});

test('领取的回应不确定、或进程自己没了：不退槽，停主进程、写失败观察，等文档服务的强制终态', async () => {
  const w = world(); w.pending.conversations = [w.conversation('c1')];
  const original = w.slots[0].open.bind(w.slots[0]);
  w.slots[0].open = async () => { const opened = await original(); w.slots[0].worker.prepareError = Object.assign(Error('run-client-unavailable'), { status: 503, code: 'run-client-unavailable' }); return opened; };
  await w.scheduler.tick(); await quiet(); w.pending.conversations = [];
  assert.deepEqual(without(w.calls, 'pending'), ['slot-a:open:1', 'slot-a:prepare:1:c1:dispatch:slot-a:1', 'slot-a:worker-stop:1', 'slot-a:observeFailure:1']);
  assert.equal(w.calls.some(call => call.startsWith('slot-a:retire')), false);
  assert.deepEqual(w.scheduler.describe().map(row => [row.phase, row.failureObserved]), [['failed', true]]);
  w.pending.scopeControls = [w.controlRow(w.slots[0], 'failed-1')]; w.controls.set('failed-1', { unassigned: false, terminal: { forced: true } });
  await w.scheduler.tick(); await quiet();
  assert.deepEqual(w.phases(), ['idle']);

  // 跑着跑着进程没了。
  const v = world(); v.pending.conversations = [v.conversation('c1')];
  await v.scheduler.tick(); await quiet(); v.pending.conversations = [];
  v.clear(); v.slots[0].worker.die(); await quiet();
  assert.deepEqual(v.calls, ['slot-a:observeFailure:1']); assert.deepEqual(v.phases(), ['failed']);
  // 终态和意向都交了，但进程在 root 动手之前没了：不按正常关（正常关要亲眼看它停），改写失败观察。
  const u = world(); u.pending.conversations = [u.conversation('c1')];
  await u.scheduler.tick(); await quiet(); u.pending.conversations = [];
  u.slots[0].gates.observeFailure = latch(); u.clear();
  u.slots[0].worker.die(); u.slots[0].worker.settlement.open({ kind: 'normal', terminal: { t: 1 }, intent: { i: 1 } });
  u.slots[0].gates.observeFailure.open(); await quiet();
  assert.equal(u.calls.includes('slot-a:close:1'), false); assert.deepEqual(u.calls.filter(call => call === 'slot-a:observeFailure:1').length, 1);
});

test('root 的动作失败后这个槽停下等人看，不自动接着做；别的槽照常', async () => {
  const w = world({ slotIds: ['slot-a', 'slot-b'] }); w.pending.conversations = [w.conversation('c1'), w.conversation('c2')];
  await w.scheduler.tick(); await quiet();
  assert.deepEqual(w.phases(), ['running', 'running']);
  assert.ok(w.calls.includes('slot-a:prepare:1:c1:dispatch:slot-a:1') && w.calls.includes('slot-b:prepare:1:c2:dispatch:slot-b:1'), '两个对话各占一个槽');
  w.slots[0].faults.close = 'agent-scope-closure-observation';
  w.slots[0].worker.settlement.open({ kind: 'normal', terminal: { t: 1 }, intent: { i: 1 } });
  w.slots[1].worker.settlement.open({ kind: 'normal', terminal: { t: 2 }, intent: { i: 2 } }); await quiet();
  assert.deepEqual(w.scheduler.describe().map(row => [row.slotId, row.phase, row.note]),
    [['slot-a', 'stuck', 'agent-scope-closure-observation'], ['slot-b', 'idle', 'normal']]);
  w.clear(); w.pending.conversations = [w.conversation('c3')]; await w.scheduler.tick(); await quiet();
  assert.ok(w.calls.includes('slot-b:open:2')); assert.equal(w.calls.some(call => call.startsWith('slot-a:')), false);
});

test('接手上一个调度进程留下的一代：等它主进程退出后写失败观察，再凭强制终态关', async () => {
  const ref = { rootAuthorityId: 'root-slot-a', slotId: 'slot-a', epoch: 7, recordDigest: 'c'.repeat(64) };
  const w = world({ current: () => ({ rootScopeRef: ref, phase: 'bound' }) });
  w.slots[0].faults.observeFailure = 'agent-scope-main-still-live';
  await w.scheduler.start();
  try {
    await quiet(20);
    assert.deepEqual(w.phases(), ['orphan']); assert.ok(w.calls.some(call => call.startsWith('slot-a:observeFailure')));
    assert.equal(w.calls.some(call => call.startsWith('slot-a:open')), false);
    delete w.slots[0].faults.observeFailure;
    w.pending.scopeControls = [{ projectId: 'p', controlId: 'failed-7', runGrantId: 'g', assignmentDigest: 'b'.repeat(64), rootScopeRef: ref }];
    w.controls.set('failed-7', { unassigned: false, terminal: { forced: true } });
    for (let i = 0; i < 200 && w.phases()[0] !== 'idle'; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(w.phases(), ['idle']); assert.ok(w.calls.some(call => call.startsWith('slot-a:forcedClose')));
  } finally { await w.scheduler.stop(); }
});

test('配置不全一律拒绝', () => {
  const good = world();
  for (const change of [{ slots: [] }, { master: {} }, { slots: [{ slotId: 'x' }] }, { pollMs: 0 },
    { slots: [good.slots[0], good.slots[0]] }])
    assert.throws(() => createAccountSlotScheduler({ slots: good.slots, master: { pending() {}, scopeControl() {} }, ...change }),
      /slot-scheduler-configuration/);
});
