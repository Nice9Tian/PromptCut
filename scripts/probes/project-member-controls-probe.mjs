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
import { startCloudQueueUserFixture } from '../../server/test/fixtures/cloud-queue-user-path.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const value = flag => { const at = process.argv.indexOf(flag); return at < 0 ? null : process.argv[at + 1]; };
const DIST = path.resolve(value('--dist') ?? path.join(ROOT, 'dist-online'));
const SITE = value('--site-root');
const OUT = path.resolve(value('--out') ?? path.join(os.tmpdir(), 'pc-project-member-controls'));
const relative = path.relative(os.tmpdir(), OUT);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !SITE) throw Error('private-output-and-site-required');
const ORIGIN = 'https://127.0.0.1:6568', STAGES = ['http://s1.pc.localhost:6570', 'http://s2.pc.localhost:6571'];
const TIMEOUT = 30_000, stages = [], contexts = [], pages = [];
const result = { sourceBefore: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, windowsHide: true, encoding: 'utf8' }).trim(),
  checks: [], network: [], screenshots: [], completed: false, executorMounted: false, cleanup: {} };
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
  await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control'); await page.keyboard.press('Backspace'); await page.type(selector, text);
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
  const until = Date.now() + TIMEOUT;
  while (Date.now() < until) {
    const dialog = await page.$('[data-pc="cloud-agent-consent"]');
    if (dialog) {
      const buttons = await page.$$('[data-pc="cloud-agent-consent"] button'); await buttons[1].click();
      await page.waitForSelector('[data-pc="cloud-agent-consent"]', { hidden: true }); return;
    }
    if (page.consentAccepted === true) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw Error('consent-not-ready');
};const projectName = 'Account member controls browser project';
const openMembers = async page => {
  await page.waitForSelector('[data-pc="members-button"]', { visible: true });
  if (!await page.$('[data-pc="members-pop"]')) await page.click('[data-pc="members-button"]');
  await page.waitForSelector('[data-pc="account-member"]', { visible: true });
};
const project = page => page.createdProjectId;
const reopen = async (page, id) => {
  await page.waitForSelector('[data-pc="account-name"]', { visible: true });
  check(!await page.$('input[type="password"]'), 'home-preserves-account-login');
  await page.waitForFunction(name => [...document.querySelectorAll('[data-pc="cloud-project-lists"] .sp-account-row')]
    .some(row => row.querySelector('button')?.textContent === name && !row.querySelector('button').disabled), { timeout: TIMEOUT }, projectName);
  const row = await page.evaluateHandle(name => [...document.querySelectorAll('[data-pc="cloud-project-lists"] .sp-account-row')]
    .find(row => row.querySelector('button')?.textContent === name), projectName);
  try {
    const buttons = await row.asElement().$$('button'); await buttons[1].click();
    const linked = await page.$eval('[data-pc="cloud-project-link"]', input => new URL(input.value).searchParams.get('project'));
    check(linked === id, 'joined-list-same-project-after-home'); await buttons[0].click();
  } finally { await row.dispose(); }
  await page.waitForSelector('[data-pc="cloud-project-copy"]', { visible: true });
};
const join = async (page, id) => {
  await enabled(page, '[data-pc="cloud-join"]');
  await fill(page, '[data-pc="cloud-project-link"]', `${ORIGIN}/editor?project=${encodeURIComponent(id)}`);
  await page.click('[data-pc="cloud-join"]');
  await page.waitForSelector('[data-pc="cloud-project-copy"]', { visible: true });
  await consent(page);
};
const started = Date.now();
try {
  await fs.mkdir(OUT, { recursive: true }); await fs.access(path.join(DIST, 'index.html'));
  fixture = await startCloudQueueUserFixture({ ports: [6560, 6561, 6562, 6563, 6564, 6565, 6568], agentPort: 6567, publicHandler: serve(false) });
  for (const port of [6570, 6571]) {
    const sockets = new Set(), server = http.createServer((req, res) => { void serve(true)(req, res); });
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    stages.push({ server, sockets, port }); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  }
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH ?? await puppeteer.executablePath(); await fs.access(executablePath);
  browser = await puppeteer.launch({ executablePath, headless: true, pipe: true, userDataDir: path.join(OUT, 'chrome'),
    args: [...PROBE_CHROME_ARGS, '--ignore-certificate-errors', '--host-resolver-rules=MAP s1.pc.localhost 127.0.0.1,MAP s2.pc.localhost 127.0.0.1'] });
  for (let i = 0; i < 3; i++) {
    const context = await browser.createBrowserContext(); contexts.push(context); const page = await context.newPage(); pages.push(page);
    page.setDefaultTimeout(TIMEOUT);
    const cdp = await page.createCDPSession(), wsIds = new Set();
    page.docSockets = { opened: 0, closed: 0 };
    await cdp.send('Network.enable');
    cdp.on('Network.webSocketCreated', event => {
      if (new URL(event.url).pathname !== '/hosted/ws') return;
      wsIds.add(event.requestId); page.docSockets.opened++;
    });
    cdp.on('Network.webSocketClosed', event => { if (wsIds.delete(event.requestId)) page.docSockets.closed++; });
    page.on('response', response => {
      const pathname = new URL(response.url()).pathname;
      if (pathname === '/api/account/cloud-agent-consent' && response.status() === 200) {
        void response.json().then(body => { page.consentAccepted = body.accepted === true; }).catch(() => {}); return;
      }
      if (!pathname.startsWith('/hosted/shared/account/')) return;
      result.network.push({ path: pathname, status: response.status(), method: response.request().method() });
      if (pathname.endsWith('/create') && response.status() === 201) void response.json().then(body => {
        if (/^sp_[a-z2-7]{26}$/.test(body.projectId)) page.createdProjectId = body.projectId;
      }).catch(() => {});
      if (pathname.endsWith('/members') && response.status() === 200) void response.json().then(body => {
        if (/^acc_[a-f0-9]{24}$/.test(body.self?.accountId)) page.accountId = body.self.accountId;
      }).catch(() => {});
    });
    await login(page, fixture.accounts[i === 0 ? 0 : 1]);
  }
  const [a, b, b2] = pages;
  phase = 'create'; await enabled(a, '[data-pc="cloud-create"]'); await fill(a, '[data-pc="cloud-project-name"]', projectName); await a.click('[data-pc="cloud-create"]');
  await a.waitForSelector('[data-pc="cloud-project-copy"]', { visible: true }); await consent(a);
  const id = project(a); check(/^sp_[a-z2-7]{26}$/.test(id ?? ''), 'real-project-created'); result.projectId = id;
  phase = 'join-two-devices'; await join(b, id); await join(b2, id);
  await openMembers(b);
  await b.waitForFunction(() => [...document.querySelectorAll('[data-pc="account-member"]')].length === 2, { timeout: TIMEOUT });
  check(!await b.$('[data-pc="account-member-kick"]'), 'ordinary-member-has-no-admin-controls');
  await openMembers(a);
  await a.waitForFunction(() => [...document.querySelectorAll('[data-pc="account-member"]')].filter(row => row.querySelector('[data-pc="account-member-kick"]'))
    .some(row => row.querySelectorAll('.pc-members-sub').length === 2), { timeout: TIMEOUT });
  const targetId = await a.$eval('[data-pc="account-member-kick"]', button => button.closest('[data-account-id]').dataset.accountId);
  check(/^acc_[a-f0-9]{24}$/.test(targetId), 'real-target-account-id');
  check(await b.$eval('[data-pc="account-member"] .pc-members-name', node => node.textContent !== ''), 'trusted-member-name-visible');
  await shot(a, '01-creator-two-devices'); await shot(b, '02-member-readonly-controls');
  phase = 'kick'; await a.click('[data-pc="account-member-kick"]'); await enabled(a, '[data-pc="account-member-submit"]'); await a.click('[data-pc="account-member-submit"]');
  await a.waitForSelector('[data-pc="account-member-confirm"]', { hidden: true });
  for (const page of [b, b2]) {
    await page.waitForFunction(() => [...document.querySelectorAll('.pc-toast')].some(node => /登录已失效|访问.*权限|禁止加入|连接/.test(node.textContent)), { timeout: TIMEOUT });
    const until = Date.now() + TIMEOUT;
    while (page.docSockets.closed === 0 && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 40));
    check(page.docSockets.closed >= 1, 'affected-page-actual-websocket-closed');
    // Real reload goes through current session/join. No public principal or old ticket is injected.
    await page.goto(`${ORIGIN}/editor/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-pc="account-name"]', { visible: true });
    await enabled(page, '[data-pc="cloud-join"]'); await fill(page, '[data-pc="cloud-project-link"]', `${ORIGIN}/editor?project=${encodeURIComponent(id)}`);
    await page.click('[data-pc="cloud-join"]');
    await page.waitForFunction(() => [...document.querySelectorAll('[role="alert"],.sp-account-error')].some(node => node.textContent.includes('禁止加入')), { timeout: TIMEOUT });
  }
  check(result.network.filter(row => row.path.endsWith('/join') && row.status === 403).length === 2, 'both-devices-current-join-rejected');
  phase = 'bans'; await openMembers(a); await a.click('[data-pc="account-bans-open"]');
  await a.waitForSelector(`[data-pc="account-ban"][data-account-id="${targetId}"]`, { visible: true }); await shot(a, '03-creator-ban-account');
  phase = 'unban'; await a.click('[data-pc="account-member-unban"]'); await enabled(a, '[data-pc="account-member-submit"]'); await a.click('[data-pc="account-member-submit"]');
  await a.waitForSelector('[data-pc="account-member-confirm"]', { hidden: true });
  phase = 'rejoin'; await join(b, id);
  await openMembers(b); const closesBeforeHome = b.docSockets.closed; await b.click('[data-pc="account-project-home"]');
  phase = 'home'; await reopen(b, id);
  check(b.docSockets.closed > closesBeforeHome, 'project-home-actually-closes-current-page-socket');
  check(result.network.filter(row => row.path.endsWith('/admin') && row.status === 200).length === 2, 'real-kick-and-unban-admin-requests');
  check(result.network.filter(row => row.path.endsWith('/create') && row.status === 201).length === 1, 'home-reopens-no-duplicate-create');
  await shot(b, '04-rejoined-after-project-home');
  result.completed = true;
} catch (error) {
  result.failure = { phase, code: error?.name === 'TimeoutError' ? 'timeout' : 'probe-check-failed' };
  for (let i = 0; i < pages.length; i++) await shot(pages[i], `failure-${i}`).catch(() => {});
  process.exitCode = 1;
} finally {
  for (const context of contexts) await context.close().catch(() => {}); await browser?.close();
  for (const stage of stages) { for (const socket of stage.sockets) socket.destroy(); await new Promise(resolve => stage.server.close(resolve)); }
  result.cleanup = await fixture?.close() ?? { fixtureStarted: false };
  result.wallMs = Date.now() - started;
  result.sourceAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, windowsHide: true, encoding: 'utf8' }).trim();
  await fs.writeFile(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ completed: result.completed, phase, checks: result.checks.length, wallMs: result.wallMs, closed: result.cleanup.closed === true, output: OUT }));
}
