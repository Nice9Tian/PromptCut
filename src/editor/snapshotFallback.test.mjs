/**
 * 根因 C、D 的回归测试 + 兜底顺序在父页一侧的排程(`snapshotFeed.ts`)。
 * 跑:node --experimental-test-module-mocks --test src/editor/snapshotFallback.test.mjs
 *
 *  (C) 以前播放中只要就绪索引说「这一段有流」就不给快照;舞台那边流还没解出来 / 超解码器预算 /
 *      清单没到时画布 blank(),快照这条兜底已经被父页撤掉 → 整层透明。现在流覆盖时照样选快照,
 *      标成「海报」:挂着的那张离当前帧不到 15 帧就不换;超出解码器预算的层当「无流」,每拍换。
 *  (D) 以前 K6 降级卡的「就绪」只看流表有没有**任意**一段。现在按当前位置起的覆盖窗口判
 *      (流按分段、快照按帧;mechanism/rendering.md「降级」:从当前位置起 1 秒,不足 1 秒到片段结束)。
 *  一次投递在 2 MB 内按优先级装:无流 > 超预算 > 海报;装不下的这一拍保留上一张,不摘。
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

globalThis.window = globalThis;
let heavyIds = ["h", "d"];
mock.module(srcUrl("render/dataMirror.ts"), { exports: { mirrorKey: () => ({ session: "s", localRev: 1 }), pushWanted: () => {} } });
mock.module(srcUrl("editor/planDispatch.ts"), { exports: { currentPlan: () => ({ segments: [{ fromSec: 0, toSec: 1000, heavy: new Set(heavyIds) }] }) } });
const feed = await import(srcUrl("editor/snapshotFeed.ts"));
const { DECODER_BUDGET } = await import(srcUrl("render/streamPlayer.ts"));

let now = 1000;
performance.now = () => now;

let push = null;
const bodies = new Map();
const card = (id, start = 0, end = 10) => ({ id, cardId: "c", start, end, params: {} });
const projectOf = (ids) => ({ fps: 30, tracks: [{ id: "t", clips: ids.map((id) => card(id)) }] });
const project = projectOf(["h", "d"]);

beforeEach(() => {
  feed.resetSnapshotFeed();
  heavyIds = ["h", "d"];
  bodies.clear();
  feed.setSnapshotSource({
    subscribeReady: (_s, _r, cb) => { push = cb; return () => {}; },
    fetchSnapshot: async (kind, key, f) => bodies.get(`${key}@${f}`) ?? `<div>${key}@${f}</div>`,
  });
  feed.syncSnapshotSubscription(() => {});
});

const settle = () => new Promise((r) => setTimeout(r, 0));
function fakeStage() {
  const st = { calls: [] };
  st.setSnapshots = async (patch, opts) => { st.calls.push({ patch, opts }); return { ok: true }; };
  return st;
}

test("(C) 播放中流覆盖这一段:照样选快照兜底,标成海报;暂停时照常", () => {
  push({ type: "layer", clipId: "h", kind: "html", key: "K", ranges: [[0, 299]] });
  push({ type: "layer", clipId: "h", kind: "stream", key: "S", ranges: [[0, 19]] });
  const playing = feed.planFeed({ project, t: 1, playing: true });
  assert.ok(playing.heavy.includes("h"));
  assert.ok(playing.picks.has("h"), "流画不出来时有快照顶上,不透明");
  assert.equal(playing.picks.get("h").tier, "poster");
  assert.ok(!playing.wanted.some((w) => w.clipId === "h"), "有流的层不催预渲染进程补精确帧");
  const paused = feed.planFeed({ project, t: 1, playing: false });
  assert.equal(paused.picks.get("h").tier, "none");
});

test("(D) K6:当前段没有流、也没有快照 → 不切进抑制,照常活渲", () => {
  feed.markPendingDemote("d");
  push({ type: "layer", clipId: "d", kind: "stream", key: "SD", ranges: [[15, 19]] });   // 只有第 7.5 秒以后
  const f = feed.planFeed({ project, t: 1, playing: true });                            // 播放头在第 1 秒 = 第 2 段
  assert.ok(!f.heavy.includes("d"), "就绪前照常活渲");
  assert.ok(feed.pendingDemotes().has("d"));
});

test("(D) K6:从当前位置起 1 秒的分段都有流才算就绪", () => {
  feed.markPendingDemote("d");
  push({ type: "layer", clipId: "d", kind: "stream", key: "SD", ranges: [[2, 2]] });   // 第 30~44 帧
  assert.ok(!feed.planFeed({ project, t: 1, playing: true }).heavy.includes("d"), "第 1 秒起 30 帧要到第 59 帧,第 3 段(45~59)没有 → 不够");
  push({ type: "layer", clipId: "d", kind: "stream", key: "SD", ranges: [[2, 3]] });
  assert.ok(feed.planFeed({ project, t: 1, playing: true }).heavy.includes("d"), "第 2~3 段盖住了第 30~59 帧");
  assert.ok(!feed.pendingDemotes().has("d"));
});

test("超出解码器预算的层当「无流」:不进流平面,快照每拍换(不是海报)", () => {
  const ids = Array.from({ length: DECODER_BUDGET + 1 }, (_, i) => `h${i}`);
  heavyIds = ids;
  const p = projectOf(ids);
  for (const id of ids) {
    push({ type: "layer", clipId: id, kind: "html", key: `K${id}`, ranges: [[0, 299]] });
    push({ type: "layer", clipId: id, kind: "stream", key: `S${id}`, ranges: [[0, 19]] });
  }
  const head = { project: p, t: 1, playing: true };
  const planes = feed.streamPlanesAt(head);
  assert.equal(planes.length, DECODER_BUDGET, "父页发给舞台的流平面也按解码器预算截");
  const f = feed.planFeed(head);
  const last = ids.at(-1);
  assert.equal(f.picks.get(last).tier, "over");
  assert.equal(f.picks.get(ids[0]).tier, "poster");
});

test("海报:挂着的快照离当前帧不到 15 帧不换;无流的层每拍换", async () => {
  push({ type: "layer", clipId: "h", kind: "html", key: "K", ranges: [[0, 299]] });
  push({ type: "layer", clipId: "h", kind: "stream", key: "S", ranges: [[0, 19]] });
  push({ type: "layer", clipId: "d", kind: "html", key: "D", ranges: [[0, 299]] });
  const stage = fakeStage();
  const at = async (t) => {
    await feed.deliverSnapshots(stage, "front", { project, t, playing: true });   // 发起取字节(字节还没到,这一次投不了)
    await settle();
    now += 40;
    await feed.deliverSnapshots(stage, "front", { project, t, playing: true });
  };
  await at(1);
  assert.equal(stage.calls.at(-1).patch.h, "<div>K@30</div>");
  stage.calls.length = 0;
  await at(1 + 10 / 30);
  assert.ok(!("h" in (stage.calls.at(-1)?.patch ?? {})), "海报离当前帧 10 帧:不换");
  assert.equal(stage.calls.at(-1).patch.d, "<div>D@40</div>", "无流的 d 每拍换");
  await at(1 + 16 / 30);
  assert.equal(stage.calls.at(-1).patch.h, "<div>K@46</div>", "满 15 帧了:换一张");
});

test("一次投递 ≤ 2 MB,按优先级装:无流 > 海报;装不下的保留上一张,不摘", async () => {
  const big = "x".repeat(1.5 * 1024 * 1024);
  push({ type: "layer", clipId: "h", kind: "html", key: "K", ranges: [[0, 299]] });
  push({ type: "layer", clipId: "h", kind: "stream", key: "S", ranges: [[0, 19]] });
  push({ type: "layer", clipId: "d", kind: "html", key: "D", ranges: [[0, 299]] });
  bodies.set("K@30", big);
  bodies.set("D@30", big);
  const head = { project, t: 1, playing: true };
  const stage = fakeStage();
  await feed.deliverSnapshots(stage, "front", head);   // 发起取字节
  await settle();
  now += 40;
  await feed.deliverSnapshots(stage, "front", head);
  assert.equal(stage.calls.length, 1, "一次只投一包");
  assert.deepEqual(Object.keys(stage.calls[0].patch), ["d"], "无流的 d 先装,海报 h 这一拍装不下");
  now += 40;
  await feed.deliverSnapshots(stage, "front", head);
  assert.deepEqual(Object.keys(stage.calls[1].patch), ["h"], "下一拍再装 h;d 没有被摘");
});
