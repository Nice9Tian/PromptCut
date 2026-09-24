/**
 * 兜底顺序的端到端探针(rendering.md「兜底顺序」):真编辑台里播放含重卡的工程,**逐拍**记录每张被抑制的卡
 * 落在哪一级 —— `dense`(满帧流)/ `sparse`(稀疏流)/ `snapshot`(同区间最近快照)/ `placeholder`(占位符)/
 * `transparent`(无提示透明,不许出现)。满 120 ms 才显示的那段空档记成 `placeholder-delay`,单列统计。
 *
 *   node scripts/probes/preview-fallback-probe.mjs --origin http://127.0.0.1:5230 [--seconds 10] [--out <dir>] [--json <file>]
 *        [--label after|before] [--baseline <before.json>]
 *
 * 端口按分配的端口段:dev server 用 `npx vite --port 5230 --strictPort --host 127.0.0.1`(舞台端口 5231 / 5232)。
 *
 * 流程(和 `stream-editor-e2e.mjs` 同一套打法:编辑台 `?preview=stage`,探针自己按 `{ session, localRev }`
 * 调预渲染进程的 preload —— dual 模式今天没有别人调它):
 *   0. 换空项目,加一张长粒子卡(重卡:按追帧上界判重),等它的轨道流满密度、快照铺上一截;
 *      再加两张金句药丸(一张旋转 25°、一张缩放 0.6),在父页的分派表里钉成重卡、**不给它们预渲染** ——
 *      播放时它们走到兜底顺序尽头,显示占位符(旋转 / 缩放那两张截图);
 *   1. **起播**:停在 0 秒,播 3 秒;
 *   2. **跳转**:暂停中跳到片段 60% 处,播 2 秒;
 *   3. **超过 6 路流**:再加 6 张同样的粒子卡,把第一张的 `stream` / `html` 层复制给它们(父页就绪索引),
 *      一共 7 条流、解码器预算 6 —— 第 7 张当「无流」、每拍换快照;播 2 秒;
 *   4. **编辑后**:删掉那 6 张,暂停在 2 秒,改一张药丸的文字(localRev + 1),**紧接着**播 2 秒 ——
 *      以前这一下会清空就绪索引、重连 SSE(根因 E),空档里重卡全透明。
 *   另外核对:后台舞台上没有任何占位节点、没有注入占位样式;可见舞台 `__pcCreateSnapshot()` 的产物里没有占位节点;
 *   点中占位符命中它所在的卡。
 *
 * 逐拍分级靠舞台的 `window.__pcFallbackTrace`(`StageView` 的 `traceFallback`,数组时才记)。
 * 每拍主线程耗时有两份:`trace.workMs`(舞台自己量的一拍干活时长,只有修复后的代码有)和
 * `taskMs`(CDP `Performance.getMetrics` 的 `TaskDuration` 按 1/fps 采样取差 —— 修复前后的代码都能量,
 * 用它比「相对修复前 p90 涨幅 ≤ 1 ms」)。修复前那一份用 `--label before` 在修复前的代码上跑出来,
 * 再用 `--baseline <那份 json>` 比。
 *
 * 验收:`transparent` 拍数为 0(`placeholder-delay` 单列、不算);给了 `--baseline` 时 `taskMs` 的 p90 涨幅 ≤ 1 ms。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { devOrigin, flagArg } from './probe-connect.mjs';

const args = process.argv.slice(2);
const origin = devOrigin(args);
const SECONDS = Number(flagArg('seconds', '10', args)) || 10;
const LABEL = flagArg('label', 'after', args);
const BASELINE = flagArg('baseline', null, args);
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-fallback-${LABEL}-${Date.now().toString(36)}`));
const JSON_OUT = flagArg('json', null, args);
const RUN = Date.now().toString(36);
const fails = [];
const notes = [];
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 600))); return cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (xs, q) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor(s.length * q))].toFixed(3); };

async function until(label, fn, timeoutMs, everyMs = 1000, soft = false) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value = null;
    try { value = await fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() > deadline) { (soft ? notes : fails).push(`超时:${label}`); return null; }
    await sleep(everyMs);
  }
}

const out = { origin, label: LABEL, seconds: SECONDS, out: OUT, scenarios: {} };
await fs.mkdir(OUT, { recursive: true });
const browser = await puppeteer.launch({ headless: true, protocolTimeout: 300000,
  args: ['--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(origin + '/?editor&nosetup=1&preview=stage', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(async () => {
    const m = await import('/src/editor/stageBridge.ts');
    return !!m.frontStage() && m.backRole() === 'back';
  }, { timeout: 120000, polling: 500 });
  const ports = await (await fetch(origin + '/api/stage/ports')).json();
  const stagePorts = (ports.ports ?? []).slice(0, 2).map(String);
  const store = (fn, ...a) => page.evaluate(async (src, a2) => {
    const { actions, getState } = await import('/src/store/project.ts');
    // eslint-disable-next-line no-new-func
    return new Function('actions', 'getState', 'args', src)(actions, getState, a2);
  }, fn, a);
  const stageFrames = () => page.frames().filter((f) => /[?&]stage=1/.test(f.url()) && stagePorts.some((p) => f.url().includes(`:${p}/`)));
  const frontFrame = async () => {
    const id = await page.evaluate(() => window.__pcPreviewDiag?.().frontId ?? 'A');
    return stageFrames().find((f) => f.url().includes(`id=${id}`)) ?? null;
  };

  /* ---------------------------------------------------------------- 0. 工程 */
  const clipId = await store(`actions.newProject('fallback-${RUN}');
    const c = actions.addCardClip('particles', 0, { duration: args[0], params: { color: '#30ff60', quantity: 100, links: 'yes', seed: 5 } });
    actions.seek(0);
    return c?.id;`, SECONDS);
  out.clipId = clipId;
  check(!!clipId, '加上了粒子卡');
  /**
   * 把这几张卡钉成重卡(`pinnedHeavy`):父页的分派表当场生效(`mergePlanCosts`);`persist` 时再整条 PUT 到
   * 本 dev server 的成本存档(worktree 自己的 `out/card-costs.json`),预渲染进程据此把它们放进预渲染集合。
   * 粒子卡实测是轻卡(K1 量得 stepMs ≈ 1 ms),不钉的话播放时它活渲、根本不走兜底顺序。
   */
  const pinHeavy = (ids, persist = false) => page.evaluate(async (ids, persist) => {
    const { getState } = await import('/src/store/project.ts');
    const { clipIdentityOf } = await import('/src/editor/costIdentity.ts');
    const pd = await import('/src/editor/planDispatch.ts');
    const keys = clipIdentityOf(getState().project).identityKeys;
    const costs = pd.currentCosts();
    const device = costs[0]?.device ?? 'probe';
    const recs = ids.filter((id) => keys[id]).map((id) => ({ ...(costs.find((r) => r.identityKey === keys[id]) ?? { identityKey: keys[id], device }), pinnedHeavy: true }));
    pd.mergePlanCosts(recs);
    if (persist) {
      const full = recs.filter((r) => typeof r.stepMs === 'number');
      if (full.length) await fetch('/api/data/costs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ records: full }) });
    }
    return recs.length;
  }, ids, persist);
  const hasRecords = (ids) => page.evaluate(async (ids) => {
    const { getState } = await import('/src/store/project.ts');
    const { clipIdentityOf } = await import('/src/editor/costIdentity.ts');
    const pd = await import('/src/editor/planDispatch.ts');
    const keys = clipIdentityOf(getState().project).identityKeys;
    return ids.every((id) => pd.currentCosts().some((r) => r.identityKey === keys[id]));
  }, ids);
  await until('粒子卡的 K1 记录', () => hasRecords([clipId]), 60000, 500, true);
  await pinHeavy([clipId], true);
  const prerender = await (await fetch(origin + '/api/prerender/info')).json();
  const segCount = Math.ceil(SECONDS * 30 / 15);
  const ready = await until('粒子卡的轨道流满密度、快照铺上一截', async () => {
    const k = await page.evaluate(async () => (await import('/src/render/dataMirror.ts')).mirrorKey());
    if (!k) return null;
    await fetch(prerender.url + '/api/frames/preload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: k.session, localRev: k.localRev, lane: 'background' }) }).catch(() => {});
    const layers = await page.evaluate(async (id) => {
      const m = await import('/src/editor/snapshotFeed.ts');
      const byKind = m.currentReadyIndex().get(id);
      return byKind ? Object.fromEntries([...byKind].map(([k, v]) => [k, v.ranges])) : null;
    }, clipId);
    const covered = (ranges, n) => { let c = 0; for (let i = 0; i < n; i++) if ((ranges ?? []).some((r) => r[0] <= i && i <= r[1])) c++; return c; };
    if (!layers?.stream || covered(layers.stream, segCount) < segCount) return null;
    if (!layers.html || covered(layers.html, SECONDS * 30) < SECONDS * 30 * 0.3) return null;
    return layers;
  }, 600000, 2000);
  out.readyLayers = ready ? Object.fromEntries(Object.entries(ready).map(([k, v]) => [k, v.length])) : null;

  // 两张药丸:一张旋转、一张缩放。等 K1 量完再在父页的分派表里钉成重卡(不给它们预渲染 → 兜底尽头)
  const pills = await store(`const a = actions.addClipOnNewTrack({ cardId: 'punch-pill', start: 0, duration: args[0] });
    const b = actions.addClipOnNewTrack({ cardId: 'punch-pill', start: 0, duration: args[0] });
    actions.setClipParams(a.id, { text: '旋转 ${RUN}' });
    actions.setClipParams(b.id, { text: '缩放 ${RUN}' });
    actions.setClipFrame(a.id, { x: 560, y: 300, w: 640, h: 360, anchor: [0.5, 0.5], rotate: 25 });
    actions.setClipFrame(b.id, { x: 1360, y: 760, w: 640, h: 360, anchor: [0.5, 0.5], scale: 0.6 });
    return [a.id, b.id];`, SECONDS);
  out.pills = pills;
  await until('药丸的 K1 记录', () => hasRecords(pills), 60000, 500, true);
  // 药丸只在父页钉(不 PUT):预渲染进程不产它们,播放时它们走到兜底顺序尽头
  const pinAll = async (extraIds = []) => { await pinHeavy([clipId, ...extraIds]); await pinHeavy(pills); await sleep(300); };
  await pinAll();
  // 暂停在 1 秒让药丸活渲一次(占位符的墨迹框在暂停后防抖量)
  await store(`actions.seek(1);`);
  await sleep(1500);

  /* ---------------------------------------------------------------- 逐拍记录 + 主线程采样 */
  const cdp = [];
  for (const target of browser.targets()) {
    if (!stagePorts.some((p) => target.url().includes(`:${p}/`))) continue;
    try {
      const s = await target.createCDPSession();
      await s.send('Performance.enable');
      cdp.push({ url: target.url(), s });
    } catch { /* 同进程的 frame 没有单独的 target */ }
  }
  out.cdpTargets = cdp.map((c) => c.url.replace(/\?.*$/, ''));
  const taskDuration = async (s) => (await s.send('Performance.getMetrics')).metrics.find((m) => m.name === 'TaskDuration')?.value ?? 0;

  async function scenario(name, run) {
    for (const f of stageFrames()) await f.evaluate(() => { window.__pcFallbackTrace = []; }).catch(() => {});
    const samples = cdp.map(() => []);
    let sampling = true;
    const sampler = (async () => {
      const last = await Promise.all(cdp.map((c) => taskDuration(c.s).catch(() => 0)));
      while (sampling) {
        await sleep(1000 / 30);
        const now = await Promise.all(cdp.map((c) => taskDuration(c.s).catch(() => 0)));
        now.forEach((v, i) => { samples[i].push((v - last[i]) * 1000); last[i] = v; });
      }
    })();
    const shots = await run();
    sampling = false;
    await sampler;
    const traces = [];
    for (const f of stageFrames()) {
      const t = await f.evaluate(() => (Array.isArray(window.__pcFallbackTrace) ? window.__pcFallbackTrace.splice(0) : null)).catch(() => null);
      if (t) traces.push(...t);
      await f.evaluate(() => { delete window.__pcFallbackTrace; }).catch(() => {});
    }
    // 播放中的那个进程干活最多:取总量最大的那一路当「可见舞台」的主线程
    const busiest = samples.map((xs) => xs.reduce((a, b) => a + b, 0)).reduce((best, v, i, all) => (v > all[best] ? i : best), 0);
    const task = samples[busiest] ?? [];
    const counts = {};
    const transparent = [];
    for (const beat of traces) {
      for (const [id, level] of Object.entries(beat.levels)) {
        counts[level] = (counts[level] ?? 0) + 1;
        if (level === 'transparent') transparent.push({ sec: beat.sec, id });
      }
    }
    const work = traces.map((b) => b.workMs);
    const res = { beats: traces.length, counts, transparent: transparent.slice(0, 20), transparentBeats: transparent.length,
      workMs: { p50: pct(work, 0.5), p90: pct(work, 0.9) }, taskMs: { n: task.length, p50: pct(task, 0.5), p90: pct(task, 0.9) }, shots };
    out.scenarios[name] = res;
    if (LABEL !== 'before') {
      check(traces.length > 0, `${name}:舞台记下了逐拍分级`);
      check(transparent.length === 0, `${name}:没有无提示透明的拍`, transparent.slice(0, 10));
    }
    return res;
  }
  const play = () => store(`actions.play();`);
  const pause = () => store(`actions.pause();`);
  const shot = async (name) => {
    const file = path.join(OUT, `${LABEL}-${name}.png`);
    await page.screenshot({ path: file });
    return file;
  };

  /* ---------------------------------------------------------------- 1. 起播 */
  await pinAll();
  await store(`actions.seek(0);`);
  await sleep(1500);
  await scenario('起播', async () => {
    await play();
    await sleep(350);
    const a = await shot('起播');
    await sleep(1200);
    // 旋转 / 缩放的药丸此刻在兜底尽头(被抑制、没有流、没有快照):占位符
    const front = await frontFrame();
    const ph = front ? await front.evaluate(() => [...document.querySelectorAll('[data-pc-placeholder-slot]:not([hidden])')].map((s) => {
      const r = (s.querySelector('[data-pc-placeholder-plane]') ?? s).getBoundingClientRect();
      return { clip: s.parentElement?.getAttribute('data-pc-clip'), reason: s.getAttribute('data-pc-placeholder-reason'), cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width, h: r.height };
    })).catch(() => []) : [];
    out.placeholdersWhilePlaying = ph;
    const b = await shot('占位符-旋转与缩放');
    // 点中占位符命中它所在的卡;快照里没有占位节点
    if (front && ph.length) {
      const hit = await front.evaluate((x, y) => window.__pcStage.hitTest(x, y), ph[0].cx, ph[0].cy).catch((e) => ({ error: String(e) }));
      out.placeholderHit = { want: ph[0].clip, hit };
      check(hit?.clipId === ph[0].clip, '点中占位符命中它所在的卡', out.placeholderHit);
      const snap = await front.evaluate(() => { const s = window.__pcCreateSnapshot(); return { html: s.html.includes('data-pc-placeholder'), controls: s.controls.some((c) => c.html.includes('data-pc-placeholder')) }; }).catch((e) => ({ error: String(e) }));
      out.snapshotHasPlaceholder = snap;
      check(snap && snap.html === false && snap.controls === false, '生成快照不带占位节点', snap);
    }
    if (LABEL !== 'before') {
      for (const id of pills) check(ph.some((p) => p.clip === id), `药丸 ${id} 在兜底尽头显示占位符`, ph);
    }
    await sleep(1400);
    await pause();
    return [a, b];
  });
  await sleep(1500);

  /* ---------------------------------------------------------------- 2. 跳转 */
  await pinAll();
  await store(`actions.seek(args[0]);`, +(SECONDS * 0.6).toFixed(2));
  await sleep(1200);
  await scenario('跳转', async () => {
    await play();
    await sleep(300);
    const a = await shot('跳转');
    await sleep(1700);
    await pause();
    return [a];
  });
  await sleep(1500);

  /* ---------------------------------------------------------------- 3. 超过 6 路流 */
  const extra = await store(`const out = [];
    for (let i = 0; i < 6; i++) { const c = actions.addClipOnNewTrack({ cardId: 'particles', start: 0, duration: args[0] }); actions.setClipParams(c.id, { color: '#30ff60', quantity: 100, links: 'yes', seed: 5 }); out.push(c.id); }
    actions.seek(0.5);
    return out;`, SECONDS);
  out.extra = extra;
  await sleep(1000);
  const injected = await page.evaluate(async (orig, ids) => {
    const m = await import('/src/editor/snapshotFeed.ts');
    const idx = m.currentReadyIndex();
    const src = idx.get(orig);
    if (!src) return 0;
    for (const id of ids) idx.set(id, new Map([...src].map(([k, v]) => [k, { ...v }])));
    return ids.length;
  }, clipId, extra);
  check(injected === 6, '给 6 张新粒子卡复制了流层和快照层', injected);
  // 新卡同一身份;一并钉成重卡
  await pinAll(extra);
  await sleep(500);
  await scenario('超过6路流', async () => {
    await play();
    await sleep(1000);
    const front = await frontFrame();
    out.overBudget = front ? await front.evaluate(() => { const d = window.__pcStageDiag(); return { planes: d.streamPlanes.length, tracks: d.streams.tracks.length, snapshots: d.snapshots.length, suppressed: d.suppressed.length }; }).catch(() => null) : null;
    const a = await shot('超过6路流');
    await sleep(1000);
    await pause();
    return [a];
  });
  if (LABEL !== 'before') check(out.overBudget && out.overBudget.planes <= 6 && out.overBudget.tracks <= 6, '父页只发解码器预算内的流平面(≤ 6)', out.overBudget);
  await sleep(1200);

  /* ---------------------------------------------------------------- 4. 编辑后 */
  await store(`for (const id of args[0]) actions.removeClip(id); actions.seek(2);`, extra);
  await pinAll();
  await sleep(1500);
  await scenario('编辑后', async () => {
    await store(`actions.setClipParams(args[0], { text: '改过 ${RUN}' }); actions.play();`, pills[0]);
    await sleep(400);
    const a = await shot('编辑后');
    await sleep(1600);
    await pause();
    return [a];
  });
  await sleep(1000);

  /* ---------------------------------------------------------------- 后台舞台 */
  const backId = await page.evaluate(() => ((window.__pcPreviewDiag?.().frontId ?? 'A') === 'A' ? 'B' : 'A'));
  const back = stageFrames().find((f) => f.url().includes(`id=${backId}`));
  out.backStage = back ? await back.evaluate(() => ({ slots: document.querySelectorAll('[data-pc-placeholder-slot],[data-pc-placeholder-plane]').length,
    style: !!document.querySelector('style[data-pc-placeholder]'), role: window.__pcStageDiag?.().role })).catch((e) => ({ error: String(e) })) : null;
  if (LABEL !== 'before') check(out.backStage && out.backStage.slots === 0 && out.backStage.style === false, '后台舞台不挂占位节点、不注入占位样式', out.backStage);

  /* ---------------------------------------------------------------- 汇总 */
  const all = Object.values(out.scenarios);
  out.total = {
    beats: all.reduce((n, s) => n + s.beats, 0),
    transparentBeats: all.reduce((n, s) => n + s.transparentBeats, 0),
    placeholderDelay: all.reduce((n, s) => n + (s.counts['placeholder-delay'] ?? 0), 0),
    counts: all.reduce((acc, s) => { for (const [k, v] of Object.entries(s.counts)) acc[k] = (acc[k] ?? 0) + v; return acc; }, {}),
    taskP90: pct(all.flatMap((s) => [s.taskMs.p90]).filter((v) => v !== null), 0.5),
  };
  if (BASELINE) {
    const base = JSON.parse(await fs.readFile(BASELINE, 'utf8'));
    out.vsBaseline = {};
    for (const [name, s] of Object.entries(out.scenarios)) {
      const b = base.scenarios?.[name];
      if (!b?.taskMs?.p90 || s.taskMs.p90 === null) continue;
      const delta = +(s.taskMs.p90 - b.taskMs.p90).toFixed(3);
      out.vsBaseline[name] = { before: b.taskMs.p90, after: s.taskMs.p90, delta };
      check(delta <= 1, `${name}:每拍主线程耗时 p90 相对修复前涨幅 ≤ 1 ms`, out.vsBaseline[name]);
    }
  }
  out.pageErrors = errors;
} catch (error) {
  fails.push(`异常:${error?.stack || error}`);
} finally {
  out.fails = fails;
  out.notes = notes;
  await browser.close().catch(() => {});
  const text = JSON.stringify(out, null, 2);
  if (JSON_OUT) await fs.writeFile(JSON_OUT, text);
  console.log(text);
  console.log(fails.length ? `FAIL ${fails.length}` : 'PASS');
  process.exit(fails.length ? 1 : 0);
}
