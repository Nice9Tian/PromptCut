/**
 * Puppeteer CLI for real account conversation controls. It launches its own browser
 * and the isolated user-path fixture; it never injects page state or a fake response.
 * Usage: node scripts/probes/account-conversation-controls-probe.mjs --dist PATH --site-root PATH --out TEMP_PATH
 */
import '../lib/no-user-dirs.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { editorSecurityHeaders, stageSecurityHeaders } from '../../src/online/stagePolicy.mjs';
import { startAccountConversationControlsUserFixture } from '../../server/test/fixtures/account-conversation-controls-user-path.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arg = flag => { const at = process.argv.indexOf(flag); return at < 0 ? null : process.argv[at + 1]; };
export function classifyAccountControlOutcome(state, confirmedText) {
  if (state.status === confirmedText) return { outcome: 'confirmed', state };
  if (state.status?.includes('已禁止新访问，相关服务关闭待确认') || state.status?.includes('云端尚未确认这项操作'))
    return { outcome: 'pending', state };
  return { outcome: 'error', state };
}

export async function inspectAccountConversationControls(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('[data-pc="cloud-ai-panel"]:not([data-inactive="1"]):not([aria-hidden="true"])');
    if (!panel) throw new Error('cloud-ai-panel-not-mounted');
    const visible = selector => {
      const element = panel.querySelector(selector);
      if (!element) return false;
      for (let node = element; node; node = node.parentElement) {
        const style = getComputedStyle(node), rect = node.getBoundingClientRect();
        if (node.hidden || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' ||
            style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0 ||
            rect.width <= 0 || rect.height <= 0) return false;
      }
      return true;
    };
    const messageList = panel.querySelector('.ai-messages');
    const visibleUserMessages = [...panel.querySelectorAll('.ai-messages .ai-message.user .ai-message-text')].filter(element => {
      for (let node = element; node; node = node.parentElement) {
        const style = getComputedStyle(node), rect = node.getBoundingClientRect();
        if (node.hidden || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' ||
            style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0 ||
            rect.width <= 0 || rect.height <= 0) return false;
        if (node === panel) break;
      }
      if (!messageList) return false;
      const rect = element.getBoundingClientRect(), clip = messageList.getBoundingClientRect();
      return rect.bottom > clip.top && rect.top < clip.bottom && rect.right > clip.left && rect.left < clip.right;
    });
    return {
      running: panel.getAttribute('data-cloud-running') === '1',
      canStop: panel.getAttribute('data-cloud-can-stop') === '1',
      visibility: panel.querySelector('[data-pc="cloud-conversation-controls"]')?.getAttribute('data-visibility') ?? null,
      canToggleVisibility: visible('[data-pc="cloud-visibility-toggle"]'),
      composerVisible: visible('[data-pc="ai-input"]'),
      creatorReadOnly: visible('[data-pc="cloud-readonly-note"]'),
      stopVisible: visible('[data-pc="ai-stop"]') || visible('[data-pc="cloud-stop-readonly"]'),
      status: panel.querySelector('[data-pc="cloud-control-status"]')?.textContent?.trim() ?? null,
      visibleMessages: visibleUserMessages.length,
    };
  });
}

export function assertAccountConversationControls(state, expected) {
  for (const [key, value] of Object.entries(expected)) {
    if (state[key] !== value) throw new Error(`cloud-control-${key}-expected-${String(value)}-got-${String(state[key])}`);
  }
  return state;
}

function safePageError(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  const category = /loading chunk|chunkloaderror/i.test(message) ? 'chunk-load' :
    /cannot read properties|undefined is not an object|null is not an object/i.test(message) ? 'missing-value' :
    /minified react|react error #|hydration/i.test(message) ? 'react-render' :
    /failed to fetch|networkerror|load failed/i.test(message) ? 'network' :
    /syntaxerror|unexpected token/i.test(message) ? 'syntax' : 'other';
  const name = new Set(['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError']).has(error?.name) ? error.name : 'Error';
  let frame = null;
  if (typeof error?.stack === 'string') for (const line of error.stack.split('\n')) {
    const match = line.match(/((?:https?|file):\/\/[^\s)]+):(\d+):(\d+)/);
    if (!match) continue;
    try {
      const url = new URL(match[1]);
      const origin = url.pathname.startsWith('/editor/') ? 'editor' : url.hostname.endsWith('.pc.localhost') ? 'stage' : 'other';
      const file = path.posix.basename(url.pathname);
      frame = { origin, ...( /^[A-Za-z0-9._-]{1,120}$/.test(file) ? { file } : {}), line: Number(match[2]), column: Number(match[3]) };
      break;
    } catch { /* never retain malformed or raw frame text */ }
  }
  return { name, category, ...(frame ? { frame } : {}) };
}

async function safePageSnapshot(page) {
  const pathname = (() => { try { return new URL(page.url()).pathname; } catch { return null; } })();
  try {
    const state = await page.evaluate(() => {
      const root = document.querySelector('#root');
      return {
        readyState: document.readyState,
        rootPresent: Boolean(root),
        rootChildCount: root?.childElementCount ?? 0,
        bodyChildCount: document.body?.childElementCount ?? 0,
        loginFormPresent: Boolean(document.querySelector('[data-pc="account-projects"] form')),
        accountNamePresent: Boolean(document.querySelector('[data-pc="account-name"]')),
        projectListPresent: Boolean(document.querySelector('[data-pc="cloud-project-lists"]')),
        projectRowCount: document.querySelectorAll('[data-pc="cloud-project-lists"] .sp-account-row').length,
        projectCopyPresent: Boolean(document.querySelector('[data-pc="cloud-project-copy"]')),
        consentDialogPresent: Boolean(document.querySelector('[data-pc="cloud-agent-consent"]')),
        cloudPanelPresent: Boolean(document.querySelector('[data-pc="cloud-ai-panel"]')),
      };
    });
    return { pathname, ...state };
  } catch {
    return { pathname, snapshotUnavailable: true };
  }
}

/** Click the actual owner control and distinguish a server-confirmed result from pending. */
export async function requestAccountVisibility(page, target, { timeoutMs = 30_000 } = {}) {
  if (target !== 'private' && target !== 'shared') throw new Error('visibility-target-must-be-private-or-shared');
  const state = await inspectAccountConversationControls(page);
  if (!state.canToggleVisibility) throw new Error('cloud-visibility-control-not-visible');
  const button = await page.$('[data-pc="cloud-visibility-toggle"]');
  if (!button) throw new Error('cloud-visibility-control-not-mounted');
  const label = await page.evaluate(element => element.textContent?.trim() ?? '', button);
  if (target === 'private' ? !label.includes('设为私有') && !label.includes('重试设为私有') : !label.includes('设为共有') && !label.includes('重试设为共有'))
    throw new Error(`visibility-control-does-not-target-${target}`);
  const conversationId = await page.evaluate(() => window.__pcCloud?.main?.conversationId?.() ?? null);
  if (typeof conversationId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(conversationId)) throw new Error('visibility-conversation-id-missing');
  const response = waitForControlResponse(page, conversationId, 'visibility', timeoutMs);
  await button.click();
  const realResponse = await response;
  await waitForControlResult(page, timeoutMs);
  return { ...classifyAccountControlOutcome(await inspectAccountConversationControls(page), target === 'private' ? '已切为私有。' : '已切为共有。'), httpStatus: realResponse.status() };
}

/** Retry the real stop control and report pending honestly; it never fabricates a fence ACK. */
export async function retryAccountStop(page, { timeoutMs = 30_000 } = {}) {
  const button = await page.$('[data-pc="cloud-stop-retry"]');
  if (!button || !await elementVisible(page, button)) throw new Error('cloud-stop-retry-not-visible');
  const conversationId = await page.evaluate(() => window.__pcCloud?.main?.conversationId?.() ?? null);
  if (typeof conversationId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(conversationId)) throw new Error('stop-conversation-id-missing');
  const response = waitForControlResponse(page, conversationId, 'abort', timeoutMs);
  await button.click();
  const realResponse = await response;
  await waitForControlResult(page, timeoutMs);
  return { ...classifyAccountControlOutcome(await inspectAccountConversationControls(page), '云端已确认停止请求。正在同步对话状态。'), httpStatus: realResponse.status() };
}

async function elementVisible(page, element) {
  return page.evaluate(target => {
    for (let node = target; node; node = node.parentElement) {
      const style = getComputedStyle(node), rect = node.getBoundingClientRect();
      if (node.hidden || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' ||
          style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0 ||
          rect.width <= 0 || rect.height <= 0) return false;
    }
    return true;
  }, element);
}

function waitForControlResponse(page, conversationId, action, timeoutMs) {
  if (action !== 'visibility' && action !== 'abort') throw new Error('unsupported-control-response');
  const expectedPath = `/agent/v1/conversations/${encodeURIComponent(conversationId)}/${action}`;
  return page.waitForResponse(response => {
    const url = new URL(response.url());
    return response.request().method() === 'POST' && url.pathname === expectedPath;
  }, { timeout: timeoutMs });
}

function waitForConsentResponse(page, method, timeoutMs) {
  return page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/account/cloud-agent-consent' && response.request().method() === method;
  }, { timeout: timeoutMs });
}

async function consentAccepted(response) {
  if (!response.ok()) return false;
  try { return (await response.json())?.accepted === true; } catch { return false; }
}

async function waitForControlResult(page, timeoutMs) {
  await page.waitForFunction(() => {
    const text = document.querySelector('[data-pc="cloud-control-status"]')?.textContent?.trim() ?? '';
    return Boolean(text) && !text.startsWith('正在更新') && !text.startsWith('正在向云端提交');
  }, { timeout: timeoutMs });
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.wasm': 'application/wasm' };
const TIMEOUT = 30_000;
const fill = async (page, selector, text) => {
  await page.waitForSelector(selector, { visible: true, timeout: TIMEOUT });
  await page.focus(selector); await page.keyboard.down('Control'); await page.keyboard.press('KeyA');
  await page.keyboard.up('Control'); await page.keyboard.press('Backspace'); await page.type(selector, text);
};
const enabled = (page, selector) => page.waitForFunction(query => {
  const element = document.querySelector(query); return element && !element.disabled;
}, { timeout: TIMEOUT }, selector);
const waitVisible = (page, selector) => page.waitForSelector(selector, { visible: true, timeout: TIMEOUT });
const waitForVisibleUserMessage = (page, expectedText) => page.waitForFunction(expected => {
  const panel = document.querySelector('[data-pc="cloud-ai-panel"]:not([data-inactive="1"]):not([aria-hidden="true"])');
  const list = panel?.querySelector('.ai-messages');
  if (!list) return false;
  return [...list.querySelectorAll('.ai-message.user .ai-message-text')].some(element => {
    const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node), rect = node.getBoundingClientRect();
      if (node.hidden || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' ||
          style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0 ||
          rect.width <= 0 || rect.height <= 0) return false;
      if (node === panel) break;
    }
    const rect = element.getBoundingClientRect(), clip = list.getBoundingClientRect();
    return text.includes(expected) && rect.bottom > clip.top && rect.top < clip.bottom &&
      rect.right > clip.left && rect.left < clip.right;
  });
}, { timeout: TIMEOUT }, expectedText);
const portFree = port => new Promise(resolve => {
  const socket = net.createConnection({ host: '127.0.0.1', port });
  socket.once('connect', () => { socket.destroy(); resolve(false); });
  socket.once('error', error => resolve(error.code === 'ECONNREFUSED'));
  socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
});
const closeServer = async entry => {
  for (const socket of entry.sockets) socket.destroy();
  if (entry.server.listening) await new Promise(resolve => entry.server.close(resolve));
  entry.server.closeAllConnections?.();
};

async function main() {
  const distArg = arg('--dist'), siteArg = arg('--site-root'), outArg = arg('--out');
  if (!distArg || !siteArg || !outArg) throw new Error('required-flags:--dist --site-root --out');
  const DIST = path.resolve(distArg), SITE = path.resolve(siteArg), OUT = path.resolve(outArg);
  const outRelative = path.relative(os.tmpdir(), OUT);
  if (!outRelative || outRelative.startsWith('..') || path.isAbsolute(outRelative)) throw new Error('--out-must-be-a-child-of-os-temp');
  const ports = [6620, 6621, 6622, 6623, 6624, 6625, 6626, 6627, 6628, 6629];
  const ORIGIN = 'https://127.0.0.1:6626', STAGES = ['http://s1.pc.localhost:6628', 'http://s2.pc.localhost:6629'];
  const result = { sourceBefore: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, windowsHide: true, encoding: 'utf8' }).trim(),
    checks: [], network: [], eventReads: [], screenshots: [], pageErrors: [], pageSteps: [], completed: false, fence: 'not-tested', cleanup: {} };
  const check = (condition, name) => { result.checks.push({ name, pass: Boolean(condition) }); if (!condition) throw new Error(name); };
  const stages = [], contexts = [], pages = [], requestIds = new WeakMap(), firstVisibilityId = new WeakMap(), visibilityCounts = new WeakMap(), eventReadRequests = new WeakMap();
  const pageLabels = ['creator', 'owner', 'member'];
  let browser, fixture, phase = 'preflight', phaseDetail = null, browserProfile;
  const started = Date.now();
  const recordPageStep = async (page, label, step) => {
    phaseDetail = step;
    result.pageSteps.push({ page: label, step, ...(await safePageSnapshot(page)) });
  };
  const shot = async (page, name) => {
    if (await page.$('input[type="password"]')) return;
    const file = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: file, fullPage: true }); result.screenshots.push({ name, file });
  };
  const visibleAndUnobscured = (page, element) => page.evaluate(target => {
    for (let node = target; node; node = node.parentElement) {
      const style = getComputedStyle(node), rect = node.getBoundingClientRect();
      if (node.hidden || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' ||
          style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0 ||
          rect.width <= 0 || rect.height <= 0) return false;
    }
    const rect = target.getBoundingClientRect(), hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return Boolean(hit && (hit === target || target.contains(hit)));
  }, element);
  const closeProjectShareToast = async (page, pageLabel) => {
    const toast = '.pc-toast:has([data-pc="cloud-project-copy"])';
    const closeSelector = `${toast} button[aria-label="关闭"]`;
    check(Boolean(await page.$(`${toast} [data-pc="cloud-project-copy"]`)), `${pageLabel}-project-copy-toast-present`);
    await page.waitForFunction(selector => {
      const button = document.querySelector(selector);
      if (!button || button.disabled) return false;
      const rect = button.getBoundingClientRect(), style = getComputedStyle(button);
      if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden') return false;
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return Boolean(hit && (hit === button || button.contains(hit)));
    }, { timeout: TIMEOUT }, closeSelector);
    const closeButton = await page.$(closeSelector);
    if (!closeButton || !await visibleAndUnobscured(page, closeButton)) throw new Error('project-share-toast-close-obscured');
    await recordPageStep(page, pageLabel, 'open-project:share-toast-close-visible');
    await closeButton.click();
    await page.waitForFunction(selector => document.querySelector(selector) === null, { timeout: TIMEOUT }, toast);
    await recordPageStep(page, pageLabel, 'open-project:share-toast-dismissed');
  };
  const chooseHistory = async (page, conversationId) => {
    await page.waitForFunction(() => {
      const panel = document.querySelector('[data-pc="cloud-ai-panel"]'), button = panel?.querySelector('button[title*="历史"]');
      if (!button || button.disabled) return false;
      const rect = button.getBoundingClientRect(), style = getComputedStyle(button);
      if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden') return false;
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return Boolean(hit && (hit === button || button.contains(hit)));
    }, { timeout: TIMEOUT });
    const history = await page.$('[data-pc="cloud-ai-panel"] button[title*="历史"]');
    check(Boolean(history), 'history-button-present'); await history.click();
    await page.waitForFunction(id => Array.from(document.querySelectorAll('[data-pc="chat-cloud-item"]')).some(row => {
      if (row.getAttribute('data-chat-id') !== id) return false;
      const rect = row.getBoundingClientRect(), style = getComputedStyle(row);
      if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden' ||
          row.hidden || row.getAttribute('aria-hidden') === 'true') return false;
      return true;
    }), { timeout: TIMEOUT }, conversationId);
    const rows = await page.$$('[data-pc="chat-cloud-item"]');
    let target = null;
    for (const row of rows) if (await row.evaluate(element => element.getAttribute('data-chat-id')) === conversationId) { target = row; break; }
    if (!target) throw new Error('history-row-not-found');
    await target.scrollIntoView();
    await page.waitForFunction(id => Array.from(document.querySelectorAll('[data-pc="chat-cloud-item"]')).some(row => {
      if (row.getAttribute('data-chat-id') !== id) return false;
      const rect = row.getBoundingClientRect(), style = getComputedStyle(row);
      if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden' ||
          row.hidden || row.getAttribute('aria-hidden') === 'true') return false;
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return Boolean(hit && (hit === row || row.contains(hit)));
    }), { timeout: TIMEOUT }, conversationId);
    if (!await visibleAndUnobscured(page, target)) throw new Error('history-row-obscured');
    await target.click();
    await page.waitForFunction(id => window.__pcCloud?.main?.conversationId?.() === id, { timeout: TIMEOUT }, conversationId);
  };
  const serve = stage => async (req, res) => {
    const url = new URL(req.url, ORIGIN), headers = stage ? stageSecurityHeaders(ORIGIN) : editorSecurityHeaders(STAGES);
    if (url.pathname === '/editor/runtime-config.json') {
      res.writeHead(200, { ...headers, 'content-type': 'application/json' });
      res.end(JSON.stringify({ v: 1, stageOrigins: STAGES })); return;
    }
    const editor = url.pathname.startsWith('/editor'), root = editor || stage || url.pathname.startsWith('/catalog/') ? DIST : SITE;
    const name = editor ? (url.pathname.replace(/^\/editor\/?/, '') || 'index.html') : url.pathname.slice(1) || 'index.html';
    const file = path.resolve(root, name), relative = path.relative(root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) { res.writeHead(404); res.end(); return; }
    try {
      const bytes = await fs.readFile(file);
      res.writeHead(200, { ...headers, 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch { res.writeHead(404); res.end(); }
  };
  try {
    await fs.access(path.join(DIST, 'index.html')); await fs.access(SITE);
    await fs.mkdir(OUT, { recursive: true });
    for (const port of ports) check(await portFree(port), `port-${port}-available`);
    fixture = await startAccountConversationControlsUserFixture({
      ports: [6620, 6621, 6622, 6623, 6624, 6625, 6626], agentPort: 6627, publicHandler: serve(false),
    });
    result.fixtureEvidenceDir = fixture.fixtureDir;
    for (const port of [6628, 6629]) {
      const sockets = new Set(), server = http.createServer((req, res) => { void serve(true)(req, res); });
      server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
      const entry = { server, sockets, port }; stages.push(entry);
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    }
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH ?? await puppeteer.executablePath();
    await fs.access(executablePath);
    browserProfile = path.join(OUT, 'chrome-profile');
    result.browserProfileEvidenceDir = browserProfile;
    browser = await puppeteer.launch({ executablePath, headless: true, pipe: true, userDataDir: browserProfile,
      args: [...PROBE_CHROME_ARGS, '--ignore-certificate-errors', '--host-resolver-rules=MAP s1.pc.localhost 127.0.0.1,MAP s2.pc.localhost 127.0.0.1'] });
    for (let i = 0; i < pageLabels.length; i++) {
      const context = await browser.createBrowserContext(); contexts.push(context);
      const page = await context.newPage(); pages.push(page); page.setDefaultTimeout(TIMEOUT);
      const pageLabel = pageLabels[i];
      page.on('pageerror', error => result.pageErrors.push({ page: pageLabel, ...safePageError(error) }));
      page.on('request', request => {
        const url = new URL(request.url());
        if (request.method() === 'GET' && /\/agent\/v1\/conversations\/[^/]+\/events$/.test(url.pathname)) {
          const safePath = url.pathname.replace(/\/conversations\/[^/]+(?=\/)/g, '/conversations/:conversationId');
          const record = { page: pageLabel, path: safePath, status: null, lifecycle: 'open' };
          result.eventReads.push(record); eventReadRequests.set(request, record);
        }
        if (url.pathname.endsWith('/visibility') && request.method() === 'POST') {
          let id = null; try { id = JSON.parse(request.postData() ?? '{}')?.requestId ?? null; } catch { /* keep only match status */ }
          const count = visibilityCounts.get(page) ?? 0;
          visibilityCounts.set(page, count + 1);
          if (count === 0) firstVisibilityId.set(page, id);
          requestIds.set(request, { sequence: count + 1, matched: count === 0 ? Boolean(id) : Boolean(id && id === firstVisibilityId.get(page)) });
        }
      });
      page.on('response', response => {
        const url = new URL(response.url());
        const eventRead = eventReadRequests.get(response.request());
        if (eventRead) eventRead.status = response.status();
        if (url.pathname.startsWith('/agent/') || url.pathname.startsWith('/hosted/shared/account/')) {
          const meta = requestIds.get(response.request());
          const safePath = url.pathname.replace(/\/conversations\/[^/]+(?=\/)/g, '/conversations/:conversationId');
          result.network.push({ page: pageLabel, path: safePath, status: response.status(), method: response.request().method(),
            ...(url.pathname.endsWith('/visibility') ? { attempt: meta?.sequence ?? 0, stableRequestIdMatch: meta?.matched === true } : {}) });
        }
      });
      page.on('requestfinished', request => {
        const eventRead = eventReadRequests.get(request);
        if (eventRead) eventRead.lifecycle = 'finished';
      });
      page.on('requestfailed', request => {
        const eventRead = eventReadRequests.get(request);
        if (eventRead) eventRead.lifecycle = 'failed';
      });
    }
    const [creator, owner, member] = pages, projectName = 'Shared dual account project';
    phase = 'login';
    for (let index = 0; index < pages.length; index++) {
      const page = pages[index], account = fixture.accounts[index];
      const pageLabel = pageLabels[index];
      await recordPageStep(page, pageLabel, 'login:navigate');
      await page.goto(`${ORIGIN}/editor/`, { waitUntil: 'domcontentloaded' });
      await recordPageStep(page, pageLabel, 'login:form-loaded');
      await fill(page, 'input[name="username"]', account.name); await fill(page, 'input[name="password"]', account.password);
      const submit = '[data-pc="account-projects"] form button.sp-primary-btn';
      await enabled(page, submit); await page.click(submit);
      await waitVisible(page, '[data-pc="account-name"]');
      await recordPageStep(page, pageLabel, 'login:account-ready');
    }
    const openProject = async page => {
      const pageLabel = pageLabels[pages.indexOf(page)];
      let consentRead;
      await recordPageStep(page, pageLabel, 'open-project:wait-list-row');
      await page.waitForFunction(name => Array.from(document.querySelectorAll('[data-pc="cloud-project-lists"] .sp-account-row'))
        .some(row => row.querySelector('button')?.textContent?.trim() === name), { timeout: TIMEOUT }, projectName);
      await recordPageStep(page, pageLabel, 'open-project:list-row-ready');
      const rows = await page.$$('[data-pc="cloud-project-lists"] .sp-account-row');
      let selected = false;
      for (const row of rows) {
        const title = await row.$eval('button', element => element.textContent?.trim() ?? '').catch(() => '');
        if (title !== projectName) continue;
        const buttons = await row.$$('button');
        if (!buttons.length || await buttons[0].evaluate(button => button.disabled)) throw new Error('project-open-button-disabled');
        await recordPageStep(page, pageLabel, 'open-project:before-real-click');
        consentRead = waitForConsentResponse(page, 'GET', TIMEOUT).then(async response => ({ kind: 'response', accepted: await consentAccepted(response) })).catch(() => null);
        await buttons[0].click(); selected = true; break;
      }
      if (!selected) throw new Error('project-open-row-not-selected');
      await recordPageStep(page, pageLabel, 'open-project:clicked-wait-cloud-copy');
      await waitVisible(page, '[data-pc="cloud-project-copy"]');
      await recordPageStep(page, pageLabel, 'open-project:cloud-copy-ready');
      const consentDialog = page.waitForSelector('[data-pc="cloud-agent-consent"]', { visible: true, timeout: TIMEOUT })
        .then(() => ({ kind: 'dialog' })).catch(() => null);
      let consentState = await Promise.race([consentRead ?? Promise.resolve(null), consentDialog]);
      if (consentState?.kind === 'response' && consentState.accepted) {
        await recordPageStep(page, pageLabel, 'open-project:consent-already-accepted');
      } else {
        if (consentState?.kind === 'response') consentState = await consentDialog;
        if (consentState?.kind === 'dialog' || await page.$('[data-pc="cloud-agent-consent"]')) {
          await waitVisible(page, '[data-pc="cloud-agent-consent"]');
          await recordPageStep(page, pageLabel, 'open-project:consent-dialog-visible');
          const buttons = await page.$$('[data-pc="cloud-agent-consent"] button');
          if (buttons.length < 2) throw new Error('cloud-consent-buttons-missing');
          const acceptance = waitForConsentResponse(page, 'POST', TIMEOUT);
          await buttons[1].click();
          const accepted = await acceptance;
          if (!await consentAccepted(accepted)) throw new Error('cloud-consent-acceptance-not-confirmed');
          await page.waitForSelector('[data-pc="cloud-agent-consent"]', { hidden: true, timeout: TIMEOUT });
          await recordPageStep(page, pageLabel, 'open-project:consent-accepted');
        } else {
          throw new Error('cloud-consent-read-or-dialog-not-observed');
        }
      }
      await closeProjectShareToast(page, pageLabel);
    };
    phase = 'project-open'; await openProject(creator); await openProject(owner); await openProject(member);
    phase = 'enable-agent';
    const enableButton = await creator.$('[data-pc="cloud-agent-enable"]');
    if (enableButton) { await enabled(creator, '[data-pc="cloud-agent-enable"]'); await enableButton.click(); }
    await creator.waitForSelector('[data-pc="cloud-off"]', { hidden: true, timeout: TIMEOUT });
    await owner.waitForFunction(() => document.querySelector('[data-pc="cloud-off"]') === null, { timeout: TIMEOUT });
    phase = 'owner-creates-shared-conversation';
    phaseDetail = 'owner-send-shared-message';
    const ownerPrompt = 'Owner-created shared conversation for control probe';
    await fill(owner, '[data-pc="cloud-ai-panel"] [data-pc="ai-input"]', ownerPrompt);
    await owner.keyboard.press('Enter');
    await owner.waitForFunction(() => document.querySelectorAll('[data-pc="cloud-queue"] li[data-message-id]').length === 1, { timeout: TIMEOUT });
    await owner.waitForFunction(() => Boolean(window.__pcCloud?.main?.conversationId?.()), { timeout: TIMEOUT });
    const conversationId = await owner.evaluate(() => window.__pcCloud.main.conversationId());
    check(typeof conversationId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(conversationId), 'owner-conversation-id-shape');
    await chooseHistory(creator, conversationId);
    await creator.waitForFunction(() => document.querySelector('[data-pc="cloud-visibility-label"]')?.textContent?.includes('共有对话'), { timeout: TIMEOUT });
    await waitForVisibleUserMessage(creator, ownerPrompt);
    await chooseHistory(member, conversationId);
    await member.waitForFunction(() => document.querySelector('[data-pc="cloud-visibility-label"]')?.textContent?.includes('共有对话'), { timeout: TIMEOUT });
    await waitForVisibleUserMessage(member, ownerPrompt);
    check(result.eventReads.some(entry => entry.page === 'member' && entry.path.endsWith('/events') && entry.status === 200 && entry.lifecycle === 'open'),
      'ordinary-member-real-shared-events-readable');
    const creatorShared = await inspectAccountConversationControls(creator);
    assertAccountConversationControls(creatorShared, { visibility: 'shared', canToggleVisibility: false, creatorReadOnly: false });
    check(creatorShared.visibleMessages > 0, 'creator-can-read-shared-conversation');
    await shot(creator, '01-creator-shared-no-toggle');
    check((await inspectAccountConversationControls(member)).visibleMessages > 0, 'ordinary-member-real-shared-history-readable');
    await shot(member, '02-member-shared-readable');
    const ownerShared = await inspectAccountConversationControls(owner);
    assertAccountConversationControls(ownerShared, { visibility: 'shared', canToggleVisibility: true });
    await shot(owner, '03-owner-shared-toggle');

    phase = 'owner-switch-private-confirmed';
    phaseDetail = 'wait-for-real-private-confirmation-and-member-access-revocation';
    const firstAttempt = await requestAccountVisibility(owner, 'private');
    check(firstAttempt.outcome === 'confirmed' && firstAttempt.httpStatus === 200, 'private-switch-real-fence-confirmed');
    result.fence = 'confirmed-by-real-service';
    check(result.network.some(entry => entry.page === 'owner' && entry.path.endsWith('/visibility') && entry.status === 200),
      'private-switch-real-http-200');
    const memberReadClosed = await waitFor(() => result.eventReads.some(entry => entry.page === 'member' &&
      entry.path.endsWith('/events') && entry.status === 200 && entry.lifecycle !== 'open'),
    'ordinary member old events stream close after private fence', TIMEOUT).then(() => true, () => false);
    let memberMessageCleared = false;
    try {
      await member.waitForFunction(() => {
        const panel = document.querySelector('[data-pc="cloud-ai-panel"]:not([data-inactive="1"]):not([aria-hidden="true"])');
        return Boolean(panel) && panel.querySelector('.ai-message.user .ai-message-text') === null;
      }, { timeout: TIMEOUT });
      memberMessageCleared = (await inspectAccountConversationControls(member)).visibleMessages === 0;
    } catch { /* Keep the actual visible result for the paired assertions below. */ }
    await shot(owner, '04-owner-private-confirmed');

    phase = 'ordinary-member-private-history-hidden';
    phaseDetail = 'refresh-member-history-after-real-private-confirmation';
    const memberHistoryButton = await member.$('[data-pc="cloud-ai-panel"] button[title*="历史"]');
    if (!memberHistoryButton || !await visibleAndUnobscured(member, memberHistoryButton)) throw new Error('member-history-button-not-usable');
    const memberListResponse = member.waitForResponse(response => {
      const url = new URL(response.url());
      return response.request().method() === 'GET' && url.pathname === '/agent/v1/conversations';
    }, { timeout: TIMEOUT }).catch(() => null);
    await memberHistoryButton.click();
    check((await memberListResponse)?.status() === 200, 'ordinary-member-history-refresh-real-http-200');
    const memberHistoryAfterPrivate = await member.$('[data-pc="cloud-ai-panel"] button[title*="历史"]');
    if (!memberHistoryAfterPrivate || !await visibleAndUnobscured(member, memberHistoryAfterPrivate)) throw new Error('member-history-button-after-private-not-usable');
    const memberListAfterPrivate = member.waitForResponse(response => {
      const url = new URL(response.url());
      return response.request().method() === 'GET' && url.pathname === '/agent/v1/conversations';
    }, { timeout: TIMEOUT }).catch(() => null);
    await memberHistoryAfterPrivate.click();
    const memberHistoryResponse = await memberListAfterPrivate;
    const memberHistoryStatus = memberHistoryResponse?.status() ?? null;
    let memberServerListsPrivate = null;
    if (memberHistoryResponse?.ok()) {
      try {
        const body = await memberHistoryResponse.json();
        memberServerListsPrivate = Array.isArray(body?.items) && body.items.some(item => item?.id === conversationId);
      } catch { memberServerListsPrivate = null; }
    }
    await waitVisible(member, '[data-pc="chat-cloud-group"]');
    await member.waitForFunction(() => {
      const group = document.querySelector('[data-pc="chat-cloud-group"]');
      const loading = group?.querySelector('.chat-drawer-empty');
      return Boolean(group) && (!loading || loading.textContent?.trim() !== '读取中…');
    }, { timeout: TIMEOUT });
    const memberHistoryRowVisible = await member.evaluate(id => Array.from(document.querySelectorAll('[data-pc="chat-cloud-item"]'))
      .some(row => row.getAttribute('data-chat-id') === id), conversationId);
    await shot(member, '06-member-after-private-history-refresh');
    const privateReadChecks = [
      { name: 'ordinary-member-old-read-closed-after-private', pass: memberReadClosed },
      { name: 'ordinary-member-current-private-message-cleared', pass: memberMessageCleared },
      { name: 'ordinary-member-private-history-refresh-real-http-200', pass: memberHistoryStatus === 200 },
      { name: 'ordinary-member-private-history-server-omits-id', pass: memberServerListsPrivate === false },
      { name: 'ordinary-member-private-history-ui-omits-id', pass: memberHistoryRowVisible === false },
    ];
    result.checks.push(...privateReadChecks);
    if (privateReadChecks.some(item => !item.pass)) throw new Error(privateReadChecks.find(item => !item.pass).name);
    phase = 'creator-private-readonly';
    phaseDetail = 'creator-reopen-private-conversation-and-wait-for-history-body';
    await chooseHistory(creator, conversationId);
    await creator.waitForFunction(() => document.querySelector('[data-pc="cloud-visibility-label"]')?.textContent?.includes('私有对话'), { timeout: TIMEOUT });
    await waitForVisibleUserMessage(creator, ownerPrompt);
    const creatorPrivate = await inspectAccountConversationControls(creator);
    assertAccountConversationControls(creatorPrivate, { visibility: 'private', canToggleVisibility: false, creatorReadOnly: true, composerVisible: false });
    check(creatorPrivate.visibleMessages > 0, 'creator-can-read-private-conversation');
    await shot(creator, '04-creator-private-readonly');

    check(result.network.filter(entry => entry.path.endsWith('/messages') && entry.status === 202).length === 1,
      'message-was-queued-and-not-called-running');
    await shot(owner, '05-owner-private-confirmed');
    result.fence = 'confirmed-by-real-service';
    result.completed = true;
  } catch (error) {
    result.failure = { phase, detail: phaseDetail, code: error?.name === 'TimeoutError' ? 'timeout' : error?.name === 'Error' ? 'probe-check-failed' : 'probe-failed' };
    for (let index = 0; index < pages.length; index++) {
      const page = pages[index];
      result.pageSteps.push({ page: pageLabels[index], step: `failure-snapshot:${phase}`, ...(await safePageSnapshot(page)) });
    }
    for (let index = 0; index < pages.length; index++) await shot(pages[index], `failure-${index}`).catch(() => {});
    process.exitCode = 1;
  } finally {
    for (const context of contexts) await context.close().catch(() => {});
    await browser?.close().catch(() => {});
    for (const stage of stages) await closeServer(stage).catch(() => {});
    const fixtureClose = await fixture?.close().catch(() => ({ closed: false })) ?? { closed: true, notStarted: true };
    result.cleanup.fixture = { closed: fixtureClose.closed === true,
      ...(typeof fixtureClose.childClosed === 'boolean' ? { childClosed: fixtureClose.childClosed } : {}),
      ...(fixtureClose.notStarted === true ? { notStarted: true } : {}),
      ...(Number.isSafeInteger(fixtureClose.closeFailureCount) ? { closeFailureCount: fixtureClose.closeFailureCount } : {}),
      evidenceDir: fixtureClose.fixtureDir ?? result.fixtureEvidenceDir ?? null };
    result.cleanup.portsFree = Object.fromEntries(await Promise.all(ports.map(async port => [String(port), await portFree(port)])));
    result.cleanup.allPortsFree = Object.values(result.cleanup.portsFree).every(Boolean);
    result.cleanup.fixtureAndPortsClosed = result.cleanup.fixture.closed &&
      (result.cleanup.fixture.notStarted === true || result.cleanup.fixture.childClosed === true) && result.cleanup.allPortsFree;
    result.wallMs = Date.now() - started;
    result.sourceAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, windowsHide: true, encoding: 'utf8' }).trim();
    await fs.writeFile(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ completed: result.completed, phase, checks: result.checks.length, fence: result.fence,
      detail: phaseDetail, pageErrors: result.pageErrors.length, wallMs: result.wallMs,
      closed: result.cleanup.fixtureAndPortsClosed === true, output: OUT,
      fixtureEvidenceDir: result.fixtureEvidenceDir ?? null, browserProfileEvidenceDir: result.browserProfileEvidenceDir ?? null }));
    if (!result.cleanup.allPortsFree) process.exitCode = 1;
  }
}

const invoked = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  try { await main(); }
  catch (error) {
    console.error(JSON.stringify({ completed: false, code: error?.name === 'Error' ? error.message : 'probe-start-failed' }));
    process.exitCode = 1;
  }
}
