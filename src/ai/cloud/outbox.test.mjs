/**
 * 断网待发(outbox.ts,2026-10-22 用户定,`docs/semantics/workflow/production.md`「云端对话」):
 *   1. 断网时发消息不报错,消息排着,气泡照常显示,下面写「等网络恢复后发出」;
 *   2. 网络恢复后自动发出;
 *   3. 发出之前核一次:对话里最近一条用户消息(服务端为准)和排队时看到的是不是同一条,不一样就不发;
 *   4. 不发的那条标「发送失败」带「重新发送」;点了按当前状态重新走一遍。
 * 另有:同一个对话里排了多条的顺序;排着的消息跨页面刷新还在(〔裁〕三级,见 AGENT 报告)。
 * 跑:npm test -- src/ai/cloud/outbox.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { OUTBOX_TEXT, baselineFor, createOutbox, createOutboxRunner, isOfflineError, isTransientError, outboxBackoff, outboxKey,
  outboxLocalId, outboxVerdict } from "./outbox.ts";
import { CloudError, DOC_LINK_DOWN_TEXT } from "./cloudApi.ts";
import { createCloudSession } from "./session.ts";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check, ms = 3000) => { const end = Date.now() + ms; for (;;) { if (check()) return; if (Date.now() > end) throw new Error("等不到"); await sleep(5); } };

function memStorage() {
  const map = new Map();
  return { map, getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
}
function fakeStore() {
  let value = [];
  const listeners = new Set();
  return { get: () => value, set(next) { value = typeof next === "function" ? next(value) : next; for (const l of [...listeners]) l(); }, subscribe(l) { listeners.add(l); return () => listeners.delete(l); } };
}
const item = (over = {}) => ({ requestId: "r1", conversationId: "c1", text: "hi", options: {}, baseline: { messageId: "m1" }, state: "queued", createdAt: 1, ...over });

/* ---------------- 3. 核对:最近一条用户消息变没变(正反两面) ---------------- */

test("核对:最近一条用户消息没变 → 发;变了 → 不发", () => {
  const server = [{ messageId: "m0", requestId: "x0", arrivalSeq: 1 }, { messageId: "m1", requestId: "x1", arrivalSeq: 2 }];
  assert.equal(outboxVerdict(server, item({ baseline: { messageId: "m1" } })), "send", "最近一条还是排队时看到的那条:发");
  const changed = [...server, { messageId: "m2", requestId: "other-device", arrivalSeq: 3 }];
  assert.equal(outboxVerdict(changed, item({ baseline: { messageId: "m1" } })), "conflict", "离线期间别人(或自己的其它设备)发过:不发");
  // 排队时看到的是更旧的那条(服务端最近一条不是它)
  assert.equal(outboxVerdict(server, item({ baseline: { messageId: "m0" } })), "conflict");
});

test("核对:按 arrivalSeq 认最近一条,不看数组顺序", () => {
  const server = [{ messageId: "m2", arrivalSeq: 9 }, { messageId: "m1", arrivalSeq: 3 }];
  assert.equal(outboxVerdict(server, item({ baseline: { messageId: "m2" } })), "send");
  assert.equal(outboxVerdict(server, item({ baseline: { messageId: "m1" } })), "conflict");
});

test("核对:新对话(服务端还没有消息)、排队时也没看到消息 → 发;排队时没看到、服务端却有了 → 不发", () => {
  assert.equal(outboxVerdict([], item({ baseline: null })), "send");
  assert.equal(outboxVerdict([{ messageId: "m9", arrivalSeq: 1 }], item({ baseline: null })), "conflict");
  assert.equal(outboxVerdict([], item({ baseline: { messageId: "m1" } })), "conflict", "看到过的消息服务端没了(对话被清):不发");
});

test("核对:这一页更早排的那条(看到的是它的请求号)已经发出 → 发;它没发出(不发了) → 这条也不发", () => {
  const sentA = [{ messageId: "m1", arrivalSeq: 1 }, { messageId: "mA", requestId: "rA", arrivalSeq: 2 }];
  assert.equal(outboxVerdict(sentA, item({ requestId: "rB", baseline: { requestId: "rA" } })), "send");
  const aBlocked = [{ messageId: "m1", arrivalSeq: 1 }, { messageId: "mX", requestId: "other", arrivalSeq: 2 }];
  assert.equal(outboxVerdict(aBlocked, item({ requestId: "rB", baseline: { requestId: "rA" } })), "conflict");
});

test("核对:这条其实早到了(丢了回包)→ delivered,不当成「别人发过」", () => {
  const server = [{ messageId: "m1", arrivalSeq: 1 }, { messageId: "mine", requestId: "r1", arrivalSeq: 2 }, { messageId: "later", requestId: "z", arrivalSeq: 3 }];
  assert.equal(outboxVerdict(server, item({ requestId: "r1", baseline: { messageId: "m1" } })), "delivered");
});

test("排一条时它看到的最近一条:同一对话里更早排着的优先,失败的、别的对话的不算", () => {
  const items = [item({ requestId: "a", conversationId: "c1" }), item({ requestId: "b", conversationId: "c2" }), item({ requestId: "c", conversationId: "c1", state: "failed" })];
  assert.deepEqual(baselineFor(items, "c1", { messageId: "m1" }), { requestId: "a" });
  assert.deepEqual(baselineFor(items, "c1", { messageId: "m1" }, "a"), { messageId: "m1" }, "排除它自己(重新发送时)");
  assert.deepEqual(baselineFor(items, "c3", null), null);
});

/* ---------------- 1. 断网时排着、气泡带「等网络恢复后发出」 ---------------- */

function fakeApi({ sendImpl } = {}) {
  let push = null;
  const api = {
    async send(_id, body) { return sendImpl ? sendImpl(body) : { runId: null, seq: 5, messageId: `srv-${body?.requestId ?? "x"}`, queuePosition: 1, queueRevision: 5 }; },
    async abort() {},
    async *events(_id, _after, signal) {
      const queue = []; let wake = null;
      push = (ev) => { queue.push(ev); wake?.(); };
      const onAbort = () => wake?.();
      signal?.addEventListener("abort", onAbort);
      try {
        for (;;) {
          while (queue.length) { const ev = queue.shift(); if (ev.type === "__end") return; yield ev; }
          if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
          await new Promise((resolve) => { wake = resolve; });
          wake = null;
        }
      } finally { signal?.removeEventListener("abort", onAbort); }
    },
  };
  return { api, push: (ev) => push?.(ev), ready: () => push !== null };
}
const userEv = (seq, messageId, prompt) => ({ type: "user", seq, messageId, prompt, senderAccountId: "acc-a", senderNameAtSend: "A", projectId: "p", conversationId: "c1" });

test("断网发消息:不报错,气泡照常显示,下面是「等网络恢复后发出」;不会被下一次发送撤掉", async () => {
  const f = fakeApi();
  const store = fakeStore();
  const session = createCloudSession({ api: f.api, store, accountMode: true, flushMs: 0, backoff: () => 5 });
  session.open("c1");
  await until(f.ready);
  f.push(userEv(1, "m1", "第一条"));
  await until(() => store.get().some((m) => m.id === "cq-m1"));
  const box = createOutbox();
  const id = session.stage("断网时发的", undefined, "r1");
  box.add(item({ requestId: "r1", localId: id, text: "断网时发的", baseline: session.seenBaseline() }));
  session.showOutbox(box.items);
  const bubble = store.get().find((m) => m.id === id);
  assert.equal(bubble.text, "断网时发的");
  assert.equal(bubble.sendState, "queued", "排着(界面据此写「等网络恢复后发出」)");
  assert.equal(bubble.error, undefined, "不报错");
  assert.equal(OUTBOX_TEXT.queued, "等网络恢复后发出");
  assert.deepEqual(box.items[0].baseline, { messageId: "m1" }, "记下排队时看到的最近一条");
  // 不发了的(标发送失败)待发气泡,下一次点发送不撤(它带着「重新发送」)
  box.update("r1", { state: "failed", error: OUTBOX_TEXT.conflict });
  session.showOutbox(box.items);
  session.stage("另一条");
  const failed = store.get().find((m) => m.id === id);
  assert.equal(failed.sendState, "failed");
  assert.equal(failed.resendable, true);
  assert.equal(failed.error, OUTBOX_TEXT.conflict);
  session.close();
});

test("断流清空正文(账号模式)后,排队时看到的最近一条仍是断流前那条;重放没放到它之前也以它为准", async () => {
  const f = fakeApi();
  const store = fakeStore();
  const session = createCloudSession({ api: f.api, store, accountMode: true, flushMs: 0, backoff: () => 50 });
  session.open("c1");
  await until(f.ready);
  f.push(userEv(1, "m1", "一"));
  f.push(userEv(2, "m2", "二"));
  await until(() => store.get().some((m) => m.id === "cq-m2"));
  assert.deepEqual(session.seenBaseline(), { messageId: "m2" });
  f.push({ type: "__end" }); // 流断了:账号模式清正文、等重连
  await until(() => !store.get().some((m) => m.id === "cq-m2"));
  assert.deepEqual(session.seenBaseline(), { messageId: "m2" }, "清空以后还记得");
  await sleep(80); // 重连,从头重放
  f.push(userEv(1, "m1", "一"));
  await until(() => store.get().some((m) => m.id === "cq-m1"));
  assert.deepEqual(session.seenBaseline(), { messageId: "m2" }, "重放只到 m1:仍以 m2 为准");
  f.push(userEv(2, "m2", "二"));
  f.push(userEv(3, "m3", "三"));
  await until(() => store.get().some((m) => m.id === "cq-m3"));
  assert.deepEqual(session.seenBaseline(), { messageId: "m3" });
  session.close();
});

/* ---------------- 2. 恢复后自动发出 + 顺序 + 3 的正反两面 ---------------- */

/** 模拟服务端:消息清单 + 发送;`online` 控制连不连得上 */
function fakeServer(initial = []) {
  const messages = [...initial];
  let seq = Math.max(0, ...messages.map((m) => m.arrivalSeq));
  const net = { online: false };
  const sent = [];
  return {
    net, messages, sent,
    async list() { if (!net.online) throw new CloudError("network", "连不上云端 Agent 服务,请检查网络。"); return messages.map((m) => ({ ...m })); },
    async send(it) {
      if (!net.online) throw new CloudError("network", "连不上云端 Agent 服务,请检查网络。");
      if (!messages.some((m) => m.requestId === it.requestId)) { messages.push({ messageId: `m-${it.requestId}`, requestId: it.requestId, arrivalSeq: ++seq }); sent.push(it.text); }
    },
    otherDevice(text) { messages.push({ messageId: `m-other-${++seq}`, requestId: `other-${seq}`, arrivalSeq: seq, text }); },
  };
}
/** 同 useCloud.ts 里 attempt 的核对与发送那两步(告知、选区在浏览器探针里走真的) */
const attemptVia = (server) => async (it) => {
  let msgs;
  try { msgs = await server.list(); } catch (err) { return isTransientError(err) ? { kind: "retry" } : { kind: "failed", error: OUTBOX_TEXT.failed(err.message) }; }
  if (outboxVerdict(msgs, it) === "conflict") return { kind: "failed", error: OUTBOX_TEXT.conflict };
  try { await server.send(it); } catch (err) { return isTransientError(err) ? { kind: "retry" } : { kind: "failed", error: OUTBOX_TEXT.failed(err.message) }; }
  return { kind: "sent" };
};
function manualTimers() {
  const pending = [];
  return { pending, setTimer: (fn, ms) => { const t = { fn, ms }; pending.push(t); return t; }, clearTimer: (t) => { const i = pending.indexOf(t); if (i >= 0) pending.splice(i, 1); },
    async fire() { const t = pending.shift(); if (t) { t.fn(); await sleep(0); } } };
}

test("恢复后自动发出:断网时试不出去、按退避等着;网络回来(kick)不用再点就发出,清单清空", async () => {
  const server = fakeServer([{ messageId: "m1", requestId: "x1", arrivalSeq: 1 }]);
  const box = createOutbox();
  const timers = manualTimers();
  let browserOffline = true;
  const runner = createOutboxRunner({ outbox: box, attempt: attemptVia(server), offline: () => browserOffline, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  box.add(item({ requestId: "rA", text: "A", baseline: { messageId: "m1" } }));
  await runner.kick();
  assert.equal(server.sent.length, 0, "断着网:不发");
  assert.equal(box.items[0].state, "queued");
  assert.equal(timers.pending.length, 1, "排了下一次再试");
  // 浏览器说联网了,但服务端还连不上:试了一次没成,留着,退避
  browserOffline = false;
  await timers.fire();
  await until(() => !runner.busy);
  assert.equal(server.sent.length, 0);
  assert.equal(box.items[0].state, "queued");
  assert.equal(box.items[0].tries, 1, "试过一次:气泡一直写「等网络恢复后发出」,不来回闪");
  assert.equal(timers.pending.length, 1);
  // 网络恢复(online 事件 / 事件流重新连上 → kick)
  server.net.online = true;
  await runner.kick();
  assert.deepEqual(server.sent, ["A"], "自动发出");
  assert.equal(box.items.length, 0);
  assert.equal(timers.pending.length, 0, "没有排着的就不再定时");
  runner.stop();
});

test("同一个对话里排了多条:按排队顺序发出(B 看到的是 A,A 发出后 B 的核对照样通过)", async () => {
  const server = fakeServer([{ messageId: "m1", requestId: "x1", arrivalSeq: 1 }]);
  const box = createOutbox();
  const runner = createOutboxRunner({ outbox: box, attempt: attemptVia(server), offline: () => false, setTimer: () => 0, clearTimer: () => {} });
  box.add(item({ requestId: "rA", text: "A", baseline: baselineFor(box.items, "c1", { messageId: "m1" }) }));
  box.add(item({ requestId: "rB", text: "B", baseline: baselineFor(box.items, "c1", { messageId: "m1" }) }));
  box.add(item({ requestId: "rC", text: "C", baseline: baselineFor(box.items, "c1", { messageId: "m1" }) }));
  assert.deepEqual(box.items.map((x) => x.baseline), [{ messageId: "m1" }, { requestId: "rA" }, { requestId: "rB" }]);
  server.net.online = true;
  await runner.kick();
  assert.deepEqual(server.sent, ["A", "B", "C"]);
  assert.equal(box.items.length, 0);
});

test("同一个对话里前一条还连不上,后面的不越过它;别的对话不受影响", async () => {
  const calls = [];
  const box = createOutbox();
  let aOk = false;
  const runner = createOutboxRunner({ outbox: box, offline: () => false, setTimer: () => 0, clearTimer: () => {},
    attempt: async (it) => { calls.push(it.text); if (it.text === "A" && !aOk) return { kind: "retry" }; return { kind: "sent" }; } });
  box.add(item({ requestId: "rA", text: "A" }));
  box.add(item({ requestId: "rB", text: "B" }));
  box.add(item({ requestId: "rX", text: "X", conversationId: "c2" }));
  await runner.kick();
  assert.deepEqual(calls, ["A", "X"], "B 等 A");
  assert.deepEqual(box.items.map((x) => x.text), ["A", "B"]);
  aOk = true;
  await runner.kick();
  assert.deepEqual(calls, ["A", "X", "A", "B"]);
  assert.equal(box.items.length, 0);
});

test("最近一条没变 → 恢复后发出(正);离线期间别人发过 → 不发,标「发送失败」(反)", async () => {
  // 正
  const ok = fakeServer([{ messageId: "m1", requestId: "x1", arrivalSeq: 1 }]);
  const box1 = createOutbox();
  box1.add(item({ requestId: "rA", text: "A", baseline: { messageId: "m1" } }));
  ok.net.online = true;
  await createOutboxRunner({ outbox: box1, attempt: attemptVia(ok), offline: () => false, setTimer: () => 0, clearTimer: () => {} }).kick();
  assert.deepEqual(ok.sent, ["A"]);
  assert.equal(box1.items.length, 0);
  // 反
  const changed = fakeServer([{ messageId: "m1", requestId: "x1", arrivalSeq: 1 }]);
  const box2 = createOutbox();
  box2.add(item({ requestId: "rA", text: "A", baseline: { messageId: "m1" } }));
  box2.add(item({ requestId: "rB", text: "B", baseline: { requestId: "rA" } }));
  changed.otherDevice("别人发的");
  changed.net.online = true;
  await createOutboxRunner({ outbox: box2, attempt: attemptVia(changed), offline: () => false, setTimer: () => 0, clearTimer: () => {} }).kick();
  assert.deepEqual(changed.sent, [], "一条都没发");
  assert.deepEqual(box2.items.map((x) => [x.text, x.state, x.error]), [["A", "failed", OUTBOX_TEXT.conflict], ["B", "failed", OUTBOX_TEXT.conflict]],
    "两条都标发送失败(B 看到的是没发出的 A)");
});

/* ---------------- 4. 重新发送按当前状态重走 ---------------- */

test("重新发送:核对以点的这一刻看到的为准(这时最近一条已是别人那条)→ 发出;挪到清单末尾", async () => {
  const server = fakeServer([{ messageId: "m1", requestId: "x1", arrivalSeq: 1 }]);
  const box = createOutbox();
  const runner = createOutboxRunner({ outbox: box, attempt: attemptVia(server), offline: () => false, setTimer: () => 0, clearTimer: () => {} });
  box.add(item({ requestId: "rA", text: "A", baseline: { messageId: "m1" } }));
  server.otherDevice("别人发的");
  server.net.online = true;
  await runner.kick();
  assert.equal(box.items[0].state, "failed");
  // 页面此刻看到的最近一条是别人那条(事件流已经重放到它)
  const seenNow = { messageId: server.messages.at(-1).messageId };
  box.add(item({ requestId: "rZ", text: "Z", conversationId: "c9", state: "failed", error: "x" }));
  box.requeue("rA", baselineFor(box.items, "c1", seenNow, "rA"));
  assert.deepEqual(box.items.map((x) => x.requestId), ["rZ", "rA"], "重新发送的挪到最后");
  assert.equal(box.get("rA").state, "queued");
  assert.equal(box.get("rA").error, undefined);
  assert.deepEqual(box.get("rA").baseline, seenNow);
  await runner.kick();
  assert.deepEqual(server.sent, ["A"]);
  assert.equal(box.get("rA"), null);
  // 重新发送之后又有人发了:照样不发(核对仍然以服务端为准)
  box.add(item({ requestId: "rQ", text: "Q", baseline: { messageId: server.messages.at(-1).messageId } }));
  server.otherDevice("又一条");
  await runner.kick();
  assert.equal(box.get("rQ").state, "failed");
});

test("其它原因不再试(没权限、对话被删):标「发送失败：原因」;5xx、忙、断网一类留着再试", async () => {
  const box = createOutbox();
  let err = new CloudError("forbidden", "你没有权限使用这个项目的云端 Agent。", 403);
  const runner = createOutboxRunner({ outbox: box, offline: () => false, setTimer: () => 0, clearTimer: () => {},
    attempt: async () => (isTransientError(err) ? { kind: "retry" } : { kind: "failed", error: OUTBOX_TEXT.failed(err.message) }) });
  box.add(item());
  await runner.kick();
  assert.equal(box.items[0].error, "发送失败：你没有权限使用这个项目的云端 Agent。");
  assert.equal(isTransientError(new CloudError("unavailable", "x", 503)), true);
  assert.equal(isTransientError(new CloudError("busy", "x", 429)), true);
  assert.equal(isTransientError(new CloudError("conversation-deleted", "x", 404)), false);
  // 点发送那一下只有真断网才转排着(5xx 照旧当场报错)
  assert.equal(isOfflineError(new CloudError("network", "x")), true);
  assert.equal(isOfflineError(new CloudError("unavailable", DOC_LINK_DOWN_TEXT)), true, "和文档服务的连接断着");
  assert.equal(isOfflineError(new CloudError("unavailable", "这个项目没有可用的云端 Agent。")), false);
  assert.equal(isOfflineError(new CloudError("unavailable", "x", 503)), false);
  assert.equal(isOfflineError(new TypeError("Failed to fetch")), true);
  assert.equal(isOfflineError(new CloudError("forbidden", "x", 403), true), true, "浏览器说断网时一律算断网");
  err = null;
});

/* ---------------- 跨刷新、数字 ---------------- */

test("排着的消息跨页面刷新还在(按账号、项目、页签存);刷新前正在发的那条按排着办;不和别的键共用", () => {
  const storage = memStorage();
  const key = outboxKey("acc-a", "proj", "tab1");
  assert.equal(key, "pc.cloudOutbox:acc-a:proj:tab1");
  const a = createOutbox({ storage, key });
  a.add(item({ requestId: "rA", text: "A", localId: "local-x", options: { model: "m", creativity: null } }));
  a.add(item({ requestId: "rB", text: "B", baseline: { requestId: "rA" } }));
  a.update("rA", { state: "sending" });
  a.add(item({ requestId: "rC", text: "C", state: "failed", error: OUTBOX_TEXT.conflict }));
  const b = createOutbox({ storage, key }); // 刷新页面
  assert.deepEqual(b.items.map((x) => [x.requestId, x.state]), [["rA", "queued"], ["rB", "queued"], ["rC", "failed"]]);
  assert.equal(outboxLocalId(b.get("rA")), "local-x");
  assert.equal(outboxLocalId(b.get("rB")), "local-rB");
  assert.deepEqual(b.get("rA").options, { model: "m", creativity: null }, "运行选项按点发送时的");
  assert.deepEqual(b.get("rB").baseline, { requestId: "rA" });
  assert.equal(b.get("rC").error, OUTBOX_TEXT.conflict);
  assert.deepEqual([...storage.map.keys()], [key], "只写这一个键");
  for (const x of [...b.items]) b.remove(x.requestId);
  assert.equal(storage.map.size, 0, "清空了就删键");
  // 坏数据不炸
  storage.setItem(key, "{not json");
  assert.deepEqual(createOutbox({ storage, key }).items, []);
});

test("数字:退避 2 秒起、翻倍、封顶 30 秒", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 9].map(outboxBackoff), [2000, 4000, 8000, 16000, 30000, 30000, 30000]);
});

test("向服务端现问:GET 对话 → 取 meta.messages 的消息号、请求号、到达序号;服务端还没有这个对话 → 空清单", async () => {
  const { createCloudApi } = await import("./cloudApi.ts");
  const calls = [];
  const reply = { status: 200, body: { ok: true, meta: { id: "c1", messages: [{ messageId: "m1", requestId: "r1", arrivalSeq: 4, content: "正文不取" }, null] } } };
  const api = createCloudApi({ baseUrl: () => "http://agent/v1", projectId: () => "p", ticket: async () => "t",
    fetchImpl: async (url, init) => { calls.push([String(url), init.method ?? "GET"]); return new Response(JSON.stringify(reply.body), { status: reply.status }); } });
  assert.deepEqual(await api.conversationMessages("c1"), [{ messageId: "m1", requestId: "r1", arrivalSeq: 4 }]);
  assert.deepEqual(calls[0], ["http://agent/v1/conversations/c1", "GET"]);
  reply.status = 404; reply.body = { ok: false, code: "no-conversation" };
  assert.deepEqual(await api.conversationMessages("c1"), []);
  reply.status = 404; reply.body = { ok: false, code: "conversation-deleted" };
  await assert.rejects(api.conversationMessages("c1"), { code: "conversation-deleted" });
  reply.status = 200; reply.body = { ok: true, meta: { id: "other", messages: [] } };
  await assert.rejects(api.conversationMessages("c1"), { code: "unavailable" }, "回的不是这个对话:不认");
  const offline = createCloudApi({ baseUrl: () => "http://agent/v1", ticket: async () => "t", fetchImpl: async () => { throw new TypeError("Failed to fetch"); } });
  await assert.rejects(offline.conversationMessages("c1"), (err) => err.code === "network" && isOfflineError(err));
});
