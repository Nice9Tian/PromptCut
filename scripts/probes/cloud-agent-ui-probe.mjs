/**
 * 云端 Agent 界面的真实浏览器探针(任务书 `docs/plan/cloud-agent-task.md` 完成条件第 5、6 条里属于界面的部分;
 * 契约 `docs/plan/cloud-agent-contract.md` 第 7.4、9.5、10 节)。全程在本机,绝不连任何远端:
 *
 *   - 托管组合(文档服务 + 素材服务,`server/hosted/combo.mjs`),
 *   - 云端 Agent 服务(托管档,`server/agent-service/main.mjs` 的 `startAgentService`,模型是模拟提供方的脚本模式,**鉴权与凭证是测试替身**:
 *     身份取自 `Authorization: Bearer test:<项目>:<成员>`,连文档服务用探针手里的创建者凭证;合流后换成真的委托票据),
 *   - 在线构建 + 仿 nginx 的本机代理(编辑器页、两个舞台的源、`/hosted/`、`/media/`、`/agent/`),
 *   - 本 worktree 的桌面 dev server(照桌面壳的环境起,数据都在临时目录)。
 *
 *   node scripts/probes/cloud-agent-ui-probe.mjs [--base-port 5790] [--doc-port 8776] [--asset-port 8777] [--agent-port 8778]
 *        [--phases online,desktop] [--dist <在线构建目录>] [--out <截图目录>]
 *
 * 端口:--base-port 起 +0 编辑器页的源(在线构建与各代理)、+1 / +2 两个舞台的源、+3 桌面版编辑器(+4、+5 是它的舞台端口);
 * 文档服务、素材服务、Agent 服务各一个。数据目录都在系统临时目录。输出:每项断言一行 `{ check, ok, detail }`,最后一行 `{ summary }`,有失败退出码 1。
 * 截图存 --out(缺省 `work/four-stage/cloud-agent/ui/`)。
 *
 * 验收标准:
 *
 * 在线浏览器宽屏(`online`)
 *   O0  右侧是云端 AI 栏、不是占位;接入方式下拉里只有「云端」且选中;没有任何同源 `/api/*` 请求(`__pcApiBlocked` 为空);
 *   O1  发一条消息(模型脚本:读项目、改文案、挪片段、调卡片参数各一次):收尾之前就能看到停止按钮、进度与工具调用(流式),
 *       最后有回复;文档服务里的项目真的被改了三处(文案、片段起止、卡片参数);
 *   O2  停止:点「停止」后 5 秒内停下、回复没有脚本里停之后才会说的话、服务端那一轮确实不在跑了;
 *   O3  事件流被掐断(代理掐掉所有 /agent/ 的事件流连接)后自动重连、带上已看到的最大 seq 补齐:最终的工具调用数与脚本一致(不重不漏),
 *       连接状态经过「重连中」回到「已连接」;
 *   O4  关掉页面、另开一个浏览器上下文(另一台设备,没有本地存储)再进同一个项目:自动接上还在跑的对话,看得到关页面之前的工具调用,
 *       等它结束后过程完整(工具调用数、用户消息数都对);历史列表的「云端」一组里有这些对话,在跑过的带状态;
 *   O5  出错不悄悄丢:模型调用失败时对话里有原因;服务端撤销(被移出、开关关了)时对话里写明「已失效」、停在完好的版本上,之后还能再发消息;
 *   O6  手机仿真(低内存档):仍是占位,没有云端 AI 栏、没有发往 /agent/ 的请求;
 *
 * 桌面版(`desktop`,桌面 dev server 在 `?aimock=1` 下起,本机驱动是内置假流,保证有一个本机驱动可选)
 *   D1  放本机的项目:接入方式里没有「云端」,没有任何发往 Agent 服务的请求;
 *   D2  项目放云端(桌面页面里勾「多用户协作」→ 放云端)且文档服务报了有云端 Agent 后:接入方式里多了「云端」,本机驱动仍是缺省、没有自动切;
 *       不选「云端」时发往 Agent 服务的请求只有一次 info 加一次对话列表(CA-DESK-02);开关被关时「云端」一项在、置灰、写原因;
 *   D3  选「云端」:页面直连 Agent 服务(跨源),没有发往本机 /api/ai/chat、/api/mcp/ 的请求;附件按钮置灰并写原因;「深度自主」置灰并写原因;
 *   D4  选「云端」发一条长一点的任务(三处改动 + 等待),确认已被云端接下后关掉桌面页面:对话在云端照跑完,项目被改了三处;
 *   D5  桌面页面重新打开回到同一个项目:AI 栏仍是本机驱动,只多一次 info 与一次对话列表;历史列表「云端」一组里找得到那个对话,点开找回完整过程;
 *   D6  云端对话还在跑时重新打开:AI 栏仍是本机驱动,出现「云端对话进行中」提示,点「接上看看」接上还在跑的对话,跑完过程完整、改动落地。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const BASE = Number(arg('--base-port', 5790));
const PHASES = new Set(arg('--phases', 'online,desktop').split(','));
const PORTS = { site: BASE, stageA: BASE + 1, stageB: BASE + 2, desktop: BASE + 3, doc: Number(arg('--doc-port', 8776)), asset: Number(arg('--asset-port', 8777)), agent: Number(arg('--agent-port', 8778)) };
for (const p of [5190, 5191, 5192, 5210, 5211, 5212]) if (Object.values(PORTS).includes(p) || PORTS.desktop + 1 === p || PORTS.desktop + 2 === p) { process.stderr.write(`端口段碰到了 ${p}(用户的编辑器或安装版)\n`); process.exit(2); }
const RUN = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-cloud-ui-'));
const OUT = path.resolve(arg('--out', path.join(ROOT, '..', '..', 'work', 'four-stage', 'cloud-agent', 'ui')));
fs.mkdirSync(OUT, { recursive: true });
const SITE = `http://127.0.0.1:${PORTS.site}`;
const DOC_DIRECT = `http://127.0.0.1:${PORTS.doc}`;
const HOSTED_FOR_DESKTOP = `${SITE}/hosted/`;
const AGENT_DIRECT = `http://127.0.0.1:${PORTS.agent}/v1`;
const STAGE_ORIGINS = [`http://127.0.0.1:${PORTS.stageA}`, `http://127.0.0.1:${PORTS.stageB}`];

const results = [];
const check = (name, ok, detail = {}) => { results.push({ check: name, ok: !!ok }); console.log(JSON.stringify({ check: name, ok: !!ok, detail }).slice(0, 1600)); return !!ok; };
const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), step, ...fields })}\n`);
const sleep = (ms) => delay(ms);
async function until(what, fn, ms = 30_000, every = 200) {
  const t0 = Date.now();
  let last = null;
  for (;;) {
    let v = null;
    try { v = await fn(); } catch (e) { last = String(e?.message ?? e).slice(0, 200); }
    if (v) return v;
    if (Date.now() - t0 > ms) { check(`等到:${what}`, false, { last }); return null; }
    await sleep(every);
  }
}

function viteBin() {
  const local = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fs.existsSync(local)) return local;
  const main = createRequire(import.meta.url).resolve('vite');
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), 'bin', 'vite.js');
}
function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else { try { process.kill(pid, 'SIGKILL'); } catch { /* 已退 */ } }
}
const portFree = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
});
function pidOnPort(port) {
  if (process.platform !== 'win32') return null;
  const r = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true });
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line);
    if (m && Number(m[1]) === port) return Number(m[2]);
  }
  return null;
}
const getJson = async (url, timeoutMs = 10_000) => (await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })).json();

/* ================================================================== 托管组合 + Agent 服务 + 仿 nginx 的代理 */

let combo = null;
let agent = null;
let DIST = null;
const proxies = [];
const upgraded = new Set();
/** 经代理转发的 /agent/ 请求日志(每条 { method, path, at }) 与正在进行的事件流(用来掐断) */
const agentLog = [];
const agentStreams = new Set();
const creds = new Map(); // projectId → { username, password }
const sockets = [];

/** 掐掉所有 /agent/ 的事件流连接(应用层模拟断线:只动本机代理的 socket,不动宿主机网络) */
function dropAgentStreams() {
  const n = agentStreams.size;
  for (const s of [...agentStreams]) { try { s.up.destroy(); } catch { /* 已断 */ } try { s.res.destroy(); } catch { /* 已断 */ } }
  agentStreams.clear();
  return n;
}

async function startSite() {
  for (const p of [PORTS.site, PORTS.stageA, PORTS.stageB, PORTS.doc, PORTS.asset, PORTS.agent]) if (!(await portFree(p))) throw new Error(`端口 ${p} 被占用`);
  DIST = arg('--dist', null);
  if (!DIST) {
    DIST = path.join(TMP, 'dist-online');
    say('build-online', { dist: DIST });
    const b = spawnSync(process.execPath, [viteBin(), 'build', '--mode', 'online', '--outDir', DIST, '--emptyOutDir', '--logLevel', 'error'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    if (b.status !== 0) throw new Error(`在线构建失败:${String(b.stderr).slice(-600)}`);
  }
  DIST = path.resolve(DIST);
  const { startHostedCombo } = await import('../../server/hosted/combo.mjs');
  fs.mkdirSync(path.join(TMP, 'hosted'), { recursive: true });
  combo = await startHostedCombo({
    dataDir: path.join(TMP, 'hosted'), docPort: PORTS.doc, assetPort: PORTS.asset, host: '127.0.0.1',
    docPublicUrl: `ws://127.0.0.1:${PORTS.site}/hosted/`, assetPublicUrl: `${SITE}/media/api/asset`, log: () => {},
  });

  // 云端 Agent 服务(托管档),鉴权与凭证是测试替身
  const { startAgentService } = await import('../../server/agent-service/main.mjs');
  const { buildAuthProtocols } = await import('../../server/auth/client.mjs');
  fs.mkdirSync(path.join(TMP, 'agent-data'), { recursive: true });
  agent = await startAgentService({
    dataDir: path.join(TMP, 'agent-data'),
    docUrl: `ws://127.0.0.1:${PORTS.doc}`,
    port: PORTS.agent,
    authenticate: (req) => {
      const m = /^Bearer test:([^:]+):(.+)$/.exec(String(req.headers.authorization ?? ''));
      return m ? { projectId: m[1], userId: m[2], username: m[2].split('@')[0], deviceName: `设备 ${m[2].split('@')[1] ?? ''}`.trim() } : null;
    },
    credentials: {
      protocolsFor: async (identity, n) => {
        const c = creds.get(identity.projectId);
        if (!c) throw new Error('探针里没有这个项目的创建者凭证');
        return buildAuthProtocols({ base: DOC_DIRECT, projectId: identity.projectId, username: c.username, deviceId: `agent-svc-${identity.projectId.slice(0, 20)}`.padEnd(16, '0').slice(0, 64), deviceName: 'cloud-agent 测试替身', as: 'creator', password: c.password, role: 'agent', conversation: n });
      },
    },
    modelConfig: () => ({ vendor: 'mock', model: 'mock-1' }),
    log: () => {},
  });

  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.wasm': 'application/wasm' };
  const OAC = { 'origin-agent-cluster': '?1' };
  const runtimeConfig = JSON.stringify({ v: 1, stageOrigins: STAGE_ORIGINS });
  const makeProxy = (port) => {
    const origin = `http://127.0.0.1:${port}`;
    const forward = (req, res, upstream, strip, { stream = false } = {}) => {
      const target = req.url.slice(strip.length) || '/';
      const up = http.request({ host: '127.0.0.1', port: upstream, method: req.method, path: target.startsWith('/') ? target : `/${target}`, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode ?? 502, { ...r.headers, ...OAC });
        r.pipe(res);
      });
      up.on('error', () => { try { res.writeHead(502, OAC); } catch { /* 已发 */ } res.end('bad gateway'); });
      if (stream) {
        const h = { up, res };
        agentStreams.add(h);
        res.on('close', () => agentStreams.delete(h));
      }
      req.pipe(up);
    };
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, origin);
      if (url.pathname === '/hosted' || url.pathname.startsWith('/hosted/')) return forward(req, res, PORTS.doc, '/hosted');
      if (url.pathname.startsWith('/media/')) return forward(req, res, PORTS.asset, '/media');
      if (url.pathname.startsWith('/agent/') && port === PORTS.site) {
        agentLog.push({ method: req.method, path: url.pathname + url.search, at: Date.now() });
        return forward(req, res, PORTS.agent, '/agent', { stream: /\/events$/.test(url.pathname) });
      }
      const sec = { 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', ...OAC };
      const sendFile = (file, cache) => {
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': cache, ...sec });
        fs.createReadStream(file).pipe(res);
      };
      if (url.pathname === '/editor/runtime-config.json') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...sec }); return res.end(runtimeConfig); }
      const index = path.join(DIST, 'index.html');
      if (url.pathname === '/editor' || url.pathname === '/editor/' || url.pathname === '/editor/index.html') return sendFile(index, 'no-store');
      if (url.pathname.startsWith('/editor/')) {
        const f = path.join(DIST, decodeURIComponent(url.pathname.slice('/editor/'.length)));
        if (f.startsWith(DIST) && fs.existsSync(f) && fs.statSync(f).isFile()) return sendFile(f, 'public, max-age=31536000, immutable');
        return sendFile(index, 'no-store');
      }
      res.writeHead(404, { 'Content-Type': 'text/plain', ...OAC });
      res.end('not found');
    });
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, origin);
      if (!(url.pathname === '/hosted' || url.pathname.startsWith('/hosted/'))) return socket.destroy();
      const target = (url.pathname.slice('/hosted'.length) || '/') + url.search;
      upgraded.add(socket);
      socket.on('close', () => upgraded.delete(socket));
      const up = net.connect(PORTS.doc, '127.0.0.1', () => {
        const lines = [`${req.method} ${target} HTTP/1.1`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
        up.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (head?.length) up.write(head);
        up.pipe(socket);
        socket.pipe(up);
      });
      upgraded.add(up);
      up.on('close', () => { upgraded.delete(up); socket.destroy(); });
      socket.on('close', () => up.destroy());
      up.on('error', () => socket.destroy());
      socket.on('error', () => up.destroy());
    });
    proxies.push(server);
    return new Promise((r) => server.listen(port, '127.0.0.1', r));
  };
  await Promise.all([makeProxy(PORTS.site), makeProxy(PORTS.stageA), makeProxy(PORTS.stageB)]);
  say('site.up', { site: SITE, doc: PORTS.doc, asset: PORTS.asset, agent: PORTS.agent, dist: DIST });
}

/* ================================================================== 文档服务的直连小件:种项目、读项目 */

let M = null;
async function openDocConn(projectId) {
  const c = creds.get(projectId);
  const protocols = await M.buildAuthProtocols({ base: DOC_DIRECT, projectId, username: c.username, deviceId: `cloud-ui-probe-${RUN}`.padEnd(16, '0').slice(0, 64), deviceName: 'cloud-ui 探针', as: 'creator', password: c.password, role: 'page' });
  const ws = new WebSocket(DOC_DIRECT.replace(/^http/, 'ws'), protocols);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  sockets.push(ws);
  const ask = (msg, timeoutMs = 20_000) => new Promise((resolve, reject) => {
    const reqId = `ui-${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => reject(new Error(`等 ${msg.type} 超时`)), timeoutMs);
    const on = (ev) => { const m = JSON.parse(String(ev.data)); if (m.reqId === reqId) { clearTimeout(timer); ws.removeEventListener('message', on); resolve(m); } };
    ws.addEventListener('message', on);
    ws.send(JSON.stringify({ ...msg, reqId }));
  });
  return { ws, ask, close: () => { try { ws.close(); } catch { /* 已关 */ } } };
}
async function readProject(projectId) {
  const c = await openDocConn(projectId);
  try {
    const parts = [];
    let st = null;
    const collect = (ev) => { const m = JSON.parse(String(ev.data)); if (m.type === 'project.state.part') parts.push(m); };
    c.ws.addEventListener('message', collect);
    st = await c.ask({ type: 'project.open', projectId });
    if (st.project === undefined && Number.isSafeInteger(st.parts)) {
      await until('项目分段收齐', () => parts.filter((p) => p.rev === st.rev).length >= st.parts, 10_000, 50);
      st.project = JSON.parse(parts.filter((p) => p.rev === st.rev).sort((x, y) => x.index - y.index).map((p) => p.data).join(''));
    }
    return st.project;
  } finally { c.close(); }
}
async function seedProject(projectId, body) {
  const c = await openDocConn(projectId);
  try {
    await c.ask({ type: 'project.open', projectId });
    const r = await c.ask({ type: 'project.op', projectId, opId: randomBytes(16).toString('base64url'), ops: [{ op: 'set', path: '', value: body }] });
    return r;
  } finally { c.close(); }
}
const seedBody = (name) => ({
  version: 1, id: `cloud-ui-${RUN}`, name, width: 640, height: 360, fps: 30, duration: 12, themeId: 'midnight', media: [],
  tracks: [{
    id: 't-1', name: '序列 1',
    clips: [
      { id: 'c-text', cardId: 'blur-text', start: 0, end: 4, params: { text: '原来的|标题' }, label: '标题卡' },
      { id: 'c-move', cardId: 'blur-text', start: 4, end: 7, params: { text: '要挪的|片段' }, label: '挪动的卡' },
      { id: 'c-ring', cardId: 'ring-metric', start: 7, end: 11, params: { value: 40, label: '完播率' }, label: '指标卡' },
    ],
  }, { id: 't-2', name: '序列 2', clips: [] }],
  transitions: [],
});
const stepsOf = (steps) => `按脚本做。\n\`\`\`mock-script\n${JSON.stringify(steps)}\n\`\`\``;
/** 三处改动的脚本(改文案、挪片段、调卡片参数各一次),每步之间等一小会儿,收尾之前能看到过程 */
const threeEdits = (gap = 700, say = '三处都改好了') => [
  { tool: 'get_project', input: {} }, { sleepMs: gap },
  { tool: 'update_clip', input: { clipId: 'c-text', params: { text: '云端改的|标题' } } }, { sleepMs: gap },
  { tool: 'update_clip', input: { clipId: 'c-move', start: 8, end: 11 } }, { sleepMs: gap },
  { tool: 'update_clip', input: { clipId: 'c-ring', params: { value: 88 } } }, { sleepMs: gap },
  { say },
];

/* ================================================================== 页面小件 */

let browser = null;
async function launchBrowser() {
  const { default: puppeteer } = await import('puppeteer');
  const { PROBE_CHROME_ARGS } = await import('./probe-chrome.mjs');
  return puppeteer.launch({
    headless: true, protocolTimeout: 900_000, defaultViewport: { width: 1600, height: 900 },
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--mute-audio', '--disable-gpu'],
  });
}
const P = (page, fn, ...a) => page.evaluate(fn, ...a);
const shot = async (page, name) => { const f = path.join(OUT, `${name}.png`); await page.screenshot({ path: f }).catch(() => {}); return f; };
async function typeInto(page, sel, text) {
  await page.waitForSelector(sel, { visible: true, timeout: 20_000 });
  await page.click(sel);
  await page.$eval(sel, (el) => el.select());
  await page.keyboard.press('Backspace');
  if (text) await page.type(sel, text, { delay: 5 });
}
/** 探针替身:页面向文档服务要不到委托票据时,用这个口子给测试替身的票据(合流后换成真的) */
const identityScript = (projectId, userId) => `window.__pcCloudIdentity = { getTicket: async () => ${JSON.stringify(`test:${projectId}:${userId}`)}, getGrant: async () => undefined };`;
async function newPage(ctx, { mobile = false, init = [] } = {}) {
  const page = await ctx.newPage();
  page.on('dialog', (d) => void d.accept());
  page.pageErrors = [];
  page.requests = [];
  page.on('pageerror', (e) => page.pageErrors.push(String(e?.message ?? e).slice(0, 200)));
  page.on('request', (r) => page.requests.push({ method: r.method(), url: r.url() }));
  page.failures = [];
  page.on('requestfailed', (r) => page.failures.push(`${r.method()} ${r.url().slice(0, 120)} ${r.failure()?.errorText}`));
  page.on('response', (r) => { if (r.status() >= 400) page.failures.push(`${r.status()} ${r.request().method()} ${r.url().slice(0, 120)}`); });
  page.consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.text().includes('[collab]')) page.consoleErrors.push(m.text().slice(0, 300)); });
  if (mobile) {
    await page.emulate({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36', viewport: { width: 412, height: 915, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: false } });
    await page.evaluateOnNewDocument(() => { Object.defineProperty(Navigator.prototype, 'deviceMemory', { configurable: true, get: () => 4 }); });
  } else await page.setViewport({ width: 1600, height: 900 });
  for (const code of init) await page.evaluateOnNewDocument(code);
  return page;
}

/** 云端 AI 栏里的消息(经 `window.__pcCloud` 的只读钩子) */
const msgs = (page, tab = 'main') => P(page, (t) => window.__pcCloud?.[t]?.messages() ?? null, tab).catch(() => null);
const view = (page, tab = 'main') => P(page, (t) => window.__pcCloud?.[t]?.view() ?? null, tab).catch(() => null);
const toolCount = (messages) => (messages ?? []).filter((m) => m.role === 'assistant').flatMap((m) => m.parts ?? []).filter((p) => p.kind === 'tool').length;
const lastAssistant = (messages) => [...(messages ?? [])].reverse().find((m) => m.role === 'assistant') ?? null;
async function sendText(page, text, panelSel = '[data-pc="cloud-ai-panel"]') {
  await P(page, (t, sel) => {
    const ta = document.querySelector(`${sel} [data-pc="ai-input"]`);
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, t);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }, text, panelSel);
  await page.click(`${panelSel} [data-pc="ai-send"]`);
}
const panelText = (page) => P(page, () => document.querySelector('[data-pc="cloud-ai-panel"]')?.innerText ?? '').catch(() => '');
const providerOptions = (page) => P(page, () => {
  const s = document.querySelector('[data-pc="ai-provider"]');
  return s ? { value: s.value, options: [...s.options].map((o) => ({ value: o.value, text: o.textContent.trim(), disabled: o.disabled, title: o.title })) } : null;
}).catch(() => null);
const idle = (page) => view(page).then((v) => v && !v.streaming);
/** 发一条脚本消息并等到这一轮确实开始(服务端的 user 事件回来、界面进入「在跑」) */
async function startRun(page, steps) {
  await sendText(page, stepsOf(steps));
  return until('这一轮开始(界面进入在跑)', async () => (await view(page))?.streaming, 10_000, 30);
}

/* ================================================================== 在线浏览器 */

async function onlinePhase() {
  const NAME = `cloud-ui-${RUN}`;
  const creator = { username: 'boss', password: `boss-${randomBytes(6).toString('hex')}` };
  const PW = `pw-${randomBytes(6).toString('hex')}`;
  const shared = await M.createSharedProject({ base: DOC_DIRECT, name: NAME, mode: 'free', creator, password: PW });
  creds.set(shared.projectId, creator);
  const seeded = await seedProject(shared.projectId, seedBody(NAME));
  check('在线:共享项目建好并写进内容(托管组合在本机)', !!shared.projectId && String(seeded?.type ?? '').startsWith('project.op'), { type: seeded?.type });
  const PID = shared.projectId;
  const USER = 'alice@probe-online';

  async function join(page, username) {
    await page.goto(`${SITE}/editor`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.waitForSelector('[data-pc="join-form"]', { visible: true, timeout: 60_000 });
    await typeInto(page, '[data-pc="join-name"]', NAME);
    await typeInto(page, '[data-pc="join-username"]', username);
    await typeInto(page, '[data-pc="join-password"]', PW);
    await page.click('[data-pc="join-submit"]');
    await page.waitForSelector('[data-pc="members-button"]', { visible: true, timeout: 60_000 });
    await until(`${username} 进入项目`, () => P(page, () => !!window.__pcStore && window.__pcStore.getState().project.tracks.length > 0), 60_000);
  }

  const ctxA = await browser.createBrowserContext();
  const A = await newPage(ctxA, { init: [identityScript(PID, USER)] });
  await join(A, 'alice');
  await A.waitForSelector('[data-pc="cloud-ai-panel"]', { timeout: 30_000 }).catch(() => {});

  /* ---- O0 */
  const opts0 = await providerOptions(A);
  const placeholder0 = await P(A, () => !!document.querySelector('[data-pc="online-agent-off"]'));
  const panel0 = await P(A, () => !!document.querySelector('[data-pc="cloud-ai-panel"]'));
  await until('云端对话接上(info 回来、事件流连上)', async () => { const v = await view(A); return v && (v.connection === 'live' || v.connection === 'idle') && v.conversationId; }, 30_000);
  check('O0:右侧是云端 AI 栏、不是占位', panel0 && !placeholder0, { panel0, placeholder0 });
  check('O0:接入方式下拉里只有「云端」且选中', opts0 && opts0.value === 'cloud' && opts0.options.length === 1 && opts0.options[0].text === '云端', opts0);
  const infoReq = agentLog.filter((r) => r.path.startsWith('/agent/v1/info'));
  check('O0:进入项目时问了 info(同源 /agent/v1/info)', infoReq.length >= 1, { infoReq: infoReq.length });
  await shot(A, 'O0-online-ai-panel');

  /* ---- O1:三处改动,流式 */
  await sendText(A, stepsOf(threeEdits()));
  const sawStop = await until('O1:收尾之前出现「停止」按钮', () => A.$('[data-pc="cloud-ai-panel"] [data-pc="ai-stop"]'), 10_000, 50);
  const mid = await until('O1:收尾之前就看到工具调用与回复气泡', async () => { const m = await msgs(A); const v = await view(A); return v?.streaming && toolCount(m) >= 1 ? { tools: toolCount(m), total: (m ?? []).length } : null; }, 10_000, 50);
  check('O1:流式:收尾之前有「停止」按钮、已能看到工具调用', !!sawStop && !!mid, mid ?? {});
  await shot(A, 'O1-online-streaming');
  await until('O1:这一轮结束', () => idle(A), 60_000, 100);
  const m1 = await msgs(A);
  const a1 = lastAssistant(m1);
  check('O1:回复里有最后那句话,工具调用四次(读项目 + 三处改动),都成功', a1?.text?.includes('三处都改好了') && toolCount(m1) === 4 && (a1.parts ?? []).filter((p) => p.kind === 'tool').every((t) => t.ok === true), { text: a1?.text, tools: (a1?.parts ?? []).filter((p) => p.kind === 'tool').map((t) => [t.name, t.ok]) });
  const p1 = await readProject(PID);
  const clip = (p, id) => p.tracks.flatMap((t) => t.clips).find((c) => c.id === id);
  check('O1:文档服务里的项目被改了三处(文案、挪片段、卡片参数)', clip(p1, 'c-text').params.text === '云端改的|标题' && clip(p1, 'c-move').start === 8 && clip(p1, 'c-move').end === 11 && clip(p1, 'c-ring').params.value === 88, { text: clip(p1, 'c-text').params.text, move: [clip(p1, 'c-move').start, clip(p1, 'c-move').end], value: clip(p1, 'c-ring').params.value });
  const pageSees = await P(A, () => window.__pcStore.getState().project.tracks.flatMap((t) => t.clips).map((c) => [c.id, c.start, c.end, c.params?.text ?? c.params?.value]));
  check('O1:这个页面的编辑区也看到了改动', JSON.stringify(pageSees).includes('云端改的|标题') && JSON.stringify(pageSees).includes('88'), pageSees);
  const bodyText = await panelText(A);
  check('O1:AI 栏里能读到回复文字与「在云端运行」说明', bodyText.includes('三处都改好了') && bodyText.includes('在云端运行,关闭后继续'), { head: bodyText.slice(0, 160) });
  await shot(A, 'O1-online-done');

  /* ---- O2:停止 */
  await startRun(A, [{ tool: 'get_project', input: {} }, { sleepMs: 30000 }, { say: '这句话不该出现' }]);
  await sleep(800);
  const t0 = Date.now();
  await A.click('[data-pc="cloud-ai-panel"] [data-pc="ai-stop"]');
  const stopped = await until('O2:停止后 5 秒内停下', () => idle(A), 5_000, 50);
  const stopMs = Date.now() - t0;
  const m2 = await msgs(A);
  const a2 = lastAssistant(m2);
  const running2 = await fetch(`${AGENT_DIRECT}/info`, { headers: { Authorization: `Bearer test:${PID}:${USER}` } }).then((r) => r.json());
  check('O2:点「停止」后 5 秒内停下,回复里没有停之后才会说的话,outcome 是 aborted', !!stopped && stopMs < 5000 && !(a2?.text ?? '').includes('不该出现') && a2?.outcome === 'aborted', { stopMs, outcome: a2?.outcome, text: a2?.text });
  check('O2:服务端那一轮确实不在跑了', Array.isArray(running2.running) && running2.running.length === 0, running2.running);
  await shot(A, 'O2-online-stopped');

  /* ---- O3:事件流被掐断后自动重连、补齐 */
  const conn3 = [];
  await P(A, () => { window.__connLog = []; const t = setInterval(() => { const v = window.__pcCloud?.main?.view(); if (v) { const l = window.__connLog; if (l.at(-1) !== v.connection) l.push(v.connection); } }, 30); window.__connTimer = t; });
  const eventsBefore = agentLog.filter((r) => /\/events/.test(r.path)).length;
  const base3 = toolCount(await msgs(A));
  await startRun(A, [{ tool: 'get_project', input: {} }, { sleepMs: 1800 }, { tool: 'update_clip', input: { clipId: 'c-text', label: 'r1' } }, { sleepMs: 1800 }, { tool: 'update_clip', input: { clipId: 'c-text', label: 'r2' } }, { sleepMs: 1800 }, { say: '重连完成' }]);
  await until('O3:这一轮的第二个工具调用出现', async () => toolCount(await msgs(A)) - base3 >= 2 || null, 10_000, 50);
  const tBefore = toolCount(await msgs(A)) - base3;
  const dropped = dropAgentStreams();
  await until('O3:这一轮结束(断流之后页面自己重连补齐)', () => idle(A), 40_000, 100);
  const m3 = await msgs(A);
  const connLog = await P(A, () => { clearInterval(window.__connTimer); return window.__connLog; });
  const a3 = lastAssistant(m3);
  const tools3 = (a3?.parts ?? []).filter((p) => p.kind === 'tool');
  const eventReqs = agentLog.filter((r) => /\/events/.test(r.path)).slice(eventsBefore);
  const afters = eventReqs.map((r) => Number(new URL(r.path, SITE).searchParams.get('after')));
  check('O3:代理确实掐断了在跑的事件流', dropped >= 1, { dropped, toolsBefore: tBefore });
  check('O3:重连后工具调用数与脚本一致(读项目 + 两次改标签,不重不漏),回复在', tools3.length === 3 && tools3.every((t) => t.ok === true) && (a3?.text ?? '').includes('重连完成'), { tools: tools3.map((t) => [t.name, t.ok]), text: a3?.text });
  check('O3:连接状态经过「重连中」回到「已连接」', connLog.includes('reconnecting') && connLog.at(-1) === 'live', { connLog });
  check('O3:重连的请求带了已看到的最大 seq(after > 0)', afters.length >= 1 && afters.every((n) => n > 0), { afters });
  const labelNow = clip(await readProject(PID), 'c-text').label;
  check('O3:断流期间服务端的改动照常落地(标签是 r2)', labelNow === 'r2', { labelNow });

  /* ---- O4:关掉页面,另一台设备再进:自动接上还在跑的对话 */
  await startRun(A, [{ tool: 'get_project', input: {} }, { sleepMs: 5000 }, { tool: 'update_clip', input: { clipId: 'c-text', label: 'reopened' } }, { sleepMs: 5000 }, { say: '接上了' }]);
  const base4 = toolCount(await msgs(A));
  await until('O4:关页面之前先看到这一轮的第一个工具调用', async () => toolCount(await msgs(A)) > base4 || (await view(A))?.streaming, 10_000, 50);
  await sleep(500);
  const toolsBeforeClose = toolCount(await msgs(A));
  const convA = await P(A, () => window.__pcCloud.main.conversationId());
  await A.close();
  await sleep(1500);
  const ctxB = await browser.createBrowserContext();
  const B = await newPage(ctxB, { init: [identityScript(PID, USER)] });
  const tJoin = Date.now();
  await join(B, 'alice');
  const attached = await until('O4:新设备进项目后自动接上还在跑的对话,补齐关页面之前的过程', async () => {
    const v = await view(B);
    const m = await msgs(B);
    return v && v.conversationId === convA && toolCount(m) >= toolsBeforeClose ? { v, m } : null;
  }, 30_000, 100);
  const stillRunning = await view(B);
  check('O4:另一台设备(没有本地存储)进同一个项目,自动打开了那个对话', !!attached && attached.v.conversationId === convA, { conv: attached?.v?.conversationId, convA, ms: Date.now() - tJoin });
  check('O4:接上时看得到关页面之前的工具调用,而且这一轮还在跑(有「停止」)', toolCount(attached?.m) >= toolsBeforeClose && (stillRunning?.streaming === true || (await B.$('[data-pc="cloud-ai-panel"] [data-pc="ai-stop"]'))), { toolsBeforeClose, toolsNow: toolCount(attached?.m), streaming: stillRunning?.streaming });
  await shot(B, 'O4-online-reopened-running');
  await until('O4:这一轮在新设备上结束', () => idle(B), 40_000, 100);
  const m4 = await msgs(B);
  const a4 = lastAssistant(m4);
  const users4 = m4.filter((x) => x.role === 'user');
  const lastRunTools = (a4?.parts ?? []).filter((p) => p.kind === 'tool');
  check('O4:过程完整:最后一轮两个工具调用、回复「接上了」;整段对话里每轮一条用户消息,没有重复', lastRunTools.length === 2 && (a4?.text ?? '').includes('接上了') && users4.length === m4.filter((x) => x.role === 'assistant').length, { tools: lastRunTools.length, users: users4.length, text: a4?.text });
  check('O4:改动落地(标签是 reopened)', clip(await readProject(PID), 'c-text').label === 'reopened');
  await B.click('[data-pc="ai-history"]');
  const hist = await until('O4:历史列表的「云端」一组里有对话', () => P(B, () => { const g = document.querySelector('[data-pc="chat-cloud-group"]'); return g ? [...g.querySelectorAll('[data-pc="chat-cloud-item"]')].map((e) => ({ id: e.textContent.trim().slice(0, 40), state: e.getAttribute('data-state') })) : null; }), 10_000, 100);
  check('O4:历史列表的「云端」一组里列出这个项目里的云端对话(这位成员的)', Array.isArray(hist) && hist.length >= 1, { hist });
  await shot(B, 'O4-online-history');
  await B.click('.chat-drawer-close-btn').catch(() => {});

  /* ---- O5:出错不悄悄丢 */
  await sendText(B, stepsOf([{ fail: '模拟的模型错误' }]));
  await until('O5:模型失败的那一轮结束', async () => { const a = lastAssistant(await msgs(B)); return a?.outcome === 'error' && !a.pending; }, 20_000, 100);
  const a5 = lastAssistant(await msgs(B));
  check('O5:模型调用失败时对话里有原因(含模型接口给的话)', a5?.outcome === 'error' && String(a5?.error ?? '').includes('模拟的模型错误'), { outcome: a5?.outcome, error: a5?.error });
  await shot(B, 'O5-online-model-error');
  await startRun(B, [{ tool: 'get_project', input: {} }, { sleepMs: 20000 }, { say: '不该出现2' }]);
  await sleep(600);
  agent.service.revoke({ projectId: PID, userId: USER, reason: 'removed' });
  await until('O5:撤销后对话停下', () => idle(B), 10_000, 50);
  const a5b = lastAssistant(await msgs(B));
  check('O5:服务端撤销(被移出、开关关了)时对话里写明「已失效」,项目不动', a5b?.outcome === 'error' && /已失效/.test(String(a5b?.error ?? '')) && !(a5b?.text ?? '').includes('不该出现2'), { outcome: a5b?.outcome, error: a5b?.error });
  await shot(B, 'O5-online-revoked');
  await sendText(B, stepsOf([{ tool: 'get_project', input: {} }, { say: '撤销之后还能再发' }]));
  await until('O5:撤销之后再发一条,有回复', async () => (lastAssistant(await msgs(B))?.text ?? '').includes('撤销之后还能再发'), 20_000, 100);
  check('O5:撤销之后还能再发消息、有回复', (lastAssistant(await msgs(B))?.text ?? '').includes('撤销之后还能再发'));

  /* ---- O0 补:同源 /api/* 一个都没有 */
  const apiBlocked = await P(B, () => window.__pcApiBlocked ?? []);
  const apiReq = [...(A.requests ?? []), ...(B.requests ?? [])].filter((r) => { try { return new URL(r.url).origin === SITE && /^\/(editor\/)?api\//.test(new URL(r.url).pathname); } catch { return false; } });
  // 在线页面本来就有几条与桌面共用的 /api/ 调用被守卫就地拦下(棘轮清单里的 19 条,运行期一个字节都不出去);云端 AI 栏不该多出任何一条
  const ratchet = JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'test', 'c10a-online-api-paths.json'), 'utf8')).paths;
  const foreign = apiBlocked.filter((p) => !ratchet.includes(p) || /^\/api\/(ai|chats|mcp|agent)/.test(p));
  check('O0:整个在线对话过程中没有同源 /api/* 请求发出去;守卫拦下的只有棘轮清单里原有的,没有 /api/ai、/api/chats、/api/mcp', apiReq.length === 0 && foreign.length === 0, { apiBlocked, foreign, apiReq: apiReq.slice(0, 3) });
  check('O0:在线页面没有页面错误', B.pageErrors.length === 0 && A.pageErrors.length === 0, { A: A.pageErrors.slice(0, 3), B: B.pageErrors.slice(0, 3) });

  /* ---- O6:手机仿真仍是占位 */
  const ctxM = await browser.createBrowserContext();
  const Mo = await newPage(ctxM, { mobile: true, init: [identityScript(PID, USER)] });
  const agentBefore = agentLog.length;
  await join(Mo, 'carol');
  await sleep(3000);
  const mob = await P(Mo, () => ({ placeholder: !!document.querySelector('[data-pc="online-agent-off"]'), panel: !!document.querySelector('[data-pc="cloud-ai-panel"]'), text: document.querySelector('[data-pc="online-agent-off"]')?.textContent?.trim().slice(0, 60) ?? null }));
  const mobAgentReq = Mo.requests.filter((r) => r.url.includes('/agent/'));
  check('O6:手机仿真(低内存档)仍是占位,没有云端 AI 栏', mob.placeholder && !mob.panel, mob);
  check('O6:手机仿真没有发往 /agent/ 的请求', mobAgentReq.length === 0 && agentLog.length === agentBefore, { mobAgentReq: mobAgentReq.length, proxyDelta: agentLog.length - agentBefore });
  await shot(Mo, 'O6-mobile-placeholder');
  await ctxM.close().catch(() => {});
  await ctxB.close().catch(() => {});
  await ctxA.close().catch(() => {});
}

/* ================================================================== 桌面版 */

let desktop = null;
function shellEnv(dir) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^PROMPTCUT_/i.test(k) || /^VITE_PC_/i.test(k)) continue;
    env[k] = v;
  }
  const tmp = path.join(dir, 'tmp');
  for (const d of [tmp, path.join(dir, 'data'), path.join(dir, 'projects'), path.join(dir, 'work')]) fs.mkdirSync(d, { recursive: true });
  Object.assign(env, { BROWSER: 'none', PROMPTCUT_EXPORT_DIR: dir, PROMPTCUT_DATA_DIR: path.join(dir, 'data'), PROMPTCUT_PROJECTS_DIR: path.join(dir, 'projects'), PROMPTCUT_WORK_DIR: path.join(dir, 'work'), TEMP: tmp, TMP: tmp, TMPDIR: tmp });
  return env;
}
async function startDesktop() {
  for (const p of [PORTS.desktop, PORTS.desktop + 1, PORTS.desktop + 2]) if (!(await portFree(p))) throw new Error(`端口 ${p} 被占用`);
  const dir = path.join(TMP, 'desktop');
  const child = spawn(process.execPath, [viteBin(), '--port', String(PORTS.desktop), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: shellEnv(dir) });
  const log = [];
  const keep = (c) => { for (const line of c.toString().split(/\r?\n/)) if (line) { log.push(line); if (log.length > 4000) log.shift(); } };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  desktop = { child, origin: `http://127.0.0.1:${PORTS.desktop}`, log, dir };
  const up = await until('桌面版编辑器起来', async () => { if (child.exitCode !== null) throw new Error('exited'); return fetch(`${desktop.origin}/`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false); }, 240_000, 500);
  if (!up) throw new Error(`编辑器没起来:${log.slice(-6).join(' | ').slice(0, 400)}`);
  say('desktop.up', { origin: desktop.origin });
}
async function stopDesktop() {
  if (!desktop?.child?.pid) return;
  const pre = await getJson(`${desktop.origin}/api/prerender/info`, 3000).catch(() => null);
  killTree(desktop.child.pid);
  const prePort = pre?.url ? Number(new URL(pre.url).port) : null;
  if (prePort) { const pid = pidOnPort(prePort); if (pid) killTree(pid); }
  for (const p of [PORTS.desktop, PORTS.desktop + 1, PORTS.desktop + 2]) { const pid = pidOnPort(p); if (pid) killTree(pid); }
  desktop = null;
}
const agentReqs = (page) => page.requests.filter((r) => r.url.startsWith(`http://127.0.0.1:${PORTS.agent}/`));
const localAiReqs = (page) => page.requests.filter((r) => { try { const u = new URL(r.url); return u.origin === desktop.origin && /^\/api\/(ai\/(chat|abort)|mcp\/call)/.test(u.pathname); } catch { return false; } });

async function openDesktopEditor(page) {
  await page.goto(`${desktop.origin}/?editor&nosetup=1&aimock=1`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await until('桌面页面舞台起来', () => P(page, () => document.querySelectorAll('iframe').length >= 2 && !document.querySelector('[data-pc="probe-gate"]')), 300_000, 500);
  await P(page, () => { for (const b of document.querySelectorAll('.ais-dialog .ais-btn')) if (b.textContent?.trim() === '关闭') b.click(); });
  await page.waitForSelector('[data-pc="ai-provider"]', { timeout: 60_000 }).catch(() => {});
}

const clip6Label = (p) => p.tracks.flatMap((t) => t.clips).find((c) => c.label === 'D6 接上后')?.label ?? null;

async function desktopPhase() {
  await startDesktop();
  const ctx = await browser.createBrowserContext();
  let page = await newPage(ctx);
  // 合流前的可注入来源:文档服务没报 hosted.agent 时,让桌面页面知道云端 Agent 在哪(只在连着托管端的共享项目上才算数)
  const agentInject = `window.__pcCloudAgent = { available: true, enabled: true, url: ${JSON.stringify(AGENT_DIRECT)} };`;
  await page.evaluateOnNewDocument(agentInject);
  await openDesktopEditor(page);

  /* ---- D1:放本机的项目 */
  const NAME = `云端界面-${RUN}`;
  const clips = await P(page, async (name) => {
    const S = await import('/src/store/project.ts');
    S.actions.newProject(name);
    S.actions.seek(0);
    const a = S.actions.addClipOnNewTrack({ index: 0, cardId: 'blur-text', start: 0, duration: 4 });
    S.actions.setClipParams(a.id, { text: '原来的|标题' });
    const b = S.actions.addClipOnNewTrack({ index: 0, cardId: 'blur-text', start: 4, duration: 3 });
    S.actions.setClipParams(b.id, { text: '要挪的|片段' });
    const c = S.actions.addClipOnNewTrack({ index: 0, cardId: 'ring-metric', start: 7, duration: 4 });
    S.actions.setClipParams(c.id, { value: 40, label: '完播率' });
    return { text: a.id, move: b.id, ring: c.id };
  }, NAME);
  await sleep(2500);
  const local = await providerOptions(page);
  check('D1:放本机的项目:接入方式里没有「云端」(本机驱动都在)', local && local.options.length >= 2 && !local.options.some((o) => o.value === 'cloud'), local);
  check('D1:放本机的项目没有任何发往 Agent 服务的请求', agentReqs(page).length === 0, { n: agentReqs(page).length });

  /* ---- 放云端:桌面页面里勾「多用户协作」→ 放云端 */
  await P(page, () => window.dispatchEvent(new Event('pc-open-project-settings')));
  await page.waitForSelector('[data-pc="collab-section"]', { visible: true, timeout: 20_000 });
  await page.click('[data-pc="collab-toggle"]');
  await page.waitForSelector('[data-pc="collab-where-hosted"]', { visible: true });
  await until('创建者用户名的缺省值填上', () => page.$eval('#pc-collab-creator', (i) => i.value.trim()).catch(() => ''), 10_000, 200);
  const creator = { username: await page.$eval('#pc-collab-creator', (i) => i.value), password: await page.$eval('#pc-collab-cpw', (i) => i.value) };
  await page.click('[data-pc="collab-where-hosted"]');
  await typeInto(page, '[data-pc="collab-hosted-url"]', HOSTED_FOR_DESKTOP);
  await page.click('.pc-dialog-foot .pc-btn--primary');
  const enabled = await until('放云端开启完成', async () => { const t = await page.$eval('[data-pc="collab-status"]', (el) => el.textContent ?? '').catch(() => ''); return t && !t.includes('正在设置') ? t : null; }, 90_000, 300);
  check('D2:桌面页面开启「多用户协作」放云端', enabled?.includes('多用户协作已开启。'), { status: enabled, failures: page.failures.slice(-6), consoleErrors: page.consoleErrors.slice(-4) });
  await page.keyboard.press('Escape');
  const found = await M.lookupProject({ base: HOSTED_FOR_DESKTOP, name: NAME });
  const PID = found.projectId;
  creds.set(PID, creator);
  const USER = `${creator.username}@probe-desktop`;
  const ID = identityScript(PID, USER);
  await page.evaluateOnNewDocument(ID);
  // 合流前文档服务不报 hosted.agent:让页面重新判一次可用性(读上面注入的来源);这时身份还没有 —— 页面一个请求都不发
  await P(page, async () => { const E = await import('/src/ai/cloud/endpoint.ts'); E.setCloudAgentSource(null); });
  await sleep(1500);
  check('D2:身份还没就绪时(云端可用、没有票据)页面不向 Agent 服务发任何请求', agentReqs(page).length === 0, { n: agentReqs(page).length });
  // 身份就绪(合流后是文档服务给的委托票据;这里是测试替身):页面此时才取一次 info 加一次对话列表
  await P(page, async (ticket) => { const I = await import('/src/ai/cloud/identity.ts'); I.setCloudIdentity({ getTicket: async () => ticket, getGrant: async () => undefined }); }, `test:${PID}:${USER}`);
  await sleep(2500);

  /* ---- D2 */
  const cloudOpt = await providerOptions(page);
  const co = cloudOpt?.options.find((o) => o.value === 'cloud');
  check('D2:项目放云端后,接入方式里多了「云端」', !!co && co.text === '云端' && !co.disabled, cloudOpt);
  check('D2:本机驱动仍是缺省,没有自动切到云端', cloudOpt && cloudOpt.value !== 'cloud' && cloudOpt.value !== '', { value: cloudOpt?.value });
  const preSel = agentReqs(page).filter((r) => r.method !== 'OPTIONS');
  check('D2:不选「云端」时发往 Agent 服务的请求只有一次 info 加一次对话列表', preSel.length === 2 && preSel.some((r) => r.url.endsWith('/v1/info')) && preSel.some((r) => r.url.endsWith('/v1/conversations')), preSel.map((r) => `${r.method} ${r.url.replace(/^http:\/\/127\.0\.0\.1:\d+/, '')}`));
  // 开关被关:成员列表通知过来的 hosted.agent.enabled = false
  await P(page, async (url) => { const E = await import('/src/ai/cloud/endpoint.ts'); E.setCloudAgentSource(() => ({ available: true, enabled: false, url })); }, AGENT_DIRECT);
  await sleep(700);
  const offOpt = (await providerOptions(page))?.options.find((o) => o.value === 'cloud');
  check('D2:创建者关了开关时「云端」一项在、置灰、写原因', !!offOpt && offOpt.disabled && /项目创建者已关闭云端 Agent/.test(offOpt.title), offOpt);
  await P(page, async () => { const E = await import('/src/ai/cloud/endpoint.ts'); E.setCloudAgentSource(null); }, null);
  await sleep(700);

  /* ---- D3:选「云端」 */
  await page.select('[data-pc="ai-provider"]', 'cloud');
  await page.waitForSelector('[data-pc="cloud-ai-panel"]', { timeout: 20_000 });
  await until('D3:云端页接上', async () => { const v = await view(page); return v && v.conversationId; }, 20_000);
  const attach = await P(page, () => { const b = document.querySelector('[data-pc="cloud-ai-panel"] [data-pc="ai-attach"]'); return b ? { disabled: b.disabled, title: b.title } : null; });
  check('D3:云端下附件按钮置灰并写原因', attach?.disabled === true && /暂不支持附文件/.test(attach.title), attach);
  await page.click('[data-pc="cloud-ai-panel"] [data-pc="ai-run-options"]');
  const deep = await P(page, () => { const b = document.querySelector('[data-pc="cloud-ai-panel"] [data-pc="deep-auto"]'); return b ? { disabled: b.disabled, title: b.title } : null; });
  check('D3:云端下「深度自主」置灰并写原因(含审查环路)', deep?.disabled === true && /深度自主与审查环路/.test(deep.title), deep);
  await page.click('[data-pc="cloud-ai-panel"] [data-pc="ai-run-options"]').catch(() => {});
  await shot(page, 'D3-desktop-cloud-selected');

  /* ---- D4:发长任务,确认被接下后关页面 */
  const DESK_STEPS = [
    { tool: 'get_project', input: {} }, { sleepMs: 2500 },
    { tool: 'update_clip', input: { clipId: clips.text, params: { text: '桌面云端改的|标题' } } }, { sleepMs: 2500 },
    { tool: 'update_clip', input: { clipId: clips.move, start: 8, end: 11 } }, { sleepMs: 2500 },
    { tool: 'update_clip', input: { clipId: clips.ring, params: { value: 88 } } }, { sleepMs: 2500 },
    { say: '桌面发起的三处改动做完了' },
  ];
  await sendText(page, stepsOf(DESK_STEPS));
  const taken = await until('D4:云端接下了任务(第一个工具调用出现)', async () => toolCount(await msgs(page)) >= 1 && (await view(page))?.streaming, 20_000, 100);
  const convD = await P(page, () => window.__pcCloud.main.conversationId());
  const localAi = localAiReqs(page);
  const agentCross = agentReqs(page).filter((r) => r.method === 'POST' && r.url.includes('/messages'));
  check('D3:选「云端」后页面直连 Agent 服务(跨源 POST),没有发往本机 /api/ai/chat、/api/mcp/ 的请求', agentCross.length === 1 && localAi.length === 0, { agentPosts: agentCross.length, localAi: localAi.map((r) => r.url) });
  await shot(page, 'D4-desktop-streaming');
  check('D4:云端接下了任务', !!taken, {});
  // 关掉桌面页面:标签页离开编辑器(页面里的一切、事件流连接都没了);同一个标签页稍后再打开,共享项目的恢复信息在标签页的会话存储里
  await page.goto('about:blank');
  say('desktop.page-closed');
  const doneOnCloud = await until('D4:桌面页面关掉之后,云端对话照跑完', async () => {
    const r = await fetch(`${AGENT_DIRECT}/conversations`, { headers: { Authorization: `Bearer test:${PID}:${USER}` } }).then((x) => x.json());
    const c = (r.items ?? []).find((x) => x.id === convD);
    return c && c.state === 'idle' ? c : null;
  }, 60_000, 500);
  check('D4:桌面页面关掉后云端对话跑完(服务端状态 idle)', !!doneOnCloud, doneOnCloud ?? {});
  const pD = await readProject(PID);
  const clipD = (id) => pD.tracks.flatMap((t) => t.clips).find((c) => c.id === id);
  check('D4:桌面页面不在时三处改动照样落地', clipD(clips.text)?.params?.text === '桌面云端改的|标题' && clipD(clips.move)?.start === 8 && clipD(clips.ring)?.params?.value === 88, { text: clipD(clips.text)?.params?.text, move: clipD(clips.move)?.start, ring: clipD(clips.ring)?.params?.value });

  /* ---- D5:重新打开 */
  const markReq = page.requests.length;
  await page.goto(`${desktop.origin}/?editor&nosetup=1&aimock=1`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  const back = await until('D5:桌面页面回到同一个共享项目', () => P(page, async () => { const S = await import('/src/editor/sync/syncManager.ts'); const v = S.getSyncView(); return v.shared?.projectId ?? null; }), 120_000, 500);
  check('D5:桌面页面重新打开后回到同一个共享项目', back === PID, { back, PID });
  await until('D5:测量门放开', () => P(page, () => !document.querySelector('[data-pc="probe-gate"]')), 180_000, 300);
  await until('D5:AI 栏出来', () => page.$('[data-pc="ai-provider"]'), 60_000, 200);
  await sleep(2500);
  const reopened = await providerOptions(page);
  check('D5:重新打开后 AI 栏仍是本机驱动(云端从不自动选中)', reopened && reopened.value !== 'cloud' && reopened.options.some((o) => o.value === 'cloud'), reopened);
  const preSel2 = page.requests.slice(markReq).filter((r) => r.url.startsWith(`http://127.0.0.1:${PORTS.agent}/`) && r.method !== 'OPTIONS');
  check('D5:重新打开时只多一次 info 与一次对话列表', preSel2.length === 2, preSel2.map((r) => r.url.replace(/^http:\/\/127\.0\.0\.1:\d+/, '')));
  // 打开历史列表(点一下;没开出来就再点,最多三次)
  for (let i = 0; i < 3; i++) {
    await page.click('[data-pc="ai-history"]');
    if (await page.waitForSelector('.chat-history-drawer', { visible: true, timeout: 4000 }).catch(() => null)) break;
  }
  const group = await until('D5:历史列表「云端」一组里有刚才的对话', () => P(page, (id) => { const g = document.querySelector('[data-pc="chat-cloud-group"]'); const items = g ? [...g.querySelectorAll('[data-pc="chat-cloud-item"]')] : []; return items.length ? items.map((e) => e.textContent.trim().slice(0, 60)) : null; }, convD), 15_000, 200);
  check('D5:历史列表的「云端」一组里找得到桌面页面关掉前发起的对话', Array.isArray(group) && group.length >= 1, { group, consoleErrors: page.consoleErrors.slice(-3), failures: page.failures.slice(-3) });
  await shot(page, 'D5-desktop-history-cloud-group');
  await page.click('[data-pc="chat-cloud-item"]');
  const panelUp = await page.waitForSelector('[data-pc="cloud-ai-panel"]', { timeout: 20_000 }).catch(() => null);
  if (!panelUp) {
    await shot(page, 'D5-click-failed');
    const diag = await P(page, async () => { const T = await import('/src/ai/cloud/tabMode.ts'); return { tab: T.getCloudTab('main'), drawer: !!document.querySelector('.chat-history-drawer'), panels: [...document.querySelectorAll('aside.ai-panel')].map((a) => a.className + '|' + (a.getAttribute('data-inactive') ?? '')) }; });
    check('D5:点了历史列表里的云端对话后云端 AI 栏出现', false, { diag, consoleErrors: page.consoleErrors.slice(-4) });
    throw new Error('云端 AI 栏没出现');
  }
  const found5 = await until('D5:点开后找回完整过程', async () => { const m = await msgs(page); return m && toolCount(m) === 4 && (lastAssistant(m)?.text ?? '').includes('桌面发起的三处改动做完了') ? m : null; }, 30_000, 200);
  check('D5:点开后找回完整过程(用户消息、四个工具调用、最后的回复)', !!found5 && found5.filter((x) => x.role === 'user').length === 1, { tools: toolCount(found5), users: found5?.filter((x) => x.role === 'user').length });
  await shot(page, 'D5-desktop-cloud-recovered');

  /* ---- D6:云端对话还在跑时重新打开:有「进行中」提示,点了接上 */
  await startRun(page, [{ tool: 'get_project', input: {} }, { sleepMs: 45000 }, { tool: 'update_clip', input: { clipId: clips.text, label: 'D6 接上后' } }, { say: 'D6 做完了' }]);
  await sleep(1500);
  await page.goto('about:blank');
  await page.goto(`${desktop.origin}/?editor&nosetup=1&aimock=1`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await until('D6:桌面页面回到共享项目', () => P(page, async () => { const S = await import('/src/editor/sync/syncManager.ts'); return S.getSyncView().shared?.projectId ?? null; }), 120_000, 500);
  await until('D6:测量门放开', () => P(page, () => !document.querySelector('[data-pc="probe-gate"]')), 180_000, 300);
  const banner = await until('D6:本机模式下出现「云端对话进行中」提示', () => page.$('[data-pc="cloud-running-banner"]'), 30_000, 200);
  const optsD6 = await providerOptions(page);
  check('D6:云端对话还在跑时重新打开:AI 栏仍是本机驱动,出现「云端对话进行中」提示', !!banner && optsD6 && optsD6.value !== 'cloud', { value: optsD6?.value });
  await shot(page, 'D6-desktop-running-banner');
  await page.click('[data-pc="cloud-running-banner"] button');
  await page.waitForSelector('[data-pc="cloud-ai-panel"]', { timeout: 20_000 });
  const attachedD6 = await until('D6:点了「接上看看」后接上还在跑的对话', async () => { const v = await view(page); return v?.streaming ? v : null; }, 20_000, 100);
  check('D6:接上后看到「停止」(这一轮还在跑)', !!attachedD6 && !!(await page.$('[data-pc="cloud-ai-panel"] [data-pc="ai-stop"]')), {});
  await until('D6:这一轮结束', () => idle(page), 90_000, 200);
  const mD6 = await msgs(page);
  check('D6:接上后过程完整、回复在,改动落地', (lastAssistant(mD6)?.text ?? '').includes('D6 做完了') && clip6Label(await readProject(PID)) === 'D6 接上后', { text: lastAssistant(mD6)?.text, tools: toolCount(mD6) });
  await shot(page, 'D6-desktop-attached');
  check('D5:桌面页面没有页面错误', page.pageErrors.length === 0, page.pageErrors.slice(0, 3));
  await ctx.close().catch(() => {});
  await stopDesktop();
}

/* ================================================================== 主流程 */

let exitCode = 0;
try {
  M = {
    ...(await import('../../server/auth/client.mjs')),
    lookupProject: (await import('../../server/auth/client.mjs')).lookupProject,
  };
  await startSite();
  const health = await getJson(`http://127.0.0.1:${PORTS.agent}/healthz`).catch((e) => ({ error: String(e?.message ?? e) }));
  check('Agent 服务(托管档,本机)/healthz', health?.ok === true, health);
  browser = await launchBrowser();
  if (PHASES.has('online')) await onlinePhase();
  if (PHASES.has('desktop')) await desktopPhase();
} catch (err) {
  check('探针自己没出错', false, { error: String(err?.stack ?? err).slice(0, 800) });
} finally {
  try { await browser?.close(); } catch { /* 已关 */ }
  await stopDesktop().catch(() => {});
  for (const ws of sockets) { try { ws.close(); } catch { /* 已关 */ } }
  for (const s of upgraded) { try { s.destroy(); } catch { /* 已关 */ } }
  await Promise.all(proxies.map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }))).catch(() => {});
  await agent?.close().catch(() => {});
  await combo?.close?.().catch(() => {});
  await sleep(300);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 占着就留着 */ }
  const failed = results.filter((r) => !r.ok);
  console.log(JSON.stringify({ summary: { total: results.length, failed: failed.length, failedChecks: failed.map((r) => r.check) } }));
  exitCode = failed.length ? 1 : 0;
}
process.exit(exitCode);
