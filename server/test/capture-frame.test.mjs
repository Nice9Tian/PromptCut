import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureFrame } from '../../scripts/capture-frame.mjs';

test('a transient empty compositor result retries the same screenshot', async () => {
  const screenshot = { format: 'png' }, calls = [];
  const bakery = { beginFrame: async args => {
    calls.push(args);
    return calls.length === 1 ? {} : { screenshotData: Buffer.from('actual frame').toString('base64') };
  } };
  assert.equal((await captureFrame(bakery, screenshot)).toString(), 'actual frame');
  assert.deepEqual(calls, [{ screenshot }, { screenshot }]);
});
test('an unavailable surface cannot retry forever or return stale pixels', async () => {
  let calls = 0;
  await assert.rejects(captureFrame({ beginFrame: async () => { calls++; return {}; } }, {}), /4 compositor ticks/);
  assert.equal(calls, 4);
});
test('a superseded request stops before a retry', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(captureFrame({ beginFrame: async () => { calls++; controller.abort(); return {}; } }, {}, controller.signal), e => e.cancelled);
  assert.equal(calls, 1);
});
