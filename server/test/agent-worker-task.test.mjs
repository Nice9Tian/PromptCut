import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runFixture, projectId, conversationId, servicePrincipal } from './run-authority-fixture.mjs';
import { createAccountRunManager } from '../agent/service/account-runner.mjs';
import { createAccountRunEvents } from '../agent/service/account-run-events.mjs';
import { createHostedAgentService } from '../agent/service/create-agent-service.mjs';
import { validateRunDrainRecord } from '../agent-service/worker-settlement.mjs';
import { digestOf } from '../account/ledger.mjs';

// Real SQLite/read-intent/event ledgers and existing run authority. Assignment
// publication and model/drain are controlled here; no production bound proof.
async function setup(t, { bound = false, closeError = null, runnerError = null, silent = false } = {}) {
  const f = await runFixture(); f.enqueue(); f.enqueue('message2');
  // The old core fixture predates durable user-event mirroring. Complete this
  // test's trusted Doc seed with the fields real conversation.send persists.
  f.ledger.transaction(state => {
    for (const message of state.conversationsV2[projectId][conversationId].messages) {
      message.createdAt = f.clock.now;
      message.selectionSnapshot.messageId = message.messageId;
    }
  });
  const calls = { admit: [], reads: 0, model: 0, drain: 0, hook: [] };
  const client = { async admit(input) { calls.admit.push(input.requestId); return f.provider.admit({ ...input, servicePrincipal }); },
    confirmRead(input) { calls.reads++; return f.provider.confirmRead({ ...input, servicePrincipal }); },
    queryRead: input => f.provider.queryRead({ ...input, servicePrincipal }),
    async checkAccess({ projectId: p, runGrantId, action }) { const principal = await f.provider.resolveRunPrincipal({
      servicePrincipal, projectId: p, runGrantId }); return f.provider.checkAccess({ principal, projectId: p, action }); },
    finish() { throw Error('legacy-finish-must-not-run'); }, pending() { throw Error('global-pending-must-not-run'); } };
  const events = createAccountRunEvents({ file: path.join(f.dir, 'events.sqlite'), authorityId: f.ledger.authorityId,
    verifyGrant: grant => client.checkAccess({ projectId, runGrantId: grant.runGrantId, action: 'write' }) });
  const options = { runClient: client, readIntents: f.intents, runEvents: events,
    task: { projectId, conversationId, requestId: 'task-dispatch' },
    serviceKid: f.agentProcess.registration.serviceKid, instanceId: f.agentProcess.registration.instanceId,
    assignmentReady: async grant => ({ executionAllowed: bound, phase: bound ? 'bound' : 'assigned-unbound',
      assignment: { target: grant } }),
    onTaskDrained: async value => { calls.hook.push(value); },
    runnerFactory: async ({ onModelCall, onEvent }) => ({
      async start() { await onModelCall(); calls.model++; onEvent({ type: 'text_delta', text: 'controlled task' });
        if (runnerError) return { done: Promise.reject(runnerError), abort() {} };
        if (!silent) onEvent({ type: 'done' });
        return { done: Promise.resolve(), abort() {} }; },
      async drain() { calls.drain++; }, close() { if (closeError) throw closeError; },
    }) };
  const manager = createAccountRunManager(options);
  t.after(async () => { manager.close(); await manager.idle().catch(() => {}); await events.close(); f.close();
    fs.rmSync(f.dir, { recursive: true, force: true }); });
  return { f, manager, options, calls, events, enable: () => { bound = true; } };
}

test('single worker cannot read/model before bound or select another conversation', async t => {
  const x = await setup(t);
  await assert.rejects(x.manager.wake(projectId, 'another'), /account-worker-task-binding/);
  await assert.rejects(x.manager.resumeQueued(), /account-worker-assignment-pending/);
  assert.equal(x.calls.reads, 0); assert.equal(x.calls.model, 0);
  assert.equal(Object.keys(x.f.ledger.read().runGrantsV2).length, 1);
  x.enable();
  // 2026-10-13：任务真做完以后不再有意抛 run-outcome-unavailable，而是形成收尾记录交给主人去结算。
  // 旧的结束接口仍然一次都不调（上面的 finish 一调就抛），文档服务那边这条任务也仍然没结清。
  await x.manager.resumeQueued();
  assert.equal(x.calls.admit.length, 1); assert.equal(x.calls.admit[0], 'task-dispatch');
  assert.equal(x.calls.model, 1); assert.equal(x.calls.drain, 1);
  const hook = x.calls.hook[0], grant = Object.values(x.f.ledger.read().runGrantsV2)[0];
  assert.equal(hook.eventFlushState, 'durable'); assert.equal(hook.drainState, 'local-drained');
  assert.equal(hook.readReceiptId, Object.values(x.f.ledger.read().runReceiptsV2)[0].receiptId);
  const rows = x.events.after({ projectId, conversationId }).events, last = rows.at(-1);
  assert.deepEqual(rows.map(row => row.event.type), ['user', 'text_delta', 'runner_done']);
  assert.equal(last.event.outcome, 'done'); assert.equal(last.event.settlement, 'pending');
  assert.deepEqual(hook.outcome, { v: 1, status: 'done', eventId: last.eventId, eventDigest: digestOf(last) });
  assert.deepEqual(validateRunDrainRecord(hook.drainRecord), hook.drainRecord);
  assert.deepEqual(hook.drainRecord.outcome, hook.outcome); assert.equal(hook.drainRecord.readReceiptId, hook.readReceiptId);
  assert.equal(hook.drainRecord.binding.runGrantId, grant.runGrantId);
  assert.throws(() => validateRunDrainRecord({ ...hook.drainRecord, outcome: { ...hook.outcome, status: 'failed' } }), /run-drain-record/);
  assert.equal(grant.state, 'active'); assert.equal(grant.finishReceiptId, undefined);
  assert.equal(x.f.ledger.read().conversationsV2[projectId][conversationId].currentRunId, grant.runId);
  await assert.rejects(x.manager.resumeQueued(), /account-worker-task-consumed/);
  assert.equal(Object.keys(x.f.ledger.read().runGrantsV2).length, 1);
  assert.equal(x.f.ledger.read().conversationsV2[projectId][conversationId].messages[1].queueState, 'queued');
});

test('single task configuration requires bound source, durable events and drain owner', async t => {
  const x = await setup(t);
  for (const change of [{ assignmentReady: null }, { runEvents: null }, { onTaskDrained: null },
    { task: { ...x.options.task, runGrantId: 'transferred' } }])
    assert.throws(() => createAccountRunManager({ ...x.options, ...change }), /account-worker-task-configuration/);
  assert.equal(x.calls.admit.length, 0);
});

test('actual owned close failure propagates and reports unknown rather than local drained', async t => {
  const x = await setup(t, { bound: true, closeError: Error('owned-close-failed') });
  await assert.rejects(x.manager.resumeQueued(), /owned-close-failed/);
  assert.equal(x.calls.hook[0].drainState, 'unknown');
  // 运行器没收干净：终态事件虽然落了盘，也不形成收尾记录，这条任务不能走正常结算。
  assert.equal(x.calls.hook[0].outcome.status, 'done'); assert.equal(x.calls.hook[0].drainRecord, null);
  assert.equal(x.manager.describe().activeRuns, 0);
  await assert.rejects(x.manager.resumeQueued(), /account-worker-task-consumed/);
});

test('a rejected or silent runner is a real failed outcome; it is never reported as done', async t => {
  for (const options of [{ runnerError: Error('model-crashed') }, { silent: true }]) {
    const x = await setup(t, { bound: true, ...options });
    await x.manager.resumeQueued();
    const hook = x.calls.hook[0], last = x.events.after({ projectId, conversationId }).events.at(-1);
    assert.equal(last.event.type, 'runner_done'); assert.equal(last.event.outcome, 'failed');
    assert.equal(hook.outcome.status, 'failed'); assert.equal(hook.drainRecord.outcome.status, 'failed');
    assert.equal(hook.drainState, 'local-drained');
  }
});

test('Hosted factory actually passes task, assignment, events and drain hooks; default stays non-task', async t => {
  const x = await setup(t, { bound: true });
  const unavailable = async () => { throw Error('human-conversation-not-part-of-worker-test'); };
  const conversationClient = Object.fromEntries(['identity', 'access', 'list', 'get', 'send', 'switchVisibility', 'stop', 'rename']
    .map(name => [name, unavailable]));
  const service = createHostedAgentService({ ...x.options, accountMode: true, requireAccountRunner: true,
    conversationClient, readIntentsFile: path.join(x.f.dir, 'hosted-intents.sqlite'), runEventsSink: x.events });
  try {
    assert.equal(service.describe().singleTask, true);
    await service.runManager.resumeQueued();
    assert.equal(x.calls.model, 1); assert.equal(x.calls.hook.length, 1);
    assert.equal(x.calls.hook[0].outcome.status, 'done'); assert.ok(x.calls.hook[0].drainRecord.drainReceiptId.startsWith('drain:'));
    const ordinary = createHostedAgentService({ accountMode: true, requireAccountRunner: true,
      conversationClient, runClient: x.options.runClient, serviceKid: x.options.serviceKid,
      instanceId: x.options.instanceId, runnerFactory: x.options.runnerFactory,
      readIntentsFile: path.join(x.f.dir, 'ordinary-intents.sqlite') });
    try { assert.equal(ordinary.describe().singleTask, undefined); }
    finally { await ordinary.close(); }
  } finally { await service.close(); }
});
