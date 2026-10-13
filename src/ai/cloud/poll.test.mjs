import test from "node:test";
import assert from "node:assert/strict";
import { createPoller } from "./poll.ts";

/** 假的定时器：手动推进，不真等 */
function clock() {
  const timers = []; let id = 0;
  return { schedule: (fn, ms) => { const t = { id: ++id, fn, ms }; timers.push(t); return t; },
    cancel: h => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
    pending: () => timers.map(t => t.ms),
    async fire() { const t = timers.shift(); if (t) { t.fn(); await new Promise(r => setImmediate(r)); } return t?.ms ?? null; } };
}
const settle = () => new Promise(r => setImmediate(r));

test("同时只有一次在途：上一次没回来，kick 也不会再发一次", async () => {
  const c = clock(); let calls = 0, release;
  const p = createPoller({ baseMs: 3000, visible: () => true, schedule: c.schedule, cancel: c.cancel, run: () => { calls++; return new Promise(r => { release = r; }); } });
  p.start(); await settle(); p.kick(); p.kick(); await settle();
  assert.equal(calls, 1); assert.equal(p.describe().inflight, true);
  release(); await settle();
  assert.equal(calls, 1); assert.deepEqual(c.pending(), [3000], '回来以后才排下一次');
});

test("失败退避：连续失败一次翻一倍，封顶；成功就回到基准", async () => {
  const c = clock(); let fail = true;
  const p = createPoller({ baseMs: 3000, maxMs: 20000, visible: () => true, schedule: c.schedule, cancel: c.cancel, run: async () => { if (fail) throw new Error("x"); } });
  p.start(); await settle();
  assert.deepEqual(c.pending(), [6000]);
  assert.equal(await c.fire(), 6000); assert.deepEqual(c.pending(), [12000]);
  assert.equal(await c.fire(), 12000); assert.deepEqual(c.pending(), [20000], '封顶');
  fail = false;
  await c.fire(); assert.deepEqual(c.pending(), [3000], '成功后回到基准');
});

test("登录失效(run 回 stop)就停，不再排、kick 也不再来", async () => {
  const c = clock(); let calls = 0;
  const p = createPoller({ baseMs: 3000, visible: () => true, schedule: c.schedule, cancel: c.cancel, run: async () => { calls++; return "stop"; } });
  p.start(); await settle();
  assert.deepEqual(c.pending(), []); p.kick(); await settle();
  assert.equal(calls, 1); assert.equal(p.describe().stopped, true);
});

test("页面不可见不排下一次；回到可见 kick 一次立刻来、再接着排；stop 清掉定时器", async () => {
  const c = clock(); let calls = 0, shown = true;
  const p = createPoller({ baseMs: 3000, visible: () => shown, schedule: c.schedule, cancel: c.cancel, run: async () => { calls++; } });
  p.start(); await settle(); assert.equal(calls, 1); assert.deepEqual(c.pending(), [3000]);
  shown = false; await c.fire(); await settle();
  assert.equal(calls, 1, '不可见：定时到了也不发'); assert.deepEqual(c.pending(), [], '也不再排');
  shown = true; p.kick(); await settle();
  assert.equal(calls, 2); assert.deepEqual(c.pending(), [3000]);
  p.stop(); assert.deepEqual(c.pending(), []);
});
