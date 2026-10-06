/**
 * 编辑器页这一侧的舞台隔离会话:自检结果的校验、每台舞台取素材走哪条路、本页能不能执行用户卡与图卡、票据交接(契约
 * `docs/plan/online-card-exec-contract.md` 第 3.1、3.2、4.1 节)。
 * 跑:node --test src/online/stageIsolation.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STAGE_SANDBOX, createStageIsolation, sanitizeIsolationReport, sanitizeBreach, newSid, grantMediaCookie,
  onlineCardExec, subscribeOnlineCardExec, pageStageIsolation, resetPageStageIsolationForTest,
} from "./stageIsolation.ts";

const OK = { ok: true, crossOrigin: true, csp: "header", egress: "allowlist", hardened: true, trustedTypes: "enforced", reasons: [] };
const BAD = { ok: false, crossOrigin: true, csp: "meta", egress: "script", hardened: true, trustedTypes: "enforced", reasons: ["meta-only"] };
const SID = "0123456789abcdef0123456789abcdef";
const TICKET = "v1.payload-payload-payload.signature-signature";
const S1 = "https://s1.x.io", S2 = "https://s2.x.io";

/** 一份会话:总开关、交接都可控;定时器收在数组里手动触发 */
function make({ enabled = true, grantOk = true } = {}) {
  const state = { enabled, grantOk, grants: [], timers: [] };
  const iso = createStageIsolation({
    enabled: () => state.enabled,
    grant: async (origin, sid, ticket) => { state.grants.push({ origin, sid, ticket }); return state.grantOk; },
    sid: SID,
    setTimer: (fn) => { state.timers.push(fn); return state.timers.length; },
    clearTimer: () => {},
  });
  return { iso, state };
}
/** 两台都握手、自检通过、交接成功 */
async function bothIsolated(iso) {
  iso.setDual(true);
  iso.handshake("A"); iso.handshake("B");
  iso.report("A", OK); iso.report("B", OK);
  const a = await iso.plan("A", { dual: true, stageOrigin: S1, ticket: TICKET });
  const b = await iso.plan("B", { dual: true, stageOrigin: S2, ticket: TICKET });
  return { a, b };
}

test("OCS-S-01 舞台 iframe 的 sandbox 只开脚本与保有自己的源两项", () => {
  assert.equal(STAGE_SANDBOX, "allow-scripts allow-same-origin");
  for (const no of ["allow-popups", "allow-top-navigation", "allow-forms", "allow-modals", "allow-downloads"]) assert.ok(!STAGE_SANDBOX.includes(no), no);
});

test("OCS-S-02 舞台发来的自检结果按形状校验,结论不信舞台自己下的、按各项事实重算", () => {
  assert.deepEqual(sanitizeIsolationReport(OK), OK);
  // 舞台自称通过,但事实不齐:重算成不通过
  for (const lie of [{ ...OK, csp: "meta" }, { ...OK, csp: "none" }, { ...OK, crossOrigin: false }, { ...OK, hardened: false }, { ...OK, egress: "none" }, { ...OK, reasons: ["meta-only"] }]) {
    assert.equal(sanitizeIsolationReport(lie).ok, false, JSON.stringify(lie));
  }
  // 多出来的字段丢掉;认不出的原因丢掉
  const extra = sanitizeIsolationReport({ ...BAD, ticket: "x", reasons: ["meta-only", "made-up", 42] });
  assert.deepEqual(extra, BAD);
  for (const bad of [null, undefined, 42, "ok", [], {}, { ok: true }, { ...OK, csp: "response" }, { ...OK, egress: "browser" }, { ...OK, trustedTypes: "yes" }, { ...OK, ok: "true" }, { ...OK, reasons: "none" }, { ...OK, hardened: 1 }]) {
    assert.equal(sanitizeIsolationReport(bad), null, JSON.stringify(bad));
  }
  assert.equal(sanitizeBreach("create"), "create");
  for (const bad of ["", "nope", null, 1, {}]) assert.equal(sanitizeBreach(bad), null);
});

test("OCS-S-03 两台都自检通过、票据交接成功:都走 cookie(基址 /media-s/<sid>、不带票据),本页判可执行", async () => {
  const { iso, state } = make();
  assert.deepEqual({ enabled: iso.state().enabled, reason: iso.state().reason }, { enabled: false, reason: "single-stage" });
  const { a, b } = await bothIsolated(iso);
  assert.deepEqual(a, { mode: "cookie", base: `/media-s/${SID}`, ticket: null, cardExec: false }, "另一台还没好:先不点头");
  assert.deepEqual(b, { mode: "cookie", base: `/media-s/${SID}`, ticket: null, cardExec: true });
  assert.deepEqual(iso.state(), { enabled: true, reason: "ok", detail: {}, egress: "allowlist" });
  assert.deepEqual(state.grants, [{ origin: S1, sid: SID, ticket: TICKET }, { origin: S2, sid: SID, ticket: TICKET }]);
  // 同一张票据不重复交接;这回两台都点头
  const again = await iso.plan("A", { dual: true, stageOrigin: S1, ticket: TICKET });
  assert.equal(again.cardExec, true);
  assert.equal(state.grants.length, 2);
  // 续票:换了一张就再交接一次
  await iso.plan("A", { dual: true, stageOrigin: S1, ticket: `${TICKET}2` });
  assert.equal(state.grants.length, 3);
  assert.equal(iso.sid, SID);
});

test("OCS-S-04 有一台靠脚本加固拦 WebRTC:照样可执行,但记成 egress: script", async () => {
  const { iso } = make();
  iso.setDual(true);
  iso.handshake("A"); iso.handshake("B");
  iso.report("A", OK); iso.report("B", { ...OK, egress: "script" });
  await iso.plan("A", { dual: true, stageOrigin: S1, ticket: TICKET });
  await iso.plan("B", { dual: true, stageOrigin: S2, ticket: TICKET });
  assert.deepEqual({ enabled: iso.state().enabled, egress: iso.state().egress }, { enabled: true, egress: "script" });
});

test("OCS-S-05 托管方关了总开关:不交接、不等自检,两台都走旧办法(票据经 RPC),原因是总开关;打开后恢复", async () => {
  const { iso, state } = make({ enabled: false });
  const { a, b } = await bothIsolated(iso);
  for (const p of [a, b]) assert.deepEqual(p, { mode: "legacy", base: null, ticket: TICKET, cardExec: false });
  assert.equal(state.grants.length, 0);
  assert.deepEqual({ enabled: iso.state().enabled, reason: iso.state().reason }, { enabled: false, reason: "switch-off" });
});

test("OCS-S-06 有一台自检没过(只有 <meta> 兜底):那一台走旧办法,本页不执行,说得出是哪台、为什么", async () => {
  const { iso, state } = make();
  iso.setDual(true);
  iso.handshake("A"); iso.handshake("B");
  iso.report("A", OK); iso.report("B", BAD);
  const a = await iso.plan("A", { dual: true, stageOrigin: S1, ticket: TICKET });
  const b = await iso.plan("B", { dual: true, stageOrigin: S2, ticket: TICKET });
  assert.equal(a.mode, "cookie");
  assert.equal(a.cardExec, false);
  assert.deepEqual(b, { mode: "legacy", base: null, ticket: TICKET, cardExec: false });
  assert.deepEqual(iso.state(), { enabled: false, reason: "not-isolated", detail: { B: ["meta-only"] }, egress: null });
  assert.deepEqual(state.grants.map((g) => g.origin), [S1], "没过的那一台不交接");
});

test("OCS-S-07 票据交接没成(舞台源没有 /media-s/、第三方 cookie 被拦):走旧办法,本页不执行,原因是交接", async () => {
  const { iso } = make({ grantOk: false });
  const { a } = await bothIsolated(iso);
  assert.deepEqual(a, { mode: "legacy", base: null, ticket: TICKET, cardExec: false });
  assert.deepEqual({ enabled: iso.state().enabled, reason: iso.state().reason }, { enabled: false, reason: "grant-failed" });
});

test("OCS-S-08 握手之后等不到自检结果(旧版舞台页不发、舞台卡住):到时按自检出错,走旧办法", async () => {
  const { iso, state } = make();
  iso.setDual(true);
  iso.handshake("A");
  const pending = iso.plan("A", { dual: true, stageOrigin: S1, ticket: TICKET });
  await Promise.resolve();
  assert.equal(state.timers.length, 1);
  state.timers[0]();
  assert.deepEqual(await pending, { mode: "legacy", base: null, ticket: TICKET, cardExec: false });
  assert.equal(iso.state().reason, "not-isolated");
  assert.deepEqual(iso.state().detail, { A: ["check-error"] });
  assert.equal(state.grants.length, 0);
});

test("OCS-S-09 点过头之后任何舞台都不再收到票据:后来哪一台自检不过或交接失败,拿到的是不带票据的 cookie 基址", async () => {
  const { iso, state } = make();
  await bothIsolated(iso);
  assert.equal(iso.state().enabled, true);
  // B 重载成了没隔离的文档
  iso.handshake("B");
  assert.equal(iso.state().enabled, false);
  iso.report("B", BAD);
  const b = await iso.plan("B", { dual: true, stageOrigin: S2, ticket: TICKET });
  assert.deepEqual(b, { mode: "cookie", base: `/media-s/${SID}`, ticket: null, cardExec: false });
  // A 续票时交接失败:留在 cookie 上(旧 cookie 还能用到过期),同样不给票据
  state.grantOk = false;
  const a = await iso.plan("A", { dual: true, stageOrigin: S1, ticket: `${TICKET}2` });
  assert.equal(a.mode, "cookie");
  assert.equal(a.ticket, null);
  // 退回单舞台(握手失败):那一台是同源的旧办法调用方自己处理,这里只管不点头
  iso.setDual(false);
  assert.equal(iso.state().reason, "single-stage");
  const single = await iso.plan("A", { dual: false, stageOrigin: null, ticket: TICKET });
  assert.equal(single.ticket, null, "点过头的会话里,连退回单舞台时也不经它发票据");
});

test("OCS-S-10 加固拦下过试图造子框架的代码:本页会话不再执行;订阅方收到通知", async () => {
  const { iso } = make();
  let calls = 0;
  iso.subscribe(() => { calls++; });
  await bothIsolated(iso);
  const before = calls;
  iso.breach("create");
  assert.equal(calls, before + 1);
  assert.deepEqual({ enabled: iso.state().enabled, reason: iso.state().reason }, { enabled: false, reason: "breach" });
  const a = await iso.plan("A", { dual: true, stageOrigin: S1, ticket: TICKET });
  assert.deepEqual(a, { mode: "cookie", base: `/media-s/${SID}`, ticket: null, cardExec: false });
  // 重新握手、重新自检通过也不恢复
  iso.handshake("A"); iso.report("A", OK);
  await iso.plan("A", { dual: true, stageOrigin: S1, ticket: TICKET });
  assert.equal(iso.state().reason, "breach");
});

test("OCS-S-11 等自检的时候这一台又握手了(换了文档):这一次作废;还没有票据时不交接、也不退回旧办法", async () => {
  const { iso, state } = make();
  iso.setDual(true);
  iso.handshake("A");
  const stale = iso.plan("A", { dual: true, stageOrigin: S1, ticket: TICKET });
  iso.handshake("A");
  const r = await stale;
  assert.equal(r.cardExec, false);
  assert.equal(state.grants.length, 0);
  iso.report("A", OK);
  const noTicket = await iso.plan("A", { dual: true, stageOrigin: S1, ticket: null });
  assert.deepEqual(noTicket, { mode: "cookie", base: `/media-s/${SID}`, ticket: null, cardExec: false });
  assert.equal(state.grants.length, 0);
});

test("OCS-S-12 会话号:32 位十六进制,每次不同;交接请求是带凭据的跨源 POST、票据只在 Authorization 头里,204 才算成", async () => {
  const sid = newSid();
  assert.match(sid, /^[0-9a-f]{32}$/);
  assert.notEqual(sid, newSid());
  assert.equal(newSid((b) => b.fill(0xab)), "ab".repeat(16));
  const calls = [];
  const fetchImpl = (status) => async (url, init) => { calls.push({ url, init }); return { status }; };
  assert.equal(await grantMediaCookie(S1, SID, TICKET, fetchImpl(204)), true);
  assert.equal(calls[0].url, `${S1}/media-s/${SID}/_grant`);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.credentials, "include");
  assert.deepEqual(calls[0].init.headers, { Authorization: `Bearer ${TICKET}` });
  assert.ok(!calls[0].url.includes(TICKET), "票据不进地址");
  assert.equal(calls[0].init.body, undefined);
  for (const status of [200, 401, 403, 404, 500]) assert.equal(await grantMediaCookie(S1, SID, TICKET, fetchImpl(status)), false, String(status));
  assert.equal(await grantMediaCookie(S1, SID, TICKET, async () => { throw new TypeError("Failed to fetch"); }), false);
  const n = calls.length;
  assert.equal(await grantMediaCookie(S1, "bad sid", TICKET, fetchImpl(204)), false);
  assert.equal(calls.length, n, "会话号不对就不发请求");
});

test("OCS-S-13 本页的那一份:没建会话(桌面运行环境、还没挂舞台)回「单舞台、不执行」;总开关经 enabled 读", async () => {
  resetPageStageIsolationForTest();
  assert.deepEqual({ enabled: onlineCardExec().enabled, reason: onlineCardExec().reason }, { enabled: false, reason: "single-stage" });
  let on = false, calls = 0;
  const off = subscribeOnlineCardExec(() => { calls++; });
  const iso = pageStageIsolation(() => on);
  assert.equal(pageStageIsolation(), iso, "同一页只有一份");
  iso.setDual(true);
  assert.equal(onlineCardExec().reason, "switch-off");
  assert.ok(calls >= 1);
  on = true;
  iso.handshake("A");
  assert.equal(onlineCardExec().reason, "pending");
  off();
  resetPageStageIsolationForTest();
});
