/**
 * 在线执行用户卡与图卡 · 轻重与界面(`docs/plan/online-card-exec-contract.md` 第 6、8 节)。跑:
 *   node --experimental-test-module-mocks --test src/editor/onlineCardsL.test.mjs
 *
 *   OCE-L-01 「本页运行不了」的判法(`placeholderHost.needsLocalPc`):图卡照旧算;用户卡只有运行不了的才算 ——
 *            构建时就在包里的不算,同步来的看运行状态(只有 `ready` 不算),低内存档一律算;桌面恒不算
 *   OCE-L-02 时间轴徽标「需要本地 PC 渲染辅助」:只对本页运行不了的卡、且确认没覆盖整段时出;能运行的同步卡不出
 *   OCE-L-03 测量门:卡片源码同步完之后,再等同步来的卡第一次载入有结果(没有 `loading` 的了)才开;成功失败都算;
 *            仍受同一个上限封顶;没有在载入的卡时与原来相同
 *   OCE-L-04 导出:同步来的用户卡与图卡不管判轻判重都必须用预渲染原尺寸(导出页不执行它们的代码);层表里没有它们的层、
 *            或没有层表,算缺;低内存档的「只核对判重的卡」不把它们放过去;别的卡的核对与原来相同
 *   OCE-L-05 参数面板的说明跟着运行状态走:能运行、还在载入不出说明,十种里其余八种各有一句(文字见 `cardRunStates.ts`)
 *   OCE-L-06 接线(按源码核):分派表、测量、时间轴片段都订阅了运行状态;六处判断都经 `placeholderHost` 的同一个函数
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

globalThis.window = globalThis;
mock.module(srcUrl("editor/stageBridge.ts"), { exports: { frontStage: () => null, backStage: () => null } });

const R = await import(srcUrl("kernel/registry.ts"));
const H = await import(srcUrl("render/placeholderHost.ts"));
const B = await import(srcUrl("editor/timeline/localPcBadge.ts"));
const G = await import(srcUrl("editor/measureGate.ts"));
const O = await import(srcUrl("export/originals.ts"));
const ERS = await import(srcUrl("editor/sync/cardRunStates.ts"));

const dom = (id, extra = {}) => ({ id, name: id, defaults: {}, controls: [], frameMode: "direct", Component: () => null, ...extra });
function setup() {
  R.resetCards();
  R.registerCards([dom("builtin"), dom("repo-user"), dom("av", { audio: () => new Float32Array(2) }),
    dom("gpu", { Component: undefined, card: () => ({}) }), dom("audio-only", { Component: undefined, audio: () => new Float32Array(2) })]);
  R.setUserCardSources({ "repo-user": "" }, { "repo-user": "repo-user" });
  R.setSyncedUserCards([{ id: "synced", name: "同步卡" }]);
  R.setCardRunStates([]);
  R.setRuntimeCards([]);
  H.setLocalOnlyLowMemory(false);
  H.setOnlineBrowserMode(true);
}
const cleanup = () => { H.setOnlineBrowserMode(false); H.setLocalOnlyLowMemory(false); R.setCardRunStates([]); R.setRuntimeCards([]); R.setSyncedUserCards([]); };
const local = (id) => H.unsupportedHere(id, R.getCard(id));

test("OCE-L-01 本页运行不了的判法:图卡照旧;用户卡看能不能运行;低内存档一律算;桌面恒不算", () => {
  setup();
  try {
    assert.equal(local("builtin"), false);
    assert.equal(local("av"), false, "内置有声动效卡的画面是普通 DOM 卡");
    assert.equal(local("gpu"), true, "图卡:在线执行还没放开,照旧算");
    assert.equal(local("audio-only"), true);
    assert.equal(local("repo-user"), false, "构建时就在包里的仓库用户卡:本页能运行");
    assert.equal(local("nobody"), false, "两边都没有的 id(未知卡片)不算");
    assert.equal(local("synced"), true, "同步来的、还没有运行状态:算");
    for (const state of R.CARD_RUN_STATES) {
      R.setCardRunStates([["synced", { state }]]);
      assert.equal(local("synced"), state !== "ready", `运行状态 ${state}`);
    }
    // 执行它的环境(舞台)里:载入成功就是运行时注册表里有定义
    R.setCardRunStates([]);
    R.setRuntimeCards([dom("synced")]);
    assert.equal(local("synced"), false, "舞台里载入成功的同步卡");
    R.setRuntimeCards([dom("synced", { Component: undefined, card: () => ({}) })]);
    assert.equal(local("synced"), true, "舞台里载入的同步图卡:图卡照旧算");
    R.setRuntimeCards([]);
    // 低内存档:不执行用户卡的代码
    R.setCardRunStates([["synced", { state: "ready" }]]);
    H.setLocalOnlyLowMemory(true);
    assert.equal(H.localOnlyLowMemory(), true);
    assert.equal(local("repo-user"), true, "低内存档:构建时的用户卡也算");
    assert.equal(local("synced"), true, "低内存档:哪怕运行状态写着 ready 也算");
    assert.equal(local("builtin"), false);
    assert.deepEqual([...H.localOnlyClipIds([{ id: "a", cardId: "builtin" }, { id: "b", cardId: "repo-user" }, { id: "c", cardId: "synced" }, { id: "d", cardId: "gpu" }])], ["b", "c", "d"]);
    H.setLocalOnlyLowMemory(false);
    assert.deepEqual([...H.localOnlyClipIds([{ id: "a", cardId: "builtin" }, { id: "b", cardId: "repo-user" }, { id: "c", cardId: "synced" }, { id: "d", cardId: "gpu" }])], ["d"]);
    // 桌面(模式关着)
    H.setOnlineBrowserMode(false);
    for (const id of ["repo-user", "synced", "gpu", "audio-only"]) assert.equal(local(id), false, `桌面:${id}`);
    assert.equal(H.localOnlyClipIds([{ id: "d", cardId: "gpu" }]).size, 0);
  } finally { cleanup(); }
});

test("OCE-L-02 时间轴徽标:只对本页运行不了的卡、确认没覆盖整段时出;能运行的同步卡不出", () => {
  setup();
  try {
    const badge = (id, coverage) => B.showLocalPcBadge({ online: H.onlineBrowserMode(), localOnly: local(id), coverage });
    assert.equal(badge("synced", "none"), true, "还没载入成功、没有结果:出");
    assert.equal(badge("synced", "unknown"), false, "还不知道:不出");
    R.setCardRunStates([["synced", { state: "loading" }]]);
    assert.equal(badge("synced", "full"), false);
    R.setCardRunStates([["synced", { state: "ready" }]]);
    for (const c of ["none", "partial", "full", "unknown", null]) assert.equal(badge("synced", c), false, `能运行:覆盖 ${c} 都不出`);
    R.setCardRunStates([["synced", { state: "missing-module", detail: "lodash" }]]);
    assert.equal(badge("synced", "partial"), true, "引用了页面里没有的模块:出");
    assert.equal(badge("repo-user", "none"), false, "构建时的用户卡:不出");
    assert.equal(badge("gpu", "none"), true, "图卡:照旧出");
    H.setLocalOnlyLowMemory(true);
    assert.equal(badge("repo-user", "none"), true, "低内存档:构建时的用户卡照旧出");
  } finally { cleanup(); }
});

function fakeClock() {
  let now = 0, seq = 0;
  const timers = new Map();
  return { now: () => now, setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: now + ms }); return id; }, clearTimer: (id) => { timers.delete(id); },
    advance(ms) { now += ms; for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); } } };
}

test("OCE-L-03 测量门:卡片源码同步完之后再等同步来的卡第一次载入有结果;仍受上限封顶", () => {
  globalThis.__pcOnlinePage = true;
  try {
    R.setSyncedUserCards([{ id: "x", name: "x" }, { id: "y", name: "y" }]);
    // 没有在载入的卡:与原来相同,同步完就开
    R.setCardRunStates([["x", { state: "not-isolated" }]]);
    let clock = fakeClock();
    G.resetMeasureGate(clock);
    assert.equal(G.measureGateOpen(), false);
    G.releaseMeasureGate(true);
    assert.equal(G.measureGateOpen(), true);
    assert.equal(G.measureGateDiag().reason, "synced");

    // 有卡还在载入:同步完了也先不开
    R.setCardRunStates([["x", { state: "loading" }], ["y", { state: "loading" }]]);
    clock = fakeClock();
    G.resetMeasureGate(clock);
    assert.equal(G.measureGateOpen(), false);
    G.releaseMeasureGate(true);
    assert.equal(G.measureGateOpen(), false, "源码同步完了,但卡还在载入:不开");
    R.setCardRunStates([["x", { state: "ready", version: "1" }], ["y", { state: "loading" }]]);
    assert.equal(G.measureGateOpen(), false, "还有一张在载入:不开");
    R.setCardRunStates([["x", { state: "ready", version: "1" }], ["y", { state: "load-error", detail: "炸了" }]]);
    assert.equal(G.measureGateOpen(), true, "都有结果了(成功、失败都算):开");
    assert.equal(G.measureGateDiag().reason, "synced");

    // 一直在载入:到上限照开
    R.setCardRunStates([["x", { state: "loading" }]]);
    clock = fakeClock();
    G.resetMeasureGate(clock);
    assert.equal(G.measureGateOpen(), false);
    G.releaseMeasureGate(true);
    clock.advance(G.MEASURE_GATE_MAX_MS - 1);
    assert.equal(G.measureGateOpen(), false);
    clock.advance(1);
    assert.equal(G.measureGateOpen(), true);
    assert.equal(G.measureGateDiag().reason, "timeout");
    // 开了之后运行状态再变不影响门
    R.setCardRunStates([["x", { state: "ready", version: "2" }]]);
    assert.equal(G.measureGateOpen(), true);

    // 源码同步回了失败、卡在载入:等到有结果,原因是 failed
    R.setCardRunStates([["x", { state: "loading" }]]);
    clock = fakeClock();
    G.resetMeasureGate(clock);
    G.measureGateOpen();
    G.releaseMeasureGate(false);
    assert.equal(G.measureGateOpen(), false);
    R.setCardRunStates([["x", { state: "unsupported-syntax", detail: "namespace" }]]);
    assert.equal(G.measureGateOpen(), true);
    assert.equal(G.measureGateDiag().reason, "failed");
  } finally {
    delete globalThis.__pcOnlinePage;
    G.resetMeasureGate();
    R.setCardRunStates([]);
    R.setSyncedUserCards([]);
  }
});

test("OCE-L-04 导出:同步来的卡必须用预渲染原尺寸,缺了算缺;别的卡的核对不变", async () => {
  const HASH = "a".repeat(64);
  const layer = (clipId, rk) => ({ clipId, kind: "html", key: `k-${clipId}`, resultKey: rk, firstFrame: 0, count: 4, contentKey: `ck-${clipId}`, envFingerprint: "0123456789abcdef" });
  const frames = { frames: [[0, HASH], [1, HASH], [2, HASH], [3, HASH]] };
  const depsOf = (layers, ready) => ({ assetBase: () => "http://x/api/asset", authHeaders: async () => ({}),
    request: async (msg) => {
      if (msg.key === "layers:proj") return layers ? { type: "content.item", body: { kind: "layer-map", projectId: "proj", fps: 30, v: 2, span: 4, layers } } : { type: "content.item", missing: true };
      const rk = String(msg.key).split(":")[0];
      return ready.includes(rk) ? { type: "content.item", body: frames } : { type: "content.item", missing: true };
    } });

  // 层表里有重卡的层;同步卡 s1 有层且齐,s2 没有层
  const deps = depsOf([layer("heavy", "rk-h"), layer("s1", "rk-s1")], ["rk-h", "rk-s1"]);
  const base = await O.loadOriginalsIndex("proj", deps);
  assert.deepEqual(base.missing, [], "不给 requiredClips:与原来相同");
  assert.equal(base.hashAt("s2", 1), undefined, "原来:层表里没有的卡照活渲");
  const idx = await O.loadOriginalsIndex("proj", deps, { requiredClips: ["s1", "s2"] });
  assert.deepEqual(idx.missing, ["s2"], "必须用原尺寸、层表里却没有层:算缺(导出前的核对拦下,等渲染节点)");
  assert.equal(idx.hashAt("s1", 1), HASH, "有层的照取");
  assert.equal(idx.hashAt("s2", 1), null, "缺的回 null(不是 undefined:不许活渲)");
  assert.equal(idx.hashAt("heavy", 1), HASH);
  assert.equal(idx.hashAt("light", 1), undefined, "别的卡照旧");

  // 低内存档「只核对判重的卡」不把同步卡放过去
  const low = await O.loadOriginalsIndex("proj", deps, { onlyClips: ["heavy"], requiredClips: ["s1", "s2"] });
  assert.deepEqual(low.missing, ["s2"]);
  assert.equal(low.hashAt("s1", 2), HASH, "页面判它轻也照取原尺寸");

  // 同步卡的层有、帧不齐:照旧算缺
  const partial = await O.loadOriginalsIndex("proj", depsOf([layer("s1", "rk-s1")], []), { requiredClips: ["s1"] });
  assert.deepEqual(partial.missing, ["s1"]);

  // 没有层表:页面判重的与必须用原尺寸的都算缺
  const noMap = await O.loadOriginalsIndex("proj", depsOf(null, []), { fallbackHeavy: ["heavy"], requiredClips: ["s1"] });
  assert.deepEqual(noMap.missing.sort(), ["heavy", "s1"]);
  assert.equal(noMap.hashAt("s1", 0), null);
  assert.equal(noMap.hashAt("light", 0), undefined);
});

test("OCE-L-05 参数面板的说明跟着运行状态走", () => {
  const silent = ["ready", "loading"];
  for (const state of R.CARD_RUN_STATES) {
    const text = ERS.runStateMessage({ state });
    if (silent.includes(state)) assert.equal(text, null, `${state} 不出说明`);
    else assert.ok(typeof text === "string" && text.length > 8, `${state} 有说明`);
  }
  assert.match(ERS.runStateMessage({ state: "missing-module", detail: "lodash" }), /引用了在线页面里没有的模块 lodash/);
  assert.match(ERS.runStateMessage({ state: "low-memory" }), /低内存档/);
  // 面板组件读注册表的运行状态并订阅它
  const form = fs.readFileSync(fileURLToPath(srcUrl("editor/left/ParamsForm.tsx")), "utf8");
  assert.match(form, /useSyncExternalStore\(onCardRunStatesChanged, cardRunStatesGen\)/);
  assert.match(form, /runStateMessage\(/);
  assert.match(form, /data-pc="params-run-state"/);
});

test("OCE-L-06 接线:运行状态变了,分派表、测量、时间轴片段、投递的记忆都跟着;六处判断同一个函数", () => {
  const read = (rel) => fs.readFileSync(fileURLToPath(srcUrl(rel)), "utf8");
  assert.match(read("editor/planDispatch.ts"), /onCardRunStatesChanged\(\(\) => schedule\(\)\)/, "分派表重算");
  assert.match(read("editor/ProbeGate.tsx"), /onCardRunStatesChanged\(\(\) => \{[\s\S]*?requeueProbeRun\(getState\(\)\.project\)/, "测量重排(刚载入成功的卡即时补测)");
  assert.match(read("editor/timeline/ClipView.tsx"), /useSyncExternalStore\(onCardRunStatesChanged, cardRunStatesGen\)/, "时间轴片段重绘");
  assert.match(read("editor/snapshotFeed.ts"), /cardRunStatesGen\(\)/, "投递那一侧的记忆带运行状态的代数");
  assert.match(read("editor/costIdentity.ts"), /cardRunStatesGen\(\)/, "成本身份的记忆带运行状态的代数");
  // 契约第 6 节的六处都经 `localOnlyClipIds` / `unsupportedHere` / `needsLocalPc`,不自己再判「是不是用户卡」
  for (const [rel, re] of [
    ["editor/costIdentity.ts", /localOnlyClipIds\(/], ["editor/snapshotFeed.ts", /localOnlyClipIds\(/], ["editor/stageSwap.ts", /localOnlyClipIds\(/],
    ["StageView.tsx", /localOnlyClipIds\(/], ["render/Stage.tsx", /unsupportedHere\(clip\.cardId, def\)/], ["editor/timeline/ClipView.tsx", /unsupportedHere\(/],
  ]) {
    const text = read(rel);
    assert.match(text, re, `${rel} 走同一个判法`);
    assert.doesNotMatch(text, /isUserCardId\(/, `${rel} 不自己判「是不是用户卡」`);
  }
});

test("OCE-L-07 导出期间请渲染节点补同步卡的原尺寸:记下、去重、通知、清掉;清单计划并上它们", async () => {
  const W = await import(srcUrl("export/exportWanted.ts"));
  let calls = 0;
  const off = W.subscribeExportWanted(() => { calls++; });
  try {
    assert.deepEqual([...W.exportWantedClips()], []);
    W.setExportWantedClips(["s2", "s1", "s2"]);
    assert.deepEqual([...W.exportWantedClips()], ["s1", "s2"]);
    assert.equal(calls, 1);
    W.setExportWantedClips(["s1", "s2"]);
    assert.equal(calls, 1, "没变不通知");
    W.setExportWantedClips([]);
    assert.deepEqual([...W.exportWantedClips()], []);
    assert.equal(calls, 2);
  } finally { off(); W.setExportWantedClips([]); }
  const read = (rel) => fs.readFileSync(fileURLToPath(srcUrl(rel)), "utf8");
  const exp = read("export/onlineExport.ts");
  assert.match(exp, /setExportWantedClips\(syncedCardClips\(p\)\)/, "导出开始时记下同步卡片段");
  assert.match(exp, /finally \{\s*setExportWantedClips\(\[\]\);/, "导出结束(成功、失败、取消)清掉");
  assert.match(exp, /requiredOriginals: \(\) => syncedCardClips\(p\)/, "它们必须用预渲染原尺寸");
  assert.match(read("editor/Preview.tsx"), /\[\.\.\.plan\.prerenderSet, \.\.\.exportWantedClips\(\)\]/, "页面发布的清单计划并上它们");
});
