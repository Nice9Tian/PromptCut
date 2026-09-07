/**
 * 诊断报告 Worker 的自检。跑:node --test tools/report-worker/worker.test.mjs
 *
 * 不需要 wrangler、不需要联网:直接调 `export default { fetch }`,KV 用一个内存假货。
 *
 * 钉的是一条:**ADMIN_KEY 不许离开 Worker**。
 * 0.3.0 评审抓到的原状是 —— 每收一份报告,就把 `/r/<id>?k=<ADMIN_KEY>` 推进飞书群。
 * 那是管理密钥:能读任意一份、能列全部、能删。群里每个人、每一张转发的截图都拿到了它。
 */
import test from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.js";

/** 够用的 KV 假货:put / get / delete / list */
function fakeKv() {
  const m = new Map();
  return {
    async put(k, v, opts) { m.set(k, { v, meta: opts?.metadata }); },
    async get(k) { return m.has(k) ? m.get(k).v : null; },
    async delete(k) { m.delete(k); },
    async list({ limit = 1000, cursor } = {}) {
      void cursor;
      return { keys: [...m.entries()].slice(0, limit).map(([name, e]) => ({ name, metadata: e.meta })), list_complete: true, cursor: null };
    },
    _map: m,
  };
}

const ADMIN_KEY = "super-secret-admin-key";

function envWith(extra = {}) {
  return { REPORTS: fakeKv(), ADMIN_KEY, SUBMIT_TOKEN: "tok", ...extra };
}

const post = (env, body) =>
  worker.fetch(new Request("https://reports.example.com/", { method: "POST", body: JSON.stringify(body) }), env);
const get = (env, p) => worker.fetch(new Request("https://reports.example.com" + p), env);

/** 交一份报告,把飞书那条链接截下来 */
async function submitAndCaptureLink(env) {
  let captured = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(init.body).content.text;
    return new Response("ok");
  };
  try {
    const res = await post({ ...env, FEISHU_WEBHOOK: "https://feishu.example/hook" }, { token: "tok", label: "自检", notable: [] });
    const { id } = await res.json();
    const line = (captured || "").split("\n").find((l) => l.includes("http"));
    return { id, link: (line || "").replace(/^取报告：/, "") };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("发进群的链接里绝不能有 ADMIN_KEY", async () => {
  const env = envWith();
  const { id, link } = await submitAndCaptureLink(env);
  assert.ok(id, "该收下报告并回一个 id");
  assert.ok(link.includes(`/r/${id}?s=`), `该是单份取件码链接,实际:${link}`);
  assert.ok(!link.includes(ADMIN_KEY), `链接里带着管理密钥:${link}`);
});

test("取件码只能读它自己那一份", async () => {
  const env = envWith();
  const { id, link } = await submitAndCaptureLink(env);
  const s = new URL(link).searchParams.get("s");

  // 自己那份:读得到
  const mine = await get(env, `/r/${id}?s=${encodeURIComponent(s)}`);
  assert.equal(mine.status, 200);
  assert.match(await mine.text(), /自检/);

  // 别人那份:读不到(拿同一个码去取另一个 id)
  await env.REPORTS.put("2026-01-01-other", JSON.stringify({ label: "别人的" }), { metadata: {} });
  const other = await get(env, `/r/2026-01-01-other?s=${encodeURIComponent(s)}`);
  assert.equal(other.status, 404, "取件码不该能读别的报告");
});

test("取件码没有列表权和删除权", async () => {
  const env = envWith();
  const { id, link } = await submitAndCaptureLink(env);
  const s = new URL(link).searchParams.get("s");

  assert.equal((await get(env, `/list?s=${encodeURIComponent(s)}`)).status, 404);
  assert.equal((await get(env, `/list?k=${encodeURIComponent(s)}`)).status, 404);
  const del = await worker.fetch(new Request(`https://reports.example.com/r/${id}?s=${encodeURIComponent(s)}`, { method: "DELETE" }), env);
  assert.equal(del.status, 404, "取件码不该能删");
  assert.ok(await env.REPORTS.get(id), "报告该还在");
});

test("ADMIN_KEY 本身照样能列、能读、能删", async () => {
  const env = envWith();
  const { id } = await submitAndCaptureLink(env);
  const k = encodeURIComponent(ADMIN_KEY);
  const list = await get(env, `/list?k=${k}`);
  assert.equal(list.status, 200);
  assert.equal((await list.json()).keys.length, 1);
  assert.equal((await get(env, `/r/${id}?k=${k}`)).status, 200);
  const del = await worker.fetch(new Request(`https://reports.example.com/r/${id}?k=${k}`, { method: "DELETE" }), env);
  assert.equal(del.status, 200);
  assert.equal(await env.REPORTS.get(id), null);
});

test("管理口的响应不带 Access-Control-Allow-Origin(别让网页跨站读走)", async () => {
  const env = envWith();
  const { id } = await submitAndCaptureLink(env);
  const k = encodeURIComponent(ADMIN_KEY);
  for (const p of [`/r/${id}?k=${k}`, `/list?k=${k}`]) {
    const res = await get(env, p);
    assert.equal(res.headers.get("access-control-allow-origin"), null, `${p} 不该有 ACAO`);
  }
});

test("提交令牌不对就收不下", async () => {
  const env = envWith();
  const res = await post(env, { token: "wrong", label: "x" });
  assert.equal(res.status, 403);
});

test("限流器说不行就回 429,而且不写 KV", async () => {
  const env = envWith({ SUBMIT_LIMIT: { limit: async () => ({ success: false }) } });
  const res = await post(env, { token: "tok", label: "x" });
  assert.equal(res.status, 429);
  assert.equal(env.REPORTS._map.size, 0);
});

test("没配限流绑定时照常收(老部署不该因此挂掉)", async () => {
  const env = envWith();
  const res = await post(env, { token: "tok", label: "x" });
  assert.equal(res.status, 200);
});
