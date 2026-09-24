/**
 * K5 第二路(整场景后台补跑后互换角色,`stageSwap.ts`)的单测。跑:
 *   node --experimental-test-module-mocks --test src/editor/stageSwap.test.mjs
 *
 * store、舞台桥、后台任务队列、分派表、身份表、快照投递、K6 父页一半都换成假的;
 * 判据用真的 `pipelinePlan.mjs` / `catchUpEstimate.mjs` / `frameWindow.mjs`。钉的是:
 *   - 谁要走第二路:判重 + `vtOk = false`、判轻 + (b) 档 + `vtOk = false`;没有成本记录的不走;
 *   - 补跑估时按播放位置、封顶整段,没有数就 1 秒;
 *   - 暂停态互换的顺序一步不能省(E0 / K5 (1)～(5));补跑期间用户动了就不换;
 *     运行中来的新请求只记最后一个,做完再补(R5-15);
 *   - 播放态互换:目标拍取整到拍格、武装停、换完 `play(T)`;两次追不上就降级且不清额外抑制(R5-11)。
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { clipWeight } from "../render/pipelinePlan.mjs";

globalThis.window = globalThis;

/* ---------------------------------------------------------------- 假环境 */

const log = [];
const state = { project: null, t: 0, playing: false };
let plan = { segments: [] };
let costs = [];
let identityKeys = {};
let frameModes = {};
const listeners = new Set();
const emit = (e) => { for (const l of [...listeners]) l(e); };
let front = null;
let back = null;

mock.module(srcUrl("store/project.ts"), { exports: { getState: () => state } });
mock.module(srcUrl("editor/stageBridge.ts"), {
  exports: {
    frontStage: () => front,
    backStage: () => back,
    onStageEvent: (l) => { listeners.add(l); return () => listeners.delete(l); },
    pushProject: async (role, project, opts) => { log.push(["pushProject", role, project === state.project, opts]); },
    // 根因 A:互换之后对新 front 补推一次增量
    syncProject: async (role, project) => { log.push(["syncProject", role, project === state.project]); },
  },
});
mock.module(srcUrl("editor/stageJobs.ts"), {
  exports: {
    runBackJob: async (kind, run) => { log.push(["runBackJob", kind]); return run({ stage: back, signal: new AbortController().signal }); },
  },
});
mock.module(srcUrl("editor/planDispatch.ts"), {
  exports: {
    currentPlan: () => plan,
    currentCosts: () => costs,
    currentTuning: () => undefined,
    sendPlanTo: async (role, opts) => { log.push(["sendPlanTo", role, opts]); },
  },
});
mock.module(srcUrl("editor/costIdentity.ts"), { exports: { clipIdentityOf: () => ({ identityKeys, frameModes }) } });
mock.module(srcUrl("editor/snapshotFeed.ts"), {
  exports: {
    deliverSnapshots: async (_stage, role, head) => { log.push(["deliverSnapshots", role, head.t, head.playing]); return 0; },
    markBaselineReset: (role) => log.push(["markBaselineReset", role]),
    markAllSettled: (role) => log.push(["markAllSettled", role]),
    setExtraSuppressed: (ids) => log.push(["setExtraSuppressed", [...ids]]),
    suppressedAt: () => ["h"],
    // R8:播放态互换时也发流平面(和抑制集合同一组)
    streamPlanesAt: () => [],
  },
});
mock.module(srcUrl("editor/demote.ts"), { exports: { onStageDemote: async (id) => { log.push(["demote", id]); return { ok: true, clipId: id }; } } });

const swap = await import(srcUrl("editor/stageSwap.ts"));
const {
  needsBackCatchUp, playingCatchUpTargets, staleOnBackCatchUp, guessCatchUpMs,
  runSettleSwap, runPlayingSwap, setSwapHost, resetStageSwap, swapInFlight, DEFAULT_CATCHUP_GUESS_MS,
} = swap;

/**
 * 假舞台客户端。每个方法都往 `log` 里记 `[名字, 方法, 参数…]`。
 * `render` / `setMediaT` / `pause` 的行为可以按测试换。
 */
function fakeStage(name) {
  const st = { name };
  const rec = (method) => async (...args) => { log.push([name, method, ...args]); return { ok: true }; };
  for (const m of ["setRole", "setLocalHashes", "setSuppressed", "setStreamPlanes", "setSnapshots", "setPlaying", "setScrubbing", "setProxy", "play"]) st[m] = rec(m);
  st.render = async (sec, opts) => { log.push([name, "render", sec, opts]); await st.renderGate; return { ok: true }; };
  st.renderGate = null;
  st.setMediaT = async (sec) => { log.push([name, "setMediaT", sec]); if (st.mediaReady !== false) emit({ type: "mediaReady" }); return { ok: true }; };
  st.pause = async (opts) => {
    log.push([name, "pause", opts]);
    const passed = st.passes > 0;
    if (passed) st.passes--;
    else queueMicrotask(() => emit({ type: "frame", sec: opts.atSec }));
    return { ok: true, passed };
  };
  st.passes = 0;
  return st;
}

const FPS = 30;
const card = (id, start, end) => ({ id, cardId: "c", start, end, params: {} });
const project = (clips) => ({ version: 1, name: "p", width: 1920, height: 1080, fps: FPS, duration: 20, media: [], tracks: [{ id: "t", name: "t", clips }] });
const segments = (heavyIds) => ({ segments: [{ fromSec: 0, toSec: 1000, heavy: new Set(heavyIds) }] });
/** 给片段挂一条成本记录(身份键就用 `k-<clipId>`) */
const withRecord = (clipId, record) => {
  identityKeys[clipId] = `k-${clipId}`;
  costs.push({ identityKey: `k-${clipId}`, device: "d", ...record });
};
const REC_B = { vtOk: false, stepMs: 2, stepMaxMs: 3, catchUpMs: 200 };   // 30 fps 下是 (b) 档
const REC_A = { vtOk: false, stepMs: 2, catchUpMs: 10 };                   // (a) 档:一拍内补齐

let host;
beforeEach(() => {
  resetStageSwap();
  log.length = 0;
  listeners.clear();
  plan = { segments: [] };
  costs = [];
  identityKeys = {};
  frameModes = {};
  front = fakeStage("A");
  back = fakeStage("B");
  host = {
    swapRoles() {
      log.push(["swapRoles"]);
      [front, back] = [back, front];
      return { front, back };
    },
    proxy: () => true,
    localHashes: () => ["h1"],
  };
  setSwapHost(host);
  Object.assign(state, { project: project([card("h", 0, 10), card("l", 0, 10)]), t: 1, playing: false });
});

const methodsOf = (name) => log.filter((e) => e[0] === name).map((e) => e[1]);

/* ---------------------------------------------------------------- 判据 */

test("前提:两条记录在 30 fps 下分别是 (b) 档和 (a) 档", () => {
  assert.equal(clipWeight(REC_B, undefined, FPS, undefined).tier, "catchup-b");
  assert.equal(clipWeight(REC_A, undefined, FPS, undefined).tier, "catchup-a");
});

test("needsBackCatchUp:判重且 vtOk 不是 true 的才走;没有成本记录的不走", () => {
  plan = segments(["h", "l"]);
  const p = project([card("h", 0, 10), card("l", 0, 10), card("n", 0, 10), card("ok", 0, 10)]);
  plan = segments(["h", "l", "n", "ok"]);
  withRecord("h", { vtOk: false });
  withRecord("l", {});
  withRecord("ok", { vtOk: true });
  assert.deepEqual(needsBackCatchUp(p, 1), ["h", "l"]);
});

test("needsBackCatchUp:判轻的、不在场的卡不走", () => {
  plan = segments([]);
  withRecord("h", { vtOk: false });
  assert.deepEqual(needsBackCatchUp(project([card("h", 0, 10)]), 1), []);
  plan = segments(["h"]);
  assert.deepEqual(needsBackCatchUp(project([card("h", 5, 10)]), 1), []);
});

test("playingCatchUpTargets:只收判轻、(b) 档、vtOk 不是 true 的", () => {
  const p = project([card("b", 0, 10), card("a", 0, 10), card("t", 0, 10), card("n", 0, 10)]);
  plan = segments([]);
  withRecord("b", REC_B);
  withRecord("a", REC_A);
  withRecord("t", { ...REC_B, vtOk: true });
  assert.deepEqual(playingCatchUpTargets(p, 1), ["b"]);
});

test("staleOnBackCatchUp:两类并起来、去重、排序", () => {
  const p = project([card("z", 0, 10), card("b", 0, 10)]);
  plan = segments(["z"]);
  withRecord("z", { vtOk: false });
  withRecord("b", REC_B);
  assert.deepEqual(staleOnBackCatchUp(p, 1), ["b", "z"]);
});

test("guessCatchUpMs:按播放位置估、封顶整段;没数就 1 秒", () => {
  const p = project([card("b", 0, 10)]);
  withRecord("b", REC_B);
  // 播放头在第 1 秒 = 第 30 帧,每帧最差 3 ms → 90 ms(比整段 200 小)
  assert.equal(guessCatchUpMs(p, ["b"], 1), 90);
  // 第 5 秒:150 帧 × 3 = 450,封顶在整段 200
  assert.equal(guessCatchUpMs(p, ["b"], 5), 200);
  assert.equal(guessCatchUpMs(p, ["nobody"], 1), DEFAULT_CATCHUP_GUESS_MS);
});

/* ---------------------------------------------------------------- 暂停态互换 */

test("暂停态互换:(1)～(5) 的顺序一步不少", async () => {
  plan = segments(["h"]);
  withRecord("h", { vtOk: false });
  assert.equal(await runSettleSwap(1), true);
  const steps = log.map((e) => e.slice(0, 2).join("."));
  assert.deepEqual(steps, [
    "runBackJob.catchup",
    "pushProject.back",
    "B.render",
    "B.setMediaT",
    "swapRoles",
    "A.setRole",
    "B.setRole",
    "syncProject.front",
    "sendPlanTo.front",
    "B.setLocalHashes",
    "markBaselineReset.front",
    "markAllSettled.front",
    "B.setSnapshots",
    "B.setPlaying",
    "B.setScrubbing",
    "B.setProxy",
  ]);
  const at = (step) => log.find((e) => e.slice(0, 2).join(".") === step);
  assert.deepEqual(at("pushProject.back").slice(2), [true, { reset: true }], "整份重灌当前项目、带 reset");
  assert.deepEqual(at("B.render").slice(2), [1, { jump: true, maxCatchUp: Infinity }], "不传 maxCatchUp 会被 6000 ms 削掉起点");
  assert.deepEqual(at("A.setRole").slice(2), ["back"], "旧 front 先退成 back");
  assert.deepEqual(at("B.setRole").slice(2), ["front"]);
  assert.deepEqual(at("syncProject.front").slice(2), [true], "根因 A:互换后对新 front 补推当前项目(增量由 stageBridge 按客户端基线算)");
  assert.deepEqual(at("sendPlanTo.front").slice(2), [{ force: true }], "它作为 back 时没有表,必须补发");
  assert.deepEqual(at("B.setLocalHashes").slice(2), [["h1"]]);
  assert.deepEqual(at("B.setSnapshots").slice(2), [{}, { reset: true }]);
  assert.deepEqual(at("B.setPlaying").slice(2), [false]);
  assert.deepEqual(at("B.setProxy").slice(2), [true], "实体模式要对新 front 重发");
  assert.equal(front.name, "B");
  assert.equal(swapInFlight(), false);
});

test("暂停态:没有要补跑的卡就什么都不做", async () => {
  plan = segments(["h"]);
  withRecord("h", { vtOk: true });
  assert.equal(await runSettleSwap(1), false);
  assert.deepEqual(log, []);
});

test("暂停态:补跑期间用户挪了播放头或开始播放,这一次不换", async () => {
  plan = segments(["h"]);
  withRecord("h", { vtOk: false });
  back.render = async (sec, opts) => { log.push(["B", "render", sec, opts]); state.t = 2; return { ok: true }; };
  assert.equal(await runSettleSwap(1), false);
  assert.equal(log.some((e) => e[0] === "swapRoles"), false);

  log.length = 0;
  state.t = 1;
  back.render = async (sec, opts) => { log.push(["B", "render", sec, opts]); state.playing = true; return { ok: true }; };
  assert.equal(await runSettleSwap(1), false);
  assert.equal(log.some((e) => e[0] === "swapRoles"), false);
});

test("暂停态:素材层不回 mediaReady 也在 300 ms 后照样换", async () => {
  plan = segments(["h"]);
  withRecord("h", { vtOk: false });
  back.mediaReady = false;
  const started = Date.now();
  assert.equal(await runSettleSwap(1), true);
  assert.ok(Date.now() - started >= 290);
});

test("暂停态:运行中来的请求只记最后一个,当前这次做完按它再做一遍(R5-15)", async () => {
  plan = segments(["h"]);
  withRecord("h", { vtOk: false });
  let open;
  back.renderGate = new Promise((r) => { open = r; });
  const first = runSettleSwap(1);
  await new Promise((r) => setImmediate(r));
  assert.equal(swapInFlight(), true);
  assert.equal(await runSettleSwap(2), false, "运行中:先记下");
  assert.equal(await runSettleSwap(3), false);
  // 用户最后停在第 3 秒:第 1 秒那次补完时 t 已经不对,不换;接着按 3 再做
  state.t = 3;
  open();
  assert.equal(await first, true);
  const renders = log.filter((e) => e[1] === "render").map((e) => e[2]);
  assert.deepEqual(renders, [1, 3], "中间的 2 被盖掉,不做");
  assert.equal(log.filter((e) => e[0] === "swapRoles").length, 1);
});

/* ---------------------------------------------------------------- 播放态互换 */

test("播放态互换:先额外抑制,目标拍取整到拍格,武装停到了再换,换完 play(T)", async () => {
  Object.assign(state, { project: project([card("b", 0, 10)]), t: 1, playing: true });
  plan = segments([]);
  withRecord("b", REC_B);
  assert.equal(await runPlayingSwap(["b"]), true);
  // 预估 90 ms:T = ceil((1 + 0.09) × 30) / 30 = 33 / 30
  const T = 33 / 30;
  assert.deepEqual(log[0], ["setExtraSuppressed", ["b"]]);
  assert.deepEqual(log.find((e) => e[1] === "render").slice(2), [T, { jump: true, maxCatchUp: Infinity }]);
  assert.deepEqual(log.find((e) => e[0] === "A" && e[1] === "pause").slice(2), [{ atSec: T }]);
  const i = (pred) => log.findIndex(pred);
  assert.ok(i((e) => e[0] === "A" && e[1] === "pause") > i((e) => e[1] === "setMediaT"), "back 就绪之后才武装停");
  assert.ok(i((e) => e[0] === "setExtraSuppressed" && e[1].length === 0) < i((e) => e[0] === "swapRoles"), "互换前清掉额外抑制");
  assert.deepEqual(methodsOf("B").slice(-8), ["setRole", "setLocalHashes", "setSuppressed", "setStreamPlanes", "setScrubbing", "setProxy", "play", "setPlaying"]);
  assert.deepEqual(log.find((e) => e[0] === "B" && e[1] === "play").slice(2), [T]);
  assert.deepEqual(log.find((e) => e[0] === "B" && e[1] === "setPlaying").slice(2), [true]);
  assert.deepEqual(log.find((e) => e[0] === "deliverSnapshots").slice(1), ["front", T, true]);
  assert.equal(log.some((e) => e[0] === "demote"), false);
});

test("播放态:可见舞台先走到 T,就翻倍重取 T' 对 back 续推(不带 jump)再武装", async () => {
  Object.assign(state, { project: project([card("b", 0, 10)]), t: 1, playing: true });
  plan = segments([]);
  withRecord("b", REC_B);
  front.passes = 1;
  assert.equal(await runPlayingSwap(["b"]), true);
  const renders = log.filter((e) => e[1] === "render");
  assert.equal(renders.length, 2);
  // 翻倍到 180 ms:T' = ceil(1.18 × 30) / 30 = 36 / 30
  assert.deepEqual(renders[1].slice(2), [36 / 30, { maxCatchUp: Infinity }]);
  assert.deepEqual(log.filter((e) => e[1] === "pause").map((e) => e[2].atSec), [33 / 30, 36 / 30]);
});

test("播放态:两次都追不上就降级(K6),而且不清额外抑制(R5-11)", async () => {
  Object.assign(state, { project: project([card("b", 0, 10), card("c", 0, 10)]), t: 1, playing: true });
  plan = segments([]);
  withRecord("b", REC_B);
  withRecord("c", REC_B);
  front.passes = 2;
  assert.equal(await runPlayingSwap(["b", "c"]), false);
  assert.deepEqual(log.filter((e) => e[0] === "demote").map((e) => e[1]), ["b", "c"]);
  assert.deepEqual(log.filter((e) => e[0] === "setExtraSuppressed"), [["setExtraSuppressed", ["b", "c"]]], "只设过一次,没有清");
  assert.equal(log.some((e) => e[0] === "swapRoles"), false);
  assert.equal(swapInFlight(), false);
});

test("播放态:中途停了播放就收手,额外抑制照清", async () => {
  Object.assign(state, { project: project([card("b", 0, 10)]), t: 1, playing: true });
  plan = segments([]);
  withRecord("b", REC_B);
  back.render = async (sec, opts) => { log.push(["B", "render", sec, opts]); state.playing = false; return { ok: true }; };
  assert.equal(await runPlayingSwap(["b"]), false);
  assert.deepEqual(log.filter((e) => e[0] === "setExtraSuppressed").map((e) => e[1]), [["b"], []]);
});

test("播放态:同时只跑一次;空列表不跑", async () => {
  assert.equal(await runPlayingSwap([]), false);
  Object.assign(state, { project: project([card("b", 0, 10)]), t: 1, playing: true });
  withRecord("b", REC_B);
  let open;
  back.renderGate = new Promise((r) => { open = r; });
  const first = runPlayingSwap(["b"]);
  await new Promise((r) => setImmediate(r));
  assert.equal(await runPlayingSwap(["b"]), false);
  assert.equal(await runSettleSwap(1), false, "暂停态那一路也要等它");
  open();
  assert.equal(await first, true);
});
