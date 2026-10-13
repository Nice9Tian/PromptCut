import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { digestOf } from '../account/ledger.mjs';
import { createWorkerEventJournal } from '../agent-service/worker-event-journal.mjs';
import { createRunDrainRecord, validateRunDrainRecord, createWorkerSettlement,
  createTerminalPrepareSource } from '../agent-service/worker-settlement.mjs';

// 收尾记录的封存、准备签名的来源、四步结算的先后与重试。这里的文档服务是一张按步骤答复的表，
// 只验这一侧的次序和拒绝；真的双向 TLS、真的账本和真的子进程在 account-worker-lifecycle.test.mjs。
const binding = { projectId: 'p', conversationId: 'c', messageId: 'm', runId: 'r', runGrantId: 'g',
  instanceId: 'i', instanceGeneration: 1, serviceKid: 'kid', senderAccountId: 'acc' };
const scope = { authorityId: 'doc', rootScopeRef: { rootAuthorityId: 'root', slotId: 'slot', epoch: 1,
  recordDigest: 'a'.repeat(64) }, assignmentDigest: 'b'.repeat(64), binding };
const grant = { ...binding, accountId: 'acc' };
function ack(packet) {
  const row = { v: 1, authorityId: packet.authorityId, ...packet.binding, eventId: packet.eventId,
    eventSeq: 7 + packet.sourceSeq, at: 123, event: { ...packet.event, ...packet.binding } };
  return { v: 1, authorityId: packet.authorityId, runGrantId: packet.binding.runGrantId,
    instanceId: packet.binding.instanceId, instanceGeneration: packet.binding.instanceGeneration,
    assignmentDigest: packet.assignmentDigest, sourceSeq: packet.sourceSeq, eventId: packet.eventId,
    packetDigest: digestOf(packet), eventSeq: row.eventSeq, eventDigest: digestOf(row), row };
}
function journalFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-worker-settlement-')), file = path.join(dir, 'events.sqlite');
  let journal = createWorkerEventJournal({ file, ...scope });
  t.after(() => { try { journal.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  return { get journal() { return journal; }, reopen() { journal.close(); journal = createWorkerEventJournal({ file, ...scope }); return journal; } };
}
const recordFor = (receipt, status = 'done') => createRunDrainRecord({ grant, readReceiptId: 'read-1',
  outcome: { v: 1, status, eventId: receipt.eventId, eventDigest: receipt.eventDigest } });

test('收尾记录的回执号由内容算出，改任何一处都验不过', () => {
  const record = recordFor({ eventId: 'e', eventDigest: 'c'.repeat(64) });
  assert.deepEqual(validateRunDrainRecord(record), record);
  assert.match(record.drainReceiptId, /^drain:[a-f0-9]{64}$/);
  for (const change of [{ readReceiptId: 'other' }, { outcome: { ...record.outcome, status: 'failed' } },
    { binding: { ...record.binding, runGrantId: 'other' } }, { drain: { ...record.drain, dispatchesOpen: 1 } },
    { drain: { ...record.drain, state: 'unknown' } }, { closed: true }])
    assert.throws(() => validateRunDrainRecord({ ...record, ...change }), /run-drain-record/);
  assert.throws(() => createRunDrainRecord({ grant, readReceiptId: 'read-1', outcome: { v: 1, status: 'success', eventId: 'e', eventDigest: 'c'.repeat(64) } }), /run-outcome-invalid/);
});

test('封存要等全部事件被确认、且终态事件是最后一条；封了不能换、不能再加事件，重开只能读', t => {
  const f = journalFixture(t);
  const first = f.journal.append({ eventId: 'e1', event: { type: 'text', delta: 'a' } });
  const last = f.journal.append({ eventId: 'e2', event: { type: 'runner_done', settlement: 'pending', outcome: 'done' } });
  const r1 = ack(first), r2 = ack(last), record = recordFor(r2);
  assert.equal(f.journal.terminal(), null);
  assert.throws(() => f.journal.sealTerminal(record), /worker-journal-terminal-pending/, '还有事件没被确认');
  f.journal.acknowledge(r1);
  assert.throws(() => f.journal.sealTerminal(record), /worker-journal-terminal-pending/);
  f.journal.acknowledge(r2);
  assert.throws(() => f.journal.sealTerminal(recordFor(r1)), /worker-journal-terminal-pending/, '终态事件不是最后一条');
  assert.throws(() => f.journal.sealTerminal(recordFor({ eventId: 'e2', eventDigest: 'd'.repeat(64) })), /worker-journal-terminal-pending/, '摘要和主服务确认的不一样');
  assert.throws(() => f.journal.sealTerminal(createRunDrainRecord({ grant: { ...grant, runGrantId: 'other' }, readReceiptId: 'read-1', outcome: record.outcome })),
    /worker-journal-terminal-binding/);
  assert.deepEqual(f.journal.sealTerminal(record), record);
  assert.deepEqual(f.journal.sealTerminal(record), record, '同一份内容再封一次是同一个结果');
  assert.throws(() => f.journal.sealTerminal(recordFor(r2, 'failed')), /worker-journal-terminal-conflict/);
  assert.throws(() => f.journal.append({ eventId: 'e3', event: { type: 'text', delta: 'late' } }), /worker-journal-sealed/);
  assert.deepEqual(f.journal.append({ eventId: 'e2', event: last.event }), last, '已有的事件原样重读不算新增');
  assert.deepEqual(f.reopen().terminal(), record);
  assert.throws(() => f.journal.append({ eventId: 'e4', event: { type: 'text', delta: 'after reopen' } }), /worker-journal-sealed/);
});

test('准备签名的来源只认封存的那条记录', async t => {
  const f = journalFixture(t);
  const packet = f.journal.append({ eventId: 'e1', event: { type: 'runner_done', settlement: 'pending', outcome: 'done' } });
  const receipt = ack(packet); f.journal.acknowledge(receipt);
  const source = createTerminalPrepareSource({ readTerminal: () => f.journal.terminal() });
  const record = recordFor(receipt);
  const value = { readReceiptId: record.readReceiptId, eventId: record.outcome.eventId, eventDigest: record.outcome.eventDigest,
    outcomeDigest: digestOf(record.outcome), drainReceiptId: record.drainReceiptId, target: { ...record.binding, publicKeyDigest: 'x' } };
  await assert.rejects(source(value), /run-drain-record/, '还没封存就没有来源');
  f.journal.sealTerminal(record);
  assert.deepEqual(await source(value), value);
  for (const change of [{ drainReceiptId: 'drain:other' }, { outcomeDigest: 'e'.repeat(64) }, { eventId: 'e0' },
    { readReceiptId: 'read-2' }, { target: { ...value.target, runGrantId: 'other' } }])
    await assert.rejects(source({ ...value, ...change }), /instance-scope-prepare-source/);
});

function settlementFixture(script = {}) {
  const expected = { authorityId: 'root', slotId: 'slot' }, record = { epoch: 1, id: 'record' };
  const assignment = { target: { ...binding, publicKeyDigest: 'k' }, signature: 's' };
  delete assignment.target.senderAccountId;
  const terminalRecord = recordFor({ eventId: 'e9', eventDigest: 'c'.repeat(64) });
  const calls = [], answers = { finish: [], scopePrepare: [], scopeTerminal: [], ...script };
  const receipt = { finishReceiptId: 'finish-1', controlId: 'terminal-control:1', readReceiptId: terminalRecord.readReceiptId,
    outcomeDigest: digestOf(terminalRecord.outcome), authoritySeq: 42, outcome: terminalRecord.outcome };
  const next = (name, fallback) => { const answer = answers[name].shift(); if (answer instanceof Error) throw answer; return answer ?? fallback; };
  const runClient = {
    async finish(input) { calls.push(['finish', input]); return next('finish', { finishPending: true, finishReceipt: receipt }); },
    async queryFinish() { throw Error('not-used'); },
    async scopePrepareFor(payload) { calls.push(['prepareFor', payload]); return { ...payload, signature: 'worker-signature' }; },
    async scopePrepare(input) { calls.push(['prepare', input]); return next('scopePrepare', { recorded: true }); },
    async scopeTerminal(input) { calls.push(['terminal', input]); return next('scopeTerminal', { terminal: { protocol: 'terminal', finish: {} } }); },
    scopeIntentFor(input) { calls.push(['intent', input]); return { protocol: 'intent', signature: 'worker-intent' }; },
  };
  const driver = createWorkerSettlement({ runClient, readTerminal: () => terminalRecord, sleep: async () => {},
    scope: { expected, record, assignment, grant } });
  return { driver, calls, receipt, terminalRecord, assignment, record };
}
const unavailable = code => Object.assign(Error(code), { status: 503, code });
const rejected = code => Object.assign(Error(code), { status: 403, code });

test('四步按「结束、准备、终态、意向」的次序走；请求号固定；回应不确定或还没好就原样再问', async () => {
  const f = settlementFixture({ finish: [unavailable('run-client-unavailable')],
    scopeTerminal: [unavailable('run-scope-doc-closure-pending'), unavailable('run-scope-doc-closure-pending')] });
  const result = await f.driver.start();
  assert.equal(result.kind, 'normal'); assert.equal(result.intent.protocol, 'intent');
  assert.deepEqual(f.calls.map(call => call[0]), ['finish', 'finish', 'prepareFor', 'prepare', 'terminal', 'terminal', 'terminal', 'intent']);
  assert.deepEqual(f.calls[0][1], f.calls[1][1], '重发的是同一个请求');
  assert.equal(f.calls[0][1].requestId, 'finish:g'); assert.deepEqual(f.calls[0][1].outcome, f.terminalRecord.outcome);
  assert.equal(f.calls[0][1].readReceiptId, 'read-1');
  const payload = f.calls[2][1];
  assert.deepEqual(payload.scope, { authorityId: 'root', slotId: 'slot', epoch: 1, recordDigest: digestOf(f.record), assignmentDigest: digestOf(f.assignment) });
  assert.equal(payload.drainReceiptId, f.terminalRecord.drainReceiptId); assert.equal(payload.docControlId, 'terminal-control:1');
  assert.equal(payload.docFenceRevision, 42); assert.equal(payload.eventId, 'e9');
  assert.equal(f.calls[3][1].requestId, 'prepare:g'); assert.equal(f.calls[3][1].prepare.signature, 'worker-signature');
  assert.equal(f.calls[4][1].requestId, 'terminal:g'); assert.deepEqual(f.calls[4][1], f.calls[6][1]);
  assert.equal(await f.driver.start(), result, '结算只做一遍');
  assert.equal(f.driver.describe().state, 'intent-ready');
});

test('文档服务明确拒绝（任务已被撤销）就放弃正常结算，不补签、不换别的结果', async () => {
  for (const [step, script, expectedCalls] of [
    ['finish', { finish: [rejected('run-revoked')] }, ['finish']],
    ['prepare', { scopePrepare: [rejected('run-revoked')] }, ['finish', 'prepareFor', 'prepare']],
    ['terminal', { scopeTerminal: [unavailable('run-scope-doc-closure-pending'), rejected('run-revoked')] }, ['finish', 'prepareFor', 'prepare', 'terminal', 'terminal']]]) {
    const f = settlementFixture(script), result = await f.driver.start();
    assert.deepEqual(result, { kind: 'abandoned', code: 'run-revoked' }, step);
    assert.deepEqual(f.calls.map(call => call[0]), expectedCalls, step);
    assert.equal(f.driver.describe().state, 'abandoned');
  }
});

test('结束回执和封存的记录对不上就停，不签准备', async () => {
  const f = settlementFixture({ finish: [{ finishPending: true, finishReceipt: { finishReceiptId: 'finish-1', controlId: 'c', readReceiptId: 'read-1',
    outcomeDigest: 'f'.repeat(64), authoritySeq: 1 } }] });
  assert.deepEqual(await f.driver.start(), { kind: 'abandoned', code: 'worker-settlement-finish-protocol' });
  assert.deepEqual(f.calls.map(call => call[0]), ['finish']);
});
