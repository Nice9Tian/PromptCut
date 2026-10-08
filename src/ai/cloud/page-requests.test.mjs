/**
 * 反向通道在页面这一侧(契约 `docs/plan/cloud-agent-contract.md` 第 28 节)。
 * 跑:node --test src/ai/cloud/page-requests.test.mjs
 *
 *   CAU-REV-01  白名单:四种请求各自调到本机那一份实现,前后各调一次「Agent 在操作」的钩子;别的工具名一律拒绝、什么都不执行;
 *   CAU-REV-02  参数按本机同样的规矩查:`seek` 没给 `t` 回本机那句「缺少必填参数」,负数、不是数被拒;多带的字段不往下传;
 *               不是 `page.request`、没有合格 `id` 的不答;实现抛错只回一句原因;
 *   CAU-REV-03  会话:发消息与开事件流都报页面号;事件流里来的 `page.request` 执行一次并带着页面号交回,不折进消息、不动 `lastSeq`;
 *               同一个 id 重复到达只执行一次;
 *   CAU-REV-04  会话:没给页面号或没给执行函数(只看不动的页面)时不报页面号、不执行、不交回;关掉会话或换了对话之后到的结果不交回;
 *   CAU-REV-05  对账:页面的白名单与服务端经反向通道的工具表是同一组;
 *   CAU-REV-06  守门:页面上触发执行的入口只有事件流这一处——`src/` 里引用 `runPageRequest` 的只有接线的那一个文件,
 *               `pageRequests.ts` 自己不挂全局、不听 `postMessage` 与自定义事件;接口层带委托票据交回。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLOUD_PAGE_REQUEST_TOOLS, PAGE_ID_RE, newPageId, runPageRequest } from "./pageRequests.ts";
import { createCloudSession } from "./session.ts";
import { createCloudApi } from "./cloudApi.ts";
import { CLOUD_PAGE_TOOLS } from "../../../server/agent/service/cloud-tools.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "..", "..");
const ID = "AbCdEfGhIjKlMnOpQrStUv";

function fakeExec() {
  const calls = [];
  return {
    calls,
    seek: (args) => { calls.push(["seek", args]); return { ok: true }; },
    play: () => { calls.push(["play"]); return { ok: true }; },
    pause: () => { calls.push(["pause"]); return { ok: true }; },
    getSelection: () => { calls.push(["getSelection"]); return { id: "c1", trackId: "t1", clip: { id: "c1" } }; },
    begin: () => calls.push(["begin"]),
    end: () => calls.push(["end"]),
  };
}

function memStore() {
  let messages = [];
  const ls = new Set();
  return {
    get: () => messages,
    set(next) { messages = typeof next === "function" ? next(messages) : next; for (const l of [...ls]) l(); },
    subscribe(l) { ls.add(l); return () => ls.delete(l); },
  };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test("CAU-REV-01 白名单:四种各调到本机的实现;别的一律拒绝、什么都不执行", async () => {
  const exec = fakeExec();
  assert.deepEqual(await runPageRequest({ type: "page.request", id: ID, tool: "seek", args: { t: 2.5 } }, exec), { id: ID, ok: true, result: { ok: true } });
  assert.deepEqual(await runPageRequest({ type: "page.request", id: ID, tool: "play", args: {} }, exec), { id: ID, ok: true, result: { ok: true } });
  assert.deepEqual(await runPageRequest({ type: "page.request", id: ID, tool: "pause" }, exec), { id: ID, ok: true, result: { ok: true } });
  assert.deepEqual(await runPageRequest({ type: "page.request", id: ID, tool: "get_selection", args: {} }, exec), { id: ID, ok: true, result: { id: "c1", trackId: "t1", clip: { id: "c1" } } });
  assert.deepEqual(exec.calls, [
    ["begin"], ["seek", { t: 2.5 }], ["end"],
    ["begin"], ["play"], ["end"],
    ["begin"], ["pause"], ["end"],
    ["begin"], ["getSelection"], ["end"],
  ]);
  // 没有选中:本机回 null,这里也回 null
  const none = { ...fakeExec(), getSelection: () => null };
  assert.deepEqual(await runPageRequest({ type: "page.request", id: ID, tool: "get_selection" }, none), { id: ID, ok: true, result: null });

  const strict = fakeExec();
  for (const tool of ["remove_clip", "update_clip", "set_project_meta", "web_handoff", "collect_login", "spawn_agent", "import_media", "create_card", "toString", "constructor", "__proto__", "", "SEEK", "seek "]) {
    const out = await runPageRequest({ type: "page.request", id: ID, tool, args: { t: 1, clipId: "c1" } }, strict);
    assert.equal(out.ok, false, tool);
    assert.equal(out.id, ID);
    assert.match(out.error, /这个页面不执行/);
  }
  assert.equal((await runPageRequest({ type: "page.request", id: ID, tool: 42 }, strict)).ok, false);
  assert.deepEqual(strict.calls, [], "白名单之外的什么都没执行,连钩子都没调");
});

test("CAU-REV-02 参数的规矩、不合格的请求不答、实现抛错只回原因", async () => {
  const exec = fakeExec();
  assert.deepEqual(await runPageRequest({ type: "page.request", id: ID, tool: "seek", args: {} }, exec), { id: ID, ok: false, error: "缺少必填参数：t。请补齐后重试。" });
  assert.equal((await runPageRequest({ type: "page.request", id: ID, tool: "seek" }, exec)).ok, false);
  assert.equal((await runPageRequest({ type: "page.request", id: ID, tool: "seek", args: [3] }, exec)).ok, false);
  for (const t of [-1, "3", Number.NaN, Infinity, null, {}, true]) {
    assert.equal((await runPageRequest({ type: "page.request", id: ID, tool: "seek", args: { t } }, exec)).ok, false, String(t));
  }
  assert.deepEqual(exec.calls, [], "不合规矩的一次都没执行");
  await runPageRequest({ type: "page.request", id: ID, tool: "seek", args: { t: 0, clipId: "c1", project: { tracks: [] } } }, exec);
  assert.deepEqual(exec.calls[1], ["seek", { t: 0 }], "多带的字段不往下传");
  // 不是请求、id 不合格:不答
  for (const ev of [null, { type: "tool_call", id: ID, tool: "seek", args: { t: 1 } }, { type: "page.request", tool: "play" }, { type: "page.request", id: 7, tool: "play" }, { type: "page.request", id: "短", tool: "play" }, { type: "page.request", id: "../../etc/passwd", tool: "play" }]) {
    assert.equal(await runPageRequest(ev, exec), null);
  }
  const boom = { ...fakeExec(), play: () => { throw new Error("播放器坏了"); } };
  assert.deepEqual(await runPageRequest({ type: "page.request", id: ID, tool: "play" }, boom), { id: ID, ok: false, error: "播放器坏了" });
  assert.deepEqual(boom.calls, [["begin"], ["end"]], "抛错也收尾");
  // 页面号的形状
  const a = newPageId();
  assert.match(a, PAGE_ID_RE);
  assert.notEqual(a, newPageId());
});

/** 假的接口层:事件由测试往里推 */
function fakeApi() {
  const calls = { send: [], events: [], pageResult: [], abort: 0 };
  let push = null;
  let finish = null;
  return {
    calls,
    emit: (ev) => push?.(ev),
    drop: () => finish?.(),
    api: {
      async send(id, body) { calls.send.push([id, body]); return { runId: "r1", seq: 1 }; },
      async abort() { calls.abort += 1; },
      async pageResult(id, body) { calls.pageResult.push([id, body]); },
      async *events(id, after, signal, pageId) {
        calls.events.push([id, after, pageId]);
        const queue = [];
        let wake = null;
        let done = false;
        push = (ev) => { queue.push(ev); wake?.(); };
        finish = () => { done = true; wake?.(); };
        signal?.addEventListener("abort", () => { done = true; wake?.(); });
        for (;;) {
          while (queue.length) yield queue.shift();
          if (done) return;
          await new Promise((r) => { wake = r; });
          wake = null;
        }
      },
    },
  };
}

test("CAU-REV-03 会话:报页面号;事件流里的请求执行一次并交回,不折进消息、不动 lastSeq;重复的只执行一次", async () => {
  const f = fakeApi();
  const store = memStore();
  const exec = fakeExec();
  const session = createCloudSession({ api: f.api, store, flushMs: 0, backoff: () => 5, pageId: "pg-0123456789abcdef", onPageRequest: (ev) => runPageRequest(ev, exec) });
  session.open("c-a");
  await tick(5);
  assert.deepEqual(f.calls.events[0], ["c-a", 0, "pg-0123456789abcdef"]);
  await session.send({ prompt: "跳到第 3 秒" });
  assert.deepEqual(f.calls.send[0], ["c-a", { prompt: "跳到第 3 秒", pageId: "pg-0123456789abcdef" }]);
  f.emit({ type: "user", seq: 1, runId: "r1", prompt: "跳到第 3 秒" });
  f.emit({ type: "tool_call", seq: 2, runId: "r1", name: "seek", callId: "k1", input: { t: 3 } });
  await tick(5);
  const before = JSON.stringify(store.get());
  f.emit({ type: "page.request", id: ID, runId: "r1", tool: "seek", args: { t: 3 }, timeoutMs: 15000 });
  f.emit({ type: "page.request", id: ID, runId: "r1", tool: "seek", args: { t: 3 }, timeoutMs: 15000 });
  await tick(10);
  assert.deepEqual(exec.calls, [["begin"], ["seek", { t: 3 }], ["end"]], "同一个 id 只执行一次");
  assert.deepEqual(f.calls.pageResult, [["c-a", { id: ID, ok: true, result: { ok: true }, pageId: "pg-0123456789abcdef" }]]);
  assert.equal(JSON.stringify(store.get()), before, "不折进消息");
  assert.equal(session.getView().lastSeq, 2, "不动 lastSeq");
  // 这一步在 AI 栏里照本机的样子显示:靠的是 tool_call / tool_result 这两条普通事件
  f.emit({ type: "tool_result", seq: 3, runId: "r1", name: "seek", callId: "k1", ok: true, summary: "ok" });
  await tick(5);
  const tool = store.get()[1].parts.find((p) => p.kind === "tool");
  assert.deepEqual([tool.name, tool.ok], ["seek", true]);
  // 白名单之外的:回拒绝,不执行
  f.emit({ type: "page.request", id: `${ID}x`, runId: "r1", tool: "remove_clip", args: { clipId: "c1" } });
  await tick(10);
  assert.equal(f.calls.pageResult[1][1].ok, false);
  assert.equal(exec.calls.length, 3);
  session.close();
});

test("CAU-REV-04 只看不动的页面不报页面号、不执行;关掉或换了对话之后的结果不交回", async () => {
  // 没给执行函数
  const f1 = fakeApi();
  const s1 = createCloudSession({ api: f1.api, store: memStore(), flushMs: 0, backoff: () => 5, pageId: "pg-0123456789abcdef" });
  s1.open("c-a");
  await tick(5);
  assert.deepEqual(f1.calls.events[0], ["c-a", 0, undefined]);
  await s1.send({ prompt: "你好" });
  assert.deepEqual(f1.calls.send[0], ["c-a", { prompt: "你好" }]);
  f1.emit({ type: "page.request", id: ID, tool: "play", args: {} });
  await tick(10);
  assert.deepEqual(f1.calls.pageResult, []);
  s1.close();

  // 执行到一半换了对话:结果不交回(不会交到新对话上)
  const f2 = fakeApi();
  let release = null;
  const s2 = createCloudSession({ api: f2.api, store: memStore(), flushMs: 0, backoff: () => 5, pageId: "pg-0123456789abcdef", onPageRequest: (ev) => new Promise((r) => { release = () => r({ id: ev.id, ok: true, result: { ok: true } }); }) });
  s2.open("c-a");
  await tick(5);
  f2.emit({ type: "page.request", id: ID, tool: "play", args: {} });
  await tick(5);
  s2.open("c-b");
  release();
  await tick(10);
  assert.deepEqual(f2.calls.pageResult, []);
  s2.close();
});

test("CAU-REV-05 对账:页面的白名单与服务端经反向通道的工具表是同一组", () => {
  assert.deepEqual([...CLOUD_PAGE_REQUEST_TOOLS].sort(), [...CLOUD_PAGE_TOOLS].sort());
});

test("CAU-REV-06 守门:触发执行的入口只有事件流;接口层带委托票据交回", async () => {
  // 只看代码,注释里的说明不算
  const own = fs.readFileSync(path.join(HERE, "pageRequests.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const bad of ["window.", "postMessage", "addEventListener", "CustomEvent", "globalThis.__", "localStorage", "fetch("]) {
    assert.equal(own.includes(bad), false, `pageRequests.ts 里不该有 ${bad}`);
  }
  // `src/` 里引用 runPageRequest 的只有 useCloud.ts(接线)与本文件、pageRequests.ts 自己
  const users = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|mjs)$/.test(e.name) && fs.readFileSync(p, "utf8").includes("runPageRequest")) users.push(path.relative(SRC, p).replaceAll("\\", "/"));
    }
  };
  walk(SRC);
  assert.deepEqual(users.sort(), ["ai/cloud/page-requests.test.mjs", "ai/cloud/pageRequests.ts", "ai/cloud/useCloud.ts"]);
  // useCloud.ts 里只把它交给会话控制器(事件流的唯一读者),没有挂到全局
  const wiring = fs.readFileSync(path.join(HERE, "useCloud.ts"), "utf8");
  assert.equal(wiring.split("runPageRequest").length - 1, 2, "一处引入、一处交给 createCloudSession");
  assert.match(wiring, /createCloudSession\(\{ api, store, pageId: PAGE_ID, onPageRequest: \(ev\) => runPageRequest\(ev, pageExec\) \}\)/);
  assert.equal(/__pcCloud[^\n]*(runPageRequest|pageExec|PAGE_ID)/.test(wiring), false, "探针的只读口子里没有它");

  // 接口层:交回带委托票据、不带 Cookie;事件流的查询串带页面号
  const seen = [];
  const api = createCloudApi({
    baseUrl: () => "https://node.example/agent/v1",
    ticket: async () => "TICKET",
    grant: async () => "GRANT",
    fetchImpl: async (url, init) => { seen.push([String(url), init]); return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }); },
  });
  await api.pageResult("c-a", { id: ID, pageId: "pg-0123456789abcdef", ok: true, result: { ok: true } });
  assert.equal(seen[0][0], "https://node.example/agent/v1/conversations/c-a/page-results");
  assert.equal(seen[0][1].method, "POST");
  assert.equal(seen[0][1].headers.Authorization, "Bearer TICKET");
  assert.equal(seen[0][1].credentials, "omit");
  assert.deepEqual(JSON.parse(seen[0][1].body), { id: ID, pageId: "pg-0123456789abcdef", ok: true, result: { ok: true } });
  const it = api.events("c-a", 7, undefined, "pg-0123456789abcdef");
  await it.next().catch(() => {});
  assert.equal(seen[1][0], "https://node.example/agent/v1/conversations/c-a/events?after=7&page=pg-0123456789abcdef");
  const it2 = api.events("c-a", 7);
  await it2.next().catch(() => {});
  assert.equal(seen[2][0], "https://node.example/agent/v1/conversations/c-a/events?after=7", "没有页面号时查询串与原来一样");
});
