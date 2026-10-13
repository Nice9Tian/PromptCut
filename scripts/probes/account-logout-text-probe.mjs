// 输入：--site-root <VisuHive 仓库的 site 目录> --out <放截图和结果的目录> [--port-base 28160] [--timeout-ms 8000]
//       环境变量 PROMPTCUT_ACCOUNT_PROVIDER_ROOT、PROMPTCUT_PASSWORD_ORDER_MODULE 指向同一份 VisuHive（要带退出确认时限的那一版）。
// 断言：在真浏览器里走官网的改密页——
//   一、正常：改密成功后的问句、两个按钮、「正在退出已登录设备」「设备已退出」是用户定的原文；四样确认齐了才出现「设备已退出」。
//   二、超时：素材服务停着时选退出，时限之内显示「正在退出已登录设备」，到时显示失败那句话和调试信息，不显示「设备已退出」；
//       素材服务起来、确认到齐以后，页面照实变成「设备已退出」。
// 失败退出码 1。每一步截图存到 --out，结果写 --out/result.json。只起本机的服务，用分给本探针的端口段。
import '../lib/no-user-dirs.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { startAccountPasswordUserFixture } from '../../server/test/fixtures/account-password-user-path.mjs';

const argv = process.argv.slice(2);
const arg = name => { const index = argv.indexOf(name); return index < 0 ? undefined : argv[index + 1]; };
const SITE = path.resolve(arg('--site-root') ?? ''), OUT = path.resolve(arg('--out') ?? '');
const BASE = Number(arg('--port-base') ?? 28160), TIMEOUT_MS = Number(arg('--timeout-ms') ?? 8000), WAIT = 60_000;
if (!arg('--site-root') || !arg('--out') || !Number.isInteger(BASE) || BASE < 20000 || !Number.isInteger(TIMEOUT_MS)) throw Error('usage: --site-root <dir> --out <dir> [--port-base n] [--timeout-ms n]');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const TEXT = { question: '密码已修改。要退出已登录的其它设备吗？本网站保持登录。', yes: '退出', no: '不退出',
  exiting: '正在退出已登录设备', exited: '设备已退出', failed: '退出没有确认完成。旧设备已经不能再使用；需要帮助时，请把下面的信息发给我们。' };
const checks = [], shots = [];
const check = (condition, name, detail) => { checks.push({ name, ok: Boolean(condition), ...(detail === undefined ? {} : { detail }) }); if (!condition) console.error(`✖ ${name}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`); };

async function publicHandler(req, res) {
  const route = new URL(req.url, 'https://site.invalid').pathname;
  // 这支探针不带编辑器；夹具启动时会探一下 /editor 有没有人答，给它一个占位页。
  if (route === '/editor') { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); res.end('no editor in this probe'); return true; }
  const name = route === '/' ? 'index.html' : ['/login', '/account', '/reset', '/register'].includes(route) ? `${route.slice(1)}.html` : decodeURIComponent(route.slice(1));
  const file = path.resolve(SITE, name);
  if (!file.startsWith(SITE + path.sep)) return false;
  let bytes; try { bytes = await fs.readFile(file); } catch { return false; }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' }); res.end(bytes);
}

await fs.mkdir(OUT, { recursive: true });
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-logout-text-probe-'));
let fixture, browser, assetUp = true, failure = null;
try {
  fixture = await startAccountPasswordUserFixture({ ports: [0, 1, 2, 3, 4, 5, 6].map(n => BASE + n), agentPort: BASE + 7, publicHandler,
    logoutConfirmPollMs: 250, logoutConfirmTimeoutMs: TIMEOUT_MS,
    assetEntry: fileURLToPath(new URL('../../server/test/fixtures/asset-entry-restartable.mjs', import.meta.url)) });
  check(fixture.providerSupportsLogoutTimeout === true, 'account-backend-has-logout-timeout');
  const account = fixture.accounts[0], origin = fixture.origin;
  browser = await puppeteer.launch({ executablePath: await puppeteer.executablePath(), headless: true, pipe: true, acceptInsecureCerts: true,
    userDataDir: profile, defaultViewport: { width: 1100, height: 900 }, args: [...PROBE_CHROME_ARGS, '--ignore-certificate-errors'] });
  const page = await browser.newPage();
  const fill = async (selector, value) => { await page.waitForSelector(selector, { visible: true, timeout: WAIT }); await page.$eval(selector, el => { el.value = ''; }); await page.type(selector, value); };
  const status = () => page.$eval('#password-event-status', el => ({ text: el.textContent, kind: el.className }));
  const debug = () => page.$eval('#password-event-debug', el => ({ hidden: el.hidden, text: el.textContent }));
  const shot = async label => {
    // 截图前清掉还显示着的密码框，图里不留密码。
    await page.$$eval('input[type="password"]', inputs => inputs.forEach(input => { input.value = ''; }));
    const file = path.join(OUT, `${label}.png`); await page.screenshot({ path: file }); shots.push(`${label}.png`);
  };
  const waitText = text => page.waitForFunction(expected => document.querySelector('#password-event-status')?.textContent === expected, { timeout: WAIT }, text);
  async function changePassword(current, next) {
    await page.goto(`${origin}/account`, { waitUntil: 'domcontentloaded' });
    await fill('#password input[name="current"]', current); await fill('#password input[name="next"]', next); await fill('#password input[name="again"]', next);
    await page.waitForFunction(() => document.querySelector('#password button[type="submit"]')?.disabled === false, { timeout: WAIT });
    await page.click('#password button[type="submit"]');
    await page.waitForFunction(() => document.querySelector('#password-event-choices')?.hidden === false, { timeout: WAIT });
  }
  async function chooseExit() {
    const choice = page.waitForResponse(response => response.request().method() === 'POST' && /\/password-events\/[^/]+\/choice$/.test(new URL(response.url()).pathname), { timeout: WAIT });
    await page.click('#password-exit-yes'); return (await choice).status();
  }

  // 登录官网。
  await page.goto(`${origin}/login`, { waitUntil: 'domcontentloaded' });
  await fill('#login input[name="name"]', account.name); await fill('#login input[name="password"]', account.password);
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click('#login button[type="submit"]')]);
  await page.waitForSelector('#acc-name', { visible: true, timeout: WAIT });

  // 一、正常的一次。
  await changePassword(account.password, account.nextPassword);
  check((await status()).text === TEXT.question, 'question-text', (await status()).text);
  const buttons = await page.$$eval('#password-event-choices button', list => list.map(button => button.textContent.trim()));
  check(JSON.stringify(buttons) === JSON.stringify([TEXT.no, TEXT.yes]), 'button-texts', buttons);
  await shot('01-question');
  check(await chooseExit() === 202, 'exit-choice-accepted');
  const afterChoice = await status();
  check([TEXT.exiting, TEXT.exited].includes(afterChoice.text), 'after-choice-text-is-exiting-or-exited', afterChoice.text);
  await shot('02-exiting-or-exited-right-after-choice');
  await waitText(TEXT.exited);
  check((await debug()).hidden === true, 'no-debug-block-when-exited');
  await shot('03-exited');

  // 二、超时的一次：素材服务停着。
  await fixture.stopAsset(); assetUp = false;
  await changePassword(account.nextPassword, account.resetPassword);
  const chosenAt = Date.now();
  check(await chooseExit() === 202, 'timeout-exit-choice-accepted');
  check((await status()).text === TEXT.exiting, 'before-timeout-shows-exiting', (await status()).text);
  await shot('04-before-timeout-exiting');
  let sawExitedWhileUnconfirmed = false, sawOther = null;
  for (;;) {
    const now = await status();
    if (now.text === TEXT.failed) break;
    if (now.text === TEXT.exited) sawExitedWhileUnconfirmed = true;
    else if (now.text !== TEXT.exiting) sawOther = now.text;
    if (Date.now() - chosenAt > WAIT) break;
    await delay(250);
  }
  const failedAfterMs = Date.now() - chosenAt, failedStatus = await status();
  check(failedStatus.text === TEXT.failed && failedStatus.kind === 'msg err', 'after-timeout-shows-failure', failedStatus);
  check(!sawExitedWhileUnconfirmed && sawOther === null, 'never-shows-exited-while-unconfirmed', { sawExitedWhileUnconfirmed, sawOther });
  check(failedAfterMs >= TIMEOUT_MS, 'failure-not-before-timeout', { failedAfterMs, TIMEOUT_MS });
  // 文档服务的进度可能比页面这一次读取晚一拍到，点「重新读取状态」直到带上它。
  let debugBlock = await debug();
  for (let i = 0; i < 20 && !/doc pending: doc, asset/.test(debugBlock.text); i++) { await page.click('#password-event-refresh'); await delay(500); debugBlock = await debug(); }
  check(debugBlock.hidden === false && /^event: pw_[0-9a-f]+\nreason: confirmation-timeout\nwaited: \d+s \(limit \d+s\)\nconfirmed: -\npending: doc, asset, agent, render\ndoc confirmed: agent, render\ndoc pending: doc, asset\ndoc reasons: logout-pending:doc,asset$/.test(debugBlock.text),
    'debug-block-content', debugBlock.text);
  check(!/token|ticket|Bearer|login_|cred_|[A-Za-z0-9_-]{40,}/.test(debugBlock.text), 'debug-block-has-no-secrets');
  await shot('05-after-timeout-failed');
  // 迟到的确认：素材服务起来以后，页面照实变成已退出。
  await fixture.startAsset(); assetUp = true;
  await page.click('#password-event-refresh').catch(() => {});
  for (let i = 0; i < 80 && (await status()).text !== TEXT.exited; i++) { await delay(500); if (i % 4 === 3) await page.click('#password-event-refresh').catch(() => {}); }
  check((await status()).text === TEXT.exited && (await debug()).hidden === true, 'late-confirmation-shows-exited', (await status()).text);
  await shot('06-late-confirmation-exited');
} catch (error) { failure = error; console.error(error); }
finally {
  await browser?.close().catch(() => {});
  if (fixture && !assetUp) await fixture.startAsset().catch(() => {});
  await fixture?.close().catch(error => { failure ??= error; });
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}
const ok = !failure && checks.length > 0 && checks.every(item => item.ok);
await fs.writeFile(path.join(OUT, 'result.json'), JSON.stringify({ ok, timeoutMs: TIMEOUT_MS, checks, shots, error: failure ? String(failure.message ?? failure) : null }, null, 2) + '\n');
console.log(JSON.stringify({ ok, passed: checks.filter(item => item.ok).length, total: checks.length, shots }));
process.exitCode = ok ? 0 : 1;
