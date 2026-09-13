import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { captureFrame } from '../../scripts/capture-frame.mjs';

// PNG screenshots are integrity-checked, so fixtures must be real PNGs.
function framePng(seed = 0) {
  const png = new PNG({ width: 16, height: 8 });
  for (let i = 0; i < png.data.length; i++) png.data[i] = (i * 29 + seed) & 0xff;
  return PNG.sync.write(png);
}
function corrupt(buffer) {
  const copy = Buffer.from(buffer);
  copy[copy.indexOf('IDAT', 0, 'latin1') + 4 + 6] ^= 0xff;
  return copy;
}

test('a transient empty compositor result retries the same screenshot', async () => {
  const screenshot = { format: 'png' }, calls = [], frame = framePng();
  const bakery = { beginFrame: async args => {
    calls.push(args);
    return calls.length === 1 ? {} : { screenshotData: frame.toString('base64') };
  } };
  assert.deepEqual(await captureFrame(bakery, screenshot), frame);
  assert.deepEqual(calls, [{ screenshot }, { screenshot }]);
});
test('a corrupt PNG screenshot is shot again at the same time', async t => {
  t.mock.method(console, 'warn', () => {});
  const screenshot = { format: 'png' }, frame = framePng(1);
  const results = [corrupt(frame), frame];
  let calls = 0;
  const bakery = { beginFrame: async () => ({ screenshotData: results[calls++].toString('base64') }) };
  assert.deepEqual(await captureFrame(bakery, screenshot), frame);
  assert.equal(calls, 2);
});
test('a persistently corrupt PNG fails instead of reaching the encoder', async t => {
  t.mock.method(console, 'warn', () => {});
  let calls = 0;
  const bad = corrupt(framePng(2)).toString('base64');
  await assert.rejects(captureFrame({ beginFrame: async () => { calls++; return { screenshotData: bad }; } }, { format: 'png' }),
    /corrupt PNG after 4 compositor ticks: CRC mismatch in IDAT/);
  assert.equal(calls, 4);
});
test('JPEG screenshots are returned without the PNG check', async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  assert.deepEqual(await captureFrame({ beginFrame: async () => ({ screenshotData: jpeg.toString('base64') }) }, { format: 'jpeg' }), jpeg);
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
