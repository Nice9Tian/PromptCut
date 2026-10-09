import '../lib/no-user-dirs.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { startAccountExecutorVisibleFixture } from '../../server/test/fixtures/account-executor-visible.mjs';

// Scoped visible-layer probe: actual service SSE -> product CloudApi/Session ->
// React MessageList. Controlled sender/registry/selection/model/tool driver.
// Not the complete editor, VH, actual model, data WS or OS-resource proof.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argIndex = process.argv.indexOf('--out');
const OUT = path.resolve(argIndex >= 0 ? process.argv[argIndex + 1] : path.join(os.tmpdir(), 'pc-executor-visible-' + randomUUID()));
const rel = path.relative(os.tmpdir(), OUT);
if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw Error('private-tmp-output-required');
const result = { source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, windowsHide: true, encoding: 'utf8' }).trim(),
  layer: 'actual-service-sse-react-visible-controlled-driver', completed: false, checks: [], cleanup: {} };
const check = (name, ok) => { result.checks.push({ name, ok: !!ok }); if (!ok) throw Error(name); };
let fixture, vite, browser, page, phase = 'preflight';
const agentResponses = [];
const started = Date.now();
await fs.mkdir(OUT, { recursive: true });
const listening = port => new Promise(resolve => {
  const socket = net.connect({ host: '127.0.0.1', port });
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
});
try {
  check('exclusive-four-ports-empty', !(await Promise.all([6640, 6641, 6642, 6643].map(listening))).some(Boolean));
  fixture = await startAccountExecutorVisibleFixture();
  phase = 'private-vite-start';
  vite = await createServer({ configFile: false, root: ROOT, cacheDir: path.join(OUT, 'vite-cache'),
    optimizeDeps: { entries: ['scripts/probes/fixtures/account-executor-visible/index.html'] }, plugins: [react(), {
    name: 'private-visible-config', configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== '/fixture-config') return next();
        res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify({ origin: fixture.origin, projectId: fixture.projectId,
          conversationId: fixture.conversationId, ticket: fixture.ticket }));
      });
    },
  }], server: { host: '127.0.0.1', port: 6643, strictPort: true, hmr: false,
    fs: { allow: [ROOT, path.resolve(ROOT, '../..')] } } });
  await vite.listen();
  phase = 'chrome-start';
  const chrome = process.env.PUPPETEER_EXECUTABLE_PATH ?? await puppeteer.executablePath();
  await fs.access(chrome);
  browser = await puppeteer.launch({ executablePath: chrome, headless: true, pipe: true,
    userDataDir: path.join(OUT, 'chrome-profile'), args: [...PROBE_CHROME_ARGS, '--window-size=1200,1000'] });
  result.chromePid = browser.process().pid;
  page = await browser.newPage(); await page.setViewport({ width: 1200, height: 1000 });
  page.on('pageerror', error => { result.pageErrorName = error.name; });
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.origin === fixture.origin && url.pathname.startsWith('/v1/conversations/'))
      agentResponses.push({ pathname: url.pathname.endsWith('/events') ? 'events' : url.pathname.endsWith('/messages') ? 'messages' : 'other', status: response.status() });
  });
  phase = 'react-page-load';
  await page.goto('http://127.0.0.1:6643/scripts/probes/fixtures/account-executor-visible/index.html', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('[data-pc="visible-send"]', { timeout: 20000 });
  phase = 'real-submit-and-pending-output';
  await page.click('[data-pc="visible-send"]');
  await page.waitForFunction(() => document.querySelector('.ai-messages')?.textContent?.includes('等待云端确认关闭与结算'), { timeout: 15000 });
  const snapshot = () => page.evaluate(() => ({
    userCount: document.querySelectorAll('[data-pc-msg^="cq-"]').length,
    assistantCount: document.querySelectorAll('[data-pc-msg^="ca-"]').length,
    textVisible: document.querySelector('.ai-messages')?.textContent?.includes('Controlled result'),
    senderVisible: document.querySelector('.ai-messages')?.textContent?.includes('Controlled actor'),
    toolVisible: document.querySelector('.ai-messages')?.textContent?.includes('get_project') ||
      document.querySelector('.ai-messages')?.textContent?.includes('Controlled project read'),
    pending: document.querySelector('[data-pc="visible-state"]')?.getAttribute('data-live') === 'true',
    cursor: Number(document.querySelector('[data-pc="visible-state"]')?.getAttribute('data-cursor')),
    error: document.querySelector('[data-pc="visible-state"]')?.getAttribute('data-error') === 'true',
  }));
  result.first = await snapshot();
  check('actual-post-202-and-sse-200', agentResponses.some(r => r.pathname === 'messages' && r.status === 202) && agentResponses.some(r => r.pathname === 'events' && r.status === 200));
  check('one-accepted-user-and-bound-assistant', result.first.userCount === 1 && result.first.assistantCount === 1);
  check('actual-durable-text-sender-and-tool-visible', result.first.textVisible && result.first.senderVisible && result.first.toolVisible);
  check('terminal-remains-pending-not-success', result.first.pending && !result.first.error);
  await page.screenshot({ path: path.join(OUT, 'visible-first.png'), fullPage: true });
  phase = 'durable-reopen';
  await page.click('[data-pc="visible-replay"]');
  await page.waitForFunction(cursor => Number(document.querySelector('[data-pc="visible-state"]')?.getAttribute('data-cursor')) >= cursor &&
    document.querySelector('.ai-messages')?.textContent?.includes('等待云端确认关闭与结算'), { timeout: 15000 }, result.first.cursor);
  result.replay = await snapshot();
  check('reopen-from-durable-cursor-no-duplicate', result.replay.userCount === 1 && result.replay.assistantCount === 1 && result.replay.textVisible && result.replay.pending);
  await page.screenshot({ path: path.join(OUT, 'visible-replay.png'), fullPage: true });
  phase = 'owned-driver-drain';
  const deadline = Date.now() + 5000;
  while (fixture.describe().activeRuns !== 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  const state = fixture.describe();
  check('controlled-model-tool-once-and-doc-fifo-retained', state.models === 1 && state.tools === 1 && state.grants.length === 1 && state.grants[0].state === 'active' && state.completionReady === false);
  result.eventSeq = fixture.rows().events.map(row => row.eventSeq);
  result.completed = true;
} catch (error) {
  result.error = { name: error.name, phase };
  if (page) result.ui = await page.evaluate(() => ({
    submitDisabled: document.querySelector('[data-pc="visible-send"]')?.disabled === true,
    errorVisible: document.querySelector('[data-pc="visible-state"]')?.getAttribute('data-error') === 'true',
    messages: Number(document.querySelector('[data-pc="visible-state"]')?.getAttribute('data-count')),
    cursor: Number(document.querySelector('[data-pc="visible-state"]')?.getAttribute('data-cursor')),
  })).catch(() => ({ unavailable: true }));
  if (page) await page.screenshot({ path: path.join(OUT, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  const own = [['browser', () => browser?.close()], ['vite', () => vite?.close()]];
  const closed = await Promise.allSettled(own.map(async ([name, close]) => { await close(); return name; }));
  closed.forEach((row, i) => { result.cleanup[own[i][0]] = row.status === 'fulfilled'; });
  try { result.cleanup.fixture = fixture ? await fixture.close() : { notStarted: true }; }
  catch (error) { result.cleanup.fixture = { closed: false, errorName: error.name }; }
  result.cleanup.listening = (await Promise.all([6640, 6641, 6642, 6643].map(async port => (await listening(port)) ? port : null))).filter(Boolean);
  if (closed.some(row => row.status === 'rejected') || result.cleanup.fixture.closed === false || result.cleanup.listening.length) result.completed = false;
  result.sourceAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, windowsHide: true, encoding: 'utf8' }).trim();
  result.network = agentResponses;
  result.wallMs = Date.now() - started;
  await fs.writeFile(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ completed: result.completed, checks: result.checks.length,
    passed: result.checks.filter(row => row.ok).length, wallMs: result.wallMs, listening: result.cleanup.listening, output: OUT }));
  if (!result.completed) process.exitCode = 1;
}
