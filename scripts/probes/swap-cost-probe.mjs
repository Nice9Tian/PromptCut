/**
 * `SWAP_MS` 按卡种实测(swap-tuning 任务 A;`src/render/beatSwap.mjs`、`docs/semantics/mechanism/rendering.md`「兜底顺序」):
 * 在线普通档播放时,重层每拍换一次 HTML 快照。这里量「换一层快照」在可见舞台主线程上的实际代价。
 *
 *   node scripts/probes/swap-cost-probe.mjs --origin http://127.0.0.1:5700
 *        [--cards a,b,…]   只量这几张(缺省按卡种各取几张,见 DEFAULT_SET)
 *        [--all]           注册表里的全部卡(去掉探针卡、r6 测试卡与要参数才能画的通用卡 lottie / particles / composite),
 *                          粒子卡只取前 --particles 张(缺省 6)
 *        [--frames 24]     每张卡生成多少帧不同的快照(轮流换)
 *        [--batches 5]     换帧、空换各跑几批(交替),每批把 frames 帧换一遍
 *        [--via direct|rpc] direct(缺省):直接调舞台的 setSnapshots 实现;rpc:经 postMessage 投递(另含结构化克隆,
 *                          宿主与舞台同进程,两头的克隆都算进去,比真实的跨进程舞台偏大)
 *        [--params <json>] 每张卡的参数(缺省卡的默认参数),例如 --cards probe-slow-stepped --params '{"padNodes":400}'
 *        [--json <file>]   结果另写一份 JSON
 *
 * # 做法
 *
 * 宿主页(探针拦截一个路径现给)里开两个同源舞台 iframe:
 *   - **B**(`?stage=1&id=B&prerender=1`,`setRole('back', { job: 'probe' })`):每张卡单独一条轨道,推到 frames 个不同时刻
 *     各生成一次快照,取 `window.__pcCreateSnapshot().controls[0].html`(与预渲染投递的那份同形:差异样式已内联、画布已栅格成 `<img>`);
 *   - **A**(`?stage=1&id=A&preview=stage&dual=1`,舞台的 live 变体(`FrameScene`,平面 prop 生效),`setRole('front')`,1920×1080 可见):同一张卡,`setSuppressed([片段])` 当重层,
 *     然后逐帧 `window.__pcStage.setSnapshots({ 片段: 第 i 帧 })` —— 与播放中父页每拍投递的是同一个 RPC、同一条
 *     `Stage` 提交路径(快照平面 `dangerouslySetInnerHTML`、`renameSnapshotIds`)。
 *
 * 每换一次:
 *   1. `commitMs`:`setSnapshots` 的同步部分(非播放时它当场 `flushSync` 提交;播放中这一次提交并进下一拍的 `flushSync(setT)`);
 *   2. `layoutMs`:紧接着强制样式与布局(读快照平面的 `getBoundingClientRect` 与 `document.body.offsetHeight`);
 *   3. 再等两次真 rAF,让这一帧画出来(绘制记录也在主线程)。
 * 同样的循环再跑一遍「空换」(把当前那一帧原样再投一次:`Stage` 看到同一个 `__html` 不动 DOM,但 `commitPlanes` 的
 * React 提交与占位刷新照样走),两者**交替**成批跑。每批前后读 CDP `Performance.getMetrics` 的 `TaskDuration`
 * (渲染进程主线程的任务总时长;两个舞台与宿主同源,同一个渲染进程),
 *
 *   swapMs = (换帧批的 ΔTaskDuration − 空换批的 ΔTaskDuration) / 每批帧数
 *
 * 取各批的中位数。它就是「每多换一层,这一拍主线程多干多少」,含解析、改名、样式、布局、绘制记录;
 * 不含光栅化与图片解码(在光栅线程,不占一拍的主线程预算)。另报 `commitMs + layoutMs` 的中位数与 p90 作对照。
 *
 * 跑在 dev 模式的 dev server 上:React 是开发版,但「空换」同样付那一份 React 提交,相减后基本抵掉;
 * 解析、样式、布局、绘制是浏览器原生代码,dev 与产物包一样。机器忙时数会偏大,报告里写明当时机器忙不忙。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { devOrigin, flagArg } from './probe-connect.mjs';

const argv = process.argv.slice(2);
const origin = devOrigin(argv);
const FRAMES = Math.max(4, Number(flagArg('frames', '24', argv)) || 24);
const BATCHES = Math.max(3, Number(flagArg('batches', '5', argv)) || 5);
const cardsArg = flagArg('cards', null, argv);
const jsonOut = flagArg('json', null, argv);
const VIA = flagArg('via', 'direct', argv) === 'rpc' ? 'rpc' : 'direct';
const ALL = argv.includes('--all');
/** 给每张卡的参数(JSON),例如 `--params '{"padNodes":400}'`;缺省用卡的默认参数 */
const PARAMS = (() => { const v = flagArg('params', null, argv); try { return v ? JSON.parse(v) : {}; } catch { throw new Error(`--params 不是 JSON:${v}`); } })();
const PARTICLES = Math.max(0, Number(flagArg('particles', '6', argv)) || 0);
const FPS = 30;
const CLIP_SEC = 4;
const HOST_PATH = '/__swap-cost-probe-host';

/**
 * 缺省清单:按卡种各取几张。`kind` 是报告里的归类(与 `beatSwap.mjs` 的 `swapKindOf` 同口径);
 * 注册表里没有的(例如素材目录没装)自动跳过。lottie / particles 取目录里排在前面的两张。
 */
const DEFAULT_SET = [
  { id: 'mu-number-ticker', kind: 'dom' },
  { id: 'mu-typing', kind: 'dom' },
  { id: 'quote-lockup', kind: 'dom' },
  { id: 'versus-card', kind: 'dom' },
  { id: 'checklist', kind: 'dom' },
  { id: 'chapter-bar', kind: 'dom', note: 'hud-glass:backdrop-filter blur' },
  { id: 'stat-proof', kind: 'dom', note: 'hud-glass:backdrop-filter blur' },
  { id: 'punch-pill', kind: 'dom', note: 'filter: blur(32px)' },
  { id: 'blur-text', kind: 'dom', note: 'filter: blur' },
  { id: 'lottie-*', kind: 'lottie' },
  { id: 'scene-3d', kind: 'canvas' },
  { id: 'particles-*', kind: 'canvas' },
  { id: 'mu-animated-shiny-text', kind: 'user' },
];

const hostHtml = `<!doctype html><html><head><meta charset="utf-8"><title>swap cost probe host</title>
<script type="module">
try {
  const RefreshRuntime = await import('/@react-refresh');
  RefreshRuntime.injectIntoGlobalHook(window);
  window.$RefreshReg$ = () => {};
  window.$RefreshSig$ = () => (type) => type;
  window.__vite_plugin_react_preamble_installed__ = true;
} catch { /* 产物包:没有 react-refresh */ }
</script>
</head>
<body style="margin:0;background:#111">
<iframe id="a" src="/?stage=1&id=A&preview=stage&dual=1" style="position:absolute;left:0;top:0;width:1920px;height:1080px;border:0;display:block"></iframe>
<iframe id="b" src="/?stage=1&id=B&prerender=1" style="position:absolute;left:0;top:0;width:1920px;height:1080px;border:0;display:block;opacity:0;pointer-events:none"></iframe>
<script type="module">
function createStageRpc(target) {
  let nextId = 1; const pending = new Map();
  window.addEventListener('message', (e) => {
    if (e.source !== target) return; const d = e.data;
    if (d && d.type === 'pc-rpc-reply') { const p = pending.get(d.id); if (!p) return; pending.delete(d.id); d.ok ? p.resolve(d.result) : p.reject(new Error(d.error)); }
  });
  const call = (method) => (...args) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); target.postMessage({ type: 'pc-rpc', id, method, args }, location.origin); });
  const c = {};
  for (const m of ['setProject','setTime','render','setRole','setSuppressed','setSnapshots']) c[m] = call(m);
  return c;
}
const frames = { A: document.getElementById('a'), B: document.getElementById('b') };
const readyOf = (f) => new Promise((res, rej) => {
  setTimeout(() => rej(new Error('stage ready timeout')), 180000);
  window.addEventListener('message', (e) => {
    if (e.source !== f.contentWindow || e.data?.type !== 'pc-stage-ready') return;
    res(createStageRpc(f.contentWindow));
  });
});
window.__ready = Promise.all([readyOf(frames.A), readyOf(frames.B)]).then(([a, b]) => { window.__rpcA = a; window.__rpcB = b; return true; });

window.__kit = (async () => {
  await import('/src/cards/index.ts');
  const registry = await import('/src/kernel/registry.ts');
  const { cardFrameMode, reviewedCard } = await import('/src/kernel/frameMode.mjs');
  return { ...registry, cardFrameMode, reviewedCard };
})();
window.__knownIds = async () => (await window.__kit).allCards().map((c) => c.id);
window.__cardMeta = async (ids) => {
  const kit = await window.__kit;
  return ids.map((id) => { const def = kit.getCard(id); return def ? { id, source: def.source || 'native',
    mode: kit.cardFrameMode(def, def.defaults), canvasHeavy: !!kit.reviewedCard(id)?.canvasHeavy, glCanvas: !!(def.canvas && def.canvas.kind !== 'dom2d') } : { id, missing: true }; });
};
window.__mkProject = (cardId, fps, lenSec, params = {}) => ({
  version: 1, id: 'swap-probe', name: 'swap-probe', width: 1920, height: 1080, fps, duration: lenSec,
  themeId: 'midnight', media: [],
  tracks: [{ id: 'probe-track', clips: [{ id: 'c0', cardId, start: 0, end: lenSec, params }] }],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const raf = () => new Promise((r) => requestAnimationFrame(() => r()));

/** B 上生成 n 帧快照(canvas 卡等画布出现) */
window.__makeSnapshots = async (job) => {
  const rpc = window.__rpcB, w = frames.B.contentWindow;
  await rpc.setRole('back', { job: 'probe' });
  await rpc.setProject(window.__mkProject(job.cardId, job.fps, job.lenSec, job.params), { reset: true });
  await rpc.setTime(0);
  await sleep(200);
  if (job.canvas) {
    for (let i = 0; i < 100; i++) {
      const cv = w.document.querySelector('[data-pc-clip] canvas');
      if (cv && cv.width > 1) break;
      await sleep(50);
    }
    await sleep(200);
  }
  const out = [];
  const t0 = 0.3, t1 = job.lenSec - 0.2;
  for (let i = 0; i < job.n; i++) {
    const t = Math.round((t0 + (t1 - t0) * i / Math.max(1, job.n - 1)) * job.fps) / job.fps;
    if (job.mode === 'direct') await rpc.setTime(t);
    else if (i === 0) await rpc.render(t, { jump: true, maxCatchUp: Infinity });
    else await rpc.render(t, { maxCatchUp: Infinity });
    await sleep(job.canvas ? 60 : 0);
    const snap = w.__pcCreateSnapshot();
    const html = snap.controls[0]?.html ?? '';
    out.push(html);
  }
  return out;
};

/** A 上挂好这张卡、当重层,贴第 0 帧 */
window.__prepareFront = async (job) => {
  const rpc = window.__rpcA;
  await rpc.setRole('front');
  await rpc.setProject(window.__mkProject(job.cardId, job.fps, job.lenSec, job.params), { reset: true });
  await rpc.setTime(0.3);
  await rpc.setSuppressed(['c0']);
  window.__snaps = job.snaps;
  window.__cur = 0;
  await frames.A.contentWindow.__pcStage.setSnapshots({ c0: window.__snaps[0] });
  await raf(); await raf();
  await sleep(300);
  const w = frames.A.contentWindow;
  const plane = w.document.querySelector('[data-pc-clip="c0"] > [data-pc-snapshot-plane]');
  return { plane: !!plane, planeNodes: plane ? plane.getElementsByTagName('*').length : 0 };
};

/**
 * 一批:把 frames 帧挨个换一遍(swap = true),或者把当前那一帧原样再投 frames 次(swap = false,空换)。
 * 回每次的 commitMs / layoutMs。
 */
window.__batch = async (swap, via) => {
  const w = frames.A.contentWindow, stage = w.__pcStage, now = w.__pcRealNow || (() => performance.now());
  const out = [];
  const n = window.__snaps.length;
  for (let k = 0; k < n; k++) {
    if (swap) window.__cur = (window.__cur + 1) % n;
    const html = window.__snaps[window.__cur];
    const t0 = now();
    // direct:直接调舞台的 RPC 实现(只量舞台侧);rpc:经 postMessage(另含结构化克隆的序列化与反序列化,两头都在这个进程里)
    if (via === 'rpc') await window.__rpcA.setSnapshots({ c0: html });
    else await stage.setSnapshots({ c0: html });
    const t1 = now();
    const plane = w.document.querySelector('[data-pc-clip="c0"] > [data-pc-snapshot-plane]');
    plane?.getBoundingClientRect();
    void w.document.body.offsetHeight;
    const t2 = now();
    out.push({ commitMs: t1 - t0, layoutMs: t2 - t1 });
    await raf(); await raf();
  }
  return out;
};
</script></body></html>`;

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : NaN; };
const r2 = (x) => Math.round(x * 100) / 100;
/** 整机 CPU 的忙碌比例(量这张卡期间,所有逻辑核平均):报告里写「当时机器忙不忙」 */
const cpuTimes = () => os.cpus().reduce((acc, c) => { const t = c.times; acc.idle += t.idle; acc.total += t.user + t.nice + t.sys + t.irq + t.idle; return acc; }, { idle: 0, total: 0 });
const busySince = (a) => { const b = cpuTimes(); const total = b.total - a.total; return total > 0 ? Math.round((1 - (b.idle - a.idle) / total) * 100) : null; };
const kb = (n) => Math.round(n / 102.4) / 10;

const browser = await puppeteer.launch({
  headless: true,
  // 大快照(Lottie、画布)的生成与换帧一批可能要几十秒,机器忙时更久
  protocolTimeout: 600_000,
  args: ['--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
});
let exitCode = 0;
const results = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (new URL(req.url()).pathname === HOST_PATH) req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: hostHtml });
    else req.continue();
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(origin + HOST_PATH, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.evaluate(() => window.__ready);
  const known = await page.evaluate(() => window.__knownIds());
  const pickFirst = (prefix, n) => known.filter((id) => id.startsWith(prefix)).slice(0, n);
  let jobs;
  if (cardsArg) jobs = cardsArg.split(',').map((s) => s.trim()).filter(Boolean).map((id) => ({ id, kind: null }));
  else if (ALL) {
    const skip = (id) => id.startsWith('probe') || id.startsWith('r6-') || ['lottie', 'particles', 'composite'].includes(id);
    jobs = known.filter((id) => !skip(id) && !id.startsWith('particles-')).map((id) => ({ id, kind: null }));
    for (const id of pickFirst('particles-', PARTICLES)) jobs.push({ id, kind: null });
  } else {
    jobs = [];
    for (const j of DEFAULT_SET) {
      if (j.id === 'lottie-*') for (const id of pickFirst('lottie-', 2)) jobs.push({ ...j, id });
      else if (j.id === 'particles-*') for (const id of pickFirst('particles-', 2)) jobs.push({ ...j, id });
      else jobs.push(j);
    }
  }
  jobs = jobs.filter((j) => known.includes(j.id));
  const metas = await page.evaluate((ids) => window.__cardMeta(ids), jobs.map((j) => j.id));
  const cdp = await page.createCDPSession();
  await cdp.send('Performance.enable');
  const metric = async () => {
    const { metrics } = await cdp.send('Performance.getMetrics');
    const get = (name) => (metrics.find((m) => m.name === name)?.value ?? 0) * 1000;
    return { task: get('TaskDuration'), layout: get('LayoutDuration'), style: get('RecalcStyleDuration'), script: get('ScriptDuration') };
  };
  const cpuLoad = () => { try { return JSON.stringify(process.cpuUsage()); } catch { return ''; } };
  process.stderr.write(`swap-cost-probe(${VIA}):${jobs.length} 张卡,每张 ${FRAMES} 帧,换帧 / 空换各 ${BATCHES} 批(交替) ${cpuLoad()}\n`);

  for (const [i, job] of jobs.entries()) {
    const meta = metas[i];
    const kind = job.kind ?? (meta.source === 'user' ? 'user' : job.id.startsWith('lottie') ? 'lottie' : (meta.canvasHeavy || meta.glCanvas || job.id.startsWith('particles')) ? 'canvas' : 'dom');
    process.stderr.write(`[${i + 1}/${jobs.length}] ${job.id} (${kind}) … `);
    const cpu0 = cpuTimes();
    try {
      const made = await page.evaluate((j) => window.__makeSnapshots(j), { cardId: job.id, fps: FPS, lenSec: CLIP_SEC, mode: meta.mode, canvas: kind === 'canvas', n: FRAMES, params: PARAMS });
      /*
       * 只轮换**互不相同**的帧:相邻两帧一样时 `Stage` 看到同一个 `__html`、不动 DOM,那一次换帧等于空换,会把均值拉低。
       * 不同的帧不够 FRAMES 帧就循环补满;只有一种画面的卡(静止卡)播放时本来就不换,记 `static`、不量。
       */
      const uniq = [...new Set(made)];
      const distinct = uniq.length;
      if (distinct < 2) {
        results.push({ cardId: job.id, kind, static: true, kbMedian: kb(made[0]?.length ?? 0) });
        process.stderr.write('只有一种画面,跳过\n');
        continue;
      }
      const snaps = Array.from({ length: Math.max(FRAMES, distinct) }, (_, k) => uniq[k % distinct]);
      if (snaps.length > 2 && snaps[0] === snaps[snaps.length - 1]) snaps.pop();   // 循环接头处不重复
      const bytes = snaps.map((s) => s.length);
      const imgBytes = snaps.map((s) => (s.match(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g) || []).reduce((n, m) => n + m.length, 0));
      const prep = await page.evaluate((j) => window.__prepareFront(j), { cardId: job.id, fps: FPS, lenSec: CLIP_SEC, snaps, params: PARAMS });
      // 热身一批
      await page.evaluate((v) => window.__batch(true, v), VIA);
      const swapBatches = [], baseBatches = [], swapTimes = [];
      for (let b = 0; b < BATCHES; b++) {
        for (const swap of (b % 2 ? [false, true] : [true, false])) {
          const m0 = await metric();
          const times = await page.evaluate((s, v) => window.__batch(s, v), swap, VIA);
          const m1 = await metric();
          const d = { task: m1.task - m0.task, layout: m1.layout - m0.layout, style: m1.style - m0.style, script: m1.script - m0.script, n: times.length };
          (swap ? swapBatches : baseBatches).push(d);
          if (swap) swapTimes.push(...times);
        }
      }
      const per = (arr, key) => arr.map((d) => d[key] / d.n);
      const swapMs = median(per(swapBatches, 'task')) - median(per(baseBatches, 'task'));
      const sync = swapTimes.map((t) => t.commitMs + t.layoutMs);
      const row = {
        cardId: job.id, kind, note: job.note ?? '', source: meta.source, mode: meta.mode,
        frames: snaps.length, distinct, plane: prep.plane, planeNodes: prep.planeNodes,
        kbMedian: kb(median(bytes)), kbMax: kb(Math.max(...bytes)), imgKbMedian: kb(median(imgBytes)),
        swapMs: r2(swapMs), machineBusyPct: busySince(cpu0),
        swapTaskMsPerBatch: per(swapBatches, 'task').map(r2), baseTaskMsPerBatch: per(baseBatches, 'task').map(r2),
        styleMs: r2(median(per(swapBatches, 'style')) - median(per(baseBatches, 'style'))),
        layoutMsMetric: r2(median(per(swapBatches, 'layout')) - median(per(baseBatches, 'layout'))),
        scriptMs: r2(median(per(swapBatches, 'script')) - median(per(baseBatches, 'script'))),
        syncMedian: r2(median(sync)), syncP90: r2(pct(sync, 0.9)),
        commitMedian: r2(median(swapTimes.map((t) => t.commitMs))), layoutMedian: r2(median(swapTimes.map((t) => t.layoutMs))),
      };
      results.push(row);
      process.stderr.write(`swapMs ${row.swapMs}(同步 ${row.syncMedian} / p90 ${row.syncP90}),${row.kbMedian} KB,${distinct} 帧不同,整机忙 ${row.machineBusyPct}%\n`);
    } catch (err) {
      results.push({ cardId: job.id, kind, error: String(err?.message || err) });
      process.stderr.write(`失败:${String(err?.message || err)}\n`);
    }
  }

  const ok = results.filter((r) => !r.error && !r.static);
  const statics = results.filter((r) => r.static).map((r) => r.cardId);
  const kinds = [...new Set(ok.map((r) => r.kind))];
  const byKind = Object.fromEntries(kinds.map((k) => {
    const list = ok.filter((r) => r.kind === k);
    return [k, { n: list.length, swapMsMedian: r2(median(list.map((r) => r.swapMs))), swapMsMax: r2(Math.max(...list.map((r) => r.swapMs))), syncMedian: r2(median(list.map((r) => r.syncMedian))), syncP90Max: r2(Math.max(...list.map((r) => r.syncP90))) }];
  }));
  const cols = ['cardId', 'kind', 'kbMedian', 'imgKbMedian', 'planeNodes', 'distinct', 'swapMs', 'styleMs', 'layoutMsMetric', 'scriptMs', 'syncMedian', 'syncP90', 'machineBusyPct', 'note'];
  console.log('\n' + ['| ' + cols.join(' | ') + ' |', '|' + cols.map(() => '---').join('|') + '|', ...ok.map((r) => '| ' + cols.map((c) => r[c]).join(' | ') + ' |')].join('\n'));
  console.log('\n按卡种:' + JSON.stringify(byKind, null, 1));
  const failed = results.filter((r) => r.error);
  if (failed.length) console.log('\n失败:' + JSON.stringify(failed));
  if (statics.length) console.log('\n只有一种画面(不量):' + statics.join(', '));
  if (errors.length) console.log('\n页面错误(前 5 条):' + JSON.stringify(errors.slice(0, 5)));
  const summary = { ok: failed.length === 0 && ok.length > 0, origin, via: VIA, frames: FRAMES, batches: BATCHES, byKind, results };
  if (jsonOut) { fs.mkdirSync(path.dirname(path.resolve(jsonOut)), { recursive: true }); fs.writeFileSync(jsonOut, JSON.stringify(summary, null, 2)); }
  console.log(JSON.stringify({ ok: summary.ok, byKind }));
  if (!summary.ok) exitCode = 1;
} catch (err) {
  console.error(err);
  exitCode = 2;
} finally {
  await browser.close();
}
process.exit(exitCode);
