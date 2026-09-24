/**
 * 根因 B 的回归测试:暂停态重卡已经 settled(精确活渲、舞台摘了快照)之后,父页不能再把快照投回去。
 * 跑:node --experimental-test-module-mocks --test src/editor/snapshotSettled.test.mjs
 *
 * 以前 `noteSettled` 只删投递基线;之后任何一条 SSE 消息触发的 `pumpFeed` → `deliverSnapshots`
 * 都会把(可能是改之前旧键的)快照重新投回去,盖在已经改好的活组件上 —— 违背「停下就精确」。
 *
 * 现在:父页记「暂停态已 settled」集合,暂停中不再给这些卡投快照;下一次 `setTime`(`pickForSetTime`)
 * 或播放时清空。暂停态第二路互换之后整台都是精确活渲,`markAllSettled` 一并收下。
 *
 * 真模块:snapshotFeed.ts(planFeed / deliverSnapshots / noteSettled)、snapshotPick、pipelinePlan。
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

globalThis.window = globalThis;
mock.module(srcUrl("store/project.ts"), { exports: { getState: () => ({}), subscribe: () => () => {} } });
mock.module(srcUrl("render/dataMirror.ts"), { exports: { mirrorKey: () => ({ session: "s", localRev: 1 }), pushWanted: () => {} } });
mock.module(srcUrl("editor/planDispatch.ts"), { exports: { currentPlan: () => ({ segments: [{ fromSec: 0, toSec: 1000, heavy: new Set(["h"]) }] }) } });

const feed = await import(srcUrl("editor/snapshotFeed.ts"));

let push = null;
const sent = [];
const stage = { setSnapshots: async (patch, opts) => { sent.push({ patch, opts }); return { ok: true }; } };
const card = (params) => ({ id: "h", cardId: "c", start: 0, end: 10, params });
const P0 = { fps: 30, tracks: [{ id: "t", clips: [card({ text: "旧字" })] }] };
const P1 = { fps: 30, tracks: [{ id: "t", clips: [card({ text: "" })] }] };   // 用户删掉了卡里的字
const tick = () => new Promise((r) => setTimeout(r, 40));   // > 33 ms 节流
let head;

beforeEach(async () => {
  feed.resetSnapshotFeed();
  feed.setSnapshotSource({
    subscribeReady: (_s, _r, cb) => { push = cb; return () => {}; },
    fetchSnapshot: async (kind, key, f) => `<div>${key}@${f}</div>`,
  });
  sent.length = 0;
  head = { project: P0, t: 1, playing: false };
  feed.syncSnapshotSubscription(() => { void feed.deliverSnapshots(stage, "front", head); });
  push({ type: "layer", clipId: "h", kind: "html", key: "OLDKEY", ranges: [[0, 299]] });
  await tick();
  await feed.deliverSnapshots(stage, "front", head);   // 字节到货后的补投
  assert.ok(sent.some((s) => s.patch.h?.includes("OLDKEY")), "暂停时先贴快照(正常)");
});

test("settled 之后改卡:暂停中任何 SSE 都不再把快照投回去", async () => {
  feed.noteSettled("front", ["h"]);
  sent.length = 0;
  head = { project: P1, t: 1, playing: false };
  await tick();
  push({ type: "layer", clipId: "other", kind: "html", key: "X", ranges: [[0, 1]] });
  await tick();
  await feed.deliverSnapshots(stage, "front", head);
  assert.ok(!sent.some((s) => s.patch.h), `settled 的卡不再投快照:${JSON.stringify(sent.map((s) => s.patch))}`);
  assert.ok(!feed.planFeed(head).picks.has("h"), "planFeed 暂停态也不再给它选帧");
});

test("下一次 setTime 清掉 settled:同一张卡照常贴快照", async () => {
  feed.noteSettled("front", ["h"]);
  head = { project: P0, t: 2, playing: false };
  const { snapshots } = feed.pickForSetTime(head);
  assert.ok(typeof snapshots.h === "string" || feed.planFeed(head).picks.has("h"), "setTime 之后重新选帧");
});

test("起播清掉 settled:播放中照常有兜底快照", async () => {
  feed.noteSettled("front", ["h"]);
  head = { project: P0, t: 1, playing: true };
  await tick();
  await feed.deliverSnapshots(stage, "front", head);
  head = { project: P0, t: 1, playing: false };
  assert.ok(feed.planFeed(head).picks.has("h"), "播放过一次之后 settled 已经清空");
});

test("暂停态互换之后整台精确:markAllSettled 期间不投任何快照,setTime 后恢复", async () => {
  feed.markAllSettled("front");
  sent.length = 0;
  await tick();
  push({ type: "layer", clipId: "other", kind: "html", key: "Y", ranges: [[0, 1]] });
  await tick();
  await feed.deliverSnapshots(stage, "front", head);
  assert.ok(!sent.some((s) => typeof s.patch.h === "string"), "互换后不再盖回快照");
  feed.pickForSetTime({ project: P0, t: 1.5, playing: false });
  assert.ok(feed.planFeed({ project: P0, t: 1.5, playing: false }).picks.has("h"));
});
