import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openAccountLedger } from '../account/ledger.mjs';
import { createLogoutConfirmer } from '../account/logout-confirmer.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-ledger-cache-')), file = path.join(dir, 'doc.sqlite');
  const ledger = openAccountLedger({ file, authorityId: 'ledger-cache' });
  t.after(() => { ledger.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { ledger, file };
}

test('读账本：没变就给同一份缓存，不再整段解析；缓存整个冻住，改它当场报错', t => {
  const { ledger } = fixture(t);
  ledger.transaction(state => { state.projects.p = { status: 'active', members: { a: { access: 'rw' } } }; });
  const first = ledger.read();
  assert.equal(ledger.read(), first);
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.projects.p.members.a));
  assert.throws(() => { first.projects.p.status = 'gone'; }, TypeError);
  assert.throws(() => { first.accessEvents.push({}); }, TypeError);
  assert.equal(ledger.read().projects.p.status, 'active');
});

test('读账本：自己提交过就读到新的；transaction 给的那份可以改，回滚了缓存也不受影响', t => {
  const { ledger } = fixture(t);
  const before = ledger.read();
  ledger.transaction(state => { state.projects.p = { status: 'active' }; });
  const after = ledger.read();
  assert.notEqual(after, before); assert.equal(after.projects.p.status, 'active'); assert.equal(before.projects.p, undefined);
  assert.throws(() => ledger.transaction(state => { state.projects.p.status = 'changed'; throw new Error('rollback'); }), /rollback/);
  assert.equal(ledger.read().projects.p.status, 'active');
  const result = ledger.transaction(state => state.projects.p);
  result.status = 'caller-owned';
  assert.equal(ledger.read(), after);
  assert.equal(ledger.read().projects.p.status, 'active');
});

test('读账本：别的连接（部署脚本等）提交过，也能读到新的', t => {
  const { ledger, file } = fixture(t);
  assert.equal(ledger.read().projects.q, undefined);
  const other = new DatabaseSync(file);
  try {
    const state = JSON.parse(other.prepare('SELECT payload FROM account_authority_state WHERE id=1').get().payload);
    state.projects.q = { status: 'active' };
    other.prepare('UPDATE account_authority_state SET payload=? WHERE id=1').run(JSON.stringify(state));
  } finally { other.close(); }
  assert.equal(ledger.read().projects.q.status, 'active');
});

test('退出续办器：已超时并上报的退出按指数退避拉长重办间隔，kick() 或新退出到达时立刻恢复', async t => {
  const { ledger } = fixture(t);
  let clock = 1_000_000, flushes = 0;
  ledger.transaction(state => {
    state.accessEvents.push({ eventId: 'access:1', seq: 1, createdAt: clock });
    state.barriers['event:logout_1'] = {
      eventId: 'logout_1', accountEventSeq: 1, accessEventId: 'access:1', accessSeq: 1,
      loginIds: ['login_1'], state: 'pending',
      timeout: { since: clock - 60_000, at: clock - 15_000, waitedMs: 45_000, timeoutMs: 45_000, confirmed: ['asset', 'render'], pending: ['doc', 'agent'], reasons: ['logout-pending:doc,agent'], reported: true },
    };
  });
  const authority = {
    flushAccountAcknowledgements: async () => { flushes += 1; },
    revocationStatus: eventId => ({
      ...ledger.read().barriers[`event:${eventId}`],
      serviceAcks: { asset: { complete: true, cursor: 1 }, agent: null, render: { complete: true, cursor: 1 } },
      docConfirmed: false, pendingServices: ['doc', 'agent'], logoutComplete: false,
    }),
    ackAccessEvent: () => {},
    completeLogoutBarrier: () => {},
    recordLogoutTimeout: () => ({ timeout: ledger.read().barriers['event:logout_1'].timeout }),
  };
  const confirmer = createLogoutConfirmer({
    ledger, authority, transportEvidence: () => null, now: () => clock,
    pollMs: 20, maxPollMs: 200, reportTimeout: async () => {},
  });
  t.after(() => confirmer.close());
  confirmer.start();
  await new Promise(r => setTimeout(r, 120));
  // 启动时跑 1 次（退避设为 +40ms）；若时钟不动，后续 20ms 定时器一概跳过，不会每 20ms 刷一次
  assert.equal(flushes, 1);
  // 推进时钟 +40ms：满第一次退避（20 * 2^1 = 40ms），放行第 2 次（下次退避设为 +80ms）
  clock += 40;
  await new Promise(r => setTimeout(r, 50));
  assert.equal(flushes, 2);
  // 只推进 +40ms（不足 +80ms）：不重办
  clock += 40;
  await new Promise(r => setTimeout(r, 50));
  assert.equal(flushes, 2);
  // kick() 当场唤醒并重置退避
  confirmer.kick();
  await new Promise(r => setTimeout(r, 30));
  assert.equal(flushes, 3);
});
