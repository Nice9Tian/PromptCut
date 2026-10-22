/**
 * 游客在真的账号权威（`server/account/authority.mjs`）上跑一遍：自签令牌进得来、自己建的项目只能一个、
 * 进别人的项目一律只读、账号服务挂了也不影响游客。
 *
 * 跑：npm test -- server/test/account-guest-authority.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { openAccountLedger } from '../account/ledger.mjs';
import { createAccountAuthority } from '../account/authority.mjs';
import { GUEST_LIMITS, signGuestToken } from '../account/guest.mjs';

const A = 'acc_' + 'a'.repeat(24);
const guestKey = randomBytes(32);

async function open(t, { key = guestKey } = {}) {
  /** 起好之后才拔账号服务的网线：`authority.start()` 自己要先同步一次事件 */
  const down = { now: false };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-guest-authority-'));
  const ledger = openAccountLedger({ file: path.join(dir, 'doc.sqlite'), authorityId: 'guest-doc' });
  const account = { identityVersion: 2, realm: 'account', accountId: A, accountName: 'Alice', loginId: `login-${A}`,
    credentialId: `cred-${A}`, loginGeneration: 1, expiresAt: Date.now() + 600_000, accountEventSeq: 0 };
  const authority = createAccountAuthority({ ledger, pollMs: 0, guestKey: key,
    accountClient: {
      async verify(token) {
        if (down.now) throw Object.assign(new Error('down'), { status: 503, code: 'account-unavailable' });
        if (token !== A) throw Object.assign(new Error('bad token'), { status: 401, code: 'unauthorized' });
        return structuredClone(account);
      },
      async events() { if (down.now) throw Object.assign(new Error('down'), { status: 503, code: 'account-unavailable' }); return { events: [], headSeq: 0 }; },
    },
    initializeProject: async () => ({ contentId: 'guest-content' }) });
  await authority.start();
  t.after(() => { authority.close(); ledger.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  let serial = 0;
  const create = (token, extra = {}) => { serial++; return authority.createProject({ accessToken: token }, { name: `proj-${serial}`, requestId: `req-${serial}`, ...extra }); };
  return { authority, ledger, create, down };
}
const code = async promise => { try { await promise; return null; } catch (error) { return { status: error.status, code: error.code ?? error.message }; } };
/** 新游客一枚：令牌 + 编号 */
const guest = (at = Date.now()) => signGuestToken({ key: guestKey, at });

test('游客凭自签令牌进得来，建得了项目，而且是自己项目的创建者（读写）', async t => {
  const { authority, create } = await open(t);
  const g = guest();
  const made = await create(g.token);
  assert.ok(made.projectId);
  const principal = await authority.authorizePrincipal({ accessToken: g.token }, { projectId: made.projectId, action: 'write' });
  assert.equal(principal.accountId, g.guestId);
  assert.equal(principal.creator, true);
  assert.equal(principal.access, 'rw', '自己建的项目里照常读写');
  assert.equal(principal.loginId, `guest:${g.guestId}`);
});

test('游客只能建一个项目，第二个回 guest-project-limit；账号不受这一条影响', async t => {
  const { create } = await open(t);
  const g = guest();
  await create(g.token);
  assert.deepEqual(await code(create(g.token)), { status: 403, code: 'guest-project-limit' });
  assert.equal(GUEST_LIMITS.projects, 1);
  for (let i = 0; i < 3; i++) assert.ok((await create(A)).projectId, `账号的第 ${i + 1} 个`);
  // 换一个游客身份又能建一个,互不相干
  assert.ok((await create(guest().token)).projectId);
});

test('游客进别人的项目一律只读：落账记 r，写操作回 guest-read-only', async t => {
  const { authority, create } = await open(t);
  const owned = await create(A);
  const g = guest();
  const joined = await authority.joinProject({ accessToken: g.token }, { projectId: owned.projectId, requestId: 'join-1' });
  assert.equal(joined.access, 'r', '落账就该记只读');

  const read = await authority.authorizePrincipal({ accessToken: g.token }, { projectId: owned.projectId, action: 'read' });
  assert.equal(read.access, 'r');
  assert.equal(read.creator, false);
  assert.deepEqual(await code(authority.authorizePrincipal({ accessToken: g.token }, { projectId: owned.projectId, action: 'write' })),
    { status: 403, code: 'guest-read-only' });
  // 「改设置、踢人」这类本来就只有创建者能做,游客撞的是那一条,不必另给一个码
  assert.deepEqual(await code(authority.authorizePrincipal({ accessToken: g.token }, { projectId: owned.projectId, action: 'admin' })),
    { status: 403, code: 'creator-required' });
});

test('名单里给游客写了读写也按只读算：拦在 permission 这一个口子上', async t => {
  const { authority, ledger, create } = await open(t);
  const owned = await create(A);
  const g = guest();
  await authority.joinProject({ accessToken: g.token }, { projectId: owned.projectId, requestId: 'join-1' });
  ledger.transaction(state => { state.projects[owned.projectId].members[g.guestId].access = 'rw'; });
  assert.equal((await authority.authorizePrincipal({ accessToken: g.token }, { projectId: owned.projectId, action: 'read' })).access, 'r');
  assert.deepEqual(await code(authority.authorizePrincipal({ accessToken: g.token }, { projectId: owned.projectId, action: 'write' })),
    { status: 403, code: 'guest-read-only' });
});

test('账号服务挂了，游客照样进得来（令牌不问它）', async t => {
  const { authority, create, down } = await open(t);
  const g = guest();
  down.now = true;
  assert.ok((await code(create(A)))?.status, '账号这条路这时候本来就该进不来');
  const made = await create(g.token);
  assert.ok(made.projectId, '游客不该被账号服务的故障带下水');
  assert.equal((await authority.authorizePrincipal({ accessToken: g.token }, { projectId: made.projectId, action: 'write' })).access, 'rw');
});

test('令牌过期、被改过、或者这台服务没配密钥，都进不来', async t => {
  const { create } = await open(t);
  const old = signGuestToken({ key: guestKey, at: Date.now() - GUEST_LIMITS.tokenTtlMs - 60_000 });
  assert.deepEqual(await code(create(old.token)), { status: 401, code: 'credential-revoked' });
  const g = guest();
  const tampered = g.token.slice(0, 4) + (g.token[4] === 'a' ? 'b' : 'a') + g.token.slice(5);
  assert.deepEqual(await code(create(tampered)), { status: 401, code: 'credential-revoked' });
  assert.deepEqual(await code(create(signGuestToken({ key: randomBytes(32), at: Date.now() }).token)),
    { status: 401, code: 'credential-revoked' }, '别的密钥签的不认');

  const noKey = await open(t, { key: null });
  assert.deepEqual(await code(noKey.create(guest().token)), { status: 503, code: 'guest-unavailable' });
});

test('游客被踢之后进不去，和账号一样', async t => {
  const { authority, ledger, create } = await open(t);
  const owned = await create(A);
  const g = guest();
  await authority.joinProject({ accessToken: g.token }, { projectId: owned.projectId, requestId: 'join-1' });
  ledger.transaction(state => {
    const p = state.projects[owned.projectId];
    delete p.members[g.guestId];
    p.bans[g.guestId] = { reason: 'kick' };
  });
  assert.deepEqual(await code(authority.authorizePrincipal({ accessToken: g.token }, { projectId: owned.projectId, action: 'read' })),
    { status: 403, code: 'banned' });
  assert.deepEqual(await code(authority.joinProject({ accessToken: g.token }, { projectId: owned.projectId, requestId: 'join-2' })),
    { status: 403, code: 'banned' });
});

test('三天清理：游客建的项目到点标成已删除，账号建的一个都不碰', async t => {
  const { authority, ledger, create } = await open(t);
  const g = guest(), g2 = guest();
  const mine = await create(g.token);
  const fresh = await create(g2.token);
  const owned = await create(A);
  // 把一个游客项目的生日拨到三天零一秒之前
  const born = Date.now() - GUEST_LIMITS.ttlMs - 1000;
  ledger.transaction(state => { state.projects[mine.projectId].createdAt = born; });

  const swept = authority.sweepExpiredGuestProjects();
  assert.deepEqual(swept, [mine.projectId], '只该清到点的那一个');
  const after = ledger.read().projects;
  assert.equal(after[mine.projectId].status, 'deleted');
  assert.ok(after[mine.projectId].tombstone, '该落墓碑，和创建者自己点删项目走同一条路');
  assert.equal(after[fresh.projectId].status, 'active', '没到点的游客项目不动');
  assert.equal(after[owned.projectId].status, 'active', '账号建的一个都不碰');
  // 清掉之后那个游客进不去了,也不再占他的名额
  assert.equal((await code(authority.authorizePrincipal({ accessToken: g.token }, { projectId: mine.projectId, action: 'read' })))?.status, 404);
  assert.ok((await create(g.token)).projectId, '清掉的不占名额，可以再建一个');
  // 再扫一趟没有新的可清:不重复落事件
  assert.deepEqual(authority.sweepExpiredGuestProjects(), []);
});

test('三天清理：这条规矩之前建的老项目没有生日，一律不动', async t => {
  const { authority, ledger, create } = await open(t);
  const g = guest();
  const mine = await create(g.token);
  ledger.transaction(state => { delete state.projects[mine.projectId].createdAt; });
  assert.deepEqual(authority.sweepExpiredGuestProjects(Date.now() + GUEST_LIMITS.ttlMs * 10), [], '生日不详就不猜，不误删');
  assert.equal(ledger.read().projects[mine.projectId].status, 'active');
});

test('领令牌：不带旧的就给新身份，带着没过期的旧令牌就续期、编号不变', async t => {
  const { authority } = await open(t);
  const first = authority.issueGuest(null);
  assert.match(first.guestId, /^gst_[0-9a-f]{24}$/);
  assert.equal(first.renewed, false);
  const again = authority.issueGuest(null);
  assert.notEqual(again.guestId, first.guestId, '不带旧令牌就是另一个人');

  const renewed = authority.issueGuest(first.token);
  assert.equal(renewed.guestId, first.guestId, '带着旧令牌回来还是同一个人');
  assert.equal(renewed.renewed, true);
  // 过期的、改过的、别人密钥签的,都只当没带:给新身份,不报错
  const expired = signGuestToken({ key: guestKey, at: Date.now() - GUEST_LIMITS.tokenTtlMs - 60_000 });
  assert.notEqual(authority.issueGuest(expired.token).guestId, expired.guestId);
  assert.notEqual(authority.issueGuest(signGuestToken({ key: randomBytes(32), at: Date.now() }).token).guestId, first.guestId);
  // 请求体里写什么编号都不收:只有令牌说了算
  assert.notEqual(authority.issueGuest('gst_' + 'f'.repeat(24)).guestId, 'gst_' + 'f'.repeat(24));

  const noKey = await open(t, { key: null });
  assert.throws(() => noKey.authority.issueGuest(null), e => e.code === 'guest-unavailable' && e.status === 503);
});
