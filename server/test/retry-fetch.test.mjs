// node --test server/test/retry-fetch.test.mjs —— API 直连的自动重试
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createRetryingFetch, RETRYABLE_STATUS, backoffMs, DEFAULT_RETRY } =
  await import('../harness/retry-fetch.mjs');

/** 假响应。headers.get 只认 retry-after */
function res(status, { retryAfter } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => (k.toLowerCase() === 'retry-after' ? (retryAfter ?? null) : null) },
    text: async () => '',
  };
}

/** 按剧本依次返回;数字 = 状态码,Error 实例 = 抛出去 */
function scripted(seq) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const step = seq[Math.min(calls.length, seq.length - 1)];
    calls.push({ url, init });
    if (step instanceof Error) throw step;
    return res(step);
  };
  return { fetchImpl, calls };
}

/** 不真的睡:把等待时间记下来 */
function noSleep() {
  const waits = [];
  return { waits, opts: { rand: () => 0.5, onRetry: (i) => waits.push(i.delayMs) } };
}

test('文档里那几个码才重试:408/429/500/502/503/504', () => {
  assert.deepEqual([...RETRYABLE_STATUS].sort((a, b) => a - b), [408, 429, 500, 502, 503, 504]);
  for (const s of [400, 401, 403, 404, 200, 201]) {
    assert.ok(!RETRYABLE_STATUS.has(s), `${s} 不该重试`);
  }
});

test('429 之后重试,成功就返回成功那次 —— 用户报的正是这一个', async () => {
  const { fetchImpl, calls } = scripted([429, 429, 200]);
  const { waits, opts } = noSleep();
  const f = createRetryingFetch(fetchImpl, { ...opts, baseDelayMs: 1, maxDelayMs: 2 });
  const r = await f('u', {});
  assert.equal(r.status, 200);
  assert.equal(calls.length, 3, '第一次 + 两次重试');
  assert.equal(waits.length, 2);
});

test('401 / 400 这种立刻返回,一次都不重试 —— 再发一百次也是同一个结果', async () => {
  for (const code of [400, 401, 403, 404]) {
    const { fetchImpl, calls } = scripted([code]);
    const f = createRetryingFetch(fetchImpl, { baseDelayMs: 1 });
    const r = await f('u', {});
    assert.equal(r.status, code);
    assert.equal(calls.length, 1, `${code} 不该重试`);
  }
});

test('一直 429:重试满 10 次就把最后那个响应交上去,由上层报错', async () => {
  const { fetchImpl, calls } = scripted([429]);
  const { opts } = noSleep();
  const f = createRetryingFetch(fetchImpl, { ...opts, baseDelayMs: 1, maxDelayMs: 2 });
  const r = await f('u', {});
  assert.equal(r.status, 429);
  assert.equal(calls.length, 1 + DEFAULT_RETRY.maxRetries, '一共 11 次尝试');
});

test('网络异常也重试;但 AbortError 立刻抛出 —— 用户点了停止就别再发了', async () => {
  const net = scripted([new Error('socket hang up'), 200]);
  const { opts } = noSleep();
  const f1 = createRetryingFetch(net.fetchImpl, { ...opts, baseDelayMs: 1 });
  assert.equal((await f1('u', {})).status, 200);
  assert.equal(net.calls.length, 2);

  const abort = new Error('The operation was aborted');
  abort.name = 'AbortError';
  const stopped = scripted([abort, 200]);
  const f2 = createRetryingFetch(stopped.fetchImpl, { baseDelayMs: 1 });
  await assert.rejects(() => f2('u', {}), /abort/i);
  assert.equal(stopped.calls.length, 1, '停止之后不该再发');
});

test('全程网络异常、退无可退时,抛的是最后那个异常而不是 undefined', async () => {
  const { fetchImpl } = scripted([new Error('ECONNRESET')]);
  const { opts } = noSleep();
  const f = createRetryingFetch(fetchImpl, { ...opts, baseDelayMs: 1, maxRetries: 2 });
  await assert.rejects(() => f('u', {}), /ECONNRESET/);
});

test('服务端给了 Retry-After 就听它的,而不是自己算的退避', async () => {
  const { fetchImpl } = scripted([429, 200]);
  const waits = [];
  const f = createRetryingFetch(fetchImpl, {
    baseDelayMs: 1, maxDelayMs: 60000,
    onRetry: (i) => waits.push(i.delayMs),
  });
  // 假响应里没带 retry-after,先确认走的是退避
  await f('u', {});
  assert.ok(waits[0] <= 1, `没有 Retry-After 时该用退避,实际 ${waits[0]}`);

  const withHeader = {
    fetchImpl: (() => {
      let n = 0;
      return async () => (n++ === 0 ? res(429, { retryAfter: '2' }) : res(200));
    })(),
  };
  const waits2 = [];
  const f2 = createRetryingFetch(withHeader.fetchImpl, {
    baseDelayMs: 1, maxDelayMs: 60000,
    onRetry: (i) => waits2.push(i.delayMs),
  });
  await f2('u', {});
  assert.equal(waits2[0], 2000, 'Retry-After: 2 应该等 2 秒');
});

test('Retry-After 再大也被 maxDelayMs 夹住,别让对方把我们挂死', async () => {
  let n = 0;
  const fetchImpl = async () => (n++ === 0 ? res(503, { retryAfter: '9999' }) : res(200));
  const waits = [];
  const f = createRetryingFetch(fetchImpl, { baseDelayMs: 1, maxDelayMs: 3000, onRetry: (i) => waits.push(i.delayMs) });
  await f('u', {});
  assert.equal(waits[0], 3000);
});

test('退避是指数的,并且带抖动;上限夹得住', () => {
  const cfg = { baseDelayMs: 500, maxDelayMs: 8000 };
  const half = (n) => backoffMs(n, cfg, () => 1); // rand=1 → 取满额
  assert.equal(half(0), 500);
  assert.equal(half(1), 1000);
  assert.equal(half(2), 2000);
  assert.equal(half(5), 8000, '涨到上限就不再涨');
  assert.equal(half(9), 8000);
  // 抖动:同一档在 50%~100% 之间
  assert.equal(backoffMs(1, cfg, () => 0), 500);
  assert.equal(backoffMs(1, cfg, () => 1), 1000);
});

test('总预算到点就不再重试,哪怕次数还没用完', async () => {
  const { fetchImpl, calls } = scripted([429]);
  let clock = 0;
  const f = createRetryingFetch(fetchImpl, {
    baseDelayMs: 1, maxDelayMs: 1, maxTotalMs: 50,
    now: () => (clock += 30),   // 每次问时间都往前跳 30ms
    onRetry: () => {},
  });
  const r = await f('u', {});
  assert.equal(r.status, 429);
  assert.ok(calls.length < 1 + DEFAULT_RETRY.maxRetries, `该被预算截断,实际发了 ${calls.length} 次`);
});

test('错误响应的正文会被消费掉,连接才还得回去', async () => {
  let drained = 0;
  let n = 0;
  const fetchImpl = async () => {
    if (n++ === 0) return { ...res(502), text: async () => { drained++; return ''; } };
    return res(200);
  };
  const f = createRetryingFetch(fetchImpl, { baseDelayMs: 1, onRetry: () => {} });
  await f('u', {});
  assert.equal(drained, 1);
});
