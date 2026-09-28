import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { exitDescription, retryReason, summarizeTestEvents } from '../../scripts/test-suite-policy.mjs';

const cwd = path.resolve('fixture-root');
const file = 'server/test/example.test.mjs';
const event = (type, data) => ({ type, data: { file, ...data } });
const processFail = (exitCode, signal = null) => event('test:fail', {
  name: file,
  details: { error: { code: 'ERR_TEST_FAILURE', cause: 'test failed', exitCode, signal } },
});
const summary = (...events) => summarizeTestEvents(events, cwd)[0];

test('Windows 原生异常和信号只对文件级失败重跑', () => {
  for (const code of [0xC0000005, 0xC0000142, 0xC0000409, 0xC000001D]) {
    const state = summary(event('test:pass', { name: 'case A' }), processFail(code));
    assert.equal(state.testCases, 1);
    assert.equal(retryReason(state), 'ntstatus');
    assert.match(exitDescription(code), /^0xC000/);
  }
  assert.equal(retryReason(summary(processFail(-1073741819))), 'ntstatus');
  assert.equal(retryReason(summary(processFail(null, 'SIGTERM'))), 'signal');
});

test('零用例、零 stderr 的非零退出最多可作为静默退出候选', () => {
  assert.equal(retryReason(summary(processFail(7))), 'silent-exit');
  assert.equal(retryReason(summary(event('test:pass', { name: 'case A' }), processFail(7))), null);
  assert.equal(retryReason(summary(event('test:stderr', { message: 'warn\n' }), processFail(7))), null);
});

test('真实断言失败和加载错误保留失败', () => {
  const assertion = event('test:fail', { name: 'bad assertion', details: { error: { code: 'ERR_TEST_FAILURE', cause: {} } } });
  const state = summary(assertion, processFail(0xC0000005));
  assert.equal(state.assertionFailures, 1);
  assert.equal(retryReason(state), null);
  const loading = summary(event('test:stderr', { message: 'Error [ERR_MODULE_NOT_FOUND]: bad import\n' }), processFail(1));
  assert.equal(loading.stderrLines, 1);
  assert.equal(retryReason(loading), null);
  assert.equal(retryReason(summary(event('test:stderr', { message: 'SyntaxError: bad syntax\n' }), processFail(0xC0000005))), null);
});

test('不同文件的用例和 stderr 分别计数', () => {
  const other = 'server/test/other.test.mjs';
  const states = summarizeTestEvents([
    event('test:pass', { name: 'one' }),
    event('test:stderr', { message: 'line one\nline two\n' }),
    { type: 'test:pass', data: { file: other, name: 'another' } },
    processFail(0xC0000005),
  ], cwd);
  assert.equal(states.length, 2);
  assert.equal(states[0].testCases, 1);
  assert.equal(states[0].stderrLines, 2);
  assert.equal(states[1].testCases, 1);
  assert.equal(states[1].processFailure, null);
  assert.equal(summary(event('test:stderr', { message: 'partial\nlast line' })).stderrLines, 2);
});
