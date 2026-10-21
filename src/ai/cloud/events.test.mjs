import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCloudEvent, applyCloudEvents, hasOpenRun, queueSnapshot, settleFromQueue } from './events.ts';

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
  assert.deepEqual(applyCloudEvents([], [{ ...accepted, seq: 0, runId: 'run_a' }]), []);
  assert.deepEqual(applyCloudEvents([], [{ ...accepted, senderNameAtSend: undefined, runId: 'run_a' }]), []);
});

test('account runner_done, raw done/end and model error do not claim settled success', () => {
  const initial = applyCloudEvents([], [accepted, event('run', 2), event('text', 3, { delta: 'Result' })]);
  for (const type of ['runner_done', 'done', 'end']) {
    const messages = applyCloudEvent(initial, event(type, 4, { settlement: 'pending' }));
    assert.equal(messages[1].pending, true);
    assert.equal(messages[1].outcome, undefined);
    assert.equal(messages[1].finishedAt, undefined);
    assert.equal(messages[1].statuses.at(-1), '执行已结束，等待云端确认关闭与结算。');
    assert.equal(messages[1].progress.text, '执行已结束，等待云端确认关闭与结算。');
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

const snapshot = (items, currentRunId = null, queueRevision = 5) => queueSnapshot({ type: 'queue.state', conversationId: 'conversation_a',
  queueRevision, aclRevision: 1, currentRunId, items: items.map((item, index) => ({ messageId: `message_${index}`, arrivalSeq: index + 1,
    position: null, runId: 'run_a', ...item })) }, 'conversation_a');

test('queue settlement closes the pending run: done → completed, timer stops, waiting text replaced', () => {
  const waiting = applyCloudEvents([], [accepted, event('run', 2), event('text', 3, { delta: 'Result' }), event('runner_done', 4, { settlement: 'pending' })]);
  assert.equal(waiting[1].pending, true);
  const settled = settleFromQueue(waiting, snapshot([{ state: 'done', outcome: { status: 'done', reason: null } }]));
  assert.equal(settled[1].pending, false);
  assert.equal(settled[1].outcome, 'completed');
  assert.equal(typeof settled[1].finishedAt, 'number');
  assert.equal(settled[1].cloudSettlement, undefined);
  assert.notEqual(settled[1].progress.text, '执行已结束，等待云端确认关闭与结算。');
  assert.equal(hasOpenRun(settled), false);
  assert.equal(settleFromQueue(settled, snapshot([{ state: 'done', outcome: { status: 'done', reason: null } }])), settled, '再折一次不变');
});

test('queue settlement: failed shows an error the user can read; cancelled is a stop; model error text is kept', () => {
  const waiting = applyCloudEvents([], [accepted, event('run', 2), event('runner_done', 3, { settlement: 'pending' })]);
  const failed = settleFromQueue(waiting, snapshot([{ state: 'cancelled', outcome: { status: 'failed', reason: 'worker-failed' } }]));
  assert.equal(failed[1].pending, false); assert.equal(failed[1].outcome, 'error'); assert.match(failed[1].error, /进程出了故障/);
  const stopped = settleFromQueue(waiting, snapshot([{ state: 'cancelled', outcome: { status: 'cancelled', reason: 'stopped' } }]));
  assert.equal(stopped[1].outcome, 'aborted');
  const withModelError = applyCloudEvent(waiting, event('error', 4, { code: 'model', message: '模型的回复连续 3 次超过单次输出上限被截断' }));
  const closed = settleFromQueue(withModelError, snapshot([{ state: 'cancelled', outcome: { status: 'failed', reason: 'runner-error' } }]));
  assert.equal(closed[1].outcome, 'error'); assert.match(closed[1].error, /超过单次输出上限/);
  const old = settleFromQueue(waiting, snapshot([{ state: 'done' }]));
  assert.equal(old[1].outcome, 'completed', '旧服务端没带终态:按队列状态收');
});

test('queue settlement leaves running / queued / current runs and other runs alone', () => {
  const waiting = applyCloudEvents([], [accepted, event('run', 2), event('runner_done', 3, { settlement: 'pending' })]);
  assert.equal(settleFromQueue(waiting, snapshot([{ state: 'running' }])), waiting);
  assert.equal(settleFromQueue(waiting, snapshot([{ state: 'done' }], 'run_a')), waiting, '还是当前这一轮:不收');
  assert.equal(settleFromQueue(waiting, snapshot([{ state: 'done', runId: 'run_other' }])), waiting);
  assert.equal(settleFromQueue(waiting, null), waiting);
  const bad = snapshot([{ state: 'done', outcome: { status: 'DONE!!', reason: '<script>' } }]);
  assert.equal(bad.items[0].outcome, null, '形状不对的终态丢掉');
});

test('a run that failed before its first event: a failed assistant reply is added after the user message with the reason', () => {
  // 2026-10-19 在线实测：服务端账本记了 failed / worker-failed，queue.state 也送到了页面，流里却没有这一轮的任何事件，页面什么都不显示
  const onlyUser = applyCloudEvents([], [accepted, { ...accepted, seq: 2, messageId: 'message_b', prompt: 'later one' }]);
  const dead = snapshot([{ messageId: 'message_a', state: 'cancelled', outcome: { status: 'failed', reason: 'worker-failed' } },
    { messageId: 'message_b', state: 'queued', position: 1, runId: null }]);
  const shown = settleFromQueue(onlyUser, dead);
  assert.deepEqual(shown.map(m => m.id), ['cq-message_a', 'ca-run_a', 'cq-message_b'], '失败的回复紧跟在它那条用户消息后面');
  assert.equal(shown[1].role, 'assistant'); assert.equal(shown[1].pending, false); assert.equal(shown[1].outcome, 'error');
  assert.match(shown[1].error, /进程出了故障/);
  assert.equal(hasOpenRun(shown), false);
  assert.equal(settleFromQueue(shown, dead), shown, '再折一次不变，不叠第二条');
  // 没领到运行号就中断的：用消息号起一个号
  const interrupted = settleFromQueue(onlyUser, snapshot([{ messageId: 'message_a', state: 'cancelled', runId: null, outcome: { status: 'interrupted', reason: 'agent-restart' } }]));
  assert.equal(interrupted[1].id, 'ca-q-message_a'); assert.equal(interrupted[1].outcome, 'error');
  // 停止、完成、没有终态的、找不到用户消息的：不补
  assert.equal(settleFromQueue(onlyUser, snapshot([{ messageId: 'message_a', state: 'cancelled', outcome: { status: 'cancelled', reason: 'stopped' } }])), onlyUser);
  assert.equal(settleFromQueue(onlyUser, snapshot([{ messageId: 'message_a', state: 'done', outcome: { status: 'done', reason: null } }])), onlyUser);
  assert.equal(settleFromQueue(onlyUser, snapshot([{ messageId: 'message_a', state: 'cancelled' }])), onlyUser);
  assert.equal(settleFromQueue([], dead).length, 0, '用户消息还没到：先不补，到了再补');
  // 用户消息后到：随后的那次折叠补上
  const late = settleFromQueue(applyCloudEvent([], accepted), dead);
  assert.equal(late[1].id, 'ca-run_a');
});

// ---- 出错留痕:模型第一次请求就失败(节点上的真实事件行,2026-10-21 额度不足) ----
import { friendlyErrorMessage, shortReason, cloudErrorMessage } from './events.ts';

const QUOTA_RAW = 'openai HTTP 403: token quota is not enough, token remain quota: ＄0.124114, need quota: ＄0.127928 (request id: 20261021050740667659703KtlPNKvH)';
// 形状取自 master-run-events.sqlite 的 run_8b0457ac(seq 211～218):页面事件流写出的是 {...row.event, projectId, conversationId, seq}
const realBinding = { projectId: 'sp_pqqwrqehp6yw34mextkkc24vwv', conversationId: 'cc-mvfw3j7c-eqwh',
  messageId: '603fe67e-dce3-4839-9b85-810c58ff51ef', senderAccountId: 'acc_f17cf0ab2b14547df056b54f',
  runId: 'run_8b0457ac-10ef-46be-83c1-846066ed5574', runGrantId: 'grant_cd6ef6c3-10f2-4ace-918e-c069c5345ff3',
  instanceId: '273d3438-c1c1-4864-8b5a-59677796f532', instanceGeneration: 76, serviceKid: '_yTY0wwd' };
const realRun = [
  { type: 'user', seq: 211, projectId: realBinding.projectId, conversationId: realBinding.conversationId, messageId: realBinding.messageId,
    prompt: '请把剪辑2里那张粒子背景卡的粒子颜色改成淡蓝色,其它不动。', senderAccountId: realBinding.senderAccountId, senderNameAtSend: '9tian', arrivalSeq: 267, attachments: [] },
  { type: 'run', seq: 212, ...realBinding },
  { type: 'session', seq: 213, ...realBinding, sessionId: 'account-v2-cc-mvfw3j7c-eqwh' },
  { type: 'diagnostic', seq: 214, ...realBinding, stage: 'request', data: { deepAuto: false, effort: 'high', maxRounds: 24, model: 'claude-opus-5-5', vendor: 'openai' } },
  { type: 'progress', seq: 215, ...realBinding, phase: 'requesting', round: 1, maxRounds: 24, completed: 0, failed: 0, elapsedMs: 0, text: '第 1/24 轮：正在等待模型响应…' },
  { type: 'diagnostic', seq: 216, ...realBinding, stage: 'request', data: { messages: 33, round: 1, summaryOnly: false, tools: 130 } },
  { type: 'error', seq: 217, ...realBinding, message: QUOTA_RAW },
  { type: 'runner_done', seq: 218, ...realBinding, outcome: 'failed', settlement: 'pending' },
];
const failedQueue = (state = 'done') => queueSnapshot({ type: 'queue.state', conversationId: realBinding.conversationId, queueRevision: 9, aclRevision: 1,
  currentRunId: null, items: [{ messageId: realBinding.messageId, arrivalSeq: 267, position: null, runId: realBinding.runId, state,
    outcome: { status: 'failed', reason: null } }] }, realBinding.conversationId);

test('真实事件行:额度不足的一轮折出人话原因,结清后失败收尾,原文(金额、请求号)不外露', () => {
  const folded = applyCloudEvents([], realRun);
  const waiting = folded[1];
  assert.equal(waiting.error, '模型服务的额度不够,这一轮没有执行(需要托管方充值)。已经落地的改动保留在项目里。');
  const settled = settleFromQueue(folded, failedQueue())[1];
  assert.equal(settled.pending, false);
  assert.equal(settled.outcome, 'error');
  assert.match(settled.error, /额度不够/);
  assert.match(settled.error, /托管方充值/);
  assert.doesNotMatch(settled.error, /0\.12|request id|openai|HTTP/i);
  assert.equal(settled.text, '');
  assert.equal(settled.tools.length, 0);
});

test('真实事件行:同一份事件重放两遍结果相同', () => {
  const once = settleFromQueue(applyCloudEvents([], realRun), failedQueue());
  const twice = settleFromQueue(applyCloudEvents(once, realRun), failedQueue());
  assert.equal(twice[1].error, once[1].error);
  assert.equal(twice.length, 2);
});

test('失败的一轮没有 error 事件时(只有队列里的终态),也要写出失败而不是「服务中断」', () => {
  const noError = realRun.filter(e => e.type !== 'error');
  const settled = settleFromQueue(applyCloudEvents([], noError), failedQueue())[1];
  assert.equal(settled.outcome, 'error');
  assert.match(settled.error, /执行失败/);
  assert.doesNotMatch(settled.error, /服务中断/);
});

test('friendlyErrorMessage:各类模型错误说人话,不外露密钥与请求号', () => {
  assert.match(friendlyErrorMessage(QUOTA_RAW), /额度不够.*托管方充值/);
  assert.match(friendlyErrorMessage('openai HTTP 402: insufficient_balance'), /额度不够/);
  assert.match(friendlyErrorMessage('openai HTTP 401: Incorrect API key provided: sk-abcdefghijklmnop1234'), /拒绝了云端 Agent 的凭证/);
  assert.doesNotMatch(friendlyErrorMessage('openai HTTP 401: Incorrect API key provided: sk-abcdefghijklmnop1234'), /sk-/);
  assert.match(friendlyErrorMessage('openai HTTP 429: rate limit reached'), /太忙/);
  assert.match(friendlyErrorMessage('openai HTTP 503: upstream down'), /HTTP 503.*稍后再试/);
  assert.match(friendlyErrorMessage('fetch failed: ECONNRESET'), /连不上模型服务/);
  const odd = friendlyErrorMessage('openai HTTP 400: bad request: messages[3].content must be a string (request id: abcdef0123456789abcdef0123456789abcd)');
  assert.match(odd, /^模型调用失败\(HTTP 400\)/);
  assert.doesNotMatch(odd, /abcdef0123456789/);
  assert.ok(odd.length < 120);
  assert.match(friendlyErrorMessage('something broke'), /^云端 Agent 出错了:something broke$/);
  assert.equal(friendlyErrorMessage('云端 Agent 服务中断,这一轮没有做完。'), '云端 Agent 服务中断,这一轮没有做完。');
  assert.equal(cloudErrorMessage('model'), '模型调用失败。');
  assert.equal(shortReason('Bearer abc.def-ghi token https://x.y/z  end'), 'token end');
});

test('已有行为不变:正常轮收尾、第一个事件之前就失败的轮(补位)', () => {
  const ok = settleFromQueue(applyCloudEvents([], [accepted, event('run', 2), event('text', 3, { delta: 'Result' }), event('runner_done', 4, { settlement: 'pending' })]),
    snapshot([{ state: 'done', outcome: { status: 'done', reason: null } }]));
  assert.equal(ok[1].outcome, 'completed');
  assert.equal(ok[1].error, undefined);
  const early = settleFromQueue(applyCloudEvents([], [accepted]), snapshot([{ state: 'done', messageId: 'message_a', outcome: { status: 'failed', reason: 'worker-failed' } }]));
  assert.equal(early.length, 2);
  assert.match(early[1].error, /进程出了故障/);
});

// ---- 出错留痕(探针 E1～E3):账号模式下原因要写进对话 ----
test('E1 没带 code 的 error 是模型调用失败:写「模型调用失败:原因」,中文原因保留', () => {
  assert.equal(cloudErrorMessage(undefined, '上游接口 500(探针注入)'), '模型调用失败:上游接口 500(探针注入)');
  assert.equal(cloudErrorMessage('model', '上游接口 500'), '模型调用失败:上游接口 500');
  // 已经以「模型」开头的话不再叠一层
  assert.equal(cloudErrorMessage(undefined, '模型服务暂时不可用'), '模型服务暂时不可用');
  // 英文原因同样带前缀(没有更具体的分类时)
  assert.equal(cloudErrorMessage(undefined, 'unexpected token in JSON'), '模型调用失败:unexpected token in JSON');
  // 网关额度不足仍是原来那句(托管方充值)
  assert.match(cloudErrorMessage(undefined, QUOTA_RAW), /额度不够.*托管方充值/);
  const folded = applyCloudEvents([], [accepted, event('run', 2), event('error', 3, { message: '上游接口 500(探针注入)' }), event('runner_done', 4, { outcome: 'failed', settlement: 'pending' })]);
  const settled = settleFromQueue(folded, snapshot([{ state: 'done', outcome: { status: 'failed', reason: null } }]))[1];
  assert.equal(settled.outcome, 'error');
  assert.match(settled.error, /^模型调用失败:上游接口 500/);
});

test('E2 项目额度用尽(带 code):服务端写的「已用 N / 上限 M」原样显示,不加「模型调用失败」前缀', () => {
  const said = '这个项目的云端 Agent 额度已用完(已用 1234 / 上限 1000)。请联系托管方。';
  assert.equal(cloudErrorMessage('quota-exceeded', said), said);
  const folded = applyCloudEvents([], [accepted, event('run', 2), event('error', 3, { code: 'quota-exceeded', message: said }), event('runner_done', 4, { outcome: 'failed', settlement: 'pending' })]);
  assert.match(folded[1].error, /额度已用完\(已用 \d+ \/ 上限 \d+\)/);
  // 只有代号没有话:仍有兜底句
  assert.equal(cloudErrorMessage('quota-exceeded'), '云端 Agent 的额度已用完。');
});

test('E3 创建者关了开关:gate 的话带 code=disabled 原样显示;只有账本强制终态(没有 error 事件)时也写出原因', () => {
  assert.equal(cloudErrorMessage('disabled', '项目创建者已关闭云端 Agent。'), '项目创建者已关闭云端 Agent。');
  const running = applyCloudEvents([], [accepted, event('run', 2), event('text', 3, { delta: '写了一半' })]);
  const stopped = settleFromQueue(running, snapshot([{ state: 'cancelled', outcome: { status: 'interrupted', reason: 'agent-disabled' } }]))[1];
  assert.equal(stopped.pending, false);
  assert.equal(stopped.outcome, 'error');
  assert.match(stopped.error, /已关闭云端 Agent/);
  const removed = settleFromQueue(running, snapshot([{ state: 'cancelled', outcome: { status: 'interrupted', reason: 'member-revoked' } }]))[1];
  assert.match(removed.error, /不在这个项目/);
  // 已有 error 事件写过原因就以它为准
  const withError = applyCloudEvents([], [accepted, event('run', 2), event('error', 3, { code: 'disabled', message: '项目创建者已关闭云端 Agent。' })]);
  const kept = settleFromQueue(withError, snapshot([{ state: 'cancelled', outcome: { status: 'interrupted', reason: 'agent-disabled' } }]))[1];
  assert.equal(kept.error, '项目创建者已关闭云端 Agent。');
});
