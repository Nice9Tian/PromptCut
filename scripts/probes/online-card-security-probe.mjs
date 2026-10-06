/**
 * 安全验收探针:在线执行用户卡与图卡的隔离(任务书 `docs/plan/sound-online-render-task.md` 第 14 条,**核心项**;
 * 契约 `docs/plan/online-card-exec-contract.md` 第 3、4、10 节)。用断言,不靠推断。
 *
 *   npx vite build --mode online
 *   node scripts/probes/online-card-security-probe.mjs [--dist dist-online] [--base-port 5750] [--doc-port 8780] [--asset-port 8781]
 *        [--out <截图目录>] [--only A,B,G,C,L,S,N,M] [--headful]
 *
 * 全程在本机、不连任何远端:本机托管组合(不信回环,素材服务真核票据) + 仿 nginx 的代理 `lib/hosted-proxy.mjs`(策略头与
 * `/media-s/` 的判定和 nginx 模板同出 `src/online/stagePolicy.mjs`) + 在线构建。三个源同站跨源:
 * 编辑器页 `http://pc.localhost:<base>`、舞台 `http://s1.pc.localhost:<base+1>`、`http://s2.pc.localhost:<base+2>`;
 * 收集站 `http://127.0.0.1:<base+7>`(另一个站;记每条 TCP 连接、每个 UDP 包、每个 HTTP 请求)。
 *
 * 攻击代码是夹具 `fixtures/online-card-attacks/probe-evil-attacks.ts`(恶意用户卡 `probe-evil-card.tsx`、恶意图卡
 * `probe-evil-graph.tsx` 都引它)。加载器还没接到舞台上,所以本探针把夹具当「代表卡片代码的脚本」直接在舞台的帧里用
 * `new Function("require", "module", "exports", 代码)` 执行(与加载器执行转译结果的办法相同):舞台 A 里按「用户卡」跑一遍,
 * 舞台 B 里按「图卡」跑一遍(多一组凭 cookie 读素材进 GPU),各自再在舞台起的 blob Worker 里跑声音那一半。
 * 与块 T 合流后改成经真实加载路径再跑一遍(三份夹具原样 `content.put`)。
 *
 * # 验收标准(每条一行「过 / 不过 / 缺口」,最后一行是 JSON `{ ok, pass, fail, gaps, fails, notes }`;退出码 = 有没有「不过」)
 *
 * **核心项:下面 A2、A3 任何一条读得到凭证或票据 = 第二段的核心项不过。**
 *
 * A 隔离生效时(新 nginx:策略头 + 出口白名单 + `/media-s/`)
 *   A1 前提:两台舞台自检通过、票据交接成功、本页判「可执行」;舞台 iframe 的 `sandbox` 只有脚本与自己的源两项;
 *      舞台响应带内容安全策略与出口白名单,编辑器页带 `frame-src`;舞台读素材的地址是 `/media-s/<sid>/media/<哈希>`、不带 `?t=`。
 *   A2 父页对象:`parent.*`、`top.*`、别的舞台,读任何属性抛 `SecurityError`;`opener`、`frameElement` 为空。
 *   A3 凭证、票据、本机存储:把舞台(窗口与 Worker)里读得到的一切倒出来 —— localStorage、sessionStorage、IndexedDB 全部内容、
 *      可读 cookie、cookieStore、OPFS、Cache、性能条目、DOM 属性、全局变量与观察口、父页发来的每一条消息、凭 cookie 读素材的应答头 ——
 *      里面没有:项目密码、编辑器页存的凭证(密钥)、设备身份、页面拿到过的每一张票据、探针种在编辑器页各处存储里的记号;
 *      也没有任何票据形状的串(`v1.<…>.<…>`)与 `?t=`。
 *   A4 图卡干得了活:凭 cookie 按 Range 取到素材(206、字节对),画进 2D 画布、传进 WebGL2 纹理读得回像素;换一个 `sid`、
 *      不带票据走旧路由都是 401;只放行 GET / HEAD,只放行素材字节那一种路径。
 *   A5 带不走:夹具里每一种向收集站发请求的办法(fetch / XHR / WebSocket / sendBeacon / EventSource / WebTransport / 图片 /
 *      CSS / 字体 / 脚本 / 动态载入 / 子框架 / 插件 / 媒体 / 表单 / 预取与预连接 / Worker / Service Worker / worklet / 开窗 / WebRTC)
 *      跑完,收集站 0 条 TCP 连接、0 个 UDP 包、0 个 HTTP 请求;导航类(自己跳走、带走顶层、开新窗口、meta 刷新、链接、表单)
 *      每种单开一页,收集站 0 个请求、顶层地址没变、没开出新窗口。
 *   A6 声音线程(Worker):没有父页、文档、localStorage、`RTCPeerConnection`;网络全拦下(收集站 0)。
 *   A7 加固:可行性探针试过的 21 条从子框架拿回 `RTCPeerConnection` 的路,加实现时补的,一条都拿不到;
 *      有代码试图造子框架之后,父页本次会话不再判「可执行」。
 *   A8 父页对伪造消息:舞台发各种伪造的握手、RPC 回包、舞台事件(超范围的数、巨串、带脚本的 HTML),父页不崩、不报错、
 *      不把那段 HTML 放进活文档、存储里没有超范围的数。
 *   A9 DNS:Chrome 的网络日志里没有对「受控组用的那个域名」的解析。
 * B 浏览器层面拦 WebRTC:假设脚本加固被绕过(探针在页面脚本之前留一份原装的构造器),隔离生效时 WebRTC 仍然 0 个包到收集站
 *   (`Connection-Allowlist`)。另核加固的第二层:假设「不给造子框架元素」那一层被绕过(探针留一个原装造出来的 iframe 元素),
 *   每个插入入口都拦下、舞台里不出现子框架。
 * G **已知缺口**(单列;记录现状,不算失败,也不许悄悄消失):只有内容安全策略、没有出口白名单时(仿不认 `Connection-Allowlist`
 *   的浏览器),脚本加固在的时候拿不到构造器、收集站 0;**假设脚本加固被绕过,WebRTC 的包到得了收集站**(`webrtc 'block'` 不管用)。
 *   这一条哪天不成立了(浏览器开始执行 `webrtc 'block'`),探针记「缺口已不存在」提醒更新文档。
 * C 对照:去掉策略与出口白名单,同一段攻击代码的请求到得了收集站、域名被解析 —— 证明上面的「收不到」不是探针瞎了。
 * L 旧 nginx(没有策略头、没有 `/media-s/`):舞台自检不过(只有 `<meta>` 兜底),本页不执行,素材照旧走 `?t=`,内置卡照常画。
 * S 托管方关掉总开关(运行配置 `onlineCardExec: false`):本页不执行,原因是总开关。
 * N 没有舞台源(读不到运行配置;放本机、没有 nginx 子域的部署):同源单舞台,不执行。
 * M 低内存档(仿手机):同源单舞台,不执行。
 *   L / S / N / M 里编辑器页与每个舞台文档的执行闸门都是关的。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import puppeteer from 'puppeteer';
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { startHostedProxy, proxyOrigins } from './lib/hosted-proxy.mjs';
import { startHostedCombo } from '../../server/hosted/combo.mjs';
import { createSharedProject, buildAuthProtocols } from '../../server/auth/client.mjs';
import { createAssetClient } from '../../server/asset-store/client.mjs';
import { STAGE_CONNECTION_ALLOWLIST, stageCspHeader, editorCspHeader } from '../../src/online/stagePolicy.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.resolve(arg('--dist', path.join(ROOT, 'dist-online')));
const BASE = Number(arg('--base-port', 5750));
const DOC_PORT = Number(arg('--doc-port', 8780)), ASSET_PORT = Number(arg('--asset-port', 8781));
const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), 'online-card-security-shots')));
const ONLY = arg('--only', 'A,B,G,C,L,S,N,M').split(',');
const HEADFUL = argv.includes('--headful');
const EVIL_PORT = BASE + 7;
const EVIL = `http://127.0.0.1:${EVIL_PORT}`;
const ORIGINS = proxyOrigins(BASE);
const DOC_DIRECT = `http://127.0.0.1:${DOC_PORT}`;
fs.mkdirSync(OUT, { recursive: true });

/** 探针知道的秘密:值 → 标签。**值不打印**,比对时只报标签 */
const secrets = new Map();

/* ------------------------------------------------------------------ 记分 */
const fails = [], notes = [];
let pass = 0;
/** 打印前把票据形状的串与探针知道的秘密都盖掉(令牌、密钥的值不进输出) */
const scrub = (s) => { let o = s.replace(/v1\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, 'v1.***'); for (const [value] of secrets) o = o.split(value).join('***'); return o; };
const short = (v) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s === undefined ? '' : scrub(s.length > 300 ? `${s.slice(0, 300)}…` : s); };
const check = (label, ok, detail) => { console.log(`${ok ? '  过' : '不过'}  ${label}${detail === undefined || detail === '' ? '' : `  〔${short(detail)}〕`}`); if (ok) pass++; else fails.push(label); return !!ok; };
/** 已知缺口:`present` 为真 = 缺口还在(记现状,不算失败);为假 = 缺口不见了(同样不算失败,但要醒目提醒更新文档) */
const gaps = [];
const gap = (label, present, detail) => { console.log(`${present ? '缺口' : '注意'}  ${label}${present ? '' : ' —— 这一条缺口已不存在,更新契约与报告里的表述'}${detail ? `  〔${short(detail)}〕` : ''}`); gaps.push({ label, present }); if (!present) notes.push(`缺口已不存在:${label}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 30_000, every = 250) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) { check(`等到:${what}`, false, `${ms} ms 没等到`); return null; }
    await sleep(every);
  }
}

/* ------------------------------------------------------------------ 夹具:攻击代码(ESM 写法换成 CommonJS) */
const FIXTURE_DIR = path.join(ROOT, 'scripts', 'probes', 'fixtures', 'online-card-attacks');
const LIB = (() => {
  const names = [];
  const src = fs.readFileSync(path.join(FIXTURE_DIR, 'probe-evil-attacks.ts'), 'utf8')
    .replace(/^export (async )?function (\w+)/gm, (_m, a, n) => { names.push(n); return `${a ?? ''}function ${n}`; });
  if (/^\s*(import|export)\s/m.test(src)) throw new Error('夹具里还有没换掉的 import / export');
  return `${src}\n${names.map((n) => `exports.${n} = ${n};`).join('\n')}\n`;
})();

/* ------------------------------------------------------------------ 收集站 */
const png = (() => { const p = new PNG({ width: 4, height: 4 }); for (let i = 0; i < 16; i++) p.data.set([10, 200, 30, 255], i * 4); return PNG.sync.write(p); })();
const evil = { connections: 0, requests: [], udp: 0 };
const evilSrv = http.createServer((req, res) => {
  evil.requests.push(`${req.method} ${req.url}`);
  const type = req.url.includes('.js') ? 'text/javascript' : req.url.includes('.css') ? 'text/css' : req.url.includes('.png') ? 'image/png' : 'text/html';
  res.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': type });
  res.end(req.url.includes('.png') ? png : '');
});
evilSrv.on('connection', () => { evil.connections++; });
evilSrv.on('upgrade', (req, socket) => { evil.requests.push(`UPGRADE ${req.url}`); socket.destroy(); });
const evilUdp = dgram.createSocket('udp4');
evilUdp.on('message', () => { evil.udp++; });
const resetEvil = () => { evil.connections = 0; evil.udp = 0; evil.requests.length = 0; };
const evilNow = () => ({ tcp: evil.connections, udp: evil.udp, http: evil.requests.length, sample: evil.requests.slice(0, 6) });
await new Promise((res, rej) => { evilSrv.once('error', rej); evilSrv.listen(EVIL_PORT, '127.0.0.1', res); });
await new Promise((res) => evilUdp.bind(EVIL_PORT, '127.0.0.1', res));

/* ------------------------------------------------------------------ 托管组合、项目、素材 */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'online-card-security-hosted-'));
const combo = await startHostedCombo({
  dataDir, docPort: DOC_PORT, assetPort: ASSET_PORT, host: '127.0.0.1', trustLoopback: false, clusterToken: randomBytes(32).toString('base64url'),
  docPublicUrl: `ws://pc.localhost:${BASE}/hosted/`, assetPublicUrl: `${ORIGINS.editor}/media/api/asset`, log: () => {},
});
const stamp = Date.now().toString(36);
const NAME = `ocs-${stamp}`;
const creator = { username: 'boss', password: `boss-${randomBytes(9).toString('hex')}` };
const PROJECT_PW = `pw-${randomBytes(9).toString('hex')}`;
const made = await createSharedProject({ base: DOC_DIRECT, name: NAME, mode: 'free', creator, password: PROJECT_PW });

const addSecret = (label, value) => { if (typeof value === 'string' && value.length >= 8) secrets.set(value, label); };
addSecret('项目密码', PROJECT_PW);
addSecret('创建者密码', creator.password);

async function wsAsCreator() {
  const protocols = await buildAuthProtocols({ base: DOC_DIRECT, projectId: made.projectId, username: creator.username, deviceId: 'ocs-probe-node-01', deviceName: 'probe-node', as: 'creator', password: creator.password, role: 'page' });
  const ws = new WebSocket(DOC_DIRECT.replace(/^http/, 'ws'), protocols);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  const ask = (msg) => new Promise((resolve) => {
    const reqId = `p${Math.random().toString(36).slice(2)}`;
    const on = (ev) => { const m = JSON.parse(String(ev.data)); if (m.reqId === reqId) { ws.removeEventListener('message', on); resolve(m); } };
    ws.addEventListener('message', on);
    ws.send(JSON.stringify({ ...msg, reqId }));
  });
  return { ask, close: () => ws.close() };
}
let MEDIA_HASH = '';
{
  // 在线页面只加入、不新建:替创建者写进一份空项目(同 `lib-seed.mjs`),再传一张图当素材
  const node = await wsAsCreator();
  const opened = await node.ask({ type: 'project.open', projectId: made.projectId });
  const body = { version: 1, id: `ocs-seed-${made.projectId.slice(-8)}`, name: NAME, width: 1920, height: 1080, fps: 30, duration: 30, themeId: 'midnight', media: [],
    tracks: [{ id: 't-1', name: '序列 1', clips: [] }, { id: 't-2', name: '序列 2', clips: [] }] };
  const seeded = await node.ask({ type: 'project.op', projectId: made.projectId, opId: randomBytes(16).toString('base64url'), ops: [{ op: 'set', path: '', value: body }] });
  check('准备:替创建者写进空项目', !/error|reject/i.test(String(opened?.type) + String(seeded?.type)), { opened: opened?.type, seeded: seeded?.type });
  const tk = await node.ask({ type: 'auth.ticket', kind: 'asset', access: 'rw' });
  addSecret('创建者的读写素材票据', tk?.ticket);
  const assets = createAssetClient({ base: `http://127.0.0.1:${ASSET_PORT}/api/asset`, ticket: () => tk.ticket });
  const put = await assets.put('media', png, { ext: 'png' });
  MEDIA_HASH = put.hash;
  check('准备:创建者凭读写票据把一张图传进素材服务', /^[0-9a-f]{64}$/.test(MEDIA_HASH), { size: put.size });
  const bare = await fetch(`http://127.0.0.1:${ASSET_PORT}/api/asset/media/${MEDIA_HASH}`);
  check('准备:素材服务不信回环,不带票据读素材是 401', bare.status === 401, bare.status);
  node.close();
}

/* ------------------------------------------------------------------ 浏览器 */
const NETLOG = path.join(OUT, 'netlog.json');
try { fs.rmSync(NETLOG, { force: true }); } catch { /* 没有 */ }
const browser = await puppeteer.launch({
  headless: !HEADFUL, protocolTimeout: 900_000,
  args: [...PROBE_CHROME_ARGS, '--no-first-run', '--hide-scrollbars', '--mute-audio', '--window-position=-32000,-32000', '--site-per-process', `--log-net-log=${NETLOG}`, '--net-log-capture-mode=IncludeSensitive',
    ...(process.env.PC_CHROME_ARGS ? process.env.PC_CHROME_ARGS.split(/\s+/).filter(Boolean) : [])],
});
const summary = { chrome: await browser.version(), out: OUT };
const DNS = { guarded: `g${randomBytes(5).toString('hex')}.pcexfil.invalid`, control: `c${randomBytes(5).toString('hex')}.pcexfil.invalid` };

/** 核对代理发的响应头(Node 这边直接连端口,Host 头给舞台的主机名) */
const headOf = (port, host, urlPath) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: urlPath, headers: { host } }, (r) => { r.resume(); resolve({ status: r.statusCode, headers: r.headers }); });
  req.on('error', reject); req.end();
});

/**
 * 开一个成员页:新的浏览器上下文、加入项目、(第一次)摆一张内置卡与一张图片素材。
 * `saveRtc`:在每个文档的页面脚本之前留一份原装的 `RTCPeerConnection`(仿「脚本加固被绕过」)。
 */
let clipsAdded = false;
async function openMember(tag, { saveRtc = false, mobile = false } = {}) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  const popups = [];
  ctx.on('targetcreated', (t) => { if (t.type() === 'page' && t.url() && t.url() !== 'about:blank') popups.push(t.url()); });
  if (mobile) {
    await page.emulate({
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
      viewport: { width: 412, height: 915, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: false },
    });
    await page.evaluateOnNewDocument(() => { Object.defineProperty(Navigator.prototype, 'deviceMemory', { configurable: true, get: () => 4 }); });
  } else {
    await page.setViewport({ width: 1600, height: 900 });
  }
  if (saveRtc) await page.evaluateOnNewDocument(() => {
    try {
      Object.defineProperty(window, '__pcSavedRtc', { value: window.RTCPeerConnection, enumerable: false });
      const create = Document.prototype.createElement;
      Object.defineProperty(window, '__pcMakeFrame', { value: () => create.call(document, 'iframe'), enumerable: false });
    } catch { /* Worker 等没有 */ }
  });
  page.on('dialog', (d) => void d.accept());
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e?.message ?? e).slice(0, 200)));
  // 页面经文档服务拿到的每一张票据都算秘密(读的、读写的、连接用的)
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  cdp.on('Network.webSocketFrameReceived', (ev) => {
    const data = ev?.response?.payloadData;
    if (typeof data !== 'string' || !data.includes('ticket')) return;
    try { const m = JSON.parse(data); if (typeof m.ticket === 'string') addSecret(`页面拿到的票据(${m.type})`, m.ticket); } catch { /* 不是 JSON */ }
  });
  const typeInto = async (sel, value) => {
    await page.waitForSelector(sel, { visible: true, timeout: 30_000 });
    await page.click(sel, { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await page.type(sel, value, { delay: 5 });
  };
  await page.goto(`${ORIGINS.editor}/editor`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForSelector('[data-pc="join-form"]', { visible: true, timeout: 60_000 });
  await typeInto('[data-pc="join-name"]', NAME);
  await typeInto('[data-pc="join-username"]', `m-${tag.toLowerCase()}`);
  await typeInto('[data-pc="join-password"]', PROJECT_PW);
  await page.click('[data-pc="join-submit"]');
  await page.waitForSelector('[data-pc="members-button"]', { visible: true, timeout: 60_000 });
  await until(`${tag} 时间轴`, () => page.evaluate(() => !!window.__pcStore), 30_000);
  if (!clipsAdded) {
    clipsAdded = true;
    await page.evaluate((hash) => {
      const S = window.__pcStore;
      S.actions.addClipOnNewTrack({ index: 0, cardId: 'punch-pill', start: 0, duration: 6 });
      const m = S.actions.addMedia({ kind: 'image', name: 'probe.png', url: '/@media/' + hash, hash, ext: 'png', size: 100, width: 4, height: 4 });
      S.actions.addClipOnNewTrack({ index: 1, mediaId: m.id, start: 0, duration: 6 });
    }, MEDIA_HASH);
  }
  await page.evaluate(() => window.__pcStore.actions.seek(1));
  const stageFrames = () => page.frames().filter((f) => /[?&]stage=1/.test(f.url()) && !f.detached);
  const stageOf = (i) => stageFrames().find((f) => f.url().startsWith(`${ORIGINS.stages[i]}/`)) ?? null;
  const diag = () => page.evaluate(() => { const d = window.__pcPreviewDiag?.(); return d ? { dual: d.dual, onlineStages: d.onlineStages, cardExec: d.cardExec, lowMemory: d.lowMemory } : null; });
  const gateOf = (frame) => frame.evaluate(() => ({ gate: window.__pcCardExecGate?.() ?? null, iso: window.__pcStageIsolation?.() ?? null, url: location.origin + location.pathname })).catch(() => null);
  return { tag, ctx, page, popups, pageErrors, stageFrames, stageOf, diag, gateOf, close: () => ctx.close().catch(() => {}) };
}

/** 在一个帧里执行夹具的某个函数(与加载器执行转译结果同一个办法) */
const runInFrameRaw = (frame, fn, ctx, { worker = false } = {}) => frame.evaluate(async (code, fnName, c, inWorker) => {
  if (!inWorker) {
    const mod = { exports: {} };
    new Function('require', 'module', 'exports', code)(() => { throw new Error('探针里没有模块'); }, mod, mod.exports);
    const arg2 = fnName === 'webrtcAttack' ? window.__pcSavedRtc : undefined;
    return await mod.exports[fnName](c, arg2);
  }
  // 声音那一半:舞台起 blob Worker(继承舞台文档的策略);Worker 里先建 Trusted Types 的缺省策略再执行(同 `spawnWorker.ts`)
  const boot = 'if (self.trustedTypes && !self.trustedTypes.defaultPolicy) self.trustedTypes.createPolicy("default", { createHTML: (s) => s, createScript: (s) => s, createScriptURL: (s) => s });'
    + 'onmessage = async (e) => { const m = { exports: {} }; try { new Function("require", "module", "exports", e.data.code)(() => { throw new Error("no modules"); }, m, m.exports); postMessage({ ok: true, out: await m.exports[e.data.fn](e.data.ctx) }); } catch (err) { postMessage({ ok: false, error: String(err) }); } };';
  const w = new Worker(URL.createObjectURL(new Blob([boot], { type: 'text/javascript' })));
  try {
    return await new Promise((res) => { w.onmessage = (ev) => res(ev.data.ok ? ev.data.out : { 'worker-error': ev.data.error }); w.onerror = (ev) => res({ 'worker-error': String(ev.message) }); w.postMessage({ code, fn: fnName, ctx: c }); setTimeout(() => res({ 'worker-error': '超时' }), 120_000); });
  } finally { w.terminate(); }
}, LIB, fn, ctx, worker).catch((e) => ({ 'run-error': String(e?.message ?? e).slice(0, 300) }));
/** 每次执行有时限:舞台被攻击代码带死(渲染进程卡住)时回 `run-error`,由断言去报,探针自己不挂 */
const RUN_TIMEOUT_MS = Number(process.env.PROBE_RUN_TIMEOUT_MS ?? 180_000);
async function runInFrame(frame, fn, ctx, opts) {
  const t0 = Date.now();
  if (process.env.PROBE_DEBUG) console.error(`[run] ${fn}${opts?.worker ? '(worker)' : ''} ${ctx?.tag ?? ''} …`);
  let r = await Promise.race([runInFrameRaw(frame, fn, ctx, opts), sleep(RUN_TIMEOUT_MS).then(() => null)]);
  if (r === null) r = { 'run-error': `${RUN_TIMEOUT_MS} ms 没返回,停在 ${await Promise.race([frame.evaluate(() => String(globalThis.__pcEvilProgress)).catch(() => '?'), sleep(3000).then(() => '(舞台没应答)')])}` };
  if (process.env.PROBE_DEBUG) console.error(`[run] ${fn} ${ctx?.tag ?? ''} ${Date.now() - t0} ms${r && r['run-error'] ? ` 出错:${r['run-error']}` : ''}`);
  return r;
}

const flat = (o) => Object.entries(o ?? {}).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n');
/** 一段倒出来的文本里有没有探针知道的秘密;回命中的标签(不回值) */
const leaksIn = (textDump) => { const hit = new Set(); for (const [value, label] of secrets) if (textDump.includes(value)) hit.add(label); return [...hit]; };
const TICKET_SHAPE = /v1\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/;

/** 起代理 → 跑一个场景 → 关代理 */
async function withProxy(options, fn) {
  const proxy = await startHostedProxy({ dist: DIST, basePort: BASE, docPort: DOC_PORT, assetPort: ASSET_PORT, ...options });
  try { return await fn(proxy); } finally { await proxy.close(); }
}

/** 等本页的判定落定(不是 pending),回诊断 */
const settled = (m, ms = 40_000) => until(`${m.tag} 本页的执行判定落定`, async () => { const d = await m.diag(); return d && d.cardExec && d.cardExec.reason !== 'pending' && (d.dual ? m.stageFrames().length >= 2 : true) ? d : null; }, ms);

try {
  /* ============================================================ A 隔离生效 */
  if (ONLY.includes('A')) await withProxy({ policy: 'full' }, async (proxy) => {
    console.log('\n== A 隔离生效(新 nginx:策略头 + 出口白名单 + /media-s/)');
    resetEvil();
    const m = await openMember('A');
    const canary = `PCCANARY${randomBytes(12).toString('hex')}`;
    addSecret('探针种在编辑器页存储里的记号', canary);
    // 记号种进编辑器页的每一种存储与一个全局变量
    await m.page.evaluate(async (c) => {
      localStorage.setItem('pc.probe.canary', c);
      sessionStorage.setItem('pc.probe.canary', c);
      document.cookie = `pc_probe_canary=${c}; Path=/`;
      window.__pcProbeCanary = c;
      await new Promise((res) => { const r = indexedDB.open('pc-probe-canary-db', 1); r.onupgradeneeded = () => r.result.createObjectStore('s'); r.onsuccess = () => { const tx = r.result.transaction('s', 'readwrite'); tx.objectStore('s').put(c, 'k'); tx.oncomplete = () => { r.result.close(); res(); }; }; });
      try { const d = await navigator.storage.getDirectory(); const f = await d.getFileHandle('pc-probe-canary.txt', { create: true }); const w = await f.createWritable(); await w.write(c); await w.close(); } catch { /* 没有 OPFS */ }
      try { const ch = await caches.open('pc-probe-canary'); await ch.put('/pc-probe-canary', new Response(c)); } catch { /* 没有 Cache */ }
    }, canary);
    const d0 = await settled(m);
    summary.A = { cardExec: d0?.cardExec, onlineStages: d0?.onlineStages?.handshake };
    const sA = m.stageOf(0), sB = m.stageOf(1);
    const gA = sA ? await m.gateOf(sA) : null, gB = sB ? await m.gateOf(sB) : null;
    check('A1 本页是双舞台、握手成功', d0?.dual === true && d0?.onlineStages?.handshake === 'ok', d0?.onlineStages);
    check('A1 两台舞台自检通过(跨源、策略出自响应头、加固装上、Trusted Types 在强制)', [gA, gB].every((g) => g?.iso?.report?.ok === true && g.iso.report.csp === 'header' && g.iso.report.crossOrigin === true && g.iso.harden?.trustedTypes === 'enforced'), [gA?.iso?.report, gB?.iso?.report]);
    check('A1 出口由浏览器的出口白名单管(Connection-Allowlist 在生效)', [gA, gB].every((g) => g?.iso?.report?.egress === 'allowlist'), [gA?.iso?.report?.egress, gB?.iso?.report?.egress]);
    check('A1 票据交接成功、本页判「可执行」,两台舞台的执行闸门开着', d0?.cardExec?.enabled === true && gA?.gate?.allowed === true && gB?.gate?.allowed === true, { page: d0?.cardExec?.reason, A: gA?.gate, B: gB?.gate });
    check('A1 舞台载的是舞台入口 stage.html', [gA, gB].every((g) => /\/editor\/stage\.html$/.test(g?.url ?? '')), [gA?.url, gB?.url]);
    const sandbox = await m.page.$$eval('iframe[data-pc^="stage-frame"]', (els) => els.map((e) => e.getAttribute('sandbox')));
    check('A1 舞台 iframe 的 sandbox 只有 allow-scripts allow-same-origin', sandbox.length >= 2 && sandbox.every((s) => s === 'allow-scripts allow-same-origin'), sandbox);
    const hs = await headOf(BASE + 1, `s1.pc.localhost:${BASE + 1}`, '/editor/stage.html'), he = await headOf(BASE, `pc.localhost:${BASE}`, '/editor');
    check('A1 舞台响应带内容安全策略(与 stagePolicy.mjs 逐字相同)与出口白名单', hs.headers['content-security-policy'] === stageCspHeader(ORIGINS.editor) && hs.headers['connection-allowlist'] === STAGE_CONNECTION_ALLOWLIST && hs.headers['x-dns-prefetch-control'] === 'off', hs.headers['connection-allowlist']);
    check('A1 编辑器页响应带 frame-src(只许本源与两个舞台源)', he.headers['content-security-policy'] === editorCspHeader(ORIGINS.stages), he.headers['content-security-policy']);
    const sid = d0?.cardExec?.sid ?? '';
    const mediaSrc = sA ? await until('A 舞台里的素材元素', () => sA.evaluate((hash) => { const el = [...document.querySelectorAll('img,video')].find((e) => (e.getAttribute('src') ?? '').includes(hash)); return el ? el.getAttribute('src') : null; }, MEDIA_HASH), 20_000) : null;
    check('A1 舞台读素材的地址是 /media-s/<sid>/media/<哈希>,不带 ?t=', mediaSrc === `/media-s/${sid}/media/${MEDIA_HASH}`, (mediaSrc ?? '').replace(MEDIA_HASH, '<哈希>').replace(/\?t=.*/, '?t=…'));
    await until('A 舞台凭 cookie 取到素材', () => proxy.requests.some((r) => r.path === `/media-s/${sid}/media/${MEDIA_HASH}` && (r.status === 200 || r.status === 206)), 20_000);
    for (const g of proxy.grants) addSecret('交接给舞台源的只读素材票据', g.ticket);
    check('A1 交接请求到了两个舞台源(票据在 Authorization 头里)', ['stageA', 'stageB'].every((r) => proxy.grants.some((g) => g.role === r && g.sid === sid && g.ticket.length > 40)), proxy.grants.map((g) => g.role));
    // 编辑器页存的凭证、设备身份
    const editorSecrets = await m.page.evaluate(() => {
      const out = [];
      const walk = (v, where, key) => {
        if (typeof v === 'string') { if (/^[A-Za-z0-9_-]{43}$/.test(v) || /^(key|password|secret|token|proof|ticket)$/i.test(key ?? '')) out.push({ label: `编辑器页存的凭证(${where})`, value: v }); return; }
        if (v && typeof v === 'object') for (const [k, c] of Object.entries(v)) walk(c, where, k);
      };
      for (const k of Object.keys(localStorage)) { let v = localStorage.getItem(k); try { v = JSON.parse(v); } catch { /* 原样 */ } walk(v, k, k); }
      const dev = localStorage.getItem('pc.online.device');
      if (dev) { try { const j = JSON.parse(dev); for (const [k, c] of Object.entries(j)) if (typeof c === 'string' && c.length >= 12 && /id/i.test(k)) out.push({ label: `设备身份(${k})`, value: c }); } catch { if (dev.length >= 12) out.push({ label: '设备身份', value: dev }); } }
      return out;
    });
    for (const s of editorSecrets) addSecret(s.label, s.value);
    check('A3 准备:探针手里有编辑器页存的凭证、设备身份与票据可比', editorSecrets.some((s) => /凭证/.test(s.label)) && [...secrets.values()].some((l) => /票据/.test(l)), [...new Set(secrets.values())]);

    const mkCtx = (tag, graph, stageOrigin) => ({ tag, graph, collector: EVIL, collectorPort: EVIL_PORT, dnsHost: DNS.guarded, sid, mediaHash: MEDIA_HASH, stageOrigin, frameDocUrl: '/editor/stage.html', magic: `MAGIC${randomBytes(6).toString('hex')}`, listenMs: 1500 });
    const ctxA = mkCtx('user-card', false, ORIGINS.stages[0]), ctxB = mkCtx('graph-card', true, ORIGINS.stages[1]);
    /*
     * 「卡片代码」的执行办法与加载器相同。分三段:
     *   一、闸门开着(A1 已核):读父页、把读得到的一切倒出来、图卡读素材、声音线程;
     *   二、两台舞台都开始听父页的消息,然后舞台 A 试着造一个子框架 —— 加固拦下并上报,父页改判、把取档策略重发给两台(RPC),
     *       听到的消息里不该有票据;
     *   三、伪造消息、外传、加固各条路(这时闸门已经因为第二段关上了;照样硬跑,断言看的是浏览器与加固拦不拦得住)。
     */
    const rA = {}, rB = {};
    if (sA && sB) {
      for (const [frame, ctx, r] of [[sA, ctxA, rA], [sB, ctxB, rB]]) {
        r.parent = await runInFrame(frame, 'parentReads', ctx);
        r.dump = await runInFrame(frame, 'dumpEverything', ctx);
        if (ctx.graph) r.media = await runInFrame(frame, 'mediaWork', ctx);
        r.worker = await runInFrame(frame, 'workerAttacks', ctx, { worker: true });
      }
      const hearA = runInFrame(sA, 'listenParent', { listenMs: 8000 }), hearB = runInFrame(sB, 'listenParent', { listenMs: 8000 });
      await sleep(500);
      rA.firstBreach = await runInFrame(sA, 'hardenAttacks', { ...ctxA, only: ['createElement'] });
      rA.heard = await hearA; rB.heard = await hearB;
      for (const [frame, ctx, r] of [[sA, ctxA, rA], [sB, ctxB, rB]]) {
        r.forged = await runInFrame(frame, 'forgedMessages', ctx);
        r.exfil = await runInFrame(frame, 'exfilAttacks', ctx);
        r.harden = await runInFrame(frame, 'hardenAttacks', ctx);
      }
    }
    await sleep(2000);
    summary.A.userCard = { parent: rA.parent, exfil: rA.exfil, harden: rA.harden, worker: rA.worker };
    summary.A.graphCard = { parent: rB.parent, media: rB.media, exfil: rB.exfil, harden: rB.harden, worker: rB.worker };

    for (const [who, r] of [['恶意用户卡(舞台 A)', rA], ['恶意图卡(舞台 B)', rB]]) {
      /* A2 父页对象 */
      const mustThrow = ['parent.document', 'parent.location.href', 'parent.localStorage', 'parent.sessionStorage', 'parent.indexedDB', 'parent.__pcStore', 'parent.__pcPreviewDiag', 'parent.fetch', 'parent.eval', 'parent.document.cookie', 'top.document', 'top.location.href', 'top.localStorage', 'parent.name'];
      const notThrown = mustThrow.filter((k) => !/^抛错:SecurityError/.test(r.parent?.[k] ?? ''));
      check(`A2 ${who}:读父页与顶层的 ${mustThrow.length} 种属性全部抛 SecurityError`, notThrown.length === 0, notThrown.map((k) => `${k}=${r.parent?.[k]}`));
      const sib = [0, 1, 2, 3].map((i) => r.parent?.[`parent.frames[${i}]`] ?? '').filter((v) => v && v !== '自己' && !/^抛错:(SecurityError|TypeError)/.test(v));
      check(`A2 ${who}:别的框架(另一台舞台)读不到`, sib.length === 0, sib);
      check(`A2 ${who}:opener、frameElement 为空`, r.parent?.opener === 'null' && r.parent?.frameElement === 'null', `${r.parent?.opener} / ${r.parent?.frameElement}`);
      /* A3 凭证、票据、本机存储 */
      const all = `${flat(r.parent)}\n${flat(r.dump)}\n${flat(r.heard)}\n${flat(r.media)}\n${flat(r.worker)}\n${flat(r.exfil)}`;
      const leaked = leaksIn(all);
      check(`A3 ${who}:读得到的一切里没有凭证、票据、设备身份、编辑器页存储里的记号(共比对 ${secrets.size} 个秘密,倒出 ${all.length} 字符)`, leaked.length === 0 && all.length > 5000, leaked);
      const shaped = TICKET_SHAPE.test(all), tq = /[?&]t=v1\./.test(all);
      check(`A3 ${who}:读得到的一切里没有任何票据形状的串,也没有 ?t=`, !shaped && !tq, { shaped, tq });
      for (const k of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie', 'cookieStore', 'opfs', 'caches', 'performance', 'dom', 'globals', 'parent-messages']) {
        const v = r.dump?.[k];
        check(`A3 ${who}:${k} 读出来了、里面没有秘密`, typeof v === 'string' && !/^抛错|^超时/.test(v) && leaksIn(v).length === 0 && !TICKET_SHAPE.test(v), typeof v === 'string' ? `${v.length} 字符` : v);
      }
      check(`A3 ${who}:舞台里可读的 cookie 是空的(票据的 cookie 是 HttpOnly)`, r.dump?.['document.cookie'] === '' && r.dump?.cookieStore === '[]', `${r.dump?.['document.cookie']} / ${r.dump?.cookieStore}`);
      const heard = r.heard?.['parent-messages'] ?? '';
      check(`A3 ${who}:听到了父页重发的取档策略(RPC setMediaPolicy,基址是 /media-s/<sid>),里面的票据是 null、整段消息里没有秘密`, /setMediaPolicy/.test(heard) && heard.includes(`/media-s/${sid}`) && /"ticket":null/.test(heard) && leaksIn(heard).length === 0 && !TICKET_SHAPE.test(heard), { chars: heard.length, methods: [...new Set([...heard.matchAll(/"method":"(\w+)"/g)].map((x) => x[1]))] });
      check(`A3 ${who}:凭 cookie 读素材的应答头里没有票据;舞台自己发交接请求被拒`, /^200 /.test(r.dump?.['media-headers'] ?? '') && /^403 /.test(r.dump?.['grant-from-stage'] ?? ''), `${(r.dump?.['media-headers'] ?? '').slice(0, 4)} / ${(r.dump?.['grant-from-stage'] ?? '').slice(0, 4)}`);
      /* A6 声音线程 */
      const w = r.worker ?? {};
      check(`A6 ${who}:声音线程里没有父页、顶层、文档、localStorage、opener,也没有 RTCPeerConnection`, w['w.globals'] === 'undefined/undefined/undefined/undefined/undefined' && w['w.RTCPeerConnection'] === 'undefined/undefined', `${w['w.globals']} ; ${w['w.RTCPeerConnection']}`);
      const wNet = ['w.fetch', 'w.fetch-no-cors', 'w.xhr', 'w.websocket', 'w.eventsource', 'w.importScripts', 'w.dynamic-import', 'w.nested-worker-url', 'w.webtransport'].filter((k) => /到达|已建/.test(w[k] ?? ''));
      check(`A6 ${who}:声音线程里 fetch / XHR / WebSocket / EventSource / importScripts / 动态载入 / 再起外部 Worker / WebTransport 都没到`, wNet.length === 0 && !w['worker-error'], w['worker-error'] ?? wNet);
      /* A7 加固 */
      const paths = Object.entries(r.harden ?? {}).filter(([k]) => k !== 'own' && k !== '收尾时的子框架数');
      const got = paths.filter(([, v]) => /拿到了|OPENED/.test(v)).map(([k]) => k);
      check(`A7 ${who}:本文档没有 RTCPeerConnection;试过的 ${paths.length} 条从子框架拿回它的路一条都没拿到`, r.harden?.own === 'undefined/undefined' && paths.length >= 40 && got.length === 0, got.length ? got : `收尾时子框架 ${r.harden?.['收尾时的子框架数']} 个`);
      const leftFrames = paths.filter(([, v]) => !/子框架 0 个/.test(v)).map(([k, v]) => `${k}:${v}`);
      check(`A7 ${who}:每条路试完舞台里都没有留下子框架`, leftFrames.length === 0 && r.harden?.['收尾时的子框架数'] === '0', leftFrames);
    }
    for (const k of ['XSLT', 'importNode(从取回来的同源文档)', 'XHR responseType=document']) console.log(`        回归:${k} → 用户卡 ${rA.harden?.[k]} ; 图卡 ${rB.harden?.[k]}`);
    /* A4 图卡干得了活 */
    const md = rB.media ?? {};
    check('A4 图卡:凭 cookie 按 Range 取素材是 206、字节是 PNG 的头', /^206 bytes 0-7\/\d+ 137,80,78,71,13,10,26,10$/.test(md.range ?? ''), md.range);
    check('A4 图卡:素材画进 2D 画布、传进 WebGL2 纹理都读得回像素(没被污染)', md['img-canvas-2d'] === '10,200,30,255' && md['img-webgl2'] === '10,200,30,255', `${md['img-canvas-2d']} / ${md['img-webgl2']}`);
    check('A4 图卡:换一个 sid、不带票据走旧路由都是 401', md['other-sid'] === '状态:401' && md['legacy-route-without-ticket'] === '状态:401', `${md['other-sid']} / ${md['legacy-route-without-ticket']}`);
    check('A4 图卡:只放行 GET / HEAD 与素材字节那一种路径(POST 405,别的命名空间与子路由 404)', md['post-to-media'] === '状态:405' && md['other-namespace'] === '状态:404' && md['chunks-route'] === '状态:404', `${md['post-to-media']} / ${md['other-namespace']} / ${md['chunks-route']}`);
    check('A6 声音线程凭同一张 cookie 取得到素材(应答头里没有票据)', /^状态:200 /.test(rB.worker?.['w.media'] ?? ''), (rB.worker?.['w.media'] ?? '').slice(0, 8));
    /* A5 带不走(非导航) */
    const e1 = evilNow();
    check(`A5 两张卡的 ${Object.keys(rA.exfil ?? {}).length} 种外传办法(窗口)加声音线程里的都跑完:收集站 0 条 TCP 连接、0 个 UDP 包、0 个 HTTP 请求`, Object.keys(rA.exfil ?? {}).length >= 44 && Object.keys(rB.exfil ?? {}).length >= 44 && !rA.exfil['run-error'] && !rB.exfil['run-error'] && e1.tcp === 0 && e1.udp === 0 && e1.http === 0, e1);
    const claimed = [...Object.entries(rA.exfil ?? {}), ...Object.entries(rB.exfil ?? {})].filter(([, v]) => /^到达|开出来了|注册成功|跑起来了/.test(v)).map(([k, v]) => `${k}=${v}`);
    check('A5 攻击代码自己也没有一条报「到达」', claimed.length === 0, claimed);
    check('A5 本文档里 WebRTC 没有构造器', rA.exfil?.webrtc === '没有构造器' && rB.exfil?.webrtc === '没有构造器', `${rA.exfil?.webrtc} / ${rB.exfil?.webrtc}`);
    check('A5 没开出新窗口,顶层地址没变', m.popups.length === 0 && m.page.url().startsWith(`${ORIGINS.editor}/editor`), { popups: m.popups, url: m.page.url() });
    /* A7 试图造子框架之后父页不再执行 */
    const d1 = await until('A 父页收到加固拦下的上报', async () => { const d = await m.diag(); return d?.cardExec?.reason === 'breach' ? d : null; }, 10_000);
    const gA2 = sA ? await m.gateOf(sA) : null;
    check('A7 有代码试图造子框架之后:父页本次会话不再判「可执行」(原因 breach),舞台的执行闸门关上', d1?.cardExec?.enabled === false && gA2?.gate?.allowed === false, { page: d1?.cardExec?.reason, stage: gA2?.gate });
    /* A8 父页对伪造消息 */
    const after = await m.page.evaluate(async (magics) => {
      const parts = [];
      for (const k of Object.keys(localStorage)) parts.push(k + '=' + localStorage.getItem(k));
      for (const info of await indexedDB.databases()) {
        const db = await new Promise((res, rej) => { const r = indexedDB.open(info.name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
        for (const store of Array.from(db.objectStoreNames)) {
          const rows = await new Promise((res) => { const r = db.transaction(store, 'readonly').objectStore(store).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => res([]); });
          try { parts.push(JSON.stringify(rows)); } catch { /* 存的不是普通对象 */ }
        }
        db.close();
      }
      const storage = parts.join('\n');
      return {
        alive: !!window.__pcPreviewDiag?.(), xss: typeof window.__pcXss, html: document.querySelectorAll('[data-pcevil-html]').length,
        polluted: typeof ({}).polluted, hugeNumber: /7\.77e\+?98/.test(storage), forgedIdentity: magics.some((x) => storage.includes('FORGED-' + x)), bytes: storage.length,
        probeRun: JSON.stringify(window.__pcPreviewDiag?.().probeRun ?? null).length,
      };
    }, [ctxA.magic, ctxB.magic]);
    check('A8 父页对伪造的握手、回包、舞台事件:没崩、没有页面错误', after.alive === true && m.pageErrors.length === 0, m.pageErrors.slice(0, 3));
    check('A8 父页没有把舞台交来的 HTML 放进活文档(里面的脚本没执行、原型没被污染)', after.xss === 'undefined' && after.html === 0 && after.polluted === 'undefined', after);
    check('A8 父页的存储里没有伪造事件里那个超范围的数', after.hugeNumber === false, { bytes: after.bytes, forgedIdentity: after.forgedIdentity });
    await m.page.screenshot({ path: path.join(OUT, 'a-editor.png') }).catch(() => {});
    await m.close();

    /* A5 导航类:每种单开一页 */
    summary.A.nav = {};
    for (const nav of ['self', 'assign', 'top', 'parent', 'open', 'open-top', 'meta', 'anchor', 'anchor-blank', 'form-self', 'form-blank', 'a-download', 'form-top']) {
      if (process.env.PROBE_SKIP_NAV) break; // 调探针时省时间用;验收不许带
      resetEvil();
      const n = await openMember(`An${nav.replace(/-/g, '')}`);
      await settled(n);
      const f = n.stageOf(0);
      const said = f ? await runInFrame(f, 'navAttack', { collector: EVIL, tag: 'nav', nav }).catch((e) => `帧没了:${String(e.message).slice(0, 60)}`) : '没有舞台';
      await sleep(2500);
      const e = evilNow();
      const stillEditor = n.page.url().startsWith(`${ORIGINS.editor}/editor`) && await n.page.evaluate(() => !!window.__pcStore).catch(() => false);
      summary.A.nav[nav] = { said, ...e, popups: n.popups };
      check(`A5 导航类(${nav}):收集站 0 个请求、0 条连接,顶层没被带走,没开出新窗口`, e.http === 0 && e.tcp === 0 && stillEditor && n.popups.filter((u) => u.startsWith(EVIL)).length === 0, { said, ...e, popups: n.popups });
      await n.close();
    }
  });

  /* ============================================================ B 浏览器层面拦 WebRTC */
  if (ONLY.includes('B')) await withProxy({ policy: 'full' }, async () => {
    console.log('\n== B 假设脚本加固被绕过(页面脚本之前留了一份原装构造器):隔离生效时 WebRTC 仍然带不走');
    resetEvil();
    const m = await openMember('B', { saveRtc: true });
    await settled(m);
    const f = m.stageOf(0);
    const has = f ? await f.evaluate(() => typeof window.__pcSavedRtc + '/' + typeof window.RTCPeerConnection) : '';
    check('B 准备:舞台里原装构造器留着(function),加固后的全局是 undefined', has === 'function/undefined', has);
    const said = f ? await runInFrame(f, 'webrtcAttack', { collectorPort: EVIL_PORT, tag: 'bypass' }) : '没有舞台';
    await sleep(1500);
    const e = evilNow();
    summary.B = { said, ...e };
    check('B 拿着原装构造器发 STUN / TURN:收集站 0 个 UDP 包、0 条 TCP 连接(出口白名单是浏览器层面的拦)', e.udp === 0 && e.tcp === 0, { said, ...e });
    const ins = f ? await runInFrame(f, 'insertAttacks', { tag: 'bypass' }) : {};
    summary.B.insert = ins;
    const entries = Object.entries(ins).filter(([k]) => k !== '收尾时的子框架数');
    const through = entries.filter(([, v]) => !/^抛错:TypeError;同一拍里子框架 0 个$/.test(v)).map(([k, v]) => `${k}:${v}`);
    check(`B 假设「不给造子框架元素」那一层也被绕过(手里有一个原装造出来的 iframe 元素):${entries.length} 个插入入口全部拦下,舞台里没出现子框架`, entries.length >= 20 && through.length === 0 && ins['收尾时的子框架数'] === '0', through.length ? through : `收尾时子框架 ${ins['收尾时的子框架数']} 个`);
    await m.close();
  });

  /* ============================================================ G 已知缺口 */
  if (ONLY.includes('G')) await withProxy({ policy: 'csp-only' }, async () => {
    console.log('\n== G 已知缺口:只有内容安全策略、没有出口白名单(仿不认 Connection-Allowlist 的浏览器)');
    resetEvil();
    const m = await openMember('G', { saveRtc: true });
    const d = await settled(m);
    const f = m.stageOf(0);
    const g = f ? await m.gateOf(f) : null;
    check('G 这时舞台自检记「出口靠脚本加固」(egress: script),仍判隔离、可执行', g?.iso?.report?.ok === true && g.iso.report.egress === 'script' && d?.cardExec?.enabled === true && d.cardExec.egress === 'script', { report: g?.iso?.report, page: d?.cardExec });
    const guarded = f ? await runInFrame(f, 'exfilAttacks', { collector: EVIL, collectorPort: EVIL_PORT, dnsHost: DNS.guarded, tag: 'gap', only: ['fetch', 'fetch-no-cors', 'xhr', 'img', 'beacon', 'websocket', 'webrtc'] }) : {};
    await sleep(1500);
    const e0 = evilNow();
    check('G 脚本加固在的时候:本文档没有构造器,内容安全策略管得到的几种办法收集站仍是 0', guarded.webrtc === '没有构造器' && e0.tcp === 0 && e0.udp === 0 && e0.http === 0, { webrtc: guarded.webrtc, ...e0 });
    resetEvil();
    const said = f ? await runInFrame(f, 'webrtcAttack', { collectorPort: EVIL_PORT, tag: 'gap' }) : '没有舞台';
    await sleep(2000);
    const e1 = evilNow();
    summary.G = { said, ...e1 };
    gap('WebRTC 残余缺口:只有内容安全策略(含 webrtc \'block\')、没有出口白名单时,假设脚本加固被绕过,STUN / TURN 的包到得了收集站 —— 这种浏览器上 WebRTC 一项靠脚本加固,不是浏览器保证;带得走的是本项目的内容与素材,带不走凭证与票据(A3)', e1.udp > 0 || e1.tcp > 0, { said, udp: e1.udp, tcp: e1.tcp });
    await m.close();
  });

  /* ============================================================ C 对照 */
  if (ONLY.includes('C')) await withProxy({ policy: 'none' }, async () => {
    console.log('\n== C 对照:去掉内容安全策略与出口白名单');
    resetEvil();
    const m = await openMember('C', { saveRtc: true });
    await settled(m);
    const f = m.stageOf(0);
    // 表单会把舞台自己带走,等不到结果:不等返回值,只看收集站
    const running = f ? runInFrame(f, 'exfilAttacks', { collector: EVIL, collectorPort: EVIL_PORT, dnsHost: DNS.control, tag: 'control' }).catch(() => null) : null;
    await Promise.race([running, sleep(45_000)]);
    const f2 = m.stageOf(1);
    if (f2) await runInFrame(f2, 'webrtcAttack', { collectorPort: EVIL_PORT, tag: 'control' }).catch(() => null);
    await sleep(1500);
    const seen = (k) => evil.requests.some((q) => q.includes(`${k}=control`));
    summary.C = { ...evilNow(), kinds: ['fetch', 'nocors', 'xhr', 'beacon', 'img', 'cssbg', 'script', 'link', 'form'].filter(seen) };
    for (const k of ['fetch', 'nocors', 'xhr', 'beacon', 'img', 'cssbg', 'script']) check(`C 对照组:${k} 到得了收集站`, seen(k));
    check('C 对照组:拿着原装构造器,WebRTC 的包到得了收集站', evil.udp > 0, { udp: evil.udp });
    await m.close();
  });

  /* ============================================================ L 旧 nginx */
  const offScenario = async (label, tag, proxyOptions, memberOptions, expect) => withProxy(proxyOptions, async (proxy) => {
    console.log(`\n== ${label}`);
    const m = await openMember(tag, memberOptions);
    const d = await settled(m);
    // 后台舞台挂得晚:等每个舞台文档的自检都出了结论再看(闸门不再是 checking)
    await until(`${tag} 每个舞台文档的自检出结论`, async () => { const gs = await Promise.all(m.stageFrames().map((f) => m.gateOf(f))); return gs.length >= (d?.dual ? 2 : 1) && gs.every((g) => g?.gate && g.gate.reason !== 'checking'); }, 30_000);
    const frames = m.stageFrames();
    const gates = await Promise.all(frames.map((f) => m.gateOf(f)));
    const editorGate = await m.page.evaluate(() => window.__pcCardExecGate?.() ?? null);
    summary[tag] = { cardExec: d?.cardExec, dual: d?.dual, stages: gates.map((g) => ({ url: g?.url, gate: g?.gate, report: g?.iso?.report ?? null })) };
    check(`${tag} 本页不执行用户卡与图卡,原因是 ${expect.reason}`, d?.cardExec?.enabled === false && d.cardExec.reason === expect.reason, d?.cardExec);
    check(`${tag} 编辑器页与每个舞台文档的执行闸门都是关的(共 ${gates.length} 个舞台文档)`, editorGate?.allowed === false && gates.length >= 1 && gates.every((g) => g?.gate?.allowed === false), { editor: editorGate, stages: gates.map((g) => g?.gate) });
    if (expect.dual !== undefined) check(`${tag} ${expect.dual ? '仍是双舞台' : '是同源单舞台'}`, d?.dual === expect.dual && (expect.dual || frames.every((f) => f.url().startsWith(`${ORIGINS.editor}/`))), { dual: d?.dual, frames: frames.map((f) => f.url().replace(/\?.*$/, '')) });
    if (expect.report) check(`${tag} 舞台自检的结论:${expect.report}`, gates.every((g) => g?.iso?.report?.ok === false && g.iso.report.reasons.includes(expect.report)), gates.map((g) => g?.iso?.report?.reasons));
    const drawn = await until(`${tag} 内置卡照常画出来`, async () => { for (const f of m.stageFrames()) { if (await f.evaluate(() => [...document.querySelectorAll('[data-pc-clip]:not([data-pc-media])')].some((w) => w.childElementCount > 0)).catch(() => false)) return true; } return false; }, 30_000);
    check(`${tag} 内置卡照常画出来`, !!drawn);
    if (expect.legacyMedia) {
      const src = await until(`${tag} 舞台里的素材元素`, async () => { for (const f of m.stageFrames()) { const s = await f.evaluate((hash) => { const el = [...document.querySelectorAll('img,video')].find((e) => (e.getAttribute('src') ?? '').includes(hash)); return el ? el.getAttribute('src') : null; }, MEDIA_HASH).catch(() => null); if (s) return s; } return null; }, 20_000);
      check(`${tag} 素材照旧走 /media 加 ?t=(这样的舞台文档不执行用户代码),没有交接请求`, /\/media\/api\/asset\/media\/[0-9a-f]{64}\?t=/.test(src ?? '') && proxy.grants.length === 0, { src: (src ?? '').replace(/\?t=.*/, '?t=…'), grants: proxy.grants.length });
    }
    check(`${tag} 没有页面错误`, m.pageErrors.length === 0, m.pageErrors.slice(0, 3));
    await m.page.screenshot({ path: path.join(OUT, `${tag.toLowerCase()}-editor.png`) }).catch(() => {});
    await m.close();
  });
  if (ONLY.includes('L')) await offScenario('L 旧 nginx:没有策略头、没有 /media-s/(新页面先上、nginx 没改)', 'L', { policy: 'legacy' }, {}, { reason: 'not-isolated', dual: true, report: 'meta-only', legacyMedia: true });
  if (ONLY.includes('S')) await offScenario('S 托管方关掉总开关(运行配置 onlineCardExec: false)', 'S', { policy: 'full', onlineCardExec: false }, {}, { reason: 'switch-off', dual: true, legacyMedia: true });
  if (ONLY.includes('N')) await offScenario('N 没有舞台源(读不到运行配置;放本机、没有 nginx 子域的部署)', 'N', { policy: 'legacy', runtimeConfig: false }, {}, { reason: 'single-stage', dual: false });
  if (ONLY.includes('M')) await offScenario('M 低内存档(仿手机)', 'M', { policy: 'full' }, { mobile: true }, { reason: 'single-stage', dual: false });
} catch (e) {
  check('探针没有中途出错', false, String(e?.stack ?? e).slice(0, 500));
} finally {
  await browser.close().catch(() => {});
  /* A9 / C DNS:网络日志里有没有对那两个域名的解析 */
  try {
    const text = fs.readFileSync(NETLOG, 'utf8');
    const resolved = (host) => text.split('\n').filter((l) => l.includes(host) && /"host"|HOST_RESOLVER|dns/i.test(l)).length;
    const anywhere = (host) => text.split(host).length - 1;
    if (ONLY.includes('A')) check('A9 网络日志里没有对受控组那个域名的解析(也没有任何提到它的网络事件)', anywhere(DNS.guarded) === 0, { mentions: anywhere(DNS.guarded) });
    if (ONLY.includes('C')) check('C 对照组:网络日志里有对对照组那个域名的解析 —— 证明探针看得见 DNS', resolved(DNS.control) > 0, { mentions: anywhere(DNS.control), resolverLines: resolved(DNS.control) });
    summary.netlogBytes = text.length;
  } catch (e) {
    check('读到 Chrome 的网络日志', false, String(e?.message ?? e));
  }
  evilSrv.closeAllConnections?.(); evilSrv.close(); evilUdp.close();
  await combo.close?.().catch?.(() => {});
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 临时目录 */ }
  try { fs.rmSync(NETLOG, { force: true }); } catch { /* 留着也行 */ }
}
const ok = fails.length === 0;
console.log(JSON.stringify({ ok, pass, fail: fails.length, gaps, fails, notes, secretsCompared: secrets.size, ...summary }));
process.exit(ok ? 0 : 1);
