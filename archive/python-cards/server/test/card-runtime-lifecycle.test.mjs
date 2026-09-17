import assert from 'node:assert/strict';
import test from 'node:test';
import { CardRuntime } from '../card-runtime.mjs';

test('late failure from an old runner cannot kill its replacement', () => {
  const runtime = new CardRuntime({ root: process.cwd() });
  let oldKills = 0, newKills = 0;
  const oldChild = { kill() { oldKills++; } };
  const newChild = { kill() { newKills++; } };
  runtime.child = newChild;
  runtime.fail(new Error('old child exited'), oldChild);
  assert.equal(oldKills, 0);
  assert.equal(newKills, 0);
  assert.equal(runtime.child, newChild);
  runtime.fail(new Error('current child exited'), newChild);
  assert.equal(newKills, 1);
  assert.equal(runtime.child, null);
});
