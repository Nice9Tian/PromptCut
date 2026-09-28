/**
 * M7 验收探针：纯浏览器节点（契约 `docs/plan/m7-contract.md` 第 10 节 M7-A1～A12 与 W7；第 13 节主会话裁定 D1～D18 是定论）。
 * 照契约写，不看页面节点分支（`claude/rq-m7-node`）的实现；页面诊断的读法收在 `m7-node-adapter.mjs`（集成时只改那一处）。
 *
 *   node scripts/probes/m7-browser-probe.mjs [--role all]                    本机替身：协调口 + creator、node 两个子进程
 *   node scripts/probes/m7-browser-probe.mjs --role creator [--coord <url>] [--bind 0.0.0.0 --public-host <PC 局域网 IP>]
 *   node scripts/probes/m7-browser-probe.mjs --role node --coord http://<PC>:5456 [--timing-authoritative]
 *
 * 角色（W7 跨机：PC 当 creator = 用户 A，笔记本当 node = 成员 B；协调口 KV 前缀 `m7ap`，键名见 `m8/kv.mjs`）：
 *   creator  起本机托管组合（进程内，回环不信任、集群令牌现场生成）与仿 nginx 的三源代理（编辑器页 + 两个舞台，都带 OAC）、
 *            在线构建（`vite build --mode online`，或 `--dist` 复用）；以 A 建放云端的项目（自由进入）、上传夹具；
 *            起 A 的桌面编辑器当 pc 节点（测试指纹、`PROMPTCUT_TEST_PLAN_ONLY=1`，D15）；
 *            「上帝视角」：进程内 `service.describe()` 轮询 + 一个 pc 档旁观节点（看得见全部任务的正文）；
 *            服务端一侧现在就能判的项用替身节点真判（替身 = `server/render-node/session.mjs` + `filter.mjs`，
 *            经带 `owner: { kind: 'browser' }` 的 render 票据连文档服务，即页面节点按 D11 要用的同一份节点代码）；
 *            页面当了节点以后，判服务端那一侧（任务状态、锁、清单、`snap/` `px/` 块、层表）。
 *   node     无头 Chromium（W7 在笔记本上跑）：B 的普通档页面 b1（节点候选）、低内存档页面 low、退回单舞台的页面 single；
 *            A10 另开 b2。每页用 CDP 抓全部 WebSocket 帧（握手头、收发的业务消息），判据以线上消息为准，页面诊断只作对照。
 *   all      本机替身：协调口（进程内）+ 上面两个角色各一个子进程；stdout 最后一行是汇总。
 *
 * 结果：stdout 最后一行一行 JSON：`{ ok, fails, pending, items: { 'M7-A1': { status, parts }, … }, … }`。
 *   status：pass / fail / pending（`节点未就绪（等 rq-m7-node）` 或别的前置没到）；ok = 没有 fail 也没有 pending。
 *   退出码：0 全过；1 有 fail；3 没有 fail、只有 pending；2 参数不对。
 * 计时项（M7-A4 的 30 s、A5 的 500 ms、A12 的长任务）在 PC 上跑只作参考（`timing.authoritative: false`），
 * 以笔记本为准（`guide_files/verification.md`「性能基准机」）：笔记本跑 node 角色时加 `--timing-authoritative`。
 *
 * 端口（本分支分到 5450～5459）：5450 编辑器页的源、5451 / 5452 两个舞台的源、5453～5455 A 的桌面编辑器（及舞台端口）、
 *   5456 协调口；托管组合的文档服务与素材服务用端口 0（只经代理访问）。不碰 5190～5192、5203～5205。
 * 令牌与口令：集群令牌、票据、会话号、口令都不打印、不进结果行；票据只在内存里做「有没有漏进地址 / 日志 / describe」的比对。
 *
 * 其它参数：
 *   --out <目录>  --keep-temp  --dist <在线构建目录>  --timeout-min 120  --node-wait-s 60  --a3-seconds 60
 *   --no-twin     页面没当节点时不跑「页面同身份替身」的 D1 / D2 / D12 服务端检查（它要 30 s 以上的锁闲置）
 *   --no-a10      不跑 M7-A10（它要重启 A 的编辑器、关页面、等 30 s）
 *   --headful     node 角色用有头 Chrome（排障）
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { argsOf, sayer, newRunId, lastJsonLine, fingerprintOf } from './m8/lib.mjs';
import { roleKv, resolveRun } from './m8/kv.mjs';
import { startCoord, startQueueEditor, viteBin, killTree, until, claimPorts, portFree } from './m8/procs.mjs';
import { ASSUMPTIONS, readNodeDiag, readStageBakeDiag, releaseCauseOf } from './m7-node-adapter.mjs';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..', '..');
const PROBE = 'm7-browser-probe';
const PREFIX = 'm7ap';
const BAND = [5450, 5459];
const PORTS = { site: 5450, stageA: 5451, stageB: 5452, editor: 5453, coord: 5456 };
const FPS = 30;
const SECONDS = 10;
const NODE_PENDING = '节点未就绪（等 rq-m7-node）';
/** 票据的样子（`v1.<负载>.<签名>`，`server/auth/tickets.mjs`）：日志、地址、describe 里出现这样的串就算漏 */
const TICKET_RE = /v1\.[A-Za-z0-9_-]{40,}\.[A-Za-z0-9_-]{30,}/;

const { arg, flag } = argsOf();
const ROLE = arg('--role', arg('--site') ? 'creator' : 'all');
const say = sayer(PROBE, ROLE);
const TIMEOUT_MS = Number(arg('--timeout-min', 120)) * 60_000;
const deadline = Date.now() + TIMEOUT_MS;
const NODE_WAIT_MS = Number(arg('--node-wait-s', 60)) * 1000;
const A3_MS = Number(arg('--a3-seconds', 60)) * 1000;

/** 等一个 KV 信号；对方中止（abort）就回 null，不干等到总时限 */
async function waitSignal(kv, name) {
  const v = await until(async () => (await kv.peekSignal(name)) ?? ((await kv.aborted()) ? { __aborted: true } : null), Math.max(1000, deadline - Date.now()), 1000);
  return v?.__aborted ? null : v;
}

/* ================================================================== 验收项的账本 */

const ITEM_IDS = ['M7-A1', 'M7-A2', 'M7-A3', 'M7-A4', 'M7-A5', 'M7-A6', 'M7-A7', 'M7-A8', 'M7-A9', 'M7-A10', 'M7-A11', 'M7-A12', 'W7', 'D9', 'D10', 'D14', 'D1-D2-D12'];

/** 每项由若干「部分」组成（服务端替身、页面、计时……），各部分 pass / fail / pending；项的状态取最差的 */
function createBook() {
  const items = {};
  const book = {
    items,
    part(id, name, status, detail) {
      if (!['pass', 'fail', 'pending'].includes(status)) throw new Error(`状态不对：${status}`);
      (items[id] ??= { parts: {} }).parts[name] = { status, ...(detail === undefined ? {} : { detail }) };
      say('part', { id, name, status, detail: JSON.stringify(detail ?? null).slice(0, 1500) });
      return status === 'pass';
    },
    judge(id, name, ok, detail) { return book.part(id, name, ok ? 'pass' : 'fail', detail); },
    /** 带耗时门槛的判据：只有在性能基准机（笔记本，node 角色带 --timing-authoritative）上才判；别处只记录、标「待笔记本复核」 */
    timed(id, name, ok, detail, authoritative) {
      if (authoritative) return book.judge(id, name, ok, detail);
      return book.part(id, name, 'pending', { reason: '待笔记本复核（这台机器上的计时只作参考）', referenceVerdict: ok ? 'pass' : 'fail', observed: detail });
    },
    pending(id, name, reason, detail) { return book.part(id, name, 'pending', { reason, ...(detail === undefined ? {} : { observed: detail }) }); },
    merge(other) { for (const [id, it] of Object.entries(other ?? {})) for (const [name, p] of Object.entries(it.parts ?? {})) (items[id] ??= { parts: {} }).parts[name] = p; },
    summary() {
      const out = {};
      const fails = [];
      const pending = [];
      for (const id of [...ITEM_IDS, ...Object.keys(items).filter((k) => !ITEM_IDS.includes(k))]) {
        const it = items[id];
        if (!it) { out[id] = { status: 'pending', parts: {}, note: '这一轮没有走到' }; pending.push(`${id}: 这一轮没有走到`); continue; }
        const st = Object.values(it.parts).map((p) => p.status);
        const status = st.includes('fail') ? 'fail' : st.includes('pending') || st.length === 0 ? 'pending' : 'pass';
        out[id] = { status, parts: it.parts };
        for (const [name, p] of Object.entries(it.parts)) {
          if (p.status === 'fail') fails.push(`${id}/${name} :: ${JSON.stringify(p.detail ?? null).slice(0, 300)}`);
          if (p.status === 'pending') pending.push(`${id}/${name}: ${p.detail?.reason ?? ''}`);
        }
      }
      return { items: out, fails, pending };
    },
  };
  return book;
}

/* ================================================================== 小工具 */

const sha = (s) => fingerprintOf(s);
const nowIso = () => new Date().toISOString();
const errText = (e) => String(e?.message ?? e).slice(0, 500);
const sleepUntil = (t) => delay(Math.max(0, t - Date.now()));

let modsP = null;
/** 按需载入被测模块 */
function mods() {
  modsP ??= (async () => {
    const [client, shared, route, link, fp, messages, session, transfer, filter] = await Promise.all([
      import('../../server/auth/client.mjs'), import('../../server/auth/shared-config.mjs'), import('../../server/auth/route.mjs'),
      import('../../server/render-node/session-link.mjs'), import('../../server/render-node/fingerprint.mjs'),
      import('../../server/render-queue/messages.mjs'), import('../../server/render-node/session.mjs'), import('../../server/artifact-transfer.mjs'),
      import('../../server/render-node/filter.mjs'),
    ]);
    return { ...client, ...shared, ...route, ...link, ...fp, ...messages, ...session, ...transfer, ...filter };
  })();
  return modsP;
}

/** 请求 / 回包按 reqId 配对；另记这条连接收到的全部消息（`all`） */
function rpcOn(ep, tag) {
  const waiting = new Map();
  const all = [];
  let seq = 0;
  ep.onMessage((m) => {
    all.push({ at: Date.now(), m });
    if (all.length > 20_000) all.shift();
    const w = m?.reqId !== undefined ? waiting.get(m.reqId) : undefined;
    if (!w) return;
    waiting.delete(m.reqId);
    clearTimeout(w.timer);
    w.resolve(m);
  });
  const rpc = (message, timeoutMs = 20_000) => new Promise((resolve, reject) => {
    const reqId = `m7ap-${tag}-${++seq}-${randomBytes(3).toString('hex')}`;
    const timer = setTimeout(() => { waiting.delete(reqId); reject(new Error(`等 ${message.type} 的回包超时`)); }, timeoutMs);
    waiting.set(reqId, { resolve, timer });
    if (!ep.send({ ...message, reqId })) { waiting.delete(reqId); clearTimeout(timer); reject(new Error(`${message.type} 没发出去`)); }
  });
  return { rpc, all };
}

function closeEp(ep) {
  return new Promise((resolve) => {
    if (!ep.connected) { try { ep.close(); } catch { /* 已关 */ } return resolve(); }
    const t = setTimeout(resolve, 3000);
    ep.onClose(() => { clearTimeout(t); resolve(); });
    try { ep.close(); } catch { clearTimeout(t); resolve(); }
  });
}

/** 设备 id：16～64 个 [A-Za-z0-9_-] */
const deviceOf = (tag, run) => `m7ap-${tag}-${run}`.replace(/[^A-Za-z0-9_-]/g, '-').padEnd(16, '0').slice(0, 64);

/** 替身报的环境原始值：Linux + SwiftShader + 指定的 Chrome 主版本（主版本不同 → 指纹不同，与真页面、pc 都不撞） */
function standinEnv(major, { ua = null } = {}) {
  return {
    platform: 'Linux x86_64',
    userAgent: ua ?? `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
    vendor: 'Google Inc. (Google)',
  };
}
const UA = {
  firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
  safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  crios: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.0.0 Mobile/15E148 Safari/604.1',
};

/* ================================================================== 探针项目（夹具） */

/**
 * 10 秒时间轴：一张轻卡（`chapter-bar`）+ 三张重卡（D15「3 张没被预渲染过的重卡，独立、内置」）。
 * 重卡缺省用 `probe-slow-stepped`（内置、审阅表 `independent`、每个新时刻烧 40 ms，任何机器上都判重）；
 * `--a4-motion` 改用三张 Motion 卡（`punch-pill`、`mu-number-ticker`、`mu-blur-fade`，独立、内置），但它们在快机器上可能判轻。
 */
function projectDoc(projectId, extra = []) {
  const heavy = flag('--a4-motion')
    ? [['h1', 'punch-pill', { text: 'M7 h1' }], ['h2', 'mu-number-ticker', { value: 12480, label: 'h2', unit: '' }], ['h3', 'mu-blur-fade', { text: 'M7 h3' }]]
    : [['h1', 'probe-slow-stepped', { burnMs: 40, label: 'h1' }], ['h2', 'probe-slow-stepped', { burnMs: 40, label: 'h2' }], ['h3', 'probe-slow-stepped', { burnMs: 40, label: 'h3' }]];
  const tracks = [
    ...[...heavy, ...extra].map(([id, cardId, params, start = 0, end = SECONDS]) => ({ id: `t-${id}`, name: id, clips: [{ id, cardId, start, end, params }] })),
    { id: 't-light', name: 'light', clips: [{ id: 'light', cardId: 'chapter-bar', start: 0, end: SECONDS, params: {} }] },
  ];
  return { version: 1, id: projectId, name: `m7ap ${projectId}`, width: 1920, height: 1080, fps: FPS, duration: SECONDS, themeId: 'midnight', media: [], tracks };
}

/* ================================================================== 本机替身：在线构建 + 托管组合 + 三源代理 */

async function buildOnline(out) {
  let dist = arg('--dist', null);
  if (dist) return path.resolve(dist);
  dist = path.join(out, 'dist-online');
  say('build-online', { dist });
  const t0 = Date.now();
  const b = spawnSync(process.execPath, [viteBin(), 'build', '--mode', 'online', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (b.status !== 0) throw new Error(`在线构建失败：${String(b.stderr).slice(-800)}`);
  say('build-online.done', { ms: Date.now() - t0 });
  return dist;
}

/**
 * 托管组合（进程内，`server/hosted/combo.mjs`）+ 三个源的仿 nginx 前缀代理（同 `c10-browser-probe.mjs`）。
 * 回环不信任（`trustLoopback: false`）：代理转进来的连接一律按远端核凭证，D9 的票据归属才落得到连接上。
 */
async function startSite({ out, bind, publicHost }) {
  await claimPorts([PORTS.site, PORTS.stageA, PORTS.stageB], { band: BAND, triple: false });
  const dist = await buildOnline(out);
  const logs = [];
  const clusterToken = randomBytes(32).toString('base64url');
  const site = `http://${publicHost}:${PORTS.site}`;
  const stageOrigins = [`http://${publicHost}:${PORTS.stageA}`, `http://${publicHost}:${PORTS.stageB}`];
  const { startHostedCombo } = await import('../../server/hosted/combo.mjs');
  const dataDir = path.join(out, 'hosted');
  fs.mkdirSync(dataDir, { recursive: true });
  const combo = await startHostedCombo({
    dataDir, docPort: 0, assetPort: 0, host: '127.0.0.1', clusterToken, trustLoopback: false,
    docPublicUrl: `${site.replace(/^http/, 'ws')}/hosted/`, assetPublicUrl: `${site}/media/api/asset`,
    log: (event, fields) => { logs.push(JSON.stringify({ event, ...fields })); if (logs.length > 50_000) logs.shift(); },
  });
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.wasm': 'application/wasm' };
  const OAC = { 'origin-agent-cluster': '?1' };
  const runtimeConfig = JSON.stringify({ v: 1, stageOrigins });
  const urls = [];
  const servers = [];
  const makeProxy = (port) => {
    const forward = (req, res, upstream, strip) => {
      const target = req.url.slice(strip.length) || '/';
      const up = http.request({ host: '127.0.0.1', port: upstream, method: req.method, path: target.startsWith('/') ? target : `/${target}`,
        headers: { ...req.headers, 'x-forwarded-for': req.socket.remoteAddress ?? '' } }, (r) => {
        res.writeHead(r.statusCode ?? 502, { ...r.headers, ...OAC });
        r.pipe(res);
      });
      up.on('error', () => { if (!res.headersSent) res.writeHead(502, OAC); res.end('bad gateway'); });
      req.pipe(up);
    };
    const server = http.createServer((req, res) => {
      urls.push(req.url);
      if (urls.length > 50_000) urls.shift();
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/hosted' || url.pathname.startsWith('/hosted/')) return forward(req, res, combo.docPort, '/hosted');
      if (url.pathname.startsWith('/media/')) return forward(req, res, combo.assetPort, '/media');
      const sec = { 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', ...OAC };
      const sendFile = (file, cache) => {
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': cache, ...sec });
        fs.createReadStream(file).pipe(res);
      };
      if (url.pathname === '/editor/runtime-config.json') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...sec });
        return res.end(runtimeConfig);
      }
      const index = path.join(dist, 'index.html');
      if (url.pathname === '/editor' || url.pathname === '/editor/' || url.pathname === '/editor/index.html') return sendFile(index, 'no-store');
      if (url.pathname.startsWith('/editor/assets/')) {
        const f = path.join(dist, decodeURIComponent(url.pathname.slice('/editor/'.length)));
        if (!f.startsWith(dist) || !fs.existsSync(f)) { res.writeHead(404, sec); return res.end('not found'); }
        return sendFile(f, 'public, max-age=31536000, immutable');
      }
      if (url.pathname.startsWith('/editor/')) return sendFile(index, 'no-store');
      res.writeHead(404, { 'Content-Type': 'text/plain', ...OAC });
      res.end('not found');
    });
    server.on('upgrade', (req, socket, head) => {
      urls.push(req.url);
      const url = new URL(req.url, 'http://x');
      if (!(url.pathname === '/hosted' || url.pathname.startsWith('/hosted/'))) return socket.destroy();
      const target = (url.pathname.slice('/hosted'.length) || '/') + url.search;
      const up = net.connect(combo.docPort, '127.0.0.1', () => {
        const lines = [`${req.method} ${target} HTTP/1.1`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
        lines.push(`X-Forwarded-For: ${req.socket.remoteAddress ?? ''}`);
        up.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (head?.length) up.write(head);
        up.pipe(socket);
        socket.pipe(up);
      });
      up.on('error', () => socket.destroy());
      socket.on('error', () => up.destroy());
    });
    servers.push(server);
    return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, bind, resolve); });
  };
  await Promise.all([makeProxy(PORTS.site), makeProxy(PORTS.stageA), makeProxy(PORTS.stageB)]);
  say('site.up', { site, stageOrigins, bind, docPort: combo.docPort, assetPort: combo.assetPort });
  return {
    site, stageOrigins, dist, combo, logs, urls,
    /** Node 侧直连文档服务（不经代理） */
    ws: `ws://127.0.0.1:${combo.docPort}`,
    /** 进程内的 describe()，队列部分拍平成一张表（本机空间 + 各共享项目空间） */
    queues() {
      const d = combo.service.describe();
      const rq = d?.modules?.['render-queue'];
      const list = [];
      if (rq?.tasks) list.push(rq);
      for (const q of Object.values(rq?.spaces ?? {})) if (q?.tasks) list.push(q);
      return { raw: d, list };
    },
    async stop() {
      for (const s of servers) await new Promise((r) => { s.close(() => r()); s.closeAllConnections?.(); });
      await combo.close().catch(() => {});
    },
  };
}


/* ================================================================== 外网模式（--site）：站点、上帝视角、素材核对 */

/**
 * 外网模式的站点：不起本机托管组合与代理；页面 `<源>/editor`，文档服务 `<源>/hosted/`，素材服务 `<源>/media/api/asset`，
 * 两个舞台源读 `<源>/editor/runtime-config.json`。托管端的日志与 describe() 看不到。
 */
async function remoteSite(origin) {
  const site = origin.replace(/\/+$/, '');
  const rc = await fetch(site + '/editor/runtime-config.json', { signal: AbortSignal.timeout(15_000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const stageOrigins = Array.isArray(rc?.stageOrigins) ? rc.stageOrigins : Object.values(rc?.stageOrigins ?? {});
  say('site.remote', { site, stageOrigins });
  return { site, stageOrigins, remote: true, combo: null, logs: [], urls: [], ws: site.replace(/^http/, 'ws') + '/hosted/', queues: () => ({ raw: null, list: [] }), stop: async () => {} };
}

/**
 * 外网模式的上帝视角：没有进程内 describe()，只能从 pc 档旁观节点收到的消息拼（opened / taken / closed）。
 * 认领者（nodeId）、attempts、lastError 拿不到（记 null）；锁按「最后一次被认领的那份任务的指纹」推断。
 */
function remoteGodView(watcher) {
  const tasks = new Map();
  const locks = new Map();
  let seen = 0;
  const poll = () => {
    const ev = watcher.events;
    for (; seen < ev.length; seen++) {
      const e = ev[seen];
      if (!e.id) continue;
      let r = tasks.get(e.id);
      if (!r) { r = { id: e.id, firstSeen: e.at, states: [], claimedBy: [], attempts: null, lastError: null, doneAt: null }; tasks.set(e.id, r); }
      const body = watcher.bodies.get(e.id);
      const state = e.type === 'task.opened' ? 'open' : e.type === 'task.taken' ? 'claimed' : e.type === 'task.closed' ? e.state : null;
      if (!state || state === 'hidden') continue;
      if (r.states.at(-1)?.state !== state) r.states.push({ state, at: e.at });
      r.state = state;
      if (body?.version !== undefined) r.version = body.version;
      if (state === 'done' && !r.doneAt) r.doneAt = e.at;
      if (state === 'claimed' && body?.input?.contentKey && body.kind !== 'plan') {
        const lk = body.kind + ':' + body.input.contentKey;
        const fp = body.requires?.envFingerprint ?? null;
        const l = locks.get(lk) ?? { lockKey: lk, history: [], inferred: true };
        if (l.history.at(-1)?.envFingerprint !== fp) l.history.push({ envFingerprint: fp, at: e.at });
        l.envFingerprint = fp;
        locks.set(lk, l);
      }
    }
    // 旁观节点在快照里先收到、还没有事件的任务按 open 记
    for (const [id, b] of watcher.bodies) if (!tasks.has(id)) tasks.set(id, { id, firstSeen: Date.now(), states: [{ state: 'open', at: Date.now() }], state: 'open', version: b.version, claimedBy: [], attempts: null, lastError: null, doneAt: null });
  };
  const timer = setInterval(poll, 250);
  return { tasks, nodes: new Map(), locks, poll, remote: true, get polls() { return seen; }, browserNodes: () => [], lockOf: (k) => { poll(); return locks.get(k) ?? null; }, stop: () => clearInterval(timer) };
}

/** 素材服务上这一块齐没齐（GET <ns>/<hash>/chunks 的 complete）；读票据现签，只在内存里 */
async function assetHasFactory(ctx) {
  let ticket = null;
  let ticketAt = 0;
  const base = ctx.site.remote ? ctx.site.site + '/media/api/asset' : 'http://127.0.0.1:' + ctx.site.combo.assetPort + '/api/asset';
  return async (ns, hash) => {
    if (!ticket || Date.now() - ticketAt > 5 * 60_000) {
      const r = await ctx.aConn.rpc({ type: 'auth.ticket', kind: 'asset', access: 'r' }).catch(() => null);
      ticket = r?.ticket ?? null; ticketAt = Date.now();
      if (ticket) ctx.secrets.add(ticket);
    }
    const res = await fetch(base + '/' + ns + '/' + hash + '/chunks', { headers: ticket ? { Authorization: 'Bearer ' + ticket } : {}, signal: AbortSignal.timeout(15_000) }).catch(() => null);
    const j = res?.ok ? await res.json().catch(() => null) : null;
    return j?.complete === true;
  };
}

/* ================================================================== 文档服务连接（Node 侧） */

/** 以某个身份（口令）开一条会话层连接 */
async function openConn({ url, projectId, username, password, as = 'member', role = 'page', device, tag, log = () => {} }) {
  const M = await mods();
  const entry = M.normalizeEntry({ url, projectId, username, password, as, role, deviceId: device, deviceName: `m7ap ${tag}` });
  const ep = M.createDocEndpoint({ url: entry.url, protocols: M.sharedProtocols(entry, { role }), log: (e, f) => log(`${tag}.${e}`, f) });
  const { rpc, all } = rpcOn(ep, tag);
  const opened = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 30_000);
    ep.onOpen(() => { clearTimeout(t); resolve(true); });
  });
  if (!opened) { try { ep.close(); } catch { /* 没连上 */ } throw new Error(`${tag} 连不上文档服务`); }
  return { ep, rpc, all, userId: `${username}@${device}`, close: () => closeEp(ep) };
}

/**
 * 纯浏览器节点的 render 连接（契约第 5 节）：每建一次会话，经页面连接现签 `auth.ticket { kind: 'conn', role: 'render', owner: { kind: 'browser' } }`，
 * 交 `ticketProtocols(票据)`。票据只进 `secrets`（查泄漏用），不打印。
 */
async function openBrowserRender({ url, pageConn, tag, secrets, owner = { kind: 'browser' }, log = () => {} }) {
  const M = await mods();
  const ep = M.createDocEndpoint({
    url,
    protocols: async () => {
      const r = await pageConn.rpc({ type: 'auth.ticket', kind: 'conn', role: 'render', ...(owner ? { owner } : {}) });
      if (r?.type !== 'auth.ticket.ok') throw new Error(`auth.ticket 回 ${r?.type} ${r?.reason ?? ''}`);
      secrets.add(r.ticket);
      return M.ticketProtocols(r.ticket);
    },
    log: (e, f) => log(`${tag}.${e}`, f),
  });
  const { rpc, all } = rpcOn(ep, tag);
  const opened = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 30_000);
    ep.onOpen(() => { clearTimeout(t); resolve(true); });
  });
  if (!opened) { try { ep.close(); } catch { /* 没连上 */ } throw new Error(`${tag} 的 render 连接没建成`); }
  return { ep, rpc, all, close: () => closeEp(ep) };
}

/** 报到：回 `node.welcome` 或 `error`（带 reqId 的回包；认不出时回 null） */
async function hello(conn, fields) {
  try { return await conn.rpc({ type: 'node.hello', maxConcurrent: 1, capabilities: {}, codeVersions: [], resume: [], ...fields }, 15_000); } catch (e) { return { type: 'timeout', detail: errText(e) }; }
}

/** 上传整份项目（根替换；项目小，一次 `project.op` 就够） */
async function putProject(conn, projectId, doc, run) {
  const r = await conn.rpc({ type: 'project.op', projectId, opId: `m7ap-${run}-${Date.now().toString(36)}${randomBytes(2).toString('hex')}`, session: `m7ap-${run}`,
    ops: [{ op: 'set', path: '', value: doc }] }, 30_000);
  if (r?.type !== 'project.op.ok') throw new Error(`project.op 回 ${r?.type} ${r?.reason ?? ''}`);
  return r.rev;
}

/**
 * 在当前文档上做路径操作（不整份替换：页面自己加的片段要留着）。`addCards` 在最上面插新轨道，`touchLight` 改轻卡参数（只为让版本变、页面重发计划）
 */
async function opProject(conn, projectId, ops, run) {
  const r = await conn.rpc({ type: 'project.op', projectId, opId: `m7ap-${run}-${Date.now().toString(36)}${randomBytes(2).toString('hex')}`, session: `m7ap-${run}`, ops }, 30_000);
  if (r?.type !== 'project.op.ok') throw new Error(`project.op 回 ${r?.type} ${r?.reason ?? ''}`);
  return r.rev;
}
const addCards = (conn, projectId, cards, run) => opProject(conn, projectId, cards.map(([id, cardId, params, start = 0, end = SECONDS]) => ({ op: 'insert', path: '/tracks', index: 0, value: { id: `t-${id}`, name: id, clips: [{ id, cardId, start, end, params }] } })), run);
const touchLight = (conn, projectId, run) => opProject(conn, projectId, [{ op: 'set', path: '/tracks/@t-light/clips/@light/params', value: { title: `m7ap ${Date.now()}` } }], run);

async function contentGet(conn, key) {
  const r = await conn.rpc({ type: 'content.get', kind: 'snapshot-manifest', key }, 20_000).catch(() => null);
  return r?.type === 'content.item' && !r.missing ? r.body ?? null : null;
}

/* ================================================================== 替身节点（服务端一侧的真判） */

/**
 * 替身纯浏览器节点：`createNodeSession`（页面按 D11 要用的同一份会话与过滤代码）+ 带浏览器归属的 render 连接。
 * `mode`：'observe' 只报到、watch、记消息，不认领；'work' 照过滤认领，认领到先 progress(0)，隔 workMs 完成（清单是假的）；
 * 'grab' 认领第一件 `grab(task)` 为真的任务，progress(0) 后隔 holdMs 放回（D2 要的锁），之后不再认领。
 */
async function startStandin({ url, pageConn, tag, env, secrets, projects, codeVersions = [], mode = 'observe', workMs = 300, holdMs = 1500, grab = () => true, log = () => {} }) {
  const M = await mods();
  const render = await openBrowserRender({ url, pageConn, tag, secrets, log });
  const fp = M.describeEnvironment({ platform: env.platform, renderer: env.renderer, vendor: env.vendor, chromeVersion: env.userAgent }).fingerprint;
  const nodeId = `m7ap-${tag}-${randomBytes(3).toString('hex')}`;
  const rec = { sent: [], recv: render.all, claimedIds: [], completed: [], released: [], welcome: null, errors: [] };
  let grabbed = null;
  let grabbing = mode === 'grab';
  let grabPred = grab;
  const attempted = new Set();
  const session = M.createNodeSession({
    nodeId, node: { profile: 'browser', envFingerprint: fp, codeVersions, capabilities: {}, userId: pageConn.userId }, now: Date.now, maxConcurrent: 1, projects,
    isIdle: () => mode === 'work',
    send: (m) => {
      const out = m.type === 'node.hello' ? { ...m, environment: env } : m;
      rec.sent.push({ at: Date.now(), type: out.type, id: out.id ?? null, reason: out.reason ?? null });
      render.ep.send(out);
    },
    onTask: (task, { token }) => {
      rec.claimedIds.push(task?.id ?? null);
      if (mode === 'work') {
        session.progress(task.id, 0);
        setTimeout(() => {
          const result = { v: 1, kind: 'snapshot', tier: task.tier ?? 'shared', resultKey: task.resultKey, dirKey: task.resultKey, entryKey: null, range: task.range, canvasHeavy: false, frames: [] };
          if (session.complete(task.id, result)) rec.completed.push(task.id);
        }, workMs);
      } else if (mode === 'grab') {
        grabbing = false;
        grabbed = { id: task.id, at: Date.now(), token };
        session.progress(task.id, 0);
        setTimeout(() => { session.yieldAll('m7ap-grab-release'); rec.released.push(task.id); }, holdMs);
      } else {
        session.yieldAll('m7ap-observer');
      }
    },
    onLost: (id, reason) => rec.errors.push({ lost: id, reason }),
  });
  render.ep.onMessage((m) => {
    if (m?.type === 'node.welcome') rec.welcome = m;
    if (m?.type === 'error') rec.errors.push({ reason: m.reason, detail: m.detail });
    session.receive(m);
  });
  render.ep.onOpen(() => session.start(session.held()));
  session.start([]);
  const timer = setInterval(() => {
    try { session.tick(); } catch (e) { rec.errors.push({ tick: errText(e) }); }
    // 'grab'：只认领满足条件的（锚帧段先），每个 id 只试一次；认领回包由会话照常处理（onClaimed 不要求在飞）
    if (mode === 'grab' && grabbing) {
      const t = session.known().filter((x) => grabPred(x) && !attempted.has(x.id)).sort((a, b) => (b.priority === 50) - (a.priority === 50))[0];
      if (t) {
        attempted.add(t.id);
        rec.sent.push({ at: Date.now(), type: 'task.claim', id: t.id, reason: null });
        render.ep.send({ type: 'task.claim', id: t.id, expectVersion: t.version ?? 1 });
      }
    }
  }, 50);
  await until(() => rec.welcome || rec.errors.find((e) => e.reason), 15_000, 50);
  return {
    tag, nodeId, fp, env, session, rec, render,
    get grabbed() { return grabbed; },
    setMode(next) { mode = next; grabbing = next === 'grab'; },
    setGrab(pred) { grabPred = pred; grabbed = null; mode = 'grab'; grabbing = true; },
    async stop() { clearInterval(timer); try { session.yieldAll('m7ap-stop'); } catch { /* 已停 */ } await render.close(); },
  };
}

/**
 * 假干活节点（非浏览器、自报指纹，用来「做完」某些任务）：认领 `pick(task)` 为真的任务，progress(0) 后隔 workMs 以空清单完成。
 * A 的一整轮（A1）用它；页面没当节点时，也用它替 pc 吃掉非双份的细任务（代 D15 的「只切分」开关，见 twinChecks）。
 */
async function startFakeWorker({ url, projectId, cred, as = 'creator', tag, run, fp = null, codeVersions = [], profile = 'host', pick = () => true, workMs = 150, log = () => {} }) {
  const M = await mods();
  const conn = await openConn({ url, projectId, username: cred.username, password: cred.password, as, role: 'render', device: deviceOf(tag, run), tag, log });
  const done = [];
  const session = M.createNodeSession({
    nodeId: `m7ap-${tag}-${run}`, node: { profile, codeVersions, capabilities: {}, ...(fp ? { envFingerprint: fp } : {}) }, now: Date.now, maxConcurrent: 2, projects: [projectId],
    send: (m) => conn.ep.send(m.type === 'node.hello' && fp ? { ...m, envFingerprint: fp } : m),
    onTask: (task) => {
      if (!pick(task)) { session.yieldAll('m7ap-not-mine'); return; }
      session.progress(task.id, 0);
      setTimeout(() => { if (session.complete(task.id, { v: 1, kind: 'snapshot', tier: task.tier ?? 'shared', resultKey: task.resultKey, dirKey: task.resultKey, entryKey: null, range: task.range, canvasHeavy: false, frames: [] })) done.push(task.id); }, workMs);
    },
    onLost: () => {},
  });
  // 只认领 pick 为真的：包一层会话的视图（filterClaimable 之前先筛）
  const origKnown = session.known;
  conn.ep.onMessage((m) => {
    if (m?.type === 'queue.snapshot') m = { ...m, tasks: (m.tasks ?? []).filter(pick) };
    else if (m?.type === 'task.opened' && m.task && !pick(m.task)) return;
    session.receive(m);
  });
  session.start([]);
  const timer = setInterval(() => { try { session.tick(); } catch { /* 忽略 */ } }, 50);
  return { conn, session, done, known: origKnown, async stop() { clearInterval(timer); try { session.yieldAll('m7ap-stop'); } catch { /* 已停 */ } await conn.close(); } };
}

/* ================================================================== 上帝视角（creator） */

/** 轮询进程内 describe()：每个任务的状态史、认领过它的节点、锁、节点表 */
function startGodView(site) {
  const tasks = new Map();
  const nodes = new Map();
  const locks = new Map();
  let polls = 0;
  const poll = () => {
    let qs;
    try { qs = site.queues().list; } catch { return; }
    polls += 1;
    const at = Date.now();
    for (const q of qs) {
      for (const t of q.tasks ?? []) {
        let r = tasks.get(t.id);
        if (!r) { r = { id: t.id, projectId: t.projectId, firstSeen: at, states: [], claimedBy: [], attempts: t.attempts, lastError: null, doneAt: null }; tasks.set(t.id, r); }
        if (r.states.at(-1)?.state !== t.state) r.states.push({ state: t.state, at });
        r.state = t.state;
        r.attempts = t.attempts;
        r.lastError = t.lastError ?? null;
        r.version = t.version;
        if (t.claim?.nodeId && r.claimedBy.at(-1)?.nodeId !== t.claim.nodeId) r.claimedBy.push({ nodeId: t.claim.nodeId, at });
        if (t.state === 'claimed' && t.claim) r.progress = t.claim.progress?.done ?? null;
        if (t.state === 'done' && !r.doneAt) r.doneAt = at;
      }
      for (const n of q.nodes ?? []) {
        const r = nodes.get(n.nodeId) ?? { nodeId: n.nodeId, firstSeen: at, claimsMax: 0 };
        Object.assign(r, { profile: n.profile, userId: n.userId, envFingerprint: n.envFingerprint, connected: n.connected, claims: n.claims });
        r.claimsMax = Math.max(r.claimsMax, n.claims ?? 0);
        nodes.set(n.nodeId, r);
      }
      for (const l of q.locks ?? []) {
        const r = locks.get(l.lockKey) ?? { lockKey: l.lockKey, history: [] };
        if (r.history.at(-1)?.envFingerprint !== l.envFingerprint) r.history.push({ envFingerprint: l.envFingerprint, at });
        Object.assign(r, { envFingerprint: l.envFingerprint, source: l.source, touchedAt: l.touchedAt });
        locks.set(l.lockKey, r);
      }
    }
  };
  const timer = setInterval(poll, 250);
  poll();
  return {
    tasks, nodes, locks, poll,
    get polls() { return polls; },
    lockOf: (k) => locks.get(k) ?? null,
    browserNodes: () => [...nodes.values()].filter((n) => n.profile === 'browser'),
    stop: () => clearInterval(timer),
  };
}

/** pc 档旁观节点（A 的 render 连接，不带指纹、watch 'all'）：看得见全部任务的正文（requires、input、priority、source.userId） */
async function startWatcher({ url, projectId, cred, run, log }) {
  const conn = await openConn({ url, projectId, username: cred.username, password: cred.password, as: 'creator', role: 'render', device: deviceOf('watch', run), tag: 'watcher', log });
  const bodies = new Map();
  const closed = new Map();
  const events = [];
  conn.ep.onMessage((m) => {
    const put = (t) => { if (t?.id) bodies.set(t.id, t); };
    if (m?.type === 'queue.snapshot') for (const t of m.tasks ?? []) put(t);
    else if (m?.type === 'task.opened') put(m.task);
    if (m?.type === 'task.closed') closed.set(m.id, { state: m.state, reason: m.reason ?? null, at: Date.now() });
    if (/^task\./.test(m?.type ?? '')) { events.push({ at: Date.now(), type: m.type, id: m.id ?? m.task?.id ?? null, state: m.state ?? null, reason: m.reason ?? null }); if (events.length > 50_000) events.shift(); }
  });
  const reg = async () => {
    const h = await hello(conn, { nodeId: `m7ap-watcher-${run}`, profile: 'pc' });
    const w = await conn.rpc({ type: 'queue.watch', projects: 'all' }).catch((e) => ({ type: 'error', reason: errText(e) }));
    return { hello: h?.type, watch: w?.type };
  };
  const first = await reg();
  conn.ep.onOpen(() => { reg().catch(() => {}); });
  return { conn, bodies, closed, events, first, close: () => conn.close() };
}

/* ================================================================== creator */

async function runCreator(book, head) {
  const out = path.resolve(arg('--out', fs.mkdtempSync(path.join(os.tmpdir(), 'pc-m7ap-'))));
  fs.mkdirSync(out, { recursive: true });
  const bind = arg('--bind', '127.0.0.1');
  const publicHost = arg('--public-host', '127.0.0.1');
  const REMOTE = arg('--site', null);
  let coord = arg('--coord', REMOTE ? REMOTE.replace(/\/+$/, '') + '/coord' : null);
  let ownCoord = null;
  if (!coord) {
    ownCoord = await startCoord({ port: PORTS.coord, host: bind, mailToken: process.env.PROBE_MAIL_TOKEN || null });
    coord = `http://${publicHost}:${ownCoord.port}`;
    say('coord.up', { coord });
  }
  const run = await resolveRun({ coord, prefix: PREFIX, run: arg('--run'), isCreator: true, newRun: newRunId, deadline, log: say });
  Object.assign(head, { run, out });
  const kv = roleKv({ coord, prefix: PREFIX, run, role: 'creator', log: say });
  for (const k of ['VITE_PC_ONLINE', 'PROMPTCUT_CARD_SYNC']) delete process.env[k];
  const secrets = new Set();
  const cleanups = [];
  const ctx = { run, out, kv, secrets, book };
  let nodeResult = null;
  try {
    const M = await mods();
    const site = REMOTE ? await remoteSite(REMOTE) : await startSite({ out, bind, publicHost });
    cleanups.push(() => site.stop());
    ctx.site = site;
    const t0 = Date.now();

    /* ---------------------------------------------------------------- 项目：A 建、上传夹具 */
    const name = `m7ap-${run}`;
    const creator = { username: 'creator', password: randomBytes(12).toString('base64url') };
    const projectPassword = randomBytes(12).toString('base64url');
    const created = await M.createSharedProject({ where: 'hosted', hostedUrl: site.ws, name, mode: 'free', creator, password: projectPassword });
    const projectId = created.projectId;
    ctx.projectId = projectId;
    ctx.creator = creator;
    ctx.projectPassword = projectPassword;
    const aConn = await openConn({ url: site.ws, projectId, username: creator.username, password: creator.password, as: 'creator', role: 'page', device: deviceOf('A', run), tag: 'A', log: say });
    cleanups.push(() => aConn.close());
    ctx.aConn = aConn;
    ctx.doc = projectDoc(projectId);
    ctx.rev = await putProject(aConn, projectId, ctx.doc, run);
    say('project', { projectId, rev: ctx.rev });

    /* ---------------------------------------------------------------- A 的桌面编辑器 = pc 节点（测试指纹、只切分，D15） */
    ctx.pcFp = fingerprintOf(`m7ap-pc-${run}`);
    const editorDir = path.join(out, 'editor');
    fs.mkdirSync(editorDir, { recursive: true });
    const sharedConfig = path.join(editorDir, 'shared.json');
    fs.writeFileSync(sharedConfig, JSON.stringify([{ url: site.ws, projectId, username: creator.username, password: creator.password, as: 'creator', role: 'render',
      deviceId: deviceOf('pc', run), deviceName: 'm7ap A 的桌面' }]));
    const startEditor = async (planOnly) => {
      for (const d of ['card-overrides', 'projects', 'work']) fs.mkdirSync(path.join(editorDir, d), { recursive: true });
      const e = await startQueueEditor({ port: PORTS.editor, dir: editorDir, sharedConfig, fakeFingerprint: ctx.pcFp, band: BAND, extraEnv: {
        PROMPTCUT_CARD_OVERRIDES: path.join(editorDir, 'card-overrides'), PROMPTCUT_PROJECTS_DIR: path.join(editorDir, 'projects'), PROMPTCUT_WORK_DIR: path.join(editorDir, 'work'),
        PROMPTCUT_DEVICE_ID: deviceOf('pc', run), PROMPTCUT_DEVICE_NAME: 'm7ap A 的桌面', ...(planOnly ? { PROMPTCUT_TEST_PLAN_ONLY: '1' } : {}) } });
      const q = await e.waitActive();
      return { e, q };
    };
    ctx.startEditor = startEditor;
    let ed = await startEditor(true);
    ctx.editor = ed;
    cleanups.push(() => ctx.editor?.e?.stop());
    const fpApplied = ed.q.envFingerprint === ctx.pcFp;
    say('editor.up', { envFingerprint: ed.q.envFingerprint, fpApplied, ms: Date.now() - t0 });
    ctx.pcNodeId = ed.q.nodeId ?? null;

    const watcher = await startWatcher({ url: site.ws, projectId, cred: creator, run, log: say });
    cleanups.push(() => watcher.close());
    ctx.watcher = watcher;
    const god = site.remote ? remoteGodView(watcher) : startGodView(site);
    cleanups.push(() => god.stop());
    ctx.god = god;
    ctx.assetHas = await assetHasFactory(ctx);

    /* ---------------------------------------------------------------- 给 node 角色的配置 */
    const users = {
      b1: { username: 'B', deviceId: deviceOf('b1', run) },
      b2: { username: 'B', deviceId: deviceOf('b2', run) },
      low: { username: 'B-low', deviceId: deviceOf('low', run) },
      single: { username: 'B-single', deviceId: deviceOf('single', run) },
    };
    ctx.users = users;
    await kv.config({ run, site: site.site, stageOrigins: site.stageOrigins, projectName: name, projectId, projectPassword, users, pcFp: ctx.pcFp, at: Date.now(),
      a10: !flag('--no-a10') });
    const ready = await until(async () => (await kv.get('ready.node', 0).catch(() => null)) ?? ((await kv.aborted()) ? { aborted: true } : null), Math.max(1000, deadline - Date.now()), 1000);
    if (ready?.aborted) throw new Error('node 角色中止了（见 node-crash）');
    if (!ready) throw new Error('node 角色没报 ready');
    ctx.ready = ready;
    say('node.ready', { pageFp: ready.pageFp, isNode: ready.isNode ?? null });

    /* ---------------------------------------------------------------- 服务端一侧的真判（替身） */
    await serverChecks(ctx);

    const pn = await waitSignal(kv, 'page.node');
    ctx.pageNode = pn;
    const isNode = !!pn?.isNode;
    // 页面播放 10 秒（A12）时不改项目，免得重灌打扰计时
    await waitSignal(kv, 'node.play-done');

    if (isNode) {
      await pageServerSide(ctx);

    }
    else {
      for (const id of ['M7-A3', 'M7-A4', 'M7-A8', 'M7-A9', 'M7-A10']) book.pending(id, 'server', NODE_PENDING, { browserNodes: god.browserNodes().map((n) => ({ profile: n.profile, userId: n.userId })) });
      if (!flag('--no-twin')) await twinChecks(ctx);
      else book.pending('D1-D2-D12', 'twin', '--no-twin');
    }
    if (ctx.site.remote) book.pending('M7-A11', 'server-logs-describe', '外网模式看不到托管端的日志与 describe()（在阿里云上另查）');
    else book.judge('M7-A11', 'server-logs-describe', !scanLeaks(ctx).found, scanLeaks(ctx));
    head.planDump = await dumpPlans(ctx);
    await kv.signal('creator.finished', {});
    await kv.done({});
    nodeResult = await kv.takeResult('node', deadline);
    if (nodeResult?.items) book.merge(nodeResult.items);
    else book.part('W7', 'node-result', 'fail', { reason: 'node 角色没交结果行' });
    // W7：跨机（D17）；M7-A1、A2、A3 过；M7-A4 的计时在笔记本判
    const sum = book.summary().items;
    const where = { creator: os.hostname(), node: ready.host ?? null, bind, publicHost, timingAuthoritative: !!ready.timingAuthoritative };
    if (where.node && where.node !== where.creator) book.judge('W7', 'cross-machine', true, where);
    else book.pending('W7', 'cross-machine', '本机替身（两个角色在同一台机器上），真跨机待复核（D17）', where);
    for (const id of ['M7-A1', 'M7-A2', 'M7-A3']) {
      const st = sum[id]?.status ?? 'pending';
      if (st === 'pending') book.pending('W7', id, `${id} 还有待定的部分`);
      else book.judge('W7', id, st === 'pass', { mirror: id });
    }
    const a4t = sum['M7-A4']?.parts?.['page-within-30s'];
    if (!where.timingAuthoritative) book.pending('W7', 'A4-timing-on-laptop', '计时在笔记本判：这一轮 node 角色没带 --timing-authoritative', { reference: a4t ?? null });
    else if (!a4t || a4t.status === 'pending') book.pending('W7', 'A4-timing-on-laptop', 'M7-A4 的计时这一轮没判出来', a4t ?? null);
    else book.judge('W7', 'A4-timing-on-laptop', a4t.status === 'pass', a4t.detail);
    Object.assign(head, { projectId, pcFp: ctx.pcFp, pcFpApplied: fpApplied, pageFp: ready.pageFp ?? null, pageNode: pn ?? null,
      planOnly: planOnlyState(ctx), godPolls: god.polls, nodesSeen: [...god.nodes.values()].map((n) => ({ profile: n.profile, userId: n.userId?.replace(/@.*/, '@…'), fp: n.envFingerprint, claimsMax: n.claimsMax })) });
  } catch (error) {
    book.part('W7', 'creator-crash', 'fail', { error: errText(error), stack: String(error?.stack ?? '').split('\n').slice(0, 6).join(' | ') });
    say('creator-crash', { error: errText(error), stack: String(error?.stack ?? '').split('\n').slice(0, 6).join(' | ') });
    await kv.abort(errText(error));
  } finally {
    for (const c of cleanups.reverse()) { try { await c(); } catch { /* 收尾出错不影响结论 */ } }
    await ownCoord?.stop();
    if (!flag('--keep-temp')) { try { fs.rmSync(path.join(out, 'hosted'), { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* Windows 句柄 */ } }
  }
  return nodeResult;
}

/** 日志、describe、代理收到的地址里有没有票据样子的串（契约第 5 节、第 7 节；A11） */
function scanLeaks(ctx) {
  const hits = [];
  const known = [...ctx.secrets];
  const look = (where, text) => {
    const s = String(text ?? '');
    if (TICKET_RE.test(s) || known.some((t) => s.includes(t))) hits.push(where);
  };
  for (const l of ctx.site?.logs ?? []) look('server-log', l);
  try { look('describe', JSON.stringify(ctx.site.combo.service.describe())); } catch { /* 取不到 */ }
  for (const u of ctx.site?.urls ?? []) look('url', u);
  return { found: hits.length > 0, where: [...new Set(hits)], ticketsKnown: known.length, logLines: ctx.site?.logs?.length ?? 0, urls: ctx.site?.urls?.length ?? 0 };
}

/* ---------------------------------------------------------------- 服务端一侧：E5（A1、A2）、B2（A3）、D9、D10、D14 */

async function serverChecks(ctx) {
  const { site, projectId, book, run, secrets, kv } = ctx;
  const M = await mods();
  const cv = `m7ap-cv-${run}`;
  ctx.fakeCv = cv;
  const url = site.ws;
  const pw = ctx.projectPassword;
  const member = (username, tag) => openConn({ url, projectId, username, password: pw, as: 'member', role: 'page', device: deviceOf(tag, run), tag, log: say });
  const closers = [];
  try {
    /* ---- 替身：B 的纯浏览器（sB）、与 A 同名不同设备（sS），只看不领 */
    const bPage = await member('B', 'sB'); closers.push(() => bPage.close());
    const sPage = await member(ctx.creator.username, 'sS').catch((e) => ({ error: errText(e) }));
    if (sPage.error) book.judge('M7-A1', 'server-same-name-join', false, { reason: '与 A 同名、不同设备进不了项目', error: sPage.error });
    else closers.push(() => sPage.close());
    const sB = await startStandin({ url, pageConn: bPage, tag: 'sB', env: standinEnv(901), secrets, projects: [projectId], codeVersions: [cv], mode: 'observe', log: say });
    closers.push(() => sB.stop());
    const sS = sPage.error ? null : await startStandin({ url, pageConn: sPage, tag: 'sS', env: standinEnv(902), secrets, projects: [projectId], codeVersions: [cv], mode: 'observe', log: say });
    if (sS) closers.push(() => sS.stop());

    /* ---- D10：welcome 回的指纹 = 服务端按原始值算的；自报的不作数；不报原始值回 bad-message */
    const fpOf = (env) => M.describeEnvironment({ platform: env.platform, renderer: env.renderer, vendor: env.vendor, chromeVersion: env.userAgent }).fingerprint;
    const d10 = { welcome: sB.rec.welcome?.envFingerprint ?? null, expected: fpOf(sB.env) };
    const fPage = await member('B', 'sF'); closers.push(() => fPage.close());
    const fRender = await openBrowserRender({ url, pageConn: fPage, tag: 'sF', secrets, log: say }); closers.push(() => fRender.close());
    const envF = standinEnv(905);
    const hF = await hello(fRender, { nodeId: `m7ap-sF-${run}`, profile: 'browser', environment: envF, envFingerprint: 'ffffffffffffffff', codeVersions: [cv] });
    d10.selfReported = { type: hF?.type, envFingerprint: hF?.envFingerprint ?? null, expected: fpOf(envF) };
    const nPage = await member('B', 'sN'); closers.push(() => nPage.close());
    const nRender = await openBrowserRender({ url, pageConn: nPage, tag: 'sN', secrets, log: say }); closers.push(() => nRender.close());
    const hN = await hello(nRender, { nodeId: `m7ap-sN-${run}`, profile: 'browser', envFingerprint: fpOf(envF) });
    d10.noEnvironment = { type: hN?.type, reason: hN?.reason ?? null };
    book.judge('D10', 'welcome-fingerprint', d10.welcome === d10.expected, d10);
    book.judge('D10', 'self-reported-ignored', d10.selfReported.type === 'node.welcome' && d10.selfReported.envFingerprint === d10.selfReported.expected, d10.selfReported);
    book.judge('D10', 'browser-without-environment', d10.noEnvironment.type === 'error' && d10.noEnvironment.reason === 'bad-message', d10.noEnvironment);

    /* ---- D14：非 Chromium 内核报到回 not-chromium */
    const d14 = {};
    for (const [k, ua] of Object.entries(UA)) {
      const p = await member('B', `s14${k}`); closers.push(() => p.close());
      const rr = await openBrowserRender({ url, pageConn: p, tag: `s14${k}`, secrets, log: say }); closers.push(() => rr.close());
      const h = await hello(rr, { nodeId: `m7ap-s14${k}-${run}`, profile: 'browser', environment: standinEnv(0, { ua }) });
      const w = await rr.rpc({ type: 'queue.watch', projects: [projectId] }).catch((e) => ({ type: 'timeout', reason: errText(e) }));
      d14[k] = { hello: h?.type, reason: h?.reason ?? null, watchAfter: w?.type === 'error' ? w.reason : w?.type };
    }
    book.judge('D14', 'non-chromium-refused', Object.values(d14).every((x) => x.hello === 'error' && x.reason === 'not-chromium' && x.watchAfter !== 'queue.snapshot'), d14);

    /* ---- D9：浏览器凭证以 pc 报到 forbidden、不登记；nodeId 绑第一次报到的 userId */
    const d9 = {};
    const pPage = await member('B', 'sP'); closers.push(() => pPage.close());
    const pRender = await openBrowserRender({ url, pageConn: pPage, tag: 'sP', secrets, log: say }); closers.push(() => pRender.close());
    for (const profile of ['pc', 'host']) {
      const h = await hello(pRender, { nodeId: `m7ap-sP-${profile}-${run}`, profile, environment: standinEnv(906), codeVersions: [cv] });
      const w = await pRender.rpc({ type: 'queue.watch', projects: [projectId] }).catch((e) => ({ type: 'timeout', reason: errText(e) }));
      d9[`as-${profile}`] = { hello: h?.type, reason: h?.reason ?? null, watchAfter: w?.type === 'error' ? w.reason : w?.type };
    }
    book.judge('D9', 'browser-credential-as-pc-host', ['pc', 'host'].every((p) => d9[`as-${p}`].hello === 'error' && d9[`as-${p}`].reason === 'forbidden' && d9[`as-${p}`].watchAfter !== 'queue.snapshot'), d9);
    // 别的用户拿 sB 的 nodeId 报到（浏览器凭证 / A 的桌面凭证）
    const xPage = await member('X', 'sX'); closers.push(() => xPage.close());
    const xRender = await openBrowserRender({ url, pageConn: xPage, tag: 'sX', secrets, log: say }); closers.push(() => xRender.close());
    const hx = await hello(xRender, { nodeId: sB.nodeId, profile: 'browser', environment: standinEnv(907) });
    const aRender = await openConn({ url, projectId, username: ctx.creator.username, password: ctx.creator.password, as: 'creator', role: 'render', device: deviceOf('aR', run), tag: 'aR', log: say });
    closers.push(() => aRender.close());
    const ha = await hello(aRender, { nodeId: sB.nodeId, profile: 'pc', envFingerprint: fingerprintOf('x') });
    const wb = await sB.render.rpc({ type: 'queue.watch', projects: [projectId] }).catch((e) => ({ type: 'timeout', reason: errText(e) }));
    d9.bindOtherBrowser = { hello: hx?.type, reason: hx?.reason ?? null };
    d9.bindOtherDesktop = { hello: ha?.type, reason: ha?.reason ?? null };
    d9.originalStillWorks = wb?.type;
    book.judge('D9', 'nodeId-bound-to-userId', hx?.type === 'error' && hx.reason === 'forbidden' && ha?.type === 'error' && ha.reason === 'forbidden' && wb?.type === 'queue.snapshot', d9);

    /* ---- A1 / A2：A 一整轮发布、认领、完成；替身 B 与同名不同设备收到 A 的任务消息 0 条 */
    const pageFp = ctx.ready?.pageFp ?? null;
    const aPub = await openConn({ url, projectId, username: ctx.creator.username, password: ctx.creator.password, as: 'creator', role: 'page', device: deviceOf('Apub', run), tag: 'Apub', log: say });
    closers.push(() => aPub.close());
    await aPub.rpc({ type: 'publisher.hello', publisherId: `m7ap-Apub-${run}` });
    const mk = (tag, n, requires, extra = {}) => Array.from({ length: n }, (_, i) => {
      const resultKey = sha(`m7ap-${run}-${tag}-${i}`).repeat(4);
      const range = { unit: 'localFrame', from: 0, to: 59 };
      return { id: M.taskIdOf({ kind: 'snapshot', resultKey, range }), kind: 'snapshot', tier: 'shared', resultKey, range, source: { projectId, projectRev: ctx.rev },
        input: { clipId: `fake-${tag}-${i}`, cardId: 'probe-slow-stepped', entryKey: null, contentKey: sha(`ck-${run}-${tag}-${i}`).repeat(4), canvasHeavy: false, compositing: 'independent' },
        weight: { class: 'light', estMs: null, frames: 60 }, requires: { codeVersion: cv, cardSources: {}, transcode: false, userCards: false, graphCards: false, belowDependent: false, ...requires }, priority: 10, ...extra };
    });
    // 第一批：不带指纹（前置过滤不挡，只剩「只见本人」一道）+ 带 sB / sS / 页面的指纹
    const batch1 = [...mk('a1', 4, {}), ...mk('a1b', 2, { envFingerprint: sB.fp }), ...(sS ? mk('a1s', 2, { envFingerprint: sS.fp }) : []), ...(pageFp ? mk('a1p', 2, { envFingerprint: pageFp }) : [])];
    const aPlan = M.clipsPlanTaskOf({ projectId, projectRev: 900_000 + Math.floor(Math.random() * 1000), clips: ['m7ap-a-plan'], codeVersion: cv });
    // A 的假节点：host 档、不带指纹（看得见全部），codeVersion 同假任务；把第一批做完
    // A 的假节点：host 档，每种指纹一个（节点侧过滤规则 1 要指纹相同；不带指纹的节点只接不带指纹的任务），codeVersion 同假任务
    const fpGroups = [...new Set(batch1.map((t) => t.requires.envFingerprint ?? null))];
    const aWorkers = [];
    for (const [i, fp] of fpGroups.entries()) {
      const w = await startFakeWorker({ url, projectId, cred: ctx.creator, tag: `Awork${i}`, run, fp, codeVersions: [cv], pick: (t) => (t.requires?.envFingerprint ?? null) === fp && t.requires?.codeVersion === cv, log: say });
      aWorkers.push(w);
      closers.push(() => w.stop());
    }
    const tA1 = Date.now();
    await kv.signal('a1.start', { at: tA1 });
    const pubRes = await aPub.rpc({ type: 'task.publish', tasks: batch1 });
    const aIds = new Set(batch1.map((t) => t.id));
    const allDone = await until(() => [...aIds].every((id) => ctx.god.tasks.get(id)?.state === 'done'), 90_000, 250);
    for (const w of aWorkers) await w.stop();
    // A 的计划任务（B 认领应回 forbidden）与第三批（A 的节点已停，任务保持 open，给 A2 认领用）
    const batch3 = mk('a3', 3, {});
    await aPub.rpc({ type: 'task.publish', tasks: [...batch3, aPlan] });
    for (const t of [...batch3, aPlan]) aIds.add(t.id);
    await delay(1500);
    const aMsgs = (st) => st.rec.recv.filter(({ at, m }) => at >= tA1 && (
      (m?.type === 'queue.snapshot' && (m.tasks ?? []).some((t) => aIds.has(t.id)))
      || (m?.type === 'task.opened' && aIds.has(m.task?.id))
      || ((m?.type === 'task.taken' || m?.type === 'task.closed') && aIds.has(m.id))));
    const a1 = { published: pubRes?.type, tasks: batch1.length, allDone: !!allDone, doneMs: allDone ? Date.now() - tA1 : null, sB: aMsgs(sB).length, sS: sS ? aMsgs(sS).length : null,
      watcherSaw: [...aIds].filter((id) => ctx.watcher.bodies.has(id)).length };
    book.judge('M7-A1', 'server-B-other-user', a1.allDone && a1.sB === 0 && a1.watcherSaw > 0, a1);
    if (sS) book.judge('M7-A1', 'server-same-name-other-device', a1.allDone && a1.sS === 0, { sS: a1.sS, userIdDiffers: `${ctx.creator.username}@${deviceOf('sS', run)}` !== aPub.userId });
    await kv.signal('a1.done', { ids: [...aIds], at: Date.now() });

    // A2：B 拿 A 的任务 id 认领一律 forbidden（不带 state / version）；认领 A 的 plan 同样 forbidden；B 自己的 plan 回 plan-profile
    const claimRaw = async (st, id) => {
      const before = st.render.all.length;
      st.render.ep.send({ type: 'task.claim', id, expectVersion: ctx.god.tasks.get(id)?.version ?? 1 });
      const got = await until(() => st.render.all.slice(before).map((x) => x.m).find((m) => (m?.type === 'task.claim-rejected' || m?.type === 'task.claimed' || m?.type === 'error') && (m.id === id || m.id === undefined)), 10_000, 50);
      return got ? { type: got.type, reason: got.reason ?? null, hasState: 'state' in got, hasVersion: 'version' in got } : { type: 'timeout' };
    };
    const a2 = { otherTasks: [], otherPlan: null, ownPlan: null };
    for (const t of batch3) a2.otherTasks.push(await claimRaw(sB, t.id));
    a2.otherPlan = await claimRaw(sB, aPlan.id);
    await bPage.rpc({ type: 'publisher.hello', publisherId: `m7ap-Bpub-${run}` });
    const bPlan = M.clipsPlanTaskOf({ projectId, projectRev: 910_000 + Math.floor(Math.random() * 1000), clips: ['m7ap-b-plan'], codeVersion: cv });
    await bPage.rpc({ type: 'task.publish', tasks: [bPlan] });
    await delay(500);
    a2.ownPlan = await claimRaw(sB, bPlan.id);
    const forb = (x) => x.type === 'task.claim-rejected' && x.reason === 'forbidden' && !x.hasState && !x.hasVersion;
    book.judge('M7-A2', 'server-claim-other-user-forbidden', a2.otherTasks.length > 0 && a2.otherTasks.every(forb) && forb(a2.otherPlan), a2);
    book.judge('M7-A2', 'server-own-plan-plan-profile', a2.ownPlan.type === 'task.claim-rejected' && a2.ownPlan.reason === 'plan-profile', a2.ownPlan);
    book.judge('M7-A2', 'server-d9-browser-as-pc-forbidden', d9['as-pc'].hello === 'error' && d9['as-pc'].reason === 'forbidden', d9['as-pc']);

    /* ---- A3（B2）：本人任务里各放 heavy、流、plan、本地档、用户卡、改过源码的卡、非独立卡；跑满 A3_MS */
    const qPage = await member('B', 'sQ'); closers.push(() => qPage.close());
    await qPage.rpc({ type: 'publisher.hello', publisherId: `m7ap-Qpub-${run}` });
    const sQ = await startStandin({ url, pageConn: qPage, tag: 'sQ', env: standinEnv(903), secrets, projects: [projectId], codeVersions: [cv], mode: 'work', log: say });
    closers.push(() => sQ.stop());
    const fpQ = sQ.fp;
    const cls = {};
    const add = (name, tasks) => { cls[name] = tasks; return tasks; };
    const base = (tag, n, requires = {}, extra = {}) => mk(`q-${tag}`, n, { envFingerprint: fpQ, ...requires }, extra);
    add('light', base('light', 2));
    add('medium', base('medium', 2, {}, { weight: { class: 'medium', estMs: null, frames: 60 } }));
    add('heavy', base('heavy', 2, {}, { weight: { class: 'heavy', estMs: null, frames: 60 } }));
    add('local', base('local', 2, {}, { tier: 'local' }));
    add('userCard', base('user', 2, { userCards: true }));
    add('graphCard', base('graph', 1, { graphCards: true }));
    add('modifiedCard', base('mod', 2, { cardSources: { 'probe-slow-stepped': 'user:deadbeef' } }));
    add('notIndependent', base('dep', 2, {}, { input: { clipId: 'fake-dep', cardId: 'chapter-bar', entryKey: null, contentKey: sha(`dep-${run}`).repeat(4), canvasHeavy: false, compositing: 'belowDependent' } }));
    const streamRk = sha(`m7ap-${run}-stream`).repeat(4);
    add('stream', [{ id: M.taskIdOf({ kind: 'stream', resultKey: streamRk, range: { unit: 'segment', from: 0, to: 0 } }), kind: 'stream', resultKey: streamRk, range: { unit: 'segment', from: 0, to: 0 },
      source: { projectId, projectRev: ctx.rev }, input: { clipId: 'fake-stream', cardId: null, entryKey: null, contentKey: sha(`st-${run}`).repeat(4) },
      weight: { class: 'medium', estMs: null, frames: 60 }, requires: { envFingerprint: fpQ, codeVersion: cv, cardSources: {}, transcode: true, userCards: false, graphCards: false, belowDependent: false }, priority: 10 }]);
    add('plan', [M.clipsPlanTaskOf({ projectId, projectRev: 920_000 + Math.floor(Math.random() * 1000), clips: ['m7ap-q-plan'], codeVersion: cv })]);
    const all3 = Object.values(cls).flat();
    const tA3 = Date.now();
    const pub3 = await qPage.rpc({ type: 'task.publish', tasks: all3 });
    const pubErrors = (pub3?.results ?? []).filter((x) => x.error).map((x) => `${x.id.slice(0, 24)}…:${x.error}`);
    await delay(A3_MS);
    const claimedBy = (id) => (ctx.god.tasks.get(id)?.claimedBy ?? []).map((c) => c.nodeId);
    const perClass = Object.fromEntries(Object.entries(cls).map(([k, ts]) => [k, {
      tasks: ts.length,
      claimedBySq: ts.filter((t) => claimedBy(t.id).includes(sQ.nodeId) || sQ.rec.claimedIds.includes(t.id)).length,
      claimsSent: sQ.rec.sent.filter((s) => s.type === 'task.claim' && ts.some((t) => t.id === s.id)).length,
      done: ts.filter((t) => ctx.god.tasks.get(t.id)?.state === 'done').length,
    }]));
    const forbiddenClasses = ['heavy', 'local', 'userCard', 'graphCard', 'modifiedCard', 'notIndependent', 'stream', 'plan'];
    const a3 = { seconds: Math.round((Date.now() - tA3) / 1000), perClass, publishErrors: pubErrors, fp: fpQ };
    book.judge('M7-A3', 'server-standin-forbidden-claimed-0', pubErrors.length === 0 && forbiddenClasses.every((k) => perClass[k].claimedBySq === 0 && perClass[k].claimsSent === 0), a3);
    book.judge('M7-A3', 'server-standin-light-medium-done', ['light', 'medium'].every((k) => perClass[k].done === perClass[k].tasks && perClass[k].claimedBySq === perClass[k].tasks), { light: perClass.light, medium: perClass.medium });
    ctx.a3Classes = cls;
  } catch (error) {
    book.part('W7', 'server-checks-crash', 'fail', { error: errText(error), stack: String(error?.stack ?? '').split('\n').slice(0, 5).join(' | ') });
  } finally {
    for (const c of closers.reverse()) { try { await c(); } catch { /* 忽略 */ } }
  }
}

/* ---------------------------------------------------------------- 页面没当节点时：以页面的身份起替身，真判 D1 双份出键、建锁作废、D2 接手、D12 层表 v3 */

async function twinChecks(ctx) {
  const { site, projectId, book, run, secrets, god, watcher, users } = ctx;
  const M = await mods();
  const { layerRefOf, layerCandidates } = await (async () => { await import('../../src/testing/registerTs.mjs'); return import('../../src/render/snapshotSource.ts'); })();
  const closers = [];
  try {
    // 页面（b1）的身份：同用户名、同设备 → 同一个 userId；指纹用替身自己的（Chrome 904），与页面、pc 都不同
    const tPage = await openConn({ url: site.ws, projectId, username: users.b1.username, password: ctx.projectPassword, as: 'member', role: 'page', device: users.b1.deviceId, tag: 'twin', log: say });
    closers.push(() => tPage.close());
    const pageCv = [...watcher.bodies.values()].find((t) => t.kind === 'plan' && t.source?.userId === `${users.b1.username}@${users.b1.deviceId}`)?.requires?.codeVersion ?? null;
    const twin = await startStandin({ url: site.ws, pageConn: tPage, tag: 'twin', env: standinEnv(904), secrets, projects: [projectId], codeVersions: pageCv ? [pageCv] : [], mode: 'observe', log: say });
    closers.push(() => twin.stop());
    ctx.twin = twin;
    say('twin.up', { fp: twin.fp, codeVersion: pageCv, welcome: twin.rec.welcome?.type ?? null });
    if (!twin.rec.welcome) { book.judge('D1-D2-D12', 'twin-hello', false, twin.rec.errors); return; }
    if (!pageCv) { book.pending('D1-D2-D12', 'dual-split', '没看到页面发布的清单计划（取不到页面的 codeVersion）', { plans: [...watcher.bodies.values()].filter((t) => t.kind === 'plan').length }); return; }
    // 代 D15 的「只切分」开关（服务端还没有）：替 pc 以空清单吃掉非双份的细任务，pc 空着才能及时认领新计划去切分。
    // 双份（input.dual）的一律不碰：它们是这里要判的「先认领者得卡」
    const absorber = await startFakeWorker({ url: site.ws, projectId, cred: ctx.creator, tag: 'absorb', run, fp: ctx.pcFp, codeVersions: [pageCv],
      pick: (t) => t.kind === 'snapshot' && t.requires?.envFingerprint === ctx.pcFp && t.input?.dual !== true && !['h4', 'h5'].includes(t.input?.clipId), log: say });
    closers.push(() => absorber.stop());
    const planList = () => [...watcher.bodies.values()].filter((t) => t.kind === 'plan' && t.source?.userId !== undefined && Number(t.source?.projectRev) < 900_000).map((t) => ({
      rev: t.source?.projectRev, user: String(t.source?.userId ?? '').split('@')[0], clips: t.input?.clips ?? null, state: god.tasks.get(t.id)?.state ?? null,
      claimedBy: (god.tasks.get(t.id)?.claimedBy ?? []).map((c) => (c.nodeId === ctx.pcNodeId ? 'pc' : c.nodeId.slice(0, 16))) }));

    // 加一张新重卡 h4，让页面测完、重发清单计划（此时本项目有同一用户的在线纯浏览器节点：替身）
    for (const clip of ['h4', 'h5']) {
      twin.setGrab((t) => t.input?.clipId === clip);
      const extra = [[clip, 'probe-slow-stepped', { burnMs: 40, label: clip }]];
      ctx.rev = await addCards(ctx.aConn, projectId, extra, run);
      const tEdit = Date.now();
      const tasksOf = () => [...watcher.bodies.values()].filter((t) => t.kind === 'snapshot' && t.input?.clipId === clip);
      const split = await until(() => { const ts = tasksOf(); const fps = new Set(ts.map((t) => t.requires?.envFingerprint)); return fps.size >= 2 ? ts : null; }, 240_000, 500);
      const ts = tasksOf();
      const byFp = {};
      for (const t of ts) (byFp[t.requires?.envFingerprint ?? '-'] ??= []).push(t);
      const pcCopy = byFp[ctx.pcFp] ?? [];
      const twinCopy = byFp[twin.fp] ?? [];
      const d1 = {
        clip, msAfterEdit: split ? Date.now() - tEdit : null, fps: Object.fromEntries(Object.entries(byFp).map(([k, v]) => [k, v.length])),
        allDual: ts.length > 0 && ts.every((t) => t.input?.dual === true),
        twinHasBake: twinCopy.length > 0 && twinCopy.every((t) => t.input?.compositing === 'independent' && t.input?.bake && ['start', 'end', 'count', 'sampling'].every((k) => k in t.input.bake)),
        pcHasNoBake: pcCopy.every((t) => !t.input?.bake),
        sameRanges: JSON.stringify(pcCopy.map((t) => `${t.range.from}-${t.range.to}:${t.priority}`).sort()) === JSON.stringify(twinCopy.map((t) => `${t.range.from}-${t.range.to}:${t.priority}`).sort()),
        userIdOfTwinCopy: [...new Set(twinCopy.map((t) => t.source?.userId === `${users.b1.username}@${users.b1.deviceId}`))],
        weights: [...new Set(ts.map((t) => t.weight?.class))],
      };
      if (!split) {
        book.judge('D1-D2-D12', `dual-split-${clip}`, false, { ...d1, reason: '切分方没按两种指纹出键（等了 240 s）', planOnly: planOnlyState(ctx), plans: planList().slice(-6), absorbed: absorber.done.length });
        continue;
      }
      d1.plans = planList().slice(-3);
      d1.absorbed = absorber.done.length;
      book.judge('D1-D2-D12', `dual-split-${clip}`, d1.allDual && d1.twinHasBake && d1.pcHasNoBake && d1.sameRanges && pcCopy.length > 0 && twinCopy.length > 0 && d1.userIdOfTwinCopy.every(Boolean), d1);

      // 建锁作废：先认领者得卡，另一份（open 的）进 failed / superseded
      const won = await until(() => twin.grabbed ?? (pcCopy.some((t) => god.tasks.get(t.id)?.claimedBy?.length) ? 'pc' : null), 60_000, 100);
      await delay(2000);
      const loserIds = won === 'pc' ? twinCopy.map((t) => t.id) : pcCopy.map((t) => t.id);
      const stateOf = (id) => ({ state: god.tasks.get(id)?.state ?? null, lastError: god.tasks.get(id)?.lastError ?? null, attempts: god.tasks.get(id)?.attempts ?? null });
      const losers = loserIds.map(stateOf);
      const lockKey = `snapshot:${ts[0].input.contentKey}`;
      book.judge('D1-D2-D12', `supersede-${clip}`, !!won && losers.length > 0 && losers.every((x) => x.state === 'failed' && (god.remote || (/superseded/.test(String(x.lastError)) && x.attempts === 0))),
        { winner: won === 'pc' ? 'pc' : won ? 'twin' : null, losers: losers.slice(0, 6), lock: god.lockOf(lockKey)?.envFingerprint ?? null });

      // D12：层表 v3，这一层带两个候选（切分方自己的在前），layerRefOf 按 alive 整份换
      const lm = await until(async () => {
        const body = await contentGet(ctx.aConn, `layers:${projectId}`);
        const l = body?.layers?.find((x) => x.clipId === clip);
        return l && (l.candidates ?? []).length >= 2 ? body : null;
      }, 90_000, 1000);
      const layer = lm?.layers?.find((x) => x.clipId === clip);
      const cands = layer ? layerCandidates(layer) : [];
      const twinRk = twinCopy[0]?.resultKey;
      const pcRk = pcCopy[0]?.resultKey;
      const pickTwin = lm ? layerRefOf(lm, clip, { alive: new Set([twinRk]) }) : null;
      const pickPc = lm ? layerRefOf(lm, clip, { alive: new Set([pcRk]) }) : null;
      const d12 = {
        v: lm?.v ?? null, candidates: cands.map((c) => ({ fp: c.envFingerprint, rkIsTwin: c.resultKey === twinRk, rkIsPc: c.resultKey === pcRk })),
        topEqualsFirst: !!layer && layer.resultKey === layer.candidates?.[0]?.resultKey && layer.envFingerprint === layer.candidates?.[0]?.envFingerprint,
        pickTwin: pickTwin ? { fp: pickTwin.envFingerprint, rk: pickTwin.resultKey === twinRk } : null,
        pickPc: pickPc ? { fp: pickPc.envFingerprint, rk: pickPc.resultKey === pcRk } : null,
      };
      // 候选的先后不判：同一次切分两份都发时切分方自己的在前；锁已在浏览器那份上、只出了它的那一次切分，
      // 切分方自己的指纹补在末尾（rq-m7-queue 报告「与契约的出入」第 6 条）。层表写几次、读到哪一次看时机，只记下来
      d12.firstIsSplitter = cands[0]?.envFingerprint === ctx.pcFp;
      book.judge('D1-D2-D12', `layer-map-v3-${clip}`, d12.v === 3 && cands.length >= 2 && cands.some((c) => c.envFingerprint === ctx.pcFp) && cands.some((c) => c.envFingerprint === twin.fp)
        && d12.topEqualsFirst && d12.pickTwin?.fp === twin.fp && d12.pickTwin.rk && d12.pickPc?.fp === ctx.pcFp && d12.pickPc.rk, d12);

      // D2：替身先得锁、放回、闲置 > 30 s 后有人发布新计划 → 切分方带 takeover 按自己的指纹接手整张卡，替身那份作废
      if (won !== 'pc' && twin.grabbed) {
        twin.setMode('observe');
        const idleFrom = twin.grabbed.at;
        await sleepUntil(idleFrom + 33_000);
        const lockBefore = god.lockOf(lockKey)?.envFingerprint ?? null;
        // 改一处与这张卡无关的地方（轻卡的参数）→ 版本变了 → 页面防抖后重发清单计划 → 切分方重切
        ctx.rev = await touchLight(ctx.aConn, projectId, run);
        const took = await until(() => (god.lockOf(lockKey)?.envFingerprint === ctx.pcFp ? god.lockOf(lockKey) : null), 180_000, 500);
        const twinLeft = twinCopy.map((t) => stateOf(t.id));
        book.judge('D1-D2-D12', `idle-takeover-${clip}`, !!took && twinLeft.every((x) => x.state === 'failed' || x.state === 'done'),
          { lockBefore, lockAfter: god.lockOf(lockKey)?.envFingerprint ?? null, lockHistory: god.lockOf(lockKey)?.history ?? null, idleMs: Date.now() - idleFrom, twinCopy: twinLeft.slice(0, 6) });
        break;
      }
      book.pending('D1-D2-D12', `idle-takeover-${clip}`, 'pc 先得了这张卡的锁，接手测不了（换下一张再试）', { winner: 'pc' });
    }
  } catch (error) {
    book.part('D1-D2-D12', 'twin-crash', 'fail', { error: errText(error), stack: String(error?.stack ?? '').split('\n').slice(0, 5).join(' | ') });
  } finally {
    for (const c of closers.reverse()) { try { await c(); } catch { /* 忽略 */ } }
  }
}

/**
 * 诊断：本项目全部计划任务的去向（主会话 2026-09-28 追问「低内存页的补渲计划为什么一直 open」）。
 * 每个计划：清单种类（#clips / #backfill）、档、requires、状态、认领过它的节点；按 pc 节点的描述跑一遍节点侧过滤与挑选；
 * pc 诊断里的认领记录、持有、闲时门槛、最近事件。全文写进 <out>/plan-dump.json，结果行里放摘要。
 */
async function dumpPlans(ctx) {
  const M = await mods();
  const { pickCandidate } = await import('../../server/render-node/pick.mjs');
  const pcDiag = await ctx.editor?.e?.queue().catch(() => null);
  const pcNode = { nodeId: pcDiag?.nodeId ?? ctx.pcNodeId, profile: 'pc', envFingerprint: ctx.pcFp, codeVersions: pcDiag?.codeVersion ? [pcDiag.codeVersion] : [], capabilities: {}, editing: false };
  const shortUser = (u) => String(u ?? '').split('@')[0] || null;
  const plans = [...ctx.watcher.bodies.values()].filter((t) => t.kind === 'plan' && Number(t.source?.projectRev) < 900_000).map((t) => {
    const g = ctx.god.tasks.get(t.id);
    return { id: t.id.replace(/^plan:[^@]+/, 'plan:<项目>'), kind: t.resultKey.includes('#backfill:') ? 'backfill' : t.resultKey.includes('#clips:') ? 'clips' : 'desktop', priority: t.priority,
      user: shortUser(t.source?.userId), rev: t.source?.projectRev, clips: t.input?.clips ?? null, requires: { ...t.requires, codeVersion: t.requires?.codeVersion ? `${t.requires.codeVersion.slice(0, 8)}…` : undefined },
      state: g?.state ?? null, attempts: g?.attempts ?? null, lastError: g?.lastError ?? null, states: (g?.states ?? []).map((x) => x.state),
      claimedBy: (g?.claimedBy ?? []).map((c) => (c.nodeId === pcNode.nodeId ? 'pc' : c.nodeId.slice(0, 20))),
      pcFilter: M.checkClaimable({ ...t, state: 'open' }, pcNode) };
  });
  const openForPc = [...ctx.watcher.bodies.values()].filter((t) => ctx.god.tasks.get(t.id)?.state === 'open' && (t.requires?.envFingerprint == null || t.requires.envFingerprint === ctx.pcFp));
  const claimable = M.filterClaimable(openForPc.map((t) => ({ ...t, version: ctx.god.tasks.get(t.id)?.version ?? 1 })), pcNode);
  const band = (t) => (t.priority === 'backfill' ? 'backfill' : 'normal');
  const pcView = { openVisible: openForPc.length, claimable: claimable.length, claimableByBand: claimable.reduce((m, t) => ((m[band(t)] = (m[band(t)] ?? 0) + 1), m), {}),
    claimableNormal: claimable.filter((t) => band(t) === 'normal').slice(0, 8).map((t) => ({ id: t.id.slice(0, 40), kind: t.kind, user: shortUser(t.source?.userId), clip: t.input?.clipId ?? null, lastError: ctx.god.tasks.get(t.id)?.lastError ?? null, attempts: ctx.god.tasks.get(t.id)?.attempts ?? null })),
    wouldPick: (() => { const p = pickCandidate(claimable, { random: () => 0 }); return p ? { id: p.id.slice(0, 40), kind: p.kind, band: band(p) } : null; })() };
  const pc = pcDiag ? { held: pcDiag.held, running: pcDiag.running, idle: pcDiag.idle, stats: pcDiag.stats, claims: (pcDiag.claims ?? []).slice(-12).map((c) => ({ id: String(c.id).slice(0, 40), priority: c.priority })),
    events: (pcDiag.events ?? []).filter((e) => /claim|reject|plan|split|lock|fail|lost|release|yield/i.test(e.event)).slice(-30).map((e) => JSON.stringify(e).slice(0, 300)) } : null;
  const full = { plans, pcView, pc, pcNode: { ...pcNode, codeVersions: pcNode.codeVersions.map((v) => `${v.slice(0, 8)}…`) } };
  try { fs.writeFileSync(path.join(ctx.out, 'plan-dump.json'), JSON.stringify({ ...full, pcDiagRaw: pcDiag }, null, 1)); } catch { /* 写不了 */ }
  return full;
}

/** D15 的「只切分、不认领细任务」开关生效没有：pc 认领过细任务就是没生效 */
function planOnlyState(ctx) {
  const pc = ctx.pcNodeId ?? [...ctx.god.nodes.values()].find((n) => n.envFingerprint === ctx.pcFp && n.profile === 'pc')?.nodeId;
  const fine = [...ctx.god.tasks.values()].filter((t) => !t.id.startsWith('plan:') && t.claimedBy.some((c) => c.nodeId === pc)).length;
  const plans = [...ctx.god.tasks.values()].filter((t) => t.id.startsWith('plan:') && t.claimedBy.some((c) => c.nodeId === pc)).length;
  ctx.planOnly = { pcNodeId: pc ?? null, fineClaimedByPc: fine, plansClaimedByPc: plans, applied: fine === 0 };
  return ctx.planOnly;
}


/**
 * D1-D2-D12 在真页面上判（页面当了节点时；不起同身份替身，免得与真页面抢）。在 M7-A4 之后、M7-A10 之前判：
 * 之后 pc 要重启、任务过了 DONE_TTL 会被回收，那时的切分没有浏览器、层表只剩 pc（队列方第二轮查明）。
 * 判据（主会话 2026-09-28）：h1～h3 每张卡都出了双份（pc 指纹、页面指纹，都 dual，页面那份带 bake 与 independent）；
 * 每张卡恰好有一份被作废（先认领的是谁都行：宿主全开时 pc 先得卡也合契约），被作废那份的全部段都是 superseded；
 * 层表 v3 这一层两个候选（pc、页面）都在。
 */
async function judgeDualOnPage(ctx) {
  const { book, god, watcher } = ctx;
  const lm = await contentGet(ctx.aConn, `layers:${ctx.projectId}`);
  const pageFp = ctx.pageNode?.envFingerprint ?? null;
  const sup = (t) => god.tasks.get(t.id)?.state === 'failed' && (god.remote || /superseded/.test(String(god.tasks.get(t.id)?.lastError)));
  const perClip = {};
  for (const clip of ['h1', 'h2', 'h3']) {
    const ts = [...watcher.bodies.values()].filter((t) => t.kind === 'snapshot' && t.input?.clipId === clip);
    const copies = { pc: ts.filter((t) => t.requires?.envFingerprint === ctx.pcFp), page: ts.filter((t) => t.requires?.envFingerprint === pageFp) };
    const superseded = Object.entries(copies).filter(([, list]) => list.length > 0 && list.every(sup)).map(([k]) => k);
    const cands = lm?.layers?.find((l) => l.clipId === clip)?.candidates ?? [];
    perClip[clip] = {
      pc: copies.pc.length, page: copies.page.length,
      allDual: ts.length > 0 && ts.every((t) => t.input?.dual === true),
      pageHasBake: copies.page.length > 0 && copies.page.every((t) => t.input?.compositing === 'independent' && t.input?.bake),
      superseded, partlySuperseded: Object.entries(copies).filter(([, list]) => list.some(sup) && !list.every(sup)).map(([k]) => k),
      candidates: cands.map((c) => (c.envFingerprint === ctx.pcFp ? 'pc' : c.envFingerprint === pageFp ? 'page' : c.envFingerprint)),
    };
  }
  book.judge('D1-D2-D12', 'page-dual-split-supersede-layermap', lm?.v === 3 && Object.values(perClip).every((x) => x.pc > 0 && x.page > 0 && x.allDual && x.pageHasBake
    && x.superseded.length === 1 && x.partlySuperseded.length === 0 && x.candidates.includes('pc') && x.candidates.includes('page')), { v: lm?.v ?? null, perClip });
}

/* ---------------------------------------------------------------- 页面当了节点：服务端那一侧 */

async function pageServerSide(ctx) {
  const { book, god, watcher, kv, users, projectId } = ctx;
  const M = await mods();
  const userB1 = `${users.b1.username}@${users.b1.deviceId}`;
  const pageNode = () => god.browserNodes().find((n) => n.userId === userB1) ?? (god.remote && ctx.pageNode?.nodeId ? { nodeId: ctx.pageNode.nodeId, profile: 'browser', envFingerprint: ctx.pageNode.envFingerprint, remoteInferred: true } : null);
  const pn = pageNode();
  const pageFp = pn?.envFingerprint ?? ctx.pageNode?.envFingerprint ?? null;
  book.judge('M7-A3', 'server-page-node-registered', !!pn && pn.profile === 'browser', { node: pn ? { profile: pn.profile, fp: pn.envFingerprint } : null });

  // 后台应答 node 角色的两个请求：A11 在服务端结束 b1 的 render 会话（票据过期后）；A10 加一张新重卡 z1
  (async () => {
    const req = await waitSignal(kv, 'a11.end-render');
    if (!req) return;
    if (ctx.site.remote) { await kv.signal('a11.ended', { closed: false, reason: '外网模式在服务端结束不了那条会话（阿里云上另用托管端的测试钩子验）' }); return; }
    const conns = (ctx.site.combo.service.describe()?.conns ?? []).filter((c) => c.principal?.userId === `${users.b1.username}@${req.deviceId}` && (c.principal?.role === 'render' || c.node));
    for (const c of conns) ctx.site.combo.service.closeConn(c.connId, 1001, 'm7ap-ticket-expiry');
    await kv.signal('a11.ended', { closed: conns.length > 0, conns: conns.length, code: 1001, reason: conns.length ? null : '找不到 b1 的 render 连接' });
  })().catch((e) => say('a11.responder-error', { error: errText(e) }));
  (async () => {
    const req = await waitSignal(kv, 'a10.want-z');
    if (!req) return;
    ctx.rev = await addCards(ctx.aConn, projectId, [['z1', 'probe-slow-stepped', { burnMs: 40, label: 'z1' }]], ctx.run);
  })().catch((e) => say('a10.responder-error', { error: errText(e) }));

  /* ---- A3 页面：本人任务里放禁收的各类（页面的指纹、页面的代码版本），60 s 内页面节点认领 0 次 */
  const pageCv = [...watcher.bodies.values()].find((t) => t.kind === 'plan' && t.source?.userId === userB1)?.requires?.codeVersion ?? null;
  const bPub = await openConn({ url: ctx.site.ws, projectId, username: users.b1.username, password: ctx.projectPassword, as: 'member', role: 'page', device: users.b1.deviceId, tag: 'b1pub', log: say });
  await bPub.rpc({ type: 'publisher.hello', publisherId: `m7ap-b1pub-${ctx.run}` });
  const forbidden = [];
  const mkF = (tag, requires = {}, extra = {}) => {
    const resultKey = sha(`m7ap-${ctx.run}-pf-${tag}`).repeat(4);
    const range = { unit: 'localFrame', from: 0, to: 59 };
    const t = { id: M.taskIdOf({ kind: 'snapshot', resultKey, range }), kind: 'snapshot', tier: 'shared', resultKey, range, source: { projectId, projectRev: ctx.rev },
      input: { clipId: `fake-${tag}`, cardId: 'probe-slow-stepped', entryKey: null, contentKey: sha(`pf-${ctx.run}-${tag}`).repeat(4), canvasHeavy: false, compositing: 'independent', bake: { start: 0, end: 2, count: 60, sampling: {} } },
      weight: { class: 'medium', estMs: null, frames: 60 }, requires: { envFingerprint: pageFp, codeVersion: pageCv, cardSources: {}, transcode: false, userCards: false, graphCards: false, belowDependent: false, ...requires }, priority: 50, ...extra };
    forbidden.push({ tag, t });
  };
  mkF('heavy', {}, { weight: { class: 'heavy', estMs: null, frames: 60 } });
  mkF('local', {}, { tier: 'local' });
  mkF('user', { userCards: true });
  mkF('graph', { graphCards: true });
  mkF('modified', { cardSources: { 'probe-slow-stepped': 'user:deadbeef' } });
  mkF('dependent', {}, { input: { clipId: 'fake-dep', cardId: 'chapter-bar', entryKey: null, contentKey: sha(`pfdep-${ctx.run}`).repeat(4), canvasHeavy: false, compositing: 'belowDependent' } });
  const srk = sha(`m7ap-${ctx.run}-pf-stream`).repeat(4);
  forbidden.push({ tag: 'stream', t: { id: M.taskIdOf({ kind: 'stream', resultKey: srk, range: { unit: 'segment', from: 0, to: 0 } }), kind: 'stream', resultKey: srk, range: { unit: 'segment', from: 0, to: 0 },
    source: { projectId, projectRev: ctx.rev }, input: { clipId: 'fake-stream', cardId: null, entryKey: null, contentKey: sha(`pfst-${ctx.run}`).repeat(4) }, weight: { class: 'medium', estMs: null, frames: 60 },
    requires: { envFingerprint: pageFp, codeVersion: pageCv, cardSources: {}, transcode: true, userCards: false, graphCards: false, belowDependent: false }, priority: 50 } });
  forbidden.push({ tag: 'plan', t: M.clipsPlanTaskOf({ projectId, projectRev: 930_000 + Math.floor(Math.random() * 1000), clips: ['m7ap-pf-plan'], codeVersion: `${pageCv}-x` }) });
  const tF = Date.now();
  const pubF = await bPub.rpc({ type: 'task.publish', tasks: forbidden.map((x) => x.t) }).catch((e) => ({ error: errText(e) }));
  await delay(A3_MS);
  await kv.signal('a3.forbidden', { ids: forbidden.map((x) => [x.tag, x.t.id]), from: tF, to: Date.now() });
  const claimedByPage = forbidden.filter((x) => (god.tasks.get(x.t.id)?.claimedBy ?? []).some((c) => c.nodeId === pn?.nodeId)).map((x) => x.tag);
  if (god.remote) book.pending('M7-A3', 'server-page-forbidden-claimed-0', '外网模式看不到认领者（由 node 角色的 page-forbidden-claimed-0 判）', { publishErrors: (pubF?.results ?? []).filter((r) => r.error).length });
  else book.judge('M7-A3', 'server-page-forbidden-claimed-0', claimedByPage.length === 0 && !pubF?.error, { seconds: Math.round((Date.now() - tF) / 1000), claimedByPage, publishErrors: (pubF?.results ?? []).filter((r) => r.error).length });
  await bPub.close();

  /* ---- A4 服务端：三张重卡的锚帧段由纯浏览器认领并完成；清单、snap/、层表 */
  const a4 = await waitSignal(kv, 'a4.page');
  const browserTasks = [...watcher.bodies.values()].filter((t) => t.kind === 'snapshot' && ['h1', 'h2', 'h3'].includes(t.input?.clipId) && t.requires?.envFingerprint === pageFp);
  const anchors = browserTasks.filter((t) => t.priority === 50);
  const hasAll = async (ns, frames) => { for (const f of frames ?? []) if (!(await ctx.assetHas(ns, f[1]))) return false; return true; };
  const perClip = {};
  const manifests = [];
  for (const clip of ['h1', 'h2', 'h3']) {
    const as = anchors.filter((t) => t.input.clipId === clip);
    const rows = [];
    for (const t of as) {
      const g = god.tasks.get(t.id);
      const man = await contentGet(ctx.aConn, `${t.resultKey}:${t.range.from}-${t.range.to}`);
      if (man) manifests.push({ t, man });
      rows.push({ id: t.id.slice(0, 20), state: g?.state ?? null, byPage: god.remote ? (a4?.completedIds ?? []).includes(t.id) : (g?.claimedBy ?? []).some((c) => c.nodeId === pn?.nodeId), manifest: !!man,
        snapAll: !!man && (await hasAll('snap', man.frames)), frames: man?.frames?.length ?? 0 });
    }
    perClip[clip] = rows;
  }
  const lm = await contentGet(ctx.aConn, `layers:${projectId}`);
  const layerPoint = Object.fromEntries(['h1', 'h2', 'h3'].map((c) => [c, (lm?.layers?.find((l) => l.clipId === c)?.candidates ?? []).some((x) => x.envFingerprint === pageFp)]));
  book.judge('M7-A4', 'server-anchors-by-browser', Object.values(perClip).every((rows) => rows.length > 0 && rows.every((r) => r.state === 'done' && r.byPage && r.manifest && r.snapAll)), { perClip, pageSignal: a4 ?? null });
  book.judge('M7-A4', 'server-layer-map-points-to-browser', Object.values(layerPoint).every(Boolean), { v: lm?.v ?? null, layerPoint });

  /* ---- A8：清单过 manifestMatches；同一层所有帧的指纹相同；每个任务恰好一次 done；桌面成员取回（pc 的 applyResult） */
  const bad = manifests.filter(({ t, man }) => !M.manifestMatches(man, { kind: 'snapshot', resultKey: t.resultKey, range: t.range }));
  book.judge('M7-A8', 'server-manifest-matches', manifests.length > 0 && bad.length === 0, { manifests: manifests.length, bad: bad.map(({ t }) => t.id.slice(0, 24)) });
  const lockPurity = {};
  for (const clip of ['h1', 'h2', 'h3']) {
    const done = [...watcher.bodies.values()].filter((t) => t.kind === 'snapshot' && t.input?.clipId === clip && god.tasks.get(t.id)?.state === 'done');
    lockPurity[clip] = [...new Set(done.map((t) => t.requires?.envFingerprint))];
  }
  book.judge('M7-A8', 'server-one-env-per-layer', Object.values(lockPurity).every((fps) => fps.length === 1), lockPurity);
  const doneEvents = watcher.events.filter((e) => e.type === 'task.closed' && e.state === 'done');
  const dupDone = Object.entries(doneEvents.reduce((m, e) => ((m[e.id] = (m[e.id] ?? 0) + 1), m), {})).filter(([, n]) => n > 1);
  book.judge('M7-A8', 'server-exactly-once-done', dupDone.length === 0, { doneEvents: doneEvents.length, dup: dupDone.slice(0, 5) });
  const pcDiag = await ctx.editor.e.queue().catch(() => null);
  book.judge('M7-A8', 'server-desktop-applied', (pcDiag?.stats?.applied ?? 0) > 0 && (pcDiag?.stats?.applyErrors ?? 0) === 0, { applied: pcDiag?.stats?.applied ?? null, fetched: pcDiag?.stats?.fetched ?? null, applyErrors: pcDiag?.stats?.applyErrors ?? null });

  /* ---- A9 服务端：浏览器产的每一帧都有 px/ 的 WebP */
  const smallRows = [];
  for (const { t, man } of manifests) smallRows.push({ id: t.id.slice(0, 20), frames: man.frames?.length ?? 0, small: man.small?.length ?? 0, pxAll: await hasAll('px', man.small) });
  book.judge('M7-A9', 'server-every-frame-has-px', smallRows.length > 0 && smallRows.every((r) => r.small === r.frames && r.pxAll), smallRows);

  /* ---- D1-D2-D12：A4 之后、A10 之前判（见 judgeDualOnPage） */
  await judgeDualOnPage(ctx);

  /* ---- A10：宿主全开时谁先谁得卡；浏览器认领后关页、锁闲置 > 30 s、有人发布计划 → pc 接手整张卡 */
  if (flag('--no-a10')) { book.pending('M7-A10', 'server', '--no-a10'); return; }
  const z = await waitSignal(kv, 'a10.page-closed');
  if (!z?.clip) { book.pending('M7-A10', 'server', 'node 角色没报「页面拿着一段后关掉」', z); return; }
  const lockKeyZ = [...watcher.bodies.values()].find((t) => t.input?.clipId === z.clip)?.input?.contentKey;
  await sleepUntil((z.at ?? Date.now()) + 33_000);
  // 宿主全开（重启 A 的编辑器、不设只切分）；这时本项目没有 B 的在线纯浏览器节点（b1 已关、b2 还没开），
  // 改一处（轻卡参数）→ 还开着的页面（single：普通档单舞台，照发清单计划）重发计划 → pc 切分：z 的锁闲置超 30 s、没做完 → 接手
  await ctx.editor.e.stop();
  ctx.editor = await ctx.startEditor(false);
  // 「下一次有人发布计划」：再开 b2（B 的另一台设备，普通档，会发清单计划、也当节点）
  await kv.signal('a10.open-b2', { at: Date.now() });
  await waitSignal(kv, 'a10.b2-ready');
  // 「下一次有人发布计划」要是新的一版：只开 b2 时版本没变，它发的清单计划与 b1 那一版同 id、已 done，队列只回 task.done，
  // 没人重新切分，也就不会接手（契约第 3.4 节：接手只在有人重新切分时发生）。改一处轻卡参数，让页面按新版本重发
  ctx.rev = await touchLight(ctx.aConn, projectId, ctx.run);
  const pcDoneZ = () => [...watcher.bodies.values()].filter((t) => t.kind === 'snapshot' && t.input?.clipId === z.clip && t.requires?.envFingerprint === ctx.pcFp && god.tasks.get(t.id)?.state === 'done');
  const tTake = Date.now();
  const took = await until(() => (god.lockOf(`snapshot:${lockKeyZ}`)?.envFingerprint === ctx.pcFp || pcDoneZ().length > 0 ? { lock: god.lockOf(`snapshot:${lockKeyZ}`)?.envFingerprint ?? null, pcDone: pcDoneZ().length } : null), 600_000, 1000);
  book.judge('M7-A10', 'server-idle-takeover', !!took, { clip: z.clip, took, takeoverMs: took ? Date.now() - tTake : null, lockHistory: god.lockOf(`snapshot:${lockKeyZ}`)?.history ?? null, plans: [...watcher.bodies.values()].filter((t) => t.kind === 'plan').slice(-4).map((t) => ({ user: String(t.source?.userId ?? '').split('@')[0], rev: t.source?.projectRev, clips: t.input?.clips, state: god.tasks.get(t.id)?.state })) });
  // 宿主全开、b2 在线时加两张新卡：两份任务谁先谁得卡、每张卡只出自一种环境
  ctx.rev = await addCards(ctx.aConn, projectId, [['w1', 'probe-slow-stepped', { burnMs: 40, label: 'w1' }], ['w2', 'probe-slow-stepped', { burnMs: 40, label: 'w2' }]], ctx.run);
  const race = {};
  for (const clip of ['w1', 'w2']) {
    await until(() => [...watcher.bodies.values()].some((t) => t.input?.clipId === clip && god.tasks.get(t.id)?.state === 'done'), 300_000, 1000);
    const done = [...watcher.bodies.values()].filter((t) => t.kind === 'snapshot' && t.input?.clipId === clip && god.tasks.get(t.id)?.state === 'done');
    race[clip] = [...new Set(done.map((t) => t.requires?.envFingerprint))];
  }
  book.judge('M7-A10', 'server-race-one-env-per-card', Object.values(race).every((fps) => fps.length === 1), race);
  await kv.signal('a10.server-done', { race, took: !!took });
}

/* ================================================================== node：页面一侧 */

/**
 * CDP 抓一页的全部 WebSocket：握手头（子协议）、收发的业务消息。票据、会话号只留在内存里（查泄漏、认连接的角色），不输出。
 * 连接的角色：握手子协议里的票据负载 `r`（render / page …）与 `o.kind`；接续的连接按会话号认回原来的角色；
 * 认不出的，发过 `node.hello` 的算 render。
 */
async function tapPage(page, name) {
  const M = await mods();
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  const conns = new Map();
  const frames = [];
  const sidRole = new Map();
  const secrets = new Set();
  const leaks = [];
  const noteLeak = (where, s) => { if (TICKET_RE.test(String(s)) || [...secrets].some((t) => String(s).includes(t))) leaks.push(where); };
  cdp.on('Network.webSocketCreated', ({ requestId, url }) => {
    conns.set(requestId, { requestId, createdAt: Date.now(), role: null, owner: null, echoed: null, offered: [], closedAt: null, kind: null });
    noteLeak('ws-url', url);
  });
  cdp.on('Network.webSocketWillSendHandshakeRequest', ({ requestId, request }) => {
    const c = conns.get(requestId) ?? { requestId, createdAt: Date.now() };
    const h = Object.fromEntries(Object.entries(request?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const items = String(h['sec-websocket-protocol'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    for (const it of items) {
      if (it.startsWith('promptcut.ticket.')) {
        const t = it.slice('promptcut.ticket.'.length);
        secrets.add(t);
        const p = (() => { try { return M.ticketPayload(t); } catch { return null; } })();
        c.role = p?.r ?? c.role; c.owner = p?.o?.kind ?? c.owner; c.kind = 'ticket';
      } else if (it === 'promptcut.session.new') c.session = 'new';
      else if (it.startsWith('promptcut.session.')) { const sid = it.slice('promptcut.session.'.length).replace(/\.\d+$/, ''); c.resumeOf = sid; c.role = c.role ?? sidRole.get(sid)?.role ?? null; c.owner = c.owner ?? sidRole.get(sid)?.owner ?? null; }
      else if (it.startsWith('promptcut.auth.')) c.kind = c.kind ?? 'auth';
    }
    c.offered = items.map((it) => (it.startsWith('promptcut.ticket.') ? 'promptcut.ticket.<票据>' : it.startsWith('promptcut.session.') && it !== 'promptcut.session.new' ? 'promptcut.session.<会话号>' : it.startsWith('promptcut.auth.') ? 'promptcut.auth.<凭证>' : it));
    conns.set(requestId, c);
  });
  cdp.on('Network.webSocketHandshakeResponseReceived', ({ requestId, response }) => {
    const c = conns.get(requestId);
    if (!c) return;
    const h = Object.fromEntries(Object.entries(response?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    c.echoed = h['sec-websocket-protocol'] ?? null;
    c.status = response?.status ?? null;
  });
  cdp.on('Network.webSocketClosed', ({ requestId }) => { const c = conns.get(requestId); if (c) c.closedAt = Date.now(); });
  const onFrame = (dir) => ({ requestId, response }) => {
    const text = response?.payloadData;
    if (typeof text !== 'string' || text.length > 4_000_000 || text[0] !== '{') return;
    let m;
    try { m = JSON.parse(text); } catch { return; }
    const c = conns.get(requestId);
    if (m.type === 'session.welcome' && typeof m.sid === 'string') sidRole.set(m.sid, { role: c?.role ?? null, owner: c?.owner ?? null });
    if (m.type === 'auth.ticket.ok' && typeof m.ticket === 'string') { secrets.add(m.ticket); return; }
    if (dir === 'sent' && m.type === 'node.hello' && c && !c.role) c.role = 'render';
    const keep = /^(node\.|queue\.|task\.|error$|auth\.ticket$|publisher\.)/.test(m.type ?? '');
    if (!keep) return;
    const slim = { at: Date.now(), dir, conn: requestId, type: m.type, id: m.id ?? m.task?.id ?? null, reqId: m.reqId ?? null };
    if (m.reason !== undefined) slim.reason = m.reason;
    if (m.state !== undefined) slim.state = m.state;
    if (m.type === 'node.hello') Object.assign(slim, { profile: m.profile, nodeId: m.nodeId, hasEnvironment: !!m.environment, maxConcurrent: m.maxConcurrent, codeVersions: m.codeVersions });
    if (m.type === 'node.welcome') Object.assign(slim, { envFingerprint: m.envFingerprint ?? null, nodeId: m.nodeId ?? null });
    if (m.type === 'queue.watch') slim.projects = m.projects;
    if (m.type === 'queue.snapshot') slim.tasks = (m.tasks ?? []).map((t) => ({ id: t.id, userId: t.source?.userId ?? null }));
    if (m.type === 'task.opened') slim.userId = m.task?.source?.userId ?? null;
    if (m.type === 'task.progress') slim.done = m.done ?? null;
    if (m.type === 'task.claimed' && m.task) slim.task = { priority: m.task.priority, clipId: m.task.input?.clipId ?? null, fp: m.task.requires?.envFingerprint ?? null, resultKey: m.task.resultKey, range: m.task.range, weight: m.task.weight?.class ?? null, attempts: m.task.attempts ?? null };
    if (m.type === 'task.complete' && m.result) slim.result = { resultKey: m.result.resultKey, range: m.result.range, frames: m.result.frames?.length ?? null, small: m.result.small?.length ?? null, dedup: m.result.dedup ?? null };
    if (m.type === 'auth.ticket') Object.assign(slim, { kind: m.kind, role: m.role ?? null, owner: m.owner?.kind ?? null, access: m.access ?? null });
    frames.push(slim);
    if (frames.length > 200_000) frames.shift();
  };
  cdp.on('Network.webSocketFrameSent', onFrame('sent'));
  cdp.on('Network.webSocketFrameReceived', onFrame('recv'));
  cdp.on('Network.requestWillBeSent', ({ request }) => noteLeak('http-url', request?.url ?? ''));
  const renderConns = () => [...conns.values()].filter((c) => c.role === 'render' || frames.some((f) => f.conn === c.requestId && f.type === 'node.hello'));
  return {
    name, cdp, conns, frames, secrets, leaks,
    renderConns,
    sent: (type, since = 0) => frames.filter((f) => f.dir === 'sent' && f.type === type && f.at >= since),
    recv: (type, since = 0) => frames.filter((f) => f.dir === 'recv' && f.type === type && f.at >= since),
    /** 页面当了节点：发过 node.hello 且收到 node.welcome */
    nodeState() {
      const h = frames.find((f) => f.dir === 'sent' && f.type === 'node.hello');
      const w = frames.find((f) => f.dir === 'recv' && f.type === 'node.welcome');
      return { hello: h ?? null, welcome: w ?? null, isNode: !!h && !!w };
    },
  };
}

async function launchBrowser(cfg) {
  const { default: puppeteer } = await import('puppeteer');
  const origins = [cfg.site, ...cfg.stageOrigins];
  const loopback = origins.every((o) => /^https:\/\//.test(o) || /^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(o));
  const exe = arg('--chrome', process.env.PUPPETEER_EXECUTABLE_PATH || null);
  return puppeteer.launch({
    headless: !flag('--headful'), protocolTimeout: 900_000, defaultViewport: { width: 1600, height: 1000 },
    ...(exe ? { executablePath: exe } : {}),
    args: [...(process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []), '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required', '--disable-gpu',
      ...(flag('--headful') ? [] : ['--window-position=-32000,-32000']),
      // 跨机（W7）时站点是局域网的 http：WebCrypto 等要安全上下文，按测试源放行（只放行这三个源）
      ...(loopback ? [] : [`--unsafely-treat-insecure-origin-as-secure=${origins.join(',')}`])],
  });
}

/** 开一个成员页：预置设备身份（同一 userId 才能由 creator 以同一身份发布本人任务）、可选低内存档 / 退回单舞台，凭项目名与口令进入 */
async function openMember(browser, cfg, key, { lowMem = false, single = false } = {}) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('dialog', (d) => void d.accept());
  page.pageErrors = [];
  page.on('pageerror', (e) => page.pageErrors.push(String(e?.message ?? e).slice(0, 200)));
  const tap = await tapPage(page, key);
  const u = cfg.users[key];
  await page.evaluateOnNewDocument((dev, low) => {
    if (window.top !== window) return;
    try {
      if (location.pathname.startsWith('/editor')) {
        localStorage.setItem('pc.online.device', JSON.stringify(dev));
        if (low) localStorage.setItem('pc.device.displayTier', 'low');
      }
    } catch { /* 存不了 */ }
    window.__m7LongTasks = [];
    try {
      new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__m7LongTasks.push({ at: performance.timeOrigin + e.startTime, ms: e.duration }); }).observe({ type: 'longtask', buffered: true });
    } catch { /* 没有 longtask */ }
  }, { deviceId: u.deviceId, deviceName: `m7ap ${key}` }, lowMem);
  if (single) {
    await page.setRequestInterception(true);
    page.on('request', (r) => {
      if (r.isInterceptResolutionHandled()) return;
      if (r.url().endsWith('/editor/runtime-config.json')) return void r.respond({ status: 404, contentType: 'text/plain', body: 'no stages' });
      void r.continue();
    });
  }
  await page.goto(`${cfg.site}/editor`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  const typeInto = async (sel, text) => {
    await page.waitForSelector(sel, { visible: true, timeout: 60_000 });
    await page.click(sel, { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await page.type(sel, text, { delay: 3 });
  };
  await typeInto('[data-pc="join-name"]', cfg.projectName);
  await typeInto('[data-pc="join-password"]', cfg.projectPassword);
  await typeInto('[data-pc="join-username"]', u.username);
  await page.click('[data-pc="join-submit"]');
  const joined = await page.waitForSelector('[data-pc="members-button"]', { visible: true, timeout: 120_000 }).then(() => true, () => false);
  if (!joined) {
    const msg = await page.$eval('[data-pc="join-message"]', (el) => el.textContent).catch(() => null);
    throw new Error(`${key} 没进项目：${msg}`);
  }
  // 加载遮罩：出现又撤下（低内存档过渡期不测，可能根本不出现：members 在、2 s 内没有遮罩就算撤下）
  let seen = false;
  let quietSince = null;
  const lifted = await until(async () => {
    const g = await page.evaluate(() => !!document.querySelector('[data-pc="probe-gate"]')).catch(() => true);
    if (g) { seen = true; quietSince = null; return null; }
    quietSince ??= Date.now();
    return seen || Date.now() - quietSince > 2000 ? Date.now() : null;
  }, 600_000, 100);
  return { key, ctx, page, tap, gateSeen: seen, gateLiftAt: lifted ? (seen ? lifted : lifted - 2000) : null, user: u };
}

const P = (page, fn, ...a) => page.evaluate(fn, ...a);
const previewDiag = (page) => P(page, () => { try { return JSON.parse(JSON.stringify(window.__pcPreviewDiag?.() ?? null)); } catch { return null; } }).catch(() => null);
const onlineDiag = (page) => P(page, () => { try { return JSON.parse(JSON.stringify(window.__pcOnlineSnapshots?.() ?? null)); } catch { return null; } }).catch(() => null);
const longTasks = (page, since) => P(page, (s) => (window.__m7LongTasks ?? []).filter((x) => x.at >= s), since).catch(() => null);
/** 页面内快照库的 snapshots 表条数（C10 的 `promptcut-l2`） */
const l2Snapshots = (page) => P(page, () => new Promise((resolve) => {
  const r = indexedDB.open('promptcut-l2');
  r.onerror = () => resolve(null);
  r.onsuccess = () => {
    const db = r.result;
    if (!db.objectStoreNames.contains('snapshots')) { db.close(); return resolve(null); }
    const q = db.transaction('snapshots', 'readonly').objectStore('snapshots').count();
    q.onsuccess = () => { db.close(); resolve(q.result); };
    q.onerror = () => { db.close(); resolve(null); };
  };
})).catch(() => null);

/** 在页面上算指纹（同 c10-browser-probe：WebGL 原始值 → describeEnvironment） */
async function pageFingerprint(page) {
  const M = await mods();
  const e = await P(page, () => {
    const c = document.createElement('canvas').getContext('webgl');
    const ext = c?.getExtension('WEBGL_debug_renderer_info');
    return { platform: navigator.platform, renderer: ext ? c.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '', vendor: ext ? c.getParameter(ext.UNMASKED_VENDOR_WEBGL) : '', ua: navigator.userAgent };
  }).catch(() => null);
  return e ? M.describeEnvironment({ platform: e.platform, renderer: e.renderer, vendor: e.vendor, chromeVersion: e.ua }).fingerprint : null;
}

/** 时间轴标尺上按住拖 ms 毫秒（真鼠标事件，同 playback-probe） */
async function dragRuler(page, ms) {
  const ruler = await page.$('[data-pc="ruler"]');
  const box = ruler ? await ruler.boundingBox() : null;
  if (!box) return { ok: false, reason: '没有 [data-pc="ruler"]' };
  const y = box.y + box.height / 2;
  const x = (f) => box.x + box.width * f;
  const t0 = Date.now();
  await page.mouse.move(x(0.2), y);
  await page.mouse.down();
  let i = 0;
  while (Date.now() - t0 < ms) { await page.mouse.move(x(0.2 + 0.6 * ((i++ % 20) / 20)), y); await delay(50); }
  await page.mouse.up();
  return { ok: true, startedAt: t0, endedAt: Date.now() };
}

/** 让页面隐藏：同一窗口另开一个标签并切过去；回 { hidden, restore() } */
async function hidePage(page) {
  const other = await page.browserContext().newPage();
  await other.goto('about:blank');
  await other.bringToFront();
  const hidden = await until(() => P(page, () => document.visibilityState === 'hidden').catch(() => false), 5000, 50);
  return { hidden: !!hidden, at: Date.now(), async restore() { await page.bringToFront(); await other.close().catch(() => {}); } };
}

async function runNode(book, head) {
  const coord = arg('--coord', arg('--site') ? arg('--site').replace(/\/+$/, '') + '/coord' : null);
  if (!coord) { book.part('W7', 'args', 'fail', { reason: 'node 要给 --coord（或 --site，协调口取 <站点>/coord）' }); process.exitCode = 2; return; }
  const run = await resolveRun({ coord, prefix: PREFIX, run: arg('--run'), isCreator: false, newRun: newRunId, deadline, log: say });
  Object.assign(head, { run });
  const kv = roleKv({ coord, prefix: PREFIX, run, role: 'node', log: say });
  const authoritative = flag('--timing-authoritative');
  head.timingAuthoritative = authoritative;
  head.host = os.hostname();
  let browser = null;
  try {
    const cfg = await kv.takeConfig(deadline);
    if (!cfg) throw new Error('没等到 creator 的 config');
    browser = await launchBrowser(cfg);
    // b1：普通档（节点候选）；low：低内存档；single：退回单舞台
    const b1 = await openMember(browser, cfg, 'b1');
    const pageFp = await pageFingerprint(b1.page);
    const [low, single] = await Promise.all([openMember(browser, cfg, 'low', { lowMem: true }), openMember(browser, cfg, 'single', { single: true })]);
    const d1 = await previewDiag(b1.page);
    await kv.ready({ pageFp, host: os.hostname(), timingAuthoritative: authoritative, gateLiftAt: b1.gateLiftAt, dual: d1?.dual ?? null });
    say('pages.up', { pageFp, gate: b1.gateSeen, dual: d1?.dual ?? null });

    // 页面当节点了没有：线上看 node.hello + node.welcome；诊断钩子只作对照
    const nodeUp = await until(() => (b1.tap.nodeState().isNode ? b1.tap.nodeState() : null), NODE_WAIT_MS, 250);
    const diag0 = await readNodeDiag(b1.page);
    const ns = b1.tap.nodeState();
    const isNode = !!nodeUp;
    await kv.signal('page.node', { isNode, nodeId: ns.hello?.nodeId ?? null, envFingerprint: ns.welcome?.envFingerprint ?? null, gateLiftAt: b1.gateLiftAt, diag: { available: diag0.available, state: diag0.state ?? null, reason: diag0.reason ?? null } });
    head.pageNode = { isNode, waitedMs: NODE_WAIT_MS, diag: diag0, welcomeFp: ns.welcome?.envFingerprint ?? null, computedFp: pageFp };
    if (isNode) {
      book.judge('D10', 'page-welcome-fp-equals-computed', ns.welcome?.envFingerprint === pageFp, { welcome: ns.welcome?.envFingerprint, computed: pageFp });
      book.judge('M7-A2', 'page-hello-profile-browser', ns.hello?.profile === 'browser' && ns.hello?.maxConcurrent === 1 && ns.hello?.hasEnvironment, ns.hello);
    }

    // A1 页面：A 的任务消息 0 条（三页都算，任何连接）
    const a1s = await waitSignal(kv, 'a1.start');
    const a1d = await waitSignal(kv, 'a1.done');
    // A12：播放 10 秒（C10-A1 回归）：主文档长任务 0；期间认领 0 次。页面当节点时放到 A4 判完之后（播放会让路，打扰 A4 的 30 s）
    const playCheck = async () => {
      await P(b1.page, () => { const s = window.__pcStore; s.actions.seek(0); s.actions.play(); }).catch(() => {});
      const tPlay = Date.now();
      await delay(10_500);
      await P(b1.page, () => window.__pcStore.actions.pause()).catch(() => {});
      const playLong = await longTasks(b1.page, tPlay);
      const playClaims = b1.tap.sent('task.claim', tPlay).filter((f) => f.at <= tPlay + 10_500).length;
      book.timed('M7-A12', 'play-10s-longtasks-0', Array.isArray(playLong) && playLong.length === 0, { count: playLong?.length ?? null, worst: (playLong ?? []).sort((a, b) => b.ms - a.ms).slice(0, 3) }, authoritative);
      if (isNode) book.judge('M7-A12', 'play-10s-claims-0', playClaims === 0, { claims: playClaims, heldAtStart: null });
      else book.pending('M7-A12', 'play-10s-claims-0', NODE_PENDING, { claims: playClaims });
      await kv.signal('node.play-done', { at: Date.now() });
    };
    if (!isNode) await playCheck();

    if (isNode) await pageFlows({ book, kv, cfg, browser, b1, low, single, pageFp, authoritative, playCheck });
    else {
      for (const id of ['M7-A4', 'M7-A5', 'M7-A6', 'M7-A9', 'M7-A10']) book.pending(id, 'page', NODE_PENDING, { diag: { available: diag0.available, reason: diag0.reason ?? null }, nodeHello: b1.tap.sent('node.hello').length });
      book.pending('M7-A12', 'bake-longtasks-0', NODE_PENDING);
      book.pending('M7-A11', 'page-render-ticket-expiry', NODE_PENDING);
      book.pending('M7-A3', 'page', NODE_PENDING);
      book.pending('M7-A8', 'page', NODE_PENDING);
    }

    // 等 creator 做完（twin、A10 这些要页面开着重发计划）
    await until(async () => (await kv.peekSignal('creator.finished')) ?? (await kv.aborted()), Math.max(1000, deadline - Date.now()), 1000);

    // A1 页面：整场收到 A 的任务消息条数（任何连接、三页）
    const aIds = new Set(a1d?.ids ?? []);
    const countA = (tap) => tap.frames.filter((f) => f.dir === 'recv' && f.at >= (a1s?.at ?? 0) && (
      (f.type === 'queue.snapshot' && (f.tasks ?? []).some((t) => aIds.has(t.id))) || (['task.opened', 'task.taken', 'task.closed', 'task.claimed'].includes(f.type) && aIds.has(f.id)))).length;
    const a1 = { b1: countA(b1.tap), low: countA(low.tap), single: countA(single.tap), aTasks: aIds.size };
    if (!aIds.size) book.judge('M7-A1', 'page', false, { reason: '没拿到 A 的任务 id' });
    else if (isNode) book.judge('M7-A1', 'page', a1.b1 === 0 && a1.low === 0 && a1.single === 0, a1);
    else book.pending('M7-A1', 'page', NODE_PENDING, a1);

    // A7：低内存档、退回单舞台的页面整场 render 连接 0 条、node.hello 0 条；对照 = 普通档页面当了节点
    const lowDiag = await previewDiag(low.page);
    const singleDiag = await previewDiag(single.page);
    const a7 = {
      low: { render: low.tap.renderConns().length, hello: low.tap.sent('node.hello').length, dual: lowDiag?.dual ?? null },
      single: { render: single.tap.renderConns().length, hello: single.tap.sent('node.hello').length, dual: singleDiag?.dual ?? null },
      control: { isNode, render: b1.tap.renderConns().length },
    };
    const a7ok = a7.low.render === 0 && a7.low.hello === 0 && a7.single.render === 0 && a7.single.hello === 0;
    book.judge('M7-A7', 'setup-single-stage', a7.single.dual === false, { single: a7.single.dual, low: a7.low.dual });
    if (!a7ok) book.judge('M7-A7', 'no-render-connection', false, a7);
    else if (isNode) book.judge('M7-A7', 'no-render-connection', true, a7);
    else book.pending('M7-A7', 'no-render-connection', `${NODE_PENDING}：两种页面都是 0 条，但普通档对照也没当节点，判据成立却没有对照`, a7);

    // A11：握手只回显 promptcut.v1；票据不进地址
    const echoes = [b1, low, single].flatMap((p) => [...p.tap.conns.values()].filter((c) => c.status === 101).map((c) => ({ page: p.key, role: c.role, echoed: c.echoed })));
    book.judge('M7-A11', 'echo-only-promptcut.v1', echoes.length > 0 && echoes.every((e) => e.echoed === 'promptcut.v1'), echoes.slice(0, 12));
    const renderEchoes = echoes.filter((e) => e.role === 'render');
    if (isNode) book.judge('M7-A11', 'render-echo-only-promptcut.v1', renderEchoes.length > 0 && renderEchoes.every((e) => e.echoed === 'promptcut.v1'), renderEchoes);
    else book.pending('M7-A11', 'render-echo-only-promptcut.v1', NODE_PENDING);
    const leaks = [b1, low, single].flatMap((p) => p.tap.leaks.map((w) => `${p.key}:${w}`));
    const diagLeak = [];
    for (const p of [b1, low, single]) {
      const texts = [JSON.stringify(await readNodeDiag(p.page)), JSON.stringify(await previewDiag(p.page)), JSON.stringify(await onlineDiag(p.page))];
      if (texts.some((t) => TICKET_RE.test(t) || [...p.tap.secrets].some((s) => t.includes(s)))) diagLeak.push(p.key);
    }
    book.judge('M7-A11', 'ticket-not-in-url-or-page-diag', leaks.length === 0 && diagLeak.length === 0, { urlLeaks: leaks, diagLeaks: diagLeak, ticketsSeen: [b1, low, single].reduce((s, p) => s + p.tap.secrets.size, 0) });

    head.pages = Object.fromEntries([b1, low, single].map((p) => [p.key, { gateSeen: p.gateSeen, conns: p.tap.conns.size, render: p.tap.renderConns().length, frames: p.tap.frames.length, pageErrors: p.page.pageErrors.slice(-5) }]));
  } catch (error) {
    book.part('W7', 'node-crash', 'fail', { error: errText(error), stack: String(error?.stack ?? '').split('\n').slice(0, 6).join(' | ') });
    say('node-crash', { error: errText(error), stack: String(error?.stack ?? '').split('\n').slice(0, 6).join(' | ') });
    await kv.abort(errText(error));
  } finally {
    try { await browser?.close(); } catch { /* 已关 */ }
    await kv.result({ items: book.items, head });
  }
}

/* ---------------------------------------------------------------- 页面当了节点：A4、A5、A6、A9、A10、A11 过期、A12 生成快照 */

async function pageFlows({ book, kv, cfg, browser, b1, low, pageFp, authoritative, playCheck }) {
  const tap = b1.tap;
  const page = b1.page;
  const heavy = ['h1', 'h2', 'h3'];

  /* ---- A4：从加载遮罩撤下起 30 秒内，三张卡的锚帧段都由本页认领并完成；页面内快照库有条目 */
  const claimedTask = (id) => tap.recv('task.claimed').find((f) => f.id === id)?.task ?? null;
  // 锚帧段 = 认领回包里 priority 50 的段；这张卡认领到的段里一段 50 都没有（切分方没给锚帧）时退回第 0 段，结果里记 anchorRule
  const anchorRule = {};
  const anchorDone = () => {
    const out = {};
    const claimed = tap.recv('task.claimed').map((f) => ({ id: f.id, t: f.task })).filter((x) => x.t && heavy.includes(x.t.clipId));
    for (const c of heavy) anchorRule[c] = claimed.some((x) => x.t.clipId === c && x.t.priority === 50) ? 'priority-50' : 'first-segment';
    for (const f of tap.sent('task.complete')) {
      const t = claimedTask(f.id);
      if (!t || !heavy.includes(t.clipId)) continue;
      const isAnchor = anchorRule[t.clipId] === 'priority-50' ? t.priority === 50 : t.range?.from === 0;
      if (isAnchor) (out[t.clipId] ??= []).push({ id: f.id.slice(0, 24), fullId: f.id, at: f.at, sinceGateMs: f.at - b1.gateLiftAt });
    }
    return out;
  };
  const got = await until(() => (heavy.every((c) => anchorDone()[c]?.length) ? anchorDone() : null), Math.max(0, b1.gateLiftAt + 600_000 - Date.now()), 250);
  const done = got ?? anchorDone();
  const worst = Math.max(...heavy.map((c) => Math.max(...(done[c] ?? [{ sinceGateMs: Infinity }]).map((x) => x.sinceGateMs))));
  const l2 = await l2Snapshots(page);
  const a4 = { anchorRule, perClip: done, worstSinceGateMs: Number.isFinite(worst) ? worst : null, l2Snapshots: l2, authoritative, diag: await readNodeDiag(page) };
  book.judge('M7-A4', 'page-anchors-done', heavy.every((c) => done[c]?.length) && (l2 ?? 0) > 0, a4);
  book.timed('M7-A4', 'page-within-30s', Number.isFinite(worst) && worst <= 30_000, { worstSinceGateMs: a4.worstSinceGateMs }, authoritative);
  const od = await onlineDiag(page);
  book.judge('M7-A4', 'page-layer-env-browser', heavy.every((c) => od?.layers?.find((l) => l.clipId === c)?.envFingerprint === pageFp), (od?.layers ?? []).map((l) => ({ clip: l.clipId, fp: l.envFingerprint, ready: l.ready })));
  await kv.signal('a4.page', { done: Object.fromEntries(Object.entries(done).map(([k, v]) => [k, v.length])), worstSinceGateMs: a4.worstSinceGateMs,
    completedIds: tap.sent('task.complete').map((f) => f.id) });

  // A12：生成快照期间主文档长任务 0（从遮罩撤下到三张卡的锚帧段做完）
  const bakeLong = await longTasks(page, b1.gateLiftAt);
  await playCheck();
  book.timed('M7-A12', 'bake-longtasks-0', Array.isArray(bakeLong) && bakeLong.filter((x) => x.at <= b1.gateLiftAt + Math.max(30_000, a4.worstSinceGateMs ?? 0)).length === 0, { count: bakeLong?.length ?? null, worst: (bakeLong ?? []).sort((a, b) => b.ms - a.ms).slice(0, 3) }, authoritative);

  /* ---- 等本页拿着一段（生成快照中）：下面几条让路都要这个前提 */
  // 持有中 = 最后一次认领晚于最后一次结束（完成 / 放回 / 失败 / 丢认领），且这次认领之后报过进度、最近 3 s 内还在报（在生成快照）；
  // 页面诊断的 state 是 baking 时另作对照。同一段放回后重新认领很常见，所以按时间比，不按 id 集合
  const holding = async (ms = 120_000) => until(async () => {
    const lastAt = (frames, id) => Math.max(-Infinity, ...frames.filter((f) => f.id === id).map((f) => f.at));
    const ends = [...tap.sent('task.complete'), ...tap.sent('task.release'), ...tap.sent('task.fail'), ...tap.recv('task.lease-lost')];
    const claims = tap.recv('task.claimed');
    const ids = [...new Set(claims.map((f) => f.id))];
    const now = Date.now();
    const cur = ids.filter((id) => lastAt(claims, id) > lastAt(ends, id))
      .filter((id) => { const p = tap.sent('task.progress').filter((f) => f.id === id && f.at >= lastAt(claims, id)); return p.length > 0 && now - p.at(-1).at < 3000; })
      .at(-1);
    if (!cur) return null;
    const d = await readNodeDiag(page);
    return !d.available || d.state === 'baking' || d.held.includes(cur) ? cur : null;
  }, ms, 100);

  /* ---- A5：生成快照中连续拖动 3 秒 */
  const heldId = await holding();
  if (!heldId) book.pending('M7-A5', 'page', '一直没等到本页在生成快照（没有持有中的任务）');
  else {
    const l2Before = await l2Snapshots(page);
    const drag = await dragRuler(page, 3000);
    const t0 = drag.startedAt ?? Date.now();
    const doneDuring = tap.sent('task.progress', t0).filter((f) => f.at <= drag.endedAt && f.id === heldId).length;
    const claimsDuring = tap.sent('task.claim', t0).filter((f) => f.at <= drag.endedAt).length;
    const rel = tap.sent('task.release', t0).filter((f) => f.id === heldId);
    const l2After = await l2Snapshots(page);
    await delay(500);
    const quietClaims = tap.sent('task.claim', drag.endedAt).filter((f) => f.at < drag.endedAt + 500).length;
    const resumed = await until(() => tap.sent('task.claim', drag.endedAt + 500)[0] ?? null, 30_000, 100);
    const reclaim = tap.recv('task.claimed', drag.endedAt).find((f) => f.id === heldId);
    const a5 = { drag: drag.ok, claimsDuring, framesDuringDrag: doneDuring, releases: rel.map((r) => ({ reason: r.reason, cause: releaseCauseOf(r.reason), msAfterDrag: r.at - t0 })), l2: { before: l2Before, after: l2After },
      claimsWithin500ms: quietClaims, resumedAfterMs: resumed ? resumed.at - drag.endedAt : null, attemptsOnReclaim: reclaim?.task?.attempts ?? null, authoritative };
    book.judge('M7-A5', 'page-yield-on-drag', drag.ok && claimsDuring === 0 && doneDuring <= 1 && rel.length === 1 && (l2After ?? 0) - (l2Before ?? 0) <= 2, a5); // 一帧 = 原尺寸 + 小尺寸两块
    book.judge('M7-A5', 'page-attempts-unchanged', reclaim ? (reclaim.task?.attempts ?? 0) === 0 : true, { attemptsOnReclaim: a5.attemptsOnReclaim, note: '放回不计失败（C2）；认领回包里的 attempts 由队列给' });
    book.timed('M7-A5', 'page-resume-after-500ms', quietClaims === 0 && !!resumed, { claimsWithin500ms: quietClaims, resumedAfterMs: a5.resumedAfterMs }, authoritative);
  }

  /* ---- A6：播放同 A5；页面隐藏后立即放回、隐藏期间认领 0 次、回前台恢复；更急的后台活来了停在帧边界 */
  const heldPlay = await holding();
  if (!heldPlay) book.pending('M7-A6', 'play', '没等到本页在生成快照');
  else {
    const t0 = Date.now();
    await P(page, () => window.__pcStore.actions.play()).catch(() => {});
    await delay(3000);
    await P(page, () => window.__pcStore.actions.pause()).catch(() => {});
    const claims = tap.sent('task.claim', t0).filter((f) => f.at <= t0 + 3000).length;
    const frames = tap.sent('task.progress', t0).filter((f) => f.at <= t0 + 3000 && f.id === heldPlay).length;
    const rel = tap.sent('task.release', t0).filter((f) => f.id === heldPlay && f.at <= t0 + 3500);
    const relLate = await until(() => tap.sent('task.release', t0).find((f) => f.id === heldPlay) ?? null, 15_000, 100);
    book.judge('M7-A6', 'play-yield', claims === 0 && frames <= 1 && rel.length === 1, { claims, frames, releases: rel.map((r) => r.reason),
      releaseAfterPauseMs: relLate && !rel.length ? relLate.at - (t0 + 3000) : null, lateReason: relLate?.reason ?? null, diagAfter: (await readNodeDiag(page)).state });
  }
  const heldHide = await holding();
  if (!heldHide) book.pending('M7-A6', 'hidden', '没等到本页在生成快照');
  else {
    const h = await hidePage(page);
    const lastProgress = tap.sent('task.progress', h.at).find((f) => f.id === heldHide);
    const rel = await until(() => tap.sent('task.release', h.at - 200).find((f) => f.id === heldHide) ?? null, 5000, 50);
    await delay(5000);
    const claimsHidden = tap.sent('task.claim', h.at).length;
    await h.restore();
    const resumed = await until(() => tap.sent('task.claim', Date.now() - 100)[0] ?? tap.sent('task.claim', h.at + 5000)[0] ?? null, 60_000, 200);
    book.judge('M7-A6', 'hidden-release-now', h.hidden && !!rel && (!lastProgress || lastProgress.at >= rel.at), { hidden: h.hidden, releaseMs: rel ? rel.at - h.at : null, reason: rel?.reason ?? null, cause: releaseCauseOf(rel?.reason), progressBeforeRelease: !!lastProgress && lastProgress.at < (rel?.at ?? 0) });
    book.judge('M7-A6', 'hidden-no-claims-then-resume', claimsHidden === 0 && !!resumed, { claimsHidden, resumed: !!resumed });
  }
  const heldUrgent = await holding();
  if (!heldUrgent) book.pending('M7-A6', 'urgent', '没等到本页在生成快照');
  else {
    // 更急的后台活：加一张新卡 → 后台舞台要测量它（测量 > 生成快照）
    const t0 = Date.now();
    await P(page, () => window.__pcStore.actions.addClipOnNewTrack({ index: 0, cardId: 'chapter-bar', start: 0, duration: 2 })).catch(() => {});
    const rel = await until(() => tap.sent('task.release', t0).find((f) => f.id === heldUrgent) ?? null, 30_000, 50);
    const framesAfter = tap.sent('task.progress', t0).filter((f) => f.id === heldUrgent && (!rel || f.at <= rel.at)).length;
    book.judge('M7-A6', 'urgent-stops-at-frame-boundary', !!rel && framesAfter <= 1, { releaseMs: rel ? rel.at - t0 : null, reason: rel?.reason ?? null, cause: releaseCauseOf(rel?.reason), framesAfter });
  }

  /* ---- A9 页面：低内存档页面对浏览器产的层贴小尺寸、不显示占位 */
  // 先等低内存页三层的产物都到齐（本页节点要把每张卡 5 段都做完），再从头播放、在 1.5 s 处取样：取样的那一帧一定有产物
  const lowReady = await until(async () => { const o = await onlineDiag(low.page); return heavy.every((c) => (o?.layers?.find((l) => l.clipId === c)?.ready ?? 0) >= FPS * SECONDS) ? o : null; }, 600_000, 2000);
  await P(low.page, () => { const s = window.__pcStore; s.actions.seek(0); s.actions.play(); }).catch(() => {});
  await delay(1500);
  const lowOd = await onlineDiag(low.page);
  const lowShown = await (async () => {
    const f = low.page.frames().find((x) => /[?&]stage=1/.test(x.url()));
    return f ? f.evaluate(() => [...document.querySelectorAll('[data-pc-clip]')].map((w) => ({ id: w.getAttribute('data-pc-clip'), plane: !!w.querySelector(':scope > [data-pc-snapshot-plane]'), placeholder: !!w.querySelector(':scope > [data-pc-placeholder-slot]:not([hidden])') }))).catch(() => null) : null;
  })();
  await P(low.page, () => window.__pcStore.actions.pause()).catch(() => {});
  const lowLayers = heavy.map((c) => ({ clip: c, layer: lowOd?.layers?.find((l) => l.clipId === c) ?? null, shown: lowShown?.find((w) => w.id === c) ?? null }));
  book.judge('M7-A9', 'page-low-memory-shows-small', lowOd?.tier === 'small' && lowLayers.every((x) => x.layer?.envFingerprint === pageFp && (x.layer?.ready ?? 0) > 0 && x.shown && !x.shown.placeholder),
    { waitedForAllFrames: !!lowReady, tier: lowOd?.tier ?? null, layers: lowLayers.map((x) => ({ clip: x.clip, fp: x.layer?.envFingerprint ?? null, ready: x.layer?.ready ?? null, placeholder: x.shown?.placeholder ?? null })) });

  /* ---- A11：render 票据过期（2 分钟）之后重建会话照常 */
  const firstRender = tap.renderConns().sort((a, b) => a.createdAt - b.createdAt)[0];
  if (!firstRender) book.pending('M7-A11', 'page-render-ticket-expiry', '找不到 render 连接');
  else {
    // 票据 2 分钟有效：等过期后请 creator 在服务端结束这条 render 会话（应用层，不动网络）；页面只能新建会话、重签票据
    await sleepUntil(firstRender.createdAt + 130_000);
    const tOff = Date.now();
    await kv.signal('a11.end-render', { deviceId: cfg.users.b1.deviceId, at: tOff });
    const ended = await waitSignal(kv, 'a11.ended');
    if (!ended?.closed) { book.pending('M7-A11', 'page-render-ticket-expiry', ended?.reason ?? 'creator 没能结束这条会话', ended); }
    else {
    const rebuilt = await until(() => {
      const w = tap.recv('node.welcome', tOff)[0];
      const t = tap.sent('auth.ticket', tOff).find((f) => f.role === 'render' && f.owner === 'browser');
      return w && t ? { welcomeMs: w.at - tOff, ticket: true } : null;
    }, 120_000, 250);
    book.judge('M7-A11', 'page-render-ticket-expiry', !!rebuilt, { endedBy: ended, rebuilt, newRenderConns: tap.renderConns().filter((c) => c.createdAt > tOff).length });
    }
  }

  /* ---- A3 页面：creator 以本页的身份发布的禁收任务，本页整场认领 0 次（线上看 task.claim） */
  const a3f = await waitSignal(kv, 'a3.forbidden');
  if (!a3f?.ids?.length) book.pending('M7-A3', 'page-forbidden-claimed-0', 'creator 没发禁收任务清单');
  else {
    const claimedTags = a3f.ids.filter(([, id]) => tap.sent('task.claim').some((f) => f.id === id)).map(([tag]) => tag);
    book.judge('M7-A3', 'page-forbidden-claimed-0', claimedTags.length === 0, { tasks: a3f.ids.length, seconds: Math.round(((a3f.to ?? 0) - (a3f.from ?? 0)) / 1000), claimedTags,
      blocked: (await readNodeDiag(page)).counts?.blocked ?? null });
  }
  book.judge('M7-A3', 'page-light-medium-done', tap.sent('task.complete').length > 0, { completed: tap.sent('task.complete').length });

  /* ---- A10 页面：本页拿着一张新卡的一段时关掉；creator 等锁闲置 > 30 s、重启 pc（不只切分）、发计划 → pc 接手；b2 上整层换键 */
  if (!cfg.a10) { book.pending('M7-A10', 'page', '--no-a10'); return; }
  const tZ = Date.now();
  // creator 加一张新重卡 z1（A 的路径操作）；本页测完、发计划、切分方双份出键，本页认领它的一段
  await kv.signal('a10.want-z', { at: tZ });
  const zClaim = await until(() => tap.recv('task.claimed', tZ).find((f) => f.task?.clipId === 'z1') ?? null, 300_000, 200);
  if (!zClaim) { book.pending('M7-A10', 'page', '新卡 z1 没被本页认领（没法测「拿着一段后关掉」）', { diag: (await readNodeDiag(page)).counts ?? null }); await kv.signal('a10.page-closed', { clip: null }); return; }
  await until(() => tap.sent('task.progress', zClaim.at).some((f) => f.id === zClaim.id), 30_000, 100);
  await b1.page.close();
  await kv.signal('a10.page-closed', { clip: zClaim.task.clipId, at: Date.now() });
  await waitSignal(kv, 'a10.open-b2');
  const b2 = await openMember(browser, cfg, 'b2');
  await until(() => b2.tap.nodeState().isNode, NODE_WAIT_MS, 250);
  await kv.signal('a10.b2-ready', { isNode: b2.tap.nodeState().isNode });
  await waitSignal(kv, 'a10.server-done');
  const od2 = await onlineDiag(b2.page);
  const zl = od2?.layers?.find((l) => l.clipId === zClaim.task.clipId);
  book.judge('M7-A10', 'page-layer-switched', zl?.envFingerprint === cfg.pcFp && (zl?.ready ?? 0) > 0, { clip: zClaim.task.clipId, fp: zl?.envFingerprint ?? null, pcFp: cfg.pcFp, ready: zl?.ready ?? null });
}

/* ================================================================== all */

async function runAll() {
  const out = path.resolve(arg('--out', fs.mkdtempSync(path.join(os.tmpdir(), 'pc-m7ap-'))));
  fs.mkdirSync(out, { recursive: true });
  const coord = await startCoord({ port: PORTS.coord, host: '127.0.0.1', mailToken: null });
  try {
    const run = newRunId();
    const common = ['--coord', coord.url, '--run', run, '--out', out, '--timeout-min', String(TIMEOUT_MS / 60_000), '--node-wait-s', String(NODE_WAIT_MS / 1000), '--a3-seconds', String(A3_MS / 1000),
      ...(flag('--no-twin') ? ['--no-twin'] : []), ...(flag('--no-a10') ? ['--no-a10'] : []), ...(arg('--dist') ? ['--dist', arg('--dist')] : []), ...(flag('--keep-temp') ? ['--keep-temp'] : []),
      ...(flag('--a4-motion') ? ['--a4-motion'] : [])];
    const runRole = (role, extra = []) => new Promise((resolve) => {
      const c = spawn(process.execPath, [SELF, '--role', role, ...common, ...extra], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '';
      c.stdout.on('data', (d) => { stdout += d.toString(); });
      c.stderr.on('data', (d) => process.stderr.write(d));
      c.once('exit', (code) => resolve({ role, code, line: lastJsonLine(stdout) }));
    });
    const [cr, nd] = await Promise.all([runRole('creator'), runRole('node')]);
    return { run, out, creator: cr, node: nd };
  } finally {
    await coord.stop();
  }
}

/* ================================================================== 入口 */

const started = Date.now();
const book = createBook();
const head = { probe: PROBE, role: ROLE, startedAt: nowIso() };
let final;
if (ROLE === 'all') {
  const r = await runAll();
  const c = r.creator.line;
  final = c ? { ...c, role: 'all', run: r.run, out: r.out, exit: { creator: r.creator.code, node: r.node.code }, nodeHead: r.node.line?.head ?? null }
    : { probe: PROBE, role: 'all', run: r.run, ok: false, fails: [`creator 没有结果行（退出码 ${r.creator.code}）`], pending: [], items: {}, exit: { creator: r.creator.code, node: r.node.code } };
} else if (ROLE === 'creator') {
  const nodeRes = await runCreator(book, head);
  const s = book.summary();
  final = { ...head, ok: s.fails.length === 0 && s.pending.length === 0, fails: s.fails, pending: s.pending, items: s.items,
    timing: { authoritative: !!nodeRes?.head?.timingAuthoritative || false, note: '带耗时门槛的项（A4 的 30 s、A5 的 500 ms、A12 的长任务）以笔记本为准' },
    nodeHead: nodeRes?.head ?? null, assumptions: ASSUMPTIONS, ms: Date.now() - started };
} else if (ROLE === 'node') {
  await runNode(book, head);
  const s = book.summary();
  final = { ...head, ok: s.fails.length === 0 && s.pending.length === 0, fails: s.fails, pending: s.pending, items: s.items, head, ms: Date.now() - started };
} else {
  final = { probe: PROBE, role: String(ROLE), ok: false, fails: ['--role 取 all | creator | node'], pending: [], items: {} };
  process.exitCode = 2;
}
process.stdout.write(`${JSON.stringify(final)}\n`);
if (process.exitCode !== 2) process.exitCode = final.ok ? 0 : (final.fails?.length ? 1 : 3);
setTimeout(() => process.exit(process.exitCode), 15_000).unref();
