/**
 * K1 的「离线那一半」:在后台舞台(角色 `back`、工作项 `probe`)逐张实测卡片代价,
 * 结果按 `(identityKey, device)` 写进 `out/card-costs.json`(`GET/PUT /api/data/costs`)。
 *
 *   node scripts/probe-card-costs.mjs [--origin http://127.0.0.1:5197]
 *                                     [--cards odometer,punch-pill | --project path/to/x.proc]
 *                                     [--fps 30] [--clip-sec 4] [--worst-frames 40]
 *                                     [--force] [--dry-run] [--limit N] [--gl-route perDocument]
 *
 * 第 4 步的常驻探针(`ProbeGate` + `back`)做的是同一件事,只是由编辑器在加载遮罩里驱动;
 * 这个脚本是它的离线版,用来在第 4 步准入前把成绩先跑出来、把端点和键跑通。
 *
 * # 和任务书 K1 的对应
 *
 * - **一次只测一个片段**:每张卡先 `setProject(缩水项目, { reset: true })`(一条轨道一个 clip),
 *   再测 —— `render` 没有 clipId,不缩水的话 `StageView.tsx:183` 会把此刻全部活跃卡一起推。
 * - `identityKey = cardCostKey(node, sourceVersion, fps, durationFrames)`,`node` 取
 *   `projectCardGraph(缩水项目, getCard).nodes` 里那个片段的节点,`sourceVersion` 照
 *   `ExportView.tsx:108-118` 的算法(user 卡带 dependencies、内置卡带 builtinCardSourceFiles)。
 * - `direct` 卡:固定随机抽 8 个本地帧,各发一次 `setTime(t, { probe: true })`,
 *   `frameMs = max(elapsedMs)`、`stepMs = null`、`catchUpMs = 0`、`kind: 'random'`。
 * - `stateful` 卡:`render(片段最后一帧, { jump: true, probe: true, maxCatchUp: Infinity })`
 *   从挂载帧一直推,舞台自己按一拍上限 B = 1000/fps × 70% 截断(`StageView.tsx` 的 `budgetMs`);
 *   推完 `catchUpMs` = 实测总时间,被截断的按「已推帧的平均 × 片段总帧数」外推。
 * - `capped = frameMs > B`。
 * - `vtOk` / `seekOk` / `seekMs` **离线不测**(留空):它们要在舞台里按 K3 的重挂载配方复位、
 *   用 `pinner.syncIn` 钉子树虚拟时间,那是第 4 步常驻探针的事,父页这一侧够不到 `pinner`。
 *
 * # `frameMs` 是怎么量出来的(和第 4 步的差别,必须知道)
 *
 * `render({ probe: true })` 的回包只报**整趟**的 `{ elapsedMs, frames, truncated }`,没有逐帧数;
 * 而 `probe-frame` 事件到父页的时间不能拿来当逐帧耗时 —— `stageClock.advanceToAsync` 的
 * `yieldEvery: 8` 只在每 8 帧让出一个宏任务,这 8 条 postMessage 是在同一个让出点成批送达的,
 * 时间戳几乎相同。所以这里改用**逐帧单独发 render**:先 `render(mountSec, { jump: true })` 复位,
 * 再对第 1…N 帧各发一次续推 `render(t, { probe: true })`。续推一次正好推一帧,
 * 回包的 `elapsedMs` 是舞台用 `__pcRealNow` 量的、**不含 RPC 往返**(`StageView.tsx` 在
 * 尾部的 flushSync/tick/pin 之前就取了值),于是每一帧都有一个独立的墙钟数,取最差即 `frameMs`。
 * 同一段再跑一遍、这次**不带** `probe`(舞台就不冻结),取最差即 `stepMs`(不含 `__bfFreeze` 的单帧最差)。
 * 逐帧发 render 会比一趟推完略贵(每帧多一次 flushSync + tick + pin),所以这里的
 * `frameMs` / `stepMs` 是**偏保守(偏大)**的估计;整趟的平均值一并打印出来做对照。
 * N 由 `--worst-frames` 给(缺省 40 帧 ≈ 入场动画全段),够不到片段尾部的长卡在表里标 `worstN`。
 *
 * # 已测过的卡会跳过
 *
 * 开跑前 `GET /api/data/costs?device=<本机>`,`(identityKey, device)` 已有记录
 * **且 `demoted !== true`** 的整张跳过(pinned 渲染 5 末句:身份没变就直接复用)。`--force` 强制重测。
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

/* ------------------------------------------------------------------ 参数 */

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(name);

const origin = (flag('--origin') || process.env.PC_STAGE_TEST_URL || 'http://127.0.0.1:5197').replace(/\/+$/, '');
const fpsArg = Number(flag('--fps', '30')) || 30;
const clipSec = Number(flag('--clip-sec', '4')) || 4;
const worstFrames = Math.max(1, Number(flag('--worst-frames', '40')) || 40);
const cardsArg = flag('--cards');
const projectArg = flag('--project');
const glRouteArg = flag('--gl-route');
const limit = Number(flag('--limit', '0')) || 0;
const force = has('--force');
const dryRun = has('--dry-run');

const HOST_PATH = '/__probe-card-costs-host';
/** 用户 pinned 渲染 5 的一拍预算 */
const budgetOf = (fps) => (1000 / fps) * 0.7;

/* ------------------------------------------------------------------ 宿主页 */

// 同源的一张测试页:仓库里不留静态文件,由 puppeteer 请求拦截临时供给。
// 技法照 scripts/probes/stage-rpc-probe.mjs(那一份已知对 5197 可用)。
const hostHtml = `<!doctype html><html><head><meta charset="utf-8"><title>card cost probe host</title>
<!-- @vitejs/plugin-react 的前导:index.html 由插件自动注入,这张手写的页要自己带,
     否则任何 /src/**.tsx 一 import 就抛「can't detect preamble」。production 包里 /@react-refresh 不存在,
     所以吞掉失败(那时候也不需要它)。 -->
<script type="module">
try {
  const RefreshRuntime = await import('/@react-refresh');
  RefreshRuntime.injectIntoGlobalHook(window);
  window.$RefreshReg$ = () => {};
  window.$RefreshSig$ = () => (type) => type;
  window.__vite_plugin_react_preamble_installed__ = true;
} catch { /* 产物包:没有 react-refresh,也不需要 */ }
</script>
</head>
<body style="margin:0;background:#111">
<iframe id="f" src="/?stage=1&id=back&prerender=1" style="width:1920px;height:1080px;border:0;display:block"></iframe>
<script type="module">
// 最小 RPC 客户端(和 src/render/stageRpc.ts 同一协议),内联着写是为了这张页也能打产物包
function createStageRpc(target) {
  let nextId = 1; const pending = new Map(); const listeners = new Set();
  window.addEventListener('message', (e) => {
    if (e.source !== target) return; const d = e.data;
    if (d && d.type === 'pc-rpc-reply') { const p = pending.get(d.id); if (!p) return; pending.delete(d.id); d.ok ? p.resolve(d.result) : p.reject(new Error(d.error)); return; }
    if (d && typeof d.type === 'string' && ['mediaReady','frame','ended','settled','probe','demote','probe-frame'].includes(d.type)) for (const l of listeners) l(d);
  });
  const call = (method) => (...args) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); target.postMessage({ type: 'pc-rpc', id, method, args }, location.origin); });
  const c = { onEvent: (l) => { listeners.add(l); return () => listeners.delete(l); } };
  for (const m of ['setProject','setTime','render','hitTest','rectsWithBounds','size','setProxy','setRole','setPlan','play','pause','setSuppressed','setStreamPlanes','setScrubbing','setPlaying','setMediaT','setLocalHashes','setSnapshots']) c[m] = call(m);
  return c;
}

const f = document.getElementById('f');
window.__probeFrames = 0;
window.__ready = new Promise((res, rej) => {
  setTimeout(() => rej(new Error('stage ready timeout')), 180000);
  window.addEventListener('message', (e) => {
    if (e.source !== f.contentWindow || e.data?.type !== 'pc-stage-ready') return;
    window.__caps = e.data.hostCapabilities;
    window.__rpc = createStageRpc(f.contentWindow);
    // probe-frame 只计数:逐帧 html 在这一侧没用,攒下来白占内存
    window.__rpc.onEvent((ev) => { if (ev.type === 'probe-frame') window.__probeFrames++; });
    res(true);
  });
});

/* 卡片注册表 / 图 / 身份键。dev 模式下 /src/* 由 vite 现场变换,直接 import 即可。 */
window.__kit = (async () => {
  await import('/src/cards/index.ts');                       // 模块级 registerCards
  const registry = await import('/src/kernel/registry.ts');
  const { projectCardGraph } = await import('/src/kernel/cardGraph.mjs');
  const { cardCostKey } = await import('/src/render/cardCostKey.mjs');
  const { cardSourceVersion } = await import('/src/render/cardSourceVersion.mjs');
  const { builtinCardSourceFiles } = await import('/src/render/cardSourceFiles.mjs');
  const { cardFrameMode, reviewedCard } = await import('/src/render/frameMode.mjs');
  const assets = await import('/src/cards/assets/index.ts');
  // 源码版本照 ExportView.tsx:108-118 那份算法
  const sourceVersionOf = (card) => {
    const user = registry.userCardSources();
    const file = user.fileOf[card.id];
    return file && user.files[file] !== undefined
      ? 'user:' + cardSourceVersion(card, { ...builtinCardSourceFiles, ...user.dependencies }, '/src/cards/user/' + file + '.tsx')
      : 'builtin:' + cardSourceVersion(card, builtinCardSourceFiles);
  };
  return { ...registry, projectCardGraph, cardCostKey, cardFrameMode, reviewedCard, sourceVersionOf, featuredParticleIds: assets.featuredParticleIds };
})();

/* 本机身份(J4):UA + WebGL 渲染器 + lowMemory / offscreenGl / glRoute。
   一次性的丢弃上下文在**宿主页**里开,不碰舞台自己那个共享 WebGL 上下文。 */
window.__deviceParts = () => {
  let renderer = 'unknown';
  try {
    const cv = document.createElement('canvas');
    const gl = cv.getContext('webgl2') || cv.getContext('webgl');
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      renderer = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
      try { gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch {}
    }
  } catch {}
  const caps = window.__caps || {};
  return { ua: navigator.userAgent, renderer, lowMemory: !!caps.lowMemory, offscreenGl: !!caps.offscreenGl,
    glRoute: caps.lowMemory ? 'shared' : 'perDocument' };
};

/* 缩水项目:一条轨道一个 clip(形状同 FrameScene.tsx 的 legacyTimeline) */
window.__mkProject = (cardId, fps, lenSec, params) => ({
  version: 1, id: 'probe', name: 'probe', width: 1920, height: 1080, fps, duration: lenSec,
  themeId: 'midnight', media: [],
  tracks: [{ id: 'probe-track', clips: [{ id: 'c0', cardId, start: 0, end: lenSec, params: params || {} }] }],
});

/* 身份键 + 声明的帧模式。只算不测,给「跳过已测过的卡」用 */
window.__identify = async (jobs) => {
  const kit = await window.__kit;
  return jobs.map((job) => {
    const def = kit.getCard(job.cardId);
    if (!def) return { ...job, error: '注册表里没有这张卡' };
    try {
      const project = window.__mkProject(job.cardId, job.fps, job.lenSec, job.params);
      const node = kit.projectCardGraph(project, kit.getCard).nodes.find((n) => n.clipId === 'c0');
      if (!node) return { ...job, error: '图里没有这个片段的节点' };
      const durationFrames = Math.max(1, Math.round(job.lenSec * job.fps));
      return { ...job, durationFrames,
        identityKey: kit.cardCostKey(node, kit.sourceVersionOf(def), job.fps, durationFrames),
        canvasHeavy: !!kit.reviewedCard(job.cardId)?.canvasHeavy,
        mode: kit.cardFrameMode(def, def.defaults) };
    } catch (err) { return { ...job, error: String(err && err.message || err) }; }
  });
};

/* 面板默认可见的那 62 张(inventory :19):非粒子卡全要 + 目录标了 featured 的粒子卡 */
window.__highFrequencyIds = async () => {
  const kit = await window.__kit;
  return kit.allCards().map((c) => c.id).filter((id) => !id.startsWith('particles-') || kit.featuredParticleIds.has(id));
};

/* -------- 一张卡的实测。整趟都在页面里跑,免得每帧一次 puppeteer 往返 -------- */
const seedOf = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const mulberry32 = (a) => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const maxOf = (xs) => xs.reduce((m, x) => (Number.isFinite(x) && x > m ? x : m), 0);
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0; };

window.__probeOne = async (job) => {
  const rpc = window.__rpc;
  const { cardId, fps, lenSec, params, mode, identityKey, durationFrames } = job;
  const budget = (1000 / fps) * 0.7;
  const out = { cardId, identityKey, fps, mode, durationFrames };
  const project = window.__mkProject(cardId, fps, lenSec, params);
  await rpc.setRole('back', { job: 'probe' });
  await rpc.setProject(project, { reset: true });
  // 挂载那一下 React 要建树、Motion 要解析关键帧:给一个真任务边界再开测,
  // 否则第一张卡的第一帧会把整个模块的首次求值算进去。canvas 卡(three.js / tsParticles)
  // 还要等它异步把画布装起来,不然量的是一个空壳(实测 particles-basic 差 30 倍)。
  await rpc.setTime(0);
  await new Promise((r) => setTimeout(r, 150));
  if (job.canvasHeavy) {
    const w = document.getElementById('f').contentWindow;
    for (let i = 0; i < 100; i++) {
      const cv = w.document.querySelector('[data-pc-clip] canvas');
      if (cv && cv.width > 1) { await new Promise((r) => setTimeout(r, 150)); break; }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  if (mode === 'direct') {
    // 固定随机抽 8 个本地帧(按 cardId 播种,复跑同一台机器结果可比)
    const rnd = mulberry32(seedOf(cardId));
    const picks = new Set();
    for (let i = 0; i < 64 && picks.size < Math.min(8, durationFrames); i++) picks.add(Math.floor(rnd() * durationFrames));
    const frames = [...picks].sort((a, b) => a - b);
    const each = [];
    for (const n of frames) {
      const r = await rpc.setTime(n / fps, { probe: true });
      each.push(Number(r?.elapsedMs) || 0);
    }
    out.kind = 'random';
    out.frameMs = maxOf(each);
    out.stepMs = null;
    out.catchUpMs = 0;
    out.samples = each.length;
    out.each = each;
    out.frameP50 = pct(each, 0.5);
    out.frameP90 = pct(each, 0.9);
    out.firstMs = each[0] ?? 0;
    out.truncated = false;
    out.capped = out.frameMs > budget;
    return out;
  }

  /* stateful:第一趟按任务书那样整趟推(舞台自己按一拍上限截断),拿 catchUpMs */
  const target = Math.max(0, lenSec - 1 / fps);
  const totalFrames = Math.max(1, Math.round(target * fps) + 1);
  window.__probeFrames = 0;
  const pass = await rpc.render(target, { jump: true, probe: true, maxCatchUp: Infinity });
  const frames = Number(pass?.frames) || 0;
  const elapsed = Number(pass?.elapsedMs) || 0;
  const truncated = !!pass?.truncated;
  out.kind = 'stepped';
  out.runFrames = frames;
  out.runMs = elapsed;
  out.truncated = truncated;
  out.avgFrameMs = frames ? elapsed / frames : elapsed;
  out.probeFrameEvents = window.__probeFrames;
  // 推完了就是实测总时间;被截断的按已推帧的平均外推到整段(任务书 K1)
  out.catchUpMs = truncated ? (frames ? (elapsed / frames) * totalFrames : elapsed) : elapsed;

  /* 第二、三趟:逐帧单独发 render,拿真正的「单帧最差」。见文件头的说明。 */
  const n = Math.max(1, Math.min(totalFrames - 1, job.worstFrames));
  out.worstN = n;
  const step = async (probe) => {
    await rpc.render(0, { jump: true, maxCatchUp: Infinity });   // 按重挂载配方复位到挂载帧
    const each = [];
    for (let k = 1; k <= n; k++) {
      const r = await rpc.render(k / fps, probe ? { probe: true, maxCatchUp: Infinity } : { maxCatchUp: Infinity });
      each.push(Number(r?.elapsedMs) || 0);
    }
    return each;
  };
  window.__probeFrames = 0;
  const withFreeze = await step(true);
  const bare = await step(false);
  out.frameMs = maxOf(withFreeze);
  out.stepMs = maxOf(bare);
  // 单帧最差几乎总是落在重挂载后的头一两帧(React 建树 + 第一次 getComputedStyle 全量求值),
  // 所以把分位数和「最差落在第几帧」一并记下来,免得只看 max 时误以为整段都这么贵。
  out.frameP50 = pct(withFreeze, 0.5);
  out.frameP90 = pct(withFreeze, 0.9);
  out.stepP50 = pct(bare, 0.5);
  out.stepP90 = pct(bare, 0.9);
  out.firstMs = withFreeze[0] ?? 0;
  out.frameMaxAt = withFreeze.indexOf(out.frameMs) + 1;
  out.freezeMs = Math.max(0, out.frameP50 - out.stepP50);
  out.capped = out.frameMs > budget;
  return out;
};
</script></body></html>`;

/* ------------------------------------------------------------------ 要测哪些卡 */

function jobsFromProject(file, fps) {
  const raw = fs.readFileSync(file, 'utf8');
  let doc;
  try { doc = JSON.parse(raw); } catch (e) { throw new Error(`${file} 不是 JSON 项目(${e.message})`); }
  // .proc 是 { format, version, project: {...} };裸项目也收
  const proj = doc?.project ?? doc;
  const projFps = Number(proj.fps) || fps;
  const jobs = [];
  for (const track of proj.tracks ?? []) {
    for (const clip of track.clips ?? []) {
      if (!clip.cardId) continue;
      const len = Math.max(1 / projFps, Number(clip.end) - Number(clip.start));
      jobs.push({ cardId: clip.cardId, fps: projFps, lenSec: Number(len.toFixed(6)), params: clip.params ?? {} });
    }
  }
  return jobs;
}

/* ------------------------------------------------------------------ 端点 */

async function getCosts(device) {
  const res = await fetch(`${origin}/api/data/costs?device=${encodeURIComponent(device)}`);
  if (res.status === 404) return { missing: true, costs: [] };
  if (!res.ok) throw new Error(`GET /api/data/costs → HTTP ${res.status}`);
  const data = await res.json();
  return { missing: false, costs: Array.isArray(data?.costs) ? data.costs : [] };
}

async function putCosts(records) {
  const res = await fetch(`${origin}/api/data/costs`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ records }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) throw new Error(`PUT /api/data/costs → HTTP ${res.status} ${JSON.stringify(data)}`);
  return data;
}

/* ------------------------------------------------------------------ 主流程 */

const num = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '—');
function table(rows, columns) {
  const head = columns.map((c) => c.title);
  const body = rows.map((r) => columns.map((c) => String(c.get(r) ?? '')));
  const width = head.map((h, i) => Math.max([...h].length, ...body.map((r) => [...r[i]].length)));
  const line = (cells) => cells.map((c, i) => (i === 0 ? c.padEnd(width[i]) : c.padStart(width[i]))).join('  ');
  return [line(head), width.map((w) => '-'.repeat(w)).join('  '), ...body.map(line)].join('\n');
}

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

  const parts = await page.evaluate(() => window.__deviceParts());
  if (glRouteArg) parts.glRoute = glRouteArg;
  const device = [parts.ua, parts.renderer, `lowMemory=${parts.lowMemory}`, `offscreenGl=${parts.offscreenGl}`, `glRoute=${parts.glRoute}`].join(' | ');
  console.log(`device: ${device}\n`);

  let jobs;
  if (projectArg) {
    jobs = jobsFromProject(path.resolve(projectArg), fpsArg);
  } else if (cardsArg) {
    jobs = cardsArg.split(',').map((s) => s.trim()).filter(Boolean).map((cardId) => ({ cardId, fps: fpsArg, lenSec: clipSec, params: {} }));
  } else {
    const ids = await page.evaluate(() => window.__highFrequencyIds());
    jobs = ids.map((cardId) => ({ cardId, fps: fpsArg, lenSec: clipSec, params: {} }));
  }
  if (limit) jobs = jobs.slice(0, limit);

  const identified = await page.evaluate((j) => window.__identify(j), jobs);
  const broken = identified.filter((j) => j.error);
  for (const j of broken) console.warn(`跳过 ${j.cardId}:${j.error}`);

  const existing = dryRun ? { missing: true, costs: [] } : await getCosts(device);
  if (existing.missing) console.warn('GET /api/data/costs 回了 404 —— 插件还没挂上(或者在 --dry-run 里),这一趟不跳过任何卡。');
  const known = new Map(existing.costs.map((r) => [r.identityKey, r]));
  const todo = [], skipped = [];
  const seen = new Set();
  for (const j of identified) {
    if (j.error) continue;
    if (seen.has(j.identityKey)) continue;   // 同一张卡的多个片段身份相同,只测一次
    seen.add(j.identityKey);
    const hit = known.get(j.identityKey);
    if (!force && hit && hit.demoted !== true) { skipped.push({ ...j, hit }); continue; }
    todo.push({ ...j, worstFrames });
  }
  console.log(`共 ${identified.length} 个片段 → ${todo.length} 张要测,${skipped.length} 张已有记录跳过,${broken.length} 张有问题。\n`);

  const records = [], results = [];
  for (const [i, job] of todo.entries()) {
    process.stdout.write(`[${i + 1}/${todo.length}] ${job.cardId} (${job.mode}) … `);
    let out;
    try {
      out = await page.evaluate((j) => window.__probeOne(j), job);
    } catch (err) {
      console.log('失败');
      results.push({ ...job, error: String(err && err.message || err) });
      continue;
    }
    console.log(`frameMs=${num(out.frameMs, 2)} catchUpMs=${num(out.catchUpMs, 0)}${out.capped ? ' CAPPED' : ''}`);
    results.push(out);
    records.push({
      identityKey: out.identityKey,
      fps: out.fps,
      frameMs: Number(out.frameMs.toFixed(3)),
      stepMs: out.stepMs === null ? null : Number(out.stepMs.toFixed(3)),
      catchUpMs: Number(out.catchUpMs.toFixed(3)),
      ...(out.capped ? { capped: true } : {}),
      kind: out.kind,
      measuredAt: Date.now(),
      device,
    });
  }

  const B = budgetOf(fpsArg);
  console.log(`\nB = 1000/${fpsArg} × 70% = ${B.toFixed(2)} ms\n`);
  console.log(table(results.filter((r) => !r.error), [
    { title: 'card', get: (r) => r.cardId },
    { title: 'kind', get: (r) => r.kind },
    { title: 'frameMs', get: (r) => num(r.frameMs, 2) },
    { title: 'stepMs', get: (r) => (r.stepMs === null || r.stepMs === undefined ? '—' : num(r.stepMs, 2)) },
    { title: 'catchUpMs', get: (r) => num(r.catchUpMs, 0) },
    { title: 'p50', get: (r) => num(r.frameP50, 2) },
    { title: 'p90', get: (r) => num(r.frameP90, 2) },
    { title: '1st', get: (r) => num(r.firstMs, 2) },
    { title: 'freeze≈', get: (r) => (r.kind === 'stepped' ? num(r.freezeMs, 2) : '—') },
    { title: 'avg/frame', get: (r) => num(r.avgFrameMs, 2) },
    { title: 'run', get: (r) => (r.kind === 'stepped' ? `${r.runFrames}/${r.durationFrames}` : `${r.samples}`) },
    { title: 'worstN', get: (r) => r.worstN ?? '—' },
    { title: 'maxAt', get: (r) => r.frameMaxAt ?? '—' },
    { title: 'trunc', get: (r) => (r.truncated ? 'yes' : 'no') },
    { title: 'capped', get: (r) => (r.capped ? 'YES' : '') },
  ]));

  const failed = results.filter((r) => r.error);
  if (failed.length) {
    console.log('\n失败:');
    for (const f of failed) console.log(`  ${f.cardId}: ${f.error}`);
  }
  if (skipped.length) console.log(`\n已有记录跳过:${skipped.map((s) => s.cardId).join(', ')}`);

  if (!dryRun && records.length) {
    const put = await putCosts(records);
    console.log(`\nPUT /api/data/costs → ok,存档共 ${put.count} 条(新增 ${put.added}、更新 ${put.updated})。`);
    const back = await getCosts(device);
    const got = new Set(back.costs.map((r) => r.identityKey));
    const missing = records.filter((r) => !got.has(r.identityKey));
    console.log(`GET /api/data/costs?device=… → ${back.costs.length} 条;本趟 ${records.length} 条里缺 ${missing.length} 条。`);
    if (missing.length) exitCode = 1;
  } else if (dryRun) {
    console.log('\n--dry-run:没有写 /api/data/costs。');
  }

  const noise = errors.filter((e) => !/favicon|React DevTools|Failed to load resource/i.test(e));
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
