/**
 * 云端 Agent 界面的真实浏览器探针(任务书 `docs/plan/cloud-agent-task.md` 完成条件第 5、6 条里属于界面的部分;
 * 契约 `docs/plan/cloud-agent-contract.md` 第 5、7.4、9.5、10 节)。全程在本机,绝不连任何远端。
 *
 * 0.7.18 起改走账号入口(原来的「房间号加口令」进入方式:开始页填项目名/用户名/密码的加入表单,在线构建的开始页上已经没有了;
 * 云端项目一律走网站账号):探针起的是账号模式的真实组合——VisuHive 的真账号后端、文档服务(账号模式)、独立进程的素材服务、
 * 带证书的公共入口、Agent 服务(主服务只做控制,任务在真的独立子进程里跑真运行器,停止由「结清」收口;夹具 `server/test/fixtures/account-runner-process.mjs` 的生产主服务装配)。模型只有脚本式模拟提供方 ```mock-script```,不连任何真实模型。页面的身份是真的:
 * 浏览器里登录账号、在开始页「新建云端项目」、首次使用云端 Agent 时点「告知托管方可读」、创建者打开项目的「云端 Agent」开关;
 * 委托票据与对话委托由页面在自己的账号会话上取,探针不注入任何替身。夹具是 `server/test/accept-018-conv-runner-fixture.mjs`
 * 搭法同 `accept-018-conv-endtoend.test.mjs` 里「停止」那一条;不用进程内执行器那套(`account-real-runner.mjs` 一族):它没有关闭结算,一轮结束后界面一直停在「等待云端确认关闭与结算」,停止也确认不了。
 *
 *   node scripts/probes/cloud-agent-ui-probe.mjs --dist <在线构建目录> --site-root <VisuHive 的 site 目录> --out <截图目录>
 *        [--base-port 29003] [--phases online|reverse|online,reverse]
 *   (--site-root 缺省取环境变量 PROMPTCUT_ACCOUNT_PROVIDER_ROOT 下的 site;要先设 PROMPTCUT_ACCOUNT_PROVIDER_ROOT 与
 *    PROMPTCUT_PASSWORD_ORDER_MODULE;--dist 缺省 dist-online,要先 `vite build --mode online`)
 *
 * 端口:--base-port 起连着 45 个(见文件里 PORT_COUNT 的注释),公共入口是 +6。数据都在系统临时目录。
 * 输出:每项断言一行 `{ check, ok, detail }`,最后一行 `{ summary }`,有失败退出码 1。截图存 --out。浏览器无头,子进程不弹窗。
 *
 * 验收标准(在线浏览器宽屏,账号模式;编号沿用原来的 O 系列,没搬过来的在文末「没搬过来的」里写明):
 *   O0  登录后新建项目、打开「云端 Agent」开关,右侧是云端 AI 栏、不是占位;接入方式下拉里只有「云端」且选中;没有任何同源 `/api/*`
 *       以外的编辑器进程请求;页面打 Agent 服务的每个请求都带账号会话签的委托票据,发消息的请求体里带对话委托;
 *   O8  空对话只有一条示例句「为我快速创建一个视频告诉我软件都可以做什么。」;云端下一键配特效置灰并写真实原因,诊断报告不隐藏;
 *   O1  发一条消息(模型脚本:先加一条轨道和三张文字卡,再读项目、改文案、挪片段、调卡片参数各一次):收尾之前就能看到停止按钮与工具调用(流式),
 *       最后有回复;页面编辑区看到三处改动;「Agent 操作记录」里这几步有记录,点「撤销这步」撤掉最后一步;
 *   O9  云端下「诊断报告」可用:报告是这段云端对话的过程、客户端与版本信息,没有票据形状的串、Bearer、Key;在线页面的「保存为文件」是浏览器下载;
 *   O12 〔反向通道;--phases reverse 才跑〕发起方在线时云端 Agent 能操作他的页面:调 `seek` 后播放头到了那个时刻;`play` 后在播、`pause` 后停下;`get_selection` 回当下的选区。
 *       账号模式下这一段现在不通(云端 Agent 回「发起方不在线」,页面没收到要它执行的请求),先单独成一段,免得它拖死别的断言;见报告「发现的产品问题」;
 *   O2  停止:点「停止」后这一轮停下、回复里没有脚本里停之后才会说的话;
 *   O4  另一个浏览器上下文(没有本地存储)以同一个账号登录、从项目列表进同一个项目:历史列表的「云端」一组里有刚才的对话,点开找回完整过程;
 *   O6  手机仿真(低内存档)仍是占位,没有云端 AI 栏、没有发往 /agent/ 的请求。
 *
 * 没搬过来的(原来的断言依赖旧入口的夹具:房间号加口令的共享项目、可掐事件流的代理、可注入的在场状态,或桌面版的页面;记在
 * `docs/reports/AGENT-v18-runner-list.md`「老项逐条判」):O3 事件流掐断后重连补齐、O5 出错与创建者关开关、O7 成员计数与离线 Agent、
 * O10 关开关的气泡、O11 附件、O9(K) 一键提交到收集端;整个桌面版阶段 D1～D12(桌面版进云端项目走 Rust 壳里的账号保管,无头的 dev server 页面没有它)。
 * 其中 O5(关开关)、O7(成员计数)、云端对话重连在账号模式下已有服务端层的测试:accept-018-auth-agent-path、accept-018-conv-controls、
 * accept-018-conv-endtoend、account-real-runner-sse。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { editorSecurityHeaders, stageSecurityHeaders } from '../../src/online/stagePolicy.mjs';
import { startRunnerProcessFixture } from '../../server/test/fixtures/account-runner-process.mjs';
import { createTimings } from './probe-timings.mjs';
import {
  ROOT, sleep, USER_PORTS, portFree, createUi, launchBrowser, killBrowser, newPage, P, mockSteps, msgs, conversationOf,
  toolCount, lastAssistant, panelText, providerOptions, sendText, eventLog, gateSettled,
} from './cloud-agent-ui-lib.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const BASE = Number(arg('--base-port', 29003));
const PHASES = new Set(arg('--phases', 'online').split(',')); // online:O0～O9、O2、O4、O6;reverse:O12 反向通道(单独一段:账号模式下现在不通,见文件头)
const DIST = path.resolve(arg('--dist', path.join(ROOT, 'dist-online')));
const SITE = path.resolve(arg('--site-root', process.env.PROMPTCUT_ACCOUNT_PROVIDER_ROOT ? path.join(process.env.PROMPTCUT_ACCOUNT_PROVIDER_ROOT, 'site') : ''));
const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), 'pc-cloud-ui-account')));
const ORIGIN = `https://127.0.0.1:${BASE + 6}`;
const STAGE_PORTS = [BASE + 11, BASE + 12];
const STAGES = STAGE_PORTS.map((p, i) => `http://s${i + 1}.pc.localhost:${p}`);
const PORT_COUNT = 45; // +0～+6 文档服务组合(公共入口 +6)、+7 Agent 入口、+8 主服务收事件、+9 看画面、+10 渲染替身、+11/+12 两个舞台源、+13～+28 任务进程身份口、+29～+44 任务进程控制口
for (const p of Array.from({ length: PORT_COUNT }, (_, n) => BASE + n)) {
  if (USER_PORTS.includes(p) || (p >= 5800 && p <= 5999)) { process.stderr.write(`端口段碰到了 ${p}(用户的编辑器或保留段)\n`); process.exit(2); }
}
if (!process.env.PROMPTCUT_ACCOUNT_PROVIDER_ROOT || !process.env.PROMPTCUT_PASSWORD_ORDER_MODULE) { process.stderr.write('要先设 PROMPTCUT_ACCOUNT_PROVIDER_ROOT 与 PROMPTCUT_PASSWORD_ORDER_MODULE\n'); process.exit(2); }

const timingLog = createTimings('cloud-agent-ui-probe');
const { results, check, say, until } = createUi({ maxLine: 1600 });
fs.mkdirSync(OUT, { recursive: true });
const shot = async (page, name) => { if (await page.$('input[type="password"]').catch(() => null)) return; await page.screenshot({ path: path.join(OUT, `${name}.png`) }).catch(() => {}); };

/* ---------------------------------------------------------------- 公共入口:在线构建 + VisuHive 的网站页 + 两个舞台源 */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.wasm': 'application/wasm' };
const serve = (stage) => async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  const headers = stage ? stageSecurityHeaders(ORIGIN) : editorSecurityHeaders(STAGES);
  if (url.pathname === '/editor/runtime-config.json') { res.writeHead(200, { ...headers, 'content-type': 'application/json' }); res.end(JSON.stringify({ v: 1, stageOrigins: STAGES })); return; }
  if (url.pathname === '/editor/_iso/ok') { res.writeHead(204, headers); res.end(); return; }
  if (url.pathname === '/editor/_iso/redirect') { res.writeHead(302, { ...headers, location: '/editor/_iso/ok' }); res.end(); return; }
  const editor = url.pathname.startsWith('/editor');
  const root = editor || stage || url.pathname.startsWith('/catalog/') ? DIST : SITE;
  const name = editor ? (url.pathname.replace(/^\/editor\/?/, '') || 'index.html') : url.pathname.slice(1) || 'index.html';
  const file = path.resolve(root, name);
  const rel = path.relative(root, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) { res.writeHead(404); res.end(); return; }
  try { const bytes = await fsp.readFile(file); res.writeHead(200, { ...headers, 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' }); res.end(req.method === 'HEAD' ? undefined : bytes); }
  catch { res.writeHead(404); res.end(); }
};

/* ---------------------------------------------------------------- 页面上的账号操作 */
const TIMEOUT = 30_000;
const fill = async (page, selector, text) => {
  await page.waitForSelector(selector, { visible: true, timeout: TIMEOUT }); await page.focus(selector);
  await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control'); await page.keyboard.press('Backspace');
  await page.type(selector, text);
};
const enabled = (page, selector) => page.waitForFunction((s) => { const el = document.querySelector(s); return el && !el.disabled; }, { timeout: TIMEOUT }, selector);
async function login(page, account) {
  await page.goto(`${ORIGIN}/editor/`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await fill(page, 'input[name="username"]', account.name); await fill(page, 'input[name="password"]', account.password);
  const submit = '[data-pc="account-projects"] form button.sp-primary-btn';
  await enabled(page, submit); await page.click(submit);
  await page.waitForSelector('[data-pc="account-name"]', { visible: true, timeout: TIMEOUT });
}
async function consent(page) {
  await page.waitForSelector('[data-pc="cloud-agent-consent"]', { visible: true, timeout: TIMEOUT });
  const buttons = await page.$$('[data-pc="cloud-agent-consent"] button');
  await buttons[1].click();
  await page.waitForSelector('[data-pc="cloud-agent-consent"]', { hidden: true, timeout: TIMEOUT });
}
const clipIn = (p, id) => p?.tracks?.flatMap((t) => t.clips).find((c) => c.id === id) ?? null;
const pageProject = (page) => P(page, () => JSON.parse(JSON.stringify(window.__pcStore.getState().project)));
const agentReqs = (page) => page.requests.filter((r) => r.url.startsWith(`${ORIGIN}/agent/`) && r.method !== 'OPTIONS');
// 账号会话签的票据是 43 个字符(Bearer 加起来不到 60,公用件 newPage 的长度判断会把它记成 other);带了 Bearer 且不是旧的 Bearer test: 替身就算带了票据
const ticketed = (reqs) => reqs.length > 0 && reqs.every((r) => r.auth === 'ticket' || r.auth === 'other');
const sameOriginApi = (page) => page.requests.filter((r) => { try { const u = new URL(r.url); return u.origin === ORIGIN && u.pathname.startsWith('/api/') && !u.pathname.startsWith('/api/account'); } catch { return false; } });
const EXAMPLE = '为我快速创建一个视频告诉我软件都可以做什么。';
const TICKET_SHAPE = /\bv1\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;
const CLOUD_PANEL = '[data-pc="cloud-ai-panel"]';
const exampleSentences = (page, panel) => P(page, (sel) => [...document.querySelectorAll(`${sel} [data-pc="ai-empty-example"]`)].map((e) => (e.textContent ?? '').trim()), panel);
async function menuState(page, panel) {
  await page.click(`${panel} [data-pc="ai-menu"]`);
  const out = await P(page, (sel) => {
    const rd = (pc) => { const b = document.querySelector(`${sel} [data-pc="${pc}"]`); return b ? { disabled: b.disabled, title: b.title } : null; };
    return { workflow: rd('ai-auto-workflow'), diagnostics: rd('ai-diagnostics') };
  }, panel);
  await page.click(`${panel} [data-pc="ai-menu"]`).catch(() => {});
  return out;
}
// 「在跑」看界面:云端 AI 栏里有「停止」按钮(账号模式下 window.__pcCloud.main.view() 在第一条消息之前是 null,不拿它判)
const streamingNow = (page) => P(page, () => !!document.querySelector('[data-pc="cloud-ai-panel"] [data-pc="ai-stop"]')).catch(() => false);
const idle = async (page) => !(await streamingNow(page));
/** 发一条脚本消息并等到这一轮确实开始(界面进入「在跑」) */
async function startRun(page, steps) {
  await sendText(page, mockSteps(steps));
  return until('这一轮开始(界面进入在跑)', () => streamingNow(page), 60_000, 30); // 每条消息起一个新的任务子进程(进程内 vite 载工具实现),机器忙时要十几秒;时限只为防卡死
}
async function diagnostics(page, browser, { save = false, shotName = null } = {}) {
  await gateSettled(page, { appearMs: 1500 });
  await page.click(`${CLOUD_PANEL} [data-pc="ai-menu"]`);
  await page.click(`${CLOUD_PANEL} [data-pc="ai-diagnostics"]`);
  await page.waitForSelector('.rpt-dialog', { visible: true, timeout: 8000 });
  const text = await page.$eval('.rpt-text', (t) => t.value);
  const buttons = await P(page, () => [...document.querySelectorAll('.rpt-dialog .rpt-btn')].map((b) => ({ text: b.textContent.trim(), disabled: b.disabled })));
  if (shotName) await shot(page, shotName);
  let saveMsg = null; let downloaded = null;
  const apiBefore = page.requests.filter((r) => /\/api\/ai\/diagnostics/.test(r.url)).length;
  if (save) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-ui-dl-'));
    const cdp = await browser.target().createCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir, browserContextId: page.browserContext().id });
    await page.evaluate(() => { [...document.querySelectorAll('.rpt-dialog .rpt-btn')].find((b) => b.textContent.trim() === '保存为文件')?.click(); });
    saveMsg = await until('诊断报告:保存为文件有回执', () => page.$eval('.rpt-dialog .rpt-msg', (e) => e.textContent ?? '').catch(() => null), 8000, 100);
    const file = await until('诊断报告:浏览器真的把文件下载下来了', () => fs.readdirSync(dir).find((n) => !n.endsWith('.crdownload')) ?? null, 10_000, 100);
    if (file) downloaded = { name: file, text: fs.readFileSync(path.join(dir, file), 'utf8') };
    await cdp.detach().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const apiAfter = page.requests.filter((r) => /\/api\/ai\/diagnostics/.test(r.url)).length;
  await page.click('.rpt-dialog .rpt-x').catch(() => {});
  let report = null;
  try { report = JSON.parse(text); } catch { report = null; }
  return { text, report, buttons, saveMsg, downloaded, diagApiRequests: apiAfter - apiBefore };
}

/* ================================================================== 主流程 */
let fixture = null; let browser = null; const stageServers = []; let exitCode = 0;
try {
  for (const p of Array.from({ length: PORT_COUNT }, (_, n) => BASE + n)) if (!(await portFree(p))) throw new Error(`端口 ${p} 被占用(--base-port 换一段)`);
  await fsp.access(path.join(DIST, 'index.html'));
  await fsp.access(SITE);
  fixture = await startRunnerProcessFixture({ productionMaster: true, publicHandler: serve(false), ports: {
    combo: [0, 1, 2, 3, 4, 5, 6].map((n) => BASE + n), agent: BASE + 7, masterEvents: BASE + 8, look: BASE + 9, renderWorker: BASE + 10, identityBase: BASE + 13, controlBase: BASE + 29 } });
  await fixture.scheduler.start(); // 槽调度:有消息等着就起一个任务进程(真的子进程,里面是真运行器)
  for (const port of STAGE_PORTS) {
    const server = http.createServer((req, res) => { void serve(true)(req, res); });
    const sockets = new Set(); server.on('connection', (s) => { sockets.add(s); s.once('close', () => sockets.delete(s)); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    stageServers.push({ server, sockets });
  }
  say('stack.up', { origin: ORIGIN });
  browser = await launchBrowser({ extraArgs: ['--disable-gpu', '--ignore-certificate-errors', '--host-resolver-rules=MAP s1.pc.localhost 127.0.0.1,MAP s2.pc.localhost 127.0.0.1'] });
  if (PHASES.has('desktop')) say('desktop.skipped', { why: '桌面版阶段(D1～D12)走旧入口,已废:见文件头「没搬过来的」' });

  if (PHASES.has('online')) {
    const [acctA, acctB] = fixture.accounts;
    const ctxA = await browser.createBrowserContext();
    const A = await newPage(ctxA);
    A.setDefaultTimeout(TIMEOUT);

    /* ---- 登录、新建、告知、打开开关 */
    await login(A, acctA);
    check('账号入口:登录后开始页有账号名(账号模式的登录,不是房间号加口令)', !!(await A.$('[data-pc="account-name"]')) && !(await A.$('[data-pc="join-form"]')), { joinForm: !!(await A.$('[data-pc="join-form"]')) });
    let createdId = null;
    A.on('response', (r) => { if (new URL(r.url()).pathname === '/hosted/shared/account/create' && r.status() === 201) void r.json().then((b) => { createdId = b.projectId; }).catch(() => {}); });
    await enabled(A, '[data-pc="cloud-create"]');
    await fill(A, '[data-pc="cloud-project-name"]', 'Cloud UI probe project'); await A.click('[data-pc="cloud-create"]');
    await A.waitForSelector('[data-pc="cloud-project-copy"]', { visible: true });
    await consent(A);
    await enabled(A, '[data-pc="cloud-agent-enable"]'); await A.click('[data-pc="cloud-agent-enable"]');
    await A.waitForSelector('[data-pc="cloud-off"]', { hidden: true });
    await A.waitForSelector(CLOUD_PANEL, { timeout: 30_000 }).catch(() => {});
    // 会话对象在发第一条消息时才建,之前 view() 是 null;所以这里等页面挂出云端 AI 栏的读取钩子
    await until('云端 AI 栏挂上读取钩子(window.__pcCloud.main)', () => P(A, () => !!window.__pcCloud?.main), 30_000, 200);
    check('账号入口:新建的项目是账号名下的云端项目(创建回包 201 带项目号 sp_…)', /^sp_[a-z0-9]{26}$/.test(createdId ?? ''), { createdId: createdId ? 'sp_…' : null });

    /* ---- O0、O8 */
    await until('O0:接入方式下拉出现', () => A.$('[data-pc="ai-provider"]'), 20_000, 200);
    const opts0 = await providerOptions(A);
    const placeholder0 = await P(A, () => !!document.querySelector('[data-pc="online-agent-off"]'));
    const panel0 = await P(A, () => !!document.querySelector('[data-pc="cloud-ai-panel"]'));
    check('O0:右侧是云端 AI 栏、不是占位', panel0 && !placeholder0, { panel0, placeholder0 });
    check('O0:接入方式下拉里只有「云端」且选中', opts0 && opts0.value === 'cloud' && opts0.options.length === 1 && opts0.options[0].text === '云端', opts0);
    check('O0:进入项目时问了 info(同源 /agent/v1/info)', agentReqs(A).some((r) => /\/agent\/v1\/info/.test(r.url)), { reqs: agentReqs(A).length });
    check('O0:页面的身份是真的:发往 Agent 服务的请求都带账号会话签的委托票据', ticketed(agentReqs(A)) && !(await panelText(A)).includes('还没有取得身份证明'), { requests: agentReqs(A).length, kinds: [...new Set(agentReqs(A).map((r) => r.auth))] });
    await shot(A, 'O0-online-ai-panel');
    const ex0 = await exampleSentences(A, CLOUD_PANEL);
    check('O8:空对话只有一条示例句,原文照抄「为我快速创建一个视频告诉我软件都可以做什么。」', ex0.length === 1 && ex0[0] === EXAMPLE, { ex0 });
    const menu0 = await menuState(A, CLOUD_PANEL);
    check('O8:云端下「一键配特效」在菜单里、置灰、悬停写原因;「诊断报告」不隐藏', !!menu0.workflow && menu0.workflow.disabled === true && /语音识别|云端暂不支持|暂不/.test(menu0.workflow.title) && !!menu0.diagnostics, menu0);

    const forOnline = PHASES.has('online');
    /* ---- O1:先让云端 Agent 搭出内容(一条轨道三张文字卡),再三处改动 */
    await startRun(A, [{ tool: 'add_track', input: { name: '序列 1' } },
      { tool: 'add_clip', input: { cardId: 'blur-text', start: 0, duration: 4, params: { text: '原来的|标题' } } },
      { tool: 'add_clip', input: { cardId: 'blur-text', start: 4, duration: 3, params: { text: '要挪的|片段' } } },
      { tool: 'add_clip', input: { cardId: 'blur-text', start: 7, duration: 4, params: { text: '第三张|卡片' } } }, { say: '搭好了' }]);
    await until('O1 搭内容:这一轮结束', () => idle(A), 60_000, 100);
    const built = await until('O1 搭内容:页面编辑区看到三张文字卡', async () => { const p = await pageProject(A); return p.tracks.flatMap((t) => t.clips).length >= 3 ? p : null; }, 20_000, 200);
    const clips = built?.tracks.flatMap((t) => t.clips).filter((c) => c.cardId === 'blur-text') ?? [];
    check('O1:云端 Agent 在空项目里加出一条轨道和三张文字卡(页面编辑区看到)', clips.length === 3, { clips: clips.map((c) => [c.id, c.start, c.end]) });
    const [cText, cMove, cParam] = clips.map((c) => c.id);
    if (forOnline) {
    const reqBase1 = agentReqs(A).length;
    const baseTools = toolCount(await msgs(A));
    await startRun(A, [{ tool: 'get_project', input: {} }, { sleepMs: 700 },
      { tool: 'update_clip', input: { clipId: cText, params: { text: '云端改的|标题' } } }, { sleepMs: 700 },
      { tool: 'update_clip', input: { clipId: cMove, start: 8, end: 11 } }, { sleepMs: 700 },
      { tool: 'update_clip', input: { clipId: cParam, params: { staggerMs: 321 } } }, { sleepMs: 700 }, { say: '三处都改好了' }]);
    const sawStop = await until('O1:收尾之前出现「停止」按钮', () => A.$(`${CLOUD_PANEL} [data-pc="ai-stop"]`), 10_000, 50);
    const mid = await until('O1:收尾之前就看到工具调用', async () => { const m = await msgs(A); return (await streamingNow(A)) && toolCount(m) - baseTools >= 1 ? { tools: toolCount(m) - baseTools } : null; }, 10_000, 50);
    check('O1:流式:收尾之前有「停止」按钮、已能看到工具调用', !!sawStop && !!mid, mid ?? {});
    await shot(A, 'O1-online-streaming');
    await until('O1:这一轮结束', () => idle(A), 60_000, 100);
    const m1 = await msgs(A);
    const a1 = lastAssistant(m1);
    check('O1:回复里有最后那句话,这一轮四次工具调用(读项目 + 三处改动),都成功', a1?.text?.includes('三处都改好了') && toolCount(m1) - baseTools === 4 && (a1.parts ?? []).filter((p) => p.kind === 'tool').every((t) => t.ok === true), { text: a1?.text, tools: (a1?.parts ?? []).filter((p) => p.kind === 'tool').map((t) => [t.name, t.ok]) });
    const p1 = await until('O1:页面编辑区看到三处改动', async () => { const p = await pageProject(A); return clipIn(p, cText)?.params?.text === '云端改的|标题' && clipIn(p, cMove)?.start === 8 && clipIn(p, cParam)?.params?.staggerMs === 321 ? p : null; }, 20_000, 200);
    check('O1:这个页面的编辑区看到了改动(文案、片段起止、卡片参数)', !!p1, { text: clipIn(await pageProject(A), cText)?.params?.text });
    check('O1:AI 栏里能读到回复文字与「在云端运行」说明', (await panelText(A)).includes('三处都改好了') && (await panelText(A)).includes('在云端运行,关闭后继续'), { head: (await panelText(A)).slice(0, 160) });
    const post1 = agentReqs(A).slice(reqBase1).filter((r) => r.method === 'POST' && /\/messages$/.test(new URL(r.url).pathname));
    check('O1:发消息的请求带账号会话签的委托票据(账号模式的请求体里没有单独的 grant 字段,detail 里记下)', post1.length === 1 && post1[0].auth !== null, { posts: post1.length, auth: post1[0]?.auth ?? null, grant: post1[0]?.grant ?? null });
    const log1 = await until('O1:Agent 操作记录里出现这几步', async () => { const l = await eventLog(A); return l && l.count >= 4 ? l : null; }, 15_000, 200);
    check('O1:「Agent 操作记录」里有这几步的记录,署名是云端 Agent', !!log1 && log1.rows.length >= 4 && log1.rows.every((r) => /云端 Agent/.test(r.who)), { count: log1?.count, who: [...new Set((log1?.rows ?? []).map((r) => r.who))] });
    const undoRow = (log1?.rows ?? []).find((r) => r.undo === 'ready' && r.tool.includes('update_clip')) ?? (log1?.rows ?? []).find((r) => r.undo === 'ready');
    const beforeUndo = JSON.stringify(await pageProject(A));
    if (undoRow) await A.click(`[data-pc="agent-event"][data-event-id="${undoRow.id}"] [data-pc="agent-undo"]`);
    const undone = undoRow ? await until('O1:撤销后页面里的项目内容变了', async () => (JSON.stringify(await pageProject(A)) !== beforeUndo ? true : null), 10_000, 200) : null;
    const after = await eventLog(A);
    const rowAfter = after?.rows.find((r) => r.id === undoRow?.id) ?? null;
    check('O1:点「撤销这步」:这一步的按钮变成「已撤销」,页面里的项目内容回到改之前', !!undoRow && rowAfter?.undo === 'done' && !!undone, { tool: undoRow?.tool ?? null, undo: rowAfter?.undo ?? null });
    await shot(A, 'O1-online-done');

    /* ---- O9:诊断报告 */
    const diagA = await diagnostics(A, browser, { save: true, shotName: 'O9-online-diagnostics' });
    const rep = diagA.report;
    const toolNames = (rep?.rounds ?? []).flatMap((r) => (r.reply?.tools ?? []).map((t) => t.name));
    check('O9:云端下「诊断报告」可用:报告是这段云端对话的(格式、对话 id、工具调用、回复、客户端模式 online、代码版本)', rep?.format === 'PromptCut cloud conversation debug v1' && rep.conversation?.id === (await conversationOf(A)) && toolNames.filter((n) => n === 'update_clip').length >= 3 && JSON.stringify(rep.rounds).includes('三处都改好了') && rep.client?.mode === 'online' && typeof rep.client?.userAgent === 'string' && 'codeVersion' in rep.client, { format: rep?.format, tools: toolNames, client: rep?.client });
    check('O9:报告里没有任何凭证:没有票据形状的串(v1.…)、没有 Bearer、没有 sk- 形状的 Key', !TICKET_SHAPE.test(diagA.text) && !/Bearer\s+[A-Za-z0-9]/.test(diagA.text) && !/\bsk-[A-Za-z0-9_-]{12,}/.test(diagA.text), { chars: diagA.text.length });
    check('O9:在线页面的「保存为文件」是浏览器下载(有回执),没有请求 /api/ai/diagnostics*', /已下载/.test(String(diagA.saveMsg ?? '')) && diagA.diagApiRequests === 0 && !!diagA.downloaded && diagA.downloaded.text === diagA.text, { saveMsg: diagA.saveMsg, diagApi: diagA.diagApiRequests, file: diagA.downloaded?.name ?? null });
    }

    /* ---- O12:反向通道(--phases 里有 reverse 才跑) */
    if (PHASES.has('reverse')) {
      const pageState = () => P(A, () => { const s = window.__pcStore.getState(); return { t: s.t, playing: s.playing, selection: s.selection }; });
      await P(A, (id) => { const { actions } = window.__pcStore; actions.pause(); actions.seek(0); actions.select([id]); }, cParam);
      const sel0 = (await pageState()).selection;
      const base12 = toolCount(await msgs(A));
      const reqBase = agentReqs(A).length;
      await startRun(A, [{ sleepMs: 1500 }, { tool: 'seek', input: { t: 3 } }, { sleepMs: 1800 }, { tool: 'play', input: {} }, { sleepMs: 1800 }, { tool: 'pause', input: {} }, { sleepMs: 1200 }, { tool: 'get_selection', input: {} }, { say: '播放头操作完了' }]);
      await P(A, (id) => window.__pcStore.actions.select([id]), cMove);
      const atSeek = await until('O12:seek 之后页面的播放头到了 3 秒(没在播)', async () => { const s = await pageState(); return Math.abs(s.t - 3) < 0.05 && s.playing === false ? s : null; }, 15_000, 40);
      const atPlay = await until('O12:play 之后页面在播', async () => { const s = await pageState(); return s.playing === true ? s : null; }, 15_000, 40);
      const atPause = await until('O12:pause 之后页面停下', async () => { const s = await pageState(); return s.playing === false && toolCount(await msgs(A)) - base12 >= 3 ? s : null; }, 15_000, 40);
      await until('O12:这一轮结束', () => idle(A), 30_000, 100);
      const a12 = lastAssistant(await msgs(A));
      const tools12 = (a12?.parts ?? []).filter((p) => p.kind === 'tool');
      check('O12:云端 Agent 调 seek 后页面的播放头到了那个时刻(3 秒)', !!atSeek, atSeek ?? (await pageState()));
      check('O12:调 play 后页面在播,调 pause 后页面停下(停下时播放头已经走过 3 秒)', !!atPlay && !!atPause && atPause.t > 3, { atPlay, atPause });
      check('O12:AI 栏里这四步各显示一步、都成功,回复在', tools12.map((t) => t.name).join() === 'seek,play,pause,get_selection' && tools12.every((t) => t.ok === true) && (a12?.text ?? '').includes('播放头操作完了'), { tools: tools12.map((t) => [t.name, t.ok, t.summary]), text: a12?.text });
      const sel12 = String(tools12.find((t) => t.name === 'get_selection')?.summary ?? '');
      check('O12:get_selection 回的是页面当下的选区(挪的那张),不是发消息时的(第三张)', sel0.join() === cParam && sel12.includes(cMove) && !sel12.includes(cParam), { sel0, summary: sel12.slice(0, 200) });
      const results12 = agentReqs(A).slice(reqBase).filter((r) => r.method === 'POST' && /\/page-results$/.test(r.url));
      check('O12:页面交回结果的请求(POST …/page-results)四次、都带委托票据', results12.length === 4 && results12.every((r) => r.auth !== null), { results: results12.length, auth: results12.map((r) => r.auth) });
      await P(A, () => { window.__pcStore.actions.pause(); window.__pcStore.actions.select([]); });
    }

    if (forOnline) {
    /* ---- O2:停止 */
    await startRun(A, [{ tool: 'get_project', input: {} }, { sleepMs: 30000 }, { say: '这句话不该出现' }]);
    await sleep(800);
    const t0 = Date.now();
    await A.click(`${CLOUD_PANEL} [data-pc="ai-stop"]`);
    const stopped = await until('O2:停止后停下', () => idle(A), 25_000, 50); // 等待时限只为防卡死;脚本 30 秒后自己会说完,所以不能等过 30 秒
    timingLog.record('O2 点「停止」到这一轮停下', stopped ? Date.now() - t0 : null, { formerLimit: '< 5 秒' });
    const a2 = lastAssistant(await msgs(A));
    // 账号模式的界面消息模型里一轮被停下后没有旧的 outcome:'aborted' 标记(那是旧的进程内会话的内部字段),所以按用户看得到的结果判:
    // 「停止」按钮没了(这一轮结束)、云端 Agent 的回复里没有停之后才会说的话。(不扫整个 AI 栏:用户自己发的那条脚本消息里就写着这句话。)
    const replies2 = (await msgs(A) ?? []).filter((m) => m.role === 'assistant').map((m) => m.text ?? '').join(' ');
    check('O2:点「停止」后停下(用时只记录),云端 Agent 的回复里没有停之后才会说的话,「停止」按钮没了', !!stopped && !replies2.includes('不该出现') && !(await A.$(`${CLOUD_PANEL} [data-pc="ai-stop"]`)), { outcome: a2?.outcome ?? null, text: a2?.text ?? null, panelTail: (await panelText(A)).slice(-120) });
    await shot(A, 'O2-online-stopped');

    /* ---- O0 收尾:整个在线过程里没有编辑器进程的请求 */
    check('O0:整个在线对话过程中没有发往编辑器进程的同源 /api/*(账号的 /api/account 不算)', sameOriginApi(A).length === 0, { api: sameOriginApi(A).slice(0, 4).map((r) => r.url) });
    check('O0:整个在线过程发往 Agent 服务的请求都带委托票据', ticketed(agentReqs(A)), { A: agentReqs(A).length, kinds: [...new Set(agentReqs(A).map((r) => r.auth))] });
    check('O0:在线页面没有页面错误', A.pageErrors.length === 0, { A: A.pageErrors.slice(0, 3) });

    /* ---- O4:另一个浏览器上下文以同一个账号登录,从项目列表进同一个项目,历史里找回对话 */
    const convId = await conversationOf(A);
    const ctxB = await browser.createBrowserContext();
    const B = await newPage(ctxB);
    B.setDefaultTimeout(TIMEOUT);
    await login(B, acctA);
    const listItem = await until('O4:新上下文的项目列表里有刚才的项目', async () => {
      const h = await B.evaluateHandle(() => [...document.querySelectorAll('[data-pc="cloud-project-lists"] .sp-account-row > button')].find((b) => b.textContent.trim() === 'Cloud UI probe project') ?? null);
      return h.asElement();
    }, 20_000, 300);
    check('O4:同一个账号换一个浏览器环境登录,项目列表里能找到那个项目', !!listItem, { found: !!listItem });
    if (listItem) {
      await listItem.click();
      await B.waitForSelector(CLOUD_PANEL, { timeout: 60_000 }).catch(() => {});
      await until('O4:新环境的云端 AI 栏挂上读取钩子', () => P(B, () => !!window.__pcCloud?.main), 30_000, 200);
      const history = await B.$(`${CLOUD_PANEL} button[title*="历史"]`);
      if (history) await history.click();
      const item = await until('O4:历史列表的「云端」一组里有刚才的对话', async () => (await B.$(`[data-pc="chat-cloud-item"][data-chat-id="${convId}"]`)) ?? null, 20_000, 300);
      check('O4:历史列表的「云端」一组里列出这个项目里的云端对话(刚才那几轮的)', !!item, { convId: convId ? 'ca_…' : null });
      if (item) {
        await item.click();
        await B.waitForFunction((id) => window.__pcCloud?.main?.conversationId?.() === id, { timeout: 30_000 }, convId).catch(() => {});
        const back = await until('O4:点开后找回完整过程(含刚才的工具调用与回复)', async () => {
          const text = await panelText(B);
          const ops = await P(B, () => document.querySelectorAll('button[data-pc-op].is-ok').length);
          return text.includes('三处都改好了') && ops >= 4 ? { ops } : null;
        }, 30_000, 300);
        check('O4:点开后过程完整:工具调用的小标都在(至少四个)、回复里有「三处都改好了」', !!back, back ?? { text: (await panelText(B)).slice(-200) });
      }
      await shot(B, 'O4-reopen-history');
    }
    await ctxB.close().catch(() => {});

    /* ---- O6:手机仿真仍是占位(第二个账号加入同一个项目链接,手机环境) */
    const ctxM = await browser.createBrowserContext();
    const Mo = await newPage(ctxM, { mobile: true });
    Mo.setDefaultTimeout(TIMEOUT);
    const agentBefore = agentReqs(Mo).length;
    await login(Mo, acctB).catch((e) => say('mobile.login.error', { e: String(e?.message ?? e).slice(0, 120) }));
    const joinInput = await Mo.$('[data-pc="cloud-project-link"]');
    if (joinInput && createdId) { await fill(Mo, '[data-pc="cloud-project-link"]', `${ORIGIN}/editor?project=${encodeURIComponent(createdId)}`); await enabled(Mo, '[data-pc="cloud-join"]'); await Mo.click('[data-pc="cloud-join"]'); }
    await Mo.waitForSelector('[data-pc="cloud-agent-consent"]', { visible: true, timeout: 8000 }).then(() => consent(Mo)).catch(() => {});
    await sleep(3000);
    const mob = await P(Mo, () => ({ placeholder: !!document.querySelector('[data-pc="online-agent-off"]'), panel: !!document.querySelector('[data-pc="cloud-ai-panel"]'), editor: !!window.__pcStore, text: document.querySelector('[data-pc="online-agent-off"]')?.textContent?.trim().slice(0, 60) ?? null }));
    check('O6:手机仿真(低内存档)进了项目,仍是占位,没有云端 AI 栏', mob.editor && mob.placeholder && !mob.panel, mob);
    check('O6:手机仿真没有发往 /agent/ 的请求', agentReqs(Mo).length === agentBefore, { mobAgentReq: agentReqs(Mo).length - agentBefore });
    await shot(Mo, 'O6-mobile-placeholder');
    await ctxM.close().catch(() => {});
    }
    await ctxA.close().catch(() => {});
  }
} catch (err) {
  check('探针自己没出错', false, { error: String(err?.stack ?? err).slice(0, 900) });
} finally {
  try { if (browser) await killBrowser(browser); } catch { /* 已关 */ }
  for (const s of stageServers) { for (const sk of s.sockets) sk.destroy(); await new Promise((r) => s.server.close(r)); }
  try { await fixture?.close(); } catch (e) { say('fixture.close.error', { e: String(e?.message ?? e).slice(0, 200) }); }
  await sleep(300);
  const failed = results.filter((r) => !r.ok);
  timingLog.print();
  console.log(JSON.stringify({ summary: { total: results.length, failed: failed.length, failedChecks: failed.map((r) => r.check) } }));
  exitCode = failed.length || !results.length ? 1 : 0;
}
process.exit(exitCode);
