/**
 * node --test server/test/openai-effort-tools.test.mjs
 *
 * 有些模型不接受 reasoning_effort 和 function tools 同时出现,直接 400:
 *
 *   Function tools with reasoning_effort are not supported for gpt-5.6-terra in
 *   /v1/chat/completions. To use function tools, use /v1/responses or set
 *   reasoning_effort to 'none'.
 *
 * 而这个应用每次请求都带着三十来个工具,所以只要给这类模型选了思考档,就是条条大路都 400,
 * 用户看到的是「对话一发就红」。通用重试层不该管这个(400 重发一百次也一样),
 * 要做的是**改请求再发一次**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createProvider } = await import('../harness/providers/openai.mjs');

const REJECT = JSON.stringify({
  error: {
    message: "Function tools with reasoning_effort are not supported for gpt-5.6-terra in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.",
  },
});

function okStream(text = '好的') {
  return {
    ok: true, status: 200,
    headers: { get: () => 'text/event-stream' },
    body: (async function* () {
      yield `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
      yield `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`;
      yield 'data: [DONE]\n\n';
    })(),
  };
}

function errRes(status, payload) {
  return { ok: false, status, headers: { get: () => null }, text: async () => payload };
}

const TOOLS = [{ name: 'get_project', description: 'x', inputSchema: { type: 'object', properties: {} } }];

/** 跑一次;返回每次请求发出去的 body(已解析)和收到的正文 */
async function run({ model = 'gpt-5.6-terra', effort = 'high', tools = TOOLS, responses }) {
  const sent = [];
  let n = 0;
  const fetchImpl = async (url, init) => {
    sent.push(JSON.parse(init.body));
    const r = responses[Math.min(n, responses.length - 1)];
    n++;
    return typeof r === 'function' ? r() : r;
  };
  const p = createProvider(
    { apiKey: 'k', model, effort, baseUrl: 'https://relay.example/v1' },
    { fetchImpl },
  );
  let text = '';
  for await (const ev of p.stream([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools, '', undefined)) {
    if (ev.type === 'text_delta') text += ev.text;
  }
  return { sent, text };
}

test('撞上这条 400:去掉 reasoning_effort 重发一次,对话照常进行', async () => {
  const { sent, text } = await run({
    model: 'm-reject-1',
    responses: [errRes(400, REJECT), okStream('好的')],
  });
  assert.equal(sent.length, 2, '应该重发了一次');
  assert.equal(sent[0].reasoning_effort, 'high', '第一次照常带上思考档');
  assert.equal('reasoning_effort' in sent[1], false, '重发那次必须把它去掉');
  assert.ok(sent[1].tools?.length, '工具还要在 —— 我们让步的是思考档,不是工具');
  assert.equal(text, '好的');
});

test('记住了:同一个模型下一轮直接不带,不再白撞一次 400', async () => {
  const model = 'm-reject-2';
  await run({ model, responses: [errRes(400, REJECT), okStream()] });
  const second = await run({ model, responses: [okStream('第二轮')] });
  assert.equal(second.sent.length, 1, '不该再撞一次');
  assert.equal('reasoning_effort' in second.sent[0], false);
});

test('别的 400 照常报错,不许悄悄重发', async () => {
  const bad = JSON.stringify({ error: { message: 'model not found' } });
  let calls = 0;
  const fetchImpl = async () => { calls++; return errRes(400, bad); };
  const p = createProvider(
    { apiKey: 'k', model: 'm-other-400', effort: 'high', baseUrl: 'https://relay.example/v1' },
    { fetchImpl },
  );
  await assert.rejects(
    async () => { for await (const _ of p.stream([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], TOOLS, '', undefined)) { /* drain */ } },
    /model not found/,
    '别的 400 的原文要原样透出来 —— 正文已经被读过一次,不能因此丢掉',
  );
  assert.equal(calls, 1, '不是那个原因就不该重发');
});

test('没选思考档时本来就不带,也就没有这一出', async () => {
  const { sent } = await run({ model: 'm-no-effort', effort: '', responses: [okStream()] });
  assert.equal(sent.length, 1);
  assert.equal('reasoning_effort' in sent[0], false);
});

test('没有工具时不做这个降级 —— 那种 400 是别的原因', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return errRes(400, REJECT); };
  const p = createProvider(
    { apiKey: 'k', model: 'm-no-tools', effort: 'high', baseUrl: 'https://relay.example/v1' },
    { fetchImpl },
  );
  await assert.rejects(async () => {
    for await (const _ of p.stream([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], [], '', undefined)) { /* drain */ }
  });
  assert.equal(calls, 1);
});
