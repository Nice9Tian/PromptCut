/**
 * 声音改动 A、B 的真实浏览器探针(任务书 `docs/plan/sound-online-render-task.md` 第一段验收第 4、5 条)。
 * 全程在本机:桌面一侧是本探针自己起的 dev server,在线一侧是在线构建 + 本机托管组合(`server/hosted/combo.mjs`)+ 仿 nginx 的代理,
 * 绝不连真正的托管端。
 *
 *   npx vite build --mode online --outDir <在线构建目录>
 *   node scripts/probes/sound-ab-probe.mjs --dist <在线构建目录> [--out <目录>] [--phases desktop,online,lowmem]
 *        [--desktop-port 5700] [--site-port 5705] [--doc-port 8790] [--asset-port 8791]
 *
 * 端口:桌面 dev server 占 --desktop-port 起连号三个;在线站点占 --site-port 起连号三个(编辑器页 + 两个舞台的源);
 * 文档服务、素材服务各一个。数据目录都在 --out 下的临时目录里。某个端口被别的进程占着时(启动报 EADDRINUSE)用上面的参数换一段。
 *
 * **不向扬声器出声**:Chrome 无头、带 `--mute-audio`(整个浏览器的输出在设备前静音);探针量声音用的分析节点不接输出。
 * 「听到」一律按数字判,不靠人听:
 *   - 预览:这段声音的 `<audio>` 在播(没暂停、时间在走、音量 > 0),它的声音源解码出来在片段的窗口里有能量,
 *     并且从元素上采到的实时信号(`captureStream` → 分析节点)有能量;
 *   - 成片:ffmpeg 解码 MP4 的音轨,每段声音在它的时间窗里有能量、起音离片段起点不超过一帧多一点,频率是这一段该有的那个。
 *
 * 验收标准(每项一行 `{ check, ok }`,最后一行 `{ summary }`,有失败退出码 1):
 *
 * 桌面(第 4 条,`desktop`):
 *   D1 预览里未生成的声音仍然提示(不自动生成):有声卡的声音层是 error、没有声音源,预览左下角有提示文字;
 *   D2 导出前的清单认出未生成、过期、缺失各一段;
 *   D3 直接导出成功:进度里先出现 sound 阶段(共 3 段,走到 3/3),之后才是 render;成片三段声音都在、位置对齐、
 *      过期那一段是按当前参数重新生成的;导出后项目里三段声音都是有效产物;
 *   D4 生成中取消:导出被取消、导出任务没开出来、生成停了;做完的几段是完整产物(解析得到、字节在素材服务里),
 *      没做完的没有任何记录;素材条数 = 有产物的片段数;之后项目不再变;
 *   D5 故意让一段生成失败(参数越界):导出失败,错误信息里有那个片段的名字与 id,导出任务没开出来。
 *
 * 在线普通档(第 5 条与第 4 条的在线一半,`online`):
 *   O1 测量不出声:判定一段还没测过的声音时,测量确实做了(记录 16 块),期间没有新建音频上下文、没有元素开始播放、
 *      没有新建可播放地址、没有声源启动,页面上没有在播的媒体元素;
 *   O2 没有任何现成声音产物时听得到:内置有声卡(未生成)、提示音与键盘声(素材服务里没有它们的文件)在预览里播放,
 *      声音源是浏览器合成的(blob 地址),有能量;
 *   O3 再问同一段声音复用记录、不重测;
 *   O4 判重、没有产物:不在浏览器里合成(没有新建可播放地址),预览提示原因;导出失败并指出片段;
 *   O5 判重、有产物:另一位成员生成后同步过来,这台设备播的是产物(素材服务的地址,不是 blob),有能量;
 *   O6 在线直接导出:进度里先出现 sound 阶段;成片有声且位置对齐;导出后声音成了同步的产物;
 *   O7 在线生成中取消:导出取消,没做完的没有记录;
 *   O8 在线故意让一段生成失败:导出失败并指出片段。
 *
 * 在线低内存档(`lowmem`,手机仿真):
 *   L1 不测、不合成:未生成的有声卡预览不出声、提示里写明低内存档;
 *   L2 已同步的产物照常播;
 *   L3 导出开始时缺声音:失败并指出片段;声音齐全时导出成功且有声。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { startDevServer } from '../lib/dev-server.mjs';
import { findFfmpeg } from '../../server/bakery/ffmpeg.mjs';
import { startHostedCombo } from '../../server/hosted/combo.mjs';
import { createSharedProject, buildAuthProtocols } from '../../server/auth/client.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUN = Date.now().toString(36) + randomBytes(2).toString('hex');
const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), `pc-sound-ab-${RUN}`)));
const DIST = path.resolve(arg('--dist', path.join(ROOT, 'dist-online')));
const PHASES = new Set(arg('--phases', 'desktop,online,lowmem').split(','));
const DESKTOP_PORT = Number(arg('--desktop-port', 5700));
const SITE_PORT = Number(arg('--site-port', 5705));
const PORTS = { editor: SITE_PORT, stageA: SITE_PORT + 1, stageB: SITE_PORT + 2, doc: Number(arg('--doc-port', 8790)), asset: Number(arg('--asset-port', 8791)) };
fs.mkdirSync(OUT, { recursive: true });

const SR = 48000, FPS = 30;
const results = [];
const check = (name, ok, detail = {}) => { results.push({ check: name, ok: !!ok }); console.log(JSON.stringify({ check: name, ok: !!ok, detail }).slice(0, 1800)); return !!ok; };
const log = (...a) => console.error('[sound-ab]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 30_000, every = 200) {
  const t0 = Date.now();
  let last = null;
  for (;;) {
    let v = null;
    try { v = await fn(); } catch (e) { last = String(e?.message ?? e); }
    if (v) return v;
    if (Date.now() - t0 > ms) { check(`等到:${what}`, false, { last }); return null; }
    await sleep(every);
  }
}

/* ------------------------------------------------------------------ 成片的音轨:解码与度量 */
const ffmpeg = await findFfmpeg();
function decodeMono(file) {
  const r = spawnSync(ffmpeg, ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { encoding: 'buffer', windowsHide: true, maxBuffer: 512 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`ffmpeg 解码失败:${String(r.stderr).slice(-300)}`);
  return new Float32Array(r.stdout.buffer, r.stdout.byteOffset, Math.floor(r.stdout.length / 4));
}
function hasAudioTrack(file) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8', windowsHide: true });
  return /Stream #\d+:\d+.*Audio:/.test(String(r.stderr));
}
const rmsOf = (pcm, from, to) => {
  const a = Math.max(0, Math.round(from * SR)), b = Math.min(pcm.length, Math.round(to * SR));
  let sq = 0;
  for (let i = a; i < b; i++) sq += pcm[i] * pcm[i];
  return b > a ? Math.sqrt(sq / (b - a)) : 0;
};
/** 某个频率在一段里的能量(Goertzel),用来认「这一段是哪一个频率的声音」 */
function toneEnergy(pcm, from, to, hz) {
  const a = Math.max(0, Math.round(from * SR)), b = Math.min(pcm.length, Math.round(to * SR));
  const w = 2 * Math.PI * hz / SR, c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = a; i < b; i++) { const s0 = pcm[i] + c * s1 - s2; s2 = s1; s1 = s0; }
  return (s1 * s1 + s2 * s2 - c * s1 * s2) / Math.max(1, b - a);
}
/** 起音时刻:窗口里第一个超过窗口峰值两成的采样 */
function onsetOf(pcm, at, span = 0.3) {
  const a = Math.max(0, Math.round((at - 0.1) * SR)), b = Math.min(pcm.length, Math.round((at + span) * SR));
  let peak = 0;
  for (let i = a; i < b; i++) peak = Math.max(peak, Math.abs(pcm[i]));
  if (peak < 1e-4) return null;
  for (let i = a; i < b; i++) if (Math.abs(pcm[i]) >= peak * 0.2) return i / SR;
  return null;
}
/** 成片里每段声音:有能量、起音对齐(一帧 + AAC 的余量 12 ms)、频率对(`hz` 的能量大于 `notHz` 的) */
function auditMp4(label, file, sounds) {
  const hasTrack = hasAudioTrack(file);
  check(`${label}:成片有音轨`, hasTrack, { file });
  if (!hasTrack) return null;
  const pcm = decodeMono(file);
  const rows = sounds.map((s) => {
    const rms = rmsOf(pcm, s.at, s.at + s.dur), onset = onsetOf(pcm, s.at, s.dur);
    const row = { id: s.id, at: s.at, rms: +rms.toFixed(5), onsetErrMs: onset === null ? null : +((onset - s.at) * 1000).toFixed(1) };
    if (s.hz) { row.hz = s.hz; row.tone = +toneEnergy(pcm, s.at, s.at + s.dur, s.hz).toExponential(2); }
    if (s.notHz) row.other = +toneEnergy(pcm, s.at, s.at + s.dur, s.notHz).toExponential(2);
    return row;
  });
  const first = Math.min(...sounds.map((s) => s.at));
  const lead = rmsOf(pcm, 0, Math.max(0.05, first - 0.12));
  check(`${label}:每段声音在成片里都有能量`, rows.every((r) => r.rms > 0.003), { rows });
  check(`${label}:每段声音的起音离片段起点不超过一帧(33.3 ms)加 12 ms`, rows.every((r) => r.onsetErrMs !== null && Math.abs(r.onsetErrMs) <= 1000 / FPS + 12), { rows: rows.map((r) => [r.id, r.onsetErrMs]) });
  check(`${label}:第一段声音之前是静音`, lead < 0.0015, { leadRms: +lead.toFixed(6), until: +(first - 0.12).toFixed(3) });
  const toned = rows.filter((r) => r.other !== undefined);
  if (toned.length) check(`${label}:频率是这一段该有的那个(不是旧参数的)`, toned.every((r) => r.tone > r.other * 4), { rows: toned.map((r) => [r.id, r.hz, r.tone, r.other]) });
  return { rows, seconds: +(pcm.length / SR).toFixed(3) };
}

/* ------------------------------------------------------------------ 页面里的记录:任何可能出声的动作都记一笔 */
const AUDIO_HOOK = () => {
  if (window.__pcAudioLog) return;
  const logged = (window.__pcAudioLog = []);
  const note = (kind, extra) => logged.push({ kind, at: Math.round(performance.now()), ...extra });
  for (const name of ['AudioContext', 'OfflineAudioContext']) {
    const Original = window[name];
    if (!Original) continue;
    window[name] = new Proxy(Original, { construct(target, args, newTarget) { note(name); return Reflect.construct(target, args, newTarget); } });
  }
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...a) { note('play', { src: String(this.currentSrc || this.src).slice(0, 24) }); return play.apply(this, a); };
  const create = URL.createObjectURL;
  URL.createObjectURL = function (...a) { note('createObjectURL', { type: a[0]?.type ?? null }); return create.apply(this, a); };
  if (window.AudioScheduledSourceNode) {
    const start = AudioScheduledSourceNode.prototype.start;
    AudioScheduledSourceNode.prototype.start = function (...a) { note('sourceStart'); return start.apply(this, a); };
  }
};

/**
 * 在页面里听一段:把播放头放到 `at`、播 `ms` 毫秒,看此刻出声的 `<audio>`。
 * 回:元素的状态、声音源是 blob 还是地址、源解码后在这一段窗口里的能量、从元素实时采到的峰值。
 * 分析节点不接输出,探针自己不出声。
 */
async function listen(page, { at, ms = 700, clipId = null }) {
  return page.evaluate(async ({ at, ms, clipId }) => {
    const { actions, getState } = window.__pcStore;
    const wait = (n) => new Promise((r) => setTimeout(r, n));
    actions.pause(); actions.setVolume?.(1); actions.seek(at);
    const statusOf = () => [...document.querySelectorAll('[role="status"]')].map((e) => e.textContent || '').filter((t) => /音频|声音/.test(t));
    let el = null;
    for (let i = 0; i < 80 && !el; i++) {
      await wait(100);
      el = [...document.querySelectorAll('audio')].find((a) => (a.currentSrc || a.getAttribute('src')) && a.readyState >= 2) ?? null;
      if (!el && [...document.querySelectorAll('audio')].some((a) => a.dataset.cardAudioState === 'error')) break;
    }
    const audios = [...document.querySelectorAll('audio')].map((a) => ({ state: a.dataset.cardAudioState ?? null, src: (a.currentSrc || a.getAttribute('src') || '').slice(0, 60), ready: a.readyState, error: a.error?.code ?? null }));
    if (!el) return { playing: false, audios, status: statusOf() };
    const src = el.currentSrc;
    // 声音源解码:这一段时间窗里有没有能量(源的 0 秒对应的时间轴位置由元素此刻的 currentTime 反推)
    let decoded = null;
    try {
      const bytes = await (await fetch(src)).arrayBuffer();
      const buffer = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(bytes);
      const data = buffer.getChannelData(0), from = Math.max(0, Math.floor(el.currentTime * buffer.sampleRate)), to = Math.min(data.length, from + Math.round((ms / 1000) * buffer.sampleRate));
      let sq = 0, peak = 0;
      for (let i = from; i < to; i++) { sq += data[i] * data[i]; peak = Math.max(peak, Math.abs(data[i])); }
      decoded = { seconds: +buffer.duration.toFixed(4), rms: to > from ? Math.sqrt(sq / (to - from)) : 0, peak, bytes: bytes.byteLength };
    } catch (e) { decoded = { error: String(e?.message ?? e) }; }
    // 实时信号:元素 → captureStream → 分析节点(不接输出)
    let live = { peak: 0, rms: 0, samples: 0 };
    let analyser = null, context = null, source = null;
    try {
      context = window.__pcProbeContext ??= new AudioContext({ sampleRate: 48000 });
      if (context.state !== 'running') await context.resume();
      source = context.createMediaStreamSource(el.captureStream());
      analyser = context.createAnalyser(); analyser.fftSize = 2048;
      source.connect(analyser);
    } catch (e) { live.error = String(e?.message ?? e); }
    const t0 = el.currentTime, block = new Float32Array(2048);
    actions.play();
    const started = performance.now();
    let pausedSeen = 0, sq = 0, n = 0, reached = t0;
    while (performance.now() - started < ms) {
      await wait(20);
      if (el.isConnected) reached = Math.max(reached, el.currentTime);
      if (el.paused) pausedSeen++;
      if (analyser) {
        analyser.getFloatTimeDomainData(block);
        for (const v of block) { live.peak = Math.max(live.peak, Math.abs(v)); sq += v * v; n++; }
        live.samples++;
      }
    }
    const t1 = reached, volume = el.volume, muted = el.muted;
    const owner = getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
    const left = owner ? Math.max(0, owner.end - at) : ms / 1000;
    actions.pause();
    live.rms = n ? Math.sqrt(sq / n) : 0;
    try { source?.disconnect(); } catch { /* 已断 */ }
    await wait(120);
    return {
      // 在走:走过了「监听时长与片段剩余时长里较短那个」的四成(片段比监听时长短时元素会先卸掉)
      playing: t1 - t0 > Math.max(0.08, Math.min(ms / 1000, left) * 0.4), advanced: +(t1 - t0).toFixed(3), pausedSeen, volume, muted,
      source: src.startsWith('blob:') ? 'blob' : 'url', src: src.slice(0, 80), decoded, live, audios, status: statusOf(),
      clip: clipId, playhead: +getState().t.toFixed(3),
    };
  }, { at, ms, clipId });
}
const audible = (r) => !!r && r.playing && r.volume > 0 && !r.muted && (r.decoded?.rms ?? 0) > 0.003 && (r.live?.peak ?? 0) > 0.003;
const brief = (r) => r && ({ playing: r.playing, advanced: r.advanced, source: r.source, decodedRms: r.decoded?.rms && +r.decoded.rms.toFixed(5), livePeak: r.live?.peak && +r.live.peak.toFixed(5), liveErr: r.live?.error, status: r.status, audios: r.audios });

const CHROME_ARGS = [...PROBE_CHROME_ARGS, '--mute-audio', '--no-first-run', '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required',
  ...(process.env.PC_CHROME_ARGS ? process.env.PC_CHROME_ARGS.split(/\s+/).filter(Boolean) : [])];
const cleanups = [];
let exitCode = 1;
try {
  if (PHASES.has('desktop')) await desktopPhase();
  if (PHASES.has('online') || PHASES.has('lowmem')) await onlinePhases();
  const failed = results.filter((r) => !r.ok);
  console.log(JSON.stringify({ summary: { checks: results.length, passed: results.length - failed.length, fails: failed.map((r) => r.check), out: OUT, phases: [...PHASES] } }));
  exitCode = failed.length ? 1 : 0;
} catch (e) {
  console.log(JSON.stringify({ summary: { checks: results.length, error: String(e?.stack ?? e).slice(0, 1500), fails: results.filter((r) => !r.ok).map((r) => r.check), out: OUT } }));
} finally {
  for (const fn of cleanups.reverse()) { try { await fn(); } catch { /* 尽力清 */ } }
}
process.exit(exitCode);

/* ================================================================== 桌面 */
async function desktopPhase() {
  const base = path.join(OUT, 'desktop');
  const dirs = { exportDir: path.join(base, 'out'), dataDir: path.join(base, 'data'), projectsDir: path.join(base, 'projects') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  log('桌面:起 dev server', DESKTOP_PORT);
  const server = await startDevServer({ port: DESKTOP_PORT, logFile: path.join(OUT, 'vite-desktop.log'), log,
    env: { PROMPTCUT_EXPORT_DIR: dirs.exportDir, PROMPTCUT_DATA_DIR: dirs.dataDir, PROMPTCUT_PROJECTS_DIR: dirs.projectsDir, PROMPTCUT_NO_PORT_FILE: '1', PROMPTCUT_PUSH: '0' } });
  cleanups.push(() => server.stop());
  const browser = await puppeteer.launch({ headless: true, protocolTimeout: 900_000, args: CHROME_ARGS });
  cleanups.push(() => browser.close());
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e?.message ?? e).slice(0, 200)));
  await page.evaluateOnNewDocument(AUDIO_HOOK);
  await page.goto(`${server.origin}/?editor&nosetup=1`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await until('桌面编辑器就绪', () => page.evaluate(() => !!window.__pcStore && !!window.__pcIo?.sound), 120_000);
  // 只数导出任务的目录(`export-<时间>`):同一层的 `frame-library`(预渲染进程的快照库)是用到才建的 —— 有声动效卡判轻之后不再提前预渲染,
  // 它可能到导出时才出现,落在「导出前」还是「导出后」也看机器忙不忙,不能算成一个导出任务
  const exportJobs = () => fs.readdirSync(dirs.exportDir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith('export-')).map((d) => d.name);

  /* ---- 摆项目:未生成一段、过期一段、缺失一段 */
  const setup = await page.evaluate(async () => {
    const { actions, getState } = window.__pcStore;
    const sound = await window.__pcIo.sound();
    actions.newProject('sound-ab 桌面');
    actions.setProjectMeta({ width: 640, height: 360, fps: 30 });
    // 总时长跟着内容走:先放一张 4 秒的无声卡把时间轴撑到 4 秒
    actions.addCardClip('punch-pill', 0, { duration: 4 });
    const fresh = actions.addCardClip('av-pulse', 0.5, { duration: 0.6, params: { frequency: 880, gain: 0.6, duration: 0.3 } });
    const stale = actions.addCardClip('av-pulse', 1.5, { duration: 0.6, params: { frequency: 660, gain: 0.6, duration: 0.3 } });
    await sound.generateCardAudio(stale.id);
    actions.setClipParams(stale.id, { frequency: 520 });
    const job = await sound.waitSoundGeneration(sound.startSoundGeneration({ preset: 'notification', start: 2.5, params: { frequency: 1200, duration: 0.3, gain: 0.6 } }).id);
    const p = getState().project;
    const effect = p.tracks.flatMap((t) => t.clips).find((c) => c.id === job.result?.clipId);
    return { fresh: fresh.id, stale: stale.id, effect: effect?.id ?? null, effectHash: p.media.find((m) => m.id === effect?.mediaId)?.hash ?? null, jobState: job.state, duration: p.duration };
  });
  check('桌面:摆好项目(未生成、过期、缺失各一段)', setup.jobState === 'succeeded' && !!setup.effect && !!setup.effectHash, setup);
  // 缺失:把那段提示音的文件从本机内容库里删掉(项目里的素材记录还在)
  const removed = [];
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) walk(f); else if (e.name.includes(setup.effectHash)) { fs.rmSync(f); removed.push(path.relative(base, f)); } } };
  for (const d of [dirs.dataDir, dirs.exportDir]) walk(d);
  const gone = await page.evaluate(async (hash) => !(await (await window.__pcIo.sound()).hasGeneratedAudio(hash, new AbortController().signal)), setup.effectHash);
  check('桌面:提示音的文件已从内容库删掉(素材服务报没有)', removed.length > 0 && gone, { removed });

  /* ---- D1 预览里未生成的声音仍然提示 */
  const hint = await listen(page, { at: 0.55, ms: 300, clipId: setup.fresh });
  check('D1 桌面预览:未生成的声音仍然提示,不自动生成、不出声', !hint.playing && hint.audios.some((a) => a.state === 'error' && !a.src) && hint.status.some((t) => /尚未生成/.test(t)), brief(hint));
  await page.screenshot({ path: path.join(OUT, 'D1-desktop-preview-hint.png') });

  /* ---- D2 清单 */
  const needs = await page.evaluate(async () => (await (await window.__pcIo.sound()).listExportSoundNeeds(new AbortController().signal)).map((n) => ({ clipId: n.clipId, kind: n.kind, reason: n.reason, label: n.label })));
  const reasonOf = (id) => needs.find((n) => n.clipId === id)?.reason;
  check('D2 导出前的清单:未生成、过期、缺失各一段', needs.length === 3 && reasonOf(setup.fresh) === 'ungenerated' && reasonOf(setup.stale) === 'stale' && reasonOf(setup.effect) === 'missing', { needs });

  /* ---- D3 直接导出 */
  log('桌面:直接导出(先生成声音)');
  const jobsBefore = exportJobs();
  const exported = await page.evaluate(async () => {
    const progress = [], ids = [];
    try {
      const r = await window.__pcIo.exportVideo({ onStart: (id) => ids.push(id), onProgress: (done, total, stage) => progress.push([stage ?? 'render', +Number(done).toFixed(2), total]) });
      return { ok: true, outDir: r.outDir, id: r.id, ids, progress };
    } catch (e) { return { ok: false, error: String(e?.message ?? e), ids, progress }; }
  });
  const soundSteps = exported.progress.filter((p) => p[0] === 'sound');
  const firstRender = exported.progress.findIndex((p) => p[0] !== 'sound');
  const lastSound = exported.progress.map((p) => p[0]).lastIndexOf('sound');
  check('D3 桌面直接导出成功', exported.ok, { error: exported.error, ids: exported.ids });
  check('D3 导出进度里看得到生成阶段:sound 共 3 段、从 0 走到 3/3,之后才是出画面', soundSteps.length >= 4 && soundSteps[0][1] === 0 && soundSteps.every((p) => p[2] === 3) && soundSteps.at(-1)[1] === 3 && firstRender > lastSound && lastSound >= 0,
    { soundSteps: soundSteps.length, first: soundSteps[0], last: soundSteps.at(-1), stages: [...new Set(exported.progress.map((p) => p[0]))], firstRender, lastSound });
  check('D3 生成阶段有自己的任务 id(可取消),之后换成导出任务的 id', exported.ids.length === 2 && /^sound-prep-/.test(exported.ids[0]) && exported.ids[1] === exported.id, { ids: exported.ids });
  if (exported.ok) {
    const mp4 = path.join(OUT, 'D3-desktop-export.mp4');
    fs.copyFileSync(path.join(exported.outDir, 'preview.mp4'), mp4);
    auditMp4('D3 桌面成片', mp4, [
      { id: '未生成的有声卡 880 Hz', at: 0.5, dur: 0.3, hz: 880, notHz: 660 },
      { id: '过期的有声卡 520 Hz(旧参数 660 Hz)', at: 1.5, dur: 0.3, hz: 520, notHz: 660 },
      { id: '缺失的提示音 1200 Hz', at: 2.5, dur: 0.3, hz: 1200, notHz: 880 },
    ]);
  }
  const after = await page.evaluate(async () => {
    const sound = await window.__pcIo.sound();
    const needs = await sound.listExportSoundNeeds(new AbortController().signal);
    return { needs: needs.length, media: window.__pcStore.getState().project.media.length };
  });
  check('D3 导出之后三段声音都是有效产物(再导出不用再生成)', after.needs === 0, after);
  check('D3 导出任务只开了一个', exportJobs().length === jobsBefore.length + 1, { before: jobsBefore.length, after: exportJobs().length });

  /* ---- D4 生成中取消 */
  log('桌面:生成中取消');
  const jobsBeforeCancel = exportJobs();
  const cancel = await page.evaluate(async () => {
    const { actions, getState } = window.__pcStore;
    const sound = await window.__pcIo.sound();
    const wait = (n) => new Promise((r) => setTimeout(r, n));
    actions.newProject('sound-ab 取消');
    actions.setProjectMeta({ width: 640, height: 360, fps: 30 });
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push(actions.addCardClip('av-pulse', i * 31, { duration: 30, params: { frequency: 500 + i * 100, gain: 0.5, duration: 0.3 } }).id);
    const started = [], progress = [];
    let cancelledAt = null;
    const run = window.__pcIo.exportVideo({
      onStart: (id) => started.push(id),
      onProgress: (done, total, stage) => {
        progress.push([stage, +Number(done).toFixed(2), total]);
        // 第一段做完、第二段正在做的时候取消
        if (stage === 'sound' && done > 1.2 && cancelledAt === null) { cancelledAt = done; void window.__pcIo.cancelExport(started[0]); }
      },
    }).then(() => ({ ok: true }), (e) => ({ ok: false, cancelled: !!e?.cancelled, message: String(e?.message ?? e) }));
    const outcome = await run;
    const snapshot = () => {
      const p = getState().project;
      return { media: p.media.length, withAudio: p.tracks.flatMap((t) => t.clips).filter((c) => c.cardAudio).map((c) => c.id), project: p };
    };
    const first = snapshot();
    await wait(1500);
    const second = snapshot();
    const needs = await sound.listExportSoundNeeds(new AbortController().signal);
    const stats = [];
    for (const id of first.withAudio) {
      const clip = first.project.tracks.flatMap((t) => t.clips).find((c) => c.id === id);
      const media = first.project.media.find((m) => m.id === clip.cardAudio.mediaId);
      stats.push({ id, frames: clip.cardAudio.frames, hasMedia: !!media, bytes: media ? await sound.hasGeneratedAudio(media.hash, new AbortController().signal) : false });
    }
    return { outcome, started, cancelledAt, lastProgress: progress.at(-1), ids, done: first.withAudio.length, media: first.media, unchanged: first.project === second.project,
      needs: needs.map((n) => [n.clipId, n.reason]), stats };
  });
  check('D4 生成中取消:导出被取消', cancel.outcome.ok === false && cancel.outcome.cancelled === true, cancel.outcome);
  check('D4 取消时还在生成阶段:导出任务没开出来', cancel.started.length === 1 && /^sound-prep-/.test(cancel.started[0]) && exportJobs().length === jobsBeforeCancel.length, { started: cancel.started, jobs: exportJobs().length - jobsBeforeCancel.length });
  check('D4 生成停了:做完的不足 6 段,进度没有走完', cancel.done >= 1 && cancel.done < 6 && cancel.lastProgress?.[1] < 6, { done: cancel.done, cancelledAt: cancel.cancelledAt, lastProgress: cancel.lastProgress });
  check('D4 不留半截产物:素材条数 = 有产物的片段数,每个产物完整(30 秒 = 1440000 帧)且字节在素材服务里', cancel.media === cancel.done && cancel.stats.every((s) => s.hasMedia && s.bytes && s.frames === 30 * SR), { media: cancel.media, stats: cancel.stats });
  check('D4 没做完的片段没有任何声音记录(仍是未生成),取消后项目不再变', cancel.needs.length === 6 - cancel.done && cancel.needs.every((n) => n[1] === 'ungenerated') && cancel.unchanged, { needs: cancel.needs.length, unchanged: cancel.unchanged });

  /* ---- D5 故意让一段生成失败 */
  log('桌面:故意让一段生成失败');
  const jobsBeforeFail = exportJobs();
  const failed = await page.evaluate(async () => {
    const { actions, getState } = window.__pcStore;
    actions.newProject('sound-ab 失败');
    actions.setProjectMeta({ width: 640, height: 360, fps: 30 });
    const good = actions.addCardClip('av-pulse', 0.2, { duration: 0.5, params: { frequency: 700, gain: 0.5, duration: 0.3 } });
    const bad = actions.addCardClip('av-pulse', 1.2, { duration: 0.5, params: { frequency: 9000, gain: 0.5, duration: 0.3 } });
    const started = [], stages = new Set();
    const outcome = await window.__pcIo.exportVideo({ onStart: (id) => started.push(id), onProgress: (_d, _t, stage) => stages.add(stage) })
      .then(() => ({ ok: true }), (e) => ({ ok: false, cancelled: !!e?.cancelled, message: String(e?.message ?? e), code: e?.code ?? null, clipId: e?.clipId ?? null }));
    const clips = getState().project.tracks.flatMap((t) => t.clips);
    return { outcome, started, stages: [...stages], good: good.id, bad: bad.id, goodHasAudio: !!clips.find((c) => c.id === good.id)?.cardAudio, badHasAudio: !!clips.find((c) => c.id === bad.id)?.cardAudio };
  });
  check('D5 一段生成失败:导出失败(不是取消)', failed.outcome.ok === false && !failed.outcome.cancelled, failed.outcome);
  check('D5 错误信息指出是哪个片段(名字与 id)和原因', failed.outcome.clipId === failed.bad && failed.outcome.message.includes(failed.bad) && /片段「.+」/.test(failed.outcome.message) && /frequency/.test(failed.outcome.message), { message: failed.outcome.message, bad: failed.bad });
  check('D5 失败在生成阶段:导出任务没开出来,出问题的那段没有记录', failed.started.length === 1 && exportJobs().length === jobsBeforeFail.length && !failed.badHasAudio && failed.stages.every((s) => s === 'sound'), { started: failed.started, stages: failed.stages, goodHasAudio: failed.goodHasAudio });
  check('桌面:页面没有报错', errors.length === 0, { errors: errors.slice(0, 5) });
  await browser.close();
  server.stop();
}

/* ================================================================== 在线 */
async function onlinePhases() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error(`没有在线构建:${DIST}(先跑 npx vite build --mode online --outDir <目录>)`);
  const SITE = `http://127.0.0.1:${PORTS.editor}`;
  const STAGE_ORIGINS = [`http://127.0.0.1:${PORTS.stageA}`, `http://127.0.0.1:${PORTS.stageB}`];
  const DOC_DIRECT = `http://127.0.0.1:${PORTS.doc}`;
  const dataDir = fs.mkdtempSync(path.join(OUT, 'hosted-'));
  log('在线:起托管组合', PORTS.doc, PORTS.asset);
  const combo = await startHostedCombo({ dataDir, docPort: PORTS.doc, assetPort: PORTS.asset, host: '127.0.0.1',
    docPublicUrl: `ws://127.0.0.1:${PORTS.editor}/hosted/`, assetPublicUrl: `${SITE}/media/api/asset`, log: () => {} });
  cleanups.push(() => combo.close?.() ?? combo.stop?.());

  /** 「素材服务里没有这份文件」:代理对挡住的哈希回 404 / 未完成;同一份重新入库(complete)后放行 */
  const blocked = new Set();
  const assetLog = [];
  const proxyLog = [];
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.wasm': 'application/wasm' };
  const OAC = { 'origin-agent-cluster': '?1' };
  const runtimeConfig = JSON.stringify({ v: 1, stageOrigins: STAGE_ORIGINS });
  const servers = [];
  const makeProxy = (port) => {
    const origin = `http://127.0.0.1:${port}`;
    const forward = (req, res, upstream, strip) => {
      const target = req.url.slice(strip.length) || '/';
      const up = http.request({ host: '127.0.0.1', port: upstream, method: req.method, path: target.startsWith('/') ? target : `/${target}`, headers: req.headers }, (r) => { proxyLog.push(`${req.method} ${req.url.slice(0, 80)} → ${r.statusCode}`); res.writeHead(r.statusCode ?? 502, { ...r.headers, ...OAC }); r.pipe(res); });
      up.on('error', (e) => { proxyLog.push(`${req.method} ${req.url.slice(0, 80)} → 上游错误 ${e.message}`); res.writeHead(502, OAC); res.end('bad gateway'); });
      req.pipe(up);
    };
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, origin);
      if (url.pathname === '/hosted' || url.pathname.startsWith('/hosted/')) return forward(req, res, PORTS.doc, '/hosted');
      const m = /^\/media\/api\/asset\/media\/([0-9a-f]{64})(\/chunks|\/complete|\/\d+)?$/.exec(url.pathname);
      if (m) {
        assetLog.push({ method: req.method, hash: m[1], tail: m[2] ?? '' });
        if (req.method === 'POST' && m[2] === '/complete') blocked.delete(m[1]);
        else if (blocked.has(m[1]) && req.method !== 'PUT' && req.method !== 'OPTIONS') {
          const cors = { 'Access-Control-Allow-Origin': req.headers.origin ?? '*', 'Access-Control-Allow-Headers': 'authorization, content-type, range', ...OAC };
          if (m[2] === '/chunks') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors }); return res.end(JSON.stringify({ hash: m[1], complete: false, received: [] })); }
          res.writeHead(404, cors); return res.end('Not found');
        }
      }
      if (url.pathname.startsWith('/media/')) return forward(req, res, PORTS.asset, '/media');
      const sec = { 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', ...OAC };
      const sendFile = (file, cache) => { res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': cache, ...sec }); fs.createReadStream(file).pipe(res); };
      if (url.pathname === '/editor/runtime-config.json') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...sec }); return res.end(runtimeConfig); }
      const index = path.join(DIST, 'index.html');
      if (url.pathname === '/editor' || url.pathname === '/editor/' || url.pathname === '/editor/index.html') return sendFile(index, 'no-store');
      if (url.pathname.startsWith('/editor/')) {
        const f = path.join(DIST, decodeURIComponent(url.pathname.slice('/editor/'.length)));
        if (f.startsWith(DIST) && fs.existsSync(f) && fs.statSync(f).isFile()) return sendFile(f, 'public, max-age=31536000, immutable');
        return sendFile(index, 'no-store');
      }
      res.writeHead(404, { 'Content-Type': 'text/plain', ...OAC });
      res.end('not found');
    });
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, origin);
      proxyLog.push(`UPGRADE ${req.url.slice(0, 80)}`);
      if (!(url.pathname === '/hosted' || url.pathname.startsWith('/hosted/'))) return socket.destroy();
      const target = (url.pathname.slice('/hosted'.length) || '/') + url.search;
      const up = net.connect(PORTS.doc, '127.0.0.1', () => {
        const lines = [`${req.method} ${target} HTTP/1.1`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
        up.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (head?.length) up.write(head);
        up.pipe(socket); socket.pipe(up);
      });
      up.on('error', (e) => { proxyLog.push(`UPGRADE 上游错误 ${e.message}`); socket.destroy(); });
      up.once('data', (d) => proxyLog.push(`UPGRADE 回 ${String(d).split(/\r?\n/)[0]}`));
      socket.on('error', () => up.destroy());
    });
    servers.push(server);
    return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  };
  await Promise.all([makeProxy(PORTS.editor), makeProxy(PORTS.stageA), makeProxy(PORTS.stageB)]);
  cleanups.push(() => Promise.all(servers.map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }))));

  const NAME = `sound-ab-${RUN}`;
  const creator = { username: 'boss', password: `boss-${randomBytes(6).toString('hex')}` };
  const PROJECT_PW = `pw-${randomBytes(6).toString('hex')}`;
  const shared = await createSharedProject({ base: DOC_DIRECT, name: NAME, mode: 'free', creator, password: PROJECT_PW });
  // 在线页面只加入、不新建:项目要先有内容(空着的加入不了)。探针替创建者的桌面版写进一份空项目
  {
    const protocols = await buildAuthProtocols({ base: DOC_DIRECT, projectId: shared.projectId, username: creator.username, deviceId: 'sound-ab-probe-host-01', deviceName: 'probe-host', as: 'creator', password: creator.password, role: 'page' });
    const ws = new WebSocket(DOC_DIRECT.replace(/^http/, 'ws'), protocols);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
    const ask = (msg) => new Promise((resolve) => {
      const reqId = `seed-${Math.random().toString(36).slice(2)}`;
      const on = (ev) => { const m = JSON.parse(String(ev.data)); if (m.reqId === reqId) { ws.removeEventListener('message', on); resolve(m); } };
      ws.addEventListener('message', on);
      ws.send(JSON.stringify({ ...msg, reqId }));
    });
    await ask({ type: 'project.open', projectId: shared.projectId });
    const body = { version: 1, id: `sound-ab-${RUN}`, name: NAME, width: 640, height: 360, fps: 30, duration: 6, themeId: 'midnight', media: [], tracks: [{ id: 't-1', name: '序列 1', clips: [] }, { id: 't-2', name: '序列 2', clips: [] }] };
    const seeded = await ask({ type: 'project.op', projectId: shared.projectId, opId: randomBytes(16).toString('base64url'), ops: [{ op: 'set', path: '', value: body }] });
    check('在线:共享项目建好并写进一份空项目(托管组合在本机)', !!shared.projectId && !/error|reject/i.test(String(seeded?.type ?? '')), { type: seeded?.type, rev: seeded?.rev ?? null });
    /*
     * 探针里没有渲染节点。在线普通档导出前要核对「重卡的预渲染原尺寸齐不齐」:没有层表时页面把分派表里判重的片段都算缺
     * (素材段、还没测过的卡都在里面),会一直等渲染节点。这里替渲染节点写一张空的层表(= 没有哪一层要用预渲染原尺寸),
     * 画面由导出页逐帧活渲 —— 这个探针验的是声音,画面只用按帧直接算的内置卡。
     */
    for (const id of new Set([body.id, shared.projectId])) {
      const stored = await ask({ type: 'content.put', kind: 'snapshot-manifest', key: `layers:${id}`, body: { v: 2, kind: 'layer-map', projectId: id, fps: 30, width: 640, height: 360, span: 60, at: Date.now(), layers: [] } });
      check(`在线:替渲染节点写一张空层表(${id === body.id ? '项目 id' : '共享项目 id'})`, stored?.type === 'content.stored', { type: stored?.type });
    }
    ws.close();
  }

  const browser = await puppeteer.launch({ headless: true, protocolTimeout: 900_000, args: [...CHROME_ARGS, '--site-per-process'] });
  cleanups.push(() => browser.close());
  async function newPage(label, { mobile = false } = {}) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    page.on('dialog', (d) => void d.accept());
    if (mobile) {
      await page.emulate({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
        viewport: { width: 412, height: 915, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: false } });
      await page.evaluateOnNewDocument(() => { Object.defineProperty(Navigator.prototype, 'deviceMemory', { configurable: true, get: () => 4 }); });
    } else await page.setViewport({ width: 1600, height: 900 });
    await page.evaluateOnNewDocument(AUDIO_HOOK);
    page.label = label; page.errors = [];
    page.on('pageerror', (e) => page.errors.push(String(e?.message ?? e).slice(0, 200)));
    page.consoleLog = [];
    page.wsLog = [];
    const cdp = await page.createCDPSession();
    await cdp.send('Network.enable');
    cdp.on('Network.webSocketFrameSent', (e) => page.wsLog.push(`→ ${e.response.payloadData.slice(0, 160)}`));
    cdp.on('Network.webSocketFrameReceived', (e) => page.wsLog.push(`← ${e.response.payloadData.slice(0, 160)}`));
    cdp.on('Network.webSocketClosed', () => page.wsLog.push('closed'));
    cdp.on('Network.webSocketFrameError', (e) => page.wsLog.push(`error ${e.errorMessage}`));
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warn') page.consoleLog.push(`${m.type()}: ${m.text().slice(0, 200)}`); });
    return page;
  }
  async function typeInto(page, sel, text) {
    await page.waitForSelector(sel, { visible: true, timeout: 15_000 });
    await page.click(sel, { clickCount: 3 });
    await page.keyboard.press('Backspace');
    if (text) await page.type(sel, text, { delay: 5 });
  }
  async function join(page, username) {
    await page.goto(`${SITE}/editor`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.waitForSelector('[data-pc="join-form"]', { visible: true, timeout: 60_000 });
    await typeInto(page, '[data-pc="join-name"]', NAME);
    await typeInto(page, '[data-pc="join-username"]', username);
    await typeInto(page, '[data-pc="join-password"]', PROJECT_PW);
    await page.click('[data-pc="join-submit"]');
    try { await page.waitForSelector('[data-pc="members-button"]', { visible: true, timeout: 60_000 }); }
    catch (e) {
      await page.screenshot({ path: path.join(OUT, `join-failed-${username}.png`) }).catch(() => {});
      const text = await page.evaluate(() => document.querySelector('[data-pc="join-form"]')?.textContent?.slice(0, 300) ?? document.body.innerText.slice(0, 300)).catch(() => '');
      throw new Error(`${username} 加入项目失败:${text} :: ${page.errors.join(' | ')} :: 代理记录 ${JSON.stringify(proxyLog.slice(-12))} :: 控制台 ${JSON.stringify(page.consoleLog.slice(-8))} :: WS ${JSON.stringify(page.wsLog.slice(0, 14))} :: ${e.message}`);
    }
    await until(`${username} 进入项目`, () => page.evaluate(() => !!window.__pcStore && !!window.__pcIo?.sound && !!window.__pcSoundJudge), 60_000);
  }
  const clipsOf = (page) => page.evaluate(() => window.__pcStore.getState().project.tracks.flatMap((t) => t.clips).map((c) => ({ id: c.id, cardId: c.cardId, start: c.start, end: c.end, hasAudio: !!c.cardAudio, effect: c.soundEffect?.recipe?.preset ?? null, mediaId: c.mediaId ?? null })));
  const audioLog = (page) => page.evaluate(() => window.__pcAudioLog.length);
  const audioLogSince = (page, from) => page.evaluate((n) => window.__pcAudioLog.slice(n), from);
  /** 在线直接导出,回进度、任务 id、成片字节(base64) */
  const exportOnline = (page, { cancelAt = null } = {}) => page.evaluate(async (cancelAt) => {
    const progress = [], ids = [], waits = [];
    let cancelled = null;
    // 导出前核对一直不过(等素材、等预渲染原尺寸)或迟迟不结束:取消,把看到的提示交回去,不让探针挂住
    const guard = setTimeout(() => { waits.push('探针:240 秒没结束,取消'); void window.__pcIo.cancelExport(ids[0]); }, 240_000);
    try {
      const r = await window.__pcIo.exportVideo({ target: null, onStart: (id) => ids.push(id),
        onWaiting: (message) => { if (message) { waits.push(message); if (waits.length > 2) void window.__pcIo.cancelExport(ids[0]); } },
        onProgress: (done, total, stage) => {
          progress.push([stage ?? 'render', +Number(done).toFixed(2), total]);
          if (cancelAt !== null && stage === 'sound' && done > cancelAt && cancelled === null) { cancelled = done; void window.__pcIo.cancelExport(ids[0]); }
        } });
      const blob = await window.__pcIo.fetchExportFile(r.id, 'preview.mp4');
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { ok: true, ids, progress, base64: btoa(bin), bytes: bytes.length, waits };
    } catch (e) { return { ok: false, ids, progress, waits, cancelled: !!e?.cancelled, cancelledAt: cancelled, message: String(e?.message ?? e), clipId: e?.clipId ?? null }; }
    finally { clearTimeout(guard); }
  }, cancelAt);

  if (PHASES.has('online')) {
    log('在线普通档:甲加入');
    const A = await newPage('甲');
    await join(A, 'alice');
    const env = await A.evaluate(() => ({ online: window.__pcOnlinePage === true, device: window.__pcSoundJudge.device(), stats: window.__pcSoundJudge.stats() }));
    check('在线:页面是在线浏览器模式(在线构建),声音判定用的是这台设备的设备串', env.online && /cores=\d+ \| mode=build \| stepP=0\.9 \| stepN=16$/.test(env.device), { device: env.device.slice(-60), stats: env.stats });

    /* ---- 摆项目:内置有声卡(未生成)、提示音、键盘声(之后把它们的文件从素材服务里挡掉) */
    const made = await A.evaluate(async () => {
      const { actions, getState } = window.__pcStore;
      const sound = await window.__pcIo.sound();
      actions.setProjectMeta({ width: 640, height: 360, fps: 30 });
      // 总时长跟着内容走:先放一张 6 秒的卡把时间轴撑开。用静音的 av-pulse(按帧直接算的轻卡):在线普通档导出时判重的卡要等渲染节点的
      // 预渲染原尺寸,这个探针里没有渲染节点,画面只放判轻的卡
      const base = actions.addCardClip('av-pulse', 0, { duration: 6, params: { frequency: 300, gain: 0.5, duration: 0.3 } });
      actions.setClipMuted(base.id, true);
      const pulse = actions.addCardClip('av-pulse', 0.5, { duration: 0.6, params: { frequency: 880, gain: 0.6, duration: 0.3 } });
      const note = await sound.waitSoundGeneration(sound.startSoundGeneration({ preset: 'notification', start: 1.5, params: { frequency: 1200, duration: 0.3, gain: 0.6 } }).id);
      const keys = await sound.waitSoundGeneration(sound.startSoundGeneration({ preset: 'keyboard', start: 2.5, typing: { text: 'hello world', duration: 90, delayMs: 0, punctuationPauseMs: 0, newlinePauseMs: 0, jitterMs: 0, seed: 7 }, params: { gain: 0.8 } }).id);
      const p = getState().project, clip = (id) => p.tracks.flatMap((t) => t.clips).find((c) => c.id === id);
      const hashOf = (job) => p.media.find((m) => m.id === clip(job.result?.clipId)?.mediaId)?.hash ?? null;
      return { pulse: pulse.id, note: { state: note.state, error: note.error ?? null, clip: note.result?.clipId ?? null, hash: hashOf(note) },
        keys: { state: keys.state, error: keys.error ?? null, clip: keys.result?.clipId ?? null, hash: hashOf(keys), end: clip(keys.result?.clipId)?.end ?? null } };
    });
    check('在线:提示音与键盘声在在线浏览器里生成、入库成功(判轻)', made.note.state === 'succeeded' && made.keys.state === 'succeeded' && !!made.note.hash && !!made.keys.hash, made);
    blocked.add(made.note.hash); blocked.add(made.keys.hash);
    const noProducts = await A.evaluate(async () => (await (await window.__pcIo.sound()).listExportSoundNeeds(new AbortController().signal)).map((n) => [n.kind, n.reason]));
    check('在线:此刻没有任何现成的声音产物(有声卡未生成,两段音效的文件素材服务里没有)', noProducts.length === 3 && noProducts.filter((n) => n[1] === 'missing').length === 2 && noProducts.some((n) => n[0] === 'card' && n[1] === 'ungenerated'), { noProducts });

    /* ---- O1 测量不出声(有声卡还没测过:提示音、键盘声生成时已经测过) */
    await A.evaluate(() => { const { actions } = window.__pcStore; actions.pause(); actions.seek(5.5); });
    await sleep(400);
    const before = await A.evaluate(() => ({ stats: window.__pcSoundJudge.stats(), log: window.__pcAudioLog.length }));
    const measured = await A.evaluate(async (id) => {
      const { getState } = window.__pcStore;
      const p = getState().project, clip = p.tracks.flatMap((t) => t.clips).find((c) => c.id === id);
      const sound = await window.__pcIo.sound();
      const key = window.__pcSoundJudge.keyOf(p, clip);
      const hadRecord = !!(await window.__pcSoundJudge.read(key));
      let sawMeasuring = 0;
      const timer = setInterval(() => { if (window.__pcSoundJudge.stats().measuring > 0) sawMeasuring++; }, 0);
      const mediaDuring = [];
      const watch = setInterval(() => { mediaDuring.push([...document.querySelectorAll('audio,video')].filter((e) => !e.paused).length); }, 5);
      const decision = await sound.decideClipSound(p, clip);
      clearInterval(timer); clearInterval(watch);
      const record = await window.__pcSoundJudge.read(key);
      return { hadRecord, sawMeasuring, synth: decision.synth, reused: decision.verdict?.reused, record, playingDuring: Math.max(0, ...mediaDuring), context: window.__pcProbeContext?.state ?? null };
    }, made.pulse);
    const during = await audioLogSince(A, before.log);
    const stats = await A.evaluate(() => window.__pcSoundJudge.stats());
    check('O1 测量确实做了:之前没有记录,测了 16 块,记下耗时,判轻', !measured.hadRecord && measured.reused === false && measured.record?.samples === 16 && measured.record?.blockFrames === 4096 && measured.synth === true && stats.measured === before.stats.measured + 1,
      { record: measured.record && { kind: measured.record.kind, blockMs: +measured.record.blockMs.toFixed(3), blockMaxMs: +measured.record.blockMaxMs.toFixed(3), samples: measured.record.samples }, budgetMs: +(4096 / 48000 * 1000 * 0.7).toFixed(1), stats });
    check('O1 测量期间扬声器无输出:没有新建音频上下文、没有元素开始播放、没有新建可播放地址、没有声源启动,页面上没有在播的媒体元素', during.length === 0 && measured.playingDuring === 0, { during, playingDuring: measured.playingDuring });

    /* ---- O2 没有任何现成产物时听得到 */
    const logBeforePlay = await audioLog(A);
    const heardPulse = await listen(A, { at: 0.5, ms: 500, clipId: made.pulse });
    check('O2 内置有声卡(未生成):在线预览听得到,声音源是浏览器合成的', audible(heardPulse) && heardPulse.source === 'blob', brief(heardPulse));
    const heardNote = await listen(A, { at: 1.5, ms: 500, clipId: made.note.clip });
    check('O2 提示音(素材服务里没有文件):在线预览听得到,声音源是浏览器按配方合成的', audible(heardNote) && heardNote.source === 'blob', brief(heardNote));
    const heardKeys = await listen(A, { at: 2.5, ms: 900, clipId: made.keys.clip });
    check('O2 键盘声(素材服务里没有文件):在线预览听得到,声音源是浏览器按配方合成的', audible(heardKeys) && heardKeys.source === 'blob', brief(heardKeys));
    const blobs = (await audioLogSince(A, logBeforePlay)).filter((e) => e.kind === 'createObjectURL' && e.type === 'audio/wav').length;
    check('O2 三段声音各合成了一份临时声音(项目与素材服务都没变)', blobs === 3 && (await clipsOf(A)).find((c) => c.id === made.pulse)?.hasAudio === false && blocked.size === 2, { blobs, blocked: blocked.size });
    // 内置有声卡的画面:在线页面照常渲染(它是普通的 DOM 卡,不是图卡),不出「需要本地 PC 渲染辅助」
    await A.evaluate(() => { const { actions } = window.__pcStore; actions.pause(); actions.seek(0.6); });
    await sleep(1200);
    const picture = { stage: null, badge: null };
    for (const frame of A.frames().filter((f) => /[?&]stage=1/.test(f.url()))) {
      const seen = await frame.evaluate((id) => {
        const wrap = document.querySelector(`[data-pc-clip="${id}"]:not([data-pc-media])`);
        if (!wrap) return null;
        const slot = wrap.querySelector(':scope > [data-pc-placeholder-slot]');
        const ring = [...wrap.querySelectorAll('div')].find((d) => getComputedStyle(d).borderRadius === '50%' && d.getBoundingClientRect().width > 50);
        return { placeholderShown: !!slot && !slot.hidden, reason: slot?.getAttribute('data-pc-placeholder-reason') ?? null, ring: ring ? Math.round(ring.getBoundingClientRect().width) : 0 };
      }, made.pulse).catch(() => null);
      if (seen && (!picture.stage || seen.ring > picture.stage.ring)) picture.stage = seen;
    }
    picture.badge = await A.evaluate(() => document.body.innerText.includes('需要本地 PC 渲染辅助'));
    check('在线:内置有声卡的画面照常渲染(圆环在舞台上),没有「需要本地 PC 渲染辅助」', !!picture.stage && picture.stage.ring > 50 && !picture.stage.placeholderShown && !picture.badge, picture);
    await A.screenshot({ path: path.join(OUT, 'O2-online-preview.png') });
    // 有声动效卡的画面有成本身份(2026-10-06):在线页面也自动测过它(测量日志里有它),播放到它的位置时不被抑制(判轻、活渲)
    const measuredPulse = await until('在线:有声动效卡的画面测过', () => A.evaluate(() => {
      const d = window.__pcPreviewDiag?.();
      return d && !d.probeRun.running && d.probeRun.probed.some((e) => e.cardId === 'av-pulse') ? d.probeRun.probed.filter((e) => e.cardId === 'av-pulse').length : null;
    }), 60_000);
    const whilePlaying = await A.evaluate(async () => {
      const { actions } = window.__pcStore;
      const wait = (n) => new Promise((r) => setTimeout(r, n));
      actions.pause(); actions.seek(0.6);
      await wait(400);
      actions.play();
      await wait(250);
      const suppressed = window.__pcPreviewDiag().suppressed;
      actions.pause();
      await wait(200);
      return suppressed;
    });
    check('在线:有声动效卡的画面自动测过、判轻活渲(播放时不在被抑制的集合里)', !!measuredPulse && !whilePlaying.includes(made.pulse), { measuredPulse, whilePlaying, pulse: made.pulse });

    /* ---- O3 复用记录 */
    const reuse = await A.evaluate(async (id) => {
      const p = window.__pcStore.getState().project, clip = p.tracks.flatMap((t) => t.clips).find((c) => c.id === id);
      const s0 = window.__pcSoundJudge.stats();
      const d = await (await window.__pcIo.sound()).decideClipSound(p, clip);
      return { reused: d.verdict?.reused, measuredDelta: window.__pcSoundJudge.stats().measured - s0.measured };
    }, made.pulse);
    check('O3 再问同一段声音:复用记录,不重测', reuse.reused === true && reuse.measuredDelta === 0, reuse);

    /* ---- O6 在线直接导出(先于判重的场景:此刻三段声音都要生成) */
    log('在线普通档:直接导出');
    const exported = await exportOnline(A);
    const soundSteps = exported.progress.filter((p) => p[0] === 'sound');
    const firstRender = exported.progress.findIndex((p) => p[0] !== 'sound'), lastSound = exported.progress.map((p) => p[0]).lastIndexOf('sound');
    check('O6 在线直接导出成功', exported.ok, { message: exported.message, bytes: exported.bytes, waits: exported.waits, lastProgress: exported.progress.at(-1),
      ...(exported.ok ? {} : { diag: await A.evaluate(() => { const d = window.__pcPreviewDiag?.() ?? {}; return { measureGate: d.measureGate ?? null, probeRun: JSON.stringify(d.probeRun ?? null).slice(0, 300) }; }).catch(() => null) }) });
    check('O6 导出进度里看得到生成阶段:sound 共 3 段、走到 3/3,之后才是出画面', soundSteps.length >= 4 && soundSteps.every((p) => p[2] === 3) && soundSteps.at(-1)?.[1] === 3 && lastSound >= 0 && firstRender > lastSound, { soundSteps: soundSteps.length, last: soundSteps.at(-1), stages: [...new Set(exported.progress.map((p) => p[0]))] });
    if (exported.ok) {
      const mp4 = path.join(OUT, 'O6-online-export.mp4');
      fs.writeFileSync(mp4, Buffer.from(exported.base64, 'base64'));
      auditMp4('O6 在线成片', mp4, [
        { id: '有声卡 880 Hz', at: 0.5, dur: 0.3, hz: 880, notHz: 1200 },
        { id: '提示音 1200 Hz', at: 1.5, dur: 0.3, hz: 1200, notHz: 880 },
        { id: '键盘声(第一个键,片段起点后 90 毫秒)', at: 2.59, dur: 0.07 },
      ]);
    }
    const afterExport = await A.evaluate(async () => {
      const needs = await (await window.__pcIo.sound()).listExportSoundNeeds(new AbortController().signal);
      return { needs: needs.length, clips: window.__pcStore.getState().project.tracks.flatMap((t) => t.clips).map((c) => [c.cardId || c.soundEffect?.recipe?.preset, !!c.cardAudio]) };
    });
    check('O6 导出之后声音成了同步的产物(有声卡有了声音记录,两段音效的文件回到素材服务)', afterExport.needs === 0 && blocked.size === 0 && afterExport.clips.some((c) => c[0] === 'av-pulse' && c[1]), { ...afterExport, blocked: blocked.size });
    const heardProduct = await listen(A, { at: 0.5, ms: 400, clipId: made.pulse });
    check('O6 有了有效产物之后预览改用产物(素材服务的地址),不再用浏览器合成的那份', audible(heardProduct) && heardProduct.source === 'url', brief(heardProduct));

    /* ---- O4 / O5 判重 */
    log('在线普通档:判重');
    const heavy = await A.evaluate(async () => {
      const { actions, getState } = window.__pcStore;
      const added = actions.addCardClip('av-pulse', 4.2, { duration: 0.6, params: { frequency: 440, gain: 0.6, duration: 0.3 } });
      const p = getState().project, clip = p.tracks.flatMap((t) => t.clips).find((c) => c.id === added.id);
      const key = window.__pcSoundJudge.keyOf(p, clip);
      // 按真实的记录形状写一条「每块 200 毫秒」(预算约 59.7 毫秒):这台设备对这段声音判重
      const record = await window.__pcSoundJudge.seed({ soundKey: key, kind: 'card', blockMs: 200 });
      const decision = await (await window.__pcIo.sound()).decideClipSound(p, clip);
      return { id: added.id, key, record: { blockMs: record.blockMs, device: record.device.slice(-40) }, synth: decision.synth, reason: decision.reason ?? null, message: decision.message ?? null, reused: decision.verdict?.reused };
    });
    check('O4 写一条慢记录后这段声音判重(复用记录,不重测)', heavy.synth === false && heavy.reason === 'heavy' && heavy.reused === true, heavy);
    const logBeforeHeavy = await audioLog(A);
    const heavyPreview = await listen(A, { at: 4.25, ms: 400, clipId: heavy.id });
    const heavyLog = await audioLogSince(A, logBeforeHeavy);
    check('O4 判重、没有产物:不在浏览器里合成(没有新建可播放地址),预览不出声并提示原因', !heavyPreview.playing && !heavyLog.some((e) => e.kind === 'createObjectURL') && heavyPreview.status.some((t) => /判重/.test(t)), { ...brief(heavyPreview), log: heavyLog });
    await A.screenshot({ path: path.join(OUT, 'O4-online-heavy-hint.png') });
    const heavyExport = await exportOnline(A);
    check('O4 判重、没有产物:导出失败并指出片段', heavyExport.ok === false && !heavyExport.cancelled && heavyExport.clipId === heavy.id && heavyExport.message.includes(heavy.id) && /判重/.test(heavyExport.message), { message: heavyExport.message });

    log('在线普通档:乙加入,替甲判重的那段生成产物');
    const B = await newPage('乙');
    await join(B, 'bob');
    await until('乙看到那段声音', async () => (await clipsOf(B)).some((c) => c.id === heavy.id), 30_000);
    const made2 = await B.evaluate(async (id) => {
      const sound = await window.__pcIo.sound();
      try { const r = await sound.generateCardAudio(id); return { ok: r.ok, reused: r.reused, stats: window.__pcSoundJudge.stats() }; } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
    }, heavy.id);
    check('O5 乙(另一台设备,自己测、判轻)在在线浏览器里生成了这段声音并入库', made2.ok === true && made2.reused === false, made2);
    await until('产物同步到甲', async () => (await clipsOf(A)).find((c) => c.id === heavy.id)?.hasAudio, 30_000);
    const logBeforeProduct = await audioLog(A);
    const heavyProduct = await listen(A, { at: 4.25, ms: 400, clipId: heavy.id });
    const productLog = await audioLogSince(A, logBeforeProduct);
    check('O5 判重、有产物:甲播的是产物(素材服务的地址,不是浏览器合成的),有能量', audible(heavyProduct) && heavyProduct.source === 'url' && !productLog.some((e) => e.kind === 'createObjectURL'), brief(heavyProduct));
    const stillHeavy = await A.evaluate(async (id) => {
      const p = window.__pcStore.getState().project, clip = p.tracks.flatMap((t) => t.clips).find((c) => c.id === id);
      return (await (await window.__pcIo.sound()).decideClipSound(p, clip)).reason ?? 'light';
    }, heavy.id);
    const heavyExport2 = await exportOnline(A);
    check('O5 判重、有产物:甲这边仍判重,导出直接用产物、成功', stillHeavy === 'heavy' && heavyExport2.ok && !heavyExport2.progress.some((p) => p[0] === 'sound'), { stillHeavy, ok: heavyExport2.ok, message: heavyExport2.message });
    if (heavyExport2.ok) {
      const mp4 = path.join(OUT, 'O5-online-heavy-product-export.mp4');
      fs.writeFileSync(mp4, Buffer.from(heavyExport2.base64, 'base64'));
      auditMp4('O5 判重用产物的成片', mp4, [{ id: '有声卡 880 Hz', at: 0.5, dur: 0.3 }, { id: '判重的有声卡 440 Hz', at: 4.2, dur: 0.3, hz: 440, notHz: 880 }]);
    }
    await B.close();

    /* ---- O7 在线生成中取消 */
    log('在线普通档:生成中取消');
    const cancelSetup = await A.evaluate(() => {
      const { actions } = window.__pcStore;
      const ids = [];
      for (let i = 0; i < 5; i++) ids.push(actions.addCardClip('av-pulse', 10 + i * 31, { duration: 30, params: { frequency: 300 + i * 50, gain: 0.5, duration: 0.3 } }).id);
      return ids;
    });
    const cancelled = await exportOnline(A, { cancelAt: 1.2 });
    await sleep(1500);
    const afterCancel = await A.evaluate(async (ids) => {
      const p = window.__pcStore.getState().project, sound = await window.__pcIo.sound();
      const clips = p.tracks.flatMap((t) => t.clips).filter((c) => ids.includes(c.id));
      const done = clips.filter((c) => c.cardAudio);
      const complete = [];
      for (const c of done) { const m = p.media.find((x) => x.id === c.cardAudio.mediaId); complete.push(!!m && c.cardAudio.frames === 30 * 48000 && await sound.hasGeneratedAudio(m.hash, new AbortController().signal)); }
      const needs = await sound.listExportSoundNeeds(new AbortController().signal);
      return { done: done.length, complete, needs: needs.map((n) => n.reason) };
    }, cancelSetup);
    check('O7 在线生成中取消:导出被取消,进度没走完', cancelled.ok === false && cancelled.cancelled === true && (cancelled.progress.at(-1)?.[1] ?? 0) < 5 && !cancelled.progress.some((p) => p[0] !== 'sound'), { message: cancelled.message, cancelledAt: cancelled.cancelledAt, last: cancelled.progress.at(-1) });
    check('O7 不留半截产物:做完的是完整产物,没做完的没有记录', afterCancel.done >= 1 && afterCancel.done < 5 && afterCancel.complete.every(Boolean) && afterCancel.needs.length === 5 - afterCancel.done && afterCancel.needs.every((r) => r === 'ungenerated'), afterCancel);

    /* ---- O8 在线故意让一段生成失败 */
    const bad = await A.evaluate((ids) => {
      const { actions } = window.__pcStore;
      for (const id of ids) actions.removeClip?.(id);
      return actions.addCardClip('av-pulse', 6.5, { duration: 0.5, params: { frequency: 9000, gain: 0.5, duration: 0.3 } }).id;
    }, cancelSetup);
    const failed = await exportOnline(A);
    check('O8 在线一段生成失败:导出失败并指出片段与原因', failed.ok === false && !failed.cancelled && failed.clipId === bad && failed.message.includes(bad) && /片段「.+」/.test(failed.message) && /frequency/.test(failed.message), { message: failed.message, bad });
    await A.evaluate((id) => window.__pcStore.actions.removeClip?.(id), bad);
    check('在线普通档:页面没有报错', A.errors.length === 0, { errors: A.errors.slice(0, 5) });
    if (!PHASES.has('lowmem')) await A.close();
    else A.keep = true;

    if (PHASES.has('lowmem')) await lowmemPhase({ newPage, join, clipsOf, audioLog, audioLogSince, exportOnline, A, known: { pulse: made.pulse, heavy: heavy.id } });
  } else if (PHASES.has('lowmem')) {
    await lowmemPhase({ newPage, join, clipsOf, audioLog, audioLogSince, exportOnline, A: null, known: null });
  }
  await browser.close();
}

/* ================================================================== 在线低内存档 */
async function lowmemPhase({ newPage, join, clipsOf, audioLog, audioLogSince, exportOnline, A, known }) {
  log('在线低内存档:手机仿真加入');
  // 没有普通档那一步时自己先摆一段有产物的声音
  let seeded = known;
  let helper = A;
  if (!helper) {
    helper = await newPage('甲');
    await join(helper, 'alice');
    seeded = await helper.evaluate(async () => {
      const { actions } = window.__pcStore;
      actions.setProjectMeta({ width: 640, height: 360, fps: 30 });
      const base = actions.addCardClip('av-pulse', 0, { duration: 6, params: { frequency: 300, gain: 0.5, duration: 0.3 } });
      actions.setClipMuted(base.id, true);
      const pulse = actions.addCardClip('av-pulse', 0.5, { duration: 0.6, params: { frequency: 880, gain: 0.6, duration: 0.3 } });
      await (await window.__pcIo.sound()).generateCardAudio(pulse.id);
      return { pulse: pulse.id };
    });
  }
  // 再加一段没生成过的
  const fresh = await helper.evaluate(() => window.__pcStore.actions.addCardClip('av-pulse', 7.0, { duration: 0.6, params: { frequency: 610, gain: 0.6, duration: 0.3 } }).id);
  const M = await newPage('手机', { mobile: true });
  await join(M, 'mobile');
  await until('手机看到片段', async () => (await clipsOf(M)).some((c) => c.id === fresh), 30_000);
  const env = await M.evaluate(async (id) => {
    const p = window.__pcStore.getState().project, clip = p.tracks.flatMap((t) => t.clips).find((c) => c.id === id);
    const s0 = window.__pcSoundJudge.stats();
    const d = await (await window.__pcIo.sound()).decideClipSound(p, clip);
    return { synth: d.synth, reason: d.reason ?? null, message: d.message ?? null, stats0: s0, stats1: window.__pcSoundJudge.stats(), mem: navigator.deviceMemory, touch: navigator.maxTouchPoints };
  }, fresh);
  check('L1 低内存档:不测、不合成(判定直接回「低内存档」,测量次数不变)', env.synth === false && env.reason === 'low-memory' && env.stats1.measured === env.stats0.measured, env);
  const logBefore = await audioLog(M);
  const silent = await listen(M, { at: 7.05, ms: 400, clipId: fresh });
  const silentLog = await audioLogSince(M, logBefore);
  check('L1 低内存档:未生成的有声卡预览不出声,没有新建可播放地址,提示里写明原因', !silent.playing && !silentLog.some((e) => e.kind === 'createObjectURL') && silent.status.some((t) => /低内存档/.test(t)), { ...brief(silent), log: silentLog });
  await M.screenshot({ path: path.join(OUT, 'L1-lowmem-hint.png') });
  const product = await listen(M, { at: 0.5, ms: 400, clipId: seeded.pulse });
  check('L2 低内存档:已经同步的声音产物照常播(素材服务的地址)', audible(product) && product.source === 'url', brief(product));
  const missing = await exportOnline(M);
  check('L3 低内存档:导出开始时缺声音,失败并指出片段(不在这台设备上合成)', missing.ok === false && !missing.cancelled && missing.clipId === fresh && /低内存档/.test(missing.message), { message: missing.message });
  await helper.evaluate(async (id) => { await (await window.__pcIo.sound()).generateCardAudio(id); }, fresh);
  await until('补上的产物同步到手机', async () => (await clipsOf(M)).find((c) => c.id === fresh)?.hasAudio, 30_000);
  const ok = await exportOnline(M);
  check('L3 低内存档:声音齐全时导出成功,不出现生成阶段', ok.ok && !ok.progress.some((p) => p[0] === 'sound'), { ok: ok.ok, message: ok.message, bytes: ok.bytes });
  if (ok.ok) {
    const mp4 = path.join(OUT, 'L3-lowmem-export.mp4');
    fs.writeFileSync(mp4, Buffer.from(ok.base64, 'base64'));
    auditMp4('L3 低内存档成片', mp4, [{ id: '有声卡 880 Hz', at: 0.5, dur: 0.3 }, { id: '补上的有声卡 610 Hz', at: 7.0, dur: 0.3, hz: 610, notHz: 880 }]);
  }
  check('在线低内存档:页面没有报错', M.errors.length === 0, { errors: M.errors.slice(0, 5) });
}
