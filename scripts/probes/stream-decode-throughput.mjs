// G0-b (4)：解码吞吐。N = 1、2、4、6 个 VideoDecoder 同时解
//   - 1080p 上下拼合（1920x2176）
//   - 一个小裁剪（640x720 -> 拼合后 640x1456；这里按 r75-05 的偶数外扩口径算：640 x (720*2+16)）
// 量每个解码器的稳态每帧耗时、N 个同开时能否维持 30 fps 和 60 fps；
// 另外单独量「VideoFrame 不及时 close() 时的内存表现」。
// 结论用来定「同时活跃的解码器预算」（G1 的 N，初值 6）。
//
//   node scripts/probes/stream-decode-throughput.mjs --json out.json
//   node scripts/probes/stream-decode-throughput.mjs --ns 1,2,4,6 --repeats 3 --segments 8
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findFfmpeg, ffmpegVersion, encodeSegment, splitFmp4, initInfo,
  syntheticFrame, encodePng, even, stats, writeJson, arg,
} from './stream-common.mjs';
import { openBrowser, pageFactory, serve, closeAll } from './probe-connect.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const NS = String(arg('ns', '1,2,4,6')).split(',').map(Number);
const SEGMENTS = Number(arg('segments', '8'));   // 8 x 15 = 120 帧
const REPEATS = Number(arg('repeats', '3'));
const FPS = Number(arg('fps', '30'));
const PORT = Number(arg('port', '5246'));
const workDir = String(arg('out', path.join(os.tmpdir(), 'pc-stream-throughput')));
const jsonOut = arg('json');
const headful = process.argv.includes('--headful');

const GEOMS = [
  { id: 'full1080', W: even(1920), H: even(1080) },
  { id: 'crop640', W: even(640), H: even(720) },
];

fs.rmSync(workDir, { recursive: true, force: true });
fs.mkdirSync(workDir, { recursive: true });
const ffmpeg = findFfmpeg();

const report = {
  probe: 'stream-decode-throughput',
  when: new Date().toISOString(),
  env: { ffmpeg: await ffmpegVersion(ffmpeg), node: process.version, fps: FPS, ns: NS, segments: SEGMENTS, repeats: REPEATS, headful },
  streams: [], runs: [], retention: [],
};

// ── 造流 ────────────────────────────────────────────────────────────────────
for (const g of GEOMS) {
  const dir = path.join(workDir, g.id);
  fs.mkdirSync(dir, { recursive: true });
  console.log(`造流 ${g.id}：${g.W}x${g.H} -> ${g.W}x${g.H * 2 + 16}，${SEGMENTS} 段…`);
  let init = null;
  for (let s = 0; s < SEGMENTS; s++) {
    const pngs = [];
    for (let i = 0; i < 15; i++) pngs.push(encodePng(syntheticFrame(g.W, g.H, s * 15 + i), g.W, g.H));
    const res = await encodeSegment(ffmpeg, pngs, { encoder: 'libx264', fps: FPS });
    const split = splitFmp4(res.buffer);
    if (!init) { init = split.init; fs.writeFileSync(path.join(dir, 'init.mp4'), init); }
    fs.writeFileSync(path.join(dir, `seg-${String(s).padStart(3, '0')}.m4s`), split.segments[0]);
  }
  const info = initInfo(init);
  const bytes = fs.readdirSync(dir).reduce((s, f) => s + fs.statSync(path.join(dir, f)).size, 0);
  report.streams.push({ ...g, stackedH: g.H * 2 + 16, codec: info.codec, segments: SEGMENTS, bytes });
  console.log(`  codec ${info.codec}，共 ${(bytes / 1024).toFixed(0)} KB`);
}

// ── 页面 ────────────────────────────────────────────────────────────────────
const server = await serve(PORT, (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end('<!doctype html><meta charset="utf-8"><body></body>'); }
  if (u.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
  const f = path.join(workDir, decodeURIComponent(u.pathname).replace(/^[/\\]+/, ''));
  if (!f.startsWith(workDir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': 'video/mp4', 'cache-control': 'no-store' });
  res.end(fs.readFileSync(f));
}, '127.0.0.1');

const { browser, mode, close } = await openBrowser({
  launch: { headless: !headful, protocolTimeout: 600000, args: ['--autoplay-policy=no-user-gesture-required'] },
});
const factory = await pageFactory(browser, mode);
const handle = await factory.fresh();
const page = handle.page;
page.on('console', (m) => { if (m.type() === 'error') console.log('PAGE ERR:', m.text().slice(0, 200)); });

try {
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await page.addScriptTag({ path: path.join(here, 'stream-demux-browser.js') });
  report.ua = await page.evaluate(() => navigator.userAgent);
  report.gpu = await page.evaluate(() => {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl');
      const e = gl.getExtension('WEBGL_debug_renderer_info');
      return e ? String(gl.getParameter(e.UNMASKED_RENDERER_WEBGL)) : null;
    } catch { return null; }
  });
  console.log(`\n页面：${report.ua.match(/(Chrome|Edg)\/[\d.]+/)?.[0]}  GL: ${report.gpu}\n`);

  // 把整条流的字节先拉到页面里，之后每一轮都从内存喂，避免把 fetch 算进吞吐
  await page.evaluate(async (opts) => {
    window.__streams = {};
    for (const g of opts.geoms) {
      const init = await (await fetch(`/${g.id}/init.mp4`)).arrayBuffer();
      const segs = [];
      for (let s = 0; s < opts.segments; s++) segs.push(await (await fetch(`/${g.id}/seg-${String(s).padStart(3, '0')}.m4s`)).arrayBuffer());
      window.__streams[g.id] = { init, segs };
    }
  }, { geoms: GEOMS.map((g) => ({ id: g.id })), segments: SEGMENTS });

  // ── 吞吐：N 个解码器同开，全速解 SEGMENTS x 15 帧 ──────────────────────────
  for (const g of GEOMS) {
    for (const composite of [false, true]) {
      for (const N of NS) {
        const rounds = [];
        for (let r = 0; r < REPEATS; r++) {
          const res = await page.evaluate(async (o) => {
            const { id, N, fps, composite, contentH } = o;
            const st = window.__streams[id];
            const init = PCStream.parseInit(st.init);
            const comps = [];
            if (composite) for (let i = 0; i < N; i++) { const c = document.createElement('canvas'); comps.push(PCStream.makeCompositor(c, {})); }

            const per = Array.from({ length: N }, () => ({ intervals: [], count: 0, last: 0, first: 0 }));
            const decs = [];
            const errs = [];
            for (let i = 0; i < N; i++) {
              const rec = per[i];
              const dec = new VideoDecoder({
                output: (f) => {
                  const now = performance.now();
                  if (composite) { comps[i].draw(f, contentH); }
                  f.close();                       // 立刻还回去，这是 G5 的口径
                  if (rec.count === 0) rec.first = now; else rec.intervals.push(now - rec.last);
                  rec.last = now; rec.count++;
                },
                error: (e) => errs.push(String(e)),
              });
              dec.configure({ codec: init.codec, description: init.description, codedWidth: init.width, codedHeight: init.height, hardwareAcceleration: 'prefer-hardware' });
              decs.push(dec);
            }
            const t0 = performance.now();
            // N 个解码器同时开灌：全部分段按序喂进去
            for (let s = 0; s < st.segs.length; s++) {
              for (let i = 0; i < N; i++) {
                for (const c of PCStream.chunksOf(st.segs[s], { segmentIndex: s, fps, perSegment: 15 })) decs[i].decode(c);
              }
            }
            await Promise.all(decs.map((d) => d.flush()));
            const wallMs = performance.now() - t0;
            for (const d of decs) d.close();
            const med = (xs) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[a.length >> 1] : null; };
            const p90 = (xs) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.round(0.9 * (a.length - 1))] : null; };
            const all = per.flatMap((p) => p.intervals);
            return {
              N, wallMs: +wallMs.toFixed(1), totalFrames: per.reduce((s, p) => s + p.count, 0),
              perDecoderFrames: per.map((p) => p.count),
              perFrameMsP50: med(all) == null ? null : +med(all).toFixed(3),
              perFrameMsP90: p90(all) == null ? null : +p90(all).toFixed(3),
              perFrameMsMax: all.length ? +Math.max(...all).toFixed(3) : null,
              errs,
            };
          }, { id: g.id, N, fps: FPS, composite, contentH: g.H });
          rounds.push(res);
        }
        const wall = rounds.map((r) => r.wallMs);
        const total = rounds[0].totalFrames;
        const perDecFps = rounds.map((r) => (r.totalFrames / r.N) / (r.wallMs / 1000));
        const entry = {
          geom: g.id, composite, N,
          wallMs: stats(wall), totalFrames: total,
          perDecoderFps: stats(perDecFps),
          aggregateFps: stats(rounds.map((r) => r.totalFrames / (r.wallMs / 1000))),
          perFrameMsP50: stats(rounds.map((r) => r.perFrameMsP50).filter((x) => x != null)),
          perFrameMsP90: stats(rounds.map((r) => r.perFrameMsP90).filter((x) => x != null)),
          sustains30: perDecFps.every((f) => f >= 30),
          sustains60: perDecFps.every((f) => f >= 60),
          errs: rounds.flatMap((r) => r.errs),
        };
        report.runs.push(entry);
        console.log(`${g.id} ${composite ? '解码+合成' : '只解码  '} N=${N}: 每解码器 ${entry.perDecoderFps.p50.toFixed(1)} fps（${perDecFps.map((f) => f.toFixed(0)).join('/')}），` +
          `合计 ${entry.aggregateFps.p50.toFixed(0)} fps，帧间隔 p50 ${entry.perFrameMsP50.p50} ms p90 ${entry.perFrameMsP90.p50} ms  ` +
          `| 30fps ${entry.sustains30 ? 'OK' : 'NO'} 60fps ${entry.sustains60 ? 'OK' : 'NO'}${entry.errs.length ? ' ERR ' + entry.errs[0].slice(0, 80) : ''}`);
      }
    }
  }

  // ── VideoFrame 不 close() 会怎样 ────────────────────────────────────────────
  console.log('');
  for (const g of GEOMS) {
    const r = await page.evaluate(async (o) => {
      const { id, fps, bytesPerFrame } = o;
      const st = window.__streams[id];
      const init = PCStream.parseInit(st.init);
      const held = [];
      let stalled = false, err = null;
      const dec = new VideoDecoder({ output: (f) => held.push(f), error: (e) => { err = String(e); } });
      dec.configure({ codec: init.codec, description: init.description, codedWidth: init.width, codedHeight: init.height, hardwareAcceleration: 'prefer-hardware' });
      // 一次喂一个分段，喂完等它出帧；2 秒没有新帧就判定卡住
      for (let s = 0; s < st.segs.length && !stalled && !err; s++) {
        const before = held.length;
        for (const c of PCStream.chunksOf(st.segs[s], { segmentIndex: s, fps, perSegment: 15 })) dec.decode(c);
        const t0 = performance.now();
        while (held.length < before + 15) {
          await new Promise((r) => setTimeout(r, 20));
          if (performance.now() - t0 > 2000) { stalled = true; break; }
        }
      }
      const heldCount = held.length;
      let flushOk = false;
      if (!stalled) {
        flushOk = await Promise.race([dec.flush().then(() => true), new Promise((r) => setTimeout(() => r(false), 3000))]);
      }
      for (const f of held) f.close();
      try { dec.close(); } catch {}
      return { heldCount, stalled, flushOk, err, estMB: +(heldCount * bytesPerFrame / 1e6).toFixed(1) };
    }, { id: g.id, fps: FPS, bytesPerFrame: g.W * (g.H * 2 + 16) * 1.5 });
    const fed = SEGMENTS * 15;
    report.retention.push({ geom: g.id, fedFrames: fed, ...r, bytesPerFrameNv12: g.W * (g.H * 2 + 16) * 1.5 });
    console.log(`不 close：${g.id} 喂了 ${fed} 帧，攒住 ${r.heldCount} 帧（约 ${r.estMB} MB NV12）${r.stalled ? ' -> 解码器卡住' : `，flush ${r.flushOk ? 'OK' : '超时'}`}${r.err ? ' ERR ' + r.err.slice(0, 80) : ''}`);
  }
} finally {
  await factory.release(handle).catch(() => {});
  await close();
  await closeAll([server]);
}

if (jsonOut) console.log(`\nJSON -> ${writeJson(String(jsonOut), report)}`);
