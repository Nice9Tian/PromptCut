/**
 * 实验:同一张卡的逐帧快照,「整块换 HTML」和「结构留着、只改变了的地方」每帧各花多少时间。
 * 出处:`docs/plan/render-standard.md`「预渲染的产物」(2026-10-09 用户定:快照结构存一份、每帧只存变了的地方)。
 *
 *   node scripts/probes/snapshot-diff-apply-probe.mjs --dir <快照目录> [选项]
 *
 *   --dir <目录>     里面每个子目录是一张卡,子目录里是 0.html、1.html……(帧库的 `controls-html` 就是这个形状);
 *                    缺省用主工作区的 out/frame-library/controls-html
 *   --frames 120     每张卡取前多少帧
 *   --throttle 4     主线程按倍数放慢(模拟慢的处理器)
 *   --cores 2        把 Chrome 进程树限制在前 N 个核上(只在 Windows 上做)
 *   --software       关掉显卡
 *   --repeat 60      把每帧的内容重复 N 份放进同一个包裹层(真实样本只有几个节点,用这个看节点多的时候);
 *                    单帧超过 100 KB 的卡(画布卡,内容是一张内嵌的图)在重复时跳过
 *   --moving 6       重复出来的 N 份里只有前 K 份逐帧在变,其余停在第 0 帧(缺省全部在变)
 *   --json <文件>
 *
 * 两种贴法:
 *   甲(现在的做法)   每一帧 `包裹层.innerHTML = 这一帧的 HTML`;
 *   乙(只改变了的)   第 0 帧照甲建好;之后每帧只把和上一帧不同的地方改掉(某个元素的某条样式、某个属性、某段文字)。
 *                    哪里不同是**事先**算好的(相当于生成快照时就存成差异),不计入贴图时间。
 *                    结构变了的帧(元素多了少了、换了标签)整块换,并计数。
 *
 * 量两个数:
 *   同步耗时   改完 DOM 再强制排版一次(读 offsetHeight)所花的时间,脚本加排版;
 *   每帧间隔   每个动画帧贴一帧,连续贴完的总时间 ÷ 帧数,把画和合成也算进去(启动参数关了垂直同步与帧率上限)。
 *
 * 判过的标准只有一条:乙贴出来的 DOM 和甲逐节点相同(每 10 帧核一次:结构、文字、属性、每条样式的值)。不相同退出码 1。
 *
 * 页面给包裹层里的所有元素加了「不许过渡、不许动画」:快照把算好的样式整个内联了,里面可能带着 `transition-duration`,
 * 只改一个数值时浏览器会自己做一段过渡,画面就不是这一帧该有的样子了。真做的时候同样要这样压住。
 * 耗时只记录,不当通过条件。
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : dflt; };
const flag = (name) => process.argv.includes(name);

/** 工作区建在仓库目录的 .worktrees/ 下,帧库在主工作区;两处都找一下 */
function defaultDir() {
  for (const base of [ROOT, path.resolve(ROOT, '..', '..')]) {
    const d = path.join(base, 'out', 'frame-library', 'controls-html');
    if (fs.existsSync(d)) return d;
  }
  return null;
}
const DIR = arg('--dir', defaultDir());
const FRAMES = Number(arg('--frames', '120'));
const THROTTLE = Number(arg('--throttle', '1'));
const CORES = Number(arg('--cores', '0'));
const SOFTWARE = flag('--software');
const REPEAT = Math.max(1, Number(arg('--repeat', '1')));
const MOVING = Math.min(REPEAT, Math.max(1, Number(arg('--moving', String(REPEAT)))));
const JSON_OUT = arg('--json', null);
if (!DIR || !fs.existsSync(DIR)) { console.error('没有快照目录:用 --dir 指一个(每个子目录一张卡,里面是 0.html、1.html……)'); process.exit(2); }

const cards = fs.readdirSync(DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => {
  const files = fs.readdirSync(path.join(DIR, e.name)).filter((f) => /^\d+\.html$/.test(f)).map((f) => Number(f.replace('.html', ''))).sort((a, b) => a - b);
  return { id: e.name, frames: files.slice(0, FRAMES) };
}).filter((c) => c.frames.length >= 2);
if (!cards.length) { console.error('目录里没有可用的快照序列'); process.exit(2); }

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end('<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#111;overflow:hidden}#host{position:absolute;left:0;top:0;width:1920px;height:1080px;overflow:hidden}#host,#host *{transition:none!important;animation:none!important}</style><div id="host"></div><div id="tick" style="position:absolute;right:0;bottom:0;width:2px;height:2px"></div>'); return; }
  const m = /^\/snap\/([0-9a-f]+)\/(\d+)\.html$/.exec(url.pathname);
  if (m && cards.some((c) => c.id === m[1])) {
    const file = path.join(DIR, m[1], `${m[2]}.html`);
    if (fs.existsSync(file)) { res.setHeader('content-type', 'text/plain; charset=utf-8'); res.end(fs.readFileSync(file)); return; }
  }
  res.statusCode = 404; res.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://localhost:${server.address().port}`;

function limitCores(rootPid, cores) {
  if (process.platform !== 'win32' || !(cores > 0)) return null;
  const mask = (2 ** cores) - 1;
  const script = `
$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
$ids = New-Object System.Collections.Generic.List[int]; $ids.Add(${rootPid})
$i = 0; while ($i -lt $ids.Count) { $p = $ids[$i]; foreach ($c in $all) { if ($c.ParentProcessId -eq $p -and -not $ids.Contains([int]$c.ProcessId)) { $ids.Add([int]$c.ProcessId) } }; $i++ }
$n = 0; foreach ($id in $ids) { try { (Get-Process -Id $id -ErrorAction Stop).ProcessorAffinity = [IntPtr]${mask}; $n++ } catch {} }
"$n/$($ids.Count)"`;
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim();
}

async function inPage({ id, frames, repeat, moving }) {
  const host = document.getElementById('host');
  const htmls = [];
  for (const n of frames) htmls.push(await (await fetch(`/snap/${id}/${n}.html`)).text());
  if (repeat > 1) {
    if (htmls[0].length > 100 * 1024) return { id: id.slice(0, 8), skipped: "单帧超过 100 KB,重复时跳过" };
    const still = htmls[0];
    for (let i = 0; i < htmls.length; i++) { let s = ""; for (let c = 0; c < repeat; c++) s += c < moving ? htmls[i] : still; htmls[i] = s; }
  }
  // 每等一个动画帧就让角上一个 2×2 的小块换一次颜色:两种贴法都保证「这一帧画面确实变了」。
  // 不这样做的话,只改透明度这一类数值的帧,无头浏览器的动画帧会掉到约 12 毫秒一次的固定节奏
  // (实测:两张卡都是 11.945 毫秒,加了这个小块就回到 0.2 毫秒上下;原因没有深究),量出来的不是贴图的开销。
  const tick = document.getElementById("tick"); let tickOn = false;
  const nextFrame = () => new Promise((resolve) => { tickOn = !tickOn; tick.style.background = tickOn ? "#222" : "#333"; requestAnimationFrame(() => resolve()); });

  /* ---- 事先算差异:拿上一帧和这一帧各解析成一棵不上屏的树,并排走一遍 ---- */
  const parse = (html) => { const t = document.createElement('template'); t.innerHTML = html; return t.content; };
  const walk = (root) => { const out = []; const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT); for (let n = tw.nextNode(); n; n = tw.nextNode()) out.push(n); return out; };
  const sameShape = (a, b) => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) { if (a[i].nodeType !== b[i].nodeType || a[i].nodeName !== b[i].nodeName || a[i].childNodes.length !== b[i].childNodes.length) return false; }
    return true;
  };
  const diffs = [];           // diffs[i]:第 i 帧相对第 i-1 帧;null 表示结构变了,整块换
  let structural = 0, opCount = 0, opBytes = 0, styleOps = 0, attrOps = 0, textOps = 0;
  const prepStart = performance.now();
  let prev = walk(parse(htmls[0]));
  for (let i = 1; i < htmls.length; i++) {
    const cur = walk(parse(htmls[i]));
    if (!sameShape(prev, cur)) { diffs.push(null); structural++; prev = cur; continue; }
    const ops = [];
    for (let k = 0; k < cur.length; k++) {
      const a = prev[k], b = cur[k];
      if (b.nodeType !== 1) { if (a.nodeValue !== b.nodeValue) { ops.push([k, 2, b.nodeValue]); textOps++; } continue; }
      // 属性:样式拆到单条去比,别的属性整条比
      const names = new Set([...a.getAttributeNames(), ...b.getAttributeNames()]);
      for (const name of names) {
        const va = a.getAttribute(name), vb = b.getAttribute(name);
        if (va === vb) continue;
        if (name === 'style' && va !== null && vb !== null) {
          const sa = a.style, sb = b.style;
          const props = new Set(); for (let j = 0; j < sa.length; j++) props.add(sa[j]); for (let j = 0; j < sb.length; j++) props.add(sb[j]);
          for (const p of props) {
            const x = sa.getPropertyValue(p), y = sb.getPropertyValue(p), px = sa.getPropertyPriority(p), py = sb.getPropertyPriority(p);
            if (x !== y || px !== py) { ops.push([k, 0, p, y, py]); styleOps++; }
          }
        } else { ops.push([k, 1, name, vb]); attrOps++; }
      }
    }
    diffs.push(ops); opCount += ops.length; opBytes += JSON.stringify(ops).length;
    prev = cur;
  }
  const prepMs = performance.now() - prepStart;

  const applyOps = (nodes, ops) => {
    for (const op of ops) {
      const node = nodes[op[0]];
      if (op[1] === 0) { if (op[3] === '') node.style.removeProperty(op[2]); else node.style.setProperty(op[2], op[3], op[4]); }
      else if (op[1] === 1) { if (op[3] === null) node.removeAttribute(op[2]); else node.setAttribute(op[2], op[3]); }
      else node.nodeValue = op[2];
    }
  };

  /**
   * 两棵树是不是一样:结构、文字、属性逐个比;样式按「有哪些属性、各是什么值」比,不比字符串
   * (用 setProperty 改过的元素,浏览器会把 style 属性重新排版成带空格的写法,字符串不同但内容相同)。
   */
  const sameTree = (a, b) => {
    if (!sameShape(a, b)) return "结构不同";
    for (let k = 0; k < a.length; k++) {
      const x = a[k], y = b[k];
      if (x.nodeType !== 1) { if (x.nodeValue !== y.nodeValue) return `第 ${k} 个节点的文字不同`; continue; }
      const names = new Set([...x.getAttributeNames(), ...y.getAttributeNames()]);
      for (const name of names) {
        if (name === "style") {
          const sx = x.style, sy = y.style;
          if (sx.length !== sy.length) return `第 ${k} 个节点的样式条数不同(${sx.length} / ${sy.length})`;
          for (let j = 0; j < sy.length; j++) { const p = sy[j]; if (sx.getPropertyValue(p) !== sy.getPropertyValue(p) || sx.getPropertyPriority(p) !== sy.getPropertyPriority(p)) return `第 ${k} 个节点的 ${p} 不同`; }
        } else if (x.getAttribute(name) !== y.getAttribute(name)) return `第 ${k} 个节点的 ${name} 属性不同`;
      }
    }
    return null;
  };

  /* ---- 甲:整块换 ---- */
  const runWhole = async (measureSync) => {
    host.innerHTML = htmls[0]; await nextFrame(); await nextFrame();
    let sync = 0; const t0 = performance.now();
    for (let i = 1; i < htmls.length; i++) {
      const a = performance.now();
      host.innerHTML = htmls[i];
      if (measureSync) { void host.offsetHeight; sync += performance.now() - a; }
      else await nextFrame();
    }
    return measureSync ? sync / (htmls.length - 1) : (performance.now() - t0) / (htmls.length - 1);
  };

  /* ---- 乙:只改变了的地方 ---- */
  let mismatch = null;
  const runDiff = async (measureSync, check) => {
    host.innerHTML = htmls[0]; await nextFrame(); await nextFrame();
    let nodes = walk(host);
    let sync = 0; const t0 = performance.now();
    for (let i = 1; i < htmls.length; i++) {
      const ops = diffs[i - 1];
      const a = performance.now();
      if (ops === null) { host.innerHTML = htmls[i]; nodes = walk(host); } else applyOps(nodes, ops);
      if (measureSync) { void host.offsetHeight; sync += performance.now() - a; }
      else await nextFrame();
      if (check && (i % 10 === 0 || i === htmls.length - 1) && !mismatch) {
        const why = sameTree(walk(host), walk(parse(htmls[i])));
        if (why) mismatch = `第 ${frames[i]} 帧贴出来的和整块换的不一样:${why}`;
      }
    }
    return measureSync ? sync / (htmls.length - 1) : (performance.now() - t0) / (htmls.length - 1);
  };

  await runDiff(true, true);                               // 先核一遍对不对(这一遍的耗时不用)
  // 各量三遍取中位数,甲乙交替着量
  const med = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const wholeSync = [], diffSync = [], wholeFrame = [], diffFrame = [];
  for (let r = 0; r < 3; r++) { wholeSync.push(await runWhole(true)); diffSync.push(await runDiff(true, false)); }
  for (let r = 0; r < 3; r++) { wholeFrame.push(await runWhole(false)); diffFrame.push(await runDiff(false, false)); }
  host.innerHTML = '';

  const htmlBytes = htmls.reduce((s, h) => s + h.length, 0);
  const steps = htmls.length - 1;
  return {
    id: id.slice(0, 8), frames: htmls.length, nodes: walk(parse(htmls[0])).length,
    htmlKBPerFrame: +(htmlBytes / htmls.length / 1024).toFixed(1),
    structuralFrames: structural, opsPerFrame: +(opCount / Math.max(1, steps - structural)).toFixed(1), styleOps, attrOps, textOps,
    diffKBPerFrame: +(opBytes / Math.max(1, steps - structural) / 1024).toFixed(2),
    prepMsPerFrame: +(prepMs / steps).toFixed(2),
    wholeSyncMs: +med(wholeSync).toFixed(3), diffSyncMs: +med(diffSync).toFixed(3),
    wholeFrameMs: +med(wholeFrame).toFixed(3), diffFrameMs: +med(diffFrame).toFixed(3),
    mismatch,
  };
}

const report = { when: new Date().toISOString(), host: { cpu: os.cpus()[0]?.model?.trim(), logicalCores: os.cpus().length, memGiB: Math.round(os.totalmem() / 2 ** 30) },
  options: { dir: DIR, frames: FRAMES, repeat: REPEAT, moving: MOVING, throttle: THROTTLE, cores: CORES || null, software: SOFTWARE }, results: [], failures: [] };
let browser = null;
try {
  browser = await puppeteer.launch({ headless: true, protocolTimeout: 900000,
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--disable-gpu-vsync', '--disable-frame-rate-limit', ...(SOFTWARE ? ['--disable-gpu'] : [])] });
  report.chrome = await browser.version();
  if (CORES > 0) limitCores(browser.process().pid, CORES);
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  await page.goto(base + '/');
  if (CORES > 0) report.affinity = limitCores(browser.process().pid, CORES);
  if (THROTTLE > 1) { const cdp = await page.createCDPSession(); await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE }); }
  for (const card of cards) {
    const r = await page.evaluate(inPage, { ...card, repeat: REPEAT, moving: MOVING });
    if (r.skipped) { report.skipped = [...(report.skipped || []), `${r.id}:${r.skipped}`]; continue; }
    report.results.push(r);
    if (r.mismatch) report.failures.push(`${r.id}:${r.mismatch}`);
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
}

console.log(`机器:${report.host.cpu},${report.host.logicalCores} 个逻辑核;${report.chrome}`);
console.log(`条件:${SOFTWARE ? '关显卡' : '缺省'}${CORES ? `,限 ${CORES} 核(进程 ${report.affinity})` : ''}${THROTTLE > 1 ? `,主线程放慢 ${THROTTLE} 倍` : ''};每张卡前 ${FRAMES} 帧${REPEAT > 1 ? `,每帧内容重复 ${REPEAT} 份、其中 ${MOVING} 份在变` : ''};快照来自 ${DIR}`);
for (const r of report.results) {
  console.log(`卡 ${r.id}:${r.frames} 帧,${r.nodes} 个节点,每帧 HTML ${r.htmlKBPerFrame} KB;结构变了的帧 ${r.structuralFrames};其余每帧平均改 ${r.opsPerFrame} 处(样式 ${r.styleOps}、属性 ${r.attrOps}、文字 ${r.textOps}),差异 ${r.diffKBPerFrame} KB/帧`);
  console.log(`   同步耗时(脚本+排版)  整块换 ${r.wholeSyncMs} 毫秒   只改变了的 ${r.diffSyncMs} 毫秒   ${(r.wholeSyncMs / Math.max(r.diffSyncMs, 1e-3)).toFixed(1)} 倍`);
  console.log(`   每帧间隔(含画与合成)  整块换 ${r.wholeFrameMs} 毫秒   只改变了的 ${r.diffFrameMs} 毫秒   ${(r.wholeFrameMs / Math.max(r.diffFrameMs, 1e-3)).toFixed(1)} 倍`);
  console.log(`   事先算差异 ${r.prepMsPerFrame} 毫秒/帧(生成快照时做一次,不在贴图时做)${r.mismatch ? '   ✖ ' + r.mismatch : '   贴出来的 DOM 与整块换逐节点相同'}`);
}
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
if (report.failures.length) { console.log('不过:\n  ' + report.failures.join('\n  ')); process.exitCode = 1; } else console.log('核对通过(耗时只记录)');
