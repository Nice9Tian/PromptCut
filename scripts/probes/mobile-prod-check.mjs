/**
 * 手机版上线后的生产检查(任务书 `docs/plan/mobile-online-task.md` 的 M7 前一半):只读,不登录、不进项目、不改数据。
 *
 *   node scripts/probes/mobile-prod-check.mjs [--origin https://visuhive.com] [--out <截图目录>]
 *
 * 安卓仿真(UA + userAgentData.mobile=true、375×812、触屏)打开 `/editor/`:进手机版开始页,没有横向溢出;
 * 桌面仿真打开:进桌面开始页,页面里没有手机版、也没下载手机版的代码分块。
 * 两边:页面错误 0、4xx/5xx 0(未登录时 `/api/account/me` 回 401 是正常的「还没登录」,单列)。结果最后一行是一行 JSON。
 */
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { DEVICES } from './lib/mobile-env.mjs';

setTimeout(() => { console.error('SCRIPT_TIMEOUT'); process.exit(124); }, 180_000).unref();
const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const ORIGIN = arg('--origin', 'https://visuhive.com');
const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), 'mobile-prod-check')));
fs.mkdirSync(OUT, { recursive: true });
const fails = [];
const out = { ok: false, origin: ORIGIN, out: OUT };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 400))); };

const browser = await puppeteer.launch({ headless: true, args: [...PROBE_CHROME_ARGS, '--no-first-run'] });
try {
  for (const device of ['phone', 'desktop']) {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    const d = DEVICES[device];
    await page.setViewport(d.viewport);
    const cdp = await page.createCDPSession();
    await cdp.send('Emulation.setUserAgentOverride', { userAgent: d.ua, userAgentMetadata: d.meta });
    if (d.viewport.hasTouch) await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    const errors = [], bad = [], scripts = [];
    page.on('pageerror', (e) => errors.push(String(e?.message ?? e)));
    page.on('response', (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`); if (/\.js(\?|$)/.test(r.url())) scripts.push(r.url()); });
    await page.goto(`${ORIGIN}/editor/`, { waitUntil: 'networkidle2', timeout: 90_000 });
    await new Promise((r) => setTimeout(r, 2500));
    const r = await page.evaluate(() => ({
      mobileUi: !!document.querySelector('[data-pc="mobile-ui"]'), home: !!document.querySelector('[data-pcm="home"]'),
      // 2026-10-23 起在线桌面身份缺省进 Vibe 新界面（登录页 `start-login-form` / 开始页 `start-online`）；
      // 旧的账号表单 `account-projects` 只有 `?ui=classic` 才有，所以两者认其一
      desktopStart: !!document.querySelector('[data-pc="start-login-form"], [data-pc="start-online"], [data-pc="account-projects"]'),
      uaMobile: navigator.userAgentData?.mobile ?? null,
      overflow: { doc: document.documentElement.scrollWidth, vw: innerWidth },
    }));
    const notLoggedIn = bad.filter((b) => /^401 .*\/api\/account\/me/.test(b));
    // 第三方的回包不算我们站点的错：Google 登录的 `gsi/button` 在「JavaScript 来源还没把本站加进去」时回 400/403，
    // 这是控制台那边的配置，不是站点故障（2026-10-23 实测；加好来源后它就 200 了）。单列出来，不计进判定
    const thirdParty = bad.filter((b) => /\s+https:\/\/accounts\.google\.com\//.test(b));
    out[device] = { ...r, errors, bad, notLoggedIn: notLoggedIn.length, thirdParty, mobileChunk: scripts.some((u) => /MobileApp-/.test(u)) };
    if (device === 'phone') check(r.mobileUi && r.home && !r.desktopStart && r.overflow.doc <= r.overflow.vw, '手机仿真进手机版开始页、无横向溢出', out[device]);
    else check(!r.mobileUi && r.desktopStart && !out[device].mobileChunk, '桌面仿真进桌面开始页、不下载手机版分块', out[device]);
    check(errors.length === 0, `${device} 页面错误 0`, errors);
    check(bad.length === notLoggedIn.length + thirdParty.length, `${device} 4xx/5xx 0(未登录的 401、第三方登录的回包除外)`, bad);
    await page.screenshot({ path: path.join(OUT, `prod-${device}.png`) });
    await ctx.close();
  }
} catch (e) {
  fails.push(`异常:${e?.stack ?? e}`);
} finally {
  out.ok = fails.length === 0;
  out.fails = fails;
  await browser.close().catch(() => {});
  console.log(JSON.stringify(out));
  process.exit(out.ok ? 0 : 1);
}
