/**
 * 探针:Lottie「覆盖随机数种子」——直接跳到第 N 帧和从头顺着推到第 N 帧,画面相同不相同。
 * 出处:`docs/plan/render-refactor-task.md`「癸:Lottie 改成 remotion 式」的「要留意的一处」;用户 2026-10-12:「我觉得可以覆盖随机数种子。」
 * 原型在 `src/cards/native/lottie.tsx`(`loadLottie`,开关缺省关)和 `src/kernel/pinEntropy.ts`(`withSeededRandom`)。
 *
 *   node scripts/probes/lottie-seed-probe.mjs [--port 5750] [--assets fixture,adrock,bodymovin,gatin,happy2016,navidad]
 *        [--out <目录>]    存结果 result.json,以及对不上的那几帧的 SVG 文本
 *        [--before 7e7ae968]  「开关关着和改之前一样」拿哪个提交的 lottie.tsx 当改之前
 *        [--skip-sweep]    不跑「全长逐帧,开和关比」那一项(最慢)
 *
 * 做法:起一个只服务本探针的 vite(根是本工作区,不读项目的 vite 配置),真 Chrome 里装上和产品一样的随机数钉子
 * (`installPinnedEntropy`),用卡片自己的 `loadLottie` 建实例。每份画面比三样:
 *   原文      SVG 序列化后的文本,只把播放库按全页计数器发的节点 id(`__lottie_element_N`)按出现顺序重新编号。
 *             它连**看不见的图层**上留着的旧属性也比:播放库藏起一个图层只是加 `display: none`,上次显示时的位置、透明度原样留着,
 *             从没显示过的图层则什么属性都没有。所以原文相同不相同和推帧路径有关,这一项只报告。
 *   看得见的  同一份文本去掉 `display: none` 的节点里面的内容和它身上的其它属性,去掉 `<defs>` 里已经没人引用的东西
 *             (图层的蒙版路径放在 `<defs>` 里,图层藏起来以后留着旧路径),属性按名字排序。逐字节比。
 *   像素      原文不同的两份各变成 1920×1080 的像素,数不同的像素。
 * 「相同」指看得见的文本逐字节相同、并且像素逐个相同。
 *
 * 素材:`fixture` 是 `scripts/probes/fixtures/lottie-seed/expr-layers.json`——手写的测试 Lottie,图层入点 0、10、20、25、30、40,
 * 分别用 random()、只有 wiggle()、seedRandom()+random() 驱动位置、透明度、旋转、缩放,其中两层在嵌套合成里;其余是自带的 5 个。
 *
 * 每个素材、开关关着和开着各做一遍,每个 N 取这几份画面:
 *   顺推          新开页面,建一份,从第 0 帧一帧一帧推到第 N 帧
 *   回跳          同一份实例推完全长后,回到第 0 帧再直接跳到第 N 帧
 *   同页新建      同一个页面里再建一份,直接跳到第 N 帧
 *   新页新建      新开页面,建一份,直接跳到第 N 帧
 *   别的卡在前    新开页面,先调 13 次 Math.random,再建一份直接跳(只取 3 个 N)
 *   别的 Lottie 在前  新开页面,先建一份带随机表达式的 Lottie 推几帧,再建一份直接跳(只取 3 个 N)
 *   连建两次      同一个页面里连建两份,都直接跳到同一帧(只取 1 个 N)
 * 另外:
 *   全长逐帧      开和关各顺推全长,逐帧比,列出变了的帧(只报告)
 *   全页那一串    建一份 Lottie 并推几帧之后,页面里下一个 Math.random 是第几个(关着:被吃掉几个;开着:应为 0 个)
 *   图层          建好后是不是所有图层(含嵌套合成里的)都已经建了
 *   真卡片        用 React 挂真的 LottieView:开着时和上面「新页新建」的画面相同;关着时和 --before 那个提交的卡片逐帧相同
 *
 * 判定:开关**开着**时,同一个 N 的各份画面必须逐字节相同;「真卡片」两条必须成立;页面不许报错。不满足进 `fails`,退出码 1。
 * 开关**关着**时各份画面相同不相同只报告(那是现状),不算失败。耗时只记录。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : dflt; };
const flag = (name) => process.argv.includes(name);
const PORT = Number(arg('--port', '5750'));
if (!Number.isInteger(PORT) || PORT < 5750 || PORT > 5759) throw new Error('--port 只能用 5750～5759');
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BEFORE = arg('--before', '7e7ae968');
const OUT = arg('--out', fs.mkdtempSync(path.join(os.tmpdir(), 'pc-lottie-seed-')));
fs.mkdirSync(OUT, { recursive: true });
const SKIP_SWEEP = flag('--skip-sweep');
const CATALOG = path.join(ROOT, 'server', 'catalog', 'lottie');
const FIXTURE = path.join(ROOT, 'scripts', 'probes', 'fixtures', 'lottie-seed', 'expr-layers.json');
const BUNDLED = ['adrock', 'bodymovin', 'gatin', 'happy2016', 'navidad'];
const ASSETS = arg('--assets', ['fixture', ...BUNDLED].join(',')).split(',').filter(Boolean);
const FIXTURE_LAYERS = ['random-pos', 'wiggle-pos', 'seeded-opacity', 'wiggle-opacity', 'precomp', 'inner-wiggle', 'inner-random', 'plain-keyframes'];
const dataFile = (name) => (name === 'fixture' ? FIXTURE : path.join(CATALOG, `${name}.json`));

// ── 页面里跑的那一半 ──
const HARNESS = String.raw`<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;background:#111;overflow:hidden}.box{position:absolute;left:0;top:0;width:1920px;height:1080px}.absolute{position:absolute}.inset-0{inset:0}#card{position:absolute;left:0;top:0;width:1920px;height:1080px}</style>
<div id="card"></div>
<script type="module">
  // 和产品一样:随机数钉子赶在播放库加载之前装(render/stageClockEntry.ts 是入口的第一个 import)
  import { installPinnedEntropy } from '/src/kernel/pinEntropy.ts';
  installPinnedEntropy();
</script>
<script type="module">
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import { flushSync } from 'react-dom';
  import lottie from 'lottie-web';
  import * as current from '/src/cards/native/lottie.tsx';
  import * as before from '/__lottie_before.tsx';
  import { waitForFrameWork } from '/src/kernel/frameReady.ts';

  const texts = new Map();
  const text = async (name) => { if (!texts.has(name)) texts.set(name, await (await fetch('/lottie-data/' + name + '.json')).text()); return texts.get(name); };
  const made = new Map(); let nextId = 1;
  const normalize = (s) => { const ids = new Map(); return s.replace(/__lottie_element_\d+/g, (m) => { if (!ids.has(m)) ids.set(m, 'E' + ids.size); return ids.get(m); }); };
  /** 看得见的那部分:display:none 的节点只留壳(它和里面的东西都不画),属性按名字排序 */
  const visible = (svg) => {
    const copy = svg.cloneNode(true);
    const walk = (el) => {
      if (el.style && el.style.display === 'none') { while (el.firstChild) el.removeChild(el.firstChild); for (const a of [...el.attributes]) if (a.name !== 'id' && a.name !== 'style') el.removeAttributeNode(a); return; }
      const attrs = [...el.attributes].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
      for (const a of attrs) el.removeAttributeNode(a);
      for (const a of attrs) el.setAttributeNode(a);
      for (const child of [...el.children]) walk(child);
    };
    walk(copy);
    // <defs> 里没人用的东西也去掉:图层的蒙版路径放在 <defs> 里,图层藏起来以后它不再更新,留着的是旧路径
    const refsOf = (el, into) => { for (const node of [el, ...el.querySelectorAll('*')]) for (const a of node.attributes) { for (const m of a.value.matchAll(/url\(["']?#([^)"']+)["']?\)/g)) into.add(m[1]); if (a.localName === 'href' && a.value.startsWith('#')) into.add(a.value.slice(1)); } };
    const byId = new Map(); for (const el of copy.querySelectorAll('[id]')) byId.set(el.getAttribute('id'), el);
    const used = new Set(); const pending = new Set();
    for (const child of copy.children) if (child.localName !== 'defs') refsOf(child, pending);
    while (pending.size) { const id = pending.values().next().value; pending.delete(id); if (used.has(id)) continue; used.add(id); const el = byId.get(id); if (el) { const more = new Set(); refsOf(el, more); for (const x of more) if (!used.has(x)) pending.add(x); } }
    for (const defs of copy.querySelectorAll('defs')) for (const res of [...defs.children]) { const ids = [res, ...res.querySelectorAll('[id]')].map((el) => el.getAttribute('id')).filter(Boolean); if (!ids.some((id) => used.has(id))) res.remove(); }
    return normalize(new XMLSerializer().serializeToString(copy));
  };
  /** 一份画面:r 原文,v 看得见的 */
  const svgText = (root) => { const svg = root.querySelector('svg'); return svg ? { r: normalize(new XMLSerializer().serializeToString(svg)), v: visible(svg) } : { r: '', v: '' }; };
  const loaded = (anim) => anim.isLoaded ? Promise.resolve() : new Promise((resolve, reject) => { anim.addEventListener('DOMLoaded', resolve); anim.addEventListener('data_failed', () => reject(new Error('data_failed'))); });
  const countLayers = (renderer) => { let layers = 0, built = 0; const walk = (r) => { (r.layers || []).forEach((l, i) => { if (l.ty === 99) return; layers++; const e = r.elements && r.elements[i]; if (e && e !== true) { built++; if (l.ty === 0) walk(e); } }); }; walk(renderer); return { layers, built }; };

  const api = {
    /** 建一份。mode: 'on' 开着、'off' 关着(都走卡片的 loadLottie) */
    async make(name, mode) {
      const data = JSON.parse(await text(name));
      const box = document.createElement('div'); box.className = 'box'; document.body.appendChild(box);
      const t0 = performance.now();
      const handle = current.loadLottie(box, data, 'contain', mode === 'on');
      await loaded(handle.anim);
      const id = nextId++; made.set(id, { handle, box });
      return { id, seed: handle.seed, buildMs: +(performance.now() - t0).toFixed(1), total: Math.max(1, (Number(data.op) || 0) - (Number(data.ip) || 0)), fr: Number(data.fr) || 30, ...countLayers(handle.anim.renderer) };
    },
    goTo(id, frame) { made.get(id).handle.goTo(frame); },
    snap(id) { return svgText(made.get(id).box); },
    jump(id, frame) { const m = made.get(id); m.handle.goTo(frame); return svgText(m.box); },
    /** 从 frames[0] 起依次推,picks 里的帧各留一份文本 */
    seq(id, frames, picks) { const m = made.get(id); const want = new Set(picks); const out = {}; for (const f of frames) { m.handle.goTo(f); if (want.has(f)) out[f] = svgText(m.box); } return out; },
    /** 依次推,每帧只回散列(全长逐帧用) */
    async seqHashes(id, frames) { const m = made.get(id); const out = []; for (const f of frames) { m.handle.goTo(f); const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(svgText(m.box).v)); out.push([...new Uint8Array(buf)].slice(0, 12).map((x) => x.toString(16).padStart(2, '0')).join('')); } return out; },
    hide(id) { made.get(id).box.style.display = 'none'; },
    destroy(id) { const m = made.get(id); m.handle.anim.destroy(); m.box.remove(); made.delete(id); },
    /**
     * 实验用(不是原型的一部分):找出这份实例里所有带关键帧的属性,按要求动两处播放库内部的东西——
     *   exact  把「新值和旧值差不到 0.00001 就不更新」换成「不相等就更新」(播放库 setVValue 里的门槛)
     *   cold   之后每次 seqCold 跳帧前,把各属性的插值缓存清回刚建好的样子
     */
    tune(id, exact) {
      const m = made.get(id); const seen = new Set(); const props = []; const stack = [m.handle.anim.renderer.elements];
      while (stack.length) {
        const o = stack.pop();
        if (!o || typeof o !== 'object' || seen.has(o) || o instanceof Node || ArrayBuffer.isView(o) || o === window) continue;
        seen.add(o);
        if (o._caching && typeof o._caching === 'object' && 'lastFrame' in o._caching) props.push(o);
        for (const k of Object.keys(o)) { if (k === 'data' || k === 'layers' || k === 'keyframes' || k === 'globalData' || k === 'comp') continue; const v = o[k]; if (v && typeof v === 'object') stack.push(v); }
      }
      let patched = 0;
      if (exact) for (const p of props) if (typeof p.setVValue === 'function') {
        p.setVValue = function (val) { if (this.propType === 'unidimensional') { const x = val * this.mult; if (this.v !== x) { this.v = x; this._mdf = true; } } else { for (let i = 0; i < this.v.length; i++) { const x = val[i] * this.mult; if (this.v[i] !== x) { this.v[i] = x; this._mdf = true; } } } };
        patched++;
      }
      m.props = props;
      return { props: props.length, patched };
    },
    seqCold(id, frames, picks) {
      const m = made.get(id); const want = new Set(picks); const out = {};
      for (const f of frames) {
        for (const p of m.props) { const c = p._caching; c.lastFrame = -999999; c.lastIndex = 0; if ('_lastKeyframeIndex' in c) c._lastKeyframeIndex = -1; }
        m.handle.goTo(f); if (want.has(f)) out[f] = svgText(m.box);
      }
      return out;
    },
    /** 别的卡:调 n 次 Math.random */
    burn(n) { let last = 0; for (let i = 0; i < n; i++) last = Math.random(); return last; },
    /** 页面里接下来的 n 个 Math.random */
    peek(n) { return Array.from({ length: n }, () => Math.random()); },
    /** 把两份 SVG 文本各变成像素,数不同的像素 */
    async pixelDiff(a, b) {
      const W = 1920, H = 1080; const canvas = new OffscreenCanvas(W, H); const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const px = async (s) => { const doc = new DOMParser().parseFromString(s, 'image/svg+xml').documentElement; doc.setAttribute('width', String(W)); doc.setAttribute('height', String(H)); const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(doc)], { type: 'image/svg+xml' })); try { const img = new Image(); img.src = url; await img.decode(); ctx.clearRect(0, 0, W, H); ctx.drawImage(img, 0, 0, W, H); } finally { URL.revokeObjectURL(url); } return ctx.getImageData(0, 0, W, H).data.slice(); };
      const pa = await px(a), pb = await px(b); let count = 0, max = 0;
      for (let i = 0; i < pa.length; i += 4) { const d = Math.max(Math.abs(pa[i] - pb[i]), Math.abs(pa[i + 1] - pb[i + 1]), Math.abs(pa[i + 2] - pb[i + 2]), Math.abs(pa[i + 3] - pb[i + 3])); if (d) { count++; if (d > max) max = d; } }
      return { pixels: count, pct: +(100 * count / (W * H)).toFixed(4), max };
    },
    // ── 真卡片(React) ──
    root: null, Card: null, params: null, pre: null,
    /** which: 'current' | 'before';burn > 0 时在 Lottie 前面先挂一张挂载时调 burn 次 Math.random 的卡 */
    async mountCard(which, params, t, burn) {
      api.Card = (which === 'before' ? before : current).LottieView; api.params = params;
      api.pre = burn > 0 ? function Other() { React.useEffect(() => { for (let i = 0; i < burn; i++) Math.random(); }, []); return null; } : null;
      api.root = createRoot(document.getElementById('card'));
      return api.cardFrame(t);
    },
    async cardFrame(t) {
      flushSync(() => api.root.render(React.createElement(React.Fragment, null, api.pre ? React.createElement(api.pre, { key: 'other' }) : null, React.createElement(api.Card, { ...api.params, t, key: 'card' }))));
      await waitForFrameWork();
      await new Promise((resolve) => setTimeout(resolve, 0)); // 播放库的 DOMLoaded 是 setTimeout(0) 发的
      await waitForFrameWork();
      return svgText(document.getElementById('card'));
    },
    seedEnabled: () => current.lottieSeedEnabled(),
  };
  window.api = api; window.lottie = lottie; window.ready = true;
</script>`;

const beforeSource = execFileSync('git', ['show', `${BEFORE}:src/cards/native/lottie.tsx`], { cwd: ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 16 << 20 });
const BEFORE_ID = path.join(ROOT, '__lottie_before.tsx').replace(/\\/g, '/');
const plugin = {
  name: 'lottie-seed-probe', enforce: 'pre',
  resolveId(id) { if (id === '/__lottie_before.tsx' || id.replace(/\\/g, '/') === BEFORE_ID) return BEFORE_ID; },
  load(id) { if (id.replace(/\\/g, '/') !== BEFORE_ID) return; return beforeSource.replace(/from "(\.[^"]+)"/g, (_, p) => `from "/${path.posix.normalize('src/cards/native/' + p)}"`); },
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const url = new URL(req.url, 'http://x');
      res.setHeader('cache-control', 'no-store');
      if (url.pathname === '/favicon.ico') { res.statusCode = 204; res.end(); return; }
      if (url.pathname === '/harness') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(await server.transformIndexHtml('/harness', HARNESS)); return; }
      const m = /^\/lottie-data\/([a-z0-9]+)\.json$/.exec(url.pathname);
      if (m && (m[1] === 'fixture' || BUNDLED.includes(m[1]))) { res.setHeader('content-type', 'application/json'); res.end(fs.readFileSync(dataFile(m[1]))); return; }
      next();
    });
  },
};

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
/** 两份 SVG 文本哪里不同:第一处的位置和上下文;fixture 再按图层名归到层上 */
function describeDiff(a, b, layerNames) {
  let i = 0; const n = Math.min(a.length, b.length);
  while (i < n && a[i] === b[i]) i++;
  const from = Math.max(0, i - 50);
  const out = { at: i, lenA: a.length, lenB: b.length, a: a.slice(from, i + 70), b: b.slice(from, i + 70) };
  if (layerNames) {
    const tags = (s) => s.split('<');
    const ta = tags(a), tb = tags(b); const layers = new Set(); let cur = '(根)';
    for (let k = 0; k < Math.max(ta.length, tb.length); k++) {
      const m = /^g[^>]*\bid="([^"]+)"/.exec(ta[k] ?? '');
      if (m && layerNames.includes(m[1])) cur = m[1];
      if (ta[k] !== tb[k]) layers.add(cur);
    }
    out.layers = [...layers];
  }
  return out;
}

const report = { when: new Date().toISOString(), host: { cpu: os.cpus()[0]?.model?.trim(), logicalCores: os.cpus().length }, before: BEFORE, out: OUT, assets: {}, card: {}, pageErrors: [], fails: [] };
const fail = (msg) => { report.fails.push(msg); console.log(`FAIL ${msg}`); };

const vite = await createServer({
  root: ROOT, configFile: false, plugins: [plugin], logLevel: 'error', appType: 'custom',
  cacheDir: path.join(os.tmpdir(), 'pc-lottie-seed-probe-vite'),
  optimizeDeps: { include: ['lottie-web', 'react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'] },
  server: { host: '127.0.0.1', port: PORT, strictPort: true, hmr: false, watch: null },
});
await vite.listen();
let browser = null;
const t0 = Date.now();
try {
  browser = await puppeteer.launch({ headless: true, protocolTimeout: 900000, args: [...PROBE_CHROME_ARGS, '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1'] });
  report.chrome = await browser.version();
  report.lottieWeb = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.resolve('lottie-web'))), '..', '..', 'package.json'), 'utf8')).version;

  /** 每个用例一个新页面:全页那一串随机数、播放库内部那一串、节点 id 计数器都从头来 */
  const open = async (query = '') => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => report.pageErrors.push(String(e?.message ?? e).slice(0, 300)));
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warn') report.pageErrors.push(`console.${m.type()}: ${m.text().slice(0, 300)}`); });
    await page.goto(`${ORIGIN}/harness${query}`, { waitUntil: 'load' });
    await page.waitForFunction('window.ready === true', { timeout: 120000 });
    return page;
  };
  const call = (page, fn, ...args) => page.evaluate((f, a) => window.api[f](...a), fn, args);

  // 全页那一串的前 4000 个数:用来数「被吃掉几个」
  const refPage = await open();
  const reference = await call(refPage, 'peek', 4000);
  await refPage.close();
  const drawsBefore = (next) => reference.indexOf(next);
  const tool = await open(); // 只用来把 SVG 文本变成像素

  for (const name of ASSETS) {
    const data = JSON.parse(fs.readFileSync(dataFile(name), 'utf8'));
    const total = Math.max(1, (Number(data.op) || 0) - (Number(data.ip) || 0));
    const picks = name === 'fixture'
      ? [0, 5, 9, 10, 11, 12.5, 19, 20, 21, 24, 25, 26, 29, 30, 31, 39, 40, 41, 50, 59]
      : [...new Set([0, 1, Math.floor(total * 0.13), Math.floor(total * 0.31), Math.floor(total / 2), Math.floor(total * 0.69), total - 2, total - 1])].filter((f) => f >= 0 && f < total);
    const maxPick = Math.max(...picks);
    const frames = []; for (let f = 0; f <= Math.floor(maxPick); f++) { frames.push(f); for (const p of picks) if (!Number.isInteger(p) && Math.floor(p) === f) frames.push(p); }
    const few = [picks[1], picks[Math.floor(picks.length / 2)], picks[picks.length - 1]];
    const layerNames = name === 'fixture' ? FIXTURE_LAYERS : null;
    const entry = { total, fr: Number(data.fr) || 30, picks, modes: {} };
    report.assets[name] = entry;

    for (const mode of ['off', 'on']) {
      const started = Date.now();
      const shots = {}; // 画面名 → { N: 文本 }
      // 顺推、回跳、同页新建、连建两次
      // 全页那一串被吃掉几个:单开一页数,不搅进下面的比较
      const p0 = await open();
      const before0 = drawsBefore((await call(p0, 'peek', 1))[0]);
      const counted = await call(p0, 'make', name, mode); await call(p0, 'seq', counted.id, frames, []);
      const afterSeq = drawsBefore((await call(p0, 'peek', 1))[0]);
      await p0.close();
      const p1 = await open();
      const first = await call(p1, 'make', name, mode);
      shots['顺推'] = await call(p1, 'seq', first.id, frames, picks);
      await call(p1, 'seq', first.id, Array.from({ length: total }, (_, i) => i), []);
      shots['回跳'] = {};
      for (const n of picks) { await call(p1, 'goTo', first.id, 0); shots['回跳'][n] = await call(p1, 'jump', first.id, n); }
      await call(p1, 'hide', first.id);
      shots['同页新建'] = {};
      for (const n of picks) { const m = await call(p1, 'make', name, mode); shots['同页新建'][n] = await call(p1, 'jump', m.id, n); await call(p1, 'destroy', m.id); }
      const twiceN = few[1];
      const twice = [];
      for (let k = 0; k < 2; k++) { const m = await call(p1, 'make', name, mode); twice.push({ id: m.id, text: await call(p1, 'jump', m.id, twiceN) }); await call(p1, 'hide', m.id); }
      await p1.close();
      // 新页新建
      shots['新页新建'] = {};
      for (const n of picks) { const p = await open(); const m = await call(p, 'make', name, mode); shots['新页新建'][n] = await call(p, 'jump', m.id, n); await p.close(); }
      // 别的卡在前、别的 Lottie 在前
      shots['别的卡在前'] = {}; shots['别的 Lottie 在前'] = {};
      for (const n of few) {
        let p = await open(); await call(p, 'burn', 13);
        let m = await call(p, 'make', name, mode); shots['别的卡在前'][n] = await call(p, 'jump', m.id, n); await p.close();
        p = await open();
        const other = await call(p, 'make', 'fixture', 'off'); await call(p, 'seq', other.id, [0, 1, 2, 3, 22, 23, 45], []); await call(p, 'hide', other.id);
        m = await call(p, 'make', name, mode); shots['别的 Lottie 在前'][n] = await call(p, 'jump', m.id, n); await p.close();
      }

      // 逐个 N 判:以「顺推」为准,别的各份和它比
      const perN = {}; const kinds = Object.keys(shots).filter((k) => k !== '顺推');
      const tally = { rawSame: 0, same: 0 };
      for (const n of picks) {
        const base = shots['顺推'][n]; const row = { hash: sha(base.v), rawSame: true, same: true, differ: {} };
        for (const kind of kinds) {
          const other = shots[kind][n]; if (other === undefined || other.r === base.r) continue;
          row.rawSame = false;
          const pixels = await call(tool, 'pixelDiff', base.r, other.r);
          if (other.v === base.v && pixels.pixels === 0) continue;
          row.same = false;
          const d = describeDiff(base.v, other.v, layerNames);
          row.differ[kind] = { visibleSame: other.v === base.v, pixels, layers: d.layers, at: d.at, a: d.a, b: d.b };
          fs.writeFileSync(path.join(OUT, `${name}-${mode}-${n}-顺推.svg`), base.r); fs.writeFileSync(path.join(OUT, `${name}-${mode}-${n}-${kind}.svg`), other.r);
        }
        if (row.rawSame) tally.rawSame++; if (row.same) tally.same++;
        perN[n] = row;
      }
      const allSame = tally.same === picks.length;
      let twiceSame = twice[0].text.r === twice[1].text.r;
      if (!twiceSame) twiceSame = twice[0].text.v === twice[1].text.v && (await call(tool, 'pixelDiff', twice[0].text.r, twice[1].text.r)).pixels === 0;
      const result = {
        seed: first.seed, layers: first.layers, built: first.built, buildMs: first.buildMs,
        allSame, rawSameCount: tally.rawSame, sameCount: tally.same, twice: { n: twiceN, same: twiceSame }, perN,
        // 建一份并顺推到最大的 N,全页那一串被吃掉几个(-1:超出参照的 4000 个)
        globalDraws: before0 < 0 || afterSeq < 0 ? -1 : afterSeq - before0 - 1,
        ms: Date.now() - started,
      };
      entry.modes[mode] = result;
      if (first.built !== first.layers) fail(`${name}/${mode}:建好后只建了 ${first.built}/${first.layers} 个图层`);
      const worst = (n) => Object.entries(perN[n].differ).map(([k, d]) => `${k}:${d.pixels.pct}%/${d.pixels.max}${d.layers ? `(${d.layers.join(',')})` : ''}`).join(' ');
      if (mode === 'on') {
        for (const n of picks) if (!perN[n].same) fail(`${name}/开:第 ${n} 帧和「顺推」不同 —— ${worst(n)}`);
        if (!twiceSame) fail(`${name}/开:连建两次,第 ${twiceN} 帧不同`);
        if (result.globalDraws !== 0) fail(`${name}/开:全页那一串被吃掉 ${result.globalDraws} 个(应为 0)`);
      }
      const bad = picks.filter((n) => !perN[n].same);
      console.log(`${name} / 开关${mode === 'on' ? '开' : '关'}:${picks.length} 个 N 里 ${tally.same} 个各份画面相同(其中原文也逐字节相同的 ${tally.rawSame} 个);连建两次${twiceSame ? '相同' : '不同'};全页那一串被吃掉 ${result.globalDraws} 个;图层 ${first.built}/${first.layers};${result.ms} 毫秒`);
      for (const n of bad) console.log(`     第 ${n} 帧不同(画面名:不同的像素占比/最大差(哪些图层)) ${worst(n)}`);
    }

    // 全长逐帧:开和关比
    if (!SKIP_SWEEP) {
      const all = Array.from({ length: total }, (_, i) => i); const hashes = {};
      for (const mode of ['off', 'on']) { const p = await open(); const m = await call(p, 'make', name, mode); hashes[mode] = await call(p, 'seqHashes', m.id, all); await p.close(); }
      const changed = all.filter((f) => hashes.off[f] !== hashes.on[f]);
      entry.sweep = { frames: total, changed: changed.length, changedFrames: changed };
      console.log(`${name} / 全长 ${total} 帧,开和关比:${changed.length ? `${changed.length} 帧变了(${changed.length > 12 ? `${changed.slice(0, 12).join(',')}…` : changed.join(',')})` : '逐帧相同'}`);
    }
  }

  // ── 不带随机表达式的素材顺推和直接跳为什么还会差一点(只报告;实验,不是原型的一部分)──
  if (ASSETS.includes('happy2016')) {
    const name = 'happy2016'; const { total, picks } = report.assets[name];
    const frames = Array.from({ length: Math.max(...picks) + 1 }, (_, i) => i);
    const rows = [];
    for (const [label, exact, cold] of [['原样', false, false], ['只清插值缓存', false, true], ['只去掉 0.00001 的门槛', true, false], ['两样都做', true, true]]) {
      const p = await open();
      const a = await call(p, 'make', name, 'on'); const tuned = await call(p, 'tune', a.id, exact);
      const pushed = await call(p, cold ? 'seqCold' : 'seq', a.id, frames, picks); await call(p, 'hide', a.id);
      let same = 0, pixelsMax = 0, pctMax = 0;
      for (const n of picks) {
        const b = await call(p, 'make', name, 'on'); await call(p, 'tune', b.id, exact); const jumped = await call(p, 'jump', b.id, n); await call(p, 'destroy', b.id);
        if (jumped.v === pushed[n].v) { same++; continue; }
        const d = await call(tool, 'pixelDiff', pushed[n].r, jumped.r); if (d.pixels === 0) continue;
        pixelsMax = Math.max(pixelsMax, d.pixels); pctMax = Math.max(pctMax, d.pct);
      }
      await p.close();
      rows.push({ label, props: tuned.props, visibleSame: same, of: picks.length, worstPixels: pixelsMax, worstPct: pctMax });
      console.log(`happy2016 / 实验「${label}」:${picks.length} 个 N 里顺推和直接跳看得见的文本相同的 ${same} 个;像素最多差 ${pixelsMax} 个(${pctMax}%);带关键帧的属性 ${tuned.props} 个`);
    }
    report.floatExperiment = rows;
  }

  // ── 真卡片 ──
  const fixtureText = fs.readFileSync(FIXTURE, 'utf8');
  const cardParams = { json: fixtureText, src: '', speed: 1, loop: 'no', fit: 'contain' };
  const srcParams = (name) => ({ json: '', src: `/lottie-data/${name}.json`, speed: 1, loop: 'no', fit: 'contain' });
  const fr = 30;
  if (ASSETS.includes('fixture')) {
    const on = report.assets.fixture.modes.on;
    // 开着:地址带 lottieSeed=1。直接挂在第 N 帧、挂在第 0 帧再一帧帧推到第 N 帧、前面先挂一张取随机数的卡,都要和「新页新建」那一份相同
    const rows = [];
    for (const n of [9, 21, 41, 59]) {
      const want = on.perN[n].hash; const row = { n, want };
      const sha = (shot) => crypto.createHash('sha256').update(shot.v).digest('hex').slice(0, 16);
      let p = await open('?lottieSeed=1'); row.enabled = await call(p, 'seedEnabled'); row.direct = sha(await call(p, 'mountCard', 'current', cardParams, n / fr, 0)); await p.close();
      p = await open('?lottieSeed=1'); let last = await call(p, 'mountCard', 'current', cardParams, 0, 0); for (let f = 1; f <= n; f++) last = await call(p, 'cardFrame', f / fr); row.pushed = sha(last); await p.close();
      p = await open('?lottieSeed=1'); row.afterOther = sha(await call(p, 'mountCard', 'current', cardParams, n / fr, 13)); await p.close();
      row.same = row.enabled === true && row.direct === want && row.pushed === want && row.afterOther === want;
      if (!row.same) fail(`真卡片/开:fixture 第 ${n} 帧 直接挂 ${row.direct}、推过来 ${row.pushed}、别的卡在前 ${row.afterOther},应为 ${want}(开关读到 ${row.enabled})`);
      rows.push(row);
    }
    report.card.on = rows;
    console.log(`真卡片 / 开关开(地址带 lottieSeed=1):fixture 第 ${rows.map((r) => r.n).join('、')} 帧,直接挂、从第 0 帧推过来、别的卡在前 —— ${rows.every((r) => r.same) ? '都和 loadLottie 直接跳的那一份逐字节相同' : '有不同'}`);
  }
  // 关着:和 --before 那个提交的卡片逐帧相同(内联 JSON 的 fixture,和走 src 加载的 navidad)
  {
    const cases = [];
    if (ASSETS.includes('fixture')) cases.push(['fixture(内联 JSON)', cardParams, 30, fr]);
    if (ASSETS.includes('navidad')) cases.push(['navidad(src 加载)', srcParams('navidad'), 12, 25]);
    report.card.off = [];
    for (const [label, params, count, rate] of cases) {
      const seqs = {};
      for (const which of ['before', 'current']) {
        const p = await open(); const enabled = await call(p, 'seedEnabled'); if (enabled) fail(`真卡片/关:不带开关时 lottieSeedEnabled() 是 true`);
        // 关着比的是原文:连看不见的图层上留着的旧属性也要一样
        const out = [sha((await call(p, 'mountCard', which, params, 0, 0)).r)];
        for (let f = 1; f < count; f++) out.push(sha((await call(p, 'cardFrame', f / rate)).r));
        // 再往回跳一次、往前跳一次
        out.push(sha((await call(p, 'cardFrame', 3 / rate)).r)); out.push(sha((await call(p, 'cardFrame', (count + 5) / rate)).r));
        seqs[which] = out; await p.close();
      }
      const equal = seqs.before.filter((h, i) => h === seqs.current[i]).length;
      report.card.off.push({ label, frames: seqs.before.length, equal });
      if (equal !== seqs.before.length) fail(`真卡片/关:${label} 和 ${BEFORE} 的卡片 ${seqs.before.length} 帧里只有 ${equal} 帧相同`);
      console.log(`真卡片 / 开关关:${label} 和 ${BEFORE} 的卡片比,${seqs.before.length} 帧里 ${equal} 帧原文逐字节相同`);
    }
  }
  await tool.close();
  if (report.pageErrors.length) fail(`页面报错或警告 ${report.pageErrors.length} 条:${report.pageErrors.slice(0, 3).join(' | ')}`);
} catch (e) {
  fail(`探针自己出错:${String(e?.stack ?? e).slice(0, 600)}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  await vite.close().catch(() => {});
}
report.ms = Date.now() - t0;
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(report, null, 2));
console.log(`机器:${report.host.cpu},${report.host.logicalCores} 个逻辑核;${report.chrome};lottie-web ${report.lottieWeb};用时 ${(report.ms / 1000).toFixed(1)} 秒;结果 ${path.join(OUT, 'result.json')}`);
console.log(JSON.stringify({ ok: report.fails.length === 0, fails: report.fails }));
process.exitCode = report.fails.length ? 1 : 0;
