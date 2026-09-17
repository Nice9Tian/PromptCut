// Probe: does backdrop-filter on a card wrapper sample (a) a sibling <canvas>
// (2D and WebGL), (b) a sibling <video>, when the wrapper has `isolation: isolate`
// (as src/kernel/Stage.tsx:131 does)? And (c) does it sample the parent document
// when the glass is inside an iframe? Compare mean pixel under the glass.
import puppeteer from 'puppeteer';
import fs from 'node:fs';

const stage = (isolate) => `<!doctype html><body style="margin:0;background:#fff">
<div id=scene style="position:relative;width:400px;height:200px;overflow:hidden">
  <canvas id=c2 width=200 height=200 style="position:absolute;left:0;top:0"></canvas>
  <canvas id=gl width=200 height=200 style="position:absolute;left:200px;top:0"></canvas>
  <div id=wrap style="position:absolute;left:50px;top:50px;width:300px;height:100px;${isolate ? 'isolation:isolate;' : ''}">
    <div id=glass style="width:100%;height:100%;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);background:rgba(255,255,255,0.05)"></div>
  </div>
</div>
<script>
  // 2D canvas: hard 8px black/white stripes -> blur turns them grey
  const c = document.getElementById('c2').getContext('2d');
  for (let x = 0; x < 200; x += 16) { c.fillStyle = '#000'; c.fillRect(x, 0, 8, 200); }
  // WebGL canvas: same stripes via scissor clears (preserveDrawingBuffer default false)
  const g = document.getElementById('gl').getContext('webgl');
  g.enable(g.SCISSOR_TEST);
  for (let x = 0; x < 200; x += 16) {
    g.scissor(x, 0, 8, 200); g.clearColor(0, 0, 0, 1); g.clear(g.COLOR_BUFFER_BIT);
    g.scissor(x + 8, 0, 8, 200); g.clearColor(1, 1, 1, 1); g.clear(g.COLOR_BUFFER_BIT);
  }
</script></body>`;

const browser = await puppeteer.launch({ headless: true });
let page;
async function fresh(){ if (page) await page.close(); page = await browser.newPage(); await page.setViewport({ width: 400, height: 200 }); }

let n = 0;
async function measure(html, label) {
  await fresh();
  await page.setContent(html, { waitUntil: 'load' });
  await new Promise(r => setTimeout(r, 200));
  const shot = await page.screenshot({ clip: { x: 0, y: 0, width: 400, height: 200 }, encoding: 'binary' });
  fs.writeFileSync(new URL('./shot-' + (n++) + '.png', import.meta.url), shot);
  // decode via canvas in page for pixel access
  const stats = await page.evaluate(async (b64) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const cv = document.createElement('canvas'); cv.width = 400; cv.height = 200;
    const ctx = cv.getContext('2d'); ctx.drawImage(img, 0, 0);
    const row = (y, x0, x1) => { const d = ctx.getImageData(x0, y, x1 - x0, 1).data; let mn = 255, mx = 0; for (let i = 0; i < d.length; i += 4) { mn = Math.min(mn, d[i]); mx = Math.max(mx, d[i]); } return { mn, mx }; };
    return { under2d: row(100, 60, 190), underGl: row(100, 210, 340), outside2d: row(20, 0, 200), outsideGl: row(20, 200, 400) };
  }, Buffer.from(shot).toString('base64'));
  const blurred = (r) => r.mx - r.mn < 120; // stripes gone => blurred
  console.log(`${label.padEnd(40)} under glass: 2D ${blurred(stats.under2d) ? 'BLURRED' : 'sharp'} (${stats.under2d.mn}-${stats.under2d.mx}), WebGL ${blurred(stats.underGl) ? 'BLURRED' : 'sharp'} (${stats.underGl.mn}-${stats.underGl.mx}); outside: 2D ${stats.outside2d.mn}-${stats.outside2d.mx}, WebGL ${stats.outsideGl.mn}-${stats.outsideGl.mx}`);
}
await measure(stage(false), 'sibling canvas, no isolation');
await measure(stage(true), 'sibling canvas, wrapper isolation:isolate');

// (c) glass inside a same-origin iframe over parent-document stripes
const parent = `<!doctype html><body style="margin:0;background:#fff">
<div style="position:relative;width:400px;height:200px">
  <canvas id=c width=400 height=200 style="position:absolute;left:0;top:0"></canvas>
  <iframe id=f style="position:absolute;left:0;top:0;width:400px;height:200px;border:0;background:transparent" allowtransparency></iframe>
</div>
<script>
  const c = document.getElementById('c').getContext('2d');
  for (let x = 0; x < 400; x += 16) { c.fillStyle = '#000'; c.fillRect(x, 0, 8, 200); }
  const f = document.getElementById('f');
  f.srcdoc = '<body style="margin:0;background:transparent"><div style="position:absolute;left:50px;top:50px;width:300px;height:100px;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);background:rgba(255,255,255,0.05)"></div></body>';
</script></body>`;
await fresh();
await page.setContent(parent, { waitUntil: 'load' });
await new Promise(r => setTimeout(r, 400));
const shot = await page.screenshot({ clip: { x: 0, y: 0, width: 400, height: 200 }, encoding: 'binary' });
fs.writeFileSync(new URL('./shot-iframe.png', import.meta.url), shot);
const s = await page.evaluate(async (b64) => {
  const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
  const cv = document.createElement('canvas'); cv.width = 400; cv.height = 200; const ctx = cv.getContext('2d'); ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(60, 100, 280, 1).data; let mn = 255, mx = 0; for (let i = 0; i < d.length; i += 4) { mn = Math.min(mn, d[i]); mx = Math.max(mx, d[i]); } return { mn, mx };
}, Buffer.from(shot).toString('base64'));
console.log(`${'glass in iframe over parent canvas'.padEnd(40)} under glass: ${s.mx - s.mn < 120 ? 'BLURRED' : 'sharp'} (${s.mn}-${s.mx})`);
await browser.close();
