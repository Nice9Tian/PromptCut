import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openAccountLedger } from '../account/ledger.mjs';
import { createAccountAuthority } from '../account/authority.mjs';
import { createProjectMembers } from '../account/project-members.mjs';

const a = 'acc_' + 'a'.repeat(24), b = 'acc_' + 'b'.repeat(24), c = 'acc_' + 'c'.repeat(24);
async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-member-projection-'));
  const ledger = openAccountLedger({ file: path.join(dir, 'doc.sqlite'), authorityId: 'doc-members' });
  let unavailable = false;
  // Real SQLite/authority; account transport and connection inventory are controlled seams.
  const authority = createAccountAuthority({ ledger, pollMs: 0, authorityUrl: 'https://fixture.invalid',
    initializeProject: async () => ({ contentId: 'content' }), accountClient: {
      events: async () => ({ events: [], headSeq: 0 }), verify: async token => {
        if (unavailable) throw Object.assign(Error('account-unavailable'), { status: 503, code: 'account-unavailable' });
        if (!['a', 'b', 'c'].includes(token)) throw Object.assign(Error('login-required'), { status: 401 });
        return { accountId: { a, b, c }[token], accountName: '同名', loginId: `login-${token}`, credentialId: `credential-${token}`,
          loginGeneration: 1, accountEventSeq: 0, expiresAt: Date.now() + 60_000 };
      },
    } });
  t.after(() => { authority.close(); ledger.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const created = await authority.createProject({ accessToken: 'a' }, { name: 'members', requestId: 'create' });
  await authority.joinProject({ accessToken: 'b' }, { projectId: created.projectId, requestId: 'join' });
  const connections = [];
  const snapshot = createProjectMembers({ ledger, authority, getConnections: () => connections });
  const conn = (accountId, deviceId, extras = {}) => ({ transport: 'ws', detached: false, principal: { realm: 'account', identityVersion: 2,
    tenantId: created.projectId, accountId, accountName: '同名', loginId: accountId === a ? 'login-a' : 'login-b',
    deviceId, deviceName: deviceId, role: 'page', accessToken: 'must-never-project', ...extras } });
  return { ledger, authority, connections, snapshot, conn, projectId: created.projectId, unavailable: () => { unavailable = true; } };
}
test('fresh member projection keeps same-name accounts and devices distinct, excludes foreign/detached/LAN, never exposes credentials', async t => {
  const f = await setup(t);
  f.connections.push(f.conn(a, 'a-page'), f.conn(b, 'b-1'), f.conn(b, 'b-2'),
    f.conn(b, 'foreign', { tenantId: 'sp_' + 'z'.repeat(26) }), { ...f.conn(b, 'detached'), detached: true },
    f.conn(b, 'LAN', { realm: 'legacy' }));
  const value = await f.snapshot({ accessToken: 'b' }, { projectId: f.projectId });
  assert.deepEqual(value.members.map(row => [row.accountId, row.accountName]), [[a, '同名'], [b, '同名']]);
  assert.deepEqual(value.devices.map(row => row.deviceId), ['a-page', 'b-1', 'b-2']);
  assert.equal(value.self.creator, false); assert.equal(value.bans, undefined);
  for (const secret of ['accessToken', 'loginId', 'credentialId', 'authorizationId', 'must-never-project', 'requestId'])
    assert.equal(JSON.stringify(value).includes(secret), false, secret);
  await assert.rejects(f.snapshot({ accessToken: 'b' }, { projectId: f.projectId, accountId: a }), { code: 'invalid-project' });
  f.unavailable(); await assert.rejects(f.snapshot({ accessToken: 'b' }, { projectId: f.projectId }), { code: 'account-unavailable' });
});
test('existing creator-only account kick persists ban name, closes display of both devices, idempotent replay/conflict/unban preserve authority semantics', async t => {
  const f = await setup(t); f.connections.push(f.conn(a, 'a'), f.conn(b, 'b-1'), f.conn(b, 'b-2'));
  let value = await f.snapshot({ accessToken: 'a' }, { projectId: f.projectId });
  const body = { projectId: f.projectId, op: 'kick', accountId: b, requestId: 'kick', expectedAccessRevision: value.accessRevision };
  await assert.rejects(f.authority.adminProject({ accessToken: 'b' }, body), { code: 'creator-required' });
  const result = await f.authority.adminProject({ accessToken: 'a' }, body);
  assert.equal(result.completed, false); assert.equal(result.state, 'pending-services');
  assert.deepEqual(await f.authority.adminProject({ accessToken: 'a' }, body), result);
  await assert.rejects(f.authority.adminProject({ accessToken: 'a' }, { ...body, accountId: c }), { code: 'request-mismatch' });
  await assert.rejects(f.snapshot({ accessToken: 'b' }, { projectId: f.projectId }), { code: 'banned' });
  value = await f.snapshot({ accessToken: 'a' }, { projectId: f.projectId });
  assert.deepEqual(value.bans, [{ accountId: b, accountName: '同名', reason: 'kick' }]);
  assert.deepEqual(value.devices.map(row => row.accountId), [a]);
  await assert.rejects(f.authority.adminProject({ accessToken: 'a' }, { ...body, requestId: 'old-revision' }), { code: 'access-revision-mismatch' });
  await f.authority.adminProject({ accessToken: 'a' }, { ...body, op: 'unban', requestId: 'unban', expectedAccessRevision: value.accessRevision });
  assert.equal(f.ledger.read().projects[f.projectId].members[b], undefined, 'unban does not silently rejoin');
  await f.authority.joinProject({ accessToken: 'b' }, { projectId: f.projectId, requestId: 'rejoin' });
  assert.equal((await f.snapshot({ accessToken: 'b' }, { projectId: f.projectId })).self.creator, false);
  const ref = await f.authority.authorizePrincipal({ accessToken: 'a' }, { projectId: f.projectId, trustedRole: 'agent' });
  await assert.rejects(f.authority.adminProject({ authorizationId: ref.authorizationId }, { ...body, requestId: 'agent-admin' }), { code: 'creator-required' });
});
test('snapshot refuses a state revision changed between fresh authorization and synchronous projection', async t => {
  const f = await setup(t);
  const snapshot = createProjectMembers({ ledger: f.ledger, getConnections: () => [], authority: {
    authorizePrincipal: async (...args) => {
      const principal = await f.authority.authorizePrincipal(...args);
      f.ledger.transaction(state => { state.projects[f.projectId].accessRevision++; });
      return principal;
    },
  } });
  await assert.rejects(snapshot({ accessToken: 'a' }, { projectId: f.projectId }), { code: 'members-changed' });
});
test('cloud Agent task connection (no device, run-scoped) is listed under the initiating member, even while that member is offline', async t => {
  const f = await setup(t);
  // 创建者 a 的页面已断开,只剩他的云端 Agent 的任务连接(`doc-agent-assembly.mjs` 给的身份:无设备号,带 runId、service: 'agent')
  const run = f.conn(a, undefined, { role: 'agent', service: 'agent', runId: 'run_1234', userId: a, accountName: '发起人' });
  delete run.principal.deviceId; delete run.principal.deviceName;
  // 没有任务号也没有设备号的连接照旧不列
  const stray = f.conn(a, undefined, { role: 'agent', service: 'agent' });
  delete stray.principal.deviceId;
  f.connections.push(f.conn(b, 'b-page'), run, stray);
  const value = await f.snapshot({ accessToken: 'b' }, { projectId: f.projectId });
  const agentRow = value.devices.find(row => row.accountId === a);
  assert.ok(agentRow, 'initiator row present');
  assert.equal(agentRow.deviceId, 'run:run_1234');
  assert.deepEqual(agentRow.conns, [{ role: 'agent', service: 'agent' }]);
  assert.equal(agentRow.accountName, '同名', 'name comes from the member record, same as the member row');
  assert.equal(value.devices.filter(row => row.accountId === a).length, 1);
  assert.equal(JSON.stringify(value).includes('run_1234') && !JSON.stringify(value).includes('login-a'), true);
});
