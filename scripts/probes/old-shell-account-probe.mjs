/**
 * 老外壳（0.2.8 以前的桌面外壳打了更新补丁）上账号入口的真浏览器探针（报告 `docs/reports/AGENT-claude-old-shell-account.md`）。
 *
 *   node scripts/probes/old-shell-account-probe.mjs [--port 5910] [--out out]
 *
 * 起一个本工作区的编辑器进程（开发服务器，数据目录在临时目录），无头 Chrome 打开，页面里的 `window.__TAURI__` 换成外壳替身：
 * - 老外壳：`invoke('account_bridge')` 以 Tauri 对「外壳里没有这个命令」的原话（字符串）拒绝；读版本的命令也被拒
 *   （0.2.5 以前的外壳没给远程页面放行 core:default）。原话的出处与形状见 `src/account/desktopShellOld.test.mjs` 文件头。
 * - 真错误：新外壳自己的错误代号（`desktop-account-bridge`）。
 * - 新外壳权限配错：原话和老外壳一样，但读得到版本 0.2.8。
 * - 新外壳正常：配置和恢复登录都有回答。
 *
 * 看的东西：开始页「云端项目」、设置里勾多用户协作 → 云端 → 确定（「搬到云端」）。老外壳上两处各是一句「这个功能要装完整安装包」，
 * 没有红色错误条、没有登录表单、没有页面异常；真错误仍是红色错误条；新外壳正常时账号这一套照旧。
 * 截图写到 `--out` 目录；stdout 最后一行是一行 JSON，`fails` 为空才算过。不碰 5190～5192，只用 `--port`、+1、+2 三个连号。
 */
import '../lib/no-user-dirs.mjs';
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { reopenEditorEnv } from './reopen-editor-env.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(arg('--port', '5910'));
const OUT = path.resolve(arg('--out', path.join(ROOT, 'out')));
fs.mkdirSync(OUT, { recursive: true });

const OLD_TEXT = '这个功能要装完整安装包';
const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ step, ...fields })}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`等 ${what} 超时(${ms} ms)`);
    await sleep(150);
  }
}
const fails = [];
const shots = [];
const check = (ok, name, detail) => { if (!ok) { fails.push(detail === undefined ? name : `${name}(${typeof detail === 'string' ? detail : JSON.stringify(detail)})`); say('FAIL', { name, detail }); } else say('ok', { name }); return !!ok; };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-old-shell-'));
let editor = null, browser = null;

function viteBin() {
  const main = createRequire(import.meta.url).resolve('vite/package.json');
  return path.join(path.dirname(main), 'bin', 'vite.js');
}
async function startEditor() {
  const dataDir = path.join(TMP, 'editor');
  const viteCache = path.join(dataDir, 'node_modules', '.vite-probe');
  const overrides = path.join(dataDir, 'card-overrides');
  for (const d of [overrides, viteCache]) fs.mkdirSync(d, { recursive: true });
  const child = spawn(process.execPath, [viteBin(), '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: reopenEditorEnv(dataDir, {
      PROMPTCUT_VITE_CACHE_DIR: viteCache, PROMPTCUT_CARD_OVERRIDES: overrides,
      PROMPTCUT_DEVICE_ID: `oldshell-${Date.now().toString(36)}`.padEnd(16, '0'), PROMPTCUT_DEVICE_NAME: 'old-shell-probe',
      PROMPTCUT_AUTO_RENDER_NODE: '0', PROMPTCUT_PUSH: '0', PROMPTCUT_LAN_HOST: '0', PROMPTCUT_NODE_PROFILE: 'user', PROMPTCUT_SHARED_CONFIG: '', PROMPTCUT_QUEUE_NODE: '0',
    }),
  });
  const log = [];
  const keep = (c) => { log.push(c.toString()); if (log.length > 3000) log.shift(); };
  child.stdout.on('data', keep); child.stderr.on('data', keep);
  editor = { child, log, base: `http://127.0.0.1:${PORT}` };
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`编辑器退出了:${log.join('').slice(-600)}`);
    return fetch(`${editor.base}/api/docservice/device`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
  }, 240_000, '编辑器起来');
}
async function stopEditor() {
  const c = editor?.child;
  if (!c?.pid || c.exitCode !== null) return;
  const exited = new Promise((r) => c.once('exit', r));
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); else c.kill('SIGKILL');
  await Promise.race([exited, sleep(10_000)]);
}

/** 外壳替身（跑在页面里）：`mode` 决定 `account_bridge` 怎么回答；`window.__bridgeCalls` 记下被调用的操作 */
function shellStub(mode) {
  window.__bridgeCalls = [];
  const OLD = 'Command account_bridge not allowed by ACL';
  window.__TAURI__ = { core: { invoke: async (command, payload) => {
    if (command !== 'account_bridge') return null;
    window.__bridgeCalls.push(payload?.operation);
    if (mode === 'old' || mode === 'misconfigured') throw OLD;
    if (mode === 'real-error') throw 'desktop-account-bridge';
    if (payload.operation === 'configuration') return { origin: 'https://visuhive.com' };
    if (payload.operation === 'recover') return null;
    throw 'desktop-account-request';
  } }, app: { getVersion: async () => {
    if (mode === 'old') throw 'plugin:app|version not allowed by ACL';
    return '0.2.8';
  } } };
}

async function openPage(mode, url) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.errors = []; page.dialogs = [];
  page.on('pageerror', (e) => page.errors.push(String(e?.message ?? e).slice(0, 300)));
  page.on('dialog', (d) => { page.dialogs.push(d.message()); void d.accept(); });
  page.setDefaultNavigationTimeout(300_000);
  await page.evaluateOnNewDocument(shellStub, mode);
  await page.setViewport({ width: 1100, height: 800 });
  await page.goto(`${editor.base}${url}`, { waitUntil: 'domcontentloaded' });
  return page;
}
const text = (page, selector) => page.evaluate((s) => document.querySelector(s)?.textContent ?? null, selector);
const has = (page, selector) => page.evaluate((s) => !!document.querySelector(s), selector);
async function shot(page, name) {
  await page.evaluate(() => { for (const el of document.querySelectorAll('[data-pc="collab-project-password"] code')) el.replaceChildren(document.createTextNode('[已遮住]')); document.querySelector('[data-pc="collab-status"]')?.scrollIntoView({ block: 'end' }); });
  await sleep(200);
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  shots.push(path.relative(ROOT, file).split(path.sep).join('/'));
}

async function startPage(mode) {
  const page = await openPage(mode, '/?nosetup=1&ui=classic');
  await waitFor(() => has(page, '[data-pc="account-projects"]'), 120_000, `${mode} 开始页的云端项目`);
  // 等初始化走完：老外壳出说明、真错误出红条、正常出登录表单
  await waitFor(() => page.evaluate(() => !!document.querySelector('[data-pc="account-shell-old"], [data-pc="account-error"]') || [...document.querySelectorAll('[data-pc="account-projects"] .sp-primary-btn')].some((b) => b.textContent?.trim() === '登录账号')), 60_000, `${mode} 账号入口初始化完`);
  return page;
}
async function openSettings(page) {
  await waitFor(() => page.evaluate(() => !!window.__pcSyncTest && window.__pcSyncTest.view().status === 'online'), 240_000, '页面接上本机文档服务');
  await waitFor(() => page.evaluate(() => !document.querySelector('[data-pc="probe-gate"]')), 300_000, '测量遮罩退下').catch(() => null);
  await page.evaluate(() => { for (const b of document.querySelectorAll('.ais-dialog button')) if (b.textContent?.trim() === '关闭') b.click(); });
  await page.evaluate(() => window.dispatchEvent(new Event('pc-open-project-settings')));
  await page.waitForSelector('[data-pc="collab-section"]', { timeout: 30_000 });
  await page.click('[data-pc="collab-toggle"]');
  await page.waitForSelector('[data-pc="collab-where-hosted"]');
  await page.click('[data-pc="collab-where-hosted"]');
  // 账号云端的查询（accountCloud）是异步的，等它落定：老外壳出说明，别的出账号这一块或旧办法的表单
  await waitFor(() => page.evaluate(() => !!document.querySelector('[data-pc="collab-shell-old"], [data-pc="collab-account-intro"], #pc-collab-creator')), 30_000, '设置里云端这一块落定');
}
const clickConfirm = (page) => page.evaluate(() => [...document.querySelectorAll('.pc-dialog-foot button')].find((b) => b.textContent?.trim() === '确定').click());

async function main() {
  await startEditor();
  say('editor', { base: editor.base });
  browser = await puppeteer.launch({ headless: true, args: [...PROBE_CHROME_ARGS, '--no-sandbox'] });

  // ===== 老外壳 =====
  {
    const page = await startPage('old');
    const body = await text(page, '[data-pc="account-shell-old"]');
    check(body?.includes(OLD_TEXT), '老外壳-开始页：云端项目一块是那句说明', body);
    check(!(await has(page, '[data-pc="account-error"]')), '老外壳-开始页：没有红色错误条');
    check(!(await has(page, 'input[name="username"]')) && !(await has(page, '[data-pc="cloud-join"]')), '老外壳-开始页：没有会失败的登录表单和加入表单');
    check(page.errors.length === 0, '老外壳-开始页：没有页面异常', page.errors);
    check((await page.evaluate(() => window.__bridgeCalls))[0] === 'configuration', '老外壳-开始页：确实调了 account_bridge 并被拒', await page.evaluate(() => window.__bridgeCalls));
    await page.$eval('[data-pc="account-projects"]', (el) => el.scrollIntoView({ block: 'center' }));
    await shot(page, 'old-shell-account-1-start');
    await page.close();
  }
  {
    const page = await openPage('old', '/?editor&nosetup=1');
    await openSettings(page);
    const warn = await text(page, '[data-pc="collab-shell-old"]');
    check(warn?.includes(OLD_TEXT), '老外壳-设置：云端一块是那句说明', warn);
    check(!(await has(page, '#pc-collab-creator')) && !(await has(page, '[data-pc="collab-account-login"]')), '老外壳-设置：没有会走不通的创建者表单和账号登录表单');
    await clickConfirm(page);
    await waitFor(() => text(page, '[data-pc="collab-status"]'), 15_000, '点确定后的状态行');
    const status = await text(page, '[data-pc="collab-status"]');
    check(status?.includes(OLD_TEXT), '老外壳-设置：点确定，状态行还是那句说明（没有继续搬）', status);
    check(page.errors.length === 0, '老外壳-设置：没有页面异常', page.errors);
    check(page.dialogs.length === 0, '老外壳-设置：没有弹确认框', page.dialogs);
    await shot(page, 'old-shell-account-2-move');
    // 自己填别的节点：仍是旧办法，不被拦
    await page.$eval('[data-pc="collab-hosted-url"]', (el) => { el.focus(); el.select(); });
    await page.keyboard.type('https://my-own-node.example.com');
    await waitFor(() => page.evaluate(() => !!document.querySelector('#pc-collab-creator')), 10_000, '换成别的节点后出现旧办法的创建者表单');
    check(!(await has(page, '[data-pc="collab-shell-old"]')), '老外壳-设置：用户自己填的别的节点不显示说明，仍是旧办法');
    await page.close();
  }

  // ===== 老外壳：已开启的本机协作房间点「搬到云端」 =====
  {
    const page = await openPage('old', '/?editor&nosetup=1');
    await waitFor(() => page.evaluate(() => !!window.__pcSyncTest && window.__pcSyncTest.view().status === 'online'), 240_000, '页面接上本机文档服务');
    await waitFor(() => page.evaluate(() => !document.querySelector('[data-pc="probe-gate"]')), 300_000, '测量遮罩退下').catch(() => null);
    await page.evaluate(() => { for (const b of document.querySelectorAll('.ais-dialog button')) if (b.textContent?.trim() === '关闭') b.click(); });
    const created = await page.evaluate(async () => (await import('/src/editor/sync/collab.ts')).enableCollab({ where: 'lan', mode: 'free', name: `老外壳-房间-${Date.now()}`, creator: { username: 'host', password: 'probe-room-secret-1' }, projectPassword: 'probe-room-secret-2', hostedUrl: null }));
    check(created.ok, '老外壳-房间：本机协作房间开成了', created.error);
    await page.evaluate(() => window.dispatchEvent(new Event('pc-open-project-settings')));
    await page.waitForSelector('[data-pc="collab-move-hosted"]', { timeout: 30_000 });
    await sleep(1500); // 等设置打开时对账号云端的那次查询落定
    await page.click('[data-pc="collab-move-hosted"]');
    await waitFor(() => text(page, '[data-pc="collab-status"]'), 15_000, '点搬到云端后的状态行');
    const status = await text(page, '[data-pc="collab-status"]');
    check(status?.includes(OLD_TEXT), '老外壳-房间：点「搬到云端」，状态行是那句说明（没有弹确认框、没有开始搬）', status);
    check(page.dialogs.length === 0, '老外壳-房间：没有弹确认框', page.dialogs);
    check(page.errors.length === 0, '老外壳-房间：没有页面异常', page.errors);
    const still = await page.evaluate(() => window.__pcSyncTest.view().shared?.where);
    check(still === 'lan', '老外壳-房间：本机协作房间原样还在', still);
    await shot(page, 'old-shell-account-4-room');
    await page.close();
  }

  // ===== 真错误：新外壳自己的错误代号 =====
  {
    const page = await startPage('real-error');
    const err = await text(page, '[data-pc="account-error"]');
    check(err === '账号入口初始化失败。', '真错误-开始页：红色错误条照常显示（Tauri 以字符串拒绝，界面一直是这句通用的话）', err);
    check(!(await has(page, '[data-pc="account-shell-old"]')), '真错误-开始页：没有说成要装完整安装包');
    await shot(page, 'old-shell-account-3-real-error');
    await page.close();
  }
  // ===== 新外壳权限配错（原话与老外壳一样，但版本 0.2.8）=====
  {
    const page = await startPage('misconfigured');
    const err = await text(page, '[data-pc="account-error"]');
    check(err === '账号入口初始化失败。', '新外壳权限配错-开始页：红色错误条照常显示', err);
    check(!(await has(page, '[data-pc="account-shell-old"]')), '新外壳权限配错-开始页：没有说成要装完整安装包');
    await page.close();
  }
  // ===== 新外壳正常 =====
  {
    const page = await startPage('good');
    check(await has(page, 'input[name="username"]') && !(await has(page, '[data-pc="account-shell-old"]')) && !(await has(page, '[data-pc="account-error"]')), '新外壳正常-开始页：登录表单照旧，没有说明也没有错误条');
    check((await page.evaluate(() => window.__bridgeCalls)).join() === 'configuration,recover', '新外壳正常-开始页：先取配置、再恢复登录', await page.evaluate(() => window.__bridgeCalls));
    await page.close();
  }
  {
    const page = await openPage('good', '/?editor&nosetup=1');
    await openSettings(page);
    check(await has(page, '[data-pc="collab-account-intro"]') && !(await has(page, '[data-pc="collab-shell-old"]')), '新外壳正常-设置：云端是账号这一套（有账号说明，没有老外壳说明）');
    await page.close();
  }
}

let crashed = null;
try { await main(); } catch (e) { crashed = e; check(false, '探针自己出错', String(e?.stack ?? e).slice(0, 600)); }
finally {
  await browser?.close().catch(() => {});
  await stopEditor();
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(JSON.stringify({ ok: fails.length === 0 && !crashed, fails, shots }));
process.exit(fails.length ? 1 : 0);
