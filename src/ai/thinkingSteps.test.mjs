// node --test src/ai/thinkingSteps.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

import { thinkingSteps, stepsOfThinking } from "./thinkingSteps.ts";

test("加粗的一句话就是一步 —— 用户诊断报告里的真实形状", () => {
  assert.deepEqual(
    thinkingSteps("**Clarifying article link and scope**\n\n"),
    ["Clarifying article link and scope"],
  );
});

test("一段里有几条加粗就是几步:模型经常一次吐两三条", () => {
  assert.deepEqual(
    thinkingSteps("**Planning non-destructive timeline design**\n\n**Requesting placeholder asset details**\n\n"),
    ["Planning non-destructive timeline design", "Requesting placeholder asset details"],
  );
});

test("真的思维链不当步骤:多行的一律不认 —— 截成一句残句比不显示更糟", () => {
  assert.deepEqual(thinkingSteps("先看看时间轴上有什么\n然后再决定怎么排"), []);
});

test("真的思维链不当步骤:一行但很长的也不认", () => {
  assert.deepEqual(thinkingSteps("x".repeat(80)), []);
});

test("没有加粗但又短又只有一行的,当步骤 —— 那种形状只可能是标题", () => {
  assert.deepEqual(thinkingSteps("Checking the timeline"), ["Checking the timeline"]);
});

test("加粗的标题太长时截断,不然会把气泡撑坏", () => {
  const [s] = thinkingSteps("**" + "x".repeat(80) + "**");
  assert.ok(s.length <= 48, `实际 ${s.length}`);
  assert.ok(s.endsWith("…"));
});

test("空白输入没有步骤", () => {
  assert.deepEqual(thinkingSteps(""), []);
  assert.deepEqual(thinkingSteps("   \n\n  "), []);
  assert.deepEqual(thinkingSteps(undefined), []);
});

test("换行和多余空格压平:步骤名要能放进一行", () => {
  assert.deepEqual(thinkingSteps("**Checking   the\nproject**"), ["Checking the project"]);
});

test("stepsOfThinking:按顺序拼,相邻重复的合并", () => {
  assert.deepEqual(
    stepsOfThinking(["**A**", "**A**", "**B**\n\n**C**"]),
    ["A", "B", "C"],
  );
});

test("stepsOfThinking:空段落跳过,不产生空步骤", () => {
  assert.deepEqual(stepsOfThinking(["", "**只有这一步**", "  "]), ["只有这一步"]);
});
