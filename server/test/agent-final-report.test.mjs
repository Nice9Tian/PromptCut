/**
 * 用户只看得到 report_progress 交的条目,文字回复不直接显示(product/agent.md「Agent 的文字回复不直接展示给用户」)。
 * 2026-10-19 生产实测:用户说「请只回复一个字：好」,模型只回了文字「好」、没交汇报,界面上是一个空气泡,
 * 刷新后历史里也是空的。收工时没交过收尾汇报,就按文字回复代交一份,不让这一轮看起来什么都没说。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent, reportItemsFromText } from '../harness/agent.mjs';

const REPORT = { name: 'report_progress', description: 'r', inputSchema: { type: 'object', properties: {} }, async execute(input) { return { ok: true, report: input }; } };
const NOOP = { name: 'noop', description: 'x', inputSchema: { type: 'object', properties: {} }, async execute() { return { ok: true }; } };
function scripted(rounds) {
  let n = 0; const seen = [];
  return { seen, get calls() { return n; }, provider: { name: 'fake', async *stream(messages) {
    seen.push(structuredClone(messages)); const r = rounds[n++] ?? rounds.at(-1);
    if (r.text) yield { type: 'text_delta', text: r.text };
    if (r.report) yield { type: 'tool_use', id: `c${n}`, name: 'report_progress', input: r.report };
    if (r.tool) yield { type: 'tool_use', id: `c${n}`, name: 'noop', input: {} };
    yield { type: 'stop', reason: r.stop ?? 'stop' };
  } } };
}
const reports = events => events.filter(e => e.type === 'tool_call' && e.name === 'report_progress');

test('只回文字、没交汇报:按文字回复代交一份收尾汇报(界面据此画出条目),不多一次模型请求,这一轮照常算完成', async () => {
  const s = scripted([{ text: '好' }]);
  const events = [];
  const out = await new Agent({ provider: s.provider, system: 's', tools: [REPORT], requireFinalReport: true, onEvent: e => events.push(e) }).run('请只回复一个字：好');
  assert.equal(out.outcome, 'completed'); assert.equal(s.calls, 1);
  const [auto] = reports(events);
  assert.ok(auto?.synthetic, '代交的那一份要标出来');
  assert.equal(auto.input.final, true); assert.deepEqual(auto.input.done, ['好']);
  assert.deepEqual(auto.input.problems, [], '普通代交不加「问题」:用户只问了一句话');
  assert.equal(auto.input.has_problem, false);
  assert.ok(events.some(e => e.type === 'tool_result' && e.callId === auto.callId && e.ok === true));
  assert.equal(JSON.stringify(out.history.get()).includes('auto-report'), false, '代交只给屏幕,不进模型历史');
});

test('自己交过收尾汇报再说话:不代交', async () => {
  const s = scripted([{ report: { final: true, done: ['好'] }, stop: 'tool_use' }, { text: '好' }]);
  const events = [];
  await new Agent({ provider: s.provider, system: 's', tools: [REPORT], requireFinalReport: true, onEvent: e => events.push(e) }).run('好');
  assert.equal(s.calls, 2); assert.deepEqual(reports(events).map(e => !!e.synthetic), [false]);
});

test('只交过阶段汇报(final 为 false):收工时仍代交收尾那一份', async () => {
  const s = scripted([{ report: { final: false, done: ['铺好字幕'] }, stop: 'tool_use' }, { text: '都做完了' }]);
  const events = [];
  await new Agent({ provider: s.provider, system: 's', tools: [REPORT], requireFinalReport: true, onEvent: e => events.push(e) }).run('做');
  assert.deepEqual(reports(events).map(e => !!e.synthetic), [false, true]);
});

test('工具做完、交了收尾汇报,最后一次没说话:不报「API 没有返回文字」,不代交', async () => {
  const s = scripted([{ tool: true, stop: 'tool_use' }, { report: { final: true, done: ['加了一张标题卡'] }, stop: 'tool_use' }, { text: '' }]);
  const events = [];
  const out = await new Agent({ provider: s.provider, system: 's', tools: [REPORT, NOOP], requireFinalReport: true, onEvent: e => events.push(e) }).run('加卡');
  assert.equal(out.outcome, 'completed'); assert.equal(s.calls, 3); assert.equal(reports(events).length, 1);
});

test('真的什么都没回(没有文字、没有工具、没交过汇报):照旧以错误结束,用户看得到原因', async () => {
  const s = scripted([{ text: '' }]);
  await assert.rejects(new Agent({ provider: s.provider, system: 's', tools: [REPORT], requireFinalReport: true, onEvent: () => {} }).run('做'),
    /API 没有返回文字或工具调用/);
  assert.equal(s.calls, 1);
});

test('最后一轮(轮数到顶)照样代交', async () => {
  const s = scripted([{ tool: true, stop: 'tool_use' }, { text: '做完了' }]);
  const events = [];
  await new Agent({ provider: s.provider, system: 's', tools: [REPORT, NOOP], requireFinalReport: true, maxIterations: 2, onEvent: e => events.push(e) }).run('做');
  assert.equal(s.calls, 2); assert.ok(reports(events)[0]?.synthetic);
});

test('轮数到顶的收尾摘要(不给工具,模型交不了汇报):按摘要代交,停下的原因写进问题', async () => {
  const s = scripted([{ tool: true, stop: 'tool_use' }, { text: '已完成一半' }]);
  const events = [];
  const out = await new Agent({ provider: s.provider, system: 's', tools: [REPORT, NOOP], requireFinalReport: true, maxIterations: 1, onEvent: e => events.push(e) }).run('做');
  assert.equal(out.outcome, 'round_limit');
  const [auto] = reports(events);
  assert.ok(auto?.synthetic); assert.deepEqual(auto.input.done, ['已完成一半']); assert.equal(auto.input.problems.length, 1); assert.match(auto.input.problems[0], /轮模型往返上限/);
  assert.equal(auto.input.has_problem, true);
});

test('没打开这一项(环路里的角色、旧调用方):行为不变,一次收尾,不代交', async () => {
  const s = scripted([{ text: '好' }]);
  const events = [];
  await new Agent({ provider: s.provider, system: 's', tools: [REPORT], onEvent: e => events.push(e) }).run('好');
  assert.equal(s.calls, 1); assert.equal(reports(events).length, 0);
});

test('文字切成汇报条目:按行按句、去列表符号、每条不超过 60 字、最多 8 条', () => {
  assert.deepEqual(reportItemsFromText('- 加了一张卡。\n- **时长** 5 秒；放在开头'), ['加了一张卡。', '时长 5 秒；', '放在开头']);
  const many = reportItemsFromText(Array.from({ length: 20 }, (_, i) => `第${i}条`).join('\n'));
  assert.equal(many.length, 8); assert.match(many.at(-1), /原话较长/);
  assert.ok(reportItemsFromText('字'.repeat(130)).every(item => Array.from(item).length <= 60));
});
