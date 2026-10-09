import test from "node:test";
import assert from "node:assert/strict";
import { createCloudSession } from "./session.ts";
import { CloudError } from "./cloudApi.ts";

function memStore() {
  let messages = [];
  const listeners = new Set();
  return {
    get: () => messages,
    set(next) {
      messages = typeof next === "function" ? next(messages) : next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};

const waitFor = async (check, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("wait timed out");
};

test("账号读取 EOF 清正文、待折增量和附件关联；从 seq 0 重放且旧页面工具结果不回写", async t => {
  const store = memStore();
  const disconnect = deferred();
  const pageToolStarted = deferred();
  const pageToolFinish = deferred();
  const replayStarted = deferred();
  const afters = [];
  let streams = 0, pageResults = 0;
  const api = {
    async send() { return { runId: "r2", seq: 4 }; },
    async abort() { assert.fail("读取关闭不能停止服务端任务"); },
    async pageResult() { pageResults++; },
    async *events(_id, after, signal) {
      afters.push(after);
      streams++;
      if (streams === 1) {
        yield { type: "user", seq: 1, runId: "r1", prompt: "first authorized body", messageId: "m1", senderAccountId: "member-account", senderNameAtSend: "Member" };
        yield { type: "run", seq: 2, runId: "r1" };
        yield { type: "text", seq: 3, runId: "r1", delta: "buffered private text" };
        yield { type: "queue.state", conversationId: "conversation", queueRevision: 1, aclRevision: 1,
          currentRunId: "r1", items: [{ messageId: "m1", arrivalSeq: 1, state: "running", runId: "r1", position: null }] };
        yield { type: "page.request", id: "old-page-request" };
        await disconnect.promise;
        return; // 服务端关闭旧 SSE，不伪造 403 或 revoked 事件。
      }
      replayStarted.resolve({ after, messagesBeforeReplay: store.get(), viewBeforeReplay: session.getView() });
      yield { type: "user", seq: 1, runId: "r2", prompt: "replayed authorized body" };
      await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
    },
  };
  const session = createCloudSession({
    api, store, accountMode: true, pageId: "page", flushMs: 60_000, backoff: () => 1,
    onPageRequest: async () => { pageToolStarted.resolve(); await pageToolFinish.promise; return { id: "old-page-request", ok: true }; },
  });
  t.after(() => { disconnect.resolve(); pageToolFinish.resolve(); session.close(); });

  session.open("conversation");
  await waitFor(() => session.getView().lastSeq === 3);
  await pageToolStarted.promise;
  await session.send({ prompt: "sent before access loss" }, [{ id: "a", url: "work:attachments/a", name: "private.mp4", kind: "video", status: "ready" }]);
  assert.ok(store.get().length > 0, "共有读取时页面确实已有正文");
  disconnect.resolve();

  const replay = await replayStarted.promise;
  assert.equal(replay.after, 0, "新 SSE 从 seq 0 请求完整重放");
  assert.deepEqual(replay.messagesBeforeReplay, [], "旧正文在重连前已清除");
  assert.equal(replay.viewBeforeReplay.queue, null, "旧队列快照已清除");
  assert.deepEqual(replay.viewBeforeReplay.senders, {}, "旧发言者缓存已清除");
  pageToolFinish.resolve();
  await waitFor(() => store.get().some(message => message.role === "user" && message.text === "replayed authorized body"));
  await new Promise(resolve => setTimeout(resolve, 10));
  const replayed = store.get().find(message => message.role === "user" && message.text === "replayed authorized body");
  assert.equal(replayed.attachments, undefined, "旧授权下尚未贴上的附件关联不会随重放复活");
  assert.equal(pageResults, 0, "失权前启动的异步页面工具不会向服务端回交结果");
  assert.deepEqual(afters, [0, 0]);
});

for (const status of [401, 403]) {
  test(`账号读取 HTTP ${status} 即使带业务错误码也清正文并停止重连`, async t => {
    const store = memStore();
    let streams = 0;
    const api = {
      async send() { return { runId: "r", seq: 3 }; },
      async abort() { assert.fail("读取失权不能停止服务端任务"); },
      async *events() {
        streams++;
        yield { type: "user", seq: 1, runId: "r", prompt: "cached body" };
        yield { type: "text", seq: 2, runId: "r", delta: "cached text" };
        throw new CloudError("agent-fence-pending", "业务码不能覆盖 HTTP 失权状态", status);
      },
    };
    const session = createCloudSession({ api, store, accountMode: true, flushMs: 0, backoff: () => 1 });
    t.after(() => session.close());
    session.open("conversation");
    await waitFor(() => session.getView().problem !== null);
    assert.deepEqual(store.get(), [], "HTTP 401/403 清除先前已读内容");
    assert.equal(session.getView().lastSeq, 0);
    assert.equal(session.getView().connection, "idle");
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(streams, 1, "身份失权后不自动重连旧对话");
  });
}

test("旧 LAN 会话断线仍沿用 seq 续读和缓存语义", async t => {
  const store = memStore();
  let streams = 0;
  const afters = [];
  const api = {
    async send() { return { runId: "r", seq: 1 }; },
    async abort() {},
    async *events(_id, after) {
      afters.push(after);
      streams++;
      if (streams === 1) { yield { type: "user", seq: 1, runId: "r", prompt: "LAN cached body" }; throw new CloudError("network", "断线"); }
      yield { type: "end", seq: 2, state: "none" };
    },
  };
  const session = createCloudSession({ api, store, flushMs: 0, backoff: () => 1 });
  t.after(() => session.close());
  session.open("conversation");
  await waitFor(() => streams === 2);
  assert.deepEqual(afters, [0, 1]);
  assert.equal(store.get()[0]?.text, "LAN cached body");
});
