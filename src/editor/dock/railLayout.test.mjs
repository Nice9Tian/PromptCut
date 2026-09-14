/**
 * 侧边 rail 自由布局的纯逻辑。
 * 跑:node --experimental-test-module-mocks --test src/editor/dock/railLayout.test.mjs
 *
 * 钉死:读出来的布局怎么校验、拖动之后顺序和选中项怎么变、「+」画在哪、一侧拖空 / 对话式下哪些项看得见。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  SECTION_IDS,
  agentItem,
  defaultLayout,
  validateLayout,
  moveItem,
  plusAnchor,
  visibleItems,
  effectiveActive,
  sideVisible,
  syncAgents,
  gapToFullIndex,
  insertAgent,
  withActive,
  sameLayout,
} from "./railLayout.ts";

const A = (id) => agentItem(id);
const L = (left, right, active = {}) => ({
  left,
  right,
  active: { left: active.left ?? left[0] ?? null, right: active.right ?? right[0] ?? null },
});

test("默认布局 = 改版前:左边五个分区,右边剧本 + 各 Agent;选中项沿用旧键", () => {
  const d = defaultLayout(["main", "t2"]);
  assert.deepEqual(d.left, [...SECTION_IDS]);
  assert.deepEqual(d.right, ["script", A("main"), A("t2")]);
  assert.deepEqual(d.active, { left: "library", right: A("main") });

  const legacy = defaultLayout(["main", "t2"], { section: "captions", rightPage: "agent", activeTabId: "t2" });
  assert.deepEqual(legacy.active, { left: "captions", right: A("t2") });
  assert.equal(defaultLayout(["main"], { rightPage: "script" }).active.right, "script");
  assert.equal(defaultLayout(["main"], { section: "nope", activeTabId: "gone" }).active.left, "library", "旧键里不认识的值不用");
  assert.equal(defaultLayout(["main"], { activeTabId: "gone" }).active.right, A("main"));
});

test("校验:形状不对就用 fallback", () => {
  const fb = defaultLayout(["main"]);
  assert.equal(validateLayout(null, ["main"], fb), fb);
  assert.equal(validateLayout("x", ["main"], fb), fb);
  assert.equal(validateLayout({ left: "library" }, ["main"], fb), fb);
});

test("校验:去掉已不存在的 Agent 和不认识的项,重复的只留第一次", () => {
  const raw = {
    left: ["edit", A("gone"), "bogus", 42, "library"],
    right: [A("main"), "edit", "script", "captions", "animations", "effects"],
    active: { left: "edit", right: A("main") },
  };
  const v = validateLayout(raw, ["main"]);
  assert.deepEqual(v.left, ["edit", "library"]);
  assert.deepEqual(v.right, [A("main"), "script", "captions", "animations", "effects"]);
  assert.deepEqual(v.active, { left: "edit", right: A("main") });
});

test("校验:缺的分区按固定顺序补回左边末尾,缺的剧本补回右边顶上", () => {
  const v = validateLayout({ left: ["captions"], right: [A("main")], active: {} }, ["main"]);
  assert.deepEqual(v.left, ["captions", "library", "animations", "effects", "edit"]);
  assert.deepEqual(v.right, ["script", A("main")]);
});

test("校验:剧本和分区在另一侧也算数,不重复补", () => {
  const v = validateLayout({ left: ["script", ...SECTION_IDS], right: [A("main")], active: { left: "script" } }, ["main"]);
  assert.deepEqual(v.left, ["script", ...SECTION_IDS]);
  assert.deepEqual(v.right, [A("main")]);
  assert.equal(v.active.left, "script");
});

test("校验:缺的 Agent 放在最后一个 Agent 后面(右边优先,右边没有就左边)", () => {
  const v1 = validateLayout({ left: [...SECTION_IDS], right: ["script", A("main")] }, ["main", "t2", "t3"]);
  assert.deepEqual(v1.right, ["script", A("main"), A("t2"), A("t3")]);

  const v2 = validateLayout({ left: ["library", A("main"), "edit"], right: ["script"] }, ["main", "t2"]);
  assert.deepEqual(v2.left.slice(0, 4), ["library", A("main"), A("t2"), "edit"]);
  assert.deepEqual(v2.right, ["script"]);
});

test("校验:active 不在那一侧就退回 fallback 的选中项,再退回第一项;空侧是 null", () => {
  const fb = defaultLayout(["main"], { section: "effects" });
  const v = validateLayout({ left: [...SECTION_IDS], right: ["script", A("main")], active: { left: A("main"), right: "zzz" } }, ["main"], fb);
  assert.equal(v.active.left, "effects", "fallback 的 effects 还在左边");
  assert.equal(v.active.right, A("main"), "fallback 的 agent:main 还在右边");

  const empty = validateLayout({ left: [], right: ["script", ...SECTION_IDS, A("main")], active: { left: "library" } }, ["main"]);
  assert.deepEqual(empty.left, []);
  assert.equal(empty.active.left, null);
  assert.equal(empty.active.right, A("main"), "没存 right 的选中项:默认布局的 agent:main 还在右边,就用它");

  const noFallbackHit = validateLayout(
    { left: [...SECTION_IDS], right: ["script", A("main")], active: {} },
    ["main"],
    { left: [], right: [], active: { left: A("gone"), right: "captions" } },
  );
  assert.deepEqual(noFallbackHit.active, { left: "library", right: "script" }, "fallback 的选中项也不在那一侧,退回第一项");
});

test("move:同一侧往下 / 往上挪,gap 按被拖项还在原位数", () => {
  const base = L(["library", "animations", "effects", "edit", "captions"], ["script", A("main")]);
  // library 拖到 effects 和 edit 之间:gap = 3
  const down = moveItem(base, "library", "left", 3);
  assert.deepEqual(down.layout.left, ["animations", "effects", "library", "edit", "captions"]);
  assert.equal(down.layout.active.left, "library");
  assert.equal(down.emptied, null);
  // captions 拖到最上面
  const up = moveItem(base, "captions", "left", 0);
  assert.deepEqual(up.layout.left, ["captions", "library", "animations", "effects", "edit"]);
  // 原地放下:顺序不变,但成为选中项
  const same = moveItem(base, "effects", "left", 2);
  assert.deepEqual(same.layout.left, base.left);
  assert.equal(same.layout.active.left, "effects");
  assert.deepEqual(moveItem(base, "effects", "left", 3).layout.left, base.left, "紧挨着自己下面那道缝也是原地");
});

test("move:跨侧 —— 目标侧选中它;它原来是源侧选中项就改选相邻项(先上后下)", () => {
  const base = L(["library", "animations", "effects"], ["script", A("main")], { left: "animations", right: A("main") });
  const r = moveItem(base, "animations", "right", 1);
  assert.deepEqual(r.layout.left, ["library", "effects"]);
  assert.deepEqual(r.layout.right, ["script", "animations", A("main")]);
  assert.deepEqual(r.layout.active, { left: "library", right: "animations" });
  assert.equal(r.from, "left");
  assert.equal(r.to, "right");

  const top = moveItem(L(["library", "animations"], ["script"], { left: "library" }), "library", "right", 99);
  assert.equal(top.layout.active.left, "animations", "上面没有就选下面那一项");
  assert.deepEqual(top.layout.right, ["script", "library"], "gap 超界夹到末尾");

  const notActive = moveItem(base, "effects", "right", 0);
  assert.equal(notActive.layout.active.left, "animations", "拖走的不是源侧选中项,源侧不变");
});

test("move:源侧被拖空 → emptied,active 置 null,空 rail 仍然在", () => {
  const base = L(["library"], ["script", A("main")]);
  const r = moveItem(base, "library", "right", 3);
  assert.deepEqual(r.layout.left, []);
  assert.equal(r.layout.active.left, null);
  assert.equal(r.emptied, "left");
  // 再拖回空 rail
  const back = moveItem(r.layout, A("main"), "left", 0);
  assert.deepEqual(back.layout.left, [A("main")]);
  assert.equal(back.layout.active.left, A("main"));
  assert.equal(back.emptied, null);
});

test("move:改选相邻项时优先看得见的(对话式下跳过分区)", () => {
  const base = L(["script", "library", "edit", A("main")], [A("t2")], { left: A("main") });
  const chatVisible = (id) => id === "script" || id.startsWith("agent:");
  const r = moveItem(base, A("main"), "right", 1, chatVisible);
  assert.equal(r.layout.active.left, "script", "上面紧挨着的 edit / library 是分区,对话式下看不见,跳到 script");
  const classic = moveItem(base, A("main"), "right", 1);
  assert.equal(classic.layout.active.left, "edit");
});

test("move:不在布局里的项返回 null", () => {
  assert.equal(moveItem(L(["library"], ["script"]), A("nope"), "left", 0), null);
});

test("「+」:画在这一侧最后一个 Agent 项正下方;没有 Agent 不画", () => {
  assert.equal(plusAnchor(["script", A("main"), A("t2")]), 2);
  assert.equal(plusAnchor([A("main"), "library", "edit"]), 0);
  assert.equal(plusAnchor([A("main"), "library", A("t2"), "edit"]), 2);
  assert.equal(plusAnchor(["script", "library"]), -1);
  assert.equal(plusAnchor([]), -1, "空侧不画");
});

test("新建 Agent:插在那一侧最后一个 Agent 后面并在那一侧选中", () => {
  const base = L([A("main"), "library", "edit"], ["script", A("t2"), "captions"], { left: "library", right: "script" });
  const r = syncAgents(base, ["main", "t2", "t3"], "left");
  assert.deepEqual(r.layout.left, [A("main"), A("t3"), "library", "edit"]);
  assert.equal(r.layout.active.left, A("t3"));
  assert.equal(r.layout.active.right, "script", "另一侧不动");
  assert.deepEqual(r.added, [A("t3")]);

  const noHint = syncAgents(base, ["main", "t2", "t9"]);
  assert.deepEqual(noHint.layout.right, ["script", A("t2"), A("t9"), "captions"], "没提示放右边最后一个 Agent 后面");
  assert.equal(noHint.layout.active.right, "script", "没提示不抢选中");

  const onlyLeft = syncAgents(L([A("main")], ["script"]), ["main", "x"]);
  assert.deepEqual(onlyLeft.layout.left, [A("main"), A("x")], "右边没 Agent 就放左边");

  assert.deepEqual(insertAgent(L(["library"], []), "right", A("z")).right, [A("z")], "空侧直接放进去");
  assert.equal(insertAgent(L(["library"], []), "right", A("z")).active.right, A("z"), "空侧的 active 跟上");
});

test("关掉 Agent:拿掉那一项;是选中项就改选相邻项;那一侧空了报 emptied", () => {
  const base = L(["library", A("t2"), A("t3")], [A("main")], { left: A("t2") });
  const r = syncAgents(base, ["main", "t3"]);
  assert.deepEqual(r.layout.left, ["library", A("t3")]);
  assert.equal(r.layout.active.left, "library", "先往上找");
  assert.deepEqual(r.emptied, []);

  const empty = syncAgents(L([A("t2")], ["script", A("main")]), ["main"]);
  assert.deepEqual(empty.layout.left, []);
  assert.equal(empty.layout.active.left, null);
  assert.deepEqual(empty.emptied, ["left"]);

  const unchanged = L([...SECTION_IDS], ["script", A("main")]);
  assert.equal(syncAgents(unchanged, ["main"]).layout, unchanged, "没变化返回同一个对象");
});

test("对话式:rail 只显示 AI 类项;没有 AI 类项的一侧整列不显示;选中项退到看得见的第一项", () => {
  const layout = L(["library", A("t2"), "edit"], ["script", "captions", A("main")], { left: "edit", right: A("main") });
  assert.deepEqual(visibleItems(layout.left, "chat"), [A("t2")]);
  assert.deepEqual(visibleItems(layout.left, "classic"), ["library", A("t2"), "edit"]);
  assert.equal(effectiveActive(layout, "left", "chat"), A("t2"));
  assert.equal(effectiveActive(layout, "left", "classic"), "edit");
  assert.equal(effectiveActive(layout, "right", "chat"), A("main"));

  const noAiLeft = L([...SECTION_IDS], ["script", A("main")]);
  assert.equal(sideVisible(noAiLeft, "left", "chat"), false);
  assert.equal(sideVisible(noAiLeft, "right", "chat"), true);
  assert.equal(sideVisible(noAiLeft, "left", "classic"), true, "传统式两侧都显示");
  assert.equal(sideVisible(L([], ["script"]), "left", "classic"), true, "拖空的 rail 在传统式下也留着");
  assert.equal(effectiveActive(L([], ["script"]), "left", "classic"), null);
});

test("落点下标换算:对话式下只数画出来的项,隐藏的分区不跟着挪", () => {
  const full = ["library", "script", A("a"), "animations"];
  const shown = ["script", A("a")];
  assert.equal(gapToFullIndex(full, shown, 0), 1);
  assert.equal(gapToFullIndex(full, shown, 1), 2);
  assert.equal(gapToFullIndex(full, shown, 2), 3, "落在最后 = 最后一个画出来的项后面");
  assert.equal(gapToFullIndex(full, [], 0), 4);
  assert.equal(gapToFullIndex(full, full, 4), 4, "传统式就是原样");

  // 换算完交给 moveItem:script 拖到最后
  const layout = L(full, [A("b")], { left: "script" });
  const r = moveItem(layout, "script", "left", gapToFullIndex(full, shown, 2));
  assert.deepEqual(r.layout.left, ["library", A("a"), "script", "animations"]);
});

test("withActive / sameLayout", () => {
  const base = L([...SECTION_IDS], ["script", A("main")]);
  const next = withActive(base, "edit");
  assert.equal(next.active.left, "edit");
  assert.equal(base.active.left, "library", "不改原对象");
  assert.equal(withActive(base, A("nope")), base);
  assert.equal(sameLayout(base, JSON.parse(JSON.stringify(base))), true);
  assert.equal(sameLayout(base, next), false);
});
