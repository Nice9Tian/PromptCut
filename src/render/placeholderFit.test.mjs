/**
 * 占位符在屏幕上多大(`placeholderFit.ts`)。跑:node --test src/render/placeholderFit.test.mjs
 *
 *   PF-01 viewInverse:1 / 预览缩放,夹在 [1/8, 16];坏值回 1
 *   PF-02 沙漏:屏幕上保持原大小(只抵消预览缩放,不管这一层的缩放);放不进框按框缩小;噪点(铺满形态)不在这里
 *   PF-03 图标:抵消预览缩放和这一层的缩放;横排 → 竖排 → 只留图标 → 按框等比缩小;都不超出框(留边距)
 *   PF-04 相邻两个小片段:图标在屏幕上不相交(各自在自己的框里)
 */
import "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const F = await import("./placeholderFit.ts");
const screenOf = (fit, layout, view, layer) => {
  const size = layout ? F.UNSUPPORTED_SIZES[layout] : { w: F.HOURGLASS_SIZE, h: F.HOURGLASS_SIZE };
  const k = fit.scale * view * layer;
  return { w: size.w * k, h: size.h * k };
};

test("PF-01 viewInverse", () => {
  assert.equal(F.viewInverse(0.25), 4);
  assert.equal(F.viewInverse(1), 1);
  assert.equal(F.viewInverse(2), 0.5, "放大预览时按比例缩回(屏幕上保持原大小)");
  assert.equal(F.viewInverse(0.01), 16, "封顶 16");
  assert.equal(F.viewInverse(100), 1 / 8, "封底 1/8");
  for (const bad of [0, -1, NaN, Infinity, undefined, null, "x"]) assert.equal(F.viewInverse(bad), 1, String(bad));
  assert.equal(F.viewInverse("0.5"), 2);
});

test("PF-02 沙漏:只抵消预览缩放;放不进框按框缩", () => {
  const box = { width: 1920, height: 1080 };
  // 27% 预览:屏幕上 28 像素
  const a = F.hourglassFit({ box, viewScale: 0.27, layerScale: 1 });
  assert.ok(Math.abs(screenOf(a, null, 0.27, 1).w - 28) < 1e-9, JSON.stringify(a));
  // 这一层缩到一半:沙漏跟着这一层缩(语义:继承该层的缩放),倍数不变
  const b = F.hourglassFit({ box, viewScale: 0.27, layerScale: 0.5 });
  assert.equal(b.scale, a.scale, "不抵消这一层的缩放");
  assert.ok(Math.abs(screenOf(b, null, 0.27, 0.5).w - 14) < 1e-9);
  // 框很小:按框缩(留边距)
  const c = F.hourglassFit({ box: { width: 40, height: 40 }, viewScale: 0.25, layerScale: 1 });
  assert.ok(c.scale * F.HOURGLASS_SIZE <= 40 - 2 * Math.min(4 * 4, 0.08 * 40) + 1e-9, JSON.stringify(c));
  assert.ok(c.scale < 4);
  // 预览 100%、框够大:原样
  assert.deepEqual(F.hourglassFit({ box, viewScale: 1 }), { scale: 1 });
  // 框是 0:不画成 0
  assert.equal(F.hourglassFit({ box: { width: 0, height: 0 }, viewScale: 0.3 }).scale, F.FIT_MIN_SCALE);
});

test("PF-03 图标:横排 → 竖排 → 只留图标 → 按框缩;不超出框", () => {
  const view = 0.27;
  const cases = [
    // [框, 这一层的缩放, 期望排法]
    [{ width: 1920, height: 1080 }, 1, "row"],
    [{ width: 900, height: 300 }, 1, "row"],
    [{ width: 640, height: 360 }, 1, "column"],
    [{ width: 1280, height: 720 }, 0.5, "column"],
    [{ width: 640, height: 360 }, 0.5, "icon"],
    [{ width: 240, height: 200 }, 1, "icon"],
    [{ width: 100, height: 60 }, 1, "icon"],
  ];
  for (const [box, layer, want] of cases) {
    const fit = F.unsupportedFit({ box, viewScale: view, layerScale: layer });
    assert.equal(fit.layout, want, `${JSON.stringify(box)} × ${layer}: ${JSON.stringify(fit)}`);
    const size = F.UNSUPPORTED_SIZES[fit.layout];
    assert.ok(size.w * fit.scale <= box.width + 1e-9 && size.h * fit.scale <= box.height + 1e-9, `不超出框:${JSON.stringify({ box, fit })}`);
  }
  // 放得下时屏幕上是目标大小(横排约 198×40),片段自己缩到一半也一样
  for (const layer of [1, 0.5]) {
    const fit = F.unsupportedFit({ box: { width: 1920, height: 1080 }, viewScale: view, layerScale: layer });
    const sc = screenOf(fit, fit.layout, view, layer);
    assert.equal(fit.layout, "row");
    assert.ok(Math.abs(sc.w - 198) < 1e-9 && Math.abs(sc.h - 40) < 1e-9, JSON.stringify(sc));
  }
  // 小到图标都放不下:按框等比缩小
  const tiny = F.unsupportedFit({ box: { width: 60, height: 50 }, viewScale: view, layerScale: 1 });
  assert.equal(tiny.layout, "icon");
  assert.ok(tiny.scale < 1 / view, "比目标小");
  assert.ok(F.UNSUPPORTED_SIZES.icon.w * tiny.scale <= 60 && F.UNSUPPORTED_SIZES.icon.h * tiny.scale <= 50);
});

test("PF-04 相邻两个小片段:图标各在自己的框里,屏幕上不相交", () => {
  const view = 0.27;
  // 两个 320×180 的片段挨着(舞台 x 0～320、320～640),图标都在框中心
  const boxes = [{ x: 0, w: 320 }, { x: 320, w: 320 }];
  const rects = boxes.map(({ x, w }) => {
    const fit = F.unsupportedFit({ box: { width: w, height: 180 }, viewScale: view, layerScale: 1 });
    const size = F.UNSUPPORTED_SIZES[fit.layout];
    const cw = size.w * fit.scale;
    return { left: x + w / 2 - cw / 2, right: x + w / 2 + cw / 2, fit };
  });
  assert.ok(rects[0].right <= rects[1].left, JSON.stringify(rects));
  assert.ok(rects[0].left >= 0 && rects[1].right <= 640);
});
