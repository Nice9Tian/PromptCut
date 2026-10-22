/**
 * 片段速度的界面探针(手机版「速度」入口、桌面编辑分区的「速度」一栏、预览里变速段不出原声、舞台视频按倍率放)。
 * 环境同 `mobile-entries-probe.mjs`:本机托管组合 + 仿 nginx 代理 + 在线构建,不连任何远端。
 *
 *   npx vite build --mode online
 *   node scripts/probes/clip-speed-ui-probe.mjs [--dist dist-online] [--out out/clip-speed-ui] [--base-port 5930] [--doc-port 5936] [--asset-port 5937]
 *
 * 断言:
 *  P1 手机版:时间轴分页选中视频段,子导航栏有「速度」(在「静音」之后、「调整」之前,同演示稿);
 *  P2 点「速度」打开速度面板,写明「变速后这一段不出原声」;点 2× → 片段 speed = 2、起点与素材起点不动、时长减半;
 *  P3 完整时间轴上这一段标出「2× 无原声」;
 *  P4 预览的声音层:变速前主文档里有这一段的 <audio>,变速后没有(变速段原声不出);
 *  P5 播放中舞台里放这一段的 <video> 的 playbackRate ≈ 2(纠偏 ±10% 以内);
 *  P6 撤销一步回到 1×,speed 字段删掉(不是 speed: 1);
 *  D1 桌面版(在线页面的桌面布局):选中视频段,编辑分区有「速度」一栏和同一句说明;选 0.5× → speed = 0.5;
 *  D2 时间轴片段名后带「· 0.5×」,静音标记的说明写明「变速段不出原声」。
 * 最后一行是一行 JSON。
 */
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { startMobileEnv, emptyProject } from './lib/mobile-env.mjs';

setTimeout(() => { console.error('SCRIPT_TIMEOUT'); process.exit(124); }, 15 * 60_000).unref();
const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.resolve(arg('--dist', path.join(ROOT, 'dist-online')));
const OUT = path.resolve(arg('--out', path.join(ROOT, 'out', 'clip-speed-ui')));
fs.mkdirSync(OUT, { recursive: true });

const fails = [];
const out = { ok: false, out: OUT, steps: {} };
const step = (k, v) => { out.steps[k] = v; };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 400))); return !!cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 30_000, every = 250) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) { fails.push(`等不到:${what}`); return null; }
    await sleep(every);
  }
}
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`) }).catch(() => {});
const rect = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; e.scrollIntoView({ block: 'nearest', inline: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }, sel);
const tap = async (page, sel) => { const r = await rect(page, sel); if (!r) throw new Error(`点不到 ${sel}`); await page.touchscreen.tap(r.x + r.w / 2, r.y + r.h / 2); await sleep(400); };
const store = (page, src, ...a) => page.evaluate((s, a2) => new Function('S', 'args', s)(window.__pcStore, a2), src, a);
const clipOf = (page, id) => store(page, 'return S.getState().project.tracks.flatMap((t) => t.clips).find((x) => x.id === args[0]) ?? null;', id);
const closeSheet = async (page) => {
  const r = await page.evaluate(() => { const bs = [...document.querySelectorAll('.sheet-head button[aria-label="关闭"]')]; const b = bs[bs.length - 1]; if (!b) return null; const q = b.getBoundingClientRect(); return { x: q.x + q.width / 2, y: q.y + q.height / 2 }; });
  if (r) { await page.touchscreen.tap(r.x, r.y); await sleep(450); }
};

const NAME = `cs-${Date.now().toString(36)}`;
const env = await startMobileEnv({
  dist: DIST, basePort: Number(arg('--base-port', 5930)), base2Port: 0,
  docPort: Number(arg('--doc-port', 5936)), assetPort: Number(arg('--asset-port', 5937)), name: NAME,
});
await env.seed({ ...emptyProject(NAME), name: NAME });
const browser = await puppeteer.launch({ headless: true, protocolTimeout: 600_000, args: [...PROBE_CHROME_ARGS, '--no-first-run', '--autoplay-policy=no-user-gesture-required'] });
let A, B;
try {
  A = await env.newPage(browser, 'phone');
  await env.enter(A, { username: 'yi' });
  await A.waitForSelector('[data-pcm="editor"]', { visible: true });

  /* ---------- 素材:6 秒带声音的视频 ---------- */
  const mp4 = path.join(OUT, 'tone.mp4');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=6', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', mp4], { windowsHide: true });
  await tap(A, '[data-pcm="sub-video"]');
  await A.waitForSelector('[data-pcm="sheet-assets"]', { visible: true });
  await (await A.waitForSelector('[data-pcm="import-input"]')).uploadFile(mp4);
  const vid = await until('视频进素材库且有时长', () => store(A, 'const m = S.getState().project.media.find((x) => x.kind === "video"); return m && m.duration ? { id: m.id, duration: m.duration } : null;'), 120_000);
  await tap(A, `[data-pcm="asset"][data-media="${vid.id}"]`);
  if (await A.$('[data-pcm="sheet-assets"]')) await closeSheet(A);
  const placed = await until('视频段放上时间轴', () => store(A, 'return S.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.mediaId === args[0]) ?? null;', vid.id));
  step('placed', placed && { id: placed.id, start: placed.start, end: placed.end, mediaOffset: placed.mediaOffset ?? 0 });

  /* ---------- P4 前半:变速前主文档里有这一段的声音层 ---------- */
  await store(A, 'S.actions.seek(args[0]); return true;', placed.start + 1);
  const audioBefore = await until('变速前声音层在', async () => (await A.$(`audio[data-pc-audio-clip="${placed.id}"]`)) ? true : null, 20_000);
  step('P4-before', { audioLayer: !!audioBefore });

  /* ---------- P1 时间轴分页选中 → 子导航栏有「速度」 ---------- */
  await tap(A, '[data-pcm="pg-timeline"]');
  await A.waitForSelector(`[data-pcm="clip"][data-id="${placed.id}"]`, { visible: true, timeout: 20_000 });
  await tap(A, `[data-pcm="clip"][data-id="${placed.id}"]`);
  await until('子导航栏出现片段工具', async () => (await A.$('[data-pcm="sub-speed"]')) ? true : null, 10_000);
  const tools = await A.$$eval('.subnav [data-pcm]', (bs) => bs.map((b) => b.dataset.pcm));
  await shot(A, 'P1-subnav');
  step('P1', { tools });
  check(tools.includes('sub-speed'), 'P1 选中视频段后子导航栏有「速度」', tools);
  check(tools.indexOf('sub-mute') < tools.indexOf('sub-speed') && tools.indexOf('sub-speed') < tools.indexOf('sub-adjust'), 'P1 顺序同演示稿:静音、速度、调整', tools);

  /* ---------- P2 速度面板 ---------- */
  await tap(A, '[data-pcm="sub-speed"]');
  await A.waitForSelector('[data-pcm="speed-presets"]', { visible: true, timeout: 10_000 });
  const note = await A.$eval('[data-pcm="speed-note"]', (e) => e.textContent);
  const presets = await A.$$eval('[data-pcm="speed-preset"]', (bs) => bs.map((b) => [b.dataset.speed, b.getAttribute('aria-pressed')]));
  await shot(A, 'P2-sheet-before');
  check(/变速后这一段不出原声/.test(note ?? ''), 'P2 面板写明变速段不出原声', note);
  check(presets.some(([v, on]) => v === '1' && on === 'true'), 'P2 当前 1× 高亮', presets);
  await tap(A, '[data-pcm="speed-preset"][data-speed="2"]');
  const fast = await until('片段变成 2×', async () => { const c = await clipOf(A, placed.id); return c?.speed === 2 ? c : null; });
  await shot(A, 'P2-sheet-after');
  step('P2', { note, presets, after: fast && { start: fast.start, end: fast.end, mediaOffset: fast.mediaOffset ?? 0, speed: fast.speed } });
  check(!!fast && fast.start === placed.start && (fast.mediaOffset ?? 0) === (placed.mediaOffset ?? 0), 'P2 起点与素材起点不动', fast);
  check(!!fast && Math.abs((fast.end - fast.start) - (placed.end - placed.start) / 2) < 1e-6, 'P2 时长减半', fast && [fast.start, fast.end]);
  await closeSheet(A);

  /* ---------- P3 完整时间轴的标记 ---------- */
  const badge = await A.$eval(`[data-pcm="clip"][data-id="${placed.id}"] [data-pcm="clip-speed"]`, (e) => e.textContent).catch(() => null);
  await shot(A, 'P3-timeline-badge');
  step('P3', { badge });
  check(/2×\s*无原声/.test(badge ?? ''), 'P3 完整时间轴上标出「2× 无原声」', badge);

  /* ---------- P4 后半:变速后没有声音层 ---------- */
  await store(A, 'S.actions.seek(args[0]); return true;', placed.start + 0.8);
  await sleep(1500);
  const audioAfter = await A.$(`audio[data-pc-audio-clip="${placed.id}"]`);
  step('P4-after', { audioLayer: !!audioAfter });
  check(!!audioBefore && !audioAfter, 'P4 变速后预览不出原声(声音层没了)', { before: !!audioBefore, after: !!audioAfter });

  /* ---------- P5 播放中舞台视频按 2 倍放 ---------- */
  await store(A, 'S.actions.seek(args[0]); S.actions.play(); return true;', placed.start + 0.1);
  await sleep(1800);
  const rates = [];
  for (const f of A.frames()) {
    const r = await f.evaluate(() => [...document.querySelectorAll('video')].filter((v) => !v.paused).map((v) => ({ rate: v.playbackRate, t: +v.currentTime.toFixed(2) }))).catch(() => []);
    if (r.length) rates.push({ url: f.url().slice(0, 60), r });
  }
  await store(A, 'S.actions.pause(); return true;');
  step('P5', { rates });
  const playing = rates.flatMap((x) => x.r);
  check(playing.length > 0 && playing.every((v) => v.rate >= 1.8 && v.rate <= 2.2), 'P5 舞台里放变速段的视频按 2 倍(±10%)', rates);

  /* ---------- P6 撤销 ---------- */
  await store(A, 'S.actions.undo(); return true;');
  const undone = await clipOf(A, placed.id);
  step('P6', { speedField: undone && 'speed' in undone, end: undone?.end });
  check(!!undone && !('speed' in undone) && undone.end === placed.end, 'P6 撤销一步回到 1×、不留 speed 字段', undone);

  /* ---------- D1 / D2 桌面布局 ---------- */
  B = await env.newPage(browser, 'desktop');
  await env.enter(B, { username: 'er' });
  await until('桌面页同步到视频段', () => clipOf(B, placed.id), 60_000);
  await store(B, 'S.actions.select([args[0]]); return true;', placed.id);
  const form = await until('编辑分区出现速度一栏', async () => (await B.$('[data-pc="clip-speed"]')) ? true : null, 20_000);
  if (form) {
    const dnote = await B.$eval('[data-pc="clip-speed-note"]', (e) => e.textContent);
    await B.select('[data-pc="clip-speed-select"]', '0.5');
    const slow = await until('桌面改成 0.5×', async () => { const c = await clipOf(B, placed.id); return c?.speed === 0.5 ? c : null; });
    await sleep(800);
    await shot(B, 'D1-inspector');
    const label = await B.$eval(`[data-pc-clip-speed]`, (e) => e.textContent).catch(() => null);
    const badgeTitle = await B.$eval('[data-pc="clip-muted"]', (e) => e.getAttribute('title')).catch(() => null);
    await shot(B, 'D2-timeline');
    step('D1', { note: dnote, after: slow && { start: slow.start, end: slow.end, speed: slow.speed } });
    step('D2', { label, badgeTitle });
    check(/变速后这一段不出原声/.test(dnote ?? ''), 'D1 桌面编辑分区写明变速段不出原声', dnote);
    check(!!slow && Math.abs((slow.end - slow.start) - (placed.end - placed.start) * 2) < 1e-6, 'D1 0.5× 时长翻倍', slow && [slow.start, slow.end]);
    check(/0\.5×/.test(label ?? ''), 'D2 时间轴片段名带「0.5×」', label);
    check(/变速段不出原声/.test(badgeTitle ?? ''), 'D2 静音标记写明原因', badgeTitle);
    // 手机页同步到同一个速度
    const synced = await until('手机页同步到 0.5×', async () => { const c = await clipOf(A, placed.id); return c?.speed === 0.5 ? true : null; }, 30_000);
    step('D-sync', { phoneSeesHalf: !!synced });
  }
  step('errors', { phone: A.errors.slice(0, 5), desktop: B.errors.slice(0, 5) });
  check(!A.errors.length && !B.errors.length, '页面没有未捕获的异常', { A: A.errors.slice(0, 3), B: B.errors.slice(0, 3) });
} catch (error) {
  fails.push(String(error?.stack || error));
  if (A) await shot(A, 'ERR-phone');
  if (B) await shot(B, 'ERR-desktop');
} finally {
  await browser.close().catch(() => {});
  await env.close().catch(() => {});
}
out.fails = fails;
out.ok = fails.length === 0;
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
