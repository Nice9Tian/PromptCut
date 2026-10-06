/**
 * 声音预览的浏览器端验收(任务书「第一段」第 3 条;浏览器里的真实行为,用探针断言,不靠人听)。
 *
 *   node scripts/probes/sound-preview-probe.mjs [--mode desktop|online|both] [--out <目录>] [--base-port 5710]
 *        [--doc-port 8792] [--asset-port 8793] [--dist <在线构建目录>] [--keep-temp]
 *
 * 两种形态跑**同一套**断言(runSuite):
 *   - 桌面版形态:本机编辑器 dev server(本脚本所在代码树,临时数据目录),页面 `/?editor&nosetup=1`;
 *   - 在线浏览器模式:本机隔离的托管组合(文档服务 + 素材服务,只绑 127.0.0.1)+ 仿 nginx 的代理 + 在线构建,
 *     创建者 = 桌面形态那一页(在项目设置里勾「多用户协作」放云端),成员 = 在线页面凭邀请链接加入。
 *     在线一侧验的是「消费已经生成并入库的声音」这条现有路径(在线合成声音是另一条改动,不在这里)。
 *     绝不连生产节点、不碰阿里云。
 * 端口:--base-port 起 +0～+2 桌面 dev server(含两个舞台端口)、+3 在线页面的源、+4 / +5 两个舞台的源;
 *       --doc-port / --asset-port 托管组合。
 *
 * 场景(三种声音来源各一):
 *   - 打字机画面卡 mu-typing(0～7 秒,43 个字每字 90 ms)+ 经「生成键盘声」按钮生成的独立键盘声音片段(普通音频片段,长);
 *   - 「结尾加提示音」生成的提示音片段(短,时间轴上很窄);
 *   - 声画卡 av-pulse(5.2～6.2 秒)经「生成声音」按钮生成、依附同一片段的内嵌声音。
 *
 * 不靠人听的做法:无头 Chrome 带 --mute-audio(测试期间扬声器无输出),在页面里给每个 <audio> 元素接
 * captureStream → AnalyserNode(只量不出声),每 12 ms 采样一次 { 时间轴 t, 元素 currentTime, 是否暂停, 音量, 能量 }。
 *
 * 验收标准(退出码 0 当且仅当全部通过):
 *   P1 从头播放:每个声音元素的 currentTime 与时间轴对得上(|ct - (t - 片段起点 + 素材内偏移)| ≤ 0.15 s 的采样占 ≥ 90%),
 *      已采到的事件窗口(媒体时间 [E-0.02, E+0.12])里能量 ≥ 阈值的占 ≥ 80%,且每个事件的能量落在它自己的窗口(相邻事件之间不串);
 *   P2 暂停:暂停后 ≤ 300 ms 所有声音元素都停下、能量落到阈值以下;
 *   P3 拖动(真实指针拖卡尺):拖动途中没有元素在播放;松手后停在指针处;
 *   P4 从片段中间开始播放:第一批采样的 currentTime 接着中间位置(不回到 0),之后一路对齐;被听到的事件都在中间位置之后;
 *   P5 片段静音与恢复(真实右键菜单):静音后片段有 data-audio-muted、时间轴有「已静音」标记(宽片段整块标记,窄片段外置图标),
 *      播放扫过它时没有该片段的元素在响、其他片段照常;恢复后标记消失、声音回来;
 *   P6 声画卡:内嵌声音与画面是同一个片段(时间轴上没有第二个片段),元素的 data-card-audio-state = ready,从中间开始不重来。
 * 截图写进 --out:<形态>-1-playing.png、<形态>-2-muted.png 等。
 */
import './../lib/no-user-dirs.mjs';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { startDevServer, viteBin } from '../lib/dev-server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const MODE = arg('mode', 'both');
const BASE = Number(arg('base-port', 5710));
const DOC_PORT = Number(arg('doc-port', 8792));
const ASSET_PORT = Number(arg('asset-port', 8793));
const OUT = path.resolve(arg('out', path.join(ROOT, '..', '..', 'work', 'four-stage', 'sound', 'preview')));
const KEEP = argv.includes('--keep-temp');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-sound-preview-'));
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const fails = [];
const check = (ok, name, evidence = {}) => {
  results.push({ ok: !!ok, name, evidence });
  if (!ok) fails.push(name);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(evidence).slice(0, 700)}`);
  return !!ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 30_000, every = 200) {
  const t0 = Date.now();
  let last = null;
  for (;;) {
    let v = null;
    try { v = await fn(); } catch (e) { last = String(e?.message ?? e); }
    if (v) return v;
    if (Date.now() - t0 > ms) { fails.push(`等不到:${what}${last ? ` (${last.slice(0, 160)})` : ''}`); console.log(`FAIL 等不到:${what} ${last ?? ''}`); return null; }
    await sleep(every);
  }
}
const P = (page, fn, ...a) => page.evaluate(fn, ...a);

/* ================================================================== 页面里的采样器 */
const HARNESS = () => {
  const state = { trace: [], timer: null, hooks: new WeakMap(), ctx: null, firstCt: new WeakMap() };
  const store = () => window.__pcStore;
  const hook = (el) => {
    if (state.hooks.has(el)) return state.hooks.get(el);
    if (el.readyState < 1 || !el.captureStream) return null;
    try {
      state.ctx ??= new AudioContext();
      const tracks = el.captureStream().getAudioTracks();
      if (!tracks.length) return null;
      const src = state.ctx.createMediaStreamSource(new MediaStream(tracks));
      const an = state.ctx.createAnalyser();
      an.fftSize = 1024;
      src.connect(an); // 只量不出声:不接 destination
      const h = { an, buf: new Float32Array(1024) };
      state.hooks.set(el, h);
      return h;
    } catch { return null; }
  };
  const tick = () => {
    const s = store()?.getState();
    if (!s) return;
    const els = [];
    for (const el of document.querySelectorAll('audio')) {
      const h = hook(el);
      let rms = null;
      if (h) {
        h.an.getFloatTimeDomainData(h.buf);
        let e = 0;
        for (const v of h.buf) e += v * v;
        rms = Math.sqrt(e / h.buf.length);
      }
      if (!state.firstCt.has(el)) state.firstCt.set(el, el.currentTime);
      els.push({ src: el.currentSrc || el.src || '', node: el.getAttribute('data-card-audio-node'), cstate: el.getAttribute('data-card-audio-state'), ct: el.currentTime, paused: el.paused, vol: el.volume, rms, hooked: !!h, ready: el.readyState });
    }
    state.trace.push({ w: performance.now(), t: s.t, playing: s.playing, els });
  };
  window.__sv = {
    async start() {
      state.trace = [];
      state.ctx ??= new AudioContext();
      await state.ctx.resume().catch(() => {});
      clearInterval(state.timer);
      state.timer = setInterval(tick, 12);
      tick();
    },
    stop() { clearInterval(state.timer); state.timer = null; const t = state.trace; state.trace = []; return t; },
    snapshot: () => state.trace.length,
    ctxState: () => state.ctx?.state ?? null,
  };
};

/* ================================================================== 场景(在页面里用真实按钮、真实生成流程搭) */
const TEXT = 'The quick brown fox jumps over the lazy dog';
/** 左栏切到「编辑」(参数面板、生成声音按钮都在这一页) */
const openEdit = (page) => P(page, () => { const b = document.querySelector('[data-pc-rail="edit"]'); if (b && b.getAttribute('aria-pressed') !== 'true') b.click(); });
async function buildScenario(page) {
  await P(page, async (text) => {
    const S = window.__pcStore;
    const { createEmptyProject } = await import('/src/kernel/project.ts');
    S.actions.loadProject({ ...createEmptyProject('声音预览验收'), width: 1280, height: 720, fps: 30, duration: 8, media: [],
      tracks: [{ id: 't-vis', name: '画面', clips: [] }, { id: 't-av', name: '声画', clips: [] }] });
    const c = S.actions.addCardClip('mu-typing', 0, { trackId: 't-vis', duration: 7, params: { text, duration: 90 } });
    S.actions.select([c.id]);
    window.__svTyping = c.id;
  }, TEXT);
  await openEdit(page);
  const clickData = async (sel, label) => {
    const el = await page.waitForSelector(sel, { visible: true, timeout: 20_000 }).catch(() => null);
    if (!el) throw new Error(`找不到按钮 ${label}`);
    await el.click();
  };
  const mediaCount = () => P(page, () => window.__pcStore.getState().project.media.length);
  await clickData('[data-pc="sound-keyboard"]', '生成键盘声');
  if (!(await until('键盘声入库', async () => (await mediaCount()) >= 1, 60_000))) throw new Error('键盘声没生成');
  await P(page, () => window.__pcStore.actions.select([window.__svTyping]));
  await clickData('[data-pc="sound-typing-end"]', '结尾加提示音');
  if (!(await until('提示音入库', async () => (await mediaCount()) >= 2, 60_000))) throw new Error('提示音没生成');
  const av = await P(page, () => {
    const S = window.__pcStore;
    const c = S.actions.addCardClip('av-pulse', 5.2, { trackId: 't-av', duration: 1 });
    S.actions.select([c.id]);
    return c.id;
  });
  await openEdit(page);
  await page.waitForSelector('[data-pc="card-audio-controls"]', { visible: true, timeout: 20_000 });
  await P(page, () => { for (const b of document.querySelectorAll('[data-pc="card-audio-controls"] button')) if (b.textContent.trim() === '生成声音') b.click(); });
  if (!(await until('声画卡声音入库并提交', () => P(page, (id) => !!window.__pcStore.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === id)?.cardAudio, av), 60_000))) throw new Error('声画卡声音没生成');
  // 取场景的真值:每个声音的片段、素材哈希、事件的媒体时间
  return P(page, async (avId) => {
    const S = window.__pcStore;
    const p = S.getState().project;
    const SR = 48000;
    const clips = p.tracks.flatMap((t) => t.clips.map((c) => ({ ...c, trackId: t.id })));
    const out = {};
    for (const c of clips) {
      const m = c.mediaId ? p.media.find((x) => x.id === c.mediaId) : null;
      if (m?.soundEffect?.recipe?.preset === 'keyboard') out.kbd = { id: c.id, start: c.start, end: c.end, off: c.mediaOffset ?? 0, hash: m.hash, events: m.soundEffect.recipe.events.map((e) => e.frame / SR) };
      else if (m?.soundEffect?.recipe?.preset === 'notification') out.notif = { id: c.id, start: c.start, end: c.end, off: c.mediaOffset ?? 0, hash: m.hash, events: m.soundEffect.recipe.events.map((e) => e.frame / SR) };
      if (c.id === avId) {
        const cm = p.media.find((x) => x.id === c.cardAudio.mediaId);
        out.av = { id: c.id, start: c.start, end: c.end, off: 0, hash: cm.hash, events: [0], cardAudio: c.cardAudio };
      }
    }
    out.clipCount = clips.length;
    out.avDuplicateAudioClips = clips.filter((c) => c.mediaId && p.media.find((x) => x.id === c.mediaId)?.hash === out.av.hash).length;
    out.tracks = p.tracks.map((t) => ({ id: t.id, n: t.clips.length }));
    out.typing = window.__svTyping;
    return out;
  }, av);
}

/* ================================================================== 采样分析 */
const THR = 0.003;
const hashOf = (src) => /([0-9a-f]{64})/.exec(src)?.[1] ?? null;
function clipOfEl(truth, el) {
  const h = hashOf(el.src);
  return [truth.kbd, truth.notif, truth.av].find((c) => c && c.hash === h) ?? null;
}
/** 把采样里每个元素按片段归类,算对齐偏差 */
function analyse(trace, truth) {
  const per = { kbd: [], notif: [], av: [] };
  for (const s of trace) for (const el of s.els) {
    const c = clipOfEl(truth, el);
    if (!c) continue;
    const key = c === truth.kbd ? 'kbd' : c === truth.notif ? 'notif' : 'av';
    per[key].push({ w: s.w, t: s.t, playing: s.playing, ...el, expect: s.t - c.start + c.off });
  }
  return per;
}
function alignment(samples) {
  const playing = samples.filter((x) => x.playing && !x.paused);
  if (!playing.length) return { n: 0, ok: 0, frac: 0, maxDev: null };
  const dev = playing.map((x) => Math.abs(x.ct - x.expect));
  const ok = dev.filter((d) => d <= 0.15).length;
  return { n: playing.length, ok, frac: ok / playing.length, maxDev: Math.max(...dev), medianDev: dev.sort((a, b) => a - b)[dev.length >> 1] };
}
/** 事件是否被听到:媒体时间窗口 [E-0.02, E+0.12] 里最大能量 ≥ THR;只看 hook 之后的采样 */
function heardEvents(samples, clip, { after = -Infinity } = {}) {
  const hooked = samples.filter((x) => x.hooked && x.rms !== null && !x.paused);
  if (!hooked.length) return { eligible: 0, heard: [], missed: [] };
  const firstCt = Math.min(...hooked.map((x) => x.ct));
  const lastCt = Math.max(...hooked.map((x) => x.ct));
  const heard = [], missed = [];
  for (const E of clip.events) {
    if (E < Math.max(after, firstCt + 0.03) || E + 0.12 > lastCt) continue; // 窗口没被采到的不判
    const win = hooked.filter((x) => x.ct >= E - 0.02 && x.ct <= E + 0.12);
    const peak = win.length ? Math.max(...win.map((x) => x.rms)) : 0;
    (peak >= THR ? heard : missed).push(+E.toFixed(3));
  }
  return { eligible: heard.length + missed.length, heard, missed };
}
/** 事件之间的空档:相邻事件间隔 ≥ 0.2 s 时,中间(E+0.15, 下一个 E-0.02)的能量应低于阈值(声音没有串到别处) */
function gapsQuiet(samples, clip) {
  const hooked = samples.filter((x) => x.hooked && x.rms !== null && !x.paused);
  const bad = [];
  let checked = 0;
  for (let i = 0; i + 1 < clip.events.length; i++) {
    const a = clip.events[i] + 0.2, b = clip.events[i + 1] - 0.03;
    if (b - a < 0.05) continue;
    const win = hooked.filter((x) => x.ct >= a && x.ct <= b);
    if (!win.length) continue;
    checked++;
    if (Math.max(...win.map((x) => x.rms)) >= THR * 3) bad.push([+a.toFixed(3), +b.toFixed(3)]);
  }
  return { checked, bad };
}

/* ================================================================== 套件 */
async function runSuite(page, label, truth) {
  const tag = (s) => `${label}:${s}`;
  const S = (fn, ...a) => P(page, fn, ...a);
  const shot = async (name) => { const f = path.join(OUT, `${label}-${name}.png`); await page.screenshot({ path: f }).catch(() => {}); return f; };
  const play = (from) => S((t) => { const s = window.__pcStore; s.actions.pause(); s.actions.seek(t); s.actions.play(); }, from);
  const stopAll = () => S(() => { const s = window.__pcStore; s.actions.pause(); });
  const seek = (t) => S((x) => window.__pcStore.actions.seek(x), t);
  await S(HARNESS);
  await S(() => window.__sv.start());
  const shots = {};

  /* ---- P1 从头播放 ---- */
  await stopAll(); await seek(0); await sleep(400);
  await play(0);
  await sleep(1500);
  shots.playing = await shot('1-playing');
  await sleep(5100); // 播到 ~7 秒:键盘声整段、提示音、声画卡都走过
  await stopAll();
  const t1 = await S(() => window.__sv.stop());
  await S(() => window.__sv.start());
  const a1 = analyse(t1, truth);
  const ctxState = await S(() => window.__sv.ctxState());
  check(ctxState === 'running', tag('P0 采样用的 AudioContext 在运行(能量采样有效)'), { ctxState });
  for (const key of ['kbd', 'notif', 'av']) {
    const al = alignment(a1[key]);
    check(al.n > 5 && al.frac >= 0.9, tag(`P1 ${key} 播放时元素 currentTime 与时间轴对齐`), al);
  }
  const hk = heardEvents(a1.kbd, truth.kbd);
  check(hk.eligible >= 20 && hk.heard.length / hk.eligible >= 0.8, tag('P1 键盘声每个事件窗口里都有能量'), { eligible: hk.eligible, heard: hk.heard.length, missed: hk.missed.slice(0, 10) });
  const hn = heardEvents(a1.notif, truth.notif);
  check(a1.notif.some((x) => x.hooked && x.rms !== null && x.rms >= THR), tag('P1 提示音片段播放时有能量'), { heard: hn.heard.length, eligible: hn.eligible, maxRms: Math.max(0, ...a1.notif.filter((x) => x.rms !== null).map((x) => x.rms)) });
  check(a1.av.some((x) => x.hooked && x.rms !== null && x.rms >= THR), tag('P6 声画卡内嵌声音播放时有能量'), { maxRms: Math.max(0, ...a1.av.filter((x) => x.rms !== null).map((x) => x.rms)) });
  check(a1.av.length > 0 && a1.av.every((x) => x.cstate === 'ready' || x.cstate === 'pending'), tag('P6 声画卡元素 data-card-audio-state 为 ready'), { states: [...new Set(a1.av.map((x) => x.cstate))] });
  check(truth.clipCount === 4 && truth.avDuplicateAudioClips === 0, tag('P6 声画卡的声音与画面是同一个片段(项目里只有 4 个片段:打字卡、键盘声、提示音、声画卡;没有第二个引用它声音的片段)'), { clipCount: truth.clipCount, avDuplicateAudioClips: truth.avDuplicateAudioClips });

  /* ---- P2 暂停 ---- */
  await seek(0.4); await sleep(300);
  await play(0.4); await sleep(900);
  const pausedAt = await S(() => { const s = window.__pcStore; const t0 = performance.now(); s.actions.pause(); return t0; });
  await sleep(700);
  const t2 = await S(() => window.__sv.stop());
  await S(() => window.__sv.start());
  const after = t2.filter((s) => s.w > pausedAt + 300);
  const stillPlaying = after.filter((s) => s.els.some((e) => !e.paused));
  const stillLoud = after.filter((s) => s.els.some((e) => e.rms !== null && e.rms >= THR));
  check(after.length > 10 && stillPlaying.length === 0 && stillLoud.length === 0, tag('P2 暂停后 300 ms 内所有声音元素停下、能量落到阈值以下'), { samplesAfter: after.length, stillPlaying: stillPlaying.length, stillLoud: stillLoud.length });
  const stoppedT = await S(() => window.__pcStore.getState().t);

  /* ---- P3 拖动(真实指针拖卡尺) ---- */
  await stopAll();
  const geo = await S(() => {
    const r = document.querySelector('[data-pc="ruler"]').getBoundingClientRect();
    const pps = (() => { const el = document.querySelector('[data-clip-id]'); return el ? el.getBoundingClientRect().width / ((window.__pcStore.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === el.getAttribute('data-clip-id'))?.end ?? 1) - (window.__pcStore.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === el.getAttribute('data-clip-id'))?.start ?? 0)) : 100; })();
    return { x: r.left, y: r.top + r.height / 2, w: r.width, pps };
  });
  // 卡尺的 x 与时间:用播放头现在的位置标定
  const calib = async () => S(() => { const ph = document.querySelector('[data-pc="playhead"]').getBoundingClientRect(); return { x: ph.left + ph.width / 2, t: window.__pcStore.getState().t }; });
  await seek(0); await sleep(150);
  const c0 = await calib();
  await seek(4); await sleep(150);
  const c4 = await calib();
  const pxPerSec = (c4.x - c0.x) / 4;
  const xAt = (t) => c0.x + t * pxPerSec;
  await S(() => window.__sv.start());
  await page.mouse.move(xAt(0.5), geo.y);
  await page.mouse.down();
  const dragNotPlaying = [];
  for (let i = 0; i <= 24; i++) {
    await page.mouse.move(xAt(0.5 + (i / 24) * 2.0), geo.y, { steps: 2 });
    await sleep(25);
  }
  await sleep(150);
  const midDrag = await S(() => window.__sv.snapshot());
  await page.mouse.up();
  await sleep(300);
  const t3 = await S(() => window.__sv.stop());
  await S(() => window.__sv.start());
  const playingDuringDrag = t3.filter((s) => s.els.some((e) => !e.paused));
  const tRelease = await S(() => window.__pcStore.getState().t);
  check(midDrag > 20 && playingDuringDrag.length === 0, tag('P3 拖动卡尺途中没有声音元素在播放'), { samples: t3.length, playingSamples: playingDuringDrag.length });
  check(Math.abs(tRelease - 2.5) < 0.2, tag('P3 松手后播放头停在指针处'), { tRelease });
  shots.drag = await shot('3-after-drag');

  /* ---- P4 从片段中间开始播放 ---- */
  const MID = 1.6; // 键盘声片段中间(片段 0.x ~ 3 秒左右)
  await stopAll(); await seek(MID); await sleep(700);
  const visualText = await Promise.all(page.frames().map((f) => f.evaluate(() => [...document.querySelectorAll('h1')].map((h) => h.textContent).join('')).catch(() => '')));
  const wantText = TEXT.slice(0, Math.floor((MID * 1000) / 90));
  check(visualText.some((x) => x === wantText), tag('P4 画面:停在 1.6 秒时打字机已打到第 17 个字(不是从头重打)'), { want: wantText, got: visualText.filter(Boolean) });
  await play(MID);
  await sleep(1800);
  await stopAll();
  const t4 = await S(() => window.__sv.stop());
  await S(() => window.__sv.start());
  const a4 = analyse(t4, truth);
  const kbdMid = truth.kbd;
  const startMedia = MID - kbdMid.start + kbdMid.off;
  const kbdPlaying = a4.kbd.filter((x) => x.playing && !x.paused);
  const firstCt = kbdPlaying.length ? kbdPlaying[0].ct : null;
  const minCt = kbdPlaying.length ? Math.min(...kbdPlaying.map((x) => x.ct)) : null;
  check(kbdPlaying.length > 10 && minCt >= startMedia - 0.15 && minCt > 0.5, tag('P4 从片段中间播放:currentTime 接着中间位置,不回到 0'), { startMedia: +startMedia.toFixed(3), firstCt, minCt });
  const al4 = alignment(a4.kbd);
  check(al4.n > 10 && al4.frac >= 0.9, tag('P4 从中间播放后一路对齐'), al4);
  const h4 = heardEvents(a4.kbd, kbdMid, { after: startMedia - 0.02 });
  check(h4.eligible >= 8 && h4.heard.length / h4.eligible >= 0.8 && h4.heard.every((e) => e >= startMedia - 0.05), tag('P4 中间播放时听到的都是中间位置之后的事件,且没有漏'), { eligible: h4.eligible, heard: h4.heard.length, firstHeard: h4.heard[0], startMedia: +startMedia.toFixed(3), missed: h4.missed.slice(0, 8) });
  // 画面:打字机在 t=1.6 时应已有 17 个字(floor(1600/90)=17),不是从头重来
  const typed = await S((text) => { const h = [...document.querySelectorAll('iframe')]; return h.length; });
  // 声画卡中间:5.2 开始的片段,从 5.3 播
  await stopAll(); await seek(5.3); await sleep(500);
  await S(() => window.__sv.start());
  await play(5.3); await sleep(500); await stopAll();
  const t4b = await S(() => window.__sv.stop());
  await S(() => window.__sv.start());
  const a4b = analyse(t4b, truth);
  const avPlaying = a4b.av.filter((x) => x.playing && !x.paused);
  const avMin = avPlaying.length ? Math.min(...avPlaying.map((x) => x.ct)) : null;
  check(avPlaying.length > 5 && avMin >= (5.3 - truth.av.start) - 0.15 && avMin > 0.05, tag('P6 声画卡从中间播放:内嵌声音接着中间位置,不从头重来'), { avMin, expectAtLeast: +(5.3 - truth.av.start - 0.15).toFixed(3) });

  /* ---- P5 静音与恢复(真实右键菜单) ---- */
  const widths = await S((ids) => Object.fromEntries(ids.map((id) => [id, document.querySelector(`[data-clip-id="${id}"]`)?.getBoundingClientRect().width ?? null])), [truth.kbd.id, truth.notif.id, truth.av.id]);
  const menuMute = async (clipId, text) => {
    const box = await page.$eval(`[data-clip-id="${clipId}"]`, (el) => { const r = el.getBoundingClientRect(); return { x: r.left + Math.min(r.width / 2, 40), y: r.top + r.height / 2 }; });
    await page.mouse.click(box.x, box.y, { button: 'right' });
    await sleep(250);
    const clicked = await S((label) => {
      const items = [...document.querySelectorAll('[data-pc="tl-ctxmenu"] .pc-tl-ctxmenu-item')].filter((e) => e.textContent.trim() === label);
      if (!items.length) return false;
      items[0].click();
      return true;
    }, text);
    await sleep(250);
    return clicked;
  };
  const badgeOf = (id) => S((cid) => {
    const clip = document.querySelector(`[data-clip-id="${cid}"]`);
    const badges = [...document.querySelectorAll('[data-pc="clip-muted"]')];
    const own = clip?.querySelector('[data-pc="clip-muted"]') ?? badges.find((b) => (b.getAttribute('title') || '').includes(clip?.getAttribute('title')?.split('：')[0] ?? '\u0000'));
    return { attr: clip?.getAttribute('data-audio-muted') ?? null, badge: !!own, compact: !!own?.classList.contains('is-compact'), text: own?.textContent?.trim() ?? null, title: own?.getAttribute('title') ?? null, total: badges.length };
  }, id);
  await stopAll(); await seek(0); await sleep(300);
  const mutedKbd = await menuMute(truth.kbd.id, '静音片段');
  const bKbd = await badgeOf(truth.kbd.id);
  check(mutedKbd && bKbd.attr === 'true' && bKbd.badge && /已静音/.test(bKbd.text ?? ''), tag('P5 键盘声片段静音后:data-audio-muted 且时间轴有「已静音」标记'), { clicked: mutedKbd, width: widths[truth.kbd.id], ...bKbd });
  const mutedNotif = await menuMute(truth.notif.id, '静音片段');
  const bNotif = await badgeOf(truth.notif.id);
  check(mutedNotif && bNotif.attr === 'true' && bNotif.badge, tag('P5 提示音片段(窄)静音后有标记'), { clicked: mutedNotif, width: widths[truth.notif.id], compactVariantExpected: widths[truth.notif.id] < 76, ...bNotif });
  check(bNotif.compact === (widths[truth.notif.id] < 76), tag('P5 窄片段(<76px)用外置图标、宽片段用整块标记'), { width: widths[truth.notif.id], compact: bNotif.compact });
  const bAvBefore = await badgeOf(truth.av.id);
  check(!bAvBefore.attr, tag('P5 没静音的声画卡片段没有标记'), bAvBefore);
  await S(() => window.__sv.start());
  await play(0.3);
  await sleep(1400);
  shots.muted = await shot('2-muted-playing');
  await sleep(300);
  await stopAll();
  const t5 = await S(() => window.__sv.stop());
  await S(() => window.__sv.start());
  const a5 = analyse(t5, truth);
  const mutedHeard = a5.kbd.filter((x) => x.playing && !x.paused);
  check(mutedHeard.length === 0, tag('P5 静音的键盘声片段播放扫过时没有它的元素在播'), { kbdElementSamplesPlaying: mutedHeard.length });
  // 其他片段照常:播过声画卡
  await stopAll(); await seek(5.2); await sleep(400);
  await S(() => window.__sv.start());
  await play(5.2); await sleep(900); await stopAll();
  const t5b = await S(() => window.__sv.stop());
  await S(() => window.__sv.start());
  const a5b = analyse(t5b, truth);
  check(a5b.av.some((x) => x.rms !== null && x.rms >= THR), tag('P5 其他片段(声画卡)在别的片段静音时照常出声'), { maxRms: Math.max(0, ...a5b.av.filter((x) => x.rms !== null).map((x) => x.rms)) });
  // 声画卡自己静音:参数面板的按钮
  await S((id) => window.__pcStore.actions.select([id]), truth.av.id);
  await openEdit(page);
  await page.waitForSelector('[data-pc="card-audio-controls"]', { visible: true, timeout: 15_000 });
  await S(() => { for (const b of document.querySelectorAll('[data-pc="card-audio-controls"] button')) if (b.textContent.trim() === '静音卡片') b.click(); });
  await sleep(300);
  const bAv = await badgeOf(truth.av.id);
  const avStill = await S((id) => !!window.__pcStore.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === id && c.cardId === 'av-pulse'), truth.av.id);
  check(bAv.attr === 'true' && bAv.badge && avStill, tag('P5 声画卡静音:标记出现,画面片段还在'), { ...bAv, visualClipStillThere: avStill });
  await stopAll(); await seek(5.2); await sleep(300);
  await S(() => window.__sv.start());
  await play(5.2); await sleep(900); await stopAll();
  const t5c = await S(() => window.__sv.stop());
  await S(() => window.__sv.start());
  check(analyse(t5c, truth).av.filter((x) => x.playing && !x.paused).length === 0, tag('P5 静音后的声画卡片段没有声音元素在播'), {});
  // 恢复
  await stopAll();
  await S(() => { for (const b of document.querySelectorAll('[data-pc="card-audio-controls"] button')) if (b.textContent.trim() === '恢复声音') b.click(); });
  const rKbd = await menuMute(truth.kbd.id, '恢复片段声音');
  const rNotif = await menuMute(truth.notif.id, '恢复片段声音');
  const bK2 = await badgeOf(truth.kbd.id), bN2 = await badgeOf(truth.notif.id), bA2 = await badgeOf(truth.av.id);
  check(rKbd && rNotif && !bK2.attr && !bK2.badge && !bN2.attr && !bN2.badge && !bA2.attr && !bA2.badge && bA2.total === 0, tag('P5 恢复后:三个片段的标记都撤掉'), { bK2, bN2, bA2 });
  await seek(0.3); await sleep(300);
  await S(() => window.__sv.start());
  await play(0.3); await sleep(1500); shots.restored = await shot('3-restored-playing'); await stopAll();
  const t5d = await S(() => window.__sv.stop());
  const a5d = analyse(t5d, truth);
  check(a5d.kbd.some((x) => x.playing && !x.paused) && a5d.kbd.some((x) => x.rms !== null && x.rms >= THR), tag('P5 恢复后键盘声重新出声'), { maxRms: Math.max(0, ...a5d.kbd.filter((x) => x.rms !== null).map((x) => x.rms)) });
  return shots;
}

/* ================================================================== 主流程 */
let browser = null, dev = null, combo = null, proxies = [], summary = { out: OUT };

async function launchBrowser() {
  const { default: puppeteer } = await import('puppeteer');
  const { PROBE_CHROME_ARGS } = await import('./probe-chrome.mjs');
  return puppeteer.launch({ headless: true, protocolTimeout: 600_000, defaultViewport: { width: 1600, height: 900 },
    args: [...PROBE_CHROME_ARGS, '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--site-per-process',
      ...(process.env.PC_CHROME_ARGS ? process.env.PC_CHROME_ARGS.split(/\s+/).filter(Boolean) : [])] });
}
async function newPage(label) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('dialog', (d) => void d.accept());
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e?.message ?? e).slice(0, 200)));
  page.label = label;
  return page;
}
async function startDesktop() {
  const dir = path.join(TMP, 'desktop');
  for (const d of ['data', 'card-overrides', 'projects', 'work', 'tmp']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  const env = {};
  Object.assign(env, { PROMPTCUT_NO_PORT_FILE: '1', PROMPTCUT_EXPORT_DIR: dir, PROMPTCUT_DATA_DIR: path.join(dir, 'data'), PROMPTCUT_CARD_OVERRIDES: path.join(dir, 'card-overrides'),
    PROMPTCUT_PROJECTS_DIR: path.join(dir, 'projects'), PROMPTCUT_WORK_DIR: path.join(dir, 'work'), PROMPTCUT_STREAMS: '0', TEMP: path.join(dir, 'tmp'), TMP: path.join(dir, 'tmp'), TMPDIR: path.join(dir, 'tmp') });
  dev = await startDevServer({ env, logFile: path.join(dir, 'vite.log'), port: BASE, log: (m) => console.log(`[dev] ${m}`) });
  console.log(`[dev] 桌面形态 ${dev.origin}`);
}
const portFree = (port) => new Promise((resolve) => { const s = net.createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });

async function startOnlineSite() {
  const SITE = `http://127.0.0.1:${BASE + 3}`;
  for (const p of [BASE + 3, BASE + 4, BASE + 5, DOC_PORT, ASSET_PORT]) if (!(await portFree(p))) throw new Error(`端口 ${p} 被占用`);
  let DIST = arg('dist', null);
  if (!DIST) {
    DIST = path.join(TMP, 'dist-online');
    console.log(`[online] 构建在线页面到 ${DIST}`);
    const b = spawnSync(process.execPath, [viteBin(), 'build', '--mode', 'online', '--outDir', DIST, '--emptyOutDir', '--logLevel', 'error'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    if (b.status !== 0) throw new Error(`在线构建失败:${String(b.stderr).slice(-600)}`);
  }
  DIST = path.resolve(DIST);
  const { startHostedCombo } = await import('../../server/hosted/combo.mjs');
  fs.mkdirSync(path.join(TMP, 'hosted'), { recursive: true });
  combo = await startHostedCombo({ dataDir: path.join(TMP, 'hosted'), docPort: DOC_PORT, assetPort: ASSET_PORT, host: '127.0.0.1',
    docPublicUrl: `ws://127.0.0.1:${BASE + 3}/hosted/`, assetPublicUrl: `${SITE}/media/api/asset`, log: () => {} });
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.wasm': 'application/wasm' };
  const OAC = { 'origin-agent-cluster': '?1' };
  const stageOrigins = [`http://127.0.0.1:${BASE + 4}`, `http://127.0.0.1:${BASE + 5}`];
  const runtimeConfig = JSON.stringify({ v: 1, stageOrigins });
  const make = (port) => {
    const origin = `http://127.0.0.1:${port}`;
    const forward = (req, res, upstream, strip) => {
      const target = req.url.slice(strip.length) || '/';
      const up = http.request({ host: '127.0.0.1', port: upstream, method: req.method, path: target.startsWith('/') ? target : `/${target}`, headers: req.headers }, (r) => { res.writeHead(r.statusCode ?? 502, { ...r.headers, ...OAC }); r.pipe(res); });
      up.on('error', () => { res.writeHead(502, OAC); res.end('bad gateway'); });
      req.pipe(up);
    };
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, origin);
      if (url.pathname === '/hosted' || url.pathname.startsWith('/hosted/')) return forward(req, res, DOC_PORT, '/hosted');
      if (url.pathname.startsWith('/media/')) return forward(req, res, ASSET_PORT, '/media');
      const sec = { 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', ...OAC };
      const sendFile = (file, cache) => { res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': cache, ...sec }); fs.createReadStream(file).pipe(res); };
      if (url.pathname === '/editor/runtime-config.json') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...sec }); return res.end(runtimeConfig); }
      const index = path.join(DIST, 'index.html');
      if (url.pathname === '/editor' || url.pathname === '/editor/' || url.pathname === '/editor/index.html') return sendFile(index, 'no-store');
      if (url.pathname.startsWith('/editor/assets/')) {
        const f = path.join(DIST, decodeURIComponent(url.pathname.slice('/editor/'.length)));
        if (!f.startsWith(DIST) || !fs.existsSync(f)) { res.writeHead(404, sec); return res.end('not found'); }
        return sendFile(f, 'public, max-age=31536000, immutable');
      }
      if (url.pathname.startsWith('/editor/')) return sendFile(index, 'no-store');
      res.writeHead(404, { 'Content-Type': 'text/plain', ...OAC }); res.end('not found');
    });
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, origin);
      if (!(url.pathname === '/hosted' || url.pathname.startsWith('/hosted/'))) return socket.destroy();
      const target = (url.pathname.slice('/hosted'.length) || '/') + url.search;
      const up = net.connect(DOC_PORT, '127.0.0.1', () => {
        const lines = [`${req.method} ${target} HTTP/1.1`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
        up.write(`${lines.join('\r\n')}\r\n\r\n`); if (head?.length) up.write(head); up.pipe(socket); socket.pipe(up);
      });
      up.on('error', () => socket.destroy()); socket.on('error', () => up.destroy());
    });
    proxies.push(server);
    return new Promise((r) => server.listen(port, '127.0.0.1', r));
  };
  await Promise.all([make(BASE + 3), make(BASE + 4), make(BASE + 5)]);
  return SITE;
}
const typeInto = async (page, sel, text) => { await page.waitForSelector(sel, { visible: true, timeout: 20_000 }); await page.click(sel); await page.$eval(sel, (el) => el.select()); await page.keyboard.press('Backspace'); if (text) await page.type(sel, text, { delay: 5 }); };
const textOf = (page, sel) => page.$eval(sel, (el) => el.textContent ?? '').catch(() => '');

async function enableCollab(creator, SITE) {
  await P(creator, () => window.dispatchEvent(new Event('pc-open-project-settings')));
  await creator.waitForSelector('[data-pc="collab-section"]', { visible: true, timeout: 20_000 });
  await creator.click('[data-pc="collab-toggle"]');
  await creator.waitForSelector('[data-pc="collab-where-hosted"]', { visible: true });
  await creator.click('[data-pc="collab-where-hosted"]');
  await typeInto(creator, '[data-pc="collab-hosted-url"]', `${SITE}/hosted/`);
  await creator.click('.pc-dialog-foot .pc-btn--primary');
  const status = await until('放云端开启完成', async () => { const t = await textOf(creator, '[data-pc="collab-status"]'); return t && !t.includes('正在设置') ? t : null; }, 90_000, 300);
  if (!check(status?.includes('多用户协作已开启。'), '创建者项目设置里开启「多用户协作」放云端(本机托管组合)', { status })) throw new Error('协作没开起来');
  await creator.waitForSelector('[data-pc="collab-invite-link"]', { timeout: 20_000 });
  const link = (await textOf(creator, '[data-pc="collab-invite-link"]')).trim();
  await creator.keyboard.press('Escape');
  return link;
}

try {
  if (MODE === 'desktop' || MODE === 'both') await startDesktop();
  else await startDesktop(); // 在线模式也要一台桌面版当创建者
  browser = await launchBrowser();
  const creator = await newPage('creator');
  await creator.goto(`${dev.origin}/?editor&nosetup=1`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await until('桌面编辑器就绪', () => P(creator, () => !!window.__pcStore && !!document.querySelector('[data-pc="ruler"]')), 120_000, 300);
  await P(creator, () => { for (const b of document.querySelectorAll('.ais-dialog .ais-btn')) if (b.textContent?.trim() === '关闭') b.click(); });
  const truth = await buildScenario(creator);
  summary.truth = { kbdEvents: truth.kbd.events.length, notif: truth.notif.events, av: truth.av.events, start: [truth.kbd.start, truth.notif.start, truth.av.start] };
  check(truth.kbd.events.length >= 30 && !!truth.notif && !!truth.av, '场景:键盘声(≥30 个事件)、提示音、声画卡声音都已生成入库', summary.truth);

  if (MODE === 'desktop' || MODE === 'both') {
    summary.desktopShots = await runSuite(creator, 'desktop', truth);
    summary.desktopErrors = creator.errors.slice(0, 10);
  }
  if (MODE === 'online' || MODE === 'both') {
    const SITE = await startOnlineSite();
    // 开协作前先恢复到干净状态(静音都已恢复),让成员看到的与创建者一致
    const link = await enableCollab(creator, SITE);
    const code = String(link).split('invite=')[1];
    // 等素材上云
    const uploaded = await until('三份声音素材上传到本机托管组合', async () => {
      const q = await fetch(`${dev.origin}/api/media/upload-queue`).then((r) => r.json()).catch(() => null);
      return q && (q.pending ?? q.queued ?? q.length ?? 0) === 0 ? q : null;
    }, 120_000, 1000);
    summary.uploadQueue = uploaded;
    const member = await newPage('member');
    await member.goto(`${SITE}/editor#invite=${code}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await member.waitForSelector('[data-pc="join-invite-project"]', { visible: true, timeout: 60_000 });
    await typeInto(member, '[data-pc="join-username"]', '成员');
    await member.click('[data-pc="join-submit"]');
    await member.waitForSelector('[data-pc="members-button"]', { visible: true, timeout: 90_000 });
    const ready = await until('成员页看到共享项目的全部声音素材与片段', () => P(member, () => {
      const p = window.__pcStore?.getState().project;
      return p && p.media.length >= 3 && p.tracks.flatMap((t) => t.clips).length >= 5 ? p.media.length : null;
    }), 90_000, 500);
    check(!!ready, '在线成员页收到共享项目(声音素材与片段都在)', { media: ready });
    const isOnline = await P(member, () => location.pathname.startsWith('/editor'));
    check(isOnline, '成员页是在线浏览器模式(/editor)', { url: member.url().replace(/#.*/, '') });
    // 真值:成员页上的哈希与创建者一致
    summary.onlineShots = await runSuite(member, 'online', truth);
    summary.onlineErrors = member.errors.slice(0, 10);
  }
} catch (e) {
  fails.push(`中断:${String(e?.message ?? e).slice(0, 300)}`);
  console.error(e);
} finally {
  try { await browser?.close(); } catch { /* 已关 */ }
  try { dev?.stop(); } catch { /* 已关 */ }
  for (const s of proxies) { try { s.close(); } catch { /* 已关 */ } }
  try { await combo?.close?.(); } catch { /* 已关 */ }
  if (!KEEP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 留着 */ } }
}
summary.ok = fails.length === 0;
summary.fails = fails;
summary.checks = results.length;
fs.writeFileSync(path.join(OUT, `result-${MODE}.json`), JSON.stringify({ ...summary, results }, null, 2));
console.log(JSON.stringify({ ok: summary.ok, checks: results.length, fails }));
process.exit(summary.ok ? 0 : 1);
