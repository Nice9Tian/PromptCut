/**
 * 在线页面的低内存档探针(`docs/plan/c10a-contract.md` 第 8、8.1、9、11.1 节):Chrome 移动端仿真(手机视口、触屏、
 * `deviceMemory: 4`)打开**在线构建的编辑页**,看能力闸、单舞台 live 预览、按清单拉预渲染小尺寸、逐帧导出。
 *
 *   node scripts/probes/lowmem-online-probe.mjs --origin http://127.0.0.1:5643 [--remote-port 5646] [--out <dir>]
 *
 * dev server 要带在线模式的编译期常量起:`VITE_PC_ONLINE=1 npx vite --port 5643 --strictPort --host 127.0.0.1`。
 *
 * 「远程素材服务」和「文档服务的内容库」都由本探针替身:
 *   - 素材服务在 `--remote-port` 上起(`GET media/<hash>`(含 Range)、`GET media/<hash>/chunks`、`GET px/<hash>`、
 *     `GET snap/<hash>`、跨源预检),**每个请求都记下来** —— 断言「网络记录里只有小尺寸」就看它;
 *   - 内容库是页面里的一张表,经 `assetTiers.connectSharedAssets(假连接)` 交给页面(和进入共享项目同一个口子),
 *     里面放渲染节点会写的层表(`layers:<项目 id>`)和段清单(`frames` 原尺寸、`small` 小尺寸)。
 *
 * 场景:
 *   G1 能力闸:只有一个同源舞台(没有 B)、带 `preview=stage`;舞台判出低内存档;没有探针遮罩、没有 `/api/data/costs`;进入提示照抄表 C。
 *   G2 只拉小尺寸:有小尺寸的视频只拉小尺寸;没有小尺寸的视频不拉、显示「等待上传方」;重卡贴 `px/<hash>` 的小位图;
 *      原尺寸(素材原片、`snap/`)一个请求都没有。
 *   G3 播放 2 秒、暂停:播放头跟舞台走;暂停后重卡仍抑制、贴小尺寸,不起追帧(不追活渲)。
 *   G4 逐帧导出:素材原尺寸没到齐时提示「等待上传方」、不出片,可取消;到齐后导出 2 秒,ffprobe 核对帧数、时长、编码;
 *      请求记录里有素材原尺寸与 `snap/`(预渲染原尺寸);重卡那一层画的是原尺寸快照(品红「原尺寸」色块在画面里)。
 *
 * 输出:最后一行一行 JSON(`ok`、`fails`、各场景的数),截图与导出的 MP4 在 `--out`。
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
const REMOTE_PORT = Number(flagArg('remote-port', '5646', args));
const RUN = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-lowmem-online-${RUN}`));
await fs.mkdir(OUT, { recursive: true });
const FPS = 30;
const fails = [];
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 400))); return !!cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(label, fn, timeoutMs, everyMs = 200) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() > deadline) { fails.push(`等不到:${label}`); return null; }
    await sleep(everyMs);
  }
}
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

/* ------------------------------------------------------------------ 素材 */
const ffmpeg = await findFfmpeg();
const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, (m) => (m.toLowerCase().endsWith('.exe') ? 'ffprobe.exe' : 'ffprobe'));
function run(cmd, a) {
  const r = spawnSync(cmd, a, { encoding: 'buffer', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} 退出码 ${r.status}:${String(r.stderr).slice(-600)}`);
  return r.stdout;
}
async function makeFile(name, argv) {
  const file = path.join(OUT, name);
  run(ffmpeg, ['-y', '-v', 'error', ...argv, '-metadata', `comment=${RUN}`, file]);
  const bytes = await fs.readFile(file);
  return { file, bytes, hash: sha256(bytes) };
}
// 有小尺寸的视频:原片 1280×720 带声音,小尺寸 800×450
const origA = await makeFile('a-orig.mp4', ['-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
  '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']);
const smallA = await makeFile('a-small.mp4', ['-i', origA.file, '-vf', 'scale=800:450', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac']);
// 没有小尺寸的视频(浏览器里导入的只有原尺寸)
const origB = await makeFile('b-orig.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']);
// 预渲染小尺寸:两张 800×450 的位图(蓝、绿)轮换;原尺寸:每帧一份 HTML 快照(品红色块 + 帧号)
const smallBlue = await makeFile('small-blue.png', ['-f', 'lavfi', '-i', 'color=c=0x2040ff:s=800x450', '-frames:v', '1']);
const smallGreen = await makeFile('small-green.png', ['-f', 'lavfi', '-i', 'color=c=0x20c040:s=800x450', '-frames:v', '1']);

/* ------------------------------------------------------------------ 远程素材服务(替身,记下每个请求) */
const files = new Map(); // `${ns}/${hash}` → { bytes, type, complete }
const requests = [];
const put = (ns, hash, bytes, type, complete = true) => files.set(`${ns}/${hash}`, { bytes, type, complete });
put('media', origA.hash, origA.bytes, 'video/mp4', false);
put('media', smallA.hash, smallA.bytes, 'video/mp4', true);
put('media', origB.hash, origB.bytes, 'video/mp4', true);
put('px', smallBlue.hash, smallBlue.bytes, 'image/png');
put('px', smallGreen.hash, smallGreen.bytes, 'image/png');
const remote = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Range, Content-Type' });
    return res.end();
  }
  const m = /^\/api\/asset\/(media|px|snap)\/([0-9a-f]{64})(\/chunks)?$/.exec(url.pathname);
  requests.push({ at: Date.now(), ns: m?.[1] ?? '?', hash: m?.[2] ?? url.pathname, chunks: !!m?.[3], ticket: url.searchParams.get('t') || (req.headers.authorization || '').replace(/^Bearer\s+/, '') || null });
  if (!m) { res.statusCode = 404; return res.end(); }
  const f = files.get(`${m[1]}/${m[2]}`);
  if (m[3]) {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ hash: m[2], complete: !!f?.complete, received: [] }));
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
const reqsOf = (ns, hash) => requests.filter((r) => r.ns === ns && (!hash || r.hash === hash) && !r.chunks);

/* ------------------------------------------------------------------ 页面(手机仿真) */
const out = { ok: false, origin, run: RUN, out: OUT, G1: {}, G2: {}, G3: {}, G4: {} };
const browser = await puppeteer.launch({ headless: true, protocolTimeout: 600000,
  args: ['--no-first-run', '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await browser.newPage();
  await page.emulate({
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
    viewport: { width: 412, height: 915, deviceScaleFactor: 2.6, isMobile: true, hasTouch: true, isLandscape: false },
  });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(Navigator.prototype, 'deviceMemory', { configurable: true, get: () => 4 });
  });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  const apiRequests = [];
  page.on('request', (r) => { const u = r.url(); if (/\/api\/data\/costs|\/api\/frames\//.test(u)) apiRequests.push(u); });
  await page.goto(origin + '/?editor&nosetup=1', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await until('可见舞台握手', () => page.evaluate(async () => !!(await import('/src/editor/stageBridge.ts')).frontStage()), 180000, 500);

  const store = (fn, ...a) => page.evaluate(async (src, a2) => {
    const { actions, getState } = await import('/src/store/project.ts');
    return new Function('actions', 'getState', 'args', src)(actions, getState, a2);
  }, fn, a);
  const stageFrame = () => page.frames().find((f) => /[?&]stage=1/.test(f.url()) && /[?&]id=A/.test(f.url()));

  /* ============================================================ G1:能力闸 */
  const g1 = await page.evaluate(async () => {
    const bridge = await import('/src/editor/stageBridge.ts');
    const caps = bridge.stageCapabilities('front');
    const frames = [...document.querySelectorAll('iframe')].map((f) => ({ pc: f.dataset.pc || '', src: f.getAttribute('src') || '' }));
    return { caps, frames, mm: { coarse: matchMedia('(pointer: coarse)').matches, anyCoarse: matchMedia('(any-pointer: coarse)').matches }, touch: navigator.maxTouchPoints, mem: navigator.deviceMemory, screen: [screen.width, screen.height] };
  });
  out.G1 = g1;
  check(g1.caps?.lowMemory === true, 'G1 舞台判出低内存档', g1.caps);
  const stageIframes = g1.frames.filter((f) => /[?&]stage=1/.test(f.src));
  check(stageIframes.length === 1, 'G1 只有一个舞台 iframe(没有 B)', g1.frames);
  check(!g1.frames.some((f) => f.pc === 'stage-frame-back'), 'G1 没有后台舞台');
  check(stageIframes[0] && /[?&]preview=stage/.test(stageIframes[0].src) && stageIframes[0].src.startsWith('/'), 'G1 同源单舞台带 preview=stage(live 变体)', stageIframes[0]);
  const stagePolicy = await stageFrame()?.evaluate(async () => (await import('/src/render/mediaTier.ts')).mediaTierPolicy());
  check(stagePolicy?.lowMemory === true, 'G1 舞台里的取档策略是低内存档', stagePolicy);

  /* ============================================================ 项目 + 替身内容库 */
  const setup = await store(`
    actions.newProject('lowmem-${RUN}');
    const a = actions.addMedia({ kind: 'video', name: 'a.mp4', url: '/@media/' + args[0], hash: args[0], ext: 'mp4', size: args[3], tiers: { original: args[0], small: args[1] }, duration: 4, width: 1280, height: 720 });
    const b = actions.addMedia({ kind: 'video', name: 'b.mp4', url: '/@media/' + args[2], hash: args[2], ext: 'mp4', size: args[4], tiers: { original: args[2] }, duration: 4, width: 1280, height: 720 });
    const ca = actions.addMediaClip(a.id, 0, { duration: 4 });
    const cb = actions.addClipOnNewTrack ? null : null;
    const heavy = actions.addClipOnNewTrack({ index: 0, cardId: 'punch-pill', start: 0, duration: 4 });
    actions.setClipParams(heavy.id, { text: '重卡 ${RUN}' });
    actions.setClipFrame(heavy.id, { x: 480, y: 270, w: 960, h: 540, anchor: [0.5, 0.5] });
    actions.seek(1);
    const p = getState().project;
    return { projectId: p.id, heavyId: heavy.id, mediaA: a.id, mediaB: b.id, clipA: ca && ca.id, fps: p.fps, width: p.width, height: p.height };`,
    origA.hash, smallA.hash, origB.hash, origA.bytes.length, origB.bytes.length);
  out.setup = setup;
  // 没有小尺寸的视频放在第二条轨上,和重卡错开位置
  await store(`const c = actions.addMediaClip(args[0], 0, { duration: 4 }); if (c) actions.setClipFrame(c.id, { x: 1440, y: 810, w: 640, h: 360, anchor: [0.5, 0.5] }); return c && c.id;`, setup.mediaB);

  // 层表与段清单:重卡 4 秒 = 120 帧 = 两段;小尺寸蓝绿轮换,原尺寸每帧一份 HTML 快照(品红色块)
  const count = 4 * FPS;
  const RK = crypto.randomBytes(32).toString('hex');
  const content = {};
  content[`layers:${setup.projectId}`] = { v: 1, kind: 'layer-map', projectId: setup.projectId, fps: FPS, width: 1920, height: 1080, span: 60, at: Date.now(),
    layers: [{ clipId: setup.heavyId, kind: 'html', key: RK, tier: 'shared', resultKey: RK, dirKey: RK, entryKey: null, firstFrame: 0, count }] };
  const snapHashes = [];
  for (let f = 0; f < count; f++) {
    const html = `<div style="position:absolute;inset:0;background:rgb(255,0,255);display:flex;align-items:center;justify-content:center;font:bold 120px sans-serif;color:#fff">原尺寸 ${f}</div>`;
    const bytes = Buffer.from(html, 'utf8');
    const hash = sha256(bytes);
    put('snap', hash, bytes, 'text/html; charset=utf-8');
    snapHashes.push(hash);
  }
  for (const [from, to] of [[0, 59], [60, 119]]) {
    const frames = [], small = [];
    for (let f = from; f <= to; f++) {
      frames.push([f, snapHashes[f], 200]);
      const s = (Math.floor(f / 15) % 2) ? smallGreen : smallBlue;
      small.push([f, s.hash, s.bytes.length]);
    }
    content[`${RK}:${from}-${to}`] = { v: 1, kind: 'snapshot', tier: 'shared', resultKey: RK, dirKey: RK, entryKey: null, range: { from, to }, canvasHeavy: false, frames, small };
  }
  await page.evaluate(async (c, base) => {
    window.__probeContent = c;
    window.__probeDocRequests = [];
    const link = {
      async request(msg) {
        window.__probeDocRequests.push(msg);
        if (msg.type === 'service.watch') return { type: 'service.watching', endpoints: [] };
        if (msg.type === 'content.get') {
          const body = window.__probeContent[msg.key];
          return body === undefined ? { type: 'content.item', kind: msg.kind, key: msg.key, missing: true } : { type: 'content.item', kind: msg.kind, key: msg.key, body, hash: 'x' };
        }
        if (msg.type === 'auth.ticket') return { type: 'auth.ticket.ok', ticket: 'probe-ticket', exp: Date.now() + 15 * 60_000 };
        throw new Error('替身连接不认 ' + msg.type);
      },
    };
    const T = await import('/src/editor/media/assetTiers.ts');
    await T.connectSharedAssets(link, 'ws://127.0.0.1:1/hosted/');
    T.setRemoteAssets({ base, ticket: async () => 'probe-ticket' });
  }, content, REMOTE_BASE);

  /* ============================================================ G2:只拉小尺寸 */
  const g2 = await until('重卡贴上小位图', () => stageFrame()?.evaluate((id) => {
    const wrap = document.querySelector(`[data-pc-clip="${CSS.escape(id)}"]`);
    const img = wrap?.querySelector('[data-pc-snapshot-plane] img[data-pc-small-snapshot]');
    return img && img.complete && img.naturalWidth ? { cls: wrap.className, w: img.naturalWidth, h: img.naturalHeight } : null;
  }, setup.heavyId), 60000, 500);
  out.G2.heavy = g2;
  await until('素材 a 的小尺寸在放', () => stageFrame()?.evaluate(() => [...document.querySelectorAll('[data-pc-media] > video')].some((v) => v.readyState >= 2 && /media\/[0-9a-f]{64}/.test(v.currentSrc))), 60000, 500);
  const awaiting = await stageFrame()?.evaluate(() => !!document.querySelector('[data-pc-media-awaiting]'));
  out.G2.awaitingBadge = awaiting;
  check(awaiting, 'G2 没有小尺寸的视频显示「等待上传方」');
  await sleep(1500);
  await page.screenshot({ path: path.join(OUT, 'g2-phone.png') });
  const snapshotView = { smallA: reqsOf('media', smallA.hash).length, origA: reqsOf('media', origA.hash).length, origB: reqsOf('media', origB.hash).length,
    px: reqsOf('px').length, snap: reqsOf('snap').length, tickets: [...new Set(requests.map((r) => r.ticket))] };
  out.G2.requests = snapshotView;
  check(snapshotView.smallA > 0, 'G2 拉了素材小尺寸', snapshotView);
  check(snapshotView.origA === 0, 'G2 有小尺寸的视频没拉原尺寸', snapshotView);
  check(snapshotView.origB === 0, 'G2 没有小尺寸的视频不拉原尺寸', snapshotView);
  check(snapshotView.px > 0, 'G2 拉了预渲染小尺寸 px/<hash>', snapshotView);
  check(snapshotView.snap === 0, 'G2 没拉预渲染原尺寸 snap/<hash>', snapshotView);
  check(snapshotView.tickets.every((t) => t === 'probe-ticket'), 'G2 每个请求都带只读票据', snapshotView.tickets);
  const toast = await page.evaluate(() => document.body.innerText.includes('当前是低内存档：只看预渲染小尺寸和素材小尺寸'));
  check(toast, 'G1 进入提示照抄表 C');
  const online = await page.evaluate(() => window.__pcOnlineSnapshots?.());
  out.G2.onlineSource = online;

  /* ============================================================ G3:播放、暂停不追活渲 */
  const t0 = await page.evaluate(async () => (await import('/src/store/project.ts')).getState().t);
  await store(`actions.play();`);
  await sleep(2000);
  await store(`actions.pause();`);
  await sleep(800);
  const g3 = await page.evaluate(async () => (await import('/src/store/project.ts')).getState().t);
  const stageState = await stageFrame()?.evaluate((id) => {
    const d = window.__pcStageDiag?.() ?? {};
    const wrap = document.querySelector(`[data-pc-clip="${CSS.escape(id)}"]`);
    return { settling: d.settling ?? null, suppressed: d.suppressed ?? null, cls: wrap?.className ?? null, hasSmall: !!wrap?.querySelector('img[data-pc-small-snapshot]') };
  }, setup.heavyId);
  out.G3 = { t0, t1: g3, stage: stageState };
  check(g3 - t0 > 1, 'G3 播放头跟舞台走了 1 秒以上', { t0, t1: g3 });
  check(stageState && /pc-suppressed/.test(stageState.cls || '') && stageState.hasSmall, 'G3 暂停后重卡仍抑制、贴小尺寸(不追活渲)', stageState);
  check(!stageState?.settling || (Array.isArray(stageState.settling) ? !stageState.settling.length : !Object.keys(stageState.settling).length), 'G3 暂停后没有追帧', stageState);
  check(apiRequests.length === 0, 'G1 没有探针 / 预渲染进程的请求(/api/data/costs、/api/frames)', apiRequests.slice(0, 5));
  const probeGate = await page.$('[data-pc="probe-gate"]');
  check(!probeGate, 'G1 没有探针遮罩');

  /* ============================================================ G4:逐帧导出 */
  // 素材原尺寸 a 还没到齐:提示等待上传方,不出片;取消
  const waiting = await page.evaluate(async () => {
    const io = await import('/src/editor/io/index.ts');
    const seen = [];
    let id = null;
    const run = io.exportVideo({ maxFrames: 30, onStart: (x) => { id = x; }, onWaiting: (m) => { if (m) seen.push(m); } });
    for (let i = 0; i < 100 && !seen.length; i++) await new Promise((r) => setTimeout(r, 100));
    await io.cancelExport(id);
    let err = null;
    try { await run; } catch (e) { err = { message: e.message, cancelled: !!e.cancelled }; }
    return { seen, err };
  });
  out.G4.waiting = waiting;
  check(waiting.seen.some((m) => m.includes('等待上传方')), 'G4 原尺寸没到齐时提示等待上传方', waiting);
  check(waiting.err?.cancelled, 'G4 可以取消,不出片', waiting.err);
  const beforeExport = requests.length;
  files.get(`media/${origA.hash}`).complete = true;
  const exported = await page.evaluate(async () => {
    const io = await import('/src/editor/io/index.ts');
    let id = null;
    const progress = [];
    const t0 = performance.now();
    const r = await io.exportVideo({ maxFrames: 60, onStart: (x) => { id = x; }, onProgress: (d, t) => { if (d % 20 === 0 || d === t) progress.push([d, t]); } });
    const blob = await io.fetchExportFile(r.id, 'preview.mp4');
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { id, ms: Math.round(performance.now() - t0), size: buf.length, progress, base64: btoa(bin) };
  });
  const mp4 = path.join(OUT, 'lowmem-export.mp4');
  await fs.writeFile(mp4, Buffer.from(exported.base64, 'base64'));
  const exportReqs = requests.slice(beforeExport);
  out.G4.export = { ms: exported.ms, size: exported.size, progress: exported.progress,
    originals: { mediaOrig: exportReqs.filter((r) => r.ns === 'media' && r.hash === origA.hash && !r.chunks).length, snap: exportReqs.filter((r) => r.ns === 'snap').length,
      smallMedia: exportReqs.filter((r) => r.ns === 'media' && r.hash === smallA.hash && !r.chunks).length } };
  const info = JSON.parse(String(run(ffprobe, ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,codec_name,width,height,nb_read_frames,duration:format=duration', '-of', 'json', mp4])));
  out.G4.ffprobe = info;
  const v = info.streams.find((s) => s.codec_type === 'video');
  const a = info.streams.find((s) => s.codec_type === 'audio');
  check(v?.codec_name === 'h264' && Number(v.nb_read_frames) === 60 && Math.abs(Number(v.duration) - 2) < 0.01 && v.width === 1920 && v.height === 1080, 'G4 ffprobe:h264、60 帧、2 秒、1920×1080', v);
  check(a?.codec_name === 'aac', 'G4 有 AAC 音轨(原片带声音)', a ?? null);
  check(out.G4.export.originals.mediaOrig > 0, 'G4 导出拉的是素材原尺寸', out.G4.export.originals);
  check(out.G4.export.originals.snap > 0, 'G4 导出用了预渲染原尺寸 snap/', out.G4.export.originals);
  // 第 30 帧:重卡那一层(画面中央 960×540 的框)是品红的原尺寸快照
  const png = path.join(OUT, 'export-f30.png');
  run(ffmpeg, ['-y', '-v', 'error', '-i', mp4, '-vf', 'select=eq(n\\,30)', '-frames:v', '1', png]);
  const rgb = run(ffmpeg, ['-v', 'error', '-i', png, '-vf', 'crop=4:4:958:538', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  const px = [rgb[0], rgb[1], rgb[2]];
  out.G4.centerPixel = px;
  check(px[0] > 200 && px[1] < 60 && px[2] > 200, 'G4 重卡那一层画的是原尺寸快照(品红)', px);
  check(pageErrors.length === 0, '页面没有报错', pageErrors.slice(0, 5));
  // C10a 集成返工:在线页面不许露出被守卫拦下的 /api 报错 —— 全程守卫一条都没拦到,页面文字里没有 /api/
  const apiBlocked = await page.evaluate(() => [...(window.__pcApiBlocked ?? [])]);
  const apiText = await page.evaluate(() => (document.body.innerText.match(/[^\n]*\/api\/[^\n]*/g) ?? []).slice(0, 5));
  await page.screenshot({ path: path.join(OUT, 'g5-phone-end.png') });
  out.apiBlocked = apiBlocked;
  check(apiBlocked.length === 0, 'G5 全程没有被守卫拦下的 /api 请求', apiBlocked);
  check(apiText.length === 0, 'G5 页面上没有 /api 报错', apiText);
  out.pageErrors = pageErrors.slice(0, 10);
} catch (e) {
  fails.push('探针异常:' + (e?.stack || e));
} finally {
  await browser.close().catch(() => {});
  remote.close();
}
out.fails = fails;
out.ok = fails.length === 0;
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
