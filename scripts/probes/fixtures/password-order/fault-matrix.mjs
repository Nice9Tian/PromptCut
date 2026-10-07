import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { fixture, keys, saveKeys, accountFixture, spec, actor } from '../../../../server/test/password-order-fixture.mjs';

export const CRASH_CASES = [
  ['history:prepared-before-commit', 0], ['doc:prepared-after-commit', 0],
  ['account:reserve-before-commit', 0], ['account:reserve-after-commit', 0],
  ['history:reserved-before-commit', 0], ['doc:reserved-after-commit', 0], ['doc:before-seal', 0],
  ['account:seal-after-sequence', 0], ['account:seal-before-commit', 0],
  ['account:seal-after-commit', 1], ['doc:seal-ack', 1], ['history:accepted-before-commit', 1],
  ['doc:accepted-after-commit', 1], ['history:materialize-before-commit', 1], ['doc:materialize-after-commit', 1],
  ['history:fence-before-commit', 1], ['doc:fence-after-commit', 1],
  ['history:fence-request-before-commit', 1], ['doc:fence-request-after-commit', 1],
  ['history:fence-ack-before-commit', 1], ['doc:fence-ack-after-commit', 1],
  ['account:cancel-before-commit', 0], ['account:cancel-after-commit', 0], ['history:cancelled-before-commit', 0],
];
export async function runFaultMatrix(out) {
  if (!process.env.PROMPTCUT_ACCOUNT_PROVIDER_ROOT || !process.env.PROMPTCUT_PASSWORD_ORDER_MODULE) throw new Error('Fault matrix requires the actual account provider and order module');
  fs.mkdirSync(out, { recursive: true }); const results = [];
  for (const [phase, expectedRev] of CRASH_CASES) {
    const dir = fs.mkdtempSync(path.join(out, 'crash-')); const pair = keys(); saveKeys(path.join(dir, 'keys.json'), pair);
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./crash-child.mjs', import.meta.url)), dir, phase], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
    fs.writeFileSync(path.join(dir, 'child.log'), `${child.stdout ?? ''}${child.stderr ?? ''}`);
    assert.equal(child.status, 73, `${phase}: actual abrupt exit was not reached; ${child.error?.code ?? child.stderr}`);
    const f = await fixture({ dir, pair, actual: true });
    try {
      await f.coordinator.recover('project-one');
      assert.equal(f.history.snapshot('project-one').projectRev, expectedRev, phase);
      assert.equal(f.history.accepted('project-one').length, expectedRev, phase);
      assert.equal(fs.readFileSync(path.join(dir, 'external-effects.log'), 'utf8').trim().split('\n').length, 1, 'Recovery must not invoke external work again');
      assert.equal(f.history.pending('project-one').length, 0);
      f.history.validate('project-one');
      if (phase.includes('fence-') && phase !== 'history:fence-request-before-commit') {
        await assert.rejects(f.coordinator.submit(spec('after-stop', { expectedRev, principal: { ...actor, runGrantId: 'grant', runId: 'run', messageId: 'message', conversationId: 'conversation' } })), { code: 'operation-fenced' });
      }
      results.push({ phase, exitCode: child.status, projectRev: expectedRev, effects: 1, pending: 0, passed: true });
    } finally { f.close(); }
  }
  for (const phase of ['logout-before-commit', 'logout-after-commit']) {
    const dir = fs.mkdtempSync(path.join(out, 'logout-')); const pair = keys(); saveKeys(path.join(dir, 'keys.json'), pair);
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./crash-child.mjs', import.meta.url)), dir, `account:${phase}`], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
    fs.writeFileSync(path.join(dir, 'child.log'), `${child.stdout ?? ''}${child.stderr ?? ''}`); assert.equal(child.status, 73);
    const account = await accountFixture({ dir, pair, actual: true });
    try {
      const witness = account.store.witnessByRequest('logout-proof');
      if (phase === 'logout-before-commit') { assert.equal(witness, null); assert.equal(account.store.orderHead(), 2); }
      else { assert.equal(witness.state, 'sealed'); assert.equal(account.store.passwordEvent(witness.eventId).logout_state, 'complete'); assert.equal(account.store.orderHead(), witness.orderSeq); }
      results.push({ phase, exitCode: 73, sealed: Boolean(witness), atomic: true, passed: true });
    } finally { account.close(); }
  }
  for (const phase of ['password-after-hash', 'password-after-event', 'password-after-outbox']) {
    const dir = fs.mkdtempSync(path.join(out, 'password-')); const pair = keys(); saveKeys(path.join(dir, 'keys.json'), pair);
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./crash-child.mjs', import.meta.url)), dir, `store:${phase}`], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
    fs.writeFileSync(path.join(dir, 'child.log'), `${child.stdout ?? ''}${child.stderr ?? ''}`);
    assert.equal(child.status, 73);
    const account = await accountFixture({ dir, pair, actual: true });
    try { assert.equal(account.store.accountById(actor.accountId).pw, 'fixture-only-hash'); assert.equal(account.store.orderHead(), 0); assert.equal(account.store.events().events.length, 0); results.push({ phase, exitCode: 73, passwordRolledBack: true, orderHead: 0, outboxRows: 0, passed: true }); }
    finally { account.close(); }
  }
  for (const missing of ['account-witness', 'doc-prepared', 'doc-payload', 'doc-journal-payload']) {
    const dir = fs.mkdtempSync(path.join(out, 'missing-')); const pair = keys(); let f = await fixture({ dir, pair, actual: true });
    await f.coordinator.submit(spec('original')); f.close();
    const db = new DatabaseSync(path.join(dir, missing === 'account-witness' ? 'account.db' : 'history.db'));
    if (missing === 'account-witness') db.exec('DELETE FROM order_witnesses');
    else if (missing === 'doc-prepared') db.exec('DELETE FROM operations');
    else if (missing === 'doc-payload') db.exec("UPDATE operations SET prepared=json_set(prepared,'$.before.title','corrupted')");
    else db.exec("UPDATE journal SET payload=json_set(payload,'$.before.title','corrupted') WHERE kind='prepared-op'");
    db.close();
    f = await fixture({ dir, pair, actual: true });
    try { await assert.rejects(f.coordinator.recover('project-one'), { code: 'needs-reconciliation' }); results.push({ missing, state: 'needs-reconciliation', passed: true }); }
    finally { f.close(); }
  }
  fs.writeFileSync(path.join(out, 'fault-results.json'), JSON.stringify({ mode: 'actual-foundation-sqlite', results }, null, 2));
  return results;
}
