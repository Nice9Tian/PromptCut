/**
 * 舞台闸门、崩溃记录、护栏、档位气泡、查看口的真浏览器探针(`docs/plan/online-browser-task.md` 第三步;语义 `product/platforms.md`「在线浏览器」,
 * 做法 `mechanism/platforms.md`「三道闸门」)。无头 Chrome 打开在线构建的编辑页,**真的把页面进程杀掉**(CDP `Page.crash`)来模拟崩溃,
 * 再重新载入,看停在哪一级。
 *
 *   npx vite build --mode online
 *   node scripts/probes/stage-gate-probe.mjs [--dist dist-online] [--base-port 5870] [--out <目录>] [--only S1,S3]
 *
 * 端口:编辑器页 base、两个舞台 base+1 / +2、文档服务 base+3、素材服务 base+4(缺省 5870～5874)。本机隔离托管组合(`lib/mobile-env.mjs`),不连远端。
 * 页面里只读两个口:`window.__pcGates()`(查看口的数据)与 `[data-pc="tier-bubble"]`(气泡)。`?gateHold=<一步>`(只给验收)让舞台闸门记下那一步后停住,
 * 探针趁这时杀页面进程;`?gates=1` 打开只读查看口。
 *
 * 场景(每个场景一个新的浏览器上下文 = 全新的页面本地存储,除非写明接着上一个):
 *   S1  电脑全新打开:从低往高试,到第三级「顶配模式」;气泡文字照用户定的,几秒后自动消失;崩溃记录最后一步是「第 3 级运行中」
 *   S2  接着 S1 正常刷新(留了正常离开):不算崩;上次试成功,崩的次数为 0
 *   S3  试各一套渲染器时杀掉页面进程 → 重新载入停在第二级「标准模式」,崩 1 次、护栏 30 分钟;气泡「标准模式」
 *   S4  接着 S3:护栏内重新打开,停在第二级、不试
 *   S5  接着 S4:把护栏拨到过去(仿过了 30 分钟)→ 从头试,到第三级;再正常刷新 → 试成功一次,清零
 *   S6  试后台舞台时杀掉 → 停在第一级「精简模式」(一个舞台,没有后台舞台)
 *   S7  开可见舞台时(可见舞台就绪之前)杀掉 → 最低一档「低配模式」
 *   S8  切到后台(visibilitychange hidden)之后杀掉 → 不算崩
 *   S9  有护栏、崩过的记录,把记录里的软件版本改成旧的(仿升级)→ 清零,从头试
 *   S10 安卓手机(Chromium,报 4 GB)→ 不试,停在一个舞台,身份手机;报 8 GB → 试
 *   S11 电脑上只把后台舞台的进程杀掉(舞台崩了页面还在)→ 看守重载那一台、照旧第三级;反复崩 → 握手容错退回单舞台,只管当次:
 *       不留崩溃记录,重新载入照常试
 *   S12 iPad(桌面标识 + 多点触控):要试的先按电脑;试后台舞台时杀掉 → 重新载入停在第一级,身份改判手机
 *   S13 两个标签页:第一个还开着时开第二个,第二个不把第一个当成崩了
 *   S14 只读查看口:`?gates=1` 显示档位、舞台闸门、崩溃记录,不含凭证
 *
 * 输出:过程写 stderr;stdout 最后一行一行 JSON `{ ok, fails, scenes }`;截图在 --out。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { flagArg } from './probe-connect.mjs';
import { startMobileEnv, emptyProject, DEVICES } from './lib/mobile-env.mjs';

const args = process.argv.slice(2);
const DIST = path.resolve(flagArg('dist', 'dist-online', args));
const BASE = Number(flagArg('base-port', '5870', args));
const OUT = path.resolve(flagArg('out', path.join(os.tmpdir(), `stage-gate-${Date.now().toString(36)}`), args));
const ONLY = (flagArg('only', '', args) || '').split(',').filter(Boolean);
fs.mkdirSync(OUT, { recursive: true });

const fails = [];
const scenes = {};
const say = (...a) => process.stderr.write(`[stage-gate] ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`);
const check = (scene, cond, label, extra) => {
  if (!cond) fails.push(`${scene} ${label}${extra === undefined ? '' : ` :: ${JSON.stringify(extra).slice(0, 600)}`}`);
  (scenes[scene] ??= { checks: 0, failed: 0 }).checks++;
  if (!cond) scenes[scene].failed++;
  return !!cond;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeoutMs = 60_000, everyMs = 150) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(everyMs);
  }
}

const IPAD = {
  ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  viewport: { width: 1180, height: 820, deviceScaleFactor: 2, isMobile: false, hasTouch: true },
};

const env = await startMobileEnv({ dist: DIST, basePort: BASE, docPort: BASE + 3, assetPort: BASE + 4, name: 'stage-gate-probe' });
await env.seed(emptyProject('stage-gate-probe'));
const browser = await puppeteer.launch({ headless: true, protocolTimeout: 90_000, args: [...PROBE_CHROME_ARGS, '--no-first-run', '--autoplay-policy=no-user-gesture-required'] });

/** 新的上下文与页面;`device` 是 mobile-env 的设备名或 'ipad';`memory` 覆盖 navigator.deviceMemory */
async function newPage(device = 'desktop', { memory } = {}) {
  let page;
  if (device === 'ipad') {
    page = await env.newPage(browser, 'none');
    await page.setViewport(IPAD.viewport);
    await page.cdp.send('Emulation.setUserAgentOverride', { userAgent: IPAD.ua });
    await page.cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  } else {
    page = await env.newPage(browser, device);
  }
  if (memory !== undefined) await page.evaluateOnNewDocument((m) => { try { Object.defineProperty(Navigator.prototype, 'deviceMemory', { get: () => m, configurable: true }); } catch { /* 改不了 */ } }, memory);
  return page;
}
const gates = (page) => page.evaluate(() => (typeof window.__pcGates === 'function' ? window.__pcGates() : null)).catch(() => null);
const waitDone = (page, ms = 90_000) => until(async () => { const g = await gates(page); return g?.tier?.online && g.tier.gate === 'done' && g.step?.kind === 'running' ? g : null; }, ms);
const bubbleText = (page, ms = 30_000) => until(() => page.$eval('[data-pc="tier-bubble"]', (el) => el.textContent).catch(() => null), ms, 100);
async function enter(page, query = '') {
  await env.enter(page, { layout: 'desktop' });
  if (query) await page.goto(`${env.origin}/editor?layout=desktop&${query}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
}
async function reload(page, query) {
  const url = `${env.origin}/editor?layout=desktop${query ? `&${query}` : ''}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 });
}
/** 真的把页面(顶层文档)的渲染进程杀掉;回之后用新的 CDP 会话 */
async function crashPage(page) {
  const crashed = new Promise((resolve) => { page.once('error', () => resolve(true)); setTimeout(() => resolve(false), 15_000); });
  const cdp = await page.createCDPSession();
  // `Page.crash` 不回包(渲染进程当场没了):不等它,等页面的「Page crashed!」事件
  void cdp.send('Page.crash').catch(() => {});
  const ok = await crashed;
  if (!ok) fails.push('Page.crash 之后 15 秒没等到页面崩溃的事件');
  return ok;
}
/** 崩了之后用户点「重新加载」(同一个标签页) */
async function reloadAfterCrash(page, query) {
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 }).catch(async () => { await reload(page, query); });
}
const tabStep = (g) => g?.step;
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`) }).catch(() => {});
const want = (id) => !ONLY.length || ONLY.includes(id);
const TEXT = {
  top: '这台设备运行在顶配模式', standard: '这台设备运行在标准模式',
  lite: '这台设备运行在精简模式：复杂的效果交给云端渲染', low: '这台设备运行在低配模式：播放时只显示已渲染好的画面',
};
async function holdAndCrash(scene, page, what) {
  await reload(page, `gateHold=${what}`);
  const reached = await until(async () => { const g = await gates(page); return g?.step?.kind === 'stage' && g.step.what === what ? g : null; }, 90_000, 50);
  check(scene, !!reached, `停在「${what}」那一步(gateHold)`, await gates(page));
  await crashPage(page);
  await reloadAfterCrash(page, `gateHold=${what}`);
}

try {
  /* ---------------------------------------------------------------- S1～S5:电脑 */
  if (want('S1') || want('S2') || want('S3') || want('S4') || want('S5')) {
    const page = await newPage('desktop');
    await enter(page);
    let g = await waitDone(page);
    check('S1', g?.tier?.reached === 3 && g.tier.target === 3 && !g.tier.lowest, '全新打开:到第三级', g?.tier);
    check('S1', g?.decision?.reason === 'trial', '从低往高试', g?.decision);
    check('S1', g?.judged?.crashed === false, '没判崩');
    check('S1', tabStep(g)?.kind === 'running' && tabStep(g).level === 3, '最后一步是第 3 级运行中', tabStep(g));
    const steps = (g?.log?.history ?? []).length;
    check('S1', steps >= 1, '查看口有历次判定');
    const b1 = await bubbleText(page);
    check('S1', b1 === TEXT.top, '气泡:顶配模式', b1);
    await shot(page, 'S1-bubble');
    const gone = await until(() => page.$('[data-pc="tier-bubble"]').then((e) => !e), 15_000, 200);
    check('S1', !!gone, '气泡几秒后自动消失');
    const iframes = await page.$$eval('iframe[data-pc^="stage-frame"]', (els) => els.map((e) => ({ pc: e.dataset.pc, src: e.getAttribute('src') })));
    check('S1', iframes.length === 2 && iframes.every((f) => /[?&]gl=shared/.test(f.src)), '两个舞台,地址按起手的路线(共用)拼、不因试第三级而变', iframes);
    scenes.S1.tier = g?.tier;
    // 即时渲染闸门的基准卡、素材闸门的解码上限(第四步):测完了,结论进查看口
    const gb = await until(async () => { const x = await gates(page); return x?.tier?.benchmark !== 'pending' ? x : null; }, 60_000);
    check('S1', gb?.tier?.benchmark === 'ok' && typeof gb.benchmark?.stepMs === 'number', '基准卡测了、跑得动', gb?.benchmark);
    check('S1', typeof gb?.media?.decode?.maxPixels === 'number', '解码上限打开时测了一次', gb?.media?.decode);
    scenes.S1.benchmark = gb?.benchmark;
    scenes.S1.decode = gb?.media?.decode;

    // S2 正常刷新
    await reload(page);
    g = await waitDone(page);
    check('S2', g?.judged?.crashed === false, '正常刷新不算崩', g?.judged);
    check('S2', g?.log?.device?.stage?.crashes === 0, '崩的次数 0', g?.log?.device?.stage);
    check('S2', g?.tier?.reached === 3, '照样到第三级');

    // S3 试各一套时杀掉
    await holdAndCrash('S3', page, 'try-separate');
    g = await waitDone(page);
    check('S3', g?.judged?.crashed === true && g.judged.step?.what === 'try-separate', '判崩,崩在试各一套', g?.judged);
    check('S3', g?.decision?.reason === 'crash' && g.tier.target === 2 && g.tier.reached === 2, '停在第二级、不试', g?.tier);
    const st = g?.log?.device?.stage;
    check('S3', st?.crashes === 1 && st.guardUntil && Math.abs(st.guardUntil - Date.now() - 30 * 60_000) < 120_000, '崩 1 次,护栏 30 分钟', st);
    const b3 = await bubbleText(page);
    check('S3', b3 === TEXT.standard, '气泡:标准模式', b3);
    await shot(page, 'S3-standard');
    scenes.S3.sessionKept = g?.judged?.fromTab === g?.tab ? 'same-tab' : 'other-tab';

    // S4 护栏内
    await reload(page);
    g = await waitDone(page);
    check('S4', g?.decision?.reason === 'guard' && g.tier.target === 2, '护栏内:停在第二级、不试', g?.decision);

    // S5 过了护栏:从头试;试成功再刷新清零
    await page.evaluate(() => { const k = 'pc.online.crashLog'; const l = JSON.parse(localStorage.getItem(k)); l.device.stage.guardUntil = Date.now() - 1000; localStorage.setItem(k, JSON.stringify(l)); });
    await reload(page);
    g = await waitDone(page);
    check('S5', g?.decision?.reason === 'trial' && g.tier.reached === 3, '过了护栏:从头试到第三级', g?.decision);
    check('S5', g?.log?.device?.stage?.crashes === 1, '这时崩的次数还在(试成功的判据是下次载入没判崩)');
    await reload(page);
    g = await waitDone(page);
    check('S5', g?.log?.device?.stage?.crashes === 0 && g.log.device.stage.guardUntil === null, '试成功一次:清零', g?.log?.device?.stage);

    // S9 升级清零(先造一条崩过、有护栏的记录)
    if (want('S9') || !ONLY.length) {
      await page.evaluate(() => { const k = 'pc.online.crashLog'; const l = JSON.parse(localStorage.getItem(k)); l.device.stage = { reached: 1, lowest: false, crashes: 3, guardUntil: Date.now() + 3600_000, tried: false }; l.device.version = 'older-build'; localStorage.setItem(k, JSON.stringify(l)); });
      await reload(page);
      g = await waitDone(page);
      check('S9', g?.decision?.reason === 'trial' && g.log.device.stage.crashes <= 0 && g.tier.reached === 3, '软件版本变了:清零、从头试', g?.decision);
    }
    await page.browserContext().close();
  }

  /* ---------------------------------------------------------------- S6 试后台舞台时杀掉 */
  if (want('S6')) {
    const page = await newPage('desktop');
    await enter(page);
    await waitDone(page);
    await holdAndCrash('S6', page, 'try-back');
    const g = await waitDone(page);
    check('S6', g?.judged?.crashed && g.tier.target === 1 && !g.tier.lowest, '停在第一级(精简)', g?.tier);
    const frames = await page.$$eval('iframe[data-pc^="stage-frame"]', (els) => els.map((e) => e.dataset.pc));
    check('S6', frames.length === 1, '只有一个舞台', frames);
    const b = await bubbleText(page);
    check('S6', b === TEXT.lite, '气泡:精简模式', b);
    await shot(page, 'S6-lite');
    await page.browserContext().close();
  }

  /* ---------------------------------------------------------------- S7 开可见舞台时杀掉 */
  if (want('S7')) {
    const page = await newPage('desktop');
    await enter(page);
    await waitDone(page);
    await holdAndCrash('S7', page, 'open-visible');
    const g = await waitDone(page);
    check('S7', g?.judged?.crashed && g.tier.lowest === 'stage' && g.tier.target === 1, '最低一档(一个舞台都撑不住)', g?.tier);
    const src = await page.$eval('iframe[data-pc="stage-frame"]', (e) => e.getAttribute('src')).catch(() => '');
    check('S7', /[?&]lowest=1/.test(src) && /[?&]compact=1/.test(src), '舞台起手就按最低一档(素材只用小尺寸)', src);
    const b = await bubbleText(page);
    check('S7', b === TEXT.low, '气泡:低配模式', b);
    await shot(page, 'S7-low');
    await page.browserContext().close();
  }

  /* ---------------------------------------------------------------- S8 在后台被回收不算崩 */
  if (want('S8')) {
    const page = await newPage('desktop');
    await enter(page);
    await waitDone(page);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await sleep(300);
    const g0 = await gates(page);
    const mine = g0?.log?.tabs?.[g0.tab];
    check('S8', mine?.background === true, '记下了在后台', mine);
    await crashPage(page);
    await reloadAfterCrash(page);
    const g = await waitDone(page);
    check('S8', g?.judged?.crashed === false && g.decision.reason === 'trial', '在后台被回收:不算崩', g?.judged);
    await page.browserContext().close();
  }

  /* ---------------------------------------------------------------- S10 安卓 */
  if (want('S10')) {
    for (const [mem, expect] of [[4, 'fixed'], [8, 'trial']]) {
      const page = await newPage('phone', { memory: mem });
      await enter(page);
      const g = await waitDone(page);
      if (expect === 'fixed') {
        check('S10', g?.decision?.reason === 'android-memory' && g.tier.target === 1, `安卓 ${mem} GB:停在一个舞台、不试`, g?.decision);
        check('S10', g?.tier?.identity === 'phone', '身份手机');
        const b = await bubbleText(page);
        check('S10', b === TEXT.lite, '气泡:精简模式', b);
        await shot(page, 'S10-android-4g');
      } else {
        check('S10', g?.decision?.reason === 'trial', `安卓 ${mem} GB:试`, g?.decision);
      }
      await page.browserContext().close();
    }
  }

  /* ---------------------------------------------------------------- S11 电脑上只杀后台舞台的进程 */
  if (want('S11')) {
    const page = await newPage('desktop');
    await enter(page);
    let g = await waitDone(page);
    const before = g?.tier?.reached;
    const stageBTarget = () => browser.targets().find((t) => t.url().includes(`:${BASE + 2}/`) && /[?&]id=B/.test(t.url()));
    const crashB = async () => {
      const t = await until(() => stageBTarget(), 30_000, 200);
      if (!t) return false;
      const cdp = await t.createCDPSession().catch(() => null);
      void cdp?.send('Page.crash').catch(() => {});
      return true;
    };
    check('S11', !!stageBTarget(), '后台舞台是独立的渲染进程(OOPIF 目标)');
    // 第一次崩:看守整页重载那一台,握回来恢复双舞台(原有做法);页面与档位都不受影响、不留崩溃记录
    await crashB();
    const watch1 = await until(() => page.evaluate(() => window.__pcStageWatch?.()).then((w) => (w && w.reloads >= 1 ? w : null)), 90_000, 500);
    check('S11', !!watch1, '舞台崩了页面还在:看守重载那一台', watch1);
    g = await until(async () => { const x = await gates(page); return x?.tier?.reached === 3 ? x : null; }, 60_000, 500);
    check('S11', g?.tier?.target === 3 && g.step?.kind === 'running' && g.step.level === 3, '重载那一台后照旧第三级,崩溃记录不动', g?.step);
    // 反复崩(看守重载到上限):握手容错退回单舞台,只管当次
    for (let i = 0; i < 4; i++) {
      const w = await page.evaluate(() => window.__pcStageWatch?.()).catch(() => null);
      if (w?.fellBack) break;
      await until(() => page.evaluate(() => { const x = window.__pcStageWatch?.(); return x && x.B === 'ok' ? x : null; }), 60_000, 500);
      await crashB();
      await until(() => page.evaluate((n) => { const x = window.__pcStageWatch?.(); return x && (x.reloads > n || x.fellBack) ? x : null; }, (w?.reloads ?? 0)), 90_000, 500);
    }
    g = await until(async () => { const x = await gates(page); return x?.tier?.target === 1 ? x : null; }, 120_000, 500);
    check('S11', !!g && g.tier.reached === 1, `反复崩:握手容错退回单舞台(之前第 ${before} 级)`, g?.tier ?? await gates(page));
    check('S11', g?.step?.kind === 'running' && g.step.level === 1, '只管当次:最后一步是第 1 级运行中,不留「崩在试……」', g?.step);
    await reload(page);
    g = await waitDone(page);
    check('S11', g?.judged?.crashed === false && g.decision.reason === 'trial' && g.tier.reached === 3, '重新载入照常试,不算崩', g?.decision);
    await page.browserContext().close();
  }

  /* ---------------------------------------------------------------- S12 iPad */
  if (want('S12')) {
    const page = await newPage('ipad');
    await enter(page);
    let g = await waitDone(page);
    check('S12', g?.tier?.identity === 'desktop', 'iPad 要试:先按电脑', g?.tier);
    await holdAndCrash('S12', page, 'try-back');
    g = await waitDone(page);
    check('S12', g?.tier?.target === 1 && g.tier.identity === 'phone', 'iPad 停在第一级:身份改判手机', g?.tier);
    await page.browserContext().close();
  }

  /* ---------------------------------------------------------------- S13 两个标签页 */
  if (want('S13')) {
    const page = await newPage('desktop');
    await enter(page);
    await waitDone(page);
    const second = await page.browserContext().newPage();
    await second.setViewport(DEVICES.desktop.viewport);
    await second.goto(`${env.origin}/editor?layout=desktop`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    // 新标签页没有会话恢复记录:停在开始页也照样开舞台闸门吗?闸门只在编辑页挂,这里直接读崩溃记录
    await sleep(3000);
    const log = await second.evaluate(() => JSON.parse(localStorage.getItem('pc.online.crashLog') || 'null'));
    const last = log?.history?.at(-1);
    check('S13', log && last && last.crashed === false, '第二个标签页:不把还开着的第一个当成崩了', last);
    await page.browserContext().close();
  }

  /* ---------------------------------------------------------------- S14 查看口 */
  if (want('S14')) {
    const page = await newPage('desktop');
    await enter(page);
    await reload(page, 'gates=1');
    await waitDone(page);
    const rows = await until(() => page.$$eval('[data-pc="gate-viewer"] td[data-pc-gate-row]', (els) => els.map((e) => [e.dataset.pcGateRow, e.textContent])), 30_000);
    check('S14', rows && rows.length >= 8, '查看口有各闸门的结果', rows);
    const json = await page.evaluate(() => JSON.stringify(window.__pcGates()));
    check('S14', !/ticket|password|token|"key":"[A-Za-z0-9_-]{43}"/i.test(json), '查看口不含凭证', json.slice(0, 200));
    await shot(page, 'S14-viewer');
    await page.browserContext().close();
  }
} catch (e) {
  fails.push(`异常:${String(e?.stack ?? e).slice(0, 800)}`);
} finally {
  await browser.close().catch(() => {});
  await env.close().catch(() => {});
}

const result = { ok: fails.length === 0, fails, scenes, out: OUT };
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(fails.length ? 1 : 0);
