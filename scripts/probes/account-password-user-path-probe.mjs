// First import protects user directories and the shared port file before importing browser or fixture code.
import '../lib/no-user-dirs.mjs';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { editorSecurityHeaders, stageSecurityHeaders } from '../../src/online/stagePolicy.mjs';
import { startAccountPasswordUserFixture } from '../../server/test/fixtures/account-password-user-path.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const arg = name => { const index = argv.indexOf(name); return index < 0 ? undefined : argv[index + 1]; };
const required = name => { const value = arg(name); if (!value || value.startsWith('--')) throw Error(`missing-${name}`); return path.resolve(value); };
const DIST = required('--dist'), SITE = required('--site-root'), OUT = required('--out');
const SITE_FORM_ONLY = argv.includes('--site-form-only');
const outRelative = path.relative(os.tmpdir(), OUT);
if (!outRelative || outRelative.startsWith('..') || path.isAbsolute(outRelative)) throw Error('output-must-be-private-temp-child');
const PORTS = [6680, 6681, 6682, 6683, 6684, 6685, 6686, 6687, 6688, 6689];
const ORIGIN = 'https://127.0.0.1:6686';
const STAGES = ['http://s1.pc.localhost:6688', 'http://s2.pc.localhost:6689'];
const TIMEOUT = 35_000;
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css', '.json':'application/json',
  '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.woff':'font/woff', '.woff2':'font/woff2', '.ttf':'font/ttf', '.wasm':'application/wasm' };
const SOURCE = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd:ROOT, windowsHide:true, encoding:'utf8' }).trim();
const result = { sourceBefore:SOURCE(), checks:[], phases:[], network:[], staticAssets:[], styleStates:[], eventStreams:[], pageErrors:[], screenshots:[], completed:false, cleanup:{} };
const SAFE_AGENT_CODES = new Set(['disabled','bad-grant','unauthorized','forbidden','account-required','consent-required',
  'project-mismatch','ticket-expired','ticket-invalid','not-found','bad-request','service-unavailable']);
let fixture, browser;
const pages = [], contexts = [], stageServers = [];
let currentPhase = 'preflight';
let editorStep = null;
let targetConversationId = null;
let realAgentDelegationTicket = null;
let safeAction = null;
const eventConversationIds = new WeakMap();

function check(condition, name) {
  result.checks.push({ name, pass:Boolean(condition) });
  if (!condition) { const error = Error(name); error.check = name; throw error; }
}
async function bringPageToFront(page, purpose) {
  const before = await page.evaluate(() => ({ visibilityState:document.visibilityState, hasFocus:document.hasFocus() }));
  await page.bringToFront();
  const after = await page.evaluate(() => ({ visibilityState:document.visibilityState, hasFocus:document.hasFocus() }));
  result.pageFocus ??= [];
  result.pageFocus.push({ page:page.label ?? 'unlabelled', purpose, before, after });
}
function safeErrorDetails(error) {
  const rawName = error?.name || error?.constructor?.name || 'Error';
  const errorType = /^[A-Za-z][A-Za-z0-9_$]{0,80}$/.test(rawName) ? rawName : 'other';
  const message = String(error?.message ?? '');
  const protocolMethod = /Protocol error \(([A-Za-z0-9_.]{1,100})\)/.exec(message)?.[1] ?? null;
  const protocolReason = /timed?\s*out|timeout/i.test(message) ? 'timed-out' :
    /target closed|browser has disconnected/i.test(message) ? 'target-closed' :
    /execution context.*destroyed|cannot find context|context was destroyed/i.test(message) ? 'context-lost' :
    /invalid parameters/i.test(message) ? 'invalid-parameters' : 'other';
  const sourceFrames = String(error?.stack ?? '').split('\n').slice(1).map(line => line.trim())
    .filter(line => /^at\s/.test(line)).slice(0, 16)
    .map(line => line.replace(/https?:\/\/[^\s)]+/g, raw => {
      try { const url = new URL(raw); return `${url.origin}${url.pathname}`; } catch { return '[url]'; }
    }));
  return { errorType, protocolMethod, protocolReason, sourceFrames };
}
function safePath(raw) {
  const url = new URL(raw, ORIGIN), prefix = url.pathname;
  return prefix.replace(/\/password-events\/[^/]+/g, '/password-events/:eventId')
    .replace(/\/conversations\/[^/]+/g, '/conversations/:conversationId');
}
async function portIsFree(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host:'127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', error => resolve(error.code === 'ECONNREFUSED'));
    socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
  });
}
function below(root, relative) {
  const target = path.resolve(root, relative), rel = path.relative(root, target);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? target : null;
}
async function sendFile(req, res, root, relative, headers) {
  const file = below(root, relative);
  let stat;
  try { stat = file && await fs.stat(file); } catch { /* Safe static 404. */ }
  if (!stat?.isFile()) { res.writeHead(404, headers); res.end(); return; }
  const bytes = await fs.readFile(file);
  res.writeHead(200, { ...headers, 'content-type':MIME[path.extname(file)] ?? 'application/octet-stream',
    'content-length':bytes.length, 'cache-control':'no-store' });
  res.end(req.method === 'HEAD' ? undefined : bytes);
}
function siteHandler() {
  return async (req, res) => {
    const url = new URL(req.url, ORIGIN), route = url.pathname;
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    if (route === '/editor/runtime-config.json') {
      res.writeHead(200, { 'content-type':'application/json', 'cache-control':'no-store' });
      res.end(JSON.stringify({ v:1, stageOrigins:STAGES })); return;
    }
    if (route === '/editor' || route === '/editor/' || route === '/editor/index.html')
      return sendFile(req, res, DIST, 'index.html', editorSecurityHeaders(STAGES));
    if (route.startsWith('/editor/'))
      return sendFile(req, res, DIST, decodeURIComponent(route.slice('/editor/'.length)), editorSecurityHeaders(STAGES));
    if (route.startsWith('/catalog/'))
      return sendFile(req, res, DIST, decodeURIComponent(route.slice(1)), editorSecurityHeaders(STAGES));
    const siteFile = route === '/' ? 'index.html' : ['/login', '/account', '/reset', '/register'].includes(route)
      ? `${route.slice(1)}.html` : decodeURIComponent(route.slice(1));
    return sendFile(req, res, SITE, siteFile, { 'referrer-policy':'no-referrer', 'x-content-type-options':'nosniff' });
  };
}
async function startStage(port) {
  const sockets = new Set(), server = http.createServer(async (req, res) => {
    const route = new URL(req.url, ORIGIN).pathname;
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    const headers = stageSecurityHeaders(ORIGIN);
    if (route === '/editor/runtime-config.json') {
      res.writeHead(200, { ...headers, 'content-type':'application/json', 'cache-control':'no-store' });
      res.end(JSON.stringify({ v:1, stageOrigins:STAGES })); return;
    }
    if (route === '/editor/stage.html' || route === '/stage.html') return sendFile(req, res, DIST, 'stage.html', headers);
    if (route.startsWith('/editor/')) return sendFile(req, res, DIST, decodeURIComponent(route.slice('/editor/'.length)), headers);
    res.writeHead(404, headers); res.end();
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  stageServers.push({ server, sockets, port });
}
async function newPage(context, label) {
  const page = await context.newPage(); page.setDefaultTimeout(TIMEOUT); page.setDefaultNavigationTimeout(TIMEOUT);
  page.label = label; pages.push(page);
  const eventRequests = new Map();
  page.on('pageerror', error => {
    const message = String(error?.message ?? '');
    const category = /cannot read properties|undefined is not an object|null is not an object/i.test(message) ? 'missing-value' :
      /react error|hydration|minified/i.test(message) ? 'react-render' : /failed to fetch|networkerror/i.test(message) ? 'network' : 'other';
    result.pageErrors.push({ page:label, category });
  });
  page.on('request', request => {
    let url; try { url = new URL(request.url()); } catch { return; }
    if (![ORIGIN, ...STAGES].includes(url.origin)) return;
    const route = safePath(request.url());
    if (route.includes('/agent/v1/conversations/:conversationId/events') && request.method() === 'GET') {
      const entry = { page:label, lifecycle:'open', status:null,
        conversationMatch:targetConversationId === null ? null : url.pathname.includes(`/conversations/${targetConversationId}/`) };
      eventConversationIds.set(entry, /\/conversations\/([^/]+)\/events$/.exec(url.pathname)?.[1] ?? '');
      eventRequests.set(request, entry); result.eventStreams.push(entry);
    }
  });
  page.on('response', response => {
    let url; try { url = new URL(response.url()); } catch { return; }
    if (![ORIGIN, ...STAGES].includes(url.origin)) return;
    const route = safePath(response.url());
    if (/\.(?:css|js)$/.test(url.pathname) && (url.pathname.startsWith('/editor/assets/') || url.pathname.startsWith('/assets/'))) {
      const type = response.headers()['content-type']?.split(';')[0].trim();
      result.staticAssets.push({ page:label, path:url.pathname, status:response.status(),
        type:type === 'text/css' || type === 'text/javascript' || type === 'application/javascript' ? type : 'other' });
    }
    if (route.startsWith('/api/account/') || route.startsWith('/agent/v1/') ||
        route === '/hosted/shared/account/admin' || route === '/hosted/shared/account/session') {
      const entry = { page:label, method:response.request().method(), path:route, status:response.status() };
      if (label === 'online-editor' && route === '/hosted/shared/account/session' && response.status() === 200) {
        void response.json().then(body => {
          if (typeof body?.agentDelegationTicket === 'string' && /^[A-Za-z0-9_-]{43}$/.test(body.agentDelegationTicket)) {
            realAgentDelegationTicket = body.agentDelegationTicket;
            result.authorizationCapture = { realProjectSessionObserved:true, agentTicketCapturedInRam:true };
          }
        }).catch(() => {});
      }
      if (route.startsWith('/agent/v1/') && response.status() >= 400) void response.json().then(body => {
        const code = typeof body?.code === 'string' && SAFE_AGENT_CODES.has(body.code) ? body.code : 'other';
        entry.errorCode = code;
      }).catch(() => { entry.errorCode = 'unreadable'; });
      result.network.push(entry);
    }
    const entry = eventRequests.get(response.request()); if (entry) entry.status = response.status();
  });
  page.on('request', request => {
    let url; try { url = new URL(request.url()); } catch { return; }
    if (url.origin !== ORIGIN || url.pathname !== '/hosted/shared/account/admin' || request.method() !== 'POST') return;
    let body = null; try { body = JSON.parse(request.postData() ?? ''); } catch { /* Only safe booleans are retained. */ }
    result.projectControlRequests ??= [];
    result.projectControlRequests.push({ projectIdMatchesExpected:typeof body?.projectId === 'string' && body.projectId === fixture?.projectId,
      enablesAgent:body?.op === 'set-hosted-service' && body?.service === 'agent' && body?.enabled === true });
  });
  page.on('requestfinished', request => { const entry = eventRequests.get(request); if (entry) entry.lifecycle = 'finished'; });
  page.on('requestfailed', request => { const entry = eventRequests.get(request); if (entry) entry.lifecycle = 'failed'; });
  page.on('requestfailed', request => {
    let url; try { url = new URL(request.url()); } catch { return; }
    if (![ORIGIN, ...STAGES].includes(url.origin) || !/\.(?:css|js)$/.test(url.pathname)) return;
    const failure = request.failure()?.errorText ?? '';
    result.staticAssets.push({ page:label, path:url.pathname, status:null, type:'failed-request',
      error: /^net::ERR_[A-Z0-9_]+$/.test(failure) ? failure : 'other' });
  });
  return page;
}
async function fill(page, selector, value) {
  safeAction = 'fill-visible-field';
  await bringPageToFront(page, 'fill-form-field');
  const input = await page.waitForSelector(selector, { visible:true });
  await input.focus(); await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
  await page.keyboard.press('Backspace'); await input.type(value);
  safeAction = null;
}
async function clickPage(page, selector, options) {
  safeAction = 'real-page-click';
  await bringPageToFront(page, 'real-page-click');
  await page.click(selector, options);
  safeAction = null;
}
async function clickHandle(page, element, options) {
  safeAction = 'real-element-click';
  await bringPageToFront(page, 'real-element-click');
  await element.click(options);
  safeAction = null;
}
async function safeShot(page, label) {
  safeAction = 'screenshot-redaction';
  await bringPageToFront(page, `safe-screenshot:${label}`);
  for (const input of await page.$$('input[type="password"]')) {
    const visible = await input.evaluate(element => element.getClientRects().length > 0);
    if (visible) { await clickHandle(page, input, { clickCount:3 }); await page.keyboard.press('Backspace'); safeAction = 'screenshot-redaction'; }
  }
  for (const input of await page.$$('input[name="code"]')) {
    if (await input.evaluate(element => element.getClientRects().length > 0)) {
      await clickHandle(page, input); await page.keyboard.down('Control'); await page.keyboard.press('KeyA');
      await page.keyboard.up('Control'); await page.keyboard.press('Backspace');
      safeAction = 'screenshot-redaction';
    }
  }
  const clear = await page.$$eval('input[type="password"]', nodes => nodes.every(node => !node.getClientRects().length || node.value === ''));
  if (!clear) throw Error('password-screenshot-blocked');
  safeAction = 'screenshot-write';
  result.styleStates.push({ page:page.label, label, ...(await page.evaluate(() => {
    const links = [...document.querySelectorAll('link[rel="stylesheet"]')];
    let readableRuleCount = 0, unreadableStyleSheets = 0;
    for (const sheet of [...document.styleSheets]) {
      try { readableRuleCount += sheet.cssRules.length; } catch { unreadableStyleSheets++; }
    }
    return { stylesheetCount:links.length, loadedStylesheetCount:links.filter(link => Boolean(link.sheet) && !link.disabled).length,
      readableRuleCount, unreadableStyleSheets,
      bodyHasBackground:getComputedStyle(document.body).backgroundColor !== 'rgba(0, 0, 0, 0)',
      buttonsStyled:[...document.querySelectorAll('button')].some(button => getComputedStyle(button).borderRadius !== '0px') };
  })) });
  const file = `${label}.png`; await page.screenshot({ path:path.join(OUT, file), fullPage:true }); result.screenshots.push(file);
  safeAction = null;
}
async function visibleAndUnobscured(page, element) {
  return page.evaluate(target => {
    for (let node = target; node; node = node.parentElement) {
      const style = getComputedStyle(node), rect = node.getBoundingClientRect();
      if (node.hidden || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' ||
          style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0 ||
          rect.width <= 0 || rect.height <= 0) return false;
    }
    const rect = target.getBoundingClientRect(), hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return Boolean(hit && (hit === target || target.contains(hit)));
  }, element);
}
async function loginWebsite(page, account, label) {
  currentPhase = `${label}-website-login`;
  await bringPageToFront(page, 'website-login');
  await page.goto(`${ORIGIN}/login`, { waitUntil:'domcontentloaded' });
  await fill(page, '#login input[name="name"]', account.name);
  await fill(page, '#login input[name="password"]', account.password);
  const navigation = page.waitForNavigation({ waitUntil:'domcontentloaded' });
  await clickPage(page, '#login button[type="submit"]'); await navigation;
  check(new URL(page.url()).pathname === '/account', `${label}-website-session-created`);
  await page.waitForSelector('#acc-name');
  const visibleNameMatches = await page.$eval('#acc-name', element => element.textContent?.trim()) === account.name;
  check(visibleNameMatches, `${label}-authenticated-account-name`);
  await safeShot(page, `${label}-website-login`);
}
async function changePasswordThroughWebsite(page, account, checkPrefix = '') {
  currentPhase = 'password-change-and-exit';
  await page.goto(`${ORIGIN}/account`, { waitUntil:'domcontentloaded' });
  await page.waitForSelector('#password input[name="current"]', { visible:true });
  await fill(page, '#password input[name="current"]', account.password);
  await fill(page, '#password input[name="next"]', account.nextPassword);
  await fill(page, '#password input[name="again"]', account.nextPassword);
  result.passwordFormState = await page.$eval('#password', form => {
    const current = form.querySelector('[name="current"]'), next = form.querySelector('[name="next"]'), again = form.querySelector('[name="again"]');
    const submit = form.querySelector('button[type="submit"]');
    return { valid:form.checkValidity(), currentPresent:Boolean(current?.value), nextPresent:Boolean(next?.value),
      repeatedMatches:Boolean(next?.value) && next.value === again?.value, submitEnabled:Boolean(submit && !submit.disabled) };
  });
  check(result.passwordFormState.valid && result.passwordFormState.currentPresent && result.passwordFormState.nextPresent &&
    result.passwordFormState.repeatedMatches && result.passwordFormState.submitEnabled,
  checkPrefix ? `${checkPrefix}-password-form-valid` : 'password-change-form-valid-before-submit');
  const submit = await page.$('#password button[type="submit"]');
  if (!submit) throw Error('password-submit-button-missing');
  await submit.evaluate(element => element.scrollIntoView({ block:'center', inline:'nearest' }));
  result.passwordSubmitGeometry = await submit.evaluate(element => {
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    const visible = !element.disabled && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0 &&
      rect.top >= 0 && rect.left >= 0 && rect.bottom <= innerHeight && rect.right <= innerWidth;
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return { visible, unobscured:Boolean(hit && (hit === element || element.contains(hit))) };
  });
  check(result.passwordSubmitGeometry.visible && result.passwordSubmitGeometry.unobscured,
    checkPrefix ? `${checkPrefix}-password-submit-visible-unobscured` : 'password-submit-visible-unobscured');
  result.passwordRuntime = await page.evaluate(() => {
    const form = document.querySelector('#password'), current = form?.querySelector('[name="current"]'),
      next = form?.querySelector('[name="next"]'), again = form?.querySelector('[name="again"]');
    const diagnostics = { clickCount:0, clickTrusted:null, clickTargetSubmitter:false,
      submitCount:0, submitTrusted:null, submitterMatchesTarget:false, submitDefaultPrevented:null,
      invalidCount:0, invalidFields:[] };
    Object.defineProperty(window, '__pcPasswordFormDiagnostics', { value:diagnostics, configurable:true });
    const submitButton = form?.querySelector('button[type="submit"]');
    form?.addEventListener('click', event => {
      if (!submitButton || !(event.target instanceof Element) || !submitButton.contains(event.target) && event.target !== submitButton) return;
      diagnostics.clickCount++; diagnostics.clickTrusted = event.isTrusted;
      diagnostics.clickTargetSubmitter = true;
    }, true);
    form?.addEventListener('submit', event => {
      diagnostics.submitCount++; diagnostics.submitTrusted = event.isTrusted;
      diagnostics.submitterMatchesTarget = event.submitter === submitButton;
      queueMicrotask(() => { diagnostics.submitDefaultPrevented = event.defaultPrevented; });
    }, true);
    form?.addEventListener('invalid', event => {
      diagnostics.invalidCount++;
      const name = event.target instanceof HTMLInputElement ? event.target.name : '';
      if (['current','next','again'].includes(name)) diagnostics.invalidFields.push(name);
    }, true);
    return { secureContext:isSecureContext, randomUUIDType:typeof crypto?.randomUUID,
      fieldsValid:Boolean(current?.validity.valid && next?.validity.valid && again?.validity.valid),
      fieldsPresent:Boolean(current?.value && next?.value && again?.value),
      repeatedMatches:Boolean(next?.value && next.value === again?.value) };
  });
  const passwordResponse = page.waitForResponse(response => response.request().method() === 'POST' &&
    new URL(response.url()).pathname === '/api/account/password', { timeout:2500 })
    .then(response => ({ response }), () => ({ response:null }));
  const eventSnapshot = () => page.evaluate(() => ({ ...window.__pcPasswordFormDiagnostics,
    invalidFields:[...window.__pcPasswordFormDiagnostics.invalidFields] }));
  const focusSnapshot = () => page.evaluate(() => ({ visibilityState:document.visibilityState,
    hasFocus:document.hasFocus() }));
  result.passwordRuntime.focusBeforeBringToFront = await focusSnapshot();
  await page.bringToFront();
  result.passwordRuntime.focusAfterBringToFront = await focusSnapshot();
  result.passwordRuntime.eventsBeforeClick = await eventSnapshot();
  try {
    await clickHandle(page, submit);
    result.passwordRuntime.clickOutcome = 'clicked';
  } catch (error) {
    result.passwordRuntime.clickOutcome = 'failed';
    const safeClass = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_$]{0,80}$/.test(value) ? value : 'Other';
    result.passwordRuntime.clickErrorType = safeClass(error?.name);
    result.passwordRuntime.clickErrorConstructor = safeClass(error?.constructor?.name);
    const safeMessage = typeof error?.message === 'string' ? error.message : '';
    result.passwordRuntime.clickProtocolMethod = safeMessage.match(/Protocol error \(([A-Za-z0-9_.]+)\)/)?.[1] ?? null;
    result.passwordRuntime.clickProtocolReason = /timed.?out|timeout/i.test(safeMessage) ? 'timed-out' :
      /target.*closed|session.*closed/i.test(safeMessage) ? 'target-closed' :
        /execution context.*(destroyed|not found)|context.*lost/i.test(safeMessage) ? 'context-lost' :
          /invalid (parameters|params)|parameter.*invalid/i.test(safeMessage) ? 'invalid-parameters' : 'other';
    result.passwordRuntime.clickErrorFrames = String(error?.stack ?? '').split(/\r?\n/).slice(1, 17).map(line =>
      line.replace(/https?:\/\/[^\s)]+/g, value => {
        try { const url = new URL(value); return `${url.origin}${url.pathname}`; } catch { return '[url]'; }
      }).replace(/file:\/\/[^\s)]+/g, value => {
        try { return new URL(value).pathname; } catch { return '[file]'; }
      }));
    result.passwordRuntime.eventsAfterClick = await eventSnapshot().catch(() => null);
    await delay(300);
    result.passwordRuntime.hint = await page.$eval('#password .msg', element => {
      const text = element.textContent?.trim() ?? '';
      return !text ? 'empty' : /两次输入的新密码不一样/.test(text) ? 'mismatch' :
        text === '服务器出错了，过一会儿再试。' ? 'generic' : 'other';
    }).catch(() => 'unavailable');
    throw Error('password-button-click-failed');
  }
  const passwordResult = (await passwordResponse).response;
  result.passwordRuntime.eventsAfterClick = await eventSnapshot();
  if (!passwordResult) {
    await delay(300);
    result.passwordRuntime.hint = await page.$eval('#password .msg', element => {
      const text = element.textContent?.trim() ?? '';
      return !text ? 'empty' : /两次输入的新密码不一样/.test(text) ? 'mismatch' :
        text === '服务器出错了，过一会儿再试。' ? 'generic' : 'other';
    }).catch(() => 'unavailable');
    throw Error('password-change-response-not-observed-after-short-wait');
  }
  check(passwordResult.status() === 200, checkPrefix ? `${checkPrefix}-actual-password-change-accepted` : 'actual-password-change-request-accepted');
  await page.waitForFunction(() => document.querySelector('#password-event-choices')?.hidden === false, { timeout:TIMEOUT });
  const choiceResponse = page.waitForResponse(response => response.request().method() === 'POST' &&
    /\/password-events\/[^/]+\/choice$/.test(new URL(response.url()).pathname), { timeout:TIMEOUT })
    .then(response => ({ response }), () => ({ response:null }));
  await clickPage(page, '#password-exit-yes');
  const choice = (await choiceResponse).response;
  if (!choice) throw Error('password-event-choice-response-not-observed');
  check(choice.status() === 202, checkPrefix ? `${checkPrefix}-exit-choice-real-pending` : 'exit-choice-awaits-real-service-confirmations');
}
async function closeOwnStageServers() {
  for (const item of stageServers) {
    const closing = item.server.listening ? new Promise(resolve => item.server.close(resolve)) : Promise.resolve();
    for (const socket of item.sockets) socket.destroy();
    await closing; item.server.closeAllConnections?.();
  }
}
async function openProject(page, projectName) {
  currentPhase = 'editor-project-open';
  editorStep = 'editor-open-navigation';
  await bringPageToFront(page, 'open-shared-project');
  await page.goto(`${ORIGIN}/editor/`, { waitUntil:'domcontentloaded' });
  await page.waitForSelector('[data-pc="account-name"]', { visible:true });
  await page.waitForFunction(name => [...document.querySelectorAll('[data-pc="cloud-project-lists"] .sp-account-row')]
    .some(row => row.querySelector('button')?.textContent?.trim() === name), { timeout:TIMEOUT }, projectName);
  const rows = await page.$$('[data-pc="cloud-project-lists"] .sp-account-row'); let clicked = false;
  let consentRead = null;
  for (const row of rows) {
    editorStep = 'editor-project-row-scan';
    const title = await row.$eval('button', element => element.textContent?.trim() ?? '').catch(() => '');
    if (title !== projectName) continue;
    const button = (await row.$$('button'))[0];
    if (!button || await button.evaluate(element => element.disabled)) throw Error('project-open-disabled');
    consentRead = page.waitForResponse(response => response.request().method() === 'GET' &&
      new URL(response.url()).pathname === '/api/account/cloud-agent-consent', { timeout:TIMEOUT })
      .then(async response => ({ kind:'response', accepted:response.ok() &&
        (await response.json().catch(() => null))?.accepted === true })).catch(() => null);
    await clickHandle(page, button); clicked = true; break;
  }
  check(clicked, 'real-project-row-clicked');
  await page.waitForSelector('[data-pc="cloud-project-copy"]', { visible:true });
  const dialog = page.waitForSelector('[data-pc="cloud-agent-consent"]', { visible:true, timeout:TIMEOUT })
    .then(() => ({ kind:'dialog' })).catch(() => null);
  editorStep = 'editor-consent-resolution';
  let consent = await Promise.race([consentRead, dialog]);
  if (consent?.kind === 'response' && !consent.accepted) consent = await dialog;
  if (consent?.kind !== 'response' || !consent.accepted) {
    if (consent?.kind !== 'dialog' && !await page.$('[data-pc="cloud-agent-consent"]'))
      throw Error('consent-read-or-dialog-not-observed');
    const consentDialog = await page.waitForSelector('[data-pc="cloud-agent-consent"]', { visible:true, timeout:TIMEOUT });
    const buttons = await consentDialog.$$('button');
    if (buttons.length < 2) throw Error('consent-buttons-missing');
    const accepted = page.waitForResponse(response => response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/account/cloud-agent-consent', { timeout:TIMEOUT });
    await clickHandle(page, buttons[1]); const outcome = await accepted;
    const recorded = outcome.status() === 200 && (await outcome.json().catch(() => null))?.accepted === true;
    check(recorded, 'provider-recorded-agent-consent');
    await page.waitForFunction(() => ![...document.querySelectorAll('[data-pc="cloud-agent-consent"]')].some(dialog => {
      const style = getComputedStyle(dialog), rect = dialog.getBoundingClientRect();
      return !dialog.hidden && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }), { timeout:TIMEOUT }).catch(() => { throw Error('provider-accepted-consent-but-dialog-remained-visible'); });
  }
  editorStep = 'editor-share-toast-close';
  const toast = '.pc-toast:has([data-pc="cloud-project-copy"])';
  const closeToast = `${toast} button[aria-label="关闭"]`;
  check(Boolean(await page.$(`${toast} [data-pc="cloud-project-copy"]`)), 'project-copy-toast-present');
  await page.waitForFunction(selector => {
    const button = document.querySelector(selector);
    if (!button || button.disabled) return false;
    const rect = button.getBoundingClientRect(), style = getComputedStyle(button);
    if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden') return false;
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return Boolean(hit && (hit === button || button.contains(hit)));
  }, { timeout:TIMEOUT }, closeToast);
  const closeButton = await page.$(closeToast);
  if (!closeButton || !await visibleAndUnobscured(page, closeButton)) throw Error('project-share-toast-close-obscured');
  await clickHandle(page, closeButton);
  await page.waitForFunction(selector => document.querySelector(selector) === null, { timeout:TIMEOUT }, toast);
  editorStep = 'editor-agent-enable';
  const enable = await page.waitForSelector('[data-pc="cloud-agent-enable"]', { visible:true, timeout:TIMEOUT });
  if (await enable.evaluate(element => element.disabled)) throw Error('cloud-agent-enable-disabled');
  const enabledRequest = page.waitForResponse(response => response.request().method() === 'POST' &&
    new URL(response.url()).pathname === '/hosted/shared/account/admin', { timeout:TIMEOUT });
  await clickHandle(page, enable);
  const enabledResponse = await enabledRequest;
  check(enabledResponse.status() >= 200 && enabledResponse.status() < 300, 'real-project-agent-enable-request-accepted');
  await page.waitForSelector('[data-pc="cloud-off"]', { hidden:true, timeout:TIMEOUT });
  check(true, 'account-editor-project-and-agent-ready');
}
async function waitForUserMessage(page, expected) {
  await page.waitForFunction(text => {
    const panel = document.querySelector('[data-pc="cloud-ai-panel"]:not([data-inactive="1"]):not([aria-hidden="true"])');
    const list = panel?.querySelector('.ai-messages'); if (!list) return false;
    return [...list.querySelectorAll('.ai-message.user .ai-message-text')].some(element => {
      const body = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
      const style = getComputedStyle(element), rect = element.getBoundingClientRect(), clip = list.getBoundingClientRect();
      return body.includes(text) && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0 &&
        rect.bottom > clip.top && rect.top < clip.bottom;
    });
  }, { timeout:TIMEOUT }, expected);
}
async function messageGone(page, expected) {
  await page.waitForFunction(text => {
    const panel = document.querySelector('[data-pc="cloud-ai-panel"]:not([data-inactive="1"]):not([aria-hidden="true"])');
    if (!panel) return false;
    return ![...panel.querySelectorAll('.ai-message.user .ai-message-text')].some(element =>
      (element.textContent ?? '').replace(/\s+/g, ' ').trim().includes(text));
  }, { timeout:TIMEOUT, polling:100 }, expected);
}
async function revokedConversationContentGone(page, expectedText) {
  await page.waitForFunction(text => {
    const panel = document.querySelector('[data-pc="cloud-ai-panel"]:not([data-inactive="1"]):not([aria-hidden="true"])');
    if (!panel) return false;
    const bodyRemains = [...panel.querySelectorAll('.ai-message.user .ai-message-text')]
      .some(element => (element.textContent ?? '').replace(/\s+/g, ' ').trim().includes(text));
    const queueCount = panel.querySelectorAll('.ai-queue-item[data-message-id]').length;
    return !bodyRemains && queueCount === 0;
  }, { timeout:TIMEOUT }, expectedText);
}
async function requestHistoryReadAfterClick(page) {
  const button = await page.$('[data-pc="ai-history"]');
  if (!button || !await visibleAndUnobscured(page, button) || await button.evaluate(element => element.disabled))
    return { action:'blocked-by-current-ui', status:null };
  const responsePromise = new Promise(resolve => {
    const pending = new WeakSet();
    const finish = value => { clearTimeout(timer); page.off('request', onRequest); page.off('response', onResponse); resolve(value); };
    const timer = setTimeout(() => finish(null), 5000);
    const onRequest = request => {
      try {
        const url = new URL(request.url());
        if ((request.method() === 'GET' && url.pathname === '/agent/v1/conversations') ||
            (request.method() === 'POST' && url.pathname === '/hosted/shared/account/session')) pending.add(request);
      } catch { /* Ignore non-URL request data. */ }
    };
    const onResponse = response => {
      if (!pending.has(response.request())) return;
      const url = new URL(response.url());
      finish({ endpoint:url.pathname === '/agent/v1/conversations' ? 'agent-history' : 'project-session',
        status:response.status(), denied:response.status() === 401 || response.status() === 403 });
    };
    page.on('request', onRequest); page.on('response', onResponse);
  });
  await clickHandle(page, button);
  const clickResult = await responsePromise;
  if (clickResult) return { action:'clicked', ...clickResult };
  return { action:'clicked-no-authorization-response', status:null, denied:false };
}

await fs.mkdir(OUT, { recursive:true, mode:0o700 });
const profile = path.join(OUT, 'browser-profile');
const started = Date.now();
try {
  for (const port of PORTS) check(await portIsFree(port), `port-${port}-available`);
  for (const file of [path.join(DIST, 'index.html'), path.join(DIST, 'stage.html'), path.join(SITE, 'account.html'), path.join(SITE, 'login.html'), path.join(SITE, 'reset.html')]) await fs.access(file);
  fixture = await startAccountPasswordUserFixture({ publicHandler:siteHandler(), diagnostic:entry => {
    if (entry.cleanupComplete === true) result.fixtureCleanup = { childClosed:entry.childClosed === true,
      closeFailureCount:entry.closeFailureCount };
  } });
  check(fixture.accounts?.length === 3 && fixture.readControlReady, 'real-provider-doc-agent-read-control-fixture-ready');
  const readIdentity = fixture.agentInstanceReadiness ?? null;
  result.readControl = { connected:fixture.readControlReady === true,
    registeredInstanceReady:readIdentity?.registered === true, executorMounted:readIdentity?.executorMounted === true };
  result.readControl.stateAtStart = fixture.readControlState();
  result.agentHttpDiagnostics = fixture.agentHttpDiagnostics;
  result.edgeDiagnostics = fixture.edgeDiagnostics;
  result.readControlDiagnostics = fixture.readControlDiagnostics;
  result.expectedProjectMatch = null;
  for (const port of [6688, 6689]) await startStage(port);
  browser = await puppeteer.launch({ executablePath:await puppeteer.executablePath(), headless:true, pipe:true, acceptInsecureCerts:true,
    userDataDir:profile, defaultViewport:{ width:1440, height:1000 }, protocolTimeout:TIMEOUT,
    args:[...PROBE_CHROME_ARGS, '--ignore-certificate-errors',
      '--host-resolver-rules=MAP s1.pc.localhost 127.0.0.1,MAP s2.pc.localhost 127.0.0.1',
      '--no-first-run', '--no-default-browser-check', '--force-device-scale-factor=1', '--mute-audio'] });
  const contextsByRole = await Promise.all(['initiator', 'other-one', 'other-two'].map(() => browser.createBrowserContext()));
  contexts.push(...contextsByRole);
  const sitePages = await Promise.all(contextsByRole.map((context, index) => newPage(context, ['initiator', 'other-one', 'other-two'][index])));
  const account = fixture.accounts[0];
  for (let index = 0; index < sitePages.length; index++) await loginWebsite(sitePages[index], account, ['initiator', 'other-one', 'other-two'][index]);

  if (SITE_FORM_ONLY) {
    result.mode = 'site-password-form-smoke';
    currentPhase = 'site-password-form-preflight';
    const editor = await newPage(contextsByRole[0], 'online-editor');
    await editor.goto(`${ORIGIN}/editor/`, { waitUntil:'domcontentloaded' });
    await editor.waitForSelector('[data-pc="account-name"]', { visible:true });
    check(result.network.some(entry => entry.page === 'online-editor' && entry.method === 'POST' &&
      entry.path === '/api/account/editor/session' && entry.status === 200), 'actual-editor-login-created-before-password-change');
    await changePasswordThroughWebsite(sitePages[0], account, 'site-smoke');
    await sitePages[0].waitForSelector('#acc-name', { visible:true });
    check(new URL(sitePages[0].url()).pathname === '/account', 'site-smoke-initiating-session-remains');
    await Promise.all([sitePages[1], sitePages[2]].map(async (page, index) => {
      await page.goto(`${ORIGIN}/account`, { waitUntil:'domcontentloaded' });
      await page.waitForFunction(() => new URL(location.href).pathname === '/login', { timeout:TIMEOUT });
      check(new URL(page.url()).pathname === '/login', `site-smoke-other-session-${index + 1}-revoked`);
    }));
    const verificationContext = await browser.createBrowserContext(); contexts.push(verificationContext);
    const verificationPage = await newPage(verificationContext, 'password-login-verification');
    await verificationPage.goto(`${ORIGIN}/login`, { waitUntil:'domcontentloaded' });
    await fill(verificationPage, '#login input[name="name"]', account.name);
    await fill(verificationPage, '#login input[name="password"]', account.password);
    const oldLogin = verificationPage.waitForResponse(response => response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/account/login', { timeout:TIMEOUT })
      .then(response => ({ response }), () => ({ response:null }));
    await clickPage(verificationPage, '#login button[type="submit"]');
    const oldLoginResponse = (await oldLogin).response;
    check(oldLoginResponse?.status() === 401, 'site-smoke-old-password-rejected');
    await fill(verificationPage, '#login input[name="password"]', account.nextPassword);
    await Promise.all([verificationPage.waitForNavigation({ waitUntil:'domcontentloaded' }),
      clickPage(verificationPage, '#login button[type="submit"]')]);
    check(new URL(verificationPage.url()).pathname === '/account', 'site-smoke-new-password-login-succeeds');
    await safeShot(sitePages[0], 'site-password-smoke-event');
    result.completed = true;
  } else {
  const editor = await newPage(contextsByRole[0], 'online-editor');
  await openProject(editor, 'Shared dual account project');
  check(result.projectControlRequests?.some(entry => entry.projectIdMatchesExpected && entry.enablesAgent),
    'actual-agent-enable-targets-current-project');
  await sitePages[0].goto(`${ORIGIN}/account`, { waitUntil:'domcontentloaded' });
  await sitePages[0].waitForSelector('#acc-name', { visible:true });
  result.accountSessionValidAfterAgentEnable = await sitePages[0].$eval('#acc-name', element => element.textContent?.trim()) === account.name;
  check(result.accountSessionValidAfterAgentEnable, 'website-session-still-valid-after-agent-enable');
  await safeShot(editor, '04-editor-before-message');
  const prompt = `Password-revocation user-path ${randomUUID().slice(0, 8)}; remain queued, do not run.`;
  currentPhase = 'queue-real-message-without-executor';
  editorStep = 'editor-send-plaintext-user-message';
  const messageResponse = editor.waitForResponse(response => response.request().method() === 'POST' &&
    /\/agent\/v1\/conversations\/[^/]+\/messages$/.test(new URL(response.url()).pathname), { timeout:TIMEOUT });
  await fill(editor, '[data-pc="cloud-ai-panel"] [data-pc="ai-input"]', prompt);
  await editor.keyboard.press('Enter');
  const accepted = await messageResponse;
  check(accepted.status() === 202, 'real-user-message-accepted-as-queued');
  await waitForUserMessage(editor, prompt);
  check(true, 'real-sse-plaintext-user-message-body-visible');
  await editor.waitForSelector('[data-pc="cloud-queue"] li[data-message-id]', { visible:true, timeout:TIMEOUT });
  const queueState = await editor.$eval('[data-pc="cloud-queue"]', element => ({ text:element.textContent ?? '', count:element.querySelectorAll('li[data-message-id]').length }));
  check(queueState.count === 1 && queueState.text.includes('等待执行服务'), 'one-real-queued-message-no-executor-active');
  const conversationId = await editor.evaluate(() => window.__pcCloud?.main?.conversationId?.() ?? null);
  check(typeof conversationId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(conversationId), 'conversation-id-observed-shape-only');
  targetConversationId = conversationId;
  result.readControl.stateAfterQueuedMessage = fixture.readControlState();
  for (const stream of result.eventStreams) stream.conversationMatch = eventConversationIds.get(stream) === conversationId;
  await safeShot(editor, '05-editor-real-queued-message');

  currentPhase = 'password-change-and-exit';
  editorStep = 'website-change-password';
  result.passwordRuntime = {};
  result.passwordRuntime.focusBeforeBringToFront = await sitePages[0].evaluate(() => ({
    visibilityState:document.visibilityState, hasFocus:document.hasFocus() }));
  await sitePages[0].bringToFront();
  result.passwordRuntime.focusAfterBringToFront = await sitePages[0].evaluate(() => ({
    visibilityState:document.visibilityState, hasFocus:document.hasFocus() }));
  await sitePages[0].goto(`${ORIGIN}/account`, { waitUntil:'domcontentloaded' });
  await sitePages[0].waitForSelector('#password input[name="current"]', { visible:true });
  await fill(sitePages[0], '#password input[name="current"]', account.password);
  await fill(sitePages[0], '#password input[name="next"]', account.nextPassword);
  await fill(sitePages[0], '#password input[name="again"]', account.nextPassword);
  result.passwordFormState = await sitePages[0].$eval('#password', form => {
    const current = form.querySelector('[name="current"]'), next = form.querySelector('[name="next"]'), again = form.querySelector('[name="again"]');
    const submit = form.querySelector('button[type="submit"]');
    return { valid:form.checkValidity(), currentPresent:Boolean(current?.value), nextPresent:Boolean(next?.value),
      repeatedMatches:Boolean(next?.value) && next.value === again?.value, submitEnabled:Boolean(submit && !submit.disabled) };
  });
  check(result.passwordFormState.valid && result.passwordFormState.currentPresent && result.passwordFormState.nextPresent &&
    result.passwordFormState.repeatedMatches && result.passwordFormState.submitEnabled, 'password-change-form-valid-before-submit');
  const passwordResponse = sitePages[0].waitForResponse(response => response.request().method() === 'POST' &&
    new URL(response.url()).pathname === '/api/account/password', { timeout:TIMEOUT });
  await clickPage(sitePages[0], '#password button[type="submit"]');
  const passwordResult = await passwordResponse;
  check(passwordResult.status() === 200, 'actual-password-change-request-accepted');
  await sitePages[0].waitForFunction(() => document.querySelector('#password-event-choices')?.hidden === false, { timeout:TIMEOUT });
  await sitePages[0].waitForFunction(() => document.querySelector('#password-exit-yes')?.getClientRects().length > 0, { timeout:TIMEOUT });
  const choiceResponse = sitePages[0].waitForResponse(response => response.request().method() === 'POST' &&
    /\/password-events\/[^/]+\/choice$/.test(new URL(response.url()).pathname), { timeout:TIMEOUT });
  await clickPage(sitePages[0], '#password-exit-yes');
  const choice = await choiceResponse;
  check(choice.status() === 202, 'exit-choice-awaits-real-service-confirmations');
  await sitePages[0].waitForFunction(() => document.querySelector('#acc-name')?.textContent?.trim().length > 0, { timeout:TIMEOUT });
  check(new URL(sitePages[0].url()).pathname === '/account', 'initiating-site-session-remains');
  await Promise.all([sitePages[1], sitePages[2]].map(async (page, index) => {
    await page.goto(`${ORIGIN}/account`, { waitUntil:'domcontentloaded' });
    await page.waitForFunction(() => new URL(location.href).pathname === '/login', { timeout:TIMEOUT });
    check(new URL(page.url()).pathname === '/login', `other-site-session-${index + 1}-logged-out`);
  }));
  editorStep = 'editor-bring-to-front-and-wait-for-real-read-revocation';
  result.readRevocationWait = { focusBefore:await editor.evaluate(() => ({ visibilityState:document.visibilityState, hasFocus:document.hasFocus() })) };
  await editor.bringToFront();
  result.readRevocationWait.focusAfter = await editor.evaluate(() => ({ visibilityState:document.visibilityState, hasFocus:document.hasFocus() }));
  result.readRevocationWait.domBeforeWait = await editor.evaluate(text => {
    const panel = document.querySelector('[data-pc="cloud-ai-panel"]');
    const messages = [...(panel?.querySelectorAll('.ai-message.user .ai-message-text') ?? [])];
    return { expectedMessageRemains:messages.some(element => (element.textContent ?? '').replace(/\s+/g, ' ').trim().includes(text)),
      userMessageCount:panel?.querySelectorAll('.ai-message.user').length ?? 0,
      queueItemCount:panel?.querySelectorAll('.ai-queue-item[data-message-id]').length ?? 0,
      permissionLoadingCount:document.querySelectorAll('[data-pc="cloud-permission-loading"]').length };
  }, prompt);
  await messageGone(editor, prompt);
  check(true, 'online-editor-real-read-body-cleared-after-revocation');
  await waitForControlClosure(result.eventStreams);
  check(result.eventStreams.some(stream => stream.conversationMatch === true && stream.status === 200 && stream.lifecycle !== 'open'), 'real-old-conversation-event-stream-closed');
  editorStep = 'editor-revoked-content-cleared';
  await revokedConversationContentGone(editor, prompt);
  result.revokedContentUi = await editor.$eval('[data-pc="cloud-ai-panel"]', panel => ({
    userMessageCount:panel.querySelectorAll('.ai-message.user').length,
    queueItemCount:panel.querySelectorAll('.ai-queue-item[data-message-id]').length,
  }));
  check(result.revokedContentUi.userMessageCount === 0 && result.revokedContentUi.queueItemCount === 0,
    'editor-plaintext-message-and-queue-clear-naturally-after-revocation');
  result.attachmentPath = 'not-tested: mounted account attachment authority is absent; no upload was attempted';
  editorStep = 'editor-history-read-after-revocation';
  result.deniedHistoryRead = await requestHistoryReadAfterClick(editor);
  if (result.deniedHistoryRead.denied !== true && realAgentDelegationTicket && result.deniedHistoryRead.action !== 'clicked') {
    result.deniedHistoryRead.oldIssuedTicketRequest = await editor.evaluate(async ticket => {
      const response = await fetch('/agent/v1/conversations', { headers:{ Authorization:`Bearer ${ticket}` },
        credentials:'omit', cache:'no-store' });
      let code = null;
      if (response.status >= 400) {
        const body = await response.json().catch(() => null);
        code = ['disabled','unauthorized','forbidden','account-required','consent-required','not-found','busy','unavailable'].includes(body?.code)
          ? body.code : body?.code == null ? null : 'other';
      }
      return { status:response.status, denied:response.status === 401 || response.status === 403, code };
    }, realAgentDelegationTicket);
    result.deniedHistoryRead.denied = result.deniedHistoryRead.oldIssuedTicketRequest.denied;
  }
  check(result.deniedHistoryRead.denied === true, 'subsequent-real-history-read-denied-after-revocation');
  const eventStatus = await sitePages[0].evaluate(async () => {
    const node = document.querySelector('#password-event-status');
    const eventId = document.querySelector('#password-event')?.dataset.eventId;
    const response = await fetch(`/api/account/password-events/${encodeURIComponent(eventId)}`, { credentials:'same-origin' });
    const body = await response.json();
    return { visible:!!node && node.getClientRects().length > 0, textCode:node?.textContent?.includes('正在退出') ? 'revoking' : 'other',
      logoutState:body.logout?.state ?? null };
  });
  check(eventStatus.textCode === 'revoking' && eventStatus.logoutState !== 'complete', 'ui-honestly-stays-pending-without-all-service-acks');
  currentPhase = 'password-change-pending-screenshot';
  editorStep = 'website-password-pending-screenshot';
  await safeShot(sitePages[0], '06-password-changed-pending');

  currentPhase = 'password-reset-with-provider-issued-code';
  editorStep = 'reset-bind-email';
  result.resetPageFocusBeforeBringToFront = await sitePages[0].evaluate(() => ({
    visibilityState:document.visibilityState, hasFocus:document.hasFocus() }));
  await sitePages[0].bringToFront();
  result.resetPageFocusAfterBringToFront = await sitePages[0].evaluate(() => ({
    visibilityState:document.visibilityState, hasFocus:document.hasFocus() }));
  const email = `password-path-${randomUUID().replaceAll('-', '').slice(0, 18)}@example.invalid`;
  // The first field is the new-address form on the actual VisuHive account page.
  await fill(sitePages[0], '#email-start input[name="email"]', email);
  await fill(sitePages[0], '#email-start input[name="password"]', account.nextPassword);
  const bindResponse = sitePages[0].waitForResponse(response => response.request().method() === 'POST' &&
    new URL(response.url()).pathname === '/api/account/email/start', { timeout:TIMEOUT });
  await clickPage(sitePages[0], '#email-start button[type="submit"]');
  check((await bindResponse).status() === 200, 'real-email-binding-otp-request-accepted');
  const bindCode = fixture.takeIssuedCode(email, 'bind');
  check(/^\d{6}$/.test(bindCode ?? ''), 'provider-generated-bind-code-captured-in-private-memory');
  await fill(sitePages[0], '#email-confirm input[name="code"]', bindCode);
  await clickPage(sitePages[0], '#email-confirm button[type="submit"]');
  await sitePages[0].waitForFunction(() => document.querySelector('#email-done')?.textContent?.includes('邮箱已绑定'), { timeout:TIMEOUT });
  await sitePages[0].goto(`${ORIGIN}/reset`, { waitUntil:'domcontentloaded' });
  await fill(sitePages[0], '#reset-start input[name="name"]', account.name);
  const resetStartResponse = sitePages[0].waitForResponse(response => response.request().method() === 'POST' &&
    new URL(response.url()).pathname === '/api/account/reset/start', { timeout:TIMEOUT });
  await clickPage(sitePages[0], '#reset-start button[type="submit"]');
  check((await resetStartResponse).status() === 200, 'real-reset-request-accepted');
  const resetCode = fixture.takeIssuedCode(email, 'reset');
  check(/^\d{6}$/.test(resetCode ?? ''), 'provider-generated-reset-code-captured-in-private-memory');
  await fill(sitePages[0], '#reset-confirm input[name="code"]', resetCode);
  await fill(sitePages[0], '#reset-confirm input[name="password"]', account.resetPassword);
  await fill(sitePages[0], '#reset-confirm input[name="again"]', account.resetPassword);
  const resetNavigation = sitePages[0].waitForNavigation({ waitUntil:'domcontentloaded' });
  const resetConfirmResponse = sitePages[0].waitForResponse(response => response.request().method() === 'POST' &&
    new URL(response.url()).pathname === '/api/account/reset/confirm', { timeout:TIMEOUT });
  await clickPage(sitePages[0], '#reset-confirm button[type="submit"]');
  const [resetResponse] = await Promise.all([resetConfirmResponse, resetNavigation]);
  check(resetResponse.status() === 200, 'actual-reset-confirmation-accepted');
  await sitePages[0].waitForSelector('#password-event-choices', { visible:true, timeout:TIMEOUT });
  const resetChoiceResponse = sitePages[0].waitForResponse(response => response.request().method() === 'POST' &&
    /\/password-events\/[^/]+\/choice$/.test(new URL(response.url()).pathname), { timeout:TIMEOUT });
  await clickPage(sitePages[0], '#password-exit-yes');
  const resetChoice = await resetChoiceResponse;
  check(resetChoice.status() === 202, 'reset-exit-choice-awaits-real-service-confirmations');
  check(true, 'reset-flow-used-provider-issued-otp-and-private-mail-callback-no-external-email');
  await safeShot(sitePages[0], '07-reset-pending');
  result.completed = true;
  }
} catch (error) {
  const safeFailure = new Set(['provider-accepted-consent-but-dialog-remained-visible','consent-read-or-dialog-not-observed',
    'project-open-disabled','cloud-agent-enable-disabled','consent-buttons-missing',
    'password-change-response-not-observed-after-short-wait','password-button-click-failed']);
  result.failure = { phase:currentPhase, step:editorStep,
    check:error?.check ?? (safeFailure.has(String(error?.message)) ? String(error.message) : 'unclassified'),
    action:safeAction, ...safeErrorDetails(error) };
  if (fixture) {
    try { result.readControl.stateAtFailure = fixture.readControlState(); } catch { result.readControl.stateAtFailure = { unavailable:true }; }
  }
  process.exitCode = 1;
  for (const page of pages) {
    if (page.isClosed()) continue;
    if (page.label === 'online-editor') {
      try { result.failure.editorState = await page.evaluate(() => {
        const visible = selector => [...document.querySelectorAll(selector)].filter(element => {
          const style = getComputedStyle(element), rect = element.getBoundingClientRect();
          return !element.hidden && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        }).length;
        return { pathname:location.pathname, consentCount:document.querySelectorAll('[data-pc="cloud-agent-consent"]').length,
          visibleConsentCount:visible('[data-pc="cloud-agent-consent"]'), enableButtonCount:document.querySelectorAll('[data-pc="cloud-agent-enable"]').length,
          visibleEnableButtonCount:visible('[data-pc="cloud-agent-enable"]'), offCount:visible('[data-pc="cloud-off"]'),
          permissionLoadingCount:visible('[data-pc="cloud-permission-loading"]') };
      }); } catch { result.failure.editorState = { unavailable:true }; }
    }
    try { await safeShot(page, `failure-${pages.indexOf(page) + 1}`); } catch { /* Preserve original failure and still close owned resources. */ }
  }
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  if (browser) {
    try { await browser.close(); } catch { result.cleanup.browserCloseFailed = true; }
    result.cleanup.browserClosed = browser.process()?.exitCode !== null || browser.process()?.signalCode !== null;
  } else result.cleanup.browserClosed = true;
  await closeOwnStageServers();
  result.cleanup.stages = stageServers.map(entry => ({ port:entry.port, listening:entry.server.listening, sockets:entry.sockets.size }));
  if (fixture) {
    try { const state = await fixture.close(); result.cleanup.fixtureClosed = state.closed === true; result.cleanup.assetChildClosed = state.childClosed === true; }
    catch { result.cleanup.fixtureClosed = false; result.cleanup.assetChildClosed = false; }
  }
  result.cleanup.portsFree = (await Promise.all(PORTS.map(portIsFree))).every(Boolean);
  if (result.cleanup.browserClosed) await fs.rm(profile, { recursive:true, force:true });
  result.cleanup.profileRemoved = !fsSync.existsSync(profile);
  result.sourceAfter = SOURCE(); result.elapsedMs = Date.now() - started;
  realAgentDelegationTicket = null;
  result.summary = { passed:result.checks.filter(item => item.pass).length, failed:result.checks.filter(item => !item.pass).length,
    completed:result.completed, sourceUnchanged:result.sourceBefore === result.sourceAfter };
  if (!result.completed || !result.summary.sourceUnchanged || result.cleanup.browserClosed !== true || result.cleanup.fixtureClosed !== true ||
      result.cleanup.assetChildClosed !== true || result.cleanup.portsFree !== true || result.cleanup.stages.some(item => item.listening || item.sockets)) process.exitCode = 1;
  await fs.writeFile(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2), { mode:0o600 });
  process.stdout.write(JSON.stringify({ summary:result.summary, failure:result.failure ?? null, cleanup:result.cleanup, out:OUT }) + '\n');
}

async function waitForControlClosure(streams) {
  const end = Date.now() + TIMEOUT;
  while (Date.now() < end) {
    if (streams.some(stream => stream.conversationMatch === true && stream.status === 200 && stream.lifecycle !== 'open')) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const error = Error('event-stream-not-closed'); error.check = 'revoked-conversation-event-stream-closed'; throw error;
}
