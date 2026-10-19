/**
 * 一个项目的云端对话列表整张页面只有一份(historyStore.ts)：几个分页共用一个轮询、同时只有一次在途、刚读过的不再读。
 * 跑:npm test -- src/ai/cloud/history-store.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { cloudHistoryFor, createCloudHistory, _resetCloudHistories } from "./historyStore.ts";

const settle = () => new Promise((r) => setImmediate(r));
/** 手动推进的假轮询：记下起了几个、每个 kick 了几次 */
function fakePollers() {
  const made = [];
  const createPoller = (o) => { const p = { o, started: 0, stopped: 0, kicks: 0, start() { p.started++; void o.run(); }, stop() { p.stopped++; }, kick() { p.kicks++; void o.run(); }, describe() { return {}; } }; made.push(p); return p; };
  return { made, createPoller };
}

test("几个分页订阅同一份：只起一个轮询；都走了就停", async () => {
  _resetCloudHistories();
  const f = fakePollers(); let lists = 0;
  const deps = () => ({ list: async () => { lists++; return [{ id: "c1", title: "t", updatedAt: 1, state: "idle", lastSeq: 0 }]; }, pollMs: 3000, createPoller: f.createPoller });
  const a = cloudHistoryFor("p|u|1|acc:1", deps), b = cloudHistoryFor("p|u|1|acc:1", deps);
  assert.equal(a, b, "同一个键是同一份");
  const offA = a.subscribe(() => {}), offB = b.subscribe(() => {});
  await settle();
  assert.equal(f.made.length, 1, "两个分页只起一个轮询");
  assert.equal(lists, 1);
  assert.equal(a.get().loaded, true);
  assert.equal(a.get().items[0].id, "c1");
  offA(); assert.equal(f.made[0].stopped, 0, "还有人订阅就不停");
  offB(); assert.equal(f.made[0].stopped, 1, "都走了就停");
});

test("同时只有一次在途：几处同时要读，等同一次的结果", async () => {
  let lists = 0, release;
  const h = createCloudHistory({ list: () => { lists++; return new Promise((r) => { release = () => r([]); }); }, pollMs: 0 });
  const p1 = h.refresh(), p2 = h.refresh(), p3 = h.refresh({ silent: true });
  await settle();
  assert.equal(lists, 1);
  release();
  assert.deepEqual(await Promise.all([p1, p2, p3]), [true, true, true]);
});

test("刚读回来不到 maxAgeMs 的直接用，不再读；过了就读", async () => {
  let lists = 0, clock = 1000;
  const h = createCloudHistory({ list: async () => { lists++; return []; }, pollMs: 0, now: () => clock });
  await h.refresh();
  assert.equal(lists, 1);
  clock += 1500; await h.refresh({ maxAgeMs: 2000 });
  assert.equal(lists, 1, "1.5 秒前读过，直接用");
  clock += 1000; await h.refresh({ maxAgeMs: 2000 });
  assert.equal(lists, 2, "2.5 秒了，再读");
  await h.refresh();
  assert.equal(lists, 3, "不给 maxAgeMs 就总是读");
});

test("读失败：非静默抛出、静默回 false 并记下原因；列表保留上一次的", async () => {
  let fail = false;
  const h = createCloudHistory({ list: async () => { if (fail) throw Object.assign(new Error("x"), { status: 503 }); return [{ id: "c1" }]; }, pollMs: 0 });
  await h.refresh();
  fail = true;
  await assert.rejects(h.refresh(), /x/);
  assert.equal(await h.refresh({ silent: true }), false);
  assert.equal(h.lastError().status, 503);
  assert.equal(h.get().items[0].id, "c1", "失败不清掉已经有的");
});

test("没变就沿用原数组（订阅者不白白重绘）", async () => {
  const h = createCloudHistory({ list: async () => [{ id: "c1", title: "a" }], pollMs: 0 });
  await h.refresh(); const first = h.get().items;
  let calls = 0; h.subscribe(() => calls++);
  await h.refresh();
  assert.equal(h.get().items, first);
  assert.equal(calls, 1, "时间戳变了照常通知，数组不换");
});

test("轮询读失败遇到登录失效：回 stop 不再来", async () => {
  const f = fakePollers();
  const h = createCloudHistory({ list: async () => { throw Object.assign(new Error("401"), { status: 401 }); }, pollMs: 3000, createPoller: f.createPoller,
    onPollError: (err) => (err.status === 401 ? "stop" : undefined) });
  h.subscribe(() => {});
  assert.equal(await f.made[0].o.run(), "stop");
});
