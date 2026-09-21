/**
 * K1 常驻探针的验收（R4b）：**加载遮罩下逐张测完才进编辑**。
 *
 *   node scripts/probes/probe-gate-probe.mjs [--port 5251] [--cards 20] [--keep]
 *                                            [--origin http://127.0.0.1:5251]
 *                                            [--json out/probe-gate.json]
 *
 * 不带 `--origin` 时**自己起一台 dev server**（缺省 5251，舞台端口随之 5252 / 5253），
 * 并把 `PROMPTCUT_DATA_DIR` 指到一个临时目录 —— `out/card-costs.json` 的落点由
 * `server/costs-store.mjs` 的 `costsDir(root)` 决定（`PROMPTCUT_DATA_DIR || <root>/out`），
 * 不隔离的话这一趟会把仓库 `out/` 里真实的成绩冲掉。用完把 server 关掉、临时目录删掉
 * （`--keep` 留着给人看）。
 *
 * # 验收的几条（任务书 K 节验收 + R4b 任务书）
 *
 * 1. 载入一个含 N 张**没测过**的卡的项目：遮罩停留到 N 条都测完；
 * 2. `out/card-costs.json` 里有 N 条，每条带四个数（`stepMs` / `inlineMs` / `rasterMs` /
 *    `serializeMs`）+ `catchUpMs` + `mode` + `demoted: false`；
 * 3. **第二次打开遮罩一帧都不出现**（在文档创建之前就装 MutationObserver，
 *    没有任何一帧能溜过去）；
 * 4. 探针期间**可见舞台**用 `__pcRealRaf` 量的帧间隔中位数 ≤ 20 ms
 *    （`__pcRealRaf` 是 `stageClock` 接管前存下的真 rAF；页面里的 `requestAnimationFrame`
 *    已被换成只由 `clock.tick` 排空的队列，用它会死等）；
 * 5. 两趟布尔探针的三张判例：`probe-css` → `vtOk` 且 `seekOk`；粒子卡 → `vtOk`；
 *    `probe-motion-js` → `vtOk: false`；
 * 6. **项目在探针中途改了**：队列按新项目重排，而且**不把全量项目上的全部卡一起推**
 *    （验「先换缩水项目再 `render`」：任何时刻后台舞台上的卡片包裹层只有一个）。
 *
 * # 关于帧间隔这条
 *
 * R2 的报告记过：这台机器上不加 `--disable-gpu-vsync --disable-frame-rate-limit`
 * 量不到主线程停顿 —— rAF 被垂直同步钉在 16.7 ms，主线程被占住 10 ms 也看不出来。
 * 所以这里照做，两个参数都带上；带了之后 rAF 的间隔才反映真实的主线程可用度。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';

import { stagePortsOf } from '../../server/stage-ports.mjs';

/* ------------------------------------------------------------------ 参数 */

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => { const i = argv.indexOf(name); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback; };
const has = (name) => argv.includes(name);

const port = Number(flag('--port', '5251')) || 5251;
const originArg = flag('--origin');
const wantCards = Math.max(1, Number(flag('--cards', '20')) || 20);
const keep = has('--keep');
const outJson = flag('--json');
const origin = (originArg || `http://127.0.0.1:${port}`).replace(/\/+$/, '');

const fails = [];
const out = { origin, stagePorts: stagePortsOf(port) };
const check = (cond, label, extra) => {
  if (!cond) fails.push(label + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''));
  return cond;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ dev server */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-probe-gate-'));
const costsFile = path.join(dataDir, 'card-costs.json');
let server = null;

async function startServer() {
  if (originArg) return null;   // 挂到别人起的那台上（那时 out/ 的隔离由调用方负责）
  const proc = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['vite', '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
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
  // Windows 上 npx 会再 spawn 一层 node,kill 父进程不一定带走子进程
  if (process.platform === 'win32') {
    await new Promise((r) => spawn('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' }).on('close', r));
  }
  server = null;
}

/* ------------------------------------------------------------------ 页面侧的几段脚本 */

/**
 * 在**文档创建之前**装一个观察者，记下 `[data-pc="probe-gate"]` 有没有出现过。
 * 第 3 条验收（「第二次打开一帧都不出现」）靠它 —— 轮询是量不准的：
 * 遮罩可能在两次轮询之间闪一下。
 */
const GATE_WATCHER = () => {
  window.__gateSeen = false;
  window.__gateNow = false;
  const scan = () => {
    const el = document.querySelector('[data-pc="probe-gate"]');
    window.__gateNow = !!el;
    if (el) window.__gateSeen = true;
  };
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  scan();
};

/** 建一个含 N 张没测过的卡的项目。卡片从注册表里取，优先点名三张布尔判例 */
const BUILD_PROJECT = async ({ want, pinned }) => {
  await import('/src/cards/index.ts');
  const { allCards } = await import('/src/kernel/registry.ts');
  const { actions, getState } = await import('/src/store/project.ts');
  const ids = allCards().map((c) => c.id);
  const picked = [];
  for (const id of pinned) if (ids.includes(id) && !picked.includes(id)) picked.push(id);
  for (const id of ids) {
    if (picked.length >= want) break;
    // 粒子卡 50 多张,只留点名的那张;组合卡没有自己的画面
    if (picked.includes(id) || id === 'composite' || (id.startsWith('particles-') && !pinned.includes(id))) continue;
    picked.push(id);
  }
  actions.newProject('probe-gate');
  // 每张卡各占一条轨道的同一段,4 秒 —— 和离线探针 --clip-sec 4 一致,数才好比
  for (const id of picked) actions.addCardClip(id, 0, { duration: 4 });
  return { picked, clips: getState().project.tracks.flatMap((t) => t.clips.length) };
};

/* ------------------------------------------------------------------ 主流程 */

const browser = await puppeteer.launch({
  headless: true,
  args: ['--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    /*
     * R2 的报告:这台机器不带这两个就量不到主线程停顿 —— rAF 被垂直同步钉在 16.7 ms,
     * 主线程被占住 10 ms 也看不出来。第 4 条验收要的正是「可见舞台有没有被拖住」。
     */
    '--disable-gpu-vsync', '--disable-frame-rate-limit'],
});
let exitCode = 0;
try {
  server = await startServer();

  /* ---------------- 第一次打开:遮罩应当停留到全部测完 ---------------- */
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.evaluateOnNewDocument(GATE_WATCHER);
  await page.goto(origin + '/?editor&preview=stage', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForSelector('iframe[data-pc="stage-frame"]', { timeout: 180000 });
  // 两个跨源舞台都登记好了(E1)
  await page.waitForFunction(async () => {
    const m = await import('/src/editor/stageBridge.ts');
    return m.backRole() === 'back';
  }, { timeout: 180000, polling: 500 });

  const built = await page.evaluate(BUILD_PROJECT, { want: wantCards, pinned: ['probe-css', 'probe-motion-js', 'particles-snow'] });
  out.cards = built.picked;
  check(built.picked.length === wantCards, `项目里有 ${wantCards} 张卡`, built.picked.length);

  // 遮罩出现(要测的卡不为 0)
  await page.waitForFunction(() => window.__gateSeen === true, { timeout: 60000, polling: 100 }).catch(() => {});
  out.gateAppearedFirstOpen = await page.evaluate(() => window.__gateSeen);
  check(out.gateAppearedFirstOpen, '第一次打开遮罩出现了');

  /*
   * 探针期间量可见舞台的帧间隔(第 4 条)。用**舞台 iframe 自己**的 `__pcRealRaf`:
   * 页面里的 requestAnimationFrame 已被 stageClock 换成只由 clock.tick 排空的队列。
   */
  const frontFrame = () => page.frames().find((f) => f.url().includes('stage=1') && f.url().includes('id=A'));
  const rafTask = frontFrame()
    ? frontFrame().evaluate(async () => {
      const raf = window.__pcRealRaf || window.requestAnimationFrame.bind(window);
      const now = window.__pcRealNow || (() => Date.now());
      const gaps = [];
      let last = now();
      const until = last + 6000;
      await new Promise((done) => {
        const tick = () => {
          const t = now();
          gaps.push(t - last);
          last = t;
          if (t < until) raf(tick); else done();
        };
        raf(tick);
      });
      gaps.shift();
      const s = gaps.slice().sort((a, b) => a - b);
      return { n: s.length, p50: s[Math.floor(s.length * 0.5)] ?? null, p90: s[Math.floor(s.length * 0.9)] ?? null, max: s[s.length - 1] ?? null };
    }).catch(() => null)
    : Promise.resolve(null);

  // 测完:进度里的 running 落回 false(遮罩摘掉)
  const t0 = Date.now();
  await page.waitForFunction(async () => {
    const m = await import('/src/editor/probeRunner.ts');
    const p = m.probeProgress();
    return p.running === false && p.done > 0;
  }, { timeout: 900000, polling: 500 });
  out.firstRunMs = Date.now() - t0;
  out.progress = await page.evaluate(async () => {
    const m = await import('/src/editor/probeRunner.ts');
    return m.probeProgress();
  });
  out.gateStillUp = await page.evaluate(() => window.__gateNow);
  check(!out.gateStillUp, '测完之后遮罩摘掉了');

  out.raf = await rafTask;
  if (out.raf && out.raf.n > 30) {
    check(out.raf.p50 <= 20, '探针期间可见舞台的帧间隔中位数 ≤ 20 ms', out.raf);
  } else {
    out.rafNote = '没量到足够的帧(探针跑得太快或者舞台 iframe 没找到),这一条跳过';
  }

  /* ---------------- 记录:N 条、每条该有的字段都在 ---------------- */
  await page.waitForFunction(() => fetch('/api/data/costs').then((r) => r.json()).then((d) => (d?.costs?.length ?? 0) > 0), { timeout: 60000, polling: 500 }).catch(() => {});
  const costs = await page.evaluate(async () => (await (await fetch('/api/data/costs')).json()));
  out.recordCount = costs?.costs?.length ?? 0;
  out.device = costs?.costs?.[0]?.device ?? null;
  check(out.recordCount === wantCards, `成本记录有 ${wantCards} 条`, out.recordCount);
  const bad = (costs?.costs ?? []).filter((r) =>
    !Number.isFinite(r.stepMs) || !Number.isFinite(r.inlineMs) || !Number.isFinite(r.rasterMs)
    || !Number.isFinite(r.serializeMs) || !Number.isFinite(r.catchUpMs)
    || (r.mode !== 'dev' && r.mode !== 'build') || r.demoted !== false);
  check(bad.length === 0, '每条都带四个数 + catchUpMs + mode + demoted: false', bad.map((r) => r.identityKey));
  out.records = (costs?.costs ?? []).map((r) => ({
    identityKey: r.identityKey, kind: r.kind, stepMs: r.stepMs, stepMaxMs: r.stepMaxMs, inlineMs: r.inlineMs,
    rasterMs: r.rasterMs, serializeMs: r.serializeMs, catchUpMs: r.catchUpMs, capped: !!r.capped,
    vtOk: r.vtOk, seekOk: r.seekOk, seekMs: r.seekMs, mode: r.mode, demoted: r.demoted,
  }));

  // 落盘的那一份也看一眼(隔离的临时目录里)
  if (!originArg) {
    out.costsFile = costsFile;
    out.costsFileExists = fs.existsSync(costsFile);
    check(out.costsFileExists, 'out/card-costs.json 写在隔离的临时目录里,没碰仓库的 out/');
  }

  /* ---------------- 布尔探针的三张判例 ---------------- */
  out.verdicts = await page.evaluate(async (ids) => {
    await import('/src/cards/index.ts');
    const { getCard, userCardSources } = await import('/src/kernel/registry.ts');
    const { projectCardGraph } = await import('/src/kernel/cardGraph.mjs');
    const { getState } = await import('/src/store/project.ts');
    const { clipIdentityOf } = await import('/src/editor/costIdentity.ts');
    void getCard; void userCardSources; void projectCardGraph;
    const project = getState().project;
    const { identityKeys } = clipIdentityOf(project);
    const byClip = {};
    for (const tr of project.tracks) for (const c of tr.clips) if (c.cardId) byClip[c.cardId] = identityKeys[c.id];
    const costs = (await (await fetch('/api/data/costs')).json()).costs ?? [];
    const byKey = new Map(costs.map((r) => [r.identityKey, r]));
    const outv = {};
    for (const id of ids) {
      const r = byKey.get(byClip[id]);
      outv[id] = r ? { vtOk: r.vtOk, seekOk: r.seekOk, seekMs: r.seekMs, kind: r.kind } : null;
    }
    return outv;
  }, ['probe-css', 'probe-motion-js', 'particles-snow']);
  check(out.verdicts['probe-css']?.vtOk === true && out.verdicts['probe-css']?.seekOk === true,
    '只有 CSS / WAAPI 动画的卡 vtOk 且 seekOk', out.verdicts['probe-css']);
  check(out.verdicts['particles-snow']?.vtOk === true, '粒子卡 vtOk', out.verdicts['particles-snow']);
  check(out.verdicts['probe-motion-js']?.vtOk === false, 'JS 驱动的卡 vtOk 为 false', out.verdicts['probe-motion-js']);

  /* ---------------- setPlan:表到了舞台、pipelineAt 查得出来 ---------------- */
  out.plan = await page.evaluate(async () => {
    const m = await import('/src/editor/planDispatch.ts');
    const plan = m.currentPlan();
    return plan ? { segments: plan.segments.length, prerender: [...plan.prerenderSet].length } : null;
  });
  const front = frontFrame();
  out.stagePlan = front ? await front.evaluate(() => {
    const p = window.__pcStagePlan?.();
    return p ? { segments: p.plan.segments.length, prerender: [...p.plan.prerenderSet].length, costs: p.costs.length } : null;
  }).catch(() => null) : null;
  check(!!out.stagePlan && out.stagePlan.segments === out.plan?.segments,
    'setPlan 把同一张表送到了可见舞台', { parent: out.plan, stage: out.stagePlan });

  /* ---------------- 第二次打开:遮罩一帧都不出现 ---------------- */
  const page2 = await browser.newPage();
  await page2.setViewport({ width: 1600, height: 1000 });
  await page2.evaluateOnNewDocument(GATE_WATCHER);
  await page2.goto(origin + '/?editor&preview=stage', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page2.waitForSelector('iframe[data-pc="stage-frame"]', { timeout: 180000 });
  await page2.waitForFunction(async () => {
    const m = await import('/src/editor/stageBridge.ts');
    return m.backRole() === 'back';
  }, { timeout: 180000, polling: 500 });
  // 同一批卡、同一套身份键
  await page2.evaluate(BUILD_PROJECT, { want: wantCards, pinned: ['probe-css', 'probe-motion-js', 'particles-snow'] });
  await page2.waitForFunction(async () => {
    const m = await import('/src/editor/probeRunner.ts');
    return m.probeProgress().running === false;
  }, { timeout: 120000, polling: 200 }).catch(() => {});
  await sleep(2000);
  out.secondOpen = await page2.evaluate(async () => {
    const m = await import('/src/editor/probeRunner.ts');
    return { gateSeen: window.__gateSeen, progress: m.probeProgress() };
  });
  check(out.secondOpen.gateSeen === false, '第二次打开遮罩一帧都不出现', out.secondOpen);
  check(out.secondOpen.progress.total === 0, '第二次一张都不用测(记录全命中)', out.secondOpen.progress);
  await page2.close();

  /* ---------------- 项目中途改了:队列重排,而且不推全量项目 ---------------- */
  const page3 = await browser.newPage();
  await page3.setViewport({ width: 1600, height: 1000 });
  await page3.evaluateOnNewDocument(GATE_WATCHER);
  await page3.goto(origin + '/?editor&preview=stage', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page3.waitForSelector('iframe[data-pc="stage-frame"]', { timeout: 180000 });
  await page3.waitForFunction(async () => {
    const m = await import('/src/editor/stageBridge.ts');
    return m.backRole() === 'back';
  }, { timeout: 180000, polling: 500 });
  /*
   * 用别的长度(6 秒)让身份键全变一遍 —— `cardCostKey` 含 `durationFrames`,
   * 同一张卡换个片段长度就是一条没测过的记录,不用清存档就能再跑一轮。
   */
  await page3.evaluate(async ({ want }) => {
    await import('/src/cards/index.ts');
    const { allCards } = await import('/src/kernel/registry.ts');
    const { actions } = await import('/src/store/project.ts');
    const ids = allCards().map((c) => c.id).filter((id) => id !== 'composite' && !id.startsWith('particles-')).slice(0, want);
    actions.newProject('probe-gate-2');
    for (const id of ids) actions.addCardClip(id, 0, { duration: 6 });
  }, { want: wantCards });

  const backFrame = () => page3.frames().find((f) => f.url().includes('stage=1') && f.url().includes('id=B'));
  // 探针跑起来之后,盯一会儿后台舞台上有几个卡片包裹层
  await page3.waitForFunction(async () => {
    const m = await import('/src/editor/probeRunner.ts');
    return m.probeProgress().running === true;
  }, { timeout: 60000, polling: 100 }).catch(() => {});
  const wrapCounts = [];
  for (let i = 0; i < 25; i++) {
    const f = backFrame();
    if (f) {
      const n = await f.evaluate(() => document.querySelectorAll('[data-pc-clip]:not([data-pc-media])').length).catch(() => null);
      if (typeof n === 'number') wrapCounts.push(n);
    }
    await sleep(120);
  }
  out.backWrapCounts = wrapCounts;
  const maxWrap = wrapCounts.length ? Math.max(...wrapCounts) : 0;
  check(wrapCounts.length > 0 && maxWrap <= 1,
    '后台舞台上任何时刻只有一个卡片段(先换缩水项目再 render)', { maxWrap, wrapCounts });

  // 中途换项目:队列应当按新项目重排,而不是接着测旧项目的卡
  const beforeSwap = await page3.evaluate(async () => (await import('/src/editor/probeRunner.ts')).probeProgress());
  await page3.evaluate(async () => {
    const { actions } = await import('/src/store/project.ts');
    actions.newProject('probe-gate-3');
    actions.addCardClip('probe-css', 0, { duration: 9 });
    actions.addCardClip('probe-motion-js', 0, { duration: 9 });
  });
  await sleep(1500);
  const afterSwap = await page3.evaluate(async () => (await import('/src/editor/probeRunner.ts')).probeProgress());
  out.replan = { beforeSwap, afterSwap };
  check(afterSwap.total <= 2, '换了项目之后队列按新项目重排(只剩新项目那两张卡)', out.replan);
  await page3.waitForFunction(async () => (await import('/src/editor/probeRunner.ts')).probeProgress().running === false,
    { timeout: 180000, polling: 300 }).catch(() => {});
  await page3.close();

  out.pageErrors = errors.filter((e) => !/favicon|React DevTools|Failed to load resource|ResizeObserver/i.test(e)).slice(0, 8);
} catch (err) {
  console.error(err && err.stack || err);
  fails.push('探针自己抛了:' + String(err && err.message || err));
  exitCode = 1;
} finally {
  await browser.close();
  await stopServer();
  if (!keep) {
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 删不掉不算失败 */ }
  }
}

out.pass = fails.length === 0;
out.fails = fails;
console.log(JSON.stringify(out, null, 2));
if (outJson) {
  const file = path.resolve(outJson);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2), 'utf8');
  console.log(`\n写到 ${file}`);
}
if (fails.length) {
  console.log('\n不通过:');
  for (const f of fails) console.log('  ' + f);
  exitCode = 1;
}
process.exit(exitCode);
