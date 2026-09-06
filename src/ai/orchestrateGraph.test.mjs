/**
 * 编排纯逻辑的单测。跑：node --test src/ai/orchestrateGraph.test.mjs
 *
 * 这三个函数吃的是**模型生成的 JSON**，所以畸形输入是常态不是异常：
 * 环、指向不存在的任务、自依赖、瞎编的角色名、裹在 ``` 里的 JSON。
 * 任何一种都不能让整批任务丢掉或者卡死。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { topoWaves, extractJson, normalizeTasks } from "./orchestrateGraph.ts";

const T = (id, dependsOn = []) => ({ id, roleId: "r", instruction: "x", dependsOn });
const ids = (waves) => waves.map((w) => w.map((t) => t.id));
const ROLES = [{ id: "director" }, { id: "fx-assistant" }];

test("互不依赖的任务排进同一层，可以并发", () => {
  assert.deepEqual(ids(topoWaves([T("1"), T("2"), T("3")])), [["1", "2", "3"]]);
});

test("链式依赖逐层展开", () => {
  assert.deepEqual(ids(topoWaves([T("1"), T("2", ["1"]), T("3", ["2"])])), [["1"], ["2"], ["3"]]);
});

test("菱形依赖：中间两个并行", () => {
  const waves = topoWaves([T("1"), T("2", ["1"]), T("3", ["1"]), T("4", ["2", "3"])]);
  assert.deepEqual(ids(waves), [["1"], ["2", "3"], ["4"]]);
});

test("指向不存在的任务的依赖被忽略，不能因此卡住", () => {
  assert.deepEqual(ids(topoWaves([T("1", ["999"]), T("2")])), [["1", "2"]]);
});

test("自依赖被忽略", () => {
  assert.deepEqual(ids(topoWaves([T("1", ["1"])])), [["1"]]);
});

test("成环时不死循环，剩下的串成最后一层", () => {
  const waves = topoWaves([T("1", ["2"]), T("2", ["1"]), T("3")]);
  // 3 能先跑；1 和 2 互相成环，兜底塞进后面一层
  assert.deepEqual(waves[0].map((t) => t.id), ["3"]);
  assert.equal(waves.flat().length, 3, "一个任务都不能丢");
});

test("全环也不能丢任务", () => {
  const waves = topoWaves([T("a", ["b"]), T("b", ["a"])]);
  assert.equal(waves.flat().length, 2);
});

test("空输入返回空", () => {
  assert.deepEqual(topoWaves([]), []);
});

test("extractJson 能剥掉 ``` 围栏", () => {
  const o = extractJson('说明文字\n```json\n{"tasks":[]}\n```\n后面还有话');
  assert.deepEqual(o, { tasks: [] });
});

test("extractJson 能处理裸 JSON 前后带解释", () => {
  assert.deepEqual(extractJson('好的：{"a":1} 就这样'), { a: 1 });
});

test("normalizeTasks 接受 {tasks:[...]} 和裸数组两种形状", () => {
  const a = normalizeTasks({ tasks: [{ id: "1", roleId: "director", instruction: "做" }] }, ROLES);
  const b = normalizeTasks([{ id: "1", roleId: "director", instruction: "做" }], ROLES);
  assert.equal(a.length, 1);
  assert.deepEqual(a, b);
});

test("瞎编的角色名落到第一个角色，而不是整批失败", () => {
  const out = normalizeTasks([{ id: "1", roleId: "不存在的角色", instruction: "做" }], ROLES);
  assert.equal(out[0].roleId, "director");
});

test("没有 instruction 的条目被丢掉", () => {
  const out = normalizeTasks(
    [{ id: "1", roleId: "director", instruction: "" }, { id: "2", roleId: "director", instruction: "做" }],
    ROLES,
  );
  assert.deepEqual(out.map((t) => t.id), ["2"]);
});

test("一个可执行任务都没有时报错，而不是静默返回空", () => {
  assert.throws(() => normalizeTasks({ tasks: [] }, ROLES), /没有可执行的任务/);
});

test("兼容 role / deps / prompt 这几种别名", () => {
  const out = normalizeTasks(
    [{ id: "1", role: "fx-assistant", prompt: "配字幕", deps: ["0"] }],
    ROLES,
  );
  assert.equal(out[0].roleId, "fx-assistant");
  assert.equal(out[0].instruction, "配字幕");
  assert.deepEqual(out[0].dependsOn, ["0"]);
});

// ── runOrchestration：并发调度与失败传播 ──────────────────────────────

import { runOrchestration } from "./orchestrateGraph.ts";

const DEPS = { promptFor: (t) => t.instruction, providerFor: () => null };
const plan = (tasks) => ({ plan: "p", dag: "d", tasks, waves: topoWaves(tasks) });

test("同一层的任务真的是并发跑的，不是一个接一个", async () => {
  let running = 0, peak = 0;
  const exec = async () => {
    running++; peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 30));
    running--;
  };
  await runOrchestration(plan([T("1"), T("2"), T("3")]), "q", exec, () => {}, undefined, DEPS);
  assert.equal(peak, 3, "三个无依赖任务应当同时在跑");
});

test("有依赖的不会提前跑", async () => {
  const order = [];
  const exec = async (t) => { order.push(t.id); await new Promise((r) => setTimeout(r, 5)); };
  await runOrchestration(plan([T("1"), T("2", ["1"])]), "q", exec, () => {}, undefined, DEPS);
  assert.deepEqual(order, ["1", "2"]);
});

test("一个任务失败，同层的其他任务照常跑完", async () => {
  const done = [];
  const exec = async (t) => { if (t.id === "1") throw new Error("炸了"); done.push(t.id); };
  const st = await runOrchestration(plan([T("1"), T("2"), T("3")]), "q", exec, () => {}, undefined, DEPS);
  assert.deepEqual(done.sort(), ["2", "3"]);
  assert.equal(st.tasks.find((r) => r.task.id === "1").status, "error");
  assert.equal(st.tasks.find((r) => r.task.id === "2").status, "done");
});

test("依赖失败任务的后续被跳过，而不是拿着空气往下做", async () => {
  const ran = [];
  const exec = async (t) => { if (t.id === "1") throw new Error("炸了"); ran.push(t.id); };
  const st = await runOrchestration(plan([T("1"), T("2", ["1"])]), "q", exec, () => {}, undefined, DEPS);
  assert.deepEqual(ran, [], "下游不该执行");
  const t2 = st.tasks.find((r) => r.task.id === "2");
  assert.equal(t2.status, "error");
  assert.match(t2.error, /没成功，跳过/);
});

test("整体状态：全成功是 done，有失败是 error", async () => {
  const ok = await runOrchestration(plan([T("1")]), "q", async () => {}, () => {}, undefined, DEPS);
  assert.equal(ok.phase, "done");
  const bad = await runOrchestration(plan([T("1")]), "q", async () => { throw new Error("x"); }, () => {}, undefined, DEPS);
  assert.equal(bad.phase, "error");
});

test("已中止的信号：不执行任何任务，全标记为已取消", async () => {
  const ac = new AbortController(); ac.abort();
  let called = 0;
  const st = await runOrchestration(plan([T("1")]), "q", async () => { called++; }, () => {}, ac.signal, DEPS);
  assert.equal(called, 0);
  assert.equal(st.phase, "cancelled");
});

test("onUpdate 会推送中间状态，界面才能实时更新", async () => {
  const seen = [];
  await runOrchestration(plan([T("1")]), "q", async () => {}, (s) => {
    seen.push(s.tasks[0].status);
  }, undefined, DEPS);
  assert.ok(seen.includes("running"), "应当推送过 running");
  assert.equal(seen.at(-1), "done");
});

test("exec 返回的 messageId 会被记下来，界面据此对上气泡", async () => {
  const st = await runOrchestration(plan([T("1")]), "q", async () => "msg-42", () => {}, undefined, DEPS);
  assert.equal(st.tasks[0].messageId, "msg-42");
});
