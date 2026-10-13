/**
 * 0.7.18 v18-newchat 的浏览器探针：新开一个还没发过消息的云端对话，页面是不是安静的空对话。
 *
 * 真账号后端 + 本机隔离的托管组合(文档服务、素材服务、Agent HTTP 服务)，Agent 服务装着真执行器，只有模型是仓库里现成的 mock 提供方；
 * Agent 服务前面是夹具里的边缘代理(上游连接被掐时它回 502，和生产一样)；读取通道是真的(`createConversationClient` + 读取控制)。
 * 两个无头浏览器页面(创建者 creator、普通成员 member)只经 DOM 点击与输入操作，不注入页面状态、不伪造响应。
 *
 * 场景：
 *   A  进项目后停在从没发过消息的新对话上，看 30 秒(事件流请求的状态码、页面上的断线提示、请求有没有一直重试)
 *   B  点「新对话」再开一个，看 30 秒
 *   C  在新对话里发第一条消息，回复照常出现、事件流接上
 *   D  刷新页面(停在有内容的对话上；停在没发过消息的新对话上)、换到别的对话再换回来
 *   E  真故障一：成员正看着一个共有对话，创建者把它设为私有
 *   F  真故障二：Agent 服务停掉
 *
 * 用法：node scripts/probes/newchat-events-probe.mjs --dist <dist-online> --site-root <VisuHive/site> --out <os-temp 下的子目录> [--label before|after] [--quick]
 * 需要环境变量 PROMPTCUT_ACCOUNT_PROVIDER_ROOT、PROMPTCUT_PASSWORD_ORDER_MODULE。端口 28850～28861。
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

// 夹具里起的 http.Server 按端口记下来：「Agent 服务停掉」要从探针进程里关掉那一个。
const created = [];
const originalCreateServer = http.createServer;
http.createServer = function patched(...args) { const server = originalCreateServer.apply(this, args); created.push(server); return server; };
const { startAccountRealRunnerFixture } = await import('../../server/test/fixtures/account-real-runner.mjs');

const arg = flag => { const at = process.argv.indexOf(flag); return at < 0 ? null : process.argv[at + 1]; };
const has = flag => process.argv.includes(flag);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.wasm': 'application/wasm' };
const TIMEOUT = 45_000;
const PORTS = [28850, 28851, 28852, 28853, 28854, 28855, 28856];
const AGENT_PORT = 28857, CONTROL_PORT = 28858, STAGE_PORTS = [28860, 28861];
const ALL_PORTS = [...PORTS, AGENT_PORT, CONTROL_PORT, ...STAGE_PORTS];
const ORIGIN = `https://127.0.0.1:${PORTS[6]}`, STAGES = STAGE_PORTS.map((port, i) => `http://s${i + 1}.pc.localhost:${port}`);
const REPLY = '收到，这是云端 Agent 对第一条消息的回复。';
const PROMPT = '你好，先随便回一句。\n```mock-script\n' + JSON.stringify([{ say: REPLY }]) + '\n```';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fill = async (page, selector, text) => {
  await page.waitForSelector(selector, { visible: true, timeout: TIMEOUT }); await page.focus(selector);
  await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control'); await page.keyboard.press('Backspace');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (i) { await page.keyboard.down('Shift'); await page.keyboard.press('Enter'); await page.keyboard.up('Shift'); }
    await page.type(selector, lines[i]);
  }
};
const enabled = (page, selector) => page.waitForFunction(query => { const e = document.querySelector(query); return e && !e.disabled; }, { timeout: TIMEOUT }, selector);
const portFree = port => new Promise(resolve => {
  const socket = net.createConnection({ host: '127.0.0.1', port });
  socket.once('connect', () => { socket.destroy(); resolve(false); });
  socket.once('error', error => resolve(error.code === 'ECONNREFUSED'));
  socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
});
const closeStage = async entry => {
  for (const socket of entry.sockets) socket.destroy();
  if (entry.server.listening) await new Promise(resolve => entry.server.close(resolve));
};

async function main() {
  const distArg = arg('--dist'), siteArg = arg('--site-root'), outArg = arg('--out'), label = arg('--label') ?? 'run';
  if (!distArg || !siteArg || !outArg) throw new Error('required-flags:--dist --site-root --out');
  const quick = has('--quick');
  const DIST = path.resolve(distArg), SITE = path.resolve(siteArg), OUT = path.resolve(outArg);
  const rel = path.relative(os.tmpdir(), OUT);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('--out-must-be-a-child-of-os-temp');
  const result = { label, scenarios: [], checks: [], screenshots: [], pageErrors: [], notes: [], completed: false };
  const check = (condition, name) => { result.checks.push({ name, pass: Boolean(condition) }); console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`); };
  const shotDir = path.join(OUT, 'shots');
  await fs.mkdir(shotDir, { recursive: true });
  let browser, fixture, phase = 'preflight';
  const stages = [], contexts = [], pages = [];
  const names = ['creator', 'member'];
  const panel = '[data-pc="cloud-ai-panel"]:not([data-inactive="1"])';
  const shot = async (page, name) => {
    await sleep(300);
    const file = path.join(shotDir, `${label}-${name}.png`);
    await page.screenshot({ path: file });
    result.screenshots.push(file);
  };

  const serve = stage => async (req, res) => {
    const url = new URL(req.url, ORIGIN), headers = stage ? stageSecurityHeaders(ORIGIN) : editorSecurityHeaders(STAGES);
    if (url.pathname === '/editor/runtime-config.json') { res.writeHead(200, { ...headers, 'content-type': 'application/json' }); res.end(JSON.stringify({ v: 1, stageOrigins: STAGES })); return; }
    if (url.pathname === '/editor/_iso/ok') { res.writeHead(204, headers); res.end(); return; }
    if (url.pathname === '/editor/_iso/redirect') { res.writeHead(302, { ...headers, location: '/editor/_iso/ok' }); res.end(); return; }
    const editor = url.pathname.startsWith('/editor'), root = editor || stage || url.pathname.startsWith('/catalog/') ? DIST : SITE;
    const name = editor ? (url.pathname.replace(/^\/editor\/?/, '') || 'index.html') : url.pathname.slice(1) || 'index.html';
    const file = path.resolve(root, name), relative = path.relative(root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) { res.writeHead(404); res.end(); return; }
    try { const bytes = await fs.readFile(file); res.writeHead(200, { ...headers, 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' }); res.end(req.method === 'HEAD' ? undefined : bytes); }
    catch { res.writeHead(404); res.end(); }
  };

  // ---------- 页面上的小工具 ----------
  const login = async (page, account) => {
    await page.goto(`${ORIGIN}/editor/`, { waitUntil: 'domcontentloaded' });
    await fill(page, 'input[name="username"]', account.name); await fill(page, 'input[name="password"]', account.password);
    const submit = '[data-pc="account-projects"] form button.sp-primary-btn'; await enabled(page, submit); await page.click(submit);
    await page.waitForSelector('[data-pc="account-name"]', { visible: true, timeout: TIMEOUT });
  };
  const consent = async page => {
    const dialog = await page.waitForSelector('[data-pc="cloud-agent-consent"]', { visible: true, timeout: 8000 }).catch(() => null);
    if (!dialog) return;
    const buttons = await page.$$('[data-pc="cloud-agent-consent"] button'); await buttons[1].click();
    await page.waitForSelector('[data-pc="cloud-agent-consent"]', { hidden: true, timeout: TIMEOUT });
  };
  let projectName = '';
  const openProject = async page => {
    await page.waitForFunction(name => [...document.querySelectorAll('[data-pc="cloud-project-lists"] .sp-account-row')]
      .some(row => row.querySelector('button')?.textContent?.trim() === name), { timeout: TIMEOUT }, projectName);
    for (const row of await page.$$('[data-pc="cloud-project-lists"] .sp-account-row')) {
      if ((await row.$eval('button', e => e.textContent?.trim() ?? '').catch(() => '')) !== projectName) continue;
      await (await row.$('button')).click(); break;
    }
    await page.waitForSelector('[data-pc="cloud-project-copy"]', { visible: true, timeout: TIMEOUT });
    await consent(page);
    for (const close of await page.$$('.pc-toast:has([data-pc="cloud-project-copy"]) button[aria-label="关闭"]')) await close.click().catch(() => {});
    await page.waitForFunction(() => Boolean(window.__pcCloud?.main), { timeout: TIMEOUT });
  };
  const reopen = async page => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    const landed = await page.waitForSelector('[data-pc="account-name"]', { visible: true, timeout: 15_000 }).then(() => true, () => false);
    if (!landed) throw new Error('reload-lost-login');
    await openProject(page);
  };
  const convId = page => page.evaluate(() => window.__pcCloud?.main?.conversationId?.() ?? null);
  const openHistory = async page => {
    for (let attempt = 0; ; attempt++) {
      await page.click(`${panel} button[title*="历史"]`);
      const opened = await page.waitForSelector('[data-pc="chat-new"]', { visible: true, timeout: 6000 }).then(() => true, () => false);
      if (opened) return;
      if (attempt >= 3) throw new Error('history-drawer-did-not-open');
      await page.click('.chat-drawer-close-btn').catch(() => {});
    }
  };
  const newChat = async page => {
    page.mark = page.evLog.length;
    const before = await convId(page);
    await openHistory(page);
    await page.click('[data-pc="chat-new"]');
    await page.waitForFunction(was => window.__pcCloud?.main?.conversationId?.() !== was, { timeout: TIMEOUT }, before);
    await page.waitForSelector('.chat-history-drawer', { hidden: true, timeout: TIMEOUT }).catch(() => {});
  };
  const pickFromHistory = async (page, id) => {
    page.mark = page.evLog.length;
    for (let i = 0; i < 12; i++) {
      await openHistory(page);
      const found = await page.waitForSelector(`[data-pc="chat-cloud-item"][data-chat-id="${id}"]`, { visible: true, timeout: 2500 }).then(() => true, () => false);
      if (found) { await page.click(`[data-pc="chat-cloud-item"][data-chat-id="${id}"]`); break; }
      await page.click('.chat-drawer-close-btn').catch(() => {});
      if (i === 11) throw new Error('history-row-not-found');
    }
    await page.waitForFunction(want => window.__pcCloud?.main?.conversationId?.() === want, { timeout: TIMEOUT }, id);
  };
  const state = page => page.evaluate(() => {
    const view = window.__pcCloud?.main?.view?.() ?? null;
    const header = document.querySelector('[data-pc="cloud-ai-panel"]:not([data-inactive="1"]) .ai-status-dot');
    return {
      conversationId: window.__pcCloud?.main?.conversationId?.() ?? null,
      connection: view?.connection ?? null, problem: view?.problem ?? null, lastSeq: view?.lastSeq ?? null,
      banner: document.querySelector('[data-pc="cloud-reconnecting"]')?.textContent?.trim() ?? null,
      notice: document.querySelector('[data-pc="cloud-notice"]')?.textContent?.trim() ?? null,
      statusDot: header?.getAttribute('title') ?? null,
      userMessages: document.querySelectorAll('[data-pc-msg^="cq-"]').length,
      assistantMessages: document.querySelectorAll('[data-pc-msg^="ca-"]').length,
    };
  });

  /** 观察一段时间：每秒取一次页面状态，并统计这段时间里这张页面发出的事件流请求。 */
  const observe = async (page, who, name, ms, { shotAt = [3000], fromIndex = null } = {}) => {
    const t0 = Date.now(), from = fromIndex ?? page.mark ?? page.evLog.length, samples = [];
    page.mark = null;
    const shots = new Set(shotAt);
    while (Date.now() - t0 < ms) {
      const at = Date.now() - t0;
      const s = await state(page); samples.push({ at, connection: s.connection, banner: Boolean(s.banner), notice: s.notice, problem: s.problem });
      for (const wanted of [...shots]) if (at >= wanted) { shots.delete(wanted); await shot(page, `${name}-t${Math.round(wanted / 1000)}s`); }
      await sleep(1000);
    }
    const last = await state(page);
    await shot(page, `${name}-end`);
    const reqs = page.evLog.slice(from);
    const statuses = {};
    for (const r of reqs) statuses[r.status ?? 'none'] = (statuses[r.status ?? 'none'] ?? 0) + 1;
    const lastWindow = reqs.filter(r => r.at - t0 >= Math.max(0, ms - 10_000) && r.at - t0 <= ms + 1500).length;
    const bodies = [...new Set(reqs.map(r => r.body).filter(Boolean))];
    const summary = { scenario: name, who, ms, eventsRequests: reqs.length, statuses, errorBodies: bodies, requestsInLast10s: lastWindow,
      bannerSeen: samples.filter(s => s.banner).length, bannerAtEnd: Boolean(last.banner), connectionsSeen: [...new Set(samples.map(s => s.connection))],
      final: last };
    result.scenarios.push(summary);
    console.log(JSON.stringify(summary));
    return summary;
  };

  try {
    await fs.access(path.join(DIST, 'index.html')); await fs.access(SITE);
    for (const port of ALL_PORTS) if (!await portFree(port)) throw new Error(`port-${port}-not-free`);
    fixture = await startAccountRealRunnerFixture({ publicHandler: serve(false), ports: PORTS, agentPort: AGENT_PORT, controlPort: CONTROL_PORT });
    for (const port of STAGE_PORTS) {
      const sockets = new Set(), server = originalCreateServer((req, res) => { void serve(true)(req, res); });
      server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
      stages.push({ server, sockets, port });
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    }
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH ?? await puppeteer.executablePath();
    browser = await puppeteer.launch({ executablePath, headless: true, pipe: true, userDataDir: path.join(OUT, 'chrome-profile'),
      args: [...PROBE_CHROME_ARGS, '--ignore-certificate-errors', '--host-resolver-rules=MAP s1.pc.localhost 127.0.0.1,MAP s2.pc.localhost 127.0.0.1'] });
    for (let i = 0; i < 2; i++) {
      const context = await browser.createBrowserContext(); contexts.push(context);
      const page = await context.newPage(); pages.push(page); page.setDefaultTimeout(TIMEOUT);
      await page.setViewport({ width: 1600, height: 1000 });
      page.evLog = [];
      page.on('pageerror', error => result.pageErrors.push({ page: names[i], message: String(error?.message ?? error).slice(0, 160) }));
      page.on('request', request => {
        const url = new URL(request.url());
        if (url.pathname.startsWith('/agent/') && url.pathname.endsWith('/events')) request.evEntry = { at: Date.now(), status: null, url: url.pathname.replace(/\/conversations\/[^/]+/, '/conversations/:id') };
        if (request.evEntry) page.evLog.push(request.evEntry);
      });
      page.on('response', response => {
        const entry = response.request().evEntry;
        if (!entry) return;
        entry.status = response.status();
        if (entry.status >= 400) void response.text().then(text => { entry.body = text.slice(0, 160); }).catch(() => {});
      });
      page.on('requestfailed', request => { if (request.evEntry) request.evEntry.status = `failed:${request.failure()?.errorText ?? ''}`; });
      page.on('response', response => {
        const url = new URL(response.url());
        if (url.pathname === '/hosted/shared/account/create' && response.status() === 201)
          void response.json().then(body => { if (/^sp_[a-z0-9]{26}$/.test(body.projectId)) page.createdProjectId = body.projectId; }).catch(() => {});
        if (url.pathname.startsWith('/agent/') && !url.pathname.endsWith('/events'))
          result.notes.push({ page: names[i], method: response.request().method(), status: response.status(), path: url.pathname.replace(/\/conversations\/[^/]+/, '/conversations/:id') });
      });
      await login(page, fixture.accounts[i]);
    }
    const [creator, member] = pages;

    phase = 'create-project';
    await enabled(creator, '[data-pc="cloud-create"]');
    projectName = 'Newchat probe project';
    await fill(creator, '[data-pc="cloud-project-name"]', projectName); await creator.click('[data-pc="cloud-create"]');
    await creator.waitForSelector('[data-pc="cloud-project-copy"]', { visible: true, timeout: TIMEOUT }); await consent(creator);
    await enabled(creator, '[data-pc="cloud-agent-enable"]');
    // 先让成员加入，再开云端 Agent：之后创建者页和成员页都从「刚开好、还没发过消息」起步
    const projectId = creator.createdProjectId;
    if (!projectId) throw new Error('created-project-id-missing');
    await creator.click('[data-pc="cloud-agent-enable"]');
    await creator.waitForSelector('[data-pc="cloud-off"]', { hidden: true, timeout: TIMEOUT });
    await creator.waitForFunction(() => Boolean(window.__pcCloud?.main), { timeout: TIMEOUT });

    // ---------- A：停在从没发过消息的新对话上 ----------
    phase = 'A-fresh-initial';
    const idA = await convId(creator);
    result.notes.push({ A_conversationId: idA });
    await observe(creator, 'creator', 'A-fresh-initial', quick ? 12_000 : 30_000, { shotAt: [3000, quick ? 11_000 : 29_000], fromIndex: 0 });

    // ---------- B：点「新对话」 ----------
    phase = 'B-new-chat-click';
    await newChat(creator);
    await observe(creator, 'creator', 'B-new-chat-click', quick ? 8000 : 30_000, { shotAt: [3000] });

    // ---------- C：发第一条消息 ----------
    phase = 'C-first-message';
    const idC = await convId(creator);
    const from = creator.evLog.length;
    await fill(creator, `${panel} [data-pc="ai-input"]`, PROMPT); await creator.keyboard.press('Enter');
    await creator.waitForFunction(text => document.querySelector('.ai-messages')?.textContent?.includes(text), { timeout: TIMEOUT }, REPLY).catch(() => {});
    // 「显示思考」没开时助手正文可能折叠：开了再看
    let replyVisible = await creator.evaluate(text => document.querySelector('.ai-messages')?.textContent?.includes(text) ?? false, REPLY);
    if (!replyVisible) {
      for (const button of await creator.$$('button')) if (await button.evaluate(el => el.textContent?.includes('显示思考'))) { await button.click(); break; }
      for (const head of await creator.$$('[data-pc-msg^="ca-"] .ai-rawlog-head')) { if (await head.evaluate(el => el.getAttribute('aria-expanded') !== 'true')) await head.click().catch(() => {}); }
      replyVisible = await creator.waitForFunction(text => document.querySelector('.ai-messages')?.textContent?.includes(text), { timeout: 15_000 }, REPLY).then(() => true, () => false);
    }
    await sleep(1500);
    const afterSend = await state(creator);
    await shot(creator, 'C-after-first-message');
    const cReqs = creator.evLog.slice(from);
    result.scenarios.push({ scenario: 'C-first-message', conversationId: idC, replyVisible, eventsStatuses: cReqs.map(r => r.status), final: afterSend });
    console.log(JSON.stringify({ scenario: 'C', replyVisible, eventsStatuses: cReqs.map(r => r.status), connection: afterSend.connection, banner: afterSend.banner }));

    // ---------- D：刷新、换对话再换回 ----------
    phase = 'D-reload';
    let mark = creator.evLog.length;
    await reopen(creator);
    await observe(creator, 'creator', 'D1-reload-on-conversation-with-messages', quick ? 6000 : 10_000, { shotAt: [4000], fromIndex: mark });
    await newChat(creator);
    await observe(creator, 'creator', 'D2-new-chat-after-reload', quick ? 6000 : 10_000, { shotAt: [4000] });
    const idFresh = await convId(creator);
    mark = creator.evLog.length;
    await reopen(creator);
    const idAfterReload = await convId(creator);
    result.notes.push({ D3_reloadOnUnsentChatKeepsId: idAfterReload === idFresh });
    await observe(creator, 'creator', 'D3-reload-on-unsent-new-chat', quick ? 8000 : 15_000, { shotAt: [4000], fromIndex: mark });
    await pickFromHistory(creator, idC);
    await creator.waitForFunction(text => document.querySelector('.ai-messages')?.textContent?.includes(text) || document.querySelector('[data-pc-msg^="cq-"]'), { timeout: TIMEOUT }, REPLY);
    await observe(creator, 'creator', 'D4-switch-back-to-conversation-with-messages', quick ? 5000 : 8000, { shotAt: [3000] });
    await newChat(creator);
    await observe(creator, 'creator', 'D5-switch-to-another-new-chat', quick ? 5000 : 8000, { shotAt: [3000] });
    await pickFromHistory(creator, idC);
    await observe(creator, 'creator', 'D6-switch-back-again', quick ? 4000 : 6000, { shotAt: [3000] });

    // ---------- E：成员正看着共有对话，创建者把它设为私有 ----------
    phase = 'E-private';
    await member.waitForSelector('[data-pc="cloud-project-link"]', { visible: true, timeout: TIMEOUT }).catch(() => {});
    await enabled(member, '[data-pc="cloud-join"]');
    await fill(member, '[data-pc="cloud-project-link"]', `${ORIGIN}/editor?project=${encodeURIComponent(projectId)}`); await member.click('[data-pc="cloud-join"]');
    await member.waitForSelector('[data-pc="cloud-project-copy"]', { visible: true, timeout: TIMEOUT }); await consent(member);
    await member.waitForFunction(() => Boolean(window.__pcCloud?.main), { timeout: TIMEOUT });
    await member.waitForFunction(() => document.querySelector('[data-pc="cloud-off"]') === null, { timeout: TIMEOUT });
    await observe(member, 'member', 'E0-member-own-fresh-chat', quick ? 6000 : 10_000, { shotAt: [4000], fromIndex: 0 });
    await pickFromHistory(member, idC);
    await member.waitForFunction(() => document.querySelector('[data-pc-msg^="cq-"]'), { timeout: TIMEOUT });
    await observe(member, 'member', 'E1-member-views-shared-conversation', 5000, { shotAt: [] });
    const toggle = '[data-pc="cloud-visibility-toggle"]';
    await creator.waitForSelector(toggle, { visible: true, timeout: TIMEOUT });
    const toggleText = await creator.$eval(toggle, e => e.textContent?.trim());
    result.notes.push({ E_toggleButtonText: toggleText });
    await creator.click(toggle);
    await sleep(2000);
    result.notes.push({ E_creatorControlStatus: await creator.$eval('[data-pc="cloud-control-status"]', e => e.textContent?.trim()).catch(() => null) });
    await observe(member, 'member', 'E2-member-after-creator-set-private', quick ? 12_000 : 20_000, { shotAt: [3000, quick ? 11_000 : 19_000] });

    // 成员刷新页面：记着的就是这个已经对他不可读的对话(它不是页面刚建的新对话)
    const markE3 = member.evLog.length;
    await reopen(member);
    await observe(member, 'member', 'E3-member-reloads-onto-now-private-conversation', quick ? 8000 : 15_000, { shotAt: [4000, quick ? 7000 : 14_000], fromIndex: markE3 });

    // ---------- F：Agent 服务停掉 ----------
    phase = 'F-agent-down';
    await pickFromHistory(creator, idC).catch(() => {});
    await observe(creator, 'creator', 'F0-before-agent-down', 3000, { shotAt: [] });
    const agentServer = created.find(server => { try { return server.address()?.port === AGENT_PORT; } catch { return false; } });
    if (!agentServer) throw new Error('agent-server-not-found');
    agentServer.close(); agentServer.closeAllConnections?.();
    result.notes.push({ F_agentStoppedAt: Date.now() });
    await observe(creator, 'creator', 'F1-agent-down-on-open-conversation', quick ? 15_000 : 55_000, { shotAt: [5000, quick ? 14_000 : 54_000] });
    await newChat(creator);
    await observe(creator, 'creator', 'F2-new-chat-while-agent-down', quick ? 8000 : 15_000, { shotAt: [4000] });

    result.completed = true;
    check(result.pageErrors.length === 0, 'no-page-errors');
  } catch (error) {
    result.failure = { phase, message: String(error?.message ?? error) };
    console.error('FAILED', phase, error?.stack ?? error?.message);
    for (let i = 0; i < pages.length; i++) await shot(pages[i], `failure-${names[i]}`).catch(() => {});
    process.exitCode = 1;
  } finally {
    for (const context of contexts) await context.close().catch(() => {});
    await browser?.close().catch(() => {});
    for (const stage of stages) await closeStage(stage).catch(() => {});
    const closed = await fixture?.close().catch(error => ({ closed: false, error: String(error?.message ?? error) })) ?? { closed: true };
    result.cleanup = { fixtureClosed: closed.closed === true, portsFree: Object.fromEntries(await Promise.all(ALL_PORTS.map(async p => [String(p), await portFree(p)]))) };
    await fs.writeFile(path.join(OUT, `result-${label}.json`), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ completed: result.completed, scenarios: result.scenarios.length, pageErrors: result.pageErrors.length, closed: result.cleanup.fixtureClosed, output: OUT }));
  }
}

const invoked = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  try { await main(); }
  catch (error) { console.error(JSON.stringify({ completed: false, code: String(error?.message ?? error) })); process.exitCode = 1; }
}
void fileURLToPath;
