/**
 * 云端对话正开着的时候读取被撤销(创建者设为私有、对话被删、被踢、退出登录、Agent 被关):页面一侧的状态机。
 *   真没权限 → 清掉正文,显示已有的那句「当前账号已无法读取这个对话，请重新选择有权限的对话。」(被关 Agent 用它自己已有的句子),停止读,不一直重连;
 *   暂时故障(连不上、502、503) → 照原样重连,不被说成没权限;
 *   事件流里直接来的 `access.revoked` 同样走那一句。
 * 只测 session.ts。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createCloudSession } from "./session.ts";
import { CloudError, cloudErrorText } from "./cloudApi.ts";

const REVOKED = "当前账号已无法读取这个对话，请重新选择有权限的对话。";

function memStore() {
  let messages = [];
  const ls = new Set();
  return {
    get: () => messages,
    set(next) { const v = typeof next === "function" ? next(messages) : next; if (v === messages) return; messages = v; for (const l of ls) l(); },
    replace(next) { messages = Array.isArray(next) ? next : []; },
    subscribe(fn) { ls.add(fn); return () => ls.delete(fn); },
  };
}
const waitFor = async (fn, ms = 3000) => {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error("等待超时"); await new Promise((r) => setTimeout(r, 5)); }
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const content = [
  { type: "queue.state", conversationId: "c", queueRevision: 0, aclRevision: 0, currentRunId: null, items: [] },
  { type: "user", messageId: "m1", prompt: "旧内容", seq: 1, senderAccountId: "acc_x", senderNameAtSend: "X", queueState: "done" },
];
function fakeApi(connections) {
  const log = { afters: [] };
  let n = 0;
  return { log, api: {
    async send() { return { runId: "r", seq: 1 }; }, async abort() {},
    async *events(id, after) {
      log.afters.push(after);
      const conn = connections[Math.min(n++, connections.length - 1)];
      if (conn.fail) throw conn.fail;
      for (const ev of conn.events ?? []) { yield ev; await pause(1); }
      if (conn.then === "throw") throw new CloudError("network", "断了");
      if (conn.then === "close") return;
      if (conn.then === "hang") await new Promise(() => {});
    },
  } };
}
const open = (connections, accountMode = true) => {
  const store = memStore();
  const { api, log } = fakeApi(connections);
  const s = createCloudSession({ api, store, accountMode, flushMs: 0, backoff: () => 1 });
  s.open("c-1");
  return { s, store, log };
};

test("PRIV-1 设为私有/删除：围栏掐断旧流后重连得 404 no-conversation → 清正文、给「已无法读取」、停止读(账号模式)", async () => {
  for (const then of ["close", "throw"]) {
    const { s, store, log } = open([{ events: content, then }, { fail: new CloudError("no-conversation", "no-conversation", 404) }]);
    await waitFor(() => s.getView().problem === REVOKED);
    await pause(60);
    assert.equal(log.afters.length, 2, `${then}：只重连了一次，之后不再请求`);
    assert.equal(s.getView().connection, "idle");
    assert.equal(store.get().length, 0, "旧内容清掉");
    assert.equal(s.getView().lastSeq, 0);
    s.close();
  }
});

test("PRIV-2 被踢/不在成员名单(403 not-listed、banned)：同一句「已无法读取」，停止读", async () => {
  for (const code of ["not-listed", "banned"]) {
    const { s, log } = open([{ events: content, then: "close" }, { fail: new CloudError(code, code, 403) }]);
    await waitFor(() => s.getView().problem === REVOKED);
    await pause(40);
    assert.equal(log.afters.length, 2);
    assert.equal(s.getView().connection, "idle");
    s.close();
  }
});

test("PRIV-2b 项目被删(404 no-project)：同一句「已无法读取」，停止读；没读到过时仍按故障重连", async () => {
  const gone = () => new CloudError("no-project", "no-project", 404);
  const a = open([{ events: content, then: "close" }, { fail: gone() }]);
  await waitFor(() => a.s.getView().problem === REVOKED);
  await pause(40);
  assert.equal(a.log.afters.length, 2);
  a.s.close();
  const b = open([{ fail: gone() }]);
  await waitFor(() => b.log.afters.length >= 4);
  assert.equal(b.s.getView().connection, "reconnecting");
  b.s.close();
});

test("PRIV-3 Agent 被关(403 agent-disabled)：用它已有的句子，停止读", async () => {
  const { s, log } = open([{ events: content, then: "close" }, { fail: new CloudError("agent-disabled", "agent-disabled", 403) }]);
  await waitFor(() => s.getView().problem === cloudErrorText("disabled"));
  await pause(40);
  assert.equal(log.afters.length, 2);
  s.close();
});

test("PRIV-4 退出登录(401)：照原有的身份句子停止读，不重连", async () => {
  const { s, log } = open([{ events: content, then: "close" }, { fail: new CloudError("unauthorized", cloudErrorText("unauthorized"), 401) }]);
  await waitFor(() => s.getView().problem === cloudErrorText("unauthorized"));
  await pause(40);
  assert.equal(log.afters.length, 2);
  s.close();
});

test("PRIV-5 暂时故障(连不上、502、503)：照原样重连并一直重试，不被说成没权限", async () => {
  for (const fail of [new CloudError("network", "连不上", 0), new CloudError("unavailable", "bad gateway", 502),
    new CloudError("conversation-client-unavailable", "x", 503), new CloudError("read-control-unavailable", "x", 503)]) {
    const { s, log } = open([{ events: content, then: "close" }, { fail }]);
    await waitFor(() => log.afters.length >= 5);
    assert.equal(s.getView().connection, "reconnecting", `${fail.status}`);
    assert.notEqual(s.getView().problem, REVOKED);
    s.close();
  }
});

test("PRIV-6 服务端在流里直接发来 access.revoked(未被围栏掐断时)：同一句，停止读", async () => {
  const { s, store, log } = open([{ events: [...content, { type: "access.revoked" }], then: "hang" }]);
  await waitFor(() => s.getView().problem === REVOKED);
  await pause(40);
  assert.equal(log.afters.length, 1);
  assert.equal(s.getView().connection, "idle");
  assert.equal(store.get().length, 0);
  s.close();
});

test("PRIV-7 对话没读到过就 404(不是新对话:历史里选的、刷新后记着的)：不算被撤销，照原样重连", async () => {
  const { s, log } = open([{ fail: new CloudError("no-conversation", "no-conversation", 404) }]);
  await waitFor(() => log.afters.length >= 4);
  assert.equal(s.getView().connection, "reconnecting");
  assert.equal(s.getView().problem, null);
  s.close();
});

test("PRIV-8 本机模式(非账号)不走这条：读到过之后的 404 仍照原样重连", async () => {
  const { s, log } = open([{ events: content, then: "close" }, { fail: new CloudError("no-conversation", "no-conversation", 404) }], false);
  await waitFor(() => log.afters.length >= 4);
  assert.equal(s.getView().connection, "reconnecting");
  s.close();
});

test("PRIV-9 撤销之后换到别的对话：新对话照常读(状态按每次 open 重算)", async () => {
  const store = memStore();
  const { api, log } = fakeApi([{ events: content, then: "close" }, { fail: new CloudError("no-conversation", "no-conversation", 404) }, { events: content, then: "hang" }]);
  const s = createCloudSession({ api, store, accountMode: true, flushMs: 0, backoff: () => 1 });
  s.open("c-1");
  await waitFor(() => s.getView().problem === REVOKED);
  s.open("c-2");
  await waitFor(() => s.getView().connection === "live" && log.afters.length === 3);
  assert.equal(s.getView().problem, null);
  s.close();
});

function createMemStorage() {
  const map = new Map();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  };
}

test("PRIV-10 设为私有被撤销后刷新/重新打开(404 no-conversation)：直接显示「已无法读取」，停止读不重连；恢复正常后移除撤销标记", async () => {
  const storage = createMemStorage();
  // 1. 之前发生过撤销
  {
    const store = memStore();
    const { api, log } = fakeApi([
      { events: content, then: "close" },
      { fail: new CloudError("no-conversation", "no-conversation", 404) },
    ]);
    const s = createCloudSession({ api, store, accountMode: true, storage, flushMs: 0, backoff: () => 1 });
    s.open("c-revoked");
    await waitFor(() => s.getView().problem === REVOKED);
    assert.equal(s.getView().revoked, true);
    s.close();
  }
  // 2. 刷新后重新打开：服务端只回 404 no-conversation (E3 场景)
  // 不再当作网络故障重连，而是直接显示那一句、置为 idle 停止重连
  {
    const store = memStore();
    const { api, log } = fakeApi([
      { fail: new CloudError("no-conversation", "no-conversation", 404) },
    ]);
    const s = createCloudSession({ api, store, accountMode: true, storage, flushMs: 0, backoff: () => 1 });
    s.open("c-revoked");
    await waitFor(() => s.getView().problem === REVOKED);
    await pause(60);
    assert.equal(log.afters.length, 1, "只请求了一次，不再重连");
    assert.equal(s.getView().connection, "idle");
    assert.equal(s.getView().revoked, true);
    s.close();
  }
  // 3. 对话后来被改回共有，用户再次点开并成功收到正常事件流：从集合中移除，revoked 变 false
  {
    const store = memStore();
    const { api, log } = fakeApi([
      { events: content, then: "hang" },
    ]);
    const s = createCloudSession({ api, store, accountMode: true, storage, flushMs: 0, backoff: () => 1 });
    s.open("c-revoked");
    await waitFor(() => s.getView().connection === "live");
    assert.equal(s.getView().problem, null);
    assert.equal(s.getView().revoked, false);
    s.close();
  }
});

test("PRIV-9 创建者关了云端 Agent(流里 access.revoked 带 reason=agent-disabled)：正文清掉,对话里留一条写明原因的出错消息,提示用「已关闭」那句,不说无权读取", async () => {
  const { s, store } = open([{ events: [...content, { type: "access.revoked", reason: "agent-disabled" }], then: "hang" }]);
  await waitFor(() => s.getView().problem === "项目创建者已关闭云端 Agent。");
  const messages = store.get();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "assistant");
  assert.equal(messages[0].outcome, "error");
  assert.equal(messages[0].pending, false);
  assert.match(messages[0].error, /项目创建者已关闭云端 Agent/);
  assert.match(messages[0].error, /已经落地的改动保留在项目里/);
  s.close();
});

test("PRIV-10 同一条 access.revoked 不带 reason(被踢、设私有):仍是清空,不出这条消息", async () => {
  const { s, store } = open([{ events: [...content, { type: "access.revoked" }], then: "hang" }]);
  await waitFor(() => s.getView().problem === REVOKED);
  assert.equal(store.get().length, 0);
  s.close();
});

test("STREAM-1 队列里当前这一轮已被领走(preparing)但还没有任何事件:streaming 为真,与输入框一致;这一轮结清后为假", async () => {
  const prep = { type: "queue.state", conversationId: "c-1", queueRevision: 1, aclRevision: 0, currentRunId: "run_x",
    items: [{ messageId: "m1", arrivalSeq: 1, state: "preparing", position: null, runId: "run_x" }] };
  const done = { type: "queue.state", conversationId: "c-1", queueRevision: 2, aclRevision: 0, currentRunId: null,
    items: [{ messageId: "m1", arrivalSeq: 1, state: "done", position: null, runId: "run_x", outcome: { status: "failed", reason: null } }] };
  const { s } = open([{ events: [prep], then: "hang" }]);
  await waitFor(() => s.getView().queue?.currentRunId === "run_x");
  assert.equal(s.getView().streaming, true);
  s.close();
  const after = open([{ events: [prep, done], then: "hang" }]);
  await waitFor(() => after.s.getView().queue?.currentRunId === null && after.s.getView().queue?.queueRevision === 2);
  assert.equal(after.s.getView().streaming, false);
  after.s.close();
});
