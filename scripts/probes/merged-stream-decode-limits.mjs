// 合并流评估 · 第 1 问：一个解码器最大能解多大的画面，能同时开几个解码器。
//
// 做法：用产品现在编轨道流的参数（libx264 veryfast crf16 g15 bf0，见 server/bakery/ffmpeg.mjs）把 testsrc2 编成
// 逐级加大的尺寸，在浏览器里走产品播流用的那条路（WebCodecs `VideoDecoder` + avcC `description`，
// `hardwareAcceleration: 'prefer-hardware'`；另跑一遍 'prefer-software' 对照）：
//   - `VideoDecoder.isConfigSupported` 说行不行（它不校验 level 与分辨率，所以只当参考）；
//   - **真的解** 30 帧：出了几帧、有没有报错、解出来的 `VideoFrame.format`（Windows 上硬解出 NV12，软解出 I420）、每帧毫秒；
//   - 硬解和软解各取同一帧的三小块像素比一下（防「不报错但解出一片绿」）。
// 另外量同时开 N 个硬件解码器（小尺寸）到几个开始失败，以及浏览器自己报的硬件解码能力（CDP SystemInfo.getInfo）。
//
// 浏览器一律无头（新无头模式），用临时用户目录；--browser puppeteer|chrome|edge 选哪一个可执行文件。
//
//   node scripts/probes/merged-stream-decode-limits.mjs --browser puppeteer --port 27900 --json <文件>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { arg, makeStream, levelFor, serveLocal, closeServer, launchHeadless, gpuInfo, cpuBusy, writeJson, workDir, round } from './merged-stream-common.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(arg('port', '27900'));
const WHICH = String(arg('browser', 'puppeteer'));
const FRAMES = 30;
const jsonOut = arg('json');

// 编码尺寸（宽 × 高）。高 2176 = 一张 1080 高的卡上下两半各加 8 行填充：(1080 + 8) × 2。
const SIZES = String(arg('sizes', '1920x2176,3840x2176,4096x2176,4096x2304,4096x4096,4112x2176,5760x2176,7680x2176,8192x2176,8192x4320,4096x8192,8192x8192,11520x2176,16384x2176'))
  .split(',').map((s) => s.split('x').map(Number)).map(([width, height]) => ({ width, height }));
const INSTANCES = String(arg('instances', '6,8,12,16,24,32,48,64')).split(',').map(Number);

const dir = workDir('decode-limits');
const report = { probe: 'merged-stream-decode-limits', when: new Date().toISOString(), browser: WHICH, cpuBusyBefore: await cpuBusy(), sizes: [], instances: [] };

// ── 造流 ──
const blobs = {};
for (const s of SIZES) {
  const id = `${s.width}x${s.height}`;
  const made = await makeStream({ ...s, frames: FRAMES });
  const lvl = levelFor(s.width, s.height, 30);
  const row = { id, ...s, macroblocks: Math.ceil(s.width / 16) * Math.ceil(s.height / 16), minLevelBySpec: lvl?.level ?? '超出 6.2', encodeOk: made.ok, encodeMs: made.ms };
  if (made.ok) {
    row.codec = made.codec; row.bytes = made.bytes; row.x264Warning = made.stderr ? made.stderr.split(/\r?\n/).slice(0, 2).join(' | ') : null;
    blobs[`/s/${id}/init.mp4`] = made.init;
    made.segments.forEach((seg, i) => { blobs[`/s/${id}/seg${i}.m4s`] = seg; });
    row.segments = made.segments.length;
  } else row.encodeError = made.error;
  report.sizes.push(row);
  console.log(`造流 ${id}：${made.ok ? `${made.codec}，${made.bytes} 字节，${made.ms} ms` : `失败 ${made.error}`}`);
}
// 同开 N 个解码器用的小流：640×736 = 一张 640×360 的卡
const small = await makeStream({ width: 640, height: 736, frames: FRAMES });
blobs['/s/small/init.mp4'] = small.init;
small.segments.forEach((seg, i) => { blobs[`/s/small/seg${i}.m4s`] = seg; });

const PAGE = `<!doctype html><meta charset="utf-8"><title>merged-stream-decode-limits</title><script src="/demux.js"></script><body></body>`;
const server = await serveLocal(PORT, { '/': PAGE, '/demux.js': fs.readFileSync(path.join(here, 'stream-demux-browser.js')), ...blobs });

const handle = await launchHeadless(WHICH);
try {
  report.gpu = await gpuInfo(handle.browser);
  console.log('浏览器：', report.gpu.product, '|', report.gpu.angle);
  console.log('浏览器报的硬件解码能力：', JSON.stringify(report.gpu.videoDecoding.filter((v) => /H264/i.test(v.profile))));

  for (const row of report.sizes) {
    if (!row.encodeOk) continue;
    // 每个尺寸一个新页面：大尺寸解挂了不连累后面的
    const page = await handle.browser.newPage();
    try {
      await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
      row.decode = await page.evaluate(async (id, nSeg, frames) => {
        const get = async (u) => (await fetch(u)).arrayBuffer();
        const init = PCStream.parseInit(await get(`/s/${id}/init.mp4`));
        const segs = [];
        for (let i = 0; i < nSeg; i++) segs.push(await get(`/s/${id}/seg${i}.m4s`));
        const out = {};
        const samplesOf = {};
        for (const hw of ['prefer-hardware', 'prefer-software']) {
          const config = { codec: init.codec, description: init.description, codedWidth: init.width, codedHeight: init.height, hardwareAcceleration: hw, optimizeForLatency: true };
          const r = { supported: null, frames: 0, error: null, format: null, coded: null, msPerFrame: null, firstFrameMs: null };
          try { r.supported = (await VideoDecoder.isConfigSupported(config)).supported; } catch (e) { r.supported = `抛错 ${e.message}`; }
          await new Promise((resolve) => {
            let done = false;
            const finish = () => { if (!done) { done = true; resolve(); } };
            const t0 = performance.now();
            let dec;
            const pending = [];
            try {
              dec = new VideoDecoder({
                output: (f) => {
                  if (r.frames === 0) { r.firstFrameMs = +(performance.now() - t0).toFixed(1); r.format = f.format; r.coded = `${f.codedWidth}x${f.codedHeight}`; r.display = `${f.displayWidth}x${f.displayHeight}`; }
                  r.frames++;
                  if (r.frames === 20) {
                    // 第 20 帧取三小块像素（左上、中间、右下各 32×32）留着和另一种解法比。不转格式：NV12 和 I420 的第一个平面都是 Y，只比 Y
                    const W = f.displayWidth, H = f.displayHeight;
                    const rects = [[0, 0], [((W / 2) | 0) & ~1, ((H / 2) | 0) & ~1], [(W - 32) & ~1, (H - 32) & ~1]];
                    pending.push((async () => {
                      const got = [];
                      for (const [x, y] of rects) {
                        const buf = new Uint8Array(32 * 32 * 2);
                        try { const layout = await f.copyTo(buf, { rect: { x, y, width: 32, height: 32 } }); const o = layout[0].offset, st = layout[0].stride; const yy = []; for (let r2 = 0; r2 < 32; r2++) for (let c2 = 0; c2 < 32; c2++) yy.push(buf[o + r2 * st + c2]); got.push(yy); } catch (e) { got.push(`copyTo 失败 ${e.message}`); }
                      }
                      samplesOf[hw] = got;
                      f.close();
                    })());
                  } else f.close();
                },
                error: (e) => { r.error = String(e.message || e); finish(); },
              });
              dec.configure(config);
              let k = 0;
              for (let i = 0; i < segs.length; i++) for (const c of PCStream.chunksOf(segs[i], { segmentIndex: i })) { if (k++ < frames) dec.decode(c); }
              dec.flush().then(async () => { await Promise.all(pending); r.msPerFrame = +((performance.now() - t0) / Math.max(1, r.frames)).toFixed(2); finish(); }, (e) => { r.error = r.error || String(e.message || e); finish(); });
            } catch (e) { r.error = String(e.message || e); finish(); }
            setTimeout(() => { if (!done) { r.error = r.error || '60 秒没解完（防卡死的时限）'; finish(); } }, 60000);
          });
          out[hw] = r;
        }
        // 两种解法的同一帧像素差（平均绝对差、最大差）
        const a = samplesOf['prefer-hardware'], b = samplesOf['prefer-software'];
        if (a && b) {
          let sum = 0, n = 0, max = 0, bad = null;
          for (let i = 0; i < 3; i++) {
            if (typeof a[i] === 'string' || typeof b[i] === 'string') { bad = typeof a[i] === 'string' ? a[i] : b[i]; continue; }
            for (let j = 0; j < a[i].length; j++) { const d = Math.abs(a[i][j] - b[i][j]); sum += d; n++; if (d > max) max = d; }
          }
          out.hwVsSw = bad ? { error: bad } : { meanAbs: +(sum / n).toFixed(3), max };
        }
        return out;
      }, row.id, row.segments, FRAMES);
    } catch (e) { row.decode = { pageError: String(e.message || e) }; }
    await page.close().catch(() => {});
    const d = row.decode, h = d['prefer-hardware'], s = d['prefer-software'];
    if (h) console.log(`${row.id.padEnd(11)} ${row.codec} 规范最低级别 ${row.minLevelBySpec} | 硬解优先：supported=${h.supported} 出 ${h.frames}/${FRAMES} 帧 ${h.format ?? '-'} ${h.msPerFrame ?? '-'}ms/帧 ${h.error ?? ''} | 软解：supported=${s.supported} 出 ${s.frames}/${FRAMES} 帧 ${s.format ?? '-'} ${s.msPerFrame ?? '-'}ms/帧 ${s.error ?? ''} | 像素差 ${JSON.stringify(d.hwVsSw ?? null)}`);
    else console.log(`${row.id} 页面出错 ${d.pageError}`);
  }

  // ── 同时开 N 个硬件解码器 ──
  for (const n of INSTANCES) {
    const page = await handle.browser.newPage();
    let r;
    try {
      await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
      r = await page.evaluate(async (n, nSeg) => {
        const get = async (u) => (await fetch(u)).arrayBuffer();
        const init = PCStream.parseInit(await get('/s/small/init.mp4'));
        const segs = [];
        for (let i = 0; i < nSeg; i++) segs.push(await get(`/s/small/seg${i}.m4s`));
        const config = { codec: init.codec, description: init.description, codedWidth: init.width, codedHeight: init.height, hardwareAcceleration: 'prefer-hardware', optimizeForLatency: true };
        const decs = [];
        const t0 = performance.now();
        for (let i = 0; i < n; i++) {
          const st = { frames: 0, format: null, error: null };
          const dec = new VideoDecoder({ output: (f) => { st.frames++; st.format = f.format; f.close(); }, error: (e) => { st.error = String(e.message || e); } });
          try { dec.configure(config); } catch (e) { st.error = String(e.message || e); }
          decs.push({ dec, st });
        }
        // 所有解码器都开着的时候，轮着喂（和播放时一样：每拍每条流一帧）
        const chunksPer = decs.map(() => segs.flatMap((s, i) => PCStream.chunksOf(s, { segmentIndex: i })));
        for (let k = 0; k < chunksPer[0].length; k++) for (let i = 0; i < n; i++) { const { dec, st } = decs[i]; if (dec.state === 'configured') { try { dec.decode(chunksPer[i][k]); } catch (e) { st.error = st.error || String(e.message || e); } } }
        await Promise.race([Promise.allSettled(decs.map(({ dec }) => (dec.state === 'configured' ? dec.flush() : Promise.resolve()))), new Promise((res) => setTimeout(res, 60000))]);
        const ms = performance.now() - t0;
        const ok = decs.filter(({ st }) => st.frames === chunksPer[0].length && !st.error);
        const formats = {};
        for (const { st } of decs) formats[st.format ?? '没出帧'] = (formats[st.format ?? '没出帧'] || 0) + 1;
        const errors = [...new Set(decs.map(({ st }) => st.error).filter(Boolean))].slice(0, 3);
        for (const { dec } of decs) { try { dec.close(); } catch { /* 已关 */ } }
        return { n, allFramesOk: ok.length, formats, errors, totalMs: +ms.toFixed(0), framesTotal: decs.reduce((a, { st }) => a + st.frames, 0) };
      }, n, small.segments.length);
    } catch (e) { r = { n, pageError: String(e.message || e) }; }
    await page.close().catch(() => {});
    report.instances.push(r);
    console.log(`同开 ${n} 个解码器（640×736）：全部帧都出齐的 ${r.allFramesOk ?? '-'} 个，帧格式 ${JSON.stringify(r.formats ?? null)}，耗时 ${r.totalMs ?? '-'} ms，错误 ${JSON.stringify(r.errors ?? r.pageError)}`);
  }
} finally {
  await handle.close();
  await closeServer(server);
}
report.cpuBusyAfter = await cpuBusy();
console.log(`处理器占用：开始 ${report.cpuBusyBefore}%，结束 ${report.cpuBusyAfter}%`);
const out = jsonOut && jsonOut !== true ? String(jsonOut) : path.join(dir, `decode-limits-${WHICH}.json`);
writeJson(out, report);
console.log('结果写到', out);
void round;
