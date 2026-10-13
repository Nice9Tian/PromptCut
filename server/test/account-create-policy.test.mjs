/**
 * 「谁可以新建云端项目、每人能建多少」的判断口子（docs/plan/online-browser-task.md 第一步第 4 条）。
 * 缺省行为和以前完全一样：登录了的账号都能建、不限数量；配置成上限 N 后第 N+1 个被拒，回明确的码。
 *
 * 跑:npm test -- server/test/account-create-policy.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openAccountLedger } from '../account/ledger.mjs';
import { createAccountAuthority } from '../account/authority.mjs';

const A = 'acc_' + 'a'.repeat(24), B = 'acc_' + 'b'.repeat(24), C = 'acc_' + 'c'.repeat(24);

async function open(t, createPolicy) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-create-policy-'));
  const ledger = openAccountLedger({ file: path.join(dir, 'doc.sqlite'), authorityId: 'policy-doc' });
  const principals = new Map([[A, 'Alice'], [B, 'Bob'], [C, 'Carol']].map(([accountId, accountName]) => [accountId, { identityVersion: 2, realm: 'account', accountId,
    accountName, loginId: `login-${accountId}`, credentialId: `cred-${accountId}`, loginGeneration: 1, expiresAt: Date.now() + 600_000, accountEventSeq: 0 }]));
  const authority = createAccountAuthority({ ledger, pollMs: 0, ...(createPolicy === undefined ? {} : { createPolicy }),
    accountClient: { async verify(token) { if (!principals.has(token)) throw Object.assign(new Error('bad token'), { status: 401, code: 'unauthorized' }); return structuredClone(principals.get(token)); },
      async events() { return { events: [], headSeq: 0 }; } },
    initializeProject: async () => ({ contentId: 'policy-content' }) });
  await authority.start();
  t.after(() => { authority.close(); ledger.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  let serial = 0;
  const create = (token, extra = {}) => { serial++; return authority.createProject({ accessToken: token }, { name: `proj-${serial}`, requestId: `req-${serial}`, ...extra }); };
  return { authority, ledger, create };
}
const code = async promise => { try { await promise; return null; } catch (error) { return { status: error.status, code: error.code ?? error.message }; } };

test('缺省：登录了的账号都能建，不限数量', async t => {
  const { create } = await open(t);
  for (let i = 0; i < 6; i++) assert.ok((await create(A)).projectId, `第 ${i + 1} 个`);
  assert.ok((await create(B)).projectId);
});

test('缺省：没登录（凭证核对不过）仍然建不了', async t => {
  const { create } = await open(t);
  assert.ok(await code(create('not-a-login')), '没登录被拒');
});

test('配置上限 N：第 N 个放行，第 N+1 个被拒并回 project-limit-reached；别的账号不受牵连', async t => {
  const { create, ledger } = await open(t, { maxProjectsPerAccount: 2 });
  await create(A); await create(A);
  const refused = await code(create(A));
  assert.deepEqual(refused, { status: 403, code: 'project-limit-reached' });
  assert.equal(Object.values(ledger.read().projects).filter(p => p.creatorAccountId === A).length, 2, '被拒的没有留下半个项目');
  assert.ok((await create(B)).projectId, '别的账号照建');
});

test('上限按账号数账本里的项目：已删除的不占名额；重复的 requestId 回放不算新建', async t => {
  const { create, ledger, authority } = await open(t, { maxProjectsPerAccount: 1 });
  const first = await create(A, { name: 'only', requestId: 'same' });
  assert.deepEqual(await authority.createProject({ accessToken: A }, { name: 'only', requestId: 'same' }), first, '同一次新建的重试原样回放，不被上限挡');
  assert.equal((await code(create(A)))?.code, 'project-limit-reached');
  ledger.transaction(state => { state.projects[first.projectId].status = 'deleted'; });
  assert.ok((await create(A)).projectId, '删掉一个之后又有名额');
});

test('上限 0：谁都不能建；上限配置不合法时工厂直接报错', async t => {
  const { create } = await open(t, { maxProjectsPerAccount: 0 });
  assert.equal((await code(create(A)))?.code, 'project-limit-reached');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-create-policy-bad-'));
  const ledger = openAccountLedger({ file: path.join(dir, 'doc.sqlite'), authorityId: 'bad' });
  t.after(() => { ledger.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  for (const bad of [{ maxProjectsPerAccount: -1 }, { maxProjectsPerAccount: 1.5 }, { maxProjectsPerAccount: '3' }, { canCreate: 'yes' }, null])
    assert.throws(() => createAccountAuthority({ ledger, accountClient: {}, createPolicy: bad }), /create-policy-configuration/, JSON.stringify(bad));
});

test('自定义判断 canCreate：返回 false 拒绝（缺省码 create-not-allowed），返回 { code } 用自己的码，先于数量上限', async t => {
  const seen = [];
  const { create } = await open(t, { maxProjectsPerAccount: 99, canCreate(ctx) { seen.push(ctx); return ctx.accountId === A ? true : ctx.accountName === 'Bob' ? { code: 'beta-only' } : false; } });
  assert.ok((await create(A)).projectId);
  assert.deepEqual(await code(create(B)), { status: 403, code: 'beta-only' });
  assert.deepEqual(await code(create(C)), { status: 403, code: 'create-not-allowed' });
  assert.deepEqual(seen.map(s => [s.accountId, s.ownedCount]), [[A, 0], [B, 0], [C, 0]], '判断拿到的是账号和它名下已有的个数');
});
