// First import protects user directories and the shared port file before native imports.
import '../lib/no-user-dirs.mjs';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { publicOptions, testIdentities, projectFromVisibleLink, PUBLIC_ORIGIN, NATIVE_ORIGIN } from './lib/account-public-path.mjs';

/**
 * Root-run production probe. Default dry-preflight has no network or browser.
 * --run-public explicitly creates two own-test accounts and real projects using UI.
 * No fixture server, request interception, fetch/native/ready mock, TLS bypass,
 * clipboard reading or production deletion is provided.
 *
 * node scripts/probes/account-public-user-pages-probe.mjs --dry-preflight --out <new TMP child>
 * node scripts/probes/account-public-user-pages-probe.mjs --run-public --out <new TMP child>
 * Optional root-built shell: --desktop-exe <TMP .exe> --desktop-sha256 <root exact SHA256>
 *   --desktop-source-root <TMP compiled repository> --desktop-profile-root <new TMP child>
 * Root owns prestarted Vite 6500/6501/6502 and main-only 6500 test capability.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const options = publicOptions(process.argv.slice(2));
const ORIGIN = PUBLIC_ORIGIN, DESKTOP_ORIGIN = NATIVE_ORIGIN, OUT = options.out;
const DESKTOP_EXE = options.desktop, DESKTOP_PROFILE = options.profile;
let STAGES = [];
const TIMEOUT = 60_000;
const source = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd:ROOT, windowsHide:true, encoding:'utf8' }).trim();
const result = { mode:options.run ? 'public-run' : 'dry-preflight', sourceBefore:source(), checks:[], network:[], websocket:[], resources:[], screenshots:[], stageDocuments:[], phase:'preflight', desktop:'not-run', cleanup:{} };
let browser, browserPid, native, nativeAttempt = 0, nativeProfileOwned = false;
const contexts = [], pages = [], responseTasks = new Set(), networkObservers = [];
const nativeEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PROMPTCUT_ACCOUNT_TEST_/i.test(key) && !/^WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS$/i.test(key)));
function assert(ok, name) { result.checks.push({ check:name, ok:Boolean(ok) }); if (!ok) { const error = new Error(name); error.probeCheck = name; throw error; } }
async function getChromePath() { const executable = await puppeteer.executablePath(); await fs.access(executable); return executable; }
async function newPage(context, label) { return observePage(await context.newPage(), label); }
async function nativeBuildPreflight() {
  if (!DESKTOP_EXE) return;
  if (process.platform !== 'win32') throw new Error('native-public-path-requires-windows');
  assert(createHash('sha256').update(await fs.readFile(DESKTOP_EXE)).digest('hex') === options.sha, 'native-exact-root-build-sha');
  const relativeFiles = ['desktop/src-tauri/src/lib.rs', 'desktop/src-tauri/src/account_vault.rs', 'desktop/src-tauri/build.rs', 'desktop/src-tauri/Cargo.toml', 'desktop/src-tauri/Cargo.lock'];
  for (const relative of relativeFiles) {
    const [current, compiled] = await Promise.all([fs.readFile(path.join(ROOT, relative)), fs.readFile(path.join(options.nativeSource, relative))]);
    assert(current.equals(compiled), `native-source-bytes-${path.basename(relative)}`);
  }
  assert(!fsSync.existsSync(DESKTOP_PROFILE), 'native-profile-must-be-new-owned-child');
}

// Reused validated real UI/IPC actions follow. Their origin is fixed public and
// all native port arguments are restricted to this task's lease.
async function observePage(page, label) {
  pages.push(page);
  page.setDefaultTimeout(TIMEOUT); page.setDefaultNavigationTimeout(TIMEOUT);
  page.safeResponses = { projects: null, create: null, join: null };
  page.on('pageerror', error => { result.network.push({ page: label, kind:'pageerror', name:['Error', 'TypeError', 'RangeError', 'SyntaxError'].includes(error.name) ? error.name : 'Error' }); });
  const resourcePath = request => {
    const url = new URL(request.url());
    if (![ORIGIN, ...STAGES].includes(url.origin) || !['document', 'stylesheet', 'script', 'font', 'image'].includes(request.resourceType())) return null;
    return url.pathname.startsWith('/editor/') || url.pathname.startsWith('/assets/') ? url.pathname : null;
  };
  page.on('requestfailed', request => {
    const pathname = resourcePath(request);
    if (!pathname) return;
    const error = request.failure()?.errorText;
    result.resources.push({ page:label, kind:'requestfailed', path:pathname, type:request.resourceType(),
      name:typeof error === 'string' && /^net::ERR_[A-Z0-9_]+$/.test(error) ? error : 'request-failed' });
  });
  page.on('response', response => {
    const actualUrl = new URL(response.url());
    if (actualUrl.pathname === '/editor/stage.html' && ['http:', 'https:'].includes(actualUrl.protocol)) result.stageDocuments.push({ origin:actualUrl.origin, method:response.request().method(), status:response.status() });
    const pathname = resourcePath(response.request());
    if (pathname) {
      const mime = response.headers()['content-type'];
      result.resources.push({ page:label, kind:'response', path:pathname, type:response.request().resourceType(), status:response.status(),
        mime:typeof mime === 'string' && /^[a-z0-9.+-]+\/[a-z0-9.+-]+(?:;\s*charset=[a-z0-9_-]+)?$/i.test(mime) ? mime : mime === undefined ? 'missing' : 'unexpected-content-type' });
    }
    const url = new URL(response.url());
    if (![ORIGIN, ...STAGES].includes(url.origin)) return;
    if (!url.pathname.startsWith('/api/account') && !url.pathname.startsWith('/hosted/')) return;
    result.network.push({ page: label, method: response.request().method(), path: url.pathname, status: response.status() });
    if (url.pathname === '/api/account/register') {
      const accountTask = response.json().then(body => {
        const id = body.account?.id;
        if (/^acc_[0-9a-f]{24}$/.test(id ?? '')) result.ownedAccounts.push({ page:label, accountId:id });
      }).catch(() => {}).finally(() => responseTasks.delete(accountTask));
      responseTasks.add(accountTask);
    }
    const key = url.pathname === '/api/account/projects' ? 'projects' : url.pathname === '/hosted/shared/account/create' ? 'create' : url.pathname === '/hosted/shared/account/join' ? 'join' : null;
    if (!key || !response.ok()) return;
    const task = response.json().then(body => {
      // Discard all ticket, account, cookie, CSRF and credential fields immediately.
      page.safeResponses[key] = key === 'projects' ? {
        owned: (body.owned ?? []).map(p => ({ projectId:p.projectId, name:p.name })),
        joined: (body.joined ?? []).map(p => ({ projectId:p.projectId, name:p.name })),
      } : { projectId: body.projectId ?? body.membership?.projectId };
    }).catch(() => {}).finally(() => responseTasks.delete(task));
    responseTasks.add(task);
  });
  // CDP observes the real handshake and bytes without replacing WebSocket or
  // reading its credential-bearing URL/query, headers, protocols or full frames.
  const cdp = await page.createCDPSession(); networkObservers.push(cdp);
  const sockets = new Map();
  cdp.on('Network.webSocketCreated', ({ requestId, url }) => {
    let parsed;
    try { parsed = new URL(url); } catch { return; }
    if (parsed.origin !== ORIGIN.replace(/^https:/, 'wss:') || parsed.pathname !== '/hosted/') return;
    sockets.set(requestId, { path: parsed.pathname });
    result.websocket.push({ page: label, kind: 'created', path: parsed.pathname });
  });
  const record = (requestId, entry) => {
    const socket = sockets.get(requestId);
    if (socket) result.websocket.push({ page: label, path: socket.path, ...entry });
  };
  cdp.on('Network.webSocketHandshakeResponseReceived', ({ requestId, response }) => {
    record(requestId, { kind: 'handshake', status: response.status });
  });
  const frame = (direction, { requestId, response }) => {
    if (!sockets.has(requestId)) return;
    if (response.opcode === 8) {
      // CDP binary payloads are base64. Retain only the two-byte close code;
      // never retain the close reason or the payload itself.
      const bytes = Buffer.from(response.payloadData, 'base64');
      record(requestId, { kind: 'close-frame', direction, code: bytes.length >= 2 ? bytes.readUInt16BE(0) : null });
      return;
    }
    if (response.opcode !== 1) return;
    let type;
    try { type = JSON.parse(response.payloadData).type; } catch { return; }
    if (typeof type === 'string' && /^[a-zA-Z][a-zA-Z0-9_.:-]{0,99}$/.test(type)) record(requestId, { kind: 'message', direction, type });
  };
  cdp.on('Network.webSocketFrameReceived', event => frame('received', event));
  cdp.on('Network.webSocketFrameSent', event => frame('sent', event));
  cdp.on('Network.webSocketFrameError', ({ requestId }) => record(requestId, { kind: 'frame-error' }));
  cdp.on('Network.webSocketClosed', ({ requestId }) => { record(requestId, { kind: 'closed' }); sockets.delete(requestId); });
  await cdp.send('Network.enable');
  return page;
}
async function type(page, selector, value) {
  const input = await page.waitForSelector(selector, { visible:true });
  await input.focus();
  await page.keyboard.down('Control');
  try { await page.keyboard.press('A'); } finally { await page.keyboard.up('Control'); }
  await page.keyboard.press('Backspace'); await input.type(value);
}
async function safeShot(page, label) {
  for (const input of await page.$$('input[type="password"]')) {
    const visible = await input.evaluate(el => el.getClientRects().length > 0);
    if (visible) { await input.click({ clickCount:3 }); await page.keyboard.press('Backspace'); }
  }
  const safe = await page.$$eval('input[type="password"]', nodes => nodes.every(el => !el.getClientRects().length || el.value === ''));
  if (!safe) throw new Error('password-screenshot-blocked');
  const name = `${label}.png`; await page.screenshot({ path:path.join(OUT, name), fullPage:true }); result.screenshots.push(name);
}
async function loginEditor(page, account) {
  const parentPhase = result.phase;
  const step = async (stage, action) => {
    result.loginStage = stage; result.loginSteps ??= [];
    result.loginSteps.push({ phase:parentPhase, stage, state:'started', ui:await loginUiState(page) });
    try {
      await action();
      result.loginSteps.push({ phase:parentPhase, stage, state:'completed', ui:await loginUiState(page) });
    } catch (error) {
      result.loginSteps.push({ phase:parentPhase, stage, state:'failed', ui:await loginUiState(page) });
      throw error;
    }
  };
  await step('goto', () => page.goto(DESKTOP_EXE && page === native?.page ? `${DESKTOP_ORIGIN}/` : `${ORIGIN}/editor/`, { waitUntil:'domcontentloaded' }));
  await step('username-input', () => type(page, '[data-pc="account-projects"] input[name="username"]', account.name));
  await step('password-input', () => type(page, '[data-pc="account-projects"] input[name="password"]', account.password));
  await step('submit', async () => {
    await page.waitForFunction(() => {
      const button = document.querySelector('[data-pc="account-projects"] form button.sp-primary-btn');
      return Boolean(button && !button.disabled);
    });
    result.loginSteps.push({ phase:parentPhase, stage:'submit-ready', state:'completed', ui:await loginUiState(page) });
    await page.click('[data-pc="account-projects"] form button.sp-primary-btn');
  });
  await step('account-name', async () => {
    await page.waitForSelector('[data-pc="account-name"]', { visible:true });
    assert((await page.$eval('[data-pc="account-name"]', el => el.textContent)).includes(account.name), 'editor-authenticated-account');
  });
}
async function loginUiState(page) {
  return page.evaluate(() => {
    const visible = selector => Boolean(document.querySelector(selector)?.getClientRects().length);
    const button = document.querySelector('[data-pc="account-projects"] form button.sp-primary-btn');
    const error = document.querySelector('[data-pc="account-error"]');
    // Exact known product messages map to fixed codes; unknown DOM text is never
    // copied. No input value, account-name text or credential is inspected here.
    const known = new Map([
      ['请先登录账号。', 'login-required'], ['登录已失效，请重新登录。', 'credential-revoked'],
      ['账号或密码不正确。', 'bad-login'], ['这个项目名已被使用，请换一个名字。', 'name-taken'],
      ['你已被禁止加入这个项目。', 'banned'], ['你不在这个项目的成员名单中。', 'not-listed'],
      ['这个云端项目已不存在。', 'project-gone'], ['素材服务暂时不可用，项目尚不能进入，请稍后重试。', 'asset-unavailable'],
      ['项目会话暂时不可用，请稍后重试。', 'session-unavailable'], ['请使用桌面版登录，或在官网打开在线编辑器。', 'desktop-bridge-unavailable'],
      ['暂时无法获取云端项目列表，请稍后重试。', 'projects-unavailable'], ['云端服务暂时不可用，请稍后重试。', 'service-unavailable'],
      ['没有访问这个项目的权限。', 'forbidden'], ['连接云端失败，请检查网络后重试。', 'network'],
      ['无法取得当前设备身份，请重试。', 'device-unavailable'], ['登录恢复失败，请重新登录。', 'restore-failed'],
      ['账号入口初始化失败。', 'initialization-failed'], ['请求失败，请重试。', 'request-failed'],
    ]);
    const buttonText = button?.textContent?.trim();
    return { accountForm:visible('[data-pc="account-projects"]'), usernameVisible:visible('[data-pc="account-projects"] input[name="username"]'),
      passwordVisible:visible('[data-pc="account-projects"] input[name="password"]'), accountNameVisible:visible('[data-pc="account-name"]'),
      editorVisible:visible('[data-pc="editor"]'), submitVisible:Boolean(button?.getClientRects().length), submitDisabled:Boolean(button?.disabled),
      busy:buttonText === '正在连接…' ? 'connecting' : buttonText === '正在处理…' ? 'processing' : buttonText === '登录账号' ? 'idle' : 'unknown',
      errorVisible:Boolean(error?.getClientRects().length), errorCode:error ? known.get(error.textContent?.trim()) ?? 'other-error' : 'none',
      tauriInvoke:typeof window.__TAURI__?.core?.invoke === 'function' };
  }).catch(() => ({ state:'ui-unavailable' }));
}
async function waitEditor(page, check) {
  await page.waitForSelector('[data-pc="editor"]', { visible:true });
  await page.waitForSelector('[data-pc="cloud-project-copy"]', { visible:true });
  assert(!(await page.$('[data-pc="account-projects"]')), check);
}
async function copyState(page) {
  // Read only fixed classifications, never clipboard contents or complete DOM text.
  return page.evaluate(async () => {
    const button = document.querySelector('[data-pc="cloud-project-copy"]');
    const toast = document.querySelector('[data-pc="sync-toasts"]')?.textContent ?? '';
    let permission = 'unavailable';
    try {
      permission = await Promise.race([
        navigator.permissions.query({ name:'clipboard-write' }).then(value => ['granted', 'denied', 'prompt'].includes(value.state) ? value.state : 'unknown'),
        new Promise(resolve => setTimeout(() => resolve('query-timeout'), 1000)),
      ]);
    } catch { /* Unsupported browser permission query. */ }
    return { buttonPresent:Boolean(button), buttonVisible:Boolean(button?.getClientRects().length),
      buttonDisabled:Boolean(button?.disabled), buttonFocused:document.activeElement === button, documentFocused:document.hasFocus(),
      clipboardApi:typeof navigator.clipboard?.writeText === 'function', permission,
      enteredToast:toast.includes('已进入云端项目'), copiedToast:toast.includes('项目链接已复制。'),
      fallbackToast:toast.includes('项目链接：https://visuhive.com/editor?project=') };
  }).catch(() => ({ state:'copy-diagnostic-unavailable' }));
}
async function websiteList(account, kind, projectId, name, label) {
  const context = await browser.createBrowserContext(); contexts.push(context);
  const page = await newPage(context, label);
  await page.goto(`${ORIGIN}/login`, { waitUntil:'domcontentloaded' });
  await type(page, '#login input[name="name"]', account.name);
  await type(page, '#login input[name="password"]', account.password);
  await Promise.all([page.waitForNavigation({ waitUntil:'domcontentloaded' }), page.click('#login button[type="submit"]')]);
  assert(new URL(page.url()).pathname === '/account', `${label}-website-login`);
  await page.waitForFunction((kind, name) => [...document.querySelectorAll(`#${kind} li`)].some(el => el.textContent === name), {}, kind, name);
  await Promise.all([...responseTasks]);
  assert(page.safeResponses.projects?.[kind]?.some(p => p.projectId === projectId && p.name === name), `${label}-authoritative-${kind}-id-name`);
  assert((await page.$eval('#acc-name', el => el.textContent)) === account.name, `${label}-website-account`);
  await safeShot(page, label);
  // A website login must restore in the online editor through the shared cookie.
  const restored = await newPage(context, `${label}-restored-editor`);
  await restored.goto(`${ORIGIN}/editor/`, { waitUntil:'domcontentloaded' });
  await restored.waitForSelector('[data-pc="account-name"]', { visible:true });
  assert(!(await restored.$('[data-pc="account-projects"] input[name="password"]')), `${label}-cookie-restores-editor-without-password`);
  await safeShot(restored, `${label}-cookie-restore`);
}

async function waitFor(check, name, timeout = TIMEOUT) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 200)); }
  const error = new Error(name); error.probeCheck = name; throw error;
}
function childClosed(child) {
  return child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((resolve, reject) => {
    child.once('close', resolve); child.once('error', reject);
  });
}
function nativeDescendants(pid) {
  // Only public PID/parent metadata: never query process command lines or secrets.
  const text = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'],
  { windowsHide:true, encoding:'utf8', timeout:15_000 });
  const rows = JSON.parse(text), ids = new Set([pid]);
  for (let changed = true; changed;) { changed = false; for (const row of rows) if (ids.has(row.ParentProcessId) && !ids.has(row.ProcessId)) { ids.add(row.ProcessId); changed = true; } }
  return [...ids];
}
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } }
async function cdpClosed() {
  return new Promise(resolve => {
    const socket = net.connect({ host:'127.0.0.1', port:6508 });
    let closed = false;
    socket.once('connect', () => socket.destroy());
    socket.once('error', error => { closed = error.code === 'ECONNREFUSED'; });
    socket.setTimeout(1000, () => socket.destroy());
    socket.once('close', () => resolve(closed));
  });
}
async function startNative(label) {
  await fs.access(DESKTOP_EXE);
  assert(await cdpClosed(), 'native-cdp-is-not-another-process');
  if (!nativeProfileOwned) { await fs.mkdir(DESKTOP_PROFILE, { mode:0o700 }); nativeProfileOwned = true; }
  for (const relative of ['AppData/Roaming', 'AppData/Local', 'AppData/Local/Temp', 'Documents', 'Desktop', 'Downloads', 'Pictures', 'Videos', 'Music']) await fs.mkdir(path.join(DESKTOP_PROFILE, relative), { recursive:true });
  const env = { ...nativeEnvironment, USERPROFILE:DESKTOP_PROFILE,
    APPDATA:path.join(DESKTOP_PROFILE, 'AppData/Roaming'), LOCALAPPDATA:path.join(DESKTOP_PROFILE, 'AppData/Local'),
    TEMP:path.join(DESKTOP_PROFILE, 'AppData/Local/Temp'), TMP:path.join(DESKTOP_PROFILE, 'AppData/Local/Temp'),
    PROMPTCUT_ACCOUNT_TEST_EDITOR_PORT:'6500', PROMPTCUT_ACCOUNT_TEST_CLOUD_ORIGIN:ORIGIN,
    PROMPTCUT_AGENT_CDP:'6508',
    WEBVIEW2_USER_DATA_FOLDER:path.join(DESKTOP_PROFILE, 'webview2'), PROMPTCUT_NO_PORT_FILE:'1' };
  const child = spawn(DESKTOP_EXE, [], { cwd:path.dirname(DESKTOP_EXE), env, windowsHide:true, stdio:['ignore', 'ignore', 'pipe'] });
  const state = { child, env, connection:null, page:null, closed:childClosed(child) }; native = state;
  const attempt = ++nativeAttempt, limit = 16 * 1024;
  let capturing = true, bytes = 0, truncated = false, chunks = [], ipcConfirmed = false;
  child.stderr.on('data', chunk => {
    // Keep draining for the process lifetime, but retain only pre-IPC startup
    // stderr, bounded in bytes. No login operation has happened at this stage.
    if (!capturing) return;
    const remaining = limit - bytes, retained = Math.min(chunk.length, remaining);
    if (retained) { chunks.push(Buffer.from(chunk.subarray(0, retained))); bytes += retained; }
    if (chunk.length > retained) truncated = true;
  });
  // Supervise immediately; propagate startup failure through the normal first error.
  state.closed.catch(() => {});
  try {
  await waitFor(async () => {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('native-exited-before-cdp');
    try { state.connection = await puppeteer.connect({ browserURL:'http://127.0.0.1:6508', defaultViewport:null, protocolTimeout:TIMEOUT }); return true; }
    catch { return false; }
  }, 'native-cdp-start');
  await waitFor(async () => {
    state.page = (await state.connection.pages()).find(page => page.url().startsWith(`${DESKTOP_ORIGIN}/`)); return Boolean(state.page);
  }, 'native-main-target');
  await observePage(state.page, label);
  await state.page.waitForFunction(() => Boolean(window.__TAURI__?.core?.invoke));
  await state.connection.defaultBrowserContext().overridePermissions(DESKTOP_ORIGIN, []);
  const bridge = await state.page.evaluate(async () => {
    const tauri = window.__TAURI__;
    if (!tauri?.core?.invoke) return null;
    const info = await tauri.core.invoke('agent_webview_info');
    const config = await tauri.core.invoke('account_bridge', { operation:'configuration', args:{} });
    return { main:tauri.webview.getCurrentWebview().label === 'main', window:tauri.window.getCurrentWindow().label === 'main',
      agentReady:info.ready === true, port:info.port, origin:config.origin, ok:config.ok === true };
  });
  assert(bridge?.main && bridge.window && bridge.agentReady && bridge.port === 6508 && bridge.ok && bridge.origin === ORIGIN, 'actual-main-and-agent-configuration-ipc');
  ipcConfirmed = true;
  } finally {
    capturing = false;
    const raw = Buffer.concat(chunks, bytes); chunks = [];
    const text = raw.toString('utf8'), osCode = text.match(/os error ([0-9]{1,10})/i)?.[1];
    const classification = /failed to build tauri application/.test(text) ? 'tauri-build-panic' :
      /failed to resolve app data dir/.test(text) ? 'app-data-dir-panic' :
      /failed to resolve app log dir/.test(text) ? 'app-log-dir-panic' :
      /failed to resolve resource dir/.test(text) ? 'resource-dir-panic' :
      /thread .* panicked at/.test(text) ? 'rust-panic' : /webview2/i.test(text) ? 'webview2-startup' :
      bytes ? 'unclassified-startup-stderr' : 'no-startup-stderr';
    const file = `native-startup-${attempt}.stderr.log`;
    let saved = false;
    try { await fs.writeFile(path.join(OUT, file), raw, { flag:'wx', mode:0o600 }); saved = true; }
    catch { result.cleanup.nativeStartupWriteFailed = true; process.exitCode = 1; }
    result.nativeStartup ??= [];
    result.nativeStartup.push({ attempt, pid:child.pid, ipcConfirmed, exitCode:child.exitCode,
      signal:child.signalCode, classification, ...(osCode ? { osErrorCode:Number(osCode) } : {}),
      capturedBytes:bytes, truncated, file:saved ? file : null });
    // Raw stderr is TMP-only. It is never printed or copied into result.json/Git.
  }
  let agent;
  await waitFor(async () => { agent = (await state.connection.pages()).find(page => page !== state.page && page.url().startsWith('about:blank')); return Boolean(agent); }, 'actual-agent-target');
  // Navigate only this owned agent webview to the allowed main origin to prove
  // that same URL/window cannot substitute for the invoking webview label.
  await agent.goto(`${DESKTOP_ORIGIN}/`, { waitUntil:'domcontentloaded' });
  const denied = await agent.evaluate(async () => {
    if (!window.__TAURI__?.core?.invoke) return { invoked:false };
    try { await window.__TAURI__.core.invoke('account_bridge', { operation:'configuration', args:{} }); return { invoked:true, denied:false }; }
    catch { return { invoked:true, denied:true, agent:window.__TAURI__.webview.getCurrentWebview().label === 'agent' }; }
  });
  assert(denied.invoked && denied.denied && denied.agent, 'actual-agent-account-bridge-denied');
  result.desktop = 'actual-shell-in-progress';
  result.nativePids ??= []; result.nativePids.push(child.pid);
  return state.page;
}
async function quitNative() {
  if (!native) return;
  const state = native; let ownedPids = [], treeKnown = true;
  try { ownedPids = nativeDescendants(state.child.pid); }
  catch { treeKnown = false; result.cleanup.nativeFailed = true; }
  const quit = spawn(DESKTOP_EXE, ['--quit'], { cwd:path.dirname(DESKTOP_EXE), env:state.env, windowsHide:true, stdio:'ignore' });
  await childClosed(quit);
  assert(quit.exitCode === 0, 'actual-native-quit-command');
  await Promise.race([state.closed, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('native-actual-close-timeout')), TIMEOUT); timer.unref(); })]);
  state.connection?.disconnect();
  if (treeKnown) await waitFor(() => Promise.resolve(ownedPids.every(pid => !pidAlive(pid))), 'native-owned-process-tree-closed');
  await waitFor(cdpClosed, 'native-cdp-listener-closed');
  result.cleanup.nativeRuns ??= []; result.cleanup.nativeRuns.push({ pid:state.child.pid, ownedPids, exitCode:state.child.exitCode, actualClosed:true, treeKnown, cdpClosed:true });
  native = null;
  if (!treeKnown) throw new Error('native-owned-process-tree-unknown');
}

async function registerAccount(account, label) {
  const context = await browser.createBrowserContext(); contexts.push(context);
  const page = await newPage(context, label);
  await page.goto(`${ORIGIN}/register`, { waitUntil:'domcontentloaded' });
  await type(page, '#register input[name="name"]', account.name);
  await type(page, '#register input[name="password"]', account.password);
  await type(page, '#register input[name="again"]', account.password);
  await Promise.all([page.waitForNavigation({ waitUntil:'domcontentloaded' }), page.click('#register button[type="submit"]')]);
  assert(new URL(page.url()).pathname === '/account', `${label}-real-registered`);
  await page.waitForFunction(name => document.querySelector('#acc-name')?.textContent === name, {}, account.name);
  await safeShot(page, label);
}
async function enterNewProject(page, name, label) {
  await type(page, '[data-pc="cloud-project-name"]', name);
  await page.click('[data-pc="cloud-create"]'); await waitEditor(page, `${label}-creator-enters-real-editor`);
  result.copy ??= []; const diagnostic = { label, before:await copyState(page) }; result.copy.push(diagnostic);
  try {
    await page.click('[data-pc="cloud-project-copy"]');
    await page.waitForFunction(() => document.querySelector('[data-pc="sync-toasts"]')?.textContent?.includes('项目链接：https://visuhive.com/editor?project='));
  } finally { diagnostic.after = await copyState(page); }
  const visibleText = await page.$eval('[data-pc="sync-toasts"]', el => el.textContent);
  const project = projectFromVisibleLink(visibleText);
  await waitFor(() => page.safeResponses.create?.projectId === project.projectId, `${label}-real-create-response-id`);
  assert(page.safeResponses.create?.projectId === project.projectId, `${label}-visible-link-matches-real-create-id`);
  result.ownedProjects.push({ projectId:project.projectId, name, path:label });
  await safeShot(page, `${label}-created-visible-link`);
  return project;
}
async function joinProject(page, project, label) {
  await type(page, '[data-pc="cloud-project-link"]', project.link); await page.click('[data-pc="cloud-join"]');
  await waitEditor(page, `${label}-member-enters-real-editor`);
  await waitFor(() => page.safeResponses.join?.projectId === project.projectId, `${label}-real-join-id`);
  assert(page.safeResponses.join.projectId === project.projectId, `${label}-real-join-id`);
  await safeShot(page, `${label}-joined`);
}
async function runOnline(accounts, marker) {
  const [ctxA, ctxB] = await Promise.all([browser.createBrowserContext(), browser.createBrowserContext()]); contexts.push(ctxA, ctxB);
  await ctxA.overridePermissions(ORIGIN, []); await ctxB.overridePermissions(ORIGIN, []);
  const a = await newPage(ctxA, 'online-editor-a'), b = await newPage(ctxB, 'online-editor-b');
  result.phase = 'online-a-login'; await loginEditor(a, accounts[0]); await safeShot(a, 'online-a-logged-in');
  result.phase = 'online-a-create'; const name = `${marker}-online`; const project = await enterNewProject(a, name, 'online');
  await waitFor(async () => {
    STAGES = await a.$$eval('iframe', frames => [...new Set(frames.flatMap(frame => {
      try { const url = new URL(frame.src); return url.pathname === '/editor/stage.html' ? [url.origin] : []; } catch { return []; }
    }))]);
    return STAGES.length === 2 && STAGES.every(origin => origin !== ORIGIN && origin.startsWith('https://')) &&
      STAGES.every(origin => result.stageDocuments.some(item => item.origin === origin && item.method === 'GET' && item.status === 200));
  }, 'both-real-public-stage-origins-loaded');
  assert(STAGES.length === 2, 'both-real-public-stage-origins-loaded'); result.publicStages = [...STAGES];
  result.phase = 'online-b-login'; await loginEditor(b, accounts[1]);
  result.phase = 'online-b-join'; await joinProject(b, project, 'online');
  result.phase = 'online-web-a-list'; await websiteList(accounts[0], 'owned', project.projectId, name, 'online-web-a-owned');
  result.phase = 'online-web-b-list'; await websiteList(accounts[1], 'joined', project.projectId, name, 'online-web-b-joined');
  result.online = 'real-public-complete';
}
async function runDesktop(accounts, marker) {
  result.phase = 'native-start'; let a = await startNative('native-a');
  result.phase = 'native-a-login'; await loginEditor(a, accounts[0]);
  result.phase = 'native-a-create'; const name = `${marker}-native`; const project = await enterNewProject(a, name, 'native');
  result.phase = 'native-quit-and-dpapi-recover'; await quitNative(); a = await startNative('native-a-recovered');
  await a.waitForSelector('[data-pc="account-name"]', { visible:true });
  assert((await a.$eval('[data-pc="account-name"]', el => el.textContent)).includes(accounts[0].name), 'actual-public-dpapi-recovery-after-shell-restart');
  assert(!(await a.$('[data-pc="account-projects"] input[name="password"]')), 'actual-public-native-recovered-without-password');
  await safeShot(a, 'native-a-dpapi-recovered');
  result.phase = 'native-switch-to-b'; await a.goto(`${DESKTOP_ORIGIN}/`, { waitUntil:'domcontentloaded' });
  await a.waitForSelector('[data-pc="account-name"]', { visible:true });
  const buttons = await a.$$('[data-pc="account-projects"] button'); let logout;
  for (const button of buttons) if (await button.evaluate(el => el.textContent?.trim() === '退出登录')) logout = button;
  assert(Boolean(logout), 'actual-native-public-logout-control'); await logout.click();
  await a.waitForSelector('[data-pc="account-projects"] input[name="password"]', { visible:true });
  assert(!(await a.$('[data-pc="account-name"]')), 'actual-native-public-logout-visible-success');
  await loginEditor(a, accounts[1]); result.phase = 'native-b-join'; await joinProject(a, project, 'native');
  result.phase = 'native-web-a-list'; await websiteList(accounts[0], 'owned', project.projectId, name, 'native-web-a-owned');
  result.phase = 'native-web-b-list'; await websiteList(accounts[1], 'joined', project.projectId, name, 'native-web-b-joined');
  await quitNative(); result.desktop = 'actual-public-shell-complete';
}

await fs.mkdir(OUT, { mode:0o700 }); // Exclusive evidence directory: never overwrite a prior attempt.
const wallStart = Date.now(); let chromeProfile = null;
try {
  await getChromePath(); await nativeBuildPreflight();
  result.preflight = { passed:true, publicOrigin:ORIGIN, requestedNative:Boolean(DESKTOP_EXE), publicNetwork:'not-contacted', productionActions:'not-run' };
  if (options.run) {
    const identities = testIdentities(); result.testMarker = identities.marker;
    result.ownedAccounts = []; result.accountNames = identities.accounts.map(account => account.name); result.ownedProjects = [];
    chromeProfile = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-account-public-chrome-'));
    browser = await puppeteer.launch({ executablePath:await getChromePath(), headless:true, pipe:true, userDataDir:chromeProfile,
      defaultViewport:{ width:1440, height:1000 }, protocolTimeout:TIMEOUT,
      args:[...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--no-default-browser-check', '--force-device-scale-factor=1', '--mute-audio'] });
    browserPid = browser.process()?.pid; result.browserPid = browserPid;
    for (let i = 0; i < identities.accounts.length; i++) { result.phase = `public-register-${i}`; await registerAccount(identities.accounts[i], `public-register-${i}`); }
    await runOnline(identities.accounts, identities.marker);
    if (DESKTOP_EXE) await runDesktop(identities.accounts, identities.marker);
    result.phase = 'complete';
  } else { result.phase = 'dry-preflight-complete'; }
} catch (error) {
  result.failure = { phase:result.phase, name:['Error', 'TypeError', 'TimeoutError', 'RangeError'].includes(error?.name) ? error.name : 'Error', check:error?.probeCheck ?? null };
  process.exitCode = 1; result.screenshotAttempts = [];
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i], label = `failure-${i + 1}`;
    if (page.isClosed()) { result.screenshotAttempts.push({ label, state:'page-closed' }); continue; }
    try { await safeShot(page, label); result.screenshotAttempts.push({ label, state:'saved' }); }
    catch { result.screenshotAttempts.push({ label, state:'capture-failed-or-password-not-cleared' }); }
  }
} finally {
  await Promise.allSettled([...responseTasks]);
  if (native) { try { await quitNative(); } catch { result.cleanup.nativeFailed = true; native.connection?.disconnect(); process.exitCode = 1; } }
  for (const observer of networkObservers) await observer.detach().catch(() => {});
  for (const context of contexts) await context.close().catch(() => {});
  if (browser) {
    const child = browser.process(); const closed = child && child.exitCode === null ? new Promise(resolve => child.once('close', resolve)) : Promise.resolve();
    let ownedPids = [];
    try { ownedPids = child ? process.platform === 'win32' ? nativeDescendants(child.pid) : [child.pid] : []; }
    catch { result.cleanup.browserTreeUnknown = true; process.exitCode = 1; }
    try {
      await browser.close(); await closed;
      await waitFor(() => Promise.resolve(ownedPids.every(pid => !pidAlive(pid))), 'browser-owned-process-tree-closed');
      result.cleanup.browserClosed = true;
    } catch { result.cleanup.browserCloseFailed = true; process.exitCode = 1; }
    result.cleanup.browserOwnedPids = ownedPids;
  } else { result.cleanup.browser = 'not-started'; }
  if (chromeProfile && result.cleanup.browserClosed && !result.cleanup.browserTreeUnknown) { await fs.rm(chromeProfile, { recursive:true, force:true }); result.cleanup.chromeProfileRemoved = true; }
  if (nativeProfileOwned && !native && fsSync.existsSync(DESKTOP_PROFILE) && !result.cleanup.nativeFailed) {
    await fs.rm(DESKTOP_PROFILE, { recursive:true, force:true }); result.cleanup.nativeProfileRemoved = true;
  }
  result.cleanup.productionAccountsDeleted = false; result.cleanup.productionProjectsDeleted = false;
  result.sourceAfter = source(); result.wallMs = Date.now() - wallStart;
  result.summary = { mode:result.mode, checks:result.checks.length, passed:result.checks.filter(check => check.ok).length,
    failed:result.checks.filter(check => !check.ok).length, completed:options.run && result.phase === 'complete',
    dryPreflightPassed:!options.run && result.phase === 'dry-preflight-complete', sourceUnchanged:result.sourceBefore === result.sourceAfter };
  if ((!result.summary.completed && !result.summary.dryPreflightPassed) || !result.summary.sourceUnchanged || result.cleanup.nativeFailed || result.cleanup.browserCloseFailed || result.cleanup.browserTreeUnknown) process.exitCode = 1;
  await fs.writeFile(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2), { flag:'wx', mode:0o600 });
  process.stdout.write(JSON.stringify({ summary:result.summary, failure:result.failure, cleanup:result.cleanup, out:OUT }) + '\n');
}



