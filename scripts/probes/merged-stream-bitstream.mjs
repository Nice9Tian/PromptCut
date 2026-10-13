// 合并流评估 · 第 2 问的乙：不重新编码，直接把几条单卡流的码流拼成一条（最小原型）。
//
// 原理：H.264 的一幅画面由若干条带（slice）组成，条带之间互不依赖（帧内预测、运动矢量预测、熵编码都不跨条带）。
// 把每张卡的条带原样拿来，只改条带头里的几项（first_mb_in_slice 指到它在大画面里的位置、frame_num 换成合并流自己的、
// 去块滤波改成不跨条带边界），宏块数据一个比特不动，就能放进同一幅更大的画面。工具在 merged-stream-h264.mjs。
//
// 条带里的宏块按光栅顺序连着排，所以：
//   - 一张卡一幅一条带（产品现在这样）→ 只能**竖着叠**，而且每一格要和合并画面**一样宽**；
//   - 想**横着拼**，每张卡编码时就得「每一行宏块一条带」（x264: sliced-threads=1:slice-max-mbs=<宽的宏块数>），
//     这样一行里可以先放甲卡的条带、再放乙卡的条带。
// 这支探针两种都试，并核对：
//   1. 用 ffmpeg 软解合并流，逐格逐帧和各自单独解出来的画面比（Y、U、V 三个平面逐字节）；
//   2. 在无头 Chrome 里用硬件解码器解合并流（NV12），逐格逐帧的 Y 平面和上面的结果比哈希；
//   3. 各卡关键帧不对齐（一幅里有的格是 I 条带、有的是 P 条带）、某一格还没开始或者从半截起（用全黑的垫片条带顶上）时还对不对。
// 运动矢量可以指到画面外面（x264 允许超出边界 24 像素左右，参考的是边缘像素的延伸）；拼起来以后「外面」变成了邻格，
// 所以每格四周要有一圈一样的黑边才不串。探针分「带 32 像素黑边」和「不带黑边」两种内容各量一遍，看差多少。
//
//   node scripts/probes/merged-stream-bitstream.mjs --port 27900 [--browser puppeteer] [--json <文件>]
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { arg, runFfmpeg, serveLocal, closeServer, launchHeadless, cpuBusy, writeJson, workDir, levelFor, PRODUCT_X264, COLOR_TAGS } from './merged-stream-common.mjs';
import { readStream, stitch, compatible } from './merged-stream-h264.mjs';

const PORT = Number(arg('port', '27900'));
const WHICH = String(arg('browser', 'puppeteer'));
const jsonOut = arg('json');
const dir = workDir('bitstream');
const FPS = 30, FRAMES = 45;
const sha = (b) => createHash('sha256').update(b).digest('hex').slice(0, 16);

/**
 * 造一格的码流。内容：testsrc2 加一个竖着横着都在动的滚动（专门让运动矢量往边界外指）；
 * margin > 0 时四周留这么宽的纯黑边（内容缩在里面）。extra：追加的 x264 参数。回 Annex-B。
 */
async function encodeCell({ w, h, seed, margin = 0, extra = [], frames = FRAMES, black = false }) {
  const inner = `${w - 2 * margin}x${h - 2 * margin}`;
  const src = black ? `color=c=black:s=${w}x${h}:r=${FPS}` : `testsrc2=s=${inner}:r=${FPS}`;
  // scroll 让画面整体平移（每帧横竖各挪一点，方向随 seed 变），再垫黑边
  const vf = black ? 'format=yuv420p' : `scroll=h=${(0.004 * (1 + (seed % 3))).toFixed(4)}:v=${(0.006 * (1 + ((seed >> 1) % 3))).toFixed(4)},hue=h=${seed * 47},pad=${w}:${h}:${margin}:${margin}:black,scale=out_range=tv:out_color_matrix=bt709,format=yuv420p`;
  const res = await runFfmpeg(['-f', 'lavfi', '-i', src, '-frames:v', String(frames), '-vf', vf, ...PRODUCT_X264, ...extra, ...COLOR_TAGS, '-f', 'h264', 'pipe:1'], { bench: true });
  if (res.code !== 0) throw new Error(`造流失败：${res.stderr.split(/\r?\n/).slice(-3).join(' | ')}`);
  return { annexb: res.stdout, cpuMs: res.cpuMs };
}

/** ffmpeg 软解一条 Annex-B → 每帧 { y, u, v }（Buffer） */
async function decode(annexb, w, h) {
  const res = await runFfmpeg(['-f', 'h264', '-i', 'pipe:0', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', 'pipe:1'], { input: annexb });
  const size = w * h * 3 / 2;
  const frames = [];
  for (let o = 0; o + size <= res.stdout.length; o += size) frames.push({ y: res.stdout.subarray(o, o + w * h), u: res.stdout.subarray(o + w * h, o + w * h * 5 / 4), v: res.stdout.subarray(o + w * h * 5 / 4, o + size) });
  return { frames, stderr: res.stderr, code: res.code };
}
const crop = (plane, stride, x, y, w, h) => { const out = Buffer.alloc(w * h); for (let r = 0; r < h; r++) plane.copy(out, r * w, (y + r) * stride + x, (y + r) * stride + x + w); return out; };
function diff(a, b) { let max = 0, n = 0; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d) { n++; if (d > max) max = d; } } return { max, pixels: n }; }

/**
 * 一个实验：造格、拼、软解核对。layout: [{ xMb, yMb, offset }]，cell: { w, h }（都是 16 的倍数）。
 * 回 { 结果行, 给浏览器核对用的 { units, expectY: [帧][格] 的 Y 平面哈希或 null } }
 */
async function experiment({ id, title, cell, layout, margin, extra = [], count = 30 }) {
  const row = { id, title, cell: `${cell.w}x${cell.h}`, cells: layout.length, margin, x264Extra: extra.join(' ') || '（产品参数原样）' };
  const wMbs = cell.w / 16, hMbs = cell.h / 16;
  const widthMbs = Math.max(...layout.map((l) => l.xMb + wMbs)), heightMbs = Math.max(...layout.map((l) => l.yMb + hMbs));
  const W = widthMbs * 16, H = heightMbs * 16;
  row.merged = `${W}x${H}`;
  const lvl = levelFor(W, H, FPS);
  const filler = readStream((await encodeCell({ ...cell, seed: 0, extra, frames: 3, black: true })).annexb);
  row.fillerSliceBytes = { I: filler.pictures[0].slices.reduce((a, s) => a + s.nal.length, 0), P: filler.pictures[1].slices.reduce((a, s) => a + s.nal.length, 0) };
  const cells = [];
  let encodeCpu = 0, sourceBytes = 0;
  for (let i = 0; i < layout.length; i++) {
    const enc = await encodeCell({ ...cell, seed: i + 1, margin, extra });
    encodeCpu += enc.cpuMs; sourceBytes += enc.annexb.length;
    const stream = readStream(enc.annexb);
    const dec = await decode(enc.annexb, cell.w, cell.h);
    cells.push({ stream, filler, xMb: layout[i].xMb, yMb: layout[i].yMb, offset: layout[i].offset ?? 0, dec: dec.frames });
  }
  row.slicesPerPictureInSource = cells[0].stream.pictures[0].slices.length;
  row.sourceEncodeCpuMs = encodeCpu;
  const why = cells.map((c) => compatible(cells[0].stream, c.stream)).find(Boolean);
  if (why) { row.error = `拼不起来：${why}`; return { row }; }
  const t0 = performance.now();
  let out;
  try { out = stitch({ cells, widthMbs, heightMbs, count, level: lvl?.idc ?? 62 }); } catch (e) { row.error = String(e.message || e); return { row }; }
  row.stitchMs = +(performance.now() - t0).toFixed(1);
  row.stitchMsPer15Frames = +(row.stitchMs * 15 / count).toFixed(1);
  row.mergedBytes = out.annexb.length;
  row.bytesVsSources = +(out.annexb.length / (sourceBytes * count / FRAMES)).toFixed(3);
  row.pictureKinds = out.pictures.map((p) => (p.idr ? 'IDR' : p.types.join('/'))).slice(0, 18).join(' ');
  row.slicesPerMergedPicture = out.pictures[1].slices;
  fs.writeFileSync(path.join(dir, `${id}.h264`), out.annexb);

  // 软解核对
  const dec = await decode(out.annexb, W, H);
  row.ffmpegDecoded = dec.frames.length;
  row.ffmpegErrors = dec.stderr ? dec.stderr.split(/\r?\n/).slice(0, 2).join(' | ') : null;
  const expectY = [];
  const perCell = cells.map(() => ({ compared: 0, exact: 0, maxDiff: 0, worstPixels: 0, skippedBeforeOwnKey: 0 }));
  for (let n = 0; n < Math.min(count, dec.frames.length); n++) {
    const exp = [];
    cells.forEach((c, k) => {
      const i = n - c.offset;
      const src = i >= 0 && i < c.dec.length ? c.dec[i] : null;
      // 这一格在合并流里从哪一幅起才是对的：它自己的第一个关键帧进了合并流之后
      let firstKey = null;
      for (let m = 0; m <= n; m++) { const j = m - c.offset; if (j >= 0 && c.stream.pictures[j]?.idr) { firstKey = m; break; } }
      if (!src || firstKey == null) { if (src) perCell[k].skippedBeforeOwnKey++; exp.push(null); return; }
      const x = c.xMb * 16, y = c.yMb * 16;
      const gotY = crop(dec.frames[n].y, W, x, y, cell.w, cell.h);
      const dY = diff(gotY, src.y);
      const dU = diff(crop(dec.frames[n].u, W / 2, x / 2, y / 2, cell.w / 2, cell.h / 2), src.u);
      const dV = diff(crop(dec.frames[n].v, W / 2, x / 2, y / 2, cell.w / 2, cell.h / 2), src.v);
      const max = Math.max(dY.max, dU.max, dV.max), px = dY.pixels + dU.pixels + dV.pixels;
      perCell[k].compared++;
      if (!px) perCell[k].exact++;
      if (max > perCell[k].maxDiff) perCell[k].maxDiff = max;
      if (px > perCell[k].worstPixels) perCell[k].worstPixels = px;
      exp.push(sha(src.y));
    });
    expectY.push(exp);
  }
  row.softwareDecode = perCell;
  row.softwareAllExact = perCell.every((c) => c.compared > 0 && c.exact === c.compared);
  return { row, browser: { id, W, H, cell, layout: cells.map((c) => ({ x: c.xMb * 16, y: c.yMb * 16 })), units: out.units, kinds: out.pictures.map((p) => p.idr), expectY, level: lvl?.idc ?? 62 } };
}

const report = { probe: 'merged-stream-bitstream', when: new Date().toISOString(), cpuBusyBefore: await cpuBusy(), experiments: [], browser: [] };
const small = { w: 640, h: 736 };   // 一张 640×360 的卡：640 × 2×(360+8)
const wide = { w: 1280, h: 1440 };  // 一张 1280×712 的卡
const ROW = (wMbs) => ['-x264-params', `sliced-threads=1:slice-max-mbs=${wMbs}`];
const PLANS = [
  { id: 'v2-aligned-margin', title: '竖着叠 2 格，关键帧对齐，每格四周 32 像素黑边', cell: small, margin: 32, layout: [{ xMb: 0, yMb: 0 }, { xMb: 0, yMb: 46 }] },
  { id: 'v4-aligned-margin', title: '竖着叠 4 格，关键帧对齐，每格四周 32 像素黑边', cell: small, margin: 32, layout: [0, 1, 2, 3].map((i) => ({ xMb: 0, yMb: 46 * i })) },
  { id: 'v4-aligned-nomargin', title: '竖着叠 4 格，关键帧对齐，不留黑边（内容顶到格子边上）', cell: small, margin: 0, layout: [0, 1, 2, 3].map((i) => ({ xMb: 0, yMb: 46 * i })) },
  { id: 'v4-unaligned-margin', title: '竖着叠 4 格，各卡的第一帧错开（+0、+5、−7、+11），32 像素黑边', cell: small, margin: 32, layout: [0, 5, -7, 11].map((offset, i) => ({ xMb: 0, yMb: 46 * i, offset })) },
  { id: 'h4-rows-margin', title: '横着拼 4 格（每行宏块一条带），各卡的第一帧错开，32 像素黑边', cell: small, margin: 32, extra: ROW(40), layout: [0, 5, -7, 11].map((offset, i) => ({ xMb: 40 * i, yMb: 0, offset })) },
  { id: 'h5-rows-margin', title: '横着拼 5 格（每行宏块一条带，每幅 230 条带），关键帧对齐，32 像素黑边：3200×736', cell: small, margin: 32, extra: ROW(40), layout: [0, 1, 2, 3, 4].map((i) => ({ xMb: 40 * i, yMb: 0 })) },
  { id: 'h6-rows-margin', title: '横着拼 6 格（每行宏块一条带，每幅 276 条带），关键帧对齐，32 像素黑边：3840×736', cell: small, margin: 32, extra: ROW(40), layout: [0, 1, 2, 3, 4, 5].map((i) => ({ xMb: 40 * i, yMb: 0 })) },
  { id: 'g2x5-rows-margin', title: '2 列 × 5 行 = 10 格（每行宏块一条带，每幅 460 条带），关键帧对齐：1280×3680', cell: small, margin: 32, extra: ROW(40), layout: Array.from({ length: 10 }, (_, i) => ({ xMb: 40 * (i % 2), yMb: 46 * Math.floor(i / 2) })) },
  { id: 'v5-unaligned-margin', title: '竖着叠 5 格（一格一条带，每幅 5 条带），第一帧错开：640×3680', cell: small, margin: 32, layout: [0, 5, -7, 11, -3].map((offset, i) => ({ xMb: 0, yMb: 46 * i, offset })) },
  { id: 'g6x5-rows-margin', title: '6 列 × 5 行 = 30 格（每行宏块一条带），第一帧各不相同，32 像素黑边：3840×3680', cell: small, margin: 32, extra: ROW(40), layout: Array.from({ length: 30 }, (_, i) => ({ xMb: 40 * (i % 6), yMb: 46 * Math.floor(i / 6), offset: (i * 7) % 15 - 7 })) },
  { id: 'h3-wide-rows-margin', title: '横着拼 3 格 1280×1440（每行宏块一条带），32 像素黑边：3840×1440', cell: wide, margin: 32, extra: ROW(80), layout: [0, 4, -3].map((offset, i) => ({ xMb: 80 * i, yMb: 0, offset })) },
];
const forBrowser = [];
for (const plan of PLANS) {
  const { row, browser } = await experiment(plan);
  report.experiments.push(row);
  if (row.error) { console.log(`\n[${row.id}] ${row.title}\n  失败：${row.error}`); continue; }
  console.log(`\n[${row.id}] ${row.title}`);
  console.log(`  合并画面 ${row.merged}，源流每幅 ${row.slicesPerPictureInSource} 条带，合并后每幅 ${row.slicesPerMergedPicture} 条带；头几幅各格的类型：${row.pictureKinds}`);
  console.log(`  拼 ${plan.count ?? 30} 幅用 ${row.stitchMs} ms（折合每 15 帧 ${row.stitchMsPer15Frames} ms），体积是各源流之和的 ${row.bytesVsSources} 倍；垫片条带 I ${row.fillerSliceBytes.I} 字节、P ${row.fillerSliceBytes.P} 字节`);
  console.log(`  ffmpeg 软解出 ${row.ffmpegDecoded} 幅${row.ffmpegErrors ? `，报错：${row.ffmpegErrors}` : '，无报错'}；逐格和单独解的比：${row.softwareAllExact ? '全部逐字节相同' : '有不同'} ${JSON.stringify(row.softwareDecode.slice(0, 6))}`);
  if (browser) forBrowser.push(browser);
}

// ── 浏览器硬解核对 ──
const routes = { '/': '<!doctype html><meta charset="utf-8"><title>merged-stream-bitstream</title><body></body>' };
for (const b of forBrowser) {
  routes[`/b/${b.id}.bin`] = Buffer.concat(b.units);
  routes[`/b/${b.id}.json`] = JSON.stringify({ sizes: b.units.map((u) => u.length), kinds: b.kinds, W: b.W, H: b.H, cell: b.cell, layout: b.layout, level: b.level });
}
const server = await serveLocal(PORT, routes);
const handle = await launchHeadless(WHICH);
try {
  for (const b of forBrowser) {
    for (const hw of ['prefer-hardware', 'prefer-software']) {
      const page = await handle.browser.newPage();
      let r;
      try {
        await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
        r = await page.evaluate(async (id, hw) => {
          const meta = await (await fetch(`/b/${id}.json`)).json();
          const bin = new Uint8Array(await (await fetch(`/b/${id}.bin`)).arrayBuffer());
          const codec = `avc1.6400${meta.level.toString(16).padStart(2, '0')}`;
          const config = { codec, codedWidth: meta.W, codedHeight: meta.H, hardwareAcceleration: hw, optimizeForLatency: true };
          const out = { codec, supported: null, frames: 0, format: null, error: null, hashes: [], msPerFrame: null };
          try { out.supported = (await VideoDecoder.isConfigSupported(config)).supported; } catch (e) { out.supported = String(e.message); }
          const work = [];
          const hex = (buf) => Array.from(new Uint8Array(buf)).slice(0, 8).map((x) => x.toString(16).padStart(2, '0')).join('');
          await new Promise((resolve) => {
            const t0 = performance.now();
            const dec = new VideoDecoder({
              output: (f) => {
                const n = out.frames++;
                out.format = f.format;
                work.push((async () => {
                  const row = [];
                  for (const c of meta.layout) {
                    const buf = new Uint8Array(meta.cell.w * meta.cell.h * 2);
                    const layout = await f.copyTo(buf, { rect: { x: c.x, y: c.y, width: meta.cell.w, height: meta.cell.h } });
                    const y = new Uint8Array(meta.cell.w * meta.cell.h);
                    for (let r2 = 0; r2 < meta.cell.h; r2++) y.set(buf.subarray(layout[0].offset + r2 * layout[0].stride, layout[0].offset + r2 * layout[0].stride + meta.cell.w), r2 * meta.cell.w);
                    row.push(hex(await crypto.subtle.digest('SHA-256', y)));
                  }
                  out.hashes[n] = row;
                  f.close();
                })());
              },
              error: (e) => { out.error = String(e.message || e); resolve(); },
            });
            try {
              dec.configure(config); // 不带 description：Annex-B，SPS / PPS 在码流里
              let off = 0;
              (async () => {
                for (let i = 0; i < meta.sizes.length; i++) {
                  dec.decode(new EncodedVideoChunk({ type: meta.kinds[i] ? 'key' : 'delta', timestamp: Math.round(i * 1e6 / 30), data: bin.subarray(off, off + meta.sizes[i]) }));
                  off += meta.sizes[i];
                  while (work.length < i - 4 && !out.error) await new Promise((r2) => setTimeout(r2, 1)); // 别攒太多没关的帧
                }
                await dec.flush();
                await Promise.all(work);
                out.msPerFrame = +((performance.now() - t0) / Math.max(1, out.frames)).toFixed(2);
                resolve();
              })().catch((e) => { out.error = out.error || String(e.message || e); resolve(); });
            } catch (e) { out.error = String(e.message || e); resolve(); }
            setTimeout(resolve, 60000);
          });
          return out;
        }, b.id, hw);
      } catch (e) { r = { error: String(e.message || e) }; }
      await page.close().catch(() => {});
      // 和软解的期望值比
      let compared = 0, same = 0;
      const firstBad = [];
      (r.hashes ?? []).forEach((rowH, n) => rowH?.forEach((h, k) => { const exp = b.expectY[n]?.[k]; if (!exp) return; compared++; if (exp === h) same++; else if (firstBad.length < 3) firstBad.push(`第 ${n} 幅第 ${k} 格`); }));
      const line = { id: b.id, hw, codec: r.codec, supported: r.supported, frames: r.frames, format: r.format, error: r.error, msPerFrame: r.msPerFrame, compared, same, firstBad };
      report.browser.push(line);
      console.log(`浏览器 ${hw === 'prefer-hardware' ? '硬解' : '软解'} [${b.id}] ${b.W}×${b.H} ${r.codec}：supported=${r.supported}，出 ${r.frames}/${b.units.length} 幅 ${r.format ?? '-'}${r.error ? `，报错 ${r.error}` : ''}；逐格 Y 平面和单独解的比：${same}/${compared} 相同${firstBad.length ? `（先错在 ${firstBad.join('、')}）` : ''}；${r.msPerFrame} ms/幅（含取像素算哈希，不是解码速度）`);
    }
  }
} finally {
  await handle.close();
  await closeServer(server);
}
report.cpuBusyAfter = await cpuBusy();
const out = jsonOut && jsonOut !== true ? String(jsonOut) : path.join(dir, 'bitstream.json');
writeJson(out, report);
console.log('结果写到', out);
