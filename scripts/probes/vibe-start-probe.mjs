// First import protects user directories and the shared port file before any fixture import.
import '../lib/no-user-dirs.mjs';
/**
 * Vibe 模式开始页接业务层的真跑一遍(分支 `claude/vibe-wire`,报告 `docs/reports/AGENT-claude-vibe-wire.md`)。
 *
 * 全在本机、全是真进程:真的 VisuHive 账号服务与官网接口、账号版文档服务、独立的素材服务进程、真的云端 Agent HTTP 服务
 * (`server/test/fixtures/account-conversation-controls-user-path.mjs`,夹具里三个真账号 dualUser0 / 1 / 2 和一个共享项目,
 * dualUser0 是创建者),在线构建当 `/editor/`,两个舞台源;绝不连生产。无头 Chrome(不用桌面应用的内置浏览器窗格)。
 *
 *   node scripts/probes/vibe-start-probe.mjs --dist dist-online --site-root <VisuHive>/site --out <目录>
 *   要设 PROMPTCUT_ACCOUNT_PROVIDER_ROOT、PROMPTCUT_PASSWORD_ORDER_MODULE(同全量测试)、PROMPTCUT_NO_PORT_FILE=1
 *   端口:夹具 6500～6506、Agent 服务 6507、舞台源 6508 / 6509(分给这条分支的 6500～6519)
 *
 * 走的路(每步一张图,图名见 `step` 记录):
 *   账号 dualUser0:打开 /editor/ 是 Vibe 登录页 → 账号密码登录 → 开始页列出真云端项目 → 点进项目 → 告知框「我知道了」→
 *     发一句话给云端 Agent → 看到真回复或真错误 → 开拓展栏看真画面 → 详细编辑看真时间轴 → 切成私有 → 回首页 →
 *     开始页说一句话(带一张图、选 9:16)→ 新项目建好、进聊天页、这句话自动发出 → 回首页,新项目那一格是真画面
 *   账号 dualUser1(同项目的另一位成员):登录、进同一个项目 → 侧栏里**没有** dualUser0 刚切成私有的那条对话
 *   游客:登录页点「以游客身份进入」→ 开始页是游客 → 说一句话建自己那一个项目 → 回首页列着它 → 刷新再以游客进来 → 还是同一个游客、
 *     项目还列着 → 点进去
 * 最后一行是一行 JSON:{ ok, steps, fails }。退出码 0 过、1 不过。截图不含密码(截图前清空密码框)。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { editorSecurityHeaders, stageSecurityHeaders } from '../../src/online/stagePolicy.mjs';
import { solidPng } from './lib/mobile-env.mjs';
import { startAccountConversationControlsUserFixture } from '../../server/test/fixtures/account-conversation-controls-user-path.mjs';

setTimeout(() => { console.error('SCRIPT_TIMEOUT'); process.exit(124); }, 20 * 60_000).unref();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const arg = (key, dflt) => { const i = argv.indexOf(key); return i < 0 ? dflt : argv[i + 1]; };
const DIST = path.resolve(arg('--dist', path.join(ROOT, 'dist-online')));
const SITE = path.resolve(arg('--site-root', path.join(process.env.PROMPTCUT_ACCOUNT_PROVIDER_ROOT ?? '', 'site')));
const OUT = path.resolve(arg('--out', path.join(ROOT, 'docs/reports/AGENT-claude-vibe-wire-shots')));
await fs.mkdir(OUT, { recursive: true });
const FIXTURE_PORTS = [6500, 6501, 6502, 6503, 6504, 6505, 6506];
const AGENT_PORT = 6507;
const STAGE_PORTS = [6508, 6509];
const ORIGIN = `https://127.0.0.1:${FIXTURE_PORTS[6]}`;
const STAGES = STAGE_PORTS.map((p, i) => `http://s${i + 1}.pc.localhost:${p}`);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm' };
const T = 60_000;

const fails = [];
const out = { ok: false, out: OUT, steps: {} };
const step = (k, v) => { out.steps[k] = v; console.error(`[step] ${k} ${JSON.stringify(v).slice(0, 300)}`); };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 400))); return !!cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = T, every = 300) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) { fails.push(`等不到:${what}`); return null; }
    await sleep(every);
  }
}

/* ---------------- 静态服务:在线构建当 /editor/,官网页面当其余路径 ---------------- */
function below(root, relative) { const target = path.resolve(root, relative); const rel = path.relative(root, target); return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? target : null; }
async function sendFile(req, res, root, relative, headers) {
  const file = below(root, relative);
  let stat;
  try { stat = file && await fs.stat(file); } catch { /* 404 */ }
  if (!stat?.isFile()) { res.writeHead(404, headers); res.end(); return; }
  const bytes = await fs.readFile(file);
  res.writeHead(200, { ...headers, 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'content-length': bytes.length, 'cache-control': 'no-store' });
  res.end(req.method === 'HEAD' ? undefined : bytes);
}
function staticHandler(stage = false) {
  return async (req, res) => {
    const headers = stage ? stageSecurityHeaders(ORIGIN) : editorSecurityHeaders(STAGES);
    const url = new URL(req.url, ORIGIN);
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, headers); res.end(); return; }
    if (url.pathname === '/editor/runtime-config.json') { res.writeHead(200, { ...headers, 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ v: 1, stageOrigins: STAGES })); return; }
    if (url.pathname === '/editor/_iso/ok') { res.writeHead(204, headers); res.end(); return; }
    if (url.pathname === '/editor/_iso/redirect') { res.writeHead(302, { ...headers, location: '/editor/_iso/ok' }); res.end(); return; }
    // 项目直达地址(/editor/p/<id>)也回 index.html
    if (url.pathname === '/editor' || url.pathname === '/editor/' || url.pathname === '/editor/index.html' || /^\/editor\/(p|s)\//.test(url.pathname)) return sendFile(req, res, DIST, 'index.html', headers);
    if (url.pathname.startsWith('/editor/')) return sendFile(req, res, DIST, decodeURIComponent(url.pathname.slice('/editor/'.length)), headers);
    if (url.pathname.startsWith('/catalog/')) return sendFile(req, res, DIST, decodeURIComponent(url.pathname.slice(1)), headers);
    if (!stage) {
      const file = url.pathname === '/' ? 'index.html' : ['/account', '/login', '/register', '/reset'].includes(url.pathname) ? `${url.pathname.slice(1)}.html` : decodeURIComponent(url.pathname.slice(1));
      return sendFile(req, res, SITE, file, { 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' });
    }
    res.writeHead(404, headers); res.end();
  };
}
const stageServers = [];
async function startStage(port) {
  const handler = staticHandler(true);
  const server = http.createServer((req, res) => { void handler(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); });
  stageServers.push(server);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
}

/* ---------------- 页面小件 ---------------- */
async function newPage(browser, label) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.label = label; page.errors = []; page.bad = []; page.agentNet = [];
  page.on('pageerror', (e) => page.errors.push(String(e?.stack ?? e?.message ?? e).slice(0, 2000)));
  page.on('response', (r) => {
    const u = new URL(r.url());
    if (r.status() >= 500) page.bad.push(`${r.status()} ${u.pathname}`);
    if (u.pathname.startsWith('/agent/') && r.request().method() !== 'GET') page.agentNet.push(`${r.request().method()} ${u.pathname.replace(/\/conversations\/[^/]+/, '/conversations/:id')} ${r.status()}`);
  });
  await page.setViewport({ width: 1440, height: 900 });
  page.setDefaultTimeout(T);
  return page;
}
async function shot(page, name) {
  for (const input of await page.$$('input[type="password"]')) await input.evaluate((el) => { el.value = ''; });
  await page.screenshot({ path: path.join(OUT, `${name}.png`) }).catch(() => {});
}
async function typeInto(page, sel, value) {
  const input = await page.waitForSelector(sel, { visible: true });
  await input.click({ clickCount: 3 });
  await page.keyboard.press('Backspace');
  await input.type(value);
}
/** 进项目时右上角那条「已进入云端项目」的气泡会压住拓展栏的段头:先关掉(用户也是点 ✕ 关) */
async function closeToasts(page) {
  for (const b of await page.$$('.pc-toast button[aria-label="关闭"]')) await b.click().catch(() => {});
  await sleep(300);
}
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent?.trim() ?? null, sel);
const exists = (page, sel) => page.evaluate((s) => !!document.querySelector(s), sel);

/** 进项目后弹出的告知框:点「我知道了」(第二颗) */
async function acceptConsent(page) {
  const dlg = await until(`${page.label} 告知框出现`, () => page.$('[data-pc="cloud-agent-consent"]'), 30_000);
  if (!dlg) return false;
  await shot(page, `${page.label}-consent`);
  const buttons = await page.$$('[data-pc="cloud-agent-consent"] button');
  await buttons[buttons.length - 1].click();
  return !!(await until(`${page.label} 告知框关上`, async () => !(await exists(page, '[data-pc="cloud-agent-consent"]')), 30_000));
}

/** 发一句话,等真回复或真错误;回读到的东西 */
async function sendAndWait(page, sentence) {
  await typeInto(page, '[data-pc="start-chat-input"]', sentence);
  await page.keyboard.press('Enter');
  return waitOutcome(page, sentence);
}
async function waitOutcome(page, sentence) {
  const mine = await until(`${page.label} 自己那条气泡`, () => page.evaluate((t) => [...document.querySelectorAll('[data-pc="start-chat-msg"][data-from="me"]')].some((m) => m.textContent.includes(t)), sentence), 30_000);
  const outcome = await until(`${page.label} 云端 Agent 回复或出错`, () => page.evaluate(() => {
    const agent = [...document.querySelectorAll('[data-pc="start-chat-msg"][data-from="agent"]')].filter((m) => !m.dataset.live);
    const err = document.querySelector('[data-pc="start-chat-error"], [data-pc="start-chat-send-error"]');
    const banner = document.querySelector('[data-pc="start-chat-banner"]');
    if (agent.length) return { kind: 'agent', text: agent[agent.length - 1].textContent.trim().slice(0, 300), error: err?.textContent?.trim() ?? null };
    if (err) return { kind: 'error', text: err.textContent.trim().slice(0, 300) };
    if (banner) return { kind: 'banner', text: banner.textContent.trim().slice(0, 300) };
    // 云端已收下(202)、执行服务没在接活:气泡写「已发出，等待云端开始处理…」,底下一行写「消息会持久排队，等待执行服务」(和编辑器右栏同一句)
    const accepted = [...document.querySelectorAll('[data-pc="start-chat-msg"][data-from="me"][data-send="accepted"]')].length > 0;
    const note = document.querySelector('[data-pc="start-chat-note"]')?.textContent?.trim() ?? '';
    if (accepted && /等待执行服务/.test(note)) return { kind: 'queued-waiting-executor', text: note };
    return null;
  }), 120_000, 500);
  return { mine: !!mine, outcome };
}

async function login(page, account) {
  await page.goto(`${ORIGIN}/editor/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-pc="start-login-form"]', { visible: true });
  await typeInto(page, '[data-pc="start-login-form"] input[name="username"]', account.name);
  await typeInto(page, '[data-pc="start-login-form"] input[name="password"]', account.password);
  await page.click('[data-pc="start-login-submit"]');
  return until(`${page.label} 登录后进开始页`, () => page.$('[data-pc="start-online"][data-signed-in]'), 60_000);
}
const sideProjects = (page) => page.evaluate(() => [...document.querySelectorAll('[data-pc="start-side-project"]')].map((b) => ({ id: b.dataset.project, name: b.getAttribute('title') })));
const sideAgents = (page) => page.evaluate(() => [...document.querySelectorAll('[data-pc="start-side-agent"]')].map((b) => ({ id: b.dataset.agent, name: b.getAttribute('title') })));

let fixture = null, browser = null;
try {
  fixture = await startAccountConversationControlsUserFixture({ ports: FIXTURE_PORTS, agentPort: AGENT_PORT, publicHandler: staticHandler() });
  check(fixture.origin === ORIGIN, '本机账号版环境起来了', fixture.origin);
  for (const port of STAGE_PORTS) await startStage(port);
  browser = await puppeteer.launch({ headless: true, acceptInsecureCerts: true, protocolTimeout: 600_000,
    args: [...PROBE_CHROME_ARGS, '--no-first-run', '--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required',
      `--host-resolver-rules=MAP s1.pc.localhost 127.0.0.1,MAP s2.pc.localhost 127.0.0.1`] });
  const [A, B] = fixture.accounts;
  const SHARED = 'Shared dual account project';

  /* ================ 1. 打开 /editor/:缺省就是 Vibe 登录页,不是老的账号表单 ================ */
  const P = await newPage(browser, 'creator');
  await P.goto(`${ORIGIN}/editor/`, { waitUntil: 'domcontentloaded' });
  const loginShown = await until('Vibe 登录页', () => P.$('[data-pc="start-vibe-login"] [data-pc="start-login-form"]'), 60_000);
  const oldPage = await exists(P, '[data-pc="account-projects"]');
  const previewNote = await P.evaluate(() => { const n = document.querySelector('.ps-login-note'); return n ? getComputedStyle(n).display : null; });
  step('1-login-page', { vibeLogin: !!loginShown, oldAccountForm: oldPage, previewNoteDisplay: previewNote });
  check(!!loginShown && !oldPage, '/editor/ 缺省进 Vibe 登录页(没有老账号表单)');
  // 2026-10-23 接业务层之后，那行「界面预览阶段：登录不会真的发请求」已经从 OnlineLogin.tsx 里**删掉**（原先是用样式藏着）
  check(previewNote === null, '登录页上没有「界面预览阶段」那行（已删除，不是藏起来）');
  await shot(P, '01-login');

  /* ================ 2. 账号登录 → 开始页列出真云端项目 ================ */
  const signed = await login(P, A);
  const name = await text(P, '[data-pc="start-account-name"]');
  const projects = await until('侧栏列出共享项目', async () => { const l = await sideProjects(P); return l.some((p) => p.name === SHARED) ? l : null; }, 30_000);
  const tiles = await P.evaluate(() => [...document.querySelectorAll('[data-pc="start-project-tile"]')].map((t) => t.querySelector('.ps-tile-name')?.textContent));
  const fakeLeft = await P.evaluate(() => /夏季上新|开箱测评|品牌短片|课程切片|预览账号/.test(document.body.innerText));
  step('2-home', { signedIn: !!signed, name, projects, tiles, fakeLeft });
  check(!!signed && name === A.name, '账号密码登录成功,顶栏是 dualUser0', name);
  check(!!projects && tiles.includes(SHARED), '侧栏与缩略图那一排都是真云端项目', { projects, tiles });
  check(!fakeLeft, '页面上没有任何假数据');
  await shot(P, '02-home-account');

  /* ================ 3. 点进项目 → 聊天页、告知框 ================ */
  const sharedId = projects?.find((p) => p.name === SHARED)?.id;
  await P.click(`[data-pc="start-side-project"][data-project="${sharedId}"]`);
  const chat = await until('进项目的聊天页', () => P.$('[data-pc="start-chat"]'), 90_000);
  const addr = new URL(P.url()).pathname;
  step('3-open-project', { chat: !!chat, addr, editorMounted: await exists(P, '[data-pc="editor"]') });
  check(!!chat && !(await exists(P, '[data-pc="editor"]')), '点进项目留在 Vibe 聊天页,不进编辑界面');
  const consented = await acceptConsent(P);
  check(consented, '告知框「我知道了」之后关上');

  /* ================ 4. 发一句话给云端 Agent ================ */
  const r1 = await sendAndWait(P, '你好，先说说这个项目里现在有什么。');
  const convId = await P.evaluate(() => document.querySelector('[data-pc="start-chat"]')?.dataset.chat ?? null);
  step('4-send', { ...r1, convId, agentNet: P.agentNet.slice(-8) });
  check(r1.mine && !!r1.outcome, '发出去了,看到云端 Agent 的真回复或真实的错误提示', r1);
  await shot(P, '03-chat-sent');

  /* ================ 5. 拓展栏:真画面;详细编辑:真时间轴 ================ */
  await closeToasts(P);
  // 进会话之后拓展栏自己就展开了(issue #6):已经开着就别再点,点了反而关上
  await P.evaluate(() => { if (!document.querySelector('[data-pc="start-ext"]')) document.querySelector('[data-pc="start-chat-ext-toggle"]')?.click(); });
  const stage = await until('拓展栏的画面挂上舞台', () => P.$('[data-pc="start-ext-stage"] [data-pc="preview"]'), 30_000);
  await sleep(3000);
  await shot(P, '04-chat-ext');
  await P.click('[data-pc="start-ext-detail"]');
  const detail = await until('详细编辑', () => P.$('[data-pc="start-detail"] [data-pc="start-detail-stage"] [data-pc="preview"]'), 30_000);
  // 详细编辑 2026-10-23 换成真时间轴(`src/editor/timeline` 的 TimelineView,见 DetailEdit.tsx),
  // 原来那套只读轨道的 `.ps-detail-lane` / `[data-pc="start-detail-clip"]` 不存在了;这里只记录,不参与判定
  const detailInfo = await P.evaluate(() => ({ timeline: !!document.querySelector('[data-pc="start-detail-tl"] [data-pc="timeline"]'), tracks: document.querySelectorAll('[data-pc="start-detail-tl"] [data-track-id]').length, clips: document.querySelectorAll('[data-pc="start-detail-tl"] [data-clip-id]').length, extStage: !!document.querySelector('[data-pc="start-ext-stage"]') }));
  step('5-ext-detail', { stage: !!stage, detail: !!detail, ...detailInfo });
  check(!!stage && !!detail && !detailInfo.extStage, '拓展栏与详细编辑挂的是真预览,同一时刻只挂一份');
  await sleep(2000);
  await shot(P, '05-detail-edit');
  await P.click('[data-pc="start-detail-close"]');

  /* ================ 5b. 另一位成员进同一个项目:共有的时候看得到这条对话 ================ */
  const Q = await newPage(browser, 'member');
  await login(Q, B);
  await until('成员侧栏列出共享项目', async () => (await sideProjects(Q)).some((p) => p.id === sharedId), 30_000);
  await Q.click(`[data-pc="start-side-project"][data-project="${sharedId}"]`);
  await until('成员进聊天页', () => Q.$('[data-pc="start-chat"]'), 90_000);
  await acceptConsent(Q);
  const seenShared = await until('成员侧栏里有 dualUser0 的共有对话', async () => (await sideAgents(Q)).some((c) => c.id === convId), 30_000);
  step('5b-member-shared', { seenShared: !!seenShared, memberAgents: await sideAgents(Q) });
  check(!!seenShared, '共有对话:同项目的另一位成员在侧栏里看得到');
  await closeToasts(Q);
  await shot(Q, '05b-member-sees-shared');

  /* ================ 6. 切成私有(开对话的人才能切) ================ */
  const visBtn = await until('共有 / 私有键可用', () => P.$('[data-pc="start-chat-visibility"]:not([disabled])'), 30_000);
  if (visBtn) { await visBtn.click(); }
  const priv = await until('切成私有', async () => (await text(P, '[data-pc="start-chat-visibility"]')) === '私有', 30_000);
  step('6-private', { private: !!priv, convId });
  check(!!priv, '自己开的对话能切成私有');

  await closeToasts(P);
  /* ================ 7. 回首页 → 说一句话(带一张图、9:16)建新项目 ================ */
  await P.click('[data-pc="start-home"]');
  await P.waitForSelector('[data-pc="start-prompt-input"]', { visible: true });
  const homeAddr = new URL(P.url()).pathname;
  await shot(P, '06-home-back');
  const img = await solidPng(path.join(os.tmpdir(), 'vibe-probe-img.png'), [40, 150, 220]);
  await (await P.$('[data-pc="start-prompt-files"]')).uploadFile(img);
  await P.evaluate(() => { [...document.querySelectorAll('.ps-prompt-foot .ps-chip')].find((b) => b.textContent.trim() === '9:16')?.click(); });
  const chip = await text(P, '[data-pc="start-prompt-upload"]');
  const SENTENCE = '做一支 10 秒的竖屏开场：一张蓝色背景，中间写「你好」。';
  await typeInto(P, '[data-pc="start-prompt-input"]', SENTENCE);
  await P.click('[data-pc="start-prompt-send"]');
  const chat2 = await until('新项目的聊天页', async () => (await P.evaluate((c) => { const el = document.querySelector('[data-pc="start-chat"]'); return el && el.dataset.chat !== c; }, convId)), 120_000, 500);
  const consent2 = await exists(P, '[data-pc="cloud-agent-consent"]');
  if (consent2) await acceptConsent(P);
  const r2 = await waitOutcome(P, '竖屏开场');
  await P.evaluate(() => { if (!document.querySelector('[data-pc="start-ext"]')) document.querySelector('[data-pc="start-chat-ext-toggle"]')?.click(); });
  const aspect = await until('新项目的画面比例', () => P.evaluate(() => document.querySelector('[data-pc="start-ext-stage"]')?.style.aspectRatio || null), 20_000);
  const sideNow = await sideProjects(P);
  const importNote = await text(P, '[data-pc="start-chat-note"]');
  step('7-prompt', { homeAddr, chip, importNote, chat2: !!chat2, consentAgain: consent2, ...r2, aspect, sideNow });
  check(homeAddr === '/editor/', '回首页时地址换回 /editor/', homeAddr);
  check(!!chat2 && r2.mine && !!r2.outcome, '开始页说一句话:建好新项目、进聊天页、这句话自动发给云端 Agent', r2);
  check(/1080\s*\/\s*1920/.test(aspect ?? ''), '新项目按选的 9:16 定了尺寸', aspect);
  check(sideNow.some((p) => /竖屏开场/.test(p.name ?? '')), '新项目出现在侧栏', sideNow);
  await sleep(4000);
  await shot(P, '07-prompt-project-chat');

  /* ================ 8. 回首页:新项目那一格是真画面(打开过、项目里有图) ================ */
  await P.click('[data-pc="start-home"]');
  const newId = sideNow.find((p) => /竖屏开场/.test(p.name ?? ''))?.id;
  const thumb = await until('新项目那一格换成真画面', () => P.evaluate((id) => document.querySelector(`[data-pc="start-project-tile"][data-project="${id}"]`)?.dataset.thumb === 'real', newId), 40_000);
  const thumbs = await P.evaluate(() => [...document.querySelectorAll('[data-pc="start-project-tile"]')].map((t) => ({ name: t.querySelector('.ps-tile-name')?.textContent, thumb: t.dataset.thumb })));
  step('8-thumb', { newId, real: !!thumb, thumbs });
  check(!!thumb, '打开过、有素材的项目,开始页那一格是真画面;别的项目是色块', thumbs);
  await shot(P, '08-home-thumbs');

  /* ================ 9. 另一位成员:切成私有之后看不到了 ================ */
  const gone = await until('成员侧栏里那条对话消失', async () => !(await sideAgents(Q)).some((c) => c.id === convId), 30_000);
  const memberAgents = await sideAgents(Q);
  const creatorAgents = await sideAgents(P).catch(() => []);
  step('9-member', { gone: !!gone, memberAgents, convId });
  check(!memberAgents.some((c) => c.id === convId), '另一位成员的侧栏里没有 dualUser0 的私有对话', memberAgents);
  await shot(Q, '09-member-no-private');
  void creatorAgents;

  /* ================ 10. 游客 ================ */
  const G = await newPage(browser, 'guest');
  await G.goto(`${ORIGIN}/editor/`, { waitUntil: 'domcontentloaded' });
  await G.waitForSelector('[data-pc="start-login-guest"]', { visible: true });
  await G.click('[data-pc="start-login-guest"]');
  const guestHome = await until('游客进开始页', () => G.$('[data-pc="start-online"][data-guest="1"]'), 60_000);
  const guestName = await text(G, '[data-pc="start-account-name"]');
  const guestErr = guestHome ? null : await text(G, '[data-pc="start-login-error"]');
  step('10-guest-home', { guestHome: !!guestHome, guestName, guestErr });
  check(!!guestHome, '登录页「以游客身份进入」真进来了', guestErr);
  await shot(G, '10-guest-home');
  if (guestHome) {
    await typeInto(G, '[data-pc="start-prompt-input"]', '游客试一下：做一张写着欢迎的卡片。');
    await G.click('[data-pc="start-prompt-send"]');
    const gchat = await until('游客项目的聊天页', () => G.$('[data-pc="start-chat"]'), 120_000, 500);
    const gerr = gchat ? null : await text(G, '[data-pc="start-notice"]');
    // 游客暂时用不了云端 Agent（`claude/guest-enter` 的二级〔裁〕：告知记在网站账号上，游客没有地方记）。
    // 所以这里等的是那句说明，不是告知框与回复 —— 2026-10-23 之前这里等告知框，产品改口径之后探针跟着改
    // **游客能不能用云端 Agent 还没定**（`claude/guest-enter` 列为待用户项：告知记在网站账号上，游客没有地方记）。
    // 所以这里**只记录不判定**：把聊天页上看到的头 160 个字记进步骤数据，等用户定了再改成断言。
    const gsay = gchat ? await G.evaluate(() => (document.querySelector('[data-pc="start-chat"]')?.textContent ?? '').slice(0, 160)).catch(() => null) : null;
    const gr = { guestChatText: gsay };
    step('11-guest-prompt', { chat: !!gchat, notice: gerr, ...(gr ?? {}) });
    check(!!gchat, '游客说一句话建出自己那一个项目并进聊天页', gerr);
    await shot(G, '11-guest-chat');
    await G.click('[data-pc="start-home"]').catch(() => {});
    const gList = await until('游客的项目列在侧栏', async () => { const l = await sideProjects(G); return l.length ? l : null; }, 20_000);
    const createBlocked = await G.evaluate(() => document.querySelector('[data-pc="start-side-new"]')?.disabled === true);
    step('12-guest-home', { gList, createBlocked });
    check(!!gList && createBlocked, '回首页列着游客自己的项目;游客已经建过一个,「新建项目」置灰', { gList, createBlocked });
    await shot(G, '12-guest-home-project');
    // 刷新:再以游客进来,还是同一个人、项目还在
    await G.reload({ waitUntil: 'domcontentloaded' });
    await G.waitForSelector('[data-pc="start-login-guest"]', { visible: true });
    await G.click('[data-pc="start-login-guest"]');
    await until('刷新后游客再进来', () => G.$('[data-pc="start-online"][data-guest="1"]'), 60_000);
    const sameName = await text(G, '[data-pc="start-account-name"]');
    const again = await until('刷新后游客项目还列着', async () => { const l = await sideProjects(G); return l.length ? l : null; }, 20_000);
    if (again) await G.click(`[data-pc="start-side-project"][data-project="${again[0].id}"]`);
    const reopened = again ? await until('游客点进自己的项目', () => G.$('[data-pc="start-chat"]'), 90_000) : null;
    const reopenErr = reopened ? null : await text(G, '[data-pc="start-notice"]');
    step('13-guest-reload', { sameName, sameGuest: sameName === guestName, again, reopened: !!reopened, reopenErr });
    check(sameName === guestName && !!again, '刷新后再以游客进来是同一个游客,项目还列着', { sameName, guestName });
    check(!!reopened, '游客能打开自己那一个项目', reopenErr);
    await shot(G, '13-guest-reopen');
  }

  out.pageErrors = { creator: P.errors, member: Q.errors, guest: G.errors };
  out.serverErrors = { creator: P.bad, member: Q.bad, guest: G.bad };
  check([P, Q, G].every((p) => p.errors.length === 0), '三个页面都没有未捕获的错误', out.pageErrors);
} catch (e) {
  fails.push(`探针异常:${e?.stack ?? e}`);
} finally {
  out.ok = fails.length === 0;
  out.fails = fails;
  await browser?.close().catch(() => {});
  for (const s of stageServers) { s.closeAllConnections?.(); await new Promise((r) => s.close(() => r())); }
  await fixture?.close?.().catch(() => {});
  console.log(JSON.stringify(out));
  process.exit(out.ok ? 0 : 1);
}
