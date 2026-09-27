/**
 * C10 其余第 3 节(低内存档的完整规则)接进分派、补渲与导出:用例 CP-01～CP-06。
 *
 *   CP-01 planPipelines 的 lowMemoryLight:集合里的卡每个位置都判轻(不受预算挤出),其余(含没有身份的)每个位置都判重
 *   CP-02 planDispatch:低内存档的判定表按界限搜索的结果;搜索完成前全部判重、lowMemoryJudged 为 false;显示用的表一直全部判重
 *   CP-03 补渲只对判重又缺产物的层:判轻的卡不发
 *   CP-04 导出:低内存档只核对、只取判重卡的预渲染原尺寸,判轻的卡(层表里有也)本机渲
 *   CP-05 普通档不受影响:没开低内存档时判定表就是显示表,planPipelines 不给新选项时结果与原来逐字段相同
 *   CP-06 lowMemoryLight 与 allHeavy 同时给:allHeavy 优先(显示用)
 *
 * 跑:node --experimental-test-module-mocks --test src/render/c10-cost-plan.test.mjs
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { planPipelines, pipelineAt } from "./pipelinePlan.mjs";

globalThis.window = globalThis;

const FPS = 30;
function project(clips) {
  return { version: 1, name: "p", width: 1920, height: 1080, fps: FPS, duration: 60, themeId: "midnight",
    tracks: [{ id: "tr", name: "tr", clips: clips.map((c) => ({ id: c.id, cardId: `card-${c.id}`, start: c.start, end: c.end, params: {} })) }] };
}

test("CP-01 lowMemoryLight:判轻的卡在每个位置都判轻(同时 40 张也不挤出),其余与没有身份的每个位置都判重", () => {
  const clips = Array.from({ length: 40 }, (_, i) => ({ id: `c${String(i).padStart(2, "0")}`, start: 0, end: 5 }));
  clips.push({ id: "noid", start: 1, end: 3 });
  const identityKeys = Object.fromEntries(clips.filter((c) => c.id !== "noid").map((c) => [c.id, `key-${c.id}`]));
  const lightKeys = new Set(clips.filter((_, i) => i % 2 === 0 && i < 40).map((c) => `key-${c.id}`));
  const plan = planPipelines(project(clips), [], FPS, { identityKeys, lowMemoryLight: lightKeys });
  for (const c of clips) {
    const isLight = lightKeys.has(identityKeys[c.id]);
    for (let t = c.start; t < c.end; t += 0.5) assert.equal(pipelineAt(plan, c.id, t), isLight ? "light" : "heavy", `${c.id} @ ${t}`);
    assert.equal(plan.prerenderSet.has(c.id), !isLight, c.id);
  }
  assert.ok(plan.prerenderSet.has("noid"), "没有身份的卡判重");
});

test("CP-02 planDispatch:判定表按搜索结果;搜索完成前全部判重、lowMemoryJudged=false;显示表一直全部判重", async () => {
  mock.module(srcUrl("editor/stageBridge.ts"), { exports: { frontStage: () => null, backStage: () => null } });
  mock.module(srcUrl("editor/costIdentity.ts"), { exports: { clipIdentityOf: () => ({ identityKeys: { a: "ka", b: "kb", c: "kc" }, frameModes: { a: "direct", b: "direct", c: "direct" } }) } });
  const d = await import(srcUrl("editor/planDispatch.ts"));
  d.resetPlanDispatch();
  const settle = () => new Promise((r) => queueMicrotask(r));
  d.setPlanProject(project([{ id: "a", start: 0, end: 2 }, { id: "b", start: 0, end: 2 }, { id: "c", start: 1, end: 3 }]));
  await settle();
  assert.equal(d.lowMemoryJudged(), true, "普通档恒为 true");
  assert.equal(d.judgedPlan(), d.currentPlan(), "普通档两张表是同一张");
  d.setPlanLowMemory(true);
  await settle();
  assert.equal(d.planLowMemory(), true);
  assert.equal(d.lowMemoryJudged(), false, "搜索还没做完");
  assert.deepEqual([...d.judgedPlan().prerenderSet], ["a", "b", "c"], "没有结果时判定表全部判重");
  d.setPlanLowMemoryLight(["ka", "kc"]);
  assert.equal(d.lowMemoryJudged(), true);
  assert.deepEqual([...d.judgedPlan().prerenderSet], ["b"], "判定表按搜索结果(同步重算)");
  assert.equal(pipelineAt(d.judgedPlan(), "a", 1), "light");
  await settle();
  assert.deepEqual([...d.currentPlan().prerenderSet], ["a", "b", "c"], "显示用的表仍全部判重");
  assert.deepEqual([...d.planLowMemoryLight()].sort(), ["ka", "kc"]);
  d.setPlanLowMemory(false);
  await settle();
  assert.equal(d.planLowMemoryLight(), null, "关掉低内存档丢掉结果");
  assert.equal(d.judgedPlan(), d.currentPlan());
  d.resetPlanDispatch();
});

const B = await import(srcUrl("editor/lowMemoryBackfill.ts"));

test("CP-03 补渲只对判重又缺产物的层:判轻的卡不发;判重已有产物的不发", () => {
  const clip = (id, extra = {}) => ({ id, cardId: `card-${id}`, start: 0, end: 4, params: {}, ...extra });
  const p = { tracks: [{ id: "t", clips: [clip("h1"), clip("h2"), clip("l1"), clip("l2"), clip("u", { cardId: "user-card" })] }] };
  const missing = B.missingLayers({
    project: p, layerClipIds: new Set(["h2", "l2"]), unsupported: (c) => c.cardId === "user-card",
    heavy: new Set(["h1", "h2", "u"]),
  });
  assert.deepEqual(missing, ["h1"]);
  // 没给 heavy(旧口径):全部按重
  assert.deepEqual(B.missingLayers({ project: p, layerClipIds: new Set(), unsupported: () => false }), ["h1", "h2", "l1", "l2", "u"]);
});

const O = await import(srcUrl("export/originals.ts"));

test("CP-04 导出:低内存档只核对、只取判重卡的预渲染原尺寸;判轻的卡层表里有也本机渲", async () => {
  const H = "a".repeat(64);
  const map = { kind: "layer-map", projectId: "proj", fps: 30, v: 2, span: 4, layers: [
    { clipId: "heavyCard", kind: "html", key: "k-h", resultKey: "rk-h", firstFrame: 0, count: 4, contentKey: "ck-h", envFingerprint: "0123456789abcdef" },
    { clipId: "lightCard", kind: "html", key: "k-l", resultKey: "rk-l", firstFrame: 0, count: 4, contentKey: "ck-l", envFingerprint: "0123456789abcdef" },
  ] };
  const request = async (msg) => {
    if (msg.key === "layers:proj") return { type: "content.item", body: map };
    if (msg.key === "rk-h:0-3") return { type: "content.item", body: { frames: [[0, H], [1, H], [2, H], [3, H]] } };
    return { type: "content.item", missing: true }; // 判轻的卡原尺寸缺
  };
  const deps = { request, assetBase: () => "http://x/api/asset", authHeaders: async () => ({}) };
  const normal = await O.loadOriginalsIndex("proj", deps);
  assert.deepEqual(normal.missing, ["lightCard"], "普通档:层表里的都算重卡,缺了要等");
  const low = await O.loadOriginalsIndex("proj", deps, { onlyClips: ["heavyCard"] });
  assert.deepEqual(low.missing, [], "低内存档:判轻的卡不核对");
  assert.equal(low.hashAt("heavyCard", 2), H);
  assert.equal(low.hashAt("lightCard", 2), undefined, "判轻的卡不取原尺寸(本机渲)");
  const noMap = await O.loadOriginalsIndex(null, deps, { fallbackHeavy: ["heavyCard", "lightCard"], onlyClips: ["heavyCard"] });
  assert.deepEqual(noMap.missing, ["heavyCard"]);
});

test("CP-05 普通档不受影响:不给新选项时 planPipelines 的结果与原来逐字段相同(同一份输入跑两遍、对照 allHeavy 以外的路径)", () => {
  const clips = [{ id: "a", start: 0, end: 4 }, { id: "b", start: 1, end: 3 }, { id: "c", start: 2, end: 6 }];
  const costs = [
    { identityKey: "ka", fps: FPS, device: "d", stepMs: 3, kind: "random", catchUpMs: 0 },
    { identityKey: "kb", fps: FPS, device: "d", stepMs: 30, kind: "random", catchUpMs: 0 },
  ];
  const opts = { identityKeys: { a: "ka", b: "kb", c: "kc" }, frameModes: { a: "direct", b: "direct", c: "stateful" } };
  const x = planPipelines(project(clips), costs, FPS, opts);
  const y = planPipelines(project(clips), costs, FPS, { ...opts, lowMemoryLight: null });
  const wire = (p) => JSON.stringify({ s: p.segments.map((g) => [g.fromSec, g.toSec, [...g.heavy], [...g.light]]), set: [...p.prerenderSet] });
  assert.equal(wire(x), wire(y));
  assert.deepEqual([...x.prerenderSet], ["b", "c"], "b 实测超预算、c 没记录且声明 stateful");
});

test("CP-06 lowMemoryLight 与 allHeavy 同时给:allHeavy 优先", () => {
  const plan = planPipelines(project([{ id: "a", start: 0, end: 1 }]), [], FPS, { identityKeys: { a: "ka" }, lowMemoryLight: ["ka"], allHeavy: true });
  assert.deepEqual([...plan.prerenderSet], ["a"]);
});
