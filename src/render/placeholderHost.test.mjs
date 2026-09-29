/**
 * 占位平面舞台一侧的纯逻辑(`placeholderHost.ts`)。跑:node --test src/render/placeholderHost.test.mjs
 *
 * 钉的是:T1~T4 谁显示、显隐只切槽位的 `hidden`(contract 的 `setPlaceholderShown`)、
 * 几何的三级来源(流清单实体框 → 墨迹框 → 徽标)、缺省关着(导出页 / 预渲染 / 后台舞台从不打开),
 * 以及平面样式表放过占位平面。挂载与截图 / 命中的排除要浏览器,在 `preview-fallback-probe.mjs` 里验。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  applyPlaceholders, geometryFor, hideAllPlaceholders, noteInkBox, placeholdersEnabled, placeholderWanted,
  resetPlaceholderGeometry, setCatchingUpClips, setPlaceholdersEnabled, setStreamBoxSource, shownPlaceholders,
  PLACEHOLDER_SLOT_ATTR, setLocalOnlyConfirmed, localOnlyConfirmed, localOnlyReason,
} from "./placeholderHost.ts";
import { PLANE_CSS } from "./planeStyle.ts";
import { PLACEHOLDER_ATTR } from "./placeholder/contract.ts";

const set = (...ids) => new Set(ids);
/** 槽位的假件:`hidden` + 属性表(`applyPlaceholders` 只用这几样) */
function fakeSlot(attrs = {}) {
  return {
    hidden: true, attrs: { ...attrs },
    getAttribute(k) { return this.attrs[k] ?? null; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    hasAttribute(k) { return k in this.attrs; },
    toggleAttribute(k, on) { if (on) this.attrs[k] = ""; else delete this.attrs[k]; return !!on; },
  };
}
const base = { suppressed: set(), snapshots: new Map(), awaiting: set(), settling: new Map(), streamShowing: set() };

test("缺省关着:只有舞台页的 front 会打开(导出页、预渲染、后台舞台一个节点都不挂)", () => {
  assert.equal(placeholdersEnabled(), false);
  setPlaceholdersEnabled(true);
  assert.equal(placeholdersEnabled(), true);
  setPlaceholdersEnabled(false);
  assert.equal(placeholdersEnabled(), false);
});

test("T1:被抑制、流这一拍 blank、又没挂快照 → 显示;有流画面或有快照垫着 → 不显示", () => {
  const w = placeholderWanted({ ...base, suppressed: set("a", "b", "c"), snapshots: new Map([["b", "<div/>"]]), streamShowing: set("c") });
  assert.deepEqual([...w], [["a", "no-data"]]);
});

test("T2 等快照、T3 不可见追帧(没有快照垫着时)、T4 等后台补跑的轻卡", () => {
  setCatchingUpClips(["light"]);
  const w = placeholderWanted({
    ...base,
    suppressed: set("light"),
    awaiting: set("aw"),
    settling: new Map([["st", 1], ["st-snap", 2]]),
    snapshots: new Map([["st-snap", "<div/>"]]),
  });
  assert.equal(w.get("light"), "catching-up");
  assert.equal(w.get("aw"), "awaiting");
  assert.equal(w.get("st"), "catching-up");
  assert.equal(w.has("st-snap"), false, "追帧期间快照平面照常显示(`.pc-settling` 只藏子树)");
  setCatchingUpClips([]);
});

test("显隐只切槽位的 hidden;上一拍显示着、这一拍不要的关掉", () => {
  const slots = { a: fakeSlot(), b: fakeSlot() };
  const slotOf = (id) => slots[id] ?? null;
  assert.equal(applyPlaceholders(new Map([["a", "no-data"], ["gone", "no-data"]]), slotOf), 1, "没挂着槽位的跳过");
  assert.equal(slots.a.hidden, false);
  assert.equal(slots.a.attrs["data-pc-placeholder-reason"], "no-data");
  applyPlaceholders(new Map([["b", "awaiting"]]), slotOf);
  assert.equal(slots.a.hidden, true, "a 这一拍不要了");
  assert.equal(slots.b.hidden, false);
  hideAllPlaceholders(slotOf);
  assert.equal(slots.b.hidden, true);
  assert.equal(shownPlaceholders().size, 0);
});

test("几何:流清单实体框优先,其次墨迹框,都没有就在位置框中心放徽标;同样的输入回同一个对象", () => {
  resetPlaceholderGeometry();
  let streamBox = null;
  setStreamBoxSource(() => streamBox);
  const size = { width: 400, height: 200 };
  const badge = geometryFor("c", size);
  assert.deepEqual(badge, { kind: "badge", center: { x: 200, y: 100 } });
  assert.equal(geometryFor("c", size), badge, "没变就是同一个对象(占位组件是 React.memo)");
  noteInkBox("c", null);
  assert.equal(geometryFor("c", size).kind, "badge", "量不到墨迹框不记,不铺噪点");
  noteInkBox("c", { left: 10, top: 20, width: 30, height: 40 });
  assert.deepEqual(geometryFor("c", size), { kind: "solid", box: { left: 10, top: 20, width: 30, height: 40 } });
  streamBox = { x: 1, y: 2, w: 3, h: 4 };
  assert.deepEqual(geometryFor("c", size), { kind: "solid", box: { left: 1, top: 2, width: 3, height: 4 } });
  streamBox = null;
  assert.deepEqual(geometryFor("c", size).box, { left: 1, top: 2, width: 3, height: 4 }, "流停了,量到过的框留着");
  resetPlaceholderGeometry();
  assert.equal(geometryFor("c", size).kind, "badge", "换项目清掉");
});

test("平面样式表放过占位平面:藏子树的四条规则都不碰槽位和组件根元素", () => {
  for (const line of PLANE_CSS.split("\n")) {
    assert.ok(line.includes(`:not([${PLACEHOLDER_SLOT_ATTR}])`), line);
    assert.ok(line.includes(`:not([${PLACEHOLDER_ATTR}])`), line);
  }
});

/* ---------------------------------------------------------------- P3:同屏上限、unsupported 的显隐与判定 */

import { localOnlyClipIds, needsLocalPc, setMaxAnimated, setOnlineBrowserMode, unsupportedHere } from "./placeholderHost.ts";
import { PLACEHOLDER_FIXED_ATTR, PLACEHOLDER_STATIC_ATTR, UNSUPPORTED_TEXT } from "./placeholder/contract.ts";

test("同屏超过 maxAnimated 个:多出来的槽位加静止标记,撤下时摘掉", () => {
  setMaxAnimated(1);
  const slots = { a: fakeSlot(), b: fakeSlot(), c: fakeSlot() };
  const slotOf = (id) => slots[id] ?? null;
  applyPlaceholders(new Map([["a", "no-data"], ["b", "no-data"], ["c", "awaiting"]]), slotOf);
  const still = Object.entries(slots).filter(([, s]) => s.hasAttribute(PLACEHOLDER_STATIC_ATTR)).map(([id]) => id);
  assert.equal(still.length, 2, "只有一个在转");
  hideAllPlaceholders(slotOf);
  for (const s of Object.values(slots)) {
    assert.equal(s.hidden, true);
    assert.equal(s.hasAttribute(PLACEHOLDER_STATIC_ATTR), false);
  }
  setMaxAnimated(Infinity);
});

test("unsupported 进显隐调度(2026-09-29 起不再常驻):要它就显示并标原因,不要了就撤", () => {
  const slot = fakeSlot();
  const slotOf = () => slot;
  applyPlaceholders(new Map([["u", "unsupported"]]), slotOf);
  assert.equal(slot.hidden, false);
  assert.equal(slot.getAttribute("data-pc-placeholder-reason"), "unsupported");
  applyPlaceholders(new Map(), slotOf);
  assert.equal(slot.hidden, true, "快照或流到了:这一拍不要了就撤");
  // 旧的常驻标记不再有特权:带着它也照样被调度
  const legacy = fakeSlot({ [PLACEHOLDER_FIXED_ATTR]: "" });
  legacy.hidden = false;
  applyPlaceholders(new Map([["x", "unsupported"]]), () => legacy);
  applyPlaceholders(new Map(), () => legacy);
  assert.equal(legacy.hidden, true);
});

test("placeholderWanted:本机跑不了的卡贴不上快照 / 流时,父页确认没有结果才是 unsupported,其余是 awaiting 沙漏;贴得上就不显示", () => {
  const unsupported = new Set(["u", "s", "w", "q"]);
  const wanted = placeholderWanted({
    suppressed: new Set(["u", "b", "w", "q"]),
    snapshots: new Map([["s", "<div/>"]]),
    awaiting: new Set(["u", "a"]),
    settling: new Map([["u", 0]]),
    streamShowing: new Set(["w"]),
    unsupported,
    confirmedMissing: new Set(["u", "s", "w"]),
    isLight: () => false,
  });
  assert.equal(wanted.get("u"), "unsupported", "确认没有结果:被抑制、等快照、追帧的原因都换成 unsupported");
  assert.equal(wanted.get("q"), "awaiting", "没确认(层表 / 清单没到、字节在路上):沙漏");
  assert.equal(wanted.has("s"), false, "贴着快照:不显示");
  assert.equal(wanted.has("w"), false, "流这一拍画着:不显示");
  assert.equal(wanted.get("b"), "no-data", "内置卡照旧");
  assert.equal(wanted.get("a"), "awaiting");
  // 不在抑制、不等快照(普通档暂停)也显示:它没有活渲;确认了是图标,没确认是沙漏
  const idle = { suppressed: new Set(), snapshots: new Map(), awaiting: new Set(), settling: new Map(), streamShowing: new Set(), unsupported: new Set(["p"]) };
  assert.equal(placeholderWanted({ ...idle, confirmedMissing: new Set(["p"]) }).get("p"), "unsupported");
  assert.equal(placeholderWanted({ ...idle, confirmedMissing: new Set() }).get("p"), "awaiting", "暂停时也一样");
  // 缺省看 setLocalOnlyConfirmed 那一份
  assert.equal(setLocalOnlyConfirmed(["p"]), true);
  assert.equal(setLocalOnlyConfirmed(["p"]), false, "没变回 false");
  assert.equal(placeholderWanted(idle).get("p"), "unsupported");
  assert.equal(localOnlyReason("p"), "unsupported");
  assert.equal(localOnlyReason("z"), "awaiting");
  setLocalOnlyConfirmed([]);
  assert.equal(placeholderWanted(idle).get("p"), "awaiting");
  assert.equal(localOnlyConfirmed().size, 0);
  // 不给 unsupported:与以前逐项相同
  const old = placeholderWanted({ suppressed: new Set(["u"]), snapshots: new Map(), awaiting: new Set(), settling: new Map(), streamShowing: new Set(), isLight: () => false });
  assert.deepEqual([...old], [["u", "no-data"]]);
});

test("needsLocalPc / localOnlyClipIds:同步来的用户卡没有定义也认;两边都没有的 id 不算;缺省查注册表", async () => {
  const R = await import("../kernel/registry.ts");
  R.setUserCardSources({ built: "" }, { "built-user": "built" });
  R.setSyncedUserCards([{ id: "synced-user", name: "同步卡" }]);
  try {
    assert.equal(needsLocalPc("synced-user", undefined), true, "同步来的用户卡:没有 def 也认");
    assert.equal(needsLocalPc("built-user", { Component: () => null }), true, "构建时的用户卡");
    assert.equal(needsLocalPc("nobody", undefined), false, "两边都没有:未知卡片,不算");
    assert.equal(needsLocalPc("builtin", { Component: () => null }), false);
    assert.equal(needsLocalPc("graph", { card: () => ({}) }), true);
    const clips = [{ id: "a", cardId: "synced-user" }, { id: "b", cardId: "built-user" }, { id: "c", cardId: "nobody" }, { id: "d" }];
    assert.deepEqual([...localOnlyClipIds(clips)], [], "模式关着:空");
    setOnlineBrowserMode(true);
    try {
      assert.deepEqual([...localOnlyClipIds(clips)].sort(), ["a", "b"]);
      assert.equal(unsupportedHere("synced-user", undefined), true);
    } finally {
      setOnlineBrowserMode(false);
    }
  } finally {
    R.setSyncedUserCards([]);
    R.setUserCardSources({}, {});
  }
});

test("unsupported:只在在线浏览器模式下,且只认用户卡和图卡", () => {
  const isUser = (id) => id === "my-card";
  const dom = { Component: () => null };
  const graph = { card: () => ({}) };
  const audio = { audio: () => ({}) };
  assert.equal(unsupportedHere("my-card", dom, isUser), false, "模式没开:一律不算");
  setOnlineBrowserMode(true);
  try {
    assert.equal(unsupportedHere("my-card", dom, isUser), true, "用户卡");
    assert.equal(unsupportedHere("builtin-dom", dom, isUser), false, "内置 DOM 卡照常渲");
    assert.equal(unsupportedHere("builtin-graph", graph, isUser), true, "图卡");
    assert.equal(unsupportedHere("builtin-audio", audio, isUser), true, "音频图卡");
    assert.equal(unsupportedHere(undefined, dom, isUser), false, "素材段没有 cardId");
  } finally {
    setOnlineBrowserMode(false);
  }
  assert.equal(UNSUPPORTED_TEXT, "需要本地 PC 渲染辅助");
});

/* ---------------------------------------------------------------- 占位符在屏幕上的大小(纯函数在 placeholderFit.test.mjs) */

import { placeholderFitFor, placeholderViewScale, setPlaceholderViewScale } from "./placeholderHost.ts";

test("placeholderFitFor:沙漏只抵消预览缩放,图标还抵消这一层的缩放;徽标看位置框、铺满看实体框;同样的输入回同一个对象", () => {
  try {
    assert.equal(setPlaceholderViewScale(0.25), true);
    assert.equal(setPlaceholderViewScale(0.25), false, "没变回 false");
    assert.equal(placeholderViewScale(), 0.25);
    const badge = { kind: "badge", center: { x: 320, y: 180 } };
    const size = { width: 640, height: 360 };
    const h = placeholderFitFor("h", "awaiting", badge, size, 0.5);
    assert.deepEqual(h, { scale: 4 }, "沙漏:1 / 0.25,不管这一层的 0.5");
    assert.equal(placeholderFitFor("h", "awaiting", badge, size, 0.5), h, "同样的输入同一个对象");
    const u = placeholderFitFor("u", "unsupported", badge, size, 0.5);
    assert.equal(u.layout, "icon", "图标:目标倍数 1 / (0.25 × 0.5) = 8,横排、竖排、只留图标都放不进 640×360 → 只留图标、按框缩");
    assert.ok(u.scale < 8 && u.scale > 7, String(u.scale));
    setPlaceholderViewScale(0.5);
    assert.deepEqual(placeholderFitFor("u2", "unsupported", badge, { width: 360, height: 360 }, 1), { scale: 2, layout: "column" }, "横排 396 放不进 360 → 竖排");
    setPlaceholderViewScale(0.25);
    const solid = { kind: "solid", box: { left: 0, top: 0, width: 100, height: 100 } };
    assert.equal(placeholderFitFor("s", "unsupported", solid, size, 1).layout, "icon", "铺满形态看实体框(100×100)");
    setPlaceholderViewScale(1);
    assert.deepEqual(placeholderFitFor("h", "awaiting", badge, size, 1), { scale: 1 }, "预览 100%:原样");
    for (const bad of [0, -1, NaN, undefined, "x"]) { setPlaceholderViewScale(bad); assert.equal(placeholderViewScale(), 1, String(bad)); }
  } finally {
    setPlaceholderViewScale(1);
  }
});
