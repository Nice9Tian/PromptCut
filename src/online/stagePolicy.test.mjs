/**
 * 在线执行用户卡与图卡的隔离策略原文与票据换 cookie 的判定(契约 `docs/plan/online-card-exec-contract.md` 第 3.3、4.1 节)。
 * 跑:node --test src/online/stagePolicy.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STAGE_CSP_META, STAGE_CSP_HEADER_ONLY_DIRECTIVE, STAGE_CONNECTION_ALLOWLIST, MEDIA_COOKIE, MEDIA_COOKIE_MAX_AGE_S, MEDIA_PROXY_BASE, ASSET_API_PREFIX,
  stageCspHeader, editorCspHeader, stageSecurityHeaders, editorSecurityHeaders, isSid, isTicketShaped, mediaGrantUrl, mediaSBase, mediaGrantCookie,
  mediaSRoute, cookieValue,
} from "./stagePolicy.mjs";

const EDITOR = "https://x.io";
const SID = "0123456789abcdef0123456789abcdef";
const HASH = "a".repeat(64);
const TICKET = `v1.${"p".repeat(60)}.${"s".repeat(43)}`;

test("OCS-P-01 舞台的内容安全策略:响应头那一份逐字固定,只许本源,后台线程只许 blob,不许子框架、表单、插件", () => {
  assert.equal(stageCspHeader(EDITOR),
    "default-src 'none'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; "
    + "font-src 'self' data:; connect-src 'self'; worker-src blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; "
    + "webrtc 'block'; frame-ancestors https://x.io");
  // worker-src 不含 'self':同源脚本地址起的 Worker 不继承文档的策略
  assert.ok(!/worker-src[^;]*'self'/.test(stageCspHeader(EDITOR)));
  assert.throws(() => stageCspHeader("https://x.io/editor"), /不是合法的源/);
  assert.throws(() => stageCspHeader("javascript:alert(1)"), /不是合法的源/);
  // nginx 模板里占位符原样进去
  assert.ok(stageCspHeader("https://{{DOMAIN}}", { template: true }).endsWith("frame-ancestors https://{{DOMAIN}}"));
});

test("OCS-P-02 <meta> 兜底那一份:同文、不含 frame-ancestors(<meta> 里无效)、多两条 Trusted Types;响应头那一份不含 Trusted Types", () => {
  const header = stageCspHeader(EDITOR);
  assert.ok(header.startsWith(STAGE_CSP_META.replace("; require-trusted-types-for 'script'; trusted-types default", "")));
  assert.ok(!STAGE_CSP_META.includes(STAGE_CSP_HEADER_ONLY_DIRECTIVE), "自检靠这条指令分辨策略出自响应头还是 <meta>");
  assert.ok(header.includes(STAGE_CSP_HEADER_ONLY_DIRECTIVE));
  assert.ok(STAGE_CSP_META.endsWith("require-trusted-types-for 'script'; trusted-types default"));
  // 先改 nginx 再换页面:旧版页面的舞台没有缺省策略,响应头里带 Trusted Types 会把它拦死
  assert.ok(!header.includes("trusted-types"));
  assert.ok(!STAGE_CSP_META.includes('"'), "要放进 content=\"…\" 里");
});

test("OCS-P-03 舞台源每个响应的安全头:策略、出口白名单(只许本源,WebRTC 缺省拦下)、关 DNS 预解析,原有三条照旧", () => {
  const h = stageSecurityHeaders(EDITOR);
  assert.deepEqual(Object.keys(h), ["content-security-policy", "connection-allowlist", "x-dns-prefetch-control", "origin-agent-cluster", "referrer-policy", "x-content-type-options"]);
  assert.equal(h["connection-allowlist"], "(response-origin)");
  assert.equal(STAGE_CONNECTION_ALLOWLIST, "(response-origin)");
  assert.ok(!/webrtc\s*=\s*allow/.test(h["connection-allowlist"]));
  assert.equal(h["x-dns-prefetch-control"], "off");
  assert.equal(h["origin-agent-cluster"], "?1");
});

test("OCS-P-04 编辑器页只加 frame-src 一条:本源与两个舞台源,不放 blob: / data:", () => {
  assert.equal(editorCspHeader(["https://s1.x.io", "https://s2.x.io"]), "frame-src 'self' https://s1.x.io https://s2.x.io");
  assert.deepEqual(editorSecurityHeaders(["https://s1.x.io", "https://s2.x.io"]), { "content-security-policy": "frame-src 'self' https://s1.x.io https://s2.x.io" });
  assert.throws(() => editorCspHeader(["https://s1.x.io/a"]), /不是合法的源/);
  assert.ok(!/blob:|data:|\*/.test(editorCspHeader(["https://s1.x.io", "https://s2.x.io"])));
});

test("OCS-P-05 会话号与票据的形状;交接地址与取素材的基址", () => {
  assert.ok(isSid(SID));
  for (const bad of ["", "short", "a".repeat(65), "has/slash0123456789", "../../etc/passwd00", null, 42]) assert.equal(isSid(bad), false, String(bad));
  assert.ok(isTicketShaped(TICKET));
  for (const bad of ["", "v2.aaa.bbb", "v1.aaa", "v1..bbb", `v1.${"a".repeat(3000)}.b`, "v1.a b.c", "v1.a;Path=/.c", null]) assert.equal(isTicketShaped(bad), false, String(bad));
  assert.equal(mediaGrantUrl("https://s1.x.io", SID), `https://s1.x.io/media-s/${SID}/_grant`);
  assert.equal(mediaSBase(SID), `/media-s/${SID}`);
  assert.equal(MEDIA_PROXY_BASE, "/media/api/asset");
  assert.equal(ASSET_API_PREFIX, "/api/asset");
});

test("OCS-P-06 票据换成的 cookie:HttpOnly、Secure、SameSite=Strict,只在本页会话那一段路径上有效,寿命同票据(15 分钟)", () => {
  assert.equal(mediaGrantCookie(SID, TICKET), `${MEDIA_COOKIE}=${TICKET}; Path=/media-s/${SID}/; HttpOnly; Secure; SameSite=Strict; Max-Age=900`);
  assert.equal(MEDIA_COOKIE_MAX_AGE_S, 900);
  // 本机代理走 http:不带 Secure,别的不变
  assert.equal(mediaGrantCookie(SID, TICKET, { secure: false }), `${MEDIA_COOKIE}=${TICKET}; Path=/media-s/${SID}/; HttpOnly; SameSite=Strict; Max-Age=900`);
});

test("OCS-P-07 /media-s/ 的判定·交接:只认编辑器页的源发来的 POST、票据形状对;预检只对编辑器页的源开", () => {
  const opts = { editorOrigin: EDITOR };
  const p = `/media-s/${SID}/_grant`;
  const ok = mediaSRoute({ method: "POST", pathname: p, origin: EDITOR, authorization: `Bearer ${TICKET}` }, opts);
  assert.equal(ok.kind, "grant");
  assert.equal(ok.headers["set-cookie"], mediaGrantCookie(SID, TICKET));
  assert.equal(ok.headers["access-control-allow-origin"], EDITOR);
  assert.equal(ok.headers["access-control-allow-credentials"], "true");
  assert.equal(ok.headers["cache-control"], "no-store");
  // 舞台自己(或别的源)发来:不发 cookie
  for (const origin of ["https://s1.x.io", "https://evil.io", "https://x.io.evil.io", "https://xxio", null, undefined, "null"]) {
    assert.deepEqual(mediaSRoute({ method: "POST", pathname: p, origin, authorization: `Bearer ${TICKET}` }, opts), { kind: "reject", status: 403 }, String(origin));
  }
  assert.deepEqual(mediaSRoute({ method: "GET", pathname: p, origin: EDITOR, authorization: `Bearer ${TICKET}` }, opts), { kind: "reject", status: 405 });
  for (const authorization of [null, "", "Basic abc", "Bearer ", "Bearer not-a-ticket", `Bearer ${TICKET}; Domain=x.io`]) {
    assert.deepEqual(mediaSRoute({ method: "POST", pathname: p, origin: EDITOR, authorization }, opts), { kind: "reject", status: 400 }, String(authorization));
  }
  assert.equal(mediaSRoute({ method: "OPTIONS", pathname: p, origin: EDITOR }, opts).kind, "preflight");
  assert.deepEqual(mediaSRoute({ method: "OPTIONS", pathname: p, origin: "https://evil.io" }, opts), { kind: "reject", status: 403 });
});

test("OCS-P-08 /media-s/ 的判定·读素材:cookie 换成 Authorization 头转给素材服务的 /api/asset/,只放行 GET / HEAD 与按哈希寻址的素材字节", () => {
  const opts = { editorOrigin: EDITOR };
  const p = `/media-s/${SID}/media/${HASH}`;
  const cookie = `other=1; ${MEDIA_COOKIE}=${TICKET}; x=y`;
  assert.deepEqual(mediaSRoute({ method: "GET", pathname: p, cookie }, opts), { kind: "proxy", path: `/api/asset/media/${HASH}`, authorization: `Bearer ${TICKET}` });
  assert.equal(mediaSRoute({ method: "HEAD", pathname: p, cookie }, opts).kind, "proxy");
  assert.equal(mediaSRoute({ method: "GET", pathname: `${p}.mp4`, cookie }, opts).path, `/api/asset/media/${HASH}.mp4`);
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) assert.deepEqual(mediaSRoute({ method, pathname: p, cookie }, opts), { kind: "reject", status: 405 }, method);
  // 没有 cookie、cookie 不是票据的形状
  for (const c of [null, "", "other=1", `${MEDIA_COOKIE}=nope`]) assert.deepEqual(mediaSRoute({ method: "GET", pathname: p, cookie: c }, opts), { kind: "reject", status: 401 }, String(c));
  // 别的命名空间、子路由、上跳、会话号不对:一律 404
  for (const bad of [`/media-s/${SID}/snap/${HASH}`, `/media-s/${SID}/px/${HASH}`, `${p}/chunks`, `${p}/0`, `${p}/complete`, `/media-s/${SID}/media/../admin/inventory`,
    `/media-s/${SID}/admin/inventory`, `/media-s/${SID}/media/${HASH.slice(1)}`, `/media-s/short/media/${HASH}`, "/media-s/", `/media-s/${SID}`, `/media-s/${SID}/`]) {
    assert.deepEqual(mediaSRoute({ method: "GET", pathname: bad, cookie }, opts), { kind: "reject", status: 404 }, bad);
  }
  // 不是这条路由
  for (const other of ["/media/api/asset/media/x", "/editor/stage.html", "/media-sx/a", "/"]) assert.deepEqual(mediaSRoute({ method: "GET", pathname: other, cookie }, opts), { kind: "none" }, other);
});

test("OCS-P-09 从 Cookie 头里取值", () => {
  assert.equal(cookieValue("a=1; pc_rt=v1.x.y; b=2", "pc_rt"), "v1.x.y");
  assert.equal(cookieValue("pc_rtx=1", "pc_rt"), null);
  assert.equal(cookieValue(null, "pc_rt"), null);
  assert.equal(cookieValue("pc_rt=a=b", "pc_rt"), "a=b");
});
