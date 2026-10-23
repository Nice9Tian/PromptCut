/**
 * 云端 Agent 面板流畅度探针(分支 claude/agent-panel-smooth，0.7.18 发版验收在线实测的六条现象)。
 *
 * 真账号后端 + 本机隔离的托管组合(文档服务、素材服务、Agent HTTP 服务，读取通道是真的；夹具同 conversation-delete-probe.mjs，
 * 没有执行器，消息只排队不跑)。一个无头浏览器页面(项目创建者)只经 DOM 点击与输入操作，不注入页面状态、不伪造响应。
 *
 * 量什么(每项一行 PASS/FAIL；耗时只记录，按 verification.md「耗时只记录，不当闸门」不作通过条件，只有不看时间的断言算数)：
 *   R1  进项目后对话面板多久能输入(没有「正在确认对话权限」)——记录
 *   S1  点发送后输入框当场清空、对话里当场出现这条消息(「发送中…」或「已发出…」)，不等服务端回话——断言：按回车后 300 毫秒内出现
 *   S2  云端收下后气泡换成服务端那条，只有一条，不叠两条——断言
 *   N1  面板开着、空闲 30 秒：列对话、续会话、取成员名单、取通知各请求几次——记录；列对话不超过 12 次(整页一个 3 秒轮询)——断言
 *   O1  刷新页面再进项目：面板回到刚才那个对话(对话号相同、刚发的那条在)——断言；多久显示出来——记录
 *
 * 用法：node scripts/probes/agent-panel-smooth-probe.mjs --dist <dist-online> --site-root <VisuHive/site> --out <os-temp 下的子目录> [--base-port 5320]
 * 需要环境变量 PROMPTCUT_ACCOUNT_PROVIDER_ROOT、PROMPTCUT_PASSWORD_ORDER_MODULE。端口：从 --base-port 起连着 10 个(缺省 5320～5329)。
 */
import '../lib/no-user-dirs.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { editorSecurityHeaders, stageSecurityHeaders } from '../../src/online/stagePolicy.mjs';
import { startAccountConversationControlsUserFixture } from '../../server/test/fixtures/account-conversation-controls-user-path.mjs';

setTimeout(() => { console.error('SCRIPT_TIMEOUT'); process.exit(124); }, 600_000).unref();
const arg = flag => { const at = process.argv.indexOf(flag); return at < 0 ? null : process.argv[at + 1]; };
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.wasm': 'application/wasm' };
const TIMEOUT = 60_000;
const BASE = Number(arg('--base-port') ?? 5320);
const PORTS = Array.from({ length: 10 }, (_, i) => BASE + i);
const ORIGIN = `https://127.0.0.1:${BASE + 6}`, STAGES = [`http://s1.pc.localhost:${BASE + 8}`, `http://s2.pc.localhost:${BASE + 9}`];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
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
  const rel = path.relative(os.tmpdir(), OUT);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('--out-must-be-a-child-of-os-temp');
  const result = { checks: [], timings: {}, counts: {}, screenshots: [], pageErrors: [], notes: [], completed: false };
  const check = (condition, name, detail) => { result.checks.push({ name, pass: Boolean(condition), ...(detail !== undefined ? { detail } : {}) });
    console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' ' + JSON.stringify(detail) : ''}`); if (!condition) throw new Error(name); };
  const record = (name, value) => { result.timings[name] = value; console.log(`TIME ${name} ${JSON.stringify(value)}`); };
  let browser, fixture, phase = 'preflight';
  const stages = [], requests = [];
  const shotDir = path.join(OUT, 'shots');
  const shot = async (page, name) => { const file = path.join(shotDir, `${name}.png`); await page.screenshot({ path: file }); result.screenshots.push(file); };
  const panel = '[data-pc="cloud-ai-panel"]:not([data-inactive="1"])';
  const serve = stage => async (req, res) => {
    const url = new URL(req.url, ORIGIN), headers = stage ? stageSecurityHeaders(ORIGIN) : editorSecurityHeaders(STAGES);
    if (url.pathname === '/editor/runtime-config.json') { res.writeHead(200, { ...headers, 'content-type': 'application/json' }); res.end(JSON.stringify({ v: 1, stageOrigins: STAGES })); return; }
    const editor = url.pathname.startsWith('/editor'), root = editor || stage || url.pathname.startsWith('/catalog/') ? DIST : SITE;
    const name = editor ? (url.pathname.replace(/^\/editor\/?/, '') || 'index.html') : url.pathname.slice(1) || 'index.html';
    const file = path.resolve(root, name), relative = path.relative(root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) { res.writeHead(404); res.end(); return; }
    try { const bytes = await fs.readFile(file); res.writeHead(200, { ...headers, 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' }); res.end(req.method === 'HEAD' ? undefined : bytes); }
    catch { res.writeHead(404); res.end(); }
  };
  const fill = async (page, selector, text) => {
    await page.waitForSelector(selector, { visible: true, timeout: TIMEOUT });
    await page.focus(selector); await page.keyboard.down('Control'); await page.keyboard.press('KeyA');
    await page.keyboard.up('Control'); await page.keyboard.press('Backspace'); await page.type(selector, text);
  };
  const count = (from, to, test) => requests.filter(r => r.at >= from && r.at <= to && test(r)).length;

  try {
    await fs.access(path.join(DIST, 'index.html')); await fs.access(SITE);
    await fs.mkdir(shotDir, { recursive: true });
    for (const port of PORTS) check(await portFree(port), `port-${port}-available`);
    fixture = await startAccountConversationControlsUserFixture({ ports: PORTS.slice(0, 7), agentPort: BASE + 7, publicHandler: serve(false) });
    for (const port of [BASE + 8, BASE + 9]) {
      const sockets = new Set(), server = http.createServer((req, res) => { void serve(true)(req, res); });
      server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
      stages.push({ server, sockets, port });
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    }
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH ?? await puppeteer.executablePath();
    browser = await puppeteer.launch({ executablePath, headless: true, pipe: true, protocolTimeout: 90_000, userDataDir: path.join(OUT, 'chrome-profile'),
      args: [...PROBE_CHROME_ARGS, '--ignore-certificate-errors', '--host-resolver-rules=MAP s1.pc.localhost 127.0.0.1,MAP s2.pc.localhost 127.0.0.1'] });
    const page = await browser.newPage(); page.setDefaultTimeout(TIMEOUT);
    await page.setViewport({ width: 1500, height: 950 });
    page.on('pageerror', error => result.pageErrors.push(String(error?.message ?? error).slice(0, 160)));
    page.on('response', response => {
      const url = new URL(response.url());
      if (url.pathname.startsWith('/agent/') || url.pathname.startsWith('/hosted/shared/account/'))
        requests.push({ at: Date.now(), method: response.request().method(), status: response.status(),
          path: url.pathname.replace(/\/conversations\/[^/]+/g, '/conversations/:id'), ms: Math.round(response.timing()?.receiveHeadersEnd ?? -1) });
    });
    const account = fixture.accounts[0], projectName = 'Shared dual account project';

    phase = 'login';
    await page.goto(`${ORIGIN}/editor/`, { waitUntil: 'domcontentloaded' });
    await fill(page, 'input[name="username"]', account.name); await fill(page, 'input[name="password"]', account.password);
    const submit = '[data-pc="account-projects"] form button.sp-primary-btn';
    await page.waitForFunction(q => { const e = document.querySelector(q); return e && !e.disabled; }, {}, submit); await page.click(submit);
    await page.waitForSelector('[data-pc="account-name"]', { visible: true });

    const openProject = async () => {
      await page.waitForFunction(name => [...document.querySelectorAll('[data-pc="cloud-project-lists"] .sp-account-row')]
        .some(row => row.querySelector('button')?.textContent?.trim() === name), { timeout: TIMEOUT }, projectName);
      for (const row of await page.$$('[data-pc="cloud-project-lists"] .sp-account-row')) {
        if ((await row.$eval('button', e => e.textContent?.trim() ?? '').catch(() => '')) !== projectName) continue;
        const at = Date.now(); await (await row.$('button')).click(); return at;
      }
      throw new Error('project-row-not-found');
    };
    const dismissConsent = async () => {
      const dialog = await page.waitForSelector('[data-pc="cloud-agent-consent"]', { visible: true, timeout: 8000 }).catch(() => null);
      if (!dialog) return false;
      const buttons = await page.$$('[data-pc="cloud-agent-consent"] button'); await buttons[1].click();
      await page.waitForSelector('[data-pc="cloud-agent-consent"]', { hidden: true }); return true;
    };
    const composerReady = () => page.waitForFunction(q => document.querySelector(`${q} [data-pc="ai-input"]`) && !document.querySelector(`${q} [data-pc="cloud-permission-wait"]`)
      && !document.querySelector(`${q} [data-pc="cloud-permission-loading"]`), { timeout: TIMEOUT, polling: 50 }, panel);

    phase = 'enter-first';
    await openProject();
    await page.waitForSelector('[data-pc="cloud-project-copy"]', { visible: true });
    await dismissConsent();
    for (const close of await page.$$('.pc-toast:has([data-pc="cloud-project-copy"]) button[aria-label="关闭"]')) await close.click().catch(() => {});
    const enable = await page.$('[data-pc="cloud-agent-enable"]');
    if (enable) { await enable.click(); }
    await page.waitForSelector('[data-pc="cloud-off"]', { hidden: true });

    // ---------- R1：重新进项目(已同意过告知、开关已开)，量面板多久能输入 ----------
    phase = 'enter-measured';
    await page.goto(`${ORIGIN}/editor/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-pc="account-name"]', { visible: true });
    const clickedAt = await openProject();
    await page.waitForSelector('[data-pc="cloud-project-copy"]', { visible: true });
    const enteredAt = Date.now();
    await composerReady();
    const readyAt = Date.now();
    record('R1-click-to-composer-ready-ms', readyAt - clickedAt);
    record('R1-entered-to-composer-ready-ms', readyAt - enteredAt);
    for (const close of await page.$$('.pc-toast:has([data-pc="cloud-project-copy"]) button[aria-label="关闭"]')) await close.click().catch(() => {});
    await shot(page, '01-entered-composer-ready');

    // 同一张页面里回项目首页再进一次(像建完项目直接进去那样)：页面内存里的绑定版本不再是刷新后的那个数，
    // 之后的 O1 才能复现「刷新后找不到上次的对话」
    phase = 'leave-and-reenter';
    await page.click('[data-pc="members-button"]');
    await page.waitForSelector('[data-pc="account-project-home"]', { visible: true });
    await page.click('[data-pc="account-project-home"]');
    await page.waitForSelector('[data-pc="cloud-project-lists"]', { visible: true });
    await openProject();
    await page.waitForSelector('[data-pc="cloud-project-copy"]', { visible: true });
    for (const close of await page.$$('.pc-toast:has([data-pc="cloud-project-copy"]) button[aria-label="关闭"]')) await close.click().catch(() => {});
    await composerReady();

    // ---------- S1 / S2：点发送当场出气泡 ----------
    phase = 'send';
    const prompt = '把片头的标题改成「流畅度探针」';
    await fill(page, `${panel} [data-pc="ai-input"]`, prompt);
    const before = await page.$$eval(`${panel} .ai-row--user`, rows => rows.length);
    await page.evaluate(() => { window.__pcProbeBubble = new Promise(resolve => {
      const t0 = performance.now();
      const seen = () => document.querySelectorAll('[data-pc="cloud-ai-panel"]:not([data-inactive="1"]) .ai-row--user').length;
      const start = seen();
      const ob = new MutationObserver(() => { if (seen() > start) { ob.disconnect(); resolve({ ms: performance.now() - t0,
        input: document.querySelector('[data-pc="cloud-ai-panel"]:not([data-inactive="1"]) [data-pc="ai-input"]')?.value ?? null,
        state: document.querySelector('[data-pc="cloud-send-state"]')?.getAttribute('data-state') ?? null }); } });
      ob.observe(document.body, { childList: true, subtree: true });
      window.__pcProbeT0 = t0;
    }); });
    const postWait = page.waitForResponse(r => r.request().method() === 'POST' && /\/agent\/v1\/conversations\/[^/]+\/messages$/.test(new URL(r.url()).pathname));
    const sentAt = Date.now();
    await page.keyboard.press('Enter');
    const bubble = await page.evaluate(() => window.__pcProbeBubble);
    record('S1-enter-to-bubble-ms(in-page)', Math.round(bubble.ms));
    await shot(page, '02-right-after-enter');
    check(bubble.ms !== null, 'S1-bubble-appears-on-enter(ms 只记录,见上面 record;耗时只记录,不当闸门(verification.md,2026-10-07 用户改定);2026-10-23 探针总审改)', { ms: Math.round(bubble.ms), before });
    check(bubble.input === '', 'S1-input-cleared-immediately', { input: bubble.input });
    check(bubble.state === 'sending' || bubble.state === 'accepted', 'S1-bubble-says-sending-not-sent', { state: bubble.state });
    const post = await postWait;
    record('S1-post-messages-status', post.status());
    record('S1-enter-to-post-202-ms', Date.now() - sentAt);
    const conversationId = await page.evaluate(() => window.__pcCloud?.main?.conversationId?.() ?? null);
    await page.waitForFunction(() => document.querySelector('[data-pc="cloud-ai-panel"]:not([data-inactive="1"]) [data-pc-msg^="cq-"]'), { timeout: TIMEOUT });
    record('S2-enter-to-server-record-ms', Date.now() - sentAt);
    const users = await page.$$eval(`${panel} .ai-row--user`, rows => rows.map(r => ({ id: r.getAttribute('data-pc-msg'), text: r.textContent?.trim().slice(0, 40) })));
    check(users.filter(u => u.text?.includes('流畅度探针')).length === 1 && users.some(u => u.id?.startsWith('cq-')), 'S2-one-bubble-replaced-by-server-record', users);
    await sleep(600);
    await shot(page, '03-after-server-record');

    // ---------- N1：空闲 30 秒的请求数 ----------
    phase = 'idle-requests';
    const idleFrom = Date.now();
    await sleep(30_000);
    const idleTo = Date.now();
    const counts = {
      listConversations: count(idleFrom, idleTo, r => r.method === 'GET' && r.path === '/agent/v1/conversations'),
      notices: count(idleFrom, idleTo, r => r.path === '/agent/v1/notices'),
      info: count(idleFrom, idleTo, r => r.path === '/agent/v1/info'),
      accountSession: count(idleFrom, idleTo, r => r.path === '/hosted/shared/account/session'),
      accountMembers: count(idleFrom, idleTo, r => r.path === '/hosted/shared/account/members'),
    };
    result.counts.idle30s = counts;
    console.log('COUNT idle30s ' + JSON.stringify(counts));
    const listMs = requests.filter(r => r.method === 'GET' && r.path === '/agent/v1/conversations' && r.ms >= 0).map(r => r.ms);
    record('N1-list-conversations-header-ms(median)', listMs.length ? listMs.sort((a, b) => a - b)[Math.floor(listMs.length / 2)] : null);
    check(counts.listConversations <= 12, 'N1-one-list-poller-per-page', counts);

    // ---------- O1：刷新页面再进项目，回到刚才的对话 ----------
    phase = 'reopen';
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-pc="account-name"]', { visible: true }).catch(() => {});
    const reopenClick = await (async () => {
      const inProject = await page.$('[data-pc="cloud-ai-panel"]');
      return inProject ? Date.now() : openProject();
    })();
    await page.waitForFunction(text => [...document.querySelectorAll('[data-pc="cloud-ai-panel"]:not([data-inactive="1"]) .ai-row--user')]
      .some(row => row.textContent?.includes(text)), { timeout: TIMEOUT }, '流畅度探针').catch(() => {});
    record('O1-reopen-to-last-conversation-shown-ms', Date.now() - reopenClick);
    const after = await page.evaluate(() => window.__pcCloud?.main?.conversationId?.() ?? null);
    const shown = await page.$$eval(`${panel} .ai-row--user`, rows => rows.map(r => r.textContent?.trim().slice(0, 40)));
    await shot(page, '04-after-reopen');
    check(after === conversationId && shown.some(t => t?.includes('流畅度探针')), 'O1-reopen-returns-to-last-conversation', { before: conversationId, after, shown });
    await composerReady();
    record('O1-reopen-to-composer-ready-ms', Date.now() - reopenClick);

    result.completed = true;
    check(result.pageErrors.length === 0, 'no-page-errors', result.pageErrors);
  } catch (error) {
    result.failure = { phase, message: String(error?.message ?? error) };
    console.error('FAILED', phase, error?.message);
    process.exitCode = 1;
  } finally {
    await browser?.close().catch(() => {});
    for (const stage of stages) await closeServer(stage).catch(() => {});
    const closed = await fixture?.close().catch(() => ({ closed: false })) ?? { closed: true };
    result.requests = requests.map(r => ({ ...r, at: r.at - (requests[0]?.at ?? 0) }));
    result.cleanup = { fixtureClosed: closed.closed === true, portsFree: Object.fromEntries(await Promise.all(PORTS.map(async p => [String(p), await portFree(p)]))) };
    await fs.writeFile(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ completed: result.completed, checks: result.checks.length, failed: result.checks.filter(c => !c.pass).length,
      pageErrors: result.pageErrors.length, closed: result.cleanup.fixtureClosed, output: OUT }));
  }
}

const invoked = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  try { await main(); }
  catch (error) { console.error(JSON.stringify({ completed: false, code: String(error?.message ?? error) })); process.exitCode = 1; }
}
void fileURLToPath;
