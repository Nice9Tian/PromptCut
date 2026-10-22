/**
 * 领游客令牌的 IP 限流（`server/account/guest-rate.mjs`，2026-10-23 用户定「先用 IP 拦」）。
 *
 * 最要紧的两条：经 nginx 进来时**不能**把所有人算成一个（那样一个人就能把全世界限住），
 * 客户端伪造的转发头**不能**算数（那样换个头就绕过去了）。
 *
 * 跑：npm test -- server/test/account-guest-rate.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { GUEST_RATE, clientKeyOf, createGuestRateLimit } from '../account/guest-rate.mjs';

const req = (peer, headers = {}) => ({ socket: peer === null ? null : { remoteAddress: peer }, headers });

test('直连这台服务：用对端地址，转发头一概不看', () => {
  assert.equal(clientKeyOf(req('203.0.113.7')), '203.0.113.7');
  // 客户端自己写的转发头不可信:直连时看都不看
  assert.equal(clientKeyOf(req('203.0.113.7', { 'x-forwarded-for': '1.2.3.4' })), '203.0.113.7');
  assert.equal(clientKeyOf(req('203.0.113.7', { 'x-real-ip': '1.2.3.4' })), '203.0.113.7');
  assert.equal(clientKeyOf(req('2001:db8::1')), '2001:db8::1');
});

test('经本机 nginx 进来：取 X-Forwarded-For 的最后一跳（nginx 亲眼看到的那个）', () => {
  // nginx 的 $proxy_add_x_forwarded_for 把真实对端追加在客户端那串后面
  assert.equal(clientKeyOf(req('127.0.0.1', { 'x-forwarded-for': '198.51.100.9' })), '198.51.100.9');
  // 客户端伪造一串:只会排在前面,最后一跳仍是 nginx 写的那个
  assert.equal(clientKeyOf(req('127.0.0.1', { 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 198.51.100.9' })), '198.51.100.9');
  // 伪造 X-Real-IP / Forwarded 不算数:nginx 不设它们,看了反而能被伪造
  assert.equal(clientKeyOf(req('127.0.0.1', { 'x-forwarded-for': '198.51.100.9', 'x-real-ip': '1.1.1.1' })), '198.51.100.9');
  assert.equal(clientKeyOf(req('127.0.0.1', { forwarded: 'for=1.1.1.1', 'x-forwarded-for': '198.51.100.9' })), '198.51.100.9');
  // 带端口、带方括号的写法要剥干净
  assert.equal(clientKeyOf(req('::1', { 'x-forwarded-for': '198.51.100.9:443' })), '198.51.100.9');
  assert.equal(clientKeyOf(req('::1', { 'x-forwarded-for': '[2001:db8::5]:443' })), '2001:db8::5');
  // 真的本机请求(没有转发头):就用对端
  assert.equal(clientKeyOf(req('127.0.0.1')), '127.0.0.1');
  assert.equal(clientKeyOf(req('127.0.0.1', { 'x-forwarded-for': '   ' })), '127.0.0.1');
});

test('认不出是谁就回 null，而且不限 —— 认不出的全算成一个人的话，一个请求就能把他们全挡住', () => {
  assert.equal(clientKeyOf(req(null)), null);
  assert.equal(clientKeyOf(undefined), null);
  const limit = createGuestRateLimit({ max: 1 });
  for (let i = 0; i < 50; i++) assert.deepEqual(limit.take(null), { ok: true });
  assert.deepEqual(limit.take(''), { ok: true });
});

test('同一个 IP 到数就拦，并说清楚等多久；别的 IP 不受牵连', () => {
  let at = 1_000_000;
  const limit = createGuestRateLimit({ max: 3, windowMs: 60_000, now: () => at });
  for (let i = 0; i < 3; i++) assert.deepEqual(limit.take('1.1.1.1'), { ok: true }, `第 ${i + 1} 次`);
  const refused = limit.take('1.1.1.1');
  assert.equal(refused.ok, false);
  assert.equal(refused.retryAfterSec, 60, '最早那一次滚出窗口就能再来');
  assert.deepEqual(limit.take('2.2.2.2'), { ok: true }, '别的 IP 不该被牵连');

  // 窗口往前滚:最早那一次出去了,就又能来一次
  at += 60_001;
  assert.deepEqual(limit.take('1.1.1.1'), { ok: true });
});

test('等多久是按最早那一次算的，不是一律整窗', () => {
  let at = 0;
  const limit = createGuestRateLimit({ max: 2, windowMs: 1000, now: () => at });
  limit.take('1.1.1.1');          // t=0
  at = 400; limit.take('1.1.1.1'); // t=400
  at = 500;
  const refused = limit.take('1.1.1.1');
  assert.equal(refused.ok, false);
  assert.equal(refused.retryAfterSec, 1, '第一次在 t=1000 滚出窗口，还剩 500ms，向上取整 1 秒');
});

test('盯不过来时不把内存吃光', () => {
  const limit = createGuestRateLimit({ max: 5, windowMs: 60_000 });
  for (let i = 0; i < 12_000; i++) limit.take(`10.0.${(i >> 8) & 255}.${i & 255}`);
  assert.ok(limit.size() <= 10_000, `盯着 ${limit.size()} 个，超了上限`);
});

test('缺省的数：每小时 20 张', () => {
  assert.equal(GUEST_RATE.max, 20);
  assert.equal(GUEST_RATE.windowMs, 60 * 60 * 1000);
  let at = 0;
  const limit = createGuestRateLimit({ now: () => at });
  for (let i = 0; i < GUEST_RATE.max; i++) assert.equal(limit.take('9.9.9.9').ok, true);
  assert.equal(limit.take('9.9.9.9').ok, false);
});
