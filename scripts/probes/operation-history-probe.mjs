/** Isolated history proof. --out <new TMP directory>; actual account provider env is mandatory.
 * Verifies full values, stable IDs, structural versions, same-value other-actor evidence,
 * journal reconstruction, account/doc restart and checkpoint retention. No compensation or production mounting.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fixture, keys, spec, actorOther } from '../../server/test/password-order-fixture.mjs';
import { itemKey } from '../../server/docservice/modules/operation-history.mjs';

const args = process.argv.slice(2); const out = path.resolve(args[args.indexOf('--out') + 1] ?? '');
const relative = path.relative(path.resolve(os.tmpdir()), out);
if (!args.includes('--out') || !relative || relative.startsWith('..') || path.isAbsolute(relative) || !process.env.PROMPTCUT_ACCOUNT_PROVIDER_ROOT) throw new Error('New TMP output directory and actual account provider required');
if (fs.existsSync(out)) throw new Error('Output directory already exists');
fs.mkdirSync(out, { recursive: true });
const pair = keys(); let f = await fixture({ dir: out, pair, actual: true });
try {
  const source = 'export function card(){return "complete source Ω";}';
  const edits = [
    [{ op: 'set', path: '/cardSource', value: source }, { op: 'set', path: '/clips/@clip~1a/x', value: 7 }],
    [{ op: 'set', path: '/clips/@clip~1a/x', value: 7 }],
    [{ op: 'insert', path: '/clips', index: 1, value: { id: 'clip~new', x: 3, nested: { full: [1, 2] } } }],
    [{ op: 'move', path: '/clips/@clip~0new', index: 0 }],
    [{ op: 'remove', path: '/clips/@clip-b' }],
    [{ op: 'set', path: '', value: { title: 'root replacement', clips: [{ id: 'clip/a', x: 9 }], cardSource: source, asset: { hash: 'fixture-hash', note: 'metadata' } } }],
  ];
  for (let i = 0; i < edits.length; i++) await f.coordinator.submit(spec(`history-${i}`, { expectedRev: i, ops: edits[i], ...(i === 1 ? { principal: actorOther } : {}) }));
  const rows = f.history.accepted('project-one'); const journal = f.history.journal('project-one');
  const x = itemKey('/clips/@clip~1a/x'); const first = rows[0].changes.find((c) => c.itemKey === x); const equal = rows[1].changes.find((c) => c.itemKey === x);
  assert.equal(equal.beforeVersion, first.afterVersion); assert.notEqual(equal.afterVersion, first.afterVersion); assert.equal(rows[1].actor.accountId, actorOther.accountId);
  assert.equal(rows[0].changes.find((c) => c.path === '/cardSource').after.value, source);
  const removed = rows[4].changes.find((c) => c.path === '/clips/@clip-b'); assert.deepEqual(removed.before.value, { id: 'clip-b', x: 2 }); assert.equal(removed.after.present, false);
  assert.ok(rows[2].changes.some((c) => c.kind === 'structure' && c.path === '/clips'));
  for (const row of rows) { const prepared = journal.find((j) => j.kind === 'prepared-op' && j.opId === row.opId); assert.deepEqual(prepared.before, row.before); assert.deepEqual(prepared.after, row.after); assert.deepEqual(prepared.changes, row.changes); assert.deepEqual(prepared.actor, row.actor); }
  const snapshot = f.history.validate('project-one'); f.history.checkpoint(); f.close(); f = null;
  f = await fixture({ dir: out, pair, actual: true }); await f.coordinator.recover('project-one');
  assert.deepEqual(f.history.accepted('project-one'), rows); assert.deepEqual(f.history.journal('project-one'), journal); assert.deepEqual(f.history.snapshot('project-one'), snapshot);
  const result = { passed: 6, failed: 0, operations: rows.length, journalRecords: journal.length, projectRev: snapshot.projectRev, mode: 'actual-foundation-sqlite', assertions: ['full-source-values', 'same-value-other-actor-version', 'stable-id-structure-and-tombstone', 'root-replacement', 'journal-reconstruction', 'checkpoint-and-both-provider-restart'] };
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ ...result, out }));
} catch (error) { fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ message: error.message, code: error.code }, null, 2)); throw error; }
finally { f?.close(); }
