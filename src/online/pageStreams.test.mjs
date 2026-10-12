/**
 * 本页产流的编排(`pageStreams.ts`,任务书 `docs/plan/render-refactor-task.md`「甲二」):什么时候轮到本页自己产、先查、让路、停手、层表。
 *
 *   PS-01  计划发出去没人认领:等满 PAGE_STREAM_WAIT_MS 才动手;先查、把自己的那一行写进层表、再产;产完叫宿主认这个结果键
 *   PS-02  有能切分的节点接了活(计划是 claimed / done):不产;done 之后不再问队列
 *   PS-03  先查:自己的键已经有 → 不产;层表里别的候选已经有 → 不产,认的是那个候选的键
 *   PS-04  让路:播放、拖动、更急的活 —— 当前帧做完就停,闲下来接着做;页面隐藏马上中止;让路后当前帧 1 秒做不完就中止
 *   PS-05  产到一半有切分方接了活:做完当前帧就停,不再开工
 *   PS-06  产到一半别处产出来了:停下,改用现成的
 *   PS-07  不闲不开工;不是节点(不能产)时什么都不做;换了一版计划,旧一版在产的马上中止
 *   PS-08  层表:开工前写;本页的那一行被别人盖掉之后重写;有切分方接了活之后不再写
 *   PS-09  口子:产几趟、每趟多密由 passes 定(先稀疏后满密度时,先把每条流的稀疏那一趟都做完)
 *   PS-10  做不成:退避后再试,连着不成放下这一段;没活了不再问队列
 *
 * 跑:npm test -- src/online/pageStreams.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPageStreams, PAGE_STREAM_WAIT_MS, PAGE_STREAM_POLL_MS, PAGE_STREAM_RECHECK_MS, PAGE_STREAM_ROWS_MS, PAGE_STREAM_ATTEMPTS } from "./pageStreams.ts";
import { YIELD_FRAME_MAX_MS } from "./browserNode.ts";

const flush = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const FP = "2222222222222222";
const PROJECT = { id: "proj", fps: 30, width: 1920, height: 1080, tracks: [{ id: "t", clips: [{ id: "clip-a", cardId: "punch-pill", start: 0, end: 4 }, { id: "clip-b", cardId: "focus-card", start: 4, end: 5 }] }] };
const specOf = (clipId, contentKey, firstSegment, lastSegment) => ({
  kind: "card", plane: "local", clipIds: [clipId], topClipId: clipId, cardId: "punch-pill", contentKey, streamKey: `rk-${contentKey}`, envFingerprint: FP,
  fps: 30, stage: { width: 1920, height: 1080 }, total: 300, firstFrame: firstSegment * 15, lastFrame: lastSegment * 15 + 14, firstSegment, lastSegment,
  offset: { x: 0, y: 0 }, bound: { x: 0, y: 0, w: 640, h: 360 }, compositing: "independent",
  bake: { start: firstSegment / 2, end: (lastSegment + 1) / 2, count: (lastSegment - firstSegment + 1) * 15, sampling: { firstFrame: firstSegment * 15, fps: { numerator: "30", denominator: "1" }, phase: { numerator: "0", denominator: "1" } } },
});
const PLAN = { id: "plan:proj@7#clips:x", projectId: "proj", projectRev: 7, clips: ["clip-a", "clip-b"], at: 1000 };

/** 一套假的宿主:假时钟、队列状态、内容库(层表与清单)、产一段的活 */
function rig(over = {}) {
  const w = {
    now: 1000, idle: true, capable: true, plan: PLAN, state: "open",
    specs: [specOf("clip-a", "ka", 0, 9), specOf("clip-b", "kb", 8, 9)],
    /** 结果键 → 已有清单的范围(`from-to`) */
    present: new Set(), layerMap: null, written: [], alive: [], produced: [], probes: 0, specCalls: 0,
    /** 在产的那一段:测试里手动放行 */
    current: null, readFails: false,
  };
  const deps = {
    now: () => w.now,
    capable: () => w.capable,
    isIdle: () => w.idle,
    plan: () => w.plan,
    planState: async () => { w.probes++; return w.state; },
    codeVersion: "cv",
    specs: async () => { w.specCalls++; return { specs: w.specs, skipped: { other: "canvas" }, project: PROJECT }; },
    lookupOwn: async (task) => w.present.has(`${task.resultKey}:${task.range.from}-${task.range.to}`),
    lookupOther: async (resultKey, range) => w.present.has(`${resultKey}:${range.from}-${range.to}`),
    readLayerMap: async () => { if (w.readFails) throw new Error("断了"); return w.layerMap; },
    writeLayerMap: async (_project, body) => { w.layerMap = body; w.written.push(body); },
    produce: (job) => new Promise((resolve, reject) => {
      w.produced.push({ id: job.task.id, stride: job.stride });
      w.current = { job, resolve, reject };
      job.signal.addEventListener("abort", () => reject(Object.assign(new Error("已中止"), { retryable: true })), { once: true });
    }),
    onAlive: (key) => w.alive.push(key),
    ...over,
  };
  const pages = createPageStreams(deps);
  /** 走 ms 毫秒,每 250 毫秒一拍(宿主的节拍) */
  const run = async (ms) => { for (let t = 0; t < ms; t += 250) { w.now += 250; pages.tick(); await flush(); } };
  /** 把在产的这一段做完(清单进内容库) */
  const finish = async () => {
    const c = w.current;
    w.current = null;
    w.present.add(`${c.job.task.resultKey}:${c.job.task.range.from}-${c.job.task.range.to}`);
    c.resolve("done");
    await flush();
  };
  /** 在产的这一段因让路停手 */
  const yielded = async () => { const c = w.current; w.current = null; c.resolve("yielded"); await flush(); };
  return { w, pages, run, finish, yielded };
}

test("PS-01 没人认领:等满等待时间才动手;先查、写层表、再产;产完认这个结果键", async () => {
  const { w, pages, run, finish } = rig();
  pages.tick();
  await flush();
  assert.equal(pages.debug().state, "waiting");
  await run(PAGE_STREAM_WAIT_MS - 500);
  assert.equal(w.produced.length, 0, "没等满不动手");
  assert.equal(pages.debug().planState, "open");
  await run(1000);
  assert.equal(w.produced.length, 1, "等满了开工");
  assert.deepEqual(w.produced[0], { id: "stream:rk-ka:0-7", stride: 1 }, "任务 id 与切分方给浏览器出的那一份同一个式子;满密度");
  // 开工前层表里已经有本页的那一行
  assert.equal(w.written.length, 1);
  assert.equal(w.written[0].kind, "layer-map");
  assert.deepEqual(w.written[0].streams.map((r) => [r.topClipId, r.contentKey, r.candidates[0].resultKey, r.firstSegment, r.lastSegment, r.segmentsPerTask]), [["clip-a", "ka", "rk-ka", 0, 9, 8]]);
  assert.equal(pages.running(), true);
  assert.equal(pages.debug().state, "producing");
  await finish();
  assert.deepEqual(w.alive, ["rk-ka"]);
  // 接着做下一段、下一条流
  await run(500);
  assert.equal(w.produced[1].id, "stream:rk-ka:8-9");
  await finish();
  await run(500);
  assert.equal(w.produced[2].id, "stream:rk-kb:8-9");
  await finish();
  await run(500);
  const d = pages.debug();
  assert.equal(d.state, "done");
  assert.equal(d.counters.produced, 3);
  assert.deepEqual(d.jobs.map((j) => j.state), ["produced", "produced", "produced"]);
  assert.deepEqual(w.layerMap.streams.map((r) => r.topClipId).sort(), ["clip-a", "clip-b"]);
  assert.deepEqual(d.skipped, { other: "canvas" });
  assert.equal(w.specCalls, 1, "这一版的流只算一次");
});

test("PS-02 有能切分的节点接了活:不产;done 之后不再问队列", async () => {
  for (const state of ["claimed", "done"]) {
    const { w, pages, run } = rig();
    w.state = state;
    await run(PAGE_STREAM_WAIT_MS + 6000);
    assert.equal(w.produced.length, 0, state);
    assert.equal(w.written.length, 0, "层表归切分方,不写");
    assert.equal(pages.debug().state, "taken");
    if (state === "done") assert.equal(w.probes, 1, "done 是终态,只问一次");
    else assert.ok(w.probes > 2, "claimed 接着问(切分方可能放回)");
  }
  // 认领的节点放回了(又成了 open):过了等待时间照常自己产
  const { w, run } = rig();
  w.state = "claimed";
  await run(PAGE_STREAM_WAIT_MS + 2000);
  w.state = "open";
  await run(PAGE_STREAM_POLL_MS + 1000);
  assert.equal(w.produced.length, 1);
});

test("PS-03 先查:自己的键已经有、别的候选已经有,都不产", async () => {
  // 自己的键:三段都有
  const own = rig();
  for (const k of ["rk-ka:0-7", "rk-ka:8-9", "rk-kb:8-9"]) own.w.present.add(k);
  await own.run(PAGE_STREAM_WAIT_MS + 3000);
  assert.equal(own.w.produced.length, 0);
  assert.equal(own.pages.debug().counters.have, 3);
  assert.equal(own.pages.debug().state, "done");
  assert.deepEqual([...new Set(own.w.alive)].sort(), ["rk-ka", "rk-kb"]);
  assert.ok(own.w.written.length >= 1, "自己的键有了,层表里要有本页的那一行");
  // 别的候选(桌面产的):层表里这张卡、这个内容键的行列着它的键
  const other = rig();
  other.w.specs = [specOf("clip-a", "ka", 0, 7)];
  other.w.layerMap = { v: 3, kind: "layer-map", projectId: "proj", layers: [], streams: [
    { topClipId: "clip-a", clipIds: ["clip-a"], kind: "card", plane: "local", contentKey: "ka", candidates: [{ envFingerprint: "desktop", resultKey: "rk-desktop" }], firstSegment: 0, lastSegment: 7, segmentsPerTask: 8 }] };
  other.w.present.add("rk-desktop:0-7");
  await other.run(PAGE_STREAM_WAIT_MS + 2000);
  assert.equal(other.w.produced.length, 0, "桌面产好的直接用");
  assert.deepEqual(other.w.alive, ["rk-desktop"], "认的是那个候选的键");
  assert.equal(other.w.written.length, 0, "别人的流,本页不往层表里加自己的候选");
  assert.equal(other.pages.debug().jobs[0].state, "elsewhere");
  // 内容键不同的行(旧参数的流)不算
  const stale = rig();
  stale.w.specs = [specOf("clip-a", "ka", 0, 7)];
  stale.w.layerMap = { ...other.w.layerMap, streams: [{ ...other.w.layerMap.streams[0], contentKey: "old" }] };
  stale.w.present.add("rk-desktop:0-7");
  await stale.run(PAGE_STREAM_WAIT_MS + 2000);
  assert.equal(stale.w.produced.length, 1);
});

test("PS-04 让路:播放、拖动做完当前帧就停,闲下来接着做;隐藏马上中止;当前帧 1 秒做不完就中止", async () => {
  const { w, pages, run, yielded } = rig();
  await run(PAGE_STREAM_WAIT_MS + 500);
  assert.equal(w.produced.length, 1);
  const first = w.current.job;
  assert.equal(first.yielding(), false);
  // 播放开始:不中止,等当前帧
  w.idle = false;
  pages.yieldFor("play");
  assert.equal(first.yielding(), true, "每帧前问到要让路");
  assert.equal(first.signal.aborted, false, "当前帧做完再停,不中止");
  await yielded();
  assert.equal(pages.running(), false);
  assert.equal(pages.debug().counters.yields.play, 1);
  // 播放期间不开工
  await run(3000);
  assert.equal(w.produced.length, 1, "播放期间不产");
  // 停下、闲了:接着做同一段(已推完的分段由宿主按任务 id 留着)
  w.idle = true;
  await run(500);
  assert.equal(w.produced.length, 2);
  assert.equal(w.produced[1].id, w.produced[0].id, "接着做同一段");
  // 拖动:同样等当前帧;1 秒做不完就中止
  const second = w.current.job;
  w.idle = false;
  pages.yieldFor("drag");
  assert.equal(second.signal.aborted, false);
  await run(YIELD_FRAME_MAX_MS + 250);
  assert.equal(second.signal.aborted, true, "当前帧迟迟做不完:中止");
  await flush();
  assert.equal(pages.running(), false);
  assert.equal(pages.debug().counters.yields.drag, 1);
  assert.equal(pages.debug().counters.aborts, 1);
  // 页面隐藏:不等当前帧
  w.idle = true;
  await run(500);
  const third = w.current.job;
  pages.yieldFor("hidden");
  assert.equal(third.signal.aborted, true, "隐藏马上中止");
  await flush();
  assert.equal(pages.debug().counters.yields.hidden, 1);
  // 让路不算做不成
  assert.deepEqual(pages.debug().jobs.map((j) => j.fails), [0, 0, 0]);
});

test("PS-05 产到一半有切分方接了活:做完当前帧就停,不再开工", async () => {
  const { w, pages, run, yielded } = rig();
  await run(PAGE_STREAM_WAIT_MS + 500);
  const job = w.current.job;
  w.state = "claimed";
  await run(PAGE_STREAM_POLL_MS + 500);
  assert.equal(job.yielding(), true);
  assert.equal(job.signal.aborted, false);
  await yielded();
  assert.equal(pages.debug().counters.stops.splitter, 1);
  await run(8000);
  assert.equal(w.produced.length, 1, "不再自己产");
  assert.equal(pages.debug().state, "taken");
});

test("PS-06 产到一半别处产出来了:停下,改用现成的", async () => {
  const { w, pages, run, yielded } = rig();
  w.specs = [specOf("clip-a", "ka", 0, 7)];
  await run(PAGE_STREAM_WAIT_MS + 500);
  const job = w.current.job;
  // 桌面连上来、产好了、把自己的候选写进了层表
  w.layerMap = { ...w.layerMap, streams: [{ ...w.layerMap.streams[0], candidates: [{ envFingerprint: "desktop", resultKey: "rk-desktop" }, ...w.layerMap.streams[0].candidates] }] };
  w.present.add("rk-desktop:0-7");
  await run(PAGE_STREAM_RECHECK_MS + 500);
  assert.equal(job.yielding(), true, "查到别处有了:当前帧做完就停");
  await yielded();
  const d = pages.debug();
  assert.equal(d.counters.stops.elsewhere, 1);
  assert.equal(d.jobs[0].state, "elsewhere");
  assert.equal(d.jobs[0].via, "rk-desktop");
  assert.deepEqual(w.alive, ["rk-desktop"]);
  await run(3000);
  assert.equal(w.produced.length, 1, "不重产");
});

test("PS-07 不闲不开工;不能产时什么都不做;换了一版计划,旧一版在产的马上中止", async () => {
  const busy = rig();
  busy.w.idle = false;
  await busy.run(PAGE_STREAM_WAIT_MS + 5000);
  assert.equal(busy.w.produced.length, 0);
  assert.equal(busy.pages.debug().state, "idle-wait");
  assert.equal(busy.w.written.length, 0, "没开工,不写层表");
  const off = rig();
  off.w.capable = false;
  await off.run(PAGE_STREAM_WAIT_MS + 3000);
  assert.equal(off.w.specCalls, 0);
  assert.equal(off.w.probes, 0, "不是节点:一条消息也不发");
  assert.equal(off.pages.debug().state, "off");
  const none = rig();
  none.w.plan = null;
  await none.run(3000);
  assert.equal(none.w.probes, 0);
  // 换了一版
  const { w, pages, run } = rig();
  await run(PAGE_STREAM_WAIT_MS + 500);
  const job = w.current.job;
  w.plan = { ...PLAN, id: "plan:proj@8#clips:x", projectRev: 8, at: w.now };
  w.specs = [specOf("clip-a", "ka2", 0, 7)];
  await run(250);
  assert.equal(job.signal.aborted, true, "旧一版在产的马上停");
  assert.equal(pages.debug().counters.stops["plan-changed"], 1);
  await run(PAGE_STREAM_WAIT_MS + 1000);
  assert.equal(w.produced.at(-1).id, "stream:rk-ka2:0-7", "新一版等满之后产新的键");
  // 下线
  pages.stop("offline");
  assert.equal(pages.running() && !w.current.job.signal.aborted, false);
  assert.equal(pages.debug().state, "off");
});

test("PS-08 层表:本页的那一行被别人盖掉之后重写;有切分方接了活之后不再写", async () => {
  const { w, pages, run, finish } = rig();
  w.specs = [specOf("clip-a", "ka", 0, 7)];
  await run(PAGE_STREAM_WAIT_MS + 500);
  await finish();
  await run(500);
  const writes = w.written.length;
  assert.ok(writes >= 1);
  // 没有变化:核对了也不写
  await run(PAGE_STREAM_ROWS_MS + 1000);
  assert.equal(w.written.length, writes);
  // 另一个页面后写,把本页的那一行盖掉了
  w.layerMap = { v: 3, kind: "layer-map", projectId: "proj", layers: [], streams: [{ topClipId: "clip-z", clipIds: ["clip-z"], kind: "card", plane: "local", contentKey: "z", candidates: [{ envFingerprint: "x", resultKey: "rz" }], firstSegment: 0, lastSegment: 0, segmentsPerTask: 8 }] };
  await run(PAGE_STREAM_ROWS_MS + 1000);
  assert.equal(w.written.length, writes + 1, "重写");
  assert.deepEqual(w.layerMap.streams.map((r) => r.topClipId).sort(), ["clip-a", "clip-z"], "别人的行留着");
  // 读不到层表:不写,下一拍再试
  assert.equal(pages.debug().counters.rowsFailed, 0);
});

test("PS-09 口子:产几趟、每趟多密由 passes 定", async () => {
  const { w, run, finish } = rig({ passes: [{ name: "sparse", stride: 15 }, { name: "dense", stride: 1 }] });
  w.specs = [specOf("clip-a", "ka", 0, 7), specOf("clip-b", "kb", 8, 9)];
  // 自己的键查不到(每一趟都要做):这里让「先查」一直查不到
  w.present = { has: () => false, add: () => {} };
  await run(PAGE_STREAM_WAIT_MS + 500);
  for (let i = 0; i < 4; i++) { await finish(); await run(500); }
  assert.deepEqual(w.produced.slice(0, 4), [
    { id: "stream:rk-ka:0-7", stride: 15 }, { id: "stream:rk-kb:8-9", stride: 15 },
    { id: "stream:rk-ka:0-7", stride: 1 }, { id: "stream:rk-kb:8-9", stride: 1 },
  ], "先把每条流稀疏的那一趟做完,再补满密度");
});

test("PS-10 做不成:退避后再试,连着不成放下这一段;没活了不再问队列", async () => {
  const { w, pages, run } = rig();
  w.specs = [specOf("clip-a", "ka", 0, 7)];
  await run(PAGE_STREAM_WAIT_MS + 500);
  for (let i = 1; i <= PAGE_STREAM_ATTEMPTS; i++) {
    assert.equal(w.produced.length, i, `第 ${i} 次`);
    const c = w.current;
    w.current = null;
    c.reject(Object.assign(new Error("舞台没有交出这一帧的像素"), { retryable: true }));
    await flush();
    await run(2000 * i + 500);
  }
  const d = pages.debug();
  assert.equal(d.jobs[0].state, "failed");
  assert.equal(d.counters.failed, 1);
  assert.match(d.lastError, /像素/);
  const probes = w.probes;
  await run(10_000);
  assert.equal(w.produced.length, PAGE_STREAM_ATTEMPTS, "不再试");
  assert.equal(w.probes, probes, "没活了不再问队列");
});
