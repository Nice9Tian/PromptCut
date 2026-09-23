// R9 M3 探针：两条 Worker 路线下每拍裁 20 张 ImageBitmap，以及整张图集一次传回的退路。
// 用法：node scripts/probes/gl-atlas-probe.mjs [--beats 30] [--parent-port 5240] [--child-port 5241]
// 起两个真实的 HTTP 源（父页、跨源子页）；只有 shared 路线由父页持有 Worker。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { flagArg, openBrowser, serve, closeAll, listTargets } from './probe-connect.mjs';

const parentPort = Number(flagArg('parent-port', '5240'));
const childPort = Number(flagArg('child-port', '5241'));
const beats = Number(flagArg('beats', '30'));
if (![parentPort, childPort].every(port => Number.isInteger(port) && port >= 5240 && port <= 5249)
  || parentPort === childPort) throw new Error('both distinct ports must be in 5240–5249');
if (!Number.isInteger(beats) || beats < 10 || beats > 200) throw new Error('--beats must be 10–200');

const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'gl-atlas-harness.html'));
const handler = (req, res) => {
  if (new URL(req.url, 'http://localhost').pathname !== '/gl-atlas-harness.html') {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store', 'Origin-Agent-Cluster': '?1' });
  res.end(html);
};
const servers = [];
let browserHandle;
let chromeProcess;
const results = [];
try {
  servers.push(await serve(parentPort, handler));
  servers.push(await serve(childPort, handler));
  browserHandle = await openBrowser({ launch: { headless: true,
    args: ['--window-size=1800,1000'] } });
  const { browser } = browserHandle;
  chromeProcess = browser.process();
  const version = await browser.version();
  const parentOrigin = `http://localhost:${parentPort}`;
  const childOrigin = `http://127.0.0.1:${childPort}`;
  console.log(`Chrome ${version}; PID=${chromeProcess?.pid ?? 'unknown'}; parent=${parentOrigin}; child=${childOrigin}; beats=${beats}`);
  for (const route of ['perDocument', 'shared']) {
    const page = await browser.newPage();
    try {
      page.setDefaultTimeout(120000);
      await page.goto(`${parentOrigin}/gl-atlas-harness.html?route=${route}&beats=${beats}&childOrigin=${encodeURIComponent(childOrigin)}`,
        { waitUntil: 'load' });
      const result = await page.evaluate(() => window.__probeDone);
      const targets = await listTargets(browser);
      result.oopifTarget = targets.some(target => target.type === 'iframe' && target.url?.startsWith(childOrigin));
      result.pass = result.pass && result.crossOrigin && result.childOrigin === childOrigin
        && result.workerOwner === (route === 'shared' ? 'parent' : 'child')
        && result.samples >= 1 && result.samples <= 4
        && result.methods?.crops?.pixelChecks === 20
        && result.methods?.fallback?.pixelChecks === 20;
      results.push(result);
      for (const [method, row] of Object.entries(result.methods || {})) {
        console.log(`${route} ${method}: ${result.pass ? 'PASS' : 'FAIL'}; main p50/p90/max=${row.main.p50}/${row.main.p90}/${row.main.max} ms; beat→present p50/p90/max=${row.roundTrip.p50}/${row.roundTrip.p90}/${row.roundTrip.max} ms`);
      }
      if (!result.pass) console.log(`${route}: FAIL ${result.error || 'protocol or pixel check failed'}`);
    } catch (error) {
      results.push({ route, pass: false, error: String(error.stack || error) });
      console.log(`${route}: FAIL ${error.message || error}`);
    } finally {
      await page.close().catch(() => {});
    }
  }
  console.log('RAW_JSON_BEGIN');
  console.log(JSON.stringify({ probe: 'gl-atlas', when: new Date().toISOString(),
    browser: version, beats, results }, null, 2));
  console.log('RAW_JSON_END');
  if (results.some(row => !row.pass)) process.exitCode = 1;
} finally {
  await browserHandle?.close().catch(() => {});
  // Windows 上只结束本探针自己起的那个 Chrome。
  if (process.platform === 'win32' && chromeProcess?.pid && chromeProcess.exitCode === null)
    spawnSync('taskkill', ['/F', '/T', '/PID', String(chromeProcess.pid)], { stdio: 'ignore' });
  await closeAll(servers);
}
