/**
 * 声音样本导出(任务书「第一段」第 8 条):提示音、键盘声、有声动效卡各出一段 MP4。
 *
 *   node scripts/probes/sound-samples-probe.mjs [--out <样本目录>] [--base-port 5710] [--keep-temp]
 *
 * 画面是真实编辑器渲染的:本机编辑器 dev server(本脚本所在代码树、临时数据目录)里,用真实按钮生成声音
 * (「添加提示音」「生成键盘声」「生成声音」),再走真实的 `POST /api/export`(与界面「导出视频」同一条后端),
 * 出成片 preview.mp4。成片拷到 --out(缺省 work/four-stage/sound/samples/)。
 *
 * 验收标准(退出码 0 当且仅当全部成立;「音色」不在验收内,只验有声、位置对、画面不是纯色):
 *   S1 ffprobe:成片有视频流和音频流,时长与项目时长相差不超过 0.15 s;
 *   S2 解码音轨,每个事件窗口([事件时刻, +0.05 s])里有能量(RMS ≥ 5e-5),且声音起点落在事件时刻前 12 ms 到后 1 帧(33 ms)内
 *      (起点 = 窗口 [事件-0.05, 事件+0.1] 内第一个 |x| ≥ 0.002 的采样);
 *   S3 第一个事件之前(事件-0.2 到事件-0.05)没有声音(没有提前出声);
 *   S4 抽三帧(事件时刻、中间、结尾)存成 PNG,三帧的亮度标准差都 > 2(不是纯色),且事件时刻的帧与最后一帧不相同(画面在动)。
 * 不向扬声器出声:无头 Chrome 带 --mute-audio;ffmpeg 只解码到文件。
 */
import './../lib/no-user-dirs.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDevServer } from '../lib/dev-server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const BASE = Number(arg('base-port', 5710));
const OUT = path.resolve(arg('out', path.join(ROOT, '..', '..', 'work', 'four-stage', 'sound', 'samples')));
const KEEP = argv.includes('--keep-temp');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-sound-samples-'));
fs.mkdirSync(OUT, { recursive: true });
const SR = 48000;

const results = [], fails = [];
const check = (ok, name, evidence = {}) => { results.push({ ok: !!ok, name, evidence }); if (!ok) fails.push(name); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(evidence).slice(0, 600)}`); return !!ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 60_000, every = 250) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) { fails.push(`等不到:${what}`); console.log(`FAIL 等不到:${what}`); return null; }
    await sleep(every);
  }
}
const P = (page, fn, ...a) => page.evaluate(fn, ...a);
const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
const openEdit = (page) => P(page, () => { const b = document.querySelector('[data-pc-rail="edit"]'); if (b && b.getAttribute('aria-pressed') !== 'true') b.click(); });

let dev = null, browser = null;
const dir = path.join(TMP, 'desktop');
async function main() {
  for (const d of ['data', 'card-overrides', 'projects', 'work', 'tmp']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  dev = await startDevServer({ env: { PROMPTCUT_NO_PORT_FILE: '1', PROMPTCUT_EXPORT_DIR: dir, PROMPTCUT_DATA_DIR: path.join(dir, 'data'), PROMPTCUT_CARD_OVERRIDES: path.join(dir, 'card-overrides'),
    PROMPTCUT_PROJECTS_DIR: path.join(dir, 'projects'), PROMPTCUT_WORK_DIR: path.join(dir, 'work'), PROMPTCUT_STREAMS: '0', TEMP: path.join(dir, 'tmp'), TMP: path.join(dir, 'tmp'), TMPDIR: path.join(dir, 'tmp') },
    logFile: path.join(dir, 'vite.log'), port: BASE, log: (m) => console.log(`[dev] ${m}`) });
  const { default: puppeteer } = await import('puppeteer');
  const { PROBE_CHROME_ARGS } = await import('./probe-chrome.mjs');
  browser = await puppeteer.launch({ headless: true, protocolTimeout: 600_000, defaultViewport: { width: 1600, height: 900 }, args: [...PROBE_CHROME_ARGS, '--no-first-run', '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
  const page = await browser.newPage();
  page.on('dialog', (d) => void d.accept());
  await page.goto(`${dev.origin}/?editor&nosetup=1`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await until('编辑器就绪', () => P(page, () => !!window.__pcStore && !!document.querySelector('[data-pc="ruler"]')), 120_000, 300);

  const load = (name, duration) => P(page, async (n, d) => {
    const { createEmptyProject } = await import('/src/kernel/project.ts');
    window.__pcStore.actions.loadProject({ ...createEmptyProject(n), width: 1280, height: 720, fps: 30, duration: d, media: [], tracks: [{ id: 't-vis', name: '画面', clips: [] }] });
  }, name, duration);
  const clickBtn = async (sel) => { const el = await page.waitForSelector(sel, { visible: true, timeout: 20_000 }); await el.click(); };
  const mediaCount = () => P(page, () => window.__pcStore.getState().project.media.length);
  const clickText = (scope, text) => P(page, (sc, t) => { for (const b of document.querySelectorAll(`${sc} button`)) if (b.textContent.trim() === t) b.click(); }, scope, text);
  const events = () => P(page, () => {
    const p = window.__pcStore.getState().project;
    const out = [];
    for (const c of p.tracks.flatMap((t) => t.clips)) {
      const m = c.mediaId ? p.media.find((x) => x.id === c.mediaId) : null;
      if (m?.soundEffect?.recipe) for (const e of m.soundEffect.recipe.events) out.push(c.start - (c.mediaOffset ?? 0) + e.frame / 48000);
    }
    return out.sort((a, b) => a - b);
  });

  const samples = [];
  /* ---- 样本 1:提示音 ---- */
  await load('提示音样本', 3);
  await P(page, () => { const S = window.__pcStore; S.actions.addCardClip('punch-pill', 0, { trackId: 't-vis', duration: 3 }); S.actions.seek(1.0); });
  await openEdit(page);
  await clickBtn('[data-pc="sound-notification"]');
  await until('提示音入库', async () => (await mediaCount()) >= 1);
  samples.push({ name: 'notification', file: 'sample-notification.mp4', duration: 3, events: await events(), project: await P(page, () => window.__pcStore.getState().project) });
  /* ---- 样本 2:键盘声 ---- */
  await load('键盘声样本', 3);
  const typingId = await P(page, () => { const S = window.__pcStore; const c = S.actions.addCardClip('mu-typing', 0, { trackId: 't-vis', duration: 3, params: { text: 'Hello, PromptCut! 你好', duration: 110 } }); S.actions.select([c.id]); return c.id; });
  await openEdit(page);
  await clickBtn('[data-pc="sound-keyboard"]');
  await until('键盘声入库', async () => (await mediaCount()) >= 1);
  samples.push({ name: 'keyboard', file: 'sample-keyboard.mp4', duration: 3, events: await events(), project: await P(page, () => window.__pcStore.getState().project) });
  /* ---- 样本 3:有声动效卡(三个声画卡片段) ---- */
  await load('有声动效卡样本', 3.4);
  for (const at of [0.4, 1.4, 2.4]) {
    await P(page, (t) => { const S = window.__pcStore; const c = S.actions.addCardClip('av-pulse', t, { trackId: 't-vis', duration: 0.9 }); S.actions.select([c.id]); }, at);
    await openEdit(page);
    await page.waitForSelector('[data-pc="card-audio-controls"]', { visible: true, timeout: 20_000 });
    await clickText('[data-pc="card-audio-controls"]', '生成声音');
    await until(`声画卡 ${at} 声音入库`, () => P(page, (t) => window.__pcStore.getState().project.tracks.flatMap((x) => x.clips).some((c) => Math.abs(c.start - t) < 1e-6 && c.cardAudio), at), 60_000);
  }
  samples.push({ name: 'av-card', file: 'sample-av-card.mp4', duration: 3.4, events: [0.4, 1.4, 2.4], project: await P(page, () => window.__pcStore.getState().project), card: true });
  await page.close();

  /* ---- 导出与核对 ---- */
  for (const s of samples) {
    const post = await fetch(`${dev.origin}/api/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: s.project }) });
    const started = post.ok ? await post.json() : { error: await post.text() };
    if (!check(!!started.id, `${s.name}:启动导出`, { status: post.status, id: started.id, error: started.error?.slice?.(0, 200) })) continue;
    const job = await until(`${s.name} 导出完成`, async () => { const j = await fetch(`${dev.origin}/api/export/${started.id}`).then((r) => r.json()); if (j.status === 'error') throw new Error(j.message); return j.status === 'done' ? j : null; }, 600_000, 1000);
    const mp4 = path.join(dir, `export-${started.id}`, 'preview.mp4');
    if (!job || !fs.existsSync(mp4)) { check(false, `${s.name}:成片存在`, { job }); continue; }
    const dest = path.join(OUT, s.file);
    fs.copyFileSync(mp4, dest);
    const probe = JSON.parse(run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', dest]).stdout);
    const v = probe.streams.find((x) => x.codec_type === 'video'), a = probe.streams.find((x) => x.codec_type === 'audio');
    const dur = Number(probe.format.duration);
    check(!!v && !!a && Math.abs(dur - s.duration) <= 0.15, `${s.name} S1:有视频流与音频流,时长对`, { video: v && `${v.codec_name} ${v.width}x${v.height}`, audio: a && `${a.codec_name} ${a.sample_rate}Hz ${a.channels}ch`, duration: dur, expected: s.duration, bytes: fs.statSync(dest).size });
    const raw = path.join(dir, `${s.name}.f32`);
    run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', dest, '-vn', '-ar', String(SR), '-ac', '2', '-f', 'f32le', raw]);
    const buf = fs.readFileSync(raw);
    const pcm = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const rows = s.events.map((at) => {
      const from = Math.max(0, Math.round(at * SR)), until2 = Math.min(pcm.length / 2, from + Math.round(0.05 * SR));
      let e = 0; for (let i = from; i < until2; i++) e += pcm[i * 2] ** 2;
      const rms = Math.sqrt(e / Math.max(1, until2 - from));
      let onset = null;
      for (let i = Math.max(0, Math.round((at - 0.05) * SR)); i < Math.min(pcm.length / 2, Math.round((at + 0.1) * SR)); i++) if (Math.abs(pcm[i * 2]) >= 0.002) { onset = i / SR; break; }
      return { at: +at.toFixed(3), rms: +rms.toFixed(5), onsetErrMs: onset === null ? null : +((onset - at) * 1000).toFixed(1) };
    });
    check(rows.length > 0 && rows.every((r) => r.rms >= 5e-5 && r.onsetErrMs !== null && r.onsetErrMs >= -12 && r.onsetErrMs <= 33.4), `${s.name} S2:每个事件窗口有能量、起点对位(${rows.length} 个事件)`, { worst: rows.reduce((w, r) => (Math.abs(r.onsetErrMs ?? 999) > Math.abs(w.onsetErrMs ?? 0) ? r : w), rows[0]), minRms: Math.min(...rows.map((r) => r.rms)) });
    const first = s.events[0];
    let lead = 0, n = 0;
    for (let i = Math.max(0, Math.round((first - 0.2) * SR)); i < Math.round((first - 0.05) * SR); i++) { lead += pcm[i * 2] ** 2; n++; }
    check(n === 0 || Math.sqrt(lead / n) < 5e-4, `${s.name} S3:第一个事件之前没有提前出声`, { leadRms: n ? +Math.sqrt(lead / n).toFixed(6) : null });
    const stats = [];
    for (const [label, t] of [['event', first + 0.03], ['mid', s.duration / 2], ['end', s.duration - 0.1]]) {
      const png = path.join(OUT, `${s.file.replace('.mp4', '')}-${label}.png`);
      run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(t), '-i', dest, '-frames:v', '1', png]);
      const raw8 = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', png, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 64 * 1024 * 1024, windowsHide: true }).stdout;
      let sum = 0, sq = 0; for (const b of raw8) { sum += b; sq += b * b; }
      const mean = sum / raw8.length, std = Math.sqrt(sq / raw8.length - mean * mean);
      stats.push({ label, t: +t.toFixed(2), std: +std.toFixed(2), png, sum });
    }
    check(stats.every((x) => x.std > 2) && stats[0].sum !== stats[2].sum, `${s.name} S4:画面不是纯色、事件时刻与结尾的画面不同`, { std: stats.map((x) => `${x.label}=${x.std}`), frames: stats.map((x) => x.png) });
    s.result = { file: dest, duration: dur, events: rows.length };
  }
}
try { await main(); } catch (e) { fails.push(`中断:${String(e?.message ?? e).slice(0, 300)}`); console.error(e); }
finally {
  try { await browser?.close(); } catch { /* 已关 */ }
  try { dev?.stop(); } catch { /* 已关 */ }
  if (!KEEP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 留着 */ } }
}
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ ok: fails.length === 0, fails, results }, null, 2));
console.log(JSON.stringify({ ok: fails.length === 0, checks: results.length, fails }));
process.exit(fails.length === 0 ? 0 : 1);
