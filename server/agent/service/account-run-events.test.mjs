import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAccountRunEvents } from './account-run-events.mjs';
import { openAccountLedger } from '../../account/ledger.mjs';
import { createConversationAuthority, claimNextInState, markReadInState, finishInState } from '../../account/conversation-authority.mjs';
import { createRunAuthority } from '../../account/run-authority.mjs';
import { openReadIntents } from './read-intents.mjs';
import { createAccountRunManager } from './account-runner.mjs';
import { instanceFixture } from '../../test/agent-instance-fixture.mjs';

const grant = (extra = {}) => ({ projectId: 'project_a', conversationId: 'conversation_a',
  messageId: 'message_a', runId: 'run_a', runGrantId: 'grant_a', accountId: 'account_a',
  instanceId: 'instance_a', instanceGeneration: 1, serviceKid: 'kid_a', ...extra });
function fixture(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-account-run-events-'));
  const file = path.join(dir, 'events.sqlite');
  const open = more => createAccountRunEvents({ file, authorityId: 'doc-a',
    verifyGrant: async value => ({ allowed: true, runGrant: value }), ...options, ...more });
  return { file, open, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('FULL committed events replay across reopen; scoped monotonic cursors and immutable sender binding', async () => {
  const f = fixture(); let store = f.open();
  try {
    const binding = await store.registerRun({ grant: grant() });
    const first = await store.append({ binding, eventId: 'event1', event: { type: 'run', runId: 'forged' } });
    assert.equal(first.runId, 'run_a'); assert.equal(first.senderAccountId, 'account_a');
    assert.equal(first.event.runId, 'run_a'); assert.equal(first.eventSeq, 1);
    const next = await store.registerRun({ grant: grant({ messageId: 'message_b', runId: 'run_b', runGrantId: 'grant_b' }) });
    await store.append({ binding: next, eventId: 'event2', event: { type: 'progress', value: 2 } });
    const other = await store.registerRun({ grant: grant({ projectId: 'project_b', runGrantId: 'grant_c' }) });
    await store.append({ binding: other, eventId: 'event3', event: { type: 'tool_call', name: 'get_project' } });
    assert.equal(store.inspect().synchronous, 2);
    await store.close(); store = f.open();
    assert.deepEqual(store.after({ projectId: 'project_a', conversationId: 'conversation_a', after: 1 }).events.map(e => e.eventSeq), [2]);
    assert.equal(store.after({ projectId: 'project_b', conversationId: 'conversation_a', after: 0 }).head, 1);
    assert.throws(() => store.after({ projectId: 'project_a', conversationId: 'conversation_a', after: 3 }), /event-cursor/);
  } finally { await store.close(); f.cleanup(); }
});

test('identical event IDs replay exactly, conflicts and forged registered binding are rejected', async () => {
  const f = fixture(); const store = f.open();
  try {
    const binding = await store.registerRun({ grant: grant() });
    const args = { binding, eventId: 'same', event: { type: 'text', delta: 'kept' } };
    const first = await store.append(args);
    assert.deepEqual(await store.append(args), first);
    await assert.rejects(store.append({ ...args, event: { type: 'text', delta: 'changed' } }), { code: 'run-event-conflict', status: 409 });
    await assert.rejects(store.append({ ...args, binding: { ...binding, senderAccountId: 'other' } }), /run-event-binding/);
    assert.equal(store.after({ ...grant(), after: 0 }).head, 1);
  } finally { await store.close(); f.cleanup(); }
});

test('fresh provider mismatch and missing trusted configuration never register a run', async () => {
  const f = fixture(); const store = f.open({ verifyGrant: async g => ({ allowed: true, runGrant: { ...g, instanceGeneration: 2 } }) });
  try {
    await assert.rejects(store.registerRun({ grant: grant() }), /run-event-grant/);
    assert.throws(() => createAccountRunEvents({ file: f.file, authorityId: 'doc-a' }), /run-events-configuration/);
  } finally { await store.close(); f.cleanup(); }
});

test('supervised synchronous emitter copies payload, drains in order, omits full tool output', async () => {
  const f = fixture(); const store = f.open();
  try {
    const writer = await store.writer({ grant: grant() });
    const event = { type: 'progress', details: { value: 1 } };
    writer.emit(event); event.details.value = 99;
    writer.emit({ type: 'tool_result', output: { secretProject: 'not-public' } });
    await writer.beforeCall();
    const events = store.after({ ...grant(), after: 0 }).events;
    assert.equal(events[0].event.details.value, 1);
    assert.equal(events[1].event.output, undefined); assert.equal(events[1].event.outputOmitted, true);
    assert.deepEqual(events.map(e => e.eventSeq), [1, 2]);
  } finally { await store.close(); f.cleanup(); }
});

test('real SQLite failure is supervised immediately; subsequent gate and flush reject original failure', async () => {
  let shouldFail = false;
  const f = fixture({ failpoint(point) { if (shouldFail && point === 'event-before-commit') throw new Error('durable-event-write-failed'); } });
  const store = f.open(); const unhandled = [];
  const capture = e => unhandled.push(e); process.on('unhandledRejection', capture);
  try {
    const writer = await store.writer({ grant: grant() }); shouldFail = true;
    writer.emit({ type: 'tool_call', name: 'add_clip' });
    const failure = await writer.failed;
    assert.match(failure.message, /durable-event-write-failed/);
    await assert.rejects(writer.beforeCall(), /durable-event-write-failed/);
    await assert.rejects(writer.flush(), /durable-event-write-failed/);
    assert.equal(store.after({ ...grant(), after: 0 }).head, 0);
    await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(unhandled, []);
  } finally { process.off('unhandledRejection', capture); await store.close(); f.cleanup(); }
});

// Real doc ledger, RAM-key registration, signed invocation/run authority and FULL
// read intents. Account actor verification is a controlled adapter; no TLS/model
// or business listener is started by this fixture.
async function managerFixture(failpoint = () => {}) {
  const f = fixture(); const projectId = 'sp_' + 'a'.repeat(26), accountId = 'acc_' + 'b'.repeat(24);
  const ledger = openAccountLedger({ file: path.join(path.dirname(f.file), 'doc.sqlite'), authorityId: 'doc-a' });
  ledger.transaction(s => { s.projects[projectId] = { status: 'active', creatorAccountId: accountId,
    members: { [accountId]: { access: 'rw' } }, bans: {}, hosted: { agent: true } }; });
  const verifyServiceInState = (_s, p) => p?.authenticated === 'controlled-cert' ? { serviceId: 'agent', serviceKid: 'kid-a' } : null;
  const instances = instanceFixture(ledger, { verifyServiceInState });
  const processInstance = instances.boot({ principal: instances.connection({ authenticated: 'controlled-cert', serviceKid: 'kid-a' }) });
  const run = createRunAuthority({ ledger, conversationHooks: { claimNextInState, markReadInState, finishInState },
    verifySender: async ref => ({ ...ref, accountEventSeq: 0 }), verifyServiceInState,
    instanceAuthority: instances.authority, synchronize: async () => {} });
  const invoke = async (operation, input) => {
    const signed = instances.authorize(processInstance, operation, input);
    try { return await run[operation](input.principal ? { ...input, principal: { ...input.principal, servicePrincipal: signed.principal } }
      : { ...input, servicePrincipal: signed.principal }); }
    finally { instances.authority.release(signed.principal.instanceSession); }
  };
  const principal = { authorizationId: 'controlled', projectId, accountId, accountName: 'Alice', loginId: 'login-a', credentialId: 'credential-a', loginGeneration: 1 };
  const conversation = createConversationAuthority({ ledger, accountAuthority: { authorizePrincipal: async () => principal },
    checkConsent: async () => ({ accountId, accepted: true, noticeVersion: 1 }),
    verifySelectionSnapshot: async () => ({ projectId, accountId, pageId: 'page_a', selection: { clipIds: [] }, sentAt: 100, source: 'sent-snapshot' }),
    runHooks: run.hooks, onFence: async value => ({ ack: true, ...value }) });
  await conversation.send({ principalRef: { authorizationId: 'controlled' }, projectId, conversationId: 'conv_a', requestId: 'send-a', content: 'short task' });
  let finishes = 0;
  const client = { admit: input => invoke('admit', input), confirmRead: input => invoke('confirmRead', input), queryRead: input => invoke('queryRead', input),
    async checkAccess({ projectId: p, runGrantId, action }) {
      const principal = await invoke('resolveRunPrincipal', { projectId: p, runGrantId });
      return invoke('checkAccess', { principal, projectId: p, action });
    }, finish: input => { finishes++; return invoke('finish', input); }, pending: async () => ({ conversations: [] }) };
  const events = f.open({ failpoint, verifyGrant: g => client.checkAccess({ projectId: g.projectId, runGrantId: g.runGrantId, action: 'write' }) });
  const intents = openReadIntents({ file: path.join(path.dirname(f.file), 'intents.sqlite') });
  let manager;
  return { projectId, ledger, events, intents, finishes: () => finishes,
    manager(runnerFactory) { return manager = createAccountRunManager({ runClient: client, readIntents: intents, runEvents: events,
      runnerFactory, serviceKid: 'kid-a', instanceId: processInstance.registration.instanceId }); },
    async close() { manager?.close(); await events.close(); intents.close(); instances.close(); ledger.close(); f.cleanup(); } };
}

test('real doc read/run bindings reach durable run/tool/model events, but no inferred successful finish', async () => {
  const f = await managerFixture(); let models = 0, tools = 0, drains = 0;
  try {
    const manager = f.manager(async ({ onEvent, onModelCall, beforeToolCall }) => ({
      async start() {
        onEvent({ type: 'run' }); await onModelCall(); models++;
        onEvent({ type: 'tool_call', name: 'get_project' }); await beforeToolCall(); tools++;
        onEvent({ type: 'tool_result', output: 'project-private-output' });
        onEvent({ type: 'done', completed: true });
        return { done: Promise.resolve(), abort() {} };
      }, async drain() { drains++; }, close() {} }));
    await assert.rejects(manager.wake(f.projectId, 'conv_a'), { code: 'run-outcome-unavailable' });
    assert.equal(models, 1); assert.equal(tools, 1); assert.equal(drains, 1); assert.equal(f.finishes(), 0);
    const list = f.events.after({ projectId: f.projectId, conversationId: 'conv_a', after: 0 });
    assert.deepEqual(list.events.map(e => e.event.type), ['run', 'tool_call', 'tool_result', 'runner_done']);
    assert.equal(list.events[3].event.settlement, 'pending');
    assert.equal(f.intents.pending()[0].state, 'execution-started');
    await assert.rejects(manager.wake(f.projectId, 'conv_a'), { code: 'run-execution-uncertain' });
    assert.equal(models, 1); assert.equal(f.finishes(), 0);
  } finally { await f.close(); }
});

test('append failure aborts actual runner handle, waits owned drain, and blocks next model/tool/finish', async () => {
  const f = await managerFixture(point => { if (point === 'event-before-commit') throw new Error('real-sqlite-commit-failure'); });
  let models = 0, tools = 0, aborted = 0, releaseDrain, drained = false;
  const drainGate = new Promise(resolve => { releaseDrain = resolve; });
  const unhandled = []; const capture = e => unhandled.push(e); process.on('unhandledRejection', capture);
  try {
    const manager = f.manager(async ({ onEvent, onModelCall, beforeToolCall }) => ({
      start() {
        const done = (async () => {
          onEvent({ type: 'run' }); await onModelCall(); models++;
          await beforeToolCall(); tools++;
        })();
        return { done, abort() { aborted++; } };
      }, async drain() { await drainGate; drained = true; }, close() {} }));
    const wake = manager.wake(f.projectId, 'conv_a');
    const result = assert.rejects(wake, /real-sqlite-commit-failure/);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(drained, false); assert.equal(manager.describe().activeRuns, 1);
    releaseDrain(); await result;
    assert.equal(models, 0); assert.equal(tools, 0); assert.ok(aborted >= 1);
    assert.equal(f.finishes(), 0); assert.equal(drained, true);
    await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(unhandled, []);
  } finally { releaseDrain(); process.off('unhandledRejection', capture); await f.close(); }
});
