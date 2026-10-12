/**
 * 探针:Lottie 卡改前改后的逐帧比对(「留底」和「对照留底」)。
 * 出处:`docs/plan/render-refactor-task.md`「癸:Lottie 改成 remotion 式」的验收——改之前先留底,5 个自带素材各取全长逐帧截图;
 * 改之后逐帧相同,跳着取的若干帧也相同。像素基线的演示项目里没有 Lottie,全量比对测不到它,以这份针对性的比对为准。
 *
 *   留底  node scripts/probes/lottie-baseline-probe.mjs capture --out out/lottie-baseline/before [--port 27600] [--assets adrock,…,demo]
 *   对照  node scripts/probes/lottie-baseline-probe.mjs compare --a out/lottie-baseline/before --b out/lottie-baseline/after [--json <文件>]
 *
 * 留底怎么取:起一个只服务本探针的 vite(根是本工作区,不读项目的 vite 配置,只占 --port 一个端口),无头 Chrome 里装上和产品
 * 一样的随机数钉子(`installPinnedEntropy`),用 React 挂**真的** `LottieView`(素材封装卡用的就是它,`src` 指向素材目录里的文件;
 * `demo` 是通用 Lottie 卡缺省参数里内联的那段演示动画)。卡片摆在 1920×1080 的框里,页面截图存成 PNG。每个素材取三组:
 *   seq   顺推:挂在第 0 帧,一帧一帧推到最后一帧,每帧一张(全长)
 *   back  回跳:顺推完以后,同一份实例回到第 0 帧再直接跳到抽的那几帧
 *   jump  直接跳:每个抽的帧新开一个页面,直接挂在那一帧
 * 帧号按素材自己的帧率走(t = 帧号 / 帧率,和卡片里 t → 帧号的换算相反)。每张图另记「看得见的 SVG 文本」的散列
 * (去掉 `display: none` 的节点里的内容和没人引用的 `<defs>`,口径同 `lottie-seed-probe.mjs`),用来分清「文本变了、像素没变」。
 *
 * 对照怎么比:同名的两张图 PNG 字节相同算相同;字节不同就解码逐像素数,报不同的像素数和最大差值。
 * 退出码:compare 只在两边缺图、对不上数时非 0;有不同的帧照实列出,由报告逐个说明原因(预料中的见任务书「癸」)。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [, , COMMAND] = process.argv;
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : dflt; };
const BUNDLED = ['adrock', 'bodymovin', 'gatin', 'happy2016', 'navidad'];
const CATALOG = path.join(ROOT, 'server', 'catalog', 'lottie');
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 20);
const pad = (n) => String(n).padStart(4, '0');

if (COMMAND === 'capture') await capture();
else if (COMMAND === 'compare') await compare();
else { console.error('用法见文件头:capture --out <目录> | compare --a <目录> --b <目录>'); process.exit(2); }

async function capture() {
  const { createServer } = await import('vite');
  const { default: puppeteer } = await import('puppeteer');
  const { PROBE_CHROME_ARGS } = await import('./probe-chrome.mjs');
  const PORT = Number(arg('--port', '27600'));
  if (!Number.isInteger(PORT) || PORT < 27600 || PORT > 27619) throw new Error('--port 只能用 27600～27619');
  const OUT = path.resolve(ROOT, arg('--out', 'out/lottie-baseline/run'));
  const ASSETS = arg('--assets', [...BUNDLED, 'demo'].join(',')).split(',').filter(Boolean);
  const POKE = arg('--poke', '');
  fs.mkdirSync(OUT, { recursive: true });

  const HARNESS = String.raw`<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;background:#111;overflow:hidden}.absolute{position:absolute}.inset-0{inset:0}#card{position:absolute;left:0;top:0;width:1920px;height:1080px}</style>
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
  import { LottieView, lottieCard } from '/src/cards/native/lottie.tsx';
  import { waitForFrameWork } from '/src/kernel/frameReady.ts';
  const normalize = (s) => { const ids = new Map(); return s.replace(/__lottie_element_\d+/g, (m) => { if (!ids.has(m)) ids.set(m, 'E' + ids.size); return ids.get(m); }); };
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
    const refsOf = (el, into) => { for (const node of [el, ...el.querySelectorAll('*')]) for (const a of node.attributes) { for (const m of a.value.matchAll(/url\(["']?#([^)"']+)["']?\)/g)) into.add(m[1]); if (a.localName === 'href' && a.value.startsWith('#')) into.add(a.value.slice(1)); } };
    const byId = new Map(); for (const el of copy.querySelectorAll('[id]')) byId.set(el.getAttribute('id'), el);
    const used = new Set(); const pending = new Set();
    for (const child of copy.children) if (child.localName !== 'defs') refsOf(child, pending);
    while (pending.size) { const id = pending.values().next().value; pending.delete(id); if (used.has(id)) continue; used.add(id); const el = byId.get(id); if (el) { const more = new Set(); refsOf(el, more); for (const x of more) if (!used.has(x)) pending.add(x); } }
    for (const defs of copy.querySelectorAll('defs')) for (const res of [...defs.children]) { const ids = [res, ...res.querySelectorAll('[id]')].map((el) => el.getAttribute('id')).filter(Boolean); if (!ids.some((id) => used.has(id))) res.remove(); }
    return normalize(new XMLSerializer().serializeToString(copy));
  };
  const api = {
    root: null, params: null,
    mount(name, t) {
      api.params = name === 'demo'
        ? { json: lottieCard.defaults.json, src: '', speed: 1, loop: 'no', fit: 'contain' }
        : { json: '', src: '/catalog/lottie/' + name + '.json', speed: 1, loop: 'no', fit: 'contain' };
      api.root = createRoot(document.getElementById('card'));
      return api.frame(t);
    },
    async frame(t) {
      flushSync(() => api.root.render(React.createElement(LottieView, { ...api.params, t })));
      // 走 src 的要等取数;播放库的 DOMLoaded 是 setTimeout(0) 发的,卡片在那以后才交「这一帧好了」
      await new Promise((resolve) => setTimeout(resolve, 0));
      await waitForFrameWork();
      const svg = document.querySelector('#card svg');
      // 等浏览器把这一帧画出来再让外面截图
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return svg ? visible(svg) : '';
    },
  };
  window.api = api; window.ready = true;
</script>`;

  const plugin = {
    name: 'lottie-baseline-probe', enforce: 'pre',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url, 'http://x');
        res.setHeader('cache-control', 'no-store');
        if (url.pathname === '/favicon.ico') { res.statusCode = 204; res.end(); return; }
        if (url.pathname === '/harness') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(await server.transformIndexHtml('/harness', HARNESS)); return; }
        const m = /^\/catalog\/lottie\/([a-z0-9]+)\.json$/.exec(url.pathname);
        if (m && BUNDLED.includes(m[1])) { res.setHeader('content-type', 'application/json'); res.end(fs.readFileSync(path.join(CATALOG, `${m[1]}.json`))); return; }
        next();
      });
    },
  };
  const vite = await createServer({
    root: ROOT, configFile: false, plugins: [plugin], logLevel: 'error', appType: 'custom',
    cacheDir: path.join(os.tmpdir(), 'pc-lottie-baseline-probe-vite'),
    optimizeDeps: { include: ['lottie-web', 'react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'] },
    server: { host: '127.0.0.1', port: PORT, strictPort: true, hmr: false, watch: null },
  });
  await vite.listen();
  let browser = null;
  const started = Date.now();
  const index = { when: new Date().toISOString(), out: OUT, pageErrors: [], assets: {} };
  try {
    browser = await puppeteer.launch({ headless: true, protocolTimeout: 900000, args: [...PROBE_CHROME_ARGS, '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1'] });
    index.chrome = await browser.version();
    const open = async () => {
      const page = await browser.newPage();
      await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
      page.on('pageerror', (e) => index.pageErrors.push(String(e?.message ?? e).slice(0, 300)));
      page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warn') index.pageErrors.push(`console.${m.type()}: ${m.text().slice(0, 300)}`); });
      await page.goto(`http://127.0.0.1:${PORT}/harness`, { waitUntil: 'load' });
      await page.waitForFunction('window.ready === true', { timeout: 120000 });
      return page;
    };
    const shot = async (page, file, vis) => {
      const png = Buffer.from(await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 1920, height: 1080 } }));
      fs.writeFileSync(file, png);
      return { png: sha(png), vis: sha(vis), empty: vis === '' };
    };
    for (const name of ASSETS) {
      const data = name === 'demo' ? { fr: 30, ip: 0, op: 60 } : JSON.parse(fs.readFileSync(path.join(CATALOG, `${name}.json`), 'utf8'));
      const fr = Number(data.fr) || 30, total = Math.max(1, (Number(data.op) || 0) - (Number(data.ip) || 0));
      const picks = [...new Set([0, 1, Math.floor(total * 0.13), Math.floor(total * 0.31), Math.floor(total / 2), Math.floor(total * 0.69), total - 2, total - 1])].filter((f) => f >= 0 && f < total);
      const dir = path.join(OUT, name);
      fs.mkdirSync(dir, { recursive: true });
      const entry = { fr, total, picks, seq: [], back: {}, jump: {} };
      index.assets[name] = entry;
      const page = await open();
      for (let f = 0; f < total; f++) {
        const vis = await page.evaluate((n, t, first) => (first ? window.api.mount(n, t) : window.api.frame(t)), name, f / fr, f === 0);
        entry.seq.push(await shot(page, path.join(dir, `seq-${pad(f)}.png`), vis));
        if (POKE === `${name}:${f}`) {
          // 诊断用:顺推到这一帧以后,用几种办法逼浏览器重画,各存一张,看哪一种能让画面变成直接跳的那一张
          const tricks = {
            wait: () => new Promise((r) => setTimeout(r, 500)),
            reflow: () => { const svg = document.querySelector('#card svg'); svg.style.display = 'none'; void svg.getBoundingClientRect(); svg.style.display = 'block'; },
            reattach: () => { const svg = document.querySelector('#card svg'); const parent = svg.parentNode; parent.removeChild(svg); parent.appendChild(svg); },
          };
          for (const [trick, fn] of Object.entries(tricks)) {
            await page.evaluate(`(${fn.toString()})()`);
            await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
            const r = await shot(page, path.join(dir, `poke-${pad(f)}-${trick}.png`), vis);
            console.log(`  poke ${trick}: ${r.png}(顺推那张 ${entry.seq[f].png})`);
          }
        }
      }
      await page.evaluate(() => window.api.frame(0));
      for (const f of picks) {
        const vis = await page.evaluate((t) => window.api.frame(t), f / fr);
        entry.back[f] = await shot(page, path.join(dir, `back-${pad(f)}.png`), vis);
      }
      await page.close();
      for (const f of picks) {
        const fresh = await open();
        const vis = await fresh.evaluate((n, t) => window.api.mount(n, t), name, f / fr);
        entry.jump[f] = await shot(fresh, path.join(dir, `jump-${pad(f)}.png`), vis);
        await fresh.close();
      }
      const empties = entry.seq.filter((s) => s.empty).length;
      console.log(`${name}:${total} 帧(帧率 ${fr}),顺推 ${entry.seq.length} 张,回跳 ${Object.keys(entry.back).length} 张,直接跳 ${Object.keys(entry.jump).length} 张(第 ${picks.join('、')} 帧);没有 SVG 的 ${empties} 张`);
      if (empties) index.pageErrors.push(`${name}:有 ${empties} 张图里没有 SVG`);
    }
  } finally {
    index.seconds = +((Date.now() - started) / 1000).toFixed(1);
    fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 1));
    await browser?.close().catch(() => {});
    await vite.close().catch(() => {});
  }
  console.log(`留底写到 ${OUT},用时 ${index.seconds} 秒;页面报错和警告 ${index.pageErrors.length} 条`);
  for (const e of index.pageErrors.slice(0, 10)) console.log(`  ${e}`);
  process.exit(index.pageErrors.length ? 1 : 0);
}

async function compare() {
  const { PNG } = await import('pngjs');
  const A = path.resolve(ROOT, arg('--a', '')), B = path.resolve(ROOT, arg('--b', ''));
  const ia = JSON.parse(fs.readFileSync(path.join(A, 'index.json'), 'utf8')), ib = JSON.parse(fs.readFileSync(path.join(B, 'index.json'), 'utf8'));
  const result = { a: A, b: B, assets: {}, problems: [] };
  const pixels = (fa, fb) => {
    const pa = PNG.sync.read(fs.readFileSync(fa)), pb = PNG.sync.read(fs.readFileSync(fb));
    if (pa.width !== pb.width || pa.height !== pb.height) return { pixels: -1, max: 255 };
    let count = 0, max = 0;
    for (let i = 0; i < pa.data.length; i += 4) {
      const d = Math.max(Math.abs(pa.data[i] - pb.data[i]), Math.abs(pa.data[i + 1] - pb.data[i + 1]), Math.abs(pa.data[i + 2] - pb.data[i + 2]), Math.abs(pa.data[i + 3] - pb.data[i + 3]));
      if (d) { count++; if (d > max) max = d; }
    }
    return { pixels: count, max };
  };
  for (const name of Object.keys(ia.assets)) {
    const ea = ia.assets[name], eb = ib.assets[name];
    if (!eb) { result.problems.push(`${name}:后一份里没有`); continue; }
    if (ea.total !== eb.total) { result.problems.push(`${name}:帧数对不上 ${ea.total} / ${eb.total}`); continue; }
    const out = { total: ea.total };
    for (const group of ['seq', 'back', 'jump']) {
      const keys = group === 'seq' ? ea.seq.map((_, i) => i) : Object.keys(ea[group]).map(Number);
      const g = { count: keys.length, same: 0, textOnly: [], pixelDiff: [] };
      for (const f of keys) {
        const sa = ea[group][f], sb = eb[group][f];
        if (!sa || !sb) { result.problems.push(`${name} ${group} 第 ${f} 帧:缺图`); continue; }
        if (sa.png === sb.png) { if (sa.vis === sb.vis) g.same++; else g.textOnly.push(f); continue; }
        const d = pixels(path.join(A, name, `${group}-${pad(f)}.png`), path.join(B, name, `${group}-${pad(f)}.png`));
        if (d.pixels === 0) { if (sa.vis === sb.vis) g.same++; else g.textOnly.push(f); } else g.pixelDiff.push({ f, pixels: d.pixels, max: d.max, textSame: sa.vis === sb.vis });
      }
      out[group] = g;
      const worst = g.pixelDiff.reduce((m, x) => Math.max(m, x.pixels), 0);
      console.log(`${name} ${group}:${g.count} 张,相同 ${g.same};文本不同像素相同 ${g.textOnly.length}${g.textOnly.length ? `(第 ${ranges(g.textOnly)} 帧)` : ''};像素不同 ${g.pixelDiff.length}${g.pixelDiff.length ? `(第 ${ranges(g.pixelDiff.map((x) => x.f))} 帧,最多 ${worst} 个像素,最大差 ${g.pixelDiff.reduce((m, x) => Math.max(m, x.max), 0)})` : ''}`);
    }
    result.assets[name] = out;
  }
  const json = arg('--json', '');
  if (json) fs.writeFileSync(path.resolve(ROOT, json), JSON.stringify(result, null, 1));
  for (const p of result.problems) console.log(`对不上:${p}`);
  process.exit(result.problems.length ? 1 : 0);
}

/** [1,2,3,7,9,10] → "1～3、7、9～10" */
function ranges(list) {
  const xs = [...list].sort((a, b) => a - b), out = [];
  for (let i = 0; i < xs.length; i++) { let j = i; while (j + 1 < xs.length && xs[j + 1] === xs[j] + 1) j++; out.push(j > i ? `${xs[i]}～${xs[j]}` : `${xs[i]}`); i = j; }
  return out.join('、');
}
