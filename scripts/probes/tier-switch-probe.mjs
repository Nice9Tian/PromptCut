/**
 * 两档素材换档的端到端探针(`docs/plan/c66-design.md` 第 4 节、验收 T5 / T6 / T7):真 Chrome 里的真编辑台,
 * 素材从一台「远程素材服务」来,经本地素材服务的读路由按需拉取。
 *
 *   node scripts/probes/tier-switch-probe.mjs --origin http://127.0.0.1:5570 [--remote-port 5575] [--out <dir>]
 *
 * dev server 按分配的端口段起:`npx vite --port 5570 --strictPort --host 127.0.0.1`(舞台端口 5571 / 5572)。
 * 「远程素材服务」由本探针自己在 `--remote-port` 上起(只实现契约里本探针用到的几条:
 * `GET media/<hash>`(含 Range)、`GET media/<hash>/chunks`、跨源预检),每一档 `complete` 与否由探针控制。
 *
 * 测试素材现场用 ffmpeg 生成(设计稿第 8 节「测试素材」):1280×720、30 fps、6 秒,画面顶上一条 10 格的黑白条
 * 按二进制编码帧号(第 k 格亮 = 帧号第 k 位是 1),小版照设计稿的小版命令转(800×450),ProRes 原片是同一段画面
 * 转 `prores_ks`。每次运行在元数据里写一个随机串,哈希每次都不一样,不会命中上一次留在本地内容库里的文件。
 *
 * 场景:
 *   T5a(暂停中换档):素材层先透明(还没连远程,两档都没到齐,角上「等待上传方」)→ 连上远程、只有小版到齐:小版出现
 *        → 原片到齐:下一次轮询内换原片;换档前后同一目标时刻(2.5 s)解出的帧号相差不超过一帧,换档期间逐帧采样无黑帧。
 *   T5b(播放中换档):小版在播,中途原片到齐;换档那一刻前后两帧的帧号跳变与时间差对得上(误差 ≤ 1 帧),无黑帧。
 *   T6 :原片是 ProRes:本机探出放不了(设备本地缓存记 0),两档都到齐也一直停在小版。
 *   T7 :原片没到齐时导出:`exportVideo` 拒绝、提示「等待上传方」,顶栏点导出弹出同样的提示,没有任何导出请求发出。
 *
 * 输出:最后一行是一行 JSON(`ok`、各场景的关键数),截图在 `--out` 目录。
 * 帧号的读法:在可见舞台里对**显示着的**那个 `<video>` 做 `drawImage`,读顶上那条的 10 个格子。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import puppeteer from 'puppeteer';
import { devOrigin, flagArg } from './probe-connect.mjs';
import { findFfmpeg } from '../../server/bakery/ffmpeg.mjs';

const args = process.argv.slice(2);
const origin = devOrigin(args);
const REMOTE_PORT = Number(flagArg('remote-port', '5575', args));
const RUN = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-tier-probe-${RUN}`));
const FPS = 30;
const fails = [];
const notes = [];
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 400))); return !!cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(label, fn, timeoutMs, everyMs = 200) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() > deadline) { fails.push(`超时:${label}`); return null; }
    await sleep(everyMs);
  }
}

/* ------------------------------------------------------------------ 素材 */
await fs.mkdir(OUT, { recursive: true });
const ffmpeg = await findFfmpeg();
function ff(argv) {
  const r = spawnSync(ffmpeg, ['-v', 'error', '-y', ...argv], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg 失败:${r.stderr}`);
}
/** 一对素材(原片 + 小版)。`prores` 时原片转 ProRes MOV */
async function makePair(tag, { prores = false } = {}) {
  const src = path.join(OUT, `${tag}-src.mp4`);
  ff(['-f', 'lavfi', '-i', `color=c=gray:s=1280x720:r=${FPS}:d=6`,
    '-vf', "geq=lum='if(lt(Y,96),255*mod(floor(N/pow(2,floor(X/128))),2),96+64*sin(X/40+N/5))':cb=128:cr=128",
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-g', '150', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-metadata', `comment=${RUN}-${tag}`, src]);
  const orig = prores ? path.join(OUT, `${tag}-orig.mov`) : src;
  if (prores) ff(['-i', src, '-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', '-an', '-metadata', `comment=${RUN}-${tag}-p`, orig]);
  const small = path.join(OUT, `${tag}-small.mp4`);
  // 设计稿第 8 节的小版命令(保留 VFR 时间戳、只丢间隔不足 1/60 s 的帧、限 800×600、偶数尺寸)
  ff(['-i', orig, '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', "select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,1/60)',scale=w='min(iw\\,800)':h='min(ih\\,600)':force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1,format=yuv420p",
    '-fps_mode:v', 'vfr', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', small]);
  const read = async (f, type) => {
    const bytes = await fs.readFile(f);
    return { bytes, hash: crypto.createHash('sha256').update(bytes).digest('hex'), type };
  };
  return { orig: await read(orig, prores ? 'video/quicktime' : 'video/mp4'), small: await read(small, 'video/mp4'), ext: prores ? 'mov' : 'mp4' };
}

/* ------------------------------------------------------------------ 远程素材服务 */
const remoteFiles = new Map(); // hash → { bytes, type, complete }
const remoteLog = [];
const remote = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Range, Authorization', 'Access-Control-Max-Age': '600' });
    return res.end();
  }
  const m = /^\/api\/asset\/media\/([0-9a-f]{64})(\/chunks)?$/.exec(req.url.split('?')[0]);
  const f = m ? remoteFiles.get(m[1]) : null;
  remoteLog.push({ at: Date.now(), path: m ? `${m[1].slice(0, 8)}${m[2] ?? ''}` : req.url, auth: !!req.headers.authorization, range: req.headers.range ?? null });
  if (m && m[2]) {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(f ? { size: f.bytes.length, chunkSize: 8388608, received: f.complete ? [0] : [], complete: !!f.complete } : { size: null, chunkSize: 8388608, received: [], complete: false }));
  }
  if (!f || !f.complete) { res.statusCode = 404; return res.end('Not found'); }
  const range = req.headers.range && /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
  if (range) {
    const start = Number(range[1]);
    const end = range[2] ? Math.min(Number(range[2]), f.bytes.length - 1) : f.bytes.length - 1;
    res.writeHead(206, { 'Content-Type': f.type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${f.bytes.length}`, 'Accept-Ranges': 'bytes' });
    return res.end(req.method === 'HEAD' ? undefined : f.bytes.subarray(start, end + 1));
  }
  res.writeHead(200, { 'Content-Type': f.type, 'Content-Length': f.bytes.length, 'Accept-Ranges': 'bytes' });
  res.end(req.method === 'HEAD' ? undefined : f.bytes);
});
await new Promise((r) => remote.listen(REMOTE_PORT, '127.0.0.1', r));
const REMOTE_BASE = `http://127.0.0.1:${REMOTE_PORT}/api/asset`;
const publish = (x, complete) => remoteFiles.set(x.hash, { bytes: x.bytes, type: x.type, complete });

/* ------------------------------------------------------------------ 页面 */
const out = { ok: false, origin, run: RUN, out: OUT, T5a: {}, T5b: {}, T6: {}, T7: {} };
const browser = await puppeteer.launch({ headless: true, protocolTimeout: 300000,
  args: ['--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  const exportRequests = [];
  page.on('request', (r) => { if (/\/api\/export(\/|$)/.test(r.url())) exportRequests.push(r.url()); });
  await page.goto(origin + '/?editor&nosetup=1&preview=stage', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(async () => {
    const m = await import('/src/editor/stageBridge.ts');
    return !!m.frontStage() && m.backRole() === 'back';
  }, { timeout: 120000, polling: 500 });
  const ports = await (await fetch(origin + '/api/stage/ports')).json();
  const stagePorts = (ports.ports ?? []).slice(0, 2).map(String);
  const store = (fn, ...a) => page.evaluate(async (src, a2) => {
    const { actions, getState } = await import('/src/store/project.ts');
    // eslint-disable-next-line no-new-func
    return new Function('actions', 'getState', 'args', src)(actions, getState, a2);
  }, fn, a);
  const tiers = (fn, ...a) => page.evaluate(async (src, a2) => {
    const T = await import('/src/editor/media/assetTiers.ts');
    const AsyncFunction = (async () => {}).constructor;
    return new AsyncFunction('T', 'args', src)(T, a2);
  }, fn, a);
  const stageFrames = () => page.frames().filter((f) => /[?&]stage=1/.test(f.url()) && stagePorts.some((p) => f.url().includes(`:${p}/`)));
  const front = async () => {
    const id = await page.evaluate(() => window.__pcPreviewDiag?.().frontId ?? 'A');
    return stageFrames().find((f) => f.url().includes(`id=${id}`)) ?? null;
  };
  const preview = async (name) => {
    const el = await page.$('[data-pc="stage-frame"]');
    const box = el ? await el.boundingBox() : null;
    const file = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: file, clip: box ? { x: Math.max(0, box.x - 4), y: Math.max(0, box.y - 4), width: box.width + 8, height: box.height + 8 } : undefined });
    return file;
  };
  /** 显示着的素材层眼下是什么:哪一档、解出的帧号、就绪没有、角上有没有「等待上传方」 */
  const layer = async () => (await front())?.evaluate((F) => {
    const v = document.querySelector('[data-pc-media] > video');
    const awaiting = !!document.querySelector('[data-pc-media-awaiting]');
    if (!v) return { shown: false, awaiting };
    const r = { shown: true, awaiting, src: v.currentSrc || v.getAttribute('src') || '', rs: v.readyState, ct: v.currentTime, err: v.error?.code ?? null };
    if (v.readyState >= 2 && v.videoWidth) {
      const cv = document.createElement('canvas');
      cv.width = v.videoWidth; cv.height = v.videoHeight;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(v, 0, 0);
      const y = Math.round(cv.height * (48 / 720));
      let idx = 0;
      for (let k = 0; k < 10; k++) {
        const x = Math.round(cv.width * ((k + 0.5) / 10));
        if (ctx.getImageData(x, y, 1, 1).data[0] > 128) idx |= 1 << k;
      }
      r.idx = idx;
      r.expect = Math.round(v.currentTime * F);
    }
    return r;
  }, FPS);
  /** 在可见舞台里逐帧(真 rAF)采样显示着的那一层,直到 stopSampler */
  const startSampler = async () => (await front()).evaluate((F) => {
    window.__tierSamples = [];
    window.__tierSampling = true;
    window.__pcTierTrace = [];
    const cv = document.createElement('canvas');
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const now = () => (window.__pcRealNow ?? (() => performance.now()))();
    const raf = window.__pcRealRaf ?? window.requestAnimationFrame.bind(window);
    const loop = () => {
      if (!window.__tierSampling) return;
      const v = document.querySelector('[data-pc-media] > video');
      const s = { at: now(), shown: !!v, t: window.__pcStageDiag?.().t ?? null };
      if (v) {
        s.src = (v.currentSrc || '').split('/@media/')[1]?.slice(0, 8) ?? '';
        s.rs = v.readyState;
        s.ct = v.currentTime;
        if (v.readyState >= 2 && v.videoWidth) {
          cv.width = v.videoWidth; cv.height = v.videoHeight;
          ctx.drawImage(v, 0, 0);
          const y = Math.round(cv.height * (48 / 720));
          let idx = 0;
          for (let k = 0; k < 10; k++) if (ctx.getImageData(Math.round(cv.width * ((k + 0.5) / 10)), y, 1, 1).data[0] > 128) idx |= 1 << k;
          s.idx = idx;
          // 下半截的平均亮度:全黑(< 16)就是黑帧
          const d = ctx.getImageData(0, Math.round(cv.height * 0.5), cv.width, 1).data;
          let sum = 0;
          for (let i = 0; i < d.length; i += 4) sum += d[i];
          s.luma = sum / (d.length / 4);
        }
      }
      window.__tierSamples.push(s);
      raf(loop);
    };
    raf(loop);
  }, FPS);
  const stopSampler = async () => (await front()).evaluate(() => {
    window.__tierSampling = false;
    const trace = window.__pcTierTrace ?? [];
    delete window.__pcTierTrace;
    const samples = window.__tierSamples.splice(0);
    samples.trace = trace;
    return { samples, trace };
  });
  const blackOf = (samples, fromAt) => samples.filter((s) => s.at >= fromAt && (!s.shown || s.rs < 2 || !(s.luma > 16)));

  /**
   * 新项目 + 一段 6 秒的视频片段,素材记录带两档。
   * 注意:载入别的项目 = 回到本机空间(syncManager 的 switchToLocal),当前远程素材服务随之清掉 ——
   * 和「在共享项目里载入别的项目 = 离开共享项目」一个口径。所以 `remote` 为真时建完项目再连一次远程。
   */
  const setupProject = async (pair, name, remote = true) => {
    const r = await setupProjectOnly(pair, name);
    if (remote) await tiers(`T.setRemoteAssets({ base: args[0], ticket: async () => 'probe-ticket' });`, REMOTE_BASE);
    return r;
  };
  const setupProjectOnly = (pair, name) => store(`
    actions.newProject(args[0]);
    const m = actions.addMedia({ kind: 'video', name: args[0] + '.' + args[4], url: '/@media/' + args[1], hash: args[1], ext: args[4], size: args[3],
      tiers: { original: args[1], small: args[2] }, duration: 6, width: 1280, height: 720 });
    const c = actions.addMediaClip(m.id, 0, { duration: 6 });
    actions.seek(2.5);
    return { mediaId: m.id, clipId: c && c.id };`, name, pair.orig.hash, pair.small.hash, pair.orig.bytes.length, pair.ext);

  /* ============================================================ T5a:暂停中换档 */
  const A = await makePair('a');
  publish(A.small, false);
  publish(A.orig, false);
  await tiers('T.setRemoteAssets(null);');
  const setupA = await setupProject(A, `tier-a-${RUN}`, false);
  check(setupA?.clipId, 'T5a:加上了视频片段');
  // 1) 还没连远程:本地素材服务上两档都没有 → 透明 + 「等待上传方」
  const transparent = await until('T5a:素材层透明、角上「等待上传方」', async () => {
    const l = await layer();
    return l && l.awaiting && !(l.shown && l.rs >= 2) ? l : null;
  }, 15000);
  out.T5a.transparent = transparent ? { awaiting: transparent.awaiting, shown: transparent.shown, rs: transparent.rs ?? null } : null;
  out.T5a.shotTransparent = await preview('t5a-1-transparent');
  // 2) 连上远程、只有小版到齐 → 小版出现
  publish(A.small, true);
  const tConnect = Date.now();
  await tiers(`T.setRemoteAssets({ base: args[0], ticket: async () => 'probe-ticket' });`, REMOTE_BASE);
  const smallUp = await until('T5a:小版出现', async () => {
    const l = await layer();
    return l && l.shown && l.rs >= 2 && l.src.includes(A.small.hash) && Number.isInteger(l.idx) ? l : null;
  }, 20000);
  out.T5a.smallMs = Date.now() - tConnect;
  out.T5a.small = smallUp ? { idx: smallUp.idx, expect: smallUp.expect, awaiting: smallUp.awaiting } : null;
  check(smallUp && !smallUp.awaiting, 'T5a:小版出现后「等待上传方」撤下', smallUp);
  check(smallUp && Math.abs(smallUp.idx - 75) <= 1, 'T5a:小版停在 2.5 s(帧号 75 ± 1)', smallUp);
  out.T5a.shotSmall = await preview('t5a-2-small');
  // 3) 原片到齐 → 下一次轮询内换原片(轮询 2 s + 按需拉取 + 可播性探测 + 预热对齐)
  await startSampler();
  const samplerStart = await (await front()).evaluate(() => (window.__pcRealNow ?? (() => performance.now()))());
  publish(A.orig, true);
  const tOrig = Date.now();
  const polled = await until('T5a:页面轮询看到原片到齐', () => tiers(`return T.tierHashes().includes(args[0]);`, A.orig.hash), 10000, 50);
  out.T5a.pollMs = polled ? Date.now() - tOrig : null;
  check(out.T5a.pollMs !== null && out.T5a.pollMs <= 2600, 'T5a:complete 翻真后下一次轮询内看到(≤ 2 s + 余量)', out.T5a.pollMs);
  const origUp = await until('T5a:换到原片', async () => {
    const l = await layer();
    return l && l.shown && l.rs >= 2 && l.src.includes(A.orig.hash) && Number.isInteger(l.idx) ? l : null;
  }, 20000);
  out.T5a.switchMs = Date.now() - tOrig;
  await sleep(300);
  const { samples: samplesA, trace: traceA } = await stopSampler();
  out.T5a.trace = traceA.map((x) => ({ mediaTime: +x.mediaTime.toFixed(4), ref: +x.ref.toFixed(4), errFrames: +((x.mediaTime - x.ref) * x.fps).toFixed(2), playing: x.playing }));
  check(traceA.length >= 1 && traceA.every((x) => Math.abs(x.mediaTime - x.ref) * x.fps <= 1.03), 'T5a:换档那一帧的帧回调 mediaTime 与目标差不超过一帧', out.T5a.trace);
  out.T5a.original = origUp ? { idx: origUp.idx, expect: origUp.expect } : null;
  check(origUp && smallUp && Math.abs(origUp.idx - smallUp.idx) <= 1, 'T5a:换档前后同一目标时刻的帧号相差不超过一帧', { small: smallUp?.idx, orig: origUp?.idx });
  const blackA = blackOf(samplesA, samplerStart);
  out.T5a.samples = samplesA.length;
  out.T5a.black = blackA.length;
  check(samplesA.length > 10 && blackA.length === 0, 'T5a:换档期间逐帧采样无黑帧 / 无空档', blackA.slice(0, 3));
  const idxsA = [...new Set(samplesA.filter((s) => Number.isInteger(s.idx)).map((s) => s.idx))];
  out.T5a.idxSeen = idxsA;
  check(idxsA.every((i) => Math.abs(i - 75) <= 1), 'T5a:暂停中换档,画面一直停在 2.5 s(帧号 75 ± 1),没有跳回片头', idxsA);
  out.T5a.shotOriginal = await preview('t5a-3-original');
  out.T5a.playable = await (await front()).evaluate((h) => Object.keys(localStorage).filter((k) => k.endsWith(h)).map((k) => [k.split('.').slice(0, 3).join('.'), localStorage.getItem(k)]), A.orig.hash);

  /* ============================================================ T5b:播放中换档 */
  const B = await makePair('b');
  publish(B.small, true);
  publish(B.orig, false);
  await setupProject(B, `tier-b-${RUN}`);
  await store('actions.seek(0.3);');
  const readyB = await until('T5b:小版就绪', async () => { const l = await layer(); return l && l.rs >= 2 && l.src.includes(B.small.hash) ? l : null; }, 20000);
  if (!readyB) {
    out.T5b.debug = { layer: await layer(), tiers: await tiers('return T.assetTiersDebug();'), small: B.small.hash.slice(0, 8), orig: B.orig.hash.slice(0, 8),
      remoteLog: remoteLog.slice(-12), status: await (await fetch(origin + '/api/media/remote')).json() };
  }
  await startSampler();
  const bStart = await (await front()).evaluate(() => (window.__pcRealNow ?? (() => performance.now()))());
  await store('actions.play();');
  await sleep(800);
  publish(B.orig, true);
  const tB = Date.now();
  const switchedB = await until('T5b:播放中换到原片', async () => { const l = await layer(); return l && l.rs >= 2 && l.src.includes(B.orig.hash) ? l : null; }, 15000, 100);
  out.T5b.switchMs = switchedB ? Date.now() - tB : null;
  await sleep(600);
  const { samples: samplesB, trace: traceB } = await stopSampler();
  out.T5b.trace = traceB.map((x) => ({ mediaTime: +x.mediaTime.toFixed(4), ref: +x.ref.toFixed(4), errFrames: +((x.mediaTime - x.ref) * x.fps).toFixed(2), playing: x.playing }));
  check(traceB.length >= 1 && traceB.every((x) => Math.abs(x.mediaTime - x.ref) * x.fps <= 1.03), 'T5b:换档那一帧的帧回调 mediaTime 与画面上那一档此刻的时刻差不超过一帧', out.T5b.trace);
  await store('actions.pause();');
  const shotB = await preview('t5b-after-switch');
  out.T5b.shot = shotB;
  const decB = samplesB.filter((s) => s.at >= bStart && Number.isInteger(s.idx));
  const k = decB.findIndex((s, i) => i > 0 && decB[i - 1].src === B.small.hash.slice(0, 8) && s.src === B.orig.hash.slice(0, 8));
  if (k > 0) {
    const a = decB[k - 1], b = decB[k];
    // 画面上的帧号相对舞台时钟(目标时刻 = 舞台的 t,片段从 0 起、素材偏移 0)的偏差:换档前后这个偏差变化不超过一帧,
    // 就是「换档对准同一目标时间,帧误差不超过一帧」(两次采样之间播放头走了多少,两边一起扣掉)
    const errA = a.idx - Math.round(a.t * FPS), errB = b.idx - Math.round(b.t * FPS);
    out.T5b.swap = { before: { idx: a.idx, t: +a.t.toFixed(3), err: errA }, after: { idx: b.idx, t: +b.t.toFixed(3), err: errB }, frameError: errB - errA };
    check(Math.abs(out.T5b.swap.frameError) <= 1, 'T5b:播放中换档那一刻帧误差不超过一帧', out.T5b.swap);
    check(b.idx >= a.idx - 1, 'T5b:换档不往回跳', out.T5b.swap);
    // 换档之后 300 ms 内每一帧都有画(新档对调时已经交过对齐的帧)
    const after = samplesB.filter((s) => s.at >= b.at && s.at <= b.at + 300);
    out.T5b.afterSwapBlack = after.filter((s) => !s.shown || s.rs < 2 || !(s.luma > 16)).length;
    check(after.length > 0 && out.T5b.afterSwapBlack === 0, 'T5b:换档那一刻起 300 ms 内无黑帧 / 无空档', after.slice(0, 4));
  } else check(false, 'T5b:采样里找到了小版 → 原片的换档那一刻', { n: decB.length, srcs: [...new Set(samplesB.map((s) => s.src))] });
  // 解得出的帧里没有一帧是黑的(下半截平均亮度 < 16)
  const lumaBlack = decB.filter((s) => !(s.luma > 16));
  out.T5b.samples = samplesB.length;
  out.T5b.decoded = decB.length;
  out.T5b.lumaBlack = lumaBlack.length;
  check(decB.length > 10 && lumaBlack.length === 0, 'T5b:播放全程解得出的帧没有黑帧', lumaBlack.slice(0, 3));
  // 与换档无关的缓冲(播放中纠偏 seek 时 readyState 掉到 1,屏幕上仍是上一帧):只记数,不判
  out.T5b.bufferingSamples = blackOf(samplesB, bStart).length;
  const errs = decB.map((s) => s.idx - Math.round(s.t * FPS));
  out.T5b.frameErrVsStage = { min: Math.min(...errs), max: Math.max(...errs) };

  /* ============================================================ T6:原片不可播(ProRes) */
  const C = await makePair('c', { prores: true });
  publish(C.small, true);
  publish(C.orig, true);
  await setupProject(C, `tier-c-${RUN}`);
  const verdict = await until('T6:本机探出 ProRes 原片放不了(设备本地缓存记 0)', async () => {
    const v = await (await front()).evaluate((h) => { const k = Object.keys(localStorage).find((x) => x.startsWith('pc.playable.') && x.endsWith(h)); return k ? { key: k.replace(h, '<hash>'), value: localStorage.getItem(k) } : null; }, C.orig.hash);
    return v;
  }, 25000, 300);
  out.T6.cache = verdict;
  check(verdict && verdict.value === '0', 'T6:缓存结论是放不了', verdict);
  // 结论出来之后再看 5 秒:一直停在小版
  const stay = [];
  for (let i = 0; i < 10; i++) { const l = await layer(); stay.push(l?.src.includes(C.small.hash) ? 'small' : l?.src.includes(C.orig.hash) ? 'orig' : 'none'); await sleep(500); }
  out.T6.stay = [...new Set(stay)];
  check(stay.every((s) => s === 'small'), 'T6:两档都到齐,预览仍一直停在小版', stay);
  const lc = await layer();
  out.T6.idx = lc?.idx ?? null;
  out.T6.shot = await preview('t6-prores-stays-small');
  const projectHasNoPlayable = await store(`return JSON.stringify(getState().project).includes('playable');`);
  check(!projectHasNoPlayable, 'T6:项目文档里没有可播性字段');
  // 导出侧仍按原片:导出拦截问的是原片的哈希(两档都到齐 → 放行,不拿小版代替)
  const gateC = await tiers(`return (await T.exportGate((await import('/src/store/project.ts')).getState().project)).map((m) => m.hash);`);
  out.T6.exportGate = gateC;
  check(Array.isArray(gateC) && gateC.length === 0, 'T6:原片到齐了,导出不拦(导出只认原片)', gateC);

  /* ============================================================ T7:原片没到时导出 */
  const D = await makePair('d');
  publish(D.small, true);
  publish(D.orig, false);
  await setupProject(D, `tier-d-${RUN}`);
  await until('T7:小版就绪', async () => { const l = await layer(); return l && l.rs >= 2 && l.src.includes(D.small.hash) ? l : null; }, 20000);
  exportRequests.length = 0;
  const viaIo = await page.evaluate(async () => {
    try { await window.__pcIo.exportVideo(); return { resolved: true }; } catch (e) { return { message: String(e?.message ?? e), code: e?.code ?? null, missing: (e?.missing ?? []).length }; }
  });
  out.T7.exportVideo = viaIo;
  check(viaIo.code === 'awaiting-uploader' && /等待上传方/.test(viaIo.message) && viaIo.missing === 1, 'T7:exportVideo 拒绝并提示「等待上传方」、列出缺的素材', viaIo);
  // 顶栏点「导出」:不弹另存为,直接给同样的提示
  await sleep(2200); // 让轮询把「原片没到齐」记进集合
  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /导出/.test(x.textContent || '') || /导出/.test(x.getAttribute('title') || '') || /导出/.test(x.getAttribute('aria-label') || ''));
    if (!b) return false;
    b.click();
    return true;
  });
  const dialog = clicked ? await until('T7:导出对话框的提示', () => page.evaluate(() => { const t = document.body.innerText; return /等待上传方/.test(t) ? t.split('\n').find((l) => /等待上传方/.test(l)) : null; }), 5000) : null;
  out.T7.dialog = dialog;
  check(clicked, 'T7:顶栏找到了导出按钮');
  check(dialog && dialog.includes(`tier-d-${RUN}`), 'T7:对话框提示「等待上传方」并列出素材名', dialog);
  await sleep(300);
  out.T7.shot = path.join(OUT, 't7-export-blocked.png');
  await page.screenshot({ path: out.T7.shot });
  out.T7.exportRequests = exportRequests.length;
  check(exportRequests.length === 0, 'T7:没有发出任何导出请求(不出片)', exportRequests);

  /* ============================================================ 收尾 */
  const status = await (await fetch(origin + '/api/media/remote')).json();
  out.remoteAuthSeen = remoteLog.some((e) => e.auth);
  out.pull = { base: status.base, jobs: status.jobs.length };
  out.pageErrors = pageErrors.slice(0, 5);
  check(pageErrors.length === 0, '页面没有未捕获的错误', pageErrors.slice(0, 3));
  await tiers('T.setRemoteAssets(null);');
} catch (err) {
  fails.push(`探针异常:${err?.stack ?? err}`);
} finally {
  await browser.close().catch(() => {});
  remote.close();
}
out.fails = fails;
out.notes = notes;
out.ok = fails.length === 0;
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
