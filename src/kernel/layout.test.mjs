/**
 * kernel/layout.ts 的单测。跑:node --test src/kernel/layout.test.mjs
 *
 * 这是「Agent 说的位置」到「屏幕上的像素」之间唯一的一道换算。它算错不会报错,
 * 只会让卡片出现在别的地方,而且 world/local 两边一旦不自洽,Agent 会拿到
 * 两个互相矛盾的答案还不知道信哪个。所以钉死:
 *   - 没有 frame 时输出和以前逐字节一样(老项目的导出基线不能动);
 *   - 锚点语义:x,y 是锚点的位置,不是左上角;
 *   - world 和 local 在卡片级恒等,反解是 round-trip;
 *   - 校验的错误信息说人话,而且不能让坏值溜进 frame。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveFrame, frameBox, worldOf, localFromWorld, framePatchFromArgs, frameCss,
  visualBox, rectToFrame, alignToFrame, alignIsInvisible, nudgeFrame,
  clampToStage, rectForSafeSide,
} from "./layout.ts";

const STAGE = { width: 1920, height: 1080 };

test("没有 frame:铺满舞台,CSS 和以前一样是 inset:0、没有 transform", () => {
  assert.deepEqual(frameBox(undefined, STAGE), { left: 0, top: 0, width: 1920, height: 1080 });
  assert.deepEqual(frameCss(undefined, STAGE), { position: "absolute", inset: 0 });
});

test("没有 frame 但绑了轨迹:和以前一样只多一个 translate + willChange", () => {
  assert.deepEqual(frameCss(undefined, STAGE, { dx: 10, dy: -4 }), {
    position: "absolute",
    inset: 0,
    transform: "translate(10px, -4px)",
    willChange: "transform",
  });
});

test("锚点语义:x,y 是锚点位置。中心锚点放 960,540 就是居中", () => {
  const box = frameBox({ x: 960, y: 540, w: 400, h: 200, anchor: [0.5, 0.5] }, STAGE);
  assert.deepEqual(box, { left: 760, top: 440, width: 400, height: 200 });
});

test("右下锚点贴到舞台右下角", () => {
  const box = frameBox({ x: 1920, y: 1080, w: 300, h: 100, anchor: [1, 1] }, STAGE);
  assert.deepEqual(box, { left: 1620, top: 980, width: 300, height: 100 });
});

test("省略 w/h 就是舞台尺寸;省略 anchor 就是左上角", () => {
  assert.deepEqual(resolveFrame({ x: 100, y: 50 }, STAGE), { x: 100, y: 50, w: 1920, h: 1080, anchor: [0, 0], scale: 1, rotate: 0 });
  assert.deepEqual(frameBox({ x: 100, y: 50 }, STAGE), { left: 100, top: 50, width: 1920, height: 1080 });
});

test("CSS:transform-origin 在锚点,恒等的 scale/rotate 不写进 transform", () => {
  const css = frameCss({ x: 960, y: 540, w: 400, h: 200, anchor: [0.5, 0.5] }, STAGE);
  assert.equal(css.transformOrigin, "50% 50%");
  assert.equal(css.transform, undefined, "scale 1 / rotate 0 不该产生 transform 属性");
  assert.equal(css.left, 760);
  assert.equal(css.top, 440);
});

test("CSS:轨迹平移在最前,然后 scale,再 rotate", () => {
  const css = frameCss({ x: 0, y: 0, scale: 2, rotate: 15 }, STAGE, { dx: 10, dy: 20 });
  assert.equal(css.transform, "translate(10px, 20px) scale(2) rotate(15deg)");
  assert.equal(css.transformOrigin, "0% 0%");
  assert.equal(css.willChange, "transform");
});

test("world 和 local 在卡片级恒等,box 一致", () => {
  const frame = { x: 960, y: 540, w: 400, h: 200, anchor: [0.5, 0.5] };
  const w = worldOf(frame, STAGE);
  assert.equal(w.x, 960);
  assert.equal(w.y, 540);
  assert.deepEqual(w.anchor, [0.5, 0.5]);
  assert.deepEqual(w.box, frameBox(frame, STAGE));
});

test("world → local 反解是 round-trip", () => {
  const w = { x: 123, y: 456, anchor: [1, 0] };
  assert.deepEqual(localFromWorld(w, STAGE), w);
});

test("framePatchFromArgs:只返回传了的字段", () => {
  assert.deepEqual(framePatchFromArgs({ x: 5 }, STAGE), { x: 5 });
  assert.deepEqual(framePatchFromArgs({ anchor: [0.5, 1], scale: 0.5 }, STAGE), { anchor: [0.5, 1], scale: 0.5 });
  assert.deepEqual(framePatchFromArgs({ space: "world", x: 1, y: 2 }, STAGE), { x: 1, y: 2 });
});

test("framePatchFromArgs:坏值不能溜进去,错误信息说人话", () => {
  assert.throws(() => framePatchFromArgs({}, STAGE), /至少要传/);
  assert.throws(() => framePatchFromArgs({ x: NaN }, STAGE), /x 必须是有限数字/);
  assert.throws(() => framePatchFromArgs({ x: "1" }, STAGE), /x 必须是有限数字/);
  assert.throws(() => framePatchFromArgs({ scale: 0 }, STAGE), /scale 必须大于 0/);
  assert.throws(() => framePatchFromArgs({ w: -1 }, STAGE), /w 必须大于 0/);
  assert.throws(() => framePatchFromArgs({ anchor: [0.5] }, STAGE), /anchor 必须是两个数字/);
  assert.throws(() => framePatchFromArgs({ anchor: "center" }, STAGE), /anchor 必须是两个数字/);
});

/* ---------- visualBox:判遮挡要看的那个框 ---------- */

test("visualBox:没缩放没旋转时等于 box", () => {
  const f = { x: 960, y: 540, w: 400, h: 200, anchor: [0.5, 0.5] };
  assert.deepEqual(visualBox(f, STAGE), frameBox(f, STAGE));
});

test("visualBox:绕锚点缩放,锚点不动,尺寸按比例", () => {
  const vb = visualBox({ x: 960, y: 540, w: 400, h: 200, anchor: [0.5, 0.5], scale: 0.5 }, STAGE);
  assert.deepEqual(vb, { left: 860, top: 490, width: 200, height: 100 });
});

test("visualBox:靠右锚点缩放后,右边缘仍贴在锚点上", () => {
  const vb = visualBox({ x: 1880, y: 540, w: 400, h: 200, anchor: [1, 0.5], scale: 0.5 }, STAGE);
  assert.equal(vb.left + vb.width, 1880);
  assert.equal(vb.width, 200);
});

test("visualBox:旋转 90° 宽高互换(浮点误差以内)", () => {
  const vb = visualBox({ x: 0, y: 0, w: 400, h: 200, rotate: 90 }, STAGE);
  assert.ok(Math.abs(vb.width - 200) < 1e-9 && Math.abs(vb.height - 400) < 1e-9);
});

/* ---------- set_rect ---------- */

test("rectToFrame fit(默认):画布不动,缩放到装进矩形,居中", () => {
  const f = rectToFrame({ x1: 0, y1: 270, x2: 960, y2: 810 }, {}, undefined, STAGE);
  assert.deepEqual(f, { x: 480, y: 540, w: 1920, h: 1080, anchor: [0.5, 0.5], scale: 0.5 });
  // 缩放后的可见框正好落在矩形里
  assert.deepEqual(visualBox(f, STAGE), { left: 0, top: 270, width: 960, height: 540 });
});

test("rectToFrame fit:比例不同时取小的那个缩放,不会溢出", () => {
  const f = rectToFrame({ x1: 0, y1: 0, x2: 960, y2: 1080 }, {}, undefined, STAGE);
  assert.equal(f.scale, 0.5);
  const vb = visualBox(f, STAGE);
  assert.ok(vb.left >= 0 && vb.left + vb.width <= 960 && vb.top >= 0 && vb.top + vb.height <= 1080);
});

test("rectToFrame canvas:画布就是矩形,scale 归 1", () => {
  const f = rectToFrame({ x1: 960, y1: 810, x2: 0, y2: 270 }, { mode: "canvas" }, { scale: 3, rotate: 5, x: 0, y: 0 }, STAGE);
  assert.deepEqual(f, { x: 480, y: 540, w: 960, h: 540, anchor: [0.5, 0.5], scale: 1, rotate: 5 });
});

test("rectToFrame:对角点顺序随意;align 决定在矩形里靠哪", () => {
  const f = rectToFrame({ x1: 960, y1: 810, x2: 0, y2: 270 }, { align: [0, 1] }, undefined, STAGE);
  assert.equal(f.x, 0);
  assert.equal(f.y, 810);
  assert.deepEqual(f.anchor, [0, 1]);
});

test("rectToFrame:坏矩形和坏 mode 直接拒", () => {
  assert.throws(() => rectToFrame({ x1: 10, y1: 10, x2: 10, y2: 500 }, {}, undefined, STAGE), /正的宽高/);
  assert.throws(() => rectToFrame({ x1: "a", y1: 0, x2: 1, y2: 1 }, {}, undefined, STAGE), /x1 必须是有限数字/);
  assert.throws(() => rectToFrame({ x1: 0, y1: 0, x2: 1, y2: 1 }, { mode: "stretch" }, undefined, STAGE), /mode 只能是/);
});

/* ---------- align ---------- */

test("alignToFrame:右下 + 边距,锚点跟着到右下", () => {
  const f = alignToFrame("right", "bottom", 40, { w: 400, h: 200, x: 0, y: 0 }, STAGE);
  assert.deepEqual(f, { w: 400, h: 200, x: 1880, y: 1040, anchor: [1, 1] });
  const vb = visualBox(f, STAGE);
  assert.equal(vb.left + vb.width, 1880);
  assert.equal(vb.top + vb.height, 1040);
});

test("alignToFrame:只传 h,竖直方向不动", () => {
  const prev = { x: 100, y: 333, w: 400, h: 200, anchor: [0.5, 0.25] };
  const f = alignToFrame("center", undefined, 0, prev, STAGE);
  assert.equal(f.x, 960);
  assert.equal(f.y, 333);
  assert.deepEqual(f.anchor, [0.5, 0.25]);
});

test("alignToFrame:缩放过的卡片贴边看的是可见框", () => {
  const f = alignToFrame("left", "top", 20, { x: 0, y: 0, scale: 0.5 }, STAGE);
  const vb = visualBox(f, STAGE);
  assert.equal(vb.left, 20);
  assert.equal(vb.top, 20);
  assert.equal(vb.width, 960);
});

test("alignToFrame:什么都不传 / 乱传就拒", () => {
  assert.throws(() => alignToFrame(undefined, undefined, 0, undefined, STAGE), /至少要传/);
  assert.throws(() => alignToFrame("middle", undefined, 0, undefined, STAGE), /h 只能是/);
  assert.throws(() => alignToFrame("left", undefined, NaN, undefined, STAGE), /margin 必须是有限数字/);
});

test("alignIsInvisible:铺满又没缩小才是真,缩过或画布小了都不是", () => {
  assert.equal(alignIsInvisible(undefined, STAGE), true);
  assert.equal(alignIsInvisible({ x: 0, y: 0, scale: 0.9 }, STAGE), false);
  assert.equal(alignIsInvisible({ x: 0, y: 0, w: 800, h: 400 }, STAGE), false);
});

/* ---------- nudge ---------- */

test("nudgeFrame:位置加像素、缩放乘倍数、旋转加角度,没传的不动", () => {
  const prev = { x: 100, y: 200, anchor: [0.5, 0.5], scale: 2, rotate: 10 };
  assert.deepEqual(nudgeFrame({ dx: 50, dy: -20 }, prev, STAGE), { ...prev, x: 150, y: 180 });
  assert.deepEqual(nudgeFrame({ scaleBy: 0.5 }, prev, STAGE), { ...prev, scale: 1 });
  assert.deepEqual(nudgeFrame({ rotateBy: -10 }, prev, STAGE), { ...prev, rotate: 0 });
});

test("nudgeFrame:没有 frame 的卡片也能推,从铺满全屏起算", () => {
  assert.deepEqual(nudgeFrame({ dx: 30 }, undefined, STAGE), { x: 30, y: 0 });
});

/* ---------- clamp ---------- */

test("clampToStage:出了右边/下边就挪回来,可见框贴边", () => {
  const f = clampToStage({ x: 1800, y: 1000, w: 400, h: 200, anchor: [0, 0] }, STAGE);
  const vb = visualBox(f, STAGE);
  assert.equal(vb.left + vb.width, 1920);
  assert.equal(vb.top + vb.height, 1080);
});

test("clampToStage:出了左边/上边同样挪回来;在里面就不动", () => {
  const f = clampToStage({ x: -50, y: -20, w: 400, h: 200 }, STAGE);
  assert.deepEqual([f.x, f.y], [0, 0]);
  const inside = { x: 100, y: 100, w: 400, h: 200 };
  assert.deepEqual(clampToStage(inside, STAGE), inside);
});

test("clampToStage:按缩放后的可见框算,而不是画布", () => {
  // 画布 1920 宽、缩到 0.5 后 960 宽,锚点在中心放到 x=1700 → 可见框右缘 2180,要挪回 260
  const f = clampToStage({ x: 1700, y: 540, anchor: [0.5, 0.5], scale: 0.5 }, STAGE);
  assert.equal(f.x, 1440);
  assert.equal(visualBox(f, STAGE).left + visualBox(f, STAGE).width, 1920);
});

test("clampToStage:比舞台还大的框夹不回来,原样", () => {
  const f = clampToStage({ x: -100, y: 0, w: 2500, h: 500 }, STAGE);
  assert.equal(f.x, -100);
});

/* ---------- 主体检测 → 矩形 ---------- */

test("rectForSafeSide:left/right 半屏,top/bottom 1/3 带,留边距", () => {
  assert.deepEqual(rectForSafeSide("left", STAGE, 40), { x1: 40, y1: 40, x2: 920, y2: 1040 });
  assert.deepEqual(rectForSafeSide("right", STAGE, 40), { x1: 1000, y1: 40, x2: 1880, y2: 1040 });
  assert.deepEqual(rectForSafeSide("top", STAGE, 40), { x1: 40, y1: 40, x2: 1880, y2: 320 });
  assert.deepEqual(rectForSafeSide("bottom", STAGE, 40), { x1: 40, y1: 760, x2: 1880, y2: 1040 });
  assert.throws(() => rectForSafeSide("middle", STAGE), /safeSide 只能是/);
});

test("rectForSafeSide 的矩形喂给 rectToFrame,可见框落在那一侧", () => {
  const f = rectToFrame(rectForSafeSide("left", STAGE, 40), {}, undefined, STAGE);
  const vb = visualBox(f, STAGE);
  assert.ok(vb.left >= 40 && vb.left + vb.width <= 920);
});

test("nudgeFrame:空调用和非正倍数都拒", () => {
  assert.throws(() => nudgeFrame({}, undefined, STAGE), /至少要传/);
  assert.throws(() => nudgeFrame({ scaleBy: 0 }, undefined, STAGE), /scaleBy 是倍数/);
  assert.throws(() => nudgeFrame({ dx: "5" }, undefined, STAGE), /dx 必须是有限数字/);
});
