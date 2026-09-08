/**
 * node --test server/test/api-retry-wiring.test.mjs
 *
 * 重试**接进 runners/api.mjs 了没有**。
 *
 * 单测 retry-fetch 模块本身是不够的:模块写对了、没接到 createProvider 的 fetchImpl 上,
 * 线上照样一撞 429 就报错。所以这一条从 startRun 进去,数真正发出去了几次请求。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { startRun } = await import('../runners/api.mjs');

/** 一段最小的、能让 provider 正常收尾的 SSE */
function okStream(text) {
  const chunks = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n',
  ];
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'text/event-stream' },
    body: (async function* () { for (const c of chunks) yield c; })(),
  };
}

function errResponse(status) {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify({ error: { message: 'Current group upstream load is saturated' } }),
  };
}

/** 跑一次对话,返回 { events, calls } */
function run({ fetchImpl }) {
  const events = [];
  return new Promise((resolve) => {
    const r = startRun({
      prompt: '你好',
      systemPrompt: '',
      apiConfig: { vendor: 'openai', apiKey: 'sk-test', model: 'm', baseUrl: 'https://relay.example/v1', maxTokens: 64 },
      sessionId: `retrytest-${Math.random().toString(36).slice(2, 8)}`,
      callTool: async () => ({ ok: true }),
      fetchImpl,
      onEvent: (ev) => {
        events.push(ev);
        if (ev.type === 'done' || ev.type === 'error') setTimeout(() => resolve(events), 10);
      },
    });
    // 兜底:万一没有 done/error 也别把测试挂死
    (r?.done ?? Promise.resolve()).finally?.(() => setTimeout(() => resolve(events), 50));
  });
}

test('429 之后自动重试,最终把回复交出来 —— 用户撞到的就是这一个', async () => {
  let n = 0;
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push(url);
    // 前两次上游拥挤,第三次正常
    return n++ < 2 ? errResponse(429) : okStream('好的');
  };
  const events = await run({ fetchImpl });
  const err = events.find((e) => e.type === 'error');
  assert.equal(err, undefined, `不该报错,实际: ${err?.message}`);
  assert.ok(seen.length >= 3, `该重试到成功为止,实际只发了 ${seen.length} 次`);
  const text = events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
  assert.match(text, /好的/);
});

test('401 不重试:只发一次,并且如实报错', async () => {
  let n = 0;
  const fetchImpl = async () => { n++; return { ok: false, status: 401, headers: { get: () => null }, text: async () => JSON.stringify({ error: { message: 'invalid api key' } }) }; };
  const events = await run({ fetchImpl });
  assert.equal(n, 1, `401 该一次就停,实际发了 ${n} 次`);
  assert.ok(events.some((e) => e.type === 'error'), '应该有 error 事件');
});
