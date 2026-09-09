/**
 * 绿条覆盖范围的单测。跑:node --test src/editor/preview/bakeCoverage.test.mjs
 *
 * 这条绿条要么是可信的,要么就该拆掉:它承诺的是「绿的地方拖过去立刻有画面」。
 * 画多了就是骗人(拖过去还要等五秒,条却是绿的),画少了就白等。所以把意图钉死:
 *   - 一个烘好的时刻覆盖到**同一张卡的下一个时刻**为止,最后一个管到卡结束;
 *   - 没烘的时刻不产生任何绿色;
 *   - 相邻的段要合并,不能画成一排带缝的小块;
 *   - 覆盖范围不能超出这张卡自己的区间。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { coverageSegments } from "./bakeCoverage.ts";

/** 造一张卡的若干时刻 */
const spread = (clipId, start, end, ts) => ts.map((t) => ({ clipId, t, start, end }));
const all = () => true;
const none = () => false;

test("一个烘好的时刻,管到同一张卡的下一个时刻为止", () => {
  const m = spread("a", 0, 4, [0, 1, 2]);
  // 只有 t=1 烘好了 → 覆盖 [1,2),不该蔓延到 0 或 2 之后
  const segs = coverageSegments(m, (x) => x.t === 1);
  assert.deepEqual(segs, [{ start: 1, end: 2 }]);
});

test("最后一个时刻一直管到这张卡结束", () => {
  const m = spread("a", 0, 4, [0, 1, 2]);
  const segs = coverageSegments(m, (x) => x.t === 2);
  assert.deepEqual(segs, [{ start: 2, end: 4 }], "2 是最后一个,后面整段都靠它");
});

test("全烘好 = 整张卡连成一段,不是一排带缝的小块", () => {
  const m = spread("a", 0, 4, [0, 1, 2]);
  assert.deepEqual(coverageSegments(m, all), [{ start: 0, end: 4 }]);
});

test("一个都没烘就没有绿色", () => {
  assert.deepEqual(coverageSegments(spread("a", 0, 4, [0, 1, 2]), none), []);
});

test("烘到一半:前半段绿、后半段不绿 —— 整段涂绿会骗人", () => {
  const m = spread("a", 0, 4, [0, 1, 2, 3]);
  const segs = coverageSegments(m, (x) => x.t <= 1);
  assert.deepEqual(segs, [{ start: 0, end: 2 }], "0 和 1 连起来是 [0,2),2 之后还没烘");
});

test("中间断开的两段不能合并", () => {
  const m = spread("a", 0, 5, [0, 1, 2, 3, 4]);
  // 烘了 0 和 3,中间 1、2 没烘
  const segs = coverageSegments(m, (x) => x.t === 0 || x.t === 3);
  assert.deepEqual(segs, [{ start: 0, end: 1 }, { start: 3, end: 4 }]);
});

test("一个时刻管到下一个时刻为止,**不跨卡**去找", () => {
  // 两张卡首尾相接:a 的最后一个时刻只能管到 a 结束,不能借用 b 的时刻
  const m = [...spread("a", 0, 2, [0, 1]), ...spread("b", 2, 4, [2, 3])];
  const segs = coverageSegments(m, (x) => x.clipId === "a");
  assert.deepEqual(segs, [{ start: 0, end: 2 }], "只覆盖 a 自己那两秒");
});

test("首尾相接的两张卡都烘好了,画成连续的一整条", () => {
  const m = [...spread("a", 0, 2, [0, 1]), ...spread("b", 2, 4, [2, 3])];
  assert.deepEqual(coverageSegments(m, all), [{ start: 0, end: 4 }], "挨着就该并成一段");
});

test("中间隔着空档的两张卡,绿条也要跟着断开", () => {
  const m = [...spread("a", 0, 2, [0, 1]), ...spread("b", 5, 7, [5, 6])];
  assert.deepEqual(coverageSegments(m, all), [{ start: 0, end: 2 }, { start: 5, end: 7 }]);
});

test("覆盖范围不会超出这张卡自己的区间", () => {
  // 构造一个越界的时刻表(理论上不该出现,但越界的绿条是会骗人的,得兜住)
  const m = [{ clipId: "a", t: 3, start: 0, end: 2 }];
  assert.deepEqual(coverageSegments(m, all), [], "时刻已经在卡结束之后,不产生绿色");
});

test("时刻乱序传进来也算得对", () => {
  const m = spread("a", 0, 4, [2, 0, 1]);
  assert.deepEqual(coverageSegments(m, all), [{ start: 0, end: 4 }]);
});

test("重叠的卡(不同轨道叠在一起)合并成一条,不重复画", () => {
  const m = [...spread("a", 0, 3, [0, 1, 2]), ...spread("b", 1, 4, [1, 2, 3])];
  assert.deepEqual(coverageSegments(m, all), [{ start: 0, end: 4 }]);
});

test("0.25 秒一格累加出来的浮点误差不会画出一堆碎缝", () => {
  // 模拟 sampleTimesFor 的累加:0, 0.25, 0.5, ... 末位有误差
  const ts = [];
  for (let i = 0, v = 0; i < 8; i++, v += 0.25) ts.push(v);
  const m = spread("a", 0, 2, ts);
  const segs = coverageSegments(m, all);
  assert.equal(segs.length, 1, `该合成一段,实得 ${segs.length} 段:${JSON.stringify(segs)}`);
  assert.ok(Math.abs(segs[0].start - 0) < 1e-6);
  assert.ok(Math.abs(segs[0].end - 2) < 1e-6);
});

test("空输入不炸", () => {
  assert.deepEqual(coverageSegments([], all), []);
});
