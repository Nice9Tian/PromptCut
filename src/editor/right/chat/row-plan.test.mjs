import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCloudEvent, queueSnapshot, settleFromQueue } from '../../../ai/cloud/events.ts';
import { inboundPlan, promptOf, rowPlan } from './rowPlan.ts';

/*
 * 2026-10-20 生产复现(项目「验收018-Claude」、对话 cc-mvfhwi2p-xi4o)的同形事件:
 *   第一条消息在第一个事件前就失败(队列终态 failed / worker-failed,页面补一条失败回复);
 *   第二条只回了文字「好」、没交本轮小结;第三条有思考、工具和本轮小结。
 * 旧的 MessageList 在简洁模式下把没交小结的回复和后面几轮并成一个气泡:第二、三轮全画进了第一条的失败回复里。
 */
const C = 'conv_x', P = 'proj_x', A = 'acc_x';
const user = (seq, messageId, prompt) => ({ type: 'user', seq, projectId: P, conversationId: C, messageId, senderAccountId: A, senderNameAtSend: 'u', prompt });
const bind = (messageId, runId, n) => ({ projectId: P, conversationId: C, messageId, senderAccountId: A, runId, runGrantId: `grant_${n}`, instanceId: `inst_${n}`, instanceGeneration: n, serviceKid: 'kid' });
const ev = (b, type, seq, extra = {}) => ({ type, seq, ...b, ...extra });
const queue = (items, currentRunId = null) => queueSnapshot({ type: 'queue.state', conversationId: C, queueRevision: 9, aclRevision: 1, currentRunId,
  items: items.map(([messageId, arrivalSeq, state, runId, outcome]) => ({ messageId, arrivalSeq, state, position: null, runId, outcome })) }, C);

function fold(stream, snap) {
  let msgs = [];
  msgs = settleFromQueue(msgs, snap);
  for (const e of stream) msgs = settleFromQueue(applyCloudEvent(msgs, e), snap);
  return msgs;
}

const b2 = bind('m2', 'run_2', 2), b3 = bind('m3', 'run_3', 3);
const stream = [
  user(1, 'm1', '加一张标题卡'), user(2, 'm2', '只回复一个字：好'),
  ev(b2, 'run', 3), ev(b2, 'text', 4, { delta: '好' }), ev(b2, 'runner_done', 5),
  user(6, 'm3', '再加一张标题卡'),
  ev(b3, 'run', 7), ev(b3, 'thinking', 8, { delta: 'plan' }),
  ev(b3, 'tool_call', 9, { name: 'send_message', callId: 'k0', input: { to: 'user', text: '先看一下现有的卡' } }),
  ev(b3, 'tool_result', 10, { name: 'send_message', callId: 'k0', ok: true }),
  ev(b3, 'tool_call', 11, { name: 'list_cards', callId: 'k1', input: {} }), ev(b3, 'tool_result', 12, { name: 'list_cards', callId: 'k1', ok: true }),
  ev(b3, 'tool_call', 13, { name: 'add_clip', callId: 'k2', input: {} }), ev(b3, 'tool_result', 14, { name: 'add_clip', callId: 'k2', ok: true }),
  ev(b3, 'tool_call', 15, { name: 'report_progress', callId: 'k3', input: { final: true, done: ['加了标题卡'] } }),
  ev(b3, 'tool_result', 16, { name: 'report_progress', callId: 'k3', ok: true }), ev(b3, 'runner_done', 17),
];
const settled = queue([['m1', 1, 'cancelled', 'run_1', { status: 'failed', reason: 'worker-failed' }],
  ['m2', 2, 'done', 'run_2', { status: 'done' }], ['m3', 3, 'done', 'run_3', { status: 'done' }]]);

test('回归:前面有一条第一个事件前就失败的回复,之后每一轮仍各画各的气泡,紧跟在发起它的用户消息后面', () => {
  const msgs = fold(stream, settled);
  const rows = rowPlan(msgs);
  assert.deepEqual(rows.map(r => r.id), ['cq-m1', 'ca-run_1', 'cq-m2', 'ca-run_2', 'cq-m3', 'ca-run_3']);
  assert.ok(rows.every(r => r.kind === (r.id.startsWith('cq-') ? 'user' : 'assistant')));
  const byId = Object.fromEntries(msgs.map(m => [m.id, m]));
  assert.ok(byId['ca-run_1'].error, '补位的失败回复带着原因');
  assert.deepEqual((byId['ca-run_1'].parts ?? []).length, 0, '失败回复里没有别的轮次的内容');
  assert.deepEqual((byId['ca-run_3'].parts ?? []).filter(p => p.kind === 'tool').map(p => p.name), ['send_message', 'list_cards', 'add_clip', 'report_progress']);
  assert.equal(promptOf(msgs, 'ca-run_3')?.id, 'cq-m3');
  assert.equal(promptOf(msgs, 'ca-run_1')?.id, 'cq-m1');
});

test('第三轮还在跑时(队列里它是当前一轮):它的内容在第三条用户消息之后、自己的气泡里', () => {
  const live = queue([['m1', 1, 'cancelled', 'run_1', { status: 'failed', reason: 'worker-failed' }],
    ['m2', 2, 'done', 'run_2', { status: 'done' }], ['m3', 3, 'running', 'run_3', null]], 'run_3');
  const msgs = fold(stream.slice(0, 12), live);
  assert.deepEqual(rowPlan(msgs).map(r => r.id), ['cq-m1', 'ca-run_1', 'cq-m2', 'ca-run_2', 'cq-m3', 'ca-run_3']);
  assert.equal(msgs.find(m => m.id === 'ca-run_3').pending, true);
});

test('只装其他 Agent 消息的用户消息不画;挂到紧跟着的回复上,没有回复时留一行小字', () => {
  const msgs = [{ id: 'u1', role: 'user', text: 'hi' }, { id: 'u2', role: 'user', text: '', inbound: [{ from: 'cc-b', text: 'x' }] },
    { id: 'a1', role: 'assistant', text: '' }, { id: 'u3', role: 'user', text: '', inbound: [{ from: 'cc-b', text: 'y' }] }];
  const plan = inboundPlan(msgs);
  assert.deepEqual(rowPlan(msgs, plan), [{ id: 'u1', kind: 'user' }, { id: 'a1', kind: 'assistant' }, { id: 'u3', kind: 'note', count: 1 }]);
  assert.equal(plan.inboundFor.get('a1').list.length, 1);
  assert.equal(promptOf(msgs, 'a1', plan)?.id, 'u1');
});
