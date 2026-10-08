import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { operationFixture } from './operation-wiring-fixture.mjs';
import { ask } from './fake-docservice-env.mjs';
import { actorOf } from '../docservice/modules/actor.mjs';
import { stateBlobName } from '../docservice/modules/project.mjs';

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
