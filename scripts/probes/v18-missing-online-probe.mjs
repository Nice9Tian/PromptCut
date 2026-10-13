/**
 * 0.7.18 块四的在线浏览器探针：带「确认缺失」记录的项目在**在线构建**里预览与导出，画面出「找不到素材」加文件名，
 * 声音放得出随软件分发的那段人声（`docs/plan/account-binding-task.md`「逐项验收」的「缺失视觉/音频素材」一行里
 * 「在线浏览器」那一半）。
 *
 * 全程在本机：自己起的托管组合（文档服务、素材服务，临时数据目录）加仿 nginx 的隔离代理（`lib/hosted-proxy.mjs`，
 * 策略头与线上同一份）。页面经「刷新后回到项目」那条现成的产品路径进入一个凭口令的共享项目（`lib/online-resume-entry.mjs`）。
 * 项目内容由探针替创建者写进文档服务：三条素材（视频、声音、图片）都带「确认缺失」的记录，素材服务里没有它们的字节。
 * 在线页面不认定缺失（那是打开本机项目后的后台检查的事），只照记录出占位。
 *
 *   npx vite build --mode online        # 先有在线构建
 *   node scripts/probes/v18-missing-online-probe.mjs [--dist dist-online] [--base 28484] [--doc-port 28481] [--asset-port 28482] [--shots <目录>]
 *
 * 输出最后一行是一行 JSON：`{ ok, fails, ... }`，退出码 0 = 全过。
 */
import '../lib/no-user-dirs.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { findFfmpeg } from '../../server/bakery/ffmpeg.mjs';
import { startHostedCombo } from '../../server/hosted/combo.mjs';
import { createSharedProject, buildAuthProtocols } from '../../server/auth/client.mjs';
import { startHostedProxy, proxyOrigins } from './lib/hosted-proxy.mjs';
import { resumeRecord, plantResume } from './lib/online-resume-entry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const DIST = path.resolve(arg('--dist', path.join(ROOT, 'dist-online')));
const BASE = Number(arg('--base', 28484)), DOC_PORT = Number(arg('--doc-port', 28481)), ASSET_PORT = Number(arg('--asset-port', 28482));
const RUN = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), `pc-v18-missing-online-${RUN}`)));
const SHOTS = path.resolve(arg('--shots', path.join(OUT, 'shots')));
fs.mkdirSync(OUT, { recursive: true }); fs.mkdirSync(SHOTS, { recursive: true });

const fails = [];
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 700))); return !!cond; };
const log = (...a) => console.error('[v18-missing-online]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const ffmpeg = await findFfmpeg();
function run(cmd, a) {
  const r = spawnSync(cmd, a, { encoding: 'buffer', windowsHide: true, maxBuffer: 1024 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} 退出码 ${r.status}:${String(r.stderr).slice(-600)}`);
  return r.stdout;
}
function audioRms(file, start, dur) {
  const pcm = run(ffmpeg, ['-v', 'error', '-ss', String(start), '-t', String(dur), '-i', file, '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', '-']);
  const n = Math.floor(pcm.length / 2); let sq = 0;
  for (let i = 0; i < n; i++) { const v = pcm.readInt16LE(i * 2) / 32768; sq += v * v; }
  const rms = n ? Math.sqrt(sq / n) : 0;
  return { samples: n, rmsDb: rms ? +(20 * Math.log10(rms)).toFixed(1) : -120 };
}
function frameStats(file, at) {
  const raw = run(ffmpeg, ['-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1', '-vf', 'scale=64:36,format=gray', '-f', 'rawvideo', '-']);
  let sum = 0; for (const b of raw) sum += b;
  const mean = raw.length ? sum / raw.length : 0; let v = 0; for (const b of raw) v += (b - mean) ** 2;
  return { mean: +mean.toFixed(1), std: raw.length ? +Math.sqrt(v / raw.length).toFixed(1) : 0 };
}

const out = { ok: false, run: RUN, out: OUT, shots: SHOTS };
const cleanups = [];
try {
  if (!check(fs.existsSync(path.join(DIST, 'index.html')), '前提：有在线构建', DIST)) throw new Error('没有在线构建');
  const wavHash = sha256(fs.readFileSync(path.join(ROOT, 'src', 'audio', 'assets', 'missing-material.wav')));
  const built = fs.readdirSync(path.join(DIST, 'assets')).filter((f) => /^missing-material.*\.wav$/.test(f));
  check(built.length === 1 && sha256(fs.readFileSync(path.join(DIST, 'assets', built[0]))) === wavHash, '在线构建里带着同一份人声文件', built);

  const ORIGINS = proxyOrigins(BASE);
  const DOC_DIRECT = `http://127.0.0.1:${DOC_PORT}`;
  log('起托管组合与隔离代理', BASE, DOC_PORT, ASSET_PORT);
  const dataDir = fs.mkdtempSync(path.join(OUT, 'hosted-'));
  const combo = await startHostedCombo({ dataDir, docPort: DOC_PORT, assetPort: ASSET_PORT, host: '127.0.0.1', trustLoopback: false, clusterToken: crypto.randomBytes(32).toString('base64url'),
    docPublicUrl: `ws://pc.localhost:${BASE}/hosted/`, assetPublicUrl: `${ORIGINS.editor}/media/api/asset`, log: () => {} });
  cleanups.push(() => combo.close?.());
  const proxy = await startHostedProxy({ dist: DIST, basePort: BASE, docPort: DOC_PORT, assetPort: ASSET_PORT, policy: 'full' });
  cleanups.push(() => proxy.close());

  const NAME = `v18missing-${RUN}`;
  const creator = { username: 'boss', password: `boss-${crypto.randomBytes(9).toString('hex')}` };
  const PROJECT_PW = `pw-${crypto.randomBytes(9).toString('hex')}`;
  const made = await createSharedProject({ base: DOC_DIRECT, name: NAME, mode: 'free', creator, password: PROJECT_PW });

  // 替创建者写进项目内容：三条带「确认缺失」记录的素材（素材服务里没有它们的字节）和引用它们的片段
  const rnd = () => crypto.randomBytes(32).toString('hex');
  const mk = (id, kind, name) => {
    const hash = rnd(); const m = { id, kind, name: `(缺失) ${name}`, url: `/@media/${hash}`, hash, ext: name.split('.').pop(), duration: 2, ...(kind === 'audio' ? {} : { width: 640, height: 360 }) };
    return { ...m, missingMaterial: { v: 1, mediaId: id, reason: 'confirmed-missing', original: { kind, name: m.name, url: m.url, hash }, visual: kind !== 'audio', audio: kind !== 'image' } };
  };
  const VIDEO = '丢失的镜头.mp4', VOICE = '丢失的旁白.mp3', IMAGE = '丢失的封面.png';
  const body = { version: 1, id: `seed-${made.projectId.slice(-8)}`, name: NAME, width: 1280, height: 720, fps: 30, duration: 6, themeId: 'midnight',
    media: [mk('m-v', 'video', VIDEO), mk('m-a', 'audio', VOICE), mk('m-i', 'image', IMAGE)],
    tracks: [{ id: 't-1', name: '画面', clips: [{ id: 'c-v', mediaId: 'm-v', start: 0, end: 2, audioMuted: true }, { id: 'c-i', mediaId: 'm-i', start: 2, end: 4 }] },
      { id: 't-2', name: '配音', clips: [{ id: 'c-a', mediaId: 'm-a', start: 2.5, end: 4.5 }] }] };
  {
    const protocols = await buildAuthProtocols({ base: DOC_DIRECT, projectId: made.projectId, username: creator.username, deviceId: 'v18-missing-seed-01', deviceName: 'probe-seed', as: 'creator', password: creator.password, role: 'page' });
    const ws = new WebSocket(DOC_DIRECT.replace(/^http/, 'ws'), protocols);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
    const ask = (msg) => new Promise((resolve) => { const reqId = `seed${Math.random().toString(36).slice(2)}`; const on = (ev) => { const m = JSON.parse(String(ev.data)); if (m.reqId === reqId) { ws.removeEventListener('message', on); resolve(m); } }; ws.addEventListener('message', on); ws.send(JSON.stringify({ ...msg, reqId })); });
    const opened = await ask({ type: 'project.open', projectId: made.projectId });
    const seeded = await ask({ type: 'project.op', projectId: made.projectId, opId: crypto.randomBytes(16).toString('base64url'), ops: [{ op: 'set', path: '', value: body }] });
    ws.close();
    check(!/error|reject/i.test(`${opened?.type} ${seeded?.type}`), '准备：项目内容写进文档服务', [opened?.type, seeded?.type]);
  }

  const browser = await puppeteer.launch({ headless: true, protocolTimeout: 900_000, args: [...PROBE_CHROME_ARGS, '--no-first-run', '--hide-scrollbars', '--site-per-process', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required'] });
  cleanups.push(() => browser.close());
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  const errors = [], refused = [];
  page.on('pageerror', (e) => errors.push(String(e?.message ?? e).slice(0, 300)));
  page.on('console', (m) => { if (/Refused to /.test(m.text())) refused.push(m.text().slice(0, 300)); });
  page.on('dialog', (d) => d.accept().catch(() => {}));
  const record = await resumeRecord({ base: `${ORIGINS.editor}/hosted/`, derivationBase: DOC_DIRECT, projectId: made.projectId, name: NAME, username: 'member-a', password: PROJECT_PW, deviceId: 'v18-missing-browser-01' });
  await plantResume(page, record);
  await page.goto(`${ORIGINS.editor}/editor`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForSelector('[data-pc="members-button"]', { visible: true, timeout: 90_000 });
  await page.waitForFunction(() => !!window.__pcStore && window.__pcStore.getState().project.media.length === 3, { timeout: 60_000, polling: 300 });
  out.entered = await page.evaluate(() => ({ origin: location.origin, media: window.__pcStore.getState().project.media.map((m) => [m.name, m.missingMaterial?.reason ?? null]) }));
  check(out.entered.origin === ORIGINS.editor, '在线页面进了项目（在线构建，隔离代理的编辑器源）', out.entered);

  const stageFrames = () => page.frames().filter((f) => !f.detached);
  const placeholders = async () => { const found = []; for (const f of stageFrames()) { try { found.push(...await f.evaluate(() => [...document.querySelectorAll('[data-pc-confirmed-missing]')].map((el) => ({ text: el.textContent, origin: location.origin, visible: el.getBoundingClientRect().width > 0 })))); } catch { /* 已卸载的帧 */ } } return found; };
  const seek = (t) => page.evaluate((x) => { window.__pcStore.actions.pause(); window.__pcStore.actions.seek(x); }, t);
  const waitPlaceholder = async (text) => { let p = []; for (let i = 0; i < 60; i++) { p = await placeholders(); if (p.some((x) => x.text === text && x.visible)) break; await sleep(250); } return p; };

  await seek(1);
  let p = await waitPlaceholder(`找不到素材${VIDEO}`);
  out.previewVideo = p;
  check(p.some((x) => x.text === `找不到素材${VIDEO}` && x.visible), '在线预览：缺失的视频显示「找不到素材」加文件名', p);
  check(p.every((x) => ORIGINS.stages.includes(x.origin) || x.origin === ORIGINS.editor), '占位画在舞台里', p.map((x) => x.origin));
  await sleep(600); await page.screenshot({ path: path.join(SHOTS, '14-online-preview-missing-video.png') });
  await seek(3);
  p = await waitPlaceholder(`找不到素材${IMAGE}`);
  check(p.some((x) => x.text === `找不到素材${IMAGE}` && x.visible), '在线预览：缺失的图片显示「找不到素材」加文件名', p);
  await sleep(600); await page.screenshot({ path: path.join(SHOTS, '15-online-preview-missing-image.png') });

  // 人声：从 2.4 s 播，缺失的旁白（2.5～4.5 s）那一段的 <audio> 用的是在线构建里带的那段人声，并且在走
  await page.evaluate(() => { window.__pcStore.actions.seek(2.4); window.__pcStore.actions.play(); });
  const samples = [];
  for (let i = 0; i < 16; i++) { await sleep(150); samples.push(await page.evaluate(() => [...document.querySelectorAll('audio[data-pc-audio-clip]')].map((a) => ({ clip: a.getAttribute('data-pc-audio-clip'), src: a.currentSrc || a.src, paused: a.paused, t: +a.currentTime.toFixed(2), ready: a.readyState, err: a.error?.code ?? null, volume: a.volume, muted: a.muted })))); }
  await page.evaluate(() => window.__pcStore.actions.pause());
  const voice = samples.flat().filter((a) => /missing-material.*\.wav/.test(a.src));
  out.previewAudio = voice.slice(0, 8);
  check(voice.some((a) => a.clip === 'c-a' && !a.paused && a.t > 0.2 && a.err === null && !a.muted && a.volume > 0), '在线预览：缺失的声音放的是随软件分发的人声，播放头在走、没有静音', voice.slice(0, 6));
  const wavUrl = voice[0]?.src;
  check(!!wavUrl && new URL(wavUrl).origin === ORIGINS.editor && /\/editor\/assets\/missing-material.*\.wav$/.test(new URL(wavUrl).pathname), '人声来自在线构建自己的静态资源，不是项目素材', wavUrl);
  if (wavUrl) {
    const got = await page.evaluate(async (u) => { const r = await fetch(u); const b = new Uint8Array(await r.arrayBuffer()); const d = await crypto.subtle.digest('SHA-256', b); return { status: r.status, type: r.headers.get('content-type'), hash: [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('') }; }, wavUrl);
    check(got.status === 200 && got.hash === wavHash, '在线页面取到的就是那一份文件（哈希一致）', got);
  }
  // 在浏览器里真的解码并送到输出：用页面自己的 AudioContext 解一遍，峰值不是零（文件不是空的、浏览器解得开）
  const decoded = wavUrl ? await page.evaluate(async (u) => { const ac = new AudioContext(); const buf = await ac.decodeAudioData(await (await fetch(u)).arrayBuffer()); const ch = buf.getChannelData(0); let peak = 0; for (const v of ch) peak = Math.max(peak, Math.abs(v)); await ac.close(); return { seconds: +buf.duration.toFixed(2), rate: buf.sampleRate, peak: +peak.toFixed(3) }; }, wavUrl) : null;
  out.decoded = decoded;
  check(decoded && Math.abs(decoded.seconds - 1.37) < 0.05 && decoded.peak > 0.3, '在线页面解得开这段人声（1.37 秒，有内容）', decoded);

  // 在线导出（浏览器里逐帧导出）：占位进成片，人声进音轨
  log('在线导出');
  const exp = await page.evaluate(async () => { const r = await window.__pcIo.exportVideoBrowser({ maxFrames: 180 }); return { error: r.error ?? null, waits: r.waits, base64: r.base64, stats: r.result ? { frames: r.result.frames ?? null } : null }; });
  out.export = { error: exp.error, waits: exp.waits, bytes: exp.base64.length };
  if (check(!exp.error && exp.base64.length > 1000, '在线导出：完成（没有被「等待上传方」拦下）', out.export)) {
    const mp4 = path.join(OUT, `online-export-${RUN}.mp4`);
    fs.writeFileSync(mp4, Buffer.from(exp.base64, 'base64'));
    run(ffmpeg, ['-y', '-v', 'error', '-ss', '1', '-i', mp4, '-frames:v', '1', path.join(SHOTS, '16-online-export-frame-missing-video.png')]);
    const fVideo = frameStats(mp4, 1), fImage = frameStats(mp4, 3), fEmpty = frameStats(mp4, 5);
    const aVoice = audioRms(mp4, 2.55, 1.2), aAfter = audioRms(mp4, 4.0, 0.4), aMutedVideo = audioRms(mp4, 0.1, 1.5);
    out.export = { ...out.export, file: mp4, frames: { video: fVideo, image: fImage, empty: fEmpty }, audio: { voice: aVoice, after: aAfter, mutedVideoClip: aMutedVideo } };
    check(fVideo.std > 3 && fVideo.mean > 25 && fVideo.mean < 80, '在线导出：1 s 处是占位（深色底加白字）', fVideo);
    check(fImage.std > 3 && fImage.mean > 25 && fImage.mean < 80, '在线导出：3 s 处（缺失的图片）也是占位', fImage);
    check(aVoice.rmsDb > -40, '在线导出：缺失的旁白那一段有人声', aVoice);
    check(aAfter.rmsDb < -50, '在线导出：人声只放一次', aAfter);
    check(aMutedVideo.rmsDb < -50, '在线导出：片段静音的缺失视频不出人声（保留原来的静音设置）', aMutedVideo);
  }
  check(refused.length === 0, '没有被内容安全策略拦下的请求', refused);
  check(errors.length === 0, '页面没有报错', errors);
  out.dialogs = await page.evaluate(() => ({ missing: !!document.querySelector('[data-pc="missing-materials-dialog"]'), gone: !!document.querySelector('[data-pc="cloud-gone-dialog"]') }));
  check(!out.dialogs.missing && !out.dialogs.gone, '在线页面（云端项目）不认定缺失、不弹窗', out.dialogs);
} catch (e) {
  fails.push('探针异常:' + (e?.stack || e));
} finally {
  for (const c of cleanups.reverse()) { try { await c(); } catch { /* 收尾不挡结果 */ } }
}
out.fails = fails; out.ok = fails.length === 0;
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
