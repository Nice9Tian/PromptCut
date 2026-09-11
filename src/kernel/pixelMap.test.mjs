import test from "node:test";
import assert from "node:assert/strict";
import { normalizePixelMapDef, mapRgba, parseColor } from "./pixelMap.mjs";

test("pixel map safely evaluates selection and channel expressions", () => {
  const d = normalizePixelMapDef({ name: "暗部", where: "1-smoothstep(0,.25,luma)", to: { kind: "expr", r: "r^1.6", g: "g^1.6", b: "b^1.6", a: "a" } });
  const out = mapRgba(d, [.1, .1, .1, 1]);
  assert.ok(out[0] < .1 && out[3] === 1);
  assert.deepEqual(parseColor("#f30"), [1, 0.2, 0, 1]);
});

test("pixel map supports shorthand colors, transparent and continuous sequence alignment", () => {
  const red = normalizePixelMapDef({ name: "红", where: "1", to: "#ff0000" });
  assert.deepEqual(mapRgba(red, [0, 0, 0, 1]), [1, 0, 0, 1]);
  const clear = normalizePixelMapDef({ name: "抠", where: "1", to: "transparent" });
  assert.equal(mapRgba(clear, [1, 0, 0, 1])[3], 0);
  const seq = normalizePixelMapDef({ name: "序列", where: "1", to: "#fff", colorSequence: { from: ["#000", "#fff"], to: ["#001133", "#ffcc88", "#ffffff"], mode: "continuous" } });
  const out = mapRgba(seq, [1, 1, 1, 1]);
  assert.deepEqual(out.slice(0, 3), [1, 1, 1]);
});

test("unsafe expressions and malformed stages are rejected", () => {
  assert.throws(() => normalizePixelMapDef({ name: "x", where: "window.alert(1)", to: "#fff" }), /表达式有问题/);
  assert.throws(() => normalizePixelMapDef({ name: "x", where: "1", to: { kind: "color", value: "#fff" }, source: { stage: "shader" } }), /stage/);
});
