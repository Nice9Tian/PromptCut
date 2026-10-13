/**
 * 「搬到云端」旧流程防呆探针：对一个账号模式的云端节点，经界面真的点「搬到云端」两个入口和「搬回本机」各一遍，
 * 记下每一步的请求与状态码、界面原文、本机房间前后的状态、云端一侧落了什么，并截图。
 *
 *   node scripts/probes/move-guard-probe.mjs --tag before            # 账号模式节点：入口甲、入口乙、搬回本机
 *   node scripts/probes/move-guard-probe.mjs --tag after --legacy    # 另加一遍旧模式节点：入口乙应照旧走通
 *
 * 需要环境变量 PROMPTCUT_ACCOUNT_PROVIDER_ROOT、PROMPTCUT_PASSWORD_ORDER_MODULE（账号后端替身，同全量测试）。
 * 截图和 JSON 报告写到 docs/reports/assets/v18-move-guard/<tag>-*.png、<tag>-evidence.json。
 * 端口只用 28950～28989；所有子进程都静默（windowsHide），收尾按进程号逐个关。
 */
import '../lib/no-user-dirs.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import puppeteer from 'puppeteer';
import { pathToFileURL } from 'node:url';
import { waitFor } from '../../server/test/fake-ws-kit.mjs';
import { reopenEditorEnv } from './reopen-editor-env.mjs';

const argv = process.argv.slice(2);
const flag = name => argv.includes(`--${name}`);
const option = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
const tag = option('tag', 'run');
const withLegacy = flag('legacy');
const only = option('only', 'a,b,c,l').split(',');
const BASE = Number(option('base-port', '28950'));
const OUT = path.resolve('docs/reports/assets/v18-move-guard');
fs.mkdirSync(OUT, { recursive: true });

const require = createRequire(import.meta.url);
const vite = path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-move-guard-'));
const secret = () => randomBytes(32).toString('base64url');
const children = new Set();
const evidence = { tag, steps: [] };
const note = (step, data) => { evidence.steps.push({ step, ...data }); console.log(JSON.stringify({ step, ...data })); };

// 云端一侧收到的每个请求（方法、路径、状态码）：给 https.createServer 挂监听；夹具里的边缘服务器是它起的。
const cloudLog = [];
{
  const original = https.createServer;
  https.createServer = (...args) => {
    const server = original(...args);
    server.prependListener('request', (req, res) => {
      const entry = { method: req.method, path: String(req.url).split('?')[0] };
      res.once('finish', () => { entry.status = res.statusCode; cloudLog.push(entry); });
    });
    return server;
  };
}
const mark = () => cloudLog.length;
const since = from => cloudLog.slice(from).filter(e => !e.path.startsWith('/internal/')); // 夹具内部的账号事件轮询不算

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise(resolve => child.once('exit', resolve)); child.kill(); await done; children.delete(child);
}

async function startEditor(who, port, extraEnv) {
  const dataDir = path.join(root, who); fs.mkdirSync(dataDir, { recursive: true });
  const child = spawn(process.execPath, [vite, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: process.cwd(), windowsHide: true,
    env: reopenEditorEnv(dataDir, { PROMPTCUT_PROJECTS_DIR: path.join(dataDir, 'drafts'), PROMPTCUT_DEVICE_ID: `probe-${who}-device-000001`, PROMPTCUT_DEVICE_NAME: `isolated-${who}`,
      PROMPTCUT_ARTIFACT_DIR: path.join(dataDir, 'artifacts'), PROMPTCUT_AUTO_RENDER_NODE: '0', PROMPTCUT_NO_PORT_FILE: '1', PROMPTCUT_PUSH: '0', PROMPTCUT_LAN_HOST: '0',
      PROMPTCUT_NODE_PROFILE: 'user', PROMPTCUT_SHARED_CONFIG: '', PROMPTCUT_QUEUE_NODE: '0', ...extraEnv }), stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child); child.stdout.resume(); child.stderr.resume();
  const base = `http://127.0.0.1:${port}`;
  await waitFor(async () => { if (child.exitCode !== null) throw new Error('isolated editor exited'); try { return (await fetch(`${base}/api/docservice/device`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } }, 60000, 'isolated editor');
  return { child, base, dataDir };
}

async function startLegacyNode(docPort, assetPort) {
  const dataDir = path.join(root, 'legacy'); fs.mkdirSync(dataDir, { recursive: true });
  const comboUrl = pathToFileURL(path.resolve('server/hosted/combo.mjs')).href;
  const code = `import { startHostedCombo } from ${JSON.stringify(comboUrl)};
    const c = await startHostedCombo({ dataDir: process.env.PROMPTCUT_DATA_DIR, docPort: ${docPort}, assetPort: ${assetPort}, host: '127.0.0.1', trustLoopback: false, clusterToken: process.env.PROMPTCUT_CLUSTER_TOKEN, log: () => {} });
    console.log(JSON.stringify({ docPort: c.docPort, assetPort: c.assetPort }));
    process.stdin.resume(); process.stdin.on('end', () => c.close().then(() => process.exit(0)));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true, env: reopenEditorEnv(dataDir, { PROMPTCUT_CLUSTER_TOKEN: secret() }), stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child); child.stderr.resume();
  let ready = false; child.stdout.on('data', b => { if (String(b).includes('docPort')) ready = true; });
  await waitFor(() => { if (child.exitCode !== null) throw new Error('legacy node exited'); return ready; }, 20000, 'legacy node');
  return { child, dataDir, service: `http://127.0.0.1:${docPort}` };
}

/** 磁盘上本机房间记录里的搬迁封锁（`relocation`）：封锁了，所有成员和本机页面都进不去 */
function roomFence(editorDataDir, roomId) {
  const file = path.join(editorDataDir, 'docservice', 'auth', 'projects', `${roomId}.json`);
  if (!fs.existsSync(file)) return { recordFound: false };
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { recordFound: true, relocation: rec.relocation ? { phase: rec.relocation.phase, target: rec.relocation.target } : null, hostingEpoch: rec.hostingEpoch ?? 1 };
}
function dirListing(dir) {
  const out = [];
  const walk = d => { for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(path.relative(dir, p).replaceAll('\\', '/')); } };
  walk(dir); return out.sort();
}

let browser;
const pageErrors = [];
async function newPage(base, label) {
  const context = await browser.createBrowserContext(), page = await context.newPage();
  page.net = [];
  page.on('response', res => { const u = new URL(res.url()); if (u.pathname.startsWith('/api/collaboration/') || (u.origin !== base && /\/shared\/create$|\/hosting\/|\/healthz$/.test(u.pathname))) page.net.push({ url: `${u.origin === base ? '' : u.origin}${u.pathname}`, method: res.request().method(), status: res.status() }); });
  page.on('pageerror', e => pageErrors.push(String(e?.message ?? e).slice(0, 300)));
  page.on('console', m => { if (/\[(collab|sync)\]/.test(m.text())) console.error(`(${label}) ${m.text().replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]')}`); });
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(`${base}/?editor&nosetup=1`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    const [sync, proc, store, collab] = await Promise.all([import('/src/editor/sync/syncManager.ts'), import('/src/editor/io/proc.ts'), import('/src/store/project.ts'), import('/src/editor/sync/collab.ts')]);
    window.probe = { sync, proc, store, collab }; await sync.startSync();
  });
  await page.waitForFunction(() => document.querySelector('.ais-dialog') || window.probe.sync.getSyncView().device, { timeout: 15000 });
  await page.evaluate(() => { [...document.querySelectorAll('.ais-dialog button')].find(b => b.textContent?.trim() === '关闭')?.click(); });
  return page;
}
const view = page => page.evaluate(() => { const v = window.probe.sync.getSyncView();
  return { shared: v.shared && { projectId: v.shared.projectId, where: v.shared.where, accountId: v.shared.accountId ?? null }, association: v.association && { roomId: v.association.roomId, where: v.association.where, service: v.association.service },
    reopenState: v.reopenState, status: v.status, blocked: v.blocked }; });
const statusText = page => page.evaluate(() => document.querySelector('[data-pc="collab-status"]')?.textContent ?? null);
async function openSettings(page) { await page.evaluate(() => window.dispatchEvent(new Event('pc-open-project-settings'))); await page.waitForSelector('[data-pc="collab-section"]', { timeout: 10000 }); }
async function closeSettings(page) { await page.evaluate(() => [...document.querySelectorAll('.pc-dialog button')].find(b => b.textContent?.trim() === '取消')?.click()); }
const shot = async (page, name) => { const file = path.join(OUT, `${tag}-${name}.png`);
  // 截图里不留项目密码、邀请链接、二维码（探针房间是一次性的，也不往仓库里放这些值）
  await page.evaluate(() => { for (const el of document.querySelectorAll('[data-pc="collab-project-password"], [data-pc="collab-invite-link"], [data-pc="collab-qr"], #pc-collab-cpw, #pc-collab-ppw')) { if ('value' in el && el.tagName === 'INPUT') el.type = 'password'; else el.replaceChildren(document.createTextNode('[redacted]')); } });
  await page.screenshot({ path: file }); return path.relative(process.cwd(), file).replaceAll('\\', '/'); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 本机房间现状：页面状态、磁盘封锁、尝试一次编辑能不能存下去、成员重连用的 restore-host 回什么 */
async function localState(page, editor, roomId) {
  const v = await view(page);
  const edit = await page.evaluate(async () => {
    const { store, sync } = window.probe; const before = store.getState().project.name; const next = `probe-edit-${Date.now()}`;
    store.actions.setProjectMeta({ name: next });
    let saved; try { await sync.whenSaved(4000); saved = true; } catch (e) { saved = String(e?.message ?? e).slice(0, 80); }
    const after = window.probe.sync.getSyncView();
    return { renamedLocally: store.getState().project.name === next, before, saved, statusAfter: after.status };
  });
  let restore = null;
  const assoc = await page.evaluate(() => window.probe.sync.getSyncView().association);
  const sharedNow = await page.evaluate(() => window.probe.sync.getSyncView().shared);
  const descriptor = assoc ?? (sharedNow ? { version: 1, roomId: sharedNow.projectId, where: sharedNow.where, service: null } : null);
  if (descriptor?.service) restore = await page.evaluate(async d => { const r = await fetch('/api/collaboration/restore-host', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ descriptor: d, task: 'move-guard-probe', taskVersion: 0 }) }); return { status: r.status, body: await r.json() }; }, descriptor);
  return { view: v, edit, fence: roomId ? roomFence(editor.dataDir, roomId) : null, restoreHost: restore };
}

async function scenarioA(page, serviceUrl, name) {
  // 入口甲：项目设置里勾多用户协作、放云端、填云端地址、点确定
  const logFrom = mark(), netFrom = page.net.length;
  await page.evaluate(n => window.probe.proc.newProject(n), name);
  await openSettings(page);
  await page.click('[data-pc="collab-toggle"]'); await page.waitForSelector('[data-pc="collab-where-hosted"]');
  await page.click('[data-pc="collab-where-hosted"]');
  await page.waitForSelector('[data-pc="collab-hosted-url"]');
  await page.focus('[data-pc="collab-hosted-url"]'); await page.$eval('[data-pc="collab-hosted-url"]', el => el.select()); await page.keyboard.press('Backspace');
  await page.type('[data-pc="collab-hosted-url"]', serviceUrl);
  await page.evaluate(() => [...document.querySelectorAll('.pc-dialog-foot button')].find(b => b.textContent?.trim() === '确定').click());
  await waitFor(async () => { const t = await statusText(page); return t && !/^正在/.test(t); }, 30000, 'entry A result');
  const text = await statusText(page); const imageA = await shot(page, 'entry-a-settings');
  const state = await localState(page, null, null);
  await closeSettings(page);
  return { statusText: text, image: imageA, requests: page.net.slice(netFrom), cloud: since(logFrom), local: state };
}

async function scenarioB(page, editor, serviceUrl, name, cloudDir, { prefix = 'entry-b', logged = true } = {}) {
  // 入口乙：本机先开协作房间（放本机），再在设置里点「搬到云端」
  await page.evaluate(n => window.probe.proc.newProject(n), name);
  const created = await page.evaluate(async o => window.probe.collab.enableCollab(o), { where: 'lan', mode: 'free', name: `${name}-${Date.now()}`, creator: { username: 'host', password: secret() }, projectPassword: secret(), hostedUrl: serviceUrl });
  if (!created.ok) throw new Error(`lan room could not be created: ${created.error}`);
  const roomId = await page.evaluate(() => window.probe.sync.getSyncView().shared.projectId);
  await sleep(1500);
  const before = await localState(page, editor, roomId);
  const filesBefore = cloudDir ? dirListing(cloudDir) : null;
  const logFrom = mark(), netFrom = page.net.length;
  await openSettings(page);
  await page.waitForSelector('[data-pc="collab-move-hosted"]');
  await shot(page, `${prefix}-before-click`);
  await page.click('[data-pc="collab-move-hosted"]');
  let outcome = 'timeout';
  await waitFor(async () => {
    const t = await statusText(page), v = await view(page);
    if (v.shared?.where === 'hosted' && /已搬到云端/.test(t ?? '')) { outcome = 'moved'; return true; }
    if (t && /暂未完成|请在当前|素材尚未入库/.test(t)) { outcome = 'refused'; return true; }
    return false;
  }, 40000, 'entry B result').catch(() => undefined);
  await sleep(4000); // 让后台续传、协调器多走几步，看它最终停在哪
  const text = await statusText(page); const image = await shot(page, `${prefix}-after-click`);
  const after = await localState(page, editor, roomId);
  await closeSettings(page);
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 0));
  void bodyText;
  const filesAfter = cloudDir ? dirListing(cloudDir) : null;
  return { roomId, outcome, statusText: text, image, requests: page.net.slice(netFrom), cloud: logged ? since(logFrom) : '(旧模式节点是普通 http，不在探针的云端请求记录里)', before, after,
    cloudFilesAdded: filesBefore && filesAfter ? filesAfter.filter(f => !filesBefore.includes(f)) : null };
}

// 搬回本机：把页面接到账号项目上（桌面版里的账号项目走原生保险箱；这里用页面里的替身 native，请求交给本探针发到边缘服务器）。
async function scenarioC(page, fixture, cloudDir) {
  const ca = fs.readFileSync(fixture.caFile);
  const call = (route, { method = 'GET', body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const req = https.request(fixture.origin + route, { method, ca, timeout: 10000, headers: { ...(text === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }), ...headers } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.once('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* 非 JSON */ } resolve({ status: res.statusCode, body: json, cookie: res.headers['set-cookie']?.[0]?.split(';')[0] }); });
    });
    req.once('error', reject); req.once('timeout', () => req.destroy(Error('timeout'))); req.end(text);
  });
  let cookie = '', csrf = '';
  const site = async (route, body) => { const r = await call('/api/account' + route, { method: body ? 'POST' : 'GET', body, headers: { ...(cookie ? { cookie } : {}), ...(body ? { origin: fixture.origin, 'sec-fetch-site': 'same-origin', 'x-csrf-token': csrf } : {}) } });
    if (r.cookie) cookie = r.cookie; if (r.body?.csrfToken) csrf = r.body.csrfToken; return r; };
  await page.exposeFunction('__moveGuardNative', async (operation, args) => {
    if (operation === 'recover') {
      await site('/me'); const login = await site('/login', fixture.accounts[0]);
      if (login.status !== 200) return { ok: false, status: login.status, code: 'bad-login' };
      const s = await site('/editor/session', { deviceId: args.deviceId, deviceName: args.deviceName, requestId: `move-guard-${Date.now()}` });
      return s.body;
    }
    if (operation === 'request') {
      const r = await call(args.path, { method: args.body === undefined ? 'GET' : 'POST', body: args.body, headers: args.accessToken ? { authorization: `Bearer ${args.accessToken}` } : {} });
      return r.status === 200 || r.status === 201 ? r.body : { ok: false, status: r.status, code: r.body?.code ?? r.body?.error };
    }
    return { ok: false, status: 503, code: 'desktop-bridge-unavailable' };
  });
  const logFrom = mark(), netFrom = page.net.length;
  const entered = await page.evaluate(async ({ origin, projectId }) => {
    const [{ createAccountClient }, { createEmptyProject }] = await Promise.all([import('/src/account/client.ts'), import('/src/kernel/project.ts')]);
    const device = window.probe.sync.getSyncView().device;
    const client = createAccountClient({ online: false, origin, device: { deviceId: device.deviceId, deviceName: device.deviceName }, native: (op, args) => window.__moveGuardNative(op, args) });
    try {
      await client.restore();
      const initial = createEmptyProject('account project'); // 页面自己造的完整空项目：夹具里那个项目只有 { tracks: [] }，编辑器渲染不了
      const made = await client.create('account project', initial, crypto.randomUUID());
      await window.probe.sync.enterAccountProject({ client, origin, projectId: made.projectId, name: 'account project', initial }); return { ok: true, projectId: made.projectId };
    }
    catch (e) { return { ok: false, error: String(e?.message ?? e).slice(0, 200) }; }
  }, { origin: fixture.origin, projectId: fixture.projectId });
  note('C-enter-account-project', entered);
  if (!entered.ok) return { entered, skipped: true };
  await page.waitForFunction(() => window.probe.sync.getSyncView().shared?.accountId, { timeout: 20000 });
  await sleep(1500);
  note('C-page-after-enter', { text: await page.evaluate(() => document.body.innerText.slice(0, 200)), errors: pageErrors.slice(-5) });
  const stateBefore = await localState(page, null, null);
  const filesBefore = dirListing(cloudDir);
  await openSettings(page).catch(async e => { await shot(page, 'move-back-settings-missing'); throw e; });
  await page.waitForSelector('[data-pc="collab-move-lan"]', { timeout: 10000 });
  await shot(page, 'move-back-before-click');
  const from = mark();
  await page.click('[data-pc="collab-move-lan"]');
  await waitFor(async () => { const t = await statusText(page); return t && !/^正在/.test(t); }, 30000, 'move back result').catch(() => undefined);
  await sleep(2000);
  const text = await statusText(page); const image = await shot(page, 'move-back-after-click');
  const stateAfter = await localState(page, null, null);
  await closeSettings(page);
  return { entered, statusText: text, image, requests: page.net.slice(netFrom), cloud: since(from), stateBefore, stateAfter, cloudFilesAdded: dirListing(cloudDir).filter(f => !filesBefore.includes(f)) };
}

let fixture, legacy, editorA, accountEditor;
try {
  for (const name of ['PROMPTCUT_ACCOUNT_PROVIDER_ROOT', 'PROMPTCUT_PASSWORD_ORDER_MODULE']) if (!process.env[name]) throw new Error(`缺环境变量 ${name}`);
  const { startCloudQueueUserFixture } = await import('../../server/test/fixtures/cloud-queue-user-path.mjs');
  const ports = Array.from({ length: 7 }, (_, i) => BASE + i);
  fixture = await startCloudQueueUserFixture({ ports, agentPort: BASE + 7 });
  const accountService = `${fixture.origin}/hosted`;
  note('account-node-up', { origin: fixture.origin, service: accountService });
  {
    // 节点自己的回答：健康检查里的账号模式字段；旧办法的创建口和整房导入口各回什么
    const ca = fs.readFileSync(fixture.caFile);
    const ask = (route, method, body) => new Promise((resolve, reject) => {
      const text = body === undefined ? undefined : JSON.stringify(body);
      const req = https.request(accountService + route, { method, ca, timeout: 8000, headers: text === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), authorization: `Bearer ${'A'.repeat(43)}` } }, res => {
        const chunks = []; res.on('data', c => chunks.push(c)); res.once('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* 非 JSON */ } resolve({ status: res.statusCode, body: json }); });
      });
      req.once('error', reject); req.once('timeout', () => req.destroy(Error('timeout'))); req.end(text);
    });
    const health = await ask('/healthz', 'GET');
    note('node-facts', { healthz: { status: health.status, accountMode: health.body?.accountMode, accountRequired: health.body?.accountRequired },
      sharedCreate: await ask('/shared/create', 'POST', {}), importInit: await ask('/hosting/relocation/import-init', 'POST', { roomId: 'sp_aaaaaaaaaaaaaaaaaaaaaaaaaa', txnId: `move_${'0'.repeat(32)}`, target: {} }) });
  }
  if (withLegacy) legacy = await startLegacyNode(BASE + 10, BASE + 11);
  accountEditor = await startEditor('account-side', BASE + 20, { NODE_EXTRA_CA_CERTS: fixture.caFile });
  browser = await puppeteer.launch({ headless: true, userDataDir: path.join(root, 'browser'), args: ['--no-sandbox', '--ignore-certificate-errors'] });

  // 云端一侧的磁盘：夹具的临时目录里 doc/ 是文档服务的数据目录
  const cloudDir = path.join(fixture.fixtureDir, 'doc');
  const hostingFiles = () => dirListing(cloudDir);

  void hostingFiles;
  if (only.includes('a')) {
    const pageA = await newPage(accountEditor.base, 'A');
    const a = await scenarioA(pageA, accountService, 'move-guard-a');
    note('A-entry-a-account-node', a); evidence.entryA = a;
  }
  if (only.includes('b')) {
    const pageB = await newPage(accountEditor.base, 'B');
    const b = await scenarioB(pageB, accountEditor, accountService, 'move-guard-b', cloudDir);
    note('B-entry-b-account-node', b); evidence.entryB = b;
  }
  if (only.includes('c')) {
    const pageC = await newPage(accountEditor.base, 'C');
    const c = await scenarioC(pageC, fixture, cloudDir);
    note('C-move-back-account-node', c); evidence.moveBack = c;
  }

  if (withLegacy && only.includes('l')) {
    const legacyEditor = await startEditor('legacy-side', BASE + 21, {});
    const pageL = await newPage(legacyEditor.base, 'L');
    const l = await scenarioB(pageL, legacyEditor, legacy.service, 'move-guard-legacy', path.join(legacy.dataDir, 'docservice'), { prefix: 'legacy-entry-b', logged: false });
    note('L-entry-b-legacy-node', l); evidence.entryBLegacy = l;
    await pageL.close();
  }
  fs.writeFileSync(path.join(OUT, `${tag}-evidence.json`), JSON.stringify(evidence, null, 2).replace(/[A-Za-z0-9_-]{43,}/g, '[redacted]'));
  console.log(JSON.stringify({ done: true, tag, evidence: path.join(OUT, `${tag}-evidence.json`) }));
} catch (error) {
  console.error(error?.stack ?? error);
  fs.writeFileSync(path.join(OUT, `${tag}-evidence.json`), JSON.stringify({ ...evidence, error: String(error?.message ?? error) }, null, 2).replace(/[A-Za-z0-9_-]{43,}/g, '[redacted]'));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  for (const child of [...children]) await stopChild(child).catch(() => undefined);
  await fixture?.close().catch(() => undefined);
  fs.rmSync(root, { recursive: true, force: true });
}
