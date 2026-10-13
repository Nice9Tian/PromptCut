/**
 * 父页一侧「暂停和拖动贴流」的单测(`snapshotFeed.ts`;任务书「己三」)。
 * 跑:npm test -- src/editor/snapshotFeedScrub.test.mjs
 *
 * 钉住:
 *   - 不在播放时,这一帧有流的重卡照样发流平面,并且被抑制(`FeedPlan.scrub`);
 *   - **有流不读快照**:就算快照表盖着这一帧,也不选帧、不取字节、不点名 `awaiting`、不报缺口;
 *   - 这一帧所在分段没就绪 / 根本没有流的卡,落回快照这条路(现状),不抑制;
 *   - 追到精确活渲(`settled`)的卡不再抑制,但流平面照发(把播放头下这一帧先解好);下一次 `setTime`、起播照常;
 *   - 组流整条判;超出解码器预算的层抑制着、落到快照;低内存档暂停着照现状不发流平面;
 *   - 片段不从 15 的倍数帧开始:按这条流自己的第一帧换算。
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

globalThis.window = globalThis;
let plan = null;
const wantedPushed = [];
mock.module(srcUrl("editor/planDispatch.ts"), { exports: { currentPlan: () => plan } });
mock.module(srcUrl("render/dataMirror.ts"), { exports: { mirrorKey: () => ({ session: "s", localRev: 1 }), pushWanted: (w) => wantedPushed.push(w) } });

const feed = await import(srcUrl("editor/snapshotFeed.ts"));
const { planFeed, pickForSetTime, deliverSnapshots, noteSettled, markAllSettled, suppressedAt, streamPlanesAt, setSnapshotSource, syncSnapshotSubscription, resetSnapshotFeed } = feed;
const { DECODER_BUDGET } = await import(srcUrl("render/streamPlayer.ts"));

let now = 1000;
performance.now = () => now;

const FPS = 30;
const card = (id, start = 0, end = 10) => ({ id, cardId: "c", start, end, params: {} });
const project = (clips) => ({ version: 1, name: "p", width: 1920, height: 1080, fps: FPS, duration: 20, media: [], tracks: [{ id: "t", name: "t", clips }] });
const heavyEverywhere = (...ids) => ({ segments: [{ fromSec: 0, toSec: 1000, heavy: new Set(ids) }] });
const html = (clipId, ranges, key = `k-${clipId}`) => ({ type: "layer", clipId, kind: "html", key, ranges });
const stream = (clipId, ranges, extra = {}) => ({ type: "layer", clipId, kind: "stream", key: `s-${clipId}`, ranges, originFrame: 0, ...extra });
const at = (frame) => frame / FPS + 1e-4;

let src;
beforeEach(() => {
  resetSnapshotFeed();
  src = { push: null, fetched: [],
    subscribeReady(_s, _r, cb) { src.push = cb; return () => {}; },
    async fetchSnapshot(kind, key, f) { src.fetched.push(`${kind}/${key}/${f}`); return `html:${key}/${f}`; } };
  setSnapshotSource(src);
  syncSnapshotSubscription(() => {});
  plan = { segments: [] };
  wantedPushed.length = 0;
  now += 10_000;
});

test("暂停 / 拖动:这一帧有流的重卡发流平面、被抑制;有流不读快照(不选帧、不取字节、不等、不报缺口)", async () => {
  const p = project([card("h"), card("l")]);
  plan = heavyEverywhere("h");
  src.push(html("h", [[0, 299]]));               // 快照表盖着每一帧
  src.push(stream("h", [[0, 19]]));
  const head = { project: p, t: at(37), playing: false };
  const f = planFeed(head);
  assert.deepEqual(f.heavy, ["h"]);
  assert.deepEqual(f.streamPlanes, [{ clipIds: ["h"], key: "s-h", ranges: [[0, 19]], originFrame: 0 }]);
  assert.deepEqual(f.scrub, ["h"]);
  assert.equal(f.picks.size, 0, "有流不读快照");
  assert.deepEqual(f.wanted, []);
  assert.deepEqual(suppressedAt(head), ["h"]);
  assert.deepEqual(streamPlanesAt(head), f.streamPlanes);
  const set = pickForSetTime(head);
  assert.deepEqual(set, { snapshots: {}, awaiting: [] }, "setTime 不带快照、不点名等快照");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(src.fetched, [], "快照的字节一个都不取");
  assert.deepEqual(wantedPushed, []);
  const calls = [];
  await deliverSnapshots({ setSnapshots: async (patch) => { calls.push(patch); } }, "front", head);
  assert.deepEqual(calls, [], "也不投");
});

test("这一帧所在分段的流没就绪、或者这张卡根本没有流:不抑制,落回快照这条路(现状)", () => {
  const p = project([card("h"), card("n")]);
  plan = heavyEverywhere("h", "n");
  src.push(html("h", [[0, 299]]));
  src.push(html("n", [[0, 299]]));
  src.push(stream("h", [[0, 1]]));                // 只有头两个分段(第 0～29 帧)
  const head = { project: p, t: at(37), playing: false };
  const f = planFeed(head);
  assert.deepEqual(f.streamPlanes, []);
  assert.deepEqual(f.scrub, []);
  assert.deepEqual([...f.picks.keys()].sort(), ["h", "n"]);
  assert.deepEqual(suppressedAt(head), []);
  assert.deepEqual(pickForSetTime(head).awaiting.sort(), ["h", "n"], "字节还没到:照现状点名等快照");
  // 拖回有流的那一段:h 改贴流,n 照旧
  const back = planFeed({ ...head, t: at(20) });
  assert.deepEqual(back.scrub, ["h"]);
  assert.deepEqual([...back.picks.keys()], ["n"]);
});

test("追到精确活渲(settled)的卡不再抑制,流平面照发(把这一帧先解好);下一次 setTime 重新贴流;起播照常抑制", () => {
  const p = project([card("h")]);
  plan = heavyEverywhere("h");
  src.push(stream("h", [[0, 19]]));
  const head = { project: p, t: at(37), playing: false };
  pickForSetTime(head);
  assert.deepEqual(suppressedAt(head), ["h"]);
  noteSettled("front", ["h"]);
  const settled = planFeed(head);
  assert.deepEqual(settled.scrub, [], "停下就撤兜底:追上的不再盖回去");
  assert.equal(settled.streamPlanes.length, 1, "流平面留着:舞台拿它把播放头下这一帧先解好");
  assert.equal(settled.picks.size, 0);
  // 起播:和暂停着先解好的是同一条平面(舞台不用重建解码器),这时才抑制
  const playing = { ...head, playing: true };
  assert.deepEqual(streamPlanesAt(playing), settled.streamPlanes);
  assert.deepEqual(suppressedAt(playing), ["h"]);
  // 再拖一下:上一次的「已精确」作废
  pickForSetTime({ ...head, t: at(52) });
  assert.deepEqual(suppressedAt({ ...head, t: at(52) }), ["h"]);
});

test("暂停态互换之后整台精确(markAllSettled):一张都不抑制,流平面照发", () => {
  const p = project([card("a"), card("b")]);
  plan = heavyEverywhere("a", "b");
  src.push(stream("a", [[0, 19]]));
  src.push(stream("b", [[0, 19]]));
  const head = { project: p, t: at(37), playing: false };
  assert.deepEqual(suppressedAt(head), ["a", "b"]);
  markAllSettled("front");
  assert.deepEqual(suppressedAt(head), []);
  assert.equal(streamPlanesAt(head).length, 2);
});

test("组流整条判:成员有一张没追上,整组都还抑制着;全追上了才都放开", () => {
  const p = project([card("a"), card("b")]);
  plan = heavyEverywhere("a", "b");
  src.push(stream("b", [[0, 19]], { key: "g", groupClipIds: ["a", "b"] }));
  const head = { project: p, t: at(37), playing: false };
  const f = planFeed(head);
  assert.deepEqual(f.streamPlanes, [{ clipIds: ["a", "b"], key: "g", ranges: [[0, 19]], originFrame: 0 }]);
  assert.deepEqual(f.scrub, ["a", "b"]);
  noteSettled("front", ["a"]);
  assert.deepEqual(planFeed(head).scrub, ["a", "b"], "a 先追上:组里还有 b,整组不放");
  noteSettled("front", ["b"]);
  assert.deepEqual(planFeed(head).scrub, []);
  // 组里有一张这一刻不判重:这一组不贴(各走各的)
  plan = heavyEverywhere("a");
  pickForSetTime(head);
  assert.deepEqual(planFeed(head).streamPlanes, []);
  assert.deepEqual(planFeed(head).scrub, []);
});

test("同屏超出解码器预算:流平面按预算截;超出的那几张也抑制着,落到快照", () => {
  const ids = Array.from({ length: DECODER_BUDGET + 2 }, (_, i) => `c${i}`);
  const p = project(ids.map((id) => card(id)));
  plan = heavyEverywhere(...ids);
  for (const id of ids) { src.push(html(id, [[0, 299]])); src.push(stream(id, [[0, 19]])); }
  const head = { project: p, t: at(37), playing: false };
  const f = planFeed(head);
  assert.equal(f.streamPlanes.length, DECODER_BUDGET);
  assert.deepEqual(f.scrub, [...ids].sort());
  assert.deepEqual([...f.picks.keys()].sort(), ids.slice(DECODER_BUDGET).sort(), "只有超出预算的那两张读快照");
  assert.ok([...f.picks.values()].every((pick) => pick.tier === "over"));
});

test("低内存档暂停着:照现状不发流平面、不按贴流抑制(重卡贴小尺寸);播放中照发", () => {
  const p = project([card("h")]);
  plan = heavyEverywhere("h");
  src.push(html("h", [[0, 299]]));
  src.push(stream("h", [[0, 19]]));
  const paused = planFeed({ project: p, t: at(37), playing: false, lowMemory: true });
  assert.deepEqual(paused.streamPlanes, []);
  assert.deepEqual(paused.scrub, []);
  assert.equal(paused.picks.size, 1);
  assert.equal(planFeed({ project: p, t: at(37), playing: true, lowMemory: true }).streamPlanes.length, 1);
});

test("片段从第 100 帧开始(不是 15 的倍数):暂停着按这条流自己的第一帧判这一帧有没有流", () => {
  const p = project([card("d", 100 / FPS + 1e-3, 250 / FPS)]);
  plan = heavyEverywhere("d");
  src.push(stream("d", [[1, 2]], { originFrame: 101 }));   // 第 116～145 帧
  const scrubAt = (frame) => planFeed({ project: p, t: at(frame), playing: false }).scrub;
  assert.deepEqual(scrubAt(115), [], "第 115 帧在第 0 段,没就绪");
  assert.deepEqual(scrubAt(116), ["d"]);
  assert.deepEqual(scrubAt(145), ["d"]);
  assert.deepEqual(scrubAt(146), [], "第 146 帧是第 3 段");
});

test("这台设备跑不了的卡(在线浏览器模式)停下不追:「已精确」对它不成立,暂停着一直贴流", async () => {
  const registry = await import(srcUrl("kernel/registry.ts"));
  const host = await import(srcUrl("render/placeholderHost.ts"));
  registry.setSyncedUserCards([{ id: "synced", name: "同步卡" }]);
  const p = project([{ ...card("s"), cardId: "synced" }, card("b")]);
  plan = heavyEverywhere("b");
  try {
    host.setOnlineBrowserMode(true);
    resetSnapshotFeed(); setSnapshotSource(src); syncSnapshotSubscription(() => {});
    src.push(stream("s", [[0, 19]]));
    src.push(stream("b", [[0, 19]]));
    const head = { project: p, t: at(37), playing: false };
    assert.deepEqual(planFeed(head).scrub, ["b", "s"]);
    noteSettled("front", ["b", "s"]);
    assert.deepEqual(planFeed(head).scrub, ["s"]);
    markAllSettled("front");
    assert.deepEqual(planFeed(head).scrub, ["s"]);
  } finally {
    host.setOnlineBrowserMode(false);
    registry.setSyncedUserCards([]);
  }
});
