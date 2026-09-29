import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "../../testing/registerTs.mjs";

const contract = await import("./contract.ts");
const { PLACEHOLDER_CSS, PLACEHOLDER_ONLINE_CSS, PERF_DEGRADED } = await import("./placeholderStyle.ts");
const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const component = readFileSync(new URL("./placeholderPlane.tsx", import.meta.url), "utf8");

test("the module satisfies the handoff shape", () => {
  assert.match(index, /export \{ PlaceholderPlane \}/);
  assert.match(index, /export \{ PLACEHOLDER_CSS, PERF_DEGRADED \}/);
  assert.equal(typeof PLACEHOLDER_CSS, "string");
  assert.ok(!/filter\s*:|backdrop-filter\s*:/.test(PLACEHOLDER_CSS));
  assert.ok(!/\[hidden\]/.test(PLACEHOLDER_CSS));
  assert.match(index, /export const maxAnimated = /);
  assert.match(index, /export function layersFor\(/);
});

test("CSS animations have the reserved prefix and only animate opacity or transform", () => {
  const names = [...PLACEHOLDER_CSS.matchAll(/@keyframes\s+([\w-]+)\s*\{([^}]*\}[^}]*)\}/g)];
  // 降级时只剩 120 ms 出现延迟那一条;不降级时还有沙漏转动
  assert.equal(names.length, PERF_DEGRADED ? 1 : 2);
  for (const [, name, body] of names) {
    assert.ok(contract.isPlaceholderAnimation({ animationName: name }));
    const props = [...body.matchAll(/([\w-]+)\s*:/g)].map((m) => m[1]);
    assert.ok(props.every((p) => p === "opacity" || p === "transform"), `${name}: ${props}`);
  }
  assert.match(PLACEHOLDER_CSS, /pc-ph-reveal 120ms/, "120 ms 出现延迟降级后也保留");
});

test("solid and badge geometry render the required root; badge never has noise", () => {
  assert.match(component, /memo\(function PlaceholderPlane/);
  assert.match(component, /data-pc-placeholder-plane=""/);
  assert.match(component, /position: "absolute"/);
  assert.match(component, /geometry\.center\.x - 14/);
  assert.doesNotMatch(PLACEHOLDER_CSS, /\[data-pc-placeholder-kind="badge"\]\s*\{[^}]*background-image/s);
});

test("性能降级(P4 熔断协议):不铺噪点、沙漏不转、不新增合成层", () => {
  if (!PERF_DEGRADED) return;
  assert.ok(!PLACEHOLDER_CSS.includes("background-image"), "没有噪点贴图");
  assert.ok(!/pc-ph-turn/.test(PLACEHOLDER_CSS), "没有转动动画");
  // index.ts 引 .tsx,node 直接 import 不了,按源码核对降级分支
  assert.match(index, /maxAnimated = PERF_DEGRADED \? 0 : 1/);
  assert.match(index, /if \(PERF_DEGRADED\) return 0;/);
});

test("P3 集成修正:根元素不设 pointer-events:none(命中测试靠 elementsFromPoint)", () => {
  assert.doesNotMatch(PLACEHOLDER_CSS, /pointer-events\s*:\s*none/);
  if (!PERF_DEGRADED) assert.match(PLACEHOLDER_CSS, /\[data-pc-placeholder-static\] \.pc-ph-hourglass/);
});

test("unsupported:电脑 + 离线图标加固定文字,不用沙漏、不铺噪点、没有转动", () => {
  assert.match(component, /reason === "unsupported"/);
  assert.match(component, /UNSUPPORTED_TEXT/);
  assert.match(component, /pc-ph-offline/);
  assert.equal(contract.UNSUPPORTED_TEXT, "需要本地 PC 渲染辅助");
  assert.doesNotMatch(PLACEHOLDER_CSS, /kind="unsupported[^"]*"\]\s*\{[^}]*(background-image|animation)/s);
});

test("fit:沙漏与图标按舞台一侧算好的倍数放大(中心不动);图标按 layout 横排 / 竖排 / 只留图标;倍数 1 时不写 transform", () => {
  // 图标小徽标:translate 在前、scale 在后,中心不动;倍数 1 只有 translate
  assert.match(component, /translate\(-50%, -50%\) scale\(\$\{s\}\)/);
  assert.match(component, /s === 1 \? "translate\(-50%, -50%\)"/);
  assert.match(component, /data-pc-placeholder-layout=\{layout\}/);
  // 沙漏:徽标的圆整个放大;铺满形态只放大中间那个(噪点铺在根元素上,不缩放)
  assert.match(component, /width: 28, height: 28, \.\.\.\(s !== 1 \? \{ transform: `scale\(\$\{s\}\)` \} : null\)/);
  assert.match(component, /className="pc-ph-center"[^>]*style=\{solid && s !== 1 \? \{ transform: `translate\(-50%, -50%\) scale\(\$\{s\}\)` \}/);
  // 不再用 CSS 变量
  assert.doesNotMatch(component + PLACEHOLDER_CSS + PLACEHOLDER_ONLINE_CSS, /--pc-ph-ui-scale/);
  // 排法规则只在在线那一份里:竖排、只留图标(字藏起来)
  assert.match(PLACEHOLDER_ONLINE_CSS, /layout="column"\][^{]*\.pc-ph-unsupported\s*\{[^}]*flex-direction:\s*column/s);
  assert.match(PLACEHOLDER_ONLINE_CSS, /layout="icon"\]\s*\.pc-ph-unsupported-text\s*\{[^}]*display:\s*none/s);
  assert.match(PLACEHOLDER_ONLINE_CSS, /kind="unsupported"\]\s*\{[^}]*overflow:\s*hidden/s);
  assert.doesNotMatch(PLACEHOLDER_CSS, /data-pc-placeholder-layout/, "桌面注入的那一份不带排法规则");
});
