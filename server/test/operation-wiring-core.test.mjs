import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { operationFixture } from './operation-wiring-fixture.mjs';
import { ask } from './fake-docservice-env.mjs';
import { actorOf } from '../docservice/modules/actor.mjs';
import { stateBlobName } from '../docservice/modules/project.mjs';
import { DatabaseSync } from 'node:sqlite';

const actual = { skip: !process.env.PROMPTCUT_ACCOUNT_PROVIDER_ROOT && 'Explicit actual account provider required' };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pc-operation-wiring-'));
const open = (c, projectId) => ask(c, { type: 'project.open', projectId }, 10000);
const op = (c, projectId, opId, value = opId, extra = {}) => ask(c, { type: 'project.op', projectId, opId, ops: [{ op: 'set', path: '/title', value }], ...extra }, 10000);

test('operation-wiring actor v2 uses trusted principal; LAN actor shape stays identical', () => {
  assert.deepEqual(actorOf({ userId: 'lan' }, 'tab'), { userId: 'lan', session: 'tab' });
  assert.throws(() => actorOf({ realm: 'account', identityVersion: 2 }, null), /invalid-account-principal/);
});

test('operation-wiring real two WS pages, real authority, full history and original store restart', actual, async t => {
  const dir = tmp(); let f = await operationFixture({ dir }); t.after(async () => { await f.close(); });
  const a = await f.connect('a'), b = await f.connect('b');
  assert.equal((await open(b, f.projectId)).rev, 1);
  const beforeChecks = f.counts.credentialChecks;
  const reply = await op(a, f.projectId, 'one', 'changed', { actor: { accountId: 'forged' }, accountId: 'forged', loginId: 'forged', runGrantId: 'forged' });
  assert.equal(reply.type, 'project.op.ok'); assert.equal(reply.rev, 2);
  const seen = await b.next(m => m.type === 'project.ops');
  const principal = f.account.credentials.verify(f.sessions.a.accessToken);
  assert.equal(seen.actor.accountId, principal.accountId); assert.equal(seen.actor.loginId, principal.loginId); assert.equal(seen.actor.runGrantId, undefined);
  assert.ok(f.counts.credentialChecks - beforeChecks >= 4, 'entry and both commit phases recheck real credential');
  const accepted = f.history.accepted(f.projectId);
  assert.equal(accepted.length, 1); assert.equal(accepted[0].before.title, 'before'); assert.equal(accepted[0].after.title, 'changed');
  assert.equal(accepted[0].changes[0].before.value, 'before');
  const saved = JSON.parse(f.store.readBlob(stateBlobName(f.projectId)));
  assert.equal(saved.orderProjection.orderSeq, reply.orderSeq); assert.equal(saved.history.at(-1).actor.loginId, principal.loginId);
  const duplicate = await op(a, f.projectId, 'one', 'changed'); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.rev, 2);
  assert.equal((await op(b, f.projectId, 'one', 'changed')).reason, 'operation-id-mismatch');
  await f.close(); f = await operationFixture({ dir });
  assert.equal(f.project.bodyOf(f.projectId), null, 'unreconciled startup is hidden');
  const c = await f.connect(); const restored = await open(c, f.projectId);
  assert.equal(restored.project.title, 'changed'); assert.equal(restored.rev, 2);
  assert.equal(f.history.accepted(f.projectId).length, 1);
});

test('operation-wiring reserved is invisible; delete fence closes own WS immediately and another project progresses', actual, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(); let paused = false, ackRev;
  const f = await operationFixture({ dir: tmp(), request: async (args, invoke) => {
    const result = await invoke(args);
    if (args.path.endsWith('/reserve') && !paused) { paused = true; entered.resolve(); await release.promise; }
    return result;
  }, acknowledgeFence: async () => {
    assert.equal(f.history.pending(f.projectId).length, 0);
    ackRev = JSON.parse(f.store.readBlob(stateBlobName(f.projectId))).rev;
    return { durable: true, rev: ackRev };
  } });
  t.after(async () => { release.resolve(); await f.close(); });
  const a = await f.connect(), b = await f.connect('b'); await open(b, f.projectId);
  a.send({ type: 'project.op', projectId: f.projectId, opId: 'pending', ops: [{ op: 'set', path: '/title', value: 'unaccepted' }] });
  await entered.promise;
  assert.equal(JSON.parse(f.store.readBlob(stateBlobName(f.projectId))).project.title, 'before');
  assert.equal(a.all.some(m => m.type === 'project.op.ok'), false); assert.equal(b.all.some(m => m.type === 'project.ops'), false);
  const other = await f.authority.createProject({ accessToken: f.sessions.a.accessToken }, { requestId: 'another', name: 'Other', initialProject: { title: 'other' } });
  const c = await f.connect('a', other.projectId);
  assert.equal((await op(c, other.projectId, 'independent')).type, 'project.op.ok');
  let completed = false;
  const fence = f.coordinator.fence({ id: 'delete-pending', projectId: f.projectId, kind: 'delete' }).then(value => { completed = true; return value; });
  await Promise.all([a.closed, b.closed]);
  assert.equal(completed, false, 'connection close is not fence completion');
  release.resolve(); const result = await fence;
  assert.equal(result.complete, true); assert.equal(ackRev, 1);
  assert.equal(f.history.get(f.projectId, 'pending').state, 'cancelled');
  assert.equal(f.history.accepted(f.projectId).length, 0);
  const d = await f.connect(); assert.equal((await op(d, f.projectId, 'after')).reason, 'operation-fenced');
});

test('operation-wiring sealed ACK uncertainty completes SAME prepared before durable fence ACK', actual, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(); let paused = false, ackSnapshot;
  const f = await operationFixture({ dir: tmp(), request: async (args, invoke) => {
    const result = await invoke(args);
    if (args.path.endsWith('/seal') && !paused) { paused = true; entered.resolve(); await release.promise; throw Object.assign(new Error('lost ACK'), { code: 'order-outcome-unknown' }); }
    return result;
  }, acknowledgeFence: async () => {
    ackSnapshot = JSON.parse(f.store.readBlob(stateBlobName(f.projectId)));
    assert.equal(f.history.pending(f.projectId).length, 0);
    return { durable: true, rev: ackSnapshot.rev };
  } });
  t.after(async () => { release.resolve(); await f.close(); });
  const a = await f.connect(), b = await f.connect('b'); await open(b, f.projectId);
  a.send({ type: 'project.op', projectId: f.projectId, opId: 'sealed', ops: [{ op: 'set', path: '/title', value: 'sealed-value' }] });
  await entered.promise;
  const fence = f.coordinator.fence({ id: 'delete-sealed', projectId: f.projectId, kind: 'delete' });
  await Promise.all([a.closed, b.closed]);
  assert.equal(JSON.parse(f.store.readBlob(stateBlobName(f.projectId))).rev, 1);
  release.resolve(); assert.equal((await fence).complete, true);
  assert.equal(ackSnapshot.rev, 2); assert.equal(ackSnapshot.project.title, 'sealed-value');
  assert.equal(f.history.journal(f.projectId).filter(row => row.kind === 'prepared-op').length, 1);
  assert.equal(b.all.filter(m => m.type === 'project.ops').length, 0, 'closed observer receives no later bytes');
});

test('operation-wiring real credential revoked in reserve/seal gap is rejected despite cached creator principal', actual, async t => {
  let revoked = false;
  const f = await operationFixture({ dir: tmp(), request: async (args, invoke) => {
    const result = await invoke(args);
    if (args.path.endsWith('/reserve') && !revoked) { revoked = true; f.account.choose(f.account.change(), true); }
    return result;
  } }); t.after(() => f.close());
  const a = await f.connect(), b = await f.connect('b'); await open(b, f.projectId);
  const reply = await op(a, f.projectId, 'revoked');
  assert.equal(reply.type, 'project.op.rejected');
  assert.equal(f.history.get(f.projectId, 'revoked').state, 'cancelled');
  assert.equal(f.history.accepted(f.projectId).length, 0);
  assert.equal(JSON.parse(f.store.readBlob(stateBlobName(f.projectId))).rev, 1);
  assert.equal(b.all.some(m => m.type === 'project.ops'), false);
});

test('operation-wiring password retain plus backward UTC preserves seal order and full equal-write versions', actual, async t => {
  let event, changed = false; const clock = { now: 100 };
  const f = await operationFixture({ dir: tmp(), clock, request: async (args, invoke) => {
    const result = await invoke(args);
    if (args.path.endsWith('/reserve') && !changed) { changed = true; event = f.account.change(); f.account.choose(event, false); clock.now = 90; }
    return result;
  } }); t.after(() => f.close());
  const a = await f.connect(), b = await f.connect('b');
  assert.equal((await op(a, f.projectId, 'after-password', 'equal')).type, 'project.op.ok');
  assert.equal((await op(b, f.projectId, 'same-value-other-login', 'equal')).type, 'project.op.ok');
  const [first, second] = f.history.accepted(f.projectId);
  assert.ok(first.witness.orderSeq > event.change_seq); assert.ok(second.witness.orderSeq > first.witness.orderSeq);
  assert.notEqual(first.actor.loginId, second.actor.loginId);
  assert.equal(second.changes.length, 1); assert.equal(second.changes[0].before.value, second.changes[0].after.value);
  assert.equal(second.changes[0].beforeVersion, first.changes[0].afterVersion);
});

test('operation-wiring trusted run has no implicit retained authority when provider is missing', actual, async t => {
  const f = await operationFixture({ dir: tmp(), principalTransform: p => ({ ...p, role: 'agent', runId: 'run', runGrantId: 'grant', conversationId: 'conversation', messageId: 'message' }) });
  t.after(() => f.close()); const a = await f.connect();
  assert.equal((await op(a, f.projectId, 'no-provider')).reason, 'run-provider-unavailable');
  assert.equal(f.history.accepted(f.projectId).length, 0);
});

for (const kind of ['stop', 'private']) test(`operation-wiring ${kind} fence cancels a reserved trusted run at real WS entry`, actual, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(); let once = false;
  const f = await operationFixture({ dir: tmp(), principalTransform: p => ({ ...p, role: 'agent', runId: 'run', runGrantId: 'grant', conversationId: 'conversation', messageId: 'message' }),
    runProvider: { async checkAccess({ principal, projectId, action }) { await f.authority.checkAccess({ principal, projectId, action }); return { allowed: true }; } },
    request: async (args, invoke) => { const result = await invoke(args); if (args.path.endsWith('/reserve') && !once) { once = true; entered.resolve(); await release.promise; } return result; },
    acknowledgeFence: async () => ({ durable: true }),
  }); t.after(async () => { release.resolve(); await f.close(); });
  const a = await f.connect();
  a.send({ type: 'project.op', projectId: f.projectId, opId: kind, ops: [{ op: 'set', path: '/title', value: 'forbidden-run' }] });
  await entered.promise;
  const fence = f.coordinator.fence({ id: kind, projectId: f.projectId, kind,
    ...(kind === 'stop' ? { runId: 'run' } : { runIds: ['run'], conversationId: 'conversation', ownerAccountId: 'acc_' + '2'.repeat(24) }) });
  await a.closed; release.resolve(); assert.equal((await fence).complete, true);
  assert.equal(f.history.get(f.projectId, kind).state, 'cancelled');
  assert.equal(JSON.parse(f.store.readBlob(stateBlobName(f.projectId))).project.title, 'before');
});

test('operation-wiring simultaneous two-page operations share preparation baseline lock', actual, async t => {
  const f = await operationFixture({ dir: tmp() }); t.after(() => f.close());
  const a = await f.connect(), b = await f.connect('b');
  const results = await Promise.all([op(a, f.projectId, 'concurrent-a'), op(b, f.projectId, 'concurrent-b')]);
  assert.deepEqual(results.map(r => r.rev).sort(), [2, 3]);
  const [first, second] = f.history.accepted(f.projectId);
  assert.deepEqual(second.before, first.after); assert.equal(second.expectedRev, first.projectRev);
});

test('operation-wiring original-store projection error cannot send ok/broadcast; retry uses original immutable record', actual, async t => {
  let fail = true;
  const f = await operationFixture({ dir: tmp(), projectionFailpoint: phase => { if (phase === 'projection-before-write' && fail) throw Object.assign(new Error('controlled-file-failure'), { code: 'controlled-file-failure' }); } });
  t.after(() => f.close()); const a = await f.connect(), b = await f.connect('b'); await open(b, f.projectId);
  assert.equal((await op(a, f.projectId, 'file-failure')).reason, 'controlled-file-failure');
  assert.equal(a.all.some(m => m.type === 'project.op.ok'), false); assert.equal(b.all.some(m => m.type === 'project.ops'), false);
  assert.equal(JSON.parse(f.store.readBlob(stateBlobName(f.projectId))).rev, 1);
  const original = f.history.get(f.projectId, 'file-failure'); assert.equal(original.state, 'materialized');
  fail = false;
  assert.equal((await op(a, f.projectId, 'file-failure')).duplicate, true);
  assert.equal(f.history.get(f.projectId, 'file-failure').preparedDigest, original.preparedDigest);
  assert.equal(JSON.parse(f.store.readBlob(stateBlobName(f.projectId))).rev, 2);
});

test('operation-wiring invalid seal signature rejects before visible original-store materialization', actual, async t => {
  let bad = true;
  const f = await operationFixture({ dir: tmp(), request: async (args, invoke) => {
    const result = await invoke(args); return args.path.endsWith('/seal') && bad ? { ...result, signature: 'invalid' } : result;
  } }); t.after(() => f.close()); const a = await f.connect();
  assert.equal((await op(a, f.projectId, 'bad-signature')).reason, 'bad-witness');
  assert.equal(JSON.parse(f.store.readBlob(stateBlobName(f.projectId))).rev, 1); assert.equal(f.history.accepted(f.projectId).length, 0);
  bad = false; assert.equal((await open(a, f.projectId)).rev, 2, 'query authentic sealed witness restores same prepared');
});

for (const corruption of ['newer-projection', 'same-rev-content', 'same-rev-actor', 'missing-prepared-log', 'missing-account-witness', 'missing-history']) {
  test(`operation-wiring restart refuses ${corruption} without inventing accepted contents`, actual, async t => {
    const dir = tmp(); let f = await operationFixture({ dir }); let closed = false;
    t.after(async () => { if (!closed) await f.close(); });
    const a = await f.connect(); assert.equal((await op(a, f.projectId, 'durable')).type, 'project.op.ok');
    const projectId = f.projectId, store = f.store;
    const accepted = f.history.accepted(projectId)[0];
    await f.close(); closed = true;
    if (corruption.endsWith('projection') || corruption.startsWith('same-rev')) {
      const saved = JSON.parse(store.readBlob(stateBlobName(projectId)));
      if (corruption === 'newer-projection') saved.rev++;
      else if (corruption === 'same-rev-content') saved.project.title = 'unproved';
      else saved.history.at(-1).actor.loginId = 'unproved';
      store.writeBlob(stateBlobName(projectId), JSON.stringify(saved));
    } else if (corruption === 'missing-history') fs.unlinkSync(path.join(dir, 'history.db'));
    else {
      const db = new DatabaseSync(path.join(dir, corruption === 'missing-account-witness' ? 'account.db' : 'history.db'));
      try {
        if (corruption === 'missing-account-witness') db.prepare('DELETE FROM order_witnesses WHERE witness_id=?').run(accepted.witness.witnessId);
        else db.exec("DELETE FROM journal WHERE kind='prepared-op'");
      } finally { db.close(); }
    }
    const before = store.readBlob(stateBlobName(projectId));
    f = await operationFixture({ dir }); closed = false;
    const b = await f.connect();
    assert.equal((await open(b, projectId)).reason, 'needs-reconciliation');
    assert.equal(store.readBlob(stateBlobName(projectId)), before, 'unknown projection must never be guessed over');
    assert.equal(f.project.bodyOf(projectId), null);
  });
}

test('operation-wiring records actual Windows directory fsync boundary', { skip: process.platform !== 'win32' }, () => {
  const dir = tmp(); let fd;
  try { assert.throws(() => { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd); }, error => ['EISDIR', 'EPERM', 'EACCES', 'EINVAL'].includes(error.code)); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
});

test('operation-wiring another account same-value write preserves version and membership downgrade is live', actual, async t => {
  let downgrade = false;
  const f = await operationFixture({ dir: tmp(), request: async (args, invoke) => {
    const result = await invoke(args);
    if (args.path.endsWith('/reserve') && downgrade) {
      downgrade = false;
      const member = f.account.credentials.verify(f.sessions.c.accessToken);
      const p = f.ledger.read().projects[f.projectId];
      await f.authority.adminProject({ accessToken: f.sessions.a.accessToken }, { projectId: f.projectId, requestId: 'downgrade',
        expectedAccessRevision: p.accessRevision, op: 'set-list', members: [{ accountId: member.accountId, access: 'r' }] });
    }
    return result;
  } }); t.after(() => f.close());
  await f.authority.joinProject({ accessToken: f.sessions.c.accessToken }, { projectId: f.projectId, requestId: 'join-other' });
  const a = await f.connect(), c = await f.connect('c');
  assert.equal((await op(a, f.projectId, 'same-owner', 'equal')).type, 'project.op.ok');
  assert.equal((await op(c, f.projectId, 'same-other', 'equal')).type, 'project.op.ok');
  const [one, two] = f.history.accepted(f.projectId);
  assert.notEqual(one.actor.accountId, two.actor.accountId); assert.equal(two.changes[0].beforeVersion, one.changes[0].afterVersion);
  downgrade = true;
  assert.equal((await op(c, f.projectId, 'downgraded')).type, 'project.op.rejected');
  assert.equal(f.history.get(f.projectId, 'downgraded').state, 'cancelled');
  assert.equal(f.history.accepted(f.projectId).length, 2);
});
