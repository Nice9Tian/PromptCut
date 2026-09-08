/**
 * kernel/envelope.ts 的单测。跑:node --test src/kernel/envelope.test.mjs
 *
 * 封装是 Agent 和代码页看一张卡的唯一入口,读和写必须自洽:
 *   - 读出来的 parts 只带各自的参数,params 是全量,两边是同一份数据;
 *   - 写回只碰有差异的段,顺序固定;
 *   - 不合法的输入一处都不写(不留半截状态),错误信息说人话;
 *   - 只读段(world / motion / lifecycle)写了也不生效。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { envelopeOf, applyEnvelope, ENVELOPE_SCHEMA, describeLifecycle } from "./envelope.ts";

const STAGE = { width: 1920, height: 1080 };

const card = {
  id: "pin-board",
  name: "要点钉板",
  source: "native",
  description: "",
  defaults: { position: "left", accent: "", title: "SUMMARY", subtitle: "核心要点总结", items: "a|b|c", stepMs: 200 },
  controls: [
    { key: "position", label: "位置", type: "select", options: [{ value: "left", label: "l" }, { value: "center", label: "c" }] },
    { key: "accent", label: "主色", type: "color" },
    { key: "title", label: "小标题", type: "text" },
    { key: "subtitle", label: "副标题", type: "text" },
    { key: "items", label: "要点", type: "text" },
    { key: "stepMs", label: "间隔", type: "number" },
  ],
  parts: [
    { id: "title", label: "小标题", role: "text", params: ["title"], enterMs: 0, settleMs: 600 },
    { id: "subtitle", label: "副标题", role: "text", params: ["subtitle", "accent"], enterMs: 100, settleMs: 700 },
    { id: "items", label: "要点", role: "list", params: ["items", "stepMs"], enterMs: 300, settleMs: 1100 },
  ],
  lifecycle: { settleMs: 1100, after: "hold", exit: ["fade"] },
  Component: () => null,
};

function project(clip) {
  return { name: "p", width: 1920, height: 1080, fps: 30, duration: 20, themeId: "t", media: [], tracks: [{ id: "t1", kind: "overlay", name: "序列 1", clips: [clip] }], cuts: [] };
}

function clipOf(extra = {}) {
  return { id: "c1", cardId: "pin-board", start: 2.4, end: 5.4, params: { ...card.defaults }, ...extra };
}

function recorder() {
  const calls = [];
  return {
    calls,
    writer: {
      setClipCard: (id, cardId) => calls.push(["card", id, cardId]),
      setClipParams: (id, params, opts) => calls.push(["params", id, params, opts]),
      moveClip: (id, patch) => calls.push(["time", id, patch]),
      setClipFrame: (id, frame) => calls.push(["frame", id, frame]),
      updateClip: (id, patch) => calls.push(["blend", id, patch]),
    },
  };
}

// validateCardParams 走的是全局注册表,测试里把这张卡注册进去
const { registerCards } = await import("./registry.ts");
registerCards([card]);

test("读:parts 只带自己的参数,params 全量,lifecycle 来自卡片,world 由 frame 算出", () => {
  const env = envelopeOf(project(clipOf()), clipOf(), card, STAGE);
  assert.equal(env.$schema, ENVELOPE_SCHEMA);
  assert.equal(env.card.lifecycle.settleMs, 1100);
  assert.deepEqual(env.time, { start: 2.4, end: 5.4, duration: 3 });
  assert.equal(env.frame.local, null);
  assert.equal(env.frame.world.w, 1920);
  assert.deepEqual(env.blend, { opacity: 1, fadeIn: 0, fadeOut: 0 });
  assert.equal(env.motion.attached, false);
  assert.deepEqual(env.parts.map((p) => p.id), ["title", "subtitle", "items"]);
  assert.deepEqual(env.parts[1].params, { subtitle: "核心要点总结", accent: "" });
  assert.equal(Object.keys(env.params).length, 6);
  assert.equal(env.missingParams, undefined);
  assert.match(describeLifecycle(env), /1\.1s 落定/);
  assert.match(describeLifecycle(env), /1\.9s 是静止/);
});

test("读:没声明 parts 的卡是一个根部件,所有参数都归它;老 clip 缺的参数列在 missingParams", () => {
  const bare = { ...card, id: "bare", parts: undefined, lifecycle: undefined };
  const clip = clipOf({ cardId: "bare", params: { title: "x" } });
  const env = envelopeOf(project(clip), clip, bare, STAGE);
  assert.equal(env.parts.length, 1);
  assert.equal(env.parts[0].id, "root");
  assert.deepEqual(env.parts[0].params, { title: "x" });
  assert.deepEqual(env.card.lifecycle, { after: "hold", exit: ["fade"] });
  assert.deepEqual(env.missingParams.sort(), ["accent", "items", "position", "stepMs", "subtitle"]);
});

test("写:原样传回去什么都不写;只改一段就只写那一段", () => {
  const clip = clipOf();
  const env = envelopeOf(project(clip), clip, card, STAGE);
  const r0 = recorder();
  assert.deepEqual(applyEnvelope(project(clip), "c1", env, card, STAGE, r0.writer, () => card).changed, []);
  assert.equal(r0.calls.length, 0);

  const r1 = recorder();
  const edited = JSON.parse(JSON.stringify(env));
  edited.blend.fadeOut = 0.4;
  edited.time.end = 3.6;
  const rep = applyEnvelope(project(clip), "c1", edited, card, STAGE, r1.writer, () => card);
  assert.deepEqual(rep.changed, ["time", "blend"]);
  assert.deepEqual(r1.calls, [["time", "c1", { start: 2.4, end: 3.6 }], ["blend", "c1", { fadeOut: 0.4 }]]);
});

test("写:改 parts 里的参数等于改 params;两边都给以 params 为准", () => {
  const clip = clipOf();
  const env = envelopeOf(project(clip), clip, card, STAGE);
  const r = recorder();
  const edited = JSON.parse(JSON.stringify(env));
  edited.parts[0].params.title = "TAKEAWAYS";
  assert.deepEqual(applyEnvelope(project(clip), "c1", edited, card, STAGE, r.writer, () => card).changed, ["params"]);
  assert.equal(r.calls[0][2].title, "TAKEAWAYS");
  assert.equal(r.calls[0][2].items, "a|b|c", "没改的参数原样带着");

  const r2 = recorder();
  applyEnvelope(project(clip), "c1", { params: { ...clip.params, title: "P" }, parts: edited.parts }, card, STAGE, r2.writer, () => card);
  assert.equal(r2.calls[0][2].title, "P");
});

test("写:frame.local 可写、world 只读;null 表示清掉框", () => {
  const clip = clipOf({ frame: { x: 100, y: 100, anchor: [0, 0] } });
  const r = recorder();
  applyEnvelope(project(clip), "c1", { frame: { local: { x: 200, y: 300, w: 640, h: 360, anchor: [0.5, 0.5], scale: 0.5 }, world: { x: 1 } } }, card, STAGE, r.writer, () => card);
  assert.deepEqual(r.calls, [["frame", "c1", { x: 200, y: 300, w: 640, h: 360, anchor: [0.5, 0.5], scale: 0.5 }]]);
  const r2 = recorder();
  applyEnvelope(project(clip), "c1", { frame: { local: null } }, card, STAGE, r2.writer, () => card);
  assert.deepEqual(r2.calls, [["frame", "c1", undefined]]);
});

test("写:任一处不合法整份不写,错误说人话", () => {
  const clip = clipOf();
  const bad = [
    [{ time: { end: 1 } }, /end > start/],
    [{ frame: { local: { x: 1 } } }, /x、y 必须是数字/],
    [{ frame: { local: { x: 1, y: 1, foo: 2 } } }, /不认识 "foo"/],
    [{ blend: { opacity: 2 } }, /0~1/],
    [{ card: { id: "nope" } }, /没有这张卡/],
    [{ params: { position: "top" } }, /只能是 left \/ center/],
    [{ params: { nope: 1 } }, /不是 pin-board 的参数/],
    [{ blend: { fadeIn: -1 }, time: { end: 9 } }, /不能为负/],
  ];
  for (const [input, re] of bad) {
    const r = recorder();
    assert.throws(() => applyEnvelope(project(clip), "c1", input, card, STAGE, r.writer, (id) => (id === "pin-board" ? card : undefined)), re, JSON.stringify(input));
    assert.equal(r.calls.length, 0, "不合法时一处都不该写:" + JSON.stringify(input));
  }
});

test("写:换卡先于写参数,新卡的参数按新卡校验", () => {
  const other = { ...card, id: "other-card", controls: [{ key: "text", label: "文字", type: "text", required: true }], defaults: { text: "" }, parts: undefined };
  registerCards([card, other]);
  const clip = clipOf();
  const r = recorder();
  const rep = applyEnvelope(project(clip), "c1", { card: { id: "other-card" }, params: { text: "hi" } }, card, STAGE, r.writer, (id) => (id === "other-card" ? other : card));
  assert.deepEqual(rep.changed, ["card", "params"]);
  assert.equal(r.calls[0][0], "card");
  assert.throws(() => applyEnvelope(project(clip), "c1", { card: { id: "other-card" } }, card, STAGE, recorder().writer, (id) => (id === "other-card" ? other : card)), /必填/);
});

test("时序随参数重算:条目多了落定就晚,静态值只是默认参数下的参考", () => {
  const timed = {
    ...card,
    id: "timed-card",
    timing: (p) => {
      const count = String(p.items).split("|").filter(Boolean).length;
      const settle = 300 + (count - 1) * Number(p.stepMs) + 400;
      return { settleMs: settle, parts: { items: { settleMs: settle } } };
    },
  };
  registerCards([card, timed]);
  const base = clipOf({ cardId: "timed-card" });
  const env0 = envelopeOf(project(base), base, timed, STAGE);
  assert.equal(env0.card.lifecycle.settleMs, 1100, "默认 3 条 × 200ms 和静态声明一致");
  const more = clipOf({ cardId: "timed-card", params: { ...card.defaults, items: "a|b|c|d|e|f", stepMs: 500 } });
  const env1 = envelopeOf(project(more), more, timed, STAGE);
  assert.equal(env1.card.lifecycle.settleMs, 300 + 5 * 500 + 400);
  assert.equal(env1.parts.find((p) => p.id === "items").settleMs, 300 + 5 * 500 + 400);
  assert.equal(env1.parts.find((p) => p.id === "title").settleMs, 600, "timing 没提到的部件保留静态值");
  // timing 算炸了不能把封装拖垮
  const broken = { ...timed, id: "broken-card", timing: () => { throw new Error("boom"); } };
  registerCards([card, broken]);
  const b = clipOf({ cardId: "broken-card" });
  assert.equal(envelopeOf(project(b), b, broken, STAGE).card.lifecycle.settleMs, 1100);
});
