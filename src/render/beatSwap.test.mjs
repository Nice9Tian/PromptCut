/**
 * L4 的按拍换快照预算(C10 契约第 6 节、第 18 节第 1 条):deadMs = max(0, budgetOf(fps) − 已占用),
 * 装得下 floor(deadMs / swapMs) 层,按调用方给的层序取,装不下的占位;SWAP_MS 缺省 3。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fitBeatSwaps, SWAP_MS } from "./beatSwap.mjs";
import { budgetOf, planPipelines } from "./pipelinePlan.mjs";

test("C10-BS-01 SWAP_MS 缺省 3 ms;预算与分派同一个 B", () => {
  assert.equal(SWAP_MS, 3);
  const r = fitBeatSwaps({ fps: 30, occupiedMs: 0, layers: ["a"] });
  assert.equal(r.deadMs, budgetOf(30));
});

test("C10-BS-02 装得下的层数 = floor(deadMs / swapMs),按层序取,其余占位", () => {
  // 30 fps:B = 23.333…;已占用 11.333… → deadMs 12 → 4 层
  const r = fitBeatSwaps({ fps: 30, occupiedMs: budgetOf(30) - 12, layers: ["top", "b", "c", "d", "e", "f"] });
  assert.equal(r.fit, 4);
  assert.deepEqual(r.swap, ["top", "b", "c", "d"]);
  assert.deepEqual(r.placeholder, ["e", "f"]);
  // 同一输入结果稳定
  assert.deepEqual(fitBeatSwaps({ fps: 30, occupiedMs: budgetOf(30) - 12, layers: ["top", "b", "c", "d", "e", "f"] }), r);
});

test("C10-BS-03 已占用超过预算:deadMs = 0,全部占位;swapMs 可以换", () => {
  const r = fitBeatSwaps({ fps: 60, occupiedMs: 100, layers: ["a", "b"] });
  assert.equal(r.deadMs, 0);
  assert.deepEqual(r.swap, []);
  assert.deepEqual(r.placeholder, ["a", "b"]);
  const s = fitBeatSwaps({ fps: 30, occupiedMs: 0, layers: ["a", "b", "c"], swapMs: 10 });
  assert.equal(s.fit, 2);
  assert.deepEqual(s.swap, ["a", "b"]);
});

test("C10-BS-04 分派时 deadMs 换成 swapMs:重卡越多,轻管线让得越多(与播放时的取舍同一个预算)", () => {
  const project = { tracks: [{ id: "t", clips: [
    { id: "L1", cardId: "x", start: 0, end: 2 }, { id: "L2", cardId: "x", start: 0, end: 2 },
    { id: "H1", cardId: "y", start: 0, end: 2 }, { id: "H2", cardId: "y", start: 0, end: 2 },
  ] }] };
  const costs = [{ identityKey: "kl", stepMs: 9, kind: "random" }, { identityKey: "kh", stepMs: 99, capped: true, kind: "random" }];
  const identityKeys = { L1: "kl", L2: "kl", H1: "kh", H2: "kh" };
  const desk = planPipelines(project, costs, 30, { identityKeys });
  const online = planPipelines(project, costs, 30, { identityKeys, deadMs: SWAP_MS });
  assert.equal(desk.segments[0].light.size, 2, "桌面的 DEAD_MS 0.3:两张轻卡都装得下(9+9+2×0.3 ≤ 23.3)");
  assert.equal(online.segments[0].light.size, 1, "在线 swapMs 3:9+9+2×3 > 23.3,挤掉一张");
});
