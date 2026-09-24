import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "../../testing/registerTs.mjs";

const contract = await import("./contract.ts");
const { PLACEHOLDER_CSS } = await import("./placeholderStyle.ts");
const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const component = readFileSync(new URL("./placeholderPlane.tsx", import.meta.url), "utf8");

test("the module satisfies the handoff shape and keeps one small shared tile", () => {
  assert.match(index, /export \{ PlaceholderPlane \}/);
  assert.match(index, /export \{ PLACEHOLDER_CSS \}/);
  assert.equal(typeof PLACEHOLDER_CSS, "string");
  assert.ok(PLACEHOLDER_CSS.includes("data:image/svg+xml,"));
  assert.ok(!/filter\s*:|backdrop-filter\s*:/.test(PLACEHOLDER_CSS));
  assert.ok(!/\[hidden\]/.test(PLACEHOLDER_CSS));
  assert.match(index, /export const maxAnimated = \d+/);
  assert.match(index, /export function layersFor\(/);
  assert.match(index, /return Number\.isFinite\(n\) && n > 0 \? 1 : 0/);
});

test("CSS animations have the reserved prefix and only animate opacity or transform", () => {
  const names = [...PLACEHOLDER_CSS.matchAll(/@keyframes\s+([\w-]+)\s*\{([^}]*\}[^}]*)\}/g)];
  assert.equal(names.length, 2);
  for (const [, name, body] of names) {
    assert.ok(contract.isPlaceholderAnimation({ animationName: name }));
    const props = [...body.matchAll(/([\w-]+)\s*:/g)].map((m) => m[1]);
    assert.ok(props.every((p) => p === "opacity" || p === "transform"), `${name}: ${props}`);
  }
});

test("solid and badge geometry render the required root and badge has no noise", () => {
  assert.match(component, /memo\(function PlaceholderPlane/);
  assert.match(component, /data-pc-placeholder-plane=""/);
  assert.match(component, /position: "absolute"/);
  assert.match(component, /geometry\.center\.x - 14/);
  assert.match(PLACEHOLDER_CSS, /\[data-pc-placeholder-kind="solid"\]\s*\{[^}]*background-image/s);
  assert.doesNotMatch(PLACEHOLDER_CSS, /\[data-pc-placeholder-kind="badge"\]\s*\{[^}]*background-image/s);
});

test("P3 集成修正:根元素不设 pointer-events:none(命中测试靠 elementsFromPoint),静止标记认槽位", () => {
  assert.doesNotMatch(PLACEHOLDER_CSS, /pointer-events\s*:\s*none/);
  assert.match(PLACEHOLDER_CSS, /\[data-pc-placeholder-static\] \.pc-ph-hourglass/);
});

test("unsupported:电脑 + 离线图标加固定文字,不用沙漏、不铺噪点、没有转动", () => {
  assert.match(component, /reason === "unsupported"/);
  assert.match(component, /UNSUPPORTED_TEXT/);
  assert.match(component, /pc-ph-offline/);
  assert.equal(contract.UNSUPPORTED_TEXT, "需要本地 PC 渲染辅助");
  assert.doesNotMatch(PLACEHOLDER_CSS, /kind="unsupported[^"]*"\]\s*\{[^}]*(background-image|animation)/s);
});
