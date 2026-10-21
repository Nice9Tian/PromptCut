/**
 * 云端 Agent 发布预渲染之前的轻重判定(`agentHeavyClips.ts`;语义 `product/agent.md`「发出任务后可以离开」:托管方只为被改动的重卡产流)。
 * 跑:node --experimental-test-module-mocks --test src/editor/agentHeavyClips.test.mjs
 *
 *   JH-01 有共享成本记录:单帧耗时在预算内的判轻(不发),超出预算的判重(发);同一张卡几条记录取中位数
 *   JH-02 没有记录:按页面测完之前的兜底 —— 声明 `direct` 的判轻,其余判重;服务端注册表里没有定义的卡判重(照原来发)
 *   JH-03 剪辑段里的卡(虚拟片段 `<段 id>~<片段 id>`)与顶层的卡同一条规则;同一张卡的记录对各实例都管用
 *   JH-04 不在项目里的候选(写入之后又删了)两边都不放;候选顺序保持
 *   JH-05 与页面的分派表同一份:结果就是 `planPipelines` 的预渲染集合与候选的交集(同一位置挤不下时判重)
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test, mock } from "node:test";
import assert from "node:assert/strict";

globalThis.window = globalThis;
globalThis.document = {};

mock.module(srcUrl("render/cardSourceFiles.mjs"), { exports: { builtinCardSourceFiles: {}, cardSourceFilesVersion: () => 0 } });
mock.module(srcUrl("render/cardSourceVersion.mjs"), { exports: { cardSourceVersion: (card) => `v-${card.id}` } });

const R = await import(srcUrl("kernel/registry.ts"));
const CI = await import(srcUrl("editor/costIdentity.ts"));
const P = await import(srcUrl("render/pipelinePlan.mjs"));
const J = await import(srcUrl("editor/agentHeavyClips.ts"));

const def = (id, frameMode) => ({ id, name: id, defaults: { text: "" }, controls: [], frameMode, Component: () => null });
R.registerCards([def("stateful-card", "stateful"), def("direct-card", "direct")]);

const FPS = 30;
const B = P.budgetOf(FPS); // 23.33 ms
const card = (id, cardId, start, end, params = {}) => ({ id, cardId, start, end, params: { text: id, ...params } });
const seg = (id, cutId, start, end) => ({ id, cardId: "", cutId, start, end });

function project(clips, cuts = []) {
  return { version: 1, id: "p", name: "p", width: 1280, height: 720, fps: FPS, duration: 60, themeId: "midnight", media: [], activeCutId: "A",
    tracks: [{ id: "t", name: "t", clips }], ...(cuts.length ? { cuts: [{ id: "A", name: "剪辑1" }, ...cuts] } : {}) };
}

/** 这个项目里某个片段的成本身份(与判定用的是同一份 `clipIdentityOf`) */
const keyOf = (p, clipId) => CI.clipIdentityOf(p).identityKeys[clipId];
const rec = (identityKey, stepMs, env = "0000000000000001") => ({ identityKey, envFingerprint: env, stepMs, samples: 30, measuredAt: 1, mode: "build" });

test("JH-01 有记录:预算内的判轻、超出的判重;多条取中位数", () => {
  CI.resetClipIdentityCache();
  const p = project([card("light", "stateful-card", 0, 4), card("heavy", "stateful-card", 5, 9, { size: 2 })]);
  const kl = keyOf(p, "light"), kh = keyOf(p, "heavy");
  assert.ok(kl && kh && kl !== kh, "两张卡各有身份");
  // 粒子卡在线上实测约 2 ms/帧(轻);另一张 40 ms/帧(超出 B = 23.3 ms)
  const r = J.judgeHeavyClips(p, [rec(kl, 2.3), rec(kh, 40)], ["light", "heavy"]);
  assert.deepEqual(r, { heavy: ["heavy"], light: ["light"] });
  // 同一张卡几台机器测的:取中位数(1、2、60 → 2,轻;30、30、1 → 30,重)
  const multi = J.judgeHeavyClips(p, [rec(kl, 1, "a000000000000001"), rec(kl, 2, "a000000000000002"), rec(kl, 60, "a000000000000003"),
    rec(kh, 30, "a000000000000001"), rec(kh, 30, "a000000000000002"), rec(kh, 1, "a000000000000003")], ["light", "heavy"]);
  assert.deepEqual(multi, { heavy: ["heavy"], light: ["light"] });
  assert.ok(B > 2.3 && B < 30);
});

test("JH-02 没有记录:direct 判轻,其余判重;注册表里没有的卡判重", () => {
  CI.resetClipIdentityCache();
  const p = project([card("s", "stateful-card", 0, 4), card("d", "direct-card", 0, 4), card("u", "not-registered-card", 0, 4)]);
  const r = J.judgeHeavyClips(p, [], ["s", "d", "u"]);
  assert.deepEqual(r, { heavy: ["s", "u"], light: ["d"] });
  // 记录到了(在线成员的页面测完写进来)就按记录:stateful 的那张实测很轻 → 不发
  const r2 = J.judgeHeavyClips(p, [rec(keyOf(p, "s"), 2)], ["s", "d", "u"]);
  assert.deepEqual(r2, { heavy: ["u"], light: ["s", "d"] });
});

test("JH-03 剪辑段里的卡与顶层同一条规则;同一张卡的记录对两个实例都管用", () => {
  CI.resetClipIdentityCache();
  const inner = [card("X", "stateful-card", 0, 4), card("Y", "stateful-card", 4, 8, { size: 3 })];
  const p = project([seg("S", "B", 0, 8), seg("S2", "B", 10, 18)], [{ id: "B", name: "剪辑2", duration: 8, tracks: [{ id: "b1", name: "b1", clips: inner }] }]);
  const kx = keyOf(p, "S~X"), ky = keyOf(p, "S~Y");
  assert.ok(kx && ky, "剪辑段里的卡按虚拟片段给身份");
  assert.equal(keyOf(p, "S2~X"), kx, "成本键剥掉 flat:同一张卡在两个实例同一个键");
  const candidates = ["S~X", "S~Y", "S2~X", "S2~Y"];
  assert.deepEqual(J.judgeHeavyClips(p, [rec(kx, 2), rec(ky, 50)], candidates), { heavy: ["S~Y", "S2~Y"], light: ["S~X", "S2~X"] });
  assert.deepEqual(J.judgeHeavyClips(p, [], candidates), { heavy: candidates, light: [] }, "没有记录的 stateful 卡判重");
});

test("JH-04 不在项目里的候选两边都不放;顺序保持", () => {
  CI.resetClipIdentityCache();
  const p = project([card("a", "stateful-card", 0, 4), card("b", "stateful-card", 0, 4, { k: 1 })]);
  assert.deepEqual(J.judgeHeavyClips(p, [], ["b", "gone", "a"]), { heavy: ["b", "a"], light: [] });
  assert.deepEqual(J.judgeHeavyClips(null, [], ["a"]), { heavy: [], light: [] });
  assert.deepEqual(J.judgeHeavyClips(p, null, []), { heavy: [], light: [] });
});

test("JH-05 与页面的分派同一份:同一位置几张轻卡挤不下预算时,挤出去的判重", () => {
  CI.resetClipIdentityCache();
  // 四张卡同一位置,各 8 ms:贪心装三张就超(8×3 = 24 > 23.3 再加重卡的换帧成本),挤出去的那张判重
  const clips = ["c1", "c2", "c3", "c4"].map((id, i) => card(id, "stateful-card", 0, 4, { i }));
  const p = project(clips);
  const records = clips.map((c) => rec(keyOf(p, c.id), 8));
  const r = J.judgeHeavyClips(p, records, clips.map((c) => c.id));
  const ids = CI.clipIdentityOf(p);
  const plan = P.planPipelines(p, records.map((x) => ({ identityKey: x.identityKey, stepMs: x.stepMs })), FPS, { identityKeys: ids.identityKeys, frameModes: ids.frameModes });
  assert.ok(r.heavy.length >= 1 && r.light.length >= 1, JSON.stringify(r));
  for (const id of r.heavy) assert.ok(plan.prerenderSet.has(id), `${id} 在页面那张表里也判重`);
});
