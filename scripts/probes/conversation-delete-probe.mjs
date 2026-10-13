/**
 * 0.7.18 块五「50 个对话与删除」的浏览器探针：真账号后端 + 本机隔离的托管组合(文档服务、素材服务、Agent HTTP 服务)，三个账号各开一个
 * 无头浏览器页面(项目创建者 creator、开对话的人 owner、普通成员 member)。页面只经 DOM 点击与输入操作，不注入页面状态、不伪造响应。
 * 唯一的「造数据」是满额那一段：往文档服务的账本里直接放 49 个 owner 的空对话行(和测试夹具往数据库里放行一样)，
 * 免得在界面上点 49 次发送；第 50、第 51 个都由界面真发。
 *
 * 用法：node scripts/probes/conversation-delete-probe.mjs --dist <dist-online> --site-root <VisuHive/site> --out <os-temp 下的子目录>
 * 需要环境变量 PROMPTCUT_ACCOUNT_PROVIDER_ROOT、PROMPTCUT_PASSWORD_ORDER_MODULE。端口 28180～28189。
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
import { openAccountLedger } from '../../server/account/ledger.mjs';
import { hostedPaths } from '../../server/hosted/combo.mjs';
import { CLOUD_CHAT_TEXT, cloudNoticeText } from '../../src/ai/cloud/chatTexts.ts';

const arg = flag => { const at = process.argv.indexOf(flag); return at < 0 ? null : process.argv[at + 1]; };
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.wasm': 'application/wasm' };
const TIMEOUT = 45_000;
const PORTS = [28180, 28181, 28182, 28183, 28184, 28185, 28186, 28187, 28188, 28189];
const ORIGIN = 'https://127.0.0.1:28186', STAGES = ['http://s1.pc.localhost:28188', 'http://s2.pc.localhost:28189'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fill = async (page, selector, text) => {
  await page.waitForSelector(selector, { visible: true, timeout: TIMEOUT });
  await page.focus(selector); await page.keyboard.down('Control'); await page.keyboard.press('KeyA');
  await page.keyboard.up('Control'); await page.keyboard.press('Backspace'); await page.type(selector, text);
};
const enabled = (page, selector) => page.waitForFunction(query => { const e = document.querySelector(query); return e && !e.disabled; }, { timeout: TIMEOUT }, selector);
const waitVisible = (page, selector) => page.waitForSelector(selector, { visible: true, timeout: TIMEOUT });
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
  const result = { checks: [], network: [], screenshots: [], pageErrors: [], notes: [], completed: false };
  const check = (condition, name) => { result.checks.push({ name, pass: Boolean(condition) }); console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`); if (!condition) throw new Error(name); };
  const labels = ['creator', 'owner', 'member'];
  let browser, fixture, phase = 'preflight', seedLedger;
  const stages = [], contexts = [], pages = [];
  const shotDir = path.join(OUT, 'shots');
  const shot = async (page, name) => { await sleep(450); const file = path.join(shotDir, `${name}.png`); await page.screenshot({ path: file }); result.screenshots.push(file); };

  // ---------- 页面上的小工具 ----------
  const panel = '[data-pc="cloud-ai-panel"]:not([data-inactive="1"])';
  const toastTexts = page => page.evaluate(() => [...document.querySelectorAll('.pc-toast')].map(e => (e.textContent ?? '').trim()));
  const waitToast = async (page, includes, timeout = 40_000) => {
    await page.waitForFunction(text => [...document.querySelectorAll('.pc-toast')].some(e => (e.textContent ?? '').includes(text)), { timeout }, includes);
  };
  const currentConversationId = page => page.evaluate(() => window.__pcCloud?.main?.conversationId?.() ?? null);
  const sendMessage = async (page, text) => {
    await fill(page, `${panel} [data-pc="ai-input"]`, text);
    await page.keyboard.press('Enter');
  };
  const openHistory = async page => {
    await page.waitForSelector(`${panel} button[title*="历史"]`, { visible: true, timeout: TIMEOUT });
    // 点一下没打开(面板正好在重绘)就再点；两次都没开记下页面状态
    for (let attempt = 0; ; attempt++) {
      await page.click(`${panel} button[title*="历史"]`);
      const opened = await page.waitForSelector('[data-pc="chat-cloud-group"]', { visible: true, timeout: 6000 }).then(() => true, () => false);
      if (opened) break;
      const state = await page.evaluate(() => ({ drawer: Boolean(document.querySelector('.chat-history-drawer')), dialog: Boolean(document.querySelector('[data-pc="cloud-delete-chat"],[data-pc="cloud-agent-consent"]')),
        panel: document.querySelectorAll('[data-pc="cloud-ai-panel"]').length, conn: document.querySelector('[data-pc="cloud-reconnecting"]') !== null }));
      result.notes.push({ openHistoryRetry: attempt, ...state });
      if (attempt >= 3) throw new Error('history-drawer-did-not-open');
      if (state.drawer) await page.click('.chat-drawer-close-btn').catch(() => {});
    }
    await page.waitForFunction(() => { const e = document.querySelector('[data-pc="chat-cloud-group"] .chat-drawer-empty'); return !e || e.textContent?.trim() !== '读取中…'; }, { timeout: TIMEOUT });
  };
  const closeHistory = async page => { await page.click('.chat-drawer-close-btn'); await page.waitForSelector('.chat-history-drawer', { hidden: true, timeout: TIMEOUT }); };
  const rowOf = async (page, id) => {
    for (const row of await page.$$('[data-pc="chat-cloud-item"]')) if (await row.evaluate(e => e.getAttribute('data-chat-id')) === id) return row;
    return null;
  };
  const historyIds = page => page.evaluate(() => [...document.querySelectorAll('[data-pc="chat-cloud-item"]')].map(e => e.getAttribute('data-chat-id')));
  const hasDeleteButton = async (page, id) => { const row = await rowOf(page, id); return Boolean(row && await row.$('[data-pc="chat-cloud-delete"]')); };
  /** 抽屉里等这一行出现(列表是点开时才刷新的，刚被别人建出来的对话要重开一次抽屉) */
  const waitRow = async (page, id) => {
    for (let i = 0; i < 12; i++) {
      await openHistory(page);
      const found = await page.waitForFunction(want => [...document.querySelectorAll('[data-pc="chat-cloud-item"]')].some(e => e.getAttribute('data-chat-id') === want),
        { timeout: 2500 }, id).then(() => true, () => false);
      if (found) return rowOf(page, id);
      await closeHistory(page);
    }
    throw new Error('history-row-not-found');
  };
  const pickFromHistory = async (page, id) => {
    const row = await waitRow(page, id);
    await row.evaluate(e => e.scrollIntoView({ block: 'center' })); await row.click();
    await page.waitForFunction(want => window.__pcCloud?.main?.conversationId?.() === want, { timeout: TIMEOUT }, id);
  };
  const clickDelete = async (page, id) => {
    const row = await rowOf(page, id); if (!row) throw new Error('delete-row-not-found');
    await row.evaluate(e => e.scrollIntoView({ block: 'center' }));
    const button = await row.$('[data-pc="chat-cloud-delete"]'); if (!button) throw new Error('delete-button-not-found');
    await button.click();
    await page.waitForSelector('[data-pc="cloud-delete-chat"]', { visible: true, timeout: TIMEOUT });
  };
  const dialogLines = page => page.evaluate(() => [...document.querySelectorAll('[data-pc="cloud-delete-line"]')].map(e => e.textContent?.trim()));
  const confirmDelete = async page => {
    const response = page.waitForResponse(r => r.request().method() === 'DELETE' && /\/agent\/v1\/conversations\//.test(new URL(r.url()).pathname), { timeout: TIMEOUT });
    await page.click('[data-pc="cloud-delete-confirm"]');
    const r = await response;
    await page.waitForSelector('[data-pc="cloud-delete-chat"]', { hidden: true, timeout: TIMEOUT });
    return r.status();
  };
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

  try {
    await fs.access(path.join(DIST, 'index.html')); await fs.access(SITE);
    await fs.mkdir(shotDir, { recursive: true });
    for (const port of PORTS) check(await portFree(port), `port-${port}-available`);
    fixture = await startAccountConversationControlsUserFixture({ ports: PORTS.slice(0, 7).map((_, i) => PORTS[i]), agentPort: 28187, publicHandler: serve(false) });
    for (const port of [28188, 28189]) {
      const sockets = new Set(), server = http.createServer((req, res) => { void serve(true)(req, res); });
      server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
      stages.push({ server, sockets, port });
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    }
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH ?? await puppeteer.executablePath();
    browser = await puppeteer.launch({ executablePath, headless: true, pipe: true, protocolTimeout: 90_000, userDataDir: path.join(OUT, 'chrome-profile'),
      args: [...PROBE_CHROME_ARGS, '--ignore-certificate-errors', '--host-resolver-rules=MAP s1.pc.localhost 127.0.0.1,MAP s2.pc.localhost 127.0.0.1'] });
    for (let i = 0; i < labels.length; i++) {
      const context = await browser.createBrowserContext(); contexts.push(context);
      const page = await context.newPage(); pages.push(page); page.setDefaultTimeout(TIMEOUT);
      await page.setViewport({ width: 1500, height: 950 });
      page.on('pageerror', error => result.pageErrors.push({ page: labels[i], message: String(error?.message ?? error).slice(0, 160) }));
      page.on('console', msg => { if (msg.type() === 'error') result.notes.push({ page: labels[i], console: msg.text().slice(0, 200) }); });
      page.on('response', response => {
        const url = new URL(response.url());
        if (url.pathname.startsWith('/agent/'))
          result.network.push({ page: labels[i], method: response.request().method(), status: response.status(),
            path: url.pathname.replace(/\/conversations\/[^/]+/g, '/conversations/:id') });
      });
    }
    const [creator, owner, member] = pages;
    const projectName = 'Shared dual account project';

    phase = 'login';
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i], account = fixture.accounts[i];
      await page.goto(`${ORIGIN}/editor/`, { waitUntil: 'domcontentloaded' });
      await fill(page, 'input[name="username"]', account.name); await fill(page, 'input[name="password"]', account.password);
      const submit = '[data-pc="account-projects"] form button.sp-primary-btn';
      await enabled(page, submit); await page.click(submit);
      await waitVisible(page, '[data-pc="account-name"]');
    }
    const openProject = async page => {
      await page.waitForFunction(name => [...document.querySelectorAll('[data-pc="cloud-project-lists"] .sp-account-row')]
        .some(row => row.querySelector('button')?.textContent?.trim() === name), { timeout: TIMEOUT }, projectName);
      for (const row of await page.$$('[data-pc="cloud-project-lists"] .sp-account-row')) {
        if ((await row.$eval('button', e => e.textContent?.trim() ?? '').catch(() => '')) !== projectName) continue;
        await (await row.$('button')).click(); break;
      }
      await waitVisible(page, '[data-pc="cloud-project-copy"]');
      // 告知对话框：第一次出现就点「我知道了」；已经同意过的不会出现
      const dialog = await page.waitForSelector('[data-pc="cloud-agent-consent"]', { visible: true, timeout: 8000 }).catch(() => null);
      if (dialog) {
        const buttons = await page.$$('[data-pc="cloud-agent-consent"] button');
        await buttons[1].click();
        await page.waitForSelector('[data-pc="cloud-agent-consent"]', { hidden: true, timeout: TIMEOUT });
      }
      // 分享提示的气泡先关掉，免得挡住后面要看的气泡
      for (const close of await page.$$('.pc-toast:has([data-pc="cloud-project-copy"]) button[aria-label="关闭"]')) await close.click().catch(() => {});
    };
    phase = 'open-project';
    await openProject(creator); await openProject(owner); await openProject(member);
    const enableButton = await creator.$('[data-pc="cloud-agent-enable"]');
    if (enableButton) { await enabled(creator, '[data-pc="cloud-agent-enable"]'); await enableButton.click(); }
    await creator.waitForSelector('[data-pc="cloud-off"]', { hidden: true, timeout: TIMEOUT });
    await owner.waitForFunction(() => document.querySelector('[data-pc="cloud-off"]') === null, { timeout: TIMEOUT });
    await member.waitForFunction(() => document.querySelector('[data-pc="cloud-off"]') === null, { timeout: TIMEOUT });

    // ---------- 造数据：owner 在这个项目里已有 49 个对话 ----------
    phase = 'seed-49';
    const ledgerFile = path.join(hostedPaths(path.join(fixture.fixtureDir, 'doc')).docservice, 'account-v2.sqlite');
    seedLedger = openAccountLedger({ file: ledgerFile, authorityId: 'dual-account-doc' });
    const project = seedLedger.read().projects[fixture.projectId];
    const memberIds = Object.keys(project.members).filter(id => id !== project.creatorAccountId);
    const ownerAccountId = memberIds[0], memberAccountId = memberIds[1], creatorAccountId = project.creatorAccountId;
    const SEEDS = Array.from({ length: 49 }, (_, i) => `seed-${String(i).padStart(2, '0')}`);
    seedLedger.transaction(state => {
      const rows = (state.conversationsV2 ??= {})[fixture.projectId] ??= {};
      SEEDS.forEach((id, i) => { rows[id] = { v: 2, projectId: fixture.projectId, id, ownerAccountId, visibility: 'shared', aclRevision: 1,
        queueRevision: 0, currentRunId: null, title: `旧对话 ${i}`, createdAt: 1000 + i, updatedAt: 1000 + i, messages: [] }; });
    });
    result.notes.push({ ownerAccountId: 'redacted', seeded: SEEDS.length });

    // ---------- 第 50 个：owner 在界面里真发 ----------
    phase = 'owner-creates-50th';
    const ownerPrompt = '改一下封面文案';
    await sendMessage(owner, ownerPrompt);
    await owner.waitForFunction(() => document.querySelectorAll('[data-pc="cloud-queue"] li[data-message-id]').length === 1, { timeout: TIMEOUT });
    const convC = await currentConversationId(owner);
    check(typeof convC === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(convC), 'owner-50th-conversation-created');
    check(result.network.some(n => n.page === 'owner' && n.method === 'POST' && n.path.endsWith('/messages') && n.status === 202), 'owner-50th-send-202');

    // ---------- 权限：谁看得到删除按钮 ----------
    phase = 'delete-button-visibility';
    await pickFromHistory(member, convC);
    await sendMessage(member, '我也补一句');
    await member.waitForFunction(() => document.querySelectorAll('[data-pc="cloud-queue"] li[data-message-id]').length >= 2 ||
      document.querySelectorAll('.ai-message.user').length >= 2, { timeout: TIMEOUT });
    await waitRow(member, convC);
    check(await rowOf(member, convC) !== null, 'member-sees-shared-conversation');
    check(!(await hasDeleteButton(member, convC)), 'member-has-no-delete-button-on-others-conversation');
    check(!(await hasDeleteButton(member, SEEDS[0])), 'member-has-no-delete-button-on-others-seeded');
    await shot(member, '01-member-history-no-delete-button');
    await closeHistory(member);
    await waitRow(creator, convC); await waitRow(creator, SEEDS[0]);
    check(await hasDeleteButton(creator, convC) && await hasDeleteButton(creator, SEEDS[0]), 'creator-has-delete-button-on-every-conversation');
    await shot(creator, '02-creator-history-delete-buttons');
    await closeHistory(creator);
    await waitRow(owner, convC); await waitRow(owner, SEEDS[0]);
    check(await hasDeleteButton(owner, convC) && await hasDeleteButton(owner, SEEDS[0]), 'owner-has-delete-button-on-own-conversations');
    check((await owner.$('[data-pc="chat-cloud-limit"]')) !== null, 'owner-history-shows-limit-hint-at-50');
    await shot(owner, '03-owner-history-50-limit-hint');
    await closeHistory(owner);

    // ---------- 满额：第 51 个被拒，原来的 50 个一个不少 ----------
    phase = 'limit-51st';
    await owner.click(`${panel} button[title*="历史"]`);
    await owner.waitForSelector('[data-pc="chat-new"]', { visible: true, timeout: TIMEOUT });
    await owner.click('[data-pc="chat-new"]');
    await owner.waitForSelector('.chat-history-drawer', { hidden: true, timeout: TIMEOUT }).catch(() => {});
    await owner.waitForSelector('[data-pc="cloud-limit-note"]', { visible: true, timeout: TIMEOUT });
    check((await owner.$eval('[data-pc="cloud-limit-note"]', e => e.textContent?.trim())) === CLOUD_CHAT_TEXT.limitComposer, 'owner-new-chat-shows-limit-note-text');
    const newId = await currentConversationId(owner);
    await sendMessage(owner, '第 51 个对话');
    await owner.waitForSelector('[data-pc="cloud-notice"]', { visible: true, timeout: TIMEOUT });
    check((await owner.$eval('[data-pc="cloud-notice"]', e => e.textContent?.trim())) === CLOUD_CHAT_TEXT.limitReached, 'owner-51st-rejected-with-limit-text');
    check(result.network.some(n => n.page === 'owner' && n.method === 'POST' && n.path.endsWith('/messages') && n.status === 409), 'owner-51st-send-409');
    await shot(owner, '04-owner-51st-rejected-limit-text');
    await openHistory(owner);
    const idsAt50 = await historyIds(owner);
    check(idsAt50.length === 50 && idsAt50.includes(convC) && SEEDS.every(id => idsAt50.includes(id)) && !idsAt50.includes(newId), 'limit-no-history-auto-deleted');
    await closeHistory(owner);

    // ---------- owner 删一个旧对话：确认弹窗、删完让出名额、能再新建 ----------
    phase = 'owner-deletes-one-then-creates';
    await openHistory(owner);
    await clickDelete(owner, SEEDS[0]);
    const lines1 = await dialogLines(owner);
    check(lines1[0] === CLOUD_CHAT_TEXT.deleteBody('旧对话 0'), 'delete-dialog-names-the-conversation');
    check(lines1.includes(CLOUD_CHAT_TEXT.deleteShared), 'delete-dialog-mentions-shared-notification');
    check(!lines1.includes(CLOUD_CHAT_TEXT.deleteOthers) && !lines1.includes(CLOUD_CHAT_TEXT.deleteRunning), 'delete-dialog-own-idle-has-no-extra-warnings');
    await shot(owner, '05-owner-delete-confirm-dialog');
    // 取消：什么都不发生
    await owner.click('[data-pc="cloud-delete-cancel"]');
    await owner.waitForSelector('[data-pc="cloud-delete-chat"]', { hidden: true, timeout: TIMEOUT });
    check((await historyIds(owner)).includes(SEEDS[0]), 'delete-cancel-keeps-conversation');
    await clickDelete(owner, SEEDS[0]);
    const status1 = await confirmDelete(owner);
    check(status1 === 200, 'owner-delete-http-200');
    await owner.waitForFunction(id => ![...document.querySelectorAll('[data-pc="chat-cloud-item"]')].some(e => e.getAttribute('data-chat-id') === id), { timeout: TIMEOUT }, SEEDS[0]);
    await waitToast(owner, CLOUD_CHAT_TEXT.deleteDone);
    check((await historyIds(owner)).length === 49 && (await owner.$('[data-pc="chat-cloud-limit"]')) === null, 'owner-delete-frees-a-slot-limit-hint-gone');
    await shot(owner, '06-owner-after-delete-slot-freed');
    await closeHistory(owner);
    await sendMessage(owner, '第 51 个对话');
    await owner.waitForFunction(() => document.querySelectorAll('[data-pc="cloud-queue"] li[data-message-id]').length === 1, { timeout: TIMEOUT });
    check(result.network.some(n => n.page === 'owner' && n.method === 'DELETE' && n.status === 200), 'network-has-delete-200');
    check(result.network.filter(n => n.page === 'owner' && n.method === 'POST' && n.path.endsWith('/messages') && n.status === 202).length === 2, 'owner-can-create-again-after-delete');
    await shot(owner, '07-owner-created-again-after-delete');

    // ---------- 创建者删 owner 的共有对话 C：owner 与 member 各收到气泡，创建者自己不收 ----------
    phase = 'creator-deletes-shared';
    await pickFromHistory(creator, convC);
    await closeHistory(creator).catch(() => {});
    await openHistory(creator);
    await clickDelete(creator, convC);
    const lines2 = await dialogLines(creator);
    check(lines2.includes(CLOUD_CHAT_TEXT.deleteOthers) && lines2.includes(CLOUD_CHAT_TEXT.deleteShared), 'creator-delete-dialog-warns-others-and-shared');
    await shot(creator, '08-creator-delete-others-confirm-dialog');
    const status2 = await confirmDelete(creator);
    check(status2 === 200, 'creator-delete-http-200');
    const nameCreator = fixture.accounts[0].name, nameOwner = fixture.accounts[1].name;
    const ownerBubble = cloudNoticeText({ recipientRole: 'owner', deletedByRole: 'creator', deletedByName: nameCreator, title: ownerPrompt });
    const memberBubble = cloudNoticeText({ recipientRole: 'participant', deletedByRole: 'creator', deletedByName: nameCreator, title: ownerPrompt });
    await waitToast(member, memberBubble);
    check((await toastTexts(member)).some(t => t.includes(memberBubble)), 'member-got-participant-bubble');
    check(await currentConversationId(member) !== convC, 'member-viewing-deleted-conversation-moved-to-new-chat');
    await shot(member, '09-member-bubble-after-creator-delete');
    await waitToast(owner, ownerBubble);
    check((await toastTexts(owner)).some(t => t.includes(ownerBubble)), 'owner-got-owner-bubble');
    await shot(owner, '10-owner-bubble-after-creator-delete');
    check(!(await toastTexts(creator)).some(t => t.includes('删除了')), 'creator-did-not-get-a-bubble');
    await shot(creator, '11-creator-no-bubble');

    // ---------- 不在线的人下次打开补弹一次 ----------
    phase = 'offline-replay';
    await owner.evaluate(() => { for (const b of document.querySelectorAll('.pc-toast button[aria-label="关闭"]')) b.click(); });
    await openHistory(owner);
    await owner.click('[data-pc="chat-new"]');                 // 另开一个新对话(上一个还留着)
    await owner.waitForSelector('.chat-history-drawer', { hidden: true, timeout: TIMEOUT }).catch(() => {});
    await sendMessage(owner, '第二个共有对话');
    await owner.waitForFunction(() => document.querySelectorAll('[data-pc="cloud-queue"] li[data-message-id]').length === 1, { timeout: TIMEOUT }).catch(() => {});
    const convD = await currentConversationId(owner);
    await pickFromHistory(member, convD);
    await sendMessage(member, '成员也在第二个对话里说了话');
    await member.waitForFunction(() => document.querySelectorAll('.ai-message.user').length >= 2, { timeout: TIMEOUT });
    await member.goto('about:blank');                       // member 关掉页面：不在线
    await openHistory(owner);
    await clickDelete(owner, convD);
    check(await confirmDelete(owner) === 200, 'owner-deletes-shared-while-member-offline');
    const offlineBubble = cloudNoticeText({ recipientRole: 'participant', deletedByRole: 'owner', deletedByName: nameOwner, title: '第二个共有对话' });
    await member.goto(`${ORIGIN}/editor/`, { waitUntil: 'domcontentloaded' });
    // 登录表单会先闪一下再恢复会话：先等账号名最多 12 秒，等不到才按没登录处理
    const landed = await member.waitForSelector('[data-pc="account-name"]', { visible: true, timeout: 12_000 }).then(() => 'logged-in', () => 'login-form');
    result.notes.push({ memberReopen: landed });
    if (landed === 'login-form') {
      await fill(member, 'input[name="username"]', fixture.accounts[2].name); await fill(member, 'input[name="password"]', fixture.accounts[2].password);
      const submit = '[data-pc="account-projects"] form button.sp-primary-btn';
      await enabled(member, submit); await member.click(submit);
    }
    await waitVisible(member, '[data-pc="account-name"]');
    await openProject(member);
    await waitToast(member, offlineBubble);
    check((await toastTexts(member)).filter(t => t.includes(offlineBubble)).length === 1, 'member-offline-bubble-replayed-once');
    await shot(member, '12-member-reopened-replayed-bubble');
    // 刷新页面再开：已经弹过并回执，不再补弹
    await member.reload({ waitUntil: 'domcontentloaded' });
    await waitVisible(member, '[data-pc="account-name"]');
    result.notes.push({ memberReload: 'logged-in' });
    await openProject(member);
    await sleep(3000);
    check(!(await toastTexts(member)).some(t => t.includes(offlineBubble)), 'member-bubble-not-replayed-twice');

    // ---------- 块五第 6 条：满额时「新对话」按钮不灰；对话数实时更新(同一个账号的两页，一页新建/删除，另一页不刷新就变) ----------
    phase = 'live-count';
    const countOf = page => page.$eval('[data-pc="chat-cloud-count"]', e => Number(e.getAttribute('data-owned'))).catch(() => null);
    const waitCount = (page, n) => page.waitForFunction(want => Number(document.querySelector('[data-pc="chat-cloud-count"]')?.getAttribute('data-owned')) === want, { timeout: 20_000 }, n);
    // 第二页要「看得见」才会后台刷新(隐藏的页面不轮询)，所以另开一个浏览器环境、同一个账号重新登录
    const ctxB = await browser.createBrowserContext(); contexts.push(ctxB);
    const ownerB = await ctxB.newPage(); pages.push(ownerB); labels.push('owner2'); ownerB.setDefaultTimeout(TIMEOUT);
    await ownerB.setViewport({ width: 1500, height: 950 });
    ownerB.on('pageerror', error => result.pageErrors.push({ page: 'owner2', message: String(error?.message ?? error).slice(0, 160) }));
    phase = 'live-count step 1';
    await ownerB.goto(`${ORIGIN}/editor/`, { waitUntil: 'domcontentloaded' });
    await fill(ownerB, 'input[name="username"]', fixture.accounts[1].name); await fill(ownerB, 'input[name="password"]', fixture.accounts[1].password);
    await enabled(ownerB, '[data-pc="account-projects"] form button.sp-primary-btn'); await ownerB.click('[data-pc="account-projects"] form button.sp-primary-btn');
    await waitVisible(ownerB, '[data-pc="account-name"]');
    phase = 'live-count step 2';
    await openProject(ownerB);
    phase = 'live-count step 4';
    await closeHistory(owner).catch(() => {});
    phase = 'live-count step 5';
    await openHistory(owner); await openHistory(ownerB);
    const c0 = await countOf(owner);
    check(c0 !== null && c0 === await countOf(ownerB), 'owner-two-pages-show-same-count-at-start');
    // 先把数补到满额，验证满额时「新对话」不灰
    const room = 50 - c0;
    if (room > 0) {
      seedLedger.transaction(state => { const rows = state.conversationsV2[fixture.projectId];
        for (let i = 0; i < room; i++) { const id = `fill-${i}`; rows[id] = { v: 2, projectId: fixture.projectId, id, ownerAccountId, visibility: 'shared', aclRevision: 1, queueRevision: 0,
          currentRunId: null, title: `补满 ${i}`, createdAt: 2000 + i, updatedAt: 2000 + i, messages: [] }; } });
    }
    await waitCount(owner, 50); await waitCount(ownerB, 50);          // 两页都没刷新，数字自己变到 50
    check((await owner.$('[data-pc="chat-cloud-limit"]')) !== null && (await ownerB.$('[data-pc="chat-cloud-limit"]')) !== null, 'both-pages-show-limit-hint-after-live-update');
    check(await owner.$eval('[data-pc="chat-new"]', e => e.disabled === false) && await ownerB.$eval('[data-pc="chat-new"]', e => e.disabled === false), 'new-chat-button-not-disabled-at-limit');
    await shot(ownerB, '13-owner-second-page-live-count-50');
    // 第一页删一个，第二页不刷新就变成 49、那一行消失
    await clickDelete(owner, 'fill-0');
    check(await confirmDelete(owner) === 200, 'owner-page-1-delete-200');
    await waitCount(owner, 49);
    await waitCount(ownerB, 49);
    check(!(await historyIds(ownerB)).includes('fill-0'), 'page-2-row-disappeared-without-reload');
    check((await ownerB.$('[data-pc="chat-cloud-limit"]')) === null, 'page-2-limit-hint-gone-without-reload');
    await shot(ownerB, '14-owner-second-page-live-count-49');
    // 第二页新建一个(真发)，第一页不刷新就变回 50
    await closeHistory(ownerB);
    await sendMessage(ownerB, '第二页新建的对话');
    await ownerB.waitForFunction(() => document.querySelectorAll('[data-pc="cloud-queue"] li[data-message-id]').length === 1, { timeout: TIMEOUT });
    await waitCount(owner, 50);
    check((await historyIds(owner)).length === 50, 'page-1-count-back-to-50-after-page-2-created');
    await shot(owner, '15-owner-first-page-live-count-50-after-other-page-created');
    await closeHistory(owner);

    // ---------- 块五第 5 条：踢出成员时选「同时清除他的私有对话」 ----------
    phase = 'kick-with-clear-private';
    await openHistory(member); await member.click('[data-pc="chat-new"]');
    await member.waitForSelector('.chat-history-drawer', { hidden: true, timeout: TIMEOUT }).catch(() => {});
    await sendMessage(member, '成员的私有对话');
    await member.waitForFunction(() => document.querySelectorAll('[data-pc="cloud-queue"] li[data-message-id]').length === 1, { timeout: TIMEOUT });
    const convPv = await currentConversationId(member);
    await member.waitForSelector('[data-pc="cloud-visibility-toggle"]', { visible: true, timeout: TIMEOUT });
    await member.click('[data-pc="cloud-visibility-toggle"]');
    await member.waitForFunction(() => document.querySelector('[data-pc="cloud-visibility-label"]')?.textContent?.includes('私有对话'), { timeout: TIMEOUT });
    await openHistory(member); await member.click('[data-pc="chat-new"]');
    await member.waitForSelector('.chat-history-drawer', { hidden: true, timeout: TIMEOUT }).catch(() => {});
    await sendMessage(member, '成员的共有对话');
    await member.waitForFunction(() => document.querySelectorAll('[data-pc="cloud-queue"] li[data-message-id]').length === 1, { timeout: TIMEOUT });
    const convSh = await currentConversationId(member);
    check(convPv !== convSh, 'member-has-one-private-and-one-shared');
    await waitRow(creator, convPv); await closeHistory(creator);
    await creator.setViewport({ width: 1500, height: 1300 });   // 成员面板很长，放高一点才看得到整个确认框
    await creator.click('[data-pc="members-button"]');
    await creator.waitForSelector(`[data-pc="account-member"][data-account-id="${memberAccountId}"] [data-pc="account-member-kick"]`, { visible: true, timeout: TIMEOUT });
    await creator.click(`[data-pc="account-member"][data-account-id="${memberAccountId}"] [data-pc="account-member-kick"]`);
    await creator.waitForSelector('[data-pc="account-member-clear-option"]', { visible: true, timeout: TIMEOUT });
    check(await creator.$eval('[data-pc="account-member-clear-option"] input', e => e.checked === false), 'clear-private-option-unchecked-by-default');
    check((await creator.$eval('[data-pc="account-member-clear-option"]', e => e.textContent?.trim())) === CLOUD_CHAT_TEXT.clearPrivateOption, 'clear-private-option-text');
    await creator.click('[data-pc="account-member-clear-option"] input');
    await creator.evaluate(() => { const pop = document.querySelector('[data-pc="members-pop"]'); if (pop) pop.scrollTop = pop.scrollHeight; });   // 成员面板自己带滚动条(原来就这样)：滚到底才看得到确认框
    await shot(creator, '16-creator-kick-confirm-with-clear-private-option');
    const clearResponse = creator.waitForResponse(r => new URL(r.url()).pathname.endsWith('/members/clear-private'), { timeout: TIMEOUT });
    await creator.click('[data-pc="account-member-submit"]');
    const cleared = await clearResponse;
    check(cleared.status() === 200, 'clear-private-http-200');
    const clearedBody = await cleared.json();
    check(clearedBody.removed.length === 1 && clearedBody.removed[0] === convPv && clearedBody.pending.length === 0, 'only-the-private-conversation-removed');
    await waitToast(creator, CLOUD_CHAT_TEXT.clearPrivateDone(1));
    await shot(creator, '17-creator-after-clear-private');
    await closeHistory(creator).catch(() => {});
    await openHistory(creator);
    await creator.waitForFunction(id => ![...document.querySelectorAll('[data-pc="chat-cloud-item"]')].some(e => e.getAttribute('data-chat-id') === id), { timeout: 20_000 }, convPv);
    check((await historyIds(creator)).includes(convSh), 'kicked-members-shared-conversation-kept');
    check(!(await historyIds(creator)).includes(convPv), 'kicked-members-private-conversation-gone');
    check(!JSON.stringify(seedLedger.read()).includes('成员的私有对话'), 'ledger-has-no-text-of-cleared-private-conversation');

    result.completed = true;
    check(result.pageErrors.length === 0, 'no-page-errors');
  } catch (error) {
    result.failure = { phase, message: String(error?.message ?? error) };
    console.error('FAILED', phase, error?.message);
    for (let i = 0; i < pages.length; i++) await shot(pages[i], `failure-${labels[i]}`).catch(() => {});
    process.exitCode = 1;
  } finally {
    try { seedLedger?.close(); } catch { /* 已关 */ }
    for (const context of contexts) await context.close().catch(() => {});
    await browser?.close().catch(() => {});
    for (const stage of stages) await closeServer(stage).catch(() => {});
    const closed = await fixture?.close().catch(() => ({ closed: false })) ?? { closed: true };
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
