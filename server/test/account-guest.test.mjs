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
  checkGuestAsset, guestExpired, guestPrincipal, guestProjectLimitReached, isGuestId,
  looksLikeGuestToken, newGuestId, readGuestToken, signGuestToken,
} from '../account/guest.mjs';
import { checkCreateProject } from '../account/authority.mjs';

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
    { guestId: issued.guestId, issuedAt: at, expiresAt: issued.expiresAt, expired: false });
  // 整串只能有 Bearer 那一层认的字符：带点号会在 `bearer()` 那里被当成没登录挡回来
  assert.match(issued.token, /^[A-Za-z0-9_-]+$/, '令牌里不能有点号等字符');
  assert.ok(issued.token.length <= 256, 'Bearer 那一层最多 256 个字符');
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

test('过期的签名照样认得出是自己发的，只是标成过期（不能falls through 去问账号服务）', () => {
  const { token, expiresAt } = signGuestToken({ key, at, ttlMs: 60_000 });
  assert.equal(readGuestToken(token, { key, at: expiresAt })?.expired, false, '没到点该认');
  assert.equal(readGuestToken(token, { key, at: expiresAt + 29_000 })?.expired, false, '偏差之内该认');
  const stale = readGuestToken(token, { key, at: expiresAt + 31_000 });
  assert.ok(stale, '签名没问题就该认出是本服务发的');
  assert.equal(stale.expired, true, '过了偏差标成过期');
  // null 只留给「不是本服务发的」:那种才该交给账号服务去认
  assert.equal(readGuestToken(token, { key: other, at }), null);
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

test('建项目：游客只能建一个，账号不受这一条影响', () => {
  const guest = newGuestId(), account = 'acc_' + 'a'.repeat(24);
  assert.equal(guestProjectLimitReached({ accountId: guest, ownedCount: 0 }), false);
  assert.equal(guestProjectLimitReached({ accountId: guest, ownedCount: GUEST_LIMITS.projects }), true);
  assert.equal(guestProjectLimitReached({ accountId: account, ownedCount: 99 }), false, '账号不该被游客那一条挡住');

  // 这一条不走可配的 createPolicy:空策略下照样拦得住
  assert.throws(() => checkCreateProject({}, { accountId: guest, ownedCount: GUEST_LIMITS.projects, requestId: 'r' }),
    e => e.code === 'guest-project-limit' && e.status === 403);
  assert.doesNotThrow(() => checkCreateProject({}, { accountId: guest, ownedCount: 0, requestId: 'r' }));
  assert.doesNotThrow(() => checkCreateProject({}, { accountId: account, ownedCount: 99, requestId: 'r' }));
  // 游客没到上限时,部署方配的判断照样说了算
  assert.throws(() => checkCreateProject({ canCreate: () => ({ code: 'nope' }) }, { accountId: guest, ownedCount: 0, requestId: 'r' }),
    e => e.code === 'nope');
});

test('传素材：视频原件三条封顶，每一条源文件 100 MB 封顶，不算数的只查尺寸，账号不受限', () => {
  const guest = newGuestId(), account = 'acc_' + 'a'.repeat(24);
  const ok = { ok: true };
  assert.deepEqual(checkGuestAsset({ accountId: guest, bytes: 1, countsAsVideo: true, storedVideos: 0 }), ok);
  assert.deepEqual(checkGuestAsset({ accountId: guest, bytes: GUEST_LIMITS.assetBytes, countsAsVideo: true, storedVideos: GUEST_LIMITS.videos - 1 }), ok, '正好到线该收');
  assert.deepEqual(checkGuestAsset({ accountId: guest, bytes: GUEST_LIMITS.assetBytes + 1, countsAsVideo: true, storedVideos: 0 }),
    { ok: false, code: 'guest-file-too-large' });
  assert.deepEqual(checkGuestAsset({ accountId: guest, bytes: 1, countsAsVideo: true, storedVideos: GUEST_LIMITS.videos }),
    { ok: false, code: 'guest-video-limit' });
  // 不算数的（图片、音频、小档）：存了多少条视频都不管，只查尺寸
  assert.deepEqual(checkGuestAsset({ accountId: guest, bytes: 1, countsAsVideo: false, storedVideos: 1000 }), ok);
  assert.deepEqual(checkGuestAsset({ accountId: guest, bytes: GUEST_LIMITS.assetBytes + 1, countsAsVideo: false }),
    { ok: false, code: 'guest-file-too-large' });
  assert.deepEqual(checkGuestAsset({ accountId: guest, bytes: -1 }), { ok: false, code: 'invalid-asset' });
  assert.deepEqual(checkGuestAsset({ accountId: account, bytes: GUEST_LIMITS.assetBytes * 10, countsAsVideo: true, storedVideos: 1000 }), ok);
  assert.equal(GUEST_LIMITS.videos, 3);
  assert.equal(GUEST_LIMITS.assetBytes, 100 * 1024 * 1024);
});
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
