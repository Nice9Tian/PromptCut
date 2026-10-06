/**
 * 云端 Agent 界面的页面一侧(契约 `docs/plan/cloud-agent-contract.md` 第 2.4、7.4、9.5、10.4 节)。
 * 跑:node --test src/ai/cloud/cloud-chat.test.mjs
 *
 *   CAU-EV-01   事件折成消息:一轮的用户消息、流式文字、工具调用与结果、进度、状态、收尾;同一串事件从头折与边收边折相同;
 *   CAU-EV-02   每种收尾都给出明确原因:模型失败、额度用尽、撤销、中断、到上限;服务端的说明优先;停止记为 aborted;
 *   CAU-SES-01  事件流断了自动重连并带上已看到的 seq,补发与实时交界处重复的事件不重复折、不漏;
 *   CAU-SES-02  新对话:读到「没有」就停下,发消息后接上流;服务端把对话丢了(重启)时没收尾的一轮标成中断;
 *   CAU-SES-03  关闭只掐流、不发停止;停止才发 abort;身份类错误停下并给出原因,不无限重连;
 *   CAU-SES-04  文字增量攒批后折进去与逐条折相同;
 *   CAU-SES-05  服务端的对话从头开始了(seq 比页面看到的还小):掐掉旧流、从 0 重读;
 *   CAU-EP-01   「云端」一项出不来、出现、置灰的判定:放本机的项目没有;文档服务报了才有;开关关了置灰;在线页面地址固定;
 *   CAU-API-01  请求带委托票据与对话委托、不带 Cookie;错误码换成给用户看的话;info 与对话列表容错。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { applyCloudEvent, applyCloudEvents, cloudErrorMessage, hasOpenRun, titleOf } from "./events.ts";
import { createCloudSession } from "./session.ts";
import { CloudError, cloudErrorText, createCloudApi, normalizeChatItem, normalizeInfo } from "./cloudApi.ts";
import { CLOUD_OFF, resolveCloudAgent, setCloudAgentSource, setHostedAgent, setHostedAgentEnabled, clearHostedAgent } from "./endpoint.ts";
import { CloudIdentityError, cloudGrant, cloudTicket, setCloudIdentity } from "./identity.ts";

function memStore() {
  let messages = [];
  const ls = new Set();
  return {
    get: () => messages,
    set(next) {
      const v = typeof next === "function" ? next(messages) : next;
      if (v === messages) return;
      messages = v;
      for (const l of ls) l();
    },
    replace(next) { messages = Array.isArray(next) ? next : []; },
    subscribe(fn) { ls.add(fn); return () => ls.delete(fn); },
  };
}

const run1 = [
  { type: "user", seq: 1, runId: "r1", prompt: "把标题改成你好", at: 1000 },
  { type: "run", seq: 2, runId: "r1" },
  { type: "tool_call", seq: 3, runId: "r1", name: "update_clip", input: { clipId: "c1" }, callId: "k1" },
  { type: "tool_result", seq: 4, runId: "r1", name: "update_clip", ok: true, summary: "已改", callId: "k1", durationMs: 12 },
  { type: "progress", seq: 5, runId: "r1", phase: "work", text: "第 1 步" },
  { type: "text", seq: 6, runId: "r1", delta: "改" },
  { type: "text", seq: 7, runId: "r1", delta: "好了" },
  { type: "done", seq: 8, runId: "r1", outcome: "completed" },
  { type: "end", seq: 9, runId: "r1", state: "idle" },
];

test("CAU-EV-01 事件折成消息,从头折与边收边折相同", () => {
  const all = applyCloudEvents([], run1);
  assert.equal(all.length, 2);
  assert.deepEqual([all[0].role, all[0].text], ["user", "把标题改成你好"]);
  const a = all[1];
  assert.equal(a.role, "assistant");
  assert.equal(a.text, "改好了");
  assert.equal(a.pending, false);
  assert.equal(a.outcome, "completed");
  assert.deepEqual(a.parts.map((p) => p.kind), ["tool", "text"]);
  assert.equal(a.parts[0].ok, true);
  assert.equal(a.parts[0].summary, "已改");
  assert.equal(a.parts[0].durationMs, 12);
  assert.equal(a.tools[0].ok, true);
  assert.equal(a.progress.text, "第 1 步");
  let step = [];
  for (const ev of run1) step = applyCloudEvent(step, ev);
  assert.deepEqual(step.map((m) => ({ ...m, finishedAt: 0 })), all.map((m) => ({ ...m, finishedAt: 0 })));
  // 折函数对重放幂等:整串事件再折一遍,消息原样不变(重连交界处、从头重读都靠这一点)
  assert.equal(applyCloudEvents(all, run1), all);
  // 同一个 user 事件补发两次不重复
  assert.equal(applyCloudEvents(all, [run1[0]]).length, 2);
  // tool_call 补发两次不重复
  assert.equal(applyCloudEvents(all, [run1[2]])[1].parts.filter((p) => p.kind === "tool").length, 1);
  assert.equal(hasOpenRun(applyCloudEvents([], run1.slice(0, 5))), true);
  assert.equal(hasOpenRun(all), false);
  assert.equal(titleOf(all), "把标题改成你好");
  // 不认得的事件类型原样放过
  assert.equal(applyCloudEvent(all, { type: "future-thing", runId: "r1" }), all);
});

test("CAU-EV-01b 两轮、补渲进展、思考片段", () => {
  const evs = [
    ...run1,
    { type: "user", seq: 10, runId: "r2", prompt: "再来" },
    { type: "thinking", seq: 11, runId: "r2", delta: "想" },
    { type: "render", seq: 12, runId: "r2", state: "published", clips: ["c1", "c2"] },
    { type: "render", seq: 13, runId: "r2", state: "progress", done: 1, total: 2 },
    { type: "render", seq: 14, runId: "r2", state: "failed", reason: "渲染节点不可用" },
    { type: "end", seq: 15, runId: "r2", state: "idle" },
  ];
  const all = applyCloudEvents([], evs);
  assert.equal(all.length, 4);
  const a2 = all[3];
  assert.deepEqual(a2.parts.map((p) => p.kind), ["thinking", "status", "status", "status"]);
  assert.deepEqual(a2.statuses, ["已把 2 个片段交给云端渲染", "云端渲染中:1/2", "云端渲染失败:渲染节点不可用"]);
});

test("CAU-EV-02 每种收尾都有明确原因", () => {
  const base = [{ type: "user", seq: 1, runId: "r", prompt: "x" }];
  const cases = [
    [{ type: "error", seq: 2, runId: "r", code: "model", message: "模型调用失败:额度不足" }, "模型调用失败:额度不足"],
    [{ type: "error", seq: 2, runId: "r", code: "quota-exceeded", message: "这个项目的云端 Agent 额度已用完(上限 100 万)。" }, "这个项目的云端 Agent 额度已用完(上限 100 万)。"],
    [{ type: "error", seq: 2, runId: "r", code: "revoked", reason: "removed" }, cloudErrorMessage("revoked")],
    [{ type: "error", seq: 2, runId: "r", code: "interrupted" }, cloudErrorMessage("interrupted")],
    [{ type: "error", seq: 2, runId: "r", code: "limit" }, cloudErrorMessage("limit")],
  ];
  for (const [ev, want] of cases) {
    const out = applyCloudEvents([], [...base, ev, { type: "end", seq: 3, runId: "r", state: "failed" }]);
    const a = out[1];
    assert.equal(a.error, want);
    assert.equal(a.outcome, "error", "end 不盖掉 error");
    assert.equal(a.pending, false);
  }
  assert.match(cloudErrorMessage("revoked"), /已失效/);
  assert.match(cloudErrorMessage("interrupted"), /服务中断/);
  // 停止:先一条「已停止」状态,再收尾,没有 done
  const stopped = applyCloudEvents([], [...base, { type: "status", seq: 2, runId: "r", text: "已停止" }, { type: "end", seq: 3, runId: "r", state: "idle" }]);
  assert.equal(stopped[1].outcome, "aborted");
  assert.equal(stopped[1].pending, false);
});

/** 一个假的事件流:`script` 里每一项是一条连接要发的事件,发完按 `then` 收尾('close' 正常关 | 'throw' 抛网络错 | 'hang' 一直开着) */
function fakeApi(connections) {
  const log = { afters: [], sent: [], aborted: 0 };
  let n = 0;
  return {
    log,
    api: {
      async send(id, body) { log.sent.push({ id, body }); return { runId: "r", seq: 1 }; },
      async abort() { log.aborted++; },
      async *events(id, after, signal) {
        log.afters.push(after);
        const conn = connections[Math.min(n++, connections.length - 1)];
        if (conn.fail) throw conn.fail;
        for (const ev of conn.events) { if (signal?.aborted) return; yield ev; await new Promise((r) => setTimeout(r, 1)); }
        if (conn.then === "throw") throw new CloudError("network", "断了");
        if (conn.then === "hang") await new Promise((resolve) => { signal?.addEventListener("abort", resolve, { once: true }); });
      },
    },
  };
}

const waitFor = async (fn, ms = 3000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 5));
  }
};

test("CAU-SES-01 流断了自动重连,带已看到的 seq,交界处重复的不重复、缺的补齐", async () => {
  const store = memStore();
  const { api, log } = fakeApi([
    { events: run1.slice(0, 4), then: "throw" },
    // 第二条连接按 after=4 补发 5 起;故意把 4 也重发一次(交界处重复)
    { events: [run1[3], ...run1.slice(4)], then: "hang" },
  ]);
  const s = createCloudSession({ api, store, flushMs: 0, backoff: () => 5 });
  s.open("c-1");
  await waitFor(() => s.getView().lastSeq === 9);
  assert.deepEqual(log.afters, [0, 4], "第二次连接从看到的最大 seq 起");
  const a = store.get()[1];
  assert.equal(a.text, "改好了");
  assert.equal(a.parts.filter((p) => p.kind === "tool").length, 1, "重复的 tool_result 没有重复折");
  assert.equal(s.getView().lastSeq, 9);
  assert.equal(s.getView().streaming, false);
  assert.equal(s.getView().connection, "live");
  // 与「一次读完」得到相同的消息
  const once = applyCloudEvents([], run1);
  assert.deepEqual(store.get().map((m) => ({ ...m, finishedAt: 0 })), once.map((m) => ({ ...m, finishedAt: 0 })));
  s.close();
});

test("CAU-SES-01b 断线期间界面仍显示这一轮在跑(服务端还在跑),重连时标出连接状态", async () => {
  const store = memStore();
  const { api } = fakeApi([{ events: run1.slice(0, 3), then: "throw" }, { events: [], then: "hang" }]);
  const s = createCloudSession({ api, store, flushMs: 0, backoff: () => 30 });
  const seen = new Set();
  s.subscribe(() => seen.add(s.getView().connection));
  s.open("c-1");
  await waitFor(() => s.getView().connection === "live" && s.getView().lastSeq === 3);
  await waitFor(() => seen.has("reconnecting"));
  assert.equal(s.getView().streaming, true, "没收尾的一轮,断线也还是在跑");
  s.close();
});

test("CAU-SES-02 新对话读到「没有」就停下,发消息后接上;服务端把对话丢了就标中断", async () => {
  const store = memStore();
  const none = { events: [{ type: "end", state: "none", seq: 0 }], then: "close" };
  const { api, log } = fakeApi([none, { events: run1, then: "hang" }]);
  const s = createCloudSession({ api, store, flushMs: 0, backoff: () => 5 });
  s.open("c-new");
  await waitFor(() => s.getView().connection === "idle" && log.afters.length === 1);
  assert.equal(store.get().length, 0);
  await s.send({ prompt: "你好" });
  assert.equal(log.sent[0].id, "c-new");
  await waitFor(() => store.get()[1]?.outcome === "completed");
  assert.equal(log.afters.length, 2);
  s.close();

  // 对话丢了:有一轮没收尾,重连读到「没有」
  const store2 = memStore();
  const lost = fakeApi([{ events: run1.slice(0, 3), then: "throw" }, none]);
  const s2 = createCloudSession({ api: lost.api, store: store2, flushMs: 0, backoff: () => 5 });
  s2.open("c-lost");
  await waitFor(() => store2.get()[1]?.outcome === "error");
  assert.equal(store2.get()[1].pending, false);
  assert.equal(store2.get()[1].error, cloudErrorMessage("interrupted"));
  assert.equal(s2.getView().streaming, false);
  s2.close();
});

test("CAU-SES-03 关闭只掐流不发停止;停止才发 abort;身份类错误停下给原因", async () => {
  const store = memStore();
  const { api, log } = fakeApi([{ events: run1.slice(0, 3), then: "hang" }]);
  const s = createCloudSession({ api, store, flushMs: 0 });
  s.open("c-1");
  await waitFor(() => s.getView().lastSeq === 3);
  await s.abort();
  assert.equal(log.aborted, 1);
  s.close();
  assert.equal(log.aborted, 1, "close 不发停止");
  await assert.rejects(() => s.send({ prompt: "x" }), (e) => e instanceof CloudError);

  const store2 = memStore();
  const bad = fakeApi([{ fail: new CloudError("unauthorized", cloudErrorText("unauthorized"), 401) }]);
  const s2 = createCloudSession({ api: bad.api, store: store2, flushMs: 0, backoff: () => 5 });
  s2.open("c-1");
  await waitFor(() => s2.getView().problem !== null);
  assert.equal(s2.getView().problem, cloudErrorText("unauthorized"));
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(bad.log.afters.length, 1, "身份不对不无限重连");
  s2.close();
});

test("CAU-SES-04 文字增量攒批后折进去,与逐条折相同", async () => {
  const store = memStore();
  const deltas = [{ type: "user", seq: 1, runId: "r", prompt: "x" }, ...Array.from({ length: 50 }, (_, i) => ({ type: "text", seq: 2 + i, runId: "r", delta: `字${i}` })), { type: "end", seq: 52, runId: "r", state: "idle" }];
  const { api } = fakeApi([{ events: deltas, then: "hang" }]);
  const s = createCloudSession({ api, store, flushMs: 20 });
  s.open("c-1");
  await waitFor(() => store.get()[1]?.pending === false);
  assert.equal(store.get()[1].text, Array.from({ length: 50 }, (_, i) => `字${i}`).join(""));
  s.close();
});

test("CAU-EP-01 「云端」出不出现:放本机的项目没有,文档服务报了才有,开关关了置灰,在线页面地址固定", () => {
  setCloudAgentSource(null);
  clearHostedAgent();
  delete globalThis.__pcCloudAgent;
  const desk = (projectId, hostedWhere = true) => resolveCloudAgent({ projectId, hostedWhere, online: false });
  assert.deepEqual(desk(null), CLOUD_OFF, "没连共享项目");
  assert.deepEqual(desk("p1", false), CLOUD_OFF, "共享在局域网上(不是托管端)");
  assert.deepEqual(desk("p1"), CLOUD_OFF, "文档服务没报");
  setHostedAgent("p1", { available: true, enabled: true, url: "https://node.example/agent/v1/" });
  assert.deepEqual(desk("p1"), { available: true, enabled: true, url: "https://node.example/agent/v1" });
  assert.deepEqual(desk("p2"), CLOUD_OFF, "报的是别的项目,不算数");
  setHostedAgentEnabled("p1", false);
  assert.deepEqual(desk("p1"), { available: true, enabled: false, url: "https://node.example/agent/v1" }, "开关关了:在,但 enabled 为假");
  setHostedAgent("p1", { available: false, enabled: true, url: "https://node.example/agent/v1" });
  assert.deepEqual(desk("p1"), CLOUD_OFF, "托管端没有云端 Agent");
  clearHostedAgent();
  // 可注入来源只在文档服务没给时、连着托管端的项目上才算
  globalThis.__pcCloudAgent = { available: true, enabled: true, url: "http://127.0.0.1:8778/v1" };
  assert.deepEqual(desk("p1"), { available: true, enabled: true, url: "http://127.0.0.1:8778/v1" });
  assert.deepEqual(desk("p1", false), CLOUD_OFF);
  assert.deepEqual(desk(null), CLOUD_OFF);
  delete globalThis.__pcCloudAgent;
  // 在线页面:同源的 /agent/v1,一直在
  assert.deepEqual(resolveCloudAgent({ projectId: "p1", hostedWhere: true, online: true, origin: "https://h.example" }), { available: true, enabled: true, url: "https://h.example/agent/v1" });
  setHostedAgent("p1", { available: true, enabled: false, url: null });
  assert.equal(resolveCloudAgent({ projectId: "p1", hostedWhere: true, online: true, origin: "https://h.example" }).enabled, false);
  clearHostedAgent();
});

test("CAU-API-01 请求带票据与对话委托、不带 Cookie;错误码换成人话;info 与列表容错", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (String(url).endsWith("/info")) return Response.json({ ok: true, enabled: true, models: ["m1", { id: "m2", label: "二号" }, 5], defaultModel: "m1", running: ["c-a", 3], limits: { rounds: 24, runMs: 1800000 } });
    if (String(url).endsWith("/conversations")) return Response.json({ ok: true, items: [{ id: "c-a", state: "running", lastSeq: 7 }, { nope: 1 }, { id: "c-b", title: "标题", state: "weird", updatedAt: 5 }] });
    if (String(url).includes("/messages")) return Response.json({ ok: true, runId: "r9", seq: 3 }, { status: 202 });
    if (String(url).includes("/abort")) return Response.json({ ok: true });
    return Response.json({ ok: false, code: "disabled", message: "x" }, { status: 403 });
  };
  const api = createCloudApi({ baseUrl: () => "https://h.example/agent/v1", ticket: async () => "TICKET", grant: async (id) => `GRANT-${id}`, fetchImpl });
  const info = await api.info();
  assert.deepEqual(info.models, [{ id: "m1" }, { id: "m2", label: "二号" }]);
  assert.deepEqual(info.running, ["c-a"]);
  assert.equal(info.limits.rounds, 24);
  const items = await api.list();
  assert.deepEqual(items.map((x) => [x.id, x.state, x.title]), [["c-a", "running", "云端对话"], ["c-b", "idle", "标题"]]);
  const sent = await api.send("c-a", { prompt: "你好", pageState: { t: 1.5, selection: ["c1"] } });
  assert.deepEqual(sent, { runId: "r9", seq: 3 });
  const post = calls.find((c) => c.url.includes("/messages"));
  assert.equal(post.init.headers.Authorization, "Bearer TICKET");
  assert.equal(post.init.credentials, "omit");
  assert.deepEqual(JSON.parse(post.init.body), { prompt: "你好", pageState: { t: 1.5, selection: ["c1"] }, grant: "GRANT-c-a" });
  assert.equal(post.url, "https://h.example/agent/v1/conversations/c-a/messages");
  await api.abort("c-a");
  for (const c of calls) assert.equal(c.init.headers.Authorization, "Bearer TICKET", "每个请求都带票据");
  await assert.rejects(() => createCloudApi({ baseUrl: () => "https://h.example/agent/v1", ticket: async () => "T", fetchImpl }).events("c-a", 0).next(), (e) => e instanceof CloudError && e.code === "disabled" && e.message === "项目创建者已关闭云端 Agent。");
  // 错误码
  for (const code of ["unauthorized", "no-identity", "forbidden", "disabled", "busy", "busy-conversation", "quota-exceeded", "no-model-key", "too-large", "bad-grant", "unavailable", "network"]) {
    assert.ok(cloudErrorText(code).length > 4, code);
  }
  assert.equal(cloudErrorText("quota-exceeded", "额度 100 万已用完"), "额度 100 万已用完");
  assert.deepEqual(normalizeInfo({}), { enabled: true, models: [], defaultModel: null, running: [], limits: { rounds: undefined, runMs: undefined } });
  assert.equal(normalizeChatItem({}), null);
});

test("CAU-ID-01 身份是可注入的接口位:没注入且没有替身时抛 no-identity,请求一个都不发", async () => {
  setCloudIdentity(null);
  delete globalThis.__pcCloudIdentity;
  await assert.rejects(() => cloudTicket(), (e) => e instanceof CloudIdentityError);
  let fetched = 0;
  const api = createCloudApi({ baseUrl: () => "https://h.example/agent/v1", fetchImpl: async () => { fetched++; return Response.json({}); } });
  await assert.rejects(() => api.info(), (e) => e instanceof CloudError && e.code === "no-identity");
  assert.equal(fetched, 0);
  setCloudIdentity({ getTicket: () => "T1", getGrant: (id) => `G-${id}` });
  assert.equal(await cloudTicket(), "T1");
  assert.equal(await cloudGrant("c"), "G-c");
  setCloudIdentity(null);
  globalThis.__pcCloudIdentity = { getTicket: async () => "STUB" };
  assert.equal(await cloudTicket(), "STUB");
  assert.equal(await cloudGrant("c"), undefined);
  delete globalThis.__pcCloudIdentity;
});

test("CAU-SES-05 服务端的对话从头开始了(seq 比页面看到的还小):掐掉旧流、从 0 重读,新的一轮照样显示", async () => {
  const store = memStore();
  const log = { afters: [], sent: 0 };
  const second = [
    { type: "user", seq: 1, runId: "r-new", prompt: "撤销之后再来" },
    { type: "text", seq: 2, runId: "r-new", delta: "又能说了" },
    { type: "end", seq: 3, runId: "r-new", state: "idle" },
  ];
  let conn = 0;
  const api = {
    async send() { log.sent++; return { runId: "r-new", seq: 1 }; },
    async abort() {},
    async *events(_id, after, signal) {
      log.afters.push(after);
      conn++;
      if (conn === 1) {
        for (const ev of run1) yield ev;
        await new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true })); // 旧流:挂着,等不到任何新事件
        return;
      }
      for (const ev of second) yield ev;
      await new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true }));
    },
  };
  const s = createCloudSession({ api, store, flushMs: 0, backoff: () => 5 });
  s.open("c-1");
  await waitFor(() => s.getView().lastSeq === 9);
  await s.send({ prompt: "撤销之后再来" });
  await waitFor(() => store.get().length === 4 && store.get()[3].outcome === "completed");
  assert.deepEqual(log.afters, [0, 0], "第二条连接从 0 起");
  assert.equal(store.get()[3].text, "又能说了");
  assert.equal(store.get()[1].text, "改好了", "旧的消息还在");
  assert.equal(s.getView().lastSeq, 3);
  s.close();
});
