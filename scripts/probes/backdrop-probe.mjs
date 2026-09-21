// Probe: what can `backdrop-filter` sample?
//
//   node scripts/probes/backdrop-probe.mjs                 -> puppeteer's own Chrome
//   node scripts/probes/backdrop-probe.mjs --connect        -> the desktop shell's WebView2 on 9333
//   node scripts/probes/backdrop-probe.mjs --json out.json  -> also dump the raw numbers
//
// Cases (every one is a fresh document; the first version of this probe reused one
// page and reported white for the later cases):
//   1-2  glass over sibling <canvas> (2D + WebGL), with and without `isolation: isolate`
//        on the wrapper — src/kernel/Stage.tsx puts `isolation: isolate` on card wrappers
//   3    glass inside a same-origin srcdoc iframe, over the parent document's canvas
//   4-5  glass over a sibling <video> in the same document
//   6-7  glass inside a CROSS-ORIGIN OOPIF, over a <video> / <canvas> in that same iframe
//        — this is the shape目标 E1 gives the stage: the stage is a cross-origin iframe and
//        the 毛玻璃卡 sits on top of 流平面 inside it
//   8-9  glass inside a cross-origin OOPIF, over the PARENT document's video / canvas
//
// Everything is served over http (not setContent) so the cross-origin cases are real
// and both run modes take exactly the same path.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { connectArg, flagArg, openBrowser, pageFactory, listTargets, serve, closeAll, sleep }
  from './probe-connect.mjs';

const connect = connectArg();
const jsonOut = flagArg('json');
const shotDir = flagArg('shots', path.join(os.tmpdir(), 'pc-backdrop-probe'));
const PARENT_HOST = flagArg('parent-host', 'localhost');
const CHILD_HOST = flagArg('child-host', '127.0.0.1');
const PARENT_PORT = Number(flagArg('parent-port', '5231'));
const CHILD_PORT = Number(flagArg('child-port', '5232'));
// 默认 400x200（和旧版一致）。`--w 1280 --h 720` 用来测「整屏大小的 <video>」：Windows 上
// Chromium 可能把够大的视频层提升成 DirectComposition overlay，那样玻璃就采样不到它了。
const W = Number(flagArg('w', '400')), H = Number(flagArg('h', '200'));
const R = (v) => Math.round(v);
// 玻璃盖住中间一大块；测量行取玻璃内左右两段，外加一行在玻璃外面做「底下确实画了东西」的自检。
const GX = R(W * 0.125), GY = R(H * 0.25), GW = R(W * 0.75), GH = R(H * 0.5);
const REGIONS = [
  ['underLeft', R(H * 0.5), R(W * 0.15), R(W * 0.475)],
  ['underRight', R(H * 0.5), R(W * 0.525), R(W * 0.85)],
  ['outside', R(H * 0.1), 0, W],
];

fs.mkdirSync(shotDir, { recursive: true });

// ── the video the glass has to sample ────────────────────────────────────────
// 8px black/white vertical stripes, so "blurred" is unambiguous: sharp stripes keep
// max-min ≈ 255, a 12px blur flattens them to a single grey.
function stripesBmp(w, h, period = 16, on = 8) {
  const rowBytes = w * 3;
  const pad = (4 - (rowBytes % 4)) % 4;
  const imgSize = (rowBytes + pad) * h;
  const buf = Buffer.alloc(54 + imgSize);
  buf.write('BM', 0);
  buf.writeUInt32LE(54 + imgSize, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(imgSize, 34);
  let o = 54;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) { const v = (x % period) < on ? 0 : 255; buf[o++] = v; buf[o++] = v; buf[o++] = v; }
    o += pad;
  }
  return buf;
}

const bmpPath = path.join(shotDir, `stripes-${W}x${H}.bmp`);
const mp4Path = path.join(shotDir, `stripes-${W}x${H}.mp4`);
fs.writeFileSync(bmpPath, stripesBmp(W, H));
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-loop', '1', '-i', bmpPath, '-t', '2', '-r', '30',
  '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.0', '-pix_fmt', 'yuv420p',
  '-vf', 'scale=in_range=full:out_range=full', '-color_range', 'pc', '-g', '30', '-movflags', '+faststart',
  mp4Path]);
const mp4 = fs.readFileSync(mp4Path);

// ── page fragments ───────────────────────────────────────────────────────────
const GLASS = (extra = '') =>
  `<div id=glass style="position:absolute;left:${GX}px;top:${GY}px;width:${GW}px;height:${GH}px;${extra}` +
  `backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);background:rgba(255,255,255,0.05)"></div>`;

const wrapGlass = (isolate) =>
  `<div id=wrap style="position:absolute;left:0;top:0;width:${W}px;height:${H}px;${isolate ? 'isolation:isolate;' : ''}">${GLASS()}</div>`;

const HW = R(W / 2);
const CANVASES = `
  <canvas id=c2 width=${HW} height=${H} style="position:absolute;left:0;top:0"></canvas>
  <canvas id=gl width=${W - HW} height=${H} style="position:absolute;left:${HW}px;top:0"></canvas>`;

const CANVAS_SCRIPT = `
  const c = document.getElementById('c2').getContext('2d');
  const g = document.getElementById('gl').getContext('webgl');
  const W2 = ${HW}, W3 = ${W - HW}, HH = ${H};
  g.enable(g.SCISSOR_TEST);
  function paint() {
    for (let x = 0; x < W2; x += 16) { c.fillStyle = '#fff'; c.fillRect(x, 0, 16, HH); c.fillStyle = '#000'; c.fillRect(x, 0, 8, HH); }
    for (let x = 0; x < W3; x += 16) {
      g.scissor(x, 0, 8, HH); g.clearColor(0, 0, 0, 1); g.clear(g.COLOR_BUFFER_BIT);
      g.scissor(x + 8, 0, 8, HH); g.clearColor(1, 1, 1, 1); g.clear(g.COLOR_BUFFER_BIT);
    }
    requestAnimationFrame(paint);
  }
  paint();
  window.__probeReady = Promise.resolve('canvas');`;

const VIDEO = (src) =>
  `<video id=v src="${src}" muted autoplay loop playsinline
     style="position:absolute;left:0;top:0;width:${W}px;height:${H}px;object-fit:fill"></video>`;

const VIDEO_SCRIPT = `
  const v = document.getElementById('v');
  v.muted = true;
  window.__probeReady = new Promise(res => {
    let frames = 0;
    const done = () => res({ paused: v.paused, t: v.currentTime, readyState: v.readyState, frames });
    const tick = () => { if (++frames >= 3) done(); else if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(tick); else setTimeout(tick, 50); };
    const start = () => { if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(tick); else setTimeout(tick, 200); };
    v.play().then(start, () => { v.currentTime = 0.4; v.addEventListener('seeked', start, { once: true }); });
    setTimeout(() => res({ paused: v.paused, t: v.currentTime, readyState: v.readyState, frames, timedOut: true }), 4000);
  });`;

// A JS string literal that is safe to sit inside a <script> block: a raw `</script>`
// inside the srcdoc payload would close the *outer* script tag (that is what made the
// srcdoc case come back blank white).
const jsString = (s) => JSON.stringify(s).replace(/<\//g, '<\\/');

const doc = (body, script) =>
  `<!doctype html><meta charset=utf-8><body style="margin:0;background:#fff">
   <div id=scene style="position:relative;width:${W}px;height:${H}px;overflow:hidden">${body}</div>
   <script>${script}<\/script></body>`;

const transparentDoc = (body, script) =>
  `<!doctype html><meta charset=utf-8><body style="margin:0;background:transparent">
   <div id=scene style="position:relative;width:${W}px;height:${H}px;overflow:hidden">${body}</div>
   <script>${script}<\/script></body>`;

const iframeHost = (childPath, parentBody, parentScript) =>
  `<!doctype html><meta charset=utf-8><body style="margin:0;background:#fff">
   <div id=scene style="position:relative;width:${W}px;height:${H}px;overflow:hidden">
     ${parentBody}
     <iframe id=f src="http://${CHILD_HOST}:${CHILD_PORT}${childPath}" allow="autoplay"
       style="position:absolute;left:0;top:0;width:${W}px;height:${H}px;border:0;background:transparent"></iframe>
   </div>
   <script>
     ${parentScript}
     const own = window.__probeReady || Promise.resolve('none');
     window.__probeReady = new Promise(res => {
       let child = null;
       addEventListener('message', e => { if (e.data && e.data.probeChildReady) { child = e.data.probeChildReady; } });
       const wait = () => { if (child) own.then(o => res({ parent: o, child })); else setTimeout(wait, 50); };
       wait();
       setTimeout(() => own.then(o => res({ parent: o, child: child || 'timeout' })), 5000);
     });
   <\/script></body>`;

const announceChild = `window.__probeReady.then(r => parent.postMessage({ probeChildReady: r }, '*'));`;

// ── the cases ────────────────────────────────────────────────────────────────
const cases = [
  { name: 'same doc, sibling canvas (2D | WebGL)', path: '/case/canvas', left: '2D canvas', right: 'WebGL canvas' },
  { name: 'same doc, canvas, wrapper isolation', path: '/case/canvas-isolate', left: '2D canvas', right: 'WebGL canvas' },
  { name: 'same-origin srcdoc iframe over parent canvas', path: '/case/srcdoc', left: '2D canvas', right: '2D canvas' },
  { name: 'same doc, sibling <video>', path: '/case/video', left: '<video>', right: '<video>' },
  { name: 'same doc, <video>, wrapper isolation', path: '/case/video-isolate', left: '<video>', right: '<video>' },
  { name: 'cross-origin OOPIF: <video> + glass inside', path: '/case/oopif-video', left: '<video> in OOPIF', right: '<video> in OOPIF', oopif: true },
  { name: 'cross-origin OOPIF: canvas + glass inside', path: '/case/oopif-canvas', left: '2D canvas in OOPIF', right: 'WebGL canvas in OOPIF', oopif: true },
  { name: 'cross-origin OOPIF glass over parent <video>', path: '/case/oopif-over-parent-video', left: 'parent <video>', right: 'parent <video>', oopif: true },
  { name: 'cross-origin OOPIF glass over parent canvas', path: '/case/oopif-over-parent-canvas', left: 'parent 2D canvas', right: 'parent WebGL canvas', oopif: true },
];

const html = (p) => {
  switch (p) {
    case '/case/canvas': return doc(CANVASES + wrapGlass(false), CANVAS_SCRIPT);
    case '/case/canvas-isolate': return doc(CANVASES + wrapGlass(true), CANVAS_SCRIPT);
    case '/case/video': return doc(VIDEO('/stripes.mp4') + wrapGlass(false), VIDEO_SCRIPT);
    case '/case/video-isolate': return doc(VIDEO('/stripes.mp4') + wrapGlass(true), VIDEO_SCRIPT);
    case '/case/srcdoc': return doc(
      CANVASES + `<iframe id=f style="position:absolute;left:0;top:0;width:${W}px;height:${H}px;border:0;background:transparent"></iframe>`,
      CANVAS_SCRIPT + `document.getElementById('f').srcdoc = ${jsString(transparentDoc(GLASS(), 'window.__probeReady = Promise.resolve("srcdoc");'))};`);
    case '/case/oopif-video': return iframeHost('/child/video', '', 'window.__probeReady = Promise.resolve("host");');
    case '/case/oopif-canvas': return iframeHost('/child/canvas', '', 'window.__probeReady = Promise.resolve("host");');
    case '/case/oopif-over-parent-video': return iframeHost('/child/glass', VIDEO('/stripes.mp4'), VIDEO_SCRIPT);
    case '/case/oopif-over-parent-canvas': return iframeHost('/child/glass', CANVASES, CANVAS_SCRIPT);
    default: return null;
  }
};

const childHtml = (p) => {
  switch (p) {
    case '/child/video': return transparentDoc(VIDEO(`http://${CHILD_HOST}:${CHILD_PORT}/stripes.mp4`) + wrapGlass(false), VIDEO_SCRIPT + announceChild);
    case '/child/canvas': return transparentDoc(CANVASES + wrapGlass(false), CANVAS_SCRIPT + announceChild);
    case '/child/glass': return transparentDoc(GLASS(), 'window.__probeReady = Promise.resolve("glass");' + announceChild);
    default: return null;
  }
};

const send = (res, body, type, extra = {}) => {
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(body);
};

const parentHandler = (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/stripes.mp4') return send(res, mp4, 'video/mp4');
  const body = html(url.pathname);
  if (!body) { res.writeHead(404); return res.end('no'); }
  send(res, body, 'text/html; charset=utf-8');
};

const childHandler = (req, res) => {
  const url = new URL(req.url, 'http://x');
  // Origin-Agent-Cluster is what目标 E1 plans to put on the stage document; it is also
  // the header that forces same-host-different-port iframes out of process (oac-probe).
  if (url.pathname === '/stripes.mp4') return send(res, mp4, 'video/mp4', { 'Origin-Agent-Cluster': '?1' });
  const body = childHtml(url.pathname);
  if (!body) { res.writeHead(404); return res.end('no'); }
  send(res, body, 'text/html; charset=utf-8', { 'Origin-Agent-Cluster': '?1' });
};

// ── measurement ──────────────────────────────────────────────────────────────
// Returns {min,max,mean} of the red channel over a horizontal run, in CSS pixels
// (the screenshot may come back at deviceScaleFactor > 1, so we rescale).
const READ = async (b64, regions, w, h) => {
  const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
  const cv = document.createElement('canvas'); cv.width = img.naturalWidth; cv.height = img.naturalHeight;
  const ctx = cv.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0);
  const sx = img.naturalWidth / w, sy = img.naturalHeight / h;
  const out = {};
  for (const [name, y, x0, x1] of regions) {
    const px = Math.round(x0 * sx), pw = Math.max(1, Math.round((x1 - x0) * sx)), py = Math.round(y * sy);
    const d = ctx.getImageData(px, py, pw, 1).data;
    let mn = 255, mx = 0, sum = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { mn = Math.min(mn, d[i]); mx = Math.max(mx, d[i]); sum += d[i]; n++; }
    out[name] = { min: mn, max: mx, mean: Math.round(sum / n) };
  }
  out.__scale = img.naturalWidth / w;
  return out;
};

function classify(r) {
  if (r.max - r.min >= 120) return 'sharp';
  if (r.mean > 230) return 'blank-white';
  if (r.mean < 25) return 'blank-black';
  return 'BLURRED';
}

// ── run ──────────────────────────────────────────────────────────────────────
const servers = [await serve(PARENT_PORT, parentHandler), await serve(CHILD_PORT, childHandler)];
const { browser, mode, endpoint, close } = await openBrowser({
  connect,
  // 默认沿用旧版的 headless；`--headful` 用来对比有窗口时的合成路径（硬件 overlay 只在有窗口时出现）
  launch: { headless: !process.argv.includes('--headful'), args: [`--window-size=${W + 40},${H + 140}`] },
});
const version = await browser.version();
const factory = await pageFactory(browser, mode, { viewport: { width: W, height: H } });
const results = [];

console.log(`backdrop-probe  mode=${mode}  browser=${version}`);
console.log(`parent=http://${PARENT_HOST}:${PARENT_PORT}  child(cross-origin)=http://${CHILD_HOST}:${CHILD_PORT}\n`);

try {
  for (const c of cases) {
    const handle = await factory.fresh();
    const page = handle.page;
    let row;
    try {
      await page.goto(`http://${PARENT_HOST}:${PARENT_PORT}${c.path}`, { waitUntil: 'load' });
      const ready = await page.evaluate(() => window.__probeReady ?? 'no-hook').catch((e) => 'err:' + e.message);
      await sleep(600);
      const shot = await page.screenshot({ clip: { x: 0, y: 0, width: W, height: H }, encoding: 'binary' });
      fs.writeFileSync(path.join(shotDir, `${mode}-${W}x${H}-${c.path.split('/').pop()}.png`), shot);
      const stats = await page.evaluate(READ, Buffer.from(shot).toString('base64'), REGIONS, W, H);
      let frames = null;
      if (c.oopif) {
        const targets = await listTargets(mode === 'connect' ? endpoint : browser).catch(() => []);
        const iframes = (targets || []).filter((t) => t.type === 'iframe').map((t) => t.url);
        frames = { oopifTargets: iframes, isOOPIF: iframes.some((u) => u.includes(`:${CHILD_PORT}`)) };
      }
      row = {
        case: c.name, path: c.path, ready, frames,
        scale: stats.__scale,
        underLeft: { ...stats.underLeft, over: c.left, verdict: classify(stats.underLeft) },
        underRight: { ...stats.underRight, over: c.right, verdict: classify(stats.underRight) },
        outside: { ...stats.outside, verdict: classify(stats.outside) },
      };
      row.valid = row.outside.verdict === 'sharp';
    } catch (e) {
      row = { case: c.name, path: c.path, error: String(e && e.message || e), valid: false };
    } finally {
      await factory.release(handle);
    }
    results.push(row);
    if (row.error) {
      console.log(`${row.case.padEnd(46)} ERROR ${row.error}`);
    } else {
      const f = (r) => `${r.verdict}(${r.min}-${r.max}, mean ${r.mean})`;
      console.log(`${row.case.padEnd(46)} left[${row.underLeft.over}] ${f(row.underLeft)}  right[${row.underRight.over}] ${f(row.underRight)}  outside ${f(row.outside)}${row.valid ? '' : '  <-- INVALID: 底下的条纹没画出来'}${row.frames ? `  OOPIF=${row.frames.isOOPIF}` : ''}`);
    }
  }
} finally {
  await close();
  await closeAll(servers);
}

const report = { probe: 'backdrop', mode, browser: version, when: new Date().toISOString(), shotDir, results };
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2));
console.log(`\n截图: ${shotDir}${jsonOut ? `\nJSON: ${jsonOut}` : ''}`);
