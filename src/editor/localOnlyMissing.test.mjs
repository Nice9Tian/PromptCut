/**
 * 父页一侧「已确认这一帧没有可贴结果」的判定(`localOnlyMissing.ts`;刚打开页面不闪图标)。跑:
 *   node --test src/editor/localOnlyMissing.test.mjs
 *
 *   LM-01 只看在场(含 LEAD)、本机跑不了的片段;本地帧按 round((t − start) × fps);按 id 排好
 *   LM-02 没有在线来源、没有本机跑不了的片段:什么都确认不了(舞台一律显示沙漏)
 */
import "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const { localOnlyMissingAt } = await import("./localOnlyMissing.ts");

test("LM-01 在场、本机跑不了、在线来源确认没有", () => {
  const clips = [
    { id: "s3", start: 0, end: 4 }, { id: "s2", start: 0, end: 4 }, { id: "u", start: 0, end: 4 },
    { id: "b", start: 0, end: 4 }, { id: "later", start: 10, end: 12 }, { id: "lead", start: 1.03, end: 3 },
  ];
  const asked = [];
  const confirm = (id, f) => { asked.push([id, f]); return id !== "u"; };
  const ids = localOnlyMissingAt({ clips, t: 1.0, fps: 30, localOnly: new Set(["s2", "s3", "u", "later", "lead"]), confirm });
  assert.deepEqual(ids, ["lead", "s2", "s3"], "内置卡 b 不看;还没到的 later 不看;LEAD 里的 lead 算在场");
  assert.deepEqual(asked.find(([id]) => id === "s2"), ["s2", 30]);
  assert.deepEqual(asked.find(([id]) => id === "lead"), ["lead", -1], "LEAD 里本地帧是负的,由在线来源夹到第 0 帧");
  assert.ok(!asked.some(([id]) => id === "b" || id === "later"));
});

test("LM-02 没有在线来源 / 没有本机跑不了的片段", () => {
  const clips = [{ id: "s", start: 0, end: 4 }];
  assert.deepEqual(localOnlyMissingAt({ clips, t: 1, fps: 30, localOnly: new Set(["s"]), confirm: null }), []);
  assert.deepEqual(localOnlyMissingAt({ clips, t: 1, fps: 30, localOnly: new Set(), confirm: () => true }), []);
});
