/**
 * M7 契约第 8 节 P5(`docs/plan/m7-contract.md`):真 Chrome 里页面隐藏、窗口最小化、页面被冻结(frozen)时,
 * 续约(`task.progress`,队列 `RENEW_INTERVAL_MS` = 10 s、`LEASE_MS` = 30 s)与会话(文档服务 30 s 一轮 ping / pong)
 * 会怎样;放回(`task.release`)能多快到服务端。报告:docs/archive/agent-reports/AGENT-m7-probe.md。
 *
 *   node scripts/probes/m7-visibility-probe.mjs [--chrome installed|bundled] [--port 5717]
 *        [--scenarios tab,minimize,freeze30,freeze90] [--tab-min 6.5] [--min-min 2] [--ping-ms 5000] [--occlusion off|on]
 *
 * 做法:本进程起一个 WebSocket 服务(`server/docservice/ws.mjs`,与文档服务同一份实现),每 `--ping-ms` 发一次 ping、
 * 记 pong;页面(有头 Chrome,`--chrome installed` 用本机装的 Google Chrome 配一次性配置目录,缺省;`bundled` 用 puppeteer 自带的)
 * 照渲染节点的做法:
 *   - `setInterval(续约, 10 s)` 发 `progress`;另一条 `setTimeout(0)` 链当「逐帧生成快照」,每秒报一次推了几帧;
 *   - `visibilitychange` 变 hidden 时立即发 `release`(契约 D8:页面隐藏不等当前帧);`freeze` / `resume` / `pagehide` 各发一条。
 * 服务端按收到的时刻记账。情形:
 *   tab       切到另一个标签(页面 hidden)`--tab-min` 分钟(过 5 分钟看 Chrome 的强化节流);
 *   minimize  窗口最小化 `--min-min` 分钟;
 *   freeze30 / freeze90  CDP `Page.setWebLifecycleState { state: 'frozen' }` 冻结 30 s / 90 s 再恢复(模拟 Chrome 冻结后台页)。
 * 页面的连接断了就 0.5 s 后重连(发 `reopen`),好让后一种情形还有连接可看。
 * 每种情形算:隐藏到服务端收到 `release` 的延迟;隐藏期间续约的间隔(最大间隔是否超过 `LEASE_MS`);帧链每秒几次;
 * ping 有没有 pong(冻结时连接会不会被心跳判死);恢复后连接是否还在、积压的消息何时到。
 * 输出:过程写 stderr;最后一行 stdout 是一行 JSON,原始事件写 --out(缺省系统临时目录)下 m7-visibility-<时刻>.json。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { acceptUpgrade } from '../../server/docservice/ws.mjs';
import { flagArg, sleep } from './probe-connect.mjs';

const PORT = Number(flagArg('port', '5717'));
const CHROME = flagArg('chrome', 'installed');
const SCEN = (flagArg('scenarios') || 'tab,minimize,freeze30,freeze90').split(',');
const TAB_MIN = Number(flagArg('tab-min', '6.5'));
const MIN_MIN = Number(flagArg('min-min', '2'));
const PING_MS = Number(flagArg('ping-ms', '5000'));
// 缺省关掉「窗口被别的程序挡住就算 hidden」(本机桌面上有别的窗口,会让页面在情形开始前就 hidden);`--occlusion on` 保留
const OCCLUSION = flagArg('occlusion', 'off') === 'on';
const OUT = path.resolve(flagArg('out', os.tmpdir()));
const LEASE_MS = 30_000;
const log = (...a) => console.error(...a);

const PAGE = `<!doctype html><meta charset=utf-8><title>m7 visibility</title><body><div id=s></div><script>
const t0 = performance.now();
let ws, frames = 0, seq = 0, reopened = false;
const send = (m) => { try { ws && ws.readyState === 1 && ws.send(JSON.stringify({ ...m, seq: ++seq, pageMs: Math.round(performance.now() - t0), vis: document.visibilityState })); } catch {} };
function open() {
  ws = new WebSocket('ws://' + location.host + '/ws');
  ws.onopen = () => send({ t: reopened ? 'reopen' : 'open', lastClose: window.__closed ?? null });
  ws.onclose = (e) => { window.__closed = { code: e.code, at: performance.now() - t0 }; (window.__closes ||= []).push(window.__closed); setTimeout(() => { open(); reopened = true; }, 500); };
}
open();
setInterval(() => send({ t: 'progress' }), 10000);
(function loop() { frames++; setTimeout(loop, 0); })();
setInterval(() => { send({ t: 'fps', frames }); frames = 0; }, 1000);
document.addEventListener('visibilitychange', () => { send({ t: 'vis' }); if (document.visibilityState === 'hidden') send({ t: 'release' }); });
document.addEventListener('freeze', () => send({ t: 'freeze' }));
document.addEventListener('resume', () => send({ t: 'resume' }));
addEventListener('pagehide', () => send({ t: 'pagehide' }));
</script>`;

const events = [];
let conns = 0;
const T0 = Date.now();
const now = () => Date.now() - T0;
const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(PAGE); });
server.on('upgrade', (req, socket, head) => {
  const ws = acceptUpgrade(req, socket, head, {});
  if (!ws) return;
  const id = ++conns;
  events.push({ at: now(), t: 'srv-open', conn: id });
  let waitingPong = null;
  const timer = setInterval(() => {
    if (waitingPong !== null) events.push({ at: now(), t: 'srv-ping-unanswered', conn: id, since: waitingPong });
    waitingPong = now();
    try { ws.ping(); } catch {}
  }, PING_MS);
  ws.on('pong', () => { events.push({ at: now(), t: 'srv-pong', conn: id, rtt: waitingPong === null ? null : now() - waitingPong }); waitingPong = null; });
  ws.on('message', (data) => { let m; try { m = JSON.parse(String(data)); } catch { return; } events.push({ at: now(), conn: id, ...m }); });
  ws.on('close', (code) => { clearInterval(timer); events.push({ at: now(), t: 'srv-close', conn: id, code }); });
  ws.on('error', () => {});
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

function installedChrome() {
  for (const p of ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe']) if (fs.existsSync(p)) return p;
  return null;
}
const exe = CHROME === 'installed' ? installedChrome() : null;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'm7-vis-profile-'));
const defaults = await puppeteer.defaultArgs({ headless: false });
const ignore = ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', ...defaults.filter((a) => a.startsWith('--disable-features='))];
const browser = await puppeteer.launch({ headless: false, executablePath: exe ?? undefined, userDataDir: profile, ignoreDefaultArgs: ignore, defaultViewport: null, protocolTimeout: 900000,
  args: [...PROBE_CHROME_ARGS, '--window-size=900,700', '--window-position=60,60', '--no-first-run', '--no-default-browser-check', ...(OCCLUSION ? [] : ['--disable-backgrounding-occluded-windows'])] });
const version = await browser.version();
log(`chrome ${version} (${exe ?? 'puppeteer bundled'}) profile ${profile}`);
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await sleep(3000);
const cdp = await page.createCDPSession();
const { windowId } = await cdp.send('Browser.getWindowForTarget');

/** 一段时间窗里的事件 */
const between = (a, b) => events.filter((e) => e.at >= a && e.at <= b);
function summarize(name, a, b, hideAt) {
  const ev = between(a, b);
  const progress = ev.filter((e) => e.t === 'progress').map((e) => e.at);
  const gaps = progress.slice(1).map((x, i) => x - progress[i]);
  // 隐藏窗内(含恢复后第一条)续约的最大间隔
  const lastBefore = events.filter((e) => e.t === 'progress' && e.at <= hideAt).at(-1)?.at ?? a;
  const firstAfter = events.find((e) => e.t === 'progress' && e.at > b)?.at ?? null;
  const pts = [lastBefore, ...progress.filter((x) => x > hideAt), ...(firstAfter ? [firstAfter] : [])];
  const maxGap = Math.max(0, ...pts.slice(1).map((x, i) => x - pts[i]));
  const release = ev.find((e) => e.t === 'release');
  const fps = ev.filter((e) => e.t === 'fps').map((e) => e.frames);
  const pongs = ev.filter((e) => e.t === 'srv-pong').length;
  const unanswered = ev.filter((e) => e.t === 'srv-ping-unanswered').length;
  const closes = events.filter((e) => e.t === 'srv-close' && e.at >= a);
  // 服务端收到页面消息的时刻 vs 页面发出时的时钟:恢复后积压的消息一起到
  return { name, windowMs: b - a, releaseLatencyMs: release ? release.at - hideAt : null, releaseVis: release?.vis ?? null,
    progressCount: progress.length, progressGapMs: gaps, maxRenewGapMs: maxGap, leaseWouldExpire: maxGap > LEASE_MS,
    framesPerSec: { n: fps.length, min: Math.min(...fps), max: Math.max(...fps), median: fps.sort((x, y) => x - y)[Math.floor(fps.length / 2)] },
    pongs, pingsUnanswered: unanswered, serverCloses: closes.map((c) => ({ at: c.at, code: c.code })),
    lifecycle: ev.filter((e) => ['vis', 'freeze', 'resume', 'pagehide', 'open', 'reopen', 'srv-open', 'srv-close'].includes(e.t)).map((e) => ({ t: e.t, at: e.at - hideAt, vis: e.vis })) };
}

const results = [];
for (const sc of SCEN) {
  await page.bringToFront();
  await sleep(12000);
  const visBefore = await page.evaluate(() => document.visibilityState).catch(() => '?');
  log(`[${sc}] before: ${visBefore}`);
  const a = now();
  if (sc === 'tab') {
    const other = await browser.newPage();
    await other.goto('about:blank');
    const hideAt = now();
    await other.bringToFront();
    log(`[tab] hidden for ${TAB_MIN} min`);
    await sleep(TAB_MIN * 60000);
    const b = now();
    await page.bringToFront();
    await other.close();
    await sleep(12000);
    results.push(summarize('tab', a, b, hideAt));
  } else if (sc === 'minimize') {
    const hideAt = now();
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    log(`[minimize] ${MIN_MIN} min`);
    await sleep(MIN_MIN * 60000);
    const b = now();
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await sleep(12000);
    results.push(summarize('minimize', a, b, hideAt));
  } else if (sc.startsWith('freeze')) {
    const ms = Number(sc.slice(6)) * 1000;
    // 冻结前先隐藏(Chrome 只冻结后台页;CDP 的冻结对可见页也生效,这里照真实顺序:先 hidden 再 frozen)
    const other = await browser.newPage();
    await other.goto('about:blank');
    const hideAt = now();
    await other.bringToFront();
    await sleep(2000);
    await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
    log(`[${sc}] frozen ${ms / 1000} s`);
    await sleep(ms);
    const b = now();
    await cdp.send('Page.setWebLifecycleState', { state: 'active' });
    await page.bringToFront();
    await other.close();
    await sleep(15000);
    const row = summarize(sc, a, b, hideAt);
    row.frozenMs = ms;
    row.closedInPage = await page.evaluate(() => window.__closes ?? null).catch((e) => String(e));
    // 恢复之后 15 s 里的事件(积压的消息、重连)
    row.afterResume = events.filter((e) => e.at > b && e.at <= b + 15000 && e.t !== 'fps' && e.t !== 'srv-pong').map((e) => ({ t: e.t, at: e.at - b, pageMs: e.pageMs, code: e.code }));
    results.push(row);
  }
  log(JSON.stringify(results.at(-1)));
}
const file = path.join(OUT, `m7-visibility-${Date.now()}.json`);
fs.writeFileSync(file, JSON.stringify({ version, exe, events, results }, null, 1));
await browser.close().catch(() => {});
server.close();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 一次性配置目录 */ }
console.log(JSON.stringify({ version, file, results: results.map((r) => ({ ...r, lifecycle: r.lifecycle.slice(0, 8), progressGapMs: r.progressGapMs.slice(0, 50) })) }));
