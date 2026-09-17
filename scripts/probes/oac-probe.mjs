// Probe: does Chrome put same-host different-port iframes in separate renderer
// processes, with and without `Origin-Agent-Cluster: ?1`? Compare with a
// different-host iframe. Two signals per config:
//   1. puppeteer frame.isOOPFrame()  -> out-of-process iframe or not
//   2. block one iframe's main thread for 2.5 s, measure the parent's worst rAF gap
import http from 'node:http';
import puppeteer from 'puppeteer';

const stagePage = (name) => `<!doctype html><title>${name}</title><body style="margin:0;background:#246">
<div id=t style="color:#fff;font:24px monospace;padding:8px">${name}</div>
<script>
  addEventListener('message', e => {
    if (e.data === 'measure') { const gaps=[]; let last=performance.now(); const t0=last; (function m(){ const now=performance.now(); gaps.push(now-last); last=now; if (now-t0>3000) parent.postMessage({ measured: Math.max(...gaps) }, '*'); else requestAnimationFrame(m); })(); }
    if (e.data === 'block') { const end = performance.now() + 2500; while (performance.now() < end) {} parent.postMessage('blocked-done', '*'); }
  });
  let n = 0; (function loop(){ document.getElementById('t').textContent = '${name} ' + (n++); requestAnimationFrame(loop); })();
</script></body>`;

const parentPage = (a, b) => `<!doctype html><title>parent</title><body style="margin:0">
<iframe id=a src="${a}" style="width:400px;height:120px;border:0"></iframe>
<iframe id=b src="${b}" style="width:400px;height:120px;border:0"></iframe>
<script>
  window.__probe = () => new Promise(resolve => {
    const gaps = []; let last = performance.now(); let done = false; let bWorst = null;
    addEventListener('message', e => { if (e.data === 'blocked-done') done = true; if (e.data && e.data.measured !== undefined) bWorst = e.data.measured; });
    (function loop(){ const now = performance.now(); gaps.push(now - last); last = now; if (done && bWorst !== null && gaps.length > 20) resolve({ parent: Math.max(...gaps), b: bWorst }); else requestAnimationFrame(loop); })();
    setTimeout(() => { document.getElementById('b').contentWindow.postMessage('measure', '*'); document.getElementById('a').contentWindow.postMessage('block', '*'); }, 200);
    setTimeout(() => resolve({ parent: -1, b: -1 }), 9000);
  });
</script></body>`;

function serve(port, handler) {
  return new Promise(res => { const s = http.createServer(handler); s.listen(port, '0.0.0.0', () => res(s)); });
}

async function run(label, { oac, hostA, hostB, hostP }) {
  const P = 5301, A = 5302, B = 5303;
  const stage = (name) => (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (oac) res.setHeader('Origin-Agent-Cluster', '?1');
    res.end(stagePage(name));
  };
  const urlA = `http://${hostA}:${A}/`, urlB = `http://${hostB}:${B}/`;
  const servers = await Promise.all([
    serve(P, (req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(parentPage(urlA, urlB)); }),
    serve(A, stage('A')), serve(B, stage('B')),
  ]);
  const browser = await puppeteer.launch({ headless: false, args: ['--window-size=900,400'] });
  try {
    const page = await browser.newPage();
    await page.goto(`http://${hostP}:${P}/`, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 500));
    const frames = page.frames().filter(f => f !== page.mainFrame());
    const cdp = await page.createCDPSession(); const { targetInfos } = await cdp.send('Target.getTargets'); const oopUrls = new Set(targetInfos.filter(t => t.type === 'iframe').map(t => t.url)); const oop = frames.map(f => `${new URL(f.url()).host}:${oopUrls.has(f.url()) ? 'OOP' : 'in-process'}`);
    const worst = await page.evaluate(() => window.__probe());
    // Origin-keyed agent cluster actually applied? window.originAgentCluster is the spec'd getter.
    const oacApplied = await Promise.all(frames.map(f => f.evaluate(() => window.originAgentCluster).catch(() => 'n/a')));
    console.log(`${label.padEnd(44)} frames=[${oop.join(', ')}] originAgentCluster=[${oacApplied.join(', ')}] while A blocks 2.5s -> parent worst rAF gap ${worst.parent < 0 ? 'timeout' : worst.parent.toFixed(0) + ' ms'}, B worst rAF gap ${worst.b < 0 ? 'timeout' : worst.b.toFixed(0) + ' ms'}`);
  } finally {
    await browser.close();
    await Promise.all(servers.map(s => new Promise(r => s.close(r))));
  }
}

console.log('Chrome:', (await puppeteer.launch({ headless: true }).then(async b => { const v = await b.version(); await b.close(); return v; })));
await run('same host, different ports, no header', { oac: false, hostP: 'localhost', hostA: 'localhost', hostB: 'localhost' });
await run('same host, different ports, OAC header', { oac: true, hostP: 'localhost', hostA: 'localhost', hostB: 'localhost' });
await run('different hosts (localhost / 127.0.0.1)', { oac: false, hostP: 'localhost', hostA: '127.0.0.1', hostB: '127.0.0.2' });
await run('different hosts + OAC header', { oac: true, hostP: 'localhost', hostA: '127.0.0.1', hostB: '127.0.0.2' });
