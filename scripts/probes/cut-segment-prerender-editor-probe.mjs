/**
 * 剪辑段参与测量与预渲染,**在真编辑台里**(语义 `docs/semantics/mechanism/rendering.md`「剪辑段」)——
 * 父页测量判重 → 预渲染进程产剪辑段级的轨道流 → 父页按就绪索引判「流铺满了」→ 播放贴流 → 暂停回到活渲 → 改被引用剪辑旧流失效重产。
 *
 *   node scripts/probes/cut-segment-prerender-editor-probe.mjs (--origin http://127.0.0.1:5403 | --port 5403) [--out <dir>] [--json <file>]
 *
 * 给 `--port` 就自己在检出根起一台 dev server(另占 +1、+2 当舞台端口;预渲染进程自己挑空闲端口),数据目录放临时目录,用完收掉。
 *
 * 项目:激活剪辑「主」上一个剪辑段 S(第 1～5 秒,框 960×540 居中,偏移 1 秒)引用「重」;「重」里一张推帧卡 `r6-stateful` 和一个剪辑段
 * 引用「里」;「里」里一张 `probe-slow`,每次渲染烧掉 `BURN` 毫秒(远超一拍预算 23.3 毫秒),所以 S 整段活渲是重的。
 *
 *   1. 测量:成本记录里有 S 的一条(`cutSegment: true`、`kind: random`、`vtOk: false`、判重 `capped`);父页的分派表在 S 的位置判它重。
 *   2. 产流:预渲染进程给 S 产出一条剪辑段级的流(满密度);父页就绪索引里有它的 `stream` 层,`cutStreamHeavy` 为真。
 *   3. 播放:从第 1.2 秒起播 3 秒,舞台把 S 抑制、发了带流键的流平面、这条流画出了帧;播放头走得动(墙上 3 秒内播放头前进的秒数,
 *      对照:同一段在流铺满之前活渲时前进了多少 —— 只记录,不当闸门)。
 *   4. 暂停:等整场景补跑互换之后 S 不再抑制、流平面撤下(回到精确活渲)。
 *   5. 失效:改「里」那张卡的文字(两层深),S 的成本身份换了、父页立刻不再判「流铺满」(旧流不贴);新身份测量后照样产流、铺满。
 *
 * 输出 JSON 结论;任何一条不过就以非零退出。截图写到 `--out`。
 */
import '../lib/no-user-dirs.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { flagArg } from './probe-connect.mjs';
import { startDevServer, sleep } from './below-stream-common.mjs';

const args = process.argv.slice(2);
const ORIGIN = flagArg('origin', null, args);
const PORT = Number(flagArg('port', '0', args));
const JSON_OUT = flagArg('json', null, args);
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-cut-prerender-editor-${Date.now().toString(36)}`));
if (!ORIGIN && !PORT) { console.error('要给 --origin <dev server> 或 --port <自己起一台>'); process.exit(2); }

const FPS = 30, WIDTH = 1280, HEIGHT = 720, BURN = 60;
const SEG = 'seg-s';
const card = (id, cardId, start, end, params = {}) => ({ id, cardId, start, end, params });
const segOf = (id, cutId, start, end, extra = {}) => ({ id, cardId: '', cutId, start, end, params: {}, ...extra });
const PROJECT = {
  version: 1, id: `cut-prerender-editor-${Date.now().toString(36)}`, name: 'cut-prerender-editor', width: WIDTH, height: HEIGHT, fps: FPS, duration: 6, themeId: 'dark',
  media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
  tracks: [{ id: 'tr-main', name: 'main', clips: [segOf(SEG, 'c-heavy', 1, 5, { cutOffset: 1, frame: { x: 160, y: 90, w: 960, h: 540 } })] }],
  activeCutId: 'c-main',
  cuts: [
    { id: 'c-main', name: '主' },
    { id: 'c-heavy', name: '重', duration: 6, transitions: [], tracks: [
      { id: 'h-1', name: 'h1', clips: [card('h-r6', 'r6-stateful', 0, 6)] },
      { id: 'h-2', name: 'h2', clips: [segOf('h-seg', 'c-inner', 0, 6)] },
    ] },
    { id: 'c-inner', name: '里', duration: 6, transitions: [], tracks: [{ id: 'i-1', name: 'i1', clips: [card('i-slow', 'probe-slow', 0, 6, { burnMs: BURN, label: 'inner' })] }] },
  ],
};

const fails = [];
const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ step, t: Date.now(), ...fields })}\n`);
const check = (cond, label, extra) => { if (!cond) { fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); say('FAIL', { label, extra }); } else say('ok', { label }); return cond; };
async function until(label, fn, timeoutMs, everyMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value = null;
    try { value = await fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() > deadline) { fails.push(`超时:${label}`); say('timeout', { label }); return null; }
    await sleep(everyMs);
  }
}

const out = { burnMs: BURN };
await fs.mkdir(OUT, { recursive: true });
let dev = null, browser = null;
try {
  let origin = ORIGIN;
  if (!origin) { dev = await startDevServer({ port: PORT, dataDir: path.join(OUT, 'dev-data'), tag: 'cuteditor' }); origin = dev.origin; say('spawn', { pid: dev.pid, port: PORT }); }
  origin = origin.replace(/\/+$/, '');
  browser = await puppeteer.launch({ headless: true, protocolTimeout: 300000,
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(origin + '/?editor&nosetup=1&preview=stage', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(async () => {
    const m = await import('/src/editor/stageBridge.ts');
    return !!m.frontStage() && m.backRole() === 'back';
  }, { timeout: 180000, polling: 500 });
  await page.evaluate(async (p) => { const { actions } = await import('/src/store/project.ts'); actions.loadProject(p); actions.seek(0); }, PROJECT);
  const prerender = await (await fetch(origin + '/api/prerender/info')).json();
  out.prerender = prerender.url;

  /** 页面这一刻:S 的成本身份、记录、分派、就绪索引里的流层、`cutStreamHeavy` */
  const pageState = (t = 2) => page.evaluate(async (id, at) => {
    const { getState } = await import('/src/store/project.ts');
    const { clipIdentityOf } = await import('/src/editor/costIdentity.ts');
    const plan = await import('/src/editor/planDispatch.ts');
    const { pipelineAt } = await import('/src/render/pipelinePlan.mjs');
    const feed = await import('/src/editor/snapshotFeed.ts');
    const project = getState().project;
    const key = clipIdentityOf(project).identityKeys[id] ?? null;
    const record = plan.currentCosts().find((r) => r.identityKey === key) ?? null;
    const layer = feed.currentReadyIndex().get(id)?.get('stream') ?? null;
    return { key, record, pipeline: pipelineAt(plan.currentPlan(), id, at), layer: layer && { key: layer.key, ranges: layer.ranges, originFrame: layer.originFrame }, heavy: feed.cutStreamHeavy(project, project.tracks[0].clips[0], at) };
  }, SEG, t);
  const preload = async () => {
    const k = await page.evaluate(async () => (await import('/src/render/dataMirror.ts')).mirrorKey());
    if (k) await fetch(prerender.url + '/api/frames/preload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: k.session, localRev: k.localRev, lane: 'background' }) }).catch(() => {});
  };
  const streamStatus = async () => {
    const d = await (await fetch(prerender.url + '/api/frames/diagnostics')).json();
    const mine = d.streams?.streams?.find((x) => x.clipIds?.includes(SEG));
    if (!mine) return null;
    let dense = true, any = true;
    for (let n = mine.firstSegment; n <= mine.lastSegment; n++) { if (!mine.segments[n]) any = false; if (mine.segments[n]?.stride !== 1) dense = false; }
    return { key: mine.streamKey ?? mine.key, solo: mine.solo, any, dense, segments: mine.lastSegment - mine.firstSegment + 1 };
  };
  const playFor = async (from, ms) => {
    await page.evaluate(async (t0) => { const { actions } = await import('/src/store/project.ts'); actions.seek(t0); actions.play(); }, from);
    const w0 = Date.now();
    await sleep(ms);
    const t = await page.evaluate(async () => (await import('/src/store/project.ts')).getState().t);
    return { wallMs: Date.now() - w0, advanced: +(t - from).toFixed(3) };
  };
  const pause = () => page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.pause(); });
  const frontStage = async () => {
    const frontId = await page.evaluate(() => window.__pcPreviewDiag?.().frontId ?? 'A');
    return page.frames().find((f) => f.url().includes('stage=1') && f.url().includes(`id=${frontId}`));
  };

  // ---------------------------------------------------------------- 1. 测量
  const measured = await until('S 测完、记录到了', async () => { const s = await pageState(); return s.record ? s : null; }, 300000, 1000);
  out.measured = measured && { key: measured.key, record: measured.record && { kind: measured.record.kind, capped: measured.record.capped, stepMs: measured.record.stepMs, vtOk: measured.record.vtOk, seekOk: measured.record.seekOk, cutSegment: measured.record.cutSegment }, pipeline: measured.pipeline };
  check(!!measured?.key, '1:剪辑段有成本身份', out.measured);
  check(measured?.record?.cutSegment === true && measured.record.kind === 'random' && measured.record.vtOk === false && measured.record.seekOk === false, '1:成本记录按剪辑段的口径记', out.measured);
  check(measured?.record?.capped === true && measured.pipeline === 'heavy', '1:烧时间的剪辑段判重', out.measured);

  // 对照:流铺满之前播放,S 照旧活渲(不抑制),播放头走多快只记录
  {
    const s = await pageState(1.5);
    if (!s.heavy) {
      const r = await playFor(1.2, 3000);
      const stage = await frontStage();
      const diag = await stage.evaluate(() => window.__pcStageDiag());
      await pause();
      out.beforeStream = { ...r, suppressed: diag.suppressed.includes(SEG) };
      check(!diag.suppressed.includes(SEG), '没流时:播放中剪辑段照旧活渲(不抑制、不显示占位符)', out.beforeStream);
    } else out.beforeStream = { skipped: '流已经铺满' };
    await sleep(800);
  }

  // ---------------------------------------------------------------- 2. 产流
  const stream = await until('S 的流满密度', async () => { await preload(); const s = await streamStatus(); return s?.dense ? s : null; }, 900000, 2000);
  out.stream = stream;
  check(!!stream && stream.solo === 'cut', '2:预渲染进程给剪辑段产了一条剪辑段级的流(solo cut),满密度', stream);
  const heavyNow = await until('父页判流铺满', async () => { const s = await pageState(2); return s.heavy ? s : null; }, 60000, 500);
  out.parentLayer = heavyNow?.layer ?? null;
  check(!!heavyNow, '2:父页就绪索引里有它的流层,cutStreamHeavy 为真', heavyNow);

  // ---------------------------------------------------------------- 3. 播放贴流
  {
    const r = await playFor(1.2, 3000);
    const stage = await frontStage();
    const diag = await stage.evaluate(() => window.__pcStageDiag());
    const dom = await stage.evaluate((id) => {
      const wrap = document.querySelector(`[data-pc-clip="${id}"]`);
      const plane = wrap?.querySelector('[data-pc-stream-plane]');
      return { suppressed: !!wrap?.classList.contains('pc-suppressed'), plane: !!plane && getComputedStyle(plane).display !== 'none' };
    }, SEG);
    await page.screenshot({ path: path.join(OUT, 'editor-playing-stream.png') });
    const track = diag.streams.tracks.find((t) => t.id.startsWith(SEG));
    out.playing = { ...r, suppressed: diag.suppressed.includes(SEG), planes: diag.streamPlanes.filter((p) => p.clipIds.includes(SEG)).map((p) => p.key), track: track && { drawn: track.drawn, errors: track.errors, lastDrawn: track.lastDrawn }, dom };
    await pause();
    check(out.playing.suppressed && dom.suppressed && dom.plane, '3:播放中剪辑段被抑制、流平面露着', out.playing);
    check(out.playing.planes.includes(heavyNow?.layer?.key), '3:父页发了带这条流键的流平面', out.playing);
    check(!!track && track.drawn > 10 && track.errors === 0, '3:这条流画出了帧、解码没报错', out.playing.track);
  }

  // ---------------------------------------------------------------- 4. 暂停回到活渲
  {
    await sleep(500);
    const settled = await until('暂停后回到活渲', async () => {
      const stage = await frontStage();
      const diag = await stage.evaluate(() => window.__pcStageDiag());
      return !diag.suppressed.includes(SEG) ? { suppressed: diag.suppressed, planes: diag.streamPlanes.length } : null;
    }, 120000, 500);
    out.paused = settled;
    check(!!settled, '4:暂停后整场景补跑互换,剪辑段不再抑制(精确活渲)', settled);
    await page.screenshot({ path: path.join(OUT, 'editor-paused-live.png') });
  }

  // ---------------------------------------------------------------- 5. 改被引用剪辑:旧流失效、重测、重产
  {
    const before = await pageState(2);
    await page.evaluate(async () => {
      const { actions, getState } = await import('/src/store/project.ts');
      const p = getState().project;
      const cuts = p.cuts.map((c) => c.id !== 'c-inner' ? c : { ...c, tracks: c.tracks.map((tr) => ({ ...tr, clips: tr.clips.map((cl) => ({ ...cl, params: { ...cl.params, label: 'changed' } })) })) });
      actions.loadProject({ ...p, cuts });
    });
    const after = await until('新身份', async () => { const s = await pageState(2); return s.key && s.key !== before.key ? s : null; }, 30000, 300);
    out.changed = { beforeKey: before.key, afterKey: after?.key ?? null, heavyRightAfter: after?.heavy ?? null };
    check(!!after, '5:改了两层深的被引用剪辑,剪辑段的成本身份换了', out.changed);
    check(after?.heavy === false, '5:改完当场父页不再判流铺满(旧流不贴)', out.changed);
    const remeasured = await until('新身份测完', async () => { const s = await pageState(2); return s.record && s.key === after?.key ? s : null; }, 300000, 1000);
    check(!!remeasured, '5:新身份重新测量了', remeasured?.record);
    const restream = await until('新流满密度', async () => { await preload(); const s = await streamStatus(); return s?.dense && s.key !== stream?.key ? s : null; }, 900000, 2000);
    out.restream = restream;
    check(!!restream, '5:按新身份重新产了一条流(流键不同)', { old: stream?.key, now: restream?.key });
    const heavyAgain = await until('父页又判流铺满', async () => { const s = await pageState(2); return s.heavy && s.layer?.key !== heavyNow?.layer?.key ? s : null; }, 60000, 500);
    check(!!heavyAgain, '5:父页换上了新流的层', heavyAgain?.layer?.key);
  }
  out.pageErrors = errors;
  check(errors.length === 0, '页面零报错', errors.slice(0, 5));
} catch (error) {
  fails.push(`探针出错:${error?.message || error}`);
  say('ERROR', { error: String(error?.stack || error) });
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  try { await dev?.stop(); } catch { /* ignore */ }
  try { await fs.rm(path.join(OUT, 'dev-data'), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* ignore */ }
}
out.fails = fails;
out.ok = fails.length === 0;
try { await fs.writeFile(path.join(OUT, 'result.json'), JSON.stringify(out, null, 2)); } catch { /* ignore */ }
if (JSON_OUT) await fs.writeFile(JSON_OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
console.log(out.ok ? 'PASS' : `FAIL ${fails.length}`);
process.exit(out.ok ? 0 : 1);
