import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCloudEvent, applyCloudEvents, hasOpenRun } from './events.ts';

const accepted = { type: 'user', seq: 1, projectId: 'project_a', conversationId: 'conversation_a',
  messageId: 'message_a', senderAccountId: 'account_a', senderNameAtSend: 'Sender A', prompt: 'Original accepted message' };
const binding = { projectId: accepted.projectId, conversationId: accepted.conversationId, messageId: accepted.messageId,
  senderAccountId: accepted.senderAccountId, runId: 'run_a', runGrantId: 'grant_a', instanceId: 'instance_a',
  instanceGeneration: 1, serviceKid: 'kid_a' };
const event = (type, seq, extra = {}) => ({ type, seq, ...binding, ...extra });

test('durable account run pairs one assistant with its accepted user and preserves exact sender binding', () => {
  const messages = applyCloudEvents([], [accepted, { ...accepted, seq: 2, messageId: 'message_b', prompt: 'Queued second message' }, event('run', 3)]);
  assert.deepEqual(messages.map(m => m.id), ['cq-message_a', 'ca-run_a', 'cq-message_b']);
  assert.deepEqual(messages[1].cloudRun, binding);
  assert.equal(messages[1].cloudAcceptedMessageId, 'cq-message_a');
  assert.equal(hasOpenRun(messages), true);
});

test('replay never resets text, tools or pending assistant and same run cannot change its binding', () => {
  const stream = [accepted, event('run', 2), event('text', 3, { delta: 'Durable output' }),
    event('tool_call', 4, { name: 'get_project', callId: 'call_a' }),
    event('tool_result', 5, { name: 'get_project', callId: 'call_a', ok: true, summary: 'Read project' })];
  const messages = applyCloudEvents([], stream);
  assert.equal(messages[1].text, 'Durable output');
  assert.equal(messages[1].tools[0].ok, true);
  assert.equal(applyCloudEvents(messages, stream), messages);
  assert.equal(applyCloudEvent(messages, event('run', 6, { instanceId: 'instance_b' })), messages);
});

test('unbound account run/text never borrows last assistant, or an unrelated accepted sender', () => {
  const messages = applyCloudEvents([], [accepted, event('run', 2)]);
  for (const changed of [{ senderAccountId: 'other' }, { projectId: 'other' }, { conversationId: 'other' },
    { messageId: 'other' }, { runGrantId: 'other' }, { instanceId: 'other' }, { instanceGeneration: 2 },
    { serviceKid: 'other' }, { runId: 'other' }, { seq: 0 }, { seq: undefined }, { instanceId: undefined }]) {
    assert.equal(applyCloudEvent(messages, event('text', 3, { delta: 'Wrong scope', ...changed })), messages);
  }
  assert.deepEqual(applyCloudEvents([], [event('run', 2)]), []);
  assert.equal(applyCloudEvent(applyCloudEvents([], [accepted]), event('run', 2, { senderAccountId: 'other' })).length, 1);
  assert.equal(applyCloudEvent(messages, { type: 'text', seq: 3, runId: 'run_a', delta: 'Missing binding' }), messages);
});

test('account runner_done, raw done/end and model error do not claim settled success', () => {
  const initial = applyCloudEvents([], [accepted, event('run', 2), event('text', 3, { delta: 'Result' })]);
  for (const type of ['runner_done', 'done', 'end']) {
    const messages = applyCloudEvent(initial, event(type, 4, { settlement: 'pending' }));
    assert.equal(messages[1].pending, true);
    assert.equal(messages[1].outcome, undefined);
    assert.equal(messages[1].finishedAt, undefined);
    assert.equal(messages[1].statuses.at(-1), '执行已结束，等待云端确认关闭与结算。');
    assert.equal(applyCloudEvent(messages, event('runner_done', 5, { settlement: 'pending' })).length, 2);
    assert.equal(applyCloudEvent(messages, event('runner_done', 5, { settlement: 'pending' }))[1].statuses.length, 1);
  }
  const failed = applyCloudEvent(initial, event('error', 4, { code: 'model' }));
  assert.equal(failed[1].error, '模型调用失败。');
  assert.equal(failed[1].pending, true);
  assert.equal(failed[1].outcome, undefined);
});

test('legacy user/run sequence retains its existing completion behavior', () => {
  const messages = applyCloudEvents([], [{ type: 'user', runId: 'legacy', prompt: 'LAN', seq: 1 },
    { type: 'text', runId: 'legacy', delta: 'LAN output', seq: 2 }, { type: 'done', runId: 'legacy', seq: 3 }]);
  assert.equal(messages[1].text, 'LAN output');
  assert.equal(messages[1].pending, false);
  assert.equal(messages[1].outcome, 'completed');
});
