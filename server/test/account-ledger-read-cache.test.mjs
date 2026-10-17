import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openAccountLedger } from '../account/ledger.mjs';

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
