import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixture, actor, actorNew, actorOther, spec, keys, accountFixture } from './password-order-fixture.mjs';
import { passwordCandidates } from '../account/password-order.mjs';
import { itemKey } from '../docservice/modules/operation-history.mjs';

// Keep isolated fault databases in TEMP for evidence; all handles close in each test's own hook.
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pc-order-'));
test('password-order exact acceptance: complete prepared, signed seal, accepted fsync, same materialization, duplicate stable', async (t) => {
  const f = await fixture({ dir: tmp(t) }); t.after(() => f.close());
  const input = spec('one'); const result = await f.coordinator.submit(input);
  assert.equal(result.state, 'materialized'); assert.equal(f.history.snapshot('project-one').value.title, 'one');
  assert.deepEqual((await f.coordinator.submit(input)), result);
  assert.deepEqual(f.history.journal('project-one').map((row) => row.kind), ['project-created', 'prepared-op', 'reserved-op', 'accepted-op', 'materialized-op']);
  await assert.rejects(f.coordinator.submit({ ...input, result: { altered: true } }), { code: 'operation-id-mismatch' });
});
test('password-order reserve/password/seal gap uses seal sequence, not clock or reservation', async (t) => {
  let event; const dir = tmp(t); const pair = keys(); const account = await accountFixture({ dir, pair }); t.after(() => account.close());
  let changed = false;
  const f = await fixture({ dir, pair, account, request: async (args, invoke) => {
    const result = await invoke(args);
    if (args.path.endsWith('/reserve') && !changed) { changed = true; event = account.change(); }
    return result;
  } }); t.after(() => f.close());
  const op = await f.coordinator.submit(spec('gap'));
  assert.ok(op.witness.orderSeq > (event.changeSeq ?? event.change_seq));
  const candidates = passwordCandidates({ event: { ...event, choice: 'exit', endOrderSeq: op.witness.orderSeq }, operations: [op], projectId: 'project-one' });
  assert.deepEqual(candidates.candidates, ['gap']);
});
test('password-order lost seal ACK queries the same witness and never prepares or executes twice', async (t) => {
  let lose = true; const f = await fixture({ dir: tmp(t), request: async (args, invoke) => {
    const result = await invoke(args); if (args.path.endsWith('/seal') && lose) { lose = false; throw new Error('lost ACK'); } return result;
  } }); t.after(() => f.close());
  await assert.rejects(f.coordinator.submit(spec('ack')), /lost ACK/);
  assert.equal(f.history.snapshot('project-one').projectRev, 0);
  await f.coordinator.recover('project-one');
  assert.equal(f.history.snapshot('project-one').projectRev, 1);
  assert.equal(f.history.journal('project-one').filter((row) => row.kind === 'prepared-op').length, 1);
  assert.equal(f.history.accepted('project-one').length, 1);
});
test('password-order fence while reserve waits cancels unaccepted operation; another project continues', async (t) => {
  let release; let reached; const waiting = new Promise((r) => { reached = r; }); const pause = new Promise((r) => { release = r; });
  const principal = { ...actor, runGrantId: 'grant', runId: 'run', messageId: 'message', conversationId: 'conversation' };
  const f = await fixture({ dir: tmp(t), request: async (args, invoke) => {
    const result = await invoke(args); if (args.path.endsWith('/reserve') && args.body.opId === 'paused') { reached(); await pause; } return result;
  } }); t.after(() => f.close());
  const submit = f.coordinator.submit(spec('paused', { principal })); const failed = assert.rejects(submit, { code: 'operation-fenced' });
  await waiting;
  const fence = f.coordinator.fence({ id: 'private', projectId: 'project-one', kind: 'private', conversationId: 'conversation', ownerAccountId: actorOther.accountId, runIds: ['run'] });
  const other = await f.coordinator.submit(spec('other-project', { projectId: 'project-two' })); assert.equal(other.state, 'materialized');
  release(); await failed; const result = await fence;
  assert.equal(result.complete, false, 'No durable service ACK is not completion');
  assert.equal(f.history.snapshot('project-one').projectRev, 0);
  assert.equal(f.history.get('project-one', 'paused').state, 'cancelled');
  await assert.rejects(f.coordinator.submit(spec('late', { principal })), { code: 'operation-fenced' });
});
test('password-order seal ACK lost before stop: settle exact accepted operation, then commit stop', async (t) => {
  let lose = true;
  const principal = { ...actor, runGrantId: 'grant', runId: 'run', messageId: 'message', conversationId: 'conversation' };
  const f = await fixture({ dir: tmp(t), request: async (args, invoke) => { const result = await invoke(args); if (args.path.endsWith('/seal') && lose) { lose = false; throw new Error('ACK lost'); } return result; }, acknowledgeFence: async () => ({ durable: true }) }); t.after(() => f.close());
  await assert.rejects(f.coordinator.submit(spec('accepted-before-stop', { principal })), /ACK lost/);
  assert.equal((await f.coordinator.fence({ id: 'stop', projectId: 'project-one', kind: 'stop', runId: 'run' })).complete, true);
  const kinds = f.history.journal('project-one').map((row) => row.kind);
  assert.ok(kinds.indexOf('materialized-op') < kinds.indexOf('fence-committed'));
  await assert.rejects(f.coordinator.submit(spec('late', { expectedRev: 1, principal })), { code: 'operation-fenced' });
});
test('password-order history stable IDs, complete before/after, structure dependencies, equal write evidence survives checkpoint', async (t) => {
  const f = await fixture({ dir: tmp(t) }); t.after(() => f.close());
  await f.coordinator.submit(spec('change-x', { ops: [{ op: 'set', path: '/clips/@clip~1a/x', value: 7 }] }));
  await f.coordinator.submit(spec('other-same-value', { expectedRev: 1, principal: actorOther, ops: [{ op: 'set', path: '/clips/@clip~1a/x', value: 7 }] }));
  await f.coordinator.submit(spec('move', { expectedRev: 2, ops: [{ op: 'move', path: '/clips/@clip~1a', index: 1 }, { op: 'set', path: '/cardSource', value: 'complete source bytes' }] }));
  const records = f.history.accepted('project-one'); f.history.checkpoint();
  assert.deepEqual(f.history.accepted('project-one'), records);
  const key = itemKey('/clips/@clip~1a/x');
  const first = records[0].changes.find((c) => c.itemKey === key); const second = records[1].changes.find((c) => c.itemKey === key);
  assert.deepEqual(first.before, { present: true, value: 1 }); assert.deepEqual(first.after, { present: true, value: 7 });
  assert.equal(second.beforeVersion, first.afterVersion); assert.notEqual(second.afterVersion, first.afterVersion);
  assert.equal(records[1].actor.accountId, actorOther.accountId);
  assert.ok(records[2].changes.some((c) => c.kind === 'structure' && c.path === '/clips'));
  assert.ok(records[0].dependencies.some((d) => d.itemKey === itemKey('/clips', 'structure')));
});
test('password-order bad signature or digest never changes visible state', async (t) => {
  for (const corrupt of [(w) => ({ ...w, signature: 'invalid' }), (w) => ({ ...w, preparedDigest: 'f'.repeat(64) })]) {
    const f = await fixture({ dir: tmp(t), request: async (args, invoke) => { const value = await invoke(args); return args.path.endsWith('/seal') ? corrupt(value) : value; } });
    try { await assert.rejects(f.coordinator.submit(spec('bad')), { code: 'bad-witness' }); assert.equal(f.history.snapshot('project-one').projectRev, 0); }
    finally { f.close(); }
  }
});

test('password-order private and disabled fences never revive old runs but permit new runs after current authority reopens', async (t) => {
  for (const kind of ['private', 'agent-disabled']) {
    let open = false;
    const f = await fixture({ dir: tmp(), checkGate: async () => ({ allowed: open }) });
    try {
      const principal = { ...actor, runGrantId: 'grant', runId: 'old-run', messageId: 'message', conversationId: 'conversation' };
      await f.coordinator.fence({ id: kind, kind, projectId: 'project-one', runIds: ['old-run'], ...(kind === 'private' ? { conversationId: 'conversation', ownerAccountId: actorOther.accountId } : {}) });
      await assert.rejects(f.coordinator.submit(spec('closed', { principal: { ...principal, runId: 'new-run' } })), { code: 'operation-forbidden' });
      open = true;
      await assert.rejects(f.coordinator.submit(spec('old', { principal })), { code: 'operation-fenced' });
      assert.equal((await f.coordinator.submit(spec('new', { principal: { ...principal, runId: 'new-run', runGrantId: 'new-grant', messageId: 'new-message' } }))).state, 'materialized');
    } finally { f.close(); }
  }
});

test('password-order precise retained run survives credential fence; private covers even owner retained run', async (t) => {
  const principal = { ...actor, runGrantId: 'grant', runId: 'run', messageId: 'message', conversationId: 'conversation' };
  const grant = { ...principal, projectId: 'project-one', state: 'retained', visibilityAtRead: 'shared', readConfirmed: true, currentRun: true, readReceiptId: 'read', fenceRevision: 1 };
  const f = await fixture({ dir: tmp(), checkGate: async () => ({ allowed: true, retainedGrant: grant }) }); t.after(() => f.close());
  const event = f.account.change(); f.account.choose(event, true);
  await f.coordinator.fence({ id: 'logout', kind: 'credential', projectId: 'project-one', loginIds: [actor.loginId], retainedRuns: [principal] });
  const accepted = await f.coordinator.submit(spec('retained', { principal }));
  assert.equal(accepted.witness.authorization.kind, 'retained');
  await assert.rejects(f.coordinator.submit(spec('wrong-message', { expectedRev: 1, principal: { ...principal, messageId: 'other' } })), { code: 'operation-fenced' });
  await f.coordinator.fence({ id: 'private-owner', kind: 'private', projectId: 'project-one', runIds: ['run'], conversationId: 'conversation', ownerAccountId: actor.accountId });
  await assert.rejects(f.coordinator.submit(spec('owner-retained-private', { expectedRev: 1, principal })), { code: 'private-overrides-retained' });
});

test('password-order global sequence gaps from other project and consecutive password events remain ordered across restart', async (t) => {
  const dir = tmp(); const pair = keys(); let f = await fixture({ dir, pair });
  const first = await f.coordinator.submit(spec('first'));
  const e1 = f.account.change('change-one'); f.account.choose(e1, false);
  await f.coordinator.submit(spec('other', { projectId: 'project-two' }));
  const e2 = f.account.change('change-two');
  const last = await f.coordinator.submit(spec('last', { expectedRev: 1 }));
  assert.ok(last.witness.orderSeq > first.witness.orderSeq + 1);
  const candidate = (event) => passwordCandidates({ event: { ...event, choice: 'exit', endOrderSeq: last.witness.orderSeq }, operations: f.history.accepted('project-one'), projectId: 'project-one' });
  assert.deepEqual(candidate(e1).candidates, ['last']); assert.deepEqual(candidate(e2).candidates, ['last']);
  const before = f.history.snapshot('project-one'); f.history.checkpoint(); f.close();
  // Portable simulator has no persistent account truth; actual-provider mode proves both sides survive restart.
  if (process.env.PROMPTCUT_ACCOUNT_PROVIDER_ROOT) { f = await fixture({ dir, pair }); try { await f.coordinator.recover('project-one'); assert.deepEqual(f.history.snapshot('project-one'), before); } finally { f.close(); } }
});

test('password-order candidate interval excludes other account/new login/outside range and only exact retained scope', () => {
  const event = { choice: 'exit', accountId: actor.accountId, oldLoginIds: [actor.loginId], changeSeq: 10, endOrderSeq: 20 };
  const make = (opId, principal, seq, extra = {}) => ({ opId, actor: principal, projectId: 'project-one', state: 'materialized', witness: { state: 'sealed', orderSeq: seq, ...extra } });
  const run = { ...actor, runGrantId: 'grant', runId: 'run', messageId: 'message', conversationId: 'conversation' };
  const authorization = { kind: 'retained', projectId: 'project-one', runGrantId: 'grant', runId: 'run', messageId: 'message', conversationId: 'conversation' };
  const operations = [make('old', actor, 11), make('other', actorOther, 12), make('new', actorNew, 13), make('before', actor, 10), make('later', actor, 21), make('invalid', actor, null), make('exact', run, 14, { authorization }), make('different-run', { ...run, runId: 'other' }, 15, { authorization })];
  const result = passwordCandidates({ event, operations, projectId: 'project-one' });
  assert.deepEqual(result.candidates, ['old', 'different-run']); assert.deepEqual(result.exempt, ['exact']);
  assert.deepEqual(passwordCandidates({ event: { ...event, choice: 'retain' }, operations, projectId: 'project-one' }).candidates, []);
  assert.equal(passwordCandidates({ event: { ...event, endOrderSeq: null }, operations, projectId: 'project-one' }).state, 'needs-reconciliation');
});
