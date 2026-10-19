/**
 * 账号模式点发送当场出气泡(session.ts 的 stage)：云端收下前写「发送中…」，收下后写「已发出，等待云端开始处理…」，
 * 服务端的记录一到就换成它；没发出去标「没有发出去」写原因，不显示成已发送。
 * 对话空闲时排第一的那条不算排队(events.ts 的 isIdleHead / markWaitingFromQueue)。
 * 跑:npm test -- src/ai/cloud/optimistic-send.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createCloudSession } from "./session.ts";
import { isIdleHead, markWaitingFromQueue } from "./events.ts";
import { CloudError } from "./cloudApi.ts";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check, ms = 3000) => { const end = Date.now() + ms; for (;;) { if (check()) return; if (Date.now() > end) throw new Error("等不到"); await sleep(5); } };

function fakeStore() {
  let value = [];
  const listeners = new Set();
  return { get: () => value, set(next) { value = typeof next === "function" ? next(value) : next; for (const l of [...listeners]) l(); }, subscribe(l) { listeners.add(l); return () => listeners.delete(l); } };
}

function fakeApi({ sendImpl } = {}) {
  let push = null, opens = 0;
  const api = {
    async send(_id, body) { return sendImpl ? sendImpl(body) : { runId: null, seq: 1, messageId: "m1", queuePosition: 1, queueRevision: 1 }; },
    async abort() {},
    async *events(_id, _after, signal) {
      opens++;
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
  return { api, push: (ev) => push?.(ev), ready: () => push !== null, opens: () => opens };
}

const userEvent = { type: "user", seq: 1, messageId: "m1", prompt: "做一个片头", senderAccountId: "acc-a", senderNameAtSend: "A",
  projectId: "p", conversationId: "c1" };

test("发送：当场出「发送中」气泡 → 云端收下改「已发出」→ 服务端记录到了换成它，不叠两条", async () => {
  let release;
  const f = fakeApi({ sendImpl: () => new Promise((r) => { release = () => r({ runId: null, seq: 1, messageId: "m1", queuePosition: 1, queueRevision: 1 }); }) });
  const store = fakeStore();
  const session = createCloudSession({ api: f.api, store, accountMode: true, flushMs: 0, backoff: () => 5 });
  session.open("c1");
  await until(f.ready);
  const id = session.stage("做一个片头");
  assert.deepEqual(store.get().map((m) => [m.role, m.text, m.sendState]), [["user", "做一个片头", "sending"]], "一点发送就有气泡");
  const sending = session.send({ prompt: "做一个片头" }, undefined, { staged: id });
  await sleep(10);
  assert.equal(store.get()[0].sendState, "sending", "云端还没回话：只写发送中，不显示成已发送");
  release(); await sending;
  assert.equal(store.get()[0].sendState, "accepted");
  f.push(userEvent);
  await until(() => store.get().some((m) => m.id === "cq-m1"));
  assert.deepEqual(store.get().map((m) => m.id), ["cq-m1"], "本地气泡换成服务端那条");
});

test("没发出去（没权限、网络断）：气泡标「没有发出去」写原因；下一次发送时撤掉旧的失败气泡", async () => {
  const f = fakeApi({ sendImpl: async () => { throw new CloudError("forbidden", "你没有权限使用这个项目的云端 Agent。", 403); } });
  const store = fakeStore();
  const session = createCloudSession({ api: f.api, store, accountMode: true, flushMs: 0, backoff: () => 5 });
  session.open("c1");
  await until(f.ready);
  const id = session.stage("hi");
  await assert.rejects(session.send({ prompt: "hi" }, undefined, { staged: id }), { code: "forbidden" });
  const m = store.get()[0];
  assert.equal(m.sendState, "failed");
  assert.match(m.error, /没有发出去：你没有权限/);
  session.stage("hi again");
  assert.deepEqual(store.get().map((x) => x.text), ["hi again"], "失败的那条撤掉，只留新的");
});

test("断流重连(账号对话清掉正文从头重放)后本地气泡补回；换对话清掉", async () => {
  const f = fakeApi();
  const store = fakeStore();
  const session = createCloudSession({ api: f.api, store, accountMode: true, flushMs: 0, backoff: () => 5 });
  session.open("c1");
  await until(f.ready);
  session.stage("还没回来的那条");
  // 流断了：账号对话清掉正文、从头重放(session.ts 的 clearAccountReadState)；本地气泡补回
  f.push({ type: "__end" });
  await until(() => f.opens() >= 2);
  assert.deepEqual(store.get().map((m) => [m.text, m.sendState]), [["还没回来的那条", "sending"]]);
  session.open("c2");
  assert.equal(store.get().length, 0, "换对话：本地气泡不跟过去");
});

test("对话空闲时排第一的不算排队：不进队列，气泡下写「已发出，等待云端开始处理…」；前面有一轮在跑时照旧排队", () => {
  const msgs = [{ id: "cq-m1", role: "user", text: "a" }, { id: "cq-m2", role: "user", text: "b" }];
  const idle = { conversationId: "c1", queueRevision: 2, aclRevision: 1, currentRunId: null,
    items: [{ messageId: "m1", arrivalSeq: 1, state: "queued", position: 1, runId: null }, { messageId: "m2", arrivalSeq: 2, state: "queued", position: 2, runId: null }] };
  assert.equal(isIdleHead(idle, idle.items[0]), true);
  assert.equal(isIdleHead(idle, idle.items[1]), false);
  const marked = markWaitingFromQueue(msgs, idle);
  assert.deepEqual(marked.map((m) => m.sendState), ["accepted", undefined]);
  assert.equal(markWaitingFromQueue(marked, idle), marked, "同一份快照折两次不变");
  const busy = { ...idle, currentRunId: "r0", items: [{ messageId: "m0", arrivalSeq: 0, state: "running", position: null, runId: "r0" }, ...idle.items] };
  assert.equal(isIdleHead(busy, busy.items[1]), false, "前面有一轮在跑：第一位照旧算排队");
  assert.deepEqual(markWaitingFromQueue(marked, busy).map((m) => m.sendState), [undefined, undefined]);
});
