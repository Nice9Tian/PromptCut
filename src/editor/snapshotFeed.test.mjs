/**
 * 父页快照 / 抑制投递(`snapshotFeed.ts`,C4 / C5 / A3c / K6 的消费方)的单测。跑:
 *   node --experimental-test-module-mocks --test src/editor/snapshotFeed.test.mjs
 *
 * 就绪索引和取字节换成假的快照来源,分派表和镜像键换成假的;选帧(`snapshotPick.mjs`)、
 * 就绪索引的合并(`snapshotSource.ts`)用真的。钉的是:
 *   - 只有判重的活跃卡进 heavy,按就绪索引回溯选帧,缺的报 wanted(最多 8 条);
 *   - K6 降级卡在死素材覆盖「从播放头起 min(fps, 剩余帧)」之前照常活渲;
 *   - 投递基线:增量、摘掉、33 ms 节流、reset 不受节流且带 reset、2 MB 拆包、失败后下次带 reset;
 *   - `pickForSetTime` 同步回手里已有的字节,`awaiting` 只点「有表但没带上快照」的卡;
 *   - settled 把卡从基线里删掉,下次同一帧会重投;
 *   - 抑制集合只在播放中有,并上 K3(b) 的额外抑制。
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

let plan = { segments: [] };
const wantedPushed = [];

mock.module(srcUrl("editor/planDispatch.ts"), { exports: { currentPlan: () => plan } });
mock.module(srcUrl("render/dataMirror.ts"), {
  exports: { mirrorKey: () => ({ session: "s", localRev: 1 }), pushWanted: (w) => wantedPushed.push(w) },
});

const feed = await import(srcUrl("editor/snapshotFeed.ts"));
const {
  planFeed, pickForSetTime, deliverSnapshots, noteSettled, markBaselineReset, markPendingDemote, pendingDemotes,
  setExtraSuppressed, suppressedAt, setSnapshotSource, syncSnapshotSubscription, resetSnapshotFeed, setSnapshotArrive,
  MAX_WANTED, SNAPSHOT_THROTTLE_MS, SNAPSHOT_DELIVERY_MAX_BYTES,
} = feed;

/* ---------------------------------------------------------------- 假环境 */

let now = 1000;
performance.now = () => now;

/** 假快照来源:手动推就绪消息;取字节回 `html:<id>`,可以指定某些 id 的内容 */
function fakeSource() {
  const src = {
    push: null,
    bodies: new Map(),
    fetched: [],
    subscribeReady(_session, _rev, onMessage) { src.push = onMessage; return () => { src.push = null; }; },
    async fetchSnapshot(kind, key, localFrame) {
      const id = `${kind}/${key}/${localFrame}`;
      src.fetched.push(id);
      return src.bodies.get(id) ?? `html:${id}`;
    },
  };
  return src;
}

/** 假舞台客户端:记下每次 setSnapshots,可以让它失败 */
function fakeStage() {
  const st = { calls: [], fail: false };
  st.setSnapshots = async (patch, opts) => {
    if (st.fail) throw new Error("iframe gone");
    st.calls.push({ patch, opts });
  };
  return st;
}

const FPS = 30;
const card = (id, start, end) => ({ id, cardId: "c", start, end, params: {} });
const project = (clips) => ({ version: 1, name: "p", width: 1920, height: 1080, fps: FPS, duration: 20, media: [], tracks: [{ id: "t", name: "t", clips }] });
const heavyEverywhere = (...ids) => ({ segments: [{ fromSec: 0, toSec: 1000, heavy: new Set(ids) }] });
const layer = (clipId, ranges, kind = "html", key = `k-${clipId}`) => ({ type: "layer", clipId, kind, key, ranges });
const settle = () => new Promise((r) => setImmediate(r));

let src;
beforeEach(() => {
  resetSnapshotFeed();
  src = fakeSource();
  setSnapshotSource(src);
  syncSnapshotSubscription(() => {});
  setExtraSuppressed([]);
  plan = { segments: [] };
  wantedPushed.length = 0;
  now += 10_000;
});

/* ---------------------------------------------------------------- 选帧 */

test("只有判重、正在挂载的卡进 heavy;轻卡和不在场的卡不进", () => {
  const p = project([card("h", 0, 10), card("l", 0, 10), card("gone", 12, 15)]);
  plan = heavyEverywhere("h", "gone");
  assert.deepEqual(planFeed({ project: p, t: 1, playing: false }).heavy, ["h"]);
});

test("按就绪索引回溯选帧;回溯了就报当前想要的那一帧", () => {
  const p = project([card("h", 0, 10)]);
  plan = heavyEverywhere("h");
  src.push(layer("h", [[0, 20]]));
  const f = planFeed({ project: p, t: 1, playing: false });
  assert.equal(f.picks.get("h").localFrame, 20, "第 30 帧没就绪,回溯到同区间里最近的 20");
  assert.deepEqual(f.wanted, [{ clipId: "h", frame: 30 }]);

  src.push(layer("h", [[0, 40]]));
  const g = planFeed({ project: p, t: 1, playing: false });
  assert.equal(g.picks.get("h").localFrame, 30);
  assert.deepEqual(g.wanted, [], "选中的就是当前帧:不报");
});

test("html 表缺时用 local 表;一张表都没有就不选、只报缺口", () => {
  const p = project([card("h", 0, 10), card("g", 0, 10)]);
  plan = heavyEverywhere("h", "g");
  src.push(layer("h", [[0, 100]], "local"));
  const f = planFeed({ project: p, t: 1, playing: false });
  assert.equal(f.picks.get("h").kind, "local");
  assert.equal(f.picks.has("g"), false);
  assert.deepEqual(f.wanted, [{ clipId: "g", frame: 30 }]);
});

test("缺口一次最多报 8 条", () => {
  const ids = Array.from({ length: 12 }, (_, i) => `h${String(i).padStart(2, "0")}`);
  plan = heavyEverywhere(...ids);
  const f = planFeed({ project: project(ids.map((id) => card(id, 0, 10))), t: 1, playing: false });
  assert.equal(f.heavy.length, 12);
  assert.equal(f.wanted.length, MAX_WANTED);
});

/* ---------------------------------------------------------------- K6 */

test("K6:降级卡死素材就绪之前照常活渲,不进 heavy", () => {
  const p = project([card("h", 0, 10)]);
  plan = heavyEverywhere("h");
  markPendingDemote("h");
  // 播放头在第 30 帧:要覆盖 [30, 59](一秒)才算就绪
  src.push(layer("h", [[0, 58]]));
  assert.deepEqual(planFeed({ project: p, t: 1, playing: true }).heavy, []);
  assert.ok(pendingDemotes().has("h"));
  src.push(layer("h", [[0, 59]]));
  assert.deepEqual(planFeed({ project: p, t: 1, playing: true }).heavy, ["h"]);
  assert.equal(pendingDemotes().has("h"), false, "就绪之后移出 pending");
});

test("K6:片段剩下不到一秒时,覆盖到片尾就算就绪;流要按分段盖住当前位置起的一秒才算(根因 D)", () => {
  const p = project([card("h", 0, 10)]);   // 300 帧,本地 0..299
  plan = heavyEverywhere("h");
  markPendingDemote("h");
  src.push(layer("h", [[290, 299]]));
  assert.deepEqual(planFeed({ project: p, t: 290 / FPS, playing: true }).heavy, ["h"]);

  resetSnapshotFeed();
  setSnapshotSource(src);
  syncSnapshotSubscription(() => {});
  markPendingDemote("h");
  src.push(layer("h", [[0, 0]], "stream"));
  assert.deepEqual(planFeed({ project: p, t: 1, playing: true }).heavy, [], "流表有别的段不算:当前位置没料");
  // 第 1 秒 = 第 30 帧,一秒到第 59 帧 = 第 2、3 段
  src.push(layer("h", [[2, 3]], "stream"));
  assert.deepEqual(planFeed({ project: p, t: 1, playing: true }).heavy, ["h"]);
});

/* ---------------------------------------------------------------- 投递 */

test("pickForSetTime:第一次缺字节就发起取、同步回空并点名 awaiting;到货后同步带上", async () => {
  const p = project([card("h", 0, 10)]);
  plan = heavyEverywhere("h");
  src.push(layer("h", [[0, 100]]));
  const head = { project: p, t: 1, playing: false };
  const first = pickForSetTime(head);
  assert.deepEqual(first, { snapshots: {}, awaiting: ["h"] });
  assert.deepEqual(src.fetched, ["html/k-h/30"]);
  await settle();
  const second = pickForSetTime(head);
  assert.deepEqual(second, { snapshots: { h: "html:html/k-h/30" }, awaiting: [] });
  // 同一帧已经挂着:不重投,也不 awaiting
  assert.deepEqual(pickForSetTime(head), { snapshots: {}, awaiting: [] });
});

test("pickForSetTime:没有表的判重卡不 awaiting(等也等不来)", () => {
  plan = heavyEverywhere("h");
  assert.deepEqual(pickForSetTime({ project: project([card("h", 0, 10)]), t: 1, playing: false }).awaiting, []);
});

test("deliverSnapshots:33 ms 节流;不再判重的卡摘掉(null)", async () => {
  const p = project([card("h", 0, 10)]);
  plan = heavyEverywhere("h");
  src.push(layer("h", [[0, 100]]));
  const stage = fakeStage();
  const head = { project: p, t: 1, playing: true };
  await deliverSnapshots(stage, "front", head);    // 发起取字节,手里还没有:什么都不发
  await settle();
  assert.equal(await deliverSnapshots(stage, "front", head), 1);
  assert.deepEqual(stage.calls.at(-1), { patch: { h: "html:html/k-h/30" }, opts: {} });

  now += SNAPSHOT_THROTTLE_MS - 1;
  plan = heavyEverywhere();
  assert.equal(await deliverSnapshots(stage, "front", head), 0, "节流内不发");
  now += 1;
  assert.equal(await deliverSnapshots(stage, "front", head), 1);
  assert.deepEqual(stage.calls.at(-1).patch, { h: null });
  now += SNAPSHOT_THROTTLE_MS;
  assert.equal(await deliverSnapshots(stage, "front", head), 0, "没变化:一条 RPC 都不发");
});

test("setSnapshotArrive:投递时缺的那一帧取到之后叫一次重投(在线页面不走 SSE 订阅,c10a)", async () => {
  const p = project([card("h", 0, 10)]);
  plan = heavyEverywhere("h");
  src.push(layer("h", [[0, 100]]));
  let arrived = 0;
  setSnapshotArrive(() => { arrived++; });
  const stage = fakeStage();
  const head = { project: p, t: 1, playing: false };
  assert.equal(await deliverSnapshots(stage, "front", head), 0, "手里还没有字节:先发起取");
  await settle();
  assert.equal(arrived, 1, "字节到了:叫宿主重投");
  now += SNAPSHOT_THROTTLE_MS;
  assert.equal(await deliverSnapshots(stage, "front", head), 1);
  setSnapshotArrive(null);
});

test("deliverSnapshots:reset 不受节流,带 reset 并把该挂的整份重投", async () => {
  const p = project([card("h", 0, 10)]);
  plan = heavyEverywhere("h");
  src.push(layer("h", [[0, 100]]));
  const stage = fakeStage();
  const head = { project: p, t: 1, playing: true };
  await deliverSnapshots(stage, "front", head);
  await settle();
  await deliverSnapshots(stage, "front", head);
  markBaselineReset("front");
  assert.equal(await deliverSnapshots(stage, "front", head), 1, "紧接着(节流内)也发");
  assert.deepEqual(stage.calls.at(-1), { patch: { h: "html:html/k-h/30" }, opts: { reset: true } });
});

test("deliverSnapshots:一次只投一包、≤ 2 MB,装不下的下一拍再投;只有第一包带 reset", async () => {
  const ids = ["a", "b", "c"];
  plan = heavyEverywhere(...ids);
  const big = "x".repeat(Math.ceil(SNAPSHOT_DELIVERY_MAX_BYTES * 0.6));
  for (const id of ids) {
    src.push(layer(id, [[0, 100]]));
    src.bodies.set(`html/k-${id}/30`, big);
  }
  const stage = fakeStage();
  const head = { project: project(ids.map((id) => card(id, 0, 10))), t: 1, playing: true };
  await deliverSnapshots(stage, "back", head);
  await settle();
  markBaselineReset("back");
  assert.equal(await deliverSnapshots(stage, "back", head), 1);
  now += SNAPSHOT_THROTTLE_MS;
  assert.equal(await deliverSnapshots(stage, "back", head), 1);
  now += SNAPSHOT_THROTTLE_MS;
  assert.equal(await deliverSnapshots(stage, "back", head), 1);
  now += SNAPSHOT_THROTTLE_MS;
  assert.equal(await deliverSnapshots(stage, "back", head), 0, "都投完了");
  assert.deepEqual(stage.calls.map((c) => Object.keys(c.patch)), [["a"], ["b"], ["c"]]);
  assert.deepEqual(stage.calls.map((c) => c.opts), [{ reset: true }, {}, {}]);
});

test("deliverSnapshots:发送失败后,下一次带 reset", async () => {
  const p = project([card("h", 0, 10)]);
  plan = heavyEverywhere("h");
  src.push(layer("h", [[0, 100]]));
  const stage = fakeStage();
  const head = { project: p, t: 1, playing: true };
  await deliverSnapshots(stage, "front", head);
  await settle();
  stage.fail = true;
  assert.equal(await deliverSnapshots(stage, "front", head), 0);
  stage.fail = false;
  now += SNAPSHOT_THROTTLE_MS;
  assert.equal(await deliverSnapshots(stage, "front", head), 1);
  assert.deepEqual(stage.calls.at(-1).opts, { reset: true });
});

test("settled 把卡从基线里删掉:同一帧会重投", async () => {
  const p = project([card("h", 0, 10)]);
  plan = heavyEverywhere("h");
  src.push(layer("h", [[0, 100]]));
  const head = { project: p, t: 1, playing: false };
  pickForSetTime(head);
  await settle();
  assert.deepEqual(Object.keys(pickForSetTime(head).snapshots), ["h"]);
  assert.deepEqual(pickForSetTime(head).snapshots, {});
  noteSettled("front", ["h"]);
  assert.deepEqual(Object.keys(pickForSetTime(head).snapshots), ["h"]);
});

/*
 * c10a 契约第 17 节「停下追当前一帧」取代了原来的「低内存档不追活渲」:低内存档停下时舞台把当前这一帧追一次,
 * 画好的层收 `settled`,和普通档一样暂停中不再盖回小尺寸;下一次 setTime / 播放照常选。
 * (这条用例原来断言「低内存档忽略 settled、暂停时仍选小尺寸」,按新规则改。)
 */
test("低内存档停下追一帧画好的层(settled)暂停中不再选小尺寸;下一次 setTime 照常选", () => {
  const p = project([card("h", 0, 10)]);
  plan = heavyEverywhere("h");
  src.push(layer("h", [[0, 100]]));
  noteSettled("front", ["h"]);
  assert.equal(planFeed({ project: p, t: 1, playing: false }).picks.size, 0);
  assert.equal(planFeed({ project: p, t: 1, playing: false, lowMemory: true }).picks.size, 0);
  pickForSetTime({ project: p, t: 1, playing: false, lowMemory: true });
  assert.equal(planFeed({ project: p, t: 1, playing: false, lowMemory: true }).picks.size, 1);
});

/* ---------------------------------------------------------------- 抑制 */

test("抑制集合只在播放中有,并上 K3(b) 的额外抑制", () => {
  const p = project([card("h", 0, 10), card("l", 0, 10)]);
  plan = heavyEverywhere("h");
  assert.deepEqual(suppressedAt({ project: p, t: 1, playing: false }), []);
  assert.deepEqual(suppressedAt({ project: p, t: 1, playing: true }), ["h"]);
  setExtraSuppressed(["l", "h"]);
  assert.deepEqual(suppressedAt({ project: p, t: 1, playing: true }), ["h", "l"]);
  assert.deepEqual(suppressedAt({ project: p, t: 1, playing: false }), []);
});

test("wanted 报给预渲染进程", () => {
  plan = heavyEverywhere("h");
  pickForSetTime({ project: project([card("h", 0, 10)]), t: 1, playing: false });
  assert.deepEqual(wantedPushed, [[{ clipId: "h", frame: 30 }]]);
});

test("低内存档:一层的就绪表有缺口(清单缺几帧小尺寸)时,有的帧照常选,缺的回溯同区间,段首缺才不选(占位)", () => {
  const p = project([card("h", 0, 10)]);
  plan = heavyEverywhere("h");
  // 阿里云 2026-09-27 手机上的样子:第 0 帧与 28～31 缺小尺寸
  src.push(layer("h", [[1, 27], [32, 119]]));
  const at = (t) => planFeed({ project: p, t, playing: false, lowMemory: true }).picks.get("h")?.localFrame ?? null;
  assert.equal(at(0), null, "段首缺:没有更早的可回溯");
  assert.equal(at(5 / FPS), 5);
  assert.equal(at(1), 27, "第 30 帧缺:回溯到 27");
  assert.equal(at(3), 90);
});

/* ---------------------------------------------------------------- C10 第 9 节:在线的用户卡、图卡 */

test("在线浏览器模式:用户卡、图卡(含同步来的)一律按重卡,照常选帧、报缺口、取字节;停下不认「已精确」;桌面照旧(C10 契约第 9 节,2026-09-29)", async () => {
  const registry = await import(srcUrl("kernel/registry.ts"));
  const host = await import(srcUrl("render/placeholderHost.ts"));
  registry.registerCards([{ id: "graphish", card: () => null, params: {} }]);
  registry.setUserCardSources({ "mine.tsx": "" }, { mine: "mine.tsx" });
  registry.setSyncedUserCards([{ id: "synced", name: "同步卡" }]);
  const clips = [
    { ...card("u", 0, 10), cardId: "mine" },
    { ...card("g", 0, 10), cardId: "graphish" },
    { ...card("s", 0, 10), cardId: "synced" },
    card("b", 0, 10),
  ];
  const p = project(clips);
  // 分派表只判 u、g、b 重:同步卡 s 表里没判重(本机测不了它)
  plan = heavyEverywhere("u", "g", "b");
  for (const id of ["u", "g", "s", "b"]) src.push(layer(id, [[0, 299]]));
  try {
    // 桌面:按分派表,同步表不起作用
    host.setOnlineBrowserMode(false);
    assert.deepEqual(planFeed({ project: p, t: 1, playing: true }).heavy, ["b", "g", "u"]);
    // 在线:四张都按重卡
    host.setOnlineBrowserMode(true);
    resetSnapshotFeed(); src = fakeSource(); setSnapshotSource(src); syncSnapshotSubscription(() => {});
    for (const id of ["u", "g", "s", "b"]) src.push(layer(id, [[0, 100]]));
    const got = planFeed({ project: p, t: 5, playing: true });
    assert.deepEqual(got.heavy, ["b", "g", "s", "u"]);
    assert.deepEqual([...got.picks.keys()].sort(), ["b", "g", "s", "u"], "照常选帧(回溯到 100)");
    assert.deepEqual(got.wanted.map((w) => w.clipId).sort(), ["b", "g", "s", "u"], "照常报缺口");
    assert.deepEqual(suppressedAt({ project: p, t: 5, playing: true }), ["b", "g", "s", "u"], "播放中一律抑制");
    const stage = fakeStage();
    await deliverSnapshots(stage, "front", { project: p, t: 1, playing: true });
    await settle();
    for (const id of ["u", "g", "s", "b"]) assert.ok(src.fetched.some((f) => f.includes(`k-${id}`)), `${id} 照常取字节:${src.fetched.join(",")}`);
    // 暂停态:舞台报了 settled(停下追到精确)的内置卡不再投;本机跑不了的卡停下不追,照常选帧
    noteSettled("front", ["b", "u", "s"]);
    const paused = planFeed({ project: p, t: 1, playing: false });
    assert.deepEqual([...paused.picks.keys()].sort(), ["g", "s", "u"]);
  } finally {
    host.setOnlineBrowserMode(false);
    registry.setSyncedUserCards([]);
    registry.setUserCardSources({}, {});
  }
});
