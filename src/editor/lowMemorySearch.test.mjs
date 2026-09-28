/**
 * 低内存档界限搜索的页面驱动(`lowMemorySearch.ts`):用例 LS-01～LS-05。舞台与文档服务连接都是假的。
 *
 *   LS-01 取记录 → 在唯一那个舞台里测(临时切 back、只走计时趟、一次一个缩水项目)→ 切回 front、整份重灌、restore 一次
 *   LS-02 测量期间 lowMemoryMeasuring() 为真(父页据此不投快照、不拨时间),测完为假;遮罩状态带进度
 *   LS-03 本地复用:第二次打开全命中,一次都不测、不切角色、不 restore
 *   LS-04 用户卡、图卡不参加、按重卡;没有记录的卡按重卡不测;direct 卡按随机帧逐帧 setTime(probe)
 *   LS-05 取不到记录抛错(调用方稍后再试),舞台一下都不碰;项目重灌打断的那一张重来
 *
 * 跑:node --test src/editor/lowMemorySearch.test.mjs
 */
import { srcUrl } from "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryCostStore, maxMeasurements } from "../render/boundarySearch.mjs";

const L = await import(srcUrl("editor/lowMemorySearch.ts"));

const FPS = 30;
const B = 1000 / FPS * 0.7;
const ENV = { platform: "iPhone", userAgent: "Mozilla/5.0 (iPhone) CriOS/152.0.0.0", renderer: "Apple GPU", vendor: "Apple Inc." };

/** n 张卡 c00…,每张一个片段;identityKey = k<i> */
function fixture(n, { extra = [] } = {}) {
  const clips = Array.from({ length: n }, (_, i) => ({ id: `c${String(i).padStart(2, "0")}`, cardId: `card${i}`, start: i * 0.1, end: i * 0.1 + 2, params: {} }));
  for (const c of extra) clips.push(c);
  const project = { version: 1, name: "p", width: 640, height: 360, fps: FPS, duration: 20, themeId: "midnight", tracks: [{ id: "t", name: "t", clips }] };
  const identityKeys = Object.fromEntries(clips.map((c) => [c.id, `k${c.id.slice(1)}`]));
  const capabilities = new Map(clips.map((c) => [c.id, { frameMode: c.frameMode ?? "stateful" }]));
  return { project, identityKeys, capabilities };
}

/** 假舞台:按当前缩水项目里那张卡的「本机耗时」回计时趟 */
function fakeStage(localMs, log) {
  let current = null;
  let role = "front";
  return {
    role: () => role,
    setProject: (p) => { current = p; },
    async setRole(r) { role = r; log.push(`role:${r}`); return { ok: true }; },
    async setTime(t, opts = {}) {
      if (opts.probe) {
        if (role !== "back") return { aborted: true, reason: "role" };
        const clip = current.tracks[0].clips[0];
        log.push(`probe:${clip.id}@${t.toFixed(3)}`);
        return { path: "set", stepMs: localMs(clip.id) };
      }
      return { path: "set" };
    },
    async render(t, opts = {}) {
      if (role !== "back") return { aborted: true, reason: "role" };
      assert.equal(opts.probe, "time", "只走计时趟,不生成快照");
      const clip = current.tracks[0].clips[0];
      assert.equal(current.tracks.length, 1, "一次只测一个片段");
      assert.equal(clip.start, 0, "缩水项目从 0 开始");
      log.push(`time:${clip.id}`);
      assert.equal(L.lowMemoryMeasuring(), true, "测量期间 lowMemoryMeasuring 为真");
      const ms = localMs(clip.id);
      return { remounted: true, caughtUpAtSec: t, elapsedMs: ms * 20, stepMs: ms, steps: Array.from({ length: 20 }, () => ms) };
    },
    async rectsWithBounds() { return []; },
  };
}

function deps({ n = 12, local, records, store = createMemoryCostStore(), extra = [], unsupported = () => false, request }) {
  const f = fixture(n, { extra });
  const log = [];
  const stage = fakeStage(local, log);
  const pushed = [];
  let restores = 0;
  const d = {
    request: request ?? (async (msg) => {
      assert.equal(msg.type, "cost.list");
      assert.deepEqual(msg.environment, ENV, "环境只报原始值");
      return { type: "cost.listing", projectId: msg.projectId, records, truncated: false, envFingerprint: "f00dfacecafe0001" };
    }),
    projectId: "sp_testtesttesttesttesttestte",
    project: f.project,
    environment: ENV,
    identityKeys: f.identityKeys,
    capabilities: f.capabilities,
    unsupported,
    stage: () => stage,
    pushProject: async (p) => { pushed.push(p); stage.setProject(p); },
    restore: () => { restores++; },
    currentProject: () => f.project,
    store,
  };
  return { d, log, pushed, restores: () => restores, f };
}

const recordsFor = (n, rep = (i) => i + 1) => Array.from({ length: n }, (_, i) => ({ identityKey: `k${String(i).padStart(2, "0")}`, envFingerprint: "aaaaaaaaaaaaaaaa", stepMs: rep(i), samples: 16, measuredAt: 1, mode: "dev" }));

test("LS-01 取记录 → 在唯一那个舞台里测(临时切 back)→ 切回 front、整份重灌、restore 一次;判轻的按搜索结果", async () => {
  L.resetLowMemorySearch();
  // 本机耗时 = 3 × 共享记录:i ≤ 6 跑得动(21 ms),7 起跑不动
  const local = (clipId) => 3 * (Number(clipId.slice(1)) + 1);
  const { d, log, pushed, restores, f } = deps({ n: 12, local, records: recordsFor(12) });
  const out = await L.runLowMemorySearch(d);
  assert.equal(out.envFingerprint, "f00dfacecafe0001");
  assert.deepEqual([...out.light].sort(), ["k00", "k01", "k02", "k03", "k04", "k05", "k06"]);
  assert.equal(out.result.boundary, 7);
  assert.ok(out.result.measurements <= maxMeasurements(12), `测了 ${out.result.measurements} 次`);
  assert.equal(log[0], "role:back");
  assert.equal(log.at(-1), "role:front");
  assert.equal(log.filter((x) => x.startsWith("role:")).length, 2, "只切两次角色");
  assert.equal(log.filter((x) => x.startsWith("time:")).length, out.result.measurements);
  assert.equal(pushed.at(-1), f.project, "测完整份重灌");
  assert.equal(restores(), 1);
  assert.ok(B > 21 && B < 24);
});

test("LS-02 测量期间遮罩状态带进度,测完 measuring 回到 false", async () => {
  L.resetLowMemorySearch();
  const seen = [];
  const off = L.onLowMemorySearch((s) => seen.push({ ...s }));
  const { d } = deps({ n: 30, local: () => 5, records: recordsFor(30) });
  const out = await L.runLowMemorySearch(d);
  off();
  assert.equal(L.lowMemoryMeasuring(), false);
  assert.ok(seen.some((s) => s.measuring && s.estimate === maxMeasurements(30)));
  assert.equal(seen.at(-1).measuring, false);
  assert.equal(Math.max(...seen.map((s) => s.done)), out.result.measurements);
  assert.equal(out.light.size, 30, "全都跑得动");
});

test("LS-03 本地复用:第二次打开全命中,一次都不测、不切角色、不 restore", async () => {
  L.resetLowMemorySearch();
  const store = createMemoryCostStore();
  const local = (clipId) => (Number(clipId.slice(1)) < 5 ? 4 : 40);
  const first = deps({ n: 20, local, records: recordsFor(20), store });
  const a = await L.runLowMemorySearch(first.d);
  assert.ok(a.result.measurements > 0);
  const again = deps({ n: 20, local: () => { throw new Error("不该再测"); }, records: recordsFor(20), store });
  const b = await L.runLowMemorySearch(again.d);
  assert.equal(b.result.measurements, 0);
  assert.deepEqual(again.log, [], "舞台一下都没碰");
  assert.equal(again.restores(), 0);
  assert.deepEqual([...b.light].sort(), [...a.light].sort());
});

test("LS-04 用户卡、图卡不参加按重卡;没有记录的卡按重卡不测;direct 卡按随机帧逐帧 setTime(probe)", async () => {
  L.resetLowMemorySearch();
  const extra = [
    { id: "cuser", cardId: "user-card", start: 0, end: 2, params: {} },
    { id: "cnew", cardId: "brand-new", start: 0, end: 2, params: {} },
  ];
  const records = [...recordsFor(4), { identityKey: "kuser", envFingerprint: "aaaaaaaaaaaaaaaa", stepMs: 1, samples: 16, measuredAt: 1, mode: "dev" }];
  const { d, log } = deps({ n: 4, extra, local: () => 5, records, unsupported: (c) => c.cardId === "user-card" });
  d.capabilities.set("c01", { frameMode: "direct" });
  const out = await L.runLowMemorySearch(d);
  assert.deepEqual(out.forcedHeavy, ["kuser"]);
  assert.ok(!out.light.has("kuser"), "用户卡不判轻(即使有记录)");
  assert.ok(!out.light.has("knew"), "没有记录的卡判重");
  assert.deepEqual(out.result.unrecorded, ["knew"]);
  assert.ok(!log.some((x) => x.includes("cuser") || x.includes("cnew")), "两张都没测");
  assert.ok(out.result.measured.has("k01"), "余量测了 k01");
  assert.ok(log.filter((x) => x.startsWith("probe:c01@")).length >= 8, "direct 卡按随机帧逐帧 setTime(probe),至少 8 帧");
  assert.ok(!log.includes("time:c01"), "direct 卡不走计时趟");
});

test("LS-05 取不到记录抛错、舞台一下都不碰;被项目重灌打断的那一张重来", async () => {
  L.resetLowMemorySearch();
  const { d, log } = deps({ n: 3, local: () => 5, records: [], request: async () => ({ type: "error", reason: "forbidden" }) });
  await assert.rejects(L.runLowMemorySearch(d), /forbidden/);
  assert.deepEqual(log, []);
  // 打断:第一次计时趟回 'project',第二次照常
  const r = deps({ n: 2, local: () => 5, records: recordsFor(2) });
  const stage = r.d.stage();
  const orig = stage.render.bind(stage);
  let first = true;
  stage.render = async (t, o) => { if (first) { first = false; return { aborted: true, reason: "project", elapsedMs: 1 }; } return orig(t, o); };
  const out = await L.runLowMemorySearch(r.d);
  assert.equal(out.light.size, 2, "重来之后测出来了");
});
