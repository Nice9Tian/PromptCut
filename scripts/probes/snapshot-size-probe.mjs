/**
 * A3c 的体积实测:高频清单里每一张卡,在后台舞台上冻出控件快照,量**原始内联 HTML** 的字节数。
 *
 *   node scripts/probes/snapshot-size-probe.mjs [--origin http://127.0.0.1:5197]
 *        [--fps 30] [--clip-sec 4] [--cards a,b] [--limit N] [--no-projects]
 *        [--out docs/snapshot-size-audit.md] [--json out/snapshot-size-audit.json]
 *
 * 任务书 A3c 的三条上限:
 *   - DOM 卡:单 clip 单帧**原始**快照 ≤ 300 KB;
 *   - canvas 卡:位图走 `toDataURL('image/webp', 0.9)`(带 alpha),单帧 ≤ 1 MB;
 *   - 一次 `setSnapshots` 投递 ≤ 2 MB。
 * 「第 4 步准入前用高频清单实测原始体积一遍,超标就先做『相对 UA + 主题基线的差异样式内联』」——
 * 这个脚本就是那一遍。
 *
 * 高频清单(A0.3)= inventory `:19` 的 62 张(= 注册表里**非粒子卡全要 + 目录标 featured 的粒子卡**,
 * 也就是首次面板不搜索、不展开粒子时展示的那一批)+ 12 个 `hud-glass` 文件里的卡;
 * 本机 `.pc-work/opened/` 里的项目用到的卡也并进来。
 *
 * 量什么:
 *   - `createSnapshot`(`window.__pcCreateSnapshot`)返回的 `controls[0].html` —— 那就是包裹层 innerHTML,
 *     是快照投递的原始体积(投递前的 deflate + base64 另算,A3c 的编码后数已在任务书里);
 *   - 整场景 `html` 的体积(给「一次投递 ≤ 2 MB」做对照);
 *   - 控件里有没有 `<canvas` / `data:image`,以及位图占了多少 —— canvas 卡另立口径;
 *   - 生成快照本身的墙钟,按任务书 3.8 拆成样式内联 / 画布栅格化 / 序列化三段(不进判重,只排产能);
 *   - 最大的 10 张卡:把那份 html 赋给一个游离 div 的 `innerHTML`,量解析耗时,
 *     对照 A3c 的「拖动 3 秒内舞台主线程 `innerHTML` 解析合计 ≤ 200 ms」。
 *
 * 跑在 dev 模式的 dev server 上(`/src/*` 现场变换)。dev 与产物包的**体积**差别很小
 * (内联的是计算样式,不是源码),但**耗时**在 dev 下偏大,报告里注明。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/* ------------------------------------------------------------------ 参数 */

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => { const i = argv.indexOf(name); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback; };
const has = (name) => argv.includes(name);

const origin = (flag('--origin') || process.env.PC_STAGE_TEST_URL || 'http://127.0.0.1:5197').replace(/\/+$/, '');
const fps = Number(flag('--fps', '30')) || 30;
const clipSec = Number(flag('--clip-sec', '4')) || 4;
const cardsArg = flag('--cards');
const limit = Number(flag('--limit', '0')) || 0;
const outMd = flag('--out', 'docs/snapshot-size-audit.md');
const outJson = flag('--json', '');
const useProjects = !has('--no-projects');

const HOST_PATH = '/__snapshot-size-probe-host';
const KB = 1024, MB = 1024 * 1024;
const DOM_LIMIT = 300 * KB;
const CANVAS_LIMIT = 1 * MB;
const DELIVERY_LIMIT = 2 * MB;

/* ------------------------------------------------------------------ 清单 */

/** 12 个 hud-glass 文件里的卡 id(`grep -l hud-glass src/cards/native`,排除 .css / .md) */
function hudGlassIds() {
  const dir = path.join(ROOT, 'src/cards/native');
  const ids = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.tsx')) continue;
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    if (!text.includes('hud-glass')) continue;
    const m = text.match(/^\s{0,2}id:\s*"([a-z0-9-]+)"/m);
    if (m) ids.push(m[1]);
  }
  return ids;
}

/** 本机打开过的项目里用到的卡(A0.3:「本机有 .pc-work/opened/ 项目就加进来」) */
function openedProjectIds() {
  const dir = path.join(ROOT, '.pc-work/opened');
  const ids = new Set();
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  for (const entry of entries) {
    const file = entry.isDirectory() ? path.join(dir, entry.name, 'project.proc') : path.join(dir, entry.name);
    let doc;
    try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    const proj = doc?.project ?? doc;
    for (const track of proj?.tracks ?? []) for (const clip of track.clips ?? []) if (clip.cardId) ids.add(clip.cardId);
  }
  return [...ids];
}

/* ------------------------------------------------------------------ 宿主页 */

const hostHtml = `<!doctype html><html><head><meta charset="utf-8"><title>snapshot size probe host</title>
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
<iframe id="f" src="/?stage=1&id=B&prerender=1" style="width:1920px;height:1080px;border:0;display:block"></iframe>
<script type="module">
function createStageRpc(target) {
  let nextId = 1; const pending = new Map();
  window.addEventListener('message', (e) => {
    if (e.source !== target) return; const d = e.data;
    if (d && d.type === 'pc-rpc-reply') { const p = pending.get(d.id); if (!p) return; pending.delete(d.id); d.ok ? p.resolve(d.result) : p.reject(new Error(d.error)); }
  });
  const call = (method) => (...args) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); target.postMessage({ type: 'pc-rpc', id, method, args }, location.origin); });
  const c = {};
  for (const m of ['setProject','setTime','render','setRole','size']) c[m] = call(m);
  return c;
}
const f = document.getElementById('f');
window.__ready = new Promise((res, rej) => {
  setTimeout(() => rej(new Error('stage ready timeout')), 180000);
  window.addEventListener('message', (e) => {
    if (e.source !== f.contentWindow || e.data?.type !== 'pc-stage-ready') return;
    window.__caps = e.data.hostCapabilities;
    window.__rpc = createStageRpc(f.contentWindow);
    res(true);
  });
});

window.__kit = (async () => {
  await import('/src/cards/index.ts');
  const registry = await import('/src/kernel/registry.ts');
  const { cardFrameMode, reviewedCard } = await import('/src/kernel/frameMode.mjs');
  const assets = await import('/src/cards/assets/index.ts');
  return { ...registry, cardFrameMode, reviewedCard, featuredParticleIds: assets.featuredParticleIds };
})();

/** inventory :19 的 62 张:非粒子卡全要 + 目录标 featured 的粒子卡 */
window.__defaultVisibleIds = async () => {
  const kit = await window.__kit;
  return kit.allCards().map((c) => c.id).filter((id) => !id.startsWith('particles-') || kit.featuredParticleIds.has(id));
};
window.__knownIds = async () => (await window.__kit).allCards().map((c) => c.id);
window.__cardMeta = async (ids) => {
  const kit = await window.__kit;
  return ids.map((id) => { const def = kit.getCard(id); return def ? { id, source: def.source || 'native',
    mode: kit.cardFrameMode(def, def.defaults), canvasHeavy: !!kit.reviewedCard(id)?.canvasHeavy } : { id, missing: true }; });
};

window.__mkProject = (cardId, fps, lenSec) => ({
  version: 1, id: 'probe', name: 'probe', width: 1920, height: 1080, fps, duration: lenSec,
  themeId: 'midnight', media: [],
  tracks: [{ id: 'probe-track', clips: [{ id: 'c0', cardId, start: 0, end: lenSec, params: {} }] }],
});

const enc = new TextEncoder();
const bytes = (s) => enc.encode(s || '').length;
const DATA_IMG = /data:image\\/[a-z0-9.+-]+;base64,[A-Za-z0-9+\\/=]+/g;
const dataImageBytes = (s) => { let n = 0; for (const m of (s || '').match(DATA_IMG) || []) n += m.length; return n; };
// 内联计算样式占了多少 —— 「相对 UA + 主题基线的差异样式内联」能省下的就是这一块
const STYLE_ATTR = /style="[^"]*"/g;
const styleBytes = (s) => { let n = 0; for (const m of (s || '').match(STYLE_ATTR) || []) n += m.length; return n; };

/** 最大的十来张卡留一份 html 在页面里,给解析计时用 */
window.__kept = new Map();
const KEEP = 14;
function keep(id, html) {
  window.__kept.set(id, html);
  if (window.__kept.size <= KEEP) return;
  const worst = [...window.__kept.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, KEEP);
  window.__kept = new Map(worst);
}

/**
 * 等卡片真正挂起来再开测。canvas 卡(three.js / tsParticles)是**异步装载**的:
 * 模块 import、WebGL 上下文、纹理都要跨任务边界,只等 120 ms 的话经常测到一个还没有画布的空壳
 * ——实测同一张 particles-basic,等得够就是 658 KB(内联位图),等不够就是 18 KB(什么都没有)。
 * 所以按审阅表的 canvasHeavy 轮询到画布出现为止。
 */
window.__settleMount = async (job) => {
  const w = f.contentWindow;
  await new Promise((r) => setTimeout(r, 150));
  if (!job.canvasHeavy) return;
  for (let i = 0; i < 100; i++) {
    const cv = w.document.querySelector('[data-pc-clip] canvas');
    if (cv && cv.width > 1) { await new Promise((r) => setTimeout(r, 150)); return; }
    await new Promise((r) => setTimeout(r, 50));
  }
};

window.__measure = async (job) => {
  const rpc = window.__rpc, w = f.contentWindow;
  const { cardId, fps, lenSec, mode } = job;
  await rpc.setRole('back', { job: 'probe' });
  await rpc.setProject(window.__mkProject(cardId, fps, lenSec), { reset: true });
  await rpc.setTime(0);
  await window.__settleMount(job);

  // 三个本地时刻:入场后一点、正中、收尾前一点
  const times = [0.3, lenSec / 2, Math.max(0.3, lenSec - 0.1)].map((t) => Math.min(t, Math.max(0, lenSec - 1 / fps)));
  const samples = [];
  for (const t of times) {
    if (mode === 'direct') await rpc.setTime(t);
    else await rpc.render(t, { jump: true, maxCatchUp: Infinity });   // 推帧卡必须真推到那一刻,否则量的是初始态
    await new Promise((r) => setTimeout(r, 0));   // 让 settle 那一拍微任务跑掉
    const t0 = w.__pcRealNow();
    const snap = w.__pcCreateSnapshot();
    const snapshotMs = w.__pcRealNow() - t0;
    const control = snap.controls[0];
    const html = control ? control.html : '';
    samples.push({
      t, snapshotMs, inlineMs: snap.timing.inlineMs, rasterMs: snap.timing.rasterMs, serializeMs: snap.timing.serializeMs,
      lossy: snap.lossy, controls: snap.controls.length,
      controlBytes: bytes(html), sceneBytes: bytes(snap.html),
      // createSnapshot 已经把 <canvas> 换成同尺寸的 <img data:…>,所以不能按标签判;
      // 用审阅表的 canvasHeavy,再用「有没有内联位图」兜一层
      hasCanvas: !!job.canvasHeavy || dataImageBytes(html) > 0,
      imgBytes: dataImageBytes(html), styleBytes: styleBytes(html),
      nodes: control ? (html.match(/</g) || []).length : 0,
    });
    if (html) keep(cardId, html);
  }
  const big = samples.reduce((m, s) => (s.controlBytes > m.controlBytes ? s : m), samples[0]);
  return { cardId, mode, samples, max: big };
};

/** 解析耗时:游离 div 的 innerHTML(不进文档,量的是解析 + 建树,不含布局) */
window.__parseTimes = (ids, reps) => ids.map((id) => {
  const html = window.__kept.get(id);
  if (!html) return { id, ms: null };
  const each = [];
  for (let i = 0; i < reps; i++) {
    const div = document.createElement('div');
    const t0 = performance.now();
    div.innerHTML = html;
    each.push(performance.now() - t0);
  }
  each.sort((a, b) => a - b);
  return { id, bytes: new TextEncoder().encode(html).length, ms: each[Math.floor(each.length / 2)], min: each[0], max: each[each.length - 1] };
});
</script></body></html>`;

/* ------------------------------------------------------------------ 工具 */

const kb = (n) => (n / KB).toFixed(1);
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0; };
function table(rows, columns) {
  const head = columns.map((c) => c.title);
  const body = rows.map((r) => columns.map((c) => String(c.get(r) ?? '')));
  const width = head.map((h, i) => Math.max([...h].length, ...body.map((r) => [...r[i]].length), 1));
  const line = (cells) => cells.map((c, i) => (i === 0 ? c.padEnd(width[i]) : c.padStart(width[i]))).join('  ');
  return [line(head), width.map((w) => '-'.repeat(w)).join('  '), ...body.map(line)].join('\n');
}
function mdTable(headers, rows) {
  return [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

/** 归族:报告按族给 p50 / p90 / max */
function familyOf(meta, hud) {
  if (meta.id.startsWith('particles-')) return 'particles-*(canvas)';
  if (meta.id.startsWith('lottie-')) return 'lottie-*(DOM/SVG)';
  if (meta.id === 'scene-3d' || meta.id === 'terminal-3d' || meta.id === 'particles') return 'three.js / canvas 通用卡';
  if (meta.source === 'magicui') return 'MagicUI';
  if (hud.has(meta.id)) return 'hud-glass 自家卡';
  return '其它自家卡';
}

/* ------------------------------------------------------------------ 主流程 */

const browser = await puppeteer.launch({
  headless: true,
  // 关掉后台节流:舞台补跑每 8 帧让出一个真 setTimeout(stageClock 的 yieldEvery),
  // 被后台页节流成 1 秒一次的话一张卡要跑几十秒,量出来的也不是卡自己的代价。
  args: ['--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
});
let exitCode = 0;
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
  await page.goto(origin + HOST_PATH, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.evaluate(() => window.__ready);
  await page.evaluate(async () => { await window.__kit; return true; });

  const hud = new Set(hudGlassIds());
  const known = new Set(await page.evaluate(() => window.__knownIds()));
  let ids;
  const fromProjects = [];
  if (cardsArg) {
    ids = cardsArg.split(',').map((s) => s.trim()).filter(Boolean);
  } else {
    const visible = await page.evaluate(() => window.__defaultVisibleIds());
    const set = new Set(visible);
    for (const id of hud) set.add(id);
    if (useProjects) {
      for (const id of openedProjectIds()) {
        if (!known.has(id)) continue;                 // .proc 内嵌卡不在注册表里,跳过并在报告里说明
        if (!set.has(id)) fromProjects.push(id);
        set.add(id);
      }
    }
    ids = [...set];
  }
  ids = ids.filter((id) => known.has(id));
  if (limit) ids = ids.slice(0, limit);

  const metas = await page.evaluate((x) => window.__cardMeta(x), ids);
  console.log(`高频清单 ${ids.length} 张(hud-glass ${hud.size} 张,其中 ${fromProjects.length} 张由 .pc-work/opened/ 补入)\n`);

  const results = [];
  for (const [i, meta] of metas.entries()) {
    process.stdout.write(`[${i + 1}/${metas.length}] ${meta.id} … `);
    try {
      const out = await page.evaluate((j) => window.__measure(j), { cardId: meta.id, fps, lenSec: clipSec, mode: meta.mode, canvasHeavy: !!meta.canvasHeavy });
      out.family = familyOf(meta, hud);
      out.source = meta.source;
      results.push(out);
      console.log(`${kb(out.max.controlBytes)} KB${out.max.hasCanvas ? ' (canvas)' : ''}`);
    } catch (err) {
      console.log('失败:' + String(err && err.message || err));
      results.push({ cardId: meta.id, family: familyOf(meta, hud), source: meta.source, error: String(err && err.message || err) });
    }
  }

  const ok = results.filter((r) => !r.error);
  const canvasCards = ok.filter((r) => r.max.hasCanvas);
  const domCards = ok.filter((r) => !r.max.hasCanvas);

  /* ---- 解析耗时:最大的 10 张 */
  const largest = [...ok].sort((a, b) => b.max.controlBytes - a.max.controlBytes).slice(0, 10).map((r) => r.cardId);
  const parse = await page.evaluate((ids, reps) => window.__parseTimes(ids, reps), largest, 5);

  /* ---- 打印 */
  console.log('\n= 每卡最大的一帧(三个时刻里最大的那个) =\n');
  console.log(table([...ok].sort((a, b) => b.max.controlBytes - a.max.controlBytes), [
    { title: 'card', get: (r) => r.cardId },
    { title: 'family', get: (r) => r.family },
    { title: 'mode', get: (r) => r.mode },
    { title: 'controlKB', get: (r) => kb(r.max.controlBytes) },
    { title: 'sceneKB', get: (r) => kb(r.max.sceneBytes) },
    { title: 'imgKB', get: (r) => kb(r.max.imgBytes) },
    { title: 'styleKB', get: (r) => kb(r.max.styleBytes) },
    { title: 'style%', get: (r) => (r.max.controlBytes ? Math.round(r.max.styleBytes * 100 / r.max.controlBytes) + '%' : '') },
    { title: 'canvas', get: (r) => (r.max.hasCanvas ? 'yes' : '') },
    { title: 'lossy', get: (r) => (r.max.lossy ? String(r.max.lossy) : '') },
    { title: 'tags', get: (r) => r.max.nodes },
    { title: 'snapMs', get: (r) => r.max.snapshotMs.toFixed(1) },
    { title: 'inlineMs', get: (r) => r.max.inlineMs.toFixed(1) },
    { title: 'rasterMs', get: (r) => r.max.rasterMs.toFixed(1) },
    { title: 'serialMs', get: (r) => r.max.serializeMs.toFixed(1) },
    { title: 'over', get: (r) => (r.max.controlBytes > (r.max.hasCanvas ? CANVAS_LIMIT : DOM_LIMIT) ? 'OVER' : '') },
  ]));

  const families = [...new Set(ok.map((r) => r.family))].sort();
  const familyRows = families.map((fam) => {
    const list = ok.filter((r) => r.family === fam).map((r) => r.max.controlBytes);
    return { fam, n: list.length, p50: pct(list, 0.5), p90: pct(list, 0.9), max: Math.max(...list) };
  });
  console.log('\n= 按族 =\n');
  console.log(table(familyRows, [
    { title: 'family', get: (r) => r.fam },
    { title: 'n', get: (r) => r.n },
    { title: 'p50 KB', get: (r) => kb(r.p50) },
    { title: 'p90 KB', get: (r) => kb(r.p90) },
    { title: 'max KB', get: (r) => kb(r.max) },
  ]));

  console.log('\n= innerHTML 解析(最大的 10 张,游离 div,5 次取中位) =\n');
  console.log(table(parse, [
    { title: 'card', get: (r) => r.id },
    { title: 'KB', get: (r) => (r.bytes ? kb(r.bytes) : '—') },
    { title: 'medianMs', get: (r) => (r.ms === null ? '—' : r.ms.toFixed(2)) },
    { title: 'minMs', get: (r) => (r.min === undefined ? '—' : r.min.toFixed(2)) },
    { title: 'maxMs', get: (r) => (r.max === undefined ? '—' : r.max.toFixed(2)) },
  ]));

  const allBytes = ok.map((r) => r.max.controlBytes);
  const overDom = domCards.filter((r) => r.max.controlBytes > DOM_LIMIT);
  const overCanvas = canvasCards.filter((r) => r.max.controlBytes > CANVAS_LIMIT);
  const p90All = pct(allBytes, 0.9);
  const parseMedian = parse.filter((p) => p.ms !== null).map((p) => p.ms);

  /* ---- 报告 */
  const now = new Date().toLocaleDateString('sv-SE');   // 本地日期(sv-SE 就是 YYYY-MM-DD)
  const md = `# A3c 快照体积审计（高频清单实测）

实测日期 ${now}。跑法：\`node scripts/probes/snapshot-size-probe.mjs --origin ${origin}\`，
dev 模式的 dev server（\`/src/*\` 现场变换），后台舞台（\`?stage=1&id=B\`，\`setRole('back', { job: 'probe' })\`）。
每张卡一条轨道一个 \`${clipSec}\` 秒的 clip、参数取默认值，fps ${fps}；在 0.3 s / 中点 / 收尾前 0.1 s 三个本地时刻各生成一次快照
（\`stateful\` 卡用 \`render(t, { jump: true, maxCatchUp: Infinity })\` 真推到那一刻，\`direct\` 卡用 \`setTime(t)\`），
取三次里最大的一帧。量的是 \`window.__pcCreateSnapshot()\` 回来的 \`controls[0].html\` —— 也就是包裹层 innerHTML、
差异样式已内联的**原始**体积，不含投递前的 deflate + base64。

机器：${(await page.evaluate(() => navigator.userAgent))}。

## 1. 三条上限（任务书 A3c）

| 口径 | 上限 |
|---|---|
| DOM 卡：单 clip 单帧原始快照 | **≤ 300 KB** |
| canvas 卡：位图 \`toDataURL('image/webp', 0.9)\`（带 alpha），单帧 | **≤ 1 MB** |
| 一次 \`setSnapshots(patch, opts)\` 投递 | **≤ 2 MB** |

「相对 UA + 主题基线的差异样式内联」已在 R1 落地（\`src/render/snapshot/inlineStyles.ts\`），
本次实测是落地**之后**的数。

## 2. 清单与总览

- 高频清单 ${ids.length} 张 = inventory \`:19\` 的默认可见卡（非粒子卡全要 + 目录标 \`featured\` 的粒子卡）
  + 12 个 \`hud-glass\` 文件里的卡${fromProjects.length ? `，另由 \`.pc-work/opened/\` 的项目补入 ${fromProjects.length} 张（${fromProjects.join('、')}）` : ''}。
- 测通 ${ok.length} 张，失败 ${results.length - ok.length} 张。
- 全体最大帧：p50 **${kb(pct(allBytes, 0.5))} KB**、p90 **${kb(p90All)} KB**、max **${kb(Math.max(...allBytes))} KB**。
- 超 300 KB 的 DOM 卡 **${overDom.length}** 张；超 1 MB 的 canvas 卡 **${overCanvas.length}** 张。
- 按 p90 估一次「10 张活跃卡全换」的投递：约 **${(p90All * 10 / MB).toFixed(2)} MB**${p90All * 10 > DELIVERY_LIMIT ? `，> 2 MB，得按 A3c 拆成两次投递` : '，在 2 MB 以内'}。

## 3. 按 DOM / canvas 分列的 p50 / p90 / max

差异样式内联的验收口径是**分列**的（任务书 A2(8)：「不要拿 62 张混算的 p90 当门槛」）——
全体 p50 / p90 那两个样本落在粒子 canvas 卡上，而差异样式内联碰不到它们的位图。

${(() => {
  const domNoLottie = domCards.filter((r) => !r.cardId.startsWith('lottie-'));
  const row = (name, list, get = (r) => r.max.controlBytes) => {
    const xs = list.map(get);
    return [name, String(list.length), kb(pct(xs, 0.5)), kb(pct(xs, 0.9)), kb(Math.max(...xs, 0))];
  };
  return mdTable(['口径', '张数', 'p50 KB', 'p90 KB', 'max KB'], [
    row('**DOM 卡**（门槛 300 KB）', domCards),
    row('DOM 卡（排除 `lottie-*`）', domNoLottie),
    row('**canvas 卡**位图（门槛 1 MB）', canvasCards, (r) => r.max.imgBytes),
    row('canvas 卡整份 control', canvasCards),
    row('全体（仅供对照，不是门槛）', ok),
  ]);
})()}

## 3b. 按族的 p50 / p90 / max

${mdTable(['族', '张数', 'p50 KB', 'p90 KB', 'max KB'], familyRows.map((r) => [r.fam, String(r.n), kb(r.p50), kb(r.p90), kb(r.max)]))}

## 4. 超标的卡

${overDom.length === 0 && overCanvas.length === 0 ? '本次实测没有卡超过对应口径的上限。' : ''}${overDom.length ? `### 4.1 DOM 卡超 300 KB（${overDom.length} 张）

${mdTable(['卡', '族', '最大帧 KB', '整场景 KB', '标签数', '内联样式 KB', '样式占比', '建议'],
  [...overDom].sort((a, b) => b.max.controlBytes - a.max.controlBytes)
    .map((r) => [r.cardId, r.family, kb(r.max.controlBytes), kb(r.max.sceneBytes), String(r.max.nodes), kb(r.max.styleBytes),
      r.max.controlBytes ? Math.round(r.max.styleBytes * 100 / r.max.controlBytes) + '%' : '—',
      '差异样式内联已落地；仍超标的两条路见任务书 R1 末条（改走 lottie 的 canvas 渲染器 / 审阅表标 \`prerender: false\`）']))}
` : ''}${overCanvas.length ? `### 4.2 canvas 卡超 1 MB（${overCanvas.length} 张）

${mdTable(['卡', '族', '最大帧 KB', '其中位图 KB', '建议'],
  [...overCanvas].sort((a, b) => b.max.controlBytes - a.max.controlBytes)
    .map((r) => [r.cardId, r.family, kb(r.max.controlBytes), kb(r.max.imgBytes), 'M4 的 `toDataURL` 换成 `image/webp` 0.9；仍超标的裁到实体框']))}
` : ''}
## 5. 逐卡（三个时刻里最大的一帧）

${mdTable(['卡', '族', '帧模式', '控件 KB', '整场景 KB', '其中位图 KB', '内联样式 KB', '样式占比', 'canvas', '标签数', '生成快照 ms', '样式内联 ms', '画布栅格化 ms', '序列化 ms'],
  [...ok].sort((a, b) => b.max.controlBytes - a.max.controlBytes).map((r) => [
    r.cardId, r.family, r.mode, kb(r.max.controlBytes), kb(r.max.sceneBytes), kb(r.max.imgBytes), kb(r.max.styleBytes),
    r.max.controlBytes ? Math.round(r.max.styleBytes * 100 / r.max.controlBytes) + '%' : '—',
    r.max.hasCanvas ? '是' : '', String(r.max.nodes), r.max.snapshotMs.toFixed(1),
    r.max.inlineMs.toFixed(1), r.max.rasterMs.toFixed(1), r.max.serializeMs.toFixed(1)]))}

${results.filter((r) => r.error).length ? `失败的卡：${results.filter((r) => r.error).map((r) => `\`${r.cardId}\`（${r.error}）`).join('、')}` : ''}

## 6. \`innerHTML\` 解析耗时

A3c 的预算是「拖动 3 秒内舞台主线程 \`innerHTML\` 解析合计 ≤ 200 ms」。把最大的 10 张卡的快照各赋给一个
**游离 div** 的 \`innerHTML\`（不进文档，所以量的是解析 + 建树，不含布局与绘制），5 次取中位：

${mdTable(['卡', 'KB', '中位 ms', '最快 ms', '最慢 ms'], parse.map((p) => [p.id, p.bytes ? kb(p.bytes) : '—', p.ms === null ? '—' : p.ms.toFixed(2), p.min === undefined ? '—' : p.min.toFixed(2), p.max === undefined ? '—' : p.max.toFixed(2)]))}

这 10 张里中位 **${parseMedian.length ? (parseMedian.reduce((a, b) => a + b, 0) / parseMedian.length).toFixed(2) : '—'} ms**、最慢 **${parseMedian.length ? Math.max(...parseMedian).toFixed(2) : '—'} ms**。
C4 拖一格通常只换一两张卡；按最慢的一张算，3 秒 90 格里能换 **${parseMedian.length ? Math.floor(200 / Math.max(...parseMedian)) : '—'}** 次最大的卡还留在 200 ms 预算里。

## 7. 顺带记下的两件事

- **\`createSnapshot\` 的耗时**（上表最后四列）量的是整场景一次生成快照。按任务书 3.8，它**不进判重** ——
  判重只看活渲的 \`stepMs\`（生成快照只在探针和预渲染时发生，活渲每拍并不做），这三段只用来排
  探针和预渲染的产能。本次实测整场景一次在 ${(() => { const f = ok.map((r) => r.max.snapshotMs); return `${pct(f, 0.5).toFixed(0)}～${Math.max(...f).toFixed(0)}`; })()} ms 量级
  （B = 1000/${fps} × 70% = ${((1000 / fps) * 0.7).toFixed(1)} ms，仅供对照）。dev 模式偏慢是一部分原因，
  另一部分是样式内联对场景里**每一个元素**都要 \`getComputedStyle\`。
  哪类卡贵一眼可见：样式内联高 = DOM 太复杂，画布栅格化高 = 画布太大。
- **canvas 位图现在还是 PNG**：\`snapshot/rasterizeCanvas.ts\` 里是 \`toDataURL()\`（默认 PNG）。A3c 要求换成
  \`toDataURL('image/webp', 0.9)\`，那是 M4 的改动，本审计只按现状量。
`;

  const outPath = path.resolve(ROOT, outMd);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, md, 'utf8');
  console.log(`\n报告写到 ${outPath}`);
  if (outJson) {
    const jsonPath = path.resolve(ROOT, outJson);
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify({ origin, fps, clipSec, results, parse, familyRows }, null, 2), 'utf8');
    console.log(`原始数据写到 ${jsonPath}`);
  }

  const noise = errors.filter((e) => !/favicon|React DevTools|Failed to load resource|websocket|WebSocket/i.test(e));
  if (noise.length) {
    console.log(`\n页面报错 ${noise.length} 条(前 5 条):`);
    for (const e of noise.slice(0, 5)) console.log('  ' + e);
  }
} catch (err) {
  console.error(err && err.stack || err);
  exitCode = 1;
} finally {
  await browser.close();
}
process.exit(exitCode);
