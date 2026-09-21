// G0-b (5) 的追问三件：
//   sweep —— 真卡的 alpha / 颜色误差随 CRF 怎么变（G 验收要「alpha 平均误差 ≤ 0.5 / 255」，
//            CRF 16 够不够？代价是多少字节）
//   calib —— 平坦的 alpha 阶梯块：看误差是**系统性偏移**（range / matrix 标注对不上）
//            还是**细节损失**（编码有损）。这是判 out_color_matrix=bt709 与容器标注的依据。
//   halo  —— 硬边 alpha 下透明区的彩色渗边：色半区存预乘 vs 直通，端到端比一次。
//            （r75-05 第 2 条采纳预乘就是为它）
//
//   node scripts/probes/stream-alpha-quality.mjs --suites sweep,calib,halo --json out.json
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findFfmpeg, ffmpegVersion, encodeSegment, splitFmp4, initInfo,
  encodePng, pngToRgba, pngSize, stats, writeJson, arg,
} from './stream-common.mjs';
import { openBrowser, pageFactory, serve, closeAll } from './probe-connect.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MATERIAL = String(arg('material', path.join(os.tmpdir(), 'pc-stream-material')));
const SWEEP_CARD = String(arg('card', 'growth-curve'));
const QUALITIES = String(arg('qualities', '16,12,8,4,1')).split(',').map(Number);
const SUITES = String(arg('suites', 'sweep,calib,halo')).split(',').map((s) => s.trim());
const FPS = Number(arg('fps', '30'));
const ENCODER = String(arg('encoder', 'libx264'));
const PORT = Number(arg('port', '5245'));
const workDir = String(arg('out', path.join(os.tmpdir(), 'pc-stream-alpha-quality')));
const jsonOut = arg('json');

fs.rmSync(workDir, { recursive: true, force: true });
fs.mkdirSync(workDir, { recursive: true });
const ffmpeg = findFfmpeg();

const report = {
  probe: 'stream-alpha-quality',
  when: new Date().toISOString(),
  env: { ffmpeg: await ffmpegVersion(ffmpeg), node: process.version, fps: FPS, encoder: ENCODER },
  cases: [],
};

// ── 素材 ────────────────────────────────────────────────────────────────────
/** 平坦阶梯：16 列 alpha 级、每列 3 条恒定颜色。平坦区不该有细节损失，剩下的就是系统性偏移。 */
function calibFrame(W, H) {
  const rgba = Buffer.alloc(W * H * 4);
  const cols = 16, colW = Math.floor(W / cols);
  const colors = [[255, 0, 0], [0, 255, 0], [200, 200, 200], [16, 16, 16]];
  for (let y = 0; y < H; y++) {
    const band = Math.min(colors.length - 1, Math.floor(y / (H / colors.length)));
    const [R, G, B] = colors[band];
    for (let x = 0; x < W; x++) {
      const c = Math.min(cols - 1, Math.floor(x / colW));
      const a = Math.min(255, c * 17);
      const i = (y * W + x) * 4;
      rgba[i] = R; rgba[i + 1] = G; rgba[i + 2] = B; rgba[i + 3] = a;
    }
  }
  return rgba;
}

/** 硬边 alpha + 透明区里**有颜色**：直通口径下色半区在边界外仍是满饱和色，会被编码器糊过边界。 */
function haloFrame(W, H, t) {
  const rgba = Buffer.alloc(W * H * 4);
  const cx = W * (0.4 + 0.1 * Math.sin(t * 0.3)), cy = H * 0.5, r = Math.min(W, H) * 0.3;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      rgba[i] = 255; rgba[i + 1] = 0; rgba[i + 2] = 255;       // 透明区也是满饱和洋红
      rgba[i + 3] = Math.hypot(x - cx, y - cy) < r ? 255 : 0;  // 硬边，没有过渡带
    }
  }
  return rgba;
}

const W = Number(arg('w', '1920')), H = Number(arg('h', '1080'));

/** 把一组 RGBA 帧落成 PNG + 参考 raw，返回 { pngs, refDir } */
function materialize(name, rgbaFrames) {
  const dir = path.join(workDir, name);
  fs.mkdirSync(dir, { recursive: true });
  const pngs = rgbaFrames.map((rgba, i) => {
    const png = encodePng(rgba, W, H);
    fs.writeFileSync(path.join(dir, `ref-${String(i).padStart(2, '0')}.raw`), rgba);
    return png;
  });
  return { pngs, name };
}

const suites = [];

if (SUITES.includes('sweep')) {
  const framesDir = path.join(MATERIAL, SWEEP_CARD, 'frames');
  if (!fs.existsSync(framesDir)) console.log(`跳过 sweep：没有素材 ${framesDir}`);
  else {
    const files = fs.readdirSync(framesDir).filter((f) => f.endsWith('.png')).sort().slice(0, 15);
    const pngs = files.map((f) => fs.readFileSync(path.join(framesDir, f)));
    const { width, height } = pngSize(pngs[0]);
    const dir = path.join(workDir, `sweep-${SWEEP_CARD}`);
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < files.length; i++) {
      fs.writeFileSync(path.join(dir, `ref-${String(i).padStart(2, '0')}.raw`), await pngToRgba(ffmpeg, path.join(framesDir, files[i]), width, height));
    }
    for (const q of QUALITIES) {
      suites.push({ suite: 'sweep', id: `crf${q}`, name: `sweep-${SWEEP_CARD}`, pngs, W: width, H: height,
        opts: { premultiplied: true, colorMatrix: 'bt709', tagColor: true, quality: q }, srcPremultiplied: true, quality: q });
    }
  }
}

if (SUITES.includes('calib')) {
  const m = materialize('calib', Array.from({ length: 15 }, () => calibFrame(W, H)));
  for (const q of [16, 8, 4]) {
    suites.push({ suite: 'calib', id: `crf${q}`, name: m.name, pngs: m.pngs, W, H,
      opts: { premultiplied: true, colorMatrix: 'bt709', tagColor: true, quality: q }, srcPremultiplied: true, quality: q });
  }
  // 关键对照：out_range=tv（限定范围）。上面几档都是 out_range=pc，实测 Chrome 的
  // VideoFrame -> WebGL 纹理路径**不认**全范围标注，一律按限定范围展开，于是中间调 alpha
  // 被整体拉伸（见报告 (5)）。改成 tv 让两头对齐。
  for (const q of [16, 8]) {
    suites.push({ suite: 'calib', id: `tv-crf${q}`, name: m.name, pngs: m.pngs, W, H,
      opts: { premultiplied: true, colorMatrix: 'bt709', tagColor: true, quality: q, range: 'tv' }, srcPremultiplied: true, quality: q });
  }
  suites.push({ suite: 'calib', id: 'crf16-nomatrix', name: m.name, pngs: m.pngs, W, H,
    opts: { premultiplied: true, colorMatrix: null, tagColor: true, quality: 16 }, srcPremultiplied: true, quality: 16 });
  suites.push({ suite: 'calib', id: 'crf16-notag', name: m.name, pngs: m.pngs, W, H,
    opts: { premultiplied: true, colorMatrix: 'bt709', tagColor: false, quality: 16 }, srcPremultiplied: true, quality: 16 });
}

if (SUITES.includes('halo')) {
  const m = materialize('halo', Array.from({ length: 15 }, (_, i) => haloFrame(W, H, i)));
  for (const q of [16, 8]) {
    suites.push({ suite: 'halo', id: `premul-crf${q}`, name: m.name, pngs: m.pngs, W, H,
      opts: { premultiplied: true, colorMatrix: 'bt709', tagColor: true, quality: q }, srcPremultiplied: true, quality: q });
    suites.push({ suite: 'halo', id: `premul-clamp-crf${q}`, name: m.name, pngs: m.pngs, W, H,
      opts: { premultiplied: true, colorMatrix: 'bt709', tagColor: true, quality: q }, srcPremultiplied: true, clampToAlpha: true, quality: q });
    suites.push({ suite: 'halo', id: `straight-crf${q}`, name: m.name, pngs: m.pngs, W, H,
      opts: { premultiplied: false, colorMatrix: 'bt709', tagColor: true, quality: q }, srcPremultiplied: false, quality: q });
  }
}

// ── 编码 ────────────────────────────────────────────────────────────────────
for (const s of suites) {
  const res = await encodeSegment(ffmpeg, s.pngs, { encoder: ENCODER, fps: FPS, ...s.opts });
  const split = splitFmp4(res.buffer);
  const dir = path.join(workDir, `${s.suite}-${s.id}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'init.mp4'), split.init);
  fs.writeFileSync(path.join(dir, 'seg-000.m4s'), split.segments[0]);
  s.dir = `${s.suite}-${s.id}`;
  s.encodeMs = res.ms;
  s.segBytes = split.segments[0].length;
  s.codec = initInfo(split.init).codec;
  console.log(`${s.suite}/${s.id}: 编码 ${res.ms} ms，分段 ${(s.segBytes / 1024).toFixed(0)} KB，codec ${s.codec}`);
}

// ── 页面端比对 ──────────────────────────────────────────────────────────────
const server = await serve(PORT, (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end('<!doctype html><meta charset="utf-8"><body><canvas id="c"></canvas>'); }
  if (u.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
  const f = path.join(workDir, decodeURIComponent(u.pathname).replace(/^[/\\]+/, ''));
  if (!f.startsWith(workDir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(fs.readFileSync(f));
}, '127.0.0.1');

const { browser, mode, close } = await openBrowser({ launch: { headless: true, protocolTimeout: 600000 } });
const factory = await pageFactory(browser, mode);
const handle = await factory.fresh();
const page = handle.page;

try {
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await page.addScriptTag({ path: path.join(here, 'stream-demux-browser.js') });
  report.ua = await page.evaluate(() => navigator.userAgent);
  console.log(`\n页面：${report.ua.match(/(Chrome|Edg)\/[\d.]+/)?.[0]}\n`);

  for (const s of suites) {
    const r = await page.evaluate(async (o) => {
      const { dir, refName, W, H, fps, srcPremul, clamp, wantLevels } = o;
      const init = PCStream.parseInit(await (await fetch(`/${dir}/init.mp4`)).arrayBuffer());
      const segBuf = await (await fetch(`/${dir}/seg-000.m4s`)).arrayBuffer();
      const comp = PCStream.makeCompositor(document.getElementById('c'), { premultipliedAlpha: true, srcPremultiplied: srcPremul, clampToAlpha: clamp });
      const refs = [];
      for (let i = 0; i < 15; i++) refs.push(new Uint8Array(await (await fetch(`/${refName}/ref-${String(i).padStart(2, '0')}.raw`)).arrayBuffer()));

      const a = { aMax: 0, aSum: 0, aOver2: 0, aN: 0, pMax: 0, pSum: 0, pOver2: 0, pN: 0, bMax: 0, bSum: 0, bOver2: 0, bN: 0 };
      // 按 ref 的 alpha 级分桶，量**有符号**平均误差：系统性偏移会整桶同号
      const lv = wantLevels ? Array.from({ length: 16 }, () => ({ n: 0, signed: 0, abs: 0, max: 0 })) : null;
      let seen = 0, codedSize = null, err = null;

      const onFrame = (f) => {
        const idx = seen++;
        if (!codedSize) codedSize = `${f.codedWidth}x${f.codedHeight}`;
        comp.draw(f, H);
        const d = comp.readPixels().data;
        f.close();
        const ref = refs[Math.min(idx, refs.length - 1)];
        const end = W * H * 4;
        for (let p = 0; p < end; p += 4) {
          const ra = ref[p + 3], ga = d[p + 3];
          const da = ga > ra ? ga - ra : ra - ga;
          if (da > a.aMax) a.aMax = da;
          a.aSum += da; a.aN++; if (da > 2) a.aOver2++;
          if (lv) {
            const b = lv[Math.min(15, Math.round(ra / 17))];
            b.n++; b.signed += ga - ra; b.abs += da; if (da > b.max) b.max = da;
          }
          for (let k = 0; k < 3; k++) {
            const rv = ref[p + k], gv = d[p + k];
            const refPre = ((rv * ra + 127) / 255) | 0;
            const dp = gv > refPre ? gv - refPre : refPre - gv;
            if (dp > a.pMax) a.pMax = dp;
            a.pSum += dp; a.pN++; if (dp > 2) a.pOver2++;
            if (ra === 0) { if (gv > a.bMax) a.bMax = gv; a.bSum += gv; a.bN++; if (gv > 2) a.bOver2++; }
          }
        }
      };
      const dec = new VideoDecoder({ output: onFrame, error: (e) => { err = String(e); } });
      dec.configure({ codec: init.codec, description: init.description, codedWidth: init.width, codedHeight: init.height, hardwareAcceleration: 'prefer-hardware' });
      for (const c of PCStream.chunksOf(segBuf, { segmentIndex: 0, fps, perSegment: 15 })) dec.decode(c);
      await dec.flush(); dec.close();

      return {
        decoded: seen, codedSize, err,
        alpha: { max: a.aMax, mean: +(a.aSum / Math.max(1, a.aN)).toFixed(4), over2Pct: +(100 * a.aOver2 / Math.max(1, a.aN)).toFixed(4) },
        rgbPremul: { max: a.pMax, mean: +(a.pSum / Math.max(1, a.pN)).toFixed(4), over2Pct: +(100 * a.pOver2 / Math.max(1, a.pN)).toFixed(4) },
        bleed: { max: a.bMax, mean: +(a.bSum / Math.max(1, a.bN)).toFixed(4), over2Pct: +(100 * a.bOver2 / Math.max(1, a.bN)).toFixed(4), n: a.bN },
        levels: lv ? lv.map((b, i) => ({ alpha: Math.min(255, i * 17), n: b.n, signedMean: +(b.signed / Math.max(1, b.n)).toFixed(3), absMean: +(b.abs / Math.max(1, b.n)).toFixed(3), max: b.max })) : null,
      };
    }, { dir: s.dir, refName: s.name, W: s.W, H: s.H, fps: FPS, srcPremul: s.srcPremultiplied, clamp: !!s.clampToAlpha, wantLevels: s.suite === 'calib' });

    report.cases.push({ suite: s.suite, id: s.id, quality: s.quality, opts: s.opts, encodeMs: s.encodeMs, segBytes: s.segBytes, codec: s.codec, pixels: r });
    console.log(`${s.suite}/${s.id.padEnd(16)} ${(s.segBytes / 1024).toFixed(0).padStart(5)} KB  alpha 最大 ${String(r.alpha.max).padStart(3)} 均值 ${String(r.alpha.mean).padEnd(7)} >2 ${String(r.alpha.over2Pct).padEnd(8)}%  |  RGB(预乘) 最大 ${String(r.rgbPremul.max).padStart(3)} 均值 ${String(r.rgbPremul.mean).padEnd(7)}  |  透明区渗边 最大 ${String(r.bleed.max).padStart(3)} 均值 ${r.bleed.mean}`);
    if (r.levels) {
      const nz = r.levels.filter((l) => l.n > 0);
      console.log(`   按 alpha 级（有符号均值 / 绝对均值 / 最大）：${nz.map((l) => `${l.alpha}:${l.signedMean}/${l.absMean}/${l.max}`).join('  ')}`);
    }
  }
} finally {
  await factory.release(handle).catch(() => {});
  await close();
  await closeAll([server]);
}

if (jsonOut) console.log(`\nJSON -> ${writeJson(String(jsonOut), report)}`);
