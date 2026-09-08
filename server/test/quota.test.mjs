// node --test server/test/quota.test.mjs —— 额度熔断:解析和判定都不碰真 CLI
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseClaudeUsage, parseCodexRateLimits, summarize, createQuotaGuard, normalizeQuotaConfig, QuotaExceededError } = await import('../runners/quota.mjs');

const CLAUDE_TEXT = `You are currently using your subscription to power your Claude Code usage

Current session: 18% used · resets Sep 8, 3pm (Asia/Tokyo)
Current week (all models): 51% used · resets Sep 14, 10am (Asia/Tokyo)
Current week (Fable): 75% used · resets Sep 14, 10am (Asia/Tokyo)

What's contributing to your limits usage?
  93% of your usage was at >150k context
`;

test('parseClaudeUsage:三个窗口都认出来,百分比和重置时间对得上;正文里别的百分比不算', () => {
  const w = parseClaudeUsage(CLAUDE_TEXT);
  assert.deepEqual(w.map((x) => [x.id, x.usedPercent]), [['session', 18], ['week', 51], ['week-fable', 75]]);
  assert.equal(w[0].label, '当前 5 小时');
  assert.equal(w[2].label, '本周(Fable)');
  assert.equal(w[1].resetsText, 'Sep 14, 10am (Asia/Tokyo)');
  assert.equal(parseClaudeUsage('You are using an API key. No subscription limits.').length, 0);
});

test('parseCodexRateLimits:primary 是 5 小时、secondary 是本周,resetsAt 秒转毫秒', () => {
  const w = parseCodexRateLimits({ rateLimits: { primary: { usedPercent: 4, windowDurationMins: 300, resetsAt: 1788848583 }, secondary: { usedPercent: 51, windowDurationMins: 10080, resetsAt: 1789321254 }, planType: 'plus' } });
  assert.deepEqual(w.map((x) => [x.id, x.label, x.usedPercent]), [['session', '当前 5 小时', 4], ['week', '本周', 51]]);
  assert.equal(w[0].resetsAt, 1788848583000);
  assert.ok(w[0].resetsText);
  assert.equal(parseCodexRateLimits({}).length, 0);
  assert.equal(parseCodexRateLimits(null).length, 0);
});

test('summarize:最高的窗口决定 worst 和 maxUsedPercent', () => {
  const s = summarize('claude', parseClaudeUsage(CLAUDE_TEXT));
  assert.equal(s.ok, true);
  assert.equal(s.maxUsedPercent, 75);
  assert.equal(s.worst.id, 'week-fable');
  assert.equal(summarize('codex', []).ok, false);
});

test('normalizeQuotaConfig:默认 80% / 256KB;越界的值夹回来', () => {
  assert.deepEqual(normalizeQuotaConfig(undefined), { enabled: true, thresholdPercent: 80, checkEveryBytes: 262144 });
  assert.equal(normalizeQuotaConfig({ thresholdPercent: 250 }).thresholdPercent, 100);
  assert.equal(normalizeQuotaConfig({ thresholdPercent: 0 }).thresholdPercent, 1);
  assert.equal(normalizeQuotaConfig({ checkEveryBytes: 10 }).checkEveryBytes, 16384);
  assert.equal(normalizeQuotaConfig({ enabled: false }).enabled, false);
});

function fakeProbe(seq) {
  const calls = [];
  const probe = async (provider) => {
    calls.push(provider);
    const pct = typeof seq === 'function' ? seq(calls.length) : seq[Math.min(calls.length, seq.length) - 1];
    if (pct === 'fail') return { provider, label: 'Codex', supported: true, ok: false, windows: [], maxUsedPercent: null, worst: null, error: '没登录' };
    return summarize(provider, [{ id: 'session', label: '当前 5 小时', usedPercent: pct, resetsText: '12:00', resetsAt: null }]);
  };
  return { probe, calls };
}

test('gate:第一次先查再放行;没超线放行;超线抛 QuotaExceededError 且错误说人话', async () => {
  const { probe, calls } = fakeProbe([40]);
  const g = createQuotaGuard({ probe, now: () => 1000 });
  const info = await g.gate('claude', { thresholdPercent: 80 });
  assert.equal(info.maxUsedPercent, 40);
  assert.equal(calls.length, 1);
  await g.gate('claude', { thresholdPercent: 80 });
  assert.equal(calls.length, 1, '十分钟内不重查');

  const hot = createQuotaGuard({ probe: fakeProbe([85]).probe });
  await assert.rejects(() => hot.gate('codex', { thresholdPercent: 80 }), (e) => {
    assert.ok(e instanceof QuotaExceededError);
    assert.match(e.message, /Codex 额度已用 85%/);
    assert.match(e.message, /阈值 80%/);
    assert.match(e.message, /12:00 重置/);
    return true;
  });
});

test('gate:关掉熔断、不支持的驱动、查不到用量 —— 都不拦', async () => {
  const off = createQuotaGuard({ probe: fakeProbe([99]).probe });
  assert.equal(await off.gate('claude', { enabled: false }), null);
  assert.equal(await off.gate('agy', { thresholdPercent: 80 }), null);
  const failing = createQuotaGuard({ probe: fakeProbe(['fail']).probe });
  const info = await failing.gate('codex', { thresholdPercent: 80 });
  assert.equal(info.ok, false);
});

test('gate:结果太旧就重查', async () => {
  let t = 0;
  const { probe, calls } = fakeProbe([40, 90]);
  const g = createQuotaGuard({ probe, now: () => t, staleMs: 1000 });
  await g.gate('claude', {});
  t = 5000;
  await assert.rejects(() => g.gate('claude', {}), /90%/);
  assert.equal(calls.length, 2);
});

test('note:累计字节没到线不查;到线后台重查并给出判定,字节数清零', async () => {
  const { probe, calls } = fakeProbe([40, 88]);
  const g = createQuotaGuard({ probe });
  await g.gate('claude', {});
  assert.equal(g.note('claude', 100, { checkEveryBytes: 20000 }), null);
  assert.equal(calls.length, 1);
  const v = await g.note('claude', 25000, { checkEveryBytes: 20000 });
  assert.equal(calls.length, 2);
  assert.equal(v.blocked, true);
  assert.match(v.message, /88%/);
  assert.equal(g.bytesSince('claude'), 0);
  // 之后的 gate 直接按新结果拦,不用再查
  await assert.rejects(() => g.gate('claude', {}), /88%/);
  assert.equal(calls.length, 2);
});

test('并发 refresh 只查一次', async () => {
  const { probe, calls } = fakeProbe([10]);
  const g = createQuotaGuard({ probe });
  await Promise.all([g.get('codex', { refresh: true }), g.get('codex', { refresh: true }), g.gate('codex', {})]);
  assert.equal(calls.length, 1);
});
