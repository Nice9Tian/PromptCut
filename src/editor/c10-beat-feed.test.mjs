/**
 * L4 按拍换快照在投递一侧(C10 契约第 6 节、第 18 节第 1 条;`snapshotFeed.ts` 的 `setBeatSwap`):
 *   - 开着时播放中的投递不受 33 ms 节流,暂停时仍受;关着(桌面)照旧;
 *   - 每拍按 fitBeatSwaps 装得下的重层才换,按从上到下的层序取,装不下的摘掉快照(舞台显示占位符)。
 * 跑:node --experimental-test-module-mocks --test src/editor/c10-beat-feed.test.mjs
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

let plan = { segments: [] };
mock.module(srcUrl("editor/planDispatch.ts"), { exports: { currentPlan: () => plan } });
mock.module(srcUrl("render/dataMirror.ts"), { exports: { mirrorKey: () => ({ session: "s", localRev: 1 }), pushWanted: () => {} } });

const feed = await import(srcUrl("editor/snapshotFeed.ts"));
const { deliverSnapshots, setSnapshotSource, syncSnapshotSubscription, resetSnapshotFeed, setBeatSwap, beatSwapDebug, topDownOrder, SNAPSHOT_THROTTLE_MS } = feed;

let now = 1000;
performance.now = () => now;
const settle = () => new Promise((r) => setImmediate(r));
const FPS = 30;
const card = (id, start, end) => ({ id, cardId: "c", start, end, params: {} });
// 第一条轨道在最上面;同一轨道里后面的片段盖在前面的上面
const project = (tracks) => ({ version: 1, name: "p", width: 1920, height: 1080, fps: FPS, duration: 20, media: [], tracks });

let src;
function fakeSource() {
  const s = { push: null, subscribeReady(_a, _b, on) { s.push = on; return () => {}; }, async fetchSnapshot(kind, key, f) { return `html:${kind}/${key}/${f}`; } };
  return s;
}
function fakeStage() {
  const st = { calls: [] };
  st.setSnapshots = async (patch, opts) => { st.calls.push({ patch, opts }); };
  return st;
}
beforeEach(() => {
  resetSnapshotFeed();
  src = fakeSource();
  setSnapshotSource(src);
  syncSnapshotSubscription(() => {});
  now += 10_000;
});

async function warm(stage, head) {
  await deliverSnapshots(stage, "front", head);   // 第一轮取字节
  await settle();
  now += 1000;
}

test("C10-BF-01 开着:播放中每拍都投,不受 33 ms 节流;暂停时照旧节流;关着照旧", async () => {
  const p = project([{ id: "t", name: "t", clips: [card("h", 0, 10)] }]);
  plan = { segments: [{ fromSec: 0, toSec: 1000, heavy: new Set(["h"]), light: new Set() }] };
  src.push({ type: "layer", clipId: "h", kind: "html", key: "k", ranges: [[0, 300]] });
  const stage = fakeStage();
  setBeatSwap(true, { swapMs: 3, occupied: () => 0 });
  await warm(stage, { project: p, t: 1, playing: true });
  for (let i = 0; i < 4; i++) {
    await deliverSnapshots(stage, "front", { project: p, t: 1 + i / FPS, playing: true });
    await settle();
    await deliverSnapshots(stage, "front", { project: p, t: 1 + i / FPS, playing: true });
    await settle();
    now += 5;   // 每拍只隔 5 ms:节流会挡,按拍换不挡
  }
  const beatCalls = stage.calls.length;
  assert.ok(beatCalls >= 4, `播放中每拍都投了:${beatCalls}`);
  // 暂停:受节流
  const before = stage.calls.length;
  await deliverSnapshots(stage, "front", { project: p, t: 2, playing: false });
  now += 5;
  await deliverSnapshots(stage, "front", { project: p, t: 2 + 1 / FPS, playing: false });
  assert.ok(stage.calls.length - before <= 1, "暂停时 33 ms 里最多一次");
  // 关着:播放中也受节流
  setBeatSwap(false);
  const b2 = stage.calls.length;
  now += 1000;
  await deliverSnapshots(stage, "front", { project: p, t: 3, playing: true });
  now += 5;
  await deliverSnapshots(stage, "front", { project: p, t: 3 + 1 / FPS, playing: true });
  assert.ok(stage.calls.length - b2 <= 1);
  assert.ok(SNAPSHOT_THROTTLE_MS === 33);
});

test("C10-BF-02 装不下的重层这一拍摘掉快照(占位);按从上到下的层序取", async () => {
  // 三张重卡:轨道 top 上的 a、轨道 mid 上的 b、c(c 在 b 后面,盖在 b 上面)
  const p = project([
    { id: "top", name: "top", clips: [card("a", 0, 10)] },
    { id: "mid", name: "mid", clips: [card("b", 0, 10), card("c", 0, 10)] },
  ]);
  assert.deepEqual(topDownOrder(p, ["b", "c", "a"]), ["a", "c", "b"]);
  plan = { segments: [{ fromSec: 0, toSec: 1000, heavy: new Set(["a", "b", "c"]), light: new Set() }] };
  for (const id of ["a", "b", "c"]) src.push({ type: "layer", clipId: id, kind: "html", key: `k-${id}`, ranges: [[0, 300]] });
  const stage = fakeStage();
  // 30 fps:B = 23.33;已占用 17.33 → deadMs 6 → 装 2 层(swapMs 3)
  setBeatSwap(true, { swapMs: 3, occupied: () => 23.333333 - 6 });
  await warm(stage, { project: p, t: 1, playing: true });
  await deliverSnapshots(stage, "front", { project: p, t: 1, playing: true });
  const d = beatSwapDebug().last;
  assert.equal(d.fit, 2);
  assert.deepEqual(d.swap, ["a", "c"]);
  assert.deepEqual(d.placeholder, ["b"]);
  const last = stage.calls.at(-1).patch;
  assert.ok(typeof last.a === "string" && typeof last.c === "string", "装得下的两层换上");
  assert.ok(!("b" in last) || last.b === null, "装不下的那层不换(摘掉,舞台显示占位符)");
  const mounted = stage.calls.flatMap((c) => Object.entries(c.patch)).filter(([id, v]) => id === "b" && typeof v === "string");
  assert.equal(mounted.length, 0, "b 从头到尾没挂上");
});
