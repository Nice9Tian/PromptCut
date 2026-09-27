/**
 * 在线页面发布清单计划(C10 契约第 7 节、第 18 节第 9 条):形状与队列侧逐字段相同、队列的入站校验收它;
 * 测量落定后才发、防抖、改了重发、同一版不重发;requires 不带 envFingerprint / preferNode,codeVersion 给了才写;
 * 没人认领、发不出去都不抛。
 * 跑:node --test src/online/planPublisher.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPlanPublisher, clipsPlanTask, clipsSig, CLIPS_KEY_MARK } from "./planPublisher.ts";
import { clipsPlanTaskOf, backfillSig, CLIPS_KEY_MARK as SERVER_MARK, parseInbound } from "../../server/render-queue/messages.mjs";

test("C10-PP-01 形状与队列侧 clipsPlanTaskOf 逐字段相同;入站校验收它", () => {
  const clips = ["c3", "c1", "c2", "c1"];
  for (const codeVersion of [undefined, "cv-123"]) {
    const page = clipsPlanTask({ projectId: "proj-1", projectRev: 7, clips, codeVersion });
    const server = clipsPlanTaskOf({ projectId: "proj-1", projectRev: 7, clips, codeVersion });
    assert.deepEqual(page, server);
    assert.equal(parseInbound({ type: "task.publish", tasks: [page] }).ok, true);
  }
  assert.equal(CLIPS_KEY_MARK, SERVER_MARK);
  assert.equal(clipsSig(["b", "a"]), backfillSig(["a", "b", "a"]));
  const t = clipsPlanTask({ projectId: "p", projectRev: 1, clips: ["x"] });
  assert.equal(t.priority, "normal");
  assert.deepEqual(t.requires, {}, "不带 envFingerprint、preferNode");
});

function fakeQueue({ fail = null } = {}) {
  const sent = [];
  const request = async (msg) => {
    sent.push(msg);
    if (fail) throw new Error(fail);
    if (msg.type === "publisher.hello") return { type: "publisher.welcome" };
    if (msg.type === "task.publish") return { type: "task.published", results: msg.tasks.map((t) => ({ id: t.id, created: true, state: "open" })) };
    return { type: "error" };
  };
  return { sent, request };
}

function timers() {
  const q = [];
  return {
    setTimer: (fn, ms) => { const h = { fn, ms }; q.push(h); return h; },
    clearTimer: (h) => { const i = q.indexOf(h); if (i >= 0) q.splice(i, 1); },
    async flush() { while (q.length) { const h = q.shift(); await h.fn(); await new Promise((r) => setTimeout(r, 0)); } },
    pending: () => q.length,
  };
}

test("C10-PP-02 测量落定之前不发;落定后防抖发一次;同一版不重发;改了(版本或清单)重发", async () => {
  const qd = fakeQueue();
  const t = timers();
  let clips = ["c2", "c1"];
  const pub = createPlanPublisher({ request: qd.request, publisherId: "page-x", clips: () => clips, codeVersion: "cv", setTimer: t.setTimer, clearTimer: t.clearTimer });
  pub.changed({ projectId: "p1", projectRev: 3 });
  assert.equal(t.pending(), 0, "测量没落定:不排");
  pub.measured({ projectId: "p1", projectRev: 3 });
  pub.changed({ projectId: "p1", projectRev: 3 });
  pub.changed({ projectId: "p1", projectRev: 4 });
  assert.equal(t.pending(), 1, "防抖:只排最后一次");
  await t.flush();
  const pubs = qd.sent.filter((m) => m.type === "task.publish");
  assert.equal(pubs.length, 1);
  assert.equal(qd.sent[0].type, "publisher.hello");
  const task = pubs[0].tasks[0];
  assert.equal(task.kind, "plan");
  assert.equal(task.source.projectRev, 4);
  assert.match(task.resultKey, new RegExp(`^p1@4${CLIPS_KEY_MARK}`));
  assert.deepEqual(task.input.clips, ["c1", "c2"]);
  assert.deepEqual(task.requires, { codeVersion: "cv" });
  assert.equal("envFingerprint" in task.requires || "preferNode" in task.requires, false);
  pub.changed({ projectId: "p1", projectRev: 4 });
  await t.flush();
  assert.equal(qd.sent.filter((m) => m.type === "task.publish").length, 1, "同一版不重发");
  clips = ["c1"];
  pub.changed({ projectId: "p1", projectRev: 4 });
  await t.flush();
  assert.equal(qd.sent.filter((m) => m.type === "task.publish").length, 2, "清单变了重发");
  assert.equal(qd.sent.filter((m) => m.type === "publisher.hello").length, 1, "只报到一次");
  pub.dispose();
});

test("C10-PP-03 发不出去、没人认领都不抛;清单空不发;reset 之后重新报到", async () => {
  const bad = fakeQueue({ fail: "连接断了" });
  const t = timers();
  const pub = createPlanPublisher({ request: bad.request, clips: () => ["a"], setTimer: t.setTimer, clearTimer: t.clearTimer });
  pub.measured({ projectId: "p", projectRev: 1 });
  await t.flush();
  const d = pub.debug();
  assert.equal(d.log.length, 1);
  assert.equal(d.log[0].ok, false);
  const empty = fakeQueue();
  const t2 = timers();
  const pub2 = createPlanPublisher({ request: empty.request, clips: () => [], setTimer: t2.setTimer, clearTimer: t2.clearTimer });
  pub2.measured({ projectId: "p", projectRev: 1 });
  await t2.flush();
  assert.equal(empty.sent.length, 0, "清单空不发");
  const q3 = fakeQueue();
  const t3 = timers();
  const pub3 = createPlanPublisher({ request: q3.request, clips: () => ["a"], setTimer: t3.setTimer, clearTimer: t3.clearTimer });
  pub3.measured({ projectId: "p", projectRev: 1 });
  await t3.flush();
  pub3.reset();
  await t3.flush();
  assert.equal(q3.sent.filter((m) => m.type === "publisher.hello").length, 2, "连接换了重新报到");
  assert.equal(q3.sent.filter((m) => m.type === "task.publish").length, 2, "并重发(队列只在内存里)");
});

test("C10-PP-04 endpoint 形状:按 reqId 等回包,队列推来的 task.done 转给宿主", async () => {
  const handlers = [];
  const out = [];
  const endpoint = {
    send(m) {
      out.push(m);
      queueMicrotask(() => {
        const reply = m.type === "publisher.hello" ? { type: "publisher.welcome", reqId: m.reqId }
          : { type: "task.published", reqId: m.reqId, results: m.tasks.map((t) => ({ id: t.id, created: true })) };
        for (const h of handlers) h(reply);
      });
      return true;
    },
    onMessage(h) { handlers.push(h); },
  };
  const events = [];
  const t = timers();
  const pub = createPlanPublisher({ endpoint, clips: () => ["z"], onTaskEvent: (m) => events.push(m.type), setTimer: t.setTimer, clearTimer: t.clearTimer });
  pub.measured({ projectId: "p", projectRev: 2 });
  await t.flush();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(out.map((m) => m.type), ["publisher.hello", "task.publish"]);
  assert.equal(pub.debug().log[0].ok, true);
  for (const h of handlers) h({ type: "task.done", id: "plan:x" });
  assert.deepEqual(events, ["task.done"]);
});
