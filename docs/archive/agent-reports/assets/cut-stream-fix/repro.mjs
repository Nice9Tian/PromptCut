// 复现:剪辑段里的粒子卡跳进去时的长任务、分派表与贴流诊断。node out/cut-stream-fix/repro.mjs --port 29300 [--trace file] [--origin url]
setTimeout(() => { console.error('SCRIPT_TIMEOUT'); process.exit(124); }, 900_000).unref();
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from '../../scripts/probes/probe-chrome.mjs';
import { startDevServer } from '../../scripts/probes/below-stream-common.mjs';

const args = process.argv.slice(2);
const arg = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const PORT = Number(arg('--port', '29300'));
const ORIGIN = arg('--origin', null);
const TRACE = arg('--trace', null);
const PROJECT = JSON.parse(await fs.readFile(arg('--project', path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), 'project41.json')), 'utf8'));
const SEEKS = (arg('--seeks', '1.5,5.5,2.5')).split(',').map(Number);
const WAIT = Number(arg('--wait', '10000'));
const say = (...a) => console.error(new Date().toISOString().slice(11, 23), ...a);

let dev = null;
const origin = ORIGIN ?? (dev = await startDevServer({ port: PORT, dataDir: path.join(os.tmpdir(), `pc-csf-${Date.now().toString(36)}`), tag: 'csf' })).origin;
say('origin', origin);
const browser = await puppeteer.launch({
  headless: true, protocolTimeout: 240000,
  args: [...PROBE_CHROME_ARGS, '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    '--disable-gpu-vsync', '--disable-frame-rate-limit'],
});
const out = {};
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
  await page.goto(origin + '/?editor&headless=1&preview=stage' + (args.includes('--browser') ? '&platform=browser' : ''), { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForSelector('iframe[data-pc="stage-frame"]', { timeout: 180000 });
  await page.waitForFunction(async () => (await import('/src/editor/stageBridge.ts')).backRole() === 'back', { timeout: 180000, polling: 500 });
  say('stages up');
  await page.evaluate(async (p) => {
    await import('/src/cards/index.ts');
    const { actions } = await import('/src/store/project.ts');
    actions.loadProject(p);
    window.__pcLong = [];
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__pcLong.push({ start: Math.round(e.startTime), dur: Math.round(e.duration) }); }).observe({ entryTypes: ['longtask'] });
  }, PROJECT);
  await new Promise((r) => setTimeout(r, 2000));
  await page.waitForFunction(async () => (await import('/src/editor/probeRunner.ts')).probeProgress().running === false, { timeout: 300000, polling: 500 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 3000));
  say('probe idle');
  out.plan = await page.evaluate(async () => {
    const { currentPlan, currentCosts } = await import('/src/editor/planDispatch.ts');
    const { clipIdentityOf } = await import('/src/editor/costIdentity.ts');
    const { getState } = await import('/src/store/project.ts');
    const plan = currentPlan();
    const id = clipIdentityOf(getState().project);
    return {
      segments: plan?.segments.map((s) => ({ from: s.fromSec, to: s.toSec, heavy: [...s.heavy], light: [...s.light] })),
      prerender: [...(plan?.prerenderSet ?? [])],
      identityKeys: id.identityKeys, frameModes: id.frameModes,
      costs: currentCosts().filter((c) => Object.values(id.identityKeys).includes(c.identityKey)).map((c) => ({ k: c.identityKey, stepMs: c.stepMs, catchUpMs: c.catchUpMs, kind: c.kind, seekOk: c.seekOk, seekMs: c.seekMs, vtOk: c.vtOk, capped: c.capped })),
    };
  });
  say('plan', JSON.stringify(out.plan));
  out.seeks = [];
  for (const t of SEEKS) {
    await page.evaluate(() => { window.__pcLong = []; });
    if (TRACE && t === SEEKS[0]) await page.tracing.start({ path: TRACE, categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8.execute', 'disabled-by-default-v8.cpu_profiler', 'toplevel'] });
    const t0 = await page.evaluate(async (t) => { const { actions } = await import('/src/store/project.ts'); const now = performance.now(); actions.seek(t); return now; }, t);
    await new Promise((r) => setTimeout(r, WAIT));
    if (TRACE && t === SEEKS[0]) await page.tracing.stop();
    const r = await page.evaluate((t0) => {
      const longs = window.__pcLong.filter((l) => l.start >= t0 - 5);
      const d = typeof window.__pcPreviewDiag === 'function' ? window.__pcPreviewDiag() : null;
      return { count: longs.length, totalMs: longs.reduce((a, l) => a + l.dur, 0), top: longs.map((l) => l.dur).sort((a, b) => b - a).slice(0, 12), feed: d?.snapshotFeed ?? null };
    }, t0);
    out.seeks.push({ t, ...r });
    say('seek', t, JSON.stringify({ count: r.count, totalMs: r.totalMs, top: r.top }));
  }
  out.errors = errors;
} finally {
  await browser.close().catch(() => {});
  await dev?.stop();
}
const file = arg('--json', null);
if (file) await fs.writeFile(file, JSON.stringify(out, null, 1));
console.log(JSON.stringify({ seeks: out.seeks?.map((s) => ({ t: s.t, count: s.count, totalMs: s.totalMs, top: s.top })), errors: out.errors?.length }));
