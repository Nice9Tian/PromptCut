import '../testing/registerTs.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { startUploadTarget, resetAssetTiersForTest } = await import('../editor/media/assetTiers.ts');

test('account upload target renews session HTTP ticket without legacy auth.ticket and clears target on stop', async () => {
  const posted = [], timers = []; let legacyCalls = 0, issued = 0;
  const link = { request: async () => { legacyCalls++; throw new Error('v2 forbids auth.ticket'); } };
  const stop = startUploadTarget(link, 'https://visuhive.com/media/api/asset', {
    accountTicket: async () => ({ ticket: `session-ticket-${++issued}`, exp: 10_000 }),
    now: () => 1000, post: async body => { posted.push(body); },
    setTimer: fn => { timers.push(fn); return fn; }, clearTimer: fn => { const index = timers.indexOf(fn); if (index >= 0) timers.splice(index, 1); },
  });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(legacyCalls, 0); assert.equal(posted[0].ticket, 'session-ticket-1');
    timers.shift()(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(posted[1].ticket, 'session-ticket-2'); assert.equal(legacyCalls, 0);
    stop(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(posted.at(-1), { base: null }); assert.equal(timers.length, 0);
  } finally { stop(); resetAssetTiersForTest(); }
});
