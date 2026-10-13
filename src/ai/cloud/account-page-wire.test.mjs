/**
 * 账号模式下页面这一侧反向通道的接线(0.7.18 工具表接线):会话控制器(`session.ts`)与唯一的接线入口(`accountPage.ts`)。
 * 跑:npm test -- src/ai/cloud/account-page-wire.test.mjs
 *
 *   CAU-WIRE-01  账号模式:开事件流时报的是在场页面号(每次现取);执行器的答案原样交回(页面号、一次性随机数、版本号都不改);发消息不另报页面号
 *   CAU-WIRE-02  在场页面号变了(重连了文档服务):`syncPage()` 掐掉旧流,用新的页面号重开;没变不动
 *   CAU-WIRE-03  旧通道(非账号模式)不变:页面自己起的页面号写进交回的请求体与发消息的请求体
 *   CAU-WIRE-04  接线入口按请求的种类分流:播放头与网页接管给一个执行器,采集的委托与登录给另一个;网页版没有本机采集与浏览器,如实回做不了
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createCloudSession } from "./session.ts";
import { createAccountPageHandler } from "./accountPage.ts";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check, ms = 3000) => { const end = Date.now() + ms; for (;;) { if (check()) return; if (Date.now() > end) throw new Error("等不到"); await sleep(5); } };
const NONCE = "nonce-0123456789abcdef";
const request = (over = {}) => ({ type: "page.request", v: 2, id: "AbCdEfGhIjKlMnOpQrStUv", nonce: NONCE, runId: "run-1", pageId: "presence-page-1", tool: "seek", args: { t: 3 }, timeoutMs: 15000, ...over });

function fakeStore() {
  let value = [];
  const listeners = new Set();
  return { get: () => value, set(next) { value = typeof next === "function" ? next(value) : next; for (const l of [...listeners]) l(); }, subscribe(l) { listeners.add(l); return () => listeners.delete(l); } };
}

/** 一条可以往里推事件的假事件流:每开一次记一笔(带着的页面号),中止信号来了就结束 */
function fakeApi() {
  const opened = [], results = [], sent = [];
  let push = null;
  return {
    opened, results, sent,
    push: (ev) => push?.(ev),
    api: {
      async send(_id, body) { sent.push(body); return { runId: "run-1", seq: 1 }; },
      async abort() {},
      async pageResult(id, body) { results.push({ id, body }); },
      async *events(_id, after, signal, pageId) {
        opened.push({ after, pageId });
        const queue = []; let wake = null;
        push = (ev) => { queue.push(ev); wake?.(); };
        const onAbort = () => wake?.();
        signal?.addEventListener("abort", onAbort);
        try {
          for (;;) {
            while (queue.length) yield queue.shift();
            if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
            await new Promise((resolve) => { wake = resolve; });
            wake = null;
          }
        } finally { signal?.removeEventListener("abort", onAbort); }
      },
    },
  };
}

test("CAU-WIRE-01 账号模式:事件流报在场页面号;执行器的答案原样交回;发消息不另报页面号", async () => {
  const f = fakeApi();
  const calls = [];
  const handler = createAccountPageHandler({ pageId: () => "presence-page-1", exec: { seek: (a) => { calls.push(a); return { ok: true }; }, play: () => ({ ok: true }), pause: () => ({ ok: true }) } });
  const session = createCloudSession({ api: f.api, store: fakeStore(), accountMode: true, flushMs: 0, backoff: () => 5, pageId: () => "presence-page-1", onPageRequest: (ev) => handler(ev) });
  session.open("conv-1");
  await until(() => f.opened.length === 1);
  assert.deepEqual(f.opened[0], { after: 0, pageId: "presence-page-1" });
  f.push(request());
  await until(() => f.results.length === 1);
  assert.deepEqual(calls, [{ t: 3 }]);
  assert.deepEqual(f.results[0], { id: "conv-1", body: { v: 2, id: "AbCdEfGhIjKlMnOpQrStUv", nonce: NONCE, pageId: "presence-page-1", runId: "run-1", ok: true, result: { ok: true } } });
  // 同一条请求重复到达:只执行一次、只交一次
  f.push(request());
  await sleep(30);
  assert.equal(calls.length, 1); assert.equal(f.results.length, 1);
  // 不是发给这张页面的(页面号不同):不执行也不答
  f.push(request({ id: "ZyXwVuTsRqPoNmLkJiHgFe", pageId: "someone-else" }));
  await sleep(30);
  assert.equal(calls.length, 1); assert.equal(f.results.length, 1);
  await session.send({ prompt: "你好" });
  assert.deepEqual(f.sent, [{ prompt: "你好" }], "账号模式的页面号由文档服务从选区快照里取,发消息的请求体里不另报");
  session.close();
});

test("CAU-WIRE-02 在场页面号变了:syncPage 让事件流带着新的页面号重开;没变不动", async () => {
  const f = fakeApi();
  let page = null;
  const session = createCloudSession({ api: f.api, store: fakeStore(), accountMode: true, flushMs: 0, backoff: () => 5, pageId: () => page, onPageRequest: async () => null });
  session.open("conv-1");
  await until(() => f.opened.length === 1);
  assert.equal(f.opened[0].pageId, undefined, "还没连上文档服务:这条流只是看");
  session.syncPage();
  await sleep(30);
  assert.equal(f.opened.length, 1, "页面号没变不重开");
  page = "presence-page-2";
  session.syncPage();
  await until(() => f.opened.length === 2);
  assert.equal(f.opened[1].pageId, "presence-page-2");
  session.syncPage();
  await sleep(30);
  assert.equal(f.opened.length, 2);
  session.close();
});

test("CAU-WIRE-03 旧通道不变:页面自己起的页面号写进交回与发消息的请求体", async () => {
  const f = fakeApi();
  const session = createCloudSession({ api: f.api, store: fakeStore(), flushMs: 0, backoff: () => 5, pageId: "pg-legacy-12345678",
    onPageRequest: async (ev) => ({ id: String(ev.id), ok: true, result: { ok: true } }) });
  session.open("conv-1");
  await until(() => f.opened.length === 1);
  assert.equal(f.opened[0].pageId, "pg-legacy-12345678");
  f.push({ type: "page.request", id: "legacy-request-1", tool: "play", args: {} });
  await until(() => f.results.length === 1);
  assert.deepEqual(f.results[0].body, { id: "legacy-request-1", ok: true, result: { ok: true }, pageId: "pg-legacy-12345678" });
  await session.send({ prompt: "你好" });
  assert.deepEqual(f.sent, [{ prompt: "你好", pageId: "pg-legacy-12345678" }]);
  session.syncPage();
  await sleep(20);
  assert.equal(f.opened.length, 1, "非账号模式没有 syncPage 这回事");
  session.close();
});

test("CAU-WIRE-04 接线入口分流;网页版(没有本机采集与浏览器)如实回做不了", async () => {
  const handler = createAccountPageHandler({ pageId: () => "presence-page-1", exec: { seek: () => ({ ok: true }), play: () => ({ ok: true }), pause: () => ({ ok: true }) } });
  const handoff = await handler(request({ tool: "web_handoff", args: { reason: "登录", url: "https://example.com/" } }));
  assert.deepEqual([handoff.ok, handoff.code, handoff.pageId, handoff.nonce], [false, "unsupported", "presence-page-1", NONCE]);
  const login = await handler(request({ id: "CollectLoginRequest01", tool: "collect_login", args: { site: "bilibili", method: "qr" } }));
  assert.equal(login.ok, false); assert.equal(login.pageId, "presence-page-1");
  assert.equal(JSON.stringify(login).includes("path"), false);
  const unknown = await handler(request({ id: "UnknownToolRequest001", tool: "get_selection", args: {} }));
  assert.equal(unknown.ok, false, "读选区不走这条通道");
  assert.equal(await handler(request({ id: "NotMinePageRequest001", pageId: "other" })), null);
});
