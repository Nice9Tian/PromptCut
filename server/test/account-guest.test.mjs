/**
 * 游客主体（`server/account/guest.mjs`）：令牌只认自己签的那一张，限额按游客算、账号不受影响。
 *
 * 令牌是持有即身份的东西，所以这里盯着三件事：编号只能服务端生成、签名改一个字符就不认、过期就不认。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  GUEST_ID_RE, GUEST_LIMITS,
  checkGuestAsset, guestCreatePolicy, guestExpired, guestPrincipal, isGuestId,
  looksLikeGuestToken, newGuestId, readGuestToken, signGuestToken,
} from '../account/guest.mjs';

const key = randomBytes(32);
const other = randomBytes(32);
const at = 1_700_000_000_000;

test('签发再核对：编号是服务端给的，字段原样回来', () => {
  const issued = signGuestToken({ key, at });
  assert.match(issued.guestId, GUEST_ID_RE);
  assert.equal(issued.issuedAt, at);
  assert.equal(issued.expiresAt, at + GUEST_LIMITS.tokenTtlMs);
  assert.ok(looksLikeGuestToken(issued.token));
  assert.deepEqual(readGuestToken(issued.token, { key, at }),
    { guestId: issued.guestId, issuedAt: at, expiresAt: issued.expiresAt });
  // 续期:交回旧编号换一张新令牌,还是同一个人
  const renewed = signGuestToken({ key, guestId: issued.guestId, at: at + 1000 });
  assert.equal(renewed.guestId, issued.guestId);
  assert.notEqual(renewed.token, issued.token);
  assert.equal(readGuestToken(renewed.token, { key, at: at + 1000 }).guestId, issued.guestId);
});

test('不收页面报上来的编号：形状不对就签不出来', () => {
  for (const bad of ['', 'acc_' + 'a'.repeat(24), 'gst_' + 'A'.repeat(24), 'gst_abc', 'gst_' + 'a'.repeat(25), 42, null]) {
    assert.throws(() => signGuestToken({ key, guestId: bad, at }), /invalid-guest/, `这个编号不该签得出来：${String(bad)}`);
  }
  assert.throws(() => signGuestToken({ key: null, at }), /guest-configuration/);
  assert.throws(() => signGuestToken({ key, at: 1.5 }), /guest-configuration/);
});

test('签名改一个字符就不认；换把密钥也不认', () => {
  const { token } = signGuestToken({ key, at });
  assert.ok(readGuestToken(token, { key, at }));
  assert.equal(readGuestToken(token, { key: other, at }), null, '别人的密钥不该验得过');
  const cut = token.lastIndexOf('.');
  const flip = c => (c === 'a' ? 'b' : 'a');
  // 改签名段
  assert.equal(readGuestToken(token.slice(0, cut + 1) + flip(token[cut + 1]) + token.slice(cut + 2), { key, at }), null);
  // 改负载段(改完签名对不上)
  assert.equal(readGuestToken(token.slice(0, 4) + flip(token[4]) + token.slice(5), { key, at }), null);
  // 砍掉签名、只留负载
  assert.equal(readGuestToken(token.slice(0, cut), { key, at }), null);
  assert.equal(readGuestToken('g1.', { key, at }), null);
  assert.equal(readGuestToken('g1', { key, at }), null);
});

test('过期的不认，容得下 30 秒时钟偏差', () => {
  const { token, expiresAt } = signGuestToken({ key, at, ttlMs: 60_000 });
  assert.ok(readGuestToken(token, { key, at: expiresAt }), '没到点该认');
  assert.ok(readGuestToken(token, { key, at: expiresAt + 29_000 }), '偏差之内该认');
  assert.equal(readGuestToken(token, { key, at: expiresAt + 31_000 }), null, '过了偏差就不该认');
});

test('账号的访问令牌不会被当成游客令牌', () => {
  for (const token of ['access-test', 'v1.abc.def', '', null, 'G1.abc.def', 'g1' + 'x'.repeat(2000)]) {
    assert.equal(looksLikeGuestToken(token), false, `这串不该看着像游客令牌：${String(token)}`);
    assert.equal(readGuestToken(token, { key, at }), null);
  }
});

test('主体摆成和账号一样的形状，事件序号恒为 0', () => {
  const issued = signGuestToken({ key, at });
  const p = guestPrincipal(issued);
  assert.equal(p.guest, true);
  assert.equal(p.accountId, issued.guestId);
  assert.equal(p.loginId, `guest:${issued.guestId}`);
  assert.equal(p.credentialId, `guest:${issued.guestId}:${at}`);
  assert.equal(p.loginGeneration, 1);
  assert.equal(p.accountEventSeq, 0, '游客不在账号事件流里，不能把文档服务卡在等事件上');
  assert.equal(p.expiresAt, issued.expiresAt);
  assert.equal(p.accountName, null);
  assert.ok(isGuestId(p.accountId));
  assert.equal(isGuestId(newGuestId()), true);
});

test('建项目：游客只能建一个，账号不受这一条影响，原来的判断接着问', () => {
  const guest = newGuestId(), account = 'acc_' + 'a'.repeat(24);
  const policy = guestCreatePolicy();
  assert.equal(policy({ accountId: guest, ownedCount: 0 }), true);
  assert.deepEqual(policy({ accountId: guest, ownedCount: GUEST_LIMITS.projects }), { code: 'guest-project-limit' });
  assert.equal(policy({ accountId: account, ownedCount: 99 }), true, '账号不该被游客那一条挡住');

  const asked = [];
  const chained = guestCreatePolicy(args => { asked.push(args.accountId); return args.accountId === account ? true : { code: 'nope' }; });
  assert.equal(chained({ accountId: account, ownedCount: 0 }), true);
  assert.deepEqual(chained({ accountId: guest, ownedCount: 0 }), { code: 'nope' }, '游客没到上限时该落到原来的判断');
  assert.deepEqual(asked, [account, guest]);
  // 到了上限就不必再问原来的判断了
  assert.deepEqual(chained({ accountId: guest, ownedCount: GUEST_LIMITS.projects }), { code: 'guest-project-limit' });
  assert.deepEqual(asked, [account, guest]);
});

test('传素材：三条封顶，每条 100 MB 封顶，账号不受限', () => {
  const guest = newGuestId(), account = 'acc_' + 'a'.repeat(24);
  const ok = { ok: true };
  assert.deepEqual(checkGuestAsset({ accountId: guest, bytes: 1, storedCount: 0 }), ok);
  assert.deepEqual(checkGuestAsset({ accountId: guest, bytes: GUEST_LIMITS.assetBytes, storedCount: GUEST_LIMITS.assets - 1 }), ok, '正好到线该收');
  assert.deepEqual(checkGuestAsset({ accountId: guest, bytes: GUEST_LIMITS.assetBytes + 1, storedCount: 0 }),
    { ok: false, code: 'guest-asset-too-large' });
  assert.deepEqual(checkGuestAsset({ accountId: guest, bytes: 1, storedCount: GUEST_LIMITS.assets }),
    { ok: false, code: 'guest-asset-limit' });
  assert.deepEqual(checkGuestAsset({ accountId: guest, bytes: -1, storedCount: 0 }), { ok: false, code: 'invalid-asset' });
  assert.deepEqual(checkGuestAsset({ accountId: account, bytes: GUEST_LIMITS.assetBytes * 10, storedCount: 1000 }), ok);
});

test('三天清理：到点算过期，差一毫秒不算', () => {
  const born = at;
  assert.equal(guestExpired(born, born + GUEST_LIMITS.ttlMs - 1), false);
  assert.equal(guestExpired(born, born + GUEST_LIMITS.ttlMs), true);
  assert.equal(guestExpired(born, born), false);
  assert.equal(guestExpired(undefined, born), false);
  assert.equal(GUEST_LIMITS.ttlMs, 3 * 24 * 60 * 60 * 1000, '三天');
  assert.ok(GUEST_LIMITS.tokenTtlMs < GUEST_LIMITS.ttlMs, '令牌该比清理期短，页面才有机会续期');
});
