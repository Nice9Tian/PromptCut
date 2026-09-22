/**
 * R5「播放与追帧」的验收探针（K3 / K4 / K5 / K6）。
 *
 *   node scripts/probes/playback-probe.mjs [--port 5281] [--seconds 10] [--keep]
 *                                          [--origin http://127.0.0.1:5281]
 *                                          [--json out/playback.json] [--only 节拍,跳转,...]
 *
 * 不带 `--origin` 时自己起一台 dev server（缺省 5281，舞台端口随之 5282 / 5283），
 * `PROMPTCUT_DATA_DIR` 指到临时目录，免得把仓库 `out/card-costs.json` 冲掉。
 *
 * # 怎么把「这张卡判轻还是判重」摆成想要的样子
 *
 * K2 的分派完全由 `costs` 决定，而 `costs` 是 K1 探针实测出来的 —— 在探针里等它测完
 * 再祈祷数值落在想要的一档，验收就变成了掷骰子。所以这里**自己写 `costs`**：
 * 项目建好之后按 `clipIdentityOf` 算出每个片段的 `identityKey`，PUT 一批合成记录，
 * 再调 `planDispatch.setPlanCosts` 让页面这端立刻重算并 `setPlan` 下发。
 * 合成记录里的 `stepMs` / `catchUpMs` / `vtOk` / `seekOk` 就是 K3 / K5 的分路开关。
 *
 * # 这台机器上的量法限制（照 R2 报告）
 *
 * 无头 Chrome 不带 `--disable-gpu-vsync --disable-frame-rate-limit` 时 rAF 会退到 10 Hz，
 * 节拍循环的 `await __pcRealRaf()` 就等不到、拍长全错。所以两个开关必须带。
 * **代价**：带了之后 rAF 不再被垂直同步量化成 16.6 ms 的格子，于是
 * 「24 / 25 fps 自然是 2 / 3 帧交替」「30 fps 下没有 16.6 ms 的短拍」这两条在这里
 * **观察不到那个现象本身**（rAF 想什么时候来就什么时候来）。能量准、也是这一条真正要保的，
 * 是**到达间隔的均值 = 1000 / fps** 和**连续两条 `frame` 的 `sec` 差恒为 1/fps**。
 * 真机（有垂直同步的会话）上的 2/3 交替要靠 `oac-probe` 那种带显示节拍的跑法验，这里记一笔。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';

import { stagePortsOf } from '../../server/stage-ports.mjs';

/* ------------------------------------------------------------------ 参数 */

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => { const i = argv.indexOf(name); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback; };
const has = (name) => argv.includes(name);

const port = Number(flag('--port', '5281')) || 5281;
const originArg = flag('--origin');
const seconds = Math.max(1, Number(flag('--seconds', '10')) || 10);
const keep = has('--keep');
const outJson = flag('--json');
const only = (flag('--only') || '').split(',').map((s) => s.trim()).filter(Boolean);
const origin = (originArg || `http://127.0.0.1:${port}`).replace(/\/+$/, '');
const wants = (name) => !only.length || only.includes(name);

const EDITOR_URL = '/?editor&headless=1&preview=stage';
/** 页面视口宽(时间轴那一节按它裁看得见的 x,见 xAt) */
const VIEWPORT_W = 1600;

const fails = [];
const out = { origin, editorUrl: EDITOR_URL, stagePorts: stagePortsOf(port), seconds, cases: {} };
const check = (cond, label, extra) => {
  if (!cond) fails.push(label + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''));
  return cond;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 进度打在 stderr 上:一趟要跑几分钟,卡在哪一步得看得见(stdout 留给 JSON) */
const step = (msg) => process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${msg}\n`);

/* ------------------------------------------------------------------ dev server */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-playback-'));
const costsFile = path.join(dataDir, 'card-costs.json');
let server = null;

async function startServer() {
  if (originArg) return null;
  const viteBin = path.join(path.dirname(createRequire(import.meta.url).resolve('vite/package.json')), 'bin', 'vite.js');
  const proc = spawn(process.execPath,
    [viteBin, '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    { cwd: path.resolve(import.meta.dirname, '../..'), env: { ...process.env, PROMPTCUT_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = [];
  proc.stdout.on('data', (b) => log.push(String(b)));
  proc.stderr.on('data', (b) => log.push(String(b)));
  for (let i = 0; i < 240; i++) {
    try {
      const res = await fetch(origin + '/@vite/client');
      if (res.ok) return proc;
    } catch { /* 还没起来 */ }
    await sleep(500);
  }
  proc.kill();
  throw new Error(`dev server 240 秒没起来:\n${log.join('')}`);
}

async function stopServer() {
  if (!server) return;
  server.kill();
  if (process.platform === 'win32') {
    await new Promise((r) => spawn('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' }).on('close', r));
  }
  server = null;
}

/* ------------------------------------------------------------------ 页面侧的几段脚本 */

/**
 * 主文档里装两个记录器:
 *   - `__pcFrames`:每一条 `frame` / `ended` / `settled` 事件和它的**真实**到达时刻;
 *   - `__pcLongTasks`:主文档的长任务(> 50 ms),「零卡顿」那一条的量法。
 * 订阅走 `stageBridge.onStageEvent`(角色过滤已经在那里做完了)。
 */
const INSTALL_RECORDERS = async () => {
  const bridge = await import('/src/editor/stageBridge.ts');
  window.__pcFrames = [];
  window.__pcEvents = [];
  if (!window.__pcOffEvents) {
    window.__pcOffEvents = bridge.onStageEvent((e) => {
      const at = performance.now();
      if (e.type === 'frame') window.__pcFrames.push({ sec: e.sec, at });
      else window.__pcEvents.push({ type: e.type, sec: e.sec, clipIds: e.clipIds ?? null, clipId: e.clipId ?? null, at });
    });
  }
  window.__pcLongTasks = [];
  if (!window.__pcLongObs) {
    try {
      window.__pcLongObs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__pcLongTasks.push({ start: entry.startTime, dur: entry.duration });
      });
      window.__pcLongObs.observe({ entryTypes: ['longtask'] });
    } catch { window.__pcLongObs = null; }
  }
  return true;
};

/** 建一个项目:一条轨道一张卡,参数由调用方给 */
const BUILD = async ({ fps, duration, cards }) => {
  await import('/src/cards/index.ts');
  const { actions, getState } = await import('/src/store/project.ts');
  actions.newProject('playback-probe');
  actions.setProjectMeta({ fps, duration });
  for (const card of cards) {
    actions.addCardClip(card.id, card.start ?? 0, { duration: card.duration ?? duration });
  }
  const project = getState().project;
  // 片段按加入顺序落在各自的轨道上;回一张 cardId → clipId 的表
  const byCard = {};
  for (const tr of project.tracks) for (const c of tr.clips) if (c.cardId) (byCard[c.cardId] ||= []).push(c.id);
  if (cards.some((c) => c.params)) {
    for (const card of cards) {
      if (!card.params) continue;
      for (const clipId of byCard[card.id] ?? []) actions.setClipParams(clipId, card.params, { merge: true });
    }
  }
  actions.setProjectMeta({ duration });
  return { byCard, fps: getState().project.fps, duration: getState().project.duration };
};

/**
 * 按 `clipIdentityOf` 算出每个片段的 `identityKey`,PUT 一批合成成本记录,
 * 再调 `setPlanCosts` 让页面立刻重算并 `setPlan` 下发给舞台。
 * `specs` 是 `{ [cardId]: { stepMs, catchUpMs, vtOk, seekOk, seekMs, kind } }`。
 */
const SET_COSTS = async ({ specs }) => {
  const { getState } = await import('/src/store/project.ts');
  const { clipIdentityOf } = await import('/src/editor/costIdentity.ts');
  const { setPlanCosts, currentPlan } = await import('/src/editor/planDispatch.ts');
  const project = getState().project;
  const { identityKeys } = clipIdentityOf(project);
  /*
   * **必须沿用 K1 常驻探针写下的那个 `device` 串**：`costs` 按 `(identityKey, device)` 去重，
   * 换一个 device 只会多一条记录，真实测出来的那条还在，`planPipelines` 索引时后写的赢，
   * 于是「人为摆成轻卡」这件事根本不生效（`probe-slow` 实测 60 ms > B，会被判 `capped`）。
   * 写回同一个 device 就是覆盖，而且 `probeRunner` 的「已有记录且 demoted !== true 就跳过」
   * 会让它之后不再重测。
   */
  const existing = (await (await fetch('/api/data/costs')).json())?.costs ?? [];
  const device = existing[0]?.device ?? 'playback-probe';
  const records = [];
  const seen = new Set();
  for (const tr of project.tracks) {
    for (const clip of tr.clips) {
      const spec = specs[clip.cardId];
      const key = identityKeys[clip.id];
      if (!spec || !key || seen.has(key)) continue;
      seen.add(key);
      records.push({
        identityKey: key, device, mode: 'dev', fps: project.fps,
        stepMs: spec.stepMs, stepMaxMs: spec.stepMs, inlineMs: 1, rasterMs: 0, serializeMs: 1,
        catchUpMs: spec.catchUpMs ?? 0, kind: spec.kind ?? 'stepped',
        vtOk: spec.vtOk, seekOk: spec.seekOk, seekMs: spec.seekMs ?? null,
        capped: spec.capped ?? false, demoted: false, measuredAt: Date.now(),
      });
    }
  }
  await fetch('/api/data/costs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ records }) });
  const tuning = (await (await fetch('/api/data/costs')).json())?.tuning ?? null;
  setPlanCosts(records, tuning);
  // 攒一拍才算(planDispatch 用 microtask 合批)
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 50));
  const plan = currentPlan();
  return {
    records: records.map((r) => ({ identityKey: r.identityKey, stepMs: r.stepMs, catchUpMs: r.catchUpMs, vtOk: r.vtOk, seekOk: r.seekOk })),
    segments: plan ? plan.segments.map((s) => ({ fromSec: s.fromSec, toSec: s.toSec, heavy: [...s.heavy], light: [...s.light] })) : null,
    prerenderSet: plan ? [...plan.prerenderSet] : null,
  };
};

const RESET_RECORDERS = () => { window.__pcFrames = []; window.__pcEvents = []; window.__pcLongTasks = []; };
const READ_RECORDERS = () => ({ frames: window.__pcFrames, events: window.__pcEvents, longTasks: window.__pcLongTasks });

/* ------------------------------------------------------------------ 小工具 */

/**
 * 时间轴标尺上按比例取一个**看得见**的 x。
 *
 * 标尺元素比视口宽得多（30 秒 × pxPerSec 轻松几千像素，横向靠 `.pc-tl-scroll` 滚动），
 * 按 `box.width` 取比例会算出一个在视口外的坐标 —— `page.mouse` 点过去什么都不会发生。
 * 这里只在「标尺左边缘 ~ 视口右边缘」这一段里取。
 */
const xAt = (box, frac) => {
  const left = box.x + 24;
  const right = Math.min(box.x + box.width, VIEWPORT_W) - 24;
  return left + Math.max(0, right - left) * frac;
};

const stats = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return { n: xs.length, mean: +mean.toFixed(3), p50: +s[Math.floor(s.length * 0.5)].toFixed(3), min: +s[0].toFixed(3), max: +s[s.length - 1].toFixed(3) };
};

/**
 * 等 K1 的常驻探针把这一轮测完(`ProbeGate` 的遮罩摘掉)。
 *
 * **每次换项目之后都要等**:探针会按真实成绩写 `costs`,而这个探针接着要把同一批
 * `identityKey` 覆盖成人为摆好的值。不等的话两边会互相盖。
 */
async function waitProbeIdle(page, timeoutMs = 300000) {
  await page.waitForFunction(async () => {
    const m = await import('/src/editor/probeRunner.ts');
    return m.probeProgress().running === false;
  }, { timeout: timeoutMs, polling: 300 }).catch(() => {});
}

/** 舞台侧的内部状态(跨源摸不到 document,只能问 `__pcStageDiag`) */
async function stageDiag(page, id) {
  const frame = page.frames().find((f) => f.url().includes('stage=1') && f.url().includes(`id=${id}`));
  if (!frame) return null;
  return await frame.evaluate(() => (typeof window.__pcStageDiag === 'function' ? window.__pcStageDiag() : null)).catch(() => null);
}
async function frontDiag(page) {
  const which = await page.evaluate(() => (typeof window.__pcPreviewDiag === 'function' ? window.__pcPreviewDiag() : null));
  if (!which) return { preview: null, stage: null };
  return { preview: which, stage: await stageDiag(page, which.frontId) };
}

/* ------------------------------------------------------------------ 主流程 */

const browser = await puppeteer.launch({
  headless: true,
  // 一次 evaluate 里可能要等舞台跑完一整趟补跑,缺省 180 秒不够
  protocolTimeout: 240000,
  args: ['--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    // R2 报告:不带这两个,这台机器上无头 Chrome 的 rAF 退到 10 Hz,节拍循环根本等不到帧
    '--disable-gpu-vsync', '--disable-frame-rate-limit'],
});
let exitCode = 0;
let page = null;
try {
  server = await startServer();
  page = await browser.newPage();
  await page.setViewport({ width: VIEWPORT_W, height: 1000 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  step('goto editor');
  await page.goto(origin + EDITOR_URL, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForSelector('iframe[data-pc="stage-frame"]', { timeout: 180000 });
  step('stage iframe up');
  await page.waitForFunction(async () => {
    const m = await import('/src/editor/stageBridge.ts');
    return m.backRole() === 'back';
  }, { timeout: 180000, polling: 500 });
  step('two stages registered');
  await page.evaluate(INSTALL_RECORDERS);
  step('recorders installed');

  /* ============================================================ 1. K4 节拍 */
  if (wants('节拍')) {
    const cadence = {};
    for (const fps of [24, 25, 30, 60]) {
      step(`cadence ${fps}: build`);
      await page.evaluate(BUILD, { fps, duration: seconds + 5, cards: [{ id: 'probe-css' }] });
      await waitProbeIdle(page);
      step(`cadence ${fps}: set costs`);
      await page.evaluate(SET_COSTS, { specs: { 'probe-css': { stepMs: 1, catchUpMs: 10, vtOk: true, seekOk: true, seekMs: 1 } } });
      step(`cadence ${fps}: seek 0`);
      await page.evaluate(async () => {
        const { actions } = await import('/src/store/project.ts');
        actions.seek(0);
      });
      await sleep(300);
      await page.evaluate(RESET_RECORDERS);
      step(`cadence ${fps}: play`);
      await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.play(); });
      await sleep(seconds * 1000);
      step(`cadence ${fps}: pause`);
      await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.pause(); });
      await sleep(400);
      const rec = await page.evaluate(READ_RECORDERS);
      // pinned 架构 10:正常播放一次都不该判卡顿(24 / 25 fps 是 R5-6 说的误触发档)
      const stallDiag = await page.evaluate(() => (typeof window.__pcPreviewDiag === 'function' ? window.__pcPreviewDiag() : null));
      const gaps = [];
      const secDiffs = [];
      for (let i = 1; i < rec.frames.length; i++) {
        gaps.push(rec.frames[i].at - rec.frames[i - 1].at);
        secDiffs.push(rec.frames[i].sec - rec.frames[i - 1].sec);
      }
      const want = 1000 / fps;
      const g = stats(gaps);
      const wrongSec = secDiffs.filter((d) => Math.abs(d - 1 / fps) > 1e-6).length;
      // 「短拍」= 到达间隔不到一拍的一半:真跳了一拍才算,rAF 的抖动不算
      const shortBeats = gaps.filter((x) => x < want * 0.5).length;
      cadence[fps] = { beats: rec.frames.length, want: +want.toFixed(3), gap: g, secDiffWrong: wrongSec, shortBeats, longTasks: rec.longTasks.length,
        mediaStallCount: stallDiag?.mediaStallCount ?? null, mediaGapMaxMs: stallDiag ? +Number(stallDiag.mediaGapMaxMs).toFixed(3) : null };
      check(stallDiag && stallDiag.mediaStallCount === 0,
        `${fps} fps:播 ${seconds} 秒 mediaStalled 触发 0 次(pinned 架构 10)`,
        { count: stallDiag?.mediaStallCount, overBeatMaxMs: stallDiag?.mediaGapMaxMs });
      check(g && Math.abs(g.mean - want) <= 1, `${fps} fps:frame 到达间隔的均值 = ${want.toFixed(2)} ± 1 ms`, g);
      check(wrongSec === 0, `${fps} fps:连续两条 frame 的 sec 差恒为 1/fps`, { wrongSec, n: secDiffs.length });
      /*
       * 「短拍」这一条任务书只对 **30 fps** 提(「30 fps 下没有 16.6 ms 的短拍」)。
       * 别的帧率只记数不判:60 fps 上量到的短间隔是**父页收 postMessage 的抖动**
       * —— 两条 `frame` 挨着到达,而舞台那边的拍是准的(`sec` 差恒为 1/fps、
       * 10 秒恰好 600 拍)。真跳了一拍的话 `secDiffWrong` 会非零。
       */
      if (fps === 30) check(shortBeats === 0, `${fps} fps:没有 16.6 ms 的短拍`, { shortBeats });
      // 「主文档零卡顿」:播放中主文档的长任务为 0
      check(rec.longTasks.length === 0, `${fps} fps:播放中主文档长任务为 0`, rec.longTasks.slice(0, 3));
    }
    out.cases['节拍'] = cadence;
  }

  /* ============================================================ 2. 播放到头的收尾 */
  if (wants('到头')) {
    await page.evaluate(BUILD, { fps: 30, duration: 2, cards: [{ id: 'probe-css' }] });
    await waitProbeIdle(page);
    await page.evaluate(SET_COSTS, { specs: { 'probe-css': { stepMs: 1, catchUpMs: 10, vtOk: true, seekOk: true, seekMs: 1 } } });
    await page.evaluate(async () => {
      const { actions } = await import('/src/store/project.ts');
      actions.seek(1.2);
    });
    await sleep(300);
    await page.evaluate(RESET_RECORDERS);
    await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.play(); });
    await page.waitForFunction(() => (window.__pcEvents ?? []).some((e) => e.type === 'ended'), { timeout: 30000, polling: 50 }).catch(() => {});
    await sleep(1200);
    const rec = await page.evaluate(READ_RECORDERS);
    const state = await page.evaluate(async () => {
      const { getState } = await import('/src/store/project.ts');
      const s = getState();
      return { t: s.t, playing: s.playing, duration: s.project.duration };
    });
    const diag = await frontDiag(page);
    const ended = rec.events.find((e) => e.type === 'ended');
    out.cases['到头'] = { ended, state, stage: diag.stage, settled: rec.events.filter((e) => e.type === 'settled') };
    check(!!ended, '播放到头 post 了 ended');
    check(state.playing === false, 'ended 之后 store.playing 是 false', state);
    check(Math.abs(state.t - state.duration) < 1e-6, 'ended 之后 store.t = duration', state);
    check(diag.stage && diag.stage.beatRunning === false, 'ended 之后节拍循环停了', diag.stage);
    check(diag.stage && diag.stage.suppressed.length === 0, '最后一帧不停在抑制态(suppressed 空)', diag.stage?.suppressed);

    /*
     * R7-11 的回归:播放头停在末尾时**再按播放要从最早那张卡重播**,不是立刻 ended。
     * legacy 的墙钟循环一直是这么做的(`Preview.tsx:155-158`),翻开关之后漏了。
     */
    await page.evaluate(RESET_RECORDERS);
    await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.play(); });
    await sleep(800);
    const replay = await page.evaluate(READ_RECORDERS);
    const replayState = await page.evaluate(async () => {
      const { getState } = await import('/src/store/project.ts');
      const s = getState();
      return { t: s.t, playing: s.playing };
    });
    await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.pause(); });
    await sleep(300);
    const firstSec = replay.frames[0]?.sec ?? null;
    out.cases['到头重播'] = { frames: replay.frames.length, firstSec, lastSec: replay.frames.at(-1)?.sec ?? null,
      endedAgain: replay.events.filter((e) => e.type === 'ended').length, state: replayState };
    check(replay.frames.length > 5, '播到头再按播放:真的开始播了(收到多条 frame)', out.cases['到头重播']);
    check(firstSec !== null && firstSec < 0.5, '播到头再按播放:从最早那张卡(0 秒)起,不是从 duration 起', out.cases['到头重播']);
    check(out.cases['到头重播'].endedAgain === 0, '播到头再按播放:不再立刻 ended', out.cases['到头重播']);
  }

  /* ============================================================ 3. 暂停后重卡追到活渲(第一路 / 第二路) */
  if (wants('追帧')) {
    /* ---- 第一路:vtOk 的重卡在可见舞台里自己追,post settled 带 clipId ---- */
    const built = await page.evaluate(BUILD, {
      fps: 30, duration: 30,
      cards: [{ id: 'probe-css', duration: 30 }, { id: 'probe-motion-js', duration: 30 }],
    });
    await waitProbeIdle(page);
    // probe-css 判重(capped)且 vtOk → 第一路;probe-motion-js 判轻(便宜)
    await page.evaluate(SET_COSTS, {
      specs: {
        'probe-css': { stepMs: 1, catchUpMs: 10, vtOk: true, seekOk: false, seekMs: null, capped: true },
        'probe-motion-js': { stepMs: 1, catchUpMs: 5, vtOk: false, seekOk: false, seekMs: null, kind: 'random' },
      },
    });
    await sleep(200);
    await page.evaluate(RESET_RECORDERS);
    await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.seek(8); });
    await sleep(2500);
    let rec = await page.evaluate(READ_RECORDERS);
    let diag = await frontDiag(page);
    const cssClip = built.byCard['probe-css']?.[0];
    const firstPath = rec.events.filter((e) => e.type === 'settled' && (e.clipIds ?? []).includes(cssClip));
    out.cases['追帧第一路'] = { clipId: cssClip, settled: firstPath, stage: diag.stage, preview: diag.preview };
    check(firstPath.length > 0, '第一路:settled 带上了那张卡的 clipId', rec.events);
    check(diag.stage && !diag.stage.settling.includes(cssClip), '第一路:追完之后 .pc-settling 摘掉了', diag.stage?.settling);
    check(diag.stage && !diag.stage.snapshots.includes(cssClip), '第一路:追完之后它不在 snapshots 里', diag.stage?.snapshots);

    /* ---- 第二路:vtOk = false 的重卡 → 整场景补跑后互换 ---- */
    await page.evaluate(SET_COSTS, {
      specs: {
        'probe-css': { stepMs: 1, catchUpMs: 5, vtOk: true, seekOk: true, seekMs: 1 },
        'probe-motion-js': { stepMs: 1, catchUpMs: 10, vtOk: false, seekOk: false, seekMs: null, capped: true },
      },
    });
    await sleep(200);
    const beforeFront = (await page.evaluate(() => window.__pcPreviewDiag()))?.frontId;
    await page.evaluate(RESET_RECORDERS);
    await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.seek(12); });
    await page.waitForFunction(() => (window.__pcEvents ?? []).some((e) => e.type === 'settled' && (e.clipIds ?? []).length === 0),
      { timeout: 60000, polling: 100 }).catch(() => {});
    await sleep(600);
    rec = await page.evaluate(READ_RECORDERS);
    diag = await frontDiag(page);
    const jsClip = built.byCard['probe-motion-js']?.[0];
    const swapped = rec.events.filter((e) => e.type === 'settled' && (e.clipIds ?? []).length === 0);
    out.cases['追帧第二路'] = { clipId: jsClip, beforeFront, afterFront: diag.preview?.frontId, settled: swapped, stage: diag.stage };
    check(swapped.length > 0, '第二路:互换之后新 front post 了 settled(clipIds 为空)', rec.events);
    check(diag.preview && diag.preview.frontId !== beforeFront, '第二路:两个 iframe 换了身份', { beforeFront, after: diag.preview?.frontId });
    check(diag.stage && diag.stage.snapshots.length === 0, '第二路:互换后快照平面全摘了', diag.stage?.snapshots);
    check(diag.stage && diag.stage.suppressed.length === 0 && diag.stage.settling.length === 0,
      '第二路:组件不在任何集合里', { suppressed: diag.stage?.suppressed, settling: diag.stage?.settling });

    /* ---- 连点时间轴 10 次:不触发任何重发,最后一次正常互换 ---- */
    await page.evaluate(RESET_RECORDERS);
    const front0 = (await page.evaluate(() => window.__pcPreviewDiag()))?.frontId;
    await page.evaluate(async () => {
      const { actions } = await import('/src/store/project.ts');
      for (let i = 0; i < 10; i++) actions.seek(13 + i * 0.4);
    });
    await page.waitForFunction(() => (window.__pcEvents ?? []).some((e) => e.type === 'settled' && (e.clipIds ?? []).length === 0),
      { timeout: 60000, polling: 100 }).catch(() => {});
    await sleep(800);
    rec = await page.evaluate(READ_RECORDERS);
    diag = await frontDiag(page);
    const swaps = rec.events.filter((e) => e.type === 'settled' && (e.clipIds ?? []).length === 0);
    out.cases['连点十次'] = { swaps: swaps.length, front0, front1: diag.preview?.frontId, errors: errors.length };
    check(swaps.length === 1, '连点时间轴 10 次只互换一次(前九次都被中止、没有重发)', swaps.length);
    check(diag.preview && diag.preview.frontId !== front0, '最后一次正常互换', { front0, front1: diag.preview?.frontId });
  }

  /* ============================================================ 4. K3(a′) seekOk 的直接定位 */
  if (wants('跳转')) {
    const built = await page.evaluate(BUILD, { fps: 30, duration: 60, cards: [{ id: 'probe-css', duration: 60 }] });
    await waitProbeIdle(page);
    const clipId = built.byCard['probe-css'][0];
    // seekOk 且 seekMs ≤ B(30 fps 时 B = 23.3 ms)→ (a′) 直接定位,不进预渲染集合
    const plan = await page.evaluate(SET_COSTS, {
      specs: { 'probe-css': { stepMs: 2, catchUpMs: 3000, vtOk: true, seekOk: true, seekMs: 3 } },
    });
    check((plan.prerenderSet ?? []).length === 0, '(a′) 的卡不出现在 prerenderSet 里', plan.prerenderSet);
    await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.seek(1); });
    await sleep(500);
    const before = await frontDiag(page);
    const genOf = (d, id) => (d?.stage?.remountGen ?? []).find((e) => e[0] === id)?.[1] ?? 0;
    const gen0 = genOf(before, clipId);
    // 向前跳到第 50 秒:一步到位,**不重挂载**
    const t0 = Date.now();
    await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.seek(50); });
    await sleep(500);
    const mid = await frontDiag(page);
    const forwardMs = Date.now() - t0;
    check(genOf(mid, clipId) === gen0, '(a′) 向前跳不重挂载', { gen0, gen1: genOf(mid, clipId) });
    check(Math.abs((mid.stage?.t ?? 0) - 50) < 1e-6, '(a′) 向前跳一步到位', mid.stage?.t);
    // 从第 55 秒拖回第 20 秒:**重挂载一次**之后一步到位
    await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.seek(55); });
    await sleep(400);
    const at55 = await frontDiag(page);
    const gen55 = genOf(at55, clipId);
    await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.seek(20); });
    await sleep(500);
    const back = await frontDiag(page);
    out.cases['跳转'] = { clipId, gen0, gen50: genOf(mid, clipId), gen55, gen20: genOf(back, clipId), forwardMs, prerenderSet: plan.prerenderSet };
    check(genOf(back, clipId) === gen55 + 1, '(a′) 向后跳恰好重挂载一次', { gen55, gen20: genOf(back, clipId) });
    check(Math.abs((back.stage?.t ?? 0) - 20) < 1e-6, '(a′) 向后跳之后一步到位', back.stage?.t);
    check((back.stage?.settling ?? []).length === 0, '(a′) 不留在追帧态', back.stage?.settling);
  }

  /* ====================================== 4b. 时间轴点击 / 拖动松开后精确活渲(pinned 架构 9) */
  if (wants('时间轴')) {
    /*
     * 这一条量的是**真的鼠标**,不是 `actions.seek()` —— R5-16 的缺口正在这里:
     * 松手坐标通常等于最后一次 flush 的位置(`t` 没变),在标尺上点一下时
     * `seek` 和 `beginScrub` 又在同一个 React 事件里批成一次渲染(那一刻
     * `scrubbing` 已经是 true)。两种情况下如果 `scrubbing` 不进 `setTime` 的去重键,
     * 那条 `settle: true` 就永远补不上,判重卡停在快照上。
     *
     * 判据用 K5 第一路的 `settled`:只有收到 `setTime(t, { settle: true })` 才会起跑。
     */
    const built = await page.evaluate(BUILD, { fps: 30, duration: 30, cards: [{ id: 'probe-css', duration: 30 }] });
    await waitProbeIdle(page);
    const cssClip = built.byCard['probe-css'][0];
    await page.evaluate(SET_COSTS, {
      specs: { 'probe-css': { stepMs: 1, catchUpMs: 10, vtOk: true, seekOk: false, seekMs: null, capped: true } },
    });
    await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.seek(1); });
    await sleep(800);
    /*
     * 这台机器上没装 Claude Code / agy / codex 时,AI 面板会自动弹出设置对话框,
     * 它的 `.ais-backdrop` 盖住整页 —— 不关掉的话鼠标一个字都落不到时间轴上
     * (`elementFromPoint` 命中的是遮罩)。按 Esc 关,最多三次。
     */
    for (let i = 0; i < 3; i++) {
      if (!(await page.evaluate(() => !!document.querySelector('.ais-backdrop, .pc-dialog-mask')))) break;
      await page.keyboard.press('Escape');
      await sleep(300);
    }
    const ruler = await page.$('[data-pc="ruler"]');
    const box = ruler ? await ruler.boundingBox() : null;
    check(!!box, '时间轴标尺在页面上', box);
    if (box) {
      // 点击点真的落在标尺上(而不是某个遮罩上)——不验这一条的话下面两条会以「没发 settle」的面目失败
      const hit = await page.evaluate(([px, py]) => {
        const el = document.elementFromPoint(px, py);
        return { tag: el ? `${el.tagName}.${el.className}`.slice(0, 80) : null, onRuler: !!el?.closest('[data-pc="ruler"]') };
      }, [xAt(box, 0.25), box.y + box.height / 2]);
      out.cases['时间轴点击命中'] = hit;
      check(hit.onRuler, '点击点落在时间轴标尺上(没有遮罩挡着)', hit);
    }
    const waitSettled = (id) => page.waitForFunction(
      (clip) => (window.__pcEvents ?? []).some((e) => e.type === 'settled' && (e.clipIds ?? []).includes(clip)),
      { timeout: 30000, polling: 50 }, id).then(() => true, () => false);
    if (box) {
      const y = box.y + box.height / 2;

      /* ---- ① 在标尺上点一下 ---- */
      await page.evaluate(RESET_RECORDERS);
      const beforeClick = await page.evaluate(async () => (await import('/src/store/project.ts')).getState().t);
      await page.mouse.move(xAt(box, 0.25), y);
      await page.mouse.down();
      await page.mouse.up();
      const clickSettled = await waitSettled(cssClip);
      const afterClick = await page.evaluate(async () => (await import('/src/store/project.ts')).getState().t);

      /* ---- ② 按住拖一段再松手 ---- */
      await page.evaluate(RESET_RECORDERS);
      await page.mouse.move(xAt(box, 0.45), y);
      await page.mouse.down();
      for (const f of [0.55, 0.65, 0.75, 0.85]) {
        await page.mouse.move(xAt(box, f), y);
        await sleep(60);
      }
      await sleep(200);           // 让最后一次 flush 把 t 交出去:松手坐标因此和 store.t 相同
      await page.mouse.up();
      const dragSettled = await waitSettled(cssClip);
      const afterDrag = await page.evaluate(async () => (await import('/src/store/project.ts')).getState().t);
      const diag = await frontDiag(page);

      out.cases['时间轴'] = { clipId: cssClip, beforeClick, afterClick, afterDrag, clickSettled, dragSettled, stage: diag.stage };
      check(Math.abs(afterClick - beforeClick) > 1e-6, '点标尺把播放头挪走了', { beforeClick, afterClick });
      check(clickSettled, '点时间轴之后 settled 到达(判重卡追成精确活渲)', out.cases['时间轴']);
      check(dragSettled, '拖动松开之后 settled 到达', out.cases['时间轴']);
      check(diag.stage && !diag.stage.settling.includes(cssClip), '松手之后 .pc-settling 摘掉了', diag.stage?.settling);
      check(diag.stage && !diag.stage.snapshots.includes(cssClip), '松手之后它不在 snapshots 里', diag.stage?.snapshots);
    }
  }

  /* ============================================================ 5. K6 降级 */
  if (wants('降级')) {
    const built = await page.evaluate(BUILD, {
      fps: 30, duration: 20,
      cards: [{ id: 'probe-slow', duration: 20, params: { burnMs: 60, label: 'K6' } }, { id: 'probe-css', duration: 20 }],
    });
    await waitProbeIdle(page);
    const slowClip = built.byCard['probe-slow'][0];
    // 两张都判轻:probe-slow 的**探针成绩**写得很便宜,实测却要 60 ms —— K6 要抓的正是这种
    await page.evaluate(SET_COSTS, {
      specs: {
        'probe-slow': { stepMs: 1, catchUpMs: 0, kind: 'random', vtOk: true, seekOk: true, seekMs: 1 },
        'probe-css': { stepMs: 1, catchUpMs: 5, vtOk: true, seekOk: true, seekMs: 1 },
      },
    });
    await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.seek(0); });
    await sleep(400);
    await page.evaluate(RESET_RECORDERS);
    await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.play(); });
    await page.waitForFunction(() => (window.__pcEvents ?? []).some((e) => e.type === 'demote'), { timeout: 30000, polling: 50 }).catch(() => {});
    await sleep(1500);
    await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.pause(); });
    await sleep(600);
    const rec = await page.evaluate(READ_RECORDERS);
    const demote = rec.events.filter((e) => e.type === 'demote');
    const gaps = [];
    for (let i = 1; i < rec.frames.length; i++) gaps.push(rec.frames[i].at - rec.frames[i - 1].at);
    // 只看**这一份项目**的那几条:同一台 dev server 上跑过别的用例时 costs 里还留着旧记录
    const keysNow = await page.evaluate(async () => {
      const { getState } = await import('/src/store/project.ts');
      const { clipIdentityOf } = await import('/src/editor/costIdentity.ts');
      return Object.values(clipIdentityOf(getState().project).identityKeys);
    });
    const costs = await page.evaluate(async () => (await (await fetch('/api/data/costs')).json()));
    const demotedRecords = (costs?.costs ?? []).filter((r) => r.demoted === true && keysNow.includes(r.identityKey));
    const diag = await frontDiag(page);
    out.cases['降级'] = {
      slowClip, demote, beatGap: stats(gaps), demotedRecords: demotedRecords.map((r) => ({ identityKey: r.identityKey, capped: r.capped, demoted: r.demoted, stepMs: r.stepMs })),
      preview: diag.preview, stagePendingDemote: diag.stage?.pendingDemote,
      secDiffWrong: rec.frames.slice(1).filter((f, i) => Math.abs(f.sec - rec.frames[i].sec - 1 / 30) > 1e-6).length,
    };
    check(demote.length > 0, 'K6:人为把一张卡的成本拉到 60 ms 之后触发了 demote', demote);
    check(demote[0]?.clipId === slowClip, 'K6:降的是最贵的那张(probe-slow)', { got: demote[0]?.clipId, want: slowClip });
    check(demotedRecords.length === 1, 'K6:costs 里恰好一条 demoted: true', demotedRecords.length);
    check(demotedRecords[0]?.capped === true && demotedRecords[0]?.demoted === true,
      'K6:整条 PUT —— capped 和 demoted 都写上了,各测量值还在', demotedRecords[0]);
    check(out.cases['降级'].secDiffWrong === 0, 'K6:慢帧不跳帧(sec 差恒为 1/fps)', out.cases['降级'].secDiffWrong);
    check((diag.preview?.pendingDemote ?? []).includes(slowClip),
      'K6:死素材没就绪之前它留在 pendingDemote、照常活渲', diag.preview?.pendingDemote);
    // 落盘的那一份
    if (!originArg && fs.existsSync(costsFile)) {
      const onDisk = JSON.parse(fs.readFileSync(costsFile, 'utf8'));
      const list = Array.isArray(onDisk) ? onDisk : (onDisk.records ?? onDisk.costs ?? []);
      out.cases['降级'].onDisk = list.filter((r) => r.demoted === true && keysNow.includes(r.identityKey)).length;
      check(out.cases['降级'].onDisk === 1, 'K6:out/card-costs.json 里那条 demoted: true 落盘了', out.cases['降级'].onDisk);
    }
  }

  /*
   * 没有预渲染进程时 `/api/frames/*`(就绪索引的 SSE、快照字节)一律 503 —— 那是**设计好的**
   * 退路(F5 / 总规则:预渲染进程不可用时舞台照常,重卡层透明),不算页面报错。
   * 真的 JS 异常不带 "Failed to load resource"。
   */
  const benign = (m) => /Failed to load resource/.test(m);
  out.errors = errors.filter((m) => !benign(m)).slice(0, 20);
  out.resourceErrors = errors.filter(benign).length;
  check(out.errors.length === 0, '页面没有 JS 报错', out.errors.slice(0, 5));
} catch (err) {
  fails.push('探针自己抛了:' + (err?.stack || String(err)));
  exitCode = 1;
} finally {
  out.fails = fails;
  out.ok = fails.length === 0;
  if (outJson) {
    fs.mkdirSync(path.dirname(path.resolve(outJson)), { recursive: true });
    fs.writeFileSync(path.resolve(outJson), JSON.stringify(out, null, 2));
  }
  console.log(JSON.stringify(out, null, 2));
  try { await browser.close(); } catch { /* 已经关了 */ }
  await stopServer();
  if (!keep) { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 删不掉就留着 */ } }
  else console.log('临时数据目录留着:' + dataDir);
}
process.exit(fails.length ? 1 : exitCode);
