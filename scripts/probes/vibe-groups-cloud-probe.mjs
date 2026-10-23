// First import protects user directories and the shared port file before any fixture import.
import '../lib/no-user-dirs.mjs';
/**
 * 云端分组真跑一遍(分支 `claude/groups-local-cloud`,报告 `docs/reports/AGENT-claude-groups-local-cloud.md`):
 * 在线浏览器(`VITE_PC_ONLINE=1` 的 vite dev)里两个互相隔离的浏览器上下文当「两台设备」登录同一个账号,
 * 云端分组走**真的**服务端:真的 `mountAccountProjects` + 真的权威(`createAccountHostedRuntime`)+ 真的整理信息存储
 * (`server/docservice/modules/account-org.mjs`,落在临时目录的文件里),只有账号服务那一层(`/api/account/me`、
 * `/api/account/editor/session`、`/api/account/projects`)是页面请求拦截造的假数据 —— 本脚本不连任何生产。
 *
 *   # 1) 本 worktree 里起在线构建的开发服务(端口自己挑,下面按 5964 写)
 *   VITE_PC_ONLINE=1 PROMPTCUT_NO_PORT_FILE=1 npx vite --port 5964 --strictPort --host 127.0.0.1
 *   # 2) 跑本脚本(再占一个端口当服务端,缺省 5969)
 *   node scripts/probes/vibe-groups-cloud-probe.mjs --url http://127.0.0.1:5964 --api-port 5969 --out <目录>
 *
 * 走的路(每步一张图在 --out 里):
 *   设备甲:登录、列出两个云端项目 → 新建分组、把项目放进去 → 等到服务端真的存下了
 *   设备乙(全新浏览器上下文,本机什么都没有):登录 → 侧栏里直接是设备甲建的分组和归属(换设备能看到)
 *   两台设备各改一处(甲新建第二个分组,乙给另一个项目置顶),不刷新 → 都同步后服务端两处改动都在,两边都收敛到同一份
 *   老服务端(这条路由 404):界面不报错、分组照常能建、说法改口成「暂时只记在这台浏览器里」
 *   云端暂时连不上(503):侧栏出现「云端分组没同步上」、改动留在本机;恢复后自动补上、提示消失、服务端有了
 * 最后一行是一行 JSON:{ ok, steps, fails }。退出码 0 过、1 不过。
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { openAccountLedger } from '../../server/account/ledger.mjs';
import { createAccountHostedRuntime } from '../../server/docservice/account-hosted.mjs';
import { mountAccountProjects } from '../../server/docservice/modules/account-projects.mjs';
import { createAccountOrgStore } from '../../server/docservice/modules/account-org.mjs';
import { createFileStore } from '../../server/docservice/store/index.mjs';

setTimeout(() => { console.error('SCRIPT_TIMEOUT'); process.exit(124); }, 10 * 60_000).unref();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const arg = (key, dflt) => { const i = argv.indexOf(key); return i < 0 ? dflt : argv[i + 1]; };
const URL_BASE = arg('--url', 'http://127.0.0.1:5964');
const API_PORT = Number(arg('--api-port', '5969'));
const OUT = path.resolve(arg('--out', path.join(ROOT, 'docs/reports/AGENT-claude-groups-local-cloud-shots')));
await fs.mkdir(OUT, { recursive: true });

const fails = [];
const out = { ok: false, out: OUT, steps: {} };
const step = (k, v) => { out.steps[k] = v; console.error(`[step] ${k} ${JSON.stringify(v).slice(0, 400)}`); };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 400))); return !!cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 30_000, every = 250) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) { fails.push(`等不到:${what}`); return null; }
    await sleep(every);
  }
}

/* ---------------- 真的服务端:权威 + 公开路由 + 整理信息存储(临时目录) ---------------- */
const ACC = { id: 'acc_' + 'c3'.repeat(12), name: '分组测试账号' };
const tmp = fsSync.mkdtempSync(path.join(os.tmpdir(), 'pc-groups-probe-'));
const ledger = openAccountLedger({ file: path.join(tmp, 'doc.sqlite'), authorityId: 'doc-groups-probe' });
const accountClient = {
  verify: async (token) => {
    if (token !== 'tok_abc') throw Object.assign(new Error('login-required'), { status: 401, code: 'login-required' });
    return { accountId: ACC.id, accountName: ACC.name, loginId: 'login-probe', credentialId: 'cred-probe', loginGeneration: 1, expiresAt: Date.now() + 3_600_000, accountEventSeq: 0, kind: 'editor' };
  },
  events: async () => ({ events: [], headSeq: 0 }),
};
const runtime = createAccountHostedRuntime({ ledger, accountClient, dataDir: null, authorityUrl: 'https://fixture.invalid', allowFixtureAssetReady: true, pollMs: 0, guestKey: randomBytes(32) });
runtime.setAssetReady(true);
runtime.bindService({ describe: () => ({ conns: [] }), fencePrincipals: async () => ({ actualClosed: true }) }, { registry: { refresh() {}, get: () => null }, urls: {} });
await runtime.start();
const orgStore = createAccountOrgStore({ store: createFileStore({ dir: path.join(tmp, 'data'), log: () => {} }) });
const mounted = mountAccountProjects({ authority: runtime.authority, issueSession: (o) => runtime.issueSession(o), orgStore });
const api = http.createServer((req, res) => { void mounted.handlePublic(req, res, {}).then((hit) => { if (!hit) { res.writeHead(404); res.end(); } }); });
await new Promise((resolve, reject) => { api.once('error', reject); api.listen(API_PORT, '127.0.0.1', resolve); });
const serverOrg = () => orgStore.get(ACC.id);
const cleanup = async () => { api.close(); try { runtime.close(); } catch { /* 已关 */ } try { ledger.close?.(); } catch { /* 已关 */ } fsSync.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); };

/** 当前这一刻云端分组那条路由怎么回:ok 转给真服务端;old 404(老服务端);down 503 */
let mode = 'ok';
const json = (o, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(o) });

async function newDevice(browser, label) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.label = label; page.errors = []; page.starts = [];
  await page.setViewport({ width: 1280, height: 800 });
  page.on('pageerror', (e) => page.errors.push(String(e?.message ?? e).slice(0, 300)));
  page.on('dialog', async (d) => { page.lastPrompt = d.message(); await d.accept(page.nextName ?? '客户组'); });
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    const u = new URL(req.url());
    const p = u.pathname;
    if (p === '/api/account/me') return req.respond(json({ ok: true, account: ACC, csrfToken: 'c' }));
    if (p === '/api/account/editor/session') return req.respond(json({ ok: true, account: ACC, loginId: 'login-probe', accessToken: 'tok_abc', accessExpiresAt: Date.now() + 3600e3 }));
    if (p === '/api/account/projects') return req.respond(json({ ok: true, owned: [{ projectId: 'projalpha01', name: '云端甲', authorityId: 'a' }, { projectId: 'projgamma03', name: '云端丙', authorityId: 'a' }], joined: [{ projectId: 'projbeta002', name: '云端乙', authorityId: 'a' }] }));
    if (p === '/hosted/shared/account/start-org') {
      page.starts.push(mode);
      if (mode === 'old') return req.respond(json({ ok: false, error: 'no-route', code: 'no-route' }, 404));
      if (mode === 'down') return req.respond(json({ ok: false, code: 'authority-unavailable' }, 503));
      const r = await fetch(`http://127.0.0.1:${API_PORT}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: req.headers().authorization ?? '' }, body: req.postData() });
      return req.respond({ status: r.status, contentType: 'application/json', body: await r.text() });
    }
    return req.continue();
  });
  await page.goto(`${URL_BASE}/?x=${label}`, { waitUntil: 'domcontentloaded' });
  await until(`${label} 侧栏列出云端项目`, () => page.$('[data-pc="start-side-project"]'), 40_000);
  return page;
}
const sideRows = (page) => page.$$eval('[data-pc="start-side-project"]', (els) => els.map((e) => e.dataset.project));
const groupsOn = (page) => page.$$eval('[data-pc="start-scope-group"]', (els) => els.map((e) => e.getAttribute('aria-label')));
const noteOf = (page) => page.evaluate(() => document.querySelector('[data-pc="start-notice"]')?.textContent ?? '');
const statusOf = (page) => page.evaluate(() => document.querySelector('[data-pc="start-group-status"]')?.textContent ?? null);
const newGroupTitle = (page) => page.evaluate(() => document.querySelector('[data-pc="start-new-group"]')?.title ?? null);
async function shot(page, name) { await page.screenshot({ path: path.join(OUT, `${name}.png`) }).catch(() => {}); }
async function menuOn(page, projectId, pc) {
  const box = await (await page.$(`[data-pc="start-side-project"][data-project="${projectId}"]`)).boundingBox();
  await page.mouse.click(box.x + 20, box.y + 10, { button: 'right' });
  await page.waitForSelector('[data-pc="start-row-menu"]');
  await page.click(`[data-pc="${pc}"]`);
  await sleep(400);
}
async function newGroup(page, name) { page.nextName = name; await page.click('[data-pc="start-new-group"]'); await sleep(400); }

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
try {
  /* 设备甲 */
  const A = await newDevice(browser, 'A');
  step('A.rows', await sideRows(A));
  check((await sideRows(A)).length === 3, '设备甲侧栏列出三个云端项目');
  step('A.newGroupNote', await newGroupTitle(A));
  check(/存在云端，换设备也能看到/.test(await newGroupTitle(A) ?? ''), '新建分组的提示说存在云端');
  await newGroup(A, '客户组');
  await menuOn(A, 'projalpha01', 'start-menu-move');
  await shot(A, '1-A-group-made');
  const first = await until('服务端存下了设备甲的分组', () => { const s = serverOrg(); return s.version >= 1 && s.org?.groups.some((g) => g.name === '客户组') && s.org.projects.some((p) => p.id === 'projalpha01' && p.groupId) ? s : null; });
  step('server.afterA', first && { version: first.version, groups: first.org.groups.map((g) => g.name), projects: first.org.projects.length });
  check(first?.org?.realm === 'cloud', '云端存的是 cloud 那一套');

  /* 设备乙:全新上下文 */
  const B = await newDevice(browser, 'B');
  const bGroups = await until('设备乙看到设备甲建的分组', async () => { const g = await groupsOn(B); return g.some((x) => x.includes('客户组')) ? g : null; });
  step('B.groups', bGroups);
  check(bGroups?.some((g) => g.includes('客户组') && g.includes('1 个项目')), '设备乙的分组里有设备甲放进去的项目', bGroups);
  step('B.keys', await B.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('pc.start'))));
  await shot(B, '2-B-sees-group');

  /* 两台设备各改一处,不刷新 */
  await newGroup(A, '第二组'); // 甲:新建第二个分组
  await menuOn(B, 'projbeta002', 'start-menu-pin'); // 乙:给另一个项目置顶
  const merged = await until('服务端两处改动都在', () => { const s = serverOrg(); const o = s.org; return o?.groups.some((g) => g.name === '第二组') && o.projects.some((p) => p.id === 'projbeta002' && p.pinned) && o.groups.some((g) => g.name === '客户组') ? s : null; }, 30_000);
  step('server.afterBoth', merged && { version: merged.version, groups: merged.org.groups.map((g) => g.name), pinned: merged.org.projects.filter((p) => p.pinned).map((p) => p.id) });
  // 两边都收敛到同一份:各自的页面再刷新一次(取云端的)看到的一样
  await A.reload({ waitUntil: 'domcontentloaded' }); await until('A 重新列出项目', () => A.$('[data-pc="start-side-project"]'), 40_000);
  await B.reload({ waitUntil: 'domcontentloaded' }); await until('B 重新列出项目', () => B.$('[data-pc="start-side-project"]'), 40_000);
  await sleep(2500);
  const ga = (await groupsOn(A)).sort(); const gb = (await groupsOn(B)).sort();
  step('A.groupsAfter', ga); step('B.groupsAfter', gb);
  check(JSON.stringify(ga) === JSON.stringify(gb) && ga.length === 2, '两台设备刷新后看到同一份(两个分组)', { ga, gb });
  await shot(A, '3-A-converged'); await shot(B, '3-B-converged');

  /* 老服务端:这条路由 404 */
  mode = 'old';
  const C = await newDevice(browser, 'C');
  await sleep(2500);
  step('C.starts', C.starts);
  check(C.starts.length >= 1 && C.starts.every((m) => m === 'old'), '设备丙探了老服务端', C.starts);
  const cNote = await newGroupTitle(C);
  step('C.newGroupNote', cNote);
  check(/暂时只记在这台浏览器里/.test(cNote ?? ''), '老服务端时说法改口成只记在这台浏览器里', cNote);
  check(!(await C.$('[role="alert"]')), '老服务端不报错(页面上没有提示条)');
  await newGroup(C, '老服务端下建的');
  check((await groupsOn(C)).some((g) => g.includes('老服务端下建的')), '老服务端下分组照常能建');
  check(C.errors.length === 0, '老服务端下页面没有脚本错误', C.errors);
  await shot(C, '4-C-old-server');

  /* 云端暂时连不上:待同步,恢复后补上 */
  mode = 'ok';
  await C.reload({ waitUntil: 'domcontentloaded' }); await until('C 重新列出项目', () => C.$('[data-pc="start-side-project"]'), 40_000);
  await sleep(1500);
  mode = 'down';
  await newGroup(C, '断线时建的');
  const pending = await until('出现「云端分组没同步上」', async () => { const s = await statusOf(C); return s && /没同步上/.test(s) ? s : null; }, 20_000);
  step('C.pendingText', pending);
  check(!!pending, '连不上时侧栏提示没同步上');
  check(!serverOrg().org?.groups.some((g) => g.name === '断线时建的'), '断线期间服务端没有这条');
  check((await groupsOn(C)).some((g) => g.includes('断线时建的')), '断线期间改动还在本机界面里');
  await shot(C, '5-C-pending');
  mode = 'ok';
  const healed = await until('恢复后服务端补上', () => serverOrg().org?.groups.some((g) => g.name === '断线时建的'), 40_000, 500);
  check(!!healed, '联网后自动补上');
  const gone = await until('提示消失', async () => (await statusOf(C)) === null, 10_000);
  check(!!gone, '补上之后提示消失');
  await shot(C, '6-C-healed');
  for (const p of [A, B, C]) check(p.errors.length === 0, `设备${p.label}页面没有脚本错误`, p.errors);
} catch (e) {
  fails.push(`脚本异常:${e?.stack ?? e}`);
} finally {
  await browser.close().catch(() => {});
  await cleanup();
}
out.ok = fails.length === 0;
out.fails = fails;
console.log(JSON.stringify({ ok: out.ok, steps: Object.keys(out.steps).length, fails }));
process.exit(out.ok ? 0 : 1);
