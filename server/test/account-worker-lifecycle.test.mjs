import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { digestOf } from '../account/ledger.mjs';
import { startWorkerLifecycleFixture, until } from './fixtures/account-worker-lifecycle.mjs';

// 一条任务一个进程，从领取到结清的整条路。哪些是真的、哪些是受控的，写在两个夹具文件的开头：
// 简单说，文档服务一侧、主服务一侧、任务子进程、调度和 root 发布器的事务都是真的；
// 运行器是照脚本走的，root 看操作系统的那一半用「子进程真的退出」代替 cgroup。
async function fixture(t) {
  const f = await startWorkerLifecycleFixture();
  t.after(async () => {
    const result = await f.close();
    assert.equal(result.alive, 0, '收尾后不该还有活着的任务子进程');
    if (result.errors.length) throw new AggregateError(result.errors, `fixture close; kept ${result.dir}`);
  });
  return f;
}
const message = (f, id) => f.conversation().messages.find(row => row.messageId === id);
const finished = (f, id) => f.grantOf(id)?.state === 'finished';
const sealedRecord = file => {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return JSON.parse(db.prepare('SELECT record FROM worker_terminal WHERE id=1').get().record); } finally { db.close(); }
};

test('正常结束：第一条被 root 关掉、文档服务结清之后，第二条才领得到、才开始', { timeout: 120_000 }, async t => {
  const f = await fixture(t);
  const first = f.enqueue([{ say: '第一条开工' }, { tool: 'get_project' }, { hold: 'first' }, { say: '第一条收工' }]);
  const second = f.enqueue([{ say: '第二条' }]);
  await f.scheduler.start();
  const held = await until(() => f.marker('held-first'), { what: '第一条任务进到占用状态' });
  const g1 = f.grantOf(first);
  assert.equal(f.conversation().currentRunId, g1.runId);
  assert.equal(g1.state, 'active'); assert.ok(g1.readReceiptId, '已读确认在开跑之前');
  assert.notEqual(held.pid, process.pid, '任务在另一个操作系统进程里跑');
  assert.equal(held.pid, f.generations.get(1).pid);
  assert.equal(f.chain(1).assignment.target.runGrantId, g1.runGrantId, 'root 绑定的就是文档服务签给这一条的分配');

  // 第一条还占着：再问多少轮，第二条都领不到，也不会另开进程。
  for (let i = 0; i < 6; i++) await f.scheduler.tick();
  assert.equal(message(f, second).queueState, 'queued');
  assert.equal(f.grantOf(second), null); assert.equal(f.marker(`started-${second}`), null);
  assert.equal(f.generations.size, 1); assert.equal(f.headRecord().head.phase, 'bound');

  f.release('first');
  await until(() => finished(f, first), { what: '第一条结清' });
  const done1 = f.grantOf(first), receipt = f.ledger.read().runFinishReceiptsV2[done1.finishReceiptId], chain1 = f.chain(1);
  assert.equal(done1.terminalOutcome.status, 'done'); assert.equal(message(f, first).terminalOutcome.status, 'done');
  // 结清凭的是 root 的关闭记录，不是进程自己说的。
  assert.equal(chain1.closure.protocol, 'promptcut.agent-run-scope.closure.v1');
  assert.equal(chain1.terminal.protocol, 'promptcut.agent-run-scope.terminal.v1');
  assert.equal(chain1.intent.terminalDigest, digestOf(chain1.terminal));
  assert.equal(receipt.complete, true); assert.equal(receipt.resourceWitnessDigest, digestOf(chain1.closure));
  assert.equal(f.ledger.read().runControlsV2[receipt.controlId].state, 'complete');
  // 第一代进程真的退了，而且是自己收完才退的。
  const stop1 = f.stops.find(row => row.epoch === 1);
  assert.equal(stop1.how, 'graceful'); assert.equal(stop1.exitCode, 0); assert.equal(stop1.pid, held.pid);
  assert.equal(f.generations.get(1).gateway.describe().childClosed, true);
  // 收尾记录：终态事件就是主服务确认过的最后一条，文档服务记下的结果与它一致。
  const sealed = sealedRecord(f.generations.get(1).journalFile);
  assert.equal(sealed.outcome.status, 'done'); assert.deepEqual(sealed.drain, { state: 'local-drained', events: 'durable', dispatchesOpen: 0 });
  assert.deepEqual(receipt.outcome, sealed.outcome); assert.equal(sealed.readReceiptId, done1.readReceiptId);
  assert.equal(chain1.terminal.finish.outcomeDigest, digestOf(sealed.outcome));

  await until(() => finished(f, second), { what: '第二条结清' });
  const g2 = f.grantOf(second), started2 = f.marker(`started-${second}`);
  assert.equal(g2.terminalOutcome.status, 'done');
  // 先后：第二条的领取、它的进程开始干活，都在第一代进程被关掉之后；用的是新的一代进程。
  assert.ok(g2.admittedAt >= stop1.at, `第二条领取 ${g2.admittedAt} 不该早于第一代关闭 ${stop1.at}`);
  assert.ok(started2.at >= stop1.at); assert.equal(started2.epoch, 2); assert.notEqual(started2.pid, held.pid);
  assert.equal(f.chain(2).assignment.target.runGrantId, g2.runGrantId);
  assert.equal(f.conversation().currentRunId, null);
  const rows = f.events();
  assert.deepEqual(rows.filter(row => row.runGrantId === g1.runGrantId).map(row => row.event.type),
    ['run', 'text', 'tool_call', 'tool_result', 'text', 'runner_done']);
  assert.equal(rows.find(row => row.runGrantId === g1.runGrantId && row.event.type === 'tool_result').event.output, undefined);
  const last1 = rows.findLast(row => row.runGrantId === g1.runGrantId);
  assert.equal(last1.event.outcome, 'done'); assert.equal(last1.eventId, sealed.outcome.eventId); assert.equal(digestOf(last1), sealed.outcome.eventDigest);
  assert.ok(rows.findIndex(row => row.runGrantId === g2.runGrantId) > rows.indexOf(last1), '第二条的事件排在第一条终态之后');
  assert.deepEqual(f.scheduler.describe().map(row => row.phase), ['idle']);
  t.diagnostic(`normal: epoch1 pid ${held.pid} closed gracefully at ${stop1.at}; second admitted ${g2.admittedAt}, started ${started2.at} in pid ${started2.pid}`);
});

test('从外面强制停：任务没做完就被 root 强制关掉，结果是「被中断」，后面排队的照常接着跑', { timeout: 120_000 }, async t => {
  const f = await fixture(t);
  const first = f.enqueue([{ say: '开工' }, { hold: 'never-released' }, { say: '这句不该出现' }]);
  const second = f.enqueue([{ say: '下一条' }]);
  await f.scheduler.start();
  const held = await until(() => f.marker('held-never-released'), { what: '任务进到占用状态' });
  const g1 = f.grantOf(first);
  const control = f.stop(g1.runId);
  assert.deepEqual(control.revoked, [g1.runGrantId]);
  // 围栏在文档服务一提交就生效：任务再也过不了闸；但名额要等进程真的关了才让。
  assert.equal(f.grantOf(first).state, 'revoked'); assert.equal(f.conversation().currentRunId, g1.runId);
  assert.equal(message(f, second).queueState, 'queued');
  await until(() => finished(f, first), { what: '强制停止结清' });
  const done1 = f.grantOf(first), chain1 = f.chain(1), stop1 = f.stops.find(row => row.epoch === 1);
  assert.equal(done1.terminalOutcome.status, 'interrupted'); assert.equal(done1.terminalOutcome.reason, 'stop');
  assert.equal(done1.finishReceiptId, undefined, '没做完的任务没有正常结束的回执');
  assert.equal(chain1.terminal.protocol, 'promptcut.agent-run-scope.forced-terminal.v1');
  assert.equal(chain1.terminal.fence.controlId, control.controlId); assert.equal(chain1.terminal.fence.kind, 'stop');
  assert.equal(chain1.intent, null, '强制关不需要、也不补任务进程的意向');
  assert.equal(chain1.closure.protocol, 'promptcut.agent-run-scope.forced-closure.v1');
  assert.equal(stop1.how, 'killed'); assert.equal(stop1.pid, held.pid);
  assert.equal(f.generations.get(1).gateway.describe().childClosed, true);
  assert.equal(message(f, first).queueState, 'cancelled');
  // 这条停止控制到这里才算办完（停止接口据此回成功）。
  const closed = f.ledger.read().runControlsV2[control.controlId];
  assert.equal(closed.state, 'complete'); assert.equal(closed.receipt.closures[g1.runGrantId], digestOf(chain1.closure));
  assert.equal(f.events().some(row => row.event.type === 'text' && row.event.delta === '这句不该出现'), false);
  assert.equal(f.events().some(row => row.runGrantId === g1.runGrantId && row.event.type === 'runner_done'), false);

  await until(() => finished(f, second), { what: '后一条结清' });
  const g2 = f.grantOf(second);
  assert.equal(g2.terminalOutcome.status, 'done'); assert.ok(g2.admittedAt >= stop1.at);
  assert.equal(f.marker(`started-${second}`).epoch, 2);
  assert.deepEqual(f.scheduler.describe().map(row => row.phase), ['idle']);
  t.diagnostic(`forced: epoch1 pid ${held.pid} killed at ${stop1.at} (exit ${stop1.exitCode}/${stop1.signal}); control ${closed.state}`);
});

test('交错一：任务刚报了结束、文档服务还没签终态时来了停止——只走强制，结果是「被中断」', { timeout: 120_000 }, async t => {
  const f = await fixture(t);
  f.gates.holdTerminalDelivery = true; // 文档服务先不关它那一侧的连接，于是终态签不出来
  const first = f.enqueue([{ say: '做完了' }]), second = f.enqueue([{ say: '下一条' }]);
  await f.scheduler.start();
  // 任务自己已经做完：结束回执和准备都记下了，在等终态。
  const g1 = await until(() => { const g = f.grantOf(first); return g?.finishReceiptId && f.ledger.read().runScopePreparesV1?.[g.finishReceiptId] ? g : null; },
    { what: '结束与准备已记' });
  const receipt = f.ledger.read().runFinishReceiptsV2[g1.finishReceiptId];
  assert.equal(receipt.outcome.status, 'done'); assert.equal(receipt.complete, false);
  assert.equal(f.conversation().currentRunId, g1.runId, '报了结束不等于结清，名额还占着');
  assert.equal(f.headRecord().head.phase, 'bound');
  const control = f.stop(g1.runId);
  f.gates.holdTerminalDelivery = false;
  await until(() => finished(f, first), { what: '交错一结清' });
  const done1 = f.grantOf(first), chain1 = f.chain(1);
  // 文档服务没有给被撤销的任务签正常终态；root 上只有一份关闭记录，是强制的。
  assert.equal(f.ledger.read().runScopeTerminalsV1?.[g1.finishReceiptId], undefined);
  assert.equal(chain1.terminal.protocol, 'promptcut.agent-run-scope.forced-terminal.v1'); assert.equal(chain1.intent, null);
  assert.equal(done1.terminalOutcome.status, 'interrupted');
  assert.equal(f.ledger.read().runFinishReceiptsV2[g1.finishReceiptId].outcome.status, 'done', '任务自己报的结果原样留着，不被改写');
  assert.equal(f.ledger.read().runControlsV2[control.controlId].state, 'complete');
  assert.equal(f.stops.filter(row => row.epoch === 1).length, 1); assert.equal(f.stops[0].how, 'killed');
  assert.equal(f.log.some(row => row.event === 'slot.stuck'), false);
  await until(() => finished(f, second), { what: '后一条结清' });
  assert.equal(f.grantOf(second).terminalOutcome.status, 'done');
});

test('交错二：终态和意向都有了、root 正要正常关时来了停止——只关一次，按正常关，文档服务仍记「被中断」', { timeout: 120_000 }, async t => {
  const f = await fixture(t);
  let letClose; f.holds.normalClose = new Promise(resolve => { letClose = resolve; });
  const first = f.enqueue([{ say: '做完了' }]), second = f.enqueue([{ say: '下一条' }]);
  await f.scheduler.start();
  await until(() => f.log.some(row => row.event === 'root.close.requested'), { what: '调度已拿到终态和意向、正要让 root 正常关' });
  const g1 = f.grantOf(first);
  assert.ok(f.ledger.read().runScopeTerminalsV1[g1.finishReceiptId], '文档服务已经签了正常终态');
  assert.equal(f.conversation().currentRunId, g1.runId); assert.equal(f.headRecord().head.phase, 'bound');
  const control = f.stop(g1.runId);
  // 强制终态也已经可取：等调度看到它，排在正常关后面。
  await until(async () => { await f.scheduler.tick(); return f.ledger.read().docRunClosuresV2?.[control.controlId]?.instances?.['doc-live']?.state === 'closed'; },
    { what: '停止控制在文档服务一侧办完它自己的部分' });
  await f.scheduler.tick();
  assert.equal(f.headRecord().head.phase, 'bound', '正常关还没放行，强制关不抢、不并行');
  letClose();
  await until(() => finished(f, first), { what: '交错二结清' });
  const done1 = f.grantOf(first), chain1 = f.chain(1);
  assert.equal(chain1.terminal.protocol, 'promptcut.agent-run-scope.terminal.v1'); assert.ok(chain1.intent);
  assert.equal(chain1.closure.protocol, 'promptcut.agent-run-scope.closure.v1');
  assert.equal(f.stops.filter(row => row.epoch === 1).length, 1, '这一代只被关了一次'); assert.equal(f.stops[0].how, 'graceful');
  assert.equal(f.m.calls.filter(call => call === 'stop').length >= 1, true);
  // 关的时候按正常关，但停止在结清之前已经生效：文档服务按自己的记录记「被中断」，不拿之前的成功回应盖过去。
  assert.equal(done1.terminalOutcome.status, 'interrupted'); assert.equal(done1.terminalOutcome.reason, 'stop');
  assert.equal(f.ledger.read().runControlsV2[control.controlId].state, 'complete');
  assert.equal(f.log.some(row => row.event === 'slot.stuck'), false);
  await until(() => finished(f, second), { what: '后一条结清' });
  assert.equal(f.grantOf(second).terminalOutcome.status, 'done');
  assert.equal(f.marker(`started-${second}`).epoch, 2);
  assert.deepEqual(f.scheduler.describe().map(row => row.phase), ['idle']);
});

test('任务进程中途死掉：root 写失败观察，文档服务据此强制收口，结果是「失败」，后面的照常', { timeout: 120_000 }, async t => {
  const f = await fixture(t);
  const first = f.enqueue([{ say: '开工' }, { crash: true }]), second = f.enqueue([{ say: '下一条' }]);
  await f.scheduler.start();
  await until(() => finished(f, first), { what: '崩溃的任务结清' });
  const done1 = f.grantOf(first), chain1 = f.chain(1);
  assert.equal(done1.terminalOutcome.status, 'failed'); assert.equal(done1.terminalOutcome.reason, 'worker-failed');
  assert.equal(chain1.failure.observed.kind, 'main-birth-gone'); assert.equal(chain1.failure.assignmentDigest, digestOf(chain1.assignment));
  assert.equal(chain1.terminal.protocol, 'promptcut.agent-run-scope.forced-terminal.v1'); assert.equal(chain1.terminal.fence.kind, 'worker-failed');
  assert.equal(chain1.closure.protocol, 'promptcut.agent-run-scope.forced-closure.v1');
  await until(() => finished(f, second), { what: '后一条结清' });
  assert.equal(f.grantOf(second).terminalOutcome.status, 'done'); assert.equal(f.marker(`started-${second}`).epoch, 2);
});

test('没领到任务的一代：退掉、槽回收，不占名额；之后的任务照常', { timeout: 120_000 }, async t => {
  const f = await fixture(t);
  const ghost = f.enqueue([{ say: '不该执行' }], 'ghost'); // 发消息的账号不是这个项目的成员
  await f.scheduler.start();
  await until(() => message(f, ghost).queueState === 'cancelled' && f.headRecord()?.head.phase === 'closed', { what: '没领到任务的一代被退掉' });
  const chain1 = f.chain(1);
  assert.equal(f.grantOf(ghost), null, '文档服务没有给这条消息任何任务授权');
  assert.equal(chain1.assignment, null);
  assert.equal(chain1.terminal.protocol, 'promptcut.agent-run-scope.unassigned-retirement.v1'); assert.equal(chain1.terminal.reason, 'assignment-failed');
  assert.equal(chain1.closure.protocol, 'promptcut.agent-run-scope.unassigned-closure.v1');
  assert.equal(f.marker(`started-${ghost}`), null); assert.equal(f.stops[0].how, 'killed');
  assert.equal(f.conversation().currentRunId, null);
  for (let i = 0; i < 3; i++) await f.scheduler.tick();
  assert.equal(f.generations.size, 1, '队列里没有可领的就不再开进程');
  const next = f.enqueue([{ say: '正常的一条' }]);
  f.scheduler.kick();
  await until(() => finished(f, next), { what: '之后的任务结清' });
  assert.equal(f.grantOf(next).terminalOutcome.status, 'done'); assert.equal(f.marker(`started-${next}`).epoch, 2);
  assert.deepEqual(f.scheduler.describe().map(row => row.phase), ['idle']);
});
