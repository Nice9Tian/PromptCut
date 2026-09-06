/**
 * 拿 agy(Gemini) 真实产出的第三步 JSON 过一遍解析和调度。
 *
 * 单测里的畸形输入是我自己编的，编的和模型真写出来的不是一回事。
 * 这个文件锁住一次真实往返的产物：提示词改坏了、解析退化了，这里会先炸。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { extractJson, normalizeTasks, topoWaves, runOrchestration } from "./orchestrateGraph.ts";

const ROLES = [{ id: "director" }, { id: "fx-assistant" }];

// agy 2026-09-07 实际返回的原文，一字未改
const REAL = `{
  "tasks": [
    { "id": "1", "roleId": "fx-assistant", "instruction": "给第 1 段采访视频加字幕，并根据内容配好动效卡，清除冗余内容。", "dependsOn": [] },
    { "id": "2", "roleId": "fx-assistant", "instruction": "给第 2 段采访视频加字幕，并根据内容配好动效卡，清除冗余内容。", "dependsOn": [] },
    { "id": "3", "roleId": "fx-assistant", "instruction": "给第 3 段采访视频加字幕，并根据内容配好动效卡，清除冗余内容。", "dependsOn": [] },
    { "id": "4", "roleId": "director", "instruction": "拿到前面处理好的三段视频后，将它们按顺序统一排列到时间轴上形成完整的片子，并加上片头。", "dependsOn": ["1","2","3"] }
  ]
}`;

test("真实输出能解析成 4 个任务", () => {
  const tasks = normalizeTasks(extractJson(REAL), ROLES);
  assert.equal(tasks.length, 4);
  assert.deepEqual(tasks.map((t) => t.roleId),
    ["fx-assistant", "fx-assistant", "fx-assistant", "director"]);
});

test("三段视频排进同一批并行，收口任务单独一批", () => {
  const waves = topoWaves(normalizeTasks(extractJson(REAL), ROLES));
  assert.deepEqual(waves.map((w) => w.map((t) => t.id)), [["1", "2", "3"], ["4"]]);
});

test("真实计划跑起来：前三个并发，第四个等它们", async () => {
  const tasks = normalizeTasks(extractJson(REAL), ROLES);
  const plan = { plan: "", dag: "", tasks, waves: topoWaves(tasks) };
  let running = 0, peak = 0;
  const order = [];
  const st = await runOrchestration(plan, "q", async (t) => {
    running++; peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 20));
    order.push(t.id); running--;
  }, () => {}, undefined, { promptFor: (t) => t.instruction, providerFor: () => null });

  assert.equal(peak, 3, "三段视频应当同时在跑");
  assert.equal(order.at(-1), "4", "收口任务必须最后跑");
  assert.equal(st.phase, "done");
});
