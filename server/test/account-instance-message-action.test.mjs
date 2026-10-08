import test from 'node:test';
import assert from 'node:assert/strict';
import { instanceMessageAction } from '../account/agent-instance-internal.mjs';
import { dataAction } from './fixtures/agent-instance-data.mjs';

test('instance message scopes distinguish project.open from exact writes without granting new message types', () => {
  const cases = [
    ['project.open', 'read'], ['project.close', 'read'], ['project.snapshot.get', 'read'],
    ['project.op', 'write'], ['project.upload', 'write'], ['project.snapshot.put', 'write'],
    ['content.get', 'read'], ['content.put', 'write'],
    ['presence.list', 'read'], ['presence.set', 'write'], ['presence.clear', 'write'], ['presence.send', 'write'],
    ['selection.set', 'read'], ['selection.clear', 'read'], ['selection.query', 'read'],
    ['events.create', 'write'], ['task.claim', 'write'], ['publisher.hello', 'write'], ['node.hello', 'write'],
    // A suffix cannot silently borrow the scope of an exact write message.
    ['project.op.extra', 'read'], ['project.uploadExtra', 'read'], ['content.putExtra', 'read'], ['presence.setter', 'read'],
  ];
  for (const [type, action] of cases) {
    assert.equal(instanceMessageAction(type), action, type);
    assert.equal(dataAction({ type }), action, `real client proof scope: ${type}`);
  }
  assert.equal(/^(project\.op|project\.upload)/.test('project.open'), true, 'retain the original prefix counterexample');
});
