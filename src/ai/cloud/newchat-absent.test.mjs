/**
 * 新开的云端对话(服务端还没有它)在页面一侧的状态机:
 *   还不存在  —— 账号模式下事件流回 404 `no-conversation`,而页面这一次 open 之后既没读到过它、也没发过消息:安静地停下,不当断线、不重试;
 *   真断线    —— 连不上、502、读到过又 404(被删、被设为私有):照原样「重新连接」并一直重试;
 *   被拒      —— 401/403 和身份类错误:停下并给原因。
 * 「还不存在」只对页面标明是刚建的新对话(`open(id, { fresh: true })`)成立；同样的 404 出现在别的对话上(被设为私有、被删除)仍是故障。
 * 只测 session.ts,不碰网络与 React。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createCloudSession } from "./session.ts";
import { CloudError } from "./cloudApi.ts";

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
const absent = () => new CloudError("no-conversation", "云端 Agent 出错了(no-conversation)。", 404);
const live = [{ type: "queue.state", conversationId: "c", queueRevision: 0, aclRevision: 0, currentRunId: null, items: [] }];

/** 每一项是一条连接：`fail` 抛这个错；`events` 发完这些事件后按 `then` 收尾('throw' 抛网络错 | 'hang' 一直开着) */
function fakeApi(connections, { acceptedSeq = 1 } = {}) {
  const log = { afters: [], sent: [] };
  let n = 0;
  return {
    log,
    api: {
      async send(id, body) { log.sent.push({ id, body }); return { runId: "r", seq: acceptedSeq }; },
      async abort() {},
      async *events(id, after, signal) {
        log.afters.push(after);
        const conn = connections[Math.min(n++, connections.length - 1)];
        if (conn.fail) throw conn.fail;
        for (const ev of conn.events ?? []) { if (signal?.aborted) return; yield ev; await pause(1); }
        if (conn.then === "throw") throw new CloudError("network", "断了");
        if (conn.then === "hang") await new Promise((resolve) => { signal?.addEventListener("abort", resolve, { once: true }); });
      },
    },
  };
}

for (const accountMode of [true, false]) {
  const mode = accountMode ? "账号模式" : "本机模式";

  test(`NEWCHAT-1 还不存在(${mode}):事件流回 404 no-conversation,停在安静的空对话,不重连、不报问题、只请求一次`, async () => {
    const store = memStore();
    const { api, log } = fakeApi([{ fail: absent() }]);
    const s = createCloudSession({ api, store, accountMode, flushMs: 0, backoff: () => 1 });
    const seen = new Set();
    s.subscribe(() => seen.add(s.getView().connection));
    s.open("c-new", { fresh: true });
    await waitFor(() => s.getView().connection === "idle" && log.afters.length === 1);
    await pause(60);
    assert.equal(log.afters.length, 1, "没有后台重试");
    assert.equal(s.getView().problem, null);
    assert.equal(seen.has("reconnecting"), false, "全程没有出现过「正在重新连接」");
    assert.equal(store.get().length, 0);
    s.close();
  });

  test(`NEWCHAT-2 发出第一条消息后事件流接上,回复照常进来(${mode})`, async () => {
    const store = memStore();
    const run = [
      { type: "user", runId: "r", seq: 1, prompt: "你好", at: 1 },
      { type: "text", runId: "r", seq: 2, delta: "回复" },
      { type: "done", runId: "r", seq: 3, outcome: "completed" },
      { type: "end", runId: "r", seq: 4 },
    ];
    const { api, log } = fakeApi([{ fail: absent() }, { events: accountMode ? live : run, then: "hang" }]);
    const s = createCloudSession({ api, store, accountMode, flushMs: 0, backoff: () => 1 });
    s.open("c-new", { fresh: true });
    await waitFor(() => s.getView().connection === "idle" && log.afters.length === 1);
    await s.send({ prompt: "你好" });
    await waitFor(() => log.afters.length === 2 && s.getView().connection === "live");
    assert.equal(s.getView().problem, null);
    s.close();
  });

  test(`NEWCHAT-3 刚发完第一条消息时事件流偶尔还读不到(404)按真故障重试,不当成「不存在」(${mode})`, async () => {
    const store = memStore();
    const { api, log } = fakeApi([{ fail: absent() }, { fail: absent() }, { events: live, then: "hang" }]);
    const s = createCloudSession({ api, store, accountMode, flushMs: 0, backoff: () => 1 });
    s.open("c-new", { fresh: true });
    await waitFor(() => s.getView().connection === "idle" && log.afters.length === 1);
    await s.send({ prompt: "你好" });
    await waitFor(() => log.afters.length >= 3 && s.getView().connection === "live");
    s.close();
  });

  test(`NEWCHAT-4 读到过的对话之后再 404(被删、被设为私有)不是「还没发过消息」:照原样重连并一直重试(${mode})`, async () => {
    const store = memStore();
    const { api, log } = fakeApi([{ events: live, then: "throw" }, { fail: absent() }]);
    const s = createCloudSession({ api, store, accountMode, flushMs: 0, backoff: () => 1 });
    s.open("c-1", { fresh: true });
    await waitFor(() => log.afters.length >= 4);
    assert.equal(s.getView().connection, "reconnecting");
    s.close();
  });

  test(`NEWCHAT-5 真断线:连不上、502 都按原样重连并一直重试,不当成「不存在」(${mode})`, async () => {
    for (const fail of [new CloudError("network", "连不上", 0), new CloudError("unavailable", "bad gateway", 502), new CloudError("not-found", "路由不存在的 404", 404), new CloudError("unavailable", "代理转错了地方的 404(没带错误码)", 404)]) {
      const store = memStore();
      const { api, log } = fakeApi([{ fail }]);
      const s = createCloudSession({ api, store, accountMode, flushMs: 0, backoff: () => 1 });
      s.open("c-1", { fresh: true });
      await waitFor(() => log.afters.length >= 4);
      assert.equal(s.getView().connection, "reconnecting", `${fail.status}`);
      s.close();
    }
  });

  test(`NEWCHAT-6 被拒:401/403 和身份类错误停下并给原因,不重试(${mode})`, async () => {
    for (const fail of [new CloudError("unauthorized", "身份验证没有通过", 401), new CloudError("forbidden", "没有权限", 403), new CloudError("disabled", "项目创建者已关闭云端 Agent。", 403)]) {
      const store = memStore();
      const { api, log } = fakeApi([{ fail }]);
      const s = createCloudSession({ api, store, accountMode, flushMs: 0, backoff: () => 1 });
      s.open("c-1", { fresh: true });
      await waitFor(() => s.getView().problem !== null);
      await pause(40);
      assert.equal(log.afters.length, 1, `${fail.status} 不重试`);
      assert.equal(s.getView().connection, "idle");
      s.close();
    }
  });
}

test("NEWCHAT-9 不是页面刚建的新对话(从历史里选的、记着的旧 id):同样的 404 是故障,照原样重连并一直重试", async () => {
  for (const accountMode of [true, false]) {
    const store = memStore();
    const { api, log } = fakeApi([{ fail: absent() }]);
    const s = createCloudSession({ api, store, accountMode, flushMs: 0, backoff: () => 1 });
    s.open("c-private-now");
    await waitFor(() => log.afters.length >= 4);
    assert.equal(s.getView().connection, "reconnecting");
    s.open("c-other", { fresh: false });
    await waitFor(() => log.afters.length >= 8);
    assert.equal(s.getView().connection, "reconnecting");
    s.close();
  }
});

test("NEWCHAT-7 换到另一个对话再换回:每次 open 都重新算「读到过没有」", async () => {
  const store = memStore();
  const { api, log } = fakeApi([{ events: live, then: "hang" }, { fail: absent() }]);
  const s = createCloudSession({ api, store, accountMode: true, flushMs: 0, backoff: () => 1 });
  s.open("c-old");
  await waitFor(() => s.getView().connection === "live");
  s.open("c-fresh", { fresh: true });
  await waitFor(() => s.getView().connection === "idle" && log.afters.length === 2);
  await pause(40);
  assert.equal(log.afters.length, 2);
  assert.equal(s.getView().problem, null);
  s.close();
});

test("NEWCHAT-8 安静停下之后窗口回到前台(kick)只再问一次,仍是 404 就仍然安静", async () => {
  const store = memStore();
  const { api, log } = fakeApi([{ fail: absent() }]);
  const s = createCloudSession({ api, store, accountMode: true, flushMs: 0, backoff: () => 1 });
  s.open("c-new", { fresh: true });
  await waitFor(() => s.getView().connection === "idle" && log.afters.length === 1);
  s.kick();
  await waitFor(() => log.afters.length === 2);
  await pause(40);
  assert.equal(log.afters.length, 2);
  assert.equal(s.getView().connection, "idle");
  assert.equal(s.getView().problem, null);
  s.close();
});
