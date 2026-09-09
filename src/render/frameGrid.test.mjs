/**
 * 帧格对齐的单测。跑:node --test src/render/frameGrid.test.mjs
 *
 * 这个函数错了不会报错,只会让预览和成片在每个卡片入点差不到一帧 ——
 * 而进场动画最陡的就是那一段。所以把两条钉死:**已经在帧格上的时刻不许被推走**、
 * **不在帧格上的一律往后取整**(往前取会让卡片比成片早挂,同样对不上)。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { onFrameGrid, atFrameGrid } from "./frameGrid.ts";

test("已经落在帧格上的时刻原样不动 —— 浮点不能把它推到下一帧", () => {
  // 2 * 30 在浮点里是 60.00000000000001,不留容差的话 ceil 会推成第 61 帧
  assert.equal(onFrameGrid(2, 30), 2);
  assert.equal(onFrameGrid(1, 30), 1);
  assert.equal(onFrameGrid(0, 30), 0);
  for (const fps of [24, 25, 30, 50, 60]) {
    for (const f of [1, 7, 30, 61, 149]) {
      const sec = f / fps;
      assert.equal(onFrameGrid(sec, fps), sec, `fps=${fps} 第 ${f} 帧被推走了`);
    }
  }
});

test("不在帧格上的往后取整 —— 取第一个不早于它的帧", () => {
  // 入点 1.0 减去 0.05 的提前量 = 0.95,30fps 下第一个不早于它的是第 29 帧
  assert.ok(Math.abs(onFrameGrid(0.95, 30) - 29 / 30) < 1e-12);
  assert.ok(Math.abs(onFrameGrid(0.9501, 30) - 29 / 30) < 1e-12);
  assert.equal(onFrameGrid(29 / 30, 30), 29 / 30, "刚好压在第 29 帧上,不能跳到 30");
  assert.ok(Math.abs(onFrameGrid(0.9667, 30) - 1) < 1e-12, "比第 29 帧晚一点点,就该落到第 30 帧");
  assert.ok(Math.abs(onFrameGrid(0.97, 30) - 30 / 30) < 1e-12);
});

test("对齐结果永远不早于原值 —— 早了就是卡片比成片先挂", () => {
  let rnd = 7;
  const next = () => (rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (const fps of [24, 30, 60]) {
    for (let i = 0; i < 200; i++) {
      const sec = next() * 10;
      const g = onFrameGrid(sec, fps);
      assert.ok(g >= sec - 1e-6, `fps=${fps} sec=${sec} 对齐到了 ${g},比原值还早`);
      assert.ok(g - sec < 1 / fps + 1e-9, `fps=${fps} sec=${sec} 对齐跨了不止一帧`);
    }
  }
});

test("fps 非法时不炸 —— 至少当成 1fps,不能除出 Infinity", () => {
  assert.equal(Number.isFinite(onFrameGrid(1.5, 0)), true);
  assert.equal(onFrameGrid(1.5, 0), 2);
  assert.equal(onFrameGrid(1.5, -30), 2);
});

test("atFrameGrid:帧格上的时刻不许被判回上一帧", () => {
  // 29/30 * 30 在浮点里是 28.999999999999996,不留容差就退回第 28 帧
  for (const fps of [24, 25, 30, 50, 60]) {
    for (const f of [1, 7, 29, 60, 149]) {
      const sec = f / fps;
      assert.equal(atFrameGrid(sec, fps), sec, `fps=${fps} 第 ${f} 帧被判回上一帧了`);
    }
  }
});

test("atFrameGrid:帧中间的时刻归它所在的那一帧", () => {
  assert.ok(Math.abs(atFrameGrid(1.02, 30) - 30 / 30) < 1e-12, "1.02 还在第 30 帧里");
  assert.ok(Math.abs(atFrameGrid(1.0666, 30) - 31 / 30) < 1e-12, "差一点点到第 32 帧,仍算第 31 帧");
  assert.equal(atFrameGrid(0, 30), 0);
  assert.equal(atFrameGrid(-1, 30), 0, "负数夹到 0,别把播放头推到时间轴外面");
});

test("两个方向合起来:atFrameGrid 永不晚于原值,onFrameGrid 永不早于", () => {
  for (const sec of [0.001, 0.4999, 0.95, 1, 2.5, 3.9999]) {
    assert.ok(atFrameGrid(sec, 30) <= sec + 1e-9, `${sec} 往下取整反而变大了`);
    assert.ok(onFrameGrid(sec, 30) >= sec - 1e-9, `${sec} 往上取整反而变小了`);
  }
});
