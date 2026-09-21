// G0-b (5)：一段真 1080p 带透明内容切 15 帧分段，量编码耗时、文件大小、**alpha 误差和颜色误差**。
// 端到端走 G5 真正要走的那条路：ffmpeg 上下拼合编码 -> Node 按 box 切 -> 页面 WebCodecs 解码
// -> WebGL 着色器合成 -> readPixels，再和原始 PNG 逐像素比。
//
// 四个变体，专门回答两条待验的口径：
//   A premul+bt709+tag   线上口径（r75-05 第 2 条）
//   B straight+bt709+tag 色半区存直通色（对照：量透明区的 RGB 渗边）
//   C premul+bt709+notag 不写容器色彩标注（对照：非阻塞 3.3）
//   D premul+notag/nomtx 不写 out_color_matrix（对照：非阻塞 3.3）
//
// 素材先用 scripts/probes/stream-material.mjs 渲好。
//   node scripts/probes/stream-roundtrip.mjs --material <dir> --cards particles-snow,growth-curve,scene-3d
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findFfmpeg, ffmpegVersion, encodeSegment, splitFmp4, initInfo, segmentInfo,
  pngToRgba, pngSize, stats, writeJson, arg,
} from './stream-common.mjs';
import { openBrowser, pageFactory, serve, closeAll } from './probe-connect.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MATERIAL = String(arg('material', path.join(os.tmpdir(), 'pc-stream-material')));
const CARDS = String(arg('cards', 'particles-snow,growth-curve,scene-3d,odometer')).split(',').map((s) => s.trim()).filter(Boolean);
const FPS = Number(arg('fps', '30'));
const ENCODER = String(arg('encoder', 'libx264'));
const REPEATS = Number(arg('repeats', '3'));
const PORT = Number(arg('port', '5244'));
const workDir = String(arg('out', path.join(os.tmpdir(), 'pc-stream-roundtrip')));
const jsonOut = arg('json');

const VARIANTS = [
  { id: 'A-premul-bt709-tag', premultiplied: true, colorMatrix: 'bt709', tagColor: true, srcPremultiplied: true },
  { id: 'B-straight-bt709-tag', premultiplied: false, colorMatrix: 'bt709', tagColor: true, srcPremultiplied: false },
  { id: 'C-premul-bt709-notag', premultiplied: true, colorMatrix: 'bt709', tagColor: false, srcPremultiplied: true },
  { id: 'D-premul-nomatrix-tag', premultiplied: true, colorMatrix: null, tagColor: true, srcPremultiplied: true },
  // E 是本探针给出的**建议口径**：限定范围 + 预乘 + 着色器钳 rgb <= a。
  // pc 全范围在 Chrome 的 VideoFrame -> 纹理路径上被当成 tv 展开（见 (5) 的 calib），
  // 不钳时预乘色在透明区的编码噪声不受衰减地直接输出。
  { id: 'E-tv-premul-clamp', premultiplied: true, colorMatrix: 'bt709', tagColor: true, range: 'tv', srcPremultiplied: true, clampToAlpha: true },
  { id: 'F-tv-premul-noclamp', premultiplied: true, colorMatrix: 'bt709', tagColor: true, range: 'tv', srcPremultiplied: true },
];

fs.rmSync(workDir, { recursive: true, force: true });
fs.mkdirSync(workDir, { recursive: true });

const ffmpeg = findFfmpeg();
const report = {
  probe: 'stream-roundtrip',
  when: new Date().toISOString(),
  env: { ffmpeg: await ffmpegVersion(ffmpeg), node: process.version, fps: FPS, encoder: ENCODER, repeats: REPEATS },
  cards: [],
};

// ── 每张卡：取前 15 帧，编 4 个变体，参考 RGBA 落盘备页面 fetch ───────────────
const jobs = [];
for (const cardId of CARDS) {
  const framesDir = path.join(MATERIAL, cardId, 'frames');
  if (!fs.existsSync(framesDir)) { console.log(`跳过 ${cardId}：没有素材 ${framesDir}`); continue; }
  const files = fs.readdirSync(framesDir).filter((f) => f.endsWith('.png')).sort().slice(0, 15);
  if (files.length < 15) { console.log(`跳过 ${cardId}：只有 ${files.length} 帧`); continue; }
  const pngs = files.map((f) => fs.readFileSync(path.join(framesDir, f)));
  const { width, height } = pngSize(pngs[0]);
  const cardDir = path.join(workDir, cardId);
  fs.mkdirSync(cardDir, { recursive: true });

  console.log(`\n=== ${cardId} === ${width}x${height}，15 帧，PNG 共 ${(pngs.reduce((s, p) => s + p.length, 0) / 1e6).toFixed(1)} MB`);

  // 参考 RGBA（直通 alpha），落盘给页面 fetch
  for (let i = 0; i < 15; i++) {
    const raw = await pngToRgba(ffmpeg, path.join(framesDir, files[i]), width, height);
    if (raw.length !== width * height * 4) throw new Error(`参考帧 ${i} 大小不对：${raw.length}`);
    fs.writeFileSync(path.join(cardDir, `ref-${String(i).padStart(2, '0')}.raw`), raw);
  }

  const card = { cardId, width, height, stackedHeight: height * 2 + 16, variants: [] };
  for (const v of VARIANTS) {
    const msList = [];
    let last = null;
    for (let r = 0; r < REPEATS; r++) {
      last = await encodeSegment(ffmpeg, pngs, {
        encoder: ENCODER, fps: FPS,
        premultiplied: v.premultiplied, colorMatrix: v.colorMatrix, tagColor: v.tagColor, range: v.range ?? 'pc',
      });
      msList.push(last.ms);
    }
    const split = splitFmp4(last.buffer);
    const vDir = path.join(cardDir, v.id);
    fs.mkdirSync(vDir, { recursive: true });
    fs.writeFileSync(path.join(vDir, 'init.mp4'), split.init);
    fs.writeFileSync(path.join(vDir, 'seg-000.m4s'), split.segments[0]);
    const info = segmentInfo(split.segments[0]);
    const entry = {
      ...v, encodeMs: stats(msList), encodeMsList: msList,
      segBytes: split.segments[0].length, initBytes: split.init.length,
      sampleCount: info.sampleCount, firstSampleIsSync: info.firstSampleIsSync,
      codec: initInfo(split.init).codec,
      dir: `${cardId}/${v.id}`,
    };
    card.variants.push(entry);
    console.log(`  ${v.id.padEnd(22)} 编码 ${entry.encodeMs.p50} ms（${msList.map((m) => m.toFixed(0)).join('/')}），分段 ${(entry.segBytes / 1024).toFixed(0)} KB，样本 ${entry.sampleCount}，codec ${entry.codec}`);
  }
  report.cards.push(card);
  jobs.push(card);
}

if (!jobs.length) { console.log('没有可用素材，退出'); process.exit(1); }

// ── 页面端：解码 + 合成 + 逐像素比 ───────────────────────────────────────────
const server = await serve(PORT, (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end('<!doctype html><meta charset="utf-8"><title>roundtrip</title><body><canvas id="c"></canvas></body>');
  }
  if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
  const file = path.join(workDir, decodeURIComponent(url.pathname).replace(/^[/\\]+/, ''));
  if (!file.startsWith(workDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(fs.readFileSync(file));
}, '127.0.0.1');

const { browser, mode, close } = await openBrowser({ launch: { headless: true, protocolTimeout: 600000 } });
const factory = await pageFactory(browser, mode);
const handle = await factory.fresh();
const page = handle.page;
page.on('console', (m) => { if (m.type() === 'error') console.log('PAGE ERR:', m.text()); });

try {
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await page.addScriptTag({ path: path.join(here, 'stream-demux-browser.js') });
  report.ua = await page.evaluate(() => navigator.userAgent);
  console.log(`\n页面：${report.ua.match(/(Chrome|Edg)\/[\d.]+/)?.[0]}`);

  for (const card of jobs) {
    console.log(`\n--- ${card.cardId} 逐像素比 ---`);
    for (const v of card.variants) {
      /*
       * 一次 evaluate 做完：解码 -> 合成 -> readPixels -> 逐像素比，**在 output 回调里当场做完
       * 并立刻 close()**。不能先把 15 帧都攒下来再处理：1920x2176 的帧攒满会把硬件解码器的
       * 输出帧池占死，`flush()` 永远不返回（实测卡到 600 秒探针超时，见报告 (4) 那一节）。
       * 参考帧先全部拉到页面里（15 x 8.3 MB），因为 output 回调是同步的、不能 await。
       */
      const r = await page.evaluate(async (opts) => {
        const { dir, cardId, W, H, fps, srcPremul, clamp } = opts;
        const initBuf = await (await fetch(`/${dir}/init.mp4`)).arrayBuffer();
        const segBuf = await (await fetch(`/${dir}/seg-000.m4s`)).arrayBuffer();
        const init = PCStream.parseInit(initBuf);
        const comp = PCStream.makeCompositor(document.getElementById('c'), { premultipliedAlpha: true, srcPremultiplied: srcPremul, clampToAlpha: clamp });

        const refs = [];
        for (let i = 0; i < 15; i++) refs.push(new Uint8Array(await (await fetch(`/${cardId}/ref-${String(i).padStart(2, '0')}.raw`)).arrayBuffer()));

        const a = {
          alphaMax: 0, alphaSum: 0, alphaOver2: 0, alphaN: 0,
          preMax: 0, preSum: 0, preOver2: 0, preN: 0,
          strMax: 0, strSum: 0, strOver2: 0, strN: 0,
          bleedMax: 0, bleedSum: 0, bleedOver2: 0, bleedN: 0,
          edgeAlphaMax: 0, edgeAlphaSum: 0, edgeRgbMax: 0, edgeRgbSum: 0, edgeN: 0,
          opAlphaMax: 0, opRgbMax: 0, opRgbSum: 0, opN: 0,
        };
        let seen = 0, codedSize = null, err = null;
        const drawMs = [], readMs = [], cmpMs = [];

        const onFrame = (f) => {
          const idx = seen++;
          if (!codedSize) codedSize = `${f.codedWidth}x${f.codedHeight}`;
          const t0 = performance.now();
          comp.draw(f, H);
          const t1 = performance.now();
          const d = comp.readPixels().data;
          const t2 = performance.now();
          f.close();                                   // 立刻还给解码器
          const ref = refs[Math.min(idx, refs.length - 1)];
          const end = W * H * 4;
          for (let p = 0; p < end; p += 4) {
            const ra = ref[p + 3], ga = d[p + 3];
            const da = ga > ra ? ga - ra : ra - ga;
            if (da > a.alphaMax) a.alphaMax = da;
            a.alphaSum += da; a.alphaN++; if (da > 2) a.alphaOver2++;
            let edgeRgb = 0;
            for (let k = 0; k < 3; k++) {
              const rv = ref[p + k], gv = d[p + k];
              const refPre = ((rv * ra + 127) / 255) | 0;
              const dp = gv > refPre ? gv - refPre : refPre - gv;
              if (dp > a.preMax) a.preMax = dp;
              a.preSum += dp; a.preN++; if (dp > 2) a.preOver2++;
              edgeRgb += dp;
              if (ra === 0) {
                if (gv > a.bleedMax) a.bleedMax = gv;
                a.bleedSum += gv; a.bleedN++; if (gv > 2) a.bleedOver2++;
              }
              if (ra >= 32 && ga >= 32) {
                let gs = ((gv * 255 + (ga >> 1)) / ga) | 0;
                if (gs > 255) gs = 255;
                const ds = gs > rv ? gs - rv : rv - gs;
                if (ds > a.strMax) a.strMax = ds;
                a.strSum += ds; a.strN++; if (ds > 2) a.strOver2++;
              }
              if (ra === 255) {
                const dr = gv > rv ? gv - rv : rv - gv;
                if (dr > a.opRgbMax) a.opRgbMax = dr;
                a.opRgbSum += dr;
              }
            }
            if (ra > 0 && ra < 255) {
              if (da > a.edgeAlphaMax) a.edgeAlphaMax = da;
              a.edgeAlphaSum += da;
              const er = edgeRgb / 3;
              if (er > a.edgeRgbMax) a.edgeRgbMax = er;
              a.edgeRgbSum += edgeRgb; a.edgeN++;
            } else if (ra === 255) {
              if (da > a.opAlphaMax) a.opAlphaMax = da;
              a.opN++;
            }
          }
          drawMs.push(+(t1 - t0).toFixed(2));
          readMs.push(+(t2 - t1).toFixed(2));
          cmpMs.push(+(performance.now() - t2).toFixed(2));
        };

        const dec = new VideoDecoder({ output: onFrame, error: (e) => { err = String(e); } });
        dec.configure({ codec: init.codec, description: init.description, codedWidth: init.width, codedHeight: init.height, hardwareAcceleration: 'prefer-hardware' });
        for (const c of PCStream.chunksOf(segBuf, { segmentIndex: 0, fps, perSegment: 15 })) dec.decode(c);
        await dec.flush();
        dec.close();

        const fin = (max, sum, over2, n) => ({ max, mean: +(sum / Math.max(1, n)).toFixed(4), over2Pct: +(100 * over2 / Math.max(1, n)).toFixed(4), n });
        const med = (xs) => { const s = [...xs].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };
        return {
          decoded: seen, codedSize, err,
          drawMsP50: med(drawMs), readMsP50: med(readMs), cmpMsP50: med(cmpMs),
          alpha: fin(a.alphaMax, a.alphaSum, a.alphaOver2, a.alphaN),
          rgbPremul: fin(a.preMax, a.preSum, a.preOver2, a.preN),
          rgbStraight: fin(a.strMax, a.strSum, a.strOver2, a.strN),
          transparentBleed: fin(a.bleedMax, a.bleedSum, a.bleedOver2, a.bleedN),
          edge: { n: a.edgeN, alphaMax: a.edgeAlphaMax, alphaMean: +(a.edgeAlphaSum / Math.max(1, a.edgeN)).toFixed(4), rgbMax: a.edgeRgbMax, rgbMean: +(a.edgeRgbSum / Math.max(1, a.edgeN * 3)).toFixed(4) },
          opaque: { n: a.opN, alphaMax: a.opAlphaMax, rgbMax: a.opRgbMax, rgbMean: +(a.opRgbSum / Math.max(1, a.opN * 3)).toFixed(4) },
        };
      }, { dir: v.dir, cardId: card.cardId, W: card.width, H: card.height, fps: FPS, srcPremul: v.srcPremultiplied, clamp: !!v.clampToAlpha });

      v.pixels = r;
      console.log(`  ${v.id.padEnd(22)} codedSize ${r.codedSize}  alpha 最大 ${r.alpha.max} 均值 ${r.alpha.mean} >2 ${r.alpha.over2Pct}%  |  ` +
        `RGB(预乘) 最大 ${r.rgbPremul.max} 均值 ${r.rgbPremul.mean} >2 ${r.rgbPremul.over2Pct}%  |  透明区渗边 最大 ${r.transparentBleed.max} 均值 ${r.transparentBleed.mean}`);
      console.log(`  ${''.padEnd(22)} 半透明边缘(${r.edge.n}px) alpha 最大 ${r.edge.alphaMax} 均值 ${r.edge.alphaMean}，RGB 最大 ${r.edge.rgbMax} 均值 ${r.edge.rgbMean}  |  不透明区 RGB 最大 ${r.opaque.rgbMax} 均值 ${r.opaque.rgbMean}`);
    }
  }
} finally {
  await factory.release(handle).catch(() => {});
  await close();
  await closeAll([server]);
}

if (jsonOut) console.log(`\nJSON -> ${writeJson(String(jsonOut), report)}`);
console.log(`码流 -> ${workDir}`);
