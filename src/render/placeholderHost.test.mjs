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
  PLACEHOLDER_SLOT_ATTR,
} from "./placeholderHost.ts";
import { PLANE_CSS } from "./planeStyle.ts";
import { PLACEHOLDER_ATTR } from "./placeholder/contract.ts";

const set = (...ids) => new Set(ids);
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
  const slots = { a: { hidden: true, attrs: {}, getAttribute(k) { return this.attrs[k] ?? null; }, setAttribute(k, v) { this.attrs[k] = v; } } };
  slots.b = { ...slots.a, attrs: {} };
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
