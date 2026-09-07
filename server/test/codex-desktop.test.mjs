import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

let scenario;
mock.module('node:child_process', { exports: { execFileSync, spawn: (_exe, args, options) => {
  assert.deepEqual(args, ['app-server', '--stdio']);
  assert.equal(options.windowsHide, true);
  assert.equal(options.detached, undefined);
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { child.stdout.end(); child.stderr.end(); };
  child.stdin = new Writable({ write(chunk, _encoding, done) {
    const request = JSON.parse(chunk.toString());
    queueMicrotask(() => {
      if (request.id == null) return;
      scenario.calls.push(request.method);
      const emit = value => child.stdout.write(JSON.stringify(value) + '\n');
      let result = {};
      if (request.method === 'thread/start' && scenario.unsupported) return emit({ id: request.id, error: { message: 'unknown field projectId' } });
      if (request.method === 'thread/start' || request.method === 'thread/read') {
        result = { thread: { id: 'thread', cwd: options.cwd, projectId: scenario.mismatch ? 'wrong' : null } };
      }
      emit({ id: request.id, result });
      if (request.method === 'turn/start') {
        emit({ method: 'turn/completed', params: { threadId: 'thread', turn: { status: scenario.turnFailed ? 'failed' : 'completed', error: { message: 'model unavailable' } } } });
      }
    });
    done();
  } });
  return child;
} } });
const { createCodexTask } = await import('../codex-desktop.ts');
const dir = path.resolve('task with spaces');

test('verifies projectless workspace; relaunch does not send a second turn', async () => {
  scenario = { calls: [] };
  const progress = [];
  const launch = await createCodexTask(dir, 'test', undefined, value => progress.push(value));
  assert.equal(launch.status, 'ready');
  assert.equal(launch.projectId, null);
  assert.equal(launch.initialState, 'completed');
  assert.ok(progress.some(value => value.initialState === 'dispatching'));
  const again = await createCodexTask(dir, 'test', launch, () => {});
  assert.equal(again.status, 'ready');
  assert.equal(scenario.calls.filter(method => method === 'turn/start').length, 1);
});

test('wrong workspace assignment prevents sending', async () => {
  scenario = { calls: [], mismatch: true };
  const launch = await createCodexTask(dir, 'test', undefined, () => {});
  assert.equal(launch.status, 'failed');
  assert.ok(!scenario.calls.includes('turn/start'));
});

test('unsupported protocol is reported instead of using selected project', async () => {
  scenario = { calls: [], unsupported: true };
  const launch = await createCodexTask(dir, 'test', undefined, () => {});
  assert.equal(launch.status, 'failed');
  assert.match(launch.detail, /unknown field/);
  assert.ok(!scenario.calls.includes('turn/start'));
});

test('failed turn keeps identity and blocks duplicate dispatch', async () => {
  scenario = { calls: [], turnFailed: true };
  const launch = await createCodexTask(dir, 'test', undefined, () => {});
  assert.equal(launch.status, 'failed');
  assert.equal(launch.threadId, 'thread');
  assert.match(launch.detail, /model unavailable/);
  await createCodexTask(dir, 'test', launch, () => {});
  assert.equal(scenario.calls.filter(method => method === 'turn/start').length, 1);
});
