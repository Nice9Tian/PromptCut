/**
 * M7 契约第 8 节 P4(`docs/plan/m7-contract.md`):在线页面(父页、主文档)把一段生成的快照推到素材服务 ——
 * 60 块原尺寸 HTML(`snap/`)+ 60 张小尺寸 WebP(`px/`):WebCrypto 算 sha256、分片接口(`GET chunks` → `PUT …/0` → `POST complete`)、
 * 耗时、主文档长任务。报告:docs/reports/AGENT-m7-probe.md。
 *
 *   node scripts/probes/m7-upload-probe.mjs --frames <目录,里面是 <n>.html> --smalls <目录,里面是 <n>.small.webp 或 <clip>-<n>-*.webp>
 *        [--port 5713] [--doc-port 5718] [--asset-port 5719] [--concurrency 1,4] [--rounds 3]
 *
 * 本机替身:托管组合(`server/hosted/combo.mjs`,临时数据目录,只绑 127.0.0.1);`--port` 上一个仿 nginx 的前缀代理,
 * 父页与 `/media/`(→ 素材服务)同源(同托管端的布置),每个响应带 `Origin-Agent-Cluster: ?1`。回环来源按本机信任,
 * 所以写入不核票据(真托管端关掉本机信任、每个请求核一次 HMAC 票据);请求照样带 `Authorization: Bearer <假票据>` 头,
 * 同源不触发预检。
 *
 * 每轮:先清空素材服务(新数据目录),父页把 120 个块读进内存(不计时),然后按并发度逐块:哈希 → chunks → PUT → complete,
 * 记总耗时、每块耗时、主文档 longtask 与 rAF 间隔;再推一遍同样的块(全部 `complete: true`,只查不传 = 去重路)。
 * 输出:过程写 stderr;最后一行 stdout 是一行 JSON。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer';
import { flagArg, sleep } from './probe-connect.mjs';

const PORT = Number(flagArg('port', '5713'));
const DOC = Number(flagArg('doc-port', '5718'));
const ASSET = Number(flagArg('asset-port', '5719'));
const FRAMES = path.resolve(flagArg('frames'));
const SMALLS = path.resolve(flagArg('smalls'));
const CONC = (flagArg('concurrency') || '1,4').split(',').map(Number);
const ROUNDS = Number(flagArg('rounds', '3'));
const log = (...a) => console.error(...a);
function winLoad() {
  try { return Number(execFileSync('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average'], { encoding: 'utf8', timeout: 20000 }).trim()); } catch { return null; }
}

const htmls = fs.readdirSync(FRAMES).filter((n) => /^\d+\.html$/.test(n)).sort((a, b) => parseInt(a) - parseInt(b)).slice(0, 60).map((n) => fs.readFileSync(path.join(FRAMES, n)).toString('base64'));
const smalls = fs.readdirSync(SMALLS).filter((n) => n.endsWith('.webp')).slice(0, 60).map((n) => fs.readFileSync(path.join(SMALLS, n)).toString('base64'));
log(`blobs: ${htmls.length} html (${Math.round(htmls.reduce((n, b) => n + b.length * 0.75, 0) / 1024)} KiB), ${smalls.length} webp (${Math.round(smalls.reduce((n, b) => n + b.length * 0.75, 0) / 1024)} KiB)`);

const PAGE = `<!doctype html><meta charset=utf-8><title>m7 upload</title><body><div id=head style="position:absolute;top:0;width:2px;height:20px;background:#c00"></div><script>
const lts = []; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) lts.push(+e.duration.toFixed(1)); }).observe({ type: 'longtask' }); } catch {}
let gaps = null, last = performance.now(), f = 0;
(function raf() { const now = performance.now(); if (gaps) gaps.push(now - last); last = now; f++; document.getElementById('head').style.left = (f % 600) + 'px'; requestAnimationFrame(raf); })();
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
let blobs = [];
window.__load = (html, webp) => { blobs = [...html.map((s) => ({ ns: 'snap', ext: 'html', bytes: b64(s) })), ...webp.map((s) => ({ ns: 'px', ext: 'webp', bytes: b64(s) }))]; return blobs.length; };
async function hex(bytes) { const d = await crypto.subtle.digest('SHA-256', bytes); return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join(''); }
async function pushOne(b) {
  const t0 = performance.now();
  const hash = await hex(b.bytes);
  const th = performance.now();
  const base = '/media/api/asset/' + b.ns + '/' + hash;
  const auth = { Authorization: 'Bearer probe-not-a-ticket' };
  const st = await (await fetch(base + '/chunks', { headers: auth })).json();
  let put = false;
  if (!st.complete) {
    if (!(st.received || []).includes(0)) {
      const r = await fetch(base + '/0', { method: 'PUT', headers: { ...auth, 'X-Media-Size': String(b.bytes.length), 'X-Media-Ext': b.ext, 'Content-Type': 'application/octet-stream' }, body: b.bytes });
      if (!r.ok) throw new Error('PUT ' + r.status + ' ' + (await r.text()).slice(0, 100));
    }
    const c = await fetch(base + '/complete', { method: 'POST', headers: auth });
    if (!c.ok) throw new Error('complete ' + c.status + ' ' + (await c.text()).slice(0, 100));
    put = true;
  }
  return { ms: performance.now() - t0, hashMs: th - t0, put, bytes: b.bytes.length };
}
window.__run = async (conc) => {
  gaps = []; const lt0 = lts.length;
  const t0 = performance.now(); const rows = []; let i = 0;
  const worker = async () => { while (i < blobs.length) { const b = blobs[i++]; rows.push(await pushOne(b)); } };
  await Promise.all(Array.from({ length: conc }, worker));
  const total = performance.now() - t0; const g = gaps; gaps = null;
  return { total, rows, lts: lts.slice(lt0), gaps: g };
};
</script>`;

const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1) : null; };
const results = [];
const { startHostedCombo } = await import('../../server/hosted/combo.mjs');
for (let r = 1; r <= ROUNDS; r++) for (const conc of CONC) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm7-upload-'));
  const combo = await startHostedCombo({ dataDir, docPort: DOC, assetPort: ASSET, host: '127.0.0.1', assetPublicUrl: `http://127.0.0.1:${PORT}/media/api/asset`, docPublicUrl: `ws://127.0.0.1:${PORT}/hosted/`, log: () => {} });
  const proxy = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/media/')) {
      const up = http.request({ host: '127.0.0.1', port: ASSET, method: req.method, path: req.url.slice('/media'.length), headers: req.headers }, (ur) => { res.writeHead(ur.statusCode ?? 502, { ...ur.headers, 'origin-agent-cluster': '?1' }); ur.pipe(res); });
      up.on('error', () => { res.writeHead(502); res.end(); });
      return req.pipe(up);
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'origin-agent-cluster': '?1' });
    res.end(PAGE);
  });
  await new Promise((ok) => proxy.listen(PORT, '127.0.0.1', ok));
  const browser = await puppeteer.launch({ headless: true, args: ['--disable-gpu'] });
  try {
    const wl = winLoad();
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
    await page.evaluate((h, w) => window.__load(h, w), htmls, smalls);
    await sleep(500);
    for (const pass of ['fresh', 'dedup']) {
      const out = await page.evaluate((c) => window.__run(c), conc);
      const rows = out.rows;
      const row = { round: r, conc, pass, winLoad: wl, blobs: rows.length, uploaded: rows.filter((x) => x.put).length, bytes: rows.reduce((n, x) => n + x.bytes, 0),
        totalMs: Math.round(out.total), perBlobMs: { p50: q(rows.map((x) => x.ms), 0.5), p95: q(rows.map((x) => x.ms), 0.95), max: q(rows.map((x) => x.ms), 1) },
        hashMs: { p50: q(rows.map((x) => x.hashMs), 0.5), p95: q(rows.map((x) => x.hashMs), 0.95), max: q(rows.map((x) => x.hashMs), 1) },
        longTasks: out.lts.length, ltMs: out.lts, rafP95: q(out.gaps, 0.95), rafMax: q(out.gaps, 1) };
      results.push(row);
      log(JSON.stringify(row));
    }
  } catch (e) {
    results.push({ round: r, conc, error: String(e.stack || e) });
    log('ERROR', String(e.message || e));
  } finally {
    await browser.close().catch(() => {});
    await new Promise((ok) => proxy.close(ok));
    await combo.close?.().catch?.(() => {});
    await combo.stop?.().catch?.(() => {});
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 临时目录 */ }
  }
}
console.log(JSON.stringify({ results }));
process.exit(0);
