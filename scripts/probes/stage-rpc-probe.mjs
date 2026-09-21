/**
 * E0 / 第 3 步验收探针:用一张「测试页」把舞台 iframe(?stage=1)当后台舞台驱动,只经 postMessage RPC。
 *
 *   node scripts/probes/stage-rpc-probe.mjs [--origin http://127.0.0.1:5197]
 *
 * 验的就是任务书第 3 步那几条:
 *   - RPC 全部正常、所有时间参数是秒;握手带 hostCapabilities(J4);
 *   - 暂停时拖播放头 60 次(含往回拖和跳 60 秒):playToken 不变(包裹层 DOM 元素同一个)、
 *     每次 setTime 舞台主线程 ≤ 5 ms(不 advanceTo);
 *   - render 只验方法本身:setRole('back') 后直接调 —— Promise 在推帧完成后才 resolve、
 *     回包带 remounted / caughtUpAtSec / elapsedMs;两次连发第一次回 { aborted: true, reason: 'superseded' };
 *     setProject 掐掉在飞的 render 回 { aborted: true, reason: 'project' };
 *     render({ probe: true }) 每帧 post 一条 probe-frame,frames 与事件数一致;
 *   - hitTest / rectsWithBounds 照常工作,17 轨 × 10 卡下 rectsWithBounds({ pixels: 'selected' }) ≤ 5 ms;
 *   - 舞台页挂了 __pcCreateSnapshot,快照的 controls 是包裹层 innerHTML(不含 data-pc-clip)。
 *
 * 测试页由 puppeteer 请求拦截临时提供(同源,免得 CORS / postMessage 的 targetOrigin 问题),仓库里不留静态页。
 * 输出 JSON 结论到 stdout;任何一条不过就以非零退出。
 */
import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
const origin = (args.includes('--origin') ? args[args.indexOf('--origin') + 1] : null) || process.env.PC_STAGE_TEST_URL || 'http://127.0.0.1:5197';
const HOST_PATH = '/__stage-rpc-probe-host';

const hostHtml = `<!doctype html><html><head><meta charset="utf-8"><title>stage rpc probe host</title></head>
<body style="margin:0;background:#222">
<iframe id="f" src="/?stage=1&id=back&prerender=1" style="width:1920px;height:1080px;border:0;display:block"></iframe>
<script type="module">
// 一个最小的 RPC 客户端(和 src/render/stageRpc.ts 同一协议),内联在这里是为了同一份探针也能打 vite preview 的产物包(那里没有 /src/*.ts)
function createStageRpc(target) {
  let nextId = 1; const pending = new Map(); const listeners = new Set();
  window.addEventListener('message', (e) => {
    if (e.source !== target) return; const d = e.data;
    if (d && d.type === 'pc-rpc-reply') { const p = pending.get(d.id); if (!p) return; pending.delete(d.id); d.ok ? p.resolve(d.result) : p.reject(new Error(d.error)); return; }
    if (d && typeof d.type === 'string' && ['mediaReady', 'frame', 'ended', 'settled', 'probe', 'demote', 'probe-frame'].includes(d.type)) for (const l of listeners) l(d);
  });
  const call = (method) => (...args) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); target.postMessage({ type: 'pc-rpc', id, method, args }, location.origin); });
  const c = { onEvent: (l) => { listeners.add(l); return () => listeners.delete(l); } };
  for (const m of ['setProject', 'setTime', 'render', 'hitTest', 'rectsWithBounds', 'size', 'setProxy', 'setRole', 'setPlan', 'play', 'pause', 'setSuppressed', 'setStreamPlanes', 'setScrubbing', 'setPlaying', 'setMediaT', 'setLocalHashes', 'setSnapshots']) c[m] = call(m);
  return c;
}
const f = document.getElementById('f');
window.__events = [];
window.__ready = new Promise((res) => {
  window.addEventListener('message', (e) => {
    if (e.source !== f.contentWindow || e.data?.type !== 'pc-stage-ready') return;
    window.__caps = e.data.hostCapabilities;
    window.__rpc = createStageRpc(f.contentWindow);
    window.__rpc.onEvent((ev) => window.__events.push(ev.type === 'probe-frame' ? { ...ev, html: ev.html.length } : ev));
    res(true);
  });
});
</script></body></html>`;

const fails = [];
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); return cond; };

const browser = await puppeteer.launch({ headless: true, args: ['--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1'] });
const out = {};
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
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('response', (r) => { if (r.status() >= 400 && !/favicon/.test(r.url())) errors.push(`HTTP ${r.status()} ${r.url()}`); });
  await page.goto(origin + HOST_PATH, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.evaluate(() => Promise.race([window.__ready, new Promise((_, rej) => setTimeout(() => rej(new Error('stage ready timeout')), 120000))]));
  out.caps = await page.evaluate(() => window.__caps);
  check(out.caps && typeof out.caps.prerender === 'boolean' && out.caps.stageId === 'back' && typeof out.caps.lowMemory === 'boolean' && typeof out.caps.offscreenGl === 'boolean', 'handshake carries hostCapabilities', out.caps);

  // ---- 项目:3 条轨道的小项目 + 17 轨 × 10 卡的大项目
  const mkProject = await page.evaluate(async () => {
    // 空项目的形状照 src/kernel/project.ts 的 createEmptyProject(这里不 import,好让探针也能打产物包)
    window.__mk = (tracks, extra = {}) => ({ version: 1, id: 'probe', name: 'probe', width: 1920, height: 1080, fps: 30, duration: 60, themeId: 'midnight', media: [], tracks, ...extra });
    return true;
  });
  check(mkProject, 'project factory');
  const small = await page.evaluate(() => window.__mk([
    { id: 'tr-a', clips: [{ id: 'c-pill', cardId: 'punch-pill', start: 0, end: 10, params: { text: 'RPC 探针' } }, { id: 'c-pill2', cardId: 'punch-pill', start: 20, end: 30, params: { text: '后半段' } }] },
    { id: 'tr-b', clips: [{ id: 'c-odo', cardId: 'odometer', start: 0, end: 60, params: {} }] },
    { id: 'tr-c', clips: [{ id: 'c-3d', cardId: 'scene-3d', start: 0, end: 60, params: {} }] },
  ]));
  const big = await page.evaluate(() => window.__mk(Array.from({ length: 17 }, (_, ti) => ({
    id: 'big-' + ti,
    clips: Array.from({ length: 10 }, (_, ci) => ({ id: `b-${ti}-${ci}`, cardId: ci % 2 ? 'odometer' : 'punch-pill', start: ci * 6, end: ci * 6 + 6, params: ci % 2 ? {} : { text: 'k' + ti + ci } })),
  }))));

  const domOnly = await page.evaluate(() => window.__mk([
    { id: 'tr-a', clips: [{ id: 'c-pill', cardId: 'punch-pill', start: 0, end: 10, params: { text: 'RPC 探针' } }, { id: 'c-pill2', cardId: 'punch-pill', start: 20, end: 30, params: { text: '后半段' } }] },
    { id: 'tr-b', clips: [{ id: 'c-odo', cardId: 'odometer', start: 0, end: 60, params: {} }] },
  ]));

  // ---- setProject full + reset。60 次拖动的 ≤ 5 ms 在「两张 DOM 卡」的项目上量:setTime 自己的机器开销 ≈ 0.3 ms(空项目),
  // 其余全是卡片自己那一次 React 渲染(实测 odometer ≈ 2.4 ms、chapter-bar ≈ 1.7 ms、punch-pill ≈ 0.9 ms,dev 版 React),
  // 三维卡每次 t 变还要 three.js 出一帧 —— 那些是卡的代价,K1 探针会把慢的判重;这里只守 setTime 不做补跑(不 advanceTo)。
  const sp = await page.evaluate(async (p) => await window.__rpc.setProject(p, { reset: true }), domOnly);
  check(sp && sp.ok === true, 'setProject(full, reset) ok', sp);
  const st0 = await page.evaluate(async () => await window.__rpc.setTime(0.5));
  check(st0 && (st0.path === 'set' || st0.path === 'continuous'), 'setTime replies with path', st0);
  await new Promise((r) => setTimeout(r, 300));

  // 在舞台文档里包一层计时:量的是舞台主线程(真墙钟 __pcRealNow),不是 RPC 往返
  await page.evaluate(() => {
    const w = document.getElementById('f').contentWindow;
    w.__times = { setTime: [], rects: [] };
    const api = w.__pcStage;
    for (const m of ['setTime', 'rectsWithBounds']) {
      const orig = api[m];
      api[m] = async function (...a) { const t0 = w.__pcRealNow(); const r = await orig.apply(this, a); w.__times[m === 'setTime' ? 'setTime' : 'rects'].push(w.__pcRealNow() - t0); return r; };
    }
    for (const el of w.document.querySelectorAll('[data-pc-clip]')) el.__probeMark = 1;
    w.__marked = [...w.document.querySelectorAll('[data-pc-clip]')].map((el) => el.getAttribute('data-pc-clip'));
  });

  // ---- 60 次拖动:往前、往回、跳 60 秒
  const seq = [];
  for (let i = 0; i < 60; i++) {
    const r = i % 6;
    seq.push(r === 0 ? 55 + (i % 5) : r === 1 ? 0.2 : r === 2 ? 3.1 : r === 3 ? 1.0 : r === 4 ? 9.7 : 4.3);
  }
  const drag = await page.evaluate(async (seq) => {
    const w = document.getElementById('f').contentWindow;
    const paths = [];
    for (const t of seq) paths.push((await window.__rpc.setTime(t)).path);
    const wrappers = [...w.document.querySelectorAll('[data-pc-clip]')];
    // 只看整段都活跃的片段(c-odo 是 0~60s):c-pill 在 55s 时本来就该卸载、拖回 0.2s 再挂上
    const always = ['c-odo'];
    const kept = wrappers.filter((el) => always.includes(el.getAttribute('data-pc-clip'))).every((el) => el.__probeMark === 1) && always.every((id) => wrappers.some((el) => el.getAttribute('data-pc-clip') === id));
    const times = w.__times.setTime.slice(-seq.length);
    return { paths, kept, max: Math.max(...times), p90: [...times].sort((a, b) => a - b)[Math.floor(times.length * 0.9)], setPaths: paths.filter((p) => p === 'set').length };
  }, seq);
  out.drag = drag;
  check(drag.kept, 'wrappers (playToken) unchanged across 60 setTime', drag);
  check(drag.setPaths > 0 && drag.paths.every((p) => p === 'set' || p === 'continuous'), 'setTime paths', drag.paths.slice(0, 8));
  check(drag.p90 <= 5, 'setTime stage main thread p90 ≤ 5 ms', { p90: drag.p90, max: drag.max });

  // 同一组拖动在含三维卡的项目上再量一遍,只报数不判(卡自己的渲染代价)
  const drag3d = await page.evaluate(async (p, seq) => { // 含三维卡 + 3 张卡的项目:只报数
    const w = document.getElementById('f').contentWindow;
    await window.__rpc.setProject(p, { reset: true });
    await window.__rpc.setTime(0.5);
    await new Promise((r) => setTimeout(r, 300));
    w.__times.setTime = [];
    for (const t of seq) await window.__rpc.setTime(t);
    const times = w.__times.setTime;
    return { max: Math.max(...times), p90: [...times].sort((a, b) => a - b)[Math.floor(times.length * 0.9)] };
  }, small, seq);
  out.drag3d = drag3d;

  // ---- hitTest / rectsWithBounds on the small project
  await page.evaluate(async () => { await window.__rpc.setTime(2); });
  await new Promise((r) => setTimeout(r, 200));
  const geo = await page.evaluate(async () => {
    const all = await window.__rpc.rectsWithBounds({ pixels: 'all' });
    const sel = await window.__rpc.rectsWithBounds({ pixels: 'selected', clipIds: ['c-odo'] });
    const b = all.find((r) => r.clipId === 'c-odo')?.bounds;
    const hit = b ? await window.__rpc.hitTest(b.left + b.width / 2, b.top + b.height / 2) : null;
    const size = await window.__rpc.size();
    const c3 = all.find((r) => r.clipId === 'c-3d');
    return { ids: all.map((r) => r.clipId), selIds: sel.map((r) => r.clipId), b, hit, size, c3 };
  });
  out.geo = geo;
  check(geo.size.width === 1920 && geo.size.height === 1080, 'size() is the project size', geo.size);
  check(geo.ids.includes('c-odo') && geo.ids.includes('c-pill') && !geo.ids.includes('c-pill2'), 'rectsWithBounds lists active clips only', geo.ids);
  check(geo.b && Number.isFinite(geo.b.left) && geo.b.width > 0 && geo.b.width < 1920, 'odometer bounds is a finite content box smaller than the stage', geo.b);
  check(geo.hit && geo.hit.clipId === 'c-odo', 'hitTest at the odometer content centre hits it', geo.hit);
  check(geo.c3 && geo.c3.bounds && geo.c3.bounds.width < 1920 * 0.95, 'scene-3d bounds (pixels: all) is not the whole canvas', geo.c3);

  // ---- 冻结面(先拨到三维卡已经画出东西的时刻;0.7s 时它还是空画布,画布像素扫不到就不写实体框)
  await page.evaluate(async () => { await window.__rpc.setTime(2); await new Promise((r) => setTimeout(r, 800)); });
  const frozen = await page.evaluate(() => {
    const w = document.getElementById('f').contentWindow;
    const f = w.__pcCreateSnapshot();
    const c3 = f.controls.find((c) => c.id === 'c-3d');
    // 不用 <img[^>]* 正则:内联样式几十万字节,回溯太慢;直接找属性
    const pi = c3 ? c3.html.indexOf('data-pc-painted-box="') : -1;
    const painted = pi >= 0 ? /^(\d+),(\d+),(\d+),(\d+)/.exec(c3.html.slice(pi + 21, pi + 60)) : null;
    return { controls: f.controls.length, first: f.controls[0] ? { id: f.controls[0].id, hasClipAttr: /data-pc-clip=/.test(f.controls[0].html), hasProxyPlane: /data-pc-proxy-plane/.test(f.controls[0].html), len: f.controls[0].html.length } : null, sceneAttr: /data-pc-scene/.test(f.html), painted: painted ? painted.slice(1).map(Number) : null, canvasLeft: c3 ? /<canvas/.test(c3.html) : null };
  });
  out.frozen = frozen;
  check(frozen.controls > 0 && frozen.first && !frozen.first.hasClipAttr && !frozen.first.hasProxyPlane, 'stage __pcCreateSnapshot controls are wrapper innerHTML without data-pc-clip', frozen);
  // A2(4):三维卡的 canvas 换成了带 data-pc-painted-box 的 <img>,坐标是画布像素坐标(小于整块画布)
  check(frozen.painted && frozen.canvasLeft === false && frozen.painted[2] > 0 && frozen.painted[2] < 1920, 'frozen scene-3d canvas became <img data-pc-painted-box> in canvas pixel coords', frozen);

  // ---- 大项目:17 轨 × 10 卡的心跳耗时
  await page.evaluate(async (p) => { await window.__rpc.setProject(p, { reset: true }); await window.__rpc.setTime(1); }, big);
  await new Promise((r) => setTimeout(r, 800));
  const beat = await page.evaluate(async () => {
    const w = document.getElementById('f').contentWindow;
    w.__times.rects = [];
    for (let i = 0; i < 10; i++) await window.__rpc.rectsWithBounds({ pixels: 'selected', clipIds: ['b-3-0'] });
    const times = w.__times.rects;
    const n = (await window.__rpc.rectsWithBounds({ pixels: 'none' })).length;
    return { active: n, max: Math.max(...times), p50: [...times].sort((a, b) => a - b)[5] };
  });
  out.beat = beat;
  check(beat.active === 17, '17 active clips on the big project', beat);
  check(beat.p50 <= 5, "rectsWithBounds({pixels:'selected'}) p50 ≤ 5 ms on 17×10", beat);

  // ---- render:只验方法本身(setRole back)
  await page.evaluate(async (p) => { await window.__rpc.setProject(p, { reset: true }); }, small);
  const role = await page.evaluate(async () => ({ back: await window.__rpc.setRole('back', { job: 'probe' }), bake: await window.__rpc.setRole('back', { job: 'bake' }) }));
  check(role.back.ok === true && role.bake.ok === false && role.bake.reason === 'unsupported', 'setRole back ok / bake unsupported', role);
  const r1 = await page.evaluate(async () => {
    const w = document.getElementById('f').contentWindow;
    const before = w.__pcStageClock ? null : null;
    const t0 = w.__pcRealNow();
    const r = await window.__rpc.render(2.0, { jump: true, maxCatchUp: Infinity });
    const wall = w.__pcRealNow() - t0;
    return { r, wall, clockSec: w.__pcStageClock?.now?.() / 1000 ?? null, before };
  });
  out.render = r1;
  check(r1.r && r1.r.remounted === true && Math.abs(r1.r.caughtUpAtSec - 2.0) < 1e-6 && r1.r.elapsedMs > 0 && r1.r.elapsedMs <= r1.wall + 1, 'render(jump) resolves after catch-up with remounted / caughtUpAtSec / elapsedMs', r1);
  const pair = await page.evaluate(async () => {
    const p1 = window.__rpc.render(1.0, { jump: true, maxCatchUp: Infinity });
    const p2 = window.__rpc.render(1.5, { jump: true, maxCatchUp: Infinity });
    return { a: await p1, b: await p2 };
  });
  out.pair = pair;
  check(pair.a && pair.a.aborted === true && pair.a.reason === 'superseded', 'first of two back-to-back renders is superseded', pair.a);
  check(pair.b && pair.b.remounted === true && Math.abs(pair.b.caughtUpAtSec - 1.5) < 1e-6, 'second render completes', pair.b);
  const proj = await page.evaluate(async (p) => {
    const p1 = window.__rpc.render(5.0, { jump: true, maxCatchUp: Infinity });
    await new Promise((r) => setTimeout(r, 5));
    await window.__rpc.setProject({ ...p, themeId: p.themeId }, { reset: true });
    return await p1;
  }, small);
  out.proj = proj;
  check(proj && proj.aborted === true && proj.reason === 'project', 'setProject during render aborts it with reason project', proj);
  // 续推:不重挂载;倒退直接 superseded
  const cont = await page.evaluate(async () => {
    await window.__rpc.render(1.0, { jump: true, maxCatchUp: Infinity });
    const fwd = await window.__rpc.render(1.2, { maxCatchUp: Infinity });
    const back = await window.__rpc.render(0.5, {});
    return { fwd, back };
  });
  out.cont = cont;
  check(cont.fwd && cont.fwd.remounted === false && Math.abs(cont.fwd.caughtUpAtSec - 1.2) < 1e-6, 'continue-mode render does not remount', cont.fwd);
  check(cont.back && cont.back.aborted === true && cont.back.reason === 'superseded', 'continue-mode render backwards is superseded', cont.back);
  // probe:每帧一条 probe-frame
  const probe = await page.evaluate(async () => {
    window.__events.length = 0;
    const r = await window.__rpc.render(0.5, { jump: true, probe: true, maxCatchUp: Infinity, maxFrames: 6 });
    const evs = window.__events.filter((e) => e.type === 'probe-frame');
    const controls = new Set(evs.map((e) => e.clipId)).size;
    return { r, n: evs.length, controls, sample: evs[0] };
  });
  out.probe = probe;
  check(probe.r && (probe.r.frames * probe.controls === probe.n) && probe.n > 0 && probe.sample.html > 0 && typeof probe.sample.localFrame === 'number', 'render(probe) posts one probe-frame per frame and reports frames', probe);
  check(!probe.r.aborted || probe.r.reason === 'timeout', 'probe render ends normally or by timeout', probe.r);
  const stp = await page.evaluate(async () => await window.__rpc.setTime(0.7, { probe: true }));
  check(stp && stp.path === 'set' && typeof stp.elapsedMs === 'number' && stp.elapsedMs > 0, 'setTime(probe) replies elapsedMs on the set path', stp);

  // ---- 其余方法回包形状
  const misc = await page.evaluate(async () => ({
    play: await window.__rpc.play(0), pause: await window.__rpc.pause(),
    snaps: await window.__rpc.setSnapshots({ 'c-odo': '<div>x</div>', 'c-pill': null }, { reset: true }),
    plan: await window.__rpc.setPlan({ plan: {}, costs: [] }), lh: await window.__rpc.setLocalHashes([]), sup: await window.__rpc.setSuppressed([]),
    front: await window.__rpc.setRole('front'),
  }));
  out.misc = misc;
  check(misc.play.ok === false && misc.pause.ok === false, 'play/pause report unsupported in step 3', misc);
  check(misc.snaps.ok === true && misc.snaps.bytes === 12 && misc.plan.ok && misc.lh.ok && misc.sup.ok && misc.front.ok, 'misc replies', misc);
  out.pageErrors = errors.filter((e) => !/favicon|Download the React DevTools|Failed to load resource/i.test(e));
  check(out.pageErrors.length === 0, 'no page errors', out.pageErrors.slice(0, 5));
} catch (err) {
  fails.push('exception: ' + (err && err.stack || err));
} finally {
  await browser.close();
}
out.fails = fails;
console.log(JSON.stringify(out, null, 2));
process.exit(fails.length ? 1 : 0);
