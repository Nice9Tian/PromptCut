/**
 * 账号模式下页面这一侧反向通道的接线(0.7.18 工具表接线):会话控制器(`session.ts`)与唯一的接线入口(`accountPage.ts`)。
 * 跑:npm test -- src/ai/cloud/account-page-wire.test.mjs
 *
 *   CAU-WIRE-01  账号模式:开事件流时报的是在场页面号(每次现取);执行器的答案原样交回(页面号、一次性随机数、版本号都不改);发消息不另报页面号
 *   CAU-WIRE-02  在场页面号变了(重连了文档服务):`syncPage()` 掐掉旧流,用新的页面号从读到的位置接着读;没变不动;
 *                这不是断线:正文不清、不显示「重连中」、不退避;重开没成才照普通断线办
 *   CAU-WIRE-03  旧通道(非账号模式)不变:页面自己起的页面号写进交回的请求体与发消息的请求体
 *   CAU-WIRE-04  接线入口按请求的种类分流:播放头与网页接管给一个执行器,采集的委托与登录给另一个;网页版没有本机采集与浏览器,如实回做不了
 *   CAU-WIRE-05  代下:云端超过若干秒不来问(任务被停、进程被关,取消发不过来),页面自己停掉本机的下载;下好了还没传的不再传;
 *                已经交给上传队列的请上传一侧撤回;云端一直来问就不停
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createCloudSession } from "./session.ts";
import { createAccountPageHandler } from "./accountPage.ts";
import { createCollectBridgePage } from "./collectBridge.ts";

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

test("CAU-WIRE-02 在场页面号变了:syncPage 让事件流带着新的页面号接着读;正文不清、不显示重连;没变不动", async () => {
  const f = fakeApi();
  let page = null;
  const store = fakeStore();
  // 退避给得很长:要是走了普通断线那条路(退避后才重开),下面等不到第二次开流
  const session = createCloudSession({ api: f.api, store, accountMode: true, flushMs: 0, backoff: () => 60_000, pageId: () => page, onPageRequest: async () => null });
  const connections = [];
  session.subscribe(() => { const c = session.getView().connection; if (connections[connections.length - 1] !== c) connections.push(c); });
  session.open("conv-1");
  await until(() => f.opened.length === 1);
  assert.equal(f.opened[0].pageId, undefined, "还没连上文档服务:这条流只是看");
  // 读到两条正文
  f.push({ type: "user", seq: 1, runId: "run-1", prompt: "你好" });
  f.push({ type: "text", seq: 2, runId: "run-1", delta: "我" });
  await until(() => session.getView().lastSeq === 2 && session.getView().connection === "live");
  const before = store.get();
  assert.ok(before.length >= 1, "正文读到了");
  session.syncPage();
  await sleep(30);
  assert.equal(f.opened.length, 1, "页面号没变不重开");
  connections.length = 0;
  page = "presence-page-2";
  session.syncPage();
  await until(() => f.opened.length === 2);
  assert.deepEqual(f.opened[1], { after: 2, pageId: "presence-page-2" }, "带着新页面号,从刚才读到的位置接着读(不是从头)");
  assert.equal(store.get(), before, "正文原样留着:对话 store 没有被清、没有被换");
  assert.equal(session.getView().lastSeq, 2);
  // 新流上接着来的事件照常折进去;界面上一直是「连着」,没有闪过「连接中 / 重连中」
  f.push({ type: "text", seq: 3, runId: "run-1", delta: "在" });
  await until(() => session.getView().lastSeq === 3);
  assert.deepEqual(connections.filter((c) => c !== "live"), [], `换页面号期间出现了 ${connections.join(",")}`);
  assert.equal(session.getView().problem, null);
  session.syncPage();
  await sleep(30);
  assert.equal(f.opened.length, 2);
  session.close();
});

test("CAU-WIRE-02 换页面号时重开没成:照普通断线办(清正文、显示重连),不带着旧正文装作连着", async () => {
  const f = fakeApi();
  let page = "presence-page-1";
  const store = fakeStore();
  let failNext = false;
  const events = f.api.events;
  const api = { ...f.api, async *events(...args) { if (failNext) { failNext = false; f.opened.push({ failed: true }); throw new Error("network down"); } yield* events(...args); } };
  const session = createCloudSession({ api, store, accountMode: true, flushMs: 0, backoff: () => 5, pageId: () => page, onPageRequest: async () => null });
  session.open("conv-1");
  await until(() => f.opened.length === 1);
  f.push({ type: "user", seq: 1, runId: "run-1", prompt: "你好" });
  await until(() => session.getView().lastSeq === 1);
  const seen = [];
  session.subscribe(() => seen.push(session.getView().connection));
  page = "presence-page-2"; failNext = true;
  session.syncPage();
  await until(() => f.opened.length === 3);
  assert.equal(f.opened[1].failed, true);
  assert.deepEqual(f.opened[2], { after: 0, pageId: "presence-page-2" }, "断线之后从头重放");
  assert.ok(seen.includes("reconnecting"), "真断了才显示重连");
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

/* ---------- 代下:云端不来问了就停 ---------- */

/** 一套可拨时钟的本机采集与上传:下载、上传各自由测试推进 */
function collectKit({ quietMs = 30_000 } = {}) {
  let clock = 1_000_000;
  const log = [];
  const jobs = new Map();
  const stored = new Set();
  const sleepers = [];
  const local = {
    status: async () => ({ ready: true }),
    cookies: async () => ({ bilibili: { loggedIn: true, path: "C:\\secret\\cookies.txt" } }),
    download: async () => { const jobId = `local-${jobs.size + 1}`; jobs.set(jobId, { status: "running", stage: "video", percent: 10 }); log.push(`download:${jobId}`); return { jobId }; },
    job: async (jobId) => { kit.onJob?.(); return jobs.get(jobId) ?? null; },
    cancel: async (jobId) => { log.push(`cancel:${jobId}`); jobs.set(jobId, { status: "error" }); },
    login: async () => ({ ok: true }),
    loginCheck: async () => ({ ok: true, loggedIn: true }),
  };
  const upload = {
    projectId: () => "project-1",
    push: async (items) => { log.push(`push:${items.map((it) => it.hash.slice(0, 4)).join(",")}`); return true; },
    stored: async (hash) => stored.has(hash),
    cancel: async (hashes) => { log.push(`withdraw:${hashes.map((h) => h.slice(0, 4)).join(",")}`); },
  };
  const page = createCollectBridgePage({ pageId: () => "presence-page-1", local, upload, quietMs, pollMs: 1000, now: () => clock,
    // 页面自己的轮询由测试一步一步放行:每放一步,时钟走一秒
    sleep: () => new Promise((resolve) => { sleepers.push(resolve); }) });
  let n = 0;
  const ask = (tool, args) => page.run({ type: "page.request", v: 2, id: `CollectRequest${String(++n).padStart(8, "0")}`, nonce: NONCE, runId: "run-1", pageId: "presence-page-1", tool, args, timeoutMs: 15000 });
  /** 让页面的轮询走 `seconds` 步(每步一秒) */
  const tick = async (seconds) => { for (let i = 0; i < seconds; i++) { await sleep(1); clock += 1000; sleepers.splice(0).forEach((resolve) => resolve()); await sleep(1); } };
  const DELEGATION = "cd-0123456789abcdef01234567";
  const start = () => ask("collect_delegate_start", { delegationId: DELEGATION, jobId: "job-0001", projectId: "project-1", url: "https://www.bilibili.com/video/BV1xx", site: "bilibili", quality: 1080 });
  const poll = () => ask("collect_delegate_poll", { delegationId: DELEGATION });
  const kit = { page, log, jobs, stored, ask, tick, start, poll, onJob: null, advance: (ms) => { clock += ms; } };
  return kit;
}

test("CAU-WIRE-05 代下:云端不来问了,页面自己停掉本机的下载;之后再来问得到「没做成」", async () => {
  const k = collectKit({ quietMs: 30_000 });
  assert.deepEqual((await k.start()).result, { accepted: true });
  // 云端照常每隔几秒来问:一直问就一直下,过了三十秒也不停
  for (let i = 0; i < 20; i++) { await k.tick(2); assert.equal((await k.poll()).result.state, "running"); }
  assert.deepEqual(k.log, ["download:local-1"], "有人问就不停");
  // 云端那条任务没了(取消发不过来):三十秒没人问
  await k.tick(29);
  assert.equal(k.log.includes("cancel:local-1"), false, "还没到时限");
  await k.tick(3);
  assert.equal(k.log.includes("cancel:local-1"), true, "到时限:本机的下载被停掉");
  assert.equal(k.log.some((row) => row.startsWith("push:")), false, "没有往项目的素材服务传任何东西");
  assert.equal(k.page.describe().running, 0);
  const late = await k.poll();
  assert.deepEqual([late.ok, late.result.state, late.result.code], [true, "error", "abandoned"]);
  assert.equal(JSON.stringify(late).includes("secret"), false);
});

test("CAU-WIRE-05 代下:下载的时候云端已经不等了,下好的文件不再往项目里传", async () => {
  const k = collectKit({ quietMs: 30_000 });
  await k.start();
  // 本机查作业这一步卡了很久才回(期间没人来问),回来时下载已经做完
  k.jobs.set("local-1", { status: "done", items: [{ filename: "C:\\dl\\clip.mp4", hash: "a".repeat(64), bytes: 1234 }] });
  k.onJob = () => { k.onJob = null; k.advance(40_000); };
  await k.tick(1);
  await until(() => k.page.describe().running === 0);
  assert.equal(k.log.some((row) => row.startsWith("push:")), false, "下好了也不传");
  assert.equal(k.log.some((row) => row.startsWith("cancel:")), false, "下载已经做完,没有要停的");
  assert.equal((await k.poll()).result.state, "error");
});

test("CAU-WIRE-05 代下:已经交给上传队列之后云端不来问了,请上传一侧撤回;一直来问就照常做完", async () => {
  const k = collectKit({ quietMs: 30_000 });
  await k.start();
  k.jobs.set("local-1", { status: "done", cookiesUsed: true, items: [{ filename: "clip.mp4", hash: "b".repeat(64), bytes: 4321 }] });
  await k.tick(1);
  await until(() => k.log.some((row) => row.startsWith("push:")));
  for (let i = 0; i < 20; i++) { await k.tick(2); assert.equal((await k.poll()).result.state, "running"); }
  assert.equal(k.log.some((row) => row.startsWith("withdraw:")), false, "有人问就接着等上传");
  await k.tick(32);
  await until(() => k.page.describe().running === 0);
  assert.deepEqual(k.log.filter((row) => row.startsWith("withdraw:")), ["withdraw:bbbb"]);
  assert.equal((await k.poll()).result.code, "abandoned");

  // 对照:一直来问、上传也齐了 → 照常交回回执
  const ok = collectKit({ quietMs: 30_000 });
  await ok.start();
  ok.jobs.set("local-1", { status: "done", cookiesUsed: true, items: [{ filename: "clip.mp4", hash: "c".repeat(64), bytes: 99 }] });
  await ok.tick(1);
  await until(() => ok.log.some((row) => row.startsWith("push:")));
  ok.stored.add("c".repeat(64));
  await ok.tick(1);
  let done = null;
  for (let i = 0; i < 5 && !done; i++) { const r = await ok.poll(); if (r.result.state === "done") done = r.result; else await ok.tick(1); }
  assert.equal(done?.receipt?.assetRef?.hash, "c".repeat(64));
  assert.equal(ok.log.some((row) => row.startsWith("withdraw:") || row.startsWith("cancel:")), false);
});
