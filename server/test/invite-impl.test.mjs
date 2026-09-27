/**
 * 邀请码服务端的实现单测（C10a 契约 `docs/plan/c10a-contract.md` 第 5 节；`c10a-web` 分支自测）。
 * 契约测试（编号 `C10A-…`）由 `c10a-tests` 分支照契约独立写；这里是实现方自己的覆盖，编号 `INV-…`。
 *
 * 跑：node --test server/test/invite-impl.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  hostFor, createProject, join, joinStatus, newDevice, adminOp, logText, derive,
} from './auth-kit.mjs';
import {
  INVITE_LENGTH, INVITE_DEFAULTS, isInviteCode, newInviteCode, inviteDigest, parseInviteOptions, issueInvite,
  inviteActive, inviteStatus, redeemOn,
} from '../auth/invite.mjs';
import { openCredentialStore } from '../auth/store.mjs';
import { createRateLimiter } from '../auth/rate-limit.mjs';
import { publicOriginOf } from '../hosted/combo.mjs';

const DAY = 86_400_000;
let seq = 0;
const R = () => `203.0.113.${(seq += 1) % 250 + 1}`;

const resolve = (env, code, remote = R()) => env.http('shared/invite/resolve', { method: 'POST', body: { code }, remote });
const redeem = (env, code, { username = 'zoe', deviceId = newDevice().deviceId, remote = R() } = {}) =>
  env.http('shared/invite/redeem', { method: 'POST', body: { code, username, deviceId }, remote });

async function creatorOf(env, proj) {
  return join(env, proj, { username: proj.creator.username, as: 'creator', remote: R() });
}

/* ---------------- 纯函数 ---------------- */

test('INV-1 邀请码形状：32 字节随机数编成 43 个 base64url 字符；摘要是 HMAC-SHA256 的 base64url', () => {
  const a = newInviteCode();
  const b = newInviteCode();
  assert.equal(a.length, INVITE_LENGTH);
  assert.ok(isInviteCode(a) && isInviteCode(b));
  assert.notEqual(a, b);
  assert.equal(Buffer.from(a, 'base64url').length, 32);
  assert.ok(!isInviteCode(`${a}=`) && !isInviteCode(a.slice(1)) && !isInviteCode(`${a.slice(1)}+`) && !isInviteCode(null));
  const secret = Buffer.alloc(32, 7);
  assert.equal(inviteDigest(secret, a), inviteDigest(secret, a));
  assert.notEqual(inviteDigest(secret, a), inviteDigest(Buffer.alloc(32, 8), a));
  assert.equal(Buffer.from(inviteDigest(secret, a), 'base64url').length, 32);
});

test('INV-2 签发参数：缺省 7 天、次数不限；非法值回 null', () => {
  assert.deepEqual(parseInviteOptions({}), { expiresInSec: 604_800, maxUses: null });
  assert.deepEqual(parseInviteOptions({ expiresInSec: 60, maxUses: 3 }), { expiresInSec: 60, maxUses: 3 });
  for (const bad of [{ expiresInSec: 0 }, { expiresInSec: -1 }, { expiresInSec: 1.5 }, { expiresInSec: '60' }, { maxUses: 0 }, { maxUses: 2.5 },
    { expiresInSec: INVITE_DEFAULTS.MAX_EXPIRES_IN_SEC + 1 }]) {
    assert.equal(parseInviteOptions(bad), null, JSON.stringify(bad));
  }
  const { code, invite } = issueInvite(Buffer.alloc(32, 1), { expiresInSec: 10, maxUses: 2 }, 1000);
  assert.ok(isInviteCode(code));
  assert.equal(invite.expiresAt, 11_000);
  assert.ok(!JSON.stringify(invite).includes(code), '记录里不含原文');
  assert.equal(inviteActive(invite, 10_999), true);
  assert.equal(inviteActive(invite, 11_000), false, '到点就过期');
  assert.equal(redeemOn(invite, 'a@d1', 2000), 'ok');
  assert.equal(redeemOn(invite, 'a@d1', 2000), 'again', '同一 userId 不重复扣');
  assert.equal(redeemOn(invite, 'b@d2', 2000), 'ok');
  assert.equal(invite.used, 2);
  assert.equal(redeemOn(invite, 'c@d3', 2000), 'invalid', '次数用完');
  assert.equal(redeemOn(invite, 'a@d1', 2000), 'again', '兑换过的人次数用完后照样放行');
  assert.deepEqual(inviteStatus(invite, 2000), { active: false, expiresAt: 11_000, maxUses: 2, used: 2, revokedAt: null });
  invite.revokedAt = 3000;
  assert.equal(redeemOn(invite, 'a@d1', 3000), 'invalid', '作废之后兑换过的人也进不来');
  assert.deepEqual(inviteStatus(null, 0), { active: false, expiresAt: null, maxUses: null, used: 0, revokedAt: null });
});

test('INV-3 限速器的剩余冷却：冷却中给出剩余毫秒，冷却外为 0', () => {
  let t = 0;
  const lim = createRateLimiter({ now: () => t, maxFailures: 2, cooldownMs: 60_000 });
  assert.equal(lim.retryAfterMs('x'), 0);
  lim.fail('x');
  lim.fail('x');
  assert.equal(lim.retryAfterMs('x'), 60_000);
  t = 45_000;
  assert.equal(lim.retryAfterMs('x'), 15_000);
  t = 61_000;
  assert.equal(lim.retryAfterMs('x'), 0);
});

test('INV-4 邀请链接的源：取文档服务公网地址的源，ws→http、wss→https', () => {
  assert.equal(publicOriginOf('wss://8-219-80-16.sslip.io/hosted/'), 'https://8-219-80-16.sslip.io');
  assert.equal(publicOriginOf('ws://1.2.3.4:8787'), 'http://1.2.3.4:8787');
  assert.equal(publicOriginOf('https://a.example/x'), 'https://a.example');
  assert.equal(publicOriginOf(''), null);
  assert.equal(publicOriginOf(undefined), null);
  assert.equal(publicOriginOf('ftp://x'), null);
});

/* ---------------- 端点与创建者操作 ---------------- */

for (const attached of [false, true]) {
  const where = attached ? '挂载模式（局域网主机）' : '独立模式（托管端）';

  test(`INV-5 ${where}：invite-create 签发、resolve 查到项目、invite-status 不含原文`, async (t) => {
    const env = await hostFor(t, { attached });
    const proj = await createProject(env, { mode: 'free' });
    const creator = await creatorOf(env, proj);
    const before = env.clock.now();
    const r = await adminOp(creator, proj, 'invite-create');
    assert.equal(r.type, 'shared.admin.ok', JSON.stringify(r));
    assert.equal(r.op, 'invite-create');
    assert.ok(isInviteCode(r.code), r.code);
    assert.equal(r.maxUses, null);
    assert.ok(r.expiresAt >= before + 7 * DAY && r.expiresAt <= env.clock.now() + 7 * DAY, '缺省 7 天');
    assert.equal(r.linkOrigin, null, '组装层没给公网源');

    const res = await resolve(env, r.code);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json, { ok: true, projectId: proj.projectId, name: proj.name, mode: 'free' });
    assert.equal(res.headers.get('cache-control'), 'no-store');

    const st = await adminOp(creator, proj, 'invite-status');
    assert.equal(st.type, 'shared.admin.ok', JSON.stringify(st));
    assert.deepEqual({ active: st.active, used: st.used, maxUses: st.maxUses, revokedAt: st.revokedAt, expiresAt: st.expiresAt },
      { active: true, used: 0, maxUses: null, revokedAt: null, expiresAt: r.expiresAt });
    assert.ok(!JSON.stringify(st).includes(r.code), 'status 不含原文');
    assert.equal(st.code, undefined);
  });
}

test('INV-6 只有一个有效邀请码：再签发就作废旧的；revoke 之后 resolve/redeem 都是 invite-invalid', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const creator = await creatorOf(env, proj);
  const first = await adminOp(creator, proj, 'invite-create');
  const second = await adminOp(creator, proj, 'invite-create', { expiresInSec: 3600, maxUses: 5 });
  assert.notEqual(first.code, second.code);
  assert.equal(second.maxUses, 5);
  assert.equal((await resolve(env, first.code)).status, 404);
  assert.equal((await resolve(env, first.code)).json.error, 'invite-invalid');
  assert.equal((await resolve(env, second.code)).status, 200);

  const rv = await adminOp(creator, proj, 'invite-revoke');
  assert.equal(rv.type, 'shared.admin.ok', JSON.stringify(rv));
  const gone = await resolve(env, second.code);
  assert.deepEqual([gone.status, gone.json.error], [404, 'invite-invalid']);
  const gone2 = await redeem(env, second.code);
  assert.deepEqual([gone2.status, gone2.json.error], [404, 'invite-invalid']);
  const st = await adminOp(creator, proj, 'invite-status');
  assert.equal(st.active, false);
  assert.ok(Number.isFinite(st.revokedAt));
  // 没有邀请码的项目也能 revoke / status
  const other = await createProject(env, { mode: 'free' });
  const c2 = await creatorOf(env, other);
  assert.equal((await adminOp(c2, other, 'invite-revoke')).type, 'shared.admin.ok');
  const st2 = await adminOp(c2, other, 'invite-status');
  assert.deepEqual([st2.active, st2.expiresAt, st2.used], [false, null, 0]);
  // 作废不影响已经进来的人、不影响项目口令
  assert.equal(creator.ws.readyState, 1);
  assert.equal(await joinStatus(env, proj, { username: 'late', remote: R() }), 101);
});

test('INV-7 限时：过期之后一个口径 invite-invalid', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const creator = await creatorOf(env, proj);
  const r = await adminOp(creator, proj, 'invite-create', { expiresInSec: 60 });
  assert.equal((await resolve(env, r.code)).status, 200);
  env.clock.advance(61_000);
  const res = await resolve(env, r.code);
  assert.deepEqual([res.status, res.json.error], [404, 'invite-invalid']);
  const red = await redeem(env, r.code);
  assert.deepEqual([red.status, red.json.error], [404, 'invite-invalid']);
});

test('INV-8 限量：同一 userId 不重复扣；满了一个口径 invite-invalid；resolve 不扣次数', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const creator = await creatorOf(env, proj);
  const r = await adminOp(creator, proj, 'invite-create', { maxUses: 2 });
  for (let i = 0; i < 3; i++) assert.equal((await resolve(env, r.code)).status, 200, 'resolve 不扣');
  const d1 = newDevice().deviceId;
  const d2 = newDevice().deviceId;
  assert.equal((await redeem(env, r.code, { username: 'u1', deviceId: d1 })).status, 200);
  assert.equal((await redeem(env, r.code, { username: 'u1', deviceId: d1 })).status, 200, '同一人再兑换');
  assert.equal((await adminOp(creator, proj, 'invite-status')).used, 1, '同一 userId 只扣一次');
  assert.equal((await redeem(env, r.code, { username: 'u1', deviceId: d2 })).status, 200, '同名换设备算另一个人');
  const full = await redeem(env, r.code, { username: 'u3' });
  assert.deepEqual([full.status, full.json.error], [404, 'invite-invalid']);
  assert.equal((await resolve(env, r.code)).status, 404, '用完之后 resolve 也无效');
  assert.equal((await redeem(env, r.code, { username: 'u1', deviceId: d1 })).status, 200, '兑换过的人照样放行');
  const st = await adminOp(creator, proj, 'invite-status');
  assert.deepEqual([st.used, st.maxUses, st.active], [2, 2, false]);
});

test('INV-9 自由进入回 K，凭它握手进得去；限定进入不回 K', async (t) => {
  const env = await hostFor(t);
  const free = await createProject(env, { mode: 'free', password: 'free-pw' });
  const c1 = await creatorOf(env, free);
  const inv = await adminOp(c1, free, 'invite-create');
  const dev = newDevice('Phone');
  const red = await redeem(env, inv.code, { username: 'mia', deviceId: dev.deviceId });
  assert.equal(red.status, 200, red.text);
  assert.equal(red.json.projectId, free.projectId);
  assert.equal(red.json.mode, 'free');
  assert.deepEqual(red.json.kdf, { alg: 'pbkdf2-sha256', iter: 100_000 });
  assert.equal(red.json.project.key, derive('free-pw', red.json.project.salt, red.json.kdf), '回的就是项目口令的 K');
  assert.equal(await joinStatus(env, free, { username: 'mia', device: dev, key: red.json.project.key, remote: R() }), 101);

  const restricted = await createProject(env, { mode: 'restricted', list: [{ username: 'bob', password: 'bob-pw' }] });
  const c2 = await creatorOf(env, restricted);
  const inv2 = await adminOp(c2, restricted, 'invite-create');
  const red2 = await redeem(env, inv2.code, { username: 'bob' });
  assert.equal(red2.status, 200, red2.text);
  assert.deepEqual(red2.json, { ok: true, projectId: restricted.projectId, name: restricted.name, mode: 'restricted' });
  assert.equal((await adminOp(c2, restricted, 'invite-status')).used, 1, '限定进入在兑换时就扣');
});

test('INV-10 禁入：被踢的 (用户名, 设备) 兑换回 401 banned；unban 后恢复', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const creator = await creatorOf(env, proj);
  const inv = await adminOp(creator, proj, 'invite-create');
  const dev = newDevice('Tab');
  const zoe = await join(env, proj, { username: 'zoe', device: dev, remote: R() });
  assert.equal((await adminOp(creator, proj, 'kick', { username: 'zoe', deviceId: dev.deviceId })).type, 'shared.admin.ok');
  await zoe.closed;
  const r = await redeem(env, inv.code, { username: 'zoe', deviceId: dev.deviceId });
  assert.deepEqual([r.status, r.json.error], [401, 'banned']);
  assert.equal((await redeem(env, inv.code, { username: 'zoe', deviceId: newDevice().deviceId })).status, 200, '换设备不在禁入表里');
  await adminOp(creator, proj, 'unban', { username: 'zoe', deviceId: dev.deviceId });
  assert.equal((await redeem(env, inv.code, { username: 'zoe', deviceId: dev.deviceId })).status, 200);
});

test('INV-11 限速：同一来源 5 次失败后 429 带 Retry-After 头；别的来源不受影响；回环不计数', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const creator = await creatorOf(env, proj);
  const inv = await adminOp(creator, proj, 'invite-create');
  const bad = newInviteCode();
  const src = '198.18.0.7';
  for (let i = 0; i < 5; i++) assert.equal((await resolve(env, i % 2 ? bad : 'not-a-code', src)).status, 404);
  const blocked = await resolve(env, inv.code, src);
  assert.equal(blocked.status, 429, '冷却期内对的码也拒');
  assert.equal(blocked.json.error, 'rate-limited');
  const after = Number(blocked.headers.get('retry-after'));
  assert.ok(after > 0 && after <= 60, String(after));
  assert.deepEqual(blocked.json, { ok: false, error: 'rate-limited' }, '回包体照契约原样');
  assert.equal(blocked.headers.get('access-control-expose-headers'), 'Retry-After');
  assert.equal((await redeem(env, inv.code, { remote: src })).status, 429);
  assert.equal((await resolve(env, inv.code, '198.18.0.8')).status, 200, '另一来源');
  env.clock.advance(61_000);
  assert.equal((await resolve(env, inv.code, src)).status, 200, '61 s 后恢复');
  // 被踢的兑换同样计数
  const dev = newDevice();
  const zoe = await join(env, proj, { username: 'zoe', device: dev, remote: R() });
  await adminOp(creator, proj, 'kick', { username: 'zoe', deviceId: dev.deviceId });
  await zoe.closed;
  const src2 = '198.18.0.9';
  for (let i = 0; i < 5; i++) assert.equal((await redeem(env, inv.code, { username: 'zoe', deviceId: dev.deviceId, remote: src2 })).status, 401);
  assert.equal((await resolve(env, inv.code, src2)).status, 429);
  // 回环来源不计数（与挑战一致；托管端在反向代理之后的来源问题归 HT-a）
  for (let i = 0; i < 7; i++) assert.equal((await resolve(env, bad, '127.0.0.1')).status, 404);
});

test('INV-12 创建者操作：成员、不带证明、证明错一律 forbidden；字段不对 bad-message', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const creator = await creatorOf(env, proj);
  const member = await join(env, proj, { username: 'zoe', remote: R() });
  for (const op of ['invite-create', 'invite-revoke', 'invite-status']) {
    assert.equal((await adminOp(member, proj, op, {}, { password: proj.password, username: 'zoe' })).reason, 'forbidden', `${op} 成员`);
    assert.equal((await adminOp(creator, proj, op, {}, { noProof: true })).reason, 'forbidden', `${op} 不带证明`);
    assert.equal((await adminOp(creator, proj, op, {}, { badProof: true })).reason, 'forbidden', `${op} 证明错`);
  }
  assert.equal((await adminOp(creator, proj, 'invite-create', { expiresInSec: 0 })).reason, 'bad-message');
  assert.equal((await adminOp(creator, proj, 'invite-create', { maxUses: -1 })).reason, 'bad-message');
  assert.equal((await adminOp(creator, proj, 'invite-status')).active, false, '都没生效');
});

test('INV-13 原文不落盘、不进日志；删项目后邀请码一并失效；重开存储后按摘要仍找得到', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const creator = await creatorOf(env, proj);
  const inv = await adminOp(creator, proj, 'invite-create');
  await redeem(env, inv.code, { username: 'ann' });
  await resolve(env, inv.code);
  await resolve(env, newInviteCode());

  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) (e.isDirectory() ? walk : (p) => files.push(p))(path.join(d, e.name)); };
  walk(env.dataDir);
  assert.ok(files.length > 0);
  for (const f of files) assert.ok(!fs.readFileSync(f).includes(Buffer.from(inv.code)), `${f} 里有邀请码原文`);
  const text = logText(env);
  assert.ok(!text.includes(inv.code), '日志里有邀请码原文');
  assert.ok(!text.includes('"ann"'), '日志里有请求体里的用户名');

  // 重开：从磁盘读回，索引重建
  const authDir = path.join(env.dataDir, 'auth');
  assert.ok(fs.existsSync(authDir), '凭证存储在 <dataDir>/auth/');
  {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-inv-store-'));
    t.after(() => fs.rmSync(copy, { recursive: true, force: true }));
    fs.cpSync(authDir, copy, { recursive: true });
    const st = openCredentialStore({ dir: copy });
    const rec = st.peekByInviteDigest(inviteDigest(st.serverSecret, inv.code));
    assert.equal(rec?.projectId, proj.projectId);
    assert.equal(rec.invite.used, 1);
  }

  assert.equal((await adminOp(creator, proj, 'delete')).type, 'shared.admin.ok');
  const r = await resolve(env, inv.code);
  assert.deepEqual([r.status, r.json.error], [404, 'invite-invalid']);
});

test('INV-14 请求格式：兑换缺用户名或设备 id 回 400；GET 回 405', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const creator = await creatorOf(env, proj);
  const inv = await adminOp(creator, proj, 'invite-create');
  assert.equal((await env.http('shared/invite/redeem', { method: 'POST', body: { code: inv.code }, remote: R() })).status, 400);
  assert.equal((await env.http('shared/invite/redeem', { method: 'POST', body: { code: inv.code, username: 'x', deviceId: 'short' }, remote: R() })).status, 400);
  assert.equal((await env.http('shared/invite/resolve', { method: 'GET', remote: R() })).status, 405);
  assert.equal((await env.http('shared/invite/resolve', { method: 'POST', raw: '{', headers: { 'content-type': 'application/json' }, remote: R() })).status, 400);
});
