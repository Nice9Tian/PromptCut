// G0-b (6)：出帧节奏。两半：
//
//   seek    —— 解码侧「回放到第 N 帧的耗时曲线」：只给 init + 一个分段，新建 VideoDecoder，
//              量到第 N 帧可用为止的耗时（N = 0..14；随机访问最坏要从 IDR 解 14 帧）。
//   produce —— 生产侧：resetMs（换页 / 重置会话）、稳态 frameMs（截图 + 喂编码器）、
//              「从头回放到第 N 帧」的耗时曲线、以及**两个 ffmpeg 编码器并存时**的出帧节奏。
//
// produce 这一半要先起 dev server：npx vite --port 5201 --strictPort --host 127.0.0.1
//
//   node scripts/probes/stream-cadence.mjs --half both --card growth-curve --json out.json
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findFfmpeg, ffmpegVersion, encodeSegment, splitFmp4, syntheticFrame, encodePng,
  even, stats, median, writeJson, arg,
} from './stream-common.mjs';
import { openBrowser, pageFactory, serve, closeAll } from './probe-connect.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const HALF = String(arg('half', 'both'));
const ORIGIN = String(arg('origin', 'http://127.0.0.1:5201')).replace(/\/+$/, '');
const CARD = String(arg('card', 'growth-curve'));
const FPS = Number(arg('fps', '30'));
const W = even(Number(arg('w', '1920'))), H = even(Number(arg('h', '1080')));
const REPEATS = Number(arg('repeats', '3'));
const PORT = Number(arg('port', '5247'));
const workDir = String(arg('out', path.join(os.tmpdir(), 'pc-stream-cadence')));
const jsonOut = arg('json');

fs.rmSync(workDir, { recursive: true, force: true });
fs.mkdirSync(workDir, { recursive: true });
const ffmpeg = findFfmpeg();

const report = {
  probe: 'stream-cadence',
  when: new Date().toISOString(),
  env: { ffmpeg: await ffmpegVersion(ffmpeg), node: process.version, fps: FPS, card: CARD, w: W, h: H, repeats: REPEATS },
  seek: null, produce: null,
};

// ── 解码侧：回放到第 N 帧的耗时曲线 ─────────────────────────────────────────
if (HALF === 'seek' || HALF === 'both') {
  console.log('=== seek：解码侧回放曲线 ===');
  const pngs = [];
  for (let i = 0; i < 15; i++) pngs.push(encodePng(syntheticFrame(W, H, i), W, H));
  const res = await encodeSegment(ffmpeg, pngs, { encoder: 'libx264', fps: FPS, range: 'tv' });
  const split = splitFmp4(res.buffer);
  fs.writeFileSync(path.join(workDir, 'init.mp4'), split.init);
  fs.writeFileSync(path.join(workDir, 'seg-000.m4s'), split.segments[0]);

  const server = await serve(PORT, (req, res2) => {
    const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (u.pathname === '/') { res2.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res2.end('<!doctype html><meta charset="utf-8"><body><canvas id="c"></canvas>'); }
    if (u.pathname === '/favicon.ico') { res2.writeHead(204); return res2.end(); }
    const f = path.join(workDir, path.basename(u.pathname));
    if (!fs.existsSync(f)) { res2.writeHead(404); return res2.end(); }
    res2.writeHead(200, { 'content-type': 'video/mp4', 'cache-control': 'no-store' });
    res2.end(fs.readFileSync(f));
  }, '127.0.0.1');

  const { browser, mode, close } = await openBrowser({ launch: { headless: true, protocolTimeout: 600000 } });
  const factory = await pageFactory(browser, mode);
  const handle = await factory.fresh();
  const page = handle.page;
  try {
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
    await page.addScriptTag({ path: path.join(here, 'stream-demux-browser.js') });
    const ua = await page.evaluate(() => navigator.userAgent);
    const r = await page.evaluate(async (o) => {
      const { fps, contentH, repeats } = o;
      const initBuf = await (await fetch('init.mp4')).arrayBuffer();
      const segBuf = await (await fetch('seg-000.m4s')).arrayBuffer();
      const init = PCStream.parseInit(initBuf);
      const comp = PCStream.makeCompositor(document.getElementById('c'), {});
      const rows = [];
      // 先跑一次热身，把解码器的首次初始化开销从曲线里摘掉（它单独量）
      const once = async (target, composite) => {
        const chunks = PCStream.chunksOf(segBuf, { segmentIndex: 0, fps, perSegment: 15 });
        let got = 0, doneAt = null;
        const t0 = performance.now();
        const dec = new VideoDecoder({
          output: (f) => {
            if (composite && got === target) comp.draw(f, contentH);
            f.close();
            if (got === target && doneAt == null) doneAt = performance.now() - t0;
            got++;
          },
          error: () => {},
        });
        dec.configure({ codec: init.codec, description: init.description, codedWidth: init.width, codedHeight: init.height, hardwareAcceleration: 'prefer-hardware' });
        // 只喂到目标帧为止：随机访问就是从 IDR 解到目标，不用解完整段
        for (let i = 0; i <= target; i++) dec.decode(chunks[i]);
        await dec.flush();
        dec.close();
        return doneAt;
      };
      const coldFirst = await once(0, false);   // 含解码器冷启动
      for (const target of [0, 1, 2, 4, 7, 10, 14]) {
        const ms = [], msComp = [];
        for (let r = 0; r < repeats; r++) ms.push(await once(target, false));
        for (let r = 0; r < repeats; r++) msComp.push(await once(target, true));
        rows.push({ target, decodeMs: ms, compositeMs: msComp });
      }
      return { coldFirstMs: +coldFirst.toFixed(2), rows, codec: init.codec, size: `${init.width}x${init.height}` };
    }, { fps: FPS, contentH: H, repeats: REPEATS });

    report.seek = {
      ua, codec: r.codec, size: r.size, coldFirstMs: r.coldFirstMs,
      rows: r.rows.map((x) => ({ target: x.target, decodeMs: stats(x.decodeMs), compositeMs: stats(x.compositeMs) })),
    };
    console.log(`  ${ua.match(/(Chrome|Edg)\/[\d.]+/)?.[0]}  ${r.size} ${r.codec}；解码器冷启动含首帧 ${r.coldFirstMs} ms`);
    for (const row of report.seek.rows) {
      console.log(`  到第 ${String(row.target).padStart(2)} 帧：解码 ${String(row.decodeMs.p50).padStart(6)} ms（${row.decodeMs.min}～${row.decodeMs.max}），解码+合成 ${String(row.compositeMs.p50).padStart(6)} ms`);
    }
  } finally {
    await factory.release(handle).catch(() => {});
    await close();
    await closeAll([server]);
  }
}

// ── 生产侧：resetMs / frameMs / 回放曲线 / 两编码器并存 ──────────────────────
if (HALF === 'produce' || HALF === 'both') {
  console.log('\n=== produce：生产侧出帧节奏 ===');
  const { openBakery } = await import('../../server/bakery/chrome.mjs');
  const { bakeFrames } = await import('../../server/bakery/bake.mjs');

  const mkProject = (cardId, lenSec) => ({
    version: 1, id: 'g0b', name: 'g0b', width: W, height: H, fps: FPS, duration: lenSec,
    themeId: 'midnight', media: [],
    tracks: [{ id: 'g0b-track', clips: [{ id: 'c0', cardId, start: 0, end: lenSec, params: {} }] }],
  });
  const lenSec = +(60 / FPS).toFixed(6);
  const outBase = path.join(workDir, 'bake');

  const bakery = await openBakery({ url: `${ORIGIN}/?export=1` });
  const produce = { resetMs: [], replay: [], steady: null, withEncoders: null };
  try {
    // 1) resetMs：换页 / 重置会话
    for (let r = 0; r < REPEATS + 2; r++) {
      const t0 = performance.now();
      await bakery.reset(mkProject(CARD, lenSec), `${ORIGIN}/?export=1`);
      produce.resetMs.push(+(performance.now() - t0).toFixed(1));
    }
    console.log(`  resetMs（换页 + 灌项目 + 等就绪）：p50 ${stats(produce.resetMs).p50} ms（${produce.resetMs.join('/')}）`);

    // 2) 回放曲线：每次从干净会话开始，预渲染 0..N，量总墙钟
    const bakeTo = async (n, dir) => {
      await bakery.reset(mkProject(CARD, lenSec), `${ORIGIN}/?export=1`);
      const t0 = performance.now();
      await bakeFrames(bakery, { out: dir, fps: FPS, frames: `0-${n}`, fullFrame: true, format: 'png', warm: 3, staticSkip: false });
      return +(performance.now() - t0).toFixed(1);
    };
    for (const n of [0, 1, 2, 4, 7, 10, 14, 29, 44]) {
      const ms = [];
      for (let r = 0; r < REPEATS; r++) ms.push(await bakeTo(n, path.join(outBase, `n${n}-r${r}`)));
      produce.replay.push({ toFrame: n, frames: n + 1, ms: stats(ms), list: ms });
      console.log(`  预渲染到第 ${String(n).padStart(2)} 帧（${n + 1} 帧）：p50 ${stats(ms).p50} ms（${ms.join('/')}）`);
    }
    // 斜率 = 稳态 frameMs；截距 = 这一趟的固定开销（挂载 + 热身），不含 reset
    const a = produce.replay.find((x) => x.toFrame === 4), b = produce.replay.find((x) => x.toFrame === 44);
    const frameMs = +((b.ms.p50 - a.ms.p50) / (44 - 4)).toFixed(2);
    const fixedMs = +(a.ms.p50 - frameMs * 5).toFixed(1);
    produce.steady = { frameMs, fixedMsPerRun: fixedMs, note: '斜率取 frames 4->44 的 p50 差' };
    console.log(`  稳态 frameMs = ${frameMs} ms/帧；每趟固定开销（挂载+热身，不含 reset）≈ ${fixedMs} ms`);

    // 3) 两个 ffmpeg 编码器并存时的出帧节奏
    const pngs = [];
    for (let i = 0; i < 15; i++) pngs.push(encodePng(syntheticFrame(W, H, i), W, H));
    let keepEncoding = true;
    const encoderLoop = async () => {
      while (keepEncoding) await encodeSegment(ffmpeg, pngs, { encoder: 'libx264', fps: FPS, range: 'tv' }).catch(() => {});
    };
    const loops = [encoderLoop(), encoderLoop()];   // G4：同时存活的分段编码器 ≤ 2 × streamPool
    const ms = [];
    for (let r = 0; r < REPEATS; r++) ms.push(await bakeTo(44, path.join(outBase, `enc-r${r}`)));
    keepEncoding = false;
    await Promise.all(loops);
    const busyFrameMs = +((stats(ms).p50 - fixedMs) / 45).toFixed(2);
    produce.withEncoders = { bakeMs: stats(ms), list: ms, approxFrameMs: busyFrameMs, idleFrameMs: frameMs, ratio: +(busyFrameMs / frameMs).toFixed(2) };
    console.log(`  两个编码器并存时预渲染 45 帧：p50 ${stats(ms).p50} ms（${ms.join('/')}）-> 约 ${busyFrameMs} ms/帧，是空闲时的 ${produce.withEncoders.ratio} 倍`);
  } finally {
    await bakery.close().catch(() => {});
  }
  report.produce = produce;
}

if (jsonOut) console.log(`\nJSON -> ${writeJson(String(jsonOut), report)}`);
