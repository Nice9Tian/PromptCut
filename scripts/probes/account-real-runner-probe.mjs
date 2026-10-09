import '../lib/no-user-dirs.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { editorSecurityHeaders, stageSecurityHeaders } from '../../src/online/stagePolicy.mjs';
import { startAccountRealRunnerFixture, REAL_RUNNER_PROMPT, REAL_RUNNER_TEXT, REAL_RUNNER_NAME } from '../../server/test/fixtures/account-real-runner.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const value = flag => { const at = process.argv.indexOf(flag); return at < 0 ? null : process.argv[at + 1]; };
const DIST = path.resolve(value('--dist') ?? path.join(ROOT, 'dist-online'));
const SITE = value('--site-root');
const OUT = path.resolve(value('--out') ?? path.join(os.tmpdir(), 'pc-account-real-runner-browser'));
const relative = path.relative(os.tmpdir(), OUT);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !SITE) throw Error('private-output-and-site-required');
const ORIGIN = 'https://127.0.0.1:6708', STAGES = ['http://s1.pc.localhost:6710', 'http://s2.pc.localhost:6711'];
const TIMEOUT = 30_000, stages = [], contexts = [], pages = [];
const result = { sourceBefore: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, windowsHide: true, encoding: 'utf8' }).trim(),
  checks: [], network: [], screenshots: [], completed: false, executorMounted: true, productionModel: false, completionReady: false, cleanup: {} };
let browser, fixture, phase = 'preflight';
const check = (condition, name) => { result.checks.push({ name, pass: Boolean(condition) }); if (!condition) throw Error(name); };
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.wasm': 'application/wasm' };
const serve = stage => async (req, res) => {
  const url = new URL(req.url, ORIGIN), headers = stage ? stageSecurityHeaders(ORIGIN) : editorSecurityHeaders(STAGES);
  if (url.pathname === '/editor/runtime-config.json') { res.writeHead(200, { ...headers, 'content-type': 'application/json' }); res.end(JSON.stringify({ v: 1, stageOrigins: STAGES })); return; }
  if (url.pathname === '/editor/_iso/ok') { res.writeHead(204, headers); res.end(); return; }
  if (url.pathname === '/editor/_iso/redirect') { res.writeHead(302, { ...headers, location: '/editor/_iso/ok' }); res.end(); return; }
  const editor = url.pathname.startsWith('/editor'), root = editor || stage || url.pathname.startsWith('/catalog/') ? DIST : path.resolve(SITE);
  const name = editor ? (url.pathname.replace(/^\/editor\/?/, '') || 'index.html') : url.pathname.slice(1) || 'index.html';
  const file = path.resolve(root, name), rel = path.relative(root, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) { res.writeHead(404); res.end(); return; }
  try { const bytes = await fs.readFile(file); res.writeHead(200, { ...headers, 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' }); res.end(req.method === 'HEAD' ? undefined : bytes); }
  catch { res.writeHead(404); res.end(); }
};
const fill = async (page, selector, text) => {
  await page.waitForSelector(selector, { visible: true }); await page.focus(selector);
  await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control'); await page.keyboard.press('Backspace'); if (text.includes('\n')) await page.keyboard.insertText(text); else await page.type(selector, text);
};
const enabled = async (page, selector) => page.waitForFunction(selector => { const el = document.querySelector(selector); return el && !el.disabled; }, { timeout: TIMEOUT }, selector);
const shot = async (page, name) => {
  if (await page.$('input[type="password"]')) return; // Never capture an entered credential.
  const file = path.join(OUT, `${name}.png`); await page.screenshot({ path: file, fullPage: true }); result.screenshots.push({ name, file });
};
const login = async (page, account) => {
  await page.goto(`${ORIGIN}/editor/`, { waitUntil: 'domcontentloaded' });
  await fill(page, 'input[name="username"]', account.name); await fill(page, 'input[name="password"]', account.password);
  const submit = '[data-pc="account-projects"] form button.sp-primary-btn'; await enabled(page, submit); await page.click(submit);
  await page.waitForSelector('[data-pc="account-name"]', { visible: true });
};
const consent = async page => {
  await page.waitForSelector('[data-pc="cloud-agent-consent"]', { visible: true });
  const buttons = await page.$$('[data-pc="cloud-agent-consent"] button'); await buttons[1].click();
  await page.waitForSelector('[data-pc="cloud-agent-consent"]', { hidden: true });
};
const queue = async (page, count) => {
  await page.waitForFunction(count => document.querySelectorAll('[data-pc="cloud-queue"] li[data-message-id]').length === count, { timeout: TIMEOUT }, count);
  return page.$$eval('[data-pc="cloud-queue"] li[data-message-id]', rows => rows.map(row => ({ messageId: row.dataset.messageId, position: Number(row.dataset.queuePosition) })));
};
const chooseHistory = async (page, conversationId) => {
  const history = await page.$('[data-pc="cloud-ai-panel"] button[title*="历史"]');
  check(Boolean(history), 'history-button-visible'); await history.click();
  const row = `[data-pc="chat-cloud-item"][data-chat-id="${conversationId}"]`;
  await page.waitForSelector(row, { visible: true }); await page.click(row);
  await page.waitForFunction(id => window.__pcCloud?.main?.conversationId?.() === id, { timeout: TIMEOUT }, conversationId);
};
const started = Date.now();
try {
  await fs.mkdir(OUT, { recursive: true }); await fs.access(path.join(DIST, 'index.html'));
  fixture = await startAccountRealRunnerFixture({ publicHandler: serve(false) });
  for (const port of [6710, 6711]) {
    const sockets = new Set(), server = http.createServer((req, res) => { void serve(true)(req, res); });
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    stages.push({ server, sockets, port }); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  }
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH ?? await puppeteer.executablePath(); await fs.access(executablePath);
  browser = await puppeteer.launch({ executablePath, headless: true, pipe: true, userDataDir: path.join(OUT, 'chrome'),
    args: [...PROBE_CHROME_ARGS, '--ignore-certificate-errors', '--host-resolver-rules=MAP s1.pc.localhost 127.0.0.1,MAP s2.pc.localhost 127.0.0.1'] });
  for (let i = 0; i < 2; i++) {
    const context = await browser.createBrowserContext(); contexts.push(context); const page = await context.newPage(); pages.push(page);
    page.setDefaultTimeout(TIMEOUT); page.on('response', response => {
      const url = new URL(response.url()); if (url.pathname.startsWith('/agent/') || url.pathname.startsWith('/hosted/shared/account/'))
        result.network.push({ path: url.pathname, status: response.status(), method: response.request().method() });
      if (url.pathname === '/hosted/shared/account/create' && response.status() === 201)
        void response.json().then(body => { if (/^sp_[a-z0-9]{26}$/.test(body.projectId)) page.createdProjectId = body.projectId; }).catch(() => {});
    });
    await login(page, fixture.accounts[i]);
  }
  const [a, b] = pages;
  phase = 'create'; await enabled(a, '[data-pc="cloud-create"]'); await fill(a, '[data-pc="cloud-project-name"]', 'Actual runner browser project'); await a.click('[data-pc="cloud-create"]');
  await a.waitForSelector('[data-pc="cloud-project-copy"]', { visible: true }); await consent(a);
  const id = a.createdProjectId;
  check(typeof id === 'string' && /^sp_/.test(id), 'authoritative-created-project'); result.projectId = id;
  phase = 'enable'; await enabled(a, '[data-pc="cloud-agent-enable"]'); await a.click('[data-pc="cloud-agent-enable"]');
  await a.waitForSelector('[data-pc="cloud-off"]', { hidden: true });
  phase = 'join'; await enabled(b, '[data-pc="cloud-join"]'); await fill(b, '[data-pc="cloud-project-link"]', `${ORIGIN}/editor?project=${encodeURIComponent(id)}`); await b.click('[data-pc="cloud-join"]');
  await b.waitForSelector('[data-pc="cloud-project-copy"]', { visible: true }); await consent(b);
  check(!await b.$('[data-pc="cloud-agent-enable"]'), 'member-cannot-enable-creator-switch');
  phase = 'actual-send';
  await fill(a, '[data-pc="cloud-ai-panel"] [data-pc="ai-input"]', REAL_RUNNER_PROMPT); await a.keyboard.press('Enter');
  await a.waitForFunction(() => Boolean(window.__pcCloud?.main?.conversationId?.()));
  const conversationId = await a.evaluate(() => window.__pcCloud.main.conversationId()); result.conversationId = conversationId;
  phase = 'actual-output-a';
  await a.waitForFunction(text => document.querySelector('.ai-messages')?.textContent?.includes(text) &&
    document.querySelector('.ai-messages')?.textContent?.includes('等待云端确认关闭与结算'), { timeout: TIMEOUT }, REAL_RUNNER_TEXT);
  phase = 'shared-history-b'; await chooseHistory(b, conversationId);
  await b.waitForFunction(text => document.querySelector('.ai-messages')?.textContent?.includes(text), { timeout: TIMEOUT }, REAL_RUNNER_TEXT);
  for (const [i, page] of [a,b].entries()) {
    const visible = await page.evaluate(({text,name}) => ({
      text: document.querySelector('.ai-messages')?.textContent?.includes(text),
      pending: document.querySelector('.ai-messages')?.textContent?.includes('等待云端确认关闭与结算'),
      userCount: document.querySelectorAll('[data-pc-msg^="cq-"]').length,
      assistantCount: document.querySelectorAll('[data-pc-msg^="ca-"]').length,
      projectName: window.__pcStore?.getState()?.project?.name === name,
      toolCount: document.querySelectorAll('.ai-messages [data-pc-tool]').length,
    }), {text:REAL_RUNNER_TEXT,name:REAL_RUNNER_NAME});
    result['page'+i] = visible;
    check(visible.text && visible.pending && visible.userCount===1 && visible.assistantCount===1, 'full-editor-bound-output-'+i);
    check(visible.projectName, 'real-project-projection-'+i);
    await shot(page, '0'+i+'-actual-editor');
  }
  const rows = fixture.rows(id,conversationId);
  const tools = rows.filter(row=>row.event.type==='tool_result');
  check(tools.length===4 && tools.every(row=>row.event.ok===true), 'four-real-tools-succeeded');
  check(tools.map(row=>row.event.name).join(',')==='get_project,get_selection,report_progress,set_project_meta','exact-tools');
  const run = rows.find(row=>row.event.type==='run');
  const gate = await fixture.checkRun(run);
  check(gate.allowed===true && gate.runGrant.state==='active','fifo-remains-pending');
  check(fixture.describe().dataConnections===0 && fixture.describe().completionReady===false,'actual-data-closed-no-final-proof');
  result.eventSeq=rows.map(row=>row.eventSeq);
  check(result.network.filter(row=>row.path.endsWith('/messages') && row.status===202).length===1,'actual-send-202-once');
  check(result.network.some(row=>row.path.endsWith('/events') && row.status===200),'actual-sse-200');
  result.completed = true;
} catch (error) {
  result.failure = { phase, code: error?.name === 'TimeoutError' ? 'timeout' : 'probe-check-failed', failedCheck: result.checks.find(row=>!row.pass)?.name };
  for (let i = 0; i < pages.length; i++) await shot(pages[i], `failure-${i}`).catch(() => {});
  process.exitCode = 1;
} finally {
  const cleanup = await Promise.allSettled(contexts.map(context=>context.close()));
  const browserClose = await Promise.allSettled([browser?.close()]);
  const stageClose = await Promise.allSettled(stages.map(async stage=>{ for(const socket of stage.sockets) socket.destroy(); if(stage.server.listening) await new Promise(resolve=>stage.server.close(resolve)); }));
  try { result.cleanup = await fixture?.close() ?? { fixtureStarted:false }; }
  catch(error){ result.cleanup={closed:false,errorName:error.name}; }
  result.cleanup.browserClosed=browserClose.every(row=>row.status==='fulfilled');
  result.cleanup.stagesClosed=stageClose.every(row=>row.status==='fulfilled');
  result.cleanup.contextsClosed=cleanup.every(row=>row.status==='fulfilled');
  if(!result.cleanup.closed || !result.cleanup.browserClosed || !result.cleanup.stagesClosed || !result.cleanup.contextsClosed) {result.completed=false;process.exitCode=1;}
  result.wallMs = Date.now() - started;
  result.sourceAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, windowsHide: true, encoding: 'utf8' }).trim();
  await fs.writeFile(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ completed: result.completed, phase, checks: result.checks.length, wallMs: result.wallMs, closed: result.cleanup.closed === true, output: OUT }));
}
